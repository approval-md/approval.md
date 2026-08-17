# Approval Policy — approval.md repository

This repo builds the tool this file configures. Until the gate (M3) and
channels (M4) exist, enforcement is social: agents read this policy and
CLAUDE.md holds them to it. From M3 it becomes mechanical.

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
  vcs.push.branch:           { autonomy: autonomous}
  vcs.push.main:             { autonomy: supervised }   # gated by per-task human review
  vcs.history.rewrite:       { autonomy: manual}
  files.delete.out_of_scope: { autonomy: manual }
  deps.add:                  { autonomy: manual }       # every new package, runtime or dev
  network.call:              { autonomy: manual }       # anything beyond package installs
  release.publish:           { autonomy: manual }       # npm, tags, versions
  policy.edit:               { autonomy: manual }       # this file, CLAUDE.md, CI config

budgets:
  global: { daily_actions: 200 }

audit:
  supervised_sample_rate: 0.15
  sampling_secret_env: APPROVAL_SAMPLING_SECRET   # name only; secret in the env
```