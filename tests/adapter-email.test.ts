/**
 * The email adapter (APRV-69) — `src/adapters/email.ts` and `src/adapters/smtp.ts`.
 *
 * Same discipline as every other suite here. Nothing hand-writes a log line: the
 * policy is attested through `core/attest.ts`, the task is registered and
 * requested through `core/gate.ts`, the grant is a real human decision, and the
 * token under test is the one that grant printed. Nothing hand-writes a vault
 * either — every credential was stored through `core/vault.ts`'s real write
 * path — and nothing contacts the network: every send goes to
 * `tests/smtp-mock.ts` on 127.0.0.1, asserted loopback before each adapter is
 * built.
 *
 * Two sweeps run over the whole suite rather than over one case, the pattern
 * `tests/cli-vault.test.ts` established:
 *
 * - every string this suite captured — every adapter result, every rendered
 *   message, every failure message — is scanned at the end for the SMTP
 *   password and the vault passphrase; and
 * - every log file any case wrote is scanned for the same values.
 *
 * A leak through a message nobody thought to assert on is exactly the shape of
 * failure SPEC.md §11.1 invariant 3 exists to prevent, so the scan is over
 * everything, not over the strings a test remembered to check.
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  executeThroughAdapter,
  type Adapter,
  type AdapterExecuteOptions,
  type AdapterExecuteResult,
  type JsonValue,
} from "../src/adapters/contract.js";
import { runAdapterConformance, type AdapterConformanceHarness } from "../src/adapters/conformance.js";
import {
  DEFAULT_CREDENTIAL_NAMES,
  EMAIL_CLASS,
  EMAIL_CREDENTIAL_SPECS,
  EMAIL_FAILURE_CODES,
  checkEmailCredentialSet,
  deterministicMessageId,
  emailAdapter,
  encodeHeaderValue,
  envelopeRecipients,
  isEmailFailureCode,
  quotedPrintable,
  renderEmailMessage,
  rfc5322Date,
  validateEmailPayload,
  type EmailPayload,
} from "../src/adapters/email.js";
import { SMTP_REPLY_CODE_PATTERN, dotStuff } from "../src/adapters/smtp.js";
import { vaultCredentialProvider } from "../src/adapters/vault-provider.js";
import { payloadHash } from "../src/core/payload.js";
import { setCredential, VAULT_FILENAME } from "../src/core/vault.js";
import { decide, register, request } from "./clock-adapters.js";
import { at, attest, fixedClock, newScenario, scratchRoot, T0 } from "./scenario.js";
import { assertLoopback, startMockSmtp, type MockSmtp } from "./smtp-mock.js";

const scratch = scratchRoot("adapter-email");

const TASK = "task-690";
const AGENT = "agent:sender";
const HUMAN = "human:carter";
/** Distinctive enough to hunt for in a log file, a JSON blob and a transcript. */
const SMTP_PASSWORD = "smtp-pw-aprv69-8f13ca-DO-NOT-USE";
const SMTP_USER = "chaser@approval.invalid";
const PASSPHRASE = "an operator-held passphrase for the email suite";
const PASS_ENV = "APPROVAL_TEST_EMAIL_PASSPHRASE";

/** Everything this suite captured. Swept for secrets in `after`. */
const transcript: string[] = [];
/** Every log this suite wrote. Swept too. */
const logs: string[] = [];

function record(value: unknown): void {
  transcript.push(typeof value === "string" ? value : JSON.stringify(value));
}

const POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "1h"',
  "  on_expiry: reject",
  "classes:",
  "  communicate.email.external:",
  "    autonomy: manual",
  "  financial.spend:",
  "    autonomy: manual",
  "vault:",
  `  passphrase_env: ${PASS_ENV}`,
  "```",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// The mocks. One plaintext+STARTTLS listener, one implicit-TLS listener.
// ---------------------------------------------------------------------------

const starttls = await startMockSmtp({
  tls: "none",
  user: SMTP_USER,
  password: SMTP_PASSWORD,
});
const implicit = await startMockSmtp({
  tls: "implicit",
  user: SMTP_USER,
  password: SMTP_PASSWORD,
});
/** A port with nothing behind it: this mock is started only to be closed. */
const closed = await startMockSmtp();
const DEAD_PORT = closed.port;
await closed.close();

after(async () => {
  await starttls.close();
  await implicit.close();

  const said = transcript.join("\n");
  for (const [label, needle] of [
    ["SMTP password", SMTP_PASSWORD],
    ["vault passphrase", PASSPHRASE],
  ] as const) {
    assert.equal(
      said.includes(needle),
      false,
      `the ${label} appeared in something this suite captured (SPEC.md §11.1 invariant 3)`,
    );
  }
  for (const logPath of logs) {
    const raw = readFileSync(logPath, "utf8");
    for (const needle of [SMTP_PASSWORD, PASSPHRASE]) {
      assert.equal(raw.includes(needle), false, `a secret reached ${logPath}`);
    }
  }

  scratch.cleanup();
});

// ---------------------------------------------------------------------------
// The scenario: a real grant, and a real vault beside it
// ---------------------------------------------------------------------------

