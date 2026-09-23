/** Local synthetic Muse consumer facade. No native Muse protocol is claimed. */
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { buildPendingQueue, type ChannelTagRefusal } from "../channels/tagging.js";
import type { ChannelRequest } from "../channels/contract.js";
import { readGateRecords, register, registeredAction, request, type GateRefusal } from "../core/gate.js";
import { payloadHash } from "../core/payload.js";
import { loadPolicy } from "../core/policy-load.js";
import { requestState } from "../core/state.js";
import { canonicalRender } from "../core/wysiwys.js";

export interface MuseOptions {
  tenant: string;
  actor: string;
  root: string;
  log: string;
  readToken: string;
  proposeToken: string;
  port: number;
}

export const MUSE_TOKEN_MIN_LENGTH = 24;
const MAX_BODY = 64 * 1024;
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/u;

/** Facade-local refusals. Core gate/tagger codes pass through separately. */
export const MUSE_LOCAL_REFUSAL_CODES = [
  "unauthorized", "scope-forbidden", "unsupported-query", "not-found",
  "invalid-registration", "invalid-request", "invalid-lookup", "invalid-payload",
  "payload-mismatch", "not-awaiting", "policy-unavailable", "sensitive-payload",
  "body-too-large", "malformed-body", "internal-error",
] as const;
export type MuseLocalRefusalCode = (typeof MUSE_LOCAL_REFUSAL_CODES)[number];

class MuseBodyError extends Error {
  constructor(readonly code: "body-too-large" | "malformed-body") { super(code); }
}

export function validMuseOptions(o: MuseOptions): boolean {
  return KEY.test(o.tenant) && /^agent:[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/u.test(o.actor)
    && o.readToken.length >= MUSE_TOKEN_MIN_LENGTH && o.proposeToken.length >= MUSE_TOKEN_MIN_LENGTH
    && o.readToken !== o.proposeToken && Number.isInteger(o.port) && o.port >= 0 && o.port <= 65535;
}

function equalToken(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

function respond(res: ServerResponse, status: number, value: unknown): void {
  const bytes = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'",
    "x-content-type-options": "nosniff",
  });
  res.end(bytes);
}

function fail(res: ServerResponse, status: number, code: MuseLocalRefusalCode | GateRefusal["code"] | ChannelTagRefusal["code"]): void {
  respond(res, status, { ok: false, error: { code } });
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, fields: string[]): boolean {
  return Object.keys(value).every((name) => fields.includes(name));
}

async function body(req: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array);
    size += chunk.length;
    if (size > MAX_BODY) throw new MuseBodyError("body-too-large");
    parts.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown; }
  catch { throw new MuseBodyError("malformed-body"); }
}

/** No caller-supplied object may smuggle bearer values into a durable payload. */
function secretLike(value: unknown): boolean {
  if (typeof value === "string") return /(?:\bbearer\s+[A-Za-z0-9._~+/-]{12,}|\b(?:sk|ghp|xox[baprs])-\S{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/iu.test(value);
  if (Array.isArray(value)) return value.some(secretLike);
  if (object(value)) return Object.entries(value).some(([key, item]) =>
    /(?:secret|password|credential|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key)/iu.test(key) || secretLike(item));
  return false;
}

function sensitive(value: unknown, o: MuseOptions): boolean {
  if (secretLike(value)) return true;
  if (typeof value === "string") return value.includes(o.readToken) || value.includes(o.proposeToken);
  if (Array.isArray(value)) return value.some((item) => sensitive(item, o));
  if (object(value)) return Object.entries(value).some(([key, item]) =>
    key.includes(o.readToken) || key.includes(o.proposeToken) || sensitive(item, o));
  return false;
}

function safeRequest(item: ChannelRequest, detail: boolean): Record<string, unknown> {
  const canonical = item.fullPayload.value === null ? null : canonicalRender(item.fullPayload.value.value, item.class.value);
  const result: Record<string, unknown> = {
    task: item.task.value,
    action_key: item.action_key.value,
    class: item.class.value,
    autonomy: item.autonomy.value,
    state: item.state.value,
    payload_hash: item.payload_hash.value,
    display_hash: canonical?.display_hash ?? null,
    requested_ts: item.requested_ts.value,
    ttl_remaining_ms: item.ttl_remaining_ms.value,
    chain_seq: item.chain.value.seq,
    decision_channel: "telegram",
    telegram_delivery_observed: false,
    native_human_confirmation: false,
  };
  if (detail) {
    // A canonical block is returned only on the read scope, and only when the
    // verified payload store produced it. Never return claimed summaries or
    // free-form gate errors, which may echo caller-supplied sensitive text.
    result["canonical_rendering"] = canonical?.text ?? null;
  }
  return result;
}

function identity(req: IncomingMessage, o: MuseOptions): "read" | "propose" | null {
  let authorizationCount = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i]?.toLowerCase() === "authorization") authorizationCount += 1;
  }
  if (authorizationCount !== 1) return null;
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  const token = header.slice(7);
  if (equalToken(token, o.readToken)) return "read";
  if (equalToken(token, o.proposeToken)) return "propose";
  return null;
}

