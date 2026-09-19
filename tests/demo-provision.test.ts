/**
 * `examples/demo-provision.mjs` — the demo instances, provisioned from the
 * documented steps (APRV-386).
 *
 * Three stage demos are provisioned by one script, and the properties that
 * make it safe to point at `~/demo-gate` are properties a test has to hold,
 * not promises a header comment makes:
 *
 *  1. **It writes inside the instance and nowhere else.** The parent directory
 *     is listed before and after every run in this file, and a run that
 *     touched anything outside its own instance fails here.
 *  2. **A second run changes nothing.** Every file's bytes and mtime are
 *     captured and compared, because "idempotent" that rewrites a file with
 *     identical bytes still breaks the one thing an operator uses it for: a
 *     rerun a minute before a demo that leaves the attested policy alone.
 *  3. **It runs no human-only step.** After a full provision the instance has
 *     no `events.jsonl` at all: the script neither attested nor appended, and
 *     the attestation is listed as a line for a human with the exact command.
 *  4. **`--reset` retires, it does not truncate.** The previous log is moved
 *     into `<instance>/retired/<stamp>/` byte for byte, and the vault survives
 *     unless `--vault` says otherwise.
 *  5. **The guest instance holds no vault.** `examples/web-agent-demo/runbook.md`
 *     §4 states it as a MUST; here `--vault` is refused for that instance and
 *     `--check` FAILS if a vault ever appears in it.
 *
 * Everything under test is reached through the real verbs: `approval init`,
 * `approval payload hash`, `approval policy check`, `approval policy attest`,
 * `approval vault set`, `approval doctor`. Nothing is hand-written into a log,
 * no real credential is used, and no instance in a home directory is touched:
 * every instance here is a scratch directory this file created and removes.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

/** The repository root, from `dist/tests/` at runtime. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = join(REPO_ROOT, "examples", "demo-provision.mjs");
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
const POLICY_FILE = join(REPO_ROOT, "examples", "policies", "demo-gate.APPROVAL.md");
const PROVISIONING = join(REPO_ROOT, "examples", "web-agent-demo", "provisioning.md");

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-demo-provision-")));
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface ScriptRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly json: Record<string, unknown> | null;
}

/**
 * The script, as an operator runs it, with `--json` for the assertions.
 *
 * The environment is deliberately bare of the demo's variables: a test that
 * leaked `APPROVAL_HUMAN` or a vault passphrase in from the developer's own
 * shell would be asserting about their machine rather than about this script.
 */
function runScript(args: readonly string[]): ScriptRun {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(APPROVAL|TG_)/u.test(name)) delete env[name];
  }
  const result = spawnSync(process.execPath, [SCRIPT, ...args, "--json"], {
    encoding: "utf8",
    env,
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(result.stdout ?? "") as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", json };
}

/** One CLI verb against an instance, through the real binary. */
function runCli(args: readonly string[], cwd: string, extraEnv: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    timeout: 60_000,
  });
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** A fresh, empty parent for one instance, so "outside" is observable. */
function newHome(label: string): { home: string; dir: string } {
  const home = join(scratch, label);
  mkdirSync(home, { recursive: true });
  // A sibling the script has no business touching.
  writeFileSync(join(home, "sibling.txt"), "not the instance\n");
  return { home, dir: join(home, "instance") };
}

interface Snapshot {
  readonly paths: readonly string[];
  readonly bytes: ReadonlyMap<string, string>;
  readonly mtimes: ReadonlyMap<string, number>;
}

function snapshot(root: string): Snapshot {
  const paths: string[] = [];
  const bytes = new Map<string, string>();
  const mtimes = new Map<string, number>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const key = relative(root, full);
      paths.push(key);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      bytes.set(key, readFileSync(full).toString("base64"));
      mtimes.set(key, statSync(full).mtimeMs);
    }
  };
  walk(root);
  paths.sort();
  return { paths, bytes, mtimes };
}

/** One rendered row, with every field a string so assertions stay readable. */
interface Row {
  readonly name: string;
  readonly status: string;
  readonly detail: string;
  readonly command: string;
}

function rows(run: ScriptRun, key: "steps" | "checks"): Array<Record<string, unknown>> {
  return (run.json?.[key] ?? []) as Array<Record<string, unknown>>;
}

