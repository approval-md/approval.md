/**
 * What the payload store's fsyncs cost (APRV-457), opt-in like every
 * wall-clock number in this repository (APRV-248, APRV-440).
 *
 * ```
 * npm run build && APPROVAL_BENCH=1 node --test dist/tests/payload-fsync.bench.js
 * ```
 *
 * Kept out of `npm test` the same two ways `tests/append-fsync.bench.ts` is: the
 * runner discovers `*.test.js` only, and without `APPROVAL_BENCH=1` every case
 * fails fast instead of measuring. The structural claim (fsync of the temp file
 * before the rename and of the directory after it, before ok) is asserted at any
 * load in `tests/payload-fsync.test.ts`; what lives here is the magnitude.
 *
 * Each shape is measured twice: once with Node's real layer, and once with a
 * layer that reproduces the pre-APRV-457 store, whose temp-file fsync and
 * directory sync do nothing while the LOG's fsync (APRV-440) stays real. The
 * difference is the store's new cost and only that.
 *
 *  1. `storePayload` alone, one payload per call.
 *  2. The propose path: `approval.requested` with inline material (intake
 *     stores the payload, then appends the record that binds it).
 *  3. The grant path for policy text: an attestation (`policy.updated`), which
 *     stores the attested bytes before appending (APRV-356).
 *
 * The numbers print as `# BENCH` lines. The budget each case asserts is the
 * per-append budget APRV-440 recorded (25 ms median); a breach is a REPORT to
 * read against what else the machine was doing, not a verdict.
 */

import assert from "node:assert/strict";
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  openSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { appendAttestation } from "../src/core/attest.js";
import { setAppendWriteLayerForTests, type AppendWriteLayer } from "../src/core/log-write-layer.js";
import { payloadHash } from "../src/core/payload.js";
import { storePayload } from "../src/core/payload-store.js";
import { register, request } from "./clock-adapters.js";
import { at, attest, fixedClock, newScenario, scratchRoot, T0 } from "./scenario.js";

function requireOptIn(): void {
  assert.equal(
    process.env["APPROVAL_BENCH"],
    "1",
    "this is a benchmark, not a test: it measures the disk as much as the code. Run it on purpose " +
      "with APPROVAL_BENCH=1, and read `tests/payload-fsync.test.ts` for the load-proof ordering claim.",
  );
}

/** The descriptor a skipped directory open hands back; never a real fd. */
const NO_DIR_FD = -1;

/**
 * The pre-APRV-457 store, with the log as it is now: real open, write, close and
 * rename; fsync real for the log only; the store's directory sync skipped
 * entirely (no open, no fsync, no close), as it never happened before.
 */
function storeWithoutFsync(): AppendWriteLayer {
  const logFds = new Set<number>();
  return {
    open: (path, flags, mode) => {
      const writable = (flags & (fsConstants.O_WRONLY | fsConstants.O_RDWR)) !== 0;
      if (!writable && !path.endsWith(".jsonl")) return NO_DIR_FD;
      const fd = openSync(path, flags, mode);
      if (path.endsWith(".jsonl")) logFds.add(fd);
      return fd;
    },
    write: (fd, data) => writeSync(fd, data, 0, data.length),
    fsync: (fd) => {
      if (logFds.has(fd)) fsyncSync(fd);
    },
    close: (fd) => {
      if (fd === NO_DIR_FD) return;
      logFds.delete(fd);
      closeSync(fd);
    },
    rename: (from, to) => {
      renameSync(from, to);
    },
  };
}

const scratch = scratchRoot("payload-fsync-bench");

/** APRV-440's per-append budget, median; the store's fsync gets the same. */
const FSYNC_BUDGET_MS = 25;
const CALLS = 100;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] as number;
}

function material(arm: string, n: number): Record<string, unknown> {
  return { to: ["agency@example.co.uk"], subject: `bench ${arm} ${String(n)}`, body: "x".repeat(400) };
}

function report(label: string, withFsync: number[], without: number[]): number {
  const cost = median(withFsync) - median(without);
  process.stdout.write(
    `# BENCH ${label}: with store fsync median ${median(withFsync).toFixed(3)} ms p95 ${p95(withFsync).toFixed(3)} ms; ` +
      `without median ${median(without).toFixed(3)} ms p95 ${p95(without).toFixed(3)} ms; ` +
      `store fsync costs ${cost.toFixed(3)} ms per call (${process.platform}, n=${String(withFsync.length)})\n`,
  );
  return cost;
}

