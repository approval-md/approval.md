---
id: APRV-348
title: >-
  Upstream Codex hook payload: propose per-call cwd on Bash pre-events and an
  outcome field on post-events
status: In Progress
assignee:
  - '@opus-lane-codex'
created_date: '2026-09-17 01:25'
updated_date: '2026-09-17 07:40'
labels:
  - codex
  - upstream
  - hook
dependencies: []
priority: medium
ordinal: 265000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Lane 4b (APRV-311, PR #408, 2026-09-17) confirmed against the installed @openai/codex 0.152.1 envelope that every Bash PreToolUse event carries tool_input keys exactly ["command"], with no per-call cwd or workdir (the event cwd and the hook process cwd both stay at the session root), and that PostToolUse carries no success or failure signal (exit 0 and exit 7 raise the same event with the same empty tool_response and there is no PostToolUseFailure). Those two omissions are what keep native Codex Bash gating refused (hook-unsupported-execution-context) and keep APRV-311 AC1 and its outcome-correlation clause unprovable. Codex is open source, so the fix is an upstream proposal rather than a workaround: an issue and, if welcomed, a pull request against openai/codex adding (a) the effective execution directory of the shell call to the Bash pre-event payload and (b) an outcome field (exit status or success/failure plus a stable call id) to the post-event, with our probe evidence (docs/codex-hook-probe.md, docs/codex-boundary-probe.md, the APRV-311 notes and tests/cli-hook-codex.test.ts fixtures) as the motivating case. The fail-open behaviour on crash, timeout and malformed output is a third, separate ask (a fail-closed option), worth naming in the same issue as a distinct item. Opening the issue and the PR are network.call and vcs.pr actions on a foreign repository: they run through the gate from the primary, never from a worktree. Related: APRV-311, APRV-315, APRV-325, APRV-349.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 An issue on openai/codex states the two payload gaps and the fail-open behaviour with reproduction steps against a named version, links our probe docs, and proposes the minimal payload additions; the issue URL is recorded in the task notes
- [ ] #2 If maintainers welcome a change, a pull request implements the payload additions with tests in the Codex repository; its URL and review state are recorded in the notes (a declined issue closes this task with the reason recorded)
- [x] #3 docs/codex-hook.md and docs/integrations-considered.md name the upstream issue as the condition under which native Codex Bash gating becomes activatable, and APRV-311 references it
- [ ] #4 Every external action (issue, fork push, PR) went through the gate from the primary checkout with the seqs recorded in the notes
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read the reviewed native fixtures and the probe doc so the reproduction quotes captured envelope key lists rather than memory. 2. Write docs/upstream/codex-hook-payload.md as paste-ready issue text: title, summary, three separate asks (per-call execution directory on the shell pre-event, outcome field plus documented stable call id on the post-event, an opt-in fail-closed setting), reproduction against 0.152.1 with the key lists, why it matters, a minimal payload diff, and an offer to send a pull request. Tone stays that of a good upstream citizen with one linking sentence about this project. 3. Name that issue as the activation condition in docs/codex-hook.md and add a Codex entry to docs/integrations-considered.md, which had none. 4. Point APRV-311 at it with a reference and a note. 5. Leave criteria one, two and four unchecked: they need the posted issue, which is the operator's runbook step, and the maintainer response that follows it.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Criterion three checked with this evidence: docs/codex-hook.md gained a section titled 'What would lift the refusal' that names docs/upstream/codex-hook-payload.md and states which of the three asks lifts which refusal (ask one reopens APRV-311 AC1, ask two is what the outcome clause waits on, ask three is what separates one control from a boundary). docs/integrations-considered.md had no Codex entry at all, so one was added in the register's own five-heading format, with a summary-table row and a Conclusion that names the same draft as the activation condition. APRV-311 now carries the draft as a reference and a note saying the same. Verified by grep of both docs and by reading back the task's References line. The docs-guard suite gave 16 tests, 16 pass, 0 fail, exit 0 after the edits; build, typecheck and lint all exit 0.

Criteria one, two and four are deliberately unchecked and none of them is work this lane can do. Criterion one needs the issue POSTED and its URL recorded; that is step 3 of the operator runbook at private/runbook-2026-09-17.md, and no agent session in this repository posts publicly. Criterion two needs a maintainer response, which cannot exist before the post. Criterion four records the gate seqs for the external actions, which likewise cannot exist before them. The task therefore stays In Progress rather than Done. What is ready is the paste: docs/upstream/codex-hook-payload.md carries the title, the summary, three separate asks, a reproduction against 0.152.1 quoting the captured envelope key lists from the reviewed native fixtures, why each omission matters, a minimal payload diff for each ask, and an offer to send a pull request. Two deliberate choices worth review before it goes out. The call-id half of ask two is phrased as a request to DOCUMENT an existing property rather than to add a field, because the reviewed native v6 evidence shows the pre and post identifiers of one call are already identical and distinct calls already differ; asking for something that already ships would have read as not having looked. And the one sentence about this project sits at the very end, framed as context for where the report came from, so the issue reads as a payload report rather than as a pitch.
<!-- SECTION:NOTES:END -->
