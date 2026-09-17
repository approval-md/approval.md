/**
 * APRV-325.2: the policy-bound typed Codex workspace change broker.
 *
 * Every record here is produced by the real append path (`core/gate.ts`,
 * `core/token.ts`, `core/execute.ts`), every policy is a real `APPROVAL.md`
 * parsed by `core/policy-load.ts`, and every attestation is a real
 * `policy.updated`. Nothing hand-writes a log line, and every scenario that
 * touches the log ends by walking the chain: a refusal that leaves a broken log
 * has still failed.
 *
 * The suite is adversarial by construction. The interesting assertions are not
 * "the change was applied" but "the change was NOT applied, and the log says
 * exactly why" — a caller trying to name its own actor, a policy that is not
 * attested, a digest that drifted, a leg with no grant, a second apply of the
 * same bytes, a workspace edited between the approval and the commit, a second
 * broker holding the lock, and a crash in the middle of a multi-file
 * transaction.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  applyWorkspaceChange,
  brokerActionKey,
  brokerInstallation,
  brokerTaskId,
  BROKER_REFUSAL_CODES,
  BROKER_TOOLS,
  parseBrokerInput,
  WORKSPACE_COMMIT_UNKNOWN,
  type BrokerInstallation,
  type BrokerOptions,
  type BrokerRefusal,
  type BrokerResult,
} from "../src/codex/broker.js";
import {
  inspectWorkspaceState,
  recoverWorkspaceCommit,
  WORKSPACE_LOCK_FILE,
  WORKSPACE_TXN_DIR,
} from "../src/codex/workspace-commit.js";
import type { CodexInstanceManifest } from "../src/codex/manifest.js";
import { INDETERMINATE_REASONS } from "../src/core/execute.js";
import type { EventRecord } from "../src/core/log.js";
import { verify } from "../src/core/verify.js";
import { appendAttestation, decide } from "./clock-adapters.js";

const scratch = mkdtempSync(join(tmpdir(), "approval-md-codex-broker-"));
let serial = 0;

after(() => rmSync(scratch, { recursive: true, force: true }));

const T0 = "2026-09-16T10:00:00.000Z";
const CLOCK = (): string => T0;

function sha(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function b64(bytes: string | Buffer): string {
  return Buffer.from(bytes).toString("base64");
}

/** `autonomy` for `files.write.workspace`, with the APRV-317 opt-in where needed. */
function policyText(autonomy: string, options: { protectedPaths?: boolean } = {}): string {
  const irreversible = autonomy === "manual" || autonomy === "human-only"
    ? []
    : ["    allow_irreversible: true"];
  return [
    "# Broker test policy",
    "",
    "```yaml approval-policy",
    'version: "0.1"',
    "defaults:",
    "  autonomy: manual",
    '  approval_ttl: "1h"',
    ...(options.protectedPaths === true
      ? [
          "protected_paths:",
          "  - { path: docs/, class: policy.edit.docs }",
          "  - { path: secret/, class: policy.edit.secret }",
        ]
      : []),
    "classes:",
    "  files.write.workspace:",
    `    autonomy: ${autonomy}`,
    ...irreversible,
    "  policy.edit.docs:",
    `    autonomy: ${autonomy}`,
    ...irreversible,
    "  policy.edit.secret:",
    "    autonomy: human-only",
    "```",
    "",
  ].join("\n");
}

interface Unit {
  dir: string;
  root: string;
  logPath: string;
  policyPath: string;
  installation: BrokerInstallation;
  policySha256: string;
  options: BrokerOptions;
}

function unit(text: string = policyText("manual")): Unit {
  serial += 1;
  const dir = join(scratch, `case-${String(serial)}`);
  mkdirSync(join(dir, "workspace"), { recursive: true });
  // `$TMPDIR` is a symlink on macOS and the planner requires a real root.
  const root = realpathSync(join(dir, "workspace"));
  const policyPath = join(dir, "APPROVAL.md");
  writeFileSync(policyPath, text, "utf8");
  const logPath = join(dir, ".approval", "log", "events.jsonl");
  const installation: BrokerInstallation = {
    instanceId: "probe",
    actor: "agent:codex-probe",
    root,
    policyPath,
    logPath,
  };
  const attested = appendAttestation(logPath, policyPath, "human:carter", T0);
  assert.equal(attested.ok, true, "attestation append failed");
  return {
    dir,
    root,
    logPath,
    policyPath,
    installation,
    policySha256: sha(readFileSync(policyPath)),
    options: { clock: CLOCK },
  };
}

