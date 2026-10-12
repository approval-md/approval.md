---
id: APRV-508
title: >-
  Classify date as read.shell in its display forms; setting forms stay
  unclassified
status: Done
assignee: []
created_date: '2026-10-12 04:14'
updated_date: '2026-10-12 04:49'
labels:
  - classifier
  - agent-village
dependencies: []
priority: high
ordinal: 389000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Agents on the hosted Agent Village boxes cannot read the clock: approval.md 0.4.3 refuses `date` (hook-unclassified: no rule for date), and the python3 -c fallback is opaque. Every Telegram session works from a 'today' line fixed at the last prompt rebuild, so most agents report a stale day (lane note AGENT-DATE.md, Carter's call to unblock date). This task classifies date as read.shell ONLY in its display forms and keeps every setting form (-s/--set, a bare MMDDhhmm operand, -f/--file) at its current unclassified answer. timedatectl and python3 -c are deliberately not widened.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 bare date, date +FORMAT, -u/--utc/--universal, -R/--rfc-2822/--rfc-email, -I[FMT]/--iso-8601[=FMT], --rfc-3339=FMT, -d/--date STRING, --debug, --resolution, --help, --version and TZ=Zone date classify read.shell under rule date-read, for GNU and uutils 0.10 date alike
- [x] #2 -s/--set, any operand not starting with +, a value starting with -, long-option abbreviations, and words carrying $, backticks, globs or braces stay unclassified
- [x] #3 No admitted form opens a file: -f/--file and -r/--reference in every spelling and cluster, a zone path in TZ (absolute, :/, ..) or in a TZ="…" inside a -d string, and a locale value that is a path all stay unclassified
- [x] #4 An environment assignment other than TZ, LANG, LANGUAGE, LC_ALL, LC_TIME declines the row
- [x] #5 date inside $(…) and at the end of a pipeline classifies read.shell; [ classifies as test does
- [x] #6 Conformance vectors (allow and refuse) regenerated; command-class suite minor bump; tests and docs rule tables updated
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
New src/core/date-argv.ts holds a parse of the display forms that both getopt (GNU) and clap (uutils 0.10) agree on, used by a new date-read row in COMMAND_RULES, matched through a new generic CommandRule.shape predicate (the general form of probe/skillScript). matchRule receives the assignment words so the row can admit TZ/locale assignments whose values name no file. No form that opens a file is admitted, so read-scope.ts is unchanged. [ joins the read-shell row. Fixtures in tests/command-class.test.ts, a focused test file, an end-to-end Hermes case in tests/agent-village-policy.test.ts, vectors via scripts/regen-conformance-vectors.mjs, rows in docs/claude-code-hook.md and docs/cursor-hook.md.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
What was done: src/core/date-argv.ts parses a date argv the way getopt does and answers null for anything not display-only. COMMAND_RULES gains a date-read row, matched through a new generic CommandRule.shape predicate (the general form of probe and skillScript): an argv outside the shape does not match, so it keeps the unclassified answer every date had. matchRule now also receives the assignment NAMES so the row can admit TZ, LANG, LANGUAGE, LC_ALL and LC_TIME and decline the rest (LD_PRELOAD=x date, PATH=. date). read-scope.ts gains a reference shape for date: the -r/--reference value is the only target, and a date naming no reference answers null (not a scoped reader), so a bare date never becomes a read of the working directory (which on Hermes would refuse a call naming no path).

Decisions: (1) -r FILE / --reference FILE is a stat, the same read stat FILE is, so it takes stat's treatment: read.shell, account.credential for a credential path (credentialTouch runs first), and a read-scope target. Only the separate-word spelling is accepted; --reference=FILE and -rFILE hide the path inside a flag word where credentialTouch and the scope check do not look, so they are declined. (2) -f/--file is declined: GNU echoes each unparseable line back, which is a read of the file's contents, and on BSD -f without -j sets the clock. (3) Words carrying $, backticks, globs or braces decline the row, as do substituted words: the shell may split or expand them into -s. (4) Long options match by exact name only, since getopt accepts --se for --set. (5) timedatectl stays unclassified and python3 -c stays opaque; not widened.

Invariants touched: none weakened. This is a deliberate loosening of one binary from unclassified to read.shell, display forms only. Self-reported fields: none read. Fail closed: any form the parse does not know keeps the old refusal.

Pre-existing gap noticed, NOT changed here: an assignment prefix is stripped before classification for every other row, so LD_PRELOAD=./x.so cat f is read.shell. The date row declines foreign assignments, so it does not add to that gap. Worth its own task.

Validation (Node 26.8.2, local): npm test exit 1 with 6177 pass / 2 fail of 6185; the two failures are unrelated to this change: gloss-codex 'Codex runner kills the process group on timeout and removes its empty cwd' fails identically on an unmodified origin/main build (4ef5c209), and adapter-zzz 'ineligible no-token actions touch neither credentials nor adapter precheck' passes on rerun (36/36, exit 0), a load flake. node conformance/run.mjs exit 0 (594/594, 235 controls). npm run lint exit 0, npm run typecheck exit 0. tests/command-class-date.test.ts 91/91, tests/command-class.test.ts 629/629, tests/agent-village-policy.test.ts 10/10 (new end-to-end Hermes case).

Revision (security review, read-scope-bypass in date-argv.ts; fleet audit APPROVAL-OVERBLOCK): -r/--reference is now refused in every spelling, and the reference read-scope shape is removed, so no admitted date form opens a file and read-scope.ts is unchanged from main. Zone and locale VALUES are now judged, not just names: a TZ that is an absolute path, :/path, or carries .. (GNU and uutils open it as a zone file), and the same inside a TZ="…" in a -d string, are refused; locale values with / or .. are refused. Required values starting with - are refused because clap (uutils 0.10, the boxes' date) may read them as the next flag where getopt reads them as the value. --debug, --resolution, -h/--help, -V/--version added (uutils' option set, all harmless). [ added to the read-shell row (it is test).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
date is read.shell (rule date-read) in its display forms for GNU and uutils date; every setting form, every file-reading form (-f, -r, zone or locale paths), flag-shaped values, abbreviations, unreadable words and foreign assignments keep the unclassified refusal. [ reads as test. command-class vectors 1.7.0 (+22, 13 controls). Verified by unit, end-to-end Hermes hook and conformance runs.
<!-- SECTION:FINAL_SUMMARY:END -->
