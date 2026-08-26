/**
 * Execution token core tests (APRV-17 Part A).
 *
 * Every record here is produced by the real append path — `decide` minting
 * through `core/gate.ts`, `consumeToken` appending through `core/log.ts`.
 * Nothing hand-writes a log line, so no assertion rests on a record the write
 * boundary would have refused, and every scenario ends by walking the chain.
 *
 * The named guarantee has its own helper: {@link assertTokenAbsentFromLog}
 * scans the log's raw bytes for the raw token after each flow. If that ever
 * fires, the whole design is void — the log is the artifact this project asks
 * people to copy, export and audit.
 *
 * Timestamps are supplied, never read from the clock, so TTL death is exercised
 * by arithmetic rather than by sleeping.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { appendAttestation, consumeToken, decide, register, request } from "./clock-adapters.js";
import { evaluateBudgets } from "../src/core/budgets.js";
import { type GateOptions } from "../src/core/gate.js";
import { appendEvent, type EventRecord } from "../src/core/log.js";
import {
  asSealedToken,
  keyStoreDirFor,
  mintRecipientKeypair,
  openSealedToken,
  readPrivateKey,
  SEALED_TOKEN_FIELD,
} from "../src/core/seal.js";
import {
  digestsEqual,
  mintToken,
  TOKEN_BYTES,
  TOKEN_HASH_FIELD,
  TOKEN_REFUSAL_CODES,
  TOKEN_VERIFY_REFUSAL_CODES,
  tokenHash,
  tokenStatus,
  tokenTtlMs,
  verifyToken,
  type TokenRefusal,
} from "../src/core/token.js";
import { verify } from "../src/core/verify.js";

const scratch = mkdtempSync(join(tmpdir(), "approval-md-token-"));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const T0 = "2026-08-05T10:00:00.000Z";

/** `minutes` after {@link T0}, as an RFC 3339 instant. */
function at(minutes: number): string {
  return new Date(Date.parse(T0) + minutes * 60_000).toISOString();
}

const TTL_MS = 3_600_000;

const POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "1h"',
  "  on_expiry: reject",
  "classes:",
  "  communicate.email.external:",
  "    autonomy: manual",
  "    limits:",
  "      daily_actions: 1",
  "```",
  "",
].join("\n");

/**
 * The same policy with sealed token delivery turned on (APRV-105). The knob is
 * the ONLY difference: everything else about this file's flows is unchanged, so
 * a sweep that passes under both is a sweep that pins the amended invariant.
 */
const SEALED_POLICY = [
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "1h"',
  "  on_expiry: reject",
  "  token_delivery: sealed",
  "```",
  "",
].join("\n");

/** The action key this file's flows use. */
const SEALED_KEY = "task-042:chaser";

/** Same policy with no TTL: nothing lapses, so no token dies of old age. */
const POLICY_NO_TTL = [
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  "```",
  "",
].join("\n");

interface Case {
  dir: string;
  logPath: string;
  policyPath: string;
  options: GateOptions;
}

function newCase(policyText: string = POLICY): Case {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  const policyPath = join(dir, "APPROVAL.md");
  writeFileSync(policyPath, policyText, "utf8");
  return {
    dir,
    logPath: join(dir, ".approval", "log", "events.jsonl"),
    policyPath,
    options: { policy: { file: policyPath } },
  };
}

function attest(unit: Case): void {
  const result = appendAttestation(unit.logPath, unit.policyPath, "human:carter", T0);
  assert.equal(result.ok, true, "attestation append failed");
}

function rawLog(unit: Case): string {
  try {
    return readFileSync(unit.logPath, "utf8");
  } catch {
    return "";
  }
}

function records(unit: Case): EventRecord[] {
  return rawLog(unit)
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as EventRecord);
}

function assertClean(unit: Case): void {
  const result = verify(unit.logPath);
  assert.equal(result.status, "clean", `log not clean: ${JSON.stringify(result)}`);
}

/** THE named guarantee: the raw token appears in no byte of the log. */
function assertTokenAbsentFromLog(unit: Case, token: string): void {
  const raw = rawLog(unit);
  assert.ok(raw.length > 0, "expected a non-empty log");
  assert.equal(raw.includes(token), false, "the RAW TOKEN reached the log");
  // Line by line too, so a token that were split across a JSON escape could not
  // hide from the whole-file scan.
  for (const line of raw.split("\n")) {
    assert.equal(line.includes(token), false, `raw token found in: ${line.slice(0, 120)}`);
  }
}

