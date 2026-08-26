/**
 * `.approval/QUEUE.md` — the queue projection of SPEC.md §9.1.
 *
 * > **The queue** (`.approval/QUEUE.md`): a rendered, read-only markdown view of
 * > pending requests (task, actions, declared effects, cost, TTL countdown) plus
 * > the sampled-audit backlog. Regenerated on every relevant event. This is the
 * > screenshot; it is never the truth.
 *
 * Three properties are the whole point of this module.
 *
 * **It is a pure function of (verified log, policy, `now`).** No ambient clock,
 * no locale, no hostname, no environment, no random temp name in the bytes. The
 * evaluation instant is a parameter — the same discipline `channels/tagging.ts`
 * already keeps — so an identical log rendered at an identical `now` produces
 * identical bytes, and a rendering can be reproduced later from the log alone.
 * Every number here is formatted by hand with integer arithmetic for the same
 * reason: `toLocaleString` would make the output depend on the machine.
 *
 * **It re-derives nothing.** Entries come from
 * {@link buildPendingQueue}, which is the one place a {@link ChannelRequest} is
 * built. So the class, the autonomy, the provenance, the budgets, the
 * attestation and the TTL a reader sees in QUEUE.md are the same answers the
 * gate itself would give — not a second implementation that could drift. This
 * module's entire job is text.
 *
 * **It never writes the log.** {@link writeQueue} writes exactly one file, and
 * it is `QUEUE.md`.
 *
 * ## Why this lives in `src/channels/`, not `src/core/`
 *
 * It consumes `channels/contract.ts`'s tagged requests through
 * `channels/tagging.ts`. Putting it in `core/` would make core import channels,
 * inverting the dependency the codebase is built on: core decides, channels
 * display, and this file is display — a read-only markdown surface that collects
 * no gesture and holds no authority. It sits beside `tagging.ts` and `batch.ts`
 * because it is the third consumer of the same tagged data, and it deliberately
 * does not implement {@link ../channels/contract.js Channel}: QUEUE.md notifies
 * nobody and answers nothing.
 *
 * ## B3: computed vs claimed
 *
 * SPEC.md §9: "Every displayed field is one of two kinds and MUST be visibly
 * distinguished". Here that is structural, not typographic: computed fields are
 * rendered as `computed · <source>` lines under **Computed by the runtime**, and
 * claimed fields under a separate **Claimed by `<actor>` (not verified)** block
 * that names its author. A reader skimming the file cannot mistake an agent's
 * cost estimate for a budget verdict, because they are not in the same list.
 *
 * ## The full payload is NOT in this file — flagged for human review
 *
 * SPEC.md §10.4 requires channels to present the full payload before collecting
 * a decision. QUEUE.md collects no decision: it is a read-only summary, and the
 * decision surfaces are the channels (`approval grant`, the web page, Telegram),
 * each of which presents the bytes at decision time. Inlining payloads here
 * would put every pending payload — recipients, bodies, argv — into a file that
 * is regenerated on every event, checked into nothing, and read by anyone with
 * the working directory, with no gesture ever collected from it. So the queue
 * carries the **binding** (`payload_hash`) and points at the channels for the
 * bytes, and the rendered header says exactly that to the human reading it.
 *
 * Which is a different statement from "the renderer cannot see the payload".
 * Since APRV-28 it can: `channels/tagging.ts` reads the payload store beside the
 * log (SPEC.md §6.2's "the payload itself is stored or referenced by the request
 * so channels can display it"), so a request whose bytes were supplied at intake
 * is *summarizable* here and appears in the pending section — which is why this
 * file's pending count now agrees with the queue every channel shows, where
 * before it silently disagreed. The bytes still do not appear in this file.
 * Requests whose material nobody holds remain in {@link QueueRender.skipped},
 * rendered in their own section with the reason, never silently dropped.
 */

import { closeSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

import type { BudgetVerdict } from "../core/budgets.js";
import type { EventRecord, LogHead } from "../core/log.js";
import { payloadOf, readVerifiedRecords } from "../core/state.js";
import type { ChannelRequest, TaggedField } from "./contract.js";
import {
  buildPendingQueue,
  type ChannelTagRefusalCode,
  type SkippedRequest,
  type TagOptions,
} from "./tagging.js";

// ---------------------------------------------------------------------------
// Options, results, refusals
// ---------------------------------------------------------------------------

/**
 * Rendering options. A superset of {@link TagOptions} with nothing added: the
 * renderer's inputs are exactly the tagger's inputs, plus `now`, because it
 * derives nothing the tagger does not already derive.
 */
export type RenderQueueOptions = TagOptions;

/**
 * Why the renderer refused.
 *
 * The three log codes are `channels/tagging.ts`'s and `core/state.ts`'s,
 * verbatim, so a corrupt log is reported as corruption by every layer with one
 * vocabulary. `write-failed` is {@link writeQueue}'s alone — the renderer itself
 * cannot fail for any other reason, because it is a pure function.
 */
export const RENDER_QUEUE_REFUSAL_CODES = [
  "log-unreadable",
  "log-torn-tail",
  "log-corrupt",
  "write-failed",
] as const;

export type RenderQueueRefusalCode = (typeof RENDER_QUEUE_REFUSAL_CODES)[number];

export interface RenderQueueRefusal {
  ok: false;
  code: RenderQueueRefusalCode;
  message: string;
}

/** A successful render: the bytes, plus what went into them. */
export interface QueueRender {
  ok: true;
  /** The complete file contents. Deterministic for a given (log, policy, now). */
  markdown: string;
  /** The chain head the render derives from; `null` for an empty log. */
  head: LogHead | null;
  /** Pending requests rendered, in log order. */
  pending: number;
  /** Live requests that could not be tagged, listed with their reason. */
  skipped: number;
  /** `audit.sampled` events with no later `audit.reviewed`. */
  auditBacklog: number;
}

export type RenderQueueResult = QueueRender | RenderQueueRefusal;

export interface QueueWrite extends Omit<QueueRender, "markdown"> {
  /** Where the file was written. */
  path: string;
  /** Bytes written (UTF-8). */
  bytes: number;
}

export type WriteQueueResult = QueueWrite | RenderQueueRefusal;

function refuse(code: RenderQueueRefusalCode, message: string): RenderQueueRefusal {
  return { ok: false, code, message };
}

// ---------------------------------------------------------------------------
// Deterministic formatting primitives
// ---------------------------------------------------------------------------

/**
 * Render a value inside a markdown code span, with anything that could break
 * the line or the span neutralized.
 *
 * Claimed strings are attacker-controlled in the threat model that matters
 * (SPEC.md §11: the party under oversight authors them), so a summary
 * containing a newline, a backtick, or a markdown heading must not be able to
 * restructure the file it is rendered into — a claimed field that could forge a
 * `computed ·` line would defeat B3 by typography alone.
 */
function span(value: string): string {
  // Replacements are written as escapes so the substitutes themselves (U+23CE
  // RETURN SYMBOL, U+FFFD REPLACEMENT CHARACTER, U+02CB MODIFIER GRAVE ACCENT)
  // are unambiguous in a diff: each is a visible stand-in, never the character
  // it replaces.
  const flat = value
    .replace(/\r\n?|\n/gu, "\u23ce ")
    .replace(/\p{Cc}/gu, "\ufffd")
    .replace(/`/gu, "\u02cb");
  return flat.length === 0 ? "``" : `\`${flat}\``;
}

/** `null` renders as an explicit absence, never as an empty cell. */
function optionalSpan(value: string | null): string {
  return value === null ? "_none_" : span(value);
}

/**
 * A number, formatted without a locale.
 *
 * `JSON.stringify` of a finite number is the ECMAScript number-to-string
 * algorithm: locale-independent, platform-independent, and the same function
 * the log's canonical serialization already relies on.
 */
function num(value: number): string {
  return Number.isFinite(value) ? JSON.stringify(value) : "NaN";
}

/**
 * A TTL remaining, as a countdown.
 *
 * Integer arithmetic only, largest non-zero unit first, seconds always present
 * so the string never reads as more precise than it is. `0ms` is the boundary:
 * a request whose TTL has fully elapsed is no longer `requested` and therefore
 * is not in this file at all — see {@link renderQueue}'s section on expiry.
 */
function countdown(ms: number | null): string {
  if (ms === null) return "_no TTL_ (the policy declares no `defaults.approval_ttl`)";
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${String(hours)}h`);
  if (hours > 0 || minutes > 0) parts.push(`${String(minutes)}m`);
  parts.push(`${String(seconds)}s`);
  return `${parts.join(" ")} left`;
}

/**
 * One budget verdict, in the evaluator's own vocabulary.
 *
 * `remaining` is headroom *after* admitting this action, exactly as
 * `core/budgets.ts` defines it, so a failing verdict shows how far over the line
 * the action is rather than a reassuring zero.
 */
/*
 * The three figures are printed exactly as the evaluator reports them: since
 * APRV-121 they are decimal strings computed in integer micro-USD, so there is
 * no number here to reformat and no locale that could change what a human sees.
 */
function budgetLine(verdict: BudgetVerdict): string {
  const note = verdict.note === undefined ? "" : ` — ${span(verdict.note)}`;
  return `${verdict.pass ? "pass" : "**FAIL**"} ${span(verdict.limit)} (${span(
    verdict.scope,
  )}, ${span(verdict.window)}): consumed ${verdict.consumed}, requested ${
    verdict.requested
  }, remaining ${verdict.remaining}${note}`;
}

// ---------------------------------------------------------------------------
// The tagged-field renderers (B3)
// ---------------------------------------------------------------------------

/** One computed line. `source` is always shown: the derivation is the warrant. */
function computedLine(label: string, field: TaggedField<unknown>, rendered: string): string {
  const source = field.kind === "computed" ? field.source : "unknown";
  return `- **${label}** — computed · ${source}: ${rendered}`;
}

/** One claimed line. The author is always shown: the claim is theirs, not ours. */
function claimedLine(label: string, field: TaggedField<unknown>, rendered: string): string {
  const author = field.kind === "claimed" ? field.author : "unknown";
  return `- **${label}** — claimed by ${span(author)}: ${rendered}`;
}

/**
 * One pending request, as a markdown section.
 *
 * The order is deliberate: what the runtime computed first, what the agent
 * claimed second, under its own heading. B3 is satisfied structurally — the two
 * kinds are never adjacent lines in one list — and the claimed heading repeats
 * the word "unverified" because a heading is what a skimming reader actually
 * reads.
 */
function renderRequest(index: number, request: ChannelRequest): string[] {
  const lines: string[] = [];
  const claimedAuthor =
    request.summary.kind === "claimed" ? request.summary.author : "unknown";

  lines.push(`### ${String(index)}. ${span(request.action_key.value)}`);
  lines.push("");
  lines.push("**Computed by the runtime** (derived from the verified log, the attested policy, and the payload binding):");
  lines.push("");
  lines.push(computedLine("action key", request.action_key, span(request.action_key.value)));
  lines.push(computedLine("task", request.task, optionalSpan(request.task.value)));
  lines.push(computedLine("class", request.class, span(request.class.value)));
  lines.push(
    computedLine(
      "autonomy",
      request.autonomy,
      `${span(request.autonomy.value)} (provenance ${span(request.provenance.value)})`,
    ),
  );
  lines.push(computedLine("state", request.state, span(request.state.value)));
  lines.push(computedLine("requested at", request.requested_ts, span(request.requested_ts.value)));
  // APRV-106: the age and the deadline an answer has to beat, in one line.
  lines.push(computedLine("waiting", request.waiting, request.waiting.value));
  lines.push(
    computedLine("TTL remaining", request.ttl_remaining_ms, countdown(request.ttl_remaining_ms.value)),
  );
  lines.push(computedLine("payload hash", request.payload_hash, span(request.payload_hash.value)));
  lines.push(
    computedLine(
      "payload bytes",
      request.fullPayload,
      request.fullPayload.value === null
        ? "_not held by this renderer_ — the channels present the bytes at decision time"
        : "_not shown here_ — this file is a summary; the channels present the bytes at decision time",
    ),
  );
  lines.push(
    computedLine(
      "attestation",
      request.attestation,
      `${span(request.attestation.value.status)}`,
    ),
  );
  const verdicts = request.budgets.value;
  lines.push(
    computedLine(
      "budgets",
      request.budgets,
      verdicts.length === 0 ? "_no budgets in force_" : "",
    ).trimEnd(),
  );
  for (const verdict of verdicts) lines.push(`  - ${budgetLine(verdict)}`);
  lines.push(
    computedLine(
      "chain position",
      request.chain,
      `seq ${String(request.chain.value.seq)} ${span(request.chain.value.hash)} (head seq ${String(
        request.chain.value.head_seq,
      )})`,
    ),
  );
  lines.push("");
  lines.push(`**Claimed by ${span(claimedAuthor)} — UNVERIFIED** (the requesting party authored these; they may raise scrutiny, never lower it):`);
  lines.push("");
  lines.push(claimedLine("summary", request.summary, optionalSpan(request.summary.value)));
  lines.push(
    claimedLine("est. cost (USD)", request.est_cost_usd, num(request.est_cost_usd.value)),
  );
  if (request.rationale !== undefined) {
    lines.push(claimedLine("rationale", request.rationale, span(request.rationale.value)));
  }
  if (request.confidence !== undefined) {
    lines.push(claimedLine("confidence", request.confidence, num(request.confidence.value)));
  }
  lines.push("");
  return lines;
}

// ---------------------------------------------------------------------------
// The audit backlog (SPEC.md §9.1, §12)
// ---------------------------------------------------------------------------

/** One sampled action still waiting for a review. */
interface AuditItem {
  seq: number;
  ts: string;
  actor: string;
  task: string | null;
  actionKey: string | null;
}

/**
 * `audit.sampled` events with no later `audit.reviewed` for the same subject.
 *
 * Matching is on `action_key` when both records carry one, and on `task`
 * otherwise — the two identifiers the event schema gives these types. A review
 * must come *after* its sample in the chain: an earlier `audit.reviewed` is a
 * review of an earlier sample, and treating it as covering this one would
 * silently empty the backlog, which is exactly the failure a sampled-audit
 * backlog exists to prevent.
 *
 * The sampler that fills this section is `core/audit.ts`, driven by the daemon
 * (APRV-40). It runs only when the operator's HMAC secret is configured, so an
 * empty backlog is genuinely ambiguous — everything reviewed, or nothing
 * sampled — and the empty state is rendered as an honest statement of that
 * ambiguity, never as "all reviewed". `approval audit list` resolves it.
 */
function auditBacklog(records: EventRecord[]): AuditItem[] {
  const subjectOf = (record: EventRecord): { key: string | null; task: string | null } => {
    const payload = payloadOf(record);
    const key =
      typeof record.action_key === "string"
        ? record.action_key
        : typeof payload["action_key"] === "string"
          ? (payload["action_key"] as string)
          : null;
    const task =
      typeof record.task === "string"
        ? record.task
        : typeof payload["task"] === "string"
          ? (payload["task"] as string)
          : null;
    return { key, task };
  };

  const backlog: AuditItem[] = [];
  for (const record of records) {
    if (record.event !== "audit.sampled") continue;
    const subject = subjectOf(record);
    const reviewed = records.some((other) => {
      if (other.event !== "audit.reviewed" || other.seq <= record.seq) return false;
      const theirs = subjectOf(other);
      if (subject.key !== null && theirs.key !== null) return subject.key === theirs.key;
      if (subject.task !== null && theirs.task !== null) return subject.task === theirs.task;
      return false;
    });
    if (reviewed) continue;
    backlog.push({
      seq: record.seq,
      ts: record.ts,
      actor: record.actor,
      task: subject.task,
      actionKey: subject.key,
    });
  }
  return backlog;
}

// ---------------------------------------------------------------------------
// renderQueue
// ---------------------------------------------------------------------------

const HEADER = [
  "<!--",
  "  GENERATED FILE — DO NOT EDIT.",
  "",
  "  This is `.approval/QUEUE.md`, the queue projection of SPEC.md §9.1: a",
  "  rendered, READ-ONLY markdown view of pending requests plus the sampled-audit",
  "  backlog, regenerated WHOLE on every relevant event. \"This is the screenshot;",
  "  it is never the truth.\"",
  "",
  "  The truth is `.approval/log/events.jsonl`, the append-only hash-chained event",
  "  log. Editing this file changes nothing, authorizes nothing, and will be",
  "  overwritten by the next `approval render`. To approve or reject something,",
  "  use a decision surface: `approval grant|reject <action-key>`, or a channel.",
  "-->",
].join("\n");

function headerSection(now: string, head: LogHead | null): string[] {
  return [
    HEADER,
    "",
    "# Approval queue (generated — read only)",
    "",
    `> **Do not edit this file.** It is a projection of the append-only log, regenerated whole by \`approval render\`. The log is the truth (SPEC.md §9.1); this is the screenshot.`,
    "",
    `- **Evaluated at** (the \`now\` handed to the renderer, not an ambient clock): ${span(now)}`,
    `- **Derived from log head**: ${
      head === null ? "_empty log_" : `seq ${String(head.seq)} ${span(head.hash)}`
    }`,
    "- **Full payloads are not in this file.** The queue is a summary surface and collects no decision. It carries the content binding (`payload_hash`) only; the full payload is presented by the decision channels before a decision is collected, as SPEC.md §10.4 requires.",
    "",
  ];
}

/**
 * Render the queue.
 *
 * Deterministic in the strong sense: for a fixed log, policy and `now`, the
 * returned string is byte-identical across processes and machines. Nothing here
 * reads a clock, a locale, an environment variable, or a hostname.
 *
 * Expiry is not this module's judgment: `channels/tagging.ts` derives state
 * through `core/state.ts` with the policy TTL and the same `now`, so a request
 * whose TTL has elapsed is `expired`, not `requested`, and never reaches the
 * pending section. The countdown a reader sees therefore never reaches zero on
 * a listed entry.
 *
 * The verified read happens twice — once here for the head and the audit
 * records, once inside {@link buildPendingQueue} — which is a deliberate trade:
 * a second walk of the chain costs a few milliseconds on a rendering path, and
 * the alternative is widening the tagger's public result to carry records it
 * has no other reason to expose.
 */
export function renderQueue(
  logPath: string,
  options: RenderQueueOptions,
  now: string,
): RenderQueueResult {
  const read = readVerifiedRecords(
    logPath,
    options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir },
  );
  if (!read.ok) return refuse(read.code, read.message);

  const queue = buildPendingQueue(logPath, options, now);
  if (!queue.ok) {
    // Only the three log codes can reach here: every other tagger refusal is
    // per-request and lands in `skipped`.
    const code: RenderQueueRefusalCode = isLogCode(queue.code)
      ? (queue.code as RenderQueueRefusalCode)
      : "log-corrupt";
    return refuse(code, queue.message);
  }

  const backlog = auditBacklog(read.records);
  const lines: string[] = [...headerSection(now, read.head)];

  lines.push("## Pending requests awaiting a human decision");
  lines.push("");
  if (queue.requests.length === 0) {
    lines.push("_Nothing is awaiting a decision._ No action key has a live `approval.requested` at this instant.");
    lines.push("");
  } else {
    lines.push(
      `${String(queue.requests.length)} request(s), oldest first (log order).`,
    );
    lines.push("");
    for (const [index, request] of queue.requests.entries()) {
      lines.push(...renderRequest(index + 1, request));
    }
  }

  lines.push(...renderSkipped(queue.skipped));
  lines.push(...renderAudit(backlog));
  lines.push(...footer(read.head, logPath));

  return {
    ok: true,
    markdown: `${lines.join("\n")}\n`,
    head: read.head,
    pending: queue.requests.length,
    skipped: queue.skipped.length,
    auditBacklog: backlog.length,
  };
}

/**
 * Is this tagger refusal one of the whole-log codes?
 *
 * The tagger's other codes are per-request and land in `skipped`; only these
 * three can refuse an entire render, and they are passed through verbatim so a
 * corrupt log is reported as corruption by every layer with one vocabulary.
 */
function isLogCode(code: ChannelTagRefusalCode): boolean {
  return code === "log-unreadable" || code === "log-torn-tail" || code === "log-corrupt";
}

function renderSkipped(skipped: SkippedRequest[]): string[] {
  const lines = ["## Live requests this render could not summarize", ""];
  if (skipped.length === 0) {
    lines.push("_None._ Every live request above is rendered in full.");
    lines.push("");
    return lines;
  }
  lines.push(
    "These action keys have a live `approval.requested` that the renderer could not tag. They are listed rather than dropped: a request missing from a queue is a request nobody will answer.",
  );
  lines.push("");
  for (const entry of skipped) {
    lines.push(`- ${span(entry.action_key)} — \`${entry.code}\`: ${span(entry.message)}`);
  }
  lines.push("");
  return lines;
}

function renderAudit(backlog: AuditItem[]): string[] {
  const lines = ["## Sampled-audit backlog", ""];
  if (backlog.length === 0) {
    lines.push(
      "_Empty._ No `audit.sampled` event in this log is waiting for an `audit.reviewed`. Note what this does and does not say. The daemon samples supervised executions (SPEC.md §5.2) only when the operator's HMAC secret is configured, so an empty backlog means either **everything sampled has been reviewed** or **nothing was sampled**, and this file cannot tell you which. Run `approval audit list` for the answer: it reports whether sampling is running, and why not when it is not.",
    );
    lines.push("");
    return lines;
  }
  lines.push(
    `${String(backlog.length)} sampled action(s) with no later \`audit.reviewed\`, oldest first.`,
  );
  lines.push("");
  for (const item of backlog) {
    lines.push(
      `- seq ${String(item.seq)} — computed · log: sampled at ${span(item.ts)} by ${span(
        item.actor,
      )}, task ${optionalSpan(item.task)}, action ${optionalSpan(item.actionKey)}`,
    );
  }
  lines.push("");
  return lines;
}

function footer(head: LogHead | null, logPath: string): string[] {
  return [
    "---",
    "",
    `Rendered from ${span(logPath)} at log head ${
      head === null ? "_empty log_" : `seq ${String(head.seq)}, hash ${span(head.hash)}`
    }. Every fact above is reproducible from that log: re-running \`approval render\` against the same head with the same evaluation instant produces this file byte for byte. If this file disagrees with the log, the log is right.`,
  ];
}

// ---------------------------------------------------------------------------
// writeQueue
// ---------------------------------------------------------------------------

/** Distinguishes concurrent renders' temp files within one process. */
let tempCounter = 0;

/**
 * Render and write `.approval/QUEUE.md` atomically.
 *
 * Temp file in the destination directory, `fsync`, then `rename` — a reader
 * either sees the previous complete rendering or the new one, never a half-
 * written queue. The temp name is the only non-deterministic byte anywhere in
 * this module and it never reaches the file's contents; it is removed on every
 * failure path, so a failed render leaves no debris beside the queue.
 *
 * Writes this one file and nothing else. In particular it does not touch the
 * log: the log is opened read-only by the verified read and is not reopened
 * here.
 */
export function writeQueue(
  logPath: string,
  queuePath: string,
  options: RenderQueueOptions,
  now: string,
): WriteQueueResult {
  const rendered = renderQueue(logPath, options, now);
  if (!rendered.ok) return rendered;

  const directory = dirname(queuePath);
  tempCounter += 1;
  const temp = join(
    directory,
    `.${queuePath.split(/[\\/]/u).pop() ?? "QUEUE.md"}.tmp-${String(process.pid)}-${String(tempCounter)}`,
  );

  const bytes = Buffer.byteLength(rendered.markdown, "utf8");
  try {
    mkdirSync(directory, { recursive: true });
    const handle = openSync(temp, "wx");
    try {
      writeSync(handle, rendered.markdown, 0, "utf8");
    } finally {
      closeSync(handle);
    }
    renameSync(temp, queuePath);
  } catch (cause) {
    try {
      unlinkSync(temp);
    } catch {
      // The temp file may never have been created; nothing to clean up.
    }
    return refuse(
      "write-failed",
      `queue ${queuePath} could not be written: ${
        cause instanceof Error ? cause.message : String(cause)
      }. Nothing was written and the log was not touched.`,
    );
  }

  return {
    ok: true,
    path: queuePath,
    bytes,
    head: rendered.head,
    pending: rendered.pending,
    skipped: rendered.skipped,
    auditBacklog: rendered.auditBacklog,
  };
}
