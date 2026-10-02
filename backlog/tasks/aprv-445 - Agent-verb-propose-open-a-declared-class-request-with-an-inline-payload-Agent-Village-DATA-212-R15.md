---
id: APRV-445
title: >-
  Agent verb propose: open a declared-class request with an inline payload
  (Agent Village DATA-212 R15)
status: In Progress
assignee:
  - '@claude'
created_date: '2026-10-02 19:53'
updated_date: '2026-10-02 22:09'
labels: []
dependencies: []
references:
  - Agent Village DATA-212 approval half
  - rulings R15-R24
ordinal: 334000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Agent Village (Edge City, DATA-212 R15) needs a resident's agent, holding only the agent credential on approval serve, to open an approval request for an intention it captured: the text travels inline (serve refuses path flags for the agent), the class must be one the tenant's policy declares explicitly and marks agent-requestable, and the call must be retry-safe. Today the agent can only request an action that was registered from a host-side task file, which a sandboxed agent cannot produce. Same PR carries the hosting asks that ride with it: payload-store file modes and gitignore, a non-blocking wait, a unix-socket listen target for serve (DATA-233), Hermes classifier rows for the tools that have none (DATA-234), and a Hermes hook that blocks on every error path.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 propose --class --key --summary --payload-json [--json] is a verb in the registry, the CLI dispatch, and the serve agent verb list; --payload-json is a string flag carrying a JSON object, refused above a documented size with a named code
- [x] #2 propose registers and requests in one call; the task id is derived deterministically from the store, class and key; an identical retry returns the live request with idempotent:true and exit 0; the same key with a different payload while live refuses duplicate-request
- [x] #3 propose refuses class-not-agent-requestable unless the class is an exact key of policy.classes and that key or a declared prefix family of it sets agent_may_request: true; the flag is in the schema, PolicyClassRule, explain and diff
- [x] #4 an autonomous class registers the task and returns decision autonomous with the task id, writing no approval record
- [x] #5 payload store files are written 0600 inside a 0700 directory for every writer; approval init gitignores .approval/payloads/
- [x] #6 wait --timeout 0 returns the current state without sleeping
- [x] #7 approval serve accepts --listen unix:<path> / APPROVAL_SERVE_LISTEN=unix:<path>: socket 0666, stale socket replaced, refused when the directory is not owned by the serving uid
- [x] #8 the Hermes adapter classifies cronjob_manage, process_manage, browser_*, skill_manage, delegate_task, send_message and the HERMES_HOME script/env/approval paths per the DATA-234 table
- [x] #9 the Hermes hook emits the block directive and exits 2 on every error path
- [x] #10 SPEC.md, docs/cli-reference.md and CHANGELOG.md describe the verb, the flag and the listen target; npm test green
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Policy: agent_may_request (boolean, default false) on schema/policy.schema.json classRule (true forbidden on human-only, schema if/then like allow_irreversible) and PolicyClassRule; pure lookup agentRequestability(load, cls) in core/policy-match.ts: exact classes key required, the exact key's own flag wins when stated, else the longest declared family key <prefix>.* that states it, else false; explain gains agentMayRequest, policy diff reports the field.
2. Core: proposeAction() in core/gate.ts. Hash the inline payload (payloadHash, RFC 8785), derive task id propose:<sha256(JCS([actor, class, key]))[:32]>, check attestation + agent-requestability BEFORE register, register an in-memory envelope (origin app approval-propose), then request() with execution harness and agentProposal true so the same check re-runs inside request()'s retried write cycle. Idempotency: same registration + same hash returns the live/decided request without appending; differing hash refuses duplicate-request while live and payload-mismatch otherwise; withdrawn/expired re-file. New refusal code class-not-agent-requestable (+ payload-too-large at the CLI edge) in GATE_REFUSAL_CODES and SPEC §11.2.
3. CLI: commandPropose in cli/gate.ts (--class --key --summary --payload-json, 256 KiB cap on the UTF-8 bytes, JSON object only), REGISTRY entry, main.ts dispatch, help, instructions guide; serve AGENT_VERBS + AGENT_FLAGS.
4. A4 gap: no agent verb records execution.started for a non-hook action. Add agent verb start <task> --action <key> --payload-json: requester-only, presented bytes must hash to the registration; spends a harness grant (consumeHarnessGrant) when one exists, else records the policy-authorized start (startHarnessExecution, refuses manual).
5. Payload store: 0600 files, 0700 dir (all writers); init gitignores .approval/payloads/.
6. wait --timeout 0: one read, current state, no sleep.
7. serve --listen unix:<path> / APPROVAL_SERVE_LISTEN: 0666 socket, stale socket unlinked, dir must be owned by the serving uid.
8. Hermes classifier rows (tool rules on the adapter + .hermes path rows) and a top-level fail-closed wrapper (directive + exit 2 on every pre-event error path, including the signal exit and a throw before hook.ts loads).
9. Tests per brief; SPEC/docs/CHANGELOG; npm test before/after.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Progress 2026-10-02: core propose()/startProposed() in src/core/gate.ts; agentRequestability() in policy-match.ts; schema + PolicyClassRule + explain (agentRequest) + diff (agentRequest change) done; CLI propose/start, registry, dispatch, serve AGENT_VERBS/AGENT_FLAGS; wait --timeout 0; payload store 0600/0700 for every writer (writeAtomic); init gitignores .approval/payloads/ (reverses the tracked-by-default note, flagged for Carter); serve --listen unix:<path> + APPROVAL_SERVE_LISTEN; Hermes toolRules table + .hermes/scripts|approval|allowlist.lock path rows; hermesFailClosed wrapper + main.ts catch for a hook.js load failure.
Found while testing: (1) the hook's abandoned-question sweep (APRV-287) and findHarnessCarry select by actor + execution:harness, so under serve (one actor) every proposal pending past wait+grace would be withdrawn by the next gated tool call; proposals (task prefix propose:) are now excluded from both, with a test. (2) The hook wait loop is synchronous (Atomics.wait), so its SIGTERM/SIGINT handler cannot run mid-wait: the process keeps waiting and answers at timeout. Pre-existing; for Hermes the answer is still the block directive at exit 2.

