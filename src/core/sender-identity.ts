/**
 * From an authenticated channel sender to an attested human identity
 * (APRV-324, `design/channel-sender-identity.md`, amended SPEC.md §5.2/§10.3).
 *
 * ## The fact this module is about
 *
 * Before it, every Telegram tap was recorded against the actor the listener
 * process was launched with. `routeCallback` checked `message.chat.id` against
 * the configured chat and never read the update's `from` object at all, so two
 * people in one chat both approved as one name and the log could not tell them
 * apart. GitHub issue #137 asked for the person who tapped; this is the
 * mapping that produces one.
 *
 * ## What is evidence here, and what is not
 *
 * Exactly one field in the whole system is a sender fact worth mapping:
 * Telegram's `callback_query.from.id`, the stable numeric account id the Bot
 * API attributes the tap to. {@link SENDER_CHANNELS} is closed to that one
 * channel for that reason. A web form post authenticates nobody and a CLI
 * process authenticates local machine control, so neither may be given an
 * identity key it cannot support: a `senders` entry for either is a schema
 * violation rather than a mapping nothing backs.
 *
 * Three things are deliberately NOT inputs:
 *
 * - **`from.username`.** Mutable and reusable, so a mapping keyed on it would
 *   transfer an identity with a handle. It is never a key and never recorded.
 * - **Anything the message body says.** A callback whose payload or text names
 *   a user id is naming it about itself; SPEC.md §11.1 invariant 4 is the rule,
 *   and the whole difference between this design and a spoofable one is that
 *   the key is the transport's own attribution rather than a claim inside it.
 * - **A sender on a channel with no transport authentication.** See above.
 *
 * And the mapping itself is evidence about an ACCOUNT, not about a person. What
 * binds the account to a human is the operator's assertion, written in
 * `APPROVAL.md`, which is `policy.core` and human-only and inoperative until a
 * human re-attests it. That is why the mapping lives in the policy: it inherits
 * the ceremony that already protects the approver roster it sits inside, and an
 * agent can no more add itself as an approver's sender than as an approver.
 *
 * ## The four modes (design §3.2)
 *
 * {@link resolveSender} is total and pure, and returns one of:
 *
 * 1. `configured` — nothing to resolve against, so the surface keeps the actor
 *    it was launched with. This is today's behaviour, and it is what every
 *    deployment that never writes a `senders` key stays in forever.
 * 2. `mapped` — the policy maps this sender to exactly one approver, and the
 *    decision is recorded as that person whatever the process was launched as.
 * 3. `unmapped` — refuse. Never a fallback to the configured actor, which is
 *    today's behaviour dressed as a feature and would let a stranger in the
 *    chat approve as the operator.
 * 4. `ambiguous` — two people claiming one account is an operator error, and
 *    the runtime does not resolve it by picking. `core/policy-load.ts` refuses
 *    such a policy at LOAD time, so this mode is the belt on that brace.
 *
 * ## Why mode 1 is keyed on the policy and not on the transport
 *
 * The channel supplies a sender for every tap once it can see one. If a
 * supplied sender with nothing to map it against were a refusal, the first
 * upgrade of the listener would lock every existing installation out of its own
 * gate. So the question mode 1 asks is whether the POLICY configures a mapping
 * for that channel at all: no approver declaring `senders.<channel>` means the
 * operator has not adopted this, and the decision is attributed by
 * configuration exactly as before. Writing the first mapping for a channel is
 * what turns enforcement on for it, which is the migration `design §6`
 * describes and `tests/sender-identity.test.ts` pins.
 *
 * ## A policy that does not load
 *
 * Fails closed: a supplied sender is refused `sender-unmapped`. A load failure
 * is not "a policy with no mapping", it is a policy the runtime could not read,
 * and inventing an identity from bytes it could not parse is the one thing this
 * module exists to stop. Nothing is stranded by it — the CLI channel supplies
 * no sender, so a terminal can still decide and still repair the file, which is
 * where a `policy.core` edit has to happen anyway.
 */

