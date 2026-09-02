---
id: APRV-184
title: 'Policy amendment: policy.edit moves to supervised-live 0.1'
status: To Do
assignee: []
created_date: '2026-08-31 23:38'
updated_date: '2026-09-02 07:58'
labels:
  - policy
  - gate
dependencies:
  - APRV-127
priority: medium
ordinal: 160000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
2026-08-31, from the human, confirming the APRV-127 dogfood payoff: 'yeah we should probably make that policy amendment'. Amend APPROVAL.md so class policy.edit declares autonomy supervised-live with live_rate 0.1: roughly one in ten policy/SPEC/CLAUDE.md edits blocks on a Telegram tap (selected by HMAC(sampling secret, payload_hash), agent-unpredictable, post-hoc verifiable), the rest proceed and stay in the retro pool.

Prerequisites, in order:
(1) APRV-127's SPEC 5/7/11.1 amendments are still flagged pending sign-off; the human signs those off first, since the policy grammar this amendment uses is defined there.
(2) approval setup sampling must be run by the human: approval env --check on 2026-08-31 reports APPROVAL_SAMPLING_SECRET unresolved and no .approval/env file. Supervised-live fails closed without a usable secret in the gate process's environment: every action in the class gates, making the amendment a no-op that still costs a ceremony. Verify the daemon terminal resolves the secret before amending.
(3) The ceremony itself: approval policy amend --commit from the primary checkout (protected main auto-switches to the policy-amend-<seq> branch + PR flow). Amendment ends in human attestation; the agent's role is drafting the exact YAML in this task and verifying prerequisites, per the dogfood rule that agents do not edit APPROVAL.md.

Note for the drafter: consider whether the live grants for sampled policy.edit actions need their own dogfood pin in the same PR, per the session practice that pins for newly declared classes move in the same PR as the policy.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Exact APPROVAL.md diff drafted in this task: policy.edit autonomy supervised-live, live_rate 0.1, everything else on the rule unchanged
- [x] #2 APRV-127 SPEC sign-off confirmed landed before the ceremony
- [ ] #3 Sampling secret verified resolvable in the gate process environment (approval doctor or env --check clean on APPROVAL_SAMPLING_SECRET)
- [x] #4 Human runs the amend ceremony; attestation seq and PR recorded in implementation notes
- [ ] #5 Post-amend: one sampled and one unsampled policy.edit observed and their selection verified against the secret, recorded in notes
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Exact APPROVAL.md diff drafted (AC 1). Line 46 changes from:

  policy.edit:               { autonomy: manual }       # this file, CLAUDE.md, CI config

to:

  policy.edit:               { autonomy: supervised-live, live_rate: 0.1 }  # this file, CLAUDE.md, CI config; APRV-184

Everything else on the rule unchanged (no approvers list or limits declared today, none added). Sampled edits follow the manual path bit for bit; unsampled ones proceed and stay in the retro pool.

Prerequisites verified 2026-09-01: APRV-127 grammar is BUILT and its SPEC amendments still carry pending-sign-off flags (Carter's step 1). APPROVAL_SAMPLING_SECRET is unresolved and .approval/env absent (approval env --check), so supervised-live would fail closed and gate 100 percent: Carter runs approval setup sampling first (step 2), then verifies the daemon terminal resolves the secret, then approval policy amend --commit in the primary (step 3; expect the ~33s silent pre-diff verify, APRV-167). Blocked on those three human steps; nothing further for an agent until the ceremony lands.

2026-09-01: ceremony landed. Carter hand-applied line 46 (policy.edit: { autonomy: supervised-live, live_rate: 0.1 }) and ran approval policy amend --commit: attested seq 5147, PR #175 (policy-amend-5147, merged 05:39Z with the dogfood pin moved to supervised in the same PR), log advance PR #176 merged 08:14Z. AC2: APRV-127 sign-off PR #174 merged 05:21Z, before the ceremony. Still open: AC3 (APPROVAL_SAMPLING_SECRET minted via approval setup sampling into keychain + .approval/env, but not yet resolvable in hook/agent gate processes, so supervised-live fails closed and gates 100 percent; safe, no tap reduction yet) and AC5 (observation of one sampled + one unsampled edit, possible only after AC3). Hardening dependency: APRV-198 narrows policy.edit so the 0.1 sampling stops covering APPROVAL.md and the log; landing today.

DEPENDENCY ADDED 2026-09-01 by the APRV-198 lane: this task now depends on APRV-198, which splits the classifier's single protected class three ways (policy.edit narrows to CLAUDE.md / AGENTS.md / .npmrc / .github/workflows/ and the policy's own protected_paths entries; policy.core is APPROVAL.md and the rest of the approval home plus the harness files that install the hook; log.mutate is anything aimed at .approval/log/). Until that lands, the supervised-live 0.1 already attested at seq 5147 is sampling a class that still covers APPROVAL.md itself and log-redirect writes, which is the second blocker recorded above.

The proposed APPROVAL.md block for the next amend ceremony, updated to name the split (APRV-198 AC5, and the APRV-185 draft it supersedes):

