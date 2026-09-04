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
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
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
import { main } from "../src/cli/main.js";
import {
  openObligations,
  openSamples,
  pendingSamples,
  reviewSample,
  sampleSupervised,
  sampledSubjects,
  type AuditCandidate,
  type SampledSubject,
} from "../src/core/audit.js";
import { evaluateBudgetsWithTask, type BudgetScope } from "../src/core/budgets.js";
import type { EventRecord } from "../src/core/log.js";
import { runPayloadHash } from "../src/core/payload.js";
import { resolveSampler } from "../src/core/sampler.js";
import { verify } from "../src/core/verify.js";
import { appendAttestation, decide, register, request, startExecution } from "./clock-adapters.js";

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
 *
 * `agents-md.ts` was added by APRV-240 and is the one WRITER on the list. It
 * renders a DRAFT values block for a human to paste, so it has to spell the
 * label it emits, and it does nothing else with it: it reads no APPROVAL.md,
 * extracts no block, parses no YAML, imports no reader, and no decision path
 * calls it. Writing a label is the opposite direction from the one this
 * invariant is about, and `the draft renderer emits a block and reads none`
 * below holds that entry to exactly that. Nothing else may be added here on the
 * strength of this precedent: the next writer argues its own case.
 */
const VALUES_LITERAL_ALLOWED: readonly string[] = ["values.ts", "md-fence.ts", "agents-md.ts"];

/**
 * The reading machinery {@link VALUES_LITERAL_ALLOWED}'s writer entry must not
 * touch. Naming a fence label is not reading a block, and this is where that
 * distinction stops being a claim in a comment.
 */
const READING_MACHINERY: readonly string[] = [
  "loadValues",
  "loadValuesText",
  "scanFences",
  "parseHardenedYaml",
  "./values.js",
];

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

