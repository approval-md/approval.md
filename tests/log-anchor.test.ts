/**
 * Log anchoring verification (APRV-219), and the two doctor rows APRV-210
 * recorded misreading the checkout.
 *
 * Every case builds a REAL git topology — a bare remote and one or two working
 * clones, driven with real `git` — for the reason `tests/cli-log-verbs.test.ts`
 * does: the whole subject is what git actually holds and what a working file
 * actually says, and a fake git would test the fake.
 *
 * Nothing here writes a log line by hand. Records come from `core/attest.ts`'s
 * `appendAttestation`, which is the real append path. The one case that has to
 * produce a forged chain produces it the way a forger would: it truncates the
 * file and re-appends different records through the same real path, so what the
 * anchor check is shown is a log that walks clean from genesis and disagrees
 * with the copy somebody else already holds.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { appendAttestation } from "../src/core/attest.js";
import { APPEND_ERROR_CODES } from "../src/core/log.js";
import { GATE_REFUSAL_CODES } from "../src/core/gate.js";
import { verify, verifyWithRecords } from "../src/core/verify.js";
import {
  ANCHOR_REFUSAL_CODES,
  anchorRevs,
  checkLogAnchor,
  forgetAnchorBlobs,
  resolveAnchor,
} from "../src/cli/log-anchor.js";
import { publishedState } from "../src/cli/log-advance.js";
import { GIT_OUTPUT_LIMIT_BYTES, repoRoot } from "../src/cli/git-scope.js";
import { Daemon, type DaemonEvent } from "../src/daemon/daemon.js";
import { POLICY } from "./scenario.js";

/** dist/tests/log-anchor.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-anchor-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const LOG_RELATIVE = ".approval/log/events.jsonl";
const QUEUE_RELATIVE = ".approval/QUEUE.md";
const MARKER_RELATIVE = ".approval/attest-marker.md";

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function git(args: string[], cwd: string): Run {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    // The same ceiling the runtime raised, for the same reason and with the
    // same lesson: this helper ran `git show HEAD:<log>` on every fixture and
    // would have started answering `code: -1` the moment a fixture's log
    // crossed a megabyte. A harness that cannot read what it is asserting
    // about reports failures it cannot explain.
    maxBuffer: GIT_OUTPUT_LIMIT_BYTES,
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

/** One appended record, through the real append path. Returns the new head seq. */
function appendRecord(dir: string, marker: string): number {
  const path = join(dir, MARKER_RELATIVE);
  if (!existsSync(path)) {
    mkdirSync(join(dir, ".approval"), { recursive: true });
    writeFileSync(path, "# attested fixture\n", "utf8");
  }
  writeFileSync(path, `${readFileSync(path, "utf8")}\n<!-- ${marker} -->\n`, "utf8");
  const appended = appendAttestation(join(dir, LOG_RELATIVE), path, "human:tester");
  assert.equal(appended.ok, true, appended.ok ? "" : appended.error.message);
  if (!appended.ok) throw new Error("unreachable");
  return appended.record.seq;
}

interface Repo {
  dir: string;
  remote: string;
  logPath: string;
}

