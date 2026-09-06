/**
 * Adapter contract tests (APRV-67).
 *
 * Same discipline as every other suite here: nothing hand-writes a log line.
 * The policy is attested through `core/attest.ts`, the task is registered and
 * requested through `core/gate.ts`, the grant is a real human decision through
 * the real `decide()`, and the token under test is the one that grant printed.
 * Timestamps are injected as clocks (amended SPEC.md §8, A2).
 *
 * The suite has three parts:
 *
 * 1. The shared conformance suite, run against the mock adapter.
 * 2. The same suite run against deliberately broken adapters, asserted to go
 *    RED. A conformance suite nobody has watched fail is a suite that might
 *    pass anything.
 * 3. Unit checks the conformance suite does not reach: the frozen unions, the
 *    redaction guard, the default fail-closed credential provider, and the two
 *    ways an adapter's own step can go wrong (reporting failure, throwing).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";

import {
  ADAPTER_REFUSAL_CODES,
  CREDENTIAL_REFUSAL_CODES,
  NO_CREDENTIALS,
  REDACTION_PLACEHOLDER,
  containsSecret,
  executeThroughAdapter,
  inMemoryCredentials,
  redactJson,
  redactSecrets,
  type ActInput,
  type ActOutcome,
  type Adapter,
  type AdapterExecuteOptions,
  type CredentialProvider,
  type JsonValue,
  type PrecheckOutcome,
} from "../src/adapters/contract.js";
import {
  runAdapterConformance,
  type AdapterConformanceCase,
  type AdapterConformanceHarness,
} from "../src/adapters/conformance.js";
import {
  AGENTMAIL_CLASS,
  DEFAULT_AGENTMAIL_CREDENTIAL_NAMES,
  agentmailAdapter,
} from "../src/adapters/agentmail.js";
import { EXECUTE_REFUSAL_CODES } from "../src/core/execute.js";
import { payloadHash } from "../src/core/payload.js";
import { MOCK_CLASS, MOCK_CREDENTIAL, mockAdapter, type MockAdapter } from "./adapter-mock.js";
import {
  assertLocal as assertAgentmailLocal,
  startMockAgentmail,
} from "./agentmail-mock.js";
import { decide, register, request } from "./clock-adapters.js";
import { verify } from "../src/core/verify.js";
import { at, attest, fixedClock, newScenario, scratchRoot, T0 } from "./scenario.js";

const scratch = scratchRoot("adapters-contract");
after(scratch.cleanup);

const TASK = "task-670";
const AGENT = "agent:sender";
const HUMAN = "human:carter";
const SECRET = "sk-live-conformance-93bf21";

const POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "1h"',
  "  on_expiry: reject",
  "classes:",
  "  read.*:",
  "    autonomy: autonomous",
  "  communicate.email.external:",
  "    autonomy: manual",
  "```",
  "",
].join("\n");

let counter = 0;

/** The bytes a grant will bind to. Distinct per case, so no case can borrow. */
function payloadFor(index: number): JsonValue {
  return {
    to: [`ap-${index}@vendor.example`],
    subject: `Invoice ${index} chaser`,
    body: `Following up on invoice ${index}.`,
  };
}

/**
 * A fresh log holding one granted, unspent manual action, built through the
 * real gate. Returns everything an adapter execution needs.
 */
function granted(
  cls: string = MOCK_CLASS,
  /** The bytes to bind. Defaults to this file's own shape (APRV-222). */
  bytes?: JsonValue,
): AdapterConformanceCase {
  counter += 1;
  const unit = newScenario(scratch.root, POLICY);
  attest(unit, T0);

  const actionKey = `${TASK}:send-${counter}:2026-08-05`;
  const payload = bytes ?? payloadFor(counter);

  const registered = register(
    unit.logPath,
    {
      task: TASK,
      envelope: {
        origin: { app: "manual", created_by: AGENT },
        state: "awaiting",
        actions: [
          {
            class: cls,
            idempotency_key: actionKey,
            summary: `chase invoice ${counter}`,
            reversible: false,
            est_cost_usd: "0.02",
            payload_hash: payloadHash(payload),
          },
        ],
      },
    },
    T0,
    AGENT,
    unit.options,
  );
  assert.equal(registered.ok, true, `registration failed: ${JSON.stringify(registered)}`);

  const requested = request(
    unit.logPath,
    {
      task: TASK,
      actionKey,
      cls,
      est_cost_usd: "0.02",
      reversible: false,
      summary: `chase invoice ${counter}`,
    },
    at(1),
    AGENT,
    unit.options,
  );
  assert.equal(requested.ok, true, `request failed: ${JSON.stringify(requested)}`);

  const decided = decide(unit.logPath, actionKey, "grant", HUMAN, at(2), unit.options);
  assert.equal(decided.ok, true, `grant failed: ${JSON.stringify(decided)}`);
  if (!decided.ok || decided.token === undefined) throw new Error("expected a token");

  return {
    logPath: unit.logPath,
    actionKey,
    payload,
    token: decided.token,
    actor: AGENT,
    class: cls,
    options: { policy: { file: unit.policyPath }, clock: fixedClock(at(3)) },
  };
}

