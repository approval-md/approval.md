/**
 * Attaching the model gloss to a request, for every channel that renders one
 * (APRV-144, APRV-164, APRV-197).
 *
 * `cli/gloss.ts` decides how a sentence is obtained; this decides which
 * material is worth asking about and where the answer is hung. It lived inside
 * `cli/channel-telegram.ts` until APRV-197, when a second surface needed it:
 * Carter, deciding requests on the CLI channel, read the raw claimed summary
 * and nothing else, because the only code that had ever attached a gloss was
 * the Telegram listener. One reading aid implemented twice would be two reading
 * aids that drift, so the listener and the terminal walker now call the same
 * function over the same payload views.
 *
 * The safety argument is unchanged and belongs here rather than at either call
 * site. This runs at RENDER time, on a `ChannelRequest` the tagger has already
 * finished building: the gate resolved the class, the budgets and the payload
 * binding without this field existing, the payload hash was computed over bytes
 * that do not contain it, and the log will record a decision that never
 * mentions it. Nothing anywhere branches on the content of a gloss; the only
 * thing that turns on it is whether one more line appears.
 *
 * What APRV-197 adds is an {@link GlossOutcome}. Absence used to be silent by
 * design, and that was right for one request and wrong for a thousand: with the
 * timeout set where APRV-144 set it, the subprocess missed EVERY time and the
 * result was indistinguishable from the feature never having shipped. The
 * outcome is returned so a caller can count, and count is all it is for — no
 * caller retries, waits longer, or renders anything different because of it.
 */

import {
  changePayloadView,
  commandPayloadView,
  emailPayloadFields,
} from "../channels/payload-view.js";
import { claimed, type ChannelRequest } from "../channels/contract.js";
import {
  glossAuthor,
  glossFor,
  GLOSS_EDIT_INSTRUCTION,
  GLOSS_EMAIL_INSTRUCTION,
  GLOSS_INSTRUCTION,
  type GlossRunner,
} from "./gloss.js";

/**
 * What one attempt did. Counted by the caller, read by nobody else.
 *
 * `opaque` and `absent` are kept apart because they mean different things to an
 * operator: a payload with no describable material was never going to get a
 * sentence (there is nothing the canonical JSON does not already show), while
 * `absent` means a model was asked and did not answer in time. Only the second
 * is a fault, and a counter that added them together would report a fault every
 * time an opaque payload went by.
 */
export type GlossOutcome = "attached" | "absent" | "opaque";

export interface GlossAttachment {
  /** The request, with a `gloss` field when there is one and unchanged otherwise. */
  request: ChannelRequest;
  outcome: GlossOutcome;
}

/**
 * The request, plus a model's one-sentence gloss of its payload when one can be
 * had.
 *
 * Every payload kind the renderer can read gets one (APRV-164): a command, a
 * file change, an email. The kind is derived exactly as the WYSIWYS rendering
 * derives it, from the structure of the bytes, so the sentence is about the
 * material the approver is being shown and the two can never be about different
 * payloads. An opaque payload gets none.
 *
 * Returns the request UNCHANGED for every flavour of "no answer". Losing the
 * gloss costs one line on a prompt, which is why no failure here is allowed to
 * cost anything more.
 */
export function attachGloss(request: ChannelRequest, run: GlossRunner): GlossAttachment {
  const asked = glossMaterial(request.fullPayload.value?.value);
  if (asked === null) return { request, outcome: "opaque" };
  const result = glossFor(asked.instruction, asked.material, run);
  if (result === null) return { request, outcome: "absent" };
  return {
    request: { ...request, gloss: claimed(result.text, glossAuthor(result)) },
    outcome: "attached",
  };
}

/**
 * The instruction and the material for one payload, or `null` for an opaque one.
 *
 * The material is assembled from the same structural views the canonical
 * rendering is built from, and it is deliberately plain: labelled lines and the
 * text itself, in the order the prompt shows them. Nothing here reads a
 * self-declared kind field, for the reason `core/wysiwys.ts` gives at length —
 * a payload that chose its own presentation would have chosen its own gloss too.
 */
export function glossMaterial(
  value: unknown,
): { instruction: string; material: string } | null {
  const command = commandPayloadView(value);
  if (command !== null) {
    // Byte for byte what APRV-144 sent: the command alone, under the command
    // instruction. A prompt that drifted here would change a shipped behaviour
    // for no reason beyond the refactor that touched it.
    return { instruction: GLOSS_INSTRUCTION, material: command.command };
  }

  const change = changePayloadView(value);
  if (change !== null) {
    const labels = change.labels.map((field) => `${field.label}: ${field.text}`);
    const body =
      change.before === null
        ? ["new content:", change.after]
        : ["before:", change.before, "after:", change.after];
    return { instruction: GLOSS_EDIT_INSTRUCTION, material: [...labels, ...body].join("\n") };
  }

  const email = emailPayloadFields(value);
  if (email !== null) {
    return {
      instruction: GLOSS_EMAIL_INSTRUCTION,
      material: email.map((field) => `${field.label}: ${field.text}`).join("\n"),
    };
  }

  return null;
}

/**
 * The stderr line that turns chronic silence into a visible fault (APRV-197 #3).
 *
 * One line, at the end of a walk or a dispatch cycle, and only when a model was
 * actually asked and did not answer. It names the ceiling because that is the
 * number an operator can act on, and it says the decision is unaffected because
 * the first thing a reader of an approval tool's stderr needs to know is
 * whether the thing they just approved was compromised by this. It was not:
 * nothing downstream of a gloss exists.
 */
export function glossAbsenceLine(
  surface: string,
  absent: number,
  asked: number,
  timeoutMs: number,
): string {
  return (
    `approval: ${surface}: ${absent} of ${asked} request(s) got no model gloss ` +
    `(the \`claude -p\` subprocess was missing, failed, or exceeded ${timeoutMs}ms) — ` +
    "the prompts are unaffected; a gloss is a reading aid the runtime never reads\n"
  );
}
