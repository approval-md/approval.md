---
id: APRV-241
title: >-
  Integrations register: commerce agents blueprint (anthropics/commerce-agents)
  declined; Agent SDK hook recipe filed
status: Done
assignee:
  - '@claude'
created_date: '2026-09-02 20:54'
updated_date: '2026-09-02 21:48'
labels:
  - docs
dependencies: []
references:
  - 'https://claude.com/blog/claude-for-commerce-agents'
  - 'https://github.com/anthropics/commerce-agents'
  - docs/integrations-considered.md
priority: medium
ordinal: 192000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Carter asked on 2026-09-02 whether approval.md should ship a pre-launch adapter for "Claude for commerce agents" (claude.com/blog/claude-for-commerce-agents, repo github.com/anthropics/commerce-agents). Verified against the repo that day: a Python reference blueprint (Agent SDK, Messages API, Managed Agents runtimes), single commit, Apache-2.0, self-described "reference implementation; it is not maintained and does not accept contributions". The shopping agent never transacts (checkout_handoff returns a hosted URL; payment is the retailer). The merchant agent stages every write (ChangeLedger in merchant-agent/core/merchant_agent/changes.py) and apply_change succeeds only for ids the host marked approved through three methods on an in-memory per-session MerchantToolset: pending_host_approvals(), host_approve(change_id), host_clear(change_id). The host surface is a README comment (`if operator_approved(change):`), require_host_approval is a config flag, --no-host-approval turns it off, and the apply runs in-process through MerchantBackend with whatever credentials the host holds. The Agent SDK runtime uses permission_mode="dontAsk" with an allow-list and one post-tool-batch hook, no PreToolUse. Verdict: declined. Nothing to integrate with (a code pattern in an unmaintained repo that forks per customer), the gate could not hold custody (a host_approve mark is advisory; recording a financial.spend grant for a change we cannot stop is a self-reported field, SPEC §11.1), the shopping side has nothing to gate, and the audience (Shopify, Priceline, Accenture-scale integrators with their own portals) is not the local-first launch audience. Two general things surfaced: Agent SDK hosts are ungated (filed as a follow-up), and `pip install` is unclassified where `npm install -g` is deps.add (folded into APRV-228). This task writes the register entry per the "How to add an entry" section of docs/integrations-considered.md.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 docs/integrations-considered.md summary table has a row for the commerce agents blueprint: link, assessed 2026-09-02, kind blueprint, verdict declined, pointer to the follow-up task ids
- [x] #2 The entry uses the five fixed headings in order (What it is, What it exposes, Fit, Conclusion, Next steps) and quotes the verified `approval hook classify` results for the commands the blueprint would issue
- [x] #3 Next steps name the Agent SDK hook recipe task id and APRV-228 (pip install scope), both filed before the entry is written
- [x] #4 The docs guard (npm run check:changed) passes
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Verify the candidate against github.com/anthropics/commerce-agents on 2026-09-02 (done in the assessment: README, docs/safety.md, docs/backends.md, merchant-agent/runtime-agent-sdk README and main.py, merchant_agent_sdk/agent.py, core/merchant_agent/changes.py).
2. Run approval hook classify on the five commands the blueprint would issue and quote the results.
3. File the follow-ups first: APRV-242 (Agent SDK hook recipe) created; APRV-228 extended with a pip/pipx/uv acceptance criterion.
4. Add the summary-table row and a five-heading entry after the UCA entry in docs/integrations-considered.md, matching its structure.
5. npm run check:changed; commit, push, open PR, arm merge with gh pr merge --merge.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Verification: npm run check:changed ran the full tier (backlog/** in the diff), 27.8 minutes on a loaded machine; two daemon TTL tests timed out (daemon.test "sweep: a live daemon expires a lapsed request exactly once", up.test "the daemon expires a lapsed request and the channel annotates it"). Both pass in isolation (daemon.test 31/31, the up.test case 1/1), CI on main is green for the identical source (run 33681247202 for PR #243), and this diff touches no source, so recorded as load flakes rather than regressions. Directly: docs-guard 9/9, milestones-guard plus backlog-fixtures 11/11, lint clean, typecheck clean.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added the commerce agents blueprint to docs/integrations-considered.md as declined (assessed 2026-09-02, five headings, verified classifier table, summary-table row), filed APRV-242 (Agent SDK hook recipe) and extended APRV-228 with a pip/pipx/uv acceptance criterion. Verified with the docs guard (9/9), the records-tier guards (11/11), lint and typecheck; the full tier had two daemon TTL timeouts that pass in isolation and on CI main.
<!-- SECTION:FINAL_SUMMARY:END -->
