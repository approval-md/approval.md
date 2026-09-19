# examples/

Walkthroughs and demos. Each one is a transcript of commands that were actually
run, against the real runtime, on a gate instance of its own.

| | What it shows |
| --- | --- |
| [`telegram-demo.md`](telegram-demo.md) | The whole loop in one sitting: request, a phone, an executed run. |
| [`email-demo.md`](email-demo.md) | The same loop with a credential behind it: an agent's chaser, approved from a phone, sent as real mail. |
| [`agentmail-demo.md`](agentmail-demo.md) | The two-key custody model, where the agent never holds the sending key. |
| [`mcp-demo.md`](mcp-demo.md) | An MCP client asking the gate for permission, mid-conversation. |
| [`web-agent-demo/`](web-agent-demo/) | The stage demo: a web agent behind the gate, a room watching, a human on a phone. Its [crowd track](web-agent-demo/runbook.md) hands the same gate to everybody's own agent over MCP. |
| [`grok-bot-connector/`](grok-bot-connector/) | A Grok Bot agent on the other end of an MCP connector, using the gate and then skipping it. |
| [`backlog-md-project/`](backlog-md-project/) | A Backlog.md project carrying approval envelopes, end to end. |

## Reproducing a demo

The three stage demos are provisioned by one script,
[`demo-provision.mjs`](demo-provision.mjs), from the steps
[`web-agent-demo/provisioning.md`](web-agent-demo/provisioning.md) publishes. The
instances are durable directories, never temporary ones, so the same directory is
the same demo next month:

| Instance | Directory | First line to run |
| --- | --- | --- |
| The web-agent demo | `~/demo-gate` | `node examples/demo-provision.mjs --instance web-agent` |
| The crowd track's guest gate | `~/demo-guest` | `node examples/demo-provision.mjs --instance guest` |
| The Grok Bot connector demo | `~/demo-grok-bot` | `node examples/demo-provision.mjs --instance grok-bot` |

Build the repository first (`npm run build`); everything shells out to
`dist/src/cli/main.js`. `--path <dir>` puts an instance somewhere else.

**One directory holds one demo.** The three defaults are three separate
directories on purpose, and a `demo-instance.json` marker records which demo a
directory was provisioned for: a run whose `--instance` disagrees with the
marker refuses and names the two ways out (`--path`, or `--reset` to retire what
is there and rebuild it as the other demo). The marker is the backstop; separate
defaults are what keep anyone from needing it.

**Run it as often as you like.** An instance that already exists is detected and
nothing in it is overwritten, so a rerun the morning of a demo tells you what is
still missing instead of undoing what is there.

**It stops at every step a human must run** — `approval policy attest`, `setup
identity`, `setup vault`, `setup channel telegram`, the mail adapter verb, the
Grok demo's `git clone`, and the `cloudflared` tunnel each runbook gates as a
live action — prints the exact line for each one, and picks up from there the
next time it runs. It runs none of them, and it writes nothing outside the
instance directory.

**Check an instance before the doors open:**

```sh
node examples/demo-provision.mjs --instance web-agent --check
```

The instance's own `approval doctor`, plus the demo's preflight: the policy is
still the packaged one, the ports that demo is allowed to bind are free, every
seeded envelope's `payload_hash` still matches the bytes beside it, and the
Telegram channel is configured (doctor marks an unconfigured channel `–`, a
legitimate state for a gate and a dead demo for a room). One pass/fail line each;
a non-zero exit if any of them failed.

**Reset between runs:**

```sh
node examples/demo-provision.mjs --instance web-agent --reset            # keeps the vault
node examples/demo-provision.mjs --instance web-agent --reset --vault    # retires it too
```

A reset moves the instance's log, queue, payload store and seeded tasks into
`<instance>/retired/<stamp>/` and provisions the instance again behind them.
Nothing is ever truncated or edited: the log is append-only, and a demo that
rewrote one to tidy a queue would have demonstrated the opposite of the thing it
came to show. The credentials are not in the moved set, which is how a reset
keeps them.

**The guest instance holds no credential, by construction.**
`examples/web-agent-demo/runbook.md` §4 states it as a MUST: the crowd track runs
against a throwaway instance with an empty vault and no mail adapter, because
that is what makes a bug in guest mode's verb filter cost nothing. The script
refuses the vault and adapter steps for that instance, and `--check` fails if a
vault ever appears in it.

The demo policy all three instances are written from is
[`policies/demo-gate.APPROVAL.md`](policies/demo-gate.APPROVAL.md). It is a file
rather than a heredoc in a document so that a change to the demo's rules arrives
as a diff; `tests/demo-provision.test.ts` pins it against the policy block
`web-agent-demo/provisioning.md` explains line by line.
