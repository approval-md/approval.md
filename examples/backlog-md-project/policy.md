# Approval policy (example Backlog.md project)

An agent works the board in `backlog/`. Reading, building, testing and writing
inside the workspace run on their own. Publishing a release leaves the machine,
so it waits for a person.

In your own project this block lives in `APPROVAL.md` at the repository root
and every verb below finds it without a flag. The example names it `policy.md`
because this repository's own gate reserves the `APPROVAL.md` filename to human
hands wherever it sits (`policy.core`, human-only), so the agent that wrote this
example could not have committed one; the walkthrough passes `--policy` instead.

```yaml approval-policy
version: "0.1"
defaults:
  autonomy: manual
  approval_ttl: "24h"
  on_expiry: reject
  channel: cli
classes:
  read.*:
    autonomy: autonomous
  exec.local:
    autonomy: autonomous
  files.write.workspace:
    autonomy: autonomous
  release.publish:
    autonomy: manual
```
