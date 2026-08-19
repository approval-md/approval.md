/**
 * The MCP wrapper of SPEC.md §10.5 — the same verbs as tools, over the CLI's
 * own code paths (APRV-87).
 *
 * §10.5 asks for "a thin MCP server exposing the same verbs as tools … for
 * clients where MCP is more ergonomic than shelling out", and says plainly that
 * "it shares the CLI's code paths". Both halves of that sentence are load-
 * bearing here, and the second one is the whole design: **there is no second
 * implementation of any verb in this file.** A tool call builds an argv, hands
 * it to the function `src/cli/main.ts` dispatches to, captures the `--json`
 * object the CLI would have printed, and returns it. A refusal is the refusal
 * the CLI prints, with the same machine-readable `error.code`.
 *
 * ## The scoping decision: agent-facing only
 *
 * SPEC.md §11 names the agent the **untrusted policy** and the human the
 * **trusted, expensive overseer**. An MCP client is an agent's harness. Offering
 * `grant` to it hands the untrusted policy the overseer's pen, and no amount of
 * care inside the tool implementation would undo that. So the tool list is
 * exactly {@link VERB_REGISTRY} filtered by `human_only === false`, minus the
 * two exclusions in {@link EXCLUDED_VERBS}, and the registry's `human_only`
 * marker — not a list kept here — is what decides. `verb-registry.ts` says it in
 * its own header: the marker "exists so a wrapper does not offer an agent a door
 * the runtime will only slam".
 *
 * The runtime would slam it anyway (the CLI layer refuses, core refuses again,
 * and the event schema refuses a third time). Publishing the door would still be
 * wrong: a tool list is a statement about what this surface is for.
 *
 * ## Identity is the server's, and a tool call cannot change it
 *
 * The server runs AS one agent identity, fixed when the operator starts it
 * (`--as agent:<id>`, or `APPROVAL_AGENT`). `human:` and `system:` are refused at
 * startup. Every tool whose verb accepts `--as` gets the server's identity
 * appended LAST, after anything the caller supplied, and `--as` is removed from
 * every published input schema so that a client sending it is refused by the
 * schema rather than quietly ignored. Two mechanisms for one rule, because the
 * rule is the reason this server is safe to run at all.
 *
 * ## What this server does NOT do
 *
 * - It reads no `.approval/env` (SPEC.md §11.1 invariant 7). The environment a
 *   gate operation runs under is the one the operator launched this process
 *   with, exactly as for any other `approval` invocation.
 * - It maps nothing onto the MCP tasks/elicitation extension. §10.5 says the
 *   tasks extension MAY be mapped onto `awaiting` "when client support
 *   stabilizes"; that is post-v1, and until then `wait` blocks and answers.
 * - It appends nothing of its own. `tools/list` touches no file.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { commandAdapter } from "../cli/adapter.js";
import { commandChannel } from "../cli/channel.js";
import { commandDoctor } from "../cli/doctor.js";
import { commandRun } from "../cli/execute.js";
import { main, type Streams } from "../cli/main.js";
import {
  VERB_REGISTRY,
  verbLabel,
  type JsonSchema,
  type VerbSpec,
} from "../cli/verb-registry.js";
import { SPEC_VERSION } from "../core/version.js";

// ---------------------------------------------------------------------------
// The tool list
// ---------------------------------------------------------------------------

/**
 * Agent-facing verbs that are still not tools, each for a reason that is about
 * the TRANSPORT or the verb's role rather than about authority. Anything
 * excluded for authority reasons is `human_only` in the registry instead, which
 * is where that judgment belongs.
 */
export const EXCLUDED_VERBS: ReadonlyMap<string, string> = new Map([
  [
    "consume",
    "internal plumbing: its own purpose says so. `run` wraps it and is published instead, so a client that reached for `consume` would be spending a token outside the verb that records the outcome.",
  ],
  [
    "hook claude-code",
    "it reads one PreToolUse event from STDIN and its registry input schema has nowhere to put that event. On a stdio server, stdin is the JSON-RPC stream: a tool that read it would eat the protocol. It is also the wrong shape for MCP — a harness that can call tools calls `request` and `wait` directly.",
  ],
]);

