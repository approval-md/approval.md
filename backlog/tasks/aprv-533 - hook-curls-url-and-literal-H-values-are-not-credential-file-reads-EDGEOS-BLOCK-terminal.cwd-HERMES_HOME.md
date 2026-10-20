---
id: APRV-533
title: >-
  hook: curl's --url and literal -H values are not credential file reads
  (EDGEOS-BLOCK, terminal.cwd = HERMES_HOME)
status: In Progress
assignee:
  - '@claude-approval-edge2'
created_date: '2026-10-20 11:58'
updated_date: '2026-10-20 12:25'
labels:
  - classifier
  - hook
  - credential
dependencies: []
ordinal: 405000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
EDGEOS-BLOCK, second half. Core 0.4.6's credential disk pass (refineCredentialReads / credentialReadLandings, APRV-522/524) judges every word credentialReadWords returns for curl, a -H value and a --url value included, as a path. A word still holding an unexpanded $ whose last component is the span ("Authorization: Bearer $EDGEOS_API_KEY") reads as a read of the working directory, and the configured-home spelling turns "${EDGEOS_API_BASE:-https://...}/events/..." into two unknown segments in a row; with terminal.cwd = $HERMES_HOME (every resident box) both add account.credential, which the overlay template keeps human-only. So every skills/edgeos curl recipe is denied from HERMES_HOME while allowed from $HOME. curl reads a header from a file only for -H @file, and a URL list only for --url @file (curl 8.13+); everything else in those two values is sent, never opened.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 With HOME=<tmp>/home/hermes, HERMES_HOME=<tmp>/home/hermes/.hermes (with .env and config.yaml) and terminal workdir = HERMES_HOME under the overlay's classes, the four EDGEOS curl shapes (Bearer $KEY / ${KEY} header, ${EDGEOS_API_BASE:-...} --url, Accept header) classify network.call/read.web and are allowed by approval hook hermes
- [x] #2 Still account.credential under the same layout: curl -H @.env, -H "$X", -H @"$F", -K "$C", -d @.env, -T .env, --url @.env, --url "$U", cat .env, grep -r KEY .
- [x] #3 Mutants: dropping the @ check on -H fails a test; adding -d to the exempt options fails a test
- [x] #4 fetch-output-unknown, argvWordUnknowable, fetchOutputs, expandHookWord and the pure classifier (credentialReadWords) unchanged
- [x] #5 CLASS-DIFF of the existing command-class/hook vectors plus the 63-recipe overlay corpus, base vs head at HERMES_HOME and HOME: only curl --url/-H cases move, account.credential away, nothing else moves
- [x] #6 CHANGELOG Unreleased names EDGEOS-BLOCK
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. hook.ts: curlValuesNotRead(bin,args) beside NON_OPENING_BINS: drops curl -H/--header/-HVALUE and wget --header values that open with neither @ nor a shell-expandable char nor file:, and curl --url literal values; returns span-led --url values separately. 2. credentialReadLandings: credentialReadWords over the filtered argv; spanned --url values judged with homeSpelled=false (no $HERMES_HOME re-spelling of the configured home). 3. resolvedPathClasses (Hermes per-call pass, read.* curl): same filter and same spanned judgement. 4. tests/cli-hook-credential-curl-values.test.ts under a fake box layout; mutants. 5. CHANGELOG Unreleased. 6. CLASS-DIFF base vs head over test literals + 63-recipe overlay corpus.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Found while building: the Hermes per-call pass (resolvedPathClasses) also adds account.credential for a read.web curl (shape b, literal --url, no -X) through the same header value, so the fix covers both passes; the brief named only the credential pass. curl 8.13.0 added --url @FILE (URL list from a file; curl man page), so --url takes the same @ rule as -H, and a span-led --url value is judged as the path an @/file: expansion would read rather than exempted: --url "$U" stays a credential read in HERMES_HOME. The only judgement change for span-led --url values is that the configured home is not re-spelled as $HERMES_HOME (that spelling made the known home an unknown segment and two unknowns in a row matched the approval vault row); with a literal last component and a span-led word, every Hermes row that needs the home name ends in a literal credential name, which the after-unknown rule still catches. wget shares the generic path, so wget --header gets the same literal-value rule (wget never reads a header from a file). Pure classifier, expandHookWord, fetch-output-unknown, argvWordUnknowable, fetchOutputs unchanged; global invariants: only ever adds classes as before, no invariant weakened (a credential read through these options is still found). Not covered (stricter, unchanged): -sH clusters, positional span-led URLs (curl -s "${B}/x" is policy.core by fetch-output-unknown on base and head). Pre-existing, not this task: curl -H "`cat h`" (backtick in a double-quoted header) finds no credential read on base either.

Validation: lint 0, typecheck 0, build 0; 12 targeted files one at a time all rc 0 (curl-values 6, credential-reads 24, command-class-credential-reads 11, sentinel-credential 24, hermes-home-organs 32+27, hermes-rules 22, hermes 42, write-scope 10, command-class 633, exec-code 29+14); npm test exit 0 (6828 tests, 6816 pass, 0 fail, 11 skipped, 1 todo). New test file fails on base (4 of 6 tests; denied account.credential human-only). Mutants: drop the @ check -> fails (curl -H @.env); add -d to the -H rule -> fails (curl -d .env). CLASS-DIFF: 2376 commands x {HERMES_HOME, HOME} = 4752, 25 changed, all curl/wget -H/--url losing account.credential; PR #666.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
curl -H/--header, curl --url and wget --header values that curl/wget send as written are no longer judged as file reads by the credential disk pass or the Hermes per-call pass; span-led --url values are judged as the path an @/file: expansion would read. Fixes the EDGEOS-BLOCK denial of every skills/edgeos curl recipe from terminal.cwd = HERMES_HOME. Verified by a box-layout hook test that fails on base, two killed mutants, the targeted suites, npm test exit 0, and a base-vs-head class diff whose only moves are curl/wget account.credential removals.
<!-- SECTION:FINAL_SUMMARY:END -->
