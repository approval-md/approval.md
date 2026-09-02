---
id: APRV-168
title: >-
  Demo email finale: adapter credential path collides with the runner's env
  scrub
status: In Progress
assignee:
  - '@claude'
created_date: '2026-08-31 00:01'
updated_date: '2026-09-02 08:00'
labels:
  - demo
  - design
dependencies: []
ordinal: 147000
approval:
  origin:
    app: manual
    created_by: 'agent:fable'
  route:
    assignee: 'agent:fable'
    rationale: >-
      Branch adapter-credentials carries the APRV-169 + APRV-168 commits,
      including a SPEC.md 10.4 amendment authored in a spawned agent worktree
      where protected-path prompts may not fire (APRV-151 gap). Publishing the
      branch for PR review is routed through the gate explicitly, per the
      APRV-159 precedent. Verified before request: 2415/2415 tests, lint
      clean, conformance 106 controls clean.
  state: executed
  actions:
    - class: policy.edit
      summary: >-
        git push origin adapter-credentials from /Users/carter/dev/approval-md:
        publish APRV-169 (credentials resolve before token consumption) and
        APRV-168 (scoped vault-passphrase self-resolution inside a consumed
        token window) with their SPEC 10.4 amendment, pending sign-off, for PR
        review. Base origin/main 64f9d0a; commits e2784a1, d733677.
      reversible: true
      est_cost_usd: '0'
      idempotency_key: 'aprv-168:publish-adapter-credentials:2026-08-31'
      payload_hash: '4db66385b232ab385e94371307a98d54441f98c8acd93bb7f6fb84bf6f180fa2'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found during APRV-157 (runbook): the web-agent demo's email finale routes adapter_email through the agent child, whose env the server deliberately scrubs of anything matching APPROVAL|VAULT|TELEGRAM (server.mjs agentEnv, and the security contract requires the server itself to hold no vault passphrase). passphraseFrom (src/core/vault.ts:764) reads only process.env and no verb reads .approval/env into its own environment (src/core/env-file.ts:45), so the agent's adapter call should refuse credential-unavailable. Compounding it: startExecution (src/adapters/contract.ts:560-585) consumes the token and appends execution.started BEFORE the credential window opens, so the failure burns the single-use token and the retry refuses token-consumed. The runbook ships with a mandatory pre-show rehearsal and a stage recovery (operator sends by hand from ~/demo-gate per email-demo.md), but the finale deserves a design answer: candidates include a narrowly-scoped passthrough of the demo instance's passphrase variable into the agent child (weighing that against the server's no-credentials contract, since the child is not the server), the adapter reading the instance's .approval/env itself, or moving credential resolution before token consumption so a credential-unavailable refusal does not burn the token (that last one may be a §11-adjacent change and deserves its own scrutiny regardless of the demo).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A decided design (recorded here) for how a gated adapter reaches vault credentials when its parent process holds none
- [ ] #2 The demo's send_the_email template completes end to end in rehearsal: phone approve, sealed wait, mail sent, execution.completed on the demo log
- [x] #3 Decision recorded on whether credential resolution should precede token consumption in the adapter contract, with a follow-up task if yes
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. APRV-169 (C) lands first on the shared branch; B builds on its final contract shape.
2. Add scoped credential self-resolution: vault passphrase lookup falls back, only inside token-holding adapter execution, to resolving the policy-named variable via .approval/env (keychain: refs included).
3. SPEC 10.4 amendment sentence (gated edit).
4. Tests: resolution works with a scrubbed env inside a token window; unreachable without a token; secret absent from argv/log; demo rehearsal AC left for the phone-in-the-loop pass.
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
<!-- SECTION:NOTES:END -->
