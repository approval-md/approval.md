/**
 * CLI end-to-end tests (APRV-9).
 *
 * Every case spawns the real compiled CLI as a child process against a temp
 * directory. Nothing here calls the command functions in-process: the contract
 * under test is what an agent actually observes — the exit code, the bytes on
 * stdout, and the bytes on stderr — and an in-process call would test none of
 * those.
 *
 * Repo invariant, restated: every log under test is built exclusively through
 * the real `appendEvent` path. Tamper and torn-tail fixtures are made by
 * *copying* a real log and damaging the copy; the copy plays the attacker or
 * the crashed writer.
 *
 * The exit codes and the `--json` shapes are frozen public API, so they are
 * asserted exactly — `deepEqual` on parsed JSON, `strictEqual` on the code.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { appendEvent, type EventInput } from "../src/core/log.js";
import { indexHead } from "../src/core/reindex.js";

// ---------------------------------------------------------------------------
// Frozen wire commitments (APRV-20 finding S3)
// ---------------------------------------------------------------------------

/**
 * These are **frozen wire commitments**: the literal bytes the CLI is contracted
 * to emit for the fixture logs built by {@link buildLog}.
 *
 * They used to be derived by calling core's `verify()` inside the test and
 * asserting the CLI matched it — which passes even when both sides drift
 * together, and which is the one thing a public-API test must not do. The digests
 * are deterministic (fixed timestamps, fixed payloads, JCS canonicalization,
 * SHA-256), so they are captured once and written down. If a hash below changes,
 * something changed the serialization or the hashing of an event, and every
 * consumer of an existing log is affected: that is a spec change, and this test
 * is where it must be argued rather than absorbed.
 */
const HEAD_AFTER_2 = {
  seq: 2,
  hash: "d42d8abe3ae3b0f057013636740b6bd5e45d622951597e0dc457fa4fff440b28",
} as const;

const HEAD_AFTER_3 = {
  seq: 3,
  hash: "73c5bc2652202931fa33560a2f7749fcd5aafd804899f815110125333f21c67d",
} as const;

/** The digest each tampered record recomputes to, per {@link tamperedCopy}. */
const RECOMPUTED_AFTER_TAMPER: Readonly<Record<number, string>> = {
  1: "8ac220475752eaee092b51d31bec8997b7db66b73e90d93b7912b403e798be57",
  2: "a3a6cd58f770f06676235941415d0c02b7fc1f53a586c3e4408597b7e275d22b",
  3: "31c7c05c0c9ee34271f234b3a4444b237e213feda0aae11d3c1ec7fcc8477ef6",
};

/** The stored hash of each record of a 3-record fixture log. */
const STORED_HASH: Readonly<Record<number, string>> = {
  1: "92a924934af7976a77c37a4bf3726c00e6a9d9220d7ac6ad45de3b9c142dd5ba",
  2: HEAD_AFTER_2.hash,
  3: HEAD_AFTER_3.hash,
};

/** The exact `corrupt` message for a tampered record — frozen, not derived. */
function hashMismatchMessage(seq: number): string {
  return `record ${seq} hash ${STORED_HASH[seq] as string} does not match its contents (recomputed ${
    RECOMPUTED_AFTER_TAMPER[seq] as string
  })`;
}

/** The exact `torn-tail` message for {@link tornCopy} of a 3-record log. */
function tornTailMessage(path: string): string {
  return `log ${path} ends with an unterminated line of 32 byte(s); records 1..3 verify clean. This is the signature of a crashed write. The log is NOT repaired here: truncating the torn line is a human decision.`;
}

/** dist/tests/cli.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
/** dist/tests/cli.test.js -> <repo>/cli.js */
const BIN_ENTRY = fileURLToPath(new URL("../../cli.js", import.meta.url));

const scratch = mkdtempSync(join(tmpdir(), "approval-md-cli-"));
let counter = 0;

after(() => {
  // Restore any permission-denied fixtures so the tree can be removed.
  for (const path of restoreOnExit) {
    try {
      chmodSync(path, 0o644);
    } catch {
      // Already gone or already writable; nothing to do.
    }
  }
  rmSync(scratch, { recursive: true, force: true });
});

const restoreOnExit: string[] = [];

