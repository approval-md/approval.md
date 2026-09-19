/**
 * `approval policy apply` publishes by refspec, never a branch switch
 * (APRV-360).
 *
 * The observed failure, 2026-09-18 (seq 44188, PR 439): `approval policy apply
 * docs/proposals/policy-2026-09-18.md` was run as the runbook wrote it, without
 * `--pr`. The amend attested the policy and then stopped, printing a hand
 * procedure that opened with `git checkout -b policy-amend-<seq> origin/main`.
 * The primary's local main was fourteen commits behind origin, the checkout
 * refused rather than overwrite `QUEUE.md`, the working log and six payloads,
 * and the ceremony stalled with an edited, attested, unpublished policy — the
 * one state in which every gated operation on the box refuses.
 *
 * Two things are pinned here, and one more in `tests/cli-amend.test.ts` (the
 * printed runbook, which now carries no `git checkout` at all):
 *
 *  1. `apply` publishes by default. The amendment runs with `--pr`, so the
 *     branch is created on the remote, the pull request is opened, the merge is
 *     armed, and the checkout ends the verb where it started;
 *  2. a local main BEHIND origin is not an obstacle, because nothing is built
 *     on the local trunk; while a working log that has genuinely forked from
 *     the remote's is refused as `base-log-diverged`, with the sentence that
 *     names `approval log sync`, and never as a git error.
 *
 * Real git all the way down: the remote is a bare repository on disk, and the
 * one thing that is faked is `gh`, by a stub first on PATH. Nothing here writes
 * a log line by hand — every record is appended by `approval policy attest`.
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
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

/** dist/tests/cli-policy-apply-publish.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLEAN_PROPOSAL = join(REPO_ROOT, "tests", "fixtures", "proposals", "clean.md");

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-apply-publish-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** The policy the `clean` proposal fixture is written against. */
const POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "1h"',
  "  # classes",
  "classes:",
  "  network.call:              { autonomy: supervised }",
  "```",
  "",
].join("\n");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function git(args: string[], cwd: string): Run {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.error, undefined, `git failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function cli(args: string[], cwd: string, path: string): Run {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", PATH: path };
  delete env["APPROVAL_HUMAN"];
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env,
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/**
 * A `gh` that answers protected, opens a pull request and arms a merge.
 *
 * Every invocation is appended to a log file, one argument per line, so the
 * argv of `pr create` and `pr merge` can be asserted rather than inferred from
 * the verb's own report.
 */
function ghStub(): { dir: string; log: string } {
  counter += 1;
  const dir = join(scratch, `bin-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "gh-invocations.txt");
  const script = [
    "#!/bin/sh",
    `for arg in "$@"; do printf '%s\\n' "$arg" >> ${JSON.stringify(log)}; done`,
    `printf -- '---\\n' >> ${JSON.stringify(log)}`,
    'case "$1" in',
    '  --version) echo "gh version 2.0.0 (stub)"; exit 0 ;;',
    '  api) case "$2" in',
    "    */rules/branches/*) echo '[]'; exit 0 ;;",
    "    *) exit 0 ;;",
    "  esac ;;",
    "  repo) echo main; exit 0 ;;",
    '  pr) case "$2" in',
    "    merge) exit 0 ;;",
    "    list) echo '[]'; exit 0 ;;",
    "    edit) echo https://github.test/o/r/pull/360; exit 0 ;;",
    "    *) echo https://github.test/o/r/pull/360; exit 0 ;;",
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

function pathWith(dir: string): string {
  return `${dir}${delimiter}${process.env["PATH"] ?? ""}`;
}

/** Every argument the stub was called with, in order, one per line. */
function ghCalls(log: string): string[] {
  return existsSync(log)
    ? readFileSync(log, "utf8").split("\n").filter((line) => line.length > 0)
    : [];
}

/**
 * A repository on `main` with a bare remote as origin, the policy committed and
 * attested through the real CLI, and both on origin.
 */
function published(): { dir: string; remote: string } {
  counter += 1;
  const dir = join(scratch, `case-${String(counter)}`);
  const remote = join(scratch, `remote-${String(counter)}.git`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  git(["init", "-q", "--bare", "-b", "main", remote], scratch);
  git(["init", "-q", "-b", "main", "."], dir);
  git(["config", "user.email", "test@example.invalid"], dir);
  git(["config", "user.name", "Test"], dir);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "policy"], dir);
  git(["remote", "add", "origin", remote], dir);
  git(["push", "-q", "-u", "origin", "main"], dir);
  git(["remote", "set-head", "origin", "main"], dir);
  attest(dir, "human:carter");
  git(["add", "-A"], dir);
  git(["commit", "-qm", "attestation"], dir);
  git(["push", "-q", "origin", "main"], dir);
  return { dir, remote };
}

