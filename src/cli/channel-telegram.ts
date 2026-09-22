/**
 * `approval channel telegram listen | health` — the runtime half of the
 * Telegram channel (SPEC.md §10.3, APRV-26).
 *
 * As everywhere else in this CLI, **no logic lives here**. The rendering and
 * the Bot API are `channels/telegram.ts`; turning a button press into an event
 * is `channels/contract.ts`'s `recordChannelDecision`, which calls the
 * human-only `decide()` in `core/gate.ts`. This file resolves configuration,
 * builds the pending queue, wires the two together, and chooses an exit code.
 *
 * Three things it does that the channel deliberately cannot:
 *
 * 1. **It reads the environment.** `APPROVAL_TG_TOKEN` and `APPROVAL_TG_CHAT`
 *    are read here and passed to the channel as values (SPEC.md §5.1: policy
 *    carries the env-var *names*, never the secrets). Nothing in `channels/`
 *    touches `process.env`.
 * 2. **It declares the identity the process itself acts under.** `--as` /
 *    `APPROVAL_HUMAN` is what this listener is, and it is what a decision is
 *    recorded as whenever the policy maps no sender for this channel: SPEC.md
 *    §11's config-declared identity, where the trust boundary is the local
 *    machine and everyone who can reach the configured chat can approve as that
 *    actor. Since APRV-324 a policy MAY map Telegram account ids to approvers,
 *    and then the decision is recorded against the person the operator attested
 *    the tapping account to, and an unmapped account is refused rather than
 *    recorded as this listener. Either way the choosing happens in
 *    `channels/contract.ts` against the attested policy, never here and never
 *    in the channel. Both settings are stated in `--help` because an operator
 *    has to be able to see which one they are in without reading the source.
 * 3. **It holds the token.** A grant mints a single-use execution token;
 *    `recordChannelDecision` returns it to *this* handler, which prints it on
 *    **stdout** and never hands it back to the channel. It is never sent to
 *    Telegram — see the module doc of `channels/telegram.ts` for why a chat
 *    transcript is not a credential store, and for the flag on that decision.
 *
 * ## Payload material — the store, and why `--payloads` still exists
 *
 * SPEC.md §6.2 records a `payload_hash` in the log and never the bytes, and
 * §10.4 requires a channel to present the full payload for a manual action. So
 * the bytes must come from somewhere the runtime can reach. Since APRV-28 that
 * somewhere is the payload store beside the log (`.approval/payloads/`, written
 * by `approval request --payload`), and a listener ordinarily needs no payload
 * flag at all. `--payloads` remains an override for bytes an operator holds
 * elsewhere: a JSON file mapping action key to that action's payload value,
 * consulted before the store. The tagger
 * (`channels/tagging.ts`) re-hashes whatever it is given and refuses anything
 * that does not match the recorded binding, so a wrong or stale file cannot put
 * different bytes in front of an approver than the token will execute — it
 * produces a visible skip instead. Requests whose material is missing are
 * reported on stderr and NOT delivered: a manual request rendered without its
 * payload would be exactly the §10.4 violation the contract refuses.
 *
 * ## Dispatch: where it lives, and why it lives here (APRV-55) — flagged
 *
 * SPEC.md §10.2 lists "dispatches channel notifications" among the daemon's
 * jobs. At v0.1 the reference runtime performs that dispatch **in this
 * listener**, on every poll cycle, and the placement is deliberate:
 *
 * 1. The listener already holds the channel connection (the bot token, the
 *    chat id) and the approver identity. The daemon holds neither, and giving
 *    it either would put a credential and a human identity into a process
 *    whose job is to read files and append events.
 * 2. The daemon is the sole writer of the log; dispatch appends nothing. Moving
 *    a read-and-send out of the daemon costs the single-writer stance nothing,
 *    because dispatch was never a write.
 * 3. A network round-trip inside the daemon's tick couples the projection loop
 *    to Telegram's availability. A slow Bot API would delay TTL expiry and
 *    write-back, which are the daemon's actual obligations.
 *
 * So this is an implementation placement, not a change to the daemon's stated
 * role: a later build MAY move dispatch into the daemon (or a supervisor) with
 * no change to the log or to any event shape. SPEC.md §10.3 records the same.
 *
 * ### The cycle
 *
 * {@link dispatchPending} runs before every `getUpdates` — the startup send and
 * every later cycle are the same call with the same state, the startup one
 * merely finding an empty delivered set. Each call **re-derives** the pending
 * queue from the verified log ({@link buildPendingQueue}), so which requests
 * are pending is always the log's answer and never this process's memory. A
 * request appended while the listener is running is therefore delivered on the
 * next cycle, without a restart; a request that was decided or whose TTL lapsed
 * simply stops appearing in the derivation and is never sent.
 *
 * What *is* remembered, and only in {@link DispatchState} for this process's
 * lifetime, is which action keys this listener has already put on the phone.
 * Losing that memory (a restart, a crash) re-sends everything still pending:
 * a duplicate on the phone, never silence. That direction is the whole design
 * (SPEC.md §10.3: channels hold no state that is a source of truth).
 *
 * APRV-196 made that re-send legible rather than rarer. The first batch a
 * process sends is preceded by one banner naming how many are coming, the
 * copies already in the chat keep working (`actionRefOf` in
 * `channels/telegram.ts` resolves their buttons to the same request), and the
 * bookkeeping above is pruned as requests settle and age out instead of growing
 * for the life of a listener that `approval up` keeps running for weeks.
 *
 * ### Send failures
 *
 * A key that fails to send stays undelivered, so the next cycle retries it.
 * There is **no attempt limit**: giving up would turn a transient outage into a
 * pending request no human ever sees, which is the one failure this project
 * exists to prevent. The retry rate is bounded by the poll cycle itself (the
 * long-poll timeout, or the channel's doubling backoff after a poll error), and
 * the stderr warnings are throttled after {@link DISPATCH_LOUD_ATTEMPTS}
 * consecutive failures for one key so a long outage cannot bury the terminal.
 * The one exception is the **startup** dispatch, which still exits non-zero on
 * a send failure: an operator who has just mistyped a chat id or a token should
 * learn it immediately rather than watch a listener retry forever.
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve as resolvePathSegments } from "node:path";

import { HUMAN_ACTOR_ENV, resolveHumanActor } from "../core/attest.js";
import type { DecideOptions } from "../core/gate.js";
import { assembleBatch } from "../channels/batch.js";
import {
  recordChannelDecision,
  refusedDecisionLine,
  type ChannelDecision,
  type ChannelRequest,
  type DecisionOutcome,
  type DeliveryId,
} from "../channels/contract.js";
import {
  ageText,
  buildPendingQueue,
  type ChannelTagRefusalCode,
  type TagOptions,
} from "../channels/tagging.js";
import {
  checkpointOfferFor,
  checkpointPromptLines,
  checkpointSignedLines,
  signCheckpointOffer,
  type CheckpointTap,
} from "./checkpoint-tap.js";
import {
  actionRefOf,
  decidedLine,
  groupForDigest,
  isMessageNotModified,
  isTelegramTerminalState,
  TelegramChannel,
  telegramChatEnvFor,
  telegramTokenEnvFor,
  TELEGRAM_NOT_RECORDED,
  TELEGRAM_REVIEW_DENIED,
  TELEGRAM_REVIEW_RECORDED,
  TELEGRAM_DEFAULT_API_BASE,
  TELEGRAM_TERMINAL_HEADLINES,
  utcClock,
  type CheckpointTapResponse,
  type ReviewCard,
  type ReviewTapResponse,
  type TelegramCommand,
  type TelegramConfig,
  type TelegramTerminalState,
} from "../channels/telegram.js";
import { openReviewCards } from "./audit-card.js";
import { reviewSample } from "../core/audit.js";
import {
  abandonedAfterMs,
  HOOK_DEFAULT_WAIT_MS,
  HOOK_RETRY_GRACE_MS,
} from "../core/harness-wait.js";
import {
  normaliseWebhookUrl,
  redactWebhookUrl,
  telegramDeliveryFor,
  type TelegramDelivery,
} from "../core/telegram-config.js";
import {
  reclaimDetail,
  takeChannelLease,
  type ChannelLease,
  type ChannelLeaseMode,
} from "../core/channel-lease.js";
import { loadPolicy } from "../core/policy-load.js";
import { valueFindings, type InstanceFinding } from "../core/instance.js";
import { defaultSourceRunner } from "../core/env-file.js";
import {
  claimBot,
  describeOwners,
  otherOwnersOf,
  ownedBot,
} from "../core/channel-owner.js";
import {
  actorForSender,
  recordedSenderFor,
  senderKeyFrom,
  type ChannelSender,
  type RecordedSender,
  type SenderSource,
} from "../core/sender-identity.js";
import {
  recordRefusedGesture,
  type RefusedGestureKind,
} from "../core/gesture-refusal.js";
import { attestationRefusal, checkAttestation } from "../core/attest.js";
import { promptLayoutFor } from "../core/prompt-layout.js";
import { passphraseEnvFor } from "../core/vault.js";
import {
  isAttestationActionKey,
  proposalRecords,
  proposalState,
} from "../core/policy-proposal.js";
import { payloadOf, readVerifiedRecords, requestState } from "../core/state.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind, type ParsedFlags } from "./args.js";
import { GLOSS_TIMEOUT_MS, type GlossRunner } from "./gloss.js";
import { attachGloss, glossAbsenceLine } from "./gloss-attach.js";
import {
  glossRunnerFromOptions,
  parseGlossOptions,
  type GlossOptions,
  type GlossRunnerFactoryOptions,
} from "./gloss-options.js";
import { EXIT_INTEGRITY, EXIT_IO, EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import {
  TELEGRAM_HEALTH_HELP,
  TELEGRAM_HELP,
  TELEGRAM_LISTEN_HELP,
} from "./help.js";
import type { Streams } from "./main.js";
import { DEFAULT_LOG_PATH, preflightLog, resolvePath } from "./paths.js";
import { style, tokenPanel, TOKEN_NOTICE_TELEGRAM } from "./style.js";
import { usageErrorText } from "./usage.js";

const LISTEN_FLAGS: Record<string, FlagKind> = {
  "--log": "string",
  "--policy": "string",
  "--dir": "string",
  "--as": "string",
  "--payloads": "string",
  "--api-base": "string",
  "--poll-timeout": "string",
  "--once": "boolean",
  /** APRV-390: start on a credential this instance did not configure. */
  "--allow-cross-instance": "boolean",
  "--gloss": "boolean",
  "--no-gloss": "boolean",
  "--gloss-provider": "string",
  "--gloss-model": "string",
  "--json": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

/**
 * The gloss runner this listener will use, as a spreadable fragment (APRV-197).
 *
 * ON unless `--no-gloss`. Two flags rather than one because the pair reads
 * honestly next to `channel cli`, where the default is the other way round:
 * `--gloss` is accepted here (and is simply the default restated) so that one
 * command line works on both verbs, and `--no-gloss` wins a tie, because the
 * flag that removes a language model from the path should never lose one.
 *
 * A fragment rather than a value so that "no runner" is the ABSENCE of the
 * key. {@link ListenSetup.gloss} being optional is what lets every
 * programmatic caller of `dispatchPending` spawn nothing without saying so.
 *
 * `passphraseEnv` is the name this policy's `vault.passphrase_env` gives, and
 * the only thing the APRV-207 scrub needs from a policy: the subprocess is
 * spawned starved either way, and naming the variable covers the deployment
 * that renamed it out from under the credential prefixes.
 */
export function glossWiring(
  flags: ParsedFlags,
  passphraseEnv: string | null = null,
  factories: Omit<GlossRunnerFactoryOptions, "passphraseEnv"> = {},
): { gloss?: GlossRunner } {
  const selected = parseGlossOptions(flags, true);
  if (!selected.ok) return {};
  return glossWiringFor(selected.options, passphraseEnv, factories);
}

function glossWiringFor(
  selection: GlossOptions,
  passphraseEnv: string | null,
  factories: Omit<GlossRunnerFactoryOptions, "passphraseEnv"> = {},
): { gloss?: GlossRunner } {
  const gloss = glossRunnerFromOptions(selection, { ...factories, passphraseEnv });
  return gloss === undefined ? {} : { gloss };
}

function usageError(streams: Streams, json: boolean, message: string, helpText: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "usage", message } })}\n`);
  else streams.err(usageErrorText(message, helpText));
  return EXIT_USAGE;
}

function ioError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "io", message } })}\n`);
  else streams.err(`approval: ${message}\n`);
  return EXIT_IO;
}

