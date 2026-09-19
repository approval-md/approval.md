---
id: APRV-386
title: >-
  Reproducible demo provisioning: one script, three instances, idempotent, with
  reset and check
status: Done
assignee:
  - '@claude'
created_date: '2026-09-19 20:22'
updated_date: '2026-09-19 21:10'
labels:
  - demo
  - examples
  - runbook
dependencies: []
priority: medium
ordinal: 298000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The three stage demos (the web-agent demo, its crowd track, and the Grok Bot connector demo) are provisioned today by reading a runbook and pasting a command sequence by hand. That makes every rehearsal a fresh chance to skip a step, and it makes "reset between runs" mean "read the doc again". Carter wants each demo reproducible from a known state: one script per instance invocation, durable directories (never a temp folder), and a reset that puts an instance back where provisioning left it.

Outcome: a script under examples/ that provisions a demo instance idempotently from the steps the docs already publish, stops at every step a human must run (attest, the interactive credential verbs, tunnel creation) and prints the exact line for that step, continues from there on the next invocation, resets an instance between runs without ever truncating a log, and checks an instance with the doctor plus the demo own preflight. The instances: --instance web-agent targets ~/demo-gate, --instance guest targets ~/demo-guest, --instance grok-bot targets the path its runbook names.

Boundaries that are part of the deliverable rather than nice to have: the guest instance is a throwaway with an EMPTY vault and no mail adapter (the crowd-track MUST in examples/web-agent-demo/runbook.md section 4), so the script refuses to create a vault there at all; the script writes nothing outside the instance directory it was pointed at; every step it runs is one of the documented approval verbs, with no hand-written log lines and no direct edits of .approval/ contents; and the demo policy it writes is the one the provisioning doc publishes, kept as a file under examples/ so that a policy change shows up as a diff rather than as a paragraph somebody has to notice.