import { createHmac } from "node:crypto";

import type { PolicyLoadResult } from "./policy-load.js";

/**
 * The prefix a KEYED sender mapping wears, in the policy and in the log
 * (APRV-370).
 *
 * ## Why keyed, and not a plain digest
 *
 * The operator raised this on 2026-09-18 while applying APRV-324: a Telegram
 * account id is a short decimal number, and this repository publishes both its
 * policy and its log. Writing the raw id discloses the account once in
 * `APPROVAL.md` and then on every phone decision. It is an identifier rather
 * than a credential and the gate does not depend on its secrecy, so this is a
 * disclosure question rather than a security hole, and the fix has to actually
 * fix it: a plain `sha256:<hex>` of a ten-digit number is not a fix, because
 * the whole space of ten-digit numbers is ten billion digests and a laptop
 * enumerates it in minutes. The operator ruled on 2026-09-19 for the keyed
 * form, which has no such space to enumerate without the key.
 *
 * ## What the key is, and what it is not
 *
 * An operator-held secret in the launch environment, beside the sampling
 * secret, minted by `approval setup sender-key` and named by
 * {@link SENDER_KEY_ENV}. It is NOT an authenticator: nothing about the gate's
 * safety rests on it, and an attacker who learns it learns only which account
 * ids the policy names, which is what the raw form told everybody anyway. It
 * exists so that a published policy and a published log carry a value nobody
 * can walk backwards.
 */
export const SENDER_HASH_PREFIX = "hmac-sha256:";

/** The shape a keyed mapping value and a keyed recorded id both take. */
const HASHED_SENDER_PATTERN = /^hmac-sha256:[0-9a-f]{64}$/u;

/**
 * The environment variable the sender key is read from.
 *
 * A CONVENTIONAL name rather than one the policy declares, which is the one
 * place this diverges from the sampling secret's shape, and the reason is that
 * the two questions differ. The policy names `audit.sampling_secret_env`
 * because the POLICY decides whether sampling happens at all: a policy naming
 * no variable turns the sampler off, and that is a deliberate control. Here the
 * mapping's own form decides — a value wearing {@link SENDER_HASH_PREFIX} is
 * keyed and a decimal one is not — so the policy already says everything it
 * needs to, and a second declaration would be a second place for one fact to be
 * wrong. Per-instance isolation comes from the env FILE beside the log, which
 * is where the sampling secret gets it too.
 */
export const SENDER_KEY_ENV = "APPROVAL_SENDER_KEY";

/** Is this mapping value (or recorded id) the keyed form? */
export function isHashedSenderId(value: string): boolean {
  return HASHED_SENDER_PATTERN.test(value);
}

/**
 * The keyed digest of one observed id: what a keyed policy carries and what a
 * keyed record records.
 *
 * HMAC-SHA-256 under the operator's key, over the id as the transport reported
 * it, hex, prefixed. Computed the way `core/sampler.ts` computes its selection
 * value — `createHmac("sha256", key).update(value, "utf8")` — so this runtime
 * has one keyed-digest idiom rather than two that could drift.
 *
 * The prefix is part of the value on purpose. It is what tells a reader of a
 * policy or a log which form they are looking at without a second field to
 * consult, and it is what makes a keyed entry and a raw entry unable to
 * collide: a raw Telegram id is decimal digits and can never be this string.
 */
export function hashedSenderId(key: string, id: string): string {
  return `${SENDER_HASH_PREFIX}${createHmac("sha256", key).update(id, "utf8").digest("hex")}`;
}

