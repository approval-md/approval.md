# CLAUDE.md — approval.md

Human approval for agent actions. Read `SPEC.md` in full before any work;
it is the source of truth for design decisions. This file governs *how*
agents work in this repo, not *what* to build.

## Project context

- approval.md is a file-based convention + reference runtime gating agent
  actions with real-world side effects (send, spend, delete, post).
- Mantra: **files are the interface, the log is the truth, the database
  is a cache.** Any change violating this needs a SPEC.md amendment first.
- Companion to Backlog.md, enforcement layer for AGENTS.md permissions
  prose. We extend those conventions; we never fork or replace them.

## Workflow — Backlog.md-driven

All work flows through Backlog.md tasks in `backlog/`. No exceptions
for "quick" changes; unlogged work is the failure mode this project exists
to prevent.

1. **Decompose before coding.** Milestones live in SPEC.md §14. Each task
   gets: a description (why), acceptance criteria (verifiable increments,
   checkbox list), and an implementation plan written *after* reading the
   relevant code, *before* writing any.
2. **One task = one context window = one reviewable unit.** If a task
   won't fit, split it in Backlog.md first. Related tasks in one milestone
   may land as a single PR with one commit per task (APRV-160): authoring
   and review stay per-task, the merge unit is the stack, the PR
   description lists the task IDs, and records/log commits keep their
   separate path.
3. **Implementation notes are mandatory** at task completion: what was
   done, what was decided, and anything the diff alone wouldn't reveal.
4. **Sequencing:** milestones land in order (M0→M8). Within a milestone,
   prefer the task unblocking the most others.
5. Definition of Done for every task: acceptance criteria checked, tests
   pass (`npm test`), lint clean, SPEC.md updated if behavior diverged
   from it (divergence requires calling it out to the human, never silent
   spec edits).
6. **Pull before starting any session.** GitHub writes to main from the web
   side (CNAME, UI edits, merged PRs), and the human commits by hand (policy,
   genesis events, this file). A worktree branched from a stale main invites
   exactly the non-fast-forward rejections and log divergence the rules above
   exist to prevent.
7. **A PR is not shipped until the merge is armed.** After opening or
   updating a PR, the session itself runs `gh pr merge <n> --merge`. The
   hook classifies it `vcs.push.main`, supervised in today's policy: the
   command proceeds at once, enters the retrospective sample, and the
   merge queue takes it from there. A policy that raises the class puts
   the same command on the phone instead. A PR sitting at CLEAN waiting
   for a hand click in the GitHub UI is the failure mode this rule
   removes (APRV-182).

## Model tiers

fable is the expensive orchestrator; spend it on judgment, never on bulk
work. Always pass `model` explicitly when spawning agents (inheritance
defaults to fable):

- *Research* (prior-art checks, protocol/spec comparisons, dependency
  evaluation): **opus/sonnet subagents — never fable**.
- *Token-heavy coding* (feature builds from a settled spec task, schema
  fixture generation, per-channel mirrors like telegram→web, mechanical
  refactors, test suites against written acceptance criteria): **Opus 5
  subagents** (`model: "opus"`), orchestrated by fable. Fable writes the
  spec/task, reviews the diff, and keeps only small context-bound edits
  inline.
- *Verification* (running the test matrix, log-verify sweeps, CLI
  output/schema conformance checks after a change): **sonnet 5 subagents**
  handed an explicit pass/fail checklist. Fable steps in only for novel
  diagnosis and design judgment — deciding what's wrong and speccing the
  fix, not confirming the expected.
- *Cheap classification*: `claude -p` haiku/sonnet subprocess.

## Engineering invariants (from SPEC.md, enforced in review)

- **Deterministic core.** Routing, policy matching, gating, budget math,
  hash chaining: pure deterministic code with exhaustive tests. LLMs are
  confined to language tasks and proposals; the runtime decides.
