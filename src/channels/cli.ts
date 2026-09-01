/**
 * The CLI channel (APRV-23) — the zero-config channel, written against the
 * contract in `channels/contract.ts` and nothing else.
 *
 * It is the first implementation of {@link TestableChannel}, and it exists as
 * much to prove the contract is implementable as to be useful: a terminal has no
 * stylesheet, no buttons and no webhook, so everything the contract asks a
 * channel to do has to be done in plain text. If SPEC.md §9's display rule
 * cannot survive a channel this poor, it cannot survive a rich one either.
 *
 * ## The rendering convention (SPEC.md §9)
 *
 * Every line carries a marker in the first column, and the marker is the first
 * thing a reader sees:
 *
 * ```
 * [computed] class            communicate.email.external            (log)
 * [claimed]  summary          chase invoice 41                      (agent:drafter)
 * ```
 *
 * `[computed]` means the runtime derived the value — from the verified log, the
 * attested policy, the budget evaluator, the payload bytes, or arithmetic on the
 * display instant — and the parenthetical names *which* derivation. `[claimed]`
 * means the party under oversight wrote it, and the parenthetical names that
 * party. The marker is not decoration: it is the difference between "the runtime
 * says this is a manual action" and "an agent says this costs two cents", and a
 * channel that gave them the same weight would be a conformance failure rather
 * than a styling preference.
 *
 * Claimed lines are additionally indented under a `claimed by …` heading, so the
 * split survives a terminal that eats no colour and a reader who skims. There is
 * no bold, no colour and no unicode box drawing anywhere in this file — a marker
 * a `less`, a pipe, a CI log or a screen reader can lose is a marker that was
 * never there.
 *
 * ## The full payload (SPEC.md §10.4)
 *
 * For a manual action the payload is printed verbatim inside an explicitly
 * delimited block:
 *
 * ```
 * --- BEGIN FULL PAYLOAD (bound sha256 <hash>) ---
 * { … }
 * --- END FULL PAYLOAD ---
 * ```
 *
 * The block is never mixed with the claimed summary, and the summary is never
 * printed inside it. `channels/tagging.ts` has already checked those bytes
 * against the recorded binding, so what is inside the delimiters is what the
 * execution token will spend.
 *
 * ## What this file does NOT do
 *
 * It does not read the log, write the log, decide anything, or hold a token.
 * The decision handler is registered by the runtime (`cli/channel.ts`) and its
 * only job is to call {@link recordChannelDecision}. The prompt loop collects a
 * gesture and hands it over; whether that gesture becomes an event is the gate's
 * answer, not this file's.
 *
 * It also does not dispatch (APRV-55). This channel is **one-shot by design**:
 * the runtime derives the queue once, renders it, collects decisions on the
 * requests in front of the operator, and the process ends. There is no cycle in
 * which a newly appended request could arrive, so there is nothing to push —
 * the operator running the verb again is the refresh. Only the long-lived push
 * channel (Telegram) needs a per-cycle send; the long-lived pull channel (web)
 * re-derives per page view.
 */

import { createInterface, type Interface } from "node:readline";

import type { BudgetVerdict } from "../core/budgets.js";
import { GLOSS_UNVERIFIED_SUFFIX } from "./contract.js";
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
// Injectable I/O
// ---------------------------------------------------------------------------

/** The narrowest thing this channel needs to write to. `process.stdout` fits. */
export interface OutputSink {
  write(text: string): unknown;
}

/** The narrowest thing this channel needs to read lines from. `process.stdin` fits. */
export type InputSource = NodeJS.ReadableStream;

export interface CliChannelOptions {
  /** Where the rendering goes. Defaults to `process.stdout`. */
  output?: OutputSink;
  /** Where the gesture comes from. Defaults to `process.stdin`. */
  input?: InputSource;
  /** Channel name recorded for audit. Defaults to `cli`. */
  name?: string;
}

/** The marker prefixes. Exported because the help text and the tests pin them. */
export const COMPUTED_MARKER = "[computed]";
export const CLAIMED_MARKER = "[claimed]";

/** The full-payload delimiters (SPEC.md §10.4). Pinned by tests. */
export const PAYLOAD_BEGIN = "--- BEGIN FULL PAYLOAD";
export const PAYLOAD_END = "--- END FULL PAYLOAD ---";