function caseDir(): string {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const DEFAULT_LOG_RELATIVE = join(".approval", "log", "events.jsonl");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string, entry: string = CLI_ENTRY): Run {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function json(run: Run): unknown {
  return JSON.parse(run.stdout);
}

function jsonErr(run: Run): unknown {
  return JSON.parse(run.stderr);
}

function event(index: number): EventInput {
  const stamp = String(index).padStart(2, "0");
  return {
    ts: `2026-08-04T09:${stamp}:00Z`,
    event: "task.registered",
    actor: "agent:planner",
    task: `task-${stamp}`,
    channel: "cli",
    payload: { note: `record ${index}` },
  };
}

/** Build a log of `count` real records at the default location under `dir`. */
function buildLog(dir: string, count: number): string {
  const logPath = join(dir, DEFAULT_LOG_RELATIVE);
  for (let index = 1; index <= count; index += 1) {
    const result = appendEvent(logPath, event(index));
    assert.equal(result.ok, true, `append ${index} failed`);
  }
  return logPath;
}

/** A copy of `logPath` with line `lineNumber` mutated: hash no longer matches. */
function tamperedCopy(logPath: string, lineNumber: number): string {
  const target = `${logPath}.tampered`;
  copyFileSync(logPath, target);
  const lines = readFileSync(target, "utf8").split("\n");
  const original = lines[lineNumber - 1] as string;
  const record = JSON.parse(original) as Record<string, unknown>;
  record["payload"] = { note: "forged" };
  lines[lineNumber - 1] = JSON.stringify(record);
  writeFileSync(target, lines.join("\n"));
  return target;
}

/** A copy of `logPath` with an unterminated final line appended. */
function tornCopy(logPath: string): string {
  const target = `${logPath}.torn`;
  copyFileSync(logPath, target);
  appendFileSync(target, '{"seq":99,"ts":"2026-08-04T10:00');
  return target;
}

const RUNNING_AS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

// --------------------------------------------------------------------------
// log verify
// --------------------------------------------------------------------------

test("log verify: clean log exits 0 with the exact JSON shape", () => {
  const dir = caseDir();
  buildLog(dir, 3);

  const run = runCli(["log", "verify", "--json"], dir);
  assert.equal(run.code, 0);
  assert.deepEqual(json(run), {
    status: "clean",
    records: 3,
    head: { seq: 3, hash: HEAD_AFTER_3.hash },
  });
  assert.equal(run.stderr, "");
});

test("log verify: human output prints status and head", () => {
  const dir = caseDir();
  buildLog(dir, 2);

  const run = runCli(["log", "verify"], dir);
  assert.equal(run.code, 0);
  assert.equal(run.stdout, `clean: 2 record(s), head seq 2 ${HEAD_AFTER_2.hash}\n`);
});

test("log verify: absent log is a clean empty log, exit 0", () => {
  const dir = caseDir();
  const run = runCli(["log", "verify", "--json"], dir);
  assert.equal(run.code, 0);
  assert.deepEqual(json(run), { status: "clean", records: 0, head: null });
});

test("log verify: corrupt log exits 1 with the exact JSON shape", () => {
  const dir = caseDir();
  const logPath = buildLog(dir, 3);
  const tampered = tamperedCopy(logPath, 2);

  const run = runCli(["log", "verify", "--log", tampered, "--json"], dir);
  assert.equal(run.code, 1);
  assert.deepEqual(json(run), {
    status: "corrupt",
    records: null,
    head: null,
    firstBadSeq: 2,
    reason: "hash-mismatch",
    message: hashMismatchMessage(2),
  });
});

test("log verify: corrupt log reports reason and first bad seq on stderr", () => {
  const dir = caseDir();
  const logPath = buildLog(dir, 3);
  const tampered = tamperedCopy(logPath, 2);

  const run = runCli(["log", "verify", "--log", tampered], dir);
  assert.equal(run.code, 1);
  assert.equal(run.stdout, "");
  assert.equal(
    run.stderr,
    // APRV-102: the shared refusal shape (glyph, code, message).
    `✗ corrupt  hash-mismatch at seq 2\napproval: ${hashMismatchMessage(2)}\n`,
  );
});

test("log verify: torn tail exits 3 with the exact JSON shape", () => {
  const dir = caseDir();
  const logPath = buildLog(dir, 3);
  const torn = tornCopy(logPath);

  const run = runCli(["log", "verify", "--log", torn, "--json"], dir);
  assert.equal(run.code, 3);
  assert.deepEqual(json(run), {
    status: "torn-tail",
    records: 3,
    head: null,
    intactThroughSeq: 3,
    message: tornTailMessage(torn),
  });
});

test("log verify: unreadable log is an I/O error (exit 4), never corruption", { skip: RUNNING_AS_ROOT ? "running as root: permission bits are not enforced" : false }, () => {
  const dir = caseDir();
  const logPath = buildLog(dir, 2);
  chmodSync(logPath, 0o000);
  restoreOnExit.push(logPath);

  const run = runCli(["log", "verify"], dir);
  assert.equal(run.code, 4);
  assert.match(run.stderr, /not readable/);
  assert.doesNotMatch(run.stdout + run.stderr, /corrupt/i);
});

test("log verify: unreadable log in --json mode emits an io error object", { skip: RUNNING_AS_ROOT ? "running as root: permission bits are not enforced" : false }, () => {
  const dir = caseDir();
  const logPath = buildLog(dir, 2);
  chmodSync(logPath, 0o000);
  restoreOnExit.push(logPath);

  const run = runCli(["log", "verify", "--json"], dir);
  assert.equal(run.code, 4);
  assert.equal(run.stdout, "");
  const payload = jsonErr(run) as { error: { code: string; message: string } };
  assert.equal(payload.error.code, "io");
  assert.doesNotMatch(payload.error.message, /corrupt/i);
});

// --------------------------------------------------------------------------
// log tail
// --------------------------------------------------------------------------

test("log tail: defaults to the last 10 records", () => {
  const dir = caseDir();
  buildLog(dir, 12);

  const run = runCli(["log", "tail", "--json"], dir);
  assert.equal(run.code, 0);
  const payload = json(run) as { status: string; records: Array<{ seq: number }> };
  assert.equal(payload.status, "ok");
  assert.deepEqual(
    payload.records.map((record) => record.seq),
    [3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  );
  assert.deepEqual(Object.keys(payload), ["status", "records"]);
});

test("log tail: -n selects the count, oldest first", () => {
  const dir = caseDir();
  buildLog(dir, 5);

  const run = runCli(["log", "tail", "-n", "2", "--json"], dir);
  assert.equal(run.code, 0);
  const payload = json(run) as { status: string; records: Array<{ seq: number }> };
  assert.deepEqual(
    payload.records.map((record) => record.seq),
    [4, 5],
  );
});

test("log tail: -n 0 prints no records and exits 0", () => {
  const dir = caseDir();
  buildLog(dir, 3);

  const run = runCli(["log", "tail", "-n", "0", "--json"], dir);
  assert.equal(run.code, 0);
  assert.deepEqual(json(run), { status: "ok", records: [] });

  const human = runCli(["log", "tail", "-n", "0"], dir);
  assert.equal(human.code, 0);
  assert.equal(human.stdout, "");
});

test("log tail: human output is one line per record", () => {
  const dir = caseDir();
  buildLog(dir, 2);

  const run = runCli(["log", "tail"], dir);
  assert.equal(run.code, 0);
  const lines = run.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "1\t2026-08-04T09:01:00Z\ttask.registered\tagent:planner\ttask-01");
});

test("log tail: absent log prints nothing and exits 0", () => {
  const dir = caseDir();

  const run = runCli(["log", "tail"], dir);
  assert.equal(run.code, 0);
  assert.equal(run.stdout, "");

  const asJson = runCli(["log", "tail", "--json"], dir);
  assert.equal(asJson.code, 0);
  assert.deepEqual(json(asJson), { status: "ok", records: [] });
});

test("log tail: torn tail prints intact records, warns on stderr, exits 0", () => {
  const dir = caseDir();
  const logPath = buildLog(dir, 3);
  const torn = tornCopy(logPath);

  const run = runCli(["log", "tail", "--log", torn], dir);
  assert.equal(run.code, 0);
  assert.equal(run.stdout.trimEnd().split("\n").length, 3);
  assert.match(run.stderr, /torn line/);
  assert.match(run.stderr, /nothing was repaired or truncated/);
});

test("log tail: torn tail --json carries status torn-tail and a warning", () => {
  const dir = caseDir();
  const logPath = buildLog(dir, 3);
  const torn = tornCopy(logPath);

  const run = runCli(["log", "tail", "--log", torn, "--json"], dir);
  assert.equal(run.code, 0);
  const payload = json(run) as { status: string; records: unknown[]; warning: string };
  assert.deepEqual(Object.keys(payload), ["status", "records", "warning"]);
  assert.equal(payload.status, "torn-tail");
  assert.equal(payload.records.length, 3);
  assert.match(payload.warning, /torn line/);
});

test("log tail: corrupt log prints no records and exits 1", () => {
  const dir = caseDir();
  const logPath = buildLog(dir, 3);
  const tampered = tamperedCopy(logPath, 2);

  const run = runCli(["log", "tail", "--log", tampered], dir);
  assert.equal(run.code, 1);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /refusing to print records/);

  const asJson = runCli(["log", "tail", "--log", tampered, "--json"], dir);
  assert.equal(asJson.code, 1);
  assert.equal(asJson.stdout, "");
  const payload = jsonErr(asJson) as { error: { code: string } };
  assert.equal(payload.error.code, "integrity");
});