/** `<name>_<subcommand words>` — `log_verify`, `channel_telegram_health`. */
export function toolName(spec: VerbSpec): string {
  const words = spec.subcommand === undefined ? [] : spec.subcommand.split(" ");
  return [spec.name, ...words].join("_");
}

/** The verbs this server publishes, in registry order. */
export function publishedVerbs(): VerbSpec[] {
  return VERB_REGISTRY.filter(
    (spec) => !spec.human_only && !EXCLUDED_VERBS.has(verbLabel(spec)),
  );
}

/**
 * The input schema for one tool: the registry's input schema, with the single
 * documented deletion of `--as`.
 *
 * Nothing else is translated, reshaped or regenerated. The registry's schemas
 * are already `{type:"object", properties:{positionals, flags, trailing?}}` with
 * `additionalProperties:false` throughout, which is exactly what MCP wants a
 * tool `inputSchema` to be, so the SDK's low-level {@link Server} is used rather
 * than `McpServer`: `McpServer.registerTool` takes Zod, and translating JSON
 * Schema into Zod so the SDK can translate it back would put a lossy round trip
 * between the one source and the published contract.
 *
 * `additionalProperties:false` is also what refuses `{"as":"human:carter"}`:
 * there is no such property, at any level, on any published tool.
 */
export function toolInputSchema(spec: VerbSpec): JsonSchema {
  const schema = structuredClone(spec.input) as {
    properties?: { flags?: { properties?: Record<string, unknown> } };
  };
  const flagProperties = schema.properties?.flags?.properties;
  if (flagProperties !== undefined) delete flagProperties["--as"];
  return schema as JsonSchema;
}

