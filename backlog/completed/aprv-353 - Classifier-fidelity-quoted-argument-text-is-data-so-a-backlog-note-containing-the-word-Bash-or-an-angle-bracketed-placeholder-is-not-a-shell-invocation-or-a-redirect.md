---
id: APRV-353
title: >-
  Classifier fidelity: quoted argument text is data, so a backlog note
  containing the word Bash or an angle-bracketed placeholder is not a shell
  invocation or a redirect
status: Done
assignee:
  - '@opus-lane-classifier'
created_date: '2026-09-17 03:06'
updated_date: '2026-09-17 07:48'
labels:
  - classifier
  - hook
  - fidelity
dependencies: []
priority: medium
ordinal: 270000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found by Lane 4a on 2026-09-17 while finalizing APRV-325: the hook refused several backlog task edit --append-notes commands because the quoted note text contained the word Bash (read as a shell invocation) or an angle-bracketed placeholder such as <abs> (read as a redirect). The notes had to be reworded and split to land, which is the classifier mis-reading data as syntax. The command boundary the classifier should honour is the shell's own: a single-quoted or double-quoted argument is one word to the shell, and nothing inside it is an operator or a command. Related precedent: APRV-114 (classifier fidelity), APRV-283 (find, ls -d and grep forms read as writes). Fix the tokenizer or the segmenter so operator detection (redirects, pipes, separators, substitutions) runs on unquoted text only, and command-name detection runs on the first word of each segment rather than on substrings of arguments; keep the existing fail-closed behaviour for genuinely unquoted operators and for command substitution inside double quotes (which the shell does expand). Carter approved filing this on 2026-09-17.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 approval hook classify on backlog task edit APRV-n --append-notes with a quoted note containing the word Bash, an angle-bracketed placeholder, a pipe character and a semicolon classifies as the backlog edit it is (one segment, files.write.workspace), with tests for single-quoted and double-quoted forms
- [x] #2 A double-quoted argument containing $(...) or backticks still classifies the substitution (hook-opaque or its class) because the shell expands it; an unquoted redirect or pipe still splits segments as today; tests cover both
- [x] #3 The conformance vectors gain the quoted-argument cases; build, typecheck, lint and the classifier suites pass; docs/claude-code-hook.md notes that quoted argument text is never read as syntax
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Reproduce the reported refusal against origin/main before changing anything: drive classifyCommand and commandSegmentWords over a backlog task edit --append-notes command whose quoted note carries every printable ASCII character, in both quote styles, plus adjacent-quote concatenation, backslash escapes and unbalanced quotes.
2. Fix whatever the sweep shows is not quote-aware in the segmenter, the operator scan or the command-name pick. Keep unquoted operators splitting exactly as today, keep an expansion the shell performs inside double quotes classifying as today, and keep an unbalanced quote failing closed.
3. Write the guarantee down in the tokenizer itself, so a later edit cannot lose it silently.
4. Make the refusal for an expansion the shell performs inside a double-quoted argument say which spelling is inert, without changing its code or its verdict.
5. New suite tests/command-class-quoting.test.ts for the criteria: single- and double-quoted notes carrying the offending words and characters are one workspace-write segment; a substitution inside double quotes still refuses; an unquoted redirect, pipe and separator still split; an unbalanced quote is unparseable; the exhaustive character sweep runs as a property test.
6. New conformance suite command-class with vectors for the quoted-argument cases and for the two double-quoted exceptions, generated through scripts/regen-conformance-vectors.mjs and pinned in the manifest.
7. One sentence in docs/claude-code-hook.md saying quoted argument text is never read as syntax, with the two exceptions named.
8. build, typecheck, lint, the classifier suites and node conformance/run.mjs.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Repro probe: this note names the Bash tool and a <abs> placeholder, a pipe | and a semicolon ; on purpose.

Finding, before the fix: the tokenizer in src/core/command-class.ts was ALREADY quote-aware, and the reported defect does not reproduce against origin/main (3cf777c). I swept every printable ASCII character plus newline and tab through a backlog task edit --append-notes command, in both quote styles, and every one of them came back as a single files.write.workspace segment with the note intact as one word: pipes, semicolons, angle brackets, parentheses, ampersands, redirection arrows, the word naming a shell. Adjacent-quote concatenation, backslash escapes and empty quotes are handled the way the shell handles them, and quoting that never closes already failed closed as unparseable. The reason is structural: lex() consumes a quoted run inside readWord() before the operator scan can see it, so operator detection only ever runs on unquoted text and the command name is words[cursor] of each segment, never a substring of an argument. I did not invent a defect to fix.

