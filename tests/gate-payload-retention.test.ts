/** APRV-316: nonmanual intake retains supplied bytes for later execution evidence. */

import assert from "node:assert/strict";
import { lstatSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { appendAttestation } from "../src/core/attest.js";
import { register, request } from "../src/core/gate.js";
import { payloadHash } from "../src/core/payload.js";
import {
  loadPayload,
  payloadPath,
  payloadStoreDirFor,
  storeReference,
} from "../src/core/payload-store.js";
import { verifyWithRecords } from "../src/core/verify.js";
import { at, fixedClock, newScenario, scratchRoot } from "./scenario.js";

const AGENT = "agent:claude-code";
const HUMAN = "human:carter";

const POLICY = [
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "1h"',
  "  on_expiry: reject",
  "classes:",
  "  files.write.*:",
  "    autonomy: supervised",
  "```",
  "",
].join("\n");

function ready(label: string, material: unknown, cls = "files.write.workspace") {
  const scratch = scratchRoot(label);
  const unit = newScenario(scratch.root, POLICY);
  const attested = appendAttestation(unit.logPath, unit.policyPath, HUMAN, {
    clock: fixedClock(at(0)),
  });
  assert.equal(attested.ok, true, JSON.stringify(attested));
  const hash = payloadHash(material);
  const task = `retain:${label}`;
  const actionKey = `${task}:write`;
  const registered = register(
    unit.logPath,
    {
      task,
      envelope: {
        origin: { app: "test", created_by: AGENT },
        state: "proposed",
        actions: [{
          class: cls,
          summary: "Retain exact file edit",
          reversible: true,
          est_cost_usd: "0",
          idempotency_key: actionKey,
          payload_hash: hash,
        }],
      },
    },
    AGENT,
    { ...unit.options, clock: fixedClock(at(1)) },
  );
  assert.equal(registered.ok, true, JSON.stringify(registered));
  return { scratch, unit, hash, task, actionKey, cls };
}

function admit(
  setup: ReturnType<typeof ready>,
  material: unknown,
  overrides: { cls?: string; payloadStoreDir?: string } = {},
) {
  return request(
    setup.unit.logPath,
    {
      task: setup.task,
      actionKey: setup.actionKey,
      cls: overrides.cls ?? setup.cls,
      payload: { value: material },
    },
    AGENT,
    {
      ...setup.unit.options,
      clock: fixedClock(at(2)),
      ...(overrides.payloadStoreDir === undefined
        ? {}
        : { payloadStoreDir: overrides.payloadStoreDir }),
    },
  );
}

test("successful nonmanual intake retains exact registered material without an approval event", () => {
  const material = { tool: "Edit", rule: "protected path", file: "SPEC.md", before: "old", after: "new" };
  const setup = ready("payload-retain", material);
  try {
    const before = verifyWithRecords(setup.unit.logPath).records.length;
    const result = admit(setup, material);
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.proceed, true);
    assert.equal(result.record, null);
    assert.equal(verifyWithRecords(setup.unit.logPath).records.length, before);
    const loaded = loadPayload(payloadStoreDirFor(setup.unit.logPath), setup.hash);
    assert.equal(loaded.ok, true, JSON.stringify(loaded));
    if (loaded.ok) assert.deepEqual(loaded.value, material);

    // A second intake finds the same verified content and leaves it valid.
    const again = admit(setup, material);
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal(loadPayload(payloadStoreDirFor(setup.unit.logPath), setup.hash).ok, true);
  } finally {
    setup.scratch.cleanup();
  }
});

