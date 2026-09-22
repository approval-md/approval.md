/**
 * Content binding: the hash an approval is bound to (amended SPEC.md §6.2, §10,
 * APRV-20 pass two / amendment A1).
 *
 * ## What this buys
 *
 * Before content binding, a grant approved an *action key*. The bytes that key
 * would ultimately execute were whatever the executor happened to hold at
 * execution time, which is to say: whatever the agent decided after the human
 * said yes. The amended §10 closes that:
 *
 * > An execution token is bound to the request, its `idempotency_key`, AND its
 * > `payload_hash`. Adapters and `approval run` MUST recompute the hash of the
 * > payload they are about to execute and MUST refuse, with a distinct
 * > machine-readable reason (`payload-mismatch`), when it differs from the hash
 * > the grant recorded. A grant therefore approves specific bytes.
 *
 * So the hash is the *whole* mechanism: `core/gate.ts` refuses to admit a manual
 * action whose declaration carries none (`payload-hash-required`), copies it
 * onto `approval.requested` and then onto `approval.granted`, and
 * `core/token.ts` refuses to spend a token against different bytes
 * (`payload-mismatch`).
 *
 * ## Why JCS, and why not "just hash the string"
 *
 * §6.2 says "SHA-256 over the RFC 8785 canonical serialization of the action's
 * concrete payload". Canonicalization is what makes the hash reproducible across
 * two implementations that agree about the *payload* but not about key order,
 * whitespace, or number formatting — which is exactly the situation an adapter
 * written in another language is in. The same canonicalizer the log's hash chain
 * uses (`core/jcs.ts`) is used here, so there is one serialization rule in this
 * codebase and not two.
 *
 * ## The `approval run` payload
 *
 * §6.2 names it: "for `approval run`, the argv array and cwd". {@link
 * runPayloadHash} is that definition made executable — the hash of
 * `{"argv": [...], "cwd": "..."}` — and `approval run` computes it
 * automatically from the command it is about to spawn. An adapter whose payload
 * is something else (a message body and its recipients, a proposed record)
 * hashes that with {@link payloadHash} and presents the result explicitly.
 *
 * The cwd is inside the hash on purpose: `rm -rf build` means two different
 * things in two different directories, and a binding that ignored the working
 * directory would approve one of them and execute the other.
 *
 * Since APRV-401 the SCRIPT is inside it too, where the argv names one: an
 * interpreter this runtime knows followed by a path operand, or a path at
 * `argv[0]` with a shebang behind it, carries that file's SHA-256 and size, so
 * a grant over `bash /tmp/install.sh` binds the script's bytes and not its
 * name. `core/run-payload.ts` owns that rule, states what it does not reach,
 * and is the one thing in this file's dependency graph that touches a disk.
 *
 * {@link payloadHash} is pure: no I/O, no clock, no randomness. {@link
 * runPayloadHash} reads the one file the argv names as its script, and nothing
 * else.
 */

import { createHash } from "node:crypto";

import { canonicalize } from "./jcs.js";
import { runPayloadValue } from "./run-payload.js";

/** The form a `payload_hash` takes everywhere: SHA-256, lowercase hex. */
export const PAYLOAD_HASH_PATTERN = /^[a-f0-9]{64}$/u;

/** Is this a well-formed `payload_hash`? The schema says the same thing. */
export function isPayloadHash(value: unknown): value is string {
  return typeof value === "string" && PAYLOAD_HASH_PATTERN.test(value);
}

/**
 * SHA-256 (lowercase hex) over the RFC 8785 canonical serialization of a
 * payload — the definition amended SPEC.md §6.2 gives for `payload_hash`.
 *
 * Throws `JcsError` for a value RFC 8785 cannot serialize (a cycle, a NaN, a
 * function). That is deliberate: a payload that cannot be canonicalized cannot
 * be bound to, and returning a plausible-looking digest for it would be worse
 * than failing.
 */
export function payloadHash(value: unknown): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

/**
 * The `payload_hash` of an `approval run` invocation: the argv array, the cwd,
 * and the digest of the script that argv names (APRV-401).
 *
 * `argv` is the child's argv as it will actually be spawned — the command name
 * first, then its arguments — not the `approval` wrapper's own flags, which
 * have no side effect to bind. `cwd` is the absolute directory the child will
 * run in, and the directory a relative script path is resolved against.
 *
 * Reads that one file, because a binding that did not would bind its name. An
 * argv naming no readable script hashes exactly as it did before the script was
 * bound at all, so every record and declaration written earlier still verifies;
 * see `core/run-payload.ts` for the rule and for what it does not reach.
 */
export function runPayloadHash(argv: readonly string[], cwd: string): string {
  return payloadHash(runPayloadValue(argv, cwd));
}