function rowNamed(run: ScriptRun, key: "steps" | "checks", field: string, name: string): Row {
  const found = rows(run, key).find((entry) => entry[field] === name);
  assert.ok(found !== undefined, `no ${field} named ${name} in ${JSON.stringify(rows(run, key), null, 2)}`);
  return {
    name,
    status: String(found["status"] ?? ""),
    detail: String(found["detail"] ?? ""),
    command: String(found["command"] ?? ""),
  };
}

function stepNamed(run: ScriptRun, name: string): Row {
  return rowNamed(run, "steps", "step", name);
}

function checkNamed(run: ScriptRun, name: string): Row {
  return rowNamed(run, "checks", "check", name);
}

/** The message of a refusal printed as `{"ok":false,"error":{…}}`. */
function errorMessage(run: ScriptRun): string {
  const error = (run.json?.["error"] ?? {}) as Record<string, unknown>;
  return String(error["message"] ?? "");
}

/** The one ```yaml approval-policy block in a markdown file. */
function policyBlock(path: string): string {
  const text = readFileSync(path, "utf8");
  const blocks = [...text.matchAll(/```yaml approval-policy\n([\s\S]*?)```/gu)].map((match) => match[1] ?? "");
  assert.equal(blocks.length, 1, `expected exactly one policy block in ${path}, found ${blocks.length}`);
  return blocks[0] ?? "";
}

// ---------------------------------------------------------------------------
// The policy is a file, so that a policy change is a diff
// ---------------------------------------------------------------------------

test("the packaged demo policy is the one provisioning.md publishes", () => {
  assert.equal(
    policyBlock(POLICY_FILE),
    policyBlock(PROVISIONING),
    "examples/policies/demo-gate.APPROVAL.md and examples/web-agent-demo/provisioning.md have drifted apart. The file is what the script writes into every demo instance and the document is what a human reads before signing for it; they are the same policy or the documentation is a description of something else.",
  );
});

test("the packaged demo policy loads, and answers permissively where it should", () => {
  const permissive = runCli(
    ["policy", "check", "read.files", "--reversible", "true", "--policy", POLICY_FILE, "--json"],
    REPO_ROOT,
  );
  assert.equal(permissive.code, 0, permissive.stderr);
  const outcome = JSON.parse(permissive.stdout) as { outcome: { autonomy: string } };
  // The discriminating check: an unparseable policy is a manual-everything
  // policy delivered at exit 0, so only a permissive answer proves it loaded.
  assert.equal(outcome.outcome.autonomy, "autonomous");
});

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

test("a first provision writes the documented instance, and nothing outside it", () => {
  const { home, dir } = newHome("first");
  const run = runScript(["--instance", "guest", "--path", dir]);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.json?.["ok"], true);

  const inside = snapshot(dir);
  assert.deepEqual(
    inside.paths.filter((path) => !path.startsWith("retired")).sort(),
    [
      ".approval",
      ".approval/QUEUE.md",
      ".approval/log",
      ".gitignore",
      "APPROVAL.md",
      "demo-instance.json",
      "tasks",
      "tasks/crowd-01.echo.json",
      "tasks/crowd-01.md",
      "tasks/crowd-02.echo.json",
      "tasks/crowd-02.md",
      "tasks/crowd-03.echo.json",
      "tasks/crowd-03.md",
    ].sort(),
  );

  // The policy in the instance is the packaged file, byte for byte.
  assert.equal(readFileSync(join(dir, "APPROVAL.md"), "utf8"), readFileSync(POLICY_FILE, "utf8"));

  // Nothing outside the instance: the sibling is the only other entry, and it
  // is the one this test wrote.
  assert.deepEqual(readdirSync(home).sort(), ["instance", "sibling.txt"]);
  assert.equal(readFileSync(join(home, "sibling.txt"), "utf8"), "not the instance\n");

  // Every seeded envelope carries a payload_hash. A manual action registered
  // without one is refused `payload-hash-required` at request time, so an
  // envelope missing it is an envelope the crowd track cannot use at all.
  for (const id of ["crowd-01", "crowd-02", "crowd-03"]) {
    const envelope = readFileSync(join(dir, "tasks", `${id}.md`), "utf8");
    const hash = /payload_hash: "([0-9a-f]{64})"/u.exec(envelope);
    assert.ok(hash !== null, `${id} has no payload_hash`);
    const hashed = runCli(["payload", "hash", join(dir, "tasks", `${id}.echo.json`), "--json"], dir);
    assert.equal((JSON.parse(hashed.stdout) as { hash: string }).hash, hash[1] ?? "");
  }
});

