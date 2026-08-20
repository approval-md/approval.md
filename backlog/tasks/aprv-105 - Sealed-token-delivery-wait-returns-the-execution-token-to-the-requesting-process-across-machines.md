---
id: APRV-105
title: >-
  Sealed token delivery: wait returns the execution token to the requesting
  process, across machines
status: To Do
assignee: []
created_date: '2026-08-19 13:57'
updated_date: '2026-08-20 12:56'
labels:
  - security
  - design
  - spec
milestone: m-12
dependencies: []
priority: medium
ordinal: 97000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
DESIGN TASK, raised by the human 2026-08-19: the grant-to-run handover needs two terminals and a paste (approval grant or the Telegram listener prints the raw token once on ITS stdout; approval wait reads only the verified log, which holds hashes, so it has nothing to return; examples/mcp-demo.md makes the paste the human step). The human wants one session and a path that works across machines (listener on a laptop, agent elsewhere, log synced through git as the daemon already does), with the human-gated action as secure as today. WHY THE PASTE EXISTS: the mint site (decide() in src/core/gate.ts, the one place a token is created, only on a human grant) and the spend site (approval run / the adapter contract, which verifies the hash, binds to payload_hash and idempotency_key, and consumes once) are different processes, and the only transport between them today is the human; there is no per-request secret on the request side that a grant could address a delivery to. THE DESIGN: (1) approval request mints an ephemeral X25519 keypair per request with Node crypto (no new dependency); the private key is written 0600 and atomically to .approval/keys/<action-key>.key (gitignored by approval init); the public key rides in the approval.requested payload as token_recipient_key and channels render it as a COMPUTED field. (2) On grant the mint site seals the raw token to that key (X25519 ECDH, HKDF, AES-256-GCM, nonce per seal) and appends token_sealed beside token_sha256 on approval.granted; the raw token is still printed once on the granting surface for the manual fallback. (3) approval wait, and the MCP wait tool, decrypt with the local private key and return token in --json and in the tool result; approval run reads the key file and decrypts when --token is omitted; the key file is unlinked on consume, on expiry and on revoke. (4) Policy knob token_delivery: manual | sealed, default manual (fail-closed); the dogfood APPROVAL.md opts in by human edit through policy amend. THREAT ANALYSIS (the human asked: the agent creates both keys, so how does this control the agent?): the keypair ADDRESSES, it does not AUTHORIZE. The four properties that make the action human-gated are untouched: a token exists only after a human grant (single mint site); it binds to the exact payload bytes; it is single-use at consume; credentials answer only to tokens. A keypair cannot mint, forge a grant, alter the bound payload, or reuse a spent token. What changes is who can READ a minted token: the requesting process instead of the human clipboard, which is where the human was carrying it anyway. What is lost: the marginal ability to approve on the phone and then withhold delivery. A malicious agent substituting a key substitutes it only in its OWN request, which the approver sees and approves as that agent; identity spoofing is unchanged from SPEC §11 (config-declared, trust boundary is the machine). Residual risk, stated plainly: someone who steals the private-key file AND reads the log can recover an unspent token inside its TTL; that window equals the terminal-paste window today and closes at consume or TTL. The ciphertext lives in a public, permanent log, so the seal must be sound and the token short-lived (it already is). SPEC AMENDMENTS TO DRAFT HERE AND FLAG FOR SIGN-OFF (agents never edit SPEC silently): §10.4 token delivery paragraph; §11.1 invariant 3 reworded to "raw secrets never appear in the log: what appears is a hash, or ciphertext sealed to a recipient key the log does not hold", with tests/token.test.ts and tests/binding.test.ts sweeps extended to assert the raw token is absent and the sealed field does not decrypt without the key; §6.3 payload fields token_recipient_key and token_sealed; §10.5 the MCP wait tool may return the token, retiring the APRV-88 sentence "a token an agent could fetch would be a grant an agent could give itself" (fetching a minted token is not minting one). BUILD ORDER: the amendment is signed first, then an Opus subagent builds from this task; invariants touched: 3 (reworded), 1 and 5 unchanged (wait still reads verified records; sealing happens inside the existing compare-and-append of the grant). Deferred to a later task: per-identity long-lived keys (one key per agent rather than per request) once identity is cryptographic (§11 calls that future work).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval request writes an X25519 private key to .approval/keys/<action-key>.key (0600, atomic, gitignored by init) and records token_recipient_key on approval.requested; channels render it as a computed field
- [ ] #2 On grant, approval.granted carries token_sealed beside token_sha256; a raw-token scan over the log still finds nothing and the sealed field does not decrypt without the private key (tests)
- [ ] #3 approval wait --json and the MCP wait tool return token when policy token_delivery is sealed and the local key exists; approval run without --token decrypts and consumes; the key file is unlinked on consume, expiry and revoke
- [ ] #4 Policy knob token_delivery: manual | sealed, default manual; under manual nothing about today changes byte for byte (tests pin the grant and wait outputs)
- [ ] #5 Cross-machine test: two temp working directories sharing one log file, request from A, grant from B via the cli channel, wait on A returns the token and run on A consumes it; the raw token never crosses the shared file in clear
- [ ] #6 SPEC amendments for §6.3, §10.4, §10.5 and §11.1 invariant 3 drafted, flagged, and signed by the human before the build starts
- [ ] #7 No new dependency; npm test and lint pass
<!-- AC:END -->
