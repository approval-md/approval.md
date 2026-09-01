---
id: APRV-151
title: >-
  A subagent Edit call wrote SPEC.md with no gate prompt: protected-path
  classification missed in an agent-created worktree
status: Done
assignee:
  - '@claude'
created_date: '2026-08-29 20:41'
updated_date: '2026-09-01 03:06'
labels:
  - security
  - hook
  - dogfood
  - bug
dependencies: []
priority: high
ordinal: 136000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed 2026-08-29 during the APRV-145 design landing. A subagent session working in the worktree .claude/worktrees/aprv-145-land (created with git worktree add from the primary) applied an Edit-tool change to SPEC.md — a protected path whose edits classify policy.edit and require a Telegram tap — and NO prompt was raised: the edit applied silently and was committed (since reverted; the same edit was then re-applied from the orchestrating session, where the hook classified it policy.edit and prompted normally, proving the path is protected for that session). The same evening, other subagent sessions in workflow-created worktrees DID have their SPEC.md Edit calls classified and gated (policy.edit timeouts recorded overnight), so the bypass is not simply "subagents are unhooked"; something about that session or worktree let a protected-path write through. Impact: the dogfood control on SPEC/policy edits can be silently bypassed by an agent session with the wrong (or missing) hook wiring, and nothing surfaces the gap — the edit does not even leave a refused-request record. Investigate: which sessions carry the PreToolUse hook for Edit/Write and why this one did not (settings inheritance in spawned sessions? worktree cwd at session start? hook matcher scope?); whether the hook can fail CLOSED for tool-call classes it never sees (a session-level doctor check, or a repo guard that detects protected-path diffs lacking a matching grant in the log); and whether a CI-side guard should verify that every SPEC.md/APPROVAL.md change reaching a PR has a corresponding policy.edit grant in the committed log window. The last idea turns the append-only log into the audit trail for exactly this bypass and fails the PR rather than trusting session wiring.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Root cause identified and recorded: why this session Edit call on SPEC.md was never classified while sibling sessions were
- [x] #2 A fail-closed detection exists for protected-path writes that bypassed classification (session doctor check, repo guard, or CI-side grant cross-check), tested
- [x] #3 The overnight bypass instance is reconstructed in the notes: which commit, which worktree, and the remediation that re-applied the edit through a granted policy.edit
- [x] #4 npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Evidence gathering: read src/cli/hook.ts (fileToolGate/tierOf/hookScope), src/core/command-class.ts (isProtectedPath), .claude/settings.json in HEAD + every worktree, and the primary log's hook-minted records grouped by session id, to establish whether the miss was misclassification or a hook that never ran.
2. Record the root cause in the notes with log-seq and settings evidence, plus the reconstruction of the overnight bypass (AC3).
3. Build the favored fail-closed layer: a CI-side grant cross-check. New pure core module src/core/protected-grant.ts maps VERIFIED records to the set of protected-path file edits a human actually granted (policy.edit file-tool grants only), and answers, for a list of changed repo-relative paths, which protected changes have no matching grant. Ambiguity resolves to unauthorized.
4. Thin runner scripts/protected-grant-guard.mjs (the classify-tier.mjs shape): git diff base...HEAD for changed paths, read the log from a git ref through the verified reader, print findings, exit non-zero on any unauthorized protected change.
5. Tests: tests/protected-grant.test.ts — logs built ONLY through the real append path (register/request/decide from core/gate.ts), covering granted, ungranted, denied, withdrawn, bash-only-grant, worktree-copy path matching, and the two real incident shapes (worktree SPEC.md, worktree .github/workflows/ci.yml); plus a spawn test of the runner.
6. Do NOT edit .github/workflows/ci.yml, .claude/settings.json or APPROVAL.md. Write the exact workflow job to add as a human-sign-off proposal in the notes.
7. npm test, npm run lint, commit on aprv-151-protected-path-worktree.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## Root cause (AC1)

The hook code is not at fault, and the miss is not a classification bug. Evidence, in order:

1. **The wiring is identical everywhere.** `.claude/settings.json` is TRACKED (added 2026-08-18, commit 83d09c1, its only commit). `git show HEAD:.claude/settings.json`, `git show 83d09c1:.claude/settings.json` and the primary's on-disk copy are byte-identical, and every `git worktree add` checkout therefore carries the same PreToolUse entry with matcher `Bash|Edit|Write|MultiEdit|NotebookEdit`. No worktree was ever missing the registration on disk.
2. **The classifier resolves worktree copies correctly.** `fileToolGate` (src/cli/hook.ts:886) runs `isProtectedPath` on the DECLARED path before any checkout resolution, and `isProtectedPath` (src/core/command-class.ts:174) is deliberately name-based, not location-based. `tierOf` (src/cli/hook.ts:809) then labels a file under `<primary>/.claude/worktrees/<name>/` `protected-path-proposal` and still classifies it `policy.edit`. Proven live, on both incident files: log seq 2534 registered `branch proposal (worktree aprv-145-build): Edit …/worktrees/aprv-145-build/SPEC.md`, and seq 2781 registered `branch proposal (worktree agent-a3f5d255372d43ac0): Edit …/worktrees/agent-a3f5d255372d43ac0/.github/workflows/ci.yml`. The exact two paths that 'bypassed' the gate are paths the runtime demonstrably gates.
3. **The bypassing sessions produced no records of any kind.** Grouping every `hook:<session>:<tool-use>` task id in the primary log by session shows that between 2026-08-26T23:13Z and 2026-08-30T20:09Z exactly ONE session appears: a6546960-9df2-4588-829c-4a1ee1231a51. Every gated `policy.edit` naming aprv-137-build, aprv-145-build and the other worktrees that evening carries THAT session id. So the task's premise that 'sibling sessions in other worktrees WERE gated' is a misreading of the log: those records are the orchestrating session editing files that live inside sibling worktrees, not sibling sessions being gated. There were no gated sibling sessions. The subagent sessions produced not one record — no Bash record either, not just no Edit record.

**Root cause: the enforcement path is entirely session-local, and a hook the harness never invokes is invisible to it.** The gate depends on Claude Code launching `approval hook claude-code` for that session; the spawned subagent sessions of 2026-08-29/30 did not, for the whole session and every tool, and a hook that never runs leaves no deny, no refused request and no session id in the log. Nothing in this runtime could have noticed, because every check it has runs inside the session whose wiring is the question. Two facts confirm the harness-side nature rather than anything in this repo: the settings file those sessions had on disk was correct, and spawned worktree-isolated sessions DO carry the hook today (this very session, 4c8f925f, is a spawned agent in .claude/worktrees/agent-a9de0a50bde9864f3 and its Bash calls are being classified — two `hook-opaque`/`hook-unclassified` denies were raised against it during this investigation). Whatever selects hook registration for a spawned session sits above this codebase; what this codebase can fix is the blindness, not the selection.

Secondary contributing fact, from docs/claude-code-hook.md's own install note: a hook whose binary cannot launch is a NON-BLOCKING error in Claude Code, so the tool call proceeds. Every 'hook did not run' cause, whatever its origin, therefore fails OPEN at the harness boundary, and nothing downstream records it.

## The fail-closed detection (AC2)

**Layer chosen: the CI-side grant cross-check**, which is the one the task author favoured, and the choice follows directly from the root cause. A session doctor check cannot work here: the party that would run it is the party whose wiring is in question, and the failure mode is precisely 'this session's hook never ran', which a check inside that session cannot report. `approval doctor`'s existing `harness-hook-outcomes` check (src/cli/doctor.ts:1445) already reads `.claude/settings.json` and would have answered 'correctly wired' on every incident worktree, because the file on disk WAS correct. So the question has to be asked from outside the session, over records the session did not write, about a diff it cannot retract.

Landed:

- `src/core/protected-grant.ts` — pure. Given changed repo-relative paths, VERIFIED records, `policy.protected_paths`, root hints and a window floor, it answers which protected-path changes no human granted. Three narrowings, all strict: only `approval.granted` counts (pending, rejected, withdrawn, expired authorize nothing); only FILE-TOOL grants count (a `policy.edit` minted from `git add SPEC.md && git commit` is a grant to run that command, and the bytes the human read were the command line, not the diff); a summary it cannot parse contributes nothing, so it can never widen the authorized set.
- Path anchoring, not suffix matching. A grant names an absolute path in whatever checkout minted it and a diff names a repo-relative one, so the checkout roots are derived from the log's own agent-worktree summaries (`<root>/.claude/worktrees/<name>/…` names its root exactly) rather than from the machine the guard runs on, which in CI is a different path entirely. A plain suffix rule would let a grant for `docs/SPEC.md` authorize a change to `SPEC.md`; that is fail-OPEN and is tested against.
- The grant WINDOW. Without it one historical grant for SPEC.md would authorize every future SPEC.md edit forever. The floor is the head of the log the branch itself carries, which is frozen at the commit the branch was cut from (the daemon writes the log only in the primary checkout), so only grants given after the branch existed can authorize what the branch changed.
- `scripts/protected-grant-guard.mjs` — the impure half, in the `scripts/classify-tier.mjs` shape. `git diff --name-only base...HEAD` for the change set; the log read from a git ref through `readVerifiedRecords` (enforcement reads only verified records), never the branch's own stale copy; `policy.protected_paths` unioned across BOTH sides of the diff so a PR cannot un-protect a file in the same PR that edits it. Exit 0 clean, 1 unauthorized, 2 could-not-establish — and 2 is a failure, deliberately. Every failure axis (unreadable git state, unreadable log, unanchorable path, missing policy) leaves the change UNAUTHORIZED.
- `tests/protected-grant.test.ts` — 19 tests, all logs built through the REAL append path (`appendAttestation`/`register`/`request`/`decide`/`withdraw` via tests/clock-adapters.ts), no fabricated records, every scenario asserted clean with `verify()`. Covers both incident shapes, the pending/rejected/withdrawn arms, the shell-grant arm, the docs/SPEC.md fail-open trap, the window, and the runner's three exit codes.
- docs/claude-code-hook.md gains the 'hook the harness never invokes leaves no trace' limit and a section on the guard.

