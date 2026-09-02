/**
 * `approval log sync` and `approval log advance`, end to end (APRV-125).
 *
 * Every case builds a REAL git topology — a bare remote and one or two working
 * clones, driven with real `git` — because the whole subject of these verbs is
 * what git actually does to a file that another process is appending to. A fake
 * git would test the fake.
 *
 * Nothing here writes a log line by hand. Records are produced by
 * `core/attest.ts`'s `appendAttestation`, which is the real append path, and the
 * assertions that matter compare log BYTES before and against after: "the
 * working log is never rewound" is a claim about bytes, so it is tested as one.
 *
 * The snapshot-restore guarantee is tested per step rather than argued for.
 * `logSync` takes a `hooks.failBefore` seam — a parameter of the function, never
 * a CLI flag, so the shipped surface has no way to ask for a failure — and the
 * table below injects a failure at every step after the snapshot exists and
 * asserts the same three things each time: the refusal says `restored`, the
 * working log is byte-identical to what it was, and no snapshot file is left
 * behind.
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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { appendAttestation } from "../src/core/attest.js";
import { compareChains } from "../src/core/log-reconcile.js";
import { storePayload } from "../src/core/payload-store.js";
import { verify } from "../src/core/verify.js";
import { logAdvance } from "../src/cli/log-advance.js";
import { LOG_SYNC_STEPS, logSync, type LogSyncStep } from "../src/cli/log-sync.js";
import { POLICY } from "./scenario.js";

/** dist/tests/cli-log-verbs.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-log-verbs-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const LOG_RELATIVE = ".approval/log/events.jsonl";
const QUEUE_RELATIVE = ".approval/QUEUE.md";

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

function runCli(args: string[], cwd: string): Run {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], { cwd, encoding: "utf8" });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/**
 * The file every appended record attests, and the reason it is gitignored.
 *
 * A record has to come from the real append path, and the cheapest real append
 * is an attestation, which covers a FILE's bytes — so the bytes have to move
 * for each record to be a fact of its own. Doing that to a tracked file would
 * leave the working tree dirty in a way no real checkout is, and a dirty
 * tracked file blocks a fast-forward for reasons that have nothing to do with
 * the log. So the attested file is ignored by git, and the only tracked things
 * these fixtures ever dirty are the ones a case dirties on purpose.
 */
const MARKER_RELATIVE = ".approval/attest-marker.md";

function ensureMarker(dir: string): string {
  const path = join(dir, MARKER_RELATIVE);
  if (!existsSync(path)) {
    mkdirSync(join(dir, ".approval"), { recursive: true });
    writeFileSync(path, "# attested fixture\n", "utf8");
  }
  return path;
}

/** One appended record, through the real append path. Returns the new head seq. */
function appendRecord(dir: string, marker: string): number {
  const path = ensureMarker(dir);
  writeFileSync(path, `${readFileSync(path, "utf8")}\n<!-- ${marker} -->\n`, "utf8");
  const appended = appendAttestation(join(dir, LOG_RELATIVE), path, "human:tester");
  assert.equal(appended.ok, true, appended.ok ? "" : appended.error.message);
  if (!appended.ok) throw new Error("unreachable");
  return appended.record.seq;
}

/**
 * A module's CODE, with its comments removed.
 *
 * The prose in these modules names what was retired (`git stash`) and what they
 * do not call (`appendEvent`), so a grep over the raw source would fail on the
 * documentation rather than on the behaviour. What the assertions below are
 * about is what the code DOES.
 */
function codeOf(relative: string): string {
  return readFileSync(join(REPO_ROOT, relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/(^|[^:])\/\/.*$/gmu, "$1");
}

/** A working checkout with a log, a queue file, an origin, and one commit. */
interface Repo {
  dir: string;
  remote: string;
  logPath: string;
}

function newRepo(records = 2): Repo {
  counter += 1;
  const remote = join(scratch, `remote-${counter}.git`);
  const dir = join(scratch, `work-${counter}`);
  mkdirSync(join(dir, ".approval", "log"), { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  writeFileSync(join(dir, "README.md"), "# fixture\n", "utf8");
  writeFileSync(join(dir, QUEUE_RELATIVE), "# queue\n", "utf8");
  writeFileSync(join(dir, ".gitignore"), `${MARKER_RELATIVE}\n`, "utf8");

  for (let index = 0; index < records; index += 1) appendRecord(dir, `seed-${index}`);

  assert.equal(git(["init", "-q", "--bare", "-b", "main", remote], scratch).code, 0);
  assert.equal(git(["init", "-q", "-b", "main", "."], dir).code, 0);
  git(["config", "user.email", "test@example.invalid"], dir);
  git(["config", "user.name", "Test"], dir);
  assert.equal(git(["add", "-A"], dir).code, 0);
  assert.equal(git(["commit", "-qm", "seed"], dir).code, 0);
  assert.equal(git(["remote", "add", "origin", remote], dir).code, 0);
  assert.equal(git(["push", "-q", "-u", "origin", "main"], dir).code, 0);

  return { dir, remote, logPath: join(dir, LOG_RELATIVE) };
}

/** A second checkout of the same remote, for the cases that need two writers. */
function secondClone(repo: Repo): string {
  counter += 1;
  const dir = join(scratch, `peer-${counter}`);
  assert.equal(git(["clone", "-q", repo.remote, dir], scratch).code, 0);
  git(["config", "user.email", "test@example.invalid"], dir);
  git(["config", "user.name", "Test"], dir);
  return dir;
}

/** Commit and push everything in `dir`. */
function push(dir: string, message: string): void {
  assert.equal(git(["add", "-A"], dir).code, 0);
  assert.equal(git(["commit", "-qm", message], dir).code, 0);
  const pushed = git(["push", "-q", "origin", "main"], dir);
  assert.equal(pushed.code, 0, pushed.stderr);
}

function bytes(path: string): Buffer {
  return readFileSync(path);
}

/** The head of a log that must verify clean, or a failed assertion. */
function cleanHead(logPath: string): { seq: number; hash: string } | null {
  const result = verify(logPath);
  assert.equal(result.status, "clean");
  if (result.status !== "clean") throw new Error("unreachable");
  return result.head;
}

/** Every `*.sync-snapshot` left under `.approval/`, which should always be none. */
function snapshots(dir: string): string[] {
  const found: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".sync-snapshot")) found.push(path);
    }
  };
  walk(join(dir, ".approval"));
  return found;
}

