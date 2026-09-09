# APRV-307 Trusted Publishing review bundle

This directory is a scratch proposal. It changes no repository workflow, GitHub
setting, npm setting, package version, tag, credential, or published package.
Both proposed workflow files are protected `policy.edit.ci` paths and require the
repository's normal approval and protected-path evidence before they can merge.

## Proposed trust boundary

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
requires Node 22.14.0 or newer and npm 11.5.1 or newer. It then runs the locked
install, full test suite, lint, typecheck, and conformance suite without OIDC.

After `npm pack`, the verifier checks the pack result's name, version, and
canonical filename. It reads `package/package.json` from the finished tarball and
checks its name, version, public status, and repository again. It records and
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
   The version must be a stable `X.Y.Z`; prereleases and dist-tags are outside
   this proposal.
2. Pause merges briefly and verify the local release commit equals current
   remote main.
3. Perform the separately gated annotated `vX.Y.Z` tag creation and tag push.
   The tag must point at current main and the package version must equal `X.Y.Z`.
4. Keep main fixed until the downstream publish workflow's tag/main binding step
   passes. Then observe the relay, verifier, artifact upload, environment
   admission, checksum verification, and npm publish jobs.
5. Read back the exact package version and repository from npm, inspect the npm
   provenance statement, install that exact version in a clean directory, and
   run the repository's release verification. A successful workflow alone does
   not prove the public package is usable.

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
release-evidence contract. This proposal adds no such mechanism and adds no
second GitHub reviewer.

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
