---
id: APRV-205
title: >-
  approval run starves the granted child of credential-bearing environment
  variables
status: Done
assignee:
  - 'agent:opus-lane-n'
created_date: '2026-09-02 03:47'
updated_date: '2026-09-02 05:57'
labels:
  - security
  - dogfood
dependencies: []
priority: high
ordinal: 169000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found by the APRV-193 design lane: commandRun in src/cli/execute.ts (spawnSync at line 452) passes no env option, so a granted child inherits the whole session environment, including the Telegram bot token and the value of the vault passphrase variable. APRV-194 cannot see this: the classifier reads 'npm test', and the credential read happens inside whatever the child runs. This is the minimal, pre-launch slice of APRV-193's 193d (spawn starved): scrub, do not sandbox. Outcome: a child spawned by approval run receives an environment with every variable under the credential-bearing prefixes (APPROVAL_*, TELEGRAM_*, VAULT_*, minus the APRV-194 allowlist of non-secret runtime names) removed, plus any variable the policy's vault.passphrase_env names, unless the adapter for the granted action declared it in requiredCredentials (APRV-169), in which case exactly those are passed. The removal is recorded on execution.started as a count of stripped names (never values, never names beyond the count, per the raw-secrets invariant). Why: the gate holding the token while handing it to every child it launches is custody theatre; the fix is small and the full sandbox (APRV-193) can land later.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A child spawned by approval run cannot read APPROVAL_TG_TOKEN, any TELEGRAM_* or VAULT_* variable, or the vault passphrase variable from its environment, proven by a test whose child prints its environment
- [x] #2 Variables an adapter declares in requiredCredentials for the granted action ARE passed, and nothing else under those prefixes is; the APRV-194 allowlist names (APPROVAL_HUMAN, _AGENT, _ASCII, _MD, _HOME, _DIR) survive
- [x] #3 execution.started carries the count of stripped variables and never a name or a value; the log grep test for raw secrets is extended to this path
- [x] #4 The same scrub applies to the daemon and the hook wherever they spawn a granted command, with a shared helper so there is one list
- [x] #5 docs/cli-reference.md run section states what the child does and does not receive
- [x] #6 npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Export the APRV-194 credential-name knowledge from src/core/command-class.ts (SECRET_ENV_PREFIXES, NON_SECRET_ENV_NAMES, isSecretEnvName) rather than duplicating the list.
2. New src/core/child-env.ts: childEnvironment({ source, passphraseEnv, declaredCredentials }) -> { env, stripped }. Pure, deterministic, core (both the CLI and the daemon may import core; the CLI may not import the daemon, so core is the only placement that gives one list to every caller). Strips every name under the credential prefixes that is not on the allowlist, plus the name the policy's vault.passphrase_env gives; keeps names the granted action's adapter declared in requiredCredentials; everything else (PATH, HOME, locale) passes through unchanged.
3. New src/adapters/registry.ts: declaredCredentialsForClass(class) over the built-in adapter list, so the pass-through set is derived from the adapter's static declaration and never from a caller flag.
4. src/cli/execute.ts commandRun: resolve the declared class from verified records, build the child environment before startExecution, pass it to spawnSync as env, and pass the stripped COUNT into ExecuteOptions.
5. core: ExecuteOptions.envStripped and TokenOptions.envStripped thread the count onto the execution.started payload as env_stripped at BOTH append sites (core/execute.ts non-manual, core/token.ts manual). No CLI flag sets it; the runtime computes it at the spawn site.
6. schema/event.schema.json: one additive allOf block constraining payload.env_stripped on execution.started to a non-negative integer, plus a valid fixture. Minimal and additive: records written before it still validate.
7. Apply the same helper to the git children the hook and the daemon spawn (defence in depth; neither spawns a granted command, which the notes state).
8. docs/cli-reference.md run section: what the child does and does not receive.
9. Tests: tests/child-env.test.ts for the helper, and cli-run cases proving a real APPROVAL_TG_TOKEN value reaches neither the child's printed environment nor the log, that TELEGRAM_/VAULT_/the passphrase variable are gone, that the allowlist and PATH/HOME survive, and that env_stripped is recorded.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What was built

One helper, one list, applied at every spawn.

- `src/core/child-env.ts` (new): `childEnvironment({ source, passphraseEnv, declaredCredentials })` returns `{ env, stripped, passed }`. Strips every name matching the credential-bearing prefixes less the APRV-194 allowlist, plus the name `vault.passphrase_env` gives (which matters when a deployment renamed it outside the prefixes). Adapter-declared credentials (APRV-169) pass. Everything else, PATH and HOME included, passes through untouched.
- `src/core/command-class.ts`: `SECRET_ENV_PREFIXES`, `NON_SECRET_ENV_NAMES` and `isSecretEnvName` are now exported and reused rather than copied. The classifier and the scrub ask the same question of the same list.
- `src/adapters/registry.ts` (new): `declaredCredentialsForClass(class)` over the built-in adapters, so the pass-through set is derived from the adapter's own static declaration. There is deliberately NO flag that names a variable to keep: such a flag would hand the token back to whoever passed it.
- `src/cli/execute.ts`: `commandRun` builds the child environment before `execution.started` (the count is on that event, and a number written afterwards would be a number nobody measured), passes it as `spawnSync`'s `env`, and passes the count into `ExecuteOptions.envStripped`.
- `src/core/execute.ts` + `src/core/token.ts`: `env_stripped` lands on BOTH `execution.started` append sites. The manual path's start event is written by `consumeToken`, so a count threaded into only one of them would have been a field an auditor could not rely on.
- `src/cli/hook.ts` and `src/daemon/git-evidence.ts`: their git children get the same built environment.

