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
  approval_ttl: 24h
  on_expiry: reject
  token_delivery: sealed   # APRV-166: grant seals to the requester's ephemeral
                           # key; the channel never carries a usable token and
                           # no human relays one (was: manual)

approvers:
  carter:
    channels: [telegram, cli]

protected_paths:            # widens policy.edit; the built-ins hold regardless
  - SPEC.md

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
  vcs.push.main:             { autonomy: supervised }   # gated by per-task human review; includes gh pr merge
  vcs.pr.*:                  { autonomy: supervised }   # gh pr create / edit / comment on a feature branch
  vcs.history.rewrite:       { autonomy: human-only }   # a person rewrites shared history, never an agent (APRV-185)
  files.delete.out_of_scope: { autonomy: manual }
  deps.add:                  { autonomy: manual }       # every new package, runtime or dev
  deps.install:              { autonomy: autonomous }   # bare npm install / npm ci from the lockfile
  network.call:              { autonomy: manual }       # mutating/ambiguous only; reads classify read.* and flow
  release.publish:           { autonomy: manual }       # npm, tags, versions
  policy.edit:               { autonomy: supervised-live, live_rate: 0.1 }       # this file, CLAUDE.md, CI config
  policy.core:               { autonomy: human-only }   # APPROVAL.md and .approval/* except the log (APRV-198)
  log.mutate:                { autonomy: human-only }   # any write aimed at .approval/log/ (APRV-198)
  account.credential:        { autonomy: human-only }   # keychain, APPROVAL_*/TELEGRAM_*/VAULT_* probes, vault/keys/env reads (APRV-194)
  log.sync:                  { autonomy: autonomous }       # ff-pull with chain reconcile; APRV-125
  log.advance:               { autonomy: supervised-live, live_rate: 0.01 }       # records commit to a records branch; APRV-125

budgets:
  global: { daily_actions: 20000 }

audit:
  supervised_sample_rate: 0.15
  sampling_secret_env: APPROVAL_SAMPLING_SECRET   # name only; secret in the env

daemon:
  read_proof: incremental
  full_reproof_every: 50
  full_reproof_after: 60s
```

````markdown
Below the policy is a second block the runtime never enforces. It is what I
value, for agents that want to know; `approval values` prints it.

```yaml approval-values
version: 1

love:
  - honest thoughts on what we are building, including when you think I am wrong
  - a journal entry of about five points at the end of each milestone
  - "a tight ship loop: task, plan, diff, tests, PR, merge armed, all in one session"

like:
  - success reported first, caveats after, in a message that stands on its own
  - a runbook I can paste into a terminal rather than prose about one
  - the real change shown, not a description of it
  - small diffs with one reviewable idea in them

dislike:
  - work that lands without a Backlog task
  - a PR left waiting for a hand click when the merge could have been armed
  - confident documentation that is stale

wants:
  - say when you are stuck rather than guessing a fourth time; the journal is for that
  - tell me when a policy or an instruction reads as wrong, then comply or stop, your call
  - name the window and the full command when you hand me something to run

responds: >-
  I read the journal after a session and react on the samples that reach me.
  Silence is not disapproval. A loved or disliked reaction always carries a
  note saying why; a bare ok means I looked and it was fine.
```
````