/** One line of the legend, printed above every delivery. */
export const RENDERING_LEGEND = [
  `${COMPUTED_MARKER} derived by the runtime (verified log, attested policy, budget evaluator,`,
  "           payload bytes, clock); the parenthetical names the derivation.",
  `${CLAIMED_MARKER}  written by the party under oversight; the parenthetical names the author.`,
  "           A claim may raise your scrutiny. It is never evidence.",
].join("\n");

// ---------------------------------------------------------------------------
// Value formatting
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
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
 * A field's value as one line of text.
 *
 * Deliberately total: an unknown shape is JSON-stringified rather than dropped,
 * because a field the runtime tagged and the channel silently omitted is a field
 * the approver did not see.
 */
function formatValue(field: string, value: unknown): string {
  if (value === null || value === undefined) return "(none)";
  // APRV-197. The one line in the rendering that NO party stands behind — not
  // the runtime, not even the requesting agent — says so on the line itself,
  // in the same words Telegram has used since APRV-144. The `(model:haiku)`
  // attribution at the end of the line is true but small, and a reader skimming
  // a terminal reads the sentence, not the parenthetical.
  if (field === "gloss" && typeof value === "string") {
    return `${value} ${GLOSS_UNVERIFIED_SUFFIX}`;
  }
  if (field === "ttl_remaining_ms" && typeof value === "number") return formatDuration(value);
  if (field === "budgets" && Array.isArray(value)) return formatBudgets(value as BudgetVerdict[]);
  if (field === "attestation" && typeof value === "object") {
    const status = (value as { status?: unknown }).status;
    const seq = (value as { seq?: unknown }).seq;
    return seq === undefined ? String(status) : `${String(status)} (policy.updated seq ${String(seq)})`;
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
 * The order fields are presented in.
 *
 * Computed identity and authority first, claimed persuasion last: a reader who
 * stops halfway has read the runtime's answer and not the agent's pitch. Fields
 * absent from a request are skipped; fields present but not listed here are
 * appended, so a widened {@link ChannelRequest} cannot silently lose a member.
 */
const FIELD_ORDER: string[] = [
  "action_key",
  "task",
  "class",
  "command_breakdown",
  "protected_path",
  // APRV-109: on an attestation prompt these two ARE the decision, so they sit
  // with the resolution lines rather than after the claimed block. Absent on
  // every ordinary request, and `orderedFields` skips a name the request does
  // not carry.
  "policy_diff",
  "policy_load",
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
  "gloss",
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
// Line reading
// ---------------------------------------------------------------------------

/**
 * Sequential line reads over one `readline` interface.
 *
 * One interface per channel, not one per question: a fresh interface per prompt
 * would race for buffered bytes on a piped stdin and lose lines, which on this
 * path means losing a human's answer. `next()` resolves `null` at end of input,
 * which every caller treats as "no gesture" — never as a default answer.
 */
class LineReader {
  private readonly rl: Interface;
  private readonly pending: string[] = [];
  private readonly waiting: ((line: string | null) => void)[] = [];
  private closed = false;

  constructor(input: InputSource) {
    this.rl = createInterface({ input, terminal: false });
    this.rl.on("line", (line: string) => {
      const waiter = this.waiting.shift();
      if (waiter === undefined) this.pending.push(line);
      else waiter(line);
    });
    this.rl.on("close", () => {
      this.closed = true;
      while (this.waiting.length > 0) this.waiting.shift()?.(null);
    });
  }

  next(): Promise<string | null> {
    const buffered = this.pending.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiting.push(resolve);
    });
  }

  close(): void {
    this.rl.close();
  }
}

// ---------------------------------------------------------------------------
// The channel
// ---------------------------------------------------------------------------

/** What {@link CliChannel.collectDecision} produced. */
export type CliCollection =
  | { kind: "decided"; decision: ChannelDecision; outcome: DecisionOutcome }
  /** The human declined to answer this one; nothing was reported. */
  | { kind: "skipped" }
  /** Input ended before an answer arrived; nothing was reported. */
  | { kind: "aborted" };

export class CliChannel implements TestableChannel {
  readonly name: string;

  private readonly output: OutputSink;
  private readonly input: InputSource;
  private handler: ((decision: ChannelDecision) => DecisionOutcome) | null = null;
  private rendered: RenderedRequest[] = [];
  private reader: LineReader | null = null;
  private counter = 0;

  constructor(options: CliChannelOptions = {}) {
    this.name = options.name ?? "cli";
    this.output = options.output ?? process.stdout;
    this.input = options.input ?? process.stdin;
  }

  /**
   * Present a request, or a batch, and return the delivery id.
   *
   * Writes to the output sink and nowhere else: no log, no state, no decision.
   * A batch is rendered member by member — each member carries its own full
   * payload, and folding one behind another is exactly what `channels/batch.ts`
   * refuses upstream.
   */
  notify(request: ChannelRequest | ChannelBatch): DeliveryId {
    this.counter += 1;
    const deliveryId = `cli-${this.counter}`;
    const isBatch = "requests" in request;
    const members = isBatch ? request.requests : [request];

    this.output.write(
      `\n=== approval.md ${isBatch ? `batch ${deliveryId} (${members.length} request(s))` : `request ${deliveryId}`} ===\n${RENDERING_LEGEND}\n`,
    );

    this.rendered = members.map((member, index) => {
      const entry = this.renderRequest(member, isBatch ? deliveryId : undefined);
      this.output.write(textOf(member, entry, isBatch ? index + 1 : null, members.length));
      return entry;
    });

    return deliveryId;
  }

  onDecision(handler: (decision: ChannelDecision) => DecisionOutcome): void {
    this.handler = handler;
  }

  health(): ChannelHealth {
    return { ok: true };
  }

  lastRendered(): RenderedRequest[] {
    return this.rendered;
  }

  /**
   * Release the input interface. Safe to call when nothing was ever read.
   *
   * The source is paused as well as closed: a `readline` interface over
   * `process.stdin` leaves the stream flowing, and a process that finished
   * asking would sit there holding the event loop open.
   */
  close(): void {
    this.reader?.close();
    this.reader = null;
    this.input.pause?.();
  }

  /**
   * The prompt loop: `g` grants, `r` rejects, `s` skips.
   *
   * A reject demands a note and re-asks until it gets one — a refusal an agent
   * cannot read is a refusal it will retry. A grant's note is optional; there is
   * nothing to explain about "yes, do the thing I was shown".
   *
   * The gesture is reported to the handler registered by the runtime, and the
   * handler's {@link DecisionOutcome} is returned unchanged, refusals included.
   * Nothing here inspects it, and nothing here retries: a gate refusal is an
   * answer, and re-asking a human who already answered is how double-grants get
   * made.
   */
  async collectDecision(
    actionKey: string,
    deliveryId: DeliveryId,
    options: { batchDeliveryId?: DeliveryId } = {},
  ): Promise<CliCollection> {
    const handler = this.handler;
    if (handler === null) {
      throw new Error(
        "no decision handler is registered on the cli channel; the runtime registers one before notify(), and a channel that recorded its own decision would be deciding rather than transporting (SPEC.md §10.3)",
      );
    }

    for (;;) {
      this.output.write(`\n${actionKey}\n  g) grant   r) reject   s) skip  > `);
      const answer = (await this.readLine())?.trim().toLowerCase();
      if (answer === undefined) {
        this.output.write("\n(input ended; no decision was recorded)\n");
        return { kind: "aborted" };
      }

      if (answer === "s" || answer === "skip" || answer === "") {
        this.output.write("skipped; the request stays pending\n");
        return { kind: "skipped" };
      }

      if (answer === "g" || answer === "grant") {
        const note = await this.askNote("note (optional, press enter to skip) > ", false);
        if (note === null) return { kind: "aborted" };
        return this.report(handler, actionKey, "grant", note, deliveryId, options);
      }

      if (answer === "r" || answer === "reject") {
        const note = await this.askNote("note (REQUIRED — say why) > ", true);
        if (note === null) return { kind: "aborted" };
        return this.report(handler, actionKey, "reject", note, deliveryId, options);
      }

      this.output.write(`unrecognized answer ${JSON.stringify(answer)}; expected g, r or s\n`);
    }
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private report(
    handler: (decision: ChannelDecision) => DecisionOutcome,
    actionKey: string,
    verb: "grant" | "reject",
    note: string | undefined,
    deliveryId: DeliveryId,
    options: { batchDeliveryId?: DeliveryId },
  ): CliCollection {
    const decision: ChannelDecision = {
      action_key: actionKey,
      decision: verb,
      deliveryId,
      ...(note === undefined ? {} : { note }),
      ...(options.batchDeliveryId === undefined
        ? {}
        : { batchDeliveryId: options.batchDeliveryId }),
    };
    return { kind: "decided", decision, outcome: handler(decision) };
  }

  /**
   * Ask for a note. Returns `undefined` for "none given" and `null` when input
   * ended — the two are different, and conflating them would let a closed pipe
   * look like a human who chose to say nothing.
   */
  private async askNote(prompt: string, required: boolean): Promise<string | undefined | null> {
    for (;;) {
      this.output.write(prompt);
      const line = await this.readLine();
      if (line === null) {
        this.output.write("\n(input ended; no decision was recorded)\n");
        return null;
      }
      const note = line.trim();
      if (note.length > 0) return note;
      if (!required) return undefined;
      this.output.write("a note is required to reject: an unexplained refusal cannot be acted on\n");
    }
  }

  private async readLine(): Promise<string | null> {
    this.reader ??= new LineReader(this.input);
    return await this.reader.next();
  }

  /**
   * Build one request's rendering split. This is the same function whose output
   * is written to the terminal — {@link lastRendered} is not a parallel
   * description of the rendering, it *is* the rendering.
   */
  private renderRequest(request: ChannelRequest, batchDeliveryId?: DeliveryId): RenderedRequest {
    const members = request as unknown as Record<string, TaggedField<unknown> | undefined>;
    const fields: RenderedField[] = [];
    for (const name of orderedFields(request)) {
      const field = members[name];
      if (field === undefined) continue;
      fields.push({ field: name, kind: field.kind, text: formatValue(name, field.value) });
    }

    const rendering = request.fullPayload.value;
    const fullPayloadText =
      rendering === null
        ? null
        : [
            `${PAYLOAD_BEGIN} (bound sha256 ${rendering.hash}) ---`,
            // APRV-119. The canonical rendering, the same bytes the other two
            // channels put in front of a human. Until now this channel printed
            // the pretty JSON alone, which meant a terminal approver and a
            // Telegram approver read two different texts for one payload — the
            // exact divergence WYSIWYS exists to rule out.
            payloadRegionText(rendering, request.class.value),
            PAYLOAD_END,
            ...(rendering.truncated
              ? ["(TRUNCATED — this is not the whole payload; do not grant on it)"]
              : []),
          ].join("\n");

    return {
      action_key: request.action_key.value,
      fields,
      fullPayloadText,
      ...(batchDeliveryId === undefined ? {} : { batchDeliveryId }),
    };
  }

}

/**
 * The terminal text for one rendering.
 *
 * Computed lines first, then the claimed block under its own heading, then the
 * delimited payload. `request` is read only for each field's attribution — the
 * derivation that produced a computed value, the author of a claimed one.
 */
function textOf(
  request: ChannelRequest,
  entry: RenderedRequest,
  position: number | null,
  total: number,
): string {
  const members = request as unknown as Record<string, TaggedField<unknown> | undefined>;
  const suffix = (name: string): string => {
    const field = members[name];
    return field === undefined ? "" : ` (${attribution(field)})`;
  };

  const lines: string[] = [
    position === null
      ? `\n--- ${entry.action_key} ---`
      : `\n--- ${entry.action_key} (${position} of ${total}) ---`,
  ];

  for (const field of entry.fields) {
    if (field.kind !== "computed") continue;
    lines.push(`${COMPUTED_MARKER} ${field.field.padEnd(16)} ${field.text}${suffix(field.field)}`);
  }

  const claimed = entry.fields.filter((field) => field.kind === "claimed");
  if (claimed.length > 0) {
    lines.push("claimed by the party under oversight — NOT verified by the runtime:");
    for (const field of claimed) {
      lines.push(`  ${CLAIMED_MARKER} ${field.field.padEnd(14)} ${field.text}${suffix(field.field)}`);
    }
  }

  if (entry.fullPayloadText !== null) {
    lines.push("");
    lines.push(entry.fullPayloadText);
  }
  return `${lines.join("\n")}\n`;
}
