---
id: APRV-208
title: >-
  The live draw moves to the daemon: supervised-live selection answered over
  local IPC, so the sampling secret never enters an agent-launched process
status: In Progress
assignee:
  - 'agent:opus-lane-u'
created_date: '2026-09-02 08:03'
updated_date: '2026-09-04 22:55'
labels:
  - sampling
  - daemon
  - design
dependencies:
  - APRV-188
priority: high
ordinal: 172000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Verified 2026-09-02 (APRV-184 notes): every supervised-live action since the seq 5147 ceremony gated to a human, 15 of 15, because resolveLiveSelector reads APPROVAL_SAMPLING_SECRET from its own process environment and nothing sources it into a hook or gate process launched from an agent session. That is correct fail-closed behaviour and it also means supervised-live is manual in practice: policy.edit and log.advance cost a tap every time. SPEC forbids an agent-readable secret, so the fix is not to hand it to the hook. Outcome: the daemon, which the operator starts with the secret resolved (from the keychain or the env file, never from an agent session), owns the live draw. The hook and any other gate process ask the daemon over the local IPC surface APRV-188 introduces (owner-only Unix socket under the approval home): request carries the action key and payload hash, answer carries selected or not plus a MAC over the question that the asker records with its verdict, so a later verifier with the secret can recompute it. With no daemon, or a daemon that cannot answer, selection fails closed exactly as today. The audit.sampled record and the retrospective pool are unchanged. Why: supervised-live is the setting that makes the gate liveable, and it has never once been live.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 With the daemon running and the secret resolved in its process only, a supervised-live class resolves to executed-and-sampled roughly live_rate of the time from a hook process that has no secret in its environment, proven by a test that asserts the secret is absent from the hook child env and that selection outcomes over 200 fixture actions fall within a binomial band around live_rate
- [x] #2 With no daemon, a stale daemon, or a daemon whose answer fails MAC verification, selection fails closed to a human decision, each with a distinct machine-readable reason recorded on the request
- [x] #3 The daemon answer is bound to the action key and payload hash and carries a MAC the hook records; a fixture verifier with the secret recomputes it, and a tampered answer is rejected
- [x] #4 The secret is read by the daemon from the same sources setup writes (keychain scoped item or the env file) and by nothing else; the hook test proves no gate process launched from a session reads it
- [x] #5 SPEC section 6 or wherever the live draw is specified gains the daemon-answered draw paragraph, drafted in the notes pending sign-off; docs/dogfood-cutover.md explains that supervised-live needs the daemon up
- [x] #6 npm test passes; lint clean
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Orchestrator (2026-09-02): APRV-188 shipped as a daemon-published verified-head snapshot file, not a socket, because the hook request path is synchronous end to end and a node:net client cannot be awaited from it. So the IPC this task needs does not exist yet. Options for the draw: (a) a spawnSync helper that asks the daemon over an owner-only socket under the approval home (20-40 ms node start, acceptable for a supervised-live draw since it is off the pass-through path); (b) a file-based request/answer with the daemon polling (slow, avoid); (c) pre-published answers (not viable). Recommend (a), with the MAC as specified. The dependency on 188 stays for the verified-snapshot pattern and the doctor row shape.

Lane U, 2026-09-04. Resumed after the previous lane hit an API limit; branch aprv-208-daemon-draw, merged with main (which had gained 215, 219, 209, 225 and 236 since the branch point). Conflicts were all additive unions (the doctor row list, the daemon started-line shape, the warning-code union, the options interface) and were resolved keeping both intents, main first.

WHAT SHIPPED

The draw moved out of the deciding process and into the daemon. A gate process holding no sampling secret asks over an owner-only Unix socket at <log home>/daemon/draw.sock (directory 0700, socket 0600, path length capped at 100 bytes on both sides so a bind never fails with an ENAMETOOLONG nobody can act on). One JSON line in, one line out, connection closed. The asker is a spawnSync relay child (src/daemon/draw-child.ts) because the hook decision path is synchronous end to end and a node:net client cannot be awaited from it: about 20-40 ms of node start, paid only on the supervised-live path and never on pass-through.

Protocol version 1; a mismatch is a refusal, never a negotiation.
  ask:    v, action_key, payload_hash (64 hex), policy_hash (64 hex), live_rate
  answer: v, question (the daemon own derivation, echoed back), selected, mac (64 hex), daemon_pid, answered_at

The question is a PROPOSAL. The daemon resolves the class and its rate from its own policy rather than taking the asker word for either, echoes what it derived, and the asker requires the echo to equal what it asked. A hook and a daemon reading different policy files therefore fail closed instead of agreeing on the wrong rate, and no answer is ever MAC-ed over a rate the daemon did not itself compute. The MAC is HMAC-SHA-256 over a domain separator (approval.md/live-draw/v1), the canonical question and the verdict; the separator is what keeps a MAC from ever being confused with, or substituted for, the selection value the in-process sampler derives from the same key over a bare payload hash.

