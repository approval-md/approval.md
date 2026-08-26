# approval.md

**Human approval for agent actions.**

Version: 0.1.0-draft · Status: Draft · License: MIT · Canonical URL: https://approval.md

> Your AGENTS.md says "require approval first." approval.md enforces it, and puts the approve button on your phone.

Amended text names the task that changed it, `(Amended APRV-n.)`. Text a builder drafted and the maintainer has not signed off yet says so, `(Amended APRV-n, pending sign-off.)`, and carries no more authority than a proposal until the suffix is removed.

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
  alice:
    channels: [telegram, cli]

classes:
  read.*:                       { autonomy: autonomous }
  files.write.workspace:        { autonomy: autonomous }
  calendar.write.own:           { autonomy: supervised }
  communicate.email.draft:      { autonomy: autonomous }
  communicate.email.external:
    autonomy: manual
    approvers: [alice]
  financial.spend:
    autonomy: manual
    approvers: [alice]
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
- **Agents MUST NOT be able to modify `APPROVAL.md`, the log, or channel credentials.** The reference runtime refuses to mint tokens if the policy file's mtime/hash changed without a signed `policy.updated` event from a human session. Attestation makes this mechanical: a human runs `approval policy attest`, which appends a `policy.updated` event carrying the SHA-256 of the policy file's bytes. Gate operations — request intake, grant recording, token minting — MUST refuse, with a distinct machine-readable reason, whenever the live file's hash differs from the latest attestation or no attestation exists. An edited policy is inoperative until a human re-attests it. Attestation also names the rules a decision was made under: gate-written `approval.requested` and `approval.granted` events carry `policy_sha256`, the attested hash in force when the runtime evaluated them. The field is assigned at the write boundary exactly as `ts` is (§8): no caller can supply it, and a value arriving from outside the runtime is refused. When the hash in force at grant time differs from the hash recorded on the matching request, the grant MUST refuse with its own reason, `policy-drift`, distinct from the unattested-file refusal above: the file is attested and is a different policy, so the pending request is void and must be re-requested under the rules now in force. The field is additive per §8: records written before it existed still validate and verify, and a verifier accepts both forms. (Amended APRV-118, pending sign-off.)
- **`payload_retention`.** An optional top-level duration bounding how long the payload bytes in `.approval/payloads/` (§9) are kept. A payload is prunable once the action it is bound to has been in a terminal state (`executed`, `rejected`, `expired`, `revoked`) for longer than the duration. A payload whose action is not terminal is never prunable, at any age: a pending or granted approval binds to those exact bytes, and discarding them would leave a live authorization pointing at nothing. When the key is present, orphaned payloads (bytes with no recorded binding) are prunable at any age: the duration governs bound payloads and does not gate residue nothing ever bound. When the key is absent, the pruning subsystem does not run and nothing is deleted, orphaned or not; the store holds the material evidence of what a human approved, so forgetting anything is an operator's explicit choice, and an operator who never made that choice never asked the runtime to delete anything (amended APRV-49 to match the enforcement shipped in APRV-41). Pruning is performed by the daemon and by nothing else, and each removal appends a `payload.pruned` event, so a log states what its store no longer holds. (Policy vocabulary in v0.1; enforcement lands with the M5 daemon.)
- **`protected_paths`.** An optional top-level list widening the set of files whose edit is classified `policy.edit`, so a project can put its own governing documents (a specification, a constitution, a design directory) behind the gate that already stands in front of `APPROVAL.md`. Entries are repo-relative and literal: an exact file path (`SPEC.md`, `docs/constitution.md`) or a directory prefix ending in `/` (`design/`). Globs, negation, absolute paths and `..` segments are schema violations, because a pattern language the runtime half-implemented would leave an author believing a file is gated when it is not. Matching is by path segments and never resolves against a checkout, so a linked worktree and the primary answer alike: an exact path matches a candidate whose trailing segments are that path (a single-segment entry therefore matches that filename in any directory, exactly as the built-in filenames do), and a directory prefix matches a candidate containing those segments as a contiguous run. The key is ADDITIVE and can only widen: the runtime's built-in protected set (the policy file, the agent instruction files, the approval home, the harness settings, the release configuration) stays protected whatever this list says or omits, and a policy that fails to load leaves those built-ins in force while every class resolves to `manual`. (Amended APRV-107, pending sign-off.)
- **`vault.passphrase_env`.** An optional top-level key naming the environment variable that holds the passphrase for the credential vault of §10.4. The policy carries the variable's *name*, never the passphrase, on the same reasoning as `audit.sampling_secret_env` and the channel credential keys (`chat_id_env`, `token_env`): agents may read `APPROVAL.md`, and a passphrase they can read is a vault they can open. The passphrase MUST NOT appear in the log, in any command's output, or in any error message. When the key is absent the runtime reads `APPROVAL_VAULT_PASSPHRASE`; a variable name is not a permission, so an unnamed one MUST NOT lock an operator out of credentials they created, and a policy that fails to load leaves the default in force for this key alone. (Amended APRV-68, which implements the reference vault.)
- **`channels.telegram.token_env` and `channels.telegram.chat_id_env`** are honoured by the runtime exactly as `audit.sampling_secret_env` and `vault.passphrase_env` are: the policy carries the variable's *name*, the runtime reads the value from the environment under that name, and a policy that declares neither (or fails to load) gets the reference runtime's defaults, `APPROVAL_TG_TOKEN` and `APPROVAL_TG_CHAT`. (Amended APRV-72, pending sign-off.)
- **The environment map.** Every key above that ends in `_env` carries a variable's name rather than its value, which leaves an operator with several values to establish before any gate operation works and nowhere to record where those values live. `.approval/env` is that place: a SOURCE MAP, sibling of the log directory as the vault is, one `KEY=VALUE` per line with `#` comments and blank lines ignored, no quoting and no interpolation. The VALUE says where the value lives, in one of four forms: `keychain:<service>` (macOS, `security find-generic-password -a "$USER" -s <service> -w`), `secret-service:<label>` (Linux desktop, `secret-tool lookup approval <label>`), `env:` (inherited from the ambient environment, and reported as inherited), or a bare literal. A literal is permitted and is ALWAYS reported as plaintext, by every diagnostic, because a rule people route around is not a control: an operator told plainly that their token sits in a file in the working tree can weigh that, while an operator forbidden from writing it there writes it into a shell profile where nothing can see it to say so. Values are never passed to a helper in an argv; they arrive on its stdout. The file MUST be mode 0600 (anything else is refused, with the `chmod` to run) and `approval init` adds it to `.gitignore`. **No command loads this file implicitly. A single verb, `approval env`, resolves it and emits an export block for a shell to evaluate, so the environment a gate operation runs under is always one a human established** (§11, §11.1 invariant 7). An already-exported value always wins over the file, and an absent file is not an error. The variables answered for are the human identity variable, the two Telegram variables, the vault passphrase, the sampling secret when the policy names one, and any other string-valued `_env` key in the policy. (Amended APRV-73, pending sign-off.)
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
    created_by: "human:alice" # or "agent:<id>"
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
| `idempotency_key` | MUST per action | Stable string; adapters MUST refuse to execute the same key twice. An `idempotency_key` is the global identity of one side effect: it MUST be unique across all `task.registered` records, so registration refuses a key already declared under a different task (`task-already-registered`), and a log that somehow carries two declarations of one key is untrustworthy, so execution refuses (`action-not-registered`) rather than choose the later one. Without this, a second registration under a new task could shadow the first at execute time and disable the irreversibility floor. (Amended APRV-138.) |
| `payload_hash` | MUST for every action that executes | SHA-256 over the RFC 8785 canonical serialization of the action's concrete payload: for a message send, the full body and recipients; for `approval run`, the argv array and cwd; for a record write, the proposed record content. The payload itself is stored or referenced by the request so channels can display it; the hash is what approval binds to. The requirement was `manual` actions only, and is now every action the runtime executes. A `supervised` or `autonomous` action passes through no grant (§6.3), so its declaration is the entire statement of what was authorized: without a hash there is nothing an execution can be checked against, and `approval run <key> -- <anything>` under an autonomous class is unauthenticated arbitrary execution. Execution refuses `payload-mismatch` for a declaration carrying no hash and for an executor whose recomputed hash differs from it, in both cases appending nothing. (Amended APRV-140, pending sign-off.) |

