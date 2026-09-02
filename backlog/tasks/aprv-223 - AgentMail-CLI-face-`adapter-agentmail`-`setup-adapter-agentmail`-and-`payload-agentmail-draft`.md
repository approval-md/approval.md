---
id: APRV-223
title: >-
  AgentMail CLI face: `adapter agentmail`, `setup adapter agentmail`, and
  `payload agentmail-draft`
status: Done
assignee:
  - '@claude-opus'
created_date: '2026-09-02 16:30'
updated_date: '2026-09-02 17:53'
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
- [x] #1 `approval adapter agentmail` accepts the same flags as `adapter email`, executes both payload modes, and maps refusals onto the same exit table
- [x] #2 `approval setup adapter agentmail` stores agentmail.api_key and agentmail.inbox_id in the vault after validation and offers a no-send probe; a key lacking send permissions produces a warning naming the missing permission
- [x] #3 `approval payload agentmail-draft <inbox> <draft>` prints canonical JSON whose hash equals what the adapter recomputes from the same draft; exits non-zero with a machine-readable code when AGENTMAIL_API_KEY is unset or the draft is missing
- [x] #4 Verb registry, `approval instructions`, help, long-help and MCP tool list all carry the three new surfaces; docs/cli-reference.md has #adapter-agentmail, #setup-adapter-agentmail, #payload-agentmail-draft
- [x] #5 npm test green, lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. registry.ts: add agentmailAdapter() to builtInAdapters().
2. agentmail.ts (additive exports only): draftPayloadFrom(inboxId, draftId, fetched) building the canonical {inbox_id,draft_id,to,cc?,bcc?,subject,text} the drift check expects; probeAgentmail also reports any permissions the inbox read discloses.
3. help.ts: ADAPTER_AGENTMAIL_HELP, SETUP_ADAPTER_AGENTMAIL_HELP, PAYLOAD_AGENTMAIL_DRAFT_HELP; roster lines in ADAPTER_HELP, SETUP_ADAPTER_HELP, PAYLOAD_HELP, ROOT_HELP.
4. adapter.ts: ADAPTER_CLIS.agentmail; lookup through Object.hasOwn so inherited Object keys are unknown adapters.
5. setup-adapter.ts: ADAPTER_SETUPS.agentmail, manifest from AGENTMAIL_CREDENTIAL_SPECS, verify through probeAgentmail (no send), warning or reminder about draft_send/message_send.
6. payload.ts: approval payload agentmail-draft <inbox> <draft>, AGENTMAIL_API_KEY from the environment, injectable fetch and --api-base, canonical JSON on stdout, machine-readable refusals.
7. verb-registry, instructions roster, docs/cli-reference.md anchors.
8. Tests: cli-adapter (constructor is an unknown adapter, agentmail help), cli-payload (printed JSON hashes to what the adapter recomputes), cli-setup (agentmail probe warns), cli-instructions labels. npm test + lint.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
APRV-223 implementation.

WHAT LANDED
- src/adapters/registry.ts: builtInAdapters() now returns [emailAdapter(), agentmailAdapter()]. Two adapters serve communicate.email.external and the scrub sees the union, which is what unionRequiredCredentials was written for.
- src/cli/adapter.ts: ADAPTER_CLIS.agentmail -> agentmailAdapter(options), help ADAPTER_AGENTMAIL_HELP. The name lookup is Object.hasOwn now: the table is a plain object, so 'constructor' and 'toString' used to resolve to Object.prototype members and be dispatched as adapters. Same fix in setup-adapter.ts's ADAPTER_SETUPS lookup.
- src/cli/setup-adapter.ts: ADAPTER_SETUPS.agentmail, manifest AGENTMAIL_CREDENTIAL_SPECS, verify = probeAgentmail (GET /v0/inboxes/{id}, sends nothing). VerifyContext gained apiBase, threaded from SetupDeps.apiBase (already existed) so tests point the probe at the loopback mock; no new field on SetupDeps and no probe seam of its own.
- src/cli/payload.ts: 'approval payload agentmail-draft <inbox> <draft>'. AGENTMAIL_API_KEY from the environment (this is the one verb that reads it), injectable env/fetch deps, --api-base or AGENTMAIL_API_BASE, --timeout. Prints canonicalize(payload) so the printed bytes ARE the RFC 8785 form the hash is defined over.
- src/adapters/agentmail.ts (additive only): draftSnapshot() builds the canonical payload with exactly canonicalField()'s rules (cc/bcc omitted when absent/null/empty, 'to' copied unnormalized), readAgentmailDraft() is the shared GET, probeAgentmail now also reports permissions the inbox read disclosed.
- src/cli/main.ts and src/mcp/server.ts: 'payload' joined the promise-unwrapping dispatch arm, because agentmail-draft is asynchronous. Without the MCP arm the tool would have returned exit 0 with no output.
- help.ts (ADAPTER_AGENTMAIL_HELP, SETUP_ADAPTER_AGENTMAIL_HELP, PAYLOAD_AGENTMAIL_DRAFT_HELP plus roster lines in ROOT_HELP/ADAPTER_HELP/SETUP_ADAPTER_HELP/PAYLOAD_HELP), verb-registry (adapter agentmail, payload agentmail-draft, widened 'setup adapter' positional), instructions roster, docs/cli-reference.md #adapter-agentmail, #setup-adapter-agentmail, #payload-agentmail-draft.

