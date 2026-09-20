---
id: APRV-397
title: >-
  Classifier rules for the read-only packaging and archive tools a release
  verification uses: npm pack, npm init, npm --version, tar (list and extract
  into a scratch dir), gunzip, base64, openssl dgst, shasum; and git tag -l is a
  read, never release.publish
status: In Progress
assignee:
  - '@opus-lane-397'
created_date: '2026-09-20 04:41'
updated_date: '2026-09-20 11:42'
labels:
  - classifier
  - hook
  - release
dependencies: []
priority: medium
ordinal: 306000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found on 2026-09-20 during the APRV-371 AC3 verification pass and the tag ceremony. (1) A Sonnet verifier could not run npm pack, npm init, bare npm --version, tar (list or extract), gunzip, base64 or openssl dgst: all came back hook-unclassified and were refused, so it fetched the tarball with curl and parsed it with node scripts. These are the tools any release verification or packaging check uses; each is read-only or writes only into a directory it names, so they belong in src/core/command-class.ts with the same scoping the read.* and files.write.workspace rules apply (tar extraction is a write into its destination path; refuse when the destination is outside the workspace or scratch). (2) The orchestrator ran git tag -l in a state check and the git-tag rule (APRV-305) sent it to release.publish, a manual class, which put a nine-minute question on Carter phone for a listing; git tag with -l, --list, -n or no arguments is a read and must classify read.repo (or whatever the read class for git metadata is), while -a, -d, -f, -s and a bare tag name stay release.publish. Add conformance vectors for both groups in command-class.v1.json with the version bump the suite requires. Related: APRV-305, APRV-380 (the login-shell unwrap set the pattern for pinning classifier changes in vectors), APRV-371.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 npm pack, npm init, npm --version, tar list and tar extract into a named scratch path, gunzip, base64, openssl dgst and shasum classify as reads or workspace writes with the scoping stated, pinned by conformance vectors; tar extract to a path outside the workspace or scratch is refused
- [x] #2 git tag -l, --list, -n and bare git tag classify as a read; git tag -a, -d, -f, -s and git tag <name> stay release.publish; pinned by vectors and a hook test
- [x] #3 docs/claude-code-hook.md and docs/cli-reference.md classifier section list the new rules; build, typecheck, lint, hook and conformance suites pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Reuse existing notions, invent none. The out-of-scope destination arithmetic already lives in refineRm: a target strictly under a caller-resolved scratch root loosens, an absolute path anywhere else, a parent segment, or a value the text cannot read is out of scope. Hoist it into one shared helper and answer an out-of-scope packaging write with files.delete.out_of_scope, the class this table already uses for a destructive file operation whose destination the text puts outside the workspace and the one the reference policy already holds at manual. A brand new class name would resolve by defaults.autonomy in every deployment, which is the widening direction, so no new class is minted and CLASSIFIER_CLASSES does not move.
2. New rows in the table: npm pack (workspace write scoped by the pack-destination value, network.call when a positional names a registry spec rather than a local path), npm init (workspace write, with its own rule id when an initializer package is named so the sandbox list can see it), a probe-only row so bare version and help flags on the four package managers read instead of falling to no-rule, tar (list is a read, extract is a write into the directory flag or the working directory, create is a write of the archive the file flag names, a mode the text cannot read is opaque), gunzip (a read only for the stdout and test forms, a workspace write of the named path otherwise), base64 (a read of its named files, a write when an output flag names one), and the digest subcommands of openssl only (a read, a write when an out flag names one). shasum and sha256sum are already in the read row and need vectors only.
3. matchRule gains the argv so a row may declare itself probe-only; everything the probe row does not match keeps the unclassified deny it has today.
4. The tag verb of the version control CLI gains a refinement shaped like the branch one: an allowlist of listing flags plus the ones that consume a value, so the listing forms and a bare invocation answer read.shell, while any flag the allowlist does not name and any remaining positional stay release.publish. Fail closed by allowlist, not by denylist.
5. core/read-scope.ts gains tar, gunzip, base64 and openssl in its target-shape table so the read-side path scoping applies to the new readers through the same code as every other reader.
6. Vectors authored in scripts/regen-conformance-vectors.mjs, both directions for every new rule (the read spelling and the write or refused spelling), then regenerated; the command-class suite goes to 1.4.0, a minor bump, since no existing expectation in that file moves.
7. Unit fixtures in tests/command-class.test.ts, including the scratch-root branch which the pure vectors cannot express, a hook classify test for the tag listing forms in tests/cli-hook.test.ts, rows in the docs/claude-code-hook.md rule table and the docs/cli-reference.md classifier section.
8. Verify: build, typecheck, lint, the focused suites, the conformance run against the regenerated manifest, then a full test compared against the known baseline.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
WHAT SHIPPED, in two commits on this branch. Seven new rows in the classifier table (the version probe, pack, init, tar, gunzip, base64 and the openssl digests), one row split (the tag verb of the version control CLI), four new readers in the read-scope target table, thirty-three conformance vectors at command-class 1.4.0, and rule-table rows plus a new documentation section in four files.

