# Changelog

All notable changes to `approval-md`, the reference runtime for the approval.md
convention. Versions follow the package; the SPEC keeps its own amendment
markers.

A released version's heading is exactly `## X.Y.Z — YYYY-MM-DD`: a canonical
stable version, an em dash, an ISO date. That is an interface, not a habit.
`publish.yml` reads the matching section and publishes it as the body of the
GitHub Release for the tag (`scripts/release-notes.mjs`, APRV-396), so a tag
whose section is missing, undated or duplicated fails the release run before
anything reaches npm. `## Unreleased` carries no version, which is what keeps
it from ever being published as a release body; dating it is the last edit
before a tag.

## Unreleased

### Channels

- **A minimal Telegram card, chosen by the attested policy (APRV-489).**
  `channels.telegram.prompt.style: minimal` sends each approval as one short
  message in plain words: a bold headline the runtime computes from the class
  ("Your agent wants to …"), the payload's own words quoted from the bound
  bytes, any model or agent description labelled "not checked" below them, a
  deadline line ("Open for about 3 days. If you don't answer, your agent will
  not do this."), Approve and Deny, and the whole technical card, canonical
  rendering included, collapsed in the same message under "Full details".
  `channels.telegram.prompt.say` holds the operator's phrase per exact class
  name and the closed field set of an opaque payload. The box holds payload
  values only, verbatim; a cut value, a command not shown as written and a
  field left off are announced under it. Anything the card cannot draw
  honestly gets the technical card (attestations, policy edits, truncated
  payloads, abnormal health facts, undeclared or unlisted payload keys,
  batches and digests, cards over 3800 characters, a card the Bot API
  refuses), and the decision record states what was shown in
  `payload.rendering` (an open field in this release). Style and `say` are
  read for each card, so a re-attested setting needs no restart. `technical` stays the default and its bytes are
  unchanged; review cards, their note prompt and checkpoint prompts are the
  same under both styles; `web` and `cli` ignore the key. SPEC §10.3 and §5.2
  are amended (pending sign-off). **Rollout order:** an older core refuses the
  new keys and fails the whole policy closed to all-`manual`, so a policy may
  carry them only once every daemon reading it runs this release.

- **A relayed Telegram channel refuses a button it did not send (APRV-456).**
  With `--api-base` naming anything but the Bot API, or with the new
  `--no-stale-copy` flag (on `approval channel telegram listen`, `channel
  telegram webhook` and `approval up`), a decision tap whose nonce the listener
  is not holding is refused `nonce-not-issued` and is never carried to the gate
  by its action reference. Behind a relay anyone holding its token could put a
  card with forged text and a real pending action's reference in front of the
  approver, and APRV-196's earlier-copy fallback would have decided it on the
  approver's genuine tap. The refusal appends at most one
  `audit.decision_refused` and leaves the live card armed, and the restart
  banner stops promising that earlier copies still decide. The direct-bot shape
  is unchanged. `nonce-not-issued` joins `channel_decision_refusal_codes`, so
  `refusal-unions` is 28.0.0. Behavior change: a relayed listener (the Agent
  Village shape) no longer honours taps on cards sent before a restart.

### Harnesses

- **Every harness hook: a SIGTERM mid-wait withdraws the question, answers in
  that harness's own deny, and a grant after the harness gave up starts nothing
  (APRV-475).** `approval hook claude-code`, `cursor`, `codex`, `grok` and
  `muse` now drive their wait through the same yielding driver Hermes got in
  APRV-473, so a SIGTERM or SIGINT during the wait reaches the wait's handler
  within one poll. Before, the signal was held until the wait returned and then
  discarded with the wait's listener, so the hook answered whatever the wait
  reached, and a grant that landed meanwhile was recorded as `execution.started`
  for a call the harness had abandoned. The handler first prints the harness's
  ordinary deny under the `hook-interrupted` code, at that harness's deny exit
  code (the nested `hookSpecificOutput` deny at exit 0 for Claude Code, Codex
  and Muse, `{permission:"deny"}` at exit 0 for Cursor, `{decision:"deny"}` at
  exit 2 for Grok), then withdraws the question this invocation opened; Hermes
  now prints before withdrawing too, so a withdrawal waiting on the log's lock
  never delays the block. A short or failed write of the directive exits 2. A
  later grant is refused `request-withdrawn`; a grant that landed first is left
  unspent. The pause before every spend is the one APRV-473 added, shared by
  all six harnesses. Same poll cadence, same `--timeout`. A signal before the
  wait still takes the default disposition on these five (APRV-477); a signal
  while the spend waits for the log's lock is covered by APRV-478, below.
- **Every harness hook: a signal while the spend waits for the log's lock blocks
  instead of being dropped (APRV-478).** After the wait found a grant and passed
  its pause, the spend still waited for `events.jsonl.lock` synchronously (up
  to two seconds per attempt, behind the daemon or any other writer), so a
  SIGTERM in that stretch was held, the grant was recorded as
  `execution.started`, the allow was printed, and the signal was then discarded
  with the wait's listener; the same on all six harnesses. The wait for the
  lock now runs on the event loop: while another writer holds it the hook
  sleeps on a timer and tries every 20 ms, and the pause before the spend comes
  after that wait, immediately before the spend's one try at the lock. A signal
  during the wait gets the harness's `hook-interrupted` block, nothing is
  spent, and the grant stays standing for a retry to carry. The same applies to
  the unattended and autonomous charges and to an open window's `gate.bypassed`.
  What remains between the last pause and the record is the spend's own read
  and its single try at the lock; a try that loses the race goes back to
  waiting on the event loop until the same two-second bound, and a spend that
  still has no lock then denies with `append-failed` (`lock-timeout`). A budget
  refusal's `budget.exceeded` record gets the same retries. A command with
  several gated classes spends them one at a time, each behind its own pause,
  so a signal between two of them blocks with the earlier starts already
  recorded. The trade: the spend's read now sits between seeing the lock free
  and trying it, so a lock that is only ever free for gaps shorter than that
  read can run a CLI spend out of its bound (deny, the grant left for a retry)
  where the old synchronous wait got through. `approval serve`, the Codex
  bridge and in-process `commandHook` are unchanged: they drive the steps
  synchronously, have no event loop to wait on, and keep the writer's own
  synchronous wait exactly as before.
- **`approval hook hermes`: a SIGTERM mid-wait withdraws the question, and a
  grant after Hermes gave up starts nothing (APRV-473).** The CLI hook run was
  synchronous end to end, so a SIGTERM during the wait (Hermes's own hook
  timeout, a gateway shutdown) was held until the wait returned; a human who
  granted meanwhile got `execution.started` recorded for a call that never ran.
  The wait's pauses now run on the event loop, on the same cadence and inside
  the same 240 s window, so the signal reaches the wait's handler within one
  poll: it withdraws the question this invocation opened, prints the
  `hook-interrupted` block directive and exits 2, and a later grant is refused
  `request-withdrawn`. The hook also passes through a poll phase of the loop
  before every `execution.started` or `gate.bypassed` append, so a signal held
  through the stdin read blocks instead of spending. `approval serve` and the
  Codex bridge run the same steps synchronously, unchanged (the other CLI
  harnesses followed in APRV-475); serve already noticed a departed client at
  every poll and never spent a grant on its call.
- **`approval hook hermes`: a signal while the runtime is still loading no
  longer kills the hook silently (APRV-466).** The runtime's SIGTERM/SIGINT
  guard exists only once `dist/` has loaded, so a signal during that load
  (Hermes sends SIGTERM on its hook timeout and on gateway shutdown) took the
  default action: death with an empty stdout, which a stock Hermes reads as an
  allow. The `approval` bin now installs a guard in its first statements when
  argv names the Hermes hook. A signal it hears during the load gets the
  runtime's own `hook-interrupted` block directive, byte for byte, at exit 2; a
  signal held until the synchronous hook run returns ends the process with the
  verdict that run reached. The runtime raises a flag while its own guards are
  registered and the bin steps aside for it, so the two never both print. Every
  other verb and every other harness hook keeps the default disposition. What
  remains is Node's own bootstrap before the bin's first statement, which the
  gated image's `shell_hooks` patch is there to cover on Hermes's side
  (docs/hermes-hook.md, "Two layers against a signal").

## 0.4.0 — 2026-10-04

Written on 2026-10-04 against `main` at `70979abe`, 239 non-merge commits after
`v0.3.0`. This is the Agent Village build. An agent behind `approval serve` can
declare and ask in one call (`approval propose`, open to a class through the new
per-class key `agent_may_request`) and record what it carried out (`approval
start`); `serve` listens on a unix socket (`--listen unix:<path>`) and runs hook
calls off its listener thread (APRV-427); `approval wait` refuses a task the log
never registered (APRV-428). The Hermes adapter classifies the tools it used to
wave through and blocks on every error path. A human decision gains a new
arrival: the `edgeos` sender channel over the authenticated `approval channel
relay` transport, beside the new Telegram webhook. Every log append and every
stored payload is fsynced before the verb reports ok; `execution.started` names
the attested policy it ran under (`policy_sha256`); `approval serve` and the
Telegram webhook stamp the daemon id on what they write; a refused Telegram tap
no longer kills the live prompt; and `approval policy attest --bootstrap` gives
a hosted tenant with no shell its first policy. Additive at the package boundary
apart from the behavior changes listed last, so this is a minor bump. The tag,
its push and the Trusted Publishing run are gated `release.publish` acts
(APRV-453).

### The agent surface and `approval serve`

- **`approval serve`, the agent-facing surface over HTTP (APRV-421).** A
  foreground HTTP server for a harness that has no local log and no local
  policy: a sandboxed tenant whose daemon runs elsewhere, one process per
  tenant. It publishes the same registry-derived catalog as `approval mcp
  serve` (human-only verbs absent, `--as` stripped, identity fixed at launch,
  refusals returned as results) and adds the three routes the MCP transport
  withheld: `POST /hook/<harness>` takes the harness envelope as its body and
  answers the verdict the stdin form prints; `GET /log/follow` pages the
  verified log by an exclusive `(seq, hash)` cursor with SPEC §8's subscription
  semantics; `GET /export` returns the store as an archive, taken under the
  append lock. Two bearer credentials come from the launch environment.
  `APPROVAL_SERVE_AGENT_TOKEN` opens an allowlist (`instructions`,
  `hook_classify`, `request`, `wait`, `withdraw`, and since APRV-445 `propose`
  and `start`); `APPROVAL_SERVE_TENANT_TOKEN` opens follow, export, status and
  every other published verb, so the agent credential never reads the log it is
  judged by. Store roots are pinned, every path flag is confined, and the
  listener binds loopback unless `--allow-non-loopback` says otherwise. It is a
  transport: every verdict comes from the function the CLI dispatches to.
- **An agent can declare and ask in one call, with the payload inline
  (APRV-445).** `approval propose --class <c> --key <k> --summary <s>
  --payload-json <json>` registers a one-action envelope and requests it,
  for a requester with no file on the gate's machine (an agent behind
  `approval serve`, which refuses every path flag). The class must be an exact
  key of the policy's `classes`, opened to agents with the new per-class key
  `agent_may_request: true` on itself or on a declared `<prefix>.*` family;
  anything else refuses the new code `class-not-agent-requestable` and registers
  nothing. The task id is derived from the actor, class and key, so a retry with
  the same bytes appends nothing (`idempotent: true`). `approval start <task>
  --action <k> --payload-json <json>` records the `execution.started` for a
  proposed action its requester carries out, requester-only and bound to the
  proposed bytes, through the existing harness-grant and policy-start paths.
  Both are on the serve agent surface. `policy check` reports `agentRequest`,
  and `policy amend`'s diff reports a change in it. Payloads over 256 KiB refuse
  `payload-too-large` (exit 2).