function proposal(unitUnderTest: Unit, operations: unknown): Record<string, unknown> {
  return { operations, expected_policy_sha256: unitUnderTest.policySha256 };
}

function apply(
  unitUnderTest: Unit,
  operations: unknown,
  options: BrokerOptions = {},
): BrokerResult {
  return applyWorkspaceChange(
    "codex_workspace_apply",
    unitUnderTest.installation,
    proposal(unitUnderTest, operations),
    { ...unitUnderTest.options, ...options },
  );
}

function refused(result: BrokerResult, code: string): BrokerRefusal {
  assert.equal(result.ok, false, "expected a refusal");
  const refusal = result as BrokerRefusal;
  assert.equal(refusal.code, code, refusal.message);
  return refusal;
}

function records(unitUnderTest: Unit): EventRecord[] {
  let raw: string;
  try {
    raw = readFileSync(unitUnderTest.logPath, "utf8");
  } catch {
    return [];
  }
  return raw.split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as EventRecord);
}

function eventsFor(unitUnderTest: Unit, event: string): EventRecord[] {
  return records(unitUnderTest).filter((record) => record.event === event);
}

function assertClean(unitUnderTest: Unit): void {
  const result = verify(unitUnderTest.logPath);
  assert.equal(result.status, "clean", `log not clean: ${JSON.stringify(result)}`);
}

/** Nothing under the workspace root but the files the test put there. */
function workspaceEntries(unitUnderTest: Unit): string[] {
  return readdirSync(unitUnderTest.root).sort();
}

/** Grant every pending request for the classes named, returning class -> token. */
function grantAll(unitUnderTest: Unit, classes: readonly string[]): Record<string, string> {
  const task = tasksOf(unitUnderTest)[0] as string;
  const tokens: Record<string, string> = {};
  for (const cls of classes) {
    const granted = decide(
      unitUnderTest.logPath,
      brokerActionKey(task, cls),
      "grant",
      "human:carter",
      T0,
      { policy: { file: unitUnderTest.policyPath } },
    );
    assert.equal(granted.ok, true, granted.ok ? "" : granted.message);
    if (!granted.ok || granted.token === undefined) throw new Error("expected a token");
    tokens[cls] = granted.token;
  }
  return tokens;
}

function tasksOf(unitUnderTest: Unit): string[] {
  return [...new Set(eventsFor(unitUnderTest, "task.registered").map((record) => String(record.task)))];
}

// ===========================================================================
// AC1 — caller input cannot override authority; positive tool allowlist
// ===========================================================================

test("the broker refusal-code union is frozen and every member is distinct", () => {
  assert.equal(new Set(BROKER_REFUSAL_CODES).size, BROKER_REFUSAL_CODES.length);
  assert.deepEqual([...BROKER_REFUSAL_CODES], [
    "tool-not-allowed",
    "input-invalid",
    "installation-invalid",
    "log-unavailable",
    "policy-unavailable",
    "policy-not-attested",
    "attestation-drift",
    "reserved-path",
    "no-op-operation",
    "plan-refused",
    "replay",
    "register-refused",
    "request-refused",
    "approval-required",
    "start-refused",
    "custody-contended",
    "custody-unavailable",
    "custody-insufficient",
    "workspace-drift",
    "stage-failed",
    "commit-not-applied",
    "commit-unknown",
  ]);
});

test("the tool allowlist is positive: one name, and nothing else is reachable", () => {
  assert.deepEqual([...BROKER_TOOLS], ["codex_workspace_apply"]);
  const one = unit();
  for (const name of ["approval_run", "run", "codex_workspace_apply ", "CODEX_WORKSPACE_APPLY", "mcp_serve"]) {
    const result = applyWorkspaceChange(name, one.installation, proposal(one, []), one.options);
    refused(result, "tool-not-allowed");
  }
  assert.deepEqual(workspaceEntries(one), []);
  assert.deepEqual(eventsFor(one, "task.registered"), []);
});

