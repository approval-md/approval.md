---
id: APRV-114
title: 'Classifier: GET-shaped web fetches are read.web, not network.call'
status: To Do
assignee: []
created_date: '2026-08-20 12:08'
labels:
  - classifier
  - dogfood
dependencies: []
priority: medium
ordinal: 106000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Research subagents shelling out to curl and gh api flood the Telegram channel: every fetch classifies as network.call, the repo policy holds that class at manual, and the approver gets a ping per URL (see events ~98-137 in the live log, 2026-08-20). SPEC §7 already places web fetch and API GET under read.* (autonomous); the classifier is coarser than the taxonomy, and that fidelity gap is the noise source.

Proposal: refine the network rule in src/core/command-class.ts so read-shaped invocations emit read.web (or read.vcs.remote for gh api) and everything else keeps network.call.
- curl/wget/http(ie): GET-shaped only — no -X with a non-GET method, no -d/--data*/-F/--form/--upload-file/-T/--post-data/--post-file/--method. Any ambiguity fails toward network.call (manual), matching the fail-closed invariant.
- gh api: no -X/--method with a non-GET value and no -f/-F/--field/--raw-field/--input → read.vcs.remote (same class refineGh gives gh pr view). Otherwise network.call.
- ssh/scp/sftp/rsync/nc/telnet/ftp stay network.call unconditionally: transport read/write cannot be judged from argv.
- Precedent: APRV-83 carved vcs.pr.* out of network.call for the same approver-fatigue reason; APRV-108 is the same shape of classifier-fidelity fix.

Alternative the human may prefer instead (or in the interim, since only a human can edit APPROVAL.md and re-attest): set network.call to supervised in the repo policy, accepting that mutating network calls then ride at 15% retrospective sampling. The classifier refinement is the better fix because it keeps mutating calls at manual while un-gating what the taxonomy already calls a read. Requires human sign-off before implementation because it widens what runs autonomously under the live dogfood policy.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Classifier emits read.web for GET-shaped curl/wget/http(ie) invocations and network.call for anything carrying a body, upload, or non-GET method flag
- [ ] #2 gh api without a method or field flag classifies read.vcs.remote; with any of them it stays network.call
- [ ] #3 ssh, scp, sftp, rsync, nc, telnet, ftp remain network.call unconditionally
- [ ] #4 Ambiguous or unparsed invocations fail toward network.call, with tests pinning the ambiguous cases
- [ ] #5 approval hook classify -- 'curl https://example.com' reports the read class end-to-end; hook tests cover it
- [ ] #6 SPEC §7 wording checked; amended only if the refinement diverges from it (expected: no change needed)
<!-- AC:END -->
