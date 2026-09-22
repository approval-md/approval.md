# The probe driver convention

Every harness this repository adapts gets a probe first: a script that records
what an installed harness actually sends a hook, which verdict forms it honours,
and what it does when the hook breaks. The adapter is then built on the
measurement rather than on the vendor's prose.

The probes worked. What they cost was a human's afternoon. The Muse round
(APRV-350) and the Hermes round (APRV-398) were both driven by hand: a prompt
typed into an interactive session, a file checked, the harness quit and
relaunched, a control file armed, the next prompt typed, about thirty times. The
Hermes round also ran its whole first pass on a build 670 commits behind the one
that fixed the behaviour under test, and every result was wrong for that one
reason.

This page is the shape that removes both costs (APRV-418). It is written for the
next harness.

## Where the cost actually came from

Three sources, and only one of them is the gate:

1. **Launching a harness is `harness.launch.<kind>`, manual by policy.** That is
   correct and it costs ONE tap. It is not what made the rounds expensive.
2. **The probes assumed an interactive TUI session.** That is a design choice,
   and it is what made every prompt its own launch, its own tap and its own wait.
   It is the one this convention changes.
3. **A model key has to be in the harness home**, because a probe measures tool
   calls and only a model makes them. Agents do not touch credentials, so a human
   places the key once. See "Credentials" below.

## The driver shape

`scripts/probes/<harness>.mjs` gains a `run` verb that does the whole round in
one process. Six properties, in this order, because the order is the safety
property:

1. **The version first, before anything is written.** Not before the first trial:
   before the CONFIG. `run` spawns `<binary> --version`, keeps the RAW first line
   (control characters stripped, capped, one line), and records it in the capture
   directory. A build below a MEASURED floor is refused outright, and the refusal
   happens before the scratch project exists, so a refused build never has a hook
   block installed in its home and the operator has nothing to undo. An
   unreadable version line refuses too, naming `--allow-unknown-version` for the
   operator who knows better than the banner.

   A floor is DATA in the probe, and it exists only where a build difference has
   been measured. Hermes has one (`fail_closed` is ignored silently below `main`
   `118984d7`). Grok Build has none, and its probe says so rather than inventing
   one, because an invented floor is exactly the confident-stale documentation
   this project exists to avoid. Where the runtime also carries the floor
   (`src/core/harness-version.ts`), the probe's copy is pinned to it by a test:
   the probe is plain ESM that runs before any build and cannot import the
   compiled module, so the copy is necessary and the drift it invites has to cost
   a test failure.

2. **One `prepare` shared with the hand-typed path.** The scratch project, the
   hook registration and the pointer file are built by one function that both
   `setup` and `run` call, so the two paths cannot drift into measuring different
   things. The scratch project holds ONLY synthetic files the script writes, and
   deliberately no `AGENTS.md` and no `CLAUDE.md`: a coding harness reads those as
   instructions, so a real project's rules would enter the session. A test
   asserts their absence.

3. **A declarative matrix.** `matrix()` returns the steps as data: the trial to
   arm, the configuration state the step needs, the prompt to send, the artifact
   whose presence is the measurement, and whether the step has to outlast a
   harness timeout. A reviewer should be able to read the matrix without reading
   the loop that walks it.

4. **One one-shot invocation per step.** The prompt goes to the harness's
   non-interactive mode, and the spelling is a TEMPLATE with `{prompt}` and
   `{dir}` placeholders that `--one-shot "<template>"` overrides. That matters
   more than it looks: no vendor's one-shot flags have been verified in this
   repository, so a wrong guess has to be a flag on the command line rather than
   an edit to the script, and the driver's diagnosis has to be able to name the
   knob.

   A one-shot invocation is a fresh harness start, and that is what makes the
   fail-closed PAIR drivable at all. A configuration key is read at startup, so
   switching it between steps needs nobody to quit and relaunch anything. The
   manual Hermes round never got its control pass for exactly that reason.

5. **An early abort.** If the FIRST invocation captures no envelope, the driver
   stops. Twenty further invocations against a wrong flag spelling, an
   unregistered hook or a home nothing reads would all fail the same silent way,
   and the round would read as "the harness ignored everything" when the truth is
   that nothing ever ran. One wasted invocation is the price, and the diagnosis
   names the causes in the order they are worth checking.

6. **A report read back out of the capture.** Not out of the loop's own memory:
   the capture is what a reader can check. The report says which way the round was
   run, so a hand-typed round cannot be mistaken for a driven one.

### The step label, and the retry that misread a trial

A driven step is one one-shot process, so the driver writes a STEP LABEL into the
control file and the hook copies it into every envelope that step produces. The
label survives the arm being consumed, which is the whole point of it.

It exists because the file-existence heuristic has one hole and the Hermes round
walked into it twice: after a refusal the model retries the same effect through
another tool or another path, and one of those retries can create the very file
whose absence was the measurement. With the label the report can say which:

- **same step** — a retry INSIDE the armed session. This is the confound;
- **later step** — a different process, so the file belongs to another trial and
  the armed call is not implicated at all.

A hand-armed round carries no label and reads exactly as it did before.

### Canned-envelope tests, and a fake harness binary

The driver is verified before any install, in `tests/probe-<harness>.test.ts`:

- the exported pure parts (the matrix, the template, the floor reading, the
  verdict shapes) driven directly;
