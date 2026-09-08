---
id: APRV-312
title: Codex apply_patch gating and hook configuration protection
status: In Progress
assignee:
  - '@codex-sol'
created_date: '2026-09-08 07:25'
updated_date: '2026-09-08 08:38'
labels: []
dependencies:
  - APRV-311
priority: high
type: feature
ordinal: 230000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
User-authorized Codex patch integration. SPEC 6.3,7,9,10,11.1 bind. Isolated code and fixtures; parent owns protected edits/delivery; no live configuration activation.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 All Add/Update/Delete/Move targets are classified and the full patch plus directory binds approval and rendering.
- [ ] #2 Malformed/ambiguous/traversal/symlink/mixed-protection and changed-payload cases cannot get weaker authority.
- [ ] #3 Codex config.toml, hooks.json and hooks directory classify policy.core with shell/copy/patch tests.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Extend the settled Codex binding/validation to exact apply_patch. Add one strict pure parser for Begin/End, Add/Delete/Update, optional immediate Move-to including pure move, and paired @@ hunks; reject ambiguous repeated operations, malformed framing, NUL/CR and unsafe paths. 2. Resolve every source and destination through existing path/protection scope, including nearest existing ancestors and symlinks; classify all classes and route the full call through the existing verified gate without ordinary-edit passthrough. Bind raw patch plus tool and canonical execution directory; canonical JSON rendering retains every byte. 3. Protect .codex/config.toml, .codex/hooks.json and .codex/hooks/ as gate organs for shell/copy/patch paths. 4. Ensure protected-path evidence never treats tagged patch text as a shell command; conservative naming-only evidence is acceptable for moves until cross-path proof, never invented hunk coverage. 5. Test multi-file mixed classes, add/delete/move, traversal/symlinks/worktrees, malformed input, changed payloads and attempted hook removal; preserve Claude/Cursor suites. APRV-311 public binding is settled; native outcome confirmation continues independently.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented strict Codex apply_patch parser and full raw tool/command/cwd binding; classified every source and move destination using lexical and resolved paths. Protected Codex gate organs and log paths across shell cwd/control flow; closed cd syntax and bounded 64-directory union refuse ambiguity. Patch guard provides naming-only evidence, never shell-time or fabricated hunk coverage. Astra review identified and resolved path ancestor, bare directory, traversal, redirect-only, conditional cd, log cwd, symlink logical cwd and CDPATH cases. Sol parser/classifier/guard 444/444 exit0; prior shared hook regressions565/565 exit0; final Codex12/12 before last narrow CDPATH tightening passed. Typecheck/lint/diff exit0 after that tightening. Central full/CI validation and native evidence still pending; acceptance left unchecked.
<!-- SECTION:NOTES:END -->
