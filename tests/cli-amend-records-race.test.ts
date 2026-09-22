/**
 * `policy amend --pr` and the records advance stop racing for the log (APRV-420).
 *
 * ## The incident
 *
 * On 2026-09-21 `approval policy amend --as human:carter --pr` opened PR 530
 * carrying `APPROVAL.md`, `.approval/log/events.jsonl` and a payload file. Two
 * records advances (PR 529 and PR 531) merged first, and both carried the SAME
 * records: the attestation at seq 65736 and its payload were on main before
 * anybody looked at 530. Git does not care that one side's appended lines are a
 * prefix of the other's — two sides appending at the end of a file is a
 * conflict — so 530 went DIRTY, lost its auto-merge arm, and the repair was a
 * hand merge of `events.jsonl` in a throwaway worktree. Hand-merging the log is
 * exactly the work every idiom in this codebase exists to remove, and re-running
 * the ceremony answered "nothing to amend", which is true and useless: the
 * attestation exists, and the pull request carrying it to the trunk is stuck.
 *
 * ## What is pinned here
 *
 * 1. **Prevention.** With a records advance live on origin, the amendment
 *    commit carries the policy and NOT the log, so the advance landing first
 *    leaves it mergeable. The file list is asserted, then a real merge is run.
 * 2. **The bug, and then the repair.** With no advance live, the amendment
 *    carries the log as it always has. An advance landing afterwards makes the
 *    branch genuinely unmergeable — asserted, so the repair is proved against a
 *    real conflict rather than a hypothetical one — and a RE-RUN rebuilds the
 *    branch on the trunk and force-updates it, after which the same merge is
 *    clean. The re-run never says "nothing to amend".
 * 3. **Landed.** A re-run whose amendment is already on the trunk in full says
 *    so and names the command that closes the branch.
 * 4. **A branch it cannot account for is not rebuilt over.** Somebody else's
 *    commit on the amendment branch stops the repair with its own commands.
 *
 * ## How
 *
 * Real git all the way down, with a bare remote on disk, and both ceremonies
 * through their real entry points: `approval policy attest` and `approval
 * policy amend` as spawned CLI processes, `logAdvance` as the module the CLI
 * edge calls. No log line is written by hand anywhere in this file; every
 * record comes from the real append path, and the attestation this race is
 * about is the one the amendment ceremony itself appends.
 *
 * `gh` is stubbed, because it is the one thing here that would reach the
 * network. It logs every call, so what the verb did NOT run is as assertable as
 * what it did.
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
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { register } from "../src/core/gate.js";
import { logAdvance } from "../src/cli/log-advance.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-amend-race-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const LOG_RELATIVE = ".approval/log/events.jsonl";
const QUEUE_RELATIVE = ".approval/QUEUE.md";
const TODAY = "2026-09-21T09:00:00.000Z";
const RECORDS_BRANCH = "records-log-2026-09-21";

/** Before and after: one class moves, which is all an amendment needs to be one. */
const BEFORE = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "1h"',
  "  on_expiry: reject",
  "classes:",
  "  log.advance:",
  "    autonomy: supervised",
  "```",
  "",
].join("\n");

