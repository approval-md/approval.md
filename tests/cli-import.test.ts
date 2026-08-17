/**
 * `approval import agents-md` CLI tests (APRV-64) — spawned as a real child
 * process, because what is under test is what an agent or a human observes: the
 * bytes on stdout, the `--json` shape, the exit code, and above all the things
 * this verb must NEVER do.
 *
 * The load-bearing cases are the negative ones. `writes nothing anywhere`
 * imports a permissions section in a directory that has an APPROVAL.md and a
 * log, and asserts both are byte-identical afterwards: a verb that generates
 * policy is the most attractive thing in the repository to point at the policy
 * file, so "it prints" has to be a tested property rather than a claim in a
 * doc comment. `refuses to overwrite` covers the same ground for `--out`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

/** dist/tests/cli-import.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
/** The repository root, from `dist/tests/` at runtime. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURE_DIR = join(REPO_ROOT, "tests", "fixtures", "agents-md");

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-cli-import-")));
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
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], { cwd, encoding: "utf8" });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function caseDir(): string {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function fixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

/** Run against a fixture from the repository root, so paths stay stable. */
function importFixture(name: string, extra: string[] = []): Run {
  return runCli(
    ["import", "agents-md", `tests/fixtures/agents-md/${name}`, ...extra],
    REPO_ROOT,
  );
}

// ---------------------------------------------------------------------------
// Output

test("prints the pinned fenced draft for the CLAUDE.md permissions fixture", () => {
  const run = importFixture("claude-md-permissions.md");
  assert.equal(run.code, 0);
  assert.equal(
    run.stdout,
    `\`\`\`yaml approval-policy\n${fixture("claude-md-permissions.expected.yaml")}\`\`\`\n`,
  );
  assert.match(run.stderr, /DRAFT and authorizes nothing/u);
});

test("prints the pinned fenced draft for the tolerant-variants fixture", () => {
  const run = importFixture("tolerant-variants.md");
  assert.equal(run.code, 0);
  assert.equal(
    run.stdout,
    `\`\`\`yaml approval-policy\n${fixture("tolerant-variants.expected.yaml")}\`\`\`\n`,
  );
  assert.match(run.stderr, /ignored heading "House style"/u);
  assert.match(run.stderr, /stricter autonomy wins/u);
});

test("a source with no permissions section is exit 0 with an empty draft", () => {
  const run = importFixture("no-permissions.md");
  assert.equal(run.code, 0);
  assert.ok(run.stdout.includes("# No classes:"));
  assert.match(run.stderr, /no permissions section found/u);
});

// ---------------------------------------------------------------------------
// The --json shape (frozen public API)

test("--json prints exactly the documented shape", () => {
  const run = importFixture("tolerant-variants.md", ["--json"]);
  assert.equal(run.code, 0);
  const value = JSON.parse(run.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(value), [
    "ok",
    "source",
    "out",
    "classes",
    "unmapped",
    "ignored",
    "warnings",
  ]);
  assert.equal(value["ok"], true);
  assert.equal(value["source"], "tests/fixtures/agents-md/tolerant-variants.md");
  assert.equal(value["out"], null);
  assert.deepEqual(value["classes"], [
    {
      class: "read.*",
      autonomy: "autonomous",
      from: "Read the docs directory and search the codebase",
      section: "allowed",
    },
    {
      class: "data.delete",
      autonomy: "manual",
      from: "Deleting anything under data/",
      section: "approval-first",
    },
    {
      class: "network.call",
      autonomy: "manual",
      from: "Any outbound webhook",
      section: "approval-first",
    },
    {
      class: "account.credential",
      autonomy: "manual",
      from: "Touch the deployment vault",
      section: "never",
    },
  ]);
  assert.deepEqual(value["unmapped"], [
    { text: "Feed the plants on the third floor", section: "never" },
  ]);
  assert.deepEqual(value["ignored"], ["House style"]);
  assert.equal((value["warnings"] as string[]).length, 2);
});