test("the draft renderer emits a block and reads none (APRV-240)", () => {
  // The condition `agents-md.ts` sits on VALUES_LITERAL_ALLOWED under. It may
  // spell the label of the block it writes; the moment it can extract, parse or
  // load one, it has become a reader inside `src/core/` and this fails.
  assert.ok(CORE_FILES.includes("agents-md.ts"), "src/core/agents-md.ts has moved or been renamed");
  const source = coreSource("agents-md.ts");
  const found = READING_MACHINERY.filter((name) => source.includes(name));
  assert.deepEqual(
    found,
    [],
    `SPEC.md §11.1 invariant 10: src/core/agents-md.ts is on the values-literal allowlist as a WRITER of draft blocks. It names ${found.join(
      ", ",
    )}, which is reading machinery. Either drop that, or take the file off the allowlist and argue the case again.`,
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

// ===========================================================================
// The behavioural half: reactions (APRV-239)
// ===========================================================================

/**
 * The test the file header promised and could not yet write.
 *
 * The static guard above proves that no enforcement module NAMES a reaction.
 * This proves the consequence: two logs built by the same operations at the same
 * instants, differing only in the grades and notes a human attached, produce the
 * same supervision backlog, the same obligations, the same budget verdicts and
 * the same execution outcomes. A `loved` grant buys nothing and a `disliked`
 * review costs nothing.
 *
 * One field is deliberately NOT compared, and saying why is the point: the chain
 * hash of every record after the first difference. The two logs contain different
 * bytes, so of course they hash differently — that is the chain working. What
 * matters is that no DECISION is derived from the difference, which is what the
 * comparisons below assert. Sampling at rate 1 makes the selection total, so the
 * one place a record hash does feed a decision (the retrospective sampler's HMAC
 * over it, exactly as it already does for a `note`) cannot silently supply the
 * agreement being asserted.
 */

const behaviourScratch = mkdtempSync(join(tmpdir(), "approval-md-inert-"));
let behaviourCounter = 0;

after(() => {
  rmSync(behaviourScratch, { recursive: true, force: true });
});

const T0 = "2026-08-05T10:00:00.000Z";

function at(minutes: number): string {
  return new Date(Date.parse(T0) + minutes * 60_000).toISOString();
}

const SAMPLING_SECRET_ENV = "APPROVAL_TEST_SAMPLING_SECRET";
const SAMPLING_ENV: NodeJS.ProcessEnv = { [SAMPLING_SECRET_ENV]: "operator-held-secret" };

const INERT_POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "6h"',
  "  on_expiry: reject",
  "classes:",
  "  files.write.*:",
  "    autonomy: supervised",
  "  communicate.email.external:",
  "    autonomy: manual",
  "budgets:",
  "  global:",
  "    daily_usd: 10",
  "    daily_actions: 50",
  "audit:",
  "  supervised_sample_rate: 1",
  `  sampling_secret_env: ${SAMPLING_SECRET_ENV}`,
  "```",
  "",
].join("\n");

function bindingFor(key: string): string {
  return createHash("sha256").update(`payload:${key}`, "utf8").digest("hex");
}

const INERT_ENVELOPE = {
  origin: { app: "example-capture", created_by: "human:carter" },
  state: "proposed",
  actions: [
    {
      class: "communicate.email.external",
      summary: "Send the deposit chaser",
      reversible: false,
      est_cost_usd: "0.02",
      idempotency_key: "task-042:chaser",
      payload_hash: bindingFor("task-042:chaser"),
    },
    {
      class: "files.write.local",
      summary: "Write the draft",
      reversible: true,
      est_cost_usd: "0.01",
      idempotency_key: "task-042:draft",
      payload_hash: bindingFor("task-042:draft"),
    },
    {
      class: "files.write.local",
      summary: "Write the second draft",
      reversible: true,
      est_cost_usd: "0.01",
      idempotency_key: "task-042:draft2",
      payload_hash: bindingFor("task-042:draft2"),
    },
  ],
};

interface InertCase {
  dir: string;
  logPath: string;
  policyPath: string;
}

function inertCase(): InertCase {
  behaviourCounter += 1;
  const dir = join(behaviourScratch, `case-${String(behaviourCounter)}`);
  mkdirSync(dir, { recursive: true });
  const policyPath = join(dir, "APPROVAL.md");
  writeFileSync(policyPath, INERT_POLICY, "utf8");
  return { dir, logPath: join(dir, ".approval", "log", "events.jsonl"), policyPath };
}

function inertRecords(unit: InertCase): EventRecord[] {
  return readFileSync(unit.logPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as EventRecord);
}

function must<T extends { ok: boolean }>(result: T, what: string): T {
  assert.equal(result.ok, true, `${what} failed: ${JSON.stringify(result)}`);
  return result;
}

/**
 * The same eleven operations at the same eleven instants, twice. `feedback`
 * decides only whether the human attached a grade and words to two of them.
 */
function buildInertLog(feedback: boolean): InertCase {
  const unit = inertCase();
  const options = { policy: { file: unit.policyPath } };
  must(appendAttestation(unit.logPath, unit.policyPath, "human:carter", T0), "attest");
  must(
    register(unit.logPath, { task: "task-042", envelope: INERT_ENVELOPE }, at(1), "agent:claude"),
    "register",
  );
  must(
    request(
      unit.logPath,
      { task: "task-042", actionKey: "task-042:chaser", cls: "communicate.email.external" },
      at(2),
      "agent:claude",
      options,
    ),
    "request",
  );
  must(
    decide(unit.logPath, "task-042:chaser", "grant", "human:carter", at(3), {
      ...options,
      ...(feedback ? { note: "good call, and worded well", reaction: "loved" as const } : {}),
    }),
    "grant",
  );

  for (const [key, minutes] of [
    ["task-042:draft", 4],
    ["task-042:draft2", 5],
  ] as Array<[string, number]>) {
    must(
      startExecution(
        unit.logPath,
        key,
        { ...options, presentedPayloadHash: bindingFor(key) },
        at(minutes),
        "agent:claude",
      ),
      `execute ${key}`,
    );
  }

  must(
    sampleSupervised(unit.logPath, unit.dir, {
      policy: { file: unit.policyPath },
      env: SAMPLING_ENV,
      clock: () => at(6),
    }),
    "sample",
  );

  // A denial either way: the VERDICT is the enforcement field and it is the same
  // in both logs. Only the grade and the words beside it move.
  must(
    reviewSample(
      unit.logPath,
      { kind: "action-key", actionKey: "task-042:draft" },
      "human:carter",
      feedback ? "this should not have been written at all" : null,
      {
        clock: () => at(7),
        verdict: "denied",
        ...(feedback ? { reaction: "disliked" as const } : {}),
      },
    ),
    "review draft",
  );
  must(
    reviewSample(
      unit.logPath,
      { kind: "action-key", actionKey: "task-042:draft2" },
      "human:carter",
      null,
      { clock: () => at(8), ...(feedback ? { reaction: "liked" as const } : {}) },
    ),
    "review draft2",
  );

  assert.equal(
    verify(unit.logPath).status,
    "clean",
    `log not clean for feedback=${String(feedback)}`,
  );
  return unit;
}

/** The chain hash of the sampled record: different bytes, different hash. */
function withoutChainHash(subject: SampledSubject): Omit<SampledSubject, "subjectHash"> {
  const { subjectHash: _ignored, ...rest } = subject;
  return rest;
}

function withoutCandidateHash(candidate: AuditCandidate): Omit<AuditCandidate, "hash"> {
  const { hash: _ignored, ...rest } = candidate;
  return rest;
}

test("reactions change no supervision decision (APRV-239)", () => {
  const withFeedback = buildInertLog(true);
  const without = buildInertLog(false);

  // The difference is real and it is in the log, so the comparison below is not
  // comparing two identical files.
  const graded = inertRecords(withFeedback).filter((record) =>
    Object.hasOwn((record.payload ?? {}) as Record<string, unknown>, "reaction"),
  );
  assert.equal(graded.length, 3, "the feedback log did not record three reactions");
  assert.equal(
    inertRecords(without).some((record) =>
      Object.hasOwn((record.payload ?? {}) as Record<string, unknown>, "reaction"),
    ),
    false,
  );

  const a = inertRecords(withFeedback);
  const b = inertRecords(without);

  // The two logs are the same shape: same events, same order, same instants,
  // same actors. Anything that diverges below diverged because of a grade.
  assert.deepEqual(
    a.map((record) => [record.seq, record.event, record.ts, record.actor]),
    b.map((record) => [record.seq, record.event, record.ts, record.actor]),
  );

  assert.deepEqual(
    sampledSubjects(a).map(withoutChainHash),
    sampledSubjects(b).map(withoutChainHash),
  );
  assert.deepEqual(openSamples(a).map(withoutChainHash), openSamples(b).map(withoutChainHash));
  assert.deepEqual(openObligations(a), openObligations(b));
  // Both denials opened an obligation, so the comparison is over a non-empty
  // backlog rather than over two empty lists.
  assert.equal(openObligations(a).length, 1);

  const load = loadPolicy({ file: withFeedback.policyPath });
  assert.equal(load.ok, true);
  const sampler = resolveSampler(load, SAMPLING_ENV);
  assert.equal(sampler.enabled, true);
  assert.deepEqual(
    pendingSamples(a, load, sampler).map(withoutCandidateHash),
    pendingSamples(b, load, sampler).map(withoutCandidateHash),
  );
});

test("reactions change no budget verdict (APRV-239)", () => {
  const a = inertRecords(buildInertLog(true));
  const b = inertRecords(buildInertLog(false));

  const scope: BudgetScope = {
    classLimits: null,
    classPattern: null,
    globalBudgets: { global: { daily_usd: 10, daily_actions: 50 } },
  };
  for (const cost of ["0.01", "5", "20"]) {
    const action = { class: "communicate.email.external", est_cost_usd: cost };
    const verdictsA = evaluateBudgetsWithTask(a, scope, action, at(9), "task-042");
    const verdictsB = evaluateBudgetsWithTask(b, scope, action, at(9), "task-042");
    assert.deepEqual(verdictsA, verdictsB, `budgets diverged at est_cost_usd ${cost}`);
  }
  // The largest cost actually fails, so the equality above is over a real
  // refusal and not over two blanket passes.
  assert.equal(
    evaluateBudgetsWithTask(
      a,
      scope,
      { class: "communicate.email.external", est_cost_usd: "20" },
      at(9),
      "task-042",
    ).pass,
    false,
  );
});

test("reactions change no `approval run` outcome (APRV-239)", async () => {
  // A fresh pair: these logs get a real execution driven through the CLI, whose
  // timestamps come from the real clock, so only the OUTCOME is comparable —
  // which is the whole claim.
  const child = [process.execPath, "-e", 'console.log("child ran")'];
  const outcomes: Array<{ code: number; events: string[] }> = [];
  for (const feedback of [true, false]) {
    const unit = inertCase();
    const options = { policy: { file: unit.policyPath } };
    // The real derivation, not a stand-in: the declaration must bind to exactly
    // the bytes `approval run` will spend, and the hash is cwd-relative.
    const envelope = {
      ...INERT_ENVELOPE,
      actions: INERT_ENVELOPE.actions.map((declared) =>
        declared.idempotency_key === "task-042:draft"
          ? { ...declared, payload_hash: runPayloadHash(child, unit.dir) }
          : declared,
      ),
    };
    must(appendAttestation(unit.logPath, unit.policyPath, "human:carter", T0), "attest");
    must(
      register(unit.logPath, { task: "task-042", envelope }, at(1), "agent:claude"),
      "register",
    );
    must(
      request(
        unit.logPath,
        { task: "task-042", actionKey: "task-042:chaser", cls: "communicate.email.external" },
        at(2),
        "agent:claude",
        options,
      ),
      "request",
    );
    must(
      decide(unit.logPath, "task-042:chaser", "grant", "human:carter", at(3), {
        ...options,
        ...(feedback ? { note: "loved this one", reaction: "loved" as const } : {}),
      }),
      "grant",
    );

    const before = inertRecords(unit).length;
    let err = "";
    const code = await main(
      [
        "run",
        "task-042:draft",
        "--as",
        "agent:claude",
        "--log",
        unit.logPath,
        "--",
        ...child,
      ],
      {
        cwd: unit.dir,
        streams: {
          out: () => {},
          err: (text) => {
            err += text;
          },
        },
      },
    );
    assert.equal(code, 0, err);
    outcomes.push({
      code,
      events: inertRecords(unit)
        .slice(before)
        .map((record) => record.event),
    });
  }

  assert.deepEqual(outcomes[0], outcomes[1]);
  assert.deepEqual(outcomes[0]?.events, ["execution.started", "execution.completed"]);
});
