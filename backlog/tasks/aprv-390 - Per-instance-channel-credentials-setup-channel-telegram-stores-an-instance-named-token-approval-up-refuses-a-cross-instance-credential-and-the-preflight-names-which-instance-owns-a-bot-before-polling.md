---
id: APRV-390
title: >-
  Per-instance channel credentials: setup channel telegram stores an
  instance-named token, approval up refuses a cross-instance credential, and the
  preflight names which instance owns a bot before polling
status: Done
assignee:
  - '@claude-opus-lane'
created_date: '2026-09-19 22:40'
updated_date: '2026-09-20 00:37'
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
- [x] #1 setup channel telegram stores the token under an instance-named keychain item and an instance-specific variable, the policy token_env is updated accordingly, and a second instance on the same machine can be set up against a second bot without either name colliding; tests through the real setup verb with a stubbed keystore
- [x] #2 approval up refuses a cross-instance channel credential with a machine-readable code and the fix line; --allow-cross-instance overrides and says so; test for both
- [x] #3 approval up preflight records the bot id per instance and refuses a bot another local instance owns, naming it; telegram health prints bot username and owner; the runtime 409 is reported once with the two likely instances; tests with a stubbed Bot API
- [x] #4 docs: dogfood-cutover.md, cli-reference.md (setup channel telegram, up), the demo runbook step 4 and provisioning.md say one bot per instance and how the names are derived; build, typecheck, lint and the setup, up, telegram and demo-provision suites pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. New core module src/core/channel-owner.ts. Two records, both of them names and ids and never a value: (a) per-instance .approval/channel-owner.json, gitignored, holding the channel, the bot id, the username and when it was probed; (b) a per-machine registry mapping a bot id to the instance that claimed it (instance id plus its home directory).
2. WHERE the per-machine registry lives, decided here rather than taken from the task. NOT the keystore: doctor and the up preflight may never block on an unlock dialog (NON_RESOLVING_RUNNER is the existing rule for exactly this), a machine with no keystore backend still needs the refusal, and the contents are open names rather than a secret. NOT a dot-approval directory under the home directory either, which was the other candidate: this repo hook classifies any path under such a directory as policy.core, human-only, so a file the runtime rewrites on every listener start would sit in the directory the policy reserves to human hands. It goes where setup-service.ts already puts per-user runtime state, by the same platform split as defaultLogsDir: Library/Application Support/approval/bots.json on darwin, .local/state/approval/bots.json on linux, with an APPROVAL_STATE_DIR override so the suite never writes the operators real registry.
3. Refusal codes. Add cross-instance-credential and bot-owned-elsewhere to LISTEN_REFUSAL_CODES in src/cli/channel-telegram.ts so the listen verb and up branch on one closed union (invariant 6: refusals machine-readable and distinct).
4. AC2. prepareListen gains allowCrossInstance and runs instanceFindings; a foreign-instance or ambient-bleed finding becomes cross-instance-credential with the fix line (unset the variable, or start from a fresh shell after evaluating approval env). up and channel telegram listen both grow --allow-cross-instance, which downgrades it to the current warning and says it is overriding. In up.ts the two new codes abort the verb instead of degrading telegram to part_unavailable.
5. AC3. New async preflight in channel-telegram.ts run once before the first poll by both runListener and up: ONE getMe, then a claim. Another instance holding that bot id is bot-owned-elsewhere, naming the other instance home and the bot username, before any getUpdates. On success the identity is written to the per-instance file and the registry. setup channel telegram reuses its EXISTING getMe for the same claim, so no second network call is added anywhere.
6. AC3 continued, the 409. TelegramChannel.listen dedupes repeated poll-error complaints and gives a 409 its own one-time sentence, built by the CLI from the registry so the channel keeps no filesystem knowledge: another process is polling this bot, naming this instance and the recorded owner. Repeats are counted, not reprinted.
7. AC3 continued, health. approval channel telegram health (offline, no network) and doctors telegram row both print the recorded bot username and which instance owns it, read from the two files.
8. AC1 plus Carters addendum of 2026-09-19. The keystore item is already scoped (APRV-178) and setup already reads token_env and chat_id_env from the live policy; both get a pinning test. The VARIABLE names are the policys declaration, so the packaged demo policy under examples/policies moves to APPROVAL_DEMO_TG_TOKEN and APPROVAL_DEMO_TG_CHAT beside the APPROVAL_DEMO_VAULT_PASSPHRASE it already names; the primary keeps APPROVAL_TG_TOKEN. No policy-rewriting verb is built. setup channel telegram prints the names it is writing and, when they are the defaults and the registry already knows another instance, suggests instance-specific ones. Test: two instances, two policies, two stubbed bots, no collision on either the item or the variable.
9. examples/demo-provision.mjs reads the declared names out of the instance policy instead of hardcoding the defaults, and its adopt path (an APPROVAL.md kept because it differs from the packaged file) reports a policy still on the default names with the rename line rather than accepting it silently.
10. The ignore file gains the per-instance channel-owner.json.
11. AC4 docs: docs/dogfood-cutover.md, docs/cli-reference.md (setup channel telegram and up), examples/web-agent-demo/runbook.md step 4, examples/web-agent-demo/provisioning.md section 4. One bot per instance, how the item name and the variable name are each derived, and the two refusals with their codes.
12. build, typecheck, lint, then the setup, up, telegram, instance, doctor and demo-provision suites, then the full suite.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
IMPLEMENTATION, 2026-09-19 (lane/instance-bots-390, PR 499, commit f30a67c).

