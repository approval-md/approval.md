# The Claude Code hook — `approval hook claude-code` (APRV-82)

`approval run` gates the commands an agent hands to the runtime. It cannot gate
the ones the agent's harness runs directly, and those are most of them: `git
push`, `gh pr create`, `npm install`, `curl`. Until this verb, enforcement of
`vcs.push.*`, `deps.add`, `network.call` and `release.publish` in this repository
was prose in CLAUDE.md plus an agent's willingness to read it, which is the
AGENTS.md failure SPEC.md §2 exists to criticize.

`approval hook claude-code` is a [Claude Code PreToolUse
hook](https://code.claude.com/docs/en/hooks). Claude Code runs it before a tool
call, hands it the event as JSON on stdin, and reads a decision back on stdout.
The hook classifies the command, resolves the class against `APPROVAL.md`, and
answers:

| resolved autonomy | answer | what reaches the log |
|---|---|---|
| `autonomous` | allow | nothing (amended SPEC.md §6.3) |
| `supervised` | allow | `task.registered` |
| `manual` | wait for a human, then allow or deny | `task.registered`, `approval.requested`, the decision |
| unclassifiable | deny | nothing |

The decision arrives through whatever channel the policy names. In this
repository that is Telegram: the command sits at the gate, the phone buzzes, a
tap grants it, and the hook returns allow to the harness that was blocked on it.

## Installing it

The hook lives in `.claude/settings.json`. **A human commits this file.** It is
`policy.edit` in the taxonomy and in this repository's own policy: a file that
configures the gate is part of the gate, and an agent that could write its own
hook entry could write itself out of it. The hook classifies edits to it as
`policy.edit` for the same reason.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "approval hook claude-code --dir <primary checkout> --as agent:claude-code --timeout 9m",
            "timeout": 600
          }
        ]
      }
    ]
  }
}
```

A few things about those numbers and paths:

- `--dir <primary checkout>` points policy discovery AND the log at the primary
  checkout, whose committed log the daemon writes: the log path is
  `<dir>/.approval/log/events.jsonl`, never relative to the session's working
  directory. `--policy` and `--log` override either half; with neither `--dir`
  nor `--log`, the hook asks git for the primary checkout
  (`git rev-parse --git-common-dir`, whose parent is the primary root) and uses
  its policy and its log, so a session inside a linked worktree still writes to
  the one log. A plain checkout resolves to itself, and outside a repository (or
  without git) the hook falls back to its working directory.
- **The hook never creates a log.** If the resolved log is not there, it denies
  with `hook-log-unreachable` naming the path it looked for, rather than
  scaffolding a second chain that forks from the real one's tail — hash chains
  do not survive a merge. Run `approval init` and `approval policy attest` in
  the primary checkout first.
- `timeout` is Claude Code's cap on the hook process, in seconds. `--timeout` is
  how long the hook waits for a human, in the SPEC.md §5.2 duration grammar. Keep
  `--timeout` comfortably below `timeout`, so a wait that runs out produces a
  `hook-timeout` deny with an explanation rather than a killed process.
- The default `--timeout` is 55s, which suits Claude Code's default 60s hook
  timeout. Raise both together if you want a human to have minutes rather than a
  minute.

Install the CLI on `PATH` (`npm link`, or an absolute path in the `command`).
**A hook whose binary cannot be launched is a non-blocking error in Claude Code,
which means the tool call proceeds.** An uninstalled CLI is therefore an open
gate, and `approval doctor` will not know to look for it.

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
| `gh-api` | gh | api \| auth \| gist \| secret \| workflow | read.vcs.remote for a `gh api` with no method flag (or `GET`) and no `-f`/`-F`/`--field`/`--raw-field`/`--input`; every other call, and every other subcommand on the row, network.call |
| `gh-simple-read` | gh | browse \| search \| status | read.vcs.remote |
| `gh` | gh | pr \| issue \| repo \| run \| cache | read.vcs.remote for view/list/status/checks/diff; `gh pr create` vcs.pr.open, `gh pr edit/comment/review/ready/close/reopen` vcs.pr.update, `gh pr merge` vcs.push.main, `gh pr checkout` vcs.commit.branch; every other write network.call |
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
| `node` | node | (any) | files.write.workspace, gate.self |
| `approval` | approval | (any) | gate.self |
| `workspace-tool` | npx, tsx, ts-node, tsc, oxlint, eslint, prettier, vitest, jest, backlog, make | (any) | files.write.workspace |
| `workspace-write` | mkdir, cp, mv, touch, tee, ln, chmod, truncate, rmdir | (any) | files.write.workspace |
| `rm` | rm | (any) | files.write.workspace, files.delete.out_of_scope |
| `sed` | sed | (any) | read.shell, files.write.workspace |
| `web-fetch` | curl, wget, http, httpie | (any) | read.web for a GET-shaped fetch; network.call for a body, an upload, a non-GET method, or anything ambiguous |
| `network` | ssh, scp, sftp, rsync, nc, telnet, ftp | (any) | network.call |
| `read-shell` | basename, cat, cd, cksum, cut, diff, dirname, du, echo, false, file, find, grep, head, jq, ls, md5sum, printf, pwd, readlink, realpath, rg, shasum, sha256sum, sort, stat, tail, test, tr, tree, true, type, uniq, wc, which | (any) | read.shell |