test("the script runs no human-only step: nothing is attested and no log exists", () => {
  const { dir } = newHome("human-steps");
  const run = runScript(["--instance", "guest", "--path", dir]);
  assert.equal(run.code, 0, run.stderr);

  // `approval init` creates the log DIRECTORY and deliberately puts nothing in
  // it; the first attestation is what creates events.jsonl. So an instance
  // with no events.jsonl is an instance nothing has appended to.
  assert.equal(existsSync(join(dir, ".approval", "log")), true);
  assert.equal(existsSync(join(dir, ".approval", "log", "events.jsonl")), false);

  assert.equal(stepNamed(run, "attest").status, "waiting");
  assert.equal(stepNamed(run, "identity").status, "waiting");
  assert.equal(stepNamed(run, "channel").status, "waiting");

  const pending = (run.json?.["pending"] ?? []) as Array<Record<string, string>>;
  assert.deepEqual(
    pending.map((entry) => entry["step"]),
    ["attest", "identity", "channel"],
  );
  const attest = pending[0]?.["command"] ?? "";
  assert.match(attest, /policy attest --as human:demo$/u);
  assert.ok(attest.startsWith(`cd ${dir} && `), attest);
});

test("a second run overwrites nothing and still exits 0", () => {
  const { dir } = newHome("idempotent");
  assert.equal(runScript(["--instance", "guest", "--path", dir]).code, 0);
  const before = snapshot(dir);

  const second = runScript(["--instance", "guest", "--path", dir]);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.json?.["ok"], true);
  assert.equal(stepNamed(second, "scaffold").detail.includes("wrote nothing"), true);

  const after_ = snapshot(dir);
  assert.deepEqual(after_.paths, before.paths);
  for (const path of before.paths) {
    assert.equal(after_.bytes.get(path), before.bytes.get(path), `${path} was rewritten`);
    assert.equal(after_.mtimes.get(path), before.mtimes.get(path), `${path} was touched`);
  }
});

test("an existing policy that differs is kept, never overwritten", () => {
  const { dir } = newHome("kept-policy");
  assert.equal(runScript(["--instance", "guest", "--path", dir]).code, 0);
  const mine = `${readFileSync(POLICY_FILE, "utf8")}\n<!-- an operator's own edit -->\n`;
  writeFileSync(join(dir, "APPROVAL.md"), mine);

  const run = runScript(["--instance", "guest", "--path", dir]);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(readFileSync(join(dir, "APPROVAL.md"), "utf8"), mine);
  assert.match(stepNamed(run, "policy").detail, /KEPT/u);
});

test("one directory cannot be two demos at once", () => {
  const { dir } = newHome("marker");
  assert.equal(runScript(["--instance", "guest", "--path", dir]).code, 0);

  const wrong = runScript(["--instance", "web-agent", "--path", dir]);
  assert.equal(wrong.code, 2, wrong.stdout);
  assert.match(stepNamed(wrong, "marker").detail, /provisioned for the guest demo/u);
  assert.match(stepNamed(wrong, "marker").detail, /--path|--reset/u);
});

test("the Grok instance stops at the clone and scaffolds nothing into a path git could still use", () => {
  const { home, dir } = newHome("grok");
  const run = runScript(["--instance", "grok-bot", "--path", dir]);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(stepNamed(run, "clone").status, "waiting");
  assert.match(stepNamed(run, "clone").command, /^git clone /u);
  // `git clone` refuses a directory that already holds files, so the script
  // has to leave this one alone rather than scaffold into it first.
  assert.equal(existsSync(dir), false);
  assert.deepEqual(readdirSync(home).sort(), ["sibling.txt"]);
});

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

