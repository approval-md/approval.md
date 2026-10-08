---
id: APRV-225
title: >-
  `approval log sync` refuses over untracked payload files that are
  byte-identical to the incoming commit
status: Done
assignee:
  - 'agent:opus-lane-t'
created_date: '2026-09-02 16:52'
updated_date: '2026-09-02 20:30'
labels:
  - daemon
  - dogfood
dependencies: []
priority: medium
ordinal: 181000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Seen 2026-09-02 after PR #226 (log advance to seq 11361) merged: `approval log sync` in the main checkout failed with `log-sync-git-failed`, because `git merge --ff-only FETCH_HEAD` refused to overwrite 33 untracked files under `.approval/payloads/` that the records advance had already committed. The verb restored the working log correctly, so only the fast-forward was blocked. The files are content-addressed (`<sha256>.json`, §9 payload store), and every one matched its name on both sides, so the local and incoming bytes were identical by construction and the only way forward was a hand step: move the untracked files aside, sync, build. Outcome: sync recognises this case and completes on its own. A payload whose bytes do NOT match its name, or differ from the incoming blob, is a different situation and must still refuse with its own code, since a payload is the material evidence an approval bound to.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Before the fast-forward, sync lists untracked files under `.approval/payloads/` that the incoming tree also carries; for each, it hashes the local bytes and refuses to proceed unless the hash equals the filename and equals the incoming blob
- [x] #2 When every such file is identical, sync completes the fast-forward without a hand step and reports how many payload files it reconciled; the local bytes are never deleted before the incoming blob has been confirmed identical
- [x] #3 A mismatching payload (name, local bytes, incoming blob disagree) refuses with a distinct machine-readable code that names the file, appends nothing, and leaves the working tree and the working log as they were
- [x] #4 Tests cover the identical case, the mismatch case, and a payload present locally but absent from the incoming tree (left alone)
- [x] #5 docs/dogfood-cutover.md or the log sync reference names the behaviour
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add a 'payloads' step to LOG_SYNC_STEPS, between 'ff-check' and 'merge': the fast-forward is known possible, the merge has not run.
2. In that step, list untracked non-ignored files under .approval/payloads/ (git ls-files --others --exclude-standard) and the incoming tree's files there (git ls-tree -r --name-only FETCH_HEAD). Intersect.
3. For each intersecting file: read the local bytes, read the incoming blob with showBlob (git cat-file semantics, never the git blob id, which is sha1 of a header+bytes and not the content address the store uses). Require sha256(local) == filename stem (the store writes canonical bytes, so the file is self-addressed; the {\"$ref\": …} reference form is the documented exception and is accepted on the byte-equality check alone) AND local bytes == incoming bytes.
4. Only after every file has passed, remove the local copies, remembering their bytes; then let the merge write them back. Any later abort re-places the removed bytes, so a refusal leaves the working tree as it was.
5. A failure refuses log-sync-payload-mismatch naming the file and the disagreement, appends nothing, restores log+queue snapshots and any removed payload.
6. A local payload absent from the incoming tree is not listed and is left alone.
7. Report payloadsReconciled in LogSyncReport, the --json shape, and the human table.
8. Tests in tests/cli-log-verbs.test.ts: identical, mismatch, absent-from-incoming, plus the injected-failure table guard updated.
9. Docs: docs/cli-reference.md log sync section and docs/dogfood-cutover.md.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented as a new step 'payloads' in the log sync ceremony (src/cli/log-sync.ts), placed between the fast-forward CHECK and the merge. Placement is the design: after ff-check the fast-forward is known possible, so removing a file the merge is about to write is a step towards a merge that WILL run; before merge because git merge --ff-only is what stops on untracked files.

What it does: git ls-files --others --exclude-standard -z over the store dir (payloadStoreDirFor(logPath), repo-relative via repoPath) intersected with git ls-tree -r --name-only -z FETCH_HEAD over the same path. --exclude-standard is deliberate: an ignored file is not one git refuses to overwrite, so including it would make sync stricter than the merge it is clearing the way for. -z on BOTH listings so quoted and unquoted spellings of an unusual name cannot silently fail to intersect.

Per file, two independent proofs, both before any byte moves: (1) SHA-256 of the local bytes equals the filename stem (storePayload writes RFC 8785 canonical bytes, so a payload file is self-addressed); the store's documented {\"\$ref\": …} form is the exception and rides on byte equality alone. (2) local bytes equal the incoming blob, read with showBlob (git show). Explicitly NOT git's blob id: that is SHA-1 over a header plus content, a different hash of a different thing, and comparing it to a SHA-256 content address would manufacture disagreements.

Two passes on purpose: every file is confirmed, then the removals happen. A mismatch in the last file cannot have deleted the first. Removed bytes are held in memory and restorePayloads() re-places them from abort(), so every failure path after the step leaves the working tree as found.

Refusal code chosen: log-sync-payload-mismatch (added to LOG_SYNC_REFUSAL_CODES, the help, and both docs). It maps to EXIT_IO via the existing refusalExit table, which is right: it is a filesystem fact, not a statement about the chain's integrity.

Report/CLI: LogSyncReport.payloadsReconciled; --json gains payloads:{reconciled:N}; the human table gains a payloads row.

Invariant paths touched: none of SPEC §11's global invariants change. Worth naming anyway, since the step deletes files: it appends nothing (no appendEvent on any path here, and the existing 'neither verb appends an event' test still passes), it never touches events.jsonl, and the delete-only-after-proof ordering is the fail-closed reading — an unprovable payload refuses rather than being cleared. No SPEC amendment needed: §9's payload store contract is unchanged, and §10.1's 'sync appends no event' still holds.

No new dependencies.

Verification evidence (node --test against the built CLI, real git topologies with a bare remote and a peer clone; no gate verb ever run against this worktree's own .approval):

- tests/cli-log-verbs.test.ts, 38/38 pass. New cases: 'an untracked payload the incoming commit also carries is reconciled, not refused' (AC1/AC2 — payloadsReconciled 1, pulled 1, bytes identical after, file now tracked, log bytes and head seq unchanged); 'a payload whose bytes disagree with the incoming commit refuses and touches nothing' (AC3 — code log-sync-payload-mismatch, step 'payloads', message names the file, HEAD unmoved, local bytes untouched, log unchanged, no snapshot left); 'an untracked payload the incoming commit does not carry is left alone' (AC4 — payloadsReconciled 0, bytes unchanged, still ?? in git status); 'a file in the payload store that is not named by a hash is refused, not cleared'; '--json reports the payload count'. Payloads are written through storePayload (the real store write), so the filenames are real content addresses over real canonical bytes.
- The injected-failure table now covers the new step: 'a failure before payloads restores the working log exactly' passes alongside the other seven, and the guard-on-the-guard assertion lists 'payloads' in order.
- cli-long-help + cli-help: 70/70 with cli-log-verbs. The first pass of the help text broke cli-long-help's 25-line cap (LOG_SYNC_HELP hit 27); trimmed to one sentence plus the new refusal code, reasoning left in docs/cli-reference.md as that test directs.
- npm run lint (oxlint src tests): clean.

Pre-existing, unrelated failure: tests/ci-guard.test.ts 'every production dependency's engines.node admits the Node floor' fails with ENOENT on node_modules/@modelcontextprotocol/sdk/package.json. This worktree has no node_modules of its own (imports resolve by walking up to the primary checkout's), and the test reads a path under its own REPO_ROOT. Confirmed pre-existing by checking out the base commit's source and re-running: 27/28 there too. Nothing to do with this change.

Correction to the verification note above, and the full-suite numbers as actually recorded.

The completed full run (npm test, exit 1) finished: tests 2989, pass 2986, fail 2, skipped 1. Both failures are unrelated to this change, but the run was NOT clean and an earlier reading of it as 3004/3003/fail 0 was wrong.

1. ci-guard.test.ts 'every production dependency engines.node admits the Node floor' — ENOENT on node_modules/@modelcontextprotocol/sdk/package.json. This worktree has no node_modules of its own (imports resolve by walking up to the primary checkout); the test reads a path under its own REPO_ROOT. Confirmed pre-existing by checking out the base commit source and re-running: 27/28 there too.
2. telegram-tap-latency.test.ts — failed at file level (19.2s) under full-suite load. It passes 5/5 in isolation, three times in a row. Its assertions are latency bounds (ack within 300 ms on a 10k-record log; the decision path is not linear in log length), so it is load-sensitive on a busy machine rather than broken. It passed in the earlier full run and failed in the later one with no change to any path it touches.

The two runs totals reconcile exactly, which is the check that the second failure is a file-level abort rather than lost coverage: run 1 was 2992 total with telegram-tap-latency 5 subtests counted; run 2 is 2989, being -5 subtests +1 file-level failure +1 newly added log-verbs test.

Targeted evidence for this change, all green after the final build: cli-log-verbs 38/38; cli-help + cli-long-help 70/70; and the six other suites that name log sync (cli-doctor, command-class, cli-instructions, log, cli-amend, sealed-delivery) 482/482. oxlint clean.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
approval log sync reconciles untracked payload files the incoming records commit already carries: each is proven twice (SHA-256 of the bytes equals the filename stem; bytes equal the incoming blob via git show) before any removal, then the fast-forward completes and the count is reported; a mismatch refuses with log-sync-payload-mismatch naming the file, appends nothing and leaves the tree as found. Verified by cli-log-verbs 38/38 (identical, mismatch, absent-from-incoming, not-a-hash, json count), help suites 70/70, lint clean; the full-suite failures were environmental (ci-guard node_modules path, telegram-tap-latency under load), recorded in the notes; merged in PR #238.
<!-- SECTION:FINAL_SUMMARY:END -->
