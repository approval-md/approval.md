---
id: APRV-405
title: >-
  Meta Muse connector directory listing for approval.md: the submission packet,
  blocked on the hosted daemon
status: To Do
assignee: []
created_date: '2026-09-20 18:13'
labels:
  - muse
  - hosting
  - release
dependencies:
  - APRV-383
references:
  - 'https://muse.ai/platform'
  - 'https://github.com/HeddleCo/heddle/issues/1772'
  - 'https://github.com/1clawAI/muse-connector'
documentation:
  - docs/muse-hook.md
priority: low
ordinal: 313000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
muse.ai/platform is the consumer Muse assistant connector directory, a different surface from the Muse Code hook shipped under APRV-350. There is no namespace reservation: Meta reviews each submission for functional, security and legal requirements with end-to-end testing, so a placeholder submission fails and the only way to hold the name is to ship a working connector. Other submitters (HeddleCo/heddle issue 1772, 1clawAI/muse-connector) describe the packet: a hosted HTTP or REST facade Meta can test, OAuth with distinct read and write scopes, an action taxonomy with user-visible purpose strings, example prompts, a 512x512 PNG or SVG icon, a payments category, terms of service, privacy policy and a security contact. All of that needs the hosted daemon as the backend, which is why this depends on APRV-383. 1Claw already lists a connector pitched as "Is anything waiting on me? Approve that", so the approvals category is not empty. Name the listing approval.md, the common-law mark, rather than the generic word Approval. Company field: decide deliberately between Carter Crouch (copyright holder) and Bountify, Inc. (licensee); the legal review asks who owns the code. Submitting the form is a network action outside this repo; Carter submits or grants it. Filed 2026-09-20 from the half-completed form Carter had open.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A hosted connector endpoint answers Muse end-to-end testing: list pending requests, read one, decide one, each reaching the daemon through a granted token and never a raw credential
- [ ] #2 OAuth app with separate read and write scopes; a read-only grant cannot decide
- [ ] #3 Submission packet drafted under examples/muse-connector/: description, action taxonomy, example prompts, icon, ToS and privacy links, security contact
- [ ] #4 Listing name is approval.md and the company field is recorded with the reason for the choice
- [ ] #5 Implementation notes record submission date, reviewer feedback and listing status
<!-- AC:END -->
