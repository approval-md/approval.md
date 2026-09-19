/**
 * The conformance suite's executor (APRV-122).
 *
 * `conformance/vectors/*.v1.json` is a language-neutral description of what a
 * conforming approval.md implementation must do on the hot-loop surfaces of
 * SPEC.md §13: canonicalization, policy resolution, chain verification, gate
 * verdicts, schema validation at the write boundary, and the refusal-code
 * unions of §11.1 invariant 6. This module is the *reference* runner: it reads
 * those files and drives this implementation with them.
 *
 * Two consumers, one executor, deliberately:
 *
 * - `tests/conformance.test.ts` runs it under `node --test`, so the vectors are
 *   the TypeScript suite's own source of truth and cannot drift from the code
 *   they describe;
 * - `conformance/run.mjs` runs it as a command, printing one strict JSON object
 *   and exiting non-zero on any failure, which is the contract a second
 *   implementation's runner reproduces (see `conformance/README.md`).
 *
 * ## What "no vector is silently skipped" means here
 *
 * Every suite file names its own `count`, and a suite whose `vectors` array is a
 * different length is a hard failure rather than a shorter run. A suite id with
 * no executor is a hard failure, not a skip. A vector whose `expect` this
 * executor does not understand is a hard failure. A file named in the manifest
 * and absent from disk, or present with a different SHA-256, is a hard failure.
 * There is no path through this module that reports success for work it did not
 * do — which is the only property that makes a conformance run mean anything.
 *
 * ## Negative controls
 *
 * A vector marked `"control": true` is a deliberately broken input that MUST be
 * refused. It is checked like any other vector, and additionally counted: a
 * control that *passes* is reported in its own field and fails the run loudly,
 * because a checker that accepts a broken input has stopped checking regardless
 * of how many honest vectors it got right.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { appendAttestation } from "../src/core/attest.js";
import {
  APPEND_ERROR_CODES,
  appendEvent,
  type EventInput,
} from "../src/core/log.js";
import {
  EXECUTE_REFUSAL_CODES,
} from "../src/core/execute.js";
import {
  GATE_REFUSAL_CODES,
  decide,
  expire,
  register,
  registeredAction,
  request,
  withdraw,
  type Decision,
} from "../src/core/gate.js";
import { classifyCommand } from "../src/core/command-class.js";
import { HOOK_DENY_CODES, POST_TOOL_CODES, commandHook } from "../src/cli/hook.js";
import { ANCHOR_REFUSAL_CODES } from "../src/cli/log-anchor.js";
import { CHECKPOINT_REFUSAL_CODES } from "../src/core/checkpoint.js";
import { readVerifiedRecords } from "../src/core/state.js";
import { canonicalize, JcsError } from "../src/core/jcs.js";
import { loadPolicyText } from "../src/core/policy-load.js";
import { resolve as resolveClass } from "../src/core/policy-match.js";
import {
  BRIDGE_REFUSAL_CODES,
  chooseDecision,
  encodeDecision,
  type BridgeOutcome,
} from "../src/cli/codex-bridge.js";
import { CHANNEL_DECISION_REFUSAL_CODES } from "../src/core/sender-identity.js";
import { TOKEN_REFUSAL_CODES, TOKEN_VERIFY_REFUSAL_CODES } from "../src/core/token.js";
import { validate, type ValidationMode } from "../src/core/validate.js";
import { verifyText } from "../src/core/verify.js";

/** Repository root, from `dist/tests/` at runtime. */
export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const CONFORMANCE_DIR = join(REPO_ROOT, "conformance");
export const VECTORS_DIR = join(CONFORMANCE_DIR, "vectors");
export const MANIFEST_PATH = join(CONFORMANCE_DIR, "conformance-manifest.json");
const SCHEMA_DIR = join(REPO_ROOT, "schema");

/** `<major>.<minor>.<patch>`: a suite file's own version, semver, no range. */
const SEMVER = /^\d+\.\d+\.\d+$/u;

// ---------------------------------------------------------------------------
// The file format
// ---------------------------------------------------------------------------

/** What a vector asserts. `valid: false` carries a machine-readable class. */
export interface Expectation {
  valid: boolean;
  failure_class?: string;
  [key: string]: unknown;
}

export interface Vector {
  id: string;
  description: string;
  /** A deliberately broken input that MUST be refused (see the header). */
  control?: boolean;
  input: Record<string, unknown>;
  expect: Expectation;
}

export interface Suite {
  suite: string;
  vectors_version: string;
  algorithm: string;
  description: string;
  count: number;
  vectors: Vector[];
}

