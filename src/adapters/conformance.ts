/**
 * The shared adapter conformance suite (SPEC.md §10.4, §11.1).
 *
 * `channels/conformance.ts` exists because SPEC.md §9 names a display rule and
 * then names its consequence: rendering claimed fields as computed "is a
 * conformance failure for a channel". This module is the same idea one boundary
 * further out. §10.4 says an adapter "MUST require a valid, unexpired,
 * single-use execution token bound to the action's `idempotency_key`", and the
 * only way to find out whether a given adapter does is to hand it a bad token
 * and watch.
 *
 * What is being tested is mostly **the contract**, not the adapter: an adapter
 * that goes through {@link executeThroughAdapter} inherits the sequence and
 * cannot skip a step. That is the point. The suite is what turns "cannot skip"
 * from an assertion in a module header into a thing someone has watched fail,
 * and it is what a third-party adapter runs to learn whether it is wired into
 * the gate or merely near it.
 *
 * ## What it checks
 *
 * 1. **Bad token, no side effect.** A garbage token refuses and `act` is never
 *    called. The log is unchanged.
 * 2. **Wrong bytes, no side effect.** A payload that is not the approved one
 *    refuses `payload-mismatch`, `act` is never called, the token stays live.
 * 3. **Wrong class, nothing appended.** An adapter that does not serve the
 *    declared class refuses `adapter-class-mismatch` before the log is touched.
 * 4. **`started` precedes the effect.** On the happy path `act` observes an
 *    `execution.started` for its own key already in the verified log at the
 *    moment it is called, and `execution.completed` lands after it returns. The
 *    same check reads the provider reference of APRV-251 off that record: a
 *    detail naming one is on the record under this adapter's name, and a detail
 *    naming none leaves the record carrying none.
 * 5. **Single use.** A second execution with the same token and key refuses
 *    without calling `act`.
 * 6. **Credentials are scoped and never leak.** A value handed out inside `act`
 *    appears in no log line and in no field of the result, and the provider
 *    refuses once `act` has returned.
 * 7. **Failure is recorded, not swallowed.** An adapter reporting failure
 *    produces `execution.failed` and an `adapter-failed` refusal.
 *
 * The chain is verified after every check.
 *
 * ## How it is run
 *
 * ```ts
 * test("my adapter conforms", async (t) => {
 *   await runAdapterConformance(t, () => new MyAdapter(), harness);
 * });
 * ```
 *
 * As in the channel suite, `t` is used only for `diagnostic()` labels: the
 * checks run inline and **throw** on the first failure, so
 * `tests/adapters-contract.test.ts` can assert the suite goes RED against
 * deliberately broken adapters. A conformance suite nobody has watched fail is a
 * suite that might pass anything.
 *
 * Several checks wrap the adapter under test in a hostile shell — one that reads
 * a credential it was not asked to read, one that returns the secret inside its
 * own detail, one that reports failure. The wrapper delegates to the real `act`
 * where the check allows it. Wrapping rather than requiring cooperation is what
 * lets the suite test properties (scoping, redaction) that a well-behaved
 * adapter would never exercise on its own.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { ProviderRef } from "../core/execute.js";
import { payloadOf, readVerifiedRecords } from "../core/state.js";
import { verify } from "../core/verify.js";
import {
  executeThroughAdapter,
  inMemoryCredentials,
  providerRefFor,
  type ActInput,
  type ActOutcome,
  type Adapter,
  type AdapterExecuteOptions,
  type AdapterExecuteResult,
  type CredentialProvider,
  type JsonValue,
} from "./contract.js";

/** Anything with a `diagnostic` method — `node:test`'s `TestContext` qualifies. */
export interface ConformanceContext {
  diagnostic?(message: string): void;
}

/**
 * One scenario the harness prepares: a real log carrying a real grant, built
 * through the real gate, and the token that grant printed.
 *
 * Everything here is a fact about the world the suite executes against. The
 * suite never builds a grant itself and never hand-writes a log line; a
 * conformance suite that fabricated its own authorization would be testing the
 * fabrication.
 */
