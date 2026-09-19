# The Codex app-server approval bridge

APRV-349. Can approval.md answer Codex's own approval requests, as the client
of its app-server protocol, and would that give native shell and patch work the
class-and-policy gate the native hook cannot?

The native hook cannot. APRV-311 established why: a `Bash` pre-event carries
`tool_input` keys exactly `["command"]`, so the adapter cannot bind the
directory a command will run in, and it refuses every native shell call as
`hook-unsupported-execution-context` rather than approve bytes whose meaning it
does not know. The app-server protocol is a different shape. Codex stops before
it acts, asks its client, and waits, so the question this note answers is
whether that wait is real, whether the question carries enough to decide on, and
whether anything else can answer it first.

## How to read the evidence markers

Every answer below is marked one of two ways, and the difference matters.

- **source (`path:line @ b0659c5`)** means it was read in the `openai/codex`
  sources at commit `b0659c53865dd48b0cd69c454368cea3980017cc`. A source claim
  says what the code does. It does not say what the binary on a particular
  machine does.
- **observed (2026-09-18)** means it was seen on the operator's machine in one
  run of `scripts/probes/codex-app-server.mjs` against `codex-cli 0.155.0`
  (`/Users/carter/.local/bin/codex`, ChatGPT login, `approvalPolicy:
  "untrusted"`, `sandbox: "read-only"`). One machine, one version, once. The
  verbatim requests are in the primary checkout's `private/aprv349-probe-2026-09-18/`.
  A first run against 0.152.1 the same evening was void: the operator's
  `~/.codex/config.toml` pinned a model that release could not serve, every turn
  ended in a 400 before any tool call, and the report still printed the hold
  sentence (APRV-359 makes the probe say void instead).

One third kind of evidence appears twice and is labelled where it does:
**installed binary**, meaning a string table read out of the shipped 0.152.1
binary with `grep`. That binary was never executed. A string table proves a name
exists in the release the operator will run, which is weaker than source and
stronger than hope, and it is used here only to check that the source read at
`b0659c5` describes the same protocol the installed version speaks.

Version under discussion for the source and string-table claims: `@openai/codex`
0.152.1, read from `/opt/homebrew/lib/node_modules/@openai/codex/package.json`,
the same version APRV-310, APRV-311 and APRV-325 pinned. The observed claims
are from 0.155.0, three releases later; the method names, key paths and
decision vocabulary matched the source read, and the one place the wire differs
from the source names is recorded under question 5.

## Question 1: what does an approval request carry, and does it bind the action?

### The exec request

**source.** There are two live shapes, chosen by which API started the turn.

The item-based API sends `item/commandExecution/requestApproval` with
`CommandExecutionRequestApprovalParams`
(`codex-rs/app-server-protocol/src/protocol/v2/item.rs:1544-1606 @ b0659c5`):
`kind` (`command` or `writeStdin`), `threadId`, `turnId`, `itemId`,
`startedAtMs`, `approvalId`, `environmentId`, `reason`,
`networkApprovalContext`, `command`, `cwd`, `commandActions`,
`additionalPermissions`, `proposedExecpolicyAmendment`,
`proposedNetworkPolicyAmendments`, `availableDecisions`.

The legacy API sends `execCommandApproval` with `ExecCommandApprovalParams`
(`codex-rs/app-server-protocol/src/protocol/v1.rs:158-171 @ b0659c5`):
`conversationId`, `callId`, `approvalId`, `command`, `cwd`, `reason`,
`parsedCmd`.

**Both carry a `cwd`.** That is the whole reason this spike exists. The field
the hook does not have is on the wire here, on the same frame as the command,
minted by the runtime rather than reported by the model.

