/** Strict parsing and path classification for Codex `apply_patch` (APRV-312). */

import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { protectedPathClass, type ProtectedPathEntry } from "./command-class.js";

export type ApplyPatchOperation =
  | { kind: "add"; path: string; lines: string[] }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; hunks: ApplyPatchHunk[]; eof: boolean };

export interface ApplyPatchHunk {
  header: string;
  lines: string[];
}

export type ApplyPatchParseResult =
  | { ok: true; operations: ApplyPatchOperation[] }
  | { ok: false; detail: string };

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const EOF_MARKER = "*** End of File";
const OPERATION_HEADER = /^\*\*\* (Add|Delete|Update) File: (.+)$/u;
const MOVE_HEADER = /^\*\*\* Move to: (.+)$/u;
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:|[\\/]{2})/u;

function safePath(raw: string): string | null {
  if (raw.length === 0 || raw !== raw.trim()) return null;
  if (isAbsolute(raw) || WINDOWS_ABSOLUTE.test(raw)) return null;
  // On POSIX a backslash is a filename byte, while on Windows it is a path
  // separator. Reject it so parsing and filesystem resolution cannot disagree.
  if (raw.includes("\\")) return null;
  const normalized = raw;
  const parts = normalized.split("/");
  if (
    parts.some((part) => part.length === 0 || part === "." || part === "..") ||
    normalized.endsWith("/")
  ) {
    return null;
  }
  return normalized;
}

function pathOrError(raw: string, line: number): { ok: true; path: string } | { ok: false; detail: string } {
  const path = safePath(raw);
  return path === null
    ? { ok: false, detail: `line ${String(line)} names an unsafe or ambiguous relative path` }
    : { ok: true, path };
}

/** Parse one exact apply_patch envelope. No filesystem reads occur here. */
export function parseApplyPatch(raw: string): ApplyPatchParseResult {
  if (raw.includes("\0")) return { ok: false, detail: "patch contains NUL" };
  if (raw.includes("\r")) return { ok: false, detail: "patch contains CR" };
  const body = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  const lines = body.split("\n");
  if (lines[0] !== BEGIN) return { ok: false, detail: `line 1 must be ${BEGIN}` };
  if (lines[lines.length - 1] !== END) {
    return { ok: false, detail: `last line must be ${END}, with at most one terminal LF` };
  }

  const operations: ApplyPatchOperation[] = [];
  const claimed = new Set<string>();
  let index = 1;
  const claim = (path: string, line: number): string | null => {
    if (claimed.has(path)) return `line ${String(line)} repeats or conflicts with path ${JSON.stringify(path)}`;
    claimed.add(path);
    return null;
  };

  while (index < lines.length - 1) {
    const header = OPERATION_HEADER.exec(lines[index] ?? "");
    if (header === null) {
      return { ok: false, detail: `line ${String(index + 1)} is not an Add, Delete, or Update header` };
    }
    const kind = (header[1] ?? "").toLowerCase() as "add" | "delete" | "update";
    const parsedPath = pathOrError(header[2] ?? "", index + 1);
    if (!parsedPath.ok) return parsedPath;
    const conflict = claim(parsedPath.path, index + 1);
    if (conflict !== null) return { ok: false, detail: conflict };
    index += 1;

    if (kind === "add") {
      const added: string[] = [];
      while (index < lines.length - 1 && !OPERATION_HEADER.test(lines[index] ?? "")) {
        const line = lines[index] ?? "";
        if (!line.startsWith("+")) {
          return { ok: false, detail: `line ${String(index + 1)} in Add File must start with +` };
        }
        added.push(line.slice(1));
        index += 1;
      }
      if (added.length === 0) return { ok: false, detail: "Add File must contain at least one + line" };
      operations.push({ kind, path: parsedPath.path, lines: added });
      continue;
    }

    if (kind === "delete") {
      const next = lines[index] ?? "";
      if (index < lines.length - 1 && !OPERATION_HEADER.test(next)) {
        return { ok: false, detail: `line ${String(index + 1)} follows Delete File with a body` };
      }
      operations.push({ kind, path: parsedPath.path });
      continue;
    }

    let moveTo: string | undefined;
    const move = MOVE_HEADER.exec(lines[index] ?? "");
    if (move !== null) {
      const destination = pathOrError(move[1] ?? "", index + 1);
      if (!destination.ok) return destination;
      const destinationConflict = claim(destination.path, index + 1);
      if (destinationConflict !== null) return { ok: false, detail: destinationConflict };
      moveTo = destination.path;
      index += 1;
    }

    const hunks: ApplyPatchHunk[] = [];
    let eof = false;
    let changed = false;
    while (index < lines.length - 1 && !OPERATION_HEADER.test(lines[index] ?? "")) {
      const headerLine = lines[index] ?? "";
      if (headerLine === EOF_MARKER) {
        if (hunks.length === 0 || eof) {
          return { ok: false, detail: `line ${String(index + 1)} has a misplaced ${EOF_MARKER}` };
        }
        eof = true;
        index += 1;
        if (index < lines.length - 1 && !OPERATION_HEADER.test(lines[index] ?? "")) {
          return { ok: false, detail: `${EOF_MARKER} must be last in its Update File operation` };
        }
        break;
      }
      if (headerLine !== "@@" && !/^@@ .+$/u.test(headerLine)) {
        return { ok: false, detail: `line ${String(index + 1)} is not a valid @@ hunk header` };
      }
      index += 1;
      const hunkLines: string[] = [];
      let hunkChanged = false;
      while (index < lines.length - 1) {
        const line = lines[index] ?? "";
        if (line === EOF_MARKER || OPERATION_HEADER.test(line) || line === "@@" || /^@@ .+$/u.test(line)) break;
        if (!(line.startsWith(" ") || line.startsWith("+") || line.startsWith("-"))) {
          return { ok: false, detail: `line ${String(index + 1)} in an Update hunk must start with space, +, or -` };
        }
        if (line.startsWith("+") || line.startsWith("-")) hunkChanged = true;
        hunkLines.push(line);
        index += 1;
      }
      if (hunkLines.length === 0) return { ok: false, detail: "an Update hunk must contain lines" };
      if (!hunkChanged) return { ok: false, detail: "an Update hunk must add or remove at least one line" };
      changed ||= hunkChanged;
      hunks.push({ header: headerLine, lines: hunkLines });
    }
    if (hunks.length === 0 && moveTo === undefined) {
      return { ok: false, detail: "Update File must contain a change or an immediate Move to" };
    }
    if (hunks.length > 0 && !changed) return { ok: false, detail: "Update File changes no lines" };
    operations.push({
      kind,
      path: parsedPath.path,
      ...(moveTo === undefined ? {} : { moveTo }),
      hunks,
      eof,
    });
  }

  if (operations.length === 0) return { ok: false, detail: "patch contains no operations" };
  return { ok: true, operations };
}