test("log tail: unreadable log exits 4 without saying corrupt", { skip: RUNNING_AS_ROOT ? "running as root: permission bits are not enforced" : false }, () => {
  const dir = caseDir();
  const logPath = buildLog(dir, 2);
  chmodSync(logPath, 0o000);
  restoreOnExit.push(logPath);

  const run = runCli(["log", "tail"], dir);
  assert.equal(run.code, 4);
  assert.doesNotMatch(run.stdout + run.stderr, /corrupt/i);
});

// --------------------------------------------------------------------------
// log export
// --------------------------------------------------------------------------

test("log export: output is byte-identical to the stored log", () => {
  const dir = caseDir();
  const logPath = buildLog(dir, 4);

  const run = runCli(["log", "export"], dir);
  assert.equal(run.code, 0);
  assert.equal(run.stdout, readFileSync(logPath, "utf8"));
  assert.equal(run.stderr, "");
});

test("log export: --json emits every record under a records key", () => {
  const dir = caseDir();
  const logPath = buildLog(dir, 3);

  const run = runCli(["log", "export", "--json"], dir);
  assert.equal(run.code, 0);
  const payload = json(run) as { records: unknown[] };
  assert.deepEqual(Object.keys(payload), ["records"]);
  assert.deepEqual(
    payload.records,
    readFileSync(logPath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line)),
  );
});

