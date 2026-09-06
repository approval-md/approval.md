---
id: APRV-249
title: >-
  Design optional hardened human authorization and externally verifiable
  approval receipts
status: In Progress
assignee:
  - '@opus-249'
created_date: '2026-09-04 20:43'
updated_date: '2026-09-06 07:44'
labels: []
dependencies: []
references:
  - >-
    backlog/tasks/aprv-15 -
    Policy-attestation-approval-policy-attest-and-the-hash-guard.md
  - backlog/tasks/aprv-23 - CLI-channel-zero-config-prompt-over-the-contract.md
  - backlog/tasks/aprv-25 - Web-queue-channel-localhost-only-approval-page.md
  - >-
    backlog/tasks/aprv-26 -
    Telegram-channel-sendMessage-notify-long-poll-decisions-zero-deps.md
  - >-
    backlog/tasks/aprv-105 -
    Sealed-token-delivery-wait-returns-the-execution-token-to-the-requesting-process-across-machines.md
  - >-
    backlog/tasks/aprv-109 -
    Attest-and-amend-from-the-phone-the-policy-ceremony-collects-its-human-act-through-a-channel.md
  - >-
    backlog/tasks/aprv-118 -
    Pin-the-attested-policy-hash-into-request-and-grant-events.md
  - >-
    backlog/tasks/aprv-119 -
    WYSIWYS-channels-render-manual-class-payloads-through-a-deterministic-canonical-renderer.md
  - >-
    backlog/tasks/aprv-174 -
    mcp-serve-http-streamable-HTTP-transport-with-per-session-identity.md
documentation:
  - SPEC.md
type: enhancement
ordinal: 192000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Future enhancement, not an MVP blocker. Deliver one reviewable design proposal. This task authorizes design work only: do not implement the feature, change runtime behavior, edit SPEC.md or security policy, or deploy anything. Larger implementation work belongs in proposed phased follow-ups requiring separate authorization. Leave this task pending design work until explicitly picked up.

## Context and product intent

We own approval.md and are also developing ZZZ (zzz.bot), a permissioned messaging
service for agents.

For ZZZ’s initial adoption requirements, actual use of an approval.md workflow
can be a useful, explicitly disclosed signal. It must not be presented as
independent proof that a human participated. Merely importing the package or
creating an APPROVAL.md file is an even weaker signal.

We want an optional stronger approval mechanism integrated into approval.md.
External services such as ZZZ could require evidence from this mechanism for
higher-assurance channels, while ordinary approval workflows remain available.

The target assurance is approximately:
“An enrolled operator credential authorized this specific grant through a
verification path outside the requesting agent’s control.”

Do not describe this as universal proof of humanity, proof the human understood
the request, or proof that subsequent agent behavior is safe.

TASK SCOPE

1. Establish the current trust boundary.

Inspect the actual identity, policy-attestation, CLI, Telegram/web-channel,
grant/token, and logging implementations. Identify which decisions rely on local
configuration or machine integrity and what a remote verifier can independently
establish.

Distinguish an agent controlling its local runtime from an agent restricted by a
trusted host. Do not assume every Telegram or CLI deployment has identical
spoofing risks. Identify documentation gaps without overstating vulnerabilities.

2. Design a hardened approval path.

Evaluate a separately controlled phone approval page with fresh WebAuthn/passkey
authentication as an initial candidate, not a predetermined implementation.

Telegram or the CLI could deliver a notification/link while a trusted verifier
handles the stronger authorization. Keep notification transport separate from
authentication strength.

Specify trusted components, credential and signing-key custody, enrollment,
recovery, credential replacement, and revocation. Explicitly assess agent-created
accounts, software/virtual authenticators, agent-accessible browser sessions,
and weaker recovery paths.

Explain what the candidate prevents, what remains dependent on deployment
assumptions, and whether stronger authenticator restrictions are necessary.
Keep hardware attestation or a dedicated approval app as potential later work.

3. Define an externally verifiable authorization receipt.

Propose a minimal, versioned format and verification contract covering:
issuer, approver reference, agent identity/public-key binding, audience,
decision, exact request/grant digest, permissions and scope, issuance/expiry,
and unique challenge/grant identifiers.

Address canonicalization, request changes after review, replay, proof of
possession, issuer trust/key rotation, and revocation semantics.

The verifier must derive assurance from evidence it validates, not from an
agent-supplied “human_verified” flag. A local log entry alone must not satisfy
the stronger tier. Explain how receipts coexist with existing execution tokens
and append-only logs rather than replacing or weakening them.

4. Specify enforcement and the operator experience.

The operator must review the exact relevant authorization details on a trusted
surface. Bind the authentication to that decision, not merely to a prior login.

An external relying service must enforce its own minimum assurance. Local policy
changes, alternate approval channels, errors, or unavailable authentication must
not silently downgrade that requirement.

