---
id: APRV-320
title: Verified zzz.bot integration and operator onboarding
status: In Progress
assignee:
  - '@codex-sol'
created_date: '2026-09-08 22:43'
updated_date: '2026-09-08 22:53'
labels: []
dependencies: []
priority: high
type: feature
ordinal: 237000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Carter requested first-class zzz.bot compatibility. Establish the exact product and supported public integration contract, implement a usable gate connection where the product exposes a supported boundary, and document the actual enforcement scope and live prerequisites without inventing hook or credential-custody guarantees.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The exact zzz.bot product, official integration contract and supported version are established from primary sources.
- [ ] #2 A usable tested integration and copyable onboarding are delivered for the supported surface, with stable identity and exact payload binding through the existing gate.
- [ ] #3 Harmless isolated verification covers request rejection and once-approved execution; product/account-dependent live gaps remain explicitly pending if inaccessible.
- [ ] #4 The documentation and website name only verified compatibility and distinguish voluntary MCP use from mechanically enforced interception.
- [ ] #5 Changes pass applicable tests and review and are delivered through GitHub with Codex co-author attribution.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Implement a credential-custody ZZZ adapter for exact create_thread/create_reply HTTP payloads using official v0.1.0 routes, fixed production/preview origins, strict bounded validation and deterministic action/payload-bound provider idempotency keys. 2. Obtain zzz.agent_token only through the existing vault credential window; no credential reads or live sends during implementation. 3. Integrate CLI registry/setup/help/MCP publication without changing the shared execution contract; read-only setup probe claims credential acceptance only. 4. Test actual local HTTP transport for exact bytes, token/replay refusals, 200/201 outcomes, definite 4xx failure, and indeterminate transport/redirect/5xx/malformed-success responses with secret redaction. 5. Document invitation/write scope plus private room membership and existing workflow-evidence enrollment, without claiming independently proven human approval. 6. Parent reviews security, runs focused/full checks, merges code/docs, then site describes only verified coverage. New adapter live send remains unverified without an explicitly authorized ceremony.
<!-- SECTION:PLAN:END -->
