---
id: APRV-318
title: Reconcile GitHub issues PRs and merged branches for the compatibility wave
status: In Progress
assignee:
  - '@codex-astra'
created_date: '2026-09-08 22:40'
updated_date: '2026-09-17 01:58'
labels: []
dependencies: []
priority: high
type: chore
ordinal: 235000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Carter requested a coordinated remaining-work wave including repository cleanup. The live inventory has six open PRs, five open issues and 305 remote branch names. Reconcile obsolete work against actual main and preserve active quickstart/release work and daemon-owned records.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Every open PR and issue has a verified disposition or explicit remaining-work record; completed or superseded items are closed with evidence.
- [ ] #2 Only branches whose current exact tips are demonstrably merged and unowned are removed; active worktrees, unique commits and records delivery refs needed by the gate are preserved.
- [ ] #3 A durable inventory records kept and removed refs with commit IDs and reasons, and GitHub state is checked after changes.
- [ ] #4 Task changes pass records checks and are committed with Codex co-author attribution, pushed and delivered through the merge queue.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Inventory live PRs/issues/branches and worktree ownership from refreshed main. 2. Verify old log PRs as exact committed-log prefixes and old source PRs against replacement commits/tests. 3. Bind specific close/delete operations through the primary policy gate, without shared-history rewrites. 4. Remove only exact merged unowned branch tips, preserving active and unique work. 5. Record unresolved issues as pending tasks and publish reviewed inventory/closeout records.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Live inventory at main2e5fc18: six open PRs, five issues, 305 remote heads. Verified old log PRs281/282/283/285 are byte-exact prefixes (20921/20944/20975/20999 records) of committed main log; all four closed through primary gate, outcomes29977/29980/29983/29986. PR167 superseded by merged PR183 (73c9fea), final implementation693cf79; closed through gate outcome29974, unique alternative branch preserved. Only site PR289 remains open and is being resumed in isolated /private/tmp/approval-site-wave. Issue141 resolved on main, but exact close action is pending manual network.call grant (task codex-aprv-318-close-issue141). Branch inventory selects234 older merged inactive tips after preserving active worktrees including detached tips, recent tips, release/active-task delivery, policy/records refs and unique/unavailable commits. Scratch pre-push guard tests exit0 for approved deletion and exit1 for changed-tip/non-delete; deletion plan is hash-bound, each batch atomic, no force push, pending manual gate task codex-aprv-318-delete-branches. No refs deleted yet. Remaining issues140/139/138/137 mapped to pending APRV321/322/323/324, with249 identity design dependency where applicable.

Four exact merged inactive local branches were removed with git branch -d, each exit0: aprv-276-278-agentmail-release-stack@8246896ee499aecb2db8b721ee27d2b6ddcb6570, claude/rsi-demo-restyle-combined@ac90682cd0f0eba8d7801393021b6ba00a1562a7, demo-paper-restyle@4ef3f4377d92d2d54718c8fd90b6cffef337dab3, rsi-page@e359031290fcc66f53bd52f0ebd0da96c39b1e3e. No remote deletions yet. Durable exact-ref snapshot: docs/repository-reconciliation-2026-09-08.json; pending operations remain explicitly pending.

Reconciliation closeout by the closeouts lane, 2026-09-16.

AC1, dispositions as of today. Live read of the repository: one open pull request and three open issues.
- PR #405, opened 2026-09-17 by a parallel lane to land HANDOVER-2026-09-16.md. Out of wave: it did not exist at the 2026-09-08 snapshot, it is not a compatibility-wave artifact, and it is not this task's to dispose of.
- Issue #137 stays open, mapped to APRV-324. The design lands this wave as design/channel-sender-identity.md; the issue asks for grant attribution to the actual sender, which is implementation, so it closes when that ships and not when the design does. The issue's own AC3 in APRV-324 says the same thing.
- Issue #138 stays open, mapped to APRV-323. The design lands as design/multi-approver-semantics.md; quorum does not exist in the runtime today and the issue closes when it does.
- Issue #140 stays open, and it has two halves rather than one task. The release itself is APRV-307, where 0.2.0 is published and the remaining criterion is the operator's confirmation that no NPM_TOKEN secret exists; the supported exports surface the issue also asks for is APRV-321, unstarted. The 2026-09-08 snapshot mapped this issue to APRV-321 alone, which was accurate then and is half the picture now.
Resolved since the snapshot, so no longer needing a disposition: PR #289 merged, PR #379 merged at b44adfc9531102daaad9b64d1f7bf448e48a1fec, issue #141 closed through the gate at outcome seq 30367, issue #139 closed. The five pull requests the snapshot closed through the gate keep their recorded outcome seqs.
All of the above is written into the durable inventory as well, as an additive followups section dated 2026-09-16 in docs/repository-reconciliation-2026-09-08.json. Nothing in the 2026-09-08 arrays was edited; a snapshot that gets rewritten is not a snapshot.

