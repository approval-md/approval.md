# Session handover

Written 2026-08-19 at the close of the second long session (M5 through most of
M8). Read CLAUDE.md first, then SPEC.md in full, then MILESTONES.md. This file
covers what those three do not. It replaces the founding-session handover,
which was retired at M5 close; a handover is orientation for the NEXT session
and should be retired again once M8 closes.

## Current state (verified at write time)

- main at `667ed76` (Merge APRV-91). 1733 tests, lint and typecheck clean.
- The live log verifies clean at seq 26. Policy attested at seq 13.
- Milestones: M0–M7 and M7.1 done. **M8 (`m-11`, "MCP wrapper and harness
  hooks") is in flight**: 85 (instructions/registry), 86 (SDK through the
  gate, seq 18–25), 87 (MCP server), 82 (Claude Code hook) are Done and on
  main; 88's agent half is on main; 91's ACs 1–5 are on main.
- `@modelcontextprotocol/sdk@1.30.0` is a pinned runtime dependency, added
  through the gate by human grant (the third real dogfood).
- The human's own worktree sessions file tasks in parallel (APRV-81, 82, 83,
  84, 94, 95, 97, 98, 99, 100, 101 came from them). Expect more; pull before
  anything and drive PRs BY BRANCH NAME (`gh pr view <branch>`), never by
  number: numbers race across sessions and two merge commits in history are
  mislabeled from exactly that mistake.

## Open work, in dependency order

1. **APRV-93 and APRV-91 are closed** (2026-08-19, third session). PR by
   branch `aprv-93-legibility` landed after a merge of main (one conflict,
   `MCP_HELP`), a TTY-independent wordmark test, and the ASCII collapse of the
   banner. 91's ACs 8/13 and 9/14 are partial and left unchecked; the
   remainder is **APRV-102** (refusal shape beyond the gate, log tail table,
   `--verbose`, token panel, shared table helper). The review of M8 under the
   degraded context found SPEC lagging the code in four places: **APRV-103**
   (human sign-off). **APRV-104** is the close-out hygiene (stale worktrees,
   retiring this file). APRV-101's evidence is on its notes.
2. **APRV-88 AC 2 needs the human**: run `examples/mcp-demo.md` once against a
   real MCP client (Claude Code) and the phone; record the seq range on
   APRV-88; then Done.
3. **APRV-89 README holistic pass** — last in M8, after 93 lands (it quotes
   final transcripts). Pairs with the launch post in `private/LAUNCH.md`.
4. **APRV-101 (human-filed, HIGH)**: the hook writes to the worktree log when
   invoked from a worktree because `--dir` scopes only the policy. Decision
   already made with the human: ONE log; the hook appends to the primary
   checkout's log and refuses closed when it cannot. Not started.
5. APRV-99, 100 (human-filed setup/telegram polish), 57, 58 (M5 leftovers):
   independent, low.
6. Then M8 closes: MILESTONES.md row → done, records PR, M8 report.

## Things a fresh session should know that live nowhere else

- Cadence that worked: fable orchestrates and reviews; Opus subagents build in
  isolated worktrees from main (or from a not-yet-merged branch when they
  need it: `git fetch origin && git merge origin/<branch> --no-edit` first);
  every PR merges through auto-merge behind the strict `ci` gate; backlog
  records land as record-only PRs; per-task notes are written by fable via the
  backlog CLI in the PRIMARY checkout (subagents never touch backlog/).
- The primary checkout's `.approval/QUEUE.md` is rewritten live when the
  human's daemon is running; `git checkout -- .approval/QUEUE.md` before any
  branch switch. Never `git pull` with uncommitted record edits: it fails
  silently and leaves the checkout behind (that cost one confusing hour).
- Worktrees have no `node_modules`; symlink the primary's for a local test run
  and remove the symlink before pushing. The `ci-guard` engines test needs a
  real `node_modules` and fails closed without one, by design.
- Gate operations run ONLY in the primary checkout (`/Users/carter/dev/
  approval-md`), never in a worktree (see APRV-101 for what happens
  otherwise). The task file carries the envelope (a direct frontmatter edit,
  the one edit the backlog CLI cannot express); register/request there; the
  human grants; `approval run` executes; the human commits the log advance via
  a branch and PR (the APRV-92 flow, not a bypass push).
- SPEC amendments pending human sign-off, drafted by builders and flagged in
  task notes: §10.1 setup/instructions/mcp lines, §10.3 channel-vs-adapter
  setup nouns, §10.4 interactive vault writer, §10.5 (APRV-88 rewrite),
  §5.2 environment map + telegram names, §11 no-implicit-config paragraph,
  §11.1 invariant 7. CLAUDE.md's Engineering-invariants list still needs the
  invariant-7 bullet (drafted in APRV-73's notes; CLAUDE.md is the human's).
- `docs/record-example.md` lives in `private/` (untracked) by human ruling
  while the notes-app thinking is private; APRV-80's five spec tensions stay
  on record in its notes and feed the v0.2 spec pass.
- Dates: verify against created_date or the log, never your own sense of
  elapsed time (APRV-46). Cold reads sample task notes as well as code.
