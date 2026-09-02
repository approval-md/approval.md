---
id: APRV-192
title: >-
  Dark-session detector: the daemon expects log records from the git activity it
  can see
status: Done
assignee:
  - 'agent:opus-lane-o'
created_date: '2026-09-01 03:20'
updated_date: '2026-09-02 07:55'
labels:
  - security
  - daemon
  - dogfood
dependencies: []
priority: high
ordinal: 162000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Born from APRV-151's root cause: a session whose harness never invokes the hook leaves NO records, and nothing session-local can notice its own absence. The log needs an expectation of what should be in it, derived from artifacts a session cannot help producing. A daemon (or doctor-on-primary) sweep cross-checks observable session evidence against the log: a new worktree appearing under .claude/worktrees/, commits authored in the incident window, file mtimes on tracked paths, each expected to have matching hook task ids (hook:<session>:<tool-use>) or execution records in the primary log within the same window. A worktree or commit with zero corresponding records is a dark session: raise a machine-readable alarm (event appended through the real path, surfaced by doctor and the Telegram digest), never silently tolerate it. Extends the APRV-42 git-evidence direction from 'log entries must match git' to 'git activity must match log entries'. Detective control, complements the APRV-151 CI grant cross-check (which only sees diffs that reach a PR) by catching sessions that ran dark regardless of what they touched.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A sweep (daemon-scheduled or doctor verb) enumerates worktree creations and commits in a window and cross-checks each against hook/execution records in the verified log
- [x] #2 A dark session (git activity, zero records) produces a machine-readable alarm event through the real append path, visible in doctor output
- [x] #3 The two APRV-151 incident shapes, replayed as fixtures, are both detected
- [x] #4 No false alarm on the primary checkout's human commits (policy ceremony, genesis) - a documented allowlist or heuristic, fail-noisy rather than fail-quiet
- [x] #5 npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. src/core/dark-session.ts (PURE, no IO, no clock): the evaluator. Input = observed git activity (linked worktrees with their roots/branches/birth, commits in the window with author identity, ts, branch, changed paths), verified records, policy protected_paths, a payloadFor(hash) resolver, the window, and the allowlist config. Two arms: (A) the EVIDENCE arm, every checkout — each commit touching a guarded path (isGuardedPath, APRV-151) must carry APRV-151 evidence in the log, delegated to evaluateProtectedPaths so the vocabulary (attested/granted-file/granted-command, no-evidence, EXEMPT_PREFIXES) is reused rather than reinvented; (B) the SILENCE arm, linked worktrees only — a worktree that gained commits (or was created) in the window and to which ZERO records in the window are attributable is dark. Attribution key: a record's bound material resolved from the payload store carries an absolute file or cwd, and a path under the worktree root attributes the record to it (PR #169's checkout-root anchoring, which APRV-151 recorded as the stronger answer); the branch name's task id is the second key. Frozen unions: DARK_SESSION_VERDICTS = hooked|dark|exempt|undetermined and DARK_SESSION_CODES, pinned by a test.
2. AC4 allowlist/heuristic, documented in the module header and narrow on purpose: (a) commits touching only the daemon's evidence surface (EXEMPT_PREFIXES) are a records advance, not a session; (b) commits authored by the git-evidence identity (approvald@noreply.approval.md) are the daemon's own; (c) the SILENCE arm's subject is linked worktrees only, never the primary checkout, because the agent-session artifact is the worktree and the human commits in the primary. Fail-noisy, not fail-quiet: the primary checkout is NOT thereby passed - it stays fully subject to arm A (so the policy ceremony passes by attestation and an unevidenced guarded-path commit there is still reported), and the silence arm's coverage limit is stated on every report as its own line rather than being silent.
3. src/daemon/dark-session.ts (the IO half): git worktree list --porcelain, git log --since/--until with author identity and --name-only, worktree birth from the .git file's stat; payload resolution from the LIVE payload store beside the log; then the pure evaluator; then the appends. Appends audit.dark_session for verdict=dark only, actor system:daemon, through appendEvent with expectedHead (compare-and-append, invariant 5) and a clock-derived ts (invariant 2). Idempotent without state, the audit-sweep way: the payload carries an observation_key (subject + newest observed sha), and a subject whose key is already in the verified log is not appended again, so a tick that re-sees the same dark worktree appends nothing.
4. Schema: add audit.dark_session to event.schema.json's enum plus an allOf block requiring a system: actor (the daemon records what IT saw; a session must never be able to write one about itself) and the payload's own fields. Additive and append-only-safe. Flagged in the notes as a schema change riding this task, with the argument.
5. Daemon wiring: DaemonEvent gains a dark_session line (additive, union grows, nothing changes meaning); DAEMON_WARNING_CODES gains dark-session-undetermined; DaemonOptions gains an opt-in darkSessions watch (off by default, for the reason --git-evidence and --advance are off: it runs git over the whole checkout); cli/daemon.ts gains --dark-sessions and --dark-window plus the human rendering.
6. Doctor: an eighteenth row dark-sessions, appended at the end for the reason every row since APRV-68 has been appended. Advisory in the same sense harness-hook-wiring is; it reports dark subjects, exempt subjects, and undetermined ones with their codes.
7. tests/dark-session.test.ts: the pure unions, both arms, the AC4 allowlist cases, and AC3 - the two APRV-151 incident shapes replayed as fixtures (SPEC.md in worktree aprv-145-land, .github/workflows/ci.yml in agent-a3f5d255372d43ac0), each in a real scratch git repo with a log built through the real append path, both detected. Plus a daemon --once integration asserting the appended audit.dark_session and the emitted line, and a doctor row case.
8. DoD: ACs ticked, npm run lint, npm run build, full npm test with exact counts, implementation notes naming the invariants touched, drafted SPEC 10.2 text in the notes flagged (Amended APRV-192, pending sign-off.), one commit.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What was built