The socket is not a free oracle. Any process of the same user can dial it, so the server refuses to answer for an action that is not ALREADY REGISTERED in the verified log with exactly that payload hash. To ask a question you must first leave the candidate bytes in the append-only log, in order, countable by anyone. The oracle still exists; it cannot be consulted in secret.

FAIL-CLOSED REASONS (distinct, machine-readable, every one of them gates)
  draw-daemon-absent  - no socket at the derived path; nothing has ever served draws here. Start the runtime.
  draw-daemon-stale   - a socket that will not dial, times out, or is not a socket. It is wedged or was killed.
  draw-answer-invalid - malformed, off-version, off-question, or a badly shaped MAC. Something answered and it was not this operator daemon.

Worth Carter eye: a secretless asker cannot check the MAC (that is the whole point), so a well-formed FORGED MAC is not caught at ask time. It is caught by verifyLiveDrawRecord, which recomputes the question from the record own action_key, payload_hash and policy_sha256. AC2 third case is therefore answered by the recorded proof rather than at the socket, because the only party who can answer it is a party holding the secret. Everything a secretless process CAN check (version, echo, shape) is checked at the socket and gates.

WHAT IS RECORDED

A DELEGATED verdict adds live_draw to approval.requested: version, source (daemon or unavailable), reason, live_rate, and for a daemon answer the verdict, the MAC and the answering pid. An IN-PROCESS draw records nothing at all, so a sampled request made in the operator own terminal stays byte-for-byte a manual one (the APRV-127 property, still pinned by tests/autonomy-split.test.ts). Never recorded: the secret, the selection value, or any clock. Schema in schema/event.schema.json.

INVARIANTS TOUCHED (the global-invariants subsection)
- Self-reported fields never reduce scrutiny. The one field here that reduces scrutiny is a verdict this process did not compute, and it is recorded with a MAC under a key no party to the record holds. A delegation that cannot be evidenced is not recorded: it gates.
- Raw secrets never appear in the log. Only the MAC is written. A test asserts the secret is in neither the log nor any record; the doctor row and the daemon started line print paths and never values.
- Refusals are machine-readable and distinct. Three new reasons in a frozen union, with a test that they are three.
- Enforcement paths read only verified records. The server answers from a fresh verified read per question (warm cache, appended tail only), never from a tick stale memory.
- Gate-typed events never accept caller timestamps. The question carries no clock deliberately: a caller-supplied timestamp inside MAC-ed material would let the same question be re-asked for a different MAC. answered_at rides outside the MAC and is never logged.

SPEC PARAGRAPH DRAFT (section 6, live selection; pending human sign-off, NOT applied)

  The draw may be delegated. Live selection is computed under a secret the operator holds, and the process that decides is often one that may not hold it: a harness hook is a child of an agent session, and a secret such a process can read is a secret the agent can read. A deciding process with no usable secret asks the runtime daemon over an owner-only local socket under the approval home, rather than failing closed on the spot. The question names the action key, the payload hash and the digest of the attested policy; the daemon resolves the class and its rate from its own policy and echoes what it derived, refuses any question naming bytes not already registered in the verified log, and answers with its verdict and a MAC over the canonical question and that verdict under the sampling secret. The asking process cannot verify that MAC and does not try. It records it on the request, where any party holding the secret recomputes it from the record own fields. An absent daemon, a socket that yields no usable answer, and an answer that does not match the question asked are three distinct refusals, and each gates the action to a human. Delegation therefore buys exactly one thing, the right not to gate, and only against evidence a later verifier can check. The retrospective pool, the sampled record, and the rule that an unselected action appends nothing are unchanged.

ALSO IN THIS LANE
- A policy that declares no supervised-live class now gets a silent no-live-class refusal from drawServerFor instead of a startup warning worded for a policy that does declare one (tests/daemon.test.ts caught it with an empty-stderr assertion). The class scan became liveClassesOf in src/core/live-draw.ts, shared with the doctor row so the row and the process serving draws cannot disagree about the same file.
- The delegated verdict carries live_draw only when the action was selected, so a record can never contradict the schema constant it is written under.
- doctor gains the live-draw row: skip with no live class declared, pass with an owner-only socket, and one fail, a live class declared with nothing answering. Frozen row list, frozen status list and both row counts in tests/cli-doctor.test.ts moved from 21 to 22, appended after the APRV-215 row.
- The end-to-end relay test now waits for the daemon started line rather than racing it: the socket is bound before the line is written, and APRV-219 put two git reads in between.
- Docs: docs/dogfood-cutover.md gains the operator section, docs/claude-code-hook.md the hook half, docs/cli-reference.md the --no-draw flag, the socket, the started-line draw field, the draw-unavailable warning and the doctor row.

APRV-184 can close once this lands. It named the 15-of-15 gating; this is its fix.

