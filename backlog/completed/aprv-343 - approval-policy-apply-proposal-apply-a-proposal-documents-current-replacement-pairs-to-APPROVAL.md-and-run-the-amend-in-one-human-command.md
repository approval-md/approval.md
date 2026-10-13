---
id: APRV-343
title: >-
  approval policy apply <proposal>: apply a proposal document's
  current/replacement pairs to APPROVAL.md and run the amend in one human
  command
status: Done
assignee:
  - '@opus-lane-ergonomics'
created_date: '2026-09-16 17:59'
updated_date: '2026-09-17 01:26'
labels:
  - cli
  - policy
  - design
  - ergonomics
dependencies: []
priority: medium
ordinal: 261000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Agents may not edit APPROVAL.md (policy.core), so policy changes travel as proposal documents under docs/proposals/ that quote each current line byte for byte with its replacement (docs/proposals/approval-md-2026-09.md is the shape: sections per task, Current and Replace-with fenced pairs, a later section may supersede an earlier one). On 2026-09-16 the human applied one by copying a prepared file over APPROVAL.md and running approval policy amend. Design and build a human-only verb, approval policy apply <proposal.md>, that parses the pairs, refuses before touching anything when any Current block does not occur exactly once in the live file (so a stale proposal cannot half-apply), applies the replacements in order with explicit supersession, shows the resulting diff, and on confirmation runs the amend (and its --pr once APRV-341 exists). The proposal format becomes a documented contract that agents write to and the verb reads; APRV-273's wrapper-fence hazard is handled by parsing only fenced blocks with a declared language. Open design questions to settle in the task: how supersession is declared, whether the verb also accepts a whole-file replacement, and how the values block (inert, SPEC 5.3) is treated identically to the policy block by the applier. Related: APRV-273, APRV-334, APRV-341.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The proposal-document format is specified in docs (fenced Current and Replace-with pairs, ordering, supersession) and a fixture proposal exists
- [x] #2 approval policy apply refuses with a machine-readable code, writing nothing, when any Current block is absent or not unique in the live file; otherwise it applies all pairs and prints the diff
- [x] #3 The verb is policy.core: it refuses under an agent and runs the amend for a human after confirmation
- [x] #4 Tests cover a clean apply, a stale pair, a superseding pair, and a wrapper-fenced proposal; docs/cli-reference.md and docs/proposals/README (or equivalent) describe the flow
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. New module policy-apply.ts with a fence scanner that matches closers of at least the opener's backtick run and ignores any opener with no info string, so a four-backtick wrapper carries a three-backtick block as content and an undeclared fence is skipped. APRV-273 becomes a parser rule rather than a warning.

2. Pairs are fenced blocks labelled on the line above: Current, Replace with, and an optional Supersedes. Every pair resolves against an in-memory copy in document order before a byte is written, so a stale pair anywhere refuses and writes nothing.

3. Human-only twice: an agent identity refuses apply-agent-actor in the verb, and refineApprovalVerb classifies approval policy apply as policy.core, which mints no class. Then the verb prints the replacements, confirms, writes, and calls the amend in-process, passing --pr through.

4. Fixtures under tests-fixtures-proposals plus a proposals README describing the contract, the cli reference gains a policy apply section, and a new suite drives the built verb.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
THE THREE OPEN DESIGN QUESTIONS, settled. (1) Supersession is DECLARED, by a third block labelled Supersedes whose content is the earlier section's replacement, and never inferred from position. The applier looks for that text when the section's own Current block is no longer in the file, which is exactly the state the earlier section left behind. Position could not carry it: two sections that touch one line are not in general in the order the file needs, and a rule inferred from order is a rule nobody can read off the page. Both texts present at once is proposal-ambiguous.

(2) Whole-file replacement is NOT accepted, and that is the decision rather than an omission. The verb's whole value is that every byte it writes is anchored to a byte it proved present, which is what turns a stale proposal into a refusal instead of a silent revert of somebody else's amendment. A whole-file blob has no anchor, and policy amend over a hand-edited file is already the supported way to replace the file deliberately.

(3) The values block is treated IDENTICALLY to the policy block, by knowing nothing about either. The applier is a byte-level replacement over the whole file: it does not parse the policy, does not locate blocks, and does not care which fence a pair lands in. The values block is inert under SPEC 11.1 invariant 10, so applying one changes no verdict, and the attestation the amendment appends covers the whole file's bytes either way.

SPEC 11.1 invariant 9 touched and not weakened: the verb mints NO class. policy.core already exists and already covers the policy's own machinery, and refineApprovalVerb routes approval policy apply to it exactly as it routes gate open and log checkpoint. Invariant 6 holds too: nine refusal codes, each distinct by repair. No SPEC amendment is required, on the policy amend precedent: SPEC 10.1's CLI block does not list attest or amend either, and APRV-109's amendment says in terms that the block gains no verb. Flagging that reading rather than editing SPEC.

The human-only lock is doubled deliberately. The classifier row denies an agent through a harness hook; the verb's own apply-agent-actor refusal denies one in a harness that has no hook. A lock that exists only in the classifier is a lock a session without the hook does not have.

Verification: node scripts-run-tests --only cli-policy-apply is 17 tests, 17 pass, 0 fail, exit 0. Three fence cases pin the APRV-273 rules; the clean apply writes both pairs and leaves the unlabelled bash block out; the stale case proves the FIRST pair is not written either; the superseding case ends with one network.call line carrying the corrected comment and the new autonomy; the wrapper-fenced case leaves no four-backtick run in the policy and exactly one values fence; an agent identity, a missing proposal, a missing confirmation and an undeclared fence each refuse with their own code and change nothing; --dry-run prints the diff and writes nothing; and the handover case proves the amend runs and the stderr sentence names what is owed when it fails. A run over command-class, command-class-routing, classify-tier, cli-hook and cli-coverage is 628 tests, 628 pass, 0 fail, exit 0; cli-help, cli-long-help, cli-instructions and docs-guard are 64 pass, 0 fail. Build, typecheck and lint exit 0.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
approval policy apply <proposal.md> parses a proposal document's labelled Current and Replace-with pairs, resolves every one of them against an in-memory copy before a byte is written, prints the replacements, confirms, writes, and runs the amendment in the same process. Human-only twice: the verb refuses an agent identity with apply-agent-actor and the command classifies policy.core, minting no class. Fences are read by their backtick run and an undeclared fence is skipped, so APRV-273's wrapper hazard is a parser rule. The three open design questions are settled in the notes and in the docs: supersession is declared by its own block, whole-file replacement is refused, and the values block is treated identically to the policy block. Verified by 17 cases driving the built verb: 17 pass, 0 fail, exit 0.
<!-- SECTION:FINAL_SUMMARY:END -->
