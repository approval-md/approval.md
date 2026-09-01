/**
 * Protected-path changes, cross-checked against the grants that authorized them
 * (APRV-151).
 *
 * ## Why this exists
 *
 * Every other enforcement path in this repository is *session-local*: the
 * harness invokes `approval hook claude-code`, the hook classifies, and a
 * `policy.edit` waits for a human. That design has one hole it cannot see out
 * of. A hook that is never invoked leaves NO trace — not a deny, not a refused
 * request, not a record of any kind — so a session whose harness never ran the
 * hook edits `SPEC.md` or `.github/workflows/ci.yml` in silence, and the
 * runtime has nothing to notice. Two such bypasses were observed (2026-08-29
 * and 2026-08-30, both in agent-created worktrees under
 * `.claude/worktrees/`), and in both the log's own account of the evening was
 * simply that the session did not exist.
 *
 * The fix cannot be another session-local check, because the party that would
 * run it is the party whose wiring is in question. It has to be a check made
 * from OUTSIDE the session, over records the session did not write, about a
 * diff the session cannot retract: the change reaching a pull request, and the
 * committed log's grants. That is what this module computes.
 *
 * ## What authorizes a protected change
 *
 * Exactly one thing: an `approval.granted` record, for a `policy.edit` action,
 * whose action was DECLARED as a file-tool touch of that path. The declaration
 * is the summary the hook minted (`Edit /abs/path`, and the two APRV-124 tier
 * prefixes in front of it), read back from the log rather than from the
 * caller.
 *
 * Three narrowings, all in the strict direction:
 *
 * 1. **Grants only.** A request is a question, not an answer. A denied,
 *    withdrawn, expired, or still-pending request authorizes nothing.
 * 2. **File-tool grants only.** A `policy.edit` that came from a shell command
 *    (`git add SPEC.md && git commit …` classifies `policy.edit` too) is a
 *    grant to run that command, and the bytes a human saw were the command
 *    line, not the diff. It does not stand in for the edit.
 * 3. **A summary this module cannot parse contributes nothing.** It never
 *    widens the authorized set, so an unreadable record fails toward
 *    "unauthorized".
 *
 * ## Path matching
 *
 * The granted summary carries an ABSOLUTE path, and the path may name a copy
 * inside an agent worktree (`…/.claude/worktrees/<name>/SPEC.md`) rather than
 * the primary checkout's file — that is the normal shape, since the branch a
 * pull request carries was written in a worktree. The changed path from git is
 * repository-relative (`SPEC.md`). So a grant matches a change when the
 * grant's path ENDS WITH the changed path's segments, the same suffix rule
 * `isProtectedPath` uses for `policy.protected_paths` entries.
 *
 * That is deliberately generous about WHICH checkout the grant named and
 * strict about which file: a human who approved an edit to `SPEC.md` in a
 * worktree approved that content landing on a branch, and the merge to main is
 * separately gated. A human who approved an edit to `docs/SPEC.md` did not
 * approve one to `SPEC.md`.
 *
 * ## Purity
 *
 * No disk, no git, no clock. The caller supplies the changed paths and the
 * VERIFIED records; this decides. `scripts/protected-grant-guard.mjs` is the
 * impure half.
 */

import { isProtectedPath } from "./command-class.js";
import type { EventRecord } from "./log.js";

/** The class a protected-path edit resolves to, everywhere in the runtime. */
const POLICY_EDIT = "policy.edit";

/**
 * The file-tool summaries `src/cli/hook.ts` mints, as one reader.
 *
 * `summaryFor` produces three shapes, all ending in `<Tool> <absolute path>`:
 *
 * - `Edit /abs/path`
 * - `branch proposal (worktree <name>): Edit /abs/path`
 * - `file named like a policy file, outside this gated checkout: Edit /abs/path`
 *
 * The tier prefix is stripped and ignored: it says which checkout the file sat
 * in, and this module's question is which file, not which copy.
 */
const FILE_SUMMARY =
  /^(?:branch proposal \(worktree [^)]*\): |file named like a policy file, outside this gated checkout: )?(?:Edit|Write|MultiEdit|NotebookEdit) (\S.*)$/u;

/** The path a file-tool summary declares, or `null` when it is not one. */
export function summaryPath(summary: string): string | null {
  const match = FILE_SUMMARY.exec(summary.trim());
  if (match === null) return null;
  const path = match[1];
  return path === undefined || path.length === 0 ? null : path;
}

