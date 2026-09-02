/**
 * The daemon-answered live draw (APRV-208).
 *
 * ## The hole this closes
 *
 * `supervised-live` (APRV-127) puts a declared fraction of a class through the
 * human gate, chosen by HMAC over the payload hash under an operator-held
 * secret. `core/sampler.ts`'s {@link import("./sampler.js").resolveLiveSelector}
 * reads that secret out of the DECIDING PROCESS's own environment, and the
 * deciding process is usually the harness hook — a short-lived child of an
 * agent session. Nothing sources the secret there, and nothing may: a secret an
 * agent-launched process can read is a secret the agent can read, and an agent
 * that can compute its own luck can grind its payload until the draw comes up
 * unsampled. SPEC.md §5.2 forbids exactly that.
 *
 * So the draw failed closed, correctly and permanently: measured on this
 * repository's own log, 15 of 15 supervised-live actions since the seq 5147
 * ceremony gated to a human (APRV-184). A class an operator asked to sample at
 * 10% was gated at 100%, which is safe and is also the setting never once
 * having been live.
 *
 * The fix is not to hand the hook the secret. It is to move the DRAW to the one
 * process that legitimately holds it — the daemon, started by the operator in a
 * terminal where `eval "$(approval env)"` has run — and let the hook ASK.
 *
 * ## The protocol, and what each part is for
 *
 * One owner-only Unix socket under the approval home
 * (`.approval/daemon/draw.sock`, directory 0700, socket 0600). One JSON line in,
 * one JSON line out, connection closed.
 *
 * ```
 * ->  {"v":1,"action_key":"...","payload_hash":"<64hex>","policy_hash":"<64hex>","live_rate":0.1}
 * <-  {"v":1,"question":{...},"selected":true,"mac":"<64hex>","daemon_pid":123,"answered_at":"..."}
 * ```
 *
 * - **The question is a PROPOSAL; the echoed question is the daemon's own
 *   derivation.** The daemon does not take `live_rate` or `policy_hash` on the
 *   asker's word — it resolves the class from its own policy and echoes what it
 *   derived. The asker requires the echo to equal what it asked. A daemon and a
 *   hook reading different policies therefore fail closed instead of agreeing on
 *   the wrong rate, and no answer is ever MAC'd over a rate the daemon did not
 *   itself compute.
 * - **The MAC binds the whole question AND the verdict.** `HMAC-SHA-256(secret,
 *   domain || canonical question || "\n" || selected)`. An answer is worth
 *   nothing without it: the asker cannot check it (it holds no secret), so it
 *   records it, and an operator who holds the secret recomputes it later from
 *   the record's own `action_key`, `payload_hash` and `policy_sha256`. That is
 *   what keeps SPEC.md §11's "self-reported fields never reduce scrutiny" true
 *   here — the answer is not believed, it is EVIDENCED, and an answer that
 *   cannot be evidenced (absent daemon, dead daemon, malformed reply) is refused
 *   and the action gates.
 * - **A domain separator.** The MAC message is prefixed with
 *   {@link DRAW_MAC_DOMAIN} so a MAC can never be confused with, or substituted
 *   for, the selection value `core/sampler.ts` derives from the same key over a
 *   bare payload hash.
 *
 * ## Why the socket is not a free oracle
 *
 * An owner-only socket is reachable by any process of the same user, and an
 * agent session runs as that user. If the daemon answered any question put to
 * it, the agent could ask "would these bytes be sampled?" for a thousand
 * candidate payloads and pick one that is not — the very grinding attack the
 * secret exists to prevent, restored through the front door.
 *
 * `daemon/draw.ts` closes it by refusing to answer for an action that is not
 * ALREADY REGISTERED in the verified log with exactly this payload hash. To ask
 * a question you must first append a `task.registered` naming the bytes, so
 * every candidate an agent grinds is permanently in the append-only log, in
 * order, countable by anyone. The oracle still exists; it just cannot be
 * consulted in secret, which is the property this project trades in.
 *
 * ## The secret is never here
 *
 * This module takes a secret as a parameter in exactly two pure functions
 * ({@link drawMac}, {@link verifyDrawAnswer}) and stores it nowhere. Nothing in
 * the client half ever sees one: the asking process holds no secret, which is
 * the entire point.
 */

import { spawnSync } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalize } from "./jcs.js";