### 6.3 Approval lifecycle

```
proposed ──▶ awaiting ──▶ approved ──▶ executed
                │             │
                │             └─▶ revoked      (human, before execution)
                ├─▶ rejected
                ├─▶ expired                    (TTL, per on_expiry)
                └─▶ withdrawn                  (requester, while pending)
```

`state` is a **projection** of log events; the file is updated by the daemon after the event is appended, never the reverse. A file edit that contradicts the log is itself logged (`envelope.drift`) and surfaced.

`approval.*` events are exclusive to the manual path. All but one of them record a human decision; the exception is `approval.withdrawn`, which records the requester taking its question back. A pending request MAY be withdrawn by the party that opened it, and by nobody else: the actor MUST equal the actor of the matching `approval.requested`, and MUST NOT be `system:`, because the runtime's way of ending a request it was not asked to end is the TTL. Withdrawal is legal only while the request is pending, judged exactly as a decision is judged (a lapsed TTL is not pending, event or no event), and it is terminal: a grant, rejection, or revocation attempted afterwards is refused, and so is a second withdrawal. The reason is recorded and closed to three values, `timeout`, `cancelled`, `superseded`. Withdrawal exists because human attention is the audit budget (§11) and a decision nobody can consume must not be solicited: a requester whose wait has elapsed can no longer act on an answer, so it retracts the question rather than leaving it standing until the TTL. Channels MUST NOT present a withdrawn request as pending, and a channel that has already delivered one SHOULD retract or annotate that delivery. Nothing about a withdrawal reduces scrutiny: it removes an authorization that was never granted, and a withdrawn action that is still wanted is requested again, which is a new request with a new decision. (Amended APRV-106, pending sign-off.)

Actions whose class resolves to `supervised` or `autonomous` emit no `approval.requested` or `approval.granted`; their execution is recorded by `execution.*` events, and supervised actions are additionally eligible for `audit.sampled` and `audit.reviewed`.

The execution half of the lifecycle has its own states, and they are custody states rather than results: the question each answers is not "did it work" but "who is holding this, and what may still be done with it". A started execution is in exactly one of five.