THE ONE RULE ALL SEVEN ROWS SHARE. Each of these commands either reads what it names or writes into a destination it names, and the destination is in the command text. So a single helper decides them, and it is refineRm's arithmetic hoisted rather than a second notion invented: a destination strictly under a scratch root the CALLER resolved is the agent's own space, a relative destination or none at all is the workspace, and an absolute path anywhere else, a parent segment, an unreadable value, or a destination flag with nothing readable after it is out of scope with the destination bound for the approver.

THE CLASS CHOICE, which is the only decision in this task capable of loosening anything, and the reason it went the way it did. An out-of-scope packaging destination answers files.delete.out_of_scope, which rm and find -delete already answer for a destructive file operation the text places outside the workspace. Minting files.write.out_of_scope instead would have been a widening in disguise: SPEC section 7 resolves a class no policy names by defaults.autonomy, so a brand-new name arrives AUTONOMOUS in every deployment whose defaults are permissive, while the existing class is held at manual by the reference policy and by this repository's. CLASSIFIER_CLASSES is therefore unchanged by this task, which is the mechanical form of the same statement. The name also describes the act: unpacking an archive over a directory overwrites whatever it finds there.

THE STRICTNESS THIS INHERITS, stated because it is stricter than the acceptance criterion asked for. An ABSOLUTE destination is out of scope even when it happens to sit inside the checkout, because the classifier holds no workspace root and the read roots it does hold are a read notion that must not become a write authorization. That is exactly what rm has answered since APRV-267, and matching it was the instruction.

THE TAG SPLIT IS AN ALLOWLIST, not a denylist, and that direction is the whole safety argument. The listing flags are enumerated (the short and long list flags, the annotation-line flag in both the bare and numbered spellings, contains, no-contains, points-at, merged, no-merged, sort, format, color, ignore-case, omit-empty) along with the ones that consume a value, and a flag this rule has never heard of is a creation. So a future option of that verb cannot arrive as a read by default. A positional is a tag NAME, which creates one, unless the list flag is present and makes it a pattern. The shape mirrors the branch verb's refinement, which has split read and write halves of one verb since APRV-82. Everything APRV-305 priced as a release is unmoved: annotate, delete, force, sign, message and a bare name.

A NEW FIELD ON THE RULE SHAPE, for the one thing subcommand matching cannot express. A bare version probe carries no positional, so no subs row can ever match it, and a row with no subs at all would have matched every subcommand the table does not name and turned a wall of unclassified denials into whatever class that row declared. CommandRule.probe matches an argv that is nothing but version or help flags and nothing else, so npm doctor and npm cache clean keep the refusal they had. matchRule now takes the argv for that one purpose.

FAIL CLOSED WHERE THE TEXT RUNS OUT. A tar whose MODE is not in its words is opaque, which is the honest code for a command whose effect is not in its words. A bundle carrying both value-taking letters is refused, because which following word feeds which letter is tar's own option order. An unreadable pack spec is treated as a registry spec, so the network reading wins. gunzip -k is a write, not a read: it spares the input and still creates the output. And the openssl row names the digest subcommands rather than the binary, so enc, genrsa, req, rand and s_client are as unclassified as they were.

WHAT I FOLLOWED THE BRIEF ON RATHER THAN MY OWN READING. gunzip -l lists an archive's contents and is a read in fact, but the brief enumerated only the stdout and test forms as reads, so -l takes the workspace-write branch. Over-strict in the safe direction (it is autonomous for a relative path either way, so it costs nobody a prompt) and a one-line change if a human wants it moved.

INVARIANTS TOUCHED, SPEC section 11.1, named as the repository rules require.

Invariant 4, self-reported fields never reduce scrutiny. The destination values these rules read are words the harness sent, which is the same standing every other argument in this table has; nothing outside the command text is read, no description field is consulted, and every unreadable value resolves to the stricter branch. The one place a value chooses the LOOSER branch is a relative or scratch-rooted destination, and that is the pre-existing property of the workspace-write row rather than something added here: see the limitation below.

