# Codex project integration

This directory gives a trusted Codex project a direct connection to
approval.md's existing agent-facing MCP server. The connection is voluntary:
it does not intercept Codex's builtin shell or file tools, prove that a declared
action class matches its command, or confine an `approval run` child process.
It does not enable native `PreToolUse` or `PostToolUse` hooks and does not change
Codex approval, sandbox, trust, app, plugin, or remote-control settings.

Before trusting this project in Codex, review `config.toml`,
`approval-mcp.mjs`, and the `codex:mcp` package script. Build the checkout, then
start a new Codex session from this repository:

```sh
npm ci
npm run build
codex
```

Open `/mcp`. The `approval` server should be connected and should list the
agent-facing approval tools. Call `instructions` first. The server always acts
as `agent:codex-mcp`; it never publishes human-only decision, attestation, or
credential tools.

The launcher derives the primary checkout from Git's common directory. The MCP
process and gate run in that primary checkout, against its `APPROVAL.md`, event
log, and payload store. In a linked worktree, pass absolute worktree paths to
tools that must read a task or payload from that worktree. An `approval run`
action remains bound to its declared argv and cwd, so a worktree command should
carry the worktree path explicitly in those reviewed bytes.

The server is optional so an unbuilt or malformed checkout reports an MCP
startup failure without preventing the Codex session from opening. Fix the
reported launcher refusal, run `npm run build`, then reload the MCP server or
start a new session.

This MCP connection is a first-class way for Codex to voluntarily declare,
request, wait for, and execute actions through approval.md. Availability in
`/mcp` proves only that Codex completed the MCP handshake. It does not prove a
gated operation occurred or that other tool paths cannot bypass the server.

Codex CLI 0.152.1 native hooks still omit the effective per-call Bash working
directory, expose no reliable successful versus nonzero outcome, and proceed
after hook crashes, timeouts, or malformed output. Keep the experimental hook
example in `examples/` inert. Mandatory Codex confinement is separate work under
APRV-325; this project MCP setup is not that boundary.
