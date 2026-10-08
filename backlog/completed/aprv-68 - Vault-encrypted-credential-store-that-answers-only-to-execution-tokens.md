---
id: APRV-68
title: 'Vault: encrypted credential store that answers only to execution tokens'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-17 21:40'
updated_date: '2026-08-17 22:55'
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
- [x] #1 approval vault set|list|remove (human-only) manage named credentials in an encrypted file; list never prints values; no credential value ever appears in the log, any output, or any test fixture
- [x] #2 Vault read is only reachable through the adapter execute path after token verification; a direct read without a verified-token context is refused with a distinct code and tested
- [x] #3 doctor reports vault presence, decryptability, and gitignore status; init scaffolds the gitignore line
- [x] #4 Threat model stated in module and SPEC 10.4; passphrase supplied by env var name only
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, worktree from aprv-67 branch (needs CredentialProvider). 2. src/core/vault.ts: AES-256-GCM over a JSON map of named credentials, key via scrypt from a passphrase read from the env var named by policy (vault.passphrase_env, additive vocabulary; schema+SPEC same-commit) or APPROVAL_VAULT_PASSPHRASE default; file .approval/vault.enc; header carries salt, nonce, kdf params, version. 3. src/adapters/vault-provider.ts implements CredentialProvider: opens the vault lazily inside get(), scoped by the contract window. 4. Human-only verbs approval vault set|list|remove (list names only). 5. doctor check: presence, decryptable with env passphrase, gitignored. 6. Threat model in module + SPEC 10.4 wording. Tests: round-trip, wrong passphrase refused, tamper (GCM tag) refused, no value in any output/log/fixture. PR.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Opus subagent build, PR #35. File: .approval/vault.enc beside the log dir (derived like the payload store), JSON header {version, kdf{scrypt N=16384 r=8 p=1 salt}, nonce, tag, ciphertext}, AES-256-GCM over the name->value map; AAD binds the header (version, kdf, nonce) so a header-only edit fails authentication (added beyond the brief); KDF params read from the file and BOUNDED on read (N power of two in [2^12,2^20], r<=32, p<=16) so a hostile header is malformed, not a DoS; fresh nonce per write, salt reused; temp wx 0600 + rename. Names inside the ciphertext, so file access reveals neither names nor values (tested). Passphrase from the env var named by new policy key vault.passphrase_env (default APPROVAL_VAULT_PASSPHRASE; schema+SPEC 5.2 bullet+fixtures both ways). Human-only approval vault set|list|remove (value via stdin or --value-env, never a flag; list never prints values); getCredential is the only value-returning export, pinned by source scan; vault provider implements CredentialProvider and maps refusals by repair (absent/passphrase-unset/credential-absent/invalid-name -> credential-unavailable; a vault that exists and will not open -> credential-refused). vault-unreadable deliberately conflates wrong passphrase with tampered file (distinguishing publishes an oracle). Doctor check 10 vault: gitignore first (a vault one git add -A from publication is the fault that survives fixing everything else), then passphrase, then decrypt, then pass with COUNT only. INVARIANT 3 FINDING: the whole-suite stdout/stderr/log scan for the secret caught a real leak during development (approval vault set <name> <secret> echoed the stray positional in its usage error) — fixed; that message deliberately does not echo. Threat model in SPEC 10.4 paragraph + three module headers: defends at rest and casual reads; does not defend a compromised host or an agent that can read the passphrase variable. Reviewer-weigh: provider caches the decrypted value for its lifetime (one act by design; ~100ms scrypt otherwise); passphrase-env NAME falls back to the default when the policy fails to load (argued: a name is not a permission); remove-on-missing refuses; no log event for vault ops (SPEC decision if rotation should be auditable); repo .gitignore gained vault.enc. README verb table lacks vault (README follow-up). SPEC 5.2 bullet and 10.4 paragraph flagged for review. +64 tests; 1333 composed.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
AES-256-GCM/scrypt credential vault with header-bound AAD and bounded KDF, human-only set/list/remove, values reachable only through the contract-scoped provider inside the token window, doctor check, threat model stated. A real leak was caught by the suite-wide secret scan during development. PR #35.
<!-- SECTION:FINAL_SUMMARY:END -->
