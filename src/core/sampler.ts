/**
 * The audit sampler (SPEC.md §5.2 `supervised_sample_rate`, §11 invariant 4).
 *
 * > "Sample selection MUST be reproducible by the operator and unpredictable to
 * > agents. Implementations derive the selection value as HMAC-SHA-256 over the
 * > event hash using an operator-held secret stored outside the repository and
 * > outside any agent-readable path. Seeding from event content alone is
 * > forbidden: the authoring agent controls that content and could search it
 * > until its action falls outside the sample."
 *
 * This module is that derivation and nothing else. It reads no log, writes no
 * log, and appends nothing; `core/audit.ts` decides *what* is eligible and
 * `daemon/audit.ts` decides *when* to look.
 *
 * ## Why a keyed function rather than a hash of the record
 *
 * The event hash alone is a perfectly good uniform value, and using it would be
 * a complete failure of the control. The party whose action is being sampled
 * authors the content the hash covers: a summary, a cost estimate, an
 * idempotency key. An agent that knows the mapping can grind its own payload
 * until the resulting value lands outside the rate, and every action it cares
 * about escapes review while the log still shows a sampler running at 10%. The
 * secret is what makes the mapping unpredictable to the authoring party, and the
 * hash is what makes it reproducible for the operator who holds the secret. Both
 * properties are required; neither is optional.
 *
 * ## The secret never appears anywhere
 *
 * {@link resolveSampler} returns a closure over the secret, never the secret.
 * Nothing in this module puts it in a message, a return value, an error, or a
 * fixture, and {@link EnabledSampler.toJSON} pins that: a caller who serializes
 * a sampler gets the rate and the *name* of the environment variable, which is
 * exactly what the policy file already carries in the open.
 *
 * Determinism: given a secret, a rate, and a record hash the verdict is a pure
 * function. No clock, no network, no cross-call state.
 */

import { createHmac } from "node:crypto";

import type { DeclaredAutonomy, PolicyLoadResult } from "./policy-load.js";
import { resolve } from "./policy-match.js";

/**
 * Why sampling is not running. Machine-readable and distinct (SPEC.md §11.1
 * invariant 6), and a closed union because an operator's diagnostic branches on
 * it: "you never configured this" and "your secret is missing from this
 * process's environment" call for different actions.
 */
export const SAMPLER_DISABLED_REASONS = [
  /** The policy could not be loaded, so it declares no audit configuration. */
  "policy-unreadable",
  /** The policy carries no `audit.supervised_sample_rate`. */
  "rate-absent",
  /** The rate is exactly 0: the operator asked for no sampling. */
  "rate-zero",
  /** The rate is present but not a usable proportion (negative, NaN, ∞). */
  "rate-invalid",
  /** The policy carries no `audit.sampling_secret_env`, so no secret is named. */
  "secret-env-unnamed",
  /** The named environment variable is unset or empty in this process. */
  "secret-unset",
] as const;

export type SamplerDisabledReason = (typeof SAMPLER_DISABLED_REASONS)[number];

/**
 * The rate in force for one action class, and where it came from (APRV-183).
 *
 * `source` is the honest part. `"class"` means the winning rule declared a
 * `retro_rate`; `"global"` means it did not and `audit.supervised_sample_rate`
 * applies; `"none"` means neither exists, so nothing in this class is sampled
 * and `rate` is `null`. A reader that prints a rate without its source cannot
 * tell an operator whether editing the class rule or the global key is what
 * changes the number.
 */
export interface EffectiveRetroRate {
  rate: number | null;
  source: "class" | "global" | "none";
  /** The winning rule's pattern, when a rule matched. */
  pattern: string | null;
}

