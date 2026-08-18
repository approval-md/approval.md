/**
 * The email adapter (SPEC.md §6.1, §6.2, §7, §10.4; APRV-69).
 *
 * SPEC.md §6.1 makes the point in its second sentence: "the canonical example is
 * an email, deliberately. This spec governs agent actions in the world." So this
 * is the first adapter, and the class it serves —
 * `communicate.email.external` — is the one the canonical task envelope
 * declares. It implements exactly one method, {@link Adapter.act}, and the
 * contract in `adapters/contract.ts` owns everything around it: the hash
 * recomputation, the token spend, `execution.started`, the credential window,
 * the outcome event, and the redaction sweep. **Nothing in this file touches a
 * token or the log**, and nothing in it can, because it is never handed either.
 *
 * ## The payload, and what the grant therefore approved
 *
 * ```ts
 * {
 *   from: string,          // one addr-spec
 *   to: string[],          // at least one
 *   cc?: string[],
 *   bcc?: string[],        // RCPT TO only; never a header
 *   subject: string,
 *   body: string,
 *   content_type?: "text/plain" | "text/html"   // default "text/plain"
 * }
 * ```
 *
 * §6.2 says a message send's `payload_hash` covers "the full body and
 * recipients", and this shape is that sentence made concrete. `bcc` is inside
 * the hash even though it appears in no header: a blind recipient is still a
 * recipient, and an approval that did not cover them would be an approval of a
 * different act than the one performed.
 *
 * {@link validateEmailPayload} re-checks the shape inside `act` and refuses
 * `email-payload-invalid`. This is defence in depth and is *not* the binding —
 * the hash already bound the bytes before `act` was called. What it catches is a
 * grant over bytes that are well-formed JSON and not a well-formed email, which
 * is a human approving a mistake rather than an attacker substituting one.
 * Unknown keys are refused too: a payload carrying `attachments` that this
 * adapter silently dropped would send something other than what a human read.
 *
 * ## The two fields the grant does NOT bind
 *
 * A wire message needs a `Date` and a `Message-ID`, and neither can live in the
 * payload without making the hash depend on when the send happened.
 *
 * - **`Date`** is stamped by the runtime from {@link EmailAdapterOptions.clock}
 *   (default: the wall clock) at the moment of the send. The grant binds the
 *   *message content*; the runtime records *when it went*. A human who approved
 *   a chaser on Tuesday and watched it execute on Wednesday approved the words,
 *   not the timestamp, and a `Date` inside the payload would additionally make
 *   every grant expire into a `payload-mismatch` the moment the clock moved.
 * - **`Message-ID`** is derived, not random: SHA-256 over the action key and the
 *   payload hash, at the From address's domain. It is therefore reproducible
 *   from the log alone — an operator holding `action_key` and the grant's
 *   `payload_hash` can recompute the exact Message-ID the far side saw, which is
 *   what makes a delivery receipt or a bounce traceable back to an approval. A
 *   random one would have to be logged to be useful, and the log is not where an
 *   adapter writes.
 *
 * Both are stated in the module header rather than only in code because they are
 * the two places this adapter puts bytes on the wire that no human approved.
 *
 * ## Encoding
 *
 * Quoted-printable, implemented here (RFC 2045 §6.7), rather than refusing
 * non-ASCII. Refusing would mean an adapter whose canonical example — a chaser
 * to a British letting agency about a £1,200 deposit — cannot be sent, and
 * "your approval was fine, the runtime cannot spell your currency" is not a
 * refusal any operator would accept. An all-ASCII body is sent `8bit`
 * unchanged, so the common case is byte-for-byte what the human read.
 *
 * A non-ASCII `subject` is RFC 2047 `B` encoded-words. Addresses must be ASCII:
 * an internationalized address needs SMTPUTF8 negotiation (RFC 6531), this
 * client does not implement it, and encoding one anyway would hand the server an
 * address it may or may not interpret as intended. That is
 * `email-payload-invalid` with the rule quoted.
 *
 * ## Configuration comes from the vault
 *
 * All five settings — host, port, security, user, password — are read through
 * {@link ActInput.credentials} inside `act`, under the names in
 * {@link DEFAULT_CREDENTIAL_NAMES}. Host and port are not secrets, and reading
 * them from the vault anyway buys one thing worth having: there is exactly one
 * place an adapter reads deployment configuration from, and it is not the
 * environment, not a config file an agent can write, and not the policy an agent
 * can read. A future task may let policy supply host/port (they are the sort of
 * thing an operator would like to see in `APPROVAL.md`), at which point the
 * vault stays the source for the two that are actually secret; that is a SPEC
 * §5.2 change and therefore its own task, not a flag here.
 *
 * The same five are also DECLARED, as {@link EMAIL_CREDENTIAL_SPECS}, so that
 * `approval setup adapter email` can ask for them without knowing what SMTP is
 * (APRV-78). The manifest is derived from {@link DEFAULT_CREDENTIAL_NAMES} and
 * its validation borrows `act`'s own refusal sentences, so a value setup accepts
 * is a value `act` accepts, and the words are the same on both paths.
 *
 * Deterministic given its clock: no randomness anywhere, no environment reads,
 * and `act` never throws (every path returns an {@link ActOutcome}).
 */

