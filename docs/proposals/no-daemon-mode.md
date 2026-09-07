# Proposal: no-daemon mode as a first-class path

Status: proposed, not built. Nothing in this document amends SPEC.md.
Companion to `solo-dev-quickstart.md`.

## Where things stand

The daemon is optional in the code and mandatory in the story. The README
needs `approval up` in a foreground terminal before a prompt reaches
Telegram, `approval setup service` writes the launchd or systemd unit, and
this repository's own rules name the daemon as the sole writer of the
committed log. The CLI verbs already work without it, serialising through
the append lockfile. What is missing is a mode that is designed,
documented, tested, and recommended for the case where nothing long-running
exists.

That case is one person's app. It runs when they run it. Their laptop
sleeps. They do not want a service.

## What the daemon does, and who needs each part

| Daemon responsibility | Solo need | In no-daemon mode |
|---|---|---|
| Deliver prompts to channels | Yes | The waiting process delivers its own prompt |
| Poll channels for taps | Yes, while waiting | The waiting process polls for its own wait |
| Expire lapsed requests | Rarely | Lazily, on the next verb that reads the queue |
| Detect envelope drift | No (no task files) | Not applicable; `guard` synthesises envelopes |
| Regenerate QUEUE.md | Cosmetic | Lazily, with expiry |
| Audit sampling draw | No (team feature) | Absent; the solo policy has no audit block |
| Restart crashed channels | No | The waiting process retries with backoff, then fails closed |
| Advance the records branch | No (log is not git-hosted) | Not applicable |

The pattern: everything the daemon does continuously, no-daemon mode does
at the moment a verb needs it, inside that verb's process. The log is still
the truth; what changes is who reads it and when.

## Design

### The waiting process is the runtime

When `approval guard`, `approval request` plus `approval wait`, or the SDK
`guard()` needs a decision and finds no daemon (no live socket at the known
path, the check doctor uses since APRV-282), it:

1. Delivers the prompt through the policy's channel, in-process, using the
   channel code the daemon uses.
2. Polls that channel until the wait deadline, with the channel
   supervisor's backoff.
3. On a decision, appends `approval.granted` or `approval.rejected`, mints
   the token in memory, and continues. The prompt annotation happens in the
   same edit call, as today.
4. On timeout, withdraws its own request. `--withdraw-on-timeout` is the
   default in no-daemon mode, because nothing else will tidy it.

The listener is a phase of the verb, not a process.

### Lazy housekeeping

Expiry and queue regeneration run at the start of any verb that reads
pending state (`status`, `queue`, `guard`, `request`, `wait`), under the
append lock, before the verb's own work. Same code as the daemon tick,
called once. The cost is one verified read per verb, cheap since APRV-186.

### Two concurrent waiters

Two `guard` processes waiting at once both poll one Telegram bot. The design
already handles a decision taken at another surface: the loser sees the
grant on its next poll and annotates. What must be added is a poll-offset
lease under the append lock so two pollers do not consume the same update.
Simplest form: the lease is a record in the log's sidecar state, held for
one poll interval; a waiter that cannot take it sleeps and reads the log
instead of the channel. The log stays the arbiter.

### Detection and refusal

- Doctor gains a row: `runtime  no daemon (solo mode): verbs deliver and
  poll inline`. Green when the policy is a solo policy (no audit block, no
  `daemon:` section). Amber, with the existing fix line, when the policy
  declares things only a daemon can do: sampling, drift on task files,
  records advance.
- A policy that declares `audit.supervised_sample_rate` while no daemon runs
  fails closed exactly as today: sampling cannot be drawn, so
  supervised-live classes gate at 100%. That stays.
- No-daemon mode never writes the committed log of a git-hosted project.
  That rule exists for this repository's dogfood; the solo path never
  commits its log. State the boundary once in `docs/no-daemon.md`.

### A hosted channel is one more channel

Anything that keeps running when the laptop sleeps (delivery, polling,
continuous expiry) is what a hosted service would offer. It fits this design
as a channel with the same trust boundary as Telegram (SPEC §11: a chat
transcript lives on servers you do not control): the prompt and the decision
travel, the log, the token, and the payload store stay local. The upgrade
from inline to hosted is one policy line and no change to `guard` or to the
application. The open path stays complete on its own, which is what
`GOVERNANCE.md` promises.

## Work this implies

1. **Inline delivery and poll in `wait`**, gated on daemon detection.
   Reuses the channel supervisor and poll loop; new is the lifecycle binding
   to the verb.
2. **Lazy housekeeping** at verb start under the append lock.
3. **Poll lease** for two waiters on one channel, log-arbitrated.
4. **Doctor solo row** and the amber case.
5. **Docs**: the README "Solo" track opens with "no daemon needed", and
   `docs/no-daemon.md` states the git-hosted-log boundary.
6. **Tests**: spawned-process tests for two concurrent waiters, timeout
   withdrawal, and the sampling-declared refusal, through the real append
   path.

Sequencing: 1 and 2 first (they make `guard` work), 3 before any public
mention of concurrency, 4 and 5 with the quickstart README pass, 6 alongside
each.
