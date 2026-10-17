---
id: APRV-72
title: Runtime honours policy-declared Telegram env names
status: Done
assignee:
  - '@fable'
created_date: '2026-08-18 01:38'
updated_date: '2026-08-18 02:31'
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
- [x] #1 telegramTokenEnvFor/telegramChatEnvFor exist beside the constants; policy value wins, default otherwise, unloadable policy falls back
- [x] #2 listen, health, and doctor read the policy-named variables and name them in messages; health --json token_env/chat_env carry the resolved names
- [x] #3 Default behaviour byte-identical for policies declaring nothing or the canonical names; existing tests unchanged; src/channels/ still reads no process.env
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, worktree from main. 2. telegramTokenEnvFor/telegramChatEnvFor beside the constants in channels/telegram.ts modelled on passphraseEnvFor. 3. Consumers: cli/channel-telegram.ts setUp + health (--policy/--dir, resolved names in output), cli/doctor.ts checkTelegram (policy load passed in). 4. Help texts. 5. Tests for renamed, neither-declared, unparseable. PR, auto-merge.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Opus subagent build, PR #39. telegramTokenEnvFor/telegramChatEnvFor modelled on passphraseEnvFor (policy value when non-empty, else the constant, unloadable policy falls back: a name is not a permission); constants become defaults; type-only PolicyLoadResult import so channels/ still has no runtime edge to core and reads no process.env. Consumers: listen setUp (loads the policy once at startup; the not-configured usage error names the RESOLVED variable), health (--policy/--dir; token_env/chat_env JSON keys now carry resolved names; commandTelegramHealth gained a cwd parameter), doctor checkTelegram (all four messages name the resolved variables). SPEC 5.2 bullet drafted (flagged). Judgment calls: setUp now locates the policy before the credential check (error precedence unchanged, pinned); TelegramChannel.health() still names the constants (unreachable via CLI; follow-up if surfaced). Superseded in APRV-73: fable moved the constants+resolvers to core/telegram-config.ts (env-file needed them; core must not import channels); channels/telegram.ts re-exports. +6 tests.

PR #39 closed unmerged as superseded: PR #40 (APRV-73) branched from it and landed every APRV-72 commit on main (bfbb219), plus the resolver move to core.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Policy-declared channels.telegram.token_env/chat_id_env are honoured everywhere the runtime reads them, additively; defaults preserved. PR #39.
<!-- SECTION:FINAL_SUMMARY:END -->
