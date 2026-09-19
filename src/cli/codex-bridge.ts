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
 * That rule is carried by the TYPE since APRV-367, not by a reviewer's memory:
 * every reply word is a {@link BridgeDecisionWord}, whose eight inhabitants are
 * the four spellings of yes and the four of no, and {@link encodeDecision} is
 * the one place a decision becomes bytes and re-asks the question at runtime. A
 * word outside the vocabulary is unconstructible, and were one to arrive anyway
 * the reply becomes a decline, since the only safe substitute for a word you
 * cannot name is no.
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
 * ## The approval policy is pinned, and the pin is checked (APRV-366)
 *
 * The thread starts with `approvalPolicy: "untrusted"`, which is `UnlessTrusted`
 * on the wire and the only variant under which every command and every patch
 * asks. Under `on-request` or `never` an unknown fraction of the session never
 * reaches this client, and "this client decided every question it was asked"
 * would still be true while meaning nothing. There is no flag.
 *
 * What the verb can prove about it depends on the server. A `thread/start` the
 * server refuses stops the run, carrying its error verbatim, which is where a
 * refusal of the value itself lands. A server that reports an effective policy
 * of its own, on `thread/start`'s result or on a thread notification, stops the
 * run when that policy is not the pinned one. A server that reports nothing is
 * run against, and the report then claims only what happened: the pin was
 * requested and no frame confirmed it.
 *
 * ## A probe turn runs first, and it can stop the session (APRV-364)
 *
 * Codex carries a server-side auto-reviewer that can resolve an approval with a
 * model call before this client is asked, and tells the client afterwards
 * through `item/autoApprovalReview` notifications. Whether it runs is a setting
 * in the harness's own configuration, which this project does not attest, and
 * there is no frame in the observed vocabulary where the server reports it. So
 * it cannot be READ, and the only way to establish anything is to watch what
 * happens to one command.
 *
 * Every start therefore runs a PREFLIGHT turn asking for one harmless command
 * ({@link PROBE_COMMAND}) before the operator's own turn, with no flag to skip
 * it. Three outcomes, told apart by the command-item notifications:
 *
 * - an approval request for it reaches this client: the run continues, and the
 *   report records the pin as confirmed by OBSERVATION;
 * - a command ran and no request arrived: `bridge-approval-policy-mismatch`,
 *   because a policy under which one command did not ask is not `untrusted`
 *   whatever the server says about itself;
 * - no command ran at all: `bridge-preflight-void`, carrying the turn's frames
 *   verbatim. It is never retried and never reported as a pass.
 *
 * An `item/autoApprovalReview` notification in either turn is
 * `bridge-auto-reviewer-active` and ends the run, after one
 * `audit.question_preempted` is appended for it (APRV-378): the moment
 * something other than this gate answered a question this gate exists to ask is
 * the moment this project most wants in the log.
 *
 * THE PROBE'S OWN REQUEST NEVER REACHES THE GATE. It is declined immediately,
 * as an observation. Routing it through `decideHarnessCall` would register an
 * action and could put `true` on a human's phone at every bridge start, and a
 * preflight that spends a person's attention is not a harmless one.
 *
 * WHAT A PASS MEANS, exactly: one question reached this client unanswered by
 * anything else. It is not a proof that the auto-reviewer is off for every
 * question, and nothing here says that it is.
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
import { recordPreemptedQuestion } from "../core/question-preempted.js";
import { shlexJoin, shlexRoundTrips, shlexSplit } from "../core/shlex.js";

/** The adapter every decision here is made under: Codex, through its own protocol. */
const ADAPTER = HARNESS_ADAPTERS["codex"];

/**
 * The approval policy this verb starts a thread under (`untrusted` on the
 * wire).
 *
 * `UnlessTrusted` is the only variant under which every command asks
 * (`docs/codex-app-server-bridge.md`, question 5), and `unless-trusted` is
 * REFUSED by the server: the accepted spelling is `untrusted`, established by
 * the 2026-09-18 probe. There is no flag: a session gating an unknown fraction
 * of itself is the thing this pin exists to prevent, and an operator who could
 * pass `on-request` would have exactly that session (APRV-366).
 */
export const APPROVAL_POLICY = "untrusted";

/** The sandbox posture the thread starts under. */
export const SANDBOX = "read-only";

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
export const ACCEPT_WORDS = ["accept", "approved", "approve", "allow"] as const;
export const DECLINE_WORDS = ["decline", "denied", "deny", "reject"] as const;

/** One of the four spellings of yes this verb will send. */
export type BridgeAcceptWord = (typeof ACCEPT_WORDS)[number];
/** One of the four spellings of no. */
export type BridgeDeclineWord = (typeof DECLINE_WORDS)[number];
/**
 * Everything this verb can put in a `decision` field, as a type (APRV-367).
 *
 * The list is the whole vocabulary: eight spellings of two words. A value
 * outside it is a TYPE ERROR at every point the reply is built, which is the
 * half of the rule a reviewer cannot forget to check, and it is refused again
 * at runtime by {@link encodeDecision}, which is the half that survives a
 * caller with an `any` in it.
 */
export type BridgeDecisionWord = BridgeAcceptWord | BridgeDeclineWord;

/** The two things this verb ever means, whatever the server calls them. */
export type BridgeOutcome = "accept" | "decline";

