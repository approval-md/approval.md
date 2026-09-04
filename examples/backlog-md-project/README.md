# A Backlog.md project behind the gate

This is the worked example of the native Backlog.md integration (SPEC.md
section 12). A board lives in `backlog/`, one of its tasks carries an
`approval:` envelope (section 6), and the four verbs an agent runs to take a
gated action, `register`, `request`, `wait` and `run`, operate on that file and
on the log. Nothing else is involved.

**There is no Backlog.md adapter, because a task file holds no credential: the
envelope on the file plus the log is the whole integration.** An adapter in
this system is a section 10.4 enforcement boundary, the one place a real
credential is spent inside a verified token window; a markdown file on a board
has nothing to spend, so there is nothing for an adapter to hold. The board
tool keeps writing task files, the runtime keeps reading the one frontmatter
key it owns, and the log records what happened.

**Board `status` and approval `state` are independent: `status` belongs to
Backlog.md and says where the task sits on the board, `state` is a projection
of the log and says where the action sits in its approval lifecycle, and
neither is derived from the other.** Moving the task to `Done` grants nothing,
and a grant moves the task nowhere; the daemon writes `state` after the event
is appended and never the reverse (section 6.3).

## What is in this directory

```
examples/backlog-md-project/
├── README.md                                   this walkthrough
├── policy.md                                   the example's own policy
└── backlog/tasks/task-7 - Publish-0.1.0-to-npm.md   one task, one envelope
```

`backlog/tasks/task-7 - Publish-0.1.0-to-npm.md` is a task file as Backlog.md
1.49.3 writes one (`id`, `title`, `status`, `assignee`, `labels`,
`dependencies`, the marked Description and Acceptance Criteria sections), plus
the single key approval.md adds:

```yaml
approval:
  origin:
    app: backlog-md
    created_by: "human:alice"
  route:
    assignee: "agent:release-bot"
    confidence: 0.9
    rationale: "scripted publish; the changelog and the tag were reviewed on task-6"
  state: proposed
  actions:
    - class: release.publish
      summary: "Publish 0.1.0 to the npm registry"
      reversible: false
      est_cost_usd: "0"
      idempotency_key: "task-7:publish:0.1.0"
      payload_hash: "93a5b8e63ee9c5132c5c896107eb53693bb6cb1d17f8136fec341a7faa721aa9"
  budget:
    max_latency: 24h
```

Every sibling key is Backlog.md's and the runtime never rewrites any of them:
`approval register` reads the file and appends to the log, and that is the only
direction data flows. The envelope validates against
`schema/envelope.schema.json`, and `tests/docs-guard.test.ts` asserts that it
keeps doing so.

`policy.md` is the policy the walkthrough runs against. In your own project the
same fenced block lives in `APPROVAL.md` at the repository root and every verb
below finds it with no flag. It has a different name here because this
repository's own gate reserves the `APPROVAL.md` filename to human hands
wherever it sits (`policy.core`, human-only), so the agent that wrote this
example could not commit one; the walkthrough passes `--policy policy.md`
instead. The policy declares `release.publish` as `manual`, and `defaults`
already say the same, so the class line is documentation of intent.

A real board also carries `backlog/config.yml` and the rest of what
`backlog init` writes. They are omitted here because they are Backlog.md's and
the runtime reads none of them.

## The walkthrough

Everything happens in a copy of this directory, so the repository's own
`APPROVAL.md` and `.approval/` are never touched. `approval` is the built CLI
(`npm run build`, then `npm link`, or alias it to
`node dist/src/cli/main.js`).

```sh
cp -R examples/backlog-md-project ~/backlog-md-project
cd ~/backlog-md-project
```

### 1. A human attests the policy

```sh
approval policy attest --policy policy.md --as human:alice
```

```
attested /home/alice/backlog-md-project/policy.md at seq 1: sha256 f6fb067b2200f6b02560e9dddd7f0b3b7eb88eae3df986626a2576a1470a8dea
```

