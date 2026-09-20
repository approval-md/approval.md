---
id: APRV-396
title: >-
  publish.yml creates the GitHub Release for every tag from the changelog
  section, so the Releases page carries the notes without a hand ceremony
status: In Progress
assignee:
  - '@opus-lane-396'
created_date: '2026-09-20 03:49'
updated_date: '2026-09-20 16:05'
labels:
  - release
  - ci
  - docs
dependencies: []
priority: medium
ordinal: 305000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Carter asked on 2026-09-20 where the 0.3.0 release notes are. They live in CHANGELOG.md (also inside the npm tarball), and the GitHub Releases page is empty for every version: neither 0.1.0, 0.2.0 nor 0.3.0 has a Release object, because publish.yml publishes to npm only. For 0.3.0 the Release is created by hand through the gate (this task first action, class release.publish, body = the 0.3.0 changelog section, --verify-tag). From the next tag on, publish.yml creates it: after the npm publish succeeds, extract the changelog section whose heading matches the tag version (refuse to create a Release when no section matches or the section is undated), create the Release with gh release create --verify-tag, title approval-md <version>, the section as the body, and attach the CI tarball and its sha256 as assets so the Releases page and the registry can be compared by hand. Idempotent: a Release that already exists is updated, never duplicated. Docs: docs/dogfood-cutover.md release section and the changelog convention note. Related: APRV-307 (Trusted Publishing), APRV-371, APRV-395 (site version guard), APRV-329.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The 0.3.0 Release exists on GitHub with the changelog section as its body, created through the gate, recorded in the notes with the grant and execution seqs
- [ ] #2 publish.yml creates or updates the Release for a tag after a successful publish, from the matching changelog section, with --verify-tag, the tarball and its sha256 attached; a tag with no matching dated section fails that step with a clear message and does not touch npm
- [x] #3 A workflow-level test or a dry-run script under scripts/ exercises the section extraction against CHANGELOG.md for 0.2.0 and 0.3.0; docs updated
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. scripts/release-notes.mjs, plain ESM with no dependencies, importable and runnable like scripts/agent-hours.mjs. Exports extractSection(text, version), listSections(text) and main(argv); refusals are machine-readable codes (no-section, undated-heading, empty-section, duplicate-section) rather than bare strings. The heading contract is exact: "## X.Y.Z" then an em dash then YYYY-MM-DD, canonical stable versions only, so Unreleased and a prerelease heading can never match a tag. Usage: node scripts/release-notes.mjs <version|vX.Y.Z> [--changelog <path>] [--out <path>] and --check to list the dated sections. Exit 0 on a match, 1 on a refusal, 2 on a usage error.
2. tests/release-notes.test.ts, importing the script module directly the way tests/agent-hours.test.ts does. Cases: the real CHANGELOG.md 0.2.0 and 0.3.0 sections (dates, body bounds, the next heading excluded), 0.4.0 refused as no-section, an undated fixture heading refused as undated-heading, a duplicate heading refused, Unreleased never matching, listSections over the real changelog, and the CLI exit codes and stderr text through spawnSync. A second half of the file asserts .github/workflows/publish.yml from its checked-in bytes under parseHardenedYaml, as tests/ci-guard.test.ts does for ci.yml: the notes check runs in the verify job ahead of the publish job, the release job needs both and holds contents write and nothing else, the create carries --verify-tag, and no secrets. spelling appears.
3. publish.yml, three changes. (a) In the verify job, right after the package identity step and before the locked install, run the script for the tag so a tag with no dated section fails the run before anything reaches npm; the step carries the script message. (b) A step immediately before npm pack that binds the release commit into the manifest (npm pkg set gitHead from RELEASE_SHA), and the existing packed-manifest check gains a gitHead assertion, so the packed bytes carry the commit or the release refuses. This changes the published metadata only, no source file. (c) A new release job, needs verify and publish, permissions contents write only and no OIDC: it checks out the pinned downstream SHA with no credentials, downloads the same npm-package artifact, re-verifies its SHA-256 against the verify job output, names the tarball approval-md-<version>.tgz beside a sha256sum file, runs the script for the body, then creates the Release with --verify-tag and the title approval-md <version> or edits the existing one and uploads the assets with --clobber, so a rerun updates and never duplicates. The token is github.token, not a secret reference, and the npm-package artifact keeps its one-file shape.
4. Docs: the CHANGELOG.md preamble states the heading convention and what reads it, docs/trusted-publishing-runbook.md gains the notes check, the gitHead bind and the release job in its step list and its audit boundary, docs/dogfood-cutover.md release section says the Releases page now fills itself and what the refusal looks like, and an Unreleased changelog entry.
5. Verify: build, typecheck, lint, the new test through run-tests --only release-notes, the script by hand against 0.3.0, 0.2.0, 0.4.0 and --check, then the full suite against the known SMTP baseline. The live half of AC2, the workflow actually creating a Release, cannot be proven until the next tag and the notes will say so.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
AC1 done 2026-09-20 ~04:0xZ through the gate: task.registered seq 59788, approval.requested 59789, approval.granted 59793 from the phone, executed under the token; gh release create v0.3.0 --verify-tag with the 360-line 0.3.0 CHANGELOG section as the body; https://github.com/approval-md/approval.md/releases/tag/v0.3.0.

