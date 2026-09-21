/**
 * Hosted-daemon identity (APRV-383).
 *
 * Every log in this file is built through the REAL append path, and every
 * refusal is taken from it: the whole claim of the task is that the stamp and the
 * allowlist live at the write boundary, so a suite that exercised them through a
 * helper would be testing a different boundary. Nothing here hand-writes a
 * record.
 *
 * The four properties under test, in the order the acceptance criteria state
 * them:
 *
 * 1. an id is declared or derived, and the derived one is stable for one machine
 *    and keystore (it is a function of the instance home, which is what
 *    `keychain-scope` scopes the keystore items by);
 * 2. every record a declaring daemon process appends carries it, and a record
 *    written before the field existed is untouched;
 * 3. an attested `daemons` list refuses an unlisted id at the write boundary with
 *    nothing written, and an absent list restricts nothing;
 * 4. the field never widens anything: it cannot be claimed by a caller, it is
 *    covered by the record's own chain hash, and a listed id gains nothing.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";

import { appendAttestation } from "../src/core/attest.js";
import { clearDaemonProcess, markDaemonProcess } from "../src/core/daemon-actor.js";
import {
  DERIVED_DAEMON_ID_PREFIX,
  daemonAllowlistOf,
  declareDaemonIdentityFor,
  derivedDaemonId,
  refreshDaemonAllowlist,
  resolveDaemonAllowlist,
  resolveDaemonId,
} from "../src/core/daemon-host.js";
import {
  DAEMON_ID_ENV,
  DAEMON_ID_MAX_LENGTH,
  clearDaemonIdentity,
  daemonIdentity,
  isDaemonId,
} from "../src/core/daemon-identity.js";
import { instanceIdFor } from "../src/core/instance.js";
import { appendEvent, verifyRecordHash, type EventInput, type EventRecord } from "../src/core/log.js";
import { loadPolicy } from "../src/core/policy-load.js";
import { readVerifiedRecords } from "../src/core/state.js";
import { verify } from "../src/core/verify.js";

const scratch = mkdtempSync(join(tmpdir(), "approval-md-daemon-identity-"));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

afterEach(() => {
  // Module state, so a case that leaves this process marked would make the next
  // case's plain append a daemon's. Both are cleared, and clearing is always the
  // stricter direction: an unmarked process stamps nothing.
  clearDaemonIdentity();
  clearDaemonProcess();
});

/** A fresh instance: `<case>/.approval/log/events.jsonl`. */
function freshInstance(): { logPath: string; dir: string } {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(join(dir, ".approval", "log"), { recursive: true });
  return { logPath: join(dir, ".approval", "log", "events.jsonl"), dir };
}

const DRIFT: EventInput = {
  ts: "2026-09-20T11:04:19Z",
  event: "envelope.drift",
  actor: "system:daemon",
  task: "task-311",
  payload: { file: "backlog/tasks/task-311.md", reason: "state-mismatch" },
};

/** The policy text, with `daemons` written exactly as an operator would. */
function policyText(daemons: readonly string[] | null): string {
  return [
    "# Policy",
    "",
    "```yaml approval-policy",
    'version: "0.1"',
    "defaults:",
    "  autonomy: manual",
    ...(daemons === null
      ? []
      : ["daemons:", ...daemons.map((id) => `  - ${id}`)]),
    "classes:",
    "  read.*:",
    "    autonomy: autonomous",
    "```",
    "",
  ].join("\n");
}

/** Write `APPROVAL.md` into `dir` and attest it through the real append path. */
function writePolicy(dir: string, logPath: string, daemons: readonly string[] | null): string {
  const policyPath = join(dir, "APPROVAL.md");
  writeFileSync(policyPath, policyText(daemons), "utf8");
  return policyPath;
}

function attest(logPath: string, policyPath: string, ts: string): void {
  const appended = appendAttestation(logPath, policyPath, "human:carter", {
    clock: () => ts,
  });
  assert.equal(appended.ok, true, JSON.stringify(appended));
}

