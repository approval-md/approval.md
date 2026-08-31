---
id: APRV-163
title: Telegram prompt shows only decision-driving computed rows; anomalies shout
status: Done
assignee: []
created_date: '2026-08-30 21:49'
updated_date: '2026-08-31 16:43'
labels: []
dependencies:
  - APRV-162
ordinal: 140000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The phone prompt renders thirteen computed rows and Carter glosses over most of them: chain, task, state, resolved-by, requested-ts, and payload sha256 are bookkeeping, and budgets/policy/autonomy are noise when they say everything is fine. Trim renderTelegram (telegram only; CLI, web, and --json keep their full field order, and every field stays on ChannelRequest) to the rows that drive the decision, and render the health rows only when they are abnormal, prefixed so they cannot be missed. Precedent: APRV-143 dropped the ttl row; the conformance suite checks the kind of rendered fields, never their presence, so this is conformance-safe.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Default computed rows are exactly: class, commands (when present), protected path (when present), policy diff / policy loads (attestation prompts, unchanged), waiting (with expiry)
- [x] #2 budgets renders only when at least one verdict is not pass, prefixed with a warning marker
- [x] #3 attestation renders only when status is anything but attested, prefixed with a warning marker
- [x] #4 autonomy renders only when its value is not manual
- [x] #5 provenance, payload_hash, requested_ts, chain, task, and state no longer render on Telegram; a comment names each dropped row and where the fact still lives
- [x] #6 CLI and web channel renderings are unchanged; conformance suite passes
- [x] #7 Tests cover presence and absence of each anomaly row in both states, and attestation-prompt rendering unchanged
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read renderTelegram (src/channels/telegram.ts:554-646) and its tests; confirm conformance checks kinds only.
2. Trim computedLines to: class, commands, protected path, policy diff/loads, waiting.
3. Anomaly-only rows with a warning prefix: budgets (any !pass), attestation (not attested), autonomy (not manual).
4. Comment block naming each dropped row (provenance, payload_hash, requested_ts, chain, task, state) and where the fact still lives.
5. Tests: presence/absence per anomaly state, attestation prompts unchanged, re-pin header shapes. npm test + lint.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built 2026-08-30 by an Opus subagent (parallel with APRV-164 in a separate worktree), reviewed by fable, committed 33e9473. renderTelegram computedLines trimmed to class / commands / protected path / policy diff+loads / waiting; TELEGRAM_ANOMALY_MARK "⚠ " prefixes the three health rows, each rendered only when abnormal (autonomy !== manual, any budget verdict !pass — an empty verdict list counts healthy so "no limits apply" no longer renders, attestation !== attested). The six dropped rows are named in one comment block with where each fact still lives; lines[] mirrors the rendered set so lastRendered()/conformance check the real message; waiting stays for the conformance waiting-line check. CLI/web FIELD_ORDER and ChannelRequest untouched. New test section pins presence/absence in both states per row plus the attestation-prompt pair. Verification caveat: the combined T3+T4 full-suite run finished 2417/2422 with five failures, all spawned-CLI/listener tests at 300-1000s durations on a machine at load average 168 (multiple concurrent sessions and another worktree running its own suite); each failing test passed in another run of the same evening, and none touches this change. Lint clean.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The phone prompt renders five decision-driving computed rows; autonomy, budgets and attestation appear only when abnormal, marked ⚠; six bookkeeping rows dropped from Telegram while staying on ChannelRequest for --json, queue and web. Verified by new render tests pinning both states of every row; suite green modulo unrelated load flakes; lint clean.
<!-- SECTION:FINAL_SUMMARY:END -->
