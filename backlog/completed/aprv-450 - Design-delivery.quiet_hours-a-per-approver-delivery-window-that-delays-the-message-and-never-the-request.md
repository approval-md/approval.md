---
id: APRV-450
title: >-
  Design: delivery.quiet_hours, a per-approver delivery window that delays the
  message and never the request
status: Done
assignee:
  - '@opus-lane-c11'
created_date: '2026-10-03 03:49'
updated_date: '2026-10-03 21:59'
labels:
  - design
  - channels
  - policy
dependencies: []
references:
  - private/agentvillage-integration/06-gap-register.md
priority: low
ordinal: 338000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Agent Village DATA-224 (2026-09-29): inferred intents can be raised by a nightly memory pass around 01:00 and the approval request should be recorded at once with the message to the resident held until their quiet period ends. Core has no quiet hours or delayed delivery key (schema has channels.telegram.delivery paced|burst and prompt layout only), and the TTL clock starts at approval.requested, so a delay anywhere costs window. For the village the hold is implemented at the control-plane relay against a 72 h TTL. This task designs the core key for after 2026-11-01: a delivery setting under approvers.<id> or channels.<ch> (start, end, timezone), a bypass flag per class, a rule for a request that would expire inside the window, delivery oldest first at the window's end, and the invariant that the setting changes when a person is told and never what is allowed or who may approve (never an input to a verdict). Design note under design/, SPEC hunk proposed, no code. Context: private/agentvillage-integration/06-gap-register.md G12.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 design/quiet-hours.md states the key shape, the TTL interaction, the bypass rule, the expiry-inside-window rule and the attestation requirement, with the alternatives rejected
- [x] #2 A SPEC section 5 and section 10.3 hunk is proposed in the note as pending sign-off, not applied
- [x] #3 The note states which channel implementations must honour the window and how a channel that cannot (cli) reports it
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read SPEC 5.2 (approval_ttl, approvers, senders), 6.3, 8, 10.2, 10.3 (dispatch placement, pacing, stale collapse, what each channel authenticates), 11.1; read core/state.ts requestState, core/harness-wait.ts, core/gate.ts appendExpiry, schema/policy.schema.json approvers and channels.telegram.delivery.
2. Settle: key placement (approvers.<id>.delivery.quiet_hours), TTL keeps running, window-end delivery order, expiry-inside-window rule, per-class bypass, multi-approver audience rule, time zone and DST, validation and fail direction, what is logged.
3. Write design/quiet-hours.md in the house format with alternatives, recommendation, proposed SPEC 5.2, 8 and 10.3 hunks and schema hunks marked proposed-not-applied, conformance vectors, open questions.
4. No code, no SPEC or schema edits.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Wrote design/quiet-hours.md. Decisions: key is approvers.<id>.delivery.quiet_hours {start, end, timezone} (person-level, delivery block kept apart from channels/senders on the daemon/daemons reasoning); TTL keeps running from approval.requested (pausing rejected: uncheckable expiry arithmetic, two windows per request, longer token shelf life, edits moving live deadlines); the hold wins for a request that would lapse inside the window and only the class-rule bypass deliver_in_quiet_hours (manual and supervised-live only, winning rule governs, never from a request field) breaks a window; window-end delivery follows the configured pacing oldest-first by seq; audience rule: a channel holds while every eligible approver on it is inside their window. Logging: no per-hold record (derivable from request ts plus pinned attested bytes); one computed approval.expired payload.quiet_hours: true. Fail direction: schema errors fail the load as usual; an unresolvable IANA zone loads with no window and fails a doctor row, so loadability never depends on the host tz database. Channels: telegram MUST honour in poll and webhook modes (a relay behind --api-base then sees nothing to hold); web and cli are pull surfaces, cli reports quiet hours as not applicable. Invariants touched: 4 (no request field moves a window) and 10's spirit (the key never reaches a verdict); neither weakened. Proposed, not applied: SPEC 5.2 bullet, 10.3 paragraph, 8 sentence, policy and event schema hunks. No code, SPEC, schema or conformance edits.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Design note design/quiet-hours.md: a per-approver delivery window that holds the message and never the request, with the TTL interaction, bypass, expiry-inside-window rule, attestation, channel obligations (cli reports not applicable), logging and fail direction, alternatives rejected, proposed SPEC 5.2/8/10.3 and schema hunks marked pending sign-off, conformance vectors and open questions. Verified by section review against AC 1-3 (sections 3-10 of the note); docs only, no tests run.
<!-- SECTION:FINAL_SUMMARY:END -->
