# Proposal: solo-dev quickstart

Status: proposed, not built. Nothing in this document amends SPEC.md.

## The problem

The README is written for the repository that dogfoods it: a primary
checkout, a daemon, a gate ceremony, a Telegram listener, a sampling secret,
and a 27-row doctor. That is the right story for a team. It is the wrong
first fifteen minutes for one person building a personal app who wants one
thing: the agent must not send, apply, pay, or delete without a tap on their
phone.

Today that person meets, in order:

1. `npm install -g approval-md`.
2. `approval init`, which scaffolds the SPEC §5.1 canonical policy naming an
   approver who is not them, then asks them to read every class before
   signing.
3. `approval setup identity`, `eval "$(approval env)"`, `approval policy
   attest`, `approval doctor`, and a doctor failure about audit sampling that
   is correct and intended and reads as broken.
4. BotFather, `approval setup channel telegram`, a payload file, a hash, an
   envelope on a task file, `register`, `request`, `approval up` in a
   foreground terminal, a token copied from the terminal, `approval run`.

Twelve steps, two files authored by hand (the policy and the envelope), and
one long-running process. Most people leave at step 2.

## The target

Three commands, one phone, no envelope authoring, no daemon on day one.

```sh
npm install -g approval-md
approval quickstart          # three questions, writes everything
approval guard -- <command>  # the one verb to learn
```

## `approval quickstart`

Interactive by refusal, like `setup`: a pipe or `--json` exits 2 and prints
the non-interactive equivalents. It asks three questions.

1. **Who are you?** One name. Becomes `APPROVAL_HUMAN=human:<name>` and the
   sole approver in the policy.
2. **Where should the button go?** Telegram (paste a BotFather token) or
   "this terminal" (the CLI channel). The web channel is offered later, not
   on day one. A hosted channel, if one exists, is one more option in this
   list and nothing else in the flow changes.
3. **What must always ask?** A checklist defaulting to all on: send a
   message or email, spend money, delete files, post publicly, push to main.
   Everything else is autonomous.

It then writes the solo policy template below, runs identity setup, stores
the token in the keystore, and attests the policy in the same session (the
human is at the keyboard; attestation is the last prompt, with the typed
`understood`). It prints one line:

```
ready: five classes ask human:<name> on Telegram; everything else runs.
try:   approval guard -- curl -X POST https://api.example.com/apply
```

Doctor output appears only when something failed. Doctor stays one command
away.

## `approval guard`

The verb that replaces the register, request, wait, run quartet for the
solo case. It is sugar over the existing machinery: the log records the
same events as the long form and nothing in SPEC changes.

```
approval guard [--payload <file>] [--as agent:<id>] -- <command>
```

- Classifies the command with the classifier the hook uses.
- Autonomous class: runs it, appends nothing.
- Supervised class: runs it, appends `task.registered`.
- Manual class: synthesises an envelope in memory (task id derived from the
  command hash, one action, class from the classifier, payload hash from
  `--payload` or from the canonical command line when there is no payload),
  appends `task.registered` and `approval.requested`, delivers the prompt
  through the policy's channel, waits, and on grant runs the command under
  the minted token through the existing `run` path, appending
  `execution.started` and `execution.completed`.
- Without a daemon, `guard` drives the channel poll for its own wait
  (see `no-daemon-mode.md`). With a daemon running it defers to it, as the
  CLI verbs already serialise through the append lock.

What `guard` must not do, because SPEC §11 forbids it:

- Let the command choose its own class. The classifier decides; there is no
  `--class` flag.
- Print the token. It is spent inside the process that minted it, and the
  log holds the hash. The solo path is stricter than the long form here:
  there is no terminal panel because there is nothing to copy.
- Run a hook-unclassified command. Same refusal codes, same exit codes.

The SDK exposes the same verb, `guard(cmd, {payload})`, so an application
wraps its own side effects instead of shelling out. A personal app wraps
"submit application" and "send follow-up", and the phone shows the rendered
payload through the email-shaped renderer that already exists.

## The solo policy template

Written by `quickstart`, attested in the same session. The five checklist
classes plus `defaults`. No audit block, so doctor has no disabled control to
report; the template's comment says sampling is a team feature and how to
add it.

```yaml
approval:
  version: 0.1
  approvers: [human:<name>]
  defaults:
    autonomy: autonomous
    ttl: 24h
  classes:
    message.send:   { autonomy: manual }
    money.spend:    { autonomy: manual }
    files.delete:   { autonomy: manual }
    content.post:   { autonomy: manual }
    vcs.push.main:  { autonomy: manual }
  channels:
    telegram: { token_env: APPROVAL_TELEGRAM_TOKEN, chat_env: APPROVAL_TELEGRAM_CHAT }
```

Class names are illustrative; the built template uses the classifier's
taxonomy. The point is five lines a human reads in ten seconds.

Design rule: **defaults autonomous, five named manual classes.** This is the
inverse of the repository's own deny-leaning policy, and it is deliberate.
Fail-closed still holds where it matters: an unparseable policy is still
everything-manual, an unknown class still takes `defaults.autonomy`, and the
five classes that touch the world outside the machine are manual. The
template comment says how to tighten.

## Work this implies

Each becomes a Backlog.md task when picked up.

1. **`approval quickstart`**: the three-question setup. Reuses `setup
   identity`, `setup channel telegram`, `policy attest`. New: the template
   and the prompt flow.
2. **`approval guard`**: CLI and SDK. Reuses the classifier, envelope
   validation, `register`, `request`, `wait`, `run`. New: in-memory envelope
   synthesis and the inline poll when no daemon runs.
3. **No-daemon mode**: `no-daemon-mode.md`.
4. **README restructure**: a "Solo" track above the current content. Three
   commands, one picture of the phone prompt, a link to the full story.
5. **A personal-app example**: `examples/personal-app/` gating an
   application submit and a follow-up email through `guard`.
6. **Doctor solo tier**: rows that only apply to team setups (audit sampling,
   daemon service, live draw) report `not applicable (solo policy)` when the
   policy has no audit block.
