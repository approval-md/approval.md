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

The publish itself is the first `release.publish` action to pass through this
gate (APRV-199).