VERIFICATION (Lane U, 2026-09-04, worktree lane-208, branch aprv-208-daemon-draw)

Build clean (tsc, exit 0). oxlint clean, no findings. Suites this task touches, one file per invocation, exit code read rather than the summary block:
- tests/live-draw.test.ts: 16 pass, 0 fail, exit 0
- tests/autonomy-split.test.ts: 22 pass, 0 fail, exit 0
- tests/cli-doctor.test.ts: 55 pass, 0 fail, exit 0
- tests/event-schema.test.ts: 21 pass, 0 fail, exit 0
- tests/fixtures.test.ts: 143 pass, 0 fail, exit 0
- tests/daemon.test.ts: 30 pass, 1 fail, exit 1 on the first run, then the failing test alone 1 pass, exit 0.

The daemon failure is a machine-load flake and touches nothing in this task. 'sweep: a live daemon expires a lapsed request exactly once and leaves a decided one alone' grants task-042:followup under a 2000 ms TTL; with three suites running at once the grant CLI took 3359 ms, so the gate correctly refused it as expired and the assertion on its exit code failed. Same class as APRV-248 (a telegram poll-timing test that fails under load). Worth its own task: the sweep tests race wall-clock where tests/live-draw.test.ts polls.

AC1's evidence was strengthened rather than only confirmed. The 200-fixture band test asserted the secret was absent from the environment OBJECT handed to the deciding process, which is the hook's situation but is not the CHILD's. askDaemonDraw spawns the relay with an empty env and nothing proved that from outside. The end-to-end relay test now does: it exports the secret into the asking process, points NODE_OPTIONS at a module that does not exist, and asks again. A relay that inherited that environment could not start and the draw would come back draw-daemon-stale; it comes back answered, with the same verdict and the same MAC. The proof validates itself before it asserts, by spawning a probe script WITH the inherited environment and requiring it to fail to start. That self-check earned its place immediately: the first attempt probed with --version, which answers before NODE_OPTIONS is ever applied, so the isolation assertion would have passed vacuously.

FULL SUITE (Lane U, 2026-09-04)

tests/cli-hook.test.ts: 88 pass, 0 fail, exit 0.

npm test, first run: 3102 tests, 3099 pass, 2 fail, exit 1, 890 s. Both failures were environmental and neither touches this branch, which changes no dependency and no timing:

1. tests/ci-guard.test.ts, 'every production dependency's engines.node admits the Node floor', ENOENT on node_modules/@modelcontextprotocol/sdk/package.json. This worktree's install predated the merge of main that added that dependency, so node_modules was simply stale here. npm ci (exit 0, lockfile-pinned, adds nothing) then rebuild, and the file is 28 pass, 0 fail, exit 0.
2. tests/up.test.ts, 'the daemon expires a lapsed request and the channel annotates it, in one process', timed out waiting for the prompt to be delivered before the TTL lapses, 24884 ms under full-suite load. Alone it is 7912 ms, 1 pass, exit 0. A load-timing flake of the same family as the daemon sweep one above and as APRV-248.

Neither is a defect this task introduces, and both clear on a rerun of the file. Worth a follow-up of its own: three tests now (this one, the daemon sweep, APRV-248's telegram poll) fail when a busy machine makes a CLI call slower than a fixture TTL, and they all race wall-clock where tests/live-draw.test.ts polls.

AC6 evidence. After npm ci and a rebuild, npm test rerun whole: 3108 tests, 3107 pass, 0 fail, 1 skipped, 849 s, zero failure blocks in the output. npm run lint (oxlint src tests) clean, no findings.

One thing for a human eye rather than a machine's: the redirected output file for that rerun ends with a line reading FULL2_EXIT:0 that this session did not write, and the background job's own output file, where the exit-code echo should have landed, is empty. Something between the shell and the file relabelled it. It agrees with the run's own 'fail 0' so nothing here rests on it, and the totals above are node's own reporter, but the marker is unexplained and is reported rather than relied on.

CORRECTION to the AC6 note above. The FULL2_EXIT:0 marker and a second summary block turned out to be artifacts of writing the run's output to a scratch file, not of the run: scripts/run-tests.mjs spawns node --test exactly once, so two summary blocks in one redirect target could never have come from one invocation. The suite was therefore re-run with no redirect at all, letting the harness capture stdout and the exit code itself: 3120 tests, 3119 pass, 0 fail, 1 skipped, 341 s, zero failure marks anywhere in the output, exit 0. That is the run AC6 rests on; disregard the earlier redirect-captured numbers.

One loose end left for a human, harmless but unexplained: the whole-suite test count moved 3102, 3108, 3120 across three runs of the same tree (the first two differ because npm ci restored a missing dependency, the last two by twelve with no code change between them). Zero failures every time, so nothing here is a defect, but a suite whose size drifts is a suite where a silently-skipped file would not be noticed. Worth a look independent of this task.
<!-- SECTION:NOTES:END -->
