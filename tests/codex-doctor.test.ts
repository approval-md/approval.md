import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { strictDoctor } from "../src/codex/doctor.js";
import type { CodexInstanceManifest } from "../src/codex/manifest.js";
import {
  diagnoseCodexInstance,
  parseCodexVersionOutput,
  parseNodeVersionOutput,
} from "../src/codex/trust.js";

function fixture(root: string): CodexInstanceManifest {
  const install = join(root, "install");
  const primary = join(root, "primary");
  const workspace = join(root, "workspace");
  const manifest = join(install, "instances", "team.json");
  const mcp = join(install, "bin", "approval-codex-mcp");
  return {
    schema_version: "approval.codex.instance.v1", instance_id: "team", platform: "darwin",
    codex_version: "0.152.1", node_version: "20.19.0", package_version: "0.1.0",
    paths: {
      install_root: install, package_root: join(install, "package"), workspace, primary,
      policy: join(primary, "APPROVAL.md"), log: join(primary, ".approval/log/events.jsonl"),
      manifest, codex_executable: join(install, "bin/codex"),
      node_executable: join(install, "bin/node"), mcp_executable: mcp,
      broker_executable: join(install, "bin/approval-codex-broker"),
      runner_executable: join(install, "bin/approval-codex-runner"),
    },
    principals: { codex: "_approval_codex", broker: "_approval_broker", runner: "_approval_runner" },
    invocation: { command: mcp, args: ["codex", "serve", "--manifest", manifest] },
    components: { broker: "required-not-shipped", runner: "required-not-shipped" },
  };
}

test("doctor never executes binaries whose custody is untrusted", () => {
  const root = mkdtempSync(join(tmpdir(), "approval-codex-doctor-"));
  const manifest = fixture(root);
  const marker = join(root, "unsafe-executable-ran");
  mkdirSync(manifest.paths.workspace, { recursive: true });
  mkdirSync(manifest.paths.primary, { recursive: true });
  mkdirSync(manifest.paths.package_root, { recursive: true });
  for (const path of [manifest.paths.codex_executable, manifest.paths.node_executable]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`, { mode: 0o755 });
  }
  const report = diagnoseCodexInstance(manifest, {
    resolveUid: (name) => ({ _approval_codex: 501, _approval_broker: 502, _approval_runner: 503 })[name] ?? null,
    groupsFor: () => [20],
  });
  assert.equal(existsSync(marker), false);
  assert.ok(report.findings.some((finding) => finding.code === "codex-version-unchecked"));
  assert.ok(report.findings.some((finding) => finding.code === "node-version-unchecked"));
  assert.ok(report.findings.some((finding) => finding.code === "workspace-custody-unproven"));
  assert.ok(report.findings.some((finding) => finding.code === "broker-not-ready"));
  assert.ok(report.findings.some((finding) => finding.code === "runner-not-ready"));
});

test("doctor rejects a manifest read from any path other than its pinned path", () => {
  const root = mkdtempSync(join(tmpdir(), "approval-codex-doctor-path-"));
  const manifest = fixture(root);
  const other = join(root, "other.json");
  writeFileSync(other, `${JSON.stringify(manifest)}\n`);
  const result = strictDoctor(other);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "manifest-path-drift");
});

test("doctor reports symlinked paths and refuses root service principals", () => {
  const root = mkdtempSync(join(tmpdir(), "approval-codex-doctor-link-"));
  const manifest = fixture(root);
  mkdirSync(manifest.paths.install_root, { recursive: true });
  mkdirSync(manifest.paths.workspace, { recursive: true });
  mkdirSync(manifest.paths.primary, { recursive: true });
  symlinkSync(manifest.paths.install_root, join(root, "install-link"));
  manifest.paths.package_root = join(root, "install-link/package");
  const report = diagnoseCodexInstance(manifest, {
    resolveUid: () => 0,
    groupsFor: () => [0],
  });
  assert.ok(report.findings.some((finding) => finding.code === "path-symlink"));
  assert.ok(report.findings.some((finding) => finding.code === "principal-root"));
  assert.ok(report.findings.some((finding) => finding.code === "principal-overlap"));
});

test("version output parsers accept only one exact version line", () => {
  assert.equal(parseCodexVersionOutput("codex-cli 0.152.1\n", ""), "0.152.1");
  assert.equal(parseCodexVersionOutput("prefix codex-cli 0.152.1\n", ""), null);
  assert.equal(parseCodexVersionOutput("codex-cli 0.152.1 suffix\n", ""), null);
  assert.equal(parseCodexVersionOutput("codex-cli 0.152.1\n", "warning"), null);
  assert.equal(parseNodeVersionOutput("v20.19.0\n", ""), "20.19.0");
  assert.equal(parseNodeVersionOutput("v20.19.0 extra\n", ""), null);
});
