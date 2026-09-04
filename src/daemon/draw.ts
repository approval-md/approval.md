/**
 * The daemon's live-draw server (APRV-208).
 *
 * The daemon is the one process on this machine that legitimately holds the
 * sampling secret: an operator starts it in a terminal where `eval "$(approval
 * env)"` has run, and `core/child-env.ts` (APRV-205) strips `APPROVAL_*` from
 * every child it spawns, so the secret goes no further. This module lets short
 * lived gate processes that hold no secret — the harness hook, above all — ASK
 * for a draw instead of failing closed on every action of a `supervised-live`
 * class. `core/live-draw.ts` carries the protocol and the argument; this is the
 * server half.
 *
 * ## Three things this server refuses to take on the asker's word
 *
 * 1. **The action.** It answers only for an `action_key` already carried by a
 *    `task.registered` record in the VERIFIED log, declaring exactly this
 *    `payload_hash`. That is what stops the socket being a private oracle: an
 *    agent that wants to grind candidate payloads until one draws unsampled must
 *    append a registration for each candidate first, in the append-only log,
 *    where the attempt is permanent and countable. See `core/live-draw.ts`'s
 *    header on why this matters more than the socket's file mode does.
 * 2. **The rate.** It resolves the action's class against its own policy and
 *    uses the `live_rate` IT derives. A `live_rate` in the question is a
 *    proposal, never an instruction; the derived one is echoed back and the
 *    asker refuses an answer to a different question.
 * 3. **The policy.** Same: it checks its own attestation and echoes its own
 *    `policy_sha256`. A daemon and a hook reading different policy files fail
 *    closed rather than agreeing on the wrong rules.
 *
 * A fresh verified read per question is what makes (1) usable at all: the hook
 * registers the task microseconds before it asks, and a daemon answering out of
 * a tick's stale memory would refuse every real request. The read is cheap for
 * the reason APRV-188 exists — the daemon's cache is warm and only the appended
 * tail is walked.
 *
 * ## The secret
 *
 * Held in one private field, closed over by nothing, and never emitted: not in
 * an answer, not in a warning, not in the `started` line. What leaves this
 * process is a verdict and a MAC.
 */

