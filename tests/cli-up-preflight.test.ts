/**
 * The startup preflight (APRV-215), driven as a real process against a real
 * git topology.
 *
 * Every case builds a bare remote and a working clone and drives them with real
 * `git`, for the reason `tests/cli-log-verbs.test.ts` gives: the subject is what
 * git actually does to a checkout, and a fake git would test the fake. The verb
 * under test is the built CLI, spawned, so what is asserted is the shipped
 * surface rather than a function's return value.
 *
 * Two things are pinned in every refusal case and are the point of the suite:
 *
 * - the refusal changed NOTHING. `HEAD` is where it was, the working log is
 *   byte-identical, and no build ran. A preflight that repaired something it
 *   was refusing to reason about would be worse than no preflight;
 * - the words `reset --hard` appear nowhere in any output, on any path.
 *
 * Nothing here reaches the network or the live log. The remotes are local bare
 * repositories, every path is an explicit `--log` / `--out` / `--dir` under a
 * scratch directory, and the daemon runs `--once` with both channels off, so no
 * socket is opened and no long poll is started.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { PREFLIGHT_REFUSAL_CODES } from "../src/cli/preflight.js";

/** dist/tests/cli-up-preflight.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-preflight-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const LOG_RELATIVE = ".approval/log/events.jsonl";
const QUEUE_RELATIVE = ".approval/QUEUE.md";

const POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "1h"',
  "  on_expiry: reject",
  "classes: {}",
  "```",
  "",
].join("\n");

function git(args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { code: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** The built CLI, spawned. `NO_COLOR` so the runbook can be read as plain text. */
function cli(args: string[], cwd: string): Run {
  const run = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", APPROVAL_HUMAN: "human:test" },
  });
  return { code: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
}

interface Repo {
  dir: string;
  remote: string;
  peer: string;
  logPath: string;
  queuePath: string;
}

/**
 * A working checkout with a log, a queue file, an origin, one commit, and a
 * second clone standing in for whoever else pushes to that origin.
 */
function newRepo(): Repo {
  counter += 1;
  const remote = join(scratch, `remote-${String(counter)}.git`);
  const dir = join(scratch, `work-${String(counter)}`);
  mkdirSync(join(dir, ".approval", "log"), { recursive: true });
  mkdirSync(join(dir, "backlog", "tasks"), { recursive: true });
  writeFileSync(join(dir, "backlog", "tasks", ".keep"), "", "utf8");
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  writeFileSync(join(dir, "README.md"), "# fixture\n", "utf8");
  writeFileSync(join(dir, LOG_RELATIVE), "", "utf8");
  writeFileSync(join(dir, QUEUE_RELATIVE), "# queue\n", "utf8");

  assert.equal(git(["init", "-q", "--bare", "-b", "main", remote], scratch).code, 0);
  assert.equal(git(["init", "-q", "-b", "main", "."], dir).code, 0);
  git(["config", "user.email", "test@example.invalid"], dir);
  git(["config", "user.name", "Test"], dir);
  assert.equal(git(["add", "-A"], dir).code, 0);
  assert.equal(git(["commit", "-qm", "seed"], dir).code, 0);
  assert.equal(git(["remote", "add", "origin", remote], dir).code, 0);
  assert.equal(git(["push", "-q", "-u", "origin", "main"], dir).code, 0);

  counter += 1;
  const peer = join(scratch, `peer-${String(counter)}`);
  assert.equal(git(["clone", "-q", remote, peer], scratch).code, 0);
  git(["config", "user.email", "test@example.invalid"], peer);
  git(["config", "user.name", "Test"], peer);

  return { dir, remote, peer, logPath: join(dir, LOG_RELATIVE), queuePath: join(dir, QUEUE_RELATIVE) };
}

/** Land one upstream commit through the peer clone. Answers its sha. */
function upstreamCommit(repo: Repo, relative: string, contents: string, message: string): string {
  const path = join(repo.peer, relative);
  mkdirSync(join(path, "..").replace(/\/\.\.$/u, ""), { recursive: true });
  writeFileSync(path, contents, "utf8");
  assert.equal(git(["add", "-A"], repo.peer).code, 0);
  assert.equal(git(["commit", "-qm", message], repo.peer).code, 0);
  const pushed = git(["push", "-q", "origin", "main"], repo.peer);
  assert.equal(pushed.code, 0, pushed.stderr);
  return git(["rev-parse", "HEAD"], repo.peer).stdout.trim();
}

