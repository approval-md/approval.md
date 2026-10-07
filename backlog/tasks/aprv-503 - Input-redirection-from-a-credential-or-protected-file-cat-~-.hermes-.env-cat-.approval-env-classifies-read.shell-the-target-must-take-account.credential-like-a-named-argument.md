---
id: APRV-503
title: >-
  Input redirection from a credential or protected file (cat < ~/.hermes/.env,
  cat < .approval/env) classifies read.shell; the < target must take
  account.credential like a named argument
status: To Do
assignee: []
created_date: '2026-10-07 01:53'
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
- [ ] #1 cat < ~/.hermes/.env, cat < .approval/env, grep x < .approval/vault.enc and the here-string form classify account.credential in the pure classifier; cat < README.md stays read.shell
- [ ] #2 Through the compiled Hermes hook with workdir set to the home, cat < .env (relative) is account.credential
- [ ] #3 No fixture in tests/command-class.test.ts changes class except the redirect cases added; conformance 553/553
<!-- AC:END -->
