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
| `autonomous` | allow | `execution.started` |
| `supervised` | allow | `task.registered`, `execution.started` |
| `manual` | wait for a human, then allow or deny | `task.registered`, `approval.requested`, the decision, `execution.started` on an allow |
| unclassifiable | deny | nothing |

No approval lifecycle exists off the manual path (amended SPEC.md §6.3): the
`autonomous` and `supervised` rows request nothing, ask nobody, and record no
decision. What they do record, since APRV-141, is the execution itself, marked
`execution: "harness"` because this runtime hands over permission and never sees
an exit status. That record is the one budgets charge and the one the
retrospective audit sampler draws from, so without it the path carrying most of
an agent's traffic was unbudgeted and unsampled. It binds the `payload_hash` of
the bytes about to run (APRV-146), so it says WHAT ran and not merely that
something did, and the only thing that ever closes it is the outcome the
post-execution registration below reports (APRV-145).

Before any of those rows allows, the hook establishes two facts from the
verified log (APRV-139): a human has attested the live policy bytes, and the
task is not loop-escalated. Either failing, or the log being unreachable at all,
is a deny.

The decision arrives through whatever channel the policy names. In this
repository that is Telegram: the command sits at the gate, the phone buzzes, a
tap grants it, and the hook returns allow to the harness that was blocked on it.

## Installing it

The hook lives in `.claude/settings.json`. **A human commits this file.** It is
`policy.core` in the taxonomy and in this repository's own policy: a file that
configures the gate is part of the gate, and an agent that could write its own
hook entry could write itself out of it. The hook classifies edits to it as
`policy.core` for the same reason.

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