import { chmodSync, mkdirSync, rmSync, statSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";

import { checkAttestation, type AttestationStatus } from "../core/attest.js";
import {
  DRAW_PROTOCOL_VERSION,
  DRAW_SOCKET_PATH_LIMIT,
  drawDirFor,
  drawMac,
  drawSocketPathFor,
  isHex64,
  liveClassesOf,
  type DrawAnswer,
  type DrawQuestion,
} from "../core/live-draw.js";
import { loadPolicy, type LoadPolicyOptions } from "../core/policy-load.js";
import { resolve as resolveClass } from "../core/policy-match.js";
import {
  isSampled,
  resolveLiveSelector,
  type LiveSelectorUnavailableReason,
} from "../core/sampler.js";
import { readVerifiedRecords } from "../core/state.js";
import type { EventRecord } from "../core/log.js";

/**
 * The server this environment can run, or the reason it cannot (APRV-208).
 *
 * ## Where the secret comes from, and why that is the whole opt-in
 *
 * From the daemon's OWN environment, and nowhere else. `.approval/env` is a
 * source MAP and `core/env-file.ts`'s load-bearing rule is that no verb reads it
 * into its own environment (the reason is `APPROVAL_HUMAN`: a working-tree file
 * that could set identity would put the human-only gate one `echo >>` away from
 * being nobody's gate). That rule is not weakened here. The operator runs `eval
 * "$(approval env)"` in the terminal they start the daemon from — the same act
 * `approval setup sampling` already documents, resolving the keychain item or the
 * env file's declared source — and this reads what that established.
 *
 * That act is also the feature's opt-in, which is why there is no flag to turn
 * it on. Serving draws changes VERDICTS: a class an operator declared
 * `supervised-live` at 0.1 goes from gating 100% to gating 10%, and a default
 * that moved that under someone on an upgrade would be the surprise this project
 * exists to prevent. But it moves only for an operator who has exported the
 * secret into the daemon's shell on purpose, having already amended their policy
 * to declare the class live. Both halves are deliberate acts by the human. What
 * exists instead is a way OUT — `approval daemon run --no-draw` — because the
 * one thing an operator must always be able to do is take a control back.
 */
export function drawServerFor(
  options: Omit<DrawServerOptions, "secret"> & { env?: NodeJS.ProcessEnv },
): { ok: true; server: DrawServer } | { ok: false; reason: DrawUnavailableReason; message: string } {
  const where: LoadPolicyOptions =
    options.policy.file !== undefined
      ? { file: options.policy.file }
      : { dir: options.policy.dir ?? process.cwd() };
  if (options.schemaDir !== undefined) where.schemaDir = options.schemaDir;
  const load = loadPolicy(where);
  const env = options.env ?? process.env;

  // Asked FIRST, and answered quietly. A policy with no `supervised-live` class
  // makes no draw at any rate, so an unset secret in this shell is not a fact
  // about that operator's configuration: it is the ordinary state of every
  // daemon that has never used the setting, and a warning printed on every start
  // would be the noise that teaches an operator to stop reading the others. It
  // has to come before the selector because `core/sampler.ts`'s refusals are
  // worded for a caller that already knows a live class is in play ("declares a
  // supervised-live class but names no ...", which would be false here).
  if (load.ok && liveClassesOf(load.policy).length === 0) {
    return {
      ok: false,
      reason: "no-live-class",
      message: `${load.source.filename} declares no supervised-live class, so no draw is ever made and none is served.`,
    };
  }

  // The availability question is asked through `core/sampler.ts`, so this and
  // the in-process draw agree on what "no usable secret" means and on the words
  // for each way of not having one. The secret itself is read here rather than
  // there because a MAC needs the key and `resolveLiveSelector` returns a
  // closure over it, deliberately.
  const selector = resolveLiveSelector(load, env);
  if (!selector.available) {
    return { ok: false, reason: selector.reason, message: selector.message };
  }
  const secret = env[selector.secretEnv];
  if (typeof secret !== "string" || secret.length === 0) {
    return { ok: false, reason: "secret-unset", message: "the sampling secret is unset in this process" };
  }
  return {
    ok: true,
    server: new DrawServer({
      logPath: options.logPath,
      policy: options.policy,
      ...(options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir }),
      ...(options.now === undefined ? {} : { now: options.now }),
      secret,
    }),
  };
}

/**
 * Why {@link drawServerFor} built no server.
 *
 * The four inherited from `core/sampler.ts` are all worth telling an operator
 * about: each one means a class they declared live is gating at 100%.
 * `no-live-class` is the fifth and the only SILENT one, because it means the
 * operator never asked for any of this — the reason a caller must branch on it
 * rather than print every refusal alike.
 */
export type DrawUnavailableReason = LiveSelectorUnavailableReason | "no-live-class";

/** Why the server declined to listen. Reported, never fatal to the daemon. */
export type DrawServeRefusal =
  | "path-too-long"
  | "directory-unusable"
  | "listen-failed";

export interface DrawServerOptions {
  logPath: string;
  policy: { dir?: string; file?: string };
  schemaDir?: string;
  /** The operator's sampling secret, resolved by the caller from its own env. */
  secret: string;
  /** The clock for `answered_at`, which is outside the MAC and never logged. */
  now?: () => string;
}

export type DrawServeResult =
  | { ok: true; path: string }
  | { ok: false; reason: DrawServeRefusal; detail: string };

/** The largest question this server will read before hanging up. */
const QUESTION_LIMIT = 8192;

function payloadOf(record: EventRecord): Record<string, unknown> {
  const payload = record.payload;
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)
    : {};
}

/**
 * The class a registered action declared, if the log declares this exact pair.
 *
 * Scans every `task.registered` because the question names no task: the action
 * key is the identifier the whole runtime keys on, and requiring the asker to
 * name a task too would be one more field to get wrong for no check gained. The
 * pair must match on BOTH halves — an action registered with other bytes is not
 * this question's action.
 */
