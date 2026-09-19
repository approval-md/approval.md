/**
 * `approval codex bridge`: approval.md as the client of Codex's app-server
 * protocol (APRV-361, adopting APRV-349's recommendation).
 *
 * ## Why this exists
 *
 * The native Codex hook refuses every shell call. A `Bash` pre-event carries
 * `tool_input` keys exactly `["command"]`, so the adapter cannot bind the
 * directory the command will run in, and it answers
 * `hook-unsupported-execution-context` rather than approve bytes whose meaning
 * it does not know (APRV-310, APRV-311). The app-server protocol is a different
 * shape: Codex stops before it acts, asks its client, and waits, and the
 * question it asks carries `cwd` on the same frame as the command, minted by
 * the harness runtime rather than reported by the model.
 *
 * `docs/codex-app-server-bridge.md` is the evidence and the recommendation.
 * Read the recommendation before changing anything here: this is an ADVISORY
 * checkpoint for everyday Codex sessions this runtime starts, and it is not a
 * boundary. The auto-reviewer can resolve a question before this client sees
 * it, the approval policy and sandbox posture decide how many questions exist
 * at all, and a pending question is replayed to whatever connects next. Each of
 * those is governed by the harness's own configuration, which this project does
 * not attest. The claim this verb supports is "this client decided every
 * question it was asked", and nothing wider.
 *
 * ## It reuses the hook's flow; it does not fork it
 *
 * Every decision is `cli/hook.ts`'s {@link decideHarnessCall}: the same
 * classifier over `{command, cwd}`, the same human-only refusal, the same
 * unruled `harness.launch.*` refusal, the same sandbox requirement, the same
 * loop floor and unattended guard, and the same register, request and wait
 * against the verified view. What changes is only where the answer goes: a
 * JSON-RPC reply on the connection instead of a decision object on stdout.
 *
 * The request is translated into the hook's own `HookInput` — tool `Bash`,
 * `tool_input.command` the string the server sent, `cwd` the directory the
 * server named — and nothing else is invented. Both fields come from the
 * server, which is what makes them usable: a `cwd` the model reported would be
 * a self-reported field reducing scrutiny (SPEC §11.1 invariant 4).
 *
 * ## The deadline is the policy's, not a harness ceiling
 *
 * Every hook adapter answers inside a ceiling its harness sets, and the retry
 * grace and adopt-on-retry machinery exist so a denial-by-deadline is
 * recoverable. This transport has no timeout at all (`docs/codex-app-server-bridge.md`,
 * question 2), so the wait here defaults to the policy's `approval_ttl`: a
 * human who answers in eleven minutes is answering rather than arriving too
 * late. `--wait` overrides it; nothing shortens the request's own TTL.
 *
 * ## What it answers, and what it never answers
 *
 * `accept` and `decline` only, in the vocabulary the request advertised through
 * `availableDecisions`, and never `acceptForSession`, `cancel` or `abort`.
 * `acceptForSession` converts one decision into standing authority for a whole
 * session, which is a grant shape this project does not have. `cancel` and
 * `abort` mean "stop the turn", which is a different act from "no to this
 * action", and sending one would record an interruption as a denial.
 *
 * A `item/fileChange/requestApproval` on the item-based API carries no content:
 * `threadId`, `turnId`, `itemId`, `startedAtMs`, `reason` and `grantRoot`, and
 * the bytes arrived on an earlier frame. Approving an identifier is not
 * approving a change, so this verb declines it with its own code and says so.
 * The correlation that would let it be approved is APRV-379, and it waits on a
 * fact nobody has recorded: the shape of the frame the content arrives on.
 *
 * The LEGACY `applyPatchApproval` is different, and since APRV-363 it is
 * decided rather than declined: its `fileChanges` map rides on the request
 * itself, so there is nothing to correlate and nothing to re-render. It goes
 * through the same `decideHarnessCall` the exec half uses, classified by the
 * paths it names and bound with the change as it arrived plus its digest. A
 * request carrying a map and no directory is refused exactly as an exec request
 * with no `cwd` is: a relative path resolves somewhere, and a directory this
 * client guessed would be a guess the grant is bound to.
 *
 * A server request this verb does not recognise is declined too, on the same
 * rule: a question nobody classified is not a question to answer yes to.
 *
 * ## One at a time, on purpose
 *
 * The gate's wait is synchronous, so while one question is being decided this
 * process is not reading frames. That is the fail-closed direction: frames
 * queue and are answered in arrival order, and a second request cannot be
 * answered from a decision made about the first. The observed protocol asks one
 * question at a time (the turn does not move past an unanswered one).
 *
 * ## Limitations stated rather than implied
 *
 * An OPEN GATE WINDOW is not honoured here. The hook's bypass prints a hook
 * verdict and appends a record shaped for the hook; wiring it into this
 * transport is more surface than this task carries, and ignoring it is the
 * strict direction — a window widens authority, and this verb simply does not
 * widen. An operator who opens a window and expects this verb to fall through
 * will find it still asking.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";

import { boolFlag, parseFlags, stringFlag } from "./args.js";
import { EXIT_IO, EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import {
  HARNESS_ADAPTERS,
  decideHarnessCall,
  hookScope,
  type HarnessVerdict,
  type HookInput,
} from "./hook.js";
import type { Streams } from "./main.js";
import { HOOK_RETRY_GRACE_MS } from "../core/harness-wait.js";
import { canonicalize } from "../core/jcs.js";
import { loadPolicy, parseDuration } from "../core/policy-load.js";

/** The adapter every decision here is made under: Codex, through its own protocol. */
const ADAPTER = HARNESS_ADAPTERS["codex"];

