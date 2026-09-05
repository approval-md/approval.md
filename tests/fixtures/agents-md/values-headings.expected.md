```yaml approval-policy
# DRAFT policy, generated from tests/fixtures/agents-md/values-headings.md by `approval import agents-md`.
#
# NOTHING HAS BEEN APPLIED. This block was printed, not written: APPROVAL.md
# is untouched, no event was appended, and no attestation was made. A human
# confirms a draft by pasting it into APPROVAL.md and running
# `approval policy amend`, which diffs it, attests it, and commits it.
#
# The v0.1 vocabulary has three levels (manual > supervised > autonomous) and
# NO forbid level, so bullets from a "Never" section are rendered `manual`
# and carry a `# never:` comment. Manual is not never — a human can still say
# yes. Read every `# never:` line before confirming this draft.
#
# Class names are PROPOSALS. The importer places bullets with a fixed keyword
# table into the SPEC.md §7 developer-workstation namespaces (vcs.*, deps.*,
# release.*, exec.*, network.*, policy.*). Rename any that do not match the
# classes your adapters actually declare.
#
# No `approvers:` and no `channels:` are invented here: a generated file must
# not name who may approve, or where. Add them by hand (SPEC.md §5.1).

version: "0.1"

defaults:
  autonomy: manual          # anything not named below needs sign-off
  approval_ttl: "24h"
  on_expiry: reject

classes:
  # from: Read files, list directories, search the repo
  read.*: { autonomy: autonomous }
  # from: Adding or upgrading dependencies
  deps.add: { autonomy: manual }
```

```yaml approval-values
# DRAFT values block, imported from tests/fixtures/agents-md/values-headings.md by `approval import agents-md`.
#
# NOTHING HAS BEEN APPLIED, exactly as for the policy draft: this block was
# printed, not written. APPROVAL.md is untouched and nothing was attested.
# The values block lives INSIDE APPROVAL.md, so pasting it changes the file's
# bytes and invalidates the standing attestation; renew it immediately after.
#
# EVERY bullet is in `wants:`, and nothing is graded. `love:`, `like:` and
# `dislike:` are yours to fill in. A grade is a statement of taste and it is
# yours to make: this importer can see that you wrote a line down, and cannot
# see how much you meant it. Guessing would put words in your mouth.
#
# This block is guidance and never policy. Nothing here is enforced, counted
# or checked, and no routing, class match, sampling draw, budget or token
# reads it (SPEC.md §11.1 invariant 10).

version: 1
wants:
  - "Work I can check without rerunning it myself"
  - "A diff that says what it changed and why it changed it"
  - "The failing case lands first, then the fix"
  - "Short messages, with the whole command spelled out"
  - "Say when you think a task is wrong, before you do it"
  - "Tell me the exit code and the number of tests that ran, in that order, before you tell me anything else about a run, because a summary block that says everything passed has been wrong before and an e…"
```
