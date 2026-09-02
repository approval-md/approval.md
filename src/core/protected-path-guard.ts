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
 * Evidence is about the CHANGE, not about the path (APRV-202). The guard reads
 * the blob at both commits, reduces the difference to the lines this pull
 * request adds and removes, and requires every one of them to trace back to the
 * bound material of some grant. A path that was granted last Tuesday and edited
 * again today has a grant naming it and no grant covering today's lines, and
 * that fails. Naming remains necessary; it stopped being sufficient.
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
 *    the touch (APRV-124), so the bound material carries `file` plus the exact
 *    edit: `{before, after}` for an Edit, `{content}` for a Write. That is
 *    HUNK-level evidence, and it is used as such. The granted `after` bytes
 *    have to occur verbatim in the blob at head before any added line is
 *    credited to them, and the granted `before` bytes have to occur in the blob
 *    at base before any removed line is. A granted edit whose after-state is not
 *    in head is a grant for something that did not land, and covers nothing.
 *    Some payloads carry the `{input}` fallback shape instead, which describes
 *    no bytes; those name the path and cover nothing.
 * 3. `granted-command` — a shell edit. The bound material is `{command, cwd}`
 *    or `{argv, cwd}`, and the guard re-runs the runtime's own
 *    {@link classifyCommand} over it, requiring a segment that classifies as a
 *    granting class BECAUSE of a word naming this path. A mention is not a
 *    grant: `cat SPEC.md` is `read.shell` and proves nothing, and the first
 *    draft of this module, which substring-matched, accepted `hook classify --
 *    vi SPEC.md` as evidence for a later SPEC.md edit.
 *
 *    A command payload cannot describe hunks: `node scripts/apply.mjs` names
 *    the file it will rewrite and says nothing about the bytes. So this kind is
 *    attributed rather than covered, and three things all have to hold:
 *
 *    - The write lands on THIS checkout's copy of the path. The payload's `cwd`
 *      joined with the repository-relative path has to be exactly the word the
 *      classifier matched (see {@link commandTargetsPath}). Three of the grants
 *      that would otherwise have carried PR #187's SPEC.md change were dry runs
 *      into `$SCRATCH/dry/SPEC.md`.
 *    - The grant was SPENT: an `execution.started` for its `action_key`, and
 *      its `execution.completed` when the log has one. A grant nobody spent
 *      authorized a command that never ran.
 *    - That run sits within {@link DEFAULT_COMMAND_ATTRIBUTION_MS} of the
 *      commit AND does not start after it. A command's effect follows its own
 *      `execution.started`, so a run four hours after the commit did not write
 *      it — a real batch, on 2026-09-02, that a symmetric window would have
 *      credited with PR #187's changes.
 *
 *    The finding names the run it attributed the change to, so a reader can
 *    check the attribution rather than take it. It stays weaker than
 *    `granted-file` because time is a weaker link than bytes: everything the
 *    approved run wrote to that path in its window is carried by it.
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
 * That bound used to be the guard's weakest joint: a repeat edit to the same
 * path inside the window inherited the earlier grant, and the guard passed
 * PR #187, #196 and #207 on grants that authorized some earlier edit. APRV-202
 * closes it, and the window is now the cheap pre-filter in front of the real
 * question. A grant inside the window still has to cover the lines: an
 * uncovered change fails `uncovered-hunk` however fresh the grants naming its
 * path are. Attestation is exempt from the bound, because it matches CONTENT: bytes that
 * hash to an attested digest are the attested bytes whenever they were signed.
 * And when git cannot date the change at all, no bound is applied rather than a
 * weaker one invented: see `changeTsFor` on {@link GuardInput} for why a bound
 * against the head commit would have been theatre. The finding says which of
 * the two it got, every time.
 *
 * ## How a hunk is decided to be covered
 *
 * The unit is a line of text. `added` is the multiset of lines the head blob
 * has and the base blob does not; `removed` is the converse. A line is covered
 * when its exact text appears in the granted material of some in-window grant
 * (in `after`/`content` for an added line, in `before` for a removed one) and
 * that material is anchored to the blob it claims, as described above. Coverage
 * may be assembled from several grants, because one pull request may carry
 * several approved edits to one file; the finding names every contributing
 * grant and puts the strongest and nearest at the head.
 *
 * Three properties of that choice are worth stating, because each is a limit:
 *
 * - A blob that differs while its line multiset does not is a REORDERING, and
 *   it is reported as one uncovered hunk rather than as no change. A rule that
 *   compared multisets alone would pass a rewrite that only moved paragraphs.
 * - Blank and whitespace-only lines neither need coverage nor give it. They
 *   carry no content, and treating them as material would let one granted edit
 *   containing an empty line cover every blank line added anywhere.
 * - Coverage is by line text, not by position. An added line whose exact text
 *   appears in some granted edit counts as covered even if it landed somewhere
 *   else in the file. Tightening that to positions would trade a narrow
 *   laundering channel (repeating a line the human already approved) for false
 *   failures on every rebase and re-indent, and the first is the cheaper loss.
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
  /**
   * Grants DO name this path, inside the window, and some added or removed line
   * of this change traces to none of their bound material (APRV-202).
   *
   * Distinct from `no-evidence` on purpose, because the two ask different
   * things of the reader. `no-evidence` says nobody approved anything about
   * this file and the question is whether the hook fired at all.
   * `uncovered-hunk` says somebody approved something about this file and it
   * was not this, which is the repeat-edit shape: the grant is real, the
   * consent trail for THESE bytes is missing, and the fix is to take the
   * change to the gate rather than to hunt for a lost record.
   */
  "uncovered-hunk",
  /**
   * The blobs at base and head could not be read for this path (git could not
   * show them, or they are binary), so no coverage could be established.
   * Failing is the fail-closed direction: a change the guard cannot read is not
   * a change it has checked.
   */
  "change-unreadable",
] as const;