/** Attest a scratch instance through the real verb, creating its log. */
function attest(dir: string): void {
  const attested = runCli(["policy", "attest", "--as", "human:demo"], dir);
  assert.equal(attested.code, 0, attested.stderr);
  assert.equal(existsSync(join(dir, ".approval", "log", "events.jsonl")), true);
}

/** A credential written through the real verb. Not a secret: a test string. */
function seedVault(dir: string): void {
  const stored = runCli(["vault", "set", "smtp.host", "--value-env", "DEMO_TEST_VALUE", "--as", "human:demo"], dir, {
    APPROVAL_DEMO_VAULT_PASSPHRASE: "not-a-real-passphrase-for-a-test",
    DEMO_TEST_VALUE: "smtp.example.invalid",
  });
  assert.equal(stored.code, 0, stored.stderr);
  assert.equal(existsSync(join(dir, ".approval", "vault.enc")), true);
}

function retiredRoot(dir: string): string {
  const stamps = readdirSync(join(dir, "retired")).filter((entry) => entry !== "marker");
  assert.equal(stamps.length, 1, `expected one retired snapshot, found ${stamps.join(", ")}`);
  return join(dir, "retired", stamps[0] ?? "");
}

test("--reset retires the log instead of truncating it, and keeps the vault", () => {
  const { dir } = newHome("reset");
  assert.equal(runScript(["--instance", "web-agent", "--path", dir]).code, 0);
  attest(dir);
  seedVault(dir);
  const chain = readFileSync(join(dir, ".approval", "log", "events.jsonl"), "utf8");
  const vault = readFileSync(join(dir, ".approval", "vault.enc")).toString("base64");

  const run = runScript(["--instance", "web-agent", "--path", dir, "--reset"]);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(stepNamed(run, "reset").status, "ok");

  // The previous chain is intact, moved, inside the instance. Byte for byte:
  // a reset that rewrote one line of it would be the one thing this project
  // exists to make impossible.
  const retired = retiredRoot(dir);
  assert.equal(readFileSync(join(retired, ".approval", "log", "events.jsonl"), "utf8"), chain);

  // And the instance is back at its post-provision state: a log directory with
  // nothing in it, waiting for an attestation.
  assert.equal(existsSync(join(dir, ".approval", "log", "events.jsonl")), false);
  assert.equal(existsSync(join(dir, ".approval", "log")), true);
  assert.equal(stepNamed(run, "attest").status, "waiting");

  // The vault was not in the moved set, which is how a reset keeps it.
  assert.equal(readFileSync(join(dir, ".approval", "vault.enc")).toString("base64"), vault);
});

test("--reset --vault retires the vault too", () => {
  const { dir } = newHome("reset-vault");
  assert.equal(runScript(["--instance", "web-agent", "--path", dir]).code, 0);
  attest(dir);
  seedVault(dir);
  const vault = readFileSync(join(dir, ".approval", "vault.enc")).toString("base64");

  const run = runScript(["--instance", "web-agent", "--path", dir, "--reset", "--vault"]);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(existsSync(join(dir, ".approval", "vault.enc")), false);
  assert.equal(readFileSync(join(retiredRoot(dir), ".approval", "vault.enc")).toString("base64"), vault);
});

test("--vault without --reset is a refusal: this script never creates a vault", () => {
  const { dir } = newHome("vault-alone");
  const run = runScript(["--instance", "web-agent", "--path", dir, "--vault"]);
  assert.equal(run.code, 2);
  assert.match(errorMessage(run), /--reset only/u);
});

// ---------------------------------------------------------------------------
// The guest instance holds no credential (runbook.md §4)
// ---------------------------------------------------------------------------

test("the guest instance is refused a vault, and --check fails if one appears", () => {
  const { dir } = newHome("guest-vault");
  assert.equal(runScript(["--instance", "guest", "--path", dir]).code, 0);

  const refused = runScript(["--instance", "guest", "--path", dir, "--reset", "--vault"]);
  assert.equal(refused.code, 2, refused.stdout);
  assert.match(stepNamed(refused, "reset").detail, /holds no vault by design/u);

  // Belt and braces, the other way around: a vault that somehow appears in the
  // guest instance is a FAILED check, not a warning.
  attest(dir);
  seedVault(dir);
  const check = runScript(["--instance", "guest", "--path", dir, "--check"]);
  assert.equal(check.code, 1);
  assert.equal(checkNamed(check, "vault").status, "fail");
  assert.match(checkNamed(check, "vault").detail, /MUST/u);

  // And the provisioning run reports it as a failure too.
  const again = runScript(["--instance", "guest", "--path", dir]);
  assert.equal(again.code, 1);
  assert.equal(stepNamed(again, "vault").status, "fail");
});

