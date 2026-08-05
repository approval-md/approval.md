# Session handover

Written at the close of the founding session (2026-08-04/05, one two-day
session spanning M0 through the M5 decomposition). Read CLAUDE.md first, then
SPEC.md in full, then MILESTONES.md for the milestone map. This file covers
what those three do not.

## Current state

- Milestones M0 through M4.1 are complete: 46 tasks (APRV-1..47, with 38..43
  pending), 952 tests, lint and typecheck clean, all on main. The suite runs
  from a wiped install; `npm test`, `npm run lint`, `npm run typecheck` are the
  gates and CI runs them on Node 20 and 22 for every push.
- The live repo log (`.approval/log/events.jsonl` on main) holds three
  attestations and verifies clean. Gate operations run only in the primary
  checkout against main. The policy is attested at seq 3 (telegram default).
- CI exists (`.github/workflows/ci.yml`): classify -> doc-guard | full ->
  `ci` aggregator. The human confirms the first run is green and then sets
  branch protection to require `ci`. Check this happened before relying on it.
- Worktree agents branch from main, not from your integration branch. Pull
  main before starting anything (CLAUDE.md session hygiene) and expect
  additive help.ts and main.ts conflicts when two tasks add verbs in parallel.

## Open items awaiting the human

1. Branch protection flip once CI is green (their repository settings).
2. The upstream Backlog.md issue draft (`docs/upstream-backlog-issue.md`)
   awaits their review before filing.
3. The date-confabulation audit (APRV-46 notes) reported 21 sibling task files
   with wrong date stamps, deliberately not rewritten; the human may order
   per-file corrections.

## M5: next actions per task (decomposition approved, riders folded)

Sequence: APRV-38 first; then 39 and 43 in parallel; then 40, 41, 42 in
parallel after 39. Stop-and-review cadence per task, wiped-install gates,
merge and push per the standing authorization. Every task below has full
acceptance criteria in its Backlog file; these are orientation lines only.

- APRV-38 (vocabulary): all additive and version-noted. payload_retention,
  payload.pruned (17th event type), first-class batch_delivery_id (both
  encodings read during v0.1), audit.sampling_secret_env. Spec text lands
  same-commit as schema; the frozen-shape suites update additively.
- APRV-39 (approvald core): foreground `approval daemon run`, watch, envelope
  drift, TTL sweep, debounced QUEUE.md regeneration. The daemon is the sole
  writer while running; CLI appends still serialize via the lockfile.
- APRV-40 (sampling + audit + skew): HMAC sampler per amended section 5.2;
  `approval audit review` is human-only; the skew check is a non-fatal
  anomalies list on verify() with the threshold drafted for review (rider:
  approach pre-approved).
- APRV-41 (retention pruning): daemon-only, write-ahead (event before file),
  non-terminal payloads never prunable, orphans prunable regardless.
- APRV-42 (per-event git commits): rider folded — opt-in for standalone log
  deployments only, own-root log repo required, nested dogfood layout remains
  valid without the opt-in, docs state both patterns and why they do not mix.
- APRV-43 (head caching): touches Global invariant 1; implementation notes
  must say so and argue why the accelerator cannot become a bypass. Run the
  whole verify/state corpus in both cached and uncached modes.

## Things a fresh session should know that live nowhere else

- Model tiers per CLAUDE.md: fable orchestrates and reviews; Opus subagents
  build; spawn worktree-isolated agents for parallel tasks and expect to
  resolve their help/main conflicts yourself. Subagents must never run the
  backlog CLI or touch backlog/, APPROVAL.md, .approval/, CLAUDE.md.
- Pipelines that grep test counts must assert `fail 0` explicitly; a lone
  failure once slipped through a count-grep.
- The `three deaths` token test was deflaked (10s TTL, poll-until-expired);
  if a timing test flakes under parallel agent load, that is the pattern to
  apply, and wall-clock truth belongs in the injected-clock core tests.
- The human cold-reviews merged diffs by unpredictable sample, auditing
  reports as well as code. Implementation notes are the defense: write them
  accurate, including dates (see APRV-46 for what drift looks like).
- Dates: verify against created_date or git, never against your own sense of
  elapsed time. This session invented five calendar days that did not exist.
- LAUNCH.md at root is the living open-threads document; update it as tasks
  close, and add threads rather than letting them live in chat history.
