---
id: APRV-143
title: >-
  Prompt metadata reads at a glance: day-aware expiry, no ttl line, the
  protected path named
status: Done
assignee: []
created_date: '2026-08-25 13:47'
updated_date: '2026-08-26 10:27'
labels:
  - channels
  - ux
dependencies: []
priority: high
ordinal: 128000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Born 2026-08-25 from Carter reading the records-commit prompt on the phone. Three metadata gaps: (1) clockText (src/channels/tagging.ts:406) renders time-of-day only, so a deadline 24 hours out reads 'expires 13:09 UTC' with no hint it means tomorrow; (2) the 'ttl: 23h 59m left' line duplicates the expires line (expires = requested + TTL) and burns a metadata row; (3) the prompt says class policy.edit without saying WHICH protected path fired, though the hook knows the matched path and rule. Outcome: clockText becomes day-aware (same-day: 'expires 13:09 UTC'; next day: 'expires tomorrow 13:09 UTC'; later: 'expires 27 Aug 13:09 UTC'), shared by the waiting and wait-until lines; the rendered ttl line is removed (the value stays in --json, additive removal from the rendered form only); COMPUTED gains 'protected path: <path> (rule <name>)' when a protected-path or classifier rule selected the class, threaded from the hook's existing rule/path knowledge. Display-side only; no schema, no gate changes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Deadlines crossing a day boundary render the day; same-day deadlines are unchanged; both waiting-line variants share the implementation, tested
- [x] #2 The rendered prompt carries no ttl line; --json still carries the TTL; tests updated
- [x] #3 A protected-path-classified prompt names the matched path and rule in COMPUTED, tested for shell and file-tool payloads
- [x] #4 npm test passes; lint clean
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built 2026-08-26 by an Opus subagent (resumed once after a network drop), reviewed by fable, merged in PR #120 (commit 2473399). clockText is day-aware in UTC (same-day unchanged; tomorrow HH:MM; DD Mon HH:MM further out or past), shared by both waiting-line branches; unparseable now degrades to time-only. The rendered ttl line is gone from the Telegram prompt only (ttl_remaining_ms stays on ChannelRequest for --json, CLI queue, web). COMPUTED protected-path line re-derives at render time: isProtectedPath re-runs over the target and a payload claiming an unknown rule name renders the classifier's own answer (tested with a hostile rule string). The shell side needed a classifier-output addition only (ClassifiedSegment gained optional path from the protected-path rules); nothing gate-recorded moved. A pre-existing test assertion pinning 'expires 10:01 UTC' under a 24h TTL was itself the reported bug and was corrected. Out of scope, noticed: render-queue.ts:278 still prints a TTL countdown in the CLI queue (correct per this task's phone-only scope). 2075 tests at this commit, lint clean.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Prompt deadlines carry their day, the redundant ttl line is gone, and the matched protected path and rule are named in COMPUTED, re-derived rather than copied. Verified by render tests incl. hostile rule-name claims; merged in PR #120.
<!-- SECTION:FINAL_SUMMARY:END -->