test("caller input cannot name an actor, root, policy, log, class, token or sandbox posture", () => {
  for (const key of ["actor", "root", "policy", "log", "class", "reversible", "token", "sandbox", "as"]) {
    const parsed = parseBrokerInput({
      operations: [],
      expected_policy_sha256: "a".repeat(64),
      [key]: "human:carter",
    });
    assert.equal(parsed.ok, false, `${key} was accepted`);
    if (!parsed.ok) assert.match(parsed.message, new RegExp(`unknown property "${key}"`, "u"));
  }
  const good = parseBrokerInput({ operations: [], expected_policy_sha256: "a".repeat(64) });
  assert.equal(good.ok, true);
});

test("the expected policy digest must be a real digest and operations must be present", () => {
  assert.equal(parseBrokerInput({ operations: [] }).ok, false);
  assert.equal(parseBrokerInput({ operations: [], expected_policy_sha256: "nope" }).ok, false);
  assert.equal(parseBrokerInput({ operations: [], expected_policy_sha256: "A".repeat(64) }).ok, false);
  assert.equal(parseBrokerInput({ expected_policy_sha256: "a".repeat(64) }).ok, false);
  assert.equal(parseBrokerInput([]).ok, false);
  assert.equal(parseBrokerInput(null).ok, false);
});

test("the installation, not the caller, supplies actor, root, policy and log", () => {
  const manifest = {
    schema_version: "approval.codex.instance.v1",
    instance_id: "morning",
    platform: "darwin",
    codex_version: "0.152.1",
    node_version: "22.0.0",
    package_version: "0.2.0",
    paths: {
      install_root: "/opt/approval",
      package_root: "/opt/approval/pkg",
      workspace: "/var/codex/workspace",
      primary: "/var/gate",
      policy: "/var/gate/APPROVAL.md",
      log: "/var/gate/.approval/log/events.jsonl",
      manifest: "/opt/approval/instance.json",
      codex_executable: "/opt/approval/bin/codex",
      node_executable: "/opt/approval/bin/node",
      mcp_executable: "/opt/approval/bin/approval",
      broker_executable: "/opt/approval/bin/broker",
      runner_executable: "/opt/approval/bin/runner",
    },
    principals: { codex: "_approval_codex", broker: "_approval_broker", runner: "_approval_runner" },
    invocation: { command: "/opt/approval/bin/approval", args: ["codex", "serve", "--manifest", "/opt/approval/instance.json"] },
    components: { broker: "required-not-shipped", runner: "required-not-shipped" },
  } as unknown as CodexInstanceManifest;
  assert.deepEqual(brokerInstallation(manifest), {
    instanceId: "morning",
    actor: "agent:codex-morning",
    root: "/var/codex/workspace",
    policyPath: "/var/gate/APPROVAL.md",
    logPath: "/var/gate/.approval/log/events.jsonl",
  });
});

// ===========================================================================
// AC2 — payload identity, verified preimages, path attacks, class separation
// ===========================================================================

test("one approved autonomous proposal produces exactly its effect and one leg per class", () => {
  const one = unit(policyText("autonomous", { protectedPaths: true }));
  mkdirSync(join(one.root, "docs"));
  writeFileSync(join(one.root, "keep.txt"), "old");
  writeFileSync(join(one.root, "docs", "gone.md"), "bye");
  const result = apply(one, [
    { kind: "create", path: "made.txt", after_base64: b64("made") },
    { kind: "replace", path: "keep.txt", expected_before_sha256: sha("old"), after_base64: b64("new") },
    { kind: "delete", path: "docs/gone.md", expected_before_sha256: sha("bye") },
  ]);
  assert.equal(result.ok, true, result.ok ? "" : `${result.code}: ${result.message}`);
  if (!result.ok) return;

  assert.equal(result.state, "after");
  assert.deepEqual(result.legs.map((leg) => leg.class).sort(), ["files.write.workspace", "policy.edit.docs"]);
  assert.equal(new Set(result.legs.map((leg) => leg.actionKey)).size, 2);
  assert.equal(result.policy_sha256, one.policySha256);

  assert.equal(readFileSync(join(one.root, "made.txt"), "utf8"), "made");
  assert.equal(readFileSync(join(one.root, "keep.txt"), "utf8"), "new");
  assert.equal(existsSync(join(one.root, "docs", "gone.md")), false);
  assert.deepEqual(workspaceEntries(one), ["docs", "keep.txt", "made.txt"]);

  const started = eventsFor(one, "execution.started");
  const completed = eventsFor(one, "execution.completed");
  assert.equal(started.length, 2);
  assert.equal(completed.length, 2);
  // Every leg binds the same payload hash and nothing was collapsed.
  const declared = eventsFor(one, "task.registered")[0] as EventRecord;
  const actions = (declared.payload as { actions: { class: string; payload_hash: string }[] }).actions;
  assert.equal(actions.length, 2);
  assert.ok(actions.every((action) => action.payload_hash === result.payload_hash));
  assertClean(one);
});

