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
 * Why literals rather than a module graph: the values reader does not exist yet
 * (APRV-238 lands `src/core/values.ts`), and a guard that cannot run before the
 * thing it guards would be written after it, which is the wrong order for a
 * safety property. Everything here passes today by construction and keeps
 * passing as the surfaces land.
 *
 * NOT here, and deliberately: a behavioural equivalence test — the same policy
 * and the same action routed with and without a values block, and with and
 * without a reaction on the preceding record, producing byte-identical verdicts.
 * That test needs the reader and the verbs to exist; APRV-238 (values reader and
 * `approval values`) and APRV-239 (`approval feedback` and the reaction-bearing
 * verbs) each add their half of it.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

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
 * may know both info strings. Neither exists yet; the list is written to the
 * shape APRV-238 will land, and the test is green whether or not the files are
 * there. Any OTHER core module naming the literal is the wiring this invariant
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
