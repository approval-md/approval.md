---
id: APRV-370
title: >-
  Sender mapping accepts a hashed id, so a public policy and a public log never
  carry the raw Telegram account id
status: Done
assignee:
  - '@claude'
created_date: '2026-09-18 06:20'
updated_date: '2026-09-19 21:16'
labels:
  - channel
  - telegram
  - privacy
dependencies: []
priority: medium
ordinal: 287000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Raised by the operator on 2026-09-18 while applying the sender line (APRV-324): approvers.<id>.senders.telegram takes the raw numeric callback_query.from.id, and once applied every approval.granted, approval.rejected and audit.decision_refused record carries payload.sender.id too. On a public repository that publishes both the policy and the log (this one), the account id is disclosed once in APPROVAL.md and then on every phone decision. The id is an identifier rather than a credential and the gate does not depend on its secrecy (the transport authenticates the tap), so this is a disclosure question, not a security hole. Proposal: accept senders.telegram as either the raw id or sha256:<hex of the id string>; the channel hashes the observed from.id before comparing when the mapping is hashed; decision records carry the same form the policy uses (a hashed mapping records the digest as payload.sender.id with an explicit payload.sender.hashed true, or a sibling field, so a reader can still correlate taps to one account without learning it). The refusal record for an unmapped sender must still carry the observed id in hashed form only when the policy is hashed. Docs: docs/proposals/sender-identity-2026-09.md and the sender-mapping doctor row explain both forms. Migration: this repository re-amends to the hashed form; git history keeps the raw id and that is stated rather than rewritten.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 senders.<channel> accepts sha256:<hex> and the channel matches a hashed observed id against it; raw ids keep working
- [x] #2 Decision and refusal records under a hashed mapping carry the digest and never the raw id; a schema change for the new field is its own task if one is needed
- [x] #3 approval doctor sender-mapping reports which form is in use; docs updated
- [ ] #4 This repository policy is re-amended to the hashed form by the operator and one live approve carries the digest
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
0. THE RULING (Carter, 2026-09-19): option (b), a KEYED hash, not plain sha256. Telegram ids are ten-digit numbers and an unsalted sha256 is brute-forced in minutes, so the digest must be unguessable without an operator-held key.

1. src/core/sender-identity.ts, the form. SENDER_HASH_PREFIX = hmac-sha256: ; isHashedSenderMapping(value); hashedSenderId(key, id) = the prefix plus HMAC-SHA256(key, id) in hex, computed exactly the way core/sampler.ts computes its selection value, so one keyed-digest idiom lives in this runtime rather than two. SENDER_KEY_ENV = APPROVAL_SENDER_KEY; senderKeyFrom(env) returns the value or null.

2. Why the env variable is NOT named in the policy, unlike audit.sampling_secret_env: the sampling secret is named there because the POLICY decides whether sampling happens at all, and a policy naming none turns it off. Here the mapping value form decides, so the policy already says everything it needs to and a second declaration would be a second place for one fact to be wrong. Per-instance isolation comes from the env FILE beside the log, which is where the sampling secret gets it too.

3. resolveSender gains a third parameter, the key or null, DEFAULTING TO NULL. A default of null is fail-closed: a caller that has not been taught about the key refuses every keyed mapping rather than falling back to a raw comparison. actorForSender gains the same. The four real call sites (channels/contract.ts three, cli/channel-telegram.ts one) pass senderKeyFrom(process.env).

4. The fail-closed rule, and it comes FIRST, before any comparison. If any mapping value for the observed channel is keyed and no key resolves, the tap is refused under a new code sender-key-unavailable naming APPROVAL_SENDER_KEY. Not just the keyed entries: the runtime cannot run the ambiguity check over a roster half of which it cannot evaluate, and SPEC section 11.1 resolves ambiguity to the stricter path.

5. Matching. The index stays keyed on the literal policy value. At lookup the observed id is compared as the raw string AND, when a key resolves, as its keyed digest. A raw entry and a keyed entry can never collide (a digest carries the prefix and a raw id is digits), so this widens nothing.