/**
 * The approval policy this verb starts a thread under (`untrusted` on the
 * wire).
 *
 * `UnlessTrusted` is the only variant under which every command asks
 * (`docs/codex-app-server-bridge.md`, question 5), and `unless-trusted` is
 * REFUSED by the server: the accepted spelling is `untrusted`, established by
 * the 2026-09-18 probe. Pinning it here rather than exposing a flag is
 * deliberate for this task; APRV-366 makes the pin something the verb proves
 * rather than something it merely requests.
 */
const APPROVAL_POLICY = "untrusted";

/** The sandbox posture the thread starts under. */
const SANDBOX = "read-only";

/** Polling interval for the gate's verified read, in milliseconds. */
const DEFAULT_INTERVAL_MS = 2000;

/**
 * The decision words this verb will send, most literal first.
 *
 * `accept`/`decline` are the item-based API's spelling and `approved`/`denied`
 * the legacy one. The session-wide and amendment-carrying variants are absent
 * from the accept list, and `cancel`/`abort` from the decline list, for the
 * reasons in this module's header. A value this runtime does not name is never
 * sent, however loudly the server advertises it.
 */
const ACCEPT_WORDS = ["accept", "approved", "approve", "allow"] as const;
const DECLINE_WORDS = ["decline", "denied", "deny", "reject"] as const;

/** Server request methods this verb recognises as approval questions. */
const EXEC_APPROVAL_METHODS = [
  "item/commandExecution/requestApproval",
  "execCommandApproval",
] as const;
const FILE_CHANGE_APPROVAL_METHODS = [
  "item/fileChange/requestApproval",
  "applyPatchApproval",
] as const;

/**
 * Every refusal this verb can answer with that is NOT a gate verdict, closed
 * and machine-readable (SPEC §11.1 invariant 7).
 *
 * A gate verdict carries the gate's own code (`hook-class-human-only`,
 * `hook-rejected`, `hook-timeout`, and the rest); these are the refusals the
 * bridge reaches on its own, before or instead of asking.
 */
export const BRIDGE_REFUSAL_CODES = [
  /** A file-change request whose content this verb cannot produce (APRV-363). */
  "bridge-file-change-unbound",
  /** A server request this verb has no reading for. */
  "bridge-unknown-request",
  /** An exec request carrying no command string, or no cwd. */
  "bridge-request-unbound",
] as const;

