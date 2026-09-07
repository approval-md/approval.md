---
id: APRV-290
title: >-
  GOVERNANCE.md and CONTRIBUTING.md: maintainer, Bountify.ai relationship,
  trademark notice, DCO
status: In Progress
assignee:
  - '@claude'
created_date: '2026-09-07 00:59'
updated_date: '2026-09-07 01:08'
labels:
  - licensing
dependencies:
  - APRV-288
priority: high
type: docs
ordinal: 215000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Adopters (labs, safety researchers, indie developers) need one page that says who holds the spec, what the commercial operator may and may not do, and how the name is protected. This earns trust for a neutral convention more than any licence choice. GOVERNANCE.md: the specification is the product; changes go through public Backlog.md tasks and the SPEC amendment-attribution rule; Carter Crouch is maintainer and copyright holder; Bountify.ai operates a hosted implementation and holds no rights over the spec beyond any Apache 2.0 licensee; commitment to move spec and name to a neutral body at meaningful multi-party adoption (loose trigger: a second independent implementation in production); trademark notice for approval.md (common-law, unregistered, owned by Carter Crouch) with permitted 'works with' / 'implements' use and prohibited product-name or endorsement use, forks under a different name; AI-authorship provenance stated plainly (built by Carter directing Claude, Codex and Cursor under the repo's own gate, log committed); defensive publication line (dated SPEC.md history is the prior-art record, no patents sought). CONTRIBUTING.md: points to CLAUDE.md for workflow and GOVERNANCE.md for licensing; DCO 1.1 sign-off (git commit -s) required on outside human contributions with the one-sentence reason (keeps a later move to a neutral body possible without chasing signatures); states that spec and schema contributions are CC0 and code contributions are Apache 2.0, and that opening a PR is agreement. No CLA.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 GOVERNANCE.md exists and covers: spec-is-the-product, maintainer and copyright holder, Bountify.ai relationship, neutral-body commitment, trademark notice, AI-authorship provenance, defensive publication
- [ ] #2 CONTRIBUTING.md exists with the DCO requirement, the reason for it, and the per-area licence statement
- [ ] #3 Neither file grants Bountify.ai any right an ordinary Apache 2.0 licensee lacks
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Write GOVERNANCE.md (one page, sections: the spec is the product; maintainer and copyright; Bountify.ai; neutral body; trademark; provenance; defensive publication). 2. Write CONTRIBUTING.md (workflow pointer, DCO 1.1, per-area licence). 3. Commit.
<!-- SECTION:PLAN:END -->
