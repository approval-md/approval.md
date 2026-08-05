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
- **Budgets are conjunctive.** An action must pass its class limits AND global budgets. Budget consumption is computed from the log, never from a mutable counter.
- **`supervised_sample_rate`** implements auditing under a budget: supervised actions execute immediately, and a deterministic pseudo-random sample (seeded from the event hash, so it is reproducible and unguessable in advance by the agent) is queued for after-the-fact human review. See §11 for why.
- **Agents MUST NOT be able to modify `APPROVAL.md`, the log, or channel credentials.** The reference runtime refuses to mint tokens if the policy file's mtime/hash changed without a signed `policy.updated` event from a human session.
- **Durations.** Every duration-valued field (`approval_ttl`, budget windows, `max_latency`) is a string matching `<positive integer><unit>` with unit one of `ms`, `s`, `m`, `h`, `d`, `w` (weeks = 7 days). Single unit only: compound (`1h30m`), fractional (`1.5h`), zero, and leading-zero forms are invalid. An invalid duration anywhere in the policy is a schema violation and the policy fails closed.

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
    app: cartsos               # provenance: which system created this
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
| `origin.app` | MUST | Source system (`cartsos`, `jobmaxxing`, `manual`, …). |
| `origin.created_by` | MUST | `human:<id>` or `agent:<id>`. |
| `route.assignee` | SHOULD | `human` or `agent:<id>`. Routing proposals from agents are events, never silent edits. |
| `route.confidence` | MAY | 0.0–1.0; used as a monitoring signal (§11). |
| `state` | MUST | Approval lifecycle state (§6.3), distinct from board `status`. |
| `actions[]` | MUST for execution | Each declared action: `class`, `summary`, `reversible`, `est_cost_usd`, `idempotency_key`. |
| `budget` | MAY | Task-level caps, conjunctive with policy budgets. |
| `idempotency_key` | MUST per action | Stable string; adapters MUST refuse to execute the same key twice. |

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

Two invariants: an action's class MUST be declared before an execution token can be requested for it, and `reversible: false` actions MUST NOT be eligible for `autonomous` regardless of policy (the runtime enforces this floor).

The irreversibility floor resolves to `manual`: an action declared `reversible: false` MUST NOT execute under `autonomous` or `supervised` regardless of policy. Retrospective audit cannot undo an irreversible action, so execute-then-sample is not meaningful oversight for one. Implementations MUST apply the floor after class resolution and record in the decision trace when the floor, rather than the matched rule, determined the outcome.

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
- **Event types (v0.1):** `task.registered`, `route.proposed`, `route.accepted`, `approval.requested`, `approval.granted`, `approval.rejected`, `approval.expired`, `approval.revoked`, `execution.started`, `execution.completed`, `execution.failed`, `budget.exceeded`, `policy.updated`, `envelope.drift`, `audit.sampled`, `audit.reviewed`.
- Events MUST validate against the JSON Schemas in `schema/` before append. Validation at the write boundary is itself a control: an agent physically cannot request execution without declaring a class, key, and cost estimate.
- Every record MUST carry an explicit hash-scheme identifier, `alg`. Version 0.1 defines exactly one value: `sha256/jcs`, meaning SHA-256 over the RFC 8785 (JCS) canonical serialization of the record with `prev` included. Verifiers MUST reject records whose `alg` is missing or unrecognized. Records with different `alg` values MAY coexist in one log, so a future scheme change is a migration, never a schism.
- Actor identifiers use exactly three prefixes: `human:` for decisions made by a person, `agent:` for actions proposed or performed by an agent, and `system:` for runtime-originated events such as `approval.expired`. Verifiers MUST reject unrecognized prefixes.

## 9. Projections

1. **The queue** (`.approval/QUEUE.md`): a rendered, read-only markdown view of pending requests (task, actions, declared effects, cost, TTL countdown) plus the sampled-audit backlog. Regenerated on every relevant event. This is the screenshot; it is never the truth.
2. **The index** (`.approval/index.sqlite`): rebuilt from the log (`approval reindex`), used for queries like "pending manual approvals touching `financial.*`, oldest first." Any SQLite client, including DuckDB, can read it; deleting it loses nothing.

## 10. Runtime

### 10.1 CLI (primary interface, for humans and agents)

```
approval init                      # scaffold APPROVAL.md, .approval/, schemas
approval instructions              # full agent-facing usage guide (also in --help)
approval register  <task-file>     # validate envelope, append task.registered
approval request   <task> [--action <key>]   # -> approval.requested (manual classes;
                                             #    supervised/autonomous proceed directly
                                             #    to execution)
approval wait      <task> --timeout 6h       # block until decided; exit code = decision
approval grant|reject|revoke <request-id> [--note …]   # human-only verbs
approval token     <action-key>    # print single-use execution token if granted
approval run -- <cmd…>             # gate arbitrary commands: mints token, runs, logs
approval queue [--json]            # pending requests
approval log verify | tail | export
approval policy check|test <class> # explain what policy does with a class
approval reindex | render
```