WHAT WAS BUILT. New core module src/core/channel-owner.ts records what one getMe said (bot id, username, Bot API base) per instance in a gitignored .approval/channel-owner.json and in a per-machine registry, and refuses a second instance claiming a bot another local instance holds. The refusal is made BEFORE any getUpdates by approval up, channel telegram listen and setup channel telegram; setup reuses the getMe it already made, so no network call is added anywhere in the runtime. Two new refusal codes on the listen union: cross-instance-credential and bot-owned-elsewhere. --allow-cross-instance overrides both and prints what it is overriding on every run.

DECISION 1, where the per-machine registry lives. The task offered a dot-approval directory under the home directory or the keychain. Both were rejected and the reasons are in the module header. NOT the keychain: doctor and the start-up preflight may never block on an unlock dialog (the NON_RESOLVING_RUNNER rule), a machine with no keystore backend still needs the refusal, and the contents are open names rather than a secret. NOT a dot-approval directory under the home directory: this project reserves anything under that name to the human ceremony, and approval hook classify confirms it, answering policy.core (human-only) for any such path. A file the runtime rewrites on every listener start cannot sit in the directory the policy holds shut. It goes where setup-service.ts already puts per-user runtime state, by the same platform split as defaultLogsDir. APPROVAL_STATE_DIR relocates it.

DECISION 2, a bot is identified by id AND API base. A bot id is unique within one Bot API deployment and nothing more, so two gates pointed at different bases hold two different bots and neither refuses the other. This also made the test suite honest: every suite talks to its own loopback mock, so cross-suite claims stop colliding without any suite having to know about the registry.

DECISION 3, the cross-instance check compares VALUES, not only names. Two facts arrived from Carter mid-task, both observed on the demo instance. (a) approval env never overrides a variable already exported, so a token re-stored in the keystore never reaches that terminal; the daemon answered 401 while the same item read by hand passed getMe. Every name agreed and only the value was wrong, which no name-only rule can see. (b) APPROVAL_HUMAN was reported cross-instance when the export came from the instance own eval seconds earlier. Both are answered by comparing: a value equal to the file resolution is correct however it got there, and a value that differs is wrong however honest its provenance looks. The new function is core/instance.ts valueFindings, called only from prepareListen, which is the one caller about to USE the value. doctor keeps the name-only rule.

INVARIANTS TOUCHED. Invariant 6 gains two distinct machine-readable refusal codes. Invariant 7 is NOT weakened: valueFindings resolves the file to compare and refuse, never to export. The shell still wins, no verb loads the file into its environment, and the file can only ever make the runtime stricter, which is the fail-closed direction. No value is printed on any path in the new code. The registry holds ids, usernames, an API base and directory paths, all of which .approval/env already carries in the open; it is never read by an enforcement path and can only produce a refusal. No policy schema change was needed: token_env and chat_id_env were already read from the live policy. No SPEC change.

CARTER ADDENDUM, the variable names. examples/policies/demo-gate.APPROVAL.md now declares APPROVAL_DEMO_TG_TOKEN and APPROVAL_DEMO_TG_CHAT beside the APPROVAL_DEMO_VAULT_PASSPHRASE it already had; the primary keeps APPROVAL_TG_TOKEN. setup channel telegram already wrote whatever the policy declared and a test now pins it. examples/demo-provision.mjs reads the declared names out of the instance policy instead of assuming the defaults, and its adopt path reports a policy still on the defaults with the rename line rather than accepting it silently.

EXISTING SETUPS. Nothing is migrated. A hand-chosen keystore item name (Carter demo instance uses approval-tg-token-demo) still resolves and produces no finding; the existing test at tests/instance.test.ts already pins that such a suffix is unknown rather than foreign. The first listener start writes the ownership record from its own getMe.

ONE THING THE ORCHESTRATOR SHOULD KNOW. The first test run of this change, before the suite had any isolation, wrote a mock-bot row into the real machine registry under the user Application Support directory. That file was this session own artifact (one row, a temp-dir instance, the mock bot id); it has been removed and the directory is gone. scripts/run-tests.mjs now points every run at a fresh temporary state directory, and the suites that deliberately want two instances to see each other claims set their own.

VERIFICATION. build, typecheck and lint clean. Full suite 4846 tests, 4823 pass, 22 fail, exit 1. All 22 are the pre-existing local SMTP and TLS failures on Node v26 (TLS ServerName on an IP address). Verified rather than assumed: origin/main checked out in this same worktree produces the same 22 failures, name for name. CI on Node 22 is the truth and is running on the PR head.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
One bot per instance, enforced rather than warned. src/core/channel-owner.ts records what one getMe said (bot id, username, API base) per instance and in a per-machine registry; approval up, channel telegram listen and setup channel telegram refuse a bot another local instance holds, by name, before any getUpdates. The cross-instance credential check became a refusal with the unset line and now compares VALUES against the file resolution, which catches a stale export (approval env never overrides an already-exported variable, so a re-stored token answers 401) and removes the false positive on the documented eval ritual. A runtime 409 is reported once with the two likely instances and its repeats counted. The packaged demo policy declares APPROVAL_DEMO_TG_TOKEN and APPROVAL_DEMO_TG_CHAT; demo-provision.mjs reads the declared names from the instance policy and flags a policy still on the defaults. Verified by new tests through the real setup verb with a stubbed keystore (two instances, two bots, no collision; the refusal naming the owner), through real spawned approval up processes against a stubbed Bot API (ownership recorded, refusal before start, --allow-cross-instance override, health printing the owner offline), and through the channel loop for the 409. build, typecheck, lint clean; full suite 4846 tests, 4823 pass, 22 fail, exit 1, and origin/main in the same worktree fails the same 22 SMTP and TLS tests name for name on Node v26. PR 499, armed.
<!-- SECTION:FINAL_SUMMARY:END -->
