---
id: APRV-219
title: >-
  Log anchoring verification: refuse a working log whose prefix diverges from
  the last committed records anchor, and fix the doctor's log-drift row
status: In Progress
assignee:
  - 'agent:opus-lane-v'
created_date: '2026-09-02 16:26'
updated_date: '2026-09-02 19:30'
labels:
  - core
  - log
  - doctor
dependencies: []
references:
  - APRV-217
  - APRV-210
  - APRV-204
  - APRV-125
  - docs/proposals/incremental-prefix-proof.md
priority: high
type: enhancement
ordinal: 181000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
An unkeyed hash chain means a process with write access to .approval/log/events.jsonl can truncate the log and recompute a self-consistent chain that passes a cold walk (the argument in docs/proposals/incremental-prefix-proof.md §3). The one witness the same-user process cannot rewrite is the log already committed to a records branch on GitHub by the advance cadence (APRV-204) and log sync (APRV-125), behind a protected main. Today nothing compares the working log against that anchor except the doctor's log-drift row, which APRV-210 records as misreading the checkout. Build the check as a first-class verification: approval log verify --anchor (default: the newest committed copy of the log reachable from origin/main and refs/approval/advance/*, the same revs cli/log-advance.ts publishedState already resolves) reads the anchored prefix's byte length and head (seq, hash), and refuses with a distinct machine-readable code (proposed anchor-diverged) when the working log's bytes up to that length do not hash to the anchor's or its record at that seq does not carry the anchor's hash. The daemon runs the same check on every full re-proof under APRV-217's cadence and on startup, reporting a fatal outcome (the log is not fit to append to) exactly as log-corrupt is today. approval doctor's log-drift row becomes this check's result (fixes the APRV-210 misread by construction). Anchor lookup is git read-only (git show of the blob at the rev), never a fetch, and its absence (no records branch yet, no git) is a skip with a reason, never a pass. Nothing here writes the log or the anchor.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 approval log verify --anchor refuses with anchor-diverged when the working log's prefix does not match the newest committed anchor (byte digest and head seq/hash), and passes when it does; both proved through the real append path plus a git fixture repo
- [x] #2 A missing anchor (no records branch, no git, detached) is reported as a skip with a reason and never as a pass
- [x] #3 The daemon runs the anchor check at startup and on each full re-proof; divergence stops the daemon with a distinct outcome, and the tick/started lines name the anchor in use
- [x] #4 approval doctor's log-drift row is this check's result and no longer misreads the checkout (APRV-210's two reproductions pass)
- [ ] #5 The refusal code joins the pinned code union (SPEC §11.1 inv. 6); SPEC.md §9 or §11 gains the anchoring sentence via a gated edit
- [ ] #6 docs/cli-reference.md and docs/git-evidence.md updated; npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. New module src/cli/log-anchor.ts: ANCHOR_REFUSAL_CODES (closed union, anchor-diverged), anchorRevs() reused from log-advance's publishedState rev resolution, resolveAnchor() (git show of the blob at each rev, newest = highest clean head seq), checkLogAnchor({logPath, records, rev?}) returning pass | skip(reason) | refused(anchor-diverged). Byte-prefix digest + the working record at the anchor head seq carrying the anchor hash. Read-only git, never a fetch, never a write.
2. Export the rev list from src/cli/log-advance.ts (anchorRevs) and have publishedState use it, so one resolution serves both.
3. approval log verify --anchor / --anchor-rev <rev> in src/cli/main.ts: runs after the chain verdict on a clean log, prints the anchor in use, refuses anchor-diverged at EXIT_INTEGRITY, --json carries the anchor block.
4. Daemon: anchor check at startup and on every tick whose reads took a full re-proof; DaemonOutcome gains kind anchor-diverged (EXIT_INTEGRITY, like log-corrupt); started/tick lines name the anchor rev and seq.
5. Doctor: checkLogDrift becomes the anchor check's result, takes verified.records, resolves the repo-relative path realpath-safe via git-scope; no HEAD:<absolute> spec ever built.
6. Conformance: anchor_refusal_codes joins tests/conformance-harness.ts UNIONS and scripts/regen-conformance-vectors.mjs; regenerate vectors (refusal-unions 7.0.0) and the manifest the documented way.
7. Tests: tests/log-anchor.test.ts (real git fixtures with a bare remote, records through appendAttestation), daemon and doctor coverage; docs/cli-reference.md + docs/git-evidence.md.
8. Draft the SPEC sentence and the union row for the orchestrator in the notes; do not edit SPEC.md.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
BUILT (branch aprv-219-log-anchor, commits e31c5f6 / 038eb3b / 4f4e2fa / 08438ca / c2be554).

