# approval.md: the extended guide

[Start with the short README](../README.md) · [Specification](../SPEC.md) · [CLI reference](cli-reference.md) · [Website](https://approval.md/)

approval.md puts a policy between an agent and the actions you want to oversee. Some actions proceed, some are sampled, some wait for you, and some remain yours to perform. The policy lives in `APPROVAL.md`; the record lives in a hash-chained event log.

This guide covers the details behind that loop: setup, integration choices, credential custody, supervision, evidence, and operation. It describes the reference implementation, not a promise that every tool in every harness is intercepted.

**Version scope.** Reviewed against `main` on September 20, 2026. The package version is `0.3.0`, and a [v0.3.0 release](https://github.com/approval-md/approval.md/releases/tag/v0.3.0) exists. `main` also contains unreleased work, so check the [changelog](../CHANGELOG.md)'s Unreleased section and the relevant integration runbook before assuming a source feature is in an installed package. The policy format's `version: "0.1"` and values format's `version: "0.2"` are separate from the package version.

## Contents

- [How the pieces fit](#how-the-pieces-fit)
- [Installation and setup](#installation-and-setup)
- [Define what needs approval](#define-what-needs-approval)
- [Values and feedback](#values-and-feedback)
- [Channels and identity](#channels-and-identity)
- [From a request to an execution](#from-a-request-to-an-execution)
- [Credentials and adapters](#credentials-and-adapters)
- [Harnesses and MCP](#harnesses-and-mcp)
- [The log, evidence, and privacy](#the-log-evidence-and-privacy)
- [Operating and troubleshooting](#operating-and-troubleshooting)
- [Security and evidence limits](#security-and-evidence-limits)
- [How this compares](#how-this-compares)
- [Developing and maintaining the project](#developing-and-maintaining-the-project)

## How the pieces fit

**Files are the interface. The log is the truth. The database is a cache.**

`APPROVAL.md` contains human-readable prose and a fenced policy block. A human attests the file's exact bytes. The runtime resolves action classes against that policy and reads verified log state before making gate decisions.

Agents reach that runtime through the CLI, an MCP server, a harness hook, or an application using the adapter API. Telegram, the terminal, and the local web queue carry requests and decisions; they do not own approval state.

There are two execution paths worth keeping separate:

| Path | Who performs the action? | Where the control sits |
| --- | --- | --- |
| Runtime command or adapter | `approval run` or an adapter | Policy checks, the execution record, and a single-use token where a grant is required. An adapter can additionally hold the only usable credential. |
| Harness hook or approval bridge | The agent's harness | The integration returns a permission decision for a covered call. The harness must actually honor it; outcomes depend on the available post-execution reports. |

An MCP connection is a way to call the runtime, not a third kind of containment. It does not automatically put unrelated shell, browser, or file tools behind the gate.

The main local artifacts are:

```text
APPROVAL.md                 policy and optional values
.approval/log/events.jsonl  authoritative event chain
.approval/QUEUE.md          rendered queue, derived from the log
.approval/*.sqlite          rebuildable indexes
.approval/payloads/         stored bytes behind payload bindings
.approval/vault.enc         encrypted adapter credentials
.approval/env               local environment source map
.approval/keys/             private keys for sealed token delivery
.approval-journal/          the separate, ungated agent journal
```

Task declarations can live under an `approval:` key in Markdown frontmatter. The [Backlog.md example](../examples/backlog-md-project/README.md) shows the envelope on an ordinary task file; adopting a particular board is not the security boundary.

## Installation and setup

### Install the package

Use Node.js 20 or newer:

```sh
npm install -g approval-md
```

Run setup from the project whose policy and log you intend to use. A source checkout of approval.md and a project using approval.md are different directories; do not accidentally configure the former when you meant the latter.

### Guided setup

```sh
approval quickstart
```

This is a human-at-a-terminal walkthrough, not an unattended installer. It asks for an identity, a terminal or Telegram channel, and the action families that should always ask: communications, spending, file deletion, public posting, and pushes to main. It displays the resulting policy and asks you to type `understood` before attesting it.

The generated policy uses **`autonomous` for other classified, reversible actions**. It is a convenience policy, not a default-deny policy. Change `defaults.autonomy` to `manual` and re-attest when that better fits your project. Safety floors and unclassified-command refusals are separate checks and still apply. Retrospective sampling is not enabled by this walkthrough.

An interrupted ceremony does not leave an attested policy behind. It also does not install harness hooks or start an agent.

### Manual setup

```sh
approval init
approval setup identity
```

`init` creates missing policy and runtime files, merges its ignore entries into `.gitignore`, and does not overwrite an existing policy. It creates an empty log directory, not an attestation or a fabricated first event.

**Read and edit the scaffold.** It is an example policy: it names `alice`, includes example budgets, and declares retrospective sampling without provisioning its secret. Replace the approver, rules, and channel configuration with your choices. The [short README's example](../README.md#define-what-needs-approval) is a smaller, terminal-first starting point.

After reviewing the file, attest it with the identity named in your policy:

```sh
approval policy attest --as human:you
```

Replace `you` with your actual approver ID. The first attestation creates the event log. Attestation records which bytes were accepted; it is not a claim that the policy is sensible or that every integration has been installed.

### Activate and start

The setup commands record local configuration sources in `.approval/env`. Activate them explicitly in the human-controlled terminal that will run the daemon:

```sh
approval env --check
eval "$(approval env)"
approval doctor
approval up
```

`approval env --check` reports configuration sources without printing secret values. Use the absolute-directory activation command printed by quickstart when the shell is elsewhere.

`approval up` is a foreground process running the daemon and configured channel listeners. It handles expiry, task-envelope drift checks, queue regeneration, and configured retrospective sampling. A missing optional credential or an absent task folder is not proof that those features are active; read startup diagnostics and `approval doctor`.

For terminal decisions, open a separate human-controlled terminal in the same project, activate its intended environment, and run `approval channel cli`. For Telegram, configure the bot before expecting a phone prompt.

Starting the daemon does not intercept an agent's tools. Install the chosen [harness integration](#harnesses-and-mcp), then test a harmless call that your policy requires to pause. Confirm the request arrives and the expected record lands before relying on the setup.

### Install from source

Use a checkout for unreleased work or contributions:

```sh
git clone https://github.com/approval-md/approval.md.git
cd approval.md
npm ci
npm run build
npm link
```

The linked CLI executes the compiled build. Rebuild after source changes; `approval doctor` checks for a stale build. Source-checkout startup can also perform its documented fetch, safe fast-forward, and rebuild preflight. Do not treat `approval up` as a read-only command; see the [startup reference](cli-reference.md#up).

## Define what needs approval

The policy is exactly one `yaml approval-policy` fenced block inside `APPROVAL.md`. Surrounding prose helps humans and agents understand your intent, but is not executable policy. Unknown policy keys fail validation rather than silently becoming unenforced promises.

### Five levels, not six different behaviors

| Autonomy | Meaning | Additional setup |
| --- | --- | --- |
| `human-only` | Reserved for a human to perform outside agent execution. The agent cannot request, receive, or spend permission for it. | No approval can turn this into an agent action. |
| `manual` | Requires a human decision before each covered action proceeds. | A reachable approval channel. |
| `supervised-live` | A declared fraction follows the manual path; other actions can proceed under policy. | A class-level `live_rate` and the configured sampling machinery. |
| `supervised-retro` | Can proceed immediately, with a configured sample reviewed afterwards. | Retrospective rate and an operator-held sampling secret. |
| `autonomous` | Does not ask for human approval. | Attestation and the other applicable runtime checks still matter. |

The schema also accepts the deprecated spelling `supervised`, an alias of `supervised-retro`. It is not a sixth behavior. `supervised-live` cannot be the default autonomy because its required rate belongs on a class rule.

Retrospective review is not an approval that happened earlier, and a denial afterwards cannot undo an email or payment.

### Classes and matching

Classes describe actions: `communicate.email.external`, `financial.spend`, `files.write.workspace`, `vcs.push.main`, `vcs.ref.delete`, or `account.credential`. Rules match most-specific-first. A `*` matches a segment; trailing `.*` covers deeper descendants. Equally specific rules resolve to the strictest applicable autonomy.

Unmatched classes use `defaults.autonomy`. An unparseable policy resolves conservatively to all-manual; an unattested or changed policy cannot simply authorize work through an old attestation.

A class name is **not** an integration. Adding `calendar.write.own` does not install a calendar adapter. Harness hooks classify the command and path information they receive; directly registered tasks declare their own envelopes. Neither is automatic discovery of every action a model, plugin, browser, or external service could perform.

```sh
approval hook classify -- git push origin main
approval policy check vcs.push.main --reversible false
```

The first command inspects classification without executing the command. The policy check explains resolution; it is diagnostic, not authorization to execute. `approval instructions --schemas` describes approval.md's own CLI verbs, not the complete capability set of a connected harness.

### Sampling

These are fragments to merge into an existing policy, not complete replacement files:

```yaml
classes:
  files.write.workspace:
    autonomy: supervised-live
    live_rate: 0.10
    retro_rate: 0.20
  vcs.commit.branch:
    autonomy: supervised-retro
    retro_rate: 0.10

audit:
  sampling_secret_env: APPROVAL_SAMPLING_SECRET
  supervised_sample_rate: 0.10
```

`live_rate` controls pre-execution selection; `retro_rate` overrides the global retrospective rate for that class. Naming an environment variable does not create a secret. Provision it outside agent-owned configuration and check sampling with `approval doctor`. Live selection uses the runtime's operator-held sampling mechanism; a percentage in YAML alone is not a functioning control.

### Irreversible actions

An action declared `reversible: false` normally raises nonmanual autonomy to `manual`. `human-only` remains denied to agents.

An operator can deliberately retain nonmanual behavior with `allow_irreversible: true` on an eligible class rule. Every equally most-specific matching rule must opt in, and the changed policy must be attested. This exception cannot be placed in `defaults` or used to override `human-only`.

Treat it as a deliberate delegation, not a way to repair an inconvenient prompt. A declaration of reversibility is also not independent proof that a real-world effect can be undone.

### Budgets and request limits

Class limits and applicable budget scopes are conjunctive: satisfying one does not waive another. Consumption is computed from the log over rolling windows, rather than trusting a mutable counter.

```yaml
classes:
  financial.spend:
    autonomy: manual
    limits:
      per_action_usd: 25
      daily_usd: 100
      max_pending: 3
      requests_per_hour: 10

budgets:
  global:
    daily_usd: 100
    daily_actions: 200
    max_pending: 20
```

These controls bound the actions and cost information the runtime actually sees. They are not a replacement for provider billing limits or an independent accounting of every charge an agent could cause elsewhere.

### Reads and protected files

`read_scope.roots` adds directories to the built-in read scope: the policy's own project root, the session scratchpad, and the system temporary directory. Relative additions resolve against the policy root, not an arbitrary working directory supplied by a caller. Scope checks resolve paths and symlinks.

An out-of-scope read classifies as `read.file.out_of_scope`. Give that class an explicit rule; a broad autonomous `read.*` rule is not a read restriction by itself.

```yaml
read_scope:
  roots: [../shared-reference]

classes:
  read.*: { autonomy: autonomous }
  read.file.out_of_scope: { autonomy: manual }
```

This applies on the read surfaces the integration covers. A native `Read` tool omitted from a hook matcher is not controlled merely because the classifier supports it.

The built-in protected set includes the policy, log-related state, agent instructions, harness configuration, and other governing surfaces, with distinct classifications. `protected_paths` can add protection or route a path family to an eligible `policy.edit` subclass; it cannot narrow built-in protection.

```yaml
protected_paths:
  - path: SPEC.md
    class: policy.edit.spec
  - path: design/
    class: policy.edit.design

classes:
  policy.edit: { autonomy: manual }
  policy.edit.spec: { autonomy: manual }
  policy.edit.design: { autonomy: manual }
```

These are literal files or directory prefixes, not globs. Core gate configuration is not just an ordinary document: its human-only rules cannot be weakened by adding a path entry.

### Change and attest the policy

`approval policy attest` records the SHA-256 of the whole `APPROVAL.md` file. Editing prose or values also changes those bytes, even though neither is executable policy. A mismatch requires a new attestation.

For policy changes, use the `approval policy amend` workflow. It presents semantic changes to resolutions, approvers, defaults, and limits. `--require-load` refuses to attest a policy that does not load; `--dry-run` reports without applying. Read `approval policy amend --help` for the change-input and commit options rather than guessing their syntax.

**Edited `APPROVAL.md` in a checkout that has fallen behind.** This is the ordinary state after a policy edit, and `approval log sync` or `approval up` will refuse to fast-forward over the uncommitted file. Do not stash, reset, or check the file out to get past that. Run `approval policy amend --pr --require-load --as human:<id>` instead: it fetches `origin/main` itself, bases the amendment commit on the remote rather than on your checkout, attests the edited bytes, commits the policy and the log together, pushes a `policy-amend-<seq>` branch, opens the pull request, and arms its merge. Rehearse with `--dry-run` first. Once that lands, the sync and the daemon start go through.

Two related attestations are different evidence: `approval policy attest --organ <path>` records reviewed gate-configuration bytes, while `--path <path>` records whole-file sign-off for eligible protected documents. Neither is a substitute for attesting the operative policy. The [hook installation guide](claude-code-hook.md#installing-it) explains the CI evidence required for gate configuration.

### Why this verb exists: seq 2

Read this repository's own log. At **seq 2** a policy amendment was attested at
11:56:07. It was **superseded** seven minutes later, at seq 3, because the edit
broke a pinned assertion and nobody found out until the test suite ran against
it. The operator attested bytes whose consequences had never been shown to
them. (This account originally said eleven minutes. The log says seven, and
the log won.)

That is the failure the load advisory is for. Had `approval policy amend`
existed that morning, the load failure would have been on screen while the
human was deciding, and `--require-load` would have refused to attest at all.

### Policy reference

The closed [policy schema](../schema/policy.schema.json) and [SPEC section 5](../SPEC.md#5-the-approvalmd-policy-file) are the complete field reference. The main groups are:

| Group | What it controls |
| --- | --- |
| `defaults` | Fallback autonomy, channel, approval lifetime, expiry behavior, and token delivery. |
| `classes` | Per-class autonomy, approvers, rates, limits, and explicit irreversible-action delegation. |
| `approvers` | Eligible channels and optional transport-sender mappings. |
| `budgets` | Global and named-scope spend, action, and pending-request ceilings. |
| `read_scope` / `protected_paths` | Additional read roots and protected file families. |
| `audit` | Sampling, timestamp-skew reporting, and checkpoint keys and cadence. |
| `daemon` | Verification behavior for long-lived readers. |
| `channels` | Telegram and web configuration, plus supported prompt-layout choices. |
| `vault` | The name of the environment variable holding the vault passphrase. |
| `payload_retention` | Optional pruning policy for eligible stored payloads; absence means retain them. |

Keys ending in `_env` name environment variables, not secret values. Prompt customization cannot hide the fields required for a decision or remove the canonical payload from the authority path.

#### Every key

Every key that can appear in the policy block, and after it the four of the
optional values block. The schema is closed at every level: an unrecognised key
fails validation, which fails the policy closed to all-manual, because a key the
runtime did not understand is a rule its author believed was in force. A values
key the schema refuses fails the values reader alone and never the policy. Full
semantics: SPEC.md section 5.

| key | what it says |
| --- | --- |
| `version` | Policy format version, quoted (`"0.1"`). The only required key (§5.1). |
| `defaults.autonomy` | Autonomy for an action matching no class rule. Five of the six levels are admitted: `supervised-live` is not, since it needs a `live_rate` that `defaults` has nowhere to hold. `human-only` is, and reserves every unnamed class to human hands. No default of its own, and `manual` is the fail-closed choice (§5.2, APRV-185). |
| `defaults.channel` | Channel name requests surface on by default; expected to name a key of `channels`, which is a runtime cross-check rather than a schema one. No default (§5.1, §10.3). |
| `defaults.approval_ttl` | How long a pending request stays actionable. Duration string, `24h`. No default; the scaffolded policy writes one (§5.1). |
| `defaults.token_delivery` | How a minted token reaches the process that will spend it. `manual` (the default, and what an absent key means): printed once on the granting surface and carried by a human. `sealed`: sealed to a per-request X25519 key so `approval wait` can hand it back, which addresses the token and never authorizes it (§10.4, APRV-105). |
| `defaults.on_expiry` | What happens when the TTL lapses. `reject` is the only value, and absent means `reject` (§5.1). |
| `payload_retention` | How long payload bytes are kept after their action is terminal. Absent means nothing is ever pruned (§5.2). |
| `protected_paths` | Repo-relative files and directory prefixes whose edit is classified `policy.edit`. A bare string is the whole entry. Additive only, no globs, and absent means the built-in protected set alone (§5.2, APRV-107). |
| `protected_paths[].path` | The path half of the object form: the same grammar as the bare string, an exact file (`SPEC.md`) or a directory prefix (`design/`) (§5.2, APRV-266). |
| `protected_paths[].class` | The class half: one lowercase segment under `policy.edit`. Four reserved names, `policy.edit.spec`, `policy.edit.harness`, `policy.edit.ci` and `policy.edit.design`, plus any word an author mints beside them. Nothing outside `policy.edit` may be named, and a route below the `policy.edit` line is refused `protected-route-floor`. No default: an entry that wants a sub-class states it (§5.2, APRV-266). |
| `read_scope` | Directories an agent's reads may stay inside. A read resolving outside every root is `read.file.out_of_scope`. Additive only: the gate root (this policy's own directory), the session scratchpad and the system temp root are in scope whatever this says, and absent means those alone (§5.2, APRV-347). |
| `read_scope.roots` | The extra directories. Absolute, or relative to the gate root. No globs and no negation; each is resolved on disk before it is compared, so a symlink cannot smuggle a read out of one. Absent means no widening (§5.2, APRV-347). |
| `approvers.<name>.channels` | The channels one approver can decide on. At least one: an approver reachable nowhere can never grant. No default (§5.1). |
| `approvers.<name>.senders` | The transport account ids this person decides from, per channel: `senders.telegram: "12345678"`, the numeric `callback_query.from.id` and never a `@handle`, which is mutable and would transfer an identity. Optional and additive; absent everywhere means every decision is recorded against the identity the deciding process was launched with, exactly as before the key existed. Declaring the first entry for a channel turns enforcement on for that channel: a sender it authenticates and this block does not name is refused `sender-unmapped` and nothing is recorded. Two approvers claiming one id refuses the whole policy (`sender-ambiguous`), so every class resolves `manual`. Only channels whose transport authenticates a sender may appear, which today is `telegram` alone (§5.2, §10.3, APRV-324). |
| `classes.<pattern>.autonomy` | Required on every class rule, so it has no default. Six levels, strictest first: `human-only`, `manual`, `supervised-live`, `supervised-retro`, `autonomous`, and `supervised`, which is the pre-split spelling and the DEPRECATED alias of `supervised-retro`: it still parses, `approval doctor`'s `autonomy-alias` row names every rule that writes it, and a future schema version removes it (§5.2, APRV-127, APRV-185, APRV-335). |
| `classes.<pattern>.live_rate` | The fraction of a `supervised-live` class that blocks on the gate, in (0, 1]. Required there and refused everywhere else, so it has no default: a live mode with no fraction declares a control without saying how much of it runs. Selection is HMAC-SHA-256 over the payload hash under the operator's secret (§5.2, APRV-127). |
| `classes.<pattern>.retro_rate` | This class's retrospective sampling rate, in (0, 1], overriding `audit.supervised_sample_rate` for it alone. Optional on `supervised`, `supervised-retro` and `supervised-live`, refused on the rest. Absent means the global rate (§5.2, APRV-183). |
| `classes.<pattern>.allow_irreversible` | Explicit operator permission for a truthful `reversible: false` action to retain this rule's `autonomous` or supervised behavior. Optional boolean; absent or `false` preserves the manual floor. `true` is refused on `manual` and `human-only`, cannot appear in `defaults`, and takes effect only when every equally most-specific matching rule says `true` (§5.2, §7, APRV-317). |
| `classes.<pattern>.approvers` | Approver ids permitted to decide this class. Absent restricts nobody, since the list is a narrowing and a narrowing nobody wrote narrows nothing; a named list refuses everyone else with `actor-not-approver` (§5.1). |
| `classes.<pattern>.limits` | Per-class ceilings, every value a positive number: `per_action_usd`, `daily_usd`, and the request-volume counts `max_pending` and `requests_per_hour`. Absent means this class carries no ceiling of its own (§5.1, §5.2). |
| `budgets.global.daily_usd` | Repo-wide spend ceiling per rolling day, computed from the log. Absent means no spend ceiling (§5.1). |
| `budgets.global.daily_actions` | Repo-wide count of side-effecting actions per rolling day. Absent means no count ceiling (§5.1). |
| `budgets.global.max_pending` | Simultaneously pending requests across the scope; excess is refused `queue-full`. Absent means no ceiling (§5.2). |
| `budgets.<scope>` | Any other named scope, same three keys. Budgets are conjunctive with class limits (§5.2). |
| `audit.supervised_sample_rate` | The FALLBACK fraction of supervised actions escalated for retrospective review, in [0, 1], for classes declaring no `retro_rate`. Absent means no fallback rate is configured (§5.2, APRV-183). |
| `audit.sampling_secret_env` | Name of the variable holding the operator's HMAC sampling secret. Unnamed means sampling is off and says so (§5.2, §11). |
| `audit.skew_tolerance` | How far a gate-typed event's timestamp may step back before verification reports an anomaly. Report-only; default 2 seconds (§8). |
| `audit.checkpoint_keys` | Public halves of the Ed25519 keys permitted to sign a `log.checkpoint`, base64 DER SPKI. The private halves live in the vault and never in this file. A list, so a retired key stays listed: a checkpoint signed by a key the list does not carry is refused. Absent, empty or unreadable means verification skips the checkpoint check with a reason and never reports it as a pass (§9, APRV-220). |
| `audit.checkpoint_every` | How long the log may go without a human-signed checkpoint before verification says one is due, and before the listener puts one `CHECKPOINT DUE` prompt on the approver's channel (`approval setup checkpoint` mints the key). Report-only at every layer: a due checkpoint is a warning and never a refusal. Absent means the cadence is off and nothing is ever reported as due (§9, APRV-220, APRV-257). |
| `daemon.read_proof` | Which prefix proof a long-lived reader runs before reusing a cached prefix: `full` (the default, re-hash the whole prefix on every read) or `incremental` (hash only the appended bytes, re-proving in full on a cadence). One-shot processes, the Claude Code hook and `approval log verify` prove in full regardless (§5.2, APRV-217). |
| `daemon.full_reproof_every` | Reads one full re-proof may cover under `incremental`, the anchoring read included. Default 50 (§5.2). |
| `daemon.full_reproof_after` | Wall clock one full re-proof may cover under `incremental`. Duration string, default `60s` (§5.2). |
| `vault.passphrase_env` | Name of the variable holding the vault passphrase. Absent means `APPROVAL_VAULT_PASSPHRASE` (§5.2, §10.4). |
| `channels.telegram.token_env` | Name of the variable holding the bot token. Default `APPROVAL_TG_TOKEN` (§5.1). |
| `channels.telegram.chat_id_env` | Name of the variable holding the approver chat id. Default `APPROVAL_TG_CHAT` (§5.1). |
| `channels.telegram.delivery` | `paced` (the default) shows one summary line and the oldest pending request, then the next one after a decision, `/skip` or `/next`; `burst` sends every pending request the listener has not sent yet. Neither mode changes what is pending: that is re-derived from the verified log on every cycle (§10.3, APRV-216). |
| `channels.web.port` | TCP port for the local approval UI, bound on loopback only. No default in the schema; the scaffolded policy names `4680`, and 0 is excluded because the policy must name a port a human can navigate to (§5.1). |
| `channels.<name>.prompt.rows` | Order only, for `telegram`, `web` and `cli`: the rows named here render in this order ahead of the rest, which keep their default relative order behind them. Never a whitelist, so a field added later cannot be lost to a list written before it existed. Absent means the layout the channel ships (§5.2, §10.3, APRV-218). |
| `channels.<name>.prompt.always` | Rows this channel renders only when abnormal, or not at all, render on every prompt instead. The anomaly mark stays a statement about the value, so a forced-on row shouts only when the value is in fact the reason to look. Absent means the channel's own visibility rules (§5.2, §10.3, APRV-218). |
| `channels.<name>.prompt.hide` | Rows this channel never renders. Refused for the rows required for a decision (`action_key`, `class`, `command_breakdown`, `protected_path`, `policy_diff`, `policy_load`) with `prompt-row-required`, and refused for a row `always` also names. Absent means nothing is hidden, and the canonical payload block is out of reach either way (§5.2, §10.3, APRV-218). |
| `channels.<other>` | An unknown channel name is accepted as an object, so a third-party transport does not fail the whole policy closed (§10.3). A `prompt` block written under such a name is still validated: a layout is checked wherever it appears. |

And the values block (SPEC.md §5.3), which is guidance and reaches no
enforcement path:

| key | what it says |
| --- | --- |
| `version` | Values format version, quoted (`"0.2"`), spelled as the policy block's `"0.1"` is. The only required key here too. The quotes are load-bearing: a bare `0.2` is a float to YAML, and the reader refuses it by name (§5.3, APRV-336). |
| `love` | What you love in the work. The strongest of the three standing grades. Absent means you named none (§5.3). |
| `like` | What you like, which since APRV-336 is also where what you ask of an agent as behaviour lives: the former `wants` list folded in here (§5.3). |
| `dislike` | What you dislike. NOT a prohibition, which belongs in the policy block where it is enforced (§5.3). |
| `communication` | One string, at most 500 characters, on how you read and answer, so an agent can read silence or terseness correctly. Called `responds` before APRV-336 (§5.3). |

Every key ending in `_env` carries a variable's *name* and never its value:
agents may read `APPROVAL.md`, so a secret it carried would be a secret they
hold. Where those values live is recorded in `.approval/env`, which a single
verb reads, `approval env`, whose output is an export block a human evaluates.

## Values and feedback

Approval is also a judgment about the work, not only permission to execute. An optional second block carries your voice:

````markdown
```yaml approval-values
version: "0.2"
love:
  - honest thoughts on the work
  - small diffs with one idea
like:
  - success reported first
  - say when you are stuck
dislike:
  - confident documentation that is stale
communication: I read the journal after a session and react on the samples.
```
````

```sh
approval values
approval feedback
```

Values and feedback are human-authored guidance. Reviews and grants can carry graded reactions; the strongest reactions require a note. `approval journal write` is the agent's separate, ungated outlet.

None of these changes an autonomy verdict, budget, token, or sampling draw. A malformed values block does not invalidate the policy parser. `approval import agents-md` can draft policy and values from supported sections of an instruction file; its output still needs human review and attestation.

## Channels and identity

### Telegram

```sh
approval setup channel telegram
```

This provisions the local channel configuration. The operative policy must also name Telegram as the desired channel, allow the approver to use it, and declare the relevant channel settings. Review and re-attest policy changes; setup is not permission to change policy silently.

The setup uses the supported OS keystore and records configuration sources in `.approval/env`. The policy contains variable names, not the bot token. Reload the intended environment before starting `approval up`.

Requests distinguish **computed** facts from **claimed** agent-authored descriptions and include the payload to be approved. Agent text is rendered as data. An optional model-generated gloss is labeled unverified and does not change the verdict. Decisions update and disarm the request card.

Use a distinct bot for each independently polling instance. Two listeners sharing a bot conflict; the runtime includes a local ownership check, but it cannot discover every competing process on another machine. See the [Telegram walkthrough](../examples/telegram-demo.md).

### Terminal and local web

`approval channel cli` presents the queue in a human-controlled terminal. `approval channel web` serves the local queue on loopback; the policy declares its port.

The web channel has no independent login proving who clicked. Its boundary is access to the local machine and socket. There is no anti-CSRF token; the same-origin check is a speed bump, not protection against a local process that can POST directly. Do not expose this queue publicly as an authenticated approval service.

### What the recorded identity means

Local `human:<id>` identities are config-declared. Someone able to set that configuration and write to the gate's state is inside the trust boundary. An attestation does not prove that a particular physical person was present.

Telegram can additionally map transport-authenticated sender IDs to approvers through the attested policy. Once a channel has mappings, unmapped senders are refused rather than attributed to the listener's identity. Use numeric account IDs, not mutable handles. Keyed `hmac-sha256:` mappings avoid publishing raw account IDs; `approval setup sender-key` provisions the operator-held key.

Sender mapping attributes a transport account. It is not proof of personhood, and it does not remove the trusted-host assumption. See the [channel reference](cli-reference.md#channel).

## From a request to an execution

For a directly registered action, the normal sequence is:

```text
Declare the task and payload
        ↓
Register → request → human decision, when required
        ↓
Wait → execute through the appropriate runtime boundary
        ↓
Record the outcome → review and reconcile
```

The [Telegram demo](../examples/telegram-demo.md) and [Backlog.md example](../examples/backlog-md-project/README.md) contain complete declarations and runnable command sequences. An illustrative sequence is not a substitute for a valid envelope and payload.

The runtime binds the declared payload, checks policy and relevant limits, and records the request. A human grant on the command/adapter path mints a single-use token. Execution verifies the binding and consumes the grant before reaching the effect.

`approval run <action> --token "$TOKEN" -- <command>` records the execution start before spawning the child and records its outcome afterwards. It returns the child's exit status. Reusing a spent token is refused. A failed or ambiguous provider operation is not permission to replay a consumed grant blindly; inspect what happened before requesting another action.

**Hook grants are different.** The runtime returns a permission verdict to the harness rather than a token for it to execute arbitrarily. Grant consumption is recorded on the harness path. Register the post-execution counterparts to obtain outcomes, and distinguish an observed result from a start with no corresponding result.

### Token delivery

With the default `manual` delivery, the raw token is shown once at the surface that records the grant. A Telegram decision prints it in the runtime's terminal, not in the chat. The local web channel displays it once in the granting response.

With `defaults.token_delivery: sealed`, the request carries a recipient public key and the token is sealed for the requesting process. The log may contain ciphertext; the private key stays local. Sealing changes who can retrieve an authorized token, not who may authorize the action.

The raw token is not an ordinary log field. Keep tokens, private keys, vault passphrases, and provider credentials out of transcripts, task files, commits, and example payloads.

### No answer is not approval

`defaults.approval_ttl` bounds the pending request's lifetime. Expiry does not become approval. The waiter's timeout and the request's lifetime are separate: a caller stopping its wait is not automatically a rejection.

`approval withdraw` retracts a pending request; `approval wait --withdraw-on-timeout` makes that behavior explicit for a waiter. Harness retries have their own carryover rules, described in the corresponding integration guide. Inspect an existing request before creating duplicates.

## Credentials and adapters

The strongest control is often a missing capability: the agent can prepare the action, but cannot perform it without a credential held elsewhere.

```sh
approval setup vault
approval setup adapter email
```

The encrypted vault is an adapter credential store. `.approval/env` is a separate map of how the operator's process obtains its configuration. Keeping an encrypted file is not sufficient if the agent also has its passphrase or an alternative sending key.

`approval vault set` accepts secret material through stdin or a named environment variable, not a `--value` command-line argument. There is no `approval vault get`. The shared adapter contract verifies the payload and policy, records the start, opens the credential window, executes, redacts the result, and records the outcome.

Manual and selected-live actions need a grant token. Policy-authorized nonmanual actions do not mint a pretend human grant; their credential access follows the documented non-token path.

### SMTP email

`approval adapter email` sends the bound email payload through SMTP with STARTTLS using vaulted settings. Setup probes the connection without sending a message. The adapter derives a `Message-ID` from the action binding so the email and log can be correlated.

A successful adapter call is not a guarantee that a recipient read the message, nor a universal exactly-once delivery guarantee. See the [SMTP walkthrough](../examples/email-demo.md) for the full setup and execution sequence.

### AgentMail drafts

`approval adapter agentmail` uses a two-key arrangement: the agent's key can create, update, and read drafts; the vaulted key holds sending authority such as `draft_send` and `message_send`.

`approval payload agentmail-draft` snapshots the draft for approval. Before sending, the adapter re-fetches it and refuses `agentmail-draft-drifted` when the checked fields no longer match. This check happens before token consumption.

The provider permissions are part of the boundary. An agent that also holds a sending key can go around this arrangement. Follow the [AgentMail walkthrough](../examples/agentmail-demo.md), including the negative tests.

### First-class zzz.bot messages

`approval adapter zzz` creates threads or replies through the versioned zzz.bot API. The tagged payload binds the selected environment, operation, destination, content, metadata, and references. The adapter uses fixed supported origins, rejects redirects, and derives an idempotency key from the action and payload binding.

Public writes need an invited credential with write scope. Private-room writes additionally depend on room membership and accepted, unexpired workflow evidence. The setup probe checks an authenticated room-list read; it does not prove every write prerequisite.

This adapter is included in the published 0.2/0.3 package line, not just an unreleased experiment. Its repository tests use a mock HTTP service; do not mistake that for evidence of a live post in your environment. See [`adapter zzz`](cli-reference.md#adapter-zzz).

### Build an adapter

Import the supported ESM API from `approval-md/adapters`, not from internal `dist/src` paths. `executeThroughAdapter` supplies the shared execution contract; `runAdapterConformance` tests ordering, binding, single use, credential scope, redaction, and failures.

The [adapter API guide](adapter-api.md) includes a typed example and the vault credential provider. Passing conformance checks the adapter under its fixtures, not the provider's permissions or custody on your host. Automatic third-party registration into the CLI is separate work; an embedding application can use the public contract today.

## Harnesses and MCP

The following reflects the versions and evidence described in the linked repository runbooks. A fixture test, a source reading, and a live probe are different kinds of evidence. Recheck behavior after harness upgrades.

| Surface | Integration | Coverage and maturity |
| --- | --- | --- |
| Claude Code | `approval hook claude-code` | Pre-execution gating and post-execution reporting for supported, matched tools. Install both halves; review the documented timeout and carryover limits. |
| Cursor | `approval hook cursor` | Native Cursor dialect. `failClosed: true` is required to cover hook failures. Additional read-tool support must be deliberately wired and checked. |
| Claude Agent SDK | Python `HookMatcher` shim | Calls the Claude Code hook and supplies the tool-use ID. Repository fixtures exercise the CLI envelope; they are not a substitute for testing the complete SDK host. |
| Grok Build | `approval hook grok` | Dedicated dialect. Documented crash, timeout, and malformed-output paths fail open; the compatibility behavior still needs the documented live probe. |
| Muse Code | `approval hook muse` | Formats and failure behavior have live-probe evidence for the documented build. The harness fails open on hook failures, including invalid mixed-dialect output. |
| Hermes Agent | `approval hook hermes` | Implemented on `main` after the 0.3.0 release. Built from upstream source; live behavior remains unverified. Requires explicit hook registration and the documented `fail_closed` setting. |
| Generic MCP | `approval mcp serve` | Agent-facing runtime tools. Does not automatically intercept native tools or give an agent human decision authority. |

Runbooks: [Claude Code](claude-code-hook.md), [Cursor](cursor-hook.md), [Agent SDK](agent-sdk-hook.md), [Grok](grok-hook.md), [Muse](muse-hook.md), [Hermes](hermes-hook.md).

Do not copy a hook command between harnesses on the assumption that similarly named events speak the same protocol. A deny encoded for one harness can be ignored by another.

### Wire the calls you intend to cover

The classifier can support a tool that the installation example's matcher does not include. Check read, edit, shell, notebook, and outcome events against your actual harness configuration. Claude Code read support includes `Read`, `Glob`, and `Grep`, but a matcher listing only shell and edit tools does not enable it.

Keep the integration's wait below the harness's hook timeout. Protect the configuration, use the correct primary policy/log directory across worktrees, and record required organ attestations. Test both an allowed action and a denied action; a healthy-looking process is not proof that the hook fires.

Opaque code and indirect effects remain important limits. Classification of a script invocation does not, by itself, bind every byte that script might later read or execute. Where stronger control is needed, use bounded adapters, credential separation, and the applicable sandbox rather than assuming shell-text classification proves arbitrary program behavior.

### Codex is several integration paths

**MCP.** `approval mcp serve` gives Codex the same agent-facing tools as other clients. Its ordinary shell and file tools remain separate unless another control covers them.

**Native hook.** `approval hook codex` is experimental. In the documented versions, native Bash events omit the effective per-call working directory, so the adapter refuses them rather than approve ambiguous execution context. Bounded direct-patch support does not establish general shell enforcement. See the [native-hook runbook](codex-hook.md).

**App-server bridge.** `approval codex bridge` starts a child `codex app-server` over stdio and answers the approval requests that server emits through approval.md's decision path. It can bind command and working-directory information unavailable to the native hook. File-change requests need the appropriate bound content or correlated notification. The preflight stops when server-side auto-review answers first. This is not evidence that every possible native action generates a request. See the [bridge evidence and contract](codex-app-server-bridge.md).

**Workspace broker and confined process.** `approval codex apply` and `approval codex serve` provide bounded, gate-authorized canonical workspace writes. `approval codex start` provides the documented macOS confined-process path: disposable writable workspace, canonical read-only workspace, restricted reads and environment, and denied outbound network including loopback. Descendants are inside that confinement; an independently launched desktop process is not.

`approval codex prepare` creates an inert review bundle. It is not activation, account provisioning, or proof of installed custody. Linux confinement is not implemented in this build; the confined-session route refuses rather than silently falling back. Read the [constrained-session guide](codex-enforced-session.md), [workspace broker](codex-workspace-broker.md), and [activation runbook](codex-activation.md) together.

### MCP authority and remote clients

The MCP server derives its tools from the CLI registry and uses the same command implementations. Human-only verbs such as granting approvals, attesting policy, and setting vault credentials are not published. The server's agent identity is fixed at startup; a tool call cannot select a human identity.

Guest mode narrows the available tools further. It supports declaration, requests, and inspection without granting remote guests general command execution or adapter credential use. A network deployment still needs appropriate transport access control and custody; `--guest` is not an account system.

See the [MCP walkthrough](../examples/mcp-demo.md) and [guest connector runbook](../examples/grok-bot-connector/runbook.md). MCP tasks/elicitation mapping and exhaustive discovery of a client's native capabilities should not be inferred from the existence of an MCP server.

## The log, evidence, and privacy

```sh
approval log tail
approval log verify
approval status
```

Each event chains to its predecessor. Gate decisions use verified records, and decision-sensitive writes compare the expected head before appending. The queue and SQLite indexes are derived views; edit the authoritative policy through its ceremony and rebuild views rather than treating a cache as authority.

Keep these facts distinct: an agent proposed something; policy permitted it; a human granted it; execution started; an outcome was reported; an independent system witnessed an effect. They are related records, not synonyms.

### Checkpoints and external witnesses

A chain can reveal inconsistent edits, reordering, and other integrity failures. It cannot, on its own, reveal a valid suffix removed without an external anchor, or defeat an attacker able to replace the entire chain and its trusted context.

The runtime supports Git evidence and signed checkpoints. `approval setup checkpoint` provisions the checkpoint key; the policy lists accepted public keys and can request a checkpoint cadence. A due checkpoint is reported, not silently treated as a fresh signature or an authorization failure.

`approval coverage` compares available outside witnesses, including Git and supported provider observations, with gate evidence. Missing evidence is a finding, not automatic proof of malicious behavior. Equally, a log containing approvals is not proof that no unobserved effects occurred.

See [checkpoints](checkpoints.md), [Git evidence](git-evidence.md), and the [coverage reference](cli-reference.md#coverage).

### Follow the log

Downstream consumers can resume a verified stream with a sequence and its hash:

```sh
approval log follow --from <seq> --cursor-hash <hash> --json
```

The sequence is exclusive. Persist the processed sequence and hash after applying an idempotent effect: delivery across reconnects is at least once. A cursor without its expected hash is a weaker bootstrap, not the same continuity check. See [`log follow`](cli-reference.md#log-follow).

### Decide what to publish

**`approval init` does not ignore `.approval/log/` or `.approval/payloads/`.** The evidence is trackable by default. This can include real message text, recipients, paths, agent descriptions, and other information unsuitable for a public repository.

Review staged content before committing. Add local ignore rules when payloads or logs must stay private, or keep the evidence in a suitably private repository. Omitting payload bytes trades away the ability to reconstruct them from a public hash; it does not remove existing copies from history.

Vault files, environment maps, and sealed-delivery private keys are ignored by the scaffold. That is a convenience, not a guarantee that no one can accidentally stage a secret. `payload_retention` controls eligible local pruning; it does not erase Git history, channel messages, backups, or provider records.

## Operating and troubleshooting

`approval status` answers from runtime state. `approval doctor` checks this machine's configuration and health: build, identity, attestation, log, channels, sampling, credentials, hook wiring, and available evidence checks. It reports findings and suggested fixes; it does not repair them. A skipped optional check is not a passed security test.

In a directory `approval init` has just scaffolded, most of doctor's rows report `not applicable` rather than passing, and each names the absence it skipped on: `telegram`, `envelope-integrity`, `vault`, `environment`, `log-drift`, `harness-hook-outcomes`, `harness-hook-wiring`, `log-advance-cadence`, `dark-sessions`, `verified-snapshot`, `read-proof`, `main-behind-origin`, `attested-policy-on-main`, `harness-version-unverified`, `live-draw`, `checkpoint`, `gate-organs`, `sealed-keys`, `codex-hook-wiring`, and `sender-mapping`. A dash there reports a configuration you have not made yet. The one row expected to fail on the scaffolded policy is `audit-sampling`, because the scaffold names a sampling rate and does not provision the secret it needs.

| Symptom | Check first |
| --- | --- |
| Policy changed and work stops | Review the current bytes and re-attest; do not remove the mismatch check. |
| No approval arrives | Correct project/log, channel configuration, exported sources, listener health, and whether the tool actually triggered the hook. |
| Telegram polling conflicts | Another process or instance using the same bot, including on another host. |
| Sampling is disabled | A rate, the named secret, and the relevant daemon machinery are all required. The example scaffold does not provision the secret. |
| Hook denies an unclassified command | Inspect `approval hook classify`; use a supported representation or bounded adapter rather than hiding the command in an opaque wrapper. |
| An outcome is missing | Correct post-execution event wiring and whether the harness supplied an interpretable outcome. |
| Worktrees disagree about state | Primary policy/log selection, the documented log synchronization workflow, and stale compiled code. |
| A token is consumed or an effect is uncertain | Inspect the execution and provider evidence before requesting a new grant. |

The daemon can regenerate projections and perform its configured maintenance. It cannot safely invent an answer to a genuinely divergent hash chain. Do not resolve a log conflict by concatenating branches or deleting whichever records block startup. Follow the [dogfood operations guide](dogfood-cutover.md) and the relevant CLI reference.

`approval setup service` generates the supported launchd or systemd user-service configuration for inspection. A persistent service still needs the intended environment and instance, and should not compete with an already-running foreground listener.

### Exit codes

The CLI's frozen table is:

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | integrity failure (corrupt log) |
| 2 | usage error |
| 3 | torn tail |
| 4 | I/O error |
| 5 | no valid execution token (approval run only) |
| 6 | timeout (approval wait only) |

**Context matters.** Ordinary well-formed gate refusals also use exit 1; inspect the machine-readable `error.code` rather than interpreting every 1 as corruption. `approval run` returns the executed child's status. Harness hooks have their own protocol semantics: exit 0 can carry a deny verdict, and exit 2 can mean a blocking or visible hook report rather than CLI misuse. See the command's `--help` and its integration guide.

## Security and evidence limits

The intended setting is oversight of broadly cooperative agents, with stronger enforcement at boundaries that actually withhold authority. The [SPEC threat model](../SPEC.md) and integration runbooks carry the details.

**Policy integrity is not human authentication.** Attestation binds bytes. Local identities are declared by configuration; transport sender mappings identify an account. Neither proves a person's presence to a remote service that distrusts the host.

**A vault is useful only with custody.** An agent with another sending key, the vault passphrase, or control of the trusted runtime can bypass assumptions that an adapter alone cannot repair. An allow/deny response is not credential isolation.

**A hook is only as effective as its coverage and host.** Missing matchers, an unregistered hook, unsupported tools, scripts with unbound contents, and a harness that fails open all matter. MCP tool availability is not interception. Initial prompts and context may reach a model before any tool hook can intervene.

**Hashes do not make history immutable.** Preserve independently trusted anchors or checkpoints when the threat includes rewriting local history. A valid chain establishes internal consistency under its assumptions, not the absence of all off-log actions.

**Sandbox claims are route- and platform-specific.** The runtime has command-sandbox support and a separate macOS Codex confinement path. That is different from sandboxing every agent process. The ordinary command route's unsupported-platform behavior is not the confined-session route's fail-closed guarantee.

**Human judgment remains human judgment.** Showing the exact payload does not establish that approving it is wise, that its contents are true, or that a claimed cost is complete. Display-only model glosses, values, and feedback cannot confer authority. A deliberate human gate-open window is a recorded bypass, not an ordinary grant.

The [hardened-authorization proposal](proposals/hardened-authorization.md) explores a stronger trust tier. It is a proposal, not a property to infer from current tokens, sender mappings, or checkpoint signatures.

## How this compares

Three kinds of thing already exist in this space, and each solves a different
part of the problem. A hosted daemon and reviewer layer is operated by
Bountify.ai; it is optional, and nothing in the format depends on it
([GOVERNANCE.md](../GOVERNANCE.md)).

**Harness-native permission prompts** (Claude Code permission rules and hooks,
Cursor auto-run, Codex CLI approval modes) enforce inside the one harness they
ship with. That enforcement is real: a Claude Code PreToolUse deny holds even
under its bypass mode, and Codex backs its gate with an OS-level sandbox, which
this project does not attempt. What they lack is a durable record and
portability. None writes an append-only log of what was asked, who decided and
what ran; the decision reaches a human only as a terminal prompt; and the
mechanism does not travel to another harness. approval.md's Claude Code hook is
built on that PreToolUse mechanism and adds the two missing pieces: the
decision comes from an attested policy file, and it lands in a verifiable log.

**AGENTS.md permissions prose** states the policy in English and trusts the
agent to obey. Nothing parses it, nothing blocks a call against it, and no
record exists when it is violated. approval.md is the enforcement layer that
convention is missing, and treats it as an input: the permissions section of
this repository's own CLAUDE.md is the first import fixture.

**Framework interrupts** (LangGraph `interrupt()`, CrewAI human input, AutoGen
`UserProxyAgent`, the OpenAI Agents SDK's `needsApproval`, Temporal signal
approvals) give a developer a pause-and-resume primitive and leave policy,
audit format, the human channel and the credential boundary to them. They also
require adopting the framework. Temporal's event history is a real append-only
execution record with crash recovery this project does not claim, though it
lives in Temporal's storage rather than as policy-attested files in your repo.

**Hosted approval platforms** (HumanLayer, gotoHuman, Permit.io's access
requests) are the closest relatives: multi-channel human routing, review UIs,
and in Permit.io's case a real authorization engine richer than autonomy
classes. Their model is a third-party service in the decision path, with the
audit trail in the platform's backend, and the agent's own process still
choosing to honor the returned verdict. They bring hosted infrastructure,
escalation and team routing, and compliance certifications.

The difference is the combination: policy as a hash-attested markdown file in
your repo; an append-only, hash-chained log you verify locally with one
command; and an execution boundary where the credential is inert until a
single-use token is minted at the moment a human decides. Every framework
primitive and hosted API above relies on the agent's process honoring a
returned decision. Here the thing the agent needs, the credential, answers only
to the thing it cannot make, the token. The tradeoffs: you run the daemon and
listener yourself, there is no OS-level sandbox, no compliance certification,
and the reference phone channel is one app, Telegram.

## Developing and maintaining the project

### Repository map

| Area | Purpose |
| --- | --- |
| [`SPEC.md`](../SPEC.md), [`schema/`](../schema/) | Format, semantics, and machine-readable contracts. |
| [`src/core/`](../src/core/) | Policy, gate state, payloads, tokens, log verification, budgets, and related controls. |
| [`src/cli/`](../src/cli/) | Commands, setup, diagnostics, harness hooks, and the Codex bridge. |
| [`src/adapters/`](../src/adapters/) | Shared execution contract, credential providers, and built-in effect adapters. |
| [`src/channels/`](../src/channels/), [`src/daemon/`](../src/daemon/), [`src/mcp/`](../src/mcp/) | Presentations and transports around the runtime. |
| [`src/codex/`](../src/codex/), [`templates/codex/`](../templates/codex/) | Constrained-workspace preparation and broker/session support. |
| [`tests/`](../tests/), [`conformance/`](../conformance/), [`scripts/`](../scripts/) | Regression tests, language-neutral vectors, probes, and development tooling. |
| [`docs/`](./), [`examples/`](../examples/), [`design/`](../design/) | Integration contracts, walkthroughs, operations, and design records. |
| [`backlog/`](../backlog/) | Implementation work and remaining acceptance criteria. A task's existence is not a shipped feature. |
| [`index.html`](../index.html), [`features/`](../features/), [`llms.txt`](../llms.txt), [`llms-full.txt`](../llms-full.txt) | The website and its machine-readable companions. |
| [`metrics/`](../metrics/), [`brand/`](../brand/) | Agent-hour badge data and visual assets. Badge activity is not an adoption or security certification. |
| [`hosted/`](../hosted/README.md), [`judgy/`](../judgy/README.md) | Hosting scaffolding and reviewer/demo pages; separate from the core runtime contract. |

The hosted directory contains a policy builder and tenant launcher, not a complete account system or managed multi-tenant control plane. Judgy's pages render supplied data and retain simulated/replay/not-run provenance labels; a visualization is not a new authorization path. Neither should be advertised as a finished service merely because its directory exists.

### Running the checks

```sh
npm ci
npm run build
npm test
npm run lint
npm run typecheck
npm run conformance
```

For the workflow while editing and before pushing:

```sh
npm run check:changed
npm run ci:local
```

The repository classifies changes into documentation, records, and full-check tiers; the shared scripts decide rather than a contributor asserting a lighter tier. The protected-path evidence guard is a separate concern from passing ordinary tests. A local run does not reproduce every CI platform or installed harness.

The [conformance suite](../conformance/README.md) checks language-neutral vectors and their manifest. Negative controls matter: a verifier accepting broken evidence has not passed just because it also accepts valid evidence. Live provider and harness probes remain separate from fixture success.

### Keep documentation from growing stale

The short README owns the introduction, a usable starting path, and integration signposts. This guide owns the product tour and operating boundaries. Exact flags belong in the [CLI reference](cli-reference.md); policy field completeness belongs with the schema and specification. Avoid duplicating volatile diagnostic row counts, release-state paragraphs, and provider claims across all three.

[`tests/docs-guard.test.ts`](../tests/docs-guard.test.ts) holds this guide to the frozen sources: the exit-code table, the refusal names the AgentMail section quotes, every autonomy level the schema admits, every policy key the schema defines (the dictionary above), the doctor rows a fresh directory skips, the seq 2 citation, and the web channel's CSRF stance. It also checks that the root README still links here. When a claim moves between documents, move its assertion in the same change. Do not delete the behavioral coverage or hide obsolete text in comments to pass it.

This guide ships in the npm package through the explicit `files` list in `package.json`, beside `README.md` and the CLI reference. The website's feature index and `llms-full.txt` link into this guide's sections; the short README keeps several older anchors as navigation compatibility points, and their detailed material lives here.

### Contributing, license, and governance

Read [CONTRIBUTING.md](../CONTRIBUTING.md), including the DCO sign-off, and the repository's [agent instructions](../AGENTS.md) before changing code or governing documents. Proposed designs and pending sign-offs must remain distinguishable from adopted behavior.

The code is [Apache 2.0](../LICENSE); the specification and schemas are [CC0 1.0](../schema/LICENSE). [GOVERNANCE.md](../GOVERNANCE.md) explains stewardship, use of the name, and the relationship to optional hosted offerings. The file format and reference runtime do not require a proprietary hosted service.
