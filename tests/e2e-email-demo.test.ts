/**
 * The M7 end-to-end demo (APRV-70) — SPEC.md §1's promise, with a real send at
 * the end of it.
 *
 * `tests/e2e-demo.test.ts` (APRV-27) walked the same story to the point where a
 * token was spent on `echo`. This one walks it to the point where a message
 * leaves the machine: an agent drafts SPEC.md §6.1's deposit chaser, the request
 * reaches a phone over Telegram, a thumb taps Approve, and the token that grant
 * minted is spent by `approval adapter email`, which reads an SMTP password out
 * of the encrypted vault, opens a STARTTLS session, authenticates, and sends the
 * exact bytes the human approved.
 *
 * The rules are the ones APRV-27 set, and one more.
 *
 * **Everything is driven through the CLI as a child process.** `approval init`,
 * `policy attest`, `vault set`, `payload hash`, `register`, `request`, `channel
 * telegram listen`, `policy test`, `adapter email`, `log tail`, `log verify`.
 * Core is imported for three pure functions only — {@link payloadHash},
 * {@link renderEmailMessage} and {@link deterministicMessageId} — and every one
 * of them is used to *check* what the CLI did, never to do a step.
 *
 * **Nothing touches a network.** The Bot API is `tests/telegram-mock.ts` and the
 * SMTP server is `tests/smtp-mock.ts`, both on loopback, both asserted so by
 * {@link assertLocal} and {@link assertLoopback} before anything is handed to a
 * child.
 *
 * **The secrets are hunted for at the end, everywhere.** Every byte the CLI
 * printed across every hop, every byte of the log, and every body the Bot API
 * mock received are scanned for the SMTP password, the vault passphrase, the
 * SMTP username and the raw execution token. The token has exactly one
 * sanctioned appearance in that corpus — the listener's own stdout, at the
 * moment of the grant — and the scan asserts that it is the only one.
 *
 * ## The one thing here that a real deployment does differently
 *
 * The adapter verifies TLS certificates and there is deliberately no CLI flag
 * that relaxes that (`tests/cli-adapter.test.ts` explains why, and
 * `tests/adapter-email.test.ts` pins the default). So the demo does what an
 * operator with a private CA would do: it hands the child `NODE_EXTRA_CA_CERTS`
 * pointing at the committed self-signed fixture in `tests/fixtures/smtp/`. That
 * is an environment-level trust decision made outside the runtime, which is
 * exactly what it would be in production, and it lets this demo exercise the
 * path a real operator walks — `smtp.security: "starttls"` with a real
 * `AUTH PLAIN` carrying a real password out of the vault — rather than the
 * cleartext relay the CLI adapter suite has to settle for.
 *
 * The real-network twin of this script is `examples/email-demo.md`.
 *
 * Structured as one test with ordered subtests, so a failure names the hop.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  deterministicMessageId,
  renderEmailMessage,
  type EmailPayload,
} from "../src/adapters/email.js";
import { payloadHash } from "../src/core/payload.js";
import {
  commandSetup,
  type KeystoreKind,
  type KeystoreRunner,
  type SetupDeps,
  type StoreOutcome,
} from "../src/cli/setup.js";
import type { Prompter, SecretRead } from "../src/cli/prompt.js";
import type { Streams } from "../src/cli/main.js";
import type { TelegramFetch } from "../src/channels/telegram.js";
import {
  assertLocal,
  callbackUpdate,
  messageUpdate,
  startMockBotApi,
  type MockBotApi,
} from "./telegram-mock.js";
import { assertLoopback, startMockSmtp, type MockSmtp } from "./smtp-mock.js";

/** dist/tests/e2e-email-demo.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
/** The committed self-signed fixture. Public, worthless, and not a credential. */
const FIXTURE_CA = fileURLToPath(new URL("../../tests/fixtures/smtp/test-cert.pem", import.meta.url));

const HUMAN = "human:carter";
const AGENT = "agent:claude-admin";
const TASK = "task-042";
/** SPEC.md §6.1's own idempotency key. */
const ACTION = "task-042:chaser:2026-08-04";

/** A fake bot token, distinctive enough that the scans cannot pass by accident. */
const BOT_TOKEN = "7654321:AA-approval-md-fake-token-for-the-m7-demo-DO-NOT-USE";
const CHAT = "9911";

/**
 * The credentials. Distinctive for the same reason, and never real.
 *
 * The submission username is deliberately NOT the address the mail is from: the
 * envelope sender is whatever the approved payload says, the login is whatever
 * the vault holds, and keeping them different is what lets the sweep in hop (j)
 * hunt for the username without matching the payload every human saw.
 */
const SMTP_USER = "submission-aprv70@approval.invalid";
/** The address the approved payload sends from. Not a credential. */
const FROM = "carter@approval.invalid";
const SMTP_PASSWORD = "smtp-pw-aprv70-4c19de-DO-NOT-USE";
const PASSPHRASE = "the operator's vault passphrase for the m7 demo";
/** The variable the demo policy NAMES. The policy never carries the value. */
const PASS_ENV = "APPROVAL_DEMO_VAULT_PASSPHRASE";

/**
 * SPEC.md §6.1's chaser, as a concrete email payload.
 *
 * The body carries a £ on purpose: a non-ASCII body sends the message down the
 * quoted-printable path, and the DATA assertion below re-renders the message
 * rather than pattern-matching it, so the demo proves the recipient's server
 * stores exactly what the approver saw.
 */
const PAYLOAD: EmailPayload = {
  from: FROM,
  to: ["agency@example.co.uk"],
  cc: ["deposits@example.co.uk"],
  subject: "Deposit refund <second chaser> & scheme deadline",
  body: [
    "The £1,200 deposit has been due since 12 July.",
    "",
    "One chaser was sent on 21 July with no reply. The protection scheme's",
    "deadline has now passed. Please confirm the refund date by return.",
    "",
  ].join("\n"),
};

/** The content binding (SPEC.md §6.2): SHA-256 over the RFC 8785 form. */
const PAYLOAD_HASH = payloadHash(PAYLOAD as unknown as Record<string, unknown>);

