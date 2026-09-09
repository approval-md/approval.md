import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
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
  type Adapter,
  type JsonValue,
} from "../src/adapters/contract.js";
import { runAdapterConformance, type AdapterConformanceHarness } from "../src/adapters/conformance.js";
import { appendAttestation } from "../src/core/attest.js";
import { payloadHash } from "../src/core/payload.js";
import { loadPayload, payloadStoreDirFor } from "../src/core/payload-store.js";
import { keyPath, keyStoreDirFor } from "../src/core/seal.js";
import { DISPLAY_HASH_FIELD } from "../src/core/wysiwys.js";
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

interface Case { logPath: string; actionKey: string; payload: JsonValue; token?: string; policyPath?: string; options: AdapterExecuteOptions }
interface GrantedCase extends Case { token: string }

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

function granted(value: JsonValue, cls = ZZZ_CLASS): GrantedCase {
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

const LIVE_SECRET_ENV = "APPROVAL_TEST_APRV317_LIVE_SECRET";
const LIVE_ENV: NodeJS.ProcessEnv = { [LIVE_SECRET_ENV]: "operator-held-aprv317-test-secret" };

function policyAuthorized(
  value: JsonValue,
  autonomy: "autonomous" | "supervised-retro" | "supervised-live",
  liveRate?: number,
  classOptions: string[] = [],
  shouldAttest = true,
  performGate = true,
): { unit: Case; gate: ReturnType<typeof request> | null } {
  const live = autonomy === "supervised-live";
  const policy = [
    "# Policy", "", "```yaml approval-policy", 'version: "0.1"', "defaults:",
    "  autonomy: manual",
    ...(live ? ["audit:", `  sampling_secret_env: ${LIVE_SECRET_ENV}`] : []),
    "classes:", `  ${ZZZ_CLASS}:`, `    autonomy: ${autonomy}`,
    ...(live ? [`    live_rate: ${String(liveRate)}`] : []),
    "    allow_irreversible: true", ...classOptions, "```", "",
  ].join("\n");
  const scenario = newScenario(scratch.root, policy);
  if (shouldAttest) attest(scenario, T0);
  logs.push(scenario.logPath);
  counter += 1;
  const actionKey = `task-317:zzz-${String(counter)}`;
  const registered = register(scenario.logPath, { task: "task-317", envelope: {
    origin: { app: "manual", created_by: "agent:sender" }, state: "proposed",
    actions: [{ class: ZZZ_CLASS, idempotency_key: actionKey, summary: "send ZZZ message", reversible: false, est_cost_usd: "0.02", payload_hash: payloadHash(value) }],
  } }, T0, "agent:sender", scenario.options);
  assert.equal(registered.ok, true, JSON.stringify(registered));
  const gate = live && performGate
    ? request(
        scenario.logPath,
        { task: "task-317", actionKey, cls: ZZZ_CLASS, est_cost_usd: "0.02", reversible: false, summary: "send ZZZ message" },
        at(1),
        "agent:sender",
        { ...scenario.options, env: LIVE_ENV },
      )
    : null;
  return {
    unit: { logPath: scenario.logPath, actionKey, payload: value, policyPath: scenario.policyPath, options: { policy: { file: scenario.policyPath }, clock: fixedClock(at(2)), ...(live ? { liveIntake: { env: LIVE_ENV } } : {}) } },
    gate,
  };
}

function sealedGranted(value: JsonValue): Case {
  const policy = POLICY.replace(
    '  approval_ttl: "1h"\n',
    '  approval_ttl: "1h"\n  token_delivery: sealed\n',
  );
  const scenario = newScenario(scratch.root, policy);
  const keyStoreDir = `${scenario.dir}/custom-delivery-keys`;
  const gateOptions = { ...scenario.options, keyStoreDir };
  attest(scenario, T0);
  counter += 1;
  const actionKey = `task-317:sealed-${String(counter)}`;
  const registered = register(scenario.logPath, { task: "task-317", envelope: {
    origin: { app: "manual", created_by: "agent:sender" }, state: "awaiting",
    actions: [{ class: ZZZ_CLASS, idempotency_key: actionKey, summary: "send ZZZ message", reversible: false, est_cost_usd: "0.02", payload_hash: payloadHash(value) }],
  } }, T0, "agent:sender", scenario.options);
  assert.equal(registered.ok, true, JSON.stringify(registered));
  const asked = request(
    scenario.logPath,
    { task: "task-317", actionKey, cls: ZZZ_CLASS, est_cost_usd: "0.02", reversible: false, summary: "send ZZZ message" },
    at(1),
    "agent:sender",
    gateOptions,
  );
  assert.equal(asked.ok, true, JSON.stringify(asked));
  const decided = decide(scenario.logPath, actionKey, "grant", "human:carter", at(2), gateOptions);
  assert.equal(decided.ok, true, JSON.stringify(decided));
  return {
    logPath: scenario.logPath,
    actionKey,
    payload: value,
    policyPath: scenario.policyPath,
    options: { policy: { file: scenario.policyPath }, clock: fixedClock(at(3)), keyStoreDir },
  };
}

function adapter() { return zzzAdapter({ origins: { production: mock.url, preview: mock.url }, timeoutMs: 2_000 }); }
async function run(unit: Case, value = unit.payload, overrides: Partial<AdapterExecuteOptions> = {}): Promise<AdapterExecuteResult> {
  return await executeThroughAdapter(adapter(), { logPath: unit.logPath, actionKey: unit.actionKey, payload: value, actor: "agent:sender" },
    { ...unit.options, ...(unit.token === undefined ? {} : { token: unit.token }), credentials: inMemoryCredentials({ [ZZZ_TOKEN_NAME]: TOKEN }), ...overrides });
}
function refusal(result: AdapterExecuteResult) {
  assert.equal(result.ok, false, JSON.stringify(result));
  if (result.ok) throw new Error("expected refusal");
  return result;
}
function events(path: string): string[] { return readFileSync(path, "utf8").trim().split("\n").map((line) => (JSON.parse(line) as { event: string }).event); }

async function runWithSpies(unit: Case, value: JsonValue = unit.payload, actor = "agent:sender") {
  const calls = { credentials: 0, precheck: 0, act: 0 };
  const inspecting: Adapter = {
    name: "eligibility-spy",
    classes: [ZZZ_CLASS],
    requiredCredentials: [ZZZ_TOKEN_NAME],
    precheck() {
      calls.precheck += 1;
      return { ok: true };
    },
    act() {
      calls.act += 1;
      return { ok: true };
    },
  };
  const result = await executeThroughAdapter(
    inspecting,
    { logPath: unit.logPath, actionKey: unit.actionKey, payload: value, actor },
    {
      ...unit.options,
      ...(unit.token === undefined ? {} : { token: unit.token }),
      credentials: {
        get() {
          calls.credentials += 1;
          return { ok: true as const, value: TOKEN };
        },
      },
    },
  );
  return { result, calls };
}

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

for (const [autonomy, expected] of [
  ["autonomous", "autonomous"],
  ["supervised-retro", "supervised"],
] as const) {
  test(`an opted-in irreversible ${autonomy} action executes without a fabricated grant`, async () => {
    const value = payload();
    const { unit } = policyAuthorized(value, autonomy);
    const before = mock.requests.length;
    const result = await run(unit);
    assert.equal(result.ok, true, JSON.stringify(result));
    if (result.ok) assert.equal(result.autonomy, expected);
    assert.equal(mock.requests.length, before + 1);
    assert.equal(mock.requests[before]?.method, "POST");
    assert.deepEqual(events(unit.logPath), ["policy.updated", "task.registered", "execution.started", "execution.completed"]);
  });
}

test("selected supervised-live still requires a real grant token before ZZZ POST", async () => {
  const value = payload();
  const { unit, gate } = policyAuthorized(value, "supervised-live", 1);
  assert.equal(gate?.ok, true, gate?.ok === false ? gate.message : "");
  if (gate === null || !gate.ok) return;
  assert.equal(gate.proceed, false);
  assert.equal(gate.record?.event, "approval.requested");
  const before = mock.requests.length;
  const result = refusal(await run(unit));
  assert.equal(result.code, "token-required");
  assert.equal(result.acted, false);
  assert.equal(mock.requests.length, before);
});

test("direct supervised-live execution runs the existing selected and unselected intake", async () => {
  const selectedPayload = payload();
  const selected = policyAuthorized(selectedPayload, "supervised-live", 1, [], true, false).unit;
  const selectedCheck = await runWithSpies(selected);
  assert.equal(refusal(selectedCheck.result).code, "token-required");
  assert.deepEqual(selectedCheck.calls, { credentials: 0, precheck: 0, act: 0 });
  assert.equal(events(selected.logPath).at(-1), "approval.requested");
  const requested = JSON.parse(readFileSync(selected.logPath, "utf8").trim().split("\n").at(-1) ?? "null") as { payload?: Record<string, unknown> };
  assert.equal(typeof requested.payload?.[DISPLAY_HASH_FIELD], "string");
  const retained = loadPayload(payloadStoreDirFor(selected.logPath), payloadHash(selectedPayload));
  assert.equal(retained.ok, true, JSON.stringify(retained));
  if (retained.ok) assert.deepEqual(retained.value, selectedPayload);

  const unselected = policyAuthorized(payload(), "supervised-live", 1e-100, [], true, false).unit;
  const unselectedCheck = await runWithSpies(unselected);
  assert.equal(unselectedCheck.result.ok, true, JSON.stringify(unselectedCheck.result));
  assert.deepEqual(unselectedCheck.calls, { credentials: 1, precheck: 1, act: 1 });
  assert.deepEqual(events(unselected.logPath).slice(-2), ["execution.started", "execution.completed"]);
});

test("direct live intake refuses changed bytes before request storage or credentials", async () => {
  const unit = policyAuthorized(payload(), "supervised-live", 1, [], true, false).unit;
  const changed: JsonValue = { changed: true };
  const checked = await runWithSpies(unit, changed);
  assert.equal(refusal(checked.result).code, "payload-mismatch");
  assert.deepEqual(checked.calls, { credentials: 0, precheck: 0, act: 0 });
  assert.equal(events(unit.logPath).includes("approval.requested"), false);
  const retained = loadPayload(payloadStoreDirFor(unit.logPath), payloadHash(changed));
  assert.equal(retained.ok, false);
  if (!retained.ok) assert.equal(retained.code, "absent");
});

for (const reason of ["draw-daemon-absent", "draw-daemon-stale", "draw-answer-invalid"] as const) {
  test(`direct supervised-live refuses before credentials when intake reports ${reason}`, async () => {
    const unit = policyAuthorized(payload(), "supervised-live", 0.5, [], true, false).unit;
    unit.options.liveIntake = {
      env: {},
      drawAsk: () => ({ ok: false, reason, detail: "bounded test refusal" }),
    };
    const checked = await runWithSpies(unit);
    assert.equal(refusal(checked.result).code, "token-required");
    assert.deepEqual(checked.calls, { credentials: 0, precheck: 0, act: 0 });
    assert.equal(events(unit.logPath).at(-1), "approval.requested");
  });
}

test("a pending or rejected live cycle is neither redelivered nor redrawn", async () => {
  const unit = policyAuthorized(payload(), "supervised-live", 0.5, [], true, false).unit;
  let draws = 0;
  unit.options.liveIntake = {
    env: {},
    drawAsk: () => {
      draws += 1;
      return { ok: false, reason: "draw-daemon-absent", detail: "no daemon" };
    },
  };

  assert.equal(refusal((await runWithSpies(unit)).result).code, "token-required");
  const deliveryPath = keyPath(keyStoreDirFor(unit.logPath), unit.actionKey);
  const firstDelivery = readFileSync(deliveryPath);
  assert.equal(refusal((await runWithSpies(unit)).result).code, "token-required");
  assert.deepEqual(readFileSync(deliveryPath), firstDelivery);
  assert.equal(draws, 1);
  assert.equal(events(unit.logPath).filter((event) => event === "approval.requested").length, 1);

  const rejected = decide(unit.logPath, unit.actionKey, "reject", "human:carter", at(3), unit.options);
  assert.equal(rejected.ok, true, JSON.stringify(rejected));
  assert.equal(refusal((await runWithSpies(unit)).result).code, "token-required");
  assert.equal(draws, 1, "a rejected cycle was rerolled");
  assert.equal(events(unit.logPath).filter((event) => event === "approval.requested").length, 1);
});

test("non-selected supervised-live executes through ZZZ without a grant token", async () => {
  const value = payload();
  const { unit, gate } = policyAuthorized(value, "supervised-live", 1e-100);
  assert.equal(gate?.ok, true, gate?.ok === false ? gate.message : "");
  if (gate === null || !gate.ok) return;
  assert.equal(gate.proceed, true);
  assert.equal(gate.record, null);
  const before = mock.requests.length;
  const result = await run(unit);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) assert.equal(result.autonomy, "supervised");
  assert.equal(mock.requests.length, before + 1);
  assert.equal(mock.requests[before]?.method, "POST");
});

