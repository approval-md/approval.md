/**
 * `indexDeclarations` (APRV-211): the per-call derivation `core/audit.ts` reads
 * the log through, pinned against the per-key helpers it replaced.
 *
 * The index exists for speed and must be provable, so this suite asserts
 * EQUIVALENCE and nothing else. Two claims:
 *
 * 1. **Key by key.** For every action key the log carries — and for a key it
 *    does not — the index's three answers are exactly what `findDeclaration`,
 *    `declaringTasks` and `hasApprovalCycle` return for that key. Those three
 *    remain the gate's API; if the index ever disagreed with one of them, the
 *    audit sweep and the executor would be reading two different logs.
 * 2. **End to end.** `supervisedExecutions` over the same log deep-equals a
 *    reference implementation of its PREVIOUS algorithm, re-implemented inline
 *    below out of the per-key helpers. That is what makes the refactor provably
 *    a refactor rather than a rewrite that happens to pass the old cases.
 *
 * Every record is produced by the real append path (`core/gate.ts`,
 * `core/execute.ts` through `tests/clock-adapters.ts`); nothing here hand-writes
 * a log line, and the chain is walked at the end.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";

import { supervisedExecutions, type AuditCandidate } from "../src/core/audit.js";
import {
  declaringTasks,
  findDeclaration,
  hasApprovalCycle,
  indexDeclarations,
} from "../src/core/execute.js";
import type { EventRecord } from "../src/core/log.js";
import { loadPolicy, type PolicyLoadResult } from "../src/core/policy-load.js";
import { resolve } from "../src/core/policy-match.js";
import { register, request, startExecution } from "./clock-adapters.js";
import {
  assertClean,
  at,
  attest,
  newScenario,
  records,
  scratchRoot,
  T0,
  type Scenario,
} from "./scenario.js";

const scratch = scratchRoot("audit-index");

after(() => {
  scratch.cleanup();
});

function bindingFor(key: string): string {
  return createHash("sha256").update(`payload:${key}`, "utf8").digest("hex");
}

/** The classes the scenario policy knows, one of each autonomy. */
const CLASSES = ["read.inbox", "files.write.local", "communicate.email.external"] as const;

interface Action {
  class: string;
  summary: string;
  reversible: boolean;
  est_cost_usd: string;
  idempotency_key: string;
  payload_hash: string;
}

function action(key: string, cls: string): Action {
  return {
    class: cls,
    summary: `do ${key}`,
    reversible: cls !== "communicate.email.external",
    est_cost_usd: "0.01",
    idempotency_key: key,
    payload_hash: bindingFor(key),
  };
}

function registerTask(unit: Scenario, task: string, actions: Action[], minutes: number): boolean {
  const result = register(
    unit.logPath,
    {
      task,
      envelope: {
        origin: { app: "example-capture", created_by: "human:carter" },
        state: "proposed",
        actions,
      },
    },
    at(minutes),
    "agent:claude",
    unit.options,
  );
  return result.ok;
}

/**
 * The log every case reads: several tasks, several actions each, a duplicated
 * key offered across two tasks, a few approval cycles, and executions of both
 * supervised and autonomous actions.
 */
function fixture(): { unit: Scenario; keys: string[]; collision: string | null } {
  const unit = newScenario(scratch.root);
  attest(unit, T0);

  const keys: string[] = [];
  let minute = 1;
  for (const task of ["task-100", "task-200", "task-300"]) {
    const actions = CLASSES.map((cls, index) => {
      const key = `${task}:${cls.split(".")[0] ?? "act"}-${String(index)}`;
      keys.push(key);
      return action(key, cls);
    });
    // A second action in the same class, so a task declares more keys than the
    // index has classes and the "last declaration wins" rule has something to
    // chew on.
    const extra = `${task}:draft`;
    keys.push(extra);
    actions.push(action(extra, "files.write.local"));
    minute += 1;
    assert.equal(registerTask(unit, task, actions, minute), true, `${task} did not register`);
  }

  // A key already declared by task-100, offered again under a fourth task. The
  // registration boundary refuses cross-task collisions (APRV-138); if this log
  // ends up carrying one anyway, `declaringTasks` must see both and the index
  // must agree with it. Either outcome is a case.
  const duplicated = keys[0] as string;
  minute += 1;
  const collided = registerTask(
    unit,
    "task-400",
    [action(duplicated, "files.write.local")],
    minute,
  );

  // Approval cycles: the manual actions are requested and left pending.
  for (const key of keys.filter((entry) => entry.includes("communicate"))) {
    minute += 1;
    const requested = request(
      unit.logPath,
      {
        task: key.split(":")[0] as string,
        actionKey: key,
        cls: "communicate.email.external",
        est_cost_usd: "0.01",
        reversible: false,
        summary: `send ${key}`,
        payload_hash: bindingFor(key),
      },
      at(minute),
      "agent:claude",
      unit.options,
    );
    assert.equal(requested.ok, true, `request for ${key} was refused`);
  }

  // Executions: every supervised and autonomous action starts. The manual ones
  // are left at `requested`, which is what makes the `hasApprovalCycle` half of
  // the equivalence load-bearing.
  for (const key of keys) {
    if (key.includes("communicate")) continue;
    minute += 1;
    const started = startExecution(
      unit.logPath,
      key,
      { ...unit.options, presentedPayloadHash: bindingFor(key) },
      at(minute),
      "agent:claude",
    );
    // A collided key is refused by the executor, which is the point of the
    // collision guard; anything else must start.
    if (!started.ok) {
      assert.equal(
        collided && key === duplicated,
        true,
        `startExecution for ${key} was refused: ${started.message}`,
      );
    }
  }

  return { unit, keys, collision: collided ? duplicated : null };
}