const HARNESS: AdapterConformanceHarness = {
  setup: () => granted(),
  credential: { name: MOCK_CREDENTIAL, value: SECRET },
  foreignClass: "financial.spend",
};

/** Options for a one-off execution outside the conformance suite. */
function options(
  unit: AdapterConformanceCase,
  extra: Partial<AdapterExecuteOptions> = {},
): AdapterExecuteOptions {
  return {
    ...unit.options,
    token: unit.token,
    credentials: inMemoryCredentials({ [MOCK_CREDENTIAL]: SECRET }),
    ...extra,
  };
}

function run(
  adapter: Adapter,
  unit: AdapterConformanceCase,
  extra: Partial<AdapterExecuteOptions> = {},
) {
  return executeThroughAdapter(
    adapter,
    { logPath: unit.logPath, actionKey: unit.actionKey, payload: unit.payload, actor: unit.actor },
    options(unit, extra),
  );
}

// ---------------------------------------------------------------------------
// 1. The conformance suite against the mock
// ---------------------------------------------------------------------------

test("the mock adapter conforms", async (t) => {
  await runAdapterConformance(t, () => mockAdapter(), HARNESS);
});

// ---------------------------------------------------------------------------
// 2. The suite goes RED against broken adapters
// ---------------------------------------------------------------------------

test("the suite fails an adapter that declares a class it does not serve", async (t) => {
  const wrong: Adapter = { ...mockAdapter(), classes: ["read.calendar"] };
  await assert.rejects(
    () => runAdapterConformance(t, () => wrong, HARNESS),
    /adapter-class-mismatch|refused/u,
    "an adapter whose declared classes exclude the action must fail conformance",
  );
});

test("the suite fails an adapter whose act always throws", async (t) => {
  await assert.rejects(
    () => runAdapterConformance(t, () => mockAdapter({ throws: "boom" }), HARNESS),
    /refused|adapter-act-threw/u,
    "an adapter that cannot act must fail conformance",
  );
});

// ---------------------------------------------------------------------------
// 3a. The frozen unions (SPEC.md §11.1 invariant 6)
// ---------------------------------------------------------------------------

test("the adapter refusal union is frozen and a superset of the execute union", () => {
  assert.deepEqual(
    [...ADAPTER_REFUSAL_CODES],
    [
      ...EXECUTE_REFUSAL_CODES,
      "adapter-class-mismatch",
      "payload-unhashable",
      "adapter-failed",
      "adapter-act-threw",
      "credential-unavailable",
      "adapter-precheck-refused",
    ],
    "the adapter refusal union changed; it is frozen public API",
  );
  assert.equal(
    new Set(ADAPTER_REFUSAL_CODES).size,
    ADAPTER_REFUSAL_CODES.length,
    "a refusal code is listed twice",
  );
  for (const code of EXECUTE_REFUSAL_CODES) {
    assert.ok(
      ADAPTER_REFUSAL_CODES.includes(code),
      `core refusal ${code} is not surfaced by the adapter path; it must pass through verbatim`,
    );
  }
});

test("the credential refusal union is frozen", () => {
  assert.deepEqual(
    [...CREDENTIAL_REFUSAL_CODES],
    ["credential-unavailable", "credential-refused", "credential-window-closed"],
  );
});

// ---------------------------------------------------------------------------
// 3b. The redaction guard
// ---------------------------------------------------------------------------

test("redactSecrets replaces every occurrence and counts the hits", () => {
  const result = redactSecrets(`a ${SECRET} b ${SECRET}`, [SECRET]);
  assert.equal(result.hits, 2);
  assert.equal(result.text, `a ${REDACTION_PLACEHOLDER} b ${REDACTION_PLACEHOLDER}`);
  assert.equal(result.text.includes(SECRET), false);
});

