---
id: APRV-504
title: >-
  Unquoted heredoc bodies are never classified: a $(...) or backtick in the body
  of cat <<EOF runs, yet the segment is read.shell
status: To Do
assignee: []
created_date: '2026-10-07 03:26'
labels:
  - agent-village
dependencies: []
priority: high
ordinal: 387000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found by the APRV-503 lane (2026-10-07) while reading the redirect lexer in src/core/command-class.ts; pre-existing on main, a different code path from the < target fix. lex() consumes every heredoc body with skipHeredocBody and never classifies it ("a body is data, not commands"). That holds only when the terminator is quoted (<<EOF quoted with single or double quotes, or any quoted part). With an UNQUOTED terminator the shell performs parameter expansion, command substitution and arithmetic expansion on the body before the command runs, so cat <<EOF / $(cat ~/.hermes/.env) / EOF reads the credential and cat <<EOF / $(rm -rf ~) / EOF deletes the home, and both classify read.shell (autonomous under the Agent Village template and read.* autonomous policies). Same for a backtick in the body. Probe on main bd5c7562 and on lane/aprv-503-redirect-read: all four of the unquoted-$(), unquoted-backtick, unquoted-rm and quoted-terminator spellings answer read.shell; only the quoted one is right. SPEC §11.1 fail closed. Fix sketch: record whether the terminator word was quoted (LexWord.quoted); for an unquoted terminator scan the body as double-quoted text (readDoubleQuoted semantics: $(...) captured for recursive classification, backticks and $(( )) opaque) and attach the substitutions to the segment so classifySegment runs its existing substitution loop. Quoted terminators keep the inert body.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 cat <<EOF with $(cat ~/.hermes/.env) in the body is refused opaque (the substitution is account.credential), as echo "$(cat ~/.hermes/.env)" is
- [ ] #2 cat <<EOF with $(rm -rf x) or a backtick in the body is refused opaque; $((1+1)) in the body is refused opaque
- [ ] #3 A quoted terminator (<<'EOF', <<"EOF", <<E"OF") keeps the body inert: the same bodies classify read.shell
- [ ] #4 Every existing heredoc fixture in tests/command-class.test.ts and the conformance suite keeps its answer, or the move is named; command-class vectors bumped per conformance/README.md
<!-- AC:END -->
