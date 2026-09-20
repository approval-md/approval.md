---
id: APRV-371
title: >-
  Release 0.3.0: changelog, version bump, gated tag and tag push through Trusted
  Publishing
status: In Progress
assignee:
  - '@claude'
created_date: '2026-09-18 06:34'
updated_date: '2026-09-20 02:43'
labels:
  - release
dependencies:
  - APRV-307
priority: medium
ordinal: 288000
approval:
  origin:
    app: manual
    created_by: 'agent:claude-code'
  route:
    assignee: 'agent:claude-code'
    rationale: 'the 0.3.0 release ceremony, 2026-09-20: the agent creates the annotated tag on the bump merge commit and pushes it under two grants; publish.yml publishes through Trusted Publishing on the pushed tag (APRV-307); the human decides each step on the phone (APRV-371 AC2)'
  state: proposed
  actions:
    - class: release.publish
      summary: 'git tag -a v0.3.0 -m "approval-md 0.3.0" f4ebc90c698c7e8d410b184cda73de228d46ec43 in /Users/carter/dev/approval-md: an annotated tag on the merge commit of PR 507, local only, nothing published (payload is the argv and cwd; run recomputes the hash before it spawns)'
      reversible: true
      est_cost_usd: '0'
      idempotency_key: 'aprv-371:tag:2026-09-20'
      payload_hash: 'a0d66a0f5b438ba29304012cf50823ec1c40beb531aa0e7769620a78e95871ea'
    - class: release.publish
      summary: 'git push origin v0.3.0 from /Users/carter/dev/approval-md: pushes the tag, which triggers release-candidate.yml and then publish.yml, publishing approval-md@0.3.0 to npm with provenance; the v* ruleset is immutable, a mistake is repaired by a new patch version (payload is the argv and cwd)'
      reversible: false
      est_cost_usd: '0'
      idempotency_key: 'aprv-371:tag-push:2026-09-20'
      payload_hash: '48e10af9c5de29de033c4aa25df002220072633fe1eef6c1c47e26d1013fb34a'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Since v0.2.0 (published 2026-09-12, APRV-329) main carries 183 commits and 35 feat or fix entries: approval policy apply (APRV-343) and amend --pr (341), attested-policy-on-main doctor row (342), human sign-off records (338), read.file.out_of_scope with read-tool gating and the Seatbelt read profile (347), vcs.ref.delete (352), harness.launch.NAME (354), the Grok Build adapter (243) and the Muse Code adapter (350), the Codex workspace broker and confined session (325.2, 325.3), Codex native hook hardening (311), sender identity on the Telegram channel (324), approval up reconciling an extended working log (346), the values block 0.2 format (336) and the deprecation of the bare supervised alias (335). All additive; the deprecation still loads with a warning, so this is a minor bump. Ceremony as for 0.2.0: one PR carrying the CHANGELOG 0.3.0 section (written from the diffs, not from commit titles) and the package.json bump, merged; then the gated annotated tag v0.3.0 and the gated tag push (release.publish), which triggers the protected-main Trusted Publishing workflow; then registry bytes, installed behaviour and provenance verified as APRV-329 did. Before the tag push the operator confirms no NPM_TOKEN secret exists (APRV-307 AC1, runbook 2026-09-16 step 4). The tag and the push are the operator decisions; an agent prepares the PR and the verification.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 CHANGELOG.md has a 0.3.0 section that names every user-visible change since v0.2.0 with its task id, and package.json reads 0.3.0, merged to main in one PR
