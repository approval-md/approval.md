---
id: APRV-177
title: Demo agent child must not inherit the operator's personal Claude config
status: Done
assignee:
  - 'agent:opus-lane-j'
created_date: '2026-08-31 01:53'
updated_date: '2026-09-02 03:28'
labels:
  - demo
dependencies: []
ordinal: 156000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed during 2026-08-31 rehearsal (transcript demo-260831014516-002.jsonl): the claude -p child spawned by examples/web-agent-demo/server.mjs loaded the operator's full user-level configuration because HOME passes through the env filter — personal plugins (vercel, frontend-design), connected MCP servers (airtable, perplexity), user memory paths, and slash commands all appeared in the demo agent's session init. --allowedTools mcp__approval__* prevents silent use, but attendee-driven prompts should run in a session wired to nothing personal. Fix direction: spawn with CLAUDE_CONFIG_DIR pointed at a demo-owned config directory under the demo instance (so only the generated approval MCP config exists), and document the auth handoff for that isolated config dir (CLAUDE_CODE_OAUTH_TOKEN via claude setup-token passes the CLAUDE_* filter and needs no keychain). Also observed and fixed operationally the same night: keychain-based login does not reach the scrubbed child at all — 'Not logged in' authentication_failed — so setup-token is the documented path regardless; add it to the runbook preflight.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Agent child session init shows no operator plugins, no personal MCP servers, and no user memory paths (verified from the stream-json init line)
- [x] #2 Runbook preflight documents claude setup-token + CLAUDE_CODE_OAUTH_TOKEN as the auth path for the demo server shell
- [x] #3 read_the_gate template runs green under the isolated config
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. server.mjs: derive a demo-owned child config root under the demo instance — AGENT_HOME = <demo dir>/agent-home, AGENT_CONFIG_DIR = <agent home>/claude-config (CLAUDE_CONFIG_DIR), AGENT_SETTINGS_PATH = <config dir>/settings.json, AGENT_MEMORY_PATH = <config dir>/CLAUDE.md. Write all three fresh at startup beside tasks/mcp-config.json (no CLAUDE.md is shipped in the repo under examples/, so no policy.edit-classified write is involved).
2. agentEnv(): stop passing the operator's HOME. Set HOME=AGENT_HOME, CLAUDE_CONFIG_DIR=AGENT_CONFIG_DIR, XDG_CONFIG_HOME/XDG_CACHE_HOME/XDG_DATA_HOME under AGENT_HOME, keep PATH and NO_COLOR, drop SHELL. Replace the ANTHROPIC_*/CLAUDE_* prefix passthrough with an explicit allowlist of exactly the credentials the demo needs: CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, ANTHROPIC_MODEL. Everything else (including an operator CLAUDE_CONFIG_DIR) is dropped.
3. agentArgv(): add --strict-mcp-config (so only the generated approval server is loaded, never a user or project .mcp.json) and --settings <AGENT_SETTINGS_PATH>.
4. Startup banner (stdout, not stderr — the e2e asserts stderr empty) names the isolated config dir and says plainly when no credential passed the allowlist, so the auth failure is a preflight line rather than a stage surprise.
5. New tests/e2e-web-agent-demo-isolation.test.ts: build a scratch OPERATOR home holding .claude/settings.json with a hook, .claude/CLAUDE.md memory, .claude.json with personal MCP servers, and a plugins dir; spawn the real server.mjs with that HOME and a probe CLAUDE_BIN that records its own argv/env/config-visibility to JSON and drives the read verbs for read_the_gate. Assert: child HOME and CLAUDE_CONFIG_DIR are demo-owned; the operator hook file, memory file and MCP server file are not visible from the child's HOME/CLAUDE_CONFIG_DIR; the argv carries --strict-mcp-config, --settings and --mcp-config; a personal CLAUDE_CONFIG_DIR/ANTHROPIC_* extra does not reach the child while CLAUDE_CODE_OAUTH_TOKEN does; the demo config dir holds only the demo's own settings and memory.
6. Same test covers AC3: submit read_the_gate, the probe calls status/queue/log tail through the CLI under the isolated config, task ends state=done exit 0 and the log gains no records.
7. Runbook: new preflight step for claude setup-token + export CLAUDE_CODE_OAUTH_TOKEN (keychain login does not reach the scrubbed child), plus a note in the reset and hard-warnings sections that agent-home/ goes with the instance.
8. lint, build, full npm test, notes, ACs, Done.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What changed

**examples/web-agent-demo/server.mjs** — the agent child now runs in a configuration the demo owns.

