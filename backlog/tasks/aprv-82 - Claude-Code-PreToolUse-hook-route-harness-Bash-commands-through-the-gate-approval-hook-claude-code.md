---
id: APRV-82
title: >-
  Claude Code PreToolUse hook: route harness Bash commands through the gate
  (approval hook claude-code)
status: Done
assignee:
  - fable
created_date: '2026-08-18 11:00'
updated_date: '2026-08-18 12:03'
labels:
  - cli
  - dogfood
milestone: m-11
dependencies:
  - APRV-85
references:
  - SPEC.md
  - docs/dogfood-cutover.md
  - 'https://code.claude.com/docs/en/hooks'
priority: high
type: feature
ordinal: 81000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Today the runtime only gates what is executed via 'approval run'. Shell commands the Claude Code harness runs directly (git push, gh pr create, npm install, curl) bypass APPROVAL.md entirely, so enforcement of vcs.push.*, network.call, deps.add and release.publish in this repo is still social prose in CLAUDE.md, the exact AGENTS.md failure SPEC §2 critiques. Two consecutive sessions (APRV-81 and its PR) got the rule wrong from prose alone. Add a Claude Code PreToolUse hook adapter so the harness cannot run a gated command without a gate verdict.

Intended slot: M8, alongside the MCP wrapper (both expose the gate to a harness). SPEC §13's Rust fast-path stays post-v1 as the latency accelerator; this task is the TypeScript reference.

Scope: (1) new verb 'approval hook claude-code' that reads the PreToolUse JSON on stdin (tool_name, tool_input.command), classifies the command into an action class via a small deterministic table (regex -> class, e.g. 'git push origin main' -> vcs.push.main, 'git push' -> vcs.push.branch, 'gh pr create' / 'curl' / 'wget' -> network.call, 'npm install <pkg>' -> deps.add, 'npm publish' / 'npm version' / 'git tag' -> release.publish, force-push or rebase onto a shared branch -> vcs.history.rewrite), fails closed (unclassified non-allowlisted commands -> defaults.autonomy), resolves the class against the primary checkout's attested policy, and for autonomous returns allow, for supervised/manual runs approval request + wait and returns allow only on a granted decision, otherwise deny with a machine-readable reason (SPEC §11 refusals). (2) Hook output follows Claude Code's PreToolUse decision JSON (permissionDecision allow/deny with reason). (3) A documented .claude/settings.json hooks entry the human commits (policy.edit class; agents do not write it). (4) Non-Bash tools pass through unchanged.

