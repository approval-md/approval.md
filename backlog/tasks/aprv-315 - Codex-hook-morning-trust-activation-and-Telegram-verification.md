---
id: APRV-315
title: Codex hook morning trust activation and Telegram verification
status: In Progress
assignee:
  - '@opus-lane-codex-native'
created_date: '2026-09-08 07:25'
updated_date: '2026-09-17 00:58'
labels: []
dependencies:
  - APRV-314
priority: high
type: task
ordinal: 233000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
User-authorized overnight Codex integration. SPEC 6.3,7,9,10,11.1 bind. Isolated code/tests/delivery now; everyday activation and human decisions only in morning. No deployment, credentials, dependencies or production policy/log mutation.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Carter reviews/trusts intended Codex hooks with rollback available.
- [ ] #2 Closed-gate Telegram rejection prevents harmless effect, approval permits it once.
- [ ] #3 Outcome log verifies and desktop coverage is observed; configuration alone is not completion.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Agent half only; every acceptance criterion is a human step. 1. Read the adapter and the reviewed native evidence, then write docs/codex-activation.md: the hook file Codex trusts, the human-only trust tap, what trust does and does not buy on the installed Codex version, the tested rollback, and the reject-then-approve Telegram pair as a numbered runbook with window, full command, expected visible result and the two log seqs to record. 2. Mark the fail-open surfaces at the top, since the standing rule is that no known fail-open hook is activated.

Step 3. Choose a ceremony reachable on the installed version: native Bash is refused, so the only gated surface is a direct apply_patch, and the only manual class it reaches is policy.edit.ci through the primary protected_paths list, with the effect landing in a scratch directory.

Step 4. Rehearse the rollback and pin it as a regression test, since an agent cannot create a dot-codex path by hand. Step 5. Leave the task In Progress and name the exact runbook section Carter follows.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Resumed native probes establish a new activation blocker on Codex CLI 0.152.1: Bash hides effective per-call workdir, so the safe adapter must refuse every matched shell pre-event, including shell-dispatched patches. Direct apply_patch is the bounded experimental candidate; post outcomes remain diagnostic and native crashes/timeouts/malformed output fail open. Do not treat the morning phone test or hook trust as sufficient to enable normal Codex use. Revisit activation only after a verified effective-execution-directory contract or an explicitly agreed narrower workflow. No everyday installation/trust/configuration was performed.

Carter explicitly asked to prove phone delivery and verifiable Codex enforcement after the audit found no installed approval.md Codex hook and pending requests 30107–30109 with no transport witness. Telegram delivery is currently unknown; do not treat log intake as a sent message. Existing native activation criteria remain unchecked.

2026-09-09 read-only runtime diagnosis: no approval launchd service is loaded. A manually attached Node process PID 38697 owns the primary draw socket and an established TLS connection consistent with Telegram polling, but the sanitized daemon query returns draw-daemon-stale. Its checkout is 78baf522, behind reviewed main d42cd34. Requests 30107-30109 remain pending without delivery or callback evidence. Do not launch a second poller. Next live operation is a controlled replacement of the existing foreground runtime using a current reviewed build and primary policy/log, followed by phone confirmation. Preserve dirty primary release work; no process was stopped or started during diagnosis.

Lane 4b (2026-09-16), agent half delivered. The doc Carter follows is docs/codex-activation.md, top to bottom. AC1 is section 1 (Install the hook file, scratch only) plus section 2 (The trust tap, human only) and section 6 (Roll back). AC2 is sections 3, 4 and 5: prepare the ceremony, the rejection, the approval. AC3 is the closing section, What to write back into APRV-315. Every acceptance criterion remains a human step and none is checked here.

Installed Codex CLI observed read-only this session: @openai/codex 0.152.1, the version APRV-310 probed, so no blocker has lifted. Two facts shape the whole runbook and are stated in its first section. The command hook fails open: in the reviewed native runs a crashed, timed-out or malformed hook produced a visible hook failure and the scratch effect still landed, and Codex has no setting that makes a failed command hook deny. And native Bash is refused on every event with hook-unsupported-execution-context, because 0.152.1 honours a per-call shell working directory that appears in no field of the event. The runbook therefore says in as many words that a trust tap and a successful phone test do not enable everyday Codex use, and section 6 removes the hook again.

Ceremony design, and why it is not the curl witness in docs/codex-hook.md. That smoke test needs a shell command, and shell is refused, so it is unreachable on 0.152.1. The only gated surface left is a direct apply_patch, and the only manual class an apply_patch can reach is policy.edit.ci, through the protected_paths entry for the workflows directory. The ceremony therefore adds one text file under that path inside a scratch directory, which is harmless and lands nowhere near the repository. Verified read-only that the class resolves: approval policy test policy.edit.ci prints final: manual. The known failure mode is documented inline: if Codex dispatches the patch through the shell it is reported as Bash and denied, which is native v7 behaviour and the adapter working as designed, and the runbook says to record that and stop rather than reword the request into a shell command.

Rollback evidence. An agent cannot rehearse this by hand: any path naming the dot-codex directory classifies policy.core, human-only, wherever it lives, so both a mkdir and a Write of a scratch hooks.json were refused by the hook. The rehearsal is therefore a committed regression test that builds the same fixture inside the test process and touches no Codex configuration on the machine: the documented rollback returns Codex doctor to NOT CONFIGURED, and is reversible, in tests/cli-doctor-codex.test.ts. It asserts the doctor row goes from pass to the same NOT CONFIGURED line a project that never installed the hook gets, that the harness is no longer registered, and that renaming the file back restores the row. Also verified read-only on an empty scratch directory that approval doctor writes nothing: no dot-approval directory is created and no record is appended.

One finding for Carter that changes the install location. On the primary checkout the codex-hook-wiring doctor row can never read pass, because the repository carries a dot-codex config.toml for the MCP entry, Codex merges hook sources, and doctor does not interpret inline TOML hook tables; with both files present the row reports the merge and leaves the effective configuration undetermined. That is one more reason the runbook installs the hook in a scratch session directory instead of the primary. SPEC 11 invariants touched: none are weakened. The doc adds no runtime behaviour, and it states the fail-open boundary rather than implying enforcement.

Evidence: run-tests --only docs-guard cli-doctor-codex codex-doctor cli-hook-codex cli-hook gave 169 tests, 169 pass, 0 fail, exit 0. build, typecheck and lint all exit 0. No Codex process was started, no hook was installed on this machine, and no host trust state was read or changed.
<!-- SECTION:NOTES:END -->