test("redactSecrets skips the empty secret rather than redacting everything", () => {
  const result = redactSecrets("nothing secret here", [""]);
  assert.equal(result.hits, 0);
  assert.equal(result.text, "nothing secret here");
});

test("redactSecrets catches a secret embedded in a longer word", () => {
  const result = redactSecrets(`prefix${SECRET}suffix`, [SECRET]);
  assert.equal(result.hits, 1);
  assert.equal(result.text, `prefix${REDACTION_PLACEHOLDER}suffix`);
});

test("containsSecret is the assertion form of the same scan", () => {
  assert.equal(containsSecret(`... ${SECRET} ...`, [SECRET]), true);
  assert.equal(containsSecret("clean", [SECRET]), false);
  assert.equal(containsSecret("anything", [""]), false);
});

test("redactJson redacts values, keys, and nested members", () => {
  const value: JsonValue = {
    [SECRET]: "as a key",
    nested: { list: [SECRET, 1, null], note: `bearer ${SECRET}` },
  };
  const redacted = redactJson(value, [SECRET]);
  assert.equal(redacted.hits, 3);
  assert.equal(JSON.stringify(redacted.value).includes(SECRET), false);
  assert.deepEqual(redacted.value, {
    [REDACTION_PLACEHOLDER]: "as a key",
    nested: { list: [REDACTION_PLACEHOLDER, 1, null], note: `bearer ${REDACTION_PLACEHOLDER}` },
  });
});

test("redactJson leaves a value alone when there is nothing to redact", () => {
  const value: JsonValue = { a: [1, "two", true, null] };
  const redacted = redactJson(value, []);
  assert.equal(redacted.hits, 0);
  assert.deepEqual(redacted.value, value);
});

test("a credential the adapter publishes in its detail is redacted from the result", async () => {
  const unit = granted();
  const adapter = mockAdapter({ leak: SECRET });
  const result = await run(adapter, unit);

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(JSON.stringify(result).includes(SECRET), false, "the secret survived into the result");
  if (result.ok) {
    assert.equal(result.redactions, 1, "the guard must count what it replaced");
    assert.deepEqual(result.detail, { sent: true, note: `key=${REDACTION_PLACEHOLDER}` });
  }
  assert.equal(readFileSync(unit.logPath, "utf8").includes(SECRET), false, "the log holds a secret");
  unit.cleanup?.();
});

// ---------------------------------------------------------------------------
// 3c. Credentials: default, scope, and the window
// ---------------------------------------------------------------------------

test("with no provider configured, nothing is handed out and the adapter cannot act", async () => {
  const unit = granted();
  const adapter = mockAdapter();
  const before = readFileSync(unit.logPath, "utf8");
  const result = await executeThroughAdapter(
    adapter,
    { logPath: unit.logPath, actionKey: unit.actionKey, payload: unit.payload, actor: unit.actor },
    { ...unit.options, token: unit.token },
  );

  assert.equal(result.ok, false, "an adapter with no credential must not report success");
  if (!result.ok) {
    // APRV-169: the declared credential is resolved BEFORE the token is spent,
    // so this is refused with the log untouched rather than recorded as a
    // failed execution.
    assert.equal(result.code, "credential-unavailable");
    assert.equal(result.adapter_code, "credential-unavailable");
    assert.equal(result.acted, false, "act must not run without the credential it declared");
    assert.equal(result.started_seq, undefined, "an execution was started for a missing credential");
    assert.equal(result.outcome, undefined, "an outcome was recorded for an execution never begun");
  }
  assert.equal(adapter.sends.length, 0, "the mock sent without a credential");
  assert.equal(
    readFileSync(unit.logPath, "utf8"),
    before,
    "a credential refusal wrote to the log; it must cost no authority",
  );
  assert.equal(NO_CREDENTIALS.get("anything").ok, false, "the default provider handed out a value");
  unit.cleanup?.();
});