const POLICY = [
  "# Approval policy (M7 demo)",
  "",
  "Everything is manual unless a class says otherwise. External email is manual",
  "with a named approver, requests go to Telegram, and the vault passphrase is",
  "named here and held nowhere in this file.",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "1h"',
  "  on_expiry: reject",
  "  channel: telegram",
  "approvers:",
  "  carter:",
  "    channels: [telegram, cli]",
  "classes:",
  "  read.*:",
  "    autonomy: autonomous",
  "  communicate.email.external:",
  "    autonomy: manual",
  "    approvers: [carter]",
  "    limits:",
  "      per_action_usd: 1",
  "channels:",
  "  telegram:",
  "    token_env: APPROVAL_TG_TOKEN",
  "    chat_id_env: APPROVAL_TG_CHAT",
  "vault:",
  `  passphrase_env: ${PASS_ENV}`,
  "```",
  "",
].join("\n");

/**
 * A second policy, never attested and never used to gate anything, holding the
 * one rule the live policy cannot hold: the email class at `supervised`. It
 * exists so the irreversibility floor can be demonstrated as a difference rather
 * than asserted as a claim.
 */
const SUPERVISED_POLICY = [
  "# What the floor overrides (never attested; read by `policy test` only)",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "1h"',
  "  on_expiry: reject",
  "classes:",
  "  communicate.email.external:",
  "    autonomy: supervised",
  "```",
  "",
].join("\n");

