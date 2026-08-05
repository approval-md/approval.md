/**
 * The tier classifier (APRV-36).
 *
 * The property under test is not "docs are cheap to check". It is that the
 * verdict is a pure function of the changed paths, computed by the pipeline,
 * and that it cannot be talked into the light tier by the change that would
 * benefit from it. So the interesting cases here are the refusals: the
 * classifier's own source, its configuration's home, backlog task files whose
 * markdown extension hides instructions to future agents, and the empty set.
 *
 * The script is spawned rather than imported, because what the npm scripts run
 * is the process, and a unit-level import would not catch an argv or exit-code
 * regression. Explicit path arguments keep every case deterministic and free
 * of any dependency on the repository's actual git state; one case exercises
 * the git-backed path source against a throwaway repository.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/** The repository root, from `dist/tests/` at runtime. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = join(REPO_ROOT, "scripts", "classify-tier.mjs");

interface Verdict {
  readonly tier: string;
  readonly reason: string;
  readonly paths: readonly string[];
  readonly forcedBy: ReadonlyArray<{ path: string; rule: string }>;
}

function run(args: readonly string[]): { stdout: string; status: number } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return { stdout: result.stdout, status: result.status ?? 1 };
}

/** The one-word verdict the npm scripts read. */
function tier(...paths: string[]): string {
  const { stdout, status } = run(paths);
  assert.equal(status, 0, `classify-tier exited ${status} for ${paths.join(" ")}`);
  return stdout.trim();
}

function json(...paths: string[]): Verdict {
  const { stdout } = run([...paths, "--json"]);
  return JSON.parse(stdout) as Verdict;
}

// ---------------------------------------------------------------------------
// The light tier
// ---------------------------------------------------------------------------

test("a README-only change is light", () => {
  assert.equal(tier("README.md"), "light");
});

test("example and docs markdown are light, at any depth", () => {
  assert.equal(tier("examples/telegram-demo.md"), "light");
  assert.equal(tier("docs/checks.md"), "light");
  assert.equal(tier("docs/guides/deep/nested.md"), "light");
  assert.equal(
    tier("README.md", "examples/telegram-demo.md", "docs/checks.md"),
    "light",
  );
});

// ---------------------------------------------------------------------------
// One non-documentation path is enough
// ---------------------------------------------------------------------------

test("documentation mixed with source is full", () => {
  assert.equal(tier("docs/checks.md", "src/core/gate.ts"), "full");
});

test("markdown outside the documentation roots is not light", () => {
  assert.equal(tier("src/core/NOTES.md"), "full");
  assert.equal(tier("CHANGELOG.md"), "full");
});

test("non-markdown files under the documentation roots are not light", () => {
  assert.equal(tier("docs/build.sh"), "full");
  assert.equal(tier("examples/policy.yaml"), "full");
});

// ---------------------------------------------------------------------------
// The denylist: instruction-bearing and frozen paths, whatever the extension
// ---------------------------------------------------------------------------

const DENIED: ReadonlyArray<readonly [string, string]> = [
  ["APPROVAL.md", "APPROVAL.md"],
  ["APPROVALS.md", "APPROVALS.md"],
  ["CLAUDE.md", "CLAUDE.md"],
  [".claude/foo.md", ".claude/**"],
  [".claude/agents/reviewer.md", ".claude/**"],
  ["SPEC.md", "SPEC.md"],
  ["schema/event.schema.json", "schema/**"],
  ["schema/fixtures/x/valid/y.md", "schema/**"],
  ["tests/fixtures/policy/readme.md", "**/fixtures/**"],
  ["backlog/tasks/task-1 - x.md", "backlog/**"],
  ["backlog/docs/decision.md", "backlog/**"],
  ["scripts/classify-tier.mjs", "scripts/**"],
  ["scripts/notes.md", "scripts/**"],
  [".github/workflows/ci.yml", ".github/**"],
  ["package.json", "package.json"],
  ["package-lock.json", "package-lock.json"],
  ["tsconfig.json", "tsconfig.json"],
  ["cli.js", "cli.js"],
];