test("a credential refusal leaves the token spendable, and the same token then succeeds", async () => {
  const unit = granted();
  const adapter = mockAdapter();
  const before = readFileSync(unit.logPath, "utf8");

  // The credential is absent at first: the provider knows the name and holds
  // nothing for it, which is the shape of a vault an operator has not filled.
  const holdings: Record<string, string> = {};
  const late: CredentialProvider = {
    get: (name: string) => inMemoryCredentials(holdings).get(name),
  };

  const refused = await run(adapter, unit, { credentials: late });
  assert.equal(refused.ok, false, "a missing credential must not report success");
  if (!refused.ok) assert.equal(refused.code, "credential-unavailable");
  assert.equal(
    readFileSync(unit.logPath, "utf8"),
    before,
    "the failed attempt appended to the log; the grant must be untouched",
  );

  // The operator stores it. The SAME token, never consumed, now works.
  holdings[MOCK_CREDENTIAL] = SECRET;
  const second = await run(adapter, unit, { credentials: late });
  assert.equal(second.ok, true, `the retained token was refused: ${JSON.stringify(second)}`);
  assert.equal(adapter.sends.length, 1, "the retry did not send exactly once");

  // And it is still single-use: the third attempt is refused by the token, not
  // by the credential.
  const third = await run(adapter, unit, { credentials: late });
  assert.equal(third.ok, false, "a spent token executed twice");
  if (!third.ok) assert.equal(third.code, "token-consumed", `wrong refusal: ${third.code}`);
  assert.equal(adapter.sends.length, 1, "a second send happened on a spent token");
  unit.cleanup?.();
});

// ---------------------------------------------------------------------------
// 3c-bis. The pre-token check (APRV-276)
// ---------------------------------------------------------------------------

test("a precheck refusal appends nothing, spends nothing, and act never runs", async () => {
  const unit = granted();
  const adapter = mockAdapter();
  const before = readFileSync(unit.logPath, "utf8");
  let asked = 0;

  const refusing: MockAdapter = {
    ...adapter,
    precheck(input): PrecheckOutcome {
      asked += 1;
      assert.deepEqual(input.payload, unit.payload, "precheck was handed different bytes");
      assert.equal(input.actionKey, unit.actionKey);
      // The window is open here too: this is the pre-token one APRV-169 opens.
      assert.equal(input.credentials.get(MOCK_CREDENTIAL).ok, true);
      return { ok: false, code: "far-side-moved", message: "the object under the grant changed" };
    },
  };

  const result = await run(refusing, unit);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "adapter-precheck-refused");
    assert.equal(result.adapter_code, "far-side-moved");
    assert.equal(result.acted, false, "act ran after a precheck refusal");
    assert.equal(result.started_seq, undefined, "an execution was started for a refused precheck");
    assert.equal(result.outcome, undefined, "an outcome was recorded for an execution never begun");
    assert.match(result.message, /the object under the grant changed/u);
  }
  assert.equal(asked, 1, "the precheck was not called exactly once");
  assert.equal(adapter.sends.length, 0, "the mock sent after a precheck refusal");
  assert.equal(
    readFileSync(unit.logPath, "utf8"),
    before,
    "a precheck refusal wrote to the log; it must cost no authority",
  );

  // The grant is intact, so the SAME token executes once the condition clears.
  const second = await run(adapter, unit);
  assert.equal(second.ok, true, `the retained token was refused: ${JSON.stringify(second)}`);
  assert.equal(adapter.sends.length, 1, "the retry did not send exactly once");
  unit.cleanup?.();
});

test("a precheck that throws is a refusal, not an exception, and spends nothing", async () => {
  const unit = granted();
  const adapter = mockAdapter();
  const before = readFileSync(unit.logPath, "utf8");
  const hostile: MockAdapter = {
    ...adapter,
    precheck(): PrecheckOutcome {
      throw new Error(`the far side is unreachable ${SECRET}`);
    },
  };

  const result = await run(hostile, unit);
  assert.equal(result.ok, false, "a check that could not be performed is not a check that passed");
  if (!result.ok) {
    assert.equal(result.code, "adapter-precheck-refused");
    assert.equal(result.adapter_code, "precheck-threw");
    assert.equal(result.acted, false);
    assert.equal(JSON.stringify(result).includes(SECRET), false, "the secret survived the refusal");
  }
  assert.equal(adapter.sends.length, 0);
  assert.equal(readFileSync(unit.logPath, "utf8"), before, "a throwing precheck wrote to the log");
  unit.cleanup?.();
});

test("an adapter with no precheck keeps the ordering it always had", async () => {
  const unit = granted();
  const adapter = mockAdapter();
  assert.equal(adapter.precheck, undefined, "the mock adapter grew a precheck");
  const result = await run(adapter, unit);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(
    logRecords(unit).map((entry) => entry["event"]).slice(-2),
    ["execution.started", "execution.completed"],
  );
  unit.cleanup?.();
});