## Placement, argued

`src/core/`, because `tests/layering.test.ts` forbids the CLI importing the daemon and both must reach one list; core is the only directory both may import. The class-to-adapter lookup could not go there (core knows nothing about adapters and must not learn), so it sits in `src/adapters/` and the CLI does the joining.

## Findings the diff does not show

- **Nothing but `approval run` spawns a granted command.** The hook answers allow or deny and the harness runs the command itself; the daemon advances the log and executes no action; the web-agent demo's server already builds its agent's environment from an allowlist (`agentEnv()` in examples/web-agent-demo/server.mjs, which excludes APPROVAL/VAULT/TELEGRAM/TG_ by pattern). AC #4 is therefore satisfied by applying the helper to those processes' git children, which is defence in depth rather than the load-bearing case, and by there being one helper for the granted spawn when a second one appears.
- **`src/cli/gloss.ts` spawns `claude -p` with the full inherited environment.** Out of this task's scope (it is not a granted command), and a real remaining hole in the same family. Worth its own task.
- The child env is built from a second verified read of the log (to learn the declared class). A log that cannot be read yields the empty pass-through set, which starves more rather than less: `startExecution` refuses on the same read immediately afterwards.

## Invariants touched (SPEC §11.1)

- **Raw secrets never appear in the log.** `env_stripped` is a COUNT. A variable's name is half of a credential, so no name and no list is recorded, and the new cli-run case asserts the string `APPROVAL_TG_TOKEN` appears nowhere in the log for this path.
- **Self-reported fields never reduce scrutiny.** The count is informational: nothing in the gate reads it back, no decision turns on it, no CLI flag sets it, and it is computed by the same process that spawns.
- **Validate at the write boundary.** The schema change is one additive `allOf` block constraining `payload.env_stripped` on `execution.started` to a non-negative integer, plus one valid and one invalid fixture. Additive and optional by design: records written before it validate and verify unchanged, and an execution with no child (an adapter's in-process `act`) records no count, because 'none withheld' and 'no child' are different facts.

## SPEC.md §10.4, drafted (Amended APRV-205, pending sign-off.)

> An executor that spawns a child MUST construct that child's environment rather than inherit one. It MUST withhold every variable whose name falls under the credential-bearing prefixes the runtime maintains (`APPROVAL_`, `TELEGRAM_`, `VAULT_`), less the runtime's own declared non-secret names, and MUST withhold the variable named by `vault.passphrase_env` wherever that name falls. It MUST pass the credentials the adapter serving the action's class declared in `requiredCredentials`, and MUST NOT accept any other instruction, from a flag or from a payload, about which variables to pass. Every other variable passes through unchanged. The `execution.started` record MUST carry `env_stripped`, the count of variables withheld, and MUST NOT carry their names or their values. This is a credential scrub and not a sandbox: the child retains the network and filesystem capability of the process that spawned it.

## Decisions an orchestrator might overrule

1. `env_stripped` is NOT in `approval run --json`'s summary. It would have been useful to an operator, and it makes the summary's value environment-dependent, which turns one exact-shape test into a shape-plus-typeof test. Say the word and it goes in.
2. The hook and daemon git children were scrubbed even though neither spawns a granted command. The alternative reading of AC #4 is to touch neither and say so.
3. The scrub is a denylist over the credential families with everything else passing through. APRV-193 §3.4 wants a real allowlist, and it wants it at the SESSION boundary where the operator launches the harness. A per-child allowlist here would break every command an agent legitimately runs.

## Validation

- `npm run build`: clean. `npm run lint` (oxlint src tests): clean.
- `npm test`: 2699 tests, 2698 pass, 1 skipped (pre-existing), 0 fail. 17 of those are new: 11 in tests/child-env.test.ts, 4 in tests/cli-run.test.ts, 2 fixture cases.
- The end-to-end case exports a fixture APPROVAL_TG_TOKEN value, runs a granted child that writes and prints its whole environment, and asserts the value is in neither the child's environment map, nor the child's stdout, nor the log.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
approval run now builds its child's environment instead of inheriting one: every APPROVAL_/TELEGRAM_/VAULT_ variable outside the APRV-194 allowlist and the variable vault.passphrase_env names are withheld, adapter-declared requiredCredentials (APRV-169) pass, and everything else (PATH, HOME, locale) is untouched. One helper (src/core/child-env.ts) reusing the classifier's own list, applied at the granted spawn and at the hook's and daemon's git children. execution.started carries env_stripped, a count and never a name or a value; the schema change is one additive optional integer field with a valid and an invalid fixture. Verified by npm test (2699 tests, 2698 pass, 1 pre-existing skip, 0 fail), lint and build clean, including an end-to-end case that exports a fixture token value and proves it reaches neither the granted child's environment, nor its stdout, nor the log.
<!-- SECTION:FINAL_SUMMARY:END -->
