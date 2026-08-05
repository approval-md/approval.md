/**
 * Execution tokens (SPEC.md §10.4, §11) — the hard-enforcement primitive.
 *
 * An adapter holds credentials and "MUST require a valid, unexpired, single-use
 * execution token bound to the action's `idempotency_key`" (SPEC.md §10.4).
 * This module mints those tokens, decides whether a presented one is still good,
 * and spends it. Everything it knows it derives from the append-only log.
 *
 * ## The five settled properties (human decision, 2026-08-06)
 *
 * 1. **Minted at grant.** There is exactly one mint site: the grant path of
 *    `core/gate.ts`'s {@link import("./gate.js").decide}. No other code path
 *    creates a token, so a token's existence *is* a human's yes.
 * 2. **Single-use.** Consumption is an `execution.started` event, so the second
 *    attempt is refused by reading the log rather than by remembering anything.
 *    Double-spend detection is chain-native: it survives a process restart, a
 *    different machine, and a lost in-memory cache, because the evidence is the
 *    log itself.
 * 3. **Bound to the request and its `idempotency_key`.** A token is looked up by
 *    `action_key` — the envelope's `idempotency_key` — and is compared against
 *    the hash on *that* action's grant. A token minted for action A therefore
 *    cannot be presented for action B: B's grant carries a different hash (or no
 *    grant at all), and the comparison fails.
 * 4. **Hash-only in the log.** `approval.granted` carries
 *    `payload.token_sha256`; the raw token is returned to the caller of `decide`
 *    and to nothing else. Possession is proven by presenting a preimage. An
 *    attacker with a copy of the log — the one artifact this system deliberately
 *    makes durable, copyable, and auditable — gains no ability to execute.
 * 5. **No separate token TTL in v0.1.** A token dies exactly three ways:
 *    execution ({@link consumeToken}), revocation (`approval.revoked`), and the
 *    lapse of the *parent request's* TTL (`defaults.approval_ttl`, measured from
 *    the `approval.requested` timestamp). Inventing a second, independent clock
 *    would create a state where a request is live and its token is not, which no
 *    operator could explain from the log.
 *
 * ## Why the parent TTL bounds a *granted* request
 *
 * `requestState` deliberately stops applying the TTL once a decision lands: an
 * answered request is answered. Token liveness is a stricter question than
 * request state, and the settled design gives an approval a shelf life. So
 * {@link tokenStatus} re-applies `requestTs + approval_ttl` to a *granted*
 * request and refuses with `token-expired` past it. This never mutates the
 * derived request state and never writes anything — an aged-out token is simply
 * not spendable, and re-requesting the action is the repair. (Contrast
 * `core/gate.ts`, which materialises `approval.expired` when it discovers a
 * lapse on an *undecided* request. That branch belongs to the gate and this
 * module does not duplicate it: a granted request's `approval.expired` would
 * claim the human never answered.)
 *
 * ## Where this module sits between APRV-16 and APRV-18
 *
 * `core/gate.ts` deliberately appends no `execution.*` event. {@link
 * consumeToken} is the **only sanctioned appender of `execution.started` on the
 * manual path**, and it appends one only after a live token verifies — closing
 * the gap APRV-16 flagged, where a manual action's start event had no guard at
 * all.
 *
 * The supervised/autonomous paths are **not** this function's business. Under
 * the amended SPEC.md §6.3 they produce no approval events and therefore no
 * token; their `execution.started` is appended by APRV-18's `approval run`
 * wrapper, which is also where their budget is charged (see the consumption
 * contract in `core/budgets.ts`). One rule, stated once: *manual actions spend a
 * token here; non-manual actions start there.*
 *
 * ## The budgets contract
 *
 * The appended `execution.started` carries `payload.class` and
 * `payload.est_cost_usd`, **copied from the grant's payload** rather than
 * re-derived. `core/budgets.ts` counts an `execution.started` only when the
 * window holds no `approval.granted` with the same `action_key`, so a manual
 * action that is granted and then consumed is charged exactly once — the grant.
 * Copying rather than re-deriving keeps the two records agreeing about what was
 * authorized even if the task file changed in between.
 *
 * Time is a parameter here as everywhere: nothing in this module reads the
 * clock.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import {
  readGateRecords,
  requestState,
  type GateRefusal,
  type RequestState,
} from "./gate.js";
import {
  appendEvent,
  type AppendError,
  type AppendOptions,
  type EventRecord,
} from "./log.js";
import { loadPolicy, type LoadPolicyOptions } from "./policy-load.js";

/** Token entropy. 32 bytes = 256 bits, rendered as 64 lowercase hex chars. */
export const TOKEN_BYTES = 32;

