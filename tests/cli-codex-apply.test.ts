/**
 * APRV-325.2: `approval codex apply`, `recover` and `serve` through the real CLI.
 *
 * `tests/codex-broker.test.ts` drives the broker in process. This suite drives
 * it the way a host does: a scratch instance manifest under `$TMPDIR`, a real
 * `APPROVAL.md`, a real attested log, and `approval` spawned as a child, so the
 * argv parsing, the exit codes and the `--json` shapes are the ones an operator
 * and the strict server actually meet.
 *
 * Nothing here touches this machine's own gate, Codex trust state or any
 * configuration outside the scratch directory.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

import { BROKER_TOOL, BROKER_TOOL_NAME, createCodexBrokerServer } from "../src/codex/serve.js";
import { appendAttestation } from "./clock-adapters.js";

const CLI = join(fileURLToPath(new URL("../../", import.meta.url)), "cli.js");
const scratch = mkdtempSync(join(tmpdir(), "approval-md-cli-codex-apply-"));
let serial = 0;

after(() => rmSync(scratch, { recursive: true, force: true }));

const POLICY = [
  "# Broker CLI policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  "classes:",
  "  files.write.workspace:",
  "    autonomy: autonomous",
  "    allow_irreversible: true",
  "```",
  "",
].join("\n");

function sha(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface Instance {
  dir: string;
  root: string;
  manifestPath: string;
  policySha256: string;
}

/**
 * A scratch instance: a manifest whose roots are disjoint and whose policy and
 * log are real, built entirely under `$TMPDIR`.
 */
function instance(): Instance {
  serial += 1;
  const dir = realpathSync(mkdtempSync(join(scratch, `instance-${String(serial)}-`)));
  const install = join(dir, "install");
  const primary = join(dir, "primary");
  const workspace = join(dir, "workspace");
  mkdirSync(join(install, "bin"), { recursive: true });
  mkdirSync(join(primary, ".approval", "log"), { recursive: true });
  mkdirSync(workspace, { recursive: true });

  const policyPath = join(primary, "APPROVAL.md");
  writeFileSync(policyPath, POLICY, "utf8");
  const logPath = join(primary, ".approval", "log", "events.jsonl");
  const attested = appendAttestation(logPath, policyPath, "human:carter", "2026-09-16T10:00:00.000Z");
  assert.equal(attested.ok, true, "attestation append failed");

  const manifestPath = join(install, "instance.json");
  const mcp = join(install, "bin", "approval");
  writeFileSync(manifestPath, `${JSON.stringify({
    schema_version: "approval.codex.instance.v1",
    instance_id: "scratch",
    platform: "darwin",
    codex_version: "0.152.1",
    node_version: "22.0.0",
    package_version: "0.2.0",
    paths: {
      install_root: install,
      package_root: join(install, "pkg"),
      workspace,
      primary,
      policy: policyPath,
      log: logPath,
      manifest: manifestPath,
      codex_executable: join(install, "bin", "codex"),
      node_executable: join(install, "bin", "node"),
      mcp_executable: mcp,
      broker_executable: join(install, "bin", "broker"),
      runner_executable: join(install, "bin", "runner"),
    },
    principals: { codex: "_approval_codex", broker: "_approval_broker", runner: "_approval_runner" },
    invocation: { command: mcp, args: ["codex", "serve", "--manifest", manifestPath] },
    components: { broker: "required-not-shipped", runner: "required-not-shipped" },
  }, null, 2)}\n`, "utf8");

  return { dir, root: workspace, manifestPath, policySha256: sha(readFileSync(policyPath)) };
}

function run(argv: readonly string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...argv], { encoding: "utf8" });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function proposalFile(unit: Instance, operations: unknown, extra: Record<string, unknown> = {}): string {
  const path = join(unit.dir, `proposal-${String(serial)}-${String(Math.random()).slice(2)}.json`);
  writeFileSync(path, JSON.stringify({
    operations,
    expected_policy_sha256: unit.policySha256,
    ...extra,
  }), "utf8");
  return path;
}

function b64(value: string): string {
  return Buffer.from(value).toString("base64");
}

