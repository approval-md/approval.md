/**
 * The AgentMail adapter (SPEC.md §6.1, §6.2, §10.4, §11; APRV-222).
 *
 * A second executor for `communicate.email.external`, over the AgentMail HTTPS
 * API. It exists because AgentMail is becoming the way an agent holds a mailbox,
 * and because its Drafts primitive is documented as mail that only leaves when
 * something outside the agent says so. approval.md is that something, with a
 * hash-chained log behind it.
 *
 * Like every adapter it implements exactly one method, {@link Adapter.act}, and
 * `adapters/contract.ts` owns everything around the call: the hash
 * recomputation, the token spend, `execution.started`, the credential window,
 * the outcome event, and the redaction sweep. Nothing here touches a token or
 * the log.
 *
 * ## The enforcement model this adapter assumes
 *
 * AgentMail API keys carry per-permission booleans (`draft_create`,
 * `draft_update`, `draft_read`, `draft_send`, `message_send` are separate). The
 * deployment this adapter is written for gives the agent a key WITHOUT the two
 * send permissions and puts a key WITH them in the vault under
 * {@link DEFAULT_AGENTMAIL_CREDENTIAL_NAMES}.apiKey, where it is readable only
 * inside the verified-token window the contract opens. The agent can therefore
 * compose all day and cannot send at all; the sending key answers to a grant.
 *
 * ## Two payload modes, discriminated by shape, ambiguity refused
 *
 * **Direct send.** The email adapter's own payload, validated by the email
 * adapter's own {@link validateEmailPayload} rather than a second copy of it:
 *
 * ```ts
 * { from, to: string[], cc?, bcc?, subject, body, content_type? }
 * ```
 *
 * posted to `POST /v0/inboxes/{inbox_id}/messages/send`.
 *
 * **Draft send.** A snapshot of a draft the agent has already composed, taken at
 * request time so a human approves the words rather than an id:
 *
 * ```ts
 * { inbox_id, draft_id, to: string[], cc?, bcc?, subject, text }
 * ```
 *
 * The adapter re-fetches the draft, canonicalizes those same fields (RFC 8785,
 * the same `core/jcs.ts` the hash chain uses) on both sides, and refuses
 * `agentmail-draft-drifted` on any difference before calling
 * `POST .../drafts/{draft_id}/send`. That check is the whole point of the mode:
 * a draft is mutable server-side state, and an approval of a draft id would
 * otherwise be an approval of whatever the agent last wrote into it. The
 * refusal names WHICH fields differ and never what they now hold — a drift
 * message is written to a log and read by a human who did not approve the new
 * text, and quoting it there would publish unapproved content through the
 * refusal path.
 *
 * ## The comparison runs before the token is spent (APRV-276)
 *
 * It happens TWICE, through one function ({@link checkDraftBeforeSend}), and
 * the first of the two is the one this section exists for.
 *
 * The first call is {@link Adapter.precheck}: the contract runs it after the
 * declared credentials resolve and BEFORE the token is consumed, so a drifted
 * draft refuses with nothing appended and the grant intact. Until APRV-276 the
 * comparison ran only inside `act`, which meant a drift refused correctly and
 * spent the single-use token doing it: the human's tap was consumed by an
 * attempt that sent nothing, and restoring the approved text then refused
 * `token-consumed`. That is the failure mode the whole design is against — a
 * refusal that costs a human another tap teaches operators to stop checking.
 *
 * The second call is `act`'s own, inside the consumed-token window and
 * immediately before the POST. It is not redundant: AgentMail sends a draft by
 * id, so something must stand between the last read and the send, and this is
 * what makes that gap as small as the transport allows. A drift caught there is
 * `execution.started` then `execution.failed`, which is the honest record of a
 * window that was open when the far side moved.
 *
 * **Which key performs the pre-spend read.** The same sending key from the
 * vault, handed over by the credential provider the contract scopes to the
 * precheck call. Not the agent's own `AGENTMAIL_API_KEY`, even though the demo
 * has one in the environment: a comparison whose input the party under
 * oversight chooses is scrutiny that party controls, and SPEC.md §11.1
 * invariant 4 puts that the other way round. Nothing new is opened to make this
 * possible — the contract already reads the vault before the spend, to resolve
 * {@link Adapter.requiredCredentials} (APRV-169), inside APRV-168's
 * `presented`-phase grant, which is minted only when the caller's token matches
 * the digest the human's grant recorded. SPEC.md §10.4 carries the decision.
 *
 * A payload carrying markers of both modes, or of neither, is refused rather
 * than guessed at (`agentmail-payload-ambiguous`, `agentmail-payload-invalid`):
 * choosing a send mode by inference is choosing a side effect by inference.
 *
 * ## `from`, and why it costs one extra read
 *
 * AgentMail's send endpoint has no `from` field. The inbox IS the sender, so
 * the payload cannot bind the From address the way the SMTP adapter's can, and
 * a human who approved a message "from carter@…" would otherwise be approving a
 * sender this adapter never checked.
 *
 * The resolution: `from` stays in the payload as the human-facing claim about
 * the sender (reusing {@link validateEmailPayload} keeps it required and
 * well-formed), it is sent to AgentMail in no field at all, and `act` performs
 * one extra read — `GET /v0/inboxes/{inbox_id}` — before the send, refusing
 * `agentmail-from-mismatch` (case-insensitively) when the inbox's own address is
 * not the approved one. So `from` is informational on the wire and binding here.
 * The read runs on every direct send because it doubles as the credential
 * check: a key that cannot open its own inbox is a key that should not discover
 * this by half-sending. It is a GET, it is idempotent, it puts no message
 * anywhere, and a transport failure on it is `agentmail-unreachable` precisely
 * because nothing was attempted.
 *
 * ## Failures
 *
 * Every HTTP refusal is a RETURNED failure ({@link ActOutcome} `ok: false`), so
 * the contract records `execution.failed`: the far side answered, and an answer
 * is knowledge. A throw from the SEND call is deliberately NOT caught — it
 * propagates, the contract records `execution.indeterminate`, and a human finds
 * out that nobody knows whether the message went (APRV-120). A throw from the
 * pre-send GETs is returned as `agentmail-unreachable`, because those run before
 * anything is attempted.
 *
 * Deterministic apart from its transport: no randomness, no clock, no
 * environment reads. Every string this file returns has been through
 * {@link redactSecrets} against the API key.
 */

import type { ObservationWindow, ObservedEffect } from "../core/coverage.js";
import type { CredentialSpec } from "../core/credential-spec.js";
import { canonicalize } from "../core/jcs.js";
import { payloadHash } from "../core/payload.js";
import {
  CREDENTIAL_REFUSAL_CODES,
  redactSecrets,
  type ActInput,
  type ActOutcome,
  type Adapter,
  type CredentialProvider,
  type JsonValue,
  type PrecheckInput,
  type PrecheckOutcome,
} from "./contract.js";
import { EMAIL_CLASS, envelopeRecipients, validateEmailPayload } from "./email.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The one class this adapter serves. The same string the email adapter serves. */
export const AGENTMAIL_CLASS = EMAIL_CLASS;

