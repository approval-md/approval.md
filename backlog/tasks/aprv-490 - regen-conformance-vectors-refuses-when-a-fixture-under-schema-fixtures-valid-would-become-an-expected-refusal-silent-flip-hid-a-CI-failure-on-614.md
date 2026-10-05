---
id: APRV-490
title: >-
  regen-conformance-vectors refuses when a fixture under schema/fixtures/*/valid
  would become an expected refusal (silent flip hid a CI failure on #614)
status: To Do
assignee: []
created_date: '2026-10-05 09:56'
labels:
  - agentvillage
dependencies: []
priority: medium
ordinal: 374000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up from PR #614 fix round 1. F2 (52ba4de0) made payload.policy_sha256 required on new audit.sampled records. schema/fixtures/event/valid/daemon-identity.json is a second audit.sampled valid fixture and was not updated. scripts/regen-conformance-vectors.mjs computes every expectation by running the harness, so it regenerated event-valid-daemon-identity as an expected refusal (valid: false, schema-required) without complaint, and conformance and conformance-regen stayed green. The miss surfaced only in CI run 37283211330 (full gate, node 22, shard 2/3), in tests/fixtures.test.ts 'schema "event": valid fixture daemon-identity.json passes'. Fixed in c09228df. A fixture in a valid directory is a claim that the write boundary accepts it; a regeneration that turns one into a refusal is a behaviour change nobody chose and must stop the regen, not be written into the vectors.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The regen exits non-zero, naming the fixture and its errors, when any schema/fixtures/<schema>/valid fixture would get an expectation other than valid: true, and writes no vector file
- [ ] #2 Likewise for an invalid-directory fixture that would be expected valid
- [ ] #3 A test runs the regen against a scratch copy of the fixtures with one valid fixture broken and shows the refusal
<!-- AC:END -->