function integrityError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "integrity", message } })}\n`);
  else streams.err(`approval: ${message}\n`);
  return EXIT_INTEGRITY;
}

function absolute(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolvePathSegments(cwd, value);
}

/** A non-empty environment value, or `null`. Whitespace-only counts as unset. */
function env(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value.trim().length === 0 ? null : value.trim();
}

// ---------------------------------------------------------------------------
// approval channel telegram listen
// ---------------------------------------------------------------------------

export interface ListenSetup {
  channel: TelegramChannel;
  logPath: string;
  actor: string;
  json: boolean;
  once: boolean;
  gateOptions: DecideOptions;
  tagOptions: TagOptions;
  /**
   * How this listener puts the pending set in front of the approver (APRV-216):
   * `paced`, one question at a time, or `burst`, everything not yet sent on
   * every cycle.
   *
   * REQUIRED rather than defaulted, so that every construction site states
   * which of the two it means. The policy's answer is resolved once, in
   * {@link prepareListen}, and the default that answer falls back to lives in
   * `core/telegram-config.ts` beside the other Telegram policy readings.
   */
  delivery: TelegramDelivery;
  /**
   * Cross-instance findings `--allow-cross-instance` let through (APRV-390).
   *
   * Empty on every ordinary start, because a finding without the flag is a
   * refusal. Carried on the setup rather than printed inside `prepareListen`
   * for the reason that function prints nothing at all: `approval up` and
   * `approval channel telegram listen` choose their own stream, and this is
   * the one thing an overridden refusal still owes the operator.
   */
  crossInstance: readonly InstanceFinding[];
  /**
   * `--allow-cross-instance` as passed (APRV-390).
   *
   * Carried as well as applied, because the flag overrides TWO refusals and
   * only one of them can be decided synchronously. The credential check is
   * `prepareListen`'s; the bot-ownership claim needs a `getMe`, so it happens
   * later and has to be able to ask whether the operator already said yes.
   */
  allowCrossInstance: boolean;
  /**
   * The Bot API base this listener talks to (APRV-390).
   *
   * Part of the bot's identity in the ownership registry, because a bot id is
   * unique within one Bot API deployment and nothing more.
   */
  apiBase: string;
  /**
   * How the one-sentence model gloss is obtained (APRV-144).
   *
   * OPT-IN, and absent by default. The verb wires in the production runner
   * (`claude -p --model haiku`, hard timeout, failing toward absence); every
   * other caller — the test suite above all — gets no gloss unless it hands
   * over a runner. A default that spawned would make a subprocess an implicit
   * dependency of anything that drives a dispatch cycle, and would put a model
   * inside a test suite that must never invoke one.
   *
   * Injectable so the tests drive both branches, answered and absent, against
   * a stub.
   */
  gloss?: GlossRunner;
  /**
   * Where a checkpoint key may come from, and where the cadence is read
   * (APRV-257).
   *
   * Present at every construction site, because every one of them knows a log
   * path and a policy. Whether a checkpoint is ever OFFERED is the policy's
   * answer — `audit.checkpoint_every` plus `audit.checkpoint_keys` — and
   * {@link checkpointOfferFor} gives up before it walks a log when the policy
   * names neither, so a gate that has not turned checkpoints on pays a policy
   * load per cycle and nothing else.
   */
  checkpoint: CheckpointTap;
}

/**
 * Claim this listener's bot before it polls (APRV-390, extended by APRV-424).
 *
 * Three questions, in order, and each one has its own authority:
 *
 * 1. **Does anything else in THIS gate already hold the Telegram transport?**
 *    A lockfile in the gate's own `daemon/` directory (`core/channel-lease.ts`)
 *    answers it, and the answer is per PROCESS. This is the check the review of
 *    APRV-424 added, and the hole it closes is the one neither of the other two
 *    could see: an `approval up` long-polling and an `approval channel telegram
 *    webhook` started in the same project pass both of them — `getWebhookInfo`
 *    is empty while the poller is the one running, and the ownership registry
 *    compares instance ids, which are equal because it IS the same instance —
 *    and then each runs its own dispatch cycle over its own state against one
 *    log, so every request reaches the phone twice under two nonces and only
 *    one copy can resolve a tap.
 * 2. **What is the Bot API delivering this bot's updates to?** `getWebhookInfo`
 *    answers it, and it is the only thing that can see a webhook registered
 *    from another machine. A webhook beats a poller outright — `getUpdates` is
 *    refused while one is set — so any registration refuses a poller.
 * 3. **Does another INSTANCE on this machine hold this bot?** `getMe` plus the
 *    per-machine registry answers it (APRV-390's incident: two gates, one
 *    token, two names, a 409 on every poll).
 *
 * ## An unreachable Bot API: fail-soft for a poller, fail-closed for a webhook
 *
 * A `getMe` or a `getWebhookInfo` that fails says nothing about ownership. The
 * machine may be behind a captive portal, the API may be rate-limiting, the
 * network may be down for four seconds. For a POLLER, refusing on that would
 * mean a transient network fault took the phone channel down until somebody
 * noticed, in exchange for no safety: an unreachable Bot API is also a
 * `getUpdates` that cannot conflict with anything, and the HTTP 409 the loop
 * already reports is the backstop. So the poller says what happened and starts.
 *
 * For the WEBHOOK VERB there is no such backstop, and the review of APRV-424
 * turned this direction around. Its next act is `setWebhook`, which overwrites
 * whatever registration exists without asking, so proceeding on an unknown
 * answer is proceeding to take another host's taps with no error anywhere. A
 * probe it could not make is therefore a refusal (`webhook-probe-failed`), and
 * the operator retries or passes `--reclaim` deliberately.
 */
export async function claimListenerBot(
  setup: ListenSetup,
  report: (message: string) => void,
  options: {
    /**
     * The webhook URL THIS process is about to register, when it is a webhook
     * runner rather than a poller (APRV-424).
     *
     * Absent for a poller. Present for the webhook verb, and then it is the
     * url a `--reclaim` is measured against: `setWebhook` is idempotent, so a
     * restart re-registering its own url is the ordinary case, while a
     * DIFFERENT url is a second host about to take the first host's taps.
     */
    webhookUrl?: string;
    /**
     * Register over an existing webhook (`--reclaim`, APRV-424 review finding
     * 6).
     *
     * Without it, ANY registration refuses — including one at the same url,
     * which used to be waved through on a bare string compare. Two hosts
     * sharing one configuration both passed that check, the second overwrote
     * the first's `secret_token`, and from then on every real tap arrived at
     * the first host with a secret it did not recognise: a forgery, as far as
     * it could tell, on every press of a button that had worked an hour
     * earlier. So taking over is now a thing the operator says out loud.
     */
    reclaim?: boolean;
    /**
     * Which transport this process is about to run, for the lease.
     *
     * Derived from {@link webhookUrl} when it is not given, because the two
     * callers that pass a url are the two that run a webhook.
     */
    mode?: ChannelLeaseMode;
  } = {},
): Promise<ClaimedListenerBot> {
  const mode: ChannelLeaseMode = options.mode ?? (options.webhookUrl === undefined ? "poll" : "webhook");

  // The local, deterministic question first: it needs no network, and a
  // refusal here is one an operator can act on without waiting for a round
  // trip. Released again below if a later check refuses, so a refused start
  // never leaves a lease behind for the next one to reclaim.
  const leased = takeChannelLease(setup.logPath, mode);
  if (!leased.ok) {
    return {
      ok: false,
      code: leased.code,
      message: leased.message,
    };
  }
  if (leased.reclaimed !== null && leased.reclaimedBecause !== null) {
    report(`approval: ${reclaimDetail(leased.reclaimed, leased.reclaimedBecause)}`);
  }
  /**
   * Did THIS gate's own webhook runner die without removing its registration?
   *
   * The evidence is the lease this take just reclaimed: a record in this
   * gate's own lockfile, written by a webhook runner, whose process is no
   * longer the one holding it. A SIGKILL leaves exactly that, plus a
   * registration at the url the dead process had registered, and without this
   * every restart would refuse `webhook-registered` until an operator baked
   * `--reclaim` into the unit file — which would retire finding 6's protection
   * for good, in exchange for a crash recovery.
   *
   * It is deliberately narrow. Same gate (it is the same lockfile), same
   * transport (a dead poller proves nothing about a registration), and the
   * url still has to match after normalisation. Anything else keeps refusing.
   */
  const ownWebhookDied = leased.reclaimed !== null && leased.reclaimed.mode === "webhook";
  const release = (): void => leased.lease.release();
  const refuse = (code: ListenRefusalCode, message: string): ClaimedListenerBot => {
    release();
    return { ok: false, code, message };
  };

  let identity: { id: string; username: string };
  try {
    identity = await setup.channel.identify();
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    if (mode === "webhook") {
      // Fail closed: see the module note above. `setWebhook` would overwrite a
      // registration this process could not see.
      return refuse(
        "webhook-probe-failed",
        `telegram getMe could not be reached (${detail}), so which bot this token names and what is already receiving its updates are both unknown. This verb registers a webhook, and setWebhook overwrites whatever is registered without reporting it, so it does not run on an unknown answer: fix the connection and start again, or pass --reclaim to take the bot deliberately`,
      );
    }
    report(
      `approval: telegram getMe could not be reached (${detail}), so which bot this token names is unknown and no ownership was recorded; starting anyway`,
    );
    return { ok: true, lease: leased.lease };
  }
  if (identity.id.length === 0) {
    if (mode === "webhook") {
      return refuse(
        "webhook-probe-failed",
        "telegram getMe answered without a bot id, so which bot this token names is unknown. This verb registers a webhook over whatever is already registered, and will not do that on an unknown answer",
      );
    }
    report(
      "approval: telegram getMe answered without a bot id, so no ownership was recorded; starting anyway",
    );
    return { ok: true, lease: leased.lease };
  }

  // APRV-424, and before the ownership claim: the registry answers "which
  // process on THIS machine holds this bot", and the Bot API answers "what is
  // this bot's updates going to at all". A webhook beats both — `getUpdates`
  // is refused while one is set — so a listener started here would receive
  // nothing whoever else is or is not running locally.
  const hooked = await webhookOwner(setup);
  if (hooked.state === "unknown") {
    if (mode === "webhook") {
      return refuse(
        "webhook-probe-failed",
        `telegram getWebhookInfo could not be reached (${hooked.detail}), so whether another host's webhook holds this bot is unknown. setWebhook would overwrite it without saying so, and the displaced receiver would simply stop being posted to, so this verb refuses rather than guessing: try again, or pass --reclaim to register over whatever is there`,
      );
    }
    // The poller's documented fail-soft (see the module note): what a missed
    // probe costs is the clear refusal, and the 409 path is still there.
    report(
      `approval: telegram getWebhookInfo could not be reached (${hooked.detail}), so whether a webhook holds this bot is unknown; starting anyway`,
    );
  }
  if (hooked.state === "registered") {
    const queued =
      hooked.pendingUpdateCount === 0
        ? ""
        : ` (${String(hooked.pendingUpdateCount)} update(s) are queued for it)`;
    // Origin plus a redacted path, never the url as the Bot API spelled it:
    // this is somebody else's registration, its path may itself be a bearer
    // value (review finding 10), and the origin is what tells hosts apart.
    const shown = redactWebhookUrl(hooked.url);
    if (options.webhookUrl === undefined) {
      return refuse(
        "webhook-registered",
        `telegram ${identity.username} delivers its updates to a webhook at ${shown}, and the Bot API refuses getUpdates while one is set, so this listener would receive no tap at all${queued}. Long polling and a webhook are alternatives per bot: stop the \`approval channel telegram webhook\` process, which removes the webhook as it exits, or give this instance its own bot with \`approval setup channel telegram\``,
      );
    }
    const mine = normaliseWebhookUrl(options.webhookUrl);
    const theirs = normaliseWebhookUrl(hooked.url);
    const same = mine !== null && theirs !== null && mine === theirs;
    if (same && ownWebhookDied) {
      // The restart case, and the only one that needs no flag: this gate's own
      // webhook runner was killed without the chance to call `deleteWebhook`,
      // and what is registered is the url it left behind.
      report(
        `approval: the webhook at ${shown} is the one this gate's own runner registered before it died (its lease was reclaimed from pid ${String(
          leased.reclaimed?.pid ?? 0,
        )}); re-registering the same url, which needs no --reclaim`,
      );
    } else if (options.reclaim !== true) {
      return refuse(
        "webhook-registered",
        `telegram ${identity.username} already delivers its updates to a webhook at ${shown}${queued}. ${
          same
            ? "That is the url this process was asked to register, which looks like a restart and may not be one: two hosts running one configuration both read this as their own, the second overwrites the first's secret_token, and from then on every real tap reaches the first host as a forgery"
            : "This process was asked to register a different url, and a bot has exactly one webhook: registering would silently take the taps away from whatever is serving that one"
        }. Telegram allows one webhook per bot and keeps the last registration. Stop the other process, or pass --reclaim to register over it deliberately`,
      );
    } else {
      report(
        same
          ? `approval: --reclaim: re-registering ${shown}, which is the url already registered for ${identity.username}`
          : `approval: --reclaim: registering over the webhook at ${shown}; whatever is serving it stops being posted to, because Telegram keeps only the last registration for ${identity.username}`,
      );
    }
  }

  const claim = claimBot(setup.logPath, {
    channel: "telegram",
    botId: identity.id,
    username: identity.username,
    apiBase: setup.apiBase,
  });
  if (!claim.ok) {
    if (!setup.allowCrossInstance) {
      return refuse("bot-owned-elsewhere", claim.message);
    }
    // The deliberate case. It says what it is doing, and it does NOT record a
    // second claim: the registry answers "who owns this bot", and two owners
    // is the state it exists to report rather than a state to write down.
    report(`approval: --allow-cross-instance: starting anyway — ${claim.message}`);
    return { ok: true, lease: leased.lease };
  }
  report(
    `approval: telegram ${identity.username} (bot id ${identity.id}) is this instance's own; no update was consumed by this check`,
  );
  return { ok: true, lease: leased.lease };
}

/**
 * What {@link claimListenerBot} answers.
 *
 * The lease travels with the success, because the caller is the only thing
 * that knows when this process has stopped receiving: `runListener`,
 * `approval up` and `runWebhook` each release it on their way out, and a
 * refusal releases nothing because it took nothing.
 */
export type ClaimedListenerBot =
  | { ok: true; lease: ChannelLease }
  | { ok: false; code: ListenRefusalCode; message: string };

/**
 * What the Bot API says is receiving this bot's updates (APRV-424).
 *
 * THREE states rather than two, which is review finding 8. The first version
 * collapsed "nothing is registered" and "the probe failed" into `null`, and
 * the webhook verb then treated an unknown answer as a free one: it went on to
 * `setWebhook`, which silently overwrites a registration this process never
 * saw. The states are now distinct, and each caller decides what an unknown
 * one means — fail-soft for the poller, which has the 409 backstop, fail-closed
 * for the verb, which has none.
 */
type WebhookProbe =
  | { state: "none" }
  | { state: "registered"; url: string; pendingUpdateCount: number }
  | { state: "unknown"; detail: string };

async function webhookOwner(setup: ListenSetup): Promise<WebhookProbe> {
  let info: { url: string; pendingUpdateCount: number };
  try {
    info = await setup.channel.webhookInfo();
  } catch (cause) {
    return { state: "unknown", detail: cause instanceof Error ? cause.message : String(cause) };
  }
  return info.url.length === 0
    ? { state: "none" }
    : { state: "registered", url: info.url, pendingUpdateCount: info.pendingUpdateCount };
}

/**
 * What to append to a runtime 409, naming the other instance if one is known.
 *
 * Read at the moment of the conflict rather than captured at start-up, because
 * the other gate may have claimed the bot in between: the registry is the only
 * thing that knows, and it is cheap to re-read.
 */
export function conflictAdviceFor(setup: ListenSetup): () => string | null {
  return (): string | null => {
    const mine = ownedBot(setup.logPath, "telegram");
    if (mine === null) return null;
    const others = otherOwnersOf(setup.logPath, mine.botId, mine.apiBase);
    return others.length === 0
      ? `this instance is ${mine.instanceHome} (instance ${mine.instanceId}) on ${mine.username}, and nothing else on this machine has claimed it — the other poller is on another machine, or was started outside this runtime`
      : `${mine.instanceHome} (instance ${mine.instanceId}) and ${describeOwners(others)} have both claimed ${mine.username}; stop one of them`;
  };
}

function payloadSource(
  resolved: string | null,
): { ok: true; source: TagOptions["payload"] } | { ok: false; message: string } {
  if (resolved === null) return { ok: true, source: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, "utf8"));
  } catch (cause) {
    return {
      ok: false,
      message: `--payloads ${resolved} could not be read as JSON: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      message: `--payloads ${resolved} must hold a JSON object mapping action key to that action's payload value`,
    };
  }
  const table = parsed as Record<string, unknown>;
  return { ok: true, source: (actionKey: string) => table[actionKey] };
}

// ---------------------------------------------------------------------------
// Preparation, shared with the ambient runtime (APRV-110)
// ---------------------------------------------------------------------------

/**
 * Why a listener could not be built. A closed union, because more than one
 * caller now branches on it: the verb turns each into an exit code, and
 * `approval up` turns each into a part it will not start (SPEC.md §11.1
 * invariant 6 — a refusal is machine-readable and distinct).
 */
export const LISTEN_REFUSAL_CODES = [
  /** A credential variable the policy names is unset or empty. */
  "not-configured",
  /** No `human:<id>` was declared, so nothing could be recorded against one. */
  "no-identity",
  /** `--poll-timeout` was not a whole number of seconds. */
  "poll-timeout",
  /** The log could not be read (or its directory does not exist). */
  "log-unreadable",
  /** `--payloads` did not hold a JSON object of action key -> payload. */
  "payloads-unreadable",
  /**
   * A credential variable holds a value this instance did not configure
   * (APRV-390): it was exported before the process started and is not this
   * instance's own `approval env` export, or `.approval/env` names another
   * instance's keystore item. Refused rather than warned since APRV-390 — the
   * warning is what let a demo gate spend an evening on the production bot.
   * `--allow-cross-instance` is the deliberate case.
   */
  "cross-instance-credential",
  /**
   * `getMe` named a bot another instance on this machine has already claimed
   * (APRV-390). Refused BEFORE the first `getUpdates`, so the operator reads
   * which two gates are involved instead of an HTTP 409 loop.
   */
  "bot-owned-elsewhere",
  /**
   * This bot's updates are being delivered to a webhook (APRV-424).
   *
   * The two transports are alternatives per bot: the Bot API refuses
   * `getUpdates` outright while a webhook is set, so a listener that started
   * here would print a 409 every few seconds and receive not one tap. Refused
   * BEFORE the first poll, in the same preflight and for the same reason
   * `bot-owned-elsewhere` is, so the operator reads which transport owns the
   * bot instead of a status code.
   *
   * Since the review of APRV-424 it carries a second, local source: the
   * transport lease in this gate's own `daemon/` directory, when the process
   * holding it is a webhook runner. Same fact, same repair, so the same code.
   */
  "webhook-registered",
  /**
   * A long-poll listener in THIS gate already holds the Telegram transport
   * (APRV-424 review finding 1).
   *
   * The counterpart to `webhook-registered`, from the same lease. It is what
   * the webhook verb meets when an `approval up` or an `approval channel
   * telegram listen` is already running in the same project — the case
   * `getWebhookInfo` cannot see (nothing is registered yet) and the ownership
   * registry cannot see either (it is the same instance). Two of them on one
   * log put every prompt on the phone twice, under two nonces, and only one
   * copy can resolve a tap.
   */
  "telegram-poller-running",
  /**
   * The transport lease could not be taken at all (APRV-424 review finding 1).
   *
   * A `daemon/` directory that cannot be created, a lockfile that cannot be
   * written. Unlike the bot registry, whose absence is the status quo, this
   * file is the only thing keeping one gate from running two transports, so a
   * gate that cannot hold one does not start.
   */
  "telegram-lease-unavailable",
  /**
   * The webhook verb could not learn what already holds this bot (APRV-424
   * review finding 8).
   *
   * `getMe` or `getWebhookInfo` failed, and the next act would have been a
   * `setWebhook` that overwrites a registration nobody saw. A poller keeps its
   * fail-soft on the same failure, because an unreachable Bot API is also a
   * `getUpdates` that cannot conflict and the HTTP 409 loop is its backstop;
   * this verb has no backstop, so it refuses.
   */
  "webhook-probe-failed",
] as const;

export type ListenRefusalCode = (typeof LISTEN_REFUSAL_CODES)[number];

/** Everything {@link prepareListen} needs, already resolved to absolute paths. */
export interface ListenRequest {
  /** The log to derive the queue from and append decisions to. */
  logPath: string;
  /** Policy location, with `loadPolicy`'s semantics. */
  policy: { dir?: string; file?: string };
  /** `--as` as typed, or `null` to fall back to `APPROVAL_HUMAN`. */
  as: string | null;
  /** `--payloads`, already absolute, or `null` for the payload store alone. */
  payloads: string | null;
  /** `--api-base`, or `null` for the Bot API. */
  apiBase: string | null;
  /** `--poll-timeout` as typed, or `null` for the channel's own default. */
  pollTimeout: string | null;
  once: boolean;
  json: boolean;
  /**
   * `--allow-cross-instance` (APRV-390): start on a credential this instance
   * did not configure, saying so, instead of refusing.
   */
  allowCrossInstance?: boolean;
  /** Where the channel's operational complaints go. Ordinarily stderr. */
  log(message: string): void;
  /** The gloss runner, if the caller wants one. See {@link ListenSetup.gloss}. */
  gloss?: GlossRunner;
}

export type ListenPreparation =
  | { ok: true; setup: ListenSetup }
  | { ok: false; code: ListenRefusalCode; message: string };

/**
 * Everything that can fail without touching the network, in order.
 *
 * Deliberately sequential and deliberately synchronous: an operator who typed
 * the wrong thing learns it before a bot message is sent, and the async half
 * below can then assume its configuration is whole.
 *
 * It PRINTS NOTHING and CHOOSES NO EXIT CODE (APRV-110). The verb below turns
 * each refusal into the usage or I/O error it always was; `approval up` turns
 * the same refusal into a channel it declines to start, reported in doctor's
 * vocabulary while the other parts carry on. Two callers, one set of checks,
 * one set of sentences — which is the only way the two surfaces can agree about
 * what "telegram is not configured" means.
 */
