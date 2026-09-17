/**
 * The durable half of the Codex workspace broker (APRV-325.2).
 *
 * `workspace-plan.ts` decides what a change IS; this module is the only place
 * that makes one happen. It exists because POSIX gives no atomic multi-file
 * rename: four `rename(2)` calls are four separate instants, and a crash
 * between the second and the third leaves a workspace that is neither the state
 * the human approved nor the state they started from.
 *
 * ## The three states, and the one this module refuses to invent
 *
 * A committed transaction is `after`. An untouched one is `before`. Anything
 * else is `mixed`, and mixed is reported as mixed. The classification is made
 * by READING the filesystem back against the journal's recorded digests, never
 * from what the applying code believes it did: a `rename` that returned zero
 * and a `rename` whose effect a crash lost look identical from inside the
 * process that called it, and only the bytes on disk can tell them apart. That
 * is why {@link inspectWorkspaceState} runs after a successful apply as well as
 * after a failed one, and why a mixed result reaches the log as
 * `execution.indeterminate` with reason `workspace-commit-unknown` rather than
 * as a failure (SPEC.md §8's closed reason set, extended by this task).
 *
 * ## Ordering, and why the journal is written before anything moves
 *
 * 1. Stage every new byte and every preimage into a directory on the SAME
 *    filesystem as the workspace, and `fsync` each file and then the directory.
 *    Nothing in the workspace has changed yet, so a crash here is `before`.
 * 2. Write the journal — the plan's payload hash, every endpoint, and the
 *    before/after digest of each — and `fsync` it and its directory. This is
 *    the instant after which a crash is RECOVERABLE rather than merely
 *    undecidable: a journal on disk names what the workspace was and what it
 *    was becoming, so a later reader can prove which of the two it is in.
 * 3. Apply, in a fixed order, then `fsync` every touched parent directory.
 * 4. Read the endpoints back. Only an all-`after` reading removes the journal
 *    as a success; an all-`before` reading removes it as an untaken
 *    transaction; a mixed reading LEAVES IT for a person.
 *
 * ## Custody is claimed only as far as the platform proves it
 *
 * {@link acquireWorkspaceCustody} takes an `O_CREAT | O_EXCL` lock, which
 * excludes other cooperating brokers and nothing else, and then asks POSIX
 * ownership and mode whether any other principal can write the endpoints it is
 * about to touch. It reports `os-exclusive` only when both hold, `advisory`
 * otherwise, and it always reports `acl-unproven`, because ownership and mode
 * do not speak about ACLs (the same honesty `codex/trust.ts` already keeps). A
 * caller that needs the strong answer asks for it and is refused when the host
 * cannot give it; nothing here silently downgrades.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { canonicalize } from "../core/jcs.js";
import type { PlannedWorkspaceOperation, WorkspacePlan } from "./workspace-plan.js";

export const WORKSPACE_COMMIT_VERSION = "approval.codex.workspace-commit.v1" as const;

/**
 * The one directory name inside a workspace root that a proposal may never
 * name (the broker refuses an endpoint under it before the planner ever reads
 * a preimage). Staging has to share a filesystem with the workspace for
 * `rename` to be atomic, so it lives inside it; reserving the name is what
 * stops a proposal from staging over its own transaction.
 */
export const WORKSPACE_TXN_DIR = ".approval-codex-txn";

/** The lockfile, beside the staging directory and under the same reservation. */
export const WORKSPACE_LOCK_FILE = ".approval-codex-lock";

const JOURNAL_FILE = "journal.json";

// ---------------------------------------------------------------------------
// Custody
// ---------------------------------------------------------------------------

/**
 * How much exclusion the host actually granted.
 *
 * `os-exclusive`: the lock is held AND POSIX says no principal other than this
 * process's effective user can write the workspace root or any parent
 * directory this transaction touches. `advisory`: the lock is held and that
 * second claim failed or could not be made. Nothing returns `os-exclusive`
 * from a claim; it is returned from an inspection.
 */
export type CustodyKind = "os-exclusive" | "advisory";

export interface CustodyReport {
  kind: CustodyKind;
  /** Machine-readable, always includes `acl-unproven`. Never a judgment. */
  findings: readonly string[];
}

export interface WorkspaceCustody {
  report: CustodyReport;
  root: string;
  txnDir: string;
  release: () => void;
}

