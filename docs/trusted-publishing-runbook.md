# Trusted Publishing release runbook (APRV-307)

This runbook describes `.github/workflows/release-candidate.yml` and
`.github/workflows/publish.yml` in this repository. Workflow implementation,
GitHub delivery, account configuration, and publication are separate steps.
Files present in a checkout do not establish that npm trust is configured or
that a package has been published. Both workflow files are protected
`policy.edit.ci` paths and require the repository's normal approval and
protected-path evidence before they can merge.

## Trust boundary

`release-candidate.yml` is an inert tag relay. Its committed form has empty
permissions, performs no checkout, uploads no artifact, calls no API, and runs
only the shell no-op `:`. The relay exists solely to produce a completed
`workflow_run` event with the candidate tag name and commit SHA.

`publish.yml` runs from the protected default branch through `workflow_run`.
Its verification job has `contents: read` and no OIDC permission. Before it
checks out repository bytes, it requires the downstream and upstream repository,
upstream workflow name and path, upstream `push` event, successful conclusion,
and first run attempt to match fixed values. It also validates a canonical stable
`vX.Y.Z` tag and a full lowercase upstream commit SHA.

After checkout, the verifier fetches only current `main` and the validated exact
tag. It requires all five identities to be the same commit:

1. the candidate tag peeled to a commit;
2. the upstream relay's `head_sha`;
3. the downstream `workflow_run` `GITHUB_SHA`;
4. the checked-out commit;
5. the freshly fetched current `origin/main`.

The equality is deliberately strict. If main advances before verification, the
release refuses. This keeps npm's automatic provenance truthful: the downstream
workflow runs at `refs/heads/main`, and the tarball is built from the exact commit
that provenance identifies.

The verifier requires package name `approval-md`, version equal to the tag,
repository `github:approval-md/approval.md`, and a non-private package. It also
requires Node 22.14.0 or newer and npm 11.5.1 or newer.

It then requires the release notes to exist, before the locked install and so
before anything that could publish: `node scripts/release-notes.mjs <tag>`
extracts the `CHANGELOG.md` section whose heading matches the tag's version and
refuses when there is no such section, when the heading carries no release date,
when two headings name the version, or when the section is empty (APRV-396). A
tag whose notes are not written therefore fails the release run with the
registry untouched. The heading contract is exactly `## X.Y.Z — YYYY-MM-DD`,
canonical version, em dash, ISO date; `## Unreleased` carries no version and can
never match a tag.

The verifier then runs the locked install, full test suite, lint, typecheck, and
conformance suite without OIDC.

Immediately before `npm pack`, and after the checks, the verifier binds the
release commit into the manifest it is about to pack: `npm pkg set
gitHead=$RELEASE_SHA`, validated as a full lowercase SHA first. The publish job
publishes a downloaded tarball with no repository beside it, so npm has no
repository to read a commit from and registry `gitHead` was `null` for 0.2.0 and
0.3.0. This is the one field the release adds to the published metadata; no
source file in the package changes.

After `npm pack`, the verifier checks the pack result's name, version, and
canonical filename. It reads `package/package.json` from the finished tarball and
checks its name, version, public status, and repository again, plus that
`gitHead` equals the release commit, so a field npm dropped would fail the
release rather than pass unnoticed. It records and
self-checks `release.tgz` with SHA-256, exposes that digest through the verify
job's output channel, then uploads only `release.tgz` as the fixed `npm-package`
artifact.

The publish job depends on that verifier in the same downstream workflow run. It
has environment `npm` and only `id-token: write`; it has no checkout and no
repository permission. Its only external actions are the pinned official Node
setup and artifact download actions. It downloads the current run's fixed
artifact, compares its SHA-256 with the independent verify-job output, and
invokes exactly:

```text
npm publish ./release/release.tgz --access public --ignore-scripts
```

A third job creates the GitHub Release, and only after the publish job succeeds
(APRV-396). It needs both earlier jobs, holds `contents: write` and no OIDC, and
authenticates with the run's own `github.token`; no secret is referenced anywhere
in the workflow. It checks out the pinned downstream commit with
`persist-credentials: false`, downloads the same fixed `npm-package` artifact,
re-verifies its SHA-256 against the verify job's independent output, copies it to
`approval-md-X.Y.Z.tgz` and writes a `sha256sum` file beside it, and extracts the
changelog section again from the checked-out bytes. Then either

```text
gh release create <tag> --verify-tag --title "approval-md X.Y.Z" --notes-file <body> <assets>
```

when no Release exists for the tag, or `gh release edit` plus
`gh release upload --clobber` when one does, so a rerun updates the single
Release and never duplicates it. `--verify-tag` refuses to invent a Release for a
tag the remote does not have. The artifact keeps its one-file shape: the
checksum attached to the Release is written from the verified bytes at release
time, and the digest still travels between jobs through the job-output channel
rather than beside the artifact.

Fixed concurrency group `npm-publish` serializes release attempts and never
cancels a run in progress. A relay rerun is rejected because its upstream
`run_attempt` is no longer 1.

## Human configuration order

Complete these account changes manually. Do not enable npm trust until every
GitHub prerequisite below is visibly active.

1. In GitHub, create environment `npm` before any workflow can reference and
   auto-create it. Configure deployment branches and tags as selected refs, add
   branch `main` only, and add zero tag patterns. Add no environment secrets or
   variables. Leave required reviewers empty for the one-trigger ceremony.
