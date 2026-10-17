---
id: APRV-194
title: >-
  Classifier emits account.credential: credential touches must not fall to
  read.shell or unclassified
status: Done
assignee:
  - '@agent:opus'
created_date: '2026-09-01 03:54'
updated_date: '2026-09-01 21:37'
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
- [x] #1 Classifier rules emit account.credential for keychain readers, APPROVAL_*/VAULT_*/TELEGRAM_* env probes, and reads of .approval/vault*, .approval/keys/, .approval/env, including copies FROM those paths
- [x] #2 cat .approval/vault.enc no longer classifies read.shell; test pins it and the other probe commands from the APRV-185 report
- [x] #3 Refusal and deny messages name the class and never echo a secret value; tested
- [x] #4 SPEC section 7 taxonomy note updated if wording implies the class was already emitted; flagged pending sign-off if edited
- [x] #5 APPROVAL.md declaration text confirmed still matching APRV-185's draft, left for the human's amend ceremony
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Land on top of APRV-198's split, same file (src/core/command-class.ts), same shape of work.
2. Credential paths: isCredentialPath(candidate) matches .approval/vault* (any name starting 'vault'), .approval/keys/ (subtree) and .approval/env (and env.*), by path segments, pure, no disk.
3. Precedence with APRV-198, stated once and tested: a WRITE to those paths is policy.core (they sit under .approval/, and the existing protected-path override already answers that), a READ of them is account.credential. Implemented by running the credential check only when the segment's binary is not one of the in-place mutators (rm, mv, tee, truncate, chmod, chown, ln, touch, mkdir, rmdir, git, dd, install, sed -i) and never for a redirect target, so the write case falls through to the 198 override untouched. cp is the deliberate exception: direction-blind, and a cp naming a credential path is account.credential in either direction, because the exfiltration reading is the informative one and both classes are gated.
4. Placement in classifySegment: bare env (no positionals) is answered account.credential BEFORE the OPAQUE_BINS lookup, so env | grep APPROVAL_TG_TOKEN classifies instead of denying opaquely; every other credential check runs AFTER the opaque and inline-source checks, so sudo cat .approval/env stays opaque rather than being softened into a request.
5. Env-name probes: a word containing $NAME or ${NAME} under APPROVAL_ / TELEGRAM_ / VAULT_ is account.credential, minus a documented allowlist of runtime names that hold no secret (APPROVAL_HUMAN, APPROVAL_AGENT, APPROVAL_ASCII, APPROVAL_MD, APPROVAL_HOME, APPROVAL_DIR). A printenv table row answers account.credential bare or with a secret-named argument and read.shell otherwise.
6. Keychain readers: a table row for security (find-generic-password, find-internet-password and the rest), secret-tool, keyring and pass, all account.credential.
7. account.credential joins CLASSIFIER_CLASSES; docs/claude-code-hook.md and docs/cursor-hook.md get the rows and the precedence note (the docs guard requires every rule id and class to appear).
8. Tests: pin every probe command from the APRV-185 dogfood report, AC2's cat .approval/vault.enc (no longer read.shell), the write-vs-read precedence pair, cp in both directions, and AC3 — a hook deny for printenv APPROVAL_TG_TOKEN names the class and the variable NAME and never a value (the classifier is pure and reads no environment, which is why it cannot echo one).
9. npm test / lint / build, notes, ACs, second commit.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built 2026-09-01 (opus, lane A worktree agent-a553d0bab68d38f2b), on top of APRV-198's protected-path split in the same file.

WHAT EMITS account.credential NOW, and where each check sits in classifySegment, because the ORDER is the design:
1. A bare `env` (no non-flag arguments) is answered account.credential with rule env-dump, ABOVE the opaque table. `env <command>` stays opaque for its own reason (it relaunches something else with a modified environment), but `env` alone prints every variable including the token, and leaving it to the opaque branch denied it as unreadable rather than naming it. This is also what makes `env | grep APPROVAL_TG_TOKEN` classify: the pipeline's classes are the union, and the first segment carries the credential class out.
2. OPAQUE_BINS and the inline-source check run next, UNCHANGED. The credential check sits BELOW them on purpose: `sudo cat .approval/env` and `bash -c 'cat .approval/vault.enc'` stay opaque refusals, because softening a refusal into a request would be the ungated direction. Pinned by test.
3. credentialTouch() then answers, ABOVE the binary table, so a reader the table does not know is named rather than refused unclassified: base64, xxd, less, head all reach account.credential over .approval/vault*, .approval/keys/ and .approval/env (plus env.local and kin). Two shapes: a credential PATH among the positionals (rule credential-path, and the path rides in ClassifiedSegment.path so a channel can name the file), or a word expanding a secret-named variable (rule credential-env), which fires on curl -H "Authorization: Bearer $TELEGRAM_BOT_TOKEN" as well as on echo $APPROVAL_TG_TOKEN.
4. Two new table rows: keychain (security, secret-tool, keyring, pass; every subcommand, since these binaries exist to move credential material) and printenv, which is the one credential binary with a read-shaped invocation: bare or with a secret-named argument it is account.credential, and `printenv PATH` stays read.shell.