AC2 and AC3, the 233-ref deletion. It still has not run. The two burned operations are recorded in the 2026-09-09 handover: execution start 30359 went indeterminate at 30360 with zero refs deleted, and the driver that ran it swallowed the diagnostic. This lane did not retry anything and deleted nothing; it built the driver the third attempt will use and proved out its read-only half.

New: scripts/reconcile-delete-merged-branches.mjs, with tests/reconcile-branch-deletion.test.ts. Shape, all of it chosen from what went wrong before.
- It never touches the hook configuration. It reads core.hooksPath, prints it, and treats a configured path whose directory is absent as a blocker. Passing an override to make the push go through would be switching off the repository's own pre-push checks to get a push through, which is the opposite of the point.
- It is hash-bound. Every candidate must still be at the tip the inventory recorded, proved by a fresh remote listing before the run and again immediately before each batch, and each delete additionally carries a per-ref lease naming the expected tip so the server itself refuses a ref that moved inside the remaining window. There is no blanket force flag, no -f and no plus refspec anywhere in the file.
- Any drift refuses the whole run rather than deleting the subset the driver still agrees with. A moved tip is new information about that branch and the answer to new information is a human reading it.
- Each batch is one atomic push, so a failure leaves a state describable in one sentence. Default batch size 50, so 233 refs is five batches.
- Two independent name checks, not one: the inventory's own disposition, and a refusal list this driver carries itself for main, master, gh-pages, HEAD and anything named records-log-. A protected name reaching it from the inventory is treated as an inventory bug and refused before the remote is contacted.
- The one branch the inventory marks deletable that is excluded by hand, claude/approval-signals-human-values-f0cf71, is named in the driver with its reason rather than left to whoever reads the JSON. 233 and 234 differ by exactly that name.
- A candidate checked out in any worktree of the repository blocks the run.

--plan is read-only and pushes nothing. --execute refuses unless the log shows an open execution.started for the action key it was given.

Deliberate divergence from the brief's wording, called out rather than quietly done. The brief asked that --execute refuse when APPROVAL_TOKEN or the run wrapper is absent. Reading APPROVAL_TOKEN from the environment would be theatre here and would in fact be backwards: approval run hands its child a scrubbed environment built by src/core/child-env.ts, which REMOVES every APPROVAL_-prefixed name outside the small non-secret allowlist precisely so a granted child cannot read the gate's credentials back out. A driver requiring that variable to be set would therefore refuse the real wrapper and accept anyone who exported the name by hand. What the driver requires instead is proof in the log that the wrapper started it: an execution.started record for the exact action key, with no terminal record after it, begun within a fifteen-minute window. execution.started is a gate-typed event that only approval run and approval execute append, and only after verifying a live token against a grant, so an agent cannot forge one without appending a gate-typed event to the committed log. Run the driver by hand and it exits 5 having contacted nothing. The window exists so a record from one of the two burned attempts cannot be replayed into authority for the third.

Verification, all from a clean worktree at merged main, nothing run against the primary and nothing deleted anywhere.
- node scripts/reconcile-delete-merged-branches.mjs --plan against the real origin: 356 heads, 233 candidates, 233 still at the exact tip the 2026-09-08 inventory recorded, 0 already gone, 0 drifted, five atomic batches. Eight days on, the inventory is still accurate to the ref.
- The same run surfaced a live blocker, and it is the same one that burned the second attempt. The primary's .git/config sets core.hooksPath to /Users/carter/dev/approval-md/hooks, and that directory does not exist. It is shared by every worktree of the repository. A third attempt made today would fail the same way the second did. This has to be resolved by hand before the gate cycle is worth opening.
- node scripts/run-tests.mjs --only reconcile-branch-deletion: 11 tests, 11 pass, 0 fail, exit 0. The cases are the bad days: no action key is exit 2, no open grant is exit 5 with the remote untouched, a missing log is exit 5, a moved tip blocks the whole run while still printing the manifest, main and a records-log- name are refused before the remote is contacted, a name like --force is refused as unsafe for a refspec, an absent hooks directory blocks and a present one does not, the setting is unchanged after the run, and the pushed argv is asserted element by element to carry a per-ref lease and no force flag or plus refspec. The good day runs against a throwaway bare remote and confirms every ref is still there afterwards.
- Guard suites ci-guard, classify-tier and docs-guard: 97/97, exit 0. Build, typecheck and lint each exit 0.

