/**
 * The conformance suite, run against this implementation (APRV-122).
 *
 * The vector files are the source of truth: this suite reads them and asserts
 * that the reference implementation does what they say, rather than restating
 * the same expectations in TypeScript where the two copies could drift. A
 * behaviour change therefore shows up here as a failing vector and in the
 * manifest as a changed digest, which is the pair of signals SPEC.md §13 needs
 * before a second implementation can be called conforming.
 *
 * What this file additionally guards, beyond "every vector passes":
 *
 * - the envelope of every suite (id, semver, algorithm, a count that matches);
 * - the manifest pins every vector file and the runner, and nothing has moved;
 * - every executor the harness offers is exercised by a file on disk, and every
 *   file on disk has an executor — neither can go quiet;
 * - the negative controls are present in every suite and are actually refused;
 * - the full refusal-code unions of SPEC.md §11.1 invariant 6 are covered.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { APPEND_ERROR_CODES } from "../src/core/log.js";
import { EXECUTE_REFUSAL_CODES } from "../src/core/execute.js";
import { GATE_REFUSAL_CODES } from "../src/core/gate.js";
import { TOKEN_REFUSAL_CODES, TOKEN_VERIFY_REFUSAL_CODES } from "../src/core/token.js";
import {
  checkManifest,
  cleanup,
  executorNames,
  loadManifest,
  loadSuite,
  runSuiteFile,
  suiteFiles,
} from "./conformance-harness.js";

after(cleanup);

const FILES = suiteFiles();

test("the conformance directory holds vector files, and a run over none is not a pass", () => {
  assert.ok(FILES.length > 0, "no vector files: `node scripts/regen-conformance-vectors.mjs`");
});

test("every suite file declares a well-formed envelope", () => {
  for (const file of FILES) {
    // `loadSuite` throws on a missing id, a non-semver version, a count that
    // disagrees with the vectors, a duplicate id, an expectation with no
    // `valid`, a refusal with no `failure_class`, or a control that expects to
    // pass. Loading each file IS the assertion.
    const suite = loadSuite(file);
    assert.ok(suite.vectors.length > 0);
  }
});

test("every executor is exercised, and every suite file has an executor", () => {
  const onDisk = FILES.map((file) => loadSuite(file).suite).sort();
  assert.deepEqual(
    onDisk,
    executorNames(),
    "a suite with no executor would be a silent skip, and an executor with no suite is a surface nobody checks",
  );
});

test("the manifest pins every vector file and the runner, with no drift", () => {
  const result = checkManifest();
  assert.deepEqual(
    result.problems,
    [],
    "conformance/conformance-manifest.json is out of date; regenerate with `node scripts/regen-conformance-vectors.mjs` and review the diff — a changed expectation is a behaviour change",
  );
  assert.equal(result.ok, true);
  const manifest = loadManifest();
  assert.ok(Object.hasOwn(manifest.files, "conformance/run.mjs"), "the runner itself is unpinned");
  assert.ok(
    Object.hasOwn(manifest.files, "tests/conformance-harness.ts"),
    "the executor itself is unpinned",
  );
});

for (const file of FILES) {
  const suite = loadSuite(file);
  test(`conformance: ${suite.suite} (${String(suite.count)} vectors)`, () => {
    const result = runSuiteFile(file);
    assert.deepEqual(
      result.failed.map((outcome) => ({
        id: outcome.id,
        expected: outcome.expected,
        actual: outcome.actual,
      })),
      [],
    );
    assert.equal(result.passed, result.total);
  });

  test(`conformance: ${suite.suite} negative controls are all refused`, () => {
    const result = runSuiteFile(file);
    assert.ok(
      result.controls > 0,
      `${suite.suite} ships no negative control; a suite with nothing deliberately broken cannot show that it checks anything`,
    );
    assert.equal(
      result.controls_passed_wrongly,
      0,
      "a deliberately broken input was ACCEPTED: the checker has stopped checking",
    );
  });
}

test("the RFC 8785 examples canonicalize, and are pinned by their published bytes", () => {
  // A guard against the quiet way a transcribed vector goes wrong: an input
  // mangled in transit still produces a stable `expect`, and the suite freezes
  // "this input is not JSON" as though that were the RFC's answer. These two
  // vectors MUST succeed, and their §3.2.4 hex is the RFC's own.
  const file = FILES.find((candidate) => loadSuite(candidate).suite === "jcs-canonicalization");
  assert.ok(file !== undefined);
  const byId = new Map(loadSuite(file).vectors.map((vector) => [vector.id, vector]));
  for (const id of ["rfc8785-3.2.3-sorting", "rfc8785-3.2.2-full-example"]) {
    const vector = byId.get(id);
    assert.ok(vector !== undefined, `${id} is missing`);
    assert.equal(vector.expect.valid, true, `${id} does not canonicalize`);
  }
  assert.equal(
    byId.get("rfc8785-3.2.2-full-example")?.expect["utf8_hex"],
    // RFC 8785 §3.2.4, the published UTF-8 output for the §3.2.2 example.
    "7b226c69746572616c73223a5b6e756c6c2c747275652c66616c73655d2c226e756d62657273223a5b" +
      "3333333333333333332e333333333333332c31652b33302c342e352c302e3030322c31652d32375d2c" +
      "22737472696e67223a22e282ac245c75303030665c6e4127425c225c5c5c5c5c222f227d",
  );
});

// ---------------------------------------------------------------------------
// The runner's own failure paths (AC #3, #5): a checker that cannot fail is not
// a checker, so the ways this one must fail are themselves tested.
// ---------------------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), "approval-md-conformance-negative-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let temporaryCounter = 0;

/** A suite file on disk, built from `body`. Returns its path. */
function temporarySuite(body: unknown): string {
  temporaryCounter += 1;
  const path = join(scratch, `suite-${String(temporaryCounter)}.json`);
  writeFileSync(path, JSON.stringify(body), "utf8");
  return path;
}