- **Proposals after review (APRV-445).** `approval wait` reports what a request
  still authorizes: a grant whose window lapsed is `expired` (exit 3), and a
  grant or pending request pinned to a re-attested policy is `void`, a new exit
  code 7 meaning "ask again". `propose` re-files in exactly those cases instead
  of answering a dead grant idempotently, and answers `state: executed` after
  `start`. New refusals `task-is-proposal`, `task-not-proposal` and
  `key-class-mismatch` (the key must begin with `<class>:`); key and summary
  caps; lone surrogates and non-finite numbers are usage errors. Proposals are
  never collapsed, superseded or ordered as stale by the Telegram channel.
- **Proposals after the recheck (APRV-445).** `wait` voids a grant only where
  its spend enforces `policy-drift` (harness grants, every proposal): a token
  grant `approval run` still spends after a re-attest reads `granted`. `propose`
  re-checks its decision inside the append, so concurrent identical proposals on
  a void key withdraw it once and ask once, and a stale caller cannot ask again
  over a fresh grant. `wait` reports `executed` for a policy-path start after a
  withdrawal; key ids must be printable; the muse registration route refuses
  `propose:` ids. `propose` ends a lost race with the new refusal `contended`
  instead of `already-decided`.
- **`start` never turns a human's no into a policy start (APRV-445, security
  pass).** On the policy path, a proposal's start now refuses `not-granted` when
  the key has a pending or granted request (re-checked inside the append), when
  its latest request was rejected or revoked under the policy in force, and when
  the class is `supervised-live` and the draw selects the bytes. Before this a
  selected live proposal that a human rejected, or that the agent withdrew or
  let expire, could start with `authorization: policy` and no grant. An
  unselected live proposal still starts on the policy path.
- **`approval wait --timeout 0` reads the current state and never sleeps
  (APRV-445),** so a poller through `approval serve`, which runs every call
  through one queue, no longer holds the tenant's hook traffic for the length of
  a wait.
- **`approval wait` refuses a task the log never registered (APRV-428).** It
  used to answer `granted` with no actions. It now refuses `not-registered`
  (exit 1). A registered task with no requests, or with every grant already
  spent, answers `nothing-to-wait-for` (exit 0), and `granted` means an unspent
  grant exists, with byte-identical output. The refusal passes through
  `approval serve` unchanged, and the agent-facing text no longer reads a
  `wait` exit 0 as a grant.
- **`approval serve --listen unix:<path>` (APRV-445),** also
  `APPROVAL_SERVE_LISTEN`: a unix-domain socket, opened 0666 in a directory the
  serving uid must own (the directory is the access control). A stale socket is
  replaced, a live one or a non-socket file is refused. The socket refuses an
  other-writable directory and only unlinks a socket a connect proves dead.
