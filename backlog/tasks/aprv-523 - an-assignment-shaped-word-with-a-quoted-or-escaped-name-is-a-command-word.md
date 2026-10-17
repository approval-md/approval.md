---
id: APRV-523
title: an assignment-shaped word with a quoted or escaped name is a command word
status: Done
assignee:
  - '@claude-approval'
created_date: '2026-10-17 12:47'
updated_date: '2026-10-17 12:47'
labels:
  - classifier
  - security
dependencies:
  - APRV-521
priority: high
ordinal: 400000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Pre-existing on main and 0.4.5; named as not closed by the APRV-521 fold (lanes-approval/APRV-GIT-ENV-build.md) and by review-b's read of #652 at 3a9c33c3. bash decides whether a word in front of a command is an assignment on the word as written, before quote removal: the name, an optional subscript, the `+` and the `=` must carry no quoting or escaping character, and the name no `$`, backtick or brace. A word whose name is quoted or escaped is a command word: bash runs a program named by the whole word, and the next word is that program's first argument. The classifier applied its assignment grammar (`ASSIGNMENT`) to the lexer's dequoted text, so it read past such a word as an assignment and judged the next word as the program. The two disagreed about what runs, in front of every program and with every assignment spelling.

Stacked on APRV-521 (PR #652), which rewrote the same cursor.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The assignment grammar is read on each word's source spelling: a word whose name part contains a quote, a backslash, a `$`, a backtick or a brace is a command word
- [x] #2 A segment whose leading assignment-shaped words bash would not all take as assignments is `unclassified` (fail-closed: the word is refused, not resolved to a program), alone, after a real assignment and inside a substitution
- [x] #3 A quoted value or a quoted subscript keeps the word an assignment, unchanged
- [x] #4 commandSegmentWords and commandSegmentShapes name the word bash runs as the binary
- [x] #5 Classifier and hook tests that fail on #652's head and pass after
- [x] #6 A stricter-only differential against #652's head and against main, with quoted and escaped name spellings added to #652's generator alphabet: 0 loosened, 0 reclassified
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. src/core/command-class.ts: `LexWord.assignment`, computed in `lex`'s `readWord` as `ASSIGNMENT` applied to the word's source slice.
2. classifySegment: the shape cursor is unchanged (so the protected-redirect answer and the sandbox walk are unchanged); right after the protected-redirect answer, a segment where bash's count of leading assignments (`bashAssignmentCount`) differs from the shape cursor's is `unclassified`.
3. commandSegmentWords / commandSegmentShapes use `bashAssignmentCount`.
4. tests/command-class-quoted-name.test.ts (classifier + hook); tests/command-class-git-env.test.ts (alphabet, predicate, differential).
5. CHANGELOG Unreleased Security entry.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Fail-closed by construction. The shape cursor in classifySegment still reads past every assignment-shaped word, so every answer above the new check (a nested substitution, an unreadable sandbox wrapper, the protected-redirect answer with its credential touch) is the base's. Below the check, every word the shape cursor consumed is an assignment to bash and the word it stopped at is not one, so the rest of the function sees exactly the base's words. The segment's answer is therefore the base's, or `unclassified`.

The deliberately broad line scans (gitEnvironmentWrite, movesNameResolution) keep reading the dequoted text: they count both readings and only refuse more. Every hook consumer of commandSegmentWords / commandSegmentShapes runs on a line the classifier answered, where the two counts are equal; the approval breakdown (wysiwys) and the Telegram count now describe the program bash runs on a refused line.

Differential, depth 2 (tests/command-class-git-env.test.ts, `APPROVAL_DIFF_QUOTED_BASE` / `APPROVAL_DIFF_QUOTED_MAIN`): 2,421,383 lines (#652's git corpus with the quoted spellings, plus a corpus of other programs). Against #652's head 3a9c33c3: 1,567,535 unchanged, 51,226 answer to unclassified, 802,622 refused both, 0 loosened, 0 reclassified. Against main 2179e128: 42,525 unchanged, 586,454 answer to unclassified, 1,792,404 refused both, 0 loosened, 0 reclassified. #652's own differential against main with the extended alphabet: 2,329,551 lines, 545,818 answer to unclassified, 0 loosened, 0 reclassified.

Out of scope, not changed: a line continuation inside a name is refused (fail-closed; bash would join it). The argv after a sandbox wrapper is not read for assignments, as before. zsh's locale identifiers (review-b N4) are a separate class.
<!-- SECTION:NOTES:END -->
