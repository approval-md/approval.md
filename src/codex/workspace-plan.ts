/**
 * Read-only planning for a future policy-bound Codex workspace broker (APRV-325.2.1).
 *
 * This module validates a closed change language, classifies every endpoint,
 * and binds the bytes and filesystem identities it observes. It does not append
 * to the approval log, mutate a workspace, establish OS custody, or make the
 * supplied context trustworthy. A future broker must supply that context from
 * its protected configuration and retain exclusive write custody while it
 * revalidates and applies an authorized plan.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { protectedPathClass } from "../core/command-class.js";
import { canonicalize } from "../core/jcs.js";
import type { PolicyLoadResult } from "../core/policy-load.js";
import { resolve as resolvePolicy } from "../core/policy-match.js";
import { payloadHash } from "../core/payload.js";

export const WORKSPACE_PLAN_VERSION = "approval.codex.workspace-plan.v1" as const;
export const MAX_WORKSPACE_OPERATIONS = 64;
export const MAX_WORKSPACE_PATH_BYTES = 1_024;
export const MAX_WORKSPACE_IMAGE_BYTES = 1_048_576;
export const MAX_WORKSPACE_TOTAL_BYTES = 8_388_608;
export const MAX_WORKSPACE_DIRECTORY_ENTRIES = 4_096;

const HEX64 = /^[0-9a-f]{64}$/u;
const MAX_BASE64_LENGTH = 4 * Math.ceil(MAX_WORKSPACE_IMAGE_BYTES / 3);
const ALWAYS_HUMAN_ONLY = new Set(["policy.core", "log.mutate", "account.credential"]);

export type WorkspaceOperationInput =
  | { kind: "create"; path: string; after_base64: string }
  | { kind: "replace"; path: string; expected_before_sha256: string; after_base64: string }
  | { kind: "delete"; path: string; expected_before_sha256: string }
  | { kind: "move"; from: string; to: string; expected_before_sha256: string };

/**
 * Assertions supplied by the future trusted broker. The planner validates their
 * shape and binds them; possession of this object proves no custody or attestation.
 */
export interface WorkspacePlanContext {
  actor: string;
  root: string;
  policy_sha256: string;
  policy: PolicyLoadResult;
}

export interface FsIdentity {
  dev: string;
  ino: string;
}

export interface DirectoryBinding extends FsIdentity {
  path: string;
}

export interface FileMetadata extends FsIdentity {
  mode: string;
  uid: string;
  gid: string;
  nlink: string;
  size: string;
  mtime_ns: string;
  ctime_ns: string;
}

export interface BoundImage {
  base64: string;
  sha256: string;
  byte_length: number;
}

export interface BoundFileImage extends BoundImage {
  metadata: FileMetadata;
}

export type PlannedWorkspaceOperation =
  | {
      kind: "create";
      path: string;
      class: string;
      directories: readonly DirectoryBinding[];
      after: BoundImage;
    }
  | {
      kind: "replace";
      path: string;
      class: string;
      directories: readonly DirectoryBinding[];
      before: BoundFileImage;
      after: BoundImage;
    }
  | {
      kind: "delete";
      path: string;
      class: string;
      directories: readonly DirectoryBinding[];
      before: BoundFileImage;
    }
  | {
      kind: "move";
      from: string;
      to: string;
      classes: readonly string[];
      source_directories: readonly DirectoryBinding[];
      destination_directories: readonly DirectoryBinding[];
      before: BoundFileImage;
      after: BoundImage;
    };

export interface WorkspacePlanPayload {
  version: typeof WORKSPACE_PLAN_VERSION;
  actor: string;
  root: string;
  root_identity: FsIdentity;
  policy_sha256: string;
  operations: readonly PlannedWorkspaceOperation[];
}

export interface WorkspaceActionLeg {
  class: string;
  reversible: false;
  payload_hash: string;
}

export interface WorkspacePlan {
  payload: WorkspacePlanPayload;
  payload_hash: string;
  actions: readonly WorkspaceActionLeg[];
}

export type WorkspacePlanRefusalCode =
  | "input-invalid"
  | "operation-limit"
  | "path-invalid"
  | "path-conflict"
  | "payload-too-large"
  | "policy-unavailable"
  | "class-human-only"
  | "root-unsafe"
  | "parent-unsafe"
  | "source-unsafe"
  | "destination-exists"
  | "preimage-mismatch"
  | "workspace-drift"
  | "context-drift";