const AFTER = BEFORE.replace("approval_ttl: \"1h\"", "approval_ttl: \"2h\"");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function git(args: string[], cwd: string): Run {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/**
 * A `gh` stub that answers the protection probe as UNPROTECTED and every pull
 * request call as success, logging each invocation.
 *
 * Unprotected on purpose: this file is about the log, and `--pr` forces the
 * branch flow whatever the probe says, so leaving protection out of the picture
 * keeps each case's failure attributable to one thing.
 */
function ghStub(): { dir: string; log: string } {
  counter += 1;
  const dir = join(scratch, `gh-bin-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "calls.txt");
  const script = [
    "#!/bin/sh",
    `for arg in "$@"; do printf '%s ' "$arg" >> ${JSON.stringify(log)}; done`,
    `printf '\\n' >> ${JSON.stringify(log)}`,
    'case "$1" in',
    '  --version) echo "gh version 2.0.0 (stub)"; exit 0 ;;',
    '  api) case "$2" in',
    "    */rules/branches/*) echo '[]'; exit 0 ;;",
    '    *) echo "gh: Branch not protected (HTTP 404)" >&2; exit 1 ;;',
    "  esac ;;",
    "  repo) echo main; exit 0 ;;",
    '  pr) case "$2" in',
    "    list) echo '[]'; exit 0 ;;",
    '    create) echo "https://github.test/o/r/pull/7"; exit 0 ;;',
    "    merge) exit 0 ;;",
    '    close) exit 0 ;;',
    '    *) echo "gh: unexpected pr subcommand" >&2; exit 1 ;;',
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

/** Every `gh` invocation the stub saw, one line per call. */
function ghCalls(log: string): string[] {
  return existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    : [];
}

interface Repo {
  dir: string;
  remote: string;
  ghDir: string;
  ghLog: string;
}

/**
 * A working repository on `main` with a bare remote, the policy attested
 * through the real ceremony, and everything pushed.
 *
 * The genesis attestation comes from `approval policy attest`, not from a
 * hand-written line: the whole point of this file is that the race is built out
 * of the paths that caused it.
 */
function newRepo(): Repo {
  counter += 1;
  const remote = join(scratch, `remote-${String(counter)}.git`);
  const dir = join(scratch, `work-${String(counter)}`);
  mkdirSync(join(dir, ".approval", "log"), { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), BEFORE, "utf8");
  writeFileSync(join(dir, "README.md"), "# fixture\n", "utf8");
  writeFileSync(join(dir, QUEUE_RELATIVE), "# queue\n", "utf8");

  const stub = ghStub();
  const repo: Repo = { dir, remote, ghDir: stub.dir, ghLog: stub.log };

  assert.equal(runCli(repo, ["policy", "attest", "--as", "human:carter"]).code, 0);

  assert.equal(git(["init", "-q", "--bare", "-b", "main", remote], scratch).code, 0);
  assert.equal(git(["init", "-q", "-b", "main", "."], dir).code, 0);
  git(["config", "user.email", "test@example.invalid"], dir);
  git(["config", "user.name", "Test"], dir);
  assert.equal(git(["add", "-A"], dir).code, 0);
  assert.equal(git(["commit", "-qm", "seed"], dir).code, 0);
  assert.equal(git(["remote", "add", "origin", remote], dir).code, 0);
  assert.equal(git(["push", "-q", "-u", "origin", "main"], dir).code, 0);
  assert.equal(git(["remote", "set-head", "origin", "main"], dir).code, 0);
  return repo;
}

/** Run the CLI with the `gh` stub first on PATH, so no case can reach GitHub. */
function runCli(repo: Repo, args: string[]): Run {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${repo.ghDir}${delimiter}${process.env["PATH"] ?? ""}`,
  };
  delete env["APPROVAL_HUMAN"];
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: repo.dir,
    encoding: "utf8",
    env,
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** The amendment ceremony, as a lane runs it. */
function amend(repo: Repo, extra: readonly string[] = []): Run {
  return runCli(repo, ["policy", "amend", "--as", "human:carter", "--yes", "--pr", ...extra]);
}

/**
 * One more record on the working log, through the real append path.
 *
 * The race needs the two sides to actually DIFFER. A records advance that
 * carries nothing but the attestation the amendment already carries produces an
 * identical `events.jsonl` on both branches, and git merges identical content
 * without a murmur — which would make the conflict case below prove nothing.
 * In the incident the advance carried the attestation plus everything else the
 * day had logged, and that is what these fillers stand in for.
 */
function appendRecord(repo: Repo, marker: string): void {
  const result = register(
    join(repo.dir, LOG_RELATIVE),
    {
      task: `filler-${marker}`,
      envelope: {
        origin: { app: "fixture", created_by: "human:tester" },
        state: "proposed",
        actions: [{ class: "read.local", idempotency_key: `filler-${marker}` }],
      },
    },
    "human:tester",
    { policy: { file: join(repo.dir, "APPROVAL.md") } },
  );
  assert.equal(result.ok, true, result.ok ? "" : result.message);
}

/** A real records advance, opening or updating the day's records branch. */
function advance(repo: Repo): void {
  const previous = process.env["PATH"] ?? "";
  process.env["PATH"] = `${repo.ghDir}${delimiter}${previous}`;
  try {
    const result = logAdvance({
      cwd: repo.dir,
      remote: "origin",
      base: "main",
      pr: true,
      branch: RECORDS_BRANCH,
      today: TODAY,
    });
    assert.equal(result.ok, true, result.ok ? "" : `${result.code}: ${result.message}`);
  } finally {
    process.env["PATH"] = previous;
  }
}

/** Land a branch on the remote's `main`, the way the merge queue does. */
function landOnMain(repo: Repo, branch: string): void {
  counter += 1;
  const clone = join(scratch, `land-${String(counter)}`);
  assert.equal(git(["clone", "-q", "-b", "main", repo.remote, clone], scratch).code, 0);
  const merged = git(["merge", "--no-edit", "-m", `land ${branch}`, `origin/${branch}`], clone);
  assert.equal(merged.code, 0, `landing ${branch} on main conflicted: ${merged.stdout}${merged.stderr}`);
  assert.equal(git(["push", "-q", "origin", "main"], clone).code, 0);
}

/**
 * Try to merge `branch` into the remote's `main` in a throwaway clone, and
 * report whether git could.
 *
 * A real merge in a real clone, because that is what the merge queue does and
 * "mergeable" is the whole claim under test. The clone is thrown away either
 * way, so a conflicting attempt costs nothing.
 */
function mergesCleanly(repo: Repo, branch: string): { ok: boolean; output: string } {
  counter += 1;
  const clone = join(scratch, `merge-${String(counter)}`);
  assert.equal(git(["clone", "-q", "-b", "main", repo.remote, clone], scratch).code, 0);
  const merged = git(["merge", "--no-commit", "--no-ff", `origin/${branch}`], clone);
  const output = `${merged.stdout}${merged.stderr}`;
  return { ok: merged.code === 0 && !output.includes("CONFLICT"), output };
}

/** The files a commit on `branch` in the bare remote carries, sorted. */
function remoteFiles(repo: Repo, branch: string): string[] {
  return git(["show", "--name-only", "--pretty=format:", branch], repo.remote)
    .stdout.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();
}

/** The seq the amendment attested, read out of the ceremony's own stdout. */
function attestedSeq(run: Run): string {
  const match = /attested seq (\d+)/u.exec(run.stdout);
  assert.notEqual(match, null, `no attested seq in the ceremony output:\n${run.stdout}`);
  return (match as RegExpExecArray)[1] as string;
}

// ---------------------------------------------------------------------------
// 1. Prevention: a live records advance owns the log, so the amendment does not
// ---------------------------------------------------------------------------

test("an amendment opened while a records advance is pending carries no log, and merges clean", () => {
  const repo = newRepo();
  // The advance goes first, which is the incident's own order: PR 529 was open
  // before the amendment ran. It needs a record to carry to open anything.
  appendRecord(repo, "before-amend");
  advance(repo);
  assert.notEqual(
    git(["rev-parse", "--verify", "--quiet", RECORDS_BRANCH], repo.remote).stdout.trim(),
    "",
    "the records advance did not put its branch on the remote",
  );

  writeFileSync(join(repo.dir, "APPROVAL.md"), AFTER, "utf8");
  const run = amend(repo);
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  const seq = attestedSeq(run);
  const branch = `policy-amend-${seq}`;

  // The file list is the fix, stated: the policy and its attested text, and no
  // `events.jsonl`.
  const files = remoteFiles(repo, branch);
  assert.ok(files.includes("APPROVAL.md"), `the amendment carries no policy: ${files.join(", ")}`);
  assert.ok(
    !files.includes(LOG_RELATIVE),
    `the amendment still carries the log (${files.join(", ")}). While a records advance is publishing it, two commits appending the same records is a conflict on events.jsonl whichever lands first, and the repair is a hand merge of the log.`,
  );
  // The ceremony SAYS who publishes the log, so the pull request's file list is
  // never a surprise to the person who just signed the policy.
  assert.match(
    run.stdout,
    /records advance is live on records-log-2026-09-21, pushed before this attestation was appended/u,
    `the ceremony did not say who publishes the log:\n${run.stdout}`,
  );

  // And the property that matters: the advance lands, and the amendment is
  // still mergeable.
  landOnMain(repo, RECORDS_BRANCH);
  const merge = mergesCleanly(repo, branch);
  assert.ok(
    merge.ok,
    `the amendment branch no longer merges into main after the records advance landed:\n${merge.output}`,
  );
});

// ---------------------------------------------------------------------------
// 2. The conflict, and the repair
// ---------------------------------------------------------------------------

test("a re-run repairs the amendment a landed records advance made unmergeable", () => {
  const repo = newRepo();
  // No advance is live, so the amendment is the only publisher and carries the
  // log, exactly as it did before this task.
  writeFileSync(join(repo.dir, "APPROVAL.md"), AFTER, "utf8");
  const first = amend(repo);
  assert.equal(first.code, 0, `${first.stdout}\n${first.stderr}`);
  const seq = attestedSeq(first);
  const branch = `policy-amend-${seq}`;
  assert.ok(
    remoteFiles(repo, branch).includes(LOG_RELATIVE),
    "with nothing else publishing it, the amendment must carry the log",
  );

  // Now the day logs more, and the advance runs and lands. It carries the
  // amendment's attestation AND the records after it, so main's log extends
  // past the amendment branch's rather than matching it.
  appendRecord(repo, "after-amend-a");
  appendRecord(repo, "after-amend-b");
  advance(repo);
  landOnMain(repo, RECORDS_BRANCH);

  // The bug, proved rather than assumed: the branch is now unmergeable.
  const before = mergesCleanly(repo, branch);
  assert.equal(
    before.ok,
    false,
    "the premise of this case no longer holds: two commits appending the same records to events.jsonl merged cleanly, so the repair below is being tested against nothing",
  );

  // The re-run. It must not answer "nothing to amend" over a dirty pull request.
  const repair = amend(repo);
  assert.equal(repair.code, 0, `${repair.stdout}\n${repair.stderr}`);
  assert.doesNotMatch(
    repair.stdout,
    /nothing to amend/u,
    "the re-run said nothing to amend while the pull request carrying the amendment was open and unmergeable",
  );
  assert.match(repair.stdout, new RegExp(`${branch}: rebuilt `, "u"));
  assert.match(repair.stdout, /force-updated .* so the pull request is mergeable again/u);

  // The repaired branch carries only what main still lacks, and merges.
  const files = remoteFiles(repo, branch);
  assert.ok(files.includes("APPROVAL.md"), `the repair dropped the policy: ${files.join(", ")}`);
  assert.ok(
    !files.includes(LOG_RELATIVE),
    `the repair still carries the log (${files.join(", ")}); main's log is a superset by construction, so carrying it is the conflict again`,
  );
  const after = mergesCleanly(repo, branch);
  assert.ok(after.ok, `the repaired branch still does not merge:\n${after.output}`);

  // The arm is re-run too: a repaired pull request nobody armed is a pull
  // request still waiting for a click.
  assert.ok(
    ghCalls(repo.ghLog).some((call) => call.startsWith(`pr merge ${branch} --merge --auto`)),
    `the repair did not re-arm the merge; gh saw:\n${ghCalls(repo.ghLog).join("\n")}`,
  );
});

test("a re-run whose amendment already landed says so, and names the close", () => {
  const repo = newRepo();
  writeFileSync(join(repo.dir, "APPROVAL.md"), AFTER, "utf8");
  const first = amend(repo);
  assert.equal(first.code, 0, `${first.stdout}\n${first.stderr}`);
  const branch = `policy-amend-${attestedSeq(first)}`;

  // The amendment lands in full, which is the ordinary happy path.
  landOnMain(repo, branch);

  const again = amend(repo);
  assert.equal(again.code, 0, `${again.stdout}\n${again.stderr}`);
  assert.doesNotMatch(again.stdout, /nothing to amend/u);
  assert.match(again.stdout, /is already on origin\/main/u);
  assert.match(again.stderr, new RegExp(`gh pr close ${branch}`, "u"));
});

test("an amendment branch carrying somebody else's commit is never rebuilt over", () => {
  const repo = newRepo();
  writeFileSync(join(repo.dir, "APPROVAL.md"), AFTER, "utf8");
  const first = amend(repo);
  assert.equal(first.code, 0, `${first.stdout}\n${first.stderr}`);
  const branch = `policy-amend-${attestedSeq(first)}`;

  // A second commit on the branch: work this ceremony did not put there.
  counter += 1;
  const peer = join(scratch, `peer-${String(counter)}`);
  assert.equal(git(["clone", "-q", "-b", branch, repo.remote, peer], scratch).code, 0);
  writeFileSync(join(peer, "NOTES.md"), "somebody else's work\n", "utf8");
  assert.equal(git(["add", "-A"], peer).code, 0);
  assert.equal(git(["commit", "-qm", "peer work"], peer).code, 0);
  assert.equal(git(["push", "-q", "origin", branch], peer).code, 0);
  const tip = git(["rev-parse", branch], repo.remote).stdout.trim();

  const again = amend(repo);
  assert.doesNotMatch(again.stdout, /nothing to amend/u);
  assert.match(again.stdout, /carries 2 commits that origin\/main does not/u);
  assert.match(again.stdout, /will not be rebuilt over/u);
  assert.equal(
    git(["rev-parse", branch], repo.remote).stdout.trim(),
    tip,
    "the branch was force-updated over somebody else's commit",
  );
});

// ---------------------------------------------------------------------------
// 3. The preview, and the machine surface
// ---------------------------------------------------------------------------

test("--no-publish computes the repair and runs none of it", () => {
  const repo = newRepo();
  writeFileSync(join(repo.dir, "APPROVAL.md"), AFTER, "utf8");
  const first = amend(repo);
  const seq = attestedSeq(first);
  const branch = `policy-amend-${seq}`;
  advance(repo);
  landOnMain(repo, RECORDS_BRANCH);
  const tip = git(["rev-parse", branch], repo.remote).stdout.trim();

  const preview = runCli(repo, [
    "policy",
    "amend",
    "--as",
    "human:carter",
    "--yes",
    "--commit",
    "--no-publish",
  ]);
  assert.equal(preview.code, 0, `${preview.stdout}\n${preview.stderr}`);
  assert.doesNotMatch(preview.stdout, /nothing to amend/u);
  assert.match(preview.stdout, /nothing was pushed, so the pull request is unchanged/u);
  assert.match(preview.stderr, new RegExp(`git push origin \\+\\w+:refs/heads/${branch}`, "u"));
  assert.equal(
    git(["rev-parse", branch], repo.remote).stdout.trim(),
    tip,
    "--no-publish pushed",
  );
});

test("the repair is reported additively under --json", () => {
  const repo = newRepo();
  writeFileSync(join(repo.dir, "APPROVAL.md"), AFTER, "utf8");
  const first = amend(repo);
  const branch = `policy-amend-${attestedSeq(first)}`;
  advance(repo);
  landOnMain(repo, RECORDS_BRANCH);

  const run = runCli(repo, ["policy", "amend", "--as", "human:carter", "--yes", "--pr", "--json"]);
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
  assert.equal(parsed["noop"], true, "the run still reports itself a no-op ceremony");
  const repair = parsed["repair"] as Record<string, unknown>;
  assert.notEqual(repair, null, "--json carried no repair object");
  assert.equal(repair["branch"], branch);
  assert.equal(repair["state"], "repaired");
  assert.equal(repair["pushed"], true);
  assert.equal(repair["autoMerge"], "armed");
  assert.ok(
    (repair["carried"] as string[]).includes("APPROVAL.md"),
    `the repair carried ${JSON.stringify(repair["carried"])}`,
  );
  assert.ok(
    !(repair["carried"] as string[]).includes(LOG_RELATIVE),
    "the repair carried the log main already has",
  );
});