export type CustodyResult =
  | { ok: true; custody: WorkspaceCustody }
  | { ok: false; code: "custody-contended" | "custody-unavailable"; message: string };

function fsyncDir(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY);
    fsyncSync(fd);
  } catch {
    // A filesystem that refuses to fsync a directory handle (some network and
    // virtual filesystems do) is reported by the readback, not guessed at here.
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function writeDurable(path: string, bytes: Uint8Array): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    let written = 0;
    while (written < bytes.byteLength) {
      written += writeSync(fd, bytes, written, bytes.byteLength - written);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Is `path` writable by a principal other than this process's effective user,
 * as far as POSIX ownership and mode can say?
 *
 * `null` means the question could not be asked (the path could not be stated),
 * which is not the same as "no" and is never read as one.
 */
function foreignWritable(path: string): boolean | null {
  try {
    const stats = statSync(path);
    if ((stats.mode & 0o022) !== 0) return true;
    return stats.uid !== process.getuid?.();
  } catch {
    return null;
  }
}

/**
 * Take the workspace lock and report how much exclusion it bought.
 *
 * The lock is `O_CREAT | O_EXCL` on a reserved name, which is the strongest
 * primitive available to a process with no privilege: it excludes every other
 * broker that respects it and no one else. Whether anything else CAN write is a
 * separate question, asked of POSIX afterwards, and answered conservatively.
 */
export function acquireWorkspaceCustody(
  root: string,
  touchedDirectories: readonly string[],
): CustodyResult {
  const lockPath = join(root, WORKSPACE_LOCK_FILE);
  const txnDir = join(root, WORKSPACE_TXN_DIR);
  let lockFd: number;
  try {
    lockFd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      return {
        ok: false,
        code: "custody-contended",
        message: `another workspace transaction holds ${lockPath}; no operation was attempted`,
      };
    }
    return {
      ok: false,
      code: "custody-unavailable",
      message: `workspace lock ${lockPath} could not be created: ${String(code ?? cause)}`,
    };
  }
  try {
    closeSync(lockFd);
  } catch {
    // The lock is the file's existence, not the descriptor.
  }

  const findings: string[] = ["acl-unproven"];
  let exclusive = true;
  for (const directory of [root, ...touchedDirectories]) {
    const foreign = foreignWritable(directory);
    if (foreign === null) {
      findings.push(`custody-unreadable:${directory}`);
      exclusive = false;
      continue;
    }
    if (foreign) {
      findings.push(`foreign-writable:${directory}`);
      exclusive = false;
    }
  }

  try {
    mkdirSync(txnDir, { mode: 0o700 });
  } catch (cause) {
    try {
      unlinkSync(lockPath);
    } catch {
      // Best effort: the failure below is the one that matters.
    }
    return {
      ok: false,
      code: "custody-unavailable",
      message: `staging directory ${txnDir} could not be created: ${String((cause as NodeJS.ErrnoException).code ?? cause)}`,
    };
  }
  fsyncDir(root);

  return {
    ok: true,
    custody: {
      report: { kind: exclusive ? "os-exclusive" : "advisory", findings },
      root,
      txnDir,
      release: () => {
        try {
          rmSync(txnDir, { recursive: true, force: true });
        } catch {
          // Leaving staging behind is visible to recovery and to a person.
        }
        try {
          unlinkSync(lockPath);
        } catch {
          // Same.
        }
        fsyncDir(root);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// The journal
// ---------------------------------------------------------------------------

/** One endpoint of one operation, with the two digests that classify it. */
export interface JournalEndpoint {
  /** Workspace-relative POSIX path. */
  path: string;
  /** SHA-256 of the bytes this path held before the transaction, or null when absent. */
  before_sha256: string | null;
  /** SHA-256 of the bytes it must hold after it, or null when absent. */
  after_sha256: string | null;
}

export interface JournalOperation {
  index: number;
  kind: PlannedWorkspaceOperation["kind"];
  endpoints: readonly JournalEndpoint[];
  /** Staged file holding the new bytes, relative to the staging directory. */
  staged: string | null;
  /** Staged file holding the preimage bytes, relative to the staging directory. */
  preimage: string | null;
}

export interface WorkspaceCommitJournal {
  version: typeof WORKSPACE_COMMIT_VERSION;
  root: string;
  payload_hash: string;
  custody: CustodyKind;
  operations: readonly JournalOperation[];
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The endpoints one planned operation owns, in the shape recovery reads.
 *
 * A move owns two, and the second one's `before` is deliberately `null`: the
 * planner refuses a move whose destination exists, so "absent" is the state the
 * transaction started from and the state a rollback must restore.
 */
export function journalEndpointsOf(operation: PlannedWorkspaceOperation): JournalEndpoint[] {
  switch (operation.kind) {
    case "create":
      return [{ path: operation.path, before_sha256: null, after_sha256: operation.after.sha256 }];
    case "replace":
      return [{
        path: operation.path,
        before_sha256: operation.before.sha256,
        after_sha256: operation.after.sha256,
      }];
    case "delete":
      return [{ path: operation.path, before_sha256: operation.before.sha256, after_sha256: null }];
    case "move":
      return [
        { path: operation.from, before_sha256: operation.before.sha256, after_sha256: null },
        { path: operation.to, before_sha256: null, after_sha256: operation.before.sha256 },
      ];
  }
}

function newBytesOf(operation: PlannedWorkspaceOperation): Buffer | null {
  if (operation.kind === "create" || operation.kind === "replace") {
    return Buffer.from(operation.after.base64, "base64");
  }
  return null;
}

function preimageBytesOf(operation: PlannedWorkspaceOperation): Buffer | null {
  if (operation.kind === "create") return null;
  return Buffer.from(operation.before.base64, "base64");
}

/** Every parent directory a transaction will write into, absolute and deduplicated. */
export function touchedDirectories(plan: WorkspacePlan): string[] {
  const seen = new Set<string>();
  for (const operation of plan.payload.operations) {
    for (const endpoint of journalEndpointsOf(operation)) {
      seen.add(dirname(resolve(plan.payload.root, endpoint.path)));
    }
  }
  return [...seen].sort();
}

// ---------------------------------------------------------------------------
// Reading the workspace back
// ---------------------------------------------------------------------------

/** What one endpoint currently is, relative to the two states the journal names. */
export type EndpointState = "before" | "after" | "other" | "unreadable";

/** The whole transaction's state, proven by reading. Never inferred. */
export type WorkspaceState = "before" | "after" | "mixed";

export interface WorkspaceInspection {
  state: WorkspaceState;
  /** Per-endpoint readings, in journal order. Present for every state. */
  endpoints: readonly { path: string; state: EndpointState }[];
}

const MAX_READBACK_BYTES = 1_048_576;

/**
 * The digest of a regular single-link file, `null` when it is absent, and
 * `undefined` when the question could not be answered.
 *
 * `O_NOFOLLOW` and the `nlink` test are the planner's rules, repeated here
 * because a readback that followed a symlink planted between the apply and the
 * inspection would report someone else's bytes as this transaction's outcome.
 */
function readbackDigest(path: string): string | null | undefined {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    return undefined;
  }
  try {
    const stats = fstatSync(fd, { bigint: true });
    if (!stats.isFile() || stats.nlink !== 1n) return undefined;
    if (stats.size > BigInt(MAX_READBACK_BYTES)) return undefined;
    const buffer = Buffer.alloc(Number(stats.size));
    let length = 0;
    while (length < buffer.byteLength) {
      const count = readSync(fd, buffer, length, buffer.byteLength - length, length);
      if (count === 0) break;
      length += count;
    }
    if (length !== buffer.byteLength) return undefined;
    return sha256(buffer);
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

function endpointState(root: string, endpoint: JournalEndpoint): EndpointState {
  const digest = readbackDigest(resolve(root, endpoint.path));
  if (digest === undefined) return "unreadable";
  const isAfter = digest === endpoint.after_sha256;
  const isBefore = digest === endpoint.before_sha256;
  // `before` wins a tie, and a tie is real: a replace whose new bytes equal its
  // old bytes is both, and calling it `before` can only under-claim.
  if (isBefore) return "before";
  if (isAfter) return "after";
  return "other";
}

/**
 * Classify the workspace against a journal by reading it.
 *
 * `mixed` is the honest answer for anything that is not uniformly one state,
 * INCLUDING a single unreadable endpoint: "I could not look" and "it is half
 * done" are both "nobody knows", and collapsing the first into `before` would
 * be the runtime deciding an effect did not happen.
 */
export function inspectWorkspaceState(journal: WorkspaceCommitJournal): WorkspaceInspection {
  const endpoints: { path: string; state: EndpointState }[] = [];
  for (const operation of journal.operations) {
    for (const endpoint of operation.endpoints) {
      endpoints.push({ path: endpoint.path, state: endpointState(journal.root, endpoint) });
    }
  }
  const every = (state: EndpointState): boolean => endpoints.every((entry) => entry.state === state);
  if (endpoints.length > 0 && every("after")) return { state: "after", endpoints };
  if (endpoints.length === 0 || every("before")) return { state: "before", endpoints };
  return { state: "mixed", endpoints };
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

export interface CommitOptions {
  /**
   * Called once, after the journal is durable and before the first visible
   * mutation, and once after each applied operation with that operation's
   * index. A TEST SEAM and nothing else: it takes a number and returns
   * nothing, so it can supply no value and relax no check. Throwing from it
   * simulates the crash a timing test cannot produce, and every path below
   * treats the throw exactly as it treats a filesystem error.
   */
  onStep?: (step: number) => void;
}

export interface CommitOutcome {
  /** What reading the workspace back established. Never what the code believed. */
  state: WorkspaceState;
  inspection: WorkspaceInspection;
  journal: WorkspaceCommitJournal;
  /** The error that stopped the apply, when one did. */
  failure?: string;
  /** True when the journal was deliberately left on disk for a person. */
  journalRetained: boolean;
}

export type CommitResult =
  | { ok: true; outcome: CommitOutcome }
  | { ok: false; code: "stage-failed"; message: string };

function journalPath(txnDir: string): string {
  return join(txnDir, JOURNAL_FILE);
}

/**
 * Stage, journal, apply, read back.
 *
 * The caller holds custody (and therefore the staging directory) and keeps it
 * until this returns. A `stage-failed` result is the one result that guarantees
 * the workspace is untouched by construction rather than by inspection: nothing
 * visible has been attempted when it fires.
 */
export function commitWorkspacePlan(
  plan: WorkspacePlan,
  custody: WorkspaceCustody,
  options: CommitOptions = {},
): CommitResult {
  const { root, txnDir } = custody;
  const operations: JournalOperation[] = [];

  // --- Phase 1: stage. Nothing in the workspace changes. ------------------
  try {
    for (let index = 0; index < plan.payload.operations.length; index += 1) {
      const operation = plan.payload.operations[index] as PlannedWorkspaceOperation;
      const newBytes = newBytesOf(operation);
      const preimage = preimageBytesOf(operation);
      const staged = newBytes === null ? null : `new-${String(index)}`;
      const saved = preimage === null ? null : `old-${String(index)}`;
      if (staged !== null && newBytes !== null) writeDurable(join(txnDir, staged), newBytes);
      if (saved !== null && preimage !== null) writeDurable(join(txnDir, saved), preimage);
      operations.push({
        index,
        kind: operation.kind,
        endpoints: journalEndpointsOf(operation),
        staged,
        preimage: saved,
      });
    }
    fsyncDir(txnDir);
  } catch (cause) {
    return {
      ok: false,
      code: "stage-failed",
      message: `workspace staging failed before any mutation: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }

  const journal: WorkspaceCommitJournal = {
    version: WORKSPACE_COMMIT_VERSION,
    root,
    payload_hash: plan.payload_hash,
    custody: custody.report.kind,
    operations,
  };

  // --- Phase 2: the journal, durable, before anything moves. --------------
  try {
    writeDurable(journalPath(txnDir), Buffer.from(canonicalize(journal), "utf8"));
    fsyncDir(txnDir);
  } catch (cause) {
    return {
      ok: false,
      code: "stage-failed",
      message: `workspace journal could not be made durable before any mutation: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }

  // --- Phase 3: apply. From here the answer comes from reading. -----------
  let failure: string | undefined;
  try {
    options.onStep?.(0);
    for (const entry of operations) {
      const operation = plan.payload.operations[entry.index] as PlannedWorkspaceOperation;
      applyOne(root, txnDir, operation, entry);
      options.onStep?.(entry.index + 1);
    }
  } catch (cause) {
    failure = cause instanceof Error ? cause.message : String(cause);
  }

  for (const directory of touchedDirectories(plan)) fsyncDir(directory);

  // --- Phase 4: a failed apply tries to undo itself, and is then read. ----
  if (failure !== undefined) {
    try {
      rollback(root, txnDir, operations);
    } catch (cause) {
      failure = `${failure}; rollback also failed: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
    for (const directory of touchedDirectories(plan)) fsyncDir(directory);
  }

  const inspection = inspectWorkspaceState(journal);
  const retained = inspection.state === "mixed";
  if (!retained) {
    try {
      unlinkSync(journalPath(txnDir));
      fsyncDir(txnDir);
    } catch {
      // Recovery reads a journal beside a settled workspace as settled.
    }
  }

  return {
    ok: true,
    outcome: {
      state: inspection.state,
      inspection,
      journal,
      journalRetained: retained,
      ...(failure === undefined ? {} : { failure }),
    },
  };
}

function applyOne(
  root: string,
  txnDir: string,
  operation: PlannedWorkspaceOperation,
  entry: JournalOperation,
): void {
  switch (operation.kind) {
    case "create":
    case "replace":
      renameSync(join(txnDir, entry.staged as string), resolve(root, operation.path));
      return;
    case "delete":
      unlinkSync(resolve(root, operation.path));
      return;
    case "move":
      renameSync(resolve(root, operation.from), resolve(root, operation.to));
      return;
  }
}

/**
 * Put every endpoint back the way the journal says it was, from the staged
 * preimages.
 *
 * Best effort by construction: it is attempted, and then the workspace is READ.
 * A rollback that half worked produces `mixed` from the inspection, which is
 * the same answer a rollback that was never attempted would produce, and that
 * is deliberate — the classification must not depend on what this function
 * thinks it achieved.
 */
function rollback(
  root: string,
  txnDir: string,
  operations: readonly JournalOperation[],
): void {
  const problems: string[] = [];
  for (let index = operations.length - 1; index >= 0; index -= 1) {
    const entry = operations[index] as JournalOperation;
    try {
      for (let slot = 0; slot < entry.endpoints.length; slot += 1) {
        const endpoint = entry.endpoints[slot] as JournalEndpoint;
        const target = resolve(root, endpoint.path);
        if (endpoint.before_sha256 === null) {
          try {
            unlinkSync(target);
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
          }
          continue;
        }
        if (readbackDigest(target) === endpoint.before_sha256) continue;
        if (entry.preimage === null) continue;
        const restored = join(txnDir, `restore-${String(index)}-${String(slot)}`);
        writeDurable(restored, readFileSync(join(txnDir, entry.preimage)));
        renameSync(restored, target);
      }
    } catch (cause) {
      problems.push(cause instanceof Error ? cause.message : String(cause));
    }
  }
  if (problems.length > 0) throw new Error(problems.join("; "));
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

export type RecoverResult =
  | { ok: true; state: "none"; message: string }
  | { ok: true; state: WorkspaceState; inspection: WorkspaceInspection; journal: WorkspaceCommitJournal }
  | { ok: false; code: "journal-unreadable"; message: string };

/**
 * Read a workspace's retained journal and say which of the three states it is
 * in. It CHANGES NOTHING in the workspace.
 *
 * That is the whole contract, and the restraint is the point: a recovery that
 * rolled a mixed workspace forward would be guessing which half of it the
 * human approved, and a recovery that rolled one back would be deleting the
 * half that already committed. Both are the runtime inventing a fact. A proven
 * `before` or `after` needs no repair by definition, so there is nothing left
 * for this function to do but say so and let the operator clear the staging
 * directory.
 */
export function recoverWorkspaceCommit(root: string): RecoverResult {
  const path = journalPath(join(root, WORKSPACE_TXN_DIR));
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, state: "none", message: `no workspace transaction journal at ${path}` };
    }
    return {
      ok: false,
      code: "journal-unreadable",
      message: `workspace transaction journal ${path} could not be read: ${String((cause as NodeJS.ErrnoException).code ?? cause)}`,
    };
  }
  let journal: WorkspaceCommitJournal;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" || parsed === null ||
      (parsed as WorkspaceCommitJournal).version !== WORKSPACE_COMMIT_VERSION ||
      !Array.isArray((parsed as WorkspaceCommitJournal).operations)
    ) {
      return { ok: false, code: "journal-unreadable", message: `${path} is not a v1 workspace transaction journal` };
    }
    journal = parsed as WorkspaceCommitJournal;
  } catch (cause) {
    return {
      ok: false,
      code: "journal-unreadable",
      message: `${path} is not parseable JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  const inspection = inspectWorkspaceState(journal);
  return { ok: true, state: inspection.state, inspection, journal };
}