export type WorkspacePlanResult =
  | { ok: true; plan: WorkspacePlan }
  | { ok: false; code: WorkspacePlanRefusalCode; message: string; path?: string };

type ParsedOperation =
  | { kind: "create"; path: string; after: Buffer }
  | { kind: "replace"; path: string; expected: string; after: Buffer }
  | { kind: "delete"; path: string; expected: string }
  | { kind: "move"; from: string; to: string; expected: string };

type ClassifiedOperation =
  | { kind: "create"; path: string; after: Buffer; cls: string }
  | { kind: "replace"; path: string; expected: string; after: Buffer; cls: string }
  | { kind: "delete"; path: string; expected: string; cls: string }
  | { kind: "move"; from: string; to: string; expected: string; classes: string[] };

function refuse(
  code: WorkspacePlanRefusalCode,
  message: string,
  path?: string,
): WorkspacePlanResult {
  return path === undefined ? { ok: false, code, message } : { ok: false, code, message, path };
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function containsControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x1f || unit === 0x7f) return true;
  }
  return false;
}

function hasWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function agentActor(value: string): boolean {
  return value.startsWith("agent:") &&
    value.length > "agent:".length &&
    !containsControl(value) &&
    hasWellFormedUtf16(value);
}

function safePath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value !== value.normalize("NFC")) return null;
  if (!hasWellFormedUtf16(value)) return null;
  if (Buffer.byteLength(value, "utf8") > MAX_WORKSPACE_PATH_BYTES) return null;
  if (isAbsolute(value) || value.includes("\\") || containsControl(value)) return null;
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return null;
  return value;
}

type Base64Result = { ok: true; bytes: Buffer } | { ok: false; aggregate: boolean };

function decodeCanonicalBase64(value: unknown, remaining: number): Base64Result {
  if (typeof value !== "string" || value.length > MAX_BASE64_LENGTH || value.length % 4 !== 0) {
    return { ok: false, aggregate: false };
  }
  let padding = 0;
  if (value.endsWith("==")) padding = 2;
  else if (value.endsWith("=")) padding = 1;
  const contentLength = value.length - padding;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const inAlphabet =
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2b || code === 0x2f;
    if ((index < contentLength && !inAlphabet) || (index >= contentLength && code !== 0x3d)) {
      return { ok: false, aggregate: false };
    }
  }
  const decodedLength = value.length === 0 ? 0 : (value.length / 4) * 3 - padding;
  if (decodedLength > MAX_WORKSPACE_IMAGE_BYTES) return { ok: false, aggregate: false };
  if (decodedLength > remaining) return { ok: false, aggregate: true };
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== decodedLength || decoded.toString("base64") !== value) {
    return { ok: false, aggregate: false };
  }
  return { ok: true, bytes: decoded };
}

