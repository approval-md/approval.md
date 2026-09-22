import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { main } from "../src/cli/main.js";
import { createMuseServer, MUSE_LOCAL_REFUSAL_CODES, type MuseOptions } from "../src/muse/server.js";
import { payloadHash } from "../src/core/payload.js";
import { verify } from "../src/core/verify.js";
import { buildPendingQueue } from "../src/channels/tagging.js";
import { recordChannelDecision } from "../src/channels/contract.js";
import { TelegramChannel } from "../src/channels/telegram.js";
import { assertLocal, callbackUpdate, startMockBotApi } from "./telegram-mock.js";

const scratch = mkdtempSync(join(tmpdir(), "approval-muse-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const policy = ["```yaml approval-policy", 'version: "0.1"', "defaults:", "  autonomy: manual", '  approval_ttl: "1h"', "  on_expiry: reject", "```", ""].join("\n");
const payload = { to: "reviewer@example.test", message: "Please review the release." };

test("Muse facade-local refusal vocabulary is frozen", () => {
  assert.deepEqual(MUSE_LOCAL_REFUSAL_CODES, [
    "unauthorized", "scope-forbidden", "unsupported-query", "not-found",
    "invalid-registration", "invalid-request", "invalid-lookup", "invalid-payload",
    "payload-mismatch", "not-awaiting", "policy-unavailable", "sensitive-payload",
    "body-too-large", "malformed-body", "internal-error",
  ]);
});

async function fixture(tenant: string, ttl = "1h"): Promise<{ options: MuseOptions; close: () => Promise<void>; base: string }> {
  const root = join(scratch, tenant);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "APPROVAL.md"), policy.replace('approval_ttl: "1h"', `approval_ttl: "${ttl}"`));
  const code = await main(["policy", "attest", "--as", "human:test"], { cwd: root, streams: { out: () => undefined, err: () => undefined } });
  assert.equal(code, 0);
  const options: MuseOptions = { tenant, actor: `agent:muse:${tenant}`, root, log: join(root, ".approval/log/events.jsonl"), readToken: `${tenant}-read-token-long-enough-000`, proposeToken: `${tenant}-propose-token-long-enough-000`, port: 0 };
  const server = createMuseServer(options);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { options, base: `http://127.0.0.1:${String(address.port)}`, close: () => new Promise<void>((done) => server.close(() => done())) };
}

