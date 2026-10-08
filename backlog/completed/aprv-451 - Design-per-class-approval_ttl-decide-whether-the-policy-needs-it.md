---
id: APRV-451
title: 'Design: per-class approval_ttl, decide whether the policy needs it'
status: Done
assignee:
  - '@opus-lane-c11'
created_date: '2026-10-03 03:49'
updated_date: '2026-10-03 22:03'
labels:
  - design
  - policy
  - ttl
dependencies: []
references:
  - private/agentvillage-integration/06-gap-register.md
priority: low
ordinal: 339000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
approval_ttl exists only under defaults; classRule has no TTL key. Agent Village sets 72h globally for the inferred-intent class while hook-opened requests clamp to the harness cap minus 60 s regardless (APRV-423), so the village needs nothing more. The question for after 2026-11-01 is whether two proposable classes may ever need different windows (a 72 h intent against a 10 minute money.spend) and, if so, how a per-class key interacts with the cap clamp, with policy-drift voiding, and with the daemon's expiry sweep. Deliverable is a decision recorded in a design note and, if yes, a SPEC hunk proposed; no code in this task. Context: private/agentvillage-integration/06-gap-register.md G4, DATA-212 ruling R19.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 design/per-class-ttl.md records the decision with the use cases considered and the interaction with harness_cap_ms and policy-drift
- [x] #2 If the decision is yes, the schema key name, precedence over defaults.approval_ttl and the SPEC section 5.2 hunk are written as pending sign-off; if no, the note says what a policy author does instead
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read SPEC 5.2 (approval_ttl paragraph, resolution, attestation and policy-drift), 6.3, 10.1 (retry grace), 10.2; read core/policy-load.ts TTL parse, core/state.ts requestState, core/harness-wait.ts, core/gate.ts ttlOf and appendExpiry, core/token.ts shelf life, daemon sweep, schema classRule.
2. Enumerate the cases that seem to want a per-class TTL and check each against the global TTL, the harness clamp, requester withdrawal and quiet hours.
3. Weigh costs: cap composition, policy-drift and live-read deadlines, sweep and lazy-expiry agreement, record readability, closed-schema permanence, question clock vs answer clock.
4. Write design/per-class-ttl.md with the decision, the author workaround, the reopen trigger and the sketched shape of a yes, plus any pre-existing gaps found. No code, SPEC or schema edits.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Wrote design/per-class-ttl.md. Decision: NO per-class approval_ttl for now. Cases checked: long-standing agent questions beside live actions (covered by the global TTL plus the APRV-423 harness clamp), hook-gated consequential classes (covered, more tightly than a class key could), questions with a natural close (wants a per-request deadline, not a class key), quiet hours from APRV-450 (covered by its bypass and a TTL sized to the window), and grant freshness on the token path (the one real gap, unobserved). Costs weighed: cap composition is free; a class key makes deadlines a function of class resolution under a file read live, so an unrelated new winning rule would re-time pending requests and live tokens; sweep and lazy expiry would agree only by agreeing on resolution; the expiry record would need the matched pattern; closed-schema vocabulary is permanent; and a class approval_ttl conflates the question clock with the answer clock. Author workaround and reopen trigger written, with the sketched shape of a yes (not proposed): manual and supervised-live only, winning rule governs, default fallback, cap clamp, effective TTL pinned on the request and judged by min(pinned, current). Pre-existing gaps found and recorded in section 7, not fixed or filed: (1) expiry, withdrawal and manual token spend read the TTL from the file on disk, not the attested bytes (gate.ts:924, daemon.ts:2286, token.ts:637; execute.ts:712 does not re-check attestation), so an unattested TTL edit already takes effect on those paths; (2) a policy that fails to load leaves already-granted tokens with no time bound. Invariants: none touched by a no; 7.1 sits beside SPEC 5.2's 'inoperative until re-attested'. No code, SPEC, schema or conformance edits.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Design note design/per-class-ttl.md records the decision (no per-class approval_ttl for now), the cases considered, the interaction with harness_cap_ms, policy-drift and the expiry sweep, what a policy author does instead, the trigger and shape for reopening, and two pre-existing TTL-reader gaps for a follow-up. Verified by section review against AC 1-2; docs only, no tests run.
<!-- SECTION:FINAL_SUMMARY:END -->