export function prepareListen(request: ListenRequest): ListenPreparation {
  // Configuration is environment-only: policy names the variables, never the
  // values (SPEC.md §5.1), and there is no flag that would put a bot token in
  // a shell history or a process listing. A policy that fails to load names
  // nothing and the reference defaults apply — the load is fail-closed for
  // autonomy and budgets, and a variable name is not a permission.
  const policyLoad = loadPolicy(request.policy);
  const tokenEnv = telegramTokenEnvFor(policyLoad);
  const chatEnv = telegramChatEnvFor(policyLoad);
  const token = env(tokenEnv);
  const chatId = env(chatEnv);
  if (token === null || chatId === null) {
    const missing = [
      token === null ? tokenEnv : null,
      chatId === null ? chatEnv : null,
    ].filter((name): name is string => name !== null);
    return {
      ok: false,
      code: "not-configured",
      message: `telegram is not configured: ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} unset or empty (both ${tokenEnv} and ${chatEnv} are required; APPROVAL.md carries only their names)`,
    };
  }

  // APRV-390. WHOSE credentials are these? `instanceFindings` answers from
  // names alone — no value is read, compared or printed — and until this task
  // its answer was a warning `approval up` printed on the way past. It is a
  // refusal now. The incident it is named after is a demo gate that started on
  // the primary's exported token and long-polled the primary's bot: the
  // warning was on the operator's terminal the whole time, above a process
  // that had already started. An override exists because feeding a daemon from
  // a shell profile is a deliberate, supported thing to do; what was missing
  // is that it now has to be said out loud.
  //
  // `valueFindings` and not `instanceFindings`: this is the one caller that is
  // about to USE the values, so it is allowed to resolve the file and compare
  // (APRV-390, second round). Comparing is what tells a stale export — the
  // shell holding a token the keychain has since replaced, which `approval env`
  // will never override — from an honest one, and what stops the correct `eval
  // "$(approval env)"` ritual being reported as a finding. `approval doctor`
  // keeps the name-only rule, because a diagnostic may not block on an unlock
  // dialog. No value is printed here or anywhere below.
  const crossInstance = valueFindings(request.logPath, policyLoad, defaultSourceRunner);
  if (crossInstance.length > 0 && request.allowCrossInstance !== true) {
    const stale = crossInstance.some((finding) => finding.kind === "stale-export");
    return {
      ok: false,
      code: "cross-instance-credential",
      message: `${crossInstance.map((finding) => finding.detail).join("; ")}. ${
        stale
          ? "A stale export is why a token re-stored in the keystore can still answer 401: `approval env` never overrides a variable this shell has already exported."
          : "Two gates on one bot token both long-poll it, their getUpdates offsets acknowledge each other's updates, and an approval tap is answered by whichever listener asked first."
      } Fix it with one of: \`unset ${crossInstance.map((finding) => finding.variable).join(" ")}\` and then \`eval "$(approval env)"\` in this shell; a fresh shell that has never exported it; or \`approval setup channel telegram\` to give this instance its own bot. Pass --allow-cross-instance to start anyway`,
    };
  }

  const actor = resolveHumanActor(request.as === null ? {} : { actor: request.as });
  if (actor === null) {
    return {
      ok: false,
      code: "no-identity",
      message:
        request.as === null
          ? `no human identity: set ${HUMAN_ACTOR_ENV}=human:<id> or pass --as human:<id>. Every decision this listener records is recorded against it, and nothing here authenticates it`
          : `--as expects a human identity matching human:<id>, got ${JSON.stringify(request.as)}; approvals are human-only`,
    };
  }

  const pollFlag = request.pollTimeout;
  if (pollFlag !== null && !/^\d+$/u.test(pollFlag)) {
    return {
      ok: false,
      code: "poll-timeout",
      message: `--poll-timeout expects a whole number of seconds, got ${JSON.stringify(pollFlag)}`,
    };
  }

  const check = preflightLog(request.logPath);
  if (!check.ok) return { ok: false, code: "log-unreadable", message: check.message };

  const payloads = payloadSource(request.payloads);
  if (!payloads.ok) {
    return { ok: false, code: "payloads-unreadable", message: payloads.message };
  }

  const config: TelegramConfig = {
    token,
    chatId,
    ...(request.apiBase === null ? {} : { apiBase: request.apiBase }),
    ...(pollFlag === null ? {} : { pollTimeoutSeconds: Number.parseInt(pollFlag, 10) }),
    log: request.log,
    // APRV-135. The policy is already loaded above for the variable names; the
    // TTL rides along so the listener can forget delivery bookkeeping no
    // callback can still be honoured against. The channel reads no policy file
    // of its own, and a policy that failed to load declares no TTL, which makes
    // the sweep narrower rather than wider.
    approvalTtlMs: policyLoad.ok ? policyLoad.durations.approvalTtlMs : null,
    // APRV-196. The channel answers a tap on a copy it is not holding open by
    // asking what the LOG says, which is the only thing that knows. Wired here
    // because the log path lives here and nothing under `channels/` reads one.
    describeAction: describeActionFor(request.logPath),
    // APRV-218. Which rows the prompt shows, from `channels.telegram.prompt`,
    // off the same load the credential NAMES and the TTL came from: one read of
    // the policy file answers every question this preparation asks of it. A
    // policy that failed to load declares no layout and gets the slimmed
    // default, because a layout is not a permission and an unrelated typo in a
    // class rule must not silently redecorate a phone screen.
    layout: promptLayoutFor(policyLoad, "telegram"),
  };

  return {
    ok: true,
    setup: {
      channel: new TelegramChannel(config),
      logPath: request.logPath,
      actor,
      json: request.json,
      once: request.once,
      // APRV-216. Read from the policy that was already loaded above for the
      // credential NAMES, so one load answers every question this preparation
      // asks of the policy file, and a policy that failed to load leaves the
      // default (paced) in force rather than a mode nobody chose.
      delivery: telegramDeliveryFor(policyLoad),
      // APRV-390. Empty unless --allow-cross-instance let a finding through.
      crossInstance,
      allowCrossInstance: request.allowCrossInstance === true,
      apiBase: request.apiBase ?? TELEGRAM_DEFAULT_API_BASE,

      gateOptions: { policy: request.policy },
      tagOptions: {
        policy: request.policy,
        ...(payloads.source === undefined ? {} : { payload: payloads.source }),
      },
      ...(request.gloss === undefined ? {} : { gloss: request.gloss }),
      // APRV-257. The tap's whole configuration: the log to sign, the policy to
      // read the cadence and the keys from, and where the private half may come
      // from — which is the vault beside this log unless an operator said
      // otherwise. No key is read here: custody is resolved at TAP time, so a
      // prompt sitting on a phone holds no key material anywhere.
      checkpoint: {
        logPath: request.logPath,
        policy: request.policy,
        keyFile: null,
        vault: null,
      },
    },
  };
}

/**
 * What to tell a human who tapped a button for an action this listener is not
 * holding open (APRV-196).
 *
 * The one place a stale tap gets a real answer instead of a shrug. It reads the
 * VERIFIED log (SPEC.md §11.1(1): a sentence a human reads about what the log
 * says is derived from a log that verified, or it is not derived at all) and
 * answers from `requestState`, the same derivation the gate and the pending
 * queue use. Nothing here decides anything, nothing is appended, and nothing is
 * remembered between calls: an unreadable log answers `null`, which the channel
 * renders as its "not open here" toast.
 *
 * The argument is an action REFERENCE and never a key. The string came off the
 * network, so this hashes the keys the log actually carries and looks for a
 * match; a caller cannot make it describe a request by naming one, and a ref
 * matching nothing simply answers `null`.
 *
 * The walk is over `approval.requested` records, which is the set of things
 * that could ever have had a button. Run only on a stale tap, which is rare by
 * construction.
 */
export function describeActionFor(logPath: string): (actionRef: string) => string | null {
  return (actionRef: string) => {
    const read = readVerifiedRecords(logPath);
    if (!read.ok) return null;
    const now = new Date().toISOString();
    for (const record of read.records) {
      if (record.event !== "approval.requested") continue;
      const key = record.action_key ?? payloadOf(record)["action_key"];
      if (typeof key !== "string" || actionRefOf(key) !== actionRef) continue;
      const derived = requestState(read.records, key, now, null);
      switch (derived.state) {
        case "granted":
        case "rejected":
        case "revoked":
          return `Already ${derived.state} — the recorded answer stands, and nothing was recorded for this tap.`;
        case "expired":
          return "Expired — the approval window closed before an answer arrived; nothing was recorded.";
        case "withdrawn":
          return "Withdrawn — the requester took this back and is no longer waiting; nothing was recorded.";
        case "requested":
          return "Still pending — this copy's buttons are not live here. Tap the newest copy of this request in this chat.";
        default:
          return null;
      }
    }
    return null;
  };
}