interface Case {
  logPath: string;
  vaultPath: string;
  actionKey: string;
  payload: EmailPayload;
  token: string;
  options: AdapterExecuteOptions;
}

interface CaseOptions {
  payload?: EmailPayload;
  /** Which mock to point the vault at. Default the STARTTLS one. */
  mock?: MockSmtp;
  security?: string;
  /** Omit the login pair entirely. */
  anonymous?: boolean;
  /** Store only the user, so the pair is half-configured. */
  halfConfigured?: boolean;
  port?: number;
  cls?: string;
}

let counter = 0;

function payloadFor(index: number): EmailPayload {
  return {
    from: "carter@approval.invalid",
    to: [`agency-${String(index)}@vendor.invalid`],
    cc: ["records@approval.invalid"],
    bcc: ["archive@approval.invalid"],
    subject: `Deposit chaser ${String(index)}`,
    body: `Following up on the deposit.\nNo reply since 21 July.\n.a dot-led line\n`,
  };
}

/** A fresh log holding one granted, unspent manual action, plus its vault. */
function granted(setup: CaseOptions = {}): Case {
  counter += 1;
  const mock = setup.mock ?? starttls;
  assertLoopback(mock.host);

  const unit = newScenario(scratch.root, POLICY);
  attest(unit, T0);
  logs.push(unit.logPath);

  const cls = setup.cls ?? EMAIL_CLASS;
  const actionKey = `${TASK}:send-${String(counter)}:2026-08-18`;
  const payload = setup.payload ?? payloadFor(counter);

  const registered = register(
    unit.logPath,
    {
      task: TASK,
      envelope: {
        origin: { app: "manual", created_by: AGENT },
        state: "awaiting",
        actions: [
          {
            class: cls,
            idempotency_key: actionKey,
            summary: `chase deposit ${String(counter)}`,
            reversible: false,
            est_cost_usd: 0.02,
            payload_hash: payloadHash(payload),
          },
        ],
      },
    },
    T0,
    AGENT,
    unit.options,
  );
  assert.equal(registered.ok, true, `registration failed: ${JSON.stringify(registered)}`);

  const requested = request(
    unit.logPath,
    {
      task: TASK,
      actionKey,
      cls,
      est_cost_usd: 0.02,
      reversible: false,
      summary: `chase deposit ${String(counter)}`,
    },
    at(1),
    AGENT,
    unit.options,
  );
  assert.equal(requested.ok, true, `request failed: ${JSON.stringify(requested)}`);

  const decided = decide(unit.logPath, actionKey, "grant", HUMAN, at(2), unit.options);
  assert.equal(decided.ok, true, `grant failed: ${JSON.stringify(decided)}`);
  if (!decided.ok || decided.token === undefined) throw new Error("expected a token");

  const home = join(unit.dir, ".approval");
  mkdirSync(home, { recursive: true });
  const vaultPath = join(home, VAULT_FILENAME);

  const stored: Record<string, string> = {
    [DEFAULT_CREDENTIAL_NAMES.host]: mock.host,
    [DEFAULT_CREDENTIAL_NAMES.port]: String(setup.port ?? mock.port),
    [DEFAULT_CREDENTIAL_NAMES.security]:
      setup.security ?? (mock.implicitTls ? "implicit" : "starttls"),
  };
  if (setup.anonymous !== true) {
    stored[DEFAULT_CREDENTIAL_NAMES.user] = SMTP_USER;
    if (setup.halfConfigured !== true) {
      stored[DEFAULT_CREDENTIAL_NAMES.password] = SMTP_PASSWORD;
    }
  }
  for (const [name, value] of Object.entries(stored)) {
    const written = setCredential(vaultPath, PASSPHRASE, name, value);
    assert.equal(written.ok, true, `vault setup failed: ${JSON.stringify(written)}`);
  }

  return {
    logPath: unit.logPath,
    vaultPath,
    actionKey,
    payload,
    token: decided.token,
    options: { policy: { file: unit.policyPath }, clock: fixedClock(at(3)) },
  };
}

/** The send moment. Fixed, so the rendered Date is assertable. */
const SENT_AT = new Date(Date.parse("2026-08-18T09:14:02.000Z"));

function adapterFor(extra: Parameters<typeof emailAdapter>[0] = {}): Adapter {
  return emailAdapter({
    clock: () => SENT_AT,
    // The mock holds the self-signed fixture certificate. See its README:
    // this is the ONLY sanctioned false, and the default is pinned below.
    tlsRejectUnauthorized: false,
    timeoutMs: 5_000,
    ...extra,
  });
}

function providerFor(unit: Case) {
  return vaultCredentialProvider(
    { vaultPath: unit.vaultPath },
    { passphraseEnv: PASS_ENV, env: { [PASS_ENV]: PASSPHRASE } },
  );
}

async function run(
  unit: Case,
  adapter: Adapter = adapterFor(),
  overrides: Partial<AdapterExecuteOptions> = {},
  payload: JsonValue = unit.payload as unknown as JsonValue,
): Promise<AdapterExecuteResult> {
  const result = await executeThroughAdapter(
    adapter,
    { logPath: unit.logPath, actionKey: unit.actionKey, payload, actor: AGENT },
    { ...unit.options, token: unit.token, credentials: providerFor(unit), ...overrides },
  );
  record(result);
  return result;
}

