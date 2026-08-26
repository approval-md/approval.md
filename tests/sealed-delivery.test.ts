/**
 * Sealed token delivery, end to end (amended SPEC.md §6.3, §10.4, §11.1 —
 * APRV-105).
 *
 * The claim under test is a handover, not an authorization: `approval wait` can
 * hand the raw execution token back to the process that opened the request,
 * across machines, without weakening anything that makes the action human-gated.
 * So the suite is organised around what must change and what must not.
 *
 * MUST NOT change, and pinned here byte for byte: under the default
 * `token_delivery: manual`, no key is minted, no field is added to any record,
 * and `wait --json` returns exactly the object it always returned.
 *
 * MUST change, under `sealed`: the request publishes an address, the grant
 * carries ciphertext, `wait --json` returns the token, `approval run` spends it
 * with no `--token`, and the key file is gone at consume, at expiry and at
 * revocation.
 *
 * The cross-machine test is the one that matters most, and it is built the way
 * the deployment is: two working directories, each with its own `.approval`
 * home, and the log copied between them exactly as `git pull` would copy it.
 * Nothing is faked — A really does hold a private key B never sees, and B really
 * does seal to a public key it read out of the log.
 *
 * Every record comes from the real append path, and every scenario that writes
 * ends by walking the chain.
 */

import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { main } from "../src/cli/main.js";
import type { EventRecord } from "../src/core/log.js";
import { runPayloadHash } from "../src/core/payload.js";
import {
  asSealedToken,
  isRecipientKey,
  keyPath,
  keyStoreDirFor,
  mintRecipientKeypair,
  openSealedToken,
  RECIPIENT_KEY_FIELD,
  sealToken,
  SEALED_TOKEN_FIELD,
} from "../src/core/seal.js";
import { verify } from "../src/core/verify.js";
import { appendAttestation, decide, expire, register, request } from "./clock-adapters.js";

const scratch = mkdtempSync(join(tmpdir(), "approval-md-sealed-"));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const T0 = "2026-08-05T10:00:00.000Z";

function at(minutes: number): string {
  return new Date(Date.parse(T0) + minutes * 60_000).toISOString();
}

const KEY = "task-042:chaser";

/**
 * The content binding for the one command these scenarios execute (`true`, no
 * arguments, in the machine's own directory). `approval run` recomputes this
 * from the argv and cwd it is about to spawn (APRV-140), so the declaration and
 * the `--payload-hash` flag must both carry the recomputed value, and the value
 * is per machine because the cwd is.
 */
function boundFor(unit: Machine): string {
  return runPayloadHash(["true"], unit.dir);
}

/**
 * The policy under test.
 *
 * `ttl` is off by default because most of these scenarios drive the CLI, which
 * reads the REAL clock while the core writers here are given a frozen one: a
 * policy with a TTL would lapse every request between the two. The one test that
 * needs a lapse asks for it.
 */
function policyText(delivery: "manual" | "sealed", ttl = false): string {
  return [
    "# Policy",
    "",
    "```yaml approval-policy",
    'version: "0.1"',
    "defaults:",
    "  autonomy: manual",
    ...(ttl ? ['  approval_ttl: "1h"', "  on_expiry: reject"] : []),
    ...(delivery === "sealed" ? ["  token_delivery: sealed"] : []),
    "```",
    "",
  ].join("\n");
}

function envelopeFor(unit: Machine): Record<string, unknown> {
  return {
    origin: { app: "example-capture", created_by: "human:carter" },
    state: "proposed",
    actions: [
      {
        class: "communicate.email.external",
        summary: "Send deposit chaser",
        reversible: false,
        est_cost_usd: "0.02",
        idempotency_key: KEY,
        payload_hash: boundFor(unit),
      },
    ],
  };
}

interface Machine {
  dir: string;
  logPath: string;
  policyPath: string;
  keyDir: string;
  options: { policy: { file: string } };
}

/**
 * One machine: its own working directory, its own `.approval` home, its own key
 * store. `logPath` may be shared with another machine by copying the file.
 */