There is one difference between the two shapes that a bridge would have to take
a position on, and it is not cosmetic. The legacy request carries `command` as
an argv array (`Vec<String>`, `v1.rs:161`). The item-based request carries it as
a single string, produced by `shlex_join(&command)`
(`codex-rs/app-server/src/bespoke_event_handling.rs:748 @ b0659c5`), which is a
RENDERING of the argv that will execute. A classifier handed that string parses
a shell rendering back into words, and a bridge that classified the rendering
would be classifying its own re-parse rather than the bytes the kernel receives.
For Claude Code that is unavoidable, since the harness gives a string and
nothing else. Here there is a better option available on one of the two APIs,
and picking it is a design decision an adoption owes an answer to.

There is no `risk` and no `justification` field on either request. Scoring lives
in a separate subsystem (question 3).

**installed binary.** `item/commandExecution/requestApproval` and
`execCommandApproval` both appear in the 0.152.1 string table, as does
`CommandExecutionRequestApprovalParams` next to `availableDecisions`, so the
source read describes the shipped protocol rather than an unreleased one.

### The patch request

**source, and this is the weak half.** The item-based API sends
`item/fileChange/requestApproval` with `FileChangeRequestApprovalParams`
(`v2/item.rs:1627-1641 @ b0659c5`), whose entire content is `threadId`,
`turnId`, `itemId`, `startedAtMs`, `reason` and `grantRoot`. **There is no diff,
no file list and no changes map.** The content was delivered earlier, on the
`item/started` notification for the file-change item, and the approval request
refers to it by `itemId`.

The legacy API's `applyPatchApproval` does carry it: `ApplyPatchApprovalParams`
(`v1.rs:138-150 @ b0659c5`) has `fileChanges`, a map of path to `FileChange`,
inline on the request.

So on the item-based API a client approves a reference. Binding the actual bytes
means holding state from a previous frame and trusting that the `itemId` still
names the same content. That is a correlation a bridge can do, and it is a
correlation a bridge can get wrong, and the difference between those two is a
place where an approval could authorize bytes nobody classified. The honest
position for a first implementation is to refuse a file-change approval whose
content the bridge cannot produce from its own record, with its own
machine-readable code, rather than to approve an identifier.

### Does it bind enough for the classifier and the guard?

**For the exec half, yes.** `{command, cwd}` is exactly the pair the guard needs
and exactly the pair APRV-311 could not get. A bridge could classify the command
against the policy with the same `src/core/command-class.ts` every other harness
uses, resolve the path-derived classes against the real directory, and produce
guard evidence that names the directory the effect will land in.

**For the patch half, not from the request alone.** It binds an identity and a
grant root. The bytes come from elsewhere, so the binding is only as good as the
correlation.

**observed (2026-09-18):** all five exec requests carried `cwd` populated with
the trial workspace and `command` as the shell-joined rendering
(`/bin/zsh -lc 'printf marker > probe-command-marker.txt'`), plus `itemId`,
`threadId`, `turnId`, `environmentId: "local"`, `commandActions` (with
`type: "unknown"`) and `proposedExecpolicyAmendment`. `availableDecisions` was
present and advertised `accept`, `acceptWithExecpolicyAmendment` and `cancel`,
and did not advertise `decline`; the probe sent `decline` anyway as its
fallback and the server treated it as a refusal (no effect, turn completed).
Both file-change requests carried only `itemId`, `threadId`, `turnId`,
`startedAtMs`, `reason: null` and `grantRoot: null`: no content, no `cwd`, no
decision list. The source claim above holds on the wire: a client on the
item-based API approves a reference.

## Question 2: crash, disconnect, timeout, malformed reply

Each of these has a source answer and an observed answer, and they are not
interchangeable. The source says what the code does; the observed column says
what happened on the operator's machine, which is the only thing this project
lets itself call enforcement.

### Client disconnects with a question outstanding

