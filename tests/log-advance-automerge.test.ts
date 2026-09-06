/**
 * `approval log advance --pr` arms the merge it opens (APRV-284).
 *
 * ## What is being pinned
 *
 * A records pull request carries exactly the log, `QUEUE.md` and
 * `.approval/payloads/` — the three paths CI's protected-path guard exempts —
 * so the click it used to wait for at CLEAN was never a review. The verb now
 * runs `gh pr merge <branch> --merge --auto` after it opens or updates the pull
 * request, and these cases hold four things to that:
 *
 * 1. the arm actually happens, with the argv a session would type;
 * 2. `--no-auto-merge` skips it, and no `gh pr merge` reaches the stub;
 * 3. an arm `gh` refuses is REPORTED and never fatal — the records are
 *    committed, pushed and open either way;
 * 4. a records branch carrying anything an advance may not carry WITHHOLDS the
 *    arm, because the reason auto-merging one is safe is a claim about the diff
 *    and this verb checks it rather than assuming it.
 *
 * Real git throughout, with a bare remote; `gh` is stubbed because it is the
 * one thing here that would reach the network, and it logs every call so the
 * absence of a merge can be asserted as directly as its presence. No log line
 * is written by hand: records come from the real append path.
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

import { appendAttestation } from "../src/core/attest.js";
import { register } from "../src/core/gate.js";
import { logAdvance, type LogAdvanceResult } from "../src/cli/log-advance.js";
import { commandLogAdvance } from "../src/cli/log-verbs.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-advance-arm-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const LOG_RELATIVE = ".approval/log/events.jsonl";
const QUEUE_RELATIVE = ".approval/QUEUE.md";
const TODAY = "2026-09-06T09:00:00.000Z";
const RECORDS_BRANCH = "records-log-2026-09-06";

const POLICY = [
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

function git(args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
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
 * A `gh` stub that logs every call and can be told to refuse the arm.
 *
 * `pr merge` succeeds unless a `merge-refuses` file sits beside it, which is
 * how the third case gets a real `gh` refusal without a real remote: the point
 * of that case is what the VERB does with a no, and a no is a no.
 */