/** The verb's own front matter: flags in, a prepared listener or an exit code out. */
function setUp(
  argv: string[],
  streams: Streams,
  cwd: string,
): { kind: "handled"; code: number } | { kind: "run"; setup: ListenSetup } {
  const json = argv.includes("--json");
  const parsed = parseFlags(argv, LISTEN_FLAGS);
  if (!parsed.ok) {
    return { kind: "handled", code: usageError(streams, json, parsed.message, TELEGRAM_LISTEN_HELP) };
  }
  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${TELEGRAM_LISTEN_HELP}\n`);
    return { kind: "handled", code: EXIT_OK };
  }
  const extra = parsed.positionals[0];
  if (extra !== undefined) {
    return {
      kind: "handled",
      code: usageError(
        streams,
        json,
        `unexpected argument ${JSON.stringify(extra)}`,
        TELEGRAM_LISTEN_HELP,
      ),
    };
  }

  const flags = parsed.flags;
  const selectedGloss = parseGlossOptions(flags, true);
  if (!selectedGloss.ok) {
    return {
      kind: "handled",
      code: usageError(streams, json, selectedGloss.message, TELEGRAM_LISTEN_HELP),
    };
  }

  // Resolved here rather than after the log preflight because the policy is
  // what NAMES the credential variables, and a message about a missing
  // variable must name the one this policy actually asked for.
  const policyFlag = stringFlag(flags, "--policy");
  const dirFlag = stringFlag(flags, "--dir");
  const policy =
    policyFlag !== null
      ? { file: absolute(policyFlag, cwd) }
      : { dir: dirFlag === null ? cwd : absolute(dirFlag, cwd) };

  const payloadsFlag = stringFlag(flags, "--payloads");
  const prepared = prepareListen({
    logPath: resolvePath(stringFlag(flags, "--log"), DEFAULT_LOG_PATH, cwd),
    policy,
    as: stringFlag(flags, "--as"),
    payloads: payloadsFlag === null ? null : absolute(payloadsFlag, cwd),
    apiBase: stringFlag(flags, "--api-base"),
    pollTimeout: stringFlag(flags, "--poll-timeout"),
    once: boolFlag(flags, "--once"),
    json,
    // APRV-390.
    allowCrossInstance: boolFlag(flags, "--allow-cross-instance"),
    log: (message: string) => streams.err(`${message}\n`),
    // APRV-144, on by default, `--no-gloss` to turn it off (APRV-197).
    //
    // The listener is the surface the gloss was asked for: the phone is where
    // an approver reads a request they did not watch being made, with none of
    // the terminal's context around it. The measured 10-15 seconds a gloss
    // costs (see GLOSS_TIMEOUT_MS) is spent inside a dispatch cycle that is
    // already waiting on the network, and it blocks nobody — which is exactly
    // why the terminal walker makes the opposite choice and asks only under
    // `--gloss`: there, a person is sitting in front of the pause.
    //
    // The verb is still the only place a runner is wired: `dispatchPending`
    // defaults to none, so no programmatic driver spawns a subprocess by
    // importing it. Tests that drive THIS function pass `--no-gloss` or set a
    // stub, which is what {@link listenGlossRunner} is for.
    ...glossWiringFor(selectedGloss.options, passphraseEnvFor(loadPolicy(policy)), {
      diagnostic: (reason) =>
        streams.err(`approval: Codex gloss unavailable (${reason}); continuing without it\n`),
    }),
  });

  if (!prepared.ok) {
    // The mapping the verb has always used: a mistyped command line or a
    // missing variable is usage; a path that could not be read is I/O.
    const code =
      prepared.code === "log-unreadable" || prepared.code === "payloads-unreadable"
        ? ioError(streams, json, prepared.message)
        : usageError(streams, json, prepared.message, TELEGRAM_LISTEN_HELP);
    return { kind: "handled", code };
  }
  return { kind: "run", setup: prepared.setup };
}

// ---------------------------------------------------------------------------
// Dispatch (APRV-55) — one cycle's worth of "put pending requests on the phone"
// ---------------------------------------------------------------------------

/**
 * Consecutive failures for one action key after which stderr warnings thin out.
 *
 * Not an attempt limit: the send is retried on every cycle forever (see the
 * module doc). Only the complaining is throttled, to every tenth attempt.
 */
export const DISPATCH_LOUD_ATTEMPTS = 3;

/**
 * How long an unannotated delivery stays in the bookkeeping before it is
 * dropped (APRV-196). Twenty-four hours, matching the channel's own
 * `TELEGRAM_DEFAULT_RETENTION_MS`.
 *
 * It is a floor on forgetting and not a deadline for anything: a request that
 * is still pending is never dropped however old it is, because the pending
 * queue is checked first. What this bounds is the memory a long-lived listener
 * holds for questions the log has finished with.
 */
export const DISPATCH_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * The line that introduces the first batch a listener process sends (APRV-196).
 *
 * **Why a banner and not an edit of the earlier copies.** The incident was a
 * restart re-sending five pending requests with no warning, on top of five
 * copies whose buttons had quietly stopped working. Editing those earlier
 * copies to say "superseded" would read better — and it is not a design that
 * can be relied on, because it requires this process to know their message ids,
 * which a restart by definition does not: SPEC.md §10.3 forbids channel state
 * that is a source of truth, and a crash loses a cache whether or not one is
 * allowed. A design that only works when the crash was gentle is a design that
 * fails on the day it is needed. So the banner is unconditional, and the
 * earlier copies are made harmless instead of tidy: their buttons resolve by
 * action reference to the request this process has just re-delivered
 * (`actionRefOf` in `channels/telegram.ts`), so a human who taps the copy they
 * can see decides the request they meant.
 *
 * It says "started" rather than "restarted" because a listener cannot tell the
 * two apart, having deliberately kept nothing that would let it, and a first
 * start that claimed to be a restart would be this channel's own text lying
 * about the system's history.
 */
export function bannerLines(pending: number): string[] {
  const plural = pending === 1 ? "request" : "requests";
  return [
    `LISTENER STARTED — re-sending ${pending} pending ${plural}.`,
    `The ${pending === 1 ? "message" : "messages"} below ${pending === 1 ? "is" : "are"} the live ${pending === 1 ? "copy" : "copies"}. If an earlier copy of the same request is further up this chat, its buttons still decide the same request; nothing is decided twice.`,
    "Which requests are pending is read from the log on every cycle, never from this chat.",
  ];
}

// ---------------------------------------------------------------------------
// Paced delivery (APRV-216) — one question at a time
// ---------------------------------------------------------------------------

/**
 * The summary line that precedes a paced send, and the body of `/queue`.
 *
 * One message, and everything in it is arithmetic on the verified log at the
 * instant it is written: how many requests are pending, how long the oldest has
 * waited, and which classes they are. Nothing is remembered between calls, so
 * two summaries a minute apart can disagree only because the log moved.
 *
 * The class tally is the part worth the space. The count alone says how much
 * work is waiting; the classes say what KIND of work, which is what tells an
 * approver whether the queue is six identical `network.call`s they can walk
 * through or one `policy.edit` they should read carefully.
 */
export function summaryLines(requests: ChannelRequest[], now: string): string[] {
  if (requests.length === 0) return ["Nothing pending — the queue is empty."];

  const nowMs = Date.parse(now);
  const oldest = requests[0] as ChannelRequest;
  const oldestMs = Date.parse(oldest.requested_ts.value);
  const age =
    Number.isNaN(nowMs) || Number.isNaN(oldestMs) ? "unknown age" : ageText(nowMs - oldestMs);

  const tally = new Map<string, number>();
  for (const request of requests) {
    const cls = request.class.value;
    tally.set(cls, (tally.get(cls) ?? 0) + 1);
  }
  const classes = [...tally.entries()]
    .map(([cls, count]) => (count === 1 ? cls : `${cls} ×${String(count)}`))
    .join(", ");

  return [
    `${String(requests.length)} pending — oldest ${age} — ${classes}`,
  ];
}

/**
 * The marker `/queue` puts on the request this listener has selected (APRV-256).
 *
 * It says two things and claims no third. "Selected" is this process's memory of
 * which request it is holding; "card sent earlier" is the delivery bookkeeping
 * recording that a send once succeeded. Neither is evidence that the card is
 * still in the chat: Telegram reports a successful send, never a message's
 * continued existence, and a card can be deleted, buried under a thousand later
 * messages, or lost with the chat history on a reinstall. The old marker,
 * "shown now", asserted present visibility from a past delivery, which is the
 * bug this constant exists to keep fixed.
 */
const SELECTED_MARKER = " — selected — card sent earlier";

/**
 * What `/queue` says about itself, immediately under the summary (APRV-256).
 *
 * `/queue` is a summary reply and carries no buttons, so an approver reading it
 * on a phone must not be left hunting this message for controls that were never
 * on it. Where the controls DO live is stated without a direction: a card is
 * somewhere in the chat's history, and "above" was only ever true for the
 * approver who asked while looking straight at it.
 */
const QUEUE_IS_A_LIST =
  "This is a list of what the log is holding. It has no decision buttons: a request is decided on its own approval card, wherever that card sits in this chat.";

/**
 * `/queue`'s reply: the summary, then one numbered line per pending request.
 *
 * Derived, like the summary, from the verified log at reply time and not from
 * anything this process is holding: the numbering is positional and names no
 * button, so a stale copy of this list cannot be used to decide anything. The
 * marker says which one this listener has selected and once delivered, because
 * the question `/queue` is usually asked to answer is "what else is there
 * besides the one I am looking at" — and, since APRV-256, its unhappy twin,
 * "where is the one I am supposed to be looking at".
 *
 * The footer answers that second question the only honest way available to a
 * process whose knowledge of the chat ends at "a send returned success": it
 * says what was sent, says it cannot tell whether the card survived, and then
 * spends its remaining words on recovery rather than reassurance.
 */
export function queueLines(
  requests: ChannelRequest[],
  now: string,
  shown: readonly string[],
): string[] {
  const lines = summaryLines(requests, now);
  if (requests.length === 0) return lines;

  const nowMs = Date.parse(now);
  const current = new Set(shown);
  let selected = 0;
  lines.push(QUEUE_IS_A_LIST);
  requests.forEach((request, index) => {
    const key = request.action_key.value;
    const requestedMs = Date.parse(request.requested_ts.value);
    const age =
      Number.isNaN(nowMs) || Number.isNaN(requestedMs)
        ? "unknown age"
        : ageText(nowMs - requestedMs);
    const task = request.task.value ?? "no task";
    const isSelected = current.has(key);
    if (isSelected) selected += 1;
    lines.push(
      `${String(index + 1)}. ${key} — ${task} — ${request.class.value} — ${age}${
        isSelected ? SELECTED_MARKER : ""
      }`,
    );
  });

  if (selected === 0) {
    // Nothing selected is an ordinary state, not a fault: a decided or passed
    // over request leaves the listener holding nothing until the next cycle
    // picks the next one up. Saying so is what stops the reader searching the
    // chat for a card this process never claimed to have sent.
    lines.push(
      "Nothing is selected right now, so no approval card has been sent for any of these. The next one goes out with its buttons on an upcoming listener cycle.",
    );
    return lines;
  }

  // More than one key is marked when the selection is a digest group, which
  // Telegram receives as ONE card covering the set. Hence "a single approval
  // card" in the plural branch and no positional word in either: the reply may
  // be chunked across several messages, so "above" is not this function's to
  // promise even about its own lines.
  const holding =
    selected === 1
      ? "The request marked selected is the one this listener is holding, and an approval card for it was sent to this chat earlier. The buttons on that card decide it."
      : `The ${String(selected)} requests marked selected are what this listener is holding as one digest, and a single approval card for them was sent to this chat earlier. The buttons on that card decide them.`;

  lines.push(
    `${holding} This listener cannot tell whether that card is still here.`,
    "If you cannot find the card, /skip is the recovery: it puts the request at the back of the order and lets the next one through. Nothing is decided by typing it, the request stays pending in the log, and a fresh card is sent on a later listener cycle once the requests ahead of it have had their turn (a cycle can run a little long while a gloss is being written).",
    "/next gives up your place instead: this listener moves past the request and stops offering it, and no new card is sent for it. It is not a way to ask for the card again.",
  );
  return lines;
}

/**
 * What this process is showing, and in what order (APRV-216). **In memory
 * only**, like every other field of {@link DispatchState} and for the same
 * reason (SPEC.md §10.3).
 *
 * None of this is truth, and the check that proves it is what happens when it
 * is lost: a restarted listener re-derives the pending set from the verified
 * log, rebuilds the order from log order, and shows the oldest — which is
 * exactly what a fresh start does anyway. What a crash costs is the human's
 * place in a walkthrough, never a request that stays pending in the log and is
 * never shown.
 */
export interface PacedState {
  /**
   * Every pending action key, in the order this process will show them.
   *
   * Seeded from log order (oldest first, which is what `buildPendingQueue`
   * returns) and rearranged by `/skip` alone. Keys the log no longer calls
   * pending are dropped on every cycle, and newly pending ones join the back.
   */
  order: string[];
  /**
   * The action keys of the unit in front of the approver, or `null` when
   * nothing is.
   *
   * A unit rather than a key because a digest (APRV-115) is one thing to read
   * and several things to decide. It is released when the log says none of its
   * members is pending any more, which is what makes a decision — at any
   * surface, on any copy — advance the walkthrough.
   */
  current: string[] | null;
  /** Whether any summary has been sent yet, i.e. whether this is the start. */
  summarySent: boolean;
  /** The pending count the last summary named, so growth can be recognised. */
  announced: number;
}

// ---------------------------------------------------------------------------
// Paced review (APRV-299) — the retrospective backlog, one card at a time
// ---------------------------------------------------------------------------

/**
 * The retrospective walkthrough this process is running (APRV-299). **In memory
 * only**, exactly like {@link PacedState} and under the same rule (SPEC.md
 * §10.3).
 *
 * Its loss is the check that it is not truth: a restarted listener re-derives
 * the open samples from the verified log, rebuilds the order from log order,
 * and offers the oldest — which is what a fresh start does anyway. A card that
 * never arrives, or that a human scrolls past, leaves the sample OPEN: it stays
 * in `approval audit list`, in `.approval/QUEUE.md`, and reviewable with
 * `approval audit review <seq>`. Nothing here can empty the backlog, which is
 * the property a sampled-audit backlog exists to have.
 */
export interface ReviewWalkthrough {
  /** Every open sample's seq, in the order this process will show them. */
  order: number[];
  /** The sample whose card is in front of the approver, or `null`. */
  current: number | null;
  /** Sample seq -> the message this process sent the card as. */
  readonly delivered: Map<number, DeliveryId>;
  /** Whether any review summary has been sent yet. */
  summarySent: boolean;
  /** The open count the last summary named, so growth can be recognised. */
  announced: number;
  /**
   * The log's size in bytes when this pass last derived the backlog, or `null`
   * before the first one.
   *
   * A cost guard and nothing else, and it is sound for exactly one reason: the
   * log is APPEND-ONLY, so a size that has not changed is a record set that has
   * not changed. It is read only to skip a full verified walk on the cycle
   * where a card is already in front of the approver and nothing has been
   * written — which, with a 25-second poll and a human who answers in minutes,
   * is most cycles. Every other cycle re-derives from the log as usual, and a
   * lost or stale value costs one extra read rather than a wrong answer.
   */
  logSize: number | null;
}

/**
 * The summary line that precedes a review card, and `/queue`'s review footer.
 *
 * Arithmetic on the verified log at the instant it is written, exactly as
 * {@link summaryLines} is: how many samples are awaiting review, how old the
 * oldest is, and which classes they are. The last clause is the one that stops
 * a reader treating this like the pending queue: nothing here is waiting on
 * them, because all of it has already happened.
 */
export function reviewSummaryLines(cards: ReviewCard[], now: string): string[] {
  if (cards.length === 0) return ["Nothing awaiting review."];

  const nowMs = Date.parse(now);
  const ages = cards
    .map((card) => nowMs - Date.parse(card.ranAtTs))
    .filter((age) => !Number.isNaN(age) && age >= 0);
  const oldest = ages.length === 0 ? null : Math.max(...ages);

  const tally = new Map<string, number>();
  for (const card of cards) {
    const cls = card.fields.class.value;
    tally.set(cls, (tally.get(cls) ?? 0) + 1);
  }
  const classes = [...tally.entries()]
    .map(([cls, count]) => (count === 1 ? cls : `${cls} ×${String(count)}`))
    .join(", ");

  return [
    `${String(cards.length)} awaiting review — oldest ran ${oldest === null ? "at an unknown time" : ageText(oldest)} — ${classes}`,
    "These already ran. Nothing is waiting on you and no card here authorizes anything; a review records what a person thought of work that is already done.",
  ];
}

/**
 * Note when a key was delivered, for the retention sweep (APRV-196).
 *
 * The cycle's own `now` rather than a clock read, for the reason every other
 * instant in this file is a parameter: the tests drive dispatch at chosen
 * instants, and a sweep judged against `Date.now()` would be untestable and
 * would disagree with the TTL arithmetic beside it.
 */
function remember(state: DispatchState, actionKey: string, now: string): void {
  const ms = Date.parse(now);
  if (!Number.isNaN(ms)) state.sentAtMs.set(actionKey, ms);
}

/** Drop every trace of one action key from the bookkeeping (APRV-196). */
function forget(state: DispatchState, actionKey: string): void {
  state.delivered.delete(actionKey);
  state.sentAtMs.delete(actionKey);
  state.attempts.delete(actionKey);
  state.annotated.delete(actionKey);
  for (const token of state.warned) {
    if (token.startsWith(`${actionKey}:`)) state.warned.delete(token);
  }
}

/**
 * What one listener process remembers between cycles. **In memory only.**
 *
 * SPEC.md §10.3: channels hold no state that is a source of truth. Nothing here
 * is truth — the pending set is re-derived from the verified log every cycle,
 * and this only prevents a second copy of a message this process already sent.
 * Its loss (restart, crash) degrades to a re-send, never to a request that is
 * pending in the log and absent from the approver's phone.
 */
export interface DispatchState {
  /**
   * action key -> the delivery id this process sent it under.
   *
   * Pruned (APRV-196): an entry goes when the request reaches a terminal state
   * and its message has been annotated, and a straggler goes when it is older
   * than {@link DISPATCH_RETENTION_MS} and the pending queue no longer carries
   * it. Neither prune can cost a re-send, because `buildPendingQueue` only ever
   * returns requests the verified log says are pending — the same reason losing
   * the whole map to a restart is safe.
   */
  readonly delivered: Map<string, DeliveryId>;
  /** action key -> when this process sent it, ms since epoch (APRV-196). */
  readonly sentAtMs: Map<string, number>;
  /**
   * Whether the re-delivery banner has been sent (APRV-196).
   *
   * A box rather than a field because {@link DispatchState} is `readonly`
   * everywhere else, and for the same reason: a cycle may write what it did,
   * and nothing may swap the state out from under one.
   */
  readonly banner: { sent: boolean };
  /** action key -> consecutive failed send attempts. Cleared on success. */
  readonly attempts: Map<string, number>;
  /** `<action key>:<code>` skips already reported, so cycles do not repeat them. */
  readonly warned: Set<string>;
  /**
   * Keys this process has already annotated on the approver's phone (APRV-106
   * for withdrawal, APRV-113 for every other terminal state). In memory, like
   * `delivered`, and for the same reason: it stops a second edit of the same
   * message, and its loss costs a duplicate edit at worst.
   *
   * The memory that matters here is `delivered`, and losing it degrades to
   * un-annotated messages, NEVER to wrong annotations: a process that does not
   * remember sending a message cannot edit it, and one that does re-reads the
   * outcome from the verified log every cycle. A fresh listener also never
   * sends a settled request in the first place — `buildPendingQueue` re-derives
   * from the verified log and only `requested` is pending — so a restart leaves
   * stale text on old messages whose buttons the gate refuses anyway, and
   * nothing worse.
   */
  readonly annotated: Set<string>;
  /**
   * The walkthrough this process is running under `delivery: paced`
   * (APRV-216). Present under `burst` too and simply never read there, so that
   * one state shape serves both modes and a policy change between two runs
   * needs no different bookkeeping.
   */
  readonly paced: PacedState;
  /**
   * The checkpoint prompt this process has outstanding (APRV-257). **In memory
   * only**, like everything else here.
   *
   * `offeredSince` is the newest checkpoint's seq at the moment a prompt went
   * out (`null` for a log that had never been checkpointed), and it is what
   * makes "at most one outstanding, and never a nag" a single condition: a
   * cadence that has lapsed keeps producing an offer on every cycle, and this
   * process asks once per lapse. The value changes only when a checkpoint
   * actually lands, which is also the moment due-ness goes false — so the next
   * prompt comes from the next lapse and never from this one repeating.
   *
   * `offered: false` means nothing is outstanding. Losing the box to a restart
   * costs one duplicate prompt for a checkpoint that is genuinely owed, which
   * is the same direction every other piece of this bookkeeping degrades in.
   */
  readonly checkpoint: { offered: boolean; offeredSince: number | null };
  /**
   * The retrospective walkthrough (APRV-299), paced in both delivery modes.
   *
   * Always paced, and deliberately so even under `burst`: a review is never
   * urgent, nobody is blocked on one, and a restart that put sixty of them on a
   * phone at once would be the flood APRV-287 collapsed in the other direction.
   * One card at a time, behind a summary, is the whole of the design.
   */
  readonly review: ReviewWalkthrough;
}

export function newDispatchState(): DispatchState {
  return {
    delivered: new Map(),
    sentAtMs: new Map(),
    banner: { sent: false },
    attempts: new Map(),
    warned: new Set(),
    annotated: new Set(),
    paced: { order: [], current: null, summarySent: false, announced: 0 },
    checkpoint: { offered: false, offeredSince: null },
    review: {
      order: [],
      current: null,
      delivered: new Map(),
      summarySent: false,
      announced: 0,
      logSize: null,
    },
  };
}

/** What one {@link dispatchPending} call did. Total: it never throws. */
export interface DispatchResult {
  /** Requests put in front of the approver by this cycle. */
  delivered: { action_key: string; delivery_id: DeliveryId }[];
  /** Sends that failed and will be retried on the next cycle. */
  failed: { action_key: string; attempts: number; message: string }[];
  /**
   * The queue could not be derived at all: the log is unreadable or does not
   * verify. Nothing was sent. Fatal at startup, retried on later cycles.
   */
  queueError?: { code: ChannelTagRefusalCode; message: string };
  /**
   * Deliveries annotated with their terminal outcome and disarmed this cycle
   * (APRV-106 for `withdrawn`, APRV-113 for the rest).
   */
  annotated: { action_key: string; delivery_id: DeliveryId; outcome: TelegramTerminalState }[];
  /**
   * Digests sent this cycle (APRV-115): the message that carries the buttons,
   * the batch delivery id every member's event will carry, and the members.
   * A group that fell back to one message per member produces no entry here.
   */
  digests: {
    delivery_id: DeliveryId;
    batch_delivery_id: DeliveryId;
    action_keys: string[];
  }[];
  /**
   * The re-delivery banner, when this cycle sent one (APRV-196): the message
   * that precedes a startup batch and says how many requests are coming.
   */
  banner?: { delivery_id: DeliveryId; pending: number };
  /**
   * The paced summary this cycle sent, when it sent one (APRV-216): the line
   * that precedes the request being shown and says how many are waiting behind
   * it. Sent by the first paced cycle that has something to show, and again
   * whenever the pending set has grown while nothing was in front of the
   * approver. Never both this and {@link banner}: they are the two modes'
   * openings, and a process runs one mode.
   */
  summary?: { delivery_id: DeliveryId; pending: number };
  /**
   * Action keys dropped from the delivery bookkeeping this cycle (APRV-196),
   * with why. Neither kind can cost a re-send: the pending queue is the log's
   * answer, and a dropped key that is still pending is simply re-delivered.
   */
  pruned: { action_key: string; reason: "settled" | "stale" }[];
  /**
   * The collapsed re-delivery this cycle sent, when it sent one (APRV-287):
   * the one message that stood in for a batch of requests nobody is waiting on
   * any more, and the keys it covers. At most one, on a process's first cycle.
   */
  collapsed?: { delivery_id: DeliveryId; action_keys: string[]; oldest_ms: number };
  /**
   * The `CHECKPOINT DUE` prompt this cycle sent, when it sent one (APRV-257):
   * the message it is on and the head it asks about. At most one per lapse.
   */
  checkpoint?: { delivery_id: DeliveryId; seq: number; hash: string };
  /**
   * The review card this cycle sent, when it sent one (APRV-299): the message
   * it is on, the `audit.sampled` seq it is drawn for, and the action it is
   * about. At most one per cycle, and none while a request is in front of the
   * approver.
   */
  reviewCard?: { delivery_id: DeliveryId; sample_seq: number; action_key: string };
  /**
   * The review summary this cycle sent, when it sent one (APRV-299): the line
   * saying how many samples are awaiting review and how old the oldest is.
   */
  reviewSummary?: { delivery_id: DeliveryId; open: number };
  /**
   * The review backlog could not be derived: the log is unreadable or does not
   * verify. No card was sent. Never fatal — a review is not a decision anyone
   * is blocked on — and retried on the next cycle.
   */
  reviewError?: { code: string; message: string };
}

/** A delivery whose request the log now says is settled (APRV-106, APRV-113). */
interface TerminalDelivery {
  actionKey: string;
  deliveryId: DeliveryId;
  /** Which terminal state the verified log derived. Chooses the headline. */
  outcome: TelegramTerminalState;
  /** The lines the approver reads under the headline on the edited message. */
  detail: string[];
}

/** The event that records each terminal state, for finding the settling record. */
const TERMINAL_EVENT: Record<TelegramTerminalState, string> = {
  granted: "approval.granted",
  rejected: "approval.rejected",
  revoked: "approval.revoked",
  expired: "approval.expired",
  withdrawn: "approval.withdrawn",
};

/**
 * Which of this process's deliveries the log says are settled (APRV-113,
 * generalizing APRV-106's withdrawal-only pass).
 *
 * This is the cross-surface half of the feature. A request answered at the CLI
 * or on the web queue, revoked afterwards, or expired by the daemon, leaves a
 * chat prompt that this process delivered and that nothing else will ever
 * correct — so every cycle asks the verified log what became of each message it
 * sent, and annotates the ones that are over.
 *
 * Reads only VERIFIED records (SPEC.md §11.1(1)). A channel edit is not an
 * enforcement decision, but it is a statement to a human about what the log
 * says, and reading the log unverified to make one would be the same defect in
 * a smaller hat.
 *
 * Never throws: an unreadable or unverifiable log yields an empty list, and the
 * cycle's own `queueError` path already reports that failure. Annotating from a
 * log this process could not verify would be worse than leaving the message.
 */
function terminalDeliveries(
  setup: ListenSetup,
  state: DispatchState,
  now: string,
): TerminalDelivery[] {
  if (state.delivered.size === 0) return [];
  const read = readVerifiedRecords(setup.logPath);
  if (!read.ok) return [];

  const settled: TerminalDelivery[] = [];
  for (const [actionKey, deliveryId] of state.delivered) {
    // APRV-109. An attestation prompt has no `approval.requested` behind it, so
    // `requestState` can say nothing about it and the message would stay armed
    // forever — the exact stale prompt APRV-106 added this pass to retire. Its
    // own derivation answers instead, and the four terminal proposal states map
    // onto headlines this channel already has: an attested proposal reads
    // `granted`, a declined one `rejected`, a superseded one `withdrawn`
    // (a newer proposal is the live question now), and a lapsed one `expired`.
    if (isAttestationActionKey(actionKey)) {
      const proposal = proposalRecords(read.records).find(
        (entry) => entry.action_key === actionKey,
      );
      const derived =
        proposal === undefined ? null : proposalState(read.records, proposal.seq, now);
      if (derived === null || derived.state === "open") continue;
      const outcome: TelegramTerminalState =
        derived.state === "attested"
          ? "granted"
          : derived.state === "declined"
            ? "rejected"
            : derived.state === "superseded"
              ? "withdrawn"
              : "expired";
      const answer = read.records.find(
        (entry) =>
          entry.seq > derived.seq &&
          (entry.event === "policy.updated" || entry.event === "policy.declined") &&
          payloadOf(entry)["sha256"] === derived.sha256,
      );
      settled.push({
        actionKey,
        deliveryId,
        outcome,
        detail:
          derived.state === "superseded"
            ? [`a later amendment of the same policy replaced this prompt · nothing to do`]
            : derived.state === "expired"
              ? [`no answer arrived before the proposer's deadline · nothing was attested`]
              : answer === undefined
                ? [`recorded at ${utcClock(now)}`]
                : [decidedLine(answer.actor, answer.ts, answer.seq)],
      });
      continue;
    }

    // `ttlMs: null` is correct here rather than lazy, and it is the reason this
    // pass annotates the daemon's `approval.expired` but not a TTL that has
    // merely lapsed by arithmetic: an annotation states what the LOG says, and
    // a lazily-expired request has no record saying anything yet. Loading the
    // policy to compute a deadline would also make a cosmetic edit depend on a
    // file read that can fail. The armed message left behind is refused at the
    // gate, and gets its annotation on the cycle after the daemon writes.
    const derivation = requestState(read.records, actionKey, now, null);
    if (!isTelegramTerminalState(derivation.state)) continue;
    const outcome = derivation.state;
    const record = read.records.find(
      (entry) =>
        entry.seq === derivation.decisionSeq && entry.event === TERMINAL_EVENT[outcome],
    );
    const payload = record === undefined ? {} : payloadOf(record);
    const at = record === undefined ? now : record.ts;
    const seq = record?.seq ?? derivation.decisionSeq;

    if (outcome === "withdrawn") {
      const why = typeof payload["reason"] === "string" ? payload["reason"] : "withdrawn";
      const note = typeof payload["note"] === "string" ? `\n${payload["note"]}` : "";
      settled.push({
        actionKey,
        deliveryId,
        outcome,
        // APRV-106's exact line, unchanged: it is what the approver reads.
        detail: [`withdrawn by the requester at ${utcClock(at)} (${why}) · nothing to do${note}`],
      });
      continue;
    }

    if (outcome === "expired") {
      settled.push({
        actionKey,
        deliveryId,
        outcome,
        detail: [
          `no answer arrived before the deadline · recorded at ${utcClock(at)}${
            seq === null ? "" : ` (seq ${seq})`
          }`,
        ],
      });
      continue;
    }

    // granted / rejected / revoked: a human answered, somewhere. The actor is
    // the log's, never this listener's configured identity — the answer may
    // have come from another surface entirely.
    settled.push({
      actionKey,
      deliveryId,
      outcome,
      detail:
        record === undefined
          ? [`recorded at ${utcClock(at)}`]
          : [decidedLine(record.actor, record.ts, record.seq)],
    });
  }
  return settled;
}

