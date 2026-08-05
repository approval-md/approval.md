---
id: APRV-31
title: 'approval doctor: environment sanity in one verb'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-05 12:19'
updated_date: '2026-08-05 12:56'
labels: []
milestone: m-6
dependencies: []
priority: medium
type: feature
ordinal: 31000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up 4-adjacent (human-approved 2026-08-09), motivated by the stale-checkout and placeholder-binary detours in the amendment ceremony: the operator ran against an outdated build and an unbuilt bin before finding the real one. approval doctor checks, in one pass, each failure paired with a suggested fix: build freshness (dist mtime/content vs git HEAD state, and cli.js loader vs dist presence), identity resolution (APPROVAL_HUMAN/--as), attestation status vs the live policy hash, log verification summary, and channel reachability probes — Telegram send-capability via getMe (never sending a decision or message), web port availability. Read-only except the probes' outbound calls; appends nothing.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 approval doctor reports pass/fail per check — build freshness, identity, attestation vs live hash, log verification, channel probes — each failure with a concrete suggested fix line
- [x] #2 The Telegram probe proves send-capability without sending anything a human sees (getMe/token validity only, never a message or decision); web probe checks the configured port is free or held by us
- [x] #3 Exit 0 all-pass, 1 any-fail; --json frozen; appends nothing to the log (byte-check test); probes skipped cleanly with a note when env is absent
- [x] #4 Subprocess tests cover: stale dist (older than a touched source file), missing dist (the placeholder-binary shape), unattested and hash-mismatched policy, unreachable mock Telegram, all-green
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented by Opus subagent in isolated worktree; fable review found nothing to override. Check semantics accepted: build-freshness markers the exact file cli.js loads vs max mtime of src/ + tsconfig.json, with three distinct shapes (stale build / unbuilt checkout / no bin loader) because their repairs differ, and published installs skip rather than silently pass; the freshness root derives from the module URL not cwd (the question is whether the running code is stale); --root is test-only and documented as such in --help (an undocumented flag in a diagnostic verb is what this project exists not to do); exit 4 reserved for doctor's own inability to look — an unreadable log or policy is an environment fact and a check failure at exit 1; one verifyWithRecords walk feeds both attestation and log checks so two walks cannot disagree; getMe-only Telegram probe with token redaction and BotFather fix on unauthorized; a held web port passes with a note (likeliest holder is our own channel). Testing findings recorded: the suite spawns the CLI asynchronously because spawnSync would block the event loop hosting the mock Bot API; runCli refuses a configured Telegram env without --api-base so no test can drift onto the real network; EACCES not simulated (needs a privileged port, non-portable) — documented at the test rather than left a coin-flip; the doctor suite was optimized from 18s to 6s to stop pushing the (since-deflaked) TTL test over its limit. Healthy run against the live repo shows attestation seq 3 sha 8ac906a4... and the log at head seq 3. Verified on merged tree: 884/884, lint, typecheck.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
approval doctor: six checks (build freshness with three failure shapes incl. the placeholder-binary incident, identity, attestation vs live hash, log verification, getMe-only Telegram probe, web port) each paired with a concrete fix line; exit 0/1/4 semantics; appends nothing. 25 tests. Verified: 884/884, lint, typecheck.
<!-- SECTION:FINAL_SUMMARY:END -->
