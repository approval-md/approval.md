---
id: APRV-157
title: 'Web-agent demo: runbook'
status: Done
assignee:
  - '@claude'
created_date: '2026-08-30 20:43'
updated_date: '2026-08-31 00:02'
labels: []
dependencies:
  - APRV-154
  - APRV-155
  - APRV-156
ordinal: 141000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A stage demo fails on operations, not code. examples/web-agent-demo/runbook.md covers the full demo-day flow on a laptop with a cloudflared quick tunnel exposing only the demo server port. Opening beat: the tunnel launch itself is gated against the repo's LIVE dogfood log (classify first with approval hook classify, then register/request/approve from phone/approval run -- cloudflared ...), so the grant becomes a permanent record in the real chain. Rehearsal script: benign task, gated exec, recursive policy.edit rejection (note: 'the agent does not hold the pen on its own policy'), email finale to a volunteer's address. Failure playbook per dogfood rules (daemon down, Telegram dark, tunnel dies, verify red: stop and escalate). Reset procedure: fresh init into a new scratch dir; never delete a log mid-session. TBDs left for demo day: SMTP account, recipient, agent model/turn cap.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Runbook scripts the gated-tunnel opening beat against the live repo log, including the approval hook classify check and the exact register/request/wait/run commands
- [x] #2 Full rehearsal script covers: benign task, gated exec approval, recursive policy.edit rejection beat, and the live email finale
- [x] #3 Failure playbook covers daemon down, Telegram dark, tunnel death, and a red log-verify badge, each resolving to the dogfood stop-and-escalate rule
- [x] #4 Reset procedure documents fresh-init-into-new-dir and forbids deleting or truncating any log mid-session
- [x] #5 Runbook carries an explicit warning to never expose port 4680 (loopback web channel) through any tunnel
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read provisioning.md, server.mjs header + templates, mcp/email demo docs, dogfood-cutover, and the session evidence (gated tunnel classification, sealed policy now live on the repo).
2. Write examples/web-agent-demo/runbook.md: laptop + cloudflared quick tunnel; gated-tunnel opening beat against the live repo log (hook classify first); rehearsal script over the four templates; failure playbook; reset; port-4680 warning.
3. Verify the tunnel command's classification with approval hook classify and record it.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built by an Opus subagent, reviewed by fable. examples/web-agent-demo/runbook.md, 385 lines. The opening beat was reality-checked, and reality won: approval hook classify -- 'cloudflared tunnel --url http://localhost:4700' answers unclassified (real output quoted in the doc), and the hook has no ask, so the runbook routes the tunnel through the explicit register/request/wait/run flow per dogfood-cutover.md with class network.call declared by the human's envelope. Verb corrections found against --help: reject/grant take an action key, not a task id; Telegram's Reject tap records no free text, so the recursive beat's scripted note must go through approval reject --note at the CLI. Significant find promoted to its own task: APRV-168 — the email finale's adapter call should refuse credential-unavailable under the runner's env scrub AND burns the token first (contract consumes before the credential window); the runbook carries a mandatory pre-show rehearsal plus a by-hand stage recovery until APRV-168 decides the design. Also noted: dogfood-cutover.md still describes manual token handoff and predates sealed delivery (stale, small).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
examples/web-agent-demo/runbook.md: preflight checks, the gated-tunnel opening beat with the classifier's real (unclassified) verdict and the honest explicit-flow fallback, the four-beat rehearsal script with expected log events, a failure playbook grounded in project lore, reset rules, hard warnings, and demo-day TBDs. One design gap it surfaced is tracked as APRV-168.
<!-- SECTION:FINAL_SUMMARY:END -->