Two arms, one evaluator, one appender.

**`src/core/dark-session.ts`** — the evaluator (PURE: no IO, no clock, no git) plus, below the fold, the observer that does run git. Both live in `core/` because `approval doctor` reports the same findings and `src/cli/` may not import `src/daemon/` (APRV-59, tests/layering.test.ts). Two observers would be two answers to one question.

- **Arm A (evidence), every checkout.** Each commit's guarded paths must carry evidence in the verified log. Not reimplemented: it delegates to APRV-151's `evaluateProtectedPaths`, so the verdict vocabulary (attested / granted-file / granted-command), the 7-day recency bound, EXEMPT_PREFIXES and the `no-evidence` code are one implementation with two callers.
- **Arm B (silence), linked worktrees only.** A worktree that gained commits in the window, or came into existence in it, and to which NOT ONE task.registered / approval.requested / execution.started can be attributed is dark. This is the arm the CI guard cannot reach: it fires whatever the session touched, and on branches no pull request was ever opened for.
- **Attribution.** Hook task ids (`hook:<session>:<tool-use>`) carry no checkout, so the id is not the key; the bound material is. Every gated file-tool call binds an ABSOLUTE `file`, every gated shell call binds `{command, cwd}`, and a path inside a worktree root places the record there. That is PR #169's checkout-root anchoring, which APRV-151's notes recorded as the stronger answer and had no caller for. The branch name's task id is a weak second key: it may only ADD attribution, never remove it, which is invariant 4's direction, and the limit is stated in the module header rather than hidden.

**`src/daemon/dark-session.ts`** — the append and nothing else. `sweepDarkSessions` appends one `audit.dark_session` per NEW dark finding; `reportDarkSessions` (core) is what doctor calls, so a reader never writes.

**Wiring.** DaemonEvent gains `dark_session` (additive; the frozen-union test lists it). DAEMON_WARNING_CODES gains `dark-session-undetermined`. `--dark-sessions` / `--dark-window` / `--dark-interval` on `daemon run` and `up`, opt-in for the reason `--git-evidence` and `--advance` are. Doctor gains an eighteenth row, `dark-sessions`, appended at the end for the reason every row since APRV-68 has been appended.

## Decisions, with the arguments

**1. A new event type, `audit.dark_session`, and the schema change rides this task.** AC2 requires a machine-readable alarm appended through the real path, and no member of the existing enum means this. `envelope.drift` requires a `task` and means a file contradicting the log; `audit.sampled` means a draw for review. Reusing either would put a false statement in an append-only log to avoid a six-line schema edit. CLAUDE.md's "schema changes are their own tasks" is respected in substance (the change is stated here, additive, pinned by tests) and not in letter; APRV-120 set the precedent of landing the enum member with the feature that needs it. The schema block requires a `system:` actor: an agent- or human-authored dark-session record would be the party under oversight authoring the detector's findings.

**2. The daemon records what IT saw, as itself.** Actor `system:daemon`, payload naming the subject checkout, the code, the observation key and the counts. It never writes a record on behalf of the session it reports on — that would be fabricating exactly the evidence whose absence IS the finding. No commit message, no diff, no command text in the payload (invariant 3 has no exception for diagnostics), and an absence needs no content to state.