// ===========================================================================
// AC 1 — the happy paths: byte-identical, or strictly extended, never rewound
// ===========================================================================

test("sync: a pull that does not touch the log leaves the working chain byte-identical", () => {
  const repo = newRepo();
  const peer = secondClone(repo);

  // The remote advances with a commit that has nothing to do with the log.
  writeFileSync(join(peer, "README.md"), "# fixture, edited elsewhere\n", "utf8");
  push(peer, "unrelated");

  // Meanwhile this checkout records two decisions, uncommitted.
  appendRecord(repo.dir, "local-1");
  const headSeq = appendRecord(repo.dir, "local-2");
  const before = bytes(repo.logPath);

  const result = logSync({ cwd: repo.dir });
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok) throw new Error("unreachable");

  assert.deepEqual(bytes(repo.logPath), before, "the working log was not byte-identical");
  assert.equal(result.report.relation, "ahead");
  assert.equal(result.report.restored, true);
  assert.equal(result.report.pulled, 1);
  assert.equal(result.report.headAfter?.seq, headSeq);
  // The verb appends nothing: the head it started with is the head it ended with.
  assert.equal(result.report.headBefore?.seq, headSeq);
  assert.equal(verify(repo.logPath).status, "clean");
  assert.deepEqual(snapshots(repo.dir), [], "a snapshot survived a successful sync");
  // The projection was REBUILT from the reconciled log, not restored from before.
  assert.ok(result.report.queue.bytes > 0);
  assert.ok(readFileSync(join(repo.dir, QUEUE_RELATIVE), "utf8").length > 0);
});

test("sync: a pull that extends the chain adopts the longer log and rewinds nothing", () => {
  const repo = newRepo();
  const peer = secondClone(repo);

  // The peer holds exactly this checkout's chain and appends onto it, which is
  // what a second machine that pulled first legitimately does.
  appendRecord(peer, "peer-1");
  appendRecord(peer, "peer-2");
  push(peer, "log advance from the peer");

  const before = bytes(repo.logPath);
  const result = logSync({ cwd: repo.dir });
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok) throw new Error("unreachable");

  assert.equal(result.report.relation, "behind");
  assert.equal(result.report.restored, false);
  assert.equal(result.report.behind, 2);
  const after = bytes(repo.logPath);
  assert.ok(
    after.subarray(0, before.length).equals(before),
    "the adopted chain does not start with the chain that was there: that is a rewind",
  );
  assert.ok(after.length > before.length, "the chain did not grow");
  assert.equal(verify(repo.logPath).status, "clean");
  assert.deepEqual(snapshots(repo.dir), []);
});

test("sync: an up-to-date checkout is a no-op that still verifies and rebuilds", () => {
  const repo = newRepo();
  const before = bytes(repo.logPath);

  const result = logSync({ cwd: repo.dir });
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok) throw new Error("unreachable");

  assert.equal(result.report.relation, "equal");
  assert.equal(result.report.pulled, 0);
  assert.deepEqual(bytes(repo.logPath), before);
  assert.deepEqual(snapshots(repo.dir), []);
});

// ===========================================================================
// AC 2 — divergence: named, refused, restored, never merged
// ===========================================================================

/**
 * Two checkouts that appended DIFFERENT records onto the same predecessor.
 *
 * The remote carries chain A+Y; this checkout's working file carries A+X and
 * its HEAD still carries A. That is precisely the state `log sync` walks into,
 * so the fixture stops there and lets the verb do the pull.
 */
function forked(): { repo: Repo; localSeq: number } {
  const repo = newRepo();
  const peer = secondClone(repo);

  appendRecord(peer, "the other chain");
  push(peer, "the other chain");

  const localSeq = appendRecord(repo.dir, "this chain");
  return { repo, localSeq };
}

