---
id: APRV-325.2
title: Implement a policy-bound typed Codex workspace change broker
status: Done
assignee:
  - '@opus-lane-codex-broker'
created_date: '2026-09-09 07:39'
updated_date: '2026-09-17 00:50'
labels: []
dependencies:
  - APRV-325.1
  - APRV-317
references:
  - docs/codex-boundary-probe.md
parent_task_id: APRV-325
priority: high
type: feature
ordinal: 244000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Make the canonical workspace writable only through a distinct narrow broker that computes operation classification and applies attested APPROVAL.md. This follows preparation/diagnostics and is not a flag on the broad MCP server.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Caller input cannot override actor, policy, log, workspace root, class, reversibility, credentials or sandbox posture; server enforces a positive tool allowlist.
- [x] #2 Exact change payloads include stable identity and verified preimages; create/replace/delete/move targets and patch source/destination paths are canonicalized and checked for traversal, symlink, hardlink, protected-path and concurrent-edit attacks.
- [x] #3 Policy determines autonomy without fabricated human grants; manual/live decisions use genuine gate authority, and changed payloads, duplicate execution, replay, unavailable logs and attestation drift refuse before unauthorized writes.
- [x] #4 Crash and partial-write behavior preserves evidence and reports indeterminate outcomes honestly; broker runtime, policy, log and launcher remain outside agent write custody.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Broker core (src/codex/broker.ts). Installation-owned context ONLY: actor agent:codex-<instance_id>, workspace root, policy path, log path, schema dir all read from the validated codex-instance manifest; the caller supplies operations and an expected policy digest and nothing else. Read the policy file ONCE, hash those exact bytes, checkAttestation against verified records, and refuse attestation-drift when the caller's expected digest differs. Feed the planner (planWorkspaceProposal) as intake; reuse its traversal/symlink/hardlink/alias/human-only refusals rather than duplicating them.
2. Action legs. One registered action per distinct protected/path class the planner returned, never collapsed: deterministic action key codex-workspace:<instance>:<payload_hash>:<class>, all legs reversible:false and bound to the one plan payload hash, registered through core/gate.ts register() under a deterministic task id. A second apply of the same bytes is refused by the gate's own task-already-registered/already-executed, which is the replay defence.
3. Authorization before custody. request() every leg through the real gate; manual legs need a genuine token (--token <class>=<value>), supervised/autonomous legs proceed on policy. ALL legs must be authorized before any write; a refusal on leg n stops the whole apply with nothing mutated.
4. Start-all-before-any-write. startExecution() every leg; if a later start refuses, close the already-started legs execution.failed (no filesystem effect at all) and refuse. Revalidate the plan (revalidateWorkspacePlan) after the last start and immediately before the transaction, so drift between authorization and custody refuses.
5. Durable transaction (src/codex/workspace-commit.ts). Take an OS-exclusive lock (O_CREAT|O_EXCL) on the workspace; write a journal file with the plan payload hash, every endpoint and both images; stage preimages and new bytes on the SAME filesystem, fsync files and parent directories, then rename into place in a fixed order; fsync and remove the journal last. Recovery reads the journal and only completes a proven all-after state or restores a proven all-before state; a mixed or unreadable state is reported, never guessed.
6. Honest outcomes. All-after -> finishExecution(0) on every leg. Proven all-before -> finishExecution(non-zero) with a reason. Mixed/unreadable -> indeterminateExecution with a NEW reason workspace-commit-unknown (schema/event.schema.json enum + SPEC.md §8 enum-versioning sentence: a schema and SPEC amendment, called out for Carter).
7. Surface. approval codex apply (CLI verb, human_only in the verb registry so the broad MCP catalog never publishes it) plus the reserved approval codex serve implemented as a NARROW shim publishing exactly one tool with a positive allowlist and no path/identity/class arguments. No flag on src/mcp/server.ts.
8. Adversarial tests (tests/codex-broker.test.ts, tests/cli-codex-apply.test.ts): caller override attempts, unattested and drifted policy, human-only class, missing grant, forged token, duplicate execution, replay of a stale plan, unavailable log, traversal/symlink/hardlink, concurrent edit between authorization and commit, lock contention, and crash recovery from a journal at each stage.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Sol read-only design completed. Reuse parseApplyPatch/protectedPathClass but not caller-cwd classification as custody proof. POSIX multi-file rename is not atomic, so durable recovery and OS-excluded writers are required. Current indeterminate reason union only act-threw needs a truthful workspace-commit-unknown amendment before crash implementation. Task remains To Do with dependencies; no broker implementation or enforcement claim.

