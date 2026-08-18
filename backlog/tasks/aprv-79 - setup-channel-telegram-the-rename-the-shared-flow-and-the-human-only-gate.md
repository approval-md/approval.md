---
id: APRV-79
title: 'setup channel telegram: the rename, the shared flow, and the human-only gate'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-18 08:13'
updated_date: '2026-08-18 09:21'
labels: []
milestone: m-10
dependencies:
  - APRV-78
priority: high
type: feature
ordinal: 78000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
HUMAN RULING: setup telegram becomes setup channel telegram, cut over cleanly, no alias. Rationale for help and SPEC: SPEC 4 defines channels and adapters as opposites (a channel surfaces requests and collects decisions and holds no state; an adapter executes a side effect and holds credentials), and the two setup verbs fill different stores (adapter -> vault, read inside the token window; channel -> keystore + .approval/env, read by the listener from the environment); one noun per store; setup channel web slots in later. commandSetup dispatches channel <name> via a CHANNEL_SETUPS registry symmetric with ADAPTER_SETUPS; bare setup telegram is a usage error naming the new form; every doc/help/test/hint mention moves (env unset comments, doctor fixes, SETUP_HELP, ROOT_HELP, examples, dogfood doc, README, SPEC 10.1). Telegram moves onto runCredentialFlow: keeps getMe before any write, offset-free getUpdates with allowed_updates message, three attempts, 409 hint, listener warning, chat id literal, token via keystore prompt with offerLiteral fallback, no-acknowledgement paragraph, manual-curl refusal; gains requireHuman (a real gap: today --as agent:bot is accepted and ignored), the checklist, shared replace/skip/report and numbered picker; loses nothing behavioural.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 setup telegram exits 2 naming setup channel telegram; no APPROVAL_HUMAN and no --as exits 2 with vault wording; --as agent:bot exits 2 naming the rule; help title gains HUMAN-ONLY
- [x] #2 Every existing telegram test claim survives (no-offset sweep, pending-callback count, storePrompted then read, never-asked-for-token, zero-candidates exit 1 with curl, refused getMe exit 1 before chat questions, declined chat aborted, Ctrl-C, one-message proof)
- [x] #3 A test matches setup channel telegram and setup adapter email transcripts against the same checklist/replace/report patterns; whole-run test covers five subcommands, log byte-identical, .approval/env holds exactly four lines; a grep test asserts no bare setup telegram remains in src, docs, examples, README
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, worktree from aprv-78 branch. 2. Extract front/requireHuman/usageError/HintContext/SetupDeps/KeystoreRunner/Context into cli/setup-common.ts to break the setup <-> setup-adapter cycle; setup.ts, setup-adapter.ts, new setup-channel.ts import from it. 3. CHANNEL_SETUPS registry with telegram; commandSetup dispatches channel <name>; bare setup telegram is a usage error naming the new form. 4. Telegram onto runCredentialFlow with envFileDestination and hooks (collect via keystore prompt, discover for chat, verify getMe); requireHuman added. 5. Every mention of setup telegram moves (env comments, doctor fixes, help, docs, README, SPEC 10.1); grep test. 6. Tests per ACs incl. shared-transcript pattern test. PR.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Opus subagent build, PR #48. Rename cut over cleanly, no alias; bare setup telegram is a usage error naming the new form with the SPEC 4 reason; grep guard fails on any bare mention outside the single RENAMED_NOTICE constant (a second test asserts exactly one line claims the exemption). Cycle broken: front/requireHuman/usageError/SetupDeps/KeystoreRunner/HintContext/FLAGS/SERVICE_*/offerLiteral etc extracted to setup-common.ts; setup-adapter.ts and setup-channel.ts import from it only (layering test); setup.ts 1326 -> 570 lines; identity/vault/sampling helpers stay in setup.ts. Telegram on runCredentialFlow with envFileDestination: collect(token) via keystore prompt + read-back then getMe (before any write on every path; when the token line is left alone but chat is replaced, discover reads the token back from the keystore, never from the file); discover(chat) = message then offset-free getUpdates then shared pickOne; verify = optional sendMessage default no, now after the write (reported declined on failure, exit 0 as before). requireHuman ADDED (was missing; --as agent:bot exits 2). Every prior claim preserved. Shared-transcript test. NEW honest refusal: chat wanted + token line skipped + no keystore -> exit 4 (the only token copy is the file literal; resolving it is invariant 7 forbidden move; the old code silently re-prompted). Whole-run: five subcommands, log byte-identical, exactly FIVE env lines (task said four; adapter adds zero, which is the point). FlowHooks.collect became async structured; discover changed shape (nothing called it before). SPEC 10.1 line + 10.3 sentence flagged. +7 tests, 1509.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
setup channel telegram: clean rename with a grep guard, shared credential flow, human-only gate added, setup module cycle broken by extraction. PR #48.
<!-- SECTION:FINAL_SUMMARY:END -->
