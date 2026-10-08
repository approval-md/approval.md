---
id: APRV-320
title: Verified zzz.bot integration and operator onboarding
status: Done
assignee:
  - '@codex-sol'
created_date: '2026-09-08 22:43'
updated_date: '2026-09-09 01:58'
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
- [x] #1 The exact zzz.bot product, official integration contract and supported version are established from primary sources.
- [x] #2 A usable tested integration and copyable onboarding are delivered for the supported surface, with stable identity and exact payload binding through the existing gate.
- [x] #3 Harmless isolated verification covers request rejection and once-approved execution; product/account-dependent live gaps remain explicitly pending if inaccessible.
- [x] #4 The documentation and website name only verified compatibility and distinguish voluntary MCP use from mechanically enforced interception.
- [x] #5 Changes pass applicable tests and review and are delivered through GitHub with Codex co-author attribution.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Implement a credential-custody ZZZ adapter for exact create_thread/create_reply HTTP payloads using official v0.1.0 routes, fixed production/preview origins, strict bounded validation and deterministic action/payload-bound provider idempotency keys. 2. Obtain zzz.agent_token only through the existing vault credential window; no credential reads or live sends during implementation. 3. Integrate CLI registry/setup/help/MCP publication without changing the shared execution contract; read-only setup probe claims credential acceptance only. 4. Test actual local HTTP transport for exact bytes, token/replay refusals, 200/201 outcomes, definite 4xx failure, and indeterminate transport/redirect/5xx/malformed-success responses with secret redaction. 5. Document invitation/write scope plus private room membership and existing workflow-evidence enrollment, without claiming independently proven human approval. 6. Parent reviews security, runs focused/full checks, merges code/docs, then site describes only verified coverage. New adapter live send remains unverified without an explicitly authorized ceremony.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Source9261b44c3587027bd74adcaccfea2adc1258ab24 merged PR351 as14af8751d36de05c2055bf2abe098b6d8efcdbee. Exact full env-clean suite3973pass/1skip/0fail exit0; focused188/188 and security/help68/68 exit0; build/lint/typecheck0; required PR and queue checks green. Parent reviewed exact binding, fixed origins, vault window, provider idempotency, conservative indeterminate outcomes and aborted-signal zero-write behavior. Site PR289 mergedc9e0718 and Pages built; live homepage/llms bytes match source and browser displays ZZZ source-checkout limitations. Live credential setup and real ZZZ post remain explicitly unverified; automated transport uses real loopback HTTP and proves rejection/once-only behavior.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
ZZZ thread/reply adapter, copyable onboarding and honest site coverage merged through PR351/289. Full tests and CI passed; actual provider send remains a separately pending live ceremony.
<!-- SECTION:FINAL_SUMMARY:END -->
