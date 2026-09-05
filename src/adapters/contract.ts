/**
 * The adapter contract (SPEC.md §4, §6.2, §10.4, §11).
 *
 * An **adapter** is a side-effect executor: the thing that actually sends the
 * email, writes the calendar entry, moves the file. SPEC.md §10.4 makes it the
 * hard boundary of the whole system, and says why in one sentence: "an agent
 * that bypasses the CLI still cannot send, spend, or delete, because the
 * credentials only answer to tokens."
 *
 * That sentence describes a *sequence*, not a property of any one function:
 * recompute the payload hash, verify and consume the token, record that the
 * execution started, act, record how it ended. An adapter that owned that
 * sequence could skip a step — and the step it would skip is whichever one was
 * inconvenient the week the adapter was written. So the sequence lives here,
 * once, and an adapter implements exactly one method:
 *
 * ```ts
 * act(input: ActInput): Promise<ActOutcome> | ActOutcome
 * ```
 *
 * {@link executeThroughAdapter} owns everything around that call. It is not a
 * helper an adapter may choose; it is the only door, in the same sense that
 * `core/token.ts`'s `consumeToken` is the only sanctioned way to append a
 * manual `execution.started`.
 *
 * ## The five things the contract does that an adapter therefore cannot skip
 *
 * 1. **Recompute the hash.** Amended §10.4: "Adapters and `approval run` MUST
 *    recompute the hash of the payload they are about to execute and MUST
 *    refuse, with a distinct machine-readable reason (`payload-mismatch`), when
 *    it differs from the hash the grant recorded." The contract hashes
 *    `request.payload` with `core/payload.ts` — the same canonicalizer the log
 *    uses — and hands the digest to the token spend. An adapter is never asked
 *    what its payload hashes to, because an executor that could *state* its
 *    hash could state the approved one while holding different bytes.
 * 2. **Check the class before touching the log.** An adapter declares the
 *    classes it serves. An adapter asked to execute an action declared under
 *    some other class is refused `adapter-class-mismatch` with the log
 *    untouched: the declaration is read from `task.registered` (the log, not the
 *    caller's claim), and nothing is appended, because nothing happened.
 * 3. **Start before acting.** {@link startExecution} appends `execution.started`
 *    *before* `act` is called, and a refusal there means `act` is never called
 *    at all. A log that recorded an execution only once it succeeded could not
 *    tell you about the one that did not.
 * 3b. **Resolve declared credentials before spending the token** (APRV-169). An
 *    adapter names the credentials it cannot act without, and the contract
 *    resolves them before `startExecution`. A missing one refuses
 *    `credential-unavailable` with the log untouched and the grant intact,
 *    because a configuration fault must not consume a human's single-use
 *    authority. The side effect's own ordering is unchanged: the token is still
 *    consumed and `execution.started` still appended before `act` runs.
 * 4. **Scope the credentials.** The provider handed to `act` is a wrapper that
 *    closes when `act` returns. Inside the verified-token window it answers;
 *    outside it, every `get` refuses `credential-window-closed`. An adapter that
 *    stashes the provider and reads it later gets a refusal rather than a
 *    secret, so "credentials only answer to tokens" is a mechanism instead of an
 *    intention.
 * 5. **Redact.** Every string the contract is about to return is scanned for
 *    each credential value the provider handed out during the window, and hits
 *    are replaced with {@link REDACTION_PLACEHOLDER} and counted. SPEC.md §11.1
 *    invariant 3 ("raw secrets never appear in the log") is the reason adapters
 *    exist; here it is a mechanical check rather than a convention. Note what
 *    reaches the log from an adapter: nothing. The outcome events carry
 *    `exit_code` and nothing else, so the adapter's own vocabulary rides in the
 *    returned result, which is scanned before it is handed back.
 *
 * ## What is deliberately not here
 *
 * No vault. {@link CredentialProvider} is the seam a real vault implements
 * (APRV-68); this module ships {@link inMemoryCredentials} for tests and
 * {@link NO_CREDENTIALS}, which refuses everything, as the default. A runtime
 * that wires no provider therefore fails closed: an adapter that needs a secret
 * to act cannot act.
 *
 * No token verification, consumption, or append logic. Those are
 * `core/token.ts` and `core/execute.ts`, called here and reimplemented nowhere.
 *
 * ## Two callers, one core path
 *
 * `approval run` (`src/cli/execute.ts`) is the other caller of the same core
 * path: a command is an adapter whose `act` is `spawnSync`, whose payload is
 * §6.2's `{argv, cwd}`, and whose credentials are the ambient environment. It
 * calls `startExecution` and `finishExecution` directly rather than through this
 * module, because its stdio, exit-code transparency, and `--` argv split are CLI
 * concerns with nothing to do with adapters. The two callers share the core
 * verbs, not this wrapper; anything that must hold for both belongs in
 * `core/execute.ts`, and a rule added here alone protects adapters only.
 *
 * Deterministic and total: no clock of its own (it forwards
 * {@link ExecuteOptions.clock}), no randomness, and nothing here throws — an
 * adapter that throws is caught and recorded as a failed execution.
 */