/**
 * The same fork, one step further on: the pull has happened, so HEAD carries
 * A+Y while the working file carries A+X.
 *
 * Getting there by hand takes the move `log sync` makes for itself — set the
 * working file aside, let the fast-forward run over a clean path, put it back —
 * because git will not fast-forward over a modified tracked file. The bytes put
 * back are the bytes the real append path produced; nothing here composes a
 * record.
 */
function forkedAfterPull(): { repo: Repo; localSeq: number } {
  const { repo, localSeq } = forked();
  const mine = readFileSync(repo.logPath);
  const committed = git(["show", `HEAD:${LOG_RELATIVE}`], repo.dir).stdout;
  writeFileSync(repo.logPath, committed, "utf8");
  assert.equal(git(["fetch", "-q", "origin", "main"], repo.dir).code, 0);
  const merged = git(["merge", "-q", "--ff-only", "FETCH_HEAD"], repo.dir);
  assert.equal(merged.code, 0, merged.stderr);
  writeFileSync(repo.logPath, mine);
  return { repo, localSeq };
}

test("sync: a diverged committed log refuses log-diverged and restores the snapshot", () => {
  const { repo, localSeq } = forked();
  const before = bytes(repo.logPath);

  const result = logSync({ cwd: repo.dir });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");

  assert.equal(result.code, "log-diverged");
  assert.equal(result.step, "reconcile");
  assert.equal(result.restored, true);
  assert.equal(result.drift?.relation, "diverged");
  assert.equal(result.drift?.firstDivergentSeq, localSeq);

  // Both heads are named, in the machine message as well as in the drift.
  assert.ok(result.drift?.workingHead !== null && result.drift?.workingHead !== undefined);
  assert.ok(result.drift?.committedHead !== null && result.drift?.committedHead !== undefined);
  assert.match(result.message, new RegExp(`seq ${String(localSeq)}`, "u"));
  assert.match(result.message, /working head seq/u);
  assert.match(result.message, /committed head seq/u);
  assert.match(result.message, /nothing was re-chained/u);

  // Nothing was merged into the chain, and nothing was lost from it.
  assert.deepEqual(bytes(repo.logPath), before, "the working log was not restored exactly");
  assert.equal(verify(repo.logPath).status, "clean");
  assert.deepEqual(snapshots(repo.dir), [], "the snapshot outlived the refusal");
});

test("sync: the diverged refusal reaches the CLI as exit 1 with the code in --json", () => {
  const { repo, localSeq } = forked();
  const before = bytes(repo.logPath);

  const run = runCli(["log", "sync", "--json"], repo.dir);
  assert.equal(run.code, 1);
  const parsed = JSON.parse(run.stderr.trim()) as {
    ok: boolean;
    error: { code: string; message: string };
    restored: boolean;
    drift: { firstDivergentSeq: number };
  };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, "log-diverged");
  assert.equal(parsed.restored, true);
  assert.equal(parsed.drift.firstDivergentSeq, localSeq);
  assert.deepEqual(bytes(repo.logPath), before);
});

// ===========================================================================
// AC 3 — a failure at every step restores the snapshot
// ===========================================================================

/**
 * The steps that run once a snapshot exists. `primary`, `verify` and `snapshot`
 * are excluded because there is nothing to put back before the snapshot is
 * taken; they are covered by the refusal cases elsewhere in this file.
 */
const RESTORING_STEPS: readonly LogSyncStep[] = LOG_SYNC_STEPS.filter(
  (step) => !["primary", "verify", "snapshot"].includes(step),
);

test("the injected-failure table covers every step after the snapshot", () => {
  // A guard on the guard: a step added to the ceremony without a case here
  // would leave one restore path untested, which is the property this whole
  // section exists to establish.
  assert.deepEqual(
    [...RESTORING_STEPS],
    [
      "baseline",
      "fetch",
      "ff-check",
      "payloads",
      "merge",
      "reconcile",
      "projections",
      "post-verify",
    ],
  );
});

for (const step of RESTORING_STEPS) {
  test(`sync: a failure before ${step} restores the working log exactly`, () => {
    const repo = newRepo();
    const peer = secondClone(repo);
    writeFileSync(join(peer, "README.md"), "# moved on\n", "utf8");
    push(peer, "unrelated");

    appendRecord(repo.dir, `local-before-${step}`);
    const before = bytes(repo.logPath);
    const queueBefore = bytes(join(repo.dir, QUEUE_RELATIVE));

    const result = logSync({ cwd: repo.dir, hooks: { failBefore: step } });
    assert.equal(result.ok, false, `the injected failure at ${step} did not refuse`);
    if (result.ok) throw new Error("unreachable");

    assert.equal(result.step, step);
    assert.equal(result.restored, true, `the snapshot was not restored at ${step}`);
    assert.deepEqual(
      bytes(repo.logPath),
      before,
      `the working log is not what it was before the sync (failure at ${step})`,
    );
    assert.deepEqual(
      bytes(join(repo.dir, QUEUE_RELATIVE)),
      queueBefore,
      `the queue projection was not restored (failure at ${step})`,
    );
    assert.equal(verify(repo.logPath).status, "clean");
    assert.deepEqual(
      snapshots(repo.dir),
      [],
      `a snapshot was left behind after a restored failure at ${step}`,
    );
  });
}

