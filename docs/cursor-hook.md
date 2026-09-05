# The Cursor hook — `approval hook cursor` (APRV-133)

`approval run` gates the commands an agent hands to the runtime. It cannot gate
the ones the agent's harness runs directly. Cursor Agent has native `preToolUse`
hooks. `approval hook cursor` is that adapter: it classifies `Shell`, `Write` and
`Delete`, resolves the class against `APPROVAL.md`, and answers native permission
JSON. It reuses the same deterministic core as `approval hook claude-code`. It
does not speak Claude's nested `hookSpecificOutput` envelope.

| resolved autonomy | answer | what reaches the log |
|---|---|---|
| `autonomous` | allow | nothing (amended SPEC.md §6.3) |
| `supervised` | allow | `task.registered` |
| `manual` | wait for a human, then allow or deny | `task.registered`, `approval.requested`, the decision |
| unclassifiable | deny | nothing |

The decision arrives through whatever channel the policy names. In this
repository that is Telegram.

## Installing it

The hook lives in `.cursor/hooks.json`. **A human commits this file.** It is
`policy.core`: a file that configures the gate is part of the gate. The
classifier treats `.cursor/hooks.json`, `.cursor/hooks/`, and `.cursor/agents/`
as `policy.core` for the same reason.

```json
{
  "version": 1,
  "hooks": {
    "preToolUse": [{
      "command": "approval hook cursor --dir <primary checkout> --as agent:cursor --timeout 9m",
      "matcher": "Shell|Write|Delete",
      "timeout": 600,
      "failClosed": true
    }]
  }
}
```

`failClosed: true` is required. Cursor otherwise lets the tool through on crash,
timeout, or invalid JSON. The CLI still turns unexpected throws into deny JSON
and exits 0, so a launched hook that fails internally still blocks; `failClosed`
covers the cases where the process never answers.

Do not also register `beforeShellExecution` for the same Shell calls: that would
double-prompt. User-typed terminal outside Agent remains ungated, the same class
of gap as Claude Code without a Bash PreToolUse. Cloud Agents are out of scope:
a cloud VM cannot append the primary log without a shared gate.

A few things about those numbers and paths:

- `--dir <primary checkout>` points policy discovery AND the log at the primary
  checkout. `--policy` and `--log` override either half; with neither `--dir`
  nor `--log`, the hook asks git for the primary checkout
  (`git rev-parse --git-common-dir`) and uses its policy and its log.
- **The hook never creates a log.** If the resolved log is not there, it denies
  with `hook-log-unreachable`.
- `timeout` is Cursor's cap on the hook process, in seconds. `--timeout` is how
  long the hook waits for a human. Keep `--timeout` below `timeout`.
- The default `--timeout` is 55s. Raise both together for a longer wait.
- Default identity is `agent:cursor`.

Install the CLI on `PATH` (`npm link`, or an absolute path in the `command`).

## What the classifier decides


`src/core/command-class.ts` is a pure function from a command line to classes.
`approval hook classify -- <command…>` prints its answer for any command, which
is the fastest way to see why something was denied:

```sh
approval hook classify -- git push origin main
# vcs.push.main	git-push-main	git push origin main
# classes: vcs.push.main
```

The tokenizer understands quotes, backslash escapes and line continuations,
`VAR=value` prefixes, redirections (including heredocs, whose bodies are data and
are never classified), the operators `&& || ; | &` and newline, subshell
parentheses, and `$(…)` command substitution. Every segment of a command line is
classified, and the command's classes are the union: `git status && curl -d … `
is gated as `network.call`.

### The rule table

One row per binary group. The first row whose binary and subcommand match
decides; a row with more than one class in the last column reads the flags before
answering (`git push --force` is a rewrite, `npm install` with no package is not
an addition).

