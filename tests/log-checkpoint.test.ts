/**
 * Human-signed log checkpoints (APRV-220).
 *
 * The premise is `docs/proposals/incremental-prefix-proof.md` §3 and the
 * conformance suite's own boundary vector: the chain is unkeyed, so a party
 * with write access to `events.jsonl` can truncate it and recompute a chain
 * that walks clean from genesis, and nothing inside the file will ever say
 * otherwise. What that party cannot do is re-sign the hashes they replaced.
 *
 * So the load-bearing case here is the forgery, and it is built the way a
 * forger builds one: truncate the file, re-append through the REAL append path
 * (`core/log.ts`), and carry the old checkpoint record forward verbatim, which
 * is what somebody erasing a record would do rather than deleting the one
 * record that proves they did. The result walks clean, the anchor check would
 * have nothing to say on a machine that never pushed, and the checkpoint says
 * the chain was rewritten.
 *
 * Every key in this file is generated per test into a scratch directory.
 * Nothing here reads a key from the repository, and no log line is written by
 * hand: records come from `appendAttestation` and `appendEvent`.
 *
 * One case is deliberately not driven through a log file at all —
 * `checkpoint-malformed`. The event schema and `readCheckpointPayload` agree
 * field for field, so a payload that reaches the reader malformed cannot have
 * come through this runtime's write boundary. That case exercises the pure
 * function over records that never touch a file, which is the only honest way
 * to reach a state this implementation refuses to create.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { appendAttestation } from "../src/core/attest.js";
import {
  CHECKPOINT_ALG,
  CHECKPOINT_DOMAIN,
  CHECKPOINT_REFUSAL_CODES,
  appendCheckpoint,
  checkLogCheckpoints,
  checkpointKeyFingerprint,
  checkpointMessage,
  checkpointPolicyOf,
  mintCheckpointKeypair,
  privateKeyFingerprint,
  readCheckpointPayload,
  signCheckpoint,
  verifyCheckpointSignature,
} from "../src/core/checkpoint.js";
import { APPEND_ERROR_CODES, appendEvent, type EventRecord } from "../src/core/log.js";
import { GATE_REFUSAL_CODES } from "../src/core/gate.js";
import { ANCHOR_REFUSAL_CODES } from "../src/cli/log-anchor.js";
import { verify, verifyWithRecords } from "../src/core/verify.js";
import { Daemon, type DaemonEvent } from "../src/daemon/daemon.js";

/** dist/tests/log-checkpoint.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-checkpoint-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A policy carrying `keys` under `audit.checkpoint_keys`, plus an optional cadence. */
function policyText(keys: readonly string[], every?: string): string {
  const lines = [
    "# Policy",
    "",
    "```yaml approval-policy",
    'version: "0.1"',
    "defaults:",
    "  autonomy: manual",
    '  approval_ttl: "1h"',
    "  on_expiry: reject",
    "classes:",
    "  read.*:",
    "    autonomy: autonomous",
  ];
  if (keys.length > 0 || every !== undefined) {
    lines.push("audit:");
    if (every !== undefined) lines.push(`  checkpoint_every: "${every}"`);
    if (keys.length > 0) {
      lines.push("  checkpoint_keys:");
      for (const key of keys) lines.push(`    - "${key}"`);
    }
  }
  lines.push("```", "");
  return lines.join("\n");
}

interface Home {
  dir: string;
  logPath: string;
  policyPath: string;
  keyPath: string;
  publicKey: string;
  privateKey: string;
  fingerprint: string;
}

/** A scratch approval home with a fresh keypair and a policy that lists it. */
function newHome(options: { records?: number; keys?: "own" | "none" | "other"; every?: string } = {}): Home {
  counter += 1;
  const dir = join(scratch, `home-${String(counter)}`);
  mkdirSync(join(dir, ".approval", "log"), { recursive: true });
  const pair = mintCheckpointKeypair();
  const listed =
    options.keys === "none"
      ? []
      : options.keys === "other"
        ? [mintCheckpointKeypair().publicKey]
        : [pair.publicKey];
  const policyPath = join(dir, "APPROVAL.md");
  writeFileSync(policyPath, policyText(listed, options.every), "utf8");
  const keyPath = join(dir, "checkpoint.key");
  writeFileSync(keyPath, `${pair.privateKey}\n`, { encoding: "utf8", mode: 0o600 });

  const home: Home = {
    dir,
    logPath: join(dir, ".approval", "log", "events.jsonl"),
    policyPath,
    keyPath,
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    fingerprint: pair.fingerprint,
  };
  for (let index = 0; index < (options.records ?? 3); index += 1) {
    appendRecord(home, `seed-${String(index)}`);
  }
  return home;
}

