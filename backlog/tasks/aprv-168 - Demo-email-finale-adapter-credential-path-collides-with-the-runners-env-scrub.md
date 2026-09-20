---
id: APRV-168
title: >-
  Demo email finale: adapter credential path collides with the runner's env
  scrub
status: Done
assignee:
  - '@claude'
created_date: '2026-08-31 00:01'
updated_date: '2026-09-20 01:10'
labels:
  - demo
  - design
dependencies: []
ordinal: 147000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found during APRV-157 (runbook): the web-agent demo's email finale routes adapter_email through the agent child, whose env the server deliberately scrubs of anything matching APPROVAL|VAULT|TELEGRAM (server.mjs agentEnv, and the security contract requires the server itself to hold no vault passphrase). passphraseFrom (src/core/vault.ts:764) reads only process.env and no verb reads .approval/env into its own environment (src/core/env-file.ts:45), so the agent's adapter call should refuse credential-unavailable. Compounding it: startExecution (src/adapters/contract.ts:560-585) consumes the token and appends execution.started BEFORE the credential window opens, so the failure burns the single-use token and the retry refuses token-consumed. The runbook ships with a mandatory pre-show rehearsal and a stage recovery (operator sends by hand from ~/demo-gate per email-demo.md), but the finale deserves a design answer: candidates include a narrowly-scoped passthrough of the demo instance's passphrase variable into the agent child (weighing that against the server's no-credentials contract, since the child is not the server), the adapter reading the instance's .approval/env itself, or moving credential resolution before token consumption so a credential-unavailable refusal does not burn the token (that last one may be a §11-adjacent change and deserves its own scrutiny regardless of the demo).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A decided design (recorded here) for how a gated adapter reaches vault credentials when its parent process holds none
- [x] #2 The demo's send_the_email template completes end to end in rehearsal: phone approve, sealed wait, mail sent, execution.completed on the demo log
- [x] #3 Decision recorded on whether credential resolution should precede token consumption in the adapter contract, with a follow-up task if yes
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. ROOT CAUSE (proven by probe, 2026-09-19): the scoped fallback (adapters/env-passphrase.ts, APRV-168) and the resolve-before-consume ordering (adapters/contract.ts resolveRequiredCredentials, APRV-169) are both live and both correct. What fails is the keychain lookup itself: defaultSourceRunner.keychain in src/core/env-file.ts spawns security find-generic-password with the ambient environment, and macOS resolves the keychain SEARCH LIST through HOME. The demo server runs the agent child with HOME under the instance (agent-home), so the login keychain is not in the search list and every keychain: reference in that child returns errSecItemNotFound. Probe evidence: security list-keychains under a redirected HOME returns only /Library/Keychains/System.keychain and default-keychain fails; the same call with HOME pinned to the passwd home returns the login keychain. os.userInfo().homedir comes from the passwd database and is unaffected by HOME; os.homedir() follows HOME and is the wrong source.
2. FIX (one seam, the same resolver approval env uses): defaultSourceRunner.keychain retries the lookup once with HOME pinned to the passwd home when the first attempt failed and the ambient HOME differs. No new authority: the same uid can already spawn security with any HOME, and the keychain ACL and unlock state are the real controls. Refusal semantics unchanged (the first attempt wins when the retry also fails).
3. The scoping is untouched: the adapter still reaches .approval/env only through passphraseUnderGrant, which needs an ExecutionGrant the contract mints. No secret enters argv, env, output or log on either path.
4. Extract the demo server child environment into examples/web-agent-demo/agent-env.mjs (agentEnv, agentHomeFor, agentConfigDirFor, the credential allowlist and the scrub). server.mjs imports it with no behaviour change, so the scrub has one definition that the preflight and the tests can use verbatim.
5. Preflight: demo-provision.mjs --check gains a child-credentials step that runs approval env --check --json in the child scrubbed shape and fails when the policy named vault passphrase variable does not resolve there. No token, no send, no value printed.
6. Tests through the real verbs: a stub security on PATH keyed on HOME (reproduces the live failure and proves the repair) in tests/cli-env.test.ts; a new end-to-end test that runs approval adapter email in the servers own scrubbed child environment with a stubbed keystore and the mock SMTP, asserting execution.completed, a clean chain, the retry shape, and that the passphrase reaches no stream and no log byte; plus the no-token negative.
7. Docs: runbook beat 4 (the pre-APRV-169 claim that the token is burned before the vault opens is stale and gets corrected; the stage recovery paragraph stays because credential-unavailable is still reachable for other reasons) and examples/email-demo.md.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
DESIGN DECIDED 2026-08-30 (Carter, in session): options C + B; A rejected outright (the passphrase would transit the tunnel-exposed server's process tree, breaking the contract that makes tunneling defensible); D remains only the rehearsal fallback until B lands. C (resolve credentials before token consumption) split out as APRV-169 — AC3 satisfied. B, this task's scope: the adapter resolves its own credentials from the instance's .approval/env (following keychain: references) ONLY while holding a valid execution token — the authority is the token, not the environment; a human tapped Approve for exactly this send. This deliberately narrows the 'no verb reads .approval/env into its own environment' line (src/core/env-file.ts), so it needs a SPEC 10.4 amendment stating the scoping (adapter execution inside a granted token window) and review scrutiny on the boundary: self-resolution must be unreachable outside token-holding adapter execution, and the resolved secret must never enter argv, the log, or any served surface.

2026-09-02 verification lane (worktree verify-184-168, code read at origin/main): re-checked whether APRV-205 (runner-built child environment: credential families stripped, adapter-declared requiredCredentials passed through) changes the answer this task already recorded, or whether the collision it describes is still open.

TRACE. The web-agent demo's finale calls the MCP tool `adapter_email`, which server.mjs's agent child runs as `approval adapter email <key> --token <t> --payload <file>` -- this is NOT `approval run`, so it never goes through src/cli/execute.ts's childEnvFor()/childEnvironment() path that APRV-205 built; that path only shapes the environment of a FURTHER child spawnSync launches for `approval run`'s target command. `approval adapter email` (src/cli/adapter.ts:225-247) executes the email adapter in-process and builds its CredentialProvider with vaultCredentialProvider({vaultPath}, {passphraseEnv: passphraseEnvFor(policy), envFilePath: envFilePathFor(logPath)}). The envFilePath option is this task's own prior fix (commit d733677, "APRV-168: scoped credential self-resolution inside a token window"): src/adapters/env-passphrase.ts's passphraseUnderGrant() resolves APPROVAL_DEMO_VAULT_PASSPHRASE (the vault.passphrase_env name from APPROVAL.md) from .approval/env when it is absent from process.env, but ONLY inside a consumed/presented execution grant (an unexported unique-symbol brand minted by adapters/contract.ts, unreachable from any other verb) -- i.e. only after a human has already approved this exact action and the token is being spent. requiredCredentials for the email adapter (src/adapters/email.ts: requiredEmailCredentials -> EMAIL_CREDENTIAL_SPECS) are VAULT entry names (smtp.host, smtp.port, smtp.security, ...), read from the decrypted vault file, not literal process.env variable names -- so APRV-205's env-var passthrough mechanism (childEnvironment's declaredCredentials matching against process.env keys) would not even apply to them if this path did go through a spawn. The two fixes (APRV-205's child-env scrub/passthrough, and APRV-168's env-passphrase fallback) are answers to two different problems: 205 is about what a FURTHER spawned child of `approval run` receives; 168 is about the vault passphrase reaching the adapter's OWN process when that process is itself a descendant of the deliberately-scrubbed agent child server.mjs launches (agentEnv(), server.mjs:695-709, still strips anything matching APPROVAL|VAULT|TELEGRAM|TG_ from the agent's env before spawn). APRV-205 does not touch, help, or hurt this path.