### Verified against the real log, not just fixtures

- `--since-seq 2533 SPEC.md` → `granted SPEC.md — seq 2536 by human:carter (…/worktrees/aprv-145-build/SPEC.md)`, exit 0: the APRV-145 remediation is recognized as the authorization it was.
- `--since-seq 2780 .github/workflows/ci.yml` → `granted … seq 2787 by human:carter (…/worktrees/agent-a3f5d255372d43ac0/.github/workflows/ci.yml)`, exit 0.
- `--since-seq 2790 .github/workflows/ci.yml` → `UNAUTHORIZED`, exit 1: with the window moved past the grant, the same change is refused. That is the shape the guard would have shown on the night of the bypass, when no grant existed at all.
- On this branch, default mode: `no protected path changed`, exit 0.

## The overnight bypass, reconstructed (AC3)

**Instance 1 — SPEC.md, 2026-08-29.** A subagent session working in `.claude/worktrees/aprv-145-land` applied an Edit to SPEC.md with no prompt, during the APRV-145 landing. It was reverted. The remediation is commit **41d2c9f** (2026-08-29 19:05 local / 2026-08-30 02:05Z), 'APRV-145 AC2: the 11.2 registry names the counterpart's two refusals', whose own message says 'Landed through a granted policy.edit'; it re-applies the two SPEC.md lines from worktree `.claude/worktrees/aprv-145-build`, on branch `aprv-145-streak`, merged as PR #151 (merge commit 75cef01). The gate trail for the re-apply is complete in the log: seq 2534 `task.registered` (`branch proposal (worktree aprv-145-build): Edit …/aprv-145-build/SPEC.md`), 2535 `approval.requested`, **2536 `approval.granted` by human:carter at 02:03:57Z**, 2537 `execution.started` carrying `grant_seq: 2536`; the commit that carried it was separately gated at seq 2538–2541 (granted 02:05:31Z). The ungated original left NOTHING in the log — that absence is the finding.