WHAT WAS BUILT. src/cli/log-anchor.ts is the whole check. anchorRevs() is the rev resolution lifted out of log-advance's publishedState so both read one list (refs/approval/advance/*, refs/remotes/<remote>/<base>, refs/remotes/<remote>/records-log-<today>, HEAD). resolveAnchor() picks the copy reaching the highest clean head, not the newest commit: the question is how much of the log somebody else already holds. checkLogAnchor() compares (1) the working log's first N bytes against the anchored copy's SHA-256, N being the anchored byte length, and (2) the working record at the anchored head seq against the anchored hash. Both are stated even though (2) follows from (1), because (2) is the fact a human reads.

Four outcomes, one refusal. pass / behind / skip / diverged. 'behind' is its own outcome and NOT a refusal: a working log that is a strict byte prefix of the anchored copy is the ordinary state of a checkout that just pulled, so it is a doctor pass with the sync repair and a daemon warning (new DAEMON_WARNING_CODES entry anchor-behind), never a stop. Only a contradiction refuses. A missing anchor is a skip whose reason names every rev tried; there is no path through the module that reports silence as a pass.

DAEMON. The anchor is RESOLVED at startup (two git reads, no log read) so the started line can name the rev and seq this run holds itself to, and COMPARED on every tick whose reads re-proved the prefix in full - the first tick always (cold walk), every tick under read_proof: full, the re-proof cadence under incremental. DaemonOutcome gains kind anchor-diverged at EXIT_INTEGRITY, distinct from log-corrupt on purpose: one means the file contradicts itself, the other that it contradicts the record of it. tick.anchor is additive and absent on a tick that compared nothing.

COST. A blob cache keyed by git object id (content-addressed, so it cannot describe the wrong file and is safe across repositories) keeps the anchored copy's digest, head and bytes, so the per-tick cost under read_proof: full is one git rev-parse per candidate rev, not a chain walk of the committed log. The walk happens once per distinct blob. Cache limit 8, cleared wholesale; forgetAnchorBlobs() is exported for tests.

INVARIANT PATHS TOUCHED (SPEC §11.1). inv. 1, enforcement paths read only verified records: the check takes the caller's ALREADY-VERIFIED working records rather than walking the chain itself, and refuses to treat a committed copy that does not verify as an anchor (it becomes a named skip). inv. 6, refusals machine-readable and distinct: anchor-diverged is a new closed union rather than a code smuggled into an existing one - see AC5 below. Nothing here writes the log, a ref, or any file; git is read with rev-parse and show and never fetched.

APRV-210 IS FIXED BY CONSTRUCTION for its first reproduction, and the root cause turned out to be shared. git-scope.repoPath() now resolves realpath on BOTH sides. git rev-parse --show-toplevel prints the physical path, so a checkout reached through a symlinked spelling gave relative() a root and a path in different spellings of one place; the result climbed out of the repository, git had no blob at HEAD:<that>, and the caller concluded the log had never been committed. The SAME repoPath call is inside publishedHeadAt, which is why the cadence row counted every record as unpublished on the same day: one bug, two rows.

