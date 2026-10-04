---
id: APRV-448
title: >-
  approval serve and the webhook listener stamp the daemon id, or the doc stops
  claiming they do
status: In Progress
assignee:
  - '@claude-c8'
created_date: '2026-10-03 03:49'
updated_date: '2026-10-04 13:15'
labels:
  - serve
  - daemon
  - identity
  - hosting
dependencies: []
references:
  - private/agentvillage-integration/06-gap-register.md
priority: medium
ordinal: 336000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
APRV-383 added the daemon field to records and the daemons allowlist to the policy, but only the Daemon constructor calls markDaemonProcess (src/daemon/daemon.ts), so records appended by approval serve (hook route, propose, start, withdraw) and by approval channel telegram webhook carry no daemon field and are not governed by the allowlist. src/cli/serve.ts says the id is the one every record written under this process will carry, which is false. In the Agent Village co-located deployment the facade, the daemon and the channel run in one approvald loop per tenant and most records are facade-written, so a tenant reading their own log sees daemon on the sweeps and nothing on the actions. Decide: either stamp the same instance id in serve and the webhook process (same source rules as APRV-383: APPROVAL_DAEMON_ID or the derived id; refusal on a bad declared id; allowlist enforced at the write boundary), or correct the doc and the serve startup line. Recommendation: stamp, because the field is provenance and the allowlist is the only thing that catches a facade started against the wrong store. Context: private/agentvillage-integration/06-gap-register.md G10.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Records appended through approval serve verbs and the hook route carry the daemon field with the same id approval status reports for that store, and a daemons list that excludes it refuses the append with daemon-not-allowed, both under test
- [x] #2 The Telegram webhook listener behaves the same way, under test with the fake Bot API
- [ ] #3 src/cli/serve.ts, docs/cli-reference.md and design/hosted-daemon-identity.md section 6 say exactly which processes stamp the field
- [ ] #4 If the decision is not to stamp, the doc and the serve startup line are corrected instead and the implementation notes say why
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Decouple the write-boundary stamp from the daemon mark (core/daemon-identity.ts): stamp whenever this process declared an identity.
2. core/daemon-host.ts: declareResolvedDaemonIdentity and refreshDaemonAllowlistFrom.
3. serve: resolve once with resolveDaemonId, declare on the listener thread and in every hook worker (workerData), refresh the allowlist inside the store lock before every verb and hook call.
4. webhook: resolve in prepareWebhook (refuse daemon-id-invalid), declare in runWebhook, refresh at startup and every dispatch cycle.
5. CLI JSON refusals carry error.append.
6. Tests (in-process serve, child-process webhook against the fake Bot API), docs, CHANGELOG.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Decision: STAMP (the task's recommendation, confirmed by the orchestrator).

What was done
- approval serve (verb calls on the listener thread, hook calls on worker threads) and approval channel telegram webhook stamp the daemon field with the id approval status reports for the store, resolved by resolveDaemonId (APPROVAL_DAEMON_ID or daemon-<instance id>). An unusable declared id refuses either verb before it binds (exit 2; the webhook preparation returns code daemon-id-invalid).
- The daemons allowlist is enforced at the write boundary for both: serve refreshes it from the verified log and the attested policy inside the store lock before every verb call and every hook call; the webhook at startup and at the top of every dispatch cycle (its tick). A failed resolution leaves the previous list standing (never widens).
- daemonStampForAppend is keyed on the identity DECLARATION (plus a pid check), not on core/daemon-actor.ts's mark. Serve and the webhook declare without marking: the mark routes an advance under log.advance.daemon (APRV-382) and must not be held by a process that dispatches agent-requested verbs. Every existing path behaves as before (only the Daemon declared, and it marks and declares together).
- Hook worker threads hold their own module state, so hookThreads(lock, writer, limits) takes a required writer passed as workerData; each thread declares the listener's single startup resolution. No request carries any part of the id.
- core/daemon-host.ts: declareResolvedDaemonIdentity, refreshDaemonAllowlistFrom; DaemonAllowlistRefusal gains log-unverified.
- cli/gate.ts and cli/execute.ts JSON refusals carry error.append (the write boundary's code) beside append-failed, following cli/gate-window.ts, so daemon-not-allowed is machine-readable over serve.
- ServeOptions.daemonId replaced by optional env (the launch environment the id is resolved from); ServeHandle.daemonId added.
- core/gate.ts not edited: the stamp lives in appendEvent, so gate appends in a declaring process are stamped (verified by tests).

SPEC §11.1 invariants touched, none weakened
- 1 (enforcement reads only verified records): the allowlist is resolved only from the attested policy against a verified read.
- 4 (self-reported fields never reduce scrutiny): the id is provenance that only ever refuses and gains nothing; the daemon advance mark is withheld from serve and the webhook.
- 5 (compare-and-append): the refusal is in appendEvent before the lock; compare-and-append unchanged.
- 6 (refusals machine-readable and distinct): error.append exposes daemon-not-allowed beside append-failed.
- 7 (no configuration from the working tree): the id comes only from the launch environment.

Not stamped (by design or follow-up): a standalone approval channel telegram listen; child processes spawned by serve's run/sandbox verbs; approval hook <harness> run as a harness's own process; approval run / adapter starts outside these processes.

Validation: build, typecheck, lint exit 0; targeted serve-daemon-stamp 8/8, telegram-webhook-daemon-stamp 4/4, daemon-identity 18/18, existing serve/webhook/actor/layering 148/148; full suite (npm test -- --baseline) exit 0, 5574 tests, 5573 pass, 1 skip, 0 fail, ci-baseline 0 failing.

AC3: src/cli/serve.ts and docs/cli-reference.md updated; design/hosted-daemon-identity.md is a protected path, so its section 6 correction is below for the human to apply. AC3 stays unchecked until it is.

design amendment text (apply by hand), design/hosted-daemon-identity.md, new 6.6:

**6.6 Which processes stamp the field (APRV-448).** Three processes declare an identity and stamp it: the daemon loop (`approval daemon run`, and `approval up`, whose Telegram listener shares the daemon's process), `approval serve` (its verb calls on the listener's thread and its hook calls on their worker threads, each of which declares the same startup resolution), and `approval channel telegram webhook`. All three resolve the id by section 3's rule through `resolveDaemonId`, so it is the id `approval status` reports for the store, and all three are held to the `daemons` list at the write boundary: the daemon refreshes it once per tick, serve before every verb and hook call inside its store lock, and the webhook at startup and at the top of every dispatch cycle. Only the daemon loop also marks itself the daemon (`core/daemon-actor.ts`), because that mark routes an advance under `log.advance.daemon`. The write boundary's stamp is keyed on the declaration alone, so serve and the webhook stamp and are restricted without holding that route. A session's own CLI calls, `approval hook <harness>` run as a harness's own process, and a standalone `approval channel telegram listen` declare nothing and write records without the field, which keeps 2.2's reading: absence says nothing about which process wrote a record.

Refuter (opus-high) outcome and fixes:
- MUST-FIX fixed: a hook worker spawned after an unattested policy edit started with no list and wrote task.registered under an excluded id. Each HookJob now carries the listener's in-force list; the worker starts each call from the stricter of that and its own (narrowerAllowlist) before refreshing, and the listener refreshes its own list before handing a hook call over. Test: serve-daemon-stamp "a hook thread spawned after the policy lost its attestation...".
- SHOULD-FIX 1 fixed: the worker refreshes the allowlist again in leaveWait, so appends after a hook's wait are judged against the list in force then.
- SHOULD-FIX 3 fixed: one process stamps one id (a second listener for a store with a different id is refused before it binds), and close() clears the declaration unless a daemon loop runs in the process or the declaration is no longer this listener's. Test added.
- Nit 3 fixed (stale test comment).
- Not fixed here, for follow-up: SHOULD-FIX 2 (resolveDaemonAllowlist loads and attests the policy in two reads, a pre-existing APRV-383 race; fix by a single read via checkAttestationOfBytes); SHOULD-FIX 4 (refresh cost inside the store lock: measure or cache on policy mtime/size); nit 1 (no startup warning when the list excludes the id); nit 2 (docs caveat: the derived id hashes the log path string, so a symlinked or differently spelled --log derives a different id). Human decision raised by the refuter: a process RESTARTED while the policy is unattested runs unrestricted (design 4.4); hosted facades restart often, so a fail-closed rule may be wanted.

Merged: PR #588 at head 9f1765b4, 2026-10-04 12:12Z. Follow-ups filed as APRV-468 (allowlist hardening: restart under drift, the two-read race in resolveDaemonAllowlist, refresh cost inside the store lock, nits 1 and 2) and APRV-469 (stamp a standalone channel telegram listen, approval run and adapter starts; error.append in token.ts and audit.ts). AC 3 waits on Carter attesting the 6.6 design amendment (text above, under design amendment text (apply by hand)); the task stays In Progress until then.

Design amendment opened as PR #596 (lane/aprv-448-design, head a32b5064): section 6.6 applied verbatim to design/hosted-daemon-identity.md, digest 8150238d6b441e81591facf462c8cc927e1f420edb095afbb5a38dbdcd493d95. Not armed; protected paths stay red until Carter attests it (the exact attest command is in the PR body and in CLAIMS.md, line "--- 2026-10-04 13:15Z (C8)"). AC 3 can be checked once #596 merges.
<!-- SECTION:NOTES:END -->
