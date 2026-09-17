---
id: APRV-353
title: >-
  Classifier fidelity: quoted argument text is data, so a backlog note
  containing the word Bash or an angle-bracketed placeholder is not a shell
  invocation or a redirect
status: To Do
assignee: []
created_date: '2026-09-17 03:06'
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
- [ ] #1 approval hook classify on backlog task edit APRV-n --append-notes with a quoted note containing the word Bash, an angle-bracketed placeholder, a pipe character and a semicolon classifies as the backlog edit it is (one segment, files.write.workspace), with tests for single-quoted and double-quoted forms
- [ ] #2 A double-quoted argument containing $(...) or backticks still classifies the substitution (hook-opaque or its class) because the shell expands it; an unquoted redirect or pipe still splits segments as today; tests cover both
- [ ] #3 The conformance vectors gain the quoted-argument cases; build, typecheck, lint and the classifier suites pass; docs/claude-code-hook.md notes that quoted argument text is never read as syntax
<!-- AC:END -->
