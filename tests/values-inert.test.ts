/**
 * Guidance never reaches enforcement (APRV-237) — SPEC.md §11.1 invariant 10.
 *
 * APPROVAL.md gained a second, optional fenced block (```yaml approval-values```,
 * SPEC.md §5.3) and the log gained a graded `reaction` on `audit.reviewed` and
 * `approval.granted` (SPEC.md §5.2). Both are the HUMAN-TO-AGENT direction: they
 * carry what the operator values and what they thought of work the policy had
 * already allowed. Neither is policy, and the invariant is that neither can
 * become policy by accident — no routing, class matching, sampling, budget,
 * token, gate-window or execution decision may read either one.
 *
 * The guard is static and it is deliberately crude, because the failure it
 * exists to catch is crude: somebody, reasonably, wires "the human dislikes X"
 * into a check that refuses X, or lets a `loved` reaction lower a sampling rate.
 * Both would be enforcement deriving from unverified, unattested, free-text
 * human prose — and worse, from prose an agent could later be tempted to shape.
 * So the check reads the checked-in source, looks for the two literals that
 * would have to appear for such a wiring to exist, and names the offending file
 * when it finds one.
 *
 * Why literals rather than a module graph: when these guards were written the
 * values reader did not exist, and a guard that cannot run before the thing it
 * guards would be written after it, which is the wrong order for a safety
 * property. APRV-238 has since landed `src/core/values.ts`, so the import guard
 * at the bottom of the static half now does real work as well.
 *
 * The behavioural half arrived with APRV-238, at the bottom of this file: the
 * same policy block routed four ways (values block absent, valid, malformed,
 * duplicated) through `loadPolicy`, through `resolve` over a class matrix, and
 * through `approval policy check --json` in a real child process, producing
 * identical answers every time. It is here rather than in `tests/values.test.ts`
 * because the property belongs to the invariant and not to the reader: a future
 * change that made a values block move a verdict would most likely be made by
 * somebody working on enforcement, and this is the file they are pointed at.
 * The reaction half of the same argument still waits on APRV-239 (`approval
 * feedback` and the reaction-bearing verbs).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { loadPolicy } from "../src/core/policy-load.js";
import { resolve as resolveClass } from "../src/core/policy-match.js";
import { DEFAULT_SCHEMA_DIR } from "../src/core/validate.js";

/** The repository root, from `dist/tests/` at runtime. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CORE_DIR = join(REPO_ROOT, "src", "core");

/**
 * Core modules allowed to name the values block's info string, pinned as a list
 * so that widening it is itself a reviewable diff.
 *
 * `values.ts` is the reader itself: extracting the block is its whole subject.
 * `md-fence.ts` is the shared fence splitter — the one place that knows how to
 * find a labelled fenced block in APPROVAL.md, and therefore the one place that
 * may know both info strings. The list was written to the shape APRV-238 would
 * land and the test was green before either file existed; both are here now.
 * Any OTHER core module naming the literal is the wiring this invariant
 * forbids: the block's content belongs to the surfaces that show it to a human
 * or hand it to an agent's prompt, never to the code that decides.
 */
const VALUES_LITERAL_ALLOWED: readonly string[] = ["values.ts", "md-fence.ts"];

/** The info string that marks the values block in APPROVAL.md (SPEC.md §5.3). */
const VALUES_INFO_STRING = "approval-values";

/**
 * The enforcement modules, by file name under `src/core/`.
 *
 * These are the paths that decide: which class an action is, whether it is
 * sampled, whether it fits the budget, what token it gets, whether it may run,
 * and what the policy says. If `reaction` appears in any of them, a grade a
 * human typed has become an input to a decision, which is exactly invariant 10.
 *
 * The list is checked against the filesystem below, and a shrunken list fails,
 * so a rename cannot quietly empty this guard out.
 */
const ENFORCEMENT_MODULES: readonly string[] = [
  "policy-match.ts",
  "sampler.ts",
  "budgets.ts",
  "token.ts",
  "execute.ts",
  "command-class.ts",
  "gate-window.ts",
  "protected-path-guard.ts",
  "policy-load.ts",
  "policy-explain.ts",
];

