---
id: APRV-503
title: >-
  Input redirection from a credential or protected file (cat < ~/.hermes/.env,
  cat < .approval/env) classifies read.shell; the < target must take
  account.credential like a named argument
status: In Progress
assignee:
  - '@claude-b1/A503'
created_date: '2026-10-07 01:53'
updated_date: '2026-10-07 03:57'
labels:
  - agent-village
dependencies: []
priority: high
ordinal: 386000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found by the APRV-502 security refutation (2026-10-07, lanes-bountify/A502-refute.md, pre-existing on main, outside that diff). The classifier judges a reader's NAMED arguments against the credential tier (cat ~/.hermes/.env is account.credential) but an input redirection target is not put through the same check: cat < ~/.hermes/.env and cat < .approval/env classify read.shell, which is autonomous under the Agent Village template (defaults.autonomy autonomous), so the secret is reachable by a literal spelling the gate was built to stop. SPEC §7 (APRV-194 amendment): a READ of the vault, key and environment files under the approval home is account.credential, and §11.1 fail closed. Fix: in src/core/command-class.ts, feed every segment's < (and <<< here-string) targets through isCredentialPath and protectedPathClass exactly as named read arguments are (the redirect lexer already records targets for > writes), so a credential target is account.credential and a protected target keeps its class; the hook's resolvedPathClasses pass already resolves < targets for the Hermes home (its comment says so) but only adds classes where the text names the home, so cover the relative spelling run from the home too. Fixtures for cat/head/less/grep/sort/python3 reading via <, the here-string, and a pipe (cat < .env | base64). No new class.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 cat < ~/.hermes/.env, cat < .approval/env and grep x < .approval/vault.enc classify account.credential in the pure classifier; cat <<< "$(cat ~/.hermes/.env)" is refused (unparseable) with a detail naming the rewrite; cat < README.md stays read.shell
- [x] #2 Through the compiled Hermes hook with workdir set to the home, cat < .env (relative) is account.credential
- [x] #3 No fixture in tests/command-class.test.ts changes class except the redirect cases added; conformance 553/553
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. command-class.ts: collect each segment's < targets (readTargets). A credential < target makes the segment account.credential (rule credential-path, path bound) for ANY binary, below the opaque checks (same precedence as a named argument), and in the no-binary branch so a bare '< file' and the bash $(< file) idiom are covered. In an effectful segment a protected < target joins the positional protected-path scan (no prose skip: a redirect target is a path by construction).
2. Here-string <<< stays unparseable (fail closed; parsing it would loosen 'cat <<< hello'); give it its own refusal detail.
3. Hook disk pass already judges shape.reads; add a Hermes hook test (workdir = home, cat < .env).
4. Tests: command-class.test.ts redirect fixtures (positive, negative quoting, write side), hook classify CLI test, Hermes hook test. Conformance command-class vectors 1.6.0 (minor) + regen.
5. Docs (claude-code-hook.md, cursor-hook.md, hermes-hook.md), CHANGELOG under Unreleased.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Done (claude-b1/A503, 2026-10-07):
- src/core/command-class.ts: classifySegment collects each segment's < targets (readTargets, any descriptor). New redirectCredentialTouch(): a credential < target is account.credential, rule credential-path, path = target word, for ANY binary (the CREDENTIAL_WRITE_BINS exemption is for NAMED files only; a < is always a read); a secret-named variable in any redirect target (read or write) is credential-env. Called (a) in the no-binary branch, so a bare '< file' and the bash $(< file) idiom are caught (echo "$(< ~/.hermes/.env)" was read.shell, now opaque because its substitution is account.credential), and (b) right after credentialTouch, i.e. below the opaque table (sudo cat < .approval/env stays opaque) and above the binary table (less/python3 < credential named, not unclassified). In an effectful segment a protected < target joins the positional protected-path scan (no prose skip; equal rank -> positional wins, so no existing answer moves). Readers keep read.* (cat < APPROVAL.md = cat APPROVAL.md).
- Here-string <<<: was already refused unparseable (as a heredoc with no terminator word); kept refused, now with its own detail. Parsing it could only loosen (cat <<< hello would become read.shell). A refusal is denied by the hook in every policy, so it is at least as strict as account.credential.
- exec < ~/.hermes/.env; cat: opaque before and after (exec is in OPAQUE_BINS).
- Hook disk pass (src/cli/hook.ts resolvedPathClasses) already judged shape.reads against the per-call workdir; no change needed. New test proves relative, .., symlinked-parent and symlinked-workdir spellings.
- Write side: already covered (APRV-198 redirect-protected): echo x > ~/.hermes/.env, >> .approval/policy, 2> auth.json, >| APPROVAL.md are policy.core; >> .approval/log/... log.mutate. Pinned by a new test; no second write-side finding.
- Second finding, different code path: unquoted heredoc bodies are never classified (cat <<EOF with $(rm -rf ~) in the body is read.shell). Filed as APRV-504, not fixed here.
Evidence: node --test dist/tests/command-class.test.js (+quoting, routing, ref-delete, harness-launch), protected-path-guard*.test.js, conformance.test.js, conformance-regen.test.js, release-notes.test.js, demo-finale-credential.test.js: 974/974 pass, exit 0. Hook files cli-hook, cli-hook-hermes, cli-hook-hermes-rules, cli-hook-cursor, cli-hook-codex, cli-hook-read-scope, cli-hook-write-scope, cli-hook-scope, cli-hook-rewrite: 299/299, exit 0. node conformance/run.mjs: 568/568 (553 + 15 new command-class vectors at 1.6.0; the 86 existing vectors byte-identical), exit 0. npm run lint exit 0; npm run typecheck exit 0.
AC #1 left unticked on one clause: the here-string form is REFUSED (unparseable), not account.credential; every other named case classifies account.credential and cat < README.md stays read.shell. Needs a ruling: accept the refusal and restate the clause, or parse <<<.

