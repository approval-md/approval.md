/**
 * A minimal SMTP client, for the email adapter and nothing else (APRV-69).
 *
 * ## Why this exists rather than a dependency
 *
 * `CLAUDE.md` and SPEC.md §14 both put minimal dependencies among this
 * repository's invariants, and a mail library is a large surface to take on for
 * one send: nodemailer pulls a templating layer, an attachment pipeline, a DKIM
 * signer, OAuth2 token refresh, and a plugin system, all of it running inside
 * the one call this project spends its whole design protecting. What is actually
 * needed is RFC 5321's client half of a single transaction — greeting, EHLO,
 * optionally STARTTLS, optionally AUTH, MAIL FROM, RCPT TO, DATA, QUIT — which
 * is this file. `node:net` and `node:tls` and nothing else.
 *
 * ## What it deliberately does not do
 *
 * No connection pooling, no pipelining, no CHUNKING/BDAT, no SMTPUTF8, no DSN,
 * no retry. One transaction per {@link sendMail} call, one message per
 * transaction, and a failure is reported rather than retried: a retry inside an
 * adapter would be a second side effect under one consumed token, and deciding
 * to send again is a decision the gate exists to make.
 *
 * ## The probe, and the limit of what it proves
 *
 * {@link probeSmtp} runs the same session as {@link sendMail} up to and
 * including AUTH, then says QUIT. It is the same code, one call away
 * (`runSession` with no envelope), because a setup check that exercises a
 * different client than the send does is a check that can pass while the send
 * fails.
 *
 * A successful probe proves three things and no more: the host and port accept
 * a connection, the requested transport security (implicit TLS, or the STARTTLS
 * upgrade, with the same no-downgrade rule the send obeys) was actually
 * established, and this server accepts this credential.
 *
 * It does **not** prove that a message would be accepted. MAIL FROM, RCPT TO
 * and DATA are never issued, so nothing about the server's sender policy, its
 * relaying rules, its recipient validation, its size limits or its content
 * filtering is exercised. A probe that succeeds against a server which will
 * later refuse `MAIL FROM:<…>` with a 550 is a probe behaving correctly. Any
 * caller reporting the result to an operator (`setup adapter email` says
 * "verified") owes them that distinction: the transport and the login are
 * verified, the delivery is not.
 *
 * ## Failure vocabulary
 *
 * Everything is reported, nothing is thrown out of {@link sendMail}. Two
 * families:
 *
 * - the transport codes in {@link SMTP_TRANSPORT_FAILURE_CODES}, which are a
 *   frozen, additive union (SPEC.md §11.1(6)); and
 * - a reply-code family, `smtp-<NNN>`, minted from the server's own three-digit
 *   reply whenever the far side refuses a verb. It is a family rather than an
 *   enumeration because RFC 5321 lets a server answer with codes this repository
 *   cannot list in advance, and collapsing "mailbox unavailable" and
 *   "authentication failed" into one local name would throw away the one piece
 *   of information an operator needs. {@link SMTP_REPLY_CODE_PATTERN} pins the
 *   shape.
 *
 * ## What may appear in a failure message
 *
 * The verb, the reply code, and **the first line of the server's reply text**.
 * Not the whole reply: a multi-line refusal can run to a screen of banner text,
 * and everything after the first line is the server explaining itself to a human
 * rather than telling the client what happened. Not the command: an `AUTH PLAIN
 * <base64>` echoed into a diagnostic would publish the credential in the one
 * string the adapter's caller is most likely to print.
 *
 * And even the first line is passed through {@link SmtpTransportOptions.redact}
 * before it is returned, because a server is entitled to quote back the username
 * it just refused ("535 5.7.8 authentication failed for bot@example.com"), and a
 * deployment whose username IS the credential would otherwise leak it through a
 * channel the adapter contract's own guard also covers but which this module
 * should not be relying on. Two independent scrubs, by design.
 *
 * Deterministic apart from the network and the clock it does not read: no
 * randomness, no ambient configuration, no environment reads.
 */

import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from "node:tls";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** How the connection is protected. */
export type SmtpSecurity =
  /** TLS from the first byte (the submissions port, 465). */
  | "implicit"
  /** Plaintext, then a mandatory STARTTLS upgrade (the submission port, 587). */
  | "starttls"
  /**
   * Plaintext, and it stays that way. Only sane for a relay on the same host;
   * the adapter refuses to AUTH over it, because a password on a cleartext
   * socket is a password on the wire.
   */
  | "none";

