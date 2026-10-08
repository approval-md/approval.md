---
id: APRV-337
title: >-
  Protected-path guard: the policy-authorized tier rejects the absolute file
  path the hook binds, so an unattended Edit never passes CI
status: Done
assignee:
  - '@claude-fable'
created_date: '2026-09-14 21:43'
updated_date: '2026-09-14 22:36'
labels:
  - ci
  - guard
dependencies: []
priority: high
type: bug
ordinal: 255000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
APRV-316 added the policy-authorized-file tier so an exact Edit that the gate let proceed without a human grant (a supervised-live draw that came up unsampled, or supervised-retro) can pass the protected-path guard. In practice the tier never fires for a Claude Code edit. The hook binds the Edit payload with file set to the worktree's ABSOLUTE path (for example /Users/carter/dev/approval-md/.claude/worktrees/<name>/SPEC.md; see payload a7b48de87e62 registered at seq 31613 and 8b75c80ddb78 at seq 31683 on records-log-2026-09-14), and policyFileEvidence in src/core/protected-path-guard.ts returns null when file starts with a slash. The granted-file tier credits the same absolute-path payloads (grants at seq 31605 and 31610 covered their hunks in the same run), so the two tiers disagree about the shape the hook actually writes. Observed on PR #393 run 34813602123: four SPEC.md edits from one session, the two that were granted covered, the two that proceeded on the draw reported as uncovered-hunk with no evidence, although each has a verified execution.started preceded by its unique registration, no approval.requested, a matching stored payload and a start timestamp before the commit. The practical effect is that every unsampled supervised-live edit to SPEC.md fails CI, which is the situation APRV-316 was filed to end. Fixing this touches an enforcement path (SPEC §11: enforcement paths read only verified records), so the fix must keep the tier's other conditions exactly as they are and must not widen what an absolute path is allowed to mean: the path should resolve to THIS checkout's copy of the protected path the same way commandTargetsPath does for granted-command evidence, and a payload naming another checkout's copy must still cover nothing.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A verified execution.started with its unique matching registration, no prior approval.requested, a stored exact Edit payload whose file is the absolute path of the guarded file inside the checkout under test, and a start timestamp before the change is credited as policy-authorized-file evidence
- [x] #2 The same payload with an absolute path pointing at a different checkout or a dry-run copy of the file covers nothing (regression test)
- [x] #3 Every other condition of the tier from APRV-316 is unchanged and its existing tests still pass; the implementation notes state that this task touches an enforcement path and which SPEC §11 invariant it was checked against
- [x] #4 The two uncovered hunks of PR #393 (SPEC.md lines 139 and 160, starts at seq 31614 and 31684) are reproduced in a test built through the real append path, failing before the fix and passing after
- [x] #5 npm test and lint clean; docs/claude-code-hook.md or the guard's header comment states which path shape the hook binds and which shapes the tier accepts
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add a shared path predicate next to endsWithSegments in src/core/protected-path-guard.ts: true for the exact repository-relative protected path (segment-equal, no .., no backslash) or for an absolute path (leading slash, no backslash, no .. segment) whose trailing segments equal the protected path. Relative paths with extra leading directories stay rejected. 2. Use it in policyFileEvidence and exactReplayEdit in place of the startsWith('/') and join-equality checks; leave every other condition of policyAuthorizedEvidence untouched (unique preceding registration, no approval.requested, routed class, payload rehash, start before anchor within lookback). 3. Tests in tests/protected-path-guard.test.ts through the real append helpers: absolute tail-matching file passes as policy-authorized-file; absolute path to another checkout's copy with bytes absent from base/head still fails uncovered-hunk; dry/SPEC.md, dir/../SPEC.md, backslash and wrong tool shapes stay rejected; exact replay with absolute file passes; a #393-shaped regression (one granted edit plus one unattended absolute-path edit in the same file) fails before the fix and passes after. 4. Header comment of the guard (tier 2) and docs/claude-code-hook.md say the payload file is absolute and CI matches it by tail because the bytes carry the proof. 5. npm test, npm run lint; implementation notes state the enforcement-path touch and that SPEC 11.1 invariant 1 is unchanged.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Added a shared predicate namesProtectedFile(file, path) next to endsWithSegments in src/core/protected-path-guard.ts and used it in policyFileEvidence and exactReplayEdit in place of the startsWith('/') / includes('\\') / join-equality checks. It accepts the bare repository-relative path (segment-equal) and an absolute path whose trailing segments are that path; backslashes, '..' segments and relative paths with extra leading directories (dry/SPEC.md) stay rejected. Nothing else in policyAuthorizedEvidence or the replay changed: unique preceding registration, no approval.requested, routed-class match, payload rehash, start-before-anchor within lookback are byte for byte as APRV-316 left them.

