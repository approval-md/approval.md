# Changelog

All notable changes to `approval-md`, the reference runtime for the approval.md
convention. Versions follow the package; the SPEC keeps its own amendment
markers.

## 0.1.0 (unreleased)

The first release. Every milestone of SPEC.md section 14 (M0 to M8) is in it.

- **The policy file.** `APPROVAL.md` with one `yaml approval-policy` block:
  classes, six autonomy levels (`human-only`, `manual`, `supervised-live`,
  `supervised-retro`, `autonomous`, and the `supervised` alias), budgets,
  protected paths, the irreversibility floor, and attestation by content.
- **The log.** An append-only, hash-chained `events.jsonl` with schema
  validation at the write boundary, compare-and-append under concurrency,
  `log verify`, `log sync` and `log advance`, and conformance vectors a second
  implementation can run.
- **The gate.** `register`, `request`, `wait`, `grant`, `reject`, `revoke`,
  `withdraw`, `expire`; single-use execution tokens bound to payload bytes,
  delivered by hand or sealed to a per-request key; `run` and the adapter
  contract, with SMTP and AgentMail adapters that open a credential only inside
  a verified token window.
- **Channels.** Telegram (tap on a phone), a local web queue page, and the CLI.
- **Harness hooks.** `approval hook claude-code` and `approval hook cursor`
  classify every shell command and file edit a coding agent issues and answer
  from the policy; `approval mcp serve` exposes the agent surface over MCP,
  with a guest mode.
- **The daemon.** `approval up` runs the watch loop and every channel in one
  process: TTL expiry, retrospective sampling with an operator-held secret,
  loop escalation, projection write-back, and the log-advance cadence.
- **Retrospective review.** `audit list`, `audit review`, reconciliation
  obligations for a denied action, and human-signed checkpoints.
- **Both directions of "approval".** The journal (`journal write`) is the
  agent's ungated outlet; the values block (`approval values`) and graded
  reactions (`approval feedback`) are the human's, and neither reaches
  enforcement (SPEC section 11.1, invariant 10).
- **Interop.** Backlog.md task files carry the approval envelope with byte
  round-trip fidelity; `import agents-md` drafts a policy and a values block
  from AGENTS.md prose.
- **Diagnostics.** `doctor`, `status`, `coverage`, `policy check`, `policy
  test`, and machine-readable `--json` on every verb with the schemas printed
  by `instructions --schemas`.
- **A hook timeout neither floods the phone nor feeds the escalation**
  (APRV-287). An expired wait keeps its question open for a retry grace
  (`--retry-grace`, default 5 minutes) and then withdraws it with reason
  `timeout`, so a tap on it authorizes nothing and says so; a listener starting
  or reconnecting collapses the requests older than that line into one message
  with a single reject-all instead of one message each; the several classes of
  one command are delivered as one card with one approve, with the command's
  bytes sent once; an expired wait and a harness-side misfire are not executions
  and accrue no loop-safety streak; and a completed command clears the floor
  even when the grant it ran on was carried by a later tool call.
- **The harness counterpart reads the payload Claude Code actually sends, so a
  completion can clear a floor again** (APRV-303). The post-execution hook asked
  `tool_response.type` to be `text`, `base64` or `error`, which is the shape of
  an API content block and is not what any gated tool emits: `BashOutput` and
  `FileEditOutput` carry no `type` at all and `FileWriteOutput`'s is `create` or
  `update`. Every successful tool call was therefore reported
  `post-tool-unreadable-outcome` and appended nothing, while every failure landed
  through `PostToolUseFailure`, so the loop streak of SPEC section 10.2 could
  only ever count up and every long session escalated itself to manual and stayed
  there. Measured on this project's own log before the fix: 22062 harness starts,
  10 reports, and not one completion from the Claude Code adapter. The reading is
  now the event name, which is the harness saying which of its own two code paths
  ran, refined only in the strict direction: an interrupted call is unreadable
  and appends nothing, and an `error` field or `type: "error"` is a failure
  whatever the event claimed. The report still chooses neither the bucket nor the
  execution it closes; both come from the `execution.started` this runtime wrote.
- **A report that does not land is seen** (APRV-303). Claude Code discards a
  hook's stderr when the hook exits 0, so the counterpart's machine-readable
  refusal lines were written to a debug log nobody opens, which is how 22052
  unreported starts accumulated without a visible complaint. The counterpart now
  exits 0 for `post-tool-reported` and 2, the harness protocol's "show this
  line", for every code that means an outcome went unrecorded. Exit 2 blocks
  nothing on a post-execution event, and a throw on that path reports
  `post-tool-io` instead of printing a permission verdict about a tool call that
  has already run.
- **The loop floor sees every tool kind** (APRV-303). An edit the policy does not
  protect now carries the class it always deserved, `files.write.workspace`, and
  reaches the floor by the same predicate a shell write does. With no floor
  standing it is allowed outright with nothing appended, as before; with a floor
  standing it is routed like any other write, and its completion clears the floor
  like any other write's. Until this, the file path answered `allow` from above
  the floor lookup, so a session whose Bash calls were all going to a phone went
  on editing files unrouted and uncounted.
