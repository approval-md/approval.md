---
id: APRV-283
title: 'Classifier reads find, ls -d and some grep forms as files.write.workspace'
status: Done
assignee:
  - '@opus-hook'
created_date: '2026-09-06 07:19'
updated_date: '2026-09-06 08:45'
labels:
  - hook
  - classifier
dependencies: []
type: bug
ordinal: 209000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Reported by an agent lane on 2026-09-06: `find …`, `ls -d <path>/*` and grep variants classified as files.write.workspace by `approval hook classify`. They are reads. A false write classification costs nothing in policy today (both are autonomous) but it feeds the execution.failed streak of the loop-escalation rule and misreports the session in coverage. Reproduce with `approval hook classify -- "<cmd>"` for each shape, fix the classifier table in src/core/command-class.ts, and add the shapes to tests/command-class.test.ts.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 find, ls -d with a glob, and grep -r/-l/-o forms classify read.shell (or read.files) and the tests pin each shape
- [x] #2 No previously write-classified command becomes a read: the table diff is reviewed against the existing write fixtures
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Reproduce with the real classifier. The BARE shapes already answer read.shell (find, ls -d src/*, grep -r/-l/-o): the reproduction is the suffix an agent writes on all three, '2>/dev/null'. Any redirection whose op is not '<' makes writeTargets non-empty, and a read with a write redirection is reclassified files.write.workspace by the redirect-write override in classifySegment.
2. Fix: a redirection to a DISCARD device creates no file, so it is not a write. Add DISCARD_TARGETS (/dev/null, /dev/stdout, /dev/stderr, /dev/tty, /dev/fd/<n>) and filter them out of writeTargets. '> out.txt' and '2> errors.log' still classify files.write.workspace.
3. Review the diff in the OTHER direction before shipping it, per AC2: with the redirect override relaxed, 'find . -type f -delete 2>/dev/null' would fall from files.write.workspace to read.shell, and 'find . -name x -exec rm {} +' is already read.shell today. So give find its own rule: -delete/-fprint/-fprintf/-fls write, and -exec/-execdir/-ok/-okdir are OPAQUE for the reason xargs is (they run a command built elsewhere and the classifier does not read it). This needs the refine contract to carry an opaque reason of its own.
4. Pin every shape in tests/command-class.test.ts: the three bare forms, the same three with 2>/dev/null, the redirections that still write, and the find primaries in both directions.
5. Re-run command-class, classify-tier, dogfood, cli-hook classify cases, conformance.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reproduced with the CLI. The three reported shapes classify read.shell BARE on this base; what makes `approval hook classify` answer files.write.workspace is the suffix agents write on all three, `2>/dev/null`. classifySegment treated every redirection whose op is not '<' as a write target, so the redirect-write override reclassified any read carrying one: `find . -name '*.ts' 2>/dev/null`, `ls -d src/* 2>/dev/null` and `grep -rl foo . 2>/dev/null` were all files.write.workspace, as were `cat x 2>/dev/null` and `... >/dev/null 2>&1`.

FIX 1 (the bug): a redirection to a discard device creates no file, so it is not a write. DISCARD_TARGETS is exact and closed — /dev/null, /dev/stdout, /dev/stderr, /dev/tty, /dev/fd/<n> — and anything else under /dev still classifies as a write, because a device node this file does not know is one it cannot vouch for. `> out.txt` and `2> errors.log` are untouched, and a redirection onto a protected path still takes that path's class first.

FIX 2 (found by reviewing the diff in the other direction, AC2): with the override relaxed, `find . -type f -delete 2>/dev/null` would have fallen from files.write.workspace to read.shell — and `find . -type f -delete` and `find . -name '*.tmp' -exec rm {} +` were ALREADY read.shell on this base, since find sat in the read table. So find gets its own rule: -delete is files.delete.out_of_scope (find is recursive by construction and its start points are relative, so the scope of the delete cannot be established from text, which is refineRm's own reasoning for `rm -r .`), -fprint/-fprintf/-fls are files.write.workspace, and -exec/-execdir/-ok/-okdir are OPAQUE for the reason xargs is: they run a command line this classifier does not read. The Refinement type gained an opaque arm so the refusal states its own reason instead of the interpreter's 'runs inline source'.

AC2 evidence: a scan of all 352 command literals in tests/command-class.test.ts reports exactly 15 write->read moves, and all 15 are the discard-redirection fixtures this task added. No pre-existing write fixture moved; the 393-case fixture suite passes unchanged.

BEHAVIOUR CHANGE TO FLAG: `find … -exec grep -l foo {} +` was allowed as a read and is now denied opaque. That is the fail-closed answer and it matches xargs, but it will surprise a lane that uses find -exec for searching; the rewrite is a pipeline or a bare find.

Sec 11 invariants touched: none are weakened. The classifier resolves no autonomy and reads only the command text; both fixes move classes in the strict direction except the discard exemption, which is the defect being fixed. Files: src/core/command-class.ts, tests/command-class.test.ts, docs/claude-code-hook.md (rule table row, read-shell bins, redirect-write override).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
A redirection to a discard device (/dev/null and kin) is no longer a write, so the read shapes agents type — find …, ls -d <path>/*, grep -r/-l/-o, each with the 2>/dev/null they carry — classify read.shell instead of files.write.workspace. Reviewing that relaxation in the other direction turned up a live hole and closed it: find sat in the read table, so find -delete and find -exec rm classified read.shell outright; find now has its own rule (-delete is files.delete.out_of_scope, -fprint/-fprintf/-fls write, -exec/-execdir/-ok/-okdir are opaque like xargs). Verified: tests/command-class.test.ts 393/393 with 26 new pinned shapes, a scan of all 352 fixture command literals showing the only write->read moves are the 15 discard-redirection cases this task added, cli-hook 94/94, cli-hook-cursor/scope/rewrite/scratch 46/46, dogfood + routing + tier 498/498, npm run check:tier, conformance 288/288, lint and typecheck clean.
<!-- SECTION:FINAL_SUMMARY:END -->
