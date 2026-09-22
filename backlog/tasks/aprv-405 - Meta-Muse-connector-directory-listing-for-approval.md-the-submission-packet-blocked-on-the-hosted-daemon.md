---
id: APRV-405
title: >-
  Meta Muse connector directory listing for approval.md: verified submission
  packet and review
status: To Do
assignee: []
created_date: '2026-09-20 18:13'
updated_date: '2026-09-22 06:49'
labels:
  - muse
  - hosting
  - release
dependencies:
  - APRV-383
  - APRV-421
  - APRV-436
  - APRV-437
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
Consumer Muse directory listing, separate from Muse Code APRV-350. Prepare the submission from verified probe APRV-436 and prototype APRV-437; HTTP transport APRV-421 and daemon identity APRV-383 have landed but do not establish hosted availability or human decision authority. Use listing name approval.md. Native human confirmation remains unavailable until verified; prototype uses existing Telegram handoff. Company, legal links, security contact, hosting and submission require concrete operator configuration. Do not infer OAuth requirements or native decision support from third-party packets.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A reviewed hosted endpoint passes actual Muse end-to-end testing for proposal, pending inbox, request detail and trusted human decision handoff; reads and human grants do not require an execution token.
- [ ] #2 Authentication and scopes follow the verified Muse contract; read and proposal authority cannot decide, impersonate humans or access another tenant.
- [ ] #3 Submission packet under examples/muse-connector accurately includes action taxonomy, example prompts, icon, legal links and security contact with unresolved fields explicit.
- [ ] #4 Listing name is approval.md and the operator selects the legal company field with the reason recorded.
- [ ] #5 Notes record actual submission date, reviewer feedback and listing state; leave pending until those actions occur.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-09-22: refreshed from approved Codex and Muse plan. APRV-383 is Done and HTTP facade APRV-421 has landed. New probe436/prototype437 precede listing. Public platform UI Submit a connector resolves to /platform without a form in the inspected browser; native API and confirmation contract remain unavailable. No form was submitted or terms accepted.
<!-- SECTION:NOTES:END -->
