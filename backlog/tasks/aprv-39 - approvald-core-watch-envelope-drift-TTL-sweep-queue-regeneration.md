---
id: APRV-39
title: 'approvald core: watch, envelope drift, TTL sweep, queue regeneration'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-05 14:18'
updated_date: '2026-08-05 17:32'
labels: []
milestone: m-7
dependencies:
  - APRV-38
priority: high
type: feature
ordinal: 39000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC section 10.2: the daemon watches the backlog folder and the log, validates new and changed envelopes, applies policy, expires TTLs, re-renders projections. This task is the loop itself, foreground under approval daemon run (adopting the channel-listen pattern; backgrounding is the operator's business in v0.1): fs watch on the task folder and log; envelope validation on change with envelope.drift appended when a file contradicts the log (section 6.3); lazy TTL sweep appending approval.expired (system actor) on schedule; QUEUE.md regeneration on every relevant event; loop-escalation surfacing (the gate already refuses — the daemon makes it visible in status/queue outputs). Single-writer stance per CLAUDE.md: the daemon is the sole writer when running; document interaction with CLI verbs (advisory lockfile already serializes appends; the daemon tolerates external appends by re-reading).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 approval daemon run watches the task folder and log, validating changed envelopes and appending envelope.drift (schema-valid, system actor) when a file contradicts the log
- [x] #2 TTL sweep appends approval.expired for lapsed live requests on a configurable interval, idempotent with lazy expiry
- [x] #3 QUEUE.md regenerates on every relevant event via the real renderer; regeneration is debounced and never partial
- [x] #4 Escalated tasks are surfaced in the daemon's own output and status; a clean shutdown leaves no lockfile or torn state
- [x] #5 Daemon appends all go through the real gate/log paths; log verify stays clean across every daemon test; tests drive a real daemon process against temp dirs
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, isolated worktree from main (post-APRV-38). 2. Read channels/telegram listen loop (foreground-verb pattern), gate/log append paths, QUEUE renderer, lockfile serialization, envelope frontmatter validation. 3. approval daemon run: fs.watch on backlog folder + log file with debounce; envelope validation on change appending envelope.drift via real append path (system actor); configurable TTL sweep interval appending approval.expired idempotently against lazy expiry; QUEUE.md regeneration debounced via the real renderer; escalation surfacing in daemon output and status. 4. Single-writer stance documented; CLI appends still serialize via lockfile; daemon re-reads on external append. 5. Tests drive a real daemon process against temp dirs through the real append paths; verify clean throughout; clean shutdown leaves no lockfile or torn state. 6. PR, ci green, merge.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built by an Opus subagent, isolated worktree, delivered as PR #5, merged with ci green on both matrix jobs (1040 tests). approval daemon run: fs.watch on task folder and log dir as latency optimization only — every tick re-scans and re-derives from the verified log, so failed watchers degrade latency, never correctness; debounced ticks, synchronous end to end. The daemon decides nothing of its own: state from core/state requestState (rolled up per task in daemon/projection.ts), expiry through gate expire (system:gate), queue through the real renderer, escalation from core/loop surfaced only. Every append passes expectedHead (invariant 5); head-moved refusals drop and re-derive next tick; corrupt/torn/unreadable log stops the daemon (existing exit codes, no union changes; DAEMON_WARNING_CODES is a new separate closed union). Composition note: the daemon inherited APRV-43 head caching for free by calling readVerifiedRecords like every other consumer. DESIGN DECISIONS FLAGGED: (1) task-level state rollup precedence awaiting > approved > executed > revoked > rejected > expired > proposed (6.3 is per-action; single-action tasks collapse exactly); (2) drift dedupe key (declared, derived, envelope sha256) against latest drift event, so drift-repair-drift records twice on purpose; (3) schema-invalid envelopes warn without appending (a malformed file contradicts nothing; appending would put an unauthored declared_state in the log) — divergence from a literal reading of AC 1, flagged; (4) system:daemon actor on drift vs system:gate on expiries so readers can tell which runtime part spoke; (5) no daemon lockfile or pidfile, --once for cron-shaped use and tests. SPEC 10.2: new paragraph with one normative MUST (sweep idempotent with lazy expiry, obtained by re-deriving, never remembering); fable amended the write-back sentence on review so 10.2 states the 6.3 projection write-back deferral to the Backlog.md milestone explicitly instead of contradicting 6.3 — SPEC DIVERGENCE CALL-OUT for the human: v0.1 daemon records drift and never updates task files; write-back lands with M6 round-trip machinery. Incidental catch: the engines-floor guard test failed in the primary checkout during gating because its node_modules still held better-sqlite3 13.0.2 from before APRV-48; npm ci fixed it — the guard caught a real stale install on its first week.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
approval daemon run ships the 10.2 loop: watch as latency hint, verified-log re-derivation as truth, drift via compare-and-append, TTL sweep via gate expire (idempotent, now a SPEC MUST), debounced whole-file queue regeneration, escalation surfacing, clean shutdown. 28 new tests against a real spawned daemon; merged as PR #5 with both matrix jobs green.
<!-- SECTION:FINAL_SUMMARY:END -->
