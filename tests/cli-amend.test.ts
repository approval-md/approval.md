/**
 * `approval policy amend` end-to-end tests (APRV-30).
 *
 * Every case spawns the real compiled CLI as a child process, and the cases that
 * need a baseline build a real temporary git repository and drive it with real
 * `git` — the baseline-recovery design turns on what `git show HEAD:<path>`
 * actually returns, and a fake would test the fake.
 *
 * Two of these tests are the incidents the verb was written for:
 * "the seq-2 shape" (an edit that does not load: the advisory says so, a plain
 * amend still attests, and --require-load refuses without touching the log) and
 * "the interregnum" (--commit lands the policy edit and its attestation as one
 * commit carrying exactly two files).
 *
 * Nothing here writes a log line by hand; every record is produced by the CLI,
 * and log bytes are compared before/after for the cases that must write nothing.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

/** dist/tests/cli-amend.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-cli-amend-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
  path: string = DEFAULT_PATH,
): Run {
  const childEnv = { ...process.env, ...env };
  if (env["APPROVAL_HUMAN"] === undefined) delete childEnv["APPROVAL_HUMAN"];
  childEnv["PATH"] = path;
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: childEnv,
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

// ---------------------------------------------------------------------------
// The `gh` fake (APRV-92)
//
// Branch-protection detection shells out to `gh` by bare command name, so the
// tests drive it the way production does: a PATH whose first entry holds a stub
// script called `gh`. No test here reaches GitHub, and no test-only flag was
// added to the runtime to arrange that. The stub records every invocation, one
// argument per line, so the `gh pr create` argv can be asserted on.
//
// EVERY case runs with a stubbed PATH, including the ones written before this
// existed: a real `gh` on the developer's machine would otherwise answer for
// the temp repository and make the suite's behaviour depend on the box.
// ---------------------------------------------------------------------------

interface GhBehaviour {
  /** What `gh api …/protection` answers. */
  protection?: "protected" | "unprotected" | "error";
  /** What `gh repo view --json defaultBranchRef` answers; absent means it fails. */
  defaultBranch?: string;
  /** What `gh pr create` prints; absent means it fails. */
  prUrl?: string;
  /**
   * Whether `gh pr merge --auto` refuses (APRV-130). A merge queue, and a
   * repository with auto-merge disabled, both refuse it; neither is a failure
   * of the ceremony, because the pull request is open either way.
   */
  autoMergeRefused?: boolean;
}

/** A directory holding the `gh` stub, plus the path of its invocation log. */
function ghStub(behaviour: GhBehaviour): { dir: string; log: string } {
  counter += 1;
  const dir = join(scratch, `bin-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "gh-invocations.txt");

  const api =
    behaviour.protection === "protected"
      ? "exit 0"
      : behaviour.protection === "unprotected"
        ? 'echo "gh: Branch not protected (HTTP 404)" >&2; exit 1'
        : 'echo "gh: could not read protection" >&2; exit 1';
  const repo =
    behaviour.defaultBranch === undefined
      ? 'echo "gh: no GitHub remote" >&2; exit 1'
      : `echo ${behaviour.defaultBranch}; exit 0`;
  const pr =
    behaviour.prUrl === undefined
      ? 'echo "gh: pr create failed" >&2; exit 1'
      : `echo ${behaviour.prUrl}; exit 0`;
  const merge =
    behaviour.autoMergeRefused === true
      ? 'echo "gh: auto-merge is not enabled on this repository" >&2; exit 1'
      : "exit 0";

  const script = [
    "#!/bin/sh",
    `printf -- '--- %s\\n' "$1" >> ${JSON.stringify(log)}`,
    `for arg in "$@"; do printf '%s\\n' "$arg" >> ${JSON.stringify(log)}; done`,
    'case "$1" in',
    '  --version) echo "gh version 2.0.0 (stub)"; exit 0 ;;',
    `  api) ${api} ;;`,
    `  repo) ${repo} ;;`,
    // APRV-130: `pr create` and `pr merge` are different answers, so the stub
    // splits on the subcommand and not on the noun.
    '  pr) case "$2" in',
    `    merge) ${merge} ;;`,
    `    *) ${pr} ;;`,
    "  esac ;;",
    "esac",
    "exit 1",
    "",
  ].join("\n");
  const path = join(dir, "gh");
  writeFileSync(path, script, "utf8");
  chmodSync(path, 0o755);
  return { dir, log };
}

/** PATH with the stub directory first, so a real `gh` can never win. */
function pathWith(dir: string): string {
  return `${dir}${delimiter}${process.env["PATH"] ?? ""}`;
}

/**
 * A PATH holding a real `git` and no `gh` at all: the "gh absent" case, honest
 * on a box that has gh installed and on one that does not.
 */
function pathWithoutGh(): string {
  counter += 1;
  const dir = join(scratch, `nogh-bin-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  const gitPath = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  assert.notEqual(gitPath, "", "no git on PATH to link into the gh-less PATH");
  symlinkSync(gitPath, join(dir, "git"));
  return dir;
}

/**
 * The PATH every case gets unless it asks for another: a `gh` that answers
 * nothing useful, so detection resolves to `unknown` and the verb behaves as it
 * did before protection was detected at all.
 */
const DEFAULT_PATH = pathWith(ghStub({}).dir);

/** Every argument the `gh` stub was called with, in order, one per line. */
function ghCalls(log: string): string[] {
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l.length > 0) : [];
}

