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

/** A non-empty string under `channels.telegram.<key>`, or `null`. */
function declaredEnvName(load: PolicyLoadResult, key: string): string | null {
  if (!load.ok) return null;
  const telegram = load.policy.channels?.["telegram"];
  const declared = telegram === undefined ? undefined : telegram[key];
  return typeof declared === "string" && declared.length > 0 ? declared : null;
}
