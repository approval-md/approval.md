---
id: APRV-156
title: 'Web-agent demo: demo instance provisioning'
status: Done
assignee:
  - '@claude'
created_date: '2026-08-30 20:42'
updated_date: '2026-08-30 21:39'
labels: []
dependencies: []
ordinal: 140000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Demo events must not pollute the repo's live dogfood log. Provide a provisioning script or runbook section that stands up a dedicated gate instance outside the repo (e.g. ~/demo-gate): approval init --dir, a demo APPROVAL.md with defaults {channel: telegram, token_delivery: sealed}, manual autonomy for exec.local / communicate.email.external / policy.edit, a short approval_ttl (~10m) so abandoned requests expire visibly, and a tight daily action budget; then policy attest, setup channel telegram, and setup adapter email with vault-held SMTP creds. The repo's own .approval/log/events.jsonl stays untouched by rehearsals.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A script or documented command sequence provisions the demo instance from scratch: init, demo policy, attest, telegram channel setup, email adapter + vault setup
- [x] #2 Demo APPROVAL.md sets sealed token_delivery, manual exec.local / communicate.email.external / policy.edit, short approval_ttl, and a daily budget cap
- [x] #3 approval doctor reports green against the provisioned instance
- [x] #4 A rehearsal against the demo instance provably leaves the repo's .approval/log/events.jsonl unchanged
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read approval init/setup/doctor CLI surfaces (src/cli/init.ts, setup verbs, docs/cli-reference.md sections) and the canonical policy scaffold to learn exact flags and the APPROVAL.md schema vocabulary.
2. Write examples/web-agent-demo/provision.md (command sequence, copy-pasteable) plus the demo APPROVAL.md policy block inline: defaults {channel telegram, token_delivery sealed}, manual exec.local/communicate.email.external/policy.edit, approval_ttl ~10m, tight daily budget.
3. Dry-run the non-interactive parts against a scratch dir in the session scratchpad (init, policy write, attest if scriptable; telegram/email setup documented as interactive steps).
4. Verify approval doctor output against the scratch instance and document expected green state; note the repo-log-untouched check (git status on .approval/log).
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built by an Opus subagent, reviewed by fable. Deliverable: examples/web-agent-demo/provisioning.md. Every non-interactive step dry-run against a scratch instance on freshly built dist/ before writing; observed outputs are in the doc's verification table. Key discoveries recorded in the doc: (1) approval init does not create its target directory (exit 4 ENOENT) so mkdir -p is mandatory; (2) --dir scopes policy discovery only while the log/env/vault/payload paths resolve against cwd, so the governing rule is cd ~/demo-gate first (doctor --dir from outside misreads the caller's log — observed); (3) est-cost/env/vault split documented; setup verbs refuse non-tty with exit 2 and print their by-hand paths, captured verbatim. Interactive verbs deliberately not driven to completion: they require a terminal by design. Post-dry-run check: git status --porcelain .approval/ in the repo is empty (AC4 evidence).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
examples/web-agent-demo/provisioning.md: six-step verified runbook standing up the dedicated ~/demo-gate instance (init, sealed-token demo policy, attest, interactive credential ceremonies, doctor green at 7 ok/0 failed, repo-log-untouched proof). Non-interactive steps verified against a scratch instance with real outputs recorded; the cd-not---dir rule is the doc's load-bearing discovery.
<!-- SECTION:FINAL_SUMMARY:END -->
