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

// The two real loaders, so a `--out` file is checked by what would actually
// read it rather than by a regex over its bytes (APRV-240).
import { loadPolicy } from "../src/core/policy-load.js";
import { loadValuesText } from "../src/core/values.js";

/** dist/tests/cli-import.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
/** The repository root, from `dist/tests/` at runtime. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURE_DIR = join(REPO_ROOT, "tests", "fixtures", "agents-md");
const SCHEMA_DIR = join(REPO_ROOT, "schema");

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
    "values_draft",
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
  // APRV-240: this source names none of the four values headings, so the
  // answer is null. An empty draft would be the verb declaring values nobody
  // wrote down.
  assert.equal(value["values_draft"], null);
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

// ---------------------------------------------------------------------------
// The values draft (APRV-240)

test("stdout prints the values fence after the policy draft, byte for byte", () => {
  const run = importFixture("values-headings.md");
  assert.equal(run.code, 0);
  assert.equal(run.stdout, fixture("values-headings.expected.md"));
  // Order matters to a reader: the policy block first, the values block after.
  const policyAt = run.stdout.indexOf("```yaml approval-policy");
  const valuesAt = run.stdout.indexOf("```yaml approval-values");
  assert.ok(policyAt >= 0 && valuesAt > policyAt, run.stdout.slice(0, 80));
  assert.match(run.stderr, /nothing is graded/u);
  assert.match(run.stderr, /invalidates the standing attestation/u);
});

test("a source with no values heading prints no values fence at all", () => {
  const run = importFixture("claude-md-permissions.md");
  assert.equal(run.code, 0);
  assert.ok(!run.stdout.includes("approval-values"), run.stdout);
  assert.ok(!run.stderr.includes("nothing is graded"), run.stderr);
});

test("--json carries the values draft, and it is the fence and nothing else", () => {
  const run = importFixture("values-headings.md", ["--json"]);
  assert.equal(run.code, 0);
  const value = JSON.parse(run.stdout) as Record<string, unknown>;
  const draft = value["values_draft"];
  assert.equal(typeof draft, "string");
  const text = draft as string;
  assert.ok(text.startsWith("```yaml approval-values\n"), text.slice(0, 40));
  assert.ok(text.endsWith("```\n"));
  assert.ok(!text.includes("approval-policy"));
  assert.ok(text.includes("wants:"));
  // The negative property, on the wire: no grade was invented.
  assert.ok(!/^\s*(love|like|dislike):/mu.test(text), text);
  const warnings = value["warnings"] as string[];
  assert.ok(warnings.some((warning) => warning.includes("repeated values")));
  assert.ok(warnings.some((warning) => warning.includes("215 characters")));
});

test("--out writes both blocks, and the file loads as a policy and as values", () => {
  const dir = caseDir();
  const run = runCli(
    ["import", "agents-md", join(FIXTURE_DIR, "values-headings.md"), "--out", "draft.md"],
    dir,
  );
  assert.equal(run.code, 0);
  assert.match(run.stdout, /^wrote draft policy and values blocks to draft\.md\n$/u);

  const path = join(dir, "draft.md");
  const written = readFileSync(path, "utf8");
  assert.ok(written.startsWith("```yaml approval-policy\n"));
  assert.ok(written.includes("```yaml approval-values\n"));

  // The point of fencing the policy half once there are two blocks: the file
  // the human is handed loads through the real loaders, unedited.
  const policy = loadPolicy({ file: path, schemaDir: SCHEMA_DIR });
  assert.ok(policy.ok, policy.ok ? "" : `${policy.code}: ${policy.message}`);
  assert.equal(policy.policy.version, "0.1");
  assert.equal(policy.policy.defaults?.autonomy, "manual");

  const values = loadValuesText(path, written, { schemaDir: SCHEMA_DIR });
  assert.ok(values.ok, values.ok ? "" : values.message);
  assert.ok(values.present);
  assert.equal(values.values.version, 1);
  assert.equal(values.values.love, undefined);
  assert.equal(values.values.like, undefined);
  assert.equal(values.values.dislike, undefined);
  assert.ok((values.values.wants ?? []).includes("The failing case lands first, then the fix"));
});