**Instance 2 — .github/workflows/ci.yml, 2026-08-30** (task comment #1). A spawned Opus agent in `.claude/worktrees/agent-a3f5d255372d43ac0` edited the workflow with no prompt. Quarantined on branch `aprv-159-floor-shard` (commit 2dd92ed, 'APRV-159: shard the Node 20 floor leg'), and the orchestrating session then routed the change through the gate against the primary: seq 2781 `task.registered`, 2782 `approval.requested`, **2787 `approval.granted` by human:carter**, 2788 `execution.started`. Same shape, same remediation, three weeks of hook code exonerated in both.

**What the log says about the sessions themselves.** Between 2026-08-26T23:13Z and 2026-08-30T20:09Z the ONLY hook session id in the log is a6546960 (the orchestrator). Every gated `policy.edit` naming a sibling worktree that evening carries that id. The subagents that were live in aprv-145-land, aprv-145-build and aprv-137-build produced no records at all.

Comment #2's finding (the 22:32 APPROVAL.md write preceding its 22:37 grant) is a DIFFERENT defect — grant-follows-write ordering, APRV-117/150 adjacent — and is deliberately out of scope here; it is a complete-but-retroactive consent trail, not a missing one.

## Human-only follow-ups, NOT applied here (proposals for sign-off)

Both files below are protected and were deliberately left untouched, per the task's constraints.

**1. `.github/workflows/ci.yml` — add the guard job.** Proposed, to be added to `jobs:` and made a required check. It must run on every tier (it is not part of the tier matrix), needs `fetch-depth: 0` for the base ref, and needs the build because the guard imports from `dist/`:

```yaml
  protected-grants:
    # APRV-151: a protected-path change reaching a PR must carry a human's
    # policy.edit grant in the committed log. This is the ONLY check here that
    # does not trust the session that wrote the change.
    name: protected-path grants
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build
      - name: cross-check protected-path changes against the log
        env:
          BASE_REF: ${{ github.base_ref }}
        run: |
          set -euo pipefail
          if [ -n "${BASE_REF:-}" ]; then base="origin/$BASE_REF"; else base="origin/main"; fi
          node scripts/protected-grant-guard.mjs --base "$base"
```

Note for the human before wiring it: a protected-path edit a HUMAN makes by hand carries no grant either, so such a PR will fail this check. That is the correct fail-closed reading (this repository's own practice is already that SPEC and policy amendments 'land through the granted policy.edit'), but it is a workflow commitment and should be a conscious one. If an escape is wanted, the least-bad shape is a human-only `approval` record, not a commit-message trailer or a label, both of which the author of the change controls.

**2. `.claude/settings.json` — no change proposed, and that is the finding.** The registration was already correct on every incident worktree; adding entries would not have helped. The gap is above this repository (which sessions the harness registers hooks for), so the fix here is the external backstop, plus the docs note that a never-invoked hook is invisible.

## Validation (AC4)

- `npm test` (build + full suite, this worktree): **2461 tests, 2461 pass, 0 fail**. An earlier run showed two failures that were environmental, not caused by this change: `ci-guard` ENOENT on `node_modules/@modelcontextprotocol/sdk` (the worktree's node_modules was incomplete; `npm ci` fixed it) and one flaky `cli-setup` Telegram polling timing test. Both pass after `npm ci`.
- `npm run lint` (oxlint src tests): clean, no output.
- `node --test dist/tests/protected-grant.test.js`: 19/19 pass.
<!-- SECTION:NOTES:END -->

## Comments

<!-- COMMENTS:BEGIN -->
author: @claude
created: 2026-08-30 21:17
---
New data point (2026-08-30, APRV-159 build): a spawned Opus agent in an isolated worktree (.claude/worktrees/agent-a3f5d255372d43ac0) edited .github/workflows/ci.yml via the Edit tool and the protected-path hook did not fire — no prompt, no denial, only the security-guidance PostToolUse advisory. Same shape as the original SPEC.md incident: protected-path Edit hooks are not firing in spawned agent sessions. Remediation applied: the change is quarantined on branch aprv-159-floor-shard (not pushed); the orchestrating session is routing an explicit gate request against the primary checkout before the change moves anywhere.
---

author: @claude
created: 2026-08-30 23:08
---
Correction to my 22:32 comment (the APRV-159 data point stands; this one was mis-filed): the 2026-08-30 22:32 Edit to /Users/carter/dev/approval-md/APPROVAL.md from the orchestrating session was NOT a silent miss. The log shows the full trail: policy.edit registered seq 3057, approval.requested seq 3058, granted by human:carter seq 3064 (22:37), execution.started seq 3065 with grant_seq. The genuine anomaly is ORDERING: the Edit tool returned success and the file was on disk at ~22:32, five minutes before the grant landed (the session even observed the modified policy via a policy-not-attested refusal in between). So the write preceded its authorization; the consent trail is complete but retroactive. That is a different defect class (grant-follows-write carryover semantics, APRV-117/150 adjacent) and may deserve its own task rather than riding this one.
---
<!-- COMMENTS:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Root cause: not a classification bug and not worktree path anchoring. The harness settings file is tracked and byte-identical in HEAD, in commit 83d09c1 and in every worktree, and the hook classifies both incident files correctly inside worktrees (log seq 2534 gated the SPEC file under worktree aprv-145-build, seq 2781 gated the CI workflow under worktree agent-a3f5d255372d43ac0). The bypassing sessions produced NO hook records of any kind: between 2026-08-26T23:13Z and 2026-08-30T20:09Z the only session id in the log is the orchestrator's, and the reported 'gated sibling sessions' are that orchestrator editing files inside sibling worktrees. Enforcement is entirely session-local, so a hook the harness never invokes is invisible to the runtime, and Claude Code treats a hook that cannot launch as non-blocking, which fails open.

Fix: the backstop outside the session. A new pure core module plus a scripts runner cross-check every protected-path change in a PR diff against approval.granted policy.edit FILE-TOOL grants in the committed log, anchored on checkout roots derived from the log itself rather than suffix-matched, windowed at the branch point so a historical grant cannot authorize a future edit, with the policy protected-path list unioned across both sides of the diff. Every ambiguity (unreadable git state, unreadable log, unanchorable path, unparseable summary, missing policy, shell-only grant) resolves to UNAUTHORIZED.

Verified: 19 new tests, every log built through the real append path and verified clean, plus three replays against the real primary log — the APRV-145 remediation resolves to its grant at seq 2536, the APRV-159 CI remediation to seq 2787, and the same CI change with the window moved past the grant is refused with exit 1. npm test 2461 of 2461 pass; oxlint clean. The CI workflow file and the harness settings file were deliberately NOT edited; the workflow job to add is written out verbatim in the notes for human sign-off, and no settings change is proposed because the settings were already correct.
<!-- SECTION:FINAL_SUMMARY:END -->
