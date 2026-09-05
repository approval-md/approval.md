# Proposed values block for this repository's APPROVAL.md (APRV-240)

This is a draft for Carter to paste by hand. Agents may not write
`APPROVAL.md` (`policy.core`, human-only), so the block travels here and the
paste is the human's act.

## Before you paste

`APPROVAL.md` is attested as a whole file (SPEC §5.2, §5.3). Pasting the block
changes the file's bytes, so the standing attestation lapses the moment you
save, and every gated intake refuses `policy-not-attested` until you renew it.
Do the two steps together, in the primary checkout, with the daemon running:

```bash
approval policy amend
```

(`approval policy attest` is the shorter form when nothing but the values block
changed and you want to sign the bytes as they are.) Then confirm:

```bash
approval doctor
```

`values-block: pass` and no `policy-not-attested` row means the paste landed.
`approval values` prints what agents will see.

## Where it goes

Below the ` ```yaml approval-policy ` block, after its closing fence. Prose
between the two blocks is fine and is ignored by both parsers.

## The block

The content below is a starting point drawn from what you have said in
sessions. Edit freely; the shape is the deliverable, the words are yours.

````markdown
Below the policy is a second block the runtime never enforces. It is what I
value, for agents that want to know; `approval values` prints it.

```yaml approval-values
version: 1

love:
  - honest thoughts on what we are building, including when you think I am wrong
  - a journal entry of about five points at the end of each milestone
  - "a tight ship loop: task, plan, diff, tests, PR, merge armed, all in one session"

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

## Why these words

- `love` holds the three things named as the reason for this feature: honest
  opinions, per-milestone journals, and the ship loop CLAUDE.md already asks for.
- `like` restates the attention bar the repo's session practices already assume.
- `dislike` names the three failure modes CLAUDE.md's workflow section exists to
  prevent, so the block and the workflow prose agree.
- `wants` is behaviour the human asks for, phrased as requests. Nothing in it is
  enforced; SPEC §11.1 invariant 10 keeps it that way.
- `responds` tells an agent how to read silence, which is the one thing a block
  of preferences cannot otherwise convey.
