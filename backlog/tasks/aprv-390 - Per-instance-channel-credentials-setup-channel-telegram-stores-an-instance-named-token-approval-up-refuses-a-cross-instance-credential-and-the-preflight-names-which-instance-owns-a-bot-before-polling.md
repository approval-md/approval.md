---
id: APRV-390
title: >-
  Per-instance channel credentials: setup channel telegram stores an
  instance-named token, approval up refuses a cross-instance credential, and the
  preflight names which instance owns a bot before polling
status: To Do
assignee: []
created_date: '2026-09-19 22:40'
labels:
  - daemon
  - telegram
  - setup
  - bug
dependencies: []
priority: high
ordinal: 301000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed 2026-09-19 22:1xZ (and Carter says before): the primary daemon and the demo instance daemon (~/demo-gate) both long-polled one Telegram bot and both printed getUpdates HTTP 409 Conflict on every poll, so neither phone channel worked. Two causes. (1) The demo shell still carried the primary exported APPROVAL_TG_TOKEN, and approval up only WARNED ("cross-instance: APPROVAL_TG_TOKEN was exported before this process started and is not this instance own approval env export; line 2 of the env file was not consulted") and started anyway on the wrong bot. (2) Even with the demo own env file consulted, setup channel telegram had stored the same bot token under the same default keychain item (approval-tg-token) and the same default variable name (APPROVAL_TG_TOKEN, which the policy names via channels.telegram.token_env), so two instances on one machine default to one bot. The vault passphrase already got a per-instance suffix on 2026-09-19 (keychain:approval-vault-passphrase-c7129ab2); the channel token needs the same. Deliver: (a) setup channel telegram stores the token as keychain:approval-tg-token-<instance id> (the keystore instance id doctor prints as keychain-scope) and writes an instance-specific variable name into the env file, updating the policy token_env line through the proposal path or, when the policy is the packaged demo policy, in place before attestation; raw existing setups keep working. (b) approval up REFUSES to start when any channel credential is cross-instance (exported before the process started and not this instance own export), with a machine-readable code and the fix line (unset it, or run from a fresh shell); a --allow-cross-instance flag exists for the deliberate case and prints what it is doing. (c) approval up preflight calls getMe once, records bot id and username against the instance in .approval/channel-owner.json (gitignored), and refuses when the bot is already recorded as another instance own on this machine (a small local registry under ~/.approval or the keychain, naming instance path and bot id), so the 409 becomes a named refusal before any polling; the telegram health row prints the bot username and which instance owns it. (d) A 409 that still happens at runtime is reported once with the sentence "another process is polling this bot" and the two likely instances, not a retry loop of identical lines. Related: APRV-324 (sender identity), APRV-383 (hosted daemon identity, the same registry could carry the daemon id), the demo runbook step 4 warning, APRV-386.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 setup channel telegram stores the token under an instance-named keychain item and an instance-specific variable, the policy token_env is updated accordingly, and a second instance on the same machine can be set up against a second bot without either name colliding; tests through the real setup verb with a stubbed keystore
- [ ] #2 approval up refuses a cross-instance channel credential with a machine-readable code and the fix line; --allow-cross-instance overrides and says so; test for both
- [ ] #3 approval up preflight records the bot id per instance and refuses a bot another local instance owns, naming it; telegram health prints bot username and owner; the runtime 409 is reported once with the two likely instances; tests with a stubbed Bot API
- [ ] #4 docs: dogfood-cutover.md, cli-reference.md (setup channel telegram, up), the demo runbook step 4 and provisioning.md say one bot per instance and how the names are derived; build, typecheck, lint and the setup, up, telegram and demo-provision suites pass
<!-- AC:END -->