export function createMuseServer(o: MuseOptions): Server {
  if (!validMuseOptions(o)) throw new Error("invalid Muse launch configuration");
  return createServer((req, res) => {
    void (async () => {
      const role = identity(req, o);
      if (role === null) return fail(res, 401, "unauthorized");
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.search !== "" || url.hash !== "") return fail(res, 400, "unsupported-query");
      if (req.method === "GET" && url.pathname === "/v1/pending") {
        if (role !== "read") return fail(res, 403, "scope-forbidden");
        const queue = buildPendingQueue(o.log, { policy: { dir: o.root } }, new Date().toISOString());
        if (!queue.ok) return fail(res, 409, queue.code);
        const visible = queue.requests.filter((item) => !sensitive(item.fullPayload.value?.value, o));
        return respond(res, 200, { ok: true, tenant: o.tenant, requests: visible.map((item) => safeRequest(item, false)), skipped: [...queue.skipped.map((item) => ({ action_key: item.action_key, code: item.code })), ...queue.requests.filter((item) => sensitive(item.fullPayload.value?.value, o)).map((item) => ({ action_key: item.action_key.value, code: "sensitive-payload" }))] });
      }
      if (req.method === "POST" && url.pathname === "/v1/registrations") {
        if (role !== "propose") return fail(res, 403, "scope-forbidden");
        const input = await body(req);
        if (!object(input) || !exact(input, ["task", "envelope"]) || typeof input["task"] !== "string" || !KEY.test(input["task"]) || !object(input["envelope"]) || sensitive(input, o)) return fail(res, 400, "invalid-registration");
        const result = register(o.log, { task: input["task"], envelope: input["envelope"] }, o.actor);
        if (!result.ok) return fail(res, 409, result.code);
        return respond(res, 201, { ok: true, tenant: o.tenant, task: result.task, seq: result.record.seq });
      }
      if (req.method === "POST" && url.pathname === "/v1/requests") {
        if (role !== "propose") return fail(res, 403, "scope-forbidden");
        const input = await body(req);
        if (!object(input) || !exact(input, ["task", "action_key", "payload"]) || typeof input["task"] !== "string" || !KEY.test(input["task"]) || typeof input["action_key"] !== "string" || !KEY.test(input["action_key"]) || !("payload" in input) || sensitive(input["payload"], o)) return fail(res, 400, "invalid-request");
        let hash: string;
        try { hash = payloadHash(input["payload"]); } catch { return fail(res, 400, "invalid-payload"); }
        const read = readGateRecords(o.log);
        if (!read.ok) return fail(res, 409, read.code);
        const declared = registeredAction(read.records, input["task"], input["action_key"]);
        if (!declared.ok) return fail(res, 409, declared.code);
        if (declared.action.payload_hash !== hash) return fail(res, 409, "payload-mismatch");
        const result = request(o.log, {
          task: input["task"], actionKey: input["action_key"], cls: declared.action.class,
          ...(declared.action.est_cost_usd === undefined ? {} : { est_cost_usd: declared.action.est_cost_usd }),
          ...(declared.action.reversible === undefined ? {} : { reversible: declared.action.reversible }),
          ...(declared.action.summary === undefined ? {} : { summary: declared.action.summary }),
          payload: { value: input["payload"] },
        }, o.actor, { policy: { dir: o.root } });
        if (!result.ok) return fail(res, 409, result.code);
        return respond(res, 200, { ok: true, tenant: o.tenant, task: input["task"], action_key: input["action_key"], payload_hash: hash, autonomy: result.autonomy, requested: result.record !== null, seq: result.record?.seq ?? null, decision_channel: "telegram", telegram_delivery_observed: false, native_human_confirmation: false });
      }
      if (req.method === "POST" && (url.pathname === "/v1/status" || url.pathname === "/v1/request-detail")) {
        if (role !== "read") return fail(res, 403, "scope-forbidden");
        const input = await body(req);
        if (!object(input) || !exact(input, ["task", "action_key"]) || typeof input["task"] !== "string" || !KEY.test(input["task"]) || typeof input["action_key"] !== "string" || !KEY.test(input["action_key"])) return fail(res, 400, "invalid-lookup");
        const read = readGateRecords(o.log);
        if (!read.ok) return fail(res, 409, read.code);
        const declared = registeredAction(read.records, input["task"], input["action_key"]);
        if (!declared.ok) return fail(res, 404, "not-found");
        const load = loadPolicy({ dir: o.root });
        if (!load.ok) return fail(res, 409, "policy-unavailable");
        const state = requestState(read.records, input["action_key"], new Date().toISOString(), load.ok ? load.durations.approvalTtlMs : null);
        if (url.pathname === "/v1/status") return respond(res, 200, { ok: true, tenant: o.tenant, task: input["task"], action_key: input["action_key"], payload_hash: declared.action.payload_hash ?? null, state: state.state, decision_channel: "telegram", telegram_delivery_observed: false });
        const queue = buildPendingQueue(o.log, { policy: { dir: o.root } }, new Date().toISOString());
        if (!queue.ok) return fail(res, 409, queue.code);
        const item = queue.requests.find((entry) => entry.task.value === input["task"] && entry.action_key.value === input["action_key"]);
        if (item === undefined) return fail(res, 409, "not-awaiting");
        if (sensitive(item.fullPayload.value?.value, o)) return fail(res, 409, "sensitive-payload");
        return respond(res, 200, { ok: true, tenant: o.tenant, request: safeRequest(item, true) });
      }
      return fail(res, 404, "not-found");
    })().catch((cause: unknown) => {
      if (res.headersSent) return;
      if (cause instanceof MuseBodyError) return fail(res, cause.code === "body-too-large" ? 413 : 400, cause.code);
      return fail(res, 500, "internal-error");
    });
  });
}
