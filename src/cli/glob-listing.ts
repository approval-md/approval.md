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
 * A directory that is not there (`ENOENT`, `ENOTDIR`) is listed as empty.
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

import { opendir as fsOpendir } from "node:fs/promises";
import type { Dir } from "node:fs";
import { homedir } from "node:os";

import { globWriteListingDirs, type GlobDisk } from "../core/command-class.js";

/** Most entries one directory is read for before it is judged unreadable. */
export const GLOB_LISTING_ENTRY_CAP = 2_000;
/** Each directory's own deadline; all are listed at once. */
export const GLOB_LISTING_TIMEOUT_MS = 2_000;
/** Most directories one command lists; the rest keep the strict answer. */
export const GLOB_LISTING_DIR_CAP = 16;

export type GlobListing = readonly string[] | "unreadable";

/** The directory opener, injectable for tests (a slow or failing one). */
export type DirOpener = (path: string) => Promise<Dir>;

export interface GlobListingOptions {
  opendir?: DirOpener;
  entryCap?: number;
  timeoutMs?: number;
  dirCap?: number;
}

/** One directory's names, or `"unreadable"` on error, cap or timeout. */
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
    // A directory that is not there (or a file) holds no name: a pattern in it
    // matches nothing, and a copy into it lands beside no guarded directory.
    const code = (error as { code?: unknown } | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? [] : "unreadable";
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
  return listings;
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
