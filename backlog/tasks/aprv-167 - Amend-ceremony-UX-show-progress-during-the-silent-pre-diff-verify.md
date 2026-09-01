---
id: APRV-167
title: 'Amend ceremony UX: show progress during the silent pre-diff verify'
status: Done
assignee:
  - '@claude'
created_date: '2026-08-30 23:07'
updated_date: '2026-09-01 02:37'
labels:
  - cli
  - ux
dependencies: []
ordinal: 146000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed by Carter 2026-08-30: approval policy amend sat silent for ~33 seconds before printing the Policy/Changes/Load block, and read as frozen; the human nearly abandoned a live ceremony (and earlier DID abandon one mid-run, leaving the repo gate fail-closed for every agent session until a second attempt). The silence is the chain re-verify plus baseline recovery over a ~3000-record log before anything prints. Wanted: immediate output when the verb starts (what it is doing, record count), and progress for any step that can exceed a couple of seconds (verify N/M records, baseline recovery), on stderr so --json stdout stays clean. Same treatment for other verbs that re-verify the whole chain before speaking (wait, status on large logs) is in scope to survey, amend is the priority.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 approval policy amend prints a first line within ~1s of invocation naming the step in progress
- [x] #2 Chain verification over large logs reports progress (count-based, stderr), and --json output is byte-unchanged on stdout
- [x] #3 A survey note in the task lists which other verbs share the silent-verify pattern and whether each got the same treatment or a reasoned skip
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. core/verify.ts: add an optional VerifyProgress sink (onProgress) to VerifyOptions; verifyText reports total at walk start and walk reports each verified record (file-absolute counts, so a cache-resumed walk reports the same numbers). No behavioural change when the sink is absent.
2. New src/cli/progress.ts: a stderr progress reporter. Count-gated (silent below ~100 records, which is where a verify starts to exceed a couple of seconds on this machine), rate-limited to at most ~20 lines, plain 'approval: ...' lines in the muted role, no spinner and no ANSI cursor tricks. Deterministic: no elapsed times in the text.
3. Wire it into commandPolicyAmend: the pre-diff readVerifiedRecords gets the sink (first line names the step and the record count as soon as the file is split, well inside 1s), and baseline recovery is announced as its own step whenever the verify step spoke.
4. Tests (tests/cli-progress.test.ts): unit-test the reporter's line sequence; end-to-end amend --dry-run --json over a large log built through the real append path, asserting stdout is exactly the one canonical JSON line and equals the small-log run's stdout (only the --log path substituted), while stderr carries the count lines and is silent on the small log.
5. Survey every other verb that re-verifies before speaking (wait, status, run, audit, hook, daemon, log verbs) and record treated/skipped with reasons in the notes.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What changed

**core/verify.ts** — new optional `VerifyOptions.onProgress` sink (`VerifyProgress = { verified, total }`). `verifyText` calls it once with the total as soon as the file is read and split (before the first schema compile, which is where the seconds actually go), then `walk` calls it after each record it has vouched for. Counts are file-absolute, so a walk resumed behind the verified-read cache reports the same numbers a cold one would. Absent sink = byte-identical behaviour; the sink can only observe, never move a verdict. `readVerifiedRecords` forwards it with the rest of the verify options, so no state.ts change was needed.

**src/cli/progress.ts** (new) — the shared helper. `makeProgress({ err, style })` gives `chain(label)` (a sink) and `step(text)` (a countless step). Rules, all deliberate: plain `approval: …` lines in the muted role, one terminated line per write, no spinner/CR/cursor escapes (piped stderr and CI transcripts get the same bytes a terminal does); no elapsed times, so the lines are deterministic for tests; silent below 100 records (about where a cold verify passes a second and a half on this machine at ~10-15ms/record); at most ~20 checkpoints whatever the size; countless steps stay silent unless the chain sink already spoke, so a fast run prints nothing at all.

**Wiring** — amend's pre-diff `readVerifiedRecords` plus a `step()` around baseline recovery.

## Timing evidence (AC #1)

1200-record log, real repo, real attestation, `policy amend --dry-run --json`: first stderr line at **134ms** (`approval: verifying the log chain: 1200 records`), first stdout byte at **15433ms**. That 15s gap is exactly the silence the task is about; it is now narrated from 134ms in.

## Survey of the other walk-then-speak verbs (AC #3)

