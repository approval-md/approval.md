/**
 * The protected-path guard (APRV-151): CI asks the log, not the session.
 *
 * ## The hole this closes
 *
 * `approval hook claude-code` classifies a file-tool call before it applies,
 * and when the target is a protected path the answer is `policy.edit` and the
 * phone buzzes. That control is only as good as the wiring: a session whose
 * PreToolUse hook never loaded edits SPEC.md with no prompt, no denial, and —
 * this is the part that hurts — no refused-request record either. Nothing in
 * the log says the edit happened, because the thing that would have written
 * the record is the thing that did not run. Two incidents (2026-08-29 SPEC.md
 * in worktree `aprv-145-land`, 2026-08-30 `.github/workflows/ci.yml` in
 * `agent-a3f5d255372d43ac0`) are the same shape.
 *
 * A detector that asked the session whether it was hooked would be asking the
 * party under oversight to report its own oversight, which SPEC.md §11 rules
 * out on principle. So this one never talks to a session. It takes two commits,
 * asks git which protected paths changed between them, and requires — for each
 * one — evidence in the committed hash-chained log that a human saw that edit.
 * A change with no evidence fails the pull request. Session wiring is not an
 * input.
 *
 * ## What counts as evidence
 *
 * Three verdicts pass, and they are ordered by how much they prove:
 *
 * 1. `attested` — the policy file itself. `approval policy amend --commit`
 *    appends `policy.updated` carrying `{policy_path, sha256}`, the SHA-256 of
 *    the policy bytes a human attested. So for `APPROVAL.md` the guard does not
 *    look for a grant at all: it hashes the file's bytes AT THE HEAD COMMIT and
 *    requires that exact digest in the log. This is the strongest match in the
 *    system — content-level, not path-level — and it is why amendment PRs pass
 *    without a `policy.edit` grant, which they would never have.
 * 2. `granted-file` — a file-tool edit. The hook binds the CHANGE rather than
 *    the touch (APRV-124), and the bound material carries `file` as an absolute
 *    path. An `approval.granted` of class `policy.edit`/`policy.core` whose
 *    `payload_hash` resolves in the committed payload store to material whose
 *    `file` ends with the changed path is path-level evidence.
 * 3. `granted-command` — a shell edit. The bound material is `{command, cwd}`
 *    or `{argv, cwd}`, and the guard re-runs the runtime's own
 *    {@link classifyCommand} over it, requiring a segment that classifies as a
 *    granting class BECAUSE of a word naming this path. A mention is not a
 *    grant: `cat SPEC.md` is `read.shell` and proves nothing, and the first
 *    draft of this module, which substring-matched, accepted `hook classify --
 *    vi SPEC.md` as evidence for a later SPEC.md edit. Weaker than
 *    `granted-file` by exactly one thing: a path suffix cannot distinguish two
 *    files with the same repository-relative path in two checkouts. That is the
 *    same name-based protection `isProtectedPath` gives the hook, deliberately:
 *    a false positive costs one approval, a false negative costs the property.
 *
 * There is deliberately no class-level pass. A `policy.edit` grant that exists
 * in the window but names some other file is not evidence that anybody saw
 * THIS edit, and accepting it would let one approved edit launder every other
 * edit in the same window. Class-level grants appear in the failure detail as
 * diagnosis, never as a verdict.
 *
 * ## Grants go stale
 *
 * Naming the path is necessary and not sufficient, because grants accumulate
 * forever. Run without a recency rule against the real log, this guard passed a
 * SPEC.md edit made on 2026-08-29 on the strength of a `git add SPEC.md`
 * granted on 2026-08-20: once any edit to a path has ever been approved, every
 * later edit to that path would inherit the approval. So evidence must also sit
 * within {@link DEFAULT_LOOKBACK_MS} of the commit that introduced the change,
 * on either side of it. Either side, because both orderings are real: a grant
 * shortly BEFORE the commit is the ordinary case, and a grant shortly after is
 * the grant-follows-write anomaly (APRV-117/150 adjacent) — a defect in its own
 * right, but a complete consent trail all the same, and not this guard's to
 * adjudicate.
 *
 * This bound is the guard's weakest joint and it is stated rather than hidden:
 * a repeat edit to the same path inside the window still inherits the earlier
 * grant. Closing that needs hunk-level coverage (every added region of the diff
 * traced to the `after`/`content` bytes of some grant), which is a bigger
 * design than this task, and the failure message says which window was applied.
 * Attestation is exempt from the bound, because it matches CONTENT: bytes that
 * hash to an attested digest are the attested bytes whenever they were signed.
 * And when git cannot date the change at all, no bound is applied rather than a
 * weaker one invented: see `changeTsFor` on {@link GuardInput} for why a bound
 * against the head commit would have been theatre. The finding says which of
 * the two it got, every time.
 *
 * ## The evidence surface is not a protected write surface
 *
 * `.approval/` is protected wherever it sits, and the daemon appends to it
 * every time anything is approved — so a records / log-advance pull request
 * changes `.approval/log/events.jsonl`, the payload store beside it, and the
 * regenerated `QUEUE.md`. Requiring a grant for those would require a grant for
 * the evidence, which is circular and would make it impossible to land the very
 * commits this guard reads. {@link EXEMPT_PREFIXES} names that surface, and
 * nothing else under `.approval/` is exempt: the vault, the environment map and
 * anything else that lands there is still a protected write.
 *
 * ## The lag, and the ordering rule it implies
 *
 * The log on `main` trails the primary checkout's live log; advances land
 * periodically as records pull requests. A grant made this morning may not be
 * on `main` yet, and this guard can only see what the head commit's tree
 * carries. That is not a bug to paper over — it is an ordering rule, and every
 * failure states it: **the log advance carrying the grant must merge before or
 * with the protected-path pull request.** Each failure also names the window it
 * searched (the seq and timestamp range of the log at head) so the reader can
 * tell "the grant is not there" from "the grant is newer than this log".
 *
 * ## Fail closed
 *
 * A missing log, a log that does not pass chain verification, and a protected
 * path with no evidence are all failures, each with its own code. Records that
 * have not passed verification are never read for evidence (SPEC.md §11.1
 * invariant 1): the caller hands this module the verified records or none.
 * This module appends nothing, reads no clock, and performs no IO of its own —
 * git plumbing and file reads live in the caller.
 */

