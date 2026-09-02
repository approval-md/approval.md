---
id: APRV-240
title: >-
  Human-to-agent signals: docs, AGENTS.md importer values draft, session ritual,
  and this repo's own values block
status: To Do
assignee: []
created_date: '2026-09-02 20:46'
labels:
  - welfare
  - docs
dependencies:
  - APRV-238
  - APRV-239
ordinal: 195000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Close the loop on APRV-237/238/239. The AGENTS.md importer learns to draft a values block: parseValuesHeadings recognises "what i value", "what good looks like", "how i like to work", "what i want from you" and places every bullet in `wants` only (grading is the human's act, an importer must not guess it); `import agents-md` prints the draft fence after the policy draft and --json gains values_draft. CLAUDE.md and AGENTS.md tell agents to run `approval values` and `approval feedback` at session start (no SessionStart hook; docs/integrations-considered.md:132). docs/cli-reference.md gains the ## values and ## feedback sections with the reasoning. A docs/proposals/repo-values-block.md carries the exact block for Carter to paste into APPROVAL.md by hand, since agents cannot edit it (policy.core), with the warning that the file is hashed whole and the standing attestation must be renewed immediately after pasting. Depends on APRV-238 and APRV-239.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 parseValuesHeadings recognises the four headings (normalised, any level) and collects bullets into wants only; nothing is ever placed in love/like/dislike
- [ ] #2 renderFencedValuesDraft emits a commented draft fence; `approval import agents-md` prints it after the policy draft when such a heading exists; --json gains values_draft: string|null with the registry output schema updated
- [ ] #3 tests/agents-md.test.ts and tests/cli-import.test.ts cover headings found, no headings (values_draft null), bullets inside fenced blocks ignored, and the emitted draft validating against values.schema.json
- [ ] #4 CLAUDE.md and AGENTS.md instruct agents to run `approval values` and `approval feedback` at session start and state that neither is policy; no SessionStart hook is added
- [ ] #5 docs/cli-reference.md ## values and ## feedback sections carry the reasoning: why absence is a declaration, why values stays out of the enforcement trace, why feedback is top-level
- [ ] #6 docs/proposals/repo-values-block.md holds the paste-by-hand block for this repo with the re-attest warning; agents do not write APPROVAL.md
- [ ] #7 tests/dogfood.test.ts passes with the values block present, verified against a scratch copy of APPROVAL.md and never by writing to the real file
<!-- AC:END -->
