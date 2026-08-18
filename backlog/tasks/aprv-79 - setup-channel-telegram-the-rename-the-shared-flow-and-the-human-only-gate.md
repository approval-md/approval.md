---
id: APRV-79
title: 'setup channel telegram: the rename, the shared flow, and the human-only gate'
status: To Do
assignee: []
created_date: '2026-08-18 08:13'
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
- [ ] #1 setup telegram exits 2 naming setup channel telegram; no APPROVAL_HUMAN and no --as exits 2 with vault wording; --as agent:bot exits 2 naming the rule; help title gains HUMAN-ONLY
- [ ] #2 Every existing telegram test claim survives (no-offset sweep, pending-callback count, storePrompted then read, never-asked-for-token, zero-candidates exit 1 with curl, refused getMe exit 1 before chat questions, declined chat aborted, Ctrl-C, one-message proof)
- [ ] #3 A test matches setup channel telegram and setup adapter email transcripts against the same checklist/replace/report patterns; whole-run test covers five subcommands, log byte-identical, .approval/env holds exactly four lines; a grep test asserts no bare setup telegram remains in src, docs, examples, README
<!-- AC:END -->
