/**
 * Per-instance keystore item names, and the report on who is sharing what
 * (APRV-178).
 *
 * The incident these tests pin: two gates on one machine, three fixed keystore
 * item names, and therefore one bot token between them. A demo instance stored
 * its token over the production instance's item, both listeners long-polled the
 * same bot, and a human's approval tap was consumed by the listener that had
 * not asked the question.
 *
 * Nothing here touches a real Keychain or a real secret service. The names are
 * pure functions of a path, and the findings are computed from an
 * `.approval/env` file in a scratch directory with synthetic service names in
 * it; no value is ever stored, read back, or asserted on.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  INSTANCE_ID_LENGTH,
  LEGACY_SERVICE_TELEGRAM_TOKEN,
  instanceFindings,
  instanceHomeFor,
  instanceIdFor,
  scopeOfService,
  scopedService,
} from "../src/core/instance.js";
import { loadPolicy } from "../src/core/policy-load.js";

const scratch = mkdtempSync(join(tmpdir(), "approval-instance-"));
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const POLICY = `# Approval Policy

\`\`\`yaml approval-policy
version: "0.1"

defaults:
  autonomy: manual
  channel: telegram
  approval_ttl: "1h"
  on_expiry: reject

classes:
  files.write.*:
    autonomy: supervised
\`\`\`
`;

let counter = 0;

interface Instance {
  dir: string;
  logPath: string;
  envPath: string;
}

/** A scratch instance: `APPROVAL.md`, an `.approval/log/`, and nothing else. */
function makeInstance(): Instance {
  counter += 1;
  const dir = join(scratch, `gate-${String(counter)}`);
  mkdirSync(join(dir, ".approval", "log"), { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  const logPath = join(dir, ".approval", "log", "events.jsonl");
  writeFileSync(logPath, "", "utf8");
  return { dir, logPath, envPath: join(dir, ".approval", "env") };
}

/** Write `.approval/env` at the mode the runtime insists on. */
function writeEnv(instance: Instance, lines: string[]): void {
  writeFileSync(instance.envPath, `${lines.join("\n")}\n`, "utf8");
  chmodSync(instance.envPath, 0o600);
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

test("two instances on one machine get different item names, with no manual renaming", () => {
  const first = makeInstance();
  const second = makeInstance();

  const a = scopedService(LEGACY_SERVICE_TELEGRAM_TOKEN, first.logPath);
  const b = scopedService(LEGACY_SERVICE_TELEGRAM_TOKEN, second.logPath);

  assert.notEqual(
    a,
    b,
    "two instances resolved to ONE keystore item — this is the collision that put a demo gate on the production bot",
  );
  assert.match(a, new RegExp(`^${LEGACY_SERVICE_TELEGRAM_TOKEN}-[0-9a-f]{${String(INSTANCE_ID_LENGTH)}}$`, "u"));
  assert.match(b, new RegExp(`^${LEGACY_SERVICE_TELEGRAM_TOKEN}-[0-9a-f]{${String(INSTANCE_ID_LENGTH)}}$`, "u"));
});

test("the name is stable for one instance and independent of how its log is spelled", () => {
  const instance = makeInstance();
  const direct = instanceIdFor(instance.logPath);

  assert.equal(instanceIdFor(instance.logPath), direct, "the id is not deterministic");
  // `envFilePathFor` walks out of `log/`, so naming the home directory instead
  // of the log file is the same instance rather than a second one.
  assert.equal(instanceIdFor(join(instance.dir, ".approval", "anything.jsonl")), direct);
  assert.equal(instanceHomeFor(instance.logPath), join(instance.dir, ".approval"));
});

test("scopeOfService tells this instance's item from the legacy one and from a stranger's", () => {
  const mine = makeInstance();
  const theirs = makeInstance();

  assert.equal(
    scopeOfService(scopedService(LEGACY_SERVICE_TELEGRAM_TOKEN, mine.logPath), mine.logPath),
    "mine",
  );
  assert.equal(scopeOfService(LEGACY_SERVICE_TELEGRAM_TOKEN, mine.logPath), "legacy");
  assert.equal(
    scopeOfService(scopedService(LEGACY_SERVICE_TELEGRAM_TOKEN, theirs.logPath), mine.logPath),
    "other-instance",
  );
  assert.equal(scopeOfService("something-the-operator-named", mine.logPath), "unknown");
  // A suffix that is not eight hex digits is not a scope suffix at all.
  assert.equal(scopeOfService(`${LEGACY_SERVICE_TELEGRAM_TOKEN}-demo`, mine.logPath), "unknown");
});

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

test("an item scoped to THIS instance produces no findings", () => {
  const instance = makeInstance();
  writeEnv(instance, [
    `APPROVAL_TG_TOKEN=keychain:${scopedService(LEGACY_SERVICE_TELEGRAM_TOKEN, instance.logPath)}`,
    "APPROVAL_TG_CHAT=12345",
  ]);

  assert.deepEqual(instanceFindings(instance.logPath, loadPolicy({ dir: instance.dir }), {}), []);
});

test("an item scoped to ANOTHER instance is reported as foreign, by name and with no lookup", () => {
  const mine = makeInstance();
  const theirs = makeInstance();
  const stranger = scopedService(LEGACY_SERVICE_TELEGRAM_TOKEN, theirs.logPath);
  writeEnv(mine, [`APPROVAL_TG_TOKEN=keychain:${stranger}`, "APPROVAL_TG_CHAT=12345"]);

  const findings = instanceFindings(mine.logPath, loadPolicy({ dir: mine.dir }), {});
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.kind, "foreign-instance");
  assert.equal(findings[0]?.variable, "APPROVAL_TG_TOKEN");
  assert.equal(findings[0]?.service, stranger);
  assert.match(findings[0]?.detail ?? "", /two gates on this machine are pointed at one credential/u);
});

test("the unscoped legacy item still resolves, and is reported rather than adopted in silence", () => {
  const instance = makeInstance();
  writeEnv(instance, [
    `APPROVAL_TG_TOKEN=keychain:${LEGACY_SERVICE_TELEGRAM_TOKEN}`,
    "APPROVAL_TG_CHAT=12345",
  ]);

  const findings = instanceFindings(instance.logPath, loadPolicy({ dir: instance.dir }), {});
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.kind, "legacy-shared");
  assert.equal(findings[0]?.service, LEGACY_SERVICE_TELEGRAM_TOKEN);
});

test("a value exported in the shell over an instance's own line is reported as bleed", () => {
  const instance = makeInstance();
  writeEnv(instance, [
    `APPROVAL_TG_TOKEN=keychain:${scopedService(LEGACY_SERVICE_TELEGRAM_TOKEN, instance.logPath)}`,
    "APPROVAL_TG_CHAT=12345",
  ]);

  const findings = instanceFindings(instance.logPath, loadPolicy({ dir: instance.dir }), {
    // The shape of the second half of the incident: a production token exported
    // by the operator's shell rc, inherited by every terminal.
    APPROVAL_TG_TOKEN: "9999:PRODUCTION",
  });
  const bleed = findings.filter((finding) => finding.kind === "ambient-bleed");
  assert.equal(bleed.length, 1);
  assert.equal(bleed[0]?.variable, "APPROVAL_TG_TOKEN");
  assert.equal(
    findings.some((finding) => finding.detail.includes("9999:PRODUCTION")),
    false,
    "a finding carried the value it was reporting on",
  );
});

test("an instance with no env file at all has nothing to report", () => {
  const instance = makeInstance();
  assert.deepEqual(instanceFindings(instance.logPath, loadPolicy({ dir: instance.dir }), {}), []);
});