/**
 * One dispatch cycle: re-derive the pending queue from the verified log, send
 * whatever this process has not already sent.
 *
 * `now` is a parameter, not a clock read: TTL judgment inside
 * {@link buildPendingQueue} is deterministic and the tests drive it at chosen
 * instants. Requests that are decided, expired, or not yet requested are absent
 * from the derivation and so are never sent.
 */
export async function dispatchPending(
  setup: ListenSetup,
  streams: Streams,
  state: DispatchState,
  now: string,
): Promise<DispatchResult> {
  const result: DispatchResult = {
    delivered: [],
    failed: [],
    annotated: [],
    digests: [],
    pruned: [],
  };

  const queue = buildPendingQueue(setup.logPath, setup.tagOptions, now);
  if (!queue.ok) {
    result.queueError = { code: queue.code, message: queue.message };
    return result;
  }

  // APRV-106 (withdrawal) generalized by APRV-113 (every terminal state),
  // before the sends. A request this process delivered and that the log now
  // says is settled — granted or rejected at any surface, revoked, expired by
  // the daemon, or withdrawn by its requester — gets its message annotated with
  // that outcome and its buttons taken away, so the approver's phone stops
  // showing a decided question as a live one. What became of it is derived from
  // the VERIFIED log by `terminalDeliveries`, never remembered here; this state
  // only prevents a second edit of the same message.
  for (const settled of terminalDeliveries(setup, state, now)) {
    if (state.annotated.has(settled.actionKey)) continue;
    state.annotated.add(settled.actionKey);
    try {
      // The action key is what makes this per member on a digest (APRV-115):
      // one delivery id can carry several requests, and settling one of them
      // must leave the others armed.
      await setup.channel.annotate(
        settled.deliveryId,
        TELEGRAM_TERMINAL_HEADLINES[settled.outcome],
        settled.detail,
        settled.actionKey,
      );
      result.annotated.push({
        action_key: settled.actionKey,
        delivery_id: settled.deliveryId,
        outcome: settled.outcome,
      });
      // APRV-196. The question is over, the message says so, and nothing will
      // ever consult this entry again: the pending queue is derived from the
      // log and a settled request is not in it. Held until now rather than at
      // the moment the log settled, so the annotation pass above still has the
      // message id it needs.
      forget(state, settled.actionKey);
      result.pruned.push({ action_key: settled.actionKey, reason: "settled" });
      if (setup.json) {
        streams.out(
          `${JSON.stringify({
            event: "annotated",
            action_key: settled.actionKey,
            delivery_id: settled.deliveryId,
            outcome: settled.outcome,
          })}\n`,
        );
      } else {
        streams.out(
          `annotated ${settled.actionKey} (message ${settled.deliveryId}): ${settled.outcome}\n`,
        );
      }
    } catch (cause) {
      // APRV-277. Telegram answers an edit that would change nothing with 400
      // "message is not modified", and this pass re-derives its annotations
      // from the verified log rather than remembering which ones landed — so a
      // message this listener (or a previous one, or the channel's own decision
      // path) already annotated produces exactly that. The phone shows the
      // outcome, the annotation stands, and there is nothing to report. Every
      // other 400 and every other failure still reaches the operator below.
      if (isMessageNotModified(cause)) continue;
      // Cosmetic, and said so on stderr. The gate refuses a tap on the stale
      // buttons anyway (`already-decided`, `request-withdrawn`, `expired`), so
      // nothing can be decided by one.
      streams.err(
        `approval: telegram could not annotate the ${settled.outcome} ${settled.actionKey} (message ${settled.deliveryId}): ${
          cause instanceof Error ? cause.message : String(cause)
        } — the buttons are stale but the gate refuses a tap on them\n`,
      );
    }
  }

  // APRV-196, the other half of the prune: an entry whose message was never
  // annotated (the edit failed, the request lapsed with nothing to say about
  // it, the log settled it while this process was down) would otherwise sit in
  // the map for the life of a listener that `approval up` now keeps running for
  // weeks. Dropped once it is older than the retention window AND the log no
  // longer calls it pending, which is the same pair of conditions the channel's
  // own sweep uses: past that, a re-derivation cannot ask for it and a callback
  // cannot be honoured against it.
  const pendingNow = new Set(queue.requests.map((request) => request.action_key.value));
  const nowMs = Date.parse(now);
  for (const [actionKey, sentAtMs] of state.sentAtMs) {
    if (pendingNow.has(actionKey)) continue;
    if (Number.isNaN(nowMs) || nowMs - sentAtMs < DISPATCH_RETENTION_MS) continue;
    forget(state, actionKey);
    result.pruned.push({ action_key: actionKey, reason: "stale" });
  }

  for (const skipped of queue.skipped) {
    const token = `${skipped.action_key}:${skipped.code}`;
    if (state.warned.has(token)) continue;
    state.warned.add(token);
    streams.err(
      `approval: telegram cannot deliver ${skipped.action_key} (${skipped.code}): ${skipped.message}\n`,
    );
  }

  // APRV-257. The checkpoint tap, offered before the requests. Everything about
  // WHETHER to offer is `checkpointOfferFor`, which reads the policy and the
  // verified log; this cycle's only jobs are "has this process already asked"
  // and "is the approver already looking at something".
  //
  // Under `paced` a prompt that went out ends the cycle, because the approver
  // is now looking at a question and sending a request underneath it would be
  // two. Under `burst` it does NOT: burst sends everything pending on every
  // cycle, and `--once` is one cycle, so returning here would leave a startup
  // batch undelivered for the sake of a prompt that blocks nothing.
  const offered = await offerCheckpoint(setup, streams, state, result);
  if (offered && setup.delivery === "paced") return result;

  // Everything the log calls pending that this process has not put on the
  // phone. Both modes start here and differ only in how much of it they send.
  const allUndecided = queue.requests.filter(
    (request) => !state.delivered.has(request.action_key.value),
  );

  // APRV-287. A listener that has just started or reconnected re-derives the
  // pending set and re-delivers it. For a queue somebody is waiting on that is
  // exactly right; for one nobody is, it is the flood of 2026-09-06 — a dozen
  // requests whose hooks had long since given up, one message each. The ones
  // older than the hook's wait go out as ONE message with a single reject-all,
  // and the rest are delivered as they always were.
  //
  // `state.banner.sent` is this process's own "have I completed a cycle yet",
  // and it is read here BEFORE the burst banner consumes it: the first cycle of
  // a process is precisely the re-delivery, and a later cycle carries requests
  // that have just been asked.
  // `burst` only, and that is where the harm is. Under `paced` the listener
  // already puts ONE question at a time in front of the approver behind a
  // summary line that names the count, the classes and the oldest age
  // (APRV-216), so a restart there is two messages rather than a dozen and
  // there is no flood to collapse. Collapsing a paced walkthrough would also
  // take away the thing it exists for: an approver working deliberately
  // through an old queue can still approve an old request, and a reject-all
  // summary offers no way to.
  const firstCycle = !state.banner.sent && setup.delivery === "burst";
  const undecided = firstCycle
    ? await collapseStale(setup, streams, state, result, allUndecided, now)
    : allUndecided;

  // APRV-216. Under `paced` this cycle sends at most ONE unit, and `null` means
  // it sends nothing because a question is already in front of the approver.
  // Under `burst` it sends everything, which is what this file did before.
  const selected =
    setup.delivery === "paced" ? pacedSelection(state, queue.requests, undecided) : undecided;
  if (selected === null) {
    // APRV-299. Nothing to SEND is not nothing to do: either a question is
    // already in front of the approver (in which case the review pass declines
    // on its own) or the pending queue is empty, which is exactly when the
    // retrospective backlog should get the screen.
    await dispatchReviews(setup, streams, state, result, now);
    return result;
  }

  // APRV-115. The window is this cycle: whatever is being sent right now is
  // grouped, and a group of similar requests goes out as one digest instead of
  // one message each. Nothing waits for more — there is no new latency
  // mechanism here, and a lone request is delivered exactly as it always was.
  //
  // The gloss is attached to the SELECTED requests and to no others (APRV-216):
  // under `paced` the rest of the queue is not being rendered this cycle, and
  // paying 10-15 seconds of subprocess for a sentence nobody will read before
  // the next decision would be the terminal walker's mistake made here.
  const tally = { asked: 0, absent: 0 };
  const undelivered = selected.map((request) => withGloss(setup, request, tally));

  // APRV-197. One line per cycle, and only when a model was actually asked and
  // did not answer. Absence used to be silent by design, which was right for
  // one request and wrong for a thousand: with APRV-144's ceiling the
  // subprocess missed every time, and the operator's only evidence was prompts
  // that looked exactly like prompts from before the feature existed.
  if (tally.absent > 0) {
    streams.err(glossAbsenceLine("telegram", tally.absent, tally.asked, GLOSS_TIMEOUT_MS));
  }

  // APRV-216. The paced opening: one line saying how many are waiting and what
  // kind, in front of the one being shown. Sent by the first cycle that has
  // something to show, and again whenever the pending set has GROWN while
  // nothing was in front of the approver — which is the only moment a count
  // they were told is stale in the direction that matters.
  if (setup.delivery === "paced" && undelivered.length > 0) {
    const pending = queue.requests.length;
    if (!state.paced.summarySent || pending > state.paced.announced) {
      state.paced.summarySent = true;
      state.paced.announced = pending;
      try {
        const deliveryId = await setup.channel.announce(summaryLines(queue.requests, now));
        result.summary = { delivery_id: deliveryId, pending };
      } catch (cause) {
        // Cosmetic, exactly like the banner: the request below it is the point,
        // and withholding a question because its preamble failed to send would
        // be the wrong direction on the only axis that matters here.
        streams.err(
          `approval: telegram could not send the queue summary: ${
            cause instanceof Error ? cause.message : String(cause)
          } — the request below is unaffected\n`,
        );
      }
    }
  }

  // APRV-196. The STARTUP batch gets one line in front of it, and only that
  // one: a later cycle delivers what has just been requested, which is a
  // notification and not a re-delivery, and a banner over it would say
  // something false. So the flag is consumed by the first cycle that completes
  // a derivation whether or not it had anything to send — a listener that
  // started against an empty queue has no re-delivery to announce, ever. See
  // {@link bannerLines} for why this is a banner rather than an edit of the
  // copies that came before.
  const announcing =
    setup.delivery === "burst" && !state.banner.sent && undelivered.length > 0;
  state.banner.sent = true;
  if (announcing) {
    try {
      const deliveryId = await setup.channel.announce(bannerLines(undelivered.length));
      result.banner = { delivery_id: deliveryId, pending: undelivered.length };
    } catch (cause) {
      // Cosmetic, and never a reason to withhold the requests it introduces.
      streams.err(
        `approval: telegram could not send the re-delivery banner: ${
          cause instanceof Error ? cause.message : String(cause)
        } — the requests below are unaffected\n`,
      );
    }
  }

  const deliveredBefore = result.delivered.length;

  for (const group of groupForDigest(undelivered)) {
    if (group.length < 2) {
      await deliverUnits(setup, streams, state, result, group, now);
      continue;
    }

    // B7 first (SPEC.md §10.3): a set carrying more than one distinct payload
    // where any member is not whole must not be presented as a set at all. The
    // refusal is reported once and the members go out individually, which is
    // the same direction every other digest fallback takes.
    const assembled = assembleBatch(group);
    if (!assembled.ok) {
      const token = `${group.map((request) => request.action_key.value).join(",")}:${assembled.code}`;
      if (!state.warned.has(token)) {
        state.warned.add(token);
        streams.err(
          `approval: telegram cannot digest ${group.length} similar requests (${assembled.code}): ${assembled.message} — sending them one message each instead\n`,
        );
      }
      await deliverUnits(setup, streams, state, result, group, now);
      continue;
    }

    const keys = group.map((request) => request.action_key.value);
    try {
      const delivered = await setup.channel.notifyBatch(assembled.batch);
      for (const member of delivered.members) {
        state.delivered.set(member.action_key, member.delivery_id);
        remember(state, member.action_key, now);
        state.attempts.delete(member.action_key);
        result.delivered.push({ action_key: member.action_key, delivery_id: member.delivery_id });
      }
      if (delivered.digestId !== null) {
        result.digests.push({
          delivery_id: delivered.digestId,
          batch_delivery_id: delivered.batchDeliveryId,
          action_keys: delivered.members.map((member) => member.action_key),
        });
      }
      report(setup, streams, delivered.digestId, delivered.members);
    } catch (cause) {
      // Every member stays out of `delivered`, so the next cycle re-sends the
      // whole group. A half-sent digest arms nothing (the member nonces are
      // registered only once the message with the buttons exists), so the cost
      // is a duplicate prompt and never a live button on a partial set.
      const message = cause instanceof Error ? cause.message : String(cause);
      for (const actionKey of keys) {
        const attempts = (state.attempts.get(actionKey) ?? 0) + 1;
        state.attempts.set(actionKey, attempts);
        result.failed.push({ action_key: actionKey, attempts, message });
      }
    }
  }

  // APRV-216. What is in front of the approver is what actually reached the
  // chat, which is why this reads the RESULT rather than the selection: a send
  // that failed leaves `current` null, so the next cycle retries the same unit
  // instead of standing still behind a message nobody ever received.
  if (setup.delivery === "paced") {
    const sent = result.delivered.slice(deliveredBefore).map((entry) => entry.action_key);
    state.paced.current = sent.length === 0 ? null : sent;
  }

  // APRV-299, last and least urgent. The retrospective backlog is offered only
  // when nothing this cycle put a question in front of the approver: a pending
  // request is somebody waiting, and a sampled action is somebody's work that
  // already finished. Reconciliation runs even when no card goes out, so a
  // sample reviewed at a terminal releases the walkthrough on the next cycle.
  await dispatchReviews(setup, streams, state, result, now);

  return result;
}

/**
 * One cycle's worth of "put the retrospective backlog in front of the approver"
 * (APRV-299).
 *
 * The same shape as the paced request walkthrough and for the same reasons. The
 * LOG decides what exists: `openReviewCards` re-derives the open samples from
 * verified records every cycle, so a sample reviewed anywhere — this card, a
 * terminal, another listener — leaves the order and the shown slot, and nothing
 * this process remembers can keep a reviewed sample on the phone or an open one
 * off it. The ORDER is this process's, seeded from log order and rearranged by
 * `/skip` alone. And ONE AT A TIME: a card in front of the approver means this
 * cycle sends nothing.
 *
 * Never fatal, at startup or after. A backlog that cannot be derived is a
 * stderr line and a `reviewError` on the result; a card that fails to send
 * leaves the sample undelivered and the next cycle retries it. Neither can lose
 * a review, because the sample is in the log and the log is what is read.
 */
