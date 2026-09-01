---
id: APRV-194
title: >-
  Classifier emits account.credential: credential touches must not fall to
  read.shell or unclassified
status: To Do
assignee: []
created_date: '2026-09-01 03:54'
labels:
  - gate
  - security
  - design
dependencies:
  - APRV-185
priority: high
ordinal: 162000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found during APRV-185's dogfood probe (2026-09-01, classifier run read-only in the primary): no classifier rule ever emits account.credential, so the class exists in SPEC section 7's taxonomy with nothing producing it, and a human-only (or manual) rule on it is inert. Where credential touches actually land today: security find-generic-password and printenv APPROVAL_TG_TOKEN fall to unclassified (deny, acceptable but undiagnostic); cat .approval/vault.enc classifies read.shell, which is AUTONOMOUS, so an agent can read vault ciphertext without any prompt. Not exploitable alone (the vault is sealed), but the CLAUDE.md Never list believes credential access is closed and the classifier does not enforce it.

Scope: add classifier rules emitting account.credential for the credential surface: keychain readers (security find-generic-password, secret-tool lookup), env probes of APPROVAL_* / TELEGRAM_* / VAULT_* names (printenv, env piped to grep, echo $VAR forms the parser can see), and file reads under .approval/vault* and .approval/keys/ and .approval/env (reads, not only writes; the redirect-protected rule already covers writes as policy.edit). Pair with the APPROVAL.md declaration (account.credential: human-only) drafted in APRV-185's report, which is Carter's amendment to make; the rules land first so the declaration enforces from day one. Mind the direction-blind cp precedent: copies FROM these paths classify account.credential too.

Related: APRV-185 (the human-only level these rules give teeth to). Global invariants touched: raw secrets never appear in the log (rule additions must not echo values into refusal messages).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Classifier rules emit account.credential for keychain readers, APPROVAL_*/VAULT_*/TELEGRAM_* env probes, and reads of .approval/vault*, .approval/keys/, .approval/env, including copies FROM those paths
- [ ] #2 cat .approval/vault.enc no longer classifies read.shell; test pins it and the other probe commands from the APRV-185 report
- [ ] #3 Refusal and deny messages name the class and never echo a secret value; tested
- [ ] #4 SPEC section 7 taxonomy note updated if wording implies the class was already emitted; flagged pending sign-off if edited
- [ ] #5 APPROVAL.md declaration text confirmed still matching APRV-185's draft, left for the human's amend ceremony
<!-- AC:END -->