test("a proposal reaching a human-only class refuses before any preimage or record", () => {
  const one = unit(policyText("autonomous", { protectedPaths: true }));
  mkdirSync(join(one.root, "secret"));
  writeFileSync(join(one.root, "secret", "key.pem"), "sensitive");
  const refusal = refused(
    apply(one, [{ kind: "delete", path: "secret/key.pem", expected_before_sha256: sha("sensitive") }]),
    "plan-refused",
  );
  assert.equal(refusal.detail, "class-human-only");
  assert.equal(readFileSync(join(one.root, "secret", "key.pem"), "utf8"), "sensitive");
  assert.deepEqual(eventsFor(one, "task.registered"), []);
  assertClean(one);
});

test("traversal, symlinks and hardlinks refuse with the planner's own code and touch nothing", () => {
  const one = unit(policyText("autonomous"));
  const outside = join(one.dir, "outside.txt");
  writeFileSync(outside, "outside");
  symlinkSync(outside, join(one.root, "link.txt"));
  writeFileSync(join(one.root, "real.txt"), "real");
  writeFileSync(join(one.root, "hard.txt"), "hard");
  // A second link to the same inode: the planner refuses a multi-link preimage.
  linkSync(join(one.root, "hard.txt"), join(one.root, "hard2.txt"));

  refused(apply(one, [{ kind: "create", path: "../escape.txt", after_base64: b64("x") }]), "plan-refused");
  refused(apply(one, [{ kind: "create", path: "/etc/escape", after_base64: b64("x") }]), "plan-refused");
  refused(
    apply(one, [{ kind: "replace", path: "link.txt", expected_before_sha256: sha("outside"), after_base64: b64("x") }]),
    "plan-refused",
  );
  refused(
    apply(one, [{ kind: "delete", path: "hard.txt", expected_before_sha256: sha("hard") }]),
    "plan-refused",
  );
  assert.equal(readFileSync(outside, "utf8"), "outside");
  assert.equal(readFileSync(join(one.root, "hard.txt"), "utf8"), "hard");
  assert.deepEqual(eventsFor(one, "execution.started"), []);
});

test("the broker's own transaction paths are reserved and can never be a proposal endpoint", () => {
  const one = unit(policyText("autonomous"));
  for (const path of [
    `${WORKSPACE_TXN_DIR}/journal.json`,
    WORKSPACE_LOCK_FILE,
  ]) {
    const result = apply(one, [{ kind: "create", path, after_base64: b64("x") }]);
    refused(result, "reserved-path");
  }
  assert.deepEqual(workspaceEntries(one), []);
  assert.deepEqual(eventsFor(one, "task.registered"), []);
});

test("a replace that changes nothing is refused rather than reported as an outcome", () => {
  const one = unit(policyText("autonomous"));
  writeFileSync(join(one.root, "same.txt"), "same");
  refused(
    apply(one, [{ kind: "replace", path: "same.txt", expected_before_sha256: sha("same"), after_base64: b64("same") }]),
    "no-op-operation",
  );
  assert.deepEqual(eventsFor(one, "task.registered"), []);
});

test("a preimage that does not match the declared digest refuses before any record", () => {
  const one = unit(policyText("autonomous"));
  writeFileSync(join(one.root, "drifted.txt"), "actual");
  const refusal = refused(
    apply(one, [{ kind: "replace", path: "drifted.txt", expected_before_sha256: sha("claimed"), after_base64: b64("x") }]),
    "plan-refused",
  );
  assert.equal(refusal.detail, "preimage-mismatch");
  assert.equal(readFileSync(join(one.root, "drifted.txt"), "utf8"), "actual");
});

