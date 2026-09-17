import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { publishedVerbs } from "../src/mcp/server.js";
import { manifestFor } from "../src/codex/templates.js";
import { checkBundle, prepareBundle } from "../src/codex/templates.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = join(ROOT, "cli.js");

function cleanEnv(cache?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["APPROVAL_HUMAN"];
  if (cache !== undefined) env["npm_config_cache"] = cache;
  return env;
}

test("prepare creates a closed inert bundle and setup detects tampering", () => {
  const root = mkdtempSync(join(tmpdir(), "approval-codex-package-"));
  const result = prepareBundle({
    instanceId: "team", workspace: join(root, "workspace"), primary: join(root, "primary"),
    installRoot: join(root, "install"), output: join(root, "review"),
    codexExecutable: join(root, "install/bin/codex"), nodeExecutable: join(root, "install/bin/node"),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const checked = checkBundle(result.output);
  assert.equal(checked.ok, true);
  assert.equal(existsSync(join(result.output, "bundle-sha256.json")), true);
  mkdirSync(join(result.output, "unexpected-directory"));
  const extra = checkBundle(result.output);
  assert.equal(extra.ok, false);
  if (!extra.ok) assert.equal(extra.code, "bundle-file-set");
  rmSync(join(result.output, "unexpected-directory"), { recursive: true });
  writeFileSync(join(result.output, "managed_config.toml"), "tampered\n");
  const tampered = checkBundle(result.output);
  assert.equal(tampered.ok, false);
  if (!tampered.ok) assert.equal(tampered.code, "bundle-hash-mismatch");
  const index = join(result.output, "bundle-sha256.json");
  const movedIndex = join(root, "moved-index.json");
  writeFileSync(movedIndex, readFileSync(index));
  unlinkSync(index);
  symlinkSync(movedIndex, index);
  const linkedIndex = checkBundle(result.output);
  assert.equal(linkedIndex.ok, false);
  if (!linkedIndex.ok) assert.equal(linkedIndex.code, "bundle-index-unreadable");
});

test("prepare and setup --check expose the inert contract through the real CLI", () => {
  const root = mkdtempSync(join(tmpdir(), "approval-codex-cli-"));
  const output = join(root, "review");
  const install = join(root, "install");
  const prepared = spawnSync(process.execPath, [
    CLI, "codex", "prepare", "--instance", "team", "--workspace", join(root, "workspace"),
    "--primary", join(root, "primary"), "--install-root", install, "--output", output,
    "--codex", join(install, "bin/codex"), "--node", join(install, "bin/node"), "--json",
  ], { cwd: root, encoding: "utf8", env: cleanEnv() });
  assert.equal(prepared.status, 0, prepared.stderr);
  const prepareJson = JSON.parse(prepared.stdout) as { ok: boolean; inert: boolean; output: string };
  assert.deepEqual({ ok: prepareJson.ok, inert: prepareJson.inert }, { ok: true, inert: true });
  const checked = spawnSync(process.execPath, [CLI, "codex", "setup", "--check", prepareJson.output, "--json"], {
    cwd: root, encoding: "utf8", env: cleanEnv(),
  });
  assert.equal(checked.status, 0, checked.stderr);
  const setupJson = JSON.parse(checked.stdout) as { ok: boolean; inert: boolean; ready: boolean };
  assert.deepEqual(setupJson, { ...setupJson, ok: true, inert: true, ready: false });
});

test("generated launcher shell-quotes hostile pinned paths and forwards arguments", () => {
  const root = mkdtempSync(join(tmpdir(), "approval-codex-quote-"));
  const marker = join(root, "SHOULD-NOT-EXIST");
  const install = join(root, `install-$(${"touch"} ${marker})-\`touch ${marker}\`-'quote`);
  const output = join(root, "review");
  const node = join(install, "bin/node");
  mkdirSync(join(install, "bin"), { recursive: true });
  mkdirSync(join(install, "package"), { recursive: true });
  const captured = join(root, "argv.json");
  writeFileSync(node, `#!/bin/sh\nprintf '%s\\n' "$@" > '${captured}'\n`, { mode: 0o755 });
  const result = prepareBundle({
    instanceId: "team", workspace: join(root, "workspace"), primary: join(root, "primary"),
    installRoot: install, output,
    codexExecutable: join(install, "bin/codex"), nodeExecutable: node,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  for (const argv of [
    ["sandbox", "macos"],
    ["run", "--no-sandbox", "--", "touch", marker],
    ["codex", "serve", "--manifest", join(root, "alternate.json")],
  ]) {
    const refused = spawnSync(join(output, "approval-codex-mcp"), argv, {
      encoding: "utf8", env: { ...process.env, NODE_OPTIONS: `--require=${marker}` },
    });
    assert.equal(refused.status, 2);
    assert.equal(existsSync(captured), false, `pinned Node ran for rejected argv ${JSON.stringify(argv)}`);
  }
  const launch = spawnSync(join(output, "approval-codex-mcp"), result.manifest.invocation.args, {
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: `--require=${marker}`, NODE_PATH: marker, HOSTILE_SENTINEL: "must-be-scrubbed" },
  });
  assert.equal(launch.status, 0, launch.stderr);
  assert.equal(existsSync(marker), false);
  const launcher = readFileSync(join(output, "approval-codex-mcp"), "utf8");
  assert.match(launcher, /exec \/usr\/bin\/env -i PATH=\/usr\/bin:\/bin HOME=\/var\/empty TMPDIR=\/tmp/u);
  assert.match(launcher, /cd '/u);
  assert.deepEqual(readFileSync(captured, "utf8").trim().split("\n").slice(-4), result.manifest.invocation.args);
});

test("Codex family is omitted from broad MCP and unfinished entry points refuse", () => {
  // The WHOLE family, including APRV-325.2's `apply`, `recover` and `serve`.
  // The broker is reached through the strict server, which publishes exactly
  // one tool; a second door on the broad catalogue would defeat the first.
  assert.equal(publishedVerbs().some((verb) => verb.name === "codex"), false);
  // `start` still refuses codex-not-ready: the confined runner is APRV-325.3.
  const start = spawnSync(process.execPath, [CLI, "codex", "start", "--manifest", "/tmp/example.json", "--json"], { encoding: "utf8" });
  assert.equal(start.status, 1);
  assert.equal(JSON.parse(start.stderr).error.code, "codex-not-ready");
  // `serve`, `apply` and `recover` are implemented, and each still refuses a
  // manifest it cannot validate rather than inventing an installation.
  for (const argv of [
    ["serve", "--manifest", "/tmp/example.json", "--json"],
    ["recover", "--manifest", "/tmp/example.json", "--json"],
    ["apply", "--manifest", "/tmp/example.json", "--proposal", "/tmp/example-proposal.json", "--json"],
  ]) {
    const result = spawnSync(process.execPath, [CLI, "codex", ...argv], { encoding: "utf8" });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stderr).error.code, "manifest-invalid");
  }
});

test("manifest generation pins the supplied node executable below install root", () => {
  const root = mkdtempSync(join(tmpdir(), "approval-codex-manifest-for-"));
  const manifest = manifestFor({
    instanceId: "team", workspace: join(root, "workspace"), primary: join(root, "primary"),
    installRoot: join(root, "install"), output: join(root, "review"),
    codexExecutable: join(root, "install/bin/codex"), nodeExecutable: join(root, "install/bin/node"),
  });
  assert.equal(manifest.paths.node_executable, join(root, "install/bin/node"));
  assert.match(readFileSync(join(ROOT, "package.json"), "utf8"), /templates\/codex/u);
});

test("packed npm artifact installs without scripts and runs outside the checkout", { timeout: 120_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "approval-codex-tarball-"));
  const packDir = join(root, "pack");
  const outside = join(root, "installed-outside");
  const cache = join(root, "npm-cache");
  mkdirSync(packDir);
  mkdirSync(outside);
  const packed = spawnSync("npm", ["pack", "--json", "--pack-destination", packDir], {
    cwd: ROOT, encoding: "utf8", env: cleanEnv(cache), timeout: 60_000,
  });
  assert.equal(packed.status, 0, packed.stderr);
  const metadata = JSON.parse(packed.stdout) as Array<{ filename: string }>;
  const tarball = join(packDir, metadata[0]?.filename ?? "missing.tgz");
  const rootPackage = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  const dependencyCopies = join(root, "dependency-copies", "node_modules");
  mkdirSync(dependencyCopies, { recursive: true });
  const localDependencies: Record<string, string> = { "approval-md": `file:${tarball}` };
  const pending = Object.keys(rootPackage.dependencies);
  const seen = new Set<string>();
  while (pending.length > 0) {
    const name = pending.pop() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    const path = join(ROOT, "node_modules", name);
    const value = JSON.parse(readFileSync(join(path, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const copy = join(dependencyCopies, name);
    mkdirSync(join(copy, ".."), { recursive: true });
    cpSync(path, copy, { recursive: true, dereference: true });
    // npm 10 runs `prepare` for local directory dependencies even alongside
    // --ignore-scripts. These copies supply the already-installed runtime bytes
    // without letting an unrelated dependency rebuild itself in the checkout.
    delete value.scripts;
    writeFileSync(join(copy, "package.json"), `${JSON.stringify(value, null, 2)}\n`);
    localDependencies[name] = `file:${copy}`;
    pending.push(...Object.keys(value.dependencies ?? {}), ...Object.keys(value.optionalDependencies ?? {}));
  }
  writeFileSync(join(outside, "package.json"), `${JSON.stringify({ private: true, dependencies: localDependencies }, null, 2)}\n`);
  const installed = spawnSync("npm", [
    "install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock",
    "--offline", "--install-links=false",
  ], { cwd: outside, encoding: "utf8", env: cleanEnv(cache), timeout: 60_000 });
  assert.equal(installed.status, 0, installed.stderr);
  const packageRoot = join(outside, "node_modules/approval-md");
  for (const path of [
    "cli.js", "schema/codex-instance.schema.json", "docs/codex-enforced-session.md",
    "templates/codex/README.md", "dist/src/codex/manifest.js", "dist/src/cli/codex.js",
    // APRV-325.2: the broker, its durable transaction and its strict server all
    // have to be IN the tarball, because a packaged `codex serve` that could not
    // load one of them would refuse at the worst possible moment.
    "dist/src/codex/broker.js", "dist/src/codex/workspace-commit.js", "dist/src/codex/serve.js",
    "docs/codex-workspace-broker.md",
    // APRV-325.3: the confined runner, and the doc an operator activates from.
    "dist/src/codex/runner.js", "dist/src/core/sandbox.js",
  ]) {
    assert.equal(existsSync(join(packageRoot, path)), true, `${path} missing from installed tarball`);
  }
  const invoked = spawnSync(process.execPath, [join(packageRoot, "cli.js"), "codex", "--help"], {
    cwd: outside, encoding: "utf8", env: cleanEnv(), timeout: 10_000,
  });
  assert.equal(invoked.status, 0, invoked.stderr);
  assert.match(invoked.stdout, /prepare a constrained Codex host and broker its workspace writes/u);
  assert.match(invoked.stdout, /approval codex apply --manifest/u);

  // APRV-325.3: setup, doctor and start from the INSTALLED path, against a
  // scratch instance built here. This is the activation runbook's first three
  // commands, run as an operator runs them, from outside any checkout.
  const scratchInstance = join(root, "instance");
  const manifestPath = scratchCodexInstance(scratchInstance);

  const setup = spawnSync(process.execPath, [join(packageRoot, "cli.js"), "codex", "setup", "--check", scratchInstance, "--json"], {
    cwd: outside, encoding: "utf8", env: cleanEnv(), timeout: 20_000,
  });
  // The scratch tree is not a prepared bundle, so setup must REFUSE rather than
  // report an inert bundle it never verified.
  assert.equal(setup.status, 1, setup.stdout);
  assert.equal(typeof (JSON.parse(setup.stderr) as { error: { code: string } }).error.code, "string");

  const doctor = spawnSync(process.execPath, [join(packageRoot, "cli.js"), "codex", "doctor", "--strict", "--manifest", manifestPath, "--json"], {
    cwd: outside, encoding: "utf8", env: cleanEnv(), timeout: 20_000,
  });
  // Fail-closed by construction: the scratch install is not root-owned, so
  // doctor reports findings and refuses. A doctor that passed here would be the
  // bug, not the evidence.
  assert.equal(doctor.status, 1, doctor.stdout);
  const findings = (JSON.parse(doctor.stderr) as { ready: boolean; findings: { code: string }[] });
  assert.equal(findings.ready, false);
  assert.ok(findings.findings.some((finding) => finding.code === "owner-not-root"));

  const start = spawnSync(process.execPath, [join(packageRoot, "cli.js"), "codex", "start", "--manifest", manifestPath, "--json"], {
    cwd: outside, encoding: "utf8", env: cleanEnv(), timeout: 30_000,
  });
  if (process.platform === "darwin") {
    assert.equal(start.status, 0, start.stderr);
    const room = JSON.parse(start.stdout.trim()) as {
      ok: boolean; egress: string; write_allow: string[]; canonical: string;
    };
    assert.equal(room.ok, true);
    assert.equal(room.egress, "denied");
    assert.equal(room.write_allow.length, 1);
    assert.equal(room.write_allow.includes(room.canonical), false);
  } else {
    // An unsupported host REFUSES rather than silently weakening enforcement.
    assert.equal(start.status, 1, start.stdout);
    assert.equal(
      (JSON.parse(start.stderr) as { error: { code: string } }).error.code,
      "sandbox-unsupported",
    );
  }
});

/** A minimal valid instance manifest under `dir`. Returns the manifest path. */
function scratchCodexInstance(dir: string): string {
  const install = join(dir, "install");
  const primary = join(dir, "primary");
  const workspace = join(dir, "workspace");
  mkdirSync(join(install, "bin"), { recursive: true });
  mkdirSync(join(primary, ".approval", "log"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(primary, "APPROVAL.md"), "# scratch\n", "utf8");
  const manifestPath = join(install, "instance.json");
  const mcp = join(install, "bin", "approval");
  writeFileSync(manifestPath, `${JSON.stringify({
    schema_version: "approval.codex.instance.v1",
    instance_id: "packed",
    platform: "darwin",
    codex_version: "0.152.1",
    node_version: "22.0.0",
    package_version: "0.2.0",
    paths: {
      install_root: install,
      package_root: join(install, "pkg"),
      workspace,
      primary,
      policy: join(primary, "APPROVAL.md"),
      log: join(primary, ".approval", "log", "events.jsonl"),
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
  return manifestPath;
}