VERDICT: the collision is RESOLVED BY DESIGN, and was resolved by this task's own prior implementation (commit d733677), independent of and unaffected by APRV-205. Evidence:
- src/adapters/env-passphrase.ts and src/adapters/vault-provider.ts (VaultProviderOptions.envFilePath, "the scoped passphrase fallback (APRV-168)") implement exactly design option B from this task's earlier decision.
- src/cli/adapter.ts:231-244 wires envFilePath: envFilePathFor(logPath) into vaultCredentialProvider for `approval adapter email` specifically (and only there -- setup/vault verbs deliberately omit it, comment at vault-provider.ts confirms this).
- tests/vault-provider.test.ts, "The scoped passphrase fallback (APRV-168)" section (lines ~361-560): 8 tests, all passing, including "a scrubbed process resolves the passphrase from .approval/env inside the window", "a keychain: line resolves through the same seam `approval env` uses", "the fallback is unreachable without the token that grant minted", and "the ambient environment wins, and an absent env file changes nothing". Ran `node scripts/run-tests.mjs --only vault-provider`: 16/16 pass.
- tests/e2e-email-demo.test.ts (the M7 demo, full draft->telegram->approve->mail sent->chain-clean walkthrough) and tests/adapter-email.test.ts: ran both (`node scripts/run-tests.mjs --only e2e-email-demo` = 12/12 pass; `--only adapter-email` = 40/40 pass, including "the pre-token credential list is the manifest's required entries, and only those").

