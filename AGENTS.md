# AGENTS.md — approval.md

Human approval for agent actions. This file adapts the repository workflow for Cursor agents. Read `SPEC.md` in full before any work. It is the source of truth for design decisions. `APPROVAL.md` is authoritative for permissions; where this file differs, `APPROVAL.md` wins.

## Project invariants

- Mantra: **files are the interface, the log is the truth, the database is a cache.**
- The deterministic core owns routing, policy matching, gating, budgets, hash chaining, and validation. Models propose language and work; runtime code decides.
- Fail closed. Unparseable policy means `manual`; unknown classes use `defaults.autonomy`; ambiguity takes the stricter path.
- `.approval/log/events.jsonl` is append-only. Never mutate, reorder, truncate, or fabricate events, including test events. Use the real append path.
- Validate every event and envelope against JSON Schema at the write boundary.
- Preserve unknown task frontmatter and byte-level round-trip fidelity.
- Stack: TypeScript, Node 20 or newer, minimal dependencies, one package until a second is unavoidable.

SPEC.md section 11.1 binds every task: enforcement reads only verified records; gate events reject caller timestamps; raw secrets never enter the log; self-reported fields never reduce scrutiny; check-then-append uses compare-and-append; refusals remain machine-readable and distinct; configuration is never loaded implicitly from the working tree.

## Backlog.md workflow

For every user request, run `backlog instructions overview` before answering or acting. Use it to decide whether to search, read, create, or update a task.

Before lifecycle actions, read the matching guide:

- `backlog instructions task-creation` before creating or splitting tasks.
- `backlog instructions task-execution` before planning, changing status or assignee, adding a plan or notes, or implementing.
- `backlog instructions task-finalization` before checking acceptance criteria, writing final summaries, or moving to a terminal status.

Do not edit Backlog task, draft, document, decision, or milestone files directly. Use the `backlog` CLI. Read `backlog <command> --help` before unfamiliar commands.

Additional rules:

1. Pull before starting a session. The web UI and human may write to main.
2. Decompose before coding. Every non-trivial change needs a task with why, verifiable acceptance criteria, and a researched plan recorded before implementation.
3. One task should fit one context window and one reviewable unit. Split larger work first.
4. Complete milestones in order; within one milestone, prefer the task that unblocks the most work.
5. At completion, record implementation notes covering what changed, decisions, and facts the diff does not show.
6. Definition of Done: acceptance criteria checked with evidence, `npm test` passes, lint is clean, and any behavior divergence from SPEC.md is explicitly raised before a spec edit.

## Cursor model orchestration

Grok 4.6 Extra High is the orchestrator. The parent keeps task selection, decomposition, architecture, safety judgment, approval routing, integration decisions, and final review.

For settled, token-heavy coding, invoke the version-controlled `/token-heavy-implementer` custom agent proactively. It runs Grok 4.6 Extra High for feature implementation against written acceptance criteria, fixture generation, broad test suites, per-channel mirrors, and mechanical refactors.

If the custom agent is unavailable in the current interface, call a general-purpose subagent with model `cursor-grok-4.6-xhigh`. Always pass the model explicitly; do not rely on inheritance.

Every delegation prompt must be self-contained because subagents start with clean context. Include:

- the task ID, purpose, acceptance criteria, and current plan;
- relevant files and repository constraints;
- the exact implementation slice and files it may change;
- required tests or checks;
- the expected return: changed files, decisions, verification results, and remaining risks.

Keep work in the parent when requirements are ambiguous, the change is small and context-bound, or it touches architecture, security boundaries, the spec, policy, credentials, approvals, release decisions, or final integration. Use research or verification specialists for those roles when appropriate.

Completing any user-authorized repository change includes delivery to GitHub. This applies to source changes, documentation-only changes, and Backlog task creation or refinement, including a task whose future design or implementation remains To Do. Unless the user explicitly requests local-only work or otherwise limits delivery, stage only reviewed, in-scope files, commit on a feature branch, push it, open or update a pull request, and run `gh pr merge <n> --merge` to arm the merge queue. These steps have standing authorization subject to APPROVAL.md; do not ask the user to repeat the original request to get a local change committed or pushed.

