---
id: APRV-282
title: 'doctor live-draw tests the daemon socket with a connect, not a stat'
status: In Progress
assignee:
  - '@opus-doctor'
created_date: '2026-09-06 07:19'
updated_date: '2026-09-06 08:44'
labels:
  - doctor
dependencies: []
type: bug
ordinal: 208000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
On 2026-09-05 the daemon had exited but .approval/daemon/draw.sock remained on disk; doctor's live-draw row reported the socket present and owner-only, and the operator concluded the gate was up while every Telegram tap sat unconsumed. A stale socket file is the normal aftermath of a process that died; presence proves nothing. Connect to the socket (and close) and report connected, refused (stale file: name the pid file or mtime), or absent.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 live-draw reports fail with fix "approval up" when the socket file exists but refuses connections
- [x] #2 live-draw passes only on a successful connect; tests cover present-and-listening, present-and-refusing, absent
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read doctor's checkLiveDraw, the socket checks in src/core/live-draw.ts, and the APRV-271 dialDrawSocket client added on the previous commit. 2. Keep every check the row already makes, in order, and add one after them: dial the socket and hang up. dialDrawSocket takes a null request for exactly this, connecting and closing without saying a word, so the row still asks the daemon nothing. 3. A refusal is a fail whose detail names the socket's mtime, since a leftover socket's last write is when its daemon was last alive, and whose fix begins with approval up. A successful connect is the only pass. 4. checkLiveDraw becomes async and is awaited in the assembly; the check ordering is untouched. 5. Document the three failure shapes in the cli-reference doctor bullet. 6. Three tests in tests/cli-doctor.test.ts on the short socket path: present-and-listening against the fake daemon, present-and-refusing against a socket inode made by binding one path, renaming the file and closing so libuv's unlink misses it, and absent. 7. Build, run the doctor suite, lint, typecheck.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
checkLiveDraw now dials the socket. Every check it already made is kept and in the same order (no live class is still a skip; no socket file is still the absent fail; a foreign owner or a group- or world-reachable mode is still refused on sight), and one check is added after them: open a connection and hang up. dialDrawSocket, added on the APRV-271 commit for the sampling client, takes a null request for exactly this, so the row still asks the daemon nothing — no question is sent, no answer is waited for.

A refusal is a fail whose detail names the socket file's mtime, because a leftover socket's last write is when its daemon was last alive, and whose fix begins with approval up. The row's only pass is a connection that was accepted.

checkLiveDraw became async and is awaited in the assembly. The check ordering rule in doctor.ts is untouched: nothing was inserted or reordered, and no row was added.

The refusing-socket fixture is worth a note, because there is no way to make a socket inode except by binding one. staleSocket binds one path, renames the file to the path doctor will look at, then closes the server: libuv unlinks the path it bound, which no longer exists, so the inode survives with no listener and connecting to it is refused. That is exactly the aftermath of a daemon that was killed rather than stopped, which is the state the row used to read as healthy.

Both socket-bearing fixtures live under a short scratch root (ad-XXXXXX rather than approval-md-cli-doctor-XXXXXX), because sockaddr_un.sun_path is 104 bytes on macOS and core/live-draw.ts refuses anything past 100. socketHomeWithAudit asserts the derived path is inside that limit, so a future rename of the fixture directory fails loudly rather than turning every socket case into an unrelated absent-daemon result.

Touches no global invariant: a read-only diagnostic that appends nothing, sends nothing and authorizes nothing. It reaches one local socket to close it again.

A process note for the orchestrator: this task's file was not in this worktree. HEAD here is 30e4899 (main), not the 02b0af3 the brief named as the base, and APRV-280..284 were filed on 02b0af3, which lives on overnight-backlog-wave. backlog task view could read it across branches (check_active_branches is on) but backlog task edit refused it as not found, so the file was brought over with a checkout of that one path. If overnight-backlog-wave also merges, this path will want a trivial conflict resolution.

Validation: npm run build; node --test dist/tests/cli-doctor.test.js 64 pass 0 fail exit 0 (61 before this task, 3 new); the three new cases confirmed by name — 'live-draw passes only on a socket that accepts a connection', 'a socket file nothing is listening on fails, and names when it was written' (which also asserts the run exits 1 and the fix starts with approval up), and 'no socket at all is still the absent failure, with its own fix'. cli-long-help and docs-guard 39 pass 0 fail. npm run lint and npm run typecheck clean.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
doctor's live-draw row connects to the daemon socket and closes again, instead of stopping at a stat. A socket file is made by a bind and removed by an orderly shutdown, so its presence cannot report the one state that matters — a daemon that died — which on 2026-09-05 left the row green while every Telegram tap sat unconsumed. A refusal is now a fail naming the file's mtime with approval up as the fix; the only pass is an accepted connection; the absent and unusable-socket failures are unchanged, as is the check ordering. Verified with three new cli-doctor cases covering present-and-listening, present-and-refusing (against a real orphaned socket inode made by binding, renaming and closing) and absent: 64 pass, 0 fail, exit 0.
<!-- SECTION:FINAL_SUMMARY:END -->