Add to the workflow work: the publish job publishes a downloaded tarball with no repository beside it, so the registry gitHead is null for 0.2.0 and 0.3.0; set it from RELEASE_SHA before npm publish (npm pkg set gitHead=<sha> on the extracted package, or the equivalent), so the registry metadata carries the commit the provenance already binds.

AC2 and AC3, 2026-09-20, opus lane in worktree .claude/worktrees/aprv-396-release-notes on branch claude/aprv-396-publish-creates-release. Two commits: d5d961c (scripts/release-notes.mjs and tests/release-notes.test.ts) and 92bdb2e (CHANGELOG preamble, docs/trusted-publishing-runbook.md, docs/dogfood-cutover.md).

WHAT SHIPPED. scripts/release-notes.mjs is plain ESM with no dependencies, importable and runnable, in the shape of scripts/agent-hours.mjs. It extracts one version section from a changelog and refuses with a named code rather than a bare string: no-section, undated-heading, duplicate-section, empty-section, bad-version. The heading contract is exact, a canonical stable version then an em dash then an ISO calendar date, and the three ways a heading can nearly match are all refusals: an en dash, an impossible date, a trailing note such as (yanked). Unreleased carries no version so it can never match a tag, which is the property that mattered. Exit codes are 0 with a body, 1 for a refusal, 2 for a usage error, and a missing changelog file is a usage error rather than an empty release body. --check lists the dated sections and exits 1 when any version-shaped heading could not be released, so it is worth running before a tag.

DECISIONS worth knowing. (a) The refusal codes are separate because they mean different things to the person reading a failed run: undated-heading means the notes are still being written, no-section means the wrong tag. (b) The check runs in the verify job rather than only before the Release, because AC2 asks that a tag with no section never touch npm, and verify gates publish through needs. (c) The Release job takes a checkout of the pinned downstream commit and runs the extractor again rather than passing the body between jobs as an artifact or a job output: the npm-package artifact keeps its deliberate one-file shape (the runbook audit boundary depends on that), and the digest keeps travelling through the job-output channel. (d) The tarball attached to the Release is the same verified artifact, re-hashed against the verify job output before it is attached, renamed approval-md-X.Y.Z.tgz so it matches what npm pack of the registry version downloads, with a sha256sum-format file beside it so a reader can check it with sha256sum --check. (e) Idempotence is a view-then-branch: gh release edit plus gh release upload --clobber when a Release exists, gh release create --verify-tag when it does not. The concurrency group already serializes runs. (f) The token is github.token, not a secrets reference, so the workflow still mentions no secret anywhere and the test asserts that in both the parsed data and the raw bytes.

The manifest commit field, verified rather than assumed. npm sources on this machine (npm 11 under /opt/homebrew) settle the three links the task note left open: @npmcli/package-json normalize.js only fills gitHead when it is absent, so a value set on disk survives; pacote dir.js packs the file list with tar.c straight from the directory, so the on-disk package.json goes into the tarball verbatim; libnpmpublish patchManifest runs only the fixName step and buildMetadata stores the whole manifest as the version document, so a gitHead inside the tarball reaches the registry. Setting it in the verify job immediately before npm pack (not in the publish job) is what keeps the SHA-256 binding intact: the digest is computed after the pack, and the publish job still publishes the exact bytes the verifier hashed. This changes the published bytes metadata only; no source file in the package changes. The packed-manifest check asserts the field equals the release commit, so a future npm that dropped it would fail the release rather than pass unnoticed.

