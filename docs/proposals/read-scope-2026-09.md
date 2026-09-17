# Proposed edit to this repository's APPROVAL.md (APRV-347)

One line, for Carter to apply by hand or through `approval policy apply`.
Agents may not write `APPROVAL.md` (`policy.core`, human-only), so the edit
travels here and the paste is the human's act.

## What it does

APRV-347 adds `read.file.out_of_scope`: a read whose resolved target falls
outside the gate root, the session scratchpad and the system temp root. Today
this repository's policy has one read line, `read.*: autonomous`, and a
wildcard matches the new class, so **without this edit the new class is
autonomous and the gate is inert**. The edit names it and holds it at `manual`.

The line below is the whole change. It does not add a `read_scope` block: this
repository wants the default roots (its own checkout plus the scratch space),
and a block declaring nothing new would only turn on the Seatbelt read jail for
`approval run` and `approval sandbox`, which is a separate decision and belongs
in its own ceremony once somebody has measured what it breaks here.

## What it costs, honestly

`manual` means a read outside the checkout goes to the phone. In an ordinary
session that is rare — the classifier resolves relative paths against the
checkout, so `cat src/x.ts`, `grep -r TODO .` and `ls` are all inside — but two
habits will hit it:

- reading a file in ANOTHER repository (`cat ~/dev/other/README.md`);
- reading a machine-wide file (`cat /etc/hosts`, `head ~/.zshrc`).

If those turn out to be frequent enough to be noise rather than signal, the
softer line is `supervised-retro` (proceeds, sampled afterwards), which still
puts every out-of-scope read in the log and in the retro sample. Start at
`manual` for a week and look at the queue before deciding.

The `Read`, `Glob` and `Grep` tool gate is NOT turned on by this edit either.
It needs those three tools added to the `PreToolUse` matcher in
`.claude/settings.json`, which is `policy.core` and a separate human act; the
cost there is a Node process start per read, and `docs/claude-code-hook.md`
says so beside the matcher.

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
  files.delete.out_of_scope: { autonomy: manual }
```

Replace with:

```yaml
  files.delete.out_of_scope: { autonomy: manual }
  read.file.out_of_scope:    { autonomy: manual }       # a read resolving outside this checkout, the scratchpad and the temp root (APRV-347)
```

The anchor is `files.delete.out_of_scope` rather than the `read.*` line
because the two are siblings: one is the delete that leaves the workspace and
the other is the read that leaves it, and a reader of the policy should find
them together.

## After you paste

`approval hook classify -- "cat /etc/hosts"` prints `read.file.out_of_scope`,
and `approval policy check read.file.out_of_scope` prints `manual` with the
effective roots on the decision path. Before the paste, the same two commands
print the class and `autonomous`, which is the state this page exists to
change.
