/**
 * Credential-custody transport for zzz.bot messages (APRV-320).
 *
 * The adapter sends only the JSON value a grant binds. Destination selection
 * is a strict tagged union over two fixed service origins; neither the CLI nor
 * the payload can supply an arbitrary URL. The Bearer credential comes only
 * from the scoped provider opened by the shared adapter contract.
 */

import { createHash } from "node:crypto";

import type { CredentialSpec } from "../core/credential-spec.js";
import { canonicalize } from "../core/jcs.js";
import { payloadHash } from "../core/payload.js";
import {
  CREDENTIAL_REFUSAL_CODES,
  PROVIDER_REF_DETAIL_KEY,
  type ActInput,
  type ActOutcome,
  type Adapter,
  type JsonValue,
  type PrecheckInput,
  type PrecheckOutcome,
} from "./contract.js";

export const ZZZ_CLASS = "communicate.zzz.external";
export const ZZZ_PRODUCTION_API_BASE = "https://zzz.bot";
export const ZZZ_PREVIEW_API_BASE = "https://zzz-preview.soycarts.workers.dev";
export const ZZZ_DEFAULT_TIMEOUT_MS = 15_000;
export const ZZZ_TOKEN_NAME = "zzz.agent_token";

const TOKEN = /^[A-Za-z0-9_-]{32,256}$/u;
const PROVIDER_ID = /^(?:thr|pst)_[a-f0-9]{32}$/u;
const MAX_MESSAGE_BYTES = 65_536;
const MAX_RESPONSE_BYTES = 16_384;

export const ZZZ_FAILURE_CODES = [
  "zzz-payload-invalid",
  "zzz-config-invalid",
  "zzz-invalid-request",
  "zzz-unauthorized",
  "zzz-forbidden",
  "zzz-not-found",
  "zzz-idempotency-conflict",
  "zzz-payload-too-large",
  "zzz-rejected",
  "zzz-rate-limited",
  "zzz-unreachable",
  "zzz-cancelled",
  ...CREDENTIAL_REFUSAL_CODES,
] as const;

export const ZZZ_CREDENTIAL_SPECS: readonly CredentialSpec[] = [
  {
    name: ZZZ_TOKEN_NAME,
    kind: "secret",
    label: "ZZZ agent token",
    describe: "an invited zzz.bot principal credential with write scope",
    required: true,
    validate(value: string) {
      return TOKEN.test(value)
        ? { ok: true }
        : {
            ok: false,
            message:
              "the ZZZ agent token must be 32 to 256 ASCII letters, digits, underscores, or hyphens",
          };
    },
  },
];

type Reference = {
  kind: "external" | "post";
  target: string;
  label: string;
  relationship: "source" | "context" | "supersedes";
};

type Message = {
  body: string;
  metadata?: JsonValue;
  tags?: string[];
  references?: Reference[];
};

export type ZzzPayload =
  | ({ environment: "production" | "preview"; operation: "create_thread"; room_id: string; title: string } & Message)
  | ({ environment: "production" | "preview"; operation: "create_reply"; thread_id: string } & Message);

type Validation =
  | { ok: true; payload: ZzzPayload; path: string; body: Record<string, JsonValue> }
  | { ok: false; message: string };

function object(value: JsonValue): Record<string, JsonValue> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : null;
}

function exactKeys(value: Record<string, JsonValue>, allowed: readonly string[]): string | null {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  return extra === undefined ? null : extra;
}

function boundedString(value: JsonValue | undefined, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function validReferences(value: JsonValue | undefined): value is Reference[] {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 20) return false;
  return value.every((candidate) => {
    const ref = object(candidate);
    if (ref === null || exactKeys(ref, ["kind", "target", "label", "relationship"]) !== null) return false;
    if (!boundedString(ref["target"], 1, 2048) || !boundedString(ref["label"], 1, 120)) return false;
    if (ref["kind"] !== "external" && ref["kind"] !== "post") return false;
    if (!["source", "context", "supersedes"].includes(String(ref["relationship"]))) return false;
    if (ref["kind"] === "external") {
      try {
        const url = new URL(ref["target"]);
        if (url.protocol !== "http:" && url.protocol !== "https:") return false;
      } catch {
        return false;
      }
    }
    return true;
  });
}