export function isSmtpSecurity(value: unknown): value is SmtpSecurity {
  return value === "implicit" || value === "starttls" || value === "none";
}

/**
 * Transport failures this client can report. Frozen union, additive only
 * (SPEC.md §11.1(6)).
 *
 * They are distinguished because they call for four different responses: fix
 * the address, fix the TLS configuration, look at why the far side is slow, and
 * report a server that is not speaking SMTP.
 */
export const SMTP_TRANSPORT_FAILURE_CODES = [
  /** The TCP connection could not be established at all. */
  "smtp-connect-failed",
  /** TLS could not be established, or the server would not offer STARTTLS. */
  "smtp-tls-failed",
  /** The session exceeded its whole-transaction budget. */
  "smtp-timeout",
  /** The far side sent something that is not an SMTP reply, or hung up. */
  "smtp-protocol-error",
] as const;

export type SmtpTransportFailureCode = (typeof SMTP_TRANSPORT_FAILURE_CODES)[number];

/** The shape of a minted reply-code failure: `smtp-` and three digits. */
export const SMTP_REPLY_CODE_PATTERN = /^smtp-[1-5]\d\d$/u;

/** The default whole-session budget, in milliseconds. */
export const DEFAULT_SMTP_TIMEOUT_MS = 30_000;

/** A parsed SMTP reply. `lines` holds the text of each line, code stripped. */
export interface SmtpReply {
  code: number;
  lines: string[];
  /** The first line's text, which is the only part any message may quote. */
  first: string;
}

export interface SmtpTransportOptions {
  host: string;
  port: number;
  security: SmtpSecurity;
  /** Omitted (or empty) means the session does not authenticate. */
  user?: string;
  password?: string;
  /** Whole-session budget. Exceeding it is `smtp-timeout`. */
  timeoutMs?: number;
  /** The name this client gives in EHLO. */
  clientName?: string;
  /**
   * TLS certificate verification. **Defaults to `true`, and production must
   * leave it there.** The only sanctioned `false` is a test against a mock on
   * 127.0.0.1 holding a self-signed fixture certificate.
   */
  tlsRejectUnauthorized?: boolean;
  /** Applied to every string this module returns. See the module header. */
  redact?(text: string): string;
}

/** The SMTP envelope, which is not the message's headers. */
export interface SmtpEnvelope {
  /** MAIL FROM. The return path, not necessarily the From: header. */
  from: string;
  /** RCPT TO, once each: To, Cc, and **Bcc**, which appear in no header. */
  recipients: readonly string[];
}

export type SmtpSendResult =
  | {
      ok: true;
      /** The reply to the end-of-data terminator: the server accepting it. */
      reply: { code: number; text: string };
      /** `VERB code` for each step, in order. Never a command argument. */
      transcript: string[];
      /** Was the message handed over on an encrypted socket? */
      secure: boolean;
      /** Did the session authenticate, and with which mechanism? */
      authenticated: "PLAIN" | "LOGIN" | null;
    }
  | {
      ok: false;
      code: SmtpTransportFailureCode | `smtp-${number}`;
      message: string;
      transcript: string[];
      secure: boolean;
    };

/**
 * What {@link probeSmtp} reports: {@link SmtpSendResult} without `reply`, since
 * a probe never issues a verb whose reply is anything but a step of the
 * session. The failure codes are the same union, from the same code path.
 */
export type SmtpProbeResult =
  | {
      ok: true;
      /** `VERB code` for each step, in order. Never a command argument. */
      transcript: string[];
      /** Was the session encrypted when it ended? */
      secure: boolean;
      /** Did the session authenticate, and with which mechanism? */
      authenticated: "PLAIN" | "LOGIN" | null;
    }
  | {
      ok: false;
      code: SmtpTransportFailureCode | `smtp-${number}`;
      message: string;
      transcript: string[];
      secure: boolean;
    };

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const CRLF = "\r\n";

/** An internal control-flow carrier. Never escapes {@link sendMail}. */
class SmtpError extends Error {
  constructor(
    readonly code: SmtpTransportFailureCode | `smtp-${number}`,
    message: string,
  ) {
    super(message);
    this.name = "SmtpError";
  }
}