async function call(base: string, path: string, token: string, data?: unknown): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
  const response = await fetch(`${base}${path}`, { method: data === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, ...(data === undefined ? {} : { "content-type": "application/json" }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const raw = await response.text();
  return { status: response.status, body: JSON.parse(raw) as Record<string, unknown>, raw };
}

test("local synthetic Muse facade isolates tenants and scopes; Telegram alone decides", async () => {
  const a = await fixture("tenant-a");
  const b = await fixture("tenant-b");
  try {
    const envelope = { origin: { app: "muse-local", created_by: "agent:muse:tenant-a" }, state: "proposed", actions: [{ class: "communicate.email.external", summary: "Review release", reversible: false, est_cost_usd: "0", idempotency_key: "task-a:send", payload_hash: payloadHash(payload) }] };
    const unauthorized = await call(a.base, "/v1/pending", "wrong-token");
    assert.equal(unauthorized.status, 401);
    assert.equal((await call(a.base, "/v1/pending", a.options.proposeToken)).status, 403);
    assert.equal((await call(a.base, "/v1/registrations", a.options.readToken, { task: "task-a", envelope })).status, 403);
    assert.equal((await call(a.base, "/v1/registrations", b.options.proposeToken, { task: "task-a", envelope })).status, 401);
    assert.equal((await call(a.base, "/v1/registrations", a.options.proposeToken, { task: "task-a", envelope })).status, 201);
    assert.equal((await call(a.base, "/v1/registrations", a.options.proposeToken, { task: "task-a", envelope })).status, 409);
    assert.equal((await call(a.base, "/v1/requests", a.options.proposeToken, { task: "task-a", action_key: "task-a:send", payload: { ...payload, message: "tampered" } })).status, 409);
    const request = await call(a.base, "/v1/requests", a.options.proposeToken, { task: "task-a", action_key: "task-a:send", payload });
    assert.equal(request.status, 200, request.raw);
    assert.equal(request.body["requested"], true);
    assert.equal((await call(a.base, "/v1/requests", a.options.proposeToken, { task: "task-a", action_key: "task-a:send", payload })).status, 409);
    const detail = await call(a.base, "/v1/request-detail", a.options.readToken, { task: "task-a", action_key: "task-a:send" });
    assert.equal(detail.status, 200, detail.raw);
    const item = (detail.body["request"] ?? {}) as Record<string, unknown>;
    assert.match(String(item["canonical_rendering"]), /Please review the release/);
    assert.equal(item["decision_channel"], "telegram");
    assert.equal(item["native_human_confirmation"], false);
    assert.equal(item["telegram_delivery_observed"], false);
    const status = await call(a.base, "/v1/status", a.options.readToken, { task: "task-a", action_key: "task-a:send" });
    assert.equal(status.body["state"], "requested");
    assert.equal(status.body["payload_hash"], payloadHash(payload));
    assert.equal((await call(b.base, "/v1/pending", b.options.readToken)).status, 200);
    assert.equal((await call(b.base, "/v1/status", b.options.readToken, { task: "task-a", action_key: "task-a:send" })).status, 404);
    for (const route of ["/v1/grant", "/v1/reject", "/v1/execute", "/v1/export", "/verbs", "/v1/requests/task-a:send"]) {
      assert.equal((await call(a.base, route, a.options.proposeToken, {})).status, 404);
    }
    assert.equal(verify(a.options.log).status, "clean");
    assert.equal(verify(b.options.log).status, "clean");
  } finally { await a.close(); await b.close(); }
});

test("expired request is derived from verified log and leaves the inbox", async () => {
  const a = await fixture("tenant-expiry", "1ms");
  try {
    const envelope = { origin: { app: "muse-local", created_by: "agent:muse:tenant-expiry" }, state: "proposed", actions: [{ class: "communicate.email.external", summary: "Review release", reversible: false, est_cost_usd: "0", idempotency_key: "task-expiry:send", payload_hash: payloadHash(payload) }] };
    assert.equal((await call(a.base, "/v1/registrations", a.options.proposeToken, { task: "task-expiry", envelope })).status, 201);
    assert.equal((await call(a.base, "/v1/requests", a.options.proposeToken, { task: "task-expiry", action_key: "task-expiry:send", payload })).status, 200);
    await new Promise((done) => setTimeout(done, 15));
    const status = await call(a.base, "/v1/status", a.options.readToken, { task: "task-expiry", action_key: "task-expiry:send" });
    assert.equal(status.body["state"], "expired");
    const pending = await call(a.base, "/v1/pending", a.options.readToken);
    assert.deepEqual(pending.body["requests"], []);
    assert.equal((await call(a.base, "/v1/request-detail", a.options.readToken, { task: "task-expiry", action_key: "task-expiry:send" })).status, 409);
  } finally { await a.close(); }
});

test("policy drift after registration refuses request intake without appending a request or grant", async () => {
  const a = await fixture("tenant-policy-drift");
  try {
    const key = "task-policy-drift:send";
    const envelope = { origin: { app: "muse-local", created_by: "agent:muse:tenant-policy-drift" }, state: "proposed", actions: [{ class: "communicate.email.external", summary: "Review release", reversible: false, est_cost_usd: "0", idempotency_key: key, payload_hash: payloadHash(payload) }] };
    assert.equal((await call(a.base, "/v1/registrations", a.options.proposeToken, { task: "task-policy-drift", envelope })).status, 201);
    const before = readFileSync(a.options.log, "utf8");

    writeFileSync(join(a.options.root, "APPROVAL.md"), policy.replace('approval_ttl: "1h"', 'approval_ttl: "2h"'));
    const response = await call(a.base, "/v1/requests", a.options.proposeToken, { task: "task-policy-drift", action_key: key, payload });

    assert.equal(response.status, 409, response.raw);
    assert.deepEqual(response.body, { ok: false, error: { code: "policy-not-attested" } });
    assert.equal(readFileSync(a.options.log, "utf8"), before);
    assert.doesNotMatch(before, /"event":"approval\.requested"|"event":"approval\.granted"/u);
    assert.equal(verify(a.options.log).status, "clean");
  } finally { await a.close(); }
});

test("tampering and secret-like material are refused without echo", async () => {
  const a = await fixture("tenant-negative");
  try {
    const bad = await call(a.base, "/v1/requests", a.options.proposeToken, { task: "x", action_key: "x:1", payload: { api_key: "DO-NOT-PRINT-ME" } });
    assert.equal(bad.status, 400);
    assert.doesNotMatch(bad.raw, /DO-NOT-PRINT-ME/);
    const identity = await call(a.base, "/v1/registrations", a.options.proposeToken, { task: "x", envelope: {}, actor: "human:test" });
    assert.equal(identity.status, 400);
    assert.equal((await call(a.base, "/v1/status", a.options.readToken, { task: "x", action_key: "x:1", tenant: "tenant-a" })).status, 400);
    assert.equal((await call(a.base, "/v1/grant", a.options.readToken, { action_key: "x:1" })).status, 404);
    const malformed = await fetch(`${a.base}/v1/registrations`, { method: "POST", headers: { authorization: `Bearer ${a.options.proposeToken}` }, body: "{" });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { ok: false, error: { code: "malformed-body" } });
    const large = await fetch(`${a.base}/v1/registrations`, { method: "POST", headers: { authorization: `Bearer ${a.options.proposeToken}` }, body: "x".repeat(65 * 1024) });
    assert.equal(large.status, 413);
    assert.deepEqual(await large.json(), { ok: false, error: { code: "body-too-large" } });
    const raw = readFileSync(a.options.log, "utf8");
    assert.doesNotMatch(raw, /DO-NOT-PRINT-ME/);
  } finally { await a.close(); }
});

test("a quote-containing proposal credential cannot hide in escaped JSON and enter the log", async () => {
  const fixtureInstance = await fixture("tenant-quoted-credential");
  const quoteToken = 'proposal"credential-long-enough-000';
  const options = { ...fixtureInstance.options, proposeToken: quoteToken };
  const server = createMuseServer(options);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const base = `http://127.0.0.1:${String(address.port)}`;
    const envelope = { origin: { app: "muse-local", created_by: options.actor }, state: "proposed", actions: [{ class: "communicate.email.external", summary: quoteToken, reversible: false, est_cost_usd: "0", idempotency_key: "task-quoted:send", payload_hash: payloadHash(payload) }] };
    const response = await call(base, "/v1/registrations", quoteToken, { task: "task-quoted", envelope });
    assert.equal(response.status, 400);
    assert.doesNotMatch(response.raw, /proposal/);
    const log = readFileSync(options.log, "utf8");
    assert.equal(log.includes(quoteToken), false);
    assert.equal(log.includes(JSON.stringify(quoteToken).slice(1, -1)), false);
    assert.equal(verify(options.log).status, "clean");
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await fixtureInstance.close();
  }
});