Sources: examples/web-agent-demo/provisioning.md (the six steps), examples/web-agent-demo/runbook.md (the instance table, section 4 crowd track, section 6 reset), examples/grok-bot-connector/runbook.md (sections 1, 5, 6), examples/email-demo.md and examples/telegram-demo.md (the same verbs in their older walkthrough form), and the demo tasks APRV-156, 168, 176, 246.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 One script under examples/ provisions a demo instance from the steps provisioning.md publishes, selected by --instance web-agent (~/demo-gate), --instance guest (~/demo-guest) and --instance grok-bot (the path its own runbook names), with the instance path overridable by a flag
- [x] #2 Every step the script runs is a documented approval verb; it hand-writes no log line, edits nothing inside .approval/ other than through those verbs, and writes no file outside the instance directory (pinned by a test that watches the surrounding filesystem)
- [x] #3 A second run against an existing instance is safe: nothing already written is overwritten, the run exits 0, and it reports what is already done and what is still pending
- [x] #4 The script stops at every human-only step (policy attest, setup identity, setup vault, setup channel telegram, the mail adapter verb, tunnel creation), prints the exact command line for it, and a later invocation picks up after the human has run it
- [x] #5 The guest instance never gets a vault or a mail adapter: the script refuses any vault or adapter step for --instance guest, names the crowd-track MUST as the reason, and leaves the instance without vault.enc
- [x] #6 --reset returns the instance log, queue and tasks to the post-provision state and keeps the vault; --reset --vault retires the vault too; no log is ever truncated or edited in place
- [x] #7 --check runs the instance doctor and the demo own preflight checks, prints one pass/fail line per check, and exits non-zero when any check fails
- [x] #8 The demo policy is a file under examples/ that the script writes verbatim, and a test pins it against the policy block examples/web-agent-demo/provisioning.md publishes so the two cannot drift
- [x] #9 Tests drive the script non-interactive steps against a scratch instance built through the real verbs: first provision, idempotent second run, reset with and without the vault, the guest refusal, and a failing --check. No real credential, and no instance under a home directory
- [x] #10 The three runbooks and provisioning.md reference the script instead of repeating the command sequence, keeping the prose that explains why, and examples/README.md gains a "Reproducing a demo" section listing the three instances, their script lines and the reset
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. ONE script, not three: examples/demo-provision.mjs, selected by --instance. The three demos differ only in data (the instance path, which steps a human must run, which preflight checks apply, what gets seeded); the idempotency, the stop-at-a-human-step and the reset logic are identical, and three copies of them would drift exactly the way the three runbooks drifted from each other. Node built-ins only, shelling out to dist/src/cli/main.js, in the style of examples/web-agent-demo/server.mjs (no import from src/).
2. examples/policies/demo-gate.APPROVAL.md holds the demo policy, byte-identical to the block provisioning.md publishes. All three instances share it: the crowd-track caps table in runbook.md section 4 quotes limits from that same policy, and the grok demo adds an adapter rather than a class. tests/demo-provision.test.ts pins the file against the block tests/demo-guest-limits.test.ts already extracts from provisioning.md, so the doc, the file and the runtime cannot drift apart.
3. Steps, each detected before it is run and each reported: mkdir -p; approval init --dir (itself idempotent, never overwrites); the demo policy (written only when init reported APPROVAL.md as written in this same run, i.e. provably the scaffold; an APPROVAL.md that exists and differs is KEPT and reported, because overwriting an attested policy would break every gate verb with hash-mismatch); approval policy check on the two classes provisioning.md names (read.files reversible, communicate.email.external irreversible) as the proof that the file parses; per-instance seeding of payload files and envelopes, hashed with the real approval payload hash read verb.
4. Human-only steps are detected from approval doctor --json rows (attestation, identity, telegram, vault, environment) and printed as the exact line to run, never executed: policy attest, setup identity, setup vault, setup channel telegram, the mail adapter verb, the git clone and the cloudflared tunnel. The script exits 0 with a PENDING section; the next invocation picks up after them.
5. Guest: the instance carries no vault and no mail adapter by construction. The script refuses --instance guest with any vault or adapter step (including --reset --vault as a request to create one), quotes the crowd-track MUST, and --check FAILS if .approval/vault.enc exists there.
6. --reset never truncates or edits a log. It MOVES .approval/log/, .approval/QUEUE.md, .approval/payloads/ and tasks/ into <instance>/retired/<UTC stamp>/, keeping relative paths, then re-provisions; the vault and .approval/env are simply not in that set, which is how the vault survives. --reset --vault adds .approval/vault.enc to the moved set. Everything stays inside the instance directory.
7. --check runs approval doctor in the instance (exit 0 and 0 failed) plus the demo preflight from its own runbook: the build is fresh, the policy is attested and matches the packaged file, the ports the runbook allows are free, seeded envelopes carry a payload_hash, and the guest vault is absent. One pass/fail line per check, non-zero exit on any failure.
8. A marker file <instance>/demo-instance.json records which demo the directory was provisioned for. An unmarked existing directory (Carter ~/demo-gate from 2026-08-30) is adopted rather than refused; a marker that disagrees with --instance refuses and names the two ways out (--path, or --reset).
9. tests/demo-provision.test.ts drives the real script against a scratch instance: first provision, idempotent second run, reset with and without the vault, the guest refusal, a failing --check, the policy-file pin, and a sweep proving nothing was written outside the instance directory.
10. Docs: provisioning.md, examples/web-agent-demo/runbook.md (sections 1, 4, 6), examples/grok-bot-connector/runbook.md (sections 1, 5) point at the script and keep the prose that explains why; new examples/README.md with a Reproducing a demo section (three instances, three script lines, the reset).
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What shipped

examples/demo-provision.mjs (Node built-ins only, shelling out to dist/src/cli/main.js exactly as examples/web-agent-demo/server.mjs does), examples/policies/demo-gate.APPROVAL.md, tests/demo-provision.test.ts (16 cases), and the doc edits that point the three runbooks at the script.

### One script, not three (AC1)

--instance takes web-agent, guest or grok-bot, with --path to override the directory. The three demos differ only in data: the path, which steps are human-only, which ports the demo may bind, what is seeded. The idempotency, the stop-at-a-human-step and the reset logic are identical, and three copies of them would drift the way the three runbooks already had. The instance table is one INSTANCES object at the top of the file.

--instance grok-bot targets ~/demo-gate, which is what its runbook names, and which is also the web-agent demo instance. That collision is handled rather than papered over: a demo-instance.json marker records which demo a directory was provisioned for; a run whose --instance disagrees with the marker refuses at exit 2 and names the two ways out (--path, or --reset); and a directory with no marker (Carters existing ~/demo-gate from 2026-08-30) is adopted rather than refused.

### Never overwriting anything (AC2, AC3)

- The demo policy is written over the scaffold ONLY when the same run scaffolded it (init --json reports it under "written"). An APPROVAL.md that was already there is somebodys attested policy and is KEPT with the reason printed: overwriting one refuses every gate verb with hash-mismatch until a human attests again.
- A seeded payload file that exists is left alone (the operator owns the bytes) and an existing envelope keeps its class, summary and key. What a rerun maintains is the binding: the payload_hash is re-read from the bytes through the real approval payload hash verb and rewritten in place if it moved, because an envelope whose hash does not match its payload is refused payload-mismatch at request time, on stage.
- The marker keeps its original provisioned_at, so even the one file the script owns is byte-identical on a rerun. The test captures every files bytes AND mtime and compares.
- Verbs run: approval init, approval payload hash, approval policy check (twice, on the two classes provisioning.md names), and approval doctor --json plus approval env --check --json for state detection. Nothing else. No log line is hand-written, nothing inside .approval/ is edited, and the test lists the parent directory before and after every run.

