---
id: APRV-415
title: >-
  Hermes adapter on observed facts: refuse unbound shell and relative paths,
  state the fail-open finding, probe the modify directive
status: To Do
assignee: []
created_date: '2026-09-20 21:13'
updated_date: '2026-09-20 21:45'
labels:
  - hermes
  - hook
  - harness
dependencies: []
priority: high
ordinal: 321000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The live probe of APRV-398 ran on 2026-09-21 (report in APRV-398 notes; captures in /Users/carter/dev/hermes/probe/envelopes.jsonl, 38 envelopes). Three findings change the adapter. (1) fail_closed: true did NOT block on crash, hang or garbage: all three writes happened. The source (agent/shell_hooks.py) says timeout and non-JSON stdout should block under the key, so either the installed build differs or the key was not loaded; Carter's hermes --version, hermes hooks list and the config grep decide which, and the doc must state the observed result either way. (2) The envelope cwd is the Hermes PROCESS directory (Path.cwd() in _payload_fields), while the terminal tool keeps a per-session recorded cwd that a cd moves, and all four file tools resolve RELATIVE paths against that recorded cwd (_resolve_path_for_task). The model passed no workdir on the shell call in the probe. So a terminal command without an absolute workdir, and a write_file, patch, read_file or search_files with a relative path, run against a directory the verdict cannot see: the APRV-310 shape across every tool. Fail-closed answer: refuse terminal without an absolute workdir and refuse relative paths on the file and read tools with hook-unsupported-execution-context and a reason that tells the model to retry with absolute paths, so a session stays usable. (3) Dialects confirmed: every single deny form blocks, deny-mixed blocks (Hermes tolerates supersets, unlike Muse), {} and empty stdout allow, and an invented action allow also allows (falls through). execute_code was refused before it ran, as designed. Also: Hermes documents a modify directive (action modify with args) that a shell hook may return; if honoured it would let the adapter PIN workdir to the classified directory the way the Codex adapter pins the command through updatedInput. Add a probe trial for it before relying on it. The probe banner says HERMES_HOME is redirected to scratch when --home is given; fix the wording. Related: APRV-398, APRV-310, APRV-350.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 terminal calls without an absolute workdir, and write_file, patch, read_file and search_files calls with a relative path, are refused with hook-unsupported-execution-context and a reason naming the retry, pinned by tests and conformance vectors; absolute forms keep the existing path
- [ ] #2 docs/hermes-hook.md opens with the observed fail-open result (or the confound and its resolution), replaces every UNVERIFIED marker with the observed fact or its correction, and the register entry moves from parked to adopted with caveats; no SPEC row is proposed while the harness fails open
- [ ] #3 the probe gains a modify-workdir trial and a fail_closed-absent pass, and its setup banner describes the --home case correctly
- [ ] #4 APRV-398 AC1 is checked with the report in its notes; build, typecheck, lint, hook, hermes and conformance suites pass
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Probe addenda from 2026-09-21 (see APRV-398 notes): the fail-open results came from Hermes v0.21.3, which does not know fail_closed; re-run on the fresh main clone is pending. Add to this task: a documented version floor for fail_closed and a harness-version doctor pin; the gateway session cwd is the user home, so the docs and help must say --dir is mandatory in gateway deployments; the headless first-use consent case is still unprobed.
<!-- SECTION:NOTES:END -->
