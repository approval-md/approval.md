---
id: APRV-207
title: >-
  gloss spawns claude -p with the full inherited environment; starve it like a
  granted child
status: Done
assignee:
  - 'agent:opus-lane-r'
created_date: '2026-09-02 05:58'
updated_date: '2026-09-02 08:03'
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
- [x] #1 The gloss subprocess cannot read APPROVAL_TG_TOKEN, any TELEGRAM_*/VAULT_* variable, or the vault passphrase variable, proven by a test using the fake claude stub that prints its environment
- [x] #2 The model's own auth variables and PATH/HOME/locale still reach the subprocess
- [x] #3 One helper (child-env) is used; no second list
- [x] #4 npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. src/cli/gloss.ts: spawnGloss passes env: childEnvironment({ passphraseEnv }).env to spawnSync (APRV-205's one helper; no second list). spawnGloss gains an optional second parameter (the policy's vault.passphrase_env name), so it stays assignable as a GlossRunner, plus a glossRunnerFor(passphraseEnv) factory for the verbs that have a policy load in hand. The model's own auth (ANTHROPIC_*, CLAUDE_CODE_OAUTH_TOKEN), PATH, HOME and locale are not under the gate's credential prefixes, so they pass with no allowlist of their own.
2. Wire the three verbs that spawn a gloss so a RENAMED passphrase variable is stripped too: channel cli (glossRunner), channel telegram listen (glossWiring), up. Each already resolves a policy location; pass passphraseEnvFor(loadPolicy(...)).
3. Test in tests/channels-cli.test.ts through the verb, with the tests/fake-claude.ts stub bodied to dump its own environment to a witness file: credential-shaped fixtures (APPROVAL_TG_TOKEN, TELEGRAM_*, VAULT_*, the default passphrase name and a renamed one from the policy) are absent; ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_BASE_URL / ANTHROPIC_MODEL, PATH, HOME, LANG and the APRV-194 non-secret allowlist (APPROVAL_HUMAN) are present. repo() gains an optional policy override for the rename case.
4. One sentence in the gloss section of docs/cli-reference.md.
5. lint, build, full npm test.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented (APRV-207).

WHAT CHANGED
- src/cli/gloss.ts: spawnGloss now passes env: childEnvironment({ passphraseEnv }).env to spawnSync. APRV-205's helper is the only list; no allowlist is added here, because the model's own auth (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_BASE_URL, ANTHROPIC_MODEL), PATH, HOME, TMPDIR and the locale are not under the gate's credential-bearing prefixes and therefore pass untouched. No credential is declared: a gloss is not a granted action and no adapter asked for one.
- spawnGloss gained an optional second parameter (the policy's vault.passphrase_env name) so it stays assignable as a GlossRunner, plus glossRunnerFor(passphraseEnv) for the verbs.
- Wired the three verbs that spawn a gloss so a RENAMED passphrase variable is stripped too: channel cli (glossRunner now takes the policy location), channel telegram listen (glossWiring takes an optional passphraseEnv, default null so programmatic callers and the existing APRV-197 test are unchanged), and up (its loadPolicy result was already in hand). Each resolves the name through passphraseEnvFor(loadPolicy(...)), which is the same one-name-only read cli/execute.ts does; the default name is caught by the prefix rule regardless.

DECISION worth recording: the two existing non-granted-child call sites (cli/hook.ts, daemon/git-evidence.ts) call childEnvironment() bare, which covers only the DEFAULT passphrase name. The gloss threads the policy's name instead because the task names the passphrase variable explicitly and the stricter path is the one this repo takes on ambiguity. That leaves those two sites as the looser pair; not in this task's scope, and worth a follow-up if the orchestrator wants them aligned.

INVARIANTS: no gate-typed event, no log path, no policy resolution and no refusal shape is touched. §11.1's raw-secrets invariant is the one this moves toward: the count childEnvironment returns is not read here, and no variable NAME is printed anywhere.

VERIFICATION
- tests/channels-cli.test.ts: three tests through the real verb with the tests/fake-claude.ts stub bodied to dump its own environment ('env > witness'), so both halves are proven from the CHILD's point of view: (1) APPROVAL_TG_TOKEN, APPROVAL_VAULT_PASSPHRASE, TELEGRAM_BOT_TOKEN and VAULT_MASTER_KEY are absent, and none of their VALUES arrived under another name, while APPROVAL_HUMAN (the APRV-194 non-secret allowlist) survives; (2) the five model-auth variables arrive with their fixture values, and PATH/HOME/LANG are intact and the sentence still renders; (3) a policy that renames vault.passphrase_env to GLOSS_LANE_PASSPHRASE (outside the prefixes) has that variable stripped while a same-shaped neighbour passes.
- repo() in that suite gained an optional policy override for the rename case.
- docs/cli-reference.md: one paragraph in the gloss section of channel cli.
- npm run lint clean; npm run build clean; npm test: 2712 tests, 2711 pass, 0 fail, 1 skipped (the pre-existing conditional skip in tests/backlog-fixtures.test.ts).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The gloss subprocess is now spawned with APRV-205's scrubbed environment instead of the session's own: no APPROVAL_*/TELEGRAM_*/VAULT_* variable and no vault passphrase (including one the policy renamed out from under the prefixes) reaches claude -p, while its own auth, PATH, HOME and the locale pass because they were never the gate's secrets. One helper, no second list. Proven by three tests that drive the real channel cli verb with the fake claude stub printing its own environment; lint and build clean, npm test 2711 passed / 0 failed / 1 pre-existing skip.
<!-- SECTION:FINAL_SUMMARY:END -->