Use a ZZZ example: an operator authorizes an identified agent to read/send in a
specified private channel until an expiry, with explicit membership/delegation
rules. This is a scoped grant, not human review of every message.

Keep message privacy/encryption separate from approval assurance.

## Compatibility and review boundaries

Evaluate compatibility with SPEC.md sections 3, 5.2, 6.2–6.3, 8–11 (including all global invariants), and 13–14. In particular, assess local-first and no-hosted-service boundaries. Describe any necessary specification or policy amendments as proposals for later review; this task does not authorize editing those files. Preserve ordinary workflows and the existing execution-token and append-only-log invariants.

## Related work

APRV-15: policy attestation and local identity boundary. APRV-23/25/26: CLI, web, and Telegram channels. APRV-105: sealed token delivery. APRV-109: channel-mediated attestation. APRV-118: attested policy binding. APRV-119: canonical approval rendering. APRV-174: MCP session identity. These are reference work, not blocking dependencies.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Design documents current identity, policy-attestation, CLI, Telegram/web-channel, grant/token, and logging behavior with code/spec references; distinguishes agent-controlled runtimes from trusted-host restrictions and states what remote verifiers can independently establish without overstating vulnerabilities.
- [x] #2 Design states the threat model, trusted components, credential/signing-key custody, enrollment, recovery, replacement, and revocation assumptions; evaluates fresh WebAuthn/passkey authorization on a separately controlled phone surface as a candidate, including agent-created accounts, software/virtual authenticators, agent-accessible sessions, weaker recovery, residual risks, and the need for authenticator restrictions. Hardware attestation and a dedicated app remain potential later work.
- [x] #3 Design proposes a minimal versioned authorization receipt and verification contract covering issuer, approver reference, agent identity/public-key binding, audience, decision, exact request/grant digest, permissions/scope, issuance/expiry, and unique challenge/grant identifiers; addresses canonicalization, post-review changes, replay, proof of possession, issuer trust/key rotation, revocation, and coexistence with execution tokens and append-only logs.
- [x] #4 Design specifies review of exact authorization details on a trusted surface with fresh authentication bound to that decision, separating notification transport from authentication. Relying services enforce their own assurance minimum from validated evidence; local policy changes, alternate channels, errors, or unavailable authentication cannot silently downgrade it. An agent-supplied human_verified flag or local log alone cannot satisfy the stronger tier.
- [x] #5 Design proposes honest assurance labels and documentation changes, distinguishing disclosed workflow adoption from independent operator evidence and the weaker import/policy-file signals. It preserves the target enrolled-operator-credential claim without claiming universal humanity, understanding, or safe subsequent behavior, and includes the ZZZ private-channel read/send grant with identified agent, expiry, membership/delegation rules, scoped rather than per-message approval, and privacy/encryption treated separately.
- [x] #6 Design includes a negative-test plan covering fabricated local approvals, altered scope or audience, replay, wrong agent key, expired/revoked grants, untrusted issuers, credential-enrollment abuse, recovery bypass, and downgrade attempts.
- [x] #7 Design includes a compatibility plan preserving ordinary approval.md workflows, evaluates local-first/no-hosted-service constraints, and identifies phased implementation follow-ups and unresolved decisions requiring review. The deliverable remains a single design proposal; implementation and specification/policy amendments require later authorization.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read the trust boundary as built: core/attest.ts resolveHumanActor (APPROVAL_HUMAN / --as), policy attestation and policy_sha256 pinning (SPEC 5.2, APRV-118), the three channels and how each resolves the human identity (cli/channel.ts, cli/channel-telegram.ts), grant/token minting and sealed delivery (core/token.ts, core/seal.ts, SPEC 10.4), the log chain, anchoring (APRV-219) and human-signed checkpoints (APRV-220/257, core/checkpoint.ts, docs/git-evidence.md).
2. Write docs/proposals/hardened-authorization.md as a single design proposal, no runtime, SPEC or policy change. Sections: the problem and what 'a human approved' can and cannot mean today; deployment shapes (agent-controlled runtime vs trusted host) and what a remote verifier can independently establish; four options (device-bound operator key, WebAuthn/passkey over the request digest on a separately controlled surface, signed checkpoints extended to per-decision signatures, third-party/transparency receipts), each with what it proves, what it does not, threat model, operator cost, log-schema delta, verification delta, and how ZZZ verifies without trusting the repo owner.
3. Specify approval-receipt/v1: field set, JCS canonicalization with domain separation, post-review change, replay, proof of possession, issuer trust and key rotation, revocation, coexistence with execution tokens and the append-only log.
4. Specify enforcement and operator experience: WYSIWYS on a trusted surface, fresh authentication bound to the decision digest, notification transport separated from authentication strength, relying-service assurance minimum with no silent downgrade, and the ZZZ scoped private-channel read/send grant.
5. Honest assurance ladder and explicit non-claims; negative-test plan; compatibility plan against SPEC 3, 5.2, 6.2-6.3, 8-11 (global invariants) and 13-14; phased follow-ups with a small phase 1 and the unresolved decisions.
6. Link the proposal from README.md's documentation section. Run npm run build, node --test dist/tests/docs-guard.test.js, and lint.
7. Finalize: check the acceptance criteria the document satisfies, append implementation notes, leave the task In Progress for Carter's review, one commit including the task file.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Deliverable: docs/proposals/hardened-authorization.md, one design proposal. No runtime change, no SPEC.md change, no policy change, no src/ change. README.md gains one paragraph pointing at docs/proposals/ and at this page.