/** A sampler that will select. The secret is closed over and never exposed. */
export interface EnabledSampler {
  enabled: true;
  /**
   * `audit.supervised_sample_rate`, clamped to (0, 1] — the FALLBACK rate
   * (amended, APRV-183).
   *
   * `null` when the policy declares no usable global rate and at least one class
   * declares a `retro_rate` of its own: the sampler is running, and it is
   * running for those classes only. {@link EnabledSampler.fallbackReason} says
   * why there is no fallback.
   */
  rate: number | null;
  /**
   * Why there is no global fallback rate, or `null` when there is one. The same
   * machine-readable vocabulary a disabled sampler uses, because it is the same
   * fact about the same key.
   */
  fallbackReason: SamplerDisabledReason | null;
  /** The NAME of the environment variable the secret was read from. */
  secretEnv: string;
  /**
   * Does the event with this record hash fall in the sample at the GLOBAL rate?
   *
   * `eventHash` is the subject record's `hash` field: the 64-hex digest the
   * chain already carries, which is stable, unique per record, and the one
   * identifier a reproducing operator can name without re-deriving anything.
   *
   * Prefer {@link EnabledSampler.selectsFor} wherever the action's class is
   * known: a class declaring its own `retro_rate` is not sampled at this rate.
   */
  selects(eventHash: string): boolean;
  /** The rate governing this action class, and where it came from (APRV-183). */
  rateFor(actionClass: string): EffectiveRetroRate;
  /**
   * Does the event with this record hash fall in the sample for its class?
   *
   * The same HMAC over the same event hash under the same secret; only the rate
   * it is compared against differs. There is one mechanism here, and a class
   * rate moves the threshold rather than introducing a second draw.
   */
  selectsFor(actionClass: string, eventHash: string): boolean;
  /**
   * Serializes to the rates and the variable NAME. Never to the secret.
   *
   * `class_rates` maps a class pattern to the `retro_rate` it declared. Both
   * halves are bytes the policy file already carries in the open.
   */
  toJSON(): {
    enabled: true;
    rate: number | null;
    secret_env: string;
    class_rates: Record<string, number>;
  };
}

/** A sampler that will not select, and the reason it will not. */
export interface DisabledSampler {
  enabled: false;
  reason: SamplerDisabledReason;
  message: string;
  /** The variable name the policy declared, when it declared one. */
  secretEnv: string | null;
  /** The rate the policy declared, when it declared a usable one. */
  rate: number | null;
}

export type Sampler = EnabledSampler | DisabledSampler;

/**
 * The uniform selection value for one record hash under one secret, in [0, 1).
 *
 * HMAC-SHA-256(secret, eventHash) is taken as the PRF output; the top 53 bits of
 * its first eight bytes (big-endian) are divided by 2^53. Two properties are
 * being bought:
 *
 * - **Exactness.** A 53-bit integer is representable in an IEEE-754 double
 *   without rounding, and 2^53 is a power of two, so the division is exact.
 *   Every one of the 2^53 possible outputs is a distinct double, uniformly
 *   spaced, and no two distinct MAC prefixes collide through rounding into a
 *   value that a comparison against the rate would treat differently than the
 *   arithmetic says. Using all 64 bits would round, quietly biasing the extremes.
 * - **Uniformity.** HMAC-SHA-256 is a PRF, so its output bits are
 *   indistinguishable from uniform without the key; taking a fixed 53-bit slice
 *   preserves that. The result is < 1 always, which is what makes rate 1 select
 *   everything and rate 0 select nothing without either being a special case.
 *
 * Pure. The secret is a parameter and is never stored, logged, or returned.
 */
export function selectionValue(secret: string, eventHash: string): number {
  const mac = createHmac("sha256", secret).update(eventHash, "utf8").digest();
  const top53 = mac.readBigUInt64BE(0) >> 11n;
  return Number(top53) / 2 ** 53;
}

/**
 * Is this record in the sample at this rate?
 *
 * Selected iff `selectionValue < rate`. Rate 0 selects nothing (no value is
 * below 0) and rate 1 selects everything (every value is below 1); both fall out
 * of the arithmetic rather than being branches that could be got wrong.
 */
export function isSampled(secret: string, eventHash: string, rate: number): boolean {
  if (!Number.isFinite(rate) || rate <= 0) return false;
  if (rate >= 1) return true;
  return selectionValue(secret, eventHash) < rate;
}

function disabled(
  reason: SamplerDisabledReason,
  message: string,
  secretEnv: string | null,
  rate: number | null,
): DisabledSampler {
  return { enabled: false, reason, message, secretEnv, rate };
}

