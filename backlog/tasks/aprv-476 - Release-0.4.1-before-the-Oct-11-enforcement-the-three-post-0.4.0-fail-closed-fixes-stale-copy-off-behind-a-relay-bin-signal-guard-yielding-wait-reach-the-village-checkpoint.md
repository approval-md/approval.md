---
id: APRV-476
title: >-
  Release 0.4.1 before the Oct 11 enforcement: the three post-0.4.0 fail-closed
  fixes (stale-copy off behind a relay, bin signal guard, yielding wait) reach
  the village checkpoint
status: In Progress
assignee: []
created_date: '2026-10-05 02:08'
labels:
  - agent-village
dependencies:
  - APRV-453
priority: high
ordinal: 362000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
0.4.0 was tagged at fb0cf987 on 2026-10-04 20:22Z; after it, three security fixes merged to main that the Agent Village fleet should run before APPROVALD_ENFORCE=1 on Oct 11: APRV-456 (#605, a tap whose nonce the listener is not holding is refused behind a relay, closing the forged-card path through the stale-copy fallback), APRV-466 (#604, the Hermes hook's signal guard lives in the bin so a signal during module load prints the block directive), APRV-473 (#608, the Hermes wait yields so a SIGTERM withdraws the question and no execution.started is appended after an interruption). The hosted image's shell_hooks patch covers the signal cases on Hermes's side as the other belt, and the relay case matters only once the relay is live, so 0.4.0 can run on dogfood now; the fleet should be cut from 0.4.1. Same ceremony as APRV-453: a release PR (changelog section, version strings, release notes naming the three), Carter's gated tag and push, Trusted Publishing, read-backs, then DATA-228 rebakes the checkpoint at 0.4.1 and HOSTED-32's pin moves. Include APRV-467/468/469/474/475 only if they land in time; do not wait for them.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Release PR opened with the 0.4.1 section naming 456, 466 and 473 and anything else merged since fb0cf987; CI green; not armed
- [ ] #2 Carter tags and pushes v0.4.1 through the gate; publish run green; read-backs recorded
- [ ] #3 DATA-228 and HOSTED-32 told the version; the checkpoint rebuilt at 0.4.1 before the Oct 11 roll
<!-- AC:END -->

## Implementation Notes
<!-- SECTION:NOTES:BEGIN -->
2026-10-05 (claude-edge/REL-open). Release PR prepared on lane/rel-0.4.1: commit 79e0a925 (changelog section, version strings as in #595, release-notes test list, docs/releases/0.4.1.md), then a merge of origin/main aba1b98e (#616 APRV-489, #619 APRV-492, #620 records APRV-494..498, #621 log advance). CHANGELOG conflict resolved by keeping the merged #616 and #619 entries and deleting the two TODO lines; a fresh empty `## Unreleased` sits above `## 0.4.1 — 2026-10-05` (date from the GitHub server Date header, 2026-10-05 19:38Z). The #616 entry cites the SPEC sign-off (gate.path.signed_off seq 84046, SPEC.md sha256 3b1de87a), which equals main's SPEC.md bytes.

Entries in `## 0.4.1`: APRV-456, 466, 473, 475, 478, 479, 480, 481, 482, 483, 489, 492. Records only (no entry): APRV-491 (named in the APRV-479 entry as the known gap), APRV-494..498.

Targeted checks only (no full suite): `npx tsc -p tsconfig.json` exit 0; `node scripts/run-tests.mjs --only release-notes site-version-guard` exit 0, 30 pass, 0 fail; `node scripts/release-notes.mjs 0.4.1` exit 0 (280 lines, starts `### Channels`); `node scripts/release-notes.mjs --check` exit 0, lists `0.4.1 2026-10-05` first.

Remaining: AC #1 needs CI green on the PR head and claude-edge's review and arming; AC #2 and #3 are Carter's (tag, push, Trusted Publishing, read-backs, DATA-228 rebake with APPROVALD_LISTEN=unix, HOSTED-32 pin).
<!-- SECTION:NOTES:END -->
