/**
 * CI guard (APRV-37) — the gate stays outside any agent's hands.
 *
 * `.github/workflows/ci.yml` is the one file in this repository that decides
 * how much scrutiny a change receives *after* it leaves an agent's context
 * window. That makes it the highest-value edit an agent could make: weakening
 * the matrix, widening the light tier, or teaching the workflow to read a
 * tier out of the change itself would disable the gate silently, and the
 * disabling diff would be the last one anybody checked carefully.
 *
 * So the workflow's own properties are asserted here, from the checked-in
 * bytes. The parser is `parseHardenedYaml` from `core/policy-load.ts` — the
 * same hardened parse the policy file and the task envelope get, dogfooded on
 * a third YAML surface. It matters twice over: the YAML 1.2 core schema keeps
 * the `on:` key a string rather than the YAML 1.1 boolean `true`, and a
 * workflow that only parses under looser settings is a workflow whose meaning
 * depends on which parser reads it.
 *
 * The last test closes the loop the other way: the workflow file must itself
 * be denylisted by the tier classifier, so a change to CI can never ride the
 * light tier that the same change might be widening.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

import { parseHardenedYaml } from "../src/core/policy-load.js";

/** The repository root, from `dist/tests/` at runtime. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "ci.yml");
const CLASSIFIER = join(REPO_ROOT, "scripts", "classify-tier.mjs");

const WORKFLOW_TEXT = readFileSync(WORKFLOW_PATH, "utf8");

/** The workflow as data, parsed under the repository's hardened settings. */
function workflow(): Record<string, unknown> {
  const parsed = parseHardenedYaml(WORKFLOW_TEXT, {
    subject: "workflow YAML",
    tagContext: "a workflow file",
  });
  assert.ok(
    parsed.ok,
    `.github/workflows/ci.yml does not parse under the hardened settings this repository uses for every other YAML surface: ${parsed.ok ? "" : parsed.message}`,
  );
  const value = parsed.value;
  assert.ok(
    typeof value === "object" && value !== null && !Array.isArray(value),
    ".github/workflows/ci.yml is not a YAML mapping",
  );
  return value as Record<string, unknown>;
}

function job(name: string): Record<string, unknown> {
  const jobs = workflow()["jobs"];
  assert.ok(
    typeof jobs === "object" && jobs !== null,
    ".github/workflows/ci.yml declares no jobs",
  );
  const entry = (jobs as Record<string, unknown>)[name];
  assert.ok(
    typeof entry === "object" && entry !== null,
    `.github/workflows/ci.yml no longer declares the \`${name}\` job`,
  );
  return entry as Record<string, unknown>;
}

/** Every scalar reachable from `value`, keys included. */
function scalars(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) scalars(item, out);
  else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      scalars(item, out);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// No credentials, at all
// ---------------------------------------------------------------------------

test("the CI workflow references no secrets anywhere", () => {
  const offenders = scalars(workflow()).filter((text) => text.includes("secrets."));
  assert.deepEqual(
    offenders,
    [],
    `.github/workflows/ci.yml now reads a secret (${offenders.join(", ")}). CI checks out public code and runs tests; it has nothing to send, spend, or publish. A workflow that holds a credential is a workflow a pull request is worth attacking.`,
  );
  // Belt and braces: the raw bytes too, so a secret hidden in a comment or in
  // a construct the parser folds away is still caught.
  assert.ok(
    !WORKFLOW_TEXT.includes("secrets."),
    ".github/workflows/ci.yml mentions `secrets.` in its raw text",
  );
});

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

test("the CI workflow runs on push, on pull_request and on merge_group", () => {
  const triggers = workflow()["on"];
  assert.ok(
    typeof triggers === "object" && triggers !== null,
    ".github/workflows/ci.yml has no trigger mapping. Note the parse is YAML 1.2 core: `on` is the string key, not the 1.1 boolean.",
  );
  const keys = Object.keys(triggers as Record<string, unknown>);
  for (const event of ["push", "pull_request", "merge_group"]) {
    assert.ok(
      keys.includes(event),
      `.github/workflows/ci.yml no longer runs on ${event}; a gate that skips an event is not a gate for that event`,
    );
  }
});

// ---------------------------------------------------------------------------
// The full tier's matrix
// ---------------------------------------------------------------------------

