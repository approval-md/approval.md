/**
 * The local web queue channel (SPEC.md §5.1 `channels.web.port`, §9, §10.3,
 * §10.4, §11 — APRV-25).
 *
 * The third reference channel, and the only *pull* one. `cli` asks a question
 * and waits for an answer; `telegram` pushes a message at a human who is
 * elsewhere. This one serves a page: the queue sits at
 * `http://127.0.0.1:4680/` and a human looks at it when they choose to. That
 * difference is the design, not an accident of the transport — see "notify is a
 * no-op" below.
 *
 * Everything the contract says about a channel still holds:
 *
 * - **It decides nothing.** A submitted form becomes a {@link ChannelDecision}
 *   handed to the handler the runtime registered, and that handler calls
 *   `recordChannelDecision` / `recordBatchDecisions`, which call the human-only
 *   `decide()` in `core/gate.ts`. TTL lapse, budget re-check, attestation,
 *   idempotency and compare-and-append apply to a button on a web page exactly
 *   as they apply to `approval grant`.
 * - **It writes no log line and holds no decision state.** The only memory here
 *   is the map from action key to delivery id, which is delivery bookkeeping.
 *   It dies with the process; the approvals live in the log.
 * - **It renders the computed/claimed split** (§9) and the full payload for
 *   manual actions (§10.4), and reports what it rendered through
 *   {@link WebChannel.lastRendered} so `channels/conformance.ts` can check it.
 *
 * ## 127.0.0.1 ONLY, and there is deliberately no --host
 *
 * {@link WebChannel.start} calls `listen(port, "127.0.0.1")` with the host
 * **hard-coded**. There is no option, no flag and no environment variable that
 * widens it, and adding one would be a SPEC.md amendment rather than a feature:
 * this server has **no authentication at all** (see below), so the loopback
 * interface is the entire access-control mechanism. A `--host 0.0.0.0` would
 * turn "anyone with local access can approve" into "anyone on the coffee shop
 * wifi can approve", silently, from a flag that reads like a convenience. The
 * bound address is asserted by `tests/channels-web.test.ts`.
 *
 * ## No auth in v0.1 — the trust boundary, stated twice
 *
 * SPEC.md §11: *"Human identity in v0.1 is config-declared (an environment
 * variable or flag); the trust boundary is the local machine, and anyone who
 * can set that configuration and write to the log is inside it."*
 *
 * This channel authenticates nobody. Every decision it collects is recorded
 * against the human actor the **runtime** was started with (`--as` /
 * `APPROVAL_HUMAN`), so the guarantee is "someone with access to this machine
 * approved", never "that specific person approved". Because the page *is* the
 * decision surface, that caveat is printed on the page itself
 * ({@link TRUST_BANNER}) as well as in `--help` and here: a human reading a
 * queue in a browser tab should not have to have read the source to know what
 * their click proves.
 *
 * ## CSRF — inside the stated boundary, with cheap hardening. FLAGGED.
 *
 * There is no CSRF token in v0.1, and the reasoning is worth writing down
 * because it is a deliberate omission rather than an oversight. A CSRF token
 * defends a *session* — it stops a page on another origin from acting as an
 * authenticated user. Here there is no session and no authentication: anything
 * that can open a socket to 127.0.0.1:4680 can already POST directly, token or
 * no token, because the trust boundary is the whole local machine. A token
 * would defend against exactly one attacker: a web page, in a browser on this
 * machine, that the human visited, that guessed the port. That attacker is
 * inside the §11 boundary as written — and is also the most realistic one, so:
 *
 * - A same-origin **soft check** rejects (403) any POST whose `Origin` (or
 *   failing that, `Referer`) names something other than this server's own
 *   loopback origins. It is best effort: a request with neither header is
 *   allowed, because `curl`, `fetch` in a test, and a form POST from an older
 *   browser all send neither, and refusing them would break the documented
 *   scripting path to buy nothing (an attacker can omit a header too).
 * - **Flagged for human review**: if v0.2 puts this server behind anything
 *   resembling a session, or widens the bind address, this stance must be
 *   revisited and a real anti-CSRF token added. The soft check is a speed bump,
 *   not a control.
 *
 * ## The token IS shown on the page — FLAGGED, and it differs from telegram
 *
 * `channels/telegram.ts` refuses to put an execution token in the chat, and
 * prints it on the listener's stdout instead: a chat transcript lives on
 * someone else's servers and is readable by anyone later added to the chat.
 * This channel does the opposite and shows the raw token **once**, in the
 * response page for the grant that minted it. The asymmetry is the point:
 *
 * - the page is served over loopback to the human who is deciding, right now;
 * - the response is generated per request and persisted nowhere — no file, no
 *   log line, no `lastRendered()` entry (the notice is rendered and dropped);
 * - the alternative is worse. On telegram the approver and the terminal are
 *   often the same person one room apart; here the browser *is* the surface the
 *   human is looking at, and sending them to hunt for a token on a daemon's
 *   stdout would push them toward copying tokens out of log files.
 *
 * The token is never written to the log (which holds only its SHA-256), never
 * put in a URL (a query string lands in history), and never repeated: reload
 * the response and it is gone. The channel itself does not even hold it — the
 * runtime returns the notice text through {@link WebChannelOptions.decisionNotice}
 * at render time, so a channel that logged its own outcomes would log nothing
 * sensitive. **Flagged for human review** all the same: it is the one place in
 * this codebase where a credential is rendered into a document a browser
 * handles, and browsers cache, autofill and sync more than one expects.
 *
 * ## notify() is a no-op — pull, not push
 *
 * The queue *is* the notification surface. `notify()` records the request as
 * deliverable (so a decision can be routed back to it), returns a synthetic
 * delivery id, and sends nothing anywhere: there is nowhere to send it, since a
 * web page is fetched rather than delivered. Everything the human sees is
 * produced by `GET /`, which re-renders from the runtime's live queue
 * ({@link WebChannelOptions.refresh}) whenever one is supplied. This is why
 * `lastRendered()` reflects the most recent *render* — a GET when there has
 * been one, the last `notify()` otherwise — and why both go through the same
 * {@link renderWebRequest}: the conformance suite must be inspecting the thing a
 * browser was actually served.
 *
 * ## Zero JavaScript required
 *
 * Every flow — grant, reject with a note, select-and-batch — is plain
 * `<form method="post" enctype="application/x-www-form-urlencoded">`. The batch
 * checkboxes live outside the batch form and are attached to it with the HTML5
 * `form=` attribute (nested forms are illegal), so one page can carry per-request
 * forms *and* a batch gesture with no script at all. A four-line inline script
 * offers "select all" as a convenience; disable scripting and every flow still
 * works, which is checked by the tests driving the server with `fetch` alone.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { BudgetVerdict } from "../core/budgets.js";
import { assembleBatch, type BatchRefusal } from "./batch.js";
import type {
  ChannelBatch,
  ChannelDecision,
  ChannelHealth,
  ChannelRequest,
  DecisionOutcome,
  DeliveryId,
  RenderedField,
  RenderedRequest,
  TaggedField,
  TestableChannel,
} from "./contract.js";
import { payloadRegionText } from "./payload-view.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** SPEC.md §5.1 `channels.web.port`. Used when policy and flags say nothing. */
export const WEB_DEFAULT_PORT = 4680;