- **settled** — an `execution.completed` or `execution.failed` closed it. The runtime watched the outcome and wrote down what it saw.
- **open** — a start with no outcome, written by a runtime that MEANT to watch one. This is the dangling execution a crash between `execution.started` and its outcome leaves; the log honestly says the action began and nobody knows how it ended, nothing repairs it automatically, and a person closes it by recording what they observed.
- **delegated** — a start recording that a harness, rather than this runtime, ran the command. **Terminal by design.** No outcome event will ever follow, because no exit status is ever observed, and the record is complete as written. Implementations MUST NOT report these as dangling: an operational list that fills with records nothing is wrong with is a list operators learn to scroll past.
- **indeterminate** — the side effect was attempted and nobody knows whether it committed (§10.4). The consumption is burned, a re-run is refused, and only an explicit human reconciliation resolves it.
- **reconciled** — a person established which it was, and said so in a record that sits beside the indeterminate one rather than over it.

`open` and `indeterminate` are both operational debris and both ask a person for something, but not for the same thing: the first asks them to look at what this runtime did, the second to establish from the relying party's own evidence whether the far side committed. Implementations MUST keep the two distinguishable in whatever surface reports system health. (Amended APRV-120, pending sign-off.)

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
 "actor":"human:alice","channel":"telegram",
 "payload":{"note":"go, but cc me"},
 "alg":"sha256/jcs","prev":"b3c9…","hash":"a41f…"}
```

- `hash` = SHA-256 over the canonical serialization of the record with `prev` included; `prev` = previous record's hash. `approval log verify` MUST detect any mutation or truncation. Optionally, the log directory is a git repo and the daemon commits per event with its own identity, giving signed, distributed tamper evidence for free (the [TaskChampion operation log](https://github.com/GothenburgBitFactory/taskchampion) and [Automerge](https://automerge.org) both converged on op-logs for related reasons; see also Ink & Switch's [local-first task framework](https://www.inkandswitch.com/patchwork/notebook/tasks-01/)).
- **Event types (v0.1):** `task.registered`, `route.proposed`, `route.accepted`, `approval.requested`, `approval.granted`, `approval.rejected`, `approval.expired`, `approval.revoked`, `approval.withdrawn`, `execution.started`, `execution.completed`, `execution.failed`, `execution.indeterminate`, `execution.reconciled`, `budget.exceeded`, `policy.updated`, `envelope.drift`, `audit.sampled`, `audit.reviewed`, `payload.pruned`.
- **Enum versioning.** `payload.pruned` is the first addition to the draft v0.1 set of sixteen types, `approval.withdrawn` the second, and `execution.indeterminate` with `execution.reconciled` the third and fourth. Readers of a v0.1 log may encounter any of them, and a verifier that treated the draft set as closed MUST be updated to accept all four. `execution.indeterminate` names the task and the action key like every other execution event, carries the executing actor, and its payload carries a `reason` drawn from a closed set (`act-threw` at v0.1) and, when present, an `exit_code` of `null`. `execution.reconciled` names the same task and key, carries a `human:` actor, and its payload carries `indeterminate_seq`, a `resolution` of `executed` or `not-executed`, a non-empty `note`, and `attested_by_human: true`. That the named `indeterminate_seq` is an unreconciled `execution.indeterminate` for this key is a rule the gate enforces (§6.3); a schema sees one record and can only constrain the shape. (Amended APRV-120, pending sign-off.) `payload.pruned` is written by the daemon alone, carries a `system:` actor, and names the pruned payload by its SHA-256 (§5.2 `payload_retention`). `approval.withdrawn` names the task and the action key like every other approval event, carries the requester's own actor (`agent:` or `human:`, never `system:`), and its payload carries `action_key` and a `reason` drawn from `timeout`, `cancelled`, `superseded`, with an optional `note`. That the actor equals the actor of the matching `approval.requested` is a rule the gate enforces (§6.3); a schema sees one record and can only rule out the actor kind. (Amended APRV-106, pending sign-off.)
- Events MUST validate against the JSON Schemas in `schema/` before append. Validation at the write boundary is itself a control: an agent physically cannot request execution without declaring a class, key, and cost estimate.
- Every record MUST carry an explicit hash-scheme identifier, `alg`. Version 0.1 defines exactly one value: `sha256/jcs`, meaning SHA-256 over the RFC 8785 (JCS) canonical serialization of the record with `prev` included. Verifiers MUST reject records whose `alg` is missing or unrecognized. Records with different `alg` values MAY coexist in one log, so a future scheme change is a migration, never a schism.
- Actor identifiers use exactly three prefixes: `human:` for decisions made by a person, `agent:` for actions proposed or performed by an agent, and `system:` for runtime-originated events such as `approval.expired`. Verifiers MUST reject unrecognized prefixes.

Events written through the gate (`approval.*`, `execution.*`, `budget.*`, `audit.*`, `policy.updated`) have `ts` assigned by the runtime at the write boundary. Caller-supplied timestamps on these types MUST be refused. Because TTL judgment and budget windows read `ts`, a party subject to those controls must never author the clock they are judged by. Direct log writers outside the gate remain free to supply `ts` (per §8's writer rules); verification treats gate-type events with implausible skew relative to their neighbors as a reportable anomaly, never silently accepted. "Neighbor" means the adjacent **gate-typed** record, because a directly written event's `ts` is legitimately the writer's own and comparing against it would report correct behavior as skew. An anomaly is reported and never enforced: a chain that verifies is clean whether or not it carries anomalies, the exit code does not move, and no verdict, refusal, or authorization changes. Chain integrity is a proof and skew is a judgment, so folding the second into the first would turn verification into a check operators learn to silence. The skew allowance is configured by `audit.skew_tolerance`, a policy duration in the §5.2 grammar, and MUST be generous enough that ordinary clock disagreement between hosts is not reported; when the key is absent the allowance is the implementation's stated default, which in the reference runtime is 2 seconds. Because the allowance governs a report and never a verdict, an operator who widens it hides evidence from a human and permits nothing. (Amended APRV-40. The `audit.skew_tolerance` sentence is APRV-58, pending sign-off.)

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
approval log sync                  # fast-forward the committed log under the append
                                   #   lock, with a snapshot and a chain reconcile
approval log advance [--pr]        # commit the log's new records onto a records
                                   #   branch; neither verb appends an event
approval policy check|test <class> # explain what policy does with a class
approval env [--check] [--json]    # resolve .approval/env and print an export block
                                   #   for a shell to evaluate; the ONLY reader of
                                   #   that file (--check prints no values)
approval setup identity|vault|sampling|channel <name>|adapter <name>
                                   # interactive configuration; a channel's credential goes
                                   #   to the OS keystore and .approval/env, an adapter's to
                                   #   the vault; refuses when stdin is not a terminal
approval hook claude-code           # gate an agent harness: reads a PreToolUse
                                   #   event on stdin, classifies the command,
                                   #   answers allow/deny (never "ask")
approval hook cursor               # gate a local Cursor Agent: native
                                   #   preToolUse JSON in, {permission}
                                   #   allow/deny out (never "ask")
approval hook classify -- <cmd…>   # what the classifier makes of a command
approval reindex | render
approval daemon run                # the §10.2 watch loop, in the foreground
approval mcp serve                 # the §10.5 MCP server over stdio, in the
                                   #   foreground, under one agent identity the
                                   #   operator fixes when they start it
```