**source.** `connection_closed`
(`codex-rs/app-server/src/message_processor.rs:855-888 @ b0659c5`, through
`outgoing_message.rs:275-280` and
`request_processors/thread_processor.rs:3534-3547`) does not resolve pending
`request_id_to_callback` entries and does not interrupt the thread. The turn
stays alive with the question unanswered. The core-level receiver
(`rx_approve` in `Session::request_command_approval`,
`codex-rs/core/src/session/mod.rs:2872-2961 @ b0659c5`) is resolved only by
`clear_pending_waiters` on an explicit interrupt
(`codex-rs/core/src/session/input_queue.rs:206-209`, clearing
`codex-rs/core/src/state/turn.rs:90,137-138`), which yields
`ReviewDecision::Abort` through `rx_approve.await.unwrap_or(...)`
(`session/mod.rs:2960`, `:3002`).

So a crashed client blocks rather than releases, which is the property a gate
wants. It comes with a second property that a gate should think about: on
reconnect, `replay_requests_to_connection_for_thread`
(`codex-rs/app-server/src/outgoing_message.rs:446-465 @ b0659c5`) resends the
still-pending request to the NEW connection. The question survives the client,
and it is answerable by whatever connects next. "Only our client decides" is
therefore a statement about who may open that socket, not a statement the
protocol makes on its own.

**observed (2026-09-18):** trial `crash`. One exec request arrived, the probe
destroyed its stdin and stdout with it outstanding, and the server process
exited on its own with code 0 (not alive at settle, 178 bytes on stderr). No
marker and no patched file. So on this build a client crash ends the server
rather than leaving a thread running with a pending question; the replay-on-
reconnect path in the source was therefore not exercised and stays a source
claim only.

### No reply, ever

**source.** There is no timeout. `rx_approve.await` at `session/mod.rs:2960` and
`:3002` has no `tokio::time::timeout` around it, and the app-server's own outer
oneshot (`outgoing_message.rs:357`, awaited at
`bespoke_event_handling.rs:1958-1971`) has no deadline either.

This is the architecturally interesting line in the whole note, so it is worth
stating plainly against what we have today. Every hook adapter answers inside a
ceiling the harness sets, and the ceiling has nothing to do with approval.
`approval hook claude-code` defaults to a 55-second wait
(`src/core/harness-wait.ts:23,26`) because Claude Code's own hook timeout is 60,
so the adapter has to answer before the harness kills it. The Codex hook entry
buys more room and is still bounded: a nine-minute gate wait inside a
ten-minute outer timeout (`docs/codex-hook.md`). Everything downstream of a
ceiling exists because of it, including the five-minute retry grace and the
adopt-on-retry dance (`harness-wait.ts:50`, `src/cli/hook.ts:2845`), which exist
so a denial-by-deadline is recoverable.

A transport with no deadline removes the ceiling rather than widening it. A
question could wait as long as the policy's TTL allows, and a human who answers
in eleven minutes would be answering rather than arriving too late.

**observed (2026-09-18):** trial `no-reply`. One exec request arrived, the probe
held it for 60,000 ms, and the server was still alive with the question open
when the hold elapsed. No marker and no patched file, and no second request:
the turn had not moved past the first question. Silence blocked.

### Malformed reply, or an unknown decision value

**source, and it fails closed.** The reply is decoded with
`serde_json::from_value::<CommandExecutionRequestApprovalResponse>` (and the
file-change equivalent), and on error the code logs and returns
`ReviewDecision::denied("approval request failed")`
(`bespoke_event_handling.rs:1928-1934` and `:1976-2016 @ b0659c5`). A JSON-RPC
error reply is handled the same way (`:1936-1943`). It is never fatal to the
process and it never defaults to executing.

The type's own default agrees: `ReviewDecision::default()` is
`Denied { rejection: "denied" }`
(`codex-rs/protocol/src/protocol.rs:4180-4184 @ b0659c5`).

**observed (2026-09-18):** trial `malformed`. One exec request arrived, the
probe answered with a malformed frame, the server logged (368 bytes on stderr)
and stayed alive, and the settle window elapsed with no marker, no patched file
and no further request. Consistent with deserialization to a denial.

### The decision vocabulary, for completeness

