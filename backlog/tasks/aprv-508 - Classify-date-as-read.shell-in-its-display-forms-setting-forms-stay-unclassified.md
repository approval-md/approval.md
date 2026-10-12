---
id: APRV-508
title: >-
  Classify date and the system-information readers as read.shell in their
  display forms; setting and file-reading forms stay unclassified
status: Done
assignee: []
created_date: '2026-10-12 04:14'
updated_date: '2026-10-12 06:56'
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
- [x] #1 bare date, date +FORMAT, -u/--utc/--universal, -R/--rfc-2822/--rfc-email, -I[precision]/--iso-8601[=precision], --rfc-3339 precision, -d/-ud/--date STRING, --debug, --resolution, --help, --version and TZ=Zone date classify read.shell under rule date-read, by an exact-spelling allow-grammar read for GNU and uutils 0.10 date alike
- [x] #2 -s/--set, --, any operand not starting with +, a value starting with -, attached short values, abbreviations, unlisted clusters, repeated flags, words carrying $, backticks, globs or braces, and a binary spelled outside the system bin directories stay unclassified
- [x] #3 No admitted date form opens a file: -f/--file and -r/--reference in every spelling and cluster, a zone path in TZ (absolute, :/, ..) or in a TZ="…" inside a -d string, and a locale value that is a path all stay unclassified
- [x] #4 An environment assignment other than TZ, LANG, LANGUAGE, LC_ALL, LC_TIME declines the date row; no assignment is admitted before the other new rows
- [x] #5 uptime, whoami, hostname, df, free, seq and paste are read.shell in their listed display forms only; hostname NAME, hostname -- NAME, hostname -F, uptime FILE, df PATH, free -s and every unlisted form stay unclassified; paste's operands are read targets exactly as cat's
- [x] #6 date and the new readers inside $(…) and pipelines classify read.shell; [ classifies as test does
- [x] #7 A differential test runs every admitted argv from a mixed alphabet against GNU coreutils and uutils 0.10 (APPROVAL_DIFF_UUTILS) and finds no set attempt, no file open, and no admitted argv the tool rejects
- [x] #8 Conformance vectors (allow and refuse, including the hostname-sets case) regenerated; command-class suite minor bump; tests and docs rule tables updated
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

Revision 2 (second security review, parser-differential / validation bypass in command-class.ts; Carter's scope change). Every new row is now an exact-spelling allow-grammar: listed clusters only, no --, no attached short values, no option given twice in any spelling (clap refuses a repeat, getopt takes the last), flag-shaped separate values refused, and a shape row's binary must be bare or under /bin, /usr/bin, /usr/local/bin, /sbin, /usr/sbin (./date is whatever program sits there). New rows: sysinfo-read (uptime, whoami), hostname-read, df-read, free-read, seq-read, paste-read (paste: all in READ_TARGET_SHAPES, scoped as cat). tests/command-class-differential.test.ts enumerates argvs over mixed alphabets and runs every ADMITTED one against GNU coreutils (gdate etc. on macOS, the system tool on Linux) and uutils 0.10 (APPROVAL_DIFF_UUTILS): no set attempt, no canary open, and seq/paste/df/uptime/whoami must accept every admitted argv. It found three real differentials, all fixed: uutils seq reads a word after a number as a number (flags now must precede numbers); clap refuses repeated options (now refused); seq -f --format=x (clap reads the value as a flag; flag-shaped values refused). The file skips under uid 0 so no admitted argv can set the clock for real. Validation at the revision: lint 0, typecheck 0, conformance 0 (624/624), npm test exit 1 with two unrelated failures (gloss-codex fails on unmodified main too; log-lock-reclaim six-writers is a load timeout that passes on rerun, 41/41).

Revision 3 (PR #636 refutation, 1 M / 5 S / 4 N; note APPROVAL-636-refute.md). M1: lex() read >&/<& as dups only and skipped [0-9-]; bash reads >&WORD (WORD not a descriptor) as >WORD 2>&1, so cat /dev/null >& APPROVAL.md truncated the policy while classifying read.shell (on main and 0.4.3 too; this PR had added four carriers). Now the full word after >&/<& is read: ^\d+-?$ or - is a dup/close; any other word after >& is a write redirect {op: '>'} that the protected-path and write checks see (a word with a substitution is taken as a file, the stricter reading); after <& it is refused unparseable. S1: a bare assignment of TZ, TZDIR, PATH, LOCPATH, GCONV_PATH, LANG, LANGUAGE, LC_*, LD_* in its own segment is unclassified. S2: the TZ= match inside -d is case-insensitive. S3: test and [ refuse a -v/-R operand containing [ and any unquoted substitution (whose output the shell would split, possibly into -v and a subscript); quoted substitutions still read. S4: seq admits at most 100,000 values (SEQ_MAX_VALUES) and refuses a zero increment or non-finite bound. N4: kept APRV-508 per coordinator (the other lane moved to APRV-510). S5 (free/hostname real-tool coverage) and N1-N3 are informational and unchanged. Vectors: +15 (8 controls), command-class 1.7.0 now 59 new vectors; no committed expectation moved.

Revision 4 (recheck at ad26073, 1 M / 3 S). M-R1: classifySegment walked substitutions in segment.words only; redirection targets (which the shell expands before the command runs) were never classified, so cat a < "x$(rm -rf y)" was read.shell and cat a > x$(rm -rf y) a plain write on main and 0.4.3, and ad26073's >& target made four more rows regress. The recursive loop now runs over words and every redirect target: a nested refusal refuses, a non-read class is opaque. Backticks and process substitution in targets were already refused (pinned). S-R1: printf -v NAME / -vNAME is unclassified when NAME (subscript stripped) is a steering variable or carries $/backtick; HOME and CDPATH join the steering list (bare assignments too). S-R2: seq operands must have at most 15 significant digits and |x| <= 2^53, so the double count is exact enough. +15 vectors (14 controls); no committed expectation moved.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
date, uptime, whoami, hostname, df, free, seq and paste are read.shell in their display forms through exact-spelling allow-grammars checked differentially against GNU and uutils 0.10; every setting or file-reading form and every unlisted spelling stays unclassified. [ reads as test. command-class vectors 1.7.0 (+44, 28 controls).
<!-- SECTION:FINAL_SUMMARY:END -->
