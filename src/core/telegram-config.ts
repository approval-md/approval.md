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

/**
 * The environment variable the webhook `secret_token` is read from (APRV-424).
 *
 * ## Why this one is conventional and the two above are declared
 *
 * `token_env` and `chat_id_env` are policy keys because a machine may run two
 * gates against two bots, and the policy is where that pair is written down.
 * This is not that kind of key, for two reasons and in that order:
 *
 * 1. `channels.telegram` in `schema/policy.schema.json` is
 *    `additionalProperties: false`, so declaring a name there is a schema
 *    amendment, which is its own task. A capability does not get to arrive by
 *    widening a validated document on the way past.
 * 2. It is launch configuration in the sense of SPEC.md §11.1 invariant 7,
 *    which is where the precedent is: `APPROVAL_SENDER_KEY` (APRV-370) and
 *    `approval serve`'s two bearer credentials (APRV-421) are conventional
 *    names for the same reason. The host that launches one process per tenant
 *    sets it, exactly as it sets the bot token and the vault passphrase
 *    (`design/hosted-daemon-identity.md` §1.2), and two gates on one machine
 *    already have two environments rather than one.
 *
 * The VALUE never appears in a policy, a log, a record or a message. Telegram
 * constrains it to 1-256 characters of `A-Z a-z 0-9 _ -`; the verb refuses
 * anything outside that, and anything short enough to have been chosen by a
 * person rather than generated.
 */
export const TELEGRAM_WEBHOOK_SECRET_ENV = "APPROVAL_TG_WEBHOOK_SECRET";

/**
 * One webhook URL, reduced so two spellings of one endpoint compare equal
 * (APRV-424, review finding 6).
 *
 * The host is lowercased and one trailing slash is dropped from the path.
 * Nothing more is attempted: `normaliseApiBase` in `core/channel-owner.ts`
 * argues the same restraint, and the direction of the error matters here. Two
 * spellings that compare UNEQUAL turn a restart into a refusal, which an
 * operator clears with one flag; two that compare equal when they are
 * different endpoints would let a second host quietly take a first host's
 * taps, which nobody would see.
 *
 * The path's case is preserved, because a path is case-sensitive and a webhook
 * path is often a random token.
 *
 * `null` for anything that is not a URL, so a caller compares two known URLs
 * or refuses. A failed parse is never "equal to everything".
 */
export function normaliseWebhookUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/u, "") : url.pathname;
  return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${path}${url.search}`;
}

/**
 * A webhook PATH as it may be printed (APRV-424, reviews 1 to 3).
 *
 * With two segments or more, the first is kept and the rest is replaced:
 * `/hook/8Xk2-a-long-random-value` prints as `/hook/<path redacted>`, which is
 * enough for an operator to recognise their own endpoint while the bearer half
 * stays theirs. With exactly ONE segment the whole path is replaced, because a
 * single-segment path is the shape a tunnel's own token takes
 * (`https://host/8Xk2-a-long-random-value`) and keeping "the first segment"
 * there would print the token itself (third review, finding 3).
 *
 * The operator loses nothing either way. They typed it into `--url`.
 *
 * The second review found the first version printing the SERVED path verbatim,
 * on the argument that a path this process serves is a path the operator
 * chose. That argument is right about the operator and wrong about everyone
 * else who reads a terminal, a log aggregator or a pasted banner.
 */
export function redactWebhookPath(path: string): string {
  const segments = path
    .replace(/^\/+/u, "")
    .split("/")
    .filter((segment) => segment.length > 0);
  const first = segments[0];
  if (first === undefined) return "/";
  return segments.length === 1 ? "/<path redacted>" : `/${first}/<path redacted>`;
}

/**
 * A webhook URL as it may be printed (APRV-424, review finding 10).
 *
 * The origin, which carries no userinfo by construction, plus
 * {@link redactWebhookPath}'s reading of the path. Used by every line this
 * runtime writes about a webhook url: the start-up banner, the
 * `webhook_started` object, the registration refusal and the listener's
 * `webhook-registered` message, whether the url is this process's own or
 * another host's.
 *
 * A url carrying userinfo is refused at startup rather than printed; this is
 * the belt on that brace, because the origin never contains it.
 */
export function redactWebhookUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "<not a url>";
  }
  const query = url.search === "" ? "" : "?<query redacted>";
  return `${url.origin}${redactWebhookPath(url.pathname)}${query}`;
}

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
