/**
 * Identity strings by role (APRV-500, amended SPEC.md §5.2 proposed).
 *
 * The runtime has always written three actor kinds, `human:`, `agent:` and
 * `system:`, and every human-only verb checks its own `^human:.+` (grant,
 * reject, revoke, attest, review, checkpoint, gate window, channel decisions).
 * APRV-500 RESERVES a fourth kind for the judge, `model:<name>@<version>`, and
 * this module is where that reservation is stated: the one parser that names
 * the kind, and the one place that says which role may carry it.
 *
 * In 0.4.2 that is the `reviewer` role of `delegation.reviewers` and nothing
 * else, and even there it only PARSES: a policy whose block lists any reviewer
 * fails to load with `delegation-not-supported` (`core/delegation.ts`). Every
 * enforcement path keeps its own `^human:.+` check unchanged, so a `model:`
 * actor is refused `actor-not-human` by every verb, and the event schema's
 * actor patterns are unchanged, so no record can carry one. A later core that
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
 * `human:<id>` is admitted for every role. `model:<name>@<version>` is admitted
 * for `reviewer` alone; for any other role it is `null`, exactly as an `agent:`
 * or `system:` actor is. Anything else, a bare id or a malformed model string
 * included, is `null`.
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
  if (human !== null) return { kind: "human", id: human[1] ?? "" };
  return null;
}