export type BridgeRefusalCode = (typeof BRIDGE_REFUSAL_CODES)[number];

/** One answered question, for the report and for the tests. */
export interface BridgeAnswer {
  method: string;
  /** The server's own id for the request, echoed on the reply. */
  id: unknown;
  /** `accept` or `decline`, as this verb decided it. */
  outcome: "accept" | "decline";
  /** The word actually sent, which is the server's if it advertised one. */
  decision: string;
  /** Where that word came from: the request's own list, or this verb's fallback. */
  decisionSource: "advertised" | "fallback";
  /** The gate's code, or a {@link BRIDGE_REFUSAL_CODES} entry. `null` on an accept. */
  code: string | null;
  /** The gate's reason or the refusal's detail, for the operator. */
  detail: string;
}

/**
 * The decision words a request says are legal, if it says.
 *
 * Walked generically rather than read from one key path, so a renamed field of
 * the same shape still answers. This is the server describing its own
 * vocabulary, which is the one thing a client should never pin.
 */
export function advertisedDecisions(params: unknown): string[] {
  const found: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 8 || value === null || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (/decision/iu.test(key)) {
        if (Array.isArray(entry)) {
          for (const candidate of entry) if (typeof candidate === "string") found.push(candidate);
        } else if (typeof entry === "string") {
          found.push(entry);
        }
      }
      walk(entry, depth + 1);
    }
  };
  walk(params, 0);
  return [...new Set(found)];
}

/**
 * The word to send for this outcome, and where it came from (AC4).
 *
 * An advertised word wins, matched case-insensitively and then by prefix, so a
 * server that spells it `acceptWithExecpolicyAmendment` does not match `accept`
 * as a prefix — the exact match is tried for every candidate before any prefix
 * is. A request advertising nothing gets this verb's own first word, and the
 * report says `fallback` so the choice is visible rather than assumed.
 */
export function chooseDecision(
  params: unknown,
  outcome: "accept" | "decline",
): { decision: string; decisionSource: "advertised" | "fallback" } {
  const offered = advertisedDecisions(params);
  const order = outcome === "accept" ? ACCEPT_WORDS : DECLINE_WORDS;
  for (const candidate of order) {
    const match = offered.find((value) => value.toLowerCase() === candidate);
    if (match !== undefined) return { decision: match, decisionSource: "advertised" };
  }
  return { decision: order[0], decisionSource: "fallback" };
}

/** A frame the server sent: a request when it carries an id and a method. */
interface Frame {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

function stringField(source: unknown, key: string): string | null {
  if (source === null || typeof source !== "object") return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The exec request's command, as one string.
 *
 * The item-based API sends a shell-joined rendering and the legacy API an argv
 * array; both are accepted, and an array is joined here so the classifier sees
 * one command either way. That join is a re-rendering, and APRV-362 is the task
 * that records the re-parse beside the received string so a mismatch is visible
 * rather than silent. Until it lands, what is bound is what arrived.
 */
function commandOf(params: unknown): string | null {
  if (params === null || typeof params !== "object") return null;
  const value = (params as Record<string, unknown>)["command"];
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value)) {
    const words = value.filter((entry): entry is string => typeof entry === "string");
    if (words.length > 0 && words.length === value.length) return words.join(" ");
  }
  return null;
}

/**
 * A stable identity for the call, so two frames about one action are one
 * question.
 *
 * `itemId` on the item-based API, `callId` on the legacy one, and `approvalId`
 * where neither is present. It becomes the hook's `tool_use_id`, which is what
 * the task id is derived from.
 */
function callIdOf(params: unknown): string | null {
  return (
    stringField(params, "itemId") ??
    stringField(params, "callId") ??
    stringField(params, "approvalId")
  );
}