/**
 * How many of {@link ENFORCEMENT_MODULES} must actually exist for the guard to
 * mean anything. Renames happen; a list that silently matched nothing would be
 * a green test asserting a property of an empty set.
 */
const MIN_ENFORCEMENT_MODULES = 6;

/** `reaction` as a whole word, case-sensitive: `reactions` and `Reaction` are not it. */
const REACTION_IDENTIFIER = /\breaction\b/u;

const CORE_FILES = readdirSync(CORE_DIR)
  .filter((entry) => entry.endsWith(".ts"))
  .sort();

function coreSource(file: string): string {
  return readFileSync(join(CORE_DIR, file), "utf8");
}

test("the core directory is readable and holds modules to check (APRV-237)", () => {
  assert.ok(CORE_FILES.length > 0, `no *.ts files found in ${CORE_DIR}`);
});

test("only the values reader and the fence splitter name the values block (APRV-237)", () => {
  const offenders = CORE_FILES.filter(
    (file) =>
      !VALUES_LITERAL_ALLOWED.includes(file) &&
      coreSource(file).includes(VALUES_INFO_STRING),
  ).map((file) => `src/core/${file}`);

  assert.deepEqual(
    offenders,
    [],
    `SPEC.md §11.1 invariant 10: the values block is human-authored guidance and no enforcement path may read it. Only ${VALUES_LITERAL_ALLOWED.join(
      ", ",
    )} may name "${VALUES_INFO_STRING}":\n${offenders.join("\n")}`,
  );
});

test("the enforcement modules named by this guard still exist (APRV-237)", () => {
  const present = ENFORCEMENT_MODULES.filter((file) => CORE_FILES.includes(file));
  assert.ok(
    present.length >= MIN_ENFORCEMENT_MODULES,
    `only ${String(present.length)} of the ${String(
      ENFORCEMENT_MODULES.length,
    )} enforcement modules this guard scans exist under src/core/. The list has rotted: update it to the current file names rather than leaving the guard scanning nothing. Missing: ${ENFORCEMENT_MODULES.filter(
      (file) => !CORE_FILES.includes(file),
    ).join(", ")}`,
  );
});

test("no enforcement module reads a reaction (APRV-237)", () => {
  const offenders: string[] = [];
  for (const file of ENFORCEMENT_MODULES) {
    if (!CORE_FILES.includes(file)) continue;
    if (REACTION_IDENTIFIER.test(coreSource(file))) {
      offenders.push(`src/core/${file}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `SPEC.md §11.1 invariant 10: \`reaction\` is what a human thought of an action, not an input to what the runtime does about it. \`verdict\` is the enforcement field. These modules decide, and they must not mention it:\n${offenders.join(
      "\n",
    )}`,
  );
});

/**
 * Who may import the values reader, once it exists.
 *
 * `cli/values.ts` is the verb that shows the block; `cli/doctor.ts` reports on
 * it as it reports on every other part of the file; `cli/instructions.ts` is the
 * agent-facing surface that renders it into an agent's context, which is the
 * whole point of the block. Everything else — and every module under
 * `src/core/`, `src/daemon/` and `src/channels/` — reaches it through none of
 * these, because a decision path that can import the reader is one review has to
 * re-argue every time it changes.
 */
const VALUES_IMPORTERS_ALLOWED: readonly string[] = [
  "src/cli/values.ts",
  "src/cli/doctor.ts",
  "src/cli/instructions.ts",
];

/** `import ... from "<specifier>"` and `export ... from "<specifier>"`, static form. */
const IMPORT_SPECIFIER = /(?:^|\n)\s*(?:import|export)\b[^;]*?from\s*["']([^"']+)["']/gu;

function specifiersOf(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1];
    if (specifier !== undefined) found.push(specifier);
  }
  return found;
}

/** Every checked-in `.ts` file under `src/`, as repo-relative paths. */
function sourceFiles(dir: string, prefix: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(child, `${prefix}${entry.name}/`));
    } else if (entry.name.endsWith(".ts")) {
      found.push(`${prefix}${entry.name}`);
    }
  }
  return found;
}

