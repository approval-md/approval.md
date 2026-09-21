/**
 * The store as an archive (APRV-421): a POSIX ustar tar, gzipped, written here
 * rather than by a library.
 *
 * ## Why a writer and not a dependency
 *
 * The repository rule is minimal dependencies, justified per addition, and the
 * justification for a tar library would have to survive one question: what does
 * it do that ninety lines here do not? A ustar header is a fixed 512-byte
 * record with octal fields and a checksum, `node:zlib` already ships the
 * compression, and the archive this verb produces contains a handful of files
 * whose paths are short and known. A dependency would add a supply-chain
 * surface to a process that hands a tenant their own evidence, in exchange for
 * code this file can state completely.
 *
 * ## The contents are a POSITIVE allowlist
 *
 * {@link EXPORTED_PATHS} names what goes in. Everything else is out by not
 * being named, which is the fail-closed direction SPEC.md §11 asks for
 * everywhere else: `.approval/keys`, `.approval/env`, `.approval/daemon` and
 * any `vault.enc` are excluded because nothing admits them, not because a
 * denylist remembered them. A file added to the store next month is absent
 * from this archive until somebody decides it belongs, and that decision is a
 * diff here.
 *
 * `.approval/payloads/` IS on the list, and it is the entry the reasoning
 * turns on. The log records a `payload_hash` for every action a human was
 * shown, and the bytes those hashes name live in that directory. An archive
 * carrying the hashes without the bytes would hand a tenant a chain of
 * references to evidence they no longer hold: a receipt for an exit rather
 * than an exit. Payload bytes are the tenant's own and are not credential
 * material — the vault, the keys and the environment source map are, and
 * those are the things excluded below.
 *
 * ## What the reader is for
 *
 * {@link readTarEntries} exists so that a test, and a conformance reader after
 * it, can assert what an archive CONTAINS rather than trusting the writer that
 * produced it. A test that checked the writer against itself would pass on the
 * day the writer put the vault in.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";

/** One tar block. The format's unit, and every offset below is inside one. */
const BLOCK = 512;

/**
 * What an export carries, relative to the store root, in archive order.
 *
 * A trailing `/` means "this directory, recursively". Everything else is one
 * file, included when it exists and silently absent when it does not: a store
 * whose index has never been built is an ordinary store, not a broken one.
 */
export const EXPORTED_PATHS: readonly string[] = [
  "APPROVAL.md",
  ".approval/log/",
  ".approval/payloads/",
  ".approval/QUEUE.md",
  ".approval/index.sqlite",
];

/**
 * Paths an export MUST NOT carry, checked as well as excluded.
 *
 * The allowlist above is what decides; this list is what a test asserts
 * against, so the property "no credential material left the store" is written
 * down as a property and not merely implied by the absence of an entry.
 */
export const EXCLUDED_PREFIXES: readonly string[] = [
  ".approval/keys",
  ".approval/env",
  ".approval/daemon",
];

/** Any file with this name is credential material, wherever it sits. */
export const EXCLUDED_BASENAMES: readonly string[] = ["vault.enc"];

export interface TarEntry {
  /** POSIX path inside the archive, relative to the store root. */
  path: string;
  /** File contents. */
  data: Buffer;
  /** Modification time, seconds since the epoch. */
  mtime: number;
}

function octal(value: number, width: number): string {
  // `width - 1` digits and a NUL, which is what every reader accepts and what
  // GNU tar itself writes for these fields.
  return value.toString(8).padStart(width - 1, "0").slice(-(width - 1)) + "\0";
}

function writeString(block: Buffer, offset: number, width: number, value: string): void {
  block.write(value.slice(0, width), offset, width, "utf8");
}

type NameSplit = { name: string; prefix: string };

/**
 * Split a path into ustar's `prefix` and `name` fields.
 *
 * Refused rather than truncated when it does not fit: a truncated path in an
 * archive is a file restored to the wrong place, which is worse than an export
 * that says plainly it cannot represent this store.
 */
export function splitTarName(path: string): NameSplit {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  const cut = path.lastIndexOf("/", path.length - 1);
  for (let index = cut; index > 0; index -= 1) {
    if (path[index] !== "/") continue;
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(
    `${path} cannot be written into a ustar archive: the name exceeds the format's 100/155 byte fields`,
  );
}

/** One 512-byte ustar header, checksum included. */
function header(entry: TarEntry): Buffer {
  const block = Buffer.alloc(BLOCK, 0);
  const { name, prefix } = splitTarName(entry.path);

  writeString(block, 0, 100, name);
  writeString(block, 100, 8, octal(0o644, 8));
  writeString(block, 108, 8, octal(0, 8));
  writeString(block, 116, 8, octal(0, 8));
  writeString(block, 124, 12, octal(entry.data.length, 12));
  writeString(block, 136, 12, octal(Math.floor(entry.mtime), 12));
  // The checksum field is computed as though it held eight spaces.
  block.write("        ", 148, 8, "utf8");
  block.write("0", 156, 1, "utf8"); // typeflag: a regular file
  block.write("ustar\0", 257, 6, "utf8");
  block.write("00", 263, 2, "utf8");
  writeString(block, 345, 155, prefix);

  let sum = 0;
  for (const byte of block) sum += byte;
  // Six octal digits, a NUL and a space: the spelling every reader accepts.
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");
  return block;
}

function padding(size: number): Buffer {
  const remainder = size % BLOCK;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - remainder, 0);
}

