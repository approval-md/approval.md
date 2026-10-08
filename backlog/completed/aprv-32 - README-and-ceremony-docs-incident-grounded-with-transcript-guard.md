---
id: APRV-32
title: 'README and ceremony docs, incident-grounded, with transcript guard'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-05 12:19'
updated_date: '2026-08-05 15:32'
labels: []
milestone: m-6
dependencies:
  - APRV-28
  - APRV-29
  - APRV-30
  - APRV-31
priority: medium
type: docs
ordinal: 32000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up 5 plus the two accepted doc riders (human-approved 2026-08-05). A real README structured around the three human ceremonies: first attestation; amending your policy (citing the live log's seq 2 by number as the incident the amend verb exists to prevent); approving from your phone. States plainly, in user-facing prose rather than module headers: the token-delivery asymmetry (telegram listener stdout vs web response page, and why) and the web CSRF stance (no auth, loopback trust boundary, speed-bump Origin check). Points at CLAUDE.md for how this repo builds itself. Ships the grep-guard test binding examples/ transcripts to executed reality (exit-code table and refusal strings asserted against exit-codes.ts and live messages). Depends on the four ergonomics tasks so the ceremonies it documents exist. Prose per the repo style rule: no em dashes, affirmative statements.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 README.md covers the three ceremonies with runnable command sequences: first attestation; policy amendment via approval policy amend citing log seq 2 as the motivating incident; phone approval via the telegram channel
- [x] #2 Token-delivery asymmetry and web CSRF stance stated plainly in user-facing prose with their rationales
- [x] #3 README points at CLAUDE.md for repo self-development; prose follows the style rule (no em dashes, affirmative)
- [x] #4 A guard test asserts examples/ transcripts still match executed reality: exit-code table vs exit-codes.ts, refusal strings vs live CLI messages; drift fails npm test
- [x] #5 SPEC section 12 inbound-adapters line replaced with the approved neutral phrasing: "e.g. a Telegram capture bot, arbitrary apps via approval register --json"; rationale recorded in task notes (neutral standard names no steward-private systems; a non-normative adopters appendix is the future home, deliberately not created yet)
- [x] #6 Case-insensitive sweep for "cartsos" across SPEC.md, README and all docs, index.html, examples/, source and test comments, schema descriptions, and backlog/ task files: load-bearing hits replaced with the generic phrasing, incidental hits deleted; backlog files get clarifying notes appended rather than history edits
- [x] #7 Implementation notes report every hit and its resolution, including zero-hit files searched, so the neutrality pass is auditable rather than assumed
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented by Opus subagent; fable review found nothing to override. NEUTRALITY AUDIT (the human-mandated ledger, verbatim from the build report): 39 occurrences across 36 files resolved — SPEC.md 4 (canonical example -> example-capture; 6.2 row -> example-capture/manual with jobmaxxing dropped; section 12 approved phrasing; section 14 M8 -> "inbound capture adapters"); envelope schema description 1; 14 canonical-descendant fixtures; 18 test files (21 occurrences). Zero-hit surfaces explicitly searched: index.html, examples/, all of src/ incl. comments, README pre-rewrite, CLAUDE.md, APPROVAL.md, cli.js, package.json, LICENSE, CNAME, brand/, .approval/. backlog/ audited separately by fable: one self-referential hit in this task's own file, retained by note per the no-history-edits rule. Post-sweep repo-wide count is zero outside backlog/, enforced forever by the guard test whose needle is assembled as ["carts","os"].join("") so the guard is not exempt from its own search, negatively verified with a probe file. README landed with the three ceremonies, the seq-2 incident subsection, both doc riders stated plainly, the exit-code table deepEqual-guarded against exit-codes.ts, and the style rule held. DISCREPANCY FLAGGED TO HUMAN in the m-4.1 report: the log shows seq 2 -> seq 3 as 7m27s while the dictated and code-cited figure is "eleven minutes" — kept as dictated pending the human's ruling (may measure from the edit rather than the append); the guard regex tolerates either wording.

Date corrected in place per the 2026-08-05 human ruling (log-is-authoritative, applied to all APRV-46 findings): prose previously claimed 2026-08-09; this task's own created_date (2026-08-05) is the cited source. The wrong date was orchestrator confabulation, part of the systematic drift reported in APRV-46.
<!-- SECTION:NOTES:END -->

## Comments

<!-- COMMENTS:BEGIN -->
created: 2026-08-05 12:53
---
Human-settled (2026-08-05): the canonical example's origin.app replacement is "example-capture" (or similar carrying "example" in the name) — the replacement outlives us in frozen fixtures and must read as unmistakably illustrative, never as another product name. Ripple: SPEC section 6.1/6.2 text, canonical.json, and every fixture descended from the canonical example move together; the canonical-example-verbatim assertions enforce the agreement.
---

created: 2026-08-05 13:04
---
Neutrality-sweep audit, backlog/ portion (fable, 2026-08-05): grep -ric cartsos across backlog/ returns exactly one hit — this task's own file, where the name appears as the sweep's search target in the human-dictated scope. Retained deliberately per the no-history-edits rule: a sweep specification must be allowed to name what it removes. All other backlog task files: zero hits.
---
<!-- COMMENTS:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
README rebuilt around the three human ceremonies with the seq-2 incident cited by number, both doc riders in user-facing prose, exit-code table guarded against the source of truth; SPEC neutrality edits landed and the cartsos sweep completed with a 36-file audited ledger and a self-testing reintroduction guard. 6 tests. Verified: 900/900 from wiped install.
<!-- SECTION:FINAL_SUMMARY:END -->