What almost certainly refused the notes on 2026-09-17 is the one case where reading inside a double-quoted argument is CORRECT: a backtick. A note that quotes a command the way prose does, with backticks, is legal shell inside double quotes and really does run something, so it is opaque and denied. Single quotes make the same bytes literal and go through. That is shell semantics, not a classifier defect, and loosening it would be a real hole.

So the work is the guarantee rather than a repair. Four parts. (1) The property is written into lex() as a stated contract with its four clauses, so an edit that loses it fails a test instead of failing in somebody notes. (2) The refusal for a backtick inside a double-quoted argument now names the inert spelling; the code (opaque) and the verdict (deny) are byte for byte unchanged, only the detail prose is longer. (3) tests/command-class-quoting.test.ts, 27 cases, including two sweeps over every printable ASCII byte. (4) A new conformance suite, command-class, eleven vectors with three negative controls, generated through scripts/regen-conformance-vectors.mjs and pinned in the manifest.

Global invariants touched, named per CLAUDE.md. Fail closed: unbalanced or unclosed quoting stays unparseable and is pinned by five tests and one negative control; nothing here turns a refusal into a class. Refusals machine-readable and distinct: the backtick detail changed, the code did not, and the conformance suite deliberately pins the code and not the prose so a runtime may keep improving the sentence. Nothing here widens any surface: a quoted path argument to a path-taking command still takes its protected class, pinned by the cp APPROVAL.md trio.

Verification, with the evidence per criterion. node scripts/run-tests.mjs --only command-class command-class-quoting command-class-routing conformance conformance-regen docs-guard cli-hook cli-hook-scope hook-module-graph dogfood exited 0 with 695 tests, 695 pass, 0 fail. node conformance/run.mjs exited 0 over 337 vectors. npm run build, npm run typecheck and npm run lint each exited 0.

AC1 is proved by two named tests, one per quote style: a single-quoted backlog note naming Bash, a placeholder, a pipe and a semicolon is one workspace write, and the same note in double quotes is the same one workspace write. Both assert the class, the rule and the exact word list, so a note that split into two segments or lost a character fails. Two more back them: a quoted note naming a shell is prose, not an invocation, and a quoted argument is never a redirection target.

AC2 is proved by a command substitution inside double quotes still refuses (opaque, detail names vcs.push.main), a backtick inside double quotes refuses and the refusal names the inert spelling, arithmetic expansion inside double quotes still refuses, the same backticks inside SINGLE quotes are literal text, an UNQUOTED redirect, pipe and separator still split exactly as they did, and a quoted operator does NOT split, where the same operator unquoted does. The last pair is the same string twice, quoted and not, which is the only shape that proves the boundary moved nowhere.

AC3: conformance/vectors/command-class.v1.json carries the quoted-argument cases with three negative controls (the double-quoted substitution, the double-quoted backtick, the unclosed quote); conformance/conformance-manifest.json pins its digest; docs/claude-code-hook.md gained the paragraph under What the classifier decides.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Quoted argument text is data, and now it is a tested, documented and conformance-pinned guarantee rather than a property that happened to hold. The reported defect did not reproduce: a sweep of every printable ASCII character through a quoted backlog note, in both quote styles, came back as one workspace-write segment with the note intact, because lex() consumes a quoted run before the operator scan sees it. What refuses such a note in practice is a backtick inside DOUBLE quotes, which the shell really does expand, and that refusal is correct; single quotes make the same bytes literal. So the change states the four-clause contract inside lex(), makes the backtick refusal name the inert spelling without touching its code or its verdict, adds tests/command-class-quoting.test.ts (27 cases, two exhaustive character sweeps) and a new eleven-vector conformance suite with three negative controls, and documents the rule in docs/claude-code-hook.md. Verified: the ten affected suites at 695 tests, 695 pass, 0 fail, exit 0; conformance exit 0 over 337 vectors; build, typecheck and lint exit 0.
<!-- SECTION:FINAL_SUMMARY:END -->
