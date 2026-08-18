---
id: APRV-78
title: 'approval setup adapter <name>, and setup adapter email'
status: To Do
assignee: []
created_date: '2026-08-18 08:12'
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
- [ ] #1 Non-TTY/--json exit 2 with the manifest-generated hint naming the resolved passphrase env; --help 0; missing/unknown name exit 2 listing email; passphrase unset exit 2 with the state-chosen command, nothing stored, no vault created
- [ ] #2 In-process: five names land in the vault, values assertable via getCredential in-test, .approval/env untouched, log byte-identical; validation refuses at exit 2 before storing (port range, security choice, user-without-password with checkEmailCredentialSet sentence); existing name asks to replace without showing a value and no leaves bytes identical
- [ ] #3 Probe [Y/n]: pass exit 0 reporting security+mechanism; fail exit 1 keeps values, prints reply code without credential and approval vault remove; declined exit 0 stored-and-unverified; mock SMTP via assertLoopback with TLS relaxation only in the test wrapper; suite secret sweep includes the SMTP password with no exemption
- [ ] #4 Docs and SPEC: examples/email-demo.md Step 3 leads with setup adapter email (vault set lines kept as by-hand); SETUP_HELP, SETUP_ADAPTER_HELP, SETUP_ADAPTER_EMAIL_HELP, ROOT_HELP; SPEC 10.1 line gains adapter <name> and 10.4 vault paragraph one sentence (flagged); e2e setup-path walk uses one in-process setup adapter email with the same log shape
<!-- AC:END -->