/**
 * The precheck is handed the approved bytes or it is not run at all (APRV-276).
 *
 * A precheck reasons ABOUT the payload — AgentMail compares the live draft
 * against it — so bytes the log never bound make its answer meaningless: a
 * refusal would describe the caller's own edit in the far side's vocabulary,
 * and `payload-mismatch` is the runtime's word for that fact. `startExecution`
 * keeps sole authority over it, and the adapter is not consulted, does not
 * reach the far side, and cannot dress the refusal up as its own.
 */
test("a payload the grant did not bind to never reaches the precheck", async () => {
  const unit = granted();
  const adapter = mockAdapter();
  const before = readFileSync(unit.logPath, "utf8");
  let asked = 0;

  const watching: MockAdapter = {
    ...adapter,
    precheck(): PrecheckOutcome {
      asked += 1;
      return { ok: false, code: "far-side-moved", message: "the object under the grant changed" };
    },
  };

  const tampered: JsonValue = { approved: unit.payload, tampered: "after the human said yes" };
  const result = await executeThroughAdapter(
    watching,
    { logPath: unit.logPath, actionKey: unit.actionKey, payload: tampered, actor: unit.actor },
    options(unit),
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "payload-mismatch", `wrong refusal code: ${result.code}`);
    assert.equal(result.acted, false);
  }
  assert.equal(asked, 0, "the precheck was asked about bytes no human approved");
  assert.equal(adapter.sends.length, 0);
  assert.equal(readFileSync(unit.logPath, "utf8"), before, "a payload-mismatch wrote to the log");

  // And the grant is intact: the approved bytes still execute under it.
  const good = await run(adapter, unit);
  assert.equal(good.ok, true, `the retained token was refused: ${JSON.stringify(good)}`);
  unit.cleanup?.();
});

test("an adapter that declares no credentials keeps the ordering it always had", async () => {
  const unit = granted();
  const declaring: Adapter = {
    name: "declares-nothing",
    classes: [MOCK_CLASS],
    act(input: ActInput): ActOutcome {
      const got = input.credentials.get("never-stored");
      return got.ok
        ? { ok: true }
        : { ok: false, code: got.code, message: `no credential: ${got.message}` };
    },
  };

  const result = await run(declaring, unit, { credentials: inMemoryCredentials({}) });
  assert.equal(result.ok, false);
  if (!result.ok) {
    // Nothing was declared, so nothing was resolved early: act ran, asked, and
    // the failure is the adapter's own, recorded as execution.failed.
    assert.equal(result.code, "adapter-failed", `wrong refusal: ${result.code}`);
    assert.equal(result.acted, true);
    assert.equal(result.outcome, "execution.failed");
  }
  unit.cleanup?.();
});

test("a provider that throws during resolution is a refusal, not an exception", async () => {
  const unit = granted();
  const hostile: CredentialProvider = {
    get(): never {
      throw new Error("the vault file is a directory");
    },
  };
  const before = readFileSync(unit.logPath, "utf8");

  const result = await run(mockAdapter(), unit, { credentials: hostile });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "credential-unavailable");
    assert.equal(result.acted, false);
  }
  assert.equal(readFileSync(unit.logPath, "utf8"), before, "a throwing provider wrote to the log");
  unit.cleanup?.();
});

test("the provider handed to act refuses once act has returned", async () => {
  const unit = granted();
  const stash: { provider: CredentialProvider | null } = { provider: null };
  const adapter: Adapter = {
    name: "stasher",
    classes: [MOCK_CLASS],
    act(input: ActInput): ActOutcome {
      stash.provider = input.credentials;
      assert.equal(input.credentials.get(MOCK_CREDENTIAL).ok, true, "the window was shut too early");
      return { ok: true };
    },
  };

  const result = await run(adapter, unit);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.notEqual(stash.provider, null);

  const late = (stash.provider as CredentialProvider).get(MOCK_CREDENTIAL);
  assert.equal(late.ok, false, "a stashed provider still answered after the execution closed");
  if (!late.ok) assert.equal(late.code, "credential-window-closed");
});

// ---------------------------------------------------------------------------
// 3d. The adapter's own step: failure, and throwing
// ---------------------------------------------------------------------------

