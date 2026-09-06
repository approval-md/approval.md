---
id: APRV-285
title: approval init ignores .approval/keys/ and doctor's environment row checks it
status: In Progress
assignee:
  - '@opus-285'
created_date: '2026-09-06 08:17'
updated_date: '2026-09-06 11:52'
labels:
  - safety
  - cli
  - doctor
dependencies: []
type: bug
ordinal: 211000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found 2026-09-06 while preparing policy amendment proposals: .gitignore ignores .approval/daemon/, .approval/env, .approval/vault.enc and .approval/log/verified-head.json, and .approval/payloads/ is deliberately tracked, but .approval/keys/ (the X25519 private halves for sealed token delivery, 0600 in a 0700 dir, unlinked at consume/expiry/revocation) has no entry. A `git add .approval/` during a records or ceremony commit could sweep a live key into a public repo, and a committed key opens that action's token_sealed for anyone holding the log. The repo's own .gitignore gains the line in the overnight wave; this task makes it structural: src/cli/scaffold.ts GITIGNORE_ENTRIES adds .approval/keys/ so `approval init` and `mergeGitignore` write it, tests/cli-init.test.ts pins it, and doctor's environment row (or a sibling) fails when a .approval/keys/ file is tracked or unignored, with the fix line.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `approval init` writes .approval/keys/ into .gitignore; mergeGitignore adds it to an existing file; tests/cli-init.test.ts pins both
- [x] #2 doctor reports a tracked or unignored .approval/keys/ entry as a failure naming the fix; test covers ignored, unignored and tracked
- [x] #3 docs/cli-reference.md init and doctor sections mention it
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Scaffold (AC1): .approval/keys/ is ALREADY in GITIGNORE_ENTRIES (landed with APRV-105 sealed delivery), so the structural half is the pin, not the entry. tests/cli-init.test.ts iterates GITIGNORE_ENTRIES generically, which cannot notice the line going away; add an explicit named assertion that a fresh init writes .approval/keys/ and that mergeGitignore adds it to an existing file, plus a pin on the constant itself.
2. Doctor (AC2): APPEND one new row sealed-keys after gate-organs (never insert). It answers two questions about the sealed-token key store (core/seal.ts keyStoreDirFor): is any file under it TRACKED by git (git ls-files in the repo root, via cli/git-scope.ts), and is the directory covered by .gitignore (the existing literal-pattern ignoreVerdict, taught a dir kind so trailing-slash forms count). Verdict order worst-first, matching the vault and environment rows: tracked then fail; key files present and not ignored then fail; no keys and not ignored then skip with the fix; not a repo then skip; otherwise pass. Fix lines stay inside the pinned FIX_COMMAND_PREFIXES allowlist (echo the ignore line for the missing line, approval init for the tracked case with git rm --cached named in the prose), so doctor still tells nobody to delete or to commit.
3. Roster: tests/doctor-rows.ts gains sealed-keys at the end of DOCTOR_ROW_ORDER and in DOCTOR_FRESH_SKIPS (a scaffolded directory is not a git checkout); tests/cli-doctor.test.ts row-count assertions move 26 to 27 and one status entry is appended; README.md doctor tally moves 26 to 27 rows and 16 to 17 not-applicable, and names the new row, because tests/docs-guard.test.ts derives that prose from the roster.
4. Docs (AC3): docs/cli-reference.md gains the sealed-keys bullet in the doctor check list and a sentence in the init section saying which .approval/ paths init ignores and that .approval/keys/ is one of them.
5. New tests in tests/cli-doctor.test.ts covering ignored (pass), unignored with a key present (fail, exact ignore line in the fix), and tracked (fail, in a real git init repo).
6. Verify: npm run build, cli-init / cli-doctor / cli-long-help / docs-guard suites, npm run lint, npm run typecheck.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## Implementation notes

**What landed.** `.approval/keys/` was already in `GITIGNORE_ENTRIES` (it came in
with APRV-105 sealed delivery), so AC1 is a pin rather than a new line: every
other assertion in tests/cli-init.test.ts iterates the constant and so could not
notice a line leaving it. Two named assertions now hold the entry by name, one on
a fresh scaffold and one on the merge path.

The new work is the doctor row. `checkSealedKeys` is APPENDED last (row 27), the
sibling of the `vault` and `environment` rows, and it asks two questions
worst-first: is anything under `keyStoreDirFor(logPath)` TRACKED (a fail), and is
the store covered by a `.gitignore` line (a key present and unignored is a fail
naming the exact line). Tracking is asked of `git ls-files` rather than of the
working tree, deliberately: consume, expiry and revocation all unlink the private
half, so the disk can be clean while the index still carries the key, and it is
the index that becomes a commit. Outside a git checkout the row skips.

**A divergence from the plan, resolved toward the older invariant.** Plan step 2
said the empty-store-and-unignored case should "skip with the fix". Doctor has a
pinned property, swept over every row by "doctor: every failing check's fix begins
with a runnable command", that a NON-FAILING row carries no `fix`. A skip that
handed over a command would have broken it. The implementation keeps the
invariant and names the `.approval/keys/` line in the row's DETAIL instead; the
test that had been written to the plan's wording was corrected to assert
`fix === undefined` plus the line in the detail. Nothing an operator needs is
lost, and the "nothing to type on a green-ish row" rule survives.

**Invariants touched.** No enforcement path changes: doctor is read-only
diagnosis. Both fix lines stay inside `FIX_COMMAND_PREFIXES` and neither deletes
nor commits — `git rm --cached` for a key already in the index, and revoking every
action whose token is unspent inside its TTL, are named in prose and left to the
human. The row counts key files and never opens one; a diagnostic that read a
private key to report on it would be the fault it is reporting.

**`ignorePatternsFor` gained a `kind`.** The literal-pattern matcher now accepts
trailing-slash forms (`.approval/keys/`, `/.approval/keys/`, `keys/`) for
`kind: "dir"` only. Accepting them for files would be a false PASS: a line `env/`
matches a directory and would not cover the FILE `.approval/env`. Default stays
`"file"`, so the vault and environment rows read exactly as before.

**Roster and prose.** tests/doctor-rows.ts appends `sealed-keys` to
`DOCTOR_ROW_ORDER` and `DOCTOR_FRESH_SKIPS`; README's tally moves 26 to 27 rows
and 16 to 17 not-applicable (docs-guard derives that prose from the roster, so it
is checked and not asserted by hand); docs/cli-reference.md gains the `sealed-keys`
bullet in the doctor check list and a paragraph in the init section saying which
`.approval/` paths init ignores and why the key store is the one that matters.
The row is appended last on purpose: the doctor lane (APRV-271/282) is adding rows
on the branch this merges into, and ordering there is the orchestrator's to
resolve.

**Verification.** `npm run build` exit 0. `node --test dist/tests/cli-init.test.js
dist/tests/cli-doctor.test.js dist/tests/cli-long-help.test.js
dist/tests/docs-guard.test.js` exit 0, 121 tests, 121 pass, 0 fail. `npm run lint`
exit 0. `npm run typecheck` exit 0. Five new doctor tests drive a REAL `git init`
fixture (the vault and environment rows can be driven with an empty `.git`
directory because they only read `.gitignore`; this row asks git what it tracks,
and there is no honest way to fake that): unignored-with-key fails, empty-store
skips without a fix, the scaffolded line passes, a forced-add key fails naming the
untrack and the revoke, and an unlinked-but-indexed key still fails.
<!-- SECTION:NOTES:END -->