Same treatment applied (shared helper, 3-line wiring, `streams` and `style` already in hand):
- `policy amend` — src/cli/amend.ts:977 (the priority; also the baseline step).
- `log verify` — src/cli/main.ts:320. The verb whose entire job is the walk.
- `status` — src/cli/execute.ts:1033. Wired on the `verify()` call only; the `readVerifiedRecords` on the next line is the same bytes through the process cache and re-walks nothing.
- `queue` — src/cli/execute.ts:875.
- `wait` — src/cli/execute.ts:640, FIRST PASS ONLY. The poll loop re-reads through the cache and re-verifies only what was appended since; reporting every pass would be a line per interval for work that is not happening.
- `audit list` / `audit obligations` — src/cli/audit.ts:187, :395.
- `doctor` — src/cli/doctor.ts:1617. One walk shared by the attestation and log checks, and doctor is what a worried operator runs on a big log.

Reasoned skips:
- `audit review`, `audit reconcile`, `execution reconcile`, `run`, `request/grant/reject/revoke/withdraw/expire/register`, `consume`, `adapter <name>` — the read sits inside a core function (core/audit.ts, core/execute.ts, core/gate.ts:565 `readGateRecords`, core/token.ts) that takes no streams. Threading a sink through the core append paths is a core-API redesign, not the same small shape, and these are enforcement paths with no human staring at a blank terminal.
- `hook claude-code` / `hook cursor` (src/cli/hook.ts:1115, :1156, :1280, :1420) — machine-facing decision protocol; its stderr surfaces inside every agent turn, and count lines would land there for no reader.
- `daemon run` (src/daemon/daemon.ts:631) and `channel telegram listen` / `channel web` — long-lived services that already narrate per tick, and whose stderr is a structured service log free-form lines would pollute.
- `log tail` / `log export` (src/cli/main.ts:390) — dumps whose stdout is normally redirected; stderr noise on a redirect is unwelcome. Cheap to add later if asked.
- `token <key>` (src/cli/token.ts:205) — a single lookup nobody waits on interactively.
- `channel cli` (src/channels/tagging.ts:949 via TagOptions) — same shape but needs a new optional field on a channel-facing options type; left out to keep this diff to the verbs that read as frozen.
- `log advance` (src/cli/log-advance.ts:210) and `log sync` (src/cli/log-sync.ts:332, :553) — the verify lives inside a result-returning `*UnderLock` function, so it needs a sink parameter threaded in. `log sync` is the one verb that pays the walk twice (after a reconcile the bytes have moved, so the second walk is cold). Worth a follow-up task; not attempted here.

## Flagged for the human

Under `--json` on a log of 100+ records, stderr now carries progress lines BEFORE the refusal object when a refusal happens. The refusal is still the last line of stderr and stdout is untouched, but a consumer that parses the WHOLE of stderr as one JSON document would need the last line instead. Documented in docs/cli-reference.md under `policy amend`. The task asked for progress on stderr with `--json` stdout byte-unchanged, so this is the intended trade, called out rather than smoothed over.

Nothing here touches an invariant in SPEC §11: the sink is observational, the log is not read or written differently, and no self-reported field reaches any decision.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The silent pre-diff verify now narrates itself. core/verify.ts grew an optional, observational onProgress sink (file-absolute counts, called once with the total the moment the log is split and once per verified record); src/cli/progress.ts turns it into plain, rate-limited 'approval: verifying the log chain: N/M records' lines on stderr, silent below 100 records, with no spinner, no cursor escapes and no elapsed times. Wired into policy amend (plus a step line around baseline recovery) and, through the same helper, into log verify, status, queue, wait (first pass only), audit list, audit obligations and doctor; the rest are reasoned skips recorded in the notes.

Verified: on a 1200-record log built through the real append path, 'policy amend --dry-run --json' now prints its first stderr line at 134ms where the first stdout byte still arrives at 15.4s. tests/cli-progress.test.ts (8 cases) pins the line sequence, the bounded line count, the resumed-walk counts, the absence of control bytes, and the byte-comparison: the same amendment over a small log and over a 150-record log produce byte-identical --json stdout (only the --log path substituted), with the counts on stderr and stdout exactly one canonical JSON line. npm test: 2450 passing, 0 failing; oxlint clean.
<!-- SECTION:FINAL_SUMMARY:END -->