// ===========================================================================
// APRV-225 — untracked payload files in the fast-forward's way
// ===========================================================================

/**
 * The store directory of a checkout, and the file one payload lands in.
 *
 * Every payload below is written through `storePayload`, the real store write,
 * so the filename is a real content address over the real canonical bytes. A
 * hand-written `<name>.json` would be testing a fixture's spelling of the store
 * rather than the store.
 */
function storeDirOf(dir: string): string {
  return join(dir, ".approval", "payloads");
}

function putPayload(dir: string, value: unknown): { hash: string; relative: string } {
  const stored = storePayload(storeDirOf(dir), value);
  assert.equal(stored.ok, true, stored.ok ? "" : stored.message);
  if (!stored.ok) throw new Error("unreachable");
  return { hash: stored.hash, relative: `.approval/payloads/${stored.hash}.json` };
}

test("sync: an untracked payload the incoming commit also carries is reconciled, not refused", () => {
  const repo = newRepo();
  const peer = secondClone(repo);

  // The advance that merged carries the payload. This checkout independently
  // holds the same bytes, untracked — which is the 2026-09-02 state exactly:
  // content addressing makes the two copies identical by construction.
  const payload = { to: "+15550100", body: "ship it" };
  const { relative } = putPayload(peer, payload);
  push(peer, "records advance carrying a payload");
  const mine = putPayload(repo.dir, payload);
  assert.equal(mine.relative, relative, "content addressing did not agree across the two checkouts");

  const localBytes = bytes(join(repo.dir, relative));
  const logBefore = bytes(repo.logPath);

  // Before the fix this is where `git merge --ff-only` refused, and the verb
  // reported log-sync-git-failed.
  const result = logSync({ cwd: repo.dir });
  assert.equal(result.ok, true, result.ok ? "" : `${result.code}: ${result.message}`);
  if (!result.ok) throw new Error("unreachable");

  assert.equal(result.report.payloadsReconciled, 1);
  assert.equal(result.report.pulled, 1);
  // The bytes survived the round trip, and they are now the committed ones.
  assert.deepEqual(bytes(join(repo.dir, relative)), localBytes);
  assert.equal(git(["status", "--porcelain", "--", relative], repo.dir).stdout.trim(), "");
  // The log is the log: this verb reconciles payload FILES and nothing else.
  assert.deepEqual(bytes(repo.logPath), logBefore);
  assert.equal(result.report.headBefore?.seq, result.report.headAfter?.seq);
  assert.equal(verify(repo.logPath).status, "clean");
  assert.deepEqual(snapshots(repo.dir), []);
});

test("sync: a payload whose bytes disagree with the incoming commit refuses and touches nothing", () => {
  const repo = newRepo();
  const peer = secondClone(repo);

  const { relative } = putPayload(peer, { to: "+15550100", body: "ship it" });
  push(peer, "records advance carrying a payload");

  // The same NAME, different bytes: the local file is not the material the
  // incoming commit says that hash addresses.
  mkdirSync(storeDirOf(repo.dir), { recursive: true });
  const local = join(repo.dir, relative);
  writeFileSync(local, '{"body":"ship something else","to":"+15550199"}', "utf8");

  const localBytes = bytes(local);
  const logBefore = bytes(repo.logPath);
  const headBefore = git(["rev-parse", "HEAD"], repo.dir).stdout.trim();

  const result = logSync({ cwd: repo.dir });
  assert.equal(result.ok, false, "a payload that disagrees was accepted");
  if (result.ok) throw new Error("unreachable");

  assert.equal(result.code, "log-sync-payload-mismatch");
  assert.equal(result.step, "payloads");
  assert.equal(result.restored, true);
  assert.ok(result.message.includes(relative), "the refusal does not name the file");

  // Nothing was merged, nothing was appended, nothing was deleted.
  assert.equal(git(["rev-parse", "HEAD"], repo.dir).stdout.trim(), headBefore);
  assert.deepEqual(bytes(local), localBytes, "the disagreeing payload was overwritten or removed");
  assert.deepEqual(bytes(repo.logPath), logBefore);
  assert.equal(verify(repo.logPath).status, "clean");
  assert.deepEqual(snapshots(repo.dir), []);
});

test("sync: an untracked payload the incoming commit does not carry is left alone", () => {
  const repo = newRepo();
  const peer = secondClone(repo);
  writeFileSync(join(peer, "README.md"), "# moved on without payloads\n", "utf8");
  push(peer, "unrelated");

  // A payload this checkout recorded and has not advanced yet. It blocks no
  // fast-forward, so sync has no business in it.
  const { relative } = putPayload(repo.dir, { to: "+15550100", body: "not advanced yet" });
  const localBytes = bytes(join(repo.dir, relative));

  const result = logSync({ cwd: repo.dir });
  assert.equal(result.ok, true, result.ok ? "" : `${result.code}: ${result.message}`);
  if (!result.ok) throw new Error("unreachable");

  assert.equal(result.report.payloadsReconciled, 0);
  assert.deepEqual(bytes(join(repo.dir, relative)), localBytes);
  // Still untracked, exactly as it was found.
  assert.match(git(["status", "--porcelain", "--", relative], repo.dir).stdout, /\?\?/u);
  assert.deepEqual(snapshots(repo.dir), []);
});

