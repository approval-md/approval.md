---
id: APRV-207
title: >-
  gloss spawns claude -p with the full inherited environment; starve it like a
  granted child
status: To Do
assignee: []
created_date: '2026-09-02 05:58'
labels:
  - security
dependencies: []
priority: medium
ordinal: 171000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found by the APRV-205 lane: src/cli/gloss.ts spawns the gloss model subprocess (claude -p) with process.env unchanged, so the Telegram token and the vault passphrase variable reach a third-party CLI that talks to the network on every prompt render. Same family of hole as APRV-205, out of that task's scope. Outcome: the gloss child (and the tests/fake-claude.ts stub path) is spawned with the environment src/core/child-env.ts builds, with no declared credentials, so nothing under APPROVAL_*/TELEGRAM_*/VAULT_* or the passphrase variable is present; the model's own auth (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN and kin) passes through because it is not under the gate's credential families. Why: the gloss is a convenience; it must not be the process that holds the gate's secrets.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The gloss subprocess cannot read APPROVAL_TG_TOKEN, any TELEGRAM_*/VAULT_* variable, or the vault passphrase variable, proven by a test using the fake claude stub that prints its environment
- [ ] #2 The model's own auth variables and PATH/HOME/locale still reach the subprocess
- [ ] #3 One helper (child-env) is used; no second list
- [ ] #4 npm test passes; lint clean
<!-- AC:END -->