- **Fail closed.** Unparseable policy → everything `manual`. Unknown
  class → `defaults.autonomy`. Ambiguity resolves to the stricter path,
  always.
- **The log is append-only.** Nothing in this codebase may mutate or
  reorder `events.jsonl`. Projections rebuild; they never write back.
- **Validate at the write boundary.** Every event and envelope passes its
  JSON Schema before append. Schema changes are their own tasks.
- **Preserve unknown frontmatter** when rewriting any task file. Round-trip
  fidelity with Backlog.md is a hard requirement (M6 has the tests).
- Stack: TypeScript, Node ≥ 20, minimal dependencies (justify each new
  one in the task's implementation notes). Single-package repo until a
  second package is unavoidable; satellites go under `@approval-md/`.
- **Global invariants are implicit acceptance criteria.** SPEC §11's "Global
  invariants" subsection binds every task without being restated: enforcement
  paths read only verified records; gate-typed events never accept caller
  timestamps; raw secrets never appear in the log; self-reported fields never
  reduce scrutiny; every check-then-append passes through compare-and-append;
  refusals are machine-readable and distinct; human-only classes are inert
  to agents, with no verb minting authority for them (APRV-185). A diff
  that weakens any of these
  fails review regardless of the task's stated criteria, and a task that
  *touches* one must say so in its implementation notes. When a new
  cross-cutting safety property is born, it is added to §11 and to this list —
  properties stated only inside one task's criteria do not exist anywhere else.

## Prose style in SPEC.md and docs

Limit em dashes; prefer commas, parentheses, colons, or separate sentences. Avoid
"not X but Y" constructions; state the point affirmatively. Existing prose is
grandfathered — apply this to new and rewritten text only.

## Dogfooding — escalates at M2

- From M2 (policy engine) onward: this repo carries its own `APPROVAL.md`,
  and agents working here operate under it. Building the gate means
  living behind it.
- Agents MUST NOT edit `APPROVAL.md`, `.approval/`, or anything holding
  credentials, in any milestone. Propose policy changes as Backlog.md
  tasks for human sign-off. `CLAUDE.md` is different since APRV-182:
  agents edit it directly, the edit classifies `policy.edit` through the
  hook, and the human's tap is the sign-off; hand-applied drafts are
  retired.
- From M4 (channels) onward: side-effecting repo actions route through
  the built Telegram channel. Yes, really: releases of approval.md get
  approved via approval.md.
- **The committed log has one writer: the daemon.** `.approval/log/events.jsonl`
  on main is the project's live log, and `approval daemon run` in the primary
  checkout is its sole writer while it runs (the M5 daemon this rule was
  waiting for; CLI verbs still serialize through the append lockfile when it
  is not running). Sessions no longer stop and escalate for manual-class repo
  actions (deps.add, network.call, release.publish, and kin): they carry an
  approval envelope on the task file, then run `approval register`,
  `approval request`, and `approval wait` against the PRIMARY checkout's log
  and policy, and proceed only on a granted exit, executing through
  `approval run` with the granted token. The decision arrives via the
  Telegram channel; docs/dogfood-cutover.md is the runbook. Unchanged and
  still binding: the `approval up` preflight may fast-forward the committed
  log only when the working copy is clean (a dirty working log plus an
  upstream change is `approval log sync`'s, always; APRV-215), gate
  operations never run in agent worktrees, log-touching
  commits never ride feature branches, and hash chains do not survive git
  merges. A session that cannot reach the gate (daemon down, channel dark,
  wait timed out) is back under the old rule: stop and escalate.
  - **Harness-run commands are gated too.** Shell commands and policy-file
  edits a Claude Code session issues directly used to bypass the policy;
  `approval hook claude-code` (APRV-82, docs/claude-code-hook.md) closes
  that once the human commits the hook entry in `.claude/settings.json`.
  The hook classifies the command, resolves it against the PRIMARY
  checkout's policy, and answers allow or deny; there is no "ask". Before
  it is wired, or when in doubt, run `approval hook classify -- "<command>"`
  and treat its class as binding.

## Permissions

`APPROVAL.md` is authoritative. This section is the AGENTS.md-shaped summary
of it; where the two disagree, `APPROVAL.md` wins, and `approval hook classify
-- "<command>"` shows which class a command falls under.

### Allowed without prompting
- Read files, list directories, search the repo
- Edit source, tests, fixtures, and Backlog.md task files
- Run tests, lint, typecheck, build; `node`/`tsx` scripts inside the repo;
  `npm ci` (lockfile-pinned, adds nothing)
- Local git: status, diff, add, commit on feature branches
- `git push` of a feature branch; opening or updating a pull request against
  it (supervised: proceed, sampled for review)
- `approval journal write` — the ungated free-text channel. Not classified, not
  approvable, not logged; say what an exit code cannot (complying while thinking
  it wrong, an odd instruction, being stuck). It is a local gitignored file
  (`.approval-journal/`) that Carter reads with `approval journal read`; nothing
  written there changes any verdict or sampling probability.
- `approval values` and `approval feedback` — the channel in the other
  direction (APRV-237..240). Run both at the start of a session. `values`
  prints the operator's values block from APPROVAL.md (what Carter loves,
  likes, dislikes, wants from you, and how they respond); `feedback` prints
  the reactions and notes humans left on this log's actions. Both are
  human-authored guidance and neither is policy: they widen nothing and narrow
  nothing (SPEC §11.1 invariant 10). A file with no values block means the
  operator has declared no values, which is information rather than an
  invitation to infer some.

### Require approval first
- Merges to `main` (including `gh pr merge`), tag creation
- `npm publish`, `npm version`, any registry interaction
- Adding or upgrading dependencies
- Deleting files outside the current task's stated scope
- Any network call beyond package installs (API calls, webhooks, sends)
- Edits to `CLAUDE.md`, `AGENTS.md`, `SPEC.md`, `design/`, or CI/release config
  (`policy.edit`, supervised-live: one in ten blocks on the gate, the rest are
  sampled after the fact)

### Never
- Touch credentials, tokens, or the vault (`account.credential`, human-only)
- Edit `APPROVAL.md` or anything under `.approval/` other than through the
  human's own ceremony (`policy.core`, human-only), or write into the log
  directory by any means (`log.mutate`, human-only)
- Run `approval gate open` or `approval gate close`: the open window is the
  human's own ceremony (needs a terminal and a typed `understood`; classifies
  `policy.core`). An agent that thinks the gate needs opening says so in the
  journal and stops