/** Split a path into segments, dropping `./` noise. Never touches the disk. */
function segmentsOf(path: string): string[] {
  return path.split(/[/\\]+/u).filter((segment) => segment.length > 0 && segment !== ".");
}

/**
 * The checkout roots this log knows about, derived from the log itself.
 *
 * A granted summary names an ABSOLUTE path, and a changed path from git is
 * repository-relative, so the two can only be compared once the checkout
 * prefix is known. It must not be guessed by suffix ("ends with SPEC.md"),
 * because that would let a grant for `docs/SPEC.md` authorize a change to the
 * root `SPEC.md`: a suffix rule is generous in the fail-OPEN direction, which
 * is the one direction this guard may not be generous in.
 *
 * It also must not be taken from the machine the guard runs on: CI checks the
 * repository out at a path that has nothing to do with where the grants were
 * minted.
 *
 * So it is read out of the records. Every agent-worktree summary has the shape
 * `<root>/.claude/worktrees/<name>/<relative>`, which names its own root
 * exactly, and a repository that gates anything at all produces those
 * constantly. Extra roots may be supplied by the caller (the checkout the
 * guard is running in, for a local run); nothing else anchors.
 */
export function checkoutRoots(
  paths: Iterable<string>,
  extra: readonly string[] = [],
): string[] {
  const roots = new Set<string>(extra.filter((root) => root.length > 0));
  for (const path of paths) {
    const segments = segmentsOf(path);
    for (let index = 0; index + 2 < segments.length; index += 1) {
      if (segments[index] !== ".claude" || segments[index + 1] !== "worktrees") continue;
      roots.add(segments.slice(0, index).join("/"));
    }
  }
  return [...roots];
}

/**
 * `granted`, as a path relative to whichever checkout it sits in, or `null`.
 *
 * Two anchors, both exact: the agent-worktree shape
 * `<root>/.claude/worktrees/<name>/<relative>`, which needs no root list at
 * all, and a plain `<root>/<relative>` for a root the caller knows. A path
 * neither anchor recognizes returns `null` and therefore authorizes nothing.
 */
export function checkoutRelative(granted: string, roots: readonly string[]): string | null {
  const segments = segmentsOf(granted);
  if (segments.includes("..")) return null;
  for (let index = 0; index + 3 <= segments.length; index += 1) {
    if (segments[index] !== ".claude" || segments[index + 1] !== "worktrees") continue;
    const rest = segments.slice(index + 3);
    return rest.length === 0 ? null : rest.join("/");
  }
  for (const root of roots) {
    const prefix = segmentsOf(root);
    if (prefix.length >= segments.length) continue;
    if (!prefix.every((segment, at) => segment === segments[at])) continue;
    return segments.slice(prefix.length).join("/");
  }
  return null;
}

/** One `policy.edit` file-tool grant, as this module reads it back. */
export interface GrantedEdit {
  /** The absolute path the granted action declared. */
  path: string;
  /** The `approval.granted` record's seq. */
  seq: number;
  /** The action key the grant answered. */
  actionKey: string;
  /** Who granted it. */
  actor: string;
}

/** The verdict on one changed protected path. */
export interface ProtectedFinding {
  /** The repository-relative path git reported as changed. */
  path: string;
  /** The grant that authorizes it, or `null` when nothing in the log does. */
  grant: GrantedEdit | null;
}

export interface ProtectedAudit {
  /** Every changed path that is a protected path, with its verdict. */
  findings: ProtectedFinding[];
  /** The subset with no grant: the bypass this guard exists to catch. */
  unauthorized: ProtectedFinding[];
  /** Every file-tool `policy.edit` grant the records carried, for reporting. */
  grants: GrantedEdit[];
}

/** Read one record's `payload.class`, or `null`. */
function classOf(payload: Record<string, unknown> | undefined): string | null {
  const value = payload?.["class"];
  return typeof value === "string" ? value : null;
}

/** Read one record's `payload.summary`, or `null`. */
function summaryOf(payload: Record<string, unknown> | undefined): string | null {
  const value = payload?.["summary"];
  return typeof value === "string" ? value : null;
}

/**
 * The path each `policy.edit` action key was DECLARED to touch.
 *
 * Built from `task.registered` (whose `payload.actions[]` carry
 * `idempotency_key` and `summary`) and from `approval.requested` (whose
 * `action_key` and `payload.summary` say the same thing for a request that
 * skipped a registration this window can see). A key declared twice with two
 * different paths is dropped rather than resolved: an ambiguous declaration
 * cannot authorize anything.
 */
