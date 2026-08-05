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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

test("the CI workflow runs on push and on pull_request", () => {
  const triggers = workflow()["on"];
  assert.ok(
    typeof triggers === "object" && triggers !== null,
    ".github/workflows/ci.yml has no trigger mapping. Note the parse is YAML 1.2 core: `on` is the string key, not the 1.1 boolean.",
  );
  const keys = Object.keys(triggers as Record<string, unknown>);
  for (const event of ["push", "pull_request"]) {
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
  assert.deepEqual(ci["needs"], ["classify", "doc-guard", "full"]);
  assert.equal(ci["if"], "always()", "the aggregator must run even when tier jobs are skipped");
  const steps = ci["steps"] as Array<Record<string, unknown>>;
  const script = String((steps[steps.length - 1] as Record<string, unknown>)["run"]);
  for (const needle of [
    'if [ "$CLASSIFY_RESULT" != "success" ]',
    'light)',
    'full)',
    '[ "$DOC_RESULT" = "success" ]',
    '[ "$FULL_RESULT" = "success" ]',
    "unrecognized tier",
  ]) {
    assert.ok(script.includes(needle), `aggregator script must contain ${JSON.stringify(needle)}`);
  }
  const env = (steps[steps.length - 1] as Record<string, unknown>)["env"] as Record<string, string>;
  assert.equal(env["DOC_RESULT"], "${{ needs['doc-guard'].result }}");
  assert.equal(env["FULL_RESULT"], "${{ needs.full.result }}");
});
