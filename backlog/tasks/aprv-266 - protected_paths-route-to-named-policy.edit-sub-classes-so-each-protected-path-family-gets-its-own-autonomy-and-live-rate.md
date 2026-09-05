---
id: APRV-266
title: >-
  protected_paths route to named policy.edit sub-classes, so each protected path
  family gets its own autonomy and live rate
status: In Progress
assignee:
  - 'agent:opus-lane-c'
created_date: '2026-09-05 10:30'
updated_date: '2026-09-05 11:08'
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
- [ ] #1 A policy with {path: design/, class: policy.edit.design} and classes policy.edit.design supervised routes an edit under design/ to supervised (test through approval hook classify and the hook), while SPEC.md still resolves policy.edit.spec at the policy.edit line's autonomy when no policy.edit.spec line exists
- [ ] #2 A routing that would resolve a built-in protected path below the floor refuses at policy load with a distinct machine-readable code and the policy is inoperative until fixed; a bare string entry behaves exactly as today
- [ ] #3 The protected-path guard, dark-session evaluator and doctor rows honour the routed class, and the dogfood pins cover the repo policy's routings; conformance vectors regenerated per the ritual
- [ ] #4 Schema amended for the object form (own subtask if non-trivial); SPEC 5.2 and 7 sentences drafted in the notes; docs updated
- [ ] #5 npm test passes; lint clean
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
