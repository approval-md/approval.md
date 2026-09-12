---
id: APRV-327
title: Preserve explicit co-author attribution in generated records and merge commits
status: In Progress
assignee:
  - '@codex-sol'
created_date: '2026-09-09 22:39'
updated_date: '2026-09-09 23:42'
labels: []
dependencies: []
priority: high
type: bug
ordinal: 246000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Codex-authored feature commits include attribution, but log advance and its GitHub merge omit it. Add explicit optional attribution to generated delivery without hardcoding a harness or changing approval identities, log content, or existing shared history.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 An explicit validated co-author option is retained in generated records commit messages and the requested GitHub merge body.
- [ ] #2 Default output remains unchanged and metadata cannot inject extra headers, arguments or authority fields.
- [ ] #3 Tests verify real generated commit trailers and merge argv, invalid values refuse before mutation, and docs distinguish co-author credit from gate identity.
- [ ] #4 Reviewed change is delivered and subsequent GitHub attribution is verified; historical shared commits remain unchanged.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add an optional --co-author value at the log advance CLI edge and function boundary. Validate one canonical Name <email> identity with bounded length, no control characters, no newlines, no header fragments, and no ambiguous whitespace before any log snapshot, git object, push, or GitHub call. Never derive it from event actors or use it as approval identity. 2. Append the validated Co-authored-by trailer to the generated records commit message while preserving the default subject and message bytes when omitted. 3. For --pr, append the same trailer to a newly created PR body; for an existing daily PR, read its current body and preserve it while adding the exact trailer once. Use argv arrays and a body file so metadata cannot become gh options. Keep the existing merge-arm argv unchanged. 4. Document that GitHub merge queue ignored a custom autoMergeRequest.commitBody on PR 378, so merge attribution requires the repository merge-commit setting PR_BODY; the package changes no repository settings. 5. Add focused real-git and stub-gh tests for trailers, create/update body bytes, exact merge argv, duplicate delivery, invalid-value refusal before any mutation, and unchanged defaults; update CLI help and registry. Run build, lint, typecheck, and focused suites only while the broad-suite slot is occupied.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implementation checkpoint (2026-09-09): added an optional validated --co-author Name <email> path through log advance. Validation runs at the CLI edge and inside logAdvance before primary-checkout discovery, log snapshotting, git object creation, push or gh. Valid values add one Co-authored-by trailer to the real records commit and to the new or existing PR body; an existing body is preserved and updated once through --body-file, while the merge-arm argv and all omitted-flag output remain unchanged. Attribution is never inferred from event actors and grants no approval identity. Documentation records the observed PR 378 merge-queue loss of autoMergeRequest.commitBody and the repository merge_commit_message=PR_BODY prerequisite; the package changes no repository setting. Focused evidence: build exit 0; cli-log-verbs 43/43 exit 0; cli-help plus cli-long-help 34/34 exit 0; cli-instructions registry 14/14 exit 0 under unrestricted native sandbox access after the managed outer sandbox refused Seatbelt; lint and typecheck exit 0; conformance 298/298 vectors and 143 controls exit 0. No full suite was run because another worker owns the broad-suite slot. Live repository setting request 30346 and subsequent queued-merge attribution remain parent-owned external verification, so no AC is checked and the task remains In Progress.

Review fix and full validation (2026-09-09): duplicate detection now accepts the requested attribution only when the final non-whitespace PR-body line is the exact trailer. A regression preserves a fenced middle-body example containing the same Co-authored-by line, appends a real final trailer, and confirms the next advance does not append it again. Focused cli-log-verbs passed 43/43 exit 0 after the fix. The sole full npm test run with APPROVAL_HUMAN removed completed with actual process exit 0: 4,087 tests, 4,086 passed, 1 skipped, 0 failed, log /private/tmp/aprv327-full.log (341,139 bytes). Git diff --check also exited 0. Repository setting request 30346 later failed indeterminate at 30365 and a read-only GET still showed PR_TITLE, so no PR_BODY configuration or live queued-merge attribution is claimed; parent owns that diagnosis and delivery. During this notes update, unsafe shell quoting around a command label accidentally started a second full test discovery; it was stopped immediately with exit 130 before the Backlog command ran and supplies no evidence.

Final review correction (2026-09-09): a final-looking Co-authored-by line is considered an existing trailer only when the body is exactly that trailer or it is separated from preceding text by a blank line, after CRLF normalization. The regression now covers both a fenced middle-body example and an unseparated final prose line; both original byte sequences survive and one proper blank-separated final trailer is appended, with no further append on retry. Build exited 0 and focused cli-log-verbs passed 43/43 exit 0 after this correction. The previously recorded local full-suite exit 0 preceded this final small correction and is not claimed as post-fix evidence; exact pull-request CI must provide the final broad check. No second completed broad run was performed.

Parent integration check: explicit co-author credit is implemented on direct log advance only. Daemon cadence/up/shutdown/async-child paths reconstruct closed options and do not accept an advance-co-author setting; no identity is inferred. Codex-orchestrated records publication must invoke the reviewed direct CLI with the explicit flag. Global daemon configuration remains unchanged. GitHub PR_BODY setting attempt30365 remains indeterminate, with a live read showing PR_TITLE unchanged; human reconciliation and live queued-merge verification are pending.
<!-- SECTION:NOTES:END -->