import { createHash } from "node:crypto";

import type { CredentialSpec } from "../core/credential-spec.js";
import { payloadHash } from "../core/payload.js";
import {
  CREDENTIAL_REFUSAL_CODES,
  redactSecrets,
  type ActInput,
  type ActOutcome,
  type Adapter,
  type CredentialProvider,
  type JsonValue,
} from "./contract.js";
import {
  DEFAULT_SMTP_TIMEOUT_MS,
  SMTP_TRANSPORT_FAILURE_CODES,
  isSmtpSecurity,
  sendMail,
  type SmtpSecurity,
} from "./smtp.js";

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

/** The value whose canonical hash the grant bound to. */
export interface EmailPayload {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  content_type?: "text/plain" | "text/html";
}

/** Every key the payload may carry. Anything else is refused. */
const PAYLOAD_KEYS = ["from", "to", "cc", "bcc", "subject", "body", "content_type"] as const;

/**
 * A deliberately conservative addr-spec: `local@domain`, ASCII, no display
 * name, no angle brackets, no comments, no quoted local part.
 *
 * RFC 5322's real grammar admits far more than this, and every extra form is
 * another way for a string to mean one thing to a reader and another to a
 * server. `"carter@example.com" <attacker@evil.example>` is a valid mailbox
 * whose display name is an address, and a human skimming a rendered approval
 * would read the wrong one. So the adapter accepts the boring form only, and an
 * operator who needs a display name gets a refusal explaining why rather than a
 * message whose recipient nobody can be sure of.
 */
const ADDR_SPEC = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u;

/** ASCII only, and specifically no CR or LF: header injection's whole trick. */
function isCleanAscii(value: string): boolean {
  return /^[ -~]*$/u.test(value);
}

export type EmailValidation =
  | { ok: true; payload: EmailPayload }
  | { ok: false; message: string };

function badAddresses(field: string, values: readonly unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string" || !ADDR_SPEC.test(value) || !isCleanAscii(value)) {
      return `${field} must hold plain ASCII addresses of the form local@domain (no display name, no angle brackets, no internationalized addresses — this client does not negotiate SMTPUTF8, RFC 6531); ${JSON.stringify(String(value))} is not one`;
    }
  }
  return null;
}

/**
 * Structural validation. Never throws; returns the reason instead.
 *
 * Exported so a caller can check a payload *before* requesting approval for it,
 * which is the only place a shape error can still be fixed cheaply.
 */