import {
  EXECUTE_REFUSAL_CODES,
  declaringTasks,
  finishExecution,
  findDeclaration,
  indeterminateExecution,
  startExecution,
  type ExecuteOptions,
  type ExecuteRefusal,
} from "../core/execute.js";
import type { ObservationWindow, ObservedEffect } from "../core/coverage.js";
import { payloadHash } from "../core/payload.js";
import type { Autonomy } from "../core/policy-load.js";
import type { EventRecord } from "../core/log.js";
import { payloadOf, readVerifiedRecords } from "../core/state.js";
import { TOKEN_HASH_FIELD, digestsEqual, tokenHash } from "../core/token.js";

// ---------------------------------------------------------------------------
// Payload values
// ---------------------------------------------------------------------------

/**
 * A value RFC 8785 can canonicalize, which is exactly what a payload may be.
 *
 * The bound bytes are the ones a human saw in a channel and the ones
 * `core/payload.ts` hashed, so the payload type is the JSON type: a payload
 * carrying a function, a cycle, or a `NaN` has no canonical serialization and
 * therefore no binding. Such a value is refused {@link "payload-unhashable"}
 * rather than executed against a digest nobody can reproduce.
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * Why a credential was not handed over. Frozen union, per SPEC.md §11.1(6).
 *
 * The three are distinguished because they call for three different responses:
 * fix the configuration, ask a human, or fix the adapter.
 */
export const CREDENTIAL_REFUSAL_CODES = [
  /** No such credential is configured. The repair is configuration. */
  "credential-unavailable",
  /** The provider knows it and declined: policy, a locked vault, a human's no. */
  "credential-refused",
  /**
   * The verified-token window has closed: `act` has already returned, and the
   * provider it was handed is no longer live. Distinct from the two above
   * because nothing is wrong with the credential or the configuration — the
   * adapter asked at the wrong time, which is a defect in the adapter and is
   * reported as one.
   */
  "credential-window-closed",
] as const;

export type CredentialRefusalCode = (typeof CREDENTIAL_REFUSAL_CODES)[number];

export type CredentialResult =
  | { ok: true; value: string }
  | { ok: false; code: CredentialRefusalCode; message: string };

/**
 * The seam between an adapter and the secrets it needs (SPEC.md §10.4: adapters
 * "hold the actual credentials in an encrypted vault").
 *
 * Synchronous and total: `get` never throws and never blocks, because it is
 * called from inside a window the contract holds open and an adapter awaiting a
 * human inside that window would hold an execution open with no outcome. A
 * provider that must prompt should prompt before the execution starts and
 * answer from what it learned.
 */
export interface CredentialProvider {
  get(name: string): CredentialResult;
  /**
   * Told, by the contract and by nothing else, that a token has been consumed
   * for this action and that the credential window is open (APRV-168). Called
   * with `null` when the window closes.
   *
   * Optional, and a provider that ignores it behaves exactly as it always did.
   * It exists so a provider can offer a capability that is only defensible
   * inside a granted window, and it is safe to publish as a method because the
   * argument cannot be forged: see {@link ExecutionGrant}.
   */
  grant?(grant: ExecutionGrant | null): void;
}

/**
 * The brand that makes {@link ExecutionGrant} unforgeable outside this module.
 *
 * NOT exported. A `unique symbol` that no other module can name is a property
 * no other module can write, so an object satisfying {@link ExecutionGrant} can
 * be constructed here and nowhere else. This is the structural half of
 * APRV-168's boundary: a capability keyed to a value only the contract can mint
 * is reachable only from the contract's own execution path.
 */
declare const EXECUTION_GRANT_BRAND: unique symbol;

/**
 * Evidence, handed to a {@link CredentialProvider}, that this execution is
 * inside a verified window (APRV-168).
 *
 * The contract mints one after {@link startExecution} returns, and drops it the
 * moment `act` does. It carries no secret and grants no read by itself; what it
 * asserts is WHEN, and on the manual path also WHAT: `tokenSha256` is the digest
 * of the single-use token that was actually spent, present only when a token was
 * actually spent, so a provider can insist on a human's grant rather than merely
 * on being inside some execution.
 */
export interface ExecutionGrant {
  readonly [EXECUTION_GRANT_BRAND]: true;
  /**
   * Where in the sequence this window is.
   *
   * - **`presented`** — the caller holds a token whose digest matches the one
   *   the log's `approval.granted` recorded for this action, and the contract is
   *   about to resolve the adapter's declared credentials (APRV-169). Minted
   *   only on that digest match, so it is proof a human granted THIS action and
   *   the caller has the token that grant minted. It is not full verification:
   *   TTL, revocation and the single-use check are `core/token.ts`'s, and they
   *   run in `startExecution` before anything is spent.
   * - **`consumed`** — the token has been spent, `execution.started` is on the
   *   log, and `act` is running.
   *
   * A capability that must not exist before a human decided may look at this;
   * one that must not exist before the token is BURNED reads `tokenSha256`.
   */
  readonly phase: "presented" | "consumed";
  /** The action this window belongs to. */
  readonly actionKey: string;
  /** The seq of the `execution.started` that opened it. `null` before it. */
  readonly startedSeq: number | null;
  /** How the action was admitted. `null` until `startExecution` has answered. */
  readonly autonomy: Autonomy | null;
  /**
   * The digest of the token that was consumed, on the manual path only. Absent
   * before the spend, and absent after it for a `supervised` or `autonomous`
   * execution, which no human was asked about.
   */
  readonly tokenSha256?: string;
}