test("a reported failure closes the execution as failed and keeps the adapter's code", async () => {
  const unit = granted();
  const result = await run(
    mockAdapter({ fail: { code: "smtp-550", message: "mailbox unavailable" } }),
    unit,
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "adapter-failed");
    assert.equal(result.adapter_code, "smtp-550");
    assert.equal(result.message, "mailbox unavailable");
    assert.equal(result.exit_code, 1);
    assert.equal(result.outcome, "execution.failed");
    assert.ok(result.started_seq !== undefined && result.outcome_seq !== undefined);
  }
});

/** Every record in `unit`'s log, as parsed objects. */
function logRecords(unit: AdapterConformanceCase): Record<string, unknown>[] {
  return readFileSync(unit.logPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("a throw from INSIDE act is indeterminate, message only, closed reason only", async () => {
  // APRV-120, the far side of the boundary: `act` was entered and raised, so
  // the provider may or may not have committed and the log says exactly that.
  // Recording it as `failed` is the sentence that makes a retry look safe.
  const unit = granted();
  const result = await run(mockAdapter({ throws: `upstream refused ${SECRET}` }), unit);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "execution-indeterminate");
    assert.equal(result.outcome, "execution.indeterminate");
    assert.equal(result.acted, true);
    // The message, redacted, reaches the CALLER — and never the stack, which
    // quotes call arguments.
    assert.ok(
      result.message.includes(`upstream refused ${REDACTION_PLACEHOLDER}`),
      `the adapter's message did not reach the caller: ${result.message}`,
    );
    assert.equal(result.message.includes("\n    at "), false, "a stack frame rode out");
    assert.ok(result.redactions >= 1);
  }

  // …and the RECORD carries the closed code and nothing else. An exception's
  // text in an append-only log is a credential leak with a plausible excuse.
  const raw = readFileSync(unit.logPath, "utf8");
  assert.equal(raw.includes(SECRET), false);
  assert.equal(raw.includes("upstream refused"), false, "exception text reached the log");
  const record = logRecords(unit).find(
    (entry) => entry["event"] === "execution.indeterminate",
  );
  assert.notEqual(record, undefined, "no execution.indeterminate was appended");
  assert.deepEqual(record?.["payload"], { reason: "act-threw", exit_code: null });
});

test("a throw on the way INTO act is a failure: nothing was attempted", async () => {
  // The near side of the same boundary, and the reason it is positional rather
  // than a judgment about the error: reading the adapter's own method is the
  // last thing this runtime does before the call becomes the far side's.
  const unit = granted();
  const broken: Adapter = {
    name: "mock-email",
    classes: [MOCK_CLASS],
    get act(): Adapter["act"] {
      throw new Error(`could not reach act ${SECRET}`);
    },
  };

  const result = await run(broken, unit);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "adapter-act-threw");
    assert.equal(result.outcome, "execution.failed");
    assert.equal(result.acted, false, "nothing was attempted, so nothing was acted");
  }
  assert.notEqual(
    logRecords(unit).find((entry) => entry["event"] === "execution.failed"),
    undefined,
    "no execution.failed was appended",
  );
  assert.equal(readFileSync(unit.logPath, "utf8").includes(SECRET), false);
});

test("an indeterminate outcome burns the key: a re-run is refused with its own code", async () => {
  const unit = granted();
  await run(mockAdapter({ throws: "upstream refused" }), unit);
  const before = readFileSync(unit.logPath, "utf8");

  const again = await run(mockAdapter(), unit);
  assert.equal(again.ok, false);
  if (!again.ok) {
    assert.equal(again.code, "execution-indeterminate");
    assert.equal(again.acted, false, "the retry reached act");
  }
  assert.equal(readFileSync(unit.logPath, "utf8"), before, "a refused retry wrote to the log");
});

// ---------------------------------------------------------------------------
// 3e. Refusals that append nothing
// ---------------------------------------------------------------------------

test("an unhashable payload refuses before the log is read", async () => {
  const unit = granted();
  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  const before = readFileSync(unit.logPath, "utf8");

  const result = await executeThroughAdapter(
    mockAdapter(),
    {
      logPath: unit.logPath,
      actionKey: unit.actionKey,
      payload: cyclic as unknown as JsonValue,
      actor: unit.actor,
    },
    options(unit),
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "payload-unhashable");
    assert.equal(result.acted, false);
  }
  assert.equal(readFileSync(unit.logPath, "utf8"), before, "an unhashable payload touched the log");
});

