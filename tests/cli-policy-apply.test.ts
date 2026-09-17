/**
 * `approval policy apply` (APRV-343), driven as the shipped verb.
 *
 * Every case spawns the built CLI against a scratch policy file, because the
 * claim under test is what the verb does to bytes on disk. The two claims that
 * matter, and that every case asserts one half of:
 *
 * - **a proposal applies whole or not at all.** The stale case's FIRST pair is
 *   good; a verb that resolved pairs as it wrote them would leave that one
 *   applied and refuse on the second, which is the half-applied policy this
 *   whole design exists to make impossible;
 * - **no byte is written that was not proved present.** There is no path here
 *   that takes a whole file, and the wrapper-fence case is the one where a
 *   paste would have written the page's own fence into the policy (APRV-273).
 *
 * `--no-amend` is passed wherever the case is about the WRITE: the amendment is
 * `tests/cli-amend.test.ts`'s subject and running it here would test it twice.
 * The one case that does run it asserts the handover and nothing else.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  POLICY_APPLY_REFUSAL_CODES,
  fencesOf,
  parseProposal,
  planApply,
} from "../src/cli/policy-apply.js";

/** dist/tests/cli-policy-apply.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURES = join(REPO_ROOT, "tests", "fixtures", "proposals");

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-policy-apply-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "1h"',
  "  # classes",
  "classes:",
  "  network.call:              { autonomy: supervised }",
  "```",
  "",
].join("\n");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[], cwd: string): Run {
  const run = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { code: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
}

/** A directory with a policy in it, and nothing else. */
function caseDir(policy: string = POLICY): string {
  counter += 1;
  const dir = join(scratch, `case-${String(counter)}`);
  mkdirSync(join(dir, ".approval", "log"), { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), policy, "utf8");
  return dir;
}

function policyOf(dir: string): string {
  return readFileSync(join(dir, "APPROVAL.md"), "utf8");
}

function fixture(name: string): string {
  return join(FIXTURES, `${name}.md`);
}

function errorOf(run: Run): { code: string; message: string } {
  const line = run.stderr
    .split("\n")
    .find((candidate) => candidate.trim().startsWith("{") && candidate.includes('"error"'));
  assert.ok(line !== undefined, `no refusal object in:\n${run.stderr}`);
  return (JSON.parse(line) as { error: { code: string; message: string } }).error;
}

// ---------------------------------------------------------------------------
// The fence scanner (APRV-273)
// ---------------------------------------------------------------------------

test("fences: a four-backtick wrapper carries a three-backtick block as CONTENT", () => {
  const page = ["Current:", "", "````yaml", "```yaml approval-values", "version: 1", "```", "````", ""].join(
    "\n",
  );
  const found = fencesOf(page);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.label, "Current:");
  assert.equal(found[0]?.body, '```yaml approval-values\nversion: 1\n```');
});

test("fences: a fence with no declared language is not a block this verb reads", () => {
  const found = fencesOf(["Current:", "", "```", "anything", "```", ""].join("\n"));
  assert.deepEqual(found, []);
});

test("fences: an unterminated fence is not a block, so a typo cannot swallow a page", () => {
  const found = fencesOf(["Current:", "", "```yaml", "one", "two", ""].join("\n"));
  assert.deepEqual(found, []);
});

// ---------------------------------------------------------------------------
// Parsing and planning, as functions
// ---------------------------------------------------------------------------

test("parse: a Replace with block with no Current above it is malformed", () => {
  const parsed = parseProposal(["Replace with:", "", "```yaml", "x: 1", "```", ""].join("\n"));
  assert.equal(parsed.ok, false);
  if (parsed.ok) throw new Error("unreachable");
  assert.equal(parsed.code, "proposal-malformed");
});

test("plan: a quoted text that occurs twice refuses rather than guessing", () => {
  const parsed = parseProposal(readFileSync(fixture("clean"), "utf8"));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unreachable");
  const twice = `${POLICY}\n${POLICY}`;
  const plan = planApply(twice, parsed.pairs);
  assert.equal(plan.ok, false);
  if (plan.ok) throw new Error("unreachable");
  assert.equal(plan.code, "proposal-ambiguous");
  assert.match(plan.message, /occurs 2 times/u);
});

