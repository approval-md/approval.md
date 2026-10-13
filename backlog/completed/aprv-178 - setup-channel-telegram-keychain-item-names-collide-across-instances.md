---
id: APRV-178
title: 'setup channel telegram: keychain item names collide across instances'
status: Done
assignee:
  - '@claude'
created_date: '2026-08-31 02:05'
updated_date: '2026-09-01 21:18'
labels:
  - core
  - setup
dependencies: []
ordinal: 157000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found live 2026-08-31: the demo instance at ~/demo-gate was provisioned with setup channel telegram while the primary repo gate already existed; the setup verb stores/reads the bot token under the FIXED keychain service name approval-tg-token, so the demo instance's .approval/env pointed at the PRODUCTION bot's token. Consequences observed: demo prompts delivered through the production bot; two listeners long-polling one bot token fought over getUpdates; a human tap was consumed by the wrong listener and refused as unauthorized. Instances are directory-scoped everywhere else (policy, log, vault, env); keychain item names must be too. Fix direction: derive the service name from the instance (e.g. approval-tg-token-<8 hex of log path hash>) or make it a setup prompt with a per-instance default; on finding an EXISTING item under a candidate name, setup must ask whether it belongs to THIS instance rather than silently reusing it; doctor's telegram row should flag two instances resolving the same item. Migration note: existing single-instance users keep working (first instance may adopt the legacy name).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Two instances provisioned on one machine store and resolve distinct keychain items with no manual renaming
- [x] #2 setup channel telegram never silently reuses an existing keychain item for a new instance; the reuse question names the item and the instance
- [x] #3 approval doctor flags cross-instance sharing of a telegram token item
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add `src/core/instance.ts`: `instanceHomeFor(logPath)` (the resolved `.approval` directory), `instanceIdFor(logPath)` (first 8 hex of sha256 of that path), and `scopedService(base, logPath)` -> `<base>-<id>`. Export the legacy unscoped bases alongside.
2. `src/cli/setup-common.ts`: keep the three fixed strings as LEGACY_SERVICE_* and add `servicesFor(logPath)`; put the resolved per-instance names on `Context` (`services`) and on `HintContext` so the non-interactive hints print the same names the interactive path writes.
3. `src/cli/setup-channel.ts` + `src/cli/setup.ts`: use the per-instance names. In `setup channel telegram`, before storing, probe the keystore for the legacy unscoped item when no per-instance item exists; if one is there, ASK (naming the item and this instance's path/id) whether it belongs to this instance. Adopt the legacy name only on an explicit yes; never reuse silently. `recoverToken` falls back to the legacy name with a loud stderr notice.
4. `src/core/env-file.ts`: record on `ResolvedVariable` the file entry that was NOT consulted when the ambient environment won (`overridden`, a source LABEL, never a value).
5. `src/cli/env.ts`: `--check` prints a BLEED block for every variable whose value came from the ambient environment while the instance file names a different source; `--json` carries `overridden`.
6. `src/cli/doctor.ts`: new `keychain-scope` check, name-only (no keystore lookup, so no unlock prompt): fail when the token line names another instance's scoped item, warn when it names the unscoped legacy item, and report ambient bleed from `overridden`.
7. `src/cli/channel-telegram.ts` `prepareListen`: return `warnings`, one of which is the ambient-bleed warning; `approval up` and `channel telegram listen` both print them.
8. Tests in `tests/`: naming (two temp-dir instances get distinct names), the legacy fallback and its notice, the reuse question (both answers), the doctor collision/bleed rows, and a sweep proving no token value is printed on any of the new paths.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Second half of the footgun, found minutes later on the same machine: the operator's shell rc exports the production APPROVAL_TG_TOKEN/CHAT globally (that is how the primary daemon is fed), and approval env defers to already-exported values over the instance's .approval/env ('already exported; the file was not consulted'). So every fresh terminal silently inherits the production channel and the demo instance kept sending through the production bot even after its env file was corrected. Operator remedy: unset APPROVAL_TG_TOKEN APPROVAL_TG_CHAT APPROVAL_HUMAN before eval. Fix direction to weigh alongside the keychain scoping: when the resolved value's SOURCE is the ambient environment but the instance's env file names a different source, approval env --check should warn loudly (cross-instance bleed), and approval up should refuse or warn when its channel token provably resolves from outside the instance.

Scope note: the same fixed-name defect applies to the vault passphrase and the sampling secret items, which sit in the same constant block. Scoping only the Telegram one would leave two known-colliding items behind, so all three go through the one `servicesFor` helper. The acceptance criteria remain Telegram's.

## What was done

Keystore item names are now derived from the instance instead of being three fixed strings. `src/core/instance.ts` is the new home for the identity: `instanceHomeFor(logPath)` is the resolved `.approval` directory (via `envFilePathFor`, so the two log spellings this runtime accepts are one instance), `instanceIdFor` is the first 8 hex digits of its SHA-256, and `scopedService(base, logPath)` gives `approval-tg-token-3f2a9c11` and its two siblings. Symlinks are deliberately not resolved: `realpathSync` would make an instance's identity depend on whether its directory exists yet, and `setup` has to name the item it is about to create. Two routes to one directory therefore mint two names, which is the safe direction of that error.

## Decisions

- **Scope extension, accepted by the coordinator.** The vault passphrase and the sampling secret sat in the same constant block with the same defect. Scoping only Telegram would have shipped two known-colliding items, so all three go through one `servicesFor(logPath)` helper in `cli/setup-common.ts`. The acceptance criteria stay Telegram's; the mechanism is shared.
- **The legacy unscoped item is a doctor SKIP, not a FAIL, also accepted.** It is what every pre-APRV-178 installation looks like and it is correct on a machine with one gate. A red row for every existing install is a red row people learn to scroll past. The genuinely wrong case, a name whose scope suffix is another instance's, is the `fail`.
- **Migration is never silent.** `.approval/env` already carries the service name in the open, so existing files keep resolving with no change at all. Where a NAME has to be chosen afresh, `setup channel telegram` probes the legacy item first (one extra lookup on the ordinary machine, and no question), and only when it exists and this instance's own does not does it ask, naming the item, the instance directory and the instance id. A typed `yes` in full adopts it; anything else gives this instance its own. `recoverToken` falls back to the legacy name with a loud stderr notice.
- **Doctor answers from NAMES, never a lookup.** `checkKeychainScope` resolves nothing, so it cannot block on a keychain-unlock dialog, which is the rule `NON_RESOLVING_RUNNER` already encoded for the environment row. That runner moved from `cli/doctor.ts` to `core/env-file.ts` (beside `defaultSourceRunner`) because `approval up` needs the same refusal and two copies would be two sets of words for one rule.
- **The ambient-bleed half of the incident.** `ResolvedVariable` gained `fileSource`: what the instance's own file said, kept even when the shell won. It is value-free by construction (a `literal` entry contributes its KIND alone, because its argument IS the secret). `approval env --check` prints a CROSS-INSTANCE BLEED block from it, `--json` carries `file_source`, doctor reports it, and `approval up` says it once on stderr as the Telegram channel starts.

## Invariants touched

SPEC §11.1 invariant 3 (raw secrets never appear in the log or output): every new surface here is a service name, a scheme, a variable name or a path hash, all of which `.approval/env` already carries in the open. No value is read, compared, length-checked or redacted on any new path, and the suites' existing value-free sweeps cover the new output. Invariant 7 (no verb resolves `.approval/env` implicitly) is unchanged: nothing here resolves a value out of that file, and the bleed report exists precisely to say out loud when the file was NOT consulted.

## Validation

`npm run lint` clean, `npm run build` clean. `tests/instance.test.ts` (8 new) covers the naming, the scope classification and the four findings; `tests/cli-setup.test.ts` (4 new, 83 pass in isolation) covers the reuse question with yes / no / `y` / own-item-present; `tests/cli-doctor.test.ts` (3 new, 55 pass in isolation) covers the fail, the legacy skip and the bleed skip end to end through the spawned CLI; `tests/cli-env.test.ts` (1 new, 37 pass with instance.test.ts) covers the `--check` block and the value-free `file_source`. Full `npm test` had two failures, both reproduced on a stashed pristine baseline build (cli-hook's 20s-wait cases and one cli-setup poll-timing case), so both are the known load flakes and not this change.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Keystore item names now carry an 8-hex instance id derived from the .approval directory path, so two gates on one machine can no longer resolve one bot token. setup channel telegram asks, naming the item and the instance, before adopting the legacy unscoped item and never reuses it in silence; the legacy name still resolves and is reported by a new doctor keychain-scope row (fail for another instance's item, skip for the shared legacy one and for ambient-env bleed). approval env --check gains a CROSS-INSTANCE BLEED block and a value-free file_source in --json, and approval up says it once on stderr. Verified with 16 new tests across tests/instance.test.ts, cli-setup, cli-doctor and cli-env, each suite green in isolation, plus lint and build clean.
<!-- SECTION:FINAL_SUMMARY:END -->
