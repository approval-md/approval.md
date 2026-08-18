# approval.md

**Human approval for agent actions.**

Version: 0.1.0-draft · Status: Draft · License: MIT · Canonical URL: https://approval.md

> Your AGENTS.md says "require approval first." approval.md enforces it, and puts the approve button on your phone.

---

## 1. Abstract

approval.md is a file-based convention and reference runtime for gating AI agent actions that have real-world side effects: sending messages, spending money, deleting data, posting publicly, writing to calendars. It defines:

1. **`APPROVAL.md`**, a human-authored policy file that declares which classes of side effect an agent may perform autonomously, which require human sign-off, and under what budgets.
2. **An agentic envelope**, a namespaced YAML frontmatter extension for markdown task files (compatible with [Backlog.md](https://github.com/MrLesk/Backlog.md)) declaring a task's origin, routing, side effects, budget, and approval state.
3. **An append-only event log** (JSONL, hash-chained) as the tamper-evident source of truth for every proposal, decision, and execution.
4. **A daemon and CLI** that watch a task folder, route tasks by declared side effects, push approval requests to pluggable channels (Telegram is the reference adapter), and gate execution on granted approvals.

Design mantra: **files are the interface, the log is the truth, the database is a cache.**

## 2. Motivation and gap

Agents now produce more actions than a human can review. The coding world solved its version of this problem: [Backlog.md](https://github.com/MrLesk/Backlog.md), Taskmaster, and Vibe Kanban let you review an agent's *intent* (acceptance criteria before, implementation notes after) instead of every diff, and a bad merge is revertible anyway.

Once agents leave the repo, that safety net disappears. A sent email, a payment, a deleted account, a public post: there is no diff to revert. The artifact that must be reviewed *before* execution stops being the plan and becomes the **side-effect declaration**.

The ecosystem has converged on prose versions of this idea without an enforcement layer:

- [AGENTS.md](https://agents.md) files routinely contain permissions sections splitting actions into "allowed without prompting" and "require approval first" (package installs, `git push`, file deletion, `terraform apply`). These lists are instructions the agent is trusted to obey. Nothing checks.
- [HumanLayer](https://github.com/humanlayer/humanlayer) provides approval-as-a-service SDKs (`require_approval()` routed to Slack/email/SMS), but couples approval to a hosted service and an in-process decorator rather than a portable, inspectable file convention.
- [LangGraph interrupts](https://langchain-ai.github.io/langgraph/concepts/human_in_the_loop/) and the [OpenAI Agents SDK human-in-the-loop flow](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/) pause a graph for approval, but the approval state lives inside one framework's runtime and dies at its boundary.
- [Google's A2A protocol](https://a2a-protocol.org) models an `input-required` task state, and [MCP](https://modelcontextprotocol.io) has elicitation and an experimental tasks extension, but neither defines what *deserves* escalation, budgets, or a durable audit record.
- [mission-control](https://github.com/MeisnerDan/mission-control) ships autonomy levels, spend limits, and an approval inbox, but as a closed-world product with its own mutable JSON store: no interchange, and an audit trail that anything with file access can rewrite.
- Coding harnesses enforce permissions locally. [Claude Code's permission rules](https://code.claude.com/docs/en/permissions) (`allow` / `ask` / `deny` lists such as `Bash(git push:*)` in `.claude/settings.json`, evaluated deny-first, backed by PreToolUse hooks and an OS sandbox), [Codex CLI's approval policy and sandbox modes](https://developers.openai.com/codex/agent-approvals-security), [Gemini CLI's approval modes](https://google-gemini.github.io/gemini-cli/docs/get-started/configuration.html), and [Cursor's run modes](https://cursor.com/docs/agent/security/run-modes) are checked by the harness itself, so unlike AGENTS.md prose they actually block. Each is bound to its own runtime, though, and none treats the approval as a record: a "yes, don't ask again" in Claude Code becomes an allow rule appended to `.claude/settings.local.json`, with no trace of who approved, when, or for what, and the closest thing to a ledger is opt-in telemetry the operator must collect. None carries budgets, expiry, or delegation. (`permissions.md` is not an established convention in any of these ecosystems; the name only surfaces as Claude Code's docs page rendered as markdown.)
- Task data standards ([RFC 8984 jsCalendar](https://www.rfc-editor.org/rfc/rfc8984), [RFC 5545 iCalendar VTODO](https://www.rfc-editor.org/rfc/rfc5545)) model due dates and recurrence, and predate the questions "which agent may do this, what will it cost, and who signed off?"

The gap: **a portable, file-based, framework-agnostic layer that turns "ask first" from prose into a checked invariant, with a tamper-evident record of who approved what.** approval.md fills exactly that gap and nothing more.

## 3. Design principles

1. **Files are the interface.** Policy, tasks, and rendered views are markdown a human can read in any editor and an agent can read with `cat`. No required server to inspect state.
2. **The log is the truth.** All state transitions are immutable events in an append-only, hash-chained JSONL log. Markdown files and databases are projections rebuilt from it.
3. **Approval state is data; channels are transport.** A pending approval is a fact in the log. Telegram, the local web queue, and the CLI are interchangeable notifiers, never owners of state.
4. **Deterministic logic in code, LLMs for language only.** Routing, gating, budget math, and log verification are deterministic. Models may *propose* (draft an email, suggest a route); the runtime *decides* per policy.
5. **CLI-first agent interface.** Agents interact through a CLI whose schemas and instructions ship in `--help` (a lesson from Backlog.md's [MCP retreat](https://mrlesk.dev)). MCP is a thin optional wrapper over the same commands.
6. **Extend, don't replace.** Task files are Backlog.md-format markdown; the envelope is one namespaced frontmatter key. AGENTS.md permissions sections import as policy. No new task format is invented.
7. **Honest security.** This is an oversight layer for broadly cooperative agents, with hard enforcement only at adapter boundaries that hold the credentials. The threat model (§11) says exactly what is and is not defended.

The keywords MUST, SHOULD, MAY are per [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

## 4. Terminology

| Term | Meaning |
|---|---|
| **Action** | A single side-effecting operation an agent wants to perform (send one email, make one payment). |
| **Task** | A markdown file describing work; may spawn multiple actions. |
| **Side-effect class** | A dotted-namespace label for a category of action, e.g. `communicate.email.external`. |
| **Policy** | The rules in `APPROVAL.md` mapping classes to autonomy levels, approvers, and budgets. |
| **Autonomy level** | `manual` (approval required per action), `supervised` (proceed, but sampled for retrospective review), `autonomous` (proceed silently). |
| **Approval** | A recorded human decision (`granted` / `rejected`) on a specific requested action. |
| **Execution token** | A single-use token minted on grant, required by adapters to execute. |
| **Channel** | A transport plugin that surfaces requests and collects decisions (Telegram, local web, CLI). |
| **Adapter** | A side-effect executor (email sender, calendar writer) that holds credentials and refuses to act without a valid token. |
| **Projection** | Any derived view of the log: the queue file, the SQLite index, the web UI. |

## 5. The `APPROVAL.md` policy file

`APPROVAL.md` lives at the root of a project (or `~/.approval/APPROVAL.md` for a global personal policy). It is prose for humans plus exactly one fenced ` ```yaml approval-policy ` block for machines. Implementations MUST parse the fenced block and MUST ignore surrounding prose. Implementations MUST also accept the filename `APPROVALS.md` as a fallback, with `APPROVAL.md` taking precedence when both exist.

### 5.1 Canonical example

````markdown
# Approval Policy

Agents working in this project handle my life admin. Anything that leaves
the machine gets declared, and the classes below say what I sign off on.

```yaml approval-policy
version: "0.1"

defaults:
  autonomy: manual          # unknown/undeclared classes require sign-off
  channel: telegram
  approval_ttl: 24h         # pending requests expire
  on_expiry: reject

approvers:
  carter:
    channels: [telegram, cli]

classes:
  read.*:                       { autonomy: autonomous }
  files.write.workspace:        { autonomy: autonomous }
  calendar.write.own:           { autonomy: supervised }
  communicate.email.draft:      { autonomy: autonomous }
  communicate.email.external:
    autonomy: manual
    approvers: [carter]
  financial.spend:
    autonomy: manual
    approvers: [carter]
    limits: { per_action_usd: 25, daily_usd: 100 }
  public.post:                  { autonomy: manual }
  data.delete:                  { autonomy: manual }
  account.auth:                 { autonomy: manual }

budgets:
  global: { daily_usd: 100, daily_actions: 200 }

audit:
  supervised_sample_rate: 0.10   # fraction of supervised actions escalated
                                 # for retrospective human review

channels:
  telegram:
    chat_id_env: APPROVAL_TG_CHAT
    token_env: APPROVAL_TG_TOKEN
  web:
    port: 4680
```
````

### 5.2 Policy semantics

- **Matching.** Classes match most-specific-first; `*` is a single-segment wildcard, a trailing `.*` matches any depth. An action whose class matches no rule takes `defaults.autonomy`. Implementations MUST fail closed: unparseable policy means everything is `manual`.
- **Specificity.** Pattern specificity is compared as follows: (1) more literal (non-wildcard) segments is more specific; (2) ties broken by fewer wildcard segments; (3) remaining ties by greater total segment count; a trailing `.*` counts as a single wildcard segment and contributes no literal segments. Patterns still tied are equally specific and the strictest-autonomy rule applies.
- **Deny beats allow.** If multiple rules match at equal specificity, the strictest autonomy wins (`manual` > `supervised` > `autonomous`).
- **Budgets are conjunctive.** An action must pass its class limits AND global budgets. Budget consumption is computed from the log, never from a mutable counter. Budget windows are rolling: a `daily` limit is evaluated over the 24 hours preceding the evaluation moment, computed solely from the event log; evaluation is deterministic given the log and the evaluation timestamp. Budgets meter authorization, not completion; an authorized action consumes budget whether or not it ultimately executes.
- **`supervised_sample_rate`** implements auditing under a budget: supervised actions execute immediately, and a deterministic pseudo-random sample is queued for after-the-fact human review. Sample selection MUST be reproducible by the operator and unpredictable to agents. Implementations derive the selection value as HMAC-SHA-256 over the event hash using an operator-held secret stored outside the repository and outside any agent-readable path. Seeding from event content alone is forbidden: the authoring agent controls that content and could search it until its action falls outside the sample. See §11 for why. The secret is configured by name: `audit.sampling_secret_env` holds the *name* of the environment variable the operator keeps it in, so the policy file an agent may read carries a variable name and never the secret itself. The secret MUST NOT appear in the log, in any command's output, or in any error message. When the rate is absent or zero, or the secret is unnamed or unset in the runtime's environment, **sampling is disabled and the runtime states the reason in machine-readable form**. This is the one place the runtime does not fail closed, and the reason is that the strict reading is unavailable: escalating everything would require a selection function, the only remaining seed is the event content, and a content-seeded sample is one the authoring agent can steer. A control that looks like it is running while being steerable by the party under oversight is worse than a control that is visibly off. Sampling is retrospective, so a disabled sampler costs review coverage and authorizes nothing: no gate consults it and no budget is spent by it. (Amended APRV-40, which implements the sampler in the M5 daemon.)
- **Request-volume limits.** `limits.max_pending` (per class or global): maximum simultaneously pending requests; further requests are refused at intake with reason `queue-full`. `limits.requests_per_hour` (per origin): rolling-window ceiling on request creation; excess is refused with reason `rate-limited` and logged. Defaults are generous; the purpose is a tripwire against queue-flooding and approver fatigue, which attack the human's attention rather than the action budget. Refused requests consume no budget and no attention beyond the log line. (Policy vocabulary in v0.1; enforcement lands with M4/M5.)
- **Agents MUST NOT be able to modify `APPROVAL.md`, the log, or channel credentials.** The reference runtime refuses to mint tokens if the policy file's mtime/hash changed without a signed `policy.updated` event from a human session. Attestation makes this mechanical: a human runs `approval policy attest`, which appends a `policy.updated` event carrying the SHA-256 of the policy file's bytes. Gate operations — request intake, grant recording, token minting — MUST refuse, with a distinct machine-readable reason, whenever the live file's hash differs from the latest attestation or no attestation exists. An edited policy is inoperative until a human re-attests it.
- **`payload_retention`.** An optional top-level duration bounding how long the payload bytes in `.approval/payloads/` (§9) are kept. A payload is prunable once the action it is bound to has been in a terminal state (`executed`, `rejected`, `expired`, `revoked`) for longer than the duration. A payload whose action is not terminal is never prunable, at any age: a pending or granted approval binds to those exact bytes, and discarding them would leave a live authorization pointing at nothing. When the key is present, orphaned payloads (bytes with no recorded binding) are prunable at any age: the duration governs bound payloads and does not gate residue nothing ever bound. When the key is absent, the pruning subsystem does not run and nothing is deleted, orphaned or not; the store holds the material evidence of what a human approved, so forgetting anything is an operator's explicit choice, and an operator who never made that choice never asked the runtime to delete anything (amended APRV-49 to match the enforcement shipped in APRV-41). Pruning is performed by the daemon and by nothing else, and each removal appends a `payload.pruned` event, so a log states what its store no longer holds. (Policy vocabulary in v0.1; enforcement lands with the M5 daemon.)
- **`vault.passphrase_env`.** An optional top-level key naming the environment variable that holds the passphrase for the credential vault of §10.4. The policy carries the variable's *name*, never the passphrase, on the same reasoning as `audit.sampling_secret_env` and the channel credential keys (`chat_id_env`, `token_env`): agents may read `APPROVAL.md`, and a passphrase they can read is a vault they can open. The passphrase MUST NOT appear in the log, in any command's output, or in any error message. When the key is absent the runtime reads `APPROVAL_VAULT_PASSPHRASE`; a variable name is not a permission, so an unnamed one MUST NOT lock an operator out of credentials they created, and a policy that fails to load leaves the default in force for this key alone. (Amended APRV-68, which implements the reference vault.)
- **`channels.telegram.token_env` and `channels.telegram.chat_id_env`** are honoured by the runtime exactly as `audit.sampling_secret_env` and `vault.passphrase_env` are: the policy carries the variable's *name*, the runtime reads the value from the environment under that name, and a policy that declares neither (or fails to load) gets the reference runtime's defaults, `APPROVAL_TG_TOKEN` and `APPROVAL_TG_CHAT`. (Amended APRV-72.)
- **Durations.** Every duration-valued field (`approval_ttl`, budget windows, `max_latency`, `payload_retention`) is a string matching `<positive integer><unit>` with unit one of `ms`, `s`, `m`, `h`, `d`, `w` (weeks = 7 days). Single unit only: compound (`1h30m`), fractional (`1.5h`), zero, and leading-zero forms are invalid. An invalid duration anywhere in the policy is a schema violation and the policy fails closed.

## 6. The task envelope

Task files are ordinary Backlog.md-style markdown (`backlog/task-042 - Chase-deposit.md` and similar). approval.md adds one frontmatter key, `approval:`, holding the entire envelope. Implementations MUST preserve unknown frontmatter keys when rewriting files, and MUST tolerate tasks with no envelope (they simply cannot request side-effecting execution).

### 6.1 Canonical example

Note the canonical example is an email, deliberately. This spec governs agent actions in the world; it is unrelated to PR review, CODEOWNERS, or release sign-off.

```yaml
---
id: task-042
title: Chase deposit refund from letting agency
status: In Progress            # owned by Backlog.md / your board
approval:
  origin:
    app: example-capture       # provenance: which system created this
    created_by: "human:carter" # or "agent:<id>"
  route:
    assignee: "agent:claude-admin"
    confidence: 0.82
    rationale: "templated chaser, known counterparty, no negotiation"
  state: awaiting              # see §6.3
  actions:
    - class: communicate.email.external
      summary: "Send deposit chaser to agency@example.co.uk"
      reversible: false
      est_cost_usd: 0.02
      idempotency_key: "task-042:chaser:2026-08-04"
  budget:
    max_cost_usd: 0.50
    max_latency: 6h
---

## Description
Deposit (£1,200) due back since 12 July. One polite chaser sent by me on
21 July, no reply. Agent should send a firmer follow-up citing the
deposit-protection scheme deadline.

## Acceptance Criteria
- [ ] Email sent to the agency referencing scheme deadline
- [ ] Reply, if any, filed back onto this task
```

### 6.2 Envelope fields

| Field | Req | Meaning |
|---|---|---|
| `origin.app` | MUST | Source system (`example-capture`, `manual`, …). |
| `origin.created_by` | MUST | `human:<id>` or `agent:<id>`. |
| `route.assignee` | SHOULD | `human` or `agent:<id>`. Routing proposals from agents are events, never silent edits. |
| `route.confidence` | MAY | 0.0–1.0; used as a monitoring signal (§11). |
| `state` | MUST | Approval lifecycle state (§6.3), distinct from board `status`. |
| `actions[]` | MUST for execution | Each declared action: `class`, `summary`, `reversible`, `est_cost_usd`, `idempotency_key`. |
| `budget` | MAY | Task-level caps, conjunctive with policy budgets. `max_latency` is declared in the envelope and recorded at registration; its enforcement (bounding time-to-decision and time-to-execution) lands with the daemon (M5) and is not yet a runtime obligation. |
| `idempotency_key` | MUST per action | Stable string; adapters MUST refuse to execute the same key twice. |
| `payload_hash` | MUST for `manual` actions, SHOULD otherwise | SHA-256 over the RFC 8785 canonical serialization of the action's concrete payload: for a message send, the full body and recipients; for `approval run`, the argv array and cwd; for a record write, the proposed record content. The payload itself is stored or referenced by the request so channels can display it; the hash is what approval binds to. |

### 6.3 Approval lifecycle

```
proposed ──▶ awaiting ──▶ approved ──▶ executed
                │             │
                │             └─▶ revoked      (human, before execution)
                ├─▶ rejected
                └─▶ expired                    (TTL, per on_expiry)
```

`state` is a **projection** of log events; the file is updated by the daemon after the event is appended, never the reverse. A file edit that contradicts the log is itself logged (`envelope.drift`) and surfaced.

`approval.*` events are exclusive to the manual path and always record a human decision. Actions whose class resolves to `supervised` or `autonomous` emit no `approval.requested` or `approval.granted`; their execution is recorded by `execution.*` events, and supervised actions are additionally eligible for `audit.sampled` and `audit.reviewed`.

## 7. Side-effect taxonomy (v0.1)

Dotted, hierarchical, extensible. Top-level namespaces are reserved by this spec; implementations MAY add sub-classes freely and SHOULD upstream common ones.

| Namespace | Examples | Default gravity |
|---|---|---|
| `read.*` | web fetch, file read, API GET | autonomous |
| `files.write.*` | workspace writes, repo commits | autonomous/supervised |
| `communicate.*` | `.email.external`, `.message.telegram`, `.email.draft` | manual for external sends |
| `calendar.write.*` | own calendar, shared calendar | supervised |
| `financial.*` | `.spend`, `.transfer`, `.subscribe` | manual, always |
| `public.*` | `.post` (X, forums), `.publish` | manual, always |
| `data.delete` | destructive deletes outside workspace | manual, always |
| `account.*` | `.auth`, `.create`, `.credential` | manual, always |
| `physical.*` | orders, bookings with cancellation cost | manual |
| `record.*` | `.write.stage`, `.categorize`, `.create`, `.archive` | supervised or manual, per ownership preference |

The developer-workstation namespaces below are reserved alongside them. They name the side effects of an agent working inside a software repository, which is where AGENTS.md permissions prose lives and where `approval import agents-md` (§12) lands; the reference repository's own policy has used them since its policy engine landed, and the import verb emits them. Their gravity is stated for a shared codebase; a solo scratch repository may loosen it.

| Namespace | Examples | Default gravity |
|---|---|---|
| `vcs.*` | `.commit.branch`, `.push.branch`, `.push.main`, `.history.rewrite` | autonomous for branch commits and pushes; supervised for the trunk; manual for history rewrites |
| `deps.*` | `.add`, `.upgrade`, `.remove` | manual: a dependency change is a supply-chain decision |
| `release.*` | `.publish`, `.tag`, `.version` | manual, always |
| `exec.*` | `.local` (tests, lint, build, scripts inside the workspace) | autonomous |
| `network.*` | `.call` (any request beyond package installs) | manual |
| `policy.*` | `.edit` (the policy file, agent instructions, CI and release configuration) | manual, always |

`files.delete.out_of_scope` (destructive deletes outside the task's stated scope, inside the workspace) sits under the existing `files` namespace at manual; `data.delete` remains the class for deletes outside the workspace.

Two invariants: an action's class MUST be declared before an execution token can be requested for it, and `reversible: false` actions MUST NOT be eligible for `autonomous` regardless of policy (the runtime enforces this floor).

The irreversibility floor resolves to `manual`: an action declared `reversible: false` MUST NOT execute under `autonomous` or `supervised` regardless of policy. Retrospective audit cannot undo an irreversible action, so execute-then-sample is not meaningful oversight for one. Implementations MUST apply the floor after class resolution and record in the decision trace when the floor, rather than the matched rule, determined the outcome.

For `record.*` classes, grant means adoption: the action proposes a write to a system of record (a task stage, a note category, a pipeline state), and approval commits it. The "adapter" is whatever write path owns the record; it MUST hold proposed writes in a staged state invisible to, or visibly provisional in, the record proper until granted. `record.*` actions are typically reversible; policies gate them for cognitive ownership rather than consequence, and both rationales are first-class (see §11).

## 8. The event log

`.approval/log/events.jsonl`, append-only. One JSON object per line:

```json
{"seq":17,"ts":"2026-08-04T09:14:02Z","event":"approval.granted",
 "task":"task-042","action_key":"task-042:chaser:2026-08-04",
 "actor":"human:carter","channel":"telegram",
 "payload":{"note":"go, but cc me"},
 "alg":"sha256/jcs","prev":"b3c9…","hash":"a41f…"}
```

- `hash` = SHA-256 over the canonical serialization of the record with `prev` included; `prev` = previous record's hash. `approval log verify` MUST detect any mutation or truncation. Optionally, the log directory is a git repo and the daemon commits per event with its own identity, giving signed, distributed tamper evidence for free (the [TaskChampion operation log](https://github.com/GothenburgBitFactory/taskchampion) and [Automerge](https://automerge.org) both converged on op-logs for related reasons; see also Ink & Switch's [local-first task framework](https://www.inkandswitch.com/patchwork/notebook/tasks-01/)).
- **Event types (v0.1):** `task.registered`, `route.proposed`, `route.accepted`, `approval.requested`, `approval.granted`, `approval.rejected`, `approval.expired`, `approval.revoked`, `execution.started`, `execution.completed`, `execution.failed`, `budget.exceeded`, `policy.updated`, `envelope.drift`, `audit.sampled`, `audit.reviewed`, `payload.pruned`.
- **Enum versioning.** `payload.pruned` is the first addition to the draft v0.1 set of sixteen types. Readers of a v0.1 log may encounter it, and a verifier that treated the draft set as closed MUST be updated to accept it. It is written by the daemon alone, carries a `system:` actor, and names the pruned payload by its SHA-256 (§5.2 `payload_retention`).
- Events MUST validate against the JSON Schemas in `schema/` before append. Validation at the write boundary is itself a control: an agent physically cannot request execution without declaring a class, key, and cost estimate.
- Every record MUST carry an explicit hash-scheme identifier, `alg`. Version 0.1 defines exactly one value: `sha256/jcs`, meaning SHA-256 over the RFC 8785 (JCS) canonical serialization of the record with `prev` included. Verifiers MUST reject records whose `alg` is missing or unrecognized. Records with different `alg` values MAY coexist in one log, so a future scheme change is a migration, never a schism.
- Actor identifiers use exactly three prefixes: `human:` for decisions made by a person, `agent:` for actions proposed or performed by an agent, and `system:` for runtime-originated events such as `approval.expired`. Verifiers MUST reject unrecognized prefixes.

Events written through the gate (`approval.*`, `execution.*`, `budget.*`, `audit.*`, `policy.updated`) have `ts` assigned by the runtime at the write boundary. Caller-supplied timestamps on these types MUST be refused. Because TTL judgment and budget windows read `ts`, a party subject to those controls must never author the clock they are judged by. Direct log writers outside the gate remain free to supply `ts` (per §8's writer rules); verification treats gate-type events with implausible skew relative to their neighbors as a reportable anomaly, never silently accepted. "Neighbor" means the adjacent **gate-typed** record, because a directly written event's `ts` is legitimately the writer's own and comparing against it would report correct behavior as skew. An anomaly is reported and never enforced: a chain that verifies is clean whether or not it carries anomalies, the exit code does not move, and no verdict, refusal, or authorization changes. Chain integrity is a proof and skew is a judgment, so folding the second into the first would turn verification into a check operators learn to silence. The skew allowance is implementation-defined, stated in the implementation, and generous enough that ordinary clock disagreement between hosts is not reported (the reference runtime uses 2 seconds). (Amended APRV-40.)

## 9. Projections

1. **The queue** (`.approval/QUEUE.md`): a rendered, read-only markdown view of pending requests (task, actions, declared effects, cost, TTL countdown) plus the sampled-audit backlog. Regenerated on every relevant event. This is the screenshot; it is never the truth.
2. **The index** (`.approval/index.sqlite`): rebuilt from the log (`approval reindex`), used for queries like "pending manual approvals touching `financial.*`, oldest first." Any SQLite client, including DuckDB, can read it; deleting it loses nothing.

`.approval/payloads/` sits beside these as a content-addressed material store: the bytes approvals bind to, keyed by their hash. It is not a projection, and unlike them it cannot be rebuilt from the log.

Every displayed field is one of two kinds and MUST be visibly distinguished: **computed** (derived by the runtime from the log, policy, or payload bytes: class resolution, budget state, attestation status, payload hash, chain position) and **claimed** (authored by the requesting agent: summaries, estimates, rationale, confidence). Rendering claimed fields with the visual authority of computed fields misrepresents the verification boundary to the approver and is a conformance failure for a channel.

## 10. Runtime

### 10.1 CLI (primary interface, for humans and agents)

```
approval init                      # scaffold APPROVAL.md, .approval/, gitignore
approval instructions              # full agent-facing usage guide (also in --help)
approval register  <task-file>     # validate envelope, append task.registered
approval request   <task> [--action <key>]   # -> approval.requested (manual classes;
                                             #    supervised/autonomous proceed directly
                                             #    to execution)
approval wait      <task> --timeout 6h       # block until decided; exit code = decision
approval grant|reject|revoke <request-id> [--note …]   # human-only verbs
approval token     <action-key>    # report execution-token status (the token itself
                                   #   is printed once, by `grant`; only its hash is logged)
approval run -- <cmd…>             # gate arbitrary commands: mints token, runs, logs
approval queue [--json]            # pending requests
approval log verify | tail | export
approval policy check|test <class> # explain what policy does with a class
approval reindex | render
approval daemon run                # the §10.2 watch loop, in the foreground
```

Machine-readable output: every command supports `--json`; schemas for inputs and outputs are printed by `approval instructions --schemas`.

### 10.2 Daemon

`approvald` watches the backlog folder and the log: validates new/changed envelopes, applies policy, dispatches channel notifications, expires TTLs, samples supervised actions for audit, re-renders projections, and (optionally) polls upstream sources. Loop safety: three consecutive `execution.failed` events for one task escalate to `manual` regardless of policy.

The reference runtime ships the daemon as a CLI verb, `approval daemon run`, running in the foreground and stopping cleanly on SIGINT or SIGTERM; process supervision is the operator's business at v0.1. Each pass validates the task files' envelopes, appends `envelope.drift` (a `system:` actor) where a file's `state:` contradicts the state the log implies, appends `approval.expired` for live requests whose TTL lapsed, regenerates the queue projection whole, and surfaces escalated tasks. The sweep changes no verdict: TTL is judged at decision time whether or not an expiry event exists, so the sweep exists to make a lapse visible in the log and in every projection built from it. It MUST be idempotent with that lazy judgment and with itself, which implementations get by re-deriving the candidate list from the verified log each pass rather than remembering what they expired. Each pass then performs §6.3's projection write-back: once the events above are appended, every task file whose `state:` still disagrees with the state the log implies is rewritten to say what the log says. The order is fixed, and it is the whole point: the event is appended first and the file is updated second, never the reverse. The rewrite goes through a round-trip writer that changes the envelope's `state:` line and re-emits every other byte of the file verbatim (unknown frontmatter keys per §6, comments, key order, and line endings included), and the result is placed atomically, so a reader sees either the whole previous file or the whole new one. A drift record therefore marks the moment a file was found wrong and repaired; a file that drifts again after repair is one some other writer is contending for, and the repeated records are how that becomes visible. Implementations MUST NOT add an envelope to a file that declares none, and MUST leave the file untouched when the writer refuses the rewrite (frontmatter that does not parse, an `approval:` key that is not a mapping, a failed round-trip self-check), surfacing the refusal instead. Write-back writes files and nothing else: it appends no event of its own, and the log remains the truth. File watching is a latency optimization: a pass re-derives everything from the verified log and re-scans the folder, so an implementation whose watchers fail to attach is slower and never wrong.

### 10.3 Channels

Interface: `notify(request) -> delivery_id`, `poll()/webhook() -> decision`. Decisions become log events; channels hold no state. v0.1 ships **cli** (zero-config prompt), **web** (local queue page with grant/reject), and **telegram** (reference push channel: message with declared effects + inline Approve/Reject buttons; callback verified against approver identity). Channel breadth is explicitly out of scope; HumanLayer exists for Slack/email/SMS enterprises.

Where dispatch runs (amended APRV-55). §10.2 gives the daemon the job of dispatching channel notifications. At v0.1 the reference runtime performs that dispatch in the channel listener instead, on every poll cycle, re-deriving the pending set from the verified log each time and sending only what that listener process has not sent yet. The listener already holds the channel credential and the approver identity, dispatch appends nothing, and a network round-trip inside the daemon's pass would couple TTL expiry and write-back to a chat service's availability. This is an implementation placement and not a change to the daemon's stated role: a later build MAY move dispatch into the daemon with no change to any event, projection, or channel interface. A listener's record of what it has already sent is not state in this section's sense, since it is never read as an answer to what is pending; its loss MUST degrade to a re-send (a duplicate in front of the approver), never to a pending request nobody is shown. Pull channels need no dispatch at all: a page that builds its queue from the log per view shows a newly requested action on the next refresh.

Every displayed field is one of two kinds and MUST be visibly distinguished: **computed** (derived by the runtime from the log, policy, or payload bytes: class resolution, budget state, attestation status, payload hash, chain position) and **claimed** (authored by the requesting agent: summaries, estimates, rationale, confidence). Rendering claimed fields with the visual authority of computed fields misrepresents the verification boundary to the approver and is a conformance failure for a channel.

Channels MAY present multiple pending requests as a batch and collect one human gesture over the set, and SHOULD for high-volume `record.*` classes. The log never batches: each granted or rejected request receives its own `approval.granted` or `approval.rejected` event carrying the batch's channel delivery id in its payload, so audit granularity survives ergonomic grouping. The id is carried in the payload field `batch_delivery_id`. Earlier v0.1 builds encoded it in the first line of the payload's `note` field as `batch_delivery_id=<id>`; those logs are append-only, so readers MUST accept both encodings for the life of v0.1, preferring the first-class field. A batch MUST NOT mix `manual` classes with differing payload-display requirements in a way that hides any full payload behind the fold of another.

### 10.4 Adapters and hard enforcement

Adapters (e.g. `adapter-email`, `adapter-gcal`) hold the actual credentials in an encrypted vault and MUST require a valid, unexpired, single-use execution token bound to the action's `idempotency_key`. This is the hard boundary: an agent that bypasses the CLI still cannot send, spend, or delete, because the credentials only answer to tokens. (Same architectural intuition as mission-control's vault + "agents cannot modify security settings.")

An execution token is bound to the request, its `idempotency_key`, AND its `payload_hash`. Adapters and `approval run` MUST recompute the hash of the payload they are about to execute and MUST refuse, with a distinct machine-readable reason (`payload-mismatch`), when it differs from the hash the grant recorded. A grant therefore approves specific bytes. Changing the payload after grant requires a new request.

The reference runtime gives that boundary a definite shape. An adapter implements one method, `act`, over two things: the payload the grant bound to, and a credential provider scoped to that call. The runtime's adapter contract owns everything around it, in a fixed order: recompute the payload hash, verify and consume the token, append `execution.started`, call `act`, append `execution.completed` or `execution.failed`. An adapter cannot skip a step, because it never holds the sequence. Credentials reach `act` only inside the verified-token window, and the provider refuses every request made after `act` returns, so an adapter that keeps its reference gets a refusal rather than a secret. Whatever the adapter reports back (its own failure code, message, and detail) is scanned for the credential values it was handed and redacted before the runtime records or returns any of it, which makes §11.1's third invariant a mechanism at this boundary rather than a convention. Adapters written elsewhere are held to the same sequence by the conformance suite that ships with the contract, in the way §10.3's channels are held to their display rules. (Amended APRV-67.)

The reference vault is the storage half of the same sentence. Named credentials live in one file beside the log, `.approval/vault.enc`, holding a JSON map of name to credential encrypted with AES-256-GCM under a key derived by scrypt from an operator passphrase. The passphrase is read from the environment variable the policy names in `vault.passphrase_env` (§5.2), so the policy an agent may read carries a variable name and the value lives outside the repository. The file records its own format version and KDF parameters, so a future scheme is a migration rather than a reinterpretation of old bytes, and every write re-encrypts the whole map under a fresh nonce and lands atomically. The write path is human-only (`approval vault set | list | remove`, identity resolved exactly as `policy attest` resolves it), `list` reports names and never values, and there is deliberately no verb that prints a credential: the value's only sanctioned journey is from the vault into an adapter's `act`, through a credential provider the contract above scopes to the verified-token window. What the vault defends is credentials at rest and casual reads by an agent with file access, since the ciphertext hides the names as well as the values. What it does not defend, stated as plainly as §11 states the rest, is a compromised host or an agent that can read the passphrase variable; such an agent decrypts the file directly and needs no adapter. The vault raises the cost of a credential leak from reading a file to owning the session, and claims nothing beyond that. (Amended APRV-68.)

For `manual` actions, channels MUST present the full payload or a faithful rendering of it, clearly delineated from any agent-written summary, before collecting a decision.

### 10.5 MCP wrapper (optional)

A thin MCP server exposing the same verbs as tools (`request_approval`, `wait_decision`, `get_queue`, …) for clients where MCP is more ergonomic than shelling out. It shares the CLI's code paths; the [MCP tasks extension](https://modelcontextprotocol.io) MAY be mapped onto `awaiting` when client support stabilizes, and A2A's `input-required` maps cleanly for agent-to-agent deployments.

## 11. Security and control model

approval.md operationalizes, at consumer scale, the structure of trusted monitoring with limited auditing from the AI-control literature ([Greenblatt et al., 2023](https://arxiv.org/abs/2312.06942)):

- The **untrusted policy** is the agent proposing actions.
- **Affordance restrictions** are the adapter/token boundary plus the taxonomy: undeclared classes cannot execute.
- The **trusted, expensive overseer** is the human, whose limited attention is the audit budget; `manual` classes spend it before execution, `supervised_sample_rate` spends it retrospectively.
- The **monitoring signal** is deterministic policy (class, cost, reversibility) plus `route.confidence`; escalation is triggered by the runtime, never self-assessed by the executing agent at execution time.
- The **audit trail** is the hash-chained log, which the agent cannot rewrite undetected.

**Defended:** honest-mistake side effects, prompt-injected instructions that try to escalate side effects silently, retries double-executing (idempotency keys), quiet budget creep, after-the-fact disputes about who approved what, tampering with history.

**Not defended, stated plainly:** an agent with direct credential access outside adapters; a compromised host; collusion between agent and a careless approver; and this is engineering informed by control research, offering no guarantees against a schemer that control protocols proper are designed to stress-test. Keep `manual` floors on irreversible classes. Human identity in v0.1 is config-declared (an environment variable or flag); the trust boundary is the local machine, and anyone who can set that configuration and write to the log is inside it. Attestation therefore proves that *someone with local control* signed off, not *who* — cryptographic identity is future work, not a v0.1 claim.

Deceptive content inside an approved action is defended to this extent: the approver sees, and the token binds to, the exact payload bytes. What remains undefended is persuasion about whether those bytes should be approved, and any consequence the approver fails to model from bytes they did see.

Fields authored by the party under oversight (`route.confidence`, summaries, cost estimates) MAY raise scrutiny, inform display, or feed retrospective analysis. They MUST NOT reduce sampling probability, downgrade a resolved autonomy level, or shortcut any refusal path. Scrutiny only ratchets upward on self-report.

Disclosure duty binds the informed party. An agent that knows information material to an approval decision and omits it from the request has violated policy even where the action itself was permitted. Materiality is judged as a reasonable approver would judge it. Undeclared side effects are the mechanical case, caught at the adapter boundary; undisclosed context is the same violation in a form only audit can catch, which is one of the things audit is for.

This system makes actions, policies, and decisions common knowledge: a shared record both parties can read and neither can silently rewrite. It makes neither party's mind legible to the other. Agent reasoning is unverifiable from outputs; human intent exceeds any policy file. approval.md shrinks the information asymmetry where artifacts can carry it and claims nothing about interiority on either side.

The gate protects two things: the world from your agents' actions, and your mind from your agents' writes. A system of record is an extended mind; writes to it are cheap to make and expensive to un-believe once relied upon. Policies that set reversible `record.*` classes to `manual` are exercising reversibility-preservation over epistemic state, and the irreversibility floor (§7) remains a minimum, never a statement that manual is reserved for the irreversible.

### 11.1 Global invariants

The following hold across every surface of the runtime. They are implicit acceptance criteria for every future task: a change that violates one is a defect regardless of what its own task asked for, and each is pinned by the test file cited.

1. **Enforcement paths read only verified records.** Gate decisions are computed from log state that has passed chain verification, never from unverified or partially read input (`tests/state.test.ts`).
2. **Gate-typed events never accept caller timestamps.** `ts` on gate-typed events is assigned by the runtime at the write boundary; a caller-supplied value is refused (`tests/clock.test.ts`).
3. **Raw secrets never appear in the log; only their hashes do.** Execution tokens and binding material are logged as hashes, and a raw-token scan over written logs finds nothing (`tests/token.test.ts`, `tests/binding.test.ts`).
4. **Self-reported fields never reduce scrutiny.** Values authored by the party under oversight may raise scrutiny and never lower it (`tests/ratchet.test.ts`).
5. **Every check-then-append passes through compare-and-append.** No path reads a decision-relevant log state and appends on it without the atomic head check that makes the pair safe under concurrency (`tests/concurrency.test.ts`, `tests/log.test.ts`).
6. **Refusals are machine-readable and distinct, and every code union is pinned by a test.** Each refusal path returns its own stable code, and the unions are frozen public API (`tests/gate.test.ts`, `tests/token.test.ts`, `tests/execute.test.ts`, `tests/log.test.ts`).

## 12. Interoperability

- **Backlog.md:** native. Tasks live in `backlog/`, the envelope is one preserved frontmatter key, board `status` and approval `state` are independent. approval.md ships no board; use Backlog.md's.
- **AGENTS.md import:** `approval import agents-md` parses "require approval first / allowed without prompting" permissions sections into draft policy classes for human confirmation, turning existing prose conventions into enforced policy.
- **Inbound adapters (post-v1):** e.g. a Telegram capture bot, arbitrary apps via `approval register --json`.
- **Outbound sinks (post-v1):** approved+scheduled tasks mirrored to TickTick / Google Tasks / Google Calendar as views, never sources of truth. Mapping via [RFC 8984 jsCalendar Task](https://www.rfc-editor.org/rfc/rfc8984) with the envelope as a vendor extension, `X-APPROVAL-*` in [VTODO](https://www.rfc-editor.org/rfc/rfc5545).

## 13. Non-goals

No new task file format. No kanban UI. No agent framework or orchestration platform. No hosted service (local-first; a sync story can come later). No channel breadth beyond the three shipped. No claim of scheming-robustness (§11).

Post-v1 (non-normative): `review: adversarial` as a per-class flag. Before a flagged `manual` request reaches the approver, an independent agent instance with the raw payload and no stake in the outcome writes a dissent: worst plausible reading, omissions, questions a suspicious reviewer would ask. The approver adjudicates between framings instead of consuming one. Untrusted monitoring, spent where human attention is scarcest.

Post-v1 (non-normative): a Rust fast-path implementation of the hot loop (policy resolution, chain-tail verification, gate verdict) as the engine for per-tool-call hook adapters, where Node startup latency is unacceptable. Conformance is defined by the fixture suite; the crates.io name `approval-md` is reserved for it. The TypeScript runtime remains the reference implementation for the full surface.

## 14. Repository layout and roadmap

```
approval.md/
├── SPEC.md               # this file
├── APPROVAL.md           # this repo's own policy (dogfood from day one)
├── schema/               # JSON Schemas: policy, envelope, each event type
├── src/                  # runtime: core/ (log, policy, gate), cli/, daemon/,
│                         # channels/{cli,web,telegram}/, adapters/, mcp/
├── examples/             # personal-admin/, backlog-md-project/, agents-md-import/
└── tests/                # log verification, policy matching, gating, TTL, idempotency
```

Milestones sized for agent-driven development (each = one reviewable task):

- **M0** Schemas for policy, envelope, events + fixtures.
- **M1** Log: append, hash-chain, verify, reindex.
- **M2** Policy engine: parse, match, explain (`policy test`), fail-closed.
- **M3** Gate: request/grant/reject/expire, tokens, idempotency, `approval run`.
- **M4** Channels: cli, web queue, Telegram; QUEUE.md renderer.
- **M5** Daemon: watch, TTL, sampling, loop-escalation.
- **M6** Backlog.md round-trip + AGENTS.md import.
- **M7** First adapter (email) + vault; end-to-end demo: agent drafts chaser → Telegram ping → approve from phone → sent → log verifies.
- **M8** MCP wrapper. Post-v1: TickTick/GCal sinks, inbound capture adapters.

## 15. References

Backlog.md · https://github.com/MrLesk/Backlog.md — the markdown-task convention this extends
AGENTS.md · https://agents.md — the prose permissions this enforces
HumanLayer · https://github.com/humanlayer/humanlayer — approval-as-a-service (SDK/hosted counterpart)
LangGraph HITL · https://langchain-ai.github.io/langgraph/concepts/human_in_the_loop/
OpenAI Agents SDK HITL · https://openai.github.io/openai-agents-js/guides/human-in-the-loop/
A2A protocol · https://a2a-protocol.org — `input-required` lifecycle state
Model Context Protocol · https://modelcontextprotocol.io
mission-control · https://github.com/MeisnerDan/mission-control — autonomy levels, vault, spend limits
Claude Code permissions · https://code.claude.com/docs/en/permissions — harness-enforced allow/ask/deny rules, settings precedence, hooks
Codex CLI approvals · https://developers.openai.com/codex/agent-approvals-security — approval_policy × sandbox_mode
Gemini CLI configuration · https://google-gemini.github.io/gemini-cli/docs/get-started/configuration.html — approval modes
Cursor run modes · https://cursor.com/docs/agent/security/run-modes — allowlist / auto-review / run-everything, "best-effort guardrails"
AI Control (Greenblatt et al., 2023) · https://arxiv.org/abs/2312.06942 — trusted monitoring under an audit budget
TaskChampion · https://github.com/GothenburgBitFactory/taskchampion — operation-log task storage
Ink & Switch, A Local-First Task Framework · https://www.inkandswitch.com/patchwork/notebook/tasks-01/
jsCalendar · https://www.rfc-editor.org/rfc/rfc8984 · iCalendar · https://www.rfc-editor.org/rfc/rfc5545
RFC 2119 · https://www.rfc-editor.org/rfc/rfc2119