test("log export: torn tail exports the intact prefix verbatim and exits 0", () => {
  const dir = caseDir();
  const logPath = buildLog(dir, 3);
  const torn = tornCopy(logPath);

  const run = runCli(["log", "export", "--log", torn], dir);
  assert.equal(run.code, 0);
  // Exactly the complete lines: the torn fragment is not emitted.
  assert.equal(run.stdout, readFileSync(logPath, "utf8"));
  assert.match(run.stderr, /torn line/);
  // And the log itself is untouched.
  assert.equal(
    readFileSync(torn, "utf8"),
    `${readFileSync(logPath, "utf8")}{"seq":99,"ts":"2026-08-04T10:00`,
  );
});

test("log export: corrupt log prints nothing and exits 1", () => {
  const dir = caseDir();
  const logPath = buildLog(dir, 3);
  const tampered = tamperedCopy(logPath, 3);

  const run = runCli(["log", "export", "--log", tampered], dir);
  assert.equal(run.code, 1);
  assert.equal(run.stdout, "");
});

test("log export: absent log exits 0 with an empty records array", () => {
  const dir = caseDir();
  const run = runCli(["log", "export", "--json"], dir);
  assert.equal(run.code, 0);
  assert.deepEqual(json(run), { records: [] });
});

test("log export: unreadable log exits 4 without saying corrupt", { skip: RUNNING_AS_ROOT ? "running as root: permission bits are not enforced" : false }, () => {
  const dir = caseDir();
  const logPath = buildLog(dir, 2);
  chmodSync(logPath, 0o000);
  restoreOnExit.push(logPath);

  const run = runCli(["log", "export"], dir);
  assert.equal(run.code, 4);
  assert.doesNotMatch(run.stdout + run.stderr, /corrupt/i);
});

// --------------------------------------------------------------------------
// reindex
// --------------------------------------------------------------------------