- **One waiting hook no longer stalls the tenant's facade (APRV-427).** `approval
  serve` runs hook calls on a bounded pool of worker threads (`--hook-threads`,
  default 16; `--hook-queue`, default 64) that hold the per-store lock only
  while they append and release it during the poll, so verbs, `/status`,
  `/log/follow` and `/export` answer while a hook waits on a human. Past the
  pool a call is refused `serve-hook-saturated` (HTTP 503, a hook-dialect block,
  nothing appended), with the harness-cap budget charged from the call's
  arrival. A torn-tail read in the poll is read again; a caller that
  disconnects stops without spending; shutdown cancels before it destroys; the
  store lock is keyed by the log directory's realpath.

### Gate and guard

- **A grant over a script binds the script's bytes (APRV-401).** The `approval
  run` payload now carries the script's argv index, absolute path, byte count
  and SHA-256 inside the hashed value, when the argv is a known interpreter
  followed by a path operand or a path at `argv[0]` with a shebang behind it. A
  script edited between the declaration and the run hashes differently and
  takes the existing `payload-mismatch` refusal, before the append and before
  the child. The key is omitted when the argv names no script, so every earlier
  record and declaration still verifies. New verb `approval payload run`
  produces those bytes or their hash for the requester; it is withheld from the
  MCP and HTTP surfaces, because the path it digests is a command word no
  transport guard confines. No new refusal code, event type or schema.
  `docs/run-payload-binding.md` carries the SPEC §6.2 hunk for a human to
  apply.
- **A workspace write is checked against the disk, and some of them are now
  questions (APRV-402).** `files.write.workspace` used to be decided on the
  command text alone, so a relative destination was the workspace whatever a
  symlink on the way to it pointed at. The hook now resolves each destination
  through its nearest existing ancestor, the same walk the delete and read
  rules have used since APRV-267 and APRV-347, and tightens to
  `files.delete.out_of_scope` with the rule string `write-out-of-scope-resolved`
  when the result lands outside the working directory and every scratch root.
  **What a live session will feel:** any `cp`, `mv`, `tee`, `mkdir`, `ln`,
  `chmod`, `truncate` or `rmdir`, and any packaging write (`tar -x -C`,
  `tar -c -f`, `gunzip`, `base64 -o`, `openssl dgst -out`,
  `npm pack --pack-destination`), whose destination resolves outside those
  roots now routes to a human instead of running. That includes an ABSOLUTE
  destination inside another checkout, which was previously autonomous, and it
  includes a destination that is under the temp root only through a symlink.
  The pass can only ever narrow, no new class is minted, and the pure
  classifier is unchanged. `rm` of a relative path in the workspace and a shell
  redirect into one still answer from the text.
- **The read-only packaging and archive tools classify (APRV-397).** A
  package-manager version probe, `npm pack`, `npm init`, `tar`, `gunzip`,
  `base64` and the `openssl` digests are classified instead of refused: each
  reads what it names or writes into a destination it names, and a destination
  outside the workspace and the scratch roots answers
  `files.delete.out_of_scope` with the path bound. `git tag` with a listing
  flag reads; every creation, deletion, force-move, signature, bare name and
  unrecognised flag stays `release.publish` where APRV-305 put it. Conformance
  `command-class` 1.4.0.
- **A quoted sentence that opens with a protected path is prose (APRV-409).** A
  positional word whose protected match comes entirely from a whitespace-free
  head is skipped by the positional scan, so a task acceptance criterion that
  begins with a workflow path classifies `files.write.workspace` instead of
  `policy.edit.ci`. Redirection targets, apply-patch, the protected-path guard
  and the hook's file-tool pass are untouched. Conformance `command-class`
  1.5.0.
- **A decision that lands after the hook's retry grace authorizes nothing
  (APRV-410).** The abandoned-question sweep now also runs on the hook's
  autonomous path, from the verified read that call already makes, so the
  asking actor's next tool call of any class takes back a question nobody
  holds. A granted request whose decision is later than the request plus the
  hook's wait and grace no longer carries to a retry, which asks again. The
  `hook-timeout` deny text and `docs/claude-code-hook.md` say who withdraws and
  why nobody else may. A distinct refusal at the decision surface for a
  past-grace tap is still open (APRV-410 AC2).
- **The harness's own ceiling bounds the question (APRV-423).** The hook states
  the harness ceiling (`--harness-cap`; Hermes assumes 30 s unless stated,
  clamped at its 300 s maximum) and records it as `harness_cap_ms` on
  `approval.requested`. One derivation judges every lapse against the policy
  TTL or the cap less a 60 s margin, whichever is shorter, so the gate, the
  sweep, the carry lookup, the queue and the channels agree that a request
  expires before the harness kills the hook that asked. The hook's own wait is
  clamped to what the ceiling leaves; a cap with no room for a human is denied
  `hook-harness-cap-too-short`; `approval serve` gains `--hook-harness-cap`.
  Conformance `schema-validation` 2.8.0.

### Harnesses

- **`approval hook hermes`, the Nous Research Hermes Agent adapter (APRV-398,
  corrected against a live probe in APRV-415).** The sixth harness, and the first
  since Claude Code whose hook is a **gate rather than a backstop** — measured, not
  documented: on Hermes `main` at `118984d7` a per-entry `fail_closed: true`
  BLOCKED an armed hook crash, armed garbage output and an armed hang (at the 300s
  per-entry cap), three of three. Its default is `false`, it does not cover a hook
  that exits non-zero printing nothing (which is why this adapter's deny exits 2,
  blocking unconditionally), and **there is a version floor**: `v0.21.3` (build
  2026.9.14) does not know the key and fails open silently, both builds report the
  same semver, and `hermes hooks list` shows no flag either way, so
  `core/harness-version.ts` compares the build date and the upstream commit and
  `approval doctor`'s `harness-version-unverified` row fails below the floor. Its
  event names are its own (`pre_tool_call`, `post_tool_call`), its verdict is a
  third dialect (`{action,message}` at exit 2 for a deny; **`{}`** at 0 for an
  allow, because Hermes has no allow directive), and `execute_code` is refused
  outright with a new code `hook-hermes-execute-code-unbound`: it carries a program
  and no path, no argv and no working directory, and its kernel can call the other
  tools in-process where the hook may not see them. It is also the first harness
  whose gate organ lives OUTSIDE a checkout — `$HERMES_HOME/config.yaml`, with no
  project-local directory anywhere — so `.hermes/config.yaml`,
  `.hermes/agent-hooks/` and `.hermes/shell-hooks-allowlist.json` classify
  `policy.core` at any path position, while `$HERMES_HOME/.env` and
  `auth.json` classify `account.credential`. Name the home explicitly and spell its
  last segment `.hermes`: the classifier recognises the organ by that segment and
  nothing else.
- **A Hermes call whose working directory the event does not carry is refused
  (APRV-415).** The same live probe found that the envelope's `cwd` is the Hermes
  PROCESS directory, that `terminal` keeps a per-session recorded directory an
  earlier `cd` moves and that no field of the event reports, and that all four file
  tools resolve relative paths against THAT — observed as a refused write reappearing
  under `$HERMES_HOME/cache/scratch` and a gateway session's write landing in the
  user's home. So a `terminal` call with no absolute `workdir`, and a `write_file`,
  `patch`, `read_file` or `search_files` call whose path is relative or missing, are
  refused with `hook-unsupported-execution-context` and a reason naming the retry, so
  the session repairs itself on the next call. It is the Codex `Bash` refusal
  (APRV-310) one harness along, and it covers every gated tool because the probe
  watched the model answer a block by retrying the same effect through another one.
  `--dir` is now mandatory in gateway deployments for the same reason. Two related
  corrections: a `post_tool_call` event is **not** evidence the tool ran (it fires
  for a blocked call and after a refused timeout), so one carrying no readable result
  is now unreadable rather than a completion; and the `hook-read-scope` conformance
  suite goes to **2.0.0**, a major bump, because two expectations moved — a relative
  Hermes read and a Hermes `search_files` naming no path used to allow and now deny.
- **The Hermes adapter classifies the tools it used to wave through
  (APRV-445).** `cronjob_manage` (and `cronjob`) actions that change the
  schedule are `cron.manage`, `process_manage` (and `process`) writes are
  `process.write`, every `browser_*` is `browser.exec`, `skill_manage` is
  `skill.manage`, `delegate_task` is `agent.delegate`, `send_message` is
  `message.send`; list/poll/log/wait actions stay reads. Writes under
  `.hermes/scripts/` are `cron.manage`, and `.hermes/approval/` and the
  allowlist's `.lock` sidecar join the `policy.core` organs. Writes to
  `.hermes/.env`, `.env.*` and `auth.json` are `policy.core` (reads stay
  `account.credential`, now through `read_file` too), and a Hermes `terminal`
  call's relative words are also judged against its `workdir`.
- **The Hermes path rules fit a hosted home (APRV-445, recheck 3).** Only the
  home's own directories (root, profile homes, `approval/`, `scripts/`) and the
  approval home are organs; `workspace/`, `skills/` and the rest are ordinary
  work, so `grep -r`, `find`, `rm -f *.tmp` and friends run there again. An
  unresolvable `cd` makes later relative paths conservative; globs that could
  name the home or an organ, globbed credential reads and `<` reads are caught;
  copies into a directory, `tar -x` and `unzip` are judged by where their files
  land; profile homes carry the home's organs. The `terminal` path resolver
  follows `cd`, `$HERMES_HOME`, heredocs, globs and symlinks, resolves only
  write positions, and read tools treat a directory under `.hermes`/`.approval`
  as credentials.
- **The Hermes hook blocks on every error path (APRV-445).** A pre-event answer
  is either the adapter's own `{}` allow or a `{"action":"block"}` directive at
  exit 2: a misconfigured hook entry, a throw, a signal mid-wait, a path that
  reached no verdict, and a module that fails to load all print the directive.
  Hermes reads any other non-zero exit with an empty stdout as an allow.
  `cli.js` itself answers `approval hook hermes` with the block directive when
  the runtime cannot load, and the bin's guard covers `--no-color` and any
  silent non-zero exit.
- **A signal before the wait no longer kills the Hermes hook silently
  (APRV-445).** `approval hook hermes` used to handle SIGTERM and SIGINT only
  once it was waiting on a human. A signal that landed earlier (for example
  just after the request was appended) killed it with nothing on stdout, which
  Hermes reads as an allow. The CLI hook now guards its whole run: such a
  signal prints the `hook-interrupted` block directive and exits 2 (a
  post-event exits 0). The wait's own handler still answers first inside the
  wait and withdraws as before. Under `approval serve` the process's signals
  stay the server's.
- **`approval doctor`'s harness rows cover every harness (APRV-398).** The
  settings-path list, the hook-command pattern and the organ search are now
  `Record<HarnessKind, …>` and pinned set-equal to the kind list by
  `tests/harness-enum.test.ts`, so `grok` and `muse` get the rows they never had:
  a checkout whose `.grok/hooks/` or `.muse/hooks.json` registered this CLI
  reported "registers no `approval hook` command", and no test noticed. The
  pattern is derived from the kind list rather than spelled, so the next adapter
  cannot ship without it.
- **doctor's `harness-hook-wiring` row reads the Claude adapter (APRV-408).**
  The gated tool roster comes from the adapter instead of a hand list that had
  drifted (`MultiEdit` and `NotebookEdit` were unchecked). The row names the
  held read tools (`Read`, `Glob`, `Grep`), names a matched tool the adapter
  would pass through, and fails a handler whose `--dir` names a different
  checkout; an unreadable wrapper or a regex matcher is skipped, never passed.
- **A harness probe drives its own matrix, so an operator runs one command
  instead of typing thirty prompts (APRV-418).**
  `node scripts/probes/hermes-hook.mjs run` does what the runbook asked a human
  to do in about thirty steps: it reads `hermes --version` BEFORE it writes
  anything and refuses below the fail-closed floor (a build below it ignores the
  key silently, which is what made the first Hermes round measure the wrong thing
  for a day), builds the scratch project and the hook block, then walks a
  declarative matrix through one one-shot invocation per trial, and prints the
  report. Each invocation is a fresh harness start, which is what makes the
  fail-closed PAIR drivable at all: the manual round never got its control pass
  because switching the key needs a restart a person has to perform. A step label
  now survives the arm being consumed, so a later call naming the armed artifact
  is reported as a retry inside that one-shot session or as a different step's
  file, which is the confound that misread a trial. The round aborts after ONE
  invocation when nothing reached the hook, and names the causes. The same shape
  is now on `scripts/probes/grok-build-hook.mjs`, whose runbook no longer asks
  anybody to add a probe entry to this repository's own `policy.core` settings
  file: both candidate registrations go in a scratch project, each naming its own
  `--config-id`, so one round answers which one a session of that harness reads.
  `docs/probe-driver-convention.md` states the shape, what
  `approval hook classify` answers for a driver command, and the two credential
  options for the next harness. That classify answer is the one thing a reader
  would guess wrong: the Hermes driver command names the harness home, so it
  classifies `policy.core` under rule `protected-path`, which is human-only. No
  agent can run it, request it or be granted it, and an operator running it from
  their own terminal has no hook in the loop, so there is nothing to approve
  either. That is fail-closed rather than a gap, because the driver rewrites the
  harness configuration and then launches the harness twenty times, and both are
  protected acts. The Grok driver names no protected path and comes out
  `files.write.workspace`, which the docs record as an open question rather than a
  green light. Both drivers are verified with canned envelopes and a fake harness
  binary before any install.
- **`approval muse`, a local Muse consumer facade (APRV-437, APRV-436).** A
  single-tenant loopback listener with distinct read and propose credentials
  from the launch environment and the store root fixed by `--dir`. The propose
  scope registers an in-memory envelope and requests its declared action; the
  read scope sees status, pending requests and the canonical rendering of a
  live request. It has no grant, reject, execution, token, generic verb or
  export route; decisions go through the separately configured Telegram
  listener. It is a prototype: public hosting, native Muse confirmation and the
  directory listing are APRV-405. `docs/muse-connector.md` and
  `scripts/probes/muse-connector.mjs` record the consumer contract probe and
  what is still unknown.

### Channels and identity

- **`edgeos` is a sender channel (APRV-455).** `approvers.<id>.senders.edgeos`
  maps a person's EdgeOS `/humans/me` id, raw (an ASCII letter or digit, then
  up to 127 letters, digits, `.`, `_` or `-`; colon-free, so it can never be
  read as the keyed form) or keyed under `APPROVAL_SENDER_KEY` exactly as
  `telegram` is. It qualifies on the APRV-324 ground: the gesture is attributed
  to an id the person cannot choose, by a relay the daemon trusts the way it
  trusts the Bot API's `from.id`. An observed id that already wears the
  `hmac-sha256:` prefix is never compared raw, so a published digest cannot be
  replayed as an account. The schema hunk is confined to the `senders` object
  and the `senderChannel` definition.
- **`approval channel relay` (APRV-455).** A third arrival for a human
  gesture: a loopback HTTP listener (port 4684) an operator's control plane
  posts to, authenticated by `APPROVAL_RELAY_SECRET` from the launch
  environment in `x-approval-relay-secret`, checked before the path, method
  or body. `POST /relay/gesture` takes one closed body: `propose`,
  `attest` or `decline` a policy by sha256, or `grant` or `reject` a
  request by action key, each with an EdgeOS sender, a nonce and an
  `issued_at`. Gestures go through `recordChannelDecision` with the new
  `requireSenderMapping`, so an unmapped account (or a policy mapping none) is
  refused `sender-unmapped` with one `audit.decision_refused` and the relay
  never decides as an identity of its own; expiry, policy drift and attestation
  resolve exactly as for a Telegram tap. A forged post appends nothing; a
  replayed nonce is refused across restarts by an exclusively linked ledger under
  `.approval/daemon/relay-nonces/`; a grant's raw token never leaves the
  process. Every gesture resolves its sender against the policy IN FORCE, so a
  mapping sitting unattested on disk decides nothing. `propose` (under an
  `agent:` proposer, with a one-hour deadline) may reaffirm bytes already in force
  (`ProposeInput.reaffirm`), so an unchanged onboarding review still makes the
  resident the attester of record. The verb is `human_only` in the registry,
  so neither `serve` nor MCP publishes it. New frozen union
  `relay_refusal_codes` (refusal-unions vectors 26.0.0). Trust level: the
  daemon trusts the relay's attribution, which is operator trust (APRV-422).
  The SPEC §10.3 and §11.2 hunks ride the APRV-454 attestation batch, pending
  sign-off.
- **`approval channel telegram webhook` (APRV-424).** Decisions arrive by
  Telegram webhook, so no long-poll process needs to run. The verb registers
  the webhook with a launch-environment secret (`APPROVAL_TG_WEBHOOK_SECRET`),
  serves the callback on loopback (127.0.0.1:4683 by default; a wider bind needs
  `--allow-non-loopback`), checks the secret header first in constant time, and
  routes every update through the same handler, sender mapping and decision
  path as long poll. A forged post appends nothing. The poller and the webhook
  are mutually exclusive per gate through an owned transport lease, refused
  `telegram-poller-running` or `webhook-registered`.
- **A refused Telegram tap no longer kills the live prompt (APRV-442).** When a
  tap was refused (an unmapped account's `sender-unmapped` is the case the
  hosted smoke found), the card was disarmed as before, but the listener kept
  believing the request was on the approver's phone: no fresh card went out and
  the original card's buttons resolved to nothing until the listener restarted.
  The channel now reports each card a refused or failed tap disarmed, and the
  next dispatch cycle (polling and webhook alike) re-offers every such request
  the verified log still calls pending, so the mapped approver can answer on
  the new card. The refusal is unchanged: still refused, still one
  `audit.decision_refused` attributed to nobody. The refused card stays dead:
  a Telegram redelivery of the refused tap, or its bytes replayed, takes no
  fallback to the new card, so it appends nothing and sends nothing.
- **A listener restart sends one summary and no re-prompts (APRV-425).** The
  pending queue has a stated order now, shared by the delivery, the paced
  walkthrough and `/queue`: live requests newest first (live meaning younger than
  the hook's wait plus its retry grace), then stale ones oldest first, with
  attestation prompts last where `approval queue` already put them. A pending
  request whose payload bytes and class a NEWER pending request also names is
  collapsed whatever its age — two askings of one question, of which only the
  newer has an asker — so a live prompt no longer arrives buried behind dead
  ones, and the collapsed summary says which of its members are there for age and
  which for supersession instead of claiming all of them are old. A restart with
  N stale pending went from a banner plus N prompts to one summary and zero
  prompts, with the next cycle of that process sending nothing. Collapsing is
  still not deciding: every collapsed request stays pending in the log, is listed
  by `/queue`, and is decidable from any copy already on the phone. **The literal
  "zero messages" is held for a SPEC decision**: a listener cannot tell a request
  a previous process delivered from one that arrived while nothing was running,
  since both predate its start, so withholding a re-delivery on age alone would
  produce the one outcome SPEC §10.3 forbids — a pending request nobody is shown.
  The summary is what keeps it legal; the amendment literal zero would need is
  written out in APRV-425's notes and deliberately not applied.
- **`approval status` lists both refusal families (APRV-376).** A `refusals`
  field keyed `decision` and `gesture`, each with a count and the newest five
  seqs with their codes and the observed account, in the JSON and the table. It
  is informational: outside `healthy` and the exit code, derived from the
  verified read, and absent when there are none.
- **The SMTP adapter stops sending an address as a server name (APRV-416).**
  TLS SNI names a virtual host, so a `smtp.host` that is an IP literal is now
  probed and sent to with no `servername` at all, which Node 26 requires and
  earlier versions only warned about; verification of an address rests on the
  certificate's IP SAN entry, and SNI is unchanged for a hostname.

### Daemon and records

- **An acknowledged append survives the machine dying the next moment
  (APRV-440).** Every append to `events.jsonl` now fsyncs the descriptor after
  its single write and before the verb reports ok, and the append that creates
  the file also fsyncs the log directory (and the parent of any directory it
  created), so the new name is as durable as its bytes. Before this the append
  was atomic against other writers and nothing more: on a hosted tenant a
  platform kill about 30 s after an acknowledged attestation left the file
  ending in 456 NUL bytes where the record had been. A failed fsync, a failed
  directory fsync and a short write are each reported as `io` rather than
  acknowledged, with a message that says the bytes may be on disk; no refusal
  code was added and compare-and-append is unchanged. Measured on macOS (APFS,
  Node's fsync is `F_FULLFSYNC` there): 3.7 ms per append, and 84 ms added to a
  daemon tick that appends 20 records; a tick that appends nothing pays nothing.
  `APPROVAL_BENCH=1 node --test dist/tests/append-fsync.bench.js` re-measures.
  `approval log verify` now says which crash tore a tail: `tear: "nul-filled"`
  is the crash-before-writeback signature (the file grew, its data never reached
  the disk; nothing was tampered and no record is half-written), and
  `partial-line` is a writer that died mid-line. `--json` gains `tear`,
  `tornBytes` and `intactBytes` (the byte offset the verified records end at),
  the torn-byte count is now UTF-8 bytes rather than string length, and
  `approval doctor`'s log row names the bytes to keep and the command that
  keeps them. Nothing truncates on its own.
- **The payload store is durable before ok (APRV-457).** `storePayload` now
  fsyncs the temp file before the rename and the store directory after it
  (plus the parent of every directory the write created), through the same
  write layer the log append has used since APRV-440, so the bytes a proposal
  or grant binds are on disk before the record that binds them is appended.
  Before this, a platform kill before writeback could keep the (fsynced)
  record and lose its payload: a verified `payload_hash` pointing at a
  NUL-filled or missing file. A short write, a failed file fsync or a failed
  directory fsync is `write-failed` (no new code); a filesystem that cannot
  sync a directory (EINVAL, EBADF, ENOTSUP, EOPNOTSUPP) is tolerated as the
  log tolerates it. Hashing, canonicalization and the log append are
  unchanged. Measured on macOS APFS (opt-in `tests/payload-fsync.bench.ts`):
  about 7.8 ms per stored payload, on `storePayload`, the propose path and
  the attestation path alike; not batched.
- **doctor names a torn payload apart from a tampered one (APRV-457).** The
  `payload-store` row reads back every payload a verified record binds. An
  empty or all-NUL file, or a missing one whose record proves the store held
  it, is the crash-before-writeback signature (nothing tampered, bytes lost);
  a file with any non-NUL byte that does not verify is tampering or
  corruption. Each has its own fix text, and an intact store's row is
  unchanged.
- **The payload store is owner-only (APRV-445).** Every file under
  `.approval/payloads/` is written 0600 inside a directory narrowed to 0700 on
  every write, whatever the umask or the directory's earlier mode. `approval
  init` now lists `.approval/payloads/` in the `.gitignore` lines it writes
  (it was tracked by default before); remove the line to keep the bytes in
  history.
- **Every harness start names the policy that authorized it (APRV-447).**
  `execution.started` written by the hook route and by `approval start` now
  carries `payload.policy_sha256`, the attested policy hash the gate resolved
  the class against, on the policy path and the grant path alike. The runtime
  stamps it at the write boundary; a caller-supplied value is ignored, no
  verdict reads it, and the schema admits it as optional, so every earlier
  record still validates. Conformance `schema-validation` is 2.9.0 (two new
  fixtures, no expectation moved).
- **Every record the daemon writes names the daemon that wrote it (APRV-383).**
  A daemon-written record carries a new optional top-level `daemon` field holding
  that daemon instance's id, so a tenant whose daemon is HOSTED by another party can
  open their own log and tell which host process acted for them; before this they
  all carried the same generic `system:daemon` actor. The id is
  `APPROVAL_DAEMON_ID` from the daemon's launch environment where it is set, and
  otherwise `daemon-` plus the instance id `approval doctor` already prints as its
  `keychain-scope` suffix, so it is stable across restarts on one machine and
  keystore with nothing stored anywhere. `approval up` and `approval daemon run`
  name it on their `started` line, `approval status` reports it as `daemon`, and a
  new `daemon-identity` doctor row reports it with the allowlist below. The field is
  OPTIONAL and additive: every record written before it validates and verifies
  unchanged, and its absence is absence rather than a claim that no daemon wrote the
  record.
- **`APPROVAL.md` may list which daemons may write (APRV-383).** A new top-level
  `daemons` array names the daemon ids permitted to append to that log. ABSENT means
  no restriction, exactly as every policy written before the key; an empty list
  admits none. A daemon whose id an attested list does not name is refused at the
  write boundary with a new `daemon-not-allowed`, and a daemon launched with an
  `APPROVAL_DAEMON_ID` that is not a usable id is refused with a new
  `daemon-id-invalid` (and `approval up` / `approval daemon run` decline to start at
  all). Both join the frozen `append_error_codes` union, so the conformance vectors
  take a major bump. The id is SELF-REPORTED, so it only ever costs a daemon the
  ability to write: being listed grants nothing, and no verdict, autonomy, budget,
  floor, sampling draw or token reads the field or the list (SPEC.md §11.1 invariant
  4). The list is read only from the attested policy, and a policy that becomes
  unreadable under a running daemon leaves the restriction it carried standing
  rather than lapsing. `design/hosted-daemon-identity.md` states the whole hosting
  model and what is deliberately out of scope: process isolation, token scoping and
  billing.
- **`approval serve` and `approval channel telegram webhook` stamp the daemon id
  (APRV-448).** Records either process appends (serve's verb calls and its hook
  calls on their worker threads, the webhook's taps and dispatch cycles) now
  carry the `daemon` field with the id `approval status` reports for the store,
  resolved by the daemon loop's own rule (`APPROVAL_DAEMON_ID`, or the id
  derived from the instance), and both are held to the attested policy's
  `daemons` list at the write boundary: refreshed before every serve call and on
  every webhook cycle, refused `daemon-not-allowed` with nothing written. Before
  this only the daemon loop stamped, so in a co-located deployment a tenant saw
  the id on sweeps and nothing on actions, and an unlisted facade wrote freely.
  An unusable declared id refuses either verb before it binds (exit 2). Neither
  process marks itself the daemon, so the daemon's autonomous advance route
  stays the daemon's. The gate and execution verbs' JSON refusals now carry the
  write boundary's code under `error.append` beside `append-failed`, as
  `approval gate` already did. `ServeOptions` takes an optional `env` the id is
  resolved from (in place of the earlier `daemonId`), and the handle reports
  `daemonId`.
- **Drift-append contention is reported as deferred and retried (APRV-403).** A
  `lock-timeout` or `head-moved` on an `envelope.drift` append used to print
  `append-refused … was not appended`, which is true and reads as a lost record
  while the next tick quietly re-derives and writes it. It is now a
  `drift-deferred` warning naming the task and saying the scan retries, and the
  `drift` line that lands carries `retry` so the pair closes — the same split
  APRV-381 made for `audit.sampled`, using the same shared classifier so the two
  sweeps cannot come to disagree about which failures a retry fixes. Both drift
  reasons take it. Every other append refusal keeps the `append-refused` form,
  because `validation`, `canonicalization`, `corrupt-tail` and `io` are facts
  about the record or the file that no retry repairs. **Write-back no longer
  repairs a file whose drift record was deferred**: it used to rewrite the
  `state:` line anyway, so the next tick found the file agreeing with the log,
  the retry had nothing to re-derive, and the deferral resolved into silence — a
  correction made off the record, which is what SPEC §6.3's append-then-write
  order exists to prevent.
- **A contended audit sample waits for the next tick (APRV-381).** A
  `lock-timeout` or `head-moved` on the `audit.sampled` append is reported under
  a `sample-deferred` warning that names the action key and says it retries on
  the next tick, and the append that follows carries `retry`, so the pair closes
  in the window an operator reads. Every other refusal keeps the
  `append-refused` form.
- **A log sync under a running daemon no longer stops it as `anchor-diverged`
  (APRV-389).** The anchor check proved two facts from two reads, so a sync that
  rewrote the working log left one of them stale and the message contradicted
  itself. It now compares one triple, treats a view that disagrees with the
  bytes as moved, re-reads the file once with the cache off before any refusal,
  and logs one `anchor-reread` line. A real divergence still stops the daemon on
  byte evidence read twice.

### Policy and setup

- **A hosted tenant with no shell gets its starting policy from the operator,
  once, and can see who set it (APRV-449).** `approval policy attest
  --bootstrap --as human:<operator>` attests a store's first policy and nothing
  else: it reads the verified log first, a re-run over the same bytes refuses
  `policy-already-attested`, changed bytes refuse `policy-amendment-required`,
  and neither appends anything (exit 1, with `seq` and `attested_by` in the
  error). The append is compare-and-append against the head it read. The plain
  verb is unchanged, and needs no TTY either way. `approval status` gains
  `attestation.attested_by` (the text row reads `attested (seq 1, by
  human:carter)`) and `approval doctor`'s attestation row names the attester,
  both read from the verified record. With `--bootstrap` the log resolves under
  `--dir` unless `--log` names one. `docs/hosted-provisioning.md` is the
  sequence (init, write the policy only into a store with no log, attest as the
  store user), every refusal code, and the trust statement: the operator sets the
  starting policy, and every change needs the approver's act through a channel.
- **The Agent Village tenant policy lives here, and the Hermes guide describes
  the co-located shape (APRV-446).** `examples/agent-village/approval-policy.md`
  is the canonical day-one policy the control plane renders into each tenant's
  `APPROVAL.md`: a recorder (autonomous default), the three gate organs
  human-only, the Hermes tool classes and `network.call`/`read.web` recorded and
  never gated, `intent.publish.inferred.index` manual and agent-requestable, a
  72h proposal window, and the relay credential and resident chat named by env.
  It is named `approval-policy.md` because any file named `APPROVAL.md`
  classifies `policy.core`. `tests/agent-village-policy.test.ts` proves it
  through the real loader, resolver, `policy attest --bootstrap` and `hook
  hermes`, and runs the propose round once the build carries #569's
  `agent_may_request`. `docs/hermes-hook.md` "For Agent Village" now covers
  `serve` on loopback or a unix socket, the agent token file, `up --api-base`
  against the relay, the operator attestation, the 240 s hook window beside the
  72 h proposal window, and what the hook never sees.
- **`policy amend --pr` stops racing the records advance (APRV-420).** The
  amendment commit carries `events.jsonl` only when it is the thing publishing
  those records. When the base already carries them, or a records advance is
  live on origin, it carries the policy bytes, the attested text and the pins,
  which cannot conflict on a file they do not touch. A re-run repairs a pull
  request a landed advance made unmergeable: the branch is rebuilt on the
  current trunk, force-updated and re-armed, and only when it is the single
  commit this ceremony makes, so a peer commit is never lost.

### Demos and docs

- **The site version guard binds every version string, and no page claims a
  publish (APRV-395).** All eight strings across `index.html`,
  `features/index.html`, `llms.txt` and `llms-full.txt` are now bound to
  `package.json` and reported in one message, so a bump that moves the package
  alone is told every file still to move; `llms.txt` states the version this
  tree carries rather than asserting that it is on npm, which was false for the
  whole window between a bump merging and the publish run finishing.
- **The Releases page fills itself from the changelog (APRV-396).** After a
  successful publish, `publish.yml` creates the GitHub Release for the tag with
  the matching changelog section as its body, the title `approval-md X.Y.Z`, and
  the CI tarball plus its `sha256` file attached, so the Releases page and the
  registry can be compared by hand. `scripts/release-notes.mjs` extracts the
  section and refuses when the heading is missing, undated, duplicated or empty;
  that check also runs in the verify job, ahead of `npm publish`, so a tag with
  no notes never reaches the registry. A rerun updates the one Release rather
  than duplicating it. The published manifest now also carries
  `gitHead` (the release commit), which was `null` for 0.2.0 and 0.3.0 because
  the publish job publishes a downloaded tarball with no repository beside it.
- **README split (APRV-412).** `README.md` is a short entry and
  `docs/README-extended.md` the guide, restoring three sections earlier drafts
  dropped and shipped in the npm package. The landing page's values example
  quotes its `communication` string as `APPROVAL.md` does (APRV-413).
- **The Approved pages.** `/approved` carries the Approved landing page and the
  17-slide deck, the Get Approved hosted demo entry with an onboarding preview,
  policy setup that exposes the five approval modes (HOSTED-28), and the live
  run of 2026-09-30. This work carries no task id in this repository and is
  listed as such.
- **A lane ends on a CI verdict (APRV-426, APRV-417).** `docs/ci-verdict.md`
  states the rule; `scripts/ci-baseline.json` holds the known failures by test
  id with the task owning each, and `node scripts/run-tests.mjs --baseline`
  names a run's failures that are not on it. The test runner scrubs terminal
  colour forcing from every test-file process (APRV-417).
- **New runbooks and design notes.** `docs/hermes-hook.md` (APRV-398, APRV-415,
  APRV-446), `docs/hosted-provisioning.md` (APRV-449),
  `docs/probe-driver-convention.md` (APRV-418), `docs/run-payload-binding.md`
  (APRV-401), `docs/muse-connector.md` (APRV-436),
  `design/hosted-daemon-identity.md` (APRV-383), `design/quiet-hours.md`
  (APRV-450), `design/per-class-ttl.md` (APRV-451, deciding against a per-class
  `approval_ttl` for now) and `design/chain-continuity.md` (APRV-452, chain
  continuity across a store recreate).

### Breaking and behavior changes

- **`approval wait` answers what a request still authorizes (APRV-428,
  APRV-445).** An unregistered task refuses `not-registered` (exit 1) where it
  used to answer `granted`; a registered task with nothing live answers
  `nothing-to-wait-for` (exit 0); a lapsed grant is `expired` (exit 3); a grant
  or pending request pinned to a re-attested policy is `void` (new exit 7).
  *Migration:* a caller that read exit 0 as a grant reads `state` instead, and
  treats exit 7 as "ask again".
- **`approval init` gitignores `.approval/payloads/` (APRV-445).** The payload
  store was tracked by default. *Migration:* remove the line from `.gitignore`
  to keep payload bytes in history.
- **Workspace writes that resolve outside the workspace go to a human
  (APRV-402).** See the entry above for the commands affected. *Migration:* a
  session that wrote into another checkout or through a symlink out of the temp
  root by absolute path now asks, under `files.delete.out_of_scope`, which
  the policy resolves like any other class.
- **Relative Hermes paths are refused (APRV-415).** A `terminal` call with no
  absolute `workdir` and a file-tool call with a relative or missing path deny
  `hook-unsupported-execution-context`, and `--dir` is mandatory in gateway
  deployments. *Migration:* a Hermes deployment wired against an earlier build
  of this adapter passes absolute paths.
- **Conformance suite versions.** `refusal-unions` 19.0.0 to 27.0.0 (APRV-398,
  APRV-383, APRV-423, APRV-445, APRV-455, including the new frozen
  `relay_refusal_codes` union), `schema-validation` 2.5.0 to 2.9.0 (APRV-398,
  APRV-383, APRV-423, APRV-447), `command-class` 1.3.0 to 1.5.0 (APRV-397,
  APRV-409) and `hook-read-scope` 1.2.0 to 2.0.0 (APRV-415, two expectations
  moved). `gate-verdicts` 2.1.0, `policy-resolution` 3.0.0, `bridge-decisions`,
  `chain-verification` and `jcs-canonicalization` 1.0.0 are unchanged.
  *Migration:* a second implementation pinned to the `v0.3.0` vector files
  re-runs the four that moved; the refusal-union majors are added codes, which
  is a string a caller branching on the union has not seen before.
- **Schema additions, and no new event type.** The closed event enum is
  unchanged at thirty-four types. Records gain an optional top-level `daemon`
  (APRV-383); `payload.harness` gains `hermes` (APRV-398); `approval.requested`
  gains `harness_cap_ms`, which requires `execution: "harness"` (APRV-423);
  `execution.started` gains `policy_sha256` (APRV-447). The policy schema gains
  top-level `daemons` (APRV-383), the per-class `agent_may_request` (APRV-445)
  and the `edgeos` sender channel (APRV-455). *Migration:* every addition is
  optional, so every 0.3.0 record and policy validates unchanged; a verifier
  with its own copy of the schema accepts the new fields before it reads a
  0.4.0 log.

## 0.3.0 — 2026-09-20

Written on 2026-09-20 against `main` at `36018dc`, 192 non-merge commits after
`v0.2.0`, all additive at the package boundary. The deprecated bare `supervised`
alias still loads with a warning, so this is a minor bump. Published to npm as
`approval-md@0.3.0`, tagged `v0.3.0` at commit
`f4ebc90c698c7e8d410b184cda73de228d46ec43`. Separately approved tag creation
and push triggered the protected-main Trusted Publishing workflow. Registry
bytes, installed behavior and signed provenance were verified (APRV-371).

### Gate and guard

- **Reads are scoped, for the first time at any layer (APRV-347).** A
  `read.file.out_of_scope` class, an additive `read_scope: { roots }` policy key
  that `approval policy check` shows on the read classes, harness gating of
  Claude Code's `Read`, `Glob` and `Grep` (and Cursor's `Read`, documented as
  unverified), and a Seatbelt profile that flips to deny-default file reads.
  Fail closed throughout: an unresolvable target, an unreadable value and a
  symlink escape are each out of scope, and the scope anchors on the directory
  holding the policy the hook resolved rather than on the harness-supplied
  `cwd`. Writes and deletes were path-scoped; reads were not, so a policy could
  say a great deal about what an agent may write and nothing about what it may
  see.
- **A human sign-off is a record (APRV-338).** `approval policy attest --path
  <p>` appends the human-only `gate.path.signed_off`, carrying a
  repository-relative protected path and the SHA-256 of its bytes. The
  protected-path guard reads it last, after its grant search, hunk coverage and
  replay have all failed, and the finding it prints says the verdict rests on
  whole-file evidence. The verb refuses a non-human actor, the policy file,
  every `policy.core` surface and the log directory, each with its own code, and
  it classifies `policy.core` so the harness hook denies it to an agent first.
- **The protected-path guard credits the evidence a real edit leaves (APRV-337,
  APRV-339, APRV-340).** The policy-authorized tier accepts the absolute path
  the hook binds, so an unattended `Edit` can pass CI at all. The post-hoc check
  anchors on the committer date, so an edit folded in by `git commit --amend` is
  no longer refused as later than the change it made. A single fragment edit
  inside a long line is credited by line-local exact replay, instead of reaching
  the global replay's byte limit before it can find a proof.
- **`vcs.ref.delete`, a class of its own (APRV-352).** Removing a remote ref
  classified `vcs.push.main`, which reads as "this reaches the trunk" and is held
  here at `supervised-retro`. A push adds commits somebody can still see, while a
  deletion removes the only name an unmerged branch had. Every deletion spelling
  now takes `vcs.ref.delete`, with the ref names bound to the segment so a prompt
  can say what disappears.
- **`harness.launch.NAME` (APRV-354).** A command whose first word was `codex`,
  `muse`, `grok`, `claude` or `cursor-agent` was `hook-unclassified`: fail
  closed, and also mute, leaving an approver nothing to read and a human no class
  to grant through. Five spellings reach one class (bare, absolute,
  home-relative, env-prefixed, package runner), version and help probes classify
  as reads, and a launch resolves only under an explicit rule.
- **Quoted argument text is data, as a stated contract (APRV-353).** The
  behavior already held; what was missing was anything holding it there. The new
  `command-class` conformance suite pins the segmentation as firmly as the
  classes: a note naming a shell, a placeholder, a pipe or a semicolon is one
  word, `$(…)` and backticks inside double quotes keep classifying as they do
  anywhere else, and quoting that does not balance is a refusal rather than a
  guess.
- **`approval doctor` and the CI guard replay the same unit, and name it
  (APRV-369, APRV-374).** `src/core/commit-guard.ts` is the one place either side
  builds its inputs, so the health row and the CI verdict agree by construction
  rather than by two code paths kept in step. The `audit.dark_session` code set
  gains `no-evidence-merged`, the same `dark` verdict for a finding whose failing
  commits all reached the checkout through a merge, reported under its own code
  because the repair is in the branch the commit came from. Arm A now judges a
  merge commit on its dense combined patch, so bytes born in a conflict
  resolution are judged instead of dropped.
- **`audit.question_preempted` (APRV-378).** When something else resolves an
  approval the gate exists to ask about, starting with the Codex server-side
  auto-reviewer, the log carries the fact. Until this, it lived in an exit code
  and a terminal line, and a verdict with nothing behind it is the shape of claim
  this project is built against.
- **A hash-bound, grant-gated driver for bulk ref deletion (APRV-318).** Every
  ref must still be at the tip the 2026-09-08 inventory recorded, proved before
  the run and again before each batch, with a per-ref lease and no forced
  refspec; any drift refuses the whole run instead of deleting the subset it
  agrees with. 233 merged remote branches were deleted through it.
- **Credential starvation proved under the egress sandbox (APRV-193).** An
  ordinary `node` script, which is the class the hook allows and therefore the
  whole laundering premise, is denied the vault, the `.approval/env` source map
  and the sealing keys under a real `sandbox-exec`, with three controls that make
  the denial evidence rather than coincidence.

### Harnesses and the Codex bridge

- **`approval hook grok`, the Grok Build adapter (APRV-243).** Grok Build's
  `PreToolUse` hook is Claude Code's with camelCase keys, a `{decision, reason}`
  verdict and a deny that is exit 2. It also reads `.claude/settings.json` for
  compatibility, so this repository's committed Claude Code entry firing under a
  Grok session would deny in the nested envelope at exit 0, which Grok reads as
  an allow: every command would look gated and none would be. `docs/grok-hook.md`
  states which cases the adapter cannot cover, including a fail-open on timeout,
  crash and malformed output that has no setting to change it.
- **`approval hook muse`, the Meta Muse Code adapter (APRV-350).** Every field is
  observed, from a live run of `muse-bin-1.3.0-R3233.1`. Muse sends the two facts
  Codex lacks, a per-call working directory and a real outcome, so commands are
  classified against the directory they will run in and a non-zero exit closes
  the start as a failure. Muse also fails open on a verdict that merely mixes
  dialects, so the adapter emits exactly one, the nested `hookSpecificOutput`
  form at exit 0, and a test asserts the verdict object has exactly one
  top-level key.
- **The Codex native hook says what it cannot do (APRV-311).** The refusal for a
  `Bash` call whose per-call working directory Codex hides has its own code,
  `hook-unsupported-execution-context`, separated from the malformed-event
  `hook-io` it used to borrow, because the two repairs are opposite. A malformed
  post-execution event reports `post-tool-io` rather than printing a permission
  verdict about a call that has already run, and every post-phase line carries
  the stable task id the pre half minted. `hook_deny_codes` and
  `post_tool_codes` joined the `refusal-unions` suite.
- **The Codex workspace broker and the confined session (APRV-325.2,
  APRV-325.3).** `approval codex apply` is the one door into the canonical
  workspace, and `approval codex start` closes the window beside it: a disposable
  workspace is the only writable path, the canonical workspace is readable and
  never writable, the gate's log, policy, vault and keys are neither, the
  environment is an allow-list rather than a filtered copy of the operator's,
  outbound network is denied with loopback, and descendants inherit all of it. A
  confined session's reads are jailed to exactly those two workspaces.
- **`approval codex bridge` (APRV-361).** The bridge starts `codex app-server`
  and answers every approval request it raises through the hook's own decision
  path: the same classifier, the same human-only refusal, the same sandbox
  requirement, the same loop floor and unattended guard, and the same register,
  request and wait against the verified view. Each
  `item/commandExecution/requestApproval` carries `command` and `cwd` on one
  frame, which is exactly the pair the native hook lacks. The deadline is the
  policy's `approval_ttl` rather than a harness ceiling, overridable with
  `--wait`.
- **What the bridge binds, and what it will say (APRV-362, APRV-363, APRV-366,
  APRV-367, APRV-368, APRV-379).** An exec request binds argv rather than a
  rendering, and a string no join produces is `bridge-command-unbound`. A legacy
  `applyPatchApproval` is decided by the paths it carries. An item-based file
  change is correlated with the `item/started` frame its id names, with
  `bridge-file-change-unbound` and `bridge-file-change-already-completed` of its
  own. The answer to `thread/start` is read, so a server that refused the
  `untrusted` approval policy or started the thread under another one stops the
  run. The reply vocabulary is a closed type with one encoder, so
  `acceptForSession`, `cancel` and `abort` are never sent. `bridge_stop_codes` is
  published as a union beside `bridge_refusal_codes`, each naming the other, and
  SPEC section 6.3 gains the app-server row.
- **The bridge proves nothing else answered first (APRV-364, APRV-359).** Every
  start runs a preflight probe turn, and a session whose server-side
  auto-reviewer resolves a request before this client is asked stops rather than
  carrying on. The separate probe harness reports `VOID` where its own control
  raised no approval request and landed no effect, in place of a hold sentence
  that claimed evidence it did not have.
- **The app-server socket has no custodian because there is no socket
  (APRV-365).** The bridge starts the app-server as its own child over stdio
  pipes, so nothing binds a path, no other process holds a descriptor to speak
  on, and the replay of a pending request to whatever connects next cannot arise
  inside one run. The claim moved to what that makes true.
- **`grok` joins the harness enum (APRV-358).** A Grok session could classify and
  deny correctly and could not register: `harness: "grok"` on `task.registered`
  was refused at the write boundary, so a manual-class request never reached a
  human. The six places a harness name is written down are now pinned equal to
  `HARNESS_KINDS`, so the next adapter cannot land with the enum left behind.

### Channels and identity

- **A channel sender becomes an attested human identity (APRV-324).** The
  attested `approvers[id].senders` mapping turns an authenticated Telegram
  account into the actor a record names, with `payload.sender` and
  `sender_source: "policy"` on decisions, attestations and reviews, resolution on
  every callback family rather than decisions alone, and an `approval doctor`
  `sender-mapping` row that says what an unmapped policy means. Checkpoint and
  review gestures resolve only against an attested policy.
- **A keyed sender id, so a published policy and log stop carrying the account
  (APRV-370).** `approvers[id].senders.telegram` accepts `hmac-sha256:<hex>`
  beside the raw account id, computed under an operator secret in
  `APPROVAL_SENDER_KEY` that the new human-only `approval setup sender-key` mints
  and stores. A plain digest would not do: a Telegram id is a ten-digit decimal
  number and the whole space is enumerable on a laptop. `--id <account-id>` mints
  nothing and prints the mapping line and a paste-ready proposal pair for one
  account, which is the one step no agent session can perform. A channel with any
  keyed entry and no key in the process refuses every decision on it under
  `sender-key-unavailable` and never falls back to the raw comparison.
- **`audit.gesture_refused` (APRV-355).** A tap on a checkpoint signature or a
  review, from an account the attested policy names nobody for, is refused before
  any verb runs and used to record nothing at all, so a person's attention left
  no trace. It now leaves a record with a `^system:` actor, the channel and the
  gesture, and it carries the sender on the refusals where the account is the
  only thing the runtime knows about who tapped.
- **One bot per instance, refused before polling (APRV-390).** Two daemons on one
  machine long-polled one Telegram bot and traded HTTP 409s all evening, while
  `approval up` printed a cross-instance warning and started anyway. Scoped
  keystore item names could not catch it, since two instances can hold one token
  under two perfectly distinct names. The bot's own identity, as `getMe` reports
  it, is now recorded and claimed, `approval setup channel telegram` stores an
  instance-named token, and a second instance claiming a bot another local
  instance holds is refused.

### Daemon and records

- **`approval up` reconciles a working log that extends the committed one
  (APRV-346).** The preflight refused `up-preflight-log-diverged` whenever
  `origin/main`'s log changed and the working copy had too, which is the state
  every records advance leaves the primary checkout in. A prefix relation is now
  delegated to `approval log sync`, whose APRV-215 ceremony stays the single
  implementation, and the startup line says how many local records were kept. A
  fork, an unverifiable chain, a held append lock and a dirty unrelated path keep
  the refusal unchanged.
- **`log.advance.daemon`, the daemon's own advance class (APRV-382).** Three
  advances on 2026-09-19 each stopped on the one-in-a-hundred live draw while
  nobody was at the phone, for an operation that publishes records the log
  already holds, appends nothing and decides nothing. The class grammar has no
  actor condition, so the rule is two classes. See the breaking notes below for
  what an operator does about it.

### Policy and setup

- **`approval policy amend --pr` finishes its own ceremony (APRV-341).** The
  amendment is committed in the APRV-203 scratch index, pushed to
  `policy-amend-<seq>`, carried by a pull request that is opened or updated, and
  armed with `gh pr merge --merge --auto`. Nothing is checked out, so the
  checkout ends the verb on the same branch with the same HEAD, index and working
  tree, which removes the cause of the 2026-09-16 fork. Two refusals are split
  out and distinct by repair, both before the attestation: `staged-unrelated` and
  `dirty-tree`.
- **`attested-policy-on-main` (APRV-342).** Between a `policy amend` and its pull
  request merging, a fresh checkout of main refuses every gate operation with
  `policy-not-attested`, and nothing said so. A read-only, networkless
  `approval doctor` row compares the attested hash against the `APPROVAL.md` blob
  at the remote tip and names the command that lands it; `approval up`'s
  preflight prints the same sentence and never refuses on it.
- **`approval policy apply`, a proposal document in one human command (APRV-343,
  APRV-360).** Agents may not write `APPROVAL.md`, so policy changes travel as
  proposal documents and a human pastes, and a paste reverts what it did not know
  about. The verb writes no byte that is not anchored to a byte it proved
  present, reads fences by their backtick run, and resolves every
  current/replacement pair against an in-memory copy in document order before
  anything reaches disk, so a stale proposal writes nothing at all. It then runs
  `approval policy amend` in the same process, passing `--pr` through. Human-only
  twice over: it refuses an agent identity with `apply-agent-actor` and
  classifies `policy.core`. Without `--pr` it publishes its branch by refspec
  from a synced main, never by a branch switch in the primary.
- **The bare `supervised` alias is deprecated (APRV-335).** The spelling still
  loads and still means `supervised-retro`. Both schema enums keep it and both
  descriptions call it a deprecated alias that a future schema version removes,
  the load-time note leads with `deprecated: `, and an `approval doctor`
  `autonomy-alias` row names every rule in the operator's own policy that still
  uses it. The canonical example, the `approval init` scaffold and the fixtures
  moved to `supervised-retro`.
- **Values block "0.2" (APRV-336).** `wants` folds into `like`, since both are
  graded by the same person in the same way and one list is easier to keep true
  than two whose boundary has to be re-decided on every edit. `responds` becomes
  `communication`, which no longer reads as a sibling of the `approval feedback`
  verb. The format version moves from the integer `1` to the quoted string
  `"0.2"`, spelled as the policy block's `"0.1"` is; the quotes are load-bearing,
  since YAML reads a bare dotted identifier as a float.
- **The APRV-335 and APRV-336 SPEC amendments are signed off (APRV-345).** The
  pending markers are dropped under a human grant.

### Demos and docs

- **The landing page (APRV-331, APRV-332, APRV-333, APRV-387, APRV-388,
  APRV-391).** The feature set and reference sections moved to `/features`, and
  `index.html` drops to the wordmark, the lead line, the install block, Carter's
  seven onboarding steps and three inline graphics, with no external scripts. The
  hero dot field keeps its size when the source-install details opens. The
  wordmark bracket is visible in dark mode; every page declares the
  checked-bracket icon in the formats browsers and share crawlers need (SVG and
  ICO favicons, an Apple touch icon, manifest PNGs, a 1200x630 share card); the
  `APPROVAL.md` terminal types once, resumes from the same character after
  leaving the viewport, and stays filled; and the values block on the page is in
  the 0.2 format.
- **The web-agent demo (APRV-386, APRV-168, APRV-392).**
  `examples/demo-provision.mjs` provisions the three demo instances idempotently,
  with reset and check, in place of a command sequence pasted out of a runbook.
  The email finale's credential resolves inside the agent child, reproduced live
  on 2026-09-19 and traced to the macOS keychain search list rather than guessed.
  The demo page carries `brand/wordmark.svg` inlined byte for byte.
- **An agent-hours tracker (APRV-373).** `scripts/agent-hours.mjs` computes
  active hours, sessions, turns and tokens per model into
  `metrics/agent-hours.json`, README carries dynamic badges linking to
  `docs/agent-hours.md`, which states the method and its caveats, and a weekly
  script refreshes the file from a throwaway worktree and opens a self-merging
  pull request.
- **New runbooks and design notes.** `docs/grok-hook.md` (APRV-243),
  `docs/muse-hook.md` (APRV-350), `docs/codex-activation.md` (APRV-315),
  `docs/codex-workspace-broker.md` (APRV-325.2),
  `docs/codex-app-server-bridge.md` (APRV-349),
  `docs/upstream/codex-hook-payload.md` (APRV-348),
  `design/channel-sender-identity.md` (APRV-324),
  `design/multi-approver-semantics.md` (APRV-323, design only: quorum does not
  exist in this runtime, and the document says so three times),
  `design/constrained-model-egress.md` (APRV-351), and `docs/proposals/README.md`
  with the proposal pages the policy changes above travelled as (APRV-343).

### Breaking and behavior changes

- **The three ceremony verbs commit the attestation payload (APRV-356).**
  Terminal attestations store the attested policy text and bind its hash on the
  record they append, so `approval policy amend --commit`, `approval policy
  apply` and `approval log advance` now put that payload file in the commit they
  build. A committed log carrying the binding without the bytes is a chain whose
  in-force policy is unrecoverable to every reader of the committed copy.
  *Migration:* an amend or apply commit carries one more file, beside
  `APPROVAL.md`, the log and the pins; anything pinning the exact path set of a
  ceremony commit has to move with it, and `--dry-run` names the file in the
  `git add` it would run.
- **Whole-file evidence is anchored at the range head, and the guard judges a
  pull request per commit (APRV-375).** A grant binds one edit, and the combined
  base-to-head diff of a branch is a change nobody made: PR #427 cost fourteen
  lines tracing to no authorized material while each of its three commits was
  separately granted. Every commit of `base..head` is now judged against its own
  first parent, with its own paths and its own APRV-339 timestamps, and the pull
  request's verdict is the conjunction; a merge is judged on its dense combined
  diff. A grant stays per commit, while a sign-off, an organ attestation and the
  policy attestation say a human read the file as it now stands, so every commit
  in the range is offered the digests at the range head. *Migration:* a branch
  that passed on the old combined replay can fail per commit, and each commit
  needs its own hunk evidence or a `gate.path.signed_off` at the range head to
  rescue it.
- **The classifier unwraps a login shell around one inline script (APRV-380).**
  Classifier-wide rather than a Codex change: the unwrap lives in
  `classifyCommand`, so Claude Code, Cursor, the Agent SDK, Muse, Grok, the
  native Codex adapter and the app-server bridge all reach it through one code
  path. When the words are exactly a known shell, one inline-script flag and one
  script, the script goes through the same lexer, segment rules and table a
  `Bash` call would hand the classifier directly. Everything outside that line
  stays opaque: a script file, a fourth word, a redirection on the wrapper, an
  assignment prefix, a substitution in the wrapper words, a flag whose `c` is not
  last, and a shell nested inside the script. *Migration:* a command such as
  `zsh -lc 'git push'` that used to refuse `hook-opaque` now resolves under the
  inner command's class, so a policy that leaned on the blanket refusal has to
  declare that class. The binding does not move: the payload still carries the
  outer command, and on the bridge path the outer argv.
- **`log.advance.daemon` (APRV-382).** The daemon's advance is its own class and
  `log.advance` is untouched, so a session in a worktree, an orchestrator and a
  human terminal stay exactly where they were. A non-daemon actor under an
  autonomous rule is refused `advance-actor-not-daemon` before anything is
  appended, and the daemon's class is asked for only from inside the daemon
  process. *Migration:* declare `log.advance.daemon` in `APPROVAL.md` to give the
  cadence its own autonomy (`docs/proposals/log-advance-daemon-2026-09.md` is the
  byte-anchored page); until the rule exists the daemon falls back to
  `log.advance` and the cadence is unchanged.
- **The keyed sender id form (APRV-370).** A record carries the digest as
  `payload.sender.id` with `payload.sender.hashed: true`, in the form the matched
  entry uses, so a policy mid-migration records a keyed approver as a digest and
  a raw one as an id. The flag is `true` or absent, never `false`: absent is the
  raw form every build since APRV-324 has written, and a `false` would make all
  of those read afterwards as though they were missing something. *Migration:* a
  raw mapping is byte-identical to before and needs nothing. A deployment moving
  to the keyed form runs `approval setup sender-key`, exports
  `APPROVAL_SENDER_KEY` into the process that answers decisions, and converts a
  whole channel at once, since a keyed entry with no key in the process refuses
  every decision on that channel.
- **Conformance suite versions.** `refusal-unions` 8.0.0 to 19.0.0 and
  `schema-validation` 2.2.0 to 2.5.0, plus three suites that did not exist at
  `v0.2.0`: `command-class` 1.3.0 (APRV-353, and the rows APRV-352, APRV-354 and
  APRV-380 added), `hook-read-scope` 1.2.0 (APRV-347, extended by APRV-243 and
  APRV-350) and `bridge-decisions` 1.0.0 (APRV-367). *Migration:* a second
  implementation pinned to the `v0.2.0` vector files re-runs all five, and the
  refusal-union majors are added codes, which is a string a caller branching on
  the union has not seen before.
- **Schema enum additions.** The closed event enum grows to thirty-four types
  with `gate.path.signed_off` (APRV-338), `audit.gesture_refused` (APRV-355) and
  `audit.question_preempted` (APRV-378). `payload.harness` gains `grok`
  (APRV-358) and `muse` (APRV-350). `audit.dark_session` gains the
  `no-evidence-merged` code (APRV-369), `payload.sender` gains the optional
  `hashed` (APRV-370), and `execution.indeterminate` gains
  `workspace-commit-unknown` (APRV-325.2). *Migration:* the event enum fails shut
  at the write boundary, so a verifier written against the `v0.2.0` set has to
  accept all three new types before it can read a 0.3.0 log.

## 0.2.0 — 2026-09-12

Published to npm as `approval-md@0.2.0`, tagged `v0.2.0` at commit
`205432683ccb8a671cba22a8f884208bd2ffdf61`. Separately approved tag creation
and push triggered the protected-main Trusted Publishing workflow. Registry
bytes, installed behavior and signed provenance were verified (APRV-329).

- **Explicit irreversible policy permission (APRV-317).** An attested class rule
  may set `allow_irreversible: true` to retain declared autonomous or supervised
  behavior for an action truthfully marked `reversible: false`. Omission or
  `false` retains the manual floor. Manual and human-only controls, budgets,
  payload binding, live selection and policy-drift checks remain in force.
  Policy-authorized executions carry no fabricated human grant.
- **Public adapter-author API (APRV-321).** Import `executeThroughAdapter`,
  adapter conformance helpers and the scoped vault provider from
  `approval-md/adapters`, with TypeScript declarations. The exports map closes
  incidental deep imports such as `approval-md/dist/src/adapters/contract.js`;
  migrate them to `approval-md/adapters`. This compatibility change requires a
  minor pre-1.0 release. See [Adapter API](docs/adapter-api.md).
- **ZZZ threads and replies (APRV-320).** The built-in `zzz` adapter routes exact
  `communicate.zzz.external` payloads through the shared execution contract and
  a scoped `zzz.agent_token` credential. ZZZ authentication, room access and
  workflow evidence remain separate requirements. This package applies no ZZZ
  database migrations and does not deploy zzz.bot.
- **Codex preparation and limits (APRV-311–313, APRV-325.1, APRV-325.2.1).**
  `approval codex prepare` produces inert configuration templates. Preparation
  installs no trusted hook and provides no mandatory confinement. The
  experimental native hook covers direct patches, refuses Bash, and has
  observed native crash/timeout fail-open gaps. The internal workspace planner
  binds proposed operations and applies no writes. A broker, exclusive
  operating-system custody and live activation evidence remain unfinished.
- **File gating and protected replay (APRV-304, APRV-326).** Ordinary Claude Code
  and Cursor writes use policy and execution accounting; protected edit evidence
  is checked against the exact authorized change.
- **Operator tools.** Human-only reviewed `approval quickstart` setup (APRV-309),
  verified cursor-based `approval log follow` streaming (APRV-322), and explicit
  `approval log advance --co-author` credit in records commits and PR bodies
  (APRV-327). Co-author credit grants no authority.

## 0.1.0 — 2026-09-08

Published to npm as `approval-md@0.1.0` and tagged `v0.1.0`, through the gate:
each of the publish, the tag and the tag push was a `release.publish` request
granted from a phone and executed on a sealed token (APRV-199, APRV-306).

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
- **A review card fits on a phone** (APRV-302). The first live cards carried a
  labelled button per choice and four sentences of rules under every one of
  them, so the rows a review is about were off the first screen. The buttons are
  bare emoji now, in the same two rows (✅ 🛑 over 👎 😐 👍 ❤️), and the rule
  block is gone rather than reworded: `REVIEW — THIS ALREADY RAN` says a review
  is not a request, and the deny latch says itself through the arm toast and the
  `DENY ARMED` headline. A tap that records is answered `Heard — recording your
  review`, its own toast, because a request card's `Heard — deciding` tells a
  reviewer something is pending when nothing is. Unchanged, and checked in the
  tests: no payload region, no approve button, no token, the COMPUTED/CLAIMED
  split, the per-row origins, and every refusal rendered on the card.
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

- **Starting the runtime rebuilds a stale build, so a merge never leaves the
  daemon and the hook on compiled-away code** (APRV-301). `approval up` and
  `approval daemon run` already fetched and fast-forwarded; they now also date
  `dist/src/cli/main.js` against `src/` and `tsconfig.json` with the very
  predicate `approval doctor`'s `build-freshness` row reports, and run `npm run
  build` in the installation root when the build is older, with the compiler's
  output on the terminal and the startup line saying what it did. Staleness alone
  is enough, so a checkout already at the remote tip is covered too. `--no-build`
  opts out of the rebuild alone: the fast-forward still happens, `dist_stale`
  still reports the truth, the action reads `build-skipped` or
  `fast-forward+build-skipped`, and a warning names the stale build. A build that
  fails refuses with `up-preflight-failed` and the exit code `npm run build` came
  back with, and nothing starts, because starting there would put the writer on
  exactly the code the rebuild existed to replace.

The publish itself is the first `release.publish` action to pass through this
gate (APRV-199).