export function validateEmailPayload(value: JsonValue): EmailValidation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, message: "the payload must be a JSON object" };
  }
  const record = value;

  const unknown = Object.keys(record).filter(
    (key) => !(PAYLOAD_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    return {
      ok: false,
      message: `the payload carries ${unknown.map((key) => JSON.stringify(key)).join(", ")}, which this adapter does not implement. An unknown key is refused rather than ignored: a human approved every byte of this payload, and sending a message that silently dropped one of them would send something other than what they read. Supported keys: ${PAYLOAD_KEYS.join(", ")}`,
    };
  }

  const from = record["from"];
  if (typeof from !== "string" || from.length === 0) {
    return { ok: false, message: "from must be a non-empty string" };
  }
  const fromBad = badAddresses("from", [from]);
  if (fromBad !== null) return { ok: false, message: fromBad };

  const to = record["to"];
  if (!Array.isArray(to) || to.length === 0) {
    return { ok: false, message: "to must be a non-empty array of addresses" };
  }
  const toBad = badAddresses("to", to);
  if (toBad !== null) return { ok: false, message: toBad };

  const lists: { cc?: string[]; bcc?: string[] } = {};
  for (const field of ["cc", "bcc"] as const) {
    const list = record[field];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      return { ok: false, message: `${field}, when present, must be an array of addresses` };
    }
    const bad = badAddresses(field, list);
    if (bad !== null) return { ok: false, message: bad };
    lists[field] = list as string[];
  }

  const subject = record["subject"];
  if (typeof subject !== "string") return { ok: false, message: "subject must be a string" };
  if (/[\r\n]/u.test(subject)) {
    return {
      ok: false,
      message:
        "subject must not contain CR or LF: a newline in a header is how an extra header (a second Bcc, a different From) is smuggled into a message a human approved",
    };
  }

  const body = record["body"];
  if (typeof body !== "string") return { ok: false, message: "body must be a string" };

  const contentType = record["content_type"];
  if (
    contentType !== undefined &&
    contentType !== "text/plain" &&
    contentType !== "text/html"
  ) {
    return {
      ok: false,
      message: `content_type, when present, must be "text/plain" or "text/html", got ${JSON.stringify(contentType)}`,
    };
  }

  const recipients = [...to, ...(lists.cc ?? []), ...(lists.bcc ?? [])];
  if (recipients.length === 0) {
    return { ok: false, message: "the payload names no recipients" };
  }

  return {
    ok: true,
    payload: {
      from,
      to: to as string[],
      ...(lists.cc === undefined ? {} : { cc: lists.cc }),
      ...(lists.bcc === undefined ? {} : { bcc: lists.bcc }),
      subject,
      body,
      ...(contentType === undefined ? {} : { content_type: contentType }),
    },
  };
}

/** To, then Cc, then Bcc: every address the envelope will name, in order. */
export function envelopeRecipients(payload: EmailPayload): string[] {
  return [...payload.to, ...(payload.cc ?? []), ...(payload.bcc ?? [])];
}

// ---------------------------------------------------------------------------
// Rendering (RFC 5322, RFC 2045, RFC 2047)
// ---------------------------------------------------------------------------

const CRLF = "\r\n";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** RFC 5322 §3.3, in UTC. `Tue, 18 Aug 2026 09:14:02 +0000`. */
export function rfc5322Date(when: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return [
    `${DAYS[when.getUTCDay()] ?? "Mon"},`,
    pad(when.getUTCDate()),
    MONTHS[when.getUTCMonth()] ?? "Jan",
    String(when.getUTCFullYear()),
    `${pad(when.getUTCHours())}:${pad(when.getUTCMinutes())}:${pad(when.getUTCSeconds())}`,
    "+0000",
  ].join(" ");
}

/**
 * The deterministic Message-ID: SHA-256 over a domain-separated tuple of the
 * action key and the payload hash, at the sender's own domain.
 *
 * Domain separation (the literal prefix) so this digest can never collide with
 * a payload hash computed over the same strings by something else. Truncated to
 * 40 hex characters, which keeps the header inside a sensible width and leaves
 * 160 bits — the value needs to be unique, not unforgeable, since forging it
 * accomplishes nothing an attacker who can already send mail could not do.
 */
