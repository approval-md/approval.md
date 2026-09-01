---
id: APRV-151
title: >-
  A subagent Edit call wrote SPEC.md with no gate prompt: protected-path
  classification missed in an agent-created worktree
status: Done
assignee:
  - '@claude'
created_date: '2026-08-29 20:41'
updated_date: '2026-09-01 23:40'
labels:
  - security
  - hook
  - dogfood
  - bug
dependencies: []
priority: high
ordinal: 136000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed 2026-08-29 during the APRV-145 design landing. A subagent session working in the worktree .claude/worktrees/aprv-145-land (created with git worktree add from the primary) applied an Edit-tool change to SPEC.md — a protected path whose edits classify policy.edit and require a Telegram tap — and NO prompt was raised: the edit applied silently and was committed (since reverted; the same edit was then re-applied from the orchestrating session, where the hook classified it policy.edit and prompted normally, proving the path is protected for that session). The same evening, other subagent sessions in workflow-created worktrees DID have their SPEC.md Edit calls classified and gated (policy.edit timeouts recorded overnight), so the bypass is not simply "subagents are unhooked"; something about that session or worktree let a protected-path write through. Impact: the dogfood control on SPEC/policy edits can be silently bypassed by an agent session with the wrong (or missing) hook wiring, and nothing surfaces the gap — the edit does not even leave a refused-request record. Investigate: which sessions carry the PreToolUse hook for Edit/Write and why this one did not (settings inheritance in spawned sessions? worktree cwd at session start? hook matcher scope?); whether the hook can fail CLOSED for tool-call classes it never sees (a session-level doctor check, or a repo guard that detects protected-path diffs lacking a matching grant in the log); and whether a CI-side guard should verify that every SPEC.md/APPROVAL.md change reaching a PR has a corresponding policy.edit grant in the committed log window. The last idea turns the append-only log into the audit trail for exactly this bypass and fails the PR rather than trusting session wiring.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Root cause identified and recorded: why this session Edit call on SPEC.md was never classified while sibling sessions were
- [x] #2 A fail-closed detection exists for protected-path writes that bypassed classification (session doctor check, repo guard, or CI-side grant cross-check), tested
- [x] #3 The overnight bypass instance is reconstructed in the notes: which commit, which worktree, and the remediation that re-applied the edit through a granted policy.edit
- [x] #4 npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Investigate what the committed log records for a protected-path edit. FINDINGS: the hook's fileToolGate (src/cli/hook.ts) binds the CHANGE, not the touch: the payload filed in .approval/payloads/<payload_hash>.json carries {tool, rule, file, before/after|content|input} where 'file' is the ABSOLUTE path. Bash-tier payloads carry {command, cwd} or {argv, cwd}. approval.granted carries class + payload_hash (no summary); approval.requested carries the truncated summary. The payload store is committed (202 files) and 163/163 policy.* grants resolve in it, so PATH-LEVEL evidence is available for every grant. Attestation is a policy.updated record with payload {policy_path: 'APPROVAL.md', sha256: <sha256 of the policy bytes>} written by 'approval policy amend --commit' (head of the live log is seq 5147, exactly that).
2. Core module src/core/protected-path-guard.ts: pure evaluation over (changed repo-relative paths, VERIFIED records, a payload resolver, the head-tree sha256 of APPROVAL.md, policy.protected_paths). Guarded set = SPEC.md, APPROVAL.md, CLAUDE.md, AGENTS.md, .github/workflows/**, .approval/** and policy protected_paths; EXEMPT = the daemon's own append surface (.approval/log/**, .approval/payloads/**, .approval/QUEUE.md) so records/log-advance PRs cannot trip the check on the evidence they carry.
3. Verdicts, fail-closed: 'attested' (APPROVAL.md whose head-tree bytes hash to a policy.updated sha256 in the log) | 'granted-file' (an approval.granted of class policy.edit/policy.core whose stored payload names the path in its 'file' field, suffix match on path segments) | 'granted-command' (same but the path appears at a path boundary inside the granted command/argv) | FAIL otherwise. No class-level pass: a class-only grant is reported as diagnostic detail inside the failure, never as evidence.
4. The lag rule: the committed log trails the primary's live log. Every failure message states the window searched (seq and ts range of the log AT HEAD) and the remedy: the log advance carrying the grant must merge to main before or with this PR.
5. Distinct fail-closed codes: log-missing, log-unverified (records that do not pass chain verification are never read for evidence, SPEC.md 11.1 invariant 1), payload-unresolved.
6. scripts/protected-path-guard.mjs: thin git plumbing (git diff --name-only base head; git show head:<path> for the log, the payload blobs and APPROVAL.md), --base/--head/--json, imports the built core from dist/. Exit 0 pass, 1 fail, 2 usage, 4 could-not-look.
7. tests/protected-path-guard.test.ts: synthetic logs built ONLY through the real append path (core/attest appendAttestation, core/gate register/request/decide) plus core/payload-store; covers each verdict, the records-PR exemption, the amendment-by-attestation path, and every fail-closed code.
8. Part 2: append checkHarnessWiring(dir) to src/cli/doctor.ts as the fifteenth check, reusing registersApprovalHook; three advisory wordings (wired / not wired / undeterminable), reporting whether THIS worktree root carries .claude/settings.json and whether its PreToolUse matcher covers Edit, Write and Bash.
9. Part 3: reconstruct both incidents in the notes, file the grant-follows-write ordering defect as its own task, record the verbatim CI YAML for the orchestrator (the workflow file is protected and is not edited here).
10. Prove the checker locally against the real committed log: the PR #175 window (APPROVAL.md, attestation seq 5147) and a synthetic SPEC.md change with no grant. Record both outputs in the notes.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What was built

Two things, plus the reconstruction the task asked for. The deliverable is not a
root cause for Claude Code's hook inheritance (that is Anthropic's harness, and
this repository cannot fix it): it is a deterministic backstop that does not
trust session wiring at all.

### Part 1 (AC2) — the CI-side grant cross-check

- `src/core/protected-path-guard.ts` — pure evaluation, no IO and no clock.
- `scripts/protected-path-guard.mjs` — git plumbing plus a CLI. Exit 0 pass, 1
  a protected path lacks evidence, 2 usage, 4 the guard could not look.
- `tests/protected-path-guard.test.ts` — 16 tests. Every synthetic log is built
  through the real append path (`core/attest`'s `appendAttestation`, `core/gate`'s
  `register`/`request`/`decide`) and read back through `core/verify`. No line of
  jsonl is hand-written anywhere in the suite.

It reads NOTHING from the working tree. Both commits' blobs come from
`git show <ref>:<path>`, so the guard sees what the pull request carries and not
what the checkout happens to hold.

### What the committed log actually records (the investigation behind the design)

Asked of the live log, 5147 records at the time of writing:

- `approval.granted` carries `{class, est_cost_usd, execution, payload_hash,
  policy_sha256}`. No summary, no path. The grant alone identifies nothing.
- `approval.requested` carries the same plus a `summary`, which is the command
  or the touch, truncated to about 140 characters. Claimed, per SPEC.md §9.
- The identification is in the PAYLOAD STORE, and the store is committed: 202
  files under `.approval/payloads/`, and **163 of 163** `policy.*` grants in the
  live log resolve in it. Since APRV-124 the hook binds the CHANGE rather than
  the touch, so a file-tool payload is `{tool, rule, file, before/after|content}`
  with `file` an ABSOLUTE path, and a Bash payload is `{command, cwd}` or
  `{argv, cwd}`.
- The human's amendment ceremony (`approval policy amend --commit`) writes
  `policy.updated`, not a `policy.attested` type: `{policy_path: "APPROVAL.md",
  sha256: <sha256 of the policy bytes>}`, actor `human:carter`. Seq 5147 is
  exactly that record.

### Match strength achieved

Three passing verdicts, ordered by what they prove. There is deliberately no
class-level pass.

1. `attested` — CONTENT-level, the strongest in the system. For `APPROVAL.md`
   the guard hashes the file's bytes at the head commit and requires that exact
   digest among the log's `policy.updated` records. It never looks for a grant,
   which is how amendment pull requests pass: they have an attestation and would
   never have a `policy.edit` grant.
2. `granted-file` — PATH-level. A `policy.edit`/`policy.core` grant whose
   `payload_hash` resolves in the committed store to material whose `file` ends
   with the changed path (segment-wise suffix, so a worktree copy of `SPEC.md`
   satisfies `SPEC.md`).
3. `granted-command` — path-level, one notch weaker. The granted command is
   re-run through the runtime's own `classifyCommand`, and it is evidence only
   when a segment classifies as a granting class BECAUSE of a word naming this
   path (`ClassifiedSegment.path`, APRV-143).

**A class-level fallback was considered and rejected.** With 163/163 payload
coverage there is no need for one, and accepting a grant that names some other
file would let one approved edit launder every other edit in the same window.
Class-level grants appear in the failure detail as diagnosis, never as a verdict.
A grant whose payload the head tree does not carry is likewise not evidence, and
the failure names those hashes.

### Two weaknesses found by running it against the real log, and what was done

**Substring matching is unsound.** The first draft matched the changed path
inside the granted command at a path boundary. Run against the real log it
passed `node cli.js hook classify -- vi SPEC.md` and a heredoc whose body merely
contained the words `SPEC.md` as evidence for a later SPEC.md edit. Replaced with
`classifyCommand`, which discriminates exactly right: `cat SPEC.md` is
`read.shell` and proves nothing, `cp draft.md /repo/SPEC.md` is `policy.edit` on
that path and proves the thing asked. Pinned by the test
"a granted command that only MENTIONS the path is not evidence".

**Grants go stale.** With the classifier in place the guard still passed a
SPEC.md edit made on 2026-08-29 on the strength of a `git add SPEC.md` granted on
2026-08-20: once any edit to a path has ever been approved, every later edit to
that path inherits the approval. So evidence must also sit within
`DEFAULT_LOOKBACK_MS` (7 days) of the author date of the commit that introduced
the change, on EITHER side of it. Either side because both orderings are real: a
grant shortly before the commit is ordinary, and a grant shortly after is the
grant-follows-write anomaly now filed as APRV-200 — a defect in its own right,
but a complete consent trail, and not this guard's to adjudicate.

This bound is the guard's weakest joint and it is stated in the module rather
than hidden. A repeat edit to the same path inside the window still inherits the
earlier grant. Closing that needs hunk-level coverage (every added region of the
diff traced to the `after`/`content` bytes of some grant), which is a larger
design than this task; the failure message always names the window applied.

### The lag, and the ordering rule it implies

The committed log on `main` trails the primary checkout's live log, because
advances land periodically as records pull requests. A grant made this morning
may not be on `main` yet, and the guard can only see the log the head commit's
tree carries. That is an ordering rule, not a bug to paper over, and every
failure message states it verbatim:

> the committed log trails the primary checkout's live log, so if this edit WAS
> granted, the log advance carrying the grant must merge to main before or with
> this pull request

Every failure also names the window searched — the seq range and timestamp range
of the log at head — so a reader can tell "the grant is not there" from "the
grant is newer than this log". Proof run #2 below is exactly that case.

### Records / log-advance pull requests do not trip it

`.approval/` is protected wherever it sits, and a records pull request changes
`.approval/log/events.jsonl`, the payload store beside it, and the regenerated
`QUEUE.md`. Requiring a grant for those would require a grant for the evidence.
`EXEMPT_PREFIXES` names that surface and only that surface: `.approval/log/`,
`.approval/payloads/`, `.approval/QUEUE.md`. Everything else under `.approval/`
(the vault, the environment map) is still a protected write. Exempt paths are
reported by name in the output rather than silently dropped.

### Fail closed

Three distinct codes. `log-missing` (the head tree carries no log),
`log-unverified` (it does not pass chain verification), `no-evidence`. The first
two fire BEFORE any evidence is sought, so an unreadable log is never mistaken
for "no protected paths changed". Records that have not passed verification are
never read for evidence: the caller hands the module verified records or none,
which is SPEC.md §11.1 invariant 1 applied to a new surface. Invariant 3 is also
touched and not weakened: the guard reads only the class, the payload hash and
the stored material, and reproduces no token.

### Part 2 (AC2, session side) — the doctor row

`checkHarnessWiring` in `src/cli/doctor.ts`, appended as the fifteenth check
(the seventh append; the check list is a frozen shape that grows only at the
end). Reuses the existing `registersApprovalHook` shape and adds
`approvalHookMatchers`, which returns the matcher strings so coverage of Edit,
Write and Bash can be checked rather than assumed. Advisory: it never fails the
run. Four distinct wordings, all prefixed so a reader can grep them —
`WIRED on disk`, `NOT WIRED`, `NOT WIRED for every tool`, `UNDETERMINABLE`.

On the inheritance question the row was asked to answer: `.claude/settings.json`
is GIT-TRACKED in this repository (one commit, `83d09c1`, APRV-83), so every
worktree carries an identical copy and the worktree root's file never resolves
to the primary's — it is its own checkout of the same blob. The row therefore
reports the checkout it is in, and its `pass` wording carries the caveat that
matters: the entry being on disk is not proof the SESSION loaded it, since both
bypasses happened in worktrees carrying exactly this entry. That is precisely
why the real backstop is CI-side.

Verified in this worktree: `harness-hook-wiring` reports
`WIRED on disk: .../agent-aff522c1c9dac3d37/.claude/settings.json registers
approval hook for PreToolUse over Edit, Write, Bash.`

`src/cli/verb-registry.ts`'s doctor summary updated from fourteen checks to
fifteen.

## Part 3 (AC1, AC3) — the two incidents, reconstructed

### Incident A — 2026-08-29, worktree `.claude/worktrees/aprv-145-land`, SPEC.md

The description says "committed (since reverted)". There is no revert commit,
and that matters for anyone trying to find it: the undo was a
`git reset --hard`, which leaves no trace on the branch. The log has the reset
itself, gated: a `vcs.history.rewrite` action running
`git reset --hard e31ffff` inside `.claude/worktrees/aprv-145-land`, requested
seq 2191 at 20:24:44Z, granted by `human:carter` seq 2192 at 20:28:44Z,
`execution.started` seq 2193 at 20:28:45Z. `e31ffff` is the merge of PR #135.

The SPEC.md work either side of the reset was gated normally, which is what makes
the bypass legible as an anomaly rather than as the norm:

- payload `d83fde9f…`, the §10.2 harness-loop-streak amendment: registered seq
  2150 (20:04:11Z), requested 2151, granted by `human:carter` seq 2158
  (20:08:30Z), `execution.started` 2159. Before the reset.
- payload `e6005c1c…`, the §11.2 registry rows for `not-delegated` and
  `already-finished`: registered 2194 (20:29:37Z), requested 2195, granted seq
  2216 (20:51:18Z), `execution.started` 2231. After the reset — this is the
  remediation, and commit `41d2c9f` carries it, its message saying "Landed
  through a granted policy.edit". It merged as PR #149 (`fcc2125`).

The ungated edit itself has NO record anywhere in the log. That is the whole
problem and it is worth stating flatly: an action that bypasses the hook produces
no `approval.requested`, no refusal, nothing. Its only surviving trace is the
gated reset that discarded it.

### Incident B — 2026-08-30, worktree `.claude/worktrees/agent-a3f5d255372d43ac0`, `.github/workflows/ci.yml`

A spawned Opus agent edited the workflow through the Edit tool; no prompt, no
denial, and per comment #1 only the unrelated PostToolUse security advisory
fired. Quarantined on branch `aprv-159-floor-shard` (head
`2dd92ed8c3206bbb50982a13d02cba1b488da10f`, 2026-08-30 14:14 -0700, sharding the
Node 20 floor leg into the same 3-shard matrix as the Node 22 job).

The remediation is in the log, payload
`c57011e9641e299f84b5fec0769a535016a60cb6994e36e43bc16551351d46fc`: registered
seq 2781 at 21:02:26Z with summary "branch proposal (worktree
agent-a3f5d255372d43ac0): Edit …/.github/workflows/ci.yml", requested 2782,
granted by `human:carter` seq 2787 at 21:04:47Z, `execution.started` 2788. The
branch then landed normally as PR #154 (`a96c17b`); `git diff
main...aprv-159-floor-shard -- .github/workflows/ci.yml` is now empty.

Again: no record of the original ungated Edit.

### Best-supported root-cause hypothesis

**The repository's project-scope `.claude/settings.json` is not in effect for
some spawned-agent sessions, while other hook sources still are, so the
`approval hook` PreToolUse entry does not exist for those sessions and a
protected-path Edit is never classified.**

What supports it:

1. The file is not missing. `.claude/settings.json` is git-tracked (single
   commit `83d09c1`), so it was present and correct in both offending
   worktrees. "Not installed in the worktree" is ruled out.
2. Classification is not the failure. `isProtectedPath` is deliberately
   name-based rather than location-based, and the live log carries dozens of
   correctly gated worktree-tier grants (8 for
   `aprv-127-autonomy/SPEC.md`, 1 for `agent-a3f5d255372d43ac0/.github/workflows/ci.yml`
   itself). A worktree path classifies fine.
3. Comment #1 records that a DIFFERENT PostToolUse hook fired on the offending
   call. So the tool call was visible to the harness's hook machinery; what was
   absent was this repository's entry specifically, not hooks in general.
4. Neither offending worktree has a directory under `~/.claude/projects/`, and
   neither appears in the `projects` map of `~/.claude.json` with
   `hasTrustDialogAccepted`. Every human-opened worktree does
   (`project-luma-event-relevance-3d2cb0`, `approval-message-ui-37ea86`, and
   eight more). Project-scope settings are resolved and trusted per project
   directory, and an agent-created worktree is a project directory nobody has
   ever trusted.

What does NOT yet fit, and is the reason this is a hypothesis rather than a
finding: THIS worktree (`agent-aff522c1c9dac3d37`) is equally absent from the
trust map, and its hook fires — it refused a `node -p` command during this very
task. So trust-map membership alone does not discriminate. The remaining
difference is whether the session INHERITED a parent session that had already
resolved the project settings, or was rooted fresh in the untrusted worktree.

**Evidence that would confirm it:** for an affected session, the harness's own
settings-resolution output — `claude --debug` hook-resolution lines, or `/hooks`
in that session — showing the project settings file listed as not loaded while
user-scope hooks are; and a reproduction that starts a session rooted directly
in a fresh, never-trusted worktree and attempts a protected-path Edit. Neither
is obtainable from this repository, which is the argument for the CI-side
backstop: the guard makes the answer to that question irrelevant to whether an
ungated edit can reach `main`.

### Filed separately

**APRV-200** — "The harness hook's grant can follow the write it authorizes:
PreToolUse returns before the human decides". Comment #2's defect, which is
distinct from this task's: the consent trail is complete but retroactive
(Edit returned success and the file was on disk at ~22:32, grant landed 22:37 at
seq 3064). Labelled `security`, `hook`; references APRV-117, APRV-150 and this
task's recency bound.

## Proof runs against the real committed log

### 1. Good window, strongest match — PR #175 (APPROVAL.md, attestation seq 5147)

```
$ node scripts/protected-path-guard.mjs --base 428dd7ff123b7cbabc6fae70199e561ccdf31b05 --head 7548825
protected-path guard: 428dd7ff123b..754882511786
  exempt (the daemon's own append surface, evidence rather than a protected write): .approval/log/events.jsonl
  PASS APPROVAL.md [attested]
       APPROVAL.md at 754882511786 hashes to 34d029c8aaadd22d3f65e79686973576a8657f885b16ddf3a2fb3c3b7e4f5ed8, which human:carter attested at seq 5147
EXIT=0
```

The amendment passes on its attestation record, with no `policy.edit` grant, and
the log advance riding along is reported as exempt rather than demanded of.

### 2. Bad case — a protected-path change with no evidence in the log at head

Commit `f6e22f0` ("APRV-185 follow-up: invariant 9 mirrored in the CLAUDE.md
invariant list") changed `CLAUDE.md`. It WAS granted — seq 4986, 2026-09-01
04:34 — but the log that commit's tree carries stops at seq 3067 on 2026-08-30,
because the log advance had not merged yet. This is the lag case and the bad case
in one, which is more useful than a fabricated one:

```
$ node scripts/protected-path-guard.mjs --base f6e22f0^ --head f6e22f0
protected-path guard: 15722b1540ca..f6e22f0c4bf3
  FAIL CLAUDE.md [no-evidence]
       CLAUDE.md is a protected path (edits classify policy.edit) and changed between 15722b1540ca and f6e22f0c4bf3, and the committed log carries no evidence that a human decided it. the log at f6e22f0c4bf3 covers seq 1..3067 (2026-08-05T02:31:04.035Z .. 2026-08-30T23:00:10.330Z). 133 grants of class policy.edit/policy.core in this window, none naming this path; 10 grant payloads could not be resolved from the committed payload store (cabacb79f7ce…, 5c78181efc8c…, c57011e9641e…, …), and a grant whose bytes cannot be read is not evidence for any path. the committed log trails the primary checkout's live log, so if this edit WAS granted, the log advance carrying the grant must merge to main before or with this pull request.
EXIT=1
```

The message names the path, the window searched, why each candidate failed, and
the ordering rule that fixes it. Note the third unresolved hash: `c57011e9641e…`
is Incident B's own remediation grant, whose payload had not reached `main` at
that commit either.

### 3. A real grant, matched through the classifier — SPEC.md at `02d6ba1`

```
$ node scripts/protected-path-guard.mjs --base 02d6ba1^ --head 02d6ba1
protected-path guard: e31ffffe1e49..02d6ba13d358
  PASS SPEC.md [granted-command]
       SPEC.md was granted by human:carter at seq 462 (2026-08-25T11:06:19.561Z), within 7d of the commit that changed it (2026-08-29T15:10:50-07:00): the granted command writes this path, in the segment "cp SPEC.md /Users/carter/dev/approval-md-cleanroom/"
EXIT=0
```

Honest about what this one is: `cp SPEC.md <dir>/` READS SPEC.md, and the
classifier calls it `policy.edit` because a protected name appears as a `cp`
argument. The classifier is conservative by design (a false positive costs one
approval prompt, a false negative costs the property), and the guard inherits
that conservatism in the accepting direction. A grant like this is a real human
decision about this path inside the window; it is not a decision about these
particular bytes. Hunk-level coverage is what would close it.

## The workflow YAML for the orchestrator to apply

`.github/workflows/ci.yml` is a protected path and was NOT edited by this
session. Three verbatim changes, all in that file.

### Change 1 — a new job

Insert between the `records:` job and the `full:` job, that is, immediately after
the line

```
      - run: node scripts/run-tests.mjs --only milestones-guard backlog-fixtures docs-guard
```

and immediately before the line `  full:`:

```yaml
  protected-paths:
    # The fail-closed backstop for protected-path writes that bypassed the
    # harness hook (APRV-151). Two incidents — 2026-08-29 SPEC.md in worktree
    # aprv-145-land, 2026-08-30 this very file in agent-a3f5d255372d43ac0 —
    # applied in spawned-agent worktrees with no prompt, no denial, and no
    # refused-request record. An action that bypasses the hook writes nothing to
    # the log, so nothing in-session can report the gap; the only surviving
    # signal is the ABSENCE of a grant. This job reads that absence.
    #
    # It never asks a session whether it was hooked. It asks git which protected
    # paths changed and requires, for each, evidence in the committed
    # hash-chained log that a human decided it. Session wiring is not an input.
    #
    # It runs on every event and every tier, deliberately: a tier says how much
    # test suite a change needs, and this says whether a change was consented
    # to. fetch-depth 0 because the guard reads blobs at two commits.
    name: protected paths (grant cross-check)
    needs: classify
    if: always()
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build
      - name: cross-check protected paths against the committed log
        # Context values reach the script as environment variables and are never
        # interpolated into its text, for the reason the classify job states: a
        # branch name is attacker-shaped input and must not become shell syntax.
        env:
          EVENT_NAME: ${{ github.event_name }}
          BASE_REF: ${{ github.base_ref }}
        run: |
          set -euo pipefail
          if [ "$EVENT_NAME" = "pull_request" ] && [ -n "$BASE_REF" ]; then
            target="origin/$BASE_REF"
          else
            target="origin/main"
          fi
          base="$(git merge-base "$target" HEAD)"
          echo "base=$base head=$(git rev-parse HEAD)"
          node scripts/protected-path-guard.mjs --base "$base" --head HEAD
```

### Change 2 — the aggregator depends on it

In the `ci:` job, replace

```yaml
    needs: [classify, doc-guard, records, full, full-floor]
```

with

```yaml
    needs: [classify, doc-guard, records, full, full-floor, protected-paths]
```

and in that job's last step, add one line to its `env:` block, after the
`FULL_FLOOR_RESULT` line:

```yaml
          PROTECTED_RESULT: ${{ needs['protected-paths'].result }}
```

### Change 3 — the aggregator enforces it

In the same step's `run:` script, insert this immediately after the
`CLASSIFY_RESULT` block (that is, after its closing `fi` and before
`case "$TIER" in`):

```yaml
          if [ "$PROTECTED_RESULT" != "success" ]; then
            echo "the protected-path grant cross-check did not succeed ($PROTECTED_RESULT); a protected path changed with no evidence in the committed log that a human decided it"
            exit 1
          fi
```

Optionally extend the existing echo line with ` protected-paths=$PROTECTED_RESULT`.

### One accompanying test edit, required

`tests/ci-guard.test.ts` line 704 pins the aggregator's dependency list exactly:

```ts
  assert.deepEqual(ci["needs"], ["classify", "doc-guard", "records", "full", "full-floor"]);
```

Applying change 2 makes that assertion fail, so it must be updated in the same
commit to:

```ts
  assert.deepEqual(ci["needs"], [
    "classify",
    "doc-guard",
    "records",
    "full",
    "full-floor",
    "protected-paths",
  ]);
```

It was left untouched here so that `npm test` stays green against the workflow as
it currently stands. No other assertion in `ci-guard.test.ts` is affected: the
"downstream jobs gate on the computed tier" test iterates a fixed list of three
job names and does not enumerate the jobs mapping.

## Open questions

1. The recency bound is a bounded heuristic, not a proof. Hunk-level coverage —
   every added region of the diff traced to the `after`/`content` bytes of some
   grant — is the design that would replace it, and it is worth its own task.
2. The guard treats a grant naming `<any worktree>/SPEC.md` as evidence for
   `SPEC.md`. That is right for a branch-proposal grant (the human saw that
   edit), but it means the hook's tier distinction between a worktree proposal
   and a live-checkout write is flattened here. Whether the merge to the live
   checkout deserves its own evidence class is a design question this task did
   not settle.
3. Ten grant payloads in the live log's history do not resolve in the committed
   store at older commits. They resolve at HEAD, so this is the store's own
   advance lagging in exactly the way the log's does; worth confirming that
   `approval log advance` carries payloads and log in one commit, since the
   ordering rule assumes it.

## Addendum — the doctor check list is a pinned shape

`tests/cli-doctor.test.ts` pins the doctor's check list in four places, and
appending the fifteenth check moved all four. They are updated in this commit:
the check-name list and the parallel status list in "every check passes or skips
on a healthy environment", and the two counts (14 to 15) in "human output is one
line per check with indented fixes" and "--json emits exactly one object with the
frozen shape".

One design consequence fell out of that suite rather than out of the plan. The
healthy-environment test asserts `entry.fix === undefined` for every check it
sees, and the healthy fixture has no `.claude/settings.json`. So the new row's
"no settings file at all" branch carries no `fix`: a checkout that is not a
Claude Code checkout owes no repair, which is exactly how the neighbouring
`harness-hook-outcomes` treats the same absence. The two branches where the
harness IS present and the ENTRY is missing do carry a fix.

`node_modules` was absent in this worktree when the first full run was taken,
which fails `tests/ci-guard.test.ts`'s "every production dependency's
engines.node admits the Node floor" with an ENOENT on
`node_modules/@modelcontextprotocol/sdk/package.json` — an environment gap, not a
regression. `npm ci` was run before the final suite.

## Validation, and one pre-existing failure this task did NOT introduce

`npm run lint` clean. `npm run build` clean. Full `npm test`: 2508 tests,
**2505 pass, 3 fail**, exit 1.

All three failures are in `tests/cli-hook.test.ts` and all three are the same
pre-existing race. It reproduces on the base commit `5e16ac0` with none of this
task's changes applied, in a throwaway worktree built from that commit alone, so
it is a defect already on `main` rather than a regression here:

```
$ git worktree add <scratch>/baseline 5e16ac0 && cd <scratch>/baseline
$ npx tsc -p tsconfig.json
$ node --test --test-name-pattern="a rejected request denies with hook-rejected" dist/tests/cli-hook.test.js
✖ a rejected request denies with hook-rejected (22769.267167ms)
ℹ pass 0
ℹ fail 1
```

**The mechanism, established rather than guessed.** `decideLater` (tests/cli-hook.test.ts:201)
spawns a detached helper that waits a FIXED delay and then runs
`approval grant|reject <key> --as human:alice` exactly once, with `stdio: "ignore"`.
Instrumenting that helper in the baseline worktree to capture what it actually
got back:

```
status=1
STDOUT:
STDERR:✗ not-requested  action hook:sess-1:tu-reject:network.call has no approval.requested record to decide
```

So at 700 ms the hook under test has not yet reached its `approval.requested`
append — it has to spawn node, load the CLI, verify the chain, check attestation
and validate against the schema first — and the decision fires into a request
that does not exist. The refusal is swallowed by `stdio: "ignore"`, nothing ever
decides, and the hook waits out its full 20 s and returns `hook-timeout` where
the test expects `hook-rejected`. The two sibling failures ("a manual command is
allowed when a grant lands mid-wait", "a grant that lapsed its TTL carries
nothing") are the same fixed-delay race on the grant and TTL paths, which is why
they come and go with machine load while this one is deterministic here.

The fix is for `decideLater` to poll for the `approval.requested` record and
decide once it exists, instead of betting a fixed delay against a cold node
start, and to stop discarding the decision verb's exit status — a test helper
whose command silently fails is a test that reports the wrong defect. That is
its own task and is not taken on here.

**AC4 is therefore left UNCHECKED.** It reads "npm test passes; lint clean", and
lint passes but the suite does not. Checking it would be claiming evidence that
does not exist. What is true is narrower and is stated instead: lint and build
are clean, every suite this task touches is green in isolation
(`protected-path-guard` 16/16, `cli-doctor` 52/52, `ci-guard` green once `npm ci`
has been run), and the three red tests are pre-existing on `main` and unrelated
to anything changed here.

## Review follow-ups on fe32006

### 1. The recency bound's contract now matches its code

The `changeTsFor` doc claimed a null timestamp was "NOT a free pass" and that the
grant would be bounded against the head commit, while `inWindow` returned true
unconditionally. Both halves were wrong, and the review was right that the stated
fallback would have been vacuous anyway: every record in the log AT head is
already before head by construction, so that rule would have passed everything it
was asked about while reading like a check.

Resolved in the honest direction rather than by inventing a bound. With no usable
anchor NO recency bound is applied, the doc says so and says why the head-commit
alternative was rejected as theatre, and the finding's own text says which of the
two it got. A second bug fell out while fixing it: `boundText` handled a null
timestamp but not an UNPARSEABLE one, so a garbage date would have skipped the
bound while the finding reported the bound as applied. Anchor derivation is now
single-sourced (`anchorMs`), so the bound enforced and the bound reported cannot
disagree. Pinned by "with no usable anchor NO recency bound is applied, and the
finding says so", which exercises both the null and the unparseable case and
asserts the finding never claims a bound it skipped.

### 2. The report now names the strongest and nearest grant, not the first

Found while verifying the corrected incident-A seqs, and not part of the review:
running the guard over commit 41d2c9f passed it on a `cp SPEC.md
<dir>/` granted four days earlier, because the loop took the first qualifying
grant in log order. The verdict was true and the reason was misleading, which is
the kind of pass that survives review and then misleads whoever reads the log
after an incident. Candidates are now collected and sorted by evidence strength
(`granted-file` before `granted-command`), then by distance from the change
commit, and the detail says "the nearest and strongest of N qualifying grants".
Two tests pin it: nearest wins among equals, and a stronger kind wins over a
nearer weaker one.

Re-run on 41d2c9f now reports `granted-file` at seq 543 rather than the stale
`cp` at seq 462. It still does not report seq 2536, the grant that actually
authorized it, and the reason is the lag rather than the ordering: seq 2536 was
written 95 seconds before the commit and the log advance carrying it had not
merged, so it is not in that commit's tree at all. The guard cannot see it and
correctly does not claim to.

### 3. AC1 correction — the root cause, from PR #169's census

**My hypothesis in the notes above is superseded, and the correction is not
mine.** PR #169 (branch `aprv-151-protected-path-worktree`, unmerged) ran a
per-session census of hook task ids across the incident window and found that the
bypassing sessions produced **no records at all** — not even Bash-tier ones,
which every working session emits constantly. That is decisive in a way my
trust-map circumstantial argument was not: a session with a loaded hook that
merely failed to classify a file tool would still have left `read.shell` and
`files.write.workspace` records all over the log. Producing nothing means the
hook was never invoked by the harness in those sessions, and Claude Code treats a
hook that cannot launch as a non-blocking error — it fails open at the harness
boundary.

That also disposes of the counter-evidence I could not resolve (this worktree is
equally absent from the trust map and its hook fires): trust-map membership was
never the discriminator, because the failure is at the invocation boundary and
not at settings resolution. Credit to PR #169; my section above is left in place
as the weaker reasoning it was, rather than quietly rewritten.

It also sharpens why the deliverable is CI-side. A hook that is never invoked
cannot fail closed, cannot record a refusal, and cannot be asked whether it ran.
Nothing inside the session is in a position to notice, so the only available
signal is the absence of a grant in the log, read from outside.

### 4. AC3 correction — incident A's remediation seq was wrong

My reconstruction cited seq 2216 for commit 41d2c9f. Verified against the log,
that is wrong by about five hours, and PR #169's citation is right:

- `41d2c9f` is authored 2026-08-29 19:05:32 -0700 = **2026-08-30T02:05:32Z**.
- seq 2534 `task.registered` 02:03:19.926Z, seq 2535 `approval.requested`
  02:03:19.944Z, seq 2536 `approval.granted` by `human:carter` 02:03:57.655Z,
  seq 2537 `execution.started` 02:03:58.527Z — all `policy.edit`, all bound to
  `…/.claude/worktrees/aprv-145-build/SPEC.md`. The grant sits **95 seconds**
  before the commit.
- seq 2216 (granted 2026-08-29T20:51:18Z, worktree `aprv-145-land`) is a
  different, earlier SPEC.md edit entirely.

The corrected shape of incident A: the ungated edit and the `git reset --hard`
that discarded it both happened in `aprv-145-land` (the reset itself gated, seq
2191→2193 at 20:24–20:28Z), and the re-application landed hours later from a
DIFFERENT worktree, `aprv-145-build`, under the grant at seq 2536. Worth saying
because "same worktree, re-applied through the gate" was my reading and it is not
what the log shows.

Incident B's citations are confirmed unchanged: seq 2781 registered 21:02:26Z,
2782 requested, 2787 granted by `human:carter` 21:04:47Z, 2788
`execution.started` 21:04:48Z, all bound to
`…/.claude/worktrees/agent-a3f5d255372d43ac0/.github/workflows/ci.yml`.

### 5. docs/claude-code-hook.md documents the guard

New section "The backstop outside the session", plus a Limits bullet for the
case the section exists to cover (a hook the harness never invokes leaves no
trace at all). Covers the three verdict kinds and what each establishes, the
absence of a class-level pass and why, the strongest-and-nearest selection rule,
the recency bound with both of its stated limits, the log-lag ordering rule, the
exempt evidence surface, the protected-paths union across both sides of the diff,
and the three fail-closed codes. A "Prior art" subsection records where PR #169
differs: it anchored paths against checkout roots recovered from the log's own
worktree summaries instead of suffix-matching, which is stronger than what is
implemented here and stays the better answer to the two-checkouts problem; and it
refused command-derived grants outright, which is correct in principle but would
fail the shell-granted CLAUDE.md edits this repository actually makes.

`docs/` is not a protected path, so this is an ordinary edit.

AC4 (2026-09-01): full suite 2492 pass / 0 fail on the APRV-201 fix (PR #186, merged), which removed the decideLater race that reddened PR #180's first run; lint clean on the guard commit 5b74b33. The CI job itself landed on main through the Wave 1 batch (PR #187, grant seq 7282) and passed on that PR via in-window grants, which is the limitation APRV-202 records.
<!-- SECTION:NOTES:END -->

## Comments

<!-- COMMENTS:BEGIN -->
author: @claude
created: 2026-08-30 21:17
---
New data point (2026-08-30, APRV-159 build): a spawned Opus agent in an isolated worktree (.claude/worktrees/agent-a3f5d255372d43ac0) edited .github/workflows/ci.yml via the Edit tool and the protected-path hook did not fire — no prompt, no denial, only the security-guidance PostToolUse advisory. Same shape as the original SPEC.md incident: protected-path Edit hooks are not firing in spawned agent sessions. Remediation applied: the change is quarantined on branch aprv-159-floor-shard (not pushed); the orchestrating session is routing an explicit gate request against the primary checkout before the change moves anywhere.
---

author: @claude
created: 2026-08-30 23:08
---
Correction to my 22:32 comment (the APRV-159 data point stands; this one was mis-filed): the 2026-08-30 22:32 Edit to /Users/carter/dev/approval-md/APPROVAL.md from the orchestrating session was NOT a silent miss. The log shows the full trail: policy.edit registered seq 3057, approval.requested seq 3058, granted by human:carter seq 3064 (22:37), execution.started seq 3065 with grant_seq. The genuine anomaly is ORDERING: the Edit tool returned success and the file was on disk at ~22:32, five minutes before the grant landed (the session even observed the modified policy via a policy-not-attested refusal in between). So the write preceded its authorization; the consent trail is complete but retroactive. That is a different defect class (grant-follows-write carryover semantics, APRV-117/150 adjacent) and may deserve its own task rather than riding this one.
---
<!-- COMMENTS:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Built a CI-side grant cross-check that does not trust session wiring: src/core/protected-path-guard.ts (pure), scripts/protected-path-guard.mjs (git plumbing, exit 0/1/2/4), tests/protected-path-guard.test.ts (16 tests, every log built through the real append path). For each protected path changed between two commits it requires evidence in the committed hash-chained log that a human decided it — content-level for the policy file via its policy.updated attestation, path-level otherwise via the committed payload store (163/163 policy.* grants resolve there, so no class-level fallback was needed or built). Running it against the real log caught two over-acceptances that are now fixed and pinned by tests: substring matching accepted a command that merely MENTIONED the path (replaced with the runtime's own classifyCommand), and stale grants laundered later edits (a 7-day recency bound around the change commit, either side). Verified by three proof runs recorded in the notes: PR #175 passes [attested] at seq 5147, commit f6e22f0 fails [no-evidence] and its message states the log-lag ordering rule, and 02d6ba1 passes [granted-command] through the classifier. Added an advisory doctor row (checkHarnessWiring, the fifteenth check) reporting whether this worktree's settings file carries the PreToolUse entry, with wording that says plainly this is not proof the session loaded it. Reconstructed both incidents with commits, seqs and actors, recorded the best-supported root-cause hypothesis with its counter-evidence, and filed APRV-200 for comment #2's grant-follows-write ordering defect. AC4 left unchecked: lint and build are clean and every touched suite is green in isolation (guard 16/16, doctor 52/52), but npm test is 2505/2508 — the three red tests are a pre-existing fixed-delay race in tests/cli-hook.test.ts's decideLater helper, reproduced on base commit 5e16ac0 with none of this work applied and diagnosed in the notes (the decision fires before approval.requested exists and its not-requested refusal is swallowed by stdio ignore).
<!-- SECTION:FINAL_SUMMARY:END -->