/** A line-delimited and `Content-Length`-delimited frame reader. */
class Connection {
  private buffer = Buffer.alloc(0);
  private nextId = 1;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onFrame: (frame: Frame) => void,
  ) {
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.absorb(chunk);
    });
    this.child.stdout.on("error", () => {});
    this.child.stdin.on("error", () => {});
  }

  private absorb(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.indexOf("Content-Length:") === 0) {
        const end = this.buffer.indexOf("\r\n\r\n");
        if (end === -1) return;
        const header = this.buffer.subarray(0, end).toString("utf8");
        const match = /Content-Length:\s*(\d+)/iu.exec(header);
        if (match === null) {
          this.buffer = this.buffer.subarray(end + 4);
          continue;
        }
        const length = Number(match[1]);
        if (this.buffer.length < end + 4 + length) return;
        const body = this.buffer.subarray(end + 4, end + 4 + length).toString("utf8");
        this.buffer = this.buffer.subarray(end + 4 + length);
        this.deliver(body);
        continue;
      }
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.buffer.subarray(0, newline).toString("utf8").trim();
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.length > 0) this.deliver(line);
    }
  }

  private deliver(text: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      // Not JSON. A client that threw here would take the server down with it;
      // an unreadable line is noise on a stream that also carries logs.
      return;
    }
    if (frame !== null && typeof frame === "object") this.onFrame(frame as Frame);
  }

  private write(value: unknown): void {
    if (this.child.stdin.destroyed || !this.child.stdin.writable) return;
    try {
      this.child.stdin.write(`${JSON.stringify(value)}\n`);
    } catch {
      // The server went away; the caller's own exit path reports that.
    }
  }

  /** The envelope has no `jsonrpc` member: a request is `{id, method, params}`. */
  request(method: string, params?: unknown): number {
    const id = this.nextId;
    this.nextId += 1;
    this.write({ id, method, ...(params === undefined ? {} : { params }) });
    return id;
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  /** A reply is `{id, result}`. */
  respond(id: unknown, result: unknown): void {
    this.write({ id, result });
  }
}

/** What the verb was asked to do, once the flags are read. */
interface BridgePlan {
  logPath: string;
  root: string;
  options: ReturnType<typeof hookScope>["options"];
  actor: string;
  workspace: string;
  prompt: string;
  waitMs: number;
  intervalMs: number;
  serverCommand: string;
  serverArgs: string[];
  json: boolean;
}

