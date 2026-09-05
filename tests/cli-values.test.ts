/**
 * `approval values` (APRV-238) — the human's half of the ungated pair, pinned.
 *
 * The properties under test are the ones the verb is worthless without, and
 * every one of them erodes silently:
 *
 *  1. **The banner is on every output form.** Human and JSON, present, absent
 *     and broken. A surface that stopped saying what these words are would hand
 *     an agent human-authored prose with no statement of its standing.
 *  2. **Absence is said in the words SPEC.md §5.3 fixes.** Exactly
 *     `the operator has declared no values here.`, so a session can tell that
 *     from never having looked.
 *  3. **A broken block exits 1 with its code**, and says to treat it as absent.
 *     Not 0 with an empty answer, which is indistinguishable from absence.
 *  4. **`--json` matches the registry's declared output schema**, compiled from
 *     the registry rather than restated here.
 *  5. **`--policy` and `--dir` resolve as they do for `policy check`.**
 *
 * Spawned as real child processes, because what is under test is what an agent
 * and an operator actually observe.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
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

import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";

import { NO_VALUES_SENTENCE, VALUES_BANNER } from "../src/cli/values.js";
import { VERB_REGISTRY, verbLabel, type JsonSchema } from "../src/cli/verb-registry.js";
import { DEFAULT_SCHEMA_DIR } from "../src/core/validate.js";
import { VALUES_INFO_STRING } from "../src/core/values.js";

const addFormats = (addFormatsModule as unknown as { default: FormatsPlugin }).default;

/** dist/tests/cli-values.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
const FIXTURES = join(DEFAULT_SCHEMA_DIR, "fixtures", "values-md");

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-values-cli-")));
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
  const env = { ...process.env };
  delete env["APPROVAL_HUMAN"];
  delete env["APPROVAL_AGENT"];
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], { cwd, encoding: "utf8", env });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function caseDir(): string {
  counter += 1;
  const dir = join(scratch, `case-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A working directory holding `APPROVAL.md` copied from one fixture. */
function dirWith(...fixture: string[]): string {
  const dir = caseDir();
  copyFileSync(join(FIXTURES, ...fixture), join(dir, "APPROVAL.md"));
  return dir;
}

function fixture(...segments: string[]): string {
  return join(FIXTURES, ...segments);
}

/** The registry's declared output schema for this verb, compiled. */
function outputValidator(): (value: unknown) => boolean {
  const spec = VERB_REGISTRY.find((entry) => verbLabel(entry) === "values");
  assert.ok(spec !== undefined, "the registry does not carry `values`");
  assert.ok(spec.output !== null, "`values` declares no output schema");
  const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: true });
  addFormats(ajv);
  return ajv.compile(spec.output as JsonSchema) as (value: unknown) => boolean;
}

/** The four broken fixtures, with the code each must report. */
const BROKEN: readonly { readonly file: string; readonly code: string }[] = [
  { file: "two-blocks.md", code: "multiple-blocks" },
  { file: "unterminated.md", code: "unterminated-fence" },
  { file: "yaml-error.md", code: "yaml-error" },
  { file: "schema-invalid.md", code: "schema-invalid" },
];

// ---------------------------------------------------------------------------
// 1. The banner, on every output form
// ---------------------------------------------------------------------------

test("values: every output form carries the banner", () => {
  const present = runCli(["values", "--policy", fixture("valid", "with-values.md")], caseDir());
  assert.equal(present.code, 0);
  assert.ok(present.stdout.startsWith(VALUES_BANNER), "the human present form lost the banner");

  const absent = runCli(["values", "--policy", fixture("valid", "absent.md")], caseDir());
  assert.equal(absent.code, 0);
  assert.ok(absent.stdout.startsWith(VALUES_BANNER), "the human absent form lost the banner");

  for (const name of ["with-values.md", "absent.md"]) {
    const parsedNote = JSON.parse(
      runCli(["values", "--policy", fixture("valid", name), "--json"], caseDir()).stdout,
    ) as { note: string };
    assert.equal(parsedNote.note, VALUES_BANNER, `the --json form of ${name} lost the banner`);
  }

  const broken = runCli(["values", "--policy", fixture("invalid", "yaml-error.md")], caseDir());
  assert.equal(broken.code, 1);
  assert.ok(broken.stderr.startsWith(VALUES_BANNER), "the human broken form lost the banner");

  // The banner says the three things it exists to say.
  assert.match(VALUES_BANNER, /HUMAN-AUTHORED GUIDANCE, not policy/u);
  assert.match(VALUES_BANNER, /grant nothing, forbid nothing, and change no verdict/u);
  assert.match(VALUES_BANNER, /approval policy check/u);
});

