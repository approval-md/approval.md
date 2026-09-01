/**
 * Progress on stderr during the silent pre-diff verify (APRV-167).
 *
 * The incident: `approval policy amend` sat silent for ~33 seconds on this
 * repository's own ~3000-record log — a full chain re-verification plus the
 * baseline recovery, all of it before the first byte of output — and read as
 * frozen. One live ceremony was nearly abandoned over it, and an earlier one
 * WAS, which left the repository's gate fail-closed until somebody retried.
 *
 * Two halves:
 *
 * 1. The reporter itself (`src/cli/progress.ts`), unit-tested. Its whole
 *    contract is which lines come out for a given record count, so that is
 *    exactly what is asserted — no timing, no terminal, no spinner.
 * 2. The verb, end-to-end, over a log large enough to make it speak. The
 *    load-bearing assertion is that `--json` stdout is BYTE-identical to the
 *    same amendment over a small log that prints no progress at all: whatever
 *    the reporter writes, it writes to stderr and nowhere else.
 *
 * Every record here is written by the real append path (`approval policy
 * attest`, then `appendEvent`); nothing hand-writes a log line.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { appendEvent } from "../src/core/log.js";
import { makeProgress, MIN_ANNOUNCED_RECORDS } from "../src/cli/progress.js";
import { makeStyle } from "../src/cli/style.js";

/** dist/tests/cli-progress.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-progress-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The reporter, on its own
// ---------------------------------------------------------------------------

/** A reporter writing into an array, with colour off (the piped-output case). */
function captured(): { lines: string[]; progress: ReturnType<typeof makeProgress> } {
  const lines: string[] = [];
  const progress = makeProgress({
    err: (text) => {
      // Every write is exactly one terminated line: no partial lines, which is
      // what a spinner would need and what would garble a pipe.
      assert.equal(text.endsWith("\n"), true, `unterminated write: ${JSON.stringify(text)}`);
      assert.equal(text.slice(0, -1).includes("\n"), false, "more than one line per write");
      lines.push(text.slice(0, -1));
    },
    style: makeStyle({ tty: false }),
  });
  return { lines, progress };
}

/** Drive a sink the way a chain walk does: the opening call, then each record. */
function walkThrough(sink: (progress: { verified: number; total: number }) => void, total: number): void {
  sink({ verified: 0, total });
  for (let verified = 1; verified <= total; verified += 1) sink({ verified, total });
}

test("a log below the announce threshold prints nothing at all", () => {
  const { lines, progress } = captured();
  walkThrough(progress.chain("verifying the log chain"), MIN_ANNOUNCED_RECORDS - 1);
  assert.deepEqual(lines, []);
  assert.equal(progress.announced, false);
  // And a countless step stays quiet with it: on a log this small the verb
  // returns before a human wonders, and one lone line would be noise.
  progress.step("recovering the attested baseline from git HEAD");
  assert.deepEqual(lines, []);
});

test("a 300-record log opens with the count, then reports every 100", () => {
  const { lines, progress } = captured();
  walkThrough(progress.chain("verifying the log chain"), 300);
  assert.deepEqual(lines, [
    "approval: verifying the log chain: 300 records",
    "approval: verifying the log chain: 100/300 records",
    "approval: verifying the log chain: 200/300 records",
    "approval: verifying the log chain: 300/300 records, done",
  ]);
  // Once something slow has been announced, the countless steps speak too.
  progress.step("recovering the attested baseline from git HEAD");
  assert.equal(lines.at(-1), "approval: recovering the attested baseline from git HEAD");
});

test("the line count stays bounded as the log grows", () => {
  const { lines, progress } = captured();
  walkThrough(progress.chain("verifying the log chain"), 3000);
  assert.equal(lines[0], "approval: verifying the log chain: 3000 records");
  assert.equal(lines[1], "approval: verifying the log chain: 150/3000 records");
  assert.equal(lines.at(-1), "approval: verifying the log chain: 3000/3000 records, done");
  // 20 checkpoints at most, plus the opening line — a hundred-thousand-record
  // log must not write a thousand lines into somebody's CI transcript.
  assert.equal(lines.length <= 22, true, `too many lines: ${lines.length}`);

  const huge = captured();
  walkThrough(huge.progress.chain("verifying the log chain"), 100_000);
  assert.equal(huge.lines.length <= 22, true, `too many lines: ${huge.lines.length}`);
});

