---
id: APRV-429
title: >-
  Hook command payloads bind the command string, not the files it names: the
  APRV-401 rule for the harness path
status: To Do
assignee: []
created_date: '2026-09-22 01:32'
labels:
  - payload
  - gate
  - security
dependencies: []
priority: high
ordinal: 327000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
APRV-401 put the digest of every file an approval run argv names inside the hashed payload, so a grant over a script binds the script's bytes. The harness path still binds a NAME. A Claude Code, Codex, Grok, Muse, Cursor or Hermes tool call is bound as a command STRING by src/cli/hook.ts, and a manual or live-sampled hook request waits on a human's tap; the agent that filed the request controls the files that string names for the whole of that window, which is the same hazard APRV-401 closed for run. What makes it a separate task rather than a line in that one: recognising file operands inside a command string means reading shell text for a purpose the classifier's own OPAQUE_BINS table declines to read it for, and a second reader of that text is a second answer waiting to disagree with the shell's. The narrow shape that is probably right is the one APRV-380 already carved out, a known shell with one inline-script flag and one script word, plus the file operand of a plain argv the bridge already reconstructs. Decide whether the digests ride in the hook's payload, and therefore in its binding, or whether the honest answer is that a command string is bound as text and the hook path gets a documented limit instead. Read docs/run-payload-binding.md first: its rule, its three stated limits and its reasoning about which direction fail-safe runs are the input to this decision.
<!-- SECTION:DESCRIPTION:END -->