**source.** Item-based: `CommandExecutionApprovalDecision`
(`v2/item.rs:63-85 @ b0659c5`) is `accept`, `acceptForSession`,
`acceptWithExecpolicyAmendment`, `applyNetworkPolicyAmendment`, `decline`,
`cancel`; `FileChangeApprovalDecision` (`v2/item.rs:112-124`) is `accept`,
`acceptForSession`, `decline`, `cancel`. These map onto the core
`ReviewDecision` at `bespoke_event_handling.rs:1906-2020`, where `decline`
becomes `Denied` and `cancel` becomes `Abort`. Legacy `ReviewDecision`
(`protocol.rs:4140-4178`) is snake_case: `approved`,
`approved_execpolicy_amendment`, `approved_for_session`,
`approved_mcp_policy_amendment`, `network_policy_amendment`, `denied`,
`timed_out`, `abort`.

Two of those are worth a bridge's attention. `acceptForSession` converts one
human decision into standing authority for a whole session, which is a grant
shape this project does not have and would have to refuse rather than emit.
`cancel` and `abort` mean "stop the turn", which is a different act from "no to
this action"; conflating them would record an interruption as a denial. The
probe answers `accept` and `decline` only, and says so in its own source.

The envelope has no `jsonrpc` member
(`codex-rs/app-server-protocol/src/rpc.rs:1-2,68-72 @ b0659c5`); a reply is
`{id, result}`.

## Question 3: can the model answer its own approval, or route around the client?

This is the question that decides the recommendation.

**source: the acting model cannot.** `notify_approval`
(`codex-rs/core/src/session/mod.rs:3435 @ b0659c5`) is called from the
app-server's client-response handlers and is not exposed as a tool. No MCP verb
reaches it. An agent inside the turn has no way to resolve its own pending
question.

**source: a model upstream of the client can.** Codex carries a server-side
auto-reviewer. `Session::request_approval` calls `request_reviewer_approval`,
which calls `request_guardian_approval`, and this runs BEFORE the human path
(`codex-rs/core/src/tools/approvals.rs:469-561` and `:563-668 @ b0659c5`). Only
when `request_guardian_approval` returns `None` does control fall through to
`request_user_approval` (`approvals.rs:670`), and `request_user_approval` is
what emits the event that becomes the JSON-RPC request described in questions 1
and 2. The reviewer's answer is a genuine model call
(`codex-rs/core/src/guardian/decision.rs:83-124`, parsing an assessment at
`codex-rs/ext/guardian-reviewer/src/assessment.rs:24-26`), it is tagged
`AutoReviewDecisionSource::Agent` (`v2/item.rs:488-497`), and the client is told
about it AFTER the fact through `item/autoApprovalReview/started` and
`item/autoApprovalReview/completed` notifications
(`app-server-protocol/src/protocol/common.rs:1944-1947`), never through the
approval request channel. Whether it runs at all is config-gated
(`guardian/decision.rs:66-72`).

Read that against APRV-325's third acceptance criterion, which this project
already committed to: a mandatory executor "reuses attested APPROVAL.md and
verified runtime authorization rather than model judgment or native approval
impersonation". A channel whose questions can be resolved by a model before the
client ever sees them is model judgment sitting in front of the gate. It does
not impersonate our approval, and it does not forge a grant. What it does is
decide that a question does not need asking, which has the same effect on the
log: nothing arrives, and nothing is recorded, and the silence is
indistinguishable from a turn that never wanted to act.

The control over it is configuration, and configuration of the harness is not a
gate organ this project attests. So the property "every side effect in this
session produced a question" is not something the protocol gives. It is
something an operator's Codex configuration gives, and the bridge would have to
verify rather than assume it.

**Flagged unconfirmed, and left unconfirmed rather than guessed.** The
auto-reviewer's context includes thread history (`guardian/decision.rs:106`),
which is agent-authored content. Whether that creates a practical path for the
acting model to influence its own review was not established from the code and
is not asserted here in either direction. It is one of the follow-ups below.