test("reindex: builds the index and reports records and head", () => {
  const dir = caseDir();
  buildLog(dir, 3);

  const run = runCli(["reindex", "--json"], dir);
  assert.equal(run.code, 0);
  assert.deepEqual(json(run), {
    ok: true,
    records: 3,
    head: { seq: 3, hash: HEAD_AFTER_3.hash },
    truncated: false,
  });

  const indexPath = join(dir, ".approval", "index.sqlite");
  assert.equal(existsSync(indexPath), true);
  assert.deepEqual(indexHead(indexPath), {
    head: { seq: 3, hash: HEAD_AFTER_3.hash },
    truncated: false,
  });
});

test("reindex: human output names the record count and index path", () => {
  const dir = caseDir();
  buildLog(dir, 2);

  const run = runCli(["reindex"], dir);
  assert.equal(run.code, 0);
  assert.match(run.stdout, /^indexed 2 record\(s\) into .*index\.sqlite: head seq 2 [a-f0-9]{64}, truncated false\n$/);
});

test("reindex: honours --index", () => {
  const dir = caseDir();
  buildLog(dir, 1);
  const indexPath = join(dir, "elsewhere", "custom.sqlite");

  const run = runCli(["reindex", "--index", indexPath], dir);
  assert.equal(run.code, 0);
  assert.equal(existsSync(indexPath), true);
});

test("reindex: refuses a corrupt log with exit 1", () => {
  const dir = caseDir();
  const logPath = buildLog(dir, 3);
  const tampered = tamperedCopy(logPath, 1);

  const run = runCli(["reindex", "--log", tampered, "--json"], dir);
  assert.equal(run.code, 1);
  const payload = json(run) as { ok: boolean; error: { code: string; message: string } };
  assert.equal(payload.ok, false);
  assert.deepEqual(Object.keys(payload), ["ok", "error"]);
  assert.deepEqual(Object.keys(payload.error), ["code", "message"]);
  assert.equal(payload.error.code, "not-clean");
  assert.equal(existsSync(join(dir, ".approval", "index.sqlite")), false);
});

test("reindex: refuses a torn tail with exit 3", () => {
  const dir = caseDir();
  const logPath = buildLog(dir, 3);
  const torn = tornCopy(logPath);

  const run = runCli(["reindex", "--log", torn, "--json"], dir);
  assert.equal(run.code, 3);
  const payload = json(run) as { ok: boolean; error: { code: string } };
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "torn-tail");
});

test("reindex: --force indexes the intact prefix of a torn tail", () => {
  const dir = caseDir();
  const logPath = buildLog(dir, 3);
  const torn = tornCopy(logPath);

  const run = runCli(["reindex", "--log", torn, "--force", "--json"], dir);
  assert.equal(run.code, 0);
  const payload = json(run) as { ok: boolean; records: number; truncated: boolean };
  assert.equal(payload.ok, true);
  assert.equal(payload.records, 3);
  assert.equal(payload.truncated, true);
  assert.deepEqual(Object.keys(payload), ["ok", "records", "head", "truncated"]);
});

test("reindex: an unusable index path is an I/O error (exit 4)", () => {
  const dir = caseDir();
  const logPath = buildLog(dir, 2);
  // A path *under a file* can never be created: ENOTDIR, not tampering.
  const indexPath = join(logPath, "index.sqlite");

  const run = runCli(["reindex", "--index", indexPath, "--json"], dir);
  assert.equal(run.code, 4);
  const payload = json(run) as { ok: boolean; error: { code: string; message: string } };
  assert.equal(payload.error.code, "io");
  assert.doesNotMatch(payload.error.message, /corrupt/i);
});

test("reindex: unreadable log is an I/O error, not an integrity failure", { skip: RUNNING_AS_ROOT ? "running as root: permission bits are not enforced" : false }, () => {
  const dir = caseDir();
  const logPath = buildLog(dir, 2);
  chmodSync(logPath, 0o000);
  restoreOnExit.push(logPath);

  const run = runCli(["reindex"], dir);
  assert.equal(run.code, 4);
  assert.doesNotMatch(run.stdout + run.stderr, /corrupt/i);
});

// --------------------------------------------------------------------------
// usage errors
// --------------------------------------------------------------------------

test("usage: unknown command exits 2 with usage on stderr", () => {
  const dir = caseDir();
  const run = runCli(["frobnicate"], dir);
  assert.equal(run.code, 2);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /unknown command "frobnicate"/);
  assert.match(run.stderr, /Usage:/);
});

test("usage: unknown log subcommand exits 2", () => {
  const dir = caseDir();
  const run = runCli(["log", "squash"], dir);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /unknown subcommand "squash"/);
});