/** The log's size in bytes, or `null` when it cannot be stated. */
function logSizeOf(logPath: string): number | null {
  try {
    return statSync(logPath).size;
  } catch {
    return null;
  }
}

async function dispatchReviews(
  setup: ListenSetup,
  streams: Streams,
  state: DispatchState,
  result: DispatchResult,
  now: string,
): Promise<void> {
  const review = state.review;

  // The cost guard. A card is already in front of the approver and the log has
  // not grown since this pass last ran, so nothing can have been reviewed and
  // nothing can have been sampled: skip the verified walk. Sound because the
  // log is append-only; a `null` size, an unreadable stat, or any growth at all
  // falls through to the ordinary derivation.
  const size = logSizeOf(setup.logPath);
  if (review.current !== null && size !== null && size === review.logSize) return;

  const built = openReviewCards(
    setup.logPath,
    setup.tagOptions.payload === undefined ? {} : { payload: setup.tagOptions.payload },
  );
  if (!built.ok) {
    result.reviewError = { code: built.code, message: built.message };
    return;
  }
  review.logSize = size;

  const open = built.cards;
  const openSeqs = new Set(open.map((card) => card.sampleSeq));

  review.order = review.order.filter((seq) => openSeqs.has(seq));
  const known = new Set(review.order);
  for (const card of open) {
    if (!known.has(card.sampleSeq)) review.order.push(card.sampleSeq);
  }
  // Deleting the current entry mid-iteration is defined behaviour for a Map.
  for (const seq of review.delivered.keys()) {
    if (!openSeqs.has(seq)) review.delivered.delete(seq);
  }
  if (review.current !== null && !openSeqs.has(review.current)) review.current = null;
  // A count the approver was told that is now too high is the number they
  // watched go down, not growth to announce again.
  review.announced = Math.min(review.announced, open.length);

  if (review.current !== null) return;
  if (setup.delivery === "paced" && state.paced.current !== null) return;
  const nextSeq = review.order.find((seq) => !review.delivered.has(seq));
  if (nextSeq === undefined) return;
  const card = open.find((entry) => entry.sampleSeq === nextSeq);
  if (card === undefined) return;

  if (!review.summarySent || open.length > review.announced) {
    review.summarySent = true;
    review.announced = open.length;
    try {
      const deliveryId = await setup.channel.announce(reviewSummaryLines(open, now));
      result.reviewSummary = { delivery_id: deliveryId, open: open.length };
    } catch (cause) {
      // Cosmetic, exactly like the request summary: the card below it is the
      // point, and withholding it because its preamble failed would be the
      // wrong direction on the only axis that matters.
      streams.err(
        `approval: telegram could not send the review summary: ${
          cause instanceof Error ? cause.message : String(cause)
        } — the card below is unaffected\n`,
      );
    }
  }

  const actionKey = card.fields.action_key.value;
  try {
    const deliveryId = await setup.channel.offerReview(card);
    review.delivered.set(nextSeq, deliveryId);
    review.current = nextSeq;
    result.reviewCard = {
      delivery_id: deliveryId,
      sample_seq: nextSeq,
      action_key: actionKey,
    };
    if (setup.json) {
      streams.out(
        `${JSON.stringify({
          event: "review_offered",
          sample_seq: nextSeq,
          action_key: actionKey,
          delivery_id: deliveryId,
        })}\n`,
      );
    } else {
      streams.out(
        `offered a review of sample seq ${String(nextSeq)} (${actionKey}, message ${deliveryId})\n`,
      );
    }
  } catch (cause) {
    // The sample stays open and undelivered, so the next cycle offers it again.
    streams.err(
      `approval: telegram could not offer the review of sample seq ${String(nextSeq)} (${actionKey}): ${
        cause instanceof Error ? cause.message : String(cause)
      } — the sample stays open and the next cycle tries again\n`,
    );
  }
}

/**
 * How old a pending request must be, on a listener's first cycle, to be one
 * nobody is waiting on (APRV-287).
 *
 * The hook's own wait PLUS its retry grace, read from the same module the hook
 * reads (`core/harness-wait.ts`), because two numbers would be two answers to
 * "is anybody still holding this". Past the wait alone a hook process has
 * stopped blocking and a retry can still adopt the question, so those are
 * ordinary pending requests. Past the wait and the grace together nothing will
 * adopt it: that is the moment the hook itself takes such a request back, and a
 * request still pending here is one whose session never came back at all —
 * exactly the dozen that arrived on a phone behind a dead daemon on
 * 2026-09-06.
 *
 * Collapsing is not deciding. These stay pending, listable by `/queue`, and
 * decidable from any copy already delivered; what changes is how many messages
 * it takes to say they are there.
 */
export const COLLAPSE_STALE_AFTER_MS = abandonedAfterMs(
  HOOK_DEFAULT_WAIT_MS,
  HOOK_RETRY_GRACE_MS,
);

/**
 * How many stale requests it takes to collapse them (APRV-287).
 *
 * Two. A lone stale request keeps its own card, with its payload and both
 * buttons, because collapsing it would take away the ability to approve it and
 * save nobody a message. A flood starts at two.
 */
const COLLAPSE_MIN = 2;

/**
 * A DURATION in words, which is not what {@link ageText} renders.
 *
 * `ageText` says how long ago something happened ("5 min ago"), and these two
 * numbers are lengths of time rather than instants: writing "older than the
 * hook's 5 min ago retry grace" would be a sentence about the wrong kind of
 * thing.
 */
function durationText(ms: number): string {
  if (ms < 60_000) return `${String(Math.round(ms / 1000))}s`;
  const minutes = Math.round(ms / 60_000);
  return `${String(minutes)}m`;
}

/** The computed lines a collapsed re-delivery leads with (APRV-287). */
export function staleLines(requests: ChannelRequest[], now: string): string[] {
  const nowMs = Date.parse(now);
  const ages = requests
    .map((request) => nowMs - Date.parse(request.requested_ts.value))
    .filter((age) => !Number.isNaN(age));
  const oldest = ages.length === 0 ? null : Math.max(...ages);
  const tally = new Map<string, number>();
  for (const request of requests) {
    const cls = request.class.value;
    tally.set(cls, (tally.get(cls) ?? 0) + 1);
  }
  return [
    `${String(requests.length)} pending requests, all older than the hook's ${durationText(HOOK_DEFAULT_WAIT_MS)} wait plus its ${durationText(HOOK_RETRY_GRACE_MS)} retry grace`,
    `oldest: ${oldest === null ? "unknown age" : ageText(oldest)}`,
    `classes: ${[...tally.entries()]
      .map(([cls, count]) => (count === 1 ? cls : `${cls} ×${String(count)}`))
      .join(", ")}`,
    "collapsed into this one message because the tool calls that asked have stopped waiting; a decision on any of them can still authorize an identical retry",
  ];
}

/**
 * Put the requests nobody is waiting on into ONE message, and hand back the
 * ones that still get a message each (APRV-287).
 *
 * Called on a process's first cycle only, which is exactly a daemon start or a
 * listener reconnect. Everything it does is bookkeeping in the sense SPEC.md
 * §10.3 fixes: the pending set is re-derived from the verified log every cycle,
 * so a summary that fails to send, or a process that forgets it sent one,
 * degrades to showing those requests again, and never to a pending request
 * nobody is shown.
 */
async function collapseStale(
  setup: ListenSetup,
  streams: Streams,
  state: DispatchState,
  result: DispatchResult,
  undecided: ChannelRequest[],
  now: string,
): Promise<ChannelRequest[]> {
  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) return undecided;
  const age = (request: ChannelRequest): number => {
    const at = Date.parse(request.requested_ts.value);
    return Number.isNaN(at) ? 0 : nowMs - at;
  };
  const stale = undecided.filter((request) => age(request) >= COLLAPSE_STALE_AFTER_MS);
  if (stale.length < COLLAPSE_MIN) return undecided;

  let delivered: Awaited<ReturnType<TelegramChannel["notifyStale"]>> = null;
  try {
    delivered = await setup.channel.notifyStale(stale, { lines: staleLines(stale, now) });
  } catch (cause) {
    delivered = null;
    streams.err(
      `approval: telegram could not send the collapsed re-delivery of ${String(stale.length)} stale requests: ${
        cause instanceof Error ? cause.message : String(cause)
      } — they are delivered one message each instead\n`,
    );
  }
  if (delivered === null || delivered.digestId === null) {
    // Degrades to showing the requests again, which is this bookkeeping's rule.
    return undecided;
  }

  const digestId = delivered.digestId;
  for (const member of delivered.members) {
    state.delivered.set(member.action_key, member.delivery_id);
    remember(state, member.action_key, now);
    state.attempts.delete(member.action_key);
    result.delivered.push({ action_key: member.action_key, delivery_id: member.delivery_id });
  }
  result.collapsed = {
    delivery_id: digestId,
    action_keys: delivered.members.map((member) => member.action_key),
    oldest_ms: Math.max(...stale.map((request) => age(request))),
  };
  report(setup, streams, digestId, delivered.members);

  const collapsedKeys = new Set(delivered.members.map((member) => member.action_key));
  return undecided.filter((request) => !collapsedKeys.has(request.action_key.value));
}

/**
 * The checkpoint prompt, at most one outstanding and never a nag (APRV-257).
 *
 * Returns `true` when this cycle sent one; the caller decides what that means,
 * and under `paced` it means the cycle is over. It costs the queue one cycle
 * and never more, because a checkpoint prompt is never `paced.current` —
 * nothing releases it, so nothing could be left waiting on it.
 *
 * Three conditions, and each one is a different failure it avoids:
 *
 * 1. **Nothing already in front of the approver** (`paced` only). The whole
 *    content of APRV-216 is one question at a time, and a checkpoint is a
 *    question.
 * 2. **Not already asked for this lapse.** `state.checkpoint.offeredSince`
 *    holds the newest checkpoint's seq at the moment the last prompt went out.
 *    A lapsed cadence produces an offer on every cycle for as long as it lasts,
 *    and a listener that sent one every cycle would be the nag APRV-220 refused
 *    to build. The value moves only when a checkpoint actually LANDS, which is
 *    also when due-ness goes false — so the next prompt comes from the next
 *    lapse.
 * 3. **The policy asked for it.** No cadence, or no key, and there is no offer
 *    at all; `checkpointOfferFor` decides that and this function never second-
 *    guesses it.
 *
 * A send that fails leaves `offered` false, so the next cycle tries again — the
 * same direction a failed request send takes, and for the same reason.
 */
async function offerCheckpoint(
  setup: ListenSetup,
  streams: Streams,
  state: DispatchState,
  result: DispatchResult,
): Promise<boolean> {
  if (setup.delivery === "paced" && state.paced.current !== null) return false;

  const offer = checkpointOfferFor(setup.checkpoint);
  if (offer === null) return false;
  if (state.checkpoint.offered && state.checkpoint.offeredSince === offer.since) return false;

  try {
    const deliveryId = await setup.channel.offerCheckpoint({
      head: offer.head,
      lines: checkpointPromptLines(offer),
    });
    state.checkpoint.offered = true;
    state.checkpoint.offeredSince = offer.since;
    result.checkpoint = {
      delivery_id: deliveryId,
      seq: offer.head.seq,
      hash: offer.head.hash,
    };
    if (setup.json) {
      streams.out(
        `${JSON.stringify({
          event: "checkpoint_offered",
          delivery_id: deliveryId,
          seq: offer.head.seq,
          hash: offer.head.hash,
        })}\n`,
      );
    } else {
      streams.out(
        `offered a checkpoint of seq ${String(offer.head.seq)} (message ${deliveryId})\n`,
      );
    }
    return true;
  } catch (cause) {
    // Never fatal, not even at startup. A checkpoint that is due is a warning
    // at every layer, so a listener that refused to start because it could not
    // ASK for one would have turned a warning into an outage.
    streams.err(
      `approval: telegram could not offer a checkpoint of seq ${String(offer.head.seq)}: ${
        cause instanceof Error ? cause.message : String(cause)
      } — nothing was signed and the next cycle tries again\n`,
    );
    return false;
  }
}

/**
 * What a paced cycle sends: one unit, or nothing (APRV-216).
 *
 * It re-reconciles the walkthrough against the verified log first, and that
 * order is the whole design:
 *
 * 1. **The log decides what exists.** Keys the derivation no longer carries
 *    leave the order and leave the shown unit, however they left the queue —
 *    granted here, rejected from the terminal, withdrawn by their requester,
 *    expired by the daemon. So a decision made anywhere advances the
 *    walkthrough, and nothing this process remembers can keep a settled
 *    question on the phone or a live one off it.
 * 2. **The order is this process's.** Newly pending keys join the back in log
 *    order (oldest first); `/skip` is the only thing that rearranges it.
 * 3. **One at a time.** A unit still holding a pending member means a question
 *    is in front of the approver, and this cycle sends nothing.
 *
 * The unit is a digest group rather than a single request when the oldest
 * pending request has similar company (APRV-115): what is being paced is the
 * approver's ATTENTION, and four identical `network.call`s are one thing to
 * read whether or not they are four things to decide.
 */
function pacedSelection(
  state: DispatchState,
  pending: ChannelRequest[],
  undelivered: ChannelRequest[],
): ChannelRequest[] | null {
  const paced = state.paced;
  const pendingKeys = pending.map((request) => request.action_key.value);
  const pendingSet = new Set(pendingKeys);

  paced.order = paced.order.filter((key) => pendingSet.has(key));
  const known = new Set(paced.order);
  for (const key of pendingKeys) {
    if (!known.has(key)) paced.order.push(key);
  }

  if (paced.current !== null) {
    paced.current = paced.current.filter((key) => pendingSet.has(key));
    if (paced.current.length === 0) paced.current = null;
  }

  // A count the approver was told that is now too high is not a growth to
  // announce; it is the number they watched go down. Clamping here is what
  // makes "the pending set grew" mean growth from wherever it actually is.
  paced.announced = Math.min(paced.announced, pendingKeys.length);

  if (paced.current !== null) return null;

  const available = new Map(
    undelivered.map((request) => [request.action_key.value, request] as const),
  );
  const nextKey = paced.order.find((key) => available.has(key));
  if (nextKey === undefined) return null;

  return (
    groupForDigest(undelivered).find((group) =>
      group.some((request) => request.action_key.value === nextKey),
    ) ?? null
  );
}

/**
 * The request, plus a model's one-sentence gloss when one can be had (APRV-144).
 *
 * The attaching itself moved to `cli/gloss-attach.ts` in APRV-197, when the
 * terminal channel needed the same thing; what stays here is the listener's own
 * two decisions. Whether to ask at all is `setup.gloss`, which the verb sets
 * only under `--gloss`. What to do with the answer is nothing, except count it:
 * absence used to be silent by design, and with the old 2s ceiling that made a
 * chronically failing subprocess indistinguishable from a feature nobody built.
 *
 * Once per request, not once per cycle: a request already in `delivered` never
 * reaches this.
 */
function withGloss(
  setup: ListenSetup,
  request: ChannelRequest,
  tally: { asked: number; absent: number },
): ChannelRequest {
  if (setup.gloss === undefined) return request;
  const attached = attachGloss(request, setup.gloss);
  if (attached.outcome !== "opaque") tally.asked += 1;
  if (attached.outcome === "absent") tally.absent += 1;
  return attached.request;
}

/** Deliver each request as its own prompt: the pre-digest path, unchanged. */
async function deliverUnits(
  setup: ListenSetup,
  streams: Streams,
  state: DispatchState,
  result: DispatchResult,
  requests: ChannelRequest[],
  now: string,
): Promise<void> {
  for (const request of requests) {
    const actionKey = request.action_key.value;
    try {
      const deliveryId = await setup.channel.notify(request);
      state.delivered.set(actionKey, deliveryId);
      remember(state, actionKey, now);
      state.attempts.delete(actionKey);
      result.delivered.push({ action_key: actionKey, delivery_id: deliveryId });
      report(setup, streams, null, [{ action_key: actionKey, delivery_id: deliveryId }]);
    } catch (cause) {
      // The key stays out of `delivered`, so the next cycle tries again.
      const attempts = (state.attempts.get(actionKey) ?? 0) + 1;
      state.attempts.set(actionKey, attempts);
      const message = cause instanceof Error ? cause.message : String(cause);
      result.failed.push({ action_key: actionKey, attempts, message });
    }
  }
}

/** One `notified` line (or JSON object) per request actually delivered. */
function report(
  setup: ListenSetup,
  streams: Streams,
  digestId: DeliveryId | null,
  members: { action_key: string; delivery_id: DeliveryId }[],
): void {
  for (const member of members) {
    if (setup.json) {
      streams.out(
        `${JSON.stringify({
          event: "notified",
          action_key: member.action_key,
          delivery_id: member.delivery_id,
          ...(digestId === null ? {} : { digest_id: digestId, digest_size: members.length }),
        })}\n`,
      );
    } else {
      streams.out(
        digestId === null
          ? `notified ${member.action_key} (message ${member.delivery_id})\n`
          : `notified ${member.action_key} (digest ${digestId}, ${members.length} requests)\n`,
      );
    }
  }
}

/**
 * Report a steady-state cycle's problems on stderr. Startup reports its own,
 * as exit codes, in {@link runListener}.
 */
