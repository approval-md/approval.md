/**
 * `probeSmtp` — the SMTP session that authenticates and sends nothing (APRV-77).
 *
 * The probe shares its whole body with `sendMail` (`runSession` in
 * `src/adapters/smtp.ts`), so what these cases are really asserting is that the
 * shared session behaves identically when it is handed no envelope: the same
 * STARTTLS rules, the same refusal to put a password on a cleartext socket, the
 * same one-session budget, the same redaction, and then QUIT instead of MAIL
 * FROM. The send path's own behaviour is pinned by `tests/adapter-email.test.ts`,
 * which this task did not touch.
 *
 * Nothing here contacts the network: every session goes to `tests/smtp-mock.ts`
 * on 127.0.0.1, asserted loopback before each probe. As in the email suite,
 * every string these cases captured is swept for the password at the end,
 * because a leak through a message nobody thought to assert on is exactly the
 * shape SPEC.md §11.1 invariant 3 exists to prevent.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { REDACTION_PLACEHOLDER, redactSecrets } from "../src/adapters/contract.js";
import { probeSmtp, type SmtpProbeResult } from "../src/adapters/smtp.js";
import { assertLoopback, startMockSmtp, type MockSmtp } from "./smtp-mock.js";

/** Distinctive enough to hunt for in any string this suite captured. */
const PASSWORD = "smtp-pw-aprv77-3c91be-DO-NOT-USE";
const USER = "prober@approval.invalid";

/** Everything this suite captured. Swept for the password in `after`. */
const captured: string[] = [];

function record(value: unknown): void {
  captured.push(typeof value === "string" ? value : JSON.stringify(value));
}

/** The same scrub the email adapter builds around every vault value. */
function scrub(text: string): string {
  return redactSecrets(text, [PASSWORD]).text;
}

const mocks: MockSmtp[] = [];

async function mock(options: Parameters<typeof startMockSmtp>[0] = {}): Promise<MockSmtp> {
  const started = await startMockSmtp(options);
  assertLoopback(started.host);
  mocks.push(started);
  return started;
}

/**
 * Probe `server`. The fixture certificate is self-signed, so verification is
 * off here and ONLY here: `tlsRejectUnauthorized` defaults to `true` and
 * production must leave it there.
 */
async function probe(
  server: MockSmtp,
  extra: Partial<Parameters<typeof probeSmtp>[0]> = {},
): Promise<SmtpProbeResult> {
  const result = await probeSmtp({
    host: server.host,
    port: server.port,
    security: server.implicitTls ? "implicit" : "starttls",
    timeoutMs: 5_000,
    tlsRejectUnauthorized: false,
    redact: scrub,
    ...extra,
  });
  record(result);
  return result;
}

/**
 * Wait for `condition`, up to a second. QUIT is fire-and-forget (see `smtp.ts`
 * step 7), so it reaches the mock strictly after the probe resolves.
 */
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("the condition never became true within a second");
}

after(async () => {
  for (const server of mocks) await server.close();
  for (const value of captured) {
    assert.equal(value.includes(PASSWORD), false, "a captured string carried the SMTP password");
  }
});

// ---------------------------------------------------------------------------
// 1. What a probe does
// ---------------------------------------------------------------------------

test("a probe authenticates over STARTTLS, says QUIT, and sends no message", async () => {
  const server = await mock({ tls: "none", user: USER, password: PASSWORD });
  const result = await probe(server, { user: USER, password: PASSWORD });

  assert.equal(result.ok, true, `the probe failed: ${JSON.stringify(result)}`);
  if (!result.ok) return;
  assert.equal(result.secure, true, "the STARTTLS upgrade did not happen");
  assert.equal(result.authenticated, "PLAIN");
  assert.deepEqual(result.transcript, [
    "greeting 220",
    "EHLO 250",
    "STARTTLS 220",
    "EHLO 250",
    "AUTH 235",
  ]);

  const session = server.last();
  assert.ok(session !== undefined, "the mock served no session");
  await until(() => session.quit);

  assert.equal(session.authenticated, "PLAIN");
  assert.equal(session.commands.at(-1), "QUIT", `commands were ${JSON.stringify(session.commands)}`);
  assert.equal(session.mailFrom, null, "a probe issued MAIL FROM");
  assert.deepEqual(session.recipients, [], "a probe issued RCPT TO");
  assert.equal(
    session.commands.some((line) => line.toUpperCase().startsWith("DATA")),
    false,
    "a probe issued DATA",
  );
  assert.equal(
    session.commands.some((line) => line.toUpperCase().startsWith("MAIL")),
    false,
    "a probe issued MAIL FROM",
  );
  assert.equal(session.rawData, "", "a probe put message bytes on the wire");
  assert.equal(session.message, null);
});

test("a probe with no credential stops after EHLO and never sends AUTH", async () => {
  const server = await mock({ tls: "none" });
  const result = await probe(server, { security: "none" });

  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.authenticated, null);
  assert.equal(result.secure, false, "a plaintext session reported itself encrypted");
  assert.deepEqual(result.transcript, ["greeting 220", "EHLO 250"]);

  const session = server.last();
  assert.ok(session !== undefined);
  await until(() => session.quit);
  assert.equal(
    session.commands.some((line) => line.toUpperCase().startsWith("AUTH")),
    false,
    "a credential-free probe sent AUTH",
  );
  assert.equal(session.commands.at(-1), "QUIT");
});