/** Write `entries` as an uncompressed ustar archive. */
export function writeTar(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(header(entry), entry.data, padding(entry.data.length));
  }
  // Two zero blocks end the archive; a reader that stops at the first one is
  // still correct, and one that requires both is satisfied.
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}

/**
 * Read an uncompressed ustar archive back.
 *
 * Deliberately strict about the checksum: the point of this function is to be
 * an independent reader of what {@link writeTar} produced, and a reader that
 * ignored the field the writer computes would not be independent of it.
 */
export function readTarEntries(archive: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + BLOCK <= archive.length) {
    const block = archive.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) break;

    const declared = Number.parseInt(block.subarray(148, 156).toString("utf8").trim(), 8);
    let sum = 0;
    for (const [index, byte] of block.entries()) {
      sum += index >= 148 && index < 156 ? 0x20 : byte;
    }
    if (sum !== declared) {
      throw new Error(`tar header checksum mismatch at offset ${String(offset)}`);
    }

    const trim = (buffer: Buffer): string => {
      const end = buffer.indexOf(0);
      return buffer.subarray(0, end === -1 ? buffer.length : end).toString("utf8");
    };
    const name = trim(block.subarray(0, 100));
    const prefix = trim(block.subarray(345, 500));
    const size = Number.parseInt(trim(block.subarray(124, 136)) || "0", 8);
    const mtime = Number.parseInt(trim(block.subarray(136, 148)) || "0", 8);

    offset += BLOCK;
    entries.push({
      path: prefix.length === 0 ? name : `${prefix}/${name}`,
      data: Buffer.from(archive.subarray(offset, offset + size)),
      mtime,
    });
    offset += size + padding(size).length;
  }
  return entries;
}

/** Is this store-relative path one an export may never carry? */
export function isExcludedPath(path: string): boolean {
  const base = path.split("/").at(-1) ?? path;
  if (EXCLUDED_BASENAMES.includes(base)) return true;
  return EXCLUDED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function walk(root: string, relativeDir: string, into: TarEntry[]): void {
  let names: string[];
  try {
    names = readdirSync(join(root, relativeDir)).sort();
  } catch {
    return;
  }
  for (const name of names) {
    const relativePath = posix.join(relativeDir, name);
    collect(root, relativePath, into);
  }
}

function collect(root: string, relativePath: string, into: TarEntry[]): void {
  // Checked on every path rather than only on the roots: the allowlist decides
  // what is offered and this decides what is accepted, and a symlinked or
  // nested `vault.enc` is refused by the second even when the first admitted
  // the directory above it.
  if (isExcludedPath(relativePath)) return;
  const absolute = join(root, relativePath);
  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    return;
  }
  if (stats.isDirectory()) {
    walk(root, relativePath, into);
    return;
  }
  if (!stats.isFile()) return;
  into.push({
    path: relativePath,
    data: readFileSync(absolute),
    mtime: Math.floor(stats.mtimeMs / 1000),
  });
}

export interface StoreArchive {
  /** The gzipped ustar bytes. */
  bytes: Buffer;
  /** The paths it carries, in archive order. Reported, and asserted by tests. */
  paths: string[];
}

/**
 * Build the export archive for the store rooted at `root`.
 *
 * Reads only; writes nothing anywhere, appends no record, and touches no
 * credential. A path outside the allowlist cannot be reached from here, because
 * the walk starts at the allowlist and nowhere else.
 */
export function buildStoreArchive(root: string): StoreArchive {
  const entries: TarEntry[] = [];
  for (const candidate of EXPORTED_PATHS) {
    const relativePath = candidate.endsWith("/") ? candidate.slice(0, -1) : candidate;
    collect(root, relativePath, entries);
  }
  // Sorted, so two exports of one unchanged store are the same archive: a
  // tenant comparing two downloads is comparing the store and not the order a
  // directory happened to be read in.
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return {
    bytes: gzipSync(writeTar(entries), { level: 6 }),
    paths: entries.map((entry) => entry.path),
  };
}

/** `relative()` in POSIX spelling, for callers that hold absolute paths. */
export function storeRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}