/** The `tools/list` answer, derived entirely from the registry. */
export function toolDefinitions(): Tool[] {
  return publishedVerbs().map((spec) => ({
    name: toolName(spec),
    title: `approval ${verbLabel(spec)}`,
    description: spec.purpose,
    inputSchema: toolInputSchema(spec) as Tool["inputSchema"],
  }));
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** The environment variable an operator may use instead of `--as`. */
export const AGENT_ACTOR_ENV = "APPROVAL_AGENT";

/** `agent:<id>` and nothing else. */
const AGENT_ACTOR = /^agent:.+/u;

export type IdentityCheck =
  | { ok: true; actor: string }
  | { ok: false; message: string };

/**
 * Resolve and validate the identity this server acts as.
 *
 * A `human:` value is refused rather than accepted-and-downgraded: an operator
 * who typed one meant something, and the something they meant is not available
 * here. `system:` is refused for the same reason `expire` takes no identity —
 * the runtime's own actor is not a thing a caller supplies.
 */
export function resolveAgentActor(
  flag: string | null,
  env: NodeJS.ProcessEnv = process.env,
): IdentityCheck {
  const raw = flag ?? env[AGENT_ACTOR_ENV] ?? null;
  if (raw === null || raw.trim().length === 0) {
    return {
      ok: false,
      message: `no agent identity: pass --as agent:<id> or set ${AGENT_ACTOR_ENV}=agent:<id>. The MCP server runs as ONE agent and every tool call is recorded under that identity`,
    };
  }
  if (!AGENT_ACTOR.test(raw)) {
    return {
      ok: false,
      message: `--as expects agent:<id>, got ${JSON.stringify(raw)}. This server is agent-facing by construction (SPEC.md §11: the agent is the untrusted policy, the human is the overseer), so it refuses to act as a human or as the system`,
    };
  }
  return { ok: true, actor: raw };
}

// ---------------------------------------------------------------------------
// Tool arguments -> argv
// ---------------------------------------------------------------------------

/** Pinned paths the operator chose when launching the server. */
export interface ServerPaths {
  /** Working directory every relative path resolves against. */
  cwd: string;
  /** `--log`, when the operator pinned one. */
  log?: string;
  /** `--policy`, when the operator pinned one. */
  policy?: string;
}

export interface ServerOptions extends ServerPaths {
  /** `agent:<id>`; already validated by {@link resolveAgentActor}. */
  actor: string;
}

/** The flag names one verb accepts, from its registry input schema. */
function flagNamesOf(spec: VerbSpec): Set<string> {
  const input = spec.input as {
    properties?: { flags?: { properties?: Record<string, unknown> } };
  };
  return new Set(Object.keys(input.properties?.flags?.properties ?? {}));
}

function acceptsTrailing(spec: VerbSpec): boolean {
  const input = spec.input as { properties?: Record<string, unknown> };
  return (input.properties ?? {})["trailing"] !== undefined;
}

export type ArgvBuild =
  | { ok: true; argv: string[] }
  | { ok: false; code: string; message: string };

function refuse(code: string, message: string): ArgvBuild {
  return { ok: false, code, message };
}

/**
 * Map one tool call's arguments onto the argv the CLI would have been given.
 *
 * Validation here is deliberate rather than delegated: the low-level MCP
 * {@link Server} does not validate `arguments` against a tool's `inputSchema`,
 * and "the schema said additionalProperties:false" has to be enforced by
 * something. So an unknown top-level key, an unknown flag, or a non-string
 * argument is refused, which is what makes `{"as":"human:carter"}` a refusal
 * instead of a silently dropped field.
 */
export function buildArgv(
  spec: VerbSpec,
  rawArgs: unknown,
  options: ServerOptions,
): ArgvBuild {
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  if (typeof args !== "object" || Array.isArray(args)) {
    return refuse("mcp-invalid-arguments", "arguments must be a JSON object");
  }

  const allowedKeys = new Set(["positionals", "flags"]);
  if (acceptsTrailing(spec)) allowedKeys.add("trailing");
  for (const key of Object.keys(args)) {
    if (allowedKeys.has(key)) continue;
    return refuse(
      "mcp-unknown-property",
      `unknown property ${JSON.stringify(key)}; \`${verbLabel(spec)}\` accepts ${[...allowedKeys]
        .map((name) => JSON.stringify(name))
        .join(", ")} and nothing else. Identity in particular is NOT an argument: this server acts as ${options.actor}, fixed when it was started, and no tool call can change it`,
    );
  }

  const positionals: string[] = [];
  const rawPositionals = args["positionals"];
  if (rawPositionals !== undefined) {
    if (!Array.isArray(rawPositionals)) {
      return refuse("mcp-invalid-arguments", "positionals must be an array of strings");
    }
    for (const value of rawPositionals) {
      if (typeof value !== "string") {
        return refuse("mcp-invalid-arguments", "every positional must be a string");
      }
      positionals.push(value);
    }
  }

  const flagArgv: string[] = [];
  const accepted = flagNamesOf(spec);
  const rawFlags = args["flags"];
  if (rawFlags !== undefined) {
    if (typeof rawFlags !== "object" || rawFlags === null || Array.isArray(rawFlags)) {
      return refuse("mcp-invalid-arguments", "flags must be an object");
    }
    for (const [flag, value] of Object.entries(rawFlags as Record<string, unknown>)) {
      if (flag === "--as") {
        return refuse(
          "mcp-identity-fixed",
          `--as is not accepted from a tool call. This server acts as ${options.actor}, chosen by the operator who started it; an identity a caller could name would be an identity the caller could escalate (SPEC.md §11)`,
        );
      }
      if (!accepted.has(flag)) {
        return refuse(
          "mcp-unknown-flag",
          `unknown flag ${JSON.stringify(flag)} for \`${verbLabel(spec)}\``,
        );
      }
      if (typeof value === "boolean") {
        if (value) flagArgv.push(flag);
        continue;
      }
      if (typeof value !== "string") {
        return refuse(
          "mcp-invalid-arguments",
          `flag ${JSON.stringify(flag)} expects a string or a boolean`,
        );
      }
      flagArgv.push(flag, value);
    }
  }

  const trailing: string[] = [];
  const rawTrailing = args["trailing"];
  if (rawTrailing !== undefined) {
    if (!acceptsTrailing(spec)) {
      return refuse("mcp-unknown-property", `\`${verbLabel(spec)}\` takes no trailing argv`);
    }
    if (!Array.isArray(rawTrailing) || rawTrailing.length === 0) {
      return refuse("mcp-invalid-arguments", "trailing must be a non-empty array of strings");
    }
    for (const value of rawTrailing) {
      if (typeof value !== "string") {
        return refuse("mcp-invalid-arguments", "every trailing argument must be a string");
      }
      trailing.push(value);
    }
  }

  // `-` means "read it from stdin" everywhere in this CLI, and on a stdio
  // server stdin is the JSON-RPC stream. Reading it would deadlock the
  // connection and steal the client's next request, so it is refused with a
  // code that says what to do instead.
  for (const value of [...positionals, ...flagArgv]) {
    if (value !== "-") continue;
    return refuse(
      "mcp-stdin-unavailable",
      "`-` (read from stdin) is not available over MCP: stdin is the JSON-RPC transport. Write the bytes to a file and pass its path",
    );
  }

  // Injected LAST so the operator's pins and the server's identity win over
  // anything the caller supplied: `parseFlags` keeps the last occurrence.
  const injected: string[] = [];
  if (options.log !== undefined && accepted.has("--log")) injected.push("--log", options.log);
  if (options.policy !== undefined && accepted.has("--policy")) {
    injected.push("--policy", options.policy);
  }
  if (accepted.has("--as")) injected.push("--as", options.actor);
  if (accepted.has("--json")) injected.push("--json");

  return {
    ok: true,
    argv: [
      ...positionals,
      ...flagArgv,
      ...injected,
      ...(trailing.length === 0 ? [] : ["--", ...trailing]),
    ],
  };
}

// ---------------------------------------------------------------------------
// Invocation: the same function main.ts dispatches to
// ---------------------------------------------------------------------------

/** What one verb invocation produced. */
interface Invocation {
  code: number;
  stdout: string;
  stderr: string;
  child?: { stdout: string; stderr: string };
}

function collector(): { streams: Streams; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    streams: { out: (text) => out.push(text), err: (text) => err.push(text) },
    out,
    err,
  };
}