**Register the same command for the post-execution event too (APRV-145).**
Without it the gate answers every tool call and learns the outcome of none, so
the loop escalation of SPEC.md §10.2 holds at zero however wedged a session is,
and `approval doctor`'s `harness-hook-outcomes` check fails to say so:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "approval hook claude-code --dir <primary checkout> --as agent:claude-code"
          }
        ]
      }
    ],
    "PostToolUseFailure": [
      {
        "matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "approval hook claude-code --dir <primary checkout> --as agent:claude-code"
          }
        ]
      }
    ]
  }
}
```

One binary, two events, dispatched on `hook_event_name`. The post-execution run
answers no permission question — it cannot, the tool has already run — so it
prints an empty stdout, one machine-readable JSON line on stderr, and exits 0.
`--timeout` and `--interval` are meaningless on it; it never waits for anybody.

What it carries, and what it does with it. The event names `session_id` and
`tool_use_id`, which are the two segments the pre-execution run put in the task
id, so the task and the action keys are read back out of the VERIFIED log rather
than out of the report. `tool_response` is an object whose `type` is `text`,
`base64` or `error`, and the tool's exit code is not exposed to a hook at all: a
failing Bash call arrives as `PostToolUseFailure` instead. So the reading is
closed at three cases — `text`/`base64` is a completion, `error` is a failure,
`PostToolUseFailure` is a failure — and ANYTHING ELSE APPENDS NOTHING. A failure
nobody observed would trip an escalation on noise; a completion nobody observed
would clear one on nothing. None of the text inside `tool_response` reaches the
log, ever (SPEC.md §11.1 invariant 3 has no exception for diagnostics).

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
| `node` | node | (any) | files.write.workspace, gate.self, log.sync, log.advance |
| `approval` | approval | (any) | gate.self, log.sync, log.advance |
| `workspace-tool` | npx, tsx, ts-node, tsc, oxlint, eslint, prettier, vitest, jest, backlog, make | (any) | files.write.workspace |
| `workspace-write` | mkdir, cp, mv, touch, tee, ln, chmod, truncate, rmdir | (any) | files.write.workspace |
| `rm` | rm | (any) | files.write.workspace, files.delete.out_of_scope |
| `sed` | sed | (any) | read.shell, files.write.workspace |
| `web-fetch` | curl, wget, http, httpie | (any) | read.web for a GET-shaped fetch; network.call for a body, an upload, a non-GET method, or anything ambiguous |
| `network` | ssh, scp, sftp, rsync, nc, telnet, ftp | (any) | network.call |
| `keychain` | security, secret-tool, keyring, pass | (any) | account.credential |
| `printenv` | printenv | (any) | account.credential bare, or with a variable whose NAME is credential-bearing; read.shell otherwise |
| `read-shell` | basename, cat, cd, cksum, cut, diff, dirname, du, echo, false, file, find, grep, head, jq, ls, md5sum, printf, pwd, readlink, realpath, rg, shasum, sha256sum, sort, stat, tail, test, tr, tree, true, type, uniq, wc, which | (any) | read.shell |

† These rewrites are LOCAL, and the hook refines them against the checkout it
runs in: see [Rewriting unpublished history](#rewriting-unpublished-history).
`git push --force` is not marked, and never refines.

Five overrides sit on top of the table:

- **`redirect-protected` / `protected-path` → `policy.edit`, `policy.core` or
  `log.mutate`.** Any effectful segment naming a protected path takes that
  path's class, redirect targets included, and every positional is scanned, so
  `cp` is direction-blind: a copy OUT of a protected path is as gated as a copy
  into it. The protected set is the built-ins plus `policy.protected_paths`,
  and since APRV-198 it is split three ways by consequence:

  | Class | Built-in surface | What it is |
  |---|---|---|
  | `log.mutate` | anything under `.approval/log/` | a write to the record of what happened, not to the rules |
  | `policy.core` | `APPROVAL.md`, `APPROVALS.md`, the rest of `.approval/` (env, payloads, vault, keys, `QUEUE.md`), `.claude/settings*`, `.cursor/hooks.json`, `.cursor/hooks/`, `.cursor/agents/` | the gate's own organs, including the files that install the hook |
  | `policy.edit` | `CLAUDE.md`, `AGENTS.md`, `.npmrc`, `.github/workflows/`, and every `policy.protected_paths` entry | the prose and configuration *about* the gate |

  The check order is the precedence: a path is answered by the strictest
  surface it names (`log.mutate`, then `policy.core`, then `policy.edit`), and
  so is a segment naming several of them. The built-ins hold whatever the
  policy says, so a policy can widen the protected surface and never narrow it,
  and every path a policy adds lands on `policy.edit`. `policy.protected_paths`
  (SPEC.md §5.2, APRV-107) lists repo-relative paths: an exact file (`SPEC.md`,
  matched against a candidate's trailing segments, so a bare filename matches
  in any directory as the built-ins do) or a directory prefix ending in `/`
  (`design/`, matched wherever those segments appear). No globs, no negation.
  `approval hook classify --dir <checkout>` answers under that checkout's
  policy, which is how to ask what a path classifies as before touching it.
- **`credential-path` / `credential-env` / `env-dump` → `account.credential`.**
  Credential material, whatever binary names it (APRV-194). A segment naming
  `.approval/vault*`, `.approval/keys/` or `.approval/env` is
  `account.credential` — including under a binary the table does not know, so
  `base64 .approval/vault.enc` is named rather than refused as `unclassified` —
  and so is a word expanding `$APPROVAL_*`, `$TELEGRAM_*` or `$VAULT_*` (minus
  the runtime's own non-secret names: `APPROVAL_HUMAN`, `APPROVAL_AGENT`,
  `APPROVAL_ASCII`, `APPROVAL_MD`, `APPROVAL_HOME`, `APPROVAL_DIR`). A bare
  `env` prints the whole environment and is answered before the opaque table;
  `env <command>` stays opaque, and so does `sudo cat .approval/env`, because
  the credential check sits below the opaque one and a refusal must not be
  softened into a request.

  **Precedence with the protected classes:** a WRITE to those files is
  `policy.core` — it edits the gate's own directory — and a READ of them is
  `account.credential`, because what leaves the machine is the secret. `cp` is
  the deliberate exception: it is direction-blind, and a `cp` touching
  credential material is `account.credential` either way. Nothing here reads an
  environment, so a refusal can only ever name a variable's NAME; no rule can
  print a value.
  **`.approval-journal/` is NOT any of these** (APRV-195). The journal of
  `approval journal write` is a sibling of the approval home rather than a
  directory inside it, so no rule above was loosened to let an agent write
  there: it shares a string prefix with `.approval` and shares no path SEGMENT
  with it, and a write to it classifies `files.write.workspace` like any other
  workspace write. That is what makes the channel ungated — an outlet a policy
  could close is not an outlet. Two consequences hold in the other direction:
  traversal back out of it (`.approval-journal/../.approval/vault.enc`) is
  protected again, and a copy FROM credential material INTO the journal is
  still `account.credential`, because that rule reads every argument.
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
`permissionDecisionReason` says so.

### What the approver reads (APRV-124)

The prompt binds to the payload, and the payload is the thing being done, whole.
A `summary` is a headline and may be ellipsized; the FULL PAYLOAD block never is.

| tool | payload the grant binds to |
| --- | --- |
| `Bash` | `{command, cwd}` — the complete command line, not the headline |
| `Edit` | `{tool, rule, file, before, after}` (plus `replace_all` when the call sets it) |
| `Write` | `{tool, rule, file, content}` |
| other file tools | `{tool, rule, file, input}`, the tool input verbatim |

An `Edit` or a `Write` renders on the phone as a diff (removed lines `-`, added
lines `+`), so the human approves the change rather than the fact that a file
was touched. The diff is the whole rendering (APRV-162): it shows every byte of
the payload or the payload is not a file change at all, so it never folds and
carries no canonical-JSON copy of itself. A change too long for one screen
arrives as several messages, never as a shortened one.

A `Bash` command renders over the lines it really has, with `cwd` on its own
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

The `permissionDecisionReason` is `<code>: <detail>`, and the codes are frozen in
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
| `hook-grant-unverified` | the grant was spent, and the verified log cannot be seen to carry the `execution.started` recording it. On this surface the record IS the authorization, because the harness executes and never sees the gate's return value, so no verdict is printed until the chain carries it. The grant is spent by then: the retry costs one prompt and authorizes nothing meanwhile |
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
useful. Hook requests are matched by the **payload hash** — of `{command, cwd}`
for a Bash call, of the change itself for a file tool (see [What the approver
reads](#what-the-approver-reads-aprv-124)) — so the answer belongs to the bytes
rather than to one invocation:

- a retry while the question is still pending **adopts** it and waits out the
  remainder — the approver never sees two prompts for one command;
- a retry after a grant landed **proceeds on it**, with no new prompt, provided
  the TTL has not lapsed and nothing has spent it;
- a grant is spent **exactly once**. Consumption is an `execution.started`
  carrying `execution: "harness"` and the `payload_hash` the grant binds to
  (APRV-146: a start that cannot state its bytes says only that something ran),
  appended through compare-and-append by `consumeHarnessGrant` before the
  `allow` is printed. The harness runs the command, so this runtime observes no
  exit status and writes no outcome of its own over that record: the human
  recovery verbs refuse a delegated start with `execution-delegated`, and its
  only counterpart is the one the post-execution registration REPORTS
  (`execution.completed` or `execution.failed`, carrying `reported_by:
  "post-tool-use"`, APRV-145). Where that registration is absent, or the event
  carries no `tool_use_id` to reconstruct the task id from, the start stands
  open and terminal.

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

### When the grant can follow the write (APRV-200)

A `hook-timeout` deny and a later grant are the same request seen twice, and that
raises the question this section answers: can a human's tap arrive *after* the
bytes it authorizes are already on disk, and if it can, what does the tap mean?

**What the runtime guarantees, and where the guarantee stops.** The hook decides
before the tool runs and the *harness* runs it. Everything up to the verdict is
this runtime's: the request, the wait, the spend, and — since APRV-200 — a
verified re-read establishing that the `execution.started` is in the chain before
`allow` reaches stdout. Everything after the verdict is Claude Code's. This
runtime never observes the tool call at all, so it cannot record when the write
landed, and no field on any event asserts that it did not land early.

**The three ways a tool call can proceed without a verdict.** Each is at the
harness boundary, and none of them is reachable from inside this runtime:

1. **The hook process is killed** at the `timeout` in `.claude/settings.json`.
   A killed hook exits non-zero with no JSON, which Claude Code reads as a
   non-blocking error, and the tool call proceeds. This is why `--timeout` MUST
   be comfortably below `timeout`: the relation is a requirement, not a
   nicety, and the runtime cannot check it because a hook is not told the cap
   it runs under.
2. **Any non-zero exit that is not 2.** Exit 2 is a block with stderr as the
   reason; every other non-zero code is a non-blocking error and the tool runs.
   The verb exits 2 only for a misconfigured hook and otherwise exits 0 with a
   verdict, which is what keeps a deny a deny.
3. **The binary cannot be launched at all** — an uninstalled CLI, a wrong path
   in `command`. Same reading, same outcome, and `approval doctor` will not know
   to look for it.

**So a grant CAN follow its write, and when it does it authorizes nothing that
already happened.** A tap that lands after the effect is a *ratification*: it
says the human would have approved, not that they did approve first. The runtime
does not treat the two differently, because it cannot tell them apart at the
moment of the spend — but it now records which window the spend sits in.

**`grant_origin`, on every harness `execution.started` that names a `grant_seq`:**

- `direct` — the tool call that spent the grant is the tool call that asked for
  it. One process opened the request, waited, saw the decision, spent it and then
  returned `allow`. The gate observed the whole ordering, and no write it
  authorized could have preceded the human's answer.
- `carried` — a *later* tool call spent it, under the carryover or the adoption
  above. The asking invocation had already returned its verdict, so if that
  verdict was one of the three cases above the bytes may be on disk. The runtime
  states the window rather than claiming the ordering.

The field is derived at the write boundary from the task the request record
carries, not from a caller's claim about itself: `carried` is the default and the
value a caller reaches by saying nothing, and `direct` is reachable only by naming
a fact the verified log already holds. That is SPEC.md §11.1 invariant 4 applied
to a marker — a self-report may add scrutiny and never remove it.

**What an auditor can and cannot derive from the log alone.** They can tell a
`direct` spend from a `carried` one, which is the only window in which the
ordering can be false; and they can read the `execution.completed` or
`execution.failed` a `PostToolUse` registration reports, which is the runtime's
only evidence that the tool call happened at all. They cannot derive **when the
tool call applied**, because nothing observes it: the record that would make the
ordering fully derivable is a harness-side timestamp for the write, and it would
be a claimed field authored by the party under oversight, which §11.1 invariant 4
bars from reducing scrutiny. A `carried` spend is therefore evidence to
investigate, not proof of a violation, and a `direct` spend is proof of the
ordering.

**Carryover when the bytes are already on disk.** Adoption and carryover do not
inspect the target, and deliberately so: a grant binds to *bytes*, not to a state
of the world. A carried grant says a human approved this exact change to this
exact file, once, inside the TTL. It never says the change had not been made. If
the ordering matters for a particular class — a policy edit, a release — the
control is a `manual` floor plus the `carried` marker in review, not a
best-effort check of the file at spend time, which would be a race the runtime
would lose to the harness by construction.

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
- **The outcome is a REPORT, not an observation.** The harness runs the command,
  not the runtime, so nothing the runtime observed can say how it went. Since
  APRV-141 the hook records the execution itself (`execution.started`, marked
  `execution: "harness"`), and since APRV-145 the post-execution event closes it
  with an `execution.completed` or `execution.failed` carrying `reported_by:
  "post-tool-use"`. That record is an assertion from the untrusted side and says
  so on its face. It is bounded in one direction (SPEC.md §11.1 invariant 4): a
  reported failure accrues the loop streak, and only a completion clears one.
- **A hook that fails to launch is an open gate.** See the install note above.
- **A hook the harness never invokes leaves no trace at all** (APRV-151). Not a
  deny, not a refused request, not a record of any kind. Two protected-path
  edits reached agent-created worktrees this way — SPEC.md on 2026-08-29,
  `.github/workflows/ci.yml` on 2026-08-30 — and nothing in this runtime could
  have noticed, because every other check on this page runs inside the session
  whose wiring is the thing in question. Asking a session whether it is hooked
  is asking the party under oversight to report its own oversight. The backstop
  is `scripts/protected-path-guard.mjs`, below, which asks from outside.
- **Latency.** Every gated tool call pays a Node start-up plus a verified read of
  the log. The read is accelerated when the daemon is running (see below);
  the start-up is not, and SPEC.md §13's post-v1 Rust fast-path is the
  accelerator for exactly this loop.

## Where the hook's reads come from (APRV-188)

A hook is a fresh process per gated tool call, so it starts with nothing
remembered and verifies the chain from genesis before it may decide anything.
That cost is linear in the log: measured on a ten-thousand-record log it was
65 ms of a 371 ms invocation, growing by about 6.5 ms per further thousand
records. The daemon, meanwhile, holds a warm cache and re-verifies only the
appended tail on every tick.

So the daemon publishes what it verified, at
`.approval/log/verified-head.json`, and a hook uses it instead of walking:

```json
{"v":1,"log":"/repo/.approval/log/events.jsonl","schema_dir":"",
 "byte_length":3391938,"sha256":"…","lines":10008,
 "head":{"seq":10008,"hash":"…"},"verified_at":"…","pid":812}
