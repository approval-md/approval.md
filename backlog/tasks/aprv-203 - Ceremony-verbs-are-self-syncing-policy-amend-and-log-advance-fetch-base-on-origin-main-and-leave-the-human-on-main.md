---
id: APRV-203
title: >-
  Ceremony verbs are self-syncing: policy amend and log advance fetch, base on
  origin/main, and leave the human on main
status: Done
assignee:
  - 'agent:opus-lane-h'
created_date: '2026-09-02 00:29'
updated_date: '2026-09-02 02:28'
labels:
  - dogfood
  - cli
dependencies: []
priority: high
ordinal: 167000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Today's two amend ceremonies (seq 7355 and 7413) and the advance between them each needed the human to run git fetch plus git reset --keep origin/main by hand first, and the second amend still went wrong: the amend verb commits on the branch you are standing on, so a primary checkout whose local main had not been synced produced a policy-amend branch stacked on the previous ceremony commit (without that ceremony's test pins), which failed CI until the orchestrator rebased it. The advance verb has the same shape (PRIMARY CHECKOUT ONLY, commits on the current branch, checks out nothing). A human running a ceremony should not need to know any of this. Outcome: the ceremony verbs own their own git preconditions. Before committing, amend and advance fetch the remote, refuse (machine-readable) if the live log or the policy file in the working tree diverges from origin/main in a way the verb cannot reconcile, base the ceremony commit on origin/main rather than on whatever the local branch holds, push by refspec as today, and leave the checkout exactly as they found it (on main, working tree untouched apart from the ceremony's own edit). Amend additionally runs the dogfood policy suite against the amended file before pushing and prints the expected pin diff when it fails, so a red ceremony PR is caught on the laptop rather than in CI. Why: the human's part of a ceremony is the decision and the tap; every git step they are asked to perform is a place for the gate to be blamed for a divergence it could have prevented.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 policy amend run from a primary checkout whose local main is behind or diverged from origin/main produces a policy-amend branch whose parent is origin/main, and leaves the checkout on the branch it started on with its working tree unchanged apart from the amended policy file; covered by a test against a scratch repo with a stale local main
- [x] #2 log advance fetches first and bases the records commit on origin/main when the local branch is behind; a diverged local main that cannot fast-forward is refused with a distinct machine-readable code that names the fix, and no commit is made
- [x] #3 policy amend runs the dogfood policy suite (or an equivalent in-process check of every declared class resolution) against the amended file before pushing; on failure it prints the expectation diff and exits non-zero without pushing, and --commit can be re-run after the pins are staged
- [x] #4 docs/dogfood-cutover.md and docs/cli-reference.md no longer instruct the human to fetch or reset before a ceremony; the runbook for a ceremony is edit, run the verb, tap
- [x] #5 npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. src/cli/git-scope.ts: give git() an optional env, and add the base-commit primitives both ceremonies need — fetchBase(root, remote, branch) -> {sha} | failure (git fetch <remote> <branch>, resolved through FETCH_HEAD), and commitOnBase(root, {base, paths, message}) which builds the commit WITHOUT a checkout: GIT_INDEX_FILE=<temp>, git read-tree <base>, git add -A -- <paths>, git write-tree, git commit-tree <tree> -p <base> -m <message>. The temp index is removed on every path; HEAD, the real index and the working tree are never touched.
2. src/core/policy-expectations.ts (new): move tests/dogfood.test.ts's EXPECTATIONS here as REPO_POLICY_EXPECTATIONS (adding the missing deps.install pin), plus checkPolicyExpectations(load, expectations) returning a machine-readable failure list (wrong autonomy/provenance, a floor applied, a literal declared class with no pin, a literal declared class the command classifier cannot emit) and expectationsFor(policyPath), which answers the repo's pins only when the policy's git root is the approval-md package itself. tests/dogfood.test.ts imports both, so the pins have one home.
3. src/cli/log-advance.ts: under the append lock, after the chain verify and the dirty-stage refusal, fetch the base branch and compare origin's committed log against the working log through compareChains. origin ahead => log-advance-behind-remote (run approval log sync first); forked => log-advance-remote-diverged; fetch failure => log-advance-fetch-failed. The seq range is computed against ORIGIN's blob. The commit is built with commitOnBase on origin's tip, anchored at refs/approval/advance/<records-branch> so a failed push loses nothing, and pushed by refspec <sha>:refs/heads/<records-branch>. Nothing is staged in the real index, no branch is checked out, HEAD does not move.
4. src/cli/amend.ts: extend the --commit precondition block (which already runs BEFORE the attestation) with fetch, base checks and the policy suite: fetch-failed, base-policy-diverged (origin's policy bytes are not the attested baseline this edit was made against), base-log-diverged (origin's log is not a prefix of the working log), policy-suite-failed (checkPolicyExpectations against the AMENDED file, printing the expectation diff). The branch-name collision check moves to refs/remotes/origin/<branch> as well as the local ref. After the attestation the commit is built with commitOnBase on the captured origin sha, anchored with git branch <policy-amend-seq> <sha> (a ref copy: HEAD does not move), and pushed by refspec. The direct flow pushes the same commit at origin's default branch and says the checkout is now behind by it. Narration through the APRV-167 progress seam names each phase (fetching, verifying the base, running the policy suite, building the commit on origin/main <sha>, pushing, opening the pull request); --json stays silent.
5. Help and docs: LOG_ADVANCE_HELP loses 'commits on the branch you are standing on' and gains the origin/main base plus the new codes; docs/cli-reference.md (log advance, policy amend) and docs/dogfood-cutover.md drop every fetch/reset instruction and state the ceremony as edit, run the verb, tap.
6. Tests: scratch-repo cases with a bare remote where local main is behind AND diverged from origin — the built commit's parent is origin/main, HEAD/index/working tree are byte-identical afterwards; advance's behind-remote and diverged-log refusals commit nothing; amend's policy-suite failure pushes nothing and re-runs cleanly once the pins match. Existing advance tests that assert the commit landed on local HEAD are rewritten against the pushed records branch.
7. npm run lint, npm run build, npm test; SPEC 10.1 and 11.2 replacement text drafted in the implementation notes (SPEC.md is not edited).
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What was built (APRV-203)

**The primitives.** `src/cli/git-scope.ts` gains `fetchBase(root, remote, branch)` (fetch, then resolve FETCH_HEAD to a sha) and `commitOnBase(root, {base, paths, message})`, which assembles a commit with NO checkout: a temporary `GIT_INDEX_FILE`, `git read-tree <base>`, `git add -A -- <paths>` from the working tree, `git write-tree`, `git commit-tree -p <base>`. HEAD, the operator's index and every working-tree file are untouched; the scratch index is removed on every path. `git()` gained an optional env parameter for exactly this. An identical base tree answers `unchanged` rather than inventing an empty commit.

**log advance.** Under the append lock it now fetches the base branch (`--base`, default the branch you are standing on), measures the seq range against ORIGIN's log blob rather than HEAD's, builds the records commit on origin's tip, anchors it at `refs/approval/advance/<records-branch>` so a rejected push loses nothing, and pushes `<sha>:refs/heads/<records-branch>`. Nothing is staged in the real index any more, so the checkout is byte-identical afterwards. Three new codes: `log-advance-fetch-failed`, `log-advance-behind-remote` (origin has records this log lacks: run `approval log sync`), `log-advance-remote-diverged` (two chains; a human decides). The pre-existing `log-advance-unverified` no longer carries the fork case, which now has its own code. A local branch ahead of origin is explicitly NOT a refusal, and the report/JSON gained `base: {branch, sha}`.

**policy amend.** The `--commit` precondition block (which already ran before the attestation) gained: the fetch, a check that origin's policy bytes ARE the attested baseline this edit was written against, a check that origin's log is a prefix of the working log, and the policy suite. Four new codes, all of them ending with nothing attested, committed or pushed: `fetch-failed`, `base-policy-diverged`, `base-log-diverged`, `policy-suite-failed`. The base sha is captured before the attestation and reused afterwards, so the commit cannot be parented on a tip nobody checked. The commit is then assembled on that base and pushed by refspec; the branch flow holds it on `policy-amend-<seq>` (a ref copy) and never checks out, so the human ends the ceremony on main with their policy edit still in the working tree.

**Decisions the orchestrator might overrule.**
1. *The direct flow still moves the branch when it can.* Where HEAD already equals the base (an up-to-date checkout, or a repository with no origin at all), the verb does what `git commit` did: `update-ref` on the branch plus `read-tree` on the real index, which leaves `git status` clean. Where HEAD is NOT the base, the branch is left alone and the narration says the checkout does not carry the commit yet and that `approval log sync` brings it down. Rewriting a working tree around a live log is the thing this verb never does.
2. *A repository with no `origin` is not refused.* It bases on HEAD and behaves as before. A shipped verb that only worked with a remote would be a regression for every local-only user.
3. *The pins live in `src/core/policy-expectations.ts` and are compiled in.* Re-running after a pin edit therefore needs `npm run build`, and the refusal runbook says so in as many words. The alternative (a JSON pins file read from the working tree at run time) removes that step but adds a new root-level data file and a second format; the task hinted at the shared module, so that is what shipped.
4. *The pins are scoped by package identity.* `expectationsFor(policyPath)` answers this repository's pins only when the nearest package.json above the policy names `approval-md`, and null everywhere else, where the ceremony simply runs no suite. A shipped CLI applying this repo's pins to a user's policy would refuse every amendment they made.
5. *`deps.install` and `vcs.pr.create` were added to the pins.* The shared check refuses a literal declared class that nothing pins, and `deps.install` was declared and unpinned; `vcs.pr.create` pins the `vcs.pr.*` namespace the way `read.web` pins `read.*`.

**Global invariants touched (SPEC §11).** *Refusals are machine-readable and distinct*: seven new codes, each naming its own fix, none reusing another's spelling. *The log is append-only*: the advance and the amendment now read origin's log blob and refuse anything that is not a prefix relation, so no ceremony can publish a commit that shortens or forks the committed chain; nothing here mutates `events.jsonl`. *Fail closed*: every new check refuses rather than reconciling, and every refusal on the amend path happens BEFORE the attestation, so a stopped ceremony leaves the policy edit as a working-tree change and nothing else. No enforcement path changed what it reads, no gate-typed event gained a caller timestamp, and no self-reported field was introduced.

## SPEC.md text drafted (NOT applied; SPEC.md is a protected path)

*§10.1, replacing the `log advance` paragraph:*

> `log advance` verifies the chain, refuses when any path other than the log, the queue projection and the payload store is staged, fetches the base branch, and builds its commit on the REMOTE's tip rather than on the local branch's: a scratch index is filled from that tree, the three paths are laid over it from the working tree, and the commit is parented on the remote and pushed to a records branch by refspec. It MUST NOT check anything out and MUST NOT move the operator's branch, index or working tree: a branch switch with an uncommitted log rewinds the log file underneath its appender, and a stale local tip produced records commits that reverted whatever the remote had merged since. A local branch carrying commits the remote does not have is not a refusal, since the commit is parented on the remote either way. A working log the remote's log is not a prefix of IS refused, in both directions, each with its own machine-readable code. (Amended APRV-203, pending sign-off.)

*§10.1, appended to the `policy amend` paragraph:*

> The ceremony owns its own git preconditions. It fetches the remote, refuses unless the remote's policy bytes are the attested baseline the edit was written against and the remote's log is a prefix of the working log, runs the policy's declared expectation set against the amended file where one exists, and only then attests. Each of those refusals is machine-readable, distinct, and reached before the attestation, so a stopped ceremony leaves the policy edit as a working-tree change and nothing else. The commit is assembled on the remote's tip without a checkout and pushed by refspec, so the human ends the ceremony on the branch they started on with the working tree they started with. (Amended APRV-203, pending sign-off.)

*§11.2, four rows for `gate_refusal_codes` (the amend ceremony's union):*

> | `fetch-failed` | The remote could not be fetched, so the ceremony has no base to build its commit on. Nothing is attested. A ceremony that guessed at the base is the failure this code exists to make impossible. |
> | `base-policy-diverged` | The remote's policy bytes are not the attested baseline this edit was written against, so somebody amended the policy after the edit began and committing would revert their amendment. Nothing is attested. |
> | `base-log-diverged` | The remote's log is not a prefix of the working log: either the remote carries records this checkout does not, or the two are separate chains. The amendment commit carries the log, and hash chains do not merge. Nothing is attested. |
> | `policy-suite-failed` | The amended policy does not resolve the way its declared expectation set pins it. The expectation diff is printed. Nothing is attested, committed or pushed. |

*§11.2, three rows for the log verbs' union:* `log-advance-fetch-failed`, `log-advance-behind-remote` and `log-advance-remote-diverged`, with the same wording as their CLI messages.

## Verification

`npm run lint` clean. `npm run build` clean. `npm test`: **2636 tests, 2635 pass, 1 fail**. The single failure is `every production dependency's engines.node admits the Node floor` (tests/ci-guard.test.ts), which reads `<repo root>/node_modules/<dep>/package.json`; this agent worktree has no `node_modules` of its own (resolution walks up to the primary checkout), so the read is ENOENT. It is a worktree artifact and not a TTL flake: it will pass in the primary checkout and in CI, where `npm ci` runs. No other test failed, and no test was skipped.

Orchestrator (2026-09-02): SPEC section 10.1 text applied verbatim under a policy.edit grant in PR #196; the drafted section 11.2 rows were NOT applied because the new codes (fetch-failed, base-policy-diverged, base-log-diverged, policy-suite-failed, log-advance-fetch-failed, log-advance-behind-remote, log-advance-remote-diverged) are CLI-level refusals outside the frozen gate_refusal_codes union that section 11.2 registers; they are documented in docs/cli-reference.md. Code merged in PR #195. Decisions 1-5 accepted as built.
<!-- SECTION:NOTES:END -->
