---
id: APRV-110
title: >-
  Ambient runtime: one process for daemon and channels, and a login service to
  run it
status: To Do
assignee: []
created_date: '2026-08-20 08:55'
labels:
  - ux
  - daemon
  - channels
milestone: m-12
dependencies: []
priority: medium
ordinal: 102000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Human question 2026-08-20: "will users always need to create a listener and daemon runner?" At v0.1 yes: approval daemon run and approval channel telegram listen are two foreground processes, and dispatch deliberately lives in the listener because it holds the channel credential and the approver identity (SPEC 10.3, amended APRV-55). That placement is explicitly an implementation choice the SPEC permits moving: "a later build MAY move dispatch into the daemon with no change to any event, projection, or channel interface." This task makes the gate ambient in two steps. (1) approval up (or daemon run --with-channels): one supervised foreground process running the daemon loop plus every channel the policy configures (telegram long-poll listener, web queue page), with per-part crash isolation (a channel that dies is restarted with backoff and reported as a DaemonEvent; the daemon loop never dies with it), clean SIGINT/SIGTERM shutdown of all parts, and one --json event stream interleaving the existing DaemonEvent and listener output (additive union only). The token print sites and decision recording keep their exact current behaviour and identity handling; the human identity and channel credentials come from the environment the operator launched the process with (invariant 7, no implicit env loading). (2) approval setup service: writes and loads a launchd plist (macOS) or a systemd user unit (Linux) that runs approval up in the primary checkout at login, environment sourced the way the operator chooses explicitly (the unit file names the variables or an EnvironmentFile the human authors; setup never copies secret VALUES into the unit, only names, keystore references stay in the keystore via approval env evaluated by a wrapper the human reads). setup service is HUMAN-ONLY and interactive like the other setup verbs; it prints the unit for review before writing; uninstall verb or flag included. Logs of the service go to a file under the operator choice, never into .approval/. Fail closed: up refuses to start a channel whose credential is missing rather than starting half-armed silently (it reports and continues with the parts that can run, matching doctor vocabulary). SPEC touch: 10.2/10.3 one-paragraph amendment (dispatch MAY run inside the daemon process; the reference runtime now does), flagged for sign-off; the withdrawn/edit-message flow (APRV-106) and dispatch dedup must keep their listener-restart semantics (a restart re-sends pending, a duplicate never a silence).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval up runs the daemon pass and the configured channels in one foreground process; SIGINT/SIGTERM stops all parts cleanly; a crashing channel restarts with backoff and is reported, and the daemon loop survives it
- [ ] #2 Decision recording, token printing, withdrawn message edits and re-send-on-restart semantics are byte-compatible with the separate processes (tests reuse the existing channel and daemon suites against up)
- [ ] #3 approval setup service writes a launchd plist or systemd user unit for review before installing, names variables and never copies secret values, and can uninstall; human-only, interactive by refusal
- [ ] #4 SPEC 10.2/10.3 amendment drafted and flagged; docs (README harness section, dogfood runbook, mcp-demo prerequisites) updated to one process; npm test and lint clean
<!-- AC:END -->