import { classifyCommand, isProtectedPath } from "./command-class.js";
import type { EventRecord } from "./log.js";

/**
 * Classes whose grant authorizes a protected-path write.
 *
 * `policy.edit` is what the hook and this repository's policy use.
 * `policy.core` is accepted alongside it because SPEC.md §7's taxonomy admits
 * a stricter sibling and a policy that routed the highest-value edits there
 * should not lose its evidence.
 */
export const GRANTING_CLASSES: readonly string[] = ["policy.edit", "policy.core"];

/**
 * The daemon's own append surface: evidence, not a protected write.
 *
 * Repository-relative, `/`-separated prefixes. A changed path equal to one of
 * these, or under one of the directory ones, is skipped before any evidence is
 * sought. See the module note for why this carve-out is narrow on purpose.
 */
export const EXEMPT_PREFIXES: readonly string[] = [
  ".approval/log/",
  ".approval/payloads/",
  ".approval/QUEUE.md",
];

/** Every way this guard can refuse, as stable codes. */
export const GUARD_FAILURE_CODES = [
  /** The log blob does not exist at the head commit at all. */
  "log-missing",
  /** The log exists and does not pass chain verification. */
  "log-unverified",
  /** A protected path changed and nothing in the log is evidence for it. */
  "no-evidence",
] as const;

export type GuardFailureCode = (typeof GUARD_FAILURE_CODES)[number];

/** How strongly the evidence ties a human decision to this exact path. */
export type EvidenceKind = "attested" | "granted-file" | "granted-command";

/**
 * How far from the commit that introduced a change a grant may sit and still be
 * evidence for it: seven days, either side. See the module note.
 */
export const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export interface GuardFinding {
  /** The changed path, repository-relative. */
  path: string;
  ok: boolean;
  /** Present on a pass. */
  evidence?: EvidenceKind;
  /** The log record that is the evidence, on a pass. */
  seq?: number;
  ts?: string;
  actor?: string;
  /** Present on a failure. */
  code?: GuardFailureCode;
  /** Prose a reader can act on, on either outcome. */
  detail: string;
}

