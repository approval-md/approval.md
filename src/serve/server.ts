/**
 * `approval serve` — the agent-facing surface over HTTP, for a harness that
 * has no local log and no local policy (APRV-421).
 *
 * A tenant whose harness runs in a sandbox (Agent Village's Hermes tenants,
 * the Meta Muse connector packet) has nowhere for `approval hook <harness>` to
 * write and nothing for it to read. The hosted daemon runs elsewhere, one
 * process per tenant (design/hosted-daemon-identity.md); what was missing was a
 * way to reach it. This is that door, and it is a DOOR rather than a second
 * gate.
 *
 * ## Transport only, and the file says so by importing rather than repeating
 *
 * Every verdict, every verb and every batch of records here comes from the
 * function the CLI dispatches to:
 *
 * - the verb surface is `mcp/server.ts`'s — {@link publishedVerbs},
 *   {@link toolDefinitions}, {@link buildArgv} and {@link invokeVerb}, so the
 *   catalog MATCHES `approval mcp serve` because it IS `approval mcp serve`'s,
 *   `--as` is absent from every published schema for the same one reason, and
 *   the launch identity is appended last by the same one line;
 * - a hook call is `commandHook` with the request body as its stdin, so the
 *   bytes on the response are the bytes the stdin form prints, for every
 *   adapter in `HARNESS_ADAPTERS`, with no dialect knowledge in this file;
 * - a follow page is `core/log-subscribe.ts`'s verified subscription, drained
 *   once (`serve/follow.ts`).
 *
 * Nothing here classifies a command, resolves a policy, mints a token or
 * verifies a chain. Two implementations of the gate sequence would be two
 * gates, and the second would be the one nobody reviewed.
 *
 * ## Two credentials, two parties
 *
 * `serve/credentials.ts` holds the reasoning. The short form: the agent
 * credential opens the verbs and the hook, the tenant credential opens the
 * log, the export and status, and the agent credential never reads the log it
 * is judged by.
 *
 * ## What it does not do
 *
 * - **No TLS.** There is no certificate handling in this process and there is
 *   not going to be: the supported deployment is a loopback bind behind a
 *   proxy the operator owns, and a non-loopback bind requires an explicit flag
 *   and prints a banner (`cli/serve.ts`).
 * - **No record of its own.** This server appends nothing on its own account.
 *   Every event in the log under it was written by a verb a caller asked for,
 *   under the identity the operator fixed at launch.
 * - **No state a restart loses.** The only things held between requests are
 *   the store lock and a few warm hook threads, which are properties of the
 *   process rather than of any caller. Follow cursors belong to the caller, so
 *   a host that sleeps and wakes serves the same next page it would have served
 *   before.
 *
 * ## What is serialised, and what is not (APRV-427)
 *
 * One lock per store ({@link storeLock}). It covers every stretch of work in
 * this process that may append to the store or must read it as one snapshot:
 * a verb call, a follow page, the export, and a hook call's MUTATION sections
 * (everything up to its poll loop, and everything after it). It does not cover
 * a hook call's WAIT: the call runs on a worker thread (`serve/hook-thread.ts`)
 * and hands the lock back for as long as it polls, so one question waiting on
 * a human no longer holds the tenant's `status`, `queue` and follow, or the
 * next hook call's own question, until the human answers. The catalog takes no
 * lock at all. Across processes the guarantee is unchanged and is not this
 * lock's: every append goes through `core/log.ts`'s lockfile and
 * compare-and-append.
 * - **No `.approval/env`.** SPEC.md §11.1 invariant 7, inherited verbatim from
 *   the MCP server: the environment a gate operation runs under is the one the
 *   host launched this process with.
 */

import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";

import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { harnessBlockDirective, HARNESS_ADAPTERS } from "../cli/hook.js";
import { DEFAULT_LOG_PATH, resolvePath } from "../cli/paths.js";
import { type VerbSpec } from "../cli/verb-registry.js";
import { isHarnessKind, type HarnessKind } from "../core/harness-version.js";
import { withAppendLock } from "../core/log.js";
import {
  buildArgv,
  invokeVerb,
  publishedVerbs,
  serializer,
  toolDefinitions,
  toolName,
  type ServerOptions,
} from "../mcp/server.js";
import { buildStoreArchive, ExportHardLinkError, ExportSymlinkError } from "./archive.js";
import { checkVerbArguments } from "./arguments.js";
import {
  DEFAULT_HOOK_QUEUE,
  DEFAULT_HOOK_THREADS,
  HookCancelledError,
  HookSaturatedError,
  hookThreads,
  type HookThreadStats,
  type StoreLock,
} from "./hook-thread.js";

/**
 * Identity is resolved by the MCP server's own function, re-exported here so
 * that `cli/serve.ts` reaches it through ITS server exactly as `cli/mcp.ts`
 * reaches it through the MCP one.
 *
 * Two transports fixing an identity by two rules would be two answers to
 * "which identities may this process act as", and the answer has to be one:
 * `agent:<id>` and nothing else, refused at startup, never supplied by a
 * caller.
 */
export { resolveAgentActor, type IdentityCheck } from "../mcp/server.js";
import { bearerOf, type ServeCredentials, type ServeScope } from "./credentials.js";
import {
  DEFAULT_FOLLOW_LIMIT,
  followFailureExit,
  MAX_FOLLOW_LIMIT,
  followPage,
  type FollowCursor,
} from "./follow.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Largest request body accepted. A tool call and a hook envelope are small. */
export const MAX_BODY_BYTES = 1024 * 1024;

/**
 * How much of an oversized body this server will read and throw away before
 * dropping the socket.
 *
 * An oversized request is refused at {@link MAX_BODY_BYTES}, but the refusal
 * cannot be WRITTEN until the client stops writing, or the response closes the
 * socket under it and the caller sees a transport error instead of a verdict.
 * So the remainder is discarded as it arrives, up to this much, and beyond it
 * the connection is simply dropped: a caller streaming without end is not a
 * caller owed a polite answer.
 */
