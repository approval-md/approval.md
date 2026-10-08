---
id: APRV-23
title: 'CLI channel: zero-config prompt over the contract'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-05 10:50'
updated_date: '2026-08-05 11:28'
labels: []
milestone: m-5
dependencies:
  - APRV-22
priority: medium
type: feature
ordinal: 23000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC section 10.3 ships cli as the zero-config channel: notify surfaces the pending request in the terminal (tagged fields rendered with computed/claimed visually distinguished; full payload for manual actions), and the decision is collected interactively (grant/reject with note), recorded through the existing human-only gate verbs with resolveHumanActor identity. First consumer of the APRV-22 contract, proving the conformance suite against a real implementation. No new dependencies; plain readline.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 approval channel cli surfaces pending requests and collects grant/reject decisions interactively, recording them through the existing gate verbs with config-declared human identity
- [x] #2 Rendering distinguishes computed from claimed fields visibly and shows the full payload for manual actions, verified via the shared conformance suite
- [x] #3 The APRV-22 conformance suite passes against the cli channel unmodified
- [x] #4 Non-interactive invocation degrades gracefully (documented exit code, no hang), covered by subprocess tests
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented by Opus subagent in isolated worktree; fable review accepted all three flagged additions: (1) the interactive readline loop settles process.exitCode after main() returns (main is synchronous by cli.js contract) — the one exit code that does not travel through main's return, pinned by a test; (2) --payload-dir supplies the payload material the log deliberately does not store (hash-checked by the tagger, wrong file refused, missing material skipped loudly on stderr, never silently dropped) plus --policy alongside --policy-dir; (3) --interactive added because scripted stdin is a pipe not a TTY — without it the decision path would be untestable and unusable from wrappers. Rendering: plain-ASCII first-column [computed]/[claimed] markers with derivation source or author parentheticals, claimed fields indented under a warning heading, full payload in BEGIN/END delimited block with bound hash, truncated renderings carry a do-not-grant line, legend above every delivery. Conformance suite green via the channel's real collectDecision wiring. Verified on merged tree: 746/746, lint, typecheck.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
src/channels/cli.ts + approval channel cli: zero-config readline channel over the contract with ASCII computed/claimed marking, delimited full-payload blocks, conformance-suite-verified rendering and decision round-trip, non-TTY list-and-exit, frozen --json. 18 tests. Verified: 746/746, lint, typecheck.
<!-- SECTION:FINAL_SUMMARY:END -->
