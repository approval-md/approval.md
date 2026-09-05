---
id: APRV-266
title: >-
  protected_paths route to named policy.edit sub-classes, so each protected path
  family gets its own autonomy and live rate
status: In Progress
assignee:
  - 'agent:opus-lane-c'
created_date: '2026-09-05 10:30'
updated_date: '2026-09-05 11:38'
labels:
  - policy
  - classifier
  - dogfood
dependencies: []
priority: high
ordinal: 197000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Carter, 2026-09-05, from the log: policy.edit produced 250 of 351 phone questions since Aug 17 (129 SPEC.md, 28 AGENTS.md, 19 CI workflow, 12 CLAUDE.md, the rest design/ and misc), approved 231 to 7, because one class covers every protected path and the policy can only widen it (protected_paths is additive-only and routes to policy.edit alone; APRV-107, APRV-198). Outcome: a protected_paths entry MAY be an object {path, class} where class is a name under policy.edit.* (the runtime reserves policy.edit.spec for SPEC.md, policy.edit.harness for CLAUDE.md and AGENTS.md, policy.edit.ci for .github/workflows/, policy.edit.design for design/; an author may name their own policy.edit.<word>); a bare string entry keeps today's meaning (policy.edit). Each sub-class resolves like any class through the classes block, falling back to the policy.edit line then defaults, so design/ can be supervised while SPEC.md stays supervised-live 0.1 and the CI workflow stays manual. Floor: the built-in protected set (APPROVAL.md and the approval home stay policy.core, the log stays log.mutate, .claude/settings* and .github/workflows/ cannot resolve below supervised-live at the policy.edit line's rate, or manual if policy.edit is manual), enforced at policy load with a distinct refusal, so a routing can never weaken what an agent could otherwise edit its way out of. The hook, the protected-path guard (hunk-level, APRV-202), the dark-session evaluator, doctor rows and the dogfood pins all read the routed class; the guard's grant cross-check accepts a grant of the routed sub-class or of policy.edit itself. Why: the human should see one in ten spec edits and every CI edit, and zero design-doc edits, without a new class per path in the runtime.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A policy with {path: design/, class: policy.edit.design} and classes policy.edit.design supervised routes an edit under design/ to supervised (test through approval hook classify and the hook), while SPEC.md still resolves policy.edit.spec at the policy.edit line's autonomy when no policy.edit.spec line exists
- [x] #2 A routing that would resolve a built-in protected path below the floor refuses at policy load with a distinct machine-readable code and the policy is inoperative until fixed; a bare string entry behaves exactly as today
- [x] #3 The protected-path guard, dark-session evaluator and doctor rows honour the routed class, and the dogfood pins cover the repo policy's routings; conformance vectors regenerated per the ritual
- [x] #4 Schema amended for the object form (own subtask if non-trivial); SPEC 5.2 and 7 sentences drafted in the notes; docs updated
- [x] #5 npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Type: protected_paths entries become ProtectedPathEntry = string | {path, class}. The string keeps its APRV-107 meaning exactly, so a policy that has not adopted routing classifies byte for byte as before.
2. Classifier (src/core/command-class.ts): POLICY_EDIT_SUBCLASS closes the namespace to one lowercase segment under policy.edit; RESERVED_POLICY_EDIT_SUBCLASSES documents the four reserved names; parseProtectedEntry carries the routed class and returns null for a malformed one so it matches NOTHING rather than falling back; protectedPathClass gains a routed tier BELOW built-in log.mutate/policy.core and ABOVE built-in policy.edit, most-specific-wins with declaration order as tie-break; emittableClass answers reachability with the policy in hand.
3. Load-time floor (src/core/policy-load.ts): new error code protected-route-floor. checkProtectedRouteFloor runs LAST in loadPolicyText, because it is the only check that needs the resolved policy. It uses policy-match's own STRICTNESS table so the floor and the resolver cannot disagree; a route at a built-in policy.core/log.mutate path is refused outright (it could never fire), a route at a built-in policy.edit path must resolve at least as strictly as the policy.edit line (level first, live rate on a tie), and a path the runtime does not protect on its own is unfloored.
4. Resolution (src/core/policy-match.ts): a policy.edit sub-class with no matching rule inherits the policy.edit RULE, with the new provenance 'inherited'. Deliberately not generalized to a universal parent walk. policy-explain gains the trace line; verb-registry gains the enum value.
5. Call sites: widen readonly string[] to readonly ProtectedPathEntry[] mechanically (hook, tagging, dark-session, coverage git source, protected-path-guard, wysiwys view). The guard gains isGrantingClass, accepting a grant of the routed sub-class OR of policy.edit itself.
6. policy-expectations: the unreachable check moves from CLASSIFIER_CLASSES.includes to emittableClass(cls, protected_paths).
7. Schema: items becomes a oneOf over the bare string and the routed object; the path grammar becomes a $def so both shapes are held to one rule.
8. Tests, conformance regeneration with the bumps the ritual requires, docs.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What was built (Lane C, branch aprv-266-path-routing)