6. Recording. A new RecordedSender with channel, id and an optional hashed true: under a keyed mapping the recorded id is the prefixed digest, which is exactly the string the policy carries, so an operator can grep one for the other and an unmapped refusal hands them a line they can paste. Under a raw mapping nothing changes and the record is byte-identical to today. resolveSender returns the RECORDED form on every non-configured outcome, so no caller has to know the rule.

7. schema/policy.schema.json: the senders.telegram pattern widens to accept digits or the prefixed 64-hex digest. schema/event.schema.json: the sender object gains an optional hashed true in all four places it appears (decision, attestation and review, audit.decision_refused, audit.gesture_refused), with a conditional pinning id to the digest form whenever hashed is true so the boolean and the string cannot disagree; and the two code enums gain sender-key-unavailable. Fixtures under schema/fixtures and conformance vectors regenerated; refusal-unions channel_decision_refusal_codes grows, so that suite bumps major.

8. src/cli/setup.ts: approval setup sender-key. Bare, it is HUMAN-ONLY and interactive and the same shape as setup sampling: mint 32 random bytes through context.generate, store in the keystore under an instance-scoped service name, write APPROVAL_SENDER_KEY into the env file, print the ceremony. With --id it mints NOTHING: it reads the key from the environment and prints the exact policy pair (the senders line and the replacement block a proposal page carries), which is the printed helper Carter needs and is why the proposal page does not carry a placeholder he fills by hand. The --id path needs no terminal and no human flag: it stores nothing and prints no secret.

9. src/cli/doctor.ts sender-mapping row says which form each mapped channel is in (raw, keyed, or mixed) and, for a keyed one, whether the key resolves. Keyed with no key is a FAIL: every tap on that channel is refused.

10. docs/proposals/sender-identity-hashed-2026-09.md, the byte-anchored page Carter applies, whose Current block is the live APPROVAL.md approvers block (the raw id is already applied there) and whose Replace with block is the keyed form. It states that the operator runs approval setup sender-key first, then the --id helper to get the exact line, and that git history keeps the raw id and is not rewritten. docs/cli-reference.md gets the verb; the 2026-09 proposal page gets a line saying it is applied and what supersedes it.

11. AC4 (re-amend this repository, one live approve) stays Carter. It is left unticked and the runbook goes in the notes.

12. build, typecheck, lint, npm test, npm run conformance.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
WHAT WAS BUILT (lane, 2026-09-19), on Carter ruling of the same day: option (b), a KEYED hash.

THE FORM. senders.telegram accepts the raw decimal id (unchanged) or hmac-sha256:<64 lowercase hex>, the HMAC-SHA-256 of that same decimal string under an operator-held key. Computed the way core/sampler.ts computes its selection value, so this runtime has one keyed-digest idiom rather than two. NOTE ON AC1 WORDING: the criterion says sha256:<hex>; what was built is hmac-sha256:<hex>, because an unsalted sha256 of a ten-digit number is brute-forced in minutes and would state a privacy property it does not have. That is Carter ruling, recorded here so the divergence from the written criterion is visible rather than silent.

THE KEY. APPROVAL_SENDER_KEY, a CONVENTIONAL env name, read from the launch environment and never from the policy. This is the one place the shape diverges from setup sampling, and the reason is recorded in the code: the policy names audit.sampling_secret_env because the POLICY decides whether sampling happens at all, and a policy naming none turns it off. Here the mapping value form decides, so the policy already says everything it needs to and a second declaration would be a second place for one fact to be wrong. Per-instance isolation comes from the env FILE beside the log, exactly as it does for the sampling secret. No policy schema field was added for it.

FAIL CLOSED, and it comes FIRST. A channel with ANY keyed entry and no key in the process refuses EVERY decision on that channel under a new code sender-key-unavailable, naming the variable. Not only the keyed entries: without the key the runtime can compute no digest, so it cannot check whether the observed account is also claimed by a keyed approver, which means it cannot run the ambiguity check the mapping rests on. There is no fallback to the raw comparison. resolveSender and actorForSender gained a key parameter DEFAULTING TO NULL, which makes the fail-closed direction the default for any caller not yet taught about it.

MATCHING. The index stays keyed on the literal policy value; the observed id is looked up as the raw string and, when a key resolves, as its keyed digest. The two forms cannot collide (a digest wears the prefix, a raw id is digits), so one policy can carry a migration in progress.