/**
 * The content binding for an action key (amended SPEC.md §6.2, A1).
 *
 * Per-key rather than a shared constant, so the binding tests can prove that a
 * token minted for one payload cannot spend another: two keys have two hashes.
 * The value is `sha256(key)`, which is a legal 64-hex digest and nothing more —
 * `tests/payload.test.ts` covers the real derivation.
 */
function bindingFor(key: string): string {
  return createHash("sha256").update(`payload:${key}`, "utf8").digest("hex");
}

function envelopeFor(keys: string[]): unknown {
  return {
    origin: { app: "example-capture", created_by: "human:carter" },
    state: "proposed",
    actions: keys.map((key) => ({
      class: "communicate.email.external",
      summary: "Send deposit chaser",
      reversible: false,
      est_cost_usd: 0.02,
      idempotency_key: key,
      payload_hash: bindingFor(key),
    })),
  };
}

function registerTask(unit: Case, keys: string[] = ["task-042:chaser"]): void {
  const result = register(
    unit.logPath,
    { task: "task-042", envelope: envelopeFor(keys) },
    T0,
    "agent:claude",
  );
  assert.equal(result.ok, true, result.ok ? "" : result.message);
}

function requestAction(unit: Case, actionKey: string, ts: string = at(1)): void {
  const result = request(
    unit.logPath,
    {
      task: "task-042",
      actionKey,
      cls: "communicate.email.external",
      est_cost_usd: 0.02,
      reversible: false,
      summary: "Send deposit chaser",
      payload_hash: bindingFor(actionKey),
    },
    ts,
    "agent:claude",
    unit.options,
  );
  assert.equal(result.ok, true, result.ok ? "" : result.message);
}

function grant(unit: Case, actionKey: string, ts: string = at(2)): string {
  const result = decide(unit.logPath, actionKey, "grant", "human:carter", ts, unit.options);
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(typeof result.token, "string", "grant returned no token");
  return result.token as string;
}

/** Attested, registered, requested and granted: one live token. */
function granted(
  unit: Case,
  actionKey: string = "task-042:chaser",
  keys: string[] = [actionKey],
): string {
  attest(unit);
  registerTask(unit, keys);
  requestAction(unit, actionKey);
  return grant(unit, actionKey);
}

function asRefusal(value: { ok: boolean }): TokenRefusal {
  assert.equal(value.ok, false, "expected a refusal");
  return value as TokenRefusal;
}

// ===========================================================================
// mint / hash primitives
// ===========================================================================

test("mintToken produces 32 bytes of hex entropy and never repeats", () => {
  const seen = new Set<string>();
  for (let index = 0; index < 256; index += 1) {
    const token = mintToken();
    assert.match(token, /^[a-f0-9]{64}$/u);
    assert.equal(token.length, TOKEN_BYTES * 2);
    assert.equal(seen.has(token), false, "mintToken repeated a value");
    seen.add(token);
  }
});

test("tokenHash is plain SHA-256 hex, and digestsEqual is exact", () => {
  const token = mintToken();
  assert.equal(tokenHash(token), createHash("sha256").update(token, "utf8").digest("hex"));
  assert.equal(digestsEqual(tokenHash(token), tokenHash(token)), true);
  assert.equal(digestsEqual(tokenHash(token), tokenHash(`${token}x`)), false);
  // Malformed digests never match, and never throw out of timingSafeEqual.
  assert.equal(digestsEqual("", tokenHash(token)), false);
  assert.equal(digestsEqual("nothex", tokenHash(token)), false);
  assert.equal(digestsEqual("ab".repeat(31), tokenHash(token)), false);
});