test("sync: a file in the payload store that is not named by a hash is refused, not cleared", () => {
  const repo = newRepo();
  const peer = secondClone(repo);

  // The incoming commit carries it, so it WILL block the fast-forward — but the
  // store is addressed by hash and nothing else, so sync has no way to prove
  // this file is what the incoming commit holds, and says so instead of guessing.
  mkdirSync(storeDirOf(peer), { recursive: true });
  writeFileSync(join(storeDirOf(peer), "notes.json"), '{"a":1}', "utf8");
  push(peer, "something that is not a payload");

  mkdirSync(storeDirOf(repo.dir), { recursive: true });
  const local = join(repo.dir, ".approval", "payloads", "notes.json");
  writeFileSync(local, '{"a":1}', "utf8");

  const result = logSync({ cwd: repo.dir });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.code, "log-sync-payload-mismatch");
  assert.ok(result.message.includes("notes.json"));
  assert.equal(existsSync(local), true, "a file sync could not vouch for was removed anyway");
});

test("sync: --json reports the payload count", () => {
  const repo = newRepo();
  const peer = secondClone(repo);
  const payload = { to: "+15550100", body: "ship it" };
  putPayload(peer, payload);
  push(peer, "records advance carrying a payload");
  putPayload(repo.dir, payload);

  const run = runCli(["log", "sync", "--json"], repo.dir);
  assert.equal(run.code, 0, run.stderr);
  const parsed = JSON.parse(run.stdout) as { ok: boolean; payloads: { reconciled: number } };
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.payloads, { reconciled: 1 });
});

// ===========================================================================
// AC 4 — git stash appears nowhere
// ===========================================================================

/** Every module that implements the ritual. Comments excluded by `codeOf`. */
const RITUAL_MODULES = [
  "src/cli/log-sync.ts",
  "src/cli/log-advance.ts",
  "src/cli/log-verbs.ts",
  "src/cli/git-scope.ts",
  "src/core/log-reconcile.ts",
] as const;

test("no implementation of the log ritual reaches for git stash", () => {
  for (const relative of RITUAL_MODULES) {
    assert.equal(
      /stash/iu.test(codeOf(relative)),
      false,
      `${relative} routes the log through git state mutation; the log is snapshotted, never stashed`,
    );
  }
});

// ===========================================================================
// AC 5 — advance stages exactly three paths, names the range, pushes a branch
// ===========================================================================

/** The paths a commit carries, sorted. */
function committedPaths(dir: string, rev = "HEAD"): string[] {
  return git(["show", "--name-only", "--pretty=format:", rev], dir)
    .stdout.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();
}

test("advance: carries exactly the three paths, names the seq range, pushes a records branch", () => {
  const repo = newRepo();
  const from = appendRecord(repo.dir, "advance-1");
  const to = appendRecord(repo.dir, "advance-2");
  const logBefore = bytes(repo.logPath);
  const branchBefore = git(["rev-parse", "--abbrev-ref", "HEAD"], repo.dir).stdout.trim();
  const headBefore = git(["rev-parse", "HEAD"], repo.dir).stdout.trim();

  // The other two allowed paths, both changed, so all three ride the commit.
  writeFileSync(join(repo.dir, QUEUE_RELATIVE), "# queue, regenerated\n", "utf8");
  mkdirSync(join(repo.dir, ".approval", "payloads"), { recursive: true });
  writeFileSync(join(repo.dir, ".approval", "payloads", "abc.json"), "{}\n", "utf8");

  // A change to a path an advance may NOT carry, left unstaged: it must survive
  // untouched rather than riding along.
  writeFileSync(join(repo.dir, "README.md"), "# not part of an advance\n", "utf8");

  const result = logAdvance({ cwd: repo.dir, branch: "records-log-test", today: "2026-08-26" });
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok) throw new Error("unreachable");

  assert.deepEqual(result.report.range, { from, to });
  assert.match(result.report.message, new RegExp(`seq ${String(from)}\\.\\.${String(to)}`, "u"));
  assert.equal(result.report.pushed, true);

  const commit = String(result.report.commit);
  assert.deepEqual(
    committedPaths(repo.dir, commit),
    [LOG_RELATIVE, QUEUE_RELATIVE, ".approval/payloads/abc.json"].sort(),
  );
  assert.equal(
    git(["log", "-1", "--pretty=%s", commit], repo.dir).stdout.trim(),
    result.report.message,
  );

  // It checked nothing out, it moved no branch, and it appended nothing.
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], repo.dir).stdout.trim(), branchBefore);
  assert.equal(git(["rev-parse", "HEAD"], repo.dir).stdout.trim(), headBefore);
  assert.deepEqual(bytes(repo.logPath), logBefore);

  // The commit is on the records branch of the remote, and only there.
  const onRemote = git(["rev-parse", "--verify", "--quiet", "records-log-test"], repo.remote);
  assert.equal(onRemote.stdout.trim(), result.report.commit);
  const remoteMain = git(["rev-parse", "--verify", "--quiet", "main"], repo.remote).stdout.trim();
  assert.notEqual(remoteMain, result.report.commit, "the advance reached main directly");

  // README.md was never staged, so it is still a working-tree change.
  assert.match(git(["status", "--porcelain", "--", "README.md"], repo.dir).stdout, /README\.md/u);
});