test("a policy change during adapter precheck is rechecked before act", async () => {
  const value = payload();
  const { unit } = policyAuthorized(value, "autonomous");
  assert.notEqual(unit.policyPath, undefined);
  let prechecks = 0;
  let acts = 0;
  const changing: Adapter = {
    name: "policy-changing-zzz",
    classes: [ZZZ_CLASS],
    requiredCredentials: [ZZZ_TOKEN_NAME],
    precheck() {
      prechecks += 1;
      writeFileSync(unit.policyPath as string, POLICY, "utf8");
      return { ok: true };
    },
    act() {
      acts += 1;
      return { ok: true };
    },
  };
  const result = await executeThroughAdapter(
    changing,
    { logPath: unit.logPath, actionKey: unit.actionKey, payload: value, actor: "agent:sender" },
    { ...unit.options, credentials: inMemoryCredentials({ [ZZZ_TOKEN_NAME]: TOKEN }) },
  );
  const denied = refusal(result);
  assert.equal(denied.code, "token-required");
  assert.equal(prechecks, 1);
  assert.equal(acts, 0);
});

test("an unrecorded live draw stays bound to one policy through eligibility and start", async () => {
  const value = payload();
  const unit = policyAuthorized(value, "supervised-live", 0.5, [], true, false).unit;
  assert.notEqual(unit.policyPath, undefined);
  unit.options.liveIntake = {
    env: {},
    drawAsk: (_logPath, question) => {
      const changed = readFileSync(unit.policyPath as string, "utf8").replace(
        "    live_rate: 0.5",
        "    live_rate: 1",
      );
      writeFileSync(unit.policyPath as string, changed, "utf8");
      const attested = appendAttestation(
        unit.logPath,
        unit.policyPath as string,
        "human:carter",
        { clock: fixedClock(at(1)) },
      );
      assert.equal(attested.ok, true, JSON.stringify(attested));
      return {
        ok: true,
        answer: {
          v: 1,
          question,
          selected: false,
          mac: "0".repeat(64),
          daemon_pid: process.pid,
          answered_at: at(1),
        },
      };
    },
  };
  const checked = await runWithSpies(unit);
  assert.equal(refusal(checked.result).code, "policy-drift");
  assert.deepEqual(checked.calls, { credentials: 0, precheck: 0, act: 0 });
});