/** The public API. Overridable so the whole adapter can run against loopback. */
export const AGENTMAIL_DEFAULT_API_BASE = "https://api.agentmail.to";

/** Whole-request budget for one HTTP call. */
export const AGENTMAIL_DEFAULT_TIMEOUT_MS = 15_000;

/**
 * The two vault names, as an open record rather than a literal type: a
 * deployment that stores these under other names must be able to SAY so, and a
 * `typeof` of the defaults would type `credentialNames` as the defaults.
 */
export interface AgentmailCredentialNames {
  apiKey: string;
  inboxId: string;
}

/** The vault names, overridable per deployment. */
export const DEFAULT_AGENTMAIL_CREDENTIAL_NAMES: AgentmailCredentialNames = {
  apiKey: "agentmail.api_key",
  inboxId: "agentmail.inbox_id",
};

// ---------------------------------------------------------------------------
// The failure vocabulary (SPEC.md §11.1 invariant 6: frozen, additive only)
// ---------------------------------------------------------------------------

export const AGENTMAIL_FAILURE_CODES = [
  /** The payload is not a well-formed value for either mode. Nothing was called. */
  "agentmail-payload-invalid",
  /** The payload carries markers of both modes; a send mode is never inferred. */
  "agentmail-payload-ambiguous",
  /** The vault answered, and what it holds is not usable configuration. */
  "agentmail-config-invalid",
  /** A draft payload names an inbox that is not the configured one. */
  "agentmail-inbox-mismatch",
  /** The approved `from` is not the address this inbox sends as. Nothing sent. */
  "agentmail-from-mismatch",
  /** The draft the grant was taken over is gone (404 on the draft read). */
  "agentmail-draft-missing",
  /** The draft changed after the snapshot the human approved. Nothing sent. */
  "agentmail-draft-drifted",
  /** A transport failure on a pre-send read: nothing was attempted. */
  "agentmail-unreachable",
  /** 401 or 403: the key is not accepted, or lacks the permission. */
  "agentmail-unauthorized",
  /** 404 on something other than the draft read. */
  "agentmail-not-found",
  /** 409: the far side says this conflicts with state it already holds. */
  "agentmail-conflict",
  /** 429: rate limited. */
  "agentmail-rate-limited",
  /** Any other 4xx: the request was refused on its merits. */
  "agentmail-rejected",
  /** Any 5xx. */
  "agentmail-server-error",
  ...CREDENTIAL_REFUSAL_CODES,
] as const;

export type AgentmailFailureCode = (typeof AGENTMAIL_FAILURE_CODES)[number];