/** The window of log the guard could see, for the failure messages. */
export interface LogWindow {
  /** Lowest and highest `seq` in the log at head, or `null` for an empty log. */
  firstSeq: number | null;
  lastSeq: number | null;
  firstTs: string | null;
  lastTs: string | null;
  /** The commit range the caller diffed. */
  base: string;
  head: string;
}

export interface GuardInput {
  /** Repository-relative paths that differ between base and head, deletions included. */
  changedPaths: readonly string[];
  /**
   * Records from the log at HEAD that have passed chain verification.
   * `null` means the log could not be verified or could not be read; pair it
   * with `logStatus` so the guard can say which.
   */
  records: readonly EventRecord[] | null;
  logStatus: "ok" | "missing" | "unverified";
  /** Why the log did not verify, when `logStatus` is not `ok`. */
  logDetail?: string;
  /** `policy.protected_paths` from the policy, widening the built-in set. */
  policyProtectedPaths: readonly string[];
  /**
   * SHA-256 of the policy file's bytes at the head commit, or `null` when the
   * head tree carries no policy file. Only used for the `attested` verdict.
   */
  policySha256AtHead: string | null;
  /** The policy file's repository-relative path, e.g. `APPROVAL.md`. */
  policyPath: string;
  /**
   * Resolve bound material from the committed payload store, by hash.
   * Returns `null` when the head tree does not carry that payload.
   */
  payloadFor: (hash: string) => unknown | null;
  /**
   * The author timestamp of the newest commit in `base..head` that touched this
   * path, as an ISO-8601 instant, or `null` when git could not say.
   *
   * With no anchor — `null`, or a value that does not parse — NO recency bound
   * is applied to this path, and the finding says so in its own text rather
   * than reporting a bound it did not enforce.
   *
   * That is stated plainly because it is the accepting direction and it would
   * be easy to dress up. The alternative considered was to bound the grant
   * against the head commit instead, and it was rejected as theatre: every
   * record in the log AT head is already before head by construction, so the
   * rule would pass everything it was asked about while reading like a check.
   * A guard that reports a bound it cannot enforce is worse than one that
   * admits it has none, because only the first kind gets trusted.
   *
   * In practice the anchor is missing only when git cannot date a path it just
   * reported in the diff, which is a broken-git condition rather than an
   * attacker-reachable one; refusing on it would fire only on that breakage.
   * The path-level evidence requirement is unaffected and still holds.
   */
  changeTsFor: (path: string) => string | null;
  /** Override {@link DEFAULT_LOOKBACK_MS}. */
  lookbackMs?: number;
  window: LogWindow;
}

export interface GuardReport {
  ok: boolean;
  /** Every protected path that changed, in the order git reported them. */
  findings: readonly GuardFinding[];
  /** Changed paths skipped as the daemon's own append surface. */
  exempt: readonly string[];
  window: LogWindow;
}

/** Split on either separator, dropping empties and `.` noise. */
function segmentsOf(candidate: string): string[] {
  return candidate.split(/[/\\]+/u).filter((part) => part.length > 0 && part !== ".");
}

/** Does `candidate` end with `want`, segment-wise? `a/b/c.md` ends with `b/c.md`. */
function endsWithSegments(candidate: string, want: string): boolean {
  const have = segmentsOf(candidate);
  const tail = segmentsOf(want);
  if (tail.length === 0 || tail.length > have.length) return false;
  const offset = have.length - tail.length;
  return tail.every((segment, index) => segment === have[offset + index]);
}

/**
 * Does this command line WRITE `path`, as the runtime's own classifier reads it?
 *
 * Substring matching was the first thing tried here and it is wrong: run
 * against the real log it passed `node cli.js hook classify -- vi SPEC.md` and
 * a heredoc whose body happened to contain the words `SPEC.md` as evidence for
 * a later SPEC.md edit. A grant that merely MENTIONS a path authorizes nothing,
 * and a guard that accepted mentions would let any approved command launder
 * every edit to every path it happened to print.
 *
 * So the question is put to `classifyCommand`, the same deterministic
 * classifier the hook gates with: the granted command is evidence for `path`
 * only when one of its segments classifies as a granting class BECAUSE of a
 * word that names this path (`ClassifiedSegment.path`, APRV-143). `cat SPEC.md`
 * is `read.shell` and proves nothing; `cp draft.md /repo/SPEC.md` is
 * `policy.edit` on `/repo/SPEC.md` and proves exactly the thing asked.
 *
 * A command the classifier refuses (opaque, unclassifiable) yields no evidence,
 * which is the fail-closed direction: an unreadable command is not a licence.
 */