test("advance: the default records branch carries the date", () => {
  const repo = newRepo();
  appendRecord(repo.dir, "dated");
  const result = logAdvance({ cwd: repo.dir, today: "2026-08-26T09:15:00.000Z" });
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.report.recordsBranch, "records-log-2026-08-26");
});

test("advance: any other staged path refuses log-advance-dirty-stage and commits nothing", () => {
  const repo = newRepo();
  appendRecord(repo.dir, "advance-dirty");
  const commitsBefore = git(["rev-list", "--count", "HEAD"], repo.dir).stdout.trim();

  writeFileSync(join(repo.dir, "README.md"), "# staged by someone else\n", "utf8");
  assert.equal(git(["add", "README.md"], repo.dir).code, 0);

  const result = logAdvance({ cwd: repo.dir });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");

  assert.equal(result.code, "log-advance-dirty-stage");
  assert.deepEqual(result.offending, ["README.md"]);
  assert.match(result.message, /will not unstage anyone's work/u);
  assert.equal(git(["rev-list", "--count", "HEAD"], repo.dir).stdout.trim(), commitsBefore);
  // The other party's staged file is still staged: nothing was unstaged for them.
  assert.match(git(["diff", "--cached", "--name-only"], repo.dir).stdout, /README\.md/u);
});

test("advance: a records branch named main is refused rather than pushed at the trunk", () => {
  const repo = newRepo();
  appendRecord(repo.dir, "advance-main");
  const result = logAdvance({ cwd: repo.dir, branch: "main" });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.code, "log-advance-checkout-required");
  assert.match(result.message, /pull request/u);
});

test("advance: nothing owed is a success that commits nothing", () => {
  const repo = newRepo();
  const commitsBefore = git(["rev-list", "--count", "HEAD"], repo.dir).stdout.trim();
  const result = logAdvance({ cwd: repo.dir });
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.report.range, null);
  assert.equal(result.report.commit, null);
  assert.equal(git(["rev-list", "--count", "HEAD"], repo.dir).stdout.trim(), commitsBefore);
});

test("advance: --dry-run reports the range and writes nothing", () => {
  const repo = newRepo();
  appendRecord(repo.dir, "advance-dry");
  const commitsBefore = git(["rev-list", "--count", "HEAD"], repo.dir).stdout.trim();

  const run = runCli(["log", "advance", "--dry-run", "--json"], repo.dir);
  assert.equal(run.code, 0, run.stderr);
  const parsed = JSON.parse(run.stdout.trim()) as {
    ok: boolean;
    dryRun: boolean;
    commit: string | null;
    range: { from: number; to: number };
  };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.commit, null);
  assert.equal(git(["rev-list", "--count", "HEAD"], repo.dir).stdout.trim(), commitsBefore);
});

test("advance: a diverged chain is never advanced (APRV-203: measured against origin)", () => {
  // `forked` leaves the REMOTE carrying the other chain and this checkout's
  // working log carrying ours, which is the state the fetch now walks into: no
  // local pull is needed for the verb to see the fork.
  const { repo } = forked();
  const commitsBefore = git(["rev-list", "--count", "HEAD"], repo.dir).stdout.trim();

  const result = logAdvance({ cwd: repo.dir });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.code, "log-advance-remote-diverged");
  assert.match(result.message, /part at seq/u);
  assert.match(result.message, /nothing was committed/u);
  assert.equal(git(["rev-list", "--count", "HEAD"], repo.dir).stdout.trim(), commitsBefore);
});

test("advance: a working log BEHIND origin's is refused, not published", () => {
  // The peer advanced the log and pushed; this checkout never synced. An
  // advance from here would propose a shorter chain than the remote already has.
  const repo = newRepo();
  const peer = secondClone(repo);
  appendRecord(peer, "records this checkout has not seen");
  push(peer, "peer advance");

  const commitsBefore = git(["rev-list", "--count", "HEAD"], repo.dir).stdout.trim();
  const result = logAdvance({ cwd: repo.dir });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.code, "log-advance-behind-remote");
  assert.match(result.message, /approval log sync/u);
  assert.equal(git(["rev-list", "--count", "HEAD"], repo.dir).stdout.trim(), commitsBefore);
});

test("advance: a remote that cannot be fetched refuses with its own code", () => {
  const repo = newRepo();
  appendRecord(repo.dir, "unreachable remote");
  assert.equal(git(["remote", "set-url", "origin", join(scratch, "no-such-remote.git")], repo.dir).code, 0);

  const result = logAdvance({ cwd: repo.dir });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.code, "log-advance-fetch-failed");
  assert.match(result.message, /Nothing was committed/u);
});

