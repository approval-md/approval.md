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
2. Upgrade on one machine and run `npm test`. The drift guard in
   `tests/backlog-fixtures.test.ts` compares the committed fixture corpus
   against what the newly installed CLI produces; a format change shows up as
   a per-file diff there (see the fixture corpus below).
3. Exercise the workflow verbs this repo depends on (`task create`,
   `task edit`, `task view --plain/--json`, `search`) against a scratch task
   and confirm the written markdown round-trips through our parser.
4. Update the pinned version in this file, in `PINNED_VERSION` in
   `scripts/regen-backlog-fixtures.mjs`, and regenerate the corpus, all in the
   same change. `tests/fixtures/backlog/VERSION` must name a version this
   document mentions; a test asserts it.

## Format fixture corpus (APRV-65)

`tests/fixtures/backlog/` holds real task files written by the pinned CLI,
captured after each of a scripted sequence of canonical operations
(create, edit, check-ac, notes, final summary, milestone assign, subtask,
dependency, and the `approval:` envelope before and after an edit).

```bash
node scripts/regen-backlog-fixtures.mjs
```

The script runs the CLI only inside a throwaway temp project, never against
this repository's `backlog/` tree. Wall-clock stamps (`created_date`,
`updated_date`) are normalised to a fixed sentinel by a documented rule list in
the script, which runs on both sides of the comparison. The corpus README
explains each scenario. Two properties the corpus records are worth naming
here: the CLI at 1.49.3 **drops** an unknown `approval:` frontmatter key on
`task edit` (SPEC.md §6 requires preservation; this is the APRV-60
reproduction), and the drift guard **skips with a stated reason** when the CLI
is absent or is not the pinned version, so a runner without it stays honest.

## Archival mirror (disaster recovery only)

A bare mirror of https://github.com/MrLesk/Backlog.md is kept as insurance
against upstream deletion. It is a snapshot for disaster recovery: we never
develop on it, never build from it, and never publish it, unless upstream
vanishes. Refresh it occasionally with `git remote update` inside the mirror.

## Known gap (recorded at APRV-52, 2026-08-14; narrowed at APRV-65)

`src/core/frontmatter.ts` is still read-only: unknown-key preservation lands
with the M6 writer (APRV-61), and envelope-loss detection with APRV-63. Until
those land, the corpus proves what the CLI *writes* and that our parser reads
it, but nothing in this repository yet round-trips a task file back out. The
corpus is the input those tasks must be tested against, rather than
hand-written files.