Validation: npm test (tsc + run-tests.mjs) exit 0, 5398 tests, 5397 pass, 0 fail, 1 skipped (baseline at 6b74ca72: 5358 / 5357 / 0 / 1, exit 0). tsc --noEmit exit 0; npm run lint exit 0. New suites: tests/cli-propose.test.ts (15), tests/serve-propose.test.ts (5), tests/cli-hook-hermes-rules.test.ts (13); additions in policy-load, policy-match, policy-explain, payload-store, serve, cli-instructions, cli-policy, cli-init, gate. Conformance refusal-unions regenerated at 23.0.0 (gate union gained two codes). Mutation check: with the propose-task exclusion removed from the hook's abandoned sweep, the sweep test fails (the proposal is withdrawn).
Decisions for the human: (a) init now gitignores .approval/payloads/, reversing the documented tracked-by-default stance (brief ruling A5); (b) SPEC.md amendments are marked (Amended APRV-445, pending sign-off.); (c) a new agent verb start was added to close the A4 gap (no agent-credential path recorded execution.started for a non-hook action); (d) .hermes/.env stays account.credential (both human-only), not policy.core as the brief's table said.

Refutation round (2026-10-03). CORRECTION to the note above: '.hermes/.env stays account.credential (both human-only)' was false for writes. The credential tier is consulted for reads only, so write_file/patch/>>/sed -i/tee onto $HERMES_HOME/.env classified files.write.workspace and ran unattended. Writes to .hermes/.env, .env.*, auth.json are now policy.core; reads stay account.credential, now through read_file too. A Hermes terminal call's relative words and redirect targets are also judged against its workdir (L10).
B1: requestStanding() in core/gate.ts. wait reports expired (exit 3) for a grant whose window lapsed, and void (new EXIT_VOID = 7) for a grant or pending request pinned to a re-attested policy or withdrawn by the runtime for policy-drift. propose re-files in those cases; a drifted pending request is withdrawn first (reason superseded).
S1 task-is-proposal (plain request; task file in the propose: namespace). S2 proposals excluded from telegram supersededPending/orderPending stale bucket/collapse (collapsibleStale extracted). S3 cli.js bootstrap blocks hook hermes on missing dist or a throwing import. S4 key-class-mismatch. S5 only a pending or granted-unspent request binds start to the grant path.
L1 --withdraw-on-timeout with --timeout 0 refused. L2 stale socket unlinked only on ECONNREFUSED/ENOENT. L3 other-writable socket dir refused, 0666 only in an owner-only dir. L4 agentRequest.humanOnly, explain says refused: human-only. L5 a racing identical registration answers idempotently. L6 key ≤1024 B, summary ≤4096 B, lone surrogates and non-finite numbers exit 2. L7 state executed. L8 README-extended/doctor wording, and init re-run says it appended. L9 task-not-proposal. L11 documented.
Conformance refusal-unions 24.0.0.
Validation: npm test exit 0, 5418 tests, 5417 pass, 0 fail, 1 skipped; tsc --noEmit exit 0; npm run lint exit 0.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added the agent verbs propose and start, the policy key agent_may_request, wait --timeout 0 and the void standing (exit 7), owner-only payload store files, init gitignoring payloads, serve --listen unix:<path>, and Hermes classifier rows. Added a Hermes fail-closed path at three levels (adapter, main, cli.js). Writes to the Hermes home's secrets are now policy.core. Proposals are excluded from the hook's sweep and carry and from the Telegram stale collapse. Refutation findings B1, B2, S1-S5 and L1-L11 are addressed. Verified: npm test exit 0 (5418 tests), tsc and lint clean.
<!-- SECTION:FINAL_SUMMARY:END -->