export const DRAIN_LIMIT_BYTES = 16 * 1024 * 1024;

/**
 * How much of a captured stream travels back in a response body.
 *
 * Both streams are bounded, and both carry a flag saying whether they were
 * clipped. Generous enough that a verdict is never clipped in practice, and
 * present so that a verb which decided to print a megabyte cannot make a
 * response unsendable. Clipping happens at a CODEPOINT boundary
 * ({@link clip}), so what comes back is always valid text.
 */
export const MAX_STREAM_BYTES = 256 * 1024;

/**
 * The exit code every server-authored refusal carries.
 *
 * NON-ZERO, always, and this is the finding that made the whole response
 * contract change. A refusal used to travel as an HTTP status with the exit
 * code in a header that refusals did not set, so a client following the
 * documented rule — write stdout, exit `x-approval-exit-code` — read a missing
 * header as zero, and zero is ALLOW on Claude Code, Cursor, Codex and Muse. A
 * 413 on an oversized hook envelope was therefore an allow. Nothing on this
 * surface may be able to turn a refusal into a permission, so the exit code is
 * in the body, it is always present, and on a refusal it is always this.
 */
export const REFUSAL_EXIT_CODE = 2;

// ---------------------------------------------------------------------------
// The route table
// ---------------------------------------------------------------------------

/**
 * The verbs the AGENT credential may call. An ALLOWLIST, and the direction is
 * the whole of it.
 *
 * The catalog is the registry's and does not change (`mcp/server.ts` owns it,
 * and this surface publishes exactly what `approval mcp serve` publishes).
 * This is authorization, which is a different question asked one layer later,
 * and it is asked per verb.
 *
 * ## Why a list of what a harness MAY do
 *
 * The threat model this transport exists for is a sandboxed harness on another
 * machine, not an operator at their own laptop. `approval mcp serve` is run BY
 * the operator, on the operator's box, over a pipe the operator handed it; its
 * whole catalog is reachable there because the party at the other end is the
 * party who started it. Here the party at the other end is the party under
 * oversight, and the operative rule is that it never reads the log it is
 * judged by, nor spends the host's credentials, nor runs argv on the host.
 *
 * A denylist would have to name `log tail`, `log export`, `queue`, `coverage`,
 * `doctor`, every `adapter <name>`, `run`, `sandbox`, `token`, `reindex`,
 * `render` and every verb that lands next. This list names what a harness
 * under oversight needs in order to ASK and to ACT ON a grant, so a verb added
 * to the registry tomorrow is TENANT-scoped until somebody decides otherwise.
 * Fail closed, per SPEC.md §11, which is the same reasoning `GUEST_VERBS`
 * gives for being positive.
 *
 * What is on it, and why each:
 *
 * - `instructions`, `hook_classify` — read the guide, and find out what the
 *   classifier makes of a command. Neither reads the log or the policy file;
 *   both tell an agent what it is about to be judged for before it asks.
 * - `request`, `wait`, `withdraw` — ask, wait for the answer, and retract your
 *   own question. This is the gate sequence, and it is the reason the agent
 *   credential exists.
 * That is the whole list. It is five verbs, and the shortness is the point: a
 * harness under oversight asks and is answered, and everything else about the
 * gate belongs to the party the gate is for.
 *
 * ## What came OFF this list in review, and why
 *
 * - `register` takes a task-file POSITIONAL, which is a host path. The hook
 *   endpoint is a harness's way to register: it synthesises the envelope from
 *   the tool call, so nothing is lost and a host path stops being something a
 *   remote caller names.
 * - `log_verify` and `gate_status` hand back the log's length, its head hash
 *   and the live state of the gate. "Not a record" is not the same as "not
 *   about the log": a head hash moving is a decision being recorded, and an
 *   open window is the human's current posture toward this very agent.
 * - `policy_check` and `policy_test` answer what the policy does with a class,
 *   and `policy_check` names the absolute store path while doing it.
 * - **Both payload builders**, under the rule that a builder is the agent's
 *   only if it builds from the request's own arguments and never reaches a
 *   host resource. `payload_hash` takes a FILE, and on this transport that
 *   file is on the daemon's machine while the caller is not: every path it
 *   could name is one the host put there, so answering would be a hash oracle
 *   that also files the bytes into the payload store.
 *   `payload_agentmail-draft` takes two ids rather than a path, but it reads
 *   the draft over HTTPS with `AGENTMAIL_API_KEY` FROM THIS SERVER'S OWN
 *   ENVIRONMENT, so a remote caller would be spending the host's credential on
 *   ids it chose — the same fault wearing a network instead of a filesystem.
 *   The narrow reading was taken on purpose: publishing a builder that should
 *   have been withheld is a capability leak, and withholding one that should
 *   have been published is a line of configuration.
 *
 * Everything else is the tenant's, including the ones easiest to wave through:
 * `log_tail` and `log_export` return RECORDS, `queue` returns the tenant's
 * pending decisions, `run` and `sandbox` spawn argv on the daemon's machine,
 * every `adapter_<name>` spends vault credentials, and `status` is the
 * tenant's view of the oversight the agent is under. All of them stay
 * PUBLISHED, so the surface is honest about what exists, and all of them
 * answer the tenant credential only.
 */
export const AGENT_VERBS: ReadonlySet<string> = new Set([
  "instructions",
  "hook_classify",
  "request",
  "wait",
  "withdraw",
]);

/**
 * The frozen refusal vocabulary this server authors itself (SPEC.md §11.1
 * invariant 6).
 *
 * A refusal a VERB produced keeps the verb's own code, unchanged, because it
 * is the CLI's refusal arriving over a different transport; so does a refusal
 * `buildArgv` produced, `mcp-` prefix and all, because that function is the
 * one both transports call and renaming its codes here would make one surface
 * lie about the other. What is listed below is only what this file decides.
 */
