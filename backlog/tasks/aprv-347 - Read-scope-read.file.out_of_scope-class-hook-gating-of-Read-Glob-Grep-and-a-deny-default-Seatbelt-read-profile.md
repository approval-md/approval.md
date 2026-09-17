---
id: APRV-347
title: >-
  Read scope: read.file.out_of_scope class, hook gating of Read/Glob/Grep, and a
  deny-default Seatbelt read profile
status: Done
assignee:
  - '@opus-lane-readscope'
created_date: '2026-09-17 00:18'
updated_date: '2026-09-17 01:19'
labels:
  - hook
  - classifier
  - sandbox
  - spec
  - muse
dependencies: []
priority: high
ordinal: 264000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Carter asked (2026-09-16) whether approval.md can confine an agent working under ~/dev/muse to reading only that directory, with no read access to sibling folders under ~/dev. Today it cannot, at any layer: src/cli/hook.ts answers Read, Glob and Grep allow before classification (only Bash and the write tools are gated); every shell reader (cat, head, tail, sed -n, grep, rg, ls, find) classifies read.shell with no path bound, so no policy rule can see which file was read; schema/policy.schema.json has no scope, roots or workspace key; and the Seatbelt profile in src/core/sandbox.ts is allow-default with a deny-list for egress and credential files. Writes and deletes already have the shape this needs: files.delete.out_of_scope versus files.delete.scratch is decided by ClassifierContext.scratchRoots and refineRm in src/core/command-class.ts, and the hook tightens the answer with a symlink-escape pass (resolveScratchRoots). Build the read-side mirror. The gate root (the directory holding the policy file), the session scratchpad and the system temp root are the default read scope; a policy may widen it with an additive read_scope.roots key. A shell read whose resolved target falls outside every root classifies read.file.out_of_scope with the path bound; a Read, Glob or Grep tool call outside the roots is gated the same way through a readTools table per harness adapter, parallel to fileTools and fileToolGate; an unresolvable path is out of scope (fail closed). For OS custody, EgressAllowance gains allowRead: when set, the Seatbelt profile becomes deny file-read* by default plus allow file-read* subpath for the roots and the fixed runtime set (dyld, /usr/lib, /dev/urandom, the node binary, temp roots); it is off unless the policy asks so ordinary development is unchanged. SPEC 7 gains the class row and SPEC 5 the key; this repo does not change its own APPROVAL.md here (policy.core): the proposal text read.file.out_of_scope: { autonomy: manual } goes to docs/proposals/ for the human to apply. A muse session under ~/dev/muse with its own APPROVAL.md then has ~/dev/muse as its gate root and every sibling read is out of scope with no extra grammar. Related: APRV-193 (same sandbox.ts, lands in the same PR), APRV-267 (files.delete.scratch), APRV-194 (account.credential, the one path-aware read today). Touches SPEC 11 global invariants: fail closed (unresolvable path is out of scope) and enforcement paths read only verified records; the notes must say so.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 approval hook classify on cat, head, tail, sed -n, grep, rg, ls and find with a target outside every read root returns read.file.out_of_scope with the resolved path bound; the same commands inside the gate root, the session scratchpad or the system temp root stay read.shell; a symlink under a root that resolves outside it is out of scope; an unresolvable or relative-escaping target is out of scope
- [x] #2 A Claude Code PreToolUse envelope for Read, Glob or Grep (and the Cursor and Codex equivalents named in the adapter table) with a path outside the roots is classified read.file.out_of_scope and answered by policy; inside the roots it is answered allow with the existing not-a-gated-tool reason preserved for tools that carry no path; conformance vectors cover allow, deny and unparseable input for each harness
- [x] #3 schema/policy.schema.json accepts an optional additive read_scope: { roots: [...] } key; absent means the gate root, the scratchpad and the temp root; an unparseable value fails closed (everything manual, as today); approval policy check and approval policy explain show the effective roots
- [x] #4 EgressAllowance.allowRead switches the Seatbelt profile to deny file-read* default plus allow file-read* subpath for the roots and the documented runtime set; a test proves a sandboxed exec reading inside the root succeeds and reading a sibling gets EPERM, and that npm run build inside a scratch gate root still passes under the profile; without allowRead the profile bytes are unchanged (byte-identical fixture)
- [x] #5 SPEC 7 class table gains read.file.out_of_scope and SPEC 5 documents read_scope; docs/claude-code-hook.md, docs/cursor-hook.md, docs/codex-hook.md and docs/sandboxed-exec.md describe the read gate and the profile; docs/proposals/read-scope-2026-09.md carries the APPROVAL.md line for the human; docs/integrations-considered.md gains a Muse section answering the six harness questions from HANDOVER-2026-09-16 section 4 with sources
- [x] #6 npm run build, typecheck and lint pass; the classifier, hook, sandbox and conformance suites pass; the implementation notes name the SPEC 11 invariants touched
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Pure module src/core/read-scope.ts: the class name, effective roots, the at-or-under test, and the per-binary read-target table.