/**
 * The only address this server ever binds. Hard-coded; see the module header.
 *
 * Exported so the tests can assert the bound address against a constant rather
 * than a literal they could drift from — not so a caller can substitute one.
 */
export const WEB_LOOPBACK_HOST = "127.0.0.1";

/** The largest form body accepted. A queue page's POST is a few hundred bytes. */
export const WEB_MAX_BODY_BYTES = 256 * 1024;

/** The §11 caveat, rendered at the top of every page. */
export const TRUST_BANNER =
  "TRUST BOUNDARY — this page has NO AUTHENTICATION. It is served on 127.0.0.1 only, " +
  "and anyone with access to this machine can decide here as the configured actor. " +
  "A decision recorded from this page proves that someone with local control answered, " +
  "not who. (SPEC.md §11: identity in v0.1 is config-declared.)";

/** The full-payload delimiters (SPEC.md §10.4). Pinned by tests. */
export const PAYLOAD_BEGIN = "--- BEGIN FULL PAYLOAD";
export const PAYLOAD_END = "--- END FULL PAYLOAD ---";

/** Section headings. The computed/claimed split a reader must not have to infer. */
export const COMPUTED_HEADING =
  "COMPUTED — derived by the runtime from the verified log, the attested policy, the budget evaluator, the payload bytes and the clock";
export const CLAIMED_HEADING_PREFIX = "CLAIMED — authored by";
export const CLAIMED_HEADING_SUFFIX = "NOT verified by the runtime";

/** Badge markers, mirroring `channels/cli.ts` so the two channels read alike. */
export const COMPUTED_MARKER = "[computed]";
export const CLAIMED_MARKER = "[claimed]";

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/**
 * Escape every character that could change the structure of the document.
 *
 * A superset of `channels/telegram.ts`'s three: this channel interpolates into
 * HTML **attribute** positions (checkbox values carry action keys, form ids
 * carry them too), where a bare quote is as dangerous as a bare `<`. Applied
 * uniformly to every interpolated value without exception — the claimed fields
 * and the payload are authored by the party under oversight, and they are the
 * entire injection surface of this page.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

/** A DOM id that cannot escape its attribute, derived from an action key. */
function slug(actionKey: string, index: number): string {
  return `r${index}-${actionKey.replace(/[^A-Za-z0-9_-]/gu, "-")}`;
}

// ---------------------------------------------------------------------------
// Value formatting (mirrors channels/cli.ts, deliberately)
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  if (ms <= 0) return "EXPIRED";
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m left`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s left`;
  return `${seconds}s left`;
}

function formatBudgets(verdicts: BudgetVerdict[]): string {
  if (verdicts.length === 0) return "none configured";
  return verdicts
    .map(
      (verdict) =>
        `${verdict.limit} ${verdict.pass ? "pass" : "FAIL"} (consumed ${verdict.consumed}, requested ${verdict.requested}, remaining ${verdict.remaining}, ${verdict.window})`,
    )
    .join("; ");
}

/**
 * One field's value as display text. Deliberately total: an unrecognized shape
 * is JSON-stringified rather than dropped, because a field the runtime tagged
 * and the channel silently omitted is a field the approver did not see.
 */