export interface AdapterConformanceCase {
  /** Path to a real `events.jsonl` holding a granted, unspent manual action. */
  logPath: string;
  actionKey: string;
  /** The bytes the grant bound to. Must hash to the grant's `payload_hash`. */
  payload: JsonValue;
  /** The raw single-use token `approval grant` printed. */
  token: string;
  /** The executing identity: `agent:<id>` or `human:<id>`. */
  actor: string;
  /** The class the action was declared under; the adapter must serve it. */
  class: string;
  /** Policy location, schema dir, injected clock. Merged into every call. */
  options?: AdapterExecuteOptions;
  /** Called when the suite is done with this case. */
  cleanup?(): void;
}

/**
 * What an adapter's test file must provide.
 *
 * `setup()` returns a *fresh* case each call: a token is single-use, so the
 * suite cannot reuse one across checks. `credential` names a secret the suite
 * will ask for from inside `act` and then hunt for in the log and the result;
 * its value must be a distinctive string that could not occur by accident.
 * A class the adapter does NOT serve is needed for the routing check, and
 * `foreignClass` supplies it.
 */
export interface AdapterConformanceHarness {
  setup(): AdapterConformanceCase | Promise<AdapterConformanceCase>;
  credential: { name: string; value: string };
  /**
   * Everything else the adapter needs to reach its far side — a host, a port, a
   * transport setting, a second half of a login.
   *
   * A real adapter rarely needs exactly one credential (the email adapter needs
   * five), and the checks that must SUCCEED — the happy path, single use, the
   * live token after a payload mismatch — cannot succeed against an adapter that
   * cannot configure itself. `credential` stays the one the suite hunts for in
   * the log and the result; these are merely present, and `credential` wins any
   * collision so the hunted value cannot be shadowed. (Added APRV-69.)
   */
  credentials?: Readonly<Record<string, string>>;
  /** A declared class this adapter must refuse. Defaults to a synthetic one. */
  foreignClass?: string;
  /**
   * What the optional `observe` check needs (APRV-245). Ignored by an adapter
   * that implements no `observe`.
   *
   * `writes` is how the fixture reports the number of WRITE requests its far
   * side has received; the check reads it before and after and requires the
   * number not to move. Without it the check still runs and still proves the
   * log was untouched, but the "did not POST" claim rests on the log alone, so
   * an adapter with a reachable fixture should supply it.
   */
  observeProbe?: {
    /** The window to ask about. Defaults to one wide enough to include anything. */
    window?: { since: string; until: string };
    /** Write requests the far side has received so far. */
    writes?(): number;
  };
}

/** An adapter wrapped so the suite can see whether `act` ran, and with what. */
interface Spy {
  adapter: Adapter;
  calls: ActInput[];
}

function say(t: ConformanceContext, message: string): void {
  t.diagnostic?.(`adapter conformance: ${message}`);
}

/**
 * Wrap `adapter` so every call is recorded and `before` (if given) runs inside
 * the credential window, where the suite can observe the log and the provider.
 */
function spyOn(adapter: Adapter, before?: (input: ActInput) => void): Spy {
  const calls: ActInput[] = [];
  return {
    calls,
    // SPREAD, never a fresh `{name, classes, act}` literal (APRV-245). The
    // contract gained optional members — `requiredCredentials`, `observe` — and
    // a wrapper that rebuilt the object from three fields would quietly test an
    // adapter the caller never wrote: the one under test minus everything
    // optional it declares.
    adapter: {
      ...adapter,
      async act(input: ActInput): Promise<ActOutcome> {
        calls.push(input);
        before?.(input);
        return await adapter.act(input);
      },
    },
  };
}

/**
 * The options every check passes: whatever the harness configured, the token
 * under test, and a provider holding the harness's credential.
 *
 * The provider is supplied on every call, including the checks that expect a
 * refusal, so that an adapter which legitimately needs a secret to act is not
 * failed for the absence of one. Whether the secret is reachable is check (6)'s
 * question, not check (1)'s.
 */