**observed (2026-09-18):** zero auto-review notifications across the five
trials. The full method vocabulary seen on the wire was
`account/rateLimits/updated`, `item/agentMessage/delta`,
`item/commandExecution/requestApproval`, `item/completed`,
`item/fileChange/requestApproval`, `item/started`,
`mcpServer/startupStatus/updated`, `remoteControl/status/changed`,
`serverRequest/resolved`, `thread/started`, `thread/status/changed`,
`thread/tokenUsage/updated`, `turn/completed`, `turn/diff/updated` and
`turn/started`. `serverRequest/resolved` (seen on `approve` and `deny`) is the
server announcing that a question was resolved, which a bridge can use to
confirm its answer landed. This says the auto-reviewer did not run under the
operator's configuration that evening; it does not say it cannot.

## Question 4: how a decision would reach the phone and the log

The bridge would reuse the flow `src/cli/hook.ts` already runs, with the
JSON-RPC round trip replacing the hook's stdin and stdout.

1. **Classify.** The command string (or argv) and the `cwd` from the request go
   through the same classifier every harness uses. This is the step the native
   hook cannot reach.
2. **Register.** `register(logPath, {task, envelope}, actor, ...)`
   (`src/cli/hook.ts:2579`) writes the proposal, with Codex provenance as a call
   option rather than as an envelope field, because an envelope is authored by
   the party under oversight.
3. **Request.** One `request(...)` per class (`src/cli/hook.ts:2601`), with
   `execution: "harness"`, which is correct here for the same reason it is
   correct for the hook: Codex runs the command, `approval run` never does, so a
   minted token would be a live credential with no spender.
4. **Wait.** The hook's wait loop (`src/cli/hook.ts:2680`) polls the verified
   view until every key is granted or the deadline passes. The bridge's deadline
   is the interesting change: with no protocol timeout (question 2), it can be
   the policy's TTL rather than a harness ceiling, and the retry grace and
   adopt-on-retry machinery that exist to make a denial-by-deadline recoverable
   stop being necessary.
5. **Answer.** `{id, result: {decision: "accept"}}` or `"decline"`, on the same
   connection.

**Latency.** Two log appends and one round trip are added to each gated call.
Against a human decision measured in seconds to minutes, that is noise. Under
`autonomous` and `supervised` classes no human is involved and the added cost is
the appends alone, which is the same cost the hook pays today. The number the
operator actually feels is unchanged, with one improvement: today a manual class
denies when the harness ceiling runs out and asks the agent to retry, and here
it would simply keep waiting.

**observed (2026-09-18):** still not separable. On `approve` the first request
arrived 9 s after `turn/start` and the second 3 s after the first was answered,
and both intervals include a model call. The bridge's own cost is the two
appends and the reply, which this run cannot isolate.

## Question 5: does it compose with the sandbox and the broker, or replace them?

**It composes, and it replaces neither.** They answer different questions.

**Against the sandbox.** Whether a question is asked at all depends on the
approval policy and on whether a sandbox is available, decided in
`render_decision_for_unmatched_command_for_platform`
(`codex-rs/core/src/exec_policy.rs:770-855 @ b0659c5`). The real
`AskForApproval` variants are `Never`, `OnRequest`, `UnlessTrusted` and
`Granular` (`codex-rs/core/src/safety.rs:44-58 @ b0659c5`), which are not the
`untrusted`/`on-failure`/`on-request`/`never` names older documentation uses.
`Never` allows and relies on the sandbox (`exec_policy.rs:810-814`). `OnRequest`
allows in an unrestricted sandbox and prompts inside a restricted one only when
the command asks to escape it (`:820-839`). `UnlessTrusted` prompts always
(`:815-819`). Patches follow `assess_patch_safety`
(`safety.rs:29-84`), where `UnlessTrusted` is the variant that unconditionally
asks (`safety.rs:49-51`).

So the sandbox is not a thing the bridge sits beside. It is a thing that decides
how much the bridge sees. A read-only sandbox with `OnRequest` produces very few
questions, and a bridge under it would be gating escapes rather than gating
work. `UnlessTrusted` is the only variant under which "every command asked" is
true, and it is a setting in the harness's own configuration.

