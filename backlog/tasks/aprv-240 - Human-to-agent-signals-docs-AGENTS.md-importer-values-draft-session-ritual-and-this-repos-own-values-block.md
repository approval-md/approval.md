---
id: APRV-240
title: >-
  Human-to-agent signals: docs, AGENTS.md importer values draft, session ritual,
  and this repo's own values block
status: In Progress
assignee:
  - '@opus-240'
created_date: '2026-09-02 20:46'
updated_date: '2026-09-04 23:00'
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
- [x] #1 parseValuesHeadings recognises the four headings (normalised, any level) and collects bullets into wants only; nothing is ever placed in love/like/dislike
- [x] #2 renderFencedValuesDraft emits a commented draft fence; `approval import agents-md` prints it after the policy draft when such a heading exists; --json gains values_draft: string|null with the registry output schema updated
- [x] #3 tests/agents-md.test.ts and tests/cli-import.test.ts cover headings found, no headings (values_draft null), bullets inside fenced blocks ignored, and the emitted draft validating against values.schema.json
- [ ] #4 CLAUDE.md and AGENTS.md instruct agents to run `approval values` and `approval feedback` at session start and state that neither is policy; no SessionStart hook is added
- [ ] #5 docs/cli-reference.md ## values and ## feedback sections carry the reasoning: why absence is a declaration, why values stays out of the enforcement trace, why feedback is top-level
- [ ] #6 docs/proposals/repo-values-block.md holds the paste-by-hand block for this repo with the re-attest warning; agents do not write APPROVAL.md
- [ ] #7 tests/dogfood.test.ts passes with the values block present, verified against a scratch copy of APPROVAL.md and never by writing to the real file
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
SCOPE OF THIS LANE: acceptance criteria 1 to 3 only (the importer half). ACs 4 to 7 (CLAUDE.md/AGENTS.md session ritual, docs/cli-reference.md sections, docs/proposals/repo-values-block.md, the dogfood test with the block present) are the orchestrator's docs half and are deliberately untouched here; this lane edits no doc, no APPROVAL.md, no .approval/.

1. src/core/agents-md.ts: add VALUES_HEADING_PHRASES ("what i value", "what good looks like", "how i like to work", "what i want from you") matched through the existing normaliseHeading with the same equality/prefix/containment tolerance sectionOf uses, at any heading level. Add parseValuesHeadings(markdown): a second line pass over the same primitives (FENCE_OPEN, HEADING, LIST_ITEM), so bullets inside fenced code blocks are skipped and continuation lines are joined exactly as the permissions scanner does. Every bullet lands in wants and nothing is graded: love/like/dislike stay empty because grading is the human's act and an importer that guessed a grade would put words in their mouth. Say that in the doc comment.

2. Caps, matching values.schema.json $defs/valueList: truncate an entry over 200 characters (code points, so a surrogate pair is never split) to 199 plus an ellipsis and warn, rather than refusing the draft, because the draft exists to be edited by hand and a visible truncated line is repairable while a refusal costs the human the other nineteen bullets; dedupe AFTER truncation, since uniqueItems is what the schema checks; keep at most 20 in wants and preserve the overflow as comments inside the fence, the same stance the permissions half takes for unmapped bullets. Nothing is ever dropped silently.

