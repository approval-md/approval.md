---
id: APRV-224
title: >-
  AgentMail launch: AGENTMAIL_ credential prefix, SPEC 10.4/14 amendment, README
  and examples/agentmail-demo.md
status: In Progress
assignee:
  - '@claude-opus'
created_date: '2026-09-02 16:30'
updated_date: '2026-09-02 17:50'
labels:
  - adapter
  - launch
  - docs
  - spec
dependencies:
  - APRV-223
priority: high
ordinal: 184000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Closes the AgentMail stack for the 0.1.0 launch. (1) `AGENTMAIL_` joins SECRET_ENV_PREFIXES in src/core/command-class.ts so the agent AgentMail key never leaks into `approval run` children. (2) SPEC.md section 10.4 is amended: adapter examples name adapter-agentmail, the prefix list adds AGENTMAIL_, and a new paragraph states the two-key enforcement model (agent key without send permissions, gate key in the vault with them) and how a remote mutable draft is bound by the bytes fetched at request time; section 14 M7 notes the second adapter. This is a spec divergence: draft the text, call it out, and Carter signs it through the policy.edit gate. (3) README adapter walkthrough gains the AgentMail variant and examples/agentmail-demo.md shows the full loop: agent writes a draft, `payload agentmail-draft`, register/request, Telegram approve, `adapter agentmail` sends, log verifies. No APPROVAL.md change: adapter execution classifies by the registered action class, never network.call. APRV-199 depends on this task.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 AGENTMAIL_ is in the credential-bearing prefixes; tests/child-env.test.ts and tests/command-class.test.ts cover it; env_stripped counts an AGENTMAIL_ variable
- [x] #2 SPEC.md sections 10.4 and 14 amended as described and the divergence called out to Carter for sign-off; no silent spec edit
- [x] #3 README adapter section shows the AgentMail path and the two-key split; examples/agentmail-demo.md exists and tests/docs-guard.test.ts passes on its exit-code and refusal claims
- [ ] #4 Manual e2e against a real AgentMail account recorded in the notes: agent key gets 403 on messages/send; edited draft refuses agentmail-draft-drifted with grant intact; approved draft sends once; `approval log verify` clean
- [x] #5 npm test green, lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add AGENTMAIL_ to SECRET_ENV_PREFIXES in src/core/command-class.ts (comment says why the prefix joins the family).
2. tests/child-env.test.ts: put AGENTMAIL_API_KEY in the session fixture, update the withheld list and the stripped/passed counts, and add a case proving the agentmail adapter's declared credentials are vault names (agentmail.api_key / agentmail.inbox_id) so nothing AGENTMAIL_-prefixed rides through a declaration.
3. tests/command-class.test.ts: an AGENTMAIL_-referencing command classifies as secret-bearing the way APPROVAL_/TELEGRAM_/VAULT_ do, and isSecretEnvName answers for the bare name.
4. examples/agentmail-demo.md: draft-bound loop (agent's no-send key composes, approval payload agentmail-draft, register/request, Telegram approve, approval adapter agentmail, log verify) plus the direct-send variant; every exit code and refusal name checked against src/cli/exit-codes.ts and AGENTMAIL_FAILURE_CODES.
5. README.md: the AgentMail path and the two-key split inside the existing 'Hand a grant to a real credential' section, no restructuring.
6. SPEC.md 10.4 and 14 M7 in as few Edit calls as possible (policy.edit, gated); legend of the edits appended to these notes first.
7. npm run build + targeted node --test, then full npm test and npm run lint; commit only my files plus the task file.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Lane split: APRV-223 owns src/cli/*, src/adapters/registry.ts, src/adapters/agentmail.ts, docs/cli-reference.md and the CLI tests; this lane owns core/command-class.ts, the two core tests, SPEC.md, README.md, examples/agentmail-demo.md.

SPEC.md edit legend (each item is one Edit call, each classifies policy.edit and reaches Carter as its own prompt):
(1) §10.4 opening sentence: the adapter examples become 'adapter-email, adapter-agentmail, adapter-gcal'. Nothing else in that paragraph changes.
(2) §10.4 child-environment paragraph (APRV-205's): the credential-bearing prefix list gains AGENTMAIL_, its citation gains 'The AGENTMAIL_ prefix is APRV-224', and ONE new paragraph is appended after it stating (a) the two-key enforcement model AgentMail keys make possible (agent key holds draft_create/draft_update/draft_read and no send permission; the vault key holds draft_send and message_send and is read only inside the verified-token window; without the split a key in the agent's environment is a full bypass, which is §11's stated undefended case; no pre-send webhook exists, so the permission boolean is the whole mechanism) and (b) how a grant binds a remote mutable object (the grant binds the bytes fetched at request time, the adapter re-fetches and refuses agentmail-draft-drifted, distinct from payload-mismatch, naming which fields differ and never what they now hold). Signed '(Amended APRV-224.)'.
(3) §14 M7 line: notes that a second adapter (AgentMail) serves the same class over an HTTPS API and exercises §10.4's two-key model.
No §11 edit proposed: the 'Not defended' list already states 'an agent with direct credential access outside adapters', which is exactly the case the two-key split addresses, and the new §10.4 paragraph cites it rather than restating it. MILESTONES.md is left alone: its M7 row records a done milestone's historical scope and APRV-224 carries no milestone.

Done in this lane.

CODE. src/core/command-class.ts: AGENTMAIL_ joins SECRET_ENV_PREFIXES, with a comment saying why (an AgentMail key is a mailbox in one string, and the two-key split of SPEC 10.4 is undone by either half sitting in a granted child's environment). No other core change was needed: core/child-env.ts already reads the list.

TESTS. tests/child-env.test.ts puts AGENTMAIL_API_KEY in the session fixture, so the withheld-name sweep covers it and the env_stripped counts move 5->6 and 4->5 (the count assertion is the AC's 'counted in env_stripped'). A new case, 'the agentmail adapter declares vault names, so nothing AGENTMAIL_ passes', asserts requiredAgentmailCredentials() is exactly ['agentmail.inbox_id','agentmail.api_key'], that no declared name is AGENTMAIL_-prefixed, and that passing the whole declaration through childEnvironment still withholds AGENTMAIL_API_KEY with passed=0: the declaration is honoured in full and cannot open the scrub, because a vault name can never match an environment variable. The APRV-169 case that deepEqualled the class's union with the email adapter's declaration is now a superset check, since APRV-223 registers a second adapter on communicate.email.external and an equality there would fail the moment the roster grows. tests/command-class.test.ts gains three credential fixtures (printenv AGENTMAIL_API_KEY, echo $AGENTMAIL_API_KEY, a curl Authorization header) and a membership test pinning SECRET_ENV_PREFIXES name by name with the isSecretEnvName edge cases (bare prefix, no underscore, prefix in the middle).

DOCS. examples/agentmail-demo.md is the draft-bound loop: two keys, the agent composes with curl, the agent key gets 403 on the send (step 6, the load-bearing result), payload agentmail-draft snapshots the bytes, register/request/Telegram approve, an edit to the draft refuses adapter-failed (agentmail-draft-drifted) at exit 1 with the grant intact, the restored draft sends once, the second spend refuses token-consumed at exit 1, log verify clean. It leans on examples/email-demo.md for the shared scaffolding rather than repeating 700 lines of it. The direct-send variant and a 'when something goes wrong' table close it out. README gains a subsection under 'Hand a grant to a real credential' with the two-key split and the drift binding; nothing was restructured. tests/docs-guard.test.ts gains two guards over the new example (its runtime refusals against ADAPTER_REFUSAL_CODES plus the existing unions, its agentmail-* refusals against isAgentmailFailureCode, and the four permission names it depends on) and one over the README's AgentMail paragraph.

ONE ASSUMPTION TO RECONCILE WITH APRV-223: the demo says 'approval payload agentmail-draft' reads the agent's own draft_read key from AGENTMAIL_API_KEY in the environment. That is the only source that makes sense (the vault key is the send-capable one and opens only inside the token window), but the verb is the sibling lane's to build. If it resolves the key differently, step 4 of the example needs one line changed.

SPEC.md: the three edits of the legend were applied through the harness hook, which classified each as policy.edit and let it proceed under today's supervised-live policy. No prompt blocked and no tap was collected, so none of them is signed off yet: the new 10.4 paragraph is marked '(Amended APRV-224, pending sign-off.)', matching the pending-sign-off amendments already in that section, and the 14 M7 line cites the task rather than claiming a grant. Carter's retrospective sample is where the sign-off is owed. Nothing was edited silently: the legend above was written to these notes before the first edit.

VERIFICATION. npm run build clean. node --test over dist/tests/child-env.test.js, dist/tests/command-class.test.js and dist/tests/docs-guard.test.js: 317 tests, 317 pass, 0 fail. Full npm test: 2902 tests, 2901 pass, 0 fail. npm run lint (oxlint src tests): clean, no output. Note for the reader: APRV-223 is running in this same worktree, so two earlier full-suite runs failed inside ITS in-flight CLI files (a setup-adapter help string, a per-verb help length); both were transient and the final run is green.

AC4 (manual e2e against a real AgentMail account) is NOT done and is left unchecked. It cannot be done from this session: there are no AgentMail credentials here and the calls are network.call. It is Carter's step, and examples/agentmail-demo.md is the runbook for it. The four things to record afterwards: (1) step 6, the agent key returns 403 on POST /v0/inboxes/{inbox}/drafts/{draft}/send; (2) step 9, an edited draft refuses 'adapter-failed (agentmail-draft-drifted)' at exit 1 with no execution.completed and the grant still spendable; (3) step 10, the restored draft sends exactly once, execution.completed appended; (4) step 12, 'approval log verify' clean, with the seq range and head hash noted here. No result for any of these is claimed or fabricated in this task.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
AGENTMAIL_ joins the credential-bearing prefixes in src/core/command-class.ts, so an AgentMail key is withheld from every child approval run spawns and counted in env_stripped without being named; tests/child-env.test.ts and tests/command-class.test.ts prove both, plus the property that keeps the adapter's own declaration from reopening the hole (every name it declares is a vault name, so nothing AGENTMAIL_-prefixed can pass through). SPEC.md 10.4 names adapter-agentmail, adds the prefix to the scrub list, and gains one paragraph stating the two-key enforcement model and how a grant binds a remote mutable draft by the bytes fetched at request time; 14's M7 line notes the second adapter. README gains the AgentMail path and the two-key split, and examples/agentmail-demo.md walks the whole loop with guards in tests/docs-guard.test.ts over its refusal names and permission names. Verified with npm run build, node --test over the three owned test files (317/317), full npm test (2902 tests, 2901 pass, 0 fail) and npm run lint clean. AC4, the manual e2e against a real AgentMail account, is unchecked and stays open: it needs credentials this session does not have and network calls it may not make, so the notes name it as Carter's step with the exact four observations to record. The SPEC edits proceeded through the policy.edit hook without a blocking prompt, so the new paragraph is marked pending sign-off.
<!-- SECTION:FINAL_SUMMARY:END -->
