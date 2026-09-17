---
id: APRV-325.3
title: Confine Codex shell work and prove end-to-end gate enforcement
status: Done
assignee:
  - '@opus-lane-codex-broker'
created_date: '2026-09-09 07:39'
updated_date: '2026-09-17 01:54'
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
- [ ] #2 Native write/patch tools and all alternate mutable app/browser/MCP capabilities are demonstrably constrained; managed configuration presence alone is insufficient evidence.
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
Implemented the confined session on top of the APRV-325.2 broker, in one new module plus one optional member on the shared sandbox.

src/core/sandbox.ts gains an optional writeAllow on EgressAllowance and nothing else. When present the Seatbelt profile emits a file-write deny plus an allow-list of subpaths, with /dev allowed unconditionally because writes there are process I/O rather than filesystem state, and denying them kills a shell before it can demonstrate anything (the same failure the module's header records for network-outbound and unix sockets). Deny-DEFAULT for that one rule family only. The header's reasoning for a deny-LIST posture holds for reads and everything else and is untouched, and a test asserts the egress-only profile every other caller uses is unchanged, and that absent is not the same as an empty allow-list.

src/codex/runner.ts is the session. planConfinedSession takes everything from the installation manifest, creates a disposable workspace under the system temp directory, and returns the room: writeAllow naming ONLY that workspace, denyRead over the vault, environment map and sealing keys, and an environment built from a literal ALLOW-list (CONFINED_ENV_ALLOW) applied after core/child-env.ts's credential strip. The allow-list is the interesting decision. child-env strips a named family (APPROVAL_, TELEGRAM_, VAULT_, AGENTMAIL_), which is right for approval run and not enough here: a Codex host carries OPENAI_API_KEY, GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY and an SSH_AUTH_SOCK, none of which is under a prefix this runtime knows, and a deny-list would have to keep up with every provider anyone adds. It is a control over NAMES and therefore best-effort by construction, which the docs say plainly; the load-bearing control beside it is that egress is denied, so a secret that does reach the child has nowhere to go. runConfined resolves the command BEFORE wrapping it and refuses command-unresolvable rather than spawning it unwrapped, because an unwrapped spawn is exactly the raw fallback this session must not have.

No opt-out and no raw fallback, and this is deliberately STRICTER than core/sandbox.ts's posture table: an unsupported host refuses sandbox-unsupported where approval run records unsupported and proceeds. A session advertised as confined and not confined is worse than no session. The two sandbox environment overrides still only tighten.

SPEC §11.1 invariants touched. Invariant 4 (self-reported fields never reduce scrutiny): nothing a caller supplies widens the room, the write allow-list and the environment allow-list are both literals computed here, and the force-unavailable override can only refuse. Invariant 3 (raw secrets never appear in the log): the session reports COUNTS of withheld variables and never a name, because a name is half of a credential. Invariants 1, 2, 5 and 8 are untouched: this module appends nothing to the log at all; the outcome events are the broker's.

No SPEC or schema amendment in this change.

Validation on this head, worktree, Node v26.8.2 on darwin. Build exit 0, typecheck exit 0, lint exit 0 with zero warnings. Conformance exit 0 with 300 vectors, 0 failures and 145 controls. Targeted sweep of codex-confine, sandbox, cli-long-help, cli-instructions, cli-help, codex-broker, cli-codex-apply, codex-doctor, codex-manifest, codex-project-config, mcp-server, layering, docs-guard, cli-run, child-env, execute and conformance: 298 tests, 298 pass, 0 fail, exit 0. Core regression of cli, gate, human-only, concurrency, state, audit, adapters-contract, cli-status, validate, log, cli-hook and cli-hook-scope: 462 tests, 462 pass, 0 fail, exit 0.

Every confinement case is a PAIR: the same script unconfined, where it MUST succeed, and confined, where it must fail. A suite asserting only the failure would pass with a profile that denies nothing, a path that does not exist, or a machine where nothing could have worked. Canonical workspace write, gate log and policy write, and credential read each carry their control leg. The loopback case compares ECONNREFUSED unconfined against EPERM confined, because a closed port fails either way and the two codes are what separate a denial from an absence. It uses no in-process listener on purpose: runConfined uses spawnSync, which blocks the test process event loop, so a server started there could never answer and its silence would prove nothing. A grandchild shell write is denied, which is the case that matters because a session spawns shells rather than calling into this runtime. Six distinct write APIs are attempted in one child and all six are denied, which asserts the kernel-level property rather than an API-by-API list.

Delivery: PR 413, branch lane/codex-confine-325-3, commits 7684b11 and c324b7e, stacked on APRV-325.2's PR 406 which merged at 2026-09-17T01:50:11Z as e9b6a817a2eea7ae36d9bfbf6be6e3f89c29e084. CI on run 35171566676 is fully green: node 22 shards 1, 2 and 3 all pass, protected paths (grant cross-check) passes, classify tier passes, ci passes. The merge is armed and the PR is in the merge queue. CI's green shard 3 is the ONLY verdict available for the packed-artifact case, which now runs setup, doctor --strict and start from a tarball installed outside any checkout against a scratch instance, with start refusing sandbox-unsupported on a host that has no mechanism. That case cannot run in this worktree, which has no node_modules.

CI also caught two of my own assertions going stale, fixed in c324b7e: codex-package still expected codex start to refuse codex-not-ready (it now validates the manifest before asking the host about a sandbox, so a bad manifest is a manifest error and never a confinement verdict), and three codex-confine cases read a prepared session and so looked pure, when preparing one needs a working mechanism and a host without one refuses by design. They stand down with the rest rather than asserting against a refusal they were not written for.

AC2 is NOT checked, and here is exactly why. Lane 3's allowRead read profile had not landed on origin/main when this was written, so the read-scoping leg is pending. Separately, the evidence here covers processes this runtime spawns and their descendants, on macOS: it demonstrates that write and patch APIs and grandchild shells are constrained inside the room, and it demonstrates nothing about a Codex desktop application, its browser tool, or another MCP server that a person starts OUTSIDE approval codex start. Those processes are not in the room. Managed configuration presence is not evidence and is not offered as any. What was measured about the desktop boundary is in docs/codex-boundary-probe.md, and the honest report belongs to the parent spike APRV-325.

Other limits stated rather than implied, in docs/codex-enforced-session.md: Linux has no mechanism in this build and refuses rather than running unconfined, inbound sockets are not denied, and the environment allow-list is a control over names and therefore best-effort, with egress denial as the load-bearing control beside it.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
A Codex session's shell now runs in a disposable workspace that is the only path it may write. The canonical workspace is readable and never writable, the gate's log, policy, vault and keys are neither, the environment is an allow-list rather than a filtered copy of the operator's, outbound network is denied with loopback, and descendants inherit all of it. There is no opt-out flag and no unwrapped fallback: a host with no sandbox mechanism refuses where approval run would record unsupported and proceed. Verified by 21 paired adversarial tests, each running the same script unconfined where it must succeed and confined where it must fail, including a loopback case that compares ECONNREFUSED against EPERM, a grandchild shell write, six write APIs at once, crash, timeout, replay, and the end-to-end case where only the broker's change reaches the canonical workspace; inside 298 passing targeted tests, a 462-test core regression sweep, 300 conformance vectors, and a fully green CI run whose packed-artifact shard is the only verdict available for the installed-package evidence. AC2 is deliberately unchecked: Lane 3's read profile had not landed, and this proves nothing about a desktop application started outside the room.
<!-- SECTION:FINAL_SUMMARY:END -->