function commandWritesPath(
  command: string,
  path: string,
  policyProtectedPaths: readonly string[],
): string | null {
  const classified = classifyCommand(command, policyProtectedPaths);
  if (!classified.ok) return null;
  for (const segment of classified.segments) {
    if (!GRANTING_CLASSES.includes(segment.class)) continue;
    const named = segment.path;
    if (typeof named === "string" && endsWithSegments(named, path)) return segment.text;
  }
  return null;
}

/** The payload map of a record, or an empty map. */
function payloadOf(record: EventRecord): Record<string, unknown> {
  const value = record.payload;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Is this changed path the daemon's own evidence surface? */
export function isExemptPath(path: string): boolean {
  const normal = segmentsOf(path).join("/");
  return EXEMPT_PREFIXES.some((prefix) =>
    prefix.endsWith("/") ? normal.startsWith(prefix) : normal === prefix,
  );
}

/**
 * Is this changed path one whose edit requires a human decision?
 *
 * The guarded set is exactly the hook's ({@link isProtectedPath}, built-ins
 * plus `policy.protected_paths`) minus the evidence surface. Sharing the
 * predicate is the point: a CI guard whose idea of "protected" drifted from the
 * hook's would fail the changes the hook already gated and pass the ones it
 * would have caught.
 */
export function isGuardedPath(path: string, policyProtectedPaths: readonly string[]): boolean {
  if (isExemptPath(path)) return false;
  return isProtectedPath(path, policyProtectedPaths);
}

/** The path a granted payload names, when it names one. */
function evidenceFor(
  material: unknown,
  path: string,
  policyProtectedPaths: readonly string[],
): { kind: EvidenceKind; detail: string } | null {
  if (typeof material !== "object" || material === null || Array.isArray(material)) return null;
  const map = material as Record<string, unknown>;

  const file = map["file"];
  if (typeof file === "string" && endsWithSegments(file, path)) {
    const tool = typeof map["tool"] === "string" ? map["tool"] : "a file tool";
    return {
      kind: "granted-file",
      detail: `the granted material is a ${tool} edit whose bound path is ${file}`,
    };
  }

  const command = map["command"];
  if (typeof command === "string") {
    const segment = commandWritesPath(command, path, policyProtectedPaths);
    if (segment !== null) {
      return {
        kind: "granted-command",
        detail: `the granted command writes this path, in the segment ${JSON.stringify(oneLine(segment))}`,
      };
    }
  }

  const argv = map["argv"];
  if (Array.isArray(argv)) {
    const joined = argv.filter((word) => typeof word === "string").join(" ");
    const segment = commandWritesPath(joined, path, policyProtectedPaths);
    if (segment !== null) {
      return {
        kind: "granted-command",
        detail: `the granted argv writes this path, in the segment ${JSON.stringify(oneLine(segment))}`,
      };
    }
  }

  return null;
}

/** One line of a possibly multi-line command segment, for a message. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}…` : flat;
}

/** The window, rendered for a failure message. */
function windowText(window: LogWindow): string {
  if (window.firstSeq === null || window.lastSeq === null) {
    return `the log at ${window.head} is empty`;
  }
  return `the log at ${window.head} covers seq ${window.firstSeq}..${window.lastSeq} (${window.firstTs ?? "?"} .. ${window.lastTs ?? "?"})`;
}

/** The ordering rule, stated identically on every failure that could be lag. */
const ORDERING_RULE =
  "the committed log trails the primary checkout's live log, so if this edit WAS granted, " +
  "the log advance carrying the grant must merge to main before or with this pull request";

/**
 * Evaluate a candidate against the committed log. Pure: no IO, no clock.
 *
 * @see GuardInput for what the caller has to gather.
 */
export function evaluateProtectedPaths(input: GuardInput): GuardReport {
  const exempt: string[] = [];
  const guarded: string[] = [];
  for (const path of input.changedPaths) {
    if (isExemptPath(path)) {
      if (isProtectedPath(path, input.policyProtectedPaths)) exempt.push(path);
      continue;
    }
    if (isProtectedPath(path, input.policyProtectedPaths)) guarded.push(path);
  }

  if (guarded.length === 0) {
    return { ok: true, findings: [], exempt, window: input.window };
  }

  // Fail closed before any evidence is sought: an unreadable or unverified log
  // is not "no protected paths changed", it is "this guard cannot see".
  if (input.logStatus !== "ok" || input.records === null) {
    const code: GuardFailureCode =
      input.logStatus === "missing" ? "log-missing" : "log-unverified";
    const why =
      code === "log-missing"
        ? `the committed log is absent from the tree at ${input.window.head}`
        : `the committed log at ${input.window.head} does not pass chain verification (${input.logDetail ?? "no detail"})`;
    return {
      ok: false,
      findings: guarded.map((path) => ({
        path,
        ok: false,
        code,
        detail: `${path} is a protected path and ${why}, so no evidence can be read for it. Nothing in this guard reads unverified records.`,
      })),
      exempt,
      window: input.window,
    };
  }

  const records = input.records;

  // The attestation index: every policy digest a human has signed off.
  const attestations = new Map<string, EventRecord>();
  for (const record of records) {
    if (record.event !== "policy.updated") continue;
    const sha = payloadOf(record)["sha256"];
    if (typeof sha === "string") attestations.set(sha, record);
  }

  // The grants of a class that can authorize a protected write.
  const grants = records.filter(
    (record) =>
      record.event === "approval.granted" &&
      GRANTING_CLASSES.includes(String(payloadOf(record)["class"] ?? "")),
  );

  const findings: GuardFinding[] = [];
  for (const path of guarded) {
    // 1. The policy file, by attestation.
    if (
      endsWithSegments(input.policyPath, path) ||
      endsWithSegments(path, input.policyPath)
    ) {
      if (input.policySha256AtHead !== null) {
        const attested = attestations.get(input.policySha256AtHead);
        if (attested !== undefined) {
          findings.push({
            path,
            ok: true,
            evidence: "attested",
            seq: attested.seq,
            ts: attested.ts,
            actor: attested.actor,
            detail: `${path} at ${input.window.head} hashes to ${input.policySha256AtHead}, which ${attested.actor} attested at seq ${attested.seq}`,
          });
          continue;
        }
      }
      // Not attested: fall through to the grant search rather than failing
      // here, because an ordinary policy.edit grant on the policy file is also
      // valid evidence and a human amendment is not the only way it changes.
    }

    // 2 and 3. A grant whose bound material names this path, close enough in
    // time to the commit that introduced the change to be about it.
    const changeTs = input.changeTsFor(path);
    const lookbackMs = input.lookbackMs ?? DEFAULT_LOOKBACK_MS;
    // ONE derivation of the anchor, so the bound that is enforced and the bound
    // that is reported cannot disagree. An unparseable timestamp is no anchor,
    // exactly as a missing one is not: both land in `anchorMs === null`.
    const parsed = changeTs === null ? Number.NaN : Date.parse(changeTs);
    const anchorMs = Number.isNaN(parsed) ? null : parsed;
    const inWindow = (ts: string): boolean => {
      if (anchorMs === null) return true;
      const at = Date.parse(ts);
      return !Number.isNaN(at) && Math.abs(at - anchorMs) <= lookbackMs;
    };
    const boundText =
      anchorMs === null
        ? `no usable commit timestamp for this path (${changeTs === null ? "git named none" : `git named ${JSON.stringify(changeTs)}, which does not parse`}), so NO recency bound was applied and this evidence rests on the path match alone`
        : `within ${Math.round(lookbackMs / 86_400_000)}d of the commit that changed it (${changeTs})`;

    // EVERY qualifying grant is collected and the best one is reported, rather
    // than the first one found. The first-match version passed commit 41d2c9f
    // on a `cp SPEC.md <dir>/` granted four days earlier while the grant that
    // actually authorized it sat 95 seconds before the commit: a true verdict
    // resting on a misleading reason, which is the kind of pass that survives
    // review and then misleads whoever reads the log after an incident. Order:
    // the stronger evidence kind first, then the grant nearest the change.
    const unresolved: string[] = [];
    const stale: EventRecord[] = [];
    const candidates: { grant: EventRecord; kind: EvidenceKind; detail: string }[] = [];
    for (const grant of grants) {
      const hash = payloadOf(grant)["payload_hash"];
      if (typeof hash !== "string") continue;
      const material = input.payloadFor(hash);
      if (material === null) {
        unresolved.push(hash);
        continue;
      }
      const found = evidenceFor(material, path, input.policyProtectedPaths);
      if (found === null) continue;
      if (!inWindow(grant.ts)) {
        stale.push(grant);
        continue;
      }
      candidates.push({ grant, kind: found.kind, detail: found.detail });
    }

    /** Distance from the change commit, or 0 when there is no anchor to measure from. */
    const distance = (grant: EventRecord): number => {
      if (anchorMs === null) return 0;
      const at = Date.parse(grant.ts);
      return Number.isNaN(at) ? Number.POSITIVE_INFINITY : Math.abs(at - anchorMs);
    };
    const rank = (kind: EvidenceKind): number => (kind === "granted-file" ? 0 : 1);
    candidates.sort(
      (left, right) =>
        rank(left.kind) - rank(right.kind) || distance(left.grant) - distance(right.grant),
    );

    const best = candidates[0];
    const hit: GuardFinding | null =
      best === undefined
        ? null
        : {
            path,
            ok: true,
            evidence: best.kind,
            seq: best.grant.seq,
            ts: best.grant.ts,
            actor: best.grant.actor,
            detail: `${path} was granted by ${best.grant.actor} at seq ${best.grant.seq} (${best.grant.ts}), ${boundText}: ${best.detail}${
              candidates.length > 1
                ? ` (the nearest and strongest of ${candidates.length} qualifying grants)`
                : ""
            }`,
          };
    if (hit !== null) {
      findings.push(hit);
      continue;
    }

    const diagnosis: string[] = [
      `${grants.length} grant${grants.length === 1 ? "" : "s"} of class ${GRANTING_CLASSES.join("/")} in this window, none naming this path`,
    ];
    if (stale.length > 0) {
      const oldest = stale[0] as EventRecord;
      diagnosis.push(
        `${stale.length} grant${stale.length === 1 ? "" : "s"} DO name this path but sit outside the recency bound (${boundText}); the oldest is seq ${oldest.seq} at ${oldest.ts}, and a grant that old authorized some earlier edit, not this one`,
      );
    }
    if (unresolved.length > 0) {
      diagnosis.push(
        `${unresolved.length} grant payload${unresolved.length === 1 ? "" : "s"} could not be resolved from the committed payload store (${unresolved.slice(0, 3).join(", ")}${unresolved.length > 3 ? ", …" : ""}), and a grant whose bytes cannot be read is not evidence for any path`,
      );
    }
    if (
      (endsWithSegments(input.policyPath, path) || endsWithSegments(path, input.policyPath)) &&
      input.policySha256AtHead !== null
    ) {
      diagnosis.push(
        `no policy.updated record attests the bytes this pull request would install (${input.policySha256AtHead}); an amendment lands through \`approval policy amend --commit\`, whose attestation record is the evidence`,
      );
    }

    findings.push({
      path,
      ok: false,
      code: "no-evidence",
      detail: `${path} is a protected path (edits classify policy.edit) and changed between ${input.window.base} and ${input.window.head}, and the committed log carries no evidence that a human decided it. ${windowText(input.window)}. ${diagnosis.join("; ")}. ${ORDERING_RULE}.`,
    });
  }

  return {
    ok: findings.every((finding) => finding.ok),
    findings,
    exempt,
    window: input.window,
  };
}

/** The report as the lines CI prints. Pure. */
export function renderGuardReport(report: GuardReport): string {
  const lines: string[] = [];
  lines.push(
    `protected-path guard: ${report.window.base}..${report.window.head}`,
  );
  if (report.exempt.length > 0) {
    lines.push(
      `  exempt (the daemon's own append surface, evidence rather than a protected write): ${report.exempt.join(", ")}`,
    );
  }
  if (report.findings.length === 0) {
    lines.push("  no protected paths changed");
    return `${lines.join("\n")}\n`;
  }
  for (const finding of report.findings) {
    const head = finding.ok ? `  PASS ${finding.path} [${finding.evidence}]` : `  FAIL ${finding.path} [${finding.code}]`;
    lines.push(head);
    lines.push(`       ${finding.detail}`);
  }
  return `${lines.join("\n")}\n`;
}