Machine-readable output: every command supports `--json`; schemas for inputs and outputs are printed by `approval instructions --schemas`.

Six entries in this block are amendments awaiting sign-off: `setup` (Amended APRV-79, pending sign-off), `env` (Amended APRV-73, pending sign-off), `mcp serve` (Amended APRV-103, pending sign-off), `hook claude-code` (Amended APRV-82, pending sign-off), `hook cursor` (Amended APRV-133, pending sign-off), and the `log sync` / `log advance` pair described immediately below.

**Moving the log file: `log sync` and `log advance`.** The log is append-only, and a repository that carries one still has to pull it, commit it, and push it. Those two operations are part of the runtime rather than of the operator's shell, because performing them by hand rewinds the log file through git state while an appender holds it open, which produces two chains where there was one. Both verbs run in the primary checkout only and refuse elsewhere with a distinct machine-readable code. Both hold the append lockfile for the whole of their operation rather than for a single append: an append landing partway through either one is the interleaving that forks a chain.

`log sync` verifies the chain, copies the log aside inside the approval home (implementations MUST NOT route the log through `git stash` or any other git state mutation), fast-forwards the checkout (refusing anything that is not a fast-forward), and then **reconciles**: the committed chain MUST be a prefix of the snapshot, equal to it, or an extension of it. A prefix means the snapshot is restored, since the longer chain contains the shorter one whole; an extension means the pulled file is kept, for the same reason in the other direction; equality means there is nothing to do. Anything else is a fork, and the verb MUST refuse it, naming both heads and the first sequence number at which the chains disagree. Implementations MUST NOT merge or re-chain two chains under any circumstance: re-chaining fabricates records nobody wrote. Projections are rebuilt from the reconciled log and never restored from before the pull. Every failure at every step restores the snapshot before the verb exits, so a working log is never left in a partial state.

`log advance` verifies the chain, stages exactly the log, the queue projection, and the payload store, refusing when any other path is staged rather than unstaging it; commits on the currently checked-out branch with the sequence range in the message; and pushes that commit to a records branch. It MUST NOT check anything out: a branch switch with an uncommitted log rewinds the log file underneath its appender.

**Neither verb appends an event.** The log records decisions with real-world consequence. Moving the file the log is stored in is housekeeping on the container rather than a decision about the world, and an event for it would be the log narrating its own filesystem. Implementations MUST NOT append a record for either operation. (Amended APRV-125, pending sign-off.)

### 10.2 Daemon

`approvald` watches the backlog folder and the log: validates new/changed envelopes, applies policy, dispatches channel notifications, expires TTLs, samples supervised actions for audit, re-renders projections, and (optionally) polls upstream sources. Loop safety: three consecutive `execution.failed` events for one task escalate to `manual` regardless of policy.

