/**
 * The filesystem calls `core/log.ts`'s append makes to put a line on disk and
 * make it durable (APRV-440), kept in their own module so that `core/log.ts`'s
 * public surface stays what `tests/log.test.ts` pins: no mutation, no reorder,
 * no truncate, and no way to change how its bytes reach the disk.
 *
 * Why a seam at all. The durability claim is "fsync after the write and before
 * ok", and a page cache that was flushed reads back exactly like one that was
 * not until the machine dies. Only a layer that records the ORDER of the calls
 * can prove the claim, so `tests/log-fsync.test.ts` installs one that records
 * every call and then delegates to the real one, which keeps each log it builds
 * a real log built through the real append path.
 *
 * Nothing in `src/` calls {@link setAppendWriteLayerForTests}. It changes how
 * the bytes reach the disk and nothing about which bytes, so every check before
 * the write (lock, tail, compare-and-append, schema) runs as in production.
 */

import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";

export interface AppendWriteLayer {
  /** `open(2)` with numeric flags; throws like `fs.openSync`. */
  open(path: string, flags: number, mode: number): number;
  /** One `write(2)` of the whole buffer; returns the bytes written. */
  write(fd: number, data: Buffer): number;
  /** `fsync(2)` of a file or directory descriptor; throws on failure. */
  fsync(fd: number): void;
  close(fd: number): void;
}

/** Node's own `fs`, which is the only layer production ever runs. */
const NODE_WRITE_LAYER: AppendWriteLayer = {
  open: (path, flags, mode) => openSync(path, flags, mode),
  write: (fd, data) => writeSync(fd, data, 0, data.length),
  fsync: (fd) => {
    fsyncSync(fd);
  },
  close: (fd) => {
    closeSync(fd);
  },
};

let current: AppendWriteLayer = NODE_WRITE_LAYER;

/** The layer the next append uses. */
export function appendWriteLayer(): AppendWriteLayer {
  return current;
}

/**
 * Replace the append's write layer, or restore Node's with `null`. For tests
 * and the opt-in benchmark only.
 */
export function setAppendWriteLayerForTests(layer: AppendWriteLayer | null): void {
  current = layer ?? NODE_WRITE_LAYER;
}