export function formatValue(field: string, value: unknown): string {
  if (value === null || value === undefined) return "(none)";
  if (field === "ttl_remaining_ms" && typeof value === "number") return formatDuration(value);
  if (field === "budgets" && Array.isArray(value)) return formatBudgets(value as BudgetVerdict[]);
  if (field === "attestation" && typeof value === "object") {
    const status = (value as { status?: unknown; seq?: unknown; message?: unknown }).status;
    const seq = (value as { seq?: unknown }).seq;
    if (status === "attested") return `attested (policy.updated seq ${String(seq)})`;
    if (status === "not-attested") {
      return "NOT ATTESTED — no human has signed off on this policy file";
    }
    if (status === "hash-mismatch") {
      return `HASH MISMATCH — the policy file changed since attestation seq ${String(seq)}`;
    }
    return `UNREADABLE — ${String((value as { message?: unknown }).message)}`;
  }
  if (field === "chain" && typeof value === "object") {
    const chain = value as { seq?: unknown; hash?: unknown; head_seq?: unknown };
    return `seq ${String(chain.seq)} hash ${String(chain.hash)} (log head seq ${String(chain.head_seq)})`;
  }
  if (field === "est_cost_usd" && typeof value === "number") return `$${value.toFixed(2)}`;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value) ?? String(value);
}

/** The parenthetical: which derivation, or which author. */
function attribution(field: TaggedField<unknown>): string {
  return field.kind === "computed" ? field.source : field.author;
}

/**
 * Presentation order. Computed identity and authority first, claimed persuasion
 * last. Members absent from a request are skipped; members present but unlisted
 * are appended, so a widened {@link ChannelRequest} cannot silently lose a field.
 */
const FIELD_ORDER: string[] = [
  "action_key",
  "task",
  "class",
  "protected_path",
  "autonomy",
  "provenance",
  "state",
  "requested_ts",
  "waiting",
  "ttl_remaining_ms",
  "payload_hash",
  "attestation",
  "budgets",
  "chain",
  "est_cost_usd",
  "summary",
  "rationale",
  "confidence",
];

function orderedFields(request: ChannelRequest): string[] {
  const members = Object.keys(request as unknown as Record<string, unknown>);
  const ordered = FIELD_ORDER.filter((name) => members.includes(name));
  for (const name of members) if (!ordered.includes(name)) ordered.push(name);
  return ordered;
}

// ---------------------------------------------------------------------------
// Rendering one request
// ---------------------------------------------------------------------------

/** One rendered line, and the request member it came from. */
export interface WebLine {
  field: string;
  kind: "computed" | "claimed";
  text: string;
  origin: string;
}

/** The rendering split for one request; the HTML below is built from exactly this. */
export interface WebRendering {
  actionKey: string;
  computed: WebLine[];
  claimed: WebLine[];
  /** The claimed author, for the section heading. */
  author: string;
  /** The delimited payload region, or `null` when the request carries none. */
  payloadText: string | null;
}

/** Build the split. Pure: no I/O, no clock, no HTML. */
export function renderWebRequest(request: ChannelRequest): WebRendering {
  const members = request as unknown as Record<string, TaggedField<unknown> | undefined>;
  const computedLines: WebLine[] = [];
  const claimedLines: WebLine[] = [];

  for (const name of orderedFields(request)) {
    const field = members[name];
    if (field === undefined) continue;
    // `fullPayload` has a region of its own (§10.4), rendered verbatim inside
    // delimiters below. Emitting it as a field line too would print the payload
    // twice — once as bytes and once as a JSON blob squeezed into a summary
    // line — and the squeezed copy is where an agent's markup would end up
    // sitting in the computed block, which is precisely the authority §9
    // forbids lending it.
    if (name === "fullPayload") continue;
    const line: WebLine = {
      field: name,
      kind: field.kind,
      text: formatValue(name, field.value),
      origin: attribution(field),
    };
    if (field.kind === "computed") computedLines.push(line);
    else claimedLines.push(line);
  }

  const rendering = request.fullPayload.value;
  const payloadText =
    rendering === null
      ? null
      : [
          `${PAYLOAD_BEGIN} (bound sha256 ${rendering.hash}) ---`,
          payloadRegionText(rendering),
          PAYLOAD_END,
          ...(rendering.truncated
            ? ["(TRUNCATED — this is not the whole payload; do not grant on it)"]
            : []),
        ].join("\n");

  return {
    actionKey: request.action_key.value,
    computed: computedLines,
    claimed: claimedLines,
    author: request.summary.kind === "claimed" ? request.summary.author : "the requesting party",
    payloadText,
  };
}