RECORDING, and one decision the plan did not anticipate. THE FORM FOLLOWS THE ENTRY THAT MATCHED, not the channel: a mixed policy records a keyed approver as a digest and a raw one as an id, on the same channel and in the same tap, so the id in the record is always the string that approver senders block carries and an operator can grep one for the other. Where NOTHING matched there is no entry to follow, so the channel decides and a keyed channel hashes: an unmapped account is the one a keyed deployment least wants written down, and the digest is also the line the operator would paste to map it. payload.sender gains hashed: true, present-and-true or absent, never false; a raw record is byte-identical to what every build since APRV-324 wrote.

THE FORM FOLLOWS THE FILE, THE MAPPING FOLLOWS THE ATTESTATION. Three refusals (log unreadable, policy not attested, attestation ladder) never reach the in-force mapping and still have to say who tried. recordedSenderFor honours the disclosure preference written in the policy file on disk even when that file is not in force, which grants nobody anything: the refusal is a refusal either way and the record names no approver. What must never follow an unattested file is who may decide, and that is resolveSender job against the policy in force.

THE VERB. approval setup sender-key. Bare: HUMAN-ONLY, interactive, same shape as setup sampling; mints 32 bytes through context.generate, stores as approval-sender-key-<instance>, writes APPROVAL_SENDER_KEY into .approval/env, edits no policy. With --id <account-id>: mints and stores NOTHING, reads the key from the environment, prints the hmac-sha256:<hex> and the senders line and a paste-ready proposal pair. --id needs no terminal, no human flag and accepts --json, because it stores nothing and prints a value designed to be published; a verb that refused to compute a public value without a TTY would be ceremony charged for nothing. That is what removes the placeholder from the proposal page.

DOCTOR. The sender-mapping row names the form per channel (raw, the keyed form, or both while a migration is in progress) and, for a keyed one, whether the key resolves. Keyed with no key is a FAIL with the mint-and-establish fix, because every tap on that channel is refused.

SCHEMA, called out in the PR body. policy.schema.json: the senders.telegram pattern widens to digits OR the prefixed 64-hex digest. event.schema.json: two new $defs (senderHashed, senderHashedImpliesDigest) and the optional hashed on the sender object in all four places it appears (decision, attestation and review, audit.decision_refused, audit.gesture_refused), with a conditional pinning id to the digest shape whenever hashed is true so the boolean and the string cannot disagree; the audit.gesture_refused code enum gains sender-key-unavailable. Six new fixtures: two valid events, one valid policy, and three refused (hashed true over a bare id, hashed false, and an UNKEYED sha256: mapping value). The three refusals were checked to fire for the right reason: schema-pattern at /payload/sender/id, schema-const at /payload/sender/hashed, schema-pattern on the policy value.

CONFORMANCE. refusal-unions 16.0.0 to 18.0.0 (channel_decision_refusal_codes grows, so major). 17.0.0 IS DELIBERATELY SKIPPED: APRV-379 lane bumped the same suite to 17.0.0 on its own branch in this session, and two branches naming one version for two vector sets is the collision conformance/README.md warns about; its rule is one above the highest either side saw. schema-validation 2.4.0 to 2.5.0 (minor: six new vectors, no expectation moves). npm run conformance 408/408, 170 controls.

SPEC.md, protected path, its own commit. Section 5.2 gains the keyed form and the whole-channel refusal rule; section 6.3 and 10.3 gain payload.sender.hashed and the rule that the recorded digest is the matched entry value; the section 11.2 refusal table gains the sender-key-unavailable row.

GLOBAL INVARIANTS (SPEC section 11.1). Invariant 4 (self-reported fields never reduce scrutiny) holds: the key is read from the process environment the operator launched, never from a message, and nothing the sender says about itself reaches the comparison. Invariant 1 (enforcement paths read only verified records) is untouched: no enforcement path reads the key or the hashed flag; the flag is a disclosure fact. Invariant 7 (refusals machine-readable and distinct) gains a member, pinned by the closed-vocabulary test, the schema enum and the conformance union. Ambiguity resolves to the stricter path, which is the whole reason the missing key refuses the channel rather than its keyed half.

