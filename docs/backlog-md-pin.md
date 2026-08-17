# Backlog.md: pinned version and upstream-risk posture (APRV-52)

approval.md extends the Backlog.md convention and never forks it (SPEC
principle 6). Backlog.md is not a code dependency of this package: it has no
entry in `package.json`, and the runtime parses task files with this repo's
own frontmatter code (`src/core/frontmatter.ts`). The coupling is the
plain-markdown file convention in `backlog/` plus the dev-workflow CLI.

## Pinned CLI version

The project is validated against **Backlog.md CLI 1.49.3**.

Install exactly that version via npm (the reproducible path):

```bash
npm install -g backlog.md@1.49.3
```

The current dev machine install is Homebrew (`backlog-md`). Homebrew tracks
latest, so hold it in place:

```bash
brew pin backlog-md
```

## Upgrades are deliberate

Never upgrade the CLI casually. To adopt a new version:

1. Read the upstream changelog for task-file format changes.
2. Upgrade in one machine, run `npm test` (once the M6 round-trip suite
   exists, it is the drift detector; see the gap note below).
3. Exercise the workflow verbs this repo depends on (`task create`,
   `task edit`, `task view --plain/--json`, `search`) against a scratch task
   and confirm the written markdown round-trips through our parser.
4. Update the pinned version in this file in the same change.

## Archival mirror (disaster recovery only)

A bare mirror of https://github.com/MrLesk/Backlog.md is kept as insurance
against upstream deletion. It is a snapshot for disaster recovery: we never
develop on it, never build from it, and never publish it, unless upstream
vanishes. Refresh it occasionally with `git remote update` inside the mirror.

## Known gap (recorded at APRV-52, 2026-08-14)

The M6 round-trip fixture suite does not exist yet; `src/core/frontmatter.ts`
is read-only today (unknown-key preservation is deferred to M6 by design).
Until M6 lands, CLI format drift is caught by the manual checks above rather
than by `npm test`.