/** One record through the real append path. Returns the new head seq. */
function appendRecord(home: Home, marker: string): number {
  const path = join(home.dir, ".approval", "attest-marker.md");
  const before = (() => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "# attested fixture\n";
    }
  })();
  writeFileSync(path, `${before}\n<!-- ${marker} -->\n`, "utf8");
  const appended = appendAttestation(home.logPath, path, "human:tester");
  assert.equal(appended.ok, true, appended.ok ? "" : appended.error.message);
  if (!appended.ok) throw new Error("unreachable");
  return appended.record.seq;
}

/** The verified working records, which is what the check is always handed. */
function records(logPath: string): EventRecord[] {
  const walked = verifyWithRecords(logPath);
  assert.equal(walked.result.status, "clean", JSON.stringify(walked.result));
  return walked.records;
}

/** The check, run the way every caller runs it: on already-verified records. */
function check(home: Home, extra: { now?: number } = {}): ReturnType<typeof checkLogCheckpoints> {
  const configured = checkpointPolicyOf({ file: home.policyPath });
  return checkLogCheckpoints({
    records: records(home.logPath),
    publicKeys: configured.publicKeys,
    checkpointEveryMs: configured.checkpointEveryMs,
    keysUnavailable: configured.unloadable,
    ...(extra.now === undefined ? {} : { now: extra.now }),
  });
}

/** Sign the current head with this home's key, through the real append path. */
function signHead(home: Home, actor = "human:tester"): EventRecord {
  const result = appendCheckpoint(home.logPath, home.privateKey, actor);
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok) throw new Error("unreachable");
  return result.record;
}

function runCli(args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], { cwd, encoding: "utf8" });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

// ===========================================================================
// The refusal union (SPEC.md §11.1 invariant 6)
// ===========================================================================

test("the checkpoint refusal union is frozen public API, in definition order", () => {
  // Pinned here for the reason every other union in this runtime is pinned in
  // its own suite: a caller branches on these strings, so adding, removing or
  // renaming one is a breaking change and has to show up as a diff. The
  // conformance suite pins the same array under `checkpoint_refusal_codes`.
  assert.deepEqual(
    [...CHECKPOINT_REFUSAL_CODES],
    [
      "checkpoint-key-unknown",
      "checkpoint-signature-invalid",
      "checkpoint-hash-mismatch",
      "checkpoint-out-of-order",
      "checkpoint-malformed",
    ],
  );
  // And it is distinct from every other union, the anchor's included: the two
  // checks are separate witnesses and a caller must never confuse them.
  for (const code of CHECKPOINT_REFUSAL_CODES) {
    assert.equal((GATE_REFUSAL_CODES as readonly string[]).includes(code), false, code);
    assert.equal((APPEND_ERROR_CODES as readonly string[]).includes(code), false, code);
    assert.equal((ANCHOR_REFUSAL_CODES as readonly string[]).includes(code), false, code);
  }
});

// ===========================================================================
// The signature primitive
// ===========================================================================

test("a signature over a head verifies under the public half and nothing else", () => {
  const mine = mintCheckpointKeypair();
  const theirs = mintCheckpointKeypair();
  const head = { seq: 7, hash: "a".repeat(64) };

  const signature = signCheckpoint(head, mine.privateKey);
  assert.notEqual(signature, null);
  assert.equal(verifyCheckpointSignature(head, signature as string, mine.publicKey), true);
  assert.equal(verifyCheckpointSignature(head, signature as string, theirs.publicKey), false);
  // A different head is a different message, which is the whole claim.
  assert.equal(
    verifyCheckpointSignature({ seq: 8, hash: head.hash }, signature as string, mine.publicKey),
    false,
  );
  assert.equal(
    verifyCheckpointSignature({ seq: 7, hash: "b".repeat(64) }, signature as string, mine.publicKey),
    false,
  );
});