/** The sender key in this environment, or `null` when it is unset or empty. */
export function senderKeyFrom(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[SENDER_KEY_ENV];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The channels whose transport attributes a gesture to an account the operator
 * can map (design §2).
 *
 * Closed, and short on purpose. `telegram` is here because the Bot API reports
 * `callback_query.from.id`, a stable numeric account id the sender cannot
 * choose. `web` and `cli` are absent because neither authenticates a person:
 * the web page takes an unauthenticated form post and the CLI takes whoever
 * controls the process. A policy that named either would be asserting a binding
 * the runtime cannot check, so the schema refuses the key rather than carrying
 * a mapping that reads like identity.
 */
export const SENDER_CHANNELS = ["telegram"] as const;

export type SenderChannel = (typeof SENDER_CHANNELS)[number];

/** Is `name` a channel whose transport can attribute a gesture (§2)? */
export function isSenderChannel(name: string): name is SenderChannel {
  return (SENDER_CHANNELS as readonly string[]).includes(name);
}

/**
 * One observed sender: the channel that saw it, and the id that channel's
 * transport attributed the gesture to.
 *
 * `id` is always the transport's own attribution. For Telegram it is
 * `String(callback_query.from.id)` and nothing else — not a username, not a
 * chat id, and nothing read out of the message.
 */
export interface ChannelSender {
  /** The surface that observed it: `telegram`. */
  channel: string;
  /** The transport's stable account id, as a string. */
  id: string;
}

/** Where a decision's actor came from, recorded on the decision (design §4). */
export const SENDER_SOURCES = ["policy"] as const;

export type SenderSource = (typeof SENDER_SOURCES)[number];

/**
 * Refusals that belong to the decision SURFACE rather than to the gate
 * (§11.1 invariant 6, amended SPEC.md §11.2).
 *
 * Its own union, deliberately. `GATE_REFUSAL_CODES` is documented as every way
 * `approval register|request|decide|withdraw|expire` can refuse, and `decide`
 * cannot emit either of these: the resolution happens before it is called, and
 * a second implementation whose gate emitted one would be describing a
 * different boundary. Both codes are stable public API and both are pinned by
 * `conformance/vectors/refusal-unions.v1.json`.
 */
export const CHANNEL_DECISION_REFUSAL_CODES = [
  /**
   * A sender arrived on a channel the policy maps senders for, and it maps this
   * one to nobody — or the policy could not be loaded at all. Nothing is
   * decided; one `audit.decision_refused` records the observed id.
   */
  "sender-unmapped",
  /**
   * One sender id is claimed by two approvers. `core/policy-load.ts` refuses
   * such a policy outright, so reaching this at decision time means a caller
   * supplied a policy that never passed a load; either way the runtime does not
   * pick.
   */
  "sender-ambiguous",
  /**
   * The policy maps this channel's senders in the KEYED form and no sender key
   * resolves in this process (APRV-370).
   *
   * Its own code rather than a `sender-unmapped`, because the two say opposite
   * things and want opposite repairs. Unmapped says the policy does not name
   * this account: the operator looks at the account and decides whether to add
   * it. This says the runtime could not evaluate the mapping AT ALL, for every
   * account, and the repair is {@link SENDER_KEY_ENV} in the listener's
   * environment. A caller that could not tell them apart would send an operator
   * looking for an intruder when what happened is that a process started
   * without its key.
   *
   * It refuses the WHOLE channel, not only the keyed entries, and that is the
   * strict reading rather than an accident. Without the key the runtime cannot
   * compute any digest, so it cannot check whether the observed account is also
   * claimed by a keyed approver, which means it cannot run the ambiguity check
   * the mapping's safety rests on. Matching a raw entry while half the roster
   * is unreadable would be resolving an ambiguity by not looking at it
   * (SPEC.md §11.1: ambiguity resolves to the stricter path, always). There is
   * deliberately no fallback to the raw comparison.
   */
  "sender-key-unavailable",
  /**
   * An attestation tap that would decide WHO MAY DECIDE, from a phone, under a
   * policy that cannot answer who is tapping.
   *
   * The attestation ceremony is the one act whose subject can be the sender
   * mapping itself, so resolving it against the file being attested would let
   * whoever edited that file name themselves as the approver of their own
   * edit. It is resolved against the policy IN FORCE instead, and this code is
   * what fires when that policy cannot answer: its bytes are not recoverable,
   * or it maps no sender for this channel while the amendment changes the
   * mapping. The repair is a terminal, which supplies no sender and is where a
   * `policy.core` edit happens anyway.
   */
  "attest-requires-terminal",
] as const;

export type ChannelDecisionRefusalCode = (typeof CHANNEL_DECISION_REFUSAL_CODES)[number];

/** Is `code` one of this union's members? Used where a code arrives as a string. */
export function isChannelDecisionRefusalCode(code: string): code is ChannelDecisionRefusalCode {
  return (CHANNEL_DECISION_REFUSAL_CODES as readonly string[]).includes(code);
}

/** The outcome of resolving one observed sender against one policy. */
export type SenderResolution =
  | {
      /** Nothing to resolve against; the surface keeps its configured actor. */
      kind: "configured";
      /** Why: no sender was observed, or the policy maps none for this channel. */
      reason: "no-sender" | "channel-unmapped";
    }
  | {
      kind: "mapped";
      approver: string;
      actor: string;
      source: SenderSource;
      /** The sender AS THE RECORD CARRIES IT: raw, or the keyed digest. */
      recorded: RecordedSender;
    }
  | { kind: "unmapped"; sender: RecordedSender; message: string }
  | { kind: "ambiguous"; sender: RecordedSender; approvers: string[]; message: string }
  | { kind: "key-unavailable"; sender: ChannelSender; message: string };

/**
 * A sender as a RECORD carries it (APRV-370).
 *
 * Under a raw mapping this is `{channel, id}` and byte-identical to what every
 * build since APRV-324 wrote. Under a keyed mapping `id` is the
 * {@link hashedSenderId} form and `hashed` is `true`.
 *
 * `id` carries the WHOLE `hmac-sha256:<hex>` string rather than the bare hex,
 * deliberately: that is exactly the string the policy carries, so an operator
 * reading a refusal off the log has a line they can paste into `senders`
 * without transforming it, and a reader correlating a log to a policy can grep
 * one for the other. The `hashed` flag is not a second source of truth for the
 * same fact — the schema pins `id` to the digest shape whenever it is present,
 * so the two cannot disagree — it is the field anything machine-readable
 * branches on without parsing a string.
 *
 * `hashed` is `true` or absent, never `false`. A raw record is the record this
 * runtime already wrote, and adding a field to it that says "this is what it
 * always was" would make every pre-APRV-370 record read as though it were
 * missing something.
 */
export interface RecordedSender {
  channel: string;
  id: string;
  hashed?: true;
}

/** The `human:` prefix every approver id wears once it is an actor. */
const HUMAN_PREFIX = "human:";

/** One index key. ` ` cannot occur in either half, so it cannot collide. */
function indexKey(channel: string, id: string): string {
  return `${channel} ${id}`;
}

/**
 * Every `(channel, id)` a policy maps, to the approver ids claiming it.
 *
 * The policy is written person to sender, so a reader sees each human's
 * identity in one place; this is the inversion the decision path needs, and it
 * is computed rather than stored so the two cannot disagree. A value with more
 * than one member is the ambiguity {@link checkSenderMappings} refuses at load.
 *
 * Approver ids are sorted, so one policy always produces the same message.
 */
export function senderIndex(
  approvers: Record<string, { channels: string[]; senders?: Record<string, string> }> | undefined,
): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const id of Object.keys(approvers ?? {}).sort()) {
    const senders = approvers?.[id]?.senders;
    if (senders === undefined) continue;
    for (const channel of Object.keys(senders).sort()) {
      const sender = senders[channel];
      if (sender === undefined) continue;
      const key = indexKey(channel, sender);
      const claimed = index.get(key);
      if (claimed === undefined) index.set(key, [id]);
      else claimed.push(id);
    }
  }
  return index;
}