THE PERMISSIONS DECISION (deliverable 3, and it is a judgment call)
No network call was made from this session to confirm whether AgentMail exposes an endpoint reporting the CALLING key's own permissions, so none is called at runtime either. Probing a URL nobody has confirmed exists would turn its 404 into a permissions verdict, which is a worse answer than 'not disclosed'. Instead probeAgentmail reads permissions/scopes out of the inbox response it already fetches (top level, or under key/api_key) and reports three states: both send permissions present -> one confirming line; one or both missing -> a WARNING naming exactly the missing ones and saying the failure would otherwise land after a human granted the send; nothing disclosed -> a reminder that the vault key must carry draft_send and message_send and the agent's key must not. null means UNKNOWN and never 'none', so a silent API cannot make a good key look refused. A missing permission is a warning and not a refusal: the values stay stored.

OTHER DECISIONS THE DIFF HIDES
- agentmail-draft's refusal for an unset key is exit 2 (the command is unrunnable as written) but carries the machine-readable code 'agentmail-api-key-unset' rather than 'usage', because the code is what an agent branches on. Draft missing/unusable/unreachable are exit 1.
- The printed payload is the canonical serialization itself under --json too. There is no envelope: the payload IS the machine-readable result, and wrapping it would be one more thing to strip before hashing.
- draftSnapshot refuses rather than normalizes. A 'to' that is a bare string or a missing subject would produce a snapshot the adapter's drift check rejects at send time, after a human approved it.

VALIDATION
- New: tests/cli-payload.test.ts (7 cases, in-process against the loopback AgentMail mock: the printed snapshot handed to the real agentmailAdapter().act() finds no drift and records payload_hash equal to payloadHash of the printed bytes; empty cc omitted; --api-base and the agent's bearer; unset key refuses and contacts nothing; draft-missing; draft-unusable; args and help), tests/cli-setup.test.ts (7 cases: both names stored and probed with no POST, the missing-permission warning, the no-disclosure reminder, a refused key keeping the values with the undo, a declined probe contacting nothing, --help and human-only, the generated non-interactive hint), tests/cli-adapter.test.ts ('constructor' and 'toString' are unknown adapters; the agentmail help's claims; the help and the usage error both list the whole table).
- Global invariants touched: none weakened. No enforcement path reads anything new, no timestamp is authored, no secret reaches a stream (the agent key is swept in both new test sections), nothing appends to the log.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Gave the AgentMail adapter its CLI face: `approval adapter agentmail` through the ADAPTER_CLIS table, `approval setup adapter agentmail` through ADAPTER_SETUPS with a no-send GET /v0/inboxes/{id} probe that names any missing draft_send/message_send (or says plainly it could not check, rather than calling an unconfirmed endpoint), and `approval payload agentmail-draft` which reads a draft with the AGENT's AGENTMAIL_API_KEY and prints the canonical payload. Also registered agentmailAdapter() in builtInAdapters() and fixed both adapter-name lookups to Object.hasOwn, so `approval adapter constructor` is an unknown adapter. Verified with 21 new tests: the printed snapshot handed to the real agentmailAdapter().act() finds no drift and records a payload_hash equal to payloadHash of the printed bytes; the setup probe stores both names and issues no POST; the missing-permission warning, the no-disclosure reminder and a refused key keeping its values are each pinned; 'constructor'/'toString' refuse as unknown adapters. npm test 2901 pass / 0 fail / 1 skipped, npm run lint clean.
<!-- SECTION:FINAL_SUMMARY:END -->