test("a probe over implicit TLS is encrypted from the first byte", async () => {
  const server = await mock({ tls: "implicit", user: USER, password: PASSWORD });
  const result = await probe(server, { user: USER, password: PASSWORD });

  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.secure, true);
  assert.equal(result.authenticated, "PLAIN");

  const session = server.last();
  assert.ok(session !== undefined);
  assert.equal(
    session.commands.includes("STARTTLS"),
    false,
    "STARTTLS was issued on an already-encrypted session",
  );
});

// ---------------------------------------------------------------------------
// 2. The security properties, on the probe path
// ---------------------------------------------------------------------------

test("a server that does not advertise STARTTLS is a failure, never a downgrade", async () => {
  const server = await mock({
    tls: "none",
    advertiseStarttls: false,
    user: USER,
    password: PASSWORD,
  });
  const result = await probe(server, { user: USER, password: PASSWORD });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "smtp-tls-failed");
  assert.equal(result.secure, false);
  assert.match(result.message, /will not silently downgrade/u);

  const session = server.last();
  assert.ok(session !== undefined);
  assert.equal(
    session.commands.some((line) => line.toUpperCase().startsWith("AUTH")),
    false,
    "the credential was offered to a server that refused to encrypt the session",
  );
  assert.equal(session.presented, null, "a credential reached a plaintext session");
});

test('a credential is never offered on a session with security "none"', async () => {
  const server = await mock({ tls: "none", user: USER, password: PASSWORD });
  const result = await probe(server, { security: "none", user: USER, password: PASSWORD });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "smtp-tls-failed");

  const session = server.last();
  assert.ok(session !== undefined);
  assert.equal(session.presented, null, "a password went out over a cleartext socket");
});

test("bytes injected after the STARTTLS reply abandon the session", async () => {
  // The classic STARTTLS response-injection hole: a reply queued before the
  // handshake that a naive client would attribute to the encrypted session.
  const server = await mock({
    tls: "none",
    user: USER,
    password: PASSWORD,
    injectAfterStarttls: "250 injected-by-an-attacker",
  });
  const result = await probe(server, { user: USER, password: PASSWORD });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "smtp-protocol-error");
  assert.match(result.message, /injected by something that is not the TLS session/u);

  const session = server.last();
  assert.ok(session !== undefined);
  assert.equal(session.presented, null, "the credential was sent into an injected session");
});

// ---------------------------------------------------------------------------
// 3. The failure vocabulary, which is sendMail's
// ---------------------------------------------------------------------------

test("a refused AUTH is reported as its own reply code, after AUTH was attempted", async () => {
  const server = await mock({ tls: "none", user: USER, password: PASSWORD });
  server.failAt({ step: "auth", reply: "535 5.7.8 authentication failed" });
  const result = await probe(server, { user: USER, password: PASSWORD });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "smtp-535");
  assert.equal(result.secure, true, "the upgrade happened before AUTH was refused");
  assert.match(result.message, /^AUTH refused: 535 /u);

  const session = server.last();
  assert.ok(session !== undefined);
  assert.ok(
    session.commands.some((line) => line.startsWith("AUTH")),
    `AUTH was never attempted: ${JSON.stringify(session.commands)}`,
  );
  assert.equal(session.authenticated, null);
  assert.equal(session.mailFrom, null, "the probe carried on past a refused AUTH");
});

test("a server that quotes the password back has it scrubbed out of the failure", async () => {
  const server = await mock({ tls: "none", user: USER, password: PASSWORD });
  server.failAt({ step: "auth", reply: `535 5.7.8 rejected password ${PASSWORD} for ${USER}` });
  const result = await probe(server, { user: USER, password: PASSWORD });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "smtp-535");
  assert.equal(result.message.includes(PASSWORD), false, "the password survived into the message");
  assert.ok(
    result.message.includes(REDACTION_PLACEHOLDER),
    `the reply text was not scrubbed: ${result.message}`,
  );
});

test("a closed port is smtp-connect-failed", async () => {
  const dead = await startMockSmtp();
  assertLoopback(dead.host);
  const port = dead.port;
  await dead.close();

  const result = await probeSmtp({
    host: "127.0.0.1",
    port,
    security: "starttls",
    timeoutMs: 5_000,
    tlsRejectUnauthorized: false,
    redact: scrub,
  });
  record(result);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "smtp-connect-failed");
  assert.deepEqual(result.transcript, [], "a transcript was recorded for a session never opened");
});

test("a server that never answers EHLO is smtp-timeout", async () => {
  const server = await mock({ tls: "none", user: USER, password: PASSWORD });
  server.stallAt("ehlo");
  const result = await probe(server, { user: USER, password: PASSWORD, timeoutMs: 200 });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "smtp-timeout");
  assert.deepEqual(result.transcript, ["greeting 220"]);
});
