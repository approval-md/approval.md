/**
 * The operator's headless bootstrap attestation (APRV-449).
 *
 * An Agent Village resident has no shell. The control plane provisions the
 * store, scaffolds it with `approval init`, writes the tenant's starting policy
 * and attests it as the OPERATOR, as the store user, with no terminal anywhere.
 * These tests pin the three facts that sequence rests on:
 *
 * 1. `approval policy attest --as human:<operator>` needs no TTY: identity is
 *    declared, and the attested text lands in the payload store (APRV-356), so
 *    the resident can later read exactly what was set.
 * 2. `--bootstrap` makes the step safe to re-run: the second run refuses
 *    `policy-already-attested`, changed bytes refuse
 *    `policy-amendment-required`, and neither appends anything.
 * 3. `approval status` and `approval doctor` name who attested the policy in
 *    force, read from the verified record.
 *
 * Every child is spawned with stdin IGNORED (`/dev/null`), so none of them has a
 * terminal to ask on; the env carries no `APPROVAL_HUMAN`, so the only identity
 * is the one `--as` declares. Every record is produced by the real CLI through
 * the real append path, and `approval log verify` runs after each flow.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { attestedPolicyPayloadHash, policyBytesHash } from "../src/core/attest.js";
import { payloadPath, payloadStoreDirFor } from "../src/core/payload-store.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-attest-bootstrap-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the CLI the way a control plane's root step does: no terminal on any
 * stream, and no ambient identity. `stdin: "ignore"` is `/dev/null`, which is
 * not a TTY, so a verb that needed one could only refuse.
 */
function runHeadless(args: string[], cwd: string): Run {
  const childEnv: Record<string, string | undefined> = { ...process.env };
  for (const name of ["APPROVAL_HUMAN", "APPROVAL_TG_TOKEN", "APPROVAL_TG_CHAT"]) {
    delete childEnv[name];
  }
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

const OPERATOR = "human:operator";

/** A recorder-shaped starting policy, standing in for the control plane's render. */
const STARTING_POLICY = [
  "# Tenant policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: autonomous",
  "  approval_ttl: 72h",
  "  on_expiry: reject",
  "classes:",
  "  policy.core: { autonomy: human-only }",
  "  log.mutate: { autonomy: human-only }",
  "  account.credential: { autonomy: human-only }",
  "```",
  "",
].join("\n");

/** `approval init`, then the control plane's rendered policy over the scaffold. */
function provisionedStore(): string {
  counter += 1;
  const dir = join(scratch, `store-${counter}`);
  // `init` scaffolds an existing directory; the launcher creates the store.
  mkdirSync(dir, { recursive: true });
  const init = runHeadless(["init", "--dir", dir, "--json"], scratch);
  assert.equal(init.code, 0, init.stderr);
  writeFileSync(join(dir, "APPROVAL.md"), STARTING_POLICY);
  return dir;
}

function logPathOf(dir: string): string {
  return join(dir, ".approval", "log", "events.jsonl");
}

function logLines(dir: string): string[] {
  const path = logPathOf(dir);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0);
}

function errorOf(run: Run): Record<string, unknown> {
  const body = JSON.parse(run.stderr) as { ok: boolean; error: Record<string, unknown> };
  assert.equal(body.ok, false);
  return body.error;
}

function assertChainClean(dir: string): void {
  const verify = runHeadless(["log", "verify"], dir);
  assert.equal(verify.code, 0, `${verify.stdout}${verify.stderr}`);
}

// ===========================================================================
// AC #3: headless attestation with a declared human identity
// ===========================================================================