3. renderFencedValuesDraft(draft, source): a ```yaml approval-values fence built from VALUES_INFO_STRING imported from src/core/values.ts (the constant only; no loader parse path is imported into agents-md), carrying a leading YAML comment that it is a DRAFT imported from AGENTS.md, that it authorizes nothing, and that love/like/dislike are for the human to fill in, then version: 1 and wants: with JSON-quoted scalars.

4. importAgentsMd gains a values: ValuesDraft field and merges the values warnings into result.warnings so the CLI surfaces them. renderDraftPolicy and renderFencedDraft take an optional values draft. --out shape decision: with no values heading the file is today's bare policy YAML, byte-identical, so the three pinned expected.yaml fixtures do not move; when a values draft exists the file becomes the policy YAML inside its own approval-policy fence followed by the values fence, because a bare YAML file with a fenced block appended cannot be pasted into a policy fence (the values block's closing fence would close the policy block) and would load as neither. So written, the --out file loads directly through loadPolicy and through loadValuesText.

5. src/cli/import.ts: --json gains values_draft: string | null, appended after warnings. src/cli/verb-registry.ts: the import agents-md VerbSpec output schema gains values_draft as nullable(STRING) in properties and in required. Only that VerbSpec is edited (a sibling task is adding a feedback VerbSpec to the same file).

6. Tests: tests/fixtures/agents-md/ gains a fixture with the four headings (including bullets inside a fenced block that must not be collected, an over-long bullet, a duplicate, and one that is both a permissions file and a values file). tests/agents-md.test.ts covers heading recognition at any level, the fenced-block exclusion, wants-only placement with love/like/dislike absent, truncation, dedupe, the cap and overflow comments, determinism, and the emitted draft loading through loadValuesText with ok:true/present:true and the bullets in wants. tests/cli-import.test.ts covers values_draft non-null with headings, null without, the fence printed after the policy draft on stdout, and an --out file loading through loadPolicy with the values fence present. tests/cli-instructions.test.ts is re-run so the live --json still validates against the registry schema.

7. npm run build, node --test on the five affected suites, npm run lint, npm run typecheck.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
IMPORTER HALF (ACs 1-3) landed by @opus-240. ACs 4-7 are the docs half and are untouched here; this lane edited no doc, no APPROVAL.md, nothing under .approval/, and committed nothing.

FILES
- src/core/agents-md.ts: VALUES_HEADING_PHRASES, isValuesHeading, capLength, parseValuesHeadings, ValuesDraft, renderFencedValuesDraft, valuesDraftOf, hasValuesDraft; AgentsMdImport gains `values`; renderDraftPolicy and renderFencedDraft gain an optional values argument.
- src/cli/import.ts: --json gains values_draft, --out writes the two-block form, stdout prints the values fence after the policy fence, one extra stderr line when a values draft exists.
- src/cli/verb-registry.ts: the `import agents-md` VerbSpec output schema only (values_draft: nullable string, in properties and in required).
- tests/fixtures/agents-md/values-headings.md and .expected.md (new).
- tests/agents-md.test.ts, tests/cli-import.test.ts, tests/values-inert.test.ts.

DECISIONS
1. Wants only, nothing graded. Every bullet lands in wants and love/like/dislike are never written. The ValuesDraft type has one destination for bullets by construction, so grading is not a policy the renderer applies, it is a thing the parse result cannot express. Stated in the module header, in the parseValuesHeadings doc comment, in the emitted fence's own header, and on stderr.
2. Over-long bullets are TRUNCATED, not refused, and never dropped. values.schema.json caps an entry at 200 characters. The draft exists to be read and corrected by hand, so a visibly truncated line (199 code points plus an ellipsis) is one the human repairs in place, while refusing the draft would cost them the other nineteen bullets over one long sentence. A warning names the original length. Sliced by code point so an astral character is never cut in half, which is also how Ajv measures maxLength.
3. Deduped AFTER truncation, because uniqueItems is checked on the values the block actually carries: two long bullets differing only past the cap would otherwise emit as a duplicate pair and fail the schema.
4. Past 20 entries the overflow is preserved as comments inside the fence and reported, the same stance the permissions half already takes for unmapped bullets. Nothing is dropped silently anywhere in this module.
5. --out shape. With no values heading the file is today's bare policy YAML, byte-identical, and the three pinned expected.yaml fixtures do not move. With a values draft the file becomes the two fenced blocks (policy fence, blank line, values fence). This is forced: a values fence appended to bare YAML cannot be pasted into a policy fence, because the values block's closing fence would close the policy block and the result would load as neither. So written, the file loads through loadPolicy and through loadValuesText unedited, which is pinned by tests in both suites. stdout and --out emit the same bytes for the same source.
6. VALUES_INFO_STRING is SPELLED in agents-md.ts, not imported from core/values.ts, mirroring how POLICY_INFO_STRING is already spelled there rather than imported from policy-load.ts. Pinned against the reader's own constant by a test.

INVARIANT TOUCHED (SPEC.md §11.1 invariant 10, tests/values-inert.test.ts) - FLAGGED FOR REVIEW
The APRV-237 guards forbid any src/core module from importing the values reader OR naming the literal "approval-values", including in prose. A draft renderer must spell the label it emits, so src/core/agents-md.ts was added to VALUES_LITERAL_ALLOWED as the one WRITER on that list, with the reasoning written into the guard. To keep the widening from becoming a door, a new companion test ("the draft renderer emits a block and reads none") asserts agents-md.ts names none of loadValues, loadValuesText, scanFences, parseHardenedYaml or ./values.js: it may write the label, and the moment it can extract, parse or load a block it fails. The guard caught two real violations while this task was being written (the import, then a doc comment naming loadValuesText), so it is live rather than decorative. agents-md.ts is in no enforcement path and appears in no decision module list. If the orchestrator prefers the blanket rule kept, the alternative is moving the renderer out of src/core, which splits parse from render and leaves prose that avoids a substring for reasons no future reader could see.

KNOWN GAP FOR THE DOCS HALF
src/cli/help.ts was off limits for this lane (a sibling task is landing `approval feedback` in it), so IMPORT_AGENTS_MD_HELP still prints the pre-APRV-240 --json shape and does not mention values_draft. The registry and the live output now carry it; the help text does not. cli-import.test.ts pins that help string, so whoever updates help.ts updates that assertion too. The `import agents-md` VerbSpec `purpose` was likewise left alone to keep the edit local.

VALIDATION (exit codes read, not summary blocks)
- npm run build: exit 0.
- node --test on dist/tests/agents-md.test.js, cli-import.test.js, cli-instructions.test.js, values-inert.test.js, values.test.js: exit 0, 89 tests, 89 pass, 0 fail. agents-md alone: 34/34. cli-import alone: 16/16.
- node --test on dist/tests/mcp-server.test.js, mcp-guest.test.js, cli-values.test.js (registry consumers): exit 0, 39 tests, 39 pass, 0 fail.
- npm run lint: exit 0. npm run typecheck: exit 0.
- A full npm test was not run in this lane by instruction.
<!-- SECTION:NOTES:END -->
