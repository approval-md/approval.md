/**
 * A scratch approval home, for the suites added by APRV-20 pass two.
 *
 * Same discipline as every other suite here: nothing hand-writes a log line.
 * The policy is attested through `core/attest.ts`, tasks are registered through
 * `core/gate.ts`, and every scenario can end by walking the chain with
 * `verify()` — a check that refuses correctly but leaves a broken log has still
 * failed.
 *
 * Timestamps are injected as clocks (amended SPEC.md §8, A2): the gate-typed
 * writers no longer take a `ts`, and these suites still need TTL lapse and
 * rolling budget windows exercised at chosen instants rather than with sleeps.
 *
 * Not a test file (no `.test.ts` suffix), so the runner ignores it.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendAttestation } from "../src/core/attest.js";
import type { GateOptions } from "../src/core/gate.js";
import type { EventRecord } from "../src/core/log.js";
import { verify } from "../src/core/verify.js";

export const T0 = "2026-08-05T10:00:00.000Z";

/** `minutes` after {@link T0}, as an RFC 3339 instant. */
export function at(minutes: number): string {
  return new Date(Date.parse(T0) + minutes * 60_000).toISOString();
}

/** A clock frozen at `ts`, the sanctioned way to pin a gate write's timestamp. */
export function fixedClock(ts: string): () => string {
  return () => ts;
}

export const POLICY = [
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
  "  files.write.*:",
  "    autonomy: supervised",
  "  communicate.email.external:",
  "    autonomy: manual",
  "```",
  "",
].join("\n");

export interface Scenario {
  dir: string;
  logPath: string;
  policyPath: string;
  options: GateOptions;
}

let counter = 0;

/** A fresh approval home under `root`, with `policyText` on disk. */
export function newScenario(root: string, policyText: string = POLICY): Scenario {
  counter += 1;
  const dir = join(root, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  const policyPath = join(dir, "APPROVAL.md");
  writeFileSync(policyPath, policyText, "utf8");
  return {
    dir,
    logPath: join(dir, ".approval", "log", "events.jsonl"),
    policyPath,
    options: { policy: { file: policyPath } },
  };
}

/** A scratch root that cleans itself up; pass the returned `after` to node:test. */
export function scratchRoot(label: string): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), `approval-md-${label}-`));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Attest the policy through the real append path. */
export function attest(unit: Scenario, ts: string = T0): void {
  const result = appendAttestation(unit.logPath, unit.policyPath, "human:carter", {
    clock: fixedClock(ts),
  });
  assert.equal(result.ok, true, "attestation append failed");
}

export function records(unit: Scenario): EventRecord[] {
  let raw: string;
  try {
    raw = readFileSync(unit.logPath, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as EventRecord);
}

export function eventTypes(unit: Scenario): string[] {
  return records(unit).map((record) => record.event);
}

/** A record's payload as a map — the log's payload shape is open at v0.1. */
export function payloadOf(record: EventRecord): Record<string, unknown> {
  const payload = record.payload;
  return typeof payload === "object" && payload !== null ? payload : {};
}

/** The chain still verifies. Asserted after every scenario that writes. */
export function assertClean(unit: Scenario): void {
  const result = verify(unit.logPath);
  assert.equal(result.status, "clean", `chain not clean: ${JSON.stringify(result)}`);
}
