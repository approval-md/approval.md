---
id: APRV-232
title: >-
  policy amend --commit: protection probe misses repository rulesets, so every
  ceremony first hits the GH013 wall before the branch flow
status: In Progress
assignee:
  - 'agent:fable-lane-q'
created_date: '2026-09-02 20:12'
updated_date: '2026-09-02 20:59'
labels:
  - cli
  - ceremony
dependencies: []
priority: medium
ordinal: 187000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Seen 2026-09-02 at the seq 13704 ceremony: approval policy amend --commit probed protection via gh api repos/{owner}/{repo}/branches/main/protection, got 404 (that endpoint describes classic branch protection only; this repository is governed by rulesets, which live under repos/{owner}/{repo}/rules/branches/{branch}), concluded main was unprotected, attempted the direct push, and printed the full GH013 remote rejection (required status check ci, changes must be made through the merge queue) before falling back to the branch flow, which then worked. The outcome was right; the transcript was a wall of red for a normal ceremony. Outcome: the probe also reads the rulesets endpoint (read-only, never fails the command, UNKNOWN when neither answers), and the verb goes straight to the branch flow when either says protected; the direct flow stays for unprotected repositories. Optionally remember the last ceremony's outcome in the approval home so a repository that refused once is not probed by push again. Why: the ceremony is the human's one hands-on moment and it should read as success, not as a rejection recovered from.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 On a repository whose default branch is governed by a ruleset requiring the merge queue, approval policy amend --commit prints no push rejection and goes directly to the branch flow (test with a stubbed gh answering 404 on branches/{branch}/protection and a ruleset on rules/branches/{branch})
- [x] #2 A classic-protected repository, an unprotected one, and an unreachable gh each still resolve as before (protected, unprotected, UNKNOWN), covered by tests
- [x] #3 docs/cli-reference.md policy amend section describes both probes
- [ ] #4 npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. src/cli/amend.ts probeProtection: keep the classic probe (gh api repos/{owner}/{repo}/branches/<default>/protection); exit 0 stays protected. When it answers 404 (or any other non-zero), read the rulesets endpoint (gh api repos/{owner}/{repo}/rules/branches/<default>): a non-empty JSON array is protected (reason names the rule types), an empty array or a 404 is 'no rules', anything else is unreadable. Resolution: either probe protected => protected; classic 404 AND rulesets empty/404 => unprotected; otherwise unknown. gh absent stays unknown. Both probes read-only, never fail the command.
2. GitReport.protectionReason keeps one clause and names which probe answered; no new report keys.
3. tests/cli-amend.test.ts: ghStub gains rulesets: 'ruleset' | 'none' | 'error' (default: none when protection is unprotected, error otherwise so existing cases keep their answers). New cases: classic 404 + ruleset => branch flow, no push rejection printed, PR opened (AC1); classic 404 + rulesets error => unknown; classic protected does not consult rulesets; existing protected/unprotected/gh-absent cases stand (AC2).
4. docs/cli-reference.md policy amend section: describe both probes and the resolution table; help stays under 25 lines (no help change needed).
5. npm run build, node --test per file, npx oxlint, npm test in background; implementation notes; ACs checked.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What was built (APRV-232)

**The probe reads two endpoints.** `probeProtection` in src/cli/amend.ts keeps the classic read (`gh api repos/{owner}/{repo}/branches/<default>/protection`; exit 0 is protected and ends the lookup). When classic cannot prove protection (404 or any other refusal) it reads `repos/{owner}/{repo}/rules/branches/<default>`, the endpoint that lists the rules a ruleset applies to the branch. Resolution: either probe protected is protected (the reason names the rule types, e.g. `merge_queue, required_status_checks`); classic 404 AND an empty list (or 404) is unprotected; anything else is UNKNOWN with a reason that names what each probe said. gh absent stays UNKNOWN before the rulesets read is attempted. Both reads are read-only and neither can fail the command. The `--silent` flag was dropped from the classic call because a shared `ghApi` helper now captures stdout (the rulesets body is needed; the classic body is ignored). No new JSON report keys: `protection` and `protectionReason` carry the answer as before.

**Decisions.**
1. *Unprotected needs BOTH answers.* Classic 404 alone used to be proof of unprotected; it is now only half the proof, and classic 404 plus an unreadable rulesets endpoint is UNKNOWN. UNKNOWN is the direct flow, exactly as before, so the worst case for a token that can read neither is the pre-existing recovery path rather than a refusal.
2. *Classic protected short-circuits.* The rulesets endpoint is not consulted when classic already answered protected; one network read fewer at the ceremony, and a test pins that it is not read.
3. *The optional ceremony-outcome memory was NOT added.* The rulesets read removes the GH013 wall for this repository outright, and a hint file under the approval home would be a new untracked file inside `.approval/` (a human-only path) needing a .gitignore line and its own tests. Left as a possible follow-up if a repository where both probes answer UNKNOWN turns up.

**Global invariants touched (SPEC §11).** None weakened. The probe influences only which publication flow runs (direct push or branch plus PR); the attestation, the commit contents and the log are identical on both flows. No enforcement path changed what it reads, nothing is appended to the log by this change, and no self-reported field was introduced.

**Tests.** tests/cli-amend.test.ts: the gh stub gains `rulesets: ruleset | none | error` (default follows `protection`: none when classic says unprotected, error otherwise, so every pre-existing case resolves as it did). Six new cases: ruleset-governed main with a remote that refuses direct pushes goes straight to the branch flow with no rejection text on either stream and both endpoints read in order (AC1); JSON report names the rule types; classic protected does not read rulesets; classic 404 plus unreadable rulesets is UNKNOWN; classic unreadable plus empty rules is UNKNOWN; classic 404 plus empty rules is unprotected (AC2, alongside the existing protected, unprotected and gh-absent cases which still pass). Help text unchanged, still under the 25-line cap.

## Verification

`npm run build` clean. `npx oxlint src tests` clean (two unicorn warnings from the new test were fixed by using endsWith). Per-file runs against dist: `node --test dist/tests/cli-amend.test.js` 84 tests, all pass after the one fix to the UNKNOWN reason text (first run 83/84, second targeted run of the eight protection cases 8/8); `node --test dist/tests/cli-long-help.test.js` 21/21 (the 25-line help cap holds; help text untouched). Full `npm test` was started in the background with a 10 minute ceiling on a loaded machine; the only failure it had reported by the time of these notes is `every production dependency's engines.node admits the Node floor` (tests/ci-guard.test.ts), which reads <root>/node_modules/<dep>/package.json and this agent worktree has no node_modules of its own (the same worktree artifact APRV-203 recorded; it passes in the primary checkout and in CI where npm ci runs).

Full npm test did NOT finish inside the session's 10 minute ceiling on the loaded machine: the log stopped at 577 tests reported (576 pass, 1 fail: the ci-guard engines.node worktree artifact above) and no summary line was written. AC4 is left unchecked for the orchestrator to confirm with a full run in the primary checkout. Files run to completion here with exit codes: dist/tests/cli-amend.test.js (84/84, exit 0), dist/tests/cli-long-help.test.js (21/21, exit 0); npx oxlint src tests exit 0, no warnings.
<!-- SECTION:NOTES:END -->