/** The default: no vault is wired, so nothing is handed out. Fails closed. */
export const NO_CREDENTIALS: CredentialProvider = {
  get(name: string): CredentialResult {
    return {
      ok: false,
      code: "credential-unavailable",
      message: `no credential provider is configured, so ${JSON.stringify(name)} cannot be supplied. SPEC.md §10.4 puts the credentials behind the adapter boundary; wire a provider explicitly rather than reading the environment from inside an adapter.`,
    };
  },
};

/**
 * A provider over a literal map. **Tests and fixtures only** — it holds secrets
 * in process memory in the clear, which is precisely what the vault (APRV-68)
 * exists to stop doing.
 */
export function inMemoryCredentials(entries: Readonly<Record<string, string>>): CredentialProvider {
  return {
    get(name: string): CredentialResult {
      const value = Object.prototype.hasOwnProperty.call(entries, name)
        ? entries[name]
        : undefined;
      if (typeof value !== "string") {
        return {
          ok: false,
          code: "credential-unavailable",
          message: `no credential named ${JSON.stringify(name)} is configured`,
        };
      }
      return { ok: true, value };
    },
  };
}

/** A provider scoped to one execution window, plus the handles to manage it. */
interface ScopedCredentials {
  provider: CredentialProvider;
  /** Every value handed out while the window was open. The redaction corpus. */
  issued: Set<string>;
  /** Close the window. Idempotent; every later `get` refuses. */
  close(): void;
}

/**
 * Wrap `inner` in a window that closes.
 *
 * The mechanism is a closure over a boolean, not a revoked reference: the
 * adapter may keep the object it was handed for as long as it likes, and the
 * object will refuse. Values handed out are remembered so the contract can scan
 * its own output for them; the *names* are not interesting and the values never
 * leave this set.
 */
function scopeCredentials(inner: CredentialProvider): ScopedCredentials {
  let open = true;
  const issued = new Set<string>();
  return {
    provider: {
      get(name: string): CredentialResult {
        if (!open) {
          return {
            ok: false,
            code: "credential-window-closed",
            message: `credential ${JSON.stringify(name)} was requested after act() returned. Credentials are reachable only inside the verified-token window: the execution has already been recorded, so a secret handed over now would be one no token authorized.`,
          };
        }
        const result = inner.get(name);
        if (result.ok && result.value.length > 0) issued.add(result.value);
        return result;
      },
    },
    issued,
    close(): void {
      open = false;
    },
  };
}

// ---------------------------------------------------------------------------
// Redaction (SPEC.md §11.1 invariant 3, mechanically)
// ---------------------------------------------------------------------------

/** What a redacted credential value is replaced with. */
export const REDACTION_PLACEHOLDER = "[redacted]";

/** A string with every known secret replaced, and how many replacements ran. */
export interface Redaction {
  text: string;
  hits: number;
}

/**
 * Replace every occurrence of every secret in `text`.
 *
 * Empty secrets are skipped, because "replace every occurrence of the empty
 * string" redacts a document into nothing and would hide the very message a
 * reader needs. Everything else is replaced literally (no regex, no escaping
 * question), including a secret that appears as a substring of a longer word:
 * over-redaction is the safe direction, and a credential that happens to be a
 * common word is a credential problem, not a scanner problem.
 */
export function redactSecrets(text: string, secrets: Iterable<string>): Redaction {
  let out = text;
  let hits = 0;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    let index = out.indexOf(secret);
    while (index !== -1) {
      hits += 1;
      out = out.slice(0, index) + REDACTION_PLACEHOLDER + out.slice(index + secret.length);
      index = out.indexOf(secret, index + REDACTION_PLACEHOLDER.length);
    }
  }
  return { text: out, hits };
}

/** Does `text` contain any of `secrets`? The assertion form of the guard. */
export function containsSecret(text: string, secrets: Iterable<string>): boolean {
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    if (text.includes(secret)) return true;
  }
  return false;
}

/** A JSON value with every string (key or value) redacted. */
export interface RedactedJson {
  value: JsonValue;
  hits: number;
}

/**
 * Walk `value` and redact every string in it, keys included.
 *
 * Keys are scanned as well as values because a leak does not care which side of
 * the colon it lands on: `{"sk-live-…": "used"}` publishes the secret exactly as
 * effectively as the other arrangement.
 */
export function redactJson(value: JsonValue, secrets: Iterable<string>): RedactedJson {
  const list = [...secrets].filter((secret) => secret.length > 0);
  if (list.length === 0) return { value, hits: 0 };
  let hits = 0;

  const walk = (node: JsonValue): JsonValue => {
    if (typeof node === "string") {
      const redacted = redactSecrets(node, list);
      hits += redacted.hits;
      return redacted.text;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node === "object" && node !== null) {
      const out: Record<string, JsonValue> = {};
      for (const [key, member] of Object.entries(node)) {
        const redactedKey = redactSecrets(key, list);
        hits += redactedKey.hits;
        out[redactedKey.text] = walk(member);
      }
      return out;
    }
    return node;
  };

  return { value: walk(value), hits };
}

// ---------------------------------------------------------------------------
// The plugin interface
// ---------------------------------------------------------------------------

