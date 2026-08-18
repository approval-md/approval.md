# private/

Private strategic and planning notes. Everything in this directory except this
README is gitignored (`private/*` with `!private/README.md`), so nothing here is
committed, pushed, or served by GitHub Pages.

Why a dedicated directory: the repo is public and the site is served from the
repo root, so `docs/` and every other tracked path is published. There is no
quiet corner inside the tracked tree.

Conventions:

- Store notes in the primary checkout (`approval-md/private/`), never in an agent
  worktree. Worktrees are disposable and an ignored file there is orphaned when
  the worktree is removed.
- Positioning drafts, community and conference references, essay hooks, and
  similar strategy material belong here, as does `LAUNCH.md` (the
  cross-milestone open-threads list, moved here at M5 close, 2026-08-17), and
  `record-example.md` (the record.* worked example and grant-with-choice
  question, moved here 2026-08-18 while the notes-app product thinking is still
  private; it returns to `docs/` when the human decides it is ready).
  Anything intended for publication moves out to `docs/` or the site.
- Credentials never go here. Secrets belong in the vault and `.approval/`
  handling described in CLAUDE.md, and this directory does not change that rule.
- Nothing here is a source of truth. SPEC.md and Backlog.md tasks remain the
  record for design decisions and committed work; a private note may inform a
  task, and the task then carries the decision publicly.
- Agents may read this directory when the human points them at a file, and
  must not summarise its contents into tracked files or task text.
