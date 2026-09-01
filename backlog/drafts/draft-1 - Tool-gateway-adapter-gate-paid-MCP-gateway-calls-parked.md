---
id: DRAFT-1
title: 'Tool-gateway adapter: gate paid MCP gateway calls (parked)'
status: Draft
assignee: []
created_date: '2026-09-01 05:01'
labels:
  - adapter
  - parked
dependencies: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Provider-neutral adapter gating paid tool-gateway MCP calls (prepaid USD wallet, per-call billing; AnyAPI and Monid as first configs) behind the approval.md gate, on our side of the wallet.

PARKED 2026-08-31 by Carter on customer feedback (Kevin): spend is already capped platform-side and usage metrics exist, so neither spend gating nor the audit trail is a felt need today. The data-governance case (per-agent/session attribution, purpose strings on PII SKUs, fan-out caps, fetch/persist separation) is untested rather than refuted; activate when that demand appears.

Reference: docs/proposals/tool-gateway-adapter.md holds the full verified design (provider facts, rule set, the proposed product-neutral execution.metered event, ten-task activation decomposition).

On activation: split into the ten tasks listed in the proposal, SPEC section 8 amendment task first (human sign-off required), and re-verify the design against both providers live docs before any code, since parked facts go stale.
<!-- SECTION:DESCRIPTION:END -->
