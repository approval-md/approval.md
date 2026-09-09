---
id: APRV-306
title: >-
  Release 0.1.0: second publish attempt, the one-time password in the child's
  environment
status: Done
assignee: []
created_date: '2026-09-08 06:03'
labels:
  - release
dependencies: []
ordinal: 225000
approval:
  origin:
    app: manual
    created_by: 'agent:fable'
  route:
    assignee: 'human'
    rationale: 'second attempt at the 0.1.0 publish after npm refused the first with EOTP (APRV-199 seq 29613/29614); same bytes, new key, the human runs the granted execution with the one-time password in its environment'
  state: proposed
  actions:
    - class: release.publish
      summary: 'npm publish approval-md@0.1.0 from /Users/carter/dev/approval-md (same argv and cwd as aprv-199:publish:2026-09-08; the OTP rides in npm_config_otp, never in argv or the log)'
      reversible: false
      est_cost_usd: '0'
      idempotency_key: 'aprv-306:publish:2026-09-08'
      payload_hash: '3d2fb7d3e8b83e223c134f1b9ae1ec17e8bd9c8cd6886a6cb3220e1b7b70d4bd'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The first gated publish (APRV-199 action aprv-199:publish:2026-09-08, granted seq 29604, execution.started 29613, execution.failed 29614) reached npm and was refused EOTP: npm now requires a one-time password on every publish from an account with 2FA enabled, whatever the 2FA mode. The token was spent by that attempt, so the retry is a new action key on a new registration. The OTP must not appear in argv (it would change the bound payload and be shown on the phone) nor in the log; npm reads it from npm_config_otp in the child's environment, which the human sets in the shell that runs approval run. The human therefore runs the granted execution from the primary.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A new release.publish action aprv-306:publish:2026-09-08 bound to the same {argv, cwd} as the first, requested by the agent, granted on the phone, executed by the human with npm_config_otp in the environment; grant seq and execution seqs recorded here
- [x] #2 approval-md@0.1.0 is on the registry: npm view approval-md version prints 0.1.0
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-09-08. The OTP route in the title was abandoned before use: Carter's second factor is a passkey, not a code, so there is no npm_config_otp to set. Instead Carter created a granular npm access token scoped to the approval-md package, shortest expiry, "Bypass 2FA" ticked, and set it in his npmrc; the gated child read it as any npm invocation would. The execution was then the agent's, as the first attempt was, with the human's tap as the only human act.

Records: registered seq 29671; aprv-306:publish:2026-09-08 requested 29672 (agent:fable), granted 29676 (human:carter via telegram), execution.started 29681, execution.completed 29682, exit 0: `+ approval-md@0.1.0`. npm view approval-md: version 0.1.0, bin { approval: 'cli.js' }. AC1's wording ("executed by the human with npm_config_otp") is therefore satisfied in substance (human decided, agent ran on the sealed grant, no code anywhere) and not to the letter; recorded here rather than rewritten. The bypass token is deleted after the tag push; APRV-307 replaces the mechanism with Trusted Publishing.
<!-- SECTION:NOTES:END -->