function taskFile(hash: string): string {
  return [
    "---",
    `id: ${TASK}`,
    "title: Chase deposit refund from letting agency",
    "status: In Progress",
    "approval:",
    "  origin:",
    "    app: example-capture",
    `    created_by: "${HUMAN}"`,
    "  route:",
    `    assignee: "${AGENT}"`,
    "    confidence: 0.82",
    '    rationale: "templated chaser, known counterparty, no negotiation"',
    "  state: proposed",
    "  actions:",
    "    - class: communicate.email.external",
    '      summary: "Send deposit chaser to agency@example.co.uk"',
    "      reversible: false",
    "      est_cost_usd: 0.02",
    `      idempotency_key: "${ACTION}"`,
    `      payload_hash: "${hash}"`,
    "  budget:",
    "    max_cost_usd: 0.50",
    '    max_latency: "6h"',
    "---",
    "",
    "## Description",
    "",
    "Deposit (£1,200) due back since 12 July. One polite chaser sent by me on",
    "21 July, no reply. Agent should send a firmer follow-up citing the",
    "deposit-protection scheme deadline.",
    "",
    "## Acceptance Criteria",
    "",
    "- [ ] Email sent to the agency referencing scheme deadline",
    "- [ ] Reply, if any, filed back onto this task",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The scratch demo home
// ---------------------------------------------------------------------------

/** realpath: macOS hands out /var/… symlinks, and attestation compares paths. */
const demo = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-e2e-email-")));
const logPath = join(demo, ".approval", "log", "events.jsonl");
const vaultPath = join(demo, ".approval", "vault.enc");
const messagePath = join(demo, "message.json");

let bot: MockBotApi;
let smtp: MockSmtp;

/** Every byte the CLI printed, across every hop. Swept in the last subtest. */
const captured: { label: string; text: string }[] = [];

before(async () => {
  bot = await startMockBotApi(BOT_TOKEN);
  // STARTTLS with a login, which is what a real provider offers. The mock's
  // certificate is trusted by the children through NODE_EXTRA_CA_CERTS; the
  // adapter's own verification stays strict.
  smtp = await startMockSmtp({ tls: "none", user: SMTP_USER, password: SMTP_PASSWORD });
  assertLoopback(smtp.host);
});

after(async () => {
  await bot.close();
  await smtp.close();
  rmSync(demo, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * The child's environment is stripped of every variable the demo supplies
 * itself, so a developer who exports any of them in their own shell cannot make
 * a step pass by accident.
 */
function cliEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const name of [
    "APPROVAL_HUMAN",
    "APPROVAL_TG_TOKEN",
    "APPROVAL_TG_CHAT",
    "APPROVAL_VAULT_PASSPHRASE",
    PASS_ENV,
  ]) {
    if (extra[name] === undefined) delete env[name];
  }
  return env;
}

/**
 * Spawn the CLI and wait for it.
 *
 * Asynchronous, and it has to be for the SMTP hop: both mocks run on this
 * process's event loop, so a `spawnSync` there would block the very loop the
 * child is waiting on. The synchronous twin below is used only by hops that
 * touch neither mock.
 */
async function runCli(
  args: string[],
  env: Record<string, string> = {},
  stdin = "",
): Promise<Run> {
  const run = await new Promise<Run>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd: demo,
      env: cliEnv(env),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(stdin);
  });
  captured.push({ label: `${args[0] ?? "?"} stdout`, text: run.stdout });
  captured.push({ label: `${args[0] ?? "?"} stderr`, text: run.stderr });
  return run;
}

/** For hops that touch neither mock: no event loop of ours is waiting. */
function runCliSync(args: string[], env: Record<string, string> = {}): Run {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: demo,
    encoding: "utf8",
    env: cliEnv(env),
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  const run = { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  captured.push({ label: `${args[0] ?? "?"} stdout`, text: run.stdout });
  captured.push({ label: `${args[0] ?? "?"} stderr`, text: run.stderr });
  return run;
}

function rawLog(): string {
  return existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
}

function logRecords(): Record<string, unknown>[] {
  return rawLog()
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function events(): string[] {
  return logRecords().map((record) => String(record["event"]));
}

function recordAt(seq: number): Record<string, unknown> {
  const record = logRecords().find((entry) => entry["seq"] === seq);
  assert.ok(record !== undefined, `no record at seq ${seq}`);
  return record;
}

function payloadOf(record: Record<string, unknown>): Record<string, unknown> {
  return (record["payload"] ?? {}) as Record<string, unknown>;
}

function json(run: Run): Record<string, unknown> {
  return JSON.parse(run.stdout) as Record<string, unknown>;
}

async function until(predicate: () => boolean, label: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

/** The listener's environment: the bot credentials and the approver's identity. */
const LISTENER_ENV = {
  APPROVAL_TG_TOKEN: BOT_TOKEN,
  APPROVAL_TG_CHAT: CHAT,
  APPROVAL_HUMAN: HUMAN,
};

function listenArgs(pollTimeout: string): string[] {
  return [
    "channel",
    "telegram",
    "listen",
    "--once",
    "--api-base",
    assertLocal(bot.url),
    "--poll-timeout",
    pollTimeout,
  ];
}

/** One `channel telegram listen --once` cycle, run to completion. */
async function listenOnce(): Promise<Run> {
  return runCli(listenArgs("1"), LISTENER_ENV);
}

/**
 * A listener still running, so a tap can arrive while it polls.
 *
 * The callback nonce is issued by the process that sent the button and lives
 * only in that process (SPEC.md §10.3: channels hold no state that is truth), so
 * a tap can only be answered by the listener whose message it belongs to. That
 * is a real constraint on the walk, not a test artifact, and hop (f) is shaped
 * around it.
 */
function startListener(): { done: Promise<Run> } {
  const child = spawn(process.execPath, [CLI_ENTRY, ...listenArgs("10")], {
    cwd: demo,
    env: cliEnv(LISTENER_ENV),
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const done = new Promise<Run>((resolve) => {
    child.on("exit", (code) => {
      const run = { code: code ?? -1, stdout, stderr };
      captured.push({ label: "listener stdout", text: run.stdout });
      captured.push({ label: "listener stderr", text: run.stderr });
      resolve(run);
    });
  });
  return { done };
}

/** The manual walk's `[event, actor]` list, recorded at hop (i) and reproduced
 * by the setup walk at the bottom of this file. */
let manualShape: [string, string][] = [];

/** Filled in at the Telegram hop; spent at the SMTP hop. */
let executionToken = "";
/** The listener stdout that printed it: the one sanctioned appearance. */
let grantStdout = "";

// ===========================================================================
// The walk
// ===========================================================================

test("the M7 demo: draft -> telegram -> approve -> mail sent -> chain clean", async (t) => {
  // -------------------------------------------------------------------------
  await t.test("(a) init scaffolds the home, and the demo writes its policy", () => {
    const scaffolded = runCliSync(["init", "--json"]);
    assert.equal(scaffolded.code, 0, scaffolded.stderr);
    const result = json(scaffolded);
    assert.equal(result["ok"], true);
    assert.deepEqual(result["written"], [
      "APPROVAL.md",
      ".approval/log/",
      ".approval/QUEUE.md",
      ".gitignore",
    ]);
    // init holds no authority: it appends nothing, so there is no log yet.
    assert.equal(existsSync(logPath), false, "init created a log");

    // The scaffolded policy is SPEC.md §5.1's canonical one. The demo needs its
    // own channel and vault configuration, and `init` never overwrites, so the
    // replacement is explicit.
    rmSync(join(demo, "APPROVAL.md"));
    writeFileSync(join(demo, "APPROVAL.md"), POLICY, "utf8");
    writeFileSync(join(demo, "supervised-policy.md"), SUPERVISED_POLICY, "utf8");
  });

  // -------------------------------------------------------------------------
  await t.test("(b) the human attests the policy and fills the vault", () => {
    const attested = runCliSync(["policy", "attest", "--as", HUMAN, "--json"]);
    assert.equal(attested.code, 0, attested.stderr);
    assert.equal(json(attested)["seq"], 1);

    // Five credentials, none of them on a command line. `--value-env` names a
    // variable exactly as the policy names the passphrase's; there is no
    // --value flag, because a secret on a command line is a secret in the
    // shell history and in `ps` output.
    const credentials: [string, string][] = [
      ["smtp.host", smtp.host === "127.0.0.1" ? "localhost" : smtp.host],
      ["smtp.port", String(smtp.port)],
      ["smtp.security", "starttls"],
      ["smtp.user", SMTP_USER],
      ["smtp.password", SMTP_PASSWORD],
    ];
    for (const [name, value] of credentials) {
      const set = runCliSync(["vault", "set", name, "--value-env", "DEMO_VALUE", "--as", HUMAN, "--json"], {
        [PASS_ENV]: PASSPHRASE,
        DEMO_VALUE: value,
      });
      assert.equal(set.code, 0, set.stderr);
      assert.equal(json(set)["name"], name);
      assert.equal(json(set)["created"], true);
      assert.equal(
        set.stdout.includes(value) && name === "smtp.password",
        false,
        "`vault set` echoed the credential it was storing",
      );
    }

    // The vault is a sibling of the log, and it holds names an operator can
    // read back. There is no `vault get`, and asking for one says why.
    assert.equal(existsSync(vaultPath), true, "no vault was created");
    const listed = runCliSync(["vault", "list", "--as", HUMAN, "--json"], {
      [PASS_ENV]: PASSPHRASE,
    });
    assert.equal(listed.code, 0, listed.stderr);
    assert.deepEqual(json(listed)["names"], [
      "smtp.host",
      "smtp.password",
      "smtp.port",
      "smtp.security",
      "smtp.user",
    ]);
    assert.equal(json(listed)["count"], 5);
    assert.equal(listed.stdout.includes(SMTP_PASSWORD), false, "`vault list` printed a value");

    const refused = runCliSync(["vault", "get", "smtp.password", "--as", HUMAN, "--json"], {
      [PASS_ENV]: PASSPHRASE,
    });
    assert.equal(refused.code, 2, "there is no `vault get`, and asking is a usage error");

    // Nothing about a credential is a log entry: the log records actions the
    // gate authorized, and a list of the credentials an operator holds is a map
    // of the machine's reach.
    assert.deepEqual(events(), ["policy.updated"]);
  });

  // -------------------------------------------------------------------------
  await t.test("(c) the agent drafts the chaser, binds it, registers and requests", () => {
    writeFileSync(messagePath, `${JSON.stringify(PAYLOAD, null, 2)}\n`, "utf8");

    // The binding is computed by the CLI, with the same function the runtime
    // uses at every later check.
    const hashed = runCliSync(["payload", "hash", "message.json", "--json"]);
    assert.equal(hashed.code, 0, hashed.stderr);
    assert.equal(json(hashed)["hash"], PAYLOAD_HASH);

    writeFileSync(join(demo, `${TASK}.md`), taskFile(PAYLOAD_HASH), "utf8");

    const registered = runCliSync(["register", `${TASK}.md`, "--as", AGENT, "--json"]);
    assert.equal(registered.code, 0, registered.stderr);
    assert.deepEqual(json(registered), { ok: true, seq: 2, task: TASK, actions: 1 });

    const requested = runCliSync([
      "request",
      TASK,
      "--action",
      ACTION,
      "--payload",
      "message.json",
      "--as",
      AGENT,
      "--json",
    ]);
    assert.equal(requested.code, 0, requested.stderr);
    assert.deepEqual(json(requested), {
      ok: true,
      task: TASK,
      action_key: ACTION,
      class: "communicate.email.external",
      autonomy: "manual",
      proceed: false,
      requested: true,
      seq: 3,
    });

    assert.deepEqual(events(), ["policy.updated", "task.registered", "approval.requested"]);
    assert.deepEqual(payloadOf(recordAt(3)), {
      class: "communicate.email.external",
      est_cost_usd: 0.02,
      payload_hash: PAYLOAD_HASH,
      summary: "Send deposit chaser to agency@example.co.uk",
      reversible: false,
    });
    assert.equal(recordAt(3)["actor"], AGENT);

    // The bytes are filed once, at intake, under the hash the log committed to.
    const stored = join(demo, ".approval", "payloads", `${PAYLOAD_HASH}.json`);
    assert.equal(existsSync(stored), true, "the request stored no payload");
    assert.deepEqual(JSON.parse(readFileSync(stored, "utf8")) as unknown, PAYLOAD);
  });

  // -------------------------------------------------------------------------
  // SPEC.md §7: an irreversible action cannot be autonomous or supervised, and
  // the floor is shown as a difference rather than asserted as a claim.
  await t.test("(d) the irreversibility floor: reversible false resolves manual", () => {
    const asWritten = runCliSync([
      "policy",
      "test",
      "communicate.email.external",
      "--reversible",
      "true",
      "--policy",
      "supervised-policy.md",
      "--json",
    ]);
    assert.equal(asWritten.code, 0, asWritten.stderr);
    assert.equal(
      (json(asWritten)["outcome"] as Record<string, unknown>)["autonomy"],
      "supervised",
      "the fixture policy is supposed to say supervised",
    );

    const floored = runCliSync([
      "policy",
      "test",
      "communicate.email.external",
      "--reversible",
      "false",
      "--policy",
      "supervised-policy.md",
      "--json",
    ]);
    assert.equal(floored.code, 0, floored.stderr);
    const verdict = json(floored);
    assert.equal((verdict["outcome"] as Record<string, unknown>)["autonomy"], "manual");
    assert.equal(verdict["provenance"], "floor");
    assert.equal(verdict["manualBecause"], "irreversibility-floor");
    assert.deepEqual(verdict["overridden"], {
      pattern: "communicate.email.external",
      autonomy: "supervised",
    });

    // The envelope in play declares reversible: false, which is why nothing
    // about the walk below depends on the live policy saying manual.
    assert.equal(payloadOf(recordAt(3))["reversible"], false);
  });

  // -------------------------------------------------------------------------
  await t.test("(e) telegram: the chaser reaches the phone, payload and all", async () => {
    const before_ = bot.sentTexts().length;

    const delivered = await listenOnce();
    assert.equal(delivered.code, 0, delivered.stderr);
    assert.match(delivered.stdout, new RegExp(`notified ${ACTION.replace(/:/gu, ":")}`, "u"));

    const text = bot.sentTexts().slice(before_).join("\n");
    assert.match(text, /APPROVAL REQUIRED/u);
    assert.match(text, new RegExp(`<code>${ACTION}</code>`, "u"));
    // The two blocks §10.4 requires, and the line between them: what the
    // runtime derived, and what the agent merely says.
    assert.match(text, /COMPUTED — derived by the runtime/u);
    assert.match(text, new RegExp(`CLAIMED — authored by ${AGENT}, NOT verified`, "u"));
    assert.match(text, /Send deposit chaser to agency@example\.co\.uk/u);
    assert.match(text, /FULL PAYLOAD/u);
    assert.match(text, new RegExp(PAYLOAD_HASH, "u"), "the binding is shown to the approver");
    // The payload arrives whole and HTML-escaped: an agent-authored subject
    // must not become markup on its way to a phone.
    assert.match(text, /Deposit refund &lt;second chaser&gt; &amp; scheme deadline/u);
    assert.match(text, /agency@example\.co\.uk/u);
    assert.match(text, /deposits@example\.co\.uk/u);
    assert.match(text, /£1,200 deposit has been due since 12 July/u);
    assert.equal(text.includes("<second chaser>"), false, "raw markup reached the message");

    // A delivered request is not a decided one.
    assert.deepEqual(events(), ["policy.updated", "task.registered", "approval.requested"]);
  });

  // -------------------------------------------------------------------------
  await t.test("(f) the tap: Approve is recorded, and the token is printed once", async () => {
    const sentBefore = bot.sentTexts().length;
    const staleButton = bot.callbackDataFor(ACTION, "grant");

    // A second listener re-sends what is still pending, with a FRESH nonce: the
    // "already sent" set and the button-to-action map both live in the process
    // (SPEC.md §10.3). A duplicate on the phone, never a request nobody sees —
    // and the buttons on the pre-restart message stop resolving, which is why
    // the tap below is the new button and not the old one.
    const listener = startListener();
    await until(
      () => bot.callbackDataFor(ACTION, "grant") !== staleButton,
      "the restarted listener to re-deliver the pending request",
    );
    assert.ok(
      bot.sentTexts().length > sentBefore,
      "the restarted listener did not re-deliver the still-pending request",
    );

    bot.queueUpdate(
      callbackUpdate({ data: bot.callbackDataFor(ACTION, "grant"), chatId: CHAT }),
    );

    const decided = await listener.done;
    assert.equal(decided.code, 0, decided.stderr);
    grantStdout = decided.stdout;

    assert.match(decided.stdout, new RegExp(`granted ${ACTION} .*by ${HUMAN} via telegram`, "u"));
    const printed = /execution token for \S+: (\S+)/u.exec(decided.stdout);
    assert.ok(printed !== null, `no execution token on the listener's stdout: ${decided.stdout}`);
    executionToken = printed[1] as string;
    assert.match(executionToken, /^[a-f0-9]{64}$/u);
    assert.match(decided.stdout, /NOT sent to Telegram/u);

    await until(() => events().length === 4, "the grant to land in the log");
    assert.deepEqual(events(), [
      "policy.updated",
      "task.registered",
      "approval.requested",
      "approval.granted",
    ]);
    const granted = recordAt(4);
    assert.equal(granted["actor"], HUMAN, "the decision is recorded against the human, not the bot");
    assert.equal(granted["action_key"], ACTION);
    const grantPayload = payloadOf(granted);
    assert.equal(grantPayload["payload_hash"], PAYLOAD_HASH, "the grant bound to other bytes");
    assert.equal(
      grantPayload["token_sha256"],
      createHash("sha256").update(executionToken, "utf8").digest("hex"),
      "the log holds the token's digest and only its digest",
    );
    assert.deepEqual(Object.keys(grantPayload).sort(), [
      "class",
      "est_cost_usd",
      "payload_hash",
      "token_sha256",
    ]);

    // The channel is on the terminal, not in the record: the log states who
    // decided and what they bound to.
    assert.equal(rawLog().includes(executionToken), false, "the raw token reached the log");
    assert.equal(rawLog().includes(BOT_TOKEN), false, "the bot token reached the log");

    const verified = runCliSync(["log", "verify", "--json"]);
    assert.equal(verified.code, 0, verified.stderr);
    assert.equal(json(verified)["status"], "clean");
  });

  // -------------------------------------------------------------------------
  await t.test("(g) the send: the adapter spends the token and the mail goes out", async () => {
    assert.equal(smtp.connections, 0, "something opened an SMTP session before the grant");

    const sent = await runCli(
      [
        "adapter",
        "email",
        ACTION,
        "--token",
        executionToken,
        "--payload",
        "message.json",
        "--as",
        AGENT,
        "--vault",
        vaultPath,
        "--json",
      ],
      {
        [PASS_ENV]: PASSPHRASE,
        // The operator's own trust decision, made outside the runtime. See the
        // file header: the adapter's verification stays strict.
        NODE_EXTRA_CA_CERTS: FIXTURE_CA,
      },
    );
    assert.equal(sent.code, 0, `${sent.stdout}${sent.stderr}`);

    const result = json(sent);
    assert.equal(result["ok"], true);
    assert.equal(result["adapter"], "email");
    assert.equal(result["action_key"], ACTION);
    assert.equal(result["task"], TASK);
    assert.equal(result["class"], "communicate.email.external");
    assert.equal(result["autonomy"], "manual");
    assert.equal(result["outcome"], "execution.completed");
    assert.equal(result["exit_code"], 0);
    // The contract recomputed the hash from the bytes it was handed and the
    // token spend checked it: the send is the grant's send or it is nothing.
    assert.equal(result["payload_hash"], PAYLOAD_HASH);

    const detail = result["detail"] as Record<string, unknown>;
    assert.equal(detail["secure"], true, "the session was not encrypted");
    assert.equal(detail["auth"], "PLAIN");
    assert.equal(detail["smtp_code"], 250);
    assert.equal(detail["recipients"], 2);
    // The Message-ID is derived from the action key, the binding and the sender,
    // so anyone holding the log can recompute it and match it against the mail.
    assert.equal(
      detail["message_id"],
      deterministicMessageId(ACTION, PAYLOAD_HASH, PAYLOAD.from),
      "the Message-ID is not recomputable from the log",
    );

    // What the far side actually received.
    assert.equal(smtp.connections, 1, "exactly one SMTP session was expected");
    const session = smtp.last();
    assert.ok(session !== undefined, "the mock recorded no session");
    assert.equal(session.secure, true);
    assert.equal(session.authenticated, "PLAIN");
    assert.equal(
      session.presented?.user === SMTP_USER && session.presented.password === SMTP_PASSWORD,
      true,
      "the adapter presented credentials that are not the ones in the vault",
    );
    assert.equal(session.quit, true, "the adapter did not close the session cleanly");
    // The envelope sender is the approved payload's, never the login's.
    assert.notEqual(PAYLOAD.from, SMTP_USER);
    // RCPT TO is To then Cc: the envelope names every recipient the payload did.
    assert.deepEqual(session.recipients, ["agency@example.co.uk", "deposits@example.co.uk"]);
    assert.equal(session.mailFrom, PAYLOAD.from);
    // And the message is exactly the adapter's rendering of the approved bytes,
    // byte for byte, stamped with the date and Message-ID the result reported.
    assert.equal(
      session.message,
      renderEmailMessage(PAYLOAD, {
        date: new Date(String(detail["date"])),
        messageId: String(detail["message_id"]),
      }),
      "the bytes on the wire are not the adapter's rendering of the approved payload",
    );

    assert.deepEqual(events().slice(-2), ["execution.started", "execution.completed"]);
    assert.equal(recordAt(5)["actor"], AGENT);
    assert.deepEqual(payloadOf(recordAt(6)), { exit_code: 0 });
  });

  // -------------------------------------------------------------------------
  await t.test("(h) negative space: the same token cannot send a second mail", async () => {
    const connectionsBefore = smtp.connections;
    const lengthBefore = events().length;

    const replayed = await runCli(
      [
        "adapter",
        "email",
        ACTION,
        "--token",
        executionToken,
        "--payload",
        "message.json",
        "--as",
        AGENT,
        "--vault",
        vaultPath,
        "--json",
      ],
      { [PASS_ENV]: PASSPHRASE, NODE_EXTRA_CA_CERTS: FIXTURE_CA },
    );

    assert.equal(replayed.code, 1, replayed.stdout);
    const refusal = JSON.parse(replayed.stderr.trim()) as Record<string, unknown>;
    assert.equal(refusal["ok"], false);
    assert.equal(refusal["code"], "token-consumed");
    assert.equal(refusal["acted"], false, "the adapter acted on a spent token");
    assert.equal(smtp.connections, connectionsBefore, "a refusal opened an SMTP session");
    assert.equal(events().length, lengthBefore, "a refusal appended to the log");
  });

  // -------------------------------------------------------------------------
  await t.test("(i) the log tells the whole story, and the chain verifies", () => {
    const tailed = runCliSync(["log", "tail", "-n", "10", "--json"]);
    assert.equal(tailed.code, 0, tailed.stderr);
    const tail = json(tailed);
    assert.equal(tail["status"], "ok");
    const records = tail["records"] as Record<string, unknown>[];
    // The shape the second walk has to reproduce: same events, same actors, in
    // the same order, reached through `approval setup` instead of by hand.
    manualShape = records.map((record) => [String(record["event"]), String(record["actor"])]);
    assert.deepEqual(
      records.map((record) => [record["event"], record["actor"]]),
      [
        ["policy.updated", HUMAN],
        ["task.registered", AGENT],
        ["approval.requested", AGENT],
        ["approval.granted", HUMAN],
        ["execution.started", AGENT],
        ["execution.completed", AGENT],
      ],
      "the six records of the demo, in order, with who did each",
    );

    const verified = runCliSync(["log", "verify", "--json"]);
    assert.equal(verified.code, 0, verified.stderr);
    const chain = json(verified);
    assert.equal(chain["status"], "clean");
    assert.equal(chain["records"], 6);
    assert.equal((chain["head"] as Record<string, unknown>)["seq"], 6);

    const status = runCliSync(["status", "--json"]);
    assert.equal(status.code, 0, status.stderr);
    assert.equal(json(status)["healthy"], true);
    assert.deepEqual(json(status)["dangling"], [], "a completed send leaves no debris");
  });

  // -------------------------------------------------------------------------
  // The sweep. Over everything, not over the strings a hop remembered to check:
  // a leak through output nobody thought to assert on is precisely the shape of
  // failure SPEC.md §11.1 invariant 3 exists to prevent.
  await t.test("(j) no secret is anywhere it should not be", () => {
    const logBytes = rawLog();
    // The host, the port and the security setting are configuration rather than
    // secrets, and a five-digit port can occur inside a 64-character digest by
    // chance. The three values that are secret are hunted without exception.
    for (const [label, needle] of [
      ["SMTP password", SMTP_PASSWORD],
      ["vault passphrase", PASSPHRASE],
      ["SMTP username", SMTP_USER],
      ["bot token", BOT_TOKEN],
    ] as const) {
      assert.equal(logBytes.includes(needle), false, `the ${label} reached the log`);
      for (const { label: where, text } of captured) {
        assert.equal(text.includes(needle), false, `the ${label} appeared in ${where}`);
      }
      for (const entry of bot.requests) {
        assert.equal(
          entry.raw.includes(needle),
          false,
          `the ${label} appeared in a ${entry.method} body`,
        );
      }
    }

    // The execution token has exactly ONE sanctioned appearance in everything
    // this demo captured: the listener's own stdout, at the moment of the grant.
    assert.ok(executionToken.length === 64, "no token was captured to scan for");
    assert.equal(logBytes.includes(executionToken), false, "the raw token reached the log");
    assert.ok(grantStdout.includes(executionToken), "the grant stdout is the printing terminal");
    let appearances = 0;
    for (const { label, text } of captured) {
      if (!text.includes(executionToken)) continue;
      appearances += 1;
      assert.equal(
        text,
        grantStdout,
        `the execution token appeared in ${label}, which is not the terminal it was printed on`,
      );
    }
    assert.equal(appearances, 1, "the token was printed more than once");
    for (const entry of bot.requests) {
      assert.equal(
        entry.raw.includes(executionToken),
        false,
        `the execution token appeared in a ${entry.method} body`,
      );
    }
    // The mail carried the approved bytes and nothing else: no token rode out
    // to the far side inside the message.
    const session = smtp.last();
    assert.equal(session?.message?.includes(executionToken), false, "the token reached the mail");
  });
});

// ===========================================================================
// The same walk, reached through `approval setup` (APRV-76)
// ===========================================================================

/**
 * The walk above exports its variables by hand. `examples/email-demo.md` no
 * longer tells a human to do that: it tells them to run `approval setup
 * identity|vault|telegram` and then `eval "$(approval env)"`. This test is the
 * scripted twin of THAT prelude, and its claim is the one the rewritten runbook
 * makes — the two paths reach the same log.
 *
 * How it is driven, and why:
 *
 * - **`setup` runs IN-PROCESS through its injected seams** (`tests/cli-setup.ts`
 *   does the same, for the same reason): the prompter is scripted, the keystore
 *   is a fake, and the Bot API is the loopback mock. A spawned `setup` would
 *   refuse at the terminal check, which is the property that makes the verb safe
 *   to ship, and nothing under `npm test` may reach a real keystore.
 * - **The fake keystore reports `kind: "none"`**, so every secret lands in
 *   `.approval/env` as a plaintext literal. That is deliberate: the SPAWNED
 *   children below resolve the file with the real runner, and a `keychain:` line
 *   would send them to the developer's own Keychain. §5.2 permits literals and
 *   `approval env --check` reports them as plaintext forever after, which is the
 *   path this test is allowed to walk.
 * - **`approval env --json` is the seam between the two halves.** The child
 *   reads what setup wrote and hands back the values; every later hop is spawned
 *   with exactly those values in its environment, so nothing here re-states a
 *   credential the file did not already resolve to.
 *
 * Assertions are deliberately thinner than the walk above: the hops are the same
 * hops, already asserted line by line, and what is under test here is the
 * prelude and the shape of the log it leads to.
 */

/** The second walk's home, torn down with the first. */
let setupDemo = "";

after(() => {
  if (setupDemo !== "") rmSync(setupDemo, { recursive: true, force: true });
});

/** Everything the second walk's children printed. Swept at the end. */
const setupCaptured: { label: string; text: string }[] = [];

function runSetupWalkSync(args: string[], env: Record<string, string> = {}): Run {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: setupDemo,
    encoding: "utf8",
    env: cliEnv(env),
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  const run = { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  setupCaptured.push({ label: `${args[0] ?? "?"} stdout`, text: run.stdout });
  setupCaptured.push({ label: `${args[0] ?? "?"} stderr`, text: run.stderr });
  return run;
}

async function runSetupWalk(args: string[], env: Record<string, string> = {}): Promise<Run> {
  const run = await new Promise<Run>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd: setupDemo,
      env: cliEnv(env),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end();
  });
  setupCaptured.push({ label: `${args[0] ?? "?"} stdout`, text: run.stdout });
  setupCaptured.push({ label: `${args[0] ?? "?"} stderr`, text: run.stderr });
  return run;
}

/**
 * A keystore that is a `Map` and says this machine has none, so `setup` takes
 * the documented plaintext-literal path. Nothing here can reach a real keyring:
 * the interface IS the seam.
 */
function noKeystore(): KeystoreRunner {
  const items = new Map<string, string>();
  return {
    kind: (): KeystoreKind => "none",
    storeGenerated(service, value): StoreOutcome {
      items.set(service, value);
      return { ok: true, viaArgv: false };
    },
    storePrompted(service): StoreOutcome {
      items.set(service, BOT_TOKEN);
      return { ok: true, viaArgv: false };
    },
    read(service) {
      const value = items.get(service);
      return value === undefined ? { ok: false, message: "fake: absent" } : { ok: true, value };
    },
  };
}

/** The human's side of the conversation, one answer per question, in order. */
function scripted(script: unknown[]): Prompter {
  const remaining = [...script];
  const next = (prompt: string): unknown => {
    if (remaining.length === 0) {
      throw new Error(`setup asked an unscripted question: ${JSON.stringify(prompt)}`);
    }
    return remaining.shift();
  };
  return {
    readLine(prompt) {
      const answer = next(prompt);
      return answer === null ? null : String(answer);
    },
    readSecret(prompt): SecretRead {
      return { ok: true, value: String(next(prompt)) };
    },
    confirm(prompt) {
      return next(prompt) === true;
    },
  };
}

/** Run one `setup` subcommand in-process, capturing what it said. */
async function setupSubcommand(argv: string[], deps: SetupDeps): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const streams: Streams = {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  };
  const code = await commandSetup(argv, streams, setupDemo, deps);
  const run = { code, stdout: out.join(""), stderr: err.join("") };
  setupCaptured.push({ label: `setup ${argv[0] ?? "?"} stdout`, text: run.stdout });
  setupCaptured.push({ label: `setup ${argv[0] ?? "?"} stderr`, text: run.stderr });
  return run;
}

/**
 * One flat test rather than the ordered subtests above, deliberately: a
 * `t.test()` awaited from a parent that has already awaited something else does
 * not reliably hold this Node version's runner (the parent's `finally` ran
 * before the first subtest did, closing the mock the subtests needed). The hops
 * are marked by comment, and each assertion still names what it is about.
 */
test("the setup path: `approval setup` + `approval env` reaches the same log", async () => {
  setupDemo = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-e2e-email-setup-")));
  const setupLog = join(setupDemo, ".approval", "log", "events.jsonl");
  const setupEnvFile = join(setupDemo, ".approval", "env");
  const setupVault = join(setupDemo, ".approval", "vault.enc");

  const bot2 = await startMockBotApi(BOT_TOKEN);
  const smtp2 = await startMockSmtp({ tls: "none", user: SMTP_USER, password: SMTP_PASSWORD });
  assertLoopback(smtp2.host);

  try {
    // -----------------------------------------------------------------------
    // (1) init and the policy, exactly as the manual walk starts. The policy
    // comes FIRST because setup reads the variable names out of it:
    // `vault.passphrase_env` here is the demo's own, not the default.
    const scaffolded = runSetupWalkSync(["init", "--json"]);
    assert.equal(scaffolded.code, 0, scaffolded.stderr);
    rmSync(join(setupDemo, "APPROVAL.md"));
    writeFileSync(join(setupDemo, "APPROVAL.md"), POLICY, "utf8");
    assert.equal(existsSync(setupLog), false, "init created a log");

    // -----------------------------------------------------------------------
    // (2) `approval setup identity|vault|telegram`, in process, through the
    // seams. Nothing here can reach a real keystore: the interface IS the seam.
    const deps: SetupDeps = {
      keystore: noKeystore(),
      fetch: globalThis.fetch as unknown as TelegramFetch,
      apiBase: assertLocal(bot2.url),
      generate: () => PASSPHRASE,
      pollTimeoutSeconds: 1,
    };

    const identity = await setupSubcommand(["identity"], {
      ...deps,
      prompter: scripted([HUMAN]),
    });
    assert.equal(identity.code, 0, identity.stderr);

    // With no keystore the generated passphrase is offered as a literal, and
    // the offer is taken only on a typed `yes` — never `y`, never Enter.
    const vault = await setupSubcommand(["vault", "--as", HUMAN], {
      ...deps,
      prompter: scripted(["yes"]),
    });
    assert.equal(vault.code, 0, vault.stderr);

    bot2.queueUpdate(messageUpdate({ chatId: CHAT, username: "carter" }));
    const telegram = await setupSubcommand(["telegram", "--as", HUMAN], {
      ...deps,
      prompter: scripted([
        BOT_TOKEN, // the no-echo read, on a machine with no keystore
        "yes", // write it as a plaintext literal
        "", // Enter, after "send the bot a message"
        true, // use this chat?
        false, // send a test message? — default no
      ]),
    });
    assert.equal(telegram.code, 0, telegram.stderr);

    // The file the runbook now tells a human to produce, and nothing else: no
    // log, no attestation, no edit to the policy. The passphrase line carries
    // the name the POLICY declares, which is the demo's own and not the
    // default — the fact `examples/email-demo.md` now states outright.
    assert.deepEqual(
      readFileSync(setupEnvFile, "utf8").split("\n").filter((line) => line.length > 0),
      [
        `APPROVAL_HUMAN=${HUMAN}`,
        `${PASS_ENV}=${PASSPHRASE}`,
        `APPROVAL_TG_TOKEN=${BOT_TOKEN}`,
        `APPROVAL_TG_CHAT=${CHAT}`,
      ],
    );
    assert.equal(existsSync(setupLog), false, "setup appended to the log");
    assert.equal(readFileSync(join(setupDemo, "APPROVAL.md"), "utf8"), POLICY);
    // No getUpdates setup made carried an offset, so nothing it did could
    // acknowledge an update a listener is waiting for.
    for (const entry of bot2.requests.filter((request) => request.method === "getUpdates")) {
      assert.equal("offset" in entry.body, false, "setup acknowledged an update");
    }

    // -----------------------------------------------------------------------
    // (3) `approval env --json` — the seam between the two halves. This output
    // CARRIES VALUES by design (that is the verb's whole job), so it is the one
    // child of this walk kept out of the secret sweep at the bottom.
    const envRead = spawnSync(process.execPath, [CLI_ENTRY, "env", "--json"], {
      cwd: setupDemo,
      encoding: "utf8",
      env: cliEnv({}),
    });
    assert.equal(envRead.status, 0, envRead.stderr);
    const resolvedEnv: Record<string, string> = {};
    for (const variable of (JSON.parse(envRead.stdout) as { variables: Record<string, unknown>[] })
      .variables) {
      assert.equal(
        variable["status"],
        "resolved-literal",
        `${String(variable["name"])} did not resolve from the file setup wrote`,
      );
      resolvedEnv[String(variable["name"])] = String(variable["value"]);
    }
    // The four values the manual walk types out by hand, recovered from the
    // file instead. This equality IS the claim of the rewritten runbook.
    assert.deepEqual(resolvedEnv, {
      APPROVAL_HUMAN: HUMAN,
      [PASS_ENV]: PASSPHRASE,
      APPROVAL_TG_TOKEN: BOT_TOKEN,
      APPROVAL_TG_CHAT: CHAT,
    });
    const human = resolvedEnv["APPROVAL_HUMAN"] as string;
    const passphrase = resolvedEnv[PASS_ENV] as string;

    // -----------------------------------------------------------------------
    // (4) attest, fill the vault, register and request — every child from here
    // on carries only what `approval env` handed back.
    const attested = runSetupWalkSync(["policy", "attest", "--json"], { APPROVAL_HUMAN: human });
    assert.equal(attested.code, 0, attested.stderr);

    // The five adapter credentials, through ONE verb (APRV-78). The manual walk
    // above spells out five `approval vault set` calls, which is still the
    // scripted path and is still what the runbook documents under "by hand";
    // what `examples/email-demo.md` now LEADS with is this, and the claim is
    // the same claim as the prelude's: it reaches the same vault.
    //
    // The probe is DECLINED. It is offered and it defaults to yes, but this
    // walk asserts that exactly one SMTP session happens — the send — and a
    // verification session would be a second one. That the probe works is
    // `tests/cli-setup.test.ts`'s business, against its own mock.
    //
    // The adapter's secrets live in the VAULT and never in `.approval/env`;
    // what the env file carries is the passphrase that opens it.
    const filled = await setupSubcommand(["adapter", "email", "--as", HUMAN], {
      ...deps,
      env: { [PASS_ENV]: passphrase },
      prompter: scripted([
        smtp2.host === "127.0.0.1" ? "localhost" : smtp2.host, // smtp.host
        String(smtp2.port), // smtp.port
        "", // smtp.security — Enter takes starttls
        SMTP_USER, // smtp.user
        SMTP_PASSWORD, // smtp.password, read with no echo
        false, // probe it? — declined, see above
      ]),
    });
    assert.equal(filled.code, 0, filled.stderr);
    assert.equal(existsSync(setupVault), true, "no vault was created");

    const stored = runSetupWalkSync(["vault", "list", "--json"], {
      APPROVAL_HUMAN: human,
      [PASS_ENV]: passphrase,
    });
    assert.equal(stored.code, 0, stored.stderr);
    assert.deepEqual(
      (JSON.parse(stored.stdout) as { names: string[] }).names,
      ["smtp.host", "smtp.password", "smtp.port", "smtp.security", "smtp.user"],
    );

    writeFileSync(join(setupDemo, "message.json"), `${JSON.stringify(PAYLOAD, null, 2)}\n`, "utf8");
    writeFileSync(join(setupDemo, `${TASK}.md`), taskFile(PAYLOAD_HASH), "utf8");

    const registered = runSetupWalkSync(["register", `${TASK}.md`, "--as", AGENT, "--json"]);
    assert.equal(registered.code, 0, registered.stderr);
    const requested = runSetupWalkSync([
      "request",
      TASK,
      "--action",
      ACTION,
      "--payload",
      "message.json",
      "--as",
      AGENT,
      "--json",
    ]);
    assert.equal(requested.code, 0, requested.stderr);

    // -----------------------------------------------------------------------
    // (5) the phone, the tap, and the send.
    const listener = spawn(
      process.execPath,
      [
        CLI_ENTRY,
        "channel",
        "telegram",
        "listen",
        "--once",
        "--api-base",
        assertLocal(bot2.url),
        "--poll-timeout",
        "10",
      ],
      {
        cwd: setupDemo,
        env: cliEnv({
          APPROVAL_TG_TOKEN: resolvedEnv["APPROVAL_TG_TOKEN"] as string,
          APPROVAL_TG_CHAT: resolvedEnv["APPROVAL_TG_CHAT"] as string,
          APPROVAL_HUMAN: human,
        }),
      },
    );
    let listened = "";
    let listenedErr = "";
    listener.stdout.setEncoding("utf8");
    listener.stderr.setEncoding("utf8");
    listener.stdout.on("data", (chunk: string) => {
      listened += chunk;
    });
    listener.stderr.on("data", (chunk: string) => {
      listenedErr += chunk;
    });
    const decided = new Promise<Run>((resolve) => {
      listener.on("exit", (code) =>
        resolve({ code: code ?? -1, stdout: listened, stderr: listenedErr }),
      );
    });

    // The keyboard rides the LAST message of a request, after the header and
    // the payload chunks, so waiting for "APPROVAL REQUIRED" would race it.
    await until(
      () =>
        bot2.requests.some(
          (entry) => entry.method === "sendMessage" && entry.body["reply_markup"] !== undefined,
        ),
      "the listener to deliver the request and its buttons",
    );
    bot2.queueUpdate(
      callbackUpdate({ data: bot2.callbackDataFor(ACTION, "grant"), chatId: CHAT }),
    );
    const granted = await decided;
    setupCaptured.push({ label: "listener stderr", text: granted.stderr });
    assert.equal(granted.code, 0, granted.stderr);

    const printed = /execution token for \S+: (\S+)/u.exec(granted.stdout);
    assert.ok(printed !== null, `no execution token on the listener's stdout: ${granted.stdout}`);
    const token = printed[1] as string;

    const sent = await runSetupWalk(
      [
        "adapter",
        "email",
        ACTION,
        "--token",
        token,
        "--payload",
        "message.json",
        "--as",
        AGENT,
        "--vault",
        setupVault,
        "--json",
      ],
      {
        [PASS_ENV]: passphrase,
        // The operator's own trust decision, made outside the runtime, exactly
        // as the walk above makes it.
        NODE_EXTRA_CA_CERTS: FIXTURE_CA,
      },
    );
    assert.equal(sent.code, 0, `${sent.stdout}${sent.stderr}`);
    assert.equal(smtp2.connections, 1, "exactly one SMTP session was expected");
    assert.equal(smtp2.last()?.authenticated, "PLAIN");

    // -----------------------------------------------------------------------
    // (6) the two paths reach the same log, and nothing leaked.
    const tailed = runSetupWalkSync(["log", "tail", "-n", "10", "--json"]);
    assert.equal(tailed.code, 0, tailed.stderr);
    const records = (JSON.parse(tailed.stdout) as { records: Record<string, unknown>[] }).records;
    assert.equal(manualShape.length, 6, "the manual walk recorded no shape to compare against");
    assert.deepEqual(
      records.map((record) => [String(record["event"]), String(record["actor"])]),
      manualShape,
      "the setup path produced a different log from the hand-exported path",
    );

    const verified = runSetupWalkSync(["log", "verify", "--json"]);
    assert.equal(verified.code, 0, verified.stderr);
    assert.equal((JSON.parse(verified.stdout) as Record<string, unknown>)["status"], "clean");

    // The sweep, over this walk's own corpus. `approval env` is exempt and only
    // `approval env`: it is the verb whose job is to emit these values, and it
    // was run above with its output kept out of `setupCaptured`.
    const logBytes = readFileSync(setupLog, "utf8");
    for (const [label, needle] of [
      ["SMTP password", SMTP_PASSWORD],
      ["vault passphrase", PASSPHRASE],
      ["bot token", BOT_TOKEN],
    ] as const) {
      assert.equal(logBytes.includes(needle), false, `the ${label} reached the log`);
      for (const { label: where, text } of setupCaptured) {
        assert.equal(text.includes(needle), false, `the ${label} appeared in ${where}`);
      }
    }
  } finally {
    await bot2.close();
    await smtp2.close();
  }
});