function callOptions(
  unit: AdapterConformanceCase,
  harness: AdapterConformanceHarness,
  token: string,
): AdapterExecuteOptions {
  return {
    ...unit.options,
    token,
    credentials: inMemoryCredentials({
      ...harness.credentials,
      // Last, so the hunted value cannot be shadowed by a configuration entry.
      [harness.credential.name]: harness.credential.value,
    }),
  };
}

/** Records currently in the log; the suite counts them before and after. */
function recordsOf(logPath: string) {
  const read = readVerifiedRecords(logPath);
  assert.equal(read.ok, true, `conformance log does not verify: ${JSON.stringify(read)}`);
  return read.ok ? read.records : [];
}

/**
 * What the contract should have lifted from this detail (APRV-251), computed by
 * the very function that lifts it.
 *
 * Asking the contract rather than re-deriving the rule is the point: an adapter
 * is conformant when the record agrees with the contract's own reading of its
 * detail, and a suite that spelled the rule a second time would eventually
 * disagree with the runtime and fail an adapter that had done nothing wrong.
 *
 * The detail here is the REDACTED copy the result carried, and this check runs
 * against an adapter that leaked nothing (check (6) is where a leak is hunted),
 * so both copies are the same bytes and passing one twice asks the same
 * question the contract asked.
 */
function expectedProviderRef(adapterName: string, detail: JsonValue | undefined): ProviderRef | null {
  if (detail === undefined) return null;
  return providerRefFor(adapterName, detail, detail);
}

function assertClean(logPath: string): void {
  const result = verify(logPath);
  assert.equal(result.status, "clean", `chain not clean: ${JSON.stringify(result)}`);
}

/**
 * Run the suite. Resolves when every check passes; throws (an `AssertionError`)
 * on the first failure.
 */
export async function runAdapterConformance(
  t: ConformanceContext,
  makeAdapter: () => Adapter,
  harness: AdapterConformanceHarness,
): Promise<void> {
  await checkBadToken(t, makeAdapter, harness);
  await checkWrongPayload(t, makeAdapter, harness);
  await checkWrongClass(t, makeAdapter, harness);
  await checkHappyPath(t, makeAdapter, harness);
  await checkSingleUse(t, makeAdapter, harness);
  await checkCredentialScope(t, makeAdapter, harness);
  await checkReportedFailure(t, makeAdapter, harness);
  await checkObserve(t, makeAdapter, harness);
}

// ---------------------------------------------------------------------------
// (8) observe, when the adapter offers one, reads and does not write (APRV-245)
// ---------------------------------------------------------------------------

/**
 * The optional `observe` (SPEC.md §10.4, APRV-245).
 *
 * SKIPPED for an adapter that declares none — it is optional, and an adapter
 * without it is conformant. For one that declares it, three properties, and
 * each is the failure somebody would otherwise ship:
 *
 * - **It does not write.** A coverage read that sent something would be the
 *   worst defect this contract could carry. The harness's `writes()` counts the
 *   far side's write requests where the fixture can see them (the AgentMail mock
 *   counts POSTs), and the log is counted on both sides regardless: no record is
 *   appended by a read.
 * - **It does not throw.** A reporting verb calls this, and an adapter whose
 *   far side is quiet must answer "nothing" rather than take the report down.
 *   A configured harness reaching a live fixture has no excuse to throw.
 * - **Every effect carries a class the adapter serves.** An effect of a class
 *   this adapter does not handle is an effect it cannot have observed, and
 *   admitting one would let a source contribute rows nothing could ever cover.
 */
