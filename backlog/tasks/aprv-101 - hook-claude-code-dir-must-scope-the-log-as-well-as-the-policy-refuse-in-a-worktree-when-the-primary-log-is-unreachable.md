---
id: APRV-101
title: >-
  hook claude-code: --dir must scope the log as well as the policy; refuse in a
  worktree when the primary log is unreachable
status: Done
assignee:
  - '@fable'
created_date: '2026-08-18 22:33'
updated_date: '2026-08-19 15:17'
labels:
  - bug
  - dogfood
  - cli
dependencies: []
priority: high
ordinal: 93000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found 2026-08-18: after a session in an agent worktree, the WORKTREE's .approval/log/events.jsonl held 21 task.registered (files.write.workspace) records by agent:claude-code while the primary checkout's log received nothing. Root cause in src/cli/hook.ts: .claude/settings.json invokes the hook with --dir pointing at the primary checkout, but --dir scopes only the policy (gateOptions); the log path is resolved from the process cwd, which in a worktree session is the worktree. Policy from the primary, records to a dead-end log that must never be committed (its chain forks from main's tail and merges do not reconcile hash chains). Silent, and exactly the 'unlogged work' failure mode CLAUDE.md names. Decision with the human: ONE log. The hook appends to the primary checkout's log through the existing append lockfile, and refuses closed with a machine-readable code when it cannot, rather than creating a log where it stands. Registration noise is a policy matter (class autonomy), not a reason to drop records. Rejected: per-worktree logs merged later (re-appending events is fabrication).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 When --dir is given and --log is not, the hook's log path is <dir>/.approval/log/events.jsonl, never cwd-relative; an explicit --log still wins
- [x] #2 When neither is given, the hook resolves the primary checkout (the common git dir) and uses its .approval/log; a plain checkout resolves to itself
- [x] #3 In a worktree with no reachable primary log, the hook refuses closed with a distinct machine-readable code and a one-line fix; it never creates .approval/log inside a worktree
- [x] #4 Every append still goes through the append lockfile and compare-and-append (SPEC section 11 global invariants); the implementation notes say so
- [x] #5 Tests use a throwaway worktree to prove records land in the primary log and none appear in the worktree; the refusal case is covered
- [x] #6 The dogfood runbook and the agent-instructions wording are reconciled with the chosen behaviour (write-through to primary, or refusal); the human's pick is recorded in the notes
- [x] #7 npm test and lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, worktree from main (b3ecc15). 2. src/cli/hook.ts: one resolver for log and policy: --log wins for the log, --policy for the policy; --dir sets both; neither gives the primary checkout via git rev-parse --git-common-dir (plain checkout = itself; no git = cwd, commented). 3. New deny code hook-log-unreachable: the hook never creates a log; a missing resolved log denies with the path and a one-line fix; nothing created in a worktree. 4. Append path untouched (lockfile and compare-and-append, invariant 5). 5. Tests: --dir split dirs, real git worktree, refusal, plain checkout, --log wins. 6. docs/claude-code-hook.md, HOOK_HELP, cli-reference reconciled. 7. PR by branch, auto-merge; records here.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Review evidence 2026-08-19 (read-only audit of main 3637632): src/cli/hook.ts resolves the log as resolvePath(--log, DEFAULT_LOG_PATH, cwd) at the line after the "gate itself is not gated" allow (around :532), from process cwd; gateOptions(parsed.flags, cwd) scopes only policy, so policy and log diverge exactly as this task says. docs/claude-code-hook.md lines 56-57 ("--dir points policy discovery and the log at the primary checkout") and the hook help text already describe the FIXED behaviour, not the shipped one. tests/cli-hook.test.ts never passes --dir to the hook, which is why it shipped silently: add that case. No refusal code exists yet for "primary log unreachable" (HOOK_DENY_CODES has none); the fix needs one, pinned like the others. Also noted: the manual path polls readVerifiedRecords + requestState itself (hook.ts ~398-443) with its own rejected > expired > granted precedence plus revoked and a hook-io arm, a hand-rolled copy of commandWait (src/cli/execute.ts ~527-579); sharing the loop when 101 is built would remove one drift risk.

Reproduced live 2026-08-19 13:39 local in worktree .claude/worktrees/remote-control-f54e71 (hook wired with --dir /Users/carter/dev/approval-md): gh pr create and gh pr merge --auto (vcs.pr.*, vcs.push.main, both supervised) appended task.registered at seq 27 and 28 to the WORKTREE copy of .approval/log/events.jsonl, leaving that tracked file dirty there while the primary log stayed at seq 26. The worktree file was left untouched (no log mutation by agents; never committed) and the branch there was already merged. Until this task lands, sessions in worktrees should expect this and never commit .approval/ from a worktree.

Opus subagent build, PR by branch aprv-101-hook-log-scope (#79), merged at 252b496. gateOptions() replaced by hookScope(): --log wins for the log, --policy for the policy; --dir sets both; with no flags both follow primaryRoot(cwd) = dirname of git rev-parse --git-common-dir (plain checkout resolves to itself; no git or not a repo falls back to cwd, today's behaviour, commented). New deny code hook-log-unreachable after hook-policy-unavailable: the hook writes to an existing log and never creates one; detail names the path and the fix (approval init then policy attest in the root, or --log). Judgement call: a scaffolded but empty .approval/log/ counts as reachable (init creates the dir and no events.jsonl; paths.ts treats an absent file as an empty log), so only a missing directory refuses; nothing is ever created either way. INVARIANT 5: only which path is handed to gateAndWait changed; register/request run exactly as before through the append lockfile and compare-and-append. Human's pick recorded: write-through to the primary, refusal when unreachable (not per-worktree logs). Tests: new tests/cli-hook-scope.test.ts (5: --dir split dirs, real git worktree, refusal with no .approval in the primary, plain checkout, --log wins); one existing test (unattested policy) now runs approval init first so the refusal under test is still the one that fires. 1789 tests, lint and typecheck clean. Docs: claude-code-hook.md, cli-reference.md hook section, dogfood-cutover.md one sentence. SIDE FINDING: the classifier reads an angle-bracket placeholder inside a quoted argument (e.g. a backlog --plan text containing a redirect-looking token followed by an .approval path) as a redirect to a protected path, classifying policy.edit (manual) and timing out after 9 minutes; fail-closed and defensible, but a false positive on prose; noted for APRV-104 or a classifier task.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Hook resolves policy and log from one root (explicit flags, then --dir, then the primary checkout via git), never creates a log, refuses closed with hook-log-unreachable. PR #79 merged at 252b496; verified by the new worktree tests (records land in the primary, nothing in the worktree), 1789 tests, lint, typecheck.
<!-- SECTION:FINAL_SUMMARY:END -->