2. ClassifierContext.readRoots in command-class.ts; absent means today's answer exactly. The pure half decides only what text settles.

3. Hook: a disk second pass that tightens only, as refineScratchDelete does; relative and symlinked targets are resolved there.

4. readTools per adapter through a readToolGate parallel to fileToolGate; a tool with no path keeps the not-a-gated-tool allow.

5. Optional additive read_scope roots in the policy schema and the Policy type; policy check prints the effective roots.

6. EgressAllowance.allowRead flips the Seatbelt profile to deny-default reads; byte-identical when absent.

7. SPEC rows, four hook docs, the APPROVAL.md proposal, and a Muse register entry.

8. Tests: classifier, hook per harness, a real sandbox-exec read jail, conformance vectors; then build, typecheck, lint.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
SHAPE. Two halves, mirroring the delete rule. The PURE half is src/core/read-scope.ts plus a tail branch in classifySegment: it decides only what text settles (an absolute target outside every root, or one whose expansion is not in the text) and leaves relative and dotted targets alone.

The IMPURE half is refineReadScope in src/cli/hook.ts, which resolves each target against the hook's own directory through the nearest existing ancestor, follows symlinks, and only ever tightens read.shell to read.file.out_of_scope.

SPEC 11 INVARIANTS TOUCHED. Fail closed: an unresolvable target, an unreadable value and a symlink escape are each out of scope, and a read command with no operand is checked against the working directory rather than waved through.

Self-reported fields never reduce scrutiny: the scope is anchored on the directory holding the policy the hook RESOLVED, never the harness-supplied cwd; a test drives a Read whose event cwd claims /etc and it does not move the answer.

Enforcement paths read only verified records: unchanged. Nothing here reads the log, and the read gate sits above everything that appends; an in-scope read is answered before the policy loads, before the verified read and before the window lookup.

No new cross-cutting property was born, so SPEC 11.1 and the CLAUDE.md invariant list are untouched; read.file.out_of_scope is an ordinary section 7 class with an ordinary policy line.

DECISIONS WORTH THE DIFF. An EMPTY readRoots list means the same as an absent one (do not scope reads). Scoping against no roots would make every read a decision, and it is the spelling a caller reaches by accident.

No binary was ADDED to the classifier's reader table. less and more are still unclassified; adding them would take them from a deny to read.shell, which is a widening, and a task that narrows reads has no business doing that in passing.

Which words of a read are paths is a per-binary table. A pattern arriving through -e or -f collapses grep/rg/sed/jq to all-positionals, because skipping the first would leave the FILE unchecked. find reads its RAW args so a -name pattern is not mistaken for a path. echo, basename, readlink, test and which are deliberately unscoped: they take a path without opening it.

The Read/Glob/Grep gate is NOT added to the documented PreToolUse matcher. A read is the most frequent tool call a session makes and each match is a Node start; the matcher line is offered with its cost stated. An in-scope read still short-circuits before the policy load, which is sound because read_scope can only widen.