classes:
  policy.edit:         { autonomy: supervised-live, live_rate: 0.1 }   # UNCHANGED, now the narrowed class: agent instructions, CI/release config, protected_paths entries
  policy.core:         { autonomy: human-only }   # NEW -- APPROVAL.md, .approval/* outside the log, .claude/settings*, .cursor/hooks*
  log.mutate:          { autonomy: human-only }   # NEW -- any write, redirect, append, truncation or rename aimed at .approval/log/
  account.credential:  { autonomy: human-only }   # NEW -- emitted since APRV-194
  vcs.history.rewrite: { autonomy: human-only }   # was: manual

This resolves the 184-vs-185 tension APRV-185's notes flagged: policy.edit stays sampled BECAUSE it no longer covers the gate's organs, and the human-only line lands on policy.core, log.mutate, account.credential and vcs.history.rewrite instead. The ceremony is Carter's; nothing here is applied.

2026-09-02 verification lane (worktree verify-184-168, log read at origin/main): scanned .approval/log/events.jsonl for every task whose resolved class is policy.edit or log.advance since seq 5147 (the ceremony). 15 such tasks exist, spanning seq 5281 through 8379 (well past the 7355/7413 checkpoints), all with a hook: actor except APRV-151. Sequence shape for every single one: task.registered -> approval.requested -> approval.granted (actor human:carter in every case that reached a decision) -> execution.started[/completed]. Zero tasks show the unsampled shape (task.registered -> execution.started with no approval.requested/granted in between). Bucket counts: gated-to-human = 15/15, sampled-through = 0/15, other = 0/15. Example seqs: [5281-5348], [6460-6483], [7048-7077] (all pre-7355, for baseline), [7419-7422], [7472-7622], [7693-7702], [8104-8114], [8281-8379] (post-7413). Per SPEC.md/sampler.ts design, no dedicated log record marks a live-selection verdict either way (deliberate: gate.ts's liveVerdict() comment states "an approval.requested is byte-for-byte what a manual class's would have been... nothing about the selection is written to the log"), so the classification above is by event shape, not by a sampling-record type; this is also why 0/15 is the strongest evidence available from the log alone that live selection is not distinguishing anything.

Code trace, WHERE the secret is read: core/sampler.ts's resolveLiveSelector(load, env = process.env) reads env[secretEnv] where secretEnv is APPROVAL.md's audit.sampling_secret_env (APPROVAL_SAMPLING_SECRET, confirmed at APPROVAL.md:58). It is called from core/gate.ts's liveVerdict() as resolveLiveSelector(load, env ?? process.env) (gate.ts:1440), i.e. it reads process.env of whatever process is executing gate.ts's request() path IN-PROCESS -- there is no spawn between "the hook (or CLI/daemon) process starts" and "the live verdict is computed". This is a completely different code path from src/core/child-env.ts / childEnvironment() (APRV-205), which only shapes the environment handed to a FURTHER spawned child (approval run's target command, or hook.ts's own git spawns via gitEnvironment() at hook.ts:500) -- childEnvironment() is irrelevant to whether the secret reaches the hook process's OWN process.env. Concretely: whether "a hook process launched by Claude Code" has the secret depends entirely on whether the shell/session that launches the Claude Code session (and therefore its hook subprocesses) has APPROVAL_SAMPLING_SECRET exported in its ambient environment -- there is no code path in this repo that sources .approval/env or the keychain into a hook process's environment for this purpose (env-file.ts's "no verb reads .approval/env into its own environment" rule holds here; the one narrow exception, adapters/env-passphrase.ts, is scoped to the vault passphrase inside a consumed adapter token window (APRV-168) and has nothing to do with the sampling secret or the hook path).

CONCLUSION: the sampling secret is NOT resolved in the gate processes that produced these 15 records (the hook path, since every action here carries an actor of agent:claude-code registering via a hook: task and a human:carter decision, i.e. this is the Claude Code hook / CLI request path, not a bespoke daemon test harness). 15/15 supervised-live-eligible actions since the seq 5147 ceremony gated to a human with zero live-sampled-through examples, exactly the fail-closed behavior sampler.ts documents for an unavailable secret ("an unavailable secret makes every live action gated... a class an operator asked to sample at 1% is gated at 100% until the secret is exported"). This matches the open item already recorded in this task's notes (AC3/AC5 blocked) and in core/policy-expectations.ts's own annotations for both the seq 5147 and seq 7413 checkpoints ("with no usable sampling secret live selection fails closed and every edit/advance gates").

AC3 (sampling secret verified resolvable in the gate process environment): NOT MET. Evidence points the other way -- 100% gating with zero sampled-through examples is direct empirical proof the secret is unresolved in the process that ran liveVerdict() for all 15 records.
AC5 (one sampled + one unsampled policy.edit observed and verified against the secret): NOT MET, and cannot be met while AC3 is unmet -- there is no unsampled example in the log to observe.

Nothing here questions AC1/AC2/AC4, which this lane did not re-derive and leaves as recorded. Task NOT moved to Done: two of five ACs remain open, and per SPEC's fail-closed principle that is the correct, safe state -- every policy.edit/log.advance since the ceremony has, in fact, gone to a human. What remains is an operational step outside this codebase: the process that launches the Claude Code hook (and, per APRV-127, the daemon) needs APPROVAL_SAMPLING_SECRET exported into its own environment before it starts, e.g. via the same session/terminal setup approval setup sampling wrote for, verified with approval env --check or approval doctor from that same process's environment -- not merely minted into the keychain/.approval/env, which by design nothing sources into a hook/gate process automatically.
<!-- SECTION:NOTES:END -->
