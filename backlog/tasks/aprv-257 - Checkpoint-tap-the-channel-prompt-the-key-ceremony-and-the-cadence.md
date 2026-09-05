---
id: APRV-257
title: 'Checkpoint tap: the channel prompt, the key ceremony and the cadence'
status: In Progress
assignee:
  - 'agent:opus-lane-g'
created_date: '2026-09-04 23:57'
updated_date: '2026-09-05 09:14'
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
- [x] #1 approval setup mints the checkpoint keypair, stores the private half in the vault, and prints the public half with the exact APPROVAL.md line to paste; nothing an agent runs writes that line
- [x] #2 Key rotation appends to audit.checkpoint_keys and refuses to remove a key that signed any checkpoint in the log, naming the seqs that would stop verifying
- [x] #3 A checkpoint can be requested and answered from a channel prompt (Telegram and CLI), signed by the listener from the head the human was shown, proved against the mock bot and through the real append path
- [x] #4 The daemon enqueues a checkpoint prompt when audit.checkpoint_every says one is due, at most one outstanding, and never escalates a missing one past a warning
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

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
BUILT on branch aprv-257-checkpoint-tap. Commits cea9e1c (core primitives), ac33540 (custody in one place), 07a0ad1 (the setup ceremony), 4ed40b0 (the Telegram tap), bb14ac9 (the CLI channel prompt), 83923da (doctor row + daemon due flag), d74e22f (tests), 4a5f855 (docs), 02063d6 (burst fix).

=== WHAT WAS BUILT, AND THE DECISIONS INSIDE IT ===

1. ONE DUE-NESS RULE. core/checkpoint.ts gains checkpointDue(), and cadenceWarning() is now a renderer over the same function. So the verify verdict's warning, the daemon's checkpoint-due, doctor's row and the channel prompt all read ONE rule. There is no arrangement in which the daemon says a checkpoint is owed and the listener declines to ask for one. It offers only from a PASS: a refused range is not a range to sign a new checkpoint on top of (look at it instead), and a skipped one has no key to sign with.

2. THE HEAD THE HUMAN WAS SHOWN. appendCheckpointAt(logPath, key, actor, head) signs a CALLER-NAMED head, checks the chain still carries that hash at that seq (new append refusal checkpoint-head-unknown, which is NOT in the conformance-pinned union), and appends under compare-and-append through core/head-retry.ts. appendCheckpoint keeps its signature and both share one body. This is APRV-220's verify rule (a checkpoint signs any seq BELOW its own) being used for the thing it was written for. A bug the suite found and fixed: the result's head field was reporting the LOG head rather than the SIGNED head, so a tap's own report named the wrong (seq, hash).

3. CUSTODY MOVED, NOT COPIED. resolveSigningKey left cli/log-checkpoint.ts for the new cli/checkpoint-tap.ts, because the tap adds two more callers and the property APRV-220 wanted was 'one file to read to learn every way a key can reach a signature'. The terminal verb now resolves its key with everyone else's function. Sentences unchanged. An optional env parameter was added (the same seam setup adapter carries) so the suite can prove the vault path without mutating a process-wide environment.

4. THE VAULT-HEADER QUESTION, DECIDED: amend the comment, keep the key in the vault. core/vault.ts's getCredential header now names TWO sanctioned callers and states what the list actually keeps — a credential's value goes from that file into a USE and never onto a SURFACE — with the rejected alternative recorded. Moving the key out to keep the list at one name would have made the key WEAKER: the OS keystore has no equivalent of the passphrase variable core/child-env.ts strips from every child (APRV-205), and a file beside the log has no encryption at all. A checkpoint key is the one secret whose entire value is that an agent-launched process cannot reach it. tests/checkpoint-tap.test.ts asserts the caller list is exactly those two files, so a third fails a test rather than a review.

5. THE CEREMONY. approval setup checkpoint, shaped like every other setup subcommand (front(), requireHuman, terminal-or-nothing with the scripted alternative printed). It mints, vaults the private half under approval.checkpoint.key, prints the public half plus the exact audit.checkpoint_keys block and `approval policy amend`, and STOPS. It edits no policy file, so the key is INERT when the verb finishes and the verb says so in capitals. --rotate appends and replaces the private half; --retire prints the block that drops a key and REFUSES any key that signed a checkpoint, naming the seqs (new core helper checkpointSignersIn, answered from the verified log; an unverifiable log refuses the retirement too rather than guessing).

6. THE TAP. channels/telegram.ts gains offerCheckpoint/onCheckpoint and two callback verbs of its own (k=sign, x=not now) with their own parser. The separation is load-bearing: CALLBACK_VERBS maps every decision verb onto a grant or a reject, so a checkpoint button spelled 'g' would fall into the decision ladder, where an unresolved nonce becomes an action-reference lookup and a signature gesture starts hunting for a request to approve. The head lives in the issuing process's nonce map and never in the callback bytes, so nothing that can reach the bot chooses what gets signed. The nonce is spent before the handler runs, so a double tap makes one record. channels/cli.ts gains collectCheckpoint, rendering the SAME lines (checkpointPromptLines) and reading s/n.

