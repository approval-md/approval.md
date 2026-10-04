---
id: APRV-472
title: >-
  Relay attest under a keyed edgeos mapping records the keyed sender end to end;
  a refused decision never records the raw sender id
status: To Do
assignee: []
created_date: '2026-10-04 22:32'
labels:
  - agent-village
dependencies: []
ordinal: 359000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From agentvillage-d4's DATA-285 lane (controlplane #76, merged 2026-10-04). Finding 1: core refuses a digest inside a relay gesture (src/channels/relay.ts around 346-353, relay-sender-invalid; pinned by tests/channel-relay.test.ts 313-316), so the control plane renders senders.edgeos keyed and sends the RAW id in the gesture with the per-tenant sender key in the daemon env; core then records payload.sender {channel: edgeos, id: hmac-sha256:..., hashed: true}. tests/channel-relay.test.ts covers a GRANT under a keyed mapping (around line 385) but not ATTEST. Add: propose then attest over the relay under a policy with edgeos: hashedSenderId(key, RESIDENT) and the key in env; assert policy.updated payload.sender is the keyed form with hashed: true, and RESIDENT appears in neither the log bytes nor the payload store. Finding 2: without the key, core writes the RAW sender id on audit.decision_refused (src/core/sender-identity.ts around 707-719, documented as deliberate). Under a keyed mapping that is the one remaining raw-id path into a log that may be public (APRV-370's rule); decide and build: record the digest when a key resolves, and when no key resolves record a fixed marker (sender-key-unavailable) with no id at all, since the refusal code already says why. Docs: docs/cli-reference.md channel relay and the APRV-370 rule; SPEC section 10.3 hunk drafted in the notes if the refused-record field changes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 channel-relay test: propose then attest under a keyed edgeos mapping records the keyed sender with hashed true; the raw id is absent from the log bytes and the payload store
- [ ] #2 audit.decision_refused under a keyed mapping never carries the raw id: digest when the key resolves, a fixed marker and no id when it does not; tests for Telegram and edgeos, both listeners
- [ ] #3 docs updated; SPEC hunk drafted if a recorded field changed
<!-- AC:END -->