function registeredClass(
  records: EventRecord[],
  actionKey: string,
  payloadHash: string,
): string | null {
  let found: string | null = null;
  for (const record of records) {
    if (record.event !== "task.registered") continue;
    const declared = payloadOf(record)["actions"];
    if (!Array.isArray(declared)) continue;
    for (const entry of declared) {
      if (typeof entry !== "object" || entry === null) continue;
      const item = entry as Record<string, unknown>;
      if (item["idempotency_key"] !== actionKey) continue;
      if (item["payload_hash"] !== payloadHash) continue;
      if (typeof item["class"] !== "string") continue;
      found = item["class"];
    }
  }
  return found;
}

/** The question, validated into its typed shape, or `null`. */
function parseQuestion(line: string): DrawQuestion | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const body = parsed as Record<string, unknown>;
  if (body["v"] !== DRAW_PROTOCOL_VERSION) return null;
  if (typeof body["action_key"] !== "string" || body["action_key"].length === 0) return null;
  if (!isHex64(body["payload_hash"])) return null;
  if (!isHex64(body["policy_hash"])) return null;
  const rate = body["live_rate"];
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0 || rate > 1) return null;
  return {
    v: DRAW_PROTOCOL_VERSION,
    action_key: body["action_key"],
    payload_hash: body["payload_hash"],
    policy_hash: body["policy_hash"],
    live_rate: rate,
  };
}

/**
 * A server that answers live draws for one log, over one owner-only socket.
 *
 * Started and stopped by the daemon loop. Every failure is a refusal to serve,
 * never a throw into the loop: a daemon that could not open a socket must keep
 * doing its job, and every asker fails closed to a human decision, which is
 * exactly what happens today with no daemon at all.
 */
export class DrawServer {
  private readonly options: DrawServerOptions;
  private server: Server | null = null;
  private answered = 0;
  private refused = 0;

  constructor(options: DrawServerOptions) {
    this.options = options;
  }

  /** How many questions were answered and refused, for the daemon's report. */
  stats(): { answered: number; refused: number } {
    return { answered: this.answered, refused: this.refused };
  }

  start(): DrawServeResult {
    const path = drawSocketPathFor(this.options.logPath);
    if (path.length > DRAW_SOCKET_PATH_LIMIT) {
      return {
        ok: false,
        reason: "path-too-long",
        detail: `${path} is ${String(path.length)} bytes, past the ${String(DRAW_SOCKET_PATH_LIMIT)}-byte limit a Unix socket address can carry`,
      };
    }
    const dir = drawDirFor(this.options.logPath);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // `mkdirSync`'s mode is subject to umask and a pre-existing directory
      // keeps whatever mode it had, so the mode is asserted rather than asked
      // for. The socket below is 0600 regardless; this is the second lock.
      chmodSync(dir, 0o700);
      const stats = statSync(dir);
      const euid = typeof process.geteuid === "function" ? process.geteuid() : null;
      if (euid === null || stats.uid !== euid) {
        return {
          ok: false,
          reason: "directory-unusable",
          detail: `${dir} is not owned by this user, so a socket in it could not be attributed to this daemon`,
        };
      }
    } catch (cause) {
      return {
        ok: false,
        reason: "directory-unusable",
        detail: `${dir} could not be prepared: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }

    // A socket file left by a daemon that was killed. Removing it is safe: a
    // LIVE server holding this path would make the bind below fail with EADDRINUSE
    // only if the file were still there, and a second daemon on one log is
    // already refused by the append lockfile long before it reaches here.
    try {
      rmSync(path, { force: true });
    } catch {
      // Nothing to remove, or a path we cannot clear; the bind reports it.
    }

    const server = createServer((socket) => {
      this.serve(socket);
    });
    server.on("error", () => {
      // A listening error after start is a server that has stopped serving.
      // Askers see a socket that will not answer and gate; nothing here throws
      // into the daemon loop.
    });
    try {
      server.listen(path);
      chmodSync(path, 0o600);
    } catch (cause) {
      try {
        server.close();
      } catch {
        // Never listened.
      }
      return {
        ok: false,
        reason: "listen-failed",
        detail: `${path} could not be served: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }
    // The daemon must be free to exit while this is open.
    server.unref();
    this.server = server;
    return { ok: true, path };
  }