/**
 * Does this policy map any sender for `channel`?
 *
 * The migration switch of design §6: false is mode 1 for that channel, and the
 * behaviour is exactly the listener identity of every build before this one.
 */
export function mapsSendersFor(
  approvers: Record<string, { channels: string[]; senders?: Record<string, string> }> | undefined,
  channel: string,
): boolean {
  for (const id of Object.keys(approvers ?? {})) {
    if (approvers?.[id]?.senders?.[channel] !== undefined) return true;
  }
  return false;
}

/** Which forms this policy's mapping for `channel` uses (APRV-370). */
export interface SenderMappingForms {
  /** At least one value is a decimal account id. */
  raw: boolean;
  /** At least one value is a {@link hashedSenderId} digest. */
  keyed: boolean;
}

/**
 * Which form, or forms, a policy maps `channel`'s senders in.
 *
 * Both flags can be true: nothing forbids a policy that names one approver
 * raw and another keyed, and this runtime does not refuse one. What it does is
 * refuse every tap on such a channel when the key is missing, because the half
 * it cannot evaluate is still part of the roster it is checking for ambiguity.
 * `approval doctor` reports the mixed state so an operator can finish the
 * migration rather than discover it at a tap.
 */
export function senderMappingForms(
  approvers: Record<string, { channels: string[]; senders?: Record<string, string> }> | undefined,
  channel: string,
): SenderMappingForms {
  let raw = false;
  let keyed = false;
  for (const id of Object.keys(approvers ?? {})) {
    const value = approvers?.[id]?.senders?.[channel];
    if (value === undefined) continue;
    if (isHashedSenderId(value)) keyed = true;
    else raw = true;
  }
  return { raw, keyed };
}

