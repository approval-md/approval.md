# Proposed edits to this repository's APPROVAL.md (APRV-334, APRV-335, APRV-336)

This is a draft for Carter to paste by hand. Agents may not write
`APPROVAL.md` (`policy.core`, human-only), so the edits travel here and the
paste is the human's act. Three tasks contribute a section each; one paste
covers all of them.

## Before you paste

`APPROVAL.md` is attested as a whole file (SPEC §5.2, §5.3). Editing it
changes the file's bytes, so the standing attestation lapses the moment you
save, and every gated intake refuses `policy-not-attested` until you renew it.
Do the edit and the renewal together, in the primary checkout, with the daemon
running:

```bash
approval policy amend
```

Then confirm:

```bash
approval doctor
```

No `policy-not-attested` row means the paste landed. Copy only the replacement
lines shown below, never a surrounding fence: one paste of a proposal page
carried a wrapper fence with it, which hid a block from the loader (APRV-273).

## 1. Stale comments (APRV-334)

Three comments in the policy block describe a rule the line no longer states.
Each entry quotes the current line byte for byte, then its replacement.

### `vcs.push.main`

`supervised` proceeds and is sampled afterwards; "gated by per-task human
review" describes `manual`.

Current:

```yaml
  vcs.push.main:             { autonomy: supervised }   # gated by per-task human review; includes gh pr merge
```

Replace with:

```yaml
  vcs.push.main:             { autonomy: supervised }   # proceeds, sampled for retrospective review; includes gh pr merge
```

### `policy.edit`

Since APRV-198 this file classifies `policy.core`, and `protected_paths`
above routes CI config to `policy.edit.ci`. The built-in `policy.edit` set is
CLAUDE.md, AGENTS.md and .npmrc.

Current:

```yaml
  policy.edit:               { autonomy: supervised-live, live_rate: 0.01 }       # this file, CLAUDE.md, CI config
```

Replace with:

```yaml
  policy.edit:               { autonomy: supervised-live, live_rate: 0.01 }       # CLAUDE.md, AGENTS.md, .npmrc; this file is policy.core, CI is policy.edit.ci
```

### `policy.edit.spec`

The class is declared on the line above the comment, at one in a hundred,
and the comment still says it is undeclared at one in five.

Current:

```yaml
  policy.edit.spec:          { autonomy: supervised-live, live_rate: 0.01 }
    # today it is undeclared, so it falls to the default manual: every SPEC amendment
    # in every task is a tap. The guard, the sign-off convention and retrospective
    # review already cover SPEC prose; one in five live is plenty.
```

Replace with:

```yaml
  policy.edit.spec:          { autonomy: supervised-live, live_rate: 0.01 }       # SPEC amendments: one in a hundred stops for a tap; the guard and retro review cover the rest
```

## 2. Retire the bare `supervised` spelling (APRV-335)

Four class rules in this policy still write the bare `supervised`. Since the
autonomy split (APRV-127) that spelling is an alias of `supervised-retro`, and
as of APRV-335 it is a deprecated one: it still parses, the loader still notes
it, `approval doctor`'s `autonomy-alias` row now names every rule that uses it,
and a future version of the policy schema removes it. Nothing about how these
four rules behave changes here. Each of them proceeds at once and is sampled
for retrospective review today, and does exactly that after the paste; what
changes is that the file states which of the two supervised bargains it means,
so a reader of this policy meets two levels rather than three. No `retro_rate`
is added: these rules sample at `audit.supervised_sample_rate`, and a rate
written here would be a new decision hiding inside a spelling fix.

### `vcs.push.main`

Section 1 above rewrites this line's comment, and the replacement here
supersedes it: paste the "Replace with" line from this section rather than that
one, so the line lands with the corrected comment and the current spelling
together.

Section 1's line, which this supersedes:

```yaml
  vcs.push.main:             { autonomy: supervised }   # proceeds, sampled for retrospective review; includes gh pr merge
```

Current:

```yaml
  vcs.push.main:             { autonomy: supervised }   # gated by per-task human review; includes gh pr merge
```

Replace with:

```yaml
  vcs.push.main:             { autonomy: supervised-retro }   # proceeds, sampled for retrospective review; includes gh pr merge
```

### `vcs.pr.*`

Current:

```yaml
  vcs.pr.*:                  { autonomy: supervised }   # gh pr create / edit / comment on a feature branch
```