export interface VectorOutcome {
  id: string;
  control: boolean;
  ok: boolean;
  expected: Expectation;
  actual: Expectation;
}

export interface SuiteResult {
  suite: string;
  vectors_version: string;
  file: string;
  total: number;
  passed: number;
  failed: VectorOutcome[];
  controls: number;
  /** Controls the implementation ACCEPTED. Any value above zero fails the run. */
  controls_passed_wrongly: number;
}

export interface RunResult {
  ok: boolean;
  runner: "approval-md/typescript";
  suites: SuiteResult[];
  manifest: ManifestResult;
  totals: { vectors: number; passed: number; failed: number; controls: number };
}

// ---------------------------------------------------------------------------
// Loading, with the "silently skipped" holes nailed shut
// ---------------------------------------------------------------------------

export function sha256OfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Suite files on disk, sorted, so a run's order never depends on the OS. */
export function suiteFiles(): string[] {
  return readdirSync(VECTORS_DIR)
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map((entry) => join(VECTORS_DIR, entry));
}

class ConformanceError extends Error {}

export function loadSuite(file: string): Suite {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Suite;
  const problems: string[] = [];
  if (typeof parsed.suite !== "string" || parsed.suite.length === 0) {
    problems.push("no suite id");
  }
  if (typeof parsed.vectors_version !== "string" || !SEMVER.test(parsed.vectors_version)) {
    problems.push(`vectors_version ${JSON.stringify(parsed.vectors_version)} is not semver`);
  }
  if (typeof parsed.algorithm !== "string" || parsed.algorithm.length === 0) {
    problems.push("no algorithm");
  }
  if (!Array.isArray(parsed.vectors) || parsed.vectors.length === 0) {
    problems.push("no vectors");
  } else if (parsed.count !== parsed.vectors.length) {
    // The envelope's own count is the guard against a vector quietly going
    // missing from a file nobody reads end to end.
    problems.push(
      `count says ${String(parsed.count)} and the file holds ${String(parsed.vectors.length)}`,
    );
  }
  const seen = new Set<string>();
  for (const vector of parsed.vectors ?? []) {
    if (typeof vector.id !== "string" || vector.id.length === 0) problems.push("a vector has no id");
    else if (seen.has(vector.id)) problems.push(`duplicate vector id ${vector.id}`);
    else seen.add(vector.id);
    if (typeof vector.expect !== "object" || vector.expect === null) {
      problems.push(`vector ${vector.id} has no expect`);
    } else if (typeof vector.expect.valid !== "boolean") {
      problems.push(`vector ${vector.id} does not say whether it expects a valid outcome`);
    } else if (!vector.expect.valid && typeof vector.expect.failure_class !== "string") {
      problems.push(`vector ${vector.id} expects a refusal but names no failure_class`);
    }
    if (vector.control === true && vector.expect?.valid !== false) {
      problems.push(`vector ${vector.id} is a negative control that expects to pass`);
    }
  }
  if (problems.length > 0) {
    throw new ConformanceError(`${file}: ${problems.join("; ")}`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

export interface Manifest {
  manifest_version: string;
  description: string;
  files: Record<string, string>;
}

export interface ManifestResult {
  ok: boolean;
  /** Files whose digest differs, are missing, or are on disk but unpinned. */
  problems: string[];
}

export function loadManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
}

/**
 * Every pinned file matches its digest, and every file that ought to be pinned
 * is. Both directions: an unpinned suite file would run without ever having been
 * reviewed, and a pinned file that changed is the drift the pin exists to catch.
 */
export function checkManifest(): ManifestResult {
  const manifest = loadManifest();
  const problems: string[] = [];
  for (const [relative, expected] of Object.entries(manifest.files)) {
    let actual: string;
    try {
      actual = sha256OfFile(join(REPO_ROOT, relative));
    } catch {
      problems.push(`${relative} is pinned by the manifest and missing from disk`);
      continue;
    }
    if (actual !== expected) {
      problems.push(
        `${relative} changed: manifest pins ${expected.slice(0, 12)}…, disk holds ${actual.slice(0, 12)}…`,
      );
    }
  }
  for (const file of suiteFiles()) {
    const relative = file.slice(REPO_ROOT.length);
    if (!Object.hasOwn(manifest.files, relative)) {
      problems.push(`${relative} is a vector file the manifest does not pin`);
    }
  }
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// Executors — one per suite id
// ---------------------------------------------------------------------------

type Executor = (input: Record<string, unknown>) => Expectation;

function str(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") {
    throw new ConformanceError(`vector input.${key} must be a string`);
  }
  return value;
}

// --- jcs-canonicalization ---------------------------------------------------

/**
 * A double named by its 64-bit big-endian pattern.
 *
 * Numbers are named by bits and never by a decimal literal: retyping
 * `5e-324` in source would test the language's lexer rather than the
 * serializer, and the bit pattern is the one description every language agrees
 * on exactly.
 */
function doubleFromBits(bits: string): number {
  if (!/^[0-9a-f]{16}$/u.test(bits)) {
    throw new ConformanceError(`ieee754_bits must be 16 lowercase hex digits, got ${bits}`);
  }
  const buffer = Buffer.from(bits, "hex");
  return buffer.readDoubleBE(0);
}

function runJcs(input: Record<string, unknown>): Expectation {
  let value: unknown;
  if (typeof input["ieee754_bits"] === "string") {
    value = doubleFromBits(input["ieee754_bits"]);
  } else {
    const source = str(input, "input_json");
    try {
      value = JSON.parse(source);
    } catch {
      return { valid: false, failure_class: "not-json" };
    }
  }
  try {
    const canonical = canonicalize(value);
    return {
      valid: true,
      canonical,
      utf8_hex: Buffer.from(canonical, "utf8").toString("hex"),
    };
  } catch (cause) {
    if (cause instanceof JcsError) return { valid: false, failure_class: cause.code };
    throw cause;
  }
}

// --- refusal-unions ---------------------------------------------------------

const UNIONS: Readonly<Record<string, readonly string[]>> = {
  gate_refusal_codes: GATE_REFUSAL_CODES,
  token_verify_refusal_codes: TOKEN_VERIFY_REFUSAL_CODES,
  token_refusal_codes: TOKEN_REFUSAL_CODES,
  execute_refusal_codes: EXECUTE_REFUSAL_CODES,
  append_error_codes: APPEND_ERROR_CODES,
  anchor_refusal_codes: ANCHOR_REFUSAL_CODES,
  checkpoint_refusal_codes: CHECKPOINT_REFUSAL_CODES,
  // APRV-311. The two harness-hook vocabularies were closed sets in the source
  // and in nothing else, which is how `hook-io` came to mean both "this event
  // was malformed" and "this harness version is refused outright". A caller
  // branches on these strings exactly as it branches on the gate's, so they
  // belong where a change to them is a visible diff.
  hook_deny_codes: HOOK_DENY_CODES,
  post_tool_codes: POST_TOOL_CODES,
  // APRV-324. The refusals the decision SURFACE makes, before the gate is
  // called: its own union rather than two more members of the gate's, because
  // `decide` cannot emit them and a second implementation reading them there
  // would be told its gate must.
  channel_decision_refusal_codes: CHANNEL_DECISION_REFUSAL_CODES,
  // APRV-361. The refusals `approval codex bridge` reaches ON ITS OWN, before
  // or instead of asking the gate: a question it cannot bind, one it has no
  // reading for, and a file change whose content arrived on a frame it is not
  // correlating yet. Its own union rather than more members of the hook's,
  // because the hook cannot emit them and a second implementation reading them
  // there would be told its hook must.
  bridge_refusal_codes: BRIDGE_REFUSAL_CODES,
};

function runUnion(input: Record<string, unknown>): Expectation {
  const name = str(input, "union");
  const codes = UNIONS[name];
  if (codes === undefined) return { valid: false, failure_class: "unknown-union" };
  return { valid: true, codes: [...codes] };
}

// --- policy-resolution ------------------------------------------------------

function runPolicyResolution(input: Record<string, unknown>): Expectation {
  const load = loadPolicyText("APPROVAL.md", str(input, "policy"), { schemaDir: SCHEMA_DIR });
  const reversible = input["reversible"];
  const resolution = resolveClass(
    load,
    str(input, "class"),
    typeof reversible === "boolean" ? { reversible } : {},
  );
  const outcome: Expectation = {
    valid: load.ok,
    autonomy: resolution.autonomy,
    provenance: resolution.provenance,
    matched_pattern: resolution.matched === null ? null : resolution.matched.pattern,
    floor_applied: resolution.floorApplied,
    allow_irreversible: resolution.allowIrreversible,
    irreversible_patterns: resolution.irreversiblePatterns,
    limits: resolution.limits,
  };
  if (!load.ok) outcome["failure_class"] = load.code;
  return outcome;
}

// --- chain-verification -----------------------------------------------------

function runChainVerification(input: Record<string, unknown>): Expectation {
  const lines = input["lines"];
  if (!Array.isArray(lines)) throw new ConformanceError("vector input.lines must be an array");
  const terminated = input["final_newline"] !== false;
  const text = lines.length === 0 ? "" : `${lines.join("\n")}${terminated ? "\n" : ""}`;
  const head = input["expected_head"];
  const verified = verifyText(
    "events.jsonl",
    text,
    head === undefined || head === null
      ? { schemaDir: SCHEMA_DIR }
      : { schemaDir: SCHEMA_DIR, expectedHead: head as { seq: number; hash: string } },
  ).result;
  if (verified.status === "clean") {
    return {
      valid: true,
      records: verified.records,
      head_seq: verified.head === null ? null : verified.head.seq,
      head_hash: verified.head === null ? null : verified.head.hash,
    };
  }
  if (verified.status === "torn-tail") {
    return {
      valid: false,
      failure_class: "torn-tail",
      intact_through_seq: verified.intactThroughSeq,
    };
  }
  return {
    valid: false,
    failure_class: verified.reason,
    first_bad_seq: verified.firstBadSeq,
  };
}

// --- schema-validation ------------------------------------------------------

/**
 * The failure taxonomy for a write-boundary refusal: `schema-<keyword>` of the
 * first reported error, plus every (path, keyword) pair.
 *
 * The keyword is the vocabulary of JSON Schema itself rather than of Ajv, so a
 * second implementation validating with a different library reports the same
 * class for the same violation. The pairs are sorted, because error ORDER is a
 * library's business and conformance is not.
 */
function runSchemaValidation(input: Record<string, unknown>): Expectation {
  const mode = input["mode"] === "historical" ? "historical" : "write";
  const result = validate(str(input, "schema"), input["document"], {
    schemaDir: SCHEMA_DIR,
    mode: mode as ValidationMode,
  });
  if (result.ok) return { valid: true };
  const errors = result.errors
    .map((error) => ({ path: error.path, keyword: error.keyword }))
    .sort((a, b) => `${a.path} ${a.keyword}`.localeCompare(`${b.path} ${b.keyword}`));
  return {
    valid: false,
    failure_class: `schema-${errors[0]?.keyword ?? "unknown"}`,
    errors,
  };
}

// --- gate-verdicts ----------------------------------------------------------

interface GateStep {
  op: string;
  [key: string]: unknown;
}

let gateCounter = 0;
let gateRoot: string | null = null;

function gateHome(): string {
  gateRoot ??= mkdtempSync(join(tmpdir(), "approval-md-conformance-"));
  gateCounter += 1;
  const dir = join(gateRoot, `case-${String(gateCounter)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Release the scratch homes the gate vectors wrote into. */
export function cleanup(): void {
  if (gateRoot !== null) rmSync(gateRoot, { recursive: true, force: true });
  gateRoot = null;
}

const CLOCK_BASE = "2026-08-05T10:00:00.000Z";

function clockAt(minutes: unknown): () => string {
  const offset = typeof minutes === "number" ? minutes : 0;
  const ts = new Date(Date.parse(CLOCK_BASE) + offset * 60_000).toISOString();
  return () => ts;
}

/**
 * A scripted gate scenario: a policy on disk, then a list of operations, each of
 * which may refuse. The verdict of the LAST step is the vector's outcome; an
 * earlier step that refuses is a broken vector, not a result, and says so.
 */
function runGateVerdict(input: Record<string, unknown>): Expectation {
  const dir = gateHome();
  const policyPath = join(dir, "APPROVAL.md");
  writeFileSync(policyPath, str(input, "policy"), "utf8");
  const logPath = join(dir, ".approval", "log", "events.jsonl");
  const steps = input["steps"];
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new ConformanceError("vector input.steps must be a non-empty array");
  }

  let outcome: Expectation = { valid: false, failure_class: "no-step-ran" };
  for (const [index, raw] of (steps as GateStep[]).entries()) {
    const options = { policy: { file: policyPath }, clock: clockAt(raw["at"]) };
    const last = index === steps.length - 1;
    outcome = runGateStep(logPath, policyPath, raw, options);
    if (!outcome.valid && !last) {
      return {
        valid: false,
        failure_class: "setup-refused",
        step: index,
        step_op: raw.op,
        step_failure: outcome["failure_class"],
      };
    }
  }
  return outcome;
}

/** How many records the log holds, verified as always; `-1` if it cannot be read. */
function logRecordCount(logPath: string): number {
  const read = readVerifiedRecords(logPath, { schemaDir: SCHEMA_DIR });
  return read.ok ? read.records.length : -1;
}

function runGateStep(
  logPath: string,
  policyPath: string,
  step: GateStep,
  options: { policy: { file: string }; clock: () => string },
): Expectation {
  const actor = typeof step["actor"] === "string" ? step["actor"] : "agent:claude";
  switch (step.op) {
    case "attest": {
      const result = appendAttestation(logPath, policyPath, actor, { clock: options.clock });
      return result.ok
        ? { valid: true, event: "policy.updated" }
        : { valid: false, failure_class: result.error.code };
    }
    case "register": {
      const result = register(
        logPath,
        { task: str(step, "task"), envelope: step["envelope"] },
        actor,
        options,
      );
      return result.ok
        ? { valid: true, event: "task.registered", actions: result.actions.length }
        : { valid: false, failure_class: result.code };
    }
    case "request": {
      const payload = step["payload"];
      const result = request(
        logPath,
        {
          task: str(step, "task"),
          actionKey: str(step, "action"),
          cls: str(step, "class"),
          ...(typeof step["est_cost_usd"] === "string"
            ? { est_cost_usd: step["est_cost_usd"] }
            : {}),
          ...(typeof step["reversible"] === "boolean" ? { reversible: step["reversible"] } : {}),
          ...(typeof step["payload_hash"] === "string"
            ? { payload_hash: step["payload_hash"] }
            : {}),
          ...(payload === undefined ? {} : { payload: { value: payload } }),
        },
        actor,
        options,
      );
      return result.ok
        ? {
            valid: true,
            event: result.record === null ? "none" : result.record.event,
            autonomy: result.resolution.autonomy,
            proceed: result.proceed,
          }
        : {
            valid: false,
            failure_class: result.code,
            // What a refused intake LEFT BEHIND, counted from the log rather
            // than asserted in prose. Most refusals must append nothing, and
            // `budget-exceeded` must append exactly one `budget.exceeded`; a
            // failure_class alone cannot tell those two apart, and "nothing was
            // recorded" is half of what several of these refusals promise.
            records: logRecordCount(logPath),
          };
    }
    case "decide": {
      const result = decide(logPath, str(step, "action"), str(step, "decision") as Decision, actor, {
        ...options,
        ...(typeof step["note"] === "string" ? { note: step["note"] } : {}),
      });
      return result.ok
        ? { valid: true, event: result.record.event }
        : { valid: false, failure_class: result.code };
    }
    case "withdraw": {
      const result = withdraw(logPath, str(step, "action"), actor, {
        ...options,
        ...(typeof step["reason"] === "string"
          ? { reason: step["reason"] as "superseded" }
          : {}),
      });
      return result.ok
        ? { valid: true, event: result.record.event }
        : { valid: false, failure_class: result.code };
    }
    case "lookup": {
      // SPEC.md §7's declaration check, on its own: the log is asked what it
      // knows about `(task, actionKey)`. This is where `not-registered` and
      // `action-not-registered` are produced.
      const records = readVerifiedRecords(logPath, { schemaDir: SCHEMA_DIR });
      if (!records.ok) return { valid: false, failure_class: records.code };
      const found = registeredAction(records.records, str(step, "task"), str(step, "action"));
      return found.ok
        ? { valid: true, class: found.action.class, est_cost_usd: found.action.est_cost_usd ?? null }
        : { valid: false, failure_class: found.code };
    }
    case "expire": {
      const result = expire(logPath, str(step, "action"), options);
      return result.ok
        ? { valid: true, event: result.record.event }
        : { valid: false, failure_class: result.code };
    }
    case "append": {
      // A raw append carries its own `ts`: `appendEvent` takes no clock, which
      // is the point — only gate-typed writers stamp time themselves.
      const result = appendEvent(logPath, step["event"] as EventInput);
      return result.ok
        ? { valid: true, event: result.record.event, seq: result.record.seq }
        : { valid: false, failure_class: result.error.code };
    }
    default:
      throw new ConformanceError(`unknown gate step op ${JSON.stringify(step.op)}`);
  }
}

// --- hook-read-scope (APRV-347) ---------------------------------------------

/**
 * The read scope, per harness, as a language-neutral suite.
 *
 * The inputs name targets SYMBOLICALLY (`inside`, `outside`, `absent`,
 * `unresolvable`) rather than by path, because a vector carrying
 * `/Users/carter/...` would be a fact about one machine. A conforming runner
 * builds a gate root, puts a file in it, and picks something outside every read
 * root for `outside`; this runner uses `/etc/hosts`, which is outside a scratch
 * gate root and outside the temp roots on every platform the suite runs on.
 *
 * `read.file.out_of_scope` is `human-only` in the fixture policy. That is not
 * advice about what a project should write — it is the one autonomy whose
 * refusal is immediate, total and appends nothing, so a vector measures the
 * ROUTING (did this envelope reach policy resolution under that class?) without
 * also standing up a channel, a daemon and a timeout.
 */
const READ_SCOPE_POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "1h"',
  "  on_expiry: reject",
  "classes:",
  "  read.*:",
  "    autonomy: autonomous",
  "  read.file.out_of_scope:",
  "    autonomy: human-only",
  "  files.write.workspace:",
  "    autonomy: autonomous",
  "```",
  "",
].join("\n");

/** A path outside a scratch gate root and outside every temp root. */
const READ_SCOPE_OUTSIDE = "/etc/hosts";

function readScopeTarget(kind: string, dir: string): string | null {
  switch (kind) {
    case "inside":
      return join(dir, "src", "a.ts");
    case "inside-relative":
      return "src/a.ts";
    case "outside":
      return READ_SCOPE_OUTSIDE;
    case "unresolvable":
      return "/nonexistent-root-aprv347/deep/x";
    case "absent":
      return null;
    default:
      throw new ConformanceError(`unknown read-scope target ${JSON.stringify(kind)}`);
  }
}

function runHookReadScope(input: Record<string, unknown>): Expectation {
  const harness = str(input, "harness");
  const dir = gateHome();
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), READ_SCOPE_POLICY, "utf8");
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n", "utf8");
  const attested = appendAttestation(
    join(dir, ".approval", "log", "events.jsonl"),
    join(dir, "APPROVAL.md"),
    "human:conformance",
  );
  if (!attested.ok) {
    throw new ConformanceError(`the fixture policy could not be attested: ${attested.error.code}`);
  }

  // APRV-243. Grok Build's envelope is this one with camelCase keys, and a
  // vector that sent it snake_case would pass through the adapter's
  // snake_case-first fallback and prove nothing about the dialect.
  const camelCase = harness === "grok";
  const body = {
    // Self-reported and deliberately wrong: a conforming runtime resolves
    // the scope from its own directory (SPEC.md §11.1 invariant 4).
    cwd: "/somewhere/else",
    // APRV-350. Muse refuses every tool call on a Contributor-tier model, so
    // its ordinary vectors must name a Standard one or they would all measure
    // the guard instead of the read scope. `contributor_model: true` is how a
    // vector asks to measure the guard on purpose.
    ...(harness === "muse"
      ? { model: input["contributor_model"] === true ? "muse-spark-1.3-contributor" : "muse-spark-1.3" }
      : {}),
    ...(camelCase
      ? {
          sessionId: "conformance-read-scope",
          hookEventName: "PreToolUse",
          toolName: str(input, "tool"),
          toolInput: readScopeInput(input, dir),
          toolUseId: "conformance-tu-1",
        }
      : {
          session_id: "conformance-read-scope",
          hook_event_name: harness === "cursor" ? "preToolUse" : "PreToolUse",
          tool_name: str(input, "tool"),
          tool_input: readScopeInput(input, dir),
          tool_use_id: "conformance-tu-1",
        }),
  };
  const stdin = input["malformed"] === true ? "{not json at all" : JSON.stringify(body);

  const out: string[] = [];
  const err: string[] = [];
  const code = commandHook(
    [harness],
    { out: (text) => out.push(text), err: (text) => err.push(text) },
    dir,
    () => stdin,
  );
  // Every other harness answers both verdicts at exit 0 and treats anything
  // else as a broken hook. Grok Build reads EXIT 2 as the deny and exit 0 as
  // the allow, whatever stdout said, so 2 is a verdict there and not a failure.
  if (code !== 0 && !(camelCase && code === 2)) {
    throw new ConformanceError(`hook exited ${String(code)}: ${err.join("")}`);
  }
  const parsed = JSON.parse(out.join("")) as Record<string, unknown>;
  const nested = parsed["hookSpecificOutput"] as Record<string, unknown> | undefined;
  const permission = String(
    harness === "cursor"
      ? parsed["permission"]
      : camelCase
        ? parsed["decision"]
        : nested?.["permissionDecision"],
  );
  const reason = String(
    harness === "cursor"
      ? parsed["agent_message"]
      : camelCase
        ? parsed["reason"]
        : nested?.["permissionDecisionReason"],
  );
  // The exit code is the third field of Grok's protocol, so the body and the
  // exit must agree. A deny printed at exit 0 is the exact hazard the adapter
  // exists to remove, and it would read as an ALLOW.
  if (camelCase && code !== (permission === "deny" ? 2 : 0)) {
    throw new ConformanceError(
      `the Grok verdict ${JSON.stringify(permission)} was answered at exit ${String(code)}; deny is 2 and allow is 0`,
    );
  }
  const colon = reason.indexOf(":");
  return {
    valid: permission === "allow",
    permission,
    // The code, present only for a deny. The REASON TEXT is deliberately not
    // pinned: it is prose a runtime may improve, and a conformance suite that
    // froze it would be freezing an English sentence.
    ...(permission === "deny" && colon > 0 ? { failure_class: reason.slice(0, colon) } : {}),
    gated: permission === "deny" || !reason.includes("is not a gated tool"),
  };
}

function readScopeInput(input: Record<string, unknown>, dir: string): Record<string, unknown> {
  const tool = str(input, "tool");
  const target = readScopeTarget(str(input, "target"), dir);
  if (tool === "Bash" || tool === "Shell" || tool === "bash") {
    // APRV-350: Muse's shell tool carries the PER-CALL working directory
    // beside the command, which is the directory the classifier must resolve
    // relative paths against.
    return {
      command: target === null ? "ls" : `cat ${target}`,
      ...(tool === "bash" ? { workdir: dir } : {}),
    };
  }
  // APRV-350: Muse's own read tools. `read_file` names one path; `search`
  // names an ARRAY under `paths`, which is the shape a live session was
  // observed reaching outside the workspace with.
  if (tool === "read_file") return target === null ? { limit: 5 } : { path: target, limit: 5 };
  if (tool === "search") {
    return target === null
      ? { pattern: "needle", output_mode: "text" }
      : { pattern: "needle", output_mode: "text", paths: [target] };
  }
  if (tool === "write_file") {
    return { path: target ?? "probe.txt", content: "x\n" };
  }
  if (target === null) return { pattern: "**/*.ts" };
  return tool === "Read" ? { file_path: target } : { pattern: "**/*.ts", path: target };
}

// --- command-class (APRV-353, APRV-352) -------------------------------------

/**
 * The command classifier, as a language-neutral suite.
 *
 * Pure in exactly the way `classifyCommand` is: a string in, segments out, no
 * gate root, no policy, no disk. A conforming implementation runs the same
 * string through its own classifier and must produce the same segmentation and
 * the same classes — which is the point, because the segmentation is the half a
 * second implementation is most likely to get subtly wrong. Reading inside a
 * quoted argument, or failing to read a `$(…)` the shell really does expand,
 * both look like working code until the day they do not.
 *
 * The expectation pins the SEGMENT COUNT, each segment's class and rule, and
 * the bound path where a rule bound one. On a refusal it pins the code and not
 * the detail: the code is the machine's half and is frozen by §11.1, the detail
 * is prose a runtime may improve.
 */
function runCommandClass(input: Record<string, unknown>): Expectation {
  const result = classifyCommand(str(input, "command"));
  if (!result.ok) {
    return { valid: false, failure_class: result.code, segments: null };
  }
  return {
    valid: true,
    segments: result.segments.map((segment) => ({
      class: segment.class,
      rule: segment.rule,
      ...(segment.path === undefined ? {} : { path: segment.path }),
    })),
    classes: result.classes,
  };
}

// --- bridge-decisions -------------------------------------------------------

/**
 * What word the app-server bridge puts on the wire, for one advertised list and
 * one outcome (APRV-367).
 *
 * A BEHAVIOUR rather than an array, which is why it is its own suite and not
 * another `refusal-unions` entry: the thing to pin is that a server offering
 * `acceptForSession` gets `accept`, and a server offering `cancel` gets
 * `decline`, whoever implements the client.
 *
 * An outcome this runtime does not have is REFUSED rather than answered. The
 * bridge means two things and a suite that quietly answered a third would be
 * describing a client that can mean more than this one.
 */
function runBridgeDecisions(input: Record<string, unknown>): Expectation {
  const outcome = str(input, "outcome");
  if (outcome !== "accept" && outcome !== "decline") {
    return { valid: false, failure_class: "unknown-outcome" };
  }
  const advertised = input["advertised"];
  const params =
    advertised === undefined || advertised === null
      ? {}
      : { availableDecisions: advertised };
  const chosen = chooseDecision(params, outcome satisfies BridgeOutcome);
  const encoded = encodeDecision(chosen.decision);
  if (encoded === null) {
    // Unreachable while the implementation holds its own rule, and reported as
    // a failure rather than swallowed: a runner that answered here would be
    // saying the vocabulary is open.
    return { valid: false, failure_class: "unencodable-decision" };
  }
  return {
    valid: true,
    decision: encoded.decision,
    decision_source: chosen.decisionSource,
  };
}

const EXECUTORS: Readonly<Record<string, Executor>> = {
  "jcs-canonicalization": runJcs,
  "refusal-unions": runUnion,
  "bridge-decisions": runBridgeDecisions,
  "policy-resolution": runPolicyResolution,
  "chain-verification": runChainVerification,
  "schema-validation": runSchemaValidation,
  "gate-verdicts": runGateVerdict,
  "hook-read-scope": runHookReadScope,
  "command-class": runCommandClass,
};

/** The suite ids this runner knows how to execute, sorted. */
export function executorNames(): string[] {
  return Object.keys(EXECUTORS).sort();
}

/**
 * Run one vector's input and return what this implementation does with it.
 *
 * The generator (`scripts/regen-conformance-vectors.mjs`) calls this to compute
 * the `expect` blocks it freezes, so a vector file is never hand-copied from
 * anywhere: the behavioural suites are produced by running the reference
 * implementation, and the transcribed ones (RFC 8785, the §11.1 unions) are
 * cross-checked against it before they are written.
 */
export function execute(suite: string, input: Record<string, unknown>): Expectation {
  const executor = EXECUTORS[suite];
  if (executor === undefined) {
    throw new ConformanceError(
      `suite ${JSON.stringify(suite)} has no executor; known suites: ${executorNames().join(", ")}`,
    );
  }
  return executor(input);
}

// ---------------------------------------------------------------------------
// Comparison and the run
// ---------------------------------------------------------------------------

/**
 * Does `actual` satisfy `expected`?
 *
 * Every key the vector states must match exactly; keys the actual outcome
 * carries and the vector does not are ignored. A vector therefore pins what it
 * means to pin, and adding a reported field to an implementation is not a
 * conformance break — while changing a pinned one is.
 */
function satisfies(expected: Expectation, actual: Expectation): boolean {
  for (const [key, value] of Object.entries(expected)) {
    if (JSON.stringify(actual[key]) !== JSON.stringify(value)) return false;
  }
  return true;
}

export function runVector(suite: string, vector: Vector): VectorOutcome {
  const executor = EXECUTORS[suite];
  if (executor === undefined) {
    throw new ConformanceError(
      `suite ${JSON.stringify(suite)} has no executor; known suites: ${executorNames().join(", ")}`,
    );
  }
  const actual = executor(vector.input);
  const control = vector.control === true;
  return {
    id: vector.id,
    control,
    ok: satisfies(vector.expect, actual),
    expected: vector.expect,
    actual,
  };
}

export function runSuiteFile(file: string): SuiteResult {
  const suite = loadSuite(file);
  const outcomes = suite.vectors.map((vector) => runVector(suite.suite, vector));
  return {
    suite: suite.suite,
    vectors_version: suite.vectors_version,
    file: file.slice(REPO_ROOT.length),
    total: outcomes.length,
    passed: outcomes.filter((outcome) => outcome.ok).length,
    failed: outcomes.filter((outcome) => !outcome.ok),
    controls: outcomes.filter((outcome) => outcome.control).length,
    controls_passed_wrongly: outcomes.filter(
      (outcome) => outcome.control && outcome.actual.valid === true,
    ).length,
  };
}

/** Run every suite file on disk, and check the manifest. */
export function runAll(): RunResult {
  const files = suiteFiles();
  if (files.length === 0) {
    throw new ConformanceError(`no vector files under ${VECTORS_DIR}; refusing to report success`);
  }
  const suites = files.map((file) => runSuiteFile(file));
  const manifest = checkManifest();
  const totals = suites.reduce(
    (acc, suite) => ({
      vectors: acc.vectors + suite.total,
      passed: acc.passed + suite.passed,
      failed: acc.failed + suite.failed.length,
      controls: acc.controls + suite.controls,
    }),
    { vectors: 0, passed: 0, failed: 0, controls: 0 },
  );
  const ok =
    manifest.ok &&
    totals.failed === 0 &&
    suites.every((suite) => suite.controls_passed_wrongly === 0);
  return { ok, runner: "approval-md/typescript", suites, manifest, totals };
}
