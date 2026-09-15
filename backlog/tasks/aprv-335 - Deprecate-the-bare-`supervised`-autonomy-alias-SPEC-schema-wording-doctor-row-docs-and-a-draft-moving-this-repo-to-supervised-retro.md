---
id: APRV-335
title: >-
  Deprecate the bare `supervised` autonomy alias: SPEC, schema wording, doctor
  row, docs, and a draft moving this repo to supervised-retro
status: Done
assignee:
  - '@claude-opus'
created_date: '2026-09-14 04:04'
updated_date: '2026-09-14 06:27'
labels: []
dependencies:
  - APRV-334
references:
  - docs/proposals/repo-values-block.md
ordinal: 253000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Since APRV-127 the bare `supervised` level is only an alias of `supervised-retro`, kept so pre-split policies keep their meaning, with a load-time note. Reading a policy that mixes `supervised`, `supervised-live` and `supervised-retro` suggests three bargains where there are two, and the SPEC glossary row (line 64) still lists three levels with no split at all. This task marks the alias deprecated without removing it (removal would break published policies), surfaces it in `approval doctor`, fixes the glossary, updates every doc that enumerates levels, and drafts the five class lines in this repo policy that still use the bare word (vcs.push.main, vcs.pr.*, policy.edit.design, vcs.remote.meta, and any other) as supervised-retro, appended to docs/proposals/approval-md-2026-09.md for Carter to paste. SPEC edits classify policy.edit.spec and carry an (Amended APRV-NNN, pending sign-off.) marker. No §11 invariant is touched; implementation notes must say so.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 SPEC §5.2 autonomy-split bullet states the bare spelling is deprecated: still parsed as supervised-retro, still noted at load time, surfaced in the health report, removed in a future schema version
- [x] #2 SPEC glossary row for Autonomy level lists human-only, manual, supervised-live, supervised-retro, autonomous in strictness order and names supervised as the deprecated alias
- [x] #3 schema/policy.schema.json keeps supervised in both autonomy enums and its descriptions say deprecated; the load-time note text says deprecated and tests/autonomy-split.test.ts asserts it
- [x] #4 approval doctor gains an autonomy-alias row: pass with a detail naming each class pattern that uses the bare word and a fix hint, or pass with none listed; a covered test proves both shapes
- [x] #5 README.md (dictionary row and levels prose) and docs/cli-reference.md say deprecated alias wherever they say alias today
- [x] #6 docs/proposals/approval-md-2026-09.md carries a section with every bare-supervised class line rewritten to supervised-retro, comments intact
- [x] #7 tests/dogfood.test.ts still pins the live APPROVAL.md unchanged; npm test and lint pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. SPEC.md: append the deprecation sentence to the autonomy-split bullet (line 139) ending "(Amended APRV-335, pending sign-off.)"; rewrite the glossary row for Autonomy level (line 64) to list all five levels in strictness order and name the deprecated alias; change the canonical example (line 99, calendar.write.own) from bare supervised to supervised-retro.
2. schema/policy.schema.json: keep supervised in the autonomy and defaultAutonomy enums; reword both descriptions to say DEPRECATED alias, removed in a future schema version.
3. src/core/policy-load.ts aliasNotes: prefix the note message with "deprecated: " and say a future schema version removes it. tests/autonomy-split.test.ts: add a /deprecated/ assertion beside the existing code/where/supervised-retro ones.
4. src/cli/doctor.ts: new section 7e beside the values-block check with checkAutonomyAlias() returning a DoctorCheck named autonomy-alias — pass listing the class patterns using the bare word with a fix pointing at docs/proposals/approval-md-2026-09.md, pass with "no rule uses the deprecated bare supervised" when none, skip when the policy is unreadable. No warn status. Append the row at the END of the checks array and of tests/doctor-rows.ts DOCTOR_ROW_ORDER (the roster is append-only by its own doc comment), not into FRESH_SKIPS (a scaffolded policy loads, so the row answers).
5. tests: append "pass" to the status roster in tests/cli-doctor.test.ts; add a doctor test covering both shapes (rules listed / none listed), patterned on the values-block doctor tests.
6. README.md: doctor row count 28 -> 29 and the tally, name the new row in the roster prose, and say "deprecated alias" in the levels prose (line ~431) and the dictionary row (line ~640). docs/cli-reference.md: "deprecated alias" at ~2653 and a new - **autonomy-alias** bullet last in the #doctor roster.
7. docs/proposals/approval-md-2026-09.md: replace the section 2 placeholder with rationale plus Current/Replace pairs for APPROVAL.md lines 46, 47, 55, 62 extracted with sed (byte for byte), noting that the vcs.push.main replacement supersedes section 1 and carrying section 1 new comment together with supervised-retro. No retro_rate.
8. npm test and npm run lint; tests/dogfood.test.ts must pass unchanged.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
BLOCKED on the two SPEC.md criteria (AC1, AC2). Every Edit of SPEC.md in this session returned hook-timeout on policy.edit.spec: "no decision ... within the hook s 540000ms wait", the same open request adopted by three retries spread over roughly 40 minutes. Nothing was written to SPEC.md, so SPEC.md is byte-identical to main on this branch. Journalled with `approval journal write`. The exact text that still needs to land is recorded below.

