# Approval Policy — approval.md repository

This repo builds the tool this file configures, and this file is the
authoritative statement of what agents here may do: CLAUDE.md's Permissions
section is the AGENTS.md-shaped summary and yields to this file wherever the
two disagree. Enforcement is mechanical where the runtime sits in the path:
`approval run` for actions executed through the gate, `approval hook
claude-code` (docs/claude-code-hook.md) for Claude Code once
`.claude/settings.json` carries the hook entry, and `approval hook cursor`
(docs/cursor-hook.md) for local Cursor Agent once `.cursor/hooks.json`
carries the hook entry. Anything outside those paths is still held to this
policy by CLAUDE.md / AGENTS.md prose and the agent's reading of it.

```yaml approval-policy
version: "0.1"

defaults:
  autonomy: manual
  channel: telegram        # cli remains a fallback per approvers
  approval_ttl: 2h
  on_expiry: reject
  token_delivery: sealed   # APRV-166: grant seals to the requester's ephemeral
                           # key; the channel never carries a usable token and
                           # no human relays one (was: manual)

approvers:
  carter:
    channels: [telegram, cli]

protected_paths:            # widens policy.edit; the built-ins hold regardless
  - { path: SPEC.md, class: policy.edit.spec }
  - { path: design/, class: policy.edit.design }
  - { path: .github/workflows/, class: policy.edit.ci }

channels:
  telegram:
    prompt:
      rows: [class, command_breakdown, policy_diff, protected_path, task, summary, gloss]
      hide: [ttl_remaining_ms, est_cost_usd, chain, attestation, provenance, requested_ts, waiting]

classes:
  read.*:                    { autonomy: autonomous }
  files.write.workspace:     { autonomy: autonomous }   # src, tests, fixtures, backlog/
  vcs.commit.branch:         { autonomy: autonomous }
  vcs.push.branch:           { autonomy: autonomous }
  vcs.push.main:             { autonomy: supervised-retro }   # proceeds, sampled for retrospective review; includes gh pr merge
  vcs.pr.*:                  { autonomy: supervised-retro }   # gh pr create / edit / comment on a feature branch
  vcs.history.rewrite:       { autonomy: human-only }   # a person rewrites shared history, never an agent (APRV-185)
  vcs.ref.delete:            { autonomy: manual }       # git push --delete / -d / :refspec: removing a remote branch, refs named in the prompt (APRV-352)
  files.delete.out_of_scope: { autonomy: manual }
  deps.add:                  { autonomy: manual }       # every new package, runtime or dev
  deps.install:              { autonomy: autonomous }   # bare npm install / npm ci from the lockfile
  network.call:              { autonomy: manual }       # mutating/ambiguous only; reads classify read.* and flow
  release.publish:           { autonomy: manual }       # npm, tags, versions
  policy.edit:               { autonomy: supervised-live, live_rate: 0.01 }       # CLAUDE.md, AGENTS.md, .npmrc; this file is policy.core, CI is policy.edit.ci
  policy.edit.design:        { autonomy: supervised-retro }   # design docs: read in the PR, sampled after
  policy.edit.spec:          { autonomy: supervised-live, live_rate: 0.01 }       # SPEC amendments: one in a hundred stops for a tap; the guard and retro review cover the rest
  policy.edit.ci:            { autonomy: manual }       # CI and release config: always a tap
  files.delete.scratch:      { autonomy: autonomous }   # rm confined to the system temp root (APRV-267)
  vcs.remote.meta:           { autonomy: supervised-retro }   # gh graphql query, pr update-branch, run rerun (APRV-268)
  policy.core:               { autonomy: human-only }   # APPROVAL.md and .approval/* except the log (APRV-198)
  log.mutate:                { autonomy: human-only }   # any write aimed at .approval/log/ (APRV-198)
  account.credential:        { autonomy: human-only }   # keychain, APPROVAL_*/TELEGRAM_*/VAULT_* probes, vault/keys/env reads (APRV-194)
  harness.launch.*:          { autonomy: manual }       # starting a second agent: the grant covers the launch, never what the launched session then does (APRV-354)
  harness.launch.muse:       { autonomy: human-only }   # Muse Code: a -contributor model trains on prompts and completions, and no adapter or read jail is in place yet (APRV-354)
  log.sync:                  { autonomy: autonomous }       # ff-pull with chain reconcile; APRV-125
  log.advance:               { autonomy: supervised-live, live_rate: 0.01 }       # records commit to a records branch; APRV-125

budgets:
  global: { daily_actions: 20000 }

audit:
  supervised_sample_rate: 0.01
  sampling_secret_env: APPROVAL_SAMPLING_SECRET   # name only; secret in the env

daemon:
  read_proof: incremental
  full_reproof_every: 50
  full_reproof_after: 60s
```

Below the policy is a second block the runtime never enforces. It is what I
value, for agents that want to know; `approval values` prints it.

```yaml approval-values
version: "0.2"

love:
  - honest thoughts on what we are building, including when you think I am wrong
  - a journal entry of about five points at the end of each milestone
  - "a tight ship loop: task, plan, diff, tests, PR, merge armed, all in one session"
  - suggestions for changes to APPROVAL.md, tightening or loosening, with the cost you saw that prompted them

like:
  - success reported first, caveats after, in a message that stands on its own
  - a runbook I can paste into a terminal rather than prose about one
  - the real change shown, not a description of it
  - small diffs with one reviewable idea in them
  - say when you are stuck rather than guessing a fourth time; the journal is for that
  - tell me when a policy or an instruction reads as wrong, then comply or stop, your call
  - name the window and the full command when you hand me something to run

dislike:
  - work that lands without a Backlog task
  - a PR left waiting for a hand click when the merge could have been armed
  - confident documentation that is stale

communication: "I read the journal after a session and react on the samples that reach me. Silence is not disapproval. A loved or disliked reaction always carries a note saying why; a bare ok means I looked and it was fine."
```