Implemented the executable broker on the merged read-only planner (APRV-325.2.1), in three new modules plus a CLI family.

src/codex/workspace-commit.ts is the durable transaction. Custody is an O_CREAT|O_EXCL lock plus a POSIX ownership/mode question about the workspace root and every touched parent; it reports os-exclusive only when both hold, advisory otherwise, and ALWAYS reports acl-unproven, matching codex/trust.ts's existing honesty. --require-exclusive-custody turns the weak answer into a refusal rather than a footnote, which is the 'honest refusal where the platform does not allow it' half of AC. Staging writes new bytes and preimages to a same-filesystem directory inside the workspace (reserved names .approval-codex-txn and .approval-codex-lock, refused as proposal endpoints BEFORE the planner reads a preimage), fsyncs each file and the directory, then writes and fsyncs a journal naming the before-state and after-state digest of every endpoint, and only then applies. The outcome is taken from READING the workspace back against the journal, never from what the applying code believed: a rename that returned zero and a rename whose effect a crash lost are indistinguishable from inside the calling process. A failed apply attempts rollback from the staged preimages and is then read; the classification does not depend on what the rollback thinks it achieved. recoverWorkspaceCommit reports before/after/mixed and CHANGES NOTHING, because rolling a mixed workspace forward would guess which half the human approved and rolling it back would delete the half that committed.

src/codex/broker.ts is the orchestration. Fixed installation context comes from the validated instance manifest only (actor agent:codex-<instance_id>, workspace root, policy path, log path); parseBrokerInput accepts exactly {operations, expected_policy_sha256} and refuses an unknown key rather than dropping it. Order: verified log read, single policy read with those exact bytes hashed and attested, expected-digest comparison, plan, reserved-path scan, no-op refusal, register one action per distinct class (never collapsed) under a task id derived from the payload hash, authorize every leg, start EVERY leg, take custody, revalidate UNDER custody, commit, read back, close every leg. Revalidation deliberately follows the lock: a revalidation before the lock proves only what was true before another writer could act. A later leg refusing to start closes the earlier ones execution.failed and performs no filesystem operation at all.

src/codex/serve.ts is the strict server: a literal one-tool catalog checked at call time as well as at list time, with no identity, path, class, token or sandbox argument in the published schema because none was ever published. It is deliberately NOT a flag on src/mcp/server.ts, whose catalog is derived from the verb registry and therefore grows. Grant tokens are absent from what that server may forward: the manual path works through sealed delivery (SPEC §10.4), so the human grants and core/execute.ts opens the token at the start.

SPEC §11.1 invariants touched, and how. Invariant 1 (enforcement reads only verified records): every decision comes from readVerifiedRecords; grantOpen is an early-refusal HINT over those same verified records and admits nothing, the real token check stays in core/execute.ts. Invariant 2 (gate-typed events never accept caller timestamps): no broker function takes a ts; determinism in tests is by injected clock. Invariant 4 (self-reported fields never reduce scrutiny): the caller's expected_policy_sha256 can only cause a refusal, never a relaxation, and classes are derived from the policy's protected_paths rather than declared; every leg is reversible:false, so a nonmanual route needs the operator's own APRV-317 allow_irreversible. Invariant 5 (compare-and-append): every append goes through gate.ts/execute.ts, which already hold it; the broker adds no append path of its own. Invariant 6 (machine-readable distinct refusals): BROKER_REFUSAL_CODES is a frozen 22-member union pinned by tests/codex-broker.test.ts. Invariant 9 (human-only inert to agents): a human-only class refuses in the planner before any preimage read, and no leg is registered.