A `protected_paths` entry may now be written `{path, class}`, routing that path family to a named sub-class under `policy.edit`. A bare string keeps its APRV-107 meaning exactly, and a string-only policy classifies byte for byte as before (asserted, not asserted-by-inspection: the same corpus is classified through both shapes and compared structurally).

### The tier stack, and why the routed tier sits where it does

`protectedPathClass` answers a path by the strictest surface it names. The routed tier was inserted BELOW the built-in log and gate-organ tiers and ABOVE the built-in `policy.edit` tier, and that one position is the whole routing rule:

- Below the first two, so a routing can never reach the record of what happened or the gate's own organs. SPEC §11.1 invariant 9 says a verb mints no authority over human-only classes; `protected_paths` is the one place a policy could otherwise have reached past it, and the tier order is where that holds. The loader additionally refuses such an entry outright rather than letting it sit inert, because a policy whose author believes a rule is in force that the runtime will never consult is the misreading this project exists to prevent.
- Above built-in `policy.edit`, so a routing CAN re-label a path the runtime protects on its own. That is the feature: `.github/workflows/` to `policy.edit.ci` is the sentence a project wants to write. What stops it being a demotion is the floor, not the classifier — the classifier stays pure and resolves no autonomy at all.

### The floor is load-time and general

`checkProtectedRouteFloor` runs LAST in `loadPolicyText`, because it is the only check there that needs the RESOLVED policy rather than the parsed one. For each entry routing a path the runtime protects on its own, the sub-class must resolve at least as strictly as the `policy.edit` line: level first (through `policy-match`'s own STRICTNESS table, so the floor and the resolver cannot disagree), live rate on a tie (`supervised-live 0.01` under a `supervised-live 0.1` line gates one tenth as often, which is a weakening whatever the level says). It is stated over `builtinProtectedPathClass` rather than over a list of paths, so a built-in surface added later is floored the day it is added. Paths the runtime does not protect on its own are unfloored: their author is choosing the autonomy of a surface they invented, and a loose choice narrows nothing.

A breach fails the LOAD, with the distinct code `protected-route-floor`. A policy that does not load resolves every class to `manual`, which is the strictest available answer and the one this loader has always given.

### Inheritance, and why it is not generalized

A routed class with no line of its own inherits the `policy.edit` RULE, with the new provenance `inherited`. Without it, a repository whose `policy.edit` is supervised-live and whose default is manual would find every routed path GATED the moment it adopted routing — which reads as the feature being broken and invites the author to fix it by loosening something. `inherited` is distinct from `rule` because the winning pattern does not match the class being explained, and distinct from `default` because `defaults.autonomy` did not decide it. Deliberately NOT generalized to a universal parent walk: §5.2 already gives an author `policy.edit.*`, and a parent walk would silently change every class in the taxonomy — `read` is manual in this repository BECAUSE `read.*` does not cover it, and a parent walk would make that pin unstatable.

### The guard's grant cross-check

`isGrantingClass` accepts a grant of the routed sub-class OR of `policy.edit` itself. Both directions are real: the first is the ordinary case once a policy adopts routing; the second because a routing is itself a policy edit and the two are never synchronized, so a grant taken before the routing existed was correct evidence for the edit it authorized and adopting a routing must not retroactively invalidate it. The class only opens the door — the naming test and APRV-202's hunk coverage are untouched, and there is still no class-level pass.

### Reachability

The `unreachable` check in `policy-expectations.ts` moved from `CLASSIFIER_CLASSES.includes` to `emittableClass(cls, protected_paths)`. A routed class is not in the fixed table and never will be: it exists because one policy wrote it beside one path. The negative is the point — a `policy.edit.ci` rule whose routing was deleted looks like protection and is not, and now fails at the ceremony.

## SPEC.md sentence drafts (AC4)

Not applied: agents do not edit SPEC.md. These are the two amendments this change needs, for the human's own ceremony. Neither names a protected path; both state the rule.

**§5.2, after the existing `protected_paths` paragraph:**

> A `protected_paths` entry MAY instead be an object carrying a path and a class, where the class is a name under `policy.edit` with exactly one further lowercase segment. The path family then classifies as that sub-class, which is an ordinary §7 class resolved by an ordinary rule; a sub-class with no rule of its own resolves as the `policy.edit` rule does, with provenance `inherited`. The namespace is closed: an entry MUST NOT route a path to a class outside it. A routing that would resolve a path the runtime protects on its own more loosely than the `policy.edit` rule resolves — comparing the autonomy level first and the live rate on a tie — MUST be refused at load with a distinct machine-readable code, and the policy is inoperative until it is fixed. `protected_paths` remains additive: it widens the protected surface and never narrows it, and routing is a way of describing that surface, never of shrinking it.

**§7, in the class taxonomy, beside `policy.edit`:**

> `policy.edit` admits author-named sub-classes of one further segment, minted by a `protected_paths` routing rather than by the runtime. They carry no authority the parent does not: a grant of one authorizes exactly the protected write it names, and the enforcement paths that accept a `policy.edit` grant accept a sub-class grant on the same terms and on no looser ones. Four names are reserved with fixed meanings so that two policies mean the same thing by them: `policy.edit.spec` for the governing specification, `policy.edit.harness` for agent instruction files and harness configuration that is not the hook itself, `policy.edit.ci` for continuous-integration and release configuration, `policy.edit.design` for design documents and decision records.

## Global invariants touched (CLAUDE.md requires saying so)

**§11.1 invariant 9** (human-only classes are inert to agents; no verb minting authority for them) is the invariant this change runs closest to, and it is upheld in two independent places rather than one: the classifier's tier order answers `policy.core` and `log.mutate` before any policy entry is read, AND the loader refuses a policy that tries. Either alone would hold; both are present because the first is silent and the second is legible.

No other invariant is touched. Enforcement paths still read only verified records; no gate-typed event gained a caller timestamp; no secret reaches the log; nothing self-reported reduces scrutiny; no check-then-append was added.

## Verification evidence

**AC1** — `node cli.js hook classify --json --policy schema/fixtures/policy-md/valid/routed-protected-paths.md -- sed -i '' s/a/b/ design/notes.md` returns `{"class":"policy.edit.design","rule":"protected-path","path":"design/notes.md"}`; the same verb over `.github/workflows/ci.yml` returns `policy.edit.ci`, over `CLAUDE.md` returns `policy.edit` (unrouted, unchanged), over `APPROVAL.md` returns `policy.core` (the routed tier cannot reach it), and over `docs/constitution.md` — routed to `policy.edit.spec` with no `policy.edit.spec` line in the fixture — returns `policy.edit.spec`. `node cli.js policy check --json --policy <that> policy.edit.spec` then answers `autonomy supervised, declaredAutonomy supervised-live, liveRate 0.1, provenance inherited, matched policy.edit`: the sub-class resolves at the `policy.edit` line's own autonomy, which is the AC's second half. The file-tool half of the hook goes through the same `protectedPathClass` call in `fileToolGate` and carries the result out as the action class.

**AC2** — `node cli.js policy check --json --policy <a routed policy whose policy.edit.ci is autonomous> read.shell` answers `manualBecause: "load-failure"`, `loadFailure.code: "protected-route-floor"`, with a message naming the entry and both resolutions; the class asked about is unrelated to the routing, which shows the whole policy is inoperative rather than the one entry. tests/policy-load-route-floor.test.ts (12 tests) covers the stricter-passes, unfloored-path-passes, looser-level-refuses, live-rate-tie-break, route-at-the-log-or-the-organs cases and the bare-string no-op. Byte-identity for a bare string entry is asserted in tests/command-class-routing.test.ts by classifying one corpus through both shapes and comparing the whole classification structurally.

**AC3** — tests/protected-path-guard-routed.test.ts (6 tests), logs built through the real append path: a grant of the routed sub-class is `granted-file` evidence, a grant of `policy.edit` itself still is, a routed grant naming another file is `no-evidence`, and a routed grant that did not bind the hunk is `uncovered-hunk`. The dark-session evaluator and the doctor rows read the guard's own `isGuardedPath` / `isGrantingClass`, so they honour routing by construction; both had their `protected_paths` parameters widened. The dogfood suite's reachability test now asks `emittableClass` with the live policy's own entries, plus a routed-fixture case that exercises the branch the live policy cannot yet reach. Conformance regenerated per the ritual; `node conformance/run.mjs` exits 0, tests/conformance.test.ts 25/25, tests/conformance-regen.test.ts 7/7.

**AC4** — schema/policy.schema.json amended (a `oneOf` over the bare string and the routed object, with the path grammar hoisted to `$defs/protectedPath` so both shapes are held to one rule); two fixtures added, valid and invalid. SPEC 5.2 and 7 sentences drafted above. docs/claude-code-hook.md and docs/cli-reference.md updated.

## For Carter: the APPROVAL.md amendment this unlocks

Not applied. Agents do not edit APPROVAL.md; these are the lines for the ceremony, verified against a scratch copy of the live policy (loads clean, resolves as stated, and the expectations check reports exactly the two missing pins below and nothing else).

Replace the `protected_paths` block:

    protected_paths:            # widens policy.edit; the built-ins hold regardless
      - { path: SPEC.md, class: policy.edit.spec }
      - { path: design/, class: policy.edit.design }
      - { path: .github/workflows/, class: policy.edit.ci }

Add two lines to `classes`, beside the existing `policy.edit`:

      policy.edit.design:        { autonomy: supervised }
      policy.edit.ci:            { autonomy: manual }

What that buys, verified: `design/` resolves supervised-retro (executes, sampled afterwards at audit.supervised_sample_rate, never on the phone); `.github/workflows/` resolves manual (every CI edit gates); `SPEC.md` resolves policy.edit.spec at provenance `inherited`, which is the `policy.edit` line's own supervised-live 0.1, so nothing about the specification changes until a `policy.edit.spec` line is written; `CLAUDE.md` and `AGENTS.md` stay plain `policy.edit` at 0.1; `APPROVAL.md` and the log are untouched by the routing and answer `policy.core` / `log.mutate` as before.

The routing passes the floor: `.github/workflows/` is built-in and `manual` is stricter than `supervised-live 0.1`; `design/` is not a built-in protected path, so it is unfloored and may be looser. Routing `.github/workflows/` to anything looser than the `policy.edit` line refuses the whole policy at load.

**The pins must land in the SAME commit.** `checkPolicyExpectations` reports `unpinned` for both new classes, and `approval policy amend` runs it before it pushes, so the ceremony refuses on the laptop without them. Add to `REPO_POLICY_EXPECTATIONS` in src/core/policy-expectations.ts:

    { actionClass: "policy.edit.design", autonomy: "supervised", provenance: "rule" },
    { actionClass: "policy.edit.ci", autonomy: "manual", provenance: "rule" },

(`policy.edit.spec` takes no pin: it is not declared in `classes`, so nothing flags it, and pinning an inherited class would pin the parent's line twice.)

## One thing AC3 does not yet claim

"The dogfood pins cover the repo policy's routings" is vacuously true today: the live APPROVAL.md carries no routed entry, because agents do not edit it. What is in place is the machinery and the demand — the reachability check asks `emittableClass` with the live policy's own `protected_paths`, and `checkPolicyExpectations` will report `unpinned` for `policy.edit.design` and `policy.edit.ci` the moment the routing lands, which `approval policy amend` runs before it pushes. The routed branch that the live policy cannot yet reach is exercised by a fixture test instead, so the check is not passing for the wrong reason. The two pins are written out above, ready to land in the same commit as the policy edit.

**AC5** — full `npm test` on the frozen tree at c6fb098: **3510 tests, 3509 pass, 0 fail, 1 skipped, exit 0**. The single skip is the pre-existing opt-in external-network probe (`demonstration: curl https://example.com fails inside the sandbox`, gated behind `SANDBOX_PROBE_EXTERNAL=1`), unrelated to this change. `npx oxlint src tests` exit 0. `node conformance/run.mjs` exit 0.

Two earlier full runs were discarded rather than reported: each had a `tsc` rebuild land mid-run, and a suite reading from `dist` while it is being rewritten is not a result worth quoting. The number above is from a run with no edits to the tree from start to finish.
<!-- SECTION:NOTES:END -->
