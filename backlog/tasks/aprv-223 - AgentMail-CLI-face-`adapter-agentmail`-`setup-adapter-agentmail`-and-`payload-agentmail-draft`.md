---
id: APRV-223
title: >-
  AgentMail CLI face: `adapter agentmail`, `setup adapter agentmail`, and
  `payload agentmail-draft`
status: To Do
assignee: []
created_date: '2026-09-02 16:30'
labels:
  - adapter
  - launch
  - cli
dependencies:
  - APRV-222
priority: high
ordinal: 183000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Expose the AgentMail adapter to operators and agents. `approval adapter agentmail <action-key> --token <t> --payload <file|->` executes through the contract. `approval setup adapter agentmail` is manifest-driven (src/cli/setup-adapter.ts ADAPTERS table) and probes with `GET /v0/inboxes/{inbox_id}` using the vault key, sending nothing; where the API exposes the key own permissions it checks for draft_send and message_send and warns when absent. `approval payload agentmail-draft <inbox_id> <draft_id>` fetches a draft with the AGENT key (`AGENTMAIL_API_KEY` from the environment, the one verb that reads it) and prints the canonical draft payload JSON for `approval register`. Help texts, verb-registry entries, instructions roster, and docs/cli-reference.md headings are test-enforced (tests/cli-help.test.ts, tests/cli-instructions.test.ts).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `approval adapter agentmail` accepts the same flags as `adapter email`, executes both payload modes, and maps refusals onto the same exit table
- [ ] #2 `approval setup adapter agentmail` stores agentmail.api_key and agentmail.inbox_id in the vault after validation and offers a no-send probe; a key lacking send permissions produces a warning naming the missing permission
- [ ] #3 `approval payload agentmail-draft <inbox> <draft>` prints canonical JSON whose hash equals what the adapter recomputes from the same draft; exits non-zero with a machine-readable code when AGENTMAIL_API_KEY is unset or the draft is missing
- [ ] #4 Verb registry, `approval instructions`, help, long-help and MCP tool list all carry the three new surfaces; docs/cli-reference.md has #adapter-agentmail, #setup-adapter-agentmail, #payload-agentmail-draft
- [ ] #5 npm test green, lint clean
<!-- AC:END -->