async function checkObserve(
  t: ConformanceContext,
  makeAdapter: () => Adapter,
  harness: AdapterConformanceHarness,
): Promise<void> {
  const adapter = makeAdapter();
  if (adapter.observe === undefined) {
    say(t, "observe() is not implemented; the optional read is skipped");
    return;
  }
  say(t, "observe() reads: no write to the far side, no throw, and only its own classes");
  const unit = await harness.setup();
  try {
    const probe = harness.observeProbe;
    const writesBefore = probe?.writes?.() ?? 0;
    const recordsBefore = recordsOf(unit.logPath).length;
    const window = probe?.window ?? {
      since: "1970-01-01T00:00:00Z",
      until: "2999-12-31T23:59:59Z",
    };

    const effects = await adapter.observe(
      window,
      inMemoryCredentials({
        ...harness.credentials,
        [harness.credential.name]: harness.credential.value,
      }),
    );

    assert.equal(
      probe?.writes?.() ?? 0,
      writesBefore,
      "observe() made a write request against the far side; it is a READ, called outside any grant window and with no token (SPEC.md §10.4)",
    );
    assert.equal(
      recordsOf(unit.logPath).length,
      recordsBefore,
      "observe() appended to the log; a coverage read records nothing",
    );
    for (const effect of effects) {
      assert.ok(
        adapter.classes.includes(effect.class),
        `observe() returned an effect of class ${JSON.stringify(effect.class)}, which this adapter does not serve`,
      );
      assert.ok(effect.id.length > 0, "an observed effect must carry the provider's own id");
      assert.ok(effect.source.length > 0, "an observed effect must name its source");
    }
    assertClean(unit.logPath);
  } finally {
    unit.cleanup?.();
  }
}

// ---------------------------------------------------------------------------
// (1) a bad token never reaches act
// ---------------------------------------------------------------------------

async function checkBadToken(
  t: ConformanceContext,
  makeAdapter: () => Adapter,
  harness: AdapterConformanceHarness,
): Promise<void> {
  say(t, "a token that is not the minted one refuses, and act never runs");
  const unit = await harness.setup();
  try {
    const spy = spyOn(makeAdapter());
    const before = recordsOf(unit.logPath).length;
    const result = await executeThroughAdapter(
      spy.adapter,
      { logPath: unit.logPath, actionKey: unit.actionKey, payload: unit.payload, actor: unit.actor },
      callOptions(unit, harness, "not-the-token"),
    );

    assert.equal(result.ok, false, "a bad token must not produce a completed execution");
    if (!result.ok) {
      assert.equal(result.code, "token-mismatch", `wrong refusal code: ${result.code}`);
      assert.equal(result.acted, false, "the refusal must say no side effect was attempted");
    }
    assert.equal(spy.calls.length, 0, "act() ran on an unauthorized token (SPEC.md §10.4)");
    assert.equal(recordsOf(unit.logPath).length, before, "a refused execution appended a record");
    assertClean(unit.logPath);
  } finally {
    unit.cleanup?.();
  }
}

// ---------------------------------------------------------------------------
// (2) the wrong bytes never reach act
// ---------------------------------------------------------------------------

async function checkWrongPayload(
  t: ConformanceContext,
  makeAdapter: () => Adapter,
  harness: AdapterConformanceHarness,
): Promise<void> {
  say(t, "a payload the grant did not bind to refuses payload-mismatch");
  const unit = await harness.setup();
  try {
    const spy = spyOn(makeAdapter());
    const before = recordsOf(unit.logPath).length;
    const tampered: JsonValue = { approved: unit.payload, tampered: "after the human said yes" };
    const result = await executeThroughAdapter(
      spy.adapter,
      { logPath: unit.logPath, actionKey: unit.actionKey, payload: tampered, actor: unit.actor },
      callOptions(unit, harness, unit.token),
    );

    assert.equal(result.ok, false, "different bytes must not execute against an old grant");
    if (!result.ok) {
      assert.equal(result.code, "payload-mismatch", `wrong refusal code: ${result.code}`);
      assert.equal(result.acted, false, "the refusal must say no side effect was attempted");
    }
    assert.equal(spy.calls.length, 0, "act() ran on bytes no human approved (SPEC.md §10.4)");
    assert.equal(recordsOf(unit.logPath).length, before, "a refused execution appended a record");

    // The token is still live: the repair is a new request for the new payload.
    const good = await executeThroughAdapter(
      spyOn(makeAdapter()).adapter,
      { logPath: unit.logPath, actionKey: unit.actionKey, payload: unit.payload, actor: unit.actor },
      callOptions(unit, harness, unit.token),
    );
    assert.equal(
      good.ok,
      true,
      `a payload-mismatch must leave the token live: ${JSON.stringify(good)}`,
    );
    assertClean(unit.logPath);
  } finally {
    unit.cleanup?.();
  }
}