export function isAgentmailFailureCode(value: string): boolean {
  return (AGENTMAIL_FAILURE_CODES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// The credential manifest (APRV-78's shape, APRV-222's two values)
// ---------------------------------------------------------------------------

/**
 * The refusal sentences, written once and used twice: the setup wizard refuses
 * a value at the moment an operator could still fix it, in the same words `act`
 * would use at send time.
 */
function opaqueSentence(name: string, what: string): string {
  return `the vault's ${name} is empty or carries whitespace; ${what} is a single opaque token with no spaces in it`;
}

/** Non-empty and whitespace-free, which is all either value's shape asserts. */
function checkOpaque(value: string, sentence: string): { ok: true } | { ok: false; message: string } {
  if (value.length === 0 || /\s/u.test(value)) return { ok: false, message: sentence };
  return { ok: true };
}

/**
 * What this adapter reads from the vault, declared rather than discovered, so
 * `approval setup adapter agentmail` can ask for it without knowing what
 * AgentMail is. DERIVED from {@link DEFAULT_AGENTMAIL_CREDENTIAL_NAMES} rather
 * than restating the strings.
 */
export const AGENTMAIL_CREDENTIAL_SPECS: readonly CredentialSpec[] = [
  {
    name: DEFAULT_AGENTMAIL_CREDENTIAL_NAMES.inboxId,
    kind: "config",
    label: "AgentMail inbox id",
    describe: "the inbox this runtime sends from; AgentMail has no per-message From",
    required: true,
    validate(value: string) {
      return checkOpaque(
        value.trim(),
        opaqueSentence(DEFAULT_AGENTMAIL_CREDENTIAL_NAMES.inboxId, "an inbox id"),
      );
    },
  },
  {
    name: DEFAULT_AGENTMAIL_CREDENTIAL_NAMES.apiKey,
    kind: "secret",
    label: "AgentMail API key",
    describe:
      "the key that carries message_send and draft_send; the agent's own key must not have them",
    required: true,
    validate(value: string) {
      return checkOpaque(
        value.trim(),
        opaqueSentence(DEFAULT_AGENTMAIL_CREDENTIAL_NAMES.apiKey, "an API key"),
      );
    },
  },
];

/**
 * The names this adapter cannot act without (APRV-169), for the contract's
 * pre-token resolution. Derived from the manifest, mapped through `names` so a
 * deployment that renamed one gets the name it actually stored.
 */
export function requiredAgentmailCredentials(
  names: AgentmailCredentialNames = DEFAULT_AGENTMAIL_CREDENTIAL_NAMES,
): readonly string[] {
  const keyOfDefault = new Map<string, keyof AgentmailCredentialNames>(
    Object.entries(DEFAULT_AGENTMAIL_CREDENTIAL_NAMES).map(([key, value]) => [
      value,
      key as keyof AgentmailCredentialNames,
    ]),
  );
  return AGENTMAIL_CREDENTIAL_SPECS.filter((spec) => spec.required === true).map((spec) => {
    const key = keyOfDefault.get(spec.name);
    return key === undefined ? spec.name : names[key];
  });
}

// ---------------------------------------------------------------------------
// Configuration, read in exactly one place
// ---------------------------------------------------------------------------

/** What {@link readAgentmailConfig} resolved. */
export interface AgentmailConfig {
  apiKey: string;
  inboxId: string;
}

/**
 * What one configuration read produced.
 *
 * `secrets` is the redaction corpus and holds ONLY the secret-kind values (the
 * API key). The inbox id is not a secret and is deliberately left scrubbable-not:
 * it appears in refusal sentences that are useless without it. Returned on both
 * branches, because a caller that goes on to make requests must scrub the far
 * side's sentences with the same corpus this read built.
 */
export type AgentmailConfigOutcome =
  | { ok: true; config: AgentmailConfig; secrets: readonly string[] }
  | { ok: false; code: AgentmailFailureCode; message: string; secrets: readonly string[] };

/**
 * Read this adapter's whole configuration from a credential provider.
 *
 * The single place in the repository that turns a {@link CredentialProvider}
 * into AgentMail settings — the names it asks for, the order, the shape rules —
 * mirroring `readEmailSmtpConfig` for the same reason: `act` calls it inside the
 * verified-token window and `approval setup adapter agentmail` calls it to probe
 * a configuration it only partly typed, and a second reader would be a second
 * opinion about what "configured" means.
 */
export function readAgentmailConfig(
  credentials: CredentialProvider,
  names: AgentmailCredentialNames = DEFAULT_AGENTMAIL_CREDENTIAL_NAMES,
): AgentmailConfigOutcome {
  const secrets: string[] = [];
  const scrub = (text: string): string => redactSecrets(text, secrets).text;

  const inbox = credentials.get(names.inboxId);
  if (!inbox.ok) {
    return {
      ok: false,
      code: inbox.code,
      secrets,
      message: `the agentmail adapter needs the credential ${JSON.stringify(names.inboxId)}: ${inbox.message}`,
    };
  }
  const key = credentials.get(names.apiKey);
  if (key.ok && key.value.length > 0) secrets.push(key.value);
  if (!key.ok) {
    return {
      ok: false,
      code: key.code,
      secrets,
      message: `the agentmail adapter needs the credential ${JSON.stringify(names.apiKey)}: ${key.message}`,
    };
  }

  const inboxShape = checkOpaque(inbox.value, opaqueSentence(names.inboxId, "an inbox id"));
  if (!inboxShape.ok) {
    return { ok: false, code: "agentmail-config-invalid", message: inboxShape.message, secrets };
  }
  const keyShape = checkOpaque(key.value, opaqueSentence(names.apiKey, "an API key"));
  if (!keyShape.ok) {
    return {
      ok: false,
      code: "agentmail-config-invalid",
      message: scrub(keyShape.message),
      secrets,
    };
  }

  return { ok: true, secrets, config: { apiKey: key.value, inboxId: inbox.value } };
}

// ---------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------

/**
 * The slice of `fetch` this module uses, structurally.
 *
 * Declared here rather than imported so the adapter depends on a shape and not
 * on a lib: a test hands over a stub, and the default is the global `fetch`
 * Node ≥ 20 ships.
 */
export type AgentmailFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** One HTTP answer, read to the end. */
interface HttpAnswer {
  status: number;
  body: string;
}

/** Everything a call needs that is not the call. */
interface Transport {
  fetch: AgentmailFetch;
  apiBase: string;
  timeoutMs: number;
  apiKey: string;
  signal?: AbortSignal | undefined;
}

/**
 * One request. Throws on transport failure — the caller decides whether that is
 * `agentmail-unreachable` (a pre-send read) or a propagated indeterminacy (the
 * send itself).
 *
 * `path` is appended to the API base verbatim, so it may carry a query string
 * (`/v0/inboxes/x/messages?limit=100`). The callers that need one build it with
 * `URLSearchParams`, so the escaping question is asked in one place and this
 * function stays "put these bytes after the base".
 */
async function call(
  transport: Transport,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<HttpAnswer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), transport.timeoutMs);
  const outer = transport.signal;
  const relay = (): void => controller.abort();
  outer?.addEventListener("abort", relay, { once: true });
  try {
    const response = await transport.fetch(`${transport.apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${transport.apiKey}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    return { status: response.status, body: await response.text() };
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", relay);
  }
}

/** The HTTP status → failure code mapping, in one place. */
function codeForStatus(status: number): AgentmailFailureCode {
  if (status === 401 || status === 403) return "agentmail-unauthorized";
  if (status === 404) return "agentmail-not-found";
  if (status === 409) return "agentmail-conflict";
  if (status === 429) return "agentmail-rate-limited";
  if (status >= 500) return "agentmail-server-error";
  return "agentmail-rejected";
}

/** A JSON object, or `null` when the body was not one. Never throws. */
function parseObject(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* a non-JSON body is a fact about the far side, not an exception here */
  }
  return null;
}

/**
 * The far side's own words for a refusal, kept short and scrubbed by the
 * caller. A body that is not JSON is reported by length rather than quoted:
 * an HTML error page in a refusal message is noise, and an unbounded one is a
 * log-flooding hole.
 */
function describeBody(body: string): string {
  const parsed = parseObject(body);
  const said = parsed === null ? null : parsed["message"] ?? parsed["error"] ?? parsed["detail"];
  if (typeof said === "string" && said.length > 0) return said.slice(0, 400);
  if (body.trim().length === 0) return "no body";
  return `a ${String(body.length)}-byte body that named no error`;
}

/** The one non-sending read, exported so the setup wizard can probe a key. */
export type AgentmailProbe =
  | {
      ok: true;
      address: string;
      http_status: number;
      /**
       * The permissions the inbox read DISCLOSED about the calling key, or
       * `null` when it disclosed none (APRV-223).
       *
       * Read from the one response this adapter already asks for, never from a
       * second endpoint: a setup verb that probed a URL nobody has confirmed
       * exists would report a 404 as a permissions problem, which is a worse
       * answer than "not disclosed". `null` therefore means UNKNOWN and never
       * "none", and every caller must treat it as the reminder it is.
       */
      permissions: readonly string[] | null;
    }
  | { ok: false; code: AgentmailFailureCode; message: string };

/** The two permissions a key must hold to send anything for this adapter. */
export const AGENTMAIL_SEND_PERMISSIONS = ["draft_send", "message_send"] as const;

/**
 * The permissions an inbox body disclosed, or `null` when it disclosed none.
 *
 * Accepts either spelling an API of this shape uses (`permissions`, `scopes`),
 * at the top level or under a `key`/`api_key` object, and answers `null` for
 * anything else. Every unknown shape is UNKNOWN rather than empty: an empty
 * list is the claim "this key holds nothing", and inferring that from silence
 * would make a setup run refuse a perfectly good key.
 */
function disclosedPermissions(body: Record<string, unknown> | null): readonly string[] | null {
  if (body === null) return null;
  const holders: unknown[] = [body, body["key"], body["api_key"]];
  for (const holder of holders) {
    if (typeof holder !== "object" || holder === null || Array.isArray(holder)) continue;
    for (const field of ["permissions", "scopes"] as const) {
      const held = (holder as Record<string, unknown>)[field];
      if (Array.isArray(held) && held.every((entry) => typeof entry === "string")) {
        return held as string[];
      }
    }
  }
  return null;
}

export interface AgentmailProbeOptions {
  fetch?: AgentmailFetch;
  apiBase?: string;
  timeoutMs?: number;
}

/**
 * `GET /v0/inboxes/{inbox_id}`: does this key open this inbox, and what address
 * does it send as? Sends nothing, changes nothing, and is the credential check
 * both `act` and `approval setup adapter agentmail` use.
 */
export async function probeAgentmail(
  config: AgentmailConfig,
  options: AgentmailProbeOptions = {},
): Promise<AgentmailProbe> {
  const transport: Transport = {
    fetch: options.fetch ?? (globalThis.fetch as unknown as AgentmailFetch),
    apiBase: (options.apiBase ?? AGENTMAIL_DEFAULT_API_BASE).replace(/\/+$/u, ""),
    timeoutMs: options.timeoutMs ?? AGENTMAIL_DEFAULT_TIMEOUT_MS,
    apiKey: config.apiKey,
  };
  const scrub = (text: string): string => redactSecrets(text, [config.apiKey]).text;

  let answer: HttpAnswer;
  try {
    answer = await call(transport, "GET", inboxPath(config.inboxId));
  } catch (cause) {
    return {
      ok: false,
      code: "agentmail-unreachable",
      message: scrub(
        `the AgentMail API could not be reached to read the inbox ${config.inboxId}: ${describeThrow(cause)}. Nothing was sent`,
      ),
    };
  }
  if (answer.status < 200 || answer.status >= 300) {
    return {
      ok: false,
      code: codeForStatus(answer.status),
      message: scrub(
        `reading the inbox ${config.inboxId} answered HTTP ${String(answer.status)}: ${describeBody(answer.body)}. Nothing was sent`,
      ),
    };
  }
  const parsed = parseObject(answer.body);
  const address = addressOf(parsed, config.inboxId);
  return {
    ok: true,
    address,
    http_status: answer.status,
    permissions: disclosedPermissions(parsed),
  };
}

/**
 * The address an inbox sends as.
 *
 * AgentMail inbox ids are themselves addresses, so `inbox_id` is the fallback
 * and an explicit `address` field wins when the API returns one. This is the
 * only place that decision is made.
 */
function addressOf(inbox: Record<string, unknown> | null, inboxId: string): string {
  const address = inbox?.["address"];
  if (typeof address === "string" && address.length > 0) return address;
  const id = inbox?.["inbox_id"];
  if (typeof id === "string" && id.length > 0) return id;
  return inboxId;
}

/** Only the message; never the stack, which routinely quotes arguments. */
function describeThrow(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

function inboxPath(inboxId: string): string {
  return `/v0/inboxes/${encodeURIComponent(inboxId)}`;
}

// ---------------------------------------------------------------------------
// The payloads
// ---------------------------------------------------------------------------

/** The snapshot of a composed draft a grant binds to. */
export interface AgentmailDraftPayload {
  inbox_id: string;
  draft_id: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
}

/** Every key a draft payload may carry. Anything else is refused. */
const DRAFT_PAYLOAD_KEYS = [
  "inbox_id",
  "draft_id",
  "to",
  "cc",
  "bcc",
  "subject",
  "text",
] as const;

/** The fields the drift check covers: everything a reader of the draft saw. */
export const AGENTMAIL_DRAFT_FIELDS = ["to", "cc", "bcc", "subject", "text"] as const;

/** Keys that occur in one mode and not the other. The discriminator. */
const DRAFT_MARKERS = ["draft_id", "inbox_id", "text"] as const;
const DIRECT_MARKERS = ["from", "body", "content_type"] as const;

export type AgentmailMode = "direct" | "draft";

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export type AgentmailDraftValidation =
  | { ok: true; payload: AgentmailDraftPayload }
  | { ok: false; message: string };

/**
 * Structural validation of a draft payload. Never throws; returns the reason.
 *
 * Exported so a caller can check a payload BEFORE requesting approval for it,
 * which is the only place a shape error can still be fixed cheaply.
 */
export function validateAgentmailDraftPayload(value: JsonValue): AgentmailDraftValidation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, message: "the payload must be a JSON object" };
  }
  const record = value;
  const unknown = Object.keys(record).filter(
    (key) => !(DRAFT_PAYLOAD_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    return {
      ok: false,
      message: `the payload carries ${unknown.map((key) => JSON.stringify(key)).join(", ")}, which a draft send does not implement. An unknown key is refused rather than ignored: a human approved every byte of this payload. Supported keys: ${DRAFT_PAYLOAD_KEYS.join(", ")}`,
    };
  }

  for (const field of ["inbox_id", "draft_id", "subject", "text"] as const) {
    const held = record[field];
    if (typeof held !== "string") {
      return { ok: false, message: `${field} must be a string` };
    }
    if ((field === "inbox_id" || field === "draft_id") && held.length === 0) {
      return { ok: false, message: `${field} must be a non-empty string` };
    }
  }

  const to = record["to"];
  if (!isStringArray(to) || to.length === 0) {
    return { ok: false, message: "to must be a non-empty array of addresses" };
  }
  const lists: { cc?: string[]; bcc?: string[] } = {};
  for (const field of ["cc", "bcc"] as const) {
    const list = record[field];
    if (list === undefined) continue;
    if (!isStringArray(list)) {
      return { ok: false, message: `${field}, when present, must be an array of addresses` };
    }
    lists[field] = list;
  }

  return {
    ok: true,
    payload: {
      inbox_id: record["inbox_id"] as string,
      draft_id: record["draft_id"] as string,
      to,
      ...(lists.cc === undefined ? {} : { cc: lists.cc }),
      ...(lists.bcc === undefined ? {} : { bcc: lists.bcc }),
      subject: record["subject"] as string,
      text: record["text"] as string,
    },
  };
}

/**
 * Which mode a payload is in, by the markers it carries.
 *
 * A payload with markers of both modes is ambiguous and a payload with markers
 * of neither is not addressed to this adapter at all. Both are refused: a send
 * mode chosen by inference is a side effect chosen by inference.
 */
export function agentmailMode(
  value: JsonValue,
): { ok: true; mode: AgentmailMode } | { ok: false; code: AgentmailFailureCode; message: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      code: "agentmail-payload-invalid",
      message: "the payload must be a JSON object",
    };
  }
  const keys = new Set(Object.keys(value));
  const draft = DRAFT_MARKERS.filter((key) => keys.has(key));
  const direct = DIRECT_MARKERS.filter((key) => keys.has(key));
  if (draft.length > 0 && direct.length > 0) {
    return {
      ok: false,
      code: "agentmail-payload-ambiguous",
      message: `the payload carries keys of both send modes (${draft.join(", ")} from a draft send, ${direct.join(", ")} from a direct send). This adapter will not infer which side effect a human approved`,
    };
  }
  if (draft.length > 0) return { ok: true, mode: "draft" };
  if (direct.length > 0) return { ok: true, mode: "direct" };
  return {
    ok: false,
    code: "agentmail-payload-invalid",
    message: `the payload names neither a direct send (${DIRECT_MARKERS.join(", ")}) nor a draft send (${DRAFT_MARKERS.join(", ")})`,
  };
}

/**
 * The canonical form of one drift-checked field, RFC 8785.
 *
 * Absent and `null` are the same fact ("no cc") and so is an empty list, which
 * is the third spelling an API may use for it; anything else is compared
 * exactly, array order included, because a recipient list read in a different
 * order is a different message to the person reading it.
 */
function canonicalField(value: unknown): string {
  if (value === undefined || value === null) return canonicalize(null);
  if (Array.isArray(value) && value.length === 0) return canonicalize(null);
  return canonicalize(value);
}

/**
 * Which of {@link AGENTMAIL_DRAFT_FIELDS} differ between the approved snapshot
 * and what the server now holds. Names only — never values.
 */
export function draftDrift(
  approved: AgentmailDraftPayload,
  fetched: Record<string, unknown>,
): string[] {
  const snapshot: Record<string, unknown> = { ...approved };
  return AGENTMAIL_DRAFT_FIELDS.filter(
    (field) => canonicalField(snapshot[field]) !== canonicalField(fetched[field]),
  );
}

export type AgentmailDraftSnapshot =
  | { ok: true; payload: AgentmailDraftPayload }
  | { ok: false; message: string };

/**
 * The payload a grant should bind to, built from what the API holds RIGHT NOW
 * (APRV-223).
 *
 * `approval payload agentmail-draft` prints this and nothing else, and it lives
 * here rather than in the CLI for one reason: the bytes it prints are the bytes
 * {@link draftDrift} will compare against the same draft at send time, so the
 * two must be one piece of code. A second opinion in the CLI about what "the
 * draft's cc" is would be a snapshot that drifts from a draft nobody changed.
 *
 * The rules follow {@link canonicalField} exactly. `cc`/`bcc` are OMITTED when
 * the draft holds nothing for them, because absent, `null` and `[]` are one
 * fact there; `to` is copied through as the array it is, unnormalized, because
 * a reordered or re-shaped recipient list is a different message. Anything this
 * function cannot turn into a well-formed snapshot is refused with the reason:
 * a payload that fails {@link validateAgentmailDraftPayload} at send time is a
 * refusal a human has already been asked to approve.
 */
export function draftSnapshot(
  inboxId: string,
  draftId: string,
  fetched: Record<string, unknown>,
): AgentmailDraftSnapshot {
  const to = fetched["to"];
  if (!isStringArray(to) || to.length === 0) {
    return {
      ok: false,
      message:
        "the draft's `to` is not a non-empty array of addresses. A snapshot is taken from the draft as the API holds it, and this one could not be sent as it stands",
    };
  }
  const lists: { cc?: string[]; bcc?: string[] } = {};
  for (const field of ["cc", "bcc"] as const) {
    const held = fetched[field];
    if (held === undefined || held === null) continue;
    if (!isStringArray(held)) {
      return { ok: false, message: `the draft's \`${field}\`, when present, must be an array of addresses` };
    }
    // Empty is the same fact as absent for the drift check, so it is omitted
    // rather than carried: a snapshot with "cc":[] would hash differently from
    // an identical one taken by hand.
    if (held.length > 0) lists[field] = held;
  }
  for (const field of ["subject", "text"] as const) {
    if (typeof fetched[field] !== "string") {
      return {
        ok: false,
        message: `the draft's \`${field}\` is not a string, so there is nothing here for a human to approve`,
      };
    }
  }

  return {
    ok: true,
    payload: {
      inbox_id: inboxId,
      draft_id: draftId,
      to,
      ...(lists.cc === undefined ? {} : { cc: lists.cc }),
      ...(lists.bcc === undefined ? {} : { bcc: lists.bcc }),
      subject: fetched["subject"] as string,
      text: fetched["text"] as string,
    },
  };
}

