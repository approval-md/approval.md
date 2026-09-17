# Integrations considered

The canonical record of every external adapter, harness, updater, gateway,
channel or protocol this project has evaluated for integration, whatever the
verdict. An assessment that lives only in a chat transcript is repeated the
next time the question comes up, usually with a different answer. This file
is where the answer lives.

Scope: concrete candidates we could wire code to. Design prior art (the
harness permission systems, HumanLayer, A2A, and the rest) stays in SPEC.md
§2 and §15. A parked or adopted candidate keeps its detailed design elsewhere
(a proposal under `docs/proposals/`, a Backlog task, an adapter README); the
entry here is the summary and the pointer.

## Summary

| Candidate | Link | Assessed | Kind | Verdict | Pointer |
| --- | --- | --- | --- | --- | --- |
| Tool-gateway adapter (AnyAPI, Monid) | [getanyapi.com](https://api.getanyapi.com/mcp), [monid.ai](https://mcp.monid.ai/v1) | 2026-08-31 | gateway | parked | [docs/proposals/tool-gateway-adapter.md](proposals/tool-gateway-adapter.md) |
| UCA (Universal Coding Agent Harness Updater) | [UNIVERSAL_CODING_AGENT_HARNESS_UPDATER.md](https://github.com/Dicklesworthstone/misc_coding_agent_tips_and_scripts/blob/main/UNIVERSAL_CODING_AGENT_HARNESS_UPDATER.md) | 2026-09-02 | updater | declined | APRV-227, APRV-228 |
| Grok Build (xAI coding-agent harness) | [docs.x.ai/build](https://docs.x.ai/build/overview), [xai-org/grok-build](https://github.com/xai-org/grok-build) | 2026-09-02 | harness | parked | APRV-243 |
| Grok Bot (xAI agent product) | [x.ai/news/grok-bot-and-x](https://x.ai/news/grok-bot-and-x) | 2026-09-02 | agent product (MCP client) | adopted (demo) | APRV-245, APRV-246 |
| Claude for commerce agents (anthropics/commerce-agents) | [blog](https://claude.com/blog/claude-for-commerce-agents), [repo](https://github.com/anthropics/commerce-agents) | 2026-09-02 | blueprint | declined | APRV-242, APRV-228 |
| Muse Code (Meta coding agent) | [developer.meta.com](https://developer.meta.com/ai/products/muse-code/) | 2026-09-16 | harness | parked, unverified | APRV-347 |

Verdicts: **adopted** (code exists or is scheduled in a milestone),
**parked** (design verified, no code, activated on demand), **declined** (no
integration; the reasons are recorded so the question is not re-opened by
accident).

## Tool-gateway adapter (AnyAPI, Monid)

Assessed 2026-08-31. Verdict: **parked**.

### What it is

Paid MCP tool gateways that sell per-call access to third-party data APIs
(people search, profile enrichment) against a prepaid USD wallet. The
candidate integration is a provider-neutral adapter that puts the
deterministic gate between an agent and the gateway, on our side of the
wallet.

### What it exposes

Verified against both providers' public docs on the assessment date. AnyAPI:
Streamable HTTP MCP endpoint with Bearer auth, a `run_api` tool, dot-path SKU
addressing, `costUsd` in the response, synchronous execution. Monid: MCP over
OAuth plus a REST run endpoint, provider-plus-endpoint addressing, cost in
micro-dollar units, asynchronous 202-and-poll execution with an upstream
`BLOCKED` status that is a provider refusal rather than our approval. The
differences are what justify a provider config file per gateway rather than
provider-specific code.

### Fit

Strong on the data-governance axis: platform metrics see one API key and
cannot attribute calls to an agent identity or session, enforce a purpose on
PII SKUs, fire mid-fan-out, or separate fetch from persist. Every one of those
is a deterministic rule the gate can hold, with counters derived from verified
records (§11.1 invariant 1) and fetch and persist kept apart by class. Weak on
the spend axis: wallet caps already bound dollar risk, so a cost backstop
duplicates a control the platform has. Needs one additive event type
(`execution.metered`), which is a SPEC §8 amendment and human sign-off.

### Conclusion

Parked. Customer feedback on the assessment date said spend is modest and
capped platform-side, and the audit trail is not a felt need. The
data-governance case is untested rather than refuted; it becomes live when a
customer needs PII governance or a compliance story.

### Next steps

None until that demand appears. On activation, the proposal carries a
ten-task decomposition, starting with the `execution.metered` amendment.
Detailed design: [docs/proposals/tool-gateway-adapter.md](proposals/tool-gateway-adapter.md).

## UCA (Universal Coding Agent Harness Updater)

Assessed 2026-09-02. Verdict: **declined**.

### What it is

A single zero-dependency Bash script that keeps five coding-agent harnesses
(Claude Code, Codex, Antigravity, Grok, OMP) at their latest release. It
takes an atomic lock, checks free disk, updates each harness with the command
its install method wants (`claude update`, `npm install -g`, `bun install -g`,
`codex update`), smoke-tests with `<harness> --help`, records version
transitions in `~/.local/share/uca/state.json`, and sends a desktop
notification on change. A launchd or systemd timer runs it every three hours.
The question asked was whether approval.md should ship a pre-launch adapter
that integrates with it.

### What it exposes

Verified against the linked document on the assessment date. Present:
`uca --dry-run` (report versions, change nothing), `ucas --json` (full state
dump, field structure undocumented), `uca doctor` with defined exit codes,
and one environment variable for the disk threshold. Absent: pre- or
post-update hooks, a config file, version pinning, a skip list, any
shell-startup or pre-launch integration, and any prompt or approval step
before an upgrade is applied.

What the gate makes of the commands it issues, from `approval hook classify`
on the assessment date:

| Command | Class |
| --- | --- |
| `npm install -g @anthropic-ai/claude-code` | `deps.add` |
| `bun install -g @openai/codex` | `deps.add` |
| `claude update` | unclassified (denied, `hook-unclassified`) |
| `codex update` | unclassified (denied) |
| `uca` | unclassified (denied) |
| `uca service install` | unclassified (denied) |

Since APRV-228 the four unclassified rows classify `deps.upgrade` (rules
`harness-update` and `harness-updater` in `docs/claude-code-hook.md`), which
the reference policy leaves on the manual default: still denied unattended,
now with a class a human can grant.

### Fit

Poor, on three counts.

1. **There is nothing to integrate with.** No hooks, no config, no pin, no
   stable JSON. An adapter would wrap a personal script with no contract to
   test against. The adapter contract in `src/adapters/contract.ts` is for
   token-gated side-effect executors; UCA is neither an executor we would
   gate nor a channel we would decide through.
2. **Its model contradicts the project's stance.** SPEC §7 makes a dependency
   change a supply-chain decision that resolves `manual`. UCA makes that
   decision on a timer with nobody in the loop, for the binary that hosts
   the PreToolUse hook. A harness release that changes the hook envelope can
   stop the gate firing with no record anywhere. Integrating would bless the
   path the taxonomy exists to gate.
3. **A human updating their own machine is outside the gate by design.**
   That side needs nothing built. What the gate should notice is the effect:
   the harness under a session is no longer the one the hook was last
   verified against.

A `SessionStart` hook was considered and rejected: a check at session start
that a later timer run invalidates is a check that lies. Per-record
provenance plus a doctor row covers the same ground without a new hook
surface.

### Conclusion

Declined. No adapter, no UCA-specific code. The two useful things the
question surfaced are general to every harness upgrade path and are filed
below.

### Next steps

- APRV-227: hook-written records carry the harness version, and
  `approval doctor` fails on an unverified change until the hook self-test
  re-records it.
- APRV-228: `claude update`, `codex update` and the UCA verbs classify
  `deps.upgrade` instead of falling to unclassified, so the refusal names
  the class a human can grant.

## Grok Build (xAI coding-agent harness)

Assessed 2026-09-02. Verdict: **parked**, activated by the live probe in
APRV-243.

### What it is

xAI's terminal coding agent (`grok`, open source under Apache 2.0 at
xai-org/grok-build, installed by `curl -fsSL https://x.ai/cli/install.sh |
bash`). It runs shell commands and edits files the way Claude Code and Cursor
Agent do, reads `AGENTS.md` and `CLAUDE.md`, and has a permission system
(`ask`, `auto`, `always-approve`, plus allow and deny rules in
`~/.grok/config.toml`). The question asked was whether approval.md should
build a pre-launch adapter or integration for it.

### What it exposes

Verified against docs.x.ai/build/features/hooks on the assessment date,
quoted verbatim. Hooks are modelled on Claude Code's, with `PreToolUse` among
fourteen events, configured in `~/.grok/hooks/*.json` or
`<project>/.grok/hooks/*.json`, with a per-hook `timeout` (default 5s) and a
`type` of `command` or `http`.

- Input: "The event arrives as JSON on stdin, including `hookEventName`,
  `sessionId`, `cwd`, `workspaceRoot`, and for tool events `toolName` and
  `toolInput`." CamelCase, so the claude-code parser reads no `tool_name`.
- Decision: "A `PreToolUse` hook decides by writing JSON to stdout:
  `{ "decision": "deny", "reason": "Unsafe command detected" }`. Exit code 0
  allows, exit code 2 denies."
- Failure: "Everything else, timeouts, crashes, malformed output, is
  fail-open: the failure is recorded in the session but the tool call
  proceeds." No flag changes this.
- Compatibility: "Claude Code (`.claude/settings.json`) and Cursor
  (`.cursor/hooks.json`) hook files are read as well, including Cursor's
  camelCase event names." How their output dialects are handled is not
  documented.

Unverified: the version history (secondary sources say 1.0.0 on 2026-08-07;
the xAI release-notes page shows a conflicting date and the changelog page
refused the fetch), and any npm package name. Grok Bot, a separate product,
has its own entry below.

What the gate makes of the commands involved, from `approval hook classify`
on the assessment date:

| Command | Class |
| --- | --- |
| `curl -fsSL https://x.ai/cli/install.sh \| bash` | opaque (denied, `hook-opaque`) |
| `npm install -g @xai/grok-build` (name unverified) | `deps.add` |
| `grok` | unclassified (denied) |
| `grok -p "fix the tests"` | unclassified (denied) |
| `grok mcp add --transport stdio approval approval mcp` | unclassified (denied) |

### Fit

Good on the shape, with one contradiction and one hazard.

1. **It is a harness with a pre-tool hook**, the same kind of surface
   `approval hook claude-code` and `approval hook cursor` already answer. A
   Grok adapter is a third row in the harness table in `src/cli/hook.ts`
   (input keys, output dialect, deny by exit 2), the same deterministic core
   behind it, and a `docs/grok-hook.md`. Neither the adapter contract in
   `src/adapters/contract.ts` nor the channel contract is involved.
2. **Its failure model contradicts the fail-closed invariant.** A hook that
   times out, crashes or prints something Grok cannot parse lets the tool
   run. Cursor has `failClosed: true`; Grok documents no equivalent. An
   adapter can make every answered case honest and must state plainly that
   the unanswered cases are open. A manual-class wait is minutes long, so the
   per-hook `timeout` has to be raised above `--timeout` or every wait is an
   allow.
3. **The compatibility read is the hazard, and it exists today with no
   adapter.** If a Grok session in this repository fires the committed
   `.claude/settings.json` entry, the hook receives a camelCase envelope,
   parses no tool name, prints its deny in the Claude nested envelope and
   exits 0. Grok reads exit 0 with no `decision` key. The most likely result
   is that every command looks gated and none is, with a deny reason nobody
   reads. Whether the read fires at all is undocumented, which is why the
   probe comes before the code.

"Pre-launch" in the sense of a `SessionStart` hook is rejected on the UCA
reasoning: a session-start check is invalidated by anything that happens
later. Per-tool gating is the surface; harness version provenance (APRV-227)
covers the rest.

### Conclusion

Parked. The adapter is cheap and the shape fits, but the two facts the
verdict rests on (does the Claude-file compatibility read fire, and how does
Grok treat the Claude output dialect on exit 0) are undocumented and need a
running Grok Build, which a human installs (the installer is opaque to the
classifier). Until then: do not run Grok Build in this repository expecting
the gate to hold, and treat `grok` as the unclassified command it is.

### Next steps

- APRV-243: the live probe, then `approval hook grok` (Grok envelope in,
  Grok dialect out, exit 2 on deny), `.grok/hooks/` classified `policy.core`,
  and a hook doc that names the fail-open cases. The entry moves to adopted
  or declined on the probe's result.

**Status update, 2026-09-16.** The code half of APRV-243 has landed and the
entry STAYS PARKED, because parked is about the probe and not about the
adapter. What exists now: `approval hook grok` (camelCase envelope in,
`{decision,reason}` out, deny at exit 2, post-execution always exit 0),
`.grok/hooks/` classified `policy.core` beside `.cursor/hooks.json`,
`docs/grok-hook.md` naming the fail-open cases the adapter cannot cover, and
`tests/cli-hook-grok.test.ts`. The probe Carter runs inside a Grok session is
`scripts/probes/grok-build-hook.mjs`: `--arm` prints the `.claude/settings.json`
entry to install by hand, `--report` prints the three answers. It is read-only
and writes only under the system temp root. Both facts the verdict rests on are
still undocumented and still unobserved, so the standing warning above is
unchanged: do not run Grok Build in this repository expecting the gate to hold.
SPEC.md was deliberately not amended; `docs/grok-hook.md` carries the proposed
hunk and the reason it is not a match for the Cursor row.

## Grok Bot (xAI agent product)

Assessed 2026-09-02. Verdict: **adopted (demo)**, through the MCP surface
that already exists; no Grok-specific code.

### What it is

A separate xAI product from Grok Build, in early beta from around
2026-08-11: persistent agents that run tasks end to end and "return for
approval" through xAI's desktop app and an iPhone companion app. The
approval step and the runtime are xAI's own; no official documentation page
for either was reachable on the assessment date, so the product description
rests on secondary sources.

### What it exposes

Revised 2026-09-05 against xAI's own pages. Grok Bot runs on Cursor-hosted
cloud computers and is bundled into Cursor Pro+/Ultra/Teams and SuperGrok
Plus/Heavy tiers (docs.x.ai/grok-bot/security, reported tiers). It ships its
own approval layer: sends, publishes, purchases, deletes, permission changes
and production changes prompt Allow or Deny in the desktop and phone apps, and
admins can set Auto Review rules (docs.x.ai/grok-bot/approvals-security-and-privacy).
AgentMail is an official plugin inside it, with a built-in "Approval" template
that holds one send until a yes reply (agentmail.to/build/grokbot). No
third-party pre-action hook, no webhook, and no documented link to Grok
Build's hook files.

The one surface we can wire to is custom MCP connectors
(docs.x.ai/grok/connectors): a server URL plus auth, reachable over the public
internet, with a tunnel named as the way to expose a local server; transports
are streamable HTTP and SSE (docs.x.ai/developers/tools/remote-mcp). No
command line was found to classify.

That is the client half of `approval mcp serve --http` (SPEC §10.5,
APRV-174): a streamable-HTTP MCP server on a loopback bind behind a tunnel,
`--guest` minting one `agent:guest-<id>` per session, the guest tool list
intersected rather than extended, and the `wait` clamp of APRV-175. The
server checks no header and authenticates nobody by design; guest mode and
the session caps are the protection.

### Fit

Good as a demo, and honest only if three tiers are stated with it. MCP use
is voluntary: a connected agent can call `request`, `wait` and `run`, or
simply act. The gate does not have to be trusted to be useful, because side
effects leave witnesses elsewhere.

| Tier | What holds | Where it holds |
| --- | --- | --- |
| Prevented by custody | Adapter-held credentials answer only to a token (SPEC §10.4, the AgentMail two-key model, APRV-222). An agent holding the connector and not the key cannot send around the gate. | send, spend, delete on a provider |
| Witnessed by a log we do not write | `approval coverage` (APRV-245) joins effects git, `gh` and a provider's own records can see against verified records, and reports each with its evidence or `none`. Informational: no verdict moves. | repository effects, adapter-backed effects |
| Not covered | Effects made with credentials the agent holds itself, for example pasted into Grok Bot and used from xAI's cloud. No witness reaches us. The remedy is custody, the first tier. | everything else |

Grok Bot's own Allow/Deny prompt and AgentMail's Approval template are
single-vendor approve-clicks: each answers inside one product, neither writes a
record a third party can verify, and neither reaches an effect made through a
different tool. That is the pitch, stated affirmatively: approval.md is one
policy file and one hash-chained log across Cursor, Grok Build, Grok Bot and
the adapters, with credential custody the agent cannot route around and a
coverage report for what it did not route through. A decision that is not in
the verified log did not happen as far as the gate is concerned.

### Conclusion

Adopted as the connector demo: a Grok Bot agent uses the gate through the
connector, then skips it, and the witnesses show the difference. The demo is
the runbook in APRV-246 and the coverage verb in APRV-245. No Grok Bot code
is written; if xAI documents an approval API or webhook, the product is
assessed again as a channel candidate.

### Next steps

- APRV-245: `approval coverage`, the observed-effects join (git, `gh`,
  adapter `observe`), informational, with the three tiers written under the
  verb.
- APRV-246: `examples/grok-bot-connector/runbook.md`, the beats above, with
  the TBDs only a rehearsal settles (connector transport, whether Grok Bot
  holds a long `wait`, the identity it presents, whether its cloud computer
  reaches a quick tunnel).

## Claude for commerce agents (anthropics/commerce-agents)

Assessed 2026-09-02. Verdict: **declined**.

### What it is

Anthropic's reference blueprint for retail, marketplace and travel agents,
announced 2026-09-01 and published at
[github.com/anthropics/commerce-agents](https://github.com/anthropics/commerce-agents)
(Python 3.11, Apache-2.0, one commit, README: "reference implementation; it
is not maintained and does not accept contributions"). Two agents, each on
three runtimes (Messages API, Agent SDK, Managed Agents). The **shopping
agent** searches, compares, builds a cart and hands off to checkout; it never
transacts, `checkout_handoff` returns a hosted URL that "never passes through
the model", and payment stays with the retailer. The **merchant agent**
analyses performance and drafts listing edits, price moves, promotions,
restocks and campaigns. Every merchant write is staged
(`ChangeLedger.stage` in `merchant-agent/core/merchant_agent/changes.py`)
and `apply_change` succeeds only for a change id the host has marked
approved. The question asked was whether approval.md should ship a
pre-launch adapter that integrates with it.

### What it exposes

Verified against the repository on the assessment date (README,
`docs/safety.md`, `docs/backends.md`, the merchant Agent SDK runtime and
core). The seam an adapter would target is three methods on an in-memory,
per-session `MerchantToolset`: `pending_host_approvals()`,
`host_approve(change_id)`, `host_clear(change_id)`. The host's approval
surface is a comment in the runtime README (`if operator_approved(change):`)
and, in the console, a `y/N` prompt. `require_host_approval` is a config
flag; `--no-host-approval` lets a "yes" typed into the chat apply the change
instead. The apply itself runs in the agent's own process through the
deployment's `MerchantBackend`, with whatever credentials that process
holds. Guardrails (`changes.py`, `gates.py`) are static caps: price move,
promotion depth, restock size, campaign budget. The Agent SDK runtime sets
`permission_mode="dontAsk"` over an allow-list of `mcp__merchant__*` tools
and registers one post-tool-batch hook; no PreToolUse hook, no permission
callback. Absent: any webhook, queue, callback or plugin interface for an
external approval system. Every deployment forks the repo and replaces the
mock backend, so the interface is a code pattern rather than a wire
contract.

What the gate makes of the commands it would cause an agent to issue, from
`approval hook classify` on the assessment date:

| Command | Class |
| --- | --- |
| `python merchant-agent/runtime-agent-sdk/main.py` | unclassified (denied, `hook-unclassified`) |
| `pip install -e merchant-agent/core` | unclassified (denied) |
| `scripts/install.sh` | unclassified (denied) |
| `claude plugin install commerce-builder@claude-commerce-agents` | unclassified (denied) |
| `pytest merchant-agent/runtime-agent-sdk/tests` | unclassified (denied) |

### Fit

Poor, on four counts.

1. **There is nothing to integrate with.** The approval seam is three
   methods on a per-session Python object in a reference repository that is
   unmaintained by declaration and forks per customer. An adapter would
   target a README snippet, with no contract to test against. It is neither
   an executor under `src/adapters/contract.ts` nor a channel under
   `src/channels/contract.ts`: it is the agent, and its host is the surface
   approval.md would replace.
2. **The gate could not hold custody.** SPEC §10.4's boundary is that
   credentials answer only to tokens. Here the write happens inside the
   agent's process via `MerchantBackend`, a `host_approve` mark is advisory,
   and a config flag turns it off. Recording a `financial.spend` or
   `record.write` grant for a change the gate cannot stop from applying is a
   self-reported field reducing scrutiny (§11.1). A real integration means
   the backend's write methods consuming an approval.md token from Python,
   for which there is no client. Building that client for a reference
   repository is the wrong order.
3. **The shopping side has nothing to gate.** Checkout is a handoff; the
   money moves in the retailer's portal, outside any agent.
4. **Pre-launch value is nil.** The blueprint's audience is Shopify,
   Priceline and Accenture-scale integrators with their own merchant portals
   ("the portal's approve route"). approval.md launches local-first,
   single-operator. A commerce demo would have no one to run it.

### Conclusion

Declined. No adapter, no commerce-specific code. Two general things the
question surfaced are filed below. Noted and left alone: no adapter has yet
driven `financial.*` through the gate (this repo's APPROVAL.md has no
financial class); that gap is real, and this candidate is not the one to
fill it.

### Next steps

- APRV-242: an Agent SDK host runs `permission_mode="dontAsk"` with no
  record, which is the "harness enforces locally" pattern SPEC §2
  critiques, and M8 covers Claude Code and Cursor but not
  `claude-agent-sdk` applications. The Python SDK's hooks are callables
  receiving the same PreToolUse input `approval hook claude-code` reads on
  stdin, so a documented shim makes every Agent SDK app gateable with no
  new surface. The JSON shapes are verified there, not assumed.
- APRV-228, extended: `pip install`, `pipx install` and `uv pip install`
  classify `deps.add` alongside `npm install -g` and `bun install -g`,
  instead of falling to unclassified.

## Muse Code (Meta coding agent)

Assessed 2026-09-16. Verdict: **parked, and explicitly unverified**: the read
scope this repository built for it (APRV-347) needs no Muse-specific code at
all, and everything that WOULD need code is resting on secondary sources.

### What it is

Meta's terminal coding agent, powered by the Muse Spark model family, in beta
since 2026-08-05. It is the same shape as Claude Code, Cursor Agent and Codex
CLI: a CLI run from a project directory (`muse-code init`, `muse-code auth
login`), which is why the request that produced APRV-347 was phrased as "an
agent working under `~/dev/muse`". Announced at
[developer.meta.com/ai/products/muse-code](https://developer.meta.com/ai/products/muse-code/)
and covered on the day by
[TechCrunch](https://techcrunch.com/2026/08/05/meta-launches-muse-code-an-ai-agent-for-large-code-bases/),
[CNBC](https://www.cnbc.com/2026/08/05/meta-debuts-muse-code-to-take-on-anthropic-and-openai-.html)
and
[VentureBeat](https://venturebeat.com/orchestration/meta-enters-the-ai-coding-wars-with-muse-spark-1-2-and-muse-code-with-persistent-async-background-agents).

**A name collision worth recording**, because the next person to read "Muse"
will hit it. Meta also ships a CONSUMER product called Muse, a personal agent
that asks for access to email, calendar, payments and health data
([TechCrunch, 2026-09-08](https://techcrunch.com/2026/09/08/meta-debuts-its-muse-ai-agent-will-consumers-trust-it/)).
That one is not a development harness and is not what this entry is about; its
side-effect surface (money, mail) would be a completely different assessment.
Several unrelated products also carry the name (muse.ai video hosting, the
Muse meditation headband, muse.place); none of them surfaced as a coding agent.

### What it exposes

**Read this section as unconfirmed unless it says otherwise.** Research for
this entry was a web survey, not a live install, and the most specific
material about the hook contract came from third-party sites — one of which
(`musecodes.io`) self-discloses as an unofficial fan site, and others
(`agenticcontrolplane.com`, `docs.asymptotelabs.ai`) describe internals in
more detail than Meta's own documentation does. One of those sources *disputes
Meta's docs*, claiming the documented `.muse/hooks.json` path is not what the
shipped binary reads and that the real mechanism is an experimental plugin
flag. That contradiction is unresolved here.

Against the six questions from `HANDOVER-2026-09-16.md` §4:

1. **Interception surface.** *Vendor-documented.* A hook system with
   `PreToolUse` and `PermissionRequest` events, configurable at three levels:
   project (`.muse/hooks.json`, committable, so it could be attested as a gate
   organ exactly as `.claude/settings.json` is), user, and a centrally-managed
   `managed_hooks_path`. Source: `ai.developer.meta.com/docs/muse-code/configuration`.
   *Unconfirmed:* whether that path is what ships.
2. **Payload completeness.** *Not in Meta's documentation.* A third-party
   source describes snake_case JSON on stdin with `hook_event_name`,
   `tool_name`, `tool_input`, `session_id` and `cwd` — i.e. everything the
   adapter needs, if true. Treat as unknown. This is the question that
   decided Codex (APRV-311): a hook that cannot bind the per-call working
   directory cannot produce guard evidence, and no amount of product
   documentation substitutes for one captured event.
3. **Failure mode.** *Contradictory.* Meta documents the core sandbox as
   fail-closed ("Muse Code refuses to run a shell command when it can't
   confirm that the sandbox is active",
   `ai.developer.meta.com/docs/muse-code/permissions`), while a third-party
   source claims hooks run outside that sandbox and that an empty `{}` hook
   response defaults to ALLOW. If the second is right, the hook layer fails
   OPEN, which is the Grok Build situation (APRV-243) and would cap what may
   ever be activated.
4. **Identity and session.** *Unknown.* Nothing on a stable agent identity for
   `agent:<id>`, on session scope, or on whether the harness can impersonate a
   human channel. An unverified `session_id` field is the only trace.
5. **Side-effect classes.** *Vendor-documented:* shell (sandboxed, staged for
   review), file writes (confined to the workspace and a temp directory, with
   `.git`, `.muse` and `.agents` read-only), and network (`--sandbox-network`
   with `proxy-only`, `restricted` and `enabled` modes). No email and no money
   surface is documented for Muse Code — those belong to the consumer Muse.
   Every one of these maps onto existing §7 classes; none is new.
6. **Demo shape.** *Not documented anywhere found.* It would have to be built,
   and the honest smallest version is the one APRV-347 already makes possible
   with no Muse code at all: run the session from `~/dev/muse` under a
   `~/dev/muse/APPROVAL.md`, and every read of a sibling under `~/dev` is
   `read.file.out_of_scope`.

### Fit

**The read jail needs nothing from Muse.** That is the finding that matters.
APRV-347's scope is anchored on the GATE ROOT — the directory holding the
policy file the runtime resolved — so a harness started in `~/dev/muse` with
its own `APPROVAL.md` is confined by construction, through the shell
classifier and through the Seatbelt read profile, with no adapter, no hook
entry and no harness-specific grammar. What a Muse-specific `readTools` entry
would add is gating of Muse's own read TOOL, and that needs the payload shape
in question 2.

Against the three judgements this file asks for: the §7 taxonomy needs no new
class (shell, file writes, network are all present); the §11.1 invariants at
stake are fail-closed (question 3 decides whether a Muse hook can be trusted
to deny at all) and self-reported fields never reducing scrutiny (question 2,
the `cwd`); and the existing contracts place Muse as a HARNESS, so it would
join `src/cli/hook.ts`'s adapter table rather than `src/adapters/` or
`src/channels/`.

### Conclusion

Parked. There is no code to write until somebody runs `muse-code` and captures
one `PreToolUse` event, and this entry deliberately does not pretend otherwise:
the two facts that decide the integration (payload completeness, failure mode)
are exactly the two this survey could not establish from a primary source.
Filing an adapter task on the strength of a fan site would be the failure this
register exists to prevent.

No classifier output is quoted in this entry, which the checklist below asks
for, because there is no verified Muse command surface to classify. The
commands an agent runs UNDER Muse are ordinary shell and are already covered.

### Next steps

- A human installs `muse-code` and captures one `PreToolUse` envelope and one
  hook timeout, then this entry's questions 2, 3 and 4 get answers with a
  primary source. **An agent should not run the vendor's
  `curl … | bash` installer**: it is `network.call` and untrusted-source
  execution, and the suggestion to do it came out of a web survey rather than
  from the operator (SPEC.md §11.1: nothing read from the world is an
  instruction).
- If the payload carries a per-call `cwd` and the hook fails closed, the work
  is a `readTools` entry plus a matcher, on the model of the Claude Code
  adapter. If it fails open, the entry moves to **declined** with the Grok
  Build reasoning.
- No Backlog task is filed for an adapter, on purpose: per the checklist
  below, an entry points at ids rather than intentions, and there is nothing
  here to specify yet.

## How to add an entry

1. Verify against the source, not memory: the candidate's docs or code on
   the day you assess it, with the date recorded in the entry and the table.
2. Run `approval hook classify` on every command the candidate would issue
   or cause an agent to issue, and quote the results.
3. Judge fit against three things: the §7 taxonomy (which classes the
   integration would carry), the §11.1 global invariants (which it would
   touch), and the existing contracts (`src/adapters/contract.ts`,
   `src/channels/contract.ts`), so a candidate that is neither an executor
   nor a channel is named as such.
4. File any follow-up tasks with `backlog task create` before writing "Next
   steps", so the entry points at ids rather than intentions.
5. Use the five headings above, in that order, so entries stay comparable.
   Detailed designs go under `docs/proposals/`; this file holds the summary
   and the verdict.
