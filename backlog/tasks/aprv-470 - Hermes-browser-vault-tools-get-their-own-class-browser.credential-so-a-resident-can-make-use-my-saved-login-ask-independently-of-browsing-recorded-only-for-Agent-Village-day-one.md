---
id: APRV-470
title: >-
  Hermes browser vault tools get their own class (browser.credential) so a
  resident can make 'use my saved login' ask, independently of browsing;
  recorded-only for Agent Village day one
status: To Do
assignee: []
created_date: '2026-10-04 18:01'
labels:
  - agent-village
dependencies: []
priority: low
ordinal: 357000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Raised by the refuter on hosted #41 (HOSTED-32) on 2026-10-04 and ruled by Carter the same day: for Oct 11 the vault tools stay under browser.exec (autonomous, recorded) in the Agent Village policy; after the event they get their own class. Hermes's browser family includes browser_vault_fill (fill a saved login into a page), browser_vault_save_login, browser_vault_enter_code (a 2FA code) and browser_vault_unlock; the gated image's browser_.* matcher covers them, their arguments carry vault handles rather than secret values, and core's Hermes rules class them browser.exec today. Using a stored credential on a site is a real-world side effect closer to account.credential than to reading a page: a separate class lets a policy make it manual or human-only without touching browsing, lets the onboarding review expose it as a switch later, and lets the follower count credential uses apart from page loads.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Core Hermes rules map the four browser_vault_* tools to browser.credential; the AV fixture carries the row autonomous (recorded) with a comment; conformance command-class vectors regenerated
- [ ] #2 docs/hermes-hook.md names the class and what it covers; the hosted image's matcher needs no change (browser_.* still matches)
- [ ] #3 A test proves a vault fill under a policy that makes browser.credential manual is asked and a plain browser_navigate is not
<!-- AC:END -->