SPEC.md line 64, glossary row, to replace the current three-level row:
| **Autonomy level** | How much scrutiny a class gets, strictest first: `human-only` (a person performs the action, and no agent may request it, be granted it, or run it), `manual` (a human decides before every action), `supervised-live` (a declared fraction blocks on the gate exactly as `manual` does, and the rest proceed), `supervised-retro` (proceeds at once, with a sampled fraction reviewed afterwards), `autonomous` (proceeds silently). The bare `supervised` is the deprecated alias of `supervised-retro` (§5.2). |

SPEC.md line 139, appended to the end of the autonomy-split bullet:
**The bare `supervised` is deprecated.** It is still parsed as `supervised-retro`, so no published policy breaks, and the load-time note above is still recorded wherever it appears. Implementations SHOULD surface it in their health report as well, so an operator meets the deprecation while reading the state of their own repository rather than only in a loader note. A future version of the policy schema removes the spelling, and a policy that writes `supervised-retro` today needs no change then. (Amended APRV-335, pending sign-off.)

SPEC.md line 99, the canonical example, bare supervised on the one class that uses it:
  calendar.write.own:           { autonomy: supervised-retro }

DONE and verified (AC3-AC7):
- schema/policy.schema.json keeps `supervised` in both the `autonomy` and `defaultAutonomy` enums; both descriptions now call it a DEPRECATED ALIAS of `supervised-retro` and say a future schema version removes it.
- src/core/policy-load.ts `aliasNotes`: the note message now leads with "deprecated: " and closes by saying a future schema version removes the spelling. tests/autonomy-split.test.ts asserts /deprecated/ beside the existing code and /supervised-retro/ assertions.
- src/cli/doctor.ts gains `autonomy-alias` (new section 7e, beside the values-block check, appended LAST in the checks array because tests/doctor-rows.ts is append-only by its own doc comment). Pass naming each rule when the bare word is used, pass saying "no rule uses the deprecated bare `supervised`" when it is not, skip when the policy did not load. No warn status, and the row never moves the exit code.
- Three doctor cases cover all three shapes; the shared `policyWith` fixture moved to `supervised-retro` so a passing row does not hand a fix to every sweep that asserts otherwise, and `socketHomeLive` s replace target moved with it.
- README doctor prose 28 -> 29 rows, tally 9 ok -> 10 ok, `autonomy-alias` named in the roster; levels prose and the `classes.<pattern>.autonomy` dictionary row both say deprecated alias.
- docs/cli-reference.md: a new `- **autonomy-alias**` bullet last in the #doctor roster (the roster-order guard in tests/cli-long-help.test.ts holds it to that position) and the audit section now says deprecated alias.
- docs/proposals/approval-md-2026-09.md section 2: rationale plus byte-exact Current/Replace pairs for APPROVAL.md lines 46, 47, 55 and 62, extracted by script rather than retyped. The vcs.push.main entry states that it supersedes section 1 for that line and shows section 1 s line, so the replacement carries the new comment and `supervised-retro` together. No `retro_rate` added.

DECISIONS:
- The row is `pass`-with-`fix`, never `fail` and never `warn`, following the existing log-drift and checkpoint rows. A deprecated spelling parses and is enforced identically, so a red line would be doctor going red over prose.
- The fix string leads with `approval policy amend` rather than the bare words "write supervised-retro" the task brief proposed, because FIX_COMMAND_PREFIXES (APRV-75, pinned by tests/cli-doctor.test.ts) requires every fix to begin with a runnable command; `policy amend` is the verb that owns the edit and the re-attestation it costs, and the brief s wording follows it verbatim in the prose.
- APPROVAL.md was not touched (policy.core, human-only). tests/dogfood.test.ts pins the live file and passes unchanged.

INVARIANTS: no SPEC §11 global invariant was touched. The change is wording plus one read-only health row; enforcement paths, gate timestamps, secret handling, self-reported fields, compare-and-append, refusal codes and human-only inertness are all untouched, and the loader resolves `supervised` exactly as it did before.

VALIDATION: npm test exit 0, 4120 tests, 4119 pass, 0 fail, 1 skipped. npm run lint (oxlint src tests) exit 0. `node cli.js doctor` on this repo prints the new row naming policy.edit.design, vcs.pr.*, vcs.push.main and vcs.remote.meta, the same four lines section 2 of the proposal rewrites.

SPEC edits landed 2026-09-13 after the daemon was started in the primary (the earlier hook-timeouts were the live draw failing closed with no draw socket, plus Telegram unset in that shell; not a rejection). Glossary row, deprecation paragraph and the calendar.write.own example line applied verbatim as recorded above; each passed its own 1% draw.

Follow-on after the combined-branch test run: SPEC §5.1 canonical example line calendar.write.own moved to supervised-retro, and tests/cli-init.test.ts guards that the init scaffold, the canonical fixture and §5.1 are one document, so src/cli/scaffold.ts, schema/fixtures/policy-md/valid/canonical.md, the ten fixtures that copy it and schema/fixtures/policy/valid/canonical.json moved with it, and the conformance vectors were regenerated. The init scaffold no longer emits the deprecation note it introduces. tests/policy-match.test.ts expectation stays "supervised": the resolver reports the tier with supervision retro|live alongside, so the resolved autonomy is unchanged.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Bare supervised marked deprecated: SPEC §3 glossary and §5.2 amended (pending sign-off), schema descriptions, load-time note text, new doctor row autonomy-alias (pass with fix, never fail), README and cli-reference wording, and section 2 of docs/proposals/approval-md-2026-09.md rewriting four APPROVAL.md lines to supervised-retro. Verified: npm test 4119 pass, lint clean, doctor on this repo names the four rules.
<!-- SECTION:FINAL_SUMMARY:END -->
