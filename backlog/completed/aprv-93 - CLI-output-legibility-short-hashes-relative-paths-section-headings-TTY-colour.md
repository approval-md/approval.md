---
id: APRV-93
title: >-
  CLI output legibility: short hashes, relative paths, section headings, TTY
  colour
status: Done
assignee:
  - '@fable'
created_date: '2026-08-18 17:46'
updated_date: '2026-08-19 12:39'
labels:
  - cli
  - ux
dependencies: []
priority: medium
type: feature
ordinal: 86000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Human feedback 2026-08-18 on 'approval policy amend --dry-run' output: dense and hard to scan. Two 64-hex hashes on one line, absolute paths repeated three times, every line the same visual weight, no colour. Applies to amend, status, wait, explain, hook classify and the gate verbs' human output. Proposal: (1) short hashes (12 chars) in human output, full value only in --json; (2) paths relative to cwd; (3) section labels and indentation (Policy / Changes / Load / Would run), with changed resolutions as the visual centre in a before -> after layout; (4) ANSI colour only when stdout is a TTY and NO_COLOR is unset (green ok, yellow changed, red refused, dim for hashes/paths), never in --json or when piped; (5) a shared src/cli/style.ts so every verb renders the same way; (6) tests that piped output stays byte-stable (docs-guard pins some of it) and that colour is off when not a TTY. No new dependency: hand-roll the few escape codes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 src/cli/style.ts provides heading/label/dim/ok/warn/err helpers that are no-ops when not a TTY or NO_COLOR is set
- [x] #2 amend, status, wait, explain, hook classify use it; hashes short and paths relative in human output; --json unchanged
- [x] #3 piped output has no escape codes; existing docs-guard and CLI tests pass unchanged
- [x] #4 npm test and lint pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, worktree from aprv-91 branch (needs usage.ts and the trimmed helps). 2. src/cli/style.ts (heading/label/dim/ok/warn/err; no-op unless TTY and NO_COLOR unset); short hashes (12) and cwd-relative paths in human output only; applied to amend/status/wait/explain/hook classify; --json byte-identical; piped output has no escapes. 3. Absorb the visual ACs the human added to APRV-91 (6-16: wordmark, glyph refusal shape, doctor/queue tables, --help --long) where they belong here; read that brief. 4. Tests; docs-guard unchanged. PR.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Opus subagent build (worktree agent-a54c99a4dc1f3f925, branched from aprv-91), collected and landed by fable 2026-08-19 as PR by branch aprv-93-legibility (#76). +51 tests: 1733 -> 1784; lint and typecheck clean; docs-guard byte-identical. KEY DECISIONS: (1) src/cli/style.ts is a role palette (brand/ok/warn/fail/key/value/muted/secret-notice/rule), hand-rolled ANSI, no dependency; the enable matrix is one function decided once per process, precedence json -> --no-color -> FORCE_COLOR=1 -> NO_COLOR -> TERM=dumb -> isTTY, so --json is an absolute colour veto that outranks FORCE_COLOR (frozen API first). (2) Glyphs degrade to ASCII only on an explicitly non-UTF-8 LANG/LC_ALL or APPROVAL_ASCII=1; an unset locale is treated as UTF-8 so env -i and test runners keep the pinned bytes. (3) --help --long reads docs/cli-reference.md at runtime, resolved ../../../docs/cli-reference.md from dist/src/cli, and package.json files now lists dist and docs/cli-reference.md: dist was never in files and there is no prepack script, so the published package could not have run at all (cli.js imports ./dist/src/cli/main.js); a real packaging fix, not cosmetics. (4) Gate refusals take the glyph+code shape with NO fix: line, because a gate refusal names a state (rejected, expired, no live token), not a fixable input; fix: lines stay on argument and payload errors. (5) Wordmark on approval (no args: splash to stdout, usage error to stderr, exit 2 preserved), --help and init only; collapses to "approval.md v<version>" when colour is off or in ASCII mode. (6) Short hashes (12) and cwd-relative paths in human output only; doctor paths stay absolute (outside the AC; obvious next candidate). (7) Help split: every per-verb short help is under 25 lines (test-enforced; ROOT_HELP exempt), four group headings in root help (Set up / Ask / Decide / Inspect), the long prose moved verbatim to docs/cli-reference.md under why: anchors. ABSORBED APRV-91 ACs 6-16, honest status: 6/11, 7/12, 10/15, 16 met; 9/14 partial (doctor, queue, status are tables; log tail untouched, no --verbose, token panel deferred to keep the two decision surfaces consistent); 8/13 met for the gate only (execute/audit/channel/env refusals still on the old line) -> APRV-102 carries the remainder. LANDING (fable): merge of origin/main conflicted in src/cli/help.ts MCP_HELP only (main dffb4ac hand-resolved the same 88+91 merge); resolved to the branch 25-line form with the why: anchor; reworded its not-published list to "channel listeners" since channel telegram health is agent-facing and IS published; wordmark now also collapses in ASCII mode (the comment and AC said so, the code did not); the wordmark-presence test now spawns with piped stdio because in-process it read the runner TTY and failed under a real terminal (passed only in CI). INVARIANTS TOUCHED: §11.1 invariant 6, human refusal text for the gate changed shape; codes and --json bytes unchanged and pinned (tests/cli-style-render.test.ts). Review findings beyond scope recorded in APRV-102 (legibility remainder), APRV-103 (SPEC drift), APRV-104 (hygiene).

Merged to main at dae96b5 via auto-merge behind the ci gate (classify tier, full gate node 20 and 22 green).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Shared src/cli/style.ts (role palette, one enable matrix, --json absolute veto), short hashes and cwd-relative paths in human output, glyph refusal shape for the gate, wordmark, help split with --help --long from the shipped docs/cli-reference.md, dist added to package files. PR by branch aprv-93-legibility, merged at dae96b5. Verified by npm test (1784), lint, typecheck, style matrix and piped-output tests; the landing added a TTY-independent wordmark test. Remainder of the absorbed 91 ACs is APRV-102.
<!-- SECTION:FINAL_SUMMARY:END -->
