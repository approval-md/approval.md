---
id: APRV-68
title: 'Vault: encrypted credential store that answers only to execution tokens'
status: To Do
assignee: []
created_date: '2026-08-17 21:40'
labels: []
milestone: m-9
dependencies:
  - APRV-67
priority: high
type: feature
ordinal: 67000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC 10.4: adapters hold credentials in an encrypted vault, and credentials only answer to tokens; SPEC 11 defended list assumes it. This task builds the reference vault with zero new runtime dependencies (node:crypto): an encrypted file (AES-256-GCM, key derived via scrypt from an operator passphrase or read from an operator-held env var/keychain-populated variable, mirroring the sampling-secret and Telegram conventions: the policy names the variable, never the value), holding named credentials (smtp password, API keys). Read path: an adapter opens the vault only inside execute(), after token verification succeeds, and only for the credential name its class needs; the vault never returns bytes to any caller without a verified-token context (a structural refusal, not a convention). Write path: human-only verbs approval vault set|list|remove (list shows names, never values), identity rules as attest. Never in the log, never in any output, never in the repo (.approval/vault.enc gitignored by init; doctor checks presence, decryptability with the env passphrase, and that it is gitignored). Threat-model paragraph in the module: what the vault defends (credentials at rest, casual reads by an agent with file access) and what it does not (a compromised host, an agent that can read the passphrase env var — stated plainly per SPEC 11). SPEC 10.4 wording drafted for review.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval vault set|list|remove (human-only) manage named credentials in an encrypted file; list never prints values; no credential value ever appears in the log, any output, or any test fixture
- [ ] #2 Vault read is only reachable through the adapter execute path after token verification; a direct read without a verified-token context is refused with a distinct code and tested
- [ ] #3 doctor reports vault presence, decryptability, and gitignore status; init scaffolds the gitignore line
- [ ] #4 Threat model stated in module and SPEC 10.4; passphrase supplied by env var name only
<!-- AC:END -->
