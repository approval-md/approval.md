/**
 * Identity strings by role (APRV-500, amended SPEC.md §5.2 proposed).
 *
 * The runtime has always written three actor kinds, `human:`, `agent:` and
 * `system:`, and every human-only verb (grant, reject, revoke, attest, review,
 * checkpoint, gate window, channel decisions) checked its own `^human:.+`; they
 * now all read {@link isHumanActor} below.
 * APRV-500 RESERVES a fourth kind for the judge, `model:<name>@<version>`, and
 * this module is where that reservation is stated: the one parser that names
 * the kind, and the one place that says which role may carry it.
 *
 * In 0.4.2 that is the `reviewer` role of `delegation.reviewers` and nothing
 * else, and even there it only PARSES: a policy whose block lists any reviewer
 * fails to load with `delegation-not-supported` (`core/delegation.ts`). Every
 * human-only verb checks {@link isHumanActor} (`^human:.+`, and the id does not
 * begin with a reserved kind), so a `model:` actor, and a `human:model:…` one,
 * is refused `actor-not-human` by every verb; the event schema's actor patterns
 * are unchanged, so no record can carry a `model:` actor. A later core that
 * admits the judge widens a role here and a verb there, each as its own change.
 *
 * Pure: no I/O, no clock.
 */

/**
 * `model:<name>@<major>.<minor>.<patch>`, the judge's identity.
 *
 * `<name>` is the judge service, lowercase alphanumerics and `-`, at most 64
 * characters. The version pins one judge release (prompt, rubric and underlying
 * model snapshot), so a provider change is a new version. The same pattern is
 * `schema/policy.schema.json`'s `modelIdentity`; `tests/policy-delegation.test.ts`
 * holds the two equal.
 */
export const MODEL_IDENTITY_PATTERN = /^model:[a-z0-9][a-z0-9-]{0,63}@[0-9]+\.[0-9]+\.[0-9]+$/u;

/** `human:<id>`, the shape every human-only verb already requires. */
const HUMAN_IDENTITY = /^human:(.+)$/u;

/**
 * Identity kinds that are reserved and are not a person's name (APRV-500
 * refutation S3). THE one list: every human-only verb reads it through
 * {@link isHumanActor}, so reserving a further kind is one entry here.
 *
 * Why it exists. `^human:.+` admits any id, and a policy that names no approver
 * roster restricts nothing further, so `human:model:judge@0.3.0` used to pass
 * every human-only verb and a channel decision under it was recorded as
 * `approval.granted`: the judge written down as a person, which is the one
 * thing the `model:` reservation exists to prevent. A human id that begins with
 * a reserved kind prefix is therefore not a human identity anywhere. The
 * comparison ignores case and leading whitespace, so `human:Model:judge` and
 * `human: model:judge` are refused too.
 */
export const RESERVED_IDENTITY_KINDS = ["model"] as const;

/** Does this `human:` id begin with a reserved kind prefix (`model:`)? */
export function wearsReservedKind(id: string): boolean {
  const folded = id.trimStart().toLowerCase();
  return RESERVED_IDENTITY_KINDS.some((kind) => folded.startsWith(`${kind}:`));
}

/**
 * Is `actor` a human identity a human-only verb may record (grant, reject,
 * revoke, attest, review, checkpoint, gate window, channel decisions, and the
 * CLI's `--as` / `APPROVAL_HUMAN` resolution)?
 *
 * `^human:.+`, as every verb always required, and the id does not begin with a
 * reserved kind (see {@link RESERVED_IDENTITY_KINDS}). A refusal keeps each
 * verb's existing code, `actor-not-human`: the identity names a judge, not a
 * person, and no refusal code is added.
 */
export function isHumanActor(actor: unknown): boolean {
  if (typeof actor !== "string") return false;
  const human = HUMAN_IDENTITY.exec(actor);
  return human !== null && !wearsReservedKind(human[1] ?? "");
}

/**
 * The clause a refusal message appends when `actor` is a `human:` id wearing a
 * reserved kind, so the person reading it learns why a `human:` actor was
 * refused as not human. Empty for every other actor.
 */
export function reservedKindNote(actor: unknown): string {
  if (typeof actor !== "string") return "";
  const human = HUMAN_IDENTITY.exec(actor);
  if (human === null || !wearsReservedKind(human[1] ?? "")) return "";
  return ` (a human: id may not begin with a reserved identity kind, ${RESERVED_IDENTITY_KINDS.map((kind) => `${kind}:`).join(", ")}: that names a judge, not a person)`;
}

/**
 * Where an identity is being read.
 *
 * - `reviewer`: an entry of `delegation.reviewers`. The ONLY role that admits
 *   `model:` (reserved, inert in 0.4.2).
 * - `decider`: who grants, rejects or revokes a request.
 * - `attester`: who attests policy bytes.
 * - `sender`: the person a channel decision is recorded as.
 */
export type IdentityRole = "reviewer" | "decider" | "attester" | "sender";

/** A parsed identity. */
export type Identity =
  | { kind: "human"; id: string }
  | { kind: "model"; name: string; version: string };

/** The roles a `model:` identity may hold. One, and it is reserved. */
const MODEL_ROLES: ReadonlySet<IdentityRole> = new Set<IdentityRole>(["reviewer"]);

/**
 * Parse `text` as an identity for `role`, or `null` when it is not one that
 * role admits.
 *
 * `human:<id>` is admitted for every role, unless the id begins with a reserved
 * kind (`human:model:…`, see {@link RESERVED_IDENTITY_KINDS}), which is `null`
 * for every role. `model:<name>@<version>` is admitted for `reviewer` alone;
 * for any other role it is `null`, exactly as an `agent:` or `system:` actor
 * is. Anything else, a bare id or a malformed model string included, is
 * `null`.
 */
export function parseIdentity(text: string, role: IdentityRole): Identity | null {
  if (typeof text !== "string") return null;
  if (MODEL_IDENTITY_PATTERN.test(text)) {
    if (!MODEL_ROLES.has(role)) return null;
    // The pattern admits exactly one `@`, after the name.
    const at = text.indexOf("@");
    return { kind: "model", name: text.slice("model:".length, at), version: text.slice(at + 1) };
  }
  const human = HUMAN_IDENTITY.exec(text);
  // APRV-500 refutation S3: `human:model:judge@0.3.0` is the judge wearing a
  // person's prefix, and it is no identity for any role.
  if (human !== null && !wearsReservedKind(human[1] ?? "")) return { kind: "human", id: human[1] ?? "" };
  return null;
}

/**
 * {@link isHumanActor} in the shape of the `/^human:.+/u` constants it replaced
 * (APRV-500 refutation S3), so every human-only verb's existing
 * `HUMAN_ACTOR.test(actor)` reads this one rule rather than its own copy.
 */
export const HUMAN_ACTOR_RULE: { readonly test: (actor: unknown) => boolean } = {
  test: isHumanActor,
};