/**
 * Run one verb.
 *
 * The default arm is `main()` itself — the CLI's real dispatch, so a verb whose
 * argv handling changes changes here too, with nothing to keep in step. The
 * three exceptions each have a reason that is about this transport:
 *
 * - `run` spawns a child, and `stdio: "inherit"` would hand that child the
 *   JSON-RPC pipe. It is called through the `childIo` seam `execute.ts` exposes
 *   for exactly this, which pipes the child's output back as tool content.
 * - `doctor` and `adapter email` are asynchronous, and `main()` drops their
 *   promise into `process.exitCode` rather than returning it. Awaiting the
 *   command function is the only way to get the code.
 *
 * `channel telegram health` goes through `commandChannel` for the same reason:
 * its dispatch arm in `main()` is the promise-unwrapping one.
 */
async function invoke(
  spec: VerbSpec,
  argv: string[],
  options: ServerOptions,
): Promise<Invocation> {
  const sink = collector();
  const { streams } = sink;
  const cwd = options.cwd;
  const label = verbLabel(spec);

  let code: number;
  let child: { stdout: string; stderr: string } | undefined;

  if (label === "run") {
    let captured: { stdout: string; stderr: string } | undefined;
    code = commandRun(argv, streams, cwd, {
      stdio: ["ignore", "pipe", "pipe"],
      onOutput: (output) => {
        captured = output;
      },
    });
    child = captured;
  } else if (label === "doctor") {
    code = await commandDoctor(argv, streams, cwd);
  } else if (label === "adapter email") {
    code = await commandAdapter(["email", ...argv], streams, cwd);
  } else if (spec.name === "channel") {
    const words = spec.subcommand === undefined ? [] : spec.subcommand.split(" ");
    code = await commandChannel([...words, ...argv], streams, cwd);
  } else {
    const words = spec.subcommand === undefined ? [] : spec.subcommand.split(" ");
    code = main([spec.name, ...words, ...argv], { streams, cwd });
  }

  return {
    code,
    stdout: sink.out.join(""),
    stderr: sink.err.join(""),
    ...(child === undefined ? {} : { child }),
  };
}

// ---------------------------------------------------------------------------
// Invocation -> CallToolResult
// ---------------------------------------------------------------------------

/** The last line of `text` that parses as a JSON object, or null. */
function lastJsonObject(text: string): Record<string, unknown> | null {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? "").trim();
    if (line.length === 0 || !line.startsWith("{")) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // Not JSON; keep walking backwards.
    }
  }
  return null;
}

/** The `_meta` key prefix this server stamps its out-of-band facts under. */
export const META_PREFIX = "approval.md/";

