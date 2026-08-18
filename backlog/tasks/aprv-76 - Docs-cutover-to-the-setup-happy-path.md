---
id: APRV-76
title: Docs cutover to the setup happy path
status: To Do
assignee: []
created_date: '2026-08-18 01:39'
labels: []
milestone: m-10
dependencies:
  - APRV-74
  - APRV-75
priority: medium
type: docs
ordinal: 75000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The runbooks are what a human follows and they currently teach curl getUpdates and hand-rolled exports. Move them to approval setup + eval "$(approval env)", keeping Keychain as the documented harder option (labelled as what setup does for you) rather than deleting it. LAST in the sequence; APRV-70 AC 2 (the human real-network email demo run) executes after this lands so the human runs the smoother runbook.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 examples/telegram-demo.md chat-id section uses approval setup telegram with curl kept as fallback; examples/email-demo.md prerequisites use setup identity/vault/telegram plus eval approval env with the raw security block kept and labelled; docs/dogfood-cutover.md daemon section uses one eval
- [ ] #2 README ceremony sections and verb mentions updated; tests/docs-guard.test.ts green
- [ ] #3 tests/e2e-email-demo.test.ts gains a setup-path variant so the rewritten runbook has a mechanical check
<!-- AC:END -->