/** Is this one of the eight words? The runtime face of {@link BridgeDecisionWord}. */
export function isBridgeDecisionWord(value: unknown): value is BridgeDecisionWord {
  return (
    typeof value === "string" &&
    ((ACCEPT_WORDS as readonly string[]).includes(value) ||
      (DECLINE_WORDS as readonly string[]).includes(value))
  );
}

/**
 * The reply payload for one word: the ONE place a decision becomes bytes.
 *
 * `null` for anything this runtime does not name. The types make such a value
 * unconstructible, so this is the defence against the code changing out from
 * under the types rather than against any input a server can send: no
 * `availableDecisions` list can reach it, because {@link chooseDecision} only
 * ever returns a member.
 *
 * The caller answers `null` by sending a DECLINE, and that is the whole
 * reasoning: the only safe substitute for a word you cannot name is no. It gets
 * no refusal code of its own, because a code in a closed union that no input
 * can produce is a string a second implementation cannot exercise and would
 * have to take on trust.
 */
export function encodeDecision(word: string): { decision: BridgeDecisionWord } | null {
  return isBridgeDecisionWord(word) ? { decision: word } : null;
}

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
  /**
   * An exec request whose command string names no argv this client can bind
   * (APRV-362).
   *
   * Distinct from `bridge-request-unbound`, which says a field is MISSING. This
   * one says the field arrived and could not be read as the rendering of an
   * argv: an unterminated quote, a bare double quote, a trailing backslash, or
   * whitespace no join produces. The repairs differ, which is why the codes do:
   * a missing `cwd` is a server that changed shape, and this is a command
   * string that did not come from joining the words that will run.
   */
  "bridge-command-unbound",
  /** An exec request carrying no command string, or no cwd. */
  "bridge-request-unbound",
] as const;

export type BridgeRefusalCode = (typeof BRIDGE_REFUSAL_CODES)[number];

/**
 * Every way this verb STOPS a session instead of answering a question
 * (APRV-366), closed and machine-readable.
 *
 * A separate array from {@link BRIDGE_REFUSAL_CODES}, and deliberately not a
 * member of it. Those are answers: one approval request declined, the turn
 * carrying on. These end the run before or instead of a turn, because the
 * session could not be established as the kind of session this verb is willing
 * to sit in front of. The conformance union `bridge_refusal_codes` is
 * documented as "every way the bridge can decline an app-server approval
 * request", so a stop code inside it would describe a different boundary, which
 * is the reasoning that kept these out of `hook_deny_codes` too.
 *
 * The process exit for both is {@link EXIT_IO}, as it is for every other
 * protocol stop here: the exit codes are frozen public API and a session that
 * could not be started is not a new number. The code below is the distinct part
 * a caller branches on.
 */
export const BRIDGE_STOP_CODES = [
  /**
   * The server refused `thread/start`, so no thread exists and the approval
   * policy this verb requires was never established. The server's own error is
   * carried verbatim in the detail, which is where a refusal of the policy
   * VALUE shows up (the 2026-09-18 probe's `unknown variant \`unless-trusted\`,
   * expected one of \`untrusted\`, \`on-request\`, \`granular\`, \`never\``).
   */
  "bridge-thread-start-refused",
  /**
   * The server started a thread and reported an effective approval policy that
   * is not {@link APPROVAL_POLICY}. Under any other variant an unknown fraction
   * of the session never produces a question at all, so "this client decided
   * every question it was asked" would be true and would mean nothing.
   */
  "bridge-approval-policy-mismatch",
  /**
   * An `item/autoApprovalReview` notification arrived, in the preflight turn or
   * in the real one (APRV-364).
   *
   * Codex carries a server-side auto-reviewer that can resolve an approval with
   * a model call BEFORE the client path runs, and tells the client afterwards
   * through these notifications (`docs/codex-app-server-bridge.md`, question
   * 3). A session with a reviewer in front of the gate is a session whose
   * silence means nothing: the questions this client was not asked are
   * indistinguishable from questions nobody wanted to ask. So the run stops
   * rather than gating whatever is left over.
   *
   * It leaves a RECORD since APRV-378: one `audit.question_preempted`,
   * appended through the real append path before the stop, naming the source,
   * the question as Codex identified it, and the verdict the reviewer reached
   * where the notification stated one. The write is best-effort and the stop
   * does not depend on it; a failure to append is reported on stderr beside
   * the stop rather than swallowed.
   */
  "bridge-auto-reviewer-active",
  /**
   * The preflight turn ran no command at all, so the probe established nothing
   * (APRV-364).
   *
   * The preflight is a prompt, and a model is free to answer a prompt in prose.
   * When that happens no approval request arrives AND no command executes, and
   * the fact AC1 wants — that a command reached this client as a question —
   * was not observed. Reporting it as a pass would be reporting a verdict
   * nobody established, which is the APRV-359 lesson; reporting it as the
   * policy mismatch would blame a healthy session for a model's choice of
   * words. So it is its own code, the report carries the turn's frames
   * verbatim, and nothing is retried: an operator runs the verb again.
   */
  "bridge-preflight-void",
] as const;

export type BridgeStopCode = (typeof BRIDGE_STOP_CODES)[number];

