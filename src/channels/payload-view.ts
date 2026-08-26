/**
 * The channel-side facade over the canonical renderer (APRV-119).
 *
 * Everything this module used to hold — the email view (APRV-100), the diff view
 * (APRV-124), the command view and its injective escape marking (APRV-126), the
 * classifier-derived breakdown and protected-path lines (APRV-143, APRV-144) —
 * now lives in `core/wysiwys.ts`, absorbed into {@link canonicalRender}. It
 * moved because the gate consults it: `core/gate.ts` computes the
 * `display_hash` a request records at the write boundary from the same function
 * the channels render with, and core cannot import channels.
 *
 * What is left here is the one function that needs a channel type, plus the
 * re-exports that keep every existing import path working. A channel imports
 * this; nothing else does.
 */

import { canonicalRender } from "../core/wysiwys.js";
import type { PayloadRendering } from "./contract.js";

// The canonical renderer and every view it is built from. Re-exported rather
// than re-implemented: a second definition of any of these would be a second
// rendering of the same bytes, which is the failure APRV-119 exists to remove.
export * from "../core/wysiwys.js";

/**
 * The text a channel puts inside its payload region (SPEC.md §10.4, §9).
 *
 * For a whole payload this is {@link canonicalRender}'s text verbatim, so the
 * three channels present the same reading of the same bytes and the log's
 * `display_hash` names it. Claimed material — the summary, the estimate, the
 * rationale, a model's gloss — is never inside this region; each channel renders
 * it above, under its own claimed heading.
 *
 * A **truncated** rendering has no canonical form and does not get one. The
 * tagging layer cut `text` short at the caller's `maxPayloadChars`, so the bytes
 * on screen are not the bytes the token will execute, and giving a partial
 * payload the canonical block's authority is exactly the substitution WYSIWYS
 * forbids. The pre-existing truncated text is returned unchanged, the channel's
 * own "TRUNCATED — do not grant on it" marker still surrounds it, and
 * `channels/batch.ts` still refuses to fold such a member into a batch.
 */
export function payloadRegionText(rendering: PayloadRendering, actionClass: string): string {
  if (rendering.truncated) return rendering.text;
  return canonicalRender(rendering.value, actionClass).text;
}
