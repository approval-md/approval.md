---
id: APRV-445
title: >-
  Agent verb propose: open a declared-class request with an inline payload
  (Agent Village DATA-212 R15)
status: Done
assignee:
  - '@claude'
created_date: '2026-10-02 19:53'
updated_date: '2026-10-04 10:59'
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

Scoped recheck (2026-10-03).
B: requestStanding voids a GRANT only where the spend enforces policy-drift (declared execution harness, or a propose: task). A token grant spent by approval run stays granted, so wait && run keeps working. Pending requests are void for every task. Frozen exit-table text now reads 'void: a re-attest voided a pending request or a harness grant; ask again'.
SF1: withdraw({onlyIfVoid}) re-checks void inside its attempt. request({agentProposal}) refuses already-decided over a usable grant or a human refusal. propose restarts from a fresh read, up to 4 attempts, when either append refuses. Tested with an 8-way race (1 withdrawal, 1 re-ask) and the clobber sequence.
SF2: the Hermes terminal resolver tracks cd, expands HERMES_HOME (APPROVAL_HERMES_HOME, else HERMES_HOME, from the hook env; unexpanded is conservative), counts heredoc targets, maps globs and unresolvable targets under .hermes/.approval to policy.core, realpaths deepest ancestors, and makes directory reads under .hermes/.approval account.credential (read tools too). Residuals are documented in docs/hermes-hook.md.
SF3: exit 7 named in instructions, root help and the backlog-md example.
L-a: wait answers executed for a policy-path start; propose is never idempotent after it appended a withdrawal. L-b: key id must be printable, with no whitespace or control characters. L-c: register refuses the propose: namespace for every caller except propose, the muse route included. L-d: cli.js strips --no-color before matching, and its exit guard turns any non-0/2 Hermes exit into 2 plus the directive. L-e: only redirect targets and write positions resolve. L-f: kept and documented (synchronous wait vs SIGTERM).
HOSTED FOLLOW-UP (not this lane): approval-md-hosted hermes-image write-hooks.py GATED_TOOLS lacks cronjob_manage, process(_manage), browser_*, skill_manage, send_message and delegate_task, so those calls never reach the hook and the new classifier rows are inert there until the matchers are added.
Validation: npm test exit 0, 5427 tests, 5426 pass, 0 fail, 1 skipped; tsc --noEmit exit 0; npm run lint exit 0.

Recheck 3 (2026-10-03). SF1: the organ rules are scoped to the gate's own directories (gateRootKind: home root, profile home, approval home, a home's approval/, scripts/). A recursive read or read tool is credential only for those roots or for a directory under a home that directly holds a credential file (holdsCredentials). A glob or unknown-variable write is policy.core only into those directories, or when a pattern could name the home or an organ. workspace/, skills/ and similar are ordinary, which fits the hosted HERMES_HOME=/data/.hermes. SF2: after an unresolvable cd (cd $X, cd "$D", cd -, an unknown $HERMES_HOME), later relative writes are policy.core and later relative reads account.credential. SF3: globs over .hermes/.approval/organ names, globbed reads (expanded when the directory exists), and < reads. Lows: copies into a directory (-t, --target-directory=, trailing /, existing dir) write <dir>/<name>; tar -x and unzip write into -C/-d or the cwd; profile homes .hermes/profiles/<p>/ carry the home's organs; registry code 7 wording; new refusal 'contended' (exit 1) when propose exhausts its restarts; APPROVAL_HERMES_HOME documented as trusted as given. Conformance refusal-unions 25.0.0. Validation: npm test exit 0, 5429 tests, 5428 pass, 0 fail, 1 skipped; tsc exit 0; lint exit 0.

Merge 2026-10-02: origin/main 89b8fe54 merged at 4db5f5f6 (conflicts in execute/help/hook/instructions/verb-registry/server resolved keeping both; hermesFailClosed now passes the APRV-427 wait seam). Resume point: run the full npm test in the worktree, then push carter/data-212-propose and watch gh pr checks 569.

