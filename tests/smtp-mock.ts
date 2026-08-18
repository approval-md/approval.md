/**
 * A local mock SMTP server (APRV-69).
 *
 * The email adapter is exercised end to end — implicit TLS, the STARTTLS
 * upgrade, AUTH PLAIN and AUTH LOGIN, MAIL/RCPT/DATA, every refusal the adapter
 * claims to survive, and a stall that must become `smtp-timeout` — against this
 * `node:net` / `node:tls` server on 127.0.0.1. **No test in this repository
 * opens a network connection**, and {@link assertLoopback} is called on every
 * host the suite hands the adapter so that stays true by assertion rather than
 * by good intentions, exactly as `tests/telegram-mock.ts` does for the Bot API.
 *
 * The TLS material is the checked-in self-signed fixture under
 * `tests/fixtures/smtp/` — see the README there for what it is and why it is
 * committed. It is accepted only because the suite passes
 * `tlsRejectUnauthorized: false`, an adapter option whose default is `true`.
 *
 * Where it deliberately differs from a real MTA: it delivers nothing, it
 * validates no address, it enforces no size limit, and it forgets everything
 * when it closes. What it does faithfully is the wire protocol the adapter
 * speaks, including multi-line EHLO replies (`250-…` then `250 …`), because
 * parsing those is a thing the client can get wrong.
 *
 * Not a test file (no `.test.ts` suffix), so the runner ignores it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer as createNetServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { createServer as createTlsServer, TLSSocket } from "node:tls";
import { fileURLToPath } from "node:url";

const FIXTURE_DIR = fileURLToPath(new URL("../../tests/fixtures/smtp/", import.meta.url));
const TLS_KEY = readFileSync(`${FIXTURE_DIR}test-key.pem`);
const TLS_CERT = readFileSync(`${FIXTURE_DIR}test-cert.pem`);

/** The steps a mock can be told to refuse or to stall at. */
export type MockSmtpStep =
  | "greeting"
  | "ehlo"
  | "starttls"
  | "auth"
  | "mail"
  | "rcpt"
  | "data"
  | "end-of-data";

/** One session the mock served, recorded verbatim. */
export interface MockSmtpSession {
  /** Every command line received, in order. AUTH arguments are NOT stored. */
  commands: string[];
  mailFrom: string | null;
  /** Every RCPT TO address, in order. */
  recipients: string[];
  /** The DATA bytes exactly as they arrived, dot-stuffing and all. */
  rawData: string;
  /** The same bytes un-stuffed and with the terminator removed: the message. */
  message: string | null;
  /** Did this session complete a TLS handshake (implicit or STARTTLS)? */
  secure: boolean;
  /** The mechanism the client authenticated with, if it did. */
  authenticated: "PLAIN" | "LOGIN" | null;
  /** The credentials the client presented. Checked; never printed by a test. */
  presented: { user: string; password: string } | null;
  /** Did the client send QUIT? */
  quit: boolean;
}

export interface MockSmtpOptions {
  /** `implicit` listens with TLS from the first byte. Default `none`. */
  tls?: "implicit" | "none";
  /** Advertise STARTTLS in EHLO. Default `true` for a plaintext listener. */
  advertiseStarttls?: boolean;
  /** The `AUTH` mechanisms EHLO advertises. Default `["PLAIN", "LOGIN"]`. */
  advertiseAuth?: readonly string[];
  /** The one credential this server accepts. Omit to accept any. */
  user?: string;
  password?: string;
  /**
   * Extra bytes written immediately after the `220 Ready to start TLS` reply
   * and before the handshake, in the same write, so the client sees them as
   * part of the same segment. This is the STARTTLS response-injection attack
   * (an on-path attacker queueing a reply the client will attribute to the
   * encrypted session), and a client that does anything but abandon the
   * session has the hole. Default: nothing is injected, so every existing
   * test is unaffected.
   */
  injectAfterStarttls?: string;
}

export interface MockSmtpFailure {
  step: MockSmtpStep;
  /** The reply to send instead, e.g. `"535 5.7.8 authentication failed"`. */
  reply: string;
}