Machine-readable output: every command supports `--json`; schemas for inputs and outputs are printed by `approval instructions --schemas`.

### 10.2 Daemon

`approvald` watches the backlog folder and the log: validates new/changed envelopes, applies policy, dispatches channel notifications, expires TTLs, samples supervised actions for audit, re-renders projections, and (optionally) polls upstream sources. Loop safety: three consecutive `execution.failed` events for one task escalate to `manual` regardless of policy.

### 10.3 Channels

Interface: `notify(request) -> delivery_id`, `poll()/webhook() -> decision`. Decisions become log events; channels hold no state. v0.1 ships **cli** (zero-config prompt), **web** (local queue page with grant/reject), and **telegram** (reference push channel: message with declared effects + inline Approve/Reject buttons; callback verified against approver identity). Channel breadth is explicitly out of scope; HumanLayer exists for Slack/email/SMS enterprises.

### 10.4 Adapters and hard enforcement

Adapters (e.g. `adapter-email`, `adapter-gcal`) hold the actual credentials in an encrypted vault and MUST require a valid, unexpired, single-use execution token bound to the action's `idempotency_key`. This is the hard boundary: an agent that bypasses the CLI still cannot send, spend, or delete, because the credentials only answer to tokens. (Same architectural intuition as mission-control's vault + "agents cannot modify security settings.")

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

**Not defended, stated plainly:** an agent with direct credential access outside adapters; a compromised host; deceptive *content* inside an approved action (you approve "send email," the runtime does not verify the prose is honest, though channels SHOULD display full content for `manual` actions); collusion between agent and a careless approver; and this is engineering informed by control research, offering no guarantees against a schemer that control protocols proper are designed to stress-test. Keep `manual` floors on irreversible classes.

## 12. Interoperability

- **Backlog.md:** native. Tasks live in `backlog/`, the envelope is one preserved frontmatter key, board `status` and approval `state` are independent. approval.md ships no board; use Backlog.md's.
- **AGENTS.md import:** `approval import agents-md` parses "require approval first / allowed without prompting" permissions sections into draft policy classes for human confirmation, turning existing prose conventions into enforced policy.
- **Inbound adapters (post-v1):** CartsOS/Telegram capture, arbitrary apps via `approval register --json`.
- **Outbound sinks (post-v1):** approved+scheduled tasks mirrored to TickTick / Google Tasks / Google Calendar as views, never sources of truth. Mapping via [RFC 8984 jsCalendar Task](https://www.rfc-editor.org/rfc/rfc8984) with the envelope as a vendor extension, `X-APPROVAL-*` in [VTODO](https://www.rfc-editor.org/rfc/rfc5545).

## 13. Non-goals

No new task file format. No kanban UI. No agent framework or orchestration platform. No hosted service (local-first; a sync story can come later). No channel breadth beyond the three shipped. No claim of scheming-robustness (§11).

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
- **M8** MCP wrapper. Post-v1: TickTick/GCal sinks, CartsOS inbound.

## 15. References

Backlog.md · https://github.com/MrLesk/Backlog.md — the markdown-task convention this extends
AGENTS.md · https://agents.md — the prose permissions this enforces
HumanLayer · https://github.com/humanlayer/humanlayer — approval-as-a-service (SDK/hosted counterpart)
LangGraph HITL · https://langchain-ai.github.io/langgraph/concepts/human_in_the_loop/
OpenAI Agents SDK HITL · https://openai.github.io/openai-agents-js/guides/human-in-the-loop/
A2A protocol · https://a2a-protocol.org — `input-required` lifecycle state
Model Context Protocol · https://modelcontextprotocol.io
mission-control · https://github.com/MeisnerDan/mission-control — autonomy levels, vault, spend limits
AI Control (Greenblatt et al., 2023) · https://arxiv.org/abs/2312.06942 — trusted monitoring under an audit budget
TaskChampion · https://github.com/GothenburgBitFactory/taskchampion — operation-log task storage
Ink & Switch, A Local-First Task Framework · https://www.inkandswitch.com/patchwork/notebook/tasks-01/
jsCalendar · https://www.rfc-editor.org/rfc/rfc8984 · iCalendar · https://www.rfc-editor.org/rfc/rfc5545
RFC 2119 · https://www.rfc-editor.org/rfc/rfc2119