// ===========================================================================
// AC3 — policy decides autonomy, and drift, replay and missing grants refuse
// ===========================================================================

test("an unattested policy refuses before the plan, the register and any write", () => {
  serial += 1;
  const dir = join(scratch, `unattested-${String(serial)}`);
  mkdirSync(join(dir, "workspace"), { recursive: true });
  const root = realpathSync(join(dir, "workspace"));
  const policyPath = join(dir, "APPROVAL.md");
  writeFileSync(policyPath, policyText("autonomous"), "utf8");
  const installation: BrokerInstallation = {
    instanceId: "probe",
    actor: "agent:codex-probe",
    root,
    policyPath,
    logPath: join(dir, ".approval", "log", "events.jsonl"),
  };
  const result = applyWorkspaceChange(
    "codex_workspace_apply",
    installation,
    { operations: [{ kind: "create", path: "x.txt", after_base64: b64("x") }], expected_policy_sha256: sha(readFileSync(policyPath)) },
    { clock: CLOCK },
  );
  const refusal = refused(result, "policy-not-attested");
  assert.equal(refusal.detail, "not-attested");
  assert.equal(existsSync(join(root, "x.txt")), false);
});

test("a policy edited after attestation refuses hash-mismatch and writes nothing", () => {
  const one = unit(policyText("autonomous"));
  writeFileSync(one.policyPath, `${policyText("autonomous")}\n<!-- edited -->\n`, "utf8");
  const result = applyWorkspaceChange(
    "codex_workspace_apply",
    one.installation,
    { operations: [{ kind: "create", path: "x.txt", after_base64: b64("x") }], expected_policy_sha256: sha(readFileSync(one.policyPath)) },
    one.options,
  );
  const refusal = refused(result, "policy-not-attested");
  assert.equal(refusal.detail, "hash-mismatch");
  assert.equal(existsSync(join(one.root, "x.txt")), false);
  assertClean(one);
});

test("attestation drift: a proposal built against a different policy digest refuses", () => {
  const one = unit(policyText("autonomous"));
  const result = applyWorkspaceChange(
    "codex_workspace_apply",
    one.installation,
    { operations: [{ kind: "create", path: "x.txt", after_base64: b64("x") }], expected_policy_sha256: "b".repeat(64) },
    one.options,
  );
  refused(result, "attestation-drift");
  assert.equal(existsSync(join(one.root, "x.txt")), false);
  assert.deepEqual(eventsFor(one, "task.registered"), []);
});

test("an unavailable log refuses before the policy is even consulted", () => {
  const one = unit(policyText("autonomous"));
  writeFileSync(one.logPath, `${readFileSync(one.logPath, "utf8")}{"tampered":true}\n`, "utf8");
  const refusal = refused(apply(one, [{ kind: "create", path: "x.txt", after_base64: b64("x") }]), "log-unavailable");
  assert.ok(["log-corrupt", "log-torn-tail"].includes(String(refusal.detail)));
  assert.equal(existsSync(join(one.root, "x.txt")), false);
});

test("a manual class needs a real grant: no token means no write and a named pending key", () => {
  const one = unit(policyText("manual"));
  writeFileSync(join(one.root, "keep.txt"), "old");
  const refusal = refused(
    apply(one, [{ kind: "replace", path: "keep.txt", expected_before_sha256: sha("old"), after_base64: b64("new") }]),
    "approval-required",
  );
  assert.equal(refusal.pending?.length, 1);
  assert.equal(readFileSync(join(one.root, "keep.txt"), "utf8"), "old");
  // The request WAS recorded: a human has something to decide. Nothing executed.
  assert.equal(eventsFor(one, "approval.requested").length, 1);
  assert.deepEqual(eventsFor(one, "execution.started"), []);
  assertClean(one);
});

test("a genuine grant token executes the manual leg exactly once; the replay refuses", () => {
  const one = unit(policyText("manual"));
  writeFileSync(join(one.root, "keep.txt"), "old");
  const operations = [
    { kind: "replace", path: "keep.txt", expected_before_sha256: sha("old"), after_base64: b64("new") },
  ];
  refused(apply(one, operations), "approval-required");
  const tokens = grantAll(one, ["files.write.workspace"]);

  const granted = apply(one, operations, { tokens });
  assert.equal(granted.ok, true, granted.ok ? "" : `${granted.code}: ${granted.message}`);
  assert.equal(readFileSync(join(one.root, "keep.txt"), "utf8"), "new");
  assert.equal(eventsFor(one, "execution.completed").length, 1);

  // Exactly the same bytes a second time: the same task id, the same key, and
  // the gate's own single-use scan. The file is not written twice.
  const replay = apply(one, operations, { tokens });
  assert.equal(replay.ok, false);
  assert.equal(readFileSync(join(one.root, "keep.txt"), "utf8"), "new");
  assert.equal(eventsFor(one, "execution.started").length, 1);
  assertClean(one);
});