function declaredPaths(records: readonly EventRecord[]): Map<string, string | null> {
  const declared = new Map<string, string | null>();
  const note = (key: string, path: string | null): void => {
    if (path === null) return;
    if (declared.has(key) && declared.get(key) !== path) {
      declared.set(key, null);
      return;
    }
    declared.set(key, path);
  };

  for (const record of records) {
    const payload = record.payload;
    if (record.event === "task.registered") {
      const actions = payload?.["actions"];
      if (!Array.isArray(actions)) continue;
      for (const entry of actions) {
        if (typeof entry !== "object" || entry === null) continue;
        const action = entry as Record<string, unknown>;
        if (action["class"] !== POLICY_EDIT) continue;
        const key = action["idempotency_key"];
        const summary = action["summary"];
        if (typeof key !== "string" || typeof summary !== "string") continue;
        note(key, summaryPath(summary));
      }
      continue;
    }
    if (record.event !== "approval.requested") continue;
    if (classOf(payload) !== POLICY_EDIT) continue;
    const key = record.action_key;
    const summary = summaryOf(payload);
    if (typeof key !== "string" || summary === null) continue;
    note(key, summaryPath(summary));
  }
  return declared;
}

/**
 * Every file-tool `policy.edit` grant these records carry.
 *
 * A grant whose action key has no readable file-tool declaration is skipped:
 * it may well be a shell `policy.edit`, and a grant this function cannot tie to
 * a specific file is a grant that must not excuse one.
 */
export function grantedProtectedEdits(
  records: readonly EventRecord[],
  sinceSeq = 0,
): GrantedEdit[] {
  const declared = declaredPaths(records);
  const grants: GrantedEdit[] = [];
  for (const record of records) {
    if (record.event !== "approval.granted") continue;
    if (record.seq <= sinceSeq) continue;
    const payload = record.payload;
    if (classOf(payload) !== POLICY_EDIT) continue;
    const key = record.action_key;
    if (typeof key !== "string") continue;
    const path = declared.get(key);
    if (path === undefined || path === null) continue;
    grants.push({ path, seq: record.seq, actionKey: key, actor: record.actor });
  }
  return grants;
}

/**
 * Which of `changed` are protected paths, and which of those nothing granted.
 *
 * `changed` is repository-relative, as `git diff --name-only` reports it.
 * `records` must be VERIFIED records: enforcement reads only what the chain
 * vouches for (SPEC.md §11 global invariants), and this function has no way to
 * check that itself, so the caller carries the obligation.
 *
 * `protectedPaths` is `policy.protected_paths`, widening the built-in set
 * exactly as it does for the hook. Passing none narrows the guard to the
 * built-ins, which is the fail-closed reading of "the policy could not be
 * read": the built-ins are protected whatever a policy says.
 *
 * `sinceSeq` is the WINDOW, and it is what stops the guard from becoming a
 * rubber stamp. Without it, one grant for `SPEC.md` in the log's whole history
 * would authorize every future edit to `SPEC.md` forever. The caller passes
 * the log head the branch was cut at (the branch's own committed copy of the
 * log, which is frozen at that moment), so only grants a human gave AFTER the
 * branch existed can authorize what the branch changed.
 */
export function auditProtectedChanges(
  changed: readonly string[],
  records: readonly EventRecord[],
  protectedPaths: readonly string[] = [],
  extraRoots: readonly string[] = [],
  sinceSeq = 0,
): ProtectedAudit {
  const grants = grantedProtectedEdits(records, sinceSeq);
  const roots = checkoutRoots(
    grants.map((entry) => entry.path),
    extraRoots,
  );
  const relative = new Map(grants.map((entry) => [entry, checkoutRelative(entry.path, roots)]));
  const findings: ProtectedFinding[] = [];
  for (const path of changed) {
    if (path.length === 0) continue;
    if (!isProtectedPath(path, protectedPaths)) continue;
    const want = segmentsOf(path).join("/");
    const grant = grants.find((candidate) => relative.get(candidate) === want) ?? null;
    findings.push({ path, grant });
  }
  return {
    findings,
    unauthorized: findings.filter((finding) => finding.grant === null),
    grants,
  };
}