test("the refusal unions are frozen and the verify codes are a prefix of them", () => {
  assert.deepEqual([...TOKEN_VERIFY_REFUSAL_CODES], [
    "not-granted",
    "token-mismatch",
    "token-consumed",
    "token-expired",
    "token-revoked",
    // APRV-20 pass two, amendment A1: a grant approves specific bytes, so a
    // spend that presents different ones (or none) is refused on its own code.
    "payload-mismatch",
    // APRV-106: a grant for a harness-executed request minted no token, on
    // purpose. Its own code because the repair is "nothing to repair" — an
    // agent told `token-mismatch` here would hunt for a token that was
    // deliberately never created.
    "harness-executed",
  ]);
  assert.deepEqual([...TOKEN_REFUSAL_CODES], [
    ...TOKEN_VERIFY_REFUSAL_CODES,
    "log-unreadable",
    "log-torn-tail",
    // APRV-20 finding S1, shared verbatim with the gate and the executor.
    "log-corrupt",
    "append-failed",
  ]);
});

test("a harness-executed grant refuses the token path with its own code", () => {
  // APRV-106. The grant is complete and the human decided; there is simply no
  // key, because the requesting process runs the command itself. An agent told
  // `token-mismatch` here would hunt for a token that never existed.
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  const requested = request(
    unit.logPath,
    {
      task: "task-042",
      actionKey: "task-042:chaser",
      cls: "communicate.email.external",
      est_cost_usd: 0.02,
      reversible: false,
      summary: "Send deposit chaser",
      payload_hash: bindingFor("task-042:chaser"),
      execution: "harness",
    },
    at(1),
    "agent:claude",
    unit.options,
  );
  assert.equal(requested.ok, true, requested.ok ? "" : requested.message);
  assert.equal(
    decide(unit.logPath, "task-042:chaser", "grant", "human:carter", at(2), unit.options).ok,
    true,
  );

  const status = tokenStatus(records(unit), "task-042:chaser", at(3), 3_600_000);
  assert.equal(status.ok, false);
  if (status.ok) throw new Error("unreachable");
  assert.equal(status.code, "harness-executed");
  assert.match(status.message, /runs the command itself/u);
  assertClean(unit);
});

// ===========================================================================
// mint at grant: hash in the log, token nowhere
// ===========================================================================

test("grant mints a token, logs ONLY its sha256, and the raw token never reaches the log", () => {
  const unit = newCase();
  const token = granted(unit);

  assert.match(token, /^[a-f0-9]{64}$/u);
  const grantRecord = records(unit).find((record) => record.event === "approval.granted");
  assert.notEqual(grantRecord, undefined);
  const payload = (grantRecord?.payload ?? {}) as Record<string, unknown>;
  assert.equal(payload["token_sha256"], tokenHash(token));
  // The budgets contract survives the addition.
  assert.equal(payload["class"], "communicate.email.external");
  assert.equal(payload["est_cost_usd"], 0.02);

  assertTokenAbsentFromLog(unit, token);
  assertClean(unit);
});

test("under sealed delivery the raw token STILL reaches no byte of the log", () => {
  // APRV-105 reworded §11.1 invariant 3 to "a hash, or ciphertext sealed to a
  // recipient key the log does not hold". This is the sweep that pins both
  // halves: the plaintext is still absent, and the ciphertext that replaced the
  // human's clipboard does not open without a private key the log never carries.
  const unit = newCase(SEALED_POLICY);
  const token = granted(unit);

  const grantRecord = records(unit).find((record) => record.event === "approval.granted");
  const payload = (grantRecord?.payload ?? {}) as Record<string, unknown>;
  // The digest is unchanged and is still what possession is proven against; the
  // seal is delivery, never authorization.
  assert.equal(payload["token_sha256"], tokenHash(token));

  const sealed = asSealedToken(payload[SEALED_TOKEN_FIELD]);
  assert.notEqual(sealed, null, "sealed delivery recorded no ciphertext");
  if (sealed === null) return;

  assertTokenAbsentFromLog(unit, token);

  // A reader with the whole log and no key file gets nothing. The stranger's key
  // is a well-formed X25519 private key, so this is the real attack — someone
  // who thought to bring their own key — and not a parse failure.
  const stranger = mintRecipientKeypair();
  assert.equal(openSealedToken(sealed, stranger.privateKey, SEALED_KEY), null);

  // And the seal is bound to the action it was minted for: the right key on the
  // wrong action key derives a different AEAD key and fails to authenticate.
  const rightKey = readPrivateKey(keyStoreDirFor(unit.logPath), SEALED_KEY);
  assert.notEqual(rightKey, null, "the requester's private key was not written");
  if (rightKey === null) return;
  assert.equal(openSealedToken(sealed, rightKey, "task-042:some-other-action"), null);

  // With the key AND the action key, the requesting process gets its token back.
  assert.equal(openSealedToken(sealed, rightKey, SEALED_KEY), token);
  assertClean(unit);
});

