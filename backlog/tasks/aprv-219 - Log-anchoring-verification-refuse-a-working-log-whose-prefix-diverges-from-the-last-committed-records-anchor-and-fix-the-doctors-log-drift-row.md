---
id: APRV-219
title: >-
  Log anchoring verification: refuse a working log whose prefix diverges from
  the last committed records anchor, and fix the doctor's log-drift row
status: In Progress
assignee:
  - 'agent:opus-lane-v'
created_date: '2026-09-02 16:26'
updated_date: '2026-09-02 18:32'
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
- [ ] #1 approval log verify --anchor refuses with anchor-diverged when the working log's prefix does not match the newest committed anchor (byte digest and head seq/hash), and passes when it does; both proved through the real append path plus a git fixture repo
- [ ] #2 A missing anchor (no records branch, no git, detached) is reported as a skip with a reason and never as a pass
- [ ] #3 The daemon runs the anchor check at startup and on each full re-proof; divergence stops the daemon with a distinct outcome, and the tick/started lines name the anchor in use
- [ ] #4 approval doctor's log-drift row is this check's result and no longer misreads the checkout (APRV-210's two reproductions pass)
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
