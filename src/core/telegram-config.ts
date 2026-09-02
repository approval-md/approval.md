/**
 * Telegram configuration NAMES (SPEC.md §5.1 `channels.telegram.token_env` /
 * `chat_id_env`, amended §5.2 by APRV-72).
 *
 * Constants and resolvers live in core, not in `channels/`, because more than
 * one layer needs them: the Telegram CLI, doctor, and `approval env` (APRV-73)
 * all ask "which variable holds the token?" and none of them may answer it
 * differently. Placing them here also keeps `core/` free of any import from
 * `channels/`, in the spirit of `tests/layering.test.ts`.
 *
 * NAMES only, in both directions: a policy that carried the token would be a
 * bot credential in a file agents may read, which is exactly what §5.1's
 * name-indirection exists to prevent. A policy that failed to load names
 * nothing, so the default applies: a variable name is not a permission, and
 * treating it as one would mean an unrelated policy typo locked the operator
 * out of their own channel. This is `passphraseEnvFor`'s argument, verbatim,
 * for the same reason: these are the same kind of key.
 *
 * Nothing here reads `process.env`. The CLI layer takes the name and looks
 * the value up.
 */

import type { CredentialSpec } from "./credential-spec.js";
import type { PolicyLoadResult } from "./policy-load.js";

/**
 * The environment variable the bot token is read from when the policy declares
 * no `channels.telegram.token_env`. A DEFAULT, not a fixed name: see
 * {@link telegramTokenEnvFor}.
 */
export const TELEGRAM_TOKEN_ENV = "APPROVAL_TG_TOKEN";

/**
 * The environment variable the approver chat id is read from when the policy
 * declares no `channels.telegram.chat_id_env`. Also a default.
 */
export const TELEGRAM_CHAT_ENV = "APPROVAL_TG_CHAT";

/** The NAME of the variable this policy says the bot token lives in. */
export function telegramTokenEnvFor(load: PolicyLoadResult): string {
  return declaredEnvName(load, "token_env") ?? TELEGRAM_TOKEN_ENV;
}

/** The NAME of the variable this policy says the approver chat id lives in. */
export function telegramChatEnvFor(load: PolicyLoadResult): string {
  return declaredEnvName(load, "chat_id_env") ?? TELEGRAM_CHAT_ENV;
}

/**
 * How a listener puts the pending set in front of the approver (APRV-216).
 *
 * `paced` sends one summary line and the oldest pending request, and the next
 * one only once that request is decided, skipped, or passed over. `burst` is
 * the pre-APRV-216 behaviour: every pending request this process has not sent
 * yet, on every cycle, behind the APRV-196 re-delivery banner.
 *
 * Not a credential and not a name, so it sits beside the two that are for one
 * reason: it is the third thing a caller asks the policy about the Telegram
 * channel, and a second resolver module would be a second place for the
 * fallback rule to drift.
 */
export type TelegramDelivery = "paced" | "burst";

/**
 * What an absent `channels.telegram.delivery` means.
 *
 * Paced, since APRV-216. The incident behind it is the one APRV-196 softened
 * rather than closed: a restart with six pending policy edits put six prompts
 * on a phone at once, and an approver reading a wall of near-identical
 * questions is an approver who taps rather than reads. A default is a claim
 * about which failure is worse, and the worse one here is inattentive approval
 * rather than a slower queue: pacing withholds nothing, because every request
 * stays pending in the log whether or not it has been shown, and `/queue`
 * lists the whole set on demand.
 */
export const TELEGRAM_DEFAULT_DELIVERY: TelegramDelivery = "paced";

/**
 * The delivery mode this policy declares, or the default.
 *
 * Fail-soft in the same direction as the two name resolvers above: a policy
 * that did not load declares nothing, and a delivery mode is not a permission,
 * so an unrelated policy typo must not decide how requests are shown. The
 * schema closes the enum, so a policy that LOADED can only carry one of the
 * two; anything else reaching here (a hand-built load result, a key from a
 * later version) falls back rather than being guessed at.
 */
export function telegramDeliveryFor(load: PolicyLoadResult): TelegramDelivery {
  if (!load.ok) return TELEGRAM_DEFAULT_DELIVERY;
  const declared = load.policy.channels?.["telegram"]?.["delivery"];
  if (declared === "paced" || declared === "burst") return declared;
  return TELEGRAM_DEFAULT_DELIVERY;
}

/**
 * The Telegram channel's credential manifest (APRV-79).
 *
 * The same shape an adapter declares (`core/credential-spec.ts`), for the same
 * reason: `approval setup channel telegram` runs the shared conversation in
 * `cli/setup-flow.ts`, and that conversation is DERIVED from a manifest. What
 * differs from an adapter's is the destination and not the vocabulary — a
 * channel's two values go to the OS keystore and `.approval/env`, because a
 * channel holds no state and its token is what unlocks the machine, while an
 * adapter's go to the vault (SPEC.md §4, §10.3, §10.4).
 *
 * The NAMES are the policy's, resolved through the two functions above, so the
 * checklist an operator reads names the variables their own policy declares.
 * A spec carries no value and no default on either entry: the token is the
 * operator's and the chat id is discovered.
 */
export function telegramCredentialSpecs(load: PolicyLoadResult): CredentialSpec[] {
  return [
    {
      name: telegramTokenEnvFor(load),
      kind: "secret",
      label: "bot token from @BotFather",
      describe:
        "the bot credential, stored in the OS keystore; this file records only where it lives",
      required: true,
    },
    {
      name: telegramChatEnvFor(load),
      kind: "config",
      label: "approver chat id",
      describe:
        "discovered from the bot's updates, written as a literal: a chat id is not a secret",
      required: true,
    },
  ];
}

/** A non-empty string under `channels.telegram.<key>`, or `null`. */
function declaredEnvName(load: PolicyLoadResult, key: string): string | null {
  if (!load.ok) return null;
  const telegram = load.policy.channels?.["telegram"];
  const declared = telegram === undefined ? undefined : telegram[key];
  return typeof declared === "string" && declared.length > 0 ? declared : null;
}
