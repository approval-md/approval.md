---
id: APRV-249
title: >-
  Design optional hardened human authorization and externally verifiable
  approval receipts
status: To Do
assignee: []
created_date: '2026-09-04 20:43'
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
- [ ] #1 Design documents current identity, policy-attestation, CLI, Telegram/web-channel, grant/token, and logging behavior with code/spec references; distinguishes agent-controlled runtimes from trusted-host restrictions and states what remote verifiers can independently establish without overstating vulnerabilities.
- [ ] #2 Design states the threat model, trusted components, credential/signing-key custody, enrollment, recovery, replacement, and revocation assumptions; evaluates fresh WebAuthn/passkey authorization on a separately controlled phone surface as a candidate, including agent-created accounts, software/virtual authenticators, agent-accessible sessions, weaker recovery, residual risks, and the need for authenticator restrictions. Hardware attestation and a dedicated app remain potential later work.
- [ ] #3 Design proposes a minimal versioned authorization receipt and verification contract covering issuer, approver reference, agent identity/public-key binding, audience, decision, exact request/grant digest, permissions/scope, issuance/expiry, and unique challenge/grant identifiers; addresses canonicalization, post-review changes, replay, proof of possession, issuer trust/key rotation, revocation, and coexistence with execution tokens and append-only logs.
- [ ] #4 Design specifies review of exact authorization details on a trusted surface with fresh authentication bound to that decision, separating notification transport from authentication. Relying services enforce their own assurance minimum from validated evidence; local policy changes, alternate channels, errors, or unavailable authentication cannot silently downgrade it. An agent-supplied human_verified flag or local log alone cannot satisfy the stronger tier.
- [ ] #5 Design proposes honest assurance labels and documentation changes, distinguishing disclosed workflow adoption from independent operator evidence and the weaker import/policy-file signals. It preserves the target enrolled-operator-credential claim without claiming universal humanity, understanding, or safe subsequent behavior, and includes the ZZZ private-channel read/send grant with identified agent, expiry, membership/delegation rules, scoped rather than per-message approval, and privacy/encryption treated separately.
- [ ] #6 Design includes a negative-test plan covering fabricated local approvals, altered scope or audience, replay, wrong agent key, expired/revoked grants, untrusted issuers, credential-enrollment abuse, recovery bypass, and downgrade attempts.
- [ ] #7 Design includes a compatibility plan preserving ordinary approval.md workflows, evaluates local-first/no-hosted-service constraints, and identifies phased implementation follow-ups and unresolved decisions requiring review. The deliverable remains a single design proposal; implementation and specification/policy amendments require later authorization.
<!-- AC:END -->