TESTS. tests/log-anchor.test.ts, 23 cases on real git topologies (bare remote, peer clone, an advance anchor ref, a symlinked checkout). Records come from appendAttestation; the forgeries are built the way a forger builds one - truncate, re-append through the same real path - so the file walks clean from genesis and disagrees with the committed copy. Covered: pass/byte-identical/ahead, truncate-and-recompute, truncation below the anchor, a same-record-hash byte rewrite inside the prefix, behind vs diverged, --anchor-rev, newest-copy-wins across refs/approval/advance/*, three skip paths, the CLI's exits and JSON, that --anchor writes nothing, the daemon's three lines and its outcome, and both APRV-210 reproductions.

DOCS. cli-reference gains a --anchor section under log verify (what is compared, rev order, the four outcomes with exit codes, JSON). git-evidence gains 'Reading the evidence back' - that page was entirely about writing a second record and said nothing about reading one back.

DEVIATION WORTH REVIEW. The doctor's log-drift row no longer calls compareChains directly; it calls checkLogAnchor, which calls compareChains on the refusal path only (to name the divergent seq in log-reconcile's own words). tests/cli-log-verbs.test.ts's structural pin was updated to assert the new shape rather than deleted.

AC5, FOR THE ORCHESTRATOR TO APPLY UNDER A GRANT. SPEC.md is protected; this agent did not edit it. Two changes, both to §11.1 invariant 6 plus one new sentence.

(1) THE UNION ROW. Invariant 6 currently reads: '6. **Refusals are machine-readable and distinct, and every code union is pinned by a test.** Each refusal path returns its own stable code, and the unions are frozen public API (`tests/gate.test.ts`, `tests/token.test.ts`, `tests/execute.test.ts`, `tests/log.test.ts`, and for the open window's verbs `tests/gate-window.test.ts`). (Amended APRV-214, pending sign-off.)'

Replace the parenthesised file list's closing so it reads: '... and the unions are frozen public API (`tests/gate.test.ts`, `tests/token.test.ts`, `tests/execute.test.ts`, `tests/log.test.ts`, for the open window's verbs `tests/gate-window.test.ts`, and for the log-anchoring check `tests/log-anchor.test.ts`). (Amended APRV-214, pending sign-off. The anchoring union is APRV-219.)'

(2) THE ANCHORING SENTENCE, to be added to §9 (or to §11 beside invariant 1, whichever the human prefers; §9 is where the log's evidence layers already live). Exact text:

'A verifier MAY additionally compare the working log against the newest copy of it reachable from version control (the trunk, a records branch, or an advance anchor), and a runtime that offers the comparison MUST report a working log whose byte prefix or whose record at the anchored head does not match that copy as a distinct refusal (`anchor-diverged` in the reference runtime), MUST report the absence of any committed copy as a skip naming the revs it consulted rather than as a pass, and MUST NOT fetch to obtain one. The chain is unkeyed, so a party with write access to the log can truncate it and recompute a self-consistent chain that a cold walk cannot distinguish from the original (the boundary the conformance suite states as `chain-verification/truncation-unanchored`); a copy that party did not write is the only witness that survives them. (Added APRV-219.)'

(3) CONFORMANCE VECTORS, already regenerated in this branch the documented way (npm run build && node scripts/regen-conformance-vectors.mjs, then review the diff). refusal-unions.v1.json is vectors_version 7.0.0, up from 6.0.0, and carries a sixth union anchor_refusal_codes: [anchor-diverged]. The bump is MAJOR because the suite pins which unions exist as well as what each holds. conformance/README.md's table and version history updated to match; conformance-manifest.json re-pinned.

NOT SHIPPED, needs a decision. The same regeneration wanted to add six schema-validation vectors for event fixtures that exist on main (gate.bypassed, gate.closed and kin) and were never regenerated into that suite. Reverted here with its manifest digest restored: it is another lane's expectation move, and it would ride in without the version bump that suite's own rules require. Worth its own task.
<!-- SECTION:NOTES:END -->