test("synthetic Telegram callback decides a facade request; replay and altered callbacks add no grant", async () => {
  const a = await fixture("tenant-telegram");
  const mock = await startMockBotApi("7654321:AA-local-muse-test-token-DO-NOT-USE");
  try {
    const key = "task-telegram:send";
    const envelope = { origin: { app: "muse-local", created_by: "agent:muse:tenant-telegram" }, state: "proposed", actions: [{ class: "communicate.email.external", summary: "Review release", reversible: false, est_cost_usd: "0", idempotency_key: key, payload_hash: payloadHash(payload) }] };
    assert.equal((await call(a.base, "/v1/registrations", a.options.proposeToken, { task: "task-telegram", envelope })).status, 201);
    assert.equal((await call(a.base, "/v1/requests", a.options.proposeToken, { task: "task-telegram", action_key: key, payload })).status, 200);
    const pending = buildPendingQueue(a.options.log, { policy: { dir: a.options.root } }, new Date().toISOString());
    assert.equal(pending.ok, true);
    if (!pending.ok) return;
    const request = pending.requests.find((entry) => entry.action_key.value === key);
    assert.ok(request);
    const channel = new TelegramChannel({ token: "7654321:AA-local-muse-test-token-DO-NOT-USE", chatId: "9911", apiBase: assertLocal(mock.url), pollTimeoutSeconds: 0, requestTimeoutMs: 3000, backoffMs: 5, maxBackoffMs: 20, log: () => undefined });
    channel.onDecision((decision) => recordChannelDecision(a.options.log, decision, { actor: "human:test", channel: "telegram" }, { policy: { dir: a.options.root } }).outcome);
    await channel.notify(request);
    const callback = mock.callbackDataFor(key, "grant");
    mock.queueUpdate(callbackUpdate({ data: callback, chatId: "9911" }));
    const first = await channel.pollOnce();
    assert.equal(first.outcomes.find((entry) => entry.action_key === key)?.outcome.ok, true);
    assert.equal((await call(a.base, "/v1/status", a.options.readToken, { task: "task-telegram", action_key: key })).body["state"], "granted");
    const grants = () => readFileSync(a.options.log, "utf8").split("\n").filter((line) => line.includes('"event":"approval.granted"')).length;
    assert.equal(grants(), 1);
    mock.queueUpdate(callbackUpdate({ data: callback, chatId: "9911" }));
    await channel.pollOnce();
    mock.queueUpdate(callbackUpdate({ data: "g:nosuchnonce", chatId: "9911" }));
    await channel.pollOnce();
    assert.equal(grants(), 1);
    assert.equal((await call(a.base, "/v1/request-detail", a.options.readToken, { task: "task-telegram", action_key: key })).status, 409);
    assert.equal(verify(a.options.log).status, "clean");
  } finally { await mock.close(); await a.close(); }
});