/** The payload key carrying the token's digest, on both grant and start. */
export const TOKEN_HASH_FIELD = "token_sha256";

/**
 * Mint a token: 32 cryptographically random bytes as lowercase hex.
 *
 * `randomBytes` (CSPRNG), never `Math.random`. The value is a bearer credential
 * for a real-world side effect; 256 bits makes guessing irrelevant next to every
 * other attack in SPEC.md §11's "not defended" list.
 */
export function mintToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

/** The token's SHA-256, lowercase hex — the only form that ever reaches the log. */
export function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Constant-time comparison of two 64-hex digests.
 *
 * Both operands are digests, so a timing leak reveals a prefix of a *hash*, not
 * of a token — but this CLI runs on a shared developer machine beside the very
 * agents it polices, and an oracle that says "your first N hex digits were
 * right" is the kind of affordance that should not exist at all. `timingSafeEqual`
 * costs nothing here and removes the question.
 *
 * Digests are compared as decoded bytes: a malformed stored digest decodes to a
 * different length, which `timingSafeEqual` rejects by throwing, so the length
 * guard comes first and a malformed digest simply fails to match.
 */
export function digestsEqual(a: string, b: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(a) || !/^[a-f0-9]{64}$/u.test(b)) return false;
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * The token refusals proper — the closed set an agent branches on to learn *why*
 * a token will not execute. Frozen public API, in the same sense the gate's
 * codes and the exit codes are.
 *
 * The four death conditions are distinguishable on purpose: "you presented the
 * wrong string", "this token was already spent", "a human took it back", and
 * "it aged out" call for four different responses (fix the caller, stop
 * retrying, escalate to the human, re-request).
 */
export const TOKEN_VERIFY_REFUSAL_CODES = [
  /** No grant governs this action key: never requested, awaiting, or rejected. */
  "not-granted",
  /** A grant exists, but the presented token is not its preimage. */
  "token-mismatch",
  /** The token was already spent: an `execution.started` exists for this key. */
  "token-consumed",
  /** The parent request's TTL lapsed. There is no separate token TTL. */
  "token-expired",
  /** A human withdrew the grant (`approval.revoked`). */
  "token-revoked",
] as const;

export type TokenVerifyRefusalCode = (typeof TOKEN_VERIFY_REFUSAL_CODES)[number];

/**
 * Everything {@link consumeToken} can refuse: the verification codes plus the
 * three log/append failures, whose names and meanings are borrowed verbatim from
 * `core/gate.ts` so the CLI can map them onto the frozen exit table identically.
 */
export const TOKEN_REFUSAL_CODES = [
  ...TOKEN_VERIFY_REFUSAL_CODES,
  /** The log could not be read, or holds a line that is not a record. */
  "log-unreadable",
  /** The log's final line is unterminated (a crashed write). */
  "log-torn-tail",
  /** The append itself failed; `append` carries the underlying error. */
  "append-failed",
] as const;

export type TokenRefusalCode = (typeof TOKEN_REFUSAL_CODES)[number];

/** Every token failure is one of these. Nothing here throws. */
export interface TokenRefusal {
  ok: false;
  code: TokenRefusalCode;
  message: string;
  /** The derived request state at refusal time, when one could be derived. */
  state?: RequestState;
  /** The seq of the record that produced the refusal (grant, start, revoke). */
  seq?: number;
  /** The underlying append error, when `code` is `append-failed`. */
  append?: AppendError;
}