/**
 * Wait for `condition`, up to a second.
 *
 * QUIT is the one thing the adapter sends and does not wait for a reply to (see
 * `smtp.ts`: the message is already accepted, and a failed goodbye must not turn
 * a delivered message into a failed execution). So it arrives at the mock
 * strictly after `act` returns, and asserting on it synchronously would be
 * asserting on a race rather than on the protocol.
 */
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("the condition never became true within a second");
}

function eventsOf(logPath: string): string[] {
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as { event: string }).event);
}

// ---------------------------------------------------------------------------
// 1. The happy paths
// ---------------------------------------------------------------------------

test("a granted send puts exactly the approved bytes on the wire over STARTTLS", async () => {
  const unit = granted();
  const result = await run(unit);
  assert.equal(result.ok, true, `the granted send was refused: ${JSON.stringify(result)}`);

  const session = starttls.last();
  assert.ok(session !== undefined, "the mock served no session");
  record(session.message ?? "");

  // The DATA bytes ARE the adapter's rendering of the approved payload.
  const expected = renderEmailMessage(unit.payload, {
    date: SENT_AT,
    messageId: deterministicMessageId(
      unit.actionKey,
      payloadHash(unit.payload),
      unit.payload.from,
    ),
  });
  assert.equal(session.message, expected, "the wire message is not the adapter's rendering");

  // The envelope names to + cc + bcc, once each, in that order.
  assert.deepEqual(session.recipients, envelopeRecipients(unit.payload));
  assert.equal(session.mailFrom, unit.payload.from);

  // Bcc is in the envelope and in NO header.
  assert.match(session.message, /^To: agency-\d+@vendor\.invalid\r\n/mu);
  assert.match(session.message, /^Cc: records@approval\.invalid\r\n/mu);
  assert.equal(/^Bcc:/mu.test(session.message), false, "a Bcc header reached the wire");
  assert.ok(session.recipients.includes("archive@approval.invalid"));

  // The stamped, non-payload fields.
  assert.match(session.message, /^Date: Tue, 18 Aug 2026 09:14:02 \+0000\r\n/mu);
  assert.match(session.message, /^Message-ID: <[0-9a-f]{40}@approval\.invalid>\r\n/mu);
  assert.match(session.message, /^Content-Transfer-Encoding: 8bit\r\n/mu);

  // Dot-stuffing happened on the wire and not in the message.
  assert.ok(session.rawData.includes("\r\n..a dot-led line\r\n"), "the dot line was not stuffed");
  assert.ok(session.message.includes("\r\n.a dot-led line\r\n"), "the message was altered");

  assert.equal(session.secure, true, "the session was not upgraded to TLS");
  assert.equal(session.authenticated, "PLAIN");
  await until(() => session.quit);
  assert.ok(session.commands.includes("STARTTLS"));

  assert.deepEqual(eventsOf(unit.logPath), [
    "policy.updated",
    "task.registered",
    "approval.requested",
    "approval.granted",
    "execution.started",
    "execution.completed",
  ]);
  if (result.ok) {
    assert.equal(result.payload_hash, payloadHash(unit.payload));
    assert.deepEqual((result.detail as Record<string, unknown>)["auth"], "PLAIN");
    assert.deepEqual((result.detail as Record<string, unknown>)["smtp_code"], 250);
  }
});

test("implicit TLS is spoken from the first byte, with no STARTTLS", async () => {
  const unit = granted({ mock: implicit });
  const result = await run(unit);
  assert.equal(result.ok, true, JSON.stringify(result));

  const session = implicit.last();
  assert.ok(session !== undefined);
  assert.equal(session.secure, true);
  assert.equal(
    session.commands.includes("STARTTLS"),
    false,
    "STARTTLS was issued on an already-encrypted session",
  );
  assert.equal(session.authenticated, "PLAIN");
  assert.equal(eventsOf(unit.logPath).at(-1), "execution.completed");
});

test("AUTH LOGIN is the fallback when the server offers no PLAIN", async () => {
  const loginOnly = await startMockSmtp({
    tls: "implicit",
    advertiseAuth: ["LOGIN"],
    user: SMTP_USER,
    password: SMTP_PASSWORD,
  });
  try {
    const unit = granted({ mock: loginOnly });
    const result = await run(unit);
    assert.equal(result.ok, true, JSON.stringify(result));
    const session = loginOnly.last();
    assert.ok(session !== undefined);
    assert.equal(session.authenticated, "LOGIN");
    assert.deepEqual(session.presented, { user: SMTP_USER, password: SMTP_PASSWORD });
  } finally {
    await loginOnly.close();
  }
});

