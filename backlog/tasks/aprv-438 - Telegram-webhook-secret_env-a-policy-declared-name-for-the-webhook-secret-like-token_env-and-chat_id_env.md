---
id: APRV-438
title: >-
  Telegram webhook secret_env: a policy-declared name for the webhook secret,
  like token_env and chat_id_env
status: To Do
assignee: []
created_date: '2026-09-25 01:29'
labels:
  - telegram
  - webhook
  - policy
  - hosting
dependencies: []
priority: medium
ordinal: 334000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
APRV-424 reads the webhook secret_token from the fixed environment name APPROVAL_TG_WEBHOOK_SECRET, while channels.telegram.token_env and chat_id_env are policy-declared precisely so one machine can run two gates against two bots and so an operator can give every tenant's credentials a distinct, non-colliding name. Hosted tenants (Bountify, 2026-09-24) name credentials per tenant (HOSTED_<TENANT>_TG_BOT_TOKEN and so on); the webhook secret cannot follow that convention today, and a shared fixed name is the kind of collision that has bitten this operator before. Add channels.telegram.secret_env to schema/policy.schema.json (additionalProperties is false there, so this is a schema amendment), read it in src/core/telegram-config.ts beside the other two with APPROVAL_TG_WEBHOOK_SECRET as the default, document it in docs/cli-reference.md and the policy example, and mention it in approval doctor's env rows. Recorded as the follow-up in APRV-424's notes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 channels.telegram.secret_env is accepted by the policy schema, read by the webhook verb with the fixed name as the fallback, and refused when the named variable is unset or too short, with the same codes as today
- [ ] #2 Two stores on one machine declaring different secret_env names run two webhook verbs against two bots without either reading the other's secret, shown by a test
- [ ] #3 docs/cli-reference.md, the canonical policy example and approval doctor name the key; conformance policy fixtures gain a valid example
<!-- AC:END -->