/** Everything an adapter is given, and nothing else. */
export interface ActInput {
  /** The action's idempotency key (SPEC.md §7), for the adapter's own logging. */
  actionKey: string;
  /**
   * The bytes the grant approved. The contract has already hashed this value
   * and the token spend has already checked that digest against the grant, so
   * an adapter acting on exactly this value is acting on approved bytes. An
   * adapter that reaches past it for "the current version" of anything has left
   * the binding behind.
   */
  payload: JsonValue;
  /** Live only until `act` returns. See {@link scopeCredentials}. */
  credentials: CredentialProvider;
  /** Cancellation, when the caller supplied one. */
  signal?: AbortSignal;
}

/**
 * What the adapter reports.
 *
 * The failure vocabulary is the adapter's own: `code` is a free string, because
 * this repository cannot enumerate the ways an SMTP server, a calendar API, or
 * a payments processor says no, and forcing those into a fixed union would
 * either lie about them or freeze on the first adapter written. What is NOT
 * negotiable is that neither `code`, `message`, nor `detail` may carry a
 * credential; the contract scans all three before returning them.
 */
export type ActOutcome =
  | { ok: true; detail?: JsonValue }
  | { ok: false; code: string; message: string };

/**
 * A side-effect executor (SPEC.md §4: "an email sender, calendar writer … that
 * holds credentials and refuses to act without a valid token").
 *
 * The refusal in that sentence is structural here: an adapter has no way to act
 * *except* by being handed an {@link ActInput}, and only
 * {@link executeThroughAdapter} builds one, only after the token was verified
 * and consumed.
 *
 * `classes` lists the side-effect classes (SPEC.md §7) this adapter serves,
 * matched exactly against the class the `task.registered` record declared.
 * Exactly, not by glob: patterns are the policy's language for deciding
 * autonomy, and an adapter that claimed `communicate.*` would be asserting
 * competence over classes that do not exist yet.
 */