Fail closed (the CLAUDE.md engineering invariant, SPEC section 11.1 throughout). Four refusals were preserved on purpose where a wider row would have been easier: a tar with no readable mode, a bundle whose value letters collide, every openssl subcommand that is not a digest, and every package-manager subcommand the table does not name. Each of those still denies.

Invariant 9, human-only classes are inert to agents, and the verb-minting clause. No class is minted at all. Every class these rows can return already existed in the table and in the reference policy.

Invariant 6, refusals are machine-readable and distinct. No refusal code is added or moved. A tar with an unreadable mode uses the existing opaque code, with a detail that names the missing mode rather than describing a shell.

A LIMITATION I DID NOT CLOSE, and it is filed rather than hidden. There is no disk pass for a WRITE destination. Deletes and reads each have one in the hook (a nearest-existing-ancestor walk that follows symlinks and tightens), and writes are answered from the text alone, here and in the workspace-write row above. So a relative destination, and an absolute one under a resolved scratch root, classify as the workspace write the text describes even when a symlink on the path leaves the roots. For the relative case that is byte-identical to what cp, mv, tee and mkdir have always answered, and before this task every one of these commands was denied as unclassified, so nothing that was refused became allowed by a symlink. The scratch-rooted case is sharper, because the delete rule explicitly closed it with its second pass and the write path has no equivalent. ROUTINE CALL MADE IN THE HUMAN'S ABSENCE: I filed APRV-402 (To Do) with the measurement first, since resolving a destination on every workspace write is the per-call cost APRV-188, APRV-212 and APRV-217 are about, and left the limit stated in the new documentation section rather than implied away. Delete the task if the orchestrator would rather have it inside this one.

A SPEC WORDING QUESTION FOR A HUMAN, raised and not acted on, because the repository rule is that divergence is called out and never silently written into SPEC. Section 7 introduces files.delete.out_of_scope with the parenthetical 'destructive deletes outside the task's stated scope, inside the workspace'. This task makes the classifier answer that class for a packaging WRITE whose destination the text puts outside the workspace, on the reasoning above. Nothing in the normative text forbids it and the class's gravity is unchanged, so no behaviour diverges from the specification; what is now slightly narrow is the parenthetical. The amendment, if a human wants one, is one sentence in section 7 saying that the class also covers a write that overwrites outside the workspace, with the reason (a new sibling class would resolve by defaults.autonomy wherever a policy is silent). I did not write it: SPEC edits classify policy.edit.spec and this one is a judgement about the taxonomy's vocabulary rather than a fix.

EVIDENCE, part one: the tag verb through the classify verb of the built CLI (class, then rule).

git tag                         read.shell               git-tag-read
git tag -l                      read.shell               git-tag-read
git tag --list 'v0.*'           read.shell               git-tag-read
git tag -n                      read.shell               git-tag-read
git tag -n5                     read.shell               git-tag-read
git tag --contains HEAD         read.shell               git-tag-read
git tag --points-at HEAD        read.shell               git-tag-read
git tag --sort=-v:refname       read.shell               git-tag-read
git tag v0.1.0                  release.publish          git-tag
git tag -a v0.1.0 -m release    release.publish          git-tag
git tag -d v0.1.0               release.publish          git-tag
git tag -f v0.1.0               release.publish          git-tag
git tag -s v0.1.0               release.publish          git-tag
git tag -m note v0.1.0          release.publish          git-tag

EVIDENCE, part two: the packaging and archive commands through the same verb (class, then rule, then the bound destination where one is bound). Produced by running the built CLI hook classify verb once per command from this worktree.

