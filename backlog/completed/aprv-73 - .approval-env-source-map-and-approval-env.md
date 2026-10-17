---
id: APRV-73
title: .approval/env source map and approval env
status: Done
assignee:
  - '@fable'
created_date: '2026-08-18 01:38'
updated_date: '2026-08-18 02:23'
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
- [x] #1 core/env-file.ts parses KEY=VALUE, comments, blanks; no interpolation; duplicate key and unknown scheme refused; frozen refusal-code union; resolvers for keychain, secret-service, env, literal with distinct codes for missing helper vs missing item; no value ever in argv
- [x] #2 approval env prints a header plus shell-quoted export lines (eval-safe for quote, dollar, backtick, newline, pinned); unresolved vars printed as comments naming the fixing verb; --check prints NAME/status/source with no values on any path and exits 1 when a named var is unresolvable; --json carries values, --json --check names only; a literal secret is reported as plaintext
- [x] #3 The variable set is APPROVAL_HUMAN, policy-resolved telegram names, vault.passphrase_env, audit.sampling_secret_env when named, any other *_env the policy declares
- [x] #4 A test spawns doctor, policy attest, and channel telegram health in a dir with a complete .approval/env and asserts none picked anything up; env refuses a file not mode 0600 and prints the chmod; init gitignores .approval/env; secret sweep over all captured output
- [x] #5 SPEC 5.2 environment-map bullet, 10.1 line, 11 paragraph, 11.1 invariant 7 drafted same-commit for sign-off; CLAUDE.md invariant bullet drafted in notes for the human
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, worktree from aprv-72 branch. 2. core/env-file.ts parser + resolvers with frozen refusal union; cli/env.ts verb; scaffold gitignore entry; help; SPEC 5.2/10.1/11/11.1 drafts. 3. Tests incl. no-other-verb-reads-it, eval-safety, mode refusal, secret sweep. 4. CLAUDE.md invariant-7 bullet drafted in return for the human. PR.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Opus subagent build, PR #40. .approval/env is a SOURCE MAP: NAME=keychain:<svc> | secret-service:<label> | env: | literal:<v> | bare literal; mode 0600 (refused otherwise, chmod printed); gitignored by init; ambient env wins; absent file is not an error. NO VERB LOADS IT IMPLICITLY: only approval env resolves it and emits a shell-quoted export block (eval-safe for quote/dollar/backtick/newline, round-tripped through /bin/sh); --check is value-free on every path and exits 1 when a policy-DECLARED variable is unresolved (defaulted variables do not fail check when the policy never mentioned them, or nobody without Telegram could get green). Resolvers spawn bare helper names (security / secret-tool) so PATH resolves them like production and values return on stdout, never argv; tests stub both on PATH (no test-only flag: that would itself be implicit config). Frozen ENV_FILE_REFUSAL_CODES (11 codes) pinned. GLOBAL INVARIANT 7 BORN: configuration is never loaded implicitly from the working tree; pinned by a test spawning doctor, policy attest, channel telegram health in a dir with a complete env file and asserting none saw it. Rationale in module doc + SPEC 11: APPROVAL_HUMAN is human identity; a working-tree file that could set it would let any writer act as the human on every human-only verb. Deliberate divergences: unknown-scheme narrowed to a RESERVED list after a smoke test caught APPROVAL_HUMAN=human:carter being refused as a scheme (a legitimate colon-bearing value must work; a mistyped source still cannot export as its own text); literal: explicit form; invalid-variable-name refusal (a policy-declared name is eval-d, so "x; rm -rf /" never emits); already-set values re-exported with a marker; unknown *_env keys assumed secret-bearing (stricter). Fable on review: Telegram env-name resolvers relocated to core/telegram-config.ts (env-file needed them; core must not import channels; channels re-exports; a bad paragraph-backtrack in the move briefly dropped the contract imports, caught by typecheck, restored). SPEC 5.2 environment-map bullet, 10.1 line, 11 paragraph, 11.1 invariant 7 drafted same-commit for sign-off. CLAUDE.md ENGINEERING-INVARIANTS BULLET DRAFTED FOR THE HUMAN HANDS: "- **Configuration is never loaded implicitly from the working tree.** No verb reads a working-directory file into its own environment; .approval/env is resolved by approval env alone, and the environment a gate operation runs under is the one the human who launched the process established. Identity, credentials, and the variable names that point at them are established outside the tree, always." +28 tests, 1430.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Source-map .approval/env with keystore-first resolvers, approval env (eval block; value-free --check), no implicit loading anywhere (invariant 7 born and pinned), init gitignores it, SPEC drafts for sign-off and the CLAUDE.md bullet drafted for the human. PR #40.
<!-- SECTION:FINAL_SUMMARY:END -->