† These rewrites are LOCAL, and the hook refines them against the checkout it
runs in: see [Rewriting unpublished history](#rewriting-unpublished-history).
`git push --force` is not marked, and never refines.

Four overrides sit on top of the table:

- **`redirect-protected` / `protected-path` → `policy.edit`.** Any effectful
  segment naming a protected path is `policy.edit`, redirect targets included.
  The protected set is the built-ins plus `policy.protected_paths`. The
  built-ins are `APPROVAL.md`, `APPROVALS.md`, `CLAUDE.md`, `AGENTS.md`,
  `.npmrc`, anything under `.approval/`, `.claude/settings*`, and
  `.github/workflows/`; they hold whatever the policy says, so a policy can
  widen the protected surface and never narrow it. `policy.protected_paths`
  (SPEC.md §5.2, APRV-107) lists repo-relative paths: an exact file (`SPEC.md`,
  matched against a candidate's trailing segments, so a bare filename matches
  in any directory as the built-ins do) or a directory prefix ending in `/`
  (`design/`, matched wherever those segments appear). No globs, no negation.
  `approval hook classify --dir <checkout>` answers under that checkout's
  policy, which is how to ask what a path classifies as before touching it.
- **`redirect-write` → `files.write.workspace`.** A read command with a `>` or
  `>>` writes a file, and the class says so.
- **`gate.self`.** The `approval` CLI (and `node …/dist/src/cli/main.js`) is the
  enforcement path; gating it with itself would deadlock. It is allowed and
  nothing is logged.
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
`permissionDecisionReason` says so.

## Deny reasons

The `permissionDecisionReason` is `<code>: <detail>`, and the codes are frozen in
`HOOK_DENY_CODES`:

| code | meaning |
|---|---|
| `hook-unclassified` | no rule covers some segment of the command |
| `hook-opaque` | a construct whose effect cannot be read from the text |
| `hook-unparseable` | the command line could not be tokenized |
| `hook-rejected` | a human said no |
| `hook-revoked` | a granted approval was withdrawn before use |
| `hook-expired` | the TTL lapsed before a decision |
| `hook-timeout` | no decision inside `--timeout`; the request stays OPEN, and a decision inside the TTL authorizes an identical retry, once |
| `hook-withdrawn` | the request was withdrawn before a decision landed |
| `hook-gate-refused:<code>` | the gate refused intake; `<code>` is its own frozen refusal code |
| `hook-policy-unavailable` | `APPROVAL.md` could not be loaded |
| `hook-log-unreachable` | no log where the hook was pointed; it writes to an existing log and creates none |
| `hook-io` | malformed hook input, or an unreadable log |

`hook-opaque` is the one worth knowing by sight. `bash -c …`, `eval`, `source`,
`sudo`, `env`, `xargs`, `node -e`, `python3 -c`, backticks, arithmetic expansion,
and any `$(…)` that is not purely a read: all deny. The fix is to write the
command out, or to run the effect through `approval run` with a granted token.

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
useful. Hook requests are matched by the **payload hash of `{command, cwd}`**, so
the answer belongs to the bytes rather than to one invocation:

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

The hook answers allow or deny; Claude Code runs the command, and nothing ever
calls `approval run`. So the hook's requests carry `execution: "harness"`, and a
grant on one mints no execution token — a minted token would be a live
credential with no spender. The grant is otherwise complete: class, cost and the
payload binding are all recorded. `approval token <key>` on such a grant reports
`none minted: harness-executed`, and `approval run` refuses with the same code,
so nobody hunts for a token that was deliberately never created.

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