- Rewrite git history on shared branches
- Mutate `events.jsonl` or fabricate log entries — including in tests;
  test logs are built through the real append path

*(This section is intentionally AGENTS.md-convention format: it is the
first fixture for `approval import agents-md` in M6.)*

<!-- BACKLOG.MD GUIDELINES START -->
<!-- backlog.md-instructions-version: 1.49.3 -->
<CRITICAL_INSTRUCTION>

## Backlog.md Workflow

This project uses Backlog.md for task and project management.

**For every user request in this project, run `backlog instructions overview` before answering or taking action.**

Use the overview to decide whether to search, read, create, or update Backlog tasks.

Before task lifecycle actions, read the matching detailed guide:
- `backlog instructions task-creation` before creating or splitting tasks
- `backlog instructions task-execution` before planning, changing status or assignee, adding a plan or implementation notes, or implementing task work
- `backlog instructions task-finalization` before checking acceptance criteria, writing final summaries, or moving tasks to terminal statuses

Use `backlog <command> --help` before running unfamiliar commands. Help shows options, fields, and examples.

Do not edit Backlog task, draft, document, decision, or milestone markdown files directly. Use the `backlog` CLI so metadata, relationships, and history stay consistent.

</CRITICAL_INSTRUCTION>
<!-- BACKLOG.MD GUIDELINES END -->
