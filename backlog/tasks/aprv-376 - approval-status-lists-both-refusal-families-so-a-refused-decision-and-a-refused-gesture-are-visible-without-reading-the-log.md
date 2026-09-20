---
id: APRV-376
title: >-
  approval status lists both refusal families, so a refused decision and a
  refused gesture are visible without reading the log
status: In Progress
assignee:
  - '@opus-lane-376'
created_date: '2026-09-19 10:59'
updated_date: '2026-09-20 10:54'
labels:
  - audit
  - cli
  - status
dependencies: []
priority: low
ordinal: 291000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Filed on the orchestrator ruling of 2026-09-19 while landing APRV-355. Neither audit.decision_refused (APRV-235) nor audit.gesture_refused (APRV-355) is listed by approval status or approval audit today; both are visible only through approval log tail and approval log export. APRV-355 AC4 originally asked for a listing and was reworded rather than built, on the reasoning that adding one for the newer record alone would leave the older one invisible and the two inconsistent. Add the listing for BOTH families at once: a count of each in approval status informational fields, with the newest few seqs and their codes, so an operator who is told that taps from an account they did not map are being refused can see how many and from which account without reading the chain. Informational only, like coverage and anomalies: it moves neither the health verdict nor the exit code, and it reads only verified records. Related: APRV-235, APRV-324, APRV-355.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 approval status reports a count of audit.decision_refused and of audit.gesture_refused records, each with the newest few seqs and their refusal codes, in the JSON and the human rendering
- [x] #2 The fields are informational: they move neither healthy nor the exit code, and a log with none of either omits them rather than printing zeros
- [x] #3 Only verified records are read, and docs/cli-reference.md describes the fields under status
- [x] #4 Tests cover both families present, one present, and neither; build, typecheck, lint and the status suite pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read the status verb (commandStatus in src/cli/execute.ts), its informational neighbours (harness outcomes, coverage, payload store, anomalies), the registry output schema for status, both refusal writers, and the status suite. Done.
2. Add a local projection helper beside gitCoverageSummary in src/cli/execute.ts: one pass over the verified records, filtering audit.decision_refused and audit.gesture_refused, returning per family a count and the newest five entries, each carrying seq, the payload code verbatim, and the observed sender when the record has one. Status imports neither refusal module: it filters on the event name, so no enforcement-adjacent import appears and the module-graph tests in the two refusal suites stay true.
3. Wire it into commandStatus. Informational: it is absent from the healthy conjunction and from the exit code. A family with no records is omitted, and the whole field is omitted when neither family has any, exactly as anomalies and indeterminate are omitted, so a log with no refusals emits the object it always emitted byte for byte.
4. Human rendering: one refusals row, printed only when there is something to report, with the per-family counts on the right and one under-line per recent entry naming the family, the seq, the code and the account. The row is omitted entirely when both families are empty, so the default table is unchanged.
5. Declare the field in the status output schema in src/cli/verb-registry.ts as an optional property, so tests/cli-instructions.test.ts validates live output against it. Mention the field in STATUS_HELP without adding a line, since that help sits exactly on the 25-line cap.
6. Document the field under status in docs/cli-reference.md: its own paragraph, a bullet in the field list, and a key in the JSON example.
7. Tests in tests/cli-status.test.ts: both families present, decision only, gesture only, neither. A refused decision comes from the real CLI surface (grant with a reaction and no note refuses reaction-note-required and appends one record); a refused gesture comes from recordRefusedGesture, whose only surface today is the Telegram listener, called against the same log through the real append path with real schema validation. No line is written by hand. Each case asserts healthy and the exit code are unmoved and runs log verify afterwards.
8. Verify: build, typecheck, lint, the status suite, cli-instructions, the two refusal suites, help and long-help suites, then a full test run compared against the known baseline.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Shipped: both refusal families in `approval status`, as one informational field.

WHAT IT LOOKS LIKE. The JSON gains `refusals`, keyed by family: `decision` for `audit.decision_refused` (APRV-235) and `gesture` for `audit.gesture_refused` (APRV-355). Each family carries `count`, every record of that family in the log, and `recent`, the newest five newest-first, each entry naming `seq`, the surface code verbatim, and the observed `sender` when the record carries one. The human table gains one row whose right side is the per-family counts and whose under-lines are the same entries, family padded so the seqs line up:

refusals   1 decision, 1 gesture (reported; health unaffected)
  decision  seq 4  reaction-note-required
  gesture   seq 5  sender-unmapped  telegram:5551234567

THREE JUDGMENT CALLS, made without waking anybody.