test("policy attest succeeds with no TTY and a declared human, and stores the attested text", () => {
  const dir = provisionedStore();
  const run = runHeadless(["policy", "attest", "--as", OPERATOR, "--json"], dir);
  assert.equal(run.code, 0, run.stderr);
  const body = JSON.parse(run.stdout) as Record<string, unknown>;
  assert.equal(body["ok"], true);
  assert.equal(body["seq"], 1);
  assert.equal(body["sha256"], policyBytesHash(Buffer.from(STARTING_POLICY, "utf8")));

  const [line] = logLines(dir);
  assert.ok(line !== undefined, "the attestation was not appended");
  const record = JSON.parse(line) as {
    event: string;
    actor: string;
    payload: Record<string, unknown>;
  };
  assert.equal(record.event, "policy.updated");
  assert.equal(record.actor, OPERATOR);

  // The bytes the operator set are recoverable, byte for byte, from the store
  // the record binds: this is what lets a resident read their starting policy.
  const bound = record.payload["payload_hash"];
  assert.equal(bound, attestedPolicyPayloadHash(STARTING_POLICY));
  const stored = payloadPath(payloadStoreDirFor(logPathOf(dir)), String(bound));
  assert.ok(existsSync(stored), `the record binds ${String(bound)} and the store does not hold it`);
  assert.deepEqual(JSON.parse(readFileSync(stored, "utf8")), { text: STARTING_POLICY });

  assertChainClean(dir);
});

// ===========================================================================
// --bootstrap: the re-runnable provisioning step
// ===========================================================================

test("--bootstrap attests a store's first policy, headless, and stores the text", () => {
  const dir = provisionedStore();
  const run = runHeadless(["policy", "attest", "--bootstrap", "--as", OPERATOR, "--json"], dir);
  assert.equal(run.code, 0, run.stderr);
  assert.equal((JSON.parse(run.stdout) as Record<string, unknown>)["seq"], 1);

  const record = JSON.parse(logLines(dir)[0] ?? "{}") as {
    actor: string;
    payload: Record<string, unknown>;
  };
  assert.equal(record.actor, OPERATOR);
  const stored = payloadPath(
    payloadStoreDirFor(logPathOf(dir)),
    String(record.payload["payload_hash"]),
  );
  assert.deepEqual(JSON.parse(readFileSync(stored, "utf8")), { text: STARTING_POLICY });
  assertChainClean(dir);
});

test("--bootstrap re-run refuses policy-already-attested at exit 1 and appends nothing", () => {
  const dir = provisionedStore();
  assert.equal(
    runHeadless(["policy", "attest", "--bootstrap", "--as", OPERATOR], dir).code,
    0,
  );
  const before = readFileSync(logPathOf(dir));

  const again = runHeadless(["policy", "attest", "--bootstrap", "--as", OPERATOR, "--json"], dir);
  assert.equal(again.code, 1, again.stderr);
  assert.equal(again.stdout, "");
  const error = errorOf(again);
  assert.equal(error["code"], "policy-already-attested");
  assert.equal(error["seq"], 1);
  assert.equal(error["attested_by"], OPERATOR);
  assert.deepEqual(readFileSync(logPathOf(dir)), before, "a refused re-run wrote to the log");

  // The human rendering says the same thing in words, and names the attester.
  const plain = runHeadless(["policy", "attest", "--bootstrap", "--as", OPERATOR], dir);
  assert.equal(plain.code, 1);
  assert.match(plain.stderr, /already matches its attestation at seq 1 by human:operator/u);
  assertChainClean(dir);
});

test("--bootstrap never re-attests as the operator over another human's attestation", () => {
  const dir = provisionedStore();
  assert.equal(runHeadless(["policy", "attest", "--bootstrap", "--as", OPERATOR], dir).code, 0);
  // The resident (stand-in: a terminal attestation by another human) attests
  // the same bytes later. A re-run of provisioning must leave them on record.
  assert.equal(runHeadless(["policy", "attest", "--as", "human:resident"], dir).code, 0);
  const before = readFileSync(logPathOf(dir));

  const again = runHeadless(["policy", "attest", "--bootstrap", "--as", OPERATOR, "--json"], dir);
  assert.equal(again.code, 1);
  const error = errorOf(again);
  assert.equal(error["code"], "policy-already-attested");
  assert.equal(error["seq"], 2);
  assert.equal(error["attested_by"], "human:resident");
  assert.deepEqual(readFileSync(logPathOf(dir)), before);
});