**observed (2026-09-18):** the wire name is `untrusted`. `thread/start` with
`approvalPolicy: "unless-trusted"` was refused with `unknown variant
\`unless-trusted\`, expected one of \`untrusted\`, \`on-request\`, \`granular\`,
\`never\``, and `"untrusted"` was accepted. Follow-up 6 below pins that
spelling. Under it, with `sandbox: "read-only"`, every command and every patch
in the run produced a question.

**Against the broker.** `approval codex apply` and its one-tool server
(`docs/codex-workspace-broker.md`) are a MANDATORY door: the canonical workspace
is writable only through them, every leg starts before any byte moves, the
change is journaled under a lock, and the outcome comes from reading the
workspace back. The bridge is an ADVISORY checkpoint: it decides about an action
the harness is about to take, in the harness's own process, under the harness's
own configuration, with an auto-reviewer that may answer first. Those are not
comparable strengths and the bridge should not be described as if they were.

Where the bridge earns its place is the case the broker does not cover: everyday
sessions, where the work is shell and patches in a disposable workspace and the
alternative today is APRV-311's blanket refusal. Confinement (APRV-325.3) makes
such a session safe by removing capability. The bridge would make it
GOVERNED, by putting each remaining action through the policy and the log. The
two stack: a confined session whose remaining capability is also gated is
strictly better than either alone, and neither is weakened by the other.

## What the bridge could bind, and what it could not

Could bind, from the request itself:

- the command, as argv on the legacy API and as a shell-joined rendering on the
  item-based one;
- the `cwd` of the exec call, which is the field the native hook lacks;
- a stable call identity (`itemId`, or `callId` on the legacy API), plus
  `threadId` and `turnId`;
- the declared decision vocabulary, so a client answers in the server's words
  rather than in a pinned enum;
- the reason and, where present, the network approval context.

Could not bind:

- the patch content on the item-based API, which arrives on a different frame
  and is referenced by identity;
- the guarantee that an action produces a question, which belongs to the
  approval policy and the sandbox posture;
- the guarantee that a question reaches this client, which an auto-reviewer can
  pre-empt;
- the guarantee that a replayed question is answered by this client, since a
  pending request is resent to whatever connects next;
- anything at all about a Codex started outside this arrangement, which is the
  same limit `docs/codex-activation.md` states for the confined session.

## The probe

`scripts/probes/codex-app-server.mjs`, three modes: `--setup` builds a scratch
workspace of synthetic files under a fresh `fs.mkdtemp` directory, `--run`
drives `codex app-server` as the approval client through five trials, and
`--report` prints the findings. The trials are `approve`, `deny`, `crash`,
`no-reply` and `malformed`, each in its own workspace, each asking for one
harmless command and one harmless patch.

It never reads a credential, never touches the Codex home, and redacts anything
token-shaped before recording a frame. It uses the operator's existing login,
because a real approval request needs a real turn, and it checks authentication
first and stops cleanly rather than guessing. A run is a billable model call.

It is exercised in CI against a stub server that speaks the shape above
(`tests/probe-codex-app-server.test.ts`), so the script the operator runs once
has already been run. One of those tests exists specifically to stop this note
from being written the wrong way round: a second stub performs the effect BEFORE
the answer arrives, and the report must call that a failure to block in those
words. A probe that could present a fail-open result as enforcement would be
worse than no probe.

The report prints, per approval kind, the union of params key paths and a
presence line for `cwd`, a call id, command bytes, patch content and a reason;
then the count of auto-review notifications; then one row per trial saying
whether each effect happened. Four of those rows must say no.

## Recommendation

**Adopt, narrowly, and do not call it a boundary.** Provisional when written;
confirmed by the 2026-09-18 run, which met all three conditions below: no
effect on any refusal trial, zero auto-review notifications, and `command` plus
`cwd` populated on every exec request. Confirmed once, on one machine, at
0.155.0.

