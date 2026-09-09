/**
 * `approval policy attest` end-to-end tests (APRV-15 Part B).
 *
 * As in `cli.test.ts` and `cli-policy.test.ts`, every case spawns the real
 * compiled CLI as a child process: the contract under test is what a human or
 * an agent observes — exit code, stdout bytes, stderr bytes, and the line that
 * ends up in the log. The `--json` shape is frozen public API and is asserted
 * with `deepEqual` on the whole object.
 *
 * Identity is passed through the child's environment, which is the point: the
 * environment IS the identity claim at v0.1, and these tests pin both halves of
 * that — that `APPROVAL_HUMAN` works, and that an agent actor cannot use this
 * verb by any route the CLI offers.
 *
 * Nothing here writes a log line by hand; every record is produced by the CLI
 * itself, and `approval log verify` is run afterwards to prove the appended
 * record left the chain clean.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
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

/** dist/tests/cli-attest.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-cli-attest-")));
const restoreOnExit: string[] = [];
let counter = 0;

after(() => {
  for (const path of restoreOnExit) {
    try {
      chmodSync(path, 0o644);
    } catch {
      // Already gone or already readable; nothing to do.
    }
  }
  rmSync(scratch, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the CLI with a *cleaned* environment: `APPROVAL_HUMAN` is removed unless
 * a case supplies it, so a developer who exports it in their own shell cannot
 * make the "missing identity" cases pass by accident.
 */
function runCli(args: string[], cwd: string, env: Record<string, string> = {}): Run {
  const childEnv = { ...process.env, ...env };
  if (env["APPROVAL_HUMAN"] === undefined) delete childEnv["APPROVAL_HUMAN"];
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: childEnv,
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

const POLICY_TEXT = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: supervised",
  "```",
  "",
].join("\n");

function caseDir(text: string = POLICY_TEXT, filename = "APPROVAL.md"): string {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), text, "utf8");
  return dir;
}

function logPathIn(dir: string): string {
  return join(dir, ".approval", "log", "events.jsonl");
}

function logRecords(dir: string): Record<string, unknown>[] {
  const path = logPathIn(dir);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The payload of the first logged record, as an object. */
function firstPayload(dir: string): Record<string, unknown> {
  const record = logRecords(dir)[0];
  assert.notEqual(record, undefined, "expected at least one logged record");
  return (record as Record<string, unknown>)["payload"] as Record<string, unknown>;
}

function isRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

// ---------------------------------------------------------------------------
// Success
// ---------------------------------------------------------------------------

test("--as attests the discovered policy and reports seq and sha256", () => {
  const dir = caseDir();
  const run = runCli(["policy", "attest", "--as", "human:carter"], dir);

  assert.equal(run.code, 0);
  assert.equal(run.stderr, "");
  assert.match(run.stdout, /^attested .*APPROVAL\.md at seq 1: sha256 [a-f0-9]{64}\n$/);

  const records = logRecords(dir);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.["event"], "policy.updated");
  assert.equal(records[0]?.["actor"], "human:carter");
  assert.deepEqual(Object.keys(records[0]?.["payload"] as object).sort(), [
    "policy_path",
    "sha256",
  ]);
});

test("APPROVAL_HUMAN supplies the identity when --as is absent", () => {
  const dir = caseDir();
  const run = runCli(["policy", "attest"], dir, { APPROVAL_HUMAN: "human:from-env" });

  assert.equal(run.code, 0);
  assert.equal(logRecords(dir)[0]?.["actor"], "human:from-env");
});

test("--as overrides APPROVAL_HUMAN", () => {
  const dir = caseDir();
  const run = runCli(["policy", "attest", "--as", "human:flag"], dir, {
    APPROVAL_HUMAN: "human:env",
  });

  assert.equal(run.code, 0);
  assert.equal(logRecords(dir)[0]?.["actor"], "human:flag");
});

test("--json emits the frozen success shape", () => {
  const dir = caseDir();
  const run = runCli(["policy", "attest", "--as", "human:carter", "--json"], dir);

  assert.equal(run.code, 0);
  assert.equal(run.stderr, "");
  const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), ["ok", "path", "seq", "sha256"]);
  assert.equal(parsed["ok"], true);
  assert.equal(parsed["seq"], 1);
  assert.equal(parsed["path"], join(dir, "APPROVAL.md"));
  assert.match(String(parsed["sha256"]), /^[a-f0-9]{64}$/);
  // The reported hash is the file's bytes, and the log carries the same value.
  assert.equal(firstPayload(dir)["sha256"], parsed["sha256"]);
});