test("two grants of two actions mint two different tokens bound to their own keys", () => {
  const unit = newCase(POLICY_NO_TTL);
  attest(unit);
  registerTask(unit, ["task-042:a", "task-042:b"]);
  requestAction(unit, "task-042:a");
  requestAction(unit, "task-042:b");
  const tokenA = grant(unit, "task-042:a");
  const tokenB = grant(unit, "task-042:b", at(3));

  assert.notEqual(tokenA, tokenB);
  assert.equal(verifyToken(records(unit), "task-042:a", tokenA, at(4)).ok, true);
  assert.equal(verifyToken(records(unit), "task-042:b", tokenB, at(4)).ok, true);

  // The binding to (request, idempotency_key): A's token is worthless for B.
  assert.equal(
    asRefusal(verifyToken(records(unit), "task-042:b", tokenA, at(4))).code,
    "token-mismatch",
  );
  assert.equal(
    asRefusal(verifyToken(records(unit), "task-042:a", tokenB, at(4))).code,
    "token-mismatch",
  );
  assertTokenAbsentFromLog(unit, tokenA);
  assertTokenAbsentFromLog(unit, tokenB);
  assertClean(unit);
});

// ===========================================================================
// verify: exactly the right token, and nothing else
// ===========================================================================

test("verifyToken accepts the minted token and reports the grant it came from", () => {
  const unit = newCase();
  const token = granted(unit);

  const result = verifyToken(records(unit), "task-042:chaser", token, at(3), TTL_MS);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.tokenSha256, tokenHash(token));
  assert.equal(result.task, "task-042");
  assert.equal(result.class, "communicate.email.external");
  assert.equal(result.est_cost_usd, 0.02);
  assert.equal(result.grantSeq, 4);
});

test("a wrong, tampered, or empty token is token-mismatch — nothing else is accepted", () => {
  const unit = newCase();
  const token = granted(unit);
  const log = records(unit);

  const wrong = mintToken();
  // One hex digit flipped: the timing-safe comparison leaks no prefix, and a
  // near miss is exactly as refused as a random string.
  const tampered = `${token.slice(0, 63)}${token.endsWith("a") ? "b" : "a"}`;
  for (const presented of [wrong, tampered, "", "not-hex", token.toUpperCase(), ` ${token}`]) {
    const refusal = asRefusal(verifyToken(log, "task-042:chaser", presented, at(3), TTL_MS));
    assert.equal(refusal.code, "token-mismatch", `accepted ${JSON.stringify(presented)}`);
    assert.equal(refusal.state, "granted");
  }
  assert.equal(verifyToken(log, "task-042:chaser", token, at(3), TTL_MS).ok, true);
});

test("no grant means no token: unrequested, awaiting and rejected are all not-granted", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);

  // Never requested.
  assert.equal(
    asRefusal(verifyToken(records(unit), "task-042:chaser", mintToken(), at(2), TTL_MS)).code,
    "not-granted",
  );

  // Requested but undecided.
  requestAction(unit, "task-042:chaser");
  const awaiting = asRefusal(
    verifyToken(records(unit), "task-042:chaser", mintToken(), at(2), TTL_MS),
  );
  assert.equal(awaiting.code, "not-granted");
  assert.equal(awaiting.state, "requested");

  // Rejected.
  const rejected = decide(
    unit.logPath,
    "task-042:chaser",
    "reject",
    "human:carter",
    at(2),
    unit.options,
  );
  assert.equal(rejected.ok, true);
  const after = asRefusal(verifyToken(records(unit), "task-042:chaser", mintToken(), at(3), TTL_MS));
  assert.equal(after.code, "not-granted");
  assert.equal(after.state, "rejected");
  assertClean(unit);
});

