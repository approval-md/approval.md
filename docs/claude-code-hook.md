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
classified, and the command's classes are the union: `git status && curl …` is
gated as `network.call`.

### The rule table

One row per binary group. The first row whose binary and subcommand match
decides; a row with more than one class in the last column reads the flags before
answering (`git push --force` is a rewrite, `npm install` with no package is not
an addition).

| rule | binaries | subcommands | classes |
|---|---|---|---|
| `git-push` | git | push | vcs.push.main, vcs.push.branch, vcs.history.rewrite |
| `git-rewrite` | git | rebase \| filter-branch \| filter-repo | vcs.history.rewrite |
| `git-reset` | git | reset | vcs.commit.branch, vcs.history.rewrite |
| `git-commit` | git | commit | vcs.commit.branch, vcs.history.rewrite |
| `git-branch` | git | branch | read.shell, vcs.commit.branch |
| `git-tag` | git | tag | release.publish |
| `git-clone` | git | clone | network.call |
| `git-write` | git | add \| apply \| checkout \| cherry-pick \| merge \| mv \| pull \| restore \| revert \| rm \| stash \| switch \| worktree | vcs.commit.branch |
| `git-remote-read` | git | fetch \| ls-remote \| remote | read.vcs.remote |
| `git-read` | git | blame \| describe \| diff \| grep \| log \| ls-files \| reflog \| rev-list \| rev-parse \| shortlog \| show \| status | read.shell |
| `gh-release` | gh | release | release.publish |
| `gh-api` | gh | api \| auth \| gist \| secret \| workflow | network.call |
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
| `network` | curl, wget, ssh, scp, sftp, rsync, nc, telnet, ftp, http, httpie | (any) | network.call |
| `read-shell` | basename, cat, cd, cksum, cut, diff, dirname, du, echo, false, file, find, grep, head, jq, ls, md5sum, printf, pwd, readlink, realpath, rg, shasum, sha256sum, sort, stat, tail, test, tr, tree, true, type, uniq, wc, which | (any) | read.shell |

Three overrides sit on top of the table:

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

Stricter-when-unsure, throughout: `git push` with no refspec is `vcs.push.main`,
an `rm` path holding an unexpanded `$VAR` is `files.delete.out_of_scope`, and a
remote-branch deletion takes the trunk class rather than the branch one.

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
| `hook-timeout` | no decision inside `--timeout`; the request stays live until TTL, a retry files a new one |
| `hook-gate-refused:<code>` | the gate refused intake; `<code>` is its own frozen refusal code |
| `hook-policy-unavailable` | `APPROVAL.md` could not be loaded |
| `hook-log-unreachable` | no log where the hook was pointed; it writes to an existing log and creates none |
| `hook-io` | malformed hook input, or an unreadable log |

`hook-opaque` is the one worth knowing by sight. `bash -c …`, `eval`, `source`,
`sudo`, `env`, `xargs`, `node -e`, `python3 -c`, backticks, arithmetic expansion,
and any `$(…)` that is not purely a read: all deny. The fix is to write the
command out, or to run the effect through `approval run` with a granted token.

A `hook-timeout` leaves the request live until its TTL, but a late grant on it
authorizes nothing: a retried tool call is a new `tool_use_id`, so it files a
new request (an idempotency key names one execution of one side effect, SPEC
§6). Raise the hook `timeout` and `--timeout` so decisions normally land inside
the wait, and treat a timed-out request as one to reject from the queue.

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
