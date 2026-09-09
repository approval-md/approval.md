import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  checkCodexInstance,
  type CodexInstanceManifest,
} from "../src/codex/manifest.js";

function fixture(): CodexInstanceManifest {
  const install = "/Library/Application Support/approval-codex";
  const manifest = `${install}/instances/team.json`;
  const mcp = `${install}/bin/approval-codex-mcp`;
  return {
    schema_version: "approval.codex.instance.v1",
    instance_id: "team",
    platform: "darwin",
    codex_version: "0.152.1",
    node_version: "20.19.0",
    package_version: "0.1.0",
    paths: {
      install_root: install,
      package_root: `${install}/package`,
      workspace: "/Users/_approval_codex/workspace",
      primary: "/Users/operator/approval-primary",
      policy: "/Users/operator/approval-primary/APPROVAL.md",
      log: "/Users/operator/approval-primary/.approval/log/events.jsonl",
      manifest,
      codex_executable: `${install}/bin/codex`,
      node_executable: `${install}/bin/node`,
      mcp_executable: mcp,
      broker_executable: `${install}/bin/approval-codex-broker`,
      runner_executable: `${install}/bin/approval-codex-runner`,
    },
    principals: {
      codex: "_approval_codex",
      broker: "_approval_broker",
      runner: "_approval_runner",
    },
    invocation: { command: mcp, args: ["codex", "serve", "--manifest", manifest] },
    components: { broker: "required-not-shipped", runner: "required-not-shipped" },
  };
}

test("Codex instance schema and semantic checks accept the pinned contract", () => {
  assert.deepEqual(checkCodexInstance(fixture()), { ok: true, manifest: fixture() });
});

test("Codex manifest rejects invocation drift and roots that overlap", () => {
  const drifted = fixture();
  drifted.invocation.args = ["codex", "serve", "--manifest", "/tmp/other.json"];
  const drift = checkCodexInstance(drifted);
  assert.equal(drift.ok, false);
  if (!drift.ok) assert.ok(drift.errors.some((error) => error.path === "/invocation"));

  const overlap = fixture();
  overlap.paths.workspace = resolve(overlap.paths.primary, "agent-worktree");
  const checked = checkCodexInstance(overlap);
  assert.equal(checked.ok, false);
  if (!checked.ok) assert.ok(checked.errors.some((error) => error.path === "/paths"));
});

test("Codex manifest rejects unpinned versions, platforms, interpreters and paths", () => {
  for (const mutate of [
    (value: Record<string, unknown>) => { value["platform"] = "linux"; },
    (value: Record<string, unknown>) => { value["codex_version"] = "0.153.0"; },
    (value: Record<string, unknown>) => { value["node_version"] = "19.9.0"; },
  ]) {
    const value = fixture() as unknown as Record<string, unknown>;
    mutate(value);
    assert.equal(checkCodexInstance(value).ok, false);
  }
  const outside = fixture();
  outside.paths.node_executable = "/usr/bin/node";
  const checked = checkCodexInstance(outside);
  assert.equal(checked.ok, false);
  if (!checked.ok) {
    assert.ok(checked.errors.some((error) => error.path === "/paths/node_executable"));
  }
});
