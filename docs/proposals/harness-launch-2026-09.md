# Proposed edit to this repository's APPROVAL.md (APRV-354)

Two lines, for Carter to apply by hand or through `approval policy apply`.
Agents may not write `APPROVAL.md` (`policy.core`, human-only), so the edit
travels here and the paste is the human's act.

```sh
approval policy apply docs/proposals/harness-launch-2026-09.md --pr
```

## What it does

APRV-354 adds `harness.launch.NAME`: starting an agent harness session
(`codex`, `muse`, `grok`, `claude`, `cursor-agent`), in any of the spellings the
classifier can read, with the argv bound. Before it, every one of those commands
was `hook-unclassified`: refused, which is fail closed, and also mute. It told an
approver nothing and gave a human no class to grant through the ordinary manual
path.

The two lines below hold the family at `manual` and reserve **Muse** to human
hands.

## Why the family is `manual` and not something softer

A launched harness runs its own tools **outside this gate** unless that
harness's own adapter is installed and attested. So a grant of
`harness.launch.codex` authorizes the launch, and authorizes nothing the
launched session then does: every file it writes, every command it runs and
every request it makes happens where this runtime cannot see it.

That is the laundering shape, and it is why a soft autonomy here would be worth
more to an agent than a soft autonomy anywhere else in the file. One
`autonomous` line would end the gate in a single word. `manual` is the floor
SPEC §7 asks for, and this repository has no reason to go below it.

A version or help probe is NOT in this family. `codex --version`, `muse --help`
and a lone `codex help` classify `read.shell`, which this policy already makes
autonomous, so reading a harness version costs nobody a tap.

## Why Muse is `human-only` and not `manual`

A Muse Code model id ending `-contributor` trades price for permission to train
on prompts and completions, so running one over real code shares that code.
Carter has ruled that Muse Code must never run with a Contributor model
selected, and that it must not run over real repositories at all until its
adapter, the read-jail policy line and his own confirmation are in place.

`human-only` is exactly that sentence in policy: an agent cannot request it, no
grant exists for it, and a person runs `muse` themselves or does not run it
(SPEC §5.2, APRV-185). `manual` would be weaker in the one way that matters
here, because a manual class is one an agent can put in front of a person at a
moment of its own choosing.

The classifier helps and does not pretend to enforce. It binds the `--model`
value where it appears (`--model x` and `--model=x` alike) and gives a
`-contributor` value its own rule id, `harness-launch-muse-contributor`, so a
prompt and a policy can both see it. It cannot do more than that: the model is a
**self-reported argument**, and a session may select one in Muse's own UI where
no command line shows it. A `-standard` id therefore classifies exactly as no
`--model` at all. A self-reported field may raise scrutiny and may never lower
it (SPEC §11.1 invariant 4).

## Which line wins for `harness.launch.muse`

**The specific line.** I checked this against `src/core/policy-match.ts` rather
than assuming it.

Candidates are ordered by `(literal segments DESC, wildcard segments ASC)`.
`harness.launch.muse` has three literal segments and no wildcard;
`harness.launch.*` has two literals and one wildcard. The specific line is
strictly more specific, so it wins, and **declaration order does not matter**: I
ran both orders through `loadPolicyText` and `resolve` and got `human-only` with
`matched: harness.launch.muse` either way. `tests/cli-hook.test.ts` pins it
through `approval policy check` on a scratch policy that lists the wildcard
first, which is the order below.

Two smaller findings from the same reading, recorded because a future reader
will want them:

- `harness.launch.codex` and the other three resolve through the wildcard, with
  provenance `rule` and `matched: harness.launch.*`;
- a trailing `.*` matches **one or more** segments, so `harness.launch.*` does
  NOT match a bare `harness.launch`. Nothing emits that bare class (every launch
  is `harness.launch.NAME`), so it is inert here; a policy that wanted it
  covered would write it as its own line.

## What it costs, honestly

A tap per harness launch, and nothing per probe. Sessions in this repository do
not start nested harnesses as a matter of course, so the expected volume is
near zero and each one is a real decision. The APRV-349 Codex app-server probe
is the first command this will stop, and that is the intended behaviour: it
spawns a second agent.

If the volume ever turns out to be noise rather than signal, the softer line is
`supervised-live` with a low `live_rate`, which keeps every launch in the log
and stops a fraction on the gate. It is **not** `supervised-retro`: a launch
that already happened cannot be un-launched, and the inner actions are exactly
the ones this gate never saw.

## It is already safe without these lines

The classifier ships ahead of the paste, and that is safe in the strict
direction. A class no rule matches resolves to `defaults.autonomy`, which is
`manual` in this file, so between the merge and the paste a harness launch is
`manual` rather than the `hook-unclassified` refusal it was. That is a
loosening of one step, from "refused outright" to "a person decides", and it is
the step the task asks for. What the paste adds is Muse at `human-only`, which
is stricter than the default, plus a line a reader can find and a name a future
`*` wildcard cannot silently absorb.

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
  account.credential:        { autonomy: human-only }   # keychain, APPROVAL_*/TELEGRAM_*/VAULT_* probes, vault/keys/env reads (APRV-194)
```

Replace with:

```yaml
  account.credential:        { autonomy: human-only }   # keychain, APPROVAL_*/TELEGRAM_*/VAULT_* probes, vault/keys/env reads (APRV-194)
  harness.launch.*:          { autonomy: manual }       # starting a second agent: the grant covers the launch, never what the launched session then does (APRV-354)
  harness.launch.muse:       { autonomy: human-only }   # Muse Code: a -contributor model trains on prompts and completions, and no adapter or read jail is in place yet (APRV-354)
```

The anchor is `account.credential` because it is the last of the human-only
lines, so the pair lands where a reader already looks for the classes a person
keeps to themselves. The wildcard is written first so the file reads
general-then-exception; as the precedence section above says, the order makes no
difference to which line governs Muse.

## After you paste

`approval hook classify -- "codex app-server"` prints `harness.launch.codex`
with `app-server` bound, and `approval policy check harness.launch.codex` prints
`manual` with `harness.launch.*` as the matched pattern.
`approval policy check harness.launch.muse` prints `human-only` with
`harness.launch.muse` matched. `approval hook classify -- "codex --version"`
prints `read.shell`, which stays autonomous.

Before the paste, the two `policy check` commands print `manual` from
`defaults.autonomy` with no matched rule, which is the difference this page
exists to close.

Not changed by this paste, and worth saying so: `approval codex start` keeps
`gate.self`. It is the confined Codex entry point (APRV-325.3), the spelling
that brings the inner actions back inside the gate, and pricing it as a launch
would price the safe spelling above the unsafe one.