/**
 * Build the sampler in force for a policy and an environment.
 *
 * ## Why a missing secret disables sampling instead of failing closed
 *
 * Everything else in this runtime fails closed: an unparseable policy means
 * `manual`, an unknown class takes `defaults.autonomy`, ambiguity resolves to
 * the stricter path. Sampling is the one place where the strict-by-default
 * reading is unavailable, and the reason is structural rather than a matter of
 * taste.
 *
 * The strict reading of "no secret" would be "sample everything", and that
 * requires a selection function. There is exactly one thing available to seed it
 * with — the event content — and SPEC.md §5.2 forbids that seed by name, because
 * a content-seeded sample is one the authoring agent can steer. So the strict
 * option is not "sample everything with an invented seed"; it is a control that
 * *looks* like it is running while being steerable by the party under oversight,
 * which is worse than no control at all. Global invariant 4 (self-reported
 * fields never reduce scrutiny) is the property that would be broken, and it is
 * broken silently.
 *
 * What makes this acceptable, and what bounds it:
 *
 * - sampling is **retrospective**. It escalates an action that already executed
 *   for after-the-fact human review. Nothing is authorized by the sampler, no
 *   budget is spent by it, and no gate consults it. An unconfigured sampler
 *   costs review coverage, never authorization;
 * - the disablement is **stated, not silent**. The reason is machine-readable
 *   (`secret-unset`, `secret-env-unnamed`), the daemon reports it, and
 *   `approval status` can surface it. An operator is told the control is off;
 * - the alternative is **worse and undetectable**. A steerable sample reads
 *   identically to an honest one in the log.
 *
 * HUMAN REVIEW: this is the one deliberate fail-open in the runtime. It is
 * written down here rather than assumed, and if the human's judgment is that an
 * unconfigured sampler should instead stop the daemon (fail loud rather than
 * fail open), that is a one-line change here and a SPEC.md §5.2 amendment.
 */