function recordsOf(logPath: string): EventRecord[] {
  const read = readVerifiedRecords(logPath);
  assert.equal(read.ok, true, read.ok ? "" : read.code);
  return read.ok ? [...read.records] : [];
}

function lines(logPath: string): string[] {
  const text = readFileSync(logPath, "utf8");
  return text.length === 0 ? [] : text.trimEnd().split("\n");
}

// ---------------------------------------------------------------------------
// AC1 — the id is declared or derived, and the derived one is stable
// ---------------------------------------------------------------------------

test("the derived id is the instance id `keychain-scope` names, prefixed", () => {
  const { logPath } = freshInstance();
  assert.equal(derivedDaemonId(logPath), `${DERIVED_DAEMON_ID_PREFIX}${instanceIdFor(logPath)}`);
  // Stability is the criterion: the derivation reads a path and nothing else, so
  // a restart, a rebuilt container and a second process in the same checkout all
  // land on one id, with nothing stored anywhere to be copied or lost.
  assert.equal(derivedDaemonId(logPath), derivedDaemonId(logPath));
  const other = freshInstance();
  assert.notEqual(derivedDaemonId(other.logPath), derivedDaemonId(logPath));
});

test("an id declared in the launch environment wins, and a blank one is unset", () => {
  const { logPath } = freshInstance();
  const declared = resolveDaemonId(logPath, { [DAEMON_ID_ENV]: "village-goa-1" });
  assert.deepEqual(declared, { ok: true, id: "village-goa-1", source: "environment" });

  for (const blank of ["", "   "]) {
    const resolved = resolveDaemonId(logPath, { [DAEMON_ID_ENV]: blank });
    assert.deepEqual(resolved, { ok: true, id: derivedDaemonId(logPath), source: "derived" });
  }
  assert.deepEqual(resolveDaemonId(logPath, {}), {
    ok: true,
    id: derivedDaemonId(logPath),
    source: "derived",
  });
});

test("an unusable declared id is refused and never silently replaced", () => {
  const { logPath } = freshInstance();
  for (const bad of [
    "Village-Goa-1",
    "-leading-dash",
    "has space",
    "new\nline",
    "sh; rm -rf /",
    "a".repeat(DAEMON_ID_MAX_LENGTH + 1),
  ]) {
    const resolved = resolveDaemonId(logPath, { [DAEMON_ID_ENV]: bad });
    assert.equal(resolved.ok, false, bad);
    if (!resolved.ok) {
      assert.equal(resolved.code, "daemon-id-invalid");
      assert.equal(resolved.declared, bad);
      // Never the derived id: a runtime that substituted one would write records
      // under a name nobody chose, checked against a list nobody wrote for it.
      assert.equal(resolved.message.includes(derivedDaemonId(logPath)), true);
    }
  }
  for (const good of ["a", "daemon-3f2a9c11", "village.goa_1-2", "a".repeat(DAEMON_ID_MAX_LENGTH)]) {
    assert.equal(isDaemonId(good), true, good);
  }
});

// ---------------------------------------------------------------------------
// AC2 — every record a daemon appends carries the id
// ---------------------------------------------------------------------------

test("a daemon process stamps its id onto every record it appends", () => {
  const { logPath } = freshInstance();
  markDaemonProcess();
  declareDaemonIdentityFor(logPath, { [DAEMON_ID_ENV]: "village-goa-1" });

  const first = appendEvent(logPath, DRIFT);
  assert.equal(first.ok, true);
  const second = appendEvent(logPath, { ...DRIFT, ts: "2026-09-20T11:05:19Z" });
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;

  assert.equal(first.record.daemon, "village-goa-1");
  assert.equal(second.record.daemon, "village-goa-1");
  // Through the file, not only through the return value: the field is on the
  // line, and the line is what a tenant reads.
  for (const line of lines(logPath)) {
    assert.equal((JSON.parse(line) as EventRecord).daemon, "village-goa-1");
  }
  // And it is part of what the chain protects. A provenance field the hash did
  // not cover could be edited in place without breaking anything.
  assert.equal(verifyRecordHash(first.record), true);
  assert.equal(verifyRecordHash({ ...first.record, daemon: "someone-else" }), false);
  assert.equal(verify(logPath).status, "clean");
});