test("a grant with no token_sha256 authorizes nothing (fail closed, token-mismatch)", () => {
  // A pre-APRV-17 log: the grant is genuine, but carries no digest, so no
  // preimage can be proven against it and it cannot execute.
  const unit = newCase(POLICY_NO_TTL);
  attest(unit);
  registerTask(unit);
  requestAction(unit, "task-042:chaser");
  const legacy = appendEvent(unit.logPath, {
    ts: at(2),
    event: "approval.granted",
    actor: "human:carter",
    task: "task-042",
    action_key: "task-042:chaser",
    payload: { class: "communicate.email.external", est_cost_usd: 0.02 },
  });
  assert.equal(legacy.ok, true);

  const refusal = asRefusal(tokenStatus(records(unit), "task-042:chaser", at(3)));
  assert.equal(refusal.code, "token-mismatch");
  assert.match(refusal.message, /token_sha256/u);
  assertClean(unit);
});

// ===========================================================================
// consume: the single sanctioned appender of execution.started
// ===========================================================================

test("consumeToken appends execution.started with the exact contract payload", () => {
  const unit = newCase();
  const token = granted(unit);

  const result = consumeToken(
    unit.logPath,
    "task-042:chaser",
    token,
    at(3),
    "agent:claude",
    {
      policyFile: unit.policyPath,
      presentedPayloadHash: bindingFor("task-042:chaser"),
    },
  );
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok) return;

  assert.equal(result.record.event, "execution.started");
  assert.equal(result.record.actor, "agent:claude");
  assert.equal(result.record.task, "task-042");
  assert.equal(result.record.action_key, "task-042:chaser");
  assert.deepEqual(result.record.payload, {
    class: "communicate.email.external",
    est_cost_usd: 0.02,
    token_sha256: tokenHash(token),
    // A1: the bytes that ran, recorded beside the token that authorized them.
    payload_hash: bindingFor("task-042:chaser"),
  });
  assert.equal(result.grantSeq, 4);

  assertTokenAbsentFromLog(unit, token);
  assertClean(unit);
});

test("death by execution: the second consume is refused FROM THE LOG, not from memory", () => {
  const unit = newCase();
  const token = granted(unit);
  const options = { policyFile: unit.policyPath };

  const first = consumeToken(unit.logPath, "task-042:chaser", token, at(3), "agent:claude", { ...options, presentedPayloadHash: bindingFor("task-042:chaser") });
  assert.equal(first.ok, true);

  // Chain-native: a completely fresh verification, reading only the log's bytes,
  // already knows the token is spent. No consumeToken call is involved.
  const fromLog = asRefusal(verifyToken(records(unit), "task-042:chaser", token, at(4), TTL_MS));
  assert.equal(fromLog.code, "token-consumed");
  assert.equal(fromLog.seq, 5);

  const second = asRefusal(
    consumeToken(unit.logPath, "task-042:chaser", token, at(4), "agent:claude", { ...options, presentedPayloadHash: bindingFor("task-042:chaser") }),
  );
  assert.equal(second.code, "token-consumed");
  assert.equal(
    records(unit).filter((record) => record.event === "execution.started").length,
    1,
    "a second execution.started was appended",
  );
  assertClean(unit);
});

test("a token is not spendable from a log that does not verify (log-corrupt)", () => {
  const unit = newCase();
  const token = granted(unit);

  // Forge the grant's recorded digest: valid JSON, valid against the schema,
  // wrong hash. A reader that merely parsed the line would happily authorize an
  // execution against a record nobody ever wrote.
  const lines = readFileSync(unit.logPath, "utf8").split("\n");
  const grantLine = lines.findIndex((line) => line.includes('"approval.granted"'));
  assert.ok(grantLine >= 0, "expected an approval.granted line");
  const forged = JSON.parse(lines[grantLine] as string) as Record<string, unknown>;
  forged["payload"] = {
    ...(forged["payload"] as Record<string, unknown>),
    [TOKEN_HASH_FIELD]: createHash("sha256").update("forged", "utf8").digest("hex"),
  };
  lines[grantLine] = JSON.stringify(forged);
  writeFileSync(unit.logPath, lines.join("\n"), "utf8");
  const before = readFileSync(unit.logPath, "utf8");

  const refusal = asRefusal(
    consumeToken(unit.logPath, "task-042:chaser", token, at(3), "agent:claude", {
      policyFile: unit.policyPath,      presentedPayloadHash: bindingFor("task-042:chaser"),
    }),
  );
  assert.equal(refusal.code, "log-corrupt");
  assert.match(refusal.message, /does not verify/);
  assert.equal(readFileSync(unit.logPath, "utf8"), before, "nothing was appended");
});