test("a forged or foreign token cannot start a manual leg", () => {
  const one = unit(policyText("manual"));
  writeFileSync(join(one.root, "keep.txt"), "old");
  const operations = [
    { kind: "replace", path: "keep.txt", expected_before_sha256: sha("old"), after_base64: b64("new") },
  ];
  refused(apply(one, operations), "approval-required");
  const refusal = refused(
    apply(one, operations, { tokens: { "files.write.workspace": "not-a-real-token" } }),
    "start-refused",
  );
  assert.ok(["token-mismatch", "not-granted", "token-required"].includes(String(refusal.detail)), refusal.message);
  assert.equal(readFileSync(join(one.root, "keep.txt"), "utf8"), "old");
  assert.deepEqual(eventsFor(one, "execution.started"), []);
  assertClean(one);
});

test("one leg without a grant blocks every leg: a mixed-class proposal writes nothing", () => {
  // `files.write.workspace` is autonomous, `policy.edit.docs` is manual. The
  // autonomous leg must not execute on its own.
  const one = unit([
    "# Mixed policy",
    "",
    "```yaml approval-policy",
    'version: "0.1"',
    "defaults:",
    "  autonomy: manual",
    "protected_paths:",
    "  - { path: docs/, class: policy.edit.docs }",
    "classes:",
    "  files.write.workspace:",
    "    autonomy: autonomous",
    "    allow_irreversible: true",
    "  policy.edit.docs:",
    "    autonomy: manual",
    "```",
    "",
  ].join("\n"));
  mkdirSync(join(one.root, "docs"));
  const refusal = refused(apply(one, [
    { kind: "create", path: "plain.txt", after_base64: b64("plain") },
    { kind: "create", path: "docs/note.md", after_base64: b64("note") },
  ]), "approval-required");
  assert.equal(refusal.pending?.length, 1);
  assert.equal(existsSync(join(one.root, "plain.txt")), false);
  assert.equal(existsSync(join(one.root, "docs", "note.md")), false);
  assert.deepEqual(eventsFor(one, "execution.started"), []);
  assertClean(one);
});

// ===========================================================================
// AC4 — custody, crash evidence, and honest indeterminate outcomes
// ===========================================================================

test("a workspace edited between the approval and the commit refuses under custody", () => {
  const one = unit(policyText("autonomous"));
  writeFileSync(join(one.root, "keep.txt"), "old");
  const result = apply(one, [
    { kind: "replace", path: "keep.txt", expected_before_sha256: sha("old"), after_base64: b64("new") },
  ], {
    // Another writer lands between the last `execution.started` and the commit.
    afterStart: () => writeFileSync(join(one.root, "keep.txt"), "raced"),
  });
  const refusal = refused(result, "workspace-drift");
  assert.equal(refusal.detail, "workspace-drift");
  assert.equal(readFileSync(join(one.root, "keep.txt"), "utf8"), "raced");
  // The legs started, so they are closed honestly rather than left dangling.
  assert.equal(eventsFor(one, "execution.started").length, 1);
  assert.equal(eventsFor(one, "execution.failed").length, 1);
  assertClean(one);
});

test("a held workspace lock refuses custody-contended and attempts nothing", () => {
  const one = unit(policyText("autonomous"));
  writeFileSync(join(one.root, WORKSPACE_LOCK_FILE), "", "utf8");
  const result = apply(one, [{ kind: "create", path: "x.txt", after_base64: b64("x") }]);
  refused(result, "custody-contended");
  assert.equal(existsSync(join(one.root, "x.txt")), false);
  assert.equal(eventsFor(one, "execution.failed").length, 1);
  assertClean(one);
});

