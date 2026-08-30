# The approval.md conformance suite

SPEC.md §13 reserves a Rust fast-path for the hot loop (policy resolution,
chain-tail verification, gate verdicts) with "conformance defined by the fixture
suite". This directory is that suite: a language-neutral description of what an
approval.md implementation must do, in files that any language can read and no
language can quietly skip.

```
conformance/
  vectors/*.v1.json          the vectors, one file per surface
  conformance-manifest.json  SHA-256 of every vector file and of the runner
  run.mjs                    the reference runner (TypeScript implementation)
  README.md                  this file: the runner contract
```

Run it:

```sh
npm run build && node conformance/run.mjs
```

`npm test` runs the same vectors through `tests/conformance.test.ts`, so the
TypeScript suite and a second implementation are answering the same questions
from the same bytes.

## The file format

Every suite file carries an envelope and a flat list of vectors:

```json
{
  "suite": "policy-resolution",
  "vectors_version": "1.0.0",
  "algorithm": "SPEC.md §5.2 class matching and specificity, §7 irreversibility floor",
  "description": "…",
  "provenance": "…",
  "count": 12,
  "vectors": [
    {
      "id": "floor-irreversible-blocks-autonomous",
      "description": "…",
      "control": true,
      "input": { "...": "suite-specific" },
      "expect": { "valid": true, "autonomy": "manual", "floor_applied": true }
    }
  ]
}
```

- **`vectors_version`** is semver and belongs to the file, not to the runtime. A
  new vector is a minor bump; a changed expectation is a major one, because it
  changes what a second implementation is required to do.
- **`count`** must equal `vectors.length`. It exists so a vector cannot go
  missing from a file nobody reads end to end.
- **`expect.valid`** is always present. `false` additionally carries
  **`failure_class`**: the machine-readable code the implementation must
  produce. Expected refusals are vectors, not a separate should-throw channel —
  a refusal for the *wrong reason* is a conformance failure, and a taxonomy is
  the only way to say so.
- **`control: true`** marks a **negative control**: a deliberately broken input
  that MUST be refused. A control that passes is reported in its own field and
  fails the run. Honest vectors passing is not evidence that a checker checks;
  broken ones failing is.
- Comparison is **subset**: every key the vector states must match exactly, and
  keys the implementation reports beyond them are ignored. Adding a reported
  field is not a conformance break; changing a pinned one is.

## The runner contract

A conforming runner — the one in `run.mjs`, or the one a second implementation
writes — MUST:

1. **Take the vectors by path.** It reads `conformance/vectors/*.json` from the
   repository, and every file it finds there is a file it runs. No allowlist, no
   per-language subset.
2. **Run every vector.** A suite id it has no executor for is a **hard failure**,
   not a skip. A vector whose `expect` it does not understand is a hard failure.
   An empty vectors directory is a hard failure. There must be no path through
   the runner that reports success for work it did not do.
3. **Check the manifest.** Every file in `conformance-manifest.json` must match
   its SHA-256, and every vector file on disk must be pinned. Drift in either
   direction fails.
4. **Emit strict JSON on stdout** — exactly one object, nothing else — with per
   suite: `suite`, `vectors_version`, `total`, `passed`, `failed[]`, `controls`,
   `controls_passed_wrongly`; and overall `ok`, `runner`, `totals`. Diagnostics
   go to stderr.
5. **Exit deliberately.**

   | code | meaning |
   |---|---|
   | 0 | every vector passed, every control was refused, the manifest matched |
   | 1 | a conformance failure: a vector's outcome did not satisfy its `expect`, or a control passed |
   | 2 | an INTERNAL failure: no executor for a suite, a malformed vector file, a count mismatch, an empty directory, the runner could not start |

   Exit 2 is distinct from exit 1 on purpose: the difference between "this
   implementation is wrong" and "this run did not happen" is the difference a CI
   log has to make without a human reading it.

## The suites

| suite | what it pins |
|---|---|
| `jcs-canonicalization` | RFC 8785 serialization: key ordering at every level, string escaping, and ECMAScript number formatting named by IEEE-754 bit pattern. The digest of every record in SPEC.md §8 is taken over these bytes. |
| `refusal-unions` | The five closed refusal-code unions of SPEC.md §11.1 invariant 6, in definition order. A caller branches on these strings. |
| `policy-resolution` | SPEC.md §5.2 matching and specificity, §7's irreversibility floor, and the fail-closed rule for a policy that does not parse. |
| `chain-verification` | SPEC.md §8: mutation, reorder, splice, duplication, truncation (anchored and not), a torn tail, and `alg` tampering, each with the reason a verifier must report. |
| `schema-validation` | Write-boundary validation of every committed schema fixture, with the constraint each refusal violates named — and the APRV-121 read boundary, where a pre-change monetary amount must still validate. |
| `gate-verdicts` | Scripted gate scenarios: a policy, a sequence of operations, and the verdict of the last one, covering the refusal codes intake and decision can produce. |

One suite also states a **boundary** rather than a capability, because an
implementation that claims more than the design gives is the failure mode a
conformance suite exists to catch:

- `chain-verification/truncation-unanchored` — records dropped off the tail with
  no external anchor leave a valid chain. Nothing inside the file contradicts it,
  and an implementation reporting corruption here is wrong.

`gate-verdicts` carried a second boundary until APRV-147:
`intake-does-not-check-registration` said SPEC.md §7's declaration requirement
was enforced at execution and at harness consumption but not at intake. Intake
enforces it now, so the vector is `intake-checks-registration` and asserts the
refusal, and the suite's `vectors_version` is 2.0.0 — an implementation that
passed 1.0.0 does not pass this.

`refusal-unions` bumps for the same reason whenever a union grows: the vector
pins the whole array in definition order, so a longer union is a changed
expectation rather than a new vector. It reached 2.0.0 when APRV-146 added
`execution-delegated` to the execute union, and it is 5.0.0 since APRV-145 added
`not-delegated` and `already-finished` to the gate union — the two refusals the
SPEC.md §10.2 completion counterpart can produce.

## Changing the suite

The vectors are generated, never hand-edited:

```sh
npm run build && node scripts/regen-conformance-vectors.mjs
```

Inputs are authored by hand in that script; every `expect` block is computed by
running the reference implementation. **Review the diff.** A regeneration that
moves an expectation is a behaviour change in the runtime, and the vectors are
what a second implementation is held to.