for (const [path, rule] of DENIED) {
  test(`${path} forces the full tier (${rule})`, () => {
    assert.equal(tier(path), "full");
    const verdict = json(path);
    assert.equal(verdict.reason, "denylisted-path");
    assert.deepEqual(verdict.forcedBy, [{ path, rule }]);
  });
}

test("a denylisted path is full even alongside otherwise light documentation", () => {
  assert.equal(tier("README.md", "backlog/tasks/task-1 - x.md"), "full");
});

test("the classifier cannot classify a change to its own code or config as light", () => {
  // (b), stated as a test rather than a comment. The config is this script, so
  // `scripts/**` covers both; package.json holds the npm scripts that invoke it.
  assert.equal(tier("scripts/classify-tier.mjs"), "full");
  assert.equal(tier("package.json"), "full");
  assert.equal(tier("scripts/classify-tier.mjs", "README.md"), "full");
});

// ---------------------------------------------------------------------------
// Ambiguity resolves to full
// ---------------------------------------------------------------------------

test("an empty path set is full", () => {
  const verdict = json();
  assert.equal(verdict.tier, "full");
  assert.equal(verdict.reason, "empty-path-set");
  assert.deepEqual(verdict.paths, []);
});

test("path shapes the classifier will not reason about are full", () => {
  for (const odd of [
    "/etc/passwd",
    "../outside/README.md",
    "docs/../src/gate.ts",
    "LICENSE",
    "brand/logo.png",
    "Makefile",
  ]) {
    assert.equal(tier(odd), "full", `${odd} should not be light`);
  }
});

test("an unparseable path is named as such rather than dropped", () => {
  const verdict = json("/etc/passwd");
  assert.equal(verdict.tier, "full");
  assert.deepEqual(verdict.forcedBy, [
    { path: "/etc/passwd", rule: "unparseable-path" },
  ]);
});

test("a path that is merely not documentation is distinguished from a denial", () => {
  const verdict = json("src/core/gate.ts");
  assert.equal(verdict.reason, "path-outside-light-allowlist");
  assert.deepEqual(verdict.forcedBy, [
    { path: "src/core/gate.ts", rule: "not-in-light-allowlist" },
  ]);
});

test("an unknown option is refused rather than ignored", () => {
  const { status } = run(["--tier=light", "README.md"]);
  assert.equal(status, 2, "an unrecognised flag must not silently classify");
});

// ---------------------------------------------------------------------------
// The JSON shape
// ---------------------------------------------------------------------------

test("--json reports the tier, the paths and what forced them", () => {
  const verdict = json("README.md", "docs/checks.md");
  assert.equal(verdict.tier, "light");
  assert.equal(verdict.reason, "all-paths-in-light-allowlist");
  assert.deepEqual(verdict.paths, ["README.md", "docs/checks.md"]);
  assert.deepEqual(verdict.forcedBy, []);
});

test("leading ./ is normalised away rather than making a path unknown", () => {
  assert.equal(tier("./README.md"), "light");
  assert.deepEqual(json("./README.md").paths, ["README.md"]);
});

// ---------------------------------------------------------------------------
// The git-backed path sources
// ---------------------------------------------------------------------------

test("--working-tree reads changed paths from git and yields a real verdict", () => {
  // The script classifies the repository it lives in, whatever the caller's
  // cwd, so this exercises the git plumbing end to end. The verdict itself
  // depends on the working tree of whoever is running the suite, so what is
  // asserted is the contract: exit 0 and one of the two tier words.
  const { stdout, status } = run(["--working-tree"]);
  assert.equal(status, 0);
  assert.ok(
    ["light", "full"].includes(stdout.trim()),
    `--working-tree printed ${JSON.stringify(stdout)}`,
  );
});

test("an unreadable git state resolves to full with the reason named", () => {
  const { stdout, status } = run(["--base", "definitely-not-a-ref", "--json"]);
  assert.equal(status, 0);
  const verdict = JSON.parse(stdout) as Verdict;
  assert.equal(
    verdict.tier,
    "full",
    "a git failure must resolve to the full tier, never to light",
  );
  assert.equal(verdict.reason, "git-state-unreadable");
});

test("explicit paths win over the git sources, so a caller cannot be surprised", () => {
  assert.equal(tier("--working-tree", "README.md"), "light");
});