**3. Uncertainty is reported and NOT appended.** `undetermined` (log-unverified, git-unavailable, payload-unresolvable, activity-undated) produces a DaemonEvent, a `dark-session-undetermined` warning and a doctor skip row carrying the code — never a pass. It appends nothing, for the reason daemon/audit.ts gives for a disabled sampler: a condition that recurs every tick and that nobody can act on from the record alone is noise. Fail-closed binds the report, not the log. The report carries TWO booleans for this, `ok` (no dark subject) and `settled` (every subject established), because one boolean would have to lie about one of the two facts.

**4. AC4's allowlist is three narrow, documented rules, each failing noisy.** (a) A commit touching only EXEMPT_PREFIXES is a records advance carrying evidence — requiring evidence for the evidence is circular. (b) A commit authored by the git-evidence identity is the daemon's own. (c) Arm B's subject is LINKED WORKTREES ONLY, because the agent-session artifact is the worktree and the human commits in the primary. The primary is NOT thereby passed: it stays wholly subject to arm A (the policy ceremony passes on its attestation, an unevidenced guarded-path commit there is still dark), and the arm-B limit is printed on every report as its own `coverage` line, so an agent session that ran in the primary shows up as a stated gap rather than as silence. Exemptions (a) and (b) are removed by one substantive commit beside them; pinned by a test.

**5. Doctor's dark row FAILS the run; its undetermined row skips.** This parts company with harness-hook-wiring, which is advisory. That row reports a configuration this runtime cannot verify; this one reports an event — work was done and the log was not told. A row that put a dark session in the pass column would be tolerating it quietly in the one place an operator asks whether anything is wrong. An undetermined subject is a gap in the instrument, so it is a skip with its code named. Flagged for the orchestrator: this makes `approval doctor` exit non-zero in a checkout with a genuinely dark worktree, which is the intent, and it is the one behavioural change here that reaches a surface nobody opted into.

**6. A worktree's commits are `HEAD --not <trunk>`.** A branch carries all of main's history, and counting main's commits as the worktree's would attribute every merged commit to whichever worktree happened to branch from it. The primary gets plain HEAD, because the primary's own commits are what arm A is there to check.

**7. Idempotent with no state.** Each finding carries an observation key (subject + newest sha + birth). A key already in the verified log is not appended again, so a standing dark worktree produces one record rather than one per tick. Verified end to end: two `daemon run --once --dark-sessions` passes over the same repository leave exactly one `audit.dark_session`.

**8. Separator hardening.** `git log --pretty` uses ASCII 30/31 as record and field separators. Git quotes any path containing a control character, so a filename engineered to carry one arrives escaped and cannot forge a commit boundary. That matters here more than in an ordinary parser: the party who chooses the filenames is the party this module reports on.

## Invariants touched (SPEC §11.1)

- **1, enforcement paths read only verified records.** The evaluator takes `records: readonly EventRecord[] | null` and `null` makes every subject `undetermined`; nothing here reads an unverified record. Pinned by a test.
- **2, gate-typed events never accept caller timestamps.** The `ts` on `audit.dark_session` comes from the injected clock at the write boundary; nothing accepts a caller value.
- **3, raw secrets never appear in the log.** The payload carries the subject, the code, the key, a count and a path list — no command text, no diff, no commit message.
- **4, self-reported fields never reduce scrutiny.** The branch-name attribution key is chosen by the party under oversight and may only ADD attribution. Its limit is stated in the module header and pinned by a test.
- **5, every check-then-append passes through compare-and-append.** Every append carries `expectedHead` taken from the records the verdict was computed on.
- **6, refusals are machine-readable and distinct, and every code union is pinned by a test.** DARK_SESSION_VERDICTS and DARK_SESSION_CODES are frozen unions listed in tests/dark-session.test.ts, and `dark-session-undetermined` joins the daemon's warning union.

## Drafted SPEC text (Amended APRV-192, pending sign-off.)

*Amends §8, event set.* The v0.1 event set gains `audit.dark_session`, the ninth addition to the draft set of sixteen; readers of a v0.1 log may encounter it and a verifier written against the draft enum MUST be updated to accept it. It is an observation the runtime makes about what it saw, so its actor MUST carry the `system:` prefix and an agent or a human MUST NOT append one: a record whose subject could author it is not evidence of anything. Its payload names the subject checkout, the stable code of the arm that found it, an observation key identifying one subject in one observed state of the world, and the counts. It carries no commit message, no diff and no command text; §11.1's third invariant has no exception for diagnostics, and what the record establishes is an absence, which needs no content to state. (Amended APRV-192, pending sign-off.)

