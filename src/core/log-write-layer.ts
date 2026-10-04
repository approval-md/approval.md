/**
 * The filesystem calls that put durable bytes on disk: `core/log.ts`'s append
 * (APRV-440) and `core/payload-store.ts`'s atomic write (APRV-457). They are
 * kept in their own module so that `core/log.ts`'s public surface stays what
 * `tests/log.test.ts` pins: no mutation, no reorder, no truncate, and no way to
 * change how its bytes reach the disk.
 *
 * Why a seam at all. The durability claim is "fsync after the write and before
 * ok", and a page cache that was flushed reads back exactly like one that was
 * not until the machine dies. Only a layer that records the ORDER of the calls
 * can prove the claim, so `tests/log-fsync.test.ts` and
 * `tests/payload-fsync.test.ts` install one that records every call and then
 * delegates to the real one, which keeps each log they build a real log built
 * through the real append path.
 *
 * One seam for both writers, deliberately. A log record is only as durable as
 * the payload it binds: a record that survives a crash while its payload comes
 * back NUL-filled verifies and points at nothing (APRV-457). Proving the two
 * through one layer keeps one model of "what reached the disk" for both.
 *
 * Nothing in `src/` calls {@link setAppendWriteLayerForTests}. It changes how
 * the bytes reach the disk and nothing about which bytes, so every check before
 * the write (lock, tail, compare-and-append, schema, payload hashing) runs as in
 * production.
 */

import { closeSync, constants as fsConstants, fsyncSync, openSync, renameSync, writeSync } from "node:fs";

export interface AppendWriteLayer {
  /** `open(2)` with numeric flags; throws like `fs.openSync`. */
  open(path: string, flags: number, mode: number): number;
  /** One `write(2)` of the whole buffer; returns the bytes written. */
  write(fd: number, data: Buffer): number;
  /** `fsync(2)` of a file or directory descriptor; throws on failure. */
  fsync(fd: number): void;
  close(fd: number): void;
  /**
   * `rename(2)`; throws like `fs.renameSync`. Used by the payload store's
   * temp-then-rename write (APRV-457); the log append never renames.
   */
  rename(from: string, to: string): void;
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
  rename: (from, to) => {
    renameSync(from, to);
  },
};

let current: AppendWriteLayer = NODE_WRITE_LAYER;

/** The layer the next append (or payload store write) uses. */
export function appendWriteLayer(): AppendWriteLayer {
  return current;
}

/**
 * Replace the append's write layer, or restore Node's with `null`. For tests
 * and the opt-in benchmarks only.
 */
export function setAppendWriteLayerForTests(layer: AppendWriteLayer | null): void {
  current = layer ?? NODE_WRITE_LAYER;
}

/**
 * The errors a directory fsync returns on a filesystem that cannot sync a
 * directory at all (some FUSE, SMB and drvfs mounts). The same set `core/log.ts`
 * tolerates for its first append (APRV-440); log.ts keeps its own copy so its
 * append path stays exactly what APRV-440 shipped. EIO and everything else
 * still fail.
 */
const DIRECTORY_FSYNC_UNSUPPORTED = new Set(["EINVAL", "EBADF", "ENOTSUP", "EOPNOTSUPP"]);

/**
 * fsync a directory through the current layer, so a name created or renamed
 * into it survives a crash. Skipped on Windows (a directory cannot be opened
 * for this there, and its filesystems journal names themselves) and tolerated
 * where the filesystem reports directory fsync as unsupported; every other
 * failure throws for the caller to report. The read-only handle is closed even
 * when the fsync throws.
 */
export function fsyncDirectory(dir: string): void {
  if (process.platform === "win32") return;
  const writeLayer = current;
  const fd = writeLayer.open(dir, fsConstants.O_RDONLY, 0);
  try {
    writeLayer.fsync(fd);
  } catch (cause) {
    if (!DIRECTORY_FSYNC_UNSUPPORTED.has((cause as NodeJS.ErrnoException).code ?? "")) throw cause;
  } finally {
    try {
      writeLayer.close(fd);
    } catch {
      // The fsync above is what mattered; a failed close of a read-only
      // directory handle changes nothing on disk.
    }
  }
}