test("a rate change during precheck prevents act under the earlier unrecorded draw", async () => {
  const value = payload();
  const unit = policyAuthorized(value, "supervised-live", 1e-100, [], true, false).unit;
  assert.notEqual(unit.policyPath, undefined);
  let prechecks = 0;
  let acts = 0;
  const changing: Adapter = {
    name: "live-policy-changing-zzz",
    classes: [ZZZ_CLASS],
    requiredCredentials: [ZZZ_TOKEN_NAME],
    precheck() {
      prechecks += 1;
      const changed = readFileSync(unit.policyPath as string, "utf8").replace(
        "    live_rate: 1e-100",
        "    live_rate: 1",
      );
      writeFileSync(unit.policyPath as string, changed, "utf8");
      const attested = appendAttestation(
        unit.logPath,
        unit.policyPath as string,
        "human:carter",
        { clock: fixedClock(at(3)) },
      );
      assert.equal(attested.ok, true, JSON.stringify(attested));
      return { ok: true };
    },
    act() {
      acts += 1;
      return { ok: true };
    },
  };
  const result = await executeThroughAdapter(
    changing,
    { logPath: unit.logPath, actionKey: unit.actionKey, payload: value, actor: "agent:sender" },
    { ...unit.options, credentials: inMemoryCredentials({ [ZZZ_TOKEN_NAME]: TOKEN }) },
  );
  assert.equal(refusal(result).code, "policy-drift");
  assert.equal(prechecks, 1);
  assert.equal(acts, 0);
});