test("the signed message is domain-separated and canonical", () => {
  const message = checkpointMessage({ seq: 7, hash: "a".repeat(64) }).toString("utf8");
  assert.ok(message.startsWith(`${CHECKPOINT_DOMAIN}\n`));
  // RFC 8785 orders the keys, so two runtimes that agree on the head agree on
  // the bytes without agreeing on anything else.
  assert.equal(
    message.slice(CHECKPOINT_DOMAIN.length + 1),
    `{"alg":"${CHECKPOINT_ALG}","hash":"${"a".repeat(64)}","seq":7}`,
  );
  // A signature made over the raw canonical body, without the domain prefix, is
  // not a checkpoint signature: that is what the prefix is for.
  const pair = mintCheckpointKeypair();
  const undomained = Buffer.from(message.slice(CHECKPOINT_DOMAIN.length + 1), "utf8");
  const lifted = signCheckpoint({ seq: 7, hash: "a".repeat(64) }, pair.privateKey);
  assert.notEqual(lifted, null);
  assert.notEqual(lifted, undomained.toString("base64"));
});

test("a fingerprint is over the key BYTES, so both halves agree on it", () => {
  const pair = mintCheckpointKeypair();
  assert.equal(checkpointKeyFingerprint(pair.publicKey), pair.fingerprint);
  assert.equal(privateKeyFingerprint(pair.privateKey), pair.fingerprint);
  // Anything that is not an Ed25519 public key fingerprints to nothing rather
  // than to a value that could accidentally match a record.
  assert.equal(checkpointKeyFingerprint("not a key"), null);
  assert.equal(checkpointKeyFingerprint(""), null);
});

// ===========================================================================
// Appending one
// ===========================================================================

test("appendCheckpoint signs the head it read and records the fingerprint", () => {
  const home = newHome({ records: 3 });
  const before = records(home.logPath);
  const head = before[before.length - 1] as EventRecord;

  const result = appendCheckpoint(home.logPath, home.privateKey, "human:carter");
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok) throw new Error("unreachable");

  assert.equal(result.head.seq, head.seq);
  assert.equal(result.head.hash, head.hash);
  assert.equal(result.record.seq, head.seq + 1);
  assert.equal(result.fingerprint, home.fingerprint);

  const payload = readCheckpointPayload(result.record);
  assert.notEqual(payload, null);
  if (payload === null) throw new Error("unreachable");
  assert.equal(payload.seq, head.seq);
  assert.equal(payload.hash, head.hash);
  assert.equal(payload.alg, CHECKPOINT_ALG);
  assert.equal(payload.keySha256, home.fingerprint);
  assert.equal(
    verifyCheckpointSignature(
      { seq: payload.seq, hash: payload.hash },
      payload.signature,
      home.publicKey,
    ),
    true,
  );
  // The record's own hash covers the payload, so the log is self-consistent
  // about the signature it carries.
  assert.equal(verify(home.logPath).status, "clean");
});

test("appendCheckpoint refuses an agent actor, and the write boundary refuses one too", () => {
  const home = newHome({ records: 2 });
  const refused = appendCheckpoint(home.logPath, home.privateKey, "agent:claude-code");
  assert.equal(refused.ok, false);
  if (refused.ok) throw new Error("unreachable");
  assert.equal(refused.code, "actor-not-human");
  assert.match(refused.message, /left unchanged/u);
  assert.equal(records(home.logPath).length, 2, "nothing was appended");

  // And the rule is enforced a second time, independently, at the write
  // boundary: a caller reaching past `appendCheckpoint` gets the same answer
  // from `event.schema.json` rather than a checkpoint an agent authored.
  const head = records(home.logPath).at(-1) as EventRecord;
  const signature = signCheckpoint({ seq: head.seq, hash: head.hash }, home.privateKey);
  const direct = appendEvent(home.logPath, {
    ts: new Date().toISOString(),
    event: "log.checkpoint",
    actor: "agent:claude-code",
    payload: {
      seq: head.seq,
      hash: head.hash,
      alg: CHECKPOINT_ALG,
      key_sha256: home.fingerprint,
      signature: signature as string,
    },
  });
  assert.equal(direct.ok, false);
  if (direct.ok) throw new Error("unreachable");
  assert.equal(direct.error.code, "validation");
});