/** A working checkout with a log, an origin, and one commit carrying the log. */
function newRepo(records = 2): Repo {
  counter += 1;
  // The blob cache is content-addressed and therefore safe to share, but each
  // case is a new repository and a stale entry would hide a resolution bug
  // rather than a comparison bug. Cheaper to start clean.
  forgetAnchorBlobs();
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

/** The verified working records, which is what the check is always handed. */
function records(logPath: string): ReturnType<typeof verifyWithRecords>["records"] {
  const walked = verifyWithRecords(logPath);
  assert.equal(walked.result.status, "clean", JSON.stringify(walked.result));
  return walked.records;
}

/** The check, run the way every caller runs it: on already-verified records. */
function check(repo: Repo, options: { rev?: string } = {}): ReturnType<typeof checkLogAnchor> {
  return checkLogAnchor({
    logPath: repo.logPath,
    records: records(repo.logPath),
    ...(options.rev === undefined ? {} : { rev: options.rev }),
  });
}

/**
 * Truncate the log to `keep` records and re-append different ones.
 *
 * This is the forgery the whole module exists for, and it is built with the
 * real append path rather than by hand: the result is a file that walks clean
 * from genesis (the chain is unkeyed, so recomputing it is free) and carries
 * different records from seq `keep + 1` on than the committed copy does.
 */
function forge(repo: Repo, keep: number, marker: string): void {
  const lines = readFileSync(repo.logPath, "utf8").split("\n").filter((line) => line.length > 0);
  writeFileSync(repo.logPath, `${lines.slice(0, keep).join("\n")}\n`, "utf8");
  assert.equal(verify(repo.logPath).status, "clean");
  appendRecord(repo.dir, marker);
  assert.equal(verify(repo.logPath).status, "clean", "a forged chain must still walk clean");
  forgetAnchorBlobs();
}

// ===========================================================================
// The refusal union (SPEC.md §11.1 invariant 6)
// ===========================================================================

test("the anchor refusal union is frozen public API, in definition order", () => {
  // Pinned here for the reason every other union in this runtime is pinned in
  // its own suite: a caller branches on these strings, so adding, removing or
  // renaming one is a breaking change and has to show up as a diff. The
  // conformance suite pins the same array under `anchor_refusal_codes`.
  assert.deepEqual([...ANCHOR_REFUSAL_CODES], ["anchor-diverged"]);
  // And it is distinct from every other union: a caller that saw this code
  // where a gate or append code was expected would branch on a stranger.
  for (const code of ANCHOR_REFUSAL_CODES) {
    assert.equal((GATE_REFUSAL_CODES as readonly string[]).includes(code), false, code);
    assert.equal((APPEND_ERROR_CODES as readonly string[]).includes(code), false, code);
  }
});

// ===========================================================================
// AC 1 — the comparison itself
// ===========================================================================

test("anchor: a working log that carries the committed prefix passes, and names the rev", () => {
  const repo = newRepo();
  appendRecord(repo.dir, "ahead-1");
  appendRecord(repo.dir, "ahead-2");

  const outcome = check(repo);
  assert.equal(outcome.status, "pass", JSON.stringify(outcome));
  if (outcome.status !== "pass") throw new Error("unreachable");
  assert.equal(outcome.ahead, 2);
  assert.equal(outcome.anchor.head.seq, 2);
  assert.match(outcome.anchor.rev, /origin\/main|HEAD/u);
  // The anchor's byte length is the committed file's, and the working file is
  // strictly longer: the prefix is what was compared, not the whole file.
  assert.ok(outcome.workingBytes > outcome.anchor.byteLength);
});

test("anchor: an untouched checkout is byte-identical to its committed copy", () => {
  const repo = newRepo();
  const outcome = check(repo);
  assert.equal(outcome.status, "pass", JSON.stringify(outcome));
  if (outcome.status !== "pass") throw new Error("unreachable");
  assert.equal(outcome.ahead, 0);
  assert.equal(outcome.workingBytes, outcome.anchor.byteLength);
  assert.match(outcome.detail, /byte-identical/u);
});

test("anchor: a truncated-and-recomputed chain is refused as anchor-diverged", () => {
  const repo = newRepo(3);
  // The committed copy carries seq 1..3. The forger drops seq 3 and writes a
  // different record in its place, then recomputes the chain.
  forge(repo, 2, "the record the committed copy has never seen");
  // The forgery is invisible to the chain walk, which is the premise.
  assert.equal(verify(repo.logPath).status, "clean");

  const outcome = check(repo);
  assert.equal(outcome.status, "diverged", JSON.stringify(outcome));
  if (outcome.status !== "diverged") throw new Error("unreachable");
  assert.equal(outcome.code, "anchor-diverged");
  assert.ok((ANCHOR_REFUSAL_CODES as readonly string[]).includes(outcome.code));
  assert.equal(outcome.anchor.head.seq, 3);
  // The message names where the two chains parted, in the shared vocabulary.
  assert.match(outcome.message, /DIVERGED at seq 3/u);
});

test("anchor: a working log truncated BELOW the anchor and re-chained is refused", () => {
  const repo = newRepo(4);
  forge(repo, 1, "a chain that keeps only the genesis record");

  const outcome = check(repo);
  assert.equal(outcome.status, "diverged", JSON.stringify(outcome));
  if (outcome.status !== "diverged") throw new Error("unreachable");
  assert.equal(outcome.code, "anchor-diverged");
  assert.match(outcome.message, /not a prefix of the longer one/u);
});

test("anchor: a rewritten byte inside the anchored prefix is refused on the digest", () => {
  const repo = newRepo(2);
  // A rewrite that leaves every record's own hash alone: an extra space in the
  // JSON of the first line. The chain still verifies (the digest is over the
  // canonical form), and the FILE is no longer the file that was committed.
  const text = readFileSync(repo.logPath, "utf8");
  writeFileSync(repo.logPath, text.replace(/^\{/u, "{ "), "utf8");
  forgetAnchorBlobs();

  const walked = verifyWithRecords(repo.logPath);
  assert.equal(walked.result.status, "clean", "the premise: the chain still verifies");

  const outcome = checkLogAnchor({ logPath: repo.logPath, records: walked.records });
  assert.equal(outcome.status, "diverged", JSON.stringify(outcome));
  if (outcome.status !== "diverged") throw new Error("unreachable");
  assert.match(outcome.message, /do not hash to the copy committed at/u);
});

test("anchor: a working log BEHIND the committed copy is behind, not diverged", () => {
  const repo = newRepo(2);
  counter += 1;
  const peer = join(scratch, `peer-${counter}`);
  assert.equal(git(["clone", "-q", repo.remote, peer], scratch).code, 0);
  git(["config", "user.email", "test@example.invalid"], peer);
  git(["config", "user.name", "Test"], peer);
  appendRecord(peer, "a record this checkout has not seen");
  assert.equal(git(["add", "-A"], peer).code, 0);
  assert.equal(git(["commit", "-qm", "peer advance"], peer).code, 0);
  assert.equal(git(["push", "-q", "origin", "main"], peer).code, 0);
  assert.equal(git(["fetch", "-q", "origin"], repo.dir).code, 0);
  forgetAnchorBlobs();

  const outcome = check(repo);
  assert.equal(outcome.status, "behind", JSON.stringify(outcome));
  if (outcome.status !== "behind") throw new Error("unreachable");
  assert.equal(outcome.behind, 1);
  assert.equal(outcome.anchor.rev, "refs/remotes/origin/main");
});

test("anchor: --anchor-rev pins the comparison to one rev", () => {
  const repo = newRepo(2);
  const first = git(["rev-parse", "HEAD"], repo.dir).stdout.trim();
  appendRecord(repo.dir, "after the first commit");
  assert.equal(git(["add", "-A"], repo.dir).code, 0);
  assert.equal(git(["commit", "-qm", "second"], repo.dir).code, 0);
  forgetAnchorBlobs();

  // The default resolution finds the newer copy; the explicit rev finds the
  // older one, and both pass because both are prefixes of this chain.
  const byDefault = check(repo);
  assert.equal(byDefault.status, "pass");
  if (byDefault.status !== "pass") throw new Error("unreachable");
  assert.equal(byDefault.anchor.head.seq, 3);

  const pinned = check(repo, { rev: first });
  assert.equal(pinned.status, "pass");
  if (pinned.status !== "pass") throw new Error("unreachable");
  assert.equal(pinned.anchor.head.seq, 2);
  assert.equal(pinned.anchor.rev, first);
});

test("anchor: the newest committed copy wins, whichever rev carries it", () => {
  const repo = newRepo(2);
  appendRecord(repo.dir, "for the records branch");
  assert.equal(git(["add", "-A"], repo.dir).code, 0);
  assert.equal(git(["commit", "-qm", "records"], repo.dir).code, 0);
  // An advance anchor, exactly as `approval log advance` leaves one behind.
  assert.equal(
    git(["update-ref", "refs/approval/advance/main", "HEAD"], repo.dir).code,
    0,
  );
  // And HEAD moves BACK, so only the advance anchor carries seq 3.
  assert.equal(git(["reset", "-q", "--hard", "HEAD~1"], repo.dir).code, 0);
  // The reset rewound the working log with it; put the chain back.
  appendRecord(repo.dir, "for the records branch");
  forgetAnchorBlobs();

  const root = repoRoot(repo.dir);
  assert.ok(root !== null);
  assert.ok(anchorRevs(root).includes("refs/approval/advance/main"));

  const resolved = resolveAnchor(root, repo.logPath);
  assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.reason);
  if (!resolved.ok) throw new Error("unreachable");
  assert.equal(resolved.anchor.rev, "refs/approval/advance/main");
  assert.equal(resolved.anchor.head.seq, 3);
});

// ===========================================================================
// AC 2 — a missing anchor is a skip with a reason, never a pass
// ===========================================================================

test("anchor: outside a git repository the check skips and says so", () => {
  counter += 1;
  const dir = join(scratch, `nogit-${counter}`);
  mkdirSync(join(dir, ".approval", "log"), { recursive: true });
  appendRecord(dir, "no repository here");

  const logPath = join(dir, LOG_RELATIVE);
  const outcome = checkLogAnchor({ logPath, records: records(logPath) });
  assert.equal(outcome.status, "skip", JSON.stringify(outcome));
  if (outcome.status !== "skip") throw new Error("unreachable");
  assert.match(outcome.reason, /not inside a git repository/u);
});

test("anchor: a repository that has never committed the log skips, and never passes", () => {
  counter += 1;
  const dir = join(scratch, `uncommitted-${counter}`);
  mkdirSync(join(dir, ".approval", "log"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "# fixture\n", "utf8");
  assert.equal(git(["init", "-q", "-b", "main", "."], dir).code, 0);
  git(["config", "user.email", "test@example.invalid"], dir);
  git(["config", "user.name", "Test"], dir);
  assert.equal(git(["add", "README.md"], dir).code, 0);
  assert.equal(git(["commit", "-qm", "no log in this commit"], dir).code, 0);
  appendRecord(dir, "recorded but never committed");
  forgetAnchorBlobs();

  const logPath = join(dir, LOG_RELATIVE);
  const outcome = checkLogAnchor({ logPath, records: records(logPath) });
  assert.equal(outcome.status, "skip", JSON.stringify(outcome));
  if (outcome.status !== "skip") throw new Error("unreachable");
  // The reason names the revs that were tried: a skip that says nothing is a
  // pass with extra steps.
  assert.match(outcome.reason, /tried .*HEAD/u);
  // And when NOTHING resolved, it names the command that was run and what git
  // said back. A skip that lists revs without saying how the lookup failed
  // reads identically whether the blob is absent or the lookup itself broke,
  // and those are the two answers an operator has to tell apart.
  assert.match(outcome.reason, /git rev-parse --verify --quiet/u);
  assert.match(outcome.reason, new RegExp(`HEAD:${LOG_RELATIVE.replace(/\./gu, "\\.")}`, "u"));
});

test("anchor: an explicit rev with no such blob skips rather than passing", () => {
  const repo = newRepo();
  const outcome = check(repo, { rev: "refs/heads/there-is-no-such-branch" });
  assert.equal(outcome.status, "skip", JSON.stringify(outcome));
});

// ===========================================================================
// AC 1/6 — the CLI surface
// ===========================================================================

test("cli: log verify --anchor passes at exit 0 and names the anchor", () => {
  const repo = newRepo();
  appendRecord(repo.dir, "cli-ahead");

  const plain = runCli(["log", "verify", "--anchor"], repo.dir);
  assert.equal(plain.code, 0, `${plain.stdout}${plain.stderr}`);
  assert.match(plain.stdout, /^clean: 3 record\(s\)/mu);
  assert.match(plain.stdout, /^anchor /mu);

  const json = runCli(["log", "verify", "--anchor", "--json"], repo.dir);
  assert.equal(json.code, 0, json.stderr);
  const parsed = JSON.parse(json.stdout.trim()) as {
    status: string;
    anchor: { status: string; rev: string; seq: number; bytes: number };
  };
  assert.equal(parsed.status, "clean");
  assert.equal(parsed.anchor.status, "pass");
  assert.equal(parsed.anchor.seq, 2);
  assert.ok(parsed.anchor.bytes > 0);
});

test("cli: log verify without --anchor is exactly the verdict it always was", () => {
  const repo = newRepo();
  forge(repo, 1, "a forgery the plain verdict does not look for");

  const plain = runCli(["log", "verify", "--json"], repo.dir);
  assert.equal(plain.code, 0, plain.stderr);
  const parsed = JSON.parse(plain.stdout.trim()) as Record<string, unknown>;
  assert.equal(parsed["status"], "clean");
  assert.equal("anchor" in parsed, false, "the anchor field appeared without --anchor");
});

test("cli: a diverged anchor is an integrity refusal, not a clean verdict", () => {
  const repo = newRepo(3);
  forge(repo, 2, "the forged tail");

  const plain = runCli(["log", "verify", "--anchor"], repo.dir);
  assert.equal(plain.code, 1, `${plain.stdout}${plain.stderr}`);
  assert.match(plain.stderr, /anchor-diverged/u);
  assert.equal(plain.stdout.includes("clean:"), false, "a refusal printed a clean verdict");

  const json = runCli(["log", "verify", "--anchor", "--json"], repo.dir);
  assert.equal(json.code, 1);
  const parsed = JSON.parse(json.stdout.trim()) as {
    status: string;
    anchor: { status: string };
  };
  assert.equal(parsed.status, "anchor-diverged");
  assert.equal(parsed.anchor.status, "diverged");
});

test("cli: --anchor writes nothing — not the log, not the repository", () => {
  const repo = newRepo();
  appendRecord(repo.dir, "before the check");
  const before = readFileSync(repo.logPath);
  const headBefore = git(["rev-parse", "HEAD"], repo.dir).stdout.trim();
  const statusBefore = git(["status", "--porcelain"], repo.dir).stdout;

  assert.equal(runCli(["log", "verify", "--anchor"], repo.dir).code, 0);

  assert.deepEqual(readFileSync(repo.logPath), before);
  assert.equal(git(["rev-parse", "HEAD"], repo.dir).stdout.trim(), headBefore);
  assert.equal(git(["status", "--porcelain"], repo.dir).stdout, statusBefore);
});

// ===========================================================================
// AC 3 — the daemon
// ===========================================================================

/** One in-process tick against a git fixture, with the events it emitted. */
async function tick(repo: Repo): Promise<{ events: DaemonEvent[]; kind: string }> {
  const events: DaemonEvent[] = [];
  const daemon = new Daemon({
    logPath: repo.logPath,
    tasksDir: join(repo.dir, "backlog", "tasks"),
    queuePath: join(repo.dir, QUEUE_RELATIVE),
    policy: { file: join(repo.dir, "APPROVAL.md") },
    cwd: repo.dir,
    intervalMs: 60_000,
    debounceMs: 10,
    once: true,
    sink: { emit: (event) => events.push(event) },
  });
  const outcome = await daemon.run();
  return { events, kind: outcome.kind };
}

function lineOf<K extends DaemonEvent["event"]>(
  events: DaemonEvent[],
  event: K,
): Extract<DaemonEvent, { event: K }> {
  const found = events.find((entry) => entry.event === event);
  assert.ok(found !== undefined, `no ${event} line was emitted`);
  return found as Extract<DaemonEvent, { event: K }>;
}

test("daemon: the started line names the anchor, and the tick line reports the comparison", async () => {
  const repo = newRepo();
  appendRecord(repo.dir, "daemon-ahead");

  const { events, kind } = await tick(repo);
  assert.equal(kind, "stopped");

  const started = lineOf(events, "started");
  assert.notEqual(started.anchor.rev, null, "the started line named no anchor");
  assert.equal(started.anchor.seq, 2);
  assert.equal(started.anchor.reason, null);

  // The first tick is always a cold walk, so it always compares.
  const ticked = lineOf(events, "tick");
  assert.equal(ticked.reproof, "full");
  assert.equal(ticked.anchor?.status, "pass");
  assert.equal(ticked.anchor?.seq, 2);
});

test("daemon: a diverged anchor stops the daemon with its own outcome", async () => {
  const repo = newRepo(3);
  forge(repo, 2, "a forged tail the daemon must not append onto");

  const { events, kind } = await tick(repo);
  assert.equal(kind, "anchor-diverged", JSON.stringify(events));
  // Distinct from the corrupt outcome: the file walks clean and contradicts
  // the record of it, which is a different thing to tell an operator.
  assert.notEqual(kind, "log-corrupt");
  assert.equal(lineOf(events, "stopped").reason, "anchor-diverged");
});

test("daemon: outside a repository the started line says so and the daemon runs", async () => {
  counter += 1;
  const dir = join(scratch, `daemon-nogit-${counter}`);
  mkdirSync(join(dir, ".approval", "log"), { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  appendRecord(dir, "no repository");
  const repo: Repo = { dir, remote: "", logPath: join(dir, LOG_RELATIVE) };

  const { events, kind } = await tick(repo);
  assert.equal(kind, "stopped");
  const started = lineOf(events, "started");
  assert.equal(started.anchor.rev, null);
  assert.match(started.anchor.reason ?? "", /not inside a git repository/u);
  assert.equal(lineOf(events, "tick").anchor?.status, "skip");
});

// ===========================================================================
// AC 4 — the doctor rows (APRV-210's two reproductions)
// ===========================================================================

interface DoctorRow {
  check: string;
  status: string;
  detail: string;
  fix?: string;
}

function doctorRows(dir: string): DoctorRow[] {
  const run = runCli(["doctor", "--json"], dir);
  return (JSON.parse(run.stdout.trim()) as { checks: DoctorRow[] }).checks;
}

function rowNamed(dir: string, name: string): DoctorRow {
  const found = doctorRows(dir).find((row) => row.check === name);
  assert.ok(found !== undefined, `doctor has no ${name} row`);
  return found;
}

test("doctor: log-drift never says 'never been committed' when git show HEAD:<log> succeeds", () => {
  const repo = newRepo();
  // The premise, stated as git states it.
  const shown = git(["show", `HEAD:${LOG_RELATIVE}`], repo.dir);
  assert.equal(shown.code, 0, shown.stderr);
  assert.ok(shown.stdout.length > 0);

  const row = rowNamed(repo.dir, "log-drift");
  assert.equal(row.status, "pass", row.detail);
  assert.equal(/never been committed/u.test(row.detail), false, row.detail);
  // And it reports the committed seq.
  assert.match(row.detail, /seq 2/u);
});

test("doctor: log-drift resolves the log through a symlinked spelling of the checkout", () => {
  // The APRV-210 shape: the same checkout reached by a path that is not its
  // physical one. `git rev-parse --show-toplevel` answers with the physical
  // path, and a relative() across the two spellings used to climb out of the
  // repository and produce a HEAD:<junk> spec no blob could satisfy.
  const repo = newRepo();
  counter += 1;
  const link = join(scratch, `link-${counter}`);
  const linked = spawnSync("ln", ["-s", repo.dir, link], { encoding: "utf8" });
  assert.equal(linked.status, 0, linked.stderr);
  forgetAnchorBlobs();

  const row = rowNamed(link, "log-drift");
  assert.equal(row.status, "pass", row.detail);
  assert.equal(/never been committed/u.test(row.detail), false, row.detail);
});

test("doctor: log-advance-cadence counts what the trunk carries and names the ref", () => {
  // The second APRV-210 reproduction: seq 1..N are on the remote's trunk and
  // the working log is at N+k. The row must owe k, not N+k.
  const repo = newRepo(2);
  appendRecord(repo.dir, "unpublished-1");
  appendRecord(repo.dir, "unpublished-2");
  forgetAnchorBlobs();

  const row = rowNamed(repo.dir, "log-advance-cadence");
  assert.equal(row.status, "pass", row.detail);
  assert.match(row.detail, /^2 record\(s\) are not yet on a records branch/u);
  assert.match(row.detail, /published through seq 2/u);
  assert.match(row.detail, /read from /u);

  // The same numbers, from the function the row reads.
  const root = repoRoot(repo.dir);
  assert.ok(root !== null);
  const state = publishedState(
    root,
    repo.logPath,
    records(repo.logPath),
    { remote: "origin", base: null },
    new Date().toISOString(),
  );
  assert.equal(state.publishedSeq, 2);
  assert.equal(state.pending, 2);
  assert.notEqual(state.publishedRev, null);
});

test("doctor: a diverged working log fails the log-drift row and names the seq", () => {
  const repo = newRepo(3);
  forge(repo, 2, "the forged tail doctor must fail on");

  const row = rowNamed(repo.dir, "log-drift");
  assert.equal(row.status, "fail", row.detail);
  assert.match(row.detail, /DIVERGED at seq 3/u);
  assert.match(row.fix ?? "", /^approval log verify --anchor/u);
});

test("doctor: neither git-backed row builds a HEAD:<absolute path> spec", () => {
  // Structural: an absolute path in a blob spec is the bug class APRV-210 hit,
  // and it is invisible in any fixture whose checkout is already its own
  // realpath. What is pinned is that nothing in these modules interpolates a
  // path into a rev spec except through `repoPath`.
  const REPO_ROOT_DIR = fileURLToPath(new URL("../../", import.meta.url));
  for (const relative of ["src/cli/log-anchor.ts", "src/cli/log-advance.ts", "src/cli/doctor.ts"]) {
    const code = readFileSync(join(REPO_ROOT_DIR, relative), "utf8")
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/(^|[^:])\/\/.*$/gmu, "$1");
    assert.doesNotMatch(
      code,
      /`\$\{rev\}:\$\{logPath\}`|`HEAD:\$\{logPath\}`/u,
      `${relative} builds a rev spec from an unresolved path`,
    );
  }
});

// ===========================================================================
// A committed log larger than one megabyte
// ===========================================================================

/**
 * Every fixture above this line carries a handful of records, which is why
 * every fixture above this line passed while the real checkout failed.
 *
 * `spawnSync` caps a child's captured output at `maxBuffer`, one mebibyte by
 * default, and a child that exceeds it is killed with `error` set to `ENOBUFS`
 * and `status` left null. `git show <rev>:<log>` on a log of a few hundred
 * bytes never comes near that ceiling; the same command on a twelve-megabyte
 * log never gets under it. So the fixtures were not small by accident, they
 * were small on the ONE axis the defect lives on, and the suite reported
 * health about a code path that had already stopped working in production.
 *
 * These cases grow the log past the ceiling through the real append path and
 * then ask the same questions the earlier ones ask.
 */
const OVER_BUFFER_BYTES = 1200 * 1024;

/** Append real records until the log is bigger than `targetBytes`. */
function growLog(dir: string, logPath: string, targetBytes: number): void {
  let index = 0;
  while (statSync(logPath).size <= targetBytes) {
    appendRecord(dir, `bulk-${String(index)}`);
    index += 1;
  }
}

/**
 * The primary checkout's ref layout, at the primary checkout's log size.
 *
 * A bare origin whose `main` carries the log, a `refs/remotes/origin/main`
 * remote-tracking ref pointing at it, and a `refs/approval/advance/*` ref of
 * the kind `approval log advance` leaves behind. All three are candidate
 * anchors, and the defect makes all three fail identically.
 */
function bigRepo(): Repo & { advanceRef: string } {
  const repo = newRepo(2);
  growLog(repo.dir, repo.logPath, OVER_BUFFER_BYTES);
  assert.equal(git(["add", "-A"], repo.dir).code, 0);
  assert.equal(git(["commit", "-qm", "a log past the buffer ceiling"], repo.dir).code, 0);
  assert.equal(git(["push", "-q", "origin", "main"], repo.dir).code, 0);
  const advanceRef = "refs/approval/advance/records-log-fixture";
  assert.equal(git(["update-ref", advanceRef, "HEAD"], repo.dir).code, 0);
  forgetAnchorBlobs();
  return { ...repo, advanceRef };
}

/** The premise every case here rests on, stated the way a shell states it. */
function assertGitCanSeeTheLog(dir: string, rev: string): void {
  const oid = git(["rev-parse", "--verify", "--quiet", `${rev}:${LOG_RELATIVE}`], dir);
  assert.equal(oid.code, 0, `${rev} has no blob: ${oid.stderr}`);
  assert.ok(oid.stdout.trim().length > 0, `${rev} named no blob`);
  const shown = git(["show", `${rev}:${LOG_RELATIVE}`], dir);
  assert.equal(shown.code, 0, shown.stderr);
  assert.ok(shown.stdout.length > 1024 * 1024, "the fixture log is under the buffer ceiling");
}

test("anchor: the git output limit is above spawnSync's default, in code", () => {
  // Structural, and pinned because the defect was invisible: the limit is a
  // number nothing reads back, so a change that restored the default would
  // break every committed-log read and no other assertion in this file with a
  // log of ordinary fixture size would notice.
  assert.ok(
    GIT_OUTPUT_LIMIT_BYTES > 1024 * 1024,
    `the git output limit is ${String(GIT_OUTPUT_LIMIT_BYTES)}, at or under spawnSync's default`,
  );
  const REPO_ROOT_DIR = fileURLToPath(new URL("../../", import.meta.url));
  const scope = readFileSync(join(REPO_ROOT_DIR, "src/cli/git-scope.ts"), "utf8");
  assert.match(
    scope,
    /spawnSync\("git", \["show", spec\], \{ cwd: root, maxBuffer: GIT_OUTPUT_LIMIT_BYTES \}\)/u,
    "the blob read runs git show without an explicit output limit",
  );
});

test("anchor: a committed log over a megabyte resolves in the main worktree", () => {
  const repo = bigRepo();
  assertGitCanSeeTheLog(repo.dir, "refs/remotes/origin/main");

  const resolved = resolveAnchor(repo.dir, repo.logPath);
  assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.reason);
  if (!resolved.ok) throw new Error("unreachable");
  assert.ok(resolved.anchor.byteLength > 1024 * 1024);
  assert.ok(anchorRevs(repo.dir).includes(repo.advanceRef));

  const outcome = check(repo);
  assert.equal(outcome.status, "pass", JSON.stringify(outcome));
  if (outcome.status !== "pass") throw new Error("unreachable");
  assert.equal(outcome.ahead, 0);
});

test("anchor: the same log resolves from a linked worktree", () => {
  // A linked worktree's `git rev-parse --show-toplevel` is the WORKTREE, not
  // the primary checkout, so the repo-relative spelling of the log has to be
  // taken against that root. The refs are shared, so every candidate anchor
  // the primary can see this one can see too.
  const repo = bigRepo();
  counter += 1;
  const linked = join(scratch, `linked-${counter}`);
  const added = git(["worktree", "add", "-q", "-b", `probe-${counter}`, linked, "HEAD"], repo.dir);
  assert.equal(added.code, 0, added.stderr);
  forgetAnchorBlobs();

  assertGitCanSeeTheLog(linked, "refs/remotes/origin/main");
  const root = repoRoot(linked);
  assert.ok(root !== null);
  assert.equal(realpathSync(root), realpathSync(linked), "the worktree is its own toplevel");
  assert.ok(anchorRevs(root).includes(repo.advanceRef));

  const logPath = join(linked, LOG_RELATIVE);
  const outcome = checkLogAnchor({ logPath, records: records(logPath) });
  assert.equal(outcome.status, "pass", JSON.stringify(outcome));
});

test("anchor: publishedState counts owed records against origin/main on a large log", () => {
  // The cadence's consequence of the same defect: every rev's blob read comes
  // back null, so the highest published seq is 0, the row claims the whole log
  // is owed, and the advance refuses because "no records branch carries" a seq
  // that origin/main has carried for days.
  const repo = bigRepo();
  appendRecord(repo.dir, "owed-1");
  appendRecord(repo.dir, "owed-2");
  forgetAnchorBlobs();

  const root = repoRoot(repo.dir);
  assert.ok(root !== null);
  const walked = records(repo.logPath);
  const state = publishedState(
    root,
    repo.logPath,
    walked,
    { remote: "origin", base: null },
    new Date().toISOString(),
  );
  const workingSeq = walked[walked.length - 1]?.seq ?? 0;
  assert.notEqual(state.publishedSeq, 0, "a committed log was reported as published through seq 0");
  assert.equal(state.publishedSeq, workingSeq - 2);
  assert.equal(state.pending, 2);
  assert.notEqual(state.publishedRev, null);
});

test("doctor: the log-drift row reads a large committed log rather than skipping", () => {
  const repo = bigRepo();
  const row = rowNamed(repo.dir, "log-drift");
  assert.equal(row.status, "pass", row.detail);
  assert.equal(/no rev this checkout can see/u.test(row.detail), false, row.detail);
});