test("an unregistered action key refuses without appending", async () => {
  const unit = granted();
  const before = readFileSync(unit.logPath, "utf8");

  const result = await executeThroughAdapter(
    mockAdapter(),
    {
      logPath: unit.logPath,
      actionKey: `${unit.actionKey}-nope`,
      payload: unit.payload,
      actor: unit.actor,
    },
    options(unit),
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "action-not-registered");
    assert.equal(result.acted, false);
  }
  assert.equal(readFileSync(unit.logPath, "utf8"), before);
});

test("a caller-supplied payload hash cannot override the recomputed one", async () => {
  const unit = granted();
  const other = payloadFor(9999);
  const result = await executeThroughAdapter(
    mockAdapter(),
    { logPath: unit.logPath, actionKey: unit.actionKey, payload: other, actor: unit.actor },
    // The grant's own hash, presented for bytes that are not it. The contract
    // ignores the field and hashes the payload it was handed.
    options(unit, { presentedPayloadHash: payloadHash(unit.payload) }),
  );

  assert.equal(result.ok, false, "a stated hash must not stand in for the bytes");
  if (!result.ok) {
    assert.equal(result.code, "payload-mismatch");
    assert.equal(result.acted, false);
  }
});

// ---------------------------------------------------------------------------
// 3f. The log after a full pass
// ---------------------------------------------------------------------------

test("a completed adapter execution leaves a clean chain and the two events", async () => {
  const unit = granted();
  const adapter = mockAdapter();
  const result = await run(adapter, unit);

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(adapter.sends.length, 1, "the mock did not send");
  assert.deepEqual(adapter.sends[0]?.payload, unit.payload);

  const lines = readFileSync(unit.logPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { event: string });
  assert.deepEqual(lines.map((line) => line.event), [
    "policy.updated",
    "task.registered",
    "approval.requested",
    "approval.granted",
    "execution.started",
    "execution.completed",
  ]);
  assert.equal(verify(unit.logPath).status, "clean", "the chain did not verify after an execution");
});

// ---------------------------------------------------------------------------
// 4. The agentmail adapter, against the same suite (APRV-222)
// ---------------------------------------------------------------------------

/**
 * The AgentMail adapter runs the shared suite here rather than only in its own
 * file, so that the two adapters this repository ships are held to the contract
 * side by side and a change to the contract fails against both at once.
 *
 * Everything it touches is the loopback mock in `agentmail-mock.ts`, whose
 * `assertLocal` is called on the `apiBase` below: no check in this file reaches
 * the network.
 */
const AGENTMAIL_KEY = "am-key-conformance-4d17ba-DO-NOT-USE";
const AGENTMAIL_INBOX = "conformance@agentmail.invalid";

const agentmailMock = await startMockAgentmail({
  apiKey: AGENTMAIL_KEY,
  inboxId: AGENTMAIL_INBOX,
});
after(() => agentmailMock.close());

let agentmailCounter = 0;

const AGENTMAIL_CONFORMANCE: AdapterConformanceHarness = {
  setup: () => {
    agentmailCounter += 1;
    return granted(AGENTMAIL_CLASS, {
      from: AGENTMAIL_INBOX,
      to: [`ap-${String(agentmailCounter)}@vendor.invalid`],
      subject: `Invoice ${String(agentmailCounter)} chaser`,
      body: `Following up on invoice ${String(agentmailCounter)}.`,
    });
  },
  // The one the suite hunts for in the log and in every field of the result.
  credential: { name: DEFAULT_AGENTMAIL_CREDENTIAL_NAMES.apiKey, value: AGENTMAIL_KEY },
  get credentials() {
    return { [DEFAULT_AGENTMAIL_CREDENTIAL_NAMES.inboxId]: AGENTMAIL_INBOX };
  },
  foreignClass: "financial.spend",
  // APRV-245. The optional `observe` check counts the far side's writes on both
  // sides of the call, so "it did not POST" rests on the fixture's own tally
  // rather than only on the log being unchanged.
  observeProbe: {
    writes: () => agentmailMock.posts().length,
  },
};

test("the agentmail adapter conforms to the adapter contract", async (t) => {
  await runAdapterConformance(
    t,
    () => agentmailAdapter({ apiBase: assertAgentmailLocal(agentmailMock.url), timeoutMs: 5_000 }),
    AGENTMAIL_CONFORMANCE,
  );
});