test("the appended record leaves the chain clean", () => {
  const dir = caseDir();
  assert.equal(runCli(["policy", "attest", "--as", "human:carter"], dir).code, 0);
  writeFileSync(join(dir, "APPROVAL.md"), `${POLICY_TEXT}\n<!-- edited -->\n`, "utf8");
  assert.equal(runCli(["policy", "attest", "--as", "human:carter"], dir).code, 0);

  const verify = runCli(["log", "verify", "--json"], dir);
  assert.equal(verify.code, 0);
  const parsed = JSON.parse(verify.stdout) as Record<string, unknown>;
  assert.equal(parsed["status"], "clean");
  assert.equal(parsed["records"], 2);
});

test("discovery falls back to APPROVALS.md and hashes the file it selected", () => {
  const dir = caseDir(POLICY_TEXT, "APPROVALS.md");
  const run = runCli(["policy", "attest", "--as", "human:carter", "--json"], dir);

  assert.equal(run.code, 0);
  assert.equal((JSON.parse(run.stdout) as Record<string, unknown>)["path"], join(dir, "APPROVALS.md"));
  assert.equal(firstPayload(dir)["policy_path"], "APPROVALS.md");
});

test("APPROVAL.md wins over APPROVALS.md, as in loadPolicy", () => {
  const dir = caseDir();
  writeFileSync(join(dir, "APPROVALS.md"), "# other\n", "utf8");
  const run = runCli(["policy", "attest", "--as", "human:carter", "--json"], dir);

  assert.equal(run.code, 0);
  assert.equal((JSON.parse(run.stdout) as Record<string, unknown>)["path"], join(dir, "APPROVAL.md"));
});

test("--policy names the file directly and --log redirects the append", () => {
  const dir = caseDir();
  const elsewhere = join(dir, "policies", "custom.md");
  mkdirSync(join(dir, "policies"), { recursive: true });
  writeFileSync(elsewhere, POLICY_TEXT, "utf8");
  const altLog = join(dir, "alt", "events.jsonl");

  const run = runCli(
    ["policy", "attest", "--as", "human:carter", "--policy", elsewhere, "--log", altLog, "--json"],
    dir,
  );

  assert.equal(run.code, 0);
  assert.equal((JSON.parse(run.stdout) as Record<string, unknown>)["path"], elsewhere);
  assert.equal(existsSync(altLog), true);
  assert.equal(logRecords(dir).length, 0);
});

test("a schema-invalid policy file still attests: bytes, not parse", () => {
  const dir = caseDir("not a policy file at all\n");
  const attest = runCli(["policy", "attest", "--as", "human:carter", "--json"], dir);
  assert.equal(attest.code, 0);
  assert.equal((JSON.parse(attest.stdout) as Record<string, unknown>)["ok"], true);

  // And it stays fail-closed where it counts: the engine still refuses to load it.
  const check = runCli(["policy", "check", "read.web", "--json"], dir);
  assert.equal(check.code, 0);
  const explanation = JSON.parse(check.stdout) as Record<string, unknown>;
  assert.equal(explanation["manualBecause"], "load-failure");
});

// ---------------------------------------------------------------------------
// Usage (exit 2)
// ---------------------------------------------------------------------------

test("no declared identity is a usage error naming both ways to declare one", () => {
  const dir = caseDir();
  const run = runCli(["policy", "attest"], dir);

  assert.equal(run.code, 2);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /APPROVAL_HUMAN=human:<id>/);
  assert.match(run.stderr, /--as human:<id>/);
  assert.deepEqual(logRecords(dir), []);
});

test("an agent actor is refused at the CLI and writes nothing", () => {
  const dir = caseDir();
  const run = runCli(["policy", "attest", "--as", "agent:planner"], dir);

  assert.equal(run.code, 2);
  assert.match(run.stderr, /human-only|human:<id>/);
  assert.deepEqual(logRecords(dir), []);
});

test("a system actor is refused too", () => {
  const dir = caseDir();
  assert.equal(runCli(["policy", "attest", "--as", "system:daemon"], dir).code, 2);
  assert.deepEqual(logRecords(dir), []);
});