/**
 * Where the report's claim about the approval policy COMES FROM (APRV-364).
 *
 * APRV-366 wrote this as a boolean, and a boolean could say only that some
 * frame echoed the pin back. The preflight probe establishes the same thing a
 * different way, by watching what happens to one command, and the two are not
 * the same strength of evidence: an echo is the server describing itself, and
 * an observation is a thing that happened. A reader who is told `true` cannot
 * tell them apart, so the field names its source instead.
 *
 * - `unconfirmed` — nothing has confirmed the pin. Where every run starts, and
 *   where a run that stopped before the probe finished stays.
 * - `reported` — a server frame named the pinned policy as the effective one.
 *   The observed 0.155.0 server names none, so this is rare in practice.
 * - `observed` — a probe command produced an approval request that reached
 *   this client. THE HONESTY LINE, and it is narrow on purpose: it proves that
 *   ONE question reached this client unanswered by anything else. It is not a
 *   proof that the auto-reviewer is off, and no code or document here may say
 *   that it is.
 */
export const BRIDGE_PIN_SOURCES = ["unconfirmed", "reported", "observed"] as const;

export type BridgePinSource = (typeof BRIDGE_PIN_SOURCES)[number];

/**
 * The thread this verb started, as the report records it (APRV-366).
 *
 * `requested` is what went on the wire, `effective` is what the server said
 * about it, and `confirmed` is the difference between the two: a server that
 * echoes the policy back proves the pin, and one that says nothing leaves this
 * client able to claim only that it asked. That distinction is recorded rather
 * than smoothed over, because a report that said "untrusted" for both cases
 * would be asserting something no frame carried.
 *
 * `confirmed` widened from a boolean to a {@link BridgePinSource} in APRV-364,
 * when the probe gave it a second and stronger way to be true.
 */
export interface BridgeThreadRecord {
  id: string | null;
  cwd: string;
  requested: { approvalPolicy: string; sandbox: string };
  effective: { approvalPolicy: string | null };
  confirmed: BridgePinSource;
}

/**
 * The one command the preflight turn asks for (APRV-364).
 *
 * Chosen for having no effect: it writes nothing, reads nothing, prints
 * nothing, and exits zero. The point of the probe is the QUESTION it raises,
 * and a probe whose command mattered would be a probe an operator had to think
 * about before running.
 */
export const PROBE_COMMAND = "true";

/**
 * The preflight prompt, written to leave a model as little room as a prompt can
 * (APRV-364).
 *
 * It cannot leave none, which is why {@link BRIDGE_STOP_CODES} carries
 * `bridge-preflight-void`: a model that answers in prose has run no command,
 * and that outcome is reported rather than guessed at.
 */
export const PROBE_PROMPT = [
  `Run exactly one shell command: ${PROBE_COMMAND}`,
  "Run nothing else. Do not read or write any file, do not look around the workspace,",
  "and do not explain. Running that one command is the whole task.",
].join(" ");

/** What the preflight turn established, once it ended. */
export const BRIDGE_PROBE_OUTCOMES = ["pending", "asked", "executed", "void"] as const;

export type BridgeProbeOutcome = (typeof BRIDGE_PROBE_OUTCOMES)[number];

/**
 * The preflight turn, as the report records it (APRV-364).
 *
 * `outcome` is the whole of what the probe established:
 *
 * - `asked` — an approval request for the probe arrived, so one question
 *   reached this client. The session continues.
 * - `executed` — a command ran and no request arrived. A policy under which
 *   one command did not ask is not `untrusted`, whatever the server said about
 *   itself, so the run stops under `bridge-approval-policy-mismatch`.
 * - `void` — no command ran at all, so nothing was established. The run stops
 *   under `bridge-preflight-void` and `frames` carries the turn verbatim.
 * - `pending` — the turn has not ended. Only ever seen in a report that
 *   stopped for some other reason first.
 */
export interface BridgePreflightRecord {
  turnId: string | null;
  /** The command the prompt named: {@link PROBE_COMMAND}. */
  command: string;
  outcome: BridgeProbeOutcome;
  /**
   * The word sent on the probe's own approval request, when one arrived.
   *
   * Always a decline. The probe is an observation, and a probe this client
   * approved would be a probe that ran.
   */
  decision: BridgeDecisionWord | null;
  /**
   * Every frame the preflight turn produced, verbatim, present ONLY on the
   * void stop.
   *
   * On a void there is nothing else to show: the stop says a fact could not be
   * established, and the frames are the whole of the evidence for why. On any
   * other outcome they are noise, and a report that always carried them would
   * bury the line that matters.
   */
  frames?: unknown[];
  /** The turn's own error, when `turn/failed` ended it. */
  error?: unknown;
}

/**
 * The effective approval policy a server frame reports, or `null` when it
 * reports none.
 *
 * The locations are a documented short list rather than a generic walk: this
 * value can STOP a session, so it is read from places whose meaning is known,
 * and a stray `approvalPolicy` nested inside some unrelated structure must not
 * be able to end a run. The observed 0.155.0 server echoes none of them, which
 * is why an absent value is not itself a stop.
 */
export function effectiveApprovalPolicy(value: unknown): string | null {
  const object = (candidate: unknown): Record<string, unknown> | null =>
    candidate !== null && typeof candidate === "object"
      ? (candidate as Record<string, unknown>)
      : null;
  const top = object(value);
  if (top === null) return null;
  for (const holder of [top, object(top["thread"]), object(top["config"]), object(top["settings"])]) {
    if (holder === null) continue;
    const named = holder["approvalPolicy"] ?? holder["approval_policy"];
    if (typeof named === "string" && named.length > 0) return named;
  }
  return null;
}