This is the first record of the log, and `attest` creates `.approval/log/` in
the working directory to hold it. Every gate operation from here on refuses
`policy-not-attested` if the file's bytes change, until a human attests again.

### 2. The agent binds the action to bytes

`approval run` executes an argv in a directory, and the payload of such an
action is exactly that: the argv array and the cwd (section 6.2). The runtime
recomputes the hash from what it is about to spawn, so the committed
`payload_hash` above is for a directory named `/home/alice/backlog-md-project`
and will match nothing on your machine. Write the payload for yours, with `cwd`
as `pwd -P` prints it (the physical path is what the runtime records):

```sh
cat > payload.json <<EOF
{
  "argv": ["echo", "published"],
  "cwd": "$(pwd -P)"
}
EOF
approval payload hash payload.json
```

Put the printed value into the task file's `payload_hash`, with any editor.
Not with `backlog task edit`: the pinned Backlog.md CLI drops the `approval:`
key when it rewrites a file (docs/backlog-md-pin.md), which is a defect the
runtime detects as `envelope.drift` and never repairs.

In a real project the argv is the publisher (`npm publish`, say). Here it is
`echo`, so the walkthrough has no side effect outside the log.

### 3. `register`

```sh
approval register "backlog/tasks/task-7 - Publish-0.1.0-to-npm.md" --as agent:release-bot
```

```
registered task-7 at seq 2: 1 action(s)
```

`register` validates the envelope against the schema and appends one
`task.registered` record carrying the declared actions. The task id comes from
the file's `id`, a Backlog.md key. An invalid envelope appends nothing, and the
file is read only.

### 4. `request`

```sh
approval request task-7 --action task-7:publish:0.1.0 --payload payload.json \
  --policy policy.md --as agent:release-bot
```

```
requested task-7 task-7:publish:0.1.0 at seq 3 (manual)
```

The class, cost and reversibility come from the registered record, never from
flags, so an agent cannot rename its own class between registering and asking.
`--payload` supplies the bytes: they must hash to the declared `payload_hash`
(anything else is refused `payload-mismatch` and nothing is stored), and they
are filed in `.approval/payloads/` where every decision surface reads them.

Try to run it now, before anyone has decided:

```sh
approval run task-7:publish:0.1.0 --policy policy.md --as agent:release-bot -- echo published
echo "exit=$?"
```

```
✗ token-required  action task-7:publish:0.1.0 resolves to manual (rule) and cannot execute without the single-use token minted at grant. Request the action, have a human grant it, and pass the token that grant printed.
exit=5
```

Nothing was spawned and nothing was appended.

### 5. `wait`

```sh
approval wait task-7 --timeout 2s --policy policy.md
echo "exit=$?"
```

```
approval: timeout: task-7 still has undecided request(s) after 2s; nothing was appended and the request(s) remain live
exit=6
```

For `wait` the exit code is the decision: 0 granted, 1 rejected or revoked or
withdrawn, 3 expired, 6 the timeout elapsed with the request still live. An
agent session passes a real timeout (`--timeout 6h`) and blocks here while a
person decides on whatever channel the policy configures. This example's
channel is the CLI, so the person is you, in another terminal:

```sh
approval queue --policy policy.md
```

```
action                task    class            cost  requested                 ttl
task-7:publish:0.1.0  task-7  release.publish  $0    2026-09-02T21:23:50.768Z  23h 59m left
```

```sh
approval grant task-7:publish:0.1.0 --policy policy.md --as human:alice \
  --note "changelog read, tag verified"
```

```
granted task-7:publish:0.1.0 at seq 4 by human:alice
─────────────────────────────────────────────────────────────
  execution token   task-7:publish:0.1.0
  7d3118b7ab44260f9517356b848dc609647a0e33c670fc33dcb5a4159a624309
  single-use · stored nowhere · copy it now
─────────────────────────────────────────────────────────────
```

