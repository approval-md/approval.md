---
id: APRV-226
title: 'examples/backlog-md-project: the Backlog.md on-ramp'
status: In Progress
assignee:
  - 'agent:fable-lane-p'
created_date: '2026-09-02 17:00'
updated_date: '2026-09-02 21:40'
labels:
  - docs
  - release
dependencies:
  - APRV-199
priority: medium
type: docs
ordinal: 183000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC section 14 lists examples/backlog-md-project/ in the repository layout, and it does not exist: examples/ holds the email, MCP, Telegram and web-agent demos. A stranger installing 0.1.0 has no worked example of the native Backlog.md integration that M6 shipped (envelope on a task file, register, request, wait, run). docs/backlog-md-pin.md covers the CLI pin and the upstream envelope-drop defect, not the happy path. This is the only Backlog.md item worth doing before launch; it fits APRV-199 AC1 (README front page current). Docs only: no runtime change, no new adapter (a Backlog.md adapter would hold no credential and cannot be a section 10.4 boundary; see the 2026-09-02 assessment recorded in this task). The example must run against a policy shipped with the example, not against the repo APPROVAL.md, so it stays valid when the dogfood policy changes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 examples/backlog-md-project/ holds a minimal backlog/tasks/ task file carrying an approval: envelope that validates against schema/envelope.schema.json (covered by the existing fixture test or a one-line addition to it)
- [x] #2 A README in the example walks register, request, wait and run in that order against a policy file inside the example, with the expected output of each verb shown, and states that board status and approval state are independent (SPEC section 12)
- [x] #3 The README says in one sentence why there is no Backlog.md adapter: task files hold no credential, so the envelope plus the log is the whole integration
- [x] #4 README front page links the example beside the other demos; docs-guard stays green
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read CLAUDE.md, SPEC sections 6, 12, 14, the envelope schema and fixture test, docs/backlog-md-pin.md, docs/dogfood-cutover.md, cli-reference for register/request/wait/run, the existing examples and the docs-guard rules.
2. Ship examples/backlog-md-project/ with a policy scoped to the example (policy.md, since the gate reserves the APPROVAL.md filename to human hands) and one Backlog.md 1.49.3-shaped task file carrying a release.publish envelope.
3. Run the four verbs against the built CLI in a scratch copy (attest, register, request, wait timeout, grant, wait, run, re-run refused, tail, verify) and paste the real output into the README.
4. State the no-adapter reason and the status/state independence in one sentence each.
5. Link the example from README.md beside the MCP walkthrough; add a docs-guard test that the task file's envelope validates and the README keeps the verb order.
6. Build, run docs-guard, fixtures and backlog-fixtures suites, oxlint the test file, commit per slice.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Shipped examples/backlog-md-project/: README.md (walkthrough), policy.md (the example's policy), backlog/tasks/task-7 - Publish-0.1.0-to-npm.md (Backlog.md 1.49.3-shaped task file with a release.publish envelope). README.md front page links it in the paragraph that already names request, wait, run as the session flow. tests/docs-guard.test.ts gains two tests: the task file's envelope validates against envelope.schema.json via parseFrontmatter plus validate, and the README shows register, request, wait, run in that order.

Decisions. (1) The policy is named policy.md and every verb passes --policy: this repository's gate classifies any write to a path named APPROVAL.md or APPROVALS.md as policy.core (human-only), wherever it sits, so the agent could not commit one; the README says so and says the block lives in APPROVAL.md in a real project. (2) The committed payload_hash is for the payload {argv: [echo, published], cwd: /home/alice/backlog-md-project}: approval run recomputes the hash from the argv and the physical cwd it spawns (verified: a symlinked cwd hashes the same as its physical path), so no committed hash can match a reader's machine; step 2 of the README has the reader compute their own with pwd -P and approval payload hash. (3) The expected outputs are pasted from a real run of the built CLI in a scratch directory (seq 1 to 6, one grant, one token, token-required at exit 5 before grant, timeout at exit 6, token-consumed at exit 1 on the re-spend, log verify clean). The only output rewritten is the attest path, shown as /home/alice/backlog-md-project for consistency with the illustrative cwd. (4) AC1's schema check is a docs-guard test rather than a schema fixture, because the fixture suite validates schema/fixtures only and cannot see examples/; the test reads the example file itself, so the file and the promise cannot drift apart. That .ts touch moves the PR out of the light CI tier; docs-guard itself is green.

Observed in passing, not changed: examples/telegram-demo.md step 10 shows approval run succeeding with --payload-hash of an email-shaped payload and echo as the command, and its refusal output uses the older approval: code: form; the current CLI recomputes the argv plus cwd hash and prints the check-mark form, so that transcript may be stale relative to tests/e2e-demo.test.ts. Flagged for the orchestrator, out of scope here.

Verification: npm run build exit 0; node --test dist/tests/docs-guard.test.js 11 pass exit 0; dist/tests/fixtures.test.js 143 pass exit 0; dist/tests/backlog-fixtures.test.js 9 pass exit 0 (drift guard ran, pinned CLI present); npx oxlint tests/docs-guard.test.ts exit 0. No em dashes or not-X-but-Y constructions in the new prose (grep). Gate verbs ran only against scratch directories under the session scratchpad; the primary log was touched by nothing but the hook's own records.
<!-- SECTION:NOTES:END -->
