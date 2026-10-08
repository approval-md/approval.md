---
id: APRV-338
title: >-
  Human sign-off record for a protected path at a commit: extend organ
  attestation to policy.edit paths so pending sign-off is machine-readable
status: Done
assignee:
  - '@opus-lane-signoff'
created_date: '2026-09-14 22:25'
updated_date: '2026-09-17 01:16'
labels:
  - design
  - guard
  - spec
dependencies: []
priority: medium
ordinal: 256000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC.md's amendment-provenance rule (near line 11) says text that reached a protected file without a grant carries '(Amended APRV-n, pending sign-off.)' until a human ratifies it, and doubt resolves to pending. Nothing today records the ratification: no event, no verb, no way for CI or doctor to tell a ratified amendment from a pending one. Meanwhile APRV-272 already built the exact shape for the gate's organs: a human runs approval policy attest --organ <path>, the runtime appends gate.organ.attested carrying the repository-relative path and the SHA-256 of the bytes, and the protected-path guard (src/core/protected-path-guard.ts, the attested verdict, path plus digest at HEAD) accepts it as evidence that a human saw that content. It is deliberately limited to policy.core organs: organPathRefusal in src/core/attest.ts refuses path-not-organ, and isGateOrganPath in src/core/command-class.ts admits only the hook install files. Proposal: a sibling human-only record (name to decide, for example protected.path.signed_off) with {path, sha256}, appended by a human-only verb after reading the diff, accepted by the guard for policy.edit and policy.edit.* paths the way the organ record is for organs, with SPEC 5.2 and 10 amended and the pending-sign-off suffix defined as resolved by such a record. It is whole-file evidence and therefore weaker than a hunk grant, so the SPEC text must say when it is appropriate (ratifying text a human has read at that commit) and the guard must keep preferring hunk evidence in the reasons it prints. Motivation: PR #393 was blocked by the guard for two SPEC hunks the policy had let proceed unsampled (APRV-337 is the guard bug); the only ways out were re-editing under a grant or fixing the guard, and neither is what a human who has read the diff and agrees with it should have to do. Related: APRV-272 (organ attestation), APRV-316 (policy-authorized tier), APRV-337 (its absolute-path bug).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A new human-only record type carrying a repository-relative protected path and the SHA-256 of its bytes is defined in the event schema and validated at the write boundary; the runtime computes the digest, never the caller
- [x] #2 A human-only verb appends it; run by an agent or without a human actor it refuses with a machine-readable code, and the gate mints nothing for it
- [x] #3 The protected-path guard accepts the record as the attested verdict for policy.edit and policy.edit.* paths only when path and digest at HEAD both match, and its finding names the record; tests are built through the real append path, including a wrong-path and a wrong-digest case
- [x] #4 SPEC 5.2 and 10 are amended to define the record, when it is appropriate, and that it resolves the pending-sign-off suffix; the amendment is called out to the human
- [x] #5 approval doctor or approval status lists protected files whose text carries a pending-sign-off marker with no matching record
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Event type `gate.path.signed_off` (NOT `protected.path.signed_off`): the `gate.` namespace is what SPEC §8's write-boundary clock rule is keyed on, so a `protected.` prefix would have needed §8's gate-typed list widened to keep the runtime stamping `ts`. Enum in schema/event.schema.json plus its own if/then block requiring `^human:` and `{path, sha256}`; EventType in src/core/log.ts with the rationale note; SPEC §8 enum line; four fixtures under schema/fixtures/event/; tests/event-schema.test.ts EVENT_TYPES and EXTRA_REQUIRED.
2. Core (src/core/attest.ts, beside the APRV-272 organ section): PATH_SIGN_OFF_EVENT, SIGN_OFF_PATH_FIELD, PATH_SIGN_OFF_ERROR_CODES (ATTEST_ERROR_CODES plus path-not-protected / path-is-policy / path-is-core), appendPathSignOff(logPath, {path, root, protectedPaths}, actor), pathSignOffOf, findPathSignOff, latestPathSignOff. Order: human actor, then the path rules (repository-relative, not the policy file, not policy.core or log.mutate, must classify policy.edit or policy.edit.*) BEFORE anything is read, then the runtime's own digest. No hash parameter and no ts parameter.
3. CLI: `approval policy attest --path <p>` in src/cli/attest.ts, mutually exclusive with --organ and --policy; the policy's protected_paths loaded from --dir so a routed policy.edit.* path is signable and an unloadable policy narrows rather than widens. help.ts, verb-registry.ts (purpose, --path flag, signed_path in the output object), and a classifier row in src/core/command-class.ts so `approval policy attest --path` classifies policy.core and the hook denies it to an agent.
4. Guard (src/core/protected-path-guard.ts): new optional input pathSha256AtHead; a sign-off index keyed by path+digest; the verdict is consulted AFTER the grant/hunk search has failed, so hunk evidence still leads every reason it prints; the finding names the record, the actor and the seq and says it is whole-file evidence. The no-evidence diagnosis for a policy.edit path names the verb. scripts/protected-path-guard.mjs passes its existing head-blob digest function under the new name too.
5. Doctor: a `pending-sign-off` row listing protected files whose text carries the `pending sign-off` marker with no sign-off record at their current bytes. Informational, never a fail, exactly as gate-organs is: the enforcement is the CI-side guard. tests/doctor-rows.ts roster and README's three row counts and tally.
6. SPEC: §5.2 gains a bullet defining the record as the sibling of the organ attestation (whole-file evidence, weaker than a hunk grant, appropriate for ratifying text a human has read at that commit, and what resolves the `(Amended APRV-n, pending sign-off.)` suffix); §10.1 gains the verb and the health-report obligation; §8's enum line gains the type.
7. Docs: docs/cli-reference.md `--path` section under policy attest, and the doctor row entry.
8. Tests, every log built through the real append path: tests/attest-path-signoff.test.ts (record, refusals, invisibility to the gate), guard cases in tests/protected-path-guard.test.ts including wrong-path and wrong-digest and hunk-evidence-still-leads, CLI cases in tests/cli-attest.test.ts, a doctor case in tests/cli-doctor.test.ts.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What was built (APRV-338)

