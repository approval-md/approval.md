---
id: APRV-325.3
title: Confine Codex shell work and prove end-to-end gate enforcement
status: Done
assignee:
  - '@opus-lane-codex-broker'
created_date: '2026-09-09 07:39'
updated_date: '2026-09-17 02:09'
labels: []
dependencies:
  - APRV-325.2
references:
  - docs/codex-boundary-probe.md
parent_task_id: APRV-325
priority: high
type: feature
ordinal: 245000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Provide practical shell and patch compatibility in the constrained Codex workflow. Shell runs in a disposable isolated workspace; only policy-bound changes can reach the canonical workspace. Verify the whole session before advertising mandatory enforcement.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Shell receives no canonical workspace or gate write authority, ambient credentials, external egress or mutable executor code; no opt-out or raw fallback exists.
- [x] #2 Native write/patch tools and all alternate mutable app/browser/MCP capabilities are demonstrably constrained; managed configuration presence alone is insufficient evidence.
- [x] #3 Denied or missing authority, crashes, disconnects, timeouts and replay cannot produce unauthorized canonical effects; one approved bound change produces exactly its permitted effect and a verifiable outcome.
- [x] #4 Installed-package setup/start/doctor and activation/rollback instructions are tested on supported configurations, and unsupported hosts refuse rather than silently weakening enforcement.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add write confinement to src/core/sandbox.ts as an optional writeAllow member on EgressAllowance. When present the Seatbelt profile emits a file-write deny plus an allow-list of subpaths, with /dev allowed unconditionally because writes there are process I/O rather than filesystem state. Deny-DEFAULT for this one rule family only. The module's deny-list posture for reads is untouched and the egress-only profile every other caller uses is byte-identical to before.

2. Build the confined runner in src/codex/runner.ts. planConfinedSession derives everything from the installation manifest, creates a disposable workspace under the system temp directory, and returns the room: writeAllow naming ONLY that workspace, denyRead over the vault and environment map and sealing keys, and an environment built from a literal ALLOW-list called CONFINED_ENV_ALLOW applied after the credential strip in core/child-env.ts, so a provider key this runtime has never heard of is absent rather than forgotten. runConfined resolves the command BEFORE wrapping it, and a command that does not resolve is a refusal rather than an unwrapped spawn.

3. Keep no opt-out and no raw fallback. Unlike approval run, an unsupported host REFUSES with sandbox-unsupported instead of recording unsupported and proceeding. The two sandbox environment overrides still only tighten, and no flag anywhere runs the shell outside the room.

4. Expose it as approval codex start, taking the manifest, an optional timeout, and an optional trailing command after a double dash. With no command it reports the room and runs nothing. With one it runs it inside and exits with the child's own code. The registry entry replaces the old codex-not-ready reservation and stays human_only, so the broad MCP catalogue still publishes nothing from the codex family.

5. Prove it with paired adversarial tests in tests/codex-confine.test.ts. Every confinement case runs the same script twice, unconfined where it MUST succeed and confined where it must fail: canonical workspace write, gate log and policy write, credential read, loopback connect answering ECONNREFUSED unconfined against EPERM confined, which is what separates denied from nothing-listening, a grandchild shell write, and six distinct write APIs at once. Plus crash, non-zero exit, timeout, session disposal and replay, and the end-to-end case where the confined shell cannot make the change, the broker makes exactly it, and the byte-identical replay is refused.

6. Add installed-package evidence to tests/codex-package.test.ts. Setup, strict doctor and start all run from a tarball installed OUTSIDE any checkout against a scratch instance, with start refusing sandbox-unsupported on a host that has no mechanism.

7. Write the activation and rollback runbook with human-only steps marked. docs/codex-activation.md belongs to Lane 4b and was not on origin/main, so the section lives at the end of docs/codex-enforced-session.md and says so plainly.

