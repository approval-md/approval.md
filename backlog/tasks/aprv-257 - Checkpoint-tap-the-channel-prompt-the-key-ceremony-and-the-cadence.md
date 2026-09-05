---
id: APRV-257
title: 'Checkpoint tap: the channel prompt, the key ceremony and the cadence'
status: To Do
assignee: []
created_date: '2026-09-04 23:57'
labels:
  - channels
  - log
  - setup
dependencies:
  - APRV-220
references:
  - APRV-220
  - APRV-216
  - APRV-166
type: enhancement
ordinal: 196000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The delivery half of APRV-220, split off so the record and its verification could land first. APRV-220 builds the log.checkpoint record, the Ed25519 signing, the policy vocabulary (audit.checkpoint_keys, audit.checkpoint_every) and the verify rule, and gives the human one way to sign: `approval log checkpoint` at a terminal. What is still missing is everything that makes it happen without the human remembering to.

Three pieces.

1. THE KEY CEREMONY. `approval setup` mints the Ed25519 checkpoint keypair, writes the private half into the vault under the reserved name approval.checkpoint.key, and prints the public half for the human to paste into APPROVAL.md's audit.checkpoint_keys (an agent must never write that line). Rotation appends rather than replaces, and the verb refuses to drop a key that signed any checkpoint in the log: removing it would turn every checkpoint it signed into a refusal.

2. THE TAP. A channel prompt, 'Checkpoint the log at seq N?', delivered through the paced Telegram queue of APRV-216 and answerable from the CLI channel, whose grant causes the listener (which holds the vault passphrase, as the agent's children do not) to sign the head the human was SHOWN and append the record. The head may have moved between the prompt and the tap, which is why APRV-220's verify rule requires only that the signed seq is below the record's own and that the record at that seq carries the signed hash, rather than that a checkpoint signs its immediate predecessor.

3. THE CADENCE. audit.checkpoint_every already exists as policy vocabulary and is already read as a warning threshold by verification. What is missing is the daemon deciding a checkpoint is DUE and enqueuing the prompt, at most one outstanding at a time and never a nag: a human being away is not tampering, and a due-but-missing checkpoint stays a warning at every layer.

Also here: approval doctor gains a checkpoint row (newest checkpoint, its age against the cadence, the number of keys configured), and docs/cli-reference.md plus a runbook paragraph on what to do when the key is lost.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval setup mints the checkpoint keypair, stores the private half in the vault, and prints the public half with the exact APPROVAL.md line to paste; nothing an agent runs writes that line
- [ ] #2 Key rotation appends to audit.checkpoint_keys and refuses to remove a key that signed any checkpoint in the log, naming the seqs that would stop verifying
- [ ] #3 A checkpoint can be requested and answered from a channel prompt (Telegram and CLI), signed by the listener from the head the human was shown, proved against the mock bot and through the real append path
- [ ] #4 The daemon enqueues a checkpoint prompt when audit.checkpoint_every says one is due, at most one outstanding, and never escalates a missing one past a warning
- [ ] #5 approval doctor gains a checkpoint row; docs/cli-reference.md and a runbook paragraph on a lost key; npm test passes; lint clean
<!-- AC:END -->