/**
 * The load-time check of design §3.2 mode 4: one sender id, at most one person.
 *
 * Returns the message, or `null` when the policy is clear. `core/policy-load.ts`
 * turns a message into a `sender-ambiguous` load failure, which means the
 * policy does not load, which means every class resolves `manual` (SPEC.md
 * §5.2, fail closed). That is the strictest answer available and the only
 * honest one: the file says two people are one account, and there is no reading
 * of it under which a decision by that account names a person.
 */
export function checkSenderMappings(
  approvers: Record<string, { channels: string[]; senders?: Record<string, string> }> | undefined,
): string | null {
  const index = senderIndex(approvers);
  for (const [key, claimed] of [...index.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (claimed.length < 2) continue;
    const [channel = "", id = ""] = key.split(" ");
    return `approvers ${claimed.map((name) => `\`${name}\``).join(" and ")} both declare the ${channel} sender ${JSON.stringify(id)}. A sender id names at most one person: the runtime resolves a decision to the human the operator attested that account to, and two claims on one account is a question the policy asks and does not answer. The runtime does not resolve it by picking, so the policy is refused and every class resolves \`manual\` until an author says which person holds that account.`;
  }
  return null;
}

/**
 * Resolve one observed sender against the policy in force (design §3.2,
 * APRV-370).
 *
 * Total, pure, and the whole of the decision-time logic. It never reads a file,
 * never reads the log, never reads the environment and never decides anything:
 * the caller (`channels/contract.ts`) turns a `mapped` into the actor it hands
 * the gate, and a refusal into an `audit.decision_refused` and a message to the
 * chat.
 *
 * `sender` absent is mode 1 and the reason the CLI channel and every web post
 * are untouched by this: neither supplies one, so neither can claim anybody.
 *
 * `key` is the operator's sender key, or `null` for none, and it DEFAULTS TO
 * NULL. That default is the fail-closed direction and it is load-bearing: a
 * caller that has not been taught about the key refuses every keyed mapping
 * rather than silently comparing raw ids against digests and finding nothing,
 * which would read exactly like a stranger tapping.
 */
