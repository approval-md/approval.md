---
id: APRV-325.3
title: Confine Codex shell work and prove end-to-end gate enforcement
status: In Progress
assignee:
  - '@opus-lane-codex-broker'
created_date: '2026-09-09 07:39'
updated_date: '2026-09-17 01:28'
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
- [ ] #1 Shell receives no canonical workspace or gate write authority, ambient credentials, external egress or mutable executor code; no opt-out or raw fallback exists.
- [ ] #2 Native write/patch tools and all alternate mutable app/browser/MCP capabilities are demonstrably constrained; managed configuration presence alone is insufficient evidence.
- [ ] #3 Denied or missing authority, crashes, disconnects, timeouts and replay cannot produce unauthorized canonical effects; one approved bound change produces exactly its permitted effect and a verifiable outcome.
- [ ] #4 Installed-package setup/start/doctor and activation/rollback instructions are tested on supported configurations, and unsupported hosts refuse rather than silently weakening enforcement.
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