export function resolveSampler(
  load: PolicyLoadResult,
  env: NodeJS.ProcessEnv = process.env,
): Sampler {
  if (!load.ok) {
    return disabled(
      "policy-unreadable",
      `the policy could not be loaded (${load.code}), so it declares no audit.supervised_sample_rate and no audit.sampling_secret_env; nothing is sampled. Sampling is retrospective review, so this costs coverage and authorizes nothing.`,
      null,
      null,
    );
  }

  const audit = load.policy.audit;
  const secretEnv =
    typeof audit?.sampling_secret_env === "string" && audit.sampling_secret_env.length > 0
      ? audit.sampling_secret_env
      : null;
  const rawRate = audit?.supervised_sample_rate;
  // APRV-183. A class rule may carry its own rate, so the global key is a
  // FALLBACK and its absence no longer settles the question on its own: a policy
  // whose only rate sits on one class is a policy that samples that one class.
  const classRates = classRetroRates(load);

  let rate: number | null = null;
  let fallbackReason: SamplerDisabledReason | null = null;
  let fallbackMessage = "";
  if (rawRate === undefined) {
    fallbackReason = "rate-absent";
    fallbackMessage = `${load.source.filename} declares no audit.supervised_sample_rate, so no supervised action is escalated for retrospective review`;
  } else if (typeof rawRate !== "number" || !Number.isFinite(rawRate) || rawRate < 0) {
    fallbackReason = "rate-invalid";
    fallbackMessage = `${load.source.filename} declares audit.supervised_sample_rate ${JSON.stringify(rawRate)}, which is not a proportion in [0, 1]; nothing is sampled`;
  } else if (rawRate === 0) {
    fallbackReason = "rate-zero";
    fallbackMessage = `${load.source.filename} sets audit.supervised_sample_rate to 0: the operator asked for no retrospective sampling`;
  } else {
    // A rate above 1 is a schema violation upstream. Read here as "everything",
    // which is the stricter of the two available readings.
    rate = Math.min(rawRate, 1);
  }

  if (rate === null && classRates.size === 0) {
    return disabled(
      fallbackReason ?? "rate-absent",
      fallbackMessage,
      secretEnv,
      fallbackReason === "rate-zero" ? 0 : null,
    );
  }

  // What the policy asked for, in the words of whichever key asked for it. The
  // global phrasing is unchanged for a policy that declares only the global key.
  const asked =
    rate !== null
      ? `sets audit.supervised_sample_rate to ${String(rate)}`
      : `declares a per-class retro_rate on ${String(classRates.size)} class rule(s)`;

  if (secretEnv === null) {
    return disabled(
      "secret-env-unnamed",
      `${load.source.filename} ${asked} but names no audit.sampling_secret_env. Selection needs an operator-held secret: seeding from event content alone is forbidden by SPEC.md §5.2, because the agent authoring the event controls that content and could search it until its action falls outside the sample. Nothing is sampled until the variable is named.`,
      null,
      rate,
    );
  }

  const secret = env[secretEnv];
  if (typeof secret !== "string" || secret.length === 0) {
    return disabled(
      "secret-unset",
      `${load.source.filename} names ${secretEnv} as the sampling secret's environment variable, and it is unset or empty in this process. Nothing is sampled. The value is never read from the policy file or the repository by design; export it in the operator's environment.`,
      secretEnv,
      rate,
    );
  }

  const globalRate = rate;
  const rateFor = (actionClass: string): EffectiveRetroRate => {
    const resolution = resolve(load, actionClass);
    const pattern = resolution.matched?.pattern ?? null;
    if (resolution.retroRate !== null) {
      return { rate: resolution.retroRate, source: "class", pattern };
    }
    return globalRate === null
      ? { rate: null, source: "none", pattern }
      : { rate: globalRate, source: "global", pattern };
  };

  return {
    enabled: true,
    rate: globalRate,
    fallbackReason,
    secretEnv,
    selects: (eventHash: string): boolean =>
      globalRate !== null && isSampled(secret, eventHash, globalRate),
    rateFor,
    selectsFor: (actionClass: string, eventHash: string): boolean => {
      const effective = rateFor(actionClass);
      return effective.rate !== null && isSampled(secret, eventHash, effective.rate);
    },
    toJSON: () => ({
      enabled: true,
      rate: globalRate,
      secret_env: secretEnv,
      class_rates: Object.fromEntries([...classRates.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
    }),
  };
}

/**
 * Every class rule that declares a usable `retro_rate`, keyed by pattern
 * (APRV-183).
 *
 * Pure, and deliberately ignorant of matching: this answers "what did the policy
 * write" for reporting and for the enabled/disabled decision above. Which rule
 * governs a given action is {@link resolve}'s question, and
 * {@link EnabledSampler.rateFor} asks it there so that specificity, strictness
 * and the irreversibility floor are honoured by one implementation rather than
 * two.
 */
export function classRetroRates(load: PolicyLoadResult): Map<string, number> {
  const rates = new Map<string, number>();
  if (!load.ok) return rates;
  const classes = load.policy.classes ?? {};
  for (const pattern of Object.keys(classes).sort()) {
    const declared = classes[pattern]?.retro_rate;
    if (typeof declared !== "number" || !Number.isFinite(declared)) continue;
    if (declared <= 0 || declared > 1) continue;
    rates.set(pattern, declared);
  }
  return rates;
}

/** One line of the per-class sampling report (APRV-183). */
export interface ClassSamplingEntry {
  /** The class rule's pattern, as the policy wrote it. */
  pattern: string;
  /** The level the rule declared, so a reader can see why it is in this list. */
  autonomy: DeclaredAutonomy;
  /** The rate in force for the class, or `null` when nothing samples it. */
  rate: number | null;
  source: "class" | "global" | "none";
  enabled: boolean;
  /** Why this class is not sampled, or `null` when it is. */
  reason: SamplerDisabledReason | null;
}

/**
 * What each supervised class rule is sampled at, and which are not sampled at
 * all (APRV-183).
 *
 * The disabled-sampler honesty rule of SPEC.md §5.2 is per class once the rate
 * is per class: an operator told "sampling: on, rate 0.1" while three of their
 * four supervised classes declare nothing and the global key is absent has been
 * told something true about the sampler and nothing true about their coverage.
 * Every entry carries the same machine-readable reason vocabulary the sampler
 * itself uses, so a diagnostic branches on one union.
 *
 * Pure. Reports on the rules a policy WROTE, in pattern order, so the output is
 * byte-stable across runs and independent of YAML key order.
 */
export function classSampling(load: PolicyLoadResult, sampler: Sampler): ClassSamplingEntry[] {
  if (!load.ok) return [];
  const classes = load.policy.classes ?? {};
  const entries: ClassSamplingEntry[] = [];
  for (const pattern of Object.keys(classes).sort()) {
    const rule = classes[pattern];
    if (rule === undefined) continue;
    const declaredAutonomy = rule.autonomy;
    if (
      declaredAutonomy !== "supervised" &&
      declaredAutonomy !== "supervised-retro" &&
      declaredAutonomy !== "supervised-live"
    ) {
      continue;
    }
    const declaredRate = classRetroRates(load).get(pattern) ?? null;
    if (!sampler.enabled) {
      entries.push({
        pattern,
        autonomy: declaredAutonomy,
        rate: declaredRate,
        source: declaredRate === null ? "none" : "class",
        enabled: false,
        reason: sampler.reason,
      });
      continue;
    }
    const rate = declaredRate ?? sampler.rate;
    const source = declaredRate !== null ? "class" : sampler.rate !== null ? "global" : "none";
    entries.push({
      pattern,
      autonomy: declaredAutonomy,
      rate,
      source,
      enabled: rate !== null,
      reason: rate !== null ? null : (sampler.fallbackReason ?? "rate-absent"),
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Live selection (amended SPEC.md §5.2, §6.3 — APRV-127)
// ---------------------------------------------------------------------------

/**
 * The selection algorithm recorded for a live decision, so a reproducing
 * operator knows what to recompute and over which input.
 *
 * Distinct from the retrospective sampler's `hmac-sha256/event-hash` because the
 * INPUT is different, and deliberately so. Retrospective sampling happens after
 * an execution exists, so it can key on that record's chain hash. A live
 * decision happens at intake, before any record exists, so it keys on the one
 * identifier that already binds the action to its bytes: the `payload_hash` the
 * registration declared.
 *
 * That choice is what buys the no-re-roll property. The payload hash is a pure
 * function of the payload, so an action retried with the same bytes gets the
 * same verdict every time, on every machine, forever. An agent that dislikes its
 * luck cannot retry until the verdict changes; it can only change the bytes,
 * which changes the action.
 */
export const LIVE_SELECTION = "hmac-sha256/payload-hash";

/** Why live selection could not be derived from a secret. */
export const LIVE_SELECTOR_UNAVAILABLE_REASONS = [
  /** The policy could not be loaded, so it names no sampling secret. */
  "policy-unreadable",
  /** The policy carries no `audit.sampling_secret_env`. */
  "secret-env-unnamed",
  /** The named environment variable is unset or empty in this process. */
  "secret-unset",
] as const;

export type LiveSelectorUnavailableReason = (typeof LIVE_SELECTOR_UNAVAILABLE_REASONS)[number];

/** A live selector that can answer, or one that cannot and says why. */
export type LiveSelector =
  | {
      available: true;
      /** The NAME of the environment variable the secret was read from. */
      secretEnv: string;
      /** Is this payload hash in the live fraction at this rate? */
      selects(payloadHash: string, rate: number): boolean;
    }
  | {
      available: false;
      reason: LiveSelectorUnavailableReason;
      message: string;
      secretEnv: string | null;
    };

/**
 * Build the live selector for a policy and an environment.
 *
 * ## Why this one FAILS CLOSED where the retrospective sampler fails open
 *
 * {@link resolveSampler} above documents the runtime's single deliberate
 * fail-open: with no secret, retrospective sampling stops rather than sampling
 * everything, because "sample everything" would need a selection function and
 * the only available seed — event content — is one the authoring agent controls.
 * A control that looks like it is running while the party under oversight steers
 * it is worse than no control.
 *
 * None of that reasoning transfers here, because the strict reading of a live
 * class needs no selection function at all. "Gate every action in this class" is
 * fully specified, needs no seed, and is exactly `manual`. So an unavailable
 * secret makes every live action gated: the caller ({@link
 * import("./gate.js").request}) reads `available: false` as "selected", and a
 * class an operator asked to sample at 1% is gated at 100% until the secret is
 * exported. That is loud, safe, self-repairing, and the same direction every
 * other refusal in this runtime takes.
 *
 * The secret is closed over and never returned, logged, or serialized, exactly
 * as in {@link resolveSampler}.
 */
export function resolveLiveSelector(
  load: PolicyLoadResult,
  env: NodeJS.ProcessEnv = process.env,
): LiveSelector {
  if (!load.ok) {
    return {
      available: false,
      reason: "policy-unreadable",
      message: `the policy could not be loaded (${load.code}), so it names no audit.sampling_secret_env and no live selection can be derived. Every supervised-live action is gated until it can be.`,
      secretEnv: null,
    };
  }

  const secretEnv =
    typeof load.policy.audit?.sampling_secret_env === "string" &&
    load.policy.audit.sampling_secret_env.length > 0
      ? load.policy.audit.sampling_secret_env
      : null;
  if (secretEnv === null) {
    return {
      available: false,
      reason: "secret-env-unnamed",
      message: `${load.source.filename} declares a supervised-live class but names no audit.sampling_secret_env. Live selection needs an operator-held secret: seeding it from the payload alone is forbidden by SPEC.md §5.2, because the agent authoring the payload controls those bytes and could search them until its action falls outside the fraction. Every supervised-live action is gated until the variable is named.`,
      secretEnv: null,
    };
  }

  const secret = env[secretEnv];
  if (typeof secret !== "string" || secret.length === 0) {
    return {
      available: false,
      reason: "secret-unset",
      message: `${load.source.filename} names ${secretEnv} as the sampling secret's environment variable, and it is unset or empty in this process. Every supervised-live action is gated until it is exported. The value is never read from the policy file or the repository by design.`,
      secretEnv,
    };
  }

  return {
    available: true,
    secretEnv,
    selects: (payloadHash: string, rate: number): boolean =>
      isSampled(secret, payloadHash, rate),
  };
}