test("a non-human APPROVAL_HUMAN does not become an identity", () => {
  const dir = caseDir();
  const run = runCli(["policy", "attest"], dir, { APPROVAL_HUMAN: "agent:planner" });
  assert.equal(run.code, 2);
  assert.deepEqual(logRecords(dir), []);
});

test("an unknown flag is a usage error", () => {
  const dir = caseDir();
  const run = runCli(["policy", "attest", "--as", "human:carter", "--jsno"], dir);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /unknown flag --jsno/);
  assert.deepEqual(logRecords(dir), []);
});

test("a stray positional is a usage error", () => {
  const dir = caseDir();
  const run = runCli(["policy", "attest", "--as", "human:carter", "read.web"], dir);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /unexpected argument/);
});

test("usage errors answer in JSON when --json was given", () => {
  const dir = caseDir();
  const run = runCli(["policy", "attest", "--json"], dir);
  assert.equal(run.code, 2);
  assert.equal(run.stdout, "");
  const parsed = JSON.parse(run.stderr) as { error: { code: string; message: string } };
  assert.equal(parsed.error.code, "usage");
});

// ---------------------------------------------------------------------------
// I/O (exit 4)
// ---------------------------------------------------------------------------

test("an absent policy file is an I/O error, not an attestation", () => {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(dir, { recursive: true });

  const run = runCli(["policy", "attest", "--as", "human:carter"], dir);
  assert.equal(run.code, 4);
  assert.match(run.stderr, /no policy file found/);
  assert.deepEqual(logRecords(dir), []);
});

test("an unreadable policy file is exit 4", { skip: isRoot() }, () => {
  const dir = caseDir();
  const path = join(dir, "APPROVAL.md");
  chmodSync(path, 0o000);
  restoreOnExit.push(path);

  const run = runCli(["policy", "attest", "--as", "human:carter"], dir);
  assert.equal(run.code, 4);
  assert.match(run.stderr, /not readable|could not be opened/);
  assert.deepEqual(logRecords(dir), []);
});

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

test("the help states human-only, the trust boundary, and bytes-not-parse", () => {
  const dir = caseDir();
  const run = runCli(["policy", "attest", "--help"], dir);

  assert.equal(run.code, 0);
  assert.match(run.stdout, /Human-only/);
  assert.match(run.stdout, /CONFIG-DECLARED/);
  assert.match(run.stdout, /trust boundary is the local machine/);
  assert.match(run.stdout, /not who/);
  assert.match(run.stdout, /Bytes, not parse/);
  assert.match(run.stdout, /policy-not-attested/);
  assert.match(run.stdout, /APPROVAL_HUMAN/);
  // Help writes nothing to the log.
  assert.deepEqual(logRecords(dir), []);
});

test("policy --help and the root help both mention attest", () => {
  const dir = caseDir();
  assert.match(runCli(["policy", "--help"], dir).stdout, /attest/);
  assert.match(runCli(["--help"], dir).stdout, /policy attest/);
});

// ---------------------------------------------------------------------------
// --organ: the gate organs (APRV-272)
// ---------------------------------------------------------------------------

const SETTINGS_TEXT = `${JSON.stringify(
  { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "approval hook claude-code" }] }] } },
  null,
  2,
)}\n`;

/** A case directory carrying a policy file AND one gate organ on disk. */
function organCaseDir(text = SETTINGS_TEXT, organ = join(".claude", "settings.json")): string {
  const dir = caseDir();
  const path = join(dir, organ);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, "utf8");
  return dir;
}

test("--organ attests the harness settings file and names it in the record", () => {
  const dir = organCaseDir();
  const run = runCli(
    ["policy", "attest", "--organ", ".claude/settings.json", "--as", "human:carter"],
    dir,
  );

  assert.equal(run.code, 0);
  assert.equal(run.stderr, "");
  assert.match(
    run.stdout,
    /^attested gate organ \.claude\/settings\.json at seq 1: sha256 [a-f0-9]{64}\n$/,
  );

  const records = logRecords(dir);
  assert.equal(records.length, 1);
  // Never `policy.updated`: the gate's policy readers select on that type, and
  // this record must be invisible to every one of them.
  assert.equal(records[0]?.["event"], "gate.organ.attested");
  assert.equal(records[0]?.["actor"], "human:carter");
  assert.deepEqual(Object.keys(firstPayload(dir)).sort(), ["organ_path", "sha256"]);
  assert.equal(firstPayload(dir)["organ_path"], ".claude/settings.json");

  // The chain the CLI wrote still verifies.
  assert.equal(runCli(["log", "verify"], dir).code, 0);
});

