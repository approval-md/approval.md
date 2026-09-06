---
id: APRV-278
title: The ambient-bleed cross-instance finding fires on the documented start ritual
status: In Progress
assignee:
  - '@opus-278'
created_date: '2026-09-06 01:47'
updated_date: '2026-09-06 08:11'
labels:
  - doctor
  - env
  - ux
dependencies: []
type: bug
ordinal: 205000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
approval up (and doctor) report "APPROVAL_SAMPLING_SECRET is exported in this environment, so <home>'s own line N was not consulted: the value in use is not the one this instance configured" whenever the variable is set in the shell and .approval/env carries a line for it (src/core/instance.ts findingsFor, kind ambient-bleed). The rule is name-only and reads no values (APRV-178, deliberately), so it cannot distinguish a value bled from another instance from one exported a moment earlier by this instance's own `eval "$(approval env)"`, which is the ritual docs/dogfood-cutover.md and the up preflight text prescribe. Seen 2026-09-06: unset the variable, ran eval then up in the primary, and the finding printed anyway, claiming the value in use is not this instance's. The claim is false on that path and the wording asserts a fact the rule did not check. Options: have `approval env` mark what it exported (a sidecar variable naming the instance id and the file mtime it resolved from), so up can tell its own export from a foreign one; or soften the wording to what is known ("was exported before this process started; the file line was not consulted") and drop the "not the one this instance configured" clause.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 After `eval "$(approval env)"` in the primary followed by `approval up`, no cross-instance finding is printed for a variable the eval itself exported from this instance's own file
- [x] #2 A variable exported from a shell profile or another instance's env still produces the finding, with wording that states only what the rule verified
- [x] #3 Test coverage for both cases in tests/instance or tests/cli-up, with no value ever read or printed
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. approval env emits APPROVAL_ENV_PROVENANCE=1:<instanceId>:<sha256 of the env file>:<NAME,NAME> beside its exports, listing only names it resolved from the file (names re-exported as already-set are excluded so a foreign value cannot launder itself). 2. findingsFor treats a set-in-environment variable as this instance's own export when the provenance names this instance, matches the file digest, and lists the variable; otherwise the ambient-bleed finding stands with wording narrowed to what was checked. 3. --check's bleed predicate goes through the same ownEnvExports. 4. Tests for own export, foreign export, other instance, stale digest, and the up preflight end to end.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built across two agent sessions (the first could not compile while the gate was dark). Commit e014c86: src/core/env-file.ts (envFileDigest), src/core/instance.ts (provenance format/parse, ownEnvExports, findingsFor context), src/cli/env.ts, src/cli/help.ts (ENV_HELP back at the 25-line cap), docs/cli-reference.md, tests/instance, cli-env, cli-doctor, up. Validation: build, lint, typecheck clean; instance, cli-env, child-env, cli-doctor, cli-long-help, up, cli-up-preflight suites 175/175. The doctor and up suites scrub an inherited APPROVAL_ENV_PROVENANCE so a maintainer's own shell cannot silence the bleed assertions. Invariant 7 untouched (the human still evaluates the block; the digest read is the name-only diagnostic read APRV-178 already made). Open question for Carter, invariant 4: the provenance variable is self-reported and quiets a diagnostic; the design comment argues it is outside the invariant's scope (it never reaches a verdict, class, budget or token, and anything able to set it could already set the credential variables). If you disagree, the fix is a scope note on invariant 4.
<!-- SECTION:NOTES:END -->