test("src/core/values.ts is imported only by the surfaces that show it (APRV-237)", () => {
  if (!existsSync(join(CORE_DIR, "values.ts"))) {
    // APRV-238 lands the reader. The guard is written first on purpose: a
    // safety property that arrives after the code it constrains has already
    // missed the review it existed for.
    return;
  }

  const offenders: string[] = [];
  for (const file of sourceFiles(join(REPO_ROOT, "src"), "src/")) {
    if (file === "src/core/values.ts") continue;
    if (VALUES_IMPORTERS_ALLOWED.includes(file)) continue;
    const source = readFileSync(join(REPO_ROOT, file), "utf8");
    for (const specifier of specifiersOf(source)) {
      if (!specifier.startsWith(".")) continue;
      // Resolve the relative specifier against the importing file, so
      // `./values.js` from inside src/core/ counts exactly as
      // `../core/values.js` from src/cli/ does.
      const resolved = join(dirname(file), specifier);
      if (resolved === join("src", "core", "values.js")) {
        offenders.push(`${file} imports "${specifier}"`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `only ${VALUES_IMPORTERS_ALLOWED.join(
      ", ",
    )} (and tests) may import the values reader; anything else is a decision path acquiring a taste:\n${offenders.join(
      "\n",
    )}`,
  );
});

// ---------------------------------------------------------------------------
// The behavioural half (APRV-238): the same policy, four values blocks, one
// answer. The static guards above say no decision path NAMES the block; these
// say no decision path is MOVED by it, which is the property the guards are a
// cheap proxy for.
// ---------------------------------------------------------------------------

/** dist/tests/values-inert.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
const VALUES_FIXTURES = join(DEFAULT_SCHEMA_DIR, "fixtures", "values-md");

/**
 * The four whole-file variants, byte-identical in their policy halves.
 *
 * That identity is the whole experiment: four files that a policy reader must
 * be unable to tell apart, two of which carry a values block a values reader
 * refuses outright. If any assertion below ever fails, the correct response is
 * not to relax it.
 */
const VALUES_VARIANTS: readonly { readonly label: string; readonly path: string }[] = [
  { label: "absent", path: join(VALUES_FIXTURES, "valid", "absent.md") },
  { label: "valid", path: join(VALUES_FIXTURES, "valid", "with-values.md") },
  { label: "malformed", path: join(VALUES_FIXTURES, "invalid", "yaml-error.md") },
  { label: "duplicated", path: join(VALUES_FIXTURES, "invalid", "two-blocks.md") },
];

/**
 * The classes routed through `resolve`, chosen to reach every branch the
 * resolver has: a wildcard match, several literal matches at each declared
 * autonomy, a rule carrying limits, and a class the policy never mentions,
 * which falls to `defaults.autonomy`. Each is asked three times, once for every
 * state of `reversible`, so the irreversibility floor of SPEC.md §7 is on the
 * matrix as well.
 */
const CLASS_MATRIX: readonly string[] = [
  "read.file",
  "files.write.workspace",
  "calendar.write.own",
  "communicate.email.draft",
  "communicate.email.external",
  "financial.spend",
  "public.post",
  "data.delete",
  "account.auth",
  "nothing.the.policy.mentions",
];

const REVERSIBLE_MATRIX: readonly (boolean | undefined)[] = [undefined, true, false];

// The prefix deliberately carries no form of the word this file is about: the
// last assertion below reads the CLI's own output for it, and a scratch path
// that matched would be a false positive nobody could see.
const behaviouralScratch = mkdtempSync(join(tmpdir(), "approval-md-inert-"));

after(() => {
  rmSync(behaviouralScratch, { recursive: true, force: true });
});

/**
 * Write one variant into a FIXED path and return it.
 *
 * One directory reused across all four, so the file path every answer embeds is
 * held constant and the deep-equality below compares whole results rather than
 * a subset somebody had to choose. A different directory per variant would make
 * the trace lines differ for a reason that has nothing to do with the property.
 */
function writeVariant(dir: string, variantPath: string): string {
  const policyPath = join(dir, "APPROVAL.md");
  writeFileSync(policyPath, readFileSync(variantPath, "utf8"), "utf8");
  return policyPath;
}

test("loadPolicy answers identically across the four values-block variants (APRV-238)", () => {
  const dir = mkdtempSync(join(behaviouralScratch, "load-"));
  const answers = VALUES_VARIANTS.map((variant) => {
    writeVariant(dir, variant.path);
    return { label: variant.label, result: loadPolicy({ dir }) };
  });

  const baseline = answers[0];
  assert.ok(baseline !== undefined);
  // A guard on the guard: four identical fail-closed results would satisfy
  // every comparison below and prove nothing.
  assert.equal(baseline.result.ok, true, "the shared policy block did not load");

  for (const entry of answers.slice(1)) {
    assert.deepEqual(
      entry.result,
      baseline.result,
      `the policy load differs between the "${baseline.label}" and "${entry.label}" values blocks. SPEC.md §11.1 invariant 10: the values block is guidance, and guidance may not move the policy by any route.`,
    );
  }
});

test("resolve answers identically across the variants, over a class matrix (APRV-238)", () => {
  const dir = mkdtempSync(join(behaviouralScratch, "resolve-"));

  const perVariant = VALUES_VARIANTS.map((variant) => {
    writeVariant(dir, variant.path);
    const load = loadPolicy({ dir });
    const rows = CLASS_MATRIX.flatMap((actionClass) =>
      REVERSIBLE_MATRIX.map((reversible) => ({
        actionClass,
        reversible: reversible ?? null,
        resolution: resolveClass(
          load,
          actionClass,
          reversible === undefined ? {} : { reversible },
        ),
      })),
    );
    return { label: variant.label, rows };
  });

  const baseline = perVariant[0];
  assert.ok(baseline !== undefined);
  assert.equal(
    baseline.rows.length,
    CLASS_MATRIX.length * REVERSIBLE_MATRIX.length,
    "the matrix collapsed; a resolver comparison over nothing is a green test about an empty set",
  );
  // The matrix has to reach more than one verdict, or every variant agreeing on
  // a single answer would say nothing about routing.
  assert.ok(
    new Set(baseline.rows.map((row) => row.resolution.autonomy)).size > 1,
    "the matrix produced one autonomy for every class; widen it",
  );

  for (const entry of perVariant.slice(1)) {
    assert.deepEqual(
      entry.rows,
      baseline.rows,
      `routing differs between the "${baseline.label}" and "${entry.label}" values blocks. A class match, a supervision mode, a limit or an irreversibility floor moved because of human-authored guidance (SPEC.md §11.1 invariant 10).`,
    );
  }
});

test("`policy check --json` is byte-identical across the variants (APRV-238)", () => {
  // The end-to-end form of the two tests above: a real child process, the real
  // CLI, the real explanation. What an operator or an agent actually observes.
  const dir = mkdtempSync(join(behaviouralScratch, "check-"));

  const outputs = VALUES_VARIANTS.map((variant) => {
    writeVariant(dir, variant.path);
    const env = { ...process.env };
    delete env["APPROVAL_HUMAN"];
    delete env["APPROVAL_AGENT"];
    const run = spawnSync(
      process.execPath,
      [CLI_ENTRY, "policy", "check", "financial.spend", "--json"],
      { cwd: dir, encoding: "utf8", env },
    );
    assert.equal(run.error, undefined, `spawn failed: ${String(run.error)}`);
    assert.equal(run.status, 0, `${variant.label}: policy check exited ${String(run.status)}: ${run.stderr}`);
    return { label: variant.label, stdout: run.stdout };
  });

  const baseline = outputs[0];
  assert.ok(baseline !== undefined);
  for (const entry of outputs.slice(1)) {
    assert.equal(
      entry.stdout,
      baseline.stdout,
      `\`policy check --json\` differs between the "${baseline.label}" and "${entry.label}" values blocks:\n${baseline.stdout}\n---\n${entry.stdout}`,
    );
  }

  // …and the trace names no part of the values block. `policy check` explains
  // enforcement, and guidance appearing in an enforcement trace is how a reader
  // starts believing it is enforced.
  assert.ok(!baseline.stdout.includes("approval-values"), baseline.stdout);
  assert.ok(!baseline.stdout.includes("values"), baseline.stdout);
});
