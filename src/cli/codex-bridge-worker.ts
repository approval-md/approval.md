import { parentPort, workerData } from "node:worker_threads";

import {
  decideExecRequest,
  decideFileChangeRequest,
  type BridgeDecisionPlan,
  type RecordedItem,
} from "./codex-bridge.js";
import type { Streams } from "./main.js";

interface Work {
  kind: "exec" | "file";
  params: unknown;
  item: RecordedItem | null;
  plan: Omit<BridgeDecisionPlan, "options"> & { policy: { dir?: string; file?: string } | null };
  cancellation: SharedArrayBuffer;
}

const work = workerData as Work;
const flag = new Int32Array(work.cancellation);
const streams: Streams = {
  out: (value) => parentPort?.postMessage({ type: "stdout", value }),
  err: (value) => parentPort?.postMessage({ type: "stderr", value }),
};
const cancellation = {
  cancelled: (): boolean => Atomics.load(flag, 0) !== 0,
  pause: (ms: number): void => { Atomics.wait(flag, 0, 0, ms); },
};
const plan: BridgeDecisionPlan = {
  logPath: work.plan.logPath,
  root: work.plan.root,
  actor: work.plan.actor,
  workspace: work.plan.workspace,
  waitMs: work.plan.waitMs,
  intervalMs: work.plan.intervalMs,
  options: work.plan.policy === null ? {} : { policy: work.plan.policy },
};

try {
  const result = work.kind === "exec"
    ? decideExecRequest(streams, plan, work.params, cancellation)
    : decideFileChangeRequest(
        streams,
        plan,
        work.params,
        work.item === null ? new Map() : new Map([[work.item.id, work.item]]),
        cancellation,
      );
  parentPort?.postMessage({ type: "result", result });
} catch (cause) {
  parentPort?.postMessage({
    type: "error",
    message: cause instanceof Error ? cause.message : String(cause),
  });
}
