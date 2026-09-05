---
id: APRV-220
title: >-
  Human-signed log checkpoints: a tap signs the current head, and verification
  demands every checkpoint in range
status: In Progress
assignee:
  - 'agent:opus-lane-i'
created_date: '2026-09-02 16:26'
updated_date: '2026-09-05 00:19'
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

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
BUILT: half (a), the record, the schema, the key handling and verification. Branch aprv-220-signed-checkpoints, commits e999945 / ce1036b / 0bd92bf / 26a6a1a / 02ee913.

THE SPLIT. The task's own description carries a design step, a record, a schema, a CLI verb, a verify rule, a daemon rule, a channel tap, a paced cadence and a setup ceremony. That is more than one lane. APRV-220.1 (Done, delivered here) is the write-boundary schema change, split because CLAUDE.md makes a schema change its own task. APRV-257 (To Do, depends on this) is the delivery half: the setup key ceremony, the Telegram/CLI tap through APRV-216's paced queue, the daemon deciding a checkpoint is DUE, and the doctor row. AC #4 of this task moves to APRV-257 and is left unchecked here.

AC #1 IS FOR CARTER. The design below is the section AC #1 asks for. It was BUILT AHEAD OF SIGN-OFF on the orchestrator's instruction to deliver half (a) fully; nothing is merged. If a decision below is wrong, the change is small and local, and each one names where it lives.

=== THE DESIGN ===

1. WHICH KEY SIGNS. A dedicated Ed25519 keypair, NOT the attestation identity. There was no keypair to reuse: core/attest.ts is config-declared identity (--as human:<id> or APPROVAL_HUMAN) and its documented claim is that someone with LOCAL CONTROL signed off, never who. A checkpoint has to claim more than that or it claims nothing, because the party it defends against is a process with local control. Ed25519 from node:crypto; no dependency added.

   PRIVATE HALF: the credential vault, under the reserved name approval.checkpoint.key. Encrypted at rest under the passphrase vault.passphrase_env names, which core/child-env.ts strips from every child this runtime spawns (APRV-205), behind a file whose reading classifies account.credential (human-only, APRV-194). --key-file <path> is the alternative for a key kept outside the vault. There is no --key flag and no environment variable holding the key: a key on a command line is a key in the shell history, and a key in the session environment is a key every child inherits.

   core/checkpoint.ts takes the private key as a VALUE and reads it from nowhere. Custody is decided in exactly one file, src/cli/log-checkpoint.ts, so there is one place to read to learn every way a key can reach a signature.

   NOTE FOR REVIEW: this makes approval log checkpoint the SECOND sanctioned caller of vault.getCredential after adapters/vault-provider.ts, which core/vault.ts's header names as the only one. Same shape as the first (the value travels into a signature, never into a terminal), and there is still no verb that PRINTS a credential, which is the rule that module is actually keeping. Called out because it is a documented-invariant caller list, not an accident.

   PUBLIC HALF: audit.checkpoint_keys in APPROVAL.md, base64 DER SPKI. The one key-shaped field in that file holding MATERIAL rather than the NAME of a variable, because a public key is not a secret and the value of writing it there is that the file is committed and attested: an agent that edited the list would leave a visible diff AND de-attest the policy, which stops every gate operation until a human re-attests. A LIST, not a scalar, so rotation retains retired keys.

2. THE RECORD SCHEMA. log.checkpoint, human actor in the schema, payload {seq, hash, alg: 'ed25519', key_sha256, signature}. Full detail in APRV-220.1's notes. key_sha256 is a HINT, never the authority.

3. WHAT IS SIGNED. 'approval.md/log-checkpoint/v1\n' + JCS({alg, hash, seq}). Domain-separated, so a signature made here cannot be lifted into another use of the key and one made elsewhere cannot be presented as a checkpoint. The head's hash is a 256-bit chain digest, so the message is already specific to one chain at one position. The signature deliberately does NOT cover the rest of the record: it could not, since the record's hash covers its payload which covers the signature. What a checkpoint asserts is exactly 'a key holder saw this head'.

4. THE VERIFY RULE. checkLogCheckpoints({records, publicKeys, checkpointEveryMs, now}) over the caller's ALREADY-VERIFIED records (§11.1 inv. 1). Every log.checkpoint in range must (a) read, (b) sign a seq BELOW its own, (c) name a configured key, (d) verify under it AND name the hash the log carries at that seq. First failure refuses. New closed union CHECKPOINT_REFUSAL_CODES: checkpoint-key-unknown, checkpoint-signature-invalid, checkpoint-hash-mismatch, checkpoint-out-of-order, checkpoint-malformed.

   NOT AN IMMEDIATE-PREDECESSOR RULE, on purpose. A checkpoint signs any seq below its own, not necessarily record.seq - 1. That is what makes APRV-257's phone tap possible: the head moves between the prompt and the tap, and the human signs the head they were SHOWN.

   checkpoint-key-unknown is a REFUSAL rather than a warning, and it is the load-bearing choice. If an unlisted fingerprint were merely skipped, a forger could neutralise the whole mechanism by rewriting each checkpoint's key_sha256 to name a key nobody carries. The cost is real and named in the message and the docs: retiring a key out of audit.checkpoint_keys de-verifies every checkpoint it signed. APRV-257's rotation verb refuses to drop a key that signed anything.

   Three things are deliberately not refusals: no configured key is a SKIP naming why and naming how many records went unchecked (never a pass); a signed seq below the walked range is counted and named; a lapsed cadence is a WARNING.

