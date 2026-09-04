---
id: APRV-220
title: >-
  Human-signed log checkpoints: a tap signs the current head, and verification
  demands every checkpoint in range
status: In Progress
assignee:
  - 'agent:opus-lane-i'
created_date: '2026-09-02 16:26'
updated_date: '2026-09-04 23:56'
labels:
  - core
  - log
  - channels
  - design
dependencies: []
references:
  - APRV-217
  - APRV-181
  - APRV-166
  - docs/proposals/incremental-prefix-proof.md
priority: medium
type: enhancement
ordinal: 182000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Second layer against a same-user forger (see docs/proposals/incremental-prefix-proof.md §3 and the anchoring task): anchoring relies on GitHub; this relies on a key no agent process holds. The human already signs the policy at attestation with the keypair under .approval/keys (sealed token delivery, APRV-166; amendments born signed off, APRV-181). Extend that: a log.checkpoint record carries the head (seq, hash) at signing time and a signature over it by the human's key, produced by a tap on the phone (Telegram/CLI channel prompt: 'Checkpoint the log at seq N?') or by approval log checkpoint at the terminal, on a cadence the policy sets (proposed audit.checkpoint_every: duration, off when absent) and on demand. Verification (approval log verify, the daemon's full re-proof, hook snapshot admission if cheap) then requires that every checkpoint record inside the walked range validates against the attested public key and names the hash actually at that seq; a chain recomputed after a checkpoint cannot reproduce its signature. Design first: which key signs (the attestation key vs a dedicated checkpoint key), how a checkpoint request reaches the human without becoming a nag (the paced Telegram queue of APRV-216 is the delivery), what a missing-but-due checkpoint means (a warning, never a refusal, since a human being away is not tampering), and the schema for the record. Fail closed on an invalid signature; fail open on absence.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A design section states the signing key, the record schema, the delivery path, the cadence semantics, and the verify rule; Carter signs it off before implementation
- [ ] #2 log.checkpoint records are appended only through the gate with the human's signature over (seq, hash) and validate against the attested public key
- [ ] #3 approval log verify and the daemon's full re-proof refuse a range whose checkpoint signature does not validate or whose named hash is not at that seq, with a distinct machine-readable code; a due-but-missing checkpoint is a warning
- [ ] #4 A checkpoint can be requested from the terminal and answered from a channel prompt; tests through the real append path and the mock Telegram bot
- [ ] #5 Schema change (event payload) is its own subtask; SPEC.md §9 gains the checkpoint sentence via a gated edit; docs updated; npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
SPLIT (orchestrator-sanctioned). This task keeps half (a): the record, the schema, the key handling and verification. Half (b) — the channel tap, the setup key ceremony and the paced cadence delivery — is a new task, and AC #4 moves there.

1. src/core/checkpoint.ts. Ed25519 from node:crypto, no dependency. CHECKPOINT_ALG = 'ed25519'; CHECKPOINT_REFUSAL_CODES, a new closed union (checkpoint-key-unknown, checkpoint-signature-invalid, checkpoint-hash-mismatch, checkpoint-out-of-order, checkpoint-malformed). checkpointMessage({alg,seq,hash}) = 'approval.md/log-checkpoint/v1\n' + JCS({alg,hash,seq}), domain-separated. mintCheckpointKeypair / publicKeyFingerprint (SHA-256 of DER SPKI). appendCheckpoint(logPath, {privateKey}, actor, options): human actor only, reads the log, signs the head it read, appends log.checkpoint under expectedHead. checkLogCheckpoints({records, keys, checkpointEveryMs, now}): pass | skip(reason) | warn | refused(code), over the caller's ALREADY-VERIFIED records.
2. Schema (its own subtask): log.checkpoint joins EventType and event.schema.json's enum, plus a conditional block requiring ^human: actor and payload {seq, hash, alg, key_sha256, signature}. Valid and invalid fixtures.
3. Policy vocabulary: audit.checkpoint_keys (array of base64 DER SPKI public keys, retired keys retained) and audit.checkpoint_every (duration, absent = off). policy.schema.json + policy-load resolution (checkpointEveryMs beside skewToleranceMs).
4. CLI: approval log checkpoint --as human:<id>, key from the vault under the reserved name approval.checkpoint.key or from --key-file. Classified policy.core in core/command-class.ts (human-only, mints no new class), the way gate open/close are.
5. Verify: approval log verify --checkpoints, after the chain verdict on a clean log, beside --anchor and never in place of it. Refusal at EXIT_INTEGRITY, skip on err, warning on due-but-missing.
6. Daemon: the same check on every full re-proof, beside the anchor comparison; a distinct fatal outcome kind, and a warning code for due-but-missing.
7. Conformance: checkpoint_refusal_codes joins the harness UNIONS and the regen script; refusal-unions 8.0.0 (a seventh union), README table and history, manifest re-pinned.
8. Tests: tests/log-checkpoint.test.ts through the real append path with keys generated per test in scratch; the forgery is built the way a forger builds one (truncate, re-append, walk clean from genesis) and every checkpoint inside the rewritten range must refuse.
9. Draft the SPEC sentence and the union row in the notes; SPEC.md is protected and is not edited here.
<!-- SECTION:PLAN:END -->