test("a vault holding no login pair sends unauthenticated", async () => {
  const open = await startMockSmtp({ tls: "implicit", advertiseAuth: [] });
  try {
    const unit = granted({ mock: open, anonymous: true });
    const result = await run(unit);
    assert.equal(result.ok, true, JSON.stringify(result));
    const session = open.last();
    assert.equal(session?.authenticated, null);
    assert.equal(session?.presented, null);
  } finally {
    await open.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Failures reach the log as execution.failed, carrying the reply code only
// ---------------------------------------------------------------------------

test("an authentication failure is smtp-535 and carries no credential", async () => {
  const hostile = await startMockSmtp({
    tls: "implicit",
    user: "someone-else@vendor.invalid",
    password: "not the stored password",
  });
  try {
    const unit = granted({ mock: hostile });
    const result = await run(unit);

    assert.equal(result.ok, false, "a refused login must not report a completed send");
    if (!result.ok) {
      assert.equal(result.code, "adapter-failed");
      assert.equal(result.adapter_code, "smtp-535");
      assert.equal(result.acted, true, "the send was attempted and the log must say so");
      assert.equal(result.outcome, "execution.failed");
      assert.match(result.message, /^AUTH refused: 535 /u);
      assert.equal(result.message.includes(SMTP_PASSWORD), false);
      assert.equal(result.message.includes(PASSPHRASE), false);
    }
    assert.equal(eventsOf(unit.logPath).at(-1), "execution.failed");
    assert.equal(readFileSync(unit.logPath, "utf8").includes(SMTP_PASSWORD), false);
    assert.equal(hostile.last()?.message, null, "a message was handed over after a failed login");
  } finally {
    await hostile.close();
  }
});

test("a server that quotes the credential back has it scrubbed from the message", async () => {
  const echoing = await startMockSmtp({ tls: "implicit" });
  echoing.failAt({ step: "auth", reply: `535 5.7.8 rejected ${SMTP_PASSWORD} for that mailbox` });
  try {
    const unit = granted({ mock: echoing });
    const result = await run(unit);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.adapter_code, "smtp-535");
      assert.equal(
        result.message.includes(SMTP_PASSWORD),
        false,
        "the server's reply carried the credential straight through the adapter",
      );
      assert.match(result.message, /\[redacted\]/u);
      // The ADAPTER scrubbed it, which is why the contract's own counter is 0:
      // by the time the contract scanned the message there was nothing left to
      // find. Two independent scrubs, and the outer one is not load-bearing.
      assert.equal(result.redactions, 0, "the adapter did not scrub its own diagnostic");
    }
    assert.equal(readFileSync(unit.logPath, "utf8").includes(SMTP_PASSWORD), false);
  } finally {
    await echoing.close();
  }
});

test("a refused recipient is smtp-550 and the message is never handed over", async () => {
  const refusing = await startMockSmtp({ tls: "implicit", user: SMTP_USER, password: SMTP_PASSWORD });
  refusing.failAt({ step: "rcpt", reply: "550 5.1.1 mailbox unavailable" });
  try {
    const unit = granted({ mock: refusing });
    const result = await run(unit);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.adapter_code, "smtp-550");
      assert.match(result.message, /^RCPT TO refused: 550 5\.1\.1 mailbox unavailable$/u);
      assert.equal(result.outcome, "execution.failed");
    }
    assert.equal(refusing.last()?.message, null, "DATA ran after a refused recipient");
    assert.equal(eventsOf(unit.logPath).at(-1), "execution.failed");
  } finally {
    await refusing.close();
  }
});

test("a refused end-of-data is reported against the message step", async () => {
  const full = await startMockSmtp({ tls: "implicit", user: SMTP_USER, password: SMTP_PASSWORD });
  full.failAt({ step: "end-of-data", reply: "452 4.2.2 mailbox full" });
  try {
    const unit = granted({ mock: full });
    const result = await run(unit);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.adapter_code, "smtp-452");
      assert.match(result.message, /^message refused: 452 /u);
    }
  } finally {
    await full.close();
  }
});

test("nothing listening is smtp-connect-failed, recorded as a failed execution", async () => {
  const unit = granted({ port: DEAD_PORT, security: "starttls" });
  const result = await run(unit);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.adapter_code, "smtp-connect-failed");
    // The address is not quoted back: it came from the vault, so the contract
    // would redact it. The message names the CREDENTIAL instead.
    assert.match(result.message, /could not connect to the SMTP host named by smtp\.host/u);
    assert.equal(result.outcome, "execution.failed");
  }
  assert.equal(eventsOf(unit.logPath).at(-1), "execution.failed");
});

test("a stalling server becomes smtp-timeout rather than a hung execution", async () => {
  const slow = await startMockSmtp({ tls: "implicit" });
  slow.stallAt("greeting");
  try {
    const unit = granted({ mock: slow });
    const result = await run(unit, adapterFor({ timeoutMs: 300 }));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.adapter_code, "smtp-timeout");
      assert.match(result.message, /exceeded its 300ms budget/u);
      assert.equal(result.outcome, "execution.failed", "a timeout left a dangling execution");
    }
  } finally {
    await slow.close();
  }
});

