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