// ---------------------------------------------------------------------------
// 2. Absence is a declaration, in fixed words
// ---------------------------------------------------------------------------

test("values: a file with no block prints the exact sentence and exits 0", () => {
  const run = runCli(["values", "--policy", fixture("valid", "absent.md")], caseDir());
  assert.equal(run.code, 0);
  assert.equal(run.stderr, "");
  assert.equal(NO_VALUES_SENTENCE, "the operator has declared no values here.");
  assert.ok(
    run.stdout.endsWith(`${NO_VALUES_SENTENCE}\n`),
    `the absent form must end in the SPEC.md §5.3 sentence:\n${run.stdout}`,
  );

  const json = JSON.parse(
    runCli(["values", "--policy", fixture("valid", "absent.md"), "--json"], caseDir()).stdout,
  ) as { ok: boolean; present: boolean; values: unknown };
  assert.equal(json.ok, true);
  assert.equal(json.present, false);
  assert.equal(json.values, null);
});

test("values: a present block renders every declared key for a person", () => {
  const run = runCli(["values", "--policy", fixture("valid", "with-values.md")], caseDir());
  assert.equal(run.code, 0);
  for (const line of [
    "loves:",
    "likes:",
    "dislikes:",
    "wants from you:",
    "responds:",
    "  - a runbook I can paste into a terminal",
    "  - honest opinions on the work, including when you think a task is wrong",
  ]) {
    assert.ok(run.stdout.includes(line), `the rendered block omits "${line}":\n${run.stdout}`);
  }
  assert.ok(!run.stdout.includes(NO_VALUES_SENTENCE), "a present block claimed absence");
});

// ---------------------------------------------------------------------------
// 3. A broken block exits 1 with its code
// ---------------------------------------------------------------------------

test("values: every broken fixture exits 1 and reports its load code", () => {
  for (const entry of BROKEN) {
    const path = fixture("invalid", entry.file);

    const human = runCli(["values", "--policy", path], caseDir());
    assert.equal(human.code, 1, `${entry.file}: expected exit 1`);
    assert.equal(human.stdout, "", `${entry.file}: a failure printed to stdout`);
    assert.ok(
      human.stderr.includes(
        `values block present but unreadable (${entry.code}); treat it as absent, it grants nothing either way`,
      ),
      `${entry.file}: the human failure line is missing or reworded:\n${human.stderr}`,
    );

    const json = runCli(["values", "--policy", path, "--json"], caseDir());
    assert.equal(json.code, 1, `${entry.file}: --json expected exit 1`);
    assert.equal(json.stdout, "", `${entry.file}: --json printed to stdout on a failure`);
    const parsed = JSON.parse(json.stderr) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, entry.code);
    assert.ok(parsed.error.message.length > 0);
  }
});

test("values: a broken block leaves the policy answering exactly as it did", () => {
  // The point of the exit code above is that it says nothing about the policy.
  // One directory, two files, so the path in the decision trace is held fixed
  // and the only thing that varies between the two runs is the values block.
  const dir = caseDir();
  const policyPath = join(dir, "APPROVAL.md");

  copyFileSync(fixture("invalid", "yaml-error.md"), policyPath);
  const broken = runCli(["policy", "check", "financial.spend", "--json"], dir);
  copyFileSync(fixture("valid", "absent.md"), policyPath);
  const whole = runCli(["policy", "check", "financial.spend", "--json"], dir);
  assert.equal(broken.code, 0);
  assert.equal(whole.code, 0);
  assert.deepEqual(JSON.parse(broken.stdout), JSON.parse(whole.stdout));

  // …and `policy check` says nothing about the values block at all: its answer
  // is the enforcement trace, and guidance is not enforcement. The scratch path
  // is masked first, because this suite's own temp directory carries the word
  // and a match there would say nothing about the trace.
  const trace = broken.stdout.split(scratch).join("<scratch>");
  assert.ok(!trace.includes(VALUES_INFO_STRING), `the trace names the values block:\n${trace}`);
  assert.ok(!trace.includes("values"), `the trace mentions values:\n${trace}`);
});

// ---------------------------------------------------------------------------
// 4. --json matches the registry's declared shape
// ---------------------------------------------------------------------------