export function reportCycle(result: DispatchResult, streams: Streams): void {
  if (result.queueError !== undefined) {
    streams.err(
      `approval: telegram cannot read the pending queue (${result.queueError.code}): ${result.queueError.message} — retrying next cycle\n`,
    );
  }
  for (const failure of result.failed) {
    // Loud for the first few, then every tenth: an outage must stay visible
    // without turning the operator's terminal into a log of one message.
    if (failure.attempts > DISPATCH_LOUD_ATTEMPTS && failure.attempts % 10 !== 0) continue;
    streams.err(
      `approval: telegram sendMessage failed for ${failure.action_key} (attempt ${failure.attempts}): ${failure.message} — still pending, retrying next cycle\n`,
    );
  }
}

/** The decision handler: the only thing this process does with a button press. */
function handlerFor(setup: ListenSetup, streams: Streams): (d: ChannelDecision) => DecisionOutcome {
  return (decision) => {
    const result = recordChannelDecision(
      setup.logPath,
      decision,
      { actor: setup.actor, channel: "telegram" },
      setup.gateOptions,
    );

    if (setup.json) {
      streams.out(
        `${JSON.stringify({
          event: "decision",
          action_key: decision.action_key,
          decision: decision.decision,
          ok: result.outcome.ok,
          ...(result.outcome.ok
            ? { seq: result.outcome.record.seq, state: result.outcome.state }
            : { code: result.outcome.code }),
          // The token is NEVER in the JSON stream either: --json output is the
          // thing most likely to be piped into a file or a log aggregator.
          token_issued: result.token !== undefined,
        })}\n`,
      );
    } else if (result.outcome.ok) {
      // APRV-324: the actor off the RECORD, not the one this process was
      // launched with. Under a sender mapping they differ, and the line a human
      // reads on the operator's terminal has to say who the log says decided.
      streams.out(
        `${decision.decision === "grant" ? "granted" : "rejected"} ${decision.action_key} (seq ${result.outcome.record.seq}) by ${result.outcome.record.actor} via telegram\n`,
      );
    } else {
      streams.err(
        `approval: telegram decision refused (${result.outcome.code}): ${result.outcome.message}\n`,
      );
    }

    // APRV-17: the raw token is printed exactly once, here, on this terminal's
    // stdout. It is not sent to Telegram (a chat transcript is not a secrets
    // channel), not written to the log (which holds only its sha256), and not
    // handed back to the channel. Once this line scrolls away it is gone.
    if (result.token !== undefined) {
      // APRV-102: the shared rule-boxed panel, with the Telegram clause of the
      // notice — the one surface where "not sent to Telegram" is a fact the
      // reader might otherwise doubt, having just decided in a chat window.
      streams.out(
        `${tokenPanel(style(), decision.action_key, result.token, TOKEN_NOTICE_TELEGRAM)}\n`,
      );
    }

    return result.outcome;
  };
}

/**
 * What a checkpoint tap does, on the machine the listener runs on (APRV-257).
 *
 * The signing happens HERE, in the listener's process, and that is the whole
 * point of the tap: this process holds the vault passphrase because a HUMAN
 * exported it into the shell they started it from, and `core/child-env.ts`
 * strips that variable from every child an agent's session spawns. No agent can
 * arrange for a process that reaches this function with a key.
 *
 * Nothing about the head is re-derived. The `(seq, hash)` comes back from the
 * channel exactly as it was put on the screen, and
 * {@link ../core/checkpoint.js appendCheckpointAt} signs that and checks the
 * log still carries it. A handler that quietly re-read the head would be
 * putting a human's key over bytes nobody looked at.
 *
 * `Not now` appends nothing and says so. It is not a rejection: there is no
 * request here to reject, and a checkpoint that is owed is a warning at every
 * layer and a refusal at none.
 */
/**
 * Where this listener's policy lives, as `loadPolicy` wants it (APRV-324
 * follow-up).
 *
 * The same location every gate operation this process performs resolves,
 * because the handlers below ask the policy who a sender is and the gate asks
 * it what a class resolves to, and two different files answering those two
 * questions would be a listener enforcing one policy and attributing under
 * another.
 */
function policyLoadOptions(setup: ListenSetup): { file?: string; dir?: string } {
  const policy = setup.gateOptions.policy;
  if (policy?.file !== undefined) return { file: policy.file };
  if (policy?.dir !== undefined) return { dir: policy.dir };
  return {};
}

/**
 * The identity a phone gesture is recorded under — or the refusal that replaces
 * it (APRV-324 follow-up).
 *
 * ## Why this is not just `actorForSender`
 *
 * A decision is protected twice. The mapping chooses the actor, and then
 * `decide` refuses `policy-not-attested` or `policy-drift` if the bytes on disk
 * are not the bytes in force, so a mapping edited and not attested can never
 * reach a grant. Checkpoint signing and review recording have no such backstop:
 * they read the policy, act, and append. Without this check an edited
 * `APPROVAL.md` that dropped or repointed the `senders` block would change who
 * may sign a checkpoint or file a review from a phone **before any human had
 * attested it**, which is precisely the property SPEC.md §5.2 and this
 * module's own header claim it does not have — an edited policy is inoperative
 * until a human re-attests it.
 *
 * So when a gesture carries a sender, the policy it is resolved against must be
 * the attested one. The check is `core/attest.ts`'s own
 * {@link checkAttestation}, the same function the gate's attestation refusal is
 * built on, rather than a second comparison written here that could come to a
 * different conclusion about the same file.
 *
 * With no sender, nothing changes: the gesture is attributed by configuration
 * exactly as it was before the mapping existed, and a terminal — which
 * authenticates no sender — can still sign and still review whatever state the
 * policy file is in. That is what keeps the repair path open.
 */
type GestureIdentity =
  | { ok: true; actor: string; sender?: RecordedSender; source?: SenderSource }
  | { ok: false; code: string; message: string; sender: RecordedSender };

function senderIdentityFor(
  setup: ListenSetup,
  sender: ChannelSender | undefined,
): GestureIdentity {
  const load = loadPolicy(policyLoadOptions(setup));
  if (sender === undefined) return { ok: true, actor: setup.actor };

  // APRV-370. The operator's sender key, and with it the form the two refusals
  // below record the account in. Those two never reach the in-force mapping,
  // so they take `recordedSenderFor`'s rule: the form follows the FILE, the
  // mapping follows the ATTESTATION.
  const key = senderKeyFrom();
  if (load.ok) {
    const read = readVerifiedRecords(setup.logPath);
    if (!read.ok) {
      return {
        ok: false,
        code: "policy-not-attested",
        sender: recordedSenderFor(load, sender, key),
        message: `the log could not be read to check whether ${load.source.filename} is attested (${read.code}): ${read.message}. Nothing was recorded; a decision made at a terminal carries no sender and is unaffected.`,
      };
    }
    // `core/attest.ts`'s own check and its own wording, rather than a second
    // comparison written here that could come to a different conclusion about
    // the same file than the one the gate's refusal is built on.
    const refusal = attestationRefusal(checkAttestation(read.records, load.source.path));
    if (refusal !== null) {
      return {
        ok: false,
        code: refusal.code,
        sender: recordedSenderFor(load, sender, key),
        message: `${refusal.message}. The sender mapping it declares is therefore not in force, so the account this gesture came from cannot be resolved against it and nothing was recorded. Re-attest the policy, or do this from a terminal, which authenticates no sender and is unaffected by the mapping.`,
      };
    }
  }

  return actorForSender(load, setup.actor, sender, key);
}

/**
 * Record that a gesture this listener refused was made (APRV-355).
 *
 * Best-effort, and after the refusal is already decided: the card the person
 * sees does not depend on this write landing. A failure is reported on stderr
 * beside the refusal it was about, because a record that silently did not land
 * is exactly the gap this task exists to close, and one that fails quietly is
 * the same gap wearing a fix.
 *
 * The runtime cannot name a person on `sender-unmapped` or `sender-ambiguous`,
 * which is the whole point of those refusals, so `actor` is the listener's
 * configured identity ONLY where the resolution produced one. The observed
 * account goes in either way; it is the only thing known about who tapped.
 */
function recordGestureRefusal(
  setup: ListenSetup,
  streams: Streams,
  gesture: RefusedGestureKind,
  refused: { ok: false; code: string; message: string; sender: RecordedSender },
): void {
  const recorded = recordRefusedGesture(
    setup.logPath,
    {
      gesture,
      actor: null,
      channel: "telegram",
      sender: refused.sender,
    },
    { code: refused.code, message: refused.message },
    setup.gateOptions,
  );
  if (!recorded.ok) {
    streams.err(
      `approval: telegram ${gesture} refusal could not be recorded (${recorded.code}): ${recorded.message}\n`,
    );
  }
}

export function checkpointHandlerFor(
  setup: ListenSetup,
  streams: Streams,
): (tap: {
  sign: boolean;
  head: { seq: number; hash: string };
  sender?: ChannelSender;
}) => CheckpointTapResponse {
  return (tap) => {
    // APRV-324 follow-up, and FIRST, before the decline branch is even
    // considered: a signature says this log's head is what this person saw, so
    // an account the ATTESTED policy does not name may not produce one. Under
    // no mapping this resolves to the configured identity and the whole branch
    // is today's behaviour.
    const resolved = senderIdentityFor(setup, tap.sender);
    if (!resolved.ok) {
      streams.err(`approval: telegram checkpoint refused (${resolved.code}): ${resolved.message}\n`);
      recordGestureRefusal(setup, streams, "checkpoint-signature", resolved);
      return {
        ok: false,
        headline: TELEGRAM_NOT_RECORDED,
        detail: [refusedDecisionLine(resolved.code)],
        toast: "Not signed.",
      };
    }

    if (!tap.sign) {
      return {
        ok: true,
        headline: "NOT SIGNED",
        detail: [
          `The checkpoint of seq ${String(tap.head.seq)} was declined. Nothing was appended.`,
          "A checkpoint that is owed is a warning and never a refusal; you will be asked again when the next one is due.",
        ],
        toast: "Not now.",
      };
    }

    const result = signCheckpointOffer(
      setup.checkpoint,
      tap.head,
      resolved.actor,
      "telegram",
      process.cwd(),
    );
    const lines = checkpointSignedLines(result);
    const [headline, ...detail] = lines;

    if (setup.json) {
      streams.out(
        `${JSON.stringify({
          event: "checkpoint",
          ok: result.ok,
          seq: result.ok ? result.seq : null,
          signed: tap.head,
          ...(result.ok ? {} : { code: result.code }),
        })}\n`,
      );
    } else if (result.ok) {
      streams.out(
        `checkpoint ${String(result.seq)}: signed head seq ${String(result.signed.seq)} ${result.signed.hash} by ${resolved.actor} via telegram\n`,
      );
    } else {
      streams.err(`approval: telegram checkpoint refused (${result.code}): ${result.message}\n`);
    }

    return {
      ok: result.ok,
      headline: headline ?? "NOT CHECKPOINTED",
      detail,
      toast: result.ok ? "Signed." : "Not signed — the message says why.",
    };
  };
}

/**
 * What a review tap does: the human-only `reviewSample`, and nothing else
 * (APRV-299).
 *
 * The one path from a button on a phone to an `audit.reviewed`, and it is the
 * SAME path `approval audit review` takes — same function, same refusals, same
 * record shape — so a reaction given on a card and one given at a terminal are
 * indistinguishable to `approval feedback`, which is the whole of AC3.
 *
 * The actor is `setup.actor`, the human identity this listener was configured
 * with (`--as` / `APPROVAL_HUMAN`), exactly as a grant's is. It is never read
 * off the tap, never off the callback, and never out of a payload field: this
 * channel does not authenticate the person who pressed the button, and SPEC.md
 * §11's config-declared identity is what a review is recorded against. Anyone
 * who can reach the configured chat reviews as that actor, which is the same
 * trust boundary a tapped grant already stands on.
 *
 * The reaction is passed through untouched and NOTHING here reads it (SPEC.md
 * §11.1 invariant 10): it is a field on a record, chosen by a human, on its way
 * to the log.
 */
export function reviewHandlerFor(
  setup: ListenSetup,
  streams: Streams,
): (tap: {
  sampleSeq: number;
  verdict: "ok" | "denied";
  reaction?: "disliked" | "indifferent" | "liked" | "loved";
  note?: string;
  sender?: ChannelSender;
}) => ReviewTapResponse {
  return (tap) => {
    // APRV-324 follow-up. A review confers no authority and is still a HUMAN's
    // observation: `approval feedback` hands it to agents as human-authored
    // guidance, so a review attributed to the wrong person is guidance in
    // somebody else's name. Resolved against the ATTESTED policy exactly as a
    // signature is, and under no mapping this is the configured identity and
    // today's behaviour.
    const resolved = senderIdentityFor(setup, tap.sender);
    if (!resolved.ok) {
      streams.err(`approval: telegram review refused (${resolved.code}): ${resolved.message}\n`);
      // `review-note` when the tap carried words: a note is attention spent
      // writing rather than attention spent tapping, and an operator reading
      // this record wants to know which they lost (APRV-355).
      recordGestureRefusal(
        setup,
        streams,
        tap.note === undefined || tap.note.trim().length === 0 ? "review" : "review-note",
        resolved,
      );
      return {
        ok: false,
        headline: TELEGRAM_NOT_RECORDED,
        detail: [refusedDecisionLine(resolved.code)],
        toast: "Not recorded.",
      };
    }

    const result = reviewSample(
      setup.logPath,
      { kind: "seq", seq: tap.sampleSeq },
      resolved.actor,
      tap.note ?? null,
      {
        ...(setup.gateOptions.policy === undefined ? {} : { policy: setup.gateOptions.policy }),
        verdict: tap.verdict,
        ...(tap.reaction === undefined ? {} : { reaction: tap.reaction }),
        ...(resolved.sender === undefined
          ? {}
          : {
              sender: resolved.sender,
              ...(resolved.source === undefined ? {} : { senderSource: resolved.source }),
            }),
      },
    );

    if (!result.ok) {
      // SPEC.md §11.1 invariant 6: the code is machine-readable and distinct,
      // and it reaches the approver as itself. The card carries both halves —
      // the code on its own line, the message under it — because the codes that
      // get here are ones a reviewer can act on: `reaction-conflicts-verdict`
      // asks which half they meant, `note-required` asks for words.
      streams.err(
        `approval: telegram review refused (${result.code}): ${result.message}\n`,
      );
      if (setup.json) {
        streams.out(
          `${JSON.stringify({
            event: "review",
            ok: false,
            sample_seq: tap.sampleSeq,
            verdict: tap.verdict,
            reaction: tap.reaction ?? null,
            code: result.code,
          })}\n`,
        );
      }
      return {
        ok: false,
        headline: TELEGRAM_NOT_RECORDED,
        detail: [result.code, result.message],
        toast: "Not recorded — the card says why.",
      };
    }

    const obligation = result.obligation;
    if (setup.json) {
      streams.out(
        `${JSON.stringify({
          event: "review",
          ok: true,
          seq: result.record.seq,
          sample_seq: result.subject.seq,
          action_key: result.subject.actionKey,
          verdict: tap.verdict,
          reaction: tap.reaction ?? null,
          obligation_seq: obligation === null ? null : obligation.seq,
        })}\n`,
      );
    } else {
      streams.out(
        `reviewed sample at seq ${String(result.subject.seq)} (action ${
          result.subject.actionKey ?? "-"
        }) at seq ${String(result.record.seq)} by ${setup.actor} via telegram${
          tap.verdict === "denied" ? " — DENIED" : ""
        }${tap.reaction === undefined ? "" : ` — reaction: ${tap.reaction} (guidance, not policy)`}\n`,
      );
    }

    const detail = [
      `recorded at seq ${String(result.record.seq)} by ${setup.actor} · verdict ${tap.verdict}`,
      ...(tap.reaction === undefined
        ? []
        : [`reaction: ${tap.reaction} — guidance, not policy; it changes no verdict and no budget`]),
      ...(tap.note === undefined || tap.note.trim().length === 0
        ? []
        : [`note: ${tap.note.trim()}`]),
    ];
    if (obligation !== null) {
      // APRV-127's reconciliation, said on the reply: a denial cannot undo
      // anything, and what it DOES is open an obligation somebody has to
      // discharge. An approver who denied on a phone learns that here rather
      // than from a health surface later.
      const shape = String(
        (obligation.payload as Record<string, unknown> | undefined)?.["obligation"] ?? "",
      );
      detail.push(
        shape === "gated-revert"
          ? `reconciliation obligation at seq ${String(obligation.seq)}: GATED REVERT. The action was declared reversible, so undo it through the gate and close this with \`approval audit reconcile ${String(obligation.seq)} --revert <action-key> --note "…"\`.`
          : `reconciliation obligation at seq ${String(obligation.seq)}: POLICY FINDING. Nothing can be reverted, so what is owed is a review of the class that permitted this. Close it with \`approval audit reconcile ${String(obligation.seq)} --note "…"\` once that review has happened.`,
      );
    }

    return {
      ok: true,
      headline: tap.verdict === "denied" ? TELEGRAM_REVIEW_DENIED : TELEGRAM_REVIEW_RECORDED,
      detail,
      toast: tap.verdict === "denied" ? "Recorded — denied." : "Recorded.",
    };
  };
}

/**
 * `/queue`, `/skip`, `/next` — the paced walkthrough's three verbs (APRV-216).
 *
 * **None of them appends anything**, and the reason is structural rather than
 * careful: this function never touches `recordChannelDecision`, so there is no
 * path from a typed word to the log. A decision is a button, always, because a
 * button carries the nonce and the action reference that bind an answer to the
 * bytes an approver was shown, and a word typed into a chat carries neither.
 *
 * What they do move is process memory:
 *
 * - `/queue` reads the verified log and replies with the summary and a numbered
 *   list. It changes nothing, and it works while a request is selected, because
 *   the list is derived and not held. The reply says outright that it carries no
 *   buttons and that it cannot vouch for a card it once sent (APRV-256).
 * - `/skip` sends the shown unit to the BACK of this process's order and
 *   forgets having delivered it, so the next cycle shows the next question and
 *   this one comes round again after the rest. The copy already in the chat
 *   keeps its buttons, and they still decide the same request by action
 *   reference (APRV-196), so a skip is "later", never "gone".
 * - `/next` releases the shown unit without reordering, so this process moves
 *   past it and does not show it again. The same copy stays live in the chat:
 *   the approver has kept the question and given up their place in the queue,
 *   which is the opposite trade from `/skip`.
 *
 * A command that finds nothing to do says so, because silence in a chat window
 * is indistinguishable from a listener that has died.
 */