/** The {@link RenderedRequest} report for the conformance suite. */
function reportOf(rendering: WebRendering, batchDeliveryId?: DeliveryId): RenderedRequest {
  const fields: RenderedField[] = [...rendering.computed, ...rendering.claimed].map((line) => ({
    field: line.field,
    kind: line.kind,
    text: line.text,
  }));
  return {
    action_key: rendering.actionKey,
    fields,
    fullPayloadText: rendering.payloadText,
    ...(batchDeliveryId === undefined ? {} : { batchDeliveryId }),
  };
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

/**
 * The stylesheet, inline — a queue page that needed a second request to make
 * the computed/claimed split visible would show an unstyled, indistinguishable
 * page for the duration of that request.
 *
 * Colour is never the only carrier: every claimed line also has the textual
 * `[claimed]` marker and sits under its own heading, so the split survives a
 * monochrome screen, a screen reader and a "reader mode".
 */
const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; padding: 1.5rem; }
  h1 { font-size: 1.1rem; margin: 0 0 .5rem; }
  h2 { font-size: 1rem; margin: 0 0 .25rem; }
  h3 { font-size: .85rem; margin: 1rem 0 .25rem; letter-spacing: .02em; }
  .banner { border: 2px solid #b45309; background: #fffbeb; color: #7c2d12; padding: .75rem; margin-bottom: 1rem; }
  .error { border: 2px solid #b91c1c; background: #fef2f2; color: #7f1d1d; padding: .75rem; margin-bottom: 1rem; }
  .notice { border: 2px dashed #15803d; background: #f0fdf4; color: #14532d; padding: .75rem; margin: .75rem 0; }
  article { border: 1px solid #9ca3af; padding: 1rem; margin-bottom: 1.5rem; }
  .computed { border-left: 4px solid #1d4ed8; padding-left: .75rem; }
  .claimed { border-left: 4px dashed #b45309; padding-left: .75rem; background: #fff7ed; }
  .line { display: block; white-space: pre-wrap; }
  .marker { font-weight: 700; }
  .name { display: inline-block; min-width: 11rem; }
  .origin { opacity: .75; }
  pre.payload { white-space: pre-wrap; word-break: break-all; border: 1px solid #374151; background: #f9fafb; color: #111827; padding: .75rem; }
  form { display: inline-block; margin-right: 1rem; }
  input[type=text] { font: inherit; min-width: 18rem; }
  button { font: inherit; padding: .25rem .75rem; }
  code { word-break: break-all; }
  @media (prefers-color-scheme: dark) {
    body { background: #0b0f14; color: #e5e7eb; }
    .banner { background: #3f2d10; color: #fde68a; }
    .error { background: #3f1214; color: #fecaca; }
    .notice { background: #052e16; color: #bbf7d0; }
    .claimed { background: #221708; }
    pre.payload { background: #111827; color: #e5e7eb; border-color: #6b7280; }
  }
`;

/** The optional convenience script. Every flow works without it — see the header. */
const SELECT_ALL_SCRIPT = `
  document.querySelectorAll('[data-select-all]').forEach(function (box) {
    box.addEventListener('change', function () {
      document.querySelectorAll('input[name="select"]').forEach(function (item) {
        item.checked = box.checked;
      });
    });
  });
`;

function lineHtml(line: WebLine): string {
  const marker = line.kind === "computed" ? COMPUTED_MARKER : CLAIMED_MARKER;
  return (
    `<span class="line"><span class="marker">${escapeHtml(marker)}</span> ` +
    `<span class="name">${escapeHtml(line.field)}</span> ` +
    `${escapeHtml(line.text)} <span class="origin">(${escapeHtml(line.origin)})</span></span>`
  );
}

function requestHtml(rendering: WebRendering, index: number): string {
  const key = rendering.actionKey;
  const id = slug(key, index);
  const parts: string[] = [
    `<article id="${escapeHtml(id)}">`,
    `<h2><code>${escapeHtml(key)}</code></h2>`,
    `<label><input type="checkbox" name="select" value="${escapeHtml(key)}" form="batch-form"> include in batch gesture</label>`,
    `<h3>${escapeHtml(COMPUTED_HEADING)}</h3>`,
    `<div class="computed">${rendering.computed.map(lineHtml).join("")}</div>`,
    `<h3>${escapeHtml(`${CLAIMED_HEADING_PREFIX} ${rendering.author} — ${CLAIMED_HEADING_SUFFIX}`)}</h3>`,
    `<div class="claimed">${rendering.claimed.map(lineHtml).join("")}</div>`,
  ];

  if (rendering.payloadText !== null) {
    parts.push(
      "<h3>FULL PAYLOAD — the exact bytes this approval binds to (SPEC.md §10.4)</h3>",
      `<pre class="payload">${escapeHtml(rendering.payloadText)}</pre>`,
    );
  }

  parts.push(
    "<h3>DECIDE</h3>",
    `<form method="post" action="/decide">`,
    `<input type="hidden" name="action_key" value="${escapeHtml(key)}">`,
    `<input type="hidden" name="decision" value="grant">`,
    `<label>note (optional) <input type="text" name="note"></label> `,
    `<button type="submit">Grant</button>`,
    "</form>",
    `<form method="post" action="/decide">`,
    `<input type="hidden" name="action_key" value="${escapeHtml(key)}">`,
    `<input type="hidden" name="decision" value="reject">`,
    `<label>note (REQUIRED — say why) <input type="text" name="note" required></label> `,
    `<button type="submit">Reject</button>`,
    "</form>",
    "</article>",
  );
  return parts.join("\n");
}

function page(title: string, body: string): string {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLE}</style>`,
    "</head><body>",
    `<h1>${escapeHtml(title)}</h1>`,
    `<div class="banner">${escapeHtml(TRUST_BANNER)}</div>`,
    body,
    `<script>${SELECT_ALL_SCRIPT}</script>`,
    "</body></html>",
  ].join("\n");
}

/** What the page says about the identity decisions are recorded against. */
function actorLine(actorLabel: string | null): string {
  if (actorLabel === null) return "";
  return `<p>Decisions recorded here are attributed to <code>${escapeHtml(actorLabel)}</code> — the actor this runtime was configured with, not the person at this browser.</p>`;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * The runtime's per-decision notice: text shown ONCE on the response page and
 * kept nowhere.
 *
 * This is how a grant's raw execution token reaches the human without the
 * channel ever holding it: `recordChannelDecision` returns the token to the
 * *runtime*, the runtime returns this string at render time, the channel
 * escapes it into one response and forgets it. It is not stored, not repeated
 * on the next GET, and never included in {@link WebChannel.lastRendered}.
 */
export type WebDecisionNotice = (
  decision: ChannelDecision,
  outcome: DecisionOutcome,
) => string | null | undefined;

/** One batch member's result, as the runtime reports it back to the channel. */
export interface WebBatchOutcome {
  action_key: string;
  outcome: DecisionOutcome;
  /** Shown once on the response page (the token). Never stored. */
  notice?: string;
}

/**
 * The runtime's batch recorder. Registered with
 * {@link WebChannel.onBatchDecision}; its body is a call to
 * `channels/batch.ts`'s `recordBatchDecisions`, which is one `decide()` per
 * member. When no batch handler is registered the channel falls back to the
 * unit handler once per member with `batchDeliveryId` set — identical
 * semantics, since `recordChannelDecision` encodes the id the same way.
 */
export type WebBatchHandler = (
  decisions: ChannelDecision[],
  batchDeliveryId: DeliveryId,
) => WebBatchOutcome[] | Promise<WebBatchOutcome[]>;

export interface WebChannelOptions {
  /** Port to bind. `0` asks the OS for an ephemeral one (tests). */
  port?: number;
  /** Channel name recorded for audit. Defaults to `web`. */
  name?: string;
  /**
   * The runtime's live pending queue, re-read on every GET.
   *
   * Optional: without it the page shows whatever was `notify`d. With it the
   * page is a projection of the log as of the moment it was fetched, which is
   * what makes a decided request disappear from the queue on the next reload.
   * The channel never reads the log itself — this function belongs to the
   * runtime, which is the only thing allowed to.
   */
  refresh?: () => ChannelRequest[];
  /** Per-decision one-shot notice (the execution token). See {@link WebDecisionNotice}. */
  decisionNotice?: WebDecisionNotice;
  /** The configured approver, for display only. Never used to authorize. */
  actorLabel?: string;
  /** Where operational complaints go. Defaults to stderr. */
  log?: (message: string) => void;
}

/** Delivery and traffic counters. Never decision state. */
export interface WebStats {
  /** Requests registered by `notify`. */
  notified: number;
  /** `GET /` renders served. */
  views: number;
  /** Gestures handed to the runtime's handler. */
  decisions: number;
  /** POSTs refused before the handler: bad form, missing note, cross-origin. */
  refused: number;
}

/** One delivered request, as this process remembers it. Never a decision. */
interface Delivery {
  deliveryId: DeliveryId;
  batchDeliveryId?: DeliveryId;
}

// ---------------------------------------------------------------------------
// The channel
// ---------------------------------------------------------------------------

export class WebChannel implements TestableChannel {
  readonly name: string;

  private readonly configuredPort: number;
  private readonly refresh: (() => ChannelRequest[]) | null;
  private readonly notice: WebDecisionNotice | null;
  private readonly actorLabel: string | null;
  private readonly complain: (message: string) => void;

  private handler: ((decision: ChannelDecision) => DecisionOutcome) | null = null;
  private batchHandler: WebBatchHandler | null = null;

  /** Everything ever delivered, by action key. Delivery bookkeeping only. */
  private readonly deliveries = new Map<string, Delivery>();
  /** What the last render showed, in order. */
  private pending: ChannelRequest[] = [];
  private rendered: RenderedRequest[] = [];

  private httpServer: Server | null = null;
  private counter = 0;
  private readonly counters: WebStats = { notified: 0, views: 0, decisions: 0, refused: 0 };

  constructor(options: WebChannelOptions = {}) {
    this.name = options.name ?? "web";
    this.configuredPort = options.port ?? WEB_DEFAULT_PORT;
    this.refresh = options.refresh ?? null;
    this.notice = options.decisionNotice ?? null;
    this.actorLabel = options.actorLabel ?? null;
    this.complain =
      options.log ??
      ((message: string) => {
        process.stderr.write(`${message}\n`);
      });
  }

  // -------------------------------------------------------------------------
  // Channel
  // -------------------------------------------------------------------------

  /**
   * Register a request (or a batch) as deliverable and return its delivery id.
   *
   * Sends nothing: the queue page is pulled, not pushed (see the module
   * header). The rendering split is computed here anyway, so `lastRendered()`
   * is meaningful before anyone has opened a browser — and it is computed by
   * the same {@link renderWebRequest} that produces the served HTML.
   */
  notify(target: ChannelRequest | ChannelBatch): DeliveryId {
    const isBatch = "requests" in target;
    const members = isBatch ? target.requests : [target];
    this.counter += 1;
    const deliveryId = isBatch ? `web-batch-${this.counter}` : `web-${this.counter}`;

    for (const member of members) {
      this.deliveries.set(member.action_key.value, {
        deliveryId,
        ...(isBatch ? { batchDeliveryId: deliveryId } : {}),
      });
      this.counters.notified += 1;
    }

    this.pending = members;
    this.rendered = members.map((member) =>
      reportOf(renderWebRequest(member), isBatch ? deliveryId : undefined),
    );
    return deliveryId;
  }

  onDecision(handler: (decision: ChannelDecision) => DecisionOutcome): void {
    this.handler = handler;
  }

  /** Register the runtime's batch recorder. Optional; see {@link WebBatchHandler}. */
  onBatchDecision(handler: WebBatchHandler): void {
    this.batchHandler = handler;
  }

  health(): ChannelHealth {
    const address = this.address();
    if (address === null) {
      return { ok: false, detail: `not listening (configured port ${this.configuredPort})` };
    }
    return {
      ok: true,
      detail:
        `listening on http://${address.address}:${address.port}/ (loopback only); ` +
        `${this.counters.views} page view(s), ${this.counters.notified} request(s) delivered, ` +
        `${this.counters.decisions} decision(s), ${this.counters.refused} refused POST(s)`,
    };
  }

  /** The most recent rendering — a GET when there has been one, else `notify`. */
  lastRendered(): RenderedRequest[] {
    return this.rendered;
  }

  stats(): WebStats {
    return { ...this.counters };
  }

  /** The bound address, or `null` when the server is not listening. */
  address(): AddressInfo | null {
    const address = this.httpServer?.address() ?? null;
    return address === null || typeof address === "string" ? null : address;
  }

  /** The bound port, or the configured one before {@link start}. */
  get port(): number {
    return this.address()?.port ?? this.configuredPort;
  }

  /** The underlying server, for tests that assert on the socket itself. */
  get server(): Server | null {
    return this.httpServer;
  }

  /** The page's own origin, as a browser would send it. */
  get origin(): string {
    return `http://${WEB_LOOPBACK_HOST}:${this.port}`;
  }

  // -------------------------------------------------------------------------
  // The server
  // -------------------------------------------------------------------------

  /**
   * Bind and serve — on `127.0.0.1` and nowhere else.
   *
   * The host argument is a constant. See the module header for why there is
   * deliberately no option to widen it.
   */
  start(): Promise<AddressInfo> {
    if (this.httpServer !== null) {
      const address = this.address();
      if (address !== null) return Promise.resolve(address);
    }
    const server = createServer((request, response) => {
      void this.handle(request, response).catch((cause: unknown) => {
        this.complain(
          `approval: web channel failed to handle a request: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        );
        if (!response.headersSent) {
          this.send(response, 500, page("approval.md — error", "<p>internal error</p>"));
        } else response.end();
      });
    });
    this.httpServer = server;

    return new Promise<AddressInfo>((resolve, reject) => {
      const onError = (cause: Error): void => {
        server.off("error", onError);
        reject(cause);
      };
      server.on("error", onError);
      server.listen(this.configuredPort, WEB_LOOPBACK_HOST, () => {
        server.off("error", onError);
        const address = this.address();
        if (address === null) reject(new Error("the web channel bound no address"));
        else resolve(address);
      });
    });
  }

  /** Stop listening. Safe when never started. */
  close(): Promise<void> {
    const server = this.httpServer;
    if (server === null) return Promise.resolve();
    this.httpServer = null;
    return new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  }

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? "/").split("?", 1)[0] ?? "/";

    if (request.method === "GET" && (path === "/" || path === "/index.html")) {
      this.counters.views += 1;
      this.send(response, 200, this.queuePage());
      return;
    }

    if (request.method === "POST" && (path === "/decide" || path === "/decide-batch")) {
      const origin = this.checkOrigin(request);
      if (origin !== null) {
        this.counters.refused += 1;
        this.complain(`approval: web channel refused a cross-origin POST (${origin})`);
        this.send(
          response,
          403,
          page(
            "approval.md — refused",
            `<div class="error">${escapeHtml(
              `Refused: this POST came from ${origin}, not from this page. Nothing was recorded. (Best-effort same-origin check; see SPEC.md §11 for the trust boundary this server actually relies on.)`,
            )}</div>`,
          ),
        );
        return;
      }

      const body = await this.readBody(request);
      if (!body.ok) {
        this.counters.refused += 1;
        this.send(
          response,
          413,
          page("approval.md — refused", `<div class="error">${escapeHtml(body.message)}</div>`),
        );
        return;
      }

      const form = new URLSearchParams(body.text);
      if (path === "/decide") await this.decide(form, response);
      else await this.decideBatch(form, response);
      return;
    }

    if (request.method !== "GET" && request.method !== "POST") {
      this.send(response, 405, page("approval.md — method not allowed", "<p>GET or POST.</p>"));
      return;
    }

    this.send(response, 404, page("approval.md — not found", '<p>Nothing here. <a href="/">Queue</a>.</p>'));
  }

  /**
   * The best-effort same-origin check. Returns the offending origin, or `null`
   * when the POST is acceptable.
   *
   * A request with neither `Origin` nor `Referer` is accepted: `curl`, a test's
   * `fetch` and some browsers' form posts all send neither, and an attacker can
   * omit a header as easily as anyone else — refusing them would cost the
   * documented scripting path and buy nothing. See the module header's CSRF
   * section, which is flagged for review.
   */
  private checkOrigin(request: IncomingMessage): string | null {
    const origin = request.headers["origin"];
    const referer = request.headers["referer"];
    const candidate =
      typeof origin === "string" && origin.length > 0 && origin !== "null"
        ? origin
        : typeof referer === "string" && referer.length > 0
          ? referer
          : null;
    if (candidate === null) return null;

    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      return candidate;
    }
    const port = String(this.port);
    const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"];
    if (parsed.protocol !== "http:" || parsed.port !== port) return parsed.origin;
    return loopback.includes(parsed.hostname) ? null : parsed.origin;
  }

  private readBody(
    request: IncomingMessage,
  ): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const finish = (result: { ok: true; text: string } | { ok: false; message: string }): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      request.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > WEB_MAX_BODY_BYTES) {
          finish({
            ok: false,
            message: `form body exceeds ${WEB_MAX_BODY_BYTES} bytes; nothing was recorded`,
          });
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => finish({ ok: true, text: Buffer.concat(chunks).toString("utf8") }));
      request.on("error", (cause: Error) =>
        finish({ ok: false, message: `form body could not be read: ${cause.message}` }),
      );
    });
  }

  // -------------------------------------------------------------------------
  // The queue page
  // -------------------------------------------------------------------------

  /** The live pending set: the runtime's queue when one is supplied. */
  private currentRequests(): ChannelRequest[] {
    if (this.refresh === null) return this.pending;
    const requests = this.refresh();
    for (const request of requests) {
      const key = request.action_key.value;
      if (this.deliveries.has(key)) continue;
      this.counter += 1;
      this.deliveries.set(key, { deliveryId: `web-${this.counter}` });
      this.counters.notified += 1;
    }
    this.pending = requests;
    return requests;
  }

  /**
   * Render the queue. The `lastRendered()` report is built here, from the same
   * values the HTML is built from — not from a parallel description of it.
   */
  private queuePage(error?: string, notice?: string): string {
    const requests = this.currentRequests();
    const renderings = requests.map((request) => renderWebRequest(request));
    this.rendered = renderings.map((rendering) =>
      reportOf(rendering, this.deliveries.get(rendering.actionKey)?.batchDeliveryId),
    );

    const body: string[] = [];
    if (error !== undefined) body.push(`<div class="error">${escapeHtml(error)}</div>`);
    if (notice !== undefined) body.push(`<div class="notice">${escapeHtml(notice)}</div>`);
    body.push(actorLine(this.actorLabel));

    if (renderings.length === 0) {
      body.push("<p>queue: empty — no requests awaiting a decision.</p>");
      return page("approval.md — pending decisions", body.join("\n"));
    }

    body.push(
      `<p>${renderings.length} request(s) awaiting a decision. Every field below is marked ${escapeHtml(COMPUTED_MARKER)} (the runtime derived it) or ${escapeHtml(CLAIMED_MARKER)} (the party under oversight wrote it; it is never evidence).</p>`,
    );
    body.push(...renderings.map((rendering, index) => requestHtml(rendering, index)));
    body.push(
      "<h2>BATCH — one gesture over the selected requests</h2>",
      "<p>Each selected request still receives its own log event carrying this batch's delivery id: the log never batches (SPEC.md §10.3).</p>",
      '<label><input type="checkbox" data-select-all> select all (needs JavaScript; the checkboxes above do not)</label>',
      '<form method="post" action="/decide-batch" id="batch-form">',
      '<label>note (REQUIRED to reject) <input type="text" name="note"></label> ',
      '<button type="submit" name="decision" value="grant">Grant selected</button> ',
      '<button type="submit" name="decision" value="reject">Reject selected</button>',
      "</form>",
    );

    return page("approval.md — pending decisions", body.join("\n"));
  }

  // -------------------------------------------------------------------------
  // Decisions
  // -------------------------------------------------------------------------

  private async decide(form: URLSearchParams, response: ServerResponse): Promise<void> {
    const actionKey = (form.get("action_key") ?? "").trim();
    const verb = form.get("decision");
    const note = (form.get("note") ?? "").trim();

    if (actionKey.length === 0 || (verb !== "grant" && verb !== "reject")) {
      this.counters.refused += 1;
      this.send(
        response,
        422,
        this.queuePage(
          "The form was incomplete: an action key and a decision of grant or reject are required. Nothing was recorded.",
        ),
      );
      return;
    }

    // A refusal an agent cannot read is a refusal it will retry. Enforced on
    // the server, because `required` in the markup is a courtesy the client
    // controls.
    if (verb === "reject" && note.length === 0) {
      this.counters.refused += 1;
      this.send(
        response,
        422,
        this.queuePage(
          `A note is REQUIRED to reject ${actionKey}: an unexplained refusal cannot be acted on. Nothing was recorded — say why and submit again.`,
        ),
      );
      return;
    }

    // A key this process has never delivered is refused rather than reported:
    // the runtime's queue is consulted once first, because a POST may be the
    // first thing a scripted client does and a request that IS pending should
    // be decidable without a page view.
    if (!this.deliveries.has(actionKey)) this.currentRequests();
    const delivery = this.deliveries.get(actionKey);
    if (delivery === undefined) {
      this.counters.refused += 1;
      this.send(
        response,
        404,
        this.queuePage(
          `${actionKey} was never delivered by this server, so no decision was reported for it. Nothing was recorded.`,
        ),
      );
      return;
    }

    const handler = this.handler;
    if (handler === null) {
      this.counters.refused += 1;
      this.send(
        response,
        503,
        this.queuePage(
          "The runtime has not registered a decision handler yet, so nothing could be recorded. A channel never records its own decisions (SPEC.md §10.3).",
        ),
      );
      return;
    }

    const decision: ChannelDecision = {
      action_key: actionKey,
      decision: verb,
      deliveryId: delivery.deliveryId,
      // A per-request form on a member that was delivered as part of a batch
      // still belongs to that gesture, so the id rides along and the event
      // keeps the audit granularity §10.3 asks for.
      ...(delivery.batchDeliveryId === undefined
        ? {}
        : { batchDeliveryId: delivery.batchDeliveryId }),
      ...(note.length === 0 ? {} : { note }),
    };
    const outcome = handler(decision);
    this.counters.decisions += 1;

    const once = this.notice === null ? null : (this.notice(decision, outcome) ?? null);
    this.send(response, outcome.ok ? 200 : 409, this.outcomePage([{ decision, outcome, once }]));
  }

  private async decideBatch(form: URLSearchParams, response: ServerResponse): Promise<void> {
    const verb = form.get("decision");
    const note = (form.get("note") ?? "").trim();
    const keys = form.getAll("select").map((key) => key.trim()).filter((key) => key.length > 0);

    if (verb !== "grant" && verb !== "reject") {
      this.counters.refused += 1;
      this.send(
        response,
        422,
        this.queuePage("A batch gesture must be grant or reject. Nothing was recorded."),
      );
      return;
    }
    if (keys.length === 0) {
      this.counters.refused += 1;
      this.send(
        response,
        422,
        this.queuePage("No request was selected, so there was no batch to decide. Nothing was recorded."),
      );
      return;
    }
    if (verb === "reject" && note.length === 0) {
      this.counters.refused += 1;
      this.send(
        response,
        422,
        this.queuePage(
          "A note is REQUIRED to reject, batch or not: an unexplained refusal cannot be acted on. Nothing was recorded.",
        ),
      );
      return;
    }

    const requests = this.currentRequests();
    const selected: ChannelRequest[] = [];
    for (const key of keys) {
      const request = requests.find((entry) => entry.action_key.value === key);
      if (request === undefined) {
        this.counters.refused += 1;
        this.send(
          response,
          404,
          this.queuePage(
            `${key} is not in the pending queue this server is showing, so the batch was not assembled. Nothing was recorded.`,
          ),
        );
        return;
      }
      selected.push(request);
    }

    // B7 (SPEC.md §10.3). The refusal happens BEFORE anything is recorded, and
    // the page shows the contract's own code and message rather than a
    // paraphrase: the operator needs to be able to look the code up.
    const assembled = assembleBatch(selected);
    if (!assembled.ok) {
      this.counters.refused += 1;
      const refusal: BatchRefusal = assembled;
      this.send(
        response,
        422,
        this.queuePage(`${refusal.code}: ${refusal.message} Nothing was recorded.`),
      );
      return;
    }

    this.counter += 1;
    const batchDeliveryId = `web-batch-${this.counter}`;
    for (const request of selected) {
      this.deliveries.set(request.action_key.value, {
        deliveryId: batchDeliveryId,
        batchDeliveryId,
      });
    }

    const decisions: ChannelDecision[] = selected.map((request) => ({
      action_key: request.action_key.value,
      decision: verb,
      deliveryId: batchDeliveryId,
      batchDeliveryId,
      ...(note.length === 0 ? {} : { note }),
    }));

    const results: { decision: ChannelDecision; outcome: DecisionOutcome; once: string | null }[] =
      [];

    if (this.batchHandler !== null) {
      const reported = await this.batchHandler(decisions, batchDeliveryId);
      for (const decision of decisions) {
        const entry = reported.find((item) => item.action_key === decision.action_key);
        if (entry === undefined) continue;
        this.counters.decisions += 1;
        results.push({ decision, outcome: entry.outcome, once: entry.notice ?? null });
      }
    } else {
      const handler = this.handler;
      if (handler === null) {
        this.counters.refused += 1;
        this.send(
          response,
          503,
          this.queuePage("The runtime has not registered a decision handler yet; nothing was recorded."),
        );
        return;
      }
      for (const decision of decisions) {
        const outcome = handler(decision);
        this.counters.decisions += 1;
        results.push({
          decision,
          outcome,
          once: this.notice === null ? null : (this.notice(decision, outcome) ?? null),
        });
      }
    }

    const ok = results.every((entry) => entry.outcome.ok);
    this.send(response, ok ? 200 : 409, this.outcomePage(results, batchDeliveryId));
  }

  /**
   * The response page for a gesture.
   *
   * Not a redirect. A redirect-after-POST would either drop the one-shot notice
   * or put an execution token in a URL, and a URL is exactly the place a
   * credential must never be: it lands in history, in referrers, and in every
   * proxy log between here and nowhere.
   */
  private outcomePage(
    results: { decision: ChannelDecision; outcome: DecisionOutcome; once: string | null }[],
    batchDeliveryId?: DeliveryId,
  ): string {
    const body: string[] = [];
    if (batchDeliveryId !== undefined) {
      body.push(
        `<p>Batch <code>${escapeHtml(batchDeliveryId)}</code> — ${results.length} member(s), one log event each.</p>`,
      );
    }

    for (const entry of results) {
      const { decision, outcome } = entry;
      if (outcome.ok) {
        body.push(
          `<p><strong>${escapeHtml(outcome.decision === "grant" ? "GRANTED" : "REJECTED")}</strong> <code>${escapeHtml(decision.action_key)}</code> → ${escapeHtml(outcome.state)} at seq ${outcome.record.seq}.</p>`,
        );
      } else {
        body.push(
          `<div class="error">REFUSED <code>${escapeHtml(decision.action_key)}</code> (${escapeHtml(outcome.code)}): ${escapeHtml(outcome.message)}</div>`,
        );
      }
      if (entry.once !== null && entry.once.length > 0) {
        body.push(
          `<div class="notice"><p>SHOWN ONCE — copy it now. Reload this page and it is gone; the log records only its SHA-256 and nothing can recover it.</p><pre class="payload">${escapeHtml(entry.once)}</pre></div>`,
        );
      }
    }

    body.push('<p><a href="/">back to the queue</a></p>');
    return page("approval.md — decision recorded", body.join("\n"));
  }

  private send(response: ServerResponse, status: number, html: string): void {
    response.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      // No caching anywhere: a queue page is a claim about *now*, and one of
      // these responses may carry a single-use token.
      "cache-control": "no-store, no-cache, must-revalidate, private",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      // The page is entirely self-contained; nothing it renders should be able
      // to reach the network even if an escaping bug ever let markup through.
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
    });
    response.end(html);
  }
}