function refuse(
  code: TokenRefusalCode,
  message: string,
  extra: Omit<TokenRefusal, "ok" | "code" | "message"> = {},
): TokenRefusal {
  return { ok: false, code, message, ...extra };
}

/** Narrow the gate's read refusals onto this module's codes, unchanged. */
function fromGateRefusal(refusal: GateRefusal): TokenRefusal {
  const code: TokenRefusalCode =
    refusal.code === "log-torn-tail" ? "log-torn-tail" : "log-unreadable";
  return refuse(code, refusal.message);
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** A live, unspent grant and everything a consumer needs to spend it. */
export interface TokenStatus {
  ok: true;
  actionKey: string;
  /** The task id the grant names; `execution.started` requires it. */
  task: string | null;
  /** The `approval.granted` record's seq — the mint site, for audit. */
  grantSeq: number;
  /** The digest recorded at mint. The raw token is not stored anywhere. */
  tokenSha256: string;
  /** Copied from the grant payload, per the budgets consumption contract. */
  class: string;
  est_cost_usd: number;
  /** The `approval.requested` timestamp the TTL is measured from. */
  requestTs: string | null;
}

export type TokenStatusResult = TokenStatus | TokenRefusal;

function payloadOf(record: EventRecord): Record<string, unknown> {
  const payload = record.payload;
  return typeof payload === "object" && payload !== null ? payload : {};
}

/**
 * Is there a live, unspent token for `actionKey` — and what is its digest?
 *
 * Pure: no I/O, no clock. `now` is the moment the question is asked; `ttlMs` is
 * `defaults.approval_ttl` as the policy loader parsed it, or `null` for a policy
 * that declares no lapse (in which case a granted token stays spendable until it
 * is used or revoked, exactly as an undecided request stays live).
 *
 * Check order, and why:
 *
 * 1. **Revoked**, then **expired-by-derivation**, then **anything not granted**.
 *    A withdrawn authorization and a lapsed one are different facts and get
 *    different codes; everything else — never requested, still awaiting,
 *    rejected — is `not-granted`, because from a token's point of view they are
 *    the same absence.
 * 2. **The parent TTL, re-applied to the grant.** See the module header.
 * 3. **The recorded digest.** A grant with no usable `token_sha256` is a grant
 *    minted before this module existed (or by something else); it cannot
 *    authenticate anything, so it fails closed as `token-mismatch`.
 * 4. **Consumption.** Any `execution.started` for this action key spends it —
 *    matching digest or not. The narrow rule (same digest) is what makes
 *    double-spend detection chain-native; the broader rule (same action key)
 *    enforces SPEC.md §7's single-use idempotency key even against a start event
 *    that named no token, and both answer `token-consumed`.
 */
export function tokenStatus(
  records: EventRecord[],
  actionKey: string,
  now: string,
  ttlMs: number | null = null,
): TokenStatusResult {
  const derivation = requestState(records, actionKey, now, ttlMs);

  if (derivation.state === "revoked") {
    return refuse(
      "token-revoked",
      `action ${actionKey} was revoked at seq ${String(derivation.decisionSeq)}; a revoked grant's token is dead`,
      {
        state: derivation.state,
        ...(derivation.decisionSeq === null ? {} : { seq: derivation.decisionSeq }),
      },
    );
  }
  if (derivation.state === "expired") {
    return refuse(
      "token-expired",
      `action ${actionKey} expired: the request at ${String(derivation.requestTs)} lapsed before ${now}, so no token governs it`,
      { state: derivation.state },
    );
  }
  if (derivation.state !== "granted") {
    return refuse(
      "not-granted",
      `action ${actionKey} is ${derivation.state === "none" ? "not requested" : derivation.state}; a token exists only for a granted action`,
      { state: derivation.state },
    );
  }

  // The parent request's TTL bounds the token even though the request itself is
  // decided. No separate token TTL exists; this is that one clock, re-read.
  if (ttlMs !== null) {
    const requestedAt = Date.parse(derivation.requestTs ?? "");
    const asked = Date.parse(now);
    if (Number.isNaN(requestedAt) || Number.isNaN(asked) || asked > requestedAt + ttlMs) {
      return refuse(
        "token-expired",
        `action ${actionKey}'s token expired: the request at ${String(derivation.requestTs)} lapsed its ${String(ttlMs)}ms TTL before ${now}. There is no separate token TTL — a token lives exactly as long as its parent request.`,
        { state: derivation.state },
      );
    }
  }

  let grant: EventRecord | null = null;
  const started: EventRecord[] = [];
  for (const record of records) {
    if (record.action_key !== actionKey) continue;
    if (record.event === "approval.granted") grant = record;
    if (record.event === "execution.started") started.push(record);
  }
  if (grant === null) {
    // Unreachable through `requestState`, which only reports `granted` when it
    // saw the record. Kept as a fail-closed backstop rather than a `!`.
    return refuse(
      "not-granted",
      `action ${actionKey} derives as granted but carries no approval.granted record`,
      { state: derivation.state },
    );
  }

  const recorded = payloadOf(grant)[TOKEN_HASH_FIELD];
  if (typeof recorded !== "string" || !/^[a-f0-9]{64}$/u.test(recorded)) {
    return refuse(
      "token-mismatch",
      `the approval.granted record for ${actionKey} at seq ${grant.seq} carries no usable ${TOKEN_HASH_FIELD}; nothing can be proven against it and it authorizes no execution`,
      { state: derivation.state, seq: grant.seq },
    );
  }

  for (const record of started) {
    const presented = payloadOf(record)[TOKEN_HASH_FIELD];
    const sameToken = typeof presented === "string" && digestsEqual(presented, recorded);
    if (sameToken || record.seq > grant.seq) {
      return refuse(
        "token-consumed",
        `action ${actionKey} already executed: execution.started at seq ${record.seq} spent this token. A token is single-use and the log is the proof.`,
        { state: derivation.state, seq: record.seq },
      );
    }
  }

  const payload = payloadOf(grant);
  const cls = payload["class"];
  const cost = payload["est_cost_usd"];
  return {
    ok: true,
    actionKey,
    task: derivation.task,
    grantSeq: grant.seq,
    tokenSha256: recorded,
    class: typeof cls === "string" ? cls : derivation.declared.class ?? "",
    est_cost_usd: typeof cost === "number" && Number.isFinite(cost) ? cost : 0,
    requestTs: derivation.requestTs,
  };
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

/**
 * Does `presentedToken` authorize `actionKey` right now?
 *
 * Accepts **iff** all five hold: the latest cycle for the key derives as
 * `granted`; the parent request's TTL has not lapsed; the grant has not been
 * revoked; no `execution.started` has spent it; and `sha256(presentedToken)`
 * equals the digest recorded on the grant, compared in constant time.
 *
 * `ttlMs` is the parsed `defaults.approval_ttl`. It is a parameter rather than a
 * policy read because this function is pure — {@link consumeToken} and the CLI
 * load the policy and hand it in, so a verification can be replayed from the log
 * plus the policy that was in force.
 */
export function verifyToken(
  records: EventRecord[],
  actionKey: string,
  presentedToken: string,
  now: string,
  ttlMs: number | null = null,
): TokenStatusResult {
  const status = tokenStatus(records, actionKey, now, ttlMs);
  if (!status.ok) return status;

  if (!digestsEqual(tokenHash(presentedToken), status.tokenSha256)) {
    return refuse(
      "token-mismatch",
      `the token presented for ${actionKey} is not the one minted at seq ${status.grantSeq}. The raw token is printed once, by \`approval grant\`, and is stored nowhere — if it was lost, revoke the grant and request again.`,
      { state: "granted", seq: status.grantSeq },
    );
  }

  return status;
}

// ---------------------------------------------------------------------------
// consume
// ---------------------------------------------------------------------------

/** Where to find the policy whose `approval_ttl` bounds the token. */
export interface TokenOptions {
  /** Schema directory, passed to the append's write-boundary validation. */
  schemaDir?: string;
  /** Directory to discover `APPROVAL.md` in. Ignored when `policyFile` is set. */
  policyDir?: string;
  /** An explicit policy file, overriding discovery. */
  policyFile?: string;
  /** Lock tuning for the append path. */
  append?: AppendOptions;
}

export type ConsumeResult =
  | { ok: true; record: EventRecord; tokenSha256: string; grantSeq: number }
  | TokenRefusal;

function loadOptionsOf(options: TokenOptions): LoadPolicyOptions {
  const load: LoadPolicyOptions = {};
  if (options.policyFile !== undefined) load.file = options.policyFile;
  else load.dir = options.policyDir ?? process.cwd();
  if (options.schemaDir !== undefined) load.schemaDir = options.schemaDir;
  return load;
}

/** The parsed TTL, or `null` when the policy declares (or can declare) none. */
export function tokenTtlMs(options: TokenOptions): number | null {
  const load = loadPolicy(loadOptionsOf(options));
  return load.ok ? load.durations.approvalTtlMs : null;
}

/**
 * Spend a token: verify it, then append `execution.started`.
 *
 * **This is the only sanctioned way to append `execution.started` for a manual
 * action.** APRV-16 left that gap open deliberately — the gate appends no
 * execution events — and this function closes it: on the manual path a start
 * event now requires a live, verified, unspent token, so an agent cannot record
 * an execution the human never authorized. Supervised and autonomous actions
 * have no grant and therefore no token; their start event is APRV-18's `approval
 * run` wrapper's job, and calling this for them correctly refuses `not-granted`.
 *
 * The payload is exactly `{class, est_cost_usd, token_sha256}`: the first two
 * because `core/budgets.ts` meters authorization from them, the third because it
 * is what makes the second consumption attempt refusable from the log alone.
 * `class` and `est_cost_usd` are copied from the grant, never re-derived.
 *
 * Verification and append are not atomic against a concurrent writer of *other*
 * event types, but the double-spend that matters is closed by `appendEvent`'s
 * lockfile plus this re-read: two concurrent consumers serialize on the lock,
 * and the loser's own verification — performed before its append — has already
 * observed the winner's `execution.started` only if it read after the winner
 * wrote. To make that ordering unconditional the verification here reads the log
 * itself rather than accepting records from the caller.
 *
 * `actor` is not pre-validated: the event schema is the authority on actor
 * shape, and a malformed one is refused at the write boundary as
 * `append-failed`, with the schema's own error attached. One rule about actors,
 * enforced in one place.
 */
export function consumeToken(
  logPath: string,
  actionKey: string,
  presentedToken: string,
  ts: string,
  actor: string,
  options: TokenOptions = {},
): ConsumeResult {
  const read = readGateRecords(logPath);
  if (!read.ok) return fromGateRefusal(read);

  const verified = verifyToken(
    read.records,
    actionKey,
    presentedToken,
    ts,
    tokenTtlMs(options),
  );
  if (!verified.ok) return verified;

  if (verified.task === null) {
    // `execution.started` requires `task` (event.schema.json). A granted action
    // whose cycle names no task cannot produce a valid start event; refusing
    // here says so in this module's vocabulary rather than as a schema failure.
    return refuse(
      "not-granted",
      `action ${actionKey} has a grant but no task id in its request cycle; execution.started requires one`,
      { state: "granted", seq: verified.grantSeq },
    );
  }

  const appended = appendEvent(
    logPath,
    {
      ts,
      event: "execution.started",
      actor,
      task: verified.task,
      action_key: actionKey,
      payload: {
        class: verified.class,
        est_cost_usd: verified.est_cost_usd,
        [TOKEN_HASH_FIELD]: verified.tokenSha256,
      },
    },
    {
      ...options.append,
      ...(options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir }),
    },
  );
  if (!appended.ok) {
    return refuse(
      "append-failed",
      `execution.started could not be appended: ${appended.error.message}`,
      { append: appended.error },
    );
  }

  return {
    ok: true,
    record: appended.record,
    tokenSha256: verified.tokenSha256,
    grantSeq: verified.grantSeq,
  };
}