export function deterministicMessageId(actionKey: string, hash: string, from: string): string {
  const digest = createHash("sha256")
    .update(`approval.md/message-id\n${actionKey}\n${hash}`, "utf8")
    .digest("hex")
    .slice(0, 40);
  const domain = from.slice(from.lastIndexOf("@") + 1);
  return `<${digest}@${domain}>`;
}

/** Does `text` need an encoding that is not plain ASCII? */
function isAsciiOnly(text: string): boolean {
  for (const character of text) {
    if (character.codePointAt(0) !== undefined && (character.codePointAt(0) as number) > 0x7f) {
      return false;
    }
  }
  return true;
}

function hex(byte: number): string {
  return `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
}

/**
 * Quoted-printable (RFC 2045 §6.7).
 *
 * Line endings are normalized to CRLF hard breaks first, and each resulting
 * line is encoded and then soft-wrapped at 76 characters with a trailing `=`.
 * Trailing space and tab are always encoded, because a mail server that strips
 * trailing whitespace would otherwise silently alter bytes a human approved.
 */
export function quotedPrintable(text: string): string {
  const lines = text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n");
  const out: string[] = [];

  for (const line of lines) {
    const bytes = Buffer.from(line, "utf8");
    let encoded = "";
    for (let index = 0; index < bytes.length; index += 1) {
      const byte = bytes[index] as number;
      const last = index === bytes.length - 1;
      if (byte === 0x20 || byte === 0x09) encoded += last ? hex(byte) : String.fromCharCode(byte);
      else if (byte === 0x3d) encoded += "=3D";
      else if (byte >= 0x21 && byte <= 0x7e) encoded += String.fromCharCode(byte);
      else encoded += hex(byte);
    }
    out.push(...softWrap(encoded));
  }
  return out.join(CRLF);
}

/** Break an encoded line at 76 characters, never splitting an `=XX` triplet. */
function softWrap(encoded: string): string[] {
  if (encoded.length <= 76) return [encoded];
  const pieces: string[] = [];
  let rest = encoded;
  while (rest.length > 76) {
    let cut = 75;
    // An `=` within the last two characters would be the head of a triplet.
    while (cut > 1 && rest.slice(Math.max(0, cut - 2), cut).includes("=")) cut -= 1;
    pieces.push(`${rest.slice(0, cut)}=`);
    rest = rest.slice(cut);
  }
  pieces.push(rest);
  return pieces;
}

/**
 * RFC 2047 `B` encoded-words for a non-ASCII header value, chunked so no
 * encoded-word exceeds 75 characters and no chunk splits a code point.
 */
export function encodeHeaderValue(value: string): string {
  if (isAsciiOnly(value)) return value;
  const prefix = "=?UTF-8?B?";
  const suffix = "?=";
  // 75 total, minus the delimiters, rounded down to a whole base64 quantum
  // (4 characters, which is 3 source bytes).
  const budget = 75 - prefix.length - suffix.length;
  const perChunk = Math.floor(budget / 4) * 3;

  const words: string[] = [];
  let chunk = Buffer.alloc(0);
  for (const character of value) {
    const bytes = Buffer.from(character, "utf8");
    if (chunk.length + bytes.length > perChunk) {
      words.push(`${prefix}${chunk.toString("base64")}${suffix}`);
      chunk = Buffer.alloc(0);
    }
    chunk = Buffer.concat([chunk, bytes]);
  }
  if (chunk.length > 0) words.push(`${prefix}${chunk.toString("base64")}${suffix}`);
  // A folded continuation: CRLF plus one space, which RFC 5322 §2.2.3 requires
  // and RFC 2047 §2 relies on to keep adjacent encoded-words concatenated.
  return words.join(`${CRLF} `);
}

/** `Name: value`, folded at commas when the line would run past 78. */
function header(name: string, value: string): string {
  const line = `${name}: ${value}`;
  if (line.length <= 78 || !value.includes(", ")) return line;
  const parts = value.split(", ");
  const folded: string[] = [];
  let current = `${name}:`;
  for (const [index, part] of parts.entries()) {
    const piece = index === parts.length - 1 ? part : `${part},`;
    if (`${current} ${piece}`.length > 78) {
      folded.push(current);
      current = ` ${piece}`;
    } else current = `${current} ${piece}`;
  }
  folded.push(current);
  return folded.join(CRLF);
}

/** The non-payload facts the runtime stamps onto the message. */
export interface RenderStamp {
  /** The moment of the send. NOT part of the payload hash. See the header. */
  date: Date;
  /** Derived from the action key and the payload hash. NOT part of either. */
  messageId: string;
}

/**
 * The complete RFC 5322 message, CRLF throughout, **not** dot-stuffed: stuffing
 * is RFC 5321 transport framing and belongs to the SMTP layer, so what this
 * function returns is exactly the message the recipient's server stores.
 *
 * Bcc appears nowhere in it. That is the whole meaning of blind: the address is
 * in the envelope (`RCPT TO`) and in the payload a human approved, and in no
 * byte the other recipients receive.
 */
export function renderEmailMessage(payload: EmailPayload, stamp: RenderStamp): string {
  const contentType = payload.content_type ?? "text/plain";
  const asciiBody = isAsciiOnly(payload.body);
  const body = asciiBody
    ? payload.body.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n").join(CRLF)
    : quotedPrintable(payload.body);

  const headers = [
    header("Date", rfc5322Date(stamp.date)),
    header("From", payload.from),
    header("To", payload.to.join(", ")),
    ...(payload.cc === undefined || payload.cc.length === 0
      ? []
      : [header("Cc", payload.cc.join(", "))]),
    header("Subject", encodeHeaderValue(payload.subject)),
    header("Message-ID", stamp.messageId),
    header("MIME-Version", "1.0"),
    header("Content-Type", `${contentType}; charset=utf-8`),
    header("Content-Transfer-Encoding", asciiBody ? "8bit" : "quoted-printable"),
  ];

  return `${headers.join(CRLF)}${CRLF}${CRLF}${body}${CRLF}`;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/** The class SPEC.md §6.1's canonical envelope declares. */
export const EMAIL_CLASS = "communicate.email.external";

/** The vault names this adapter reads, all of them inside `act`. */
export const DEFAULT_CREDENTIAL_NAMES = {
  host: "smtp.host",
  port: "smtp.port",
  user: "smtp.user",
  password: "smtp.password",
  security: "smtp.security",
} as const;

export type EmailCredentialNames = typeof DEFAULT_CREDENTIAL_NAMES;

// ---------------------------------------------------------------------------
// The credential manifest (APRV-78)
// ---------------------------------------------------------------------------

/**
 * The refusal sentences, written once and used twice.
 *
 * `act` refuses a bad port or a bad security setting at send time; `approval
 * setup adapter email` refuses the same values at collection time. They must
 * say the same thing in the same words, or an operator learns at 2am that the
 * port they were allowed to type six weeks earlier was never a port. Each
 * sentence takes the NAME because `credentialNames` may rename any of them.
 */
function portSentence(name: string): string {
  return `the vault's ${name} is not a TCP port number (1-65535)`;
}