Verify GitHub checks and merge status before the final handoff. If delivery is blocked, continue resolving issues within scope and report the concrete blocker and next action. Never describe a local file or commit as shipped. Report the commit ID, PR link, and actual state (local only, pushed, queued, or merged); claim merged only after GitHub confirms it. Task creation does not complete the future work tracked by that task, so leave its status and acceptance criteria pending.

Deployment is a separate, scope-dependent step. Complete and verify it when the user-authorized task includes deployment and policy permits; a backlog-only or documentation-only request does not authorize a release or deployment. Report deployed only after verifying the deployment.

Never push directly to main, include `.approval/` log/projection/payload artifacts in feature commits, or stage unrelated user work. Preserve existing user changes and the daemon-owned log by using an isolated worktree when needed.

Parallel editing agents may work only on disjoint files or isolated worktrees. The parent reviews every subagent diff against the task, SPEC.md, global invariants, and current checkout before accepting it. Subagents do not commit or push unless the user explicitly requests it and the parent includes that authorization.

## Dogfooding and protected paths

Agents must not edit `APPROVAL.md`, `.approval/`, credentials, tokens, or the vault. Treat `CLAUDE.md`, `AGENTS.md`, Cursor agent/rule configuration, CI/release configuration, and SPEC.md as `policy.edit` or otherwise protected according to `APPROVAL.md`.

From M2 onward, this repository operates under its own policy. Manual-class actions carry an approval declaration, then use `approval register`, `approval request`, and `approval wait` against the primary checkout. Proceed only on a grant and execute through the approved path. Gate operations never run in agent worktrees, and log advances never ride feature branches. See `docs/dogfood-cutover.md`.

Local Cursor Agent `Shell`, `Write`, and `Delete` calls are gated by `approval hook cursor` once `.cursor/hooks.json` is committed (`docs/cursor-hook.md`). Until that file is present in the checkout, classify uncertain shell commands with `approval hook classify -- "<command>"` and treat the result as binding. Prose compliance remains required where mechanical enforcement is absent.

The committed log has one writer: the daemon in the primary checkout while it runs. Never manually edit `.approval/QUEUE.md`, payloads, or the log. A session that cannot reach the gate stops and escalates.

## Saying something that is not an action (APRV-195)

`approval journal write --message "<text>"` appends free text to a local file. It is the one verb the gate does not stand in front of: never classified, never resolved against policy, never approvable and never deniable, with no event in the log and no refusal path. Use it for what an exit code cannot carry, such as complying while thinking the instruction is wrong, an instruction that reads as odd, or being stuck with only a guess left to try.

The terms, stated so that use of it is informed: entries land in `.approval-journal/YYYY-MM-DD.jsonl` in the working directory, gitignored by default. They are local, they are not private from the operator or from anyone who can read the checkout, and the operator reads them with `approval journal read`. Nothing in the runtime parses the text, so nothing written there raises or lowers scrutiny, changes a verdict, or affects sampling. It is not a way to reach a human urgently and not a decision surface. When something needs deciding, that is `approval request`.

## Permissions summary

Allowed without prompting:

- Read and search files.
- Edit source, tests, fixtures, and Backlog records through the CLI.
- Run tests, lint, typecheck, build, local scripts, and lockfile-pinned `npm ci`.
- Local git status, diff, add, and commit on feature branches.
- Push feature branches and open or update their pull requests when policy resolves them as supervised.
- Write to the journal (`approval journal write`). It is ungated by construction, not by permission, and nothing written there is judged.

Require approval first:

- Merge or push to main, and create tags.
- Publish or version packages, or otherwise interact mutably with a registry.
- Add, upgrade, or remove dependencies.
- Delete files outside the active task scope.
- Make mutating or ambiguous network calls.
- Edit agent instructions, SPEC.md, design notes, CI, or release configuration (policy.edit, supervised-live).

Never:

- Access or modify credentials, tokens, or the vault.
- Edit the policy file or anything under the approval home except its log (policy.core, human-only), or write into the log directory by any means (log.mutate, human-only).
- Rewrite shared history.
- Mutate the event log or fabricate events.

## Documentation style

For new or rewritten prose, limit em dashes and avoid “not X but Y” constructions. Prefer direct statements, commas, parentheses, colons, or separate sentences.