export function commandHandlerFor(
  setup: ListenSetup,
  streams: Streams,
  state: DispatchState,
  /**
   * When the command arrived. A clock read in production, because a command is
   * answered when a human types it; injectable for the same reason
   * {@link dispatchPending} takes `now` as a parameter, since the ages a reply
   * states are arithmetic against it and a suite must be able to choose them.
   */
  clock: () => string = () => new Date().toISOString(),
): (command: TelegramCommand) => Promise<void> {
  const say = async (lines: string[]): Promise<void> => {
    try {
      await setup.channel.announce(lines);
    } catch (cause) {
      streams.err(
        `approval: telegram could not answer a command: ${
          cause instanceof Error ? cause.message : String(cause)
        } — nothing was appended and the listener is still up\n`,
      );
    }
  };

  return async (command) => {
    const now = clock();

    if (command === "queue") {
      const queue = buildPendingQueue(setup.logPath, setup.tagOptions, now);
      if (!queue.ok) {
        // SPEC.md §11.1(1): a sentence a human reads about what the log says is
        // derived from a log that verified, or it is not derived at all. So the
        // reply names the refusal rather than a queue nobody could derive.
        streams.err(
          `approval: telegram cannot read the pending queue for /queue (${queue.code}): ${queue.message}\n`,
        );
        await say([
          "The queue could not be read.",
          `The log did not verify or could not be read (${queue.code}). Nothing is decided and nothing is lost; the listener retries every cycle.`,
        ]);
        return;
      }
      // APRV-299. The retrospective backlog is part of what the log is holding,
      // and `/queue` is the verb that says what that is. Appended rather than
      // interleaved, because the two lists answer different questions: one is
      // what is waiting on the approver, the other what already happened.
      const lines = queueLines(queue.requests, now, state.paced.current ?? []);
      const built = openReviewCards(setup.logPath);
      if (built.ok && built.cards.length > 0) lines.push(...reviewSummaryLines(built.cards, now));
      await say(lines);
      return;
    }

    const shown = state.paced.current;
    if (shown === null) {
      // APRV-299. With no request selected, the two verbs act on the review
      // card if one is in front of the approver. Neither decides anything here
      // either: the sample stays open in the log whichever way it goes, and
      // `approval audit review <seq>` still names it from a terminal.
      const card = state.review.current;
      if (card !== null) {
        state.review.current = null;
        if (command === "skip") {
          state.review.delivered.delete(card);
          state.review.order = state.review.order.filter((seq) => seq !== card);
          state.review.order.push(card);
        }
        await say([
          command === "skip"
            ? `Review of sample ${String(card)} skipped — it goes to the back of the order and a fresh card is sent once the rest have had their turn.`
            : `Review of sample ${String(card)} passed over — this listener sends no further card for it.`,
          "Nothing was recorded. The sample is still open: it is listed by `approval audit list` and reviewable with `approval audit review " +
            String(card) +
            "`, and the card already in this chat keeps its buttons.",
        ]);
        return;
      }
      await say([
        // APRV-256: selection language, matching `/queue`'s. "In front of you"
        // was a claim about the approver's screen, which this process has never
        // been able to see.
        command === "skip"
          ? "Nothing to skip — this listener has no request selected."
          : "This listener has no request selected right now.",
        "The next pending request is sent with its buttons on an upcoming cycle. /queue lists what the log is holding.",
      ]);
      return;
    }

    state.paced.current = null;
    if (command === "skip") {
      for (const key of shown) {
        // Forgotten as well as reordered: the delivery bookkeeping is what stops
        // a re-send, so a request that must be SHOWN again has to leave it. The
        // message already in the chat is untouched and still decides.
        forget(state, key);
        state.paced.order = state.paced.order.filter((entry) => entry !== key);
        state.paced.order.push(key);
      }
    }
  };
}

/**
 * How one run of the listen loop ended (APRV-110).
 *
 * `stopped` is the ordinary ending: a signal, or `--once` completing. The two
 * failures are the ones the startup cycle has always treated as fatal, hoisted
 * out of the verb so that a supervisor can treat them as a part that fell over
 * rather than as a process that must exit.
 */
export type ListenerOutcome =
  | { kind: "stopped" }
  | { kind: "queue-error"; code: ChannelTagRefusalCode; message: string }
  | { kind: "send-failed"; message: string };

/** A listen loop that is already running. {@link stop} ends it cleanly. */
export interface RunningListener {
  /** Settles when the loop ends. Never rejects for a listener-shaped failure. */
  readonly done: Promise<ListenerOutcome>;
  /** Stop the loop, now or as soon as it reaches its first poll. */
  stop(): void;
}

/**
 * Start the dispatch-and-poll loop. **Installs no signal handler** and chooses
 * no exit code (APRV-110): both are the caller's, because `approval up` runs
 * this beside a daemon loop and a web server under one set of handlers.
 *
 * A FRESH {@link DispatchState} per call, which is the whole of the restart
 * story: a supervisor that restarts a fallen listener re-derives the pending
 * queue from the verified log and re-sends everything still pending, exactly as
 * a restarted process would. A duplicate on the phone, never a silence.
 */
/**
 * Give the channel every handler the runtime answers a gesture with, and hand
 * back the fresh dispatch bookkeeping (APRV-424).
 *
 * Extracted from {@link startListener} so the webhook runner wires the SAME
 * four handlers rather than a second set that looks like them. This is the
 * CLI-side half of the property APRV-424 is about: the transport decides where
 * an update arrives, and nothing else. A tap that arrives by webhook is
 * recorded by `handlerFor`'s `recordChannelDecision` — the same actor, the
 * same sender resolution, the same gate — because it is the same function
 * object, registered here.
 *
 * A FRESH {@link DispatchState} per call, which is the whole of the restart
 * story: a supervisor that restarts a fallen runner re-derives the pending
 * queue from the verified log and re-sends everything still pending. A
 * duplicate on the phone, never a silence.
 */
export function wireListener(setup: ListenSetup, streams: Streams): DispatchState {
  const { channel } = setup;
  channel.onDecision(handlerFor(setup, streams));
  // APRV-257. Registered unconditionally, because whether a checkpoint is ever
  // OFFERED is the policy's answer and a handler that exists for a prompt
  // nobody sends costs nothing. Registering it here is also what makes the
  // channel's `offerCheckpoint` legal at all: it refuses to send a button
  // nothing is listening for.
  channel.onCheckpoint(checkpointHandlerFor(setup, streams));
  // APRV-299. Registered unconditionally, for the same reason the checkpoint
  // handler is: whether a review card is ever OFFERED is the log's answer (an
  // open `audit.sampled`), and a handler that exists for a card nobody sends
  // costs nothing. Registering it is also what makes `offerReview` legal at
  // all, and what makes the channel read the `message` updates a note reply
  // arrives on.
  channel.onReview(reviewHandlerFor(setup, streams));

  // Delivery bookkeeping is in memory only — channels hold no state (SPEC.md
  // §10.3). A restarted listener therefore re-sends everything still pending.
  // Duplicated messages are the acceptable failure; a decision that depends on
  // a channel's memory surviving a crash is not. Since APRV-196 the duplicates
  // announce themselves (the banner this cycle sends) and the buttons on the
  // pre-restart copies still decide the same request, so what a restart costs
  // the approver is a longer transcript rather than a stuck one.
  const state = newDispatchState();

  // APRV-216. Registering the command handler is also what makes the channel
  // ask for `message` updates at all, so a burst listener consumes none and
  // `approval setup channel telegram`'s chat discovery is untouched by this
  // task. See `TelegramChannel.onCommand`.
  if (setup.delivery === "paced") {
    channel.onCommand(commandHandlerFor(setup, streams, state));
  }
  return state;
}

export function startListener(setup: ListenSetup, streams: Streams): RunningListener {
  const { channel } = setup;
  const state = wireListener(setup, streams);

  let stopping = false;
  const stop = (): void => {
    stopping = true;
    channel.stop();
  };

  const done = (async (): Promise<ListenerOutcome> => {
    // The startup cycle. Same call as every later one; only its *failures* are
    // treated differently, because an operator who has just mistyped a token or
    // pointed at an unreadable log should learn it at once rather than watch a
    // retry loop.
    const startup = await dispatchPending(setup, streams, state, new Date().toISOString());
    if (startup.queueError !== undefined) {
      return { kind: "queue-error", ...startup.queueError };
    }
    const firstFailure = startup.failed[0];
    if (firstFailure !== undefined) {
      return { kind: "send-failed", message: firstFailure.message };
    }
    // A stop that arrived during the startup cycle: `listen()` clears its own
    // stopped flag on entry, so a loop entered now would ignore it and block.
    if (stopping) return { kind: "stopped" };

    // Every subsequent cycle: re-derive, send what is new, complain and carry
    // on. Runs before each `getUpdates`, including the poll after a recovered
    // poll error, so a request appended mid-run is delivered without a restart.
    const beforePoll = async (): Promise<void> => {
      reportCycle(await dispatchPending(setup, streams, state, new Date().toISOString()), streams);
    };

    // APRV-390. The 409's report reads the ownership registry at the moment
    // the conflict happens; the channel prints what this returns and knows
    // nothing about instances or files.
    const conflictAdvice = conflictAdviceFor(setup);

    await channel.listen(
      setup.once ? { once: true, beforePoll, conflictAdvice } : { beforePoll, conflictAdvice },
    );

    if (setup.json) {
      streams.out(`${JSON.stringify({ event: "stopped", ...channel.stats() })}\n`);
    }
    return { kind: "stopped" };
  })();

  return { done, stop };
}

async function runListener(setup: ListenSetup, streams: Streams): Promise<number> {
  // APRV-390. Before anything is delivered and before the first poll: whose
  // bot is this? An override that got this far still owes the operator the
  // sentence, because the whole point of `--allow-cross-instance` is that the
  // deliberate case is deliberate out loud.
  for (const finding of setup.crossInstance) {
    streams.err(`approval: --allow-cross-instance: starting anyway — ${finding.detail}\n`);
  }
  const claimed = await claimListenerBot(setup, (message) => streams.err(`${message}\n`));
  if (!claimed.ok) return integrityError(streams, setup.json, claimed.message);

  const running = startListener(setup, streams);
  const stop = (): void => running.stop();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let outcome: ListenerOutcome;
  try {
    outcome = await running.done;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    // The transport lease goes back on every exit, clean or not (APRV-424
    // review finding 1). A listener that crashed leaves a lockfile whose pid
    // is gone and the next taker reclaims it; a listener that stopped politely
    // leaves nothing to reclaim.
    claimed.lease.release();
  }

  switch (outcome.kind) {
    case "stopped":
      return EXIT_OK;
    case "queue-error":
      return outcome.code === "log-unreadable"
        ? ioError(streams, setup.json, outcome.message)
        : integrityError(streams, setup.json, outcome.message);
    case "send-failed":
      return ioError(streams, setup.json, `telegram sendMessage failed: ${outcome.message}`);
  }
}

/**
 * The listener verb. Returns a promise, which is why `main` treats `channel`
 * specially: it is the only long-lived command in the CLI.
 */
export function commandTelegramListen(
  argv: string[],
  streams: Streams,
  cwd: string,
): number | Promise<number> {
  const prepared = setUp(argv, streams, cwd);
  if (prepared.kind === "handled") return prepared.code;
  return runListener(prepared.setup, streams);
}

// ---------------------------------------------------------------------------
// approval channel telegram health
// ---------------------------------------------------------------------------

/**
 * Configuration health, offline.
 *
 * It answers one question — "is this runtime configured to talk to Telegram?"
 * — and deliberately makes no network call: a health check that contacted the
 * Bot API would leak the existence of the bot from any shell, and would fail
 * for reasons (a captive portal, a rate limit) that say nothing about whether
 * the operator's configuration is right. The *live* counters (deliveries,
 * decisions, ignored callbacks, recovered poll errors) belong to a running
 * listener and are surfaced by `TelegramChannel.health()` / `stats()` in
 * process, and on the listener's stderr as they happen.
 */
export function commandTelegramHealth(argv: string[], streams: Streams, cwd: string): number {
  const json = argv.includes("--json");
  const parsed = parseFlags(argv, {
    "--policy": "string",
    "--dir": "string",
    // APRV-390. Which instance's ownership record to read. Accepted here for
    // the same reason `listen` accepts it: a gate may be configured with its
    // log somewhere other than beside the policy.
    "--log": "string",
    "--json": "boolean",
    "--help": "boolean",
    "-h": "boolean",
  });
  if (!parsed.ok) return usageError(streams, json, parsed.message, TELEGRAM_HEALTH_HELP);
  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${TELEGRAM_HEALTH_HELP}\n`);
    return EXIT_OK;
  }

  // Which variables to look at is a policy question (§5.1), so this offline
  // check reads the policy for the NAMES — and only the names. It still makes
  // no network call, and an unloadable policy leaves the defaults in force
  // rather than reporting a channel that cannot be configured at all.
  const policyFlag = stringFlag(parsed.flags, "--policy");
  const dirFlag = stringFlag(parsed.flags, "--dir");
  const policyLoad = loadPolicy(
    policyFlag !== null
      ? { file: absolute(policyFlag, cwd) }
      : { dir: dirFlag === null ? cwd : absolute(dirFlag, cwd) },
  );
  const tokenEnv = telegramTokenEnvFor(policyLoad);
  const chatEnv = telegramChatEnvFor(policyLoad);

  const token = env(tokenEnv);
  const chatId = env(chatEnv);
  const ok = token !== null && chatId !== null;

  // APRV-390. Which bot, and whose. Read from the two ownership records and
  // never from the network: this verb makes no Bot API call on any path, and
  // the last `getMe` a listener or a setup run made is already written down.
  // An instance that has never started a listener has no record, which is a
  // state and not a fault — the row says so rather than guessing.
  const logPath = resolvePath(
    stringFlag(parsed.flags, "--log"),
    DEFAULT_LOG_PATH,
    dirFlag === null ? cwd : absolute(dirFlag, cwd),
  );
  const mine = ownedBot(logPath, "telegram");
  const others = mine === null ? [] : otherOwnersOf(logPath, mine.botId, mine.apiBase);
  const ownership =
    mine === null
      ? "no bot recorded for this instance yet: it is written by the first `approval up` or `approval channel telegram listen` that reaches getMe"
      : others.length === 0
        ? `bot ${mine.username} (id ${mine.botId}) is owned by this instance, ${mine.instanceHome} (instance ${mine.instanceId}), recorded ${mine.claimedAt}`
        : `bot ${mine.username} (id ${mine.botId}) is claimed by this instance AND by ${describeOwners(others)}; one of them must be given its own bot`;

  if (json) {
    streams.out(
      `${JSON.stringify({
        ok,
        channel: "telegram",
        // Presence only. The token's value never appears in any output.
        token_env: tokenEnv,
        token_set: token !== null,
        chat_env: chatEnv,
        chat_id: chatId,
        // APRV-390. Names and ids, never a value.
        bot_username: mine?.username ?? null,
        bot_id: mine?.botId ?? null,
        owner_instance: mine?.instanceId ?? null,
        owner_home: mine?.instanceHome ?? null,
        other_owners: others.map((claim) => ({
          instance_id: claim.instanceId,
          instance_home: claim.instanceHome,
        })),
      })}\n`,
    );
  } else if (ok) {
    streams.out(`telegram: configured (${tokenEnv} set, chat ${String(chatId)})\n`);
    streams.out(`  ${ownership}\n`);
  } else {
    streams.err(
      `approval: telegram is not configured: ${[
        token === null ? tokenEnv : null,
        chatId === null ? chatEnv : null,
      ]
        .filter((name) => name !== null)
        .join(" and ")} unset or empty\n`,
    );
  }
  return ok ? EXIT_OK : EXIT_INTEGRITY;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export function commandTelegram(
  argv: string[],
  streams: Streams,
  cwd: string,
): number | Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  const json = argv.includes("--json");

  if (sub === undefined) {
    return usageError(streams, json, "missing subcommand for `approval channel telegram`", TELEGRAM_HELP);
  }
  if (sub === "--help" || sub === "-h" || sub === "help") {
    streams.out(`${TELEGRAM_HELP}\n`);
    return EXIT_OK;
  }
  switch (sub) {
    case "listen":
      return commandTelegramListen(rest, streams, cwd);
    case "webhook":
      // APRV-424, and a DYNAMIC import on purpose. The webhook runner reaches
      // back into this module for `prepareListen`, `wireListener` and
      // `dispatchPending` — it is the same listener with another arrival — so
      // a static import here would close the dispatcher/dispatched circle.
      // An ESM cycle is not a compile error; it is a binding that is
      // `undefined` in one direction on the day initialisation order changes.
      // `cli/serve.ts` and `cli/mcp.ts` state the same rule.
      return import("./channel-telegram-webhook.js").then(({ commandTelegramWebhook }) =>
        commandTelegramWebhook(rest, streams, cwd),
      );
    case "health":
      return commandTelegramHealth(rest, streams, cwd);
    default:
      return usageError(
        streams,
        json,
        `unknown subcommand ${JSON.stringify(sub)} for \`approval channel telegram\``,
        TELEGRAM_HELP,
      );
  }
}