export interface ApplyPatchTarget {
  role: "add" | "delete" | "update" | "move-destination";
  path: string;
  absolute: string;
  resolved: string;
  classes: string[];
}

export type ApplyPatchClassification =
  | { ok: true; operations: ApplyPatchOperation[]; targets: ApplyPatchTarget[]; classes: string[] }
  | { ok: false; detail: string };

function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function resolveNearest(path: string): string | null {
  let current = path;
  const tail: string[] = [];
  for (;;) {
    try {
      lstatSync(current);
      const base = realpathSync(current);
      return tail.length === 0 ? base : resolve(base, ...tail);
    } catch (cause) {
      const code =
        typeof cause === "object" && cause !== null && "code" in cause
          ? String((cause as { code?: unknown }).code)
          : "";
      // A dangling symlink and permission/IO failures are unsafe. Only a path
      // component that genuinely does not exist may be resolved via its parent.
      if (code !== "ENOENT") return null;
      try {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink()) return null;
      } catch (lstatCause) {
        const lstatCode =
          typeof lstatCause === "object" && lstatCause !== null && "code" in lstatCause
            ? String((lstatCause as { code?: unknown }).code)
            : "";
        if (lstatCode !== "ENOENT") return null;
      }
      const parent = dirname(current);
      if (parent === current) return null;
      tail.unshift(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      current = parent;
    }
  }
}

/** Resolve and classify every source and destination of a parsed patch. */
export function classifyApplyPatch(
  parsed: { operations: ApplyPatchOperation[] },
  cwd: string,
  protectedPaths: readonly ProtectedPathEntry[] = [],
): ApplyPatchClassification {
  let root: string;
  try {
    root = realpathSync(cwd);
  } catch {
    return { ok: false, detail: "the patch execution directory could not be resolved" };
  }
  const targets: ApplyPatchTarget[] = [];
  const classes: string[] = [];

  const addTarget = (
    role: ApplyPatchTarget["role"],
    path: string,
    mustExist: boolean,
    mustNotExist: boolean,
  ): string | null => {
    const absolute = resolve(root, path);
    if (!within(root, absolute)) return `${path} escapes the patch execution directory`;
    let exists = false;
    try {
      lstatSync(absolute);
      exists = true;
    } catch (cause) {
      const code =
        typeof cause === "object" && cause !== null && "code" in cause
          ? String((cause as { code?: unknown }).code)
          : "";
      if (code !== "ENOENT") return `${path} could not be inspected safely for ${role}`;
    }
    if (mustExist && !exists) return `${path} does not exist for ${role}`;
    if (mustNotExist && exists) return `${path} already exists for ${role}`;
    const resolved = resolveNearest(absolute);
    if (resolved === null || !within(root, resolved)) {
      return `${path} resolves outside the patch execution directory or through an unreadable ancestor`;
    }
    const resolvedRelative = relative(root, resolved).split(sep).join("/");
    const targetClasses = [
      protectedPathClass(path, protectedPaths),
      protectedPathClass(absolute, protectedPaths),
      protectedPathClass(resolvedRelative, protectedPaths),
      protectedPathClass(resolved, protectedPaths),
    ].filter((value): value is string => value !== null);
    if (targetClasses.length === 0) targetClasses.push("files.write.workspace");
    const unique = [...new Set(targetClasses)];
    for (const cls of unique) if (!classes.includes(cls)) classes.push(cls);
    targets.push({ role, path, absolute, resolved, classes: unique });
    return null;
  };

  for (const operation of parsed.operations) {
    const sourceError = addTarget(
      operation.kind,
      operation.path,
      operation.kind !== "add",
      operation.kind === "add",
    );
    if (sourceError !== null) return { ok: false, detail: sourceError };
    if (operation.kind === "update" && operation.moveTo !== undefined) {
      const destinationError = addTarget("move-destination", operation.moveTo, false, true);
      if (destinationError !== null) return { ok: false, detail: destinationError };
    }
  }
  return { ok: true, operations: parsed.operations, targets, classes };
}