Constraints: classifier is pure and exhaustively tested; every gate write goes through the existing request/wait/compare-and-append path, no new log writer; the hook never reads self-reported fields to reduce scrutiny; when the daemon or channel is unreachable the hook denies (fail closed) rather than falling back to ask.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 approval hook claude-code reads PreToolUse stdin JSON and prints a valid Claude Code hook decision JSON for Bash tool calls; non-Bash tool calls print an allow pass-through
- [x] #2 Command classifier is a pure function with a fixture table covering vcs.push.branch, vcs.push.main, vcs.history.rewrite, network.call, deps.add, release.publish, read.* and an unclassified case that resolves to defaults.autonomy
- [x] #3 autonomous classes return allow without touching the log; supervised/manual classes create a request through the existing gate path and return allow only after a granted decision, deny otherwise, with a machine-readable refusal code
- [x] #4 Daemon/channel unreachable or wait timeout returns deny, never ask or allow
- [x] #5 docs/ documents the .claude/settings.json hooks entry and states that the human commits it (policy.edit)
- [x] #6 SPEC §14 names the harness hook as v1 with the Rust engine as its post-v1 accelerator; edit called out to the human
- [x] #7 npm test and lint pass; dogfood test confirms every class in the repo's own APPROVAL.md is reachable from the classifier table
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. New src/core/command-class.ts: pure classifier. Tokenizer handles quotes, escapes, env-assignment prefixes, redirections, heredocs, and splits on && || ; | & newline. Each segment maps by a data table to a class: read.shell (ls cat grep rg find head tail wc echo pwd which git status/diff/log/show/branch/rev-parse), read.vcs.remote (git fetch, gh pr view/list/status/checks/diff, gh issue view/list, gh repo view), files.write.workspace (sed -i, mkdir, cp, mv, touch, tee, node/npx/tsx scripts in repo, npm test/run/build/lint, rm with relative in-scope paths), vcs.commit.branch (git add/commit/checkout/switch/stash/cherry-pick/merge/pull), vcs.push.branch (git push with an explicit non-main refspec), vcs.push.main (git push to main/master, or bare git push: unknown target resolves stricter), vcs.history.rewrite (push --force/-f/--force-with-lease, rebase, reset --hard, commit --amend, filter-branch), deps.add (npm install/i/add <pkg>, npm update, yarn add, pnpm add), deps.install (bare npm install/ci), deps.remove (npm uninstall/rm), release.publish (npm publish, npm version, git tag, gh release), network.call (curl, wget, ssh, scp, rsync, nc, gh api, gh pr create/merge/comment/close/edit, gh issue create/comment), files.delete.out_of_scope (rm with absolute or .. paths), policy.edit (any non-read segment naming APPROVAL.md, .approval/, CLAUDE.md, .claude/settings*.json, including redirect targets). Opaque constructs (bash -c, sh, eval, source, node -e, python -c, sudo, env, xargs, backticks) and unknown binaries return unclassified. $(...) is classified recursively; it taints the segment unless every inner segment is read.*. The 'approval' binary itself is a documented pass-through (already gate-enforced). tool_input.description is never read (self-reported). Exhaustive fixture table in tests. 2. New src/cli/hook.ts: 'approval hook claude-code' reads PreToolUse JSON on stdin. Non-Bash tools: Edit/Write/MultiEdit/NotebookEdit with a protected file_path -> policy.edit; everything else -> allow pass-through (amends AC1: still pass-through except the policy files). Bash: classify all segments; any unclassified -> deny (code hook-unclassified). Resolve each class via loadPolicy+resolve against --dir/--policy; all autonomous -> allow without touching the log. Otherwise build one in-memory envelope (origin.app claude-code-hook, created_by = --as agent id, one action per distinct gated class, idempotency_key hook:<session_id>:<tool_use_id or random>:<class>, summary = command truncated, payload_hash = sha256/jcs of {command, cwd}), register({task, envelope}), request each with payload, then poll like commandWait until all decided or --timeout (default 55s; docs recommend hook timeout 600 with --timeout 9m). Granted -> allow; rejected/revoked/expired/timeout/any gate refusal/policy unreadable/log unreachable -> deny with a machine-readable code (hook-unclassified, hook-rejected, hook-expired, hook-timeout, hook-gate-refused:<code>, hook-policy-unavailable, hook-io) in permissionDecisionReason. Never 'ask'. Output is Claude Code hookSpecificOutput JSON on stdout, exit 0; usage errors exit 2 (which Claude Code treats as block). Sibling 'approval hook classify <command> --json' prints the classification for humans and tests. 3. Wire in main.ts, ROOT_HELP + HOOK_HELP in help.ts. No new exit codes or refusal families outside the hook module. 4. docs/claude-code-hook.md: settings.json snippet the human commits, timeout guidance, limits (best-effort classifier, not scheming-robust per SPEC 11; harness executes so no execution.* records; PostToolUse follow-up). 5. SPEC 14: harness hook is v1, Rust engine is its post-v1 accelerator (call out to human). 6. Tests: classifier fixture table, cli-hook.test.ts spawning the real CLI with a grant landing mid-wait, deny paths, dogfood test that every class key in the repo APPROVAL.md is emitted by some fixture. 7. Opus builds; fable reviews; npm test + lint.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Opus subagent build from the plan on this task; fable reviewed the diff, tightened two things, and ran the end-to-end probe. New: src/core/command-class.ts (pure classifier: tokenizer + data-driven COMMAND_RULES table, exports classifyCommand, isProtectedPath, CLASSIFIER_CLASSES, GATE_SELF_CLASS), src/cli/hook.ts ('hook claude-code' and 'hook classify', frozen HOOK_DENY_CODES), docs/claude-code-hook.md, tests/command-class.test.ts (116), tests/cli-hook.test.ts (25, real CLI spawns incl. grant landing mid-wait). Modified: main.ts dispatch, help.ts (HOOK_HELP + ROOT_HELP), tests/dogfood.test.ts (+2: every literal class in the repo APPROVAL.md is emitted by the rule table), SPEC.md.

