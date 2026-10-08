---
id: APRV-78
title: 'approval setup adapter <name>, and setup adapter email'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-18 08:12'
updated_date: '2026-08-18 08:49'
labels: []
milestone: m-10
dependencies:
  - APRV-77
priority: high
type: feature
ordinal: 77000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The gap APRV-76 recorded in the human words: setup has no story for adapter credentials. Human-approved design: adapter credentials go to the VAULT via setCredential (SPEC 10.4; the email adapter reads all five names from one place by design), nothing to .approval/env or the keystore; the passphrase must be set in this shell like vault set (never resolve the source map implicitly, invariant 7), unset -> exit 2 printing approval setup vault or eval approval env chosen by state. Manifest: new core/credential-spec.ts holds the CredentialSpec type only (NOT on the frozen Adapter interface); email.ts exports EMAIL_CREDENTIAL_SPECS derived from DEFAULT_CREDENTIAL_NAMES (agreement pinned) and checkEmailCredentialSet; registry cli/setup-adapter.ts. Shared flow cli/setup-flow.ts runCredentialFlow with TWO destinations from the first commit (vault; env-file) and hooks collect/discover/verify so telegram fits later. Order: front, requireHuman, prerequisite line, checklist, PREFLIGHT (open the vault before any password is typed), planReplacements, collect in manifest order (config readLine+validate; choice numbered picker; secret readSecret), check, write password last with no rollback, verify, report. Verify hook = probeSmtp default [Y/n]; failure exit 1 keeps values and prints approval vault remove as undo. Non-interactive hint generated from the manifest (the five vault set --value-env lines with the resolved passphrase env). The secret entering this process for the vault is stated as an explicit exception in setup.ts module doc.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Non-TTY/--json exit 2 with the manifest-generated hint naming the resolved passphrase env; --help 0; missing/unknown name exit 2 listing email; passphrase unset exit 2 with the state-chosen command, nothing stored, no vault created
- [x] #2 In-process: five names land in the vault, values assertable via getCredential in-test, .approval/env untouched, log byte-identical; validation refuses at exit 2 before storing (port range, security choice, user-without-password with checkEmailCredentialSet sentence); existing name asks to replace without showing a value and no leaves bytes identical
- [x] #3 Probe [Y/n]: pass exit 0 reporting security+mechanism; fail exit 1 keeps values, prints reply code without credential and approval vault remove; declined exit 0 stored-and-unverified; mock SMTP via assertLoopback with TLS relaxation only in the test wrapper; suite secret sweep includes the SMTP password with no exemption
- [x] #4 Docs and SPEC: examples/email-demo.md Step 3 leads with setup adapter email (vault set lines kept as by-hand); SETUP_HELP, SETUP_ADAPTER_HELP, SETUP_ADAPTER_EMAIL_HELP, ROOT_HELP; SPEC 10.1 line gains adapter <name> and 10.4 vault paragraph one sentence (flagged); e2e setup-path walk uses one in-process setup adapter email with the same log shape
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, worktree from aprv-77 branch. 2. core/credential-spec.ts; email.ts EMAIL_CREDENTIAL_SPECS + checkEmailCredentialSet; cli/setup-flow.ts runCredentialFlow with vault + env-file destinations and collect/discover/verify hooks; cli/setup-adapter.ts registry with the email entry, manifest hint, probeSmtp verify; setup.ts adapter branch, SetupDeps env + probe seams, module-doc exception. 3. Help, SPEC 10.1/10.4, examples/email-demo.md Step 3, e2e setup-path walk. 4. Tests per ACs. PR.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Opus subagent build, PR #47. core/credential-spec.ts type only (not on the frozen Adapter interface); EMAIL_CREDENTIAL_SPECS derived from DEFAULT_CREDENTIAL_NAMES with agreement pinned; checkEmailCredentialSet is one sentence now also called by act (takes optional names for credentialNames overrides; treats empty string as absent, stricter than the old inline rule and matching its purpose: reviewer-weigh). setup-flow.ts runCredentialFlow: vault AND env-file destinations from the first commit (env-file unit-tested now, adopted by telegram in 79); hooks collect/check/verify(values, progress) so a partial re-run is not probed against a stale set (the alternative reads values back out of the vault, the journey there is deliberately no verb for); planReplacements generalized as planWrites + reportLeftAlone + PLAN_PHRASES with sentences byte-identical. setup-adapter.ts: registry with email; front -> requireHuman -> passphrase required in THIS shell (invariant 7; unset exits 2 printing setup vault or eval env chosen by state; nothing stored) -> checklist -> PREFLIGHT opens the vault before any password is typed -> replace prompts -> collect -> check -> write password last no rollback -> probeSmtp [Y/n] (fail keeps values, redacted code, vault remove as undo) -> report names never values. Manifest-generated hint. SPEC 10.1 line + 10.4 sentence drafted (flagged). examples/email-demo.md Step 3 leads with setup adapter email. e2e setup-path walk uses one in-process setup adapter email. KNOWN: setup.ts <-> setup-adapter.ts ESM cycle (hoisted functions only; safe); extraction of front/requireHuman/usageError into a shared setup-common.ts is a named AC of APRV-79 which adds setup-channel.ts and touches the same code. +18 tests, 1502.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
approval setup adapter <name> driven by an adapter-declared manifest, email as the first instance: vault destination, passphrase-in-shell, preflight, validated collection, probe-with-kept-values, manifest hint; docs and SPEC updated. PR #47.
<!-- SECTION:FINAL_SUMMARY:END -->