test("the full gate runs on both supported Node majors", () => {
  const strategy = job("full")["strategy"];
  assert.ok(
    typeof strategy === "object" && strategy !== null,
    "the `full` job no longer declares a matrix strategy",
  );
  const matrix = (strategy as Record<string, unknown>)["matrix"];
  assert.ok(
    typeof matrix === "object" && matrix !== null,
    "the `full` job's strategy declares no matrix",
  );
  const versions = (matrix as Record<string, unknown>)["node-version"];
  assert.ok(Array.isArray(versions), "the `full` job's matrix declares no node-version axis");
  assert.deepEqual(
    [...versions].map(Number).sort((a, b) => a - b),
    [20, 22],
    "the `full` job's Node matrix is not [20, 22]. `engines.node` is >=20, and the floor is the version nobody develops on — dropping it from CI means the floor is untested and therefore untrue.",
  );
});

test("the full gate runs the whole standing gate, not a subset", () => {
  const steps = job("full")["steps"];
  assert.ok(Array.isArray(steps), "the `full` job declares no steps");
  const commands = steps
    .map((step) => (typeof step === "object" && step !== null ? (step as Record<string, unknown>)["run"] : undefined))
    .filter((run): run is string => typeof run === "string");
  for (const command of ["npm ci", "npm test", "npm run lint", "npm run typecheck"]) {
    assert.ok(
      commands.some((run) => run.includes(command)),
      `the \`full\` job no longer runs \`${command}\``,
    );
  }
});

test("the light tier's job runs the documentation guard", () => {
  const steps = job("doc-guard")["steps"];
  assert.ok(Array.isArray(steps), "the `doc-guard` job declares no steps");
  const commands = steps
    .map((step) => (typeof step === "object" && step !== null ? (step as Record<string, unknown>)["run"] : undefined))
    .filter((run): run is string => typeof run === "string");
  assert.ok(
    commands.some((run) => run.includes("dist/tests/docs-guard.test.js")),
    "the `doc-guard` job no longer runs dist/tests/docs-guard.test.js, which is the entirety of what the light tier checks",
  );
});

// ---------------------------------------------------------------------------
// The records tier runs every test that reads records (APRV-112)
// ---------------------------------------------------------------------------
//
// The records tier is only defensible while its job runs the whole set the
// classifier names. Two ways that could rot: the workflow drops a test from
// its command, or the classifier's list grows and the workflow does not
// follow. Both are asserted from the two files' own bytes.

test("the records job runs exactly the record-reading tests the classifier names", async () => {
  const { RECORDS_TESTS } = (await import(
    pathToFileURL(CLASSIFIER).href
  )) as { RECORDS_TESTS: readonly string[] };
  assert.deepEqual(
    [...RECORDS_TESTS].sort(),
    ["backlog-fixtures", "docs-guard", "milestones-guard"],
    "the records tier's test set changed. Every test that reads backlog/** or MILESTONES.md must be in it, or a records-only change ships without the guard that would have caught it.",
  );
  const steps = job("records")["steps"];
  assert.ok(Array.isArray(steps), "the `records` job declares no steps");
  const commands = steps
    .map((step) => (typeof step === "object" && step !== null ? (step as Record<string, unknown>)["run"] : undefined))
    .filter((run): run is string => typeof run === "string");
  const only = commands.find((run) => run.includes("run-tests.mjs"));
  assert.ok(only !== undefined, "the `records` job no longer runs the test runner");
  assert.deepEqual(
    only.trim().split(/\s+/u).slice(3).sort(),
    [...RECORDS_TESTS].sort(),
    `the \`records\` job's command (${only.trim()}) names a different set of tests than scripts/classify-tier.mjs does`,
  );
});

test("the records job runs on the Node floor", () => {
  const steps = job("records")["steps"] as Array<Record<string, unknown>>;
  const setup = steps.find((step) => String(step["uses"] ?? "").startsWith("actions/setup-node"));
  assert.ok(setup !== undefined, "the `records` job does not set up Node");
  assert.equal(
    Number((setup["with"] as Record<string, unknown>)["node-version"]),
    20,
    "the records tier runs one Node version and it must be the floor: the floor is the version nobody develops on, so it is the one a single-version tier should exercise",
  );
});

test("run-tests --only refuses a name that matches no built test file", () => {
  const result = spawnSync(
    process.execPath,
    [join(REPO_ROOT, "scripts", "run-tests.mjs"), "--only", "milestones-guard", "no-such-guard"],
    { encoding: "utf8" },
  );
  assert.notEqual(
    result.status,
    0,
    "run-tests.mjs ran a smaller suite than asked for. A renamed test file must fail the tier that exists to run it, never disappear from it.",
  );
  assert.match(result.stderr, /no-such-guard/u);
});