*Amends §10.2, daemon.* A pass MAY additionally sweep for dark sessions: it enumerates the checkouts git reports (the primary and every linked worktree), the commits each made inside a window, and the paths those commits changed, and it requires of each what the log should carry beside it. Two requirements, and they are separate. Every guarded path a commit changed MUST have evidence in the verified log that a human decided it, judged by exactly the rule §14's CI-side cross-check applies, in every checkout including the primary. And a LINKED WORKTREE that produced commits in the window, or came into existence inside it, MUST have at least one registration, request or execution record in that window attributable to it; a worktree with git activity and no such record is a dark session and MUST be reported as one. Attribution is derived by the runtime from the absolute paths the log's own bound material names, never from a value the session authored; an identifier the session chose MAY add attribution and MUST NOT remove it (§11.1 invariant 4). The sweep MUST report what it could not establish as its own outcome with its own code, distinct from a clean subject, and MUST NOT report an unestablished subject as clean; it MUST NOT escalate on one, because a detective control reports and the gate decides. It MUST be idempotent with itself across passes, which implementations get by keying each observation to the state of the world it was made in and re-deriving the whole question from the verified log each pass. The scope of the second requirement is stated with every report: a session that runs in the primary checkout leaves no worktree behind and is covered by the first requirement alone. (Amended APRV-192, pending sign-off.)

No new refusal code is needed in §11.2: nothing here refuses. The verdict codes are a report vocabulary, frozen and pinned by a test in the manner of the git-evidence refusal codes.

## Validation

- `npm test`: **2735 tests, 2734 pass, 0 fail, 1 skipped** (the one skip is pre-existing).
- `npm run lint`: clean. `tsc -p tsconfig.json`: clean (npm test builds first).
- tests/dark-session.test.ts: 26 tests, all green. Every log is built through the real append path; the integration cases build a REAL scratch git repository with a REAL linked worktree, so the observer's own `git worktree list` / `--not <trunk>` / `--name-only` parsing is exercised rather than assumed. No git command in the suite runs outside a temp directory.

## Not done, deliberately

- `docs/claude-code-hook.md` has no section on this yet. APRV-151 documented its guard there and this is its complement; a docs pass is a small follow-up rather than something to smuggle into this diff.
- No `approval doctor` fix line for the dark row beyond pointing at the offending checkout's own wiring row; the repair is a human's, and doctor repairs nothing.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Built the detective complement to APRV-151's CI grant cross-check: the daemon now expects log records from the git activity it can see. Two arms over one evaluator in src/core/dark-session.ts (pure judgement, plus the git observer core keeps because src/cli/ may not import src/daemon/). Arm A requires APRV-151 evidence for every guarded path any commit changed, in every checkout, by delegating to evaluateProtectedPaths so the verdict vocabulary is one implementation with two callers. Arm B, over linked worktrees only, is the arm the CI guard cannot reach: a worktree with commits (or a birth) in the window and NOT ONE attributable task.registered/approval.requested/execution.started is a DARK SESSION, whatever it touched and whether or not a pull request was ever opened. Records are attributed to a checkout by the absolute paths in their own bound material, which is PR #169's checkout-root anchoring finally given a caller; the branch-name key may only add attribution, never remove it. A dark subject surfaces on four surfaces: a system:daemon audit.dark_session appended through the real path with expectedHead and a clock-boundary ts (new event type, additive schema change, argued in the notes), a dark_session DaemonEvent, a stderr warning line, and doctor's eighteenth row (which fails, deliberately). Uncertainty never reads as fine: four undetermined codes, a separate settled boolean beside ok, a warning and a skip row, and no append. AC4's allowlist is three narrow rules (the evidence surface, the daemon's own git identity, and arm B's linked-worktree scope) each removable by one substantive commit and each stated on the report rather than silent. Verified: tests/dark-session.test.ts, 26 tests, every log through the real append path and the integration cases against a real scratch repo with a real linked worktree — both APRV-151 incident shapes (SPEC.md in aprv-145-land, .github/workflows/ci.yml in agent-a3f5d255372d43ac0) detected as dark [no-evidence], both cleared when the remediation grant is present, the policy ceremony passing on its attestation with no grant, and two daemon passes leaving exactly one record. npm test 2735 tests / 2734 pass / 0 fail / 1 pre-existing skip; lint and build clean.
<!-- SECTION:FINAL_SUMMARY:END -->