// ---------------------------------------------------------------------------
// (3) the wrong adapter appends nothing
// ---------------------------------------------------------------------------

async function checkWrongClass(
  t: ConformanceContext,
  makeAdapter: () => Adapter,
  harness: AdapterConformanceHarness,
): Promise<void> {
  say(t, "an adapter that does not serve the declared class refuses, log untouched");
  const unit = await harness.setup();
  try {
    const base = makeAdapter();
    const foreign: Adapter = {
      ...base,
      classes: [harness.foreignClass ?? "conformance.class.this-adapter-does-not-serve"],
      act: base.act.bind(base),
    };
    assert.ok(
      !foreign.classes.includes(unit.class),
      "harness.foreignClass names the class under test; it must name one the adapter does not serve",
    );
    const spy = spyOn(foreign);

    const before = recordsOf(unit.logPath).length;
    const result = await executeThroughAdapter(
      spy.adapter,
      { logPath: unit.logPath, actionKey: unit.actionKey, payload: unit.payload, actor: unit.actor },
      callOptions(unit, harness, unit.token),
    );

    assert.equal(result.ok, false, "a misrouted action must not execute");
    if (!result.ok) {
      assert.equal(result.code, "adapter-class-mismatch", `wrong refusal code: ${result.code}`);
      assert.equal(result.acted, false, "the refusal must say no side effect was attempted");
    }
    assert.equal(spy.calls.length, 0, "act() ran for a class the adapter does not serve");
    assert.equal(
      recordsOf(unit.logPath).length,
      before,
      "a misrouted action appended a record; a wiring mistake must not spend a token",
    );
    assertClean(unit.logPath);
  } finally {
    unit.cleanup?.();
  }
}

// ---------------------------------------------------------------------------
// (4) started precedes the side effect
// ---------------------------------------------------------------------------

async function checkHappyPath(
  t: ConformanceContext,
  makeAdapter: () => Adapter,
  harness: AdapterConformanceHarness,
): Promise<void> {
  say(t, "execution.started is in the log before act runs, completed after");
  const unit = await harness.setup();
  try {
    let sawStart = false;
    const spy = spyOn(makeAdapter(), () => {
      sawStart = recordsOf(unit.logPath).some(
        (record) => record.event === "execution.started" && record.action_key === unit.actionKey,
      );
    });

    const result = await executeThroughAdapter(
      spy.adapter,
      { logPath: unit.logPath, actionKey: unit.actionKey, payload: unit.payload, actor: unit.actor },
      callOptions(unit, harness, unit.token),
    );

    assert.equal(result.ok, true, `the granted action was refused: ${JSON.stringify(result)}`);
    assert.equal(spy.calls.length, 1, "act() must be called exactly once for a granted action");
    assert.equal(
      sawStart,
      true,
      "act() ran before execution.started was in the log; a log that records an execution only once it succeeded cannot tell you about the one that did not (SPEC.md §10.4)",
    );

    const records = recordsOf(unit.logPath);
    const started = records.find(
      (record) => record.event === "execution.started" && record.action_key === unit.actionKey,
    );
    const completed = records.find(
      (record) => record.event === "execution.completed" && record.action_key === unit.actionKey,
    );
    assert.ok(started !== undefined, "no execution.started was appended");
    assert.ok(completed !== undefined, "no execution.completed was appended");
    assert.ok(started.seq < completed.seq, "the outcome must follow the start");
    if (result.ok) {
      assert.equal(result.started_seq, started.seq, "the result names the wrong start record");
      assert.equal(result.outcome_seq, completed.seq, "the result names the wrong outcome record");
      assert.equal(result.outcome, "execution.completed", "the result names the wrong outcome");
      assert.equal(result.exit_code, 0, "a completed execution records exit_code 0");
    }

    // The adapter saw the approved bytes, not a copy assembled from the log.
    const call = spy.calls[0];
    assert.ok(call !== undefined);
    assert.deepEqual(call.payload, unit.payload, "act() was handed different bytes");
    assert.equal(call.actionKey, unit.actionKey, "act() was handed a different action key");

    // The provider reference (APRV-251). An adapter that names one under the
    // conventional key gets it onto the record, under THIS adapter's name and
    // with the id unchanged; an adapter that names none gets a record carrying
    // no reference, which is the pre-amendment record and always valid. Both
    // directions are checked because both are ways to be wrong: a reference
    // quietly dropped sends `approval coverage` back to the class-and-window
    // rule without saying so, and a reference invented for an adapter that
    // named none puts a value in a join column that means nothing.
    const expected = expectedProviderRef(spy.adapter.name, result.ok ? result.detail : undefined);
    const recorded = payloadOf(completed)["provider_ref"];
    if (expected === null) {
      assert.equal(
        recorded,
        undefined,
        `execution.completed carries a provider_ref the adapter's detail never named: ${JSON.stringify(recorded)}`,
      );
    } else {
      assert.deepEqual(
        recorded,
        { adapter: expected.adapter, id: expected.id },
        "the detail named a provider reference and the record does not carry it (APRV-251)",
      );
      if (result.ok) {
        assert.deepEqual(
          result.provider_ref,
          expected,
          "the result must name the reference the record carries",
        );
      }
    }

    assertClean(unit.logPath);
  } finally {
    unit.cleanup?.();
  }
}