Adopt as the everyday-gating answer for Codex sessions this runtime starts: the
exec request carries the `{command, cwd}` pair that APRV-311's refusal is
waiting for, the reply channel fails closed on silence, on a crashed client and
on a malformed answer, and the absence of any protocol timeout removes the one
constraint that shapes the Claude Code hook's whole wait design. That is a
better everyday gate than a blanket refusal and a better one than the hook could
be even if the upstream issue in `docs/upstream/codex-hook-payload.md` were
accepted tomorrow.

Decline as a replacement for the broker or for confinement. The auto-reviewer
can resolve a question before the client sees it, the approval policy and
sandbox posture decide how many questions exist, and a pending question is
replayed to whatever connects next. Every one of those is governed by the
harness's own configuration, which this project does not attest. A mandatory
boundary has to be one the configuration cannot open, and the broker is that and
this is not.

The adoption is conditional on three things the probe must show, and any one of
them failing overturns it:

1. no effect landed on `deny`, `crash`, `no-reply` or `malformed`;
2. no auto-review notification appeared, so no question was answered before the
   client saw it;
3. the exec request carried both `command` and `cwd`, populated.

If the probe shows an effect on a refusal trial, this note is wrong and the
answer is decline, recorded with the failing evidence exactly as APRV-325 did.

## Using it (APRV-361)

The bridge landed as `approval codex bridge`. It starts `codex app-server`,
runs one turn, and answers every approval request that turn raises.

```
approval codex bridge --prompt "refactor the parser" --workspace ~/dev/scratch
```

Flags: `--workspace` is the thread's directory (default the cwd), `--as` the
acting identity (default `agent:codex`), `--dir`/`--policy`/`--log` resolve the
policy and the log exactly as the hook resolves them, `--wait` overrides the
deadline (default the policy's `approval_ttl`), `--interval` is how often the
verified view is re-read, and `--json` prints one object carrying every answer.
A command after `--` replaces `codex app-server`, which is how the tests drive a
stub that speaks the shape recorded above.

What happens per request: the `command` and `cwd` on the frame become the hook's
own input, and the decision comes from `cli/hook.ts`'s `decideHarnessCall` — the
same classifier, the same human-only refusal, the same loop floor and unattended
guard, the same register, request and wait against the verified view. The reply
is `{id, result: {decision}}`, sent only once that sequence has an answer.

The vocabulary comes from `availableDecisions` on the request, matched exactly
and never by prefix, so `acceptWithExecpolicyAmendment` is not read as an
accept. `acceptForSession`, `cancel` and `abort` are never sent, for the reasons
under "The decision vocabulary" above. A request that advertises nothing gets
`accept` or `decline`, and the report says the word was the client's own.

**That rule is a type and a suite since APRV-367** (follow-up 7, landed). The
reply word is a closed union of eight spellings of the two words, so a value
outside it cannot be constructed; one function turns a decision into bytes and
re-checks membership there; and a word that somehow failed the check is sent as
a decline, since the only safe substitute for a word you cannot name is no. The
`bridge-decisions` conformance suite states the same rule for a second
implementation, including the two vectors a prefix matcher fails.

Three refusals are the bridge's own rather than the gate's:
`bridge-request-unbound` (no command, no `cwd`, or no call identity),
`bridge-file-change-unbound` (an item-based file change carries no content, and
approving an identifier is not approving a change), and
`bridge-unknown-request` (a server request this client has no reading for). They
are a conformance union, so a second implementation answers all three or has
left a door open.

**Two limits, stated rather than implied.** An open gate window is NOT honoured:
the hook's bypass prints a hook verdict and appends a record shaped for the
hook, and ignoring a window is the strict direction, so an operator who opens
one will find this verb still asking. And questions are answered one at a time,
because the gate's wait is synchronous: frames queue while a decision is being
made, which is the fail-closed direction and matches the observed protocol,
where a turn does not move past an unanswered question.

Follow-ups 2 through 8 below are separate tasks: the command is bound as the
string that arrived (APRV-362), the auto-reviewer is not proved off (APRV-364),
and socket custody is unsettled (APRV-365). Until those land, the claim stays
exactly what the recommendation says it is.

**The approval policy pin is now checked (APRV-366, landed).** The thread is
still started with `approvalPolicy: "untrusted"` and `sandbox: "read-only"`, and
what changed is that the answer is read. A refused `thread/start` stops the run
with `bridge-thread-start-refused`, carrying the server's own error, which is
where a refusal of the value itself arrives. A server that reports an effective
approval policy of its own, on the `thread/start` result or on a thread
notification, stops the run with `bridge-approval-policy-mismatch` when that
policy is not `untrusted`. Neither is a member of the declines union: those are
answers to one approval request, and these end the session.

What it still cannot do is make a silent server speak. The 0.155.0 server echoes
no approval policy at all, so a client that demanded an echo could not run
against the server this verb exists for; an absent value is therefore not a
stop, and the report says so rather than claiming more. `thread.requested` is
what went on the wire, `thread.effective` is what the server said, and
`thread.confirmed` is false when nothing confirmed it. An operator reading
`confirmed: false` knows the pin was asked for and not proved, which is a
different fact from the pin holding.

## The tasks an adopt would need

Filed 2026-09-18 on the operator's decision, in this order: APRV-361 (the
bridge), then 362 to 368 depending on it.

