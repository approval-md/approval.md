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

approvers:
  carter:
    channels: [telegram, cli]

protected_paths:            # widens policy.edit; the built-ins hold regardless
  - SPEC.md

classes:
  read.*:                    { autonomy: autonomous }
  files.write.workspace:     { autonomy: autonomous }   # src, tests, fixtures, backlog/
  vcs.commit.branch:         { autonomy: autonomous }
  vcs.push.branch:           { autonomy: autonomous }
  vcs.push.main:             { autonomy: supervised }   # gated by per-task human review; includes gh pr merge
  vcs.pr.*:                  { autonomy: supervised }   # gh pr create / edit / comment on a feature branch
  vcs.history.rewrite:       { autonomy: manual}
  files.delete.out_of_scope: { autonomy: manual }
  deps.add:                  { autonomy: manual }       # every new package, runtime or dev
  deps.install:              { autonomy: autonomous }   # bare npm install / npm ci from the lockfile
  network.call:              { autonomy: manual }       # mutating/ambiguous only; reads classify read.* and flow
  release.publish:           { autonomy: manual }       # npm, tags, versions
  policy.edit:               { autonomy: manual }       # this file, CLAUDE.md, CI config
  log.sync:                  { autonomy: manual }       # ff-pull with chain reconcile; APRV-125
  log.advance:               { autonomy: manual }       # records commit to a records branch; APRV-125

budgets:
  global: { daily_actions: 200 }

audit:
  supervised_sample_rate: 0.15
  sampling_secret_env: APPROVAL_SAMPLING_SECRET   # name only; secret in the env
```