function parseOperations(value: unknown): WorkspacePlanResult | ParsedOperation[] {
  if (!Array.isArray(value) || value.length === 0) {
    return refuse("input-invalid", "workspace proposal must be a nonempty array of operations");
  }
  if (value.length > MAX_WORKSPACE_OPERATIONS) {
    return refuse("operation-limit", `workspace proposal exceeds ${String(MAX_WORKSPACE_OPERATIONS)} operations`);
  }
  const parsed: ParsedOperation[] = [];
  let afterBytes = 0;
  for (const candidate of value) {
    if (!plainObject(candidate) || typeof candidate["kind"] !== "string") {
      return refuse("input-invalid", "each workspace operation must be one strict object");
    }
    const kind = candidate["kind"];
    if (kind === "create") {
      if (!exactKeys(candidate, ["kind", "path", "after_base64"])) {
        return refuse("input-invalid", "create accepts only kind, path and after_base64");
      }
      const path = safePath(candidate["path"]);
      if (path === null) return refuse("path-invalid", "create path is not a strict relative NFC POSIX path");
      const decoded = decodeCanonicalBase64(candidate["after_base64"], MAX_WORKSPACE_TOTAL_BYTES - afterBytes);
      if (!decoded.ok) {
        return refuse(decoded.aggregate ? "payload-too-large" : "input-invalid", decoded.aggregate ? "proposal after-images exceed the combined byte limit" : "create after_base64 is not canonical bounded base64", path);
      }
      afterBytes += decoded.bytes.byteLength;
      parsed.push({ kind, path, after: decoded.bytes });
      continue;
    }
    if (kind === "replace") {
      if (!exactKeys(candidate, ["kind", "path", "expected_before_sha256", "after_base64"])) {
        return refuse("input-invalid", "replace accepts only its four documented fields");
      }
      const path = safePath(candidate["path"]);
      if (path === null) return refuse("path-invalid", "replace path is not a strict relative NFC POSIX path");
      const expected = candidate["expected_before_sha256"];
      const decoded = decodeCanonicalBase64(candidate["after_base64"], MAX_WORKSPACE_TOTAL_BYTES - afterBytes);
      if (!decoded.ok && decoded.aggregate) {
        return refuse("payload-too-large", "proposal after-images exceed the combined byte limit", path);
      }
      if (typeof expected !== "string" || !HEX64.test(expected) || !decoded.ok) {
        return refuse("input-invalid", "replace needs a lowercase SHA-256 preimage and canonical bounded base64", path);
      }
      afterBytes += decoded.bytes.byteLength;
      parsed.push({ kind, path, expected, after: decoded.bytes });
      continue;
    }
    if (kind === "delete") {
      if (!exactKeys(candidate, ["kind", "path", "expected_before_sha256"])) {
        return refuse("input-invalid", "delete accepts only kind, path and expected_before_sha256");
      }
      const path = safePath(candidate["path"]);
      const expected = candidate["expected_before_sha256"];
      if (path === null) return refuse("path-invalid", "delete path is not a strict relative NFC POSIX path");
      if (typeof expected !== "string" || !HEX64.test(expected)) {
        return refuse("input-invalid", "delete needs a lowercase SHA-256 preimage", path);
      }
      parsed.push({ kind, path, expected });
      continue;
    }
    if (kind === "move") {
      if (!exactKeys(candidate, ["kind", "from", "to", "expected_before_sha256"])) {
        return refuse("input-invalid", "move accepts only kind, from, to and expected_before_sha256");
      }
      const from = safePath(candidate["from"]);
      const to = safePath(candidate["to"]);
      const expected = candidate["expected_before_sha256"];
      if (from === null || to === null) return refuse("path-invalid", "move endpoints must be strict relative NFC POSIX paths");
      if (typeof expected !== "string" || !HEX64.test(expected)) {
        return refuse("input-invalid", "move needs a lowercase SHA-256 preimage", from);
      }
      parsed.push({ kind, from, to, expected });
      continue;
    }
    return refuse("input-invalid", `unknown workspace operation kind ${JSON.stringify(kind)}`);
  }
  return parsed;
}

function endpoints(operation: ParsedOperation): string[] {
  return operation.kind === "move" ? [operation.from, operation.to] : [operation.path];
}

function conflictPath(operations: readonly ParsedOperation[]): string | null {
  const all = operations.flatMap(endpoints).map((path) => ({ path, folded: path.toLowerCase() }));
  for (let left = 0; left < all.length; left += 1) {
    for (let right = left + 1; right < all.length; right += 1) {
      const a = all[left];
      const b = all[right];
      if (a === undefined || b === undefined) continue;
      if (a.folded === b.folded || a.folded.startsWith(`${b.folded}/`) || b.folded.startsWith(`${a.folded}/`)) {
        return `${a.path} conflicts or overlaps with ${b.path}`;
      }
    }
  }
  return null;
}

function classFor(path: string, policy: Extract<PolicyLoadResult, { ok: true }>): string {
  return protectedPathClass(path, policy.policy.protected_paths ?? []) ?? "files.write.workspace";
}