```

**It is an endorsement of bytes, not a source of records.** It says: the first
`byte_length` bytes of this log, whose SHA-256 is this, verified clean and end
at this head. The hook then, on its own:

1. reads the log itself and computes the SHA-256 of those bytes — the proof, and
   the same one the in-process cache pays on every cached read;
2. parses the endorsed lines itself and re-derives the head and the line count,
   so a snapshot naming a head those bytes do not reach is refused by arithmetic
   rather than trusted;
3. re-checks the chain links (`alg`, `seq` succession, `prev` linkage) over its
   own parse;
4. walks everything appended past the endorsed prefix in full, cold, exactly as
   it walks a whole log today.

**Anything it cannot prove, it ignores.** A snapshot that is absent, stale,
truncated, for another log, verified against other schemas, owned by another
user, writable by group or other, malformed, of an unknown version, or wrong in
any of the checks above is dropped without comment and the hook verifies from
genesis. There is no failure mode where a hook is *worse off* for a bad
snapshot; the worst case is the behaviour of a machine that has never run the
daemon. `approval doctor`'s `verified-snapshot` row says which of the two is
happening.

What the hook takes on the publisher's word is exactly two checks over bytes it
has itself proved are the bytes the publisher named: the `event` schema
validation and the per-record hash recompute. That residue is not a new
capability. A snapshot can only endorse bytes already in the log file, and
anyone who can write `verified-head.json` can write `events.jsonl` beside it —
where, the chain being unkeyed, they could recompute a self-consistent forged
log that passes a cold walk too. The ownership and permission checks are what
keep that sentence true under a loose umask.

The file is local, derived, gitignored, and never evidence. Deleting it costs
latency and nothing else.

## The backstop outside the session: `scripts/protected-path-guard.mjs`

Everything above runs inside the agent's session, which is the right place for a
gate and the wrong place for the gate's own audit. A session whose harness never
invoked the hook produces no evidence that it did not, so from the log alone
such a session is indistinguishable from one that never existed.

The guard asks the same question where the answer cannot depend on session
wiring: it takes two commits, asks git which protected paths changed between
them, and requires for each one evidence in the committed hash-chained log that
a human decided it.

```sh
node scripts/protected-path-guard.mjs --base "$(git merge-base origin/main HEAD)" --head HEAD
```

Exit 0 is a clean verdict, 1 is a protected path with no evidence (or a log that
failed closed), 2 is usage, 4 is "the guard could not look". Every blob it reads
comes from `git show <ref>:<path>`, never from the working tree: a guard that
read the checkout could be told a different story than the pull request carries.

### What counts as evidence

Three verdicts pass, ordered by how much they prove.

| verdict | what it establishes |
|---|---|
| `attested` | CONTENT-level. The policy file's bytes at the head commit hash to a digest some `policy.updated` record carries, which is what `approval policy amend --commit` writes. No grant is sought, which is how amendment pull requests pass — they have an attestation and would never have a `policy.edit` grant. |
| `granted-file` | HUNK-level. An `approval.granted` of class `policy.edit`/`policy.core` whose `payload_hash` resolves in the committed payload store to material whose `file` names this path. Since APRV-124 the hook binds the CHANGE rather than the touch, so the payload carries the exact edit, and since APRV-202 that is what is checked: the granted `after` bytes must occur verbatim in the blob at head, the `before` bytes in the blob at base, and the lines they contain are the ones they cover. |
| `granted-command` | ATTRIBUTED, one notch weaker. The granted command is re-run through this runtime's own `classifyCommand`, and it counts only when a segment classifies as a granting class BECAUSE of a word naming this path (`ClassifiedSegment.path`, or another word of that same segment that resolves exactly to this checkout's copy of the path — a batch names several files and the field holds one). A mention is not a grant: `cat SPEC.md` is `read.shell` and proves nothing. A command payload describes no bytes, so it covers the whole path only with the three tests below. |

There is deliberately **no class-level pass**. A `policy.edit` grant that exists
but names some other file is not evidence that anybody saw this edit, and
accepting it would let one approved edit launder every other edit beside it.
Class-level grants appear in the failure text as diagnosis, never as a verdict.
A grant whose payload the committed store does not carry is likewise not
evidence, and the failure names those hashes.

Where several grants qualify, the report names the strongest and then the
nearest, rather than the first one it happened to find. A true verdict resting
on a misleading reason is the kind of pass that survives review and then misleads
whoever reads the log after an incident.

### Grants go stale

Naming the path is necessary and not sufficient, because grants accumulate
forever: without a recency rule, a `git add SPEC.md` granted on 2026-08-20 passes
a SPEC.md edit made on 2026-08-29, and any path ever approved is approved
permanently. So evidence must also sit within seven days of the commit that
introduced the change, **on either side of it**. Either side, because both
orderings occur: a grant shortly before the commit is the ordinary case, and a
grant shortly after is the grant-follows-write anomaly (APRV-200), which is a
defect in its own right but a complete consent trail, and not this guard's to
adjudicate.

When git cannot date the change at all, no bound is applied rather than a weaker
one invented: a bound against the head commit would pass everything, since every
record in the log at head is already before it. The finding says which of the two
it got, every time.

The bound used to be the whole answer, and that was the guard's weakest joint: a
repeat edit to the same path inside the window inherited the earlier grant, and
PR #187, #196 and #207 each passed on a grant that authorized some earlier edit.
Since APRV-202 the window is a pre-filter and coverage is the verdict.

### Coverage: the change, not the path

The guard reads the blob at base and at head, reduces the difference to the
substantive lines added and removed, and requires every one to trace to the
bound material of some in-window grant. Coverage may be assembled from several
grants, and the finding lists every contributor.

- A **file grant** covers the lines its own `before`/`after` (or `content`)
  bytes contain, and only when those bytes are anchored: the after-state occurs
  verbatim in the blob at head, the before-state in the blob at base. A granted
  edit whose after-state is not in head approved something that did not land,
  and it covers nothing.
- A **command grant** has no bytes to check, so it is attributed instead, and
  three tests all have to hold. Its write has to land at THIS checkout's copy of
  the path (the payload's `cwd` joined with the repository-relative path equals
  the word the classifier matched); the log has to carry the RUN, an
  `execution.started` for the grant's `action_key`, because a grant nobody spent
  authorized a command that never ran; and that run has to sit within six hours
  of the commit and NOT after it, because a command's effect follows its own
  `execution.started`. The finding names the run it attributed the change to.
- A change that alters no substantive line (whitespace, a mode bit) has no hunk
  to cover, and a grant naming the path inside the window is still required. A
  change that only REORDERS lines is an uncovered hunk, not an empty diff.

Three limits, stated rather than buried. Coverage is by line text and not by
position, so an added line whose exact text appears in some granted edit counts
as covered wherever it landed; tightening that to positions would fail every
rebase and re-indent. Blank lines neither need coverage nor give it. And a
command grant still authorizes the whole file for the duration of its run, which
is as fine as a payload naming a script can get.

### The log lags, so ordering is a rule

The committed log on `main` trails the primary checkout's live log, because
advances land periodically as records pull requests. A grant made this morning
may not be on `main` yet, and the guard sees only the log the head commit
carries. That is an ordering rule rather than a bug to paper over, and every
failure states it: **the log advance carrying the grant must merge to `main`
before or with the protected-path pull request.** Each failure also names the
window it searched — the seq and timestamp range of the log at head — so a
reader can tell "the grant is not there" from "the grant is newer than this log".

### The evidence surface is not a protected write surface

`.approval/` is protected wherever it sits, and a records pull request changes
`.approval/log/events.jsonl`, the payload store beside it, and the regenerated
`QUEUE.md`. Demanding a grant for those would demand a grant for the evidence
and make it impossible to land the commits this guard reads. Exactly those three
prefixes are exempt, and they are reported by name in the output rather than
silently dropped. Everything else under `.approval/` — the vault, the
environment map — is still a protected write.

`policy.protected_paths` is read from BOTH sides of the diff and unioned, so a
change that drops an entry cannot un-protect the file it was protecting on the
way in. The built-in set of `core/command-class.ts` holds regardless, and the
guard shares that predicate with the hook: a CI guard whose idea of "protected"
drifted from the hook's would fail changes the hook already gated and pass ones
it would have caught.

### Fail closed

A missing log (`log-missing`), a log that does not pass chain verification
(`log-unverified`), a protected path nothing in the log names (`no-evidence`), a
change whose lines trace to no granted material even though grants DO name the
path (`uncovered-hunk`), and a change whose blobs could not be read at both
commits (`change-unreadable`) are all failures. The first two fire before any
evidence is sought, so an unreadable log is never mistaken for "no protected
paths changed", and records that have not passed verification are never read for
evidence at all (SPEC.md §11.1 invariant 1 applied to a new surface).

`uncovered-hunk` and `no-evidence` are separate because the reader's next move
differs. `no-evidence` says nobody approved anything about this file, and the
question is whether the hook fired at all. `uncovered-hunk` says somebody
approved something about this file and it was not this: the grant is real, the
consent trail for THESE bytes is missing, and the fix is to take the change to
the gate rather than to hunt for a lost record. The failure prints the uncovered
lines and why each naming grant was set aside.

### Prior art

An earlier attempt at this guard is PR #169 (`scripts/protected-grant-guard.mjs`,
unmerged). Two of its choices are worth recording because they differ. It
anchored paths against checkout roots recovered from the log's own worktree
summaries instead of matching path suffixes, which is stronger than what is
implemented here and remains the better answer to "two files with the same
repository-relative path in two checkouts". And it refused command-derived
grants outright, on the ground that the bytes a human read were the command line
and not the diff — correct as far as it goes, but it would fail the shell-granted
`CLAUDE.md` edits this repository actually makes, so the classifier-checked
`granted-command` verdict above is used instead. Its per-session census of hook
task ids is what established the root cause recorded in APRV-151.
