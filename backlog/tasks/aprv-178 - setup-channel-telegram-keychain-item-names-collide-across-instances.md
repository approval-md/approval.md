---
id: APRV-178
title: 'setup channel telegram: keychain item names collide across instances'
status: To Do
assignee: []
created_date: '2026-08-31 02:05'
updated_date: '2026-08-31 02:23'
labels:
  - core
  - setup
dependencies: []
ordinal: 157000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found live 2026-08-31: the demo instance at ~/demo-gate was provisioned with setup channel telegram while the primary repo gate already existed; the setup verb stores/reads the bot token under the FIXED keychain service name approval-tg-token, so the demo instance's .approval/env pointed at the PRODUCTION bot's token. Consequences observed: demo prompts delivered through the production bot; two listeners long-polling one bot token fought over getUpdates; a human tap was consumed by the wrong listener and refused as unauthorized. Instances are directory-scoped everywhere else (policy, log, vault, env); keychain item names must be too. Fix direction: derive the service name from the instance (e.g. approval-tg-token-<8 hex of log path hash>) or make it a setup prompt with a per-instance default; on finding an EXISTING item under a candidate name, setup must ask whether it belongs to THIS instance rather than silently reusing it; doctor's telegram row should flag two instances resolving the same item. Migration note: existing single-instance users keep working (first instance may adopt the legacy name).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Two instances provisioned on one machine store and resolve distinct keychain items with no manual renaming
- [ ] #2 setup channel telegram never silently reuses an existing keychain item for a new instance; the reuse question names the item and the instance
- [ ] #3 approval doctor flags cross-instance sharing of a telegram token item
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Second half of the footgun, found minutes later on the same machine: the operator's shell rc exports the production APPROVAL_TG_TOKEN/CHAT globally (that is how the primary daemon is fed), and approval env defers to already-exported values over the instance's .approval/env ('already exported; the file was not consulted'). So every fresh terminal silently inherits the production channel and the demo instance kept sending through the production bot even after its env file was corrected. Operator remedy: unset APPROVAL_TG_TOKEN APPROVAL_TG_CHAT APPROVAL_HUMAN before eval. Fix direction to weigh alongside the keychain scoping: when the resolved value's SOURCE is the ambient environment but the instance's env file names a different source, approval env --check should warn loudly (cross-instance bleed), and approval up should refuse or warn when its channel token provably resolves from outside the instance.
<!-- SECTION:NOTES:END -->