| rule | binaries | subcommands | classes |
|---|---|---|---|
| `git-push` | git | push | vcs.push.main, vcs.push.branch, vcs.history.rewrite |
| `git-rewrite` | git | rebase \| filter-branch \| filter-repo | vcs.history.rewrite † |
| `git-reset` | git | reset | vcs.commit.branch, vcs.history.rewrite † |
| `git-commit` | git | commit | vcs.commit.branch, vcs.history.rewrite † |
| `git-branch` | git | branch | read.shell, vcs.commit.branch |
| `git-tag` | git | tag | release.publish |
| `git-clone` | git | clone | network.call |
| `git-write` | git | add \| apply \| checkout \| cherry-pick \| merge \| mv \| pull \| restore \| revert \| rm \| stash \| switch \| worktree | vcs.commit.branch |
| `git-remote-read` | git | fetch \| ls-remote \| remote | read.vcs.remote |
| `git-read` | git | blame \| describe \| diff \| grep \| log \| ls-files \| reflog \| rev-list \| rev-parse \| shortlog \| show \| status | read.shell |
| `gh-release` | gh | release | release.publish |
| `gh-api` | gh | api \| auth \| gist \| secret \| workflow | read.vcs.remote for a `gh api` with no method flag (or `GET`) and no `-f`/`-F`/`--field`/`--raw-field`/`--input`; vcs.remote.meta § for `gh api graphql` on the checkout's own repository whose document carries no `mutation`; every other call, and every other subcommand on the row, network.call |
| `gh-simple-read` | gh | browse \| search \| status | read.vcs.remote |
| `gh` | gh | pr \| issue \| repo \| run \| cache | read.vcs.remote for view/list/status/checks/diff; vcs.remote.meta § for `pr update-branch` and `run rerun` on the checkout's own repository; `gh pr create` vcs.pr.open, `gh pr edit/comment/review/ready/close/reopen` vcs.pr.update, `gh pr merge` vcs.push.main, `gh pr checkout` vcs.commit.branch; every other write network.call |
| `npm-publish` | npm, pnpm, yarn, bun | publish \| version \| deprecate \| dist-tag \| unpublish | release.publish |
| `npm-install` | npm, bun | install \| i \| add | deps.add, deps.install |
| `yarn-add` | yarn, pnpm | add | deps.add |
| `yarn-install` | yarn, pnpm | install | deps.install |
| `npm-ci` | npm, pnpm, yarn, bun | ci | deps.install |
| `npm-update` | npm, pnpm, yarn, bun | update \| upgrade \| up | deps.upgrade |
| `npm-remove` | npm, pnpm, yarn, bun | uninstall \| remove \| rm \| un | deps.remove |
| `npm-link` | npm, pnpm, yarn, bun | link | deps.add |
| `npm-network` | npm, pnpm, yarn, bun | audit \| outdated \| view \| search \| info \| login \| whoami | network.call |
| `npm-list` | npm, pnpm, yarn, bun | ls \| list \| config \| help | read.shell |
| `npm-script` | npm, pnpm, yarn, bun | run \| run-script \| test \| start \| build \| lint \| exec | files.write.workspace |
| `harness-update` | claude, codex, gemini | update | deps.upgrade (APRV-228: the harness's own self-update verb; a version probe, a one-shot prompt and a bare launch stay unclassified) |
| `harness-updater` | uca | (any) | deps.upgrade (APRV-228: the unattended harness updater, `--dry-run` included, taken at its strictest) |
| `node` | node | (any) | files.write.workspace, gate.self, log.sync, log.advance |
| `approval` | approval | (any) | gate.self, log.sync, log.advance |
| `workspace-tool` | npx, tsx, ts-node, tsc, oxlint, eslint, prettier, vitest, jest, backlog, make | (any) | files.write.workspace |
| `workspace-write` | mkdir, cp, mv, touch, tee, ln, chmod, truncate, rmdir | (any) | files.write.workspace |
| `rm` | rm | (any) | files.write.workspace, files.delete.out_of_scope, files.delete.scratch ‡ |
| `sed` | sed | (any) | read.shell, files.write.workspace |
| `web-fetch` | curl, wget, http, httpie | (any) | read.web for a GET-shaped fetch; network.call for a body, an upload, a non-GET method, or anything ambiguous |
| `network` | ssh, scp, sftp, rsync, nc, telnet, ftp | (any) | network.call |
| `keychain` | security, secret-tool, keyring, pass | (any) | account.credential |
| `printenv` | printenv | (any) | account.credential bare, or with a variable whose NAME is credential-bearing; read.shell otherwise |
| `read-shell` | basename, cat, cd, cksum, cut, diff, dirname, du, echo, false, file, find, grep, head, jq, ls, md5sum, printf, pwd, readlink, realpath, rg, shasum, sha256sum, sort, stat, tail, test, tr, tree, true, type, uniq, wc, which | (any) | read.shell |

† These rewrites are LOCAL, and the hook refines them against the checkout it
runs in: see [Rewriting unpublished history](#rewriting-unpublished-history).
`git push --force` is not marked, and never refines.

‡ `files.delete.scratch` needs roots the classifier cannot know and checks it
cannot make from text: see [Deleting scratch](#deleting-scratch).

§ `vcs.remote.meta` is reserved for the checkout's OWN repository: see
[GitHub metadata on your own remote](#github-metadata-on-your-own-remote).

Five overrides sit on top of the table:

- **`redirect-protected` / `protected-path` → `policy.edit`, `policy.core` or
  `log.mutate`.** Any effectful segment naming a protected path takes that
  path's class, redirect targets included, and every positional is scanned, so
  `cp` is direction-blind. The protected set is the built-ins plus
  `policy.protected_paths`, split three ways by consequence since APRV-198:
  `log.mutate` for anything under `.approval/log/`; `policy.core` for
  `APPROVAL.md`, `APPROVALS.md`, the rest of `.approval/`, `.claude/settings*`,
  `.cursor/hooks.json`, `.cursor/hooks/` and `.cursor/agents/`; `policy.edit`
  for `CLAUDE.md`, `AGENTS.md`, `.npmrc`, `.github/workflows/` and every
  `policy.protected_paths` entry. The check order is the precedence, strictest
  first. The built-ins hold whatever the policy says, so a policy can
  widen the protected surface and never narrow it. `policy.protected_paths`
  (SPEC.md §5.2, APRV-107) lists repo-relative paths: an exact file (`SPEC.md`,
  matched against a candidate's trailing segments, so a bare filename matches
  in any directory as the built-ins do) or a directory prefix ending in `/`
  (`design/`, matched wherever those segments appear). No globs, no negation.
  `approval hook classify --dir <checkout>` answers under that checkout's
  policy, which is how to ask what a path classifies as before touching it.
- **`credential-path` / `credential-env` / `env-dump` → `account.credential`.**
  Credential material, whatever binary names it (APRV-194): `.approval/vault*`,
  `.approval/keys/` and `.approval/env`, a word expanding `$APPROVAL_*`,
  `$TELEGRAM_*` or `$VAULT_*` (minus the runtime's own non-secret names), and a
  bare `env`. A WRITE to those files is `policy.core`; a READ of them is
  `account.credential`, and `cp` is direction-blind onto the credential class.
  `sudo cat .approval/env` stays opaque: the credential check sits below the
  opaque one, so a refusal is never softened into a request. No rule can print
  a value — the classifier reads command text and never an environment.
- **`.approval-journal/` is not protected** (APRV-195). The journal of
  `approval journal write` is a SIBLING of the approval home, not a directory
  inside it, so nothing above was loosened to let an agent write there: a write
  to it is `files.write.workspace` like any other workspace write, which is what
  makes the channel ungated. Traversal back out of it is protected again, and a
  copy from credential material into it is still `account.credential`.
- **`redirect-write` → `files.write.workspace`.** A read command with a `>` or
  `>>` writes a file, and the class says so.
- **`gate.self`.** The `approval` CLI (and `node …/dist/src/cli/main.js`) is the
  enforcement path; gating it with itself would deadlock. It is allowed and
  nothing is logged.
- **`log.sync` / `log.advance`.** The two exceptions to that (APRV-125).
  `approval log sync` and `approval log advance` move the log FILE and drive git
  against a shared remote, which is a real-world effect, so they classify by
  name and the policy decides. Under a policy that declares neither, the
  unknown-class default applies and both are manual.
- **`rewrite-unpublished` → `vcs.commit.branch`.** A local rewrite of history
  this checkout never published is a commit. See below.

Stricter-when-unsure, throughout: `git push` with no refspec is `vcs.push.main`,
an `rm` path holding an unexpanded `$VAR` is `files.delete.out_of_scope`, and a
remote-branch deletion takes the trunk class rather than the branch one.

### GET-shaped fetches

SPEC.md §7 puts "web fetch, API GET" under `read.*`, and the classifier used to
answer `network.call` for every curl and every `gh api` alike. In a repository
whose policy holds `network.call` at manual, that priced a documentation lookup
at a human decision, and a session doing research generated one approval per
URL. The rule is narrower now (APRV-114): `curl`, `wget`, `http` and `httpie`
answer `read.web` when the invocation is GET-shaped, and `gh api` answers
`read.vcs.remote`, the class `gh pr view` already had.

A fetch is GET-shaped when nothing in it says otherwise. Any of these takes
`network.call` instead:

- a body or upload flag: `-d`, `--data*`, `--json`, `-F`, `--form*`, `-T`,
  `--upload-file`, `--post-data`, `--post-file`, `--body-data`, `--body-file`,
  and for `gh api` the field flags `-f`, `-F`, `--field`, `--raw-field`,
  `--input`;
- a method flag naming anything but `GET` or `HEAD`: `-X`, `--request`,
  `--method`, joined or separate;
- an httpie method word (`http POST …`) or request item (`http url name=x`);
- a config file that could hold either: `curl -K`, `--config`;
- anything unreadable: `-X "$METHOD"`, a method flag with no value, a bare
  `$VAR` argument, an argument produced by `$(…)`, or a short-flag bundle whose
  method value is in the next word (`curl -sSX POST`), which this classifier
  does not unbundle.

The transports (`ssh`, `scp`, `sftp`, `rsync`, `nc`, `telnet`, `ftp`) are
unchanged and unconditional: what happens at the far end is not written in the
argv, so there is no read-shaped invocation to carve out. A GET-shaped fetch
redirected into a file is still `files.write.workspace`, by the `redirect-write`
override above.

### Rewriting unpublished history

`vcs.history.rewrite` guards SHARED history: a force push, a rebase of a branch
someone else has pulled, an amend of a commit that is already on the remote. An
agent amending its own unpushed worktree branch destroys nothing anyone can
observe, so pricing that at a human's attention spends the audit budget on a
non-event.

The classifier stays pure and keeps answering `vcs.history.rewrite` from the
text alone. The hook then applies one impure refinement, in the directory it
runs in, to any segment classified `vcs.history.rewrite` by a marked (†) rule:

| git state | `git commit --amend` | `git rebase` / `reset --hard` / `filter-branch` |
|---|---|---|
| branch has no upstream | `vcs.commit.branch`, rule `rewrite-unpublished` | `vcs.commit.branch`, rule `rewrite-unpublished` |
| upstream set, HEAD not reachable from it | `vcs.commit.branch`, rule `rewrite-unpublished` | `vcs.history.rewrite` |
| upstream set, HEAD reachable from it | `vcs.history.rewrite` | `vcs.history.rewrite` |
| the default branch (`main`, `master`, or whatever `refs/remotes/origin/HEAD` names) | `vcs.history.rewrite` | `vcs.history.rewrite` |
| detached HEAD, not a repository, no git, any git failure | `vcs.history.rewrite` | `vcs.history.rewrite` |

Only two cases downgrade, then: a branch with **no upstream at all**, and an
**amend whose HEAD is not yet on the upstream**. A rebase or reset names a base
the text cannot resolve, so on a branch that has published anything it may be
rewriting published commits and stays a rewrite. Everything push-side
(`git push --force`, `--force-with-lease`, a `+refspec`) stays
`vcs.history.rewrite` whatever the branch state is.

The queries are `git rev-parse --abbrev-ref HEAD`, `git symbolic-ref
refs/remotes/origin/HEAD`, `git for-each-ref --format=%(upstream:short)
refs/heads/<branch>`, and `git merge-base --is-ancestor HEAD <upstream>`. Every
one of them failing, or answering ambiguously, leaves the class alone.

`approval hook classify` runs the same refinement in the same directory, so what
it prints is what the hook decides, and a refined segment shows the rule name
`rewrite-unpublished`. When the hook refines, its
`agent_message` says so.

### GitHub metadata on your own remote

`network.call` exists for the calls whose whole purpose is that something
leaves: a webhook, an email, an arbitrary POST. Asking GitHub a question about
a pull request on the repository the checkout already tracks, or telling it to
redo bookkeeping about work already pushed, is not that act, and it had no class
of its own to be granted through. APRV-268 gives it one, `vcs.remote.meta`,
beside `read.vcs.remote` and `vcs.pr.open`.

**Exactly three forms**, and no wider:

| form | condition |
|---|---|
| `gh pr update-branch` | the checkout's own repository |
| `gh run rerun` | the checkout's own repository |
| `gh api graphql` | the checkout's own repository, and a document carrying no `mutation` anywhere, not read from a file (`-f query=@doc`, `--input`) |

Every one of those classified `network.call` before APRV-268. Nothing that
already read moves: `gh pr view`, `gh pr list`, `gh pr checks`, `gh pr diff`,
`gh pr status`, `gh run view`, `gh run list`, `gh run watch`, `gh issue
view/list`, `gh repo view` and a plain `gh api` GET all stay `read.vcs.remote`.
That restraint is deliberate. `vcs.remote.meta` is undeclared until a policy
ceremony names it, and an undeclared class falls to the manual default, so
moving a read onto it would RAISE the friction on the commonest commands in the
repository rather than lower it.

**The target must be the checkout's own repository**, which means gh's DEFAULT
repository resolution, reading the repository off this checkout's git remotes.
The classifier is pure and cannot resolve a remote, so it cannot tell a `-R`
naming this repository from one naming another: **any** `-R`, `--repo` or
`--hostname` makes the invocation foreign and it keeps the class it had before.
So does any `$VAR` or `$(…)` in the argv, because one of the words the
classifier cannot see could be a `--repo`.

`pr update-branch` and `run rerun` are mutations, and are included because what
they change is GitHub's bookkeeping about work already pushed, with no content
of the operator's authorship leaving the machine.

Everything else is untouched. `gh pr create` stays `vcs.pr.open`, `gh pr merge`
stays `vcs.push.main`; `gh release`, `gh gist`, `gh secret`, `gh auth`,
`gh workflow`, a `gh api` with a method or a body, a graphql document carrying a
`mutation`, and every `curl` that is not a plain GET stay where they were.

### Deleting scratch

`files.delete.out_of_scope` exists to hold a delete that leaves the workspace,
and in practice almost every one of them was an agent removing the temp
directory it had just made. That is not a decision, so APRV-267 gives it a class
of its own, `files.delete.scratch`, a sibling of `files.delete.out_of_scope`
rather than a replacement for it.

The rule has two halves, and both must say yes.

**Text (pure, in the classifier).** Every target of the `rm` must be an absolute
path, hold no `..` segment, hold nothing the classifier cannot read (`$VAR`, a
glob, `~`), and be a STRICT descendant of a scratch root the caller supplied.
All of them, not some: a command removing one scratch file beside one real one
is not a scratch delete. A root is never under itself, so `rm -rf /tmp` does not
qualify. With no roots supplied, nothing qualifies and the answer is exactly
what it was before this rule existed.

**Disk (impure, in the hook).** The hook resolves the roots and then re-checks
each target, tightening back to `files.delete.out_of_scope` (rule
`rm-scratch-rejected`) on any doubt at all:

| the hook finds | class |
|---|---|
| the target's nearest existing ancestor resolves, stays under a root, and no `.git` sits at or above the target up to that root | `files.delete.scratch`, rule `rm-scratch` |
| a symlink in the path resolves the target out of every root | `files.delete.out_of_scope`, rule `rm-scratch-rejected` |
| a `.git` at or above the target: a checkout living inside the temp root | `files.delete.out_of_scope`, rule `rm-scratch-rejected` |
| nothing on the path resolves, or the segment cannot be re-read | `files.delete.out_of_scope`, rule `rm-scratch-rejected` |

The roots are `CLAUDE_SCRATCHPAD_DIR` and `CLAUDE_CODE_SCRATCHPAD_DIR` when a
harness exports them (none does today), plus `os.tmpdir()` and the fixed temp
roots `/tmp`, `/private/tmp` and `/var/tmp`. Each is realpath'd, and three
guards mean no value an agent could reach can widen the class: a root must
resolve to a real directory, must be at least two path segments deep (so `/` can
never be a scratch root even from a poisoned `TMPDIR`), and must not contain the
directory the hook runs in.

`approval hook classify` runs both halves in the same directory, so what it
prints is what the hook decides.

### What the approver reads (APRV-124)

The prompt binds to the payload, and the payload is the thing being done, whole.
A `summary` is a headline and may be ellipsized; the FULL PAYLOAD block never is.

| tool | payload the grant binds to |
| --- | --- |
| `Shell` | `{command, cwd}` — the complete command line, not the headline |
| `Write` | `{tool, rule, file, content}` |
| `Delete` | `{tool, rule, file, input}`, the tool input verbatim |

A `Write` renders on the phone as a diff (removed lines `-`, added
lines `+`), so the human approves the change rather than the fact that a file
was touched. The diff is the whole rendering (APRV-162): it shows every byte of
the payload or the payload is not a file change at all, so it never folds and
carries no canonical-JSON copy of itself. A change too long for one screen
arrives as several messages, never as a shortened one.

A `Shell` command renders over the lines it really has, with `cwd` on its own
line beneath it and the store path of the exact bytes under that (APRV-126).
Showing a real line break as a line break raises the question of what a
*literal* backslash-`n` should look like, and the answer is that it is marked:
`«\n»` is the two bytes, a line break is a line break, and no two payloads
render the same way. The block says `the hash binds the RAW BYTES, not this
view`, and a long command renders whole, over as many messages as it takes.

`rule` is the tier of a protected-path touch, on the class the path itself selects:

- `protected-path` — the target is the LIVE checkout's file;
- `protected-path-proposal` — the target resolves inside
  `<primary>/.claude/worktrees/<name>/`, so the edit is a branch proposal and
  the merge that makes it real is separately gated;
- `protected-name-elsewhere` — the target resolves outside the gated checkout
  altogether (a scratchpad `APPROVAL.md`, a demo fixture): a file named like a
  policy file, gated because a protected name is protected wherever it sits.

The tier is resolved from the hook's own process view (`git rev-parse
--git-common-dir`, then the real paths), never from the `cwd` the harness sends,
and it fails closed: anything not provably inside an agent worktree and not
provably outside the checkout is live-tier. It changes no policy semantics —
every tier resolves exactly as the path's own protected class resolves — only what the prompt
says.

## Deny reasons

Stdout is `{ "permission": "allow" | "deny", "user_message": "...", "agent_message": "..." }`.
Never `ask`. The `agent_message` is `<code>: <detail>`, and the codes are frozen in
`HOOK_DENY_CODES`:

| code | meaning |
|---|---|
| `hook-unclassified` | no rule covers some segment of the command |
| `hook-class-human-only` | some class of the command resolves to `human-only`: the policy reserves it to human hands, so the command is denied outright and no gate lifecycle is opened. Nothing is registered, requested or appended, and a person runs the command instead. The gate's own code for the same fact is `class-human-only`, which the detail names |
| `hook-opaque` | a construct whose effect cannot be read from the text |
| `hook-unparseable` | the command line could not be tokenized |
| `hook-rejected` | a human said no |
| `hook-revoked` | a granted approval was withdrawn before use |
| `hook-expired` | the TTL lapsed before a decision |
| `hook-timeout` | no decision inside `--timeout`; the request stays OPEN, and a decision inside the TTL authorizes an identical retry, once |
| `hook-withdrawn` | the request was withdrawn before a decision landed |
| `hook-gate-refused:<code>` | the gate refused intake; `<code>` is its own frozen refusal code |
| `hook-grant-unverified` | the grant was spent, and the verified log cannot be seen to carry the `execution.started` recording it. The record IS the authorization on a harness surface, because the harness executes and never sees the gate's return value, so no verdict is printed until the chain carries it (APRV-200) |
| `hook-policy-unavailable` | `APPROVAL.md` could not be loaded |
| `hook-log-unreachable` | no log where the hook was pointed; it writes to an existing log and creates none |
| `hook-io` | malformed hook input, or an unreadable log |

`hook-opaque` is the one worth knowing by sight. `bash -c …`, `eval`, `source`,
`sudo`, `env`, `xargs`, `node -e`, `python3 -c`, backticks, arithmetic expansion,
and any `$(…)` that is not purely a read: all deny. The fix is to write the
command out, or to run the effect through `approval run` with a granted token.

### When the grant can follow the write (APRV-200)

Cursor's `failClosed` on the `hooks.json` entry is what closes, on this harness,
the window `docs/claude-code-hook.md` documents at length for Claude Code: a hook
that crashes or is killed still blocks, so a tool call that proceeds without a
verdict is not a shape this adapter has. The rest of that section applies
unchanged, including the `grant_origin` marker every harness `execution.started`
carries: `direct` when the tool call that spent the grant is the tool call that
asked for it, `carried` when a later one spent it under the carryover below. A
grant that arrives after the effect it names ratifies rather than authorizes, and
`carried` is how an auditor sees which window a spend sits in.

### When the wait runs out (APRV-106, revised by APRV-117)

A `hook-timeout` leaves the request **open**. The tool call is denied, nothing is
withdrawn, and a decision that lands inside the policy's approval TTL authorizes
a retry of the same command in the same directory, once.

This is a change on a change, and both halves are worth saying.

The incident first. On 2026-08-19 a `git commit --amend` was classified manual,
the hook waited nine minutes, got nothing, denied and moved on; half an hour
later the human was pinged on their phone and approved it, and the grant
authorized nothing at all, because a retried tool call was a new `tool_use_id`
and filed a new request. A person spent attention on a question whose asker had
left, and SPEC §11 makes human attention the audit budget. APRV-106's answer was
to retract the question when the hook stopped waiting.

APRV-117 answers the same incident the other way, by making the late decision
useful. Hook requests are matched by the **payload hash** — of `{command, cwd}`
for a Shell call, of the change itself for a file tool (see [What the approver
reads](#what-the-approver-reads-aprv-124)) — so the answer belongs to the bytes
rather than to one invocation:

- a retry while the question is still pending **adopts** it and waits out the
  remainder — the approver never sees two prompts for one command;
- a retry after a grant landed **proceeds on it**, with no new prompt, provided
  the TTL has not lapsed and nothing has spent it;
- a grant is spent **exactly once**. Consumption is an `execution.started`
  carrying `execution: "harness"`, appended through compare-and-append by
  `consumeHarnessGrant` before the `allow` is printed. No `execution.completed`
  ever follows it: the harness runs the command and this runtime never learns
  the outcome.

**The replay bounds, exactly.** Same command bytes, same `cwd`, same class, once,
inside the TTL, and only against a request that declared `execution: "harness"`.
Any difference in any of those is a different question and gets a new prompt. A
second retry after the grant has been spent is refused through the ordinary path:
it files a fresh request and waits like any other.

**What still withdraws.** Every path where nothing can adopt the question: a
`SIGTERM` or `SIGINT` arriving while the hook polls (the session is ending), an
unexpected failure mid-wait, and an intake refusal partway through a multi-class
command. Withdrawal remains requester-only, so an adopted request is never
withdrawn by the process that adopted it.

**What the human sees.** A pending prompt stays live and keeps its buttons until
it is answered or the TTL lapses, and every terminal state still annotates the
message in place (APRV-113): `✓ APPROVED`, `✗ EXPIRED — the approval window
closed`, `WITHDRAWN — no decision is needed`. The prompt's own waiting line now
reads `requested 4 min ago · expires 10:34 UTC` — the policy's TTL, which is the
deadline that actually governs. Hook requests no longer declare a `wait_until`,
because "requester waits until 10:10 UTC" stopped being true the moment a late
answer started authorizing a retry.

### No token is minted for a hook grant

The hook answers allow or deny; Cursor runs the command, and nothing ever
calls `approval run`. So the hook's requests carry `execution: "harness"`, and a
grant on one mints no execution token — a minted token would be a live
credential with no spender. The grant is otherwise complete: class, cost and the
payload binding are all recorded. `approval token <key>` on such a grant reports
`none minted: harness-executed`, and `approval run` refuses with the same code,
so nobody hunts for a token that was deliberately never created.

## Harness version provenance (APRV-227)

A harness upgrade swaps the binary that hosts this hook, unattended, on a
human's own machine. A release can change the hook envelope semantics, and the
gate then answers a protocol nobody is speaking any more. The gate cannot stop
the upgrade and should not try; what it can do is notice the effect.

**The records the hook writes name the binary that wrote them.** Two optional
payload fields, on the two records the hook authors:

| record | when the hook writes it | fields |
|---|---|---|
| `task.registered` | a supervised or manual class, at registration | `harness`, `harness_version` |
| `gate.bypassed` | a gated call allowed by an open window | `harness`, `harness_version` |

```json
{
  "event": "gate.bypassed",
  "payload": {
    "opened_seq": 41,
    "tool": "Shell",
    "classes": ["deps.add"],
    "harness": "cursor",
    "harness_version": "cursor-agent 2026.08.19"
  }
}
```

Where the version comes from, in order: the hook event's own `version` field
where the harness supplies one, then `cursor-agent --version` read at most once
per process, then absent. **Cursor's event does not state a version**, so on
this harness the value comes from the binary in practice, and a checkout with no
`cursor-agent` on `PATH` records neither field rather than a placeholder. Both
travel together or not at all: a version with no binary named beside it is a
string nobody can compare against anything, and one log holds the records of
every harness that ever wrote to it.

The write boundary constrains the SHAPE: one line, printable ASCII, at most 64
characters. The value is the output of a third-party process going into an
append-only log, and SPEC.md §11.1 invariant 3 has no exception for provenance.

Both fields are OPTIONAL and additive: every record written before they existed
still validates and still verifies.

**It reduces nothing.** The version is self-reported, and SPEC.md §11.1
invariant 4 holds here by construction rather than by care: no verdict, no
irreversibility floor, no budget, no loop streak and no sampling draw reads the
field. Its single reader is the doctor row below, which can only ADD a red line.

### `approval doctor`'s `harness-version-unverified` row

The row compares what `cursor-agent --version` says now against what the last
hook-written record says the binary was.

| verdict | when |
|---|---|
| pass | they match |
| fail | they differ, and no record has been written under the new binary yet |
| skip | this checkout registers no `approval hook` command; or no hook record names a version yet; or `cursor-agent` is not on `PATH` |

Doctor finds the registration by reading `.cursor/hooks.json` (and
`.claude/settings.json`) for an `approval hook <harness>` command, so a checkout
driven by both harnesses is reported for both. It fails rather than warns
because an unverified change is exactly the state in which nobody has checked. A
pass is not proof the hook fired; it is the absence of the one thing this row
can see.

### The self-test

Clearing the row costs nobody a prompt. Run one **supervised-class** tool call
through the upgraded hook: a supervised class registers the task and allows,
with no approval lifecycle and no question on anybody's phone (amended SPEC.md
§6.3, and the table at the top of this page). The `task.registered` it writes
carries the new version.

```sh
printf '%s' '{"session_id":"selftest","hook_event_name":"preToolUse","tool_name":"Shell","tool_input":{"command":"git push origin main"},"tool_use_id":"selftest-1"}' \
  | approval hook cursor --dir <primary checkout>
# {"permission":"allow", …}
approval doctor --json | jq '.checks[] | select(.check == "harness-version-unverified")'
```

Substitute a command your own policy resolves to `supervised`; `approval hook
classify -- <command…>` says which class a command falls under.

## Limits, stated plainly

- **The classifier is best effort.** It reads shell text without being a shell.
  Parameter expansion is not resolved, aliases and shell functions are invisible
  to it, and a binary that wraps another (`make`, `npx`) is classified by the
  wrapper. Every one of those gaps resolves toward denial or toward the stricter
  class, but "resolves stricter" is not "cannot be fooled".
- **It is not scheming-robust** (SPEC.md §11, §13). An agent that intends to
  evade this will succeed: the hook is a speed bump against doing the wrong thing
  by mistake or by momentum. The hard boundary stays the vault and the execution
  token (SPEC.md §10.4), which do not care what the harness thinks it is running.
- **Self-reported fields are never read.** The event carries the agent's own
  `description` of its command. The hook ignores it (SPEC.md §11.1: a
  self-reported field never reduces scrutiny) and classifies the command text.
- **No `execution.*` records.** The harness runs the command, not the runtime, so
  there is nothing the log could truthfully say about how it went. What the hook
  records is the approval lifecycle only. A PostToolUse companion that closes the
  loop with an execution record is future work, and would have to reckon with the
  fact that its report comes from the same untrusted side.
- **A hook that fails to launch is an open gate.** See the install note above.
- **Latency.** Every gated tool call pays a Node start-up plus a verified read of
  the log. SPEC.md §13's post-v1 Rust fast-path is the accelerator for exactly
  this loop.