test("ineligible no-token actions touch neither credentials nor adapter precheck", async () => {
  async function deniedBeforeBoundary(unit: Case, code: string, value?: JsonValue) {
    const checked = await runWithSpies(unit, value);
    const denied = refusal(checked.result);
    assert.equal(denied.code, code);
    assert.deepEqual(checked.calls, { credentials: 0, precheck: 0, act: 0 });
  }

  const manual = policyAuthorized(payload(), "autonomous").unit;
  writeFileSync(
    manual.policyPath as string,
    readFileSync(manual.policyPath as string, "utf8").replace(
      "    autonomy: autonomous\n    allow_irreversible: true",
      "    autonomy: manual",
    ),
    "utf8",
  );
  await deniedBeforeBoundary(manual, "token-required");

  const invalidActor = policyAuthorized(payload(), "autonomous").unit;
  const invalid = await runWithSpies(invalidActor, invalidActor.payload, "system:gate");
  assert.equal(refusal(invalid.result).code, "actor-invalid");
  assert.deepEqual(invalid.calls, { credentials: 0, precheck: 0, act: 0 });

  const humanOnly = policyAuthorized(payload(), "autonomous").unit;
  writeFileSync(
    humanOnly.policyPath as string,
    readFileSync(humanOnly.policyPath as string, "utf8").replace(
      "    autonomy: autonomous\n    allow_irreversible: true",
      "    autonomy: human-only",
    ),
    "utf8",
  );
  await deniedBeforeBoundary(humanOnly, "class-human-only");

  const selected = policyAuthorized(payload(), "supervised-live", 1);
  assert.equal(selected.gate?.ok, true);
  await deniedBeforeBoundary(selected.unit, "token-required");

  const unattested = policyAuthorized(payload(), "autonomous", undefined, [], false).unit;
  await deniedBeforeBoundary(unattested, "policy-not-attested");

  const drifted = policyAuthorized(payload(), "autonomous").unit;
  writeFileSync(drifted.policyPath as string, `${readFileSync(drifted.policyPath as string, "utf8")}\n`, "utf8");
  await deniedBeforeBoundary(drifted, "policy-not-attested");

  const changed = policyAuthorized(payload(), "autonomous").unit;
  await deniedBeforeBoundary(changed, "payload-mismatch", { changed: true });

  const overBudget = policyAuthorized(
    payload(),
    "autonomous",
    undefined,
    ["    limits:", "      per_action_usd: 0.01"],
  ).unit;
  await deniedBeforeBoundary(overBudget, "budget-exceeded");
  assert.equal(events(overBudget.logPath).at(-1), "budget.exceeded");

  const spent = policyAuthorized(payload(), "autonomous").unit;
  assert.equal((await run(spent)).ok, true);
  await deniedBeforeBoundary(spent, "already-executed");
});

test("an omitted CLI token still uses a verified locally delivered manual token", async () => {
  const checked = await runWithSpies(sealedGranted(payload()));
  assert.equal(checked.result.ok, true, JSON.stringify(checked.result));
  if (checked.result.ok) assert.equal(checked.result.autonomy, "manual");
  assert.deepEqual(checked.calls, { credentials: 1, precheck: 1, act: 1 });
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