Why the tail match is sound here: the hook binds an ABSOLUTE file (src/cli/hook.ts fileToolGate -> absolute(declared, cwd)), confirmed against the real PR #393 payloads a7b48de87e62... and 8b75c80ddb78... on main, both {tool: Edit, file: /Users/carter/dev/approval-md/.claude/worktrees/emilia-protocol-comparison-af4ffb/SPEC.md}. For Edit/Write material the bytes are the proof (before must occur in the base blob, after in the head blob, the replay must reach HEAD byte-identical), so a scratch or other-checkout copy holding different bytes covers nothing whatever its path says. granted-command keeps commandTargetsPath's cwd-join rule because a command payload describes no bytes. Rationale recorded in the guard header (verdict 2) and in docs/claude-code-hook.md.

Tests (tests/protected-path-guard.test.ts, all through the real append path): /repo/SPEC.md moved out of the rejected shapes into a new passing test for both Edit and Write; /other/../SPEC.md and an absolute tail mismatch added as rejected; an absolute dry-run path whose bytes are in neither blob still fails uncovered-hunk; an exact-replay case with absolute file passes; a #393-shaped case (one granted hunk plus one unattended hunk in the same file, both bound absolutely) passes. Verified the four new tests fail before the fix by temporarily restoring the old behaviour (pass 56 / fail 4), then restored it: 60/60 green.

This task touches an enforcement path. SPEC 11.1 invariant 1 (enforcement paths read only verified records) is unchanged: the same verified records go through the same checks and only the path predicate changed. No SPEC text changed.

Validation: npm run build clean, npm run lint clean (oxlint, exit 0), npm test exit 0 with tests 4121, pass 4120, fail 0, skipped 1.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The policy-authorized-file tier now accepts the absolute file path the Claude Code hook actually binds. A shared predicate namesProtectedFile in src/core/protected-path-guard.ts matches either the bare repository-relative protected path or an absolute path whose trailing segments are it, rejecting backslashes, '..' segments and relative paths with extra leading directories; policyFileEvidence and exactReplayEdit use it and every other condition of the tier is unchanged. Sound because Edit/Write material proves itself by bytes (before in the base blob, after in the head blob, replay reaching HEAD byte-identical), so another checkout's copy still covers nothing; granted-command keeps its cwd-join rule. Rationale added to the guard header (verdict 2) and docs/claude-code-hook.md. Verified: four new tests in tests/protected-path-guard.test.ts, built through the real append path, covering the absolute-path pass for Edit and Write, an absolute dry-run path that still fails uncovered-hunk, an absolute exact replay, and a PR #393-shaped granted-plus-unattended case; those four fail against the pre-fix predicate (56 pass / 4 fail) and pass after (60/60). npm run build and npm run lint clean; npm test exit 0 with 4121 tests, 4120 pass, 0 fail, 1 skipped. Enforcement-path touch checked against SPEC 11.1 invariant 1, which is unchanged.
<!-- SECTION:FINAL_SUMMARY:END -->