test("a server that will not offer STARTTLS is a failure, never a silent downgrade", async () => {
  const plaintext = await startMockSmtp({ tls: "none", advertiseStarttls: false });
  try {
    const unit = granted({ mock: plaintext, security: "starttls" });
    const result = await run(unit);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.adapter_code, "smtp-tls-failed");
      assert.match(result.message, /does not advertise STARTTLS/u);
    }
    assert.equal(plaintext.last()?.message, null, "a message went out in plaintext");
  } finally {
    await plaintext.close();
  }
});

test("a credential is never sent over a cleartext session", async () => {
  const plaintext = await startMockSmtp({ tls: "none", user: SMTP_USER, password: SMTP_PASSWORD });
  try {
    const unit = granted({ mock: plaintext, security: "none" });
    const result = await run(unit);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.adapter_code, "smtp-tls-failed");
      assert.match(result.message, /will not send a password over a cleartext socket/u);
    }
    assert.equal(plaintext.last()?.presented, null, "the password went out in the clear");
  } finally {
    await plaintext.close();
  }
});

test("the TLS verification default is strict, and the mock's fixture certificate is refused", async () => {
  const unit = granted({ mock: implicit });
  // No tlsRejectUnauthorized override: the production default must reject the
  // self-signed fixture. A default that quietly accepted it would make every
  // other test in this file meaningless.
  const strict = emailAdapter({ clock: () => SENT_AT, timeoutMs: 5_000 });
  const result = await run(unit, strict);
  assert.equal(result.ok, false, "the strict default accepted a self-signed certificate");
  if (!result.ok) assert.equal(result.adapter_code, "smtp-tls-failed");
});

// ---------------------------------------------------------------------------
// 3. Configuration refusals: nothing is connected to
// ---------------------------------------------------------------------------

test("a payload that is not a well-formed email refuses before any connection", async () => {
  const before = starttls.connections;
  const badPayload = { from: "carter@approval.invalid", to: [], subject: "x", body: "y" };
  const unit = granted({ payload: badPayload as unknown as EmailPayload });
  const result = await run(unit);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.adapter_code, "email-payload-invalid");
    assert.match(result.message, /to must be a non-empty array/u);
  }
  assert.equal(starttls.connections, before, "a malformed payload opened a socket");
});

test("an unknown payload key is refused rather than silently dropped", () => {
  const outcome = validateEmailPayload({
    from: "a@b.invalid",
    to: ["c@d.invalid"],
    subject: "s",
    body: "b",
    attachments: ["invoice.pdf"],
  } as unknown as JsonValue);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.message, /"attachments".*does not implement/su);
});

test("half a login pair is email-config-invalid and connects to nothing", async () => {
  const before = starttls.connections;
  const unit = granted({ halfConfigured: true });
  const result = await run(unit);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.adapter_code, "email-config-invalid");
    assert.match(result.message, /An SMTP login needs both/u);
  }
  assert.equal(starttls.connections, before, "a half-configured vault opened a socket");
});

test("an unusable transport setting is email-config-invalid", async () => {
  const before = starttls.connections;
  const unit = granted({ security: "sort-of-encrypted" });
  const result = await run(unit);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.adapter_code, "email-config-invalid");
    assert.match(result.message, /will not guess a transport security setting/u);
  }
  assert.equal(starttls.connections, before);
});

test("a port the vault holds as nonsense is email-config-invalid", async () => {
  const unit = granted({ port: 99_999 });
  const result = await run(unit);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.adapter_code, "email-config-invalid");
    assert.match(result.message, /not a TCP port number/u);
  }
});

test("no vault at all is credential-unavailable, and nothing is sent", async () => {
  const before = starttls.connections;
  const unit = granted();
  const result = await run(unit, adapterFor(), {
    credentials: vaultCredentialProvider(
      { vaultPath: join(scratch.root, "no-such-vault.enc") },
      { passphraseEnv: PASS_ENV, env: { [PASS_ENV]: PASSPHRASE } },
    ),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.adapter_code, "credential-unavailable");
    assert.equal(result.outcome, "execution.failed");
  }
  assert.equal(starttls.connections, before);
});

// ---------------------------------------------------------------------------
// 4. The gate refuses BEFORE act: no socket is opened at all
// ---------------------------------------------------------------------------

test("a payload the grant did not bind to opens zero connections", async () => {
  const unit = granted();
  const before = starttls.connections;
  const tampered = { ...unit.payload, body: "a body no human approved" };

  const result = await run(unit, adapterFor(), {}, tampered as unknown as JsonValue);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "payload-mismatch");
    assert.equal(result.acted, false);
  }
  assert.equal(
    starttls.connections,
    before,
    "the adapter connected on bytes the contract had already refused",
  );

  // The token is still live: the repair is a new request for the new payload.
  const good = await run(unit);
  assert.equal(good.ok, true, `payload-mismatch consumed the token: ${JSON.stringify(good)}`);
});

test("a consumed token opens zero connections on the replay", async () => {
  const unit = granted();
  const first = await run(unit);
  assert.equal(first.ok, true, JSON.stringify(first));

  const before = starttls.connections;
  const second = await run(unit);
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.ok(
      second.code === "token-consumed" || second.code === "already-executed",
      `a replay must refuse token-consumed or already-executed, got ${second.code}`,
    );
    assert.equal(second.acted, false);
  }
  assert.equal(starttls.connections, before, "a replayed idempotency key sent a second message");
});

