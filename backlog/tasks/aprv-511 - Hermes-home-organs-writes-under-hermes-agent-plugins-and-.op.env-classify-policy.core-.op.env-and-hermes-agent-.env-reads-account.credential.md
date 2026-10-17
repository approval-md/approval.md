---
id: APRV-511
title: >-
  Hermes home organs: writes under hermes-agent/, plugins/ and .op.env classify
  policy.core; .op.env and hermes-agent/.env reads account.credential
status: In Progress
assignee: []
created_date: '2026-10-12 06:29'
updated_date: '2026-10-12 07:48'
labels:
  - hook
  - hermes
  - classifier
  - village
dependencies: []
priority: high
type: bug
ordinal: 389000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
On a village box everything under the Hermes home (uid hermes, the uid agent code runs as) is writable by the agent. The classifier protects config.yaml, agent-hooks/ and the consent allowlist (policy.core) and .env, .env.*, auth.json (account.credential), but NOT: $HERMES_HOME/hermes-agent/ (the runtime source install, whose .env Hermes loads into the gateway env with override=False), $HERMES_HOME/.op.env (loaded the same way), and $HERMES_HOME/plugins/ (where the gate's own av-approval plugin and its custody_keys.json live). Writes there classify files.write.workspace, autonomous under the village template, so one write_file disables custody or the plugin half of the gate (CUSTODY-refute M1, ov#296). Fix: mirror the existing organ rules (spelled path + realpath, .., symlinks, HERMES_HOME/HOME variables), fail closed.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Every write, delete, rename, chmod, patch, write_file and redirection landing under $HERMES_HOME/hermes-agent/ or $HERMES_HOME/plugins/, or on $HERMES_HOME/.op.env, classifies policy.core (terminal, write_file, patch)
- [x] #2 Reads of $HERMES_HOME/.op.env and $HERMES_HOME/hermes-agent/.env classify account.credential; reads of other source under hermes-agent/ keep their class
- [x] #3 Symlink, .., HERMES_HOME and HOME variable spellings resolve the same way the existing organ rules do, with vectors
- [x] #4 Negative vectors: writes to $HERMES_HOME/skills/, $HERMES_HOME/scripts/ and the workspace keep their class
- [x] #5 Conformance vectors and unit tests for each path and each tool; targeted tests and lint pass
- [x] #6 docs/hermes-hook.md organ table, the hermes plugins CLI and skill_manage interaction, examples/agent-village/approval-policy.md commentary and CHANGELOG Unreleased updated
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Read hermes-hook.md organ sections, command-class.ts protected/credential paths, hook.ts resolvedPathClasses/fileToolGate, Hermes v2026.9.24 env_loader/plugins_discovery/config/shell_hooks/skill_manager. Extend the .hermes organ rows (policy.core) and credential rows; add hermes-organ-write for the CLI; make the hook judge file-tool landings and policy.core directories; vectors + unit tests; docs.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Done (commits 4861a94a, bcee8db6, 8f0e8757, 7ac41b9f, 3683e47a):
- command-class.ts: hermes-agent/, plugins/, .op.env(.*) are policy.core under any home (incl. profiles); .op.env and hermes-agent/.env(.*) except .env.example are account.credential to read. Home matching factored into hermesHomeKind/hermesTailClass/hermesOrganClass/hermesCredentialTail: the .hermes segment compares without case; $HERMES_HOME/${HERMES_HOME} is the home; any other variable segment may be the home (organ + credential rows only, never bare-home or scripts); the tail is judged as spelled and with .. resolved (stricter wins); braced operators collapse (${HERMES_HOME:-/x} is the home).
- hermes CLI: rule hermes-organ-write (policy.core) for plugins install|update|remove|rm|uninstall|enable|disable|pack install|bare, config set|unset|edit|migrate, hooks revoke|remove|rm, update, uninstall. Read verbs keep harness.launch.hermes. Security review M (help flag): help honoured only as its own flag, never after -- or after another flag; a verb that may be a flag value is unknown (write); -- in an organ argv is the write; an organ group after a leading -- is the write.
- hook.ts: fileToolGate judges the canonical landing path too (stricter only, all adapters); writesIntoGateRoot includes any policy.core directory; globCouldNameOrgan checks directory components right under a home; ORGAN_NAMES += hermes-agent, plugins; CREDENTIAL_NAMES/CREDENTIAL_FILE_NAMES += .op.env; a variable the hook cannot expand that decides the directory of a write is policy.core (CUSTODY recheck M1'); tar/unzip into a variable directory likewise.
- Changed expectations in tests/cli-hook-hermes-rules.test.ts: mkdir -p "$OUT" from the workspace moves allowed -> policy.core (recheck 3 had allowed it); cp /tmp/x $HERMES_HOME/.env names account.credential first (same as the ~/.hermes spelling).
- Verified M1' through the compiled hook: every $HERMES_HOME spelling was already denied by the Hermes hook (unset, HERMES_HOME, APPROVAL_HERMES_HOME); the gap was the pure classifier (approval hook classify, Claude Code, Cursor) and other variables ($X/.env, "$OUT/x") which the hook allowed.
- Docs: hermes-hook.md organ table + CLI/skill_manage + variable rules; village example; CHANGELOG Unreleased subsection (0.4.6 candidate); SPEC.md 5.2 organ list amended, pending sign-off.
- Conformance: command-class 1.8.0, 38 new vectors (12 unmoved controls); no earlier expectation moved; totals 618/618. 1.7.0 belongs to APRV-508 (#636): renumber at rebase if needed.
Remaining: CI on the PR is the suite of record; human merge; SPEC sign-off; follow-ups listed in the report (cron/jobs.json, av-events state key, co-location symlink blind spot, hermes CLI credential writers, pip into the Hermes venv).

Refuter round 1 (HOME-ORGANS-refute.md at ee2de332, 2 M / 5 S / 7 N), fixed in 17b6d049: M1 substitution sentinel; M2 brace expansion; S1 curl/wget outputs; S2 side-effecting commands from inside a policy.core directory and git --work-tree/--git-dir (Hermes hook); S3 -t<dir>; S4 ln / cp -s / cp -l sources; S5 SPEC marker pending sign-off; N2 CHANGELOG list; N5 exact-case .env.example. N1 (${HERMES_HOME:-/a b} split on the space, $'...' ANSI-C quoting in the pure classifier) left as follow-up; N3 corrected (village template has no harness.launch.hermes row). Verification: targeted sets exit 0 (1131 + 266 tests), conformance 635/635, tsc --noEmit 0, lint 0, differential main vs head 134 changed all stricter.

Fix round 3 (recheck at 63887f30, 1 M / 1 S / 2 N): M(L5c-1) symlink then `..`: Node's realpathSync cancels `..` before reading the link, so the hook judged `k/../.op.env` beside k; hook.ts now also walks each path component by component as the kernel does (kernelLanding/landingPaths, judged in both readings, stricter wins) in the shell pass and the file tools, and a `..` out of anything an earlier segment of the same command writes/links/moves/deletes/extracts into, or after an unmodeled program (git, npm, scripts), or through /proc/<pid>/cwd, is unknowable (policy.core / account.credential). The pure classifier has no filesystem; the Hermes hook is the gate on the village. S(open) closed by rule: an argv word of curl/wget/cp/mv/ln/install the shell may still turn into an option (unquoted variable or $(...), a variable at a word's head, an unquoted glob at its head, a brace making a `-` word, an unquoted expansion in an option value) makes the target unknown (fetch-output-unknown, new copy-target-unknown) unless after `--`; the lexer records per word whether an unquoted expansion splits or expands (LexWord.splits/expands). Output values with `#<digit>` are unknown; --output-dir joins absolute -o. N-a: an over-cap brace word whose groups are all plain numbers is judged by its first word (numericRepresentative). N-b accepted design limit, documented. tests/command-class.test.ts: four AMBIGUOUS_FETCHES rows and `curl $(cat url.txt)` move network.call -> policy.core (stricter, intended). +24 vectors, +5 tests.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The Hermes home's hermes-agent/, plugins/ and .op.env are organs (policy.core to write; .op.env and hermes-agent/.env account.credential to read), the hermes CLI verbs that rewrite them are policy.core, $HERMES_HOME and other variables reach the organ rows in the pure classifier, and the hook judges where a write lands. Verified: targeted tests command-class-hermes-home-organs (12), cli-hook-hermes-home-organs (7), cli-hook-hermes-rules, cli-hook-hermes, command-class*, protected-path-guard, wysiwys, agent-village-policy, conformance, conformance-regen all exit 0; conformance 618/618; lint exit 0.
<!-- SECTION:FINAL_SUMMARY:END -->
