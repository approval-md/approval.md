---
id: APRV-327
title: Preserve explicit co-author attribution in generated records and merge commits
status: In Progress
assignee:
  - '@codex-sol'
created_date: '2026-09-09 22:39'
updated_date: '2026-09-17 01:58'
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
- [x] #1 An explicit validated co-author option is retained in generated records commit messages and the requested GitHub merge body.
- [x] #2 Default output remains unchanged and metadata cannot inject extra headers, arguments or authority fields.
- [x] #3 Tests verify real generated commit trailers and merge argv, invalid values refuse before mutation, and docs distinguish co-author credit from gate identity.
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

Closeout verification by the closeouts lane, 2026-09-16. The reviewed change is on main: PR #381 is MERGED at merge commit 6b8f2d32a19eccaa996245cc3998aa5f7615923b; the branch head was e57680e2be65f91f93b8d8aa6501f6e939e981a8. PR CI run 34418422745 passed ci, all three node-22 full-gate shards, protected paths and classify tier; the merge commit's own run 34421841142 concluded success. Re-verified at merged main in a clean worktree: node scripts/run-tests.mjs --only cli-log-verbs cli-help cli-long-help cli-instructions, wrapper exit 0, tests 91 / pass 91 / fail 0. Build, typecheck and lint each exit 0.

AC1 checked. src/cli/log-advance.ts carries the option end to end: coAuthor on the options type at line 156, validated at the CLI edge and again inside logAdvance before any primary-checkout discovery, log snapshot, version-control object creation, push or gh call at line 287, the trailer appended to the generated records commit message through messageWithCoAuthor at lines 574 and 919-925, and appended once to the pull request body for both the create and the update arm of ghPullRequest at lines 699 and 973-1017.

AC2 checked. The value can only ever be the trailer's text: validateCoAuthor bounds the byte length, refuses control and separator characters and surrounding whitespace, and requires exactly one Name and email shape at lines 898-913. The value travels in argv arrays and a body file rather than as an interpolated gh option, so it cannot become a flag or an extra header. With the flag omitted the commit message, PR body and merge argv are unchanged byte for byte. The refusal is machine-readable, code log-advance-co-author-invalid at line 126.

AC3 checked. tests/cli-log-verbs.test.ts has the three cases the criterion names, green inside the 91-test result above: explicit co-author reaches the real commit and new PR body without entering gh argv at line 859, which asserts both the real generated trailer and the exact merge argv; an existing PR body is preserved and receives one co-author trailer at line 909, covering duplicate delivery against a real prior body; and invalid co-author values refuse before any mutation at line 943, proving the refuse-before-mutation ordering. docs/cli-reference.md lines 488-500 state the distinction the criterion asks for in as many words: the trailer is display credit only, and it does not set an event actor, name an approver, ident authority, or derive an identity from the log.

AC4 NOT checked, and it is the only thing left. Its historical half holds: no shared history was rewritten by this task. Its live half needs the repository setting this package deliberately does not change. Read today, the repository merge_commit_message is still PR_TITLE, with merge_commit_title MERGE_MESSAGE which is already correct, so a queued merge commit still cannot carry the PR body's trailer and there is as yet nothing to verify. That flip is Carter's, section 3 of private/runbook-2026-09-16.md, one command: gh api -X PATCH repos/approval-md/approval.md -f merge_commit_message=PR_BODY. After it, the first records pull request the daemon merges is the proof, and AC4 closes on that merge commit's body carrying the trailer. The task stays In Progress until then.

Typo correction to the AC3 note above: the cli-reference sentence reads that the trailer does not set an event actor, name an approver, grant authority, or derive an identity from the log. The word was mistyped as ident in the preceding paragraph.

Closeout delivered in pull request #414 (lane/closeouts). AC4 still waits on the repository setting, runbook section 3.
<!-- SECTION:NOTES:END -->