function classify(
  operations: readonly ParsedOperation[],
  policy: Extract<PolicyLoadResult, { ok: true }>,
): WorkspacePlanResult | ClassifiedOperation[] {
  const result: ClassifiedOperation[] = [];
  for (const operation of operations) {
    const paths = endpoints(operation);
    const classes = paths.map((path) => classFor(path, policy));
    for (let index = 0; index < classes.length; index += 1) {
      const cls = classes[index];
      const path = paths[index];
      if (cls === undefined || path === undefined) continue;
      const resolution = resolvePolicy(policy, cls, { reversible: false });
      if (ALWAYS_HUMAN_ONLY.has(cls) || resolution.autonomy === "human-only") {
        return refuse("class-human-only", `${path} resolves to human-only class ${cls}; no preimage was read`, path);
      }
    }
    if (operation.kind === "move") {
      result.push({ ...operation, classes: [...new Set(classes)].sort() });
    } else {
      const cls = classes[0];
      if (cls === undefined) return refuse("input-invalid", "operation has no classified endpoint");
      result.push({ ...operation, cls });
    }
  }
  return result;
}

function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function identity(stats: BigIntStats): FsIdentity {
  return { dev: stats.dev.toString(), ino: stats.ino.toString() };
}

function metadata(stats: BigIntStats): FileMetadata {
  return {
    ...identity(stats),
    mode: stats.mode.toString(),
    uid: stats.uid.toString(),
    gid: stats.gid.toString(),
    nlink: stats.nlink.toString(),
    size: stats.size.toString(),
    mtime_ns: stats.mtimeNs.toString(),
    ctime_ns: stats.ctimeNs.toString(),
  };
}

function sameMetadata(left: FileMetadata, right: FileMetadata): boolean {
  return canonicalize(left) === canonicalize(right);
}

function directoryIdentity(path: string): FsIdentity | null {
  let fd: number | null = null;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_DIRECTORY,
    );
    const stats = fstatSync(fd, { bigint: true });
    return stats.isDirectory() ? identity(stats) : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function checkSpelling(parent: string, name: string): "exact" | "alias" | "absent" | "unsafe" {
  let directory: ReturnType<typeof opendirSync> | null = null;
  try {
    directory = opendirSync(parent);
    const matches: string[] = [];
    let count = 0;
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      count += 1;
      if (count > MAX_WORKSPACE_DIRECTORY_ENTRIES) return "unsafe";
      if (entry.name.toLowerCase() === name.toLowerCase()) matches.push(entry.name);
    }
    if (matches.length === 0) return "absent";
    if (matches.length === 1 && matches[0] === name) return "exact";
    return "alias";
  } catch {
    return "unsafe";
  } finally {
    try { directory?.closeSync(); } catch { /* already closed or unreadable */ }
  }
}

type EndpointInspection = { absolute: string; directories: DirectoryBinding[]; exists: boolean };

function inspectEndpoint(root: string, path: string, mustExist: boolean): WorkspacePlanResult | EndpointInspection {
  const absolute = resolve(root, path);
  if (!within(root, absolute) || absolute === root) return refuse("path-invalid", `${path} does not name a file below the workspace`, path);
  const parts = path.split("/");
  let current = root;
  const directories: DirectoryBinding[] = [];
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (part === undefined) return refuse("parent-unsafe", `${path} has an unreadable parent`, path);
    const spelling = checkSpelling(current, part);
    if (spelling !== "exact") return refuse("parent-unsafe", `${path} has a missing, aliased, or unreadable parent`, path);
    const next = join(current, part);
    let stats: BigIntStats;
    try {
      stats = lstatSync(next, { bigint: true });
    } catch {
      return refuse("parent-unsafe", `${path} has an unreadable parent`, path);
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      return refuse("parent-unsafe", `${path} has a non-directory or symbolic-link parent`, path);
    }
    current = next;
    directories.push({ path: parts.slice(0, index + 1).join("/"), ...identity(stats) });
  }
  const parent = directoryIdentity(dirname(absolute));
  if (parent === null) return refuse("parent-unsafe", `${path} parent could not be opened safely`, path);
  if (parts.length > 1) {
    const bound = directories.at(-1);
    if (bound === undefined || bound.dev !== parent.dev || bound.ino !== parent.ino) {
      return refuse("parent-unsafe", `${path} parent identity changed during inspection`, path);
    }
  }
  const leaf = parts.at(-1);
  if (leaf === undefined) return refuse("path-invalid", `${path} has no leaf`, path);
  const spelling = checkSpelling(dirname(absolute), leaf);
  if (spelling === "alias" || spelling === "unsafe") {
    return refuse("path-conflict", `${path} is an aliased or unreadable directory entry`, path);
  }
  const exists = spelling === "exact";
  if (mustExist && !exists) return refuse("source-unsafe", `${path} does not exist`, path);
  if (!mustExist && exists) return refuse("destination-exists", `${path} already exists`, path);
  return { absolute, directories, exists };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function image(bytes: Buffer): BoundImage {
  return { base64: bytes.toString("base64"), sha256: sha256(bytes), byte_length: bytes.byteLength };
}