export function validateZzzPayload(value: JsonValue): Validation {
  const input = object(value);
  if (input === null) return { ok: false, message: "the payload must be one JSON object" };
  if (input["environment"] !== "production" && input["environment"] !== "preview") {
    return { ok: false, message: "environment must be production or preview" };
  }
  if (input["operation"] !== "create_thread" && input["operation"] !== "create_reply") {
    return { ok: false, message: "operation must be create_thread or create_reply" };
  }
  const common = ["environment", "operation", "body", "metadata", "tags", "references"];
  const allowed = input["operation"] === "create_thread"
    ? [...common, "room_id", "title"]
    : [...common, "thread_id"];
  const extra = exactKeys(input, allowed);
  if (extra !== null) return { ok: false, message: `unknown payload field ${JSON.stringify(extra)}` };
  if (!boundedString(input["body"], 1, 65_536)) return { ok: false, message: "body must contain 1 to 65536 characters" };
  if (input["tags"] !== undefined &&
      (!Array.isArray(input["tags"]) || input["tags"].length > 10 ||
       !input["tags"].every((tag) => boundedString(tag, 1, 40)))) {
    return { ok: false, message: "tags must contain at most 10 strings of 1 to 40 characters" };
  }
  if (!validReferences(input["references"])) return { ok: false, message: "references do not match the ZZZ API contract" };

  let path: string;
  if (input["operation"] === "create_thread") {
    if (!boundedString(input["room_id"], 1, 256) || !boundedString(input["title"], 1, 200)) {
      return { ok: false, message: "create_thread needs a room_id and a title of 1 to 200 characters" };
    }
    path = `/api/v1/rooms/${encodeURIComponent(input["room_id"])}/threads`;
  } else {
    if (!boundedString(input["thread_id"], 1, 256)) return { ok: false, message: "create_reply needs a thread_id" };
    path = `/api/v1/threads/${encodeURIComponent(input["thread_id"])}/posts`;
  }

  const body: Record<string, JsonValue> = {
    ...(input["operation"] === "create_thread" ? { title: input["title"] } : {}),
    body: input["body"],
    ...(input["metadata"] === undefined ? {} : { metadata: input["metadata"] }),
    ...(input["tags"] === undefined ? {} : { tags: input["tags"] }),
    ...(input["references"] === undefined ? {} : { references: input["references"] }),
  };
  if (new TextEncoder().encode(canonicalize(body)).byteLength > MAX_MESSAGE_BYTES) {
    return { ok: false, message: "the canonical ZZZ message exceeds 65536 UTF-8 bytes" };
  }
  return { ok: true, payload: input as ZzzPayload, path, body };
}

function idempotencyKey(actionKey: string, hash: string): string {
  const bytes = canonicalize({ action_key: actionKey, payload_hash: hash });
  return `approval:${createHash("sha256").update(bytes, "utf8").digest("hex")}`;
}

function codeForStatus(status: number): string {
  if (status === 400) return "zzz-invalid-request";
  if (status === 401) return "zzz-unauthorized";
  if (status === 403) return "zzz-forbidden";
  if (status === 404) return "zzz-not-found";
  if (status === 409) return "zzz-idempotency-conflict";
  if (status === 413) return "zzz-payload-too-large";
  if (status === 422) return "zzz-rejected";
  if (status === 429) return "zzz-rate-limited";
  return "zzz-rejected";
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("ZZZ returned no response body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("ZZZ returned an oversized response");
    }
    chunks.push(item.value);
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(joined)) as unknown;
}

export interface ZzzAdapterOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Constructor-only test seam. The CLI never exposes these values. */
  origins?: Partial<Record<"production" | "preview", string>>;
}

function originFor(environment: "production" | "preview", options: ZzzAdapterOptions): string {
  return options.origins?.[environment] ??
    (environment === "production" ? ZZZ_PRODUCTION_API_BASE : ZZZ_PREVIEW_API_BASE);
}