// ---------------------------------------------------------------------------
// The tier is computed, never asserted
// ---------------------------------------------------------------------------

test("the tier output is produced by the classifier step alone", () => {
  const outputs = job("classify")["outputs"];
  assert.ok(
    typeof outputs === "object" && outputs !== null,
    "the `classify` job publishes no outputs",
  );
  const tier = (outputs as Record<string, unknown>)["tier"];
  assert.equal(
    tier,
    "${{ steps.tier.outputs.tier }}",
    "the `classify` job's tier output no longer comes from the classifier step. The tier must be a function of the changed paths, computed in CI; anything else lets the change under test choose its own scrutiny.",
  );
});

test("the downstream jobs gate on the computed tier and nothing else", () => {
  for (const [name, expected] of [
    ["doc-guard", "light"],
    ["records", "records"],
    ["full", "full"],
  ] as const) {
    const condition = job(name)["if"];
    assert.equal(
      condition,
      `needs.classify.outputs.tier == '${expected}'`,
      `the \`${name}\` job's condition reads something other than the classify job's computed tier`,
    );
    assert.equal(
      job(name)["needs"],
      "classify",
      `the \`${name}\` job no longer depends on \`classify\``,
    );
  }
});

test("a push to main takes the full tier without consulting anything", () => {
  // Structural, on the raw text: the rule lives inside a shell script, so the
  // parsed tree can only show that some script exists. What matters is that
  // the main-branch branch of that script sets full and exits before any
  // classifier invocation, so it is asserted as the text it is.
  const rule =
    /if \[ "\$EVENT_NAME" = "push" \] && \[ "\$REF" = "refs\/heads\/main" \]; then\n\s*echo "push to main: tier=full, unconditionally"\n\s*echo "tier=full" >> "\$GITHUB_OUTPUT"\n\s*exit 0/u;
  assert.match(
    WORKFLOW_TEXT,
    rule,
    "the unconditional push-to-main full-tier rule is gone from .github/workflows/ci.yml. main is the branch protection is attached to; if a merge to main could be classified at all, the classifier would be on the critical path of the only check that must never be skippable.",
  );
  // Measured from the tier step itself, so the module header's prose about the
  // classifier is not mistaken for an invocation.
  const stepStart = WORKFLOW_TEXT.indexOf("- id: tier");
  assert.notEqual(stepStart, -1, "the classify job no longer has a step with id `tier`");
  const beforeRule = WORKFLOW_TEXT.slice(stepStart, WORKFLOW_TEXT.search(rule));
  assert.ok(
    !beforeRule.includes("classify-tier.mjs"),
    "the main-branch rule now runs after a classifier invocation; it must short-circuit first",
  );
});

/**
 * The tier step's shell script, as the workflow declares it. Extracted so the
 * rules below can be executed rather than only matched: a regex over YAML
 * proves the text is present, running it proves the text means what the
 * comment above it claims.
 */
function tierScript(): string {
  const steps = job("classify")["steps"];
  assert.ok(Array.isArray(steps), "the `classify` job declares no steps");
  const step = (steps as Array<Record<string, unknown>>).find(
    (entry) => entry["id"] === "tier",
  );
  assert.ok(step !== undefined, "the `classify` job no longer has a step with id `tier`");
  const script = step["run"];
  assert.equal(typeof script, "string", "the tier step declares no shell script");
  return script as string;
}

/** Run the tier step's own script with the context a given event supplies. */
function runTierScript(env: Record<string, string>): { tier: string; stdout: string } {
  const outputFile = join(
    mkdtempSync(join(tmpdir(), "ci-guard-")),
    "github-output",
  );
  writeFileSync(outputFile, "");
  const result = spawnSync("bash", ["-c", tierScript()], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: outputFile, ...env },
  });
  assert.equal(result.status, 0, `the tier script exited ${result.status}: ${result.stderr}`);
  const written = readFileSync(outputFile, "utf8").trim();
  const match = /^tier=(.*)$/mu.exec(written);
  assert.ok(match !== null, `the tier script wrote no tier= output, wrote ${JSON.stringify(written)}`);
  return { tier: match[1] as string, stdout: result.stdout };
}