test("an installation that requires OS-exclusive custody refuses when it cannot be proven", () => {
  const one = unit(policyText("autonomous"));
  // A world-writable workspace root: POSIX itself says another principal can
  // write here, so the strong claim is unavailable and the refusal is honest.
  chmodSync(one.root, 0o777);
  const result = apply(one, [{ kind: "create", path: "x.txt", after_base64: b64("x") }], {
    requireExclusiveCustody: true,
  });
  const refusal = refused(result, "custody-insufficient");
  assert.match(refusal.message, /advisory/u);
  assert.equal(existsSync(join(one.root, "x.txt")), false);
  chmodSync(one.root, 0o755);
});

test("custody always reports acl-unproven, because ownership and mode do not speak about ACLs", () => {
  const one = unit(policyText("autonomous"));
  const result = apply(one, [{ kind: "create", path: "x.txt", after_base64: b64("x") }]);
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok) return;
  assert.ok(result.custody.findings.includes("acl-unproven"));
});

test("a crash mid-transaction records execution.indeterminate with workspace-commit-unknown", () => {
  const one = unit(policyText("autonomous"));
  writeFileSync(join(one.root, "a.txt"), "a-old");
  writeFileSync(join(one.root, "b.txt"), "b-old");
  const result = apply(one, [
    { kind: "replace", path: "a.txt", expected_before_sha256: sha("a-old"), after_base64: b64("a-new") },
    { kind: "replace", path: "b.txt", expected_before_sha256: sha("b-old"), after_base64: b64("b-new") },
  ], {
    onStep: (step) => {
      // Crash after the first rename has taken and before the second, and make
      // the rollback impossible too, so the tree really is half-applied.
      if (step !== 1) return;
      rmSync(join(one.root, WORKSPACE_TXN_DIR), { recursive: true, force: true });
      throw new Error("simulated crash between two renames");
    },
  });
  const refusal = refused(result, "commit-unknown");
  assert.equal(refusal.state, "mixed");
  assert.equal(readFileSync(join(one.root, "a.txt"), "utf8"), "a-new");
  assert.equal(readFileSync(join(one.root, "b.txt"), "utf8"), "b-old");

  const indeterminate = eventsFor(one, "execution.indeterminate");
  assert.equal(indeterminate.length, 1);
  const payload = (indeterminate[0] as EventRecord).payload as { reason: string; exit_code: null };
  assert.equal(payload.reason, WORKSPACE_COMMIT_UNKNOWN);
  assert.equal(payload.exit_code, null);
  assert.deepEqual(eventsFor(one, "execution.completed"), []);
  assert.deepEqual(eventsFor(one, "execution.failed"), []);
  assertClean(one);
});

test("workspace-commit-unknown is a member of the closed indeterminate reason set", () => {
  assert.deepEqual([...INDETERMINATE_REASONS], ["act-threw", "workspace-commit-unknown"]);
});

test("a failed apply that rolls back cleanly is a failure, not an unknown", () => {
  const one = unit(policyText("autonomous"));
  writeFileSync(join(one.root, "a.txt"), "a-old");
  writeFileSync(join(one.root, "b.txt"), "b-old");
  const result = apply(one, [
    { kind: "replace", path: "a.txt", expected_before_sha256: sha("a-old"), after_base64: b64("a-new") },
    { kind: "replace", path: "b.txt", expected_before_sha256: sha("b-old"), after_base64: b64("b-new") },
  ], {
    // Throw after the first rename but leave the staged preimages in place, so
    // the rollback can prove the before-state.
    onStep: (step) => {
      if (step === 1) throw new Error("simulated failure with a survivable rollback");
    },
  });
  const refusal = refused(result, "commit-not-applied");
  assert.equal(refusal.state, "before");
  assert.equal(readFileSync(join(one.root, "a.txt"), "utf8"), "a-old");
  assert.equal(readFileSync(join(one.root, "b.txt"), "utf8"), "b-old");
  assert.equal(eventsFor(one, "execution.failed").length, 1);
  assert.deepEqual(eventsFor(one, "execution.indeterminate"), []);
  assertClean(one);
});

