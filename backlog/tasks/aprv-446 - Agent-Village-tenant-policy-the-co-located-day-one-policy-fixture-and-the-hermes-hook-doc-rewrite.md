---
id: APRV-446
title: >-
  Agent Village tenant policy: the co-located day-one policy fixture and the
  hermes-hook doc rewrite
status: Done
assignee:
  - '@opus-lane'
created_date: '2026-10-03 03:48'
updated_date: '2026-10-03 05:56'
labels:
  - hermes
  - agent-village
  - docs
dependencies: []
references:
  - private/agentvillage-integration/05-integration-architecture.md
priority: high
ordinal: 334000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The policy a co-located Agent Village tenant runs under is the recorder shape decided on 2026-10-01 (DATA-233): defaults autonomous, the three gate organs (policy.core, log.mutate, account.credential) human-only, intent.publish.* manual with agent_may_request true and the two explicit intent.publish rows, approval_ttl 72h, channels.telegram naming the relay token env and a resident chat env, and the Hermes tool classes from APRV-445 (cron.manage, process.write, browser.exec, skill.manage, agent.delegate, message.send) autonomous so they are recorded and never block. The template that merged in the overlay (Edge-City/agentvillage PR 164, skills/approval/templates/APPROVAL.md) is the hosted shape from approval-md-hosted docs/03: approval_ttl 4m, HOSTED_<TENANT>_TG_* env names, network.call and read.web and nine other classes manual. Under fail_closed and APPROVALD_ENFORCE=1 that template gates every resident shut on day one. This repo should carry the canonical fixture the overlay and the control plane copy from, and docs/hermes-hook.md section For Agent Village still describes a hosted daemon the sandbox cannot reach; it must describe co-location: approval serve on loopback or a unix socket, the agent token file, the relay api-base, the operator attestation at provisioning, and the 240 s hook window beside the 72 h proposal window. Context: private/agentvillage-integration/05-integration-architecture.md section 4 (gitignored pack, 2026-10-02).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A policy fixture for a co-located Agent Village tenant exists under examples/ or templates/, loads and attests in a test through the real loader, resolves network.call, read.web and the six Hermes tool classes autonomous, resolves intent.publish.inferred.index manual and agent-requestable, and resolves policy.core, log.mutate and account.credential human-only
- [x] #2 The fixture names the relay credential and the resident chat through channels.telegram token_env and chat_id_env with names the control plane writes, and carries approval_ttl 72h with a comment stating that hook-opened requests still clamp to the harness cap minus 60 s
- [x] #3 docs/hermes-hook.md section For Agent Village is rewritten for the co-located shape and no longer says reaching the hosted daemon from a sandbox is unsolved; it names the operator attestation step and the fact that until a human attests every gated call refuses policy-not-attested and fail_closed blocks the tool
- [x] #4 A policy test or conformance vector proves the fixture blocks nothing on a representative terminal, write_file and read_file envelope and opens a request on a propose for intent.publish.inferred.index
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Fixture at examples/agent-village/approval-policy.md: the section 4 policy of 05-integration-architecture.md row for row, with prose per choice. Named approval-policy.md and never APPROVAL.md (a file with that basename classifies policy.core wherever it sits; the control plane renders it to the tenant's APPROVAL.md at provisioning, replacing the <telegram_user_id> placeholder). approval_ttl comment says hook-opened requests clamp to the harness cap minus 60 s.
2. tests/agent-village-policy.test.ts through the real loader, resolver and CLI: unrendered template fails closed; rendered fixture names the relay token env and resident chat env and 72h; network.call, read.web and the six Hermes classes autonomous with their own rows; intent.publish.inferred.index manual (and agent_may_request true where the build has the key); the three organs human-only; a tenant store provisioned with --bootstrap blocks nothing on terminal, write_file and read_file Hermes envelopes; a propose for intent.publish.inferred.index opens a request and the stated class answers autonomous.
3. The #569 key: the test reads the build's own policy schema. Without agent_may_request (main today) it asserts the verbatim fixture fails closed (every class manual) and proves the table and hook verdicts on the same text with the key removed; the propose case skips with a reason naming #569. With the key it runs verbatim, including propose. Evidence for the #569 side from a local probe worktree (PR 569 head + this lane's commits), not pushed.
4. docs/hermes-hook.md section For Agent Village rewritten for co-location only (serve on loopback or unix, agent token file, up --api-base against the relay, operator attestation, 240 s hook window beside 72 h proposal window, what the hook never sees). Nothing else in that file is touched (PR 569 edits it).
5. CHANGELOG bullet.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Resume point: fixture, test, hermes-hook section, examples README, CHANGELOG written; targeted green on main (7 pass, propose skipped) and on the 569 probe (8/8). Next: full npm test, commit APRV-446, push lane/aprv-446, PR.

Implementation notes (2026-10-03, opus lane):

FIXTURE. examples/agent-village/approval-policy.md is section 4 of 05-integration-architecture.md row for row (all 16 class rows, the approvers block with the commented edgeos line, channels.telegram token_env APPROVAL_RELAY_TOKEN and chat_id_env APPROVAL_RESIDENT_CHAT, defaults autonomous / telegram / 72h / reject / sealed). Two deliberate differences: the approval_ttl comment now says hook-opened requests clamp to the harness cap minus 60 s (AC #2 wording; 05 said 'clamp to 240 s'), and the prose around the block explains each choice.

NAME. The file is approval-policy.md and never APPROVAL.md: the hook classifies any write to a file with that basename as policy.core (human-only) in any repository, so a fixture so named could not be maintained by an agent at all (lane O1 was refused on exactly that), and an unrendered copy must never read as a tenant's live policy. The control plane renders it into the tenant store's APPROVAL.md at provisioning, replacing "<telegram_user_id>" with the paired id. Unrendered it fails the sender pattern and resolves every class manual (tested): a store that got the template without the render is gated shut, never open.

THE #569 KEY. agent_may_request is PR #569's key and is not on main. The test reads this build's schema/policy.schema.json (classRule.properties) and VERB_REGISTRY (a 'propose' verb) and branches on what it finds, never on a flag:
- main today: asserts the verbatim rendered fixture FAILS CLOSED (load refuses naming agent_may_request; network.call, read.web, the Hermes classes and the organs all resolve manual), then proves the class table and the three hook verdicts on the same text with ', agent_may_request: true' removed. The propose test is SKIPPED with the reason 'needs #569's approval propose verb'. Result: 7 pass, 1 skipped.
- with #569: the fixture loads verbatim, agent_may_request is true on intent.publish.* and intent.publish.inferred.index, and the propose round runs (inferred class answers decision requested with an approval.requested record; stated class answers autonomous). Evidence from a local probe worktree (/Users/carter/dev/approval-md-wt/probe-446-569: PR 569 head fe10ffd4 + this lane's APRV-449 commit cherry-picked, only CHANGELOG conflicted): agent-village-policy + cli-attest-bootstrap + cli-status 42/42, exit 0. Not pushed. Once #569 merges, merging main into this branch makes CI run the full path.

HOOK VERDICTS. A tenant store is provisioned the real way (init, the policy, policy attest --bootstrap --as human:operator), then terminal (absolute workdir), write_file and read_file Hermes pre_tool_call envelopes go through approval hook hermes --harness-cap 300s: all three answer {} at exit 0, no approval.requested is appended, and log verify is clean. Passes on main and on the 569 probe (where #569's Hermes rules classify these tools).

DOC. docs/hermes-hook.md 'For Agent Village' only (PR 569 also edits this file; no other section touched): tenant shape, serve on loopback or unix (unix is #569's), the agent token file, up --api-base against the relay and the cwd/--dir log-path caveat, the operator attestation and policy-not-attested + fail_closed, the two windows, the starting policy, what the hook never sees, and the adapter bullets that still bind (HERMES_HOME, --dir, hooks_auto_accept, fail_closed + harness cap, absolute paths, execute_code, daemon identity). The 'reaching the hosted daemon from a sandbox is still unsolved' bullet is gone. Also carries the coordinator's note: intent.publish.stated.index stays autonomous only for a request that does not declare reversible: false (no row sets allow_irreversible); proposals carry no reversible field today.

NO SPEC CHANGE. Nothing here diverges from SPEC.md.

Validation: full npm test on this branch (APRV-449 + APRV-446): 5405 pass, 0 fail, 2 skipped (one is this file's propose case, skipped for want of #569), exit 0; tsc --noEmit 0; lint 0. AC #1 and #4 are proven verbatim (load with agent_may_request, propose opens a request) on the 569 probe only; on main the test proves the fail-closed reading and the table on the key-stripped text, and CI exercises the verbatim path once #569 is merged into this branch.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added examples/agent-village/approval-policy.md, the canonical co-located Agent Village day-one policy (section 4 of the integration architecture, named approval-policy.md because any APPROVAL.md classifies policy.core; the control plane renders it into the tenant's APPROVAL.md), and tests/agent-village-policy.test.ts, which proves it through the real loader, resolver, policy attest --bootstrap and hook hermes, and runs the propose round when the build carries #569's agent_may_request (verified on a local 569 probe, 42/42). Rewrote docs/hermes-hook.md 'For Agent Village' for co-location. Full suite green.
<!-- SECTION:FINAL_SUMMARY:END -->
