---
id: APRV-114
title: 'Classifier: GET-shaped web fetches are read.web, not network.call'
status: Done
assignee: []
created_date: '2026-08-20 12:08'
updated_date: '2026-08-20 18:46'
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
- [x] #1 Classifier emits read.web for GET-shaped curl/wget/http(ie) invocations and network.call for anything carrying a body, upload, or non-GET method flag
- [x] #2 gh api without a method or field flag classifies read.vcs.remote; with any of them it stays network.call
- [x] #3 ssh, scp, sftp, rsync, nc, telnet, ftp remain network.call unconditionally
- [x] #4 Ambiguous or unparsed invocations fail toward network.call, with tests pinning the ambiguous cases
- [x] #5 approval hook classify -- 'curl https://example.com' reports the read class end-to-end; hook tests cover it
- [x] #6 SPEC §7 wording checked; amended only if the refinement diverges from it (expected: no change needed)
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Merged as PR 103 (branch aprv-114-classifier-readweb). The network table row split: web-fetch (curl/wget/http/httpie) refines via refineWebFetch to read.web only when nothing contradicts a GET; every body/upload/method flag, curl -K/--config smuggling, and any ambiguity refuses to network.call (rule web-write). refineGhApi gives gh api the read.vcs.remote class refineGh gives gh pr view, with method/field flags refusing. ssh/scp/sftp/rsync/nc/telnet/ftp unconditional. Sixteen ambiguous invocations pinned. Beyond the ACs: a new RuleContext.substituted flag closes a genuine fail-open the task missed (the lexer erases $(...) words, so curl $(cat flags.txt) read as a bare GET); refinement refuses when set. SPEC section 7 needed no amendment (AC 6). +79 tests. Flagged for the human: wget URL / curl -o now classify read.web though they write a file; holding downloads is a policy line (read.web) if wanted. Post-merge: the human may tighten network.call back to manual; the dogfood pin note in tests/dogfood.test.ts anticipates it. Invariants: fail-closed preserved (every ambiguity resolves stricter); enforcement reads only parsed argv, never self-report.
<!-- SECTION:NOTES:END -->