GLOBAL INVARIANTS. Nothing here reads or writes the log, mints a verb, or touches a gate-typed event. The refusals are machine-readable and distinct (SPEC 11 invariant on distinct refusals), and the release path fails closed at every ambiguity: a duplicate section refuses rather than picking one, an unparseable or absent changelog refuses, and a heading that nearly matches refuses.

WHAT IS NOT LANDED, and why. .github/workflows/ classifies policy.edit.ci, which is autonomy: manual in the attested policy (APPROVAL.md line 61: always a tap). The orchestrator brief assumed policy.edit and its one-in-ten live rate. Six hook waits of 540s each timed out with nobody awake to tap, across five distinct requests, so only the first hunk landed (the changelog check step in the verify job, present in the worktree and NOT committed, because staging that path is the same class). Two hunks remain unwritten: the manifest commit binding with its packed-manifest assertion, and the release job. Both are written out verbatim in the scratchpad at /private/tmp/claude-501/-Users-carter-dev-approval-md--claude-worktrees-open-source-licensing-658620/acd97477-1a12-4fc1-ade5-cd637812dfb1/scratchpad/, as make-candidate.mjs (the two replacements plus the job, with unique anchors) and release-job-candidate.yml (the same YAML as a standalone fragment). check-candidate.mjs in that directory parses the fragment with the repository parseHardenedYaml and re-runs every workflow assertion from the test against it: exit 0. Validating it that way caught two real bugs in the test, an array includes that needed a substring match and an empty permissions mapping compared against null.

Also blocked by the same class: gh release view v0.3.0 classifies release.publish, so this lane could not read back the Release AC1 created.

VERIFICATION. npm run build exit 0, npm run typecheck exit 0, npm run lint exit 0. node scripts/run-tests.mjs --only release-notes: 26 tests, 23 pass, 3 fail; the three failures are the assertions that read the two un-landed workflow hunks, and they are left failing on purpose (a green suite would mean the guard proves nothing). Full npm test: 5031 tests, 5004 pass, 26 fail, which is the known Node 26 SMTP and email baseline of 22 plus those 3, plus 1 email-adapter contract case in the same family. By hand against the real changelog: 0.3.0 prints its 357-line section and stops before the 0.2.0 heading, v0.2.0 prints its section, 0.4.0 exits 1 with no-section, Unreleased exits 1 with bad-version, --check prints the three dated versions and exits 0.

FOR THE HUMAN. AC2 is half proven: the refusal path and the shape are tested, and the live half (the workflow actually creating a Release) cannot be proven until the next tag, which is the first real check of gh release create --verify-tag in this environment and of whether npm carries the manifest commit field to the registry. One tap on policy.edit.ci lands the two pending hunks from the candidate files; after that the three failing tests pass and the branch is coherent. Worth knowing before the next release: if npm ever stops carrying that field, the packed-manifest assertion fails the run and the tag is spent, so the first release after this change is worth watching rather than launching and leaving.

Final numbers after a fourth commit (a fenced code block is no longer a section boundary, preventive: release notes quote shell and YAML, and a quoted line beginning with two hashes would have truncated a body silently; the 0.2.0 and 0.3.0 extractions are byte-identical before and after). Commits on claude/aprv-396-publish-creates-release: d5d961c the extractor and its tests, 92bdb2e the changelog convention and the docs, 4f64574 the plan and these notes, plus the fence commit. Verified at that head: build 0, typecheck 0, lint 0; run-tests --only release-notes 27 tests, 24 pass, 3 fail (the un-landed workflow assertions); full suite 5032 tests, 5006 pass, 25 fail, which is exactly the 22-failure Node 26 SMTP and email baseline plus those 3. The first full run of the session showed 26 failures; the extra one was a flaky SMTP timing case that did not recur.
<!-- SECTION:NOTES:END -->

## Comments

<!-- COMMENTS:BEGIN -->
author: @opus-lane-396
created: 2026-09-20 15:55
---
Handover, not done. AC3 is checked with evidence; AC2 stays open because two of its three workflow hunks could not be written: .github/workflows/ is policy.edit.ci, manual in the attested policy, and six 540s hook waits timed out with nobody awake to tap. The pending YAML is verified and waiting in the scratchpad paths named in the notes, and one tap lands it. Also uncommitted for the same reason: the changelog-check step that DID land in the worktree copy of the workflow, since staging that path classifies the same way. Reviewer needs to apply the two hunks, then the three deliberately failing tests in tests/release-notes.test.ts pass.
---
<!-- COMMENTS:END -->