1. THE SENDER IS IN THE LISTING, which AC1 does not ask for and the description does: the operator being served was told that taps from an account they did not map are being refused, and wants to know how many AND from which account. A row that answered the first half would send them to the chain for the second. It is reported in the form the record carries it, so an APRV-370 keyed digest keeps its `hashed` marker and prints as `(keyed)`: a digest and a raw account id call for different repairs, re-keying against adding the account to a senders block.

2. NO ZEROS ANYWHERE, including per family. AC2 asks that a log with neither family omit the fields; I read that through to the family, so a log with one family present reports that one alone and the other key is absent rather than zero. Same reason `anomalies` and `indeterminate` are omitted rather than empty. The consequence for consumers is stated in both the schema and the reference: `refusals.decision` can be absent while `refusals.gesture` is present.

3. THE HUMAN ROW IS OMITTED ENTIRELY when there is nothing to report, rather than printing "none" the way the anomalies and window rows do. A row saying none on every healthy repository is a row an operator learns to skip, and the side effect is that every existing text-mode expectation stays byte-identical on a log with no refusals.

STATUS IMPORTS NEITHER WRITER. The two event names are string literals in src/cli/execute.ts rather than imports from the two refusal modules. The whole safety argument for both records is that nothing which decides reads them, and the two suites that pin it read the module graph, so a report that filters on a string needs no exemption added to those lists. It is the standing `approval doctor` already has for `audit.question_preempted` (APRV-378): reading a record in order to report it is a diagnosis, not enforcement.

WHERE THE TESTS GET THEIR RECORDS. A refused decision comes from the real CLI surface: `approval grant --reaction loved` with no note is refused `reaction-note-required`, the decision surface appends one `audit.decision_refused`, and the request stays pending, which makes it the cheapest real producer of the record. A refused gesture has exactly one writer today, the Telegram checkpoint and review handlers, and reaching it needs a mock Bot API server; that surface is already proved in tests/checkpoint-tap.test.ts and tests/channels-telegram.test.ts, so these tests call `recordRefusedGesture` directly, which is the same real append path through the same write boundary. Nothing writes a jsonl line by hand. Two boundary facts the schema corrected on the first pass: a `--json` gate refusal prints its object on stderr, and a keyed sender id must be the whole `hmac-sha256:` plus 64 hex string.

ONE TEST BEYOND THE FOUR CRITERIA. A refusal-bearing status object is validated against the registry output schema inside the status suite. The both-directions pin of APRV-85 drives a world that refuses nothing, so the live shape it validates is the shape without this field, and a declared field no capture ever carries is a declaration nothing checks.

STATUS_HELP sits exactly on the 25-line cap the long-help suite enforces, so the field is named inside the existing paragraph rather than on a new line.

INVARIANTS TOUCHED, SPEC section 11.1. Invariant 1, enforcement paths read only verified records: the field is derived from the same readVerifiedRecords result every other projection in status reads, so a log that does not verify reports no refusals rather than some it cannot stand behind, and a test pins that by tampering with a line and asserting the field disappears. Invariant 6, refusals stay machine-readable and distinct: the code is copied verbatim, and the report schema spells it as a plain string rather than carrying a third copy of the two closed unions, which live at the write boundary and in the two core modules. Nothing here appends, settles, charges or samples, so the field is outside the `healthy` conjunction and outside the exit code, which two tests assert directly.

KEPT OUT OF SCOPE. `approval audit` still lists neither family; this task asks only for status, and the diff is status, its schema, its help, its tests and its docs.

VERIFICATION. Build, typecheck and lint each exit 0. tests/cli-status.test.ts: 25 tests, 25 pass, 0 fail, exit 0, eight of them new. Targeted matrix across cli-status, cli-instructions, cli-help, cli-long-help, decision-refusal, gesture-refusal and event-schema: 119 tests, 119 pass, 0 fail, exit 0, and the better-sqlite3 ABI failure this machine sometimes shows in the registry check did not appear. Full run: 4866 tests, 4843 pass, 22 fail, 1 skipped; all 22 are this environment's pre-existing email and SMTP adapter failures (the TLS server name set to an IP address), matching the documented baseline, and none of them sits in a file this task touches.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
approval status now reports both refusal families as one informational field, refusals, keyed decision and gesture, each carrying a count and the newest five seqs with their codes and the observed account, in the JSON and in the human table. A family with none is absent and the field is absent entirely when both are; it sits outside healthy and outside the exit code and is derived from the verified read. Declared in the status output schema so the registry check validates it, and described under status in docs/cli-reference.md. Verified by 25 tests in the status suite, eight of them new, covering both families present, each alone, neither, the five-entry cap, a keyed sender, schema validation of a refusal-bearing object, and a log that does not verify; build, typecheck and lint each exit 0, and the full run matches the known baseline of 22 pre-existing email and SMTP failures.
<!-- SECTION:FINAL_SUMMARY:END -->
