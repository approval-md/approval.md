/**
 * A readable rendering of a payload a channel recognises (APRV-100).
 *
 * SPEC.md §10.4 requires a channel to present, for a `manual` action, "the full
 * payload or a faithful rendering of it". Until now every channel used the one
 * rendering `channels/tagging.ts` builds: pretty-printed JSON. That is faithful
 * and it is exact, and for an email it is close to unreadable — the observed
 * failure (2026-08-18, examples/email-demo.md) is a body arriving on a phone as
 * a single line carrying literal `\n` sequences, which is precisely the text a
 * human is being asked to take responsibility for.
 *
 * So this module adds a second rendering *on top of* the first, never instead
 * of it:
 *
 * - A payload whose **structure** matches the email adapter's payload shape
 *   ({@link ../adapters/email.js}) is rendered field by field, with the body as
 *   the human will read it: real line breaks, no JSON escapes.
 * - The canonical JSON follows underneath, unchanged, so the exact bytes remain
 *   on screen and every existing check that the region contains them still
 *   holds. The reading aid is above; the evidence is below.
 * - Every other shape keeps today's rendering byte for byte.
 *
 * Three properties this file is careful about:
 *
 * 1. **Detection is structural.** Nothing here reads a self-declared "kind" or
 *    "type" field, because that field would be authored by the party under
 *    oversight, and a channel that lets an agent choose its own presentation
 *    has handed the agent the display. A payload is email-shaped when its keys
 *    and its value types say so, and for no other reason.
 * 2. **Nothing is hidden.** The shape is accepted only when *every* key is one
 *    this module renders, so the field-by-field view never omits a byte of the
 *    payload — a `bcc` or a `content_type` that the reader could not see would
 *    be the same failure as a truncated payload, wearing a friendlier face.
 * 3. **This is claimed content.** The payload is authored by the requesting
 *    agent. The block says so in its first line, and the computed binding (the
 *    `sha256` label each channel already prints around this region) stays where
 *    it is. Making the payload *legible* must not make it look *verified*.
 *
 * The output is plain text with real newlines. Escaping belongs to the channel:
 * `telegram.ts` and `web.ts` each pass this through their own `escapeHtml` and
 * their own `<pre>`, so the injection surface is exactly what it was before.
 */

import type { PayloadRendering } from "./contract.js";

/** Keys the email adapter's payload may carry (`adapters/email.ts`). */
const STRING_KEYS = ["from", "subject", "body", "content_type"] as const;
const ADDRESS_LIST_KEYS = ["to", "cc", "bcc"] as const;

/**
 * The keys that must be present for a value to read as an email at all.
 *
 * A recipient, a subject and a body: the triple that makes the JSON rendering
 * unreadable in the first place. `from` is optional here even though the
 * adapter requires it, because this module answers "will a human read this
 * better field by field?", not "will the adapter accept it?" — the adapter
 * enforces its own shape at execution, and duplicating that judgement here
 * would only mean a payload the adapter rejects gets rendered badly first.
 */
const REQUIRED_KEYS = ["to", "subject", "body"] as const;

/** Display order. `body` last: it is the only multi-line field. */
const FIELD_ORDER = ["from", "to", "cc", "bcc", "subject", "content_type", "body"] as const;

/** The heading and delimiters. Exported because the tests pin them. */
export const EMAIL_VIEW_HEADING =
  "email — rendered field by field; every value below is CLAIMED, authored by the requesting party";
export const BODY_BEGIN = "--- body begins ---";
export const BODY_END = "--- body ends ---";
export const CANONICAL_JSON_HEADING = "--- the same bytes, canonical JSON ---";

/** One labelled line of the field-by-field view. */
export interface EmailViewField {
  label: string;
  /** The value as text. For `body`, this may contain newlines. */
  text: string;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Recognise an email-shaped payload, structurally.
 *
 * Returns the fields in display order, or `null` when the value is any other
 * shape — including an email-ish object carrying one key this module does not
 * know how to show, which falls back to JSON rather than hiding it.
 */
export function emailPayloadFields(value: unknown): EmailViewField[] | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  const known = new Set<string>([...STRING_KEYS, ...ADDRESS_LIST_KEYS]);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) return null;
  }
  for (const key of REQUIRED_KEYS) {
    if (!(key in record)) return null;
  }

  for (const key of STRING_KEYS) {
    if (key in record && typeof record[key] !== "string") return null;
  }
  for (const key of ADDRESS_LIST_KEYS) {
    if (!(key in record)) continue;
    const entry = record[key];
    if (typeof entry !== "string" && !isStringArray(entry)) return null;
  }

  const fields: EmailViewField[] = [];
  for (const key of FIELD_ORDER) {
    if (!(key in record)) continue;
    const entry = record[key];
    fields.push({
      label: key,
      text: typeof entry === "string" ? entry : (entry as string[]).join(", "),
    });
  }
  return fields;
}

/**
 * The text a channel puts inside its payload region.
 *
 * For a recognised, whole payload: the field-by-field view, then the canonical
 * JSON underneath. For anything else — an unrecognised shape, or a rendering
 * the tagging layer already truncated, where `value` holds more than `text`
 * admits to showing — exactly what a channel rendered before this module
 * existed.
 */
export function payloadRegionText(rendering: PayloadRendering): string {
  if (rendering.truncated) return rendering.text;
  const fields = emailPayloadFields(rendering.value);
  if (fields === null) return rendering.text;

  const lines: string[] = [EMAIL_VIEW_HEADING];
  for (const field of fields) {
    if (field.label === "body") continue;
    lines.push(`${field.label}: ${field.text}`);
  }
  const body = fields.find((field) => field.label === "body");
  if (body !== undefined) {
    const count = body.text === "" ? 0 : body.text.split("\n").length;
    lines.push(`body (${count} line${count === 1 ? "" : "s"}):`, BODY_BEGIN, body.text, BODY_END);
  }
  lines.push("", CANONICAL_JSON_HEADING, rendering.text);
  return lines.join("\n");
}
