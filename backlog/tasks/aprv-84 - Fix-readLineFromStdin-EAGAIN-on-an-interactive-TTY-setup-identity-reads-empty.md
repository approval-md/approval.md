---
id: APRV-84
title: >-
  Fix readLineFromStdin EAGAIN on an interactive TTY (setup identity reads
  empty)
status: In Progress
assignee:
  - Claude
created_date: '2026-08-18 11:14'
updated_date: '2026-08-18 11:21'
labels:
  - bug
  - cli
dependencies: []
ordinal: 80000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
On macOS, `approval setup identity` returned "no identity was entered; nothing was written" the instant the prompt appeared, without waiting for input (found running examples/email-demo.md, 2026-08-18). Root cause: the setup verbs check `process.stdin.isTTY`, and merely accessing `process.stdin` on a TTY has libuv put fd 0 into non-blocking mode. `readLineFromStdin` in src/cli/prompt.ts then calls `readSync(0)` before the user has typed, gets EAGAIN, and its bare `catch` treats that as EOF and returns null. `readSecret` in the same file already handles EAGAIN with `continue` (so token/password prompts work); `readLineFromStdin` does not, so every readLine prompt on a real terminal is broken: setup identity, the setup vault overwrite confirmation, setup adapter probes/choices, and the interactive confirm in `approval amend`. Reproduced with `( sleep 1; printf x\\n ) | script -q /dev/null node -e "process.stdin.isTTY; fs.readSync(0,...)"` -> EAGAIN.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 readLineFromStdin treats EAGAIN as "nothing yet" and keeps waiting (like readSecret), and does not spin a hot loop while waiting
- [x] #2 Both readers share the one blocking-byte-read helper so the EAGAIN handling exists in one place
- [x] #3 A unit test covers the EAGAIN-then-data path for readLineFromStdin via an injectable readSync
- [ ] #4 Verified by hand: approval setup identity on a macOS terminal waits for and accepts human:carter
- [x] #5 npm test and lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add `readByteBlocking(buffer)` to src/cli/prompt.ts: readSync(0, buffer, 0, 1, null); on EAGAIN, sleep ~10ms via Atomics.wait on a SharedArrayBuffer and retry; any other error or 0 bytes is EOF/abort as before.
2. Route readLineFromStdin and readSecret through it (readSecret keeps its abort-on-other-error semantics).
3. Add a test that injects a readSync stub returning EAGAIN twice then bytes, asserting readLineFromStdin returns the line. Existing prompt tests unchanged.
4. Rebuild, hand-verify `approval setup identity` on a macOS terminal (the email demo run).
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Root cause confirmed by reproduction: after `process.stdin.isTTY` is read, `readSync(0)` on a real pty raises EAGAIN until a keystroke arrives (65 EAGAINs over ~0.5s in the test). `readSecret` already looped on EAGAIN; `readLineFromStdin` swallowed it as EOF, so every readLine prompt on a terminal returned null: setup identity, the setup vault overwrite confirm, the setup adapter config/choice prompts and probe question, and amend's interactive confirm.

Fix: one `readByteBlocking(buffer)` helper in src/cli/prompt.ts (readSync; on EAGAIN, `Atomics.wait` 5ms and retry; anything else propagates; 0 = EOF). Both readers take a `ByteReader` parameter defaulting to it, which is also the test seam.

Tests: tests/cli-prompt.test.ts. Two byte-loop cases through an injected reader, and one that spawns node under `expect` so fd 0 is a real pty with the keystroke arriving 0.5s late. `script(1)` was tried first and rejected: on macOS it sends EOT the instant its own stdin is a pipe, so the reader legitimately saw EOF. The tty case fails without the fix (LINE=null) and passes with it; skips loudly where expect is absent. Full suite 1511 pass; the one failure (ci-guard: better-sqlite3 engines) is pre-existing on main and comes from a local node_modules at 13.0.2 vs the pinned 12.11.1, untouched here.

Found while running examples/email-demo.md for APRV-70; AC 4 (hand verification on the terminal) is the demo's next step.
<!-- SECTION:NOTES:END -->
