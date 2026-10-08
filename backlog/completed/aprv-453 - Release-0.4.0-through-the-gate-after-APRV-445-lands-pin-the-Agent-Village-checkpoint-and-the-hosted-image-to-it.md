---
id: APRV-453
title: >-
  Release 0.4.0 through the gate after APRV-445 lands; pin the Agent Village
  checkpoint and the hosted image to it
status: Done
assignee:
  - '@claude'
created_date: '2026-10-03 03:50'
updated_date: '2026-10-04 20:53'
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
- [x] #1 PR 569 is merged into main with a green CI verdict and its three open rulings (exit 7 in the frozen table, credentialReadGate breadth, APPROVAL_HERMES_HOME on the serve process) recorded as decided in APRV-445's notes
- [x] #2 0.4.0 is published to npm through the gated release path with a changelog entry that names propose, start, agent_may_request, unix listen, the Hermes rules, APRV-427 and APRV-428
- [x] #3 agentvillage-data DATA-228 carries the version string to bake and approval-md-hosted's image pin bump is filed or landed
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Worktree lane/aprv-453 from origin/main at 70979abe (#588 merge), after #569 (af3e591a) and every lane named in the brief.
2. CHANGELOG.md: date the Unreleased section as 0.4.0 in the heading contract scripts/release-notes.mjs enforces (## 0.4.0, em dash, 2026-10-04), with a fresh empty Unreleased above; preamble in the 0.3.0 shape (anchor commit, non-merge count since v0.3.0); entries grouped as 0.3.0 groups them; add the user-visible changes since v0.3.0 the Unreleased section never received (APRV-421 serve, 424 webhook, 423 harness cap, 427, 428, 401, 397, 409, 410, 408, 389, 376, 381, 420, 412, 437, 436), written from the task summaries and diffs; breaking and behavior notes plus conformance and schema deltas since v0.3.0. Correct 0.3.0's stale not-yet-tagged preamble with the published sentence its AC3 checklist asked for.
3. Version bump as 611a197 did: package.json and package-lock.json's two fields by npm version 0.4.0 --no-git-tag-version (no tag), VERSION in src/cli/wordmark.ts, APPROVALD_VERSION in src/daemon/git-evidence.ts, and the eight site strings the APRV-395 guard binds.
4. docs/releases/0.4.0.md: what Agent Village gets, the downstream pins (DATA-228 APPROVALD_BIN, approval-md-hosted Dockerfile 6b74ca72 to v0.4.0, HOSTED-32), conformance versions, the three SPEC states.
5. Build, typecheck, lint, full suite under the CLAIMS lock; one commit; push; PR with the morning sequence; CI watched to a verdict; merge NOT armed (Carter's release sequence).
6. AC1 checked with #569 evidence; AC2 and AC3 stay open (tag, publish and downstream pins are Carter's).
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
AC1 evidence. PR #569 (APRV-445: propose/start, agent_may_request, unix listen, Hermes rules, fail-closed paths) merged 2026-10-04T10:56:58Z, merge commit af3e591a3607f9a7d6c6aef50932d2c140260dbe, head a4dd89e5 with CI run 37195597583 'ci' success. Its three open rulings are recorded in APRV-445's notes (the 'Open rulings' paragraph) as shipped as merged: (1) exit 7 void is in the exit table, (2) credentialReadGate breadth (.approval/env.example and Glob on .approval/keys read as credential reads), (3) APPROVAL_HERMES_HOME must be set on the serve process.

Release PR (lane C9, 2026-10-04): PR #595 on lane/aprv-453, one release commit e17bdb67 on base 70979abe (the #588 merge), NOT armed. A release commit merges in Carter's sequence, because the tag must point at current main and main stays fixed until publish.yml binds tag and main.

What the commit does, mirroring 0.3.0's 611a197:
- CHANGELOG.md: Unreleased becomes '## 0.4.0 — 2026-10-04' with a fresh empty Unreleased above it. The brief said '## 0.4.0 (2026-10-04)'; that spelling fails scripts/release-notes.mjs in the publish verify job (the contract is the em dash and ISO date), so the contract spelling was used. Preamble anchored at 70979abe, 239 non-merge commits after v0.3.0, naming the headline the brief listed. Entries grouped as 0.3.0's. Every task id in the old Unreleased survives (checked by set difference). Added, because they landed after v0.3.0 and never reached Unreleased: APRV-421, 424, 423, 427, 428, 401, 397, 409, 410, 408, 389, 376, 381, 420, 412, 413, 426, 417, 436, 437, plus conformance and schema deltas. APRV-427 and APRV-428 were in no changelog section before this. The 0.3.0 preamble's stale 'Not yet tagged or published' sentence became the published sentence APRV-371's AC3 checklist item f asked for.
- Version: package.json and package-lock.json's two fields by hand (npm version classifies release.publish, rule npm-publish); VERSION in src/cli/wordmark.ts; APPROVALD_VERSION in src/daemon/git-evidence.ts; the eight site strings the APRV-395 guard binds. No tag.
- tests/release-notes.test.ts: 0.4.0 added to the dated-section lists; the absent-version cases moved from 0.4.0 to 9.8.7.
- docs/releases/0.4.0.md: new (0.3.0 had no separate notes file; its notes are the changelog section). It covers what AV gets, the downstream pins (DATA-228 APPROVALD_BIN; approval-md-hosted's Dockerfile pin from 6b74ca72 to v0.4.0, HOSTED-32), the conformance versions (refusal-unions 27.0.0, schema-validation 2.9.0, command-class 1.5.0, hook-read-scope 2.0.0, the rest unchanged), and the SPEC states. SPEC.md on 70979abe hashes bb092166..., covered by gate.path.signed_off seq 81682 (human:carter, 2026-10-04T09:19:39Z). #590 (APRV-454, head c1ab9aac, digest 59212c6d...) is awaiting attest. The pending markers left after it are APRV-317 x11, 309 x2, 322 x2, 325.1, 325.2.

Verification: npm ci 0, build 0, typecheck 0, lint 0; node scripts/run-tests.mjs --baseline exit 0, 5588 tests, 5587 pass, 0 fail, 1 skipped, ci-baseline 0 failing (CLAIMS SUITE 12:49Z to 12:59Z); release-notes --check exit 0.

AC2 open: Carter merges #595, then the gated annotated tag v0.4.0 and its push (release.publish, two taps; envelope on this task file by hand, as APRV-371 did, because the Backlog CLI strips it), then Trusted Publishing, then the APRV-371 AC3-style verification. AC3 open: after npm shows 0.4.0, tell DATA-228 the version string and file or land HOSTED-32's Dockerfile pin bump.

Noticed, not fixed: docs/cli-reference.md serve section says the agent allowlist is five verbs, but AGENT_VERBS has seven since #569; docs/README-extended.md version-scope line still says 0.3.0; package-lock.json root license reads MIT against package.json Apache-2.0.

PUBLISHED 2026-10-04. #595 merged as fb0cf987 at 19:57Z; Carter tagged v0.4.0 on it and pushed at 20:22Z; release-candidate run relayed, publish run 37231849205 succeeded (verify, publish to npm, GitHub Release). Read-backs at 20:55Z: npm view approval-md@0.4.0 version 0.4.0, gitHead fb0cf987985c2b9884ebe46b7b3b4419147d057e, dist-tags latest 0.4.0; tarball sha256 b7cf376dd616493f04dfe417a110a463d96c5e10e37265d7864b29a04c1130a4 equals the Release asset approval-md-0.4.0.tgz.sha256; clean install in a scratch directory runs approval --version = 0.4.0; npm audit signatures: 15 packages with verified attestations; provenance in the Sigstore log (logIndex 3078539447). The registry answered 404 for about seven minutes after the publish job printed + approval-md@0.4.0 (replication lag; noted for the runbook). Downstream: DATA-228 told to bake approval-md@0.4.0 at APPROVALD_BIN (note on the task); HOSTED-32's Dockerfile pin bump to v0.4.0 pushed on PR #41's branch for Carter's merge.
<!-- SECTION:NOTES:END -->
