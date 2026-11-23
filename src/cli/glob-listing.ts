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

import { opendir as fsOpendir, realpath as fsRealpath } from "node:fs/promises";
import type { Dir } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { globWriteListingDirs, realpathKey, type GlobDisk } from "../core/command-class.js";

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
  try {
    dirs = globWriteListingDirs(command, cwd, home);
  } catch {
    return listings;
  }
  const chosen = dirs.slice(0, options.dirCap ?? GLOB_LISTING_DIR_CAP);
  const results = await Promise.all(chosen.map((dir) => listGlobDirectory(dir, options)));
  chosen.forEach((dir, index) => listings.set(dir, results[index] as GlobListing));
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