test("an execution.started for the key spends it even if it named no token", () => {
  // SPEC.md §7's idempotency key is single-use: a start event appended by any
  // other path still closes the action. Fail closed, same code.
  const unit = newCase();
  const token = granted(unit);
  const started = appendEvent(unit.logPath, {
    ts: at(3),
    event: "execution.started",
    actor: "agent:claude",
    task: "task-042",
    action_key: "task-042:chaser",
    payload: { class: "communicate.email.external", est_cost_usd: 0.02 },
  });
  assert.equal(started.ok, true);

  assert.equal(
    asRefusal(verifyToken(records(unit), "task-042:chaser", token, at(4), TTL_MS)).code,
    "token-consumed",
  );
  assertClean(unit);
});

test("death by revocation: a revoked grant's token is token-revoked", () => {
  const unit = newCase();
  const token = granted(unit);

  const revoked = decide(
    unit.logPath,
    "task-042:chaser",
    "revoke",
    "human:carter",
    at(3),
    unit.options,
  );
  assert.equal(revoked.ok, true, revoked.ok ? "" : revoked.message);

  const refusal = asRefusal(verifyToken(records(unit), "task-042:chaser", token, at(4), TTL_MS));
  assert.equal(refusal.code, "token-revoked");
  assert.equal(refusal.state, "revoked");

  const consumed = asRefusal(
    consumeToken(unit.logPath, "task-042:chaser", token, at(4), "agent:claude", {
      policyFile: unit.policyPath,      presentedPayloadHash: bindingFor("task-042:chaser"),
    }),
  );
  assert.equal(consumed.code, "token-revoked");
  assert.deepEqual(
    records(unit).filter((record) => record.event === "execution.started"),
    [],
  );
  assertClean(unit);
});

test("death by the PARENT REQUEST's TTL: past requestTs + ttl the token is token-expired", () => {
  const unit = newCase();
  const token = granted(unit); // requested at at(1), granted at at(2), ttl 1h

  // Inside the TTL, at any age, the token verifies — there is no token TTL.
  for (const minutes of [2, 30, 59, 60.5]) {
    assert.equal(
      verifyToken(records(unit), "task-042:chaser", token, at(minutes), TTL_MS).ok,
      true,
      `token refused at ${minutes} minutes, still inside the parent TTL`,
    );
  }

  // Past requestTs + 1h it is dead, and nothing had to run to kill it.
  const refusal = asRefusal(verifyToken(records(unit), "task-042:chaser", token, at(62), TTL_MS));
  assert.equal(refusal.code, "token-expired");
  assert.match(refusal.message, /no separate token TTL/u);

  const consumed = asRefusal(
    consumeToken(unit.logPath, "task-042:chaser", token, at(62), "agent:claude", {
      policyFile: unit.policyPath,      presentedPayloadHash: bindingFor("task-042:chaser"),
    }),
  );
  assert.equal(consumed.code, "token-expired");
  assert.deepEqual(
    records(unit).filter((record) => record.event === "execution.started"),
    [],
  );
  assertClean(unit);
});

test("a policy with no approval_ttl gives a token no expiry at all", () => {
  const unit = newCase(POLICY_NO_TTL);
  const token = granted(unit);
  assert.equal(tokenTtlMs({ policyFile: unit.policyPath }), null);

  // A year later, still spendable: no TTL means no lapse, and this module never
  // invents a deadline the policy did not declare.
  const later = new Date(Date.parse(T0) + 365 * 24 * 3_600_000).toISOString();
  assert.equal(verifyToken(records(unit), "task-042:chaser", token, later, null).ok, true);
  const result = consumeToken(unit.logPath, "task-042:chaser", token, later, "agent:claude", {
    policyFile: unit.policyPath,
    presentedPayloadHash: bindingFor("task-042:chaser"),
  });
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  assertTokenAbsentFromLog(unit, token);
  assertClean(unit);
});

test("an expired-and-lapsed request (never decided) refuses as token-expired", () => {
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  requestAction(unit, "task-042:chaser");
  const refusal = asRefusal(
    verifyToken(records(unit), "task-042:chaser", mintToken(), at(62), TTL_MS),
  );
  assert.equal(refusal.code, "token-expired");
  assert.equal(refusal.state, "expired");
});