/**
 * The reply reader.
 *
 * SMTP framing is line-oriented: a reply is one or more lines, each opening
 * with the same three-digit code, continuation lines separated from the last by
 * a hyphen (`250-STARTTLS`) rather than a space (`250 HELP`). Bytes are
 * accumulated as a Buffer and decoded per complete line, so a multi-byte UTF-8
 * character split across two TCP segments cannot become a replacement character
 * in a diagnostic.
 */
class ReplyReader {
  private raw: Buffer = Buffer.alloc(0);
  private lines: { code: number; text: string; last: boolean }[] = [];
  private ready: SmtpReply[] = [];
  private waiting: { resolve(reply: SmtpReply): void; reject(error: Error): void } | null = null;
  private failure: Error | null = null;

  /** Feed bytes. Called from the socket's `data` handler. */
  push(chunk: Buffer): void {
    this.raw = this.raw.length === 0 ? chunk : Buffer.concat([this.raw, chunk]);
    for (;;) {
      const index = this.raw.indexOf(0x0a);
      if (index === -1) break;
      const line = this.raw.subarray(0, index).toString("utf8").replace(/\r$/u, "");
      this.raw = this.raw.subarray(index + 1);
      this.consume(line);
    }
  }

  /** Bytes received but not yet forming a line. Non-empty is a violation. */
  get pendingBytes(): number {
    return this.raw.length;
  }

  /** Replies parsed but not yet awaited. Non-empty before STARTTLS is fatal. */
  get pendingReplies(): number {
    return this.ready.length;
  }

  private consume(line: string): void {
    const match = /^(\d{3})([ -]?)(.*)$/u.exec(line);
    if (match === null) {
      this.fail(
        new SmtpError(
          "smtp-protocol-error",
          `the server sent a line that is not an SMTP reply (${JSON.stringify(line.slice(0, 120))})`,
        ),
      );
      return;
    }
    const code = Number(match[1]);
    const last = match[2] !== "-";
    this.lines.push({ code, text: match[3] ?? "", last });
    if (!last) return;

    const texts = this.lines.map((entry) => entry.text);
    const reply: SmtpReply = { code, lines: texts, first: texts[0] ?? "" };
    this.lines = [];
    const waiter = this.waiting;
    if (waiter === null) this.ready.push(reply);
    else {
      this.waiting = null;
      waiter.resolve(reply);
    }
  }

  /** Terminate every pending and future read with `error`. Idempotent. */
  fail(error: Error): void {
    if (this.failure === null) this.failure = error;
    const waiter = this.waiting;
    if (waiter !== null) {
      this.waiting = null;
      waiter.reject(this.failure);
    }
  }

