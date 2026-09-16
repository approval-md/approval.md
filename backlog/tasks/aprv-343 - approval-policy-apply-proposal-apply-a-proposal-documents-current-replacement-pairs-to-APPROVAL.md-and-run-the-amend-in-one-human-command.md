---
id: APRV-343
title: >-
  approval policy apply <proposal>: apply a proposal document's
  current/replacement pairs to APPROVAL.md and run the amend in one human
  command
status: To Do
assignee: []
created_date: '2026-09-16 17:59'
updated_date: '2026-09-16 17:59'
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
- [ ] #1 The proposal-document format is specified in docs (fenced Current and Replace-with pairs, ordering, supersession) and a fixture proposal exists
- [ ] #2 approval policy apply refuses with a machine-readable code, writing nothing, when any Current block is absent or not unique in the live file; otherwise it applies all pairs and prints the diff
- [ ] #3 The verb is policy.core: it refuses under an agent and runs the amend for a human after confirmation
- [ ] #4 Tests cover a clean apply, a stale pair, a superseding pair, and a wrapper-fenced proposal; docs/cli-reference.md and docs/proposals/README (or equivalent) describe the flow
<!-- AC:END -->