**The record is `gate.path.signed_off`, not `protected.path.signed_off`.** The task
proposed the latter; the `gate.` prefix won because SPEC §8 keys the
write-boundary timestamp rule on it ("Events written through the gate
(`approval.*`, `execution.*`, `budget.*`, `audit.*`, `gate.*`, `policy.updated`)
have `ts` assigned by the runtime"). A `protected.` prefix would have required
widening that list to keep the runtime stamping `ts`, which is a quieter change
to a stricter rule than it looks. Payload is `{path, sha256}`, both computed by
the runtime.

**Why it is a separate type from `gate.organ.attested` rather than a widening of
it.** The two surfaces differ in what evidence is available. An organ is
`policy.core`, the gate mints nothing for a human-only class, so content
attestation is the ONLY evidence that can exist for one and the guard reads it
FIRST. A protected path has grants available to it, so whole-file evidence must
be read LAST or it would silently answer for every change a grant already
covered. One type carrying both claims would have made that ordering a
convention each reader had to remember; two types make it structural.

**Guard placement is the load-bearing choice.** `signOffEligible` +
`pathSha256AtHead` are consulted after the grant search, the hunk-coverage pass
and the replay have all failed, immediately before the `uncovered-hunk` and
`no-evidence` findings. The passing finding says `WHOLE-FILE evidence and weaker
than a grant` and names how many grants named the path and how many covered part
of it. Both failure details end with `signOffRepair`, which names the verb and
then says `prefer the gate` so the sentence cannot read as an invitation to
route around it. `pathSha256AtHead` is a separate input from `organSha256AtHead`
even though `scripts/protected-path-guard.mjs` passes one function to both: a
caller wired for organs must not silently start answering for sign-offs.

**Eligibility is the loaded policy's, and failing to load narrows.** The verb and
the guard both ask `protectedPathClass(path, protected_paths)` and accept only
`policy.edit` and `policy.edit.*`. A policy that will not load contributes `[]`,
which is the built-in set alone, the strictly narrower answer, the same direction
`classifyCommand` takes when the list is omitted.

**Classifier row.** `approval policy attest --path` classifies `policy.core`
(rule `approval-policy-signoff`), which is the one refinement in
`refineApprovalVerb` that reads a flag rather than the positionals, because the
flag is what changes the act. Verified live: this session's own attempt to run
the verb through the harness hook was denied with `hook-class-human-only` before
the verb's `actor-not-human` refusal was reached. Without `--path` the verb is
byte-for-byte what it was and stays pass-through.

## SPEC §11.1 invariants touched

- **Human-only classes are inert to agents, no verb minting authority (APRV-185).**
  The verb is human-only in four places that do not depend on each other: the
  schema's `^human:` actor pattern, `appendPathSignOff`'s `HUMAN_ACTOR` check
  before anything is read, the CLI's `resolveHumanActor`, and the classifier row
  that makes the hook deny it. It mints no class: `policy.core` already exists
  and was already in the `approval` and `node` rows' `emits`.
- **The runtime computes the digest, never the caller.** No hash parameter and no
  `ts` parameter on `appendPathSignOff`, for the reason `appendOrganAttestation`
  has neither. Asserted in tests/attest-path-signoff.test.ts against
  `policyBytesHash(readFileSync(...))`.
- **Validate at the write boundary.** New `if/then` block in
  schema/event.schema.json requiring `^human:` and `{path, sha256}`; one valid
  fixture and three invalid ones (agent actor, absolute path, missing path).
- **Enforcement paths read only verified records.** The guard's new tier reads
  the same `input.records` every other tier does, which the caller supplies
  verified or not at all; the sign-off index is built from those records alone.
  `approval doctor` reads `verified.records`.
- **Refusals are machine-readable and distinct.** `PATH_SIGN_OFF_ERROR_CODES`
  widens the attestation union for itself with three codes whose repairs differ:
  `path-is-policy` (use the flagless verb), `path-is-core` (use `--organ`, or
  nothing at all for the approval home and the log), `path-not-protected`.

## SPEC amendment (four hunks, called out for the human)

1. Preamble amendment-provenance rule: one sentence, ratification is recorded
   rather than asserted.
2. §5.2: new bullet 'Sign-off on a protected path', sibling of APRV-272's organ
   bullet. Defines the record and the verb, states that it resolves the
   pending-sign-off suffix, states it is whole-file evidence and weaker than a
   grant, and makes normative both the read-it-last rule and the
   only-for-text-a-human-has-read rule.
3. §8: `gate.path.signed_off` added to the event-type enum.
4. §10.1: new paragraph 'Ratifying a protected file's text' — the refusals and
   their order, the classification requirement so an agent is denied before the
   actor rule, and the health-report obligation (MUST list, MUST NOT fail).

All four were applied with the Edit tool and classified `policy.edit.spec`
(supervised-live); none drew the 1-in-100 block, so they proceeded unsampled.
That is precisely the shape PR #393 was refused for, and it is the case this
task exists to make resolvable.

## Verification

- `npm run build`, `npm run typecheck`, `npm run lint`: exit 0 each.
- `node scripts/run-tests.mjs --only attest attest-organ attest-path-signoff
  cli-attest protected-path-guard protected-path-guard-routed
  protected-path-guard-script cli-doctor docs-guard cli-long-help
  cli-instructions command-class command-class-routing event-schema fixtures
  decision-refusal sealed-delivery policy-load-route-floor dogfood` — exit 0,
  tests 1041, pass 1041, fail 0.
- `node scripts/run-tests.mjs --only cli-hook log verify state clock human-only
  gate concurrency values-inert ratchet autonomy-split policy-load cli-policy` —
  exit 0, tests 458, pass 458, fail 0.
- Full `npm test` is CI's (local Node 26 fails 22 email TLS tests, known).
- Every log in the new tests is built through the real append path
  (`core/attest.ts` -> `core/log.ts`, `core/gate.ts` for the grants); nothing
  hand-writes a record line.

## Follow-up after running the guard against this very branch

`node scripts/protected-path-guard.mjs --base origin/main --head HEAD` fails
SPEC.md with `uncovered-hunk` on this PR, which is the expected and intended
outcome: the four SPEC hunks proceeded unsampled under supervised-live, so their
`execution.started` records sit in the primary checkout's LIVE log and have not
been advanced into a records branch. CI's 'protected paths (grant cross-check)'
job fails the same way. That is the case this task exists to make resolvable,
and the failure now ends by naming the route.

Running it also exposed an ergonomic gap the first draft had. The repair
sentence said to ratify 'in the PRIMARY checkout', which hashes the WRONG bytes:
the digest the guard checks is the file's blob at the commit under review, and
the primary checkout holds main's copy. `--dir` and `--log` are already separate
flags for exactly this (`--dir` is the checkout whose bytes are hashed and which
the recorded path is relative to, `--log` is where the record is appended), so
the advice now names both, states the digest the command must produce, and
docs/cli-reference.md carries the worked command. The verb never writes a log
inside the worktree it hashed.

That fix is a second commit rather than an amend: the harness hook denied
`git commit --amend` with `hook-class-human-only` (`vcs.history.rewrite` is
human-only), which is the policy working as written.

## CI state at hand-off (PR #407)

Run 35169334378, commit 78155e5:

- `classify tier`: pass
- `full gate (node 22, shard 1/3)`: pass
- `full gate (node 22, shard 2/3)`: pass
- `full gate (node 22, shard 3/3)`: pass
- `protected paths (grant cross-check)`: **fail**, on SPEC.md, expected
- `ci` (aggregate): fail, because of the line above
- `docs guard`, `node 20 floor`, `records guards`: skipping

Auto-merge is armed (`MERGE`); `mergeStateStatus` is BLOCKED by the cross-check.

The first CI round also failed `full gate shard 1/3` on
tests/conformance-regen.test.ts: the four new event fixtures are conformance
INPUTS, so the frozen `schema-validation` vectors had fallen behind them.
Regenerated through scripts/regen-conformance-vectors.mjs (which computes every
expectation by running this repository's own harness) and bumped
`schema-validation` 2.2.0 -> 2.3.0, a minor, the same shape 2.1.0 was for
`gate.organ.attested`. conformance/README.md's rule is that a version is claimed
at MERGE rather than at branch, so if another lane in this push also bumps that
suite the two resolve to one minor above the higher of them.

Local `node scripts/run-tests.mjs` (whole suite, Node 26): 4187 tests, 4159
pass, 27 fail, exit 1. All 27 are one environment family — Node 26 refuses
`options.servername` set to an IP address, so every test that speaks TLS to
127.0.0.1 fails (adapter-email 14, smtp-probe 4, package-adapters 4, cli-setup
4, codex-package 1). None of them touches anything in this change, and CI's
Node 22 shards pass all three.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added `gate.path.signed_off`, a human-only event carrying a repository-relative protected path and the SHA-256 of its bytes, written by `approval policy attest --path <p>` and read by the protected-path guard as the LAST evidence it looks for. The record resolves SPEC.md's `(Amended APRV-n, pending sign-off.)` suffix, which until now nothing recorded: a human who had read a diff and agreed with it could only re-edit under a grant or change the guard (PR #393). It is whole-file evidence and is treated as weaker than a grant by construction — the guard consults it only after every hunk search has failed, and says so in the finding it prints. The verb refuses the policy file, every `policy.core` surface and the log directory with their own codes, refuses a non-human actor in the schema, in core and in the CLI, and classifies `policy.core` so the harness hook denies it to an agent first. `approval doctor`'s new `pending-sign-off` row lists protected files still carrying the marker with no record over their current bytes, informational and never a fail. SPEC's preamble, §5.2, §8 and §10.1 amended and called out to the human in the PR body. Verified: build, typecheck and lint clean; 1041 tests pass across the affected suites and 458 across the invariant-adjacent ones, both exit 0, every log built through the real append path.
<!-- SECTION:FINAL_SUMMARY:END -->