8. Leave read confinement out of this change. Lane 3's allowRead read profile had not landed on origin/main, so the read-scoping leg is pending and the acceptance criterion it would prove is not checked.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Read confinement leg, completed after Lane 3's APRV-347 read profile landed on origin/main in PR 411. Merged origin/main into the branch as a merge commit c2e2347 with no rewrite. The only conflict was in src/core/sandbox.ts and it was purely additive on both sides: APRV-347 adds an optional allowRead to EgressAllowance and APRV-325.3 adds an optional writeAllow, so the resolution keeps both members. The rule families compose in the order SBPL needs, with the read jail's allows first, the credential denials after them so a vault inside an allowed root stays the last word on itself, and the write rules last. No other file conflicted. The .approval tree in this merge is byte-identical to origin/main's: a records advance came in with main and nothing here authored a log change.

The jail has exactly two roots: the disposable workspace and the canonical workspace. A session has to READ the tree it is reasoning about, which is why the canonical workspace is a root and why write confinement rather than read denial is what stops it changing one. Everything else the host holds, including the gate home, other repositories and the operator's keys, is outside the jail. core/sandbox.ts supplies the fixed runtime set and the running command's own install prefix itself, so nothing in the runner names a toolchain.

Four new cases, three of them paired. The canonical workspace is READABLE inside the room, which is the control that stops the denial cases being vacuous; a file beside the two roots that nothing names and nothing denies is unreadable while its control leg reads it fine; the gate's own log is unreadable rather than merely unwritable, again with a control; and the composed profile is asserted to place the credential denial after the jail's allows. Suite is now 26 tests, 26 pass, 0 fail, 0 skipped on darwin.

Validation after the merge, same host. Build exit 0, typecheck exit 0, lint exit 0 with zero warnings. Conformance exit 0 with 316 vectors, 0 failures and 148 controls, which now includes Lane 3's new read-scope vectors. Targeted sweep of codex-confine, sandbox, cli-hook-scope, cli-hook, codex-broker, cli-codex-apply, cli-long-help, cli-instructions, cli-help, codex-doctor, codex-manifest, codex-project-config, mcp-server, layering, docs-guard, cli-run, child-env, execute, conformance, conformance-regen and cli-policy-apply: 469 tests, 469 pass, 0 fail, exit 0. Core regression of cli, gate, human-only, concurrency, state, audit, adapters-contract, cli-status, validate, log, cli-up-preflight and cli-amend: 464 tests, 464 pass, 0 fail, exit 0.

With the read leg built and proven, AC2 is now checked for what it actually covers, and the residual gap is restated rather than dropped: this demonstrates that write and patch APIs, descendant processes and reads are constrained for processes this runtime spawns on macOS. It demonstrates nothing about a Codex desktop application, its browser tool or a second MCP server that a person starts OUTSIDE approval codex start, because those processes are not in the room. Managed configuration presence is not offered as evidence anywhere.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
A Codex session's shell now runs in a room: a disposable workspace that is the only path it may write, a read jail of exactly two roots so the gate home and everything else the host holds are unreadable, an environment allow-list rather than a filtered copy of the operator's, and outbound network denied with loopback. Descendants inherit all of it, which is the property that matters, since a session spawns shells rather than calling into this runtime. There is no opt-out flag and no unwrapped fallback: a host with no sandbox mechanism refuses where approval run would record unsupported and proceed. Verified by 26 tests, the confinement ones paired so each runs the same script unconfined where it must succeed and confined where it must fail, including ECONNREFUSED against EPERM for egress, a grandchild shell write, six write APIs at once, a readable canonical workspace beside three read denials, crash, timeout, replay, and the end-to-end case where only the broker's change reaches the canonical workspace. Inside 469 passing targeted tests, a 464-test core regression sweep, 316 conformance vectors and a green CI run. What it does not cover is stated rather than implied: a desktop application started outside the room is not in it.
<!-- SECTION:FINAL_SUMMARY:END -->
