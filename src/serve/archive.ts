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

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from "node:fs";
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

/**
 * Is this store-relative path one an export may never carry?
 *
 * `excludedLock` is the ONE lockfile this server itself creates, passed in as
 * an exact path rather than matched as a class. An earlier pass excluded
 * `*.lock` by suffix, which quietly deleted a tenant's own
 * `.approval/payloads/x.lock` from their archive: the tenant's bytes are the
 * tenant's, and a name this runtime happens to use for its own bookkeeping is
 * not a reason to drop somebody else's file. Only the path derived from the
 * log is dropped, and only because the export holds that lock while it walks,
 * so the file exists for exactly the span of the copy and means nothing but
 * "somebody was reading when this was made".
 */
export function isExcludedPath(path: string, excludedLock: string | null = null): boolean {
  const base = path.split("/").at(-1) ?? path;
  if (EXCLUDED_BASENAMES.includes(base)) return true;
  if (excludedLock !== null && path === excludedLock) return true;
  return EXCLUDED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * A symlink the export walk reached.
 *
 * Thrown rather than returned because it must abort the WHOLE archive from
 * wherever it is found, and an error is the one control flow that cannot be
 * accidentally ignored by a caller that forgot to check a return value.
 */
export class ExportSymlinkError extends Error {
  /** The store-relative path of the link itself, never its target. */
  readonly path: string;

  constructor(path: string) {
    super(
      `${path} is a symbolic link. An export copies the tenant's own store and never what a link points at: a link under the store can name credential material inside it (\`.approval/keys\`, \`.approval/env\`, the vault) or any file on the host, and a copy that followed one would put those bytes in the tenant's archive. The whole export is refused rather than the link skipped, because an archive silently missing a file is an archive nobody can tell from a complete one. Replace the link with the file, or move it outside the store.`,
    );
    this.name = "ExportSymlinkError";
    this.path = path;
  }
}

/**
 * A HARD link, which a name-based exclusion cannot see at all (APRV-421,
 * second review pass).
 *
 * `ln .approval/keys/sender.key .approval/log/note.jsonl` produces a second
 * name for the same inode. There is no link to refuse to follow and no target
 * to notice: the excluded path and the admitted path ARE one file, and the
 * admitted name is a perfectly ordinary regular file by every test a walker
 * can apply to it except one — its link count.
 *
 * So `nlink > 1` on a regular file under the store is refused, fail-closed and
 * whole, exactly as a symlink is. The false positive is a tenant who
 * deliberately hard-linked something into their own store, which is rare, is
 * visible in the refusal, and is repaired by copying the file.
 */
export class ExportHardLinkError extends Error {
  /** The store-relative path of the link, which is also the file. */
  readonly path: string;
  /** How many names this inode has. */
  readonly links: number;

  constructor(path: string, links: number) {
    super(
      `${path} has ${String(links)} names (it is a hard link). A second name for one inode cannot be told from an ordinary file by its path, so an excluded file — a key under \`.approval/keys\`, the environment source map, the vault — can be given an admitted name and copied into the archive with nothing to notice. The whole export is refused rather than the file skipped, for the reason a symbolic link refuses it: an archive silently missing a file is one nobody can tell from a complete one. Replace the link with a copy.`,
    );
    this.name = "ExportHardLinkError";
    this.path = path;
    this.links = links;
  }
}

function walk(root: string, relativeDir: string, into: TarEntry[], lock: string | null): void {
  let names: string[];
  try {
    names = readdirSync(join(root, relativeDir)).sort();
  } catch {
    return;
  }
  for (const name of names) {
    const relativePath = posix.join(relativeDir, name);
    collect(root, relativePath, into, lock);
  }
}

function collect(
  root: string,
  relativePath: string,
  into: TarEntry[],
  lock: string | null,
): void {
  // Checked on every path rather than only on the roots: the allowlist decides
  // what is offered and this decides what is accepted, and a nested `vault.enc`
  // is refused by the second even when the first admitted the directory above
  // it.
  if (isExcludedPath(relativePath, lock)) return;
  const absolute = join(root, relativePath);
  let stats;
  try {
    // LSTAT, never stat (APRV-421). `stat` follows the link, so the exclusion
    // check above would be reading one name while the copy below read another
    // file entirely: `ln -s .approval/keys/sender.key .approval/log/note.jsonl`
    // passes every name-based check ever written and hands over the key.
    stats = lstatSync(absolute);
  } catch {
    return;
  }
  if (stats.isSymbolicLink()) throw new ExportSymlinkError(relativePath);
  if (stats.isDirectory()) {
    walk(root, relativePath, into, lock);
    return;
  }
  // Not a regular file: a fifo, a socket or a device. Skipped rather than
  // refused, because none of them is a way to name another file's bytes, and
  // a store that happens to hold one is not a store that is lying about what
  // it contains.
  if (!stats.isFile()) return;

  // OPEN, then ask the DESCRIPTOR what it is (APRV-421, second review pass).
  //
  // `lstat` above and a `readFileSync(path)` below would be two resolutions of
  // one name with a window between them, and the classic move is to replace a
  // checked regular file with a symlink to somebody's key inside that window.
  // `O_NOFOLLOW` refuses to open a symlink at all, and `fstat` describes THE
  // FILE THAT WAS OPENED rather than whatever the name points at now — so the
  // regular-file and link-count checks below are about the bytes actually read.
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) return;
    if (opened.nlink > 1) throw new ExportHardLinkError(relativePath, opened.nlink);
    into.push({
      path: relativePath,
      data: readFileSync(fd),
      mtime: Math.floor(opened.mtimeMs / 1000),
    });
  } finally {
    try {
      closeSync(fd);
    } catch {
      // `readFileSync(fd)` closes it on some paths; a double close is not an
      // error worth propagating out of an export.
    }
  }
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
 * the walk starts at the allowlist and nowhere else, and no path is followed
 * through a link.
 *
 * Throws {@link ExportSymlinkError} when the walk meets a symbolic link. The
 * caller turns that into a refusal naming the link's own relative path.
 */
export function buildStoreArchive(root: string, logPath: string): StoreArchive {
  // The one file this server's own append lock creates, as an exact path.
  const lock = storeRelative(root, `${logPath}.lock`);
  const entries: TarEntry[] = [];
  for (const candidate of EXPORTED_PATHS) {
    const relativePath = candidate.endsWith("/") ? candidate.slice(0, -1) : candidate;
    collect(root, relativePath, entries, lock);
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