function securitySentence(name: string): string {
  return `the vault's ${name} must be "implicit", "starttls" or "none"; it is none of those, and this adapter will not guess a transport security setting`;
}

/** The both-or-neither sentence. `held` is the one present; `missing` is not. */
function pairSentence(held: string, missing: string): string {
  return `the vault holds ${held} but not ${missing}. An SMTP login needs both; sending unauthenticated because half the credential is missing would put the message on a path nobody configured`;
}

/**
 * What this adapter reads from the vault, declared rather than discovered.
 *
 * DERIVED from {@link DEFAULT_CREDENTIAL_NAMES} rather than restating the five
 * strings: a manifest that could drift from the names `act` asks for would be a
 * setup wizard that fills a vault the adapter then cannot read, and
 * `tests/adapter-email.test.ts` pins the two key for key.
 *
 * Order is the order an operator is asked, and it is not alphabetical: the
 * password is last, so that everything a mistyped host or port can waste is
 * answered before the one value that is unpleasant to re-enter.
 */
export const EMAIL_CREDENTIAL_SPECS: readonly CredentialSpec[] = [
  {
    name: DEFAULT_CREDENTIAL_NAMES.host,
    kind: "config",
    label: "SMTP host",
    describe: "the submission server this runtime connects to",
    required: true,
    validate(value: string) {
      const trimmed = value.trim();
      if (trimmed.length === 0) return { ok: false, message: "the host is empty" };
      if (/\s/u.test(trimmed)) {
        return { ok: false, message: "a host name contains no whitespace" };
      }
      return { ok: true };
    },
  },
  {
    name: DEFAULT_CREDENTIAL_NAMES.port,
    kind: "config",
    label: "SMTP port",
    describe: "the TCP port: 587 for STARTTLS submission, 465 for implicit TLS",
    required: true,
    default: "587",
    validate(value: string) {
      const port = Number(value.trim());
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        return { ok: false, message: portSentence(DEFAULT_CREDENTIAL_NAMES.port) };
      }
      return { ok: true };
    },
  },
  {
    name: DEFAULT_CREDENTIAL_NAMES.security,
    kind: "choice",
    label: "transport security",
    describe: "how the connection is protected; this adapter never guesses it",
    required: true,
    default: "starttls",
    choices: [
      { value: "implicit", describe: "TLS from the first byte (the submissions port, 465)" },
      { value: "starttls", describe: "plaintext, then a mandatory STARTTLS upgrade (port 587)" },
      { value: "none", describe: "plaintext throughout; the adapter refuses to AUTH over it" },
    ],
    validate(value: string) {
      if (!isSmtpSecurity(value.trim())) {
        return { ok: false, message: securitySentence(DEFAULT_CREDENTIAL_NAMES.security) };
      }
      return { ok: true };
    },
  },
  {
    name: DEFAULT_CREDENTIAL_NAMES.user,
    kind: "config",
    label: "SMTP username",
    describe: "the login name, when the relay wants one; leave empty for a relay that does not",
    required: false,
  },
  {
    name: DEFAULT_CREDENTIAL_NAMES.password,
    kind: "secret",
    label: "SMTP password",
    describe: "the login secret, required exactly when a username is given",
    required: false,
  },
];

