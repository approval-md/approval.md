---
id: APRV-257
title: 'Checkpoint tap: the channel prompt, the key ceremony and the cadence'
status: In Progress
assignee:
  - 'agent:opus-lane-g'
created_date: '2026-09-04 23:57'
updated_date: '2026-09-05 08:38'
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

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. core/checkpoint.ts gains the tap primitives. checkpointDue({records, publicKeys, checkpointEveryMs, now}) -> CheckpointOffer|null, ONE due-ness rule that cadenceWarning, the daemon and the dispatch cycle all read. appendCheckpointAt(logPath, key, actor, head, {channel}) signs a CALLER-NAMED head (the one the human was shown), refuses checkpoint-head-unknown when the log does not carry that hash at that seq, and appends under withHeadRetry with the CURRENT head as expectedHead. appendCheckpoint keeps its signature and becomes a thin wrapper (sign the head just read).
2. cli/checkpoint-tap.ts: custody in ONE place. resolveCheckpointKey moves out of cli/log-checkpoint.ts (--key-file, else the vault under approval.checkpoint.key); checkpointOfferFor(logPath, policy, now); checkpointPromptLines(offer); signOffer(...) -> one sentence. Both channels and the CLI verb call this file and nothing else reads a key.
3. cli/setup-checkpoint.ts: approval setup checkpoint [--rotate] [--retire <fp>]. front()+requireHuman, TTY-only like every other setup subcommand, mints the Ed25519 pair, writes the private half to the vault, prints the public half and the exact audit.checkpoint_keys line plus `approval policy amend`. Never writes APPROVAL.md. --rotate appends; --retire refuses to drop a key that signed any checkpoint, naming the seqs. Classified policy.core in core/command-class.ts (existing class, no minting).
4. The tap. channels/telegram.ts: offerCheckpoint(offer) sends its own unit with two buttons (k=sign, n=not now) on a nonce map of its own, onCheckpoint(handler) routes the tap, the message is edited with what the log recorded. New callback verbs parse through a separate parser so nothing can read them as a grant. channels/cli.ts: offerCheckpoint renders the same lines and reads one keystroke. cli/channel-telegram.ts dispatch enqueues at most one outstanding prompt from checkpointDue; cli/channel.ts offers it after the queue.
5. Cadence. The daemon already warns checkpoint-due; it now warns from the same checkpointDue, and its tick event carries checkpoints.due. Nothing anywhere turns due into a refusal.
6. doctor row 'checkpoint' (skip with no key, pass inside cadence, pass+fix when due, fail on a verification refusal); pins 24 -> 25.
7. Docs: cli-reference (setup checkpoint, the tap), dogfood-cutover (the ceremony, the lost key), git-evidence (checkpoints beside anchoring).
8. Tests: tests/checkpoint-tap.test.ts through the real append path, the mock bot, scratch vaults with per-test passphrases, keys minted per test; plus the no-route-to-the-key proof (classification human-only both verbs, child-env strips the passphrase, the hook module's import graph never reaches the custody file).
9. Decide the core/vault.ts caller-list question and record it.
<!-- SECTION:PLAN:END -->