/**
 * `supervisedExecutions` as it was written before the index (APRV-211): three
 * whole-log scans per candidate. Kept here, in the test, as the definition the
 * refactor must reproduce.
 */
function referenceSupervised(
  all: EventRecord[],
  load: PolicyLoadResult,
): AuditCandidate[] {
  const autonomyByClass = new Map<string, string>();
  const candidates: AuditCandidate[] = [];
  for (const record of all) {
    if (record.event !== "execution.started") continue;
    const actionKey = record.action_key;
    if (typeof actionKey !== "string" || actionKey.length === 0) continue;
    if (declaringTasks(all, actionKey).length > 1) continue;
    if (hasApprovalCycle(all, actionKey)) continue;
    const declared = findDeclaration(all, actionKey);
    if (declared === null) continue;
    let autonomy = autonomyByClass.get(declared.class);
    if (autonomy === undefined) {
      autonomy = resolve(load, declared.class).autonomy;
      autonomyByClass.set(declared.class, autonomy);
    }
    if (autonomy !== "supervised") continue;
    candidates.push({
      seq: record.seq,
      hash: record.hash,
      ts: record.ts,
      actionKey,
      task: typeof record.task === "string" ? record.task : declared.task,
      class: declared.class,
    });
  }
  return candidates;
}

// ===========================================================================

test("the index answers every key exactly as the per-key helpers do", () => {
  const { unit, keys, collision } = fixture();
  const all = records(unit);
  const index = indexDeclarations(all);

  // Every key the log carries, plus one it has never heard of: an absent key is
  // the case a lookup table is most likely to answer differently from a scan.
  const asked = [...new Set([...keys, "task-999:never-declared"])];
  assert.ok(asked.length > 10, "the fixture must ask about a real number of keys");

  for (const key of asked) {
    assert.deepEqual(
      index.declarations.get(key) ?? null,
      findDeclaration(all, key),
      `declarations disagree with findDeclaration for ${key}`,
    );
    assert.deepEqual(
      index.declaringTasks.get(key) ?? [],
      declaringTasks(all, key),
      `declaringTasks disagree for ${key}`,
    );
    assert.equal(
      index.requested.has(key),
      hasApprovalCycle(all, key),
      `requested disagrees with hasApprovalCycle for ${key}`,
    );
  }

  // The collision case, when the registration boundary let one through: both
  // tasks are named, in declaration order, by both implementations.
  if (collision !== null) {
    assert.equal((index.declaringTasks.get(collision) ?? []).length, 2, "the collision is not seen");
  }

  assertClean(unit);
});

test("indexDeclarations is a pure per-call derivation: same records, same answers", () => {
  const { unit } = fixture();
  const all = records(unit);
  const first = indexDeclarations(all);
  const second = indexDeclarations(all);
  assert.deepEqual([...second.declarations], [...first.declarations]);
  assert.deepEqual([...second.declaringTasks], [...first.declaringTasks]);
  assert.deepEqual([...second.requested], [...first.requested]);

  // An empty log has an empty index rather than a thrown error.
  const empty = indexDeclarations([]);
  assert.equal(empty.declarations.size, 0);
  assert.equal(empty.declaringTasks.size, 0);
  assert.equal(empty.requested.size, 0);
  assertClean(unit);
});

test("supervisedExecutions deep-equals the per-key algorithm it replaced", () => {
  const { unit } = fixture();
  const all = records(unit);
  const load = loadPolicy({ file: unit.policyPath });
  assert.equal(load.ok, true);

  const reference = referenceSupervised(all, load);
  assert.ok(reference.length > 0, "the fixture must produce candidates to compare");
  assert.deepEqual(supervisedExecutions(all, load), reference);

  // The same equivalence under a policy that moves the class, and under one that
  // does not load at all: the index must not have frozen an autonomy anywhere.
  const strict = loadPolicy({ file: `${unit.policyPath}.missing` });
  assert.equal(strict.ok, false);
  assert.deepEqual(supervisedExecutions(all, strict), referenceSupervised(all, strict));
  assert.deepEqual(supervisedExecutions(all, strict), []);

  // And over a prefix of the log, so the comparison is not one lucky shape.
  for (const size of [1, 5, Math.floor(all.length / 2), all.length - 1]) {
    const prefix = all.slice(0, size);
    assert.deepEqual(
      supervisedExecutions(prefix, load),
      referenceSupervised(prefix, load),
      `the two algorithms disagree over the first ${String(size)} records`,
    );
  }

  assertClean(unit);
});