SPEC.md EDIT, CALLED OUT FOR THE HUMAN: section 10.1 verb list gains 'hook claude-code' and 'hook classify'; section 13's Rust note now reads as the latency accelerator for this hook; section 14 M8 names the hook alongside the MCP wrapper. Roadmap and surface wording only, no normative behavior changed.

AC1 amended in practice: non-Bash tools pass through EXCEPT Edit/Write/MultiEdit/NotebookEdit whose file_path is a protected policy path (APPROVAL.md, .approval/, CLAUDE.md, .claude/settings*.json), which are gated as policy.edit. Leaving those ungated would have left the most sensitive files reachable by the tool agents use most.

Design decisions: (a) exit 0 with a hookSpecificOutput JSON for every classified/decided case, exit 2 only for a misconfigured hook (Claude Code treats 2 as block); no new exit code, EXIT_CODE_TABLE untouched. (b) Never 'ask': that would decide outside the log. (c) Fail closed everywhere: unclassified/opaque/unparseable, unloadable policy (hook-policy-unavailable), unreadable log (hook-io), any gate refusal (hook-gate-refused:<code>), timeout, rejected/revoked/expired all deny. (d) The harness executes, so no execution.* records are written; the log holds task.registered, approval.requested and the decision. PostToolUse follow-up could add execution evidence. (e) Idempotency key hook:<session_id>:<tool_use_id|random>:<class>, one envelope per tool call, one action per distinct gated class, payload {command, cwd} hashed with JCS and filed so channels display the real command. A retried tool call is a new tool_use_id and therefore a new request; a late grant on a timed-out request authorizes nothing (docs say so). (f) tool_input.description is never read (self-reported); the fixtures send a persuasive one to prove it. (g) The approval CLI itself (bare 'approval', root cli.js, dist/src/cli/main.js) is a documented pass-through, class gate.self; other cli.js paths are ordinary scripts. (h) Classes emitted beyond the repo policy: deps.install (bare npm install/ci), deps.remove, deps.upgrade, read.shell, read.vcs.remote; unknown classes resolve to defaults.autonomy, so bare 'npm install' is currently MANUAL under this repo's APPROVAL.md. APRV-83 should decide whether to add deps.install/files.delete.workspace to the policy. (i) Opaque set: bash/sh/zsh -c or script, eval, source, exec, sudo, env, xargs, node -e, python -c, perl -e, timeout/time/watch/nohup, backticks, arithmetic. $(...) is classified recursively and taints unless every inner segment is read.*, so gh pr create --body "$(cat <<EOF ...)" classifies as network.call rather than opaque.

Fable review changes: the poll loop now checks exactly the keys this invocation requested and allows only when every one is 'granted' (the original derived the key set from the log again, so an empty result would have read as nothing pending and allowed); gate.self for cli.js restricted to the repo-root wrapper; docs paragraph that promised a late grant could be reused corrected.

Global invariants touched (SPEC 11): enforcement reads only verified records (readVerifiedRecords in the poll); no caller timestamps; refusals machine-readable and distinct (HOOK_DENY_CODES); self-reported fields never reduce scrutiny; all writes go through register/request, no new log writer.

Not done here, human-owned: the .claude/settings.json hooks entry (policy.edit); docs/claude-code-hook.md has the snippet. Verified: npm test 1652/1652, oxlint clean, end-to-end probe against a scratch attested policy (autonomous allow with no log growth, unclassified deny, Write to APPROVAL.md gated, curl gated then allowed on grant, log verify clean).

Assigned to M8 at decomposition (2026-08-18) per its stated intended slot: the MCP wrapper (APRV-87) and this hook are the two harness-facing surfaces, and both should derive their verb knowledge from the APRV-85 instructions/schemas registry where they overlap (the class table here is its own thing; the request/wait semantics are shared). Sequenced after 85 and in parallel with 86/87: it does not need the SDK. It closes the gap that produced APRV-50 and that APRV-81 tripped again from prose alone.

Merged with main's M8 decomposition (m-11, dependency APRV-85, ordinal) on 2026-08-18. Built ahead of APRV-85: the hook's request/wait semantics call core/gate.ts and core/state.ts directly and do not read the instructions/schemas registry; if 85 lands a shared verb-knowledge layer, the hook can adopt it in a follow-up without changing its contract.
<!-- SECTION:NOTES:END -->