- `record` driven with canned envelopes in the harness's own wire shape;
- and the whole `run` loop driven against a FAKE HARNESS BINARY the suite spawns
  (`tests/fake-hermes.mjs`, `tests/fake-grok.mjs`). The fake answers `--version`,
  reads the configuration file the probe just wrote, fires the hook with an
  envelope on stdin, applies the harness's verdict semantics and performs the
  effect when nothing blocked it.

The fake earns its keep by reading the configuration the probe writes. That file
is the artifact that cost the first Hermes round a day, and a stubbed spawn
function would only prove the loop calls something.

**Label what the fake models.** Hermes's models a MEASURED harness. Grok Build's
models a DOCUMENTED one, because nothing here has ever run that binary, and its
header says so in as many words. A fake that quietly modelled documentation would
turn an open question into an apparent answer.

## The one-grant flow

The lane files ONE request for the driver invocation, against the PRIMARY
checkout's log and policy, and waits. With APRV-401 the grant binds the driver's
bytes rather than only its path.

```sh
cd /Users/carter/dev/approval-md

approval register "backlog/tasks/<task file>.md" --as agent:<session>
approval request <TASK-ID> --action "<task>:probe:<date>" --as agent:<session> \
  --payload <payload.json>          # {"argv": [...], "cwd": "..."}
approval wait <TASK-ID> --timeout 6h
approval run "<task>:probe:<date>" --token <token> --as agent:<session> \
  -- node scripts/probes/<harness>.mjs run --home <harness home> --captures <dir>
```

The human taps once, the report comes back to the lane, and the lane pastes it
into the task. On a reject the lane records the refusal and does not retry the
same request. Where a lane cannot reach the gate at all, CLAUDE.md's standing
rule applies: stop and escalate.

Two things the driver must NOT do, and both are the reason it is one request
rather than none:

- it never runs the harness outside a grant. A probe driver is a program that
  launches a harness many times, and `harness.launch.<kind>` is manual by policy;
- it never widens what the grant covers. One grant over these exact bytes, one
  round, one report.

## Credentials

A probe measures tool calls and only a model makes them, so the harness needs a
key. Two options, and the first is the one in use today:

1. **A key placed once by the human, in the harness home.** The harness's own
   setup wizard writes it (`hermes setup`, and each harness's equivalent). This
   repository classifies those files `account.credential`, human-only, which no
   agent reads and no agent may write, and the probe's own suite asserts that its
   scratch home contains no credential file. The driver passes the harness home
   through to each child so the key is found where the human put it, and nothing
   about the key ever reaches the log or a capture.

2. **A vault entry inside a consumed-token window.** `approval run` builds the
   child's environment rather than inheriting it (APRV-205): every
   credential-bearing prefix is withheld, and the only credentials kept are those
   the adapter serving that action's class declared in `requiredCredentials`
   (APRV-169). So a key can reach a driven round without ever sitting in a home
   directory, on a machine where that is what is wanted.

   **This route does not exist for a probe today**, and the page says so rather
   than implying it: no adapter serves the `harness.launch.*` classes, so there is
   no `requiredCredentials` declaration to keep a variable alive. Making it work
   is an adapter's worth of work and its own task. Until then option 1 is the
   supported one, and a driver must not invent a flag that names a variable to
   keep, because a flag like that hands the credential to whoever passes it.

Either way the capture is redacted before it is written: token-shaped strings are
stripped on the way to disk, deliberately over-eagerly, because a capture is
pasted into a task and a pull request and raw secrets never appear in a record
this project writes (SPEC.md §11.1 invariant 3).

## What stays manual

**The messaging-gateway pass.** A bot cannot message a bot, so a gateway round is
a human sending messages to a gateway and pasting back what came of it. The
driver's job there is to make it three named messages rather than a paragraph of
prose, and to print them at the end of its report so they are not a separate
thing to remember.

**The hand-typed verbs.** `setup`, `arm` and `report` keep working on their own,
for a round where somebody wants to watch a single trial. The report says which
way the round was run.

## Checklist for the next harness probe

1. `run` reads the version FIRST and refuses below a measured floor, or states
   that no floor is known for this harness.
2. `prepare` is shared with `setup`, and the scratch project holds only synthetic
   files, with no `AGENTS.md` and no `CLAUDE.md`.
3. `matrix()` is data, and it includes the controls, not only the trials. A round
   whose control never ran measured nothing.
4. The one-shot spelling is a template, overridable, and labelled UNVERIFIED
   until a live round confirms it.
5. The first invocation capturing nothing aborts the round with a diagnosis.
6. The report reads its own capture, labels each step, and distinguishes a blocked
   call from a later retry.
7. A canned-envelope suite plus a fake harness binary, with the fake's header
   stating whether it models measurement or documentation.
8. The runbook in `docs/<harness>-hook.md` is: install, set a key once, one tap,
   read the report, plus whatever genuinely cannot be driven.

## Related

- [docs/hermes-hook.md](hermes-hook.md) — the reference driver
  (`scripts/probes/hermes-hook.mjs run`) and the runbook shape above.
- [docs/grok-hook.md](grok-hook.md) — the same shape on a harness with no
  measured version floor and a documented fail-open.
- [docs/integrations-considered.md](integrations-considered.md) — the register,
  and "How to add an entry", which points here for the probe half.
- [docs/dogfood-cutover.md](dogfood-cutover.md) — the register/request/wait/run
  sequence in full, including what a reject and a timeout mean.