export const SERVE_REFUSAL_CODES = [
  "serve-unauthorized",
  "serve-agent-forbidden",
  "serve-tenant-forbidden",
  "serve-unknown-path",
  "serve-malformed-url",
  "serve-unknown-verb",
  "serve-unknown-harness",
  "serve-method-not-allowed",
  "serve-body-too-large",
  "serve-body-unreadable",
  "serve-invalid-cursor",
  "serve-path-pinned",
  "serve-path-outside-store",
  "serve-positional-flag",
  "serve-flag-not-permitted",
  "serve-export-symlink",
  "serve-export-hardlink",
  "serve-export-failed",
  "serve-hook-failed",
  "serve-hook-saturated",
] as const;

export type ServeRefusalCode = (typeof SERVE_REFUSAL_CODES)[number];

// ---------------------------------------------------------------------------
// Options and handle
// ---------------------------------------------------------------------------

export interface ServeOptions {
  /** `agent:<id>`, already validated. Every verb call is recorded under it. */
  actor: string;
  /** The store root: the working directory every relative path resolves against. */
  cwd: string;
  /** `--log`, when the operator pinned one. */
  log?: string;
  /** `--policy`, when the operator pinned one. */
  policy?: string;
  /** The two bearer credentials, already resolved from the environment. */
  credentials: ServeCredentials;
  /** The daemon instance id this gate writes under. Reported, never enforced. */
  daemonId: string;
  /** Interface to bind. The CLI owns the widening decision; this defaults to loopback. */
  host?: string;
  /** TCP port. `0` asks the kernel for an ephemeral one, which is what tests use. */
  port: number;
  /** `--timeout` pinned on every hook call, when the operator chose one. */
  hookTimeout?: string;
  /**
   * `--harness-cap` pinned on every hook call, when the operator stated one
   * (APRV-423).
   *
   * Independent of {@link ServeOptions.hookTimeout} and composed with it: that
   * one bounds how long a call WAITS, this one states the ceiling the harness
   * on the far side of the call imposes on its own hook process. The request
   * this server opens is then judged by the shorter of the policy's TTL and
   * that ceiling minus a margin, so the expiry is recorded while the tenant's
   * harness is still listening.
   */
  hookHarnessCap?: string;
  /**
   * Hook calls that may run at once, each on its own thread (APRV-427 review).
   * Defaults to {@link DEFAULT_HOOK_THREADS}. See `serve/hook-thread.ts`.
   */
  hookThreads?: number;
  /**
   * Hook calls that may wait for a thread before one is refused
   * `serve-hook-saturated`. Defaults to {@link DEFAULT_HOOK_QUEUE}.
   */
  hookQueue?: number;
  /** Request lines. The CLI passes stderr; stdout is never written to. */
  notice?: (text: string) => void;
}

