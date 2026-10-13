---
id: APRV-76
title: Docs cutover to the setup happy path
status: Done
assignee:
  - '@fable'
created_date: '2026-08-18 01:39'
updated_date: '2026-08-18 03:32'
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
- [x] #1 examples/telegram-demo.md chat-id section uses approval setup telegram with curl kept as fallback; examples/email-demo.md prerequisites use setup identity/vault/telegram plus eval approval env with the raw security block kept and labelled; docs/dogfood-cutover.md daemon section uses one eval
- [x] #2 README ceremony sections and verb mentions updated; tests/docs-guard.test.ts green
- [x] #3 tests/e2e-email-demo.test.ts gains a setup-path variant so the rewritten runbook has a mechanical check
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, worktree from main (all of 72-75). 2. examples/telegram-demo.md chat-id section -> setup telegram (curl fallback kept); examples/email-demo.md prerequisites -> setup identity/vault/telegram + eval approval env (raw security block kept, labelled); docs/dogfood-cutover.md daemon section -> one eval; README ceremony sections + verb mentions. 3. tests/e2e-email-demo.test.ts setup-path variant (non-TTY-safe: drive setup via its injected seams in-process, or use the non-interactive alternatives it prints). 4. docs-guard green. PR.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Opus subagent build, PR #43. Runbooks moved to setup + eval approval env with Keychain kept and labelled; SMTP password drawn explicitly as an ADAPTER credential (vault), distinct from .approval/env; vault.passphrase_env: the demo keeps APPROVAL_DEMO_VAULT_PASSPHRASE because setup vault writes the line the policy NAMES (verified in code), so the doc is truthful; e2e setup-path variant driven in-process via injected seams (fake keystore kind none so no spawned child touches the real Keychain), approval env --json as the seam, identical log shape asserted vs the manual walk; one flat test not ordered subtests (a Node 24 quirk with awaited subtests after other awaits, documented). Verb syntax from the built --help. README stale seven-checks -> eleven. TWO DEFECTS SURFACED AND FIXED IN THE SAME PR (fable): setup non-interactive hints hardcoded default variable names while the interactive path honoured the policy (hints now take resolved names from the loaded policy); doctor FAILED a plaintext secret that setup itself writes on a no-keystore machine behind a typed yes (SPEC 5.2 permits and says always-reported; doctor now reports it as a prominent skip naming the upgrade; two verbs no longer disagree about one line). HUMAN NEXT-ROUND INPUT: setup has no story for adapter credentials (SMTP password still by hand via vault set --value-env); nothing in the verbs output says configuration must follow init and the policy edit (.approval/env is per-directory, setup reads names from the policy). 1475 tests.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Docs cut over to approval setup + approval env with Keychain kept as the labelled harder path; e2e setup-path variant proves the rewritten runbook; two verb defects the cutover surfaced fixed alongside. PR #43.
<!-- SECTION:FINAL_SUMMARY:END -->