test("--organ computes the digest itself, from the bytes on disk", () => {
  const dir = organCaseDir();
  const run = runCli(
    ["policy", "attest", "--organ", ".claude/settings.json", "--as", "human:carter", "--json"],
    dir,
  );

  assert.equal(run.code, 0);
  const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), ["ok", "organ_path", "path", "seq", "sha256"]);
  assert.equal(parsed["ok"], true);
  assert.equal(parsed["seq"], 1);
  assert.equal(parsed["organ_path"], ".claude/settings.json");
  assert.equal(
    parsed["sha256"],
    createHash("sha256")
      .update(readFileSync(join(dir, ".claude", "settings.json")))
      .digest("hex"),
  );
  assert.equal(parsed["sha256"], firstPayload(dir)["sha256"]);
});

test("--organ takes an absolute path under the directory and records it relative", () => {
  const dir = organCaseDir();
  const run = runCli(
    [
      "policy",
      "attest",
      "--organ",
      join(dir, ".claude", "settings.json"),
      "--as",
      "human:carter",
      "--json",
    ],
    dir,
  );

  assert.equal(run.code, 0);
  assert.equal(firstPayload(dir)["organ_path"], ".claude/settings.json");
});

test("--organ pointed at the policy file is refused with its own code", () => {
  const dir = organCaseDir();
  const run = runCli(
    ["policy", "attest", "--organ", "APPROVAL.md", "--as", "human:carter", "--json"],
    dir,
  );

  assert.equal(run.code, 2);
  assert.equal(run.stdout, "");
  const parsed = JSON.parse(run.stderr) as { error: { code: string; message: string } };
  assert.equal(parsed.error.code, "path-is-policy");
  assert.match(parsed.error.message, /approval policy attest/);
  assert.deepEqual(logRecords(dir), []);
});

test("--organ pointed at a path that is not an organ is refused", () => {
  for (const path of ["README.md", ".approval/env", "src/core/gate.ts", "SPEC.md"]) {
    const dir = organCaseDir();
    const run = runCli(
      ["policy", "attest", "--organ", path, "--as", "human:carter", "--json"],
      dir,
    );

    assert.equal(run.code, 2, path);
    const parsed = JSON.parse(run.stderr) as { error: { code: string } };
    assert.equal(parsed.error.code, "path-not-organ", path);
    assert.deepEqual(logRecords(dir), [], path);
  }
});

test("--organ under an agent actor is refused at exit 2, like every attestation", () => {
  const dir = organCaseDir();
  const run = runCli(
    ["policy", "attest", "--organ", ".claude/settings.json", "--as", "agent:claude-code"],
    dir,
  );

  assert.equal(run.code, 2);
  assert.match(run.stderr, /human-only|human:<id>/);
  assert.deepEqual(logRecords(dir), []);
});

test("--organ with no declared identity is refused at exit 2", () => {
  const dir = organCaseDir();
  const run = runCli(["policy", "attest", "--organ", ".claude/settings.json"], dir);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /APPROVAL_HUMAN/);
  assert.deepEqual(logRecords(dir), []);
});

test("--policy and --organ together are a usage error, never a guess", () => {
  const dir = organCaseDir();
  const run = runCli(
    [
      "policy",
      "attest",
      "--policy",
      "APPROVAL.md",
      "--organ",
      ".claude/settings.json",
      "--as",
      "human:carter",
      "--json",
    ],
    dir,
  );

  assert.equal(run.code, 2);
  const parsed = JSON.parse(run.stderr) as { error: { code: string } };
  assert.equal(parsed.error.code, "usage");
  assert.deepEqual(logRecords(dir), []);
});

test("--organ naming a file that is not there is exit 4, not an attestation", () => {
  const dir = caseDir();
  const run = runCli(
    ["policy", "attest", "--organ", ".claude/settings.json", "--as", "human:carter"],
    dir,
  );

  assert.equal(run.code, 4);
  assert.match(run.stderr, /gate organ/);
  assert.deepEqual(logRecords(dir), []);
});

test("the help documents --organ and what it is for", () => {
  const dir = caseDir();
  const run = runCli(["policy", "attest", "--help"], dir);

  assert.equal(run.code, 0);
  assert.match(run.stdout, /--organ <path>/);
  assert.match(run.stdout, /gate\.organ\.attested/);
  assert.match(run.stdout, /policy\.core/);
});