The reference runtime ships the daemon as a CLI verb, `approval daemon run`, running in the foreground and stopping cleanly on SIGINT or SIGTERM; process supervision is the operator's business at v0.1. Each pass validates the task files' envelopes, appends `envelope.drift` (a `system:` actor) where a file's `state:` contradicts the state the log implies, appends `approval.expired` for live requests whose TTL lapsed, regenerates the queue projection whole, and surfaces escalated tasks. The sweep changes no verdict: TTL is judged at decision time whether or not an expiry event exists, so the sweep exists to make a lapse visible in the log and in every projection built from it. It MUST be idempotent with that lazy judgment and with itself, which implementations get by re-deriving the candidate list from the verified log each pass rather than remembering what they expired. Each pass then performs §6.3's projection write-back: once the events above are appended, every task file whose `state:` still disagrees with the state the log implies is rewritten to say what the log says. The order is fixed, and it is the whole point: the event is appended first and the file is updated second, never the reverse. The rewrite goes through a round-trip writer that changes the envelope's `state:` line and re-emits every other byte of the file verbatim (unknown frontmatter keys per §6, comments, key order, and line endings included), and the result is placed atomically, so a reader sees either the whole previous file or the whole new one. A drift record therefore marks the moment a file was found wrong and repaired; a file that drifts again after repair is one some other writer is contending for, and the repeated records are how that becomes visible. Implementations MUST NOT add an envelope to a file that declares none, and MUST leave the file untouched when the writer refuses the rewrite (frontmatter that does not parse, an `approval:` key that is not a mapping, a failed round-trip self-check), surfacing the refusal instead. Write-back writes files and nothing else: it appends no event of its own, and the log remains the truth. File watching is a latency optimization: a pass re-derives everything from the verified log and re-scans the folder, so an implementation whose watchers fail to attach is slower and never wrong.

### 10.3 Channels

Interface: `notify(request) -> delivery_id`, `poll()/webhook() -> decision`. Decisions become log events; channels hold no state. The reference runtime's interactive writer for a channel's transport credential is `approval setup channel <name>`, a separate noun from `approval setup adapter <name>` (§10.4) because the two fill different stores for the reason §4 separates the terms: a channel holds no state, so what it needs is the credential that lets the runtime reach a human, recorded in the environment source map of §5.2, while an adapter holds the credentials a side effect spends and those belong in the vault. (Amended APRV-79, pending sign-off.) v0.1 ships **cli** (zero-config prompt), **web** (local queue page with grant/reject), and **telegram** (reference push channel: message with declared effects + inline Approve/Reject buttons; callback verified against approver identity). Channel breadth is explicitly out of scope; HumanLayer exists for Slack/email/SMS enterprises.

Where dispatch runs (amended APRV-55). §10.2 gives the daemon the job of dispatching channel notifications. At v0.1 the reference runtime performs that dispatch in the channel listener instead, on every poll cycle, re-deriving the pending set from the verified log each time and sending only what that listener process has not sent yet. The listener already holds the channel credential and the approver identity, dispatch appends nothing, and a network round-trip inside the daemon's pass would couple TTL expiry and write-back to a chat service's availability. This is an implementation placement and not a change to the daemon's stated role: a later build MAY move dispatch into the daemon with no change to any event, projection, or channel interface. A listener's record of what it has already sent is not state in this section's sense, since it is never read as an answer to what is pending; its loss MUST degrade to a re-send (a duplicate in front of the approver), never to a pending request nobody is shown. Pull channels need no dispatch at all: a page that builds its queue from the log per view shows a newly requested action on the next refresh.

Every displayed field is one of two kinds and MUST be visibly distinguished: **computed** (derived by the runtime from the log, policy, or payload bytes: class resolution, budget state, attestation status, payload hash, chain position) and **claimed** (authored by the requesting agent: summaries, estimates, rationale, confidence). Rendering claimed fields with the visual authority of computed fields misrepresents the verification boundary to the approver and is a conformance failure for a channel.

Channels MAY present multiple pending requests as a batch and collect one human gesture over the set, and SHOULD for high-volume `record.*` classes. The log never batches: each granted or rejected request receives its own `approval.granted` or `approval.rejected` event carrying the batch's channel delivery id in its payload, so audit granularity survives ergonomic grouping. The id is carried in the payload field `batch_delivery_id`. Earlier v0.1 builds encoded it in the first line of the payload's `note` field as `batch_delivery_id=<id>`; those logs are append-only, so readers MUST accept both encodings for the life of v0.1, preferring the first-class field. A batch MUST NOT mix `manual` classes with differing payload-display requirements in a way that hides any full payload behind the fold of another.

### 10.4 Adapters and hard enforcement

Adapters (e.g. `adapter-email`, `adapter-gcal`) hold the actual credentials in an encrypted vault and MUST require a valid, unexpired, single-use execution token bound to the action's `idempotency_key`. This is the hard boundary: an agent that bypasses the CLI still cannot send, spend, or delete, because the credentials only answer to tokens. (Same architectural intuition as mission-control's vault + "agents cannot modify security settings.")

An execution token is bound to the request, its `idempotency_key`, AND its `payload_hash`. Adapters and `approval run` MUST recompute the hash of the payload they are about to execute and MUST refuse, with a distinct machine-readable reason (`payload-mismatch`), when it differs from the hash the grant recorded. A grant therefore approves specific bytes. Changing the payload after grant requires a new request.

Recomputation is unconditional, on every execute path, and a caller-supplied hash is a claim to be CHECKED and never a value to be used in place of it. An executor that accepts "here is the hash of what I am running" has no binding at all: the party under oversight is then the one asserting what it is about to do, which is the assertion the binding exists to replace. `approval run`'s payload is §6.2's argv array and cwd, so it recomputes from the argv and cwd it is about to spawn and refuses `payload-mismatch` when a supplied `--payload-hash` differs, before the child is spawned and before anything is appended. An action whose payload is content rather than an argv is executed through the adapter contract above, which hashes the bytes it holds; it is not executed by spawning a command and presenting the content's hash for it. The same rule binds the paths with no grant: a `supervised` or `autonomous` execution is checked against the `payload_hash` its registration declared (§6.2), and an undeclared or differing hash refuses identically. Every `execution.started` records the hash that was recomputed, so the log states which bytes ran and an operator holding the payload can reproduce the value. The bytes themselves are not recorded there: an argv carries whatever the caller put on it, and §11.1's third invariant keeps such material in the log as a hash. (Amended APRV-140, pending sign-off.)