Fix round (claude-b1/A503-fix, refutation lanes-b1/A503-refute.md): BLOCKING-1 confirmed. The first cut returned the redirect-credential answer early, above the protected scan, so rm -rf .approval/log < .approval/env became account.credential (main: log.mutate), and the open window over a non-loading policy ALLOWED it (log.mutate is refused unconditionally in runBypass, account.credential only inside load.ok).
Rule now: a credential < target answers early only when the segment names no protected path that outranks account.credential (outranksCredential: log.mutate, then policy.core; scanned over the positionals with the prose skip and the non-credential < targets; protected write targets already answered above). Otherwise the answer is deferred: the segment goes through the table and the protected scan exactly as without the <, and takes account.credential only if that walk ends on a read or gate.self (where credential is stricter); a protected class or a refusal (unclassified for an unknown binary) stands. policy.edit ranks below the credential class. Effect: the four refuter commands and cp x .approval/policy.yaml < .approval/env give exactly their no-redirect answer (log.mutate / policy.core); every validated tightening (less/python3/tee/git apply/bun < credential, $(< credential)) is unchanged. AC #1 restated per the coordinator ruling (here-string refused unparseable with a rewrite detail) and ticked.
Tests: unit test (with/without-< segment equality for 8 commands, shred stays unclassified, reader/policy.edit/gate.self keep credential); window e2e through approval hook claude-code with --policy nowhere: all four DENY hook-class-human-only log.mutate, nothing appended. Six credential-redirect-* vectors added inside command-class 1.6.0 (unmerged version stays, per the 1.4.0 precedent); the 101 earlier vectors unmoved. Evidence: classifier/protected/conformance files 975/975 exit 0; hook files 300/300 exit 0; conformance 574/574 exit 0; lint 0; typecheck 0.
Pre-existing, outside this diff, NOT fixed: the POSITIONAL credential tier has the same shape for non-write binaries on main: cp .approval/env .approval/log/events.jsonl is account.credential (credentialTouch answers before the protected scan; cp is not in CREDENTIAL_WRITE_BINS), so the window over a non-loading policy would bypass a log overwrite. Reported to the coordinator for a ruling/task.
<!-- SECTION:NOTES:END -->
