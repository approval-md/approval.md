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
- **The SMTP adapter stops sending an address as a server name (APRV-416).**
  TLS SNI names a virtual host, so a `smtp.host` that is an IP literal is now
  probed and sent to with no `servername` at all, which Node 26 requires and
  earlier versions only warned about; verification of an address rests on the
  certificate's IP SAN entry, and SNI is unchanged for a hostname.
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
- **`approval doctor`'s harness rows cover every harness (APRV-398).** The
  settings-path list, the hook-command pattern and the organ search are now
  `Record<HarnessKind, …>` and pinned set-equal to the kind list by
  `tests/harness-enum.test.ts`, so `grok` and `muse` get the rows they never had:
  a checkout whose `.grok/hooks/` or `.muse/hooks.json` registered this CLI
  reported "registers no `approval hook` command", and no test noticed. The
  pattern is derived from the kind list rather than spelled, so the next adapter
  cannot ship without it.

## 0.3.0 — 2026-09-20

Written on 2026-09-20 against `main` at `36018dc`, 192 non-merge commits after
`v0.2.0`, all additive at the package boundary. The deprecated bare `supervised`
alias still loads with a warning, so this is a minor bump. Not yet tagged or
published: the version bump, the gated annotated tag and the Trusted Publishing
run are the remainder of APRV-371.

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