Replace with:

```yaml
  vcs.pr.*:                  { autonomy: supervised-retro }   # gh pr create / edit / comment on a feature branch
```

### `policy.edit.design`

Current:

```yaml
  policy.edit.design:        { autonomy: supervised }   # design docs: read in the PR, sampled after
```

Replace with:

```yaml
  policy.edit.design:        { autonomy: supervised-retro }   # design docs: read in the PR, sampled after
```

### `vcs.remote.meta`

Current:

```yaml
  vcs.remote.meta:           { autonomy: supervised }   # gh graphql query, pr update-branch, run rerun (APRV-268)
```

Replace with:

```yaml
  vcs.remote.meta:           { autonomy: supervised-retro }   # gh graphql query, pr update-branch, run rerun (APRV-268)
```

## 3. Values block, version "0.2" (APRV-336)

The values block separated `wants` (what you ask of an agent as behaviour) from
`like` (what the work is graded by). The line between the two has to be
re-decided on every edit, and both lists are read by the same person in the same
way: a request about behaviour and a preference about the output are one kind of
thing. APRV-336 folds `wants` into `like`, renames `responds` to
`communication` (which no longer reads as a sibling of the `approval feedback`
verb), and moves the format version from the integer `1` to the quoted string
`"0.2"`, so both blocks in this file spell their version the same way. The
quotes carry weight: YAML reads a bare `0.2` as a float, and the reader refuses
that by name. Until you paste, `approval values` and the `values-block` row of
`approval doctor` report the live block as unreadable with the code
`version-unsupported`. Nothing else moves: the policy block, every class and
every gate are untouched, because no enforcement path reads a values block (SPEC
§11.1 invariant 10).

`>-` on the current `responds:` line is YAML's folded-scalar marker, which joins
the indented lines below it into one string. It is optional, and the replacement
writes the same sentence as an ordinary quoted string on one line.

The prose line above the block ("Below the policy is a second block the runtime
never enforces...") stays as it is. What is replaced is the fenced block itself,
from its ` ```yaml approval-values ` line through its closing fence. The
four-backtick wrapper below belongs to this page and is not part of the block.

Current:

````yaml
```yaml approval-values
version: 1

love:
  - honest thoughts on what we are building, including when you think I am wrong
  - a journal entry of about five points at the end of each milestone
  - "a tight ship loop: task, plan, diff, tests, PR, merge armed, all in one session"
  - suggestions for changes to APPROVAL.md, tightening or loosening, with the cost you saw that prompted them

like:
  - success reported first, caveats after, in a message that stands on its own
  - a runbook I can paste into a terminal rather than prose about one
  - the real change shown, not a description of it
  - small diffs with one reviewable idea in them

dislike:
  - work that lands without a Backlog task
  - a PR left waiting for a hand click when the merge could have been armed
  - confident documentation that is stale

wants:
  - say when you are stuck rather than guessing a fourth time; the journal is for that
  - tell me when a policy or an instruction reads as wrong, then comply or stop, your call
  - name the window and the full command when you hand me something to run

responds: >-
  I read the journal after a session and react on the samples that reach me.
  Silence is not disapproval. A loved or disliked reaction always carries a
  note saying why; a bare ok means I looked and it was fine.
```
````

Replace with:

````yaml
```yaml approval-values
version: "0.2"

love:
  - honest thoughts on what we are building, including when you think I am wrong
  - a journal entry of about five points at the end of each milestone
  - "a tight ship loop: task, plan, diff, tests, PR, merge armed, all in one session"
  - suggestions for changes to APPROVAL.md, tightening or loosening, with the cost you saw that prompted them

like:
  - success reported first, caveats after, in a message that stands on its own
  - a runbook I can paste into a terminal rather than prose about one
  - the real change shown, not a description of it
  - small diffs with one reviewable idea in them
  - say when you are stuck rather than guessing a fourth time; the journal is for that
  - tell me when a policy or an instruction reads as wrong, then comply or stop, your call
  - name the window and the full command when you hand me something to run

dislike:
  - work that lands without a Backlog task
  - a PR left waiting for a hand click when the merge could have been armed
  - confident documentation that is stale

communication: "I read the journal after a session and react on the samples that reach me. Silence is not disapproval. A loved or disliked reaction always carries a note saying why; a bare ok means I looked and it was fine."
```
````