Runbook for Carter, APRV-318 deletion. This is the text for section 9 of private/runbook-2026-09-16.md, which currently says only that Lane 5 would leave a driver. Window: a terminal on the primary. Daemon: up.

Step 0, and it is a real blocker, not a formality. The primary's .git/config sets core.hooksPath to /Users/carter/dev/approval-md/hooks and that directory does not exist. That is the same condition that made the second attempt indeterminate on 2026-09-09. Decide what it should be (restore the directory, or remove the setting) before anything else; the driver reports it and refuses to override it, which is deliberate.

Step 1, read the manifest. Read-only, pushes nothing, contacts only the remote listing.
  cd /Users/carter/dev/approval-md
  node scripts/reconcile-delete-merged-branches.mjs --plan
Expect: 233 candidates, 233 still at the recorded tip, 0 drifted, five atomic batches of up to 50, and a blockers section. Exit 0 means no blockers; exit 1 with the manifest still printed means one of them stands. As of 2026-09-16 the only blocker is the hooks path above.

Step 2, the envelope. The action's class must resolve manual. Careful here: a raw remote deletion classifies vcs.push.main, which today's policy makes supervised-retro, so it would proceed with nobody asked. Declare a class the policy table does not list, for instance vcs.ref.delete.bulk, which fails closed to defaults.autonomy manual. est_cost_usd must be a STRING in the envelope; a number is refused as envelope-invalid. The payload binds the exact command, so write this to a file, with the action key you chose substituted in both places:
  {"argv":["node","scripts/reconcile-delete-merged-branches.mjs","--execute","--action-key","<key>"],"cwd":"/Users/carter/dev/approval-md"}
and put its hash on the action:
  approval payload hash <that file>

Step 3, the gate cycle, from the primary:
  approval register "backlog/tasks/aprv-318 - Reconcile-GitHub-issues-PRs-and-merged-branches-for-the-compatibility-wave.md" --as agent:<session>
  approval request APRV-318 --action "<key>" --as agent:<session> --payload <that file>
  approval wait APRV-318 --timeout 6h
The request lands on the phone with the class and the payload bytes. Tap Approve; the token is sealed to the requester.

Step 4, the deletion:
  approval run "<key>" --token <t> --as agent:<session> -- node scripts/reconcile-delete-merged-branches.mjs --execute --action-key <key>
Expect: a line naming the approval.granted and execution.started seqs, then five batch lines, then a post-check confirming none of the deleted refs are still on the remote. Any drift between batches stops the run and says exactly how many refs were deleted before it stopped. Do not retry blindly; re-run --plan and read it.

Step 5, paste the run's output into this task. That is what closes AC2 and AC3.

Policy observation for Carter, offered as a suggestion and not acted on. A bulk remote-ref deletion classifies vcs.push.main, which APPROVAL.md makes supervised-retro: it proceeds and is sampled afterwards. That is the right setting for landing a pull request and arguably the wrong one for destroying 233 refs, which is irreversible and which this task has twice tried to route through a human. The cost that prompts the suggestion is concrete: without a class that resolves manual, the driver would have had no grant record to check, and its whole authorization story would have collapsed to whether someone typed the command. Two ways to close it, both yours: a distinct class for ref deletion in the classifier and the policy, or a documented convention that deletions declare an unlisted class and ride the manual default, which is what the runbook above does today. No change was made to APPROVAL.md or to the classifier.

AC status after this lane. AC1 checked: every open pull request and issue now has a verified disposition or an explicit remaining-work record, in the task notes and in the inventory's followups section, and the items the snapshot closed keep their gate outcome seqs. AC2 and AC3 NOT checked: no remote ref has been deleted, so there is nothing yet to record as removed and no post-change GitHub state to check. They close on the runbook above, on Carter's grant. AC4 NOT checked: this lane's changes are committed on lane/closeouts and delivered by its pull request, and the criterion closes when that merges through the queue. One honest note on AC4's wording, which asks for Codex co-author attribution: that was written when the task was Codex's. These commits carry this session's own co-author trailer instead, because attributing them to Codex would be a false credit; the original Codex-authored commits keep theirs. Task stays In Progress.

Delivered in pull request #414 (lane/closeouts), auto-merge armed. One check is red and it is the records path rather than this work: the protected-path guard fails no-evidence on the two design documents delivered by APRV-323 and APRV-324 in the same pull request, because their writes classified policy.edit.design and proceeded, and the committed log stops at seq 37145 (2026-09-17T01:20:45Z) while the writes happened after that. The guard's policy-authorized tier accepts exactly those execution records once a log advance carries them. AC4 closes when this merges.
<!-- SECTION:NOTES:END -->