function readFileImage(path: string, remainingBytes: number): WorkspacePlanResult | BoundFileImage {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) {
      return refuse("source-unsafe", `${path} is not a regular single-link file`, path);
    }
    const allowed = Math.min(MAX_WORKSPACE_IMAGE_BYTES, Math.max(0, remainingBytes));
    if (before.size > BigInt(allowed)) {
      return refuse("payload-too-large", `${path} exceeds the remaining bounded image budget`, path);
    }
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.byteLength) {
      const count = readSync(fd, buffer, length, buffer.byteLength - length, length);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_WORKSPACE_IMAGE_BYTES) {
      return refuse("payload-too-large", `${path} exceeded the image limit while it was read`, path);
    }
    const after = fstatSync(fd, { bigint: true });
    const beforeMetadata = metadata(before);
    if (BigInt(length) !== before.size || !after.isFile() || after.nlink !== 1n || !sameMetadata(beforeMetadata, metadata(after))) {
      return refuse("source-unsafe", `${path} changed identity or metadata while it was read`, path);
    }
    const bytes = Buffer.from(buffer.subarray(0, length));
    return { ...image(bytes), metadata: beforeMetadata };
  } catch {
    return refuse("source-unsafe", `${path} could not be opened and read safely`, path);
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const member of Object.values(value as Record<string, unknown>)) deepFreeze(member);
  return value;
}

