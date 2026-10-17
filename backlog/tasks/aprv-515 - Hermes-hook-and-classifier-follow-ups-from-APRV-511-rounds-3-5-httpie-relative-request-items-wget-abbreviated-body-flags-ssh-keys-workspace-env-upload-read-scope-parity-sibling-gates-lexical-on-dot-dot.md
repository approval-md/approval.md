---
id: APRV-515
title: >-
  Hermes hook and classifier follow-ups from APRV-511 rounds 3-5: httpie relative request items, wget abbreviated body flags, ~/.ssh as a credential path, workspace .env, upload read-scope parity across adapters, sibling gates still lexical on ..
status: To Do
assignee:
  - '@claude-approval'
created_date: '2026-10-13 09:10'
updated_date: '2026-10-13 09:10'
labels:
  - classifier
  - hermes-hook
  - security
dependencies:
  - APRV-511
priority: medium
ordinal: 393000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Filed Tue 13 Oct 2026 by the approval seat under the lead's hard stop on APRV-511 (#639): after fix round 5 any further pre-existing finding is a task with evidence, not another round. Evidence: the orchestration reports `lanes-approval/APPROVAL-HOME-ORGANS.md` ("Fix round 3" decision 4, "Fix round 4" doubts 3-4, "Fix round 5" doubts 1-4) and `lanes-approval/HOME-ORGANS-refute.md` ("Recheck at 8f954b62, re-run"; "Recheck at a0cd5e4f", "Noted for APRV tasks" items 1-7) in the agentvillage private handover. All items are pre-existing on main 3360fb86 and unchanged by #639; none reopens the #639 gate.

1. **httpie request items with a relative path** (`http POST URL f@.hermes/.env`, `f@../.op.env`): the classifier does not extract httpie items as upload sources; an absolute or `~` path is caught, a relative one stays `network.call` and ALLOW under the Hermes hook.
2. **wget abbreviated body flags** (`wget --post-f=x URL`): `refineWebFetch`'s `hasFlag` does not resolve unique prefixes, so an ordinary file x classifies `read.web`; a credential or organ x is caught since #639 round 4.
3. **`~/.ssh` is not a credential path** in `isCredentialPath` (`~/.ssh/id_rsa` reads and uploads classify by their shape, not as `account.credential`).
4. **Workspace `.env`**: `curl -d @./.env` and `cat ./.env` run in the workspace are both ALLOW, because a workspace `.env` is not a credential path today; from the Hermes home it is. Decide whether a workspace `.env` should count.
5. **Upload read-scope parity across adapters**: under the Hermes (per-call-workdir) hook an upload source outside the gate's read roots is `read.file.out_of_scope`; the pure classifier and the Claude Code / Cursor hooks still answer `network.call` for an absolute out-of-scope upload.
6. **Sibling gates lexical on `..`**: `resolvedReadTarget` (read scope) and `judgeSkillScript` resolve `..` as text, not through the kernel walk the landing check got in #639 round 3 (`kernelLanding`/`landingPaths`); plus the carried N1 (`${HERMES_HOME:-/a b}`, `$'…'` in the pure classifier).
7. **Separated non-literal upload sources** (`-T "$F"`, `-d @"$F"`) keep `network.call` while the embedded spelling (`--upload-file="$F"`) is `account.credential` (the #639 round 3 decision 1 asymmetry); whether an assignment earlier in the same command is tracked is unprobed.
8. **Conformance has no Hermes per-call-workdir shell vectors**, so the round-5 guarantee (relative upload sources judged as reads) lives only in `tests/cli-hook-hermes-home-organs.test.ts`; adding such vectors needs a `conformance/run.mjs` change.
9. **Docs**: `docs/claude-code-hook.md` (~:601) and `docs/cursor-hook.md` (~:304) could say that a credential or organ file named by a body flag takes its own class (optional).

Review note for whoever builds items 5 and 6: the symlink-then-`..` landing code in `src/cli/hook.ts` stopped three fresh automated readers (a safety classifier) during #639; the executed denial evidence is at `lanes-approval/evidence/HOME-ORGANS-r3-landing-confirm.tsv`. Plan the review of any change there as executed tests plus a differential, not a reader grade alone.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Items 1-3 and 7 closed in the pure classifier with vectors (httpie items extracted as sources; wget prefixes resolved; `~/.ssh` a credential path; the separated non-literal source judged like the embedded one), differential against main 0 looser
- [ ] #2 Item 4 decided (workspace `.env` a credential path or not) and the answer written into SPEC.md or docs with a vector either way
- [ ] #3 Item 5: the pure classifier and every hook adapter answer the same class for an absolute out-of-scope upload source, or the asymmetry is documented as intended per adapter
- [ ] #4 Item 6: `resolvedReadTarget` and `judgeSkillScript` resolve `..` through the kernel walk; executed denial tests plus a differential as the review record
- [ ] #5 Items 8-9: Hermes per-call-workdir shell vectors in conformance; the two docs sentences
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-10-13 09:10: filed by approval@edge from the #639 (APRV-511) rounds 3-5 reports; task file only, no code. Lead rulings 13 Oct 07:41Z, 08:09Z, 08:11Z (hard stop after round 5).
<!-- SECTION:NOTES:END -->