export function zzzAdapter(options: ZzzAdapterOptions = {}): Adapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? ZZZ_DEFAULT_TIMEOUT_MS;
  return {
    name: "zzz",
    classes: [ZZZ_CLASS],
    requiredCredentials: [ZZZ_TOKEN_NAME],
    precheck(input: PrecheckInput): PrecheckOutcome {
      const checked = validateZzzPayload(input.payload);
      return checked.ok
        ? { ok: true }
        : { ok: false, code: "zzz-payload-invalid", message: `${checked.message}. Nothing was sent` };
    },
    async act(input: ActInput): Promise<ActOutcome> {
      const checked = validateZzzPayload(input.payload);
      if (!checked.ok) return { ok: false, code: "zzz-payload-invalid", message: `${checked.message}. Nothing was sent` };
      const credential = input.credentials.get(ZZZ_TOKEN_NAME);
      if (!credential.ok) return { ok: false, code: credential.code, message: credential.message };
      if (!TOKEN.test(credential.value)) {
        return { ok: false, code: "zzz-config-invalid", message: "the vault's ZZZ agent token does not match the service credential shape. Nothing was sent" };
      }
      if (input.signal?.aborted === true) {
        return { ok: false, code: "zzz-cancelled", message: "the ZZZ message was cancelled before the HTTP request. Nothing was sent" };
      }
      const environment = checked.payload.environment;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const abort = (): void => controller.abort();
      input.signal?.addEventListener("abort", abort, { once: true });
      try {
        const response = await fetchImpl(new URL(checked.path, originFor(environment, options)), {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${credential.value}`,
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey(input.actionKey, payloadHash(input.payload)),
          },
          body: canonicalize(checked.body),
        });
        const definiteRefusal = [400, 401, 403, 404, 409, 413, 422, 429].includes(response.status);
        if (response.status !== 200 && response.status !== 201 && !definiteRefusal) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error(`ZZZ answered an ambiguous HTTP status ${String(response.status)}`);
        }
        if (definiteRefusal) {
          await response.body?.cancel().catch(() => undefined);
          return { ok: false, code: codeForStatus(response.status), message: `ZZZ refused the message with HTTP ${String(response.status)}. No response text was recorded` };
        }
        const answer = await boundedJson(response);
        const parsed = object(answer as JsonValue);
        const expectedPrefix = checked.payload.operation === "create_thread" ? "thr_" : "pst_";
        if (parsed === null || exactKeys(parsed, ["id", "replayed"]) !== null ||
            typeof parsed["id"] !== "string" || !PROVIDER_ID.test(parsed["id"]) ||
            !parsed["id"].startsWith(expectedPrefix) || typeof parsed["replayed"] !== "boolean" ||
            parsed["replayed"] !== (response.status === 200)) {
          throw new Error("ZZZ returned an inconsistent success receipt");
        }
        return {
          ok: true,
          detail: {
            [PROVIDER_REF_DETAIL_KEY]: parsed["id"],
            replayed: parsed["replayed"],
            operation: checked.payload.operation,
            payload_hash: payloadHash(input.payload),
          },
        };
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", abort);
      }
    },
  };
}

export type ZzzProbeResult = { ok: true } | { ok: false; code: string; message: string };

/** Read-only authentication probe. It proves no write scope or room access. */
export async function probeZzz(token: string, options: ZzzAdapterOptions = {}): Promise<ZzzProbeResult> {
  if (!TOKEN.test(token)) return { ok: false, code: "zzz-config-invalid", message: "the ZZZ agent token does not match the service credential shape" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? ZZZ_DEFAULT_TIMEOUT_MS);
  try {
    const response = await (options.fetch ?? globalThis.fetch)(new URL("/api/v1/rooms", originFor("production", options)), {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}` },
    });
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 200) return { ok: true };
    return { ok: false, code: codeForStatus(response.status), message: `ZZZ answered HTTP ${String(response.status)}; no response text was recorded` };
  } catch {
    return { ok: false, code: "zzz-unreachable", message: "ZZZ could not be reached for the read-only credential check" };
  } finally {
    clearTimeout(timer);
  }
}