/** The protocol version. A mismatch is a refusal, never a negotiation. */
export const DRAW_PROTOCOL_VERSION = 1;

/** The socket's basename under the approval home's `daemon/` directory. */
export const DRAW_SOCKET_NAME = "draw.sock";

/** The MAC's domain separator. See the module header. */
export const DRAW_MAC_DOMAIN = "approval.md/live-draw/v1";

/**
 * The longest socket path this runtime will bind or dial.
 *
 * `sockaddr_un.sun_path` is 104 bytes on macOS and 108 on Linux, and a `bind`
 * past it fails with a message an operator cannot act on. Checked on both sides
 * so the daemon reports it as a refusal to serve and the asker reports it as an
 * absent daemon, rather than either of them producing an `ENAMETOOLONG` nobody
 * expected.
 */
export const DRAW_SOCKET_PATH_LIMIT = 100;

/** How long the asking child waits for a connection and an answer. */
export const DRAW_TIMEOUT_MS = 500;

/** The whole child invocation, including Node's own start. */
export const DRAW_SPAWN_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Where the socket lives
// ---------------------------------------------------------------------------

/**
 * The approval home's `daemon/` directory for a log, derived and never
 * configured.
 *
 * `logPath` is `<home>/log/events.jsonl`, so the home is two levels up. One log
 * has one daemon directory: a reader that had to be TOLD where to look could be
 * pointed at another instance's daemon, and answers would cross between
 * instances that share a machine.
 */
export function drawDirFor(logPath: string): string {
  return join(dirname(dirname(resolve(logPath))), "daemon");
}

/** Where the draw socket for `logPath` lives. */
export function drawSocketPathFor(logPath: string): string {
  return join(drawDirFor(logPath), DRAW_SOCKET_NAME);
}

// ---------------------------------------------------------------------------
// The question and the answer
// ---------------------------------------------------------------------------

/**
 * What is asked, and what a MAC is computed over.
 *
 * Deliberately without a timestamp. A caller-supplied clock inside MAC'd
 * material would let the same question be asked again for a different MAC, and
 * SPEC.md §11's rule that gate-typed events take no caller timestamp is the
 * same rule wearing a different hat. The answer carries the daemon's own
 * `answered_at` outside the MAC, for an operator reading a live socket, and it
 * is not recorded in the log.
 */
export interface DrawQuestion {
  v: number;
  action_key: string;
  payload_hash: string;
  /** The `policy_sha256` the asker is routing under, echoed by the daemon. */
  policy_hash: string;
  /** The class's `live_rate`, echoed by the daemon from its OWN resolution. */
  live_rate: number;
}

/** What the daemon answers. */
export interface DrawAnswer {
  v: number;
  /** The daemon's own derivation of the question. Compared field for field. */
  question: DrawQuestion;
  selected: boolean;
  /** {@link drawMac} over `question` and `selected`. 64 lowercase hex. */
  mac: string;
  daemon_pid: number;
  answered_at: string;
}

/** Is this a well-formed 64-character lowercase hex digest? */
export function isHex64(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

/**
 * The canonical bytes a MAC covers: RFC 8785 over the question.
 *
 * `core/jcs.ts` is the runtime's one canonicalizer, so the asker, the daemon and
 * a later verifier cannot drift apart over key order or number spelling.
 */
export function canonicalQuestion(question: DrawQuestion): string {
  return canonicalize({
    action_key: question.action_key,
    live_rate: question.live_rate,
    payload_hash: question.payload_hash,
    policy_hash: question.policy_hash,
    v: question.v,
  });
}

/** `HMAC-SHA-256(secret, domain || question || verdict)`, lowercase hex. */
export function drawMac(secret: string, question: DrawQuestion, selected: boolean): string {
  return createHmac("sha256", secret)
    .update(`${DRAW_MAC_DOMAIN}\n${canonicalQuestion(question)}\n${selected ? "1" : "0"}`, "utf8")
    .digest("hex");
}

/**
 * Does this MAC belong to this question and this verdict, under this secret?
 *
 * Constant-time, which costs nothing and removes the argument about whether it
 * matters. A malformed MAC is `false` rather than a throw: this is a verifier,
 * and every wrong answer is one answer.
 */
export function verifyDrawAnswer(
  secret: string,
  question: DrawQuestion,
  selected: boolean,
  mac: string,
): boolean {
  if (!isHex64(mac)) return false;
  const expected = Buffer.from(drawMac(secret, question, selected), "hex");
  const actual = Buffer.from(mac, "hex");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * Why a delegated draw produced no usable answer. Machine-readable, closed and
 * DISTINCT (SPEC.md §11 invariant 6), because the operator's action differs:
 * "start the daemon", "your daemon is wedged or was killed", "something
 * answered and it was not a daemon holding your secret".
 *
 * Every one of them gates the action, exactly as an unavailable secret does
 * today. None of them is a degraded mode.
 */
export const DRAW_REFUSAL_REASONS = [
  /** No socket at the derived path: no daemon has ever served draws here. */
  "draw-daemon-absent",
  /** A socket that cannot be dialled, times out, or names a pid that is gone. */
  "draw-daemon-stale",
  /** An answer that is malformed, off-version, off-question, or badly MAC'd. */
  "draw-answer-invalid",
] as const;

export type DrawRefusalReason = (typeof DRAW_REFUSAL_REASONS)[number];

/** What the asker got back. */
export type DrawOutcome =
  | { ok: true; answer: DrawAnswer }
  | { ok: false; reason: DrawRefusalReason; detail: string };

// ---------------------------------------------------------------------------
// What the log records
// ---------------------------------------------------------------------------

/**
 * The `live_draw` field an `approval.requested` carries when the draw was
 * DELEGATED (APRV-208).
 *
 * ## Why this is recorded at all, when APRV-127 records nothing
 *
 * APRV-127 deliberately wrote nothing about the selection to the log, and that
 * property is unchanged for an in-process draw: when the deciding process holds
 * the secret it IS the operator's process, its verdict needs no evidence, and a
 * sampled request stays byte-for-byte a manual one (pinned by
 * `tests/autonomy-split.test.ts`).
 *
 * A DELEGATED verdict is a different object. The deciding process did not
 * compute it; another process asserted it. An assertion recorded without its
 * proof is a self-reported field, and SPEC.md §11 says those never reduce
 * scrutiny. So the delegation is recorded WITH the MAC that makes it checkable,
 * and a delegation that cannot be evidenced is not recorded at all — it gates,
 * and the field says which of the three refusals happened.
 *
 * What is never recorded: the secret, the selection value, or any timestamp the
 * asker or the daemon supplied. The MAC is a digest under a key nobody in this
 * process holds, and the operator recomputes it from the record's own fields.
 */
export interface LiveDrawRecord {
  v: number;
  /**
   * `"daemon"` — a MAC'd answer, recorded with its proof.
   * `"unavailable"` — no usable answer; `reason` says which refusal.
   */
  source: "daemon" | "unavailable";
  /** `selected` for a daemon answer, else the {@link DrawRefusalReason}. */
  reason: "selected" | DrawRefusalReason;
  /** The rate the draw was made at, so a verifier reconstructs the question. */
  live_rate: number;
  /** The daemon's verdict. Present only with a MAC to check it against. */
  selected?: boolean;
  mac?: string;
  daemon_pid?: number;
}

/**
 * Recompute a recorded delegation, from the record and the operator's secret.
 *
 * This is the whole point of the MAC, and it is deliberately a function of the
 * RECORD rather than of anything the asker kept: `action_key` and
 * `payload_hash` are the request's own fields and `policy_sha256` is assigned at
 * the write boundary, so a verifier reconstructs the question from bytes the
 * requester could not choose freely and could not alter afterwards without
 * breaking the chain.
 *
 * `false` for a record with no MAC (a refusal), for a tampered MAC, and for a
 * flipped verdict. Never throws.
 */
export function verifyLiveDrawRecord(
  secret: string,
  fields: {
    actionKey: string;
    payloadHash: string;
    policyHash: string;
    draw: LiveDrawRecord;
  },
): boolean {
  const { draw } = fields;
  if (draw.source !== "daemon") return false;
  if (typeof draw.selected !== "boolean" || draw.mac === undefined) return false;
  const question: DrawQuestion = {
    v: draw.v,
    action_key: fields.actionKey,
    payload_hash: fields.payloadHash,
    policy_hash: fields.policyHash,
    live_rate: draw.live_rate,
  };
  return verifyDrawAnswer(secret, question, draw.selected, draw.mac);
}

// ---------------------------------------------------------------------------
// Parsing an answer
// ---------------------------------------------------------------------------

function sameQuestion(a: DrawQuestion, b: DrawQuestion): boolean {
  return (
    a.v === b.v &&
    a.action_key === b.action_key &&
    a.payload_hash === b.payload_hash &&
    a.policy_hash === b.policy_hash &&
    a.live_rate === b.live_rate
  );
}

/**
 * Read one answer line against the question that was asked.
 *
 * Every check can only REJECT. The asker holds no secret, so it cannot check the
 * MAC; what it CAN check is that the answer is this protocol's version, is an
 * answer to this exact question (the daemon's own derivation, field for field),
 * carries a MAC of the right shape, and names a live process. Anything else is
 * `draw-answer-invalid` and the action gates.
 */
export function parseDrawAnswer(text: string, asked: DrawQuestion): DrawOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "draw-answer-invalid", detail: "the answer was not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "draw-answer-invalid", detail: "the answer was not an object" };
  }
  const body = parsed as Record<string, unknown>;
  if (body["v"] !== DRAW_PROTOCOL_VERSION) {
    return {
      ok: false,
      reason: "draw-answer-invalid",
      detail: `the answer declares protocol version ${JSON.stringify(body["v"])}, not ${String(DRAW_PROTOCOL_VERSION)}`,
    };
  }
  const echoed = body["question"];
  if (typeof echoed !== "object" || echoed === null) {
    return { ok: false, reason: "draw-answer-invalid", detail: "the answer echoed no question" };
  }
  const question = echoed as Record<string, unknown>;
  const derived: DrawQuestion = {
    v: typeof question["v"] === "number" ? question["v"] : -1,
    action_key: typeof question["action_key"] === "string" ? question["action_key"] : "",
    payload_hash: typeof question["payload_hash"] === "string" ? question["payload_hash"] : "",
    policy_hash: typeof question["policy_hash"] === "string" ? question["policy_hash"] : "",
    live_rate: typeof question["live_rate"] === "number" ? question["live_rate"] : Number.NaN,
  };
  if (!sameQuestion(derived, asked)) {
    return {
      ok: false,
      reason: "draw-answer-invalid",
      detail:
        "the daemon answered a different question than the one asked; it resolved this action against a policy or a rate this process did not",
    };
  }
  if (typeof body["selected"] !== "boolean") {
    return { ok: false, reason: "draw-answer-invalid", detail: "the verdict was not a boolean" };
  }
  if (!isHex64(body["mac"])) {
    return { ok: false, reason: "draw-answer-invalid", detail: "the answer carried no usable MAC" };
  }
  const pid = body["daemon_pid"];
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return { ok: false, reason: "draw-answer-invalid", detail: "the answer named no daemon pid" };
  }
  return {
    ok: true,
    answer: {
      v: DRAW_PROTOCOL_VERSION,
      question: derived,
      selected: body["selected"],
      mac: body["mac"],
      daemon_pid: pid,
      answered_at: typeof body["answered_at"] === "string" ? body["answered_at"] : "",
    },
  };
}