test("a resumed walk reports file-absolute counts, never a restart from zero", () => {
  const { lines, progress } = captured();
  const sink = progress.chain("verifying the log chain");
  // What `core/state.ts` produces when 2000 records are reused from the
  // verified-read cache and 1000 are appended since.
  sink({ verified: 2000, total: 3000 });
  for (let verified = 2001; verified <= 3000; verified += 1) sink({ verified, total: 3000 });
  assert.equal(lines[0], "approval: verifying the log chain: 3000 records");
  assert.equal(lines[1], "approval: verifying the log chain: 2000/3000 records");
  assert.equal(lines.at(-1), "approval: verifying the log chain: 3000/3000 records, done");
});

test("nothing the reporter writes moves the cursor or hides behind an escape", () => {
  const { lines, progress } = captured();
  walkThrough(progress.chain("verifying the log chain"), 300);
  for (const line of lines) {
    // No escape byte anywhere: no cursor movement, no carriage return,
    // nothing that turns a piped log or a CI transcript into a mess.
    const control = [...line].some((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    });
    assert.equal(control, false, `control byte in ${line}`);
    assert.equal(line.startsWith("approval: "), true, `off-convention line: ${line}`);
  }
});

// ---------------------------------------------------------------------------
// The verb, end to end
// ---------------------------------------------------------------------------

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * A PATH whose `gh` answers nothing, so branch-protection detection resolves to
 * `unknown` and no test here can reach GitHub — the same stance the amend suite
 * takes. Real `git` stays on the PATH: baseline recovery is `git show HEAD:…`.
 */
function stubbedPath(): string {
  counter += 1;
  const dir = join(scratch, `bin-${counter}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "gh"), "#!/bin/sh\nexit 1\n", "utf8");
  chmodSync(join(dir, "gh"), 0o755);
  return `${dir}${delimiter}${process.env["PATH"] ?? ""}`;
}

const STUBBED_PATH = stubbedPath();

function runCli(args: string[], cwd: string): Run {
  const env: Record<string, string | undefined> = { ...process.env, PATH: STUBBED_PATH };
  // Identity comes from `--as` in every case here, so the developer's own
  // environment cannot answer for one of them.
  delete env["APPROVAL_HUMAN"];
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], { cwd, encoding: "utf8", env });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function git(args: string[], cwd: string): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
}

function policyText(ttl: string, autonomy: string): string {
  return [
    "# Policy",
    "",
    "```yaml approval-policy",
    'version: "0.1"',
    "defaults:",
    "  autonomy: supervised",
    `  approval_ttl: ${ttl}`,
    "approvers:",
    "  carter:",
    "    channels: [cli]",
    "classes:",
    "  read.*:",
    `    autonomy: ${autonomy}`,
    "```",
    "",
  ].join("\n");
}

/** How many records the big log carries. Above the announce threshold, and
 *  above one reporting stride, so the run prints an opening line, at least one
 *  checkpoint, and a closing line. */
const BIG_RECORDS = 150;

/**
 * One git repository, one committed policy, and two logs side by side: a small
 * one holding just the attestation, and a big one holding the same attestation
 * followed by unrelated records.
 *
 * The two amendments are therefore the SAME amendment — same policy file, same
 * attested bytes at the same seq, same repository, same protection probe — and
 * differ in exactly one thing: how many records the verb has to walk before it
 * can speak. That is what makes the byte-comparison below meaningful.
 */
function twoLogFixture(): { dir: string; small: string; big: string } {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), policyText("24h", "autonomous"), "utf8");
  git(["init", "-q", "."], dir);
  git(["config", "user.email", "test@example.invalid"], dir);
  git(["config", "user.name", "Test"], dir);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "policy"], dir);

  const small = join(dir, "small.jsonl");
  const big = join(dir, "big.jsonl");
  for (const log of [small, big]) {
    const attested = runCli(["policy", "attest", "--as", "human:carter", "--log", log], dir);
    assert.equal(attested.code, 0, `attest failed: ${attested.stderr}`);
  }

  // Filler through the real append path. `task.registered` is inert here: it
  // carries no policy attestation, so it cannot move what `amend` reports.
  for (let i = 2; i <= BIG_RECORDS; i += 1) {
    const appended = appendEvent(big, {
      ts: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
      event: "task.registered",
      actor: "agent:filler",
      task: "APRV-167",
    });
    assert.equal(appended.ok, true, "filler append failed");
  }

  // The amendment itself: two edits, so there is a real diff to print.
  writeFileSync(join(dir, "APPROVAL.md"), policyText("1h", "manual"), "utf8");
  return { dir, small, big };
}

