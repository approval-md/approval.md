---
id: APRV-362
title: >-
  Bridge binds argv, not a rendering: record the re-parse of the shell-joined
  command beside the received string so a mismatch is visible
status: Done
assignee:
  - '@claude'
created_date: '2026-09-18 01:30'
updated_date: '2026-09-19 15:02'
labels:
  - codex
  - bridge
dependencies:
  - APRV-361
priority: medium
ordinal: 279000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From docs/codex-app-server-bridge.md follow-up 2 (APRV-349). The item-based API delivers command as one shell-joined string (observed 2026-09-18: /bin/zsh -lc with the model command quoted inside), while the legacy API delivers argv. The classifier reads argv. Decide between the two APIs for the bridge; if the item-based string is what the bridge must consume, re-parse it, record the re-parse alongside the received string in the registered payload, and refuse with a distinct code when the re-parse cannot round-trip to the received bytes. proposedExecpolicyAmendment carries the argv the server itself would apply and is a candidate source to compare against.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The registered payload carries both the received command string and the argv the bridge classified, and a round-trip mismatch is refused with its own machine-readable code
- [x] #2 Tests cover quoting edge cases (single and double quotes, redirections, heredoc markers) against the recorded probe requests
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. New pure module src/core/shlex.ts: shlexSplit (whitespace separates, single-quoted runs literal, backslash escapes the next character; refuses an unterminated quote, a bare double quote and a trailing backslash) reporting joinShaped, shlexJoin (minimal quoting, the single-quote idiom), shlexRoundTrips.
2. src/cli/codex-bridge.ts: bindCommand replaces commandOf and returns the received string AND the argv. The item-based string is un-joined; a legacy argv array is rendered word by word rather than concatenated. A string that is not readable as a join is refused with a new code.
3. New BRIDGE_REFUSAL_CODES entry bridge-command-unbound; refusal-unions major bump to 15.0.0 with its note in scripts/regen-conformance-vectors.mjs, and the manifest regenerated in the same commit.
4. The payload: the bridge puts argv on tool_input beside command (the shape APRV-363 established for the change map). codexArgv in src/cli/hook-codex.ts accepts it ONLY when the command splits to exactly it, so it is a derivation of bytes already bound; describeToolCall refuses a call whose two accounts disagree.
5. Tests: tests/shlex.test.ts unit table plus a 1331-argv property sweep; tests/codex-bridge.test.ts end-to-end for the bound payload, the legacy array, and the refusals; tests/cli-hook-codex.test.ts for the agreement rule.
6. Docs: docs/codex-app-server-bridge.md follow-up 2 marked landed, docs/cli-reference.md refusal table.
7. build, typecheck, lint, npm test, npm run conformance.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
WHAT LANDED. The bridge names the words a command will run, not only their rendering. src/core/shlex.ts is a new pure module (shlexSplit / shlexJoin / shlexRoundTrips); src/cli/codex-bridge.ts gained bindCommand, which replaces commandOf and returns the received string AND the argv; the registered payload carries both.

THE API DECISION THE TASK ASKED FOR. The bridge drives the ITEM-BASED API (thread/start, turn/start), so the shell-joined string is what it must consume, and the decision is settled by which API the verb speaks rather than by preference. The legacy argv array is still read, because a request in that shape is one this client can answer, but it is not the path in use.

DECISION 1, and it is the one a reviewer should look at hardest. The round trip is argv to string to argv, NOT received-bytes equality. A byte comparison would require pinning the counterpart quoting predicate: docs/codex-app-server-bridge.md records exactly one command string and it is consistent with every candidate predicate, and a join written for shell safety quotes more characters than a minimal one does. Under byte equality a genuine server string whose URL argument arrived single-quoted would be refused, because this runtime renders that word bare. That is a false refusal on live traffic bought with a guess. What IS required is the part that is checkable without knowing which characters the counterpart quoted: the string must be readable as a join and join-shaped (words separated by exactly one space, none leading or trailing), and the argv must render and re-split unchanged. Everything else is recorded rather than asserted, which is why the payload carries both values. If the orchestrator wants the stricter reading of AC1, the change is one line plus a recorded observation of the predicate, and it should not be made before that observation exists.

DECISION 2. proposedExecpolicyAmendment is NOT read, though the description names it as a candidate second source. The 2026-09-18 run recorded that the field was PRESENT and recorded nothing about its shape. A comparison written against a guessed shape silently matches nothing while looking like a check, which is the same trap APRV-379 is blocked on.

DECISION 3, and this is what the diff hides. The argv reaches the payload through tool_input.argv, the shape APRV-363 established for the change map, rather than a private channel. tool_input on a NATIVE Codex event is the model own tool-call arguments, so a model could put an argv there. codexArgv in src/cli/hook-codex.ts therefore accepts an argv ONLY when the command string splits to exactly it, which makes the field a DERIVATION of bytes already bound rather than a second claim beside them; describeToolCall refuses (hook-io) a call whose two accounts of itself disagree rather than resolving in favour of either. A call with no argv binds byte for byte as it did before this task: the key is absent from the payload, not present and empty, so no existing payload hash moved.

A REAL BUG FIXED IN PASSING. commandOf joined a legacy argv array with a plain space, so a three-word argv whose last word was a whole script became five separate words, which is a different command to the classifier and one the kernel will never see. It is now rendered word by word with the script word quoted. Pinned by a test.

SPEC SECTION 11 INVARIANTS TOUCHED. Invariant 4 (self-reported fields never reduce scrutiny) and invariant 7 (refusals machine-readable and distinct). Invariant 4 is held by construction rather than by care: the argv cannot say anything the command does not already say, classification still runs on the command string, and the new field can only add a refusal. Invariant 7: bridge-command-unbound is a fourth code rather than a widening of bridge-request-unbound, because that one says a field is MISSING and this one says a field ARRIVED and could not be read as the rendering of an argv, and the repairs differ.

CONFORMANCE. refusal-unions 14.0.0 to 15.0.0 (major: the vector pins each whole array in definition order), the note added to scripts/regen-conformance-vectors.mjs, and the manifest regenerated in the same commit. No schema change: the payload shape is open at v0.1.

OBSERVED, OUT OF SCOPE, WORTH A TASK. The zsh and bash binaries are OPAQUE_BINS in src/core/command-class.ts, so the shape the probe recorded (a login shell with the script as one quoted argument) is refused hook-unclassified by the bridge today. That is pre-existing from APRV-361, it is fail-closed, and it means the bridge currently declines the most common real Codex exec shape. Not fixed here; reported to the orchestrator.

VERIFIED. build, typecheck and lint clean; conformance 390/390 with 161 negative controls; the full suite 4708 pass and 45 fail, exit 1, where the 45 are the pre-existing Node 26 SMTP failures in adapter-email, cli-setup and smtp-probe, identical in count and suite to the pre-change baseline measured on this laptop (4677 pass / 45 fail). CI on Node 22 is the truth for those.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The bridge binds the argv a command will run, not only the string that renders it. A new pure module src/core/shlex.ts un-joins the item-based API shell-joined command; the registered payload carries the received string and the argv side by side; a string that is not readable as a join is refused with the new bridge-command-unbound. A legacy argv array is now rendered word by word rather than concatenated, which fixes a real misclassification. Verified by 16 new unit cases including a 1331-argv property sweep, 5 new end-to-end bridge cases, 1 new hook case, conformance 390/390 with refusal-unions majored to 15.0.0, and build, typecheck and lint clean.
<!-- SECTION:FINAL_SUMMARY:END -->