test("appendCheckpoint refuses an empty log and an unusable key, appending nothing", () => {
  const home = newHome({ records: 0 });
  const empty = appendCheckpoint(home.logPath, home.privateKey, "human:tester");
  assert.equal(empty.ok, false);
  if (empty.ok) throw new Error("unreachable");
  assert.equal(empty.code, "log-empty");

  appendRecord(home, "one");
  const bad = appendCheckpoint(home.logPath, "not a key at all", "human:tester");
  assert.equal(bad.ok, false);
  if (bad.ok) throw new Error("unreachable");
  assert.equal(bad.code, "checkpoint-key-unusable");
  assert.equal(records(home.logPath).length, 1);
});

test("a checkpoint's ts is stamped by the runtime, never by the caller", () => {
  // `log.checkpoint` is gate-typed: the whole content of the record is a claim
  // about a moment, so a signer who could choose the moment could backdate it.
  // The append takes no `ts` parameter at all, which is the strongest form of
  // this rule — there is nothing to pass.
  const home = newHome({ records: 2 });
  const before = Date.now();
  const record = signHead(home);
  const after_ = Date.now();
  const stamped = Date.parse(record.ts);
  assert.ok(stamped >= before - 1_000 && stamped <= after_ + 1_000, record.ts);
});

// ===========================================================================
// Verification: the happy paths
// ===========================================================================

test("a log whose checkpoints all validate passes, and names the newest", () => {
  const home = newHome({ records: 2 });
  signHead(home);
  appendRecord(home, "after-1");
  appendRecord(home, "after-2");
  const second = signHead(home);

  const outcome = check(home);
  assert.equal(outcome.status, "pass", JSON.stringify(outcome));
  if (outcome.status !== "pass") throw new Error("unreachable");
  assert.equal(outcome.checkpoints.length, 2);
  assert.equal(outcome.keys, 1);
  assert.equal(outcome.unchecked, 0);
  assert.equal(outcome.warning, null);
  assert.equal((outcome.checkpoints.at(-1) as { at: number }).at, second.seq);
});

test("a log with no checkpoints at all is a pass, not a refusal", () => {
  // Fail closed on a bad signature, fail open on an absent one. A human who has
  // been away is not a forger, and a gate that refused a log for want of a tap
  // is a gate whose operator turns the check off.
  const home = newHome({ records: 3 });
  const outcome = check(home);
  assert.equal(outcome.status, "pass", JSON.stringify(outcome));
  if (outcome.status !== "pass") throw new Error("unreachable");
  assert.equal(outcome.checkpoints.length, 0);
  assert.match(outcome.detail, /no checkpoint has been signed/u);
});

test("no configured key is a SKIP naming why, never a pass", () => {
  const home = newHome({ records: 2, keys: "none" });
  signHead(home);
  const outcome = check(home);
  assert.equal(outcome.status, "skip", JSON.stringify(outcome));
  if (outcome.status !== "skip") throw new Error("unreachable");
  assert.match(outcome.reason, /no checkpoint public key is configured/u);
  // The reason names how many records went unverified, so nobody reads the skip
  // as "there was nothing to check".
  assert.match(outcome.reason, /1 checkpoint record\(s\)/u);
});

test("an unloadable policy is a skip that says so, and never a pass", () => {
  const home = newHome({ records: 2 });
  signHead(home);
  writeFileSync(home.policyPath, "# Policy\n\n```yaml approval-policy\nversion: [\n```\n", "utf8");
  const outcome = check(home);
  assert.equal(outcome.status, "skip", JSON.stringify(outcome));
  if (outcome.status !== "skip") throw new Error("unreachable");
  assert.match(outcome.reason, /policy could not be loaded/u);
});

test("a key the policy cannot parse is a skip, not a silent pass", () => {
  // Well-formed base64 that is not an Ed25519 public key. A policy carrying it
  // still loads (the schema constrains the alphabet, not the key), so the skip
  // has to come from this check rather than from the policy layer.
  const home = newHome({ records: 2 });
  signHead(home);
  writeFileSync(home.policyPath, policyText(["QUJDREVGR0hJSktMTU5PUA=="]), "utf8");
  const outcome = check(home);
  assert.equal(outcome.status, "skip", JSON.stringify(outcome));
  if (outcome.status !== "skip") throw new Error("unreachable");
  assert.match(outcome.reason, /none of the 1 configured checkpoint key\(s\) could be read/u);
  assert.match(outcome.reason, /1 unreadable/u);
});

// ===========================================================================
// Verification: the refusals
// ===========================================================================

