# approval.md

[![ci](https://github.com/approval-md/approval.md/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/approval-md/approval.md/actions/workflows/ci.yml)
[![fable](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fapproval-md%2Fapproval.md%2Fmain%2Fmetrics%2Fagent-hours.json&query=%24.agents.claude-fable.hours&label=fable&suffix=h&color=d97757)](docs/agent-hours.md) [![opus](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fapproval-md%2Fapproval.md%2Fmain%2Fmetrics%2Fagent-hours.json&query=%24.agents.claude-opus.hours&label=opus&suffix=h&color=d97757)](docs/agent-hours.md) [![astra](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fapproval-md%2Fapproval.md%2Fmain%2Fmetrics%2Fagent-hours.json&query=%24.agents.codex-astra.hours&label=astra&suffix=h&color=10a37f)](docs/agent-hours.md) [![sol](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fapproval-md%2Fapproval.md%2Fmain%2Fmetrics%2Fagent-hours.json&query=%24.agents.codex-sol.hours&label=sol&suffix=h&color=10a37f)](docs/agent-hours.md) [![cursor](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fapproval-md%2Fapproval.md%2Fmain%2Fmetrics%2Fagent-hours.json&query=%24.agents.cursor.hours&label=cursor&suffix=h&color=6c5ce7)](docs/agent-hours.md) [![agent hours](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fapproval-md%2Fapproval.md%2Fmain%2Fmetrics%2Fagent-hours.json&query=%24.total_hours&label=agent%20hours&suffix=h&color=555)](docs/agent-hours.md)

**A harness-agnostic, open-source framework for approving agent actions with a human in the loop.**

Let your agents work. Decide where they need you.

Write an `APPROVAL.md` that says which actions can happen freely, which need a tap, and which stay in human hands. Approve from Telegram, a terminal, or a local web queue. Keep the policy and the record of decisions in files you can read and verify.

Let an agent draft your email, but ask before sending it. Let it edit your project, but stop before pushing to main. Review a sample of routine work instead of every action.

[Website](https://approval.md/) · [Extended guide](docs/README-extended.md) · [Specification](SPEC.md) · [CLI reference](docs/cli-reference.md)

## Get started

**Node.js 20 or newer.** In your project directory:

```sh
npm install -g approval-md
approval quickstart
```

The walkthrough asks who you are, where approvals should arrive, and which action families should always ask. It shows the policy before you attest it. Telegram setup is included when you choose it.

The quickstart gives **other classified, reversible actions an autonomous default**. Change `defaults.autonomy` to `manual` for a more conservative policy, then re-attest. Runtime safety floors and unclassified-command refusals still apply.

Activate the environment using the command the walkthrough prints. From the same project directory:

```sh
eval "$(approval env)"
approval up
```

This starts the daemon and configured channel listeners. It **does not install a harness hook**: connect your agent below. For terminal decisions, run `approval channel cli` in another human-controlled terminal.

Prefer to build the policy yourself? Start with `approval init` and follow the [manual setup](docs/README-extended.md#manual-setup). For unreleased features or contributions, use a [source checkout](docs/README-extended.md#install-from-source).

## Define what needs approval

Five autonomy levels, chosen per action class:

| Level | What happens |
| --- | --- |
| `autonomous` | Proceeds without asking, subject to the policy and runtime checks. |
| `supervised-retro` | Proceeds; a configured sample is reviewed afterwards. |
| `supervised-live` | A declared fraction pauses for approval; the rest proceeds. |
| `manual` | Each action waits for human approval. |
| `human-only` | The human performs the action. An agent cannot request permission to do it. |

An `APPROVAL.md` can look like this. This example uses a more conservative default than the quickstart; replace `you` with your chosen approver ID.

````markdown
# Approval Policy

Work freely inside this project. Ask before reaching outside it.

```yaml approval-policy
version: "0.1"
defaults: { autonomy: manual, channel: cli, approval_ttl: 24h }
approvers:
  you: { channels: [cli] }
classes:
  read.*:                    { autonomy: autonomous }
  read.file.out_of_scope:     { autonomy: manual }
  files.write.workspace:     { autonomy: autonomous }
  vcs.push.main:             { autonomy: manual }
  communicate.email.external: { autonomy: manual }
  financial.spend:           { autonomy: manual, limits: { per_action_usd: 25 } }
  account.credential:        { autonomy: human-only }
```
````

Class names describe actions; they do not install an integration for them. `supervised-live` needs a `live_rate` and sampling setup. The deprecated `supervised` spelling remains an alias of `supervised-retro`.

An edit invalidates the previous attestation. To land a change, run the amendment ceremony: it shows the semantic diff, attests the exact bytes, and commits the policy and the log together. In a git repository, add `--pr` and it opens the pull request for you.

```sh
approval policy amend --require-load --as human:you
```

`approval policy attest --as human:you` is the bare attestation for a policy you have already reviewed by other means. Loosen some rules, tighten others, amend, keep going. [Policy details](docs/README-extended.md#define-what-needs-approval).

<a id="the-other-half-of-the-word"></a>

### Add your voice

The file can also carry an optional `yaml approval-values` block: what you `love`, `like`, `dislike`, and how you prefer to communicate. `approval values` and `approval feedback` make that guidance available to agents; `approval journal write` gives them a channel back.

Values and reactions inform the work. They do not change permissions. [Values and feedback](docs/README-extended.md#values-and-feedback).

## Gate your coding agent

Use the integration for the harness you actually run. A hook controls the tool calls it is wired to receive, not every possible action on the machine.

| Integration | Route and important distinction |
| --- | --- |
| [Claude Code](docs/claude-code-hook.md) | `approval hook claude-code`; wire pre-execution and outcome hooks. |
| [Cursor](docs/cursor-hook.md) | `approval hook cursor`; the hook entry requires `failClosed: true`. |
| [Claude Agent SDK](docs/agent-sdk-hook.md) | Python `HookMatcher` shim calling the same Claude Code hook. |
| [Codex](docs/README-extended.md#codex-is-several-integration-paths) | MCP, an app-server bridge, and constrained-workspace tooling; native hook enforcement remains experimental. |
| [Grok Build](docs/grok-hook.md) / [Muse Code](docs/muse-hook.md) | Dedicated hooks; both have documented harness-level fail-open limitations. |
| [Hermes Agent](docs/hermes-hook.md) | New source-only hook; live verification is still pending. |
| [Any MCP client](examples/mcp-demo.md) | `approval mcp serve`; exposes gate tools, but does not intercept the client's native tools. |

Inspect a shell command's classification without running it:

```sh
approval hook classify -- git push origin main
```

The [extended guide](docs/README-extended.md#harnesses-and-mcp) covers wiring, read scope, coverage gaps, and what each route has actually demonstrated.

## Put approvals on your phone

Telegram prompts separate runtime-computed facts from agent claims and show the payload being approved. A tap records the decision; the agent can continue through the appropriate execution path. The terminal and loopback web queue use the same log.

[Telegram walkthrough](examples/telegram-demo.md) · [Channel setup and identity](docs/README-extended.md#channels-and-identity)

<a id="first-class-zzzbot-messages"></a>

## Hand a grant to a real credential

The runtime includes adapters for [SMTP email](examples/email-demo.md), [AgentMail drafts](examples/agentmail-demo.md), and [zzz.bot threads and replies](docs/README-extended.md#first-class-zzzbot-messages), plus a [public adapter API](docs/adapter-api.md).

Keep the sending credential in the runtime's vault, not in the agent's hands. On paths requiring approval, a single-use grant binds the payload before the adapter executes. Explicitly permitted autonomous or supervised paths do not require a human grant.

<a id="cant-the-agent-just-go-around-it"></a>

## Know the boundary

approval.md is an oversight layer for broadly cooperative agents, not blanket containment for a hostile process on a machine it controls. Credential custody, hook wiring, and the harness's failure behavior determine what is enforced. Local human identity is config-declared; a hash-chained log is tamper-evident, not proof of personhood or an immutable history by itself.

**Before committing real data:** the scaffold does not ignore the event log or stored approval payloads. Decide what should remain private before putting messages or other sensitive material in a public repository.

[Security and evidence limits](docs/README-extended.md#security-and-evidence-limits)

<a id="the-approvalmd-dictionary"></a>
<a id="running-the-checks"></a>
<a id="exit-codes"></a>
<a id="how-this-compares"></a>

## Read on

The [extended guide](docs/README-extended.md) covers policy controls, channels, credentials, the event log, troubleshooting, and development. The [specification](SPEC.md), [schemas](schema/), and [CLI reference](docs/cli-reference.md) carry the detailed contracts.

[Contributing](CONTRIBUTING.md) · [Conformance](conformance/README.md) · [Changelog](CHANGELOG.md) · [Governance](GOVERNANCE.md)

Code: [Apache 2.0](LICENSE). Specification and schemas: [CC0 1.0](schema/LICENSE). Releases are approved through approval.md.
