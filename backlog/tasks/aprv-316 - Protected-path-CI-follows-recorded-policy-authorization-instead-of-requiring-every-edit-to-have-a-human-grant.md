---
id: APRV-316
title: >-
  Protected-path CI follows recorded policy authorization instead of requiring
  every edit to have a human grant
status: In Progress
assignee:
  - '@codex'
created_date: '2026-09-08 19:25'
updated_date: '2026-09-08 21:02'
labels: []
dependencies: []
priority: high
type: bug
ordinal: 234000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Carter confirmed that human approval requirements must follow APPROVAL.md. The protected-path guard currently considers human grants and attestations but excludes legitimate unattended execution records, so a supervised-live edit that the primary gate permits without sampling can fail CI. Align evidence verification with the authoritative policy while preserving exact-change coverage and human-only protection.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Exact protected edits authorized by the real gate without a required human grant can pass CI using verified bound evidence.
- [x] #2 Manual or sampled-live actions still require the policy-required grant; human-only organs retain their attestation requirements.
- [x] #3 Missing, corrupt, mismatched, stale or caller-invented authorization evidence fails closed; existing hunk and command-attribution protections remain covered.
- [ ] #4 Regression tests, full required checks, documentation and GitHub delivery record the policy alignment and its limits.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add a distinct policy-authorized exact-file evidence candidate for verified execution.started records, requiring a unique preceding registration with matching task, action key, class, and recomputed committed payload hash. 2. Admit only exact Edit/Write evidence with existing before/after/content hunk coverage, require the start before the protected change and within the existing recency bound, and reject starts preceded by an unresolved approval cycle. 3. Preserve grant, attestation, command attribution, apply_patch naming-only, and human-only organ behavior unchanged. 4. Add focused real-append regression tests for a genuine unattended start plus pending, rejected, mismatched, stale, posthoc, and hunk-mismatch cases; run the focused guard suite, build, and lint.

5. Retain supplied exact payload material on the existing successful nonmanual request branch: re-read the registered declaration, require the same task/action/class and declared hash, recompute the canonical material hash, and use the existing payload-store writer before returning the unchanged proceed verdict. Preserve calls that supply no material and refuse mismatch, invalid material, corrupt existing payload, or storage failure without writing approval records.

Add a bounded exact-replay fallback for genuine authorized Edit sequences whose inline fragments cannot prove whole changed lines independently. Replay eligible starts in execution order from the committed BASE bytes; require a unique nonempty before match, supported exact material shape and matching registered authorization; admit only byte-identical committed HEAD. Preserve class, hash, path, time, approval and human-only restrictions. Test fragmented multi-edit success, unauthorized same-line additions, duplicate matches, missing/reordered/mismatched evidence and hybrid payloads before actual SPEC verification.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Checkpoint: automatic approval review rejected the source mutation accepting verified unattended execution.started evidence as a persistent security-boundary change requiring explicit user authorization. Sol reversed only its partial guard draft; owned source/test diff is clean, exit0. No APRV316 implementation tests ran. Parent documentation paragraph remains a proposed draft pending implementation and must not be shipped as implemented. Agreed contract: exact Edit/Write evidence only, preceding unique matching registration/task/action/class/hash, recomputed payload, routed-class correspondence, no unresolved approval cycle, start before change, unchanged hunk/organ protections; no new events or current-autonomy exemption. Current feature worktree /private/tmp/approval-codex-hook, branch codex/codex-hook, HEAD d33d24a. Await explicit authorization for this precise CI evidence change; APPROVAL.md remains unchanged.

Carter explicitly authorized changing protected-path CI to accept verified, policy-authorized execution records for exact Edit/Write changes without a human grant, while preserving payload matching, pending-approval checks, routed-class correspondence, and human-only protections.

Implemented after explicit authorization. Astra final security review clear. Exact-file policy-authorized evidence requires unique preceding matching registration, genuine verified start, registered payload rehash, routed class match, unambiguous relative path and bounded timing; prior approval requests and human-only organs are excluded. Nonmanual request now retains supplied registered payload through the existing writer and refuses corrupt or mismatched material. Focused guard48/48, retention7/7, gate88/88 all exit0. Full npm test3945pass/1skip/0fail, lint0, typecheck0, conformance0. Five missing exact SPEC materials retained through the reviewed request path from the primary checkout; verified log remained29929 records. Separate records delivery PR345 pushed at20e2f743, auto-merge armed, checks running. CI parity and feature delivery remain pending.

Pre-push ci:local exited0 atf6a1f85, but its protected-path wrapper falsely reported no protected paths changed. Sol traced a preexisting enforcement bypass: readEntries discarded routed {path,class} policy entries. Reviewed proposed wrapper fix retains supported entries and value-deduplicates the BASE/HEAD union without losing conflicting classes. Two exact edits are pending real primary policy.edit.ci manual requests29937/29938, taskAPRV-316-CI-wrapper. No script mutation occurred. Regression tests now cover an unapproved routed SPEC edit and a routed BASE protection removed at HEAD. Do not count the earlier wrapper result as evidence that SPEC was enforced; rerun after the gated fix.

Both wrapper grants arrived and exact edits executed through primary gate, outcomes29945/29947. Applied after-file SHA18239ab8727f22b531e5c5afee4012573281da6c11108567c5ea5df1f1ff5a11. Astra final review clear. Focused wrapper11/11, guard48/48, routed6/6,ci-local21/21 exit0; beforefix wrapper9pass2fail reproduced bypass. Actual wrapper now finds SPEC but reports6uncovered lines: genuine original payloads bind inline fragments while coverage matches complete lines. Sol/Astra investigating conservative reconstruction before claiming actual evidence passes. Records retry reconciled: PR345 merged into4de944c; normal incremental advance pushedf8d31aa in PR347 with auto-merge armed. No historical payload/event edits.

Sol verified the seven original genuine Edit starts replay in execution sequence to byte-identical HEAD (193380bytes), each before uniquely matched. Astra recommended exact full-file replay as stronger evidence than substring coverage; parent accepted under APRV316. Reviewer later hit a runtime usage limit, so parent retains final architecture/security review; do not claim another completed independent review until it occurs. Codex coauthored commits through34204b4 are verified on remote PR344. Records PR347 merged at0e031e3; original records PR345 merged at4de944c.

Exact-replay implementation and parent security review: require supported exact Edit shape, canonical material hash, exact routed class/path, unique preceding registration, real matching execution start and manual grant/request linkage, bounded pre-change timestamp, execution-sequence order and unique anchors including overlapping matches. Existing valid coverage and metadata-only behavior remain unchanged; fallback must reconstruct full committed HEAD. Focused build0,guard51/51,wrapper11/11,routed6/6,ci-local21/21,lint0,diffcheck0. Actual SPEC guard exit0 using origin/main seq29952, coveredBy29912/29914/29916/29918/29921/29924/29927 and corresponding genuine starts29912/29914/29916/29918/29922/29924/29928. Final review is tightening rehash at replay use to avoid relying on repeated payloadFor reads being stable. Full suite running at prior replay snapshot; final CI parity will test the committed result.

Final rehash-at-use regression passed: every replay candidate is independently rehashed before deriving an Edit, including a stateful payloadFor callback that changes its second answer. Final focused build0,guard52/52,lint0,diffcheck0; actual SPEC guard exit0 again, saved /private/tmp/aprv-316-actual-guard-final.json. Parent reviewed final code and docs. Implementation frozen for final committed CI parity; no new protected edit, approval event type or dependency.
<!-- SECTION:NOTES:END -->