// ---------------------------------------------------------------------------
// (5) single use
// ---------------------------------------------------------------------------

async function checkSingleUse(
  t: ConformanceContext,
  makeAdapter: () => Adapter,
  harness: AdapterConformanceHarness,
): Promise<void> {
  say(t, "a second execution with the same token and key refuses without acting");
  const unit = await harness.setup();
  try {
    const first = await executeThroughAdapter(
      spyOn(makeAdapter()).adapter,
      { logPath: unit.logPath, actionKey: unit.actionKey, payload: unit.payload, actor: unit.actor },
      callOptions(unit, harness, unit.token),
    );
    assert.equal(first.ok, true, `the first execution was refused: ${JSON.stringify(first)}`);

    const spy = spyOn(makeAdapter());
    const before = recordsOf(unit.logPath).length;
    const second = await executeThroughAdapter(
      spy.adapter,
      { logPath: unit.logPath, actionKey: unit.actionKey, payload: unit.payload, actor: unit.actor },
      callOptions(unit, harness, unit.token),
    );

    assert.equal(second.ok, false, "an idempotency key is single-use (SPEC.md §6.2, §7)");
    if (!second.ok) {
      assert.ok(
        second.code === "token-consumed" || second.code === "already-executed",
        `a replay must refuse token-consumed or already-executed, got ${second.code}`,
      );
      assert.equal(second.acted, false, "the replay attempted the side effect a second time");
    }
    assert.equal(spy.calls.length, 0, "act() ran twice for one idempotency key");
    assert.equal(recordsOf(unit.logPath).length, before, "a refused replay appended a record");
    assertClean(unit.logPath);
  } finally {
    unit.cleanup?.();
  }
}

// ---------------------------------------------------------------------------
// (6) credentials: scoped in time, absent from everything written
// ---------------------------------------------------------------------------