// ---------------------------------------------------------------------------
// The verb
// ---------------------------------------------------------------------------

test("apply: a clean proposal writes every pair and nothing else", () => {
  const dir = caseDir();
  const run = cli(["policy", "apply", fixture("clean"), "--yes", "--no-amend"], dir);
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);

  const after = policyOf(dir);
  assert.match(after, /network\.call:\s+\{ autonomy: manual \}/u);
  assert.match(after, /# classes \(amended by the clean fixture\)/u);
  // The `bash` block on that page carries no label, so it is not policy text.
  assert.doesNotMatch(after, /approval doctor/u);
  // --no-amend says what is owed, on stderr, because an edited unattested
  // policy refuses every gate operation until the amendment runs.
  assert.match(run.stderr, /UNATTESTED/u);
  assert.match(run.stderr, /approval policy amend --pr/u);
});

test("apply: a stale pair writes NOTHING, not even the pair before it", () => {
  const dir = caseDir();
  const before = policyOf(dir);

  const run = cli(["policy", "apply", fixture("stale"), "--yes", "--no-amend", "--json"], dir);
  assert.notEqual(run.code, 0);
  const error = errorOf(run);
  assert.equal(error.code, "proposal-stale");
  assert.match(error.message, /pair 2/u);
  // The first pair was good. A verb that wrote as it went would have applied it.
  assert.equal(policyOf(dir), before);
});

test("apply: a superseding pair matches the earlier section's result", () => {
  // The line carries the stale comment section 1 corrects, so section 2's own
  // Current block is absent the moment section 1 has run — which is exactly the
  // state a `Supersedes:` block exists to name.
  const dir = caseDir(
    POLICY.replace(
      "  network.call:              { autonomy: supervised }",
      "  network.call:              { autonomy: supervised }   # stale comment",
    ),
  );
  const run = cli(["policy", "apply", fixture("superseding"), "--yes", "--no-amend"], dir);
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);

  const after = policyOf(dir);
  assert.match(after, /network\.call:\s+\{ autonomy: manual \}\s+# corrected comment/u);
  // One line, not two: the second pair REPLACED what the first one wrote.
  assert.equal(after.split("network.call:").length - 1, 1);
  assert.match(run.stdout, /matched the text it supersedes/u);
});

test("apply: a wrapper-fenced pair replaces the inner block, wrapper and all", () => {
  const values = [
    "# Policy",
    "",
    "```yaml approval-values",
    "version: 1",
    "love:",
    "  - honest thoughts",
    "```",
    "",
  ].join("\n");
  const dir = caseDir(values);

  const run = cli(["policy", "apply", fixture("wrapper-fenced"), "--yes", "--no-amend"], dir);
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);

  const after = policyOf(dir);
  assert.match(after, /version: "0\.2"/u);
  // The page's own four-backtick wrapper is nowhere in the policy. A paste is
  // exactly what put one there on the day APRV-273 was filed.
  assert.doesNotMatch(after, /````/u);
  assert.equal(after.split("```yaml approval-values").length - 1, 1);
});

test("apply: a proposal whose fences declare no language proposes nothing", () => {
  const dir = caseDir();
  const before = policyOf(dir);

  const run = cli(
    ["policy", "apply", fixture("undeclared-fence"), "--yes", "--no-amend", "--json"],
    dir,
  );
  assert.notEqual(run.code, 0);
  assert.equal(errorOf(run).code, "proposal-empty");
  assert.equal(policyOf(dir), before);
});

test("apply: an agent identity refuses before reading anything", () => {
  const dir = caseDir();
  const before = policyOf(dir);

  const run = cli(
    ["policy", "apply", fixture("clean"), "--as", "agent:drafter", "--yes", "--json"],
    dir,
  );
  assert.equal(run.code, 2);
  const error = errorOf(run);
  assert.equal(error.code, "apply-agent-actor");
  assert.match(error.message, /human-only/u);
  assert.equal(policyOf(dir), before);
});