test("a record written by anything that is not a declaring daemon carries no id", () => {
  const { logPath } = freshInstance();
  // The pre-APRV-383 shape, which is also every session's, every hook's and
  // every human's: absence means nothing about this record says a daemon wrote
  // it, and it is never read as a claim that none did.
  const plain = appendEvent(logPath, DRIFT);
  assert.equal(plain.ok, true);
  if (plain.ok) assert.equal("daemon" in plain.record, false);

  // A process that marked itself and declared nothing is that same daemon: an
  // undeclared mark must not turn into a dead log.
  markDaemonProcess();
  const marked = appendEvent(logPath, { ...DRIFT, ts: "2026-09-20T11:06:19Z" });
  assert.equal(marked.ok, true);
  if (marked.ok) assert.equal("daemon" in marked.record, false);
});

test("a caller cannot claim to be a daemon by putting the field on its input", () => {
  const { logPath } = freshInstance();
  // Not a daemon process, and the input carries the property anyway. `EventInput`
  // has no such member, so this is a cast: the point is what the runtime does
  // with bytes a caller wrote, not what the type system says about them.
  const claimed = appendEvent(logPath, {
    ...DRIFT,
    daemon: "village-goa-1",
  } as unknown as EventInput);
  assert.equal(claimed.ok, true);
  if (claimed.ok) assert.equal("daemon" in claimed.record, false);
  assert.equal(lines(logPath).some((line) => line.includes("village-goa-1")), false);
});

// ---------------------------------------------------------------------------
// AC3 — the allowlist, through the real append path
// ---------------------------------------------------------------------------

test("an absent `daemons` list is no restriction", () => {
  const { logPath, dir } = freshInstance();
  const policyPath = writePolicy(dir, logPath, null);
  attest(logPath, policyPath, "2026-09-20T11:00:00Z");

  markDaemonProcess();
  declareDaemonIdentityFor(logPath, {});
  const resolution = refreshDaemonAllowlist(recordsOf(logPath), loadPolicy({ file: policyPath }));
  assert.deepEqual(resolution, { ok: true, allowed: null });

  const appended = appendEvent(logPath, DRIFT);
  assert.equal(appended.ok, true);
  if (appended.ok) assert.equal(appended.record.daemon, derivedDaemonId(logPath));
});

test("a listed id may write, and being listed grants it nothing else", () => {
  const { logPath, dir } = freshInstance();
  markDaemonProcess();
  declareDaemonIdentityFor(logPath, { [DAEMON_ID_ENV]: "village-goa-1" });
  const policyPath = writePolicy(dir, logPath, ["village-goa-1", "village-goa-2"]);
  attest(logPath, policyPath, "2026-09-20T11:00:00Z");
  refreshDaemonAllowlist(recordsOf(logPath), loadPolicy({ file: policyPath }));

  const appended = appendEvent(logPath, DRIFT);
  assert.equal(appended.ok, true);
  if (!appended.ok) return;
  // The record is the record it would have been with no list at all. Nothing
  // about the grant, the class, the actor or the payload moved, which is the
  // whole of "a listed id gains nothing" that a test can see.
  assert.equal(appended.record.daemon, "village-goa-1");
  assert.equal(appended.record.actor, DRIFT.actor);
  assert.deepEqual(appended.record.payload, DRIFT.payload);
});

