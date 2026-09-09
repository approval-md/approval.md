import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";

import {
  ZZZ_CLASS,
  ZZZ_CREDENTIAL_SPECS,
  ZZZ_PRODUCTION_API_BASE,
  ZZZ_TOKEN_NAME,
  probeZzz,
  validateZzzPayload,
  zzzAdapter,
} from "../src/adapters/zzz.js";
import {
  executeThroughAdapter,
  inMemoryCredentials,
  type AdapterExecuteOptions,
  type AdapterExecuteResult,
  type JsonValue,
} from "../src/adapters/contract.js";
import { runAdapterConformance, type AdapterConformanceHarness } from "../src/adapters/conformance.js";
import { payloadHash } from "../src/core/payload.js";
import { decide, register, request } from "./clock-adapters.js";
import { at, attest, fixedClock, newScenario, scratchRoot, T0 } from "./scenario.js";
import { startMockZzz } from "./zzz-mock.js";

const scratch = scratchRoot("adapter-zzz");
const TOKEN = `z_${"x".repeat(48)}`;
const mock = await startMockZzz(TOKEN);
const logs: string[] = [];
let counter = 0;

after(async () => { await mock.close(); scratch.cleanup(); });

const POLICY = [
  "# Policy", "", "```yaml approval-policy", 'version: "0.1"', "defaults:",
  "  autonomy: manual", '  approval_ttl: "1h"', "  on_expiry: reject", "classes:",
  `  ${ZZZ_CLASS}:`, "    autonomy: manual", "```", "",
].join("\n");

interface Case { logPath: string; actionKey: string; payload: JsonValue; token: string; options: AdapterExecuteOptions }

function payload(operation: "create_thread" | "create_reply" = "create_thread"): JsonValue {
  counter += 1;
  const common = {
    environment: "production", operation, body: `message ${String(counter)}`,
    metadata: { source: "approval-test" }, tags: ["approval"],
    references: [{ kind: "external", target: "https://zzz.bot/api", label: "contract", relationship: "source" }],
  };
  return operation === "create_thread"
    ? { ...common, room_id: "room/a", title: `Thread ${String(counter)}` }
    : { ...common, thread_id: `thr_${"b".repeat(32)}` };
}

function granted(value: JsonValue, cls = ZZZ_CLASS): Case {
  const unit = newScenario(scratch.root, POLICY);
  attest(unit, T0);
  logs.push(unit.logPath);
  counter += 1;
  const actionKey = `task-320:zzz-${String(counter)}`;
  const registered = register(unit.logPath, { task: "task-320", envelope: {
    origin: { app: "manual", created_by: "agent:sender" }, state: "awaiting",
    actions: [{ class: cls, idempotency_key: actionKey, summary: "send ZZZ message", reversible: false, est_cost_usd: "0", payload_hash: payloadHash(value) }],
  } }, T0, "agent:sender", unit.options);
  assert.equal(registered.ok, true);
  assert.equal(request(unit.logPath, { task: "task-320", actionKey, cls, est_cost_usd: "0", reversible: false, summary: "send ZZZ message" }, at(1), "agent:sender", unit.options).ok, true);
  const decision = decide(unit.logPath, actionKey, "grant", "human:carter", at(2), unit.options);
  assert.equal(decision.ok, true);
  if (!decision.ok || decision.token === undefined) throw new Error("grant produced no token");
  return { logPath: unit.logPath, actionKey, payload: value, token: decision.token, options: { policy: { file: unit.policyPath }, clock: fixedClock(at(3)) } };
}

function adapter() { return zzzAdapter({ origins: { production: mock.url, preview: mock.url }, timeoutMs: 2_000 }); }
async function run(unit: Case, value = unit.payload, overrides: Partial<AdapterExecuteOptions> = {}): Promise<AdapterExecuteResult> {
  return await executeThroughAdapter(adapter(), { logPath: unit.logPath, actionKey: unit.actionKey, payload: value, actor: "agent:sender" },
    { ...unit.options, token: unit.token, credentials: inMemoryCredentials({ [ZZZ_TOKEN_NAME]: TOKEN }), ...overrides });
}
function refusal(result: AdapterExecuteResult) {
  assert.equal(result.ok, false, JSON.stringify(result));
  if (result.ok) throw new Error("expected refusal");
  return result;
}
function events(path: string): string[] { return readFileSync(path, "utf8").trim().split("\n").map((line) => (JSON.parse(line) as { event: string }).event); }