### Stopping at the human steps (AC4)

Detected from doctor rows and approval env --check (which prints no value on any path), never run: policy attest, setup identity, setup vault, setup channel telegram, the mail adapter verb, and the Grok demos clone of its throwaway repository. Each is printed as a fully-qualified line (a cd into the instance, then node and the absolute CLI path) so nothing depends on the shell function provisioning.md defines. The clone comes FIRST for the grok instance and the script scaffolds nothing until it is done, because the clone refuses a directory that already holds files. After a full provision the instance has no events.jsonl at all, which is the test for "nothing was attested and nothing was appended".

### The guest instance (AC5)

--instance guest has no vault and no adapter in its descriptor, so those two verbs are never printed; --reset --vault against it exits 2 quoting the MUST; a vault.enc that appears there anyway is a FAILED row in both --check and a provisioning run. The runbook MUST said "follow steps 1, 2 and 3 and stop there" and then named only two forbidden verbs; the script resolves that in the operational direction and still prints setup identity and setup channel telegram, which hold no credential of the instances own and are what put a guests request on the phone. The runbook now says so.

### Reset (AC6)

--reset MOVES the log directory, QUEUE.md, the payload store, the sealed-delivery keys and tasks/ into INSTANCE/retired/UTC-STAMP/, keeping relative paths, then provisions again behind them. Nothing is truncated and nothing is edited: this is the runbooks own "retire the instance rather than reaching into it" with the directory kept, and it stays inside the instance. The vault and .approval/env are simply not in the moved set, which is how a reset keeps the credentials; --vault adds vault.enc to it. The test asserts the retired events.jsonl is byte-identical to the one that was there.

### Check (AC7)

--check runs the instances approval doctor (green is 0 failed and exit 0) and adds what doctor cannot judge for a demo: the marker, the policy still being the packaged file, ports free, every seeded envelopes hash still matching its payload, the guest empty-vault invariant, and identity plus the Telegram channel resolving from .approval/env (doctor marks an unconfigured channel as a SKIP, which is a legitimate state for a gate and a dead demo for a room). One pass/fail line each, non-zero exit on any failure, and a test proves it writes nothing.

### The policy as a file (AC8)

examples/policies/demo-gate.APPROVAL.md is the heredoc body that was in provisioning.md section 2, extracted verbatim. All three instances are written from it: the crowd-track caps table in runbook.md section 4 quotes limits from that same policy, and the grok demo adds an adapter rather than a class. provisioning.md keeps the block and its paragraph-by-paragraph explanation; tests/demo-provision.test.ts pins the two against each other, and tests/demo-guest-limits.test.ts still extracts the block from provisioning.md and still passes.

## Verification

npm run build, npm run typecheck and npm run lint all clean. node scripts/run-tests.mjs --only demo-provision: 16 of 16 pass. Full npm test: 4809 tests, 4786 pass, 22 fail, all 22 the pre-existing local SMTP/TLS suites on Node v26 (adapter-email, smtp-probe, setup-adapter-email); CI on Node 22 is the truth. Manual runs went to scratch instances in the session scratchpad only: no home-directory instance was touched, no gate verb was run by this session, and no real credential exists anywhere in the change.

## Global invariants

This task touches none of the SPEC section 11 global invariants. It appends nothing, mints no verb, reads no record for an enforcement decision, and the one place it comes near the log is --reset, which moves a log directory whole and never opens the file.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
One script, examples/demo-provision.mjs, provisions all three stage demo instances idempotently from the steps provisioning.md publishes: --instance web-agent (~/demo-gate), guest (~/demo-guest) and grok-bot, with --path, --check and --reset [--vault]. It runs only documented verbs (init, payload hash, policy check, doctor, env --check), overwrites nothing that was already there, writes nothing outside the instance directory, and stops at every human-only step with the exact line to run. --reset retires the previous log whole into INSTANCE/retired/STAMP rather than truncating it, and keeps the vault. The guest instance is refused a vault at all, per the crowd-track MUST. The demo policy moved out of a heredoc into examples/policies/demo-gate.APPROVAL.md so a policy change is a diff, pinned against provisioning.md by a test. Verified by tests/demo-provision.test.ts (16 of 16, real verbs, scratch instances) plus a clean build, typecheck and lint; the three runbooks and a new examples/README.md now point at the script.
<!-- SECTION:FINAL_SUMMARY:END -->