/** Where `GET`ting one draft lives, so no caller spells the path twice. */
function draftPathFor(inboxId: string, draftId: string): string {
  return `${inboxPath(inboxId)}/drafts/${encodeURIComponent(draftId)}`;
}

export type AgentmailDraftRead =
  | { ok: true; draft: Record<string, unknown>; http_status: number }
  | { ok: false; code: AgentmailFailureCode; message: string };

export interface AgentmailDraftReadOptions extends AgentmailProbeOptions {
  /** The key that reads the draft. The AGENT's key here, not the vault's. */
  apiKey: string;
  inboxId: string;
  draftId: string;
}

/**
 * `GET /v0/inboxes/{inbox}/drafts/{draft}`: one draft, read and nothing else.
 *
 * The read half of the draft flow, exported for `approval payload
 * agentmail-draft` (APRV-223), which runs BEFORE any approval exists and with
 * the agent's own key rather than the vault's. It sends nothing and spends no
 * token: what it produces is a proposal a human has yet to see.
 */
export async function readAgentmailDraft(
  options: AgentmailDraftReadOptions,
): Promise<AgentmailDraftRead> {
  const transport: Transport = {
    fetch: options.fetch ?? (globalThis.fetch as unknown as AgentmailFetch),
    apiBase: (options.apiBase ?? AGENTMAIL_DEFAULT_API_BASE).replace(/\/+$/u, ""),
    timeoutMs: options.timeoutMs ?? AGENTMAIL_DEFAULT_TIMEOUT_MS,
    apiKey: options.apiKey,
  };
  const scrub = (text: string): string => redactSecrets(text, [options.apiKey]).text;

  let answer: HttpAnswer;
  try {
    answer = await call(transport, "GET", draftPathFor(options.inboxId, options.draftId));
  } catch (cause) {
    return {
      ok: false,
      code: "agentmail-unreachable",
      message: scrub(
        `the AgentMail API could not be reached to read the draft ${options.draftId}: ${describeThrow(cause)}`,
      ),
    };
  }
  if (answer.status === 404) {
    return {
      ok: false,
      code: "agentmail-draft-missing",
      message: `there is no draft ${options.draftId} in the inbox ${options.inboxId}`,
    };
  }
  if (answer.status < 200 || answer.status >= 300) {
    return {
      ok: false,
      code: codeForStatus(answer.status),
      message: scrub(
        `reading the draft ${options.draftId} answered HTTP ${String(answer.status)}: ${describeBody(answer.body)}`,
      ),
    };
  }
  const body = parseObject(answer.body);
  if (body === null) {
    return {
      ok: false,
      code: "agentmail-draft-drifted",
      message: `the draft ${options.draftId} did not read back as a JSON object, so no snapshot of it can be taken`,
    };
  }
  return { ok: true, draft: body, http_status: answer.status };
}