- New `AGENT_HOME` = `<demo dir>/agent-home`, `AGENT_CONFIG_DIR` = `<agent home>/claude-config`, written fresh at every startup alongside `tasks/mcp-config.json`: a `settings.json` with `hooks: {}`, `enabledPlugins: {}`, `enableAllProjectMcpServers: false`, and a `CLAUDE.md` restating the system contract rather than adding to it.
- `agentEnv()` no longer passes the operator's `HOME`. It sets `HOME`, `CLAUDE_CONFIG_DIR` and the three `XDG_*` under the demo home, and the `ANTHROPIC_*`/`CLAUDE_*` prefix passthrough is replaced by a closed allowlist: `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`. The prefix rule was the actual bug's second half: it forwarded the operator's own `CLAUDE_CONFIG_DIR`, which would have handed back the configuration `HOME` isolation removes. `SHELL` is dropped (the child has no Bash).
- `agentArgv()` gained `--strict-mcp-config` (the generated approval server is the only one that can be on the list, not merely the first) and `--settings <AGENT_SETTINGS_PATH>` (the demo's settings named rather than discovered).
- The startup banner gained an `agent home:` line, an `agent auth:` line naming the credential that crossed (or saying in as many words that none did and the child will fail to authenticate), and a `memory above:` line when an ancestor directory of the instance holds a `CLAUDE.md`.

## Decisions

1. **No CLAUDE.md is shipped under `examples/`.** The child's memory file is generated at runtime into the instance, like `mcp-config.json`, so there is no repo file whose write would need a `policy.edit` classification, and no second document that can drift from `SYSTEM_CONTRACT`.
2. **Ancestor project memory is reported, not silently missed.** A `CLAUDE.md` above the instance is found by walking up from the child's cwd, and no `HOME` or `CLAUDE_CONFIG_DIR` hides it. The cwd has to stay the instance (the CLI resolves the log against it), so the honest answer is a named warning at startup and a runbook line, not a claim of isolation the code cannot make.
3. **`XDG_*` are pinned rather than left unset.** With `HOME` redirected they would already fall back inside the demo home; pinning says so instead of relying on it.
4. **The gate is unchanged.** `--allowedTools mcp__approval__*`, `--disallowedTools`, the `--as agent:demo` pinning, the no-`grant`-tool wrapper and the seeded envelopes are all untouched; `--strict-mcp-config` narrows the child further, never wider.

## Verification

New `tests/e2e-web-agent-demo-isolation.test.ts`. It builds a scratch operator `HOME` holding a `PreToolUse` hook that would run a shell command, a user `CLAUDE.md`, two connected MCP servers (airtable, perplexity), two plugins (vercel, frontend-design) and a slash command, then spawns the real `server.mjs` with that `HOME`, that `CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_OAUTH_TOKEN` set. The `CLAUDE_BIN` probe is not a stub that echoes a fixture: it performs the discovery a real client performs, from the environment and argv it was actually handed (config dir, settings layering, memory in the config dir / `$HOME/.claude` / walking up from cwd, MCP servers from `--mcp-config` merged with the user and project scopes unless `--strict-mcp-config` forbids it, plugins and commands on disk), emits it as the stream-json init line, and records it. Asserted: init hooks/plugins/slash_commands empty, `mcp_servers` exactly `[approval]`, `memory_paths` exactly the demo's own file and every path inside the instance, and no operator path or name anywhere in the init line; `HOME`/`CLAUDE_CONFIG_DIR`/`XDG_*` demo-owned; argv carries `--strict-mcp-config`, `--settings`, `--mcp-config`, `--allowedTools`; the child's environment is exactly the eight names the server declares (macOS's own `__CF_*` filtered), so the operator's `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` and `ANTHROPIC_CUSTOM_HEADERS` are all absent while the OAuth token crossed. A second small test guards the fixture's premise (the operator home is not an ancestor of the instance).

AC3 in the same walk: the run is `read_the_gate`, the probe drives `status`, `queue` and `log tail` through the real CLI under the isolated config, the task ends `done` with exit 0 and three gate tool_uses, and the log still holds only `policy.updated` — reads write nothing.

**Runbook** (`examples/web-agent-demo/runbook.md`): new preflight step 5 (`claude setup-token` + `export CLAUDE_CODE_OAUTH_TOKEN`, with the 2026-08-31 `Not logged in` observation and why a keychain login cannot reach the child); old steps 5/6 renumbered 6/7; the banner paragraph now mentions the agent home, credential and `memory above:` line; a failure-playbook entry for an unauthenticated child; a hard warning against 'fixing' auth by handing the child your `HOME`; and the reset section now covers `agent-home/`.

## Checks

`npm run lint` clean, `tsc -p tsconfig.json` clean, full `npm test`: 2638 tests, 2637 pass, 1 fail — `ci-guard.test.js` 'every production dependency's engines.node admits the Node floor', ENOENT on `node_modules/@modelcontextprotocol/sdk/package.json`, the known agent-worktree failure (no `node_modules` in the worktree) and unrelated to this change.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The web-agent demo's `claude -p` child no longer inherits the operator's laptop. server.mjs generates a demo-owned HOME and CLAUDE_CONFIG_DIR under the instance (settings with no hooks and no plugins, its own CLAUDE.md), spawns with --strict-mcp-config and --settings so the approval wrapper is the only MCP server on the list, and forwards a closed allowlist of five credential names (CLAUDE_CODE_OAUTH_TOKEN first) instead of the old ANTHROPIC_*/CLAUDE_* prefix rule, which had been forwarding the operator's own CLAUDE_CONFIG_DIR. The startup banner names the agent home, the credential that crossed, and any CLAUDE.md above the instance, which is the one leak a redirected HOME cannot close. Verified by tests/e2e-web-agent-demo-isolation.test.ts, which spawns the real server with a scratch operator HOME carrying a PreToolUse hook, user memory, two connected MCP servers, two plugins and a slash command, and asserts from a discovery-performing stream-json init line that none of them are visible in the child, that its environment is exactly the eight names the server declares, and that read_the_gate runs green (exit 0, three read verbs, log unchanged) under the isolated config. Runbook gained a setup-token preflight step, a renumbering, an auth failure entry and a hard warning. lint and typecheck clean; full npm test 2637/2638, the one failure being the known ci-guard engines check that needs node_modules the agent worktree does not have.
<!-- SECTION:FINAL_SUMMARY:END -->