test("values: --json validates against the registry output schema", () => {
  const validateOutput = outputValidator();
  for (const path of [fixture("valid", "with-values.md"), fixture("valid", "absent.md")]) {
    const run = runCli(["values", "--policy", path, "--json"], caseDir());
    assert.equal(run.code, 0);
    assert.equal(run.stdout.trimEnd().split("\n").length, 1, "more than one JSON object");
    const value = JSON.parse(run.stdout) as unknown;
    assert.ok(validateOutput(value), `live output does not match the registry schema: ${run.stdout}`);
    assert.deepEqual(Object.keys(value as object), ["ok", "path", "present", "note", "values"]);
  }
});

// ---------------------------------------------------------------------------
// 5. --policy and --dir, resolved as `policy check` resolves them
// ---------------------------------------------------------------------------

test("values: --dir discovers APPROVAL.md, then APPROVALS.md", () => {
  const dir = caseDir();
  const canonical = readFileSync(fixture("valid", "absent.md"), "utf8");
  writeFileSync(
    join(dir, "APPROVALS.md"),
    `${canonical}\n\`\`\`${VALUES_INFO_STRING}\nversion: 1\nlike: [from-approvals-md]\n\`\`\`\n`,
    "utf8",
  );
  const fallback = runCli(["values", "--dir", dir, "--json"], caseDir());
  assert.equal(fallback.code, 0);
  const fallbackParsed = JSON.parse(fallback.stdout) as { path: string; values: { like: string[] } };
  assert.ok(fallbackParsed.path.endsWith("APPROVALS.md"));
  assert.deepEqual(fallbackParsed.values.like, ["from-approvals-md"]);

  writeFileSync(
    join(dir, "APPROVAL.md"),
    `${canonical}\n\`\`\`${VALUES_INFO_STRING}\nversion: 1\nlike: [from-approval-md]\n\`\`\`\n`,
    "utf8",
  );
  const preferred = JSON.parse(runCli(["values", "--dir", dir, "--json"], caseDir()).stdout) as {
    path: string;
    values: { like: string[] };
  };
  assert.ok(preferred.path.endsWith("APPROVAL.md"));
  assert.deepEqual(preferred.values.like, ["from-approval-md"]);

  // `--policy` wins over discovery.
  const overridden = JSON.parse(
    runCli(
      ["values", "--dir", dir, "--policy", fixture("valid", "with-values.md"), "--json"],
      caseDir(),
    ).stdout,
  ) as { path: string };
  assert.ok(overridden.path.endsWith("with-values.md"));

  // No flags at all: the working directory is the directory.
  const implicit = JSON.parse(runCli(["values", "--json"], dir).stdout) as { path: string };
  assert.ok(implicit.path.endsWith("APPROVAL.md"));
});

test("values: an unreadable policy path is I/O (4), and an absent one is too", () => {
  const dir = caseDir();
  const missing = runCli(["values", "--policy", join(dir, "nowhere.md"), "--json"], dir);
  assert.equal(missing.code, 4);
  assert.equal(
    (JSON.parse(missing.stderr) as { error: { code: string } }).error.code,
    "io",
    "a file that is not there is an I/O fact, not a broken block",
  );

  const asDirectory = runCli(["values", "--policy", dir, "--json"], dir);
  assert.equal(asDirectory.code, 4);
});

// ---------------------------------------------------------------------------
// Usage and help, as every other verb does them
// ---------------------------------------------------------------------------

test("values: usage errors and --help behave like every other verb", () => {
  const dir = caseDir();

  const help = runCli(["values", "--help"], dir);
  assert.equal(help.code, 0);
  assert.ok(help.stdout.startsWith("approval values —"));

  const unknown = runCli(["values", "--nope"], dir);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown flag --nope/u);

  const positional = runCli(["values", "surprise"], dir);
  assert.equal(positional.code, 2);
  assert.match(positional.stderr, /unexpected argument/u);

  const unknownJson = runCli(["values", "--nope", "--json"], dir);
  assert.equal(unknownJson.code, 2);
  assert.equal(unknownJson.stdout, "");
  assert.equal(
    (JSON.parse(unknownJson.stderr) as { error: { code: string } }).error.code,
    "usage",
  );
});

test("values: the verb appends nothing and reads no log", () => {
  const dir = dirWith("valid", "with-values.md");
  const before = readFileSync(join(FIXTURES, "valid", "with-values.md"), "utf8");
  const run = runCli(["values"], dir);
  assert.equal(run.code, 0);
  // No approval home was created by looking at a file.
  assert.throws(() => readFileSync(join(dir, ".approval", "log", "events.jsonl"), "utf8"));
  // …and the file it read is untouched.
  assert.equal(readFileSync(join(dir, "APPROVAL.md"), "utf8"), before);
});