export type GuardFailureCode = (typeof GUARD_FAILURE_CODES)[number];

/** How strongly the evidence ties a human decision to this exact path. */
export type EvidenceKind = "attested" | "granted-file" | "granted-command";

/**
 * How far from the commit that introduced a change a grant may sit and still be
 * evidence for it: seven days, either side. See the module note.
 */
export const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How far from the change commit a granted command's RUN may sit and still be
 * the run that produced it: six hours, either side.
 *
 * Deliberately much tighter than {@link DEFAULT_LOOKBACK_MS}, because it is
 * carrying much more weight. A file grant is checked against the bytes, so the
 * recency bound is only a sanity rail around a content match. A command grant
 * has no bytes to check, so time is the whole attribution, and a week of it
 * would re-open exactly the hole this closes: every later edit to a path some
 * approved script once wrote would inherit that script's grant. Six hours is
 * about a working session, which is the unit of "this run produced this
 * commit"; a batch that legitimately takes longer than that is asked for a
 * fresh approval, which costs one tap.
 */
export const DEFAULT_COMMAND_ATTRIBUTION_MS = 6 * 60 * 60 * 1000;

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
  /**
   * Every grant that covered part of this change, in report order, strongest
   * and nearest first. `seq` is the head of this list.
   */
  coveredBy?: readonly number[];
  /** Present on a failure. */
  code?: GuardFailureCode;
  /**
   * On `uncovered-hunk`, a sample of the lines that traced to no granted
   * material, `+` for added and `-` for removed.
   */
  uncovered?: readonly string[];
  /** Prose a reader can act on, on either outcome. */
  detail: string;
}