test("a bad token opens zero connections", async () => {
  const unit = granted();
  const before = starttls.connections;
  const result = await run(unit, adapterFor(), { token: "not-the-token" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "token-mismatch");
  assert.equal(starttls.connections, before);
});

test("an action declared under another class opens zero connections", async () => {
  const unit = granted({ cls: "financial.spend" });
  const before = starttls.connections;
  const result = await run(unit);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "adapter-class-mismatch");
    assert.equal(result.acted, false);
  }
  assert.equal(starttls.connections, before);
});

// ---------------------------------------------------------------------------
// 5. The shared conformance suite, against the real adapter
// ---------------------------------------------------------------------------

const CONFORMANCE: AdapterConformanceHarness = {
  setup: () => {
    const unit = granted({ mock: implicit });
    return {
      logPath: unit.logPath,
      actionKey: unit.actionKey,
      payload: unit.payload as unknown as JsonValue,
      token: unit.token,
      actor: AGENT,
      class: EMAIL_CLASS,
      options: unit.options,
    };
  },
  // The one the suite hunts for in the log and in every field of the result.
  credential: { name: DEFAULT_CREDENTIAL_NAMES.password, value: SMTP_PASSWORD },
  // The rest of what a real adapter needs to reach its far side.
  get credentials() {
    return {
      [DEFAULT_CREDENTIAL_NAMES.host]: implicit.host,
      [DEFAULT_CREDENTIAL_NAMES.port]: String(implicit.port),
      [DEFAULT_CREDENTIAL_NAMES.security]: "implicit",
      [DEFAULT_CREDENTIAL_NAMES.user]: SMTP_USER,
    };
  },
  foreignClass: "financial.spend",
};

test("the email adapter conforms to the adapter contract", async (t) => {
  await runAdapterConformance(t, () => adapterFor(), CONFORMANCE);
});

// ---------------------------------------------------------------------------
// 6. Rendering, in isolation
// ---------------------------------------------------------------------------

test("a non-ASCII body is quoted-printable and a non-ASCII subject is an encoded-word", async () => {
  const payload: EmailPayload = {
    from: "carter@approval.invalid",
    to: ["agency@vendor.invalid"],
    subject: "Dépôt de £1,200 — relance",
    body: "The deposit of £1,200 is overdue.\nRégime: protection scheme.\n",
  };
  const unit = granted({ mock: implicit, payload });
  const result = await run(unit);
  assert.equal(result.ok, true, JSON.stringify(result));

  const message = implicit.last()?.message ?? "";
  record(message);
  assert.match(message, /^Content-Transfer-Encoding: quoted-printable\r\n/mu);
  assert.match(message, /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/mu);
  // £ is U+00A3, which is C2 A3 in UTF-8.
  assert.ok(message.includes("=C2=A31,200"), `the pound sign was not encoded: ${message}`);
  // And the whole message is 7-bit clean, which is the point of the encoding.
  assert.equal(
    [...message].some((character) => (character.codePointAt(0) ?? 0) > 0x7f),
    false,
    "a raw non-ASCII byte reached the wire",
  );

  // The subject decodes back to what the human approved.
  const encoded = /^Subject: (.*)$/mu.exec(message)?.[1] ?? "";
  const decoded = encoded
    .split("?=")
    .filter((part) => part.includes("?B?"))
    .map((part) => Buffer.from(part.slice(part.indexOf("?B?") + 3), "base64").toString("utf8"))
    .join("");
  assert.equal(decoded, payload.subject);
});

test("quotedPrintable encodes trailing whitespace, = and long lines", () => {
  assert.equal(quotedPrintable("a=b"), "a=3Db");
  assert.equal(quotedPrintable("trailing "), "trailing=20");
  assert.equal(quotedPrintable("trailing\t"), "trailing=09");
  assert.equal(quotedPrintable("one\ntwo"), "one\r\ntwo");
  assert.equal(quotedPrintable("one\r\ntwo"), "one\r\ntwo");
  for (const line of quotedPrintable("x".repeat(300)).split("\r\n")) {
    assert.ok(line.length <= 76, `a quoted-printable line ran to ${String(line.length)}`);
  }
  // A soft break never splits an =XX triplet.
  const wrapped = quotedPrintable("é".repeat(80)).split("\r\n");
  for (const [index, line] of wrapped.entries()) {
    const soft = index < wrapped.length - 1;
    assert.equal(line.endsWith("="), soft, `line ${String(index)} has the wrong soft break`);
    const content = soft ? line.slice(0, -1) : line;
    assert.equal(/=[0-9A-F]?$/u.test(content), false, `a triplet was split: ${line}`);
  }
});

test("encodeHeaderValue leaves ASCII alone and folds long encoded-words", () => {
  assert.equal(encodeHeaderValue("plain ascii subject"), "plain ascii subject");
  const long = encodeHeaderValue("é".repeat(200));
  for (const word of long.split("\r\n ")) {
    assert.ok(word.length <= 75, `an encoded-word ran to ${String(word.length)}`);
    assert.match(word, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/u);
  }
});

