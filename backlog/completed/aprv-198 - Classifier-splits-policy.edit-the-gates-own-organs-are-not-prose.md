---
id: APRV-198
title: 'Classifier splits policy.edit: the gate''s own organs are not prose'
status: Done
assignee:
  - '@agent:opus'
created_date: '2026-09-01 05:14'
updated_date: '2026-09-01 20:43'
labels:
  - gate
  - security
  - design
dependencies:
  - APRV-185
priority: high
ordinal: 165000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
2026-09-01, found while drafting the human-only additions Carter asked for: the classifier emits one class, policy.edit, for every protected touch — SPEC.md and CLAUDE.md prose edits, CI config, APPROVAL.md itself, and .approval/* including the redirect-protected rule that catches writes aimed at .approval/log/events.jsonl. APRV-184 (policy.edit to supervised-live 0.1, Carter-approved in principle) is therefore BLOCKED: sampling at 0.1 would let roughly nine in ten APPROVAL.md edits and log-redirect writes execute unprompted. Attestation makes a silent APPROVAL.md edit fail closed rather than loosen (edited-but-unattested policy refuses everything), and chain verify detects log tampering after the fact, but both are detection or denial-of-service where the Never list promises prevention.

Scope: split the classifier's protected-path output into three classes the policy can rule on separately. (1) policy.edit narrows to the prose-and-config surface: SPEC.md, CLAUDE.md, protected_paths entries, CI/release config. (2) policy.core, new: APPROVAL.md and .approval/* (env, payloads, keys, QUEUE.md — everything under the gate's own directory except the log redirect). (3) log.mutate, new: any write, redirect, append, or truncation aimed at .approval/log/. cp stays direction-blind (copies FROM these paths classify the same class). Update the schema/class taxonomy in SPEC section 7 if it enumerates classes (flag per convention), the hook docs tables, and tests pinning classifier output for representative commands of each of the three. defaults.autonomy manual keeps unsplit strays gated, so the split is additive and fail-closed.

Sequencing: this lands FIRST, then one amend ceremony (Carter's) applies APRV-184's supervised-live 0.1 to the narrowed policy.edit and declares policy.core and log.mutate human-only alongside the other human-only lines (draft in APRV-185 notes, updated by the orchestrator). Related: APRV-194 (account.credential rules, same shape of work — consider one lane for both).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Classifier emits policy.edit only for SPEC.md, CLAUDE.md, protected_paths entries, and CI/release config; representative commands pinned by test
- [x] #2 policy.core emitted for APPROVAL.md and .approval/* touches outside the log; log.mutate for anything aimed at .approval/log/; cp direction-blindness preserved; both pinned by test
- [x] #3 SPEC section 7 taxonomy and hook docs updated, flagged per the amendment convention
- [x] #4 Unsplit or ambiguous protected touches still fail to a gated class, never autonomous; tested
- [x] #5 APRV-184's task notes updated to depend on this task, with the proposed APPROVAL.md block naming all three classes
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read SPEC 5.2/7/11, APPROVAL.md, src/core/command-class.ts, src/cli/hook.ts (fileToolGate and the three protected-path tiers), tests/command-class.test.ts, tests/dogfood.test.ts, docs/claude-code-hook.md. Done before any edit.
2. Replace the boolean core of isProtectedPath with protectedPathClass(candidate, extra) returning 'log.mutate' | 'policy.core' | 'policy.edit' | null. Check order IS the precedence: .approval/log/** first (log.mutate); then anything else under .approval/, APPROVAL.md, APPROVALS.md and the hook-install surfaces .claude/settings*, .cursor/hooks.json, .cursor/hooks/, .cursor/agents/ (policy.core); then CLAUDE.md, AGENTS.md, .npmrc, .github/workflows/ and every policy.protected_paths entry (policy.edit). isProtectedPath stays exported as a boolean wrapper so wysiwys.ts and hook.ts keep working.
3. classifySegment: both overrides (write-redirect target, protected positional in an effectful segment) emit protectedPathClass(...) instead of the literal policy.edit. Rule ids stay redirect-protected and protected-path: the class names the surface, the rule names the mechanism, so the hook's tier rules and wysiwys PROTECTED_RULE_NAMES are untouched. cp stays direction-blind because the override scans every positional.
4. CLASSIFIER_CLASSES gains policy.core and log.mutate. No class enum in the JSON schema (classes are free-form strings); update the protected_paths description prose in schema/policy.schema.json.
5. hook.ts fileToolGate: cls = protectedPathClass(declared, protectedPaths) ?? policy.edit, so an Edit/Write of APPROVAL.md is policy.core and one aimed at .approval/log/events.jsonl is log.mutate instead of a sampled policy.edit. Update the policy.edit-specific prose in hook.ts and doctor.ts.
6. docs/claude-code-hook.md: the overrides section carries the three-class split (the docs guard in tests/cli-hook.test.ts requires every CLASSIFIER_CLASSES member to appear there).
7. Tests in tests/command-class.test.ts: pin representative commands per class (echo redirect, >> append, tee, cp both directions, sed -i, mv, truncate, git checkout -- path) plus the AC4 case that every protected touch lands on a gated class and never on read.* or files.write.workspace.
8. npm test / lint / build. SPEC 7 amendment text goes into these notes verbatim (this lane may not edit SPEC.md); APRV-184 notes get the AC5 append.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Built 2026-09-01 (opus, lane A worktree agent-a553d0bab68d38f2b).

WHAT CHANGED. src/core/command-class.ts grew protectedPathClass(candidate, extra): 'log.mutate' | 'policy.core' | 'policy.edit' | null, and isProtectedPath became a boolean wrapper over it so core/wysiwys.ts's protected-path view and the hook's file-tool gate keep their existing question. Both classifier overrides (a write redirect onto a protected target, a protected positional in an effectful segment) now emit the surface's own class through a new strictestProtected() helper. CLASSIFIER_CLASSES gains policy.core and log.mutate. cli/hook.ts's fileToolGate takes its cls from the same function, so an Edit or Write of APPROVAL.md is policy.core and one aimed at .approval/log/ is log.mutate: editing through the Edit tool must not be a cheaper way to touch the gate than editing through a shell redirect, which it would have been the moment APRV-184 put policy.edit on supervised-live 0.1.

PRECEDENCE, and it is the check order in protectedPathClass rather than a table consulted afterwards. (1) .approval/log/** and .approval/log itself -> log.mutate. (2) APPROVAL.md, APPROVALS.md, everything else under .approval/, and the harness files that install the hook (.claude/settings*, .cursor/hooks.json, .cursor/hooks/, .cursor/agents/) -> policy.core. (3) CLAUDE.md, AGENTS.md, .npmrc, .github/workflows/, and every policy.protected_paths entry -> policy.edit. A segment naming several protected paths takes the strictest of them (mv APPROVAL.md .approval/log/APPROVAL.md is log.mutate), and a policy's own protected_paths can only ever add policy.edit, so a policy cannot demote a built-in surface by naming it.

RULE IDS ARE UNCHANGED on purpose: redirect-protected and protected-path still name the mechanism, and the class now names the surface. The hook's three tiers (protected-path / protected-path-proposal / protected-name-elsewhere) and wysiwys's PROTECTED_RULE_NAMES are keyed on the rule, so keeping the rule stable kept APRV-124/143/161 intact; the tier prose was corrected to say a tier resolves as the path's own protected class rather than 'as policy.edit'.

cp STAYS DIRECTION-BLIND. The override scans every positional, source and destination alike: the classifier cannot tell which argument the binary treats as the destination and guessing would be the ungated direction. cp APPROVAL.md /tmp/policy.md and cp /tmp/policy.md APPROVAL.md are both policy.core, pinned by test.

TWO JUDGMENT CALLS for the orchestrator to overrule if wrong. (a) .claude/settings* and .cursor/hooks.json|hooks/|agents/ are policy.core rather than policy.edit. They are neither prose nor CI config: they are where the hook is installed, and an agent that can write them can write itself out of the gate, which is exactly the policy.core property. Both classes are gated today, so the split is additive either way. (b) src/core/agents-md.ts's prose-to-class import table still maps '.approval/' and 'approval.md' bullets to policy.edit. It is a proposal generator a human reads and edits, and its output is pinned byte-for-byte by tests/fixtures/agents-md; splitting it there is real work with fixture churn. FOLLOW-UP WORTH FILING: under a sampled policy.edit, an AGENTS.md imported through that table would under-gate the approval home, so the import table should learn the split (and a log.mutate row for the 'Mutate events.jsonl' bullet that is UNMAPPED today).

FAIL-CLOSED (AC4). Every protected touch still lands on one of the three gated classes: the split is additive and defaults.autonomy manual covers the two new classes wherever a policy has not declared them. The test 'no protected touch reaches an autonomous class' asserts that over every split fixture plus shapes the table does not name (ln -s onto APPROVAL.md, chmod on the log directory, touch .approval/keys/..., a build redirected into the log), and none may come back files.write.workspace or read.*.

WHAT DID NOT CHANGE. Reads of protected paths are still read.shell (cat APPROVAL.md), which is APRV-194's business and not this task's. No schema enum lists classes, so nothing in schema/ needed a new value; the protected_paths description prose still says policy.edit and should be widened when the SPEC amendment lands (it is documentation, not enforcement). Conformance vectors were NOT regenerated: classifier classes are not one of the frozen refusal unions and no vector's outcome moved.

DOGFOOD. tests/dogfood.test.ts stays green unchanged: policy.edit is still reachable from the classifier (CLAUDE.md, AGENTS.md, .npmrc, .github/workflows/, plus SPEC.md through the live policy's protected_paths), and no read.* class moved.

TEST FIXTURES THAT MOVED, so review knows they are deliberate: tests/cli-hook.test.ts and tests/cli-hook-cursor.test.ts declare policy.core and log.mutate in their fixture policies and expect policy.core where they gate APPROVAL.md, .cursor/hooks.json and the Edit-prompt payload; the SPEC.md-via-protected_paths and design/ cases still expect policy.edit, which is the split working.

SPEC AMENDMENT TEXT (AC3), drafted for the orchestrator to apply verbatim under one grant. This lane may not edit SPEC.md, so the text lives here.

SPEC.md section 7, developer-workstation table. REPLACE the exact line:
| `policy.*` | `.edit` (the policy file, agent instructions, CI and release configuration) | manual, always |
WITH:
| `policy.*` | `.edit` (agent instructions, CI and release configuration, and the paths a policy protects), `.core` (the policy file itself and the gate's own directory, minus its log) | manual, always; a policy MAY declare `.core` human-only |

SPEC.md section 7, same table. INSERT immediately after that row:
| `log.*` | `.sync`, `.advance` (section 10.1), `.mutate` (any write, redirect, append, truncation or rename aimed at the log directory) | manual, always; a policy MAY declare `.mutate` human-only |

SPEC.md section 7. INSERT after the developer-workstation table and before the `files.delete.out_of_scope` paragraph:
The `policy.*` split is by consequence rather than by file type. `policy.edit` is the prose and configuration ABOUT the gate, which a policy may reasonably sample; `policy.core` is the gate's own organs (the policy file, the approval home, and the harness files that install the hook), where sampling would let nine touches in ten through unprompted; `log.mutate` is a write to the record of what happened rather than to the rules. An implementation MUST answer a path by the strictest surface it names, and MUST classify a copy OUT of a protected path exactly as it classifies a copy into it. (Amended APRV-198, pending sign-off.)

SPEC.md section 5.2, protected_paths sentence. No replacement needed for correctness, but if the orchestrator wants the widening rule stated where authors read it, APPEND to the protected_paths bullet: Every path a policy adds is `policy.edit`: a policy widening its own protected surface is naming prose and configuration, and cannot mint authority over the gate's organs, whose classes the runtime fixes. (Amended APRV-198, pending sign-off.)

Section 11.2 refusal-code registry: NO ROWS. This task adds classes, not refusal codes, and no gate refusal changed shape. Section 11.1 global invariants: none added; the task is covered by the existing 'human-only classes are inert to agents' and 'refusals are machine-readable and distinct' lines. The class split is what gives the APRV-185 human-only declaration something to attach to, which is APRV-184's ceremony and not a SPEC change.

NOT SPEC, but owed by the same amendment pass and not editable from this lane: CLAUDE.md's Permissions summary lists 'Edits to APPROVAL.md, .approval/, CLAUDE.md, or CI/release config' as one bullet under 'Require approval first'. Once policy.core and log.mutate are declared, that bullet should split too, or the AGENTS.md-shaped summary will describe a policy the file no longer has. schema/policy.schema.json's protected_paths description also still says entries are classified policy.edit, which is now the whole truth only for the entries a policy adds (accurate as written, but worth widening to mention the three built-in surfaces).

VERIFICATION (2026-09-01, worktree agent-a553d0bab68d38f2b).

npm run lint: clean (oxlint src tests, no findings). npm run build: clean. npm test: full suite run to completion; the only failures were three TTL/poll timing races that touch nothing in this change (cli-hook 'a grant that lapsed its TTL carries nothing', cli-setup 'a message sent AFTER the first poll came back empty is still found', daemon 'sweep: a live daemon expires a lapsed request exactly once'). All three pass on re-run: node --test on those three files together gave 173 tests, 172 pass, with one DIFFERENT 20s-wait test failing ('a rejected request denies with hook-rejected'), and that one plus 'a manual command is allowed when a grant lands mid-wait' both pass in isolation (2/2). The flake is the known load race on the 1000-2000ms TTL and 20s wait tests, and it moves between tests run to run; none of them classifies a protected path (the two hook ones gate deps.add).

Per-suite evidence for the acceptance criteria:
- tests/command-class.test.ts 255 tests, 255 pass. AC1: the policy.edit rows of SPLIT_FIXTURES (echo x >> CLAUDE.md, sed -i CLAUDE.md, tee AGENTS.md, mv notes.md AGENTS.md, cp AGENTS.md /tmp, truncate -s 0 .npmrc, git checkout -- .github/workflows/ci.yml, mv ci.yml .github/workflows/ci.yml) plus the existing 'classifyCommand routes the policy's paths to policy.edit' for protected_paths entries (SPEC.md, design/). AC2: the policy.core and log.mutate rows, including cp APPROVAL.md /tmp/policy.md AND cp /tmp/policy.md APPROVAL.md for direction-blindness, cp .approval/log/events.jsonl /tmp/ for the log, and 'the strictest surface answers a command naming more than one'; protectedPathClass is unit-tested per surface. AC4: 'no protected touch reaches an autonomous class (APRV-198 AC4)' asserts every split fixture and seven unfixtured shapes land on one of the three gated classes.
- tests/cli-hook.test.ts 65/65 and tests/cli-hook-cursor.test.ts 7/7, which include the two docs guards ('docs/claude-code-hook.md still lists every rule and every deny code', and the cursor equivalent): both require every CLASSIFIER_CLASSES member to appear in the doc, so policy.core and log.mutate being documented is mechanically enforced. These suites also pin the file-tool path: an Edit/Write of APPROVAL.md now logs class policy.core, and the carried-grant action key is hook:sess-1:tu-edit-1:policy.core.
- tests/dogfood.test.ts passes unchanged: every literal class in the live APPROVAL.md is still reachable from the classifier and the classifier's read.* classes are still covered by the policy's read.* rule.

AC3 is met on the docs half in the tree (docs/claude-code-hook.md and docs/cursor-hook.md carry the three-class table, the precedence sentence and the cp direction-blindness note) and on the SPEC half as drafted text above, flagged '(Amended APRV-198, pending sign-off.)' per the convention: this lane may not edit SPEC.md, so the orchestrator applies it verbatim under one grant. AC5 is met by the note appended to APRV-184.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The classifier's single protected class is now three: log.mutate for anything aimed at .approval/log/, policy.core for APPROVAL.md and the rest of the gate's own directory plus the harness files that install the hook, policy.edit for the prose and configuration about the gate (CLAUDE.md, AGENTS.md, .npmrc, CI workflows, and the policy's own protected_paths entries). One function, protectedPathClass, is the whole split: its check order is the precedence, isProtectedPath is now a boolean wrapper over it, and both the shell overrides and the hook's file-tool gate read it, so an Edit of APPROVAL.md is policy.core exactly as a redirect onto it is. Rule ids are unchanged, so the three protected-path tiers and the channel's protected-path view are untouched. cp stays direction-blind. Verified: command-class 255/255 with 30 new pinned commands, a strictest-surface test and a fail-closed test that no protected touch reaches an autonomous class; cli-hook 65/65 and cli-hook-cursor 7/7 including both docs guards; dogfood unchanged; lint and build clean; full suite green apart from three known TTL/wait load flakes that pass on re-run. SPEC section 7 text is drafted in the notes, flagged pending sign-off, for the orchestrator to apply.
<!-- SECTION:FINAL_SUMMARY:END -->