The reference runtime gives that boundary a definite shape. An adapter implements one method, `act`, over two things: the payload the grant bound to, and a credential provider scoped to that call. The runtime's adapter contract owns everything around it, in a fixed order: recompute the payload hash, verify and consume the token, append `execution.started`, call `act`, append `execution.completed` or `execution.failed`. An adapter cannot skip a step, because it never holds the sequence. Credentials reach `act` only inside the verified-token window, and the provider refuses every request made after `act` returns, so an adapter that keeps its reference gets a refusal rather than a secret. Whatever the adapter reports back (its own failure code, message, and detail) is scanned for the credential values it was handed and redacted before the runtime records or returns any of it, which makes §11.1's third invariant a mechanism at this boundary rather than a convention. Adapters written elsewhere are held to the same sequence by the conformance suite that ships with the contract, in the way §10.3's channels are held to their display rules. (Amended APRV-67.)

Which outcome event closes the sequence is decided by WHERE the sequence stopped, and the boundary is the moment `act` is invoked. Everything up to and including that invocation is the runtime's own preparation and it can speak for it, so a failure there is `execution.failed`: nothing was attempted. From the invocation onward the call belongs to the far side, so an exception there is `execution.indeterminate`: the provider may or may not have committed and this runtime cannot tell. An adapter that RETURNS a failure is `execution.failed` too, because the provider answered and the answer was no. Implementations MUST NOT record an unknown outcome as a failure. A failure is a fact, an unknown outcome is the absence of one, and a caller that reads the second as the first retries a side effect that may already have happened, which idempotency keys only partly cover: a second request under a new key is legal. The distinction is positional rather than a judgment about the error, so it is reproducible by any implementation.

Indeterminate is a custody state, not a result. The consumption is burned: the token stays spent, the `idempotency_key` stays used, the budget stays charged. Refunding an attempt whose outcome is unknown would be the runtime deciding the effect did not happen, which is the one thing nobody knows. A re-run of the key MUST be refused with its own machine-readable reason (`execution-indeterminate`), distinct from "already executed", because the fact and the repair are both different. The record carries a closed reason code and no exception text: an error message is where a credential rides into an append-only log with a plausible excuse, and §11.1's third invariant has no exception for diagnostics. The executing caller still receives the message, redacted.

It resolves only through an explicit reconciliation, invoked by a person and never by the daemon, fed by evidence from the relying party rather than from this runtime's own log. Recovery here is never evidence that the provider did not execute. The resolution is appended as its own `execution.reconciled` record NAMING the indeterminate one, which is never rewritten, so the original observation survives its resolution and an auditor sees both the doubt and its answer. Resolving as `not-executed` is recorded distinctly from resolving as `executed`, and re-opens the possibility of the EFFECT rather than of the action: an `idempotency_key` is the global identity of one side effect (§6.2) and a used one stays used, so a still-wanted effect is declared as a fresh action and requested again. (Amended APRV-120, pending sign-off.)

The reference vault is the storage half of the same sentence. Named credentials live in one file beside the log, `.approval/vault.enc`, holding a JSON map of name to credential encrypted with AES-256-GCM under a key derived by scrypt from an operator passphrase. The passphrase is read from the environment variable the policy names in `vault.passphrase_env` (§5.2), so the policy an agent may read carries a variable name and the value lives outside the repository. The file records its own format version and KDF parameters, so a future scheme is a migration rather than a reinterpretation of old bytes, and every write re-encrypts the whole map under a fresh nonce and lands atomically. The write path is human-only (`approval vault set | list | remove`, identity resolved exactly as `policy attest` resolves it), `list` reports names and never values, and there is deliberately no verb that prints a credential: the value's only sanctioned journey is from the vault into an adapter's `act`, through a credential provider the contract above scopes to the verified-token window. What the vault defends is credentials at rest and casual reads by an agent with file access, since the ciphertext hides the names as well as the values. What it does not defend, stated as plainly as §11 states the rest, is a compromised host or an agent that can read the passphrase variable; such an agent decrypts the file directly and needs no adapter. The vault raises the cost of a credential leak from reading a file to owning the session, and claims nothing beyond that. The reference runtime's interactive writer for adapter credentials is `approval setup adapter <name>`, driven by the credential manifest the adapter declares: it asks for each named value, validates every answer with the adapter's own rules, stores the set in the vault, and offers to verify the result against the service without sending anything. (Amended APRV-68. The `approval setup adapter <name>` sentence is APRV-78, pending sign-off.)

For `manual` actions, channels MUST present the full payload or a faithful rendering of it, clearly delineated from any agent-written summary, before collecting a decision.

### 10.5 MCP wrapper (optional)

A thin MCP server exposing the same verbs as tools for clients where MCP is more ergonomic than shelling out. It shares the CLI's code paths.