function progressLines(stderr: string): string[] {
  return stderr.split("\n").filter((line) => line.includes("verifying the log chain"));
}

test("amend over a large log names the step and counts records, on stderr only", () => {
  const { dir, small, big } = twoLogFixture();

  const loud = runCli(
    ["policy", "amend", "--dry-run", "--json", "--as", "human:carter", "--log", big],
    dir,
  );
  assert.equal(loud.code, 0, `amend failed: ${loud.stderr}`);

  // (1) The FIRST thing the operator sees names the step and the size of the
  // job. It is written once the log has been read and split, before the first
  // record is verified — which is what makes it arrive in milliseconds rather
  // than after the walk it is describing.
  const firstLine = loud.stderr.split("\n")[0];
  assert.equal(firstLine, `approval: verifying the log chain: ${BIG_RECORDS} records`);

  // (2) Count-based progress, then the close, then the step that has no count.
  assert.deepEqual(progressLines(loud.stderr), [
    `approval: verifying the log chain: ${BIG_RECORDS} records`,
    "approval: verifying the log chain: 100/150 records",
    `approval: verifying the log chain: ${BIG_RECORDS}/${BIG_RECORDS} records, done`,
  ]);
  assert.equal(
    loud.stderr.includes("approval: recovering the attested baseline from git HEAD"),
    true,
    `no baseline step announced: ${loud.stderr}`,
  );

  // (3) stdout is the JSON report and NOTHING else: one line, and re-encoding
  // the parse of it reproduces the bytes exactly.
  const parsed = JSON.parse(loud.stdout) as unknown;
  assert.equal(loud.stdout, `${JSON.stringify(parsed)}\n`);
  assert.equal(loud.stdout.includes("verifying the log chain"), false);

  // (4) The byte comparison. The same amendment over the small log prints no
  // progress at all, and its `--json` stdout is byte-identical to the loud
  // run's once the one legitimately-different value — the `--log` path, which
  // appears in the printed `git add` — is normalized away.
  const quiet = runCli(
    ["policy", "amend", "--dry-run", "--json", "--as", "human:carter", "--log", small],
    dir,
  );
  assert.equal(quiet.code, 0, `amend failed: ${quiet.stderr}`);
  assert.deepEqual(progressLines(quiet.stderr), []);
  assert.equal(quiet.stderr.includes("recovering the attested baseline"), false);
  assert.equal(
    loud.stdout.split(big).join("<log>"),
    quiet.stdout.split(small).join("<log>"),
    "the --json report moved when progress was printed",
  );
});

test("the human amend output keeps its own first line on stdout", () => {
  const { dir, big } = twoLogFixture();
  const run = runCli(
    ["policy", "amend", "--dry-run", "--as", "human:carter", "--log", big],
    dir,
  );
  assert.equal(run.code, 0, `amend failed: ${run.stderr}`);
  // Progress never leaks into the block a human reads and screenshots.
  assert.equal(run.stdout.includes("verifying the log chain"), false);
  assert.equal(progressLines(run.stderr).length, 3);
});

test("the log the amend suite's other cases carry is too small to say anything", () => {
  // Regression guard for the quiet-by-default rule: the ordinary fixtures in
  // this repository's tests hold a handful of records, and none of them should
  // start emitting progress lines because this landed.
  const { dir, small } = twoLogFixture();
  const run = runCli(
    ["policy", "amend", "--dry-run", "--as", "human:carter", "--log", small],
    dir,
  );
  assert.equal(run.code, 0, `amend failed: ${run.stderr}`);
  assert.equal(run.stderr.includes("approval: verifying"), false, run.stderr);
});