// ---------------------------------------------------------------------------
// The draft comparison, written once and performed twice (APRV-276)
// ---------------------------------------------------------------------------

/** A pre-send read: a throw is `agentmail-unreachable`, nothing attempted. */
async function preSendRead(
  transport: Transport,
  scrub: (text: string) => string,
  path: string,
  what: string,
): Promise<
  { ok: true; answer: HttpAnswer } | { ok: false; code: AgentmailFailureCode; message: string }
> {
  try {
    return { ok: true, answer: await call(transport, "GET", path) };
  } catch (cause) {
    return {
      ok: false,
      code: "agentmail-unreachable",
      message: scrub(
        `the AgentMail API could not be reached to read ${what}: ${describeThrow(cause)}. Nothing was sent`,
      ),
    };
  }
}

type AgentmailDraftCheck =
  | { ok: true; payload: AgentmailDraftPayload; draftPath: string }
  | { ok: false; code: AgentmailFailureCode; message: string };

/**
 * Everything that must hold before a draft send, up to but not including the
 * send: the payload's shape, the inbox it names, the draft's existence, and the
 * comparison of the approved snapshot against what the far side holds now.
 *
 * One function because it is performed twice, and the two calls answer two
 * different questions (APRV-276):
 *
 * - As {@link Adapter.precheck}, BEFORE the token is consumed. What it protects
 *   there is the grant: a draft the agent edited after the human read it is a
 *   refusal this runtime can reach without attempting anything, so it must not
 *   cost the human another tap. A refusal there appends nothing and spends
 *   nothing, and the same token sends once the approved text is restored.
 * - Inside `act`, in the consumed-token window, immediately before the POST.
 *   What it protects there is the bytes: AgentMail sends a draft by id, so the
 *   gap between the last read and the send can never be zero, and this is the
 *   check that makes it as small as the transport allows. A drift found here is
 *   an execution that started and failed, which is the honest record — the
 *   window was open and the far side moved inside it.
 *
 * Reads only, so calling it twice sends nothing twice. The message names WHICH
 * fields differ and never what they now hold, on both calls, for the reason the
 * module header gives.
 */