What shipped is `approval mcp serve`: a foreground server speaking MCP over stdio, running as one `agent:<id>` the operator fixes when they start it. The tool surface is the agent-facing half of the verb registry, one tool per verb (`register`, `request`, `wait`, `run`, `queue`, `status`, `log_verify`, and the rest). Human-only verbs are absent by design, which is §11's argument applied to a transport: the agent is the untrusted policy and the human is the trusted overseer, an MCP client is an agent's harness, so publishing `grant` on it would hand the untrusted policy the overseer's pen. Three agent-facing verbs are withheld as well, for transport reasons rather than authority reasons: `consume`, which is internal plumbing that `run` wraps, and `hook claude-code` / `hook cursor`, which each read their event from the stdin this transport already owns. A conformance reader building the tool list from this section takes it to be the registry filtered by `human_only`, minus those three. Tool descriptions and input schemas are derived from the same registry `approval instructions --schemas` prints, with `--as` deleted from every published schema, so a caller cannot name an identity; the server's own identity is appended last to every argv, so it wins even where one arrives by another route. A tool call builds an argv and invokes the function the CLI dispatches to, so a refusal is the CLI's refusal, returned as a tool result carrying `{"error":{"code","message"}}` rather than as a protocol error. The [MCP tasks extension](https://modelcontextprotocol.io) and elicitation MAY be mapped onto `awaiting` when client support stabilizes; that remains post-v1, and until then `wait` blocks and answers. A2A's `input-required` maps cleanly for agent-to-agent deployments. (Amended APRV-88, APRV-103, pending sign-off.)

## 11. Security and control model

