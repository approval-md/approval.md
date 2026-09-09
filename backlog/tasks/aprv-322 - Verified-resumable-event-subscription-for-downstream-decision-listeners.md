---
id: APRV-322
title: Verified resumable event subscription for downstream decision listeners
status: In Progress
assignee:
  - '@codex-sol'
created_date: '2026-09-08 22:51'
updated_date: '2026-09-09 03:56'
labels: []
dependencies: []
references:
  - 'https://github.com/approval-md/approval.md/issues/139'
priority: medium
type: feature
ordinal: 239000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
GitHub issue #139 requests a channel-independent decision stream for downstream refunds and queue updates. Research a runtime-owned log subscription with resume-from-sequence semantics and the same verified-chain guarantees as existing reads; never treat a filesystem notification or partial tail as an authorized event.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A documented subscription interface emits only verified events after the requested sequence and resumes without silently losing or duplicating the contractually defined stream.
- [x] #2 Tests cover concurrent appends, torn or corrupt tails, restart/resume, cancellation and bounded resource use.
- [x] #3 No event types, enforcement or credential semantics change without explicit design review; documentation names delivery guarantees and limitations.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Implement a runtime-owned pull-based async iterator over verified records and approval log follow --from <seq> --json with exclusive sequence semantics. Default from 0 replays the verified log then follows. Optional expected cursor hash binds resume to the previously consumed prefix; seq alone is documented as weaker bootstrap. No new public package exports. 2. Treat filesystem notifications only as hints, with bounded polling fallback. Verify the complete chain before emitting a batch; corrupt/torn/unreadable/truncated or mismatched cursor state yields existing distinct log exit classes and emits no unverified records. Do not repair or write the log. 3. Bound queued state through pull backpressure, coalesce wakeups, and clean watchers/timers/listeners on cancellation, SIGINT/SIGTERM, downstream pipe closure and errors. Never lose a valid append in watcher setup or read races. 4. Exclude the long-lived verb from finite MCP publication, document at-least-once reconnect semantics and consumer checkpoint ordering, and preserve existing tail/export contracts. 5. Test real append path concurrent appends, restart/resume, malformed/torn/corrupt/truncated chains, hash mismatch, cancellation and slow consumer resource behavior. Run focused checks, build/lint/typecheck, then coordinate one full suite. Parent owns any SPEC amendment and final delivery.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Parent review required native stdout backpressure, capturing the verified cursor before yielding mutable records, and binding a sequence-only cursor on its first accepted snapshot even when already at head. Sol implemented focused regressions for these findings; final/full verification remains pending. Parent applied the three exact specification edits through the primary gate, with execution outcomes 30072, 30074 and 30076. The hash-bound review bundle is /private/tmp/aprv-322-spec-bundle (manifest SHA256 861d5a7fe1a122db993513366360b42d5c1df620ace84bba4feeaae4695f5fb7). Evidence was delivered separately through primary log advance in PR357, commit 2c3ef641d469d82cb1fbecb081ae46ae40644555, with records 30050..30078; feature branches carry no approval log artifacts. No new event types, credentials or approval authority are introduced.

Implementation reviewed and frozen: pull-based verified subscription, exclusive cursor with optional retained hash, first-read hash binding, native stdout backpressure, signal/broken-pipe cleanup, and finite-MCP exclusion. Feature-focused tests passed 44/44; typecheck/lint/build exit 0. Full local suite completed in 571057ms with 4018 tests: 4016 pass, 1 failure, 1 skip, exit 1. The sole failure was LOG_HELP exceeding the short-help limit at 27 lines. After trimming that text and documenting full verification on every 500ms idle poll, final typecheck/lint/build and 50/50 focused help/docs guards plus diff check exited 0. The full local result is retained at /private/tmp/aprv322-full-suite.log; it is not reported as a passing run. Required GitHub CI must verify the complete final head before task completion. Resource limit: O(N) log verification on every wake/poll and O(N) snapshot memory; downstream consumers own idempotent effects and cursor persistence.

Final review added a producer-side test shim around the real process.stdout.write, recording peak writableLength rather than inferring producer memory from the parent read buffer. The real CLI paused-pipe regression bounds output to one record plus native buffering and verifies cancellation-fragment discard followed by replay from the last complete cursor. Native signal cancellation may truncate the final JSON fragment; documentation requires consuming only newline-terminated records. Final build, typecheck, lint, and 67/67 feature/help/docs tests plus diff check exited 0. Runtime and tests are frozen for final-head CI; the earlier full local suite remains honestly recorded as one pre-fix help failure.

Delivery diagnostic: PR358 commit370940cf passed all three full runtime CI shards. Protected-path check failed because primary CLI78baf522 predates APRV316 and retained no exact payload material for the otherwise valid policy-authorized starts30071/30073/30075. Replayed only the existing request calls, with manifest861d5a7f and exact payload hashes, through the current built CLI against primary policy/log; all returned proceed:true/requested:false, exit0. No SPEC rewrite, new grant or execution event was manufactured. Normal gated log advance produced records PR360 commit9e153d8f40de8c40885f98c2582717f8bf2c3124 carrying runtime-stored payloads and genuine records30079..30095. Final protected check and actual merge remain pending.
<!-- SECTION:NOTES:END -->