/**
 * Shape one invocation into a tool result.
 *
 * A gate refusal is a RESULT, never a thrown JSON-RPC error: the command was
 * well-formed and the runtime's answer was no, which is a fact the caller must
 * be able to read as data. It comes back as `isError: true` carrying the same
 * `{"error":{"code","message"}}` object the CLI prints, so a client branches on
 * `error.code` exactly as it would on the CLI's stderr.
 *
 * A non-zero exit that carries a SUCCESS-shaped object is not an error: `wait`
 * exits 1 on a rejection and 6 on a timeout, `status` exits 1 when something
 * needs attention, `log verify` exits 3 on a torn tail. Those are answers. The
 * exit code always travels in `_meta` so nothing is lost either way.
 */
export function toolResult(result: Invocation): CallToolResult {
  // stdout first, then stderr: `run` prints its summary on stderr because
  // stdout belongs to the child, and every refusal goes to stderr too.
  const payload = lastJsonObject(result.stdout) ?? lastJsonObject(result.stderr);
  const isError = payload === null ? result.code !== 0 : payload["error"] !== undefined;

  const content: CallToolResult["content"] = [
    {
      type: "text",
      text:
        payload === null
          ? `${result.stdout}${result.stderr}`.trim() ||
            `the command produced no output and exited ${result.code}`
          : JSON.stringify(payload),
    },
  ];

  if (result.child !== undefined) {
    if (result.child.stdout.length > 0) {
      content.push({ type: "text", text: `child stdout:\n${result.child.stdout}` });
    }
    if (result.child.stderr.length > 0) {
      content.push({ type: "text", text: `child stderr:\n${result.child.stderr}` });
    }
  }

  return {
    content,
    ...(payload === null ? {} : { structuredContent: payload }),
    ...(isError ? { isError: true } : {}),
    _meta: {
      [`${META_PREFIX}exit_code`]: result.code,
      ...(result.child === undefined ? {} : { [`${META_PREFIX}child`]: result.child }),
    },
  };
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

/**
 * Serialize everything.
 *
 * Two reasons, and only the first is about this process. In-process, several
 * verbs are synchronous and blocking (`wait` sleeps with `Atomics.wait`, `run`
 * uses `spawnSync`), so overlapping them buys nothing and interleaves their
 * captured output. Across processes, an append still goes through
 * `core/log.ts`'s lockfile and compare-and-append, so a CLI running beside this
 * server is safe whatever this queue does — the queue is politeness, the
 * lockfile is the guarantee.
 */
function serializer(): <T>(work: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
}

/** Build the MCP server. Nothing is connected until {@link Server.connect}. */
export function createApprovalMcpServer(options: ServerOptions): Server {
  const server = new Server(
    { name: "approval-md", version: SPEC_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "approval.md gates agent actions that touch the world. The tools here are the AGENT surface only: declare an action in a task envelope, register it, request it, wait for a decision, then run it. There is deliberately no grant, reject, revoke, attest or vault tool — those record a human's authority and are not available to a client of this server (SPEC.md §11). Call `instructions` first; it prints the full guide.",
    },
  );

  const byName = new Map(publishedVerbs().map((spec) => [toolName(spec), spec]));
  const serialize = serializer();

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: toolDefinitions() }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const name = request.params.name;
    const spec = byName.get(name);
    if (spec === undefined) {
      const human = VERB_REGISTRY.find(
        (candidate) => toolName(candidate) === name && candidate.human_only,
      );
      throw new McpError(
        ErrorCode.InvalidParams,
        human === undefined
          ? `unknown tool ${JSON.stringify(name)}`
          : `unknown tool ${JSON.stringify(name)}: \`approval ${verbLabel(human)}\` records or establishes a human's authority and this server publishes no tool for it. An MCP client is an agent's harness, and SPEC.md §11 makes the agent the untrusted policy; the human decides at their own surface (\`approval channel cli\`, the web page, or Telegram)`,
      );
    }

    const built = buildArgv(spec, request.params.arguments, options);
    if (!built.ok) {
      throw new McpError(ErrorCode.InvalidParams, `${built.code}: ${built.message}`);
    }

    return toolResult(await serialize(() => invoke(spec, built.argv, options)));
  });

  return server;
}

/** Build the server and connect it to `transport`. Resolves once connected. */
export async function serveApprovalMcp(
  options: ServerOptions,
  transport: Transport,
): Promise<Server> {
  const server = createApprovalMcpServer(options);
  await server.connect(transport);
  return server;
}