export interface ServeHandle {
  readonly host: string;
  readonly port: number;
  /** How many requests this listener has answered. Diagnostics and tests. */
  requests(): number;
  /** The hook thread pool's state now. Diagnostics and tests. */
  hookThreads(): HookThreadStats;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Small HTTP helpers
// ---------------------------------------------------------------------------

/**
 * A refusal, always as a RESULT BODY, and always carrying an exit code.
 *
 * Never a bare HTTP error: the status is a hint for the plumbing between here
 * and the caller, and the `{"error":{"code","message"}}` object is the answer.
 * A client branches on `error.code` exactly as it would on the CLI's stderr,
 * and every code it can see is either this file's (above), a verb's own, or
 * the subscription's.
 *
 * `exit_code` is {@link REFUSAL_EXIT_CODE} on every one of them, and that is
 * the review finding this shape exists for. A client's rule is "write
 * `stdout`, exit `exit_code`"; if a refusal carried no exit code, the client's
 * default would be zero, and zero is ALLOW on four of the six harness
 * dialects. A refusal must never be readable as a permission, so it carries a
 * blocking code as data rather than leaving one to be inferred.
 */
function refuse(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  send(
    res,
    status,
    JSON.stringify({ error: { code, message }, exit_code: REFUSAL_EXIT_CODE, ...extra }),
    { "content-type": "application/json" },
  );
}

/**
 * A refusal on the HOOK route, spoken in the harness's own dialect.
 *
 * Same body as {@link refuse}, plus `stdout` carrying the block directive
 * `approval hook <harness>` itself prints. A client that writes `stdout` and
 * exits `exit_code` therefore blocks on BOTH halves of every dialect: the body
 * blocks Claude Code, Cursor, Codex and Muse, and the exit code blocks Grok
 * Build and Hermes. A client that instead branches on `error.code` sees the
 * refusal for what it is.
 *
 * Where the harness is not known — an unroutable path, an unrecognised name, a
 * credential that failed before the URL was parsed — there is no dialect to
 * speak and `stdout` is empty. That case is why `docs/cli-reference.md` states
 * the client rule as it does: a missing or unparseable body is a BLOCK.
 */
function refuseHook(
  res: ServerResponse,
  status: number,
  harness: HarnessKind,
  code: string,
  message: string,
): void {
  const directive = harnessBlockDirective(code, message, harness);
  refuse(res, status, code, message, {
    stdout: directive.stdout,
    stderr: "",
    stdout_truncated: false,
    stderr_truncated: false,
  });
}

function send(
  res: ServerResponse,
  status: number,
  body: string | Buffer,
  headers: Record<string, string> = {},
): void {
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  res.writeHead(status, { ...headers, "content-length": bytes.length });
  res.end(bytes);
}

type BodyRead =
  | { ok: true; text: string }
  | { ok: false; status: number; code: ServeRefusalCode; message: string };

/** Read one request body, bounded by {@link MAX_BODY_BYTES}. */
async function readBody(req: IncomingMessage): Promise<BodyRead> {
  const chunks: Buffer[] = [];
  let size = 0;
  let oversized = false;
  try {
    for await (const chunk of req) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        // DO NOT return here. The client is still uploading, and a response
        // written while it writes closes the socket under it: the caller then
        // sees ECONNRESET instead of the 413, and a hook client that got a
        // transport error rather than a refusal has no verdict to read. So the
        // rest is DISCARDED as it arrives — never buffered, so the memory is
        // bounded by one chunk — and the refusal is written once the client
        // has finished speaking.
        //
        // Bounded twice over: the drain stops at DRAIN_LIMIT_BYTES, after
        // which the socket is dropped, so a caller that streams forever is not
        // a caller this loop follows forever.
        oversized = true;
        chunks.length = 0;
        if (size > DRAIN_LIMIT_BYTES) {
          req.destroy();
          break;
        }
        continue;
      }
      chunks.push(buffer);
    }
    if (oversized) {
      return {
        ok: false,
        status: 413,
        code: "serve-body-too-large",
        message: `request body exceeds ${String(MAX_BODY_BYTES)} bytes`,
      };
    }
  } catch (cause) {
    if (oversized) {
      return {
        ok: false,
        status: 413,
        code: "serve-body-too-large",
        message: `request body exceeds ${String(MAX_BODY_BYTES)} bytes`,
      };
    }
    return {
      ok: false,
      status: 400,
      code: "serve-body-unreadable",
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

/**
 * One captured stream, bounded and clipped at a CODEPOINT boundary.
 *
 * A naive byte slice can cut a multi-byte sequence in half and produce a
 * string that is not valid text, which for a JSON body means either a
 * replacement character where a verdict had a word or, worse, a body a strict
 * client refuses to parse. `StringDecoder` emits only the complete codepoints
 * in what it was given and keeps the incomplete tail to itself, which is
 * exactly the clip wanted here.
 */
export function clip(text: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= MAX_STREAM_BYTES) return { text, truncated: false };
  return {
    text: new StringDecoder("utf8").write(bytes.subarray(0, MAX_STREAM_BYTES)),
    truncated: true,
  };
}

/**
 * The ONE body shape a verb call and a hook call answer with.
 *
 * The exit code and both streams, exactly as the CLI produced them. A caller
 * reproducing the invocation locally writes `stdout`, writes `stderr`, and
 * exits `exit_code`; a caller that wants the verb's machine-readable refusal
 * parses `stderr`, which is the stream the CLI prints refusals on.
 *
 * The alternative — unwrapping the verb's own JSON object into the response —
 * was what this surface did before review, and it had two faults. It put the
 * exit code in a header that refusals forgot to set, and it made a verb that
 * printed something unexpected into a transport-level failure with its own
 * invented code. Returning the streams says less and cannot be wrong about it.
 */
function streamsBody(result: { code: number; stdout: string; stderr: string }): string {
  const out = clip(result.stdout);
  const err = clip(result.stderr);
  return JSON.stringify({
    exit_code: result.code,
    stdout: out.text,
    stderr: err.text,
    stdout_truncated: out.truncated,
    stderr_truncated: err.truncated,
  });
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

export interface CatalogEntry {
  name: string;
  title: string;
  description: string;
  inputSchema: unknown;
  /** Which credential opens this verb. Annotation only; the check is below. */
  scope: ServeScope;
}

/**
 * The published surface: `approval mcp serve`'s tool list, with each entry's
 * scope stated.
 *
 * Derived, not restated. A verb added to the registry tomorrow appears here
 * the same day it appears as an MCP tool, with `--as` already deleted from its
 * schema by the same function, and `grant` is absent for the same reason it is
 * absent there — the registry marks it `human_only` and no transport publishes
 * a human's authority. Its SCOPE is tenant until somebody puts it on
 * {@link AGENT_VERBS}, which is the fail-closed half of the same derivation.
 */
export function serveCatalog(): CatalogEntry[] {
  return toolDefinitions().map((tool) => ({
    name: tool.name,
    title: tool.title ?? tool.name,
    description: tool.description ?? "",
    inputSchema: tool.inputSchema,
    scope: AGENT_VERBS.has(tool.name) ? ("agent" as const) : ("tenant" as const),
  }));
}

/** Every name this surface publishes, for the scope rule below. */
const PUBLISHED_TOOL_NAMES: ReadonlySet<string> = new Set(
  publishedVerbs().map((spec) => toolName(spec)),
);

/**
 * The flags every hook call is made with.
 *
 * Exported so a test can hand the SAME argv to `commandHook` directly and
 * compare the bytes. That comparison is the acceptance criterion, and it is
 * only honest if both sides are the same invocation of the same verb: a test
 * that built its own flag list would be comparing two spellings.
 *
 * `--as` is appended LAST, as everywhere else on this surface, so the identity
 * the operator fixed when they started the process wins over anything that
 * arrived by another route (`parseFlags` keeps the last occurrence).
 */
export function hookArgv(
  options: Pick<
    ServeOptions,
    "actor" | "cwd" | "log" | "policy" | "hookTimeout" | "hookHarnessCap"
  >,
): string[] {
  return [
    "--dir",
    options.cwd,
    ...(options.log === undefined ? [] : ["--log", options.log]),
    ...(options.policy === undefined ? [] : ["--policy", options.policy]),
    ...(options.hookTimeout === undefined ? [] : ["--timeout", options.hookTimeout]),
    ...(options.hookHarnessCap === undefined
      ? []
      : ["--harness-cap", options.hookHarnessCap]),
    "--as",
    options.actor,
  ];
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

type Route =
  | { kind: "catalog" }
  | { kind: "verb"; name: string }
  | { kind: "hook"; harness: string }
  | { kind: "follow" }
  | { kind: "export" }
  | { kind: "status" };

/** The route a path names, or null. Method is checked by the handler. */
export function routeOf(pathname: string): Route | null {
  if (pathname === "/verbs") return { kind: "catalog" };
  if (pathname === "/log/follow") return { kind: "follow" };
  if (pathname === "/export") return { kind: "export" };
  if (pathname === "/status") return { kind: "status" };
  const verb = /^\/verb\/(?<name>[a-z0-9_-]+)$/u.exec(pathname);
  if (verb?.groups !== undefined) return { kind: "verb", name: verb.groups["name"] as string };
  const hook = /^\/hook\/(?<harness>[a-z0-9-]+)$/u.exec(pathname);
  if (hook?.groups !== undefined) {
    return { kind: "hook", harness: hook.groups["harness"] as string };
  }
  return null;
}

/**
 * Which credential opens a route.
 *
 * `null` means either one does, which is true of the catalog alone: it is the
 * published contract, it reads no log and it appends nothing, and both parties
 * have a reason to ask what this server is.
 */
export function scopeOf(route: Route): ServeScope | null {
  switch (route.kind) {
    case "catalog":
      return null;
    case "follow":
    case "export":
    case "status":
      return "tenant";
    case "hook":
      return "agent";
    default:
      // Three answers, and the third is the one worth reading twice.
      //
      // On the allowlist: the agent's. Published and not on it: the tenant's,
      // which is where a verb added to the registry tomorrow lands.
      //
      // NOT PUBLISHED AT ALL: the agent's, so the TENANT credential is refused
      // rather than falling through to a not-found. The names in that third
      // case are the verbs `mcp/server.ts` withholds for TRANSPORT reasons —
      // `consume` above all, which is the token spend, an agent-side act that
      // `run` wraps. The tenant credential must not reach it under any
      // spelling, and a caller that guessed a path is owed the true fact about
      // itself rather than a probe that answers differently. The agent
      // credential reaches the same arm and gets `serve-unknown-verb`, which
      // is also true: the verb is not on this surface.
      if (AGENT_VERBS.has(route.name)) return "agent";
      return PUBLISHED_TOOL_NAMES.has(route.name) ? "tenant" : "agent";
  }
}

// ---------------------------------------------------------------------------
// The listener
// ---------------------------------------------------------------------------

/**
 * Start the listener. Resolves once it is bound and its real port is known;
 * rejects when the bind fails, so the CLI can report it and exit.
 */
export async function serveApproval(options: ServeOptions): Promise<ServeHandle> {
  const host = options.host ?? "127.0.0.1";
  const notice = options.notice ?? ((): void => {});
  // ALWAYS pinned, on every verb call and in every scope, whether or not the
  // operator named them (review finding 3). One process serves one store, and
  // before this these three were injected only when the operator had passed
  // them and `--dir` never was — so a published `--log` from a caller was the
  // store the verb actually read. `buildArgv` appends these LAST, so a
  // caller's value loses even if the guard above somehow let one through.
  const paths: ServerOptions = {
    actor: options.actor,
    cwd: options.cwd,
    dir: options.cwd,
    log: options.log ?? logPathOf(options.cwd),
    // `--policy` names a FILE, so it is pinned only where the operator named
    // one. Where they did not, `--dir` above is the pin: the CLI resolves the
    // policy from that directory, which is exactly "the launch configuration's
    // policy". Pinning a directory here would hand every verb a path it would
    // try to read as a policy document.
    ...(options.policy === undefined ? {} : { policy: options.policy }),
  };

  // The store's lock (APRV-427): every verb call, follow page and export takes
  // it whole, and a hook call takes it for its mutation sections only. See the
  // header's "What is serialised" for the scope, and `storeLock` for why it is
  // keyed by store.
  const serialize = storeLock(paths.log ?? logPathOf(options.cwd), options.cwd);
  // Hook calls run on worker threads, because a hook's wait is a synchronous
  // `Atomics.wait` and on this thread it would stop the listener itself.
  const hooks = hookThreads(serialize, {
    threads: options.hookThreads ?? DEFAULT_HOOK_THREADS,
    queue: options.hookQueue ?? DEFAULT_HOOK_QUEUE,
  });

  const byName = new Map(publishedVerbs().map((spec) => [toolName(spec), spec]));
  const sockets = new Set<Socket>();
  let requests = 0;
  let closing = false;

  async function handleVerb(
    res: ServerResponse,
    spec: VerbSpec,
    args: unknown,
    scope: ServeScope,
  ): Promise<void> {
    // Every scope, before the argv is built: no caller names a store, no
    // caller names a path outside the one this process serves, and no
    // positional arrives wearing a dash.
    const checked = checkVerbArguments(spec, args, options.cwd, options.cwd, scope);
    if (!checked.ok) {
      refuse(res, 403, checked.code, checked.message);
      return;
    }
    const built = buildArgv(spec, args, paths);
    if (!built.ok) {
      refuse(res, 400, built.code, built.message);
      return;
    }
    const result = await serialize(() => invokeVerb(spec, built.argv, paths));
    // The CLI's own streams and the CLI's own exit code. A refusal arrives as
    // the `{"error":{...}}` the verb printed, on the stream it printed it on.
    send(res, 200, streamsBody(result), { "content-type": "application/json" });
  }

  async function handleHook(res: ServerResponse, harness: HarnessKind, body: string): Promise<void> {
    // The same function `main()` dispatches to (`commandHook`, on a worker
    // thread), with the request body as the stdin the verb would have read.
    // The verdict object, its dialect, its reason and its exit code are decided
    // entirely inside it; the thread changes where it runs and which stretches
    // of it hold the store lock, and nothing about what it answers.
    //
    // A client that goes away before its answer (APRV-427 review) aborts the
    // call: in line it leaves the line, and on its thread it stops at the next
    // poll tick WITHOUT spending a grant or withdrawing the question, so the
    // harness's retry adopts one or the other. Nothing is sent after that,
    // and nothing is sent once the listener is closing either: the socket is
    // about to be destroyed, and a caller with no answer blocks.
    const gone = new AbortController();
    res.once("close", () => {
      if (!res.writableFinished) gone.abort();
    });
    let outcome;
    try {
      outcome = await hooks.run(
        [harness, ...hookArgv(options)],
        options.cwd,
        paths.log ?? logPathOf(options.cwd),
        body,
        gone.signal,
      );
    } catch (cause) {
      if (cause instanceof HookCancelledError || gone.signal.aborted || closing) return;
      if (cause instanceof HookSaturatedError) {
        // Every slot and every place in line is taken. Refused at once rather
        // than queued without bound, because each running call is a thread
        // holding its own copy of the log; answered as a block, so the harness
        // does not proceed on a question nobody asked.
        refuseHook(res, 503, harness, "serve-hook-saturated", cause.message);
        return;
      }
      // The THREAD failed (it was terminated, or it died), which is not a
      // verdict. Answered as a refusal in the harness's own dialect, so a
      // client that writes `stdout` and exits `exit_code` blocks.
      refuseHook(
        res,
        500,
        harness,
        "serve-hook-failed",
        `the hook call did not complete: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return;
    }
    // `stdout` is BYTE-FOR-BYTE what `approval hook <harness>` printed, and
    // `exit_code` is the code it exited. Both travel in the body, because a
    // header is a thing a refusal can forget to set and an exit code that can
    // go missing is an allow waiting to happen. `stderr` rides along because
    // Hermes's ALLOW is `{}` and carries its reason there and nowhere else.
    if (gone.signal.aborted || closing) return;
    send(res, 200, streamsBody(outcome), { "content-type": "application/json" });
  }

  async function handleFollow(res: ServerResponse, url: URL): Promise<void> {
    const fromText = url.searchParams.get("from");
    const hashText = url.searchParams.get("cursor_hash");
    const limitText = url.searchParams.get("limit");

    // Every query parameter is validated BEFORE anything reads a file, and a
    // value out of range is refused rather than clamped. A clamp is a silent
    // answer to a different question than the one asked, and the caller cannot
    // tell it happened.
    if (fromText !== null && !/^\d+$/u.test(fromText)) {
      refuse(res, 400, "serve-invalid-cursor", `from expects a whole number, got ${JSON.stringify(fromText)}`);
      return;
    }
    const from = fromText === null ? 0 : Number(fromText);
    // `99999999999999999999` matches the digits above and is not a safe
    // integer: it reached the subscription, which threw a TypeError, which
    // escaped a GET as a 500. Refused here, in this verb's own vocabulary.
    if (!Number.isSafeInteger(from)) {
      refuse(
        res,
        400,
        "serve-invalid-cursor",
        `from ${JSON.stringify(fromText)} is larger than the largest sequence number this runtime can represent`,
      );
      return;
    }
    if (limitText !== null && !/^\d+$/u.test(limitText)) {
      refuse(res, 400, "serve-invalid-cursor", `limit expects a whole number, got ${JSON.stringify(limitText)}`);
      return;
    }
    const limit = limitText === null ? DEFAULT_FOLLOW_LIMIT : Number(limitText);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_FOLLOW_LIMIT) {
      refuse(
        res,
        400,
        "serve-invalid-cursor",
        `limit expects 1 to ${String(MAX_FOLLOW_LIMIT)}, got ${JSON.stringify(limitText)}`,
      );
      return;
    }
    if (hashText !== null && !/^[a-f0-9]{64}$/u.test(hashText)) {
      refuse(
        res,
        400,
        "serve-invalid-cursor",
        "cursor_hash expects a lowercase 64-character SHA-256 digest",
      );
      return;
    }
    if (hashText !== null && from === 0) {
      refuse(res, 400, "serve-invalid-cursor", "cursor_hash requires from greater than zero");
      return;
    }
    // A RESUME MUST CARRY ITS HASH. `core/log-subscribe.ts` calls the
    // sequence-only form "a weaker bootstrap ... by design", and it is weaker
    // in exactly one way: it cannot detect a fully recomputed replacement
    // prefix on its FIRST read. In the streaming form that costs one read,
    // because the process then retains the digest it verified and catches any
    // later replacement. Here every request is a first read, so the weakness
    // would be permanent: a replaced prefix would be served silently, forever,
    // to the caller who omitted the hash, while an honest caller who kept it
    // got the refusal. `from=0` is the only hashless form, because replaying
    // from genesis binds nothing and claims nothing.
    if (from > 0 && hashText === null) {
      refuse(
        res,
        400,
        "serve-invalid-cursor",
        `from=${String(from)} requires cursor_hash: a resume names the prefix it consumed, and a sequence number alone cannot tell this log from one whose records were recomputed. Send the hash from the cursor of your last page, or from=0 to replay the whole verified log`,
      );
      return;
    }

    const cursor: FollowCursor = { seq: from, hash: hashText };
    // Under the store lock, so no append THIS process makes lands underneath a
    // page: a verified read walks the whole chain, and an append landing under
    // one is a torn read this endpoint would report as an integrity failure of
    // the tenant's own log. A hook call in its wait holds no lock and appends
    // nothing, so it does not delay a page (APRV-427).
    const result = await serialize(() =>
      followPage(options.log ?? logPathOf(options.cwd), cursor, limit),
    );
    if (!result.ok) {
      // The subscription's own terminal failure, with the CLI's own code, the
      // CLI's own message, and NO RECORDS. `reason` carries `cursor-mismatch`
      // where there is one, so the caller need not read English to tell a torn
      // prefix from a cursor that belongs to another log.
      send(
        res,
        result.code === "integrity" ? 409 : 500,
        JSON.stringify({
          error: { code: result.code, message: result.message, reason: result.reason },
          exit_code: followFailureExit(result.code),
          records: [],
        }),
        { "content-type": "application/json" },
      );
      return;
    }
    send(res, 200, JSON.stringify({ ...result.page, exit_code: 0 }), {
      "content-type": "application/json",
    });
  }

  async function handleExport(res: ServerResponse): Promise<void> {
    // Under the store lock AND the append lock.
    //
    // The store lock is about this process: no verb and no hook's mutation
    // section appends while the snapshot is taken, and `gzipSync` blocks the
    // event loop for as long as the store is large. The APPEND lock is about
    // every other process — a daemon, a CLI
    // run beside this server — because the walk reads the log and the payload
    // store as one snapshot, and an append landing between the two copies a
    // record whose payload bytes are not there yet. `withAppendLock` is the
    // same exclusion `approval log sync` takes for the same reason, and it
    // hands the callback no write primitive: this endpoint gains only the
    // guarantee that nobody is appending while it reads.
    let archive;
    try {
      archive = await serialize(async () => {
        const logPath = options.log ?? logPathOf(options.cwd);
        const locked = withAppendLock(logPath, () => buildStoreArchive(options.cwd, logPath));
        if (!locked.ok) throw new Error(locked.error.message);
        return locked.value;
      });
    } catch (cause) {
      if (cause instanceof ExportHardLinkError) {
        refuse(res, 409, "serve-export-hardlink", cause.message, {
          path: cause.path,
          links: cause.links,
        });
        return;
      }
      if (cause instanceof ExportSymlinkError) {
        // Named, and the whole export refused rather than the link skipped: an
        // archive silently missing a file is an archive nobody can tell from a
        // complete one, and a tenant checking their exit against their own
        // `payload_hash` values would find the gap only by doing the check.
        refuse(res, 409, "serve-export-symlink", cause.message, { path: cause.path });
        return;
      }
      refuse(
        res,
        500,
        "serve-export-failed",
        `the store at ${options.cwd} could not be archived: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return;
    }
    send(res, 200, archive.bytes, {
      "content-type": "application/gzip",
      "content-disposition": `attachment; filename="approval-export-${options.daemonId}.tar.gz"`,
      "x-approval-export-paths": JSON.stringify(archive.paths),
    });
  }

  const http: HttpServer = createServer((req, res) => {
    void (async () => {
      requests += 1;
      try {
        // AUTHENTICATED FIRST, before the URL is even parsed. Two reasons, and
        // the second was a review finding: there is no unauthenticated surface
        // here, not a health check and not a 404, so a caller with no
        // credential learns nothing about what exists; and `new URL()` throws
        // on a malformed `Host` header, which used to happen BEFORE this check
        // and handed an unauthenticated caller a 500.
        //
        // Duplicate `Authorization` headers are refused outright rather than
        // resolved. Node keeps the FIRST and discards the rest for this header,
        // so a proxy, a client library or an attacker sending two can make the
        // credential this server checks differ from the one a reader of the
        // request would say was sent. There is no correct way to choose; the
        // request is malformed and is treated as such.
        // WHICH DIALECT this request would be answered in, read off the raw
        // request target before anything else (second review pass, finding 3).
        //
        // It decides the SHAPE OF A REFUSAL and nothing else: no route is
        // taken from it, no scope, no verb. It has to happen here because the
        // two refusals below — a rotated credential, a malformed Host — fire
        // before the URL is parsed, and a hook client that gets a body with no
        // block directive reads exit 0 as ALLOW on four of the six dialects. A
        // credential rotation should not open a gate.
        //
        // It discloses nothing: the path set is documented, the refusal's code
        // and message are unchanged, and a name that is not a harness this
        // runtime speaks for gets the generic body.
        const early = /^\/hook\/(?<harness>[a-z0-9-]+)(?:[/?#]|$)/u.exec(req.url ?? "");
        const earlyHarness =
          early?.groups !== undefined && isHarnessKind(early.groups["harness"])
            ? early.groups["harness"]
            : null;
        const refuseEarly = (status: number, code: string, message: string): void => {
          if (earlyHarness === null) refuse(res, status, code, message);
          else refuseHook(res, status, earlyHarness, code, message);
        };

        const offered = req.rawHeaders.filter(
          (entry, index) => index % 2 === 0 && entry.toLowerCase() === "authorization",
        ).length;
        const bearer = offered > 1 ? null : bearerOf(req.headers.authorization);
        const scope = bearer === null ? null : options.credentials.identify(bearer);
        if (scope === null) {
          refuseEarly(
            401,
            "serve-unauthorized",
            offered > 1
              ? `this request carries ${String(offered)} Authorization headers. Exactly one is accepted: where there are several, the one this server would check is not the one a reader of the request would name`
              : "no usable Authorization: Bearer <credential>. This server has two credentials, one for the agent surface and one for the tenant surface, and every path requires one of them",
          );
          return;
        }

        let url: URL;
        try {
          url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);
        } catch {
          // After authentication, so this says nothing to a stranger. The
          // `Host` header is the usual culprit and is named without being
          // echoed back.
          refuseEarly(
            400,
            "serve-malformed-url",
            "the request line and Host header do not form a URL this server can parse",
          );
          return;
        }

        const route = routeOf(url.pathname);
        if (route === null) {
          refuse(
            res,
            404,
            "serve-unknown-path",
            `no endpoint at ${url.pathname}; this server answers /verbs, /verb/<name>, /hook/<harness>, /log/follow, /export and /status`,
          );
          return;
        }

        // On the hook route every refusal from here on is spoken in the
        // harness's own dialect as well as in this server's, so a client that
        // writes `stdout` and exits `exit_code` blocks rather than proceeds.
        const harness =
          route.kind === "hook" && isHarnessKind(route.harness) ? route.harness : null;
        const deny = (status: number, code: string, message: string): void => {
          if (harness === null) refuse(res, status, code, message);
          else refuseHook(res, status, harness, code, message);
        };

        const required = scopeOf(route);
        if (required !== null && required !== scope) {
          const code = scope === "agent" ? "serve-agent-forbidden" : "serve-tenant-forbidden";
          deny(
            403,
            code,
            scope === "agent"
              ? `${url.pathname} answers to the TENANT credential. The agent credential reaches the hook and the verbs a harness under oversight needs in order to ask and to act on a grant; it never reaches the log it is judged by, the store export, the tenant's own status report, or anything that runs on the host`
              : `${url.pathname} answers to the AGENT credential. The tenant credential reaches the log, the export, status and every verb that touches the host; it does not act as the agent, because an action taken with it would be recorded under an identity nobody was acting as`,
          );
          return;
        }

        const method = req.method ?? "GET";
        const wants = route.kind === "verb" || route.kind === "hook" ? "POST" : "GET";
        if (method !== wants) {
          deny(405, "serve-method-not-allowed", `${url.pathname} answers ${wants}, not ${method}`);
          return;
        }

        if (route.kind === "catalog") {
          send(res, 200, JSON.stringify({ actor: options.actor, verbs: serveCatalog() }), {
            "content-type": "application/json",
          });
          return;
        }
        if (route.kind === "follow") {
          await handleFollow(res, url);
          return;
        }
        if (route.kind === "export") {
          await handleExport(res);
          return;
        }
        if (route.kind === "status") {
          const spec = byName.get("status");
          if (spec === undefined) {
            refuse(res, 500, "serve-unknown-verb", "the registry publishes no `status` verb");
            return;
          }
          await handleVerb(res, spec, {}, scope);
          return;
        }

        if (route.kind === "hook" && harness === null) {
          refuse(
            res,
            404,
            "serve-unknown-harness",
            `no hook adapter for ${JSON.stringify(route.harness)}; this runtime speaks ${Object.keys(HARNESS_ADAPTERS).join(", ")}`,
          );
          return;
        }

        const body = await readBody(req);
        if (!body.ok) {
          // The oversized-envelope case the review found: this used to be a
          // 413 with no exit code anywhere, which a client turned into exit 0,
          // and exit 0 is ALLOW on four of the six dialects. It is now a block
          // in the harness's own words.
          deny(body.status, body.code, body.message);
          return;
        }

        if (harness !== null) {
          // NOT wrapped in the store lock: a hook call takes it for its own
          // mutation sections and releases it while it waits (APRV-427).
          await handleHook(res, harness, body.text);
          return;
        }

        // Only the verb route reaches here: the hook arm returned above, and
        // every other route was handled before the body was read.
        if (route.kind !== "verb") {
          refuse(res, 500, "serve-unknown-path", `no handler for ${url.pathname}`);
          return;
        }
        const spec = byName.get(route.name);
        if (spec === undefined) {
          refuse(
            res,
            404,
            "serve-unknown-verb",
            `no verb ${JSON.stringify(route.name)} on this surface. GET /verbs lists what is published; a verb that records a human's authority is not among them, and never will be`,
          );
          return;
        }
        let args: unknown = {};
        if (body.text.trim().length > 0) {
          try {
            args = JSON.parse(body.text) as unknown;
          } catch (cause) {
            refuse(
              res,
              400,
              "serve-body-unreadable",
              `request body is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
            );
            return;
          }
        }
        await handleVerb(res, spec, args, scope);
      } catch (cause) {
        // A throw out of a handler is still a refusal with a code, because a
        // caller that got a bare 500 would have nothing to branch on.
        if (!res.headersSent) {
          refuse(
            res,
            500,
            "serve-body-unreadable",
            `the request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        } else {
          res.end();
        }
      }
    })();
  });

  http.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((settle, fail) => {
    const onError = (cause: Error): void => fail(cause);
    http.once("error", onError);
    http.listen(options.port, host, () => {
      http.off("error", onError);
      settle();
    });
  });

  const address = http.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : options.port;
  const boundHost = typeof address === "object" && address !== null ? address.address : host;
  notice(`approval: serve bound ${boundHost}:${String(boundPort)}\n`);

  return {
    host: boundHost,
    port: boundPort,
    requests: () => requests,
    hookThreads: () => hooks.stats(),
    close: async () => {
      if (closing) return;
      closing = true;
      // In this order (APRV-427 review). Stop accepting first. Then cancel
      // every hook call, which stops each waiting one at its next tick with
      // nothing spent and nothing withdrawn (its question stays open for the
      // retry grace, as for a killed `approval hook` process), and terminate
      // the threads from inside the store lock, which also waits out any verb
      // or mutation section still running. Only then are the sockets
      // destroyed, so no in-flight append is cut off by its connection going.
      const stopped = new Promise<void>((settle) => http.close(() => settle()));
      await hooks.close();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await stopped;
    },
  };
}

/**
 * One lock per store this process serves, keyed by the store's log path
 * (APRV-427).
 *
 * A listener serves one store today (`--dir`, `--log` and `--policy` are pinned
 * at launch), so each listener finds exactly one entry here. The map is what
 * makes the lock a property of the STORE rather than of a listener: two
 * listeners in one process over one store (a test, or a future multi-tenant
 * host) share a lock, and a host serving several stores gets one lock each, so
 * one tenant's writes never wait on another's. It lives for the process and
 * holds one closure per store, which is the whole of its cost.
 */
const STORE_LOCKS = new Map<string, StoreLock>();

/**
 * The lock for the store whose log is `logPath` (resolved against `root`).
 *
 * Exported so a test can hold the SAME lock the listener takes and watch what
 * waits on it: that is how the suite shows a hook call's appends are inside
 * the lock and its wait is outside it, rather than inferring it from timing.
 */
export function storeLock(logPath: string, root: string): StoreLock {
  const key = storeKey(resolve(root, logPath));
  let lock = STORE_LOCKS.get(key);
  if (lock === undefined) {
    lock = serializer();
    STORE_LOCKS.set(key, lock);
  }
  return lock;
}

/**
 * The key a store's lock is filed under: the log path with its DIRECTORY
 * resolved through `realpath`, so two spellings of one store (a symlinked
 * root, `/tmp` against `/private/tmp`) share one lock instead of each getting
 * their own. The directory rather than the file, because a store whose log has
 * not been written yet has no file to resolve; where even the directory is
 * missing, the resolved spelling is the best key there is.
 */
function storeKey(logPath: string): string {
  try {
    return resolve(realpathSync(dirname(logPath)), basename(logPath));
  } catch {
    return logPath;
  }
}

/** The default log under a store root, from the CLI's own constant. */
function logPathOf(root: string): string {
  return resolvePath(null, DEFAULT_LOG_PATH, root);
}