npm pack                                               files.write.workspace      npm-pack
npm pack --pack-destination build/tarballs             files.write.workspace      npm-pack
npm pack --pack-destination /usr/local/lib             files.delete.out_of_scope  packaging-write-out-of-scope [/usr/local/lib]
npm pack --pack-destination                            files.delete.out_of_scope  packaging-write-out-of-scope
npm pack lodash                                        network.call               npm-pack-remote
npm pack ./packages/core                               files.write.workspace      npm-pack
npm init -y                                            files.write.workspace      npm-init
npm init vite                                          files.write.workspace      npm-init-create
npm --version                                          read.shell                 npm-version
npm -v                                                 read.shell                 npm-version
npm --help                                             read.shell                 npm-version
npm doctor                                             REFUSED unclassified       no rule for npm doctor
npm version patch                                      release.publish            npm-publish
tar -tzf dist/pkg.tgz                                  read.shell                 tar-list
tar tvf dist/pkg.tgz                                   read.shell                 tar-list
tar --list -f dist/pkg.tgz                             read.shell                 tar-list
tar -tzf /etc/backup.tgz                               read.file.out_of_scope     read-out-of-scope [/etc/backup.tgz]
tar -xzf dist/pkg.tgz -C build/unpack                  files.write.workspace      tar-extract
tar -xzf dist/pkg.tgz                                  files.write.workspace      tar-extract
tar -xzf dist/pkg.tgz -C /usr/local/lib                files.delete.out_of_scope  packaging-write-out-of-scope [/usr/local/lib]
tar -xzf dist/pkg.tgz -C ../sibling                    files.delete.out_of_scope  packaging-write-out-of-scope [../sibling]
tar -xzf dist/pkg.tgz -C $DEST                         files.delete.out_of_scope  packaging-write-out-of-scope [$DEST]
tar -czf dist/out.tgz src                              files.write.workspace      tar-create
tar -czf /etc/out.tgz src                              files.delete.out_of_scope  packaging-write-out-of-scope [/etc/out.tgz]
tar --version                                          read.shell                 tar-probe
tar -f dist/pkg.tgz                                    REFUSED opaque             tar names no mode this classifier can read
gunzip -c pkg.gz                                       read.shell                 gunzip-read
gunzip -t pkg.gz                                       read.shell                 gunzip-read
gunzip pkg.gz                                          files.write.workspace      gunzip-write
gunzip -k pkg.gz                                       files.write.workspace      gunzip-write
gunzip /etc/x.gz                                       files.delete.out_of_scope  packaging-write-out-of-scope [/etc/x.gz]
base64 -d blob.b64                                     read.shell                 base64-read
base64 dist/pkg.tgz                                    read.shell                 base64-read
base64 -o build/out.b64 -i dist/pkg.tgz                files.write.workspace      base64-write
base64 -o /etc/out.b64 -i dist/pkg.tgz                 files.delete.out_of_scope  packaging-write-out-of-scope [/etc/out.b64]
openssl dgst -sha256 dist/pkg.tgz                      read.shell                 openssl-digest
openssl sha256 dist/pkg.tgz                            read.shell                 openssl-digest
openssl dgst -sha256 -out build/sums.txt dist/pkg.tgz  files.write.workspace      openssl-digest-out
openssl dgst -sha256 -out /etc/sums.txt dist/pkg.tgz   files.delete.out_of_scope  packaging-write-out-of-scope [/etc/sums.txt]
openssl enc -d -in blob                                REFUSED unclassified       no rule for openssl enc
shasum -a 256 dist/pkg.tgz                             read.shell                 read-shell
sha256sum dist/pkg.tgz                                 read.shell                 read-shell

Two rows in that table are worth a sentence each. The listing of an archive OUTSIDE the read roots answers read.file.out_of_scope through the read-scope machinery rather than through anything this task wrote, which is the point of adding the four binaries to the read-target table instead of giving them a scoping of their own. And the pack-destination flag with nothing after it answers the out-of-scope class with NOTHING bound, on the same reasoning the ref-delete rule uses for a delete that names no ref: an invocation whose target cannot be read is the one that least deserves the looser answer.

VALIDATION, with the exit code read rather than the summary block.

Build: exit 0. Typecheck: exit 0. Lint (oxlint over src and tests): exit 0, no output.

Focused suites, one run: node scripts/run-tests.mjs --only command-class cli-hook conformance conformance-regen cli-hook-read-scope gives 717 tests, 717 pass, 0 fail, exit 0. An earlier run over command-class, cli-hook, cli-hook-read-scope, command-class-routing and dogfood gave 212 pass and 1 fail, the failure being the assertion that the hook document carries a row for every rule id; it is green now that the rows are written, which is the assertion doing its job.

Conformance: node conformance/run.mjs over the regenerated manifest gives 452 vectors, 452 passed, 0 failed, 174 negative controls, manifest ok, exit 0. command-class alone is 72 vectors with 10 negative controls, up from 39 with 4.

EVIDENCE PER CRITERION.