2. Create an active tag ruleset targeting `v*`. Enable **Restrict updates** and
   **Restrict deletions**, with no bypass actor. Leave **Restrict creations** off
   so a separately authorized release tag can be created once. This makes each
   created release tag immutable through ordinary GitHub ref operations.
3. Merge the two reviewed workflow files to protected main through the normal
   approval.md and protected-path process. Confirm the default branch contains
   the exact reviewed bytes.
4. Re-open the `npm` environment and tag ruleset in GitHub settings. Confirm
   `main` is the sole admitted branch, no tags are admitted by the environment,
   the tag ruleset is active, and neither setting gained a bypass, secret, or
   variable.
5. Only then configure npm Trusted Publishing for package `approval-md`:
   provider GitHub Actions, organization `approval-md`, repository `approval.md`,
   workflow filename `publish.yml`, environment `npm`, and direct
   `npm publish` enabled. The workflow filename is the filename only.
6. Confirm through the human account UI that no GitHub repository, organization,
   or `npm` environment secret supplies `NPM_TOKEN` or `NODE_AUTH_TOKEN`, and
   retire the old bypass-2FA publication token. Do not expose token values while
   checking their absence.

The environment must be protected before npm trust exists. Otherwise a
tag-controlled workflow could reference a missing `npm` environment, cause
GitHub to create it without protection, and present the environment name npm is
configured to trust.

## Release ceremony

Publishing remains a manual `release.publish` operation governed by
`APPROVAL.md`. The workflows do not grant permission to version, tag, push, or
publish.

1. Land the separately reviewed version and release notes on protected `main`.
   The version must be a stable `X.Y.Z`; prereleases and custom dist-tags are
   outside this release ceremony.
2. Pause merges briefly and verify the local release commit equals current
   remote main.
3. Perform the separately gated annotated `vX.Y.Z` tag creation and tag push.
   The tag must point at current main and the package version must equal `X.Y.Z`.
4. Keep main fixed until the downstream publish workflow's tag/main binding step
   passes. Then observe the relay, verifier, artifact upload, environment
   admission, checksum verification, npm publish, and Release jobs.
5. Read back the exact package version and repository from npm, inspect the npm
   provenance statement, install that exact version in a clean directory, and
   run the repository's release verification. A successful workflow alone does
   not prove the public package is usable.
6. Read the created Release: title `approval-md X.Y.Z`, body equal to the
   changelog section, two assets, and the attached `sha256` equal to the digest
   the verify job bound. `npm view approval-md@X.Y.Z gitHead` should print the
   release commit.

If the immutable tag fails the identity checks, do not move or delete it. Choose
a new version and repeat the reviewed release process. A downstream workflow
rerun may recover a transient failure only while current main still equals the
immutable release commit. The relay itself must not be rerun.

## Audit limits

The protected `workflow_run` design proves that the npm-trusted job definition
came from protected main and that the published tarball came from the exact main
commit named by npm provenance. The digest passed through the job-output channel
detects artifact changes between the verify and publish jobs in that downstream
run; it is not stored beside the artifact as a replaceable checksum pair.

It does not prove that a GitHub tag creator passed approval.md's local gate. A
principal allowed to create a new `v*` tag can trigger a release at a
version-matching current-main commit. Enforcing a hash-chained approval record at
GitHub would require a separate server-side deployment protection or committed
release-evidence contract. These workflows add no such mechanism and add no
second GitHub reviewer.

The Release job introduces the workflow's first repository write permission.
`contents: write` is what creating a Release requires, and the same scope can
write other repository contents where branch protection does not stop it. It is
confined to a job with no OIDC and no npm authority, running after the publish,
with a job-scoped `github.token` that expires with the run; its only commands are
`gh release view`, `create`, `edit` and `upload` against the tag under release.
The Release body and assets are public metadata and carry no npm authority: a
Release that is wrong is corrected by editing it, and it cannot alter the
published bytes.

Repository and organization administrators can change rulesets, environments,
workflow protections, and npm trust. GitHub-hosted runner images, Node 24 minor
versions, npm versions, and the npm registry remain external dependencies. The
workflow checks minimum tool versions and pins action source commits, but it does
not make those services part of approval.md's hash chain.

The relay workflow at an untrusted tag may contain different bytes. It gains no
npm authority because npm trusts `publish.yml` with environment `npm`, and that
environment admits branch `main` only. The downstream publisher still rejects
the relay unless its path, event, repository, first attempt, tag, and commit all
match the protected-main contract.

## Reviewed action pins and sources

The following official GitHub tag refs were resolved read-only on 2026-09-09.
The annotated checkout tag was peeled to its underlying commit.

| Action | Official tag | Pinned commit |
|---|---|---|
| `actions/checkout` | `v6.0.3` | `df4cb1c069e1874edd31b4311f1884172cec0e10` |
| `actions/setup-node` | `v6.5.0` | `249970729cb0ef3589644e2896645e5dc5ba9c38` |
| `actions/upload-artifact` | `v7.0.1` | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` |
| `actions/download-artifact` | `v8.0.1` | `3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c` |

Primary references:

- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
- [GitHub workflow_run trigger](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)
- [GitHub ruleset rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
- [GitHub deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
