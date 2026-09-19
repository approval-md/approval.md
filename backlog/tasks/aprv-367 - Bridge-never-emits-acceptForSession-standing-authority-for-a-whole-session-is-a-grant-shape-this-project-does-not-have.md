---
id: APRV-367
title: >-
  Bridge never emits acceptForSession: standing authority for a whole session is
  a grant shape this project does not have
status: Done
assignee:
  - '@claude'
created_date: '2026-09-18 01:30'
updated_date: '2026-09-19 14:02'
labels:
  - codex
  - bridge
dependencies:
  - APRV-361
priority: medium
ordinal: 284000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From docs/codex-app-server-bridge.md follow-up 7 (APRV-349). The decision vocabulary includes acceptForSession, which converts one human decision into standing authority for the rest of the session, and cancel or abort, which stop the turn rather than deny the action. The bridge answers accept and decline only. This task pins that: a policy or channel decision that would map to acceptForSession is refused with its own code, and cancel is never sent as a stand-in for a denial. The probe already holds this rule in its own source; the bridge and its conformance vectors must too.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The reply encoder can produce accept and decline only; any other value is a type error and a refusal at runtime
- [x] #2 Conformance vectors pin the two-word vocabulary
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. The encoder today returns decision: string, so the closed accept/decline lists live in the source and in nothing else: a refactor could put any word on the wire and nothing but a code reading would catch it. Give the words types (BridgeAcceptWord, BridgeDeclineWord, BridgeDecisionWord as the union of ACCEPT_WORDS and DECLINE_WORDS) and have chooseDecision return the CANONICAL word rather than the server spelling of it, so the value that reaches the wire has a type whose whole inhabitant list is the eight words. The match stays case-insensitive and exact-never-prefix, so the only behaviour difference is letter case on a server that advertises Accept rather than accept.
2. encodeDecision(word) is the ONE place a decision becomes a reply payload. It re-checks membership at runtime and answers null for anything else, which types make unconstructible; the call site answers a null by sending the canonical decline instead. No new refusal code for it: the only safe substitute for a word this runtime cannot name is no, and minting a code for a branch no input can reach would put a string in a conformance union that a second implementation cannot exercise.
3. acceptForSession, acceptWithExecpolicyAmendment, cancel and abort are never in either list, so they can be neither chosen nor encoded. The existing prefix test stays and gains a sibling for the decline side (cancel and abort advertised, decline sent).
4. AC2, conformance: a new suite file bridge-decisions.v1.json with its own executor, rather than more entries in refusal-unions, because what AC2 asks to pin is a BEHAVIOUR (given an advertised list and an outcome, which word goes on the wire) and refusal-unions pins arrays of codes. Vectors: the advertised accept and decline, the fallback when only acceptForSession or only cancel is offered, the legacy approved/denied spellings, an empty advertisement, and one negative control whose outcome is acceptForSession, which the executor must refuse with unknown-outcome rather than answer.
5. Regenerate with scripts/regen-conformance-vectors.mjs (the manifest pins every vector file digest), then node conformance/run.mjs and npm test, which cross-checks counts and digests.
6. Docs: the bridge section of docs/cli-reference.md and the vocabulary paragraph of docs/codex-app-server-bridge.md say the two words are typed and re-checked at the send boundary; conformance/README.md gains the suite row.
7. build, typecheck, lint, codex-bridge and conformance suites, npm test.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
DONE 2026-09-19 by lane 4, branch lane/bridge-two-words-367.

WHAT CHANGED. The reply vocabulary is a TYPE. ACCEPT_WORDS and DECLINE_WORDS are exported, BridgeDecisionWord is their union (eight spellings of two words), BridgeOutcome is accept or decline, and BridgeAnswer.decision carries the union rather than string, so a report row saying acceptForSession cannot be constructed. encodeDecision is the one place a decision becomes a reply payload and re-checks membership at runtime; the send site treats a null as a decline. chooseDecision now returns this runtime OWN spelling of the matched word rather than the server spelling of it, which is what lets the value have the closed type at all.

THE ONE BEHAVIOUR CHANGE, and it is small: a server advertising Accept with a capital A is still matched (the match was always case-insensitive) and now receives accept. Before, its own capitalisation went back. Nothing in the observed protocol advertises a capitalised word, and the alternative was a type that admitted any string, which is the thing this task exists to remove. A test drives the real CLI against a stub advertising Accept and asserts the wire value.

NO NEW REFUSAL CODE, deliberately. An unencodable word is unreachable while the types hold, and a code in a closed union that no input can produce is a string a second implementation cannot exercise and would have to take on trust. The fail-closed answer is a decline, stated in the header and at the call site.

AC2, and the choice it needed. The vectors went into a NEW suite, conformance/vectors/bridge-decisions.v1.json (10 vectors, one negative control), with its own executor in tests/conformance-harness.ts, rather than into refusal-unions. What AC2 asks to pin is a behaviour (given an advertised list and an outcome, which word goes on the wire and whether it came from the advertisement), and refusal-unions pins arrays of codes under the algorithm line of SPEC section 11.1 invariant 6. Two vectors are the ones a PREFIX matcher fails (acceptForSession offered alone, cancel and abort offered alone), which is the rule this task is really about. The negative control names a third outcome and must be refused with unknown-outcome, so a runner that answered it would be describing a client that can mean more than accept and decline. The manifest pins the new file digest; every expectation is computed by the generator, never transcribed.

INVARIANTS. Nothing in SPEC section 11 is weakened. Self-reported fields never reduce scrutiny: the server availableDecisions list can only select among words this runtime already named, and cannot introduce one. Fail closed: the substitute for an unnameable word is a decline. No schema change, no new event, no policy surface.

VERIFICATION. build, typecheck, lint clean. node --test dist/tests/codex-bridge.test.js: 17 tests, 17 pass, exit 0 (three new). npm run conformance: 390 vectors, 390 pass, 161 controls, manifest ok. npm test: 4713 tests, 4690 pass, 22 fail, exit 1, the same pre-existing Node v26 SMTP and email adapter failures, none of them touched here.

ALSO IN THIS COMMIT: the orchestrator ruling of 2026-09-19 on APRV-366 residual, written into APRV-364 plan and notes (the preflight probe that confirms the untrusted pin by observation when the server echoes no policy). It is recorded there rather than implemented here, on the orchestrator instruction to keep it out of this task.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The bridge two-word reply vocabulary is now carried by the type system and by a conformance suite rather than by a closed list in one source file. Every reply word is a BridgeDecisionWord (four spellings of yes, four of no), encodeDecision is the single place a decision becomes bytes and re-checks membership at runtime, and a word that failed that check would be sent as a decline. acceptForSession, acceptWithExecpolicyAmendment, cancel and abort are therefore unsendable by construction as well as by the matching rule. Verified by three new cases in tests/codex-bridge.test.ts (the decline-side fallback when only cancel and abort are advertised, the encoder round trip over all eight words and its refusal of six others, and a real CLI run against a stub advertising a capitalised spelling) and by the new bridge-decisions conformance suite, 10 vectors with one negative control, which a prefix-matching client fails on two of them. npm run conformance: 390 vectors, 390 pass, manifest ok.
<!-- SECTION:FINAL_SUMMARY:END -->