test("thread creation sends the exact approved message through real loopback HTTP", async () => {
  const value = payload();
  const unit = granted(value);
  const before = mock.requests.length;
  const result = await run(unit);
  assert.equal(result.ok, true, JSON.stringify(result));
  const sent = mock.requests[before];
  assert.equal(sent?.method, "POST");
  assert.equal(sent?.path, "/api/v1/rooms/room%2Fa/threads");
  assert.equal(sent?.authorization, `Bearer ${TOKEN}`);
  assert.match(sent?.idempotencyKey ?? "", /^approval:[a-f0-9]{64}$/u);
  const approved = value as Record<string, JsonValue>;
  assert.deepEqual(JSON.parse(sent?.body ?? "null"), {
    title: approved["title"], body: approved["body"], metadata: approved["metadata"],
    tags: approved["tags"], references: approved["references"],
  });
  if (result.ok) assert.deepEqual(result.provider_ref, { adapter: "zzz", id: `thr_${"a".repeat(32)}` });
  assert.deepEqual(events(unit.logPath).slice(-2), ["execution.started", "execution.completed"]);
});

test("reply creation selects the post route and preserves references", async () => {
  const value = payload("create_reply");
  const unit = granted(value);
  const before = mock.requests.length;
  const result = await run(unit);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(mock.requests[before]?.path, `/api/v1/threads/thr_${"b".repeat(32)}/posts`);
  if (result.ok) assert.deepEqual(result.provider_ref, { adapter: "zzz", id: `pst_${"a".repeat(32)}` });
});

test("the provider idempotency key is stable for the same action and bytes", async () => {
  const value = payload();
  const one = granted(value);
  const two = granted(value);
  two.actionKey = one.actionKey;
  await run(one);
  const first = mock.requests.at(-1)?.idempotencyKey;
  // Exercise the adapter itself without reusing a consumed approval token.
  const direct = adapter();
  assert.ok(direct.act !== undefined);
  await direct.act({ actionKey: one.actionKey, payload: value, credentials: inMemoryCredentials({ [ZZZ_TOKEN_NAME]: TOKEN }) });
  assert.equal(mock.requests.at(-1)?.idempotencyKey, first);
});

test("an inconsistent 200 receipt is indeterminate", async () => {
  const unit = granted(payload());
  mock.answer(200, { id: `thr_${"c".repeat(32)}`, replayed: false });
  const result = refusal(await run(unit));
  assert.equal(result.code, "execution-indeterminate");
  assert.equal(result.outcome, "execution.indeterminate");
});

test("a valid 200 replay is completed with the exact returned id", async () => {
  const unit = granted(payload("create_reply"));
  mock.answer(200, { id: `pst_${"d".repeat(32)}`, replayed: true });
  const result = await run(unit);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) assert.deepEqual(result.provider_ref, { adapter: "zzz", id: `pst_${"d".repeat(32)}` });
});

for (const [label, prepare] of [
  ["malformed", () => mock.answer(201, "not-json")],
  ["oversized", () => mock.answer(201, "x".repeat(20_000))],
] as const) {
  test(`${label} success bodies are indeterminate and bounded`, async () => {
    const unit = granted(payload());
    prepare();
    const result = refusal(await run(unit));
    assert.equal(result.code, "execution-indeterminate");
  });
}

test("a redirect is indeterminate and is never followed", async () => {
  const unit = granted(payload());
  const before = mock.requests.length;
  mock.redirect(`${mock.url}/should-not-be-requested`);
  const result = refusal(await run(unit));
  assert.equal(result.code, "execution-indeterminate");
  assert.equal(mock.requests.length, before + 1, "the redirect destination received a request");
  assert.notEqual(mock.requests.at(-1)?.path, "/should-not-be-requested");
});

test("a real socket disconnect during POST is indeterminate", async () => {
  const unit = granted(payload());
  mock.disconnect();
  const result = refusal(await run(unit));
  assert.equal(result.code, "execution-indeterminate");
});

test("a real HTTP stall obeys the timeout and is indeterminate", async () => {
  const unit = granted(payload());
  mock.stall();
  const result = await executeThroughAdapter(
    zzzAdapter({ origins: { production: mock.url }, timeoutMs: 25 }),
    { logPath: unit.logPath, actionKey: unit.actionKey, payload: unit.payload, actor: "agent:sender" },
    { ...unit.options, token: unit.token, credentials: inMemoryCredentials({ [ZZZ_TOKEN_NAME]: TOKEN }) },
  );
  assert.equal(refusal(result).code, "execution-indeterminate");
});

test("a 409 is a clean mapped failure and response text is never recorded", async () => {
  const unit = granted(payload());
  mock.answer(409, { error: { code: "idempotency_conflict", message: `echo ${TOKEN}` } });
  const result = refusal(await run(unit));
  assert.equal(result.adapter_code, "zzz-idempotency-conflict");
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal(readFileSync(unit.logPath, "utf8").includes(TOKEN), false);
});

test("a 500 is indeterminate because the POST may have committed", async () => {
  const unit = granted(payload());
  mock.answer(500, { error: { code: "internal_error" } });
  const result = refusal(await run(unit));
  assert.equal(result.code, "execution-indeterminate");
  assert.deepEqual(events(unit.logPath).slice(-2), ["execution.started", "execution.indeterminate"]);
});

