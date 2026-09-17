# Proposed edit to this repository's APPROVAL.md (APRV-352)

One line, for Carter to apply by hand or through `approval policy apply`.
Agents may not write `APPROVAL.md` (`policy.core`, human-only), so the edit
travels here and the paste is the human's act.

```sh
approval policy apply docs/proposals/vcs-ref-delete-2026-09.md --pr
```

## What it does

APRV-352 adds `vcs.ref.delete`: a `git push` that removes a remote ref, whether
by `--delete`, by `-d`, or by a colon refspec such as `:refs/heads/x`, and
whether it names one ref or two hundred. Until now those commands classified
`vcs.push.main`.

This repository holds `vcs.push.main` at `supervised-retro`, which means they
proceeded unasked and entered the retrospective sample. That is the right price
for a trunk push and the wrong one for a deletion. APRV-318's branch-deletion
driver found 233 remote branches queued behind one command; had it run, 233
irreversible removals would have been reviewed after the fact. The driver works
around it today by demanding a grant record before `--execute`.

The line below holds the new class at `manual`: every remote ref deletion goes
to the phone, with the ref names in the prompt.

## What it costs, honestly

`manual` means a tap per deletion command, not per ref. A bulk cleanup is one
question naming every branch it would remove, which is the shape this class
exists to produce: the refs are bound to the action, so the prompt says what
disappears.

The habits that will hit it are branch tidying after a merge (`git push origin
--delete lane/x`) and the reconcile script. If a tap per cleanup turns out to be
noise rather than signal, the softer line is `supervised-retro`, which is
exactly where the class sits today under a different name and is therefore no
worse than the status quo. Starting at `manual` is the point of the task.

Three things it does **not** change:

- a force push stays `vcs.history.rewrite`, `human-only` in this policy, even
  when the same command deletes;
- a **tag** deletion stays `release.publish` at `manual`, because the name a
  release was published under is a release surface however it is removed;
- an ordinary push keeps `vcs.push.branch` or `vcs.push.main` exactly as it is.

## It is already safe without this line

The class ships in the classifier ahead of this paste, and that is deliberate
rather than a gap. A class no policy rule matches resolves to
`defaults.autonomy`, which in this file is `manual`, so between the merge and
the paste every remote ref deletion is already **stricter** than it was
yesterday, not looser. The paste makes the line explicit, gives it a comment a
reader can find, and stops a future `vcs.*` wildcard from quietly absorbing it.

## Before you paste

`APPROVAL.md` is attested as a whole file (SPEC §5.2, §5.3). Editing it changes
the file's bytes, so the standing attestation lapses the moment you save, and
every gated intake refuses `policy-not-attested` until you renew it. Do the edit
and the renewal together, in the primary checkout, with the daemon running:

```bash
approval policy amend
```

Then confirm with `approval doctor`: no `policy-not-attested` row means the
paste landed. Copy only the replacement lines shown below, never a surrounding
fence (APRV-273).

## The edit

Current:

```yaml
  vcs.history.rewrite:       { autonomy: human-only }   # a person rewrites shared history, never an agent (APRV-185)
```

Replace with:

```yaml
  vcs.history.rewrite:       { autonomy: human-only }   # a person rewrites shared history, never an agent (APRV-185)
  vcs.ref.delete:            { autonomy: manual }       # git push --delete / -d / :refspec: removing a remote branch, refs named in the prompt (APRV-352)
```

The anchor is `vcs.history.rewrite` rather than `vcs.push.main` because the two
are siblings in consequence: one moves shared history and the other removes a
ref outright, and a reader of the policy should find the destructive pair
together.

## After you paste

`approval hook classify -- "git push origin --delete feature/x"` prints
`vcs.ref.delete` with `feature/x` bound, and `approval policy check
vcs.ref.delete` prints `manual` with `vcs.ref.delete` as the matched pattern on
the decision path. Before the paste the same two commands print the class and
`manual` from `defaults.autonomy`, with no matched rule — which is the
difference this page exists to close.

`scripts/reconcile-delete-merged-branches.mjs` keeps its grant-record check
until this line is applied; its `--plan` output says so, and removing the check
is a separate decision under APRV-318 rather than a consequence of this paste.
