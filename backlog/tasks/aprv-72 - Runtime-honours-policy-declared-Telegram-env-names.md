---
id: APRV-72
title: Runtime honours policy-declared Telegram env names
status: In Progress
assignee:
  - '@fable'
created_date: '2026-08-18 01:38'
updated_date: '2026-08-18 01:39'
labels: []
milestone: m-10
dependencies: []
priority: high
type: bug
ordinal: 71000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
schema/policy.schema.json declares channels.telegram.token_env and chat_id_env, approval init scaffolds them, both demo runbooks write them, and nothing reads them: every runtime path hardcodes APPROVAL_TG_TOKEN and APPROVAL_TG_CHAT. A policy that renames them is silently ignored, which is the file-says-one-thing-runtime-does-another failure this project exists to prevent. Honour them additively (the constants become defaults), modelled exactly on passphraseEnvFor in core/vault.ts: policy value when non-empty, else the constant; an unloadable policy returns the default (a name is not a permission). Consumers: channel telegram listen setUp, channel telegram health (gains --policy/--dir, reports resolved names), doctor checkTelegram (names the policy variable in skip/fail detail). Nothing under src/channels/ touches process.env. First in the M7.1 sequence because env, setup, and doctor all need the resolved names.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 telegramTokenEnvFor/telegramChatEnvFor exist beside the constants; policy value wins, default otherwise, unloadable policy falls back
- [ ] #2 listen, health, and doctor read the policy-named variables and name them in messages; health --json token_env/chat_env carry the resolved names
- [ ] #3 Default behaviour byte-identical for policies declaring nothing or the canonical names; existing tests unchanged; src/channels/ still reads no process.env
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, worktree from main. 2. telegramTokenEnvFor/telegramChatEnvFor beside the constants in channels/telegram.ts modelled on passphraseEnvFor. 3. Consumers: cli/channel-telegram.ts setUp + health (--policy/--dir, resolved names in output), cli/doctor.ts checkTelegram (policy load passed in). 4. Help texts. 5. Tests for renamed, neither-declared, unparseable. PR, auto-merge.
<!-- SECTION:PLAN:END -->