approval.md operationalizes, at consumer scale, the structure of trusted monitoring with limited auditing from the AI-control literature ([Greenblatt et al., 2023](https://arxiv.org/abs/2312.06942)):

- The **untrusted policy** is the agent proposing actions.
- **Affordance restrictions** are the adapter/token boundary plus the taxonomy: undeclared classes cannot execute.
- The **trusted, expensive overseer** is the human, whose limited attention is the audit budget; `manual` classes spend it before execution, `supervised_sample_rate` spends it retrospectively.
- The **monitoring signal** is deterministic policy (class, cost, reversibility) plus `route.confidence`; escalation is triggered by the runtime, never self-assessed by the executing agent at execution time.
- The **audit trail** is the hash-chained log, which the agent cannot rewrite undetected.

**Defended:** honest-mistake side effects, prompt-injected instructions that try to escalate side effects silently, retries double-executing (idempotency keys), quiet budget creep, after-the-fact disputes about who approved what, tampering with history.

**Not defended, stated plainly:** an agent with direct credential access outside adapters; a compromised host; collusion between agent and a careless approver; and this is engineering informed by control research, offering no guarantees against a schemer that control protocols proper are designed to stress-test. Keep `manual` floors on irreversible classes. Human identity in v0.1 is config-declared (an environment variable or flag); the trust boundary is the local machine, and anyone who can set that configuration and write to the log is inside it. Attestation therefore proves that *someone with local control* signed off, not *who* — cryptographic identity is future work, not a v0.1 claim.

Configuration is therefore never read implicitly from the working tree. Human identity is config-declared, so a file in the repository that any command loaded into its own environment would move the boundary from "anyone with local control" to "anyone who can write a file in the working tree", which every agent working in that tree can do: such an agent could attest a policy, grant its own request, and store a credential, as the human, on every invocation. The environment map of §5.2 is consequently inert. One verb reads it, `approval env`, and its output is an export block a human evaluates in their own shell, so the environment a gate operation runs under is established by the person who launched the process and not by the contents of a directory. The same reasoning applies to any future configuration that could set identity, a credential, or a variable naming one. (Amended APRV-73, pending sign-off.)

Deceptive content inside an approved action is defended to this extent: the approver sees, and the token binds to, the exact payload bytes. What remains undefended is persuasion about whether those bytes should be approved, and any consequence the approver fails to model from bytes they did see.

Fields authored by the party under oversight (`route.confidence`, summaries, cost estimates) MAY raise scrutiny, inform display, or feed retrospective analysis. They MUST NOT reduce sampling probability, downgrade a resolved autonomy level, or shortcut any refusal path. Scrutiny only ratchets upward on self-report.

Disclosure duty binds the informed party. An agent that knows information material to an approval decision and omits it from the request has violated policy even where the action itself was permitted. Materiality is judged as a reasonable approver would judge it. Undeclared side effects are the mechanical case, caught at the adapter boundary; undisclosed context is the same violation in a form only audit can catch, which is one of the things audit is for.

This system makes actions, policies, and decisions common knowledge: a shared record both parties can read and neither can silently rewrite. It makes neither party's mind legible to the other. Agent reasoning is unverifiable from outputs; human intent exceeds any policy file. approval.md shrinks the information asymmetry where artifacts can carry it and claims nothing about interiority on either side.

The gate protects two things: the world from your agents' actions, and your mind from your agents' writes. A system of record is an extended mind; writes to it are cheap to make and expensive to un-believe once relied upon. Policies that set reversible `record.*` classes to `manual` are exercising reversibility-preservation over epistemic state, and the irreversibility floor (§7) remains a minimum, never a statement that manual is reserved for the irreversible.

### 11.1 Global invariants

The following hold across every surface of the runtime. They are implicit acceptance criteria for every future task: a change that violates one is a defect regardless of what its own task asked for, and each is pinned by the test file cited.

1. **Enforcement paths read only verified records.** Gate decisions are computed from log state that has passed chain verification, never from unverified or partially read input (`tests/state.test.ts`). *Scope note:* the attestation-required list of §5.2 (request intake, grant recording, token minting) enumerates operations rather than modules, and the harness hooks of §14 (`approval hook claude-code`, `approval hook cursor`) are one of those surfaces: a hook verdict that lets a command run with no human in the loop is a gate decision, so it MUST verify policy attestation and loop-escalation against the verified log before it allows, and MUST fail closed when it cannot reach the log (`tests/cli-hook.test.ts`). (Amended APRV-139, pending sign-off.)
2. **Gate-typed events never accept caller timestamps.** `ts` on gate-typed events is assigned by the runtime at the write boundary; a caller-supplied value is refused (`tests/clock.test.ts`).
3. **Raw secrets never appear in the log; only their hashes do.** Execution tokens and binding material are logged as hashes, and a raw-token scan over written logs finds nothing (`tests/token.test.ts`, `tests/binding.test.ts`).
4. **Self-reported fields never reduce scrutiny.** Values authored by the party under oversight may raise scrutiny and never lower it (`tests/ratchet.test.ts`).
5. **Every check-then-append passes through compare-and-append.** No path reads a decision-relevant log state and appends on it without the atomic head check that makes the pair safe under concurrency (`tests/concurrency.test.ts`, `tests/log.test.ts`).
6. **Refusals are machine-readable and distinct, and every code union is pinned by a test.** Each refusal path returns its own stable code, and the unions are frozen public API (`tests/gate.test.ts`, `tests/token.test.ts`, `tests/execute.test.ts`, `tests/log.test.ts`).
7. **Configuration is never loaded implicitly from the working tree.** No verb reads a working-directory file into its own environment; the environment a gate operation runs under is established by the human who launched the process (`tests/cli-env.test.ts`). (Amended APRV-73, pending sign-off.)
8. **A gate verdict whose event cannot be appended is a refusal.** No surface returns `proceed`, prints an allow, or hands back a token before the event recording that verdict has been appended. When the append fails, for any reason the writer can give (lock contention, a disk error, a schema refusal at the write boundary), the caller receives a refusal carrying the stable code `append-failed` and the writer's own error, never a success whose record is missing. Nothing may soften a verdict because the log would not take it: a budget refusal whose `budget.exceeded` could not be written is still a budget refusal. The rule binds the paths that write nothing too, by naming where their record is: an autonomous admission appends no `approval.*` event (§6.3), so `execution.started` is the whole of its accounting, and a start that cannot be recorded does not happen (`tests/evidence-append.test.ts`). (Amended APRV-123, pending sign-off.)

## 12. Interoperability

- **Backlog.md:** native. Tasks live in `backlog/`, the envelope is one preserved frontmatter key, board `status` and approval `state` are independent. approval.md ships no board; use Backlog.md's.
- **AGENTS.md import:** `approval import agents-md` parses "require approval first / allowed without prompting" permissions sections into draft policy classes for human confirmation, turning existing prose conventions into enforced policy.
- **Inbound adapters (post-v1):** e.g. a Telegram capture bot, arbitrary apps via `approval register --json`.
- **Outbound sinks (post-v1):** approved+scheduled tasks mirrored to TickTick / Google Tasks / Google Calendar as views, never sources of truth. Mapping via [RFC 8984 jsCalendar Task](https://www.rfc-editor.org/rfc/rfc8984) with the envelope as a vendor extension, `X-APPROVAL-*` in [VTODO](https://www.rfc-editor.org/rfc/rfc5545).

## 13. Non-goals

No new task file format. No kanban UI. No agent framework or orchestration platform. No hosted service (local-first; a sync story can come later). No channel breadth beyond the three shipped. No claim of scheming-robustness (§11).

Post-v1 (non-normative): `review: adversarial` as a per-class flag. Before a flagged `manual` request reaches the approver, an independent agent instance with the raw payload and no stake in the outcome writes a dissent: worst plausible reading, omissions, questions a suspicious reviewer would ask. The approver adjudicates between framings instead of consuming one. Untrusted monitoring, spent where human attention is scarcest.

Post-v1 (non-normative): a Rust fast-path implementation of the hot loop (policy resolution, chain-tail verification, gate verdict) as the latency accelerator for the v1 harness hook of §14 (`approval hook claude-code`, `approval hook cursor`) and the per-tool-call adapters like it, where Node startup latency on every gated tool call is unacceptable. Conformance is defined by the fixture suite; the crates.io name `approval-md` is reserved for it. The TypeScript runtime remains the reference implementation for the full surface.

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
- **M8** MCP wrapper (§10.5) and the agent-harness hooks, `approval hook claude-code` and `approval hook cursor`: a Claude Code PreToolUse adapter that classifies the command a harness is about to run and resolves it against the policy. Allow is recorded only where the class is gated: a manual class waits on a decision the log records, a supervised class appends `task.registered` and proceeds, an autonomous class appends nothing. Both surfaces expose the same gate to a client that is not a shell. The §13 Rust fast-path is this hook's post-v1 latency accelerator, not a prerequisite. Post-v1: TickTick/GCal sinks, inbound capture adapters. (Amended APRV-103, pending sign-off.)

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