VERIFICATION. build, typecheck, lint clean. npm run conformance 408/408. Full npm test: 4811 tests, 4788 pass, 22 fail, exit 1; all 22 are the pre-existing local SMTP suite on Node v26.8.2 (CI runs Node 22, and the same 22 fail on the APRV-379 branch in this session). tests/sender-identity.test.ts alone: 44 tests, 44 pass, exit 0, of which twelve are new APRV-370 cases including three end to end through the real Telegram callback path and the real append path.

AC4 IS CARTER, AND HERE IS THE RUNBOOK. It is left UNTICKED: re-amending this repository policy and taking one live approve on the phone is an act only the operator can perform, and the digest cannot be computed by any agent session because it depends on a secret only his machine holds.

Run all of this in the PRIMARY checkout, /Users/carter/dev/approval-md, in a terminal:

  approval setup sender-key
  eval "$(approval env)"
  approval setup sender-key --id 7345216485
  # paste the printed hmac-sha256:<hex> over <PASTE_THE_PRINTED_DIGEST>
  # in docs/proposals/sender-identity-hashed-2026-09.md, then:
  approval policy apply docs/proposals/sender-identity-hashed-2026-09.md

Then RESTART THE LISTENER from a shell that has the key, or the gate cannot be answered from the phone at all:

  # in the window running approval up: stop it, then
  eval "$(approval env)"
  approval up

Then check it:

  approval doctor          # sender-mapping should PASS and say: the keyed form (APPROVAL_SENDER_KEY)
  # one approve and one reject from the phone, then
  approval log verify
  approval log tail -n 5 --json   # the grant carries payload.sender.hashed true and the digest

THE FAILURE MODE TO EXPECT, and it is the reason the doctor row is a FAIL rather than a warning: a listener started from a shell that never ran eval "$(approval env)" holds no key, and every tap is refused sender-key-unavailable. A decision typed at a terminal carries no sender and still works, which is the way out of it. Rolling back is replacing the keyed value with the raw id and re-attesting; no code change and no log repair.

The proposal page carries all of the above plus what to do when the tap is refused sender-unmapped (the digest in the file is not the digest of that account under this key; the refusal record carries the digest that actually arrived, which is the value the file should have).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
senders.<channel> now accepts a KEYED digest, hmac-sha256:<hex>, beside the raw account id, so a published policy and a published log stop carrying the account. Carter ruled for the keyed form over a plain sha256 on 2026-09-19: a Telegram id is a ten-digit number and an unsalted digest of one is brute-forced in minutes. The key is an operator secret in APPROVAL_SENDER_KEY, minted and stored by a new HUMAN-ONLY approval setup sender-key, whose --id mode mints nothing and prints the exact mapping line and proposal pair for one account, which is the one step no agent can do. Decision and refusal records carry the digest as payload.sender.id with payload.sender.hashed true, in the form the MATCHED entry uses, so a mixed policy records each approver the way their own senders block is written and a reader can grep one for the other; a raw mapping records exactly what it always did. A keyed channel with no key in the process refuses EVERY decision on it under a new sender-key-unavailable naming the variable, never falling back to the raw comparison, because without the key the roster ambiguity check cannot be run at all. Doctor sender-mapping names the form and says whether the key resolves. Schema: the policy senders pattern widens, event payload.sender gains an optional hashed pinned by a conditional to the digest shape, the gesture-refusal code enum grows, and six fixtures cover both; refusal-unions 18.0.0 (17.0.0 skipped to avoid a collision with the APRV-379 lane), schema-validation 2.5.0, conformance 408/408. SPEC 5.2, 6.3/10.3 and the 11.2 refusal table amended in their own commit. Verified by twelve new cases in tests/sender-identity.test.ts, three of them end to end through the real Telegram callback and the real append path, asserting the account id is nowhere in the log; that suite is 44/44 exit 0, build, typecheck and lint clean, full npm test 4788/4811 with 22 pre-existing local SMTP failures on Node 26. AC4 is left unticked: re-amending this repository and taking one live approve is Carter, and the runbook is in the notes and in docs/proposals/sender-identity-hashed-2026-09.md.
<!-- SECTION:FINAL_SUMMARY:END -->