test("advance: a local main BEHIND and DIVERGED from origin still bases on origin (APRV-203)", () => {
  // The failure this test exists for: the verb used to commit on the local
  // branch, so a checkout whose main was behind produced a records commit whose
  // parent was a stale tip and whose tree reverted everything origin had merged.
  const repo = newRepo();
  const peer = secondClone(repo);
  writeFileSync(join(peer, "UPSTREAM.md"), "# merged upstream while you were away\n", "utf8");
  push(peer, "upstream work");
  const originTip = git(["rev-parse", "main"], repo.remote).stdout.trim();

  // And this checkout has a commit of its own that origin does not have, so the
  // two have genuinely diverged. It is NOT a refusal: the advance is based on
  // origin either way, and this commit is simply not part of it.
  writeFileSync(join(repo.dir, "LOCAL.md"), "# local, unpushed\n", "utf8");
  assert.equal(git(["add", "LOCAL.md"], repo.dir).code, 0);
  assert.equal(git(["commit", "-qm", "local only"], repo.dir).code, 0);

  const from = appendRecord(repo.dir, "advance-over-stale-main");
  const headBefore = git(["rev-parse", "HEAD"], repo.dir).stdout.trim();
  const branchBefore = git(["rev-parse", "--abbrev-ref", "HEAD"], repo.dir).stdout.trim();
  const statusBefore = git(["status", "--porcelain"], repo.dir).stdout;
  const logBefore = bytes(repo.logPath);

  const result = logAdvance({ cwd: repo.dir, branch: "records-log-stale", today: "2026-09-01" });
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok) throw new Error("unreachable");
  assert.deepEqual(result.report.range, { from, to: from });
  assert.deepEqual(result.report.base, { branch: "main", sha: originTip });

  // The parent is origin's tip, and the commit carries origin's work.
  const commit = result.report.commit;
  assert.notEqual(commit, null);
  assert.equal(git(["rev-parse", `${String(commit)}^`], repo.dir).stdout.trim(), originTip);
  assert.match(
    git(["show", `${String(commit)}:UPSTREAM.md`], repo.dir).stdout,
    /merged upstream/u,
    "the records commit reverted work that was already on origin",
  );
  // The local-only commit is NOT in it: an advance publishes records, not work.
  assert.equal(git(["cat-file", "-e", `${String(commit)}:LOCAL.md`], repo.dir).code === 0, false);
  // Only the log actually changed, so only the log is in the diff.
  assert.deepEqual(committedPaths(repo.dir, String(commit)), [LOG_RELATIVE]);

  // The checkout is exactly as it was found.
  assert.equal(git(["rev-parse", "HEAD"], repo.dir).stdout.trim(), headBefore);
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], repo.dir).stdout.trim(), branchBefore);
  assert.equal(git(["status", "--porcelain"], repo.dir).stdout, statusBefore);
  assert.deepEqual(bytes(repo.logPath), logBefore);
  assert.equal(git(["diff", "--cached", "--name-only"], repo.dir).stdout.trim(), "");

  // And the commit is on the records branch of the remote, and only there.
  assert.equal(
    git(["rev-parse", "--verify", "--quiet", "records-log-stale"], repo.remote).stdout.trim(),
    commit,
  );
});

// ===========================================================================
// AC 6 — both verbs refuse outside the primary checkout
// ===========================================================================

test("both verbs refuse in a linked worktree, each with its own code", () => {
  const repo = newRepo();
  const worktree = join(scratch, `worktree-${(counter += 1)}`);
  const added = git(["worktree", "add", "-q", "-b", "side", worktree], repo.dir);
  assert.equal(added.code, 0, added.stderr);
  const before = bytes(repo.logPath);

  const synced = logSync({ cwd: worktree });
  assert.equal(synced.ok, false);
  if (synced.ok) throw new Error("unreachable");
  assert.equal(synced.code, "log-sync-not-primary");
  assert.match(synced.message, /PRIMARY checkout only/u);
  assert.match(synced.message, new RegExp(repo.dir.split("/").pop() ?? "work", "u"));

  const advanced = logAdvance({ cwd: worktree });
  assert.equal(advanced.ok, false);
  if (advanced.ok) throw new Error("unreachable");
  assert.equal(advanced.code, "log-advance-not-primary");

  // The two codes are distinct, and neither verb touched the primary's log.
  assert.notEqual(synced.code, advanced.code);
  assert.deepEqual(bytes(repo.logPath), before);
  assert.deepEqual(snapshots(repo.dir), []);
});

// ===========================================================================
// AC 8 — doctor's log-drift shares sync's reconcile
// ===========================================================================