test("a merge-queue candidate classifies its own diff instead of answering full (APRV-128)", () => {
  // The queue candidate used to short-circuit to full the way a push to main
  // does. It no longer may: a candidate whose diff is nothing but records runs
  // the records guards, which are exactly the tests that read what changed.
  // What must stay true is that the answer comes from the classifier, so the
  // absence of any merge_group short-circuit is asserted, not merely the
  // presence of the classifier call.
  const script = tierScript();
  assert.ok(
    !/EVENT_NAME"\s*=\s*"merge_group"/u.test(script),
    "the tier step branches on the merge_group event again. A queue candidate must reach the classifier like a pull request does; a special case for it is a tier decided by which event fired rather than by what changed.",
  );
  assert.ok(
    script.includes('node scripts/classify-tier.mjs --base "$base"'),
    "the tier step no longer asks the classifier",
  );
});

test("the tier step resolves a merge-queue candidate's base to origin/main", () => {
  // Verified against a live merge_group run (2026-08-20): the event supplies
  // an empty base_ref and a `refs/heads/gh-readonly-queue/...` ref, and the
  // queue's temporary branch carries the target branch's history, so
  // `origin/main...HEAD` is the candidate's own change set.
  const { tier, stdout } = runTierScript({
    EVENT_NAME: "merge_group",
    REF: "refs/heads/gh-readonly-queue/main/pr-109-deadbeef",
    BASE_REF: "",
  });
  assert.match(
    stdout,
    /base=origin\/main/u,
    "a merge-queue candidate is classified against some base other than origin/main",
  );
  assert.ok(
    ["light", "records", "full"].includes(tier),
    `the tier step wrote ${JSON.stringify(tier)}, which is not one of the three tiers`,
  );
});

test("an empty base_ref never becomes the ref `origin/`", () => {
  // The pull_request branch interpolates $BASE_REF into a ref name. An event
  // that reports none must fall through to origin/main rather than build a ref
  // that cannot resolve; the classifier would fail closed to full either way,
  // but a base that silently never resolves makes every tier below full dead
  // code and hides the breakage.
  const { stdout } = runTierScript({
    EVENT_NAME: "pull_request",
    REF: "refs/pull/1/merge",
    BASE_REF: "",
  });
  assert.match(stdout, /base=origin\/main/u);
});

test("a push to main still short-circuits when the script is actually run", () => {
  const { tier } = runTierScript({
    EVENT_NAME: "push",
    REF: "refs/heads/main",
    BASE_REF: "",
  });
  assert.equal(tier, "full", "a push to main must be full whatever the classifier would say");
});

test("the tier step fails closed on any word that is not a tier", () => {
  const script = tierScript();
  assert.ok(
    script.includes("light|records|full) ;;"),
    "the tier step no longer enumerates the tiers it accepts",
  );
  assert.match(
    script,
    /\*\)\s*tier=full/u,
    "the tier step no longer forces an unrecognised classifier output to full",
  );
});

test("the tier script reads only github context, never event payload text", () => {
  // `github.event.*` fields are author-controlled prose (titles, bodies,
  // commit messages). None of them may reach the tier computation, as either
  // shell input or an interpolation.
  assert.ok(
    !WORKFLOW_TEXT.includes("github.event."),
    ".github/workflows/ci.yml interpolates a github.event.* field. Those are author-written text; the tier must depend on paths git reports and on the event name alone.",
  );
  for (const expression of ["${{ github.event_name }}", "${{ github.ref }}", "${{ github.base_ref }}"]) {
    assert.ok(
      WORKFLOW_TEXT.includes(expression),
      `.github/workflows/ci.yml no longer passes ${expression} to the tier step`,
    );
  }
});

// ---------------------------------------------------------------------------
// The workflow cannot ride the tier it defines
// ---------------------------------------------------------------------------