/** A protected path's bytes at both ends of the range the guard is checking. */
export interface ChangeBlobs {
  /** The blob at base, or `null` when this pull request adds the file. */
  base: string | null;
  /** The blob at head, or `null` when this pull request deletes it. */
  head: string | null;
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
  /**
   * The path's bytes at base and at head, or `null` when they could not be
   * read (git could not show them, or the blob is binary).
   *
   * This is what makes the guard's question "was THIS change approved" rather
   * than "was this path approved once" (APRV-202). `null` fails the path with
   * `change-unreadable` rather than falling back to the path-level rule: the
   * fallback is the hole.
   */
  blobsFor: (path: string) => ChangeBlobs | null;
  /** Override {@link DEFAULT_LOOKBACK_MS}. */
  lookbackMs?: number;
  /** Override {@link DEFAULT_COMMAND_ATTRIBUTION_MS}. */
  commandAttributionMs?: number;
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
  cwd: string | undefined,
): { text: string; named: string } | null {
  const classified = classifyCommand(command, policyProtectedPaths);
  if (!classified.ok) return null;
  for (const segment of classified.segments) {
    if (!GRANTING_CLASSES.includes(segment.class)) continue;
    const named = segment.path;
    if (typeof named === "string" && endsWithSegments(named, path)) {
      return { text: segment.text, named };
    }
    // `ClassifiedSegment.path` holds ONE path, the word that selected the
    // class, and a batch names several: PR #187's granted run is
    // `node apply.mjs <root> SPEC.md .github/workflows/ci.yml tests/…`, which
    // reports SPEC.md and would leave the workflow file unattributed. So the
    // other words of a segment ALREADY classified as a protected write are
    // considered too, and only on the strict test: the word has to resolve,
    // against the recorded `cwd`, to exactly this checkout's copy of this
    // path. A mention cannot pass that, and neither can a segment the
    // classifier did not already call a protected write.
    for (const word of segment.text.split(/[\s;|&()<>]+/u)) {
      const bare = word.replace(/^['"]+|['"]+$/gu, "");
      if (bare.length === 0) continue;
      if (commandTargetsPath(bare, cwd, path)) return { text: segment.text, named: bare };
    }
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

/**
 * What a granted payload says about this path.
 *
 * `kind` and `detail` are the old path-level answer, which is still computed
 * because it is what the failure diagnosis reports. The rest is the APRV-202
 * addition: the actual bytes the human approved, so the caller can ask whether
 * THIS change is made of them.
 */
interface NamingMatch {
  kind: EvidenceKind;
  detail: string;
  /** Lines the grant authorizes as ADDED, or `null` when it binds no bytes. */
  after: string[] | null;
  /** Lines it authorizes as REMOVED, or `null`. */
  before: string[] | null;
  /** The material is the whole intended head state (a Write of exactly it). */
  whole: boolean;
  /** A command grant: covers only once its run is attributed (see the note). */
  command: boolean;
  /** The path the classified segment names, for a command grant. */
  target?: string;
  /** The directory the granted command ran in, for a command grant. */
  cwd?: string;
}

/**
 * Does this granted command write THIS repository's copy of the path?
 *
 * The naming test is a path suffix, which cannot tell two checkouts apart and
 * says so. Coverage cannot afford that, and the real log shows why: three of
 * the grants that would have carried PR #187's SPEC.md change were DRY RUNS
 * that wrote `$SCRATCH/dry/SPEC.md` in a temporary directory. Every one of them
 * classifies `policy.edit` on a path ending in `SPEC.md`, and not one of them
 * touched the file the pull request changed.
 *
 * So attribution anchors the write to the checkout the command ran in: the
 * payload's `cwd` joined with the repository-relative path has to be exactly
 * the path the segment names. A grant that wrote a copy somewhere else covers
 * nothing here, and a command run from a subdirectory of the checkout is not
 * anchored either, which is the fail-closed direction and costs one approval.
 */
function commandTargetsPath(target: string, cwd: string | undefined, path: string): boolean {
  if (cwd === undefined || cwd.length === 0) return false;
  const absolute = target.startsWith("/") || target.startsWith("\\");
  const named = absolute ? segmentsOf(target) : [...segmentsOf(cwd), ...segmentsOf(target)];
  const resolved: string[] = [];
  for (const segment of named) {
    if (segment === "..") resolved.pop();
    else resolved.push(segment);
  }
  const want = [...segmentsOf(cwd), ...segmentsOf(path)];
  return resolved.length === want.length && resolved.every((part, index) => part === want[index]);
}

/** The path a granted payload names, with the bytes it bound to it. */
function evidenceFor(
  material: unknown,
  path: string,
  policyProtectedPaths: readonly string[],
): NamingMatch | null {
  if (typeof material !== "object" || material === null || Array.isArray(material)) return null;
  const map = material as Record<string, unknown>;

  const file = map["file"];
  if (typeof file === "string" && endsWithSegments(file, path)) {
    const tool = typeof map["tool"] === "string" ? map["tool"] : "a file tool";
    const before = map["before"];
    const after = map["after"];
    const content = map["content"];
    if (typeof before === "string" && typeof after === "string") {
      return {
        kind: "granted-file",
        detail: `the granted material is a ${tool} edit of ${file} binding ${linesOf(before).length} line(s) out and ${linesOf(after).length} line(s) in`,
        after: [after],
        before: [before],
        whole: false,
        command: false,
      };
    }
    if (typeof content === "string") {
      return {
        kind: "granted-file",
        detail: `the granted material is a ${tool} of ${file} binding the whole file (${linesOf(content).length} line(s))`,
        after: [content],
        before: null,
        whole: true,
        command: false,
      };
    }
    // The `{input}` fallback shape (APRV-124): the tool call was recorded, the
    // bytes were not. It names the path and binds nothing, so it is diagnosis.
    return {
      kind: "granted-file",
      detail: `the granted material is a ${tool} call on ${file} recorded in the fallback \`input\` shape, which binds no before/after bytes`,
      after: null,
      before: null,
      whole: false,
      command: false,
    };
  }

  const cwd = typeof map["cwd"] === "string" ? map["cwd"] : undefined;
  const asCommand = (
    found: { text: string; named: string },
    shape: "command" | "argv",
  ): NamingMatch => ({
    kind: "granted-command",
    detail: `the granted ${shape} writes this path, in the segment ${JSON.stringify(oneLine(found.text))}`,
    after: null,
    before: null,
    whole: false,
    command: true,
    target: found.named,
    ...(cwd === undefined ? {} : { cwd }),
  });

  const command = map["command"];
  if (typeof command === "string") {
    const found = commandWritesPath(command, path, policyProtectedPaths, cwd);
    if (found !== null) return asCommand(found, "command");
  }

  const argv = map["argv"];
  if (Array.isArray(argv)) {
    const joined = argv.filter((word) => typeof word === "string").join(" ");
    const found = commandWritesPath(joined, path, policyProtectedPaths, cwd);
    if (found !== null) return asCommand(found, "argv");
  }

  return null;
}

/** A blob's lines, with the empty tail a trailing newline leaves dropped. */
function linesOf(text: string): string[] {
  const parts = text.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** A line that carries content. Blank lines neither need coverage nor give it. */
function substantive(line: string): boolean {
  return line.trim().length > 0;
}

/** Multiset difference, `left` minus `right`, keeping multiplicity and order. */
function linesMinus(left: readonly string[], right: readonly string[]): string[] {
  const budget = new Map<string, number>();
  for (const line of right) budget.set(line, (budget.get(line) ?? 0) + 1);
  const out: string[] = [];
  for (const line of left) {
    const remaining = budget.get(line) ?? 0;
    if (remaining > 0) {
      budget.set(line, remaining - 1);
      continue;
    }
    out.push(line);
  }
  return out;
}

/** What this pull request did to a protected path, as lines. */
interface ChangeHunks {
  added: string[];
  removed: string[];
  /** The substantive lines are the same lines in a different order. */
  reordered: boolean;
  /** No substantive line changed: whitespace, mode or metadata only. */
  identical: boolean;
}

/** Reduce a change to the substantive lines it adds and removes. */
function hunksOf(blobs: ChangeBlobs): ChangeHunks {
  const baseText = blobs.base ?? "";
  const headText = blobs.head ?? "";
  const quiet = { added: [], removed: [], reordered: false, identical: true };
  if (baseText === headText) return quiet;
  const baseLines = linesOf(baseText).filter(substantive);
  const headLines = linesOf(headText).filter(substantive);
  // Same substantive lines in the same order: the bytes moved, the content did
  // not. A re-indent or a blank line is not a change a human needs to have seen.
  if (
    baseLines.length === headLines.length &&
    baseLines.every((line, index) => line === headLines[index])
  ) {
    return quiet;
  }
  const added = linesMinus(headLines, baseLines);
  const removed = linesMinus(baseLines, headLines);
  return {
    added,
    removed,
    // Same lines, different order. Reported as an uncovered hunk rather than as
    // no change, so a rewrite that only moves paragraphs cannot pass on a diff
    // that looks empty to a multiset.
    reordered: added.length === 0 && removed.length === 0,
    identical: false,
  };
}

/** The substantive lines of every granted chunk, as a lookup set. */
function materialLines(chunks: readonly string[] | null): Set<string> {
  const set = new Set<string>();
  for (const chunk of chunks ?? []) {
    for (const line of linesOf(chunk)) {
      if (substantive(line)) set.add(line);
    }
  }
  return set;
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

/**
 * How far past the change commit a run may still start and be its cause: five
 * minutes, for clock disagreement between the log and git's author date. It is
 * a skew allowance, not an ordering allowance.
 */
const SKEW_GRACE_MS = 5 * 60 * 1000;

/** Milliseconds as something a failure message can say out loud. */
function spanText(ms: number): string {
  if (ms < 90 * 60 * 1000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 48 * 60 * 60 * 1000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

/**
 * Tie a granted command to the RUN that produced this change, or say why not.
 *
 * A command payload names a path and describes no bytes, so this is the only
 * link there is. Two things have to hold: the grant was SPENT (the log carries
 * an `execution.started` for its `action_key`, which is what the hook's
 * `consumeHarnessGrant` and `approval run` append), and that run sits within
 * the attribution window of the commit. A grant nobody spent authorized a
 * command that never ran, and a run a week away from the commit did not write
 * it. `execution.completed`, when the log has one, widens the run to the
 * interval it actually occupied: a batch that started before the commit and
 * finished after it brackets the commit, which is the strongest form of this.
 */
function attributeRun(
  grant: EventRecord,
  runs: Map<string, EventRecord[]>,
  anchorMs: number | null,
  attributionMs: number,
): { ok: true; detail: string } | { ok: false; why: string } {
  const key = grant.action_key;
  if (key === undefined) {
    return {
      ok: false,
      why: `the grant at seq ${grant.seq} carries no action_key, so no execution record can be tied to it`,
    };
  }
  const tied = runs.get(key) ?? [];
  const started = tied.filter((record) => record.event === "execution.started");
  if (started.length === 0) {
    return {
      ok: false,
      why: `the grant at seq ${grant.seq} was never spent: the committed log carries no execution.started for ${key}, so nothing says the granted command ever ran`,
    };
  }
  const completed = tied.filter((record) => record.event === "execution.completed");
  const endOf = (record: EventRecord): EventRecord | undefined =>
    completed.find((done) => done.seq > record.seq);

  if (anchorMs === null) {
    const first = started[0] as EventRecord;
    return {
      ok: true,
      detail: `spent at seq ${first.seq} (execution.started ${first.ts}), and with no usable commit timestamp NO attribution bound was applied to that run`,
    };
  }

  // A run that STARTED after the commit did not produce it. Unlike a grant,
  // whose relation to a write can be either order (APRV-200's grant-follows-
  // write), a command's effect strictly follows its own `execution.started`:
  // the record is appended before the process is spawned. The real log shows
  // what the symmetric window costs — a SPEC.md batch run four hours AFTER
  // PR #187's commit would otherwise have carried that commit's changes.
  // `SKEW_GRACE_MS` is for the two clocks (the log's and git's author date)
  // disagreeing, not for ordering.
  let best: { record: EventRecord; end: EventRecord | undefined; distance: number } | null = null;
  let laterOnly: EventRecord | null = null;
  for (const record of started) {
    const from = Date.parse(record.ts);
    if (Number.isNaN(from)) continue;
    if (from > anchorMs + SKEW_GRACE_MS) {
      if (laterOnly === null) laterOnly = record;
      continue;
    }
    const end = endOf(record);
    const to = end === undefined ? from : Date.parse(end.ts);
    const upper = Number.isNaN(to) ? from : to;
    const distance =
      anchorMs >= Math.min(from, upper) && anchorMs <= Math.max(from, upper)
        ? 0
        : Math.min(Math.abs(from - anchorMs), Math.abs(upper - anchorMs));
    if (best === null || distance < best.distance) best = { record, end, distance };
  }
  if (best === null && laterOnly !== null) {
    return {
      ok: false,
      why: `the granted command's only run started at ${laterOnly.ts}, AFTER the commit that changed this path; a command's effect follows its own execution.started, so that run did not write this change`,
    };
  }
  if (best === null) {
    return {
      ok: false,
      why: `the execution records for ${key} carry no parseable timestamp, so the run cannot be placed against the commit`,
    };
  }
  const span = best.end === undefined ? "" : `..${best.end.ts} (execution.completed)`;
  if (best.distance > attributionMs) {
    return {
      ok: false,
      why: `the granted command ran at ${best.record.ts}${span}, which is ${spanText(best.distance)} from the commit that changed this path and outside the ${spanText(attributionMs)} attribution window; that run produced some earlier change, not this one`,
    };
  }
  return {
    ok: true,
    detail:
      best.distance === 0 && best.end !== undefined
        ? `the granted run brackets the commit (execution.started ${best.record.ts}${span})`
        : `the granted run sits ${spanText(best.distance)} from the commit (execution.started ${best.record.ts}${span}), within the ${spanText(attributionMs)} attribution window`,
  };
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

  // The runs, by action key: what a granted COMMAND is attributed through
  // (APRV-202). `execution.started` is appended by the hook when it spends a
  // harness grant and by `approval run` when it spends a token; the completion
  // beside it, where the log has one, widens the run to an interval.
  const runs = new Map<string, EventRecord[]>();
  for (const record of records) {
    if (record.event !== "execution.started" && record.event !== "execution.completed") continue;
    const key = record.action_key;
    if (key === undefined) continue;
    const bucket = runs.get(key);
    if (bucket === undefined) runs.set(key, [record]);
    else bucket.push(record);
  }
  const attributionMs = input.commandAttributionMs ?? DEFAULT_COMMAND_ATTRIBUTION_MS;

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
    const candidates: { grant: EventRecord; match: NamingMatch }[] = [];
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
      candidates.push({ grant, match: found });
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
        rank(left.match.kind) - rank(right.match.kind) ||
        distance(left.grant) - distance(right.grant),
    );

    // The change this pull request makes to the path. Read before any coverage
    // is attempted, and a failure to read it is a failure: a change the guard
    // cannot see is not a change it has checked (APRV-202).
    const blobs = input.blobsFor(path);
    if (blobs === null) {
      findings.push({
        path,
        ok: false,
        code: "change-unreadable",
        detail: `${path} is a protected path and changed between ${input.window.base} and ${input.window.head}, and its bytes could not be read at both commits (git could not show the blob, or it is binary), so no grant could be checked against the change. ${candidates.length} grant${candidates.length === 1 ? "" : "s"} name this path in the window, and naming is not coverage. ${ORDERING_RULE}.`,
      });
      continue;
    }
    const hunks = hunksOf(blobs);
    const baseText = blobs.base ?? "";
    const headText = blobs.head ?? "";

    // Which of those grants covers which lines. A pull request may carry
    // several approved edits to one file, so coverage accumulates and the
    // finding names every contributor.
    const contributors: { grant: EventRecord; kind: EvidenceKind; why: string; whole: boolean }[] = [];
    const rejected: string[] = [];
    const addedCover = new Set<string>();
    const removedCover = new Set<string>();
    let whole = false;
    for (const candidate of candidates) {
      const { grant, match } = candidate;
      const at = `the grant at seq ${grant.seq}`;
      if (match.command) {
        if (!commandTargetsPath(match.target ?? "", match.cwd, path)) {
          rejected.push(
            `${at} writes ${JSON.stringify(match.target ?? "")} from ${JSON.stringify(match.cwd ?? "(no cwd recorded)")}, which is not this checkout's ${path}: a granted write to a copy of the file elsewhere (a dry run into a scratch directory, another worktree) authorizes nothing here`,
          );
          continue;
        }
        const run = attributeRun(grant, runs, anchorMs, attributionMs);
        if (!run.ok) {
          rejected.push(run.why);
          continue;
        }
        // A command payload describes no bytes, so attribution is all or
        // nothing: the run that wrote this file wrote whatever is in it.
        whole = true;
        contributors.push({ grant, kind: match.kind, why: `${match.detail}, and ${run.detail}`, whole: true });
        continue;
      }
      if (match.after === null && match.before === null) {
        rejected.push(`${at} names this path and binds no bytes (${match.detail}), so it covers nothing`);
        continue;
      }
      const after = match.after?.[0] ?? "";
      const before = match.before?.[0] ?? "";
      let contributed: string | null = null;
      let wholeHere = false;
      if (match.whole) {
        if (after === headText) {
          whole = true;
          wholeHere = true;
          contributed = `${match.detail}, and those bytes ARE the blob at head`;
        } else if (after.length > 0 && headText.includes(after)) {
          for (const line of materialLines([after])) addedCover.add(line);
          contributed = `${match.detail}, and those bytes occur in the blob at head`;
        } else {
          rejected.push(
            `${at} binds a whole-file write whose bytes are neither equal to nor contained in the blob at head, so what landed is not what was approved`,
          );
        }
      } else {
        const parts: string[] = [];
        if (after.length > 0) {
          if (headText.includes(after)) {
            for (const line of materialLines([after])) addedCover.add(line);
            parts.push("its after-state occurs verbatim in the blob at head");
          } else {
            rejected.push(
              `${at} binds an after-state that does not occur in the blob at head, so the edit it approved is not the edit that landed`,
            );
          }
        }
        if (before.length > 0) {
          if (baseText.includes(before)) {
            for (const line of materialLines([before])) removedCover.add(line);
            parts.push("its before-state occurs in the blob at base");
          } else {
            rejected.push(
              `${at} binds a before-state that does not occur in the blob at base`,
            );
          }
        }
        if (parts.length > 0) contributed = `${match.detail}, and ${parts.join(" and ")}`;
      }
      if (contributed !== null) contributors.push({ grant, kind: match.kind, why: contributed, whole: wholeHere });
    }

    // What the bytes alone cover, before any whole-file attribution. If this is
    // non-empty the change RESTS on the attribution, and the finding has to
    // lead with the grant carrying it rather than with a file grant that
    // covered a line or two: a true verdict resting on a misleading reason is
    // the failure APRV-151 fixed once already.
    const byBytesAdded = hunks.added.filter((line) => !addedCover.has(line));
    const byBytesRemoved = hunks.removed.filter((line) => !removedCover.has(line));
    const restsOnAttribution =
      whole && (byBytesAdded.length > 0 || byBytesRemoved.length > 0 || hunks.reordered);
    const uncoveredAdded = whole ? [] : byBytesAdded;
    const uncoveredRemoved = whole ? [] : byBytesRemoved;
    const uncovered = [
      ...uncoveredAdded.map((line) => `+${line}`),
      ...uncoveredRemoved.map((line) => `-${line}`),
    ];
    if (hunks.reordered && !whole) {
      uncovered.push("~ the same lines in a different order (a reordering no granted material describes)");
    }

    // The headline. Ordinarily it is the strongest and nearest grant that
    // actually covered something. The one exception is a change with no
    // substantive line difference at all (whitespace, a mode bit): there is no
    // hunk to cover, so the pre-APRV-202 rule stands for it and a naming grant
    // inside the window is the evidence. That is the only surviving path-level
    // pass, and it is narrow by construction: a change that alters no line.
    const lead = restsOnAttribution
      ? (contributors.find((one) => one.whole) ?? contributors[0])
      : contributors[0];
    const quiet = hunks.identical ? candidates[0] : undefined;
    const passing: { record: EventRecord; kind: EvidenceKind; why: string } | undefined =
      lead !== undefined
        ? { record: lead.grant, kind: lead.kind, why: lead.why }
        : quiet !== undefined
          ? {
              record: quiet.grant,
              kind: quiet.match.kind,
              why: `${quiet.match.detail}, and this change alters no substantive line (whitespace, mode or metadata only), so there is no hunk to cover`,
            }
          : undefined;
    if (passing !== undefined && uncovered.length === 0) {
      const record = passing.record;
      const kind = passing.kind;
      const why = passing.why;
      findings.push({
        path,
        ok: true,
        evidence: kind,
        seq: record.seq,
        ts: record.ts,
        actor: record.actor,
        coveredBy: contributors.map((one) => one.grant.seq),
        detail: `${path} was granted by ${record.actor} at seq ${record.seq} (${record.ts}), ${boundText}: ${why}. ${
          hunks.identical
            ? "there are no substantive hunks to cover"
            : whole
              ? "the whole change is attributed to that grant"
              : `${hunks.added.length} added and ${hunks.removed.length} removed line(s) all trace to granted material`
        }${
          contributors.length > 1
            ? ` (assembled from ${contributors.length} grants: seq ${contributors.map((one) => one.grant.seq).join(", ")}; the strongest and nearest leads)`
            : ""
        }`,
      });
      continue;
    }

    // Naming grants exist and the change is not made of them: the repeat-edit
    // shape. Its own code, because the reader's next move differs from
    // `no-evidence` — take THIS change to the gate, rather than hunt for a
    // record that was never written.
    if (candidates.length > 0) {
      const sample = uncovered.slice(0, 5).map((line) => oneLine(line));
      findings.push({
        path,
        ok: false,
        code: "uncovered-hunk",
        uncovered: sample,
        detail: `${path} is a protected path and ${uncovered.length} line(s) of this change trace to no granted material. ${candidates.length} grant${candidates.length === 1 ? "" : "s"} name this path ${boundText}, and naming is not coverage: a grant authorizes the bytes it bound, and a later edit to the same file is a different decision. ${
          contributors.length > 0
            ? `${contributors.length} grant${contributors.length === 1 ? "" : "s"} covered part of it (seq ${contributors.map((one) => one.grant.seq).join(", ")}); `
            : ""
        }${
          rejected.length > 0
            ? `${rejected.slice(0, 6).join("; ")}${rejected.length > 6 ? `; … and ${rejected.length - 6} other naming grants set aside for the same kinds of reason` : ""}. `
            : ""
        }uncovered: ${sample.map((line) => JSON.stringify(line)).join(", ")}${uncovered.length > sample.length ? `, … ${uncovered.length - sample.length} more` : ""}. ${windowText(input.window)}. ${ORDERING_RULE}.`,
      });
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
