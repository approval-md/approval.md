---
id: APRV-453
title: >-
  Release 0.4.0 through the gate after APRV-445 lands; pin the Agent Village
  checkpoint and the hosted image to it
status: To Do
assignee: []
created_date: '2026-10-03 03:50'
labels:
  - release
  - hosting
  - agent-village
dependencies: []
references:
  - private/agentvillage-integration/07-sequenced-plan.md
priority: high
ordinal: 341000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The Agent Village checkpoint (agentvillage-data DATA-228) bakes an approval-md install at APPROVALD_BIN and the Bountify hosted daemon image pins core by commit 6b74ca72, which predates APRV-427, APRV-428 and APRV-445. The village needs a release string in every tenant's log and a binary that has propose, start, wait --timeout 0, serve --listen unix and the Hermes classifier rules. Sequence: merge origin/main into carter/data-212-propose (it is CONFLICTING against main in src/serve/server.ts, src/cli/serve.ts, src/cli/hook.ts, execute, help, instructions, verb-registry and docs/cli-reference.md because APRV-427 and 428 landed there on 2026-09-25), CI to verdict, Carter's review and merge of PR 569; then the 0.3.0 release runbook (APRV-371, docs/trusted-publishing-runbook.md): changelog, version bump, gated tag and tag push through Trusted Publishing; then tell DATA-228 the version to pin and bump the hosted image Dockerfile pin in approval-md-hosted. Context: private/agentvillage-integration/07-sequenced-plan.md items 0.2, 0.3, 2.3.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 PR 569 is merged into main with a green CI verdict and its three open rulings (exit 7 in the frozen table, credentialReadGate breadth, APPROVAL_HERMES_HOME on the serve process) recorded as decided in APRV-445's notes
- [ ] #2 0.4.0 is published to npm through the gated release path with a changelog entry that names propose, start, agent_may_request, unix listen, the Hermes rules, APRV-427 and APRV-428
- [ ] #3 agentvillage-data DATA-228 carries the version string to bake and approval-md-hosted's image pin bump is filed or landed
<!-- AC:END -->