export function resolveSender(
  load: PolicyLoadResult,
  sender: ChannelSender | undefined,
  key: string | null = null,
): SenderResolution {
  if (sender === undefined) return { kind: "configured", reason: "no-sender" };

  if (!load.ok) {
    return {
      kind: "unmapped",
      sender: { channel: sender.channel, id: sender.id },
      message: `the policy could not be loaded (${load.code}), so the ${sender.channel} sender this decision arrived from maps to nobody. A policy the runtime cannot read is not a policy with no mapping: an identity resolved from bytes that did not parse would be attribution the operator never attested. Nothing was decided. Repair the policy file and re-attest it; a decision made from a terminal carries no sender and is unaffected.`,
    };
  }

  const approvers = load.policy.approvers;
  if (!mapsSendersFor(approvers, sender.channel)) {
    return { kind: "configured", reason: "channel-unmapped" };
  }

  // APRV-370, and BEFORE any comparison. A keyed roster this process cannot
  // compute digests for is a roster it cannot check for ambiguity, so it
  // refuses the whole channel rather than matching the half it can read. There
  // is no fallback to the raw comparison, by design.
  const forms = senderMappingForms(approvers, sender.channel);
  if (forms.keyed && key === null) {
    return {
      kind: "key-unavailable",
      sender,
      message: `the attested policy maps ${sender.channel} senders in the keyed form and ${SENDER_KEY_ENV} is unset or empty in this process, so no account on this channel can be resolved and nothing was decided. This is not a statement about the account that tapped: without the key the runtime can compute no digest at all, so it cannot tell a mapped account from an unmapped one and will not guess. Set ${SENDER_KEY_ENV} in the listener's environment (\`approval setup sender-key\` mints and stores it; \`eval "$(approval env)"\` establishes it) and restart the listener. A decision made from a terminal carries no sender and is unaffected.`,
    };
  }

  const index = senderIndex(approvers);
  // Both forms, asked separately. A raw entry and a keyed entry cannot collide
  // — a keyed value wears `hmac-sha256:` and a raw Telegram id is decimal
  // digits — so asking both questions widens nothing and lets one policy carry
  // a migration in progress. They are kept apart rather than concatenated
  // because WHICH one matched decides the form the record takes.
  const rawClaimed = index.get(indexKey(sender.channel, sender.id)) ?? [];
  const keyedClaimed =
    key === null ? [] : (index.get(indexKey(sender.channel, hashedSenderId(key, sender.id))) ?? []);
  const claimed = [...rawClaimed, ...keyedClaimed];
  // THE FORM FOLLOWS THE ENTRY THAT MATCHED, so the id in the record is the
  // string that approver's `senders` block carries and an operator can grep one
  // for the other. A mixed policy therefore records a keyed approver as a
  // digest and a raw one as an id, in the same policy and on the same channel.
  //
  // With nothing matched there is no entry to follow, so the CHANNEL decides
  // and a keyed channel hashes: an account the policy does not name is exactly
  // the one a keyed deployment least wants written down, and the digest is also
  // the line an operator would paste to map it.
  const recorded =
    claimed.length === 1
      ? recordedSender(sender, keyedClaimed.length === 1 ? key : null)
      : recordedSender(sender, forms.keyed ? key : null);
  if (claimed.length === 1) {
    const approver = claimed[0] ?? "";
    return {
      kind: "mapped",
      approver,
      actor: `${HUMAN_PREFIX}${approver}`,
      source: "policy",
      recorded,
    };
  }
  if (claimed.length > 1) {
    return {
      kind: "ambiguous",
      sender: recorded,
      approvers: [...claimed],
      message: `the ${sender.channel} sender this decision arrived from is declared by ${String(claimed.length)} approvers in the policy in force. The runtime does not choose between them, and a policy carrying this is refused at load; nothing was decided.`,
    };
  }
  return {
    kind: "unmapped",
    sender: recorded,
    message: `the ${sender.channel} sender this decision arrived from is not mapped to an approver in the attested policy. This policy maps ${sender.channel} senders, so an unmapped one is refused rather than recorded under the identity the listener process was launched with — that would attribute a stranger's tap to the operator. Nothing was decided. The observed ${recorded.hashed === true ? "account, as the keyed digest the policy would carry," : "id"} is on the \`audit.decision_refused\` record this refusal wrote; an operator who recognizes it adds it to that approver's \`senders\` block and re-attests.`,
  };
}