test("an unexpected 202 is indeterminate because acceptance may have committed", async () => {
  const unit = granted(payload());
  mock.answer(202, { id: `thr_${"e".repeat(32)}`, replayed: false });
  const result = refusal(await run(unit));
  assert.equal(result.code, "execution-indeterminate");
  assert.equal(result.outcome, "execution.indeterminate");
});

test("invalid payload refuses before the token is spent or HTTP is attempted", async () => {
  const value = { ...payload() as Record<string, JsonValue>, api_base: "https://attacker.invalid" };
  const unit = granted(value);
  const before = mock.requests.length;
  const result = refusal(await run(unit));
  assert.equal(result.code, "adapter-precheck-refused");
  assert.equal(result.adapter_code, "zzz-payload-invalid");
  assert.equal(mock.requests.length, before);
  assert.equal(events(unit.logPath).includes("execution.started"), false);
});

test("tampering with a reference is caught by the shared payload hash before HTTP", async () => {
  const value = payload();
  const unit = granted(value);
  const changed = { ...value as Record<string, JsonValue>, references: [] };
  const before = mock.requests.length;
  const result = refusal(await run(unit, changed));
  assert.equal(result.code, "payload-mismatch");
  assert.equal(mock.requests.length, before);
});

test("a consumed grant, a bad token, and a missing credential make zero requests", async () => {
  const first = granted(payload());
  await run(first);
  let before = mock.requests.length;
  assert.equal(refusal(await run(first)).code, "token-consumed");
  assert.equal(mock.requests.length, before);

  const bad = granted(payload());
  before = mock.requests.length;
  assert.equal(refusal(await run(bad, bad.payload, { token: "not-the-grant" })).code, "token-mismatch");
  assert.equal(mock.requests.length, before);

  const missing = granted(payload());
  before = mock.requests.length;
  assert.equal(refusal(await run(missing, missing.payload, { credentials: inMemoryCredentials({}) })).code, "credential-unavailable");
  assert.equal(mock.requests.length, before);
});

test("an already-aborted signal makes no HTTP request", async () => {
  const unit = granted(payload());
  const controller = new AbortController();
  controller.abort();
  const before = mock.requests.length;
  const result = refusal(await run(unit, unit.payload, { signal: controller.signal }));
  assert.equal(result.adapter_code, "zzz-cancelled");
  assert.equal(mock.requests.length, before);
});

test("provider idempotency changes with either action identity or payload", async () => {
  const one = payload();
  const direct = adapter();
  await direct.act?.({ actionKey: "task-320:key-one", payload: one, credentials: inMemoryCredentials({ [ZZZ_TOKEN_NAME]: TOKEN }) });
  const first = mock.requests.at(-1)?.idempotencyKey;
  await direct.act?.({ actionKey: "task-320:key-two", payload: one, credentials: inMemoryCredentials({ [ZZZ_TOKEN_NAME]: TOKEN }) });
  const second = mock.requests.at(-1)?.idempotencyKey;
  await direct.act?.({ actionKey: "task-320:key-two", payload: { ...one as Record<string, JsonValue>, body: "changed" }, credentials: inMemoryCredentials({ [ZZZ_TOKEN_NAME]: TOKEN }) });
  const third = mock.requests.at(-1)?.idempotencyKey;
  assert.notEqual(first, second);
  assert.notEqual(second, third);
});

test("manifest, defaults, and strict payload validator are stable", () => {
  assert.equal(ZZZ_PRODUCTION_API_BASE, "https://zzz.bot");
  assert.deepEqual(ZZZ_CREDENTIAL_SPECS.map((item) => item.name), [ZZZ_TOKEN_NAME]);
  assert.equal(zzzAdapter().classes[0], ZZZ_CLASS);
  assert.equal(validateZzzPayload(payload()).ok, true);
  assert.equal(validateZzzPayload({ environment: "production", operation: "create_reply", thread_id: "x", body: "ok", references: [{ kind: "external", target: "file:///etc/passwd", label: "bad", relationship: "source" }] }).ok, false);
});

test("the setup probe is one authenticated read and claims no write", async () => {
  const before = mock.requests.length;
  assert.deepEqual(await probeZzz(TOKEN, { origins: { production: mock.url } }), { ok: true });
  const seen = mock.requests[before];
  assert.equal(seen?.method, "GET");
  assert.equal(seen?.path, "/api/v1/rooms");
  assert.equal(seen?.authorization, `Bearer ${TOKEN}`);
});

const CONFORMANCE: AdapterConformanceHarness = {
  setup: () => {
    const unit = granted(payload());
    return {
      logPath: unit.logPath,
      actionKey: unit.actionKey,
      payload: unit.payload,
      token: unit.token,
      actor: "agent:sender",
      class: ZZZ_CLASS,
      options: unit.options,
    };
  },
  credential: { name: ZZZ_TOKEN_NAME, value: TOKEN },
  credentials: {},
  foreignClass: "financial.spend",
};

test("the ZZZ adapter conforms to the shared adapter contract", async (t) => {
  await runAdapterConformance(t, () => adapter(), CONFORMANCE);
});
