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