test("a mixed commit retains the journal and the lock, and recovery only reports", () => {
  const one = unit(policyText("autonomous"));
  writeFileSync(join(one.root, "a.txt"), "a-old");
  writeFileSync(join(one.root, "b.txt"), "b-old");
  const operations = [
    { kind: "replace", path: "a.txt", expected_before_sha256: sha("a-old"), after_base64: b64("a-new") },
    { kind: "replace", path: "b.txt", expected_before_sha256: sha("b-old"), after_base64: b64("b-new") },
  ];
  refused(apply(one, operations, {
    onStep: (step) => {
      if (step !== 1) return;
      // The first operation has taken and its staged preimage is gone, so the
      // rollback cannot prove the before-state either.
      rmSync(join(one.root, WORKSPACE_TXN_DIR, "old-0"), { force: true });
      throw new Error("simulated crash with no way back");
    },
  }), "commit-unknown");

  assert.equal(existsSync(join(one.root, WORKSPACE_TXN_DIR, "journal.json")), true);
  assert.equal(existsSync(join(one.root, WORKSPACE_LOCK_FILE)), true);

  const recovered = recoverWorkspaceCommit(one.root);
  assert.equal(recovered.ok, true);
  if (!recovered.ok || recovered.state === "none") assert.fail("expected a journal");
  assert.equal(recovered.state, "mixed");
  assert.deepEqual(recovered.inspection.endpoints.map((entry) => entry.state), ["after", "before"]);
  // Recovery changed nothing.
  assert.equal(readFileSync(join(one.root, "a.txt"), "utf8"), "a-new");
  assert.equal(readFileSync(join(one.root, "b.txt"), "utf8"), "b-old");
  assert.equal(inspectWorkspaceState(recovered.journal).state, "mixed");

  // And the held lock fails the next brokered change closed.
  refused(apply(one, [{ kind: "create", path: "later.txt", after_base64: b64("later") }]), "custody-contended");
});

test("recovery on a settled workspace reports none and touches nothing", () => {
  const one = unit(policyText("autonomous"));
  const result = apply(one, [{ kind: "create", path: "x.txt", after_base64: b64("x") }]);
  assert.equal(result.ok, true);
  const recovered = recoverWorkspaceCommit(one.root);
  assert.equal(recovered.ok, true);
  if (recovered.ok) assert.equal(recovered.state, "none");
  assert.deepEqual(workspaceEntries(one), ["x.txt"]);
});

test("a later leg refusing to start leaves the workspace untouched by construction", () => {
  // Two classes, both manual, and a token for only one of them. The first leg
  // starts, the second refuses, and no filesystem operation is attempted.
  const one = unit([
    "# Two manual classes",
    "",
    "```yaml approval-policy",
    'version: "0.1"',
    "defaults:",
    "  autonomy: manual",
    "protected_paths:",
    "  - { path: docs/, class: policy.edit.docs }",
    "classes:",
    "  files.write.workspace: { autonomy: manual }",
    "  policy.edit.docs: { autonomy: manual }",
    "```",
    "",
  ].join("\n"));
  mkdirSync(join(one.root, "docs"));
  const operations = [
    { kind: "create", path: "plain.txt", after_base64: b64("plain") },
    { kind: "create", path: "docs/note.md", after_base64: b64("note") },
  ];
  refused(apply(one, operations), "approval-required");
  const tokens = grantAll(one, ["files.write.workspace", "policy.edit.docs"]);
  // Corrupt exactly one token: the other leg still starts first.
  const bad = { ...tokens, "policy.edit.docs": "not-a-real-token" };
  const refusal = refused(apply(one, operations, { tokens: bad }), "start-refused");
  assert.match(refusal.message, /No workspace operation was attempted/u);
  assert.equal(existsSync(join(one.root, "plain.txt")), false);
  assert.equal(existsSync(join(one.root, "docs", "note.md")), false);
  // One leg started and was closed failed; nothing dangles.
  assert.equal(eventsFor(one, "execution.started").length, 1);
  assert.equal(eventsFor(one, "execution.failed").length, 1);
  assertClean(one);
});

test("the broker never writes into the gate's own directory", () => {
  const one = unit(policyText("autonomous"));
  const result = apply(one, [{ kind: "create", path: "x.txt", after_base64: b64("x") }]);
  assert.equal(result.ok, true);
  const task = tasksOf(one)[0] as string;
  assert.equal(task, brokerTaskId("probe", (result as { payload_hash: string }).payload_hash));
  assert.deepEqual(workspaceEntries(one), ["x.txt"]);
});