test("usage: bare invocation exits 2 with usage", () => {
  const dir = caseDir();
  const run = runCli([], dir);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /no command given/);
});

test("usage: `approval log` with no subcommand exits 2", () => {
  const dir = caseDir();
  const run = runCli(["log"], dir);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /missing subcommand/);
});

test("usage: unknown flag exits 2", () => {
  const dir = caseDir();
  const run = runCli(["log", "verify", "--jsno"], dir);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /unknown flag --jsno/);
});

test("usage: a flag missing its value exits 2", () => {
  const dir = caseDir();
  const run = runCli(["log", "verify", "--log"], dir);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /requires a value/);
});

test("usage: a bad -n exits 2", () => {
  const dir = caseDir();
  buildLog(dir, 2);

  const run = runCli(["log", "tail", "-n", "abc"], dir);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /non-negative integer/);

  const negative = runCli(["log", "tail", "-n", "-1"], dir);
  assert.equal(negative.code, 2);
});

test("usage: --json usage errors emit a JSON error object on stderr", () => {
  const dir = caseDir();
  const run = runCli(["log", "tail", "-n", "abc", "--json"], dir);
  assert.equal(run.code, 2);
  assert.equal(run.stdout, "");
  assert.deepEqual(Object.keys(jsonErr(run) as object), ["error"]);
  assert.equal((jsonErr(run) as { error: { code: string } }).error.code, "usage");
});

test("usage: an unexpected positional argument exits 2", () => {
  const dir = caseDir();
  const run = runCli(["reindex", "extra"], dir);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /unexpected argument "extra"/);
});

// --------------------------------------------------------------------------
// help
// --------------------------------------------------------------------------

const HELP_INVOCATIONS: Array<[string, string[]]> = [
  ["root", ["--help"]],
  ["log", ["log", "--help"]],
  ["verify", ["log", "verify", "--help"]],
  ["tail", ["log", "tail", "--help"]],
  ["export", ["log", "export", "--help"]],
  ["reindex", ["reindex", "--help"]],
];

// APRV-91 moved the frozen table into `approval --help` alone: a per-verb help
// points at it rather than reprinting it, so the assertion splits in two.
for (const [name, args] of HELP_INVOCATIONS) {
  test(`help: ${name} --help documents the exit codes and the JSON shape`, () => {
    const dir = caseDir();
    const run = runCli(args, dir);
    assert.equal(run.code, 0);
    assert.equal(run.stderr, "");
    if (name === "root") {
      assert.match(run.stdout, /Exit codes \(frozen public API\)/);
      for (const code of ["0  success", "1  integrity failure", "2  usage error", "3  torn tail", "4  I/O error"]) {
        assert.ok(run.stdout.includes(code), `${name} --help is missing "${code}"`);
      }
    } else {
      assert.doesNotMatch(
        run.stdout,
        /Exit codes \(frozen public API\)/,
        `${name} --help reprints the frozen table; it belongs to "approval --help" alone`,
      );
      assert.match(run.stdout, /exit codes: approval --help/);
    }
    assert.match(run.stdout, /--json/);
    assert.match(run.stdout, /JSON|Machine-readable/);
    assert.match(run.stdout, /Usage:/);
  });
}

test("help: -h is accepted wherever --help is", () => {
  const dir = caseDir();
  assert.equal(runCli(["-h"], dir).code, 0);
  assert.equal(runCli(["log", "-h"], dir).code, 0);
  assert.equal(runCli(["log", "verify", "-h"], dir).code, 0);
});

// --------------------------------------------------------------------------
// bin entry
// --------------------------------------------------------------------------

test("bin: cli.js runs the compiled CLI", () => {
  const dir = caseDir();
  buildLog(dir, 2);

  const run = runCli(["log", "verify", "--json"], dir, BIN_ENTRY);
  assert.equal(run.code, 0);
  const payload = json(run) as { status: string; records: number };
  assert.equal(payload.status, "clean");
  assert.equal(payload.records, 2);
});

test("bin: cli.js without a build exits 4 and says to build", () => {
  const dir = caseDir();
  const copied = join(dir, "cli.js");
  copyFileSync(BIN_ENTRY, copied);
  assert.equal(existsSync(join(dirname(copied), "dist")), false);

  const run = runCli([], dir, copied);
  assert.equal(run.code, 4);
  assert.match(run.stderr, /npm run build/);
});
