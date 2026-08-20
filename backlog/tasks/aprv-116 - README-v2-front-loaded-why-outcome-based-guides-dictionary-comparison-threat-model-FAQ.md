---
id: APRV-116
title: >-
  README v2: front-loaded why, outcome-based guides, dictionary, comparison,
  threat-model FAQ
status: To Do
assignee: []
created_date: '2026-08-20 12:52'
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
- [ ] #1 Hero states the why in the first 30 lines with only SPEC-11-true claims
- [ ] #2 Install leads with the npm form
- [ ] #3 Four outcome-titled step-by-step guides with expected output
- [ ] #4 APPROVAL.md dictionary covers every key in the scaffolded policy and SPEC section 5, each with a SPEC pointer
- [ ] #5 Comparison section grounded in the research brief
- [ ] #6 Threat-model FAQ answers the bypass questions with mechanism, not assertion
- [ ] #7 docs-guard and full suite pass; all transcripts are real output
<!-- AC:END -->
