# Backlog.md format fixtures (APRV-65)

**Generated. Do not hand-edit** — including this file, which
`scripts/regen-backlog-fixtures.mjs` writes. Change the script, then
regenerate.

These are real files written by the pinned Backlog.md CLI, captured after each
of a scripted sequence of canonical operations. approval.md extends the
Backlog.md convention and never forks it (SPEC.md principle 6, §12), so the
task-file format is a dependency this repository cannot express in
`package.json`. This corpus is how it is pinned: upstream format drift fails
a test here instead of quietly eating a user's envelope.

## Regeneration

```bash
node scripts/regen-backlog-fixtures.mjs
```

Requires Backlog.md CLI **1.49.3** on `PATH` (see
`docs/backlog-md-pin.md`). The exact version is recorded in `VERSION`
beside this file, and `tests/backlog-fixtures.test.ts` asserts it agrees
with the pin recorded in that document.

## Scenarios

- **`init/`** — `backlog init --defaults --no-git`: the project config the CLI writes.
- **`create/`** — `task create` with title, `--description`, two `--ac`, `--labels`, `--priority`.
- **`edit-status-assignee/`** — `task edit -s 'In Progress' -a '@agent-claude'`: status, assignee, and the first `updated_date`.
- **`check-ac/`** — `task edit --check-ac 1`: an acceptance criterion flips to `[x]` in place.
- **`append-notes/`** — `task edit --append-notes`: the `## Implementation Notes` section and its `SECTION:NOTES` markers.
- **`final-summary/`** — `task edit --final-summary`: the `## Final Summary` section and its markers.
- **`milestone-assign/`** — `milestone add` then `task edit -m`: the milestone file, and the `milestone:` key's position in task frontmatter.
- **`subtask/`** — `task create -p TASK-1`: the `parent_task_id` key and the `task-1.1` id/filename shape.
- **`dependency/`** — `task create --dep TASK-1`: the `dependencies:` sequence.
- **`envelope-edit-before/`** — A task with a hand-written SPEC §6.1 `approval:` envelope spliced into its frontmatter, before the CLI touches it.
- **`envelope-edit-after/`** — The same file after `task edit -s 'In Progress'`. See the envelope note below: at the pinned version the CLI **drops** the unknown key.

## Normalisation rule

The CLI stamps wall-clock timestamps, so raw capture would never be
reproducible. After capture, and before any comparison, these fields — and
only these — are rewritten:

- `created_date` (wall-clock stamp written by the CLI at task creation) → `'2000-01-01 00:00'`
- `updated_date` (wall-clock stamp rewritten by the CLI on every edit) → `'2000-01-01 00:00'`

Timestamps are not the only way ambient state leaks in. The CLI copies
environment values such as `$EDITOR` into `config.yml`, so the script runs
it with a **replaced** environment and a throwaway `HOME`: no user config, no
editor, no locale, fixed `TZ`. That is why the corpus is reproducible on a
machine whose shell differs from yours.

The rule list lives in `NORMALISATION_RULES` in the regeneration script and
runs on **both** sides of the drift comparison. It is line-anchored and names
each field explicitly, so a newly volatile field surfaces as a drift failure
rather than being absorbed. If two regenerations differ, the normaliser is
missing a field: add a rule, never loosen the comparison.

## The envelope scenarios

`envelope-edit-before/` holds a task file with a SPEC §6.1 `approval:`
envelope spliced into its frontmatter by hand (the CLI has no notion of the
key). `envelope-edit-after/` is the same file after `backlog task edit`.

**At 1.49.3 the CLI drops the `approval:` key entirely.** That is
what the fixture records: observed behaviour, not desired behaviour. SPEC.md §6
requires implementations to preserve unknown frontmatter keys; Backlog.md does
not, which is the whole reason envelope-loss detection (APRV-63) exists. A
future CLI version that preserves the key will fail the fixture comparison —
correctly. Flip the fixture deliberately at that point, in the same change that
bumps the pin, and say so in the task notes.

## Upgrading the pin

Bumping the Backlog.md pin regenerates this corpus **in the same commit**. A
version bump whose fixture diff is empty is a bump nobody verified; a version
bump with no fixture diff at all means the corpus was not regenerated.