7. WHERE THE ENQUEUE LIVES, and why that is the daemon's job being done. AC #4 says 'the daemon enqueues'. In this runtime SPEC §10.2's dispatch job is performed by the listener's dispatch cycle, and cli/channel-telegram.ts's module doc records why (the daemon holds no channel credential and no approver identity, and a network round-trip inside a tick couples the projection loop to Telegram's availability). So the enqueue is in dispatchPending, reading the same checkpointDue the daemon's warning reads, and the daemon's tick line now carries checkpoints.due so its decision is visible. Giving the daemon a bot token to send one prompt would have undone the reason dispatch is not there.

At most one outstanding, never a nag: DispatchState.checkpoint holds { offered, offeredSince }, where offeredSince is the newest checkpoint's seq at prompt time. A lapsed cadence produces an offer on every cycle; this process asks once per lapse and again only after a checkpoint actually LANDS (which is also when due-ness goes false). A restart re-asks once, the same direction all channel bookkeeping degrades in. A paced cycle that offered one ends there (one question at a time); a burst cycle does NOT, because --once is one cycle and returning would have left a startup batch undelivered for a prompt that blocks nothing.

8. THE DOCTOR ROW. 'checkpoint', appended sixteenth. Skip with no declared key (a check that could not look must never report a pass), fail on any verification refusal, pass otherwise INCLUDING when one is due — the cadence carries a fix line rather than a status, because a doctor that went red over somebody's holiday is a doctor whose red people stop reading. Pins bumped 24 -> 25 in tests/cli-doctor.test.ts (three of them: the count, the human line count, and the row-name/status lists).

=== GLOBAL INVARIANTS TOUCHED (SPEC §11.1, per CLAUDE.md) ===
inv. 1: every surface here reads already-verified records; checkpointOfferFor gives up on a log that does not verify rather than offering from it. inv. 2: log.checkpoint stays gate-typed and neither append entry point takes a ts. inv. 3: no raw secret reaches the log, the terminal, or a channel — the setup verb never prints the private half and the test asserts it. inv. 5: the tap's append is a compare-and-append with a bounded head-moved retry, so a listener racing the daemon does not hand 'head moved' to somebody who just tapped a button. inv. 6: checkpoint-head-unknown joins CHECKPOINT_APPEND_REFUSAL_CODES, which is not one of the seven conformance-pinned unions; CHECKPOINT_REFUSAL_CODES is untouched, so refusal-unions stays at 8.0.0. inv. 7: key_sha256 remains a hint and the policy remains the authority; --retire matches on the fingerprint of a POLICY-declared key, never on what a record claims. inv. 9: approval setup checkpoint classifies to the EXISTING policy.core (human-only in the reference policy), mints no class, and the other setup subcommands are untouched.

=== THE PROOF THAT AN AGENT CANNOT SIGN ===
Three locks, each asserted rather than described (tests/checkpoint-tap.test.ts): (a) classifyCommand puts both approval log checkpoint and approval setup checkpoint at policy.core, and gate open is asserted alongside to show the class is not new; (b) childEnvironment strips the vault passphrase, and resolveCheckpointKey over that stripped environment refuses; (c) a transitive import walk from src/cli/hook.ts never reaches checkpoint-tap.ts, log-checkpoint.ts or setup-checkpoint.ts, with a guard that the walk really walked. Plus the getCredential caller-list assertion in (4).

=== SPEC SENTENCES FOR THE ORCHESTRATOR TO APPLY UNDER A GRANT ===

SPEC.md is protected and this agent did not edit it. Two sentences, both for §9 beside APRV-220's checkpoint paragraph.

(1) THE TAP.

'A runtime that offers human-signed checkpoints MAY invite one rather than wait to be remembered: where the policy declares a checkpoint interval and that interval has lapsed, the runtime MAY put a single prompt naming the (seq, hash) it is asking about in front of the human through a channel. It MUST sign exactly the (seq, hash) the human was shown, and MUST refuse rather than sign when the chain no longer carries that hash at that seq, because a signature over a head this chain does not have is a checkpoint that can never verify. It MUST hold at most one such prompt outstanding, MUST NOT repeat it for one lapse of the interval, and MUST NOT treat a prompt that was declined, ignored, or never delivered as a refusal of anything. The signing key MUST be reachable only from a process the human established: an invitation carries no authority of its own, and a runtime that could mint or read the key on its own account would be signing for itself. (Added APRV-257.)'

(2) ROTATION.

'A runtime that lets a human rotate a checkpoint key MUST add rather than replace, and MUST refuse to remove a declared key that signed any checkpoint inside a log it can read, naming the records that would stop verifying: the declared list retains every key that has ever signed, because removing one turns every checkpoint it signed into a refusal of a log nobody has touched. (Added APRV-257.)'

Nothing in §11.1's invariant list needs a new entry: the tap touches inv. 1, 2, 3, 5, 6, 7 and 9 and weakens none of them (see the invariant paragraph above).
<!-- SECTION:NOTES:END -->
