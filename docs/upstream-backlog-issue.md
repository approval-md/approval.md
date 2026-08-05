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
