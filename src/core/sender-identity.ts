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

import type { PolicyLoadResult } from "./policy-load.js";

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
  | { kind: "mapped"; approver: string; actor: string; source: SenderSource }
  | { kind: "unmapped"; sender: ChannelSender; message: string }
  | { kind: "ambiguous"; sender: ChannelSender; approvers: string[]; message: string };

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
 * Resolve one observed sender against the policy in force (design §3.2).
 *
 * Total, pure, and the whole of the decision-time logic. It never reads a file,
 * never reads the log and never decides anything: the caller
 * (`channels/contract.ts`) turns a `mapped` into the actor it hands the gate,
 * and a refusal into an `audit.decision_refused` and a message to the chat.
 *
 * `sender` absent is mode 1 and the reason the CLI channel and every web post
 * are untouched by this: neither supplies one, so neither can claim anybody.
 */
export function resolveSender(
  load: PolicyLoadResult,
  sender: ChannelSender | undefined,
): SenderResolution {
  if (sender === undefined) return { kind: "configured", reason: "no-sender" };

  if (!load.ok) {
    return {
      kind: "unmapped",
      sender,
      message: `the policy could not be loaded (${load.code}), so the ${sender.channel} sender this decision arrived from maps to nobody. A policy the runtime cannot read is not a policy with no mapping: an identity resolved from bytes that did not parse would be attribution the operator never attested. Nothing was decided. Repair the policy file and re-attest it; a decision made from a terminal carries no sender and is unaffected.`,
    };
  }

  const approvers = load.policy.approvers;
  if (!mapsSendersFor(approvers, sender.channel)) {
    return { kind: "configured", reason: "channel-unmapped" };
  }

  const claimed = senderIndex(approvers).get(indexKey(sender.channel, sender.id)) ?? [];
  if (claimed.length === 1) {
    const approver = claimed[0] ?? "";
    return { kind: "mapped", approver, actor: `${HUMAN_PREFIX}${approver}`, source: "policy" };
  }
  if (claimed.length > 1) {
    return {
      kind: "ambiguous",
      sender,
      approvers: [...claimed],
      message: `the ${sender.channel} sender this decision arrived from is declared by ${String(claimed.length)} approvers in the policy in force. The runtime does not choose between them, and a policy carrying this is refused at load; nothing was decided.`,
    };
  }
  return {
    kind: "unmapped",
    sender,
    message: `the ${sender.channel} sender this decision arrived from is not mapped to an approver in the attested policy. This policy maps ${sender.channel} senders, so an unmapped one is refused rather than recorded under the identity the listener process was launched with — that would attribute a stranger's tap to the operator. Nothing was decided. The observed id is on the \`audit.decision_refused\` record this refusal wrote; an operator who recognizes it adds it to that approver's \`senders\` block and re-attests.`,
  };
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
      /** Present only where the actor was RESOLVED from the sender. */
      sender?: ChannelSender;
      source?: SenderSource;
    }
  | {
      ok: false;
      code: ChannelDecisionRefusalCode;
      message: string;
      sender: ChannelSender;
    };

/**
 * Resolve `sender` against `load`, falling back to `configured`.
 *
 * The `configured` actor is what the surface was launched as, and it survives
 * exactly the two modes {@link resolveSender} calls `configured`: no sender
 * observed, and no mapping declared for the channel that observed one.
 */
export function actorForSender(
  load: PolicyLoadResult,
  configured: string,
  sender: ChannelSender | undefined,
): SenderActorResolution {
  const resolution = resolveSender(load, sender);
  if (resolution.kind === "configured") return { ok: true, actor: configured };
  if (resolution.kind === "mapped") {
    return {
      ok: true,
      actor: resolution.actor,
      ...(sender === undefined ? {} : { sender, source: resolution.source }),
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
 * these two codes).
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
  return "Not recorded — the policy maps this account to more than one approver, so the runtime cannot say who decided. Ask the operator to fix the policy.";
}