test("a change to the CI workflow is classified full by the tier classifier", () => {
  const result = spawnSync(
    process.execPath,
    [CLASSIFIER, ".github/workflows/ci.yml", "--json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, `classify-tier.mjs failed: ${result.stderr}`);
  const verdict = JSON.parse(result.stdout) as {
    tier: string;
    forcedBy: ReadonlyArray<{ path: string; rule: string }>;
  };
  assert.equal(
    verdict.tier,
    "full",
    "a change to .github/workflows/ci.yml classifies as light. The workflow defines the tiers; an edit to it riding the cheaper one could widen the light tier and be checked by the widened rule in the same run.",
  );
  assert.deepEqual(
    verdict.forcedBy.map((entry) => entry.rule),
    [".github/**"],
    "the workflow is now forced to the full tier by something other than the `.github/**` denylist entry",
  );
});

test("the ci aggregator requires the active tier to have succeeded (APRV-44)", () => {
  const doc = workflow();
  const jobs = doc["jobs"] as Record<string, Record<string, unknown>>;
  const ci = jobs["ci"];
  assert.ok(ci !== undefined, "an aggregator job named ci must exist for branch protection");
  assert.deepEqual(ci["needs"], ["classify", "doc-guard", "records", "full"]);
  assert.equal(ci["if"], "always()", "the aggregator must run even when tier jobs are skipped");
  const steps = ci["steps"] as Array<Record<string, unknown>>;
  const script = String((steps[steps.length - 1] as Record<string, unknown>)["run"]);
  for (const needle of [
    'if [ "$CLASSIFY_RESULT" != "success" ]',
    'light)',
    'records)',
    'full)',
    '[ "$DOC_RESULT" = "success" ]',
    '[ "$RECORDS_RESULT" = "success" ]',
    '[ "$FULL_RESULT" = "success" ]',
    "unrecognized tier",
  ]) {
    assert.ok(script.includes(needle), `aggregator script must contain ${JSON.stringify(needle)}`);
  }
  const env = (steps[steps.length - 1] as Record<string, unknown>)["env"] as Record<string, string>;
  assert.equal(env["DOC_RESULT"], "${{ needs['doc-guard'].result }}");
  assert.equal(env["RECORDS_RESULT"], "${{ needs.records.result }}");
  assert.equal(env["FULL_RESULT"], "${{ needs.full.result }}");
});

// --------------------------------------------------------------------------
// The dependency floor
// --------------------------------------------------------------------------
//
// The Node matrix guard above keeps 20 in CI; this one keeps 20 possible. The
// first real CI run (APRV-48) failed because better-sqlite3 had been bumped to
// a major whose engines declare `>=22`: npm does not enforce `engines` at
// install time, so the violation surfaced as a native crash on the Node 20 job
// rather than as an install error. Every production dependency that declares a
// Node range must therefore admit the floor, checked here from the installed
// bytes. Range shapes this parser does not recognise fail the test rather than
// pass it: an unreadable claim about the floor is not evidence the floor holds.

test("every production dependency's engines.node admits the Node floor", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    engines: { node: string };
    dependencies: Record<string, string>;
  };
  const floorMatch = /^>=(\d+)$/.exec(pkg.engines.node);
  assert.ok(floorMatch !== undefined && floorMatch !== null, "engines.node must be a plain >=N floor");
  const floor = Number(floorMatch[1]);

  /**
   * Does `range` admit major version `major`? Understands the two shapes our
   * dependencies actually use (`>= N[.x[.y]]` and `N.x || M.x || ...`);
   * anything else returns null and fails the assertion below, deliberately.
   */
  const admits = (range: string, major: number): boolean | null => {
    const trimmed = range.trim();
    const gte = /^>=\s*(\d+)(?:\.[\dx]+)*$/.exec(trimmed);
    if (gte !== null) return major >= Number(gte[1]);
    const alternatives = trimmed.split("||").map((part) => part.trim());
    if (alternatives.every((part) => /^\d+\.x$/.test(part))) {
      return alternatives.some((part) => Number(part.split(".")[0]) === major);
    }
    return null;
  };

  for (const name of Object.keys(pkg.dependencies)) {
    const depPkg = JSON.parse(
      readFileSync(join(REPO_ROOT, "node_modules", name, "package.json"), "utf8"),
    ) as { engines?: { node?: string } };
    const range = depPkg.engines?.node;
    if (range === undefined) continue; // no claim made; nothing to check
    const verdict = admits(range, floor);
    assert.ok(
      verdict !== null,
      `${name} declares engines.node ${JSON.stringify(range)}, a shape this guard cannot read; ` +
        "extend the parser or judge the floor by hand — an unread claim is not a pass",
    );
    assert.ok(
      verdict,
      `${name} declares engines.node ${JSON.stringify(range)}, which excludes Node ${floor}; ` +
        "the repository floor is >=" + String(floor) + " (package.json engines, CLAUDE.md) — " +
        "pin a version that supports it or raise the floor deliberately, never incidentally",
    );
  }
});