function attest(dir: string, as: string): void {
  const run = cli(["policy", "attest", "--as", as], dir, process.env["PATH"] ?? "");
  assert.equal(run.code, 0, run.stderr);
}

/** The branch and commit the checkout is standing on. */
function standing(dir: string): { branch: string; head: string } {
  return {
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"], dir).stdout.trim(),
    head: git(["rev-parse", "HEAD"], dir).stdout.trim(),
  };
}

/** The branches the bare remote carries, sorted. */
function remoteBranches(remote: string): string[] {
  return git(["for-each-ref", "--format=%(refname:short)", "refs/heads/"], remote)
    .stdout.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();
}

function errorOf(run: Run): { code: string; message: string } {
  const line = run.stderr
    .split("\n")
    .find((candidate) => candidate.trim().startsWith("{") && candidate.includes('"error"'));
  assert.ok(line !== undefined, `no refusal object in:\n${run.stderr}`);
  return (JSON.parse(line) as { error: { code: string; message: string } }).error;
}

// ---------------------------------------------------------------------------
// AC1 — it publishes, and the checkout never moves
// ---------------------------------------------------------------------------

test("APRV-360: apply publishes the branch, opens the PR and arms the merge, with no flag", () => {
  const { dir, remote } = published();
  const stub = ghStub();
  const before = standing(dir);

  const run = cli(
    ["policy", "apply", CLEAN_PROPOSAL, "--as", "human:carter", "--yes"],
    dir,
    pathWith(stub.dir),
  );
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);

  // The policy was applied AND attested: the whole point of one command.
  const policy = readFileSync(join(dir, "APPROVAL.md"), "utf8");
  assert.match(policy, /network\.call:\s+\{ autonomy: manual \}/u);

  const branches = remoteBranches(remote).filter((name) => name.startsWith("policy-amend-"));
  assert.equal(branches.length, 1, `remote branches: ${remoteBranches(remote).join(", ")}`);
  const branch = branches[0] as string;

  // APRV-356: apply runs an amend, so it carries what an amend carries. The
  // published branch holds the store copy of the attested bytes beside the
  // policy and the log, and its name is the `payload_hash` the attestation
  // bound — so the committed log's binding can be resolved out of the committed
  // tree, which is the only tree a reviewer or the CI guard ever sees.
  const carried = git(["show", "--name-only", "--pretty=format:", branch], remote)
    .stdout.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();
  const records = readFileSync(join(dir, ".approval", "log", "events.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { payload?: Record<string, unknown> });
  const bound = records[records.length - 1]?.payload?.["payload_hash"];
  assert.match(String(bound), /^[a-f0-9]{64}$/u, "the attestation bound no payload");
  assert.deepEqual(carried, [
    ".approval/log/events.jsonl",
    `.approval/payloads/${String(bound)}.json`,
    "APPROVAL.md",
  ]);

  const calls = ghCalls(stub.log);
  assert.ok(calls.includes("create"), `gh pr create was never called: ${calls.join(" ")}`);
  assert.ok(calls.includes(branch), `the pull request was not opened for ${branch}`);
  assert.ok(calls.includes("merge"), "the merge was never armed");
  assert.ok(calls.includes("--auto"), "the merge was armed without --auto");

  // AC1's other half. A branch switch in the primary is the shape that forked
  // the log on 2026-09-16, so the verb's claim is that it never makes one.
  assert.deepEqual(standing(dir), before, "the checkout moved");
  const dirty = git(["status", "--porcelain"], dir)
    .stdout.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    // The three the ceremony owns. APRV-356 made the payload store the third:
    // the attestation writes the attested bytes beside the log, and a `--pr`
    // flow never moves HEAD, so the file it committed to the branch is still an
    // untracked file here. It is the ceremony's own, exactly as the log is.
    .filter(
      (line) =>
        !line.includes("APPROVAL.md") &&
        !line.includes("events.jsonl") &&
        !line.includes(".approval/payloads/"),
    );
  assert.deepEqual(dirty, [], "the ceremony touched a path that is not its own");
});

test("APRV-360: --no-publish stops at the commit, and --pr with it is a usage error", () => {
  const quiet = published();
  const quietStub = ghStub();
  const run = cli(
    ["policy", "apply", CLEAN_PROPOSAL, "--as", "human:carter", "--yes", "--no-publish"],
    quiet.dir,
    pathWith(quietStub.dir),
  );
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  assert.deepEqual(
    remoteBranches(quiet.remote).filter((name) => name.startsWith("policy-amend-")),
    [],
    "--no-publish pushed a branch",
  );
  assert.ok(!ghCalls(quietStub.log).includes("create"), "--no-publish opened a pull request");

  const clash = published();
  const clashStub = ghStub();
  const refused = cli(
    ["policy", "apply", CLEAN_PROPOSAL, "--as", "human:carter", "--yes", "--pr", "--no-publish", "--json"],
    clash.dir,
    pathWith(clashStub.dir),
  );
  assert.equal(refused.code, 2);
  assert.equal(errorOf(refused).code, "usage");
  assert.match(errorOf(refused).message, /--pr and --no-publish/u);
  // A usage error writes nothing: the policy on disk is untouched.
  assert.equal(readFileSync(join(clash.dir, "APPROVAL.md"), "utf8"), POLICY);
});

// ---------------------------------------------------------------------------
// AC2 and AC4 — behind origin succeeds, a forked log refuses by code
// ---------------------------------------------------------------------------

test("APRV-360: a local main behind origin publishes anyway, because nothing is built on it", () => {
  const { dir, remote } = published();
  const stub = ghStub();

  // Somebody else pushed while this checkout sat still. The commit touches
  // neither the policy nor the log, so it is exactly the ordinary case: a
  // trunk that has moved on. This is what refused the `git checkout -b` on
  // 2026-09-18, with QUEUE.md, the working log and six payloads in the way.
  counter += 1;
  const other = join(scratch, `other-${String(counter)}`);
  git(["clone", "-q", remote, other], scratch);
  git(["config", "user.email", "test@example.invalid"], other);
  git(["config", "user.name", "Test"], other);
  writeFileSync(join(other, "NOTES.md"), "somebody else's commit\n", "utf8");
  git(["add", "-A"], other);
  git(["commit", "-qm", "unrelated"], other);
  git(["push", "-q", "origin", "main"], other);

  const before = standing(dir);
  const behind = git(["rev-list", "--count", "HEAD..origin/main"], dir);
  assert.equal(behind.code, 0);

  const run = cli(
    ["policy", "apply", CLEAN_PROPOSAL, "--as", "human:carter", "--yes"],
    dir,
    pathWith(stub.dir),
  );
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  assert.equal(
    remoteBranches(remote).filter((name) => name.startsWith("policy-amend-")).length,
    1,
  );
  assert.deepEqual(standing(dir), before, "the checkout moved");
});

test("APRV-360: a working log that forked from origin's refuses by code, not by git", () => {
  const { dir, remote } = published();
  const stub = ghStub();

  // A SECOND chain for the same policy bytes: same APPROVAL.md, so the policy
  // baseline still matches and the refusal under test is the log's, attested by
  // a different human so the two records cannot hash alike. Built through the
  // real append path, like every other record in this file.
  counter += 1;
  const fork = join(scratch, `fork-${String(counter)}`);
  mkdirSync(fork, { recursive: true });
  writeFileSync(join(fork, "APPROVAL.md"), POLICY, "utf8");
  git(["init", "-q", "-b", "main", "."], fork);
  git(["config", "user.email", "test@example.invalid"], fork);
  git(["config", "user.name", "Test"], fork);
  git(["add", "-A"], fork);
  git(["commit", "-qm", "policy"], fork);
  attest(fork, "human:dana");
  git(["add", "-A"], fork);
  git(["commit", "-qm", "another chain"], fork);
  git(["remote", "add", "origin", remote], fork);
  git(["push", "-q", "--force", "origin", "main"], fork);

  const before = standing(dir);
  const run = cli(
    ["policy", "apply", CLEAN_PROPOSAL, "--as", "human:carter", "--yes", "--json"],
    dir,
    pathWith(stub.dir),
  );
  assert.notEqual(run.code, 0);
  const error = errorOf(run);
  assert.equal(error.code, "base-log-diverged");
  // The message is the runtime's, and it names the verb that resolves this. A
  // git error here would be the verb handing the operator somebody else's
  // vocabulary for a problem this runtime understands.
  assert.match(error.message, /approval (log sync|doctor)/u);
  assert.deepEqual(standing(dir), before, "a refusal moved the checkout");
  assert.deepEqual(
    remoteBranches(remote).filter((name) => name.startsWith("policy-amend-")),
    [],
    "a refused ceremony published a branch",
  );
});