export interface Adapter {
  /** Stable identifier: `email`, `gcal`, `mock-email`. Recorded in results. */
  name: string;
  /** The declared classes this adapter serves, matched exactly. */
  classes: readonly string[];
  /**
   * The credential names without which `act` cannot even be attempted (APRV-169).
   *
   * Declared here rather than discovered inside `act`, because the contract
   * resolves them BEFORE it consumes the token: a credential this runtime cannot
   * reach is a configuration fault, and a configuration fault must not spend the
   * single-use authority a human granted. An adapter that names nothing keeps
   * exactly the behaviour it had, and one that names an OPTIONAL credential here
   * turns an optional value into a required one, so the list holds only the
   * values whose absence makes the action impossible.
   *
   * Names, never values: the contract asks the provider for each of them and
   * keeps none of what comes back.
   */
  requiredCredentials?: readonly string[];
  act(input: ActInput): Promise<ActOutcome> | ActOutcome;
  /**
   * What this adapter's PROVIDER recorded happening in `window` (APRV-245).
   *
   * Optional, and an adapter that omits it behaves exactly as it always did.
   * It exists because MCP use is voluntary: an agent can route an action through
   * the gate, or it can act. What keeps the arrangement honest is that a side
   * effect leaves a witness this project does not write, and for an adapter-
   * backed class the witness is the provider's own record of what it did.
   * `approval coverage` reads that record back and joins it against the verified
   * log, so an effect with no matching record is visible as a gap.
   *
   * Four rules bind an implementation, and they are the mirror of {@link grant}'s:
   *
   * - **Read-only.** It performs no write of any kind against the far side. A
   *   coverage report that could send is a report nobody dares to run.
   * - **No token.** It is called OUTSIDE any grant window, by a reporting verb,
   *   with a provider the caller built for the purpose. There is no
   *   {@link ExecutionGrant} in scope and none is needed: reading what already
   *   happened authorizes nothing.
   * - **The caller redacts.** Whatever the far side says may be quoted back, so
   *   the caller runs every returned `detail` through {@link redactSecrets} with
   *   the secrets the adapter's own configuration reader reported. An
   *   implementation scrubs its strings as well; two passes are cheap and a leak
   *   is not (SPEC.md §11.1 invariant 3).
   * - **No message content.** A detail line names an effect for a person to
   *   recognize (a subject, a recipient count, an id) and never a body: the
   *   report is read by somebody who did not approve the message.
   *
   * Every returned effect carries a class this adapter serves, so a class the
   * adapter never handles cannot arrive dressed as an effect it observed.
   */
  observe?(
    window: ObservationWindow,
    credentials: CredentialProvider,
  ): Promise<readonly ObservedEffect[]>;
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * Everything {@link executeThroughAdapter} can refuse. Frozen public API, per
 * SPEC.md §11.1(6), and a strict superset of {@link EXECUTE_REFUSAL_CODES}:
 * every core refusal surfaces verbatim rather than being collapsed into an
 * adapter-flavoured one, because `token-consumed`, `payload-mismatch` and
 * `budget-exceeded` call for three different responses whether the caller is an
 * adapter or `approval run`.
 */
export const ADAPTER_REFUSAL_CODES = [
  ...EXECUTE_REFUSAL_CODES,
  /**
   * The adapter does not serve the class this action was declared under.
   * Refused before anything is appended: routing an action to the wrong
   * executor is a wiring mistake, and a wiring mistake must not consume a
   * single-use token or leave a dangling execution behind.
   */
  "adapter-class-mismatch",
  /**
   * The payload has no RFC 8785 canonical form, so there is no hash to check
   * against the grant. Nothing is appended and no token is spent.
   */
  "payload-unhashable",
  /**
   * `act` ran and reported failure. `execution.failed` WAS appended: the side
   * effect was attempted, and the log says so. `adapter_code` carries the
   * adapter's own reason.
   */
  "adapter-failed",
  /**
   * A throw on the way to `act`, before it was entered: assembling the
   * credential window, or reading the adapter's own method. Nothing was
   * attempted, so `execution.failed` is the honest record and the caller may
   * fix its wiring and try again.
   *
   * A throw from INSIDE `act` is a different code (`execution-indeterminate`)
   * and a different event, because the outcome is then unknown (APRV-120).
   *
   * Only the error's `message` is kept — never the stack, which routinely
   * quotes arguments and would be a credential-shaped leak with a plausible
   * excuse — and even that message passes the redaction guard.
   */
  "adapter-act-threw",
  /**
   * A credential the adapter declared in {@link Adapter.requiredCredentials}
   * could not be resolved (APRV-169). Refused BEFORE the token is consumed and
   * before `execution.started` is appended, so the grant survives: the log is
   * left exactly as it was found and the same token is spendable once the
   * credential appears.
   *
   * The provider's own reason (`credential-unavailable`, `credential-refused`)
   * rides in `adapter_code`, because "nobody stored an SMTP password" and "the
   * vault would not open" are two different repairs.
   */
  "credential-unavailable",
] as const;

export type AdapterRefusalCode = (typeof ADAPTER_REFUSAL_CODES)[number];

/** Every adapter-path failure is one of these. Nothing here throws. */
export interface AdapterRefusal {
  ok: false;
  code: AdapterRefusalCode;
  message: string;
  /** The adapter this was routed to. */
  adapter: string;
  action_key: string;
  /** Did `act` actually run? `false` means no side effect was attempted. */
  acted: boolean;
  /** The `execution.started` seq, when one was appended before the failure. */
  started_seq?: number;
  /**
   * The outcome event appended, when one was: `execution.failed` for an
   * attempt that provably did not commit, `execution.indeterminate` for one
   * whose outcome nobody knows (APRV-120).
   */
  outcome?: "execution.failed" | "execution.indeterminate";
  outcome_seq?: number;
  exit_code?: number;
  /** The adapter's own failure code, when `code` is `adapter-failed`. */
  adapter_code?: string;
  /** The underlying core refusal, verbatim, when the refusal came from core. */
  execute?: ExecuteRefusal;
  /** How many credential values the redaction guard replaced on this path. */
  redactions: number;
}

/** A completed execution: `act` reported success and the log says so. */
export interface AdapterExecuteSuccess {
  ok: true;
  adapter: string;
  action_key: string;
  task: string;
  class: string;
  autonomy: Autonomy;
  /** The digest the contract recomputed and the token spend checked. */
  payload_hash: string;
  started_seq: number;
  outcome: "execution.completed";
  outcome_seq: number;
  /** Always 0 here; present so success and failure read alike to a consumer. */
  exit_code: number;
  /** The adapter's own detail, after redaction. */
  detail?: JsonValue;
  redactions: number;
}

export type AdapterExecuteResult = AdapterExecuteSuccess | AdapterRefusal;

/** What the contract asks an adapter to execute. */
export interface AdapterExecuteRequest {
  logPath: string;
  actionKey: string;
  /** The concrete bytes. The contract hashes these; nobody states the hash. */
  payload: JsonValue;
  /** `human:<id>` or `agent:<id>`; the event schema is the authority on shape. */
  actor: string;
}

/**
 * {@link ExecuteOptions} plus the two things only the adapter path has.
 *
 * `presentedPayloadHash` is inherited and deliberately ignored: the contract
 * computes it from {@link AdapterExecuteRequest.payload}, and honoring a
 * caller-supplied digest would reintroduce exactly the "tell me what you are
 * running" hole that content binding closes.
 */
export interface AdapterExecuteOptions extends ExecuteOptions {
  /** The vault seam. Absent means {@link NO_CREDENTIALS}: nothing is handed out. */
  credentials?: CredentialProvider;
  /** Forwarded to `act` for cancellation. */
  signal?: AbortSignal;
}

/** The exit code recorded for an execution the adapter did not complete. */
const ADAPTER_FAILURE_EXIT_CODE = 1;

/**
 * Does `token` match the digest the log's grant for `actionKey` recorded?
 *
 * A pure comparison over records this path has already read and verified, and
 * deliberately NOT a second opinion about whether the token may be spent:
 * `core/token.ts` owns TTL, revocation and the single-use check, and
 * `startExecution` runs all three before anything is appended. What this answers
 * is the narrower question the pre-token phase needs: does the caller hold the
 * token a human's grant minted for this action?
 *
 * Constant-time, through `digestsEqual`. `false` for everything else: no grant,
 * no recorded digest, no token.
 */
function tokenMatchesGrant(
  records: readonly EventRecord[],
  actionKey: string,
  token: string | undefined,
): boolean {
  if (token === undefined || token.length === 0) return false;
  let recorded: unknown;
  for (const record of records) {
    if (record.event !== "approval.granted") continue;
    if (record.action_key !== actionKey) continue;
    recorded = payloadOf(record)[TOKEN_HASH_FIELD];
  }
  if (typeof recorded !== "string" || recorded.length === 0) return false;
  return digestsEqual(tokenHash(token), recorded);
}

/**
 * Hand `grant` to a provider that asked to be told, and swallow whatever it does
 * about it.
 *
 * A provider is not required to implement `grant`, and one that implements it
 * badly must not be able to fail an execution: this call carries no secret, no
 * decision, and nothing the contract needs back. Every path that leaves the
 * execution passes `null` through here, so a capability opened for a window is
 * closed on every exit, refusals included.
 */
function tell(provider: CredentialProvider, grant: ExecutionGrant | null): void {
  try {
    provider.grant?.(grant);
  } catch {
    // Nothing to report and nothing to repair: the contract asked, not asked for.
  }
}

/** What one pre-token credential resolution produced. */
type CredentialResolution =
  | { ok: true; issued: ReadonlySet<string> }
  | {
      ok: false;
      /** The provider's own reason, carried through to `adapter_code`. */
      credentialCode: string;
      message: string;
      redactions: number;
    };

/**
 * Resolve every credential the adapter declared it cannot act without, before
 * the token is consumed (APRV-169).
 *
 * The ordering this exists to establish, stated once: a credential the runtime
 * cannot reach is a configuration fault, and a configuration fault must not
 * spend a human's single-use grant. Resolving here means a
 * `credential-unavailable` refusal costs no authority: nothing is appended, the
 * token stays spendable, and the same token executes once the credential
 * appears.
 *
 * What this does NOT reorder is the consume-then-execute sequence for the side
 * effect itself. `startExecution` still consumes the token and appends
 * `execution.started` before `act` is called, because that ordering is what
 * makes a crash between the two an ambiguity the log can SEE rather than one it
 * is silent about (APRV-120). Credentials move ahead of the token; the side
 * effect does not.
 *
 * The reads happen in a window of their own that closes immediately, so a
 * provider handed here is never left live outside a scope, and every value it
 * hands over joins the redaction corpus of the refusal this may return. Nothing
 * read here is kept or returned: what comes back is whether the name resolved,
 * and `act` asks for the values itself inside the verified-token window.
 *
 * Note what an unauthorized caller learns by invoking this path: whether the
 * names THIS ADAPTER statically declared are present in a provider the caller
 * supplied in the first place. It is not a channel for asking about arbitrary
 * names, and a caller holding the provider could ask it directly anyway.
 */
function resolveRequiredCredentials(
  adapter: Adapter,
  actionKey: string,
  inner: CredentialProvider,
): CredentialResolution {
  const names = adapter.requiredCredentials ?? [];
  if (names.length === 0) return { ok: true, issued: new Set<string>() };

  const scope = scopeCredentials(inner);
  try {
    for (const name of names) {
      let got: CredentialResult;
      try {
        got = scope.provider.get(name);
      } catch (error) {
        // A provider is required to be total. One that throws anyway is a
        // configuration this runtime cannot use, and it is reported as one
        // rather than allowed to escape: nothing here throws.
        got = {
          ok: false,
          code: "credential-unavailable",
          message: `the credential provider raised instead of answering: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (got.ok) continue;
      const redacted = redactSecrets(
        `the ${adapter.name} adapter declares that it cannot act without the credential ${JSON.stringify(name)}, and it did not resolve (${got.code}): ${got.message}. Nothing was appended and no token was spent: credentials resolve before the token is consumed (SPEC.md §10.4, APRV-169), so this refusal costs no authority and the same token executes once the credential is reachable.`,
        scope.issued,
      );
      return {
        ok: false,
        credentialCode: got.code,
        message: redacted.text,
        redactions: redacted.hits,
      };
    }
    return { ok: true, issued: scope.issued };
  } finally {
    scope.close();
  }
}

/**
 * Copy the core-relevant options across, and bind the hash the contract
 * computed. Built explicitly rather than spread so that a future field added to
 * {@link AdapterExecuteOptions} (a credential provider, a transport handle) is
 * not silently forwarded into core.
 */
function executeOptionsFrom(
  options: AdapterExecuteOptions,
  presentedPayloadHash: string,
): ExecuteOptions {
  return {
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    ...(options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir }),
    ...(options.append === undefined ? {} : { append: options.append }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    presentedPayloadHash,
  };
}

function refuse(
  adapter: Adapter,
  actionKey: string,
  code: AdapterRefusalCode,
  message: string,
  extra: Partial<AdapterRefusal> = {},
): AdapterRefusal {
  return {
    ok: false,
    code,
    message,
    adapter: adapter.name,
    action_key: actionKey,
    acted: false,
    redactions: 0,
    ...extra,
  };
}

/**
 * Execute one approved action through `adapter`, and own every step around the
 * adapter's own.
 *
 * The order, and why it is this order:
 *
 * 1. **Hash the payload.** Before any log read, because a payload with no
 *    canonical form has nothing to check and nothing to execute.
 * 2. **Read the declaration** from the verified log and check the class. Both
 *    before `startExecution`, so a misrouted action leaves the log exactly as it
 *    found it. (The log is read twice on this path — once here, once inside
 *    `startExecution`, which reads for itself and compare-and-appends against
 *    the head it read. That is not redundancy to remove: a routing check that
 *    handed its records to core would be core trusting a caller's snapshot.)
 * 3. **Resolve the declared credentials** (APRV-169), in a window of their own
 *    that closes at once. A name the provider cannot answer refuses
 *    `credential-unavailable` here, with the log untouched and the token
 *    unspent, so a missing secret costs no authority and the same token works
 *    once the secret appears. An adapter declaring none skips this entirely.
 * 4. **`startExecution`**, which on the manual path verifies and consumes the
 *    token, refuses `payload-mismatch` against the digest from step 1, and
 *    appends `execution.started`. Any refusal here returns with `acted: false`;
 *    `act` is not called, so no side effect was attempted.
 * 5. **`act`**, inside a credential window that closes the moment it returns.
 * 6. **The outcome event**, and WHICH one depends on where things went wrong
 *    (APRV-120). `act` returning success is `execution.completed`; `act`
 *    returning a failure is `execution.failed`, because the provider answered
 *    and the answer was no; a throw on the way INTO `act` is `execution.failed`
 *    too, because nothing was attempted; and a throw from inside `act` is
 *    `execution.indeterminate`, because the provider may or may not have
 *    committed and this runtime cannot tell. The boundary is the invocation
 *    itself, not a judgment about the error.
 *
 * A refusal from step 6 is returned with `started_seq` set and the log left
 * holding a dangling execution — which is the honest state, since the side
 * effect did happen and its outcome could not be recorded. `approval status`
 * reports it and `approval execution resolve` is how a human closes it. An
 * indeterminate outcome is not that: it IS recorded, the consumption stays
 * burned, a retry is refused, and `approval execution reconcile` is how a
 * person resolves it from the relying party's own evidence.
 */
export async function executeThroughAdapter(
  adapter: Adapter,
  request: AdapterExecuteRequest,
  options: AdapterExecuteOptions = {},
): Promise<AdapterExecuteResult> {
  const { logPath, actionKey, payload, actor } = request;

  // (a) The hash, computed here from the bytes, never accepted from a caller.
  let hash: string;
  try {
    hash = payloadHash(payload);
  } catch (error) {
    return refuse(
      adapter,
      actionKey,
      "payload-unhashable",
      `the payload for ${actionKey} has no RFC 8785 canonical serialization (${error instanceof Error ? error.message : String(error)}), so it cannot be hashed and cannot be shown to be the bytes the grant approved. Nothing was appended.`,
    );
  }

  // (b) The declared class, from the verified log.
  const read = readVerifiedRecords(
    logPath,
    options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir },
  );
  if (!read.ok) return refuse(adapter, actionKey, read.code, read.message);

  const declaring = declaringTasks(read.records, actionKey);
  if (declaring.length > 1) {
    return refuse(
      adapter,
      actionKey,
      "action-not-registered",
      `action key ${JSON.stringify(actionKey)} is declared by more than one task (${declaring.join(", ")}); the runtime refuses an ambiguous declaration rather than route the later one. Registration refuses such collisions (APRV-138).`,
    );
  }
  const declared = findDeclaration(read.records, actionKey);
  if (declared === null) {
    return refuse(
      adapter,
      actionKey,
      "action-not-registered",
      `no task.registered record declares an action with idempotency_key ${JSON.stringify(actionKey)}; SPEC.md §7 requires a class to be declared before the action can execute, and an adapter cannot supply the declaration on the action's behalf.`,
    );
  }
  if (!adapter.classes.includes(declared.class)) {
    return refuse(
      adapter,
      actionKey,
      "adapter-class-mismatch",
      `adapter ${JSON.stringify(adapter.name)} serves ${adapter.classes.length === 0 ? "no classes" : adapter.classes.map((cls) => JSON.stringify(cls)).join(", ")}, and action ${actionKey} is declared under class ${JSON.stringify(declared.class)}. The action was routed to the wrong executor; nothing was appended and no token was spent.`,
    );
  }

  // (c) The credentials the adapter declared it cannot act without, resolved
  //     BEFORE the token is consumed (APRV-169). See
  //     {@link resolveRequiredCredentials} for why this sits here and why the
  //     consume-then-execute ordering below is untouched.
  const provider = options.credentials ?? NO_CREDENTIALS;

  // The presented-phase grant (APRV-168). Minted only when the caller's token
  // matches the digest a human's grant recorded for this action, so a provider
  // may offer a capability here on the strength of that decision. Everything
  // that decides whether the token may actually be SPENT still happens below,
  // in `startExecution`, and nothing here appends or consumes.
  const presented: ExecutionGrant | null = tokenMatchesGrant(
    read.records,
    actionKey,
    options.token,
  )
    ? ({ phase: "presented", actionKey, startedSeq: null, autonomy: null } as unknown as ExecutionGrant)
    : null;
  tell(provider, presented);

  const resolved = resolveRequiredCredentials(adapter, actionKey, provider);
  if (!resolved.ok) {
    tell(provider, null);
    return refuse(adapter, actionKey, "credential-unavailable", resolved.message, {
      adapter_code: resolved.credentialCode,
      redactions: resolved.redactions,
    });
  }

  // (d) Authorization and the start event. Refused here means act never runs.
  const executeOptions = executeOptionsFrom(options, hash);
  const started = startExecution(logPath, actionKey, executeOptions, actor);
  if (!started.ok) {
    tell(provider, null);
    return refuse(adapter, actionKey, started.code, started.message, { execute: started });
  }
  const startedSeq = started.record.seq;

  // (e) The adapter's own step, inside the credential window.
  //
  // `entered` is the custody boundary of APRV-120, and it is positional rather
  // than a judgment: everything up to and including the read of `adapter.act`
  // is preparation this runtime performed and can speak for, and the instant
  // after it the call is the far side's. A throw on the near side is
  // `execution.failed` — nothing was attempted. A throw on the far side is
  // `execution.indeterminate` — the provider may or may not have committed, and
  // saying "failed" about it is the assertion that produces double sends.
  const scope = scopeCredentials(provider);
  // Everything the pre-token resolution was handed is already a secret this
  // path may be about to print, so it joins the corpus before `act` runs rather
  // than only if `act` happens to ask for the same names again.
  for (const secret of resolved.issued) scope.issued.add(secret);

  // The window is now a GRANTED one, and the provider is told so (APRV-168).
  // Minted here because this is the only place that can: the brand on
  // `ExecutionGrant` is a symbol no other module can name. It is dropped in the
  // same `finally` that closes the window, so the capability it carries lives
  // exactly as long as `act` does.
  // The brand is a type-level marker with no runtime member (a `declare const
  // unique symbol` emits nothing), so the cast is what mints it. That is the
  // point: the cast compiles here and refuses to compile anywhere the brand
  // cannot be named, which is everywhere else.
  tell(provider, {
    phase: "consumed",
    actionKey,
    startedSeq,
    autonomy: started.autonomy,
    ...(started.tokenSha256 === undefined ? {} : { tokenSha256: started.tokenSha256 }),
  } as unknown as ExecutionGrant);

  let entered = false;

  let outcome: ActOutcome;
  let threw: string | null = null;
  try {
    const input: ActInput = {
      actionKey,
      payload,
      credentials: scope.provider,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    const act = adapter.act.bind(adapter);
    entered = true;
    outcome = await act(input);
  } catch (error) {
    // The message and nothing else: a stack trace quotes call arguments, and a
    // credential passed as one would ride out of here inside an error report.
    threw = error instanceof Error ? error.message : String(error);
    outcome = { ok: false, code: "adapter-act-threw", message: threw };
  } finally {
    scope.close();
    // The window and the grant end together. A provider that kept the grant is
    // holding a value the contract no longer honours, and it was told so.
    tell(provider, null);
  }

  // (f) The outcome event, then the redacted result.
  const secrets = scope.issued;
  const unknown = threw !== null && entered;
  const exitCode = outcome.ok ? 0 : ADAPTER_FAILURE_EXIT_CODE;
  const finished = unknown
    ? indeterminateExecution(logPath, actionKey, "act-threw", actor, executeOptions)
    : finishExecution(logPath, actionKey, exitCode, actor, executeOptions);

  const failureCode: AdapterRefusalCode = threw === null ? "adapter-failed" : "adapter-act-threw";
  const rawMessage = outcome.ok ? "" : outcome.message;
  const message = redactSecrets(rawMessage, secrets);
  const adapterCode = redactSecrets(outcome.ok ? "" : outcome.code, secrets);
  const detail: RedactedJson =
    outcome.ok && outcome.detail !== undefined
      ? redactJson(outcome.detail, secrets)
      : { value: null, hits: 0 };
  const redactions = message.hits + adapterCode.hits + detail.hits;

  if (!finished.ok) {
    return {
      ok: false,
      code: finished.code,
      message: `${adapter.name} ${outcome.ok ? "completed" : "did not complete"} action ${actionKey}, and the outcome could not be recorded: ${finished.message}. The side effect was attempted and the log now holds a dangling execution; close it with \`approval execution resolve\`.`,
      adapter: adapter.name,
      action_key: actionKey,
      acted: entered,
      started_seq: startedSeq,
      execute: finished,
      redactions,
    };
  }

  if (unknown) {
    // The message is the adapter's, redacted, and it reaches the CALLER only:
    // the record carries the closed reason and nothing else (APRV-120 #3).
    return {
      ok: false,
      code: "execution-indeterminate",
      message: `${adapter.name} entered act for ${actionKey} and raised, so the log records execution.indeterminate at seq ${finished.record.seq}: the side effect was attempted and nobody knows whether it committed. The token is spent and the idempotency key is burned; a retry is refused. Establish what happened and record it with \`approval execution reconcile\`. The adapter reported: ${message.text}`,
      adapter: adapter.name,
      action_key: actionKey,
      acted: true,
      started_seq: startedSeq,
      outcome: "execution.indeterminate",
      outcome_seq: finished.record.seq,
      adapter_code: adapterCode.text,
      redactions,
    };
  }

  if (!outcome.ok) {
    return {
      ok: false,
      code: failureCode,
      message: message.text,
      adapter: adapter.name,
      action_key: actionKey,
      // A throw BEFORE act was entered attempted nothing: the credential window
      // or the adapter's own method raised, and no side effect was reached.
      acted: entered,
      started_seq: startedSeq,
      outcome: "execution.failed",
      outcome_seq: finished.record.seq,
      exit_code: exitCode,
      adapter_code: adapterCode.text,
      redactions,
    };
  }

  return {
    ok: true,
    adapter: adapter.name,
    action_key: actionKey,
    task: started.task,
    class: started.class,
    autonomy: started.autonomy,
    payload_hash: hash,
    started_seq: startedSeq,
    outcome: "execution.completed",
    outcome_seq: finished.record.seq,
    exit_code: 0,
    ...(outcome.detail === undefined ? {} : { detail: detail.value }),
    redactions,
  };
}