- [ ] #2 Annotated tag v0.3.0 created and pushed through the gate; publish.yml publishes approval-md@0.3.0 with npm provenance and no NPM_TOKEN
- [ ] #3 Registry tarball matches the CI artifact, a clean install runs approval --version and approval doctor, provenance verified; results recorded in the notes and the changelog dated
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Wait for PR #504 (the 0.3.0 changelog draft) and PR #505 (the policy amendment) to merge, then branch lane/release-0-3-0-371 from the refreshed origin/main.
2. One commit, nothing else in it: package.json version 0.2.0 to 0.3.0; package-lock.json's two package version fields (top level and the root empty-name package) to 0.3.0; the CHANGELOG Unreleased 0.3.0 heading becomes the dated 0.3.0 heading in the 0.2.0 shape (2026-09-20), and the section's anchor sentence is re-pointed at the tip the branch is cut from, with the non-merge commit count since v0.2.0 recomputed there. Plus the strings the suite binds to package.json version, which cannot be left behind: wordmark VERSION, daemon APPROVALD_VERSION, and the four site strings the APRV-332 site-version-guard checks.
3. Verify: npm ci, npm run build, npm run typecheck, npm run lint, npm test, plus the packaging suites that read node_modules. Record actual exit codes, not summary banners. Local SMTP failures under Node v26 are pre-existing; CI on Node 22 is the truth, and the PR body says so.
4. Push, open the PR against main, merge origin/main and rebuild before arming, arm with a plain merge command, confirm the queue by GraphQL.
5. Tick AC1 only. Record in the notes the exact tag ceremony the orchestrator runs from the primary checkout (envelope shape, class release.publish, annotated tag v0.3.0 on this PR's merge commit, then the tag push) and the AC3 verification checklist to run once publish.yml finishes. AC2 and AC3 stay unticked: the tag, the push and the publication are the operator's.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
AC1 draft only, for review. CHANGELOG.md gains an Unreleased 0.3.0 section on branch lane/changelog-0-3-0-371, grouped into gate and guard, harnesses and the Codex bridge, channels and identity, daemon and records, policy and setup, demos and docs, and breaking and behavior changes. Every line names its task id and, where a verb changed, the verb. package.json is NOT bumped and the section is NOT dated: both wait on Carter and on the tag. Sources of truth were the 185 non-merge commits since v0.2.0, the merged pull request titles since 2026-09-12, and the Done task list, with each claim checked against the diff. Two corrections to the brief's figures, taken from the files: schema-validation vectors are at 2.5.0 rather than 2.4.0, and hook-read-scope 1.2.0 is a third new suite alongside command-class and bridge-decisions. One user-visible change carries no task id, the judgy demo pages, and it is listed as such.

AC1 closed 2026-09-20 on lane/release-0-3-0-371, PR #507, branched from main at 36018dc.

One commit (611a197), 8 files, 13 insertions, 13 deletions: package.json 0.2.0 to 0.3.0; package-lock.json's two package version fields (top level and the root empty-name package), with no dependency moved; the CHANGELOG Unreleased 0.3.0 heading dated as the 0.3.0 heading in the 0.2.0 shape, its anchor sentence re-pointed at 36018dc and the non-merge commit count since v0.2.0 recomputed there (192); and the version strings the suite binds to package.json, which a bump cannot leave behind: VERSION in src/cli/wordmark.ts, APPROVALD_VERSION in src/daemon/git-evidence.ts, and the four strings the APRV-332 site version guard checks (the #pkg-version note and the JSON-LD softwareVersion in index.html, the JSON-LD softwareVersion in features/index.html, and the two llms.txt lines). APRV-329 hit the same two source constants on the 0.2.0 bump, before the site guard existed. Nothing else is in the commit.

Verification on this machine, Node v26.8.2, actual exit codes: npm ci 0, npm run build 0, npm run typecheck 0, npm run lint 0, npm test 1 (4858 tests, 4835 passed, 22 failed, 1 skipped, 397.5s), the two packaging suites that read node_modules 0 (package-adapters and codex-package, 11 tests, 11 passed, run after npm ci because they are phantom failures in a worktree that never installed). All 22 failures are the SMTP family (adapter-email, smtp-probe, and the four setup adapter email cases in cli-setup) and they are pre-existing on Node v26: the same run on origin/main at 027f2d2 before any edit gave the identical 4858/4835/22/1 and, test name for test name, the same 22. CI on Node 22 is the truth here.

Left open deliberately, for whoever writes the next release-notes pass: features/index.html still says Feature index for approval-md 0.2.0 in its footer and carries version 0.2.0 in its #feature-index JSON, and llms-full.txt still says v0.2.0 and Feature index: approval-md 0.2.0. The site version guard binds four strings and not those four, so they were outside this commit's brief; they go stale the moment the bump merges.

AC2 and AC3 stay unticked. The tag, the tag push and the publication are the operator's, and every gate verb runs from the primary checkout (/Users/carter/dev/approval-md). No lane session creates or pushes a tag.

THE TAG CEREMONY (AC2), run by the orchestrator from the primary checkout after PR #507 merges. Every verb below is a gate verb and belongs to the orchestrator, never to a lane.

0. Preconditions. approval log sync brings the primary current; confirm HEAD equals PR #507's merge commit and the working tree is clean. approval doctor clean, in particular the attested-policy-on-main row. APRV-307 AC1 reconfirmed: no NPM_TOKEN at repository, organization or environment level. Main stays fixed until the publish workflow's identity binding passes.

1. The envelope, written into this task file's YAML frontmatter under the approval key. The Backlog CLI strips an approval envelope from a task file (recorded on APRV-199, re-proved with CLI 1.49.3 on APRV-307), so it goes in by hand as APRV-199's and APRV-306's did, and any later CLI edit of this task has to be checked for it.

   approval:
     origin:
       app: manual
       created_by: 'agent:fable'
     route:
       assignee: 'agent:fable'
       rationale: 'the 0.3.0 release ceremony (APRV-371 AC2): the orchestrator prepares, requests and executes on a grant; Carter decides go or no-go on the phone'
     state: proposed
     actions:
       - class: release.publish
         summary: 'annotated tag v0.3.0 on <merge-commit> in /Users/carter/dev/approval-md (payload is the argv and cwd; run recomputes the hash before it spawns)'
         reversible: true
         est_cost_usd: '0'
         idempotency_key: 'aprv-371:tag:2026-09-20'
         payload_hash: '<64 hex>'
       - class: release.publish
         summary: 'push of v0.3.0 to origin from /Users/carter/dev/approval-md (a tag push classifies release.publish since APRV-305; declared here as well)'
         reversible: false
         est_cost_usd: '0'
         idempotency_key: 'aprv-371:tag-push:2026-09-20'
         payload_hash: '<64 hex>'

2. The two payload hashes. approval run binds the object argv plus cwd and hashes it as SHA-256 over its RFC 8785 canonical form (src/core/payload.ts, runPayloadHash); approval payload hash <file> prints that value. Write these two files and hash each one:

     {"argv":["git","tag","-a","v0.3.0","-m","approval-md 0.3.0","<merge-commit>"],"cwd":"/Users/carter/dev/approval-md"}
     {"argv":["git","push","origin","v0.3.0"],"cwd":"/Users/carter/dev/approval-md"}

   argv is the child argv exactly as it will be spawned, and the annotation is one argv word. run recomputes the hash and refuses payload-mismatch before the child exists if one byte differs, so these two files are the contract, not a description of it.

   The 0.2.0 ceremony (APRV-329) used a scratch helper that is not in this repository, and its recorded payloads in .approval/payloads carry extra fields (operation, tag, commit, helper_sha256). Its argv is worth copying for the push, because it binds the tag object rather than a name: the create was tag --annotate --no-sign --cleanup=verbatim v0.2.0 <commit> --message <annotation>, and the push was push origin <tag-object-sha>:refs/tags/v0.2.0 under -c push.followTags=false. Both spellings classify release.publish; the plain APRV-199 forms above are the ones approval run can bind with no helper.

3. Classification, which the envelope declaration only doubles. src/core/command-class.ts sends every tag subcommand to release.publish (rule git-tag) and sends a refs/tags/ refspec, a bare v-prefixed semver refspec, --tags and --follow-tags to release.publish (rule git-push-tag, APRV-305). release.publish is manual in APPROVAL.md, so each action reaches the phone. The action key is the idempotency_key itself: src/core/gate.ts matches the request on that string.

4. The run, from /Users/carter/dev/approval-md. Each run line ends with a bare double dash and then the argv array of the matching payload file in step 2, word for word. (This note is written from a worktree-isolated lane whose harness refuses to carry a literal double dash followed by a version-control invocation, so step 2 is the authority for those two argv lines.)

approval register "backlog/tasks/aprv-371 - Release-0.3.0-changelog-version-bump-gated-tag-and-tag-push-through-Trusted-Publishing.md" --as agent:fable
     approval request APRV-371 --action aprv-371:tag:2026-09-20 --as agent:fable
     approval wait APRV-371 --timeout 30m
     approval run aprv-371:tag:2026-09-20 --as agent:fable -- <the seven argv words of the tag payload>
     approval request APRV-371 --action aprv-371:tag-push:2026-09-20 --as agent:fable
     approval wait APRV-371 --timeout 30m
     approval run aprv-371:tag-push:2026-09-20 --as agent:fable -- <the four argv words of the tag-push payload>

Record the grant and execution seqs here, as APRV-199 recorded its four. Do not move or delete the tag if anything downstream fails: the v* ruleset is immutable with no bypass actors, so a spent tag is spent and the repair is a new patch version.

5. What the push starts. release-candidate.yml relays on the pushed v* tag with empty permissions and no checkout; its successful first-attempt completion triggers publish.yml on protected main through workflow_run. The verify job binds tag, upstream event, downstream workflow, checkout and freshly fetched main to one commit, runs the full checks without OIDC, packs once, and binds the tarball SHA-256 as the release_sha256 job output beside the npm-package artifact. Only the npm environment-bound publish job holds id-token write; it re-hashes release.tgz, compares it against that output, and runs npm publish ./release/release.tgz --access public --ignore-scripts.

AC3 CHECKLIST, to run once publish.yml finishes. All of it is read-only, and it suits a Sonnet verification pass handed this list, with the results pasted back into these notes.

a. The runs. gh run list --workflow=release-candidate.yml --limit 3 and gh run list --workflow=publish.yml --limit 3. Record both run ids; confirm conclusion success and attempt 1 on each, that the publish run head is main, and that its triggering run is the relay.
b. Registry bytes against the CI artifact. Read release_sha256 from the verify job SHA-256 binding step in the publish run log. Then in a scratch directory: npm pack approval-md@0.3.0, then shasum -a 256 on the downloaded approval-md-0.3.0.tgz. The two values must be equal; APRV-329 recorded the 0.2.0 pair the same way (423ea865ee8c5f46a9e58302e5927448046a4fc3f8442dd02caf01a1eb885a60).
c. Registry metadata. npm view approval-md@0.3.0 version dist.integrity dist.shasum dist.tarball. dist.integrity is the sha512 over the same bytes and must agree with the packed tarball.
d. Clean install. In a fresh scratch directory: npm install -g approval-md@0.3.0 under a scratch prefix so nothing on the machine is replaced, then approval --version must print 0.3.0 and approval doctor must run. Record both exit codes, and record whether better-sqlite3 arrived prebuilt or was built from source.
e. Provenance. npm audit signatures in that consumer: exit 0, with the verified signature and attestation counts. Parse the signed SLSA provenance and confirm it binds this tarball digest, PR #507 merge commit, publish.yml on main, and that run id and attempt 1. If npm audit signatures cannot run there, read dist.attestations from the registry and fetch the attestation instead.
f. Record. Paste the run ids, both SHA-256 values, dist.integrity, the install and doctor exit codes and the provenance result here, and give the CHANGELOG 0.3.0 section the published sentence the 0.2.0 section carries (published to npm as approval-md@0.3.0, tagged v0.3.0 at the merge commit), replacing the draft not-yet-tagged sentence. Then tick AC2 and AC3.
<!-- SECTION:NOTES:END -->