test("an unlisted id is refused at the write boundary with nothing written", () => {
  const { logPath, dir } = freshInstance();
  markDaemonProcess();
  declareDaemonIdentityFor(logPath, { [DAEMON_ID_ENV]: "village-goa-9" });
  const policyPath = writePolicy(dir, logPath, ["village-goa-1"]);
  attest(logPath, policyPath, "2026-09-20T11:00:00Z");
  refreshDaemonAllowlist(recordsOf(logPath), loadPolicy({ file: policyPath }));

  const before = readFileSync(logPath, "utf8");
  const refused = appendEvent(logPath, DRIFT);
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.error.code, "daemon-not-allowed");
    assert.equal(refused.error.message.includes("village-goa-9"), true);
    assert.equal(refused.error.message.includes("village-goa-1"), true);
  }
  // Byte-identical, like every other member of the append union.
  assert.equal(readFileSync(logPath, "utf8"), before);
});

test("an empty `daemons` list admits no daemon at all", () => {
  const { logPath, dir } = freshInstance();
  markDaemonProcess();
  declareDaemonIdentityFor(logPath, { [DAEMON_ID_ENV]: "village-goa-1" });
  const policyPath = join(dir, "APPROVAL.md");
  // Written by hand rather than through `policyText`, because an empty YAML
  // sequence is the one spelling that list helper cannot produce.
  writeFileSync(
    policyPath,
    ["# Policy", "", "```yaml approval-policy", 'version: "0.1"', "daemons: []", "```", ""].join("\n"),
    "utf8",
  );
  attest(logPath, policyPath, "2026-09-20T11:00:00Z");
  const load = loadPolicy({ file: policyPath });
  assert.equal(load.ok, true, load.ok ? "" : load.message);
  assert.deepEqual(daemonAllowlistOf(load), []);
  refreshDaemonAllowlist(recordsOf(logPath), load);

  const refused = appendEvent(logPath, DRIFT);
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.error.code, "daemon-not-allowed");
    assert.equal(refused.error.message.includes("no daemon at all"), true);
  }
});

test("a declared id that is not an id refuses every append, writing nothing", () => {
  const { logPath } = freshInstance();
  markDaemonProcess();
  const resolved = declareDaemonIdentityFor(logPath, { [DAEMON_ID_ENV]: "Village Goa" });
  assert.equal(resolved.ok, false);
  // Declared anyway, as an identity with no id: a daemon that cannot name itself
  // must be refused rather than left unmarked and writing.
  assert.deepEqual(daemonIdentity(), {
    id: null,
    declared: "Village Goa",
    source: null,
    allowed: null,
  });

  const refused = appendEvent(logPath, DRIFT);
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.error.code, "daemon-id-invalid");
    assert.equal(refused.error.message.includes(DAEMON_ID_ENV), true);
  }
  // Nothing at all: the check runs before the lock is taken, so a refused append
  // does not even create the log file it would have appended to.
  assert.equal(existsSync(logPath), false);
});

// ---------------------------------------------------------------------------
// The list is read from the ATTESTED policy, and a failure never widens
// ---------------------------------------------------------------------------