test("doctor: log-drift names the same seq sync's reconcile does", () => {
  const { repo, localSeq } = forkedAfterPull();

  const run = runCli(["doctor", "--json"], repo.dir);
  const parsed = JSON.parse(run.stdout.trim()) as {
    checks: Array<{ check: string; status: string; detail: string }>;
  };
  const drift = parsed.checks.find((entry) => entry.check === "log-drift");
  assert.ok(drift !== undefined, "doctor has no log-drift check");
  assert.equal(drift.status, "fail");
  assert.match(drift.detail, new RegExp(`DIVERGED at seq ${String(localSeq)}`, "u"));

  // The same comparison, called directly, agrees — which is the point of the
  // shared implementation rather than a second one that looks similar.
  const direct = compareChains(
    { label: "working", text: readFileSync(repo.logPath, "utf8") },
    {
      label: "committed",
      text: git(["show", `HEAD:${LOG_RELATIVE}`], repo.dir).stdout,
    },
  );
  assert.equal(direct.ok, true);
  if (!direct.ok) throw new Error("unreachable");
  assert.equal(direct.drift.firstDivergentSeq, localSeq);
});

test("doctor: log-drift reports ahead-by-N on an ordinary working checkout", () => {
  const repo = newRepo();
  appendRecord(repo.dir, "drift-1");
  appendRecord(repo.dir, "drift-2");

  const run = runCli(["doctor", "--json"], repo.dir);
  const parsed = JSON.parse(run.stdout.trim()) as {
    checks: Array<{ check: string; status: string; detail: string; fix?: string }>;
  };
  const drift = parsed.checks.find((entry) => entry.check === "log-drift");
  assert.ok(drift !== undefined);
  assert.equal(drift.status, "pass");
  assert.match(drift.detail, /ahead by 2/u);
  assert.match(drift.fix ?? "", /^approval log advance\b/u);
});

test("both the doctor check and the sync reconcile read one implementation", () => {
  // The structural half of the claim: a second copy of the comparison could
  // agree with the first today and drift from it tomorrow, so what is pinned is
  // that there is only one.
  for (const relative of ["src/cli/doctor.ts", "src/cli/log-sync.ts"]) {
    const source = readFileSync(join(REPO_ROOT, relative), "utf8");
    assert.match(
      source,
      /import \{[^}]*compareChains[^}]*\} from "\.\.\/core\/log-reconcile\.js"/u,
      `${relative} does not read the shared chain comparison`,
    );
  }
});

// ===========================================================================
// Neither verb appends an event
// ===========================================================================

test("neither verb appends an event, and neither calls the append path", () => {
  const repo = newRepo();
  appendRecord(repo.dir, "no-event-1");
  const headBefore = cleanHead(repo.logPath);

  assert.equal(logSync({ cwd: repo.dir }).ok, true);
  assert.equal(logAdvance({ cwd: repo.dir, branch: "records-log-noevent" }).ok, true);

  assert.deepEqual(cleanHead(repo.logPath), headBefore, "a log verb appended a record");

  // Structural, so a future edit cannot quietly add one: neither module names
  // an append anywhere in its code. `withAppendLock` is exclusion, not a write.
  for (const relative of ["src/cli/log-sync.ts", "src/cli/log-advance.ts"]) {
    assert.equal(
      /\bappendEvent\b|\bappendAttestation\b/u.test(codeOf(relative)),
      false,
      `${relative} reaches for an append path; these verbs record nothing`,
    );
  }
});

// ===========================================================================
// Preconditions that refuse before the snapshot exists
// ===========================================================================

test("sync: a torn tail is refused before anything is touched", () => {
  const repo = newRepo();
  // A crashed write, produced the only honest way: bytes that stop mid-line.
  const torn = `${readFileSync(repo.logPath, "utf8")}{"seq":99,"partial"`;
  writeFileSync(repo.logPath, torn, "utf8");
  const before = bytes(repo.logPath);

  const result = logSync({ cwd: repo.dir });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.code, "log-sync-unverified");
  assert.equal(result.step, "verify");
  assert.deepEqual(bytes(repo.logPath), before);
  assert.deepEqual(snapshots(repo.dir), []);
});

test("sync: a non-fast-forward remote is named and refused, not merged", () => {
  const repo = newRepo();
  const peer = secondClone(repo);
  writeFileSync(join(peer, "README.md"), "# theirs\n", "utf8");
  push(peer, "theirs");

  // This checkout commits something of its own, so neither side is an ancestor.
  writeFileSync(join(repo.dir, "README.md"), "# mine\n", "utf8");
  assert.equal(git(["commit", "-qam", "mine"], repo.dir).code, 0);
  const before = bytes(repo.logPath);

  const result = logSync({ cwd: repo.dir });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.code, "log-sync-not-fast-forward");
  assert.match(result.message, /chains do not merge/u);
  assert.deepEqual(bytes(repo.logPath), before);
  assert.deepEqual(snapshots(repo.dir), []);
  // No merge commit was created.
  assert.equal(git(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], repo.dir).stdout.trim(), "");
});

test("sync: the CLI surface reports a clean sync on stdout at exit 0", () => {
  const repo = newRepo();
  appendRecord(repo.dir, "cli-surface");
  const run = runCli(["log", "sync", "--json"], repo.dir);
  assert.equal(run.code, 0, run.stderr);
  const parsed = JSON.parse(run.stdout.trim()) as { ok: boolean; relation: string; index: string };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.relation, "ahead");
  assert.equal(parsed.index, "absent");
  assert.equal(existsSync(join(repo.dir, ".approval", "index.sqlite")), false);
});
