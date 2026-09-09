/**
 * Pull-based subscription to the verified event log (APRV-322).
 *
 * A filesystem notification is only a hint that another read may be useful.
 * Every emitted batch comes from one complete, genesis-to-head verification;
 * a notification, a parsed line, or an intact prefix is never authority by
 * itself. The iterator queues no events: while a consumer is slow it retains
 * only the current verified snapshot and coalesces every wakeup into one bit.
 */

import { readFileSync, watch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";

import type { EventRecord } from "./log.js";
import { verifyText, type VerifyFailureReason } from "./verify.js";

export type LogSubscriptionFailureKind = "integrity" | "torn-tail" | "io";

/** A terminal subscription failure, mapped by the CLI to the existing exits. */
export class LogSubscriptionError extends Error {
  readonly kind: LogSubscriptionFailureKind;
  readonly reason: VerifyFailureReason | "cursor-mismatch" | null;

  constructor(
    kind: LogSubscriptionFailureKind,
    message: string,
    reason: VerifyFailureReason | "cursor-mismatch" | null = null,
  ) {
    super(message);
    this.name = "LogSubscriptionError";
    this.kind = kind;
    this.reason = reason;
  }
}

export interface LogSubscriptionOptions {
  /** Exclusive cursor. Zero replays the whole verified log. */
  from?: number;
  /** Hash of record `from`, retained outside the log by the consumer. */
  expectedHash?: string;
  /** Cancellation closes the watcher, timer, and signal listener. */
  signal?: AbortSignal;
  /** Bounded fallback when filesystem notifications are missing. */
  pollIntervalMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 500;

function readSnapshot(logPath: string): string {
  try {
    return readFileSync(logPath, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return "";
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new LogSubscriptionError("io", `log ${logPath} could not be read: ${detail}`);
  }
}

function checkedSnapshot(logPath: string): EventRecord[] {
  const verified = verifyText(logPath, readSnapshot(logPath));
  if (verified.result.status === "torn-tail") {
    throw new LogSubscriptionError("torn-tail", verified.result.message);
  }
  if (verified.result.status === "corrupt") {
    throw new LogSubscriptionError("integrity", verified.result.message, verified.result.reason);
  }
  return verified.records;
}

function validateOptions(options: LogSubscriptionOptions): {
  from: number;
  expectedHash: string | undefined;
  pollIntervalMs: number;
} {
  const from = options.from ?? 0;
  if (!Number.isSafeInteger(from) || from < 0) {
    throw new TypeError(`from must be a non-negative safe integer, got ${String(from)}`);
  }
  if (options.expectedHash !== undefined) {
    if (from === 0) throw new TypeError("expectedHash requires from to be greater than zero");
    if (!/^[a-f0-9]{64}$/u.test(options.expectedHash)) {
      throw new TypeError("expectedHash must be a lowercase 64-character SHA-256 digest");
    }
  }
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new TypeError(
      `pollIntervalMs must be a positive safe integer, got ${String(pollIntervalMs)}`,
    );
  }
  return { from, expectedHash: options.expectedHash, pollIntervalMs };
}

/**
 * Yield verified records after an exclusive cursor, then wait for appends.
 *
 * The optional expected hash binds the first read to the caller's stored
 * cursor. After every yield, the iterator carries that same binding forward,
 * so truncation or replacement during one process lifetime is also refused.
 */
export async function* subscribeVerifiedLog(
  logPath: string,
  options: LogSubscriptionOptions = {},
): AsyncGenerator<EventRecord, void, void> {
  const parsed = validateOptions(options);
  let cursorSeq = parsed.from;
  let cursorHash = parsed.expectedHash;
  let wakeVersion = 0;
  let wake: (() => void) | null = null;
  let watcher: FSWatcher | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const hint = (): void => {
    wakeVersion += 1;
    const pending = wake;
    wake = null;
    pending?.();
  };

  const abort = (): void => hint();
  options.signal?.addEventListener("abort", abort, { once: false });

  // Watch the directory so creation of an initially absent log is visible.
  // Failure to establish a watch is harmless: bounded polling remains active.
  try {
    watcher = watch(dirname(logPath), { persistent: false }, hint);
    watcher.on("error", hint);
  } catch {
    watcher = null;
  }

  try {
    while (!options.signal?.aborted) {
      const versionBeforeRead = wakeVersion;
      const records = checkedSnapshot(logPath);
      const headSeq = records.at(-1)?.seq ?? 0;

      if (cursorSeq > headSeq) {
        throw new LogSubscriptionError(
          "integrity",
          `log ${logPath} ends at seq ${String(headSeq)}, before subscription cursor seq ${String(cursorSeq)}: records have been removed or this cursor belongs to another log`,
          "cursor-mismatch",
        );
      }
      if (cursorSeq > 0) {
        const actual = records[cursorSeq - 1];
        if (actual === undefined || (cursorHash !== undefined && actual.hash !== cursorHash)) {
          throw new LogSubscriptionError(
            "integrity",
            `log ${logPath} does not match subscription cursor seq ${String(cursorSeq)}${
              cursorHash === undefined ? "" : ` hash ${cursorHash}`
            }: the retained prefix was truncated, replaced, or belongs to another log`,
            "cursor-mismatch",
          );
        }
        // A sequence-only bootstrap is weaker on its first read, by design,
        // but once this process has verified that prefix it can retain the
        // actual digest and detect any later replacement even while caught up.
        cursorHash ??= actual.hash;
      }

      // No slice: it would duplicate an arbitrarily large suffix. The verified
      // snapshot is the only event-bearing allocation retained by this batch.
      for (let index = cursorSeq; index < records.length; index += 1) {
        if (options.signal?.aborted) return;
        const record = records[index];
        if (record === undefined) break;
        // The yielded object is ordinary mutable JavaScript. Capture the
        // verified cursor before handing it to untrusted consumer code, so a
        // mutation cannot change where this iterator resumes or what prefix it
        // binds on the next verification.
        const verifiedSeq = record.seq;
        const verifiedHash = record.hash;
        yield record;
        cursorSeq = verifiedSeq;
        cursorHash = verifiedHash;
      }

      if (options.signal?.aborted) return;
      // An append between watcher setup/read/drain and this point changes the
      // version and causes an immediate verification instead of a lost wakeup.
      if (wakeVersion !== versionBeforeRead) continue;

      const versionBeforeWait = wakeVersion;
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(hint, parsed.pollIntervalMs);
        // Close the last race: an abort or append may land after the check
        // above and before `wake` is installed. Its version change must turn
        // into an immediate retry, not a wait for the polling fallback.
        if (options.signal?.aborted || wakeVersion !== versionBeforeWait) hint();
      });
      if (timer !== null) clearTimeout(timer);
      timer = null;
      wake = null;
    }
  } finally {
    if (timer !== null) clearTimeout(timer);
    wake = null;
    watcher?.close();
    options.signal?.removeEventListener("abort", abort);
  }
}