test("synthetic Telegram callback after expiry cannot decide a facade request", async () => {
  const a = await fixture("tenant-expired-telegram", "1s");
  const mock = await startMockBotApi("7654321:AA-local-muse-expiry-token-DO-NOT-USE");
  try {
    const key = "task-expired-tg:send";
    const envelope = { origin: { app: "muse-local", created_by: "agent:muse:tenant-expired-telegram" }, state: "proposed", actions: [{ class: "communicate.email.external", summary: "Review release", reversible: false, est_cost_usd: "0", idempotency_key: key, payload_hash: payloadHash(payload) }] };
    assert.equal((await call(a.base, "/v1/registrations", a.options.proposeToken, { task: "task-expired-tg", envelope })).status, 201);
    assert.equal((await call(a.base, "/v1/requests", a.options.proposeToken, { task: "task-expired-tg", action_key: key, payload })).status, 200);
    const pending = buildPendingQueue(a.options.log, { policy: { dir: a.options.root } }, new Date().toISOString());
    assert.equal(pending.ok, true);
    if (!pending.ok) return;
    const request = pending.requests.find((entry) => entry.action_key.value === key);
    assert.ok(request);
    const channel = new TelegramChannel({ token: "7654321:AA-local-muse-expiry-token-DO-NOT-USE", chatId: "9911", apiBase: assertLocal(mock.url), pollTimeoutSeconds: 0, requestTimeoutMs: 3000, backoffMs: 5, maxBackoffMs: 20, log: () => undefined });
    channel.onDecision((decision) => recordChannelDecision(a.options.log, decision, { actor: "human:test", channel: "telegram" }, { policy: { dir: a.options.root } }).outcome);
    await channel.notify(request);
    const callback = mock.callbackDataFor(key, "grant");
    await new Promise((done) => setTimeout(done, 1100));
    mock.queueUpdate(callbackUpdate({ data: callback, chatId: "9911" }));
    const late = await channel.pollOnce();
    assert.equal(late.outcomes.some((entry) => entry.action_key === key && entry.outcome.ok), false);
    assert.equal((await call(a.base, "/v1/status", a.options.readToken, { task: "task-expired-tg", action_key: key })).body["state"], "expired");
    assert.doesNotMatch(readFileSync(a.options.log, "utf8"), /"event":"approval.granted"/u);
    assert.equal(verify(a.options.log).status, "clean");
  } finally { await mock.close(); await a.close(); }
});