function usage(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "usage", message } })}\n`);
  else streams.err(`approval: ${message}\n`);
  return EXIT_USAGE;
}

/**
 * Decide one exec approval request through the gate (AC2, AC3).
 *
 * Exported for the tests, which drive it without a server so the DECISION can
 * be asserted apart from the transport.
 */
export function decideExecRequest(
  streams: Streams,
  plan: BridgePlan,
  params: unknown,
): { verdict: HarnessVerdict; threadId: string | null } {
  const command = commandOf(params);
  const cwd = stringField(params, "cwd");
  const callId = callIdOf(params);
  const threadId = stringField(params, "threadId") ?? stringField(params, "conversationId");
  if (command === null || cwd === null || callId === null) {
    // The three fields a decision needs. Missing any one of them, there is
    // nothing to bind and nothing to classify, and the answer is no.
    const missing = [
      command === null ? "command" : null,
      cwd === null ? "cwd" : null,
      callId === null ? "a call identity (itemId, callId or approvalId)" : null,
    ]
      .filter((entry): entry is string => entry !== null)
      .join(", ");
    return {
      threadId,
      verdict: {
        permission: "deny",
        code: "bridge-request-unbound",
        detail: `the approval request carries no ${missing}; a decision here would authorize bytes this client cannot name, so it is declined and nothing was appended`,
      },
    };
  }

  const input: HookInput = {
    sessionId: threadId ?? "codex-bridge",
    sessionIdPresent: threadId !== null,
    cwd,
    toolName: ADAPTER.shellTool,
    toolInput: { command },
    toolUseId: callId,
    hookEventName: null,
    model: null,
    toolResponse: null,
    toolResponseRaw: undefined,
    interrupted: false,
    harnessVersion: null,
  };

  return {
    threadId,
    verdict: decideHarnessCall({
      streams,
      input,
      adapter: ADAPTER,
      // The directory the SERVER named, which is the whole reason this verb
      // exists: the native hook has no such field and refuses for want of it.
      cwd,
      logPath: plan.logPath,
      root: plan.root,
      options: plan.options,
      actor: plan.actor,
      timeoutMs: plan.waitMs,
      intervalMs: plan.intervalMs,
      graceMs: HOOK_RETRY_GRACE_MS,
      // No open-window lookup was performed, so nothing is carried; the floor
      // and the unattended guard read the log themselves. See the module header
      // for why a window is not honoured here.
      windowRecords: null,
    }),
  };
}

/** The answer a file-change request with no content gets, and why. */
export function declineFileChange(params: unknown): BridgeAnswer {
  const chosen = chooseDecision(params, "decline");
  return {
    method: "item/fileChange/requestApproval",
    id: null,
    outcome: "decline",
    ...chosen,
    code: "bridge-file-change-unbound",
    detail:
      "the item-based file-change request carries an itemId and no content, and the bytes arrived on an earlier frame; approving an identifier is not approving a change, so it is declined. Correlating the two, once the notification's shape is recorded, is APRV-379",
  };
}

/**
 * The change map a file-change request carries INLINE, or `null` (APRV-363).
 *
 * The LEGACY `applyPatchApproval` carries `fileChanges`, a map of path to
 * change, on the request itself. There is nothing to correlate and nothing
 * arrives on another frame, so it is the one file-change shape this verb can
 * bind: the bytes it decides about are the bytes it was sent.
 */
export function inlineFileChanges(params: unknown): Record<string, unknown> | null {
  if (params === null || typeof params !== "object") return null;
  const value = (params as Record<string, unknown>)["fileChanges"];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const map = value as Record<string, unknown>;
  return Object.keys(map).length === 0 ? null : map;
}

/**
 * Decide one file-change request that carries its own content (APRV-363).
 *
 * Through the SAME path an exec request takes: the hook's `decideHarnessCall`,
 * so the human-only refusal, the loop floor, the unattended guard, the
 * registration and the wait are one implementation. What differs is the tool
 * name and the bound material, and the description of both is `cli/hook.ts`'s,
 * never this module's.
 *
 * The DIRECTORY is the one the server named (`cwd`, or the `grantRoot` the
 * legacy request carries for the same purpose), for the reason the exec half
 * gives: a relative path in the change resolves somewhere, and a directory this
 * client guessed would be a guess a grant is then bound to. Without one the
 * answer is the same refusal an exec request with no `cwd` gets.
 */
export function decideFileChangeRequest(
  streams: Streams,
  plan: BridgePlan,
  params: unknown,
): { verdict: HarnessVerdict; threadId: string | null } {
  const changes = inlineFileChanges(params);
  const cwd = stringField(params, "cwd") ?? stringField(params, "grantRoot");
  const callId = callIdOf(params);
  const threadId = stringField(params, "threadId") ?? stringField(params, "conversationId");
  if (changes === null || cwd === null || callId === null) {
    const missing = [
      changes === null ? "an inline fileChanges map" : null,
      cwd === null ? "a directory (cwd or grantRoot)" : null,
      callId === null ? "a call identity (itemId, callId or approvalId)" : null,
    ]
      .filter((entry): entry is string => entry !== null)
      .join(", ");
    return {
      threadId,
      verdict: {
        permission: "deny",
        code: changes === null ? "bridge-file-change-unbound" : "bridge-request-unbound",
        detail: `the file-change request carries no ${missing}; a decision here would authorize bytes this client cannot name, so it is declined and nothing was appended`,
      },
    };
  }

  const input: HookInput = {
    sessionId: threadId ?? "codex-bridge",
    sessionIdPresent: threadId !== null,
    cwd,
    toolName: "apply_patch",
    // The map VERBATIM, under the key the hook's describer reads. Nothing is
    // re-rendered into an `apply_patch` envelope: the classifier is given the
    // paths the server named, and the grant binds the change as it arrived.
    //
    // `command` beside it is the change's CANONICAL JSON, and it is identity
    // rather than content: the Codex adapter derives one task id per tool call
    // from the call's own bytes (`hook-codex.ts`'s `codexBinding`), and a call
    // with no such string could not be identified at all. Canonical so the same
    // change is the same call, whatever key order the server used. Nothing
    // classifies it and nothing executes it: the description above is built
    // from the map, and the payload a human sees is the map.
    toolInput: { file_changes: changes, command: canonicalize(changes) },
    toolUseId: callId,
    hookEventName: null,
    model: null,
    toolResponse: null,
    toolResponseRaw: undefined,
    interrupted: false,
    harnessVersion: null,
  };

  return {
    threadId,
    verdict: decideHarnessCall({
      streams,
      input,
      adapter: ADAPTER,
      cwd,
      logPath: plan.logPath,
      root: plan.root,
      options: plan.options,
      actor: plan.actor,
      timeoutMs: plan.waitMs,
      intervalMs: plan.intervalMs,
      graceMs: HOOK_RETRY_GRACE_MS,
      windowRecords: null,
    }),
  };
}

export async function runCodexBridge(
  argv: string[],
  streams: Streams,
  cwd: string,
): Promise<number> {
  const json = argv.includes("--json");
  const parsed = parseFlags(argv, {
    "--dir": "string",
    "--policy": "string",
    "--log": "string",
    "--as": "string",
    "--workspace": "string",
    "--prompt": "string",
    "--wait": "string",
    "--interval": "string",
    "--json": "boolean",
    "--help": "boolean",
    "-h": "boolean",
  });
  if (!parsed.ok) return usage(streams, json, parsed.message);
  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${CODEX_BRIDGE_HELP}\n`);
    return EXIT_OK;
  }

  const prompt = stringFlag(parsed.flags, "--prompt") ?? "";
  if (prompt.trim().length === 0) {
    return usage(streams, json, "bridge requires a prompt: `approval codex bridge --prompt <text>`");
  }
  /**
   * The app-server to start, after `--`, as `approval run` takes a command.
   *
   * Default `codex app-server`. The flag form exists for the tests, which drive
   * a stub that speaks the recorded shape — the script an operator runs once
   * has already been run, which is the same rule the probe keeps.
   */
  const server = parsed.positionals.length > 0 ? parsed.positionals : ["codex", "app-server"];

  const scope = hookScope(parsed.flags, cwd);
  const workspaceFlag = stringFlag(parsed.flags, "--workspace");
  const workspace = workspaceFlag === null ? cwd : resolve(cwd, workspaceFlag);

  const load = loadPolicy(
    scope.options.policy?.file === undefined
      ? { dir: scope.options.policy?.dir ?? cwd }
      : { file: scope.options.policy.file },
  );
  if (!load.ok) {
    // Fail closed before a server is started: a bridge that could not read the
    // policy would open a connection it must refuse every question on.
    const message = `${load.code}: ${load.message}; the bridge decides against the policy in force and will not start a session it cannot decide for`;
    if (json) streams.err(`${JSON.stringify({ error: { code: "bridge-policy-unavailable", message } })}\n`);
    else streams.err(`approval: ${message}\n`);
    return EXIT_IO;
  }

  const waitText = stringFlag(parsed.flags, "--wait");
  const waitMs = waitText === null ? load.durations.approvalTtlMs : parseDuration(waitText);
  if (waitMs === null || waitMs <= 0) {
    return usage(
      streams,
      json,
      waitText === null
        ? "this policy declares no defaults.approval_ttl, so the bridge has no deadline to wait to: pass --wait <duration>"
        : `--wait expects a duration like 30s, 10m, 6h, got ${JSON.stringify(waitText)}`,
    );
  }
  const intervalText = stringFlag(parsed.flags, "--interval");
  const intervalMs = intervalText === null ? DEFAULT_INTERVAL_MS : parseDuration(intervalText);
  if (intervalMs === null || intervalMs <= 0) {
    return usage(streams, json, `--interval expects a duration like 500ms, 2s, got ${JSON.stringify(intervalText)}`);
  }

  const plan: BridgePlan = {
    logPath: scope.logPath,
    root: scope.root,
    options: scope.options,
    actor: stringFlag(parsed.flags, "--as") ?? ADAPTER.defaultActor,
    workspace,
    prompt,
    waitMs,
    intervalMs,
    serverCommand: server[0] as string,
    serverArgs: server.slice(1),
    json,
  };

  return await driveSession(streams, plan);
}