TWO SEATBELT FACTS MEASURED RATHER THAN ASSUMED, each of which shipped a broken profile first. (1) The ROOT DIRECTORY needs file-read*, not metadata: with every other needed directory opened by subpath and / allowed for metadata only, /usr/bin/true dies with SIGABRT before main.

(2) A jailed profile must open the directory the command itself lives in, and its parent: sandbox-exec execs the resolved path, so a node or npm from a version manager under ~ fails execvp with EPERM and exits 71, which reads as the command failing. The parent is what makes a toolchain work rather than merely start (npm resolves to .../node_modules/npm/bin/npm-cli.js). A DEPTH FLOOR of two segments guards it: dirname(/bin) is /, and a root of / would open the whole disk.

A THIRD finding, caught by the orchestrator and fixed at the cause: the first draft compiled the TEMP ROOTS into the profile's runtime set. That was a widening no operator could turn off, and it made the sibling-EPERM test unable to fail. The temp roots now reach the profile from the CALLER (resolveReadRoots), so a caller passing narrower roots gets a narrower jail, and the test demonstrates a real denial with fixtures under temp.

MUSE. The register entry is parked and says in as many words that it is UNVERIFIED. The product is Meta's Muse Code (beta 2026-08-05), and a vendor-documented hook system with PreToolUse exists; the two facts that would decide an adapter, the payload's per-call cwd and the hook's failure mode, came only from third-party sites, one of which disputes Meta's own docs. No adapter task was filed on that basis.

The research suggested running the vendor's curl-pipe-bash installer to settle it. That is network.call plus execution from an untrusted source, it came out of a web survey rather than from the operator, and the entry records it as a HUMAN step rather than an agent one.

The finding that matters for Carter's question: the read jail needs NOTHING from Muse. The scope is anchored on the gate root, so a session run from ~/dev/muse under its own APPROVAL.md is confined by construction, through the shell classifier and through the Seatbelt profile, with no adapter and no harness-specific grammar.

SCOPE NOT TAKEN. The wiring of the jail into approval run and approval sandbox is APRV-193 AC1 and lands in the second commit of this PR; this commit adds the capability (EgressAllowance.allowRead) and its tests. This repository's own APPROVAL.md is untouched: the line goes to docs/proposals/read-scope-2026-09.md for the human.

VERIFICATION (this worktree, macOS 15 arm64, Node 26). npm run build, typecheck and lint clean. node scripts/run-tests.mjs --only cli-hook-read-scope sandbox-read-jail command-class cli-hook cli-hook-cursor cli-hook-codex cli-policy conformance conformance-regen cli-long-help: 677 tests, 677 pass, 0 fail, exit 0.

Wider matrix including sandbox, sandbox-probe, cli-run, cli-doctor and the other hook suites: 794 tests, 793 pass, 0 fail, 1 skip (the opt-in external curl leg of sandbox-probe). node conformance/run.mjs exits 0 with the new hook-read-scope suite at 14 vectors, 3 of them negative controls.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Reads are path-scoped now, the way writes and deletes already were. A new class read.file.out_of_scope is decided in two halves (a pure table in src/core/read-scope.ts plus a disk pass in src/cli/hook.ts that only tightens), gates Read/Glob/Grep through a readToolGate parallel to fileToolGate, takes an additive read_scope.roots key in the policy schema, and has an OS counterpart in a deny-default Seatbelt read profile behind EgressAllowance.allowRead. Verified by 26 new hook cases, 8 new profile and real sandbox-exec cases, a 14-vector conformance suite across three harnesses, and 677 passing tests across the affected suites with a clean build, typecheck and lint. Carter's question is answered: a session run from ~/dev/muse under its own APPROVAL.md is confined to it with no Muse-specific code, and the APPROVAL.md line for this repository waits in docs/proposals/read-scope-2026-09.md.
<!-- SECTION:FINAL_SUMMARY:END -->