test("THE FORGERY: a truncated-and-recomputed chain is caught by its own checkpoint", () => {
  // The premise: the chain is unkeyed, so this forgery walks clean from
  // genesis, and on a machine that never pushed there is no committed copy for
  // the anchor check to compare against either. The signature is the only
  // witness left.
  const home = newHome({ records: 3 });
  const checkpoint = signHead(home); // signs seq 3
  appendRecord(home, "the record the forger wants gone");
  assert.equal(verify(home.logPath).status, "clean");

  // The forger truncates to seq 2 and rebuilds: a different record where seq 3
  // was, then the checkpoint record carried forward VERBATIM, because deleting
  // the one record that proves a rewrite is conspicuous and they cannot mint a
  // replacement. Everything goes through the real append path.
  const lines = readFileSync(home.logPath, "utf8").split("\n").filter((line) => line.length > 0);
  writeFileSync(home.logPath, `${lines.slice(0, 2).join("\n")}\n`, "utf8");
  appendRecord(home, "a different seq 3 entirely");
  const carried = appendEvent(home.logPath, {
    ts: checkpoint.ts,
    event: "log.checkpoint",
    actor: checkpoint.actor,
    ...(checkpoint.channel === undefined ? {} : { channel: checkpoint.channel }),
    ...(checkpoint.payload === undefined ? {} : { payload: checkpoint.payload }),
  });
  assert.equal(carried.ok, true, carried.ok ? "" : carried.error.message);

  // The premise holds: nothing inside the file contradicts the forgery.
  assert.equal(verify(home.logPath).status, "clean");

  // And the checkpoint does.
  const outcome = check(home);
  assert.equal(outcome.status, "refused", JSON.stringify(outcome));
  if (outcome.status !== "refused") throw new Error("unreachable");
  assert.equal(outcome.code, "checkpoint-hash-mismatch");
  assert.match(outcome.message, /signed a head this chain does not have/u);
  assert.match(outcome.message, /could not recompute the signature/u);
});

test("a checkpoint naming a key the policy does not list is refused", () => {
  // A refusal rather than a shrug, deliberately: if this were a skip, a forger
  // could neutralise every checkpoint in a range by rewriting its fingerprint
  // to name a key nobody carries.
  const home = newHome({ records: 2, keys: "other" });
  const record = signHead(home);
  const outcome = check(home);
  assert.equal(outcome.status, "refused", JSON.stringify(outcome));
  if (outcome.status !== "refused") throw new Error("unreachable");
  assert.equal(outcome.code, "checkpoint-key-unknown");
  assert.equal(outcome.at, record.seq);
  // The message names the rotation footgun, because the innocent cause of this
  // refusal is an operator tidying a retired key out of the policy.
  assert.match(outcome.message, /retired out of audit\.checkpoint_keys/u);
});

test("a checkpoint whose signature does not verify is refused", () => {
  const home = newHome({ records: 2 });
  const head = records(home.logPath).at(-1) as EventRecord;
  // A signature over a DIFFERENT head, presented as one over this one. The
  // fingerprint is honest and the key is listed; only the bytes are wrong.
  const wrong = signCheckpoint({ seq: head.seq, hash: "c".repeat(64) }, home.privateKey);
  const appended = appendEvent(home.logPath, {
    ts: new Date().toISOString(),
    event: "log.checkpoint",
    actor: "human:tester",
    payload: {
      seq: head.seq,
      hash: head.hash,
      alg: CHECKPOINT_ALG,
      key_sha256: home.fingerprint,
      signature: wrong as string,
    },
  });
  assert.equal(appended.ok, true, appended.ok ? "" : appended.error.message);

  const outcome = check(home);
  assert.equal(outcome.status, "refused", JSON.stringify(outcome));
  if (outcome.status !== "refused") throw new Error("unreachable");
  assert.equal(outcome.code, "checkpoint-signature-invalid");
});

