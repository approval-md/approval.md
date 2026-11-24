/**
 * The disk half of GLOB-WRITE (lead ruling L61167): list the directories a
 * command's write-target patterns glob in, so the classifier can decide by
 * what is THERE instead of by everything a pattern could name.
 *
 * `rm -rf dist/*` is a write through `*`, and `*` could be `APPROVAL.md`,
 * which is guarded at any depth. Without a listing the classifier answers the
 * strict class (`policy.core`); with one it matches the pattern against the
 * names the directory holds and answers by those. The core stays pure: the
 * listing happens here, BEFORE classification, and is handed in as
 * `ClassifierContext.globDisk`.
 *
 * A directory that is not there (`ENOENT`, `ENOTDIR`) is `"missing"`: empty
 * to a glob on a one-segment line, unknown otherwise (a segment before it may
 * create it), and never empty to a contents copy.
 *
 * FAIL CLOSED. A directory that cannot be listed in full (any other error, a symlink
 * loop, more than {@link GLOB_LISTING_ENTRY_CAP} entries, the
 * {@link GLOB_LISTING_TIMEOUT_MS} timeout) is `"unreadable"`, and a directory
 * past {@link GLOB_LISTING_DIR_CAP} is not listed: both keep the strict
 * answer. Only the first globbed component's directory is listed; a deeper
 * globbed component keeps the over-approximated reading (strict where it could
 * name a guarded name).
 *
 * A file created between this listing and the command's run is not seen: the
 * check-then-act window is the reviewers' call (noted on the PR).
 */

import { lstat as fsLstat, opendir as fsOpendir, realpath as fsRealpath } from "node:fs/promises";
import type { Dir } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { globWriteListingDirs, GUARDED_WALK_CUT, guardedContentsKey, guardedFolderName, realpathKey, type GlobDisk } from "../core/command-class.js";
import { runUnderDeadline } from "../core/deadline.js";

/** Most entries one directory is read for before it is judged unreadable. */
export const GLOB_LISTING_ENTRY_CAP = 2_000;
/** Each directory's own deadline; all are listed at once. */
export const GLOB_LISTING_TIMEOUT_MS = 2_000;
/** Most directories one command lists; the rest keep the strict answer. */
export const GLOB_LISTING_DIR_CAP = 16;

export type GlobListing = readonly string[] | "unreadable" | "missing";

/** The directory opener, injectable for tests (a slow or failing one). */
export type DirOpener = (path: string) => Promise<Dir>;

export interface GlobListingOptions {
  opendir?: DirOpener;
  entryCap?: number;
  timeoutMs?: number;
  dirCap?: number;
  /**
   * The wall-clock time (`Date.now()`) by which the classification that finds
   * the directories must be done: the hook's own describe deadline (#693),
   * which this pass spends first. Past it the pass is stopped and
   * {@link GlobListingDeadline} is thrown; the classifier's state may be half
   * written (`core/deadline.ts`), so the caller classifies nothing more.
   */
  deadlineAt?: number;
}

/**
 * The classification that finds the directories to list outlasted
 * {@link GlobListingOptions.deadlineAt}. The hook refuses the call
 * (`hook-deadline`): a hook the harness kills at its timeout is a call that
 * proceeds.
 */
export class GlobListingDeadline extends Error {
  constructor() {
    super("the classification that finds the directories to list outlasted the hook's deadline");
    this.name = "GlobListingDeadline";
  }
}

/** Most directories one guarded folder's walk opens (lead ruling L62511, S-C). */
export const GUARDED_WALK_DIR_CAP = 64;
/** Most names one guarded folder's walk reads, at every depth. */
export const GUARDED_WALK_ENTRY_CAP = 4_000;

/**
 * Every name inside a guarded folder, at every depth, by basename (lead ruling
 * L62511, S-C): what a narrowed `find … -name P -delete` from a parent of it
 * may reach. Symlinks are not followed (find does not by default). The walk
 * is breadth-first in the order each directory returns its entries, with no
 * other ordering: what a limit leaves unread is whatever came later. A `.git`
 * folder's `objects` directory is listed by name and not walked: its names
 * are git's own shapes, which the classifier judges by text. `[]` for a name
 * that is not a directory, `"missing"` for one that is gone, `"unreadable"` on any other error, and
 * the names read so far after {@link GUARDED_WALK_CUT} past
 * {@link GUARDED_WALK_DIR_CAP} or {@link GUARDED_WALK_ENTRY_CAP}, at the
 * timeout or at the hook's deadline: the classifier then falls back to the
 * rule it uses with no listing, for that folder.
 */