`grant` is human-only. It appends `approval.granted`, mints the single-use
execution token and prints it once; the log holds only its SHA-256. Back in the
agent's terminal, `wait` now returns at once:

```sh
approval wait task-7 --timeout 2s --policy policy.md
echo "exit=$?"
```

```
✓ task-7  granted
  task-7:publish:0.1.0  granted
exit=0
```

With `--json` the same call prints one object, which is what a session
branches on:

```
{"ok":true,"task":"task-7","status":"granted","actions":[{"action_key":"task-7:publish:0.1.0","state":"granted","seq":4}]}
```

### 6. `run`

```sh
export TOKEN=7d3118b7...     # what grant printed
approval run task-7:publish:0.1.0 --token "$TOKEN" --policy policy.md \
  --as agent:release-bot -- echo published
echo "exit=$?"
```

```
published
exit=0
```

`run` hashed the argv and cwd it was about to spawn, checked that against the
binding the grant recorded, appended `execution.started`, spawned the command,
and appended `execution.completed` with the child's real exit code. It exits
with that code, so it composes with `&&` and CI the way the bare command would.
A different command after `--`, or the same command from a different directory,
is refused `payload-mismatch` before anything is spawned.

Spend the token again:

```sh
approval run task-7:publish:0.1.0 --token "$TOKEN" --policy policy.md \
  --as agent:release-bot -- echo published
echo "exit=$?"
```

```
✗ token-consumed  action task-7:publish:0.1.0 already executed: execution.started at seq 5 spent this token. A token is single-use and the log is the proof.
exit=1
```

No second `execution.started` was appended. A retried agent cannot publish
twice.

### 7. The log is the truth

```sh
approval log tail -n 6
approval log verify
```

```
1	2026-09-02T21:23:43.781Z	policy.updated	human:alice	-
2	2026-09-02T21:23:47.501Z	task.registered	agent:release-bot	task-7
3	2026-09-02T21:23:50.768Z	approval.requested	agent:release-bot	task-7
4	2026-09-02T21:23:57.887Z	approval.granted	human:alice	task-7
5	2026-09-02T21:25:00.930Z	execution.started	agent:release-bot	task-7
6	2026-09-02T21:25:02.240Z	execution.completed	agent:release-bot	task-7
clean: 6 record(s), head seq 6 4b04d876d0a0d180a00d63cca1a086f2cfa826098592fb0e4e50310f663b8003
```

Six records, hash-chained, and `grep -c "$TOKEN" .approval/log/events.jsonl`
is 0: the raw token is in no log byte.

## What the board does next

Close the task on the board as you normally would. The approval `state` is
unaffected by it: `status` is Backlog.md's answer to "where is this on the
board", `state` is the log's answer to "where is this action in its
lifecycle", and the runtime derives the second from the log alone. A running
daemon (`approval up`) writes `state: executed` into the file after the fact,
as a projection; an edit that contradicts the log is recorded as
`envelope.drift` and surfaced, never silently corrected.

One caution for the pinned Backlog.md CLI, stated once here and in full in
docs/backlog-md-pin.md: `backlog task edit` at 1.49.3 rewrites the file
without the `approval:` key. The log still holds everything the envelope
declared, `approval register` refuses the stripped file with
`envelope-missing` rather than narrowing the record to what survives, and
restoring the block from the log is a human's step.

## Where this connects

- SPEC.md section 6 defines the envelope, section 6.3 the lifecycle, section 12
  the interoperability stance this example demonstrates.
- docs/dogfood-cutover.md is the same four verbs as this repository's own
  sessions run them, against the live log, with the decision arriving over
  Telegram.
- examples/telegram-demo.md is the same story with the approve button on a
  phone; examples/email-demo.md ends at an irreversible send through a real
  adapter, which is where a credential and a section 10.4 boundary finally
  appear.