test("apply: --dry-run prints the replacements and writes nothing", () => {
  const dir = caseDir();
  const before = policyOf(dir);

  const run = cli(["policy", "apply", fixture("clean"), "--dry-run"], dir);
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /^ {2}-\s+network\.call:\s+\{ autonomy: supervised \}$/mu);
  assert.match(run.stdout, /^ {2}\+\s+network\.call:\s+\{ autonomy: manual \}$/mu);
  assert.match(run.stdout, /nothing was written/u);
  assert.equal(policyOf(dir), before);
});

test("apply: a second run of an applied proposal is a no-op success", () => {
  const dir = caseDir();
  assert.equal(cli(["policy", "apply", fixture("clean"), "--yes", "--no-amend"], dir).code, 0);
  const after = policyOf(dir);

  // Every pair is stale now, in the sense that its Current text is gone — but
  // its REPLACEMENT is there, which is what "already applied" looks like. The
  // honest answer is a refusal naming the first pair, because the verb cannot
  // tell an applied proposal from a stale one without guessing.
  const again = cli(["policy", "apply", fixture("clean"), "--yes", "--no-amend", "--json"], dir);
  assert.equal(errorOf(again).code, "proposal-stale");
  assert.equal(policyOf(dir), after, "a refused second run changed the policy");
});

test("apply: without --yes and without a terminal it refuses rather than assuming", () => {
  const dir = caseDir();
  const before = policyOf(dir);

  const run = cli(["policy", "apply", fixture("clean"), "--json"], dir);
  assert.equal(run.code, 2);
  assert.equal(errorOf(run).code, "usage");
  assert.match(errorOf(run).message, /confirmation it cannot ask for/u);
  assert.equal(policyOf(dir), before);
});

test("apply: with no proposal argument it is a usage refusal", () => {
  const dir = caseDir();
  const run = cli(["policy", "apply", "--json"], dir);
  assert.equal(run.code, 2);
  assert.match(errorOf(run).message, /missing <proposal\.md>/u);
});

test("apply: it hands over to the amendment, which refuses without an identity", () => {
  const dir = caseDir();
  // No --no-amend: the write happens, then `policy amend` runs in this process
  // and refuses for its own reason (no identity to attest under). The point is
  // the handover and the sentence it leaves behind, not the amendment's rules.
  const run = cli(["policy", "apply", fixture("clean"), "--yes", "--json"], dir);
  assert.notEqual(run.code, 0);
  assert.match(policyOf(dir), /autonomy: manual/u, "the replacements were not written");
  assert.match(run.stderr, /edited and unattested/u);
  assert.match(run.stderr, /approval policy amend --pr/u);
});

/**
 * SPEC §11.1 invariant 6 in its own small way: the union is frozen public API,
 * so an eighth code cannot appear without a line changing here. The two
 * outcomes that are NOT in it are the point of the assertion — an abort is exit
 * 0, and a refused amendment carries the amendment's own code.
 */
test("apply: the refusal-code union is frozen, and excludes the two non-refusals", () => {
  assert.deepEqual(
    [...POLICY_APPLY_REFUSAL_CODES],
    [
      "usage",
      "io",
      "apply-agent-actor",
      "proposal-empty",
      "proposal-malformed",
      "proposal-stale",
      "proposal-ambiguous",
    ],
  );
});

test("apply: the help names the human-only rule and the refusal codes", () => {
  const dir = caseDir();
  const run = cli(["policy", "apply", "--help"], dir);
  assert.equal(run.code, 0);
  assert.match(run.stdout, /HUMAN-ONLY/u);
  assert.match(run.stdout, /policy\.core/u);
  assert.match(run.stdout, /proposal-stale/u);
  assert.match(run.stdout, /Whole-file replacement is NOT accepted/u);
});