function head(dir: string): string {
  return git(["rev-parse", "HEAD"], dir).stdout.trim();
}

/**
 * An installation root whose `dist/` is or is not older than its `src/`.
 *
 * `npm run build` here touches the marker rather than compiling anything: the
 * question this suite asks is whether the preflight RUNS the build and reports
 * it, and a real `tsc` would be testing the compiler.
 */
function fixtureRoot(stale: boolean): string {
  counter += 1;
  const root = join(scratch, `root-${String(counter)}`);
  mkdirSync(join(root, "dist", "src", "cli"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "cli.js"), "// loader\n", "utf8");
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
  const marker = join(root, "dist", "src", "cli", "main.js");
  writeFileSync(marker, "// build\n", "utf8");
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify(
      { name: "fixture", private: true, scripts: { build: `touch ${JSON.stringify(marker)}` } },
      null,
      2,
    )}\n`,
    "utf8",
  );
  // Explicit times rather than write order: two writes a millisecond apart can
  // land on the same mtime, and this suite would then be asserting on luck. The
  // fresh marker is dated forward rather than the sources back, because
  // `newestMtime` walks `src/` and would otherwise pick up the DIRECTORY's own
  // mtime, which is whenever the fixture was written.
  const when = Date.now() / 1000 + (stale ? -3600 : 3600);
  utimesSync(marker, when, when);
  return root;
}

/** The daemon, once, with both channels off and every path named explicitly. */
function upOnce(repo: Repo, extra: string[]): Run {
  return cli(
    [
      "up",
      "--once",
      "--no-telegram",
      "--no-web",
      "--log",
      repo.logPath,
      "--out",
      repo.queuePath,
      "--dir",
      repo.dir,
      "--tasks",
      join(repo.dir, "backlog", "tasks"),
      ...extra,
    ],
    repo.dir,
  );
}

interface PreflightLine {
  event: string;
  behind_by: number;
  ahead_by: number;
  log_touched: boolean;
  dist_stale: boolean;
  action: string;
  commit: string | null;
  detail: string;
}

function preflightLineOf(run: Run): PreflightLine {
  const lines = run.stdout
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line) as { event: string });
  const found = lines.find((line) => line.event === "preflight");
  assert.ok(found !== undefined, `no preflight line in:\n${run.stdout}${run.stderr}`);
  return found as unknown as PreflightLine;
}

function refusalOf(run: Run): {
  error: { code: string; message: string; next?: string };
  preflight: PreflightLine;
} {
  const line = run.stderr
    .split("\n")
    .find((candidate) => candidate.trim().startsWith("{") && candidate.includes('"error"'));
  assert.ok(line !== undefined, `no refusal object in:\n${run.stderr}`);
  return JSON.parse(line) as {
    error: { code: string; message: string; next?: string };
    preflight: PreflightLine;
  };
}

// ---------------------------------------------------------------------------
// The safe path
// ---------------------------------------------------------------------------

test("preflight: fast-forwards a behind checkout, rebuilds a stale dist, and names the commit now running", () => {
  const repo = newRepo();
  const target = upstreamCommit(repo, "README.md", "# fixture v2\n", "upstream edit");
  assert.notEqual(head(repo.dir), target);

  const run = upOnce(repo, ["--json", "--root", fixtureRoot(true)]);
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);

  const line = preflightLineOf(run);
  assert.equal(line.behind_by, 1);
  assert.equal(line.ahead_by, 0);
  assert.equal(line.log_touched, false);
  assert.equal(line.dist_stale, true);
  assert.equal(line.action, "fast-forward+rebuild");
  assert.equal(line.commit, target);

  // The fast-forward really happened, and the started line names what is running.
  assert.equal(head(repo.dir), target);
  assert.equal(readFileSync(join(repo.dir, "README.md"), "utf8"), "# fixture v2\n");
});

/**
 * The protected path here is the QUEUE projection rather than the log, for one
 * boring reason: the daemon that runs after the preflight verifies the log, and
 * a hand-written line would fail that verification and end the case before the
 * assertion it exists for. The preflight treats the two paths identically, and
 * the diverged case below uses the log itself, where the refusal lands first.
 */
test("preflight: a clean working copy plus an upstream change to a protected path fast-forwards", () => {
  const repo = newRepo();
  const target = upstreamCommit(repo, QUEUE_RELATIVE, "# queue v2\n", "upstream queue render");

  const run = upOnce(repo, ["--json", "--root", fixtureRoot(false)]);
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  const line = preflightLineOf(run);
  assert.equal(line.log_touched, true);
  assert.equal(line.dist_stale, false);
  assert.equal(line.action, "fast-forward");
  assert.equal(head(repo.dir), target);
});

test("preflight: an up-to-date checkout with a fresh build does nothing at all", () => {
  const repo = newRepo();
  const before = head(repo.dir);
  const run = upOnce(repo, ["--json", "--root", fixtureRoot(false)]);
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  const line = preflightLineOf(run);
  assert.deepEqual(
    { behind: line.behind_by, ahead: line.ahead_by, stale: line.dist_stale, action: line.action },
    { behind: 0, ahead: 0, stale: false, action: "none" },
  );
  assert.equal(head(repo.dir), before);
});

// ---------------------------------------------------------------------------
// The three refusals
// ---------------------------------------------------------------------------

test("preflight: a checkout ahead of the remote is refused, and nothing moves", () => {
  const repo = newRepo();
  writeFileSync(join(repo.dir, "local.txt"), "mine\n", "utf8");
  git(["add", "-A"], repo.dir);
  git(["commit", "-qm", "local work"], repo.dir);
  const before = head(repo.dir);

  const run = upOnce(repo, ["--json", "--root", fixtureRoot(true)]);
  assert.equal(run.code, 1, `${run.stdout}${run.stderr}`);
  const refused = refusalOf(run);
  assert.equal(refused.error.code, "up-preflight-behind-ahead");
  assert.equal(refused.preflight.ahead_by, 1);
  assert.equal(refused.preflight.action, "refused");
  assert.equal(head(repo.dir), before);
  // Refused BEFORE the build: a preflight that compiled the tree it was
  // declining to reason about would have acted on a state it did not accept.
  assert.equal(run.stdout, "");
});

test("preflight: an upstream log change over a dirty working log names approval log sync", () => {
  const repo = newRepo();
  upstreamCommit(repo, LOG_RELATIVE, '{"seq":1,"type":"note"}\n', "upstream log advance");
  writeFileSync(repo.logPath, '{"seq":1,"type":"mine"}\n', "utf8");
  const before = head(repo.dir);
  const logBytes = readFileSync(repo.logPath);

  const run = upOnce(repo, ["--json", "--root", fixtureRoot(false)]);
  assert.equal(run.code, 1, `${run.stdout}${run.stderr}`);
  const refused = refusalOf(run);
  assert.equal(refused.error.code, "up-preflight-log-diverged");
  assert.equal(refused.error.next, "approval log sync");
  assert.equal(refused.preflight.log_touched, true);

  assert.equal(head(repo.dir), before);
  assert.deepEqual(readFileSync(repo.logPath), logBytes);
});

test("preflight: a dirty file in the fast-forward's way is its own refusal", () => {
  const repo = newRepo();
  upstreamCommit(repo, "README.md", "# fixture v2\n", "upstream edit");
  writeFileSync(join(repo.dir, "README.md"), "# mine\n", "utf8");
  const before = head(repo.dir);

  const run = upOnce(repo, ["--json", "--root", fixtureRoot(false)]);
  assert.equal(run.code, 1, `${run.stdout}${run.stderr}`);
  const refused = refusalOf(run);
  assert.equal(refused.error.code, "up-preflight-dirty-protected");
  assert.equal(refused.preflight.log_touched, false);
  assert.equal(head(repo.dir), before);
  assert.equal(readFileSync(join(repo.dir, "README.md"), "utf8"), "# mine\n");
});

test("preflight: the human refusal is a runbook, and never says reset --hard", () => {
  const repo = newRepo();
  upstreamCommit(repo, LOG_RELATIVE, '{"seq":1,"type":"note"}\n', "upstream log advance");
  writeFileSync(repo.logPath, '{"seq":1,"type":"mine"}\n', "utf8");

  const run = upOnce(repo, ["--root", fixtureRoot(false)]);
  assert.equal(run.code, 1, `${run.stdout}${run.stderr}`);
  assert.match(run.stderr, /up-preflight-log-diverged/u);
  assert.match(run.stderr, /YOUR STATE/u);
  assert.match(run.stderr, /NEXT STEPS/u);
  assert.match(run.stderr, /1\. approval log sync/u);
  assert.doesNotMatch(run.stderr, /reset --hard/u);
});

test("preflight: no refusal on any path prints reset --hard", () => {
  const repo = newRepo();
  writeFileSync(join(repo.dir, "local.txt"), "mine\n", "utf8");
  git(["add", "-A"], repo.dir);
  git(["commit", "-qm", "local work"], repo.dir);

  const run = upOnce(repo, ["--root", fixtureRoot(false)]);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /up-preflight-behind-ahead/u);
  assert.match(run.stderr, /git reset --keep origin\/main/u);
  assert.doesNotMatch(run.stderr, /reset --hard/u);
});

// ---------------------------------------------------------------------------
// Weather, opt-out, and the other spelling
// ---------------------------------------------------------------------------

test("preflight: a fetch that cannot reach the remote is a warning, and the runtime starts", () => {
  const repo = newRepo();
  rmSync(repo.remote, { recursive: true, force: true });

  const run = upOnce(repo, ["--json", "--root", fixtureRoot(false)]);
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  assert.match(run.stderr, /"preflight_warning"/u);
  const line = preflightLineOf(run);
  assert.equal(line.action, "fetch-failed");
  assert.deepEqual([line.behind_by, line.ahead_by], [0, 0]);
});

/**
 * A repository with no remote is not an unreachable remote. It is a repository
 * with no origin to be behind — the shape `--git-evidence` creates in the log
 * home, and any `git init` checkout — and a warning there would be about a
 * question nobody asked. So it skips, and a skip says nothing at all.
 */
test("preflight: a repository with no origin configured is silent, not a warning", () => {
  const repo = newRepo();
  assert.equal(git(["remote", "remove", "origin"], repo.dir).code, 0);

  const run = upOnce(repo, ["--json", "--root", fixtureRoot(false)]);
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  assert.doesNotMatch(run.stdout, /"preflight"/u);
  assert.doesNotMatch(run.stderr, /preflight_warning/u);
});

test("preflight: --no-preflight skips it entirely, even from a state that would refuse", () => {
  const repo = newRepo();
  writeFileSync(join(repo.dir, "local.txt"), "mine\n", "utf8");
  git(["add", "-A"], repo.dir);
  git(["commit", "-qm", "local work"], repo.dir);

  const run = upOnce(repo, ["--json", "--no-preflight", "--root", fixtureRoot(true)]);
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  assert.doesNotMatch(run.stdout, /"preflight"/u);
  assert.doesNotMatch(run.stderr, /up-preflight/u);
});

test("preflight: the --json line carries exactly the frozen fact set", () => {
  const repo = newRepo();
  upstreamCommit(repo, "README.md", "# fixture v2\n", "upstream edit");
  const run = upOnce(repo, ["--json", "--root", fixtureRoot(false)]);
  const raw = run.stdout
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((line) => line["event"] === "preflight");
  assert.ok(raw !== undefined);
  assert.deepEqual(Object.keys(raw).sort(), [
    "action",
    "ahead_by",
    "behind_by",
    "commit",
    "detail",
    "dist_stale",
    "event",
    "log_touched",
  ]);
});

test("preflight: approval daemon run shares it, and --no-preflight opts out there too", () => {
  const repo = newRepo();
  writeFileSync(join(repo.dir, "local.txt"), "mine\n", "utf8");
  git(["add", "-A"], repo.dir);
  git(["commit", "-qm", "local work"], repo.dir);

  const base = [
    "daemon",
    "run",
    "--once",
    "--json",
    "--log",
    repo.logPath,
    "--out",
    repo.queuePath,
    "--dir",
    repo.dir,
    "--tasks",
    join(repo.dir, "backlog", "tasks"),
    "--root",
    fixtureRoot(false),
  ];
  const refused = cli(base, repo.dir);
  assert.equal(refused.code, 1, `${refused.stdout}${refused.stderr}`);
  assert.equal(refusalOf(refused).error.code, "up-preflight-behind-ahead");

  const skipped = cli([...base, "--no-preflight"], repo.dir);
  assert.equal(skipped.code, 0, `${skipped.stdout}${skipped.stderr}`);
  assert.doesNotMatch(skipped.stdout, /"preflight"/u);
});

/**
 * SPEC.md §11.1 invariant 6 in its own small way: the union is frozen public
 * API and is pinned by a test, so a fourth code cannot appear without a line
 * changing here. These are not gate refusals and do not join one of §11.2's six
 * unions; they are this verb's, and they are distinct by repair.
 */
test("preflight: the refusal-code union is frozen", () => {
  assert.deepEqual(
    [...PREFLIGHT_REFUSAL_CODES],
    ["up-preflight-behind-ahead", "up-preflight-log-diverged", "up-preflight-dirty-protected"],
  );
});

// ---------------------------------------------------------------------------
// Doctor's row
// ---------------------------------------------------------------------------

interface DoctorRow {
  check: string;
  status: string;
  detail: string;
  fix?: string;
}

function doctorRow(repo: Repo, root: string): DoctorRow {
  const run = cli(
    ["doctor", "--json", "--log", repo.logPath, "--dir", repo.dir, "--root", root],
    repo.dir,
  );
  const parsed = JSON.parse(run.stdout.trim().split("\n").at(-1) as string) as {
    checks: DoctorRow[];
  };
  const row = parsed.checks.find((entry) => entry.check === "main-behind-origin");
  assert.ok(row !== undefined, `no main-behind-origin row in:\n${run.stdout}`);
  return row;
}

test("doctor: main-behind-origin reports behind-by and whether upstream touched the log", () => {
  const repo = newRepo();
  upstreamCommit(repo, LOG_RELATIVE, '{"seq":1,"type":"note"}\n', "upstream log advance");
  // Doctor makes no network call, so the remote-tracking ref is what it reads:
  // fetch by hand, exactly as an operator's last fetch would have.
  assert.equal(git(["fetch", "-q", "origin", "main:refs/remotes/origin/main"], repo.dir).code, 0);

  const row = doctorRow(repo, fixtureRoot(false));
  assert.equal(row.status, "pass");
  assert.match(row.detail, /1 commit behind origin\/main/u);
  assert.match(row.detail, /upstream DOES touch the working log/u);
  assert.ok(row.fix !== undefined && row.fix.startsWith("approval up"));
});

test("doctor: main-behind-origin fails with the same next command when the log diverged", () => {
  const repo = newRepo();
  upstreamCommit(repo, LOG_RELATIVE, '{"seq":1,"type":"note"}\n', "upstream log advance");
  assert.equal(git(["fetch", "-q", "origin", "main:refs/remotes/origin/main"], repo.dir).code, 0);
  writeFileSync(repo.logPath, '{"seq":1,"type":"mine"}\n', "utf8");

  const row = doctorRow(repo, fixtureRoot(false));
  assert.equal(row.status, "fail");
  assert.match(row.detail, /up-preflight-log-diverged/u);
  assert.equal(
    row.fix,
    "approval log sync — snapshot the working log, fast-forward, reconcile the chain",
  );
});

test("doctor: main-behind-origin skips outside a repository, and never fetches", () => {
  counter += 1;
  const plain = join(scratch, `plain-${String(counter)}`);
  mkdirSync(join(plain, ".approval", "log"), { recursive: true });
  writeFileSync(join(plain, ".approval", "log", "events.jsonl"), "", "utf8");
  writeFileSync(join(plain, "APPROVAL.md"), POLICY, "utf8");

  const run = cli(
    [
      "doctor",
      "--json",
      "--log",
      join(plain, LOG_RELATIVE),
      "--dir",
      plain,
      "--root",
      fixtureRoot(false),
    ],
    plain,
  );
  const parsed = JSON.parse(run.stdout.trim().split("\n").at(-1) as string) as {
    checks: DoctorRow[];
  };
  const row = parsed.checks.find((entry) => entry.check === "main-behind-origin");
  assert.ok(row !== undefined);
  assert.equal(row.status, "skip");
});