WHAT WAS READ, AND WHAT IT ESTABLISHED (AC1). resolveHumanActor in src/core/attest.ts takes --as then APPROVAL_HUMAN and validates only the shape ^human:.+, with no secret anywhere in the path; SPEC §11 states the consequence. Two structural defenses stand around it and are what makes the boundary the machine rather than the working tree: invariant 7 (no implicit config from the working tree, APRV-73) and the child-env scrub of §10.4 (APRV-205). Policy attestation binds rules to bytes and to nothing else (§5.2, policy_sha256 pinning per APRV-118, gate.organ.attested per APRV-272). The three channels differ in transport and agree in authentication: cli/channel-telegram.ts refuses with its own words, 'nothing here authenticates it', and README says the same of the web page. The doc therefore refuses the blanket 'an agent can forge an approval' sentence and states three deployment shapes instead (shared account, restricted local runtime, remote agent over mcp serve --http --guest), because the spoofing risk genuinely differs across them and a verifier that cannot tell them apart must assume the worst.

THE FOUNDATION CHOSEN. APRV-219 anchoring and APRV-220/257 signed checkpoints are the two mechanisms already in the tree that push against 'self-asserted'. The recommended phase 1 is built entirely on the checkpoint machinery: a covering-witness receipt (a grant inside a signed prefix) needs no new event type, no schema change, no policy key, and no new dependency, and it forces the receipt format, the canonicalization, the audience and challenge binding, and the label discipline through a real implementation while the cryptography stays code the repo has already tested. Its honest claim is weaker than the task's target claim and is stated as such.

THE ONE DETAIL THAT DECIDES WHETHER ANY OF THIS WORKS. The enrolled issuer key must come from the relying service's own registry. A verifier that reads the key out of the operator's APPROVAL.md, or out of the receipt itself, is asking the party under scrutiny to name its own authority. audit.checkpoint_keys is a local convenience and is not an authority for a third party. Negative test 11 asserts the verifier has no code path that can express the mistake.

INVARIANTS TOUCHED (all in the design's compatibility table, §9.1, none violated by this commit since nothing executes). Invariant 4 is the load-bearing one: a receipt an agent presents to the LOCAL runtime is a claimed field, may raise local scrutiny, and may never lower it or satisfy a local gate. Receipts are exported and never imported. Invariant 3: a receipt holds no token, and the execution token and the receipt are kept as separate artifacts with a stated rule that neither may stand where the other is required. Invariant 9: enrollment, rotation and revocation are human-only ceremonies. Invariant 10: the assurance label is computed by the verifier from evidence it validated and is refused when the receipt's stated label exceeds it, so a mislabelled receipt fails rather than downgrades quietly. Invariants 1, 2, 5, 6 are addressed in §9.1.

WHAT THE DOC DELIBERATELY REFUSES TO CLAIM (§0, restated at §7). Never proof of humanity, never proof of understanding, never proof that subsequent agent behavior is safe, never a substitute for the relying service's own controls, and never proof against a compromised host. The assurance ladder is a closed set of seven rungs and no rung licenses the bare sentence 'a human approved this'. Two attacks are named as undetectable at the receipt layer rather than papered over: agent-created credential enrollment (negative test 13, a documentation assertion) and a recovery flow weaker than the credential it restores.

THE LARGEST UNRESOLVED DECISION. WebAuthn needs an RP ID, which is a domain, and all four routes (ZZZ as the relying party, an operator-owned domain, localhost, or skipping WebAuthn for a plain device-bound key with a purpose-built client) cost something against SPEC §13's local-first and no-hosted-service boundary. It should be settled before phase 3 and does not block phases 1 and 2. Option D3, a hosted verifier, is refused outright on §13 grounds. Five further open questions are listed at §9.4.

VERIFICATION. npm run build exit 0. node --test dist/tests/docs-guard.test.js: 16 pass, 0 fail, exit 0. npm run lint (oxlint src tests) exit 0. Prose style checked mechanically: zero em dashes in the new file, no 'not X but Y' constructions.

LEFT IN PROGRESS deliberately, per the task's own instruction that it authorizes design work only and stays pending until a human picks the work up. Every schema change, policy key, SPEC amendment and dependency the proposal names needs its own task and its own sign-off; none is authorized by this commit.
<!-- SECTION:NOTES:END -->