test("apply writes exactly the proposed change and reports its legs and custody", () => {
  const unit = instance();
  writeFileSync(join(unit.root, "keep.txt"), "old", "utf8");
  const proposal = proposalFile(unit, [
    { kind: "create", path: "made.txt", after_base64: b64("made") },
    { kind: "replace", path: "keep.txt", expected_before_sha256: sha("old"), after_base64: b64("new") },
  ]);
  const result = run(["codex", "apply", "--manifest", unit.manifestPath, "--proposal", proposal, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim()) as {
    ok: boolean; state: string; legs: { class: string }[]; custody: { kind: string; findings: string[] };
  };
  assert.equal(payload.ok, true);
  assert.equal(payload.state, "after");
  assert.deepEqual(payload.legs.map((leg) => leg.class), ["files.write.workspace"]);
  assert.ok(payload.custody.findings.includes("acl-unproven"));
  assert.equal(readFileSync(join(unit.root, "made.txt"), "utf8"), "made");
  assert.equal(readFileSync(join(unit.root, "keep.txt"), "utf8"), "new");
});

test("apply refuses an unknown property in the proposal rather than ignoring it", () => {
  const unit = instance();
  const proposal = proposalFile(unit, [{ kind: "create", path: "x.txt", after_base64: b64("x") }], {
    actor: "human:carter",
  });
  const result = run(["codex", "apply", "--manifest", unit.manifestPath, "--proposal", proposal, "--json"]);
  assert.equal(result.status, 1);
  const error = (JSON.parse(result.stderr.trim()) as { error: { code: string; message: string } }).error;
  assert.equal(error.code, "input-invalid");
  assert.match(error.message, /unknown property "actor"/u);
  assert.equal(existsSync(join(unit.root, "x.txt")), false);
});

test("apply refuses a manifest it cannot validate and names the failing member", () => {
  const unit = instance();
  const broken = join(unit.dir, "broken.json");
  const manifest = JSON.parse(readFileSync(unit.manifestPath, "utf8")) as { paths: Record<string, string> };
  manifest.paths["workspace"] = "relative/workspace";
  writeFileSync(broken, JSON.stringify(manifest), "utf8");
  const proposal = proposalFile(unit, [{ kind: "create", path: "x.txt", after_base64: b64("x") }]);
  const result = run(["codex", "apply", "--manifest", broken, "--proposal", proposal, "--json"]);
  assert.equal(result.status, 1);
  assert.equal((JSON.parse(result.stderr.trim()) as { error: { code: string } }).error.code, "manifest-invalid");
});

test("apply refuses a proposal built against a different policy digest", () => {
  const unit = instance();
  const path = join(unit.dir, "drifted.json");
  writeFileSync(path, JSON.stringify({
    operations: [{ kind: "create", path: "x.txt", after_base64: b64("x") }],
    expected_policy_sha256: "c".repeat(64),
  }), "utf8");
  const result = run(["codex", "apply", "--manifest", unit.manifestPath, "--proposal", path, "--json"]);
  assert.equal(result.status, 1);
  assert.equal((JSON.parse(result.stderr.trim()) as { error: { code: string } }).error.code, "attestation-drift");
  assert.equal(existsSync(join(unit.root, "x.txt")), false);
});

test("apply refuses an unreadable proposal file with an I/O exit code", () => {
  const unit = instance();
  const result = run(["codex", "apply", "--manifest", unit.manifestPath, "--proposal", join(unit.dir, "absent.json"), "--json"]);
  assert.equal(result.status, 4);
  assert.equal((JSON.parse(result.stderr.trim()) as { error: { code: string } }).error.code, "proposal-unreadable");
});

test("apply requires both flags and rejects a malformed --token", () => {
  const unit = instance();
  const proposal = proposalFile(unit, []);
  assert.equal(run(["codex", "apply", "--proposal", proposal, "--json"]).status, 2);
  assert.equal(run(["codex", "apply", "--manifest", unit.manifestPath, "--json"]).status, 2);
  const bad = run(["codex", "apply", "--manifest", unit.manifestPath, "--proposal", proposal, "--token", "no-equals", "--json"]);
  assert.equal(bad.status, 2);
  assert.equal((JSON.parse(bad.stderr.trim()) as { error: { code: string } }).error.code, "usage");
});

test("recover reports no journal on a settled workspace and exits 0", () => {
  const unit = instance();
  const result = run(["codex", "recover", "--manifest", unit.manifestPath, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim()) as { ok: boolean; state: string };
  assert.equal(payload.ok, true);
  assert.equal(payload.state, "none");
});

test("start still refuses codex-not-ready: the broker is not a confined runner", () => {
  const unit = instance();
  const result = run(["codex", "start", "--manifest", unit.manifestPath, "--json"]);
  assert.equal(result.status, 1);
  const error = (JSON.parse(result.stderr.trim()) as { error: { code: string; message: string } }).error;
  assert.equal(error.code, "codex-not-ready");
  assert.match(error.message, /APRV-325\.3/u);
});

test("the strict server publishes exactly one tool, with no authority in its schema", () => {
  const server = createCodexBrokerServer({
    installation: {
      instanceId: "scratch",
      actor: "agent:codex-scratch",
      root: "/var/empty",
      policyPath: "/var/empty/APPROVAL.md",
      logPath: "/var/empty/.approval/log/events.jsonl",
    },
  });
  assert.ok(server);
  assert.equal(BROKER_TOOL.name, BROKER_TOOL_NAME);
  const schema = BROKER_TOOL.inputSchema as unknown as {
    additionalProperties: boolean; required: string[]; properties: Record<string, unknown>;
  };
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required.sort(), ["expected_policy_sha256", "operations"]);
  assert.deepEqual(Object.keys(schema.properties).sort(), ["expected_policy_sha256", "operations"]);
  for (const forbidden of ["as", "actor", "root", "policy", "log", "class", "token", "sandbox", "cwd"]) {
    assert.equal(forbidden in schema.properties, false, `${forbidden} is published`);
  }
});