test("nonmanual intake with no supplied material preserves its existing proceed behavior", () => {
  const scratch = scratchRoot("payload-omitted");
  try {
    const unit = newScenario(scratch.root, POLICY);
    const attested = appendAttestation(unit.logPath, unit.policyPath, HUMAN, {
      clock: fixedClock(at(0)),
    });
    assert.equal(attested.ok, true, JSON.stringify(attested));
    const before = verifyWithRecords(unit.logPath).records.length;
    const result = request(
      unit.logPath,
      { task: "unregistered", actionKey: "unregistered:write", cls: "files.write.workspace" },
      AGENT,
      { ...unit.options, clock: fixedClock(at(1)) },
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    if (result.ok) assert.equal(result.proceed, true);
    assert.equal(verifyWithRecords(unit.logPath).records.length, before);
  } finally {
    scratch.cleanup();
  }
});

test("caller payload_hash cannot replace a missing registered hash for retained material", () => {
  const scratch = scratchRoot("payload-missing-declared-hash");
  const material = { tool: "Write", file: "SPEC.md", content: "new\n" };
  const hash = payloadHash(material);
  try {
    const unit = newScenario(scratch.root, POLICY);
    const attested = appendAttestation(unit.logPath, unit.policyPath, HUMAN, {
      clock: fixedClock(at(0)),
    });
    assert.equal(attested.ok, true, JSON.stringify(attested));
    const task = "retain:missing-declared-hash";
    const actionKey = `${task}:write`;
    const registered = register(
      unit.logPath,
      {
        task,
        envelope: {
          origin: { app: "test", created_by: AGENT },
          state: "proposed",
          actions: [{
            class: "files.write.workspace",
            summary: "Missing declared hash",
            reversible: true,
            est_cost_usd: "0",
            idempotency_key: actionKey,
          }],
        },
      },
      AGENT,
      { ...unit.options, clock: fixedClock(at(1)) },
    );
    assert.equal(registered.ok, true, JSON.stringify(registered));
    const before = verifyWithRecords(unit.logPath).records.length;
    const result = request(
      unit.logPath,
      {
        task,
        actionKey,
        cls: "files.write.workspace",
        payload_hash: hash,
        payload: { value: material },
      },
      AGENT,
      { ...unit.options, clock: fixedClock(at(2)) },
    );
    assert.equal(result.ok, false, JSON.stringify(result));
    if (!result.ok) assert.equal(result.code, "payload-hash-required");
    assert.equal(loadPayload(payloadStoreDirFor(unit.logPath), hash).ok, false);
    assert.equal(verifyWithRecords(unit.logPath).records.length, before);
  } finally {
    scratch.cleanup();
  }
});

test("nonmanual retention refuses mismatched, unserializable, or class-mismatched material", () => {
  const material = { tool: "Write", rule: "protected path", file: "SPEC.md", content: "new\n" };
  for (const [label, supplied, cls, code] of [
    ["mismatch", { ...material, content: "other\n" }, undefined, "payload-mismatch"],
    ["class", material, "files.write.other", "action-not-registered"],
  ] as const) {
    const setup = ready(`payload-${label}`, material);
    try {
      const before = verifyWithRecords(setup.unit.logPath).records.length;
      const result = admit(setup, supplied, cls === undefined ? {} : { cls });
      assert.equal(result.ok, false, JSON.stringify(result));
      if (!result.ok) assert.equal(result.code, code);
      assert.equal(verifyWithRecords(setup.unit.logPath).records.length, before);
      assert.equal(loadPayload(payloadStoreDirFor(setup.unit.logPath), setup.hash).ok, false);
    } finally {
      setup.scratch.cleanup();
    }
  }

  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  const setup = ready("payload-cycle", material);
  try {
    const result = admit(setup, cyclic);
    assert.equal(result.ok, false, JSON.stringify(result));
    if (!result.ok) assert.equal(result.code, "payload-store-failed");
  } finally {
    setup.scratch.cleanup();
  }
});

test("nonmanual retention never replaces corrupt, referenced, or unreadable existing material", () => {
  const material = { tool: "Edit", rule: "protected path", file: "SPEC.md", before: "old", after: "new" };
  for (const mode of ["corrupt", "reference", "unreadable"] as const) {
    const setup = ready(`payload-existing-${mode}`, material);
    try {
      const storeDir = payloadStoreDirFor(setup.unit.logPath);
      if (mode === "corrupt") {
        mkdirSync(storeDir, { recursive: true });
        writeFileSync(payloadPath(storeDir, setup.hash), '{"different":true}\n', "utf8");
      } else if (mode === "reference") {
        const stored = storeReference(storeDir, setup.hash, "vault://payload/example");
        assert.equal(stored.ok, true, JSON.stringify(stored));
      } else {
        mkdirSync(payloadPath(storeDir, setup.hash), { recursive: true });
      }
      const before = verifyWithRecords(setup.unit.logPath).records.length;
      const result = admit(setup, material);
      assert.equal(result.ok, false, `${mode}: ${JSON.stringify(result)}`);
      if (!result.ok) assert.equal(result.code, "payload-store-failed");
      assert.equal(verifyWithRecords(setup.unit.logPath).records.length, before);
    } finally {
      setup.scratch.cleanup();
    }
  }
});

test("nonmanual retention preserves a dangling payload-store symlink", () => {
  const material = { tool: "Edit", file: "SPEC.md", before: "old", after: "new" };
  const setup = ready("payload-existing-dangling", material);
  try {
    const storeDir = payloadStoreDirFor(setup.unit.logPath);
    mkdirSync(storeDir, { recursive: true });
    const path = payloadPath(storeDir, setup.hash);
    symlinkSync(join(setup.unit.dir, "missing-payload-target"), path);
    const before = verifyWithRecords(setup.unit.logPath).records.length;
    const result = admit(setup, material);
    assert.equal(result.ok, false, JSON.stringify(result));
    if (!result.ok) assert.equal(result.code, "payload-store-failed");
    assert.equal(lstatSync(path).isSymbolicLink(), true);
    assert.equal(verifyWithRecords(setup.unit.logPath).records.length, before);
  } finally {
    setup.scratch.cleanup();
  }
});

test("nonmanual retention refuses a storage failure and appends nothing", () => {
  const material = { tool: "Write", rule: "protected path", file: "SPEC.md", content: "new\n" };
  const setup = ready("payload-store-failure", material);
  try {
    const blocker = join(setup.unit.dir, "not-a-directory");
    writeFileSync(blocker, "blocked", "utf8");
    const before = verifyWithRecords(setup.unit.logPath).records.length;
    const result = admit(setup, material, { payloadStoreDir: blocker });
    assert.equal(result.ok, false, JSON.stringify(result));
    if (!result.ok) assert.equal(result.code, "payload-store-failed");
    assert.equal(verifyWithRecords(setup.unit.logPath).records.length, before);
  } finally {
    setup.scratch.cleanup();
  }
});