const MINIMAL_SUITE = {
  suite: "refusal-unions",
  vectors_version: "1.0.0",
  algorithm: "SPEC.md §11.1 invariant 6",
  description: "a hand-built suite, for the runner's own failure paths",
  count: 1,
  vectors: [
    {
      id: "one",
      description: "the gate union",
      input: { union: "gate_refusal_codes" },
      expect: { valid: true },
    },
  ],
};

test("a count that disagrees with the file is a failure, not a shorter run", () => {
  const path = temporarySuite({ ...MINIMAL_SUITE, count: 9 });
  assert.throws(() => loadSuite(path), /count says 9/u);
});

test("a suite with no id, no semver, or a duplicate vector id is refused", () => {
  assert.throws(() => loadSuite(temporarySuite({ ...MINIMAL_SUITE, suite: "" })), /no suite id/u);
  assert.throws(
    () => loadSuite(temporarySuite({ ...MINIMAL_SUITE, vectors_version: "1.0" })),
    /not semver/u,
  );
  assert.throws(
    () =>
      loadSuite(
        temporarySuite({
          ...MINIMAL_SUITE,
          count: 2,
          vectors: [MINIMAL_SUITE.vectors[0], MINIMAL_SUITE.vectors[0]],
        }),
      ),
    /duplicate vector id/u,
  );
});

test("a refusal vector that names no failure_class is refused", () => {
  assert.throws(
    () =>
      loadSuite(
        temporarySuite({
          ...MINIMAL_SUITE,
          vectors: [{ ...MINIMAL_SUITE.vectors[0], expect: { valid: false } }],
        }),
      ),
    /names no failure_class/u,
  );
});

