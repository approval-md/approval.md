---
id: APRV-220.1
title: 'Event schema: the log.checkpoint record'
status: Done
assignee:
  - 'agent:opus-lane-i'
created_date: '2026-09-04 23:57'
updated_date: '2026-09-05 00:18'
labels:
  - core
  - log
  - schema
dependencies: []
references:
  - APRV-220
parent_task_id: APRV-220
type: enhancement
ordinal: 195000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The write-boundary half of APRV-220, split out because a schema change is its own task (CLAUDE.md). Add `log.checkpoint` to the closed event-type enum in src/core/log.ts and schema/event.schema.json, with a conditional block that requires a `^human:` actor (the same rule gate.opened carries: this is a human's signature, and an agent able to author one could vouch for a chain it wrote) and a payload of {seq, hash, alg, key_sha256, signature}. key_sha256 is a HINT and never the authority: the verifier looks the public key up in the policy, so a record naming a key nobody lists is a refusal rather than a self-signed pass. Fixtures both ways, and the event-schema and fixtures tests carry it.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 log.checkpoint is in the EventType union and in event.schema.json's enum, and the enum description says what it is
- [x] #2 The conditional block requires ^human: actor and the five payload fields with their formats; a record missing any of them fails at the write boundary
- [x] #3 schema/fixtures/event/valid and /invalid gain cases (well-formed; agent actor; missing signature; malformed hash), and tests/event-schema.test.ts covers them
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
BUILT with APRV-220 (commits ce1036b, 02ee913).

log.checkpoint is the thirteenth event type: added to EventType in src/core/log.ts and to the enum in schema/event.schema.json (the enum description now says twenty-nine and names it). The conditional block requires a ^human: actor and a payload of {seq, hash, alg, key_sha256, signature}: seq an integer >= 1, hash and key_sha256 64 lowercase hex, alg the enum [ed25519] (an enum rather than a free string so a second scheme is an explicit schema change and never a value a signer invents), signature base64.

WHY key_sha256 AND NOT THE KEY. A record carrying its own public key invites a reader to verify the signature against it, which any forger can satisfy. The record names only a fingerprint; the authority is audit.checkpoint_keys in the attested policy. This is SPEC §11.1's 'self-reported fields never reduce scrutiny' applied at the schema layer.

GATE-TYPED. src/core/verify.ts's isGateTyped now returns true for log.checkpoint, so its ts is held to the runtime's clock in the §8 skew report, and core/checkpoint.ts's append takes no ts parameter at all. The whole content of the record is a claim about a moment; a signer who could choose the moment could backdate the one record whose value is when it was taken.

FIXTURES. schema/fixtures/event/valid/log-checkpoint.json carries a REAL Ed25519 signature over the head it names (generated and the private half discarded), so the fixture is a worked example rather than a shape. Four invalid: agent actor, missing signature, a short signed hash, an unimplemented alg. All five are conformance vectors; schema-validation went 1.4.0 to 1.5.0 (minor, purely additive).

The schema and core/checkpoint.ts's readCheckpointPayload agree field for field, which is why checkpoint-malformed is unreachable through this runtime's write boundary. tests/log-checkpoint.test.ts proves that first and then exercises the reader's refusal over records that never touch a file.
<!-- SECTION:NOTES:END -->
