---
id: APRV-205
title: >-
  approval run starves the granted child of credential-bearing environment
  variables
status: To Do
assignee: []
created_date: '2026-09-02 03:47'
labels:
  - security
  - dogfood
dependencies: []
priority: high
ordinal: 169000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found by the APRV-193 design lane: commandRun in src/cli/execute.ts (spawnSync at line 452) passes no env option, so a granted child inherits the whole session environment, including the Telegram bot token and the value of the vault passphrase variable. APRV-194 cannot see this: the classifier reads 'npm test', and the credential read happens inside whatever the child runs. This is the minimal, pre-launch slice of APRV-193's 193d (spawn starved): scrub, do not sandbox. Outcome: a child spawned by approval run receives an environment with every variable under the credential-bearing prefixes (APPROVAL_*, TELEGRAM_*, VAULT_*, minus the APRV-194 allowlist of non-secret runtime names) removed, plus any variable the policy's vault.passphrase_env names, unless the adapter for the granted action declared it in requiredCredentials (APRV-169), in which case exactly those are passed. The removal is recorded on execution.started as a count of stripped names (never values, never names beyond the count, per the raw-secrets invariant). Why: the gate holding the token while handing it to every child it launches is custody theatre; the fix is small and the full sandbox (APRV-193) can land later.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A child spawned by approval run cannot read APPROVAL_TG_TOKEN, any TELEGRAM_* or VAULT_* variable, or the vault passphrase variable from its environment, proven by a test whose child prints its environment
- [ ] #2 Variables an adapter declares in requiredCredentials for the granted action ARE passed, and nothing else under those prefixes is; the APRV-194 allowlist names (APPROVAL_HUMAN, _AGENT, _ASCII, _MD, _HOME, _DIR) survive
- [ ] #3 execution.started carries the count of stripped variables and never a name or a value; the log grep test for raw secrets is extended to this path
- [ ] #4 The same scrub applies to the daemon and the hook wherever they spawn a granted command, with a shared helper so there is one list
- [ ] #5 docs/cli-reference.md run section states what the child does and does not receive
- [ ] #6 npm test passes; lint clean
<!-- AC:END -->