PRECEDENCE WITH APRV-198, decided and documented: a WRITE to a credential file is policy.core (it is an edit of the gate's own directory, and the protected-path override already says so), a READ of it is account.credential (what leaves the machine is the secret). Implemented by CREDENTIAL_WRITE_BINS (rm, mv, tee, truncate, chmod, chown, ln, touch, mkdir, rmdir, git, dd, install, plus sed -i), for which credentialTouch declines and the segment falls through to the 198 override untouched; a redirect target never reaches this check at all, since redirects are resolved earlier. cp is DELIBERATELY absent from that list: it reads its source and writes its destination, the classifier cannot tell which argument is which (that is 198's direction-blindness), and of the two readings the exfiltrating one is worth naming, so a cp touching credential material is account.credential in either direction. Both classes are gated, so the choice is about what the approver is told. One APRV-198 fixture moved for this: cp .approval/env /tmp/env became cp .approval/QUEUE.md /tmp/queue.md, and the AC4 fail-closed list gained account.credential as a fourth gated answer.

THE ENV-NAME RULE IS PREFIX-BASED WITH A SMALL ALLOWLIST. APPROVAL_*, TELEGRAM_* and VAULT_* are credential material by name; APPROVAL_HUMAN, APPROVAL_AGENT, APPROVAL_ASCII, APPROVAL_MD, APPROVAL_HOME and APPROVAL_DIR are carved out, listed rather than pattern-matched so adding one is a deliberate act with a reviewer. Without the carve-out every demo runbook line (node "$APPROVAL_MD/dist/src/cli/main.js") and every $APPROVAL_HUMAN echo would gate; with it, a name under a secret prefix that nobody has vouched for is still credential material, which is the fail-closed direction. The classifier reads command TEXT and never an environment, so it cannot tell which APPROVAL_* holds a token, and this is the honest version of that limitation.

GLOBAL INVARIANT TOUCHED (CLAUDE.md requires saying so): SPEC.md section 11.1's 'raw secrets never appear in the log'. Nothing added here reads an environment or a file, so no rule can produce a value: a refusal names the class, and the command text a prompt renders carries the variable's NAME and never its contents. tests/cli-hook.test.ts 'a credential deny names the class and never the value (APRV-194)' proves it the hard way: the hook's child process is given a real value for APPROVAL_TG_TOKEN, the deny names account.credential and carries hook-class-human-only, and the value appears in neither the verdict, nor stdout, nor stderr, nor the log. The same test checks the other surface a human reads, approval hook classify, which prints the class and the command as written (so the NAME, never the value).

WHAT IS STILL OPEN, deliberately: file-tool READS are not gated. The harness hook's file tools are the write tools (Edit, Write, NotebookEdit, Cursor's Write and Delete), so a Read tool call against .approval/vault.enc is not a gate question at v0.1; the shell path is. Worth a task if the Read tool is ever routed through the hook. AC5: the APPROVAL.md declaration text is confirmed still matching the APRV-185 draft (account.credential: { autonomy: human-only }), left for Carter's amend ceremony; the block naming it alongside policy.core and log.mutate is in APRV-184's notes.

SPEC AMENDMENT TEXT (AC4), drafted for the orchestrator to apply verbatim: this lane may not edit SPEC.md.

Section 7's account.* row does not claim the class is emitted, so nothing there is WRONG today; what is missing is the sentence that ties the taxonomy to the runtime that now enforces it. INSERT after the developer-workstation table (immediately after the APRV-198 paragraph, if that one lands first):

`account.credential` is emitted by the runtime's own command classifier: keychain readers, probes of environment variables whose NAME falls under the credential-bearing prefixes a deployment declares, and reads of the vault, key and environment files under the approval home. A WRITE to those files is `policy.core` and a READ of them is `account.credential`, because what a write changes is the gate's own directory and what a read moves is the secret; a copy is classified `account.credential` in either direction, since a classifier over shell text cannot tell a source from a destination and the exfiltrating reading is the one that must not be missed. A classifier MUST NOT read an environment or a file to make this judgment: it decides from command text alone, so a refusal can name a variable and never its value (section 11.1). (Amended APRV-194, pending sign-off.)

No section 11.2 registry rows: this task adds no refusal code. The refusal a human-only account.credential produces is class-human-only, registered by APRV-185. No section 11.1 invariant is added either; the existing 'raw secrets never appear in the log' is the one this task is bound by, and the sentence above states how the classifier stays inside it.

