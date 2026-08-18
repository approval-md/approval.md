---
id: APRV-90
title: 'setup prompts: reprompt on a bad answer, accept a bare id for identity'
status: To Do
assignee: []
created_date: '2026-08-18 12:04'
labels:
  - cli
  - ux
dependencies: []
ordinal: 81000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed running examples/email-demo.md (2026-08-18): `approval setup identity` asked `human identity (human:<id>):`, the human typed `carter`, and the verb exited with a usage error followed by the entire help page (~40 lines). Two ergonomics problems in one screen. (a) A wrong answer to an interactive prompt is treated like a mangled command line: exit 2 plus full help. For a prompt, the right behaviour is to say what was wrong in one line and ask again (Ctrl-C still aborts). (b) The `human:` prefix is load-bearing (actors are human:/agent:/system: and the human-only verbs refuse the other two), so it should be visible, but making a person retype a prefix the prompt already printed is a needless failure path: accept a bare `carter` and normalise to `human:carter`, and refuse `agent:*` / `system:*` explicitly with the existing message. Applies to every readLine question in setup (identity, adapter config/choice prompts, the probe question, the vault overwrite confirm), not only identity. Scripted-prompter tests in tests/cli-setup.test.ts cover the verbs; extend them.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A wrong interactive answer reprompts with a one-line reason; it does not exit and does not print help (Ctrl-C/Ctrl-D still abort and store nothing)
- [ ] #2 setup identity accepts a bare id and normalises it to human:<id>; agent:/system: are refused with the existing message
- [ ] #3 Choice prompts (e.g. smtp.security 1-3) and config prompts reprompt on invalid input the same way
- [ ] #4 Scripted-prompter tests cover reprompt and normalisation; examples/email-demo.md and telegram-demo.md transcripts updated where they show these prompts
- [ ] #5 npm test and lint clean
<!-- AC:END -->