test("the supervised/autonomous path is not this function's: no grant, no token", () => {
  // consumeToken is the MANUAL path's appender. An action with no grant refuses,
  // so APRV-18's run wrapper — not this — starts supervised/autonomous work.
  const unit = newCase();
  attest(unit);
  registerTask(unit);
  const refusal = asRefusal(
    consumeToken(unit.logPath, "task-042:chaser", mintToken(), at(2), "agent:claude", {
      policyFile: unit.policyPath,      presentedPayloadHash: bindingFor("task-042:chaser"),
    }),
  );
  assert.equal(refusal.code, "not-granted");
  assert.deepEqual(
    records(unit).filter((record) => record.event === "execution.started"),
    [],
  );
});

test("a malformed actor is refused at the write boundary as append-failed", () => {
  const unit = newCase();
  const token = granted(unit);
  const refusal = asRefusal(
    consumeToken(unit.logPath, "task-042:chaser", token, at(3), "root", {
      policyFile: unit.policyPath,      presentedPayloadHash: bindingFor("task-042:chaser"),
    }),
  );
  assert.equal(refusal.code, "append-failed");
  assert.equal(refusal.append?.code, "validation");
  assert.deepEqual(
    records(unit).filter((record) => record.event === "execution.started"),
    [],
  );
  // Refused, so the token is still live for a legitimate executor.
  assert.equal(verifyToken(records(unit), "task-042:chaser", token, at(3), TTL_MS).ok, true);
  assertClean(unit);
});

// ===========================================================================
// budgets: grant + consume = exactly one charge
// ===========================================================================

test("grant + consume charges the window ONCE (the double-count guard, end to end)", () => {
  const unit = newCase(); // daily_actions: 1 on communicate.email.external
  const token = granted(unit);

  const scope = {
    classLimits: { daily_actions: 1 },
    classPattern: "communicate.email.external",
    globalBudgets: null,
  };
  const action = { class: "communicate.email.external", est_cost_usd: 0.02 };

  // After the grant alone: one authorization consumed, so a second would fail.
  const afterGrant = evaluateBudgets(records(unit), scope, action, at(3));
  assert.equal(afterGrant.pass, false);
  const grantVerdict = afterGrant.verdicts.find((verdict) => verdict.limit === "daily_actions");
  assert.equal(grantVerdict?.consumed, 1);

  const consumed = consumeToken(
    unit.logPath,
    "task-042:chaser",
    token,
    at(3),
    "agent:claude",
    { policyFile: unit.policyPath, presentedPayloadHash: bindingFor("task-042:chaser") },
  );
  assert.equal(consumed.ok, true, consumed.ok ? "" : consumed.message);

  // After grant AND consume: still ONE. The evaluator counts an
  // execution.started only when the window holds no same-key approval.granted.
  const afterConsume = evaluateBudgets(records(unit), scope, action, at(4));
  const consumeVerdict = afterConsume.verdicts.find((verdict) => verdict.limit === "daily_actions");
  assert.equal(consumeVerdict?.consumed, 1, "the manual action was charged twice");
  assertClean(unit);
});

// ===========================================================================
// full flow
// ===========================================================================

test("a full request → grant → consume flow leaves the chain clean and the token unlogged", () => {
  const unit = newCase();
  const token = granted(unit);
  const consumed = consumeToken(
    unit.logPath,
    "task-042:chaser",
    token,
    at(3),
    "agent:claude",
    { policyFile: unit.policyPath, presentedPayloadHash: bindingFor("task-042:chaser") },
  );
  assert.equal(consumed.ok, true);
  const completed = appendEvent(unit.logPath, {
    ts: at(4),
    event: "execution.completed",
    actor: "agent:claude",
    task: "task-042",
    action_key: "task-042:chaser",
    payload: {},
  });
  assert.equal(completed.ok, true);

  assert.deepEqual(
    records(unit).map((record) => record.event),
    [
      "policy.updated",
      "task.registered",
      "approval.requested",
      "approval.granted",
      "execution.started",
      "execution.completed",
    ],
  );
  assertTokenAbsentFromLog(unit, token);
  assertClean(unit);
});