/**
 * Run one turn, answering every approval question it raises.
 *
 * Resolves when the turn completes, the server exits, or a protocol step is
 * refused. Nothing here retries: a bridge that reconnected would be answering
 * questions a previous connection was asked, which is exactly the custody
 * problem APRV-365 exists to settle.
 */
function driveSession(streams: Streams, plan: BridgePlan): Promise<number> {
  return new Promise<number>((done) => {
    const answers: BridgeAnswer[] = [];
    let settled = false;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(plan.serverCommand, plan.serverArgs, {
        cwd: plan.workspace,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (cause) {
      streams.err(`approval: the app-server could not be started: ${String(cause)}\n`);
      done(EXIT_IO);
      return;
    }

    const finish = (code: number, reason: string): void => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      if (plan.json) {
        streams.out(`${JSON.stringify({ ok: code === EXIT_OK, reason, answers })}\n`);
      } else {
        streams.out(`${reason}\n`);
        for (const answer of answers) {
          streams.out(
            `  ${answer.outcome === "accept" ? "granted" : "declined"}  ${answer.decision}` +
              ` (${answer.decisionSource})  ${answer.code ?? "-"}  ${answer.detail}\n`,
          );
        }
      }
      done(code);
    };

    let threadId: string | null = null;
    let initializeId = -1;
    let threadStartId = -1;
    let turnStartId = -1;

    const answer = (id: unknown, method: string, outcome: "accept" | "decline", code: string | null, detail: string, params: unknown): void => {
      const chosen = chooseDecision(params, outcome);
      answers.push({ method, id, outcome, ...chosen, code, detail });
      connection.respond(id, { decision: chosen.decision });
    };

    const connection = new Connection(child, (frame) => {
      const method = typeof frame.method === "string" ? frame.method : null;

      // A server REQUEST: it carries both a method and an id, and it is waiting.
      if (method !== null && frame.id !== undefined) {
        if ((EXEC_APPROVAL_METHODS as readonly string[]).includes(method)) {
          const decided = decideExecRequest(streams, plan, frame.params);
          if (decided.verdict.permission === "allow") {
            answer(frame.id, method, "accept", null, decided.verdict.reason, frame.params);
          } else {
            answer(frame.id, method, "decline", decided.verdict.code, decided.verdict.detail, frame.params);
          }
          return;
        }
        if ((FILE_CHANGE_APPROVAL_METHODS as readonly string[]).includes(method)) {
          // A change carried INLINE is decided like any other call (APRV-363);
          // one that is an identifier and nothing else is declined, as it has
          // been since APRV-361.
          if (inlineFileChanges(frame.params) === null) {
            const refusal = declineFileChange(frame.params);
            answer(frame.id, method, "decline", refusal.code, refusal.detail, frame.params);
            return;
          }
          const decided = decideFileChangeRequest(streams, plan, frame.params);
          if (decided.verdict.permission === "allow") {
            answer(frame.id, method, "accept", null, decided.verdict.reason, frame.params);
          } else {
            answer(frame.id, method, "decline", decided.verdict.code, decided.verdict.detail, frame.params);
          }
          return;
        }
        // A question with no reading. Declining it is the same rule the file
        // change is declined under: an unclassified action is not one to say
        // yes to.
        answer(
          frame.id,
          method,
          "decline",
          "bridge-unknown-request",
          `this client has no reading for the server request ${method}, and a question nobody classified is not one to answer yes to`,
          frame.params,
        );
        return;
      }

      // A reply to one of this client's own requests.
      if (frame.id === initializeId && initializeId !== -1) {
        if (frame.error !== undefined) {
          finish(EXIT_IO, `the app-server refused initialize: ${JSON.stringify(frame.error)}`);
          return;
        }
        connection.notify("initialized", {});
        threadStartId = connection.request("thread/start", {
          cwd: plan.workspace,
          approvalPolicy: APPROVAL_POLICY,
          sandbox: SANDBOX,
        });
        return;
      }
      if (frame.id === threadStartId && threadStartId !== -1) {
        if (frame.error !== undefined) {
          finish(EXIT_IO, `the app-server refused thread/start: ${JSON.stringify(frame.error)}`);
          return;
        }
        threadId =
          stringField(frame.result, "threadId") ??
          stringField((frame.result as Record<string, unknown> | undefined)?.["thread"], "id");
        if (threadId === null) {
          finish(EXIT_IO, "thread/start succeeded and named no thread this client could find");
          return;
        }
        turnStartId = connection.request("turn/start", {
          threadId,
          input: [{ type: "text", text: plan.prompt }],
        });
        return;
      }
      if (frame.id === turnStartId && turnStartId !== -1 && frame.error !== undefined) {
        finish(EXIT_IO, `the app-server refused turn/start: ${JSON.stringify(frame.error)}`);
        return;
      }

      // Notifications. Only the turn's end is acted on; everything else is the
      // server narrating, and a client that branched on narration would be
      // deciding from something no hash bound.
      if (method === "turn/completed" || method === "turn/failed") {
        finish(
          EXIT_OK,
          `turn ${method === "turn/completed" ? "completed" : "failed"}: ${String(answers.length)} approval request(s) answered`,
        );
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      streams.err(chunk.toString("utf8"));
    });
    child.on("error", (cause) => {
      finish(EXIT_IO, `the app-server could not be started: ${cause.message}`);
    });
    child.on("exit", (code) => {
      finish(
        answers.length > 0 ? EXIT_OK : EXIT_IO,
        `the app-server exited (code ${String(code)}): ${String(answers.length)} approval request(s) answered`,
      );
    });

    initializeId = connection.request("initialize", {
      clientInfo: { name: "approval.md", title: "approval.md codex bridge", version: "0" },
      capabilities: {},
    });
  });
}

/** The help text, printed by `approval codex bridge --help`. */
export const CODEX_BRIDGE_HELP = [
  "approval codex bridge --prompt <text> [--workspace <dir>] [-- <server command>]",
  "",
  "Start `codex app-server` and answer every approval request it raises through",
  "the policy and the log: classify {command, cwd}, register, request, wait on the",
  "verified view, then reply accept or decline in the server's own vocabulary.",
  "",
  "  --prompt <text>       the turn to run (required)",
  "  --workspace <dir>     the thread's working directory (default: cwd)",
  "  --as <agent:id>       the acting identity (default: agent:codex)",
  "  --dir/--policy/--log  where the policy and the log are, as the hook resolves them",
  "  --wait <duration>     the deadline (default: the policy's approval_ttl)",
  "  --interval <duration> how often the verified view is re-read (default: 2s)",
  "  --json                one object: {ok, reason, answers[]}",
  "  -- <command...>       the app-server to start (default: codex app-server)",
  "",
  "It answers accept or decline only, never acceptForSession, cancel or abort.",
  "A file-change request carries no content on the item-based API, so it is",
  "declined (bridge-file-change-unbound). An open gate window is not honoured.",
  "See docs/codex-app-server-bridge.md.",
].join("\n");