test("a checkpoint that signs itself or the future is refused as out of order", () => {
  const home = newHome({ records: 2 });
  const head = records(home.logPath).at(-1) as EventRecord;
  // The record about to be written will be seq 3; this one claims to sign seq
  // 9, which did not exist when it was written. The signature is genuine, which
  // is the point: a valid signature over a head nobody had is not a checkpoint.
  const signature = signCheckpoint({ seq: 9, hash: head.hash }, home.privateKey);
  const appended = appendEvent(home.logPath, {
    ts: new Date().toISOString(),
    event: "log.checkpoint",
    actor: "human:tester",
    payload: {
      seq: 9,
      hash: head.hash,
      alg: CHECKPOINT_ALG,
      key_sha256: home.fingerprint,
      signature: signature as string,
    },
  });
  assert.equal(appended.ok, true, appended.ok ? "" : appended.error.message);

  const outcome = check(home);
  assert.equal(outcome.status, "refused", JSON.stringify(outcome));
  if (outcome.status !== "refused") throw new Error("unreachable");
  assert.equal(outcome.code, "checkpoint-out-of-order");
});

test("a malformed checkpoint payload is refused, and cannot be written here at all", () => {
  // This runtime's write boundary and its reader agree field for field, so a
  // malformed checkpoint cannot enter a log through `appendEvent`. Proved
  // first, then the reader's refusal is exercised over records that never
  // touched a file — the only honest way to reach a state this implementation
  // refuses to create.
  const home = newHome({ records: 2 });
  const head = records(home.logPath).at(-1) as EventRecord;
  const refusedAtBoundary = appendEvent(home.logPath, {
    ts: new Date().toISOString(),
    event: "log.checkpoint",
    actor: "human:tester",
    payload: { seq: head.seq, hash: head.hash, alg: CHECKPOINT_ALG },
  });
  assert.equal(refusedAtBoundary.ok, false);
  if (refusedAtBoundary.ok) throw new Error("unreachable");
  assert.equal(refusedAtBoundary.error.code, "validation");

  const walked = records(home.logPath);
  const fabricated: EventRecord = {
    ...(walked.at(-1) as EventRecord),
    seq: (walked.at(-1) as EventRecord).seq + 1,
    event: "log.checkpoint",
    payload: { seq: head.seq, hash: head.hash, alg: "hmac-sha256", key_sha256: home.fingerprint, signature: "AA==" },
  };
  const outcome = checkLogCheckpoints({
    records: [...walked, fabricated],
    publicKeys: [home.publicKey],
  });
  assert.equal(outcome.status, "refused", JSON.stringify(outcome));
  if (outcome.status !== "refused") throw new Error("unreachable");
  assert.equal(outcome.code, "checkpoint-malformed");
});

test("the checkpoints that validated ahead of a refusal are reported", () => {
  // A person reading a divergence needs to know how far the log was still good.
  const home = newHome({ records: 2 });
  signHead(home);
  appendRecord(home, "more");
  const head = records(home.logPath).at(-1) as EventRecord;
  const wrong = signCheckpoint({ seq: head.seq, hash: "d".repeat(64) }, home.privateKey);
  appendEvent(home.logPath, {
    ts: new Date().toISOString(),
    event: "log.checkpoint",
    actor: "human:tester",
    payload: {
      seq: head.seq,
      hash: head.hash,
      alg: CHECKPOINT_ALG,
      key_sha256: home.fingerprint,
      signature: wrong as string,
    },
  });

  const outcome = check(home);
  assert.equal(outcome.status, "refused", JSON.stringify(outcome));
  if (outcome.status !== "refused") throw new Error("unreachable");
  assert.equal(outcome.checkpoints.length, 1);
});

// ===========================================================================
// The cadence: a warning, never a refusal
// ===========================================================================

test("a due-but-missing checkpoint is a WARNING on a passing verdict", () => {
  const home = newHome({ records: 2, every: "1h" });
  signHead(home);
  const outcome = check(home, { now: Date.now() + 5 * 3_600_000 });
  assert.equal(outcome.status, "pass", JSON.stringify(outcome));
  if (outcome.status !== "pass") throw new Error("unreachable");
  assert.notEqual(outcome.warning, null);
  assert.match(outcome.warning ?? "", /nothing is refused/u);
});

test("a log that has never been checkpointed under a cadence warns too", () => {
  const home = newHome({ records: 2, every: "1h" });
  const outcome = check(home, { now: Date.now() + 5 * 3_600_000 });
  assert.equal(outcome.status, "pass", JSON.stringify(outcome));
  if (outcome.status !== "pass") throw new Error("unreachable");
  assert.match(outcome.warning ?? "", /never been checkpointed/u);
});

