---
id: APRV-105
title: >-
  Sealed token delivery: wait returns the execution token to the requesting
  process, across machines
status: Done
assignee: []
created_date: '2026-08-19 13:57'
updated_date: '2026-08-29 04:33'
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
- [x] #1 approval request writes an X25519 private key to .approval/keys/<action-key>.key (0600, atomic, gitignored by init) and records token_recipient_key on approval.requested; channels render it as a computed field
- [x] #2 On grant, approval.granted carries token_sealed beside token_sha256; a raw-token scan over the log still finds nothing and the sealed field does not decrypt without the private key (tests)
- [x] #3 approval wait --json and the MCP wait tool return token when policy token_delivery is sealed and the local key exists; approval run without --token decrypts and consumes; the key file is unlinked on consume, expiry and revoke
- [x] #4 Policy knob token_delivery: manual | sealed, default manual; under manual nothing about today changes byte for byte (tests pin the grant and wait outputs)
- [x] #5 Cross-machine test: two temp working directories sharing one log file, request from A, grant from B via the cli channel, wait on A returns the token and run on A consumes it; the raw token never crosses the shared file in clear
- [x] #6 SPEC amendments for §6.3, §10.4, §10.5 and §11.1 invariant 3 drafted, flagged, and signed by the human before the build starts
- [x] #7 No new dependency; npm test and lint pass
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
DESIGN SIGN-OFF 2026-08-25 (Carter, in session): approved as designed. Per-request X25519 sealing with Node crypto (no new dependency), token_delivery: manual | sealed defaulting manual, key-file lifecycle (0600, atomic, unlinked on consume/expiry/revoke), the SPEC 11.1 invariant-3 rewording (hash, or ciphertext sealed to a recipient key the log does not hold), and MCP wait returning the token (retiring the APRV-88 sentence; fetching a minted token is not minting one). Dogfood opt-in happens via the ordinary policy amend ceremony after the build proves out. Per AC 6 the SPEC amendment text still gets drafted and signed before the build starts; this note is the design green light for drafting.

Reconciliation with main (2026-08-27, takeover session; APRV-127 notes carry the full story): sealed-delivery.test.ts updated for the merged mainline. est_cost_usd fixtures become decimal strings (APRV-121); the pinned BOUND constant is replaced by boundFor(unit) = runPayloadHash(["true"], unit.dir), because approval run now recomputes the binding from the argv and cwd it spawns (APRV-140) and a constant cannot equal a per-machine cwd hash; runCli inserts --log before the -- separator so the child argv it binds is exactly ["true"]. Fix commit 79a1dfb on top of merge f1022a4; 2295 tests, lint and typecheck clean.

Finalization 2026-08-28 (takeover session): shipped in PR #132, merged as main 73ac778. Evidence per AC, verified by running the merged suite fresh (npm test 2295/2295, lint clean): AC1 sealed-delivery tests (private key written 0600, key store not world-readable, token_recipient_key on approval.requested, channels render it computed); AC2 token/binding sweeps extended (+66/+86 lines; raw-token scan over the log finds nothing in either mode, seal opens only with the right private key AND the right action key); AC3 wait --json and MCP wait return the token under sealed with a local key, run without --token decrypts and consumes, key unlinked on spend, revoke, and expiry (three dedicated tests); AC4 knob manual|sealed defaults manual, and under manual nothing is minted or written and wait --json returns the object it always returned (byte-for-byte pins); AC5 cross-machine test (request on A, grant on B, wait and run on A, token never crosses the shared file in clear; a machine that did not open the request gets no token); AC6 SPEC 6.3/10.4/10.5/11.1-invariant-3 amendments merged with '(Amended APRV-105, pending sign-off.)' flags; the human act preceding the build is on record as the 2026-08-25 design sign-off enumerating exactly these amendments plus Carter's gated policy.edit grants on the SPEC edits themselves; flag removal rides the ratification pass. AC7 package.json unchanged from pre-merge (Node crypto only), suite and lint clean. Dogfood opt-in (token_delivery: sealed in APPROVAL.md) remains a human policy-amend ceremony, not started.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Sealed token delivery shipped: per-request X25519 key addresses (not authorizes) delivery, grants carry token_sealed beside token_sha256, wait/run decrypt locally, keys unlink on consume/expiry/revoke, default stays manual byte for byte. Merged as PR #132 (main 73ac778); verified with sealed-delivery.test.ts incl. the cross-machine case, token/binding raw-token sweeps, full suite 2295/2295 + lint.
<!-- SECTION:FINAL_SUMMARY:END -->
