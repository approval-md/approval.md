# Muse consumer connector prototype (APRV-436, APRV-437)

Status: **local synthetic prototype**. It has not been registered with Muse, submitted to a directory, or tested against a native Muse API. It does not enable native human decisions. A correctly configured approval.md Telegram listener remains the human decision transport; approval.md binds its buttons to the verified pending request and canonical payload.

## Evidence and unknowns

| evidence_kind | Observation | Limit |
|---|---|---|
| `official_public_page` | The [Muse platform page](https://muse.ai/platform) says a connector goes through functional, security, and legal review plus end-to-end testing before directory inclusion. | This is a review process statement, not an API contract. |
| `official_public_ui_observation` | In a read-only browser session on 2026-09-22, "Submit a connector" resolved back to `/platform`, without a visible form, authentication prompt, API specification, or warning. | No native protocol could be captured. |
| `local_synthetic` | This repository's facade and `scripts/probes/muse-connector.mjs` exercise loopback HTTP routes and negative controls. | These routes are not claimed as Muse native routes. |
| `unknown` | OAuth scopes, token exchange, callback authentication, per-action human confirmation proof, cancellation, timeouts, retries, and native display binding. | Native decisions remain disabled. |

No native capture was made.

The local probe `node scripts/probes/muse-connector.mjs` exercises only this repository's loopback HTTP facade. Its output is marked `LOCAL_SYNTHETIC_ONLY`; it cannot establish native Muse compatibility. Until a native test proves that a particular human confirmed the exact canonical rendering and request bytes, there is no `/grant` or `/reject` route. The connector returns `decision_channel: "telegram"`, `telegram_delivery_observed: false`, and `native_human_confirmation: false`. This says where the operator must collect the decision; it does not claim a message was delivered or read.

## Local contract

One foreground process serves one tenant. The operator supplies `APPROVAL_MUSE_TENANT`, distinct random `APPROVAL_MUSE_READ_TOKEN` and `APPROVAL_MUSE_PROPOSE_TOKEN` in the launch environment. Each must be at least 24 characters. The actor is fixed as `agent:muse:<tenant>` before listening. `approval muse --dir <store> --port 4683` binds only `127.0.0.1`. For separate tenants, the operator must launch separate processes with distinct stores **and** distinct credentials; the tenant label alone does not enforce isolation. Keep the configured Telegram listener running separately. No working-tree environment file is read implicitly.

Every request uses `Authorization: Bearer <token>`. No credential is accepted in a URL or body. The local routes are:

| Role | Method and route | Request | Result |
|---|---|---|---|
| propose | `POST /v1/registrations` | `{task,envelope}` | Existing gate registration; task/action keys cannot collide. |
| propose | `POST /v1/requests` | `{task,action_key,payload}` | Existing gate request; registered hash must equal the canonical hash of payload. |
| read | `GET /v1/pending` | none | Verified, live inbox with bounded fields. |
| read | `POST /v1/status` | `{task,action_key}` | Derived request state and registered payload hash. |
| read | `POST /v1/request-detail` | `{task,action_key}` | Verified canonical rendering of a live pending request. |

The facade refuses unknown fields, query strings, other scopes, and all other routes. There is no human actor input, generic CLI verb, arbitrary shell, execution, token, log export, or decision route. It sends `Cache-Control: no-store` and returns only stable error codes, never gate error prose. Input containing recognized secret fields or bearer/private-key shapes is refused; operators should still treat canonical request detail as sensitive and place the read credential only with the tenant's trusted client. Payload bytes remain in the existing content-addressed payload store, outside the append-only log.

Registration is not idempotent: a second registration is refused by core. A request retry after successful append is refused as already requested; the client should read status and compare its registered `payload_hash` before deciding its next action. A hash mismatch is refused before the request path. TTL expiry is derived by core on status and pending reads; an expired request is absent from pending. A changed policy or payload must produce the core's drift/binding refusal. The local probe has a 3-second request timeout and makes no retry. Cancellation of an HTTP request does not withdraw an already appended approval request; the caller must use the existing requester-owned withdrawal path outside this facade.

Operational prerequisite: the gate must have a configured Telegram bot token and approver chat, with its listener running. A policy using keyed sender mappings also requires the existing `APPROVAL_SENDER_KEY` in that listener's environment. A missing sender key can allow notification delivery while every decision is refused as `sender-key-unavailable`. Validate a complete decision round trip before claiming the handoff works. Terminal decisions remain the fallback.

## Submission packet, pending provider access

Connector purpose: propose a bounded approval.md task/action and let a tenant read the pending inbox and canonical request detail. Human confirmation is provided through the tenant's configured Telegram approval.md channel. Data sent to this local facade: action metadata and concrete payload; data returned: request state, hash, canonical rendering, and non-secret request metadata. No decision or execution token is sent to Muse. Transport and security for any future native integration require Muse's actual connector contract and review.

Company: **[operator to supply]**. Contact: **[operator to supply]**. Legal terms acceptance: **pending human review**. Native authentication method and OAuth scopes: **unknown**. Native cancellation, timeout, retry, callback, and confirmation semantics: **unknown**. Directory submission: **not performed**.