function timed(layer: AppendWriteLayer | null, run: (n: number) => void, setup?: (n: number) => void): number[] {
  setAppendWriteLayerForTests(layer);
  try {
    const timings: number[] = [];
    for (let n = 1; n <= CALLS; n += 1) {
      setup?.(n);
      const started = process.hrtime.bigint();
      run(n);
      timings.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    return timings;
  } finally {
    setAppendWriteLayerForTests(null);
  }
}

test("BENCH: storePayload alone, with and without its fsyncs", () => {
  requireOptIn();
  const arm = (label: string, layer: AppendWriteLayer | null): number[] => {
    const storeDir = join(newScenario(scratch.root).dir, "payloads");
    return timed(layer, (n) => {
      const stored = storePayload(storeDir, material(label, n));
      assert.ok(stored.ok, JSON.stringify(stored));
    });
  };
  arm("warm", null);
  const withFsync = arm("with", null);
  const without = arm("without", storeWithoutFsync());
  const cost = report("storePayload", withFsync, without);
  assert.ok(cost < FSYNC_BUDGET_MS, `store fsync costs ${cost.toFixed(3)} ms per call`);
});

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
  "  communicate.email.external:",
  "    autonomy: manual",
  "```",
  "",
].join("\n");

test("BENCH: the propose path (approval.requested with inline material)", () => {
  requireOptIn();
  const arm = (label: string, layer: AppendWriteLayer | null): number[] => {
    const unit = newScenario(scratch.root, POLICY);
    attest(unit, T0);
    const key = (n: number): string => `bench-${label}-${String(n)}:send`;
    return timed(
      layer,
      (n) => {
        const result = request(
          unit.logPath,
          {
            task: `bench-${label}-${String(n)}`,
            actionKey: key(n),
            cls: "communicate.email.external",
            est_cost_usd: "0.02",
            reversible: false,
            payload: { value: material(label, n) },
          },
          at(1),
          "agent:bench",
          unit.options,
        );
        assert.ok(result.ok, JSON.stringify(result));
      },
      (n) => {
        // Registration is setup, outside the timed call.
        const registered = register(
          unit.logPath,
          {
            task: `bench-${label}-${String(n)}`,
            envelope: {
              origin: { app: "bench", created_by: "agent:bench" },
              state: "proposed",
              actions: [
                {
                  class: "communicate.email.external",
                  summary: "bench send",
                  reversible: false,
                  est_cost_usd: "0.02",
                  idempotency_key: key(n),
                  payload_hash: payloadHash(material(label, n)),
                },
              ],
            },
          },
          T0,
          "agent:bench",
          unit.options,
        );
        assert.ok(registered.ok, JSON.stringify(registered));
      },
    );
  };
  arm("warm", null);
  const withFsync = arm("with", null);
  const without = arm("without", storeWithoutFsync());
  const cost = report("propose (approval.requested + payload)", withFsync, without);
  assert.ok(cost < FSYNC_BUDGET_MS, `store fsync costs ${cost.toFixed(3)} ms per request`);
});

test("BENCH: the grant path for policy text (policy.updated stores the attested bytes)", () => {
  requireOptIn();
  const arm = (label: string, layer: AppendWriteLayer | null): number[] => {
    const unit = newScenario(scratch.root, POLICY);
    return timed(
      layer,
      () => {
        const result = appendAttestation(unit.logPath, unit.policyPath, "human:carter", {
          clock: fixedClock(T0),
        });
        assert.ok(result.ok, JSON.stringify(result));
      },
      (n) => {
        // A new policy text each call, so each attestation stores new bytes.
        writeFileSync(unit.policyPath, `${POLICY}\n<!-- bench ${label} ${String(n)} -->\n`, "utf8");
      },
    );
  };
  arm("warm", null);
  const withFsync = arm("with", null);
  const without = arm("without", storeWithoutFsync());
  const cost = report("grant (policy.updated + attested bytes)", withFsync, without);
  assert.ok(cost < FSYNC_BUDGET_MS, `store fsync costs ${cost.toFixed(3)} ms per attestation`);
});