async function checkDraftBeforeSend(
  actionKey: string,
  value: JsonValue,
  config: AgentmailConfig,
  transport: Transport,
  scrub: (text: string) => string,
): Promise<AgentmailDraftCheck> {
  const validated = validateAgentmailDraftPayload(value);
  if (!validated.ok) {
    return {
      ok: false,
      code: "agentmail-payload-invalid",
      message: `the approved payload for ${actionKey} is not a well-formed draft send: ${validated.message}. Nothing was requested and nothing was sent`,
    };
  }
  const payload = validated.payload;

  // The inbox the payload names must be the inbox the vault configures.
  // Checked before any request: a payload naming another inbox is a wiring
  // mistake, and asking the far side about it would be asking it to arbitrate
  // whose mailbox this grant covers.
  if (payload.inbox_id !== config.inboxId) {
    return {
      ok: false,
      code: "agentmail-inbox-mismatch",
      message: `the approved draft names the inbox ${payload.inbox_id}, and this runtime is configured for ${config.inboxId}. Nothing was requested and nothing was sent`,
    };
  }

  const draftPath = draftPathFor(config.inboxId, payload.draft_id);
  const fetched = await preSendRead(transport, scrub, draftPath, `the draft ${payload.draft_id}`);
  if (!fetched.ok) return { ok: false, code: fetched.code, message: fetched.message };
  if (fetched.answer.status === 404) {
    return {
      ok: false,
      code: "agentmail-draft-missing",
      message: scrub(
        `the draft ${payload.draft_id} in inbox ${config.inboxId} no longer exists. A grant is over a snapshot of a draft, and the draft it named is gone; nothing was sent`,
      ),
    };
  }
  if (fetched.answer.status < 200 || fetched.answer.status >= 300) {
    return {
      ok: false,
      code: codeForStatus(fetched.answer.status),
      message: scrub(
        `reading the draft ${payload.draft_id} answered HTTP ${String(fetched.answer.status)}: ${describeBody(fetched.answer.body)}. Nothing was sent`,
      ),
    };
  }
  const body = parseObject(fetched.answer.body);
  if (body === null) {
    return {
      ok: false,
      code: "agentmail-draft-drifted",
      message: `the draft ${payload.draft_id} did not read back as a JSON object, so what the human approved cannot be compared with what would be sent. Nothing was sent`,
    };
  }

  // The drift check: the whole point of the mode. Field NAMES only.
  const drifted = draftDrift(payload, body);
  if (drifted.length > 0) {
    return {
      ok: false,
      code: "agentmail-draft-drifted",
      message: `the draft ${payload.draft_id} has changed since the snapshot a human approved: ${drifted.join(", ")} ${drifted.length === 1 ? "differs" : "differ"}. The differing content is deliberately not quoted here — it is unapproved text, and a refusal is not a channel for publishing it. Nothing was sent; re-request approval for the current draft`,
    };
  }

  return { ok: true, payload, draftPath };
}

// ---------------------------------------------------------------------------
// Observation (APRV-245): what the provider says this inbox actually sent
// ---------------------------------------------------------------------------

/**
 * How many messages one page asks for. The API's own cap is higher; this is the
 * page size, and {@link OBSERVE_MAX_PAGES} bounds how many pages are walked.
 */
export const AGENTMAIL_OBSERVE_PAGE_SIZE = 100;

/**
 * How many pages one observation walks.
 *
 * A bound rather than a full drain, because a reporting verb must terminate
 * against an inbox of any size. A run that hits the bound says so, so a reader
 * never mistakes a truncated page walk for a quiet mailbox.
 */
export const OBSERVE_MAX_PAGES = 10;

/** One sent message, reduced to what a coverage report may say out loud. */
export interface AgentmailObservedMessage {
  messageId: string;
  /** RFC 3339, as the provider reported it. */
  at: string;
  subject: string;
  recipients: number;
}

export type AgentmailObservation =
  | {
      ok: true;
      messages: AgentmailObservedMessage[];
      /** Set when the page bound stopped the walk before the far side ran out. */
      truncated: boolean;
    }
  | { ok: false; code: AgentmailFailureCode; message: string };

export interface AgentmailObserveOptions extends AgentmailProbeOptions {
  /** Override {@link AGENTMAIL_OBSERVE_PAGE_SIZE}. */
  pageSize?: number;
  /** Override {@link OBSERVE_MAX_PAGES}. */
  maxPages?: number;
}

/** The list of messages a page carries, under whichever key the body used. */
function messagesOf(body: Record<string, unknown> | null): Record<string, unknown>[] {
  if (body === null) return [];
  for (const key of ["messages", "data", "items"] as const) {
    const held = body[key];
    if (!Array.isArray(held)) continue;
    return held.filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null && !Array.isArray(entry),
    );
  }
  return [];
}

/** The next page token a body offers, or `null` when it offers none. */
function pageTokenOf(body: Record<string, unknown> | null): string | null {
  if (body === null) return null;
  for (const key of ["next_page_token", "page_token", "next_cursor"] as const) {
    const held = body[key];
    if (typeof held === "string" && held.length > 0) return held;
  }
  return null;
}

/** How many addresses a message went to, counting `to`, `cc` and `bcc`. */
function recipientCount(message: Record<string, unknown>): number {
  let count = 0;
  for (const key of ["to", "cc", "bcc"] as const) {
    const held = message[key];
    if (Array.isArray(held)) count += held.filter((entry) => typeof entry === "string").length;
    else if (typeof held === "string" && held.length > 0) count += 1;
  }
  return count;
}

/** Does this message's `labels` array carry `sent`? Case-insensitively. */
function isSent(message: Record<string, unknown>): boolean {
  const labels = message["labels"];
  if (!Array.isArray(labels)) return false;
  return labels.some((label) => typeof label === "string" && label.toLowerCase() === "sent");
}

/**
 * `GET /v0/inboxes/{inbox_id}/messages`: what this inbox actually sent.
 *
 * The endpoint and its fields are AgentMail's own, documented at
 * https://docs.agentmail.to/api-reference/inboxes/messages/list — `message_id`,
 * `labels`, `timestamp`, `to` and `subject`. The query carries `after`, `before`
 * and `limit`, and `page_token` on every page after the first.
 *
 * **The sent filter is client-side, and that is a limit worth stating.** The
 * documented list endpoint exposes no sent-only parameter, so this asks for the
 * window's messages and keeps the ones whose `labels` include `sent`. Two
 * consequences follow and neither is papered over: the request reads received
 * mail as well as sent (a read, changing nothing), and a provider that stopped
 * labelling sent mail would make this source report an empty window rather than
 * an error. The remedy for the second is the same as for everything else here:
 * the source reports what the provider said, and a source that says nothing is
 * a gap a reader can see rather than a pass.
 *
 * Sends nothing. Spends no token. Reads no clock: the window is the caller's.
 */