test("a negative control that expects to pass is refused by the loader", () => {
  assert.throws(
    () =>
      loadSuite(
        temporarySuite({
          ...MINIMAL_SUITE,
          vectors: [{ ...MINIMAL_SUITE.vectors[0], control: true }],
        }),
      ),
    /negative control that expects to pass/u,
  );
});

test("a suite id with no executor is a hard failure, never a skip", () => {
  const path = temporarySuite({ ...MINIMAL_SUITE, suite: "no-such-surface" });
  assert.throws(() => runSuiteFile(path), /has no executor/u);
});

test("a control the implementation accepts is counted and fails the run", () => {
  // The control here is broken on purpose in the OTHER direction: it says it is
  // a control and expects a refusal this implementation does not give. That is
  // exactly the shape of a checker that stopped checking, and the runner has to
  // notice it rather than reporting one ordinary failed vector.
  const path = temporarySuite({
    ...MINIMAL_SUITE,
    vectors: [
      {
        id: "control-that-passes",
        description: "an input the implementation accepts, mislabelled as broken",
        control: true,
        input: { union: "gate_refusal_codes" },
        expect: { valid: false, failure_class: "unknown-union" },
      },
    ],
  });
  const result = runSuiteFile(path);
  assert.equal(result.failed.length, 1);
  assert.equal(result.controls, 1);
  assert.equal(result.controls_passed_wrongly, 1);
});

test("the §11.1 invariant 6 refusal unions are covered in full", () => {
  const file = FILES.find((candidate) => loadSuite(candidate).suite === "refusal-unions");
  assert.ok(file !== undefined, "the refusal-unions suite is missing");
  const suite = loadSuite(file);
  const pinned = new Map<string, unknown>();
  for (const vector of suite.vectors) {
    if (vector.expect.valid) pinned.set(String(vector.input["union"]), vector.expect["codes"]);
  }
  assert.deepEqual(pinned.get("gate_refusal_codes"), [...GATE_REFUSAL_CODES]);
  assert.deepEqual(pinned.get("token_verify_refusal_codes"), [...TOKEN_VERIFY_REFUSAL_CODES]);
  assert.deepEqual(pinned.get("token_refusal_codes"), [...TOKEN_REFUSAL_CODES]);
  assert.deepEqual(pinned.get("execute_refusal_codes"), [...EXECUTE_REFUSAL_CODES]);
  assert.deepEqual(pinned.get("append_error_codes"), [...APPEND_ERROR_CODES]);
});

test("every gate refusal code a scripted scenario can reach is pinned by a vector", () => {
  // Not every code in the union is reachable through the gate-verdict DSL —
  // some need a torn log, a crashed writer, or a revoked token — so this asserts
  // COVERAGE OF WHAT IS REACHABLE and names the rest, rather than a total that
  // would be satisfied by lowering the bar.
  const file = FILES.find((candidate) => loadSuite(candidate).suite === "gate-verdicts");
  assert.ok(file !== undefined, "the gate-verdicts suite is missing");
  const covered = new Set(
    loadSuite(file)
      .vectors.filter((vector) => !vector.expect.valid)
      .map((vector) => String(vector.expect.failure_class)),
  );
  const expected = [
    "actor-not-human",
    "already-decided",
    "budget-exceeded",
    "duplicate-request",
    "envelope-invalid",
    "action-not-registered",
    "not-registered",
    "not-requested",
    "not-requester",
    "payload-hash-required",
    "policy-not-attested",
    // APRV-173: both request-volume refusals are reachable through the DSL, so
    // both are required to be pinned rather than merely permitted.
    "queue-full",
    "rate-limited",
    "request-withdrawn",
    "task-already-registered",
  ];
  for (const code of expected) {
    assert.ok(covered.has(code), `no gate vector pins the refusal code ${code}`);
  }
  for (const code of covered) {
    assert.ok(
      (GATE_REFUSAL_CODES as readonly string[]).includes(code),
      `gate vector pins ${code}, which is not in the §11.1 gate refusal union`,
    );
  }
});
