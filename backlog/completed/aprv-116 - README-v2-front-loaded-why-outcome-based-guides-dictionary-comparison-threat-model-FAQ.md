---
id: APRV-116
title: >-
  README v2: front-loaded why, outcome-based guides, dictionary, comparison,
  threat-model FAQ
status: Done
assignee: []
created_date: '2026-08-20 12:52'
updated_date: '2026-08-20 13:39'
labels:
  - docs
  - ux
milestone: m-12
dependencies: []
priority: high
ordinal: 108000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Born from the APRV-89 AC 2 newcomer read (findings on that task). Restructure README.md: hero states the why in the first 30 lines (irreversible and human-attributed actions need an enforced, verifiable human gate; supervised mode samples a percentage) using only SPEC section-11-true claims (identity is config-declared; the strong true claims are credential isolation behind adapters, single-use tokens minted only at human decision, tamper-evident hash-chained log, harness hook closing the go-around path; no blanket cryptographically-enforced claim until APRV-105). Install leads with npm install -g approval-md (publish is its own release.publish task). Ceremonies dissolve into four outcome-titled step-by-step guides with expected output: gate your coding agent (hook + MCP), put approvals on your phone (telegram), define what needs approval (classes, autonomy, budgets, protected paths, amend + attest), hand a grant to a real credential (adapters + vault). New sections: APPROVAL.md dictionary (every key, one line, SPEC pointer each); comparison with alternatives (researched brief: harness permission prompts, framework HITL interrupts, approval platforms); threat-model FAQ (can an agent edit the policy, fabricate the log, mint a token, call the adapter directly, reuse a token, bypass via its own shell) answered with mechanism. Keep checks, exit codes, pointers. docs-guard pins survive or are extended in the same PR.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Hero states the why in the first 30 lines with only SPEC-11-true claims
- [x] #2 Install leads with the npm form
- [x] #3 Four outcome-titled step-by-step guides with expected output
- [x] #4 APPROVAL.md dictionary covers every key in the scaffolded policy and SPEC section 5, each with a SPEC pointer
- [x] #5 Comparison section grounded in the research brief
- [x] #6 Threat-model FAQ answers the bypass questions with mechanism, not assertion
- [x] #7 docs-guard and full suite pass; all transcripts are real output
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Landed as PR 100 (branch aprv-116-readme-v2), merged 2026-08-20 through the merge queue. 646 lines. Opus builder wrote the restructure; fable added the comparison section from a sourced research brief (harness prompts, AGENTS.md prose, framework interrupts, hosted platforms; advantages credited both ways). Builder divergences from the plan, all accepted: the hook COVERS the direct-shell path rather than closes it (docs/claude-code-hook.md limits section); hook grants mint no token and the README says so; the seq 2 incident is seven minutes, the plan's eleven was the misremembered figure; the dictionary grew to the full schema/policy.schema.json vocabulary. docs-guard pins untouched and passing; 1879 tests, lint, typecheck clean. Transcripts regenerated where APRV-113 changed telegram output; the rest reused verbatim after re-verification.
<!-- SECTION:NOTES:END -->