/** Build a deterministic immutable proposal without changing the workspace. */
export function planWorkspaceProposal(
  input: unknown,
  context: WorkspacePlanContext,
): WorkspacePlanResult {
  if (!agentActor(context.actor) || !HEX64.test(context.policy_sha256)) {
    return refuse("input-invalid", "trusted context has an invalid actor or policy digest");
  }
  if (!context.policy.ok) return refuse("policy-unavailable", "trusted policy snapshot did not load");
  if (!isAbsolute(context.root) || resolve(context.root) !== context.root) {
    return refuse("root-unsafe", "workspace root must be a normalized absolute path");
  }
  let root: string;
  try {
    const rootStats = lstatSync(context.root, { bigint: true });
    root = realpathSync(context.root);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || root !== context.root) {
      return refuse("root-unsafe", "workspace root must be a real non-symbolic directory");
    }
  } catch {
    return refuse("root-unsafe", "workspace root could not be resolved safely");
  }
  const rootIdentity = directoryIdentity(root);
  if (rootIdentity === null) return refuse("root-unsafe", "workspace root could not be opened safely");
  try {
    const rootNow = lstatSync(root, { bigint: true });
    if (rootIdentity.dev !== rootNow.dev.toString() || rootIdentity.ino !== rootNow.ino.toString()) {
      return refuse("root-unsafe", "workspace root identity changed during inspection");
    }
  } catch {
    return refuse("root-unsafe", "workspace root changed during inspection");
  }

  const parsed = parseOperations(input);
  if (!Array.isArray(parsed)) return parsed;
  const conflict = conflictPath(parsed);
  if (conflict !== null) return refuse("path-conflict", conflict);

  // All authority decisions precede endpoint inspection and preimage reads.
  const classified = classify(parsed, context.policy);
  if (!Array.isArray(classified)) return classified;

  const planned: PlannedWorkspaceOperation[] = [];
  let totalBytes = classified.reduce((sum, operation) =>
    sum + (operation.kind === "create" || operation.kind === "replace" ? operation.after.byteLength : 0), 0);
  for (const operation of classified) {
    if (operation.kind === "create") {
      const target = inspectEndpoint(root, operation.path, false);
      if (!("absolute" in target)) return target;
      planned.push({ kind: "create", path: operation.path, class: operation.cls, directories: target.directories, after: image(operation.after) });
      continue;
    }
    if (operation.kind === "move") {
      const source = inspectEndpoint(root, operation.from, true);
      if (!("absolute" in source)) return source;
      const destination = inspectEndpoint(root, operation.to, false);
      if (!("absolute" in destination)) return destination;
      const before = readFileImage(source.absolute, Math.floor((MAX_WORKSPACE_TOTAL_BYTES - totalBytes) / 2));
      if (!("base64" in before)) return before;
      if (before.sha256 !== operation.expected) return refuse("preimage-mismatch", `${operation.from} does not match expected_before_sha256`, operation.from);
      totalBytes += before.byte_length * 2;
      if (totalBytes > MAX_WORKSPACE_TOTAL_BYTES) return refuse("payload-too-large", "combined before and after images exceed the proposal limit");
      planned.push({
        kind: "move", from: operation.from, to: operation.to, classes: operation.classes,
        source_directories: source.directories, destination_directories: destination.directories,
        before, after: { base64: before.base64, sha256: before.sha256, byte_length: before.byte_length },
      });
      continue;
    }
    const source = inspectEndpoint(root, operation.path, true);
    if (!("absolute" in source)) return source;
    const before = readFileImage(source.absolute, MAX_WORKSPACE_TOTAL_BYTES - totalBytes);
    if (!("base64" in before)) return before;
    if (before.sha256 !== operation.expected) return refuse("preimage-mismatch", `${operation.path} does not match expected_before_sha256`, operation.path);
    totalBytes += before.byte_length;
    if (totalBytes > MAX_WORKSPACE_TOTAL_BYTES) return refuse("payload-too-large", "combined before and after images exceed the proposal limit");
    if (operation.kind === "replace") {
      planned.push({ kind: "replace", path: operation.path, class: operation.cls, directories: source.directories, before, after: image(operation.after) });
    } else {
      planned.push({ kind: "delete", path: operation.path, class: operation.cls, directories: source.directories, before });
    }
  }

  const payload: WorkspacePlanPayload = {
    version: WORKSPACE_PLAN_VERSION,
    actor: context.actor,
    root,
    root_identity: rootIdentity,
    policy_sha256: context.policy_sha256,
    operations: planned,
  };
  const hash = payloadHash(payload);
  const classes = [...new Set(classified.flatMap((operation) =>
    operation.kind === "move" ? operation.classes : [operation.cls]))].sort();
  return {
    ok: true,
    plan: deepFreeze({
      payload,
      payload_hash: hash,
      actions: classes.map((cls) => ({ class: cls, reversible: false as const, payload_hash: hash })),
    }),
  };
}

function inputFromPlan(plan: WorkspacePlan): WorkspaceOperationInput[] {
  return plan.payload.operations.map((operation) => {
    if (operation.kind === "create") return { kind: "create", path: operation.path, after_base64: operation.after.base64 };
    if (operation.kind === "replace") return {
      kind: "replace", path: operation.path,
      expected_before_sha256: operation.before.sha256, after_base64: operation.after.base64,
    };
    if (operation.kind === "delete") return { kind: "delete", path: operation.path, expected_before_sha256: operation.before.sha256 };
    return { kind: "move", from: operation.from, to: operation.to, expected_before_sha256: operation.before.sha256 };
  });
}

/** Re-read and reclassify a plan. Success means only that the snapshot still matches. */
export function revalidateWorkspacePlan(
  plan: WorkspacePlan,
  context: WorkspacePlanContext,
): WorkspacePlanResult {
  if (
    context.actor !== plan.payload.actor ||
    context.root !== plan.payload.root ||
    context.policy_sha256 !== plan.payload.policy_sha256
  ) {
    return refuse("context-drift", "actor, workspace root, or attested policy digest changed");
  }
  const current = planWorkspaceProposal(inputFromPlan(plan), context);
  if (!current.ok) {
    return refuse("workspace-drift", `workspace snapshot no longer validates: ${current.code}: ${current.message}`, current.path);
  }
  if (current.plan.payload_hash !== plan.payload_hash || canonicalize(current.plan) !== canonicalize(plan)) {
    return refuse("workspace-drift", "workspace identities, bytes, classes, or policy binding changed");
  }
  return current;
}