SPEC and schema amendments, for Carter: schema/event.schema.json adds workspace-commit-unknown to execution.indeterminate's closed reason enum, and SPEC.md §8's enum-versioning paragraph gains the corresponding sentence plus the requirement that an implementation writing it retain a durable out-of-log record of the two states and resolve nothing from it. Marked '(Amended APRV-325.2, pending sign-off.)'. src/core/execute.ts's INDETERMINATE_REASONS widens to match. No other SPEC section changed. NOT changed, deliberately: schema/codex-instance.schema.json still pins components.broker to required-not-shipped, and codex doctor --strict still reports broker-not-ready and runner-not-ready. Flipping that is APRV-325.3's, when the whole thing is ready; the broker shipping as code does not make an installation enforced.

Validation on this head (worktree, Node v26.8.2). Build exit 0, typecheck exit 0, lint exit 0 with zero warnings. Targeted suites, all exit 0: codex-broker + cli-codex-apply + cli-long-help + cli-help + cli-instructions + cli-doctor-codex + codex-doctor + codex-manifest + codex-project-config + mcp-server + layering + execute + conformance + event-schema + docs-guard = 243 tests, 243 pass, 0 fail (/tmp/lane4a7.log); cli + cli-run + cli-resolve + cli-execution-dangling + gate + human-only + concurrency + state + audit + adapters-contract + cli-status + validate + log = 378 tests, 378 pass, 0 fail (/tmp/lane4a8.log). npm run conformance exit 0: 300 vectors, 0 failures, 145 controls.

One test does NOT pass in this worktree and is environmental, reported as a failure rather than explained away: tests/codex-package.test.ts 'packed npm artifact installs without scripts and runs outside the checkout' throws ENOENT on node_modules/yaml/package.json. This worktree has no node_modules at all (Node resolves the dependencies from the parent checkout by walking up), and that test reads a dependency path literally relative to the repository root. It is unrelated to this diff and is CI's to verify on a full checkout.

New adversarial coverage, by acceptance criterion. AC1: the frozen 22-code union; the positive one-name allowlist refusing approval_run, run, case variants and a trailing space with nothing registered and nothing written; nine caller-supplied authority keys (actor, root, policy, log, class, reversible, token, sandbox, as) each refused by name; brokerInstallation deriving actor, root, policy and log from a manifest alone; the strict server's published schema asserted to carry exactly two properties and none of nine forbidden ones. AC2: one autonomous proposal producing exactly its effect with two separate class legs bound to one payload hash; a human-only class refused before any preimage with the file unchanged; traversal, absolute path, symlink and hardlinked preimage each refused with the planner's own code and nothing touched; both reserved transaction paths refused; a no-op replace refused; a preimage digest mismatch refused. AC3: unattested policy, policy edited after attestation (hash-mismatch), caller digest drift, a corrupt log, a manual class with no token (request recorded, nothing executed, pending key named), a genuine grant executing exactly once with the byte-identical replay refused and the file written once, a forged token refused with the file unchanged, and a mixed-class proposal where one ungranted leg blocks the granted one. AC4: a concurrent edit between the last start and the commit refused under custody with the started leg closed failed; a held lock refused custody-contended; required-exclusive custody refused on a world-writable root; acl-unproven always present; a crash between two renames recording execution.indeterminate with reason workspace-commit-unknown and exit_code null on every leg, with the half-applied tree left alone, the journal and lock retained, the next brokered change failing closed, and recover reporting mixed and changing nothing; a failure whose rollback proves the before-state recorded as execution.failed rather than indeterminate; a later leg refusing to start leaving both endpoints absent. Every scenario that touches the log ends with a chain verification.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The canonical Codex workspace is now writable only through a narrow broker that derives its actor, root, policy and log from the installation manifest and accepts nothing else from a caller. One action is registered per distinct path class and never collapsed, policy decides autonomy with a manual class needing a genuine grant, every leg starts before any byte moves, and the change is staged, journaled and applied under a workspace lock. The outcome recorded is what reading the workspace back proved: completed, failed, or execution.indeterminate with the new workspace-commit-unknown reason, whose journal and lock are retained for a person and which nothing here resolves. Verified by 30 adversarial broker tests and 9 CLI tests over a scratch instance, inside 243 passing targeted tests plus a 378-test core regression sweep and 300 conformance vectors, all exit 0. This gates workspace WRITES; it confines no shell, and APRV-325.3 still owns the end-to-end enforcement evidence.
<!-- SECTION:FINAL_SUMMARY:END -->