  /** The next complete reply. Rejects with the session's failure, if any. */
  next(): Promise<SmtpReply> {
    const queued = this.ready.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.failure !== null) return Promise.reject(this.failure);
    return new Promise<SmtpReply>((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }
}

/** Is `code` a success for this verb? RFC 5321: 2yz, plus 3yz where expected. */
function expected(reply: SmtpReply, codes: readonly number[]): boolean {
  return codes.includes(reply.code) || codes.includes(Math.floor(reply.code / 100));
}

function replyFailure(verb: string, reply: SmtpReply, redact: (text: string) => string): SmtpError {
  return new SmtpError(
    `smtp-${reply.code}` as `smtp-${number}`,
    // The whole vocabulary of a reply-code failure, and its whole content: the
    // verb, the code, the FIRST line of the reply, redacted. See the header.
    `${verb} refused: ${String(reply.code)} ${redact(reply.first)}`,
  );
}

/** `\0user\0password`, base64. RFC 4616 over RFC 4954. */
function plainToken(user: string, password: string): string {
  return Buffer.from(`\u0000${user}\u0000${password}`, "utf8").toString("base64");
}

/** The mechanisms the server advertised on its EHLO `AUTH` line, uppercased. */
function authMechanisms(capabilities: readonly string[]): string[] {
  for (const line of capabilities) {
    const match = /^AUTH(?:[ =])(.*)$/iu.exec(line.trim());
    if (match === null) continue;
    return (match[1] ?? "")
      .split(/\s+/u)
      .filter((entry) => entry.length > 0)
      .map((entry) => entry.toUpperCase());
  }
  return [];
}

function advertises(capabilities: readonly string[], keyword: string): boolean {
  return capabilities.some((line) => line.trim().toUpperCase().split(/\s+/u)[0] === keyword);
}

// ---------------------------------------------------------------------------
// The transaction
// ---------------------------------------------------------------------------

/**
 * Run one SMTP session and report how it went. Never throws.
 *
 * With an envelope this is the whole transaction: greeting, EHLO, STARTTLS,
 * AUTH, MAIL FROM, RCPT TO, DATA, QUIT. With `envelope` and `message` both
 * null it is a probe: the same session, stopped after AUTH (or after EHLO and
 * the STARTTLS upgrade when no credential was supplied), then QUIT. One
 * function rather than two, so the probe cannot drift away from the send it is
 * meant to predict.
 *
 * `message` must already be a complete RFC 5322 message with CRLF line endings;
 * dot-stuffing and the terminating `.` are applied here, because they are
 * RFC 5321 transport framing rather than part of the message the grant bound to.
 *
 * The whole session shares one budget (`timeoutMs`) rather than one per verb.
 * A per-verb timer would let a server that answers every command in
 * `timeoutMs - 1` hold the execution open indefinitely, and an execution held
 * open is a log entry with no outcome, which is the state this project works
 * hardest to avoid.
 */
async function runSession(
  options: SmtpTransportOptions,
  envelope: SmtpEnvelope,
  message: string,
): Promise<SmtpSendResult>;
async function runSession(
  options: SmtpTransportOptions,
  envelope: null,
  message: null,
): Promise<SmtpProbeResult>;
async function runSession(
  options: SmtpTransportOptions,
  envelope: SmtpEnvelope | null,
  message: string | null,
): Promise<SmtpSendResult | SmtpProbeResult> {
  const redact = options.redact ?? ((text: string): string => text);
  const timeoutMs = options.timeoutMs ?? DEFAULT_SMTP_TIMEOUT_MS;
  const clientName = options.clientName ?? "approval.md";
  const rejectUnauthorized = options.tlsRejectUnauthorized ?? true;

  const transcript: string[] = [];
  const reader = new ReplyReader();
  let socket: Socket | TLSSocket | null = null;
  let secure = options.security === "implicit";
  let authenticated: "PLAIN" | "LOGIN" | null = null;

  // The one timer. Firing it poisons the reader, so whichever await is in
  // flight rejects with the timeout rather than hanging until the socket does.
  let expired = false;
  const deadline = setTimeout(() => {
    expired = true;
    reader.fail(
      new SmtpError(
        "smtp-timeout",
        `the SMTP session exceeded its ${String(timeoutMs)}ms budget; the message may or may not have been accepted, so the execution is recorded as failed and a human decides whether to send again`,
      ),
    );
    socket?.destroy();
  }, timeoutMs);
  // A timer must never hold the process open on its own.
  deadline.unref?.();

  /** Attach the reader to `next`, replacing any previous attachment. */
  const attach = (next: Socket | TLSSocket): void => {
    socket = next;
    next.on("data", (chunk: Buffer) => reader.push(chunk));
    next.on("error", (cause: Error) => {
      reader.fail(
        expired
          ? new SmtpError("smtp-timeout", "the SMTP session timed out")
          : new SmtpError("smtp-protocol-error", `the connection failed: ${redact(cause.message)}`),
      );
    });
    next.on("close", () => {
      reader.fail(
        new SmtpError(
          "smtp-protocol-error",
          "the server closed the connection before the transaction finished",
        ),
      );
    });
  };

  /** Detach every listener, so a TLS wrapper can take the socket over. */
  const detach = (from: Socket | TLSSocket): void => {
    from.removeAllListeners("data");
    from.removeAllListeners("error");
    from.removeAllListeners("close");
  };

  /**
   * Detach, then swallow. A socket this function has finished with can still
   * emit `ECONNRESET` when the far side goes away, and an unhandled `error` on
   * a socket is an uncaught exception that would take the process down — which
   * for an adapter means a crash *after* a message was already delivered.
   */
  const abandon = (from: Socket | TLSSocket): void => {
    detach(from);
    from.on("error", () => {
      /* the transaction is over; there is nothing left to report */
    });
  };

  const write = (line: string): void => {
    socket?.write(`${line}${CRLF}`);
  };

  /** Send `line`, read one reply, and insist it is in `codes`. */
  const say = async (
    verb: string,
    line: string | null,
    codes: readonly number[],
  ): Promise<SmtpReply> => {
    if (line !== null) write(line);
    const reply = await reader.next();
    transcript.push(`${verb} ${String(reply.code)}`);
    if (!expected(reply, codes)) throw replyFailure(verb, reply, redact);
    return reply;
  };

  try {
    // (1) The connection.
    socket = await new Promise<Socket | TLSSocket>((resolve, reject) => {
      const onError = (cause: Error): void => {
        reject(
          new SmtpError(
            options.security === "implicit" ? "smtp-tls-failed" : "smtp-connect-failed",
            // The address is NOT interpolated: it came from the vault, and
            // every value the vault handed over is redacted out of anything
            // this adapter returns (see the email adapter's header). Naming the
            // CREDENTIAL leaves the operator a diagnostic that survives the
            // scrub and points at the thing to fix.
            `could not connect to the SMTP host named by smtp.host, on the port named by smtp.port: ${redact(cause.message)}`,
          ),
        );
      };
      if (options.security === "implicit") {
        const tlsOptions: ConnectionOptions = {
          host: options.host,
          port: options.port,
          rejectUnauthorized,
          servername: options.host,
        };
        const created = tlsConnect(tlsOptions, () => {
          created.removeListener("error", onError);
          resolve(created);
        });
        created.once("error", onError);
      } else {
        const created = netConnect({ host: options.host, port: options.port }, () => {
          created.removeListener("error", onError);
          resolve(created);
        });
        created.once("error", onError);
      }
    });
    attach(socket);

    // (2) The greeting, then EHLO.
    await say("greeting", null, [220]);
    let ehlo = await say("EHLO", `EHLO ${clientName}`, [250]);
    let capabilities = ehlo.lines.slice(1);

    // (3) The STARTTLS upgrade, when the caller asked for one. A server that
    //     does not offer it is a failure and never a silent downgrade: the
    //     caller asked for an encrypted session and would otherwise get a
    //     plaintext one carrying a password.
    if (options.security === "starttls") {
      if (!advertises(capabilities, "STARTTLS")) {
        throw new SmtpError(
          "smtp-tls-failed",
          "the server named by smtp.host does not advertise STARTTLS, and this adapter will not silently downgrade to a plaintext session carrying a password",
        );
      }
      await say("STARTTLS", "STARTTLS", [220]);

      // Anything already buffered here was injected by something that is not
      // the server's TLS layer, and accepting it would be the classic STARTTLS
      // command-injection hole. Refuse, loudly.
      if (reader.pendingBytes > 0 || reader.pendingReplies > 0) {
        throw new SmtpError(
          "smtp-protocol-error",
          "bytes arrived after the STARTTLS reply and before the handshake; they were injected by something that is not the TLS session, and the transaction was abandoned",
        );
      }

      const plain = socket;
      detach(plain);
      socket = await new Promise<TLSSocket>((resolve, reject) => {
        const onError = (cause: Error): void => {
          reject(new SmtpError("smtp-tls-failed", `the STARTTLS handshake failed: ${redact(cause.message)}`));
        };
        const upgraded = tlsConnect(
          { socket: plain, rejectUnauthorized, servername: options.host },
          () => {
            upgraded.removeListener("error", onError);
            resolve(upgraded);
          },
        );
        upgraded.once("error", onError);
      });
      attach(socket);
      secure = true;

      // RFC 3207: the client MUST discard everything it learned before the
      // upgrade and re-issue EHLO. A capability list from the plaintext phase
      // is a capability list an attacker could have written.
      ehlo = await say("EHLO", `EHLO ${clientName}`, [250]);
      capabilities = ehlo.lines.slice(1);
    }

    // (4) AUTH, when a credential was supplied. PLAIN first, LOGIN as the
    //     fallback, because some servers advertise both and accept only one.
    const user = options.user ?? "";
    const password = options.password ?? "";
    if (user.length > 0 && password.length > 0) {
      if (!secure) {
        throw new SmtpError(
          "smtp-tls-failed",
          'a credential was supplied for a session with security "none"; this adapter will not send a password over a cleartext socket. Use "starttls" or "implicit", or store no smtp.user/smtp.password for a local relay that needs none',
        );
      }
      const mechanisms = authMechanisms(capabilities);
      const allow = (name: string): boolean => mechanisms.length === 0 || mechanisms.includes(name);

      let authError: SmtpError | null = null;
      if (allow("PLAIN")) {
        try {
          await say("AUTH", `AUTH PLAIN ${plainToken(user, password)}`, [235]);
          authenticated = "PLAIN";
        } catch (cause) {
          if (!(cause instanceof SmtpError)) throw cause;
          // Only a REFUSAL is worth a second mechanism. A timeout or a dropped
          // socket has nothing left to fall back onto.
          if (!SMTP_REPLY_CODE_PATTERN.test(cause.code)) throw cause;
          authError = cause;
        }
      }
      if (authenticated === null && allow("LOGIN")) {
        await say("AUTH", "AUTH LOGIN", [334]);
        await say("AUTH", Buffer.from(user, "utf8").toString("base64"), [334]);
        await say("AUTH", Buffer.from(password, "utf8").toString("base64"), [235]);
        authenticated = "LOGIN";
      }
      if (authenticated === null) {
        throw (
          authError ??
          new SmtpError(
            "smtp-protocol-error",
            `a credential was supplied but the server advertises no mechanism this adapter speaks (it offers ${mechanisms.length === 0 ? "none" : mechanisms.join(", ")}; PLAIN and LOGIN are implemented)`,
          )
        );
      }
    }

    // (5) The envelope. Bcc recipients are here and in no header.
    //     A probe stops before this line: MAIL FROM is the first verb that
    //     tells the server a message is coming, and a probe has nothing to say.
    let accepted: SmtpReply | null = null;
    if (envelope !== null && message !== null) {
      await say("MAIL FROM", `MAIL FROM:<${envelope.from}>`, [250]);
      for (const recipient of envelope.recipients) {
        await say("RCPT TO", `RCPT TO:<${recipient}>`, [250, 251]);
      }

      // (6) The message. Dot-stuffing and the terminator are transport framing.
      await say("DATA", "DATA", [354]);
      socket.write(dotStuff(message));
      accepted = await say("message", ".", [250]);
    }

    // (7) QUIT is courtesy: the message is already accepted, and a server that
    //     mishandles the goodbye has not unsent it. Failures here are ignored
    //     on purpose — reporting one would turn a delivered message into a
    //     failed execution, which is the worst lie this adapter could tell.
    //     A probe has nothing to lose here either; it has already learned
    //     everything the session can tell it.
    clearTimeout(deadline);
    abandon(socket);
    // `end`, not `write` then `destroy`: a destroyed TLS socket discards the
    // bytes still in its write buffer, and the far side would see the session
    // vanish rather than end. The message is already accepted either way, so
    // nothing here can turn a delivered message into a failed execution.
    try {
      socket.end(`QUIT${CRLF}`);
    } catch {
      /* already delivered */
    }

    if (accepted === null) return { ok: true, transcript, secure, authenticated };
    return {
      ok: true,
      reply: { code: accepted.code, text: redact(accepted.first) },
      transcript,
      secure,
      authenticated,
    };
  } catch (cause) {
    clearTimeout(deadline);
    if (socket !== null) {
      abandon(socket);
      socket.destroy();
    }
    if (cause instanceof SmtpError) {
      return { ok: false, code: cause.code, message: cause.message, transcript, secure };
    }
    return {
      ok: false,
      code: "smtp-protocol-error",
      message: redact(cause instanceof Error ? cause.message : String(cause)),
      transcript,
      secure,
    };
  }
}

/**
 * Run one SMTP transaction and report how it went. Never throws.
 *
 * The whole of it is {@link runSession}; this is the entry point that supplies
 * an envelope and a message, and its result is unchanged from the day it was
 * the whole function.
 */
export async function sendMail(
  options: SmtpTransportOptions,
  envelope: SmtpEnvelope,
  message: string,
): Promise<SmtpSendResult> {
  return runSession(options, envelope, message);
}

/**
 * Open a session, authenticate, send nothing, and report. Never throws.
 *
 * Exactly {@link sendMail}'s session up to AUTH — the same connection, the same
 * STARTTLS rules including the no-downgrade refusal and the response-injection
 * guard, the same refusal to put a password on a cleartext socket, the same
 * one-session budget, the same redaction of every string it returns — and then
 * QUIT. See this module's header for what a success does and does not prove:
 * transport, TLS mode and credential, never that a message would be delivered.
 */
export async function probeSmtp(options: SmtpTransportOptions): Promise<SmtpProbeResult> {
  return runSession(options, null, null);
}

/**
 * RFC 5321 §4.5.2: a line of the message that begins with `.` gets a second
 * one, so the terminator cannot be forged by the message's own content. The
 * terminating `.` line is NOT added here; {@link sendMail} sends it as its own
 * command so the transcript records the reply to it.
 */
export function dotStuff(message: string): string {
  const body = message
    .split(CRLF)
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join(CRLF);
  return body.endsWith(CRLF) ? body : `${body}${CRLF}`;
}
