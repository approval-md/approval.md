---
id: APRV-99
title: >-
  setup adapter email: probe after a partial re-run using the adapter's own
  vault read
status: Done
assignee:
  - '@fable'
created_date: '2026-08-18 21:32'
updated_date: '2026-08-19 15:48'
labels:
  - cli
  - ux
dependencies: []
ordinal: 91000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed running examples/email-demo.md (2026-08-18): after replacing only smtp.password (and smtp.host) the verb declined to probe: 'not verified: smtp.port, smtp.security, smtp.user were left alone this run, so this verb does not hold the whole configuration, and it will not read the missing values back'. The rule (setup-flow never reads a credential out) is sound for PRINTING, but the adapter itself reads the whole set from the vault at send time; a probe that opens the vault through the same in-process path (adapters/email.ts credential read, values never leaving the process) is no wider than the send. Proposal: on a partial re-run, offer 'open an SMTP session using the stored configuration to check it? [Y/n]' and run probeSmtp over the merged set read the way the adapter reads it. Keep the current refusal text as the fallback when the vault cannot be opened. Rotating an app password is the common case for this verb, and it deserves the same proof as first setup.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A partial re-run offers a probe over the stored configuration, read through the adapter's own vault path; nothing is printed
- [x] #2 First-run behaviour unchanged; scripted-prompter tests cover the partial case
- [x] #3 npm test and lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, worktree from main. 2. setup adapter email partial re-run: offer the probe prompt (reprompt on bad answer), read the merged set through the adapter credential path (one vault reader), run the existing SMTP probe, report as first-run does; nothing printed. 3. Vault unopenable: today text verbatim plus one reason line. 4. First run byte-identical. 5. Scripted-prompter tests for yes/no/unopenable/reprompt. 6. Help line under the cap, rationale in cli-reference. 7. PR by branch, auto-merge; records here.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Opus subagent build, PR by branch aprv-99-setup-email-probe (#81). readEmailSmtpConfig extracted from the email adapter act path (names, read order, port/security validation, pair rule, redaction corpus; bytes unchanged) and reused by setup over vaultCredentialProvider, the same factory src/cli/adapter.ts hands to executeThroughAdapter, so core/vault getCredential still has exactly one caller. Partial re-run: confirmUntil prompt "open an SMTP session using the stored configuration to check it? [Y/n]" (default yes, reprompt on a bad answer, EOF is no); probeAndReport shared with first run so the report text is identical; declining prints today refusal verbatim; an unopenable vault or unusable stored config prints it verbatim plus one "the probe could not run" line scrubbed with this run values. SetupDeps.credentials is a test seam (the flow proves the passphrase at preflight, so the fallback is otherwise unreachable). Exposure judgement recorded: the probe reads what every send reads, in process, printing nothing, so it is no wider than the send it proves. Tests: 4 new in cli-setup (probe over merged set asserts the mock saw the kept user with the new password and no MAIL/RCPT/DATA; decline; unopenable; reprompt); three pre-existing partial scripts gained the new answer; first run unchanged. 1787 tests, lint and typecheck clean.

Merged at 7e39822 via auto-merge behind ci.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
setup adapter email offers the SMTP probe on a partial re-run, reading the merged configuration through the adapter's own vault path and printing nothing; first run unchanged. PR #81 merged at 7e39822; verified by four new scripted-prompter tests, 1787 tests, lint, typecheck.
<!-- SECTION:FINAL_SUMMARY:END -->
