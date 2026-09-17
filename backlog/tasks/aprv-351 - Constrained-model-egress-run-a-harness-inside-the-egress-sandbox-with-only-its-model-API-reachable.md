---
id: APRV-351
title: >-
  Constrained model egress: run a harness inside the egress sandbox with only
  its model API reachable
status: To Do
assignee: []
created_date: '2026-09-17 02:22'
labels:
  - sandbox
  - design
  - egress
dependencies: []
priority: medium
ordinal: 268000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Split from APRV-193 AC1 on 2026-09-17 with Carter. APRV-193 now proves per-command containment: allowed-class commands run under the Seatbelt egress profile through approval run and the hook exec path, laundered code cannot send mail or POST, and cannot read vault or env material (APRV-193 AC2/AC3, PR #411). What it does not do is put the harness itself in the room: approval sandbox -- claude is a session that cannot think, because a harness needs its model API and the profile denies all egress. The 2026-09-09 review reopened AC1 for exactly this. Design and prove a constrained posture where the harness process reaches only its model provider (Anthropic, OpenAI, Meta, xAI endpoints as configured) and the loopback gate daemon, and nothing else, while every command it spawns inherits the full egress-deny profile. Candidates to evaluate with evidence: a Seatbelt profile with a host allow-list (Seatbelt cannot filter by hostname, so this likely means a local forwarding proxy the profile permits and the harness is pointed at); a per-harness proxy that pins provider hosts and strips ambient credentials; and the harness's own sandbox settings where they exist (Claude Code sandbox, Codex read-only mode). State plainly which harnesses can be confined this way and which cannot, and what an operator gives up (streaming, MCP over HTTP, plugin fetches). Output: a design under design/ (policy.edit.design), a probe under scripts/probes/, and either an approval sandbox --harness <name> mode or a declined recommendation with the failing evidence. APPROVAL_HOOK_REQUIRE_SANDBOX remains default off until this lands. Related: APRV-193, APRV-347, APRV-325.3.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A design document under design/ names the egress the harness needs (provider hosts, ports, protocols), the mechanism that admits only that egress, how ambient credentials are kept out of the harness environment, and what is lost; each claim about Seatbelt or the harness is backed by a probe result
- [ ] #2 A probe shows a harness session under the constrained posture completing one model round-trip while a command it spawns is denied outbound network and a direct connection from the harness to a non-provider host is denied
- [ ] #3 Either approval sandbox gains a documented harness mode with tests, or the task closes with a declined recommendation and the evidence; docs/sandboxed-exec.md describes the outcome either way
- [ ] #4 No credential is read or embedded; every probe runs in scratch directories through commands the classifier reads or approval run
<!-- AC:END -->
