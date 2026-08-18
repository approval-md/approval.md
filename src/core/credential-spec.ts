/**
 * The credential manifest type (SPEC.md §10.4; APRV-78).
 *
 * An adapter reads named values out of the vault, and until this file existed
 * the only place those names were written down was the adapter's own `act`,
 * where a human setting the vault up cannot read them. A manifest moves that
 * knowledge one level out: the adapter DECLARES what it needs, and a generic
 * interactive writer (`cli/setup-flow.ts`) asks for it, validates it, stores it
 * and reports on it without knowing anything about email or SMTP.
 *
 * **This module is a type and nothing else.** No I/O, no imports, no runtime
 * values, deliberately: it is imported by `src/adapters/*` (which must not
 * depend on the CLI) and by `src/cli/*` (which must not depend on a particular
 * adapter), so anything with behaviour in it would make one of those two edges
 * a dependency on the other. The behaviour lives at both ends; the vocabulary
 * lives here.
 *
 * A spec carries no default for a `secret`, and it never carries a VALUE of any
 * kind: the manifest is printed, in checklists and in non-interactive hints, and
 * a field that could hold a credential would be a credential in a terminal.
 */

/**
 * What kind of thing a credential is, from the operator's point of view.
 *
 * Three, not two, because the collection differs for each: a `config` value is
 * typed in the clear with its default shown, a `choice` is picked from a
 * numbered list so a typo cannot become a silently wrong transport, and a
 * `secret` is read with no echo. The vault stores all three identically — it
 * has no notion of a non-secret entry — so this distinction exists purely to
 * decide what the human is asked and what may be echoed back at them.
 */
export type CredentialKind = "secret" | "config" | "choice";

/** One value an adapter reads from the vault, described well enough to ask for. */
export interface CredentialSpec {
  /** The vault name, exactly as the adapter's `act` asks for it. */
  name: string;
  kind: CredentialKind;
  /** A short label for a prompt: `SMTP host`. */
  label: string;
  /** One sentence for the checklist: what this is and why the adapter wants it. */
  describe: string;
  /**
   * Must the vault hold this before the adapter can work?
   *
   * `false` does not mean "unimportant": the email adapter's user and password
   * are both optional and both-or-neither, which no per-field flag can express.
   * That is what {@link CredentialSpec.validate}'s cross-field companion (the
   * flow's `check` hook) is for.
   */
  required: boolean;
  /** Offered as `[default]` at the prompt. Never present on a `secret`. */
  default?: string;
  /** For `kind: "choice"`: the closed set, each with a one-line explanation. */
  choices?: readonly { value: string; describe: string }[];
  /**
   * Per-field validation, run on the value the operator typed.
   *
   * Returns the refusal SENTENCE rather than a code, because the sentence is
   * the whole point: it must be the same one the adapter's own `act` would
   * print later, so an operator does not learn at send time that the port they
   * typed at setup time was never a port.
   */
  validate?(value: string): { ok: true } | { ok: false; message: string };
}
