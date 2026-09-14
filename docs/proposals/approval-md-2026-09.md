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

Pending: APRV-335 appends this section.

## 3. Values block, version 2 (APRV-336)

Pending: APRV-336 appends this section.
