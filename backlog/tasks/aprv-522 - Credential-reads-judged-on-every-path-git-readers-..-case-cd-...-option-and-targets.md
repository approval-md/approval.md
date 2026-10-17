---
id: APRV-522
title: >-
  Credential reads judged on every path: git readers, .., case, cd, $(...),
  option and < targets
status: In Progress
assignee:
  - '@claude-approval'
created_date: '2026-10-17 10:29'
updated_date: '2026-10-17 11:03'
labels:
  - security
  - classifier
  - hook
dependencies: []
ordinal: 399000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The APRV-639 credential-asymmetry refutation (lanes-approval/APRV-639-cred-asymmetry.md, items M2-M6 and S2) found credential reads on main that classify below account.credential, each letting an agent read a credential file with no approval: git readers exempt from the credential rule (M2); the .approval row neither resolving .. nor folding case, in the shell and in Read/read_file (M3); the Claude Code hook never re-asking the credential rule after resolving a path through cd, a symlink or a glob (M4); the Hermes disk pass skipping readers whose segment writes or sits inside $(...) (M5); a file named inside a reader's own option never judged (M6); and < targets skipping the read scope (S2). Fix fail-closed with one credential judgement on every path. No new credential locations (~/.ssh etc. stay N2).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 git readers (diff --no-index, grep --no-index, log -p, show <rev>:<path>, cat-file) are account.credential on a credential path; the path-writing verbs keep their exact answer only when the verb is read unambiguously and every option is on a closed per-verb allow-list
- [x] #2 Credential path matching resolves .., ., // and folds case, in the classifier, the hooks' disk pass and the read tools; a .. spelling through the log directory keeps log.mutate
- [x] #3 Every hook path (Claude Code, Hermes, hook classify) re-checks each resolved landing path (cd from earlier segments, symlinks lexical and physical, globs, brace lists, $PWD, ${VAR:-default}) against isCredentialPath/holdsCredentials; an unresolvable cd makes later relative reads credential reads
- [x] #4 Readers inside $(...), pipelines and segments with redirections are judged
- [x] #5 Option-embedded file arguments (--from-file=, --file=, -fFILE, curl @file and name=@file) are judged as reads
- [x] #6 < targets go through the same read scope as positional reads (here-strings stay refused)
- [x] #7 Before/after differential with the refutation harness shows 0 milder in every mode
- [x] #8 Classifier, Claude Code hook and Hermes hook tests for each item fail on main and pass after
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Pure classifier (src/core/command-class.ts): isCredentialPath judges the written segments and the lexically resolved ones, case folded (M3); credentialReadWords is the one list of words the credential rule reads (positionals, --opt=VALUE, -fVALUE, @file / name=@file, git <rev>:<path>) (M2, M6); git leaves CREDENTIAL_WRITE_BINS, with its path-writing verbs exempt only through a closed per-verb option allow-list read past the globals; ln judged like git; a log.mutate spelling stays in the protected scan; < targets and reads inside $(...) take the read scope (S2).
2. Hook (src/cli/hook.ts): credentialReadLandings / refineCredentialReads, last in classifyForHook so Claude Code, Hermes and hook classify share it (M4, M5); refineReadScope reads < targets; gateRootKind/holdsCredentials fold case.
3. Tests for each item in tests/command-class-credential-reads.test.ts and tests/cli-hook-credential-reads.test.ts, shown failing on main.
4. Before/after differential with the APRV-639 refutation harness: 0 milder.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Decisions the diff alone does not show:
- Case is folded on every platform (fail closed): on a case-sensitive volume an upper-case spelling of a credential path is a different file and now costs a prompt.
- After a cd the hook cannot resolve (a variable target, cd -, popd), every later RELATIVE read word is account.credential, the rule the Hermes pass already had. New for Claude Code; the main usability cost; flagged for the lead.
- git path-writing verbs (add, rm, mv, restore, checkout, switch, reset, clean, update-index, checkout-index) keep their exact old answer only when the verb is found past zero-value globals and every option before -- is on that verb's closed allow-list (GIT_PATH_WRITE_OPTIONS). An abbreviated long option, a short bundle with an unlisted letter, an unknown flag, a value-taking global and --pathspec-from-file all make git a reader. Two security-review rounds on the in-progress diff drove this; it does not rely on APRV-520 refusing the globals first.
- The hook pass skips the words of non-opening builtins (echo, printf, test, ...) unless echo or printf feeds a pipe or sits inside a substitution, keeping the Hermes L-e rule; a copy's destination is not read.
- Known limits, unchanged: a path held in a variable or produced by a substitution's output (N3), inline programs (N1), and ~/.ssh and kin are not credential locations (N2).
- Write-side case variants stay open: protectedPathClass is exact-case, so a write to an upper-case spelling of the approval home is a workspace write. Follow-up, not in this brief.
- Touches SPEC §11.1 (ambiguity resolves to the stricter path): every change only adds classes or tightens read.shell; the differential shows 0 milder in 11 modes.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Credential reads are judged on every path. Pure classifier: credential rows resolve .. and fold case; credentialReadWords is the one list of read words (positionals, option values, upload sources, git path halves); git and ln are judged as direction-blind readers with the path-writing git verbs exempt only through a closed option allow-list; < targets and substitution reads take the read scope. Hook: credentialReadLandings lands every read word through cd, symlinks, globs, braces, $PWD and parameter defaults, inside every substitution, for Claude Code, Hermes and hook classify. Differential: 0 milder of 177,888 comparisons. Tests: 19 new, 16 fail on main.
<!-- SECTION:FINAL_SUMMARY:END -->