test("--bootstrap over changed bytes refuses policy-amendment-required and appends nothing", () => {
  const dir = provisionedStore();
  assert.equal(runHeadless(["policy", "attest", "--bootstrap", "--as", OPERATOR], dir).code, 0);
  const before = readFileSync(logPathOf(dir));

  // A re-render on update: the template moved under an attested store.
  writeFileSync(join(dir, "APPROVAL.md"), STARTING_POLICY.replace("72h", "4m"));
  const run = runHeadless(["policy", "attest", "--bootstrap", "--as", OPERATOR, "--json"], dir);
  assert.equal(run.code, 1, run.stderr);
  const error = errorOf(run);
  assert.equal(error["code"], "policy-amendment-required");
  assert.equal(error["seq"], 1);
  assert.equal(error["attested_by"], OPERATOR);
  assert.match(String(error["message"]), /amendment is the approver's act through a channel/u);
  assert.deepEqual(readFileSync(logPathOf(dir)), before);
  assertChainClean(dir);
});

test("--bootstrap keeps the human-only rule: an agent actor is exit 2 and nothing is written", () => {
  const dir = provisionedStore();
  const run = runHeadless(["policy", "attest", "--bootstrap", "--as", "agent:resident"], dir);
  assert.equal(run.code, 2);
  assert.deepEqual(logLines(dir), []);
});

test("--bootstrap beside --organ or --path is a usage error, never a guess", () => {
  const dir = provisionedStore();
  for (const flag of ["--organ", "--path"]) {
    const run = runHeadless(
      ["policy", "attest", "--bootstrap", flag, ".claude/settings.json", "--as", OPERATOR, "--json"],
      dir,
    );
    assert.equal(run.code, 2, `${flag}: ${run.stderr}`);
    // The usage shape carries no `ok` field (it predates this verb's refusals).
    const body = JSON.parse(run.stderr) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "usage");
    assert.match(body.error.message, /--bootstrap attests a store's first POLICY/u);
  }
  assert.deepEqual(logLines(dir), []);
});

// ===========================================================================
// AC #2: status and doctor name who set the policy in force
// ===========================================================================

test("status names the attester and seq of the policy in force, from the log", () => {
  const dir = provisionedStore();
  const unattested = runHeadless(["status", "--json"], dir);
  const before = JSON.parse(unattested.stdout) as { attestation: Record<string, unknown> };
  assert.deepEqual(before.attestation, { state: "not-attested", seq: null, attested_by: null });

  assert.equal(runHeadless(["policy", "attest", "--bootstrap", "--as", OPERATOR], dir).code, 0);
  const json = JSON.parse(runHeadless(["status", "--json"], dir).stdout) as {
    attestation: Record<string, unknown>;
  };
  assert.deepEqual(json.attestation, { state: "attested", seq: 1, attested_by: OPERATOR });

  const human = runHeadless(["status"], dir);
  assert.match(human.stdout, /attestation\s+attested \(seq 1, by human:operator\)/u);

  // Edited bytes: the row still names who vouched for the bytes last attested.
  writeFileSync(join(dir, "APPROVAL.md"), `${STARTING_POLICY}\n`);
  const drifted = JSON.parse(runHeadless(["status", "--json"], dir).stdout) as {
    attestation: Record<string, unknown>;
  };
  assert.deepEqual(drifted.attestation, {
    state: "hash-mismatch",
    seq: 1,
    attested_by: OPERATOR,
  });
});

test("doctor's attestation row names the attester beside the seq", () => {
  const dir = provisionedStore();
  assert.equal(runHeadless(["policy", "attest", "--bootstrap", "--as", OPERATOR], dir).code, 0);
  const run = runHeadless(["doctor", "--json"], dir);
  const parsed = JSON.parse(run.stdout) as {
    checks: { check: string; status: string; detail: string }[];
  };
  const row = parsed.checks.find((entry) => entry.check === "attestation");
  assert.ok(row !== undefined, `no attestation row in ${run.stdout}`);
  assert.equal(row.status, "pass");
  assert.match(row.detail, /is attested at seq 1 by human:operator \(sha256 /u);
});