test("a cadence that is met says nothing, and no cadence says nothing ever", () => {
  const met = newHome({ records: 2, every: "24h" });
  signHead(met);
  const metOutcome = check(met);
  assert.equal(metOutcome.status, "pass");
  if (metOutcome.status !== "pass") throw new Error("unreachable");
  assert.equal(metOutcome.warning, null);

  const off = newHome({ records: 2 });
  const offOutcome = check(off, { now: Date.now() + 400 * 24 * 3_600_000 });
  assert.equal(offOutcome.status, "pass");
  if (offOutcome.status !== "pass") throw new Error("unreachable");
  assert.equal(offOutcome.warning, null);
});

// ===========================================================================
// The CLI
// ===========================================================================

test("approval log checkpoint signs the head from a key file, and verify accepts it", () => {
  const home = newHome({ records: 3 });
  const signed = runCli(
    ["log", "checkpoint", "--as", "human:carter", "--key-file", home.keyPath, "--json"],
    home.dir,
  );
  assert.equal(signed.code, 0, signed.stderr);
  const body = JSON.parse(signed.stdout) as {
    ok: boolean;
    seq: number;
    signed: { seq: number; hash: string };
    key_sha256: string;
  };
  assert.equal(body.ok, true);
  assert.equal(body.signed.seq, 3);
  assert.equal(body.key_sha256, home.fingerprint);

  const verified = runCli(["log", "verify", "--checkpoints", "--json"], home.dir);
  assert.equal(verified.code, 0, verified.stderr);
  const report = JSON.parse(verified.stdout) as {
    status: string;
    checkpoints: { status: string; verified: number; keys: number };
  };
  assert.equal(report.status, "clean");
  assert.equal(report.checkpoints.status, "pass");
  assert.equal(report.checkpoints.verified, 1);
  assert.equal(report.checkpoints.keys, 1);
});

test("approval log checkpoint is human-only at the CLI edge", () => {
  const home = newHome({ records: 2 });
  const refused = runCli(
    ["log", "checkpoint", "--as", "agent:claude-code", "--key-file", home.keyPath, "--json"],
    home.dir,
  );
  assert.equal(refused.code, 2, refused.stdout);
  assert.match(refused.stderr, /human-only/u);
  assert.equal(records(home.logPath).length, 2);
});

test("approval log checkpoint says which key source failed and appends nothing", () => {
  const home = newHome({ records: 2 });
  const refused = runCli(
    ["log", "checkpoint", "--as", "human:carter", "--key-file", join(home.dir, "nope.key"), "--json"],
    home.dir,
  );
  assert.equal(refused.code, 4, refused.stdout);
  const body = JSON.parse(refused.stderr) as { error: { code: string; message: string } };
  assert.equal(body.error.code, "checkpoint-key-unreadable");
  assert.match(body.error.message, /nothing was appended/u);
  assert.equal(records(home.logPath).length, 2);
});

test("approval log verify --checkpoints refuses a forged chain at EXIT_INTEGRITY", () => {
  const home = newHome({ records: 3 });
  const checkpoint = signHead(home);
  appendRecord(home, "the record the forger wants gone");

  const lines = readFileSync(home.logPath, "utf8").split("\n").filter((line) => line.length > 0);
  writeFileSync(home.logPath, `${lines.slice(0, 2).join("\n")}\n`, "utf8");
  appendRecord(home, "a different seq 3 entirely");
  appendEvent(home.logPath, {
    ts: checkpoint.ts,
    event: "log.checkpoint",
    actor: checkpoint.actor,
    ...(checkpoint.channel === undefined ? {} : { channel: checkpoint.channel }),
    ...(checkpoint.payload === undefined ? {} : { payload: checkpoint.payload }),
  });

  // The plain verdict is still clean. That is the premise, not a bug.
  const plain = runCli(["log", "verify", "--json"], home.dir);
  assert.equal(plain.code, 0, plain.stderr);
  assert.equal((JSON.parse(plain.stdout) as { status: string }).status, "clean");

  const withCheckpoints = runCli(["log", "verify", "--checkpoints", "--json"], home.dir);
  assert.equal(withCheckpoints.code, 1, withCheckpoints.stdout);
  const report = JSON.parse(withCheckpoints.stdout) as {
    status: string;
    checkpoints: { status: string; code: string; at: number };
  };
  assert.equal(report.status, "checkpoint-invalid");
  assert.equal(report.checkpoints.code, "checkpoint-hash-mismatch");
});

