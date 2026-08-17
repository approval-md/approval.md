/**
 * `approval init` CLI tests (APRV-71) — spawned as a real child process,
 * because what is under test is what a human's first invocation actually leaves
 * on disk.
 *
 * Three assertions carry the weight.
 *
 * **The scaffolded policy IS the frozen fixture.** `init` embeds SPEC.md §5.1's
 * canonical example, and the same bytes live in
 * `schema/fixtures/policy-md/valid/canonical.md`, from which every
 * policy-loading test descends. Two copies of a document drift; a test that
 * compares them byte for byte is what keeps the scaffold, the fixtures and the
 * spec section describing one policy rather than three. The chain is closed at
 * the far end too: the fixture's policy half is asserted to appear in SPEC.md
 * verbatim.
 *
 * **The queue file IS the renderer's output.** `init` calls
 * `channels/render-queue.ts` rather than writing a header that looks like it.
 * The test proves it by reading the `Evaluated at` instant out of the written
 * file and re-rendering with that same instant: the renderer is a pure function
 * of (log, policy, now), so the bytes must match exactly. A hand-written header
 * could not survive this.
 *
 * **A re-run writes nothing.** Idempotence is not "it does not crash"; it is
 * "every byte is where it was". So the re-run case hashes all three files
 * before and after.
 *
 * Everything happens in a temp directory. Nothing here touches this
 * repository's own `APPROVAL.md`, `.approval/`, or `.gitignore`, and no test in
 * this file appends to any log.
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

import { renderQueue } from "../src/channels/render-queue.js";
import { EXIT_IO, EXIT_OK, EXIT_USAGE } from "../src/cli/exit-codes.js";
import { ROOT_HELP } from "../src/cli/help.js";
import {
  CANONICAL_POLICY,
  GITIGNORE_ENTRIES,
  GITIGNORE_MARKER,
} from "../src/cli/scaffold.js";

/** dist/tests/cli-init.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

/** The repository root, from `dist/tests/` at runtime. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const FIXTURE_PATH = join(REPO_ROOT, "schema", "fixtures", "policy-md", "valid", "canonical.md");

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-cli-init-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string): Run {
  const childEnv = { ...process.env };
  delete childEnv["APPROVAL_HUMAN"];
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: childEnv,
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function caseDir(): string {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface InitJson {
  ok: boolean;
  dir: string;
  written: string[];
  existing: Array<{ path: string; code: string }>;
  next_steps: string[];
}

function initJson(dir: string, args: string[] = []): { run: Run; parsed: InitJson } {
  const run = runCli(["init", "--json", ...args], dir);
  assert.equal(run.code, EXIT_OK, `init --json exited ${run.code}: ${run.stderr}`);
  return { run, parsed: JSON.parse(run.stdout) as InitJson };
}

const GITIGNORE_BLOCK = `${GITIGNORE_MARKER}\n${GITIGNORE_ENTRIES.join("\n")}\n`;

// ---------------------------------------------------------------------------
// The empty directory
// ---------------------------------------------------------------------------

test("init in an empty directory writes all four targets and exits 0", () => {
  const dir = caseDir();
  const run = runCli(["init"], dir);

  assert.equal(run.code, EXIT_OK, run.stderr);
  assert.ok(existsSync(join(dir, "APPROVAL.md")), "APPROVAL.md was not written");
  assert.ok(existsSync(join(dir, ".approval", "log")), ".approval/log/ was not created");
  assert.ok(existsSync(join(dir, ".approval", "QUEUE.md")), "QUEUE.md was not written");
  assert.ok(existsSync(join(dir, ".gitignore")), ".gitignore was not written");
  assert.match(run.stdout, /Next steps:/u, "the human output does not print the next steps");
});

test("the log DIRECTORY is created and left empty — attest creates events.jsonl", () => {
  const dir = caseDir();
  runCli(["init"], dir);

  assert.deepEqual(
    readdirSync(join(dir, ".approval", "log")),
    [],
    "init put something in the log directory. The first `approval policy attest` creates events.jsonl; a scaffolded log line is a chain nobody signed.",
  );
  assert.ok(
    runCli(["init"], dir).stdout.includes("attest"),
    "the next steps must say which command creates the log",
  );
});

test("the scaffolded APPROVAL.md is the frozen canonical fixture, byte for byte", () => {
  const dir = caseDir();
  runCli(["init"], dir);

  const written = readFileSync(join(dir, "APPROVAL.md"), "utf8");
  const fixture = readFileSync(FIXTURE_PATH, "utf8");

  assert.equal(
    written,
    fixture,
    "the policy `approval init` scaffolds is no longer schema/fixtures/policy-md/valid/canonical.md. Those bytes are the SPEC.md §5.1 canonical example and the ancestor of every policy fixture; init emitting anything else hands a new user a policy the documentation does not describe.",
  );
  assert.equal(CANONICAL_POLICY, fixture, "src/cli/scaffold.ts drifted from the fixture");
});

test("the fixture's policy half is SPEC.md §5.1 verbatim", () => {
  const fixture = readFileSync(FIXTURE_PATH, "utf8");
  const close = fixture.indexOf("\n```\n", fixture.indexOf("yaml approval-policy"));
  assert.ok(close > 0, "the fixture no longer contains a closed yaml approval-policy block");
  const policyHalf = fixture.slice(0, close + "\n```\n".length);

  assert.ok(
    readFileSync(join(REPO_ROOT, "SPEC.md"), "utf8").includes(policyHalf),
    "SPEC.md no longer contains the canonical fixture's policy text verbatim. The scaffold, the fixture and §5.1 are one document in three places; when they disagree the spec is right and the other two must move.",
  );
});

test("QUEUE.md is the real renderer's empty state, not an imitation of it", () => {
  const dir = caseDir();
  runCli(["init"], dir);

  const written = readFileSync(join(dir, ".approval", "QUEUE.md"), "utf8");
  const evaluated = /\*\*Evaluated at\*\*[^\n]*\): `([^`]+)`/u.exec(written);
  assert.ok(evaluated !== null, "QUEUE.md has no `Evaluated at` line to re-render from");

  const rendered = renderQueue(
    join(dir, ".approval", "log", "events.jsonl"),
    { policy: { dir } },
    evaluated[1] as string,
  );
  assert.ok(rendered.ok, "the renderer refused the scaffolded directory");
  assert.equal(
    written,
    rendered.markdown,
    "the QUEUE.md init writes is not what channels/render-queue.ts produces for the same log, policy and instant. init must call the renderer; a second implementation of the projection would start disagreeing with `approval render` immediately.",
  );
  assert.ok(written.includes("_Nothing is awaiting a decision._"), "not the empty state");
  assert.ok(written.includes("_empty log_"), "the empty log is not reported as empty");
});

test("the .gitignore lines are the index, the vault and the temp files, under one marker", () => {
  const dir = caseDir();
  runCli(["init"], dir);

  assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), GITIGNORE_BLOCK);
});

test(".approval/payloads/ is NOT ignored, and both halves of the choice are printed", () => {
  const dir = caseDir();
  const { run, parsed } = initJson(dir);

  assert.ok(
    !readFileSync(join(dir, ".gitignore"), "utf8").includes("payloads"),
    "init ignored the payload store. Payloads are the bytes an approval bound to; evidence defaults to tracked.",
  );
  const note = parsed.next_steps.find((step) => step.includes(".approval/payloads/"));
  assert.ok(note !== undefined, "no next step explains the payload-tracking choice");
  assert.ok(
    note.includes("TRACKED") && note.includes(".gitignore"),
    "the payload note must state the default AND the one-line alternative",
  );
  assert.equal(run.stderr, "", "a successful init prints nothing on stderr");
});

// ---------------------------------------------------------------------------
// Idempotence
// ---------------------------------------------------------------------------

test("a re-run writes nothing, reports what exists, exits 0, and changes no byte", () => {
  const dir = caseDir();
  runCli(["init"], dir);

  const paths = [
    join(dir, "APPROVAL.md"),
    join(dir, ".approval", "QUEUE.md"),
    join(dir, ".gitignore"),
  ];
  const before = paths.map((path) => readFileSync(path, "utf8"));

  const { run, parsed } = initJson(dir);
  assert.equal(run.code, EXIT_OK);
  assert.deepEqual(parsed.written, [], "a second init wrote something");
  assert.deepEqual(
    parsed.existing,
    [
      { path: "APPROVAL.md", code: "policy-exists" },
      { path: ".approval/log/", code: "log-dir-exists" },
      { path: ".approval/QUEUE.md", code: "queue-exists" },
      { path: ".gitignore", code: "gitignore-entries-present" },
    ],
    "the per-target `existing` codes drifted",
  );
  assert.deepEqual(
    paths.map((path) => readFileSync(path, "utf8")),
    before,
    "a re-run of init modified a file that already existed",
  );

  const human = runCli(["init"], dir);
  assert.ok(
    human.stdout.includes("nothing written"),
    "the human output of a no-op run must say nothing was written",
  );
});

test("an existing APPROVAL.md is left byte-identical and the rest is still scaffolded", () => {
  const dir = caseDir();
  const mine = "# My policy\n\nNo fenced block yet, on purpose.\n";
  writeFileSync(join(dir, "APPROVAL.md"), mine, "utf8");

  const { parsed } = initJson(dir);

  assert.equal(
    readFileSync(join(dir, "APPROVAL.md"), "utf8"),
    mine,
    "init overwrote an existing policy file",
  );
  assert.deepEqual(parsed.existing, [{ path: "APPROVAL.md", code: "policy-exists" }]);
  assert.deepEqual(parsed.written, [".approval/log/", ".approval/QUEUE.md", ".gitignore"]);
});

test("APPROVALS.md is a policy too: init reports policy-exists and writes no APPROVAL.md", () => {
  const dir = caseDir();
  writeFileSync(join(dir, "APPROVALS.md"), "# Policy\n", "utf8");

  const { parsed } = initJson(dir);

  assert.ok(
    !existsSync(join(dir, "APPROVAL.md")),
    "init wrote APPROVAL.md beside an APPROVALS.md, which SPEC.md §5 says would silently take precedence over the file the human wrote",
  );
  assert.deepEqual(parsed.existing, [{ path: "APPROVALS.md", code: "policy-exists" }]);
});

test("an existing QUEUE.md is never regenerated", () => {
  const dir = caseDir();
  mkdirSync(join(dir, ".approval"), { recursive: true });
  const mine = "not a real queue\n";
  writeFileSync(join(dir, ".approval", "QUEUE.md"), mine, "utf8");

  const { parsed } = initJson(dir);

  assert.equal(readFileSync(join(dir, ".approval", "QUEUE.md"), "utf8"), mine);
  assert.ok(parsed.existing.some((entry) => entry.code === "queue-exists"));
});

// ---------------------------------------------------------------------------
// The .gitignore merge — the one file init is allowed to touch
// ---------------------------------------------------------------------------

test("an existing .gitignore is merged: unrelated lines survive, the marker appears once", () => {
  const dir = caseDir();
  const original = "node_modules/\ndist/\n\n# my own section\n*.log\n";
  writeFileSync(join(dir, ".gitignore"), original, "utf8");

  runCli(["init"], dir);
  const merged = readFileSync(join(dir, ".gitignore"), "utf8");

  assert.ok(merged.startsWith(original), "init rewrote or reordered existing .gitignore lines");
  for (const entry of GITIGNORE_ENTRIES) {
    assert.ok(merged.includes(`\n${entry}\n`), `the merge dropped ${entry}`);
  }

  runCli(["init"], dir);
  const twice = readFileSync(join(dir, ".gitignore"), "utf8");
  assert.equal(twice, merged, "a second init changed .gitignore again");
  assert.equal(
    twice.split("\n").filter((line) => line.trim() === GITIGNORE_MARKER).length,
    1,
    "the approval.md marker comment was written twice",
  );
});

test("a .gitignore that already carries one entry gets only the missing ones", () => {
  const dir = caseDir();
  writeFileSync(join(dir, ".gitignore"), `${GITIGNORE_ENTRIES[0] as string}\n`, "utf8");

  const { parsed } = initJson(dir);
  const merged = readFileSync(join(dir, ".gitignore"), "utf8");

  assert.ok(parsed.written.includes(".gitignore"));
  for (const entry of GITIGNORE_ENTRIES) {
    assert.equal(
      merged.split("\n").filter((line) => line === entry).length,
      1,
      `${entry} appears more than once after the merge`,
    );
  }
});

// ---------------------------------------------------------------------------
// Path conflicts — the one refusal
// ---------------------------------------------------------------------------

function assertConflict(dir: string, what: string): void {
  const run = runCli(["init", "--json"], dir);
  assert.equal(run.code, EXIT_IO, `${what}: expected exit ${EXIT_IO}, got ${run.code}`);
  assert.equal(run.stdout, "", `${what}: a refusal printed to stdout`);
  const parsed = JSON.parse(run.stderr) as { error: { code: string; message: string } };
  assert.equal(parsed.error.code, "path-conflict", what);
}

test("a directory named APPROVAL.md is a path-conflict, and nothing is written", () => {
  const dir = caseDir();
  mkdirSync(join(dir, "APPROVAL.md"));

  assertConflict(dir, "APPROVAL.md as a directory");
  assert.deepEqual(
    readdirSync(dir).sort(),
    ["APPROVAL.md"],
    "init wrote something despite refusing: the plan-then-write order is broken",
  );
});

test("a FILE named .approval is a path-conflict", () => {
  const dir = caseDir();
  writeFileSync(join(dir, ".approval"), "not a directory\n", "utf8");

  assertConflict(dir, ".approval as a file");
  assert.ok(!existsSync(join(dir, "APPROVAL.md")), "init scaffolded a policy despite refusing");
});

test("a FILE where .approval/log/ belongs is a path-conflict", () => {
  const dir = caseDir();
  mkdirSync(join(dir, ".approval"));
  writeFileSync(join(dir, ".approval", "log"), "not a directory\n", "utf8");

  assertConflict(dir, ".approval/log as a file");
});

test("a directory named .gitignore is a path-conflict", () => {
  const dir = caseDir();
  mkdirSync(join(dir, ".gitignore"));

  assertConflict(dir, ".gitignore as a directory");
});

// ---------------------------------------------------------------------------
// The frozen surface: --json, --dir, help, usage
// ---------------------------------------------------------------------------

test("the --json shape is exactly {ok, dir, written, existing, next_steps}", () => {
  const dir = caseDir();
  const { parsed } = initJson(dir);

  assert.deepEqual(Object.keys(parsed).sort(), [
    "dir",
    "existing",
    "next_steps",
    "ok",
    "written",
  ]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.dir, realpathSync(dir));
  assert.deepEqual(parsed.written, [
    "APPROVAL.md",
    ".approval/log/",
    ".approval/QUEUE.md",
    ".gitignore",
  ]);
  assert.deepEqual(parsed.existing, []);
  assert.equal(parsed.next_steps.length, 4);
  assert.ok(parsed.next_steps.some((step) => step.includes("approval policy attest")));
  assert.ok(parsed.next_steps.some((step) => step.includes("approval doctor")));
});

test("--dir scaffolds somewhere else and leaves the working directory alone", () => {
  const dir = caseDir();
  const target = join(dir, "elsewhere");
  mkdirSync(target);

  const { parsed } = initJson(dir, ["--dir", "elsewhere"]);

  assert.equal(parsed.dir, join(realpathSync(dir), "elsewhere"));
  assert.ok(existsSync(join(target, "APPROVAL.md")));
  assert.deepEqual(readdirSync(dir), ["elsewhere"], "init wrote into the working directory too");
});

test("init --help prints the help and exits 0; the root help lists the verb", () => {
  const dir = caseDir();
  const run = runCli(["init", "--help"], dir);

  assert.equal(run.code, EXIT_OK);
  assert.match(run.stdout, /approval init \[--dir <path>\] \[--json\]/u);
  assert.match(run.stdout, /path-conflict/u, "the help does not document the refusal");
  assert.match(run.stdout, /"next_steps"/u, "the help does not document the --json shape");
  assert.deepEqual(readdirSync(dir), [], "--help wrote something");

  assert.match(ROOT_HELP, /approval init\s+\[--dir <path>\] \[--json\]/u);
  assert.match(ROOT_HELP, /\n {2}init {6}scaffold a working directory/u);
});

test("an unknown flag is a usage error and writes nothing", () => {
  const dir = caseDir();
  const run = runCli(["init", "--force"], dir);

  assert.equal(run.code, EXIT_USAGE);
  assert.deepEqual(readdirSync(dir), []);
});