test("rfc5322Date is UTC and RFC 5322 shaped", () => {
  assert.equal(rfc5322Date(new Date(Date.parse("2026-01-05T00:00:00Z"))), "Mon, 05 Jan 2026 00:00:00 +0000");
  assert.equal(rfc5322Date(SENT_AT), "Tue, 18 Aug 2026 09:14:02 +0000");
});

test("the Message-ID is deterministic and reproducible from the log", () => {
  const key = "task-042:chaser:2026-08-04";
  const hash = payloadHash({ to: ["a@b.invalid"] });
  const first = deterministicMessageId(key, hash, "carter@approval.invalid");
  assert.equal(first, deterministicMessageId(key, hash, "carter@approval.invalid"));
  assert.match(first, /^<[0-9a-f]{40}@approval\.invalid>$/u);
  // Different bytes under the same key produce a different id, and vice versa.
  assert.notEqual(first, deterministicMessageId(key, payloadHash({ to: [] }), "carter@approval.invalid"));
  assert.notEqual(first, deterministicMessageId(`${key}x`, hash, "carter@approval.invalid"));
});

test("dot-stuffing is transport framing and not part of the message", () => {
  assert.equal(dotStuff(".hello\r\n"), "..hello\r\n");
  assert.equal(dotStuff("a\r\n.\r\nb\r\n"), "a\r\n..\r\nb\r\n");
  assert.equal(dotStuff("no dots"), "no dots\r\n");
});

test("renderEmailMessage omits an empty Cc and always ends with CRLF", () => {
  const message = renderEmailMessage(
    { from: "a@b.invalid", to: ["c@d.invalid"], cc: [], subject: "s", body: "b" },
    { date: SENT_AT, messageId: "<x@b.invalid>" },
  );
  assert.equal(/^Cc:/mu.test(message), false);
  assert.ok(message.endsWith("\r\n"));
  assert.ok(message.includes("\r\n\r\nb\r\n"), "the header/body separator is wrong");
});

test("a long recipient list is folded rather than sent as one enormous line", () => {
  const to = Array.from({ length: 12 }, (_, index) => `recipient-${String(index)}@vendor.invalid`);
  const message = renderEmailMessage(
    { from: "a@b.invalid", to, subject: "s", body: "b" },
    { date: SENT_AT, messageId: "<x@b.invalid>" },
  );
  for (const line of message.split("\r\n")) {
    assert.ok(line.length <= 998, "a header line exceeded RFC 5322's limit");
  }
  for (const line of message.split("\r\n")) assert.ok(line.length <= 78, `unfolded: ${line}`);
  assert.match(message, /^To: recipient-0@vendor\.invalid, recipient-1@vendor\.invalid,\r\n recipient-2@/mu);
});

// ---------------------------------------------------------------------------
// 7. Validation, and the frozen vocabulary
// ---------------------------------------------------------------------------

test("validateEmailPayload refuses everything that is not a plain ASCII mailbox", () => {
  const base = { from: "a@b.invalid", to: ["c@d.invalid"], subject: "s", body: "b" };
  const cases: [string, unknown, RegExp][] = [
    ["not an object", "just a string", /must be a JSON object/u],
    ["an array", [1, 2], /must be a JSON object/u],
    ["no from", { ...base, from: "" }, /from must be a non-empty string/u],
    ["a display name", { ...base, from: '"C" <a@b.invalid>' }, /no display name/u],
    ["an internationalized address", { ...base, to: ["søren@b.invalid"] }, /SMTPUTF8/u],
    ["a header injection", { ...base, subject: "hi\r\nBcc: evil@x.invalid" }, /CR or LF/u],
    ["a non-string body", { ...base, body: 42 }, /body must be a string/u],
    ["a cc that is not a list", { ...base, cc: "c@d.invalid" }, /must be an array/u],
    ["an unknown content type", { ...base, content_type: "text/markdown" }, /content_type/u],
  ];
  for (const [label, value, pattern] of cases) {
    const outcome = validateEmailPayload(value as JsonValue);
    assert.equal(outcome.ok, false, `${label} was accepted`);
    if (!outcome.ok) assert.match(outcome.message, pattern, label);
  }

  const good = validateEmailPayload({ ...base, content_type: "text/html" } as unknown as JsonValue);
  assert.equal(good.ok, true, JSON.stringify(good));
});

test("envelopeRecipients is to, then cc, then bcc", () => {
  assert.deepEqual(
    envelopeRecipients({
      from: "a@b.invalid",
      to: ["t@x.invalid"],
      cc: ["c@x.invalid"],
      bcc: ["b@x.invalid"],
      subject: "s",
      body: "b",
    }),
    ["t@x.invalid", "c@x.invalid", "b@x.invalid"],
  );
});