test("verify without --checkpoints says nothing about them at all", () => {
  // Additive, in the strict sense the frozen --json shapes require: a consumer
  // that never asked sees byte-identical output to the one it was written for.
  const home = newHome({ records: 2 });
  signHead(home);
  const plain = runCli(["log", "verify", "--json"], home.dir);
  assert.equal(plain.code, 0, plain.stderr);
  assert.equal(Object.hasOwn(JSON.parse(plain.stdout) as object, "checkpoints"), false);
});

test("a missing key reaches the CLI as a skip on stderr, and exit 0", () => {
  const home = newHome({ records: 2, keys: "none" });
  const run = runCli(["log", "verify", "--checkpoints"], home.dir);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /^clean:/u);
  assert.match(run.stderr, /checkpoints skipped/u);
});

// ===========================================================================
// The daemon
// ===========================================================================

async function runDaemon(home: Home): Promise<{ events: DaemonEvent[]; kind: string }> {
  const events: DaemonEvent[] = [];
  const daemon = new Daemon({
    logPath: home.logPath,
    tasksDir: join(home.dir, "backlog", "tasks"),
    queuePath: join(home.dir, ".approval", "QUEUE.md"),
    policy: { file: home.policyPath },
    cwd: home.dir,
    intervalMs: 60_000,
    debounceMs: 10,
    once: true,
    // The anchor check is off: these homes are not git repositories, so it
    // would skip on every tick, and the point here is the OTHER witness.
    anchor: { enabled: false },
    sink: { emit: (event) => events.push(event) },
  });
  const outcome = await daemon.run();
  return { events, kind: outcome.kind };
}

test("daemon: the tick reports the checkpoint check it made on the full re-proof", async () => {
  const home = newHome({ records: 2 });
  signHead(home);
  const run = await runDaemon(home);
  assert.equal(run.kind, "stopped");
  const tick = run.events.find((event) => event.event === "tick");
  assert.ok(tick !== undefined && tick.event === "tick");
  // APRV-257 added `due`: the daemon's half of the cadence, read from the same
  // rule the channel prompt is enqueued from. This fixture declares no
  // `audit.checkpoint_every`, so nothing is owed and nothing would be offered.
  assert.deepEqual(tick.checkpoints, { status: "pass", verified: 1, keys: 1, due: false });
});

test("daemon: a forged chain stops the loop with checkpoint-invalid", async () => {
  const home = newHome({ records: 3 });
  const checkpoint = signHead(home);
  appendRecord(home, "the record the forger wants gone");
  const lines = readFileSync(home.logPath, "utf8").split("\n").filter((line) => line.length > 0);
  writeFileSync(home.logPath, `${lines.slice(0, 2).join("\n")}\n`, "utf8");
  appendRecord(home, "a different seq 3 entirely");
  appendEvent(home.logPath, {
    ts: checkpoint.ts,
    event: "log.checkpoint",
    actor: checkpoint.actor,
    ...(checkpoint.channel === undefined ? {} : { channel: checkpoint.channel }),
    ...(checkpoint.payload === undefined ? {} : { payload: checkpoint.payload }),
  });
  assert.equal(verify(home.logPath).status, "clean");

  const run = await runDaemon(home);
  assert.equal(run.kind, "checkpoint-invalid");
  // Distinct from log-corrupt and from anchor-diverged on purpose: the three
  // name three different witnesses, and an operator's first question is which
  // one disagrees.
  assert.notEqual(run.kind, "log-corrupt");
});

test("daemon: a due-but-missing checkpoint warns and never stops the loop", async () => {
  const home = newHome({ records: 2, every: "1ms" });
  signHead(home);
  const run = await runDaemon(home);
  assert.equal(run.kind, "stopped");
  const warning = run.events.find(
    (event) => event.event === "warning" && event.code === "checkpoint-due",
  );
  assert.ok(warning !== undefined, "no checkpoint-due warning was emitted");
});

test("daemon: no configured key is a skip on the tick line, never a pass", async () => {
  const home = newHome({ records: 2, keys: "none" });
  signHead(home);
  const run = await runDaemon(home);
  assert.equal(run.kind, "stopped");
  const tick = run.events.find((event) => event.event === "tick");
  assert.ok(tick !== undefined && tick.event === "tick");
  assert.equal(tick.checkpoints?.status, "skip");
});