/**
 * The sender as a record should carry it (APRV-370).
 *
 * `key` is the key when this channel's mapping is KEYED, and `null` when it is
 * raw. A raw mapping records what it always recorded, which is why a keyed
 * channel is the only thing that changes any existing record's bytes.
 *
 * Note which id is hashed here: the OBSERVED one, from the transport. The
 * digest of an id the policy did not name is exactly the value a refusal wants
 * an operator to see, because it is the line they would paste to map that
 * account, and it discloses the account to nobody who does not already hold the
 * key.
 */
export function recordedSender(sender: ChannelSender, key: string | null): RecordedSender {
  if (key === null) return { channel: sender.channel, id: sender.id };
  return { channel: sender.channel, id: hashedSenderId(key, sender.id), hashed: true };
}

/**
 * The recorded form for a sender on a refusal that never reached
 * {@link resolveSender} (APRV-370).
 *
 * A gesture can be refused before the mapping is consulted at all: the log
 * could not be read, or the policy on disk is not the attested one, so its
 * mapping is not in force. Those records still say who tried, and the question
 * is which FORM that says it in.
 *
 * THE RULE: the form follows the FILE; the mapping follows the ATTESTATION. The
 * form is a disclosure preference the operator wrote down, and honouring it
 * from an unattested file grants nobody anything — the refusal is a refusal
 * either way, and the record names no approver. What must never follow an
 * unattested file is who may decide, and that is decided by
 * {@link resolveSender} against the policy in force, which these paths never
 * reach.
 *
 * A load that failed, or a channel this file maps raw, or no key: the raw id,
 * exactly as every build since APRV-324 recorded it.
 */
export function recordedSenderFor(
  load: PolicyLoadResult,
  sender: ChannelSender,
  key: string | null,
): RecordedSender {
  if (!load.ok || key === null) return { channel: sender.channel, id: sender.id };
  const forms = senderMappingForms(load.policy.approvers, sender.channel);
  return recordedSender(sender, forms.keyed ? key : null);
}

/**
 * Every `(channel, id)` pair a policy declares, as a sorted, comparable list.
 *
 * The shape {@link sendersDiffer} compares. Sorted and flattened so that two
 * policies differing only in key order are the same mapping, and a policy whose
 * load failed is `null` rather than an empty mapping — "no senders" and "I
 * could not read the senders" are different answers and only one of them is
 * safe to act on.
 */
export function senderPairs(load: PolicyLoadResult): string[] | null {
  if (!load.ok) return null;
  const pairs: string[] = [];
  for (const [key, claimed] of senderIndex(load.policy.approvers)) {
    for (const approver of claimed) pairs.push(`${approver} ${key}`);
  }
  return pairs.sort();
}

/**
 * Does the amendment change who may be recognized, anywhere, on any channel?
 *
 * The question the attestation rule turns on (§10.3). An amendment that adds,
 * removes or repoints ANY `senders` entry is an amendment about the identity
 * system itself, and the policy in force is the only honest place to ask who
 * may sign for it: asking the proposed file would let whoever wrote it name
 * themselves as the approver of their own edit.
 *
 * `true` when either side could not be read, which is the strict direction: an
 * unreadable mapping is one this runtime cannot prove is unchanged.
 */
export function sendersDiffer(before: PolicyLoadResult, after: PolicyLoadResult): boolean {
  const first = senderPairs(before);
  const second = senderPairs(after);
  if (first === null || second === null) return true;
  if (first.length !== second.length) return true;
  return first.some((pair, index) => pair !== second[index]);
}