export interface MockSmtp {
  readonly host: string;
  readonly port: number;
  /** Does this listener speak TLS from the first byte? */
  readonly implicitTls: boolean;
  /** How many TCP connections have been accepted. Zero is a real assertion. */
  readonly connections: number;
  /** Every session, in order. */
  readonly sessions: MockSmtpSession[];
  /** The most recent session, or `undefined` when there is none. */
  last(): MockSmtpSession | undefined;
  /** Refuse at `step` with `reply`, or `null` to behave. */
  failAt(failure: MockSmtpFailure | null): void;
  /** Accept the command at `step` and never answer it, or `null` to behave. */
  stallAt(step: MockSmtpStep | null): void;
  close(): Promise<void>;
}

/** A test's SMTP host is loopback. Called before every adapter is built. */
export function assertLoopback(host: string): string {
  assert.match(
    host,
    /^(127\.0\.0\.1|localhost|::1)$/u,
    `tests must never contact a real SMTP server; host was ${JSON.stringify(host)}`,
  );
  return host;
}

export async function startMockSmtp(options: MockSmtpOptions = {}): Promise<MockSmtp> {
  const sessions: MockSmtpSession[] = [];
  const sockets = new Set<Socket>();
  let connections = 0;
  let failure: MockSmtpFailure | null = null;
  let stall: MockSmtpStep | null = null;

  const advertiseStarttls = options.advertiseStarttls ?? options.tls !== "implicit";
  const advertiseAuth = options.advertiseAuth ?? ["PLAIN", "LOGIN"];

  /** Drive one client session. Wired to a fresh socket on every connection. */
  function serve(socket: Socket, secure: boolean): void {
    const session: MockSmtpSession = {
      commands: [],
      mailFrom: null,
      recipients: [],
      rawData: "",
      message: null,
      secure,
      authenticated: null,
      presented: null,
      quit: false,
    };
    sessions.push(session);

    let buffer = "";
    let inData = false;
    /** When set, the next raw line is a base64 AUTH LOGIN continuation. */
    let awaiting: "login-user" | "login-password" | null = null;
    let pendingUser = "";
    /** The socket replies go out on. Swapped for the TLSSocket by STARTTLS. */
    let active: Socket = socket;

    const say = (line: string): void => {
      active.write(`${line}\r\n`);
    };

    /**
     * Handle `step`. Returns `true` when the caller should keep going: a
     * configured failure has already answered, and a configured stall has
     * deliberately answered nothing at all.
     */
    const proceed = (step: MockSmtpStep): boolean => {
      if (stall === step) return false;
      if (failure?.step === step) {
        say(failure.reply);
        return false;
      }
      return true;
    };

    /**
     * Read lines off `target`.
     *
     * Buffers, never `setEncoding("utf8")`: a STARTTLS upgrade hands the raw
     * socket to a `TLSSocket`, and a socket left in string mode delivers the
     * handshake as mangled text ("bad record type") instead of bytes.
     */
    const attach = (target: Socket): void => {
      active = target;
      target.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        for (;;) {
          const index = buffer.indexOf("\n");
          if (index === -1) break;
          const line = buffer.slice(0, index).replace(/\r$/u, "");
          buffer = buffer.slice(index + 1);
          handle(line);
        }
      });
      target.on("error", () => {
        /* a client that hangs up mid-session is a case under test */
      });
    };

    const finishData = (): void => {
      const raw = session.rawData;
      session.message = raw
        .split("\r\n")
        .map((line) => (line.startsWith("..") ? line.slice(1) : line))
        .join("\r\n");
      if (!proceed("end-of-data")) return;
      say("250 2.0.0 Ok: queued as MOCK00001");
    };

    function handle(line: string): void {
      if (inData) {
        if (line === ".") {
          inData = false;
          finishData();
          return;
        }
        session.rawData += `${line}\r\n`;
        return;
      }

      if (awaiting !== null) {
        // A base64 continuation. Recorded as the STEP, never as the bytes: a
        // recorded transcript is a thing a failing test prints.
        session.commands.push(`<${awaiting}>`);
        const decoded = Buffer.from(line, "base64").toString("utf8");
        if (awaiting === "login-user") {
          pendingUser = decoded;
          awaiting = "login-password";
          say("334 UGFzc3dvcmQ6");
          return;
        }
        awaiting = null;
        session.presented = { user: pendingUser, password: decoded };
        if (!accepts(pendingUser, decoded)) {
          say("535 5.7.8 authentication failed");
          return;
        }
        session.authenticated = "LOGIN";
        say("235 2.7.0 Authentication successful");
        return;
      }

      const verb = (line.split(" ")[0] ?? "").toUpperCase();
      // The AUTH argument is a credential. The verb is recorded; the rest is not.
      session.commands.push(verb === "AUTH" ? `AUTH ${(line.split(" ")[1] ?? "").toUpperCase()}` : line);

      switch (verb) {
        case "EHLO":
        case "HELO": {
          if (!proceed("ehlo")) return;
          const capabilities = [
            "8BITMIME",
            "SIZE 33554432",
            ...(advertiseStarttls && !session.secure ? ["STARTTLS"] : []),
            ...(advertiseAuth.length > 0 ? [`AUTH ${advertiseAuth.join(" ")}`] : []),
          ];
          say(`250-mock.smtp.invalid greets you`);
          for (const [index, capability] of capabilities.entries()) {
            say(`${index === capabilities.length - 1 ? "250 " : "250-"}${capability}`);
          }
          return;
        }
        case "STARTTLS": {
          if (!proceed("starttls")) return;
          // One write, so the injected bytes cannot lose a race with the 220.
          say(`220 2.0.0 Ready to start TLS\r\n${options.injectAfterStarttls ?? ""}`.trimEnd());
          // Detach BEFORE wrapping: the TLSSocket must be the only reader of
          // the raw socket from the handshake's first byte.
          socket.removeAllListeners("data");
          buffer = "";
          const upgraded = new TLSSocket(socket, {
            isServer: true,
            key: TLS_KEY,
            cert: TLS_CERT,
          });
          session.secure = true;
          attach(upgraded as unknown as Socket);
          upgraded.on("error", () => {
            /* a failed handshake is a case under test */
          });
          return;
        }
        case "AUTH": {
          if (!proceed("auth")) return;
          const parts = line.split(" ");
          const mechanism = (parts[1] ?? "").toUpperCase();
          if (mechanism === "PLAIN") {
            const token = parts[2] ?? "";
            const decoded = Buffer.from(token, "base64").toString("utf8").split("\u0000");
            const user = decoded[1] ?? "";
            const password = decoded[2] ?? "";
            session.presented = { user, password };
            if (!advertiseAuth.includes("PLAIN") || !accepts(user, password)) {
              say("535 5.7.8 authentication failed");
              return;
            }
            session.authenticated = "PLAIN";
            say("235 2.7.0 Authentication successful");
            return;
          }
          if (mechanism === "LOGIN") {
            awaiting = "login-user";
            say("334 VXNlcm5hbWU6");
            return;
          }
          say("504 5.5.4 Unrecognized authentication type");
          return;
        }
        case "MAIL": {
          if (!proceed("mail")) return;
          session.mailFrom = address(line);
          say("250 2.1.0 Ok");
          return;
        }
        case "RCPT": {
          if (!proceed("rcpt")) return;
          const recipient = address(line);
          if (recipient !== null) session.recipients.push(recipient);
          say("250 2.1.5 Ok");
          return;
        }
        case "DATA": {
          if (!proceed("data")) return;
          inData = true;
          say("354 End data with <CR><LF>.<CR><LF>");
          return;
        }
        case "QUIT": {
          session.quit = true;
          say("221 2.0.0 Bye");
          active.end();
          return;
        }
        case "RSET": {
          say("250 2.0.0 Ok");
          return;
        }
        default:
          say(`500 5.5.2 Unrecognized command ${verb}`);
      }
    }

    attach(socket);
    if (proceed("greeting")) say("220 mock.smtp.invalid ESMTP approval.md mock");
  }

  function accepts(user: string, password: string): boolean {
    if (options.user === undefined && options.password === undefined) return true;
    return user === (options.user ?? "") && password === (options.password ?? "");
  }

  /** `MAIL FROM:<a@b>` / `RCPT TO:<a@b>` → `a@b`. */
  function address(line: string): string | null {
    const match = /<([^>]*)>/u.exec(line);
    return match === null ? null : (match[1] ?? "");
  }

  const onConnection = (socket: Socket, secure: boolean): void => {
    connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    serve(socket, secure);
  };

  const server: Server =
    options.tls === "implicit"
      ? (createTlsServer({ key: TLS_KEY, cert: TLS_CERT }, (socket) => {
          onConnection(socket as unknown as Socket, true);
        }) as unknown as Server)
      : createNetServer((socket) => {
          onConnection(socket, false);
        });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;

  return {
    host: "127.0.0.1",
    port,
    implicitTls: options.tls === "implicit",
    get connections() {
      return connections;
    },
    sessions,
    last() {
      return sessions[sessions.length - 1];
    },
    failAt(next) {
      failure = next;
    },
    stallAt(step) {
      stall = step;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
