/**
 * The adapter coverage source (APRV-245).
 *
 * The other two sources read a repository. This one asks the PROVIDER what it
 * recorded: AgentMail knows which messages an inbox actually sent, and that
 * record is written by neither the agent nor this runtime. An adapter that
 * implements the optional `observe` (see `adapters/contract.ts`) publishes that
 * knowledge, and an adapter that does not is reported as offering none rather
 * than as having seen nothing.
 *
 * ## What this source guarantees about the call
 *
 * - **Read-only, and outside any grant window.** `observe` is never handed a
 *   token, never called from inside `executeThroughAdapter`, and is documented
 *   in the contract as a read. A coverage report that could send would be a
 *   report nobody dares run.
 * - **The caller redacts.** An adapter's answer can quote whatever its far side
 *   said, so every `detail` goes through {@link redactSecrets} against the
 *   secrets the caller knows before it is returned. The adapter scrubs its own
 *   strings too; this is the second pass, on the principle that redaction is
 *   cheap and a leak is not (SPEC.md §11.1 invariant 3).
 * - **A throw is a source failure, not a crash.** An adapter whose far side is
 *   down makes its own source unavailable and leaves every other source's
 *   answer intact.
 */

import { redactSecrets, type Adapter, type CredentialProvider } from "../../adapters/contract.js";
import type { ObservedEffect, ObservationWindow } from "../coverage.js";
import type { SourceObservation } from "./git.js";

export interface AdapterSourceOptions {
  /** Values to scrub out of every returned detail. */
  secrets?: readonly string[];
}

/** Only the message; never the stack, which routinely quotes arguments. */
function describeThrow(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Ask one adapter what its provider recorded in `window`.
 *
 * An adapter with no `observe` is `available: false` with a reason that names
 * the gap honestly: this adapter offers no observation, so the runtime cannot
 * say whether effects of its class happened outside the gate.
 */
export async function observeAdapter(
  adapter: Adapter,
  window: ObservationWindow,
  credentials: CredentialProvider,
  options: AdapterSourceOptions = {},
): Promise<SourceObservation> {
  const secrets = options.secrets ?? [];
  const scrub = (text: string): string => redactSecrets(text, secrets).text;

  if (adapter.observe === undefined) {
    return {
      name: adapter.name,
      available: false,
      reason: `the ${adapter.name} adapter implements no observe(), so its provider's own record of what was sent cannot be read`,
      effects: [],
    };
  }

  let effects: ObservedEffect[];
  try {
    effects = [...(await adapter.observe(window, credentials))];
  } catch (cause) {
    return {
      name: adapter.name,
      available: false,
      reason: `the ${adapter.name} adapter could not be asked what it observed: ${scrub(describeThrow(cause))}`,
      effects: [],
    };
  }

  return {
    name: adapter.name,
    available: true,
    effects: effects.map((effect) => ({
      ...effect,
      detail: scrub(effect.detail),
      ...(effect.actorHint === null ? {} : { actorHint: scrub(effect.actorHint) }),
    })),
  };
}