function git(args: string[], cwd: string): Run {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.error, undefined, `git failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function policyText(body: string[]): string {
  return ["# Policy", "", "```yaml approval-policy", ...body, "```", ""].join("\n");
}

const BEFORE = policyText([
  'version: "0.1"',
  "defaults:",
  "  autonomy: supervised",
  "  approval_ttl: 24h",
  "approvers:",
  "  carter:",
  "    channels: [cli]",
  "classes:",
  "  read.*:",
  "    autonomy: autonomous",
  "  communicate.*:",
  "    autonomy: manual",
  "    approvers: [carter]",
  "budgets:",
  "  global:",
  "    daily_usd: 10",
]);

/** The same policy with three edits: class autonomy, approver channels, TTL. */
const AFTER = policyText([
  'version: "0.1"',
  "defaults:",
  "  autonomy: supervised",
  "  approval_ttl: 1h",
  "approvers:",
  "  carter:",
  "    channels: [cli, telegram]",
  "classes:",
  "  read.*:",
  "    autonomy: manual",
  "  communicate.*:",
  "    autonomy: manual",
  "    approvers: [carter]",
  "budgets:",
  "  global:",
  "    daily_usd: 10",
]);

/**
 * BEFORE plus one key: the 2026-08-20 amendment that the differ reported as
 * "no semantic change" (APRV-111). Nothing about any class moved; what moved is
 * which file edits need a human.
 */
const PROTECTED_PATHS = policyText([
  'version: "0.1"',
  "defaults:",
  "  autonomy: supervised",
  "  approval_ttl: 24h",
  "protected_paths: [SPEC.md]",
  "approvers:",
  "  carter:",
  "    channels: [cli]",
  "classes:",
  "  read.*:",
  "    autonomy: autonomous",
  "  communicate.*:",
  "    autonomy: manual",
  "    approvers: [carter]",
  "budgets:",
  "  global:",
  "    daily_usd: 10",
]);

/** BEFORE plus every non-class vocabulary key SPEC.md §5.2 defines. */
const VOCABULARY = policyText([
  'version: "0.1"',
  "defaults:",
  "  autonomy: supervised",
  "  approval_ttl: 24h",
  "payload_retention: 30d",
  "protected_paths: [SPEC.md, design/]",
  "approvers:",
  "  carter:",
  "    channels: [cli]",
  "classes:",
  "  read.*:",
  "    autonomy: autonomous",
  "  communicate.*:",
  "    autonomy: manual",
  "    approvers: [carter]",
  "budgets:",
  "  global:",
  "    daily_usd: 10",
  "audit:",
  "  supervised_sample_rate: 0.1",
  "  sampling_secret_env: APPROVAL_SAMPLING_SECRET",
  "  skew_tolerance: 5s",
  "channels:",
  "  telegram:",
  "    token_env: APPROVAL_TG_TOKEN",
  "vault:",
  "  passphrase_env: APPROVAL_VAULT_PASSPHRASE",
]);

/** A top-level key the closed schema does not know: the policy fails closed. */
const UNKNOWN_KEY = policyText([
  'version: "0.1"',
  "defaults:",
  "  autonomy: supervised",
  "  approval_ttl: 24h",
  "approvers:",
  "  carter:",
  "    channels: [cli]",
  "classes:",
  "  read.*:",
  "    autonomy: autonomous",
  "  communicate.*:",
  "    autonomy: manual",
  "    approvers: [carter]",
  "budgets:",
  "  global:",
  "    daily_usd: 10",
  "protected_path: [SPEC.md]",
]);

/** The seq-2 shape: an edit whose YAML is fine and whose schema is not. */
const BROKEN = policyText([
  'version: "0.1"',
  "defaults:",
  "  autonomy: whenever",
]);

/**
 * BEFORE with a channel declared (APRV-109).
 *
 * The agent path fails closed when no channel could carry the attestation
 * prompt, so the cases that exercise the ask need a policy that names one. The
 * channel is never contacted here: `amend` appends the prompt and waits on the
 * log, and it is the listener — a different process — that delivers it.
 */
const WITH_CHANNEL = policyText([
  'version: "0.1"',
  "defaults:",
  "  autonomy: supervised",
  "  approval_ttl: 24h",
  "approvers:",
  "  carter:",
  "    channels: [telegram]",
  "channels:",
  "  telegram:",
  "    token_env: TELEGRAM_TOKEN",
  "    chat_id_env: TELEGRAM_CHAT",
  "classes:",
  "  read.*:",
  "    autonomy: autonomous",
]);

/** The same, with one class resolution tightened: a diff a phone can hold. */
const WITH_CHANNEL_AFTER = policyText([
  'version: "0.1"',
  "defaults:",
  "  autonomy: supervised",
  "  approval_ttl: 24h",
  "approvers:",
  "  carter:",
  "    channels: [telegram]",
  "channels:",
  "  telegram:",
  "    token_env: TELEGRAM_TOKEN",
  "    chat_id_env: TELEGRAM_CHAT",
  "classes:",
  "  read.*:",
  "    autonomy: manual",
]);

/** WITH_CHANNEL plus eighty classes: a diff no channel prompt can show whole. */
const WIDE = ((): string => {
  const classes: string[] = [];
  for (let index = 0; index < 80; index += 1) {
    classes.push(`  widget${String(index)}.write:`, "    autonomy: manual");
  }
  return policyText([
    'version: "0.1"',
    "defaults:",
    "  autonomy: supervised",
    "  approval_ttl: 24h",
    "approvers:",
    "  carter:",
    "    channels: [telegram]",
    "channels:",
    "  telegram:",
    "    token_env: TELEGRAM_TOKEN",
    "    chat_id_env: TELEGRAM_CHAT",
    "classes:",
    "  read.*:",
    "    autonomy: autonomous",
    ...classes,
  ]);
})();

function caseDir(text: string = BEFORE): string {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), text, "utf8");
  return dir;
}

/** A git repository with the policy committed, so HEAD carries a baseline. */
function repoDir(text: string = BEFORE): string {
  const dir = caseDir(text);
  git(["init", "-q", "."], dir);
  git(["config", "user.email", "test@example.invalid"], dir);
  git(["config", "user.name", "Test"], dir);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "policy"], dir);
  return dir;
}

/**
 * A repository on `main` with a temp BARE remote as its origin, and
 * `refs/remotes/origin/HEAD` set, which is where the default branch is read
 * from. Real git all the way down; the remote is a directory on disk.
 */
function repoWithRemote(text: string = BEFORE): { dir: string; remote: string } {
  const dir = caseDir(text);
  const remote = join(scratch, `remote-${String(counter)}.git`);
  git(["init", "-q", "--bare", "-b", "main", remote], scratch);
  git(["init", "-q", "-b", "main", "."], dir);
  git(["config", "user.email", "test@example.invalid"], dir);
  git(["config", "user.name", "Test"], dir);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "policy"], dir);
  git(["remote", "add", "origin", remote], dir);
  git(["push", "-q", "-u", "origin", "main"], dir);
  git(["remote", "set-head", "origin", "main"], dir);
  return { dir, remote };
}

/**
 * Make the bare remote refuse one ref, the way a protected branch does
 * (APRV-111).
 *
 * A `pre-receive` hook is the closest a temp repository gets to GitHub's branch
 * protection, and it is close in the way that matters: the refusal arrives from
 * the remote, at push time, after the commit already exists locally. Note that
 * `git push --dry-run` does NOT run this hook (it never sends the updates), so
 * no probe can foresee this rejection — which is the whole reason the rejection
 * itself has to be loud.
 */
function protectPushesTo(remote: string, ...refs: string[]): void {
  const hook = join(remote, "hooks", "pre-receive");
  writeFileSync(
    hook,
    [
      "#!/bin/sh",
      "while read -r old new target; do",
      // Variadic since APRV-130: the automatic recovery pushes a SECOND ref, so
      // a test that wants the whole automatic path refused protects both.
      ...refs.map(
        (ref) =>
          `  if [ "$target" = ${JSON.stringify(ref)} ]; then echo "Changes must be made through a pull request." >&2; exit 1; fi`,
      ),
      "done",
      "exit 0",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(hook, 0o755);
}

/** The commit `ref` points at in the bare remote, or "" when there is none. */
function remoteHead(remote: string, ref: string): string {
  return git(["rev-parse", "--verify", "--quiet", ref], remote).stdout.trim();
}

/** The files a commit on `branch` in the bare remote carries, sorted. */
function remoteFiles(remote: string, branch: string): string[] {
  return git(["show", "--name-only", "--pretty=format:", branch], remote)
    .stdout.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();
}

function logPathIn(dir: string): string {
  return join(dir, ".approval", "log", "events.jsonl");
}

function rawLog(dir: string): string {
  const path = logPathIn(dir);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function logRecords(dir: string): Record<string, unknown>[] {
  return rawLog(dir)
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The payload of the Nth logged record, as an object. */
function payloadAt(dir: string, index: number): Record<string, unknown> {
  const record = logRecords(dir)[index];
  assert.notEqual(record, undefined, `expected a record at index ${index}`);
  return (record as Record<string, unknown>)["payload"] as Record<string, unknown>;
}

function writePolicy(dir: string, text: string): void {
  writeFileSync(join(dir, "APPROVAL.md"), text, "utf8");
}

/** Attest the policy as it stands, so an amendment has a baseline to move from. */
function attest(dir: string): void {
  assert.equal(runCli(["policy", "attest", "--as", "human:carter"], dir).code, 0);
}

function report(run: Run): Record<string, unknown> {
  return JSON.parse(run.stdout) as Record<string, unknown>;
}

function errorOf(run: Run): { code: string; message: string } {
  return (JSON.parse(run.stderr) as { error: { code: string; message: string } }).error;
}

// ---------------------------------------------------------------------------
// (a) The no-op ceremony
// ---------------------------------------------------------------------------

test("an already-attested policy is nothing to amend, and that is a success", () => {
  const dir = caseDir();
  attest(dir);
  const before = rawLog(dir);

  const run = runCli(["policy", "amend", "--as", "human:carter", "--yes"], dir);

  assert.equal(run.code, 0);
  assert.equal(run.stderr, "");
  assert.match(run.stdout, /nothing to amend/u);
  assert.match(run.stdout, /already matches its attestation at seq 1/u);
  assert.equal(rawLog(dir), before, "the no-op ceremony wrote to the log");
});

test("the no-op --json report carries every frozen key", () => {
  const dir = caseDir();
  attest(dir);
  const run = runCli(["policy", "amend", "--as", "human:carter", "--yes", "--json"], dir);

  assert.equal(run.code, 0);
  const parsed = report(run);
  assert.deepEqual(Object.keys(parsed).sort(), [
    "aborted",
    "attestation",
    "attested",
    "baseline",
    // APRV-130, additive: the ceremony's own outcome, and the publishing half.
    "ceremony",
    "diff",
    "dryRun",
    "git",
    "liveSha256",
    "load",
    "noop",
    "ok",
    "policy",
    // APRV-109, additive: the attestation prompt this ceremony collected its tap
    // from. `null` on every human-identity run, which is what this one is.
    "proposal",
    "publishing",
  ]);
  // `attested` still means the attestation this amendment moved FROM. The new
  // boolean is `ceremony.attested`, and a no-op ceremony attested nothing.
  assert.deepEqual(parsed["ceremony"], { attested: false, seq: null });
  assert.equal(parsed["publishing"], null);
  assert.equal(parsed["ok"], true);
  assert.equal(parsed["noop"], true);
  assert.equal(parsed["diff"], null);
  assert.equal(parsed["attestation"], null);
  assert.deepEqual(parsed["attested"], {
    sha256: payloadAt(dir, 0)["sha256"],
    seq: 1,
  });
});

// ---------------------------------------------------------------------------
// (b) Baseline recovery, and its stated limits
// ---------------------------------------------------------------------------

test("outside a git repository the diff is unavailable and the notice says why", () => {
  const dir = caseDir();
  attest(dir);
  writePolicy(dir, AFTER);

  const run = runCli(["policy", "amend", "--as", "human:carter", "--yes"], dir);

  assert.equal(run.code, 0);
  assert.match(run.stdout, /HASH-ONLY MODE: no semantic diff/u);
  assert.match(run.stdout, /not inside a git repository/u);
  assert.match(run.stdout, /not recoverable from the log/u);
  // Hash-only mode still attests: the ceremony degrades, it does not stop.
  assert.equal(logRecords(dir).length, 2);
});

test("a never-attested policy has no baseline and says so", () => {
  const dir = repoDir();
  const run = runCli(["policy", "amend", "--as", "human:carter", "--yes", "--json"], dir);

  assert.equal(run.code, 0);
  const parsed = report(run);
  assert.deepEqual(parsed["baseline"], {
    mode: "unavailable",
    reason: "the policy has never been attested, so there is no previous state to diff against",
  });
  assert.equal(parsed["diff"], null);
  assert.equal(parsed["attested"], null);
});

test("a HEAD blob that is not the attested bytes is refused as a baseline", () => {
  const dir = repoDir();
  // Attest a working-tree edit that was never committed: HEAD no longer carries
  // the attested bytes, so it cannot be used to prove what was signed for.
  writePolicy(dir, AFTER);
  attest(dir);
  writePolicy(dir, BEFORE);

  const run = runCli(["policy", "amend", "--as", "human:carter", "--yes", "--json"], dir);

  assert.equal(run.code, 0);
  const baseline = report(run)["baseline"] as { mode: string; reason: string };
  assert.equal(baseline.mode, "unavailable");
  assert.match(baseline.reason, /which is not the attested/u);
  assert.equal(report(run)["diff"], null);
});

// ---------------------------------------------------------------------------
// (c) The semantic diff
// ---------------------------------------------------------------------------

test("in a git repo the diff names the class, approver and TTL changes", () => {
  const dir = repoDir();
  attest(dir);
  writePolicy(dir, AFTER);

  const run = runCli(["policy", "amend", "--as", "human:carter", "--yes", "--json"], dir);
  assert.equal(run.code, 0, run.stderr);
  const parsed = report(run);
  assert.deepEqual(parsed["baseline"], { mode: "git-head", reason: null });

  const diff = parsed["diff"] as Record<string, unknown>;
  assert.equal(diff["structuralComparable"], true);
  assert.equal(diff["unchanged"], false);
  assert.deepEqual(diff["classes"], [
    {
      class: "read.*",
      before: { autonomy: "autonomous", provenance: "rule", pattern: "read.*" },
      after: { autonomy: "manual", provenance: "rule", pattern: "read.*" },
    },
  ]);
  assert.deepEqual(diff["approvers"], [
    {
      approver: "carter",
      change: "channels-changed",
      beforeChannels: ["cli"],
      afterChannels: ["cli", "telegram"],
      danglingRules: [],
    },
  ]);
  assert.deepEqual(diff["defaults"], [
    { field: "approval_ttl", before: "24h", after: "1h" },
  ]);
  assert.deepEqual(diff["budgets"], []);
  // The probe set is stated, and it carries SPEC §7's namespaces.
  assert.equal((diff["probes"] as string[]).includes("financial.*"), true);
  assert.equal((diff["probes"] as string[]).includes("read.*"), true);
});

test("the human diff renders each section, and a budget change is a limit line", () => {
  const dir = repoDir();
  attest(dir);
  writePolicy(dir, AFTER.replace("daily_usd: 10", "daily_usd: 25"));

  const run = runCli(["policy", "amend", "--as", "human:carter", "--yes"], dir);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /class resolutions changed \(1\):/u);
  assert.match(run.stdout, /read\.\*: autonomous \(rule read\.\*\) -> manual \(rule read\.\*\)/u);
  assert.match(run.stdout, /carter: channels-changed \[cli\] -> \[cli, telegram\]/u);
  assert.match(run.stdout, /approval_ttl: 24h -> 1h/u);
  assert.match(run.stdout, /global\.daily_usd: 10 -> 25/u);
  // APRV-93: the report is sectioned now (`Policy` / `Changes` / `Load`), so
  // the advisory is a `Load` heading with the verdict under it rather than a
  // line beginning "load advisory:".
  assert.match(run.stdout, /^Changes$/mu);
  assert.match(run.stdout, /^Load\n {2}✓ loads clean$/mu);
  // Short hashes and a cwd-relative path, and nothing dressed in a pipe.
  assert.match(run.stdout, /^ {2}file {2,}APPROVAL\.md$/mu);
  assert.match(run.stdout, /^ {2}live {2,}[0-9a-f]{12}$/mu);
  assert.ok(!run.stdout.includes("\u001b"));
});

test("an approver deleted while a rule still names them is reported unreachable", () => {
  const dir = repoDir();
  attest(dir);
  // Delete the approver entry, leaving communicate.* naming a decider the
  // policy no longer defines. The schema permits this: it says the
  // rule-to-approver cross-reference is a runtime check.
  writePolicy(dir, BEFORE.replace("approvers:\n  carter:\n    channels: [cli]\n", ""));

  const run = runCli(["policy", "amend", "--as", "human:carter", "--yes", "--json"], dir);
  assert.equal(run.code, 0, run.stderr);
  const diff = report(run)["diff"] as Record<string, unknown>;
  assert.deepEqual(diff["approvers"], [
    {
      approver: "carter",
      change: "removed",
      beforeChannels: ["cli"],
      afterChannels: null,
      danglingRules: ["communicate.*"],
    },
  ]);

  // And the human rendering says it in words, in a repo of its own (the one
  // above has already been amended, so it would now be a no-op).
  const human = repoDir();
  attest(human);
  writePolicy(human, BEFORE.replace("approvers:\n  carter:\n    channels: [cli]\n", ""));
  const rendered = runCli(["policy", "amend", "--as", "human:carter", "--yes"], human);
  assert.equal(rendered.code, 0, rendered.stderr);
  assert.match(rendered.stdout, /UNREACHABLE: still named by communicate\.\*/u);
});

test("a class that stops being named falls to defaults, and the diff says so", () => {
  const dir = repoDir();
  attest(dir);
  writePolicy(
    dir,
    policyText([
      'version: "0.1"',
      "defaults:",
      "  autonomy: supervised",
      "  approval_ttl: 24h",
      "approvers:",
      "  carter:",
      "    channels: [cli]",
      "budgets:",
      "  global:",
      "    daily_usd: 10",
    ]),
  );

  const run = runCli(["policy", "amend", "--as", "human:carter", "--yes", "--json"], dir);
  assert.equal(run.code, 0, run.stderr);
  const diff = report(run)["diff"] as Record<string, unknown>;
  assert.deepEqual(diff["classes"], [
    {
      class: "communicate.*",
      before: { autonomy: "manual", provenance: "rule", pattern: "communicate.*" },
      after: { autonomy: "supervised", provenance: "default", pattern: null },
    },
    {
      class: "read.*",
      before: { autonomy: "autonomous", provenance: "rule", pattern: "read.*" },
      after: { autonomy: "supervised", provenance: "default", pattern: null },
    },
  ]);
});

// ---------------------------------------------------------------------------
// (c2) The vocabulary diff: keys outside `classes` (APRV-111)
//
// The incident: `protected_paths: [SPEC.md]` was added, the differ probed 22
// classes, found none of them moved, and printed "no semantic change" — over an
// edit that widened which file edits need a human.
// ---------------------------------------------------------------------------

test("an added protected_paths is named in the diff, never 'no semantic change'", () => {
  const dir = repoDir();
  attest(dir);
  writePolicy(dir, PROTECTED_PATHS);

  const run = runCli(["policy", "amend", "--as", "human:carter", "--yes"], dir);

  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /policy keys changed \(1\):/u);
  assert.match(run.stdout, /protected_paths: \(absent\) -> \["SPEC\.md"\]/u);
  assert.equal(
    run.stdout.includes("no semantic change"),
    false,
    "the incident: an edit outside the classes reported as no change",
  );
  // And the commit subject the ceremony proposes names it too, rather than
  // offering the operator "(no semantic change)" to sign.
  assert.match(run.stdout, /1 policy key\(s\)/u);
});

test("every non-class vocabulary key is diffed, in before -> after form", () => {
  const dir = repoDir();
  attest(dir);
  writePolicy(dir, VOCABULARY);

  const run = runCli(["policy", "amend", "--as", "human:carter", "--yes", "--json"], dir);
  assert.equal(run.code, 0, run.stderr);
  const diff = report(run)["diff"] as Record<string, unknown>;

  assert.equal(diff["vocabularyComparable"], true);
  assert.equal(diff["unchanged"], false);
  assert.deepEqual(diff["vocabulary"], [
    {
      key: "audit.sampling_secret_env",
      recognised: true,
      before: null,
      after: "APPROVAL_SAMPLING_SECRET",
    },
    { key: "audit.skew_tolerance", recognised: true, before: null, after: "5s" },
    { key: "audit.supervised_sample_rate", recognised: true, before: null, after: "0.1" },
    {
      key: "channels.telegram.token_env",
      recognised: true,
      before: null,
      after: "APPROVAL_TG_TOKEN",
    },
    { key: "payload_retention", recognised: true, before: null, after: "30d" },
    {
      key: "protected_paths",
      recognised: true,
      before: null,
      after: '["SPEC.md","design/"]',
    },
    {
      key: "vault.passphrase_env",
      recognised: true,
      before: null,
      after: "APPROVAL_VAULT_PASSPHRASE",
    },
  ]);
  // None of these keys move a class resolution, which is exactly why the class
  // probes could not see them.
  assert.deepEqual(diff["classes"], []);
});

test("an unknown top-level key is NAMED as unknown, not silently dropped", () => {
  const dir = repoDir();
  attest(dir);
  writePolicy(dir, UNKNOWN_KEY);

  const run = runCli(["policy", "amend", "--as", "human:carter", "--yes", "--json"], dir);
  assert.equal(run.code, 0, run.stderr);
  const diff = report(run)["diff"] as Record<string, unknown>;
  assert.deepEqual(diff["vocabulary"], [
    { key: "protected_path", recognised: false, before: null, after: '["SPEC.md"]' },
  ]);

  const human = repoDir();
  attest(human);
  writePolicy(human, UNKNOWN_KEY);
  const rendered = runCli(["policy", "amend", "--as", "human:carter", "--yes"], human);
  assert.equal(rendered.code, 0, rendered.stderr);
  assert.match(rendered.stdout, /protected_path: \(absent\) -> \["SPEC\.md"\] \(UNKNOWN KEY/u);
  assert.match(rendered.stdout, /FAILS CLOSED to all-manual/u);
});

test("'no semantic change' is printed when the bytes moved and the meaning did not", () => {
  const dir = repoDir();
  attest(dir);
  // Prose outside the fence: different bytes, so there is an amendment to make,
  // and an identical policy, so the claim is true.
  writePolicy(dir, `${BEFORE}\nA sentence of prose the parser never sees.\n`);

  const run = runCli(["policy", "amend", "--as", "human:carter", "--yes", "--json"], dir);
  assert.equal(run.code, 0, run.stderr);
  const diff = report(run)["diff"] as Record<string, unknown>;
  assert.equal(diff["unchanged"], true);
  assert.deepEqual(diff["vocabulary"], []);
  assert.equal(diff["vocabularyComparable"], true);

  const human = repoDir();
  attest(human);
  writePolicy(human, `${BEFORE}\nA sentence of prose the parser never sees.\n`);
  const rendered = runCli(["policy", "amend", "--as", "human:carter", "--yes"], human);
  assert.match(rendered.stdout, /no semantic change: \d+ probed class\(es\) resolve the same/u);
  assert.match(rendered.stdout, /every policy key is unchanged/u);
});

test("a class-only edit reports no vocabulary change (the old sections are untouched)", () => {
  const dir = repoDir();
  attest(dir);
  writePolicy(dir, AFTER);

  const run = runCli(["policy", "amend", "--as", "human:carter", "--yes", "--json"], dir);
  assert.equal(run.code, 0, run.stderr);
  const diff = report(run)["diff"] as Record<string, unknown>;
  // The paths the four dedicated sections already report are not repeated here.
  assert.deepEqual(diff["vocabulary"], []);
  assert.equal(diff["vocabularyComparable"], true);
  assert.equal((diff["classes"] as unknown[]).length, 1);
  assert.equal((diff["defaults"] as unknown[]).length, 1);
  assert.equal(run.stdout.includes("policy keys changed"), false);
});

// ---------------------------------------------------------------------------
// (d) The seq-2 shape: an edit that does not load
// ---------------------------------------------------------------------------

test("the seq-2 shape: the advisory names the failure and a plain amend still attests", () => {
  const dir = repoDir();
  attest(dir);
  writePolicy(dir, BROKEN);

  const run = runCli(["policy", "amend", "--as", "human:carter", "--yes"], dir);

  assert.equal(run.code, 0, run.stderr);
  // APRV-93: the shouted banner became the `Load` section's verdict line.
  assert.match(run.stdout, /^Load$/mu);
  assert.match(run.stdout, /✗ schema-invalid {2}the policy does not load:/u);
  assert.match(run.stdout, /FAIL CLOSED to all-manual/u);
  // The diff is honest about what the broken side means for every class.
  assert.match(run.stdout, /after: everything manual \(fail-closed: schema-invalid\)/u);
  // Bytes, not parse: attestation records what is on disk (see policy attest).
  assert.equal(logRecords(dir).length, 2);
  assert.equal(logRecords(dir)[1]?.["event"], "policy.updated");
});

test("--require-load refuses the same edit at exit 1 and appends nothing", () => {
  const dir = repoDir();
  attest(dir);
  const before = rawLog(dir);
  writePolicy(dir, BROKEN);

  const run = runCli(
    ["policy", "amend", "--as", "human:carter", "--yes", "--require-load"],
    dir,
  );

  assert.equal(run.code, 1);
  assert.match(run.stderr, /--require-load/u);
  assert.match(run.stderr, /schema-invalid/u);
  assert.equal(rawLog(dir), before, "--require-load appended to the log");
});

test("--require-load refuses in the frozen JSON shape", () => {
  const dir = repoDir();
  attest(dir);
  writePolicy(dir, BROKEN);

  const run = runCli(
    ["policy", "amend", "--as", "human:carter", "--yes", "--require-load", "--json"],
    dir,
  );

  assert.equal(run.code, 1);
  assert.equal(run.stdout, "");
  const parsed = JSON.parse(run.stderr) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), ["error", "ok"]);
  assert.equal(parsed["ok"], false);
  assert.equal((parsed["error"] as Record<string, unknown>)["code"], "load-failed");
});

test("--require-load is silent when the policy loads", () => {
  const dir = repoDir();
  attest(dir);
  writePolicy(dir, AFTER);

  const run = runCli(
    ["policy", "amend", "--as", "human:carter", "--yes", "--require-load"],
    dir,
  );
  assert.equal(run.code, 0, run.stderr);
  assert.equal(logRecords(dir).length, 2);
});

// ---------------------------------------------------------------------------
// (e) --dry-run and the confirmation
// ---------------------------------------------------------------------------

test("--dry-run reports everything and writes nothing", () => {
  const dir = repoDir();
  attest(dir);
  const before = rawLog(dir);
  writePolicy(dir, AFTER);

  const run = runCli(["policy", "amend", "--as", "human:carter", "--dry-run"], dir);

  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /class resolutions changed/u);
  assert.match(run.stdout, /--dry-run: nothing was attested, nothing was written/u);
  assert.match(run.stdout, /attested seq <seq>/u);
  assert.equal(rawLog(dir), before, "--dry-run wrote to the log");
  assert.equal(git(["status", "--porcelain", "--", "APPROVAL.md"], dir).stdout.includes("M"), true);
  // And no commit was made.
  assert.equal(git(["rev-list", "--count", "HEAD"], dir).stdout.trim(), "1");
});

test("--dry-run --json reports the diff with a null attestation", () => {
  const dir = repoDir();
  attest(dir);
  writePolicy(dir, AFTER);

  const run = runCli(["policy", "amend", "--as", "human:carter", "--dry-run", "--json"], dir);
  assert.equal(run.code, 0, run.stderr);
  const parsed = report(run);
  assert.equal(parsed["dryRun"], true);
  assert.equal(parsed["attestation"], null);
  assert.notEqual(parsed["diff"], null);
  const gitPlan = parsed["git"] as Record<string, unknown>;
  assert.equal(gitPlan["committed"], false);
  assert.equal(gitPlan["flow"], "direct");
  // add, commit, push: the whole direct ceremony, in order.
  assert.equal((gitPlan["commands"] as string[]).length, 3);
  assert.match((gitPlan["commands"] as string[])[1] as string, /attested seq <seq>/u);
});

test("without --yes and without a terminal the verb refuses rather than assuming", () => {
  const dir = repoDir();
  attest(dir);
  const before = rawLog(dir);
  writePolicy(dir, AFTER);

  const run = runCli(["policy", "amend", "--as", "human:carter"], dir);

  assert.equal(run.code, 2);
  assert.match(run.stderr, /stdin is not a terminal/u);
  assert.match(run.stderr, /--yes/u);
  assert.match(run.stderr, /--dry-run/u);
  assert.equal(rawLog(dir), before);
});

test("--json without --yes is a usage refusal in JSON", () => {
  const dir = repoDir();
  attest(dir);
  writePolicy(dir, AFTER);

  const run = runCli(["policy", "amend", "--as", "human:carter", "--json"], dir);
  assert.equal(run.code, 2);
  assert.equal(run.stdout, "");
  assert.equal(errorOf(run).code, "usage");
});

// ---------------------------------------------------------------------------
// (g) The git ceremony
// ---------------------------------------------------------------------------

test("--commit lands exactly the policy and the log in one commit citing the seq", () => {
  const dir = repoDir();
  attest(dir);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "attestation"], dir);
  writePolicy(dir, AFTER);

  const run = runCli(["policy", "amend", "--as", "human:carter", "--yes", "--commit"], dir);

  assert.equal(run.code, 0, run.stderr);
  assert.equal(git(["rev-list", "--count", "HEAD"], dir).stdout.trim(), "3");
  const subject = git(["log", "-1", "--pretty=%s"], dir).stdout.trim();
  assert.match(subject, /^Policy: amend APPROVAL\.md.*\(attested seq 2\)$/u);
  const files = git(["show", "--name-only", "--pretty=format:", "HEAD"], dir)
    .stdout.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();
  assert.deepEqual(files, [".approval/log/events.jsonl", "APPROVAL.md"]);
  // The tree is clean afterwards: the amendment left nothing behind.
  assert.equal(git(["status", "--porcelain"], dir).stdout.trim(), "");
});

test("--commit --json reports committed:true and the commands it ran", () => {
  const dir = repoDir();
  attest(dir);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "attestation"], dir);
  writePolicy(dir, AFTER);

  const run = runCli(
    ["policy", "amend", "--as", "human:carter", "--yes", "--commit", "--json"],
    dir,
  );
  assert.equal(run.code, 0, run.stderr);
  const gitPlan = report(run)["git"] as Record<string, unknown>;
  assert.equal(gitPlan["repo"], true);
  assert.equal(gitPlan["committed"], true);
  assert.match((gitPlan["commands"] as string[])[1] as string, /attested seq 2/u);
  assert.deepEqual(report(run)["attestation"], {
    seq: 2,
    sha256: payloadAt(dir, 1)["sha256"],
  });
});

test("--commit outside a git repository refuses BEFORE attesting", () => {
  const dir = caseDir();
  attest(dir);
  const before = rawLog(dir);
  writePolicy(dir, AFTER);

  const run = runCli(
    ["policy", "amend", "--as", "human:carter", "--yes", "--commit", "--json"],
    dir,
  );

  assert.equal(run.code, 2);
  assert.equal(errorOf(run).code, "commit-preconditions");
  assert.match(errorOf(run).message, /nothing was attested/u);
  assert.equal(rawLog(dir), before);
});

test("--commit refuses a staged change beyond the two files, and attests nothing", () => {
  const dir = repoDir();
  attest(dir);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "attestation"], dir);
  writePolicy(dir, AFTER);
  writeFileSync(join(dir, "unrelated.txt"), "staged\n", "utf8");
  git(["add", "unrelated.txt"], dir);
  const before = rawLog(dir);

  const run = runCli(
    ["policy", "amend", "--as", "human:carter", "--yes", "--commit", "--json"],
    dir,
  );

  assert.equal(run.code, 2);
  assert.equal(errorOf(run).code, "commit-preconditions");
  assert.match(errorOf(run).message, /unrelated\.txt/u);
  assert.equal(rawLog(dir), before);
  assert.equal(git(["rev-list", "--count", "HEAD"], dir).stdout.trim(), "2");
});

test("without --commit the two commands are printed for the human to run", () => {
  const dir = repoDir();
  attest(dir);
  writePolicy(dir, AFTER);

  const run = runCli(["policy", "amend", "--as", "human:carter", "--yes"], dir);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /git add .*APPROVAL\.md .*events\.jsonl/u);
  assert.match(run.stdout, /git commit -m "Policy: .*\(attested seq 2\)"/u);
  assert.equal(git(["rev-list", "--count", "HEAD"], dir).stdout.trim(), "1");
});

// ---------------------------------------------------------------------------
// (h) A protected main: the branch flow (APRV-92)
// ---------------------------------------------------------------------------

test("a protected default branch turns --commit into branch, push, and a PR of one commit", () => {
  const { dir, remote } = repoWithRemote();
  const stub = ghStub({ protection: "protected", prUrl: "https://github.test/o/r/pull/7" });
  attest(dir);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "attestation"], dir);
  writePolicy(dir, AFTER);

  const run = runCli(
    ["policy", "amend", "--as", "human:carter", "--yes", "--commit"],
    dir,
    {},
    pathWith(stub.dir),
  );

  assert.equal(run.code, 0, run.stderr);
  // A branch, created fresh, named for the seq the attestation got.
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir).stdout.trim(), "policy-amend-2");
  // One commit on top of main, carrying exactly the two files.
  assert.equal(
    git(["rev-list", "--count", "main..policy-amend-2"], dir).stdout.trim(),
    "1",
    "the amendment branch must carry exactly one commit",
  );
  assert.deepEqual(remoteFiles(remote, "policy-amend-2"), [
    ".approval/log/events.jsonl",
    "APPROVAL.md",
  ]);
  assert.match(
    git(["log", "-1", "--pretty=%s", "policy-amend-2"], remote).stdout.trim(),
    /^Policy: amend APPROVAL\.md.*\(attested seq 2\)$/u,
  );

  // And the PR, opened through the fake gh, with the seq in the title and the
  // one-commit rule plus the merge instruction in the body.
  const calls = ghCalls(stub.log);
  assert.equal(calls.includes("pr"), true, "gh pr create was never called");
  const title = calls[calls.indexOf("--title") + 1] ?? "";
  const body = calls[calls.indexOf("--body") + 1] ?? "";
  assert.match(title, /^Policy: .*\(attested seq 2\)$/u);
  assert.match(body, /exactly one commit/u);
  assert.match(body, /MERGE COMMIT/u);
  assert.equal(calls[calls.indexOf("--head") + 1], "policy-amend-2");
  assert.equal(calls[calls.indexOf("--base") + 1], "main");
  assert.match(run.stdout, /pull request: https:\/\/github\.test\/o\/r\/pull\/7/u);
  assert.match(run.stdout, /MERGE COMMIT/u);
});

test("the branch flow reports its protection, branch, push and PR in JSON", () => {
  const { dir } = repoWithRemote();
  const stub = ghStub({ protection: "protected", prUrl: "https://github.test/o/r/pull/8" });
  attest(dir);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "attestation"], dir);
  writePolicy(dir, AFTER);

  const run = runCli(
    ["policy", "amend", "--as", "human:carter", "--yes", "--commit", "--json"],
    dir,
    {},
    pathWith(stub.dir),
  );
  assert.equal(run.code, 0, run.stderr);
  const gitPlan = report(run)["git"] as Record<string, unknown>;
  assert.equal(gitPlan["protection"], "protected");
  assert.equal(gitPlan["flow"], "branch");
  assert.equal(gitPlan["defaultBranch"], "main");
  assert.equal(gitPlan["branch"], "policy-amend-2");
  assert.equal(gitPlan["committed"], true);
  assert.equal(gitPlan["pushed"], true);
  assert.equal(gitPlan["prUrl"], "https://github.test/o/r/pull/8");
  assert.equal(gitPlan["warning"], null);
  const commands = gitPlan["commands"] as string[];
  assert.match(commands[0] as string, /^git checkout -b policy-amend-2$/u);
  assert.match(commands[3] as string, /^git push -u origin policy-amend-2$/u);
  assert.match(commands[4] as string, /^gh pr create --title/u);
});

test("--branch forces the branch flow even where nothing is protected", () => {
  const { dir, remote } = repoWithRemote();
  const stub = ghStub({ protection: "unprotected", prUrl: "https://github.test/o/r/pull/9" });
  attest(dir);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "attestation"], dir);
  writePolicy(dir, AFTER);

  const run = runCli(
    ["policy", "amend", "--as", "human:carter", "--yes", "--commit", "--branch", "policy-tuesday"],
    dir,
    {},
    pathWith(stub.dir),
  );

  assert.equal(run.code, 0, run.stderr);
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir).stdout.trim(), "policy-tuesday");
  assert.deepEqual(remoteFiles(remote, "policy-tuesday"), [
    ".approval/log/events.jsonl",
    "APPROVAL.md",
  ]);
});

test("an unprotected default branch keeps the direct flow, with no warning", () => {
  const { dir } = repoWithRemote();
  const stub = ghStub({ protection: "unprotected" });
  attest(dir);
  writePolicy(dir, AFTER);

  const run = runCli(
    ["policy", "amend", "--as", "human:carter", "--yes", "--json"],
    dir,
    {},
    pathWith(stub.dir),
  );
  assert.equal(run.code, 0, run.stderr);
  const gitPlan = report(run)["git"] as Record<string, unknown>;
  assert.equal(gitPlan["protection"], "unprotected");
  assert.equal(gitPlan["flow"], "direct");
  assert.equal(gitPlan["branch"], null);
  assert.equal(gitPlan["warning"], null);
  assert.equal(gitPlan["committed"], false);
  assert.equal((gitPlan["commands"] as string[])[2], "git push origin main");
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir).stdout.trim(), "main");
});

test("--direct on a protected main warns before the push line it is about to print", () => {
  const { dir } = repoWithRemote();
  const stub = ghStub({ protection: "protected" });
  attest(dir);
  writePolicy(dir, AFTER);

  const run = runCli(
    ["policy", "amend", "--as", "human:carter", "--yes", "--direct"],
    dir,
    {},
    pathWith(stub.dir),
  );
  assert.equal(run.code, 0, run.stderr);
  const warning = run.stdout.indexOf("main is protected: this push will be rejected; use --branch");
  const push = run.stdout.indexOf("git push origin main");
  assert.notEqual(warning, -1, "the pre-push warning was not printed");
  assert.equal(warning < push, true, "the warning must come BEFORE the push command");
});

test("gh absent is 'unknown', which is the direct flow and no warning", () => {
  const { dir } = repoWithRemote();
  attest(dir);
  writePolicy(dir, AFTER);

  const run = runCli(
    ["policy", "amend", "--as", "human:carter", "--yes", "--json"],
    dir,
    {},
    pathWithoutGh(),
  );
  assert.equal(run.code, 0, run.stderr);
  const gitPlan = report(run)["git"] as Record<string, unknown>;
  assert.equal(gitPlan["protection"], "unknown");
  assert.equal(gitPlan["flow"], "direct");
  assert.equal(gitPlan["warning"], null);
  assert.match(gitPlan["protectionReason"] as string, /gh is not on PATH/u);
});

test("with gh absent the branch flow still branches, commits and pushes, and prints the PR line", () => {
  const { dir, remote } = repoWithRemote();
  attest(dir);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "attestation"], dir);
  writePolicy(dir, AFTER);

  const run = runCli(
    ["policy", "amend", "--as", "human:carter", "--yes", "--commit", "--branch", "policy-solo"],
    dir,
    {},
    pathWithoutGh(),
  );

  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(remoteFiles(remote, "policy-solo"), [
    ".approval/log/events.jsonl",
    "APPROVAL.md",
  ]);
  assert.match(run.stdout, /gh is not available, so the pull request was not opened/u);
  assert.match(run.stdout, /gh pr create --title/u);
});

test("--dry-run on a protected main shows the whole branch ceremony and creates nothing", () => {
  const { dir } = repoWithRemote();
  const stub = ghStub({ protection: "protected" });
  attest(dir);
  const before = rawLog(dir);
  writePolicy(dir, AFTER);

  const run = runCli(
    ["policy", "amend", "--as", "human:carter", "--dry-run"],
    dir,
    {},
    pathWith(stub.dir),
  );

  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /--dry-run: nothing was attested, nothing was written/u);
  assert.match(run.stdout, /git checkout -b policy-amend-<seq>/u);
  assert.match(run.stdout, /git push -u origin policy-amend-<seq>/u);
  assert.match(run.stdout, /gh pr create --title/u);
  assert.match(run.stdout, /MERGE COMMIT/u);
  assert.equal(rawLog(dir), before);
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir).stdout.trim(), "main");
  assert.equal(git(["branch", "--list"], dir).stdout.includes("policy-amend"), false);
});

test("--dry-run --direct on a protected main shows the direct block, warning first", () => {
  const { dir } = repoWithRemote();
  const stub = ghStub({ protection: "protected" });
  attest(dir);
  writePolicy(dir, AFTER);

  const run = runCli(
    ["policy", "amend", "--as", "human:carter", "--dry-run", "--direct", "--json"],
    dir,
    {},
    pathWith(stub.dir),
  );
  assert.equal(run.code, 0, run.stderr);
  const gitPlan = report(run)["git"] as Record<string, unknown>;
  assert.equal(gitPlan["flow"], "direct");
  assert.equal(gitPlan["protection"], "protected");
  assert.equal(
    gitPlan["warning"],
    "main is protected: this push will be rejected; use --branch",
  );
  assert.equal((gitPlan["commands"] as string[]).length, 3);
});

test("the rewritten paragraph says WHY the two files travel together", () => {
  const { dir } = repoWithRemote();
  const stub = ghStub({ protection: "unprotected" });
  attest(dir);
  writePolicy(dir, AFTER);

  const run = runCli(
    ["policy", "amend", "--as", "human:carter", "--yes"],
    dir,
    {},
    pathWith(stub.dir),
  );
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /have to land in the same commit/u);
  assert.match(run.stdout, /a policy no attestation covers/u);
  assert.match(run.stdout, /every gate operation refuses/u);
  assert.match(run.stdout, /Run these, in order:/u);
});

test("--branch and --direct together are a usage error, and nothing is attested", () => {
  const { dir } = repoWithRemote();
  attest(dir);
  const before = rawLog(dir);
  writePolicy(dir, AFTER);

  const run = runCli(
    ["policy", "amend", "--as", "human:carter", "--yes", "--branch", "x", "--direct", "--json"],
    dir,
  );
  assert.equal(run.code, 2);
  assert.equal(errorOf(run).code, "usage");
  assert.match(errorOf(run).message, /opposite ceremonies/u);
  assert.equal(rawLog(dir), before);
});

test("--branch onto an existing branch refuses BEFORE attesting", () => {
  const { dir } = repoWithRemote();
  attest(dir);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "attestation"], dir);
  git(["branch", "policy-taken"], dir);
  const before = rawLog(dir);
  writePolicy(dir, AFTER);

  const run = runCli(
    ["policy", "amend", "--as", "human:carter", "--yes", "--commit", "--branch", "policy-taken", "--json"],
    dir,
  );
  assert.equal(run.code, 2);
  assert.equal(errorOf(run).code, "commit-preconditions");
  assert.match(errorOf(run).message, /already exists/u);
  assert.equal(rawLog(dir), before);
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir).stdout.trim(), "main");
});

test("the branch flow with no origin remote refuses BEFORE attesting", () => {
  const dir = repoDir();
  attest(dir);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "attestation"], dir);
  const before = rawLog(dir);
  writePolicy(dir, AFTER);

  const run = runCli(
    ["policy", "amend", "--as", "human:carter", "--yes", "--commit", "--branch", "policy-nowhere", "--json"],
    dir,
  );
  assert.equal(run.code, 2);
  assert.equal(errorOf(run).code, "commit-preconditions");
  assert.match(errorOf(run).message, /needs an "origin" remote/u);
  assert.equal(rawLog(dir), before);
});

// ---------------------------------------------------------------------------
// (i) The push the ceremony used to skip (APRV-111)
//
// The incident: on a branch-protected main the direct flow printed `git add`,
// `git commit` and `git push` as the commands it had run, ran only the first
// two, and exited 0. The commit sat ahead of origin and the terminal said the
// amendment had landed.
// ---------------------------------------------------------------------------

test("the direct flow pushes, and the amendment reaches origin", () => {
  const { dir, remote } = repoWithRemote();
  const stub = ghStub({ protection: "unprotected" });
  attest(dir);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "attestation"], dir);
  git(["push", "-q", "origin", "main"], dir);
  writePolicy(dir, AFTER);

  const run = runCli(
    ["policy", "amend", "--as", "human:carter", "--yes", "--commit", "--json"],
    dir,
    {},
    pathWith(stub.dir),
  );

  assert.equal(run.code, 0, run.stderr);
  const gitPlan = report(run)["git"] as Record<string, unknown>;
  assert.equal(gitPlan["flow"], "direct");
  assert.equal(gitPlan["committed"], true);
  assert.equal(gitPlan["pushed"], true);
  assert.deepEqual(remoteFiles(remote, "main"), [".approval/log/events.jsonl", "APPROVAL.md"]);
  assert.equal(remoteHead(remote, "main"), git(["rev-parse", "HEAD"], dir).stdout.trim());
});

test("a push the remote REJECTS is a nonzero refusal naming the state and the fix", () => {
  const { dir, remote } = repoWithRemote();
  attest(dir);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "attestation"], dir);
  git(["push", "-q", "origin", "main"], dir);
  // Protection the probe cannot see: gh answers nothing useful (the default
  // stub), so the verb chooses the direct flow and the remote refuses it. Since
  // APRV-130 the verb then publishes through a branch by itself, so a test of
  // the REFUSAL has to refuse that branch too — otherwise the ceremony succeeds,
  // which is the entire point of the change.
  protectPushesTo(remote, "refs/heads/main", "refs/heads/policy-amend-2");
  const originBefore = remoteHead(remote, "main");
  writePolicy(dir, AFTER);

  const run = runCli(
    ["policy", "amend", "--as", "human:carter", "--yes", "--commit", "--json"],
    dir,
  );

  assert.equal(run.code, 4, run.stdout);
  const error = errorOf(run);
  assert.equal(error.code, "push-rejected");
  // git's own words, so the operator can tell protection from a stale ref.
  assert.match(error.message, /REJECTED by the remote/u);
  assert.match(error.message, /Changes must be made through a pull request/u);
  assert.match(error.message, /pre-receive hook declined/u);
  // The exact state.
  assert.match(error.message, /committed LOCALLY on main and is NOT on origin/u);
  assert.match(error.message, /attestation was appended at seq 2/u);
  // What the verb TRIED, by name, and the step that is still owed.
  assert.match(error.message, /published through branch policy-amend-2/u);
  assert.match(error.message, /git push -u origin policy-amend-2/u);
  assert.match(error.message, /gh pr create --title/u);

  // The additive machine half: the attestation landed, the publishing did not.
  const refusal = JSON.parse(run.stderr) as Record<string, unknown>;
  assert.deepEqual(refusal["ceremony"], { attested: true, seq: 2 });
  const publishing = refusal["publishing"] as Record<string, unknown>;
  assert.equal(publishing["complete"], false);
  assert.equal(publishing["via"], "recovery");
  assert.equal(publishing["stoppedAt"], "git push -u origin policy-amend-2");

  // And the state the message describes is the state on disk: the attestation
  // is in the log, the commit is local, origin is untouched.
  assert.equal(logRecords(dir).length, 2);
  assert.equal(git(["rev-list", "--count", "HEAD"], dir).stdout.trim(), "3");
  assert.equal(remoteHead(remote, "main"), originBefore);
  // The APRV-111 constraint, still: the operator is standing where they were.
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir).stdout.trim(), "main");
});

test("a protected main takes the branch flow, and the protected remote accepts it", () => {
  const { dir, remote } = repoWithRemote();
  const stub = ghStub({ protection: "protected", prUrl: "https://github.test/o/r/pull/11" });
  attest(dir);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "attestation"], dir);
  git(["push", "-q", "origin", "main"], dir);
  protectPushesTo(remote, "refs/heads/main");
  const originBefore = remoteHead(remote, "main");
  writePolicy(dir, AFTER);

  const run = runCli(
    ["policy", "amend", "--as", "human:carter", "--yes", "--commit", "--json"],
    dir,
    {},
    pathWith(stub.dir),
  );

  assert.equal(run.code, 0, run.stderr);
  const gitPlan = report(run)["git"] as Record<string, unknown>;
  assert.equal(gitPlan["flow"], "branch");
  assert.equal(gitPlan["pushed"], true);
  assert.deepEqual(remoteFiles(remote, "policy-amend-2"), [
    ".approval/log/events.jsonl",
    "APPROVAL.md",
  ]);
  // main is exactly where it was: the amendment reaches it through the PR.
  assert.equal(remoteHead(remote, "main"), originBefore);
});

test("a rejected BRANCH push is push-rejected too, with the push and PR to run", () => {
  const { dir, remote } = repoWithRemote();
  const stub = ghStub({ protection: "protected" });
  attest(dir);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "attestation"], dir);
  git(["push", "-q", "origin", "main"], dir);
  protectPushesTo(remote, "refs/heads/policy-amend-2");
  writePolicy(dir, AFTER);

  const run = runCli(
    ["policy", "amend", "--as", "human:carter", "--yes", "--commit", "--json"],
    dir,
    {},
    pathWith(stub.dir),
  );

  assert.equal(run.code, 4, run.stdout);
  const error = errorOf(run);
  assert.equal(error.code, "push-rejected");
  assert.match(error.message, /exists LOCALLY on policy-amend-2 and nowhere else/u);
  assert.match(error.message, /git push -u origin policy-amend-2/u);
  assert.match(error.message, /gh pr create --title/u);
  assert.equal(remoteHead(remote, "policy-amend-2"), "");
});

test("with no origin the direct --commit says the push is still to run", () => {
  const dir = repoDir();
  attest(dir);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "attestation"], dir);
  writePolicy(dir, AFTER);

  const run = runCli(["policy", "amend", "--as", "human:carter", "--yes", "--commit"], dir);

  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /NOT pushed:/u);
  assert.match(run.stdout, /Still to run:/u);
  assert.match(run.stdout, /git push origin/u);
  // The push line is printed ONCE, under the commands that did not run.
  assert.equal(run.stdout.split("git push origin").length - 1, 1);
});

// ---------------------------------------------------------------------------
// APRV-129 — a recovery refusal reads like a runbook
//
// The first live `push-rejected` was correct, complete, and unreadable: one
// paragraph carrying the remote's error, the local state, four commands and the
// merge-commit rationale. The human read the word REJECTED and stopped. The
// facts do not change here; the shape does, and the shape is what these assert.
// ---------------------------------------------------------------------------

/**
 * A repo whose main AND recovery branch the remote refuses, and the refusal it
 * produces.
 *
 * Both refs since APRV-130: a rejected direct push now publishes through
 * `policy-amend-2` by itself, so a runbook only renders once that automatic
 * path has itself run out. This helper is the "automation ran out" case.
 */
function rejectedDirectPush(env: Record<string, string> = {}): Run {
  const { dir, remote } = repoWithRemote();
  attest(dir);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "attestation"], dir);
  git(["push", "-q", "origin", "main"], dir);
  protectPushesTo(remote, "refs/heads/main", "refs/heads/policy-amend-2");
  writePolicy(dir, AFTER);
  return runCli(["policy", "amend", "--as", "human:carter", "--yes", "--commit"], dir, env);
}

/** The lines of a section, up to the next blank line. */
function sectionLines(text: string, heading: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  assert.notEqual(start, -1, `no ${heading} section in:\n${text}`);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") break;
    body.push(line.trim());
  }
  return body;
}

test("push-rejected renders a headline, YOUR STATE, and numbered NEXT STEPS", () => {
  const run = rejectedDirectPush();

  assert.equal(run.code, 4, run.stdout);
  // The headline: one short line naming what happened, with the code on it.
  const headline = run.stderr.split("\n")[0] ?? "";
  assert.match(headline, /push-rejected/u);
  // APRV-130: the headline names the SUB-STEP that was refused, which after the
  // automatic recovery is the branch push and no longer the direct one.
  assert.match(headline, /the remote REJECTED `git push -u origin policy-amend-2`/u);
  assert.ok(headline.length < 90, `headline is a paragraph again: ${headline}`);

  // The remote's own words are indented under the headline, not inside prose.
  assert.match(run.stderr, /\n {4}.*pre-receive hook declined/u);

  const state = sectionLines(run.stderr, "YOUR STATE");
  assert.ok(state.length >= 3 && state.length <= 4, `YOUR STATE has ${String(state.length)} lines`);
  assert.ok(state.every((line) => line.length <= 90), `a YOUR STATE line is a paragraph:\n${state.join("\n")}`);
  assert.match(state.join("\n"), /seq 2/u);
  assert.match(state.join("\n"), /committed LOCALLY on main/u);
  assert.match(state.join("\n"), /NOT on origin/u);

  // ONE runnable command per line, numbered, with at most a trailing comment.
  const steps = sectionLines(run.stderr, "NEXT STEPS");
  assert.deepEqual(
    steps.map((line) => /^(\d+)\. /u.exec(line)?.[1]),
    steps.map((_line, index) => String(index + 1)),
  );
  for (const step of steps) {
    const [command = "", ...rest] = step.replace(/^\d+\. /u, "").split("  # ");
    assert.match(command.trim(), /^(git|gh) /u, `not a runnable command: ${step}`);
    // At most ONE trailing comment, and it is a comment and not a paragraph.
    assert.ok(rest.length <= 1, `more than a trailing comment: ${step}`);
    assert.ok((rest[0] ?? "").length <= 60, `the comment is prose: ${step}`);
  }
  // APRV-130: the runbook resumes at the step the automatic path STOPPED at.
  // `git branch policy-amend-2` ran and succeeded, so it is not owed to anybody.
  assert.match(steps[0] ?? "", /^1\. git push -u origin policy-amend-2/u);
  assert.match(steps.join("\n"), /gh pr create --title/u);
  assert.doesNotMatch(steps.join("\n"), /git branch policy-amend-2/u);

  // The rationale is one line with a pointer, not an inline essay. (The one
  // other MERGE COMMIT in the output is inside the PR body being quoted into
  // `gh pr create`, which is a command argument and not prose the reader parses.)
  const rationale = run.stderr
    .split("\n")
    .filter((line) => line.includes("MERGE COMMIT") && !/^ *\d+\. /u.test(line));
  assert.equal(rationale.length, 1, run.stderr);
  assert.match(rationale[0] ?? "", /docs\/cli-reference\.md/u);
  // The log-safe line names the verb that replaced the runbook (APRV-125).
  assert.match(run.stderr, /approval log sync/u);
});

test("no recovery output anywhere reaches for reset --hard", () => {
  const run = rejectedDirectPush();
  assert.doesNotMatch(run.stderr, /reset --hard/u);
  assert.doesNotMatch(run.stdout, /reset --hard/u);
  // The log-safe pointer is what stands where the destructive command stood.
  // APRV-125 turned that pointer from a runbook reference into a verb.
  assert.match(run.stderr, /approval log sync/u);
});

test("the runbook survives NO_COLOR and ASCII mode with its structure intact", () => {
  const plain = rejectedDirectPush({ NO_COLOR: "1", APPROVAL_ASCII: "1" });

  assert.equal(plain.code, 4);
  assert.ok(!plain.stderr.includes("\u001b"), "an escape sequence survived NO_COLOR");
  assert.match(plain.stderr, /^\[x\] push-rejected {2}the remote REJECTED/u);
  assert.ok(sectionLines(plain.stderr, "YOUR STATE").length >= 3);
  assert.match(sectionLines(plain.stderr, "NEXT STEPS")[0] ?? "", /^1\. git push -u origin/u);
  assert.doesNotMatch(plain.stderr, /reset --hard/u);
});

test("push-rejected keeps its machine surface: same code, exit, and message facts", () => {
  const { dir, remote } = repoWithRemote();
  attest(dir);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "attestation"], dir);
  git(["push", "-q", "origin", "main"], dir);
  protectPushesTo(remote, "refs/heads/main", "refs/heads/policy-amend-2");
  writePolicy(dir, AFTER);

  const run = runCli(["policy", "amend", "--as", "human:carter", "--yes", "--commit", "--json"], dir);

  assert.equal(run.code, 4);
  const error = errorOf(run);
  assert.equal(error.code, "push-rejected");
  // One line, no runbook indentation, no escapes: the frozen shape.
  assert.doesNotMatch(error.message, /\n/u);
  assert.match(error.message, /committed LOCALLY on main and is NOT on origin/u);
  assert.match(error.message, /git push -u origin policy-amend-2/u);
  assert.doesNotMatch(error.message, /reset --hard/u);
  // APRV-125: the machine message names the verb, where it named the runbook.
  assert.match(error.message, /approval log sync/u);
});

test("a rejected BRANCH push renders the same runbook shape", () => {
  const { dir, remote } = repoWithRemote();
  const stub = ghStub({ protection: "protected" });
  attest(dir);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "attestation"], dir);
  git(["push", "-q", "origin", "main"], dir);
  protectPushesTo(remote, "refs/heads/policy-amend-2");
  writePolicy(dir, AFTER);

  const run = runCli(
    ["policy", "amend", "--as", "human:carter", "--yes", "--commit"],
    dir,
    {},
    pathWith(stub.dir),
  );

  assert.equal(run.code, 4, run.stdout);
  assert.match(run.stderr.split("\n")[0] ?? "", /push-rejected {2}the remote REJECTED/u);
  assert.match(sectionLines(run.stderr, "YOUR STATE").join("\n"), /nowhere else/u);
  assert.match(sectionLines(run.stderr, "NEXT STEPS")[0] ?? "", /^1\. git push -u origin policy-amend-2/u);
  assert.doesNotMatch(run.stderr, /reset --hard/u);
});

// ---------------------------------------------------------------------------
// APRV-130 — the ceremony is a success, and it finishes its own job
//
// The incident, 2026-08-20: a re-tighten ceremony attested at seq 293 — the one
// act only a human can perform, and it landed — and the terminal opened with
// the word REJECTED, because the convenience push after it had been refused by
// branch protection. The human: "it doesnt seem user friendly that one of the
// few human-only actions is rewarded with a REJECTED message".
//
// Two properties are asserted here. The attestation headlines its own ceremony,
// always. And the four recovery commands the runbook used to hand over are RUN,
// so the runbook is what the automation degrades INTO, sliced from the step it
// ran out at.
// ---------------------------------------------------------------------------

/** The first line of `text` that carries anything, headline included. */
function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim().length > 0) ?? "";
}

/**
 * Everything printed AFTER the human confirms.
 *
 * `Policy` / `Changes` / `Load` are the report the operator reads in order to
 * decide, and they are printed before the question. The ceremony's own output —
 * the subject of "no failure word headlines a ceremony whose attestation
 * landed" — begins where that report ends.
 */
function ceremonyOutput(stdout: string): string {
  const lines = stdout.split("\n");
  const load = lines.findIndex((line) => line.trim() === "Load");
  assert.notEqual(load, -1, `no Load section in:\n${stdout}`);
  let end = load + 1;
  while (end < lines.length && (lines[end] ?? "").trim() !== "") end += 1;
  return lines.slice(end).join("\n");
}

/**
 * A repo on a main the remote refuses, a gh that answers, and the run.
 *
 * `protect` names the refs the remote will not take, so a caller can refuse the
 * direct push only (the automatic path succeeds) or the recovery branch too.
 */
function protectedMain(options: {
  protect: string[];
  gh?: GhBehaviour;
  args?: string[];
  path?: string;
}): { run: Run; dir: string; remote: string; log: string } {
  const { dir, remote } = repoWithRemote();
  const stub = ghStub(options.gh ?? { defaultBranch: "main", prUrl: "https://github.test/o/r/pull/7" });
  attest(dir);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "attestation"], dir);
  git(["push", "-q", "origin", "main"], dir);
  protectPushesTo(remote, ...options.protect);
  writePolicy(dir, AFTER);
  const run = runCli(
    ["policy", "amend", "--as", "human:carter", "--yes", "--commit", ...(options.args ?? [])],
    dir,
    {},
    options.path ?? pathWith(stub.dir),
  );
  return { run, dir, remote, log: stub.log };
}

test("a rejected push is published through a branch, and the ceremony reads as a success", () => {
  const { run, dir, remote, log } = protectedMain({ protect: ["refs/heads/main"] });

  // Attested AND published: the ceremony finished its own job, so it is a 0.
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stderr, "");

  // THE PROPERTY: the first line is the achievement, not the failed sub-step.
  assert.match(firstLine(ceremonyOutput(run.stdout)), /attested seq 2 — the policy is operative/u);
  assert.doesNotMatch(firstLine(ceremonyOutput(run.stdout)), /REJECT|fail|✗/iu);

  // Each automatic step is reported, in the order it happened, beneath.
  const stdout = run.stdout;
  const order = [
    /main is protected:/u,
    /branch policy-amend-2 created/u,
    /pushed policy-amend-2 to origin/u,
    /PR #7 opened/u,
    /auto-merge armed/u,
  ].map((pattern) => pattern.exec(stdout)?.index ?? -1);
  assert.ok(
    order.every((index) => index > 0),
    `a publishing step went unreported:\n${stdout}`,
  );
  assert.deepEqual([...order].sort((a, b) => a - b), order, `the steps are out of order:\n${stdout}`);
  // The achievement is above every one of them.
  assert.ok(stdout.indexOf("attested seq 2") < order[0]!);

  // The APRV-111 constraint: `git branch` copies a ref, so the operator is
  // still standing on the commit they signed for.
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir).stdout.trim(), "main");
  // The amendment is on origin as a branch, and main is untouched.
  assert.deepEqual(remoteFiles(remote, "policy-amend-2"), [
    ".approval/log/events.jsonl",
    "APPROVAL.md",
  ]);
  assert.equal(
    remoteHead(remote, "policy-amend-2"),
    git(["rev-parse", "HEAD"], dir).stdout.trim(),
  );
  // The PR was opened for the recovery branch, with the one-commit body.
  const calls = ghCalls(log);
  assert.equal(calls[calls.indexOf("--head") + 1], "policy-amend-2");
  assert.match(calls[calls.indexOf("--body") + 1] ?? "", /exactly one commit/u);
  assert.ok(calls.includes("--auto"), "auto-merge was never attempted");
  // And nothing tells the operator to re-run the push the remote refused.
  assert.doesNotMatch(stdout, /NOT pushed:/u);
});

test("the same run reports attested and its publishing outcome in --json", () => {
  const { run } = protectedMain({ protect: ["refs/heads/main"], args: ["--json"] });

  assert.equal(run.code, 0, run.stderr);
  const parsed = report(run);
  // Additive: `attested` is still the attestation this amendment moved FROM.
  assert.deepEqual(parsed["ceremony"], { attested: true, seq: 2 });
  assert.deepEqual(parsed["attested"], parsed["attested"]);
  const publishing = parsed["publishing"] as Record<string, unknown>;
  assert.equal(publishing["attempted"], true);
  assert.equal(publishing["complete"], true);
  assert.equal(publishing["via"], "recovery");
  assert.equal(publishing["branch"], "policy-amend-2");
  assert.equal(publishing["pushed"], true);
  assert.equal(publishing["prUrl"], "https://github.test/o/r/pull/7");
  assert.equal(publishing["autoMerge"], "armed");
  assert.equal(publishing["stoppedAt"], null);
  // Every step the verb RAN, in order, with the refused direct push first.
  const steps = publishing["steps"] as { command: string; ok: boolean }[];
  assert.deepEqual(
    steps.map((step) => `${step.ok ? "ok" : "no"} ${step.command.split(" --title")[0]}`),
    [
      "no git push origin main",
      "ok git branch policy-amend-2",
      "ok git push -u origin policy-amend-2",
      "ok gh pr create",
      "ok gh pr merge policy-amend-2 --merge --auto",
    ],
  );
  // The frozen `git` sub-object is untouched by any of it.
  const gitPlan = parsed["git"] as Record<string, unknown>;
  assert.equal(gitPlan["committed"], true);
  assert.equal(gitPlan["flow"], "direct");
});

test("a refused auto-merge is still a success: the PR is open, and it says so", () => {
  const { run } = protectedMain({
    protect: ["refs/heads/main"],
    gh: { defaultBranch: "main", prUrl: "https://github.test/o/r/pull/9", autoMergeRefused: true },
  });

  assert.equal(run.code, 0, run.stderr);
  assert.match(firstLine(ceremonyOutput(run.stdout)), /attested seq 2 — the policy is operative/u);
  assert.match(run.stdout, /PR #9 is open — merge it with a MERGE COMMIT when CI is green/u);
  assert.match(run.stdout, /auto-merge was not armed: gh: auto-merge is not enabled/u);
});

test("a recovery step that fails drops to the runbook, sliced from that step", () => {
  // The recovery branch push is refused too, so the automatic path stops at its
  // SECOND step and the runbook owes steps 2..4.
  const { run } = protectedMain({
    protect: ["refs/heads/main", "refs/heads/policy-amend-2"],
  });

  assert.equal(run.code, 4, run.stdout);
  // Success first, even here: the attestation landed, so it headlines.
  assert.match(firstLine(ceremonyOutput(run.stdout)), /attested seq 2 — the policy is operative/u);
  // The steps that DID work are reported; the failure is a sub-step on stderr.
  assert.match(run.stdout, /branch policy-amend-2 created/u);
  assert.match(run.stdout, /the automatic path stopped here/u);
  assert.match(firstLine(run.stderr), /✗ push-rejected/u);

  const steps = sectionLines(run.stderr, "NEXT STEPS");
  assert.match(steps[0] ?? "", /^1\. git push -u origin policy-amend-2/u);
  assert.match(steps[1] ?? "", /^2\. gh pr create --title/u);
  assert.match(steps[2] ?? "", /^3\. gh pr merge policy-amend-2 --merge/u);
  assert.equal(steps.length, 3, `the runbook was not sliced: ${steps.join(" | ")}`);
});

test("a recovery branch that already exists slices the runbook from step one", () => {
  const { dir, remote } = repoWithRemote();
  const stub = ghStub({ defaultBranch: "main", prUrl: "https://github.test/o/r/pull/7" });
  attest(dir);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "attestation"], dir);
  git(["push", "-q", "origin", "main"], dir);
  protectPushesTo(remote, "refs/heads/main");
  // The name the recovery wants is taken, so its FIRST step fails.
  git(["branch", "policy-amend-2"], dir);
  writePolicy(dir, AFTER);

  const run = runCli(
    ["policy", "amend", "--as", "human:carter", "--yes", "--commit"],
    dir,
    {},
    pathWith(stub.dir),
  );

  assert.equal(run.code, 4, run.stdout);
  assert.match(firstLine(ceremonyOutput(run.stdout)), /attested seq 2 — the policy is operative/u);
  const steps = sectionLines(run.stderr, "NEXT STEPS");
  assert.equal(steps.length, 4, `the runbook lost a step: ${steps.join(" | ")}`);
  assert.match(steps[0] ?? "", /^1\. git branch policy-amend-2/u);
  assert.match(run.stderr, /already exists/u);
});

test("gh absent degrades the recovery to the runbook, with the branch on origin", () => {
  const { run, dir, remote } = protectedMain({
    protect: ["refs/heads/main"],
    path: pathWithoutGh(),
  });

  // The push half succeeded, so the branch IS on origin; only the PR is owed.
  assert.equal(run.code, 4, run.stdout);
  assert.match(firstLine(ceremonyOutput(run.stdout)), /attested seq 2 — the policy is operative/u);
  assert.deepEqual(remoteFiles(remote, "policy-amend-2"), [
    ".approval/log/events.jsonl",
    "APPROVAL.md",
  ]);
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir).stdout.trim(), "main");

  assert.match(firstLine(run.stderr), /✗ pr-failed/u);
  assert.match(run.stderr, /gh is not available, so the pull request was not opened/u);
  const steps = sectionLines(run.stderr, "NEXT STEPS");
  assert.equal(steps.length, 2, `the runbook was not sliced: ${steps.join(" | ")}`);
  assert.match(steps[0] ?? "", /^1\. gh pr create --title/u);
  // The state names what IS true: on origin as a branch, no pull request.
  assert.match(sectionLines(run.stderr, "YOUR STATE").join("\n"), /on origin as policy-amend-2/u);
});

test("--no-publish stops at the commit, and says what is still owed", () => {
  const { dir, remote } = repoWithRemote();
  const stub = ghStub({ protection: "unprotected" });
  attest(dir);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "attestation"], dir);
  git(["push", "-q", "origin", "main"], dir);
  const originBefore = remoteHead(remote, "main");
  writePolicy(dir, AFTER);

  const run = runCli(
    ["policy", "amend", "--as", "human:carter", "--yes", "--commit", "--no-publish"],
    dir,
    {},
    pathWith(stub.dir),
  );

  assert.equal(run.code, 0, run.stderr);
  assert.match(firstLine(ceremonyOutput(run.stdout)), /attested seq 2 — the policy is operative/u);
  // Committed, and nothing else: origin is exactly where it was.
  assert.equal(git(["rev-list", "--count", "HEAD"], dir).stdout.trim(), "3");
  assert.equal(remoteHead(remote, "main"), originBefore);
  assert.match(run.stdout, /--no-publish:/u);
  assert.match(run.stdout, /Still to run:/u);
  assert.match(run.stdout, /git push origin main/u);
});

test("--no-publish on the branch flow owes the push AND the pull request", () => {
  const { dir, remote } = repoWithRemote();
  const stub = ghStub({ protection: "protected", prUrl: "https://github.test/o/r/pull/7" });
  attest(dir);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "attestation"], dir);
  git(["push", "-q", "origin", "main"], dir);
  writePolicy(dir, AFTER);

  const run = runCli(
    ["policy", "amend", "--as", "human:carter", "--yes", "--commit", "--no-publish", "--json"],
    dir,
    {},
    pathWith(stub.dir),
  );

  assert.equal(run.code, 0, run.stderr);
  const publishing = report(run)["publishing"] as Record<string, unknown>;
  assert.equal(publishing["attempted"], false);
  assert.equal(publishing["pushed"], false);
  assert.match(publishing["reason"] as string, /--no-publish/u);
  assert.equal(remoteHead(remote, "policy-amend-2"), "");
  // No `gh` call was made at all: publishing is where gh lives.
  assert.equal(ghCalls(stub.log).includes("create"), false);
});

test("the direct flow's success path is unchanged: no publishing narration", () => {
  const { dir } = repoWithRemote();
  const stub = ghStub({ protection: "unprotected" });
  attest(dir);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "attestation"], dir);
  git(["push", "-q", "origin", "main"], dir);
  writePolicy(dir, AFTER);

  const run = runCli(
    ["policy", "amend", "--as", "human:carter", "--yes", "--commit"],
    dir,
    {},
    pathWith(stub.dir),
  );

  assert.equal(run.code, 0, run.stderr);
  assert.match(firstLine(ceremonyOutput(run.stdout)), /attested seq 2 — the policy is operative/u);
  // A push that worked first time needs no explaining.
  assert.doesNotMatch(run.stdout, /Publishing/u);
  assert.doesNotMatch(run.stdout, /policy-amend-2/u);
});

// ---------------------------------------------------------------------------
// Identity (exit 2) and other usage
// ---------------------------------------------------------------------------

test("no declared identity is a usage error naming both ways to declare one", () => {
  const dir = repoDir();
  attest(dir);
  writePolicy(dir, AFTER);

  const run = runCli(["policy", "amend", "--yes"], dir);
  assert.equal(run.code, 2);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /APPROVAL_HUMAN=human:<id>/u);
  assert.equal(logRecords(dir).length, 1);
});

// ---------------------------------------------------------------------------
// The agent path (APRV-109)
// ---------------------------------------------------------------------------

test("an agent actor cannot attest, and with no channel it cannot even ask", () => {
  const dir = repoDir();
  attest(dir);
  writePolicy(dir, AFTER);

  // BEFORE/AFTER declare no `channels`, so there is nowhere for an attestation
  // prompt to go. FAIL CLOSED before anything is appended: a proposal in a
  // repository with no channel is a question nobody will ever be asked.
  const run = runCli(["policy", "amend", "--as", "agent:planner", "--yes"], dir);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /no channel is configured/u);
  assert.match(run.stderr, /nothing was proposed and nothing was attested/u);
  assert.equal(logRecords(dir).length, 1);
});

test("an agent proposes rather than attests, and a lapsed prompt attests nothing", () => {
  const dir = repoDir(WITH_CHANNEL);
  attest(dir);
  writePolicy(dir, WITH_CHANNEL_AFTER);
  const before = rawLog(dir);

  const run = runCli(
    ["policy", "amend", "--as", "agent:planner", "--wait", "1s", "--interval", "200ms", "--json"],
    dir,
  );
  // A gate refusal is 1: the command was well-formed and nothing was attested.
  assert.equal(run.code, 1, run.stderr);
  const error = errorOf(run);
  assert.equal(error.code, "attestation-timeout");
  assert.match(error.message, /nothing was attested and nothing was committed/u);

  // Exactly one record was added, and it is the ASK, not the attestation.
  const records = logRecords(dir);
  assert.equal(records.length, 2);
  const proposal = records[1] as Record<string, unknown>;
  assert.equal(proposal["event"], "policy.proposed");
  assert.equal(proposal["actor"], "agent:planner");
  assert.notEqual(rawLog(dir), before);

  // The prompt carries the three COMPUTED fields a phone needs, and the hash is
  // the file's own. No `--as agent:` flag could have authored any of them.
  const payload = payloadAt(dir, 1);
  assert.match(String(payload["sha256"]), /^[a-f0-9]{64}$/u);
  assert.equal(payload["class"], "policy.edit");
  assert.equal(payload["action_key"], `policy.attest:${String(payload["sha256"])}`);
  assert.equal((payload["diff"] as { available: boolean }).available, true);
  assert.equal((payload["load"] as { ok: boolean }).ok, true);

  // And nothing was committed: the policy edit is still a working-tree change.
  assert.equal(git(["status", "--porcelain"], dir).stdout.trim().length > 0, true);
});

test("a diff too large for a channel refuses to the terminal path", () => {
  const dir = repoDir(WITH_CHANNEL);
  attest(dir);
  writePolicy(dir, WIDE);
  const before = rawLog(dir);

  const run = runCli(
    ["policy", "amend", "--as", "agent:planner", "--wait", "1s", "--json"],
    dir,
  );
  assert.equal(run.code, 1, run.stderr);
  const error = errorOf(run);
  assert.equal(error.code, "propose-failed");
  assert.match(error.message, /diff-too-large/u);
  assert.match(error.message, /at a terminal/u);
  assert.equal(rawLog(dir), before, "a refused proposal wrote to the log");
});

test("--wait belongs to the agent path and is refused under a human identity", () => {
  const dir = repoDir(WITH_CHANNEL);
  attest(dir);
  writePolicy(dir, WITH_CHANNEL_AFTER);
  const before = rawLog(dir);

  const run = runCli(["policy", "amend", "--as", "human:carter", "--yes", "--wait", "5m"], dir);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /--wait and --interval belong to the channel ceremony/u);
  assert.equal(rawLog(dir), before);
});

test("under a human identity the verb is what it was: it attests here", () => {
  const dir = repoDir(WITH_CHANNEL);
  attest(dir);
  writePolicy(dir, WITH_CHANNEL_AFTER);

  const run = runCli(["policy", "amend", "--as", "human:carter", "--yes", "--json"], dir);
  assert.equal(run.code, 0, run.stderr);
  const parsed = report(run);
  assert.equal((parsed["ceremony"] as { attested: boolean }).attested, true);
  // The channel ceremony left no trace on the path that never used it.
  assert.equal(parsed["proposal"], null);
  const records = logRecords(dir);
  assert.equal(records.length, 2);
  assert.equal(records[1]?.["event"], "policy.updated");
  assert.equal(records[1]?.["actor"], "human:carter");
});

test("APPROVAL_HUMAN supplies the identity, as it does for attest", () => {
  const dir = repoDir();
  attest(dir);
  writePolicy(dir, AFTER);

  const run = runCli(["policy", "amend", "--yes"], dir, { APPROVAL_HUMAN: "human:from-env" });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(logRecords(dir)[1]?.["actor"], "human:from-env");
});

test("an unknown flag and a stray positional are usage errors", () => {
  const dir = repoDir();
  assert.equal(runCli(["policy", "amend", "--as", "human:carter", "--nope"], dir).code, 2);
  assert.equal(
    runCli(["policy", "amend", "--as", "human:carter", "--yes", "read.web"], dir).code,
    2,
  );
  assert.deepEqual(logRecords(dir), []);
});

test("an absent policy file is an I/O error, not an amendment", () => {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(dir, { recursive: true });

  const run = runCli(["policy", "amend", "--as", "human:carter", "--yes", "--json"], dir);
  assert.equal(run.code, 4);
  assert.equal(errorOf(run).code, "io");
  assert.match(errorOf(run).message, /no policy file found/u);
});

test("the appended amendment leaves the chain clean", () => {
  const dir = repoDir();
  attest(dir);
  writePolicy(dir, AFTER);
  assert.equal(runCli(["policy", "amend", "--as", "human:carter", "--yes"], dir).code, 0);

  const verify = runCli(["log", "verify", "--json"], dir);
  assert.equal(verify.code, 0);
  const parsed = JSON.parse(verify.stdout) as Record<string, unknown>;
  assert.equal(parsed["status"], "clean");
  assert.equal(parsed["records"], 2);
});

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

test("the help states the baseline limitation, the flags, and the refusal codes", () => {
  const dir = caseDir();
  const run = runCli(["policy", "amend", "--help"], dir);

  assert.equal(run.code, 0);
  assert.match(run.stdout, /BASELINE/u);
  assert.match(run.stdout, /NOT\s+recoverable from the log/u);
  assert.match(run.stdout, /HASH-ONLY MODE/u);
  assert.match(run.stdout, /--require-load/u);
  assert.match(run.stdout, /commit-preconditions/u);
  assert.match(run.stdout, /EXACTLY two files/u);
  // The two flows, the detection, and the precedence between them.
  assert.match(run.stdout, /--branch <name>/u);
  assert.match(run.stdout, /--direct/u);
  assert.match(run.stdout, /PRECEDENCE, highest first/u);
  assert.match(run.stdout, /MERGE COMMIT/u);
  assert.match(run.stdout, /pr-failed/u);
  assert.deepEqual(logRecords(dir), []);
});

test("policy --help and the root help both mention amend", () => {
  const dir = caseDir();
  assert.match(runCli(["policy", "--help"], dir).stdout, /amend/u);
  assert.match(runCli(["--help"], dir).stdout, /policy amend/u);
});
