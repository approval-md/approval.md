# Approval Policy — approval.md repository

This repo builds the tool this file configures, and this file is the
authoritative statement of what agents here may do: CLAUDE.md's Permissions
section is the AGENTS.md-shaped summary and yields to this file wherever the
two disagree. Enforcement is mechanical where the runtime sits in the path:
`approval run` for actions executed through the gate, and `approval hook
claude-code` (docs/claude-code-hook.md) for the shell commands and policy-file
edits a Claude Code session issues directly, once `.claude/settings.json`
carries the hook entry. Anything outside those two paths is still held to this
policy by CLAUDE.md prose and the agent's reading of it.

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
  network.call:              { autonomy: manual }       # anything beyond package installs
  release.publish:           { autonomy: manual }       # npm, tags, versions
  policy.edit:               { autonomy: manual }       # this file, CLAUDE.md, CI config

budgets:
  global: { daily_actions: 200 }

audit:
  supervised_sample_rate: 0.15
  sampling_secret_env: APPROVAL_SAMPLING_SECRET   # name only; secret in the env
```