// ---------------------------------------------------------------------------
// The synchronous client
// ---------------------------------------------------------------------------

/** The seam a caller (and every test) substitutes for the real spawn. */
export type DrawAsker = (logPath: string, question: DrawQuestion) => DrawOutcome;

/** Where the relay child lives, beside this module in the built tree. */
export function drawChildPath(): string {
  return fileURLToPath(new URL("../daemon/draw-child.js", import.meta.url));
}

function socketUsable(path: string): { ok: true } | { ok: false; reason: DrawRefusalReason; detail: string } {
  if (path.length > DRAW_SOCKET_PATH_LIMIT) {
    return {
      ok: false,
      reason: "draw-daemon-absent",
      detail: `the derived socket path is ${String(path.length)} bytes, past the ${String(DRAW_SOCKET_PATH_LIMIT)}-byte limit a Unix socket can carry; no daemon can serve draws for this log`,
    };
  }
  if (!existsSync(path)) {
    return {
      ok: false,
      reason: "draw-daemon-absent",
      detail: `no draw socket at ${path}; supervised-live needs \`approval daemon run\` (or \`approval up\`) started in a terminal where the sampling secret resolves`,
    };
  }
  let stats;
  try {
    stats = statSync(path);
  } catch (cause) {
    return {
      ok: false,
      reason: "draw-daemon-stale",
      detail: `${path} could not be stat'd: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  if (!stats.isSocket()) {
    return { ok: false, reason: "draw-daemon-stale", detail: `${path} is not a socket` };
  }
  const euid = typeof process.geteuid === "function" ? process.geteuid() : null;
  if (euid === null) {
    return {
      ok: false,
      reason: "draw-daemon-stale",
      detail: "socket ownership cannot be established on this platform, so no answer from it can be attributed to this user's daemon",
    };
  }
  if (stats.uid !== euid) {
    return {
      ok: false,
      reason: "draw-daemon-stale",
      detail: `${path} is owned by uid ${String(stats.uid)}, not by this user (${String(euid)})`,
    };
  }
  if ((stats.mode & 0o077) !== 0) {
    return {
      ok: false,
      reason: "draw-daemon-stale",
      detail: `${path} is reachable by group or other (mode ${(stats.mode & 0o777).toString(8)}); an answer from a socket anyone can bind is an answer from nobody in particular`,
    };
  }
  return { ok: true };
}

/**
 * Ask the daemon, synchronously, from a process that holds no secret.
 *
 * A child process, and the module header of `daemon/draw-child.ts` says why:
 * the gate's request path is synchronous end to end (APRV-188 measured and
 * documented the same constraint), `node:net` is not, and there is no
 * synchronous Unix-socket client in Node. So one `spawnSync` of a tiny relay,
 * about 20-40 ms of Node start. That cost is affordable HERE and nowhere else:
 * this runs only for a `supervised-live` class whose deciding process has no
 * secret, which is off the pass-through path entirely — no `Read`, no ordinary
 * `Edit`, no autonomous class ever reaches it.
 *
 * The child is given a deliberately bare environment. It needs `PATH` for
 * nothing and holds no secret; passing the session's environment to it would
 * hand a relay every credential the session was launched with, which is the
 * scrub `core/child-env.ts` exists to prevent.
 */
export function askDaemonDraw(logPath: string, question: DrawQuestion): DrawOutcome {
  const path = drawSocketPathFor(logPath);
  const usable = socketUsable(path);
  if (!usable.ok) return usable;

  const child = spawnSync(process.execPath, [drawChildPath(), path], {
    input: `${JSON.stringify(question)}\n`,
    encoding: "utf8",
    timeout: DRAW_SPAWN_TIMEOUT_MS,
    env: {},
  });
  if (child.error !== undefined && child.error !== null) {
    return {
      ok: false,
      reason: "draw-daemon-stale",
      detail: `the draw relay could not be run: ${child.error.message}`,
    };
  }
  const line = (child.stdout ?? "").trim();
  if (line.length === 0) {
    return {
      ok: false,
      reason: "draw-daemon-stale",
      detail: `the draw relay said nothing (exit ${String(child.status)})`,
    };
  }

  let relayed: unknown;
  try {
    relayed = JSON.parse(line);
  } catch {
    return { ok: false, reason: "draw-answer-invalid", detail: "the relay did not emit JSON" };
  }
  const body = relayed as Record<string, unknown>;
  if (body["ok"] !== true) {
    const reason = body["reason"];
    return {
      ok: false,
      reason: (DRAW_REFUSAL_REASONS as readonly string[]).includes(reason as string)
        ? (reason as DrawRefusalReason)
        : "draw-daemon-stale",
      detail: typeof body["detail"] === "string" ? body["detail"] : "the relay refused without a reason",
    };
  }
  const outcome = parseDrawAnswer(JSON.stringify(body["answer"]), question);
  if (!outcome.ok) return outcome;

  // A pid that is gone means the socket outlived its server: something answered
  // from a file nobody is listening on, which cannot happen, or the daemon died
  // between answering and now, which can. Either way the answer is not one a
  // running daemon stands behind.
  try {
    process.kill(outcome.answer.daemon_pid, 0);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ESRCH") {
      return {
        ok: false,
        reason: "draw-daemon-stale",
        detail: `the answering daemon (pid ${String(outcome.answer.daemon_pid)}) is no longer running`,
      };
    }
    // EPERM means it exists and belongs to someone else, which the socket
    // ownership check above has already ruled out for the socket itself.
  }
  return outcome;
}