  close(): void {
    const server = this.server;
    this.server = null;
    if (server === null) return;
    try {
      server.close();
    } catch {
      // Already closed.
    }
    try {
      rmSync(drawSocketPathFor(this.options.logPath), { force: true });
    } catch {
      // A socket file we cannot remove is one the next start clears.
    }
  }

  private serve(socket: Socket): void {
    let buffer = "";
    let done = false;
    const answer = (body: unknown): void => {
      if (done) return;
      done = true;
      try {
        socket.end(`${JSON.stringify(body)}\n`);
      } catch {
        // The asker hung up; nothing to report to.
      }
    };
    const refuse = (detail: string): void => {
      this.refused += 1;
      answer({ ok: false, detail });
    };

    socket.setEncoding("utf8");
    socket.setTimeout(2_000, () => {
      refuse("no question within the server's read timeout");
      socket.destroy();
    });
    socket.on("error", () => {
      done = true;
    });
    socket.on("data", (chunk: string) => {
      if (done) return;
      buffer += chunk;
      if (buffer.length > QUESTION_LIMIT) {
        refuse("the question exceeded this protocol's size limit");
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const question = parseQuestion(buffer.slice(0, newline));
      if (question === null) {
        refuse("the question was malformed or declared another protocol version");
        return;
      }
      answer(this.decide(question, refuse));
    });
  }

  /**
   * Answer one question, or refuse it.
   *
   * Returns the answer body; refusals go through `refuse` and this returns
   * `undefined`, which `answer` above ignores because `done` is already set.
   */
  private decide(question: DrawQuestion, refuse: (detail: string) => void): unknown {
    const where: LoadPolicyOptions =
      this.options.policy.file !== undefined
        ? { file: this.options.policy.file }
        : { dir: this.options.policy.dir ?? process.cwd() };
    if (this.options.schemaDir !== undefined) where.schemaDir = this.options.schemaDir;
    const load = loadPolicy(where);
    if (!load.ok) {
      refuse(`this daemon cannot load its policy (${load.code}), so it can derive no rate`);
      return undefined;
    }

    const read = readVerifiedRecords(
      this.options.logPath,
      this.options.schemaDir === undefined ? {} : { schemaDir: this.options.schemaDir },
    );
    if (!read.ok) {
      refuse(`this daemon's log does not verify (${read.code}), so it will answer nothing`);
      return undefined;
    }

    // The policy this daemon is actually enforcing, by its own attestation
    // check over its own bytes. Never the asker's claim.
    const status: AttestationStatus = checkAttestation(read.records, load.source.path);
    if (status.status !== "attested") {
      refuse(`this daemon's policy is not attested (${status.status}), so no draw is derivable`);
      return undefined;
    }

    const cls = registeredClass(read.records, question.action_key, question.payload_hash);
    if (cls === null) {
      // The anti-grinding rule. A question about bytes nobody registered is a
      // question about a hypothetical, and answering hypotheticals is what
      // would turn this socket into the oracle the secret exists to deny.
      refuse(
        `no task.registered in the verified log declares action ${question.action_key} with this payload_hash; a draw is answered only for an action already on the record`,
      );
      return undefined;
    }

    const resolution = resolveClass(load, cls);
    if (resolution.supervision !== "live") {
      refuse(`class ${cls} is not supervised-live under this daemon's policy; there is no fraction to draw`);
      return undefined;
    }
    const rate = resolution.liveRate ?? 1;

    const derived: DrawQuestion = {
      v: DRAW_PROTOCOL_VERSION,
      action_key: question.action_key,
      payload_hash: question.payload_hash,
      policy_hash: status.sha256,
      live_rate: rate,
    };
    const selected = isSampled(this.options.secret, derived.payload_hash, derived.live_rate);
    const now = this.options.now ?? ((): string => new Date().toISOString());
    const body: DrawAnswer = {
      v: DRAW_PROTOCOL_VERSION,
      question: derived,
      selected,
      mac: drawMac(this.options.secret, derived, selected),
      daemon_pid: process.pid,
      answered_at: now(),
    };
    this.answered += 1;
    return body;
  }
}