test("an unattested or unloadable policy resolves no list, and says which", () => {
  const { logPath, dir } = freshInstance();
  const policyPath = writePolicy(dir, logPath, ["village-goa-1"]);

  // Never attested: the bytes are a document nobody signed, so no refusal may be
  // derived from them.
  const unattested = resolveDaemonAllowlist([], loadPolicy({ file: policyPath }));
  assert.equal(unattested.ok, false);
  if (!unattested.ok) assert.equal(unattested.reason, "policy-not-attested");

  // Attested, then edited: `checkAttestation` reports the mismatch and this is
  // the same refusal, because an edited policy is inoperative until a human
  // re-attests it.
  attest(logPath, policyPath, "2026-09-20T11:00:00Z");
  const attestedNow = resolveDaemonAllowlist(recordsOf(logPath), loadPolicy({ file: policyPath }));
  assert.deepEqual(attestedNow, { ok: true, allowed: ["village-goa-1"] });
  writeFileSync(policyPath, `${policyText(["village-goa-1", "village-goa-2"])}\n`, "utf8");
  const drifted = resolveDaemonAllowlist(recordsOf(logPath), loadPolicy({ file: policyPath }));
  assert.equal(drifted.ok, false);
  if (!drifted.ok) assert.equal(drifted.reason, "policy-not-attested");

  // A policy that does not load at all.
  writeFileSync(policyPath, "# Policy\n\nno block here\n", "utf8");
  const unloadable = resolveDaemonAllowlist(recordsOf(logPath), loadPolicy({ file: policyPath }));
  assert.equal(unloadable.ok, false);
  if (!unloadable.ok) assert.equal(unloadable.reason, "policy-unloadable");
});

test("a failed refresh leaves the restriction that was in force standing", () => {
  const { logPath, dir } = freshInstance();
  markDaemonProcess();
  declareDaemonIdentityFor(logPath, { [DAEMON_ID_ENV]: "village-goa-9" });
  const policyPath = writePolicy(dir, logPath, ["village-goa-1"]);
  attest(logPath, policyPath, "2026-09-20T11:00:00Z");
  refreshDaemonAllowlist(recordsOf(logPath), loadPolicy({ file: policyPath }));
  assert.deepEqual(daemonIdentity()?.allowed, ["village-goa-1"]);

  // The policy becomes unreadable under the running daemon. That must not be a
  // way out of the list it carried a moment ago: nothing is set, so the refusal
  // stands.
  writeFileSync(policyPath, "# Policy\n\nno block here\n", "utf8");
  const failed = refreshDaemonAllowlist(recordsOf(logPath), loadPolicy({ file: policyPath }));
  assert.equal(failed.ok, false);
  assert.deepEqual(daemonIdentity()?.allowed, ["village-goa-1"]);
  const refused = appendEvent(logPath, DRIFT);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.error.code, "daemon-not-allowed");
});

test("a list a human adds and attests takes effect on the next refresh", () => {
  const { logPath, dir } = freshInstance();
  markDaemonProcess();
  declareDaemonIdentityFor(logPath, { [DAEMON_ID_ENV]: "village-goa-9" });
  const policyPath = writePolicy(dir, logPath, null);
  attest(logPath, policyPath, "2026-09-20T11:00:00Z");
  refreshDaemonAllowlist(recordsOf(logPath), loadPolicy({ file: policyPath }));
  const allowedNow = appendEvent(logPath, DRIFT);
  assert.equal(allowedNow.ok, true);

  writeFileSync(policyPath, policyText(["village-goa-1"]), "utf8");
  attest(logPath, policyPath, "2026-09-20T11:10:00Z");
  refreshDaemonAllowlist(recordsOf(logPath), loadPolicy({ file: policyPath }));
  const refused = appendEvent(logPath, { ...DRIFT, ts: "2026-09-20T11:11:00Z" });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.error.code, "daemon-not-allowed");
});

test("re-declaring the identity does not drop a restriction in force", () => {
  const { logPath, dir } = freshInstance();
  markDaemonProcess();
  declareDaemonIdentityFor(logPath, { [DAEMON_ID_ENV]: "village-goa-9" });
  const policyPath = writePolicy(dir, logPath, ["village-goa-1"]);
  attest(logPath, policyPath, "2026-09-20T11:00:00Z");
  refreshDaemonAllowlist(recordsOf(logPath), loadPolicy({ file: policyPath }));

  declareDaemonIdentityFor(logPath, { [DAEMON_ID_ENV]: "village-goa-8" });
  assert.deepEqual(daemonIdentity()?.allowed, ["village-goa-1"]);
  const refused = appendEvent(logPath, DRIFT);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.error.code, "daemon-not-allowed");
});
