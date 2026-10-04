---
id: APRV-448
title: >-
  approval serve and the webhook listener stamp the daemon id, or the doc stops
  claiming they do
status: To Do
assignee: []
created_date: '2026-10-03 03:49'
labels:
  - serve
  - daemon
  - identity
  - hosting
dependencies: []
references:
  - private/agentvillage-integration/06-gap-register.md
priority: medium
ordinal: 336000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
APRV-383 added the daemon field to records and the daemons allowlist to the policy, but only the Daemon constructor calls markDaemonProcess (src/daemon/daemon.ts), so records appended by approval serve (hook route, propose, start, withdraw) and by approval channel telegram webhook carry no daemon field and are not governed by the allowlist. src/cli/serve.ts says the id is the one every record written under this process will carry, which is false. In the Agent Village co-located deployment the facade, the daemon and the channel run in one approvald loop per tenant and most records are facade-written, so a tenant reading their own log sees daemon on the sweeps and nothing on the actions. Decide: either stamp the same instance id in serve and the webhook process (same source rules as APRV-383: APPROVAL_DAEMON_ID or the derived id; refusal on a bad declared id; allowlist enforced at the write boundary), or correct the doc and the serve startup line. Recommendation: stamp, because the field is provenance and the allowlist is the only thing that catches a facade started against the wrong store. Context: private/agentvillage-integration/06-gap-register.md G10.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Records appended through approval serve verbs and the hook route carry the daemon field with the same id approval status reports for that store, and a daemons list that excludes it refuses the append with daemon-not-allowed, both under test
- [ ] #2 The Telegram webhook listener behaves the same way, under test with the fake Bot API
- [ ] #3 src/cli/serve.ts, docs/cli-reference.md and design/hosted-daemon-identity.md section 6 say exactly which processes stamp the field
- [ ] #4 If the decision is not to stamp, the doc and the serve startup line are corrected instead and the implementation notes say why
<!-- AC:END -->