test("--json prints nothing to stdout on a usage error", () => {
  const run = runCli(["import", "agents-md", "--json"], REPO_ROOT);
  assert.equal(run.code, 2);
  assert.equal(run.stdout, "");
  const error = JSON.parse(run.stderr) as { error: { code: string; message: string } };
  assert.equal(error.error.code, "usage");
  assert.match(error.error.message, /missing <file>/u);
});

// ---------------------------------------------------------------------------
// --out

test("--out writes the bare YAML and prints no draft", () => {
  const dir = caseDir();
  const run = runCli(
    [
      "import",
      "agents-md",
      join(FIXTURE_DIR, "tolerant-variants.md"),
      "--out",
      "draft.yaml",
    ],
    dir,
  );
  assert.equal(run.code, 0);
  assert.match(run.stdout, /^wrote draft policy YAML to draft\.yaml\n$/u);
  const written = readFileSync(join(dir, "draft.yaml"), "utf8");
  assert.ok(!written.startsWith("```"));
  assert.ok(written.includes("version: \"0.1\""));
  assert.ok(written.endsWith("\n"));
});

test("--out refuses to overwrite an existing file, with a distinct message", () => {
  const dir = caseDir();
  writeFileSync(join(dir, "draft.yaml"), "PRECIOUS\n", "utf8");
  const run = runCli(
    ["import", "agents-md", join(FIXTURE_DIR, "no-permissions.md"), "--out", "draft.yaml"],
    dir,
  );
  assert.equal(run.code, 4);
  assert.match(run.stderr, /refusing to overwrite draft\.yaml/u);
  assert.equal(readFileSync(join(dir, "draft.yaml"), "utf8"), "PRECIOUS\n");
});

// ---------------------------------------------------------------------------
// What the verb must never do

test("writes nothing anywhere: APPROVAL.md and the log are untouched", () => {
  const dir = caseDir();
  const policy = ["# Policy", "", "```yaml approval-policy", 'version: "0.1"', "```", ""].join(
    "\n",
  );
  writeFileSync(join(dir, "APPROVAL.md"), policy, "utf8");
  mkdirSync(join(dir, ".approval", "log"), { recursive: true });
  writeFileSync(join(dir, ".approval", "log", "events.jsonl"), "", "utf8");
  writeFileSync(join(dir, "AGENTS.md"), fixture("claude-md-permissions.md"), "utf8");

  const run = runCli(["import", "agents-md", "AGENTS.md"], dir);
  assert.equal(run.code, 0);
  assert.equal(readFileSync(join(dir, "APPROVAL.md"), "utf8"), policy);
  assert.equal(readFileSync(join(dir, ".approval", "log", "events.jsonl"), "utf8"), "");
});

test("a missing source file is exit 4, not a silent empty draft", () => {
  const run = runCli(["import", "agents-md", "nope.md"], caseDir());
  assert.equal(run.code, 4);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /nope\.md could not be read/u);
});

// ---------------------------------------------------------------------------
// Dispatch and help

test("help is available at both levels and lists the verb at the root", () => {
  const root = runCli(["--help"], REPO_ROOT);
  assert.equal(root.code, 0);
  assert.match(root.stdout, /approval import agents-md <file>/u);

  const group = runCli(["import", "--help"], REPO_ROOT);
  assert.equal(group.code, 0);
  assert.match(group.stdout, /approval import — turn existing permissions prose/u);

  const verb = runCli(["import", "agents-md", "--help"], REPO_ROOT);
  assert.equal(verb.code, 0);
  assert.match(verb.stdout, /"unmapped":\[\{"text","section"\}\]/u);
  assert.match(verb.stdout, /THE DRAFT AUTHORIZES NOTHING/u);
});

test("an unknown subcommand is a usage error", () => {
  const run = runCli(["import", "codex-md", "x.md"], REPO_ROOT);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /unknown subcommand "codex-md"/u);
});

test("a missing subcommand is a usage error", () => {
  const run = runCli(["import"], REPO_ROOT);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /missing subcommand for `approval import`/u);
});
