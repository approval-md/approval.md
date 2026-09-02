---
id: APRV-220
title: >-
  Human-signed log checkpoints: a tap signs the current head, and verification
  demands every checkpoint in range
status: To Do
assignee: []
created_date: '2026-09-02 16:26'
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