function ghStub(): { dir: string; log: string; refuseMerge: string } {
  counter += 1;
  const dir = join(scratch, `gh-bin-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "calls.txt");
  const open = join(dir, "pr-open");
  const refuseMerge = join(dir, "merge-refuses");
  const script = [
    "#!/bin/sh",
    `for arg in "$@"; do printf '%s ' "$arg" >> ${JSON.stringify(log)}; done`,
    `printf '\\n' >> ${JSON.stringify(log)}`,
    'case "$1" in',
    '  pr) case "$2" in',
    `    list) if [ -f ${JSON.stringify(open)} ]; then echo '[{"url":"https://example.invalid/pr/7"}]'; else echo '[]'; fi; exit 0 ;;`,
    `    create) : > ${JSON.stringify(open)}; echo "https://example.invalid/pr/7"; exit 0 ;;`,
    `    merge) if [ -f ${JSON.stringify(refuseMerge)} ]; then echo "auto-merge is not enabled for this repository" >&2; exit 1; fi; echo "armed"; exit 0 ;;`,
    "  esac ;;",
    "esac",
    "exit 1",
    "",
  ].join("\n");
  const path = join(dir, "gh");
  writeFileSync(path, script, "utf8");
  chmodSync(path, 0o755);
  return { dir, log, refuseMerge };
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
  logPath: string;
  ghDir: string;
  ghLog: string;
  refuseMerge: string;
}

/** One appended record, through the real append path. */
function appendRecord(dir: string, marker: string): void {
  const result = register(
    join(dir, LOG_RELATIVE),
    {
      task: `filler-${marker}`,
      envelope: {
        origin: { app: "fixture", created_by: "human:tester" },
        state: "proposed",
        actions: [{ class: "read.local", idempotency_key: `filler-${marker}` }],
      },
    },
    "human:tester",
    { policy: { file: join(dir, "APPROVAL.md") } },
  );
  assert.equal(result.ok, true, result.ok ? "" : result.message);
}

function newRepo(): Repo {
  counter += 1;
  const remote = join(scratch, `remote-${String(counter)}.git`);
  const dir = join(scratch, `work-${String(counter)}`);
  mkdirSync(join(dir, ".approval", "log"), { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  writeFileSync(join(dir, "README.md"), "# fixture\n", "utf8");
  writeFileSync(join(dir, QUEUE_RELATIVE), "# queue\n", "utf8");

  const attested = appendAttestation(join(dir, LOG_RELATIVE), join(dir, "APPROVAL.md"), "human:carter");
  assert.equal(attested.ok, true, attested.ok ? "" : attested.error.message);

  assert.equal(git(["init", "-q", "--bare", "-b", "main", remote], scratch).code, 0);
  assert.equal(git(["init", "-q", "-b", "main", "."], dir).code, 0);
  git(["config", "user.email", "test@example.invalid"], dir);
  git(["config", "user.name", "Test"], dir);
  assert.equal(git(["add", "-A"], dir).code, 0);
  assert.equal(git(["commit", "-qm", "seed"], dir).code, 0);
  assert.equal(git(["remote", "add", "origin", remote], dir).code, 0);
  assert.equal(git(["push", "-q", "-u", "origin", "main"], dir).code, 0);

  const stub = ghStub();
  return {
    dir,
    remote,
    logPath: join(dir, LOG_RELATIVE),
    ghDir: stub.dir,
    ghLog: stub.log,
    refuseMerge: stub.refuseMerge,
  };
}

/** Run the verb with the `gh` stub on PATH. */
function advance(repo: Repo, over: Record<string, unknown> = {}): LogAdvanceResult {
  const previous = process.env["PATH"] ?? "";
  process.env["PATH"] = `${repo.ghDir}${delimiter}${previous}`;
  try {
    return logAdvance({
      cwd: repo.dir,
      remote: "origin",
      base: "main",
      pr: true,
      branch: RECORDS_BRANCH,
      today: TODAY,
      ...over,
    });
  } finally {
    process.env["PATH"] = previous;
  }
}

/** Run the CLI edge with the stub on PATH, capturing both streams. */
function runCli(repo: Repo, argv: string[]): { code: number; out: string; err: string } {
  const previous = process.env["PATH"] ?? "";
  process.env["PATH"] = `${repo.ghDir}${delimiter}${previous}`;
  let out = "";
  let err = "";
  try {
    const code = commandLogAdvance(
      argv,
      {
        out: (text: string) => {
          out += text;
        },
        err: (text: string) => {
          err += text;
        },
      },
      repo.dir,
    );
    return { code, out, err };
  } finally {
    process.env["PATH"] = previous;
  }
}

/** The `gh pr merge` calls the stub saw, in order. */
function mergeCalls(repo: Repo): string[] {
  return ghCalls(repo.ghLog).filter((line) => line.startsWith("pr merge"));
}

// ---------------------------------------------------------------------------

test("--pr arms the merge with the argv a session's own arm uses", () => {
  const repo = newRepo();
  appendRecord(repo.dir, "one");

  const result = advance(repo);
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok) return;
  assert.equal(result.report.pushed, true);
  assert.equal(result.report.prCreated, true);
  assert.equal(result.report.autoMerge, "armed");
  assert.equal(result.report.autoMergeNote, null);

  // The same command, in the same order, a session types by hand — and once.
  assert.deepEqual(mergeCalls(repo), [`pr merge ${RECORDS_BRANCH} --merge --auto`]);
});

test("the arm follows the pull request on a later advance, not only the first", () => {
  const repo = newRepo();
  appendRecord(repo.dir, "one");
  const first = advance(repo);
  assert.equal(first.ok, true, first.ok ? "" : first.message);

  appendRecord(repo.dir, "two");
  const second = advance(repo);
  assert.equal(second.ok, true, second.ok ? "" : second.message);
  if (!second.ok) return;

  // The day's pull request was UPDATED, not re-opened, and armed again: the arm
  // is idempotent and an advance that only armed on creation would leave a
  // pull request opened before APRV-284 sitting unarmed forever.
  assert.equal(second.report.prCreated, false);
  assert.equal(second.report.autoMerge, "armed");
  assert.equal(mergeCalls(repo).length, 2);
  assert.equal(ghCalls(repo.ghLog).filter((line) => line.startsWith("pr create")).length, 1);
});

test("--no-auto-merge: nothing is armed and no gh pr merge is run at all", () => {
  const repo = newRepo();
  appendRecord(repo.dir, "one");

  const result = advance(repo, { autoMerge: false });
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok) return;
  assert.equal(result.report.pushed, true);
  assert.equal(result.report.prUrl, "https://example.invalid/pr/7");
  assert.equal(result.report.autoMerge, "off");
  assert.equal(result.report.autoMergeNote, null);
  assert.deepEqual(mergeCalls(repo), [], "a disabled arm still reached gh");
});

test("without --pr there is no pull request step and nothing to arm", () => {
  const repo = newRepo();
  appendRecord(repo.dir, "one");

  const result = advance(repo, { pr: false });
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok) return;
  assert.equal(result.report.pushed, true);
  assert.equal(result.report.autoMerge, null);
  assert.deepEqual(ghCalls(repo.ghLog), []);
});

test("a gh that refuses the arm is reported, and the advance still succeeds", () => {
  const repo = newRepo();
  writeFileSync(repo.refuseMerge, "", "utf8");
  appendRecord(repo.dir, "one");

  const result = advance(repo);
  assert.equal(result.ok, true, "a refused arm failed the whole advance");
  if (!result.ok) return;
  // The records are published and the pull request is open either way: that is
  // the whole reason this is a report and not a refusal code.
  assert.equal(result.report.pushed, true);
  assert.equal(result.report.prUrl, "https://example.invalid/pr/7");
  assert.equal(result.report.autoMerge, "refused");
  assert.match(result.report.autoMergeNote ?? "", /auto-merge is not enabled/u);
});

test("a records branch carrying more than an advance may carry withholds the arm", () => {
  const repo = newRepo();

  // Somebody else's commit, sitting on the day's records branch on the shared
  // remote. The advance will fast-forward over it; arming a merge for it would
  // land a path the protected-path guard does not exempt with nobody reading it.
  counter += 1;
  const clone = join(scratch, `intruder-${String(counter)}`);
  assert.equal(git(["clone", "-q", repo.remote, clone], scratch).code, 0);
  git(["config", "user.email", "test@example.invalid"], clone);
  git(["config", "user.name", "Test"], clone);
  writeFileSync(join(clone, "SNEAKY.md"), "# not evidence\n", "utf8");
  assert.equal(git(["checkout", "-q", "-b", RECORDS_BRANCH], clone).code, 0);
  assert.equal(git(["add", "-A"], clone).code, 0);
  assert.equal(git(["commit", "-qm", "something that is not the log"], clone).code, 0);
  assert.equal(git(["push", "-q", "origin", RECORDS_BRANCH], clone).code, 0);

  appendRecord(repo.dir, "one");
  const result = advance(repo);
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok) return;
  assert.equal(result.report.pushed, true, "the advance itself is unaffected");
  assert.equal(result.report.autoMerge, "withheld");
  assert.match(result.report.autoMergeNote ?? "", /SNEAKY\.md/u);
  assert.deepEqual(mergeCalls(repo), [], "the arm reached gh despite the guard");
});

test("the CLI says the merge is armed, and --no-auto-merge says it is not", () => {
  const armed = newRepo();
  appendRecord(armed.dir, "one");
  const first = runCli(armed, ["--pr", "--branch", RECORDS_BRANCH, "--base", "main"]);
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /auto-merge/u);
  assert.match(first.out, /armed/u);
  assert.match(first.out, /MERGE COMMIT when CI is green/u);

  const off = newRepo();
  appendRecord(off.dir, "one");
  const second = runCli(off, [
    "--pr",
    "--no-auto-merge",
    "--branch",
    RECORDS_BRANCH,
    "--base",
    "main",
  ]);
  assert.equal(second.code, 0, second.err);
  assert.match(second.out, /auto-merge/u);
  assert.match(second.out, /--no-auto-merge/u);
  assert.deepEqual(mergeCalls(off), []);
});

test("--json carries autoMerge and autoMergeNote as a machine reads them", () => {
  const repo = newRepo();
  writeFileSync(repo.refuseMerge, "", "utf8");
  appendRecord(repo.dir, "one");

  const run = runCli(repo, ["--pr", "--json", "--branch", RECORDS_BRANCH, "--base", "main"]);
  assert.equal(run.code, 0, run.err);
  const parsed = JSON.parse(run.out.trim()) as Record<string, unknown>;
  assert.equal(parsed["ok"], true);
  assert.equal(parsed["autoMerge"], "refused");
  assert.match(String(parsed["autoMergeNote"]), /auto-merge is not enabled/u);
  // The progress narration goes to stderr and never onto the parsed stream.
  assert.equal(run.out.trim().split("\n").length, 1);
});