export async function observeAgentmail(
  config: AgentmailConfig,
  window: { since: string; until: string },
  options: AgentmailObserveOptions = {},
): Promise<AgentmailObservation> {
  const transport: Transport = {
    fetch: options.fetch ?? (globalThis.fetch as unknown as AgentmailFetch),
    apiBase: (options.apiBase ?? AGENTMAIL_DEFAULT_API_BASE).replace(/\/+$/u, ""),
    timeoutMs: options.timeoutMs ?? AGENTMAIL_DEFAULT_TIMEOUT_MS,
    apiKey: config.apiKey,
  };
  const scrub = (text: string): string => redactSecrets(text, [config.apiKey]).text;
  const pageSize = options.pageSize ?? AGENTMAIL_OBSERVE_PAGE_SIZE;
  const maxPages = options.maxPages ?? OBSERVE_MAX_PAGES;

  const messages: AgentmailObservedMessage[] = [];
  let token: string | null = null;
  let truncated = false;
  for (let page = 0; page < maxPages; page += 1) {
    const query = new URLSearchParams({
      after: window.since,
      before: window.until,
      limit: String(pageSize),
    });
    if (token !== null) query.set("page_token", token);
    const path = `${inboxPath(config.inboxId)}/messages?${query.toString()}`;

    let answer: HttpAnswer;
    try {
      answer = await call(transport, "GET", path);
    } catch (cause) {
      return {
        ok: false,
        code: "agentmail-unreachable",
        message: scrub(
          `the AgentMail API could not be reached to list the messages of ${config.inboxId}: ${describeThrow(cause)}. Nothing was sent and nothing was changed`,
        ),
      };
    }
    if (answer.status < 200 || answer.status >= 300) {
      return {
        ok: false,
        code: codeForStatus(answer.status),
        message: scrub(
          `listing the messages of ${config.inboxId} answered HTTP ${String(answer.status)}: ${describeBody(answer.body)}. Nothing was sent and nothing was changed`,
        ),
      };
    }

    const body = parseObject(answer.body);
    for (const message of messagesOf(body)) {
      if (!isSent(message)) continue;
      const id = message["message_id"];
      const at = message["timestamp"];
      if (typeof id !== "string" || id.length === 0) continue;
      const subject = message["subject"];
      messages.push({
        messageId: id,
        at: typeof at === "string" ? at : "",
        subject: typeof subject === "string" ? subject : "",
        recipients: recipientCount(message),
      });
    }

    token = pageTokenOf(body);
    if (token === null) break;
    if (page === maxPages - 1) truncated = true;
  }

  return { ok: true, messages, truncated };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface AgentmailAdapterOptions {
  /**
   * Additional classes this adapter serves, **added** to {@link AGENTMAIL_CLASS}
   * rather than replacing it: the class list is routing, and a list that
   * replaced the default would make "add one class" silently stop serving the
   * canonical one.
   */
  classes?: readonly string[];
  /** Injectable `fetch`, for tests. Defaults to the global. */
  fetch?: AgentmailFetch;
  /** API base. Defaults to {@link AGENTMAIL_DEFAULT_API_BASE}. */
  apiBase?: string;
  /** Per-request budget. Defaults to {@link AGENTMAIL_DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Override the vault names. Partial: unnamed entries keep their default. */
  credentialNames?: Partial<AgentmailCredentialNames>;
}

/** The body a direct send puts on the wire. */
function directBody(payload: {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  content_type?: string;
}): Record<string, JsonValue> {
  const html = payload.content_type === "text/html";
  return {
    to: payload.to,
    ...(payload.cc === undefined ? {} : { cc: payload.cc }),
    ...(payload.bcc === undefined ? {} : { bcc: payload.bcc }),
    subject: payload.subject,
    ...(html ? { html: payload.body } : { text: payload.body }),
  };
}

/** The success detail. Nothing secret, and nothing the log has not earned. */
function receipt(
  mode: AgentmailMode,
  answer: HttpAnswer,
  hash: string,
  recipients: number,
): JsonValue {
  const parsed = parseObject(answer.body);
  const messageId = parsed?.["message_id"];
  const threadId = parsed?.["thread_id"];
  return {
    mode,
    message_id: typeof messageId === "string" ? messageId : null,
    ...(typeof threadId === "string" ? { thread_id: threadId } : {}),
    payload_hash: hash,
    recipients,
    http_status: answer.status,
  };
}

/**
 * A fresh AgentMail adapter.
 *
 * Stateless and reusable: it holds no connection and nothing from a previous
 * send. Two concurrent executions through the same instance share nothing.
 */
export function agentmailAdapter(options: AgentmailAdapterOptions = {}): Adapter {
  const names: AgentmailCredentialNames = {
    ...DEFAULT_AGENTMAIL_CREDENTIAL_NAMES,
    ...options.credentialNames,
  };
  const classes = [
    AGENTMAIL_CLASS,
    ...(options.classes ?? []).filter((cls) => cls !== AGENTMAIL_CLASS),
  ];
  const apiBase = (options.apiBase ?? AGENTMAIL_DEFAULT_API_BASE).replace(/\/+$/u, "");
  const timeoutMs = options.timeoutMs ?? AGENTMAIL_DEFAULT_TIMEOUT_MS;

  /** The transport for one call, built in one place for both entry points. */
  const transportFor = (config: AgentmailConfig, signal: AbortSignal | undefined): Transport => ({
    fetch: options.fetch ?? (globalThis.fetch as unknown as AgentmailFetch),
    apiBase,
    timeoutMs,
    apiKey: config.apiKey,
    signal,
  });

  return {
    name: "agentmail",
    classes,
    requiredCredentials: requiredAgentmailCredentials(names),
    /**
     * What this inbox actually sent in `window` (APRV-245).
     *
     * Read-only and outside any grant window, as the contract requires. It
     * reads the vault through the provider the CALLER built — the same
     * `vaultCredentialProvider` `approval setup adapter agentmail` uses for its
     * probe, and never the `.approval/env` passphrase fallback, which is
     * defensible only inside a consumed-token window.
     *
     * The effect id is the provider's `message_id`. It is deliberately NOT
     * matched against the log: `execution.completed` records an `exit_code` and
     * the provider's id reaches only the CLI result, so an id-level binding
     * would need a schema amendment. That amendment is APRV-251; until it
     * lands, this source is joined by class and time window like every other,
     * and `docs/cli-reference.md` says so where a reader will see it.
     */
    async observe(
      window: ObservationWindow,
      credentials: CredentialProvider,
    ): Promise<readonly ObservedEffect[]> {
      const configured = readAgentmailConfig(credentials, names);
      const scrub = (text: string): string => redactSecrets(text, configured.secrets).text;
      if (!configured.ok) {
        // Already scrubbed with everything read before it failed. A throw
        // rather than an empty list, because "the vault would not open" and
        // "this inbox sent nothing" are different facts and the source layer
        // reports them differently.
        throw new Error(configured.message);
      }
      const observed = await observeAgentmail(configured.config, window, {
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        apiBase,
        timeoutMs,
      });
      if (!observed.ok) throw new Error(scrub(observed.message));
      return observed.messages.map((message) => ({
        source: "agentmail",
        id: message.messageId,
        class: AGENTMAIL_CLASS,
        at: message.at,
        actorHint: configured.config.inboxId,
        // The subject and a COUNT. Never the body, and never the addresses:
        // this line is read by somebody who did not approve the message.
        detail: scrub(
          `sent ${JSON.stringify(message.subject)} to ${String(message.recipients)} recipient(s)`,
        ),
      }));
    },
    /**
     * The draft comparison, run BEFORE the token is consumed (APRV-276).
     *
     * The bug this closes was found on a live inbox: the comparison used to run
     * only inside `act`, so a draft the agent had edited after the grant refused
     * `agentmail-draft-drifted` with `execution.started` and `execution.failed`
     * already on the log. The refusal was right and the accounting was wrong —
     * the single-use token was spent by an attempt that sent nothing, and
     * restoring the approved text could not send under the grant the human had
     * already given. A refusal that costs a human another tap teaches operators
     * to stop checking, which is the one lesson this project cannot afford to
     * teach.
     *
     * DRAFT MODE ONLY, and the asymmetry is the point. A draft is state the far
     * side holds and the agent can rewrite, so what a grant binds and what would
     * be sent can diverge with nobody at fault. A direct send has no such
     * object: its bytes are the payload, the payload hash binds them, and the
     * only pre-send refusal left is `agentmail-from-mismatch`, which is a fact
     * about the configured inbox rather than about anything that moved. That
     * check stays in `act`, where its inbox read doubles as the credential
     * check, and a direct send therefore costs no extra request here.
     *
     * Reads and compares; sends nothing. The API key comes from the vault
     * through the provider the contract scopes to this call, which is the same
     * sending key `act` uses: see SPEC.md §10.4 for why the comparison is not
     * performed with a key the caller supplies.
     */
    async precheck(input: PrecheckInput): Promise<PrecheckOutcome> {
      const mode = agentmailMode(input.payload);
      if (!mode.ok) {
        return {
          ok: false,
          code: mode.code,
          message: `the approved payload for ${input.actionKey} is not a well-formed AgentMail send: ${mode.message}. Nothing was requested and nothing was sent`,
        };
      }
      // Nothing server-side to compare, so nothing to spend a request on.
      if (mode.mode === "direct") return { ok: true };

      const configured = readAgentmailConfig(input.credentials, names);
      if (!configured.ok) {
        // Already scrubbed with everything that had been read when it failed.
        return { ok: false, code: configured.code, message: configured.message };
      }
      const config = configured.config;
      const scrub = (text: string): string => redactSecrets(text, configured.secrets).text;

      const checked = await checkDraftBeforeSend(
        input.actionKey,
        input.payload,
        config,
        transportFor(config, input.signal),
        scrub,
      );
      return checked.ok ? { ok: true } : { ok: false, code: checked.code, message: checked.message };
    },
    async act(input: ActInput): Promise<ActOutcome> {
      // (1) The mode, then the shape. Both refused before any credential is
      //     read: a malformed payload is not a reason to touch the vault.
      const mode = agentmailMode(input.payload);
      if (!mode.ok) {
        return {
          ok: false,
          code: mode.code,
          message: `the approved payload for ${input.actionKey} is not a well-formed AgentMail send: ${mode.message}. Nothing was requested and nothing was sent`,
        };
      }

      // (2) The configuration, from the vault, inside the window, through the
      //     one reader.
      const configured = readAgentmailConfig(input.credentials, names);
      const scrub = (text: string): string => redactSecrets(text, configured.secrets).text;
      if (!configured.ok) {
        // Already scrubbed with everything that had been read when it failed.
        return { ok: false, code: configured.code, message: configured.message };
      }
      const config = configured.config;
      const transport = transportFor(config, input.signal);
      const hash = payloadHash(input.payload);

      if (mode.mode === "direct") {
        const validated = validateEmailPayload(input.payload);
        if (!validated.ok) {
          return {
            ok: false,
            code: "agentmail-payload-invalid",
            message: `the approved payload for ${input.actionKey} is not a well-formed email: ${validated.message}. Nothing was requested and nothing was sent`,
          };
        }
        const payload = validated.payload;

        // (3) The inbox read. It answers the `from` question AND is the
        //     credential check; see the module header.
        const inbox = await preSendRead(
          transport,
          scrub,
          inboxPath(config.inboxId),
          `the inbox ${config.inboxId}`,
        );
        if (!inbox.ok) return { ok: false, code: inbox.code, message: inbox.message };
        if (inbox.answer.status < 200 || inbox.answer.status >= 300) {
          return {
            ok: false,
            code: codeForStatus(inbox.answer.status),
            message: scrub(
              `reading the inbox ${config.inboxId} answered HTTP ${String(inbox.answer.status)}: ${describeBody(inbox.answer.body)}. Nothing was sent`,
            ),
          };
        }
        const address = addressOf(parseObject(inbox.answer.body), config.inboxId);
        if (payload.from.toLowerCase() !== address.toLowerCase()) {
          return {
            ok: false,
            code: "agentmail-from-mismatch",
            message: scrub(
              `the approved message says it is from ${payload.from}, and the inbox ${config.inboxId} sends as ${address}. AgentMail has no per-message From — the inbox is the sender — so this message would have gone out under a different address than the one a human read. Nothing was sent`,
            ),
          };
        }

        // (4) The send. Deliberately NOT wrapped: a throw here means the
        //     request may have left the process, and the contract's
        //     execution.indeterminate is the honest record of that.
        const answer = await call(
          transport,
          "POST",
          `${inboxPath(config.inboxId)}/messages/send`,
          directBody(payload),
        );
        if (answer.status < 200 || answer.status >= 300) {
          return {
            ok: false,
            code: codeForStatus(answer.status),
            message: scrub(
              `the AgentMail send answered HTTP ${String(answer.status)}: ${describeBody(answer.body)}`,
            ),
          };
        }
        return {
          ok: true,
          detail: receipt("direct", answer, hash, envelopeRecipients(payload).length),
        };
      }

      // ---- draft mode --------------------------------------------------
      //
      // (3) and (4): the shape, the inbox, the draft read and the drift
      //     comparison, through the one function `precheck` also calls. This
      //     call is the one that binds the bytes: it runs inside the consumed-
      //     token window, immediately before the POST, so the gap between the
      //     comparison and the send is as small as the transport allows.
      const checked = await checkDraftBeforeSend(
        input.actionKey,
        input.payload,
        config,
        transport,
        scrub,
      );
      if (!checked.ok) return { ok: false, code: checked.code, message: checked.message };
      const payload = checked.payload;

      // (5) The send. Unwrapped, for the reason given in direct mode.
      const answer = await call(transport, "POST", `${checked.draftPath}/send`);
      if (answer.status < 200 || answer.status >= 300) {
        return {
          ok: false,
          code: codeForStatus(answer.status),
          message: scrub(
            `the AgentMail draft send answered HTTP ${String(answer.status)}: ${describeBody(answer.body)}`,
          ),
        };
      }
      const recipients =
        payload.to.length + (payload.cc?.length ?? 0) + (payload.bcc?.length ?? 0);
      return { ok: true, detail: receipt("draft", answer, hash, recipients) };
    },
  };
}
