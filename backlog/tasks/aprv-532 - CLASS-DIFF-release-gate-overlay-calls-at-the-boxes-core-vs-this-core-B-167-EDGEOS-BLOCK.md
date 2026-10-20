---
id: APRV-532
title: >-
  CLASS-DIFF release gate: overlay calls at the boxes' core vs this core (B-167,
  EDGEOS-BLOCK)
status: In Progress
assignee: []
created_date: '2026-10-20 11:10'
updated_date: '2026-10-20 23:05'
labels:
  - release
  - ci
  - edgeos-block
dependencies: []
references:
  - approval-md#663
priority: high
ordinal: 405000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Lead ruling CLAIMS L15681 (1), Carter P0: a core version reaches boxes only after a conformance check classifies the whole shipped overlay corpus at the candidate core and the GATE line carries the class-diff (every call whose class changes); an existing recipe flipping auto -> human-only (or to a deny) is blocking. Builds on APRV-530 D (approval.md#663): extends scripts/overlay-recipes-check.mjs with --diff and the overlay-recipes CI job; the overlay runs the same script at its pin (Edge-City/agentvillage companion PR).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 --diff <baseline core> classifies the same corpus (recipes + template tools lines) at both cores and reports every call whose class, decision or card style moves
- [ ] #2 An existing call moving from auto/sampled/card to human-only/refused fails, unless the allowlist names it with a reason (optional flip narrows it)
- [ ] #3 New calls (with --baseline-corpus) are reported, not gated
- [ ] #4 The overlay-recipes job re-extracts the corpus at its pinned overlay sha and fails on drift, installs the boxes' core from npm at pinned integrity, and publishes markdown + JSON report
- [ ] #5 Fixture tests: a flip fails, a stay passes, a new recipe is reported; 0.4.5 -> 0.4.6 on overlay 99d33417 shows the eleven EdgeOS flips
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Fold 1 (review-b refute 3M/4S/4N): the diff and a new absolute box check run every call through each core's real approval hook hermes in a box layout (scripts/overlay-recipes-box.mjs): recipes at HERMES_HOME, HOME, workspace, unset; harness calls as Hermes envelopes (core tools + every tools line); shadowed tools lines block. S-4: any loss of autonomy on an existing call blocks. M-3: allowlist entries need accepted_by/accepted_at (Carter), trivial reasons refused, ci.yml pins the gate files by sha256 and the corpus count, base-branch extractor. Proposed for Carter (not done: agents may not edit APPROVAL.md): protected_paths entries for scripts/overlay-recipes*. A hook run exiting 0 without an allow line is an error (found: a symlinked tmpdir made the CLI skip main). Allowlist entries ship unaccepted, so the job is red until Carter accepts them.

Fold 2 (review-b recheck 0M/1S/2N, owner delta L16259): carded calls now keep their class: runBox reads task.registered/approval.requested from each box store log keyed by task hook:class-diff:<tool_use_id>, so live_rate 0.1->1.0, supervised-live->manual and minimal->technical card each block (fail-before rc 0 at bc1a7c8a, rc 1 now; no-op control rc 0). A minimal->technical card on a running call is blocking. Fixed sampling value exported when the template names audit.sampling_secret_env (today it names none: every live call cards, as on a box). N-6: one store per worker; 10 runs at concurrency 4 with 58 cards each: 10/10 rc 0, 0 append-failed. Rulings: agent-plaza entry reason per approval L16259, scope any; README '*' entries state the 63-recipe pin. Deferred to the rebase round: delete the 11 EdgeOS entries and move the baseline to npm 0.4.7.

Fold 3 (review-b recheck of bd75c4a6, 0M/1S/2N): S-5, a card whose request runBox could not find read as a card of no class (fail open once a core renames task ids). Now bindRequest takes the request key from the hook-timeout deny (else matches tool and command among what the call appended to its own store), requires one task whose every action is this call's, and a card left unbound is verdict error (card-request-unbound), so the gate exits 2. Renamed (both or head only) and swapped task ids now read correctly; a deny naming a key the store lacks exits 2 (tests; mutant: dropping the error makes it PASS none). N-7: audit.sampling_secret_env naming HOME/HERMES_HOME/PATH/APPROVAL_*/NODE_* is refused (exit 2), and the layout keys are spread last. N-8: the minimal->technical rule also compares per class (decideBoxCall keeps styles per class). Touches the fail-closed invariant (strengthens it).

Fold 5 (review-b recheck of 6f752ab8, 0M/0S/5N; lead: fold N-10 + N-9): N-10, decideInBox makes a hook-timeout card whose bound request names no class that needs a human (no class ranks below supervised-retro) verdict error card-request-no-human-class, so the gate exits 2 (box test with a planted core logging read.web: fail-before rc 0 none). N-9, bindRequest: a call that appended a request of its own binds only the rows it appended; a deny naming another call's key exits 2 (box test xsame: fail-before rc 0 none); an adoption (appended nothing) still binds by key. N-11 (owner N1): when every old class was minimal, a class new to the card at another style blocks (newlyNotMinimal). N-13: pure tests kill review-b's surviving mutants MU8, MU9, MU11. N-12 left (fail-closed, keys with a backslash or quote arrive JSON-escaped, exit 2). The 11 EdgeOS allowlist entries stay in approval.md until the rebase over 0.4.7 (ruling 1): this PR's CI build is pre-#666 and the corpus pin fd30cd7b still ships the curls, so they are still used. Touches the fail-closed invariant (strengthens it).

Fold 6 (review-b recheck of 2502bc44, 0M/0S/3N; lead: fold N-15): core keys every action <task>:<cls> (hook.ts actionKey; an adopted key is an earlier request of the same class). bindRequest reports the bound task rows whose key is not their own task and class (mislabeled); decideInBox makes a hook-timeout card with any such row verdict error card-request-class-mismatch, so the gate exits 2. This runs after the N-10 check, so a no-human class still reads card-request-no-human-class. Box test with review-b C4 (both cores log digest.share, which needs a human, while carding on network.call, plus a real minimal -> technical move): fail-before rc 0 none, now rc 2. Non-card calls are unchanged. Full fd30cd7b corpus (304 calls, conc 4): network.call manual and default template both rc 0 none, no false error. N-14 (adoption across workdirs) and N-16 (a class newly carded on a mixed card is changed) noted, not built. Touches the fail-closed invariant (strengthens it).
<!-- SECTION:NOTES:END -->