AC1 (a decided design for how a gated adapter reaches vault credentials when its parent process holds none): CONFIRMED still correct and still the live implementation; leaving ticked.
AC3 (decision on credential resolution vs. token consumption ordering, with follow-up if yes): CONFIRMED still correct -- APRV-169 (credential resolution moved ahead of token consumption in adapters/contract.ts's resolveRequiredCredentials/startExecution) is merged and is what the env-passphrase grant-window design depends on; leaving ticked.
AC2 (the demo's send_the_email template completes end to end in rehearsal: phone approve, sealed wait, mail sent, execution.completed on the demo log): NOT met by this lane -- this is explicitly the phone-in-the-loop rehearsal Carter has to run against real Telegram and a real mailbox (examples/email-demo.md's walkthrough, or the web-agent-demo runbook's Beat 4). The automated e2e test proves the runtime mechanically; it cannot prove the phone tap or the real mailbox. Leaving unticked, no change to Definition of Done.

No source code changed by this lane. Task remains In Progress; AC2 is the only thing left for Carter's rehearsal pass.

2026-09-19 lane (branch lane/demo-finale-credential-168, PR #498). The live reproduction on ~/demo-gate gave this task the fact it was missing.

ROOT CAUSE, probed not guessed. macOS resolves the keychain SEARCH LIST through HOME. Probe on this machine: security list-keychains under a redirected HOME returns /Library/Keychains/System.keychain alone and security default-keychain fails (SecKeychainCopyDefault: A default keychain could not be found); the same call with HOME pinned to the passwd home returns the login keychain first. os.userInfo().homedir reads the passwd entry and is unaffected by HOME; os.homedir() follows HOME and is the wrong source. The demo server gives the agent child HOME=<instance>/agent-home on purpose (APRV-177), so every keychain: reference in that child answered errSecItemNotFound, including the vault passphrase line setup vault wrote.

WHAT WAS ALREADY RIGHT. The scoped fallback from this task (adapters/env-passphrase.ts, wired at cli/adapter.ts:309) was live and was reached: the live refusal names the env file, which only the fallback path can do. The third candidate, credential resolution before token consumption, is on main as APRV-169: adapters/contract.ts resolveRequiredCredentials (line 978, refusal text at 1004) is called at 1373, ahead of startExecution at 1408. That is why the live refusal ends with nothing appended and no token spent, and why the grant Carter approved is still executable. AC3 needed no revisiting.

THE FIX. core/env-file.ts defaultSourceRunner.keychain retries a failed lookup once with HOME pinned to the passwd home. One seam, the same resolver approval env uses, so the adapter and the human verb cannot disagree. It grants nothing: a process of this uid can already spawn security with any HOME, and the keychain lock state and the item ACL are the actual controls. The first attempt keeps its answer whenever the retry does not succeed, so helper-item-missing and helper-failed still mean what they meant. The grant scoping is untouched: the env file is still reachable only through passphraseUnderGrant and its unexported brand.

SPEC section 11.1 invariant 3 (raw secrets never in the log) is adjacent and holds. The resolved value is returned to the vault provider, used to derive one key, and enters no argv (the service NAME is the argument, the value arrives on stdout), no environment, no message, no refusal and no event. The new suite sweeps every captured stream and every log byte of every instance it created for the passphrase.

ALSO. examples/web-agent-demo/agent-env.mjs now holds the child environment contract, extracted from server.mjs unchanged, so the preflight and the tests use the servers own scrub rather than a copy. demo-provision.mjs --check gained a child-credentials row: the policy-named passphrase resolved in the child scrubbed shape, no token, no vault opened, no mail, no value printed. It may raise the keychain access prompt, which is the right morning for that. Docs: runbook beat 4 (its pre-APRV-169 claim that the token is burned before the vault opens is corrected; the stage recovery paragraph stays, because credential-unavailable is still reachable when the item or the vault is genuinely missing), preflight steps 3 and 7, provisioning.md section 5, examples/email-demo.md (a new paragraph on the one implicit read of the env file, and a troubleshooting row).

TESTS, real verbs only. tests/demo-finale-credential.test.ts: attest, register, request, grant, vault set, adapter email, log verify, with the adapter run under agentEnv() imported from the server module, a stub security on PATH keyed on HOME, and the loopback SMTP mock. With the retry removed from the build it reproduces the live refusal verbatim (credential-unavailable on smtp.host, naming the env file); with it the mail goes out, the chain verifies, the lookups appear in pairs (child home, then passwd home, one pair per declared credential because the provider reads the passphrase per credential), and the no-token case resolves nothing and opens no socket. tests/cli-env.test.ts pins the repair, that the repair invents nothing, and that a correct HOME is looked up once. tests/demo-provision.test.ts pins the new row both ways. No real credential, no keychain read, no touch of ~/demo-gate anywhere.

VERIFICATION. build 0, typecheck 0, lint 0. npm test: 4845 tests, 4822 pass, 22 fail, exit 1, all 22 in adapter-email, cli-setup and smtp-probe and all the pre-existing local Node v26 TLS refusal (Setting the TLS ServerName to an IP address is not permitted) in files this branch does not touch. Re-run after merging origin/main: identical counts and identical three files.

AC2 remains for Carter: it is the phone-in-the-loop rehearsal of beat 4 against real Telegram and a real mailbox, which no automated suite can stand in for. Sequence after this merges: approval log sync and npm run build in the primary, restart the demo server, then node examples/demo-provision.mjs --instance web-agent --check and read the child-credentials row before submitting the beat.

Beat four completed live on 2026-09-20 ~00:50Z on ~/demo-gate after PR 498: fresh submission from the demo page, approve on the phone through @approval_md_demo_bot, sealed wait, the adapter opened the vault inside the token window (keychain reference resolved in the agent child, the demo-provision child-credentials row green), the message arrived in the getapprovalmd@gmail.com inbox. Beats one to three had passed earlier the same evening. Rehearsal setup facts recorded in APRV-386, 390 and 392 notes.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The finale sends: the agent child could not resolve the vault passphrase because macOS builds the keychain search list from HOME and the child runs with HOME under the instance; the resolver retries with the account home (PR 498), credentials resolve before the token is consumed (APRV-169), and the live rehearsal on 2026-09-20 delivered the email after a phone approval.
<!-- SECTION:FINAL_SUMMARY:END -->