/**
 * The cross-field rule: a username and a password are both-or-neither.
 *
 * Returns the refusal sentence, or `null` when the set is coherent. Exported so
 * that `approval setup adapter email` refuses the half-configured pair at the
 * moment the operator could still fix it, saying exactly what `act` would have
 * said at send time — and `act` itself calls this, so there is one sentence and
 * not two that drift.
 *
 * An absent value and an empty one are the same thing here: `setCredential`
 * refuses an empty credential outright, so "" can only ever mean "not given".
 */
export function checkEmailCredentialSet(
  values: Record<string, string | undefined>,
  names: EmailCredentialNames = DEFAULT_CREDENTIAL_NAMES,
): string | null {
  const has = (name: string): boolean => {
    const value = values[name];
    return typeof value === "string" && value.length > 0;
  };
  const user = has(names.user);
  const password = has(names.password);
  if (user === password) return null;
  return user ? pairSentence(names.user, names.password) : pairSentence(names.password, names.user);
}

/**
 * Everything this adapter can report. Frozen union, additive only
 * (SPEC.md §11.1(6)), and note the three families it is a union OF:
 *
 * - the adapter's own two (`email-payload-invalid`, `email-config-invalid`);
 * - the credential refusals, passed through verbatim from the provider, because
 *   "the vault is locked" and "nobody stored an SMTP password" are two different
 *   repairs and collapsing them into one adapter code would hide which; and
 * - the SMTP transport codes.
 *
 * A server's own refusal produces `smtp-<NNN>`, which is a family rather than a
 * member (see `smtp.ts`); {@link isEmailFailureCode} accepts both.
 */