VERIFICATION (2026-09-01, worktree agent-a553d0bab68d38f2b, on top of the APRV-198 commit).

npm run lint clean, npm run build clean. Full npm test to completion: two failures, both TTL races against a live daemon under load ('sweep: a live daemon expires a lapsed request exactly once' and 'the daemon expires a lapsed request and the channel annotates it, in one process'), and both pass on re-run alone (daemon + channels-cli together: 47 tests, 47 pass). Nothing in either test classifies a command. An earlier full run in this lane also hit the known pre-existing ci-guard ENOENT on node_modules/@modelcontextprotocol/sdk, which is this worktree lacking installed production deps and is recorded as lane-only in APRV-185's notes.

Per-suite evidence for the acceptance criteria:
- tests/command-class.test.ts 284 tests, 284 pass. AC1: CREDENTIAL_FIXTURES pins 20 commands across the three shapes — keychain (security find-generic-password, security find-internet-password, secret-tool lookup), env probes (printenv bare, printenv APPROVAL_TG_TOKEN, printenv VAULT_PASSPHRASE, bare env, echo $APPROVAL_TG_TOKEN, echo ${APPROVAL_VAULT_PASSPHRASE}, a curl Authorization header carrying $TELEGRAM_BOT_TOKEN) and file reads (cat, head -c, base64, xxd, less, grep over .approval/vault.enc, .approval/env, .approval/keys/), plus cp in BOTH directions and curl -T for the upload shape. AC2: 'cat .approval/vault.enc is no longer read.shell (APRV-194 AC2)' asserts the class moved and is exactly account.credential. Also pinned: 'env | grep NAME classifies rather than denying opaquely', 'a write to a credential file is policy.core; a read of it is account.credential' (8 write shapes, 2 read shapes), 'the non-secret runtime variables stay ordinary reads', and 'an opaque relauncher stays opaque even over credential material' (sudo, bash -c).
- tests/cli-hook.test.ts 67 tests, 67 pass, including the two new ones. AC3: 'a credential deny names the class and never the value (APRV-194)' runs the hook against a policy declaring account.credential human-only, with a REAL value exported for APPROVAL_TG_TOKEN in the child process; the deny carries hook-class-human-only and names account.credential, and the value appears in no part of stdout, stderr, the reason or the log. The same test then checks approval hook classify, the other surface a human reads, which prints the class and the command as written: the variable NAME appears, the value cannot. 'reading the vault is gated, not autonomous (APRV-194 AC2)' proves the end-to-end consequence: cat .approval/vault.enc now reaches the gate instead of being allowed as an autonomous read.
- tests/cli-hook-cursor.test.ts 7/7 and tests/dogfood.test.ts unchanged and green; both docs guards pass, which is what enforces that account.credential and the two new rule ids (keychain, printenv) appear in docs/claude-code-hook.md and docs/cursor-hook.md.

AC4 is met as drafted text above, flagged '(Amended APRV-194, pending sign-off.)' for the orchestrator to apply: section 7's account.* row never claimed the class was emitted, so nothing there was wrong, and what the amendment adds is the sentence tying the taxonomy to the runtime that now enforces it plus the write-vs-read precedence. AC5: the APPROVAL.md line (account.credential: { autonomy: human-only }) is unchanged from APRV-185's draft and remains Carter's ceremony; APRV-184's notes carry the full block.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
account.credential is emitted now, so the human-only line APRV-185 built for it stops being inert. Three shapes reach it: keychain readers (security, secret-tool, keyring, pass), environment probes the parser can see (printenv bare or on a credential-bearing NAME, a bare env, and any word expanding $APPROVAL_*/$TELEGRAM_*/$VAULT_* outside a small allowlist of the runtime's own non-secret names), and touches of .approval/vault*, .approval/keys/ and .approval/env — including under binaries the table does not know, so base64 and xxd are named rather than refused as unclassified. The precedence against APRV-198 is decided and tested: a write to those files is policy.core, a read is account.credential, and cp is direction-blind onto the credential class. Placement carries the safety: the env dump is answered above the opaque table so env | grep NAME classifies, everything else below it so sudo cat .approval/env stays an opaque refusal. Global invariant touched: raw secrets never appear in the log — the classifier reads command text and never an environment, so a refusal can name a variable and never its value, proved by a hook test that exports a real token value and finds it nowhere in the verdict, the streams or the log. Verified: command-class 284/284 with 20 new pinned probes, cli-hook 67/67, cursor 7/7, dogfood unchanged, lint and build clean, full suite green apart from daemon TTL load flakes that pass on re-run. cat .approval/vault.enc was read.shell (autonomous) and is now gated.
<!-- SECTION:FINAL_SUMMARY:END -->
