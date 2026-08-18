---
id: APRV-73
title: .approval/env source map and approval env
status: To Do
assignee: []
created_date: '2026-08-18 01:38'
labels: []
milestone: m-10
dependencies:
  - APRV-72
priority: high
type: feature
ordinal: 72000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Configuring the runtime takes five-plus values, each stored somewhere different, each exported per terminal. This gives them one declared home and keeps secrets in the OS keystore. Human-approved design: .approval/env is a SOURCE MAP from variable NAME to where the value lives (keychain:<service> via security find-generic-password; secret-service:<label> via secret-tool; env: meaning inherited; or a bare literal), mode 0600, gitignored. NO VERB LOADS IT IMPLICITLY: APPROVAL_HUMAN is human identity in v0.1, so a working-tree file that could set it would let any writer of that file act as the human on every human-only verb; the file is inert until a human evaluates approval env in their own shell. Literals are permitted (a rule people route around is not a control) and reported as plaintext by every diagnostic. Vault-as-config-store rejected: getCredential is the vault one value-returning export scoped to the adapter token window. This task births Global invariant 7 (configuration is never loaded implicitly from the working tree): SPEC 11.1 entry drafted, and the matching CLAUDE.md Engineering-invariants bullet DRAFTED FOR THE HUMAN HANDS in the notes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 core/env-file.ts parses KEY=VALUE, comments, blanks; no interpolation; duplicate key and unknown scheme refused; frozen refusal-code union; resolvers for keychain, secret-service, env, literal with distinct codes for missing helper vs missing item; no value ever in argv
- [ ] #2 approval env prints a header plus shell-quoted export lines (eval-safe for quote, dollar, backtick, newline, pinned); unresolved vars printed as comments naming the fixing verb; --check prints NAME/status/source with no values on any path and exits 1 when a named var is unresolvable; --json carries values, --json --check names only; a literal secret is reported as plaintext
- [ ] #3 The variable set is APPROVAL_HUMAN, policy-resolved telegram names, vault.passphrase_env, audit.sampling_secret_env when named, any other *_env the policy declares
- [ ] #4 A test spawns doctor, policy attest, and channel telegram health in a dir with a complete .approval/env and asserts none picked anything up; env refuses a file not mode 0600 and prints the chmod; init gitignores .approval/env; secret sweep over all captured output
- [ ] #5 SPEC 5.2 environment-map bullet, 10.1 line, 11 paragraph, 11.1 invariant 7 drafted same-commit for sign-off; CLAUDE.md invariant bullet drafted in notes for the human
<!-- AC:END -->