function newMachine(delivery: "manual" | "sealed", label = "m", ttl = false): Machine {
  counter += 1;
  const dir = join(scratch, `${label}-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  const policyPath = join(dir, "APPROVAL.md");
  writeFileSync(policyPath, policyText(delivery, ttl), "utf8");
  const logPath = join(dir, ".approval", "log", "events.jsonl");
  return { dir, logPath, policyPath, keyDir: keyStoreDirFor(logPath), options: { policy: { file: policyPath } } };
}

function ready(delivery: "manual" | "sealed", label = "m", ttl = false): Machine {
  const unit = newMachine(delivery, label, ttl);
  assert.equal(
    appendAttestation(unit.logPath, unit.policyPath, "human:carter", T0).ok,
    true,
    "attestation append failed",
  );
  const registered = register(
    unit.logPath,
    { task: "task-042", envelope: envelopeFor(unit) },
    T0,
    "agent:claude",
  );
  assert.equal(registered.ok, true, registered.ok ? "" : registered.message);
  return unit;
}

function ask(unit: Machine, minutes = 1) {
  return request(
    unit.logPath,
    {
      task: "task-042",
      actionKey: KEY,
      cls: "communicate.email.external",
      est_cost_usd: "0.02",
      reversible: false,
      summary: "Send deposit chaser",
    },
    at(minutes),
    "agent:claude",
    unit.options,
  );
}

function records(unit: Machine): EventRecord[] {
  try {
    return readFileSync(unit.logPath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as EventRecord);
  } catch {
    return [];
  }
}

function payloadOf(record: EventRecord | undefined): Record<string, unknown> {
  const payload = record?.payload;
  return typeof payload === "object" && payload !== null ? payload : {};
}

function find(unit: Machine, event: string): EventRecord | undefined {
  return records(unit).find((record) => record.event === event);
}

function assertClean(unit: Machine): void {
  const result = verify(unit.logPath);
  assert.equal(result.status, "clean", `log not clean: ${JSON.stringify(result)}`);
}

function runCli(unit: Machine, argv: string[]): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  // `--log` goes before any `--` separator: what follows the separator is the
  // child argv, and `approval run` hashes exactly those bytes (APRV-140).
  const code = main([argv[0] ?? "", "--log", unit.logPath, ...argv.slice(1)], {
    cwd: unit.dir,
    streams: {
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
    },
  });
  return { code, out, err };
}

/** Copy the whole log from one machine to another, as `git pull` would. */
function sync(from: Machine, to: Machine): void {
  mkdirSync(dirname(to.logPath), { recursive: true });
  copyFileSync(from.logPath, to.logPath);
}

// ===========================================================================
// The default: manual delivery changes nothing (AC 4)
// ===========================================================================

test("under token_delivery: manual nothing is minted, written, or added", () => {
  const unit = ready("manual");
  assert.equal(ask(unit).ok, true);
  const granted = decide(unit.logPath, KEY, "grant", "human:carter", at(2), unit.options);
  assert.equal(granted.ok, true);
  if (!granted.ok) return;

  // The request's payload: exactly the pre-APRV-105 field set, in the same
  // order. A new key here would be a record that changed under an operator who
  // never opted into anything.
  assert.deepEqual(Object.keys(payloadOf(find(unit, "approval.requested"))), [
    "class",
    "est_cost_usd",
    "payload_hash",
    "policy_sha256",
    "reversible",
    "summary",
  ]);
  // The grant's payload: likewise.
  assert.deepEqual(Object.keys(payloadOf(find(unit, "approval.granted"))), [
    "class",
    "est_cost_usd",
    "payload_hash",
    "policy_sha256",
    "token_sha256",
  ]);

  // No key store exists at all. Not an empty directory: nothing was created.
  assert.equal(existsSync(unit.keyDir), false, "a key store appeared under manual delivery");
  assertClean(unit);
});

test("under manual delivery wait --json returns the object it always returned", () => {
  const unit = ready("manual");
  assert.equal(ask(unit).ok, true);
  assert.equal(decide(unit.logPath, KEY, "grant", "human:carter", at(2), unit.options).ok, true);

  const waited = runCli(unit, ["wait", "task-042", "--timeout", "1s", "--json"]);
  assert.equal(waited.code, 0, waited.err);
  const body = JSON.parse(waited.out) as {
    ok: boolean;
    status: string;
    actions: Array<Record<string, unknown>>;
  };
  assert.equal(body.status, "granted");
  assert.deepEqual(Object.keys(body.actions[0] ?? {}), ["action_key", "state", "seq"]);
});

// ===========================================================================
// The seal itself (AC 2)
// ===========================================================================

test("a seal opens only with the right private key and the right action key", () => {
  const recipient = mintRecipientKeypair();
  const stranger = mintRecipientKeypair();
  const token = "f".repeat(64);

  const sealed = sealToken(token, recipient.publicKey, KEY);
  assert.notEqual(sealed, null);
  if (sealed === null) return;

  assert.equal(openSealedToken(sealed, recipient.privateKey, KEY), token);
  assert.equal(openSealedToken(sealed, stranger.privateKey, KEY), null);
  assert.equal(openSealedToken(sealed, recipient.privateKey, "task-042:other"), null);

  // A tampered ciphertext does not open either: AES-GCM is authenticated, so a
  // flipped bit is a refusal rather than garbage that looks like a token.
  const flipped = { ...sealed, ct: Buffer.from("nope", "utf8").toString("base64") };
  assert.equal(openSealedToken(flipped, recipient.privateKey, KEY), null);

  // Two seals of one token differ: the ephemeral key and the nonce are fresh.
  const again = sealToken(token, recipient.publicKey, KEY);
  assert.notEqual(again, null);
  assert.notEqual(again?.ct, sealed.ct);
  assert.notEqual(again?.epk, sealed.epk);
  assert.notEqual(again?.nonce, sealed.nonce);

  // A recipient key that is not a key drops the seal rather than throwing: a
  // human's grant must never be voidable by a malformed delivery address.
  assert.equal(sealToken(token, "not-a-key", KEY), null);
  assert.equal(asSealedToken({ alg: "something-else" }), null);
});

test("the private key is written 0600 and the key store is not world-readable", () => {
  const unit = ready("sealed");
  assert.equal(ask(unit).ok, true);

  const path = keyPath(unit.keyDir, KEY);
  assert.equal(existsSync(path), true, "no private key was written");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(unit.keyDir).mode & 0o777, 0o700);
  // The file name reads as the action key, which the key store's directory
  // listing is worth nothing without.
  assert.match(path, /task-042:chaser\.key$/u);
  assertClean(unit);
});

// ===========================================================================
// The lifecycle of a key file (AC 3)
// ===========================================================================

test("the key file is unlinked when the token is spent", () => {
  const unit = ready("sealed");
  assert.equal(ask(unit).ok, true);
  const granted = decide(unit.logPath, KEY, "grant", "human:carter", at(2), unit.options);
  assert.equal(granted.ok, true);
  assert.equal(existsSync(keyPath(unit.keyDir, KEY)), true);

  // No --token: `approval run` opens the seal with the local key.
  const ran = runCli(unit, [
    "run",
    KEY,
    "--as",
    "agent:claude",
    "--policy",
    unit.policyPath,
    "--payload-hash",
    boundFor(unit),
    "--",
    "true",
  ]);
  assert.equal(ran.code, 0, `${ran.out}${ran.err}`);
  assert.equal(
    existsSync(keyPath(unit.keyDir, KEY)),
    false,
    "the key outlived the token it delivered",
  );
  assert.notEqual(find(unit, "execution.started"), undefined);
  assertClean(unit);
});

test("the key file is unlinked when the grant is revoked", () => {
  const unit = ready("sealed");
  assert.equal(ask(unit).ok, true);
  assert.equal(decide(unit.logPath, KEY, "grant", "human:carter", at(2), unit.options).ok, true);
  assert.equal(existsSync(keyPath(unit.keyDir, KEY)), true);

  assert.equal(decide(unit.logPath, KEY, "revoke", "human:carter", at(3), unit.options).ok, true);
  assert.equal(existsSync(keyPath(unit.keyDir, KEY)), false);
  assertClean(unit);
});

test("the key file is unlinked when the request expires", () => {
  const unit = ready("sealed", "expiring", true);
  assert.equal(ask(unit).ok, true);
  assert.equal(existsSync(keyPath(unit.keyDir, KEY)), true);

  // Past the policy's 1h TTL: the request lapses and can never be granted, so
  // the key that would have opened its token opens nothing.
  const expired = expire(unit.logPath, KEY, at(120), unit.options);
  assert.equal(expired.ok, true, expired.ok ? "" : expired.message);
  assert.equal(existsSync(keyPath(unit.keyDir, KEY)), false);
  assertClean(unit);
});

// ===========================================================================
// Across machines, with the log synced (AC 5)
// ===========================================================================

test("request on A, grant on B, wait and run on A: the token never crosses in clear", () => {
  const a = ready("sealed", "machine-a");
  const b = newMachine("sealed", "machine-b");

  // A opens the request. The private key lands in A's key store and nowhere
  // else; the public half rides the log.
  assert.equal(ask(a).ok, true);
  assert.equal(existsSync(keyPath(a.keyDir, KEY)), true);
  const recipient = payloadOf(find(a, "approval.requested"))[RECIPIENT_KEY_FIELD];
  assert.equal(isRecipientKey(recipient), true);

  // The log travels. This is the whole of the transport between the machines.
  sync(a, b);
  assert.equal(existsSync(keyPath(b.keyDir, KEY)), false, "B must not hold A's private key");

  // B grants, through the CLI, as a human would. The raw token is still printed
  // once on the granting surface: the paste path is preserved, not replaced.
  const grantOut = runCli(b, ["grant", KEY, "--as", "human:carter", "--policy", b.policyPath]);
  assert.equal(grantOut.code, 0, grantOut.err);
  const printed = /\b([a-f0-9]{64})\b/u.exec(grantOut.out)?.[1];
  assert.notEqual(printed, undefined, "the granting surface printed no token");

  const sealed = asSealedToken(payloadOf(find(b, "approval.granted"))[SEALED_TOKEN_FIELD]);
  assert.notEqual(sealed, null, "B did not seal to the key it read from the log");

  // The log travels back.
  sync(b, a);

  // A waits, and gets its token — with no paste, and from a process that never
  // saw B's stdout.
  const waited = runCli(a, ["wait", "task-042", "--timeout", "1s", "--json"]);
  assert.equal(waited.code, 0, waited.err);
  const body = JSON.parse(waited.out) as { actions: Array<{ token?: string; state: string }> };
  const delivered = body.actions[0];
  assert.equal(delivered?.state, "granted");
  assert.equal(delivered?.token, printed, "wait returned a different token than B minted");

  // …and spends it, with no --token flag anywhere.
  const ran = runCli(a, [
    "run",
    KEY,
    "--as",
    "agent:claude",
    "--policy",
    a.policyPath,
    "--payload-hash",
    boundFor(a),
    "--",
    "true",
  ]);
  assert.equal(ran.code, 0, `${ran.out}${ran.err}`);
  assert.equal(existsSync(keyPath(a.keyDir, KEY)), false);

  // The shared file — the one artifact both machines really saw — never carried
  // the token in clear, and never carried A's private key.
  const shared = readFileSync(a.logPath, "utf8");
  assert.equal(shared.includes(printed ?? "never"), false, "the RAW TOKEN crossed in clear");
  assertClean(a);

  // And a second machine holding the whole log still cannot open the seal.
  assert.notEqual(sealed, null);
  if (sealed === null) return;
  const outsider = mintRecipientKeypair();
  assert.equal(openSealedToken(sealed, outsider.privateKey, KEY), null);
});

test("a machine that did not open the request gets no token from wait", () => {
  const a = ready("sealed", "owner");
  const b = newMachine("sealed", "onlooker");
  assert.equal(ask(a).ok, true);
  sync(a, b);
  assert.equal(runCli(b, ["grant", KEY, "--as", "human:carter", "--policy", b.policyPath]).code, 0);

  // B has the whole log, including the ciphertext, and no key. `wait` reports
  // the decision and returns no token — the same answer it gives under manual
  // delivery, which is the point: a missing key is not an error, it is simply
  // not this machine's token.
  const waited = runCli(b, ["wait", "task-042", "--timeout", "1s", "--json"]);
  assert.equal(waited.code, 0, waited.err);
  const body = JSON.parse(waited.out) as { actions: Array<Record<string, unknown>> };
  assert.deepEqual(Object.keys(body.actions[0] ?? {}), ["action_key", "state", "seq"]);
  assertClean(b);
});

test("the human render never prints the token, whatever the delivery mode is", () => {
  const unit = ready("sealed");
  assert.equal(ask(unit).ok, true);
  const granted = decide(unit.logPath, KEY, "grant", "human:carter", at(2), unit.options);
  assert.equal(granted.ok, true);
  if (!granted.ok || granted.token === undefined) return;

  // `wait` without `--json` writes to a terminal, and a token on a terminal is
  // the paste this feature exists to remove.
  const waited = runCli(unit, ["wait", "task-042", "--timeout", "1s"]);
  assert.equal(waited.code, 0, waited.err);
  assert.equal(waited.out.includes(granted.token), false, "the human render printed the token");
});