async function checkCredentialScope(
  t: ConformanceContext,
  makeAdapter: () => Adapter,
  harness: AdapterConformanceHarness,
): Promise<void> {
  say(t, "a credential read inside act reaches no log line and no result field");
  const unit = await harness.setup();
  const { name, value } = harness.credential;
  assert.ok(value.length >= 8, "harness.credential.value must be distinctive enough to hunt for");
  try {
    const base = makeAdapter();
    // A hostile shell: it reads the secret, keeps the provider, and then tries
    // to publish the secret through its own outcome. Every one of those is a
    // thing a careless adapter does by accident.
    let escaped: unknown = null;
    let stashed: CredentialProvider | null = null;
    const leaky: Adapter = {
      ...base,
      async act(input: ActInput): Promise<ActOutcome> {
        stashed = input.credentials;
        const got = input.credentials.get(name);
        escaped = got;
        assert.equal(got.ok, true, `the credential window refused inside act: ${JSON.stringify(got)}`);
        await base.act(input);
        return { ok: true, detail: { note: `authenticated with ${value}`, [value]: "as a key too" } };
      },
    };

    const result = await executeThroughAdapter(
      leaky,
      { logPath: unit.logPath, actionKey: unit.actionKey, payload: unit.payload, actor: unit.actor },
      callOptions(unit, harness, unit.token),
    );
    assert.equal(result.ok, true, `the granted action was refused: ${JSON.stringify(result)}`);
    assert.notEqual(escaped, null, "the hostile wrapper never asked for the credential");

    // Nothing the contract returns carries the secret.
    const serialized = JSON.stringify(result);
    assert.equal(
      serialized.includes(value),
      false,
      `the execution result carries the raw credential (SPEC.md §11.1 invariant 3): ${serialized}`,
    );
    if (result.ok) {
      assert.ok(
        result.redactions > 0,
        "the contract redacted nothing although the adapter published the secret; a silent pass here means the guard is not running",
      );
    }

    // Nothing the log holds carries the secret, on any line.
    const raw = readFileSync(unit.logPath, "utf8");
    assert.equal(
      raw.includes(value),
      false,
      "a raw credential value appears in the log (SPEC.md §11.1 invariant 3)",
    );

    // And the window is shut: the provider the adapter kept is the same object
    // it held inside act, and it now refuses. This is read after the execution
    // returned rather than from a deferred callback inside act, because a
    // microtask queued inside act runs before the await that closes the window
    // and would test the wrong instant.
    assert.notEqual(stashed, null, "the hostile wrapper never kept the provider");
    const late = (stashed as unknown as CredentialProvider).get(name);
    assert.equal(late.ok, false, "the credential provider still answered after act() returned");
    if (!late.ok) {
      assert.equal(
        late.code,
        "credential-window-closed",
        `a post-window read must refuse credential-window-closed, got ${late.code}`,
      );
    }

    assertClean(unit.logPath);
  } finally {
    unit.cleanup?.();
  }
}

// ---------------------------------------------------------------------------
// (7) a reported failure is recorded, not swallowed
// ---------------------------------------------------------------------------

async function checkReportedFailure(
  t: ConformanceContext,
  makeAdapter: () => Adapter,
  harness: AdapterConformanceHarness,
): Promise<void> {
  say(t, "an adapter that reports failure produces execution.failed");
  const unit = await harness.setup();
  try {
    const base = makeAdapter();
    const failing: Adapter = {
      ...base,
      act(): ActOutcome {
        return { ok: false, code: "upstream-rejected", message: "the far side said no" };
      },
    };

    const result: AdapterExecuteResult = await executeThroughAdapter(
      failing,
      { logPath: unit.logPath, actionKey: unit.actionKey, payload: unit.payload, actor: unit.actor },
      callOptions(unit, harness, unit.token),
    );

    assert.equal(result.ok, false, "a failed act must not report a completed execution");
    if (!result.ok) {
      assert.equal(result.code, "adapter-failed", `wrong refusal code: ${result.code}`);
      assert.equal(result.acted, true, "the side effect was attempted and the result must say so");
      assert.equal(result.adapter_code, "upstream-rejected", "the adapter's own code was lost");
      assert.equal(result.outcome, "execution.failed", "the wrong outcome was recorded");
    }

    const records = recordsOf(unit.logPath);
    const failed = records.find(
      (record) => record.event === "execution.failed" && record.action_key === unit.actionKey,
    );
    assert.ok(failed !== undefined, "no execution.failed was appended for a failed act()");
    assertClean(unit.logPath);
  } finally {
    unit.cleanup?.();
  }
}