export async function walkGuardedFolder(path: string, options: GlobListingOptions = {}): Promise<GlobListing> {
  const timeoutMs = options.timeoutMs ?? GLOB_LISTING_TIMEOUT_MS;
  const isGit = basename(path).toLowerCase() === ".git";
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const names: string[] = [];
  const cut = (): GlobListing => [GUARDED_WALK_CUT, ...names];
  const walking = (async (): Promise<GlobListing> => {
    try {
      if (!(await fsLstat(path)).isDirectory()) return [];
    } catch (error: unknown) {
      const code = (error as { code?: unknown } | null)?.code;
      return code === "ENOENT" ? "missing" : "unreadable";
    }
    const queue = [path];
    let opened = 0;
    while (queue.length > 0) {
      if (timedOut || (options.deadlineAt !== undefined && Date.now() > options.deadlineAt)) return cut();
      opened += 1;
      if (opened > GUARDED_WALK_DIR_CAP) return cut();
      const at = queue.shift() as string;
      const dir = await fsOpendir(at);
      try {
        for (;;) {
          const entry = await dir.read();
          if (timedOut) return cut();
          if (entry === null) break;
          names.push(entry.name);
          if (names.length > GUARDED_WALK_ENTRY_CAP) return cut();
          if (!entry.isDirectory()) continue;
          // git's object store: names of git's own shapes, judged by text.
          if (isGit && at === path && entry.name === "objects") continue;
          queue.push(join(at, entry.name));
        }
      } finally {
        dir.close().catch(() => undefined);
      }
    }
    return names;
  })().catch((): GlobListing => "unreadable");
  const deadline = new Promise<GlobListing>((settle) => {
    timer = setTimeout(() => {
      timedOut = true;
      settle(cut());
    }, timeoutMs);
  });
  try {
    return await Promise.race([walking, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** One directory's names, `"missing"` when it is not there, or `"unreadable"` on any other error, the cap or the timeout. */
export async function listGlobDirectory(path: string, options: GlobListingOptions = {}): Promise<GlobListing> {
  const opener = options.opendir ?? ((dir: string) => fsOpendir(dir));
  const cap = options.entryCap ?? GLOB_LISTING_ENTRY_CAP;
  const timeoutMs = options.timeoutMs ?? GLOB_LISTING_TIMEOUT_MS;
  let handle: Dir | null = null;
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const close = (): void => {
    const open = handle;
    handle = null;
    if (open !== null) open.close().catch(() => undefined);
  };
  const reading = (async (): Promise<GlobListing> => {
    const dir = await opener(path);
    if (timedOut) {
      dir.close().catch(() => undefined);
      return "unreadable";
    }
    handle = dir;
    const names: string[] = [];
    for (;;) {
      const entry = await dir.read();
      if (timedOut) return "unreadable";
      if (entry === null) break;
      names.push(entry.name);
      if (names.length > cap) return "unreadable";
    }
    return names;
  })().catch((error: unknown): GlobListing => {
    // A directory that is not there (or a file): the classifier reads it as
    // empty only for a glob on a one-segment line, never for a contents copy.
    const code = (error as { code?: unknown } | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable";
  });
  const deadline = new Promise<GlobListing>((settle) => {
    timer = setTimeout(() => {
      timedOut = true;
      settle("unreadable");
    }, timeoutMs);
  });
  try {
    return await Promise.race([reading, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    close();
  }
}

/**
 * The listings for `command`'s write-target patterns, placed against `cwd`
 * (and `home` for a `~` prefix), every directory at once. A directory past the
 * cap is left out, which the classifier reads as "not listed": strict.
 */
export async function listGlobWriteDirs(
  command: string,
  cwd: string,
  home: string | null = safeHome(),
  options: GlobListingOptions = {},
): Promise<Map<string, GlobListing>> {
  const listings = new Map<string, GlobListing>();
  let dirs: string[];
  let ran: { ok: true; value: string[] } | { ok: false };
  try {
    const find = (): string[] => globWriteListingDirs(command, cwd, home);
    ran = options.deadlineAt === undefined ? { ok: true, value: find() } : runUnderDeadline(Math.max(1, options.deadlineAt - Date.now()), find);
  } catch {
    return listings;
  }
  if (!ran.ok) throw new GlobListingDeadline();
  dirs = ran.value;
  const chosen = dirs.slice(0, options.dirCap ?? GLOB_LISTING_DIR_CAP);
  const results = await Promise.all(chosen.map((dir) => listGlobDirectory(dir, options)));
  chosen.forEach((dir, index) => listings.set(dir, results[index] as GlobListing));
  // Lead ruling L62511 (S-C): on a line that may run `find … -delete`, what
  // each guarded folder in a listed directory holds, at every depth, so a
  // narrowed find is judged by what its names may reach inside them.
  if (/\bfind\b/u.test(command) && /-delete\b/u.test(command)) {
    const folders: string[] = [];
    chosen.forEach((dir, index) => {
      const listing = results[index];
      if (!Array.isArray(listing)) return;
      for (const name of listing as readonly string[]) if (guardedFolderName(name)) folders.push(`${dir.replace(/\/+$/u, "")}/${name}`);
    });
    const walked = await Promise.all(folders.map((folder) => walkGuardedFolder(folder, options)));
    folders.forEach((folder, index) => listings.set(guardedContentsKey(folder), walked[index] as GlobListing));
  }
  // The canonical form of each listed path and of the working directory and
  // the home (lead ruling L61587, security review 6): the classifier compares
  // these to see whether an absolute path reaches either by another spelling
  // (a symlink, another letter case). One it lacks fails closed.
  if (chosen.length > 0) {
    const paths = [...new Set([...chosen, cwd, ...(home === null ? [] : [home])])].filter((path) => path.startsWith("/"));
    const canonical = await Promise.all(paths.map((path) => canonicalPath(path, options.timeoutMs ?? GLOB_LISTING_TIMEOUT_MS)));
    paths.forEach((path, index) => {
      const resolved = canonical[index];
      if (resolved !== null && resolved !== undefined) listings.set(realpathKey(path), [resolved]);
    });
  }
  return listings;
}

/** Most path components dropped while looking for the part of a path that exists. */
const CANONICAL_MISSING_CAP = 32;

/**
 * `path` with symlinks resolved and letter case as on disk: the realpath of
 * the longest prefix that exists, with the rest appended. `null` on any other
 * error or the deadline: the classifier then fails closed.
 */
export async function canonicalPath(path: string, timeoutMs: number = GLOB_LISTING_TIMEOUT_MS): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined;
  const resolving = (async (): Promise<string | null> => {
    const rest: string[] = [];
    let at = path;
    for (let dropped = 0; dropped <= CANONICAL_MISSING_CAP; dropped += 1) {
      try {
        return join(await fsRealpath(at), ...rest.reverse());
      } catch (error: unknown) {
        const code = (error as { code?: unknown } | null)?.code;
        if ((code !== "ENOENT" && code !== "ENOTDIR") || at === "/") return null;
        rest.push(basename(at));
        at = dirname(at);
      }
    }
    return null;
  })();
  const deadline = new Promise<null>((settle) => {
    timer = setTimeout(() => settle(null), timeoutMs);
  });
  try {
    return await Promise.race([resolving, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The listings for every directory a call may classify against (the per-call
 * cwd and the hook's own), merged: a directory is keyed by its absolute path,
 * so two cwds share the entries they have in common.
 */
export async function listGlobWriteDirsFor(
  command: string,
  cwds: readonly string[],
  options: GlobListingOptions = {},
): Promise<Map<string, GlobListing>> {
  const merged = new Map<string, GlobListing>();
  for (const cwd of new Set(cwds)) {
    for (const [dir, listing] of await listGlobWriteDirs(command, cwd, safeHome(), options)) merged.set(dir, listing);
  }
  return merged;
}

/** The `GlobDisk` a classifier call takes, for one cwd. */
export function globDiskFor(cwd: string, listings: ReadonlyMap<string, GlobListing>): GlobDisk {
  return { cwd, home: safeHome(), listings };
}

function safeHome(): string | null {
  const fromEnv = process.env["HOME"];
  if (fromEnv !== undefined && fromEnv.startsWith("/")) return fromEnv;
  try {
    const home = homedir();
    return home.startsWith("/") ? home : null;
  } catch {
    return null;
  }
}