Post-merge validation: npm test exit 0, 5461 tests, 5460 pass, 0 fail, 1 skipped; tsc --noEmit exit 0; npm run lint exit 0. Refusal unions unchanged by the merge (origin touched no conformance vectors), so no regeneration. Resume point: push carter/data-212-propose and watch gh pr checks 569 to a verdict; the orchestrator arms the merge.

CI run 37099665754 (first CI verdict this branch ever had): shard 1 red on two branch tests, both Linux-only. (1) cli-propose oversized payload: spawnSync E2BIG, Linux caps one argv string at 128 KiB, so the 256 KiB and at-limit cases now run through main() in process (serve's path). Product consequence for the human: approval propose --payload-json from a Linux shell tops out near 128 KiB; the 256 KiB cap is reachable only through serve. (2) propose-refutation B1 lapsed grant: a 3 s window was eaten by slow CI spawns; now 8 s, lapse waited from when propose returned. protected-paths check red on the branch's own SPEC.md commits (c81817f0, 6958f02b, 4c5c050c, dae522bc: no-evidence), expected while the SPEC hunks await sign-off. Resume point: push the fix and watch gh pr checks 569 again.

Merge 2026-10-04: origin/main 7f2fd996 (#570 attest --bootstrap, #571 AV policy fixture and hermes-hook doc, #572 refused tap, #573 fsync, #577 edgeos relay channel) merged onto fe10ffd4. Conflicts: CHANGELOG.md Unreleased (both entry sets kept, APRV-445 first, then main's APRV-455/440/442/446/449); conformance refusal-unions and manifest (main's 26.0.0 taken, then regenerated: the merged suite is 27.0.0 under conformance/README.md's collision rule, carrying the six APRV-445 gate codes and APRV-455's relay_refusal_codes; the regen script's history comment keeps both sides and adds 27.0.0); scripts/regen-conformance-vectors.mjs (that comment). Auto-merged: docs/cli-reference.md, docs/hermes-hook.md (three 'once #569 lands' phrases updated by hand), verb-registry, help, main. SPEC.md byte-identical to fe10ffd4 (Carter's 2026-10-03 sign-off, sha256 bb092166..., carried by records-log-2026-10-04 f2e60c20). The worktree's uncommitted events.jsonl line (that sign-off appended to this worktree's stale log copy) stays out of the commit: log lines never ride feature branches. Validation: npm run build exit 0, tsc --noEmit exit 0, lint exit 0, targeted 313/313, npm test exit 0 (5538 tests, 5537 pass, 0 fail, 1 skipped). Resume point: push carter/data-212-propose, watch gh pr checks 569, refute the merge diff, arm the merge.

Security pass 2026-10-04 (orchestrator-requested after a background review flagged gate.ts): one real bypass, fixed. startProposed's policy path (startHarnessExecution) refused only manual and human-only and never re-ran the supervised-live draw, so a selected live proposal that a human rejected, or that the agent withdrew or let expire, started with authorization: policy and no grant (reproduced with a PoC). Fix: proposalPolicyStartRefusal in src/core/gate.ts, run inside attemptHarnessStart for propose: tasks (task id decides, not a caller flag), before the budget write: refuses not-granted for a pending/granted request (re-check inside the append), a rejection/revocation under the attested policy (or one that pinned none), and a supervised-live class whose deterministic draw selects the bytes. No SPEC change. Tests: three S5-live tests in tests/propose-refutation.test.ts. Also: agent-village-policy test asserts the #569 key and verb are present (no silent fallback); conformance/README records 27.0.0 superseding 23-26. npm test exit 0 (5542, 5541 pass, 0 fail, 1 skipped). Open: protected paths (grant cross-check) red because records-log-2026-10-04 carries no gate.path.signed_off for SPEC.md sha256 bb092166...; the only such record is seq 72713 in this worktree's own stale log copy (uncommitted). Follow-ups to file: proposal payload store has no fsync (payload-store.ts writeAtomic) while the log does since APRV-440. Resume point: the SPEC sign-off must reach the primary's log and a records branch; then re-run the protected-paths job, merge-arm #569.

Resume point (2026-10-04, C1 lane stopped, #569 NOT armed): head fc3fcfa8 plus this note's commit. Carter: approval policy attest --path SPEC.md --dir /Users/carter/dev/approval-md-wt/data-212-propose --log /Users/carter/dev/approval-md/.approval/log --as human:carter (must hash to bb09216600026185f0f6380c9ca556bd35fbba5fea1c36a07e294766681550f4), then approval log advance --pr from the primary, then gh pr merge 569 --merge. The stray uncommitted seq 72713 sign-off in this worktree's .approval/log/events.jsonl was appended to a stale copy of the log and forks it; it must never be committed.

Done 2026-10-04: PR #569 merged at 10:56:58Z from head a4dd89e5 (merge commit af3e591a on main). The SPEC.md hunks were signed off by Carter as gate.path.signed_off at seq 81682, digest bb09216600026185f0f6380c9ca556bd35fbba5fea1c36a07e294766681550f4 (carried by records PR #584), so the (Amended APRV-445, pending sign-off.) markers in the merged SPEC bytes are now signed-off text. The stray seq 72713 copy in the data-212-propose worktree's stale log was never committed.
Open rulings: the three items the PR body left for Carter shipped as merged, and the notes record no separate ruling on any of them. (1) exit 7 `void` is in the exit table. (2) credentialReadGate breadth: .approval/env.example and Glob on .approval/keys read as credential reads. (3) APPROVAL_HERMES_HOME must be set on the serve process. Decisions (a) through (d) from the 2026-10-02 note stand as built: init gitignores payloads, the SPEC amendments are signed off, the start verb exists, and .hermes/.env writes are policy.core.
Fixes after review: fc3fcfa8 closed the security-pass bypass. start's policy path turned a rejected, withdrawn or expired request for a selected supervised-live proposal into a policy-authorized execution.started; proposalPolicyStartRefusal now refuses it. a4dd89e5 closed a signal-guard fail-open: the Hermes hook handled SIGTERM/SIGINT only from the start of its wait, so an earlier signal killed it with empty stdout. hermesFailClosed now guards the whole CLI run, and the wait's handler is prepended. The same commit fixed the L-d test race that ejected the first queue run (37192542666). The remaining window, a signal during module load before the runtime runs, is APRV-466.
Conformance: refusal-unions is at 27.0.0 (main's 26.0.0 relay union plus this task's six gate codes, under the collision rule; conformance/README records it).
Validation at a4dd89e5: npm test exit 0 (5559 tests, 5558 pass, 0 fail, 1 skipped); typecheck, lint and build exit 0; propose-recheck plus cli-hook-hermes-rules 20/20 green in a row; PR CI green, protected paths included.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
This task added:
- the agent verbs propose and start, and the policy key agent_may_request;
- wait --timeout 0 and the void standing (exit 7);
- owner-only payload store files, with init gitignoring .approval/payloads/;
- serve --listen unix:<path>;
- Hermes classifier rows, with writes to the Hermes home's secrets classified policy.core;
- a Hermes fail-closed path at every level: adapter, main, cli.js, and a signal guard over the whole CLI run.

Proposals are excluded from the hook's sweep and carry, and from the Telegram stale collapse. Refutation findings B1, B2, S1-S5 and L1-L11 are addressed, as is the security-pass bypass on start's policy path (fc3fcfa8). SPEC hunks are signed off (seq 81682, bb092166...), and the refusal-unions vectors are at 27.0.0.

Merged as PR #569 at a4dd89e5 on 2026-10-04. Verified: npm test exit 0 (5559 tests, 0 fail), tsc and lint clean, PR CI green.
<!-- SECTION:FINAL_SUMMARY:END -->