test("the email failure union is frozen and the reply-code family is a pattern", () => {
  assert.deepEqual(
    [...EMAIL_FAILURE_CODES],
    [
      "email-payload-invalid",
      "email-config-invalid",
      "credential-unavailable",
      "credential-refused",
      "credential-window-closed",
      "smtp-connect-failed",
      "smtp-tls-failed",
      "smtp-timeout",
      "smtp-protocol-error",
    ],
    "the email failure union changed; it is frozen public API and additive only",
  );
  assert.equal(new Set(EMAIL_FAILURE_CODES).size, EMAIL_FAILURE_CODES.length);
  for (const code of ["smtp-535", "smtp-550", "smtp-250"]) {
    assert.ok(isEmailFailureCode(code), `${code} is not recognized`);
    assert.match(code, SMTP_REPLY_CODE_PATTERN);
  }
  assert.equal(isEmailFailureCode("smtp-99"), false);
  assert.equal(isEmailFailureCode("whatever"), false);
});

test("options.classes adds to the canonical class rather than replacing it", () => {
  const plain = emailAdapter();
  assert.deepEqual(plain.classes, [EMAIL_CLASS]);
  assert.equal(plain.name, "email");

  const wider = emailAdapter({ classes: ["communicate.email.internal", EMAIL_CLASS] });
  assert.deepEqual(wider.classes, [EMAIL_CLASS, "communicate.email.internal"]);
});

// ===========================================================================
// The credential manifest (APRV-78)
// ===========================================================================

test("the manifest declares exactly the names `act` reads, key for key", () => {
  const declared = EMAIL_CREDENTIAL_SPECS.map((spec) => spec.name);
  // Not "the same set of strings": the same names against the same keys. A
  // manifest that drifted from DEFAULT_CREDENTIAL_NAMES would be a setup verb
  // filling a vault this adapter cannot read, and the failure would arrive at
  // send time as `credential-unavailable` for a credential the operator watched
  // themselves store.
  assert.deepEqual([...declared].sort(), Object.values(DEFAULT_CREDENTIAL_NAMES).sort());
  for (const [key, name] of Object.entries(DEFAULT_CREDENTIAL_NAMES)) {
    const spec = EMAIL_CREDENTIAL_SPECS.find((candidate) => candidate.name === name);
    assert.ok(spec !== undefined, `no spec declares ${key} (${name})`);
  }

  // The shape the flow depends on: the secret is LAST, so a write that fails
  // half way has not already consumed the one value nobody wants to retype; the
  // password is the only secret; and no secret carries a default.
  assert.equal(declared[declared.length - 1], DEFAULT_CREDENTIAL_NAMES.password);
  assert.deepEqual(
    EMAIL_CREDENTIAL_SPECS.filter((spec) => spec.kind === "secret").map((spec) => spec.name),
    [DEFAULT_CREDENTIAL_NAMES.password],
  );
  for (const spec of EMAIL_CREDENTIAL_SPECS) {
    if (spec.kind === "secret") assert.equal(spec.default, undefined);
  }

  const security = EMAIL_CREDENTIAL_SPECS.find(
    (spec) => spec.name === DEFAULT_CREDENTIAL_NAMES.security,
  );
  assert.deepEqual(
    (security?.choices ?? []).map((choice) => choice.value),
    ["implicit", "starttls", "none"],
  );
  assert.equal(security?.default, "starttls");
});

test("the manifest's validation refuses in the same words `act` refuses in", () => {
  const port = EMAIL_CREDENTIAL_SPECS.find((spec) => spec.name === DEFAULT_CREDENTIAL_NAMES.port);
  const rejected = port?.validate?.("70000");
  assert.equal(rejected?.ok, false);
  assert.equal(
    rejected?.ok === false ? rejected.message : "",
    `the vault's ${DEFAULT_CREDENTIAL_NAMES.port} is not a TCP port number (1-65535)`,
  );
  assert.equal(port?.validate?.("587").ok, true);

  const host = EMAIL_CREDENTIAL_SPECS.find((spec) => spec.name === DEFAULT_CREDENTIAL_NAMES.host);
  assert.equal(host?.validate?.("").ok, false);
  assert.equal(host?.validate?.("smtp example net").ok, false);
  assert.equal(host?.validate?.("smtp.example.net").ok, true);

  const security = EMAIL_CREDENTIAL_SPECS.find(
    (spec) => spec.name === DEFAULT_CREDENTIAL_NAMES.security,
  );
  assert.equal(security?.validate?.("tls").ok, false);
  assert.equal(security?.validate?.("starttls").ok, true);
});

test("checkEmailCredentialSet is the both-or-neither rule, and `act` calls this one", () => {
  const { user, password } = DEFAULT_CREDENTIAL_NAMES;
  assert.equal(checkEmailCredentialSet({}), null);
  assert.equal(checkEmailCredentialSet({ [user]: "u", [password]: "p" }), null);
  // Empty is absent: `setCredential` refuses an empty value, so "" can only
  // ever mean "not given".
  assert.equal(checkEmailCredentialSet({ [user]: "", [password]: "" }), null);

  const half = checkEmailCredentialSet({ [user]: "u" });
  assert.match(half ?? "", new RegExp(`the vault holds ${user} but not ${password}`, "u"));
  assert.match(half ?? "", /An SMTP login needs both/u);

  const other = checkEmailCredentialSet({ [password]: "p" });
  assert.match(other ?? "", new RegExp(`the vault holds ${password} but not ${user}`, "u"));
});