// ---------------------------------------------------------------------------
// --check
// ---------------------------------------------------------------------------

test("--check reports the instance's doctor and the demo's own preflight", () => {
  const { dir } = newHome("check");
  assert.equal(runScript(["--instance", "guest", "--path", dir]).code, 0);

  // Before the attestation: doctor's own attestation row fails, and so does
  // this verb, which is the point of running it ten minutes before doors.
  const before = runScript(["--instance", "guest", "--path", dir, "--check"]);
  assert.equal(before.code, 1);
  assert.equal(checkNamed(before, "doctor").status, "fail");
  assert.match(checkNamed(before, "doctor").detail, /attestation/u);

  attest(dir);

  const after_ = runScript(["--instance", "guest", "--path", dir, "--check"]);
  assert.equal(checkNamed(after_, "instance").status, "pass");
  assert.equal(checkNamed(after_, "policy").status, "pass");
  assert.equal(checkNamed(after_, "doctor").status, "pass", checkNamed(after_, "doctor").detail);
  assert.equal(checkNamed(after_, "vault").status, "pass");
  assert.equal(checkNamed(after_, "seed-crowd-01").status, "pass");

  // The two rows doctor cannot answer for a demo: an unconfigured channel is a
  // legitimate state for a gate and a dead demo for a room, so it FAILS here
  // even though doctor skips it.
  assert.equal(checkNamed(after_, "identity").status, "fail");
  assert.equal(checkNamed(after_, "channel").status, "fail");
  assert.equal(after_.code, 1);
});

test("--check on a directory that was never provisioned says so", () => {
  const { home } = newHome("unprovisioned");
  const run = runScript(["--instance", "web-agent", "--path", join(home, "nothing"), "--check"]);
  assert.equal(run.code, 1);
  assert.equal(checkNamed(run, "instance").status, "fail");
});

test("--check writes nothing", () => {
  const { dir } = newHome("check-readonly");
  assert.equal(runScript(["--instance", "guest", "--path", dir]).code, 0);
  attest(dir);
  const before = snapshot(dir);
  runScript(["--instance", "guest", "--path", dir, "--check"]);
  const after_ = snapshot(dir);
  assert.deepEqual(after_.paths, before.paths);
  for (const path of before.paths) {
    assert.equal(after_.bytes.get(path), before.bytes.get(path), `${path} changed under --check`);
    assert.equal(after_.mtimes.get(path), before.mtimes.get(path), `${path} was touched by --check`);
  }
});

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

test("the three instances have three different default directories", () => {
  const help = spawnSync(process.execPath, [SCRIPT, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  const listed = [...(help.stdout ?? "").matchAll(/^ {2}(web-agent|guest|grok-bot) +(\S+)/gmu)].map(
    (match) => [match[1] ?? "", match[2] ?? ""] as const,
  );
  assert.deepEqual(
    listed.map(([name]) => name),
    ["web-agent", "guest", "grok-bot"],
  );
  const directories = listed.map(([, directory]) => directory);
  // Two demos sharing a default directory is a footgun the marker can only
  // report after the fact: by the time it refuses, the operator has already
  // typed the wrong `--instance` at the wrong instance. The marker is the
  // backstop; separate defaults are what keep anyone from needing it.
  assert.equal(
    new Set(directories).size,
    3,
    `two demo instances share a default directory: ${directories.join(", ")}`,
  );
});

test("an unknown instance is a refusal that names the three", () => {
  const run = runScript(["--instance", "not-a-demo"]);
  assert.equal(run.code, 2);
  const message = errorMessage(run);
  assert.match(message, /web-agent/u);
  assert.match(message, /guest/u);
  assert.match(message, /grok-bot/u);
});
