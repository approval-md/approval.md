---
id: APRV-384
title: >-
  Third-party adapter registration: approval adapter <name> and approval setup
  adapter <name> discover an adapter a consumer package provides, with the
  ceremony kept in the runtime
status: To Do
assignee: []
created_date: '2026-09-19 16:26'
labels:
  - adapters
  - npm
  - api
dependencies: []
priority: medium
ordinal: 296000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Closes the last ask of GitHub issue 140 (infinitestream, 2026-08-29). Done since: real releases from 0.1.0, and the exports map at approval-md/adapters (dist/src/adapters/public) naming the supported surface. Still incidental: approval adapter <name> is a compiled-in switch, so a consumer adapter cannot be selected by name and must be wired by deep import. Define a registration path: a consumer package declares an adapter (package.json field or a small manifest naming the module that exports the Adapter contract), the CLI resolves it by name from the project node_modules, runs runAdapterConformance against it before the first use and refuses on failure, and the ceremony stays owned by the runtime (token verify, re-hash, execution.started and completed records, credential window, redaction). A registered adapter gains no class, autonomy or budget by being registered; it is executed only under a granted token like the built-ins. Security note: loading code by name from node_modules is a supply-chain surface; the registration must name the exact module and the conformance run must be recorded, and the policy may allowlist adapter names. Related: APRV-323 design style, the public-adapter-api wave, SPEC section 7 adapters.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A consumer package can declare an adapter by name and approval adapter <name> and approval setup adapter <name> resolve and run it, with a fixture package under tests/ that exercises the path end to end through the real append path
- [ ] #2 runAdapterConformance runs before first use and a failing adapter is refused with a machine-readable code; the conformance result is recorded on the log
- [ ] #3 The policy may list allowed adapter names; when present an unlisted name is refused at resolution; absent means built-ins only, so registration is opt-in
- [ ] #4 docs: an adapter-authoring page names the surface, the manifest and the ceremony the runtime keeps; SPEC section 7 amended in one commit if it describes the compiled-in switch; issue 140 closed with a comment when this lands
<!-- AC:END -->