export const EMAIL_FAILURE_CODES = [
  /** The payload is not a well-formed email. Nothing was connected to. */
  "email-payload-invalid",
  /** The vault answered, and what it holds is not usable configuration. */
  "email-config-invalid",
  ...CREDENTIAL_REFUSAL_CODES,
  ...SMTP_TRANSPORT_FAILURE_CODES,
] as const;

export type EmailFailureCode = (typeof EMAIL_FAILURE_CODES)[number] | `smtp-${number}`;

export function isEmailFailureCode(value: string): boolean {
  return (
    (EMAIL_FAILURE_CODES as readonly string[]).includes(value) || /^smtp-[1-5]\d\d$/u.test(value)
  );
}

export interface EmailAdapterOptions {
  /**
   * Additional classes this adapter serves, **added** to {@link EMAIL_CLASS}
   * rather than replacing it.
   *
   * Additive because the class list is routing, not authorization: it decides
   * which adapter an already-granted action goes to, and every real
   * authorization decision was made by the policy and the human before `act`
   * exists. An operator wiring internal mail declares
   * `communicate.email.internal` here and keeps the external class they already
   * had, which is what they meant; a list that replaced the default would make
   * "add one class" silently stop serving the canonical one.
   */
  classes?: readonly string[];
  /** Where the message's `Date` comes from. Injected for tests. */
  clock?: () => Date;
  /** Whole-session SMTP budget. Default {@link DEFAULT_SMTP_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Override the vault names. Partial: unnamed entries keep their default. */
  credentialNames?: Partial<EmailCredentialNames>;
  /** The EHLO name. */
  clientName?: string;
  /**
   * TLS certificate verification. **Defaults to `true`.** Setting it `false`
   * accepts any certificate and is sanctioned in exactly one place: this
   * repository's own tests, against the mock server on 127.0.0.1 holding the
   * self-signed fixture in `tests/fixtures/smtp/`. It exists as an explicit
   * option rather than an environment variable so that a deployment cannot
   * acquire it by accident, and `tests/adapter-email.test.ts` pins the default.
   */
  tlsRejectUnauthorized?: boolean;
}

/** One credential read, with the refusal kept as a first-class outcome. */
type Fetched =
  | { ok: true; value: string }
  | { ok: false; code: EmailFailureCode; message: string; absent: boolean };

function readCredential(credentials: CredentialProvider, name: string): Fetched {
  const got = credentials.get(name);
  if (got.ok) return { ok: true, value: got.value };
  return {
    ok: false,
    code: got.code,
    message: `the email adapter needs the credential ${JSON.stringify(name)}: ${got.message}`,
    absent: got.code === "credential-unavailable",
  };
}

/**
 * A fresh email adapter.
 *
 * Stateless and reusable: it holds no socket, no connection pool, and nothing
 * from a previous send. Two concurrent executions through the same instance
 * share nothing.
 */