AC1. The classify table in the two notes above is the per-command evidence, produced by running the built CLI once per command. Reads: the archive listing in three spellings, the stdout and test forms of the decompressor, base64 in both directions, the digest subcommands, and the two checksum tools. Workspace writes: pack with and without a relative destination, init with and without an initializer, extraction into a relative path and into the working directory, creation of a relative archive. The scratch case the criterion names cannot be expressed in the pure vector suite, which carries no machine facts, so it is a unit fixture with resolved roots: extraction into the session scratchpad and a pack destination inside it are both workspace writes, while the same extraction with no roots resolved, and one whose path escapes the root through a parent segment, are out of scope. Refused-outside: the extraction, the pack destination, the in-place decompression, the base64 output and the digest output each answer files.delete.out_of_scope, which this repository's policy holds at manual, with the destination bound.

AC2. The tag table above, plus a new hook test (hook classify reads a tag listing and still publishes a tag creation) covering fifteen spellings, plus twelve vectors and twenty unit fixtures. The listing forms read; annotate, delete, force, sign, message, a bare name and an unknown flag publish.

AC3. Rows in the rule tables of docs/claude-code-hook.md and docs/cursor-hook.md (two suites assert a row exists for every rule id, and they pass), a new section holding the destination table and the reasoning, the read-scope reader list extended, and a rewritten classifier paragraph in docs/cli-reference.md. Build, typecheck, lint, the hook suites and conformance all exit 0 as above.

A NOTE ON THE VERSION NUMBER, from the rule in the conformance README: a version is claimed at MERGE and not at branch, and two additive changes to one vector file resolve to one minor bump above the highest either side saw. This branch claims command-class 1.4.0. If another lane lands a command-class bump first, this one becomes 1.5.0 at merge and the argument in the script comment carries over unchanged.

FULL SUITE, exit code read rather than the summary block. npm test: 4989 tests, 4965 pass, 23 fail, 1 skipped, exit 1.

The 23 match the known baseline for this machine one for one, and none is in a suite this task touches. Twenty-two are the SMTP and email family on this machine's Node 26: every one of them fails inside node's TLS layer with the property options.servername Setting the TLS ServerName to an IP address is not permitted, received 127.0.0.1, which is the mock server's address. They span adapter-email (14), the email setup verb (4) and smtp-probe (4).

The twenty-third was MINE and is an artifact rather than a defect, stated in full because the honest reading of a red test matters more than the count. demo-provision's --check test asserts approval doctor passes, and doctor's build-freshness check compares the newest mtime under src against the mtime of dist/src/cli/main.js. The marker was emitted at 04:33:17 and I edited src/core/read-scope.ts (a comment rewording) at 04:33:59, mid-run, so a test that ran after that point correctly reported a stale build. After a rebuild the marker is newer than every source and the suite is 19 tests, 19 pass, 0 fail, exit 0. The lesson for the next lane in this worktree: do not edit anything under src while a full run is in flight, because doctor is inside the suite and it dates the build.

No better-sqlite3 ABI failure appeared in cli-instructions on this run.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The read-only packaging and archive tools a release verification runs are classified rather than refused, and a tag listing reads instead of costing a human a decision. Seven new rows (the package-manager version probe, pack, init, tar, gunzip, base64, the openssl digests) share one rule: each command reads what it names or writes into a destination it names, and the destination is decided by refineRm's arithmetic against the same caller-resolved scratch roots, hoisted into one helper rather than copied. An out-of-scope destination answers files.delete.out_of_scope with the path bound, which is the class this table already used for a destructive operation outside the workspace; minting a new files.write sibling was rejected because a class no policy names resolves by defaults.autonomy, so CLASSIFIER_CLASSES is unchanged. The tag verb splits on an allowlist of listing flags, mirroring the branch verb, so the listing forms read while every creation, deletion, force-move, signature, bare name and unrecognised flag stays release.publish exactly where APRV-305 put it. Fail-closed answers were kept where the text runs out: an unreadable tar mode is opaque, a destination flag with nothing after it is out of scope, and every openssl subcommand that is not a digest and every unnamed package-manager subcommand still deny. Verified by 33 conformance vectors at command-class 1.4.0 (72 vectors, 452 across the suite, exit 0), 40 new unit fixtures including the scratch-root branch the pure vectors cannot express, two new hook tests over 33 spellings through the classify verb, a per-command classify table recorded in the notes, and build, typecheck and lint each at exit 0. One limitation is stated rather than hidden and filed as APRV-402: there is no disk pass for a write destination, so a symlinked destination classifies as the workspace write the text describes, exactly as it does for cp and tee today.
<!-- SECTION:FINAL_SUMMARY:END -->
