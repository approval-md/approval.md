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
  assert.equal(publishedVerbs().some((verb) => verb.name === "codex"), false);
  for (const subcommand of ["start", "serve"]) {
    const result = spawnSync(process.execPath, [CLI, "codex", subcommand, "--manifest", "/tmp/example.json", "--json"], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).error.code, "codex-not-ready");
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
  ]) {
    assert.equal(existsSync(join(packageRoot, path)), true, `${path} missing from installed tarball`);
  }
  const invoked = spawnSync(process.execPath, [join(packageRoot, "cli.js"), "codex", "--help"], {
    cwd: outside, encoding: "utf8", env: cleanEnv(), timeout: 10_000,
  });
  assert.equal(invoked.status, 0, invoked.stderr);
  assert.match(invoked.stdout, /prepare and inspect a constrained Codex host bundle/u);
});
