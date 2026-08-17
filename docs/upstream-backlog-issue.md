# Draft upstream issue for Backlog.md (for human review, not filed)

Title: `task create --milestone` silently creates a milestone when the value
matches nothing

Body:

Passing `--milestone <value>` to `backlog task create` attaches the task to a
milestone even when no milestone with that id or title exists. The value
becomes a "virtual" milestone: it appears in `backlog milestone list` with
itself as its display name, has no file under `backlog/milestones/`, and
`backlog milestone rename` cannot find it.

Observed sequence (real incident in our repo):

1. `backlog milestone add "M3.1 - Consolidation review and retrofit"` creates
   `m-4`.
2. `backlog task create ... -m m-3.1` (operator intended the new milestone,
   typed a shorthand) attaches three tasks to a virtual milestone literally
   named `m-3.1`.
3. `m-4` completes at 0/0 while `m-3.1 (3/3 done)` appears in listings;
   `backlog milestone remove m-4` then leaves the virtual one unreachable by
   `rename`.

Suggestion: `--milestone` values that match no existing milestone id or title
should be an error by default (with perhaps `--create-milestone` to opt in).
Silent creation turns a typo into permanent bookkeeping drift, since tasks
carry the value in frontmatter and history-editing is undesirable.

Happy to PR the check if the direction sounds right.

---

# Draft upstream issue 2 for Backlog.md (for human review, not filed)

Title: `task edit` drops frontmatter keys it does not own (unknown keys are
not round-tripped)

Body:

`backlog task edit` rewrites the task file's frontmatter from the CLI's own
model, and any top-level key it does not recognise is dropped. Task files are
plain markdown by design, which invites other tools to add namespaced keys;
today any such key is silently lost on the next edit.

Reproduction against Backlog.md CLI 1.49.3 (`backlog --version`):

```sh
mkdir repro && cd repro
backlog init --defaults --no-git --integration-mode none
backlog task create "Chase deposit refund" --description "test"
# splice a foreign top-level key into the frontmatter, before the closing ---
python3 - <<'PY'
import glob
p = glob.glob("backlog/tasks/task-1 - *.md")[0]
s = open(p).read()
s = s.replace("\n---\n", "\napproval:\n  origin:\n    app: example-capture\n  state: awaiting\n---\n", 1)
open(p, "w").write(s)
PY
grep -c "^approval:" backlog/tasks/task-1\ -\ *.md    # 1
backlog task edit TASK-1 -s "In Progress"
grep -c "^approval:" backlog/tasks/task-1\ -\ *.md    # 0: the key is gone
```

Expected: `status` updated, `updated_date` added, and the `approval:` key
left exactly as it was. Observed (1.49.3): the whole `approval:` block is
removed; every key the CLI knows is preserved and nothing else is.

Why it matters: the file format is the interchange surface for tools that
extend Backlog.md rather than fork it. A rewrite that preserves only known
keys makes every extension one edit away from data loss.

Suggestion: on rewrite, preserve unknown top-level keys (and, ideally, their
position and formatting) alongside the keys the CLI manages. If that is
undesirable by default, a documented flag or a config option to preserve
unknown keys would still let extensions coexist. Happy to PR the change if
the direction sounds right.

Context: this reproduction is a committed fixture pair in the approval.md
repository (`tests/fixtures/backlog/envelope-edit-before/` and
`envelope-edit-after/`), captured by a script that regenerates it against
the pinned CLI version, so a future release that preserves the key flips a
test deliberately.