5. THE CADENCE. audit.checkpoint_every, a duration, absent = off. Parsed in policy-load beside skew_tolerance (one parse, one number, an unparseable value fails the whole policy rather than being quietly unread). REPORT-ONLY at every layer: there is no path anywhere in this runtime from due to refused. A human who has been away is not tampering, and a gate that refused a log for want of a tap is a gate whose operator turns the check off. In this half the cadence only produces a warning on the verify verdict and a checkpoint-due daemon warning; APRV-257 makes the daemon ENQUEUE a prompt from it.

6. HOW THIS RELATES TO APRV-219's ANCHOR. Two independent witnesses, and NEITHER IS WEAKENED. The anchor asks 'does anybody else hold a copy of these bytes?' and answers from git, so it is exactly as fresh as the last push and says nothing at all (a skip) on a machine with no remote. A checkpoint asks 'did a key no agent process holds sign this head?' and answers from the log plus the policy, so it works offline and covers the window nobody has pushed yet. Against the §3 forger they fail in different directions, which is the point of having both: the anchor catches a truncation whose records somebody else already holds, and a checkpoint catches one inside the unpushed window, because every checkpoint in the rewritten range names a hash the rewritten chain does not carry and the forger cannot sign the hashes they DID recompute. approval log verify runs the two independently, --anchor and --checkpoints are separate flags, and a skip on one never excuses the other. The daemon runs both on the same full re-proof cadence, the checkpoint check immediately after the anchor, before any sweep that appends.

=== WHAT SHIPPED ===

src/core/checkpoint.ts (the whole primitive), src/cli/log-checkpoint.ts (the verb's edge and the custody decision), the schema and policy-schema changes, policy-load's checkpointEveryMs, verify.ts's isGateTyped, command-class's approval-log-checkpoint row (policy.core, human-only; mints no new class, §11.1 inv. 9), main.ts's --checkpoints, daemon.ts's per-full-re-proof check with a distinct checkpoint-invalid outcome at EXIT_INTEGRITY and a checkpoint-due warning, docs/cli-reference.md (two new sections), conformance.

INVARIANT PATHS TOUCHED (SPEC §11.1). inv. 1: the check takes already-verified records and never walks a chain itself. inv. 2: log.checkpoint is gate-typed and the append takes no ts parameter at all. inv. 3: no raw secret reaches the log; the record carries a fingerprint of a PUBLIC key. inv. 5: the append reads the head and writes with it as expectedHead, so a concurrent append is head-moved and nothing partial lands. inv. 6: a new closed union, pinned in tests/log-checkpoint.test.ts and in the conformance vectors. inv. 7: key_sha256 is self-reported and reduces nothing; the policy is the authority. inv. 9: the verb classifies to an EXISTING human-only class and mints no authority.

CONFORMANCE. refusal-unions 8.0.0 (up from 7.0.0): a SEVENTH union, checkpoint_refusal_codes. MAJOR because that suite pins WHICH unions exist as well as what each holds. schema-validation 1.5.0 (up from 1.4.0): the five log.checkpoint event fixtures and the two policy fixtures are new vectors and no expectation moved. conformance/README.md's table and version history updated; manifest re-pinned. Regenerated the documented way (npm run build && node scripts/regen-conformance-vectors.mjs), and the diff is additive only.

=== FOR THE ORCHESTRATOR TO APPLY UNDER A GRANT (AC #5) ===

SPEC.md is protected and this agent did not edit it. Two changes.

(1) THE UNION ROW, §11.1 invariant 6. APRV-219 left it reading '... for the open window's verbs tests/gate-window.test.ts, and for the log-anchoring check tests/log-anchor.test.ts). (Amended APRV-214, pending sign-off. The anchoring union is APRV-219.)' Replace the tail so it reads '... for the log-anchoring check tests/log-anchor.test.ts, and for the human-signed checkpoint check tests/log-checkpoint.test.ts). (Amended APRV-214, pending sign-off. The anchoring union is APRV-219, the checkpoint union APRV-220.)'

(2) THE CHECKPOINT SENTENCE, for §9 beside APRV-219's anchoring sentence. Exact text:

'A human MAY sign the chain head at a moment with a key the runtime holds no copy of, recording the signature and the (seq, hash) it covers as a log.checkpoint event whose actor MUST be human and whose timestamp is stamped at the write boundary. A runtime that offers the check MUST verify every checkpoint inside a walked range against a public key the policy declares rather than against any key the record carries, MUST report a checkpoint whose signature does not validate, whose key the policy does not declare, or whose named hash is not the hash at that seq as a distinct refusal (checkpoint-signature-invalid, checkpoint-key-unknown and checkpoint-hash-mismatch in the reference runtime), MUST report the absence of any declared key as a skip naming that rather than as a pass, and MUST NOT treat a log carrying no checkpoint, or a checkpoint cadence that has lapsed, as a refusal: a person who has not signed recently is not evidence of tampering. Checkpoints and version-control anchoring (APRV-219) are independent witnesses against the same party, and a runtime offering both MUST NOT let either one skip excuse the other. (Added APRV-220.)'

=== NOT DONE, DELIBERATELY ===

AC #4 (the channel tap) is APRV-257. approval doctor gains no checkpoint row here; that is APRV-257 too, and log verify --checkpoints plus the daemon cover AC #3's two named surfaces. approval setup mints no key yet: an operator generates one with mintCheckpointKeypair and stores it, which is APRV-257's ceremony. The verb's key-file path is what makes this half testable and usable in the meantime.
<!-- SECTION:NOTES:END -->