/** One answered question, for the report and for the tests. */
export interface BridgeAnswer {
  method: string;
  /** The server's own id for the request, echoed on the reply. */
  id: unknown;
  /** `accept` or `decline`, as this verb decided it. */
  outcome: BridgeOutcome;
  /**
   * The word actually sent: one of the eight this runtime names, chosen to
   * match what the request advertised (APRV-367). Its TYPE is the vocabulary,
   * so a row saying `acceptForSession` cannot be constructed here.
   */
  decision: BridgeDecisionWord;
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
 * An advertised word wins, matched case-insensitively and NEVER by prefix, so a
 * server that offers `acceptWithExecpolicyAmendment` is not read as offering
 * `accept`: an amendment carries terms nobody approved. A request advertising
 * nothing gets this verb's own first word, and the report says `fallback` so
 * the choice is visible rather than assumed.
 *
 * What it returns is this runtime's own spelling of the matched word rather
 * than the server's (APRV-367). That is the point of the type: a
 * {@link BridgeDecisionWord} has eight inhabitants, all of them named here, so
 * no path through this function can produce a word this project did not choose
 * to be able to send. The two spellings differ only in letter case, since the
 * match is case-insensitive equality with one of the eight.
 */
export function chooseDecision(
  params: unknown,
  outcome: BridgeOutcome,
): { decision: BridgeDecisionWord; decisionSource: "advertised" | "fallback" } {
  const offered = advertisedDecisions(params);
  const order = outcome === "accept" ? ACCEPT_WORDS : DECLINE_WORDS;
  for (const candidate of order) {
    const match = offered.find((value) => value.toLowerCase() === candidate);
    if (match !== undefined) return { decision: candidate, decisionSource: "advertised" };
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
 * The exec request's command, as BOTH the words that will run and the string
 * that renders them (APRV-362).
 *
 * ## Which API, and why the string has to be un-joined
 *
 * The two live shapes differ in the one way that matters. The legacy
 * `execCommandApproval` sends `command` as an argv array, which is what the
 * kernel receives. The item-based `item/commandExecution/requestApproval` sends
 * it as a single string, produced by `shlex_join` over that same argv
 * (`docs/codex-app-server-bridge.md`, question 1). This verb drives the
 * ITEM-BASED API, so the string is what it must consume, and the decision the
 * task asked for is settled by which API the bridge speaks rather than by
 * preference: the legacy array is still read, because a request in that shape
 * is a request this client can answer, but it is not the path in use.
 *
 * Consuming the string means un-joining it. A classifier handed the rendering
 * and never the words is classifying its own re-parse, and the gap between the
 * two is where an approval could authorize words nobody read. So both are
 * produced here, both reach the registered payload, and a reader can see the
 * one against the other instead of being asked to trust that they agree.
 *
 * ## What this refuses, and what it deliberately does not
 *
 * A string that is not readable as a join — an unterminated quote, a bare
 * double quote, a trailing backslash, or separation no join emits — is refused
 * with `bridge-command-unbound`. So is an argv this runtime cannot render and
 * read back unchanged, which is unreachable for a correct {@link shlexJoin} and
 * checked anyway, because the cost is one pass over a short string and the
 * failure it guards against is binding words nobody will run.
 *
 * It does NOT demand that {@link shlexJoin} reproduce the received bytes. That
 * would pin the counterpart's quoting predicate, which this repository has no
 * record of: the probe captured one command string and it is consistent with
 * every candidate. A join written for shell safety quotes more than this one
 * does, so demanding byte equality would refuse ordinary traffic on a guess.
 * What is demanded instead is the part that is checkable without knowing which
 * characters the counterpart chose to quote, and the rest is recorded.
 *
 * `proposedExecpolicyAmendment` is deliberately not read, though the task names
 * it as a candidate second source. The 2026-09-18 observation records that the
 * field was PRESENT and records nothing about its shape, and a comparison
 * written against a guessed shape silently matches nothing, which is worse than
 * the check it pretends to be. It becomes usable once a probe captures it.
 */
export type BoundCommand =
  | { ok: true; command: string; argv: string[]; source: "rendering" | "argv" }
  | { ok: false; reason: string };

export function bindCommand(params: unknown): BoundCommand | null {
  if (params === null || typeof params !== "object") return null;
  const value = (params as Record<string, unknown>)["command"];

  if (typeof value === "string" && value.length > 0) {
    const split = shlexSplit(value);
    if (!split.ok) return { ok: false, reason: split.reason };
    // An all-whitespace string carries a command field and no command, which is
    // the missing-field answer rather than this one.
    if (split.argv.length === 0) return null;
    if (!split.joinShaped) {
      return {
        ok: false,
        reason:
          "its words are not separated the way a join separates them (one space each, none leading or trailing), so the string did not come from joining the argv that will run",
      };
    }
    if (!shlexRoundTrips(split.argv)) {
      return { ok: false, reason: "the words it names cannot be rendered and read back unchanged" };
    }
    return { ok: true, command: value, argv: split.argv, source: "rendering" };
  }

  if (Array.isArray(value)) {
    const argv = value.filter((entry): entry is string => typeof entry === "string");
    if (argv.length === 0 || argv.length !== value.length) return null;
    if (!shlexRoundTrips(argv)) {
      return { ok: false, reason: "the words it names cannot be rendered and read back unchanged" };
    }
    // Rendered, not concatenated. `argv.join(" ")` hands the classifier
    // `bash -lc rm -rf build` for `["bash","-lc","rm -rf build"]`, which is
    // four more words than the kernel will ever see and a different command.
    return { ok: true, command: shlexJoin(argv), argv, source: "argv" };
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

/**
 * The turn a frame belongs to, where it names one (APRV-364).
 *
 * The preflight and the real turn are told apart by this value, and a frame
 * that names no turn is decided by which turn is running instead. Both
 * spellings are read because the protocol has used both casings elsewhere and
 * neither reading can widen anything: a turn id is only ever used to decide
 * which of two phases a frame belongs to.
 */
export function turnIdOf(params: unknown): string | null {
  return stringField(params, "turnId") ?? stringField(params, "turn_id");
}

/**
 * Is this method one of Codex's auto-approval-review notifications (APRV-364)?
 *
 * The recorded names are `item/autoApprovalReview/started` and
 * `item/autoApprovalReview/completed`
 * (`docs/codex-app-server-bridge.md`, question 3). The match is on the
 * SUBSTRING rather than on those two exact names, case-folded, because a
 * reviewer notification this runtime failed to recognise would be a session
 * that ran with a reviewer in front of the gate: over-matching costs a stop
 * that an operator can read and re-run, and under-matching costs the whole
 * point of the check.
 */
export function isAutoReviewNotification(method: string): boolean {
  return method.toLowerCase().includes("autoapprovalreview");
}

/**
 * The verdict an auto-review notification states, or `null` (APRV-378).
 *
 * Read from a short list of named places rather than by a generic walk, for the
 * reason {@link effectiveApprovalPolicy} is: this value goes into the log as
 * another party's decision, and a string picked up from some unrelated
 * structure would be this runtime putting words in their mouth. `null` is
 * recorded as an ABSENT verdict, never as a default one.
 */
export function autoReviewVerdict(params: unknown): string | null {
  if (params === null || typeof params !== "object") return null;
  const top = params as Record<string, unknown>;
  const holder = top["review"] ?? top["assessment"] ?? top["result"];
  const nested =
    holder !== null && typeof holder === "object" ? (holder as Record<string, unknown>) : null;
  for (const source of [top, nested]) {
    if (source === null) continue;
    for (const key of ["decision", "verdict", "outcome"]) {
      const named = source[key];
      if (typeof named === "string" && named.length > 0) return named;
    }
  }
  return null;
}

/**
 * Does this notification say a COMMAND was executed (APRV-364)?
 *
 * The one reader in this file written against a shape nobody recorded in full.
 * The 2026-09-18 vocabulary carries `item/started` and `item/completed`, and it
 * does not record the item object they carry, so this looks for an item whose
 * type reads as a command execution, or, failing that, for an item carrying a
 * `command` string.
 *
 * That is a guess, and the reason it is an acceptable one is the direction it
 * fails in. This value only ever chooses BETWEEN TWO STOPS: a preflight turn
 * where a command ran without asking stops under
 * `bridge-approval-policy-mismatch`, and one where nothing ran stops under
 * `bridge-preflight-void`. A guess that misses turns the first into the
 * second; it can never turn either into a pass, because a pass needs an
 * approval request to have ARRIVED, which is a frame this client was handed
 * rather than one it went looking for. The void report carries the frames
 * verbatim, which is also how the real item shape gets recorded here at last.
 */
export function namesCommandExecution(params: unknown): boolean {
  if (params === null || typeof params !== "object") return false;
  const holder = (params as Record<string, unknown>)["item"];
  const item = holder !== null && typeof holder === "object" ? (holder as Record<string, unknown>) : null;
  if (item === null) return false;
  for (const key of ["type", "itemType", "item_type"]) {
    const named = item[key];
    if (typeof named !== "string") continue;
    if (named.toLowerCase().replace(/[^a-z]/gu, "").startsWith("commandexecution")) return true;
  }
  return typeof item["command"] === "string" && (item["command"] as string).length > 0;
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
  const bound = bindCommand(params);
  const cwd = stringField(params, "cwd");
  const callId = callIdOf(params);
  const threadId = stringField(params, "threadId") ?? stringField(params, "conversationId");
  if (bound === null || cwd === null || callId === null) {
    // The three fields a decision needs. Missing any one of them, there is
    // nothing to bind and nothing to classify, and the answer is no.
    const missing = [
      bound === null ? "command" : null,
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
  if (!bound.ok) {
    // APRV-362. The command arrived and this client cannot say which words it
    // renders. Approving it would approve a parse, so it is declined before
    // anything is classified and nothing is appended.
    return {
      threadId,
      verdict: {
        permission: "deny",
        code: "bridge-command-unbound",
        detail: `the approval request's command cannot be bound to the argv it will run: ${bound.reason}; a decision here would authorize this client's own re-parse rather than the words the server holds, so it is declined and nothing was appended`,
      },
    };
  }

  const input: HookInput = {
    sessionId: threadId ?? "codex-bridge",
    sessionIdPresent: threadId !== null,
    cwd,
    toolName: ADAPTER.shellTool,
    // Both accounts of the call, so the registered payload names the words and
    // the rendering side by side (APRV-362). `codexArgv` re-splits the command
    // and accepts the argv only when the two agree, so what reaches the payload
    // is a derivation of bytes already bound rather than a second claim.
    toolInput: { command: bound.command, argv: bound.argv },
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
 * Run the preflight turn and then the real one, answering every approval
 * question either of them raises.
 *
 * Resolves when the turn completes, the server exits, or a protocol step is
 * refused. Nothing here retries: a bridge that reconnected would be answering
 * questions a previous connection was asked, which is exactly the custody
 * problem APRV-365 exists to settle. A void preflight is not retried either,
 * for the reason {@link BRIDGE_STOP_CODES} gives.
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

    // What this session asked for, before the server has said anything about
    // it. Recorded from the start so a run that stops at `thread/start` still
    // reports which pin it was refused over (APRV-366).
    const thread: BridgeThreadRecord = {
      id: null,
      cwd: plan.workspace,
      requested: { approvalPolicy: APPROVAL_POLICY, sandbox: SANDBOX },
      effective: { approvalPolicy: null },
      confirmed: "unconfirmed",
    };

    // The probe turn, before it has run (APRV-364). Recorded from the start for
    // the reason the thread is: a run that stops early still says which proof
    // it was reaching for.
    const preflight: BridgePreflightRecord = {
      turnId: null,
      command: PROBE_COMMAND,
      outcome: "pending",
      decision: null,
    };
    /** Every frame the preflight turn produced, for the void report. */
    const preflightFrames: unknown[] = [];
    /** Which turn is running: the probe's, or the operator's. */
    let phase: "preflight" | "live" = "preflight";

    /** How the pin was confirmed, in words, for the human report. */
    const pinLine = (): string => {
      if (thread.confirmed === "observed") {
        return `confirmed by observation of one probe command (${PROBE_COMMAND}); that one question reached this client, which is not a proof that the auto-reviewer is off`;
      }
      if (thread.confirmed === "reported") return "reported by the server, not observed";
      return `requested; the server reported ${thread.effective.approvalPolicy ?? "none"}`;
    };

    const finish = (code: number, reason: string, stop: BridgeStopCode | null = null): void => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      // The frames ride only on the void stop, where they are the evidence for
      // a fact that could not be established. See `BridgePreflightRecord`.
      const preflightReport: BridgePreflightRecord =
        stop === "bridge-preflight-void" ? { ...preflight, frames: preflightFrames } : preflight;
      if (plan.json) {
        streams.out(
          `${JSON.stringify({ ok: code === EXIT_OK, reason, ...(stop === null ? {} : { code: stop }), thread, preflight: preflightReport, answers })}\n`,
        );
      } else {
        streams.out(`${stop === null ? reason : `${stop}: ${reason}`}\n`);
        streams.out(
          `  thread ${thread.id ?? "(none)"}  approvalPolicy ${thread.requested.approvalPolicy}` +
            ` (${pinLine()})` +
            `  sandbox ${thread.requested.sandbox}\n`,
        );
        streams.out(
          `  preflight ${preflight.turnId ?? "(none)"}  ${preflight.command}  ${preflight.outcome}\n`,
        );
        for (const answer of answers) {
          streams.out(
            `  ${answer.outcome === "accept" ? "granted" : "declined"}  ${answer.decision}` +
              ` (${answer.decisionSource})  ${answer.code ?? "-"}  ${answer.detail}\n`,
          );
        }
      }
      done(code);
    };

    /**
     * Take what a frame says about the effective approval policy, and stop the
     * session when it names one this verb did not ask for.
     *
     * Returns true when the caller should stop. A frame naming nothing leaves
     * `confirmed` false and is NOT a stop: the observed server echoes no policy
     * at all, and a client that demanded an echo could not run against it. What
     * the report then claims is only that the pin was requested.
     */
    const pinnedOrStop = (value: unknown, where: string): boolean => {
      const named = effectiveApprovalPolicy(value);
      if (named === null) return false;
      thread.effective.approvalPolicy = named;
      if (named === APPROVAL_POLICY) {
        // Never downgrades an observation: the probe is the stronger of the two
        // proofs and a later echo says nothing it did not already say.
        if (thread.confirmed !== "observed") thread.confirmed = "reported";
        return false;
      }
      finish(
        EXIT_IO,
        `${where} reports the thread's effective approval policy as ${JSON.stringify(named)}, and this verb starts a session only under ${JSON.stringify(APPROVAL_POLICY)}, the one variant under which every command and every patch asks. Under any other variant an unknown part of the session never reaches this client at all, so nothing was answered and the session was stopped`,
        "bridge-approval-policy-mismatch",
      );
      return true;
    };

    let threadId: string | null = null;
    let initializeId = -1;
    let threadStartId = -1;
    /** The `turn/start` this client sent for the probe, and for the real turn. */
    let preflightStartId = -1;
    let liveStartId = -1;

    /**
     * Does this frame belong to the PREFLIGHT turn (APRV-364)?
     *
     * By turn id where the frame names one, which is the answer that survives
     * frames arriving out of order. A frame naming no turn is decided by which
     * turn is running, which is the only reading available and is also the
     * strict one: during the probe, an unlabelled approval request is treated
     * as the probe's and is therefore DECLINED without reaching the gate.
     */
    const isPreflightFrame = (params: unknown): boolean => {
      const named = turnIdOf(params);
      if (named !== null && preflight.turnId !== null) return named === preflight.turnId;
      return phase === "preflight";
    };

    const answer = (id: unknown, method: string, outcome: BridgeOutcome, code: string | null, detail: string, params: unknown): void => {
      const chosen = chooseDecision(params, outcome);
      // The send boundary re-asks what the type already answered (APRV-367). A
      // word this runtime cannot name is never put on the wire; the reply
      // becomes a decline, because the only safe substitute for a word you
      // cannot name is no. Unreachable while the types hold, which is why it
      // carries no code of its own.
      const encoded = encodeDecision(chosen.decision) ?? { decision: DECLINE_WORDS[0] };
      answers.push({ method, id, outcome, ...chosen, decision: encoded.decision, code, detail });
      connection.respond(id, encoded);
    };

    /**
     * Answer the PROBE's own approval request, and never through the gate
     * (APRV-364).
     *
     * A decline, immediately, recorded as an observation. Two reasons it does
     * not take the gate's path. It would register an action and open a request,
     * which means the probe command on a human's phone at every bridge start,
     * and a preflight that spent a person's attention would be the opposite of
     * harmless. And the fact wanted here is only that the question ARRIVED:
     * what the policy would have said about `true` is beside the point.
     */
    const observeProbe = (id: unknown, params: unknown, aboutACommand: boolean): void => {
      const chosen = chooseDecision(params, "decline");
      const encoded = encodeDecision(chosen.decision) ?? { decision: DECLINE_WORDS[0] };
      if (aboutACommand) {
        preflight.outcome = "asked";
        preflight.decision = encoded.decision;
        // The one place this becomes `observed`, and the claim it licenses is
        // written down beside it in `BRIDGE_PIN_SOURCES`: one question reached
        // this client unanswered by anything else.
        thread.confirmed = "observed";
        streams.err(
          `approval: the preflight probe (${PROBE_COMMAND}) was asked about, so one question reached this client; declining it and starting the turn\n`,
        );
      } else {
        // The probe asks for one command and the prompt forbids everything
        // else, so a file change here is a turn that went its own way. It is
        // declined like the rest of the preflight and it proves nothing about
        // a command, so the outcome is left for the turn's end to decide.
        streams.err(
          "approval: the preflight turn raised a file-change approval, which the probe never asks for; declining it\n",
        );
      }
      connection.respond(id, encoded);
    };

    const connection = new Connection(child, (frame) => {
      const method = typeof frame.method === "string" ? frame.method : null;

      // Codex's own reviewer answered something before this client saw it. It
      // ends the run wherever it appears, because from here a resolved question
      // and a question nobody asked look the same (APRV-364).
      if (method !== null && isAutoReviewNotification(method)) {
        // The RECORD first, then the stop (APRV-378). A verdict with nothing
        // behind it is the shape of claim this project is built against, and
        // the write is best-effort: it never changes the stop, and a failure to
        // write is reported beside it rather than swallowed.
        const recorded = recordPreemptedQuestion(
          plan.logPath,
          {
            source: "codex-auto-reviewer",
            id: callIdOf(frame.params) ?? "",
            method,
            ...(stringField(frame.params, "threadId") === null
              ? {}
              : { thread: stringField(frame.params, "threadId") as string }),
            ...(turnIdOf(frame.params) === null ? {} : { turn: turnIdOf(frame.params) as string }),
            ...(autoReviewVerdict(frame.params) === null
              ? {}
              : { verdict: autoReviewVerdict(frame.params) as string }),
            detail: "approval codex bridge stopped the session under bridge-auto-reviewer-active",
          },
          plan.options,
        );
        if (!recorded.ok) {
          streams.err(
            `approval: the auto-review record could not be appended (${recorded.code}: ${recorded.message}); the session is still stopped\n`,
          );
        }
        finish(
          EXIT_IO,
          `the server sent ${method}, so Codex's own auto-reviewer resolved an approval before this client was asked: ${JSON.stringify(frame.params ?? null)}. A session with a reviewer in front of the gate is one whose silence means nothing, so the run was stopped rather than gating what was left`,
          "bridge-auto-reviewer-active",
        );
        return;
      }
      // Kept from the moment the probe turn is asked for, so a void report
      // carries the turn and not the handshake before it.
      if (phase === "preflight" && preflightStartId !== -1) preflightFrames.push(frame);

      // A server REQUEST: it carries both a method and an id, and it is waiting.
      if (method !== null && frame.id !== undefined) {
        // An approval question raised by the PROBE turn is observed and
        // declined here, above every gate path below it (APRV-364).
        const execApproval = (EXEC_APPROVAL_METHODS as readonly string[]).includes(method);
        const fileApproval = (FILE_CHANGE_APPROVAL_METHODS as readonly string[]).includes(method);
        if ((execApproval || fileApproval) && isPreflightFrame(frame.params)) {
          observeProbe(frame.id, frame.params, execApproval);
          return;
        }
        if (execApproval) {
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
          // The request that carries the pin was refused, so no thread exists
          // and nothing about this session's approval policy was established.
          // A refusal of the VALUE arrives here too, in the server's own words.
          finish(
            EXIT_IO,
            `the app-server refused thread/start with approvalPolicy ${JSON.stringify(APPROVAL_POLICY)} and sandbox ${JSON.stringify(SANDBOX)}: ${JSON.stringify(frame.error)}`,
            "bridge-thread-start-refused",
          );
          return;
        }
        if (pinnedOrStop(frame.result, "thread/start")) return;
        threadId =
          stringField(frame.result, "threadId") ??
          stringField((frame.result as Record<string, unknown> | undefined)?.["thread"], "id");
        if (threadId === null) {
          finish(EXIT_IO, "thread/start succeeded and named no thread this client could find");
          return;
        }
        thread.id = threadId;
        // The PROBE turn first, always, whatever the server said about its
        // approval policy (APRV-364). The pin's echo and the auto-reviewer are
        // two different questions, and only the probe answers the second.
        streams.err(
          `approval: running the preflight probe (${PROBE_COMMAND}) before the turn; it costs one turn and it is what makes this session's silence mean anything\n`,
        );
        preflightStartId = connection.request("turn/start", {
          threadId,
          input: [{ type: "text", text: PROBE_PROMPT }],
        });
        return;
      }
      if (frame.id === preflightStartId && preflightStartId !== -1) {
        if (frame.error !== undefined) {
          preflight.error = frame.error;
          finish(
            EXIT_IO,
            `the app-server refused the preflight turn/start: ${JSON.stringify(frame.error)}; no probe ran, so nothing was established about whether a question reaches this client`,
            "bridge-preflight-void",
          );
          return;
        }
        preflight.turnId = turnIdOf(frame.result);
        return;
      }
      if (frame.id === liveStartId && liveStartId !== -1 && frame.error !== undefined) {
        finish(EXIT_IO, `the app-server refused turn/start: ${JSON.stringify(frame.error)}`);
        return;
      }

      // Notifications. The turn's end is acted on, and so is anything the
      // server says about the thread's own approval policy: `thread/started` is
      // where a server that reports one is most likely to (APRV-366). That is
      // not a client branching on narration, which is the thing this verb does
      // not do: it is the one fact that decides whether this session is the
      // kind of session the verb will sit in front of at all.
      if (method === "thread/started" || method === "thread/status/changed") {
        if (pinnedOrStop(frame.params, method)) return;
      }
      // A command item in the PROBE turn. It is read for one purpose: to tell a
      // probe that ran without asking from a probe that never ran (APRV-364).
      if (
        phase === "preflight" &&
        (method === "item/started" || method === "item/completed") &&
        isPreflightFrame(frame.params) &&
        namesCommandExecution(frame.params) &&
        preflight.outcome === "pending"
      ) {
        preflight.outcome = "executed";
      }
      if (method === "turn/completed" || method === "turn/failed") {
        if (phase === "preflight" && isPreflightFrame(frame.params)) {
          if (method === "turn/failed") preflight.error = frame.params ?? null;
          if (preflight.outcome === "asked") {
            // The only way past here. One question reached this client, so the
            // operator's own turn runs.
            phase = "live";
            liveStartId = connection.request("turn/start", {
              threadId,
              input: [{ type: "text", text: plan.prompt }],
            });
            return;
          }
          if (preflight.outcome === "executed") {
            finish(
              EXIT_IO,
              `the preflight probe (${PROBE_COMMAND}) ran and no approval request for it reached this client. A policy under which one command did not ask is not ${JSON.stringify(APPROVAL_POLICY)} whatever the server reports, so the session was stopped before the turn ran and nothing was answered`,
              "bridge-approval-policy-mismatch",
            );
            return;
          }
          preflight.outcome = "void";
          finish(
            EXIT_IO,
            `the preflight turn ended having run no command at all, so nothing was established: a question that never arose is not a question that reached this client. The turn's frames are in the report verbatim. Nothing is retried here; run the verb again`,
            "bridge-preflight-void",
          );
          return;
        }
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
  "  --json                one object: {ok, reason, code?, thread, preflight, answers[]}",
  "  -- <command...>       the app-server to start (default: codex app-server)",
  "",
  "It answers accept or decline only, never acceptForSession, cancel or abort.",
  "A file-change request carries no content on the item-based API, so it is",
  "declined (bridge-file-change-unbound). An open gate window is not honoured.",
  "",
  "The thread is started with approvalPolicy untrusted, the only variant under",
  "which every command and every patch asks, and there is no flag for it. A",
  "server that refuses thread/start stops the run (bridge-thread-start-refused),",
  "and one that reports another effective policy stops it too",
  "(bridge-approval-policy-mismatch). A server that reports no policy at all is",
  "run against, and the report says the pin was requested and not confirmed.",
  "",
  "Every start runs a preflight turn first, asking for one harmless command",
  "(true), and there is no flag to skip it. An approval request for it means one",
  "question reached this client and the real turn runs; a command that ran",
  "without asking is bridge-approval-policy-mismatch; a turn that ran no command",
  "is bridge-preflight-void, reported with the turn's frames and never retried.",
  "An item/autoApprovalReview notification in either turn is",
  "bridge-auto-reviewer-active. A pass means one question reached this client,",
  "not that the auto-reviewer is off.",
  "See docs/codex-app-server-bridge.md.",
].join("\n");
