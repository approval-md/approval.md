---
id: APRV-246
title: >-
  Grok Bot connector demo: examples/grok-bot-connector/runbook.md, the voluntary
  gate with witnesses
status: In Progress
assignee:
  - '@claude'
created_date: '2026-09-02 21:37'
updated_date: '2026-09-05 02:03'
labels: []
dependencies:
  - APRV-245
references:
  - examples/web-agent-demo/runbook.md
  - docs/integrations-considered.md
  - 'https://x.ai/news/grok-bot-and-x'
priority: high
ordinal: 195000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Grok Bot (xAI's agent product) lets a user add an MCP server as a custom connector (name, server URL, one header). The repo already serves that shape: `approval mcp serve --http --guest` behind a tunnel (APRV-174, guest actors per session, APRV-175 wait clamp). This runbook, in the shape of examples/web-agent-demo/runbook.md, rehearses a Grok Bot agent using the gate through the connector, then skipping it, with `approval coverage` (APRV-245) as the witness for repository effects and credential custody (the AgentMail two-key model, APRV-222) as the wall for sends. Three tiers stated plainly: prevented by custody, witnessed by a log we do not write, not covered (credentials pasted into Grok Bot itself). Audience: Carter on demo day, and a warm lead who uses Grok Bot and should be able to follow it cold. The header Grok Bot sends is not checked by our server (it authenticates nobody by design); the runbook says so and leans on guest mode and the session caps.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 examples/grok-bot-connector/runbook.md exists with the web-agent runbook sections: preflight, the opening beat (the gated tunnel, reused), rehearsal beats, failure playbook, reset between runs, hard warnings, TBDs
- [x] #2 Beats: connect (serve --http --guest behind the tunnel, add the connector in Grok Bot); use the gate (push a branch and send the finale email via request, wait, run; the phone decides; the agent never sees the key); skip the gate for the repository (the push lands, `approval coverage` shows the commit with none beside the earlier one with its seq); skip the gate for email (no credential, it cannot; then a hand-sent message with the vault key shows as none under --source agentmail); read the log (log verify, the audience queue)
- [x] #3 The three tiers (prevented by custody, witnessed, not covered) appear once in a table with one sentence each, and the not-covered sentence names credentials pasted into Grok Bot
- [x] #4 Every command in the runbook is one the classifier reads or one the runbook shows routed through approval run, matching the web-agent runbook convention; hard warnings state that the server checks no header and that guest mode and the caps are the protection
- [ ] #5 TBDs list what only a rehearsal settles: the connector transport, whether Grok Bot holds a long wait, the identity string it presents, whether its cloud computer reaches a quick tunnel; the rehearsal result is recorded in this task's notes by a human
- [x] #6 README Where to look next links the runbook; the docs guard passes
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read the sources: examples/web-agent-demo/runbook.md and provisioning.md (section shape), docs/integrations-considered.md (Grok Bot entry, three tiers), src/mcp/http.ts, src/cli/mcp.ts, src/mcp/server.ts (GUEST_VERBS, GUEST_WAIT_TIMEOUT_MS, caps, no authentication), examples/agentmail-demo.md (two-key model), docs/cli-reference.md (mcp serve --http/--guest, register, request, wait, run, adapter agentmail). Done.
2. Settle the facts the runbook rests on. GUEST_VERBS is a positive allowlist of nine: instructions, register, request, wait, status, queue, log verify, policy check, policy test. There is NO run, NO adapter and NO token tool for a guest, so the connected agent declares, asks and observes, and execution stays at the operator terminal in the demo instance. wait is clamped to 5s server-side. Caps are 20 concurrent and 200 lifetime sessions. Default --http port is 4681, loopback. The server reads no header and authenticates nobody.
3. Write examples/grok-bot-connector/runbook.md in the web-agent runbook shape: instance table, the approval shell function, 1 Preflight, 2 The opening beat (the cloudflared tunnel over 4681, gated against the repo live log), 3 Rehearsal script (five beats: connect, use the gate, skip the gate for the repository, skip the gate for email, read the log), 4 Failure playbook, 5 Reset between runs, 6 Hard warnings, 7 TBDs. The three-tier table appears once, before the beats.
4. Demo topology: the demo gate instance is provisioned per provisioning.md with one substitution, a git clone of a throwaway private repository into the instance directory so that approval coverage has both a working tree and the log in one working directory, with .approval/ added to that repository gitignore so no gate state is ever pushed. The agent holds a repository credential of its own in the xAI cloud (that is what makes the skip beat possible) and holds no AgentMail key at all (that is the custody beat). Only the sending key is in the demo vault.
5. Every command checked with approval hook classify. Verified: approval verbs gate.self, git clone network.call, git commit vcs.commit.branch, git push vcs.push.branch, git fetch read.vcs.remote, curl POST network.call, npm run build and node script files.write.workspace, cloudflared unclassified (denied, so it takes the explicit register/request/wait/run flow, quoted from the web-agent runbook).
6. Coverage output blocks are marked illustrative: APRV-245 is being built concurrently and the runbook is written against its stated interface.
7. Add one paragraph to README Where to look next linking the runbook, then run npm run check:changed and report.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Runbook written from the web-agent template: preflight, the gated tunnel as the opening beat, five rehearsal beats, failure playbook, reset, hard warnings (the server checks no header; guest mode and the caps are the protection; the live gate and ~/demo-gate must not be confused), TBDs. Beat 3 uses vcs.push.branch, which is what the git coverage source now reports for a commit a remote-tracking branch reaches. Coverage output blocks are marked illustrative; confirm columns against approval coverage --help on the morning. README links it from Where to look next. Docs guard passes in the full tier. AC 5 (the rehearsal itself: connector transport, long wait, identity string, tunnel reachability) is Carter's step and keeps the task In Progress.
<!-- SECTION:NOTES:END -->