1. **The bridge client itself.** An `approval codex bridge` verb that starts
   `codex app-server`, speaks the protocol, and puts each approval request
   through classify, register, request, wait and answer. Reuses
   `src/cli/hook.ts`'s flow; it does not fork it.
2. **Bind argv rather than a rendering.** Decide between the legacy API's argv
   and the item-based API's shell-joined string, and if the latter is required,
   record the re-parse alongside the received string so a mismatch is visible
   rather than silent.
3. **Refuse a file-change approval whose content is unbound.** Correlate the
   `itemId` with the content from `item/started`, and refuse with a distinct
   machine-readable code when the correlation cannot be made. Approving an
   identifier is not approving a change.
4. **Prove the auto-reviewer is off, and refuse when it is not.** A preflight
   and a doctor row. A session with an auto-reviewer in front of the gate is a
   session whose silence means nothing, and the bridge should say so rather than
   run.
5. **Custody of the socket.** Decide and enforce who may connect, given that a
   pending request is replayed to the next connection. Until that is settled,
   the bridge's claim is "this client decided every question it was asked",
   which is narrower than "every question was decided here".
6. **Pin the approval policy.** `UnlessTrusted` (`"untrusted"` on the wire) is
   the only variant under which every command asks. An adoption that does not
   pin it is gating an unknown fraction of the session. **Landed (APRV-366):**
   sent with no flag to override it, and checked, with a stop code for a
   refusal and a stop code for a different effective policy. A server that
   reports none is run against and recorded as unconfirmed.
7. **Refuse `acceptForSession`.** Standing authority for a whole session is a
   grant shape this project does not have, and a bridge must never emit it.
   **Landed (APRV-367):** the reply vocabulary is a closed type, the encoder is
   one function that re-checks it at runtime, and the `bridge-decisions`
   conformance suite pins which word a given advertisement gets.
8. **Conformance vectors** for the bridge's refusal union, and a SPEC §6.3 row,
   once the behaviour is settled enough to pin.

## Invariants this note touches

From CLAUDE.md's list, which binds every task whether or not it is restated:
**fail closed** (the whole of question 2, and the recommendation's first
condition); **self-reported fields never reduce scrutiny** (the `cwd` here is
minted by the harness runtime rather than reported by the model, which is what
makes it usable at all, and the `reason` and `commandActions` fields are
display, never input to a decision); **refusals are machine-readable and
distinct** (follow-ups 3 and 4 each need their own code rather than borrowing
one); and **enforcement paths read only verified records** (the wait step reads
the verified view, unchanged). Nothing here writes to the log, and nothing here
is implemented yet.