export function emailAdapter(options: EmailAdapterOptions = {}): Adapter {
  const names: EmailCredentialNames = { ...DEFAULT_CREDENTIAL_NAMES, ...options.credentialNames };
  const classes = [EMAIL_CLASS, ...(options.classes ?? []).filter((cls) => cls !== EMAIL_CLASS)];
  const clock = options.clock ?? ((): Date => new Date());

  return {
    name: "email",
    classes,
    async act(input: ActInput): Promise<ActOutcome> {
      // (1) The payload. Refused before any credential is read and long before
      //     any socket is opened: a malformed payload is not a reason to touch
      //     the vault.
      const validated = validateEmailPayload(input.payload);
      if (!validated.ok) {
        return {
          ok: false,
          code: "email-payload-invalid",
          message: `the approved payload for ${input.actionKey} is not a well-formed email: ${validated.message}. Nothing was connected to and nothing was sent`,
        };
      }
      const payload = validated.payload;

      // (2) The configuration, from the vault, inside the window. Every value
      //     handed over joins the local redaction corpus, so a diagnostic this
      //     adapter builds is scrubbed before the contract scrubs it again.
      const secrets: string[] = [];
      const scrub = (text: string): string => redactSecrets(text, secrets).text;
      const read = (name: string): Fetched => {
        const got = readCredential(input.credentials, name);
        if (got.ok && got.value.length > 0) secrets.push(got.value);
        return got;
      };

      const host = read(names.host);
      if (!host.ok) return { ok: false, code: host.code, message: scrub(host.message) };
      const port = read(names.port);
      if (!port.ok) return { ok: false, code: port.code, message: scrub(port.message) };
      const security = read(names.security);
      if (!security.ok) return { ok: false, code: security.code, message: scrub(security.message) };

      const portNumber = Number(port.value);
      if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
        return {
          ok: false,
          code: "email-config-invalid",
          message: portSentence(names.port),
        };
      }
      if (!isSmtpSecurity(security.value)) {
        return {
          ok: false,
          code: "email-config-invalid",
          message: securitySentence(names.security),
        };
      }
      const transport: SmtpSecurity = security.value;

      // (3) The credential pair. Both absent is a relay that needs no login;
      //     exactly one absent is a half-configured deployment, and sending
      //     unauthenticated because the password happens to be missing is how a
      //     message goes out over a path nobody intended.
      const user = read(names.user);
      const password = read(names.password);
      if (!user.ok && !user.absent) {
        return { ok: false, code: user.code, message: scrub(user.message) };
      }
      if (!password.ok && !password.absent) {
        return { ok: false, code: password.code, message: scrub(password.message) };
      }
      const pairProblem = checkEmailCredentialSet(
        {
          [names.user]: user.ok ? user.value : undefined,
          [names.password]: password.ok ? password.value : undefined,
        },
        names,
      );
      if (pairProblem !== null) {
        return { ok: false, code: "email-config-invalid", message: pairProblem };
      }

      // (4) The two stamped fields, and the message.
      const hash = payloadHash(payload);
      const stamp: RenderStamp = {
        date: clock(),
        messageId: deterministicMessageId(input.actionKey, hash, payload.from),
      };
      const message = renderEmailMessage(payload, stamp);
      const recipients = envelopeRecipients(payload);

      // (5) The send.
      const sent = await sendMail(
        {
          host: host.value,
          port: portNumber,
          security: transport,
          ...(user.ok ? { user: user.value } : {}),
          ...(password.ok ? { password: password.value } : {}),
          timeoutMs: options.timeoutMs ?? DEFAULT_SMTP_TIMEOUT_MS,
          ...(options.clientName === undefined ? {} : { clientName: options.clientName }),
          tlsRejectUnauthorized: options.tlsRejectUnauthorized ?? true,
          redact: scrub,
        },
        { from: payload.from, recipients },
        message,
      );

      if (!sent.ok) {
        return { ok: false, code: sent.code, message: scrub(sent.message) };
      }

      // The detail is the receipt: what went where, and nothing about how the
      // session authenticated beyond the mechanism's name.
      return {
        ok: true,
        detail: {
          message_id: stamp.messageId,
          payload_hash: hash,
          date: stamp.date.toISOString(),
          recipients: recipients.length,
          bytes: Buffer.byteLength(message, "utf8"),
          secure: sent.secure,
          auth: sent.authenticated,
          smtp_code: sent.reply.code,
          transcript: sent.transcript,
        },
      };
    },
  };
}