/**
 * The actor a surface records, from the sender it observed and the policy it
 * resolved against — or the refusal that replaces it.
 *
 * One function, every surface (APRV-324 follow-up). Decisions, checkpoint
 * signatures and retrospective reviews all ask the same question of the same
 * two inputs, and three copies of the ladder would be three chances for one of
 * them to keep the pre-mapping behaviour on the gesture that matters most.
 * What differs between the surfaces is what they do with the answer, which is
 * theirs; what must not differ is who the answer names.
 */
export type SenderActorResolution =
  | {
      ok: true;
      actor: string;
      /**
       * Present only where the actor was RESOLVED from the sender, and in the
       * form the record carries: raw, or the keyed digest (APRV-370).
       */
      sender?: RecordedSender;
      source?: SenderSource;
    }
  | {
      ok: false;
      code: ChannelDecisionRefusalCode;
      message: string;
      sender: RecordedSender;
    };

/**
 * Resolve `sender` against `load`, falling back to `configured`.
 *
 * The `configured` actor is what the surface was launched as, and it survives
 * exactly the two modes {@link resolveSender} calls `configured`: no sender
 * observed, and no mapping declared for the channel that observed one.
 *
 * `key` defaults to `null` for the reason {@link resolveSender}'s does: a
 * caller that does not supply one refuses a keyed mapping rather than reading
 * past it.
 */
export function actorForSender(
  load: PolicyLoadResult,
  configured: string,
  sender: ChannelSender | undefined,
  key: string | null = null,
): SenderActorResolution {
  const resolution = resolveSender(load, sender, key);
  if (resolution.kind === "configured") return { ok: true, actor: configured };
  if (resolution.kind === "mapped") {
    return {
      ok: true,
      actor: resolution.actor,
      ...(sender === undefined ? {} : { sender: resolution.recorded, source: resolution.source }),
    };
  }
  if (resolution.kind === "key-unavailable") {
    // The one refusal whose recorded sender is RAW while the mapping is keyed,
    // and the reason is that there is no key to hash it with. Recording nothing
    // would leave an operator with no way to tell which account was in front of
    // a gate that had lost its key, and the disclosure this costs is the
    // disclosure the raw form already made. It is also the one refusal that
    // says nothing about the account: it is about this process.
    return {
      ok: false,
      code: "sender-key-unavailable",
      message: resolution.message,
      sender: { channel: resolution.sender.channel, id: resolution.sender.id },
    };
  }
  return {
    ok: false,
    code: resolution.kind === "unmapped" ? "sender-unmapped" : "sender-ambiguous",
    message: resolution.message,
    sender: resolution.sender,
  };
}

/**
 * What the person who tapped is told, in one line (APRV-235's rule, applied to
 * these codes).
 *
 * It names the code and says nothing about the mapping: not who is mapped, not
 * how many are, and not the id it saw. The chat is shared, the id belongs in
 * the log where an operator reads it deliberately, and a refusal that recited
 * the roster would turn a mis-tap into a disclosure.
 */
export function senderRefusalLine(code: ChannelDecisionRefusalCode): string {
  if (code === "sender-unmapped") {
    return "Not recorded — this account is not one the attested policy names as an approver for this gate. The attempt is on the record; ask the operator to map it.";
  }
  if (code === "attest-requires-terminal") {
    return "Not attested — this amendment decides who may decide, and the policy in force cannot say who is tapping. Attest it from a terminal.";
  }
  if (code === "sender-key-unavailable") {
    // It names the missing variable, which every other line here would refuse
    // to name, and the difference is who the line is about. The other refusals
    // are about the person tapping and a detail would disclose the roster to a
    // shared chat; this one is about the listener process, whose environment is
    // the operator's own and whose repair is one line they can act on at once.
    return `Not recorded — this gate's sender mapping is keyed and the listener has no ${SENDER_KEY_ENV}, so it can resolve no account at all. This says nothing about your account. The operator sets that variable and restarts the listener.`;
  }
  return "Not recorded — the policy maps this account to more than one approver, so the runtime cannot say who decided. Ask the operator to fix the policy.";
}
