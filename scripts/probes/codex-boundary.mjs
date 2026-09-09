#!/usr/bin/env node
/**
 * APRV-325: scratch-only proof of Codex's native command sandbox boundary.
 *
 * This invokes no model and never requests credential contents. The parent process
 * creates controlled scratch paths, proves they are writable without the
 * sandbox, removes the control effects, then repeats the exact writes through
 * Codex's built-in :read-only permission profile.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const CHILD_FAILURE_EXIT = 23;
const TIMEOUT_MS = 10_000;
const PROFILE = ":read-only";
const SECRET_PREFIXES = ["APPROVAL_", "TELEGRAM_", "VAULT_", "AGENTMAIL_", "OPENAI_", "ANTHROPIC_", "AWS_", "AZURE_", "GOOGLE_", "GCP_", "GH_", "GITHUB_"];
const ENV_ALLOWLIST = new Set(["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "SHELL", "USER", "LOGNAME", "TERM", "NO_COLOR"]);

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write("usage: node scripts/probes/codex-boundary.mjs --out <new absolute temporary directory>\n");
  process.exitCode = 2;
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] ?? null;
}

function scratchPath(value) {
  if (!value || !isAbsolute(value)) throw new Error("--out must be an absolute path");
  const absolute = resolve(value);
  const roots = [...new Set([tmpdir(), "/private/tmp", "/tmp"].map((root) => realpathSync(root)))];
  const parent = realpathSync(dirname(absolute));
  const canonical = join(parent, basename(absolute));
  if (!roots.some((root) => canonical !== root && canonical.startsWith(`${root}${sep}`))) {
    throw new Error("--out must be below a temporary root");
  }
  if (existsSync(canonical)) throw new Error("--out must not already exist");
  return canonical;
}

function assertTemporaryTarget(target) {
  if (!isAbsolute(target)) throw new Error("internal target must be absolute");
  const parent = realpathSync(dirname(target));
  const roots = [...new Set([resolve(tmpdir()), resolve("/private/tmp"), resolve("/tmp")])];
  if (!roots.some((root) => parent !== root && parent.startsWith(`${root}${sep}`))) {
    throw new Error("internal target must resolve below a temporary root");
  }
}

function childEnvironment(source = process.env) {
  const env = {};
  let stripped = 0;
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (ENV_ALLOWLIST.has(name) && !SECRET_PREFIXES.some((prefix) => name.startsWith(prefix)) && name !== "APPROVAL_HUMAN") {
      env[name] = value;
    } else {
      stripped += 1;
    }
  }
  return { env, stripped };
}

function run(argv, cwd, env) {
  return new Promise((resolveRun) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveRun({ exitCode: null, signal: null, timedOut, spawnError: error.code ?? "spawn-error", stdout: "", stderr: "" });
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolveRun({
        exitCode,
        signal,
        timedOut,
        spawnError: null,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function sanitizedRun(runResult, scenario = null) {
  const marker = scenario ? `APRV325_CHILD_STARTED ${scenario}\n` : "APRV325_PREFLIGHT_STARTED\n";
  const stderr = runResult.stderr;
  let failure = "none";
  if (runResult.timedOut) failure = "timeout";
  else if (runResult.spawnError) failure = "spawn-error";
  else if (/sandbox_apply|failed to apply sandbox|sandbox initialization/iu.test(stderr)) failure = "sandbox-apply-failed";
  else if (/EPERM|EACCES|operation not permitted|permission denied/iu.test(stderr)) failure = "operation-denied";
  else if ((runResult.exitCode ?? 0) !== 0) failure = "other-nonzero";
  return {
    exit_code: runResult.exitCode,
    signal: runResult.signal,
    timed_out: runResult.timedOut,
    spawn_error: runResult.spawnError,
    child_started: runResult.stdout.includes(marker),
    failure,
    stdout_bytes: Buffer.byteLength(runResult.stdout),
    stderr_bytes: Buffer.byteLength(runResult.stderr),
  };
}

async function attempt(args) {
  const scenario = args[1];
  const target = args[2];
  if (!scenario || !target) throw new Error("invalid internal attempt");
  assertTemporaryTarget(target);
  process.stdout.write(`APRV325_CHILD_STARTED ${scenario}\n`);
  try {
    if (scenario === "direct-node" || scenario === "symlink-target") {
      writeFileSync(target, `${scenario}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } else if (scenario === "nested-shell") {
      const shell = await run(["/bin/sh", "-c", "printf '%s\\n' nested-shell > \"$1\"", "aprv-325", target], process.cwd(), process.env);
      if (shell.exitCode !== 0 || shell.signal !== null || shell.spawnError) {
        const error = new Error("nested shell write failed");
        error.code = shell.stderr.match(/Operation not permitted/iu) ? "EPERM" : `shell-exit-${shell.exitCode}`;
        throw error;
      }
    } else {
      throw new Error("unknown internal scenario");
    }
    process.stdout.write(`APRV325_CHILD_RESULT ${scenario} ok\n`);
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "error";
    process.stderr.write(`APRV325_CHILD_RESULT ${scenario} ${code}\n`);
    process.exitCode = CHILD_FAILURE_EXIT;
  }
}

async function main(args) {
  const out = scratchPath(option(args, "--out"));
  const workspace = join(out, "workspace");
  const nested = join(workspace, "nested");
  const sibling = join(out, "sibling-target");
  const link = join(workspace, "sibling-link");
  mkdirSync(out, { mode: 0o700 });
  mkdirSync(workspace, { mode: 0o700 });
  mkdirSync(nested, { mode: 0o700 });
  mkdirSync(sibling, { mode: 0o700 });
  symlinkSync("../sibling-target", link, "dir");

  const scenarios = [
    { name: "direct-node", target: join(workspace, "direct.txt") },
    { name: "nested-shell", target: join(nested, "nested.txt") },
    { name: "symlink-target", target: join(link, "linked.txt"), resolved: join(sibling, "linked.txt") },
  ];
  const { env, stripped } = childEnvironment();
  const versionRun = await run(["codex", "--version"], out, env);
  const versionMatch = versionRun.stdout.match(/codex-cli\s+(\d+\.\d+\.\d+)/u);
  const evidence = {
    schema_version: 1,
    probe: "aprv-325-codex-command-sandbox",
    codex_version: versionMatch?.[1] ?? null,
    platform: process.platform,
    sandbox_command: "codex sandbox -P :read-only -C <scratch> -- <command>",
    permission_profile: PROFILE,
    child_environment: { policy: "fixed allowlist; credential prefixes and APPROVAL_HUMAN removed", stripped_count: stripped },
    preflight: null,
    scenarios: [],
    scope: {
      proves: "native Codex command sandbox denial for three controlled scratch writes",
      does_not_prove: ["apply_patch", "MCP", "desktop tools", "approval.md policy or grants", "signed approval", "a sole trusted executor", "network denial"],
    },
    passed: false,
  };

  try {
    if (process.platform !== "darwin") throw new Error("native Codex Seatbelt probe requires macOS");
    if (versionRun.exitCode !== 0 || versionRun.signal !== null || versionRun.timedOut || versionRun.spawnError || !versionMatch) {
      throw new Error("could not verify the installed Codex version");
    }
    const preflight = await run(["codex", "sandbox", "-P", PROFILE, "-C", out, "--", process.execPath, SCRIPT, "preflight"], out, env);
    evidence.preflight = sanitizedRun(preflight);
    if (preflight.exitCode !== 0 || !preflight.stdout.includes("APRV325_PREFLIGHT_STARTED\n")) {
      throw new Error("native Codex sandbox preflight did not execute inside Seatbelt");
    }

    for (const scenario of scenarios) {
      const actual = scenario.resolved ?? scenario.target;
      const control = await run([process.execPath, SCRIPT, "attempt", scenario.name, scenario.target], out, env);
      const controlEffect = existsSync(actual);
      const controlContent = controlEffect ? readFileSync(actual, "utf8") : null;
      if (control.exitCode !== 0 || !controlEffect || controlContent !== `${scenario.name}\n`) {
        throw new Error(`positive control failed for ${scenario.name}`);
      }
      rmSync(actual);
      const denied = await run(["codex", "sandbox", "-P", PROFILE, "-C", out, "--", process.execPath, SCRIPT, "attempt", scenario.name, scenario.target], out, env);
      const deniedEffect = existsSync(actual);
      const deniedRun = sanitizedRun(denied, scenario.name);
      evidence.scenarios.push({
        name: scenario.name,
        positive_control: { ...sanitizedRun(control, scenario.name), artifact_created: controlEffect, exact_content: controlContent === `${scenario.name}\n` },
        sandboxed: { ...deniedRun, artifact_absent: !deniedEffect },
      });
      if (deniedEffect || denied.exitCode !== CHILD_FAILURE_EXIT || !deniedRun.child_started || deniedRun.failure !== "operation-denied") {
        throw new Error(`sandbox denial proof failed for ${scenario.name}`);
      }
    }
    evidence.passed = true;
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : "probe failed";
  }

  evidence.symlink = {
    exists: lstatSync(link).isSymbolicLink(),
    spelling: "<scratch>/workspace/sibling-link -> ../sibling-target",
    resolves_to_controlled_sibling: realpathSync(link) === realpathSync(sibling),
  };
  const resultPath = join(out, "result.sanitized.json");
  writeFileSync(resultPath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (!evidence.passed) process.exitCode = 1;
}

const args = process.argv.slice(2);
if (args[0] === "attempt") {
  await attempt(args);
} else if (args[0] === "preflight") {
  process.stdout.write("APRV325_PREFLIGHT_STARTED\n");
} else {
  try {
    await main(args);
  } catch (error) {
    usage(error instanceof Error ? error.message : "probe failed");
  }
}