- **The CI guard's dependency floor reads the install Node would read**
  (APRV-298). The case that proves every production dependency admits the Node
  floor used to join the repository root to a literal `node_modules`, so running
  the suite from an agent worktree, which has none of its own, failed with
  ENOENT and reported a missing install as a violated floor. It now resolves
  each dependency's `package.json` the way module resolution does, walking up
  from the test file, and skips by name when a package is absent from every
  `node_modules` on that path. A manifest that does not name the package it
  claims to be fails the case, which keeps `@modelcontextprotocol/sdk` from
  answering with the `dist/cjs` stub its wildcard export maps the subpath to.

- **Amending the policy stops being a code change** (APRV-296). The pins in
  `src/core/policy-expectations.ts` are a safety floor rather than an inventory:
  they name the `human-only` classes, the `manual` classes whose effects leave
  the repository or cannot be undone, and the fail-closed default reached
  through classes the policy deliberately does not declare, and each pin's note
  says what loosening it would cost. A class the policy declares and no pin
  names is accepted, so declaring a `supervised` or `autonomous` class, tuning a
  live rate or changing `approval_ttl` needs no edit to the code and no rebuild;
  the dogfood suite pins the fail-closed defaults (`manual`, `reject`, a TTL
  that exists and is positive) instead of the exact duration. The amend diff's
  key vocabulary is read from `schema/policy.schema.json`, so the `daemon.*`
  block the schema has admitted since APRV-217 no longer renders as an UNKNOWN
  KEY warning over a policy that loads cleanly.

- **A rendering of the log can no longer refuse a pull of it** (APRV-292).
  `log sync` treats `.approval/QUEUE.md`, and the index projection when git
  carries one, as disposable: the working copy is discarded as the last
  statement before the fast-forward and rebuilt from the reconciled log
  afterwards, with one retry when the renderer beats the merge to the file. An
  upstream records commit that touches the queue no longer refuses with git's
  "local changes to .approval/QUEUE.md would be overwritten" while the daemon
  re-renders the projection, and the stop-the-daemon workaround is retired. The
  working log's snapshot and restore are untouched.

- **An untracked task file no longer stops `approval up`'s fast-forward**
  (APRV-300). A lane files `backlog/tasks/aprv-299` on its branch and its pull
  request merges while the primary checkout holds that path untracked from its
  own `backlog task create`, and `git merge --ff-only` will not write over an
  untracked file. The preflight now reads each collision against the incoming
  blob: byte-identical is removed, a copy whose every line the incoming file
  already carries is moved to a dated sibling of the checkout with the
  destination printed on the warning line, and the merge is retried once.
  Anything else refuses `up-preflight-task-file-conflict` (a fourth member of
  the frozen refusal union) with both paths and the count of lines only the
  local copy has. Every file is judged before any file is touched, as in
  APRV-225's payload reconciliation, and a collision anywhere but
  `backlog/tasks/` declines the whole set and keeps the old refusal.

- **The hook waits for a lagging verified view instead of denying on it**
  (APRV-294). Minutes after a `log sync` and a daemon restart, a hook appended
  its requests, re-read the log, found its own keys in state `none` and denied
  `hook-io` on the spot; the questions were live and the taps that answered them
  authorized nothing. A log is append-only, so `none` for a key this hook
  appended describes the view rather than the request: the hook now keeps
  waiting, bounded by the same timeout, says on stderr that the view lags, and
  names the repair if the wait runs out. On the same fault's other face, the
  open-window verdict and the `gate.bypassed` record that authorizes it are one
  verified read, and a window that ends in between refuses with its own code
  (`gate-window-closed`) naming the closing seq or the expiry, in place of the
  `gate-not-open` that claimed there had never been a window. Neither refusal
  appends anything or counts as a failed side-effecting call.

- **A tripped loop floor routes side effects and leaves reads alone**
  (APRV-297). APRV-280 stopped a failed `read.*` accruing the floor; a floor that
  had tripped still routed every later read to a human, so a session that could
  not get an answer could not even search the repository, at one phone message
  and one nine-minute wait per `grep`. A tool call whose classes are all `read.*`
  is now answered by the policy under a tripped floor, and says in its allow that
  a floor is standing and was not applied to a read; a mixed call is still routed
  as one question about its side effects, with its read classes neither counted
  nor separately raised; the write boundary carves reads out with the same
  predicate; and a read still clears nothing, so nobody reads their way out from
  under a floor. `approval status` and the floor's own refusals say so.

- **The retrospective sample reaches the approver's phone** (APRV-299). Each
  `audit.sampled` with no later `audit.reviewed` is delivered by the Telegram
  channel as a review card: what ran (class, command breakdown, task, the
  agent's summary), when it ran, and that the runtime allowed it without
  asking. It carries no payload block and no approve button, because the action
  has already happened and nothing on the card authorizes anything. Six buttons
  record the verdict and the grade — OK, Deny, and the four reactions — with a
  reaction alone implying OK, Deny taking two taps and naming the reconciliation
  obligation it opens, `loved` and `disliked` asking for the human's words as a
  reply before anything is appended, and every refusal in
  `audit_refusal_codes` rendered on the card. Delivery is paced like requests: a
  summary line, then one card, and never while a request is in front of the
  approver; navigation decides nothing and a card nobody sees leaves its sample
  open and reviewable with `approval audit review`. Every append goes through
  the same `reviewSample` the CLI verb calls, so `approval feedback` shows a
  grade given on a phone exactly as one given at a terminal.

The publish itself is the first `release.publish` action to pass through this
gate (APRV-199).
