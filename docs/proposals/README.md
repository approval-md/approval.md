# Policy proposals

Agents may not write `APPROVAL.md`. It is `policy.core`, and this project's
policy holds that class human-only, so a policy change an agent proposes travels
as a document in this directory and a human applies it:

```sh
approval policy apply docs/proposals/<name>.md --pr
```

The verb parses the pairs, refuses before touching anything if any quoted
current text is absent or not unique, prints the replacements, asks, writes the
file, and runs `approval policy amend` so the edit and its attestation land as
one commit. `docs/cli-reference.md#policy-apply` is the full contract; this page
is what a proposal author needs.

## What the verb reads

Everything else on the page is prose for the human. What the applier reads is
**fenced blocks with a declared language**, each introduced by a label on the
line above it:

| label | means |
|---|---|
| `Current:` | the bytes exactly as they stand in the live policy |
| `Replace with:` | what those bytes become |
| `Supersedes:` | optional: an earlier section's *result*, matched instead |

A `Current` block and the `Replace with` block after it are one **pair**. Pairs
apply in document order.

````markdown
### `vcs.pr.*`

Current:

```yaml
  vcs.pr.*:                  { autonomy: supervised }   # gh pr create / edit / comment
```

Replace with:

```yaml
  vcs.pr.*:                  { autonomy: supervised-retro }   # gh pr create / edit / comment
```
````

## Four rules that decide whether a proposal applies

**1. Declare the language.** A fence with no info string is skipped entirely.
This is APRV-273: a bare fence once swallowed a block the loader then never saw,
and the rule turns that hazard into something the parser can act on. Write
` ```yaml `, not ` ``` `.

**2. Quote enough to be unique.** The quoted current text must occur exactly
once in the live policy. One occurrence applies; none is `proposal-stale` (the
file moved since you wrote the proposal, so rewrite it against the live file);
more than one is `proposal-ambiguous`, and the repair is to quote surrounding
lines until it is unique.

**3. Fence a fence with more backticks.** To quote a block that contains a
fence — a whole `yaml approval-values` block, say — open your fence with four
backticks. The applier matches a closer of at least the opener's length, so the
inner fences are content and the wrapper is the wrapper.

**4. Declare supersession; never imply it.** When a later section rewrites a
line an earlier section in the same document already rewrote, quote the earlier
section's *replacement* under a `Supersedes:` label. The applier looks for that
text when the section's own `Current` block is no longer in the file, which is
exactly the state the earlier section left behind:

````markdown
Section 1's line, which this supersedes:

```yaml
  vcs.push.main:             { autonomy: supervised }   # proceeds, sampled for review
```

Current:

```yaml
  vcs.push.main:             { autonomy: supervised }   # gated by per-task human review
```

Replace with:

```yaml
  vcs.push.main:             { autonomy: supervised-retro }   # proceeds, sampled for review
```
````

Both spellings present in the file at once is `proposal-ambiguous`: which of
them the file means is a question, and no verb here answers it.

## What the verb will not do

**It will not take a whole-file replacement.** Every byte it writes is anchored
to a byte it proved present in the live file, which is what makes a stale
proposal a refusal instead of a silent revert of somebody else's amendment. A
proposal that wants the whole file replaced is a paste, and
`approval policy amend` over a hand-edited file is the supported way to do that
deliberately.

**It will not treat the values block differently.** The applier does not parse
the policy and does not know which fenced block a pair lands in, so a values
pair and a policy pair travel the same path. The values block is inert (SPEC
§11.1 invariant 10) and the attestation covers the whole file's bytes either
way.

**It will not run under an agent.** `--as agent:<id>` refuses
`apply-agent-actor`, and the verb classifies `policy.core`, so a hook denies an
agent that runs it. Propose here; a human applies.

## Worked example

`approval-md-2026-09.md` is a real proposal that exercises every part of this
page: three sections, a superseding pair, and a four-backtick wrapper around a
values block. `tests/fixtures/proposals/` holds the smaller ones the test suite
drives.
