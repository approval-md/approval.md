/**
 * `approval adapter email` CLI tests (APRV-69).
 *
 * Every case spawns the real compiled CLI as a child process, because the
 * contract under test is what an agent observes: the exit code, the bytes on
 * each stream, and the lines that end up in the log. No log line and no vault
 * entry is written by hand — every one is produced by the CLI — and the child
 * connects to `tests/smtp-mock.ts` on 127.0.0.1, never to a network.
 *
 * The suite-wide sweep from `tests/cli-vault.test.ts` runs here too: everything
 * the CLI printed, across every case, is scanned at the end for the SMTP
 * password and the vault passphrase, and so is every log the suite wrote.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { ROOT_HELP } from "../src/cli/help.js";
import { payloadHash } from "../src/core/payload.js";
import { assertLoopback, startMockSmtp } from "./smtp-mock.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const SMTP_PASSWORD = "smtp-pw-cli-aprv69-2b7e40-DO-NOT-USE";
const SMTP_USER = "chaser@approval.invalid";
const PASSPHRASE = "an operator-held passphrase for the CLI email suite";
const HUMAN = "human:carter";
const AGENT = "agent:claude";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-cli-adapter-")));
let counter = 0;

/** Everything the CLI printed, across every case. Swept at the end. */
const transcript: string[] = [];
const dirs: string[] = [];

/**
 * A PLAINTEXT listener, and that is not a shortcut.
 *
 * There is deliberately no CLI flag that relaxes TLS verification — the only
 * such option lives on `emailAdapter` and `tests/adapter-email.test.ts` pins its
 * default to strict — so a CLI child cannot be told to accept the mock's
 * self-signed fixture certificate. The TLS paths are exercised in-process by
 * that suite; what this one is about is the CLI's own wiring: flags, exit codes,
 * the JSON shapes, and the two log events. So the vault here says
 * smtp.security: "none", and the adapter's refusal to authenticate over a
 * cleartext socket is itself one of the cases below.
 */
const mock = await startMockSmtp({ tls: "none", advertiseStarttls: false });
assertLoopback(mock.host);

after(async () => {
  await mock.close();

  const said = transcript.join("\n");
  for (const [label, needle] of [
    ["SMTP password", SMTP_PASSWORD],
    ["vault passphrase", PASSPHRASE],
  ] as const) {
    assert.equal(
      said.includes(needle),
      false,
      `the ${label} appeared in this suite's captured CLI output (SPEC.md §11.1 invariant 3)`,
    );
  }
  for (const dir of dirs) {
    const log = join(dir, ".approval", "log", "events.jsonl");
    if (!existsSync(log)) continue;
    const raw = readFileSync(log, "utf8");
    for (const needle of [SMTP_PASSWORD, PASSPHRASE]) {
      assert.equal(raw.includes(needle), false, `a secret reached ${log}`);
    }
  }

  rmSync(scratch, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the CLI. **Asynchronous, and it has to be.**
 *
 * The mock SMTP server runs on this process's event loop, so a `spawnSync` here
 * would block the very loop the child is waiting on: the child would connect,
 * the greeting would never arrive, and the adapter would sit out its whole
 * timeout before failing. Every case therefore awaits a real child.
 */
async function runCli(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
  stdin = "",
): Promise<Run> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  for (const name of ["APPROVAL_HUMAN", "APPROVAL_VAULT_PASSPHRASE"]) {
    if (env[name] === undefined) delete childEnv[name];
  }
  const run = await new Promise<Run>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], { cwd, env: childEnv });
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
    child.on("close", (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
  transcript.push(run.stdout, run.stderr);
  return run;
}

const GREEN = { APPROVAL_HUMAN: HUMAN, APPROVAL_VAULT_PASSPHRASE: PASSPHRASE };

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
  "```",
  "",
].join("\n");

interface Ready {
  dir: string;
  actionKey: string;
  token: string;
  payloadFile: string;
  payload: Record<string, unknown>;
}

/**
 * A working directory holding an attested policy, a registered and granted
 * email action, a vault pointing at the mock, and the payload on disk.
 * Everything through the real CLI.
 */
async function ready(
  overrides: { port?: number; withCredentials?: boolean } = {},
): Promise<Ready> {
  counter += 1;
  const dir = join(scratch, `case-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");

  const actionKey = `task-042:chaser-${String(counter)}`;
  const payload = {
    from: "carter@approval.invalid",
    to: ["agency@vendor.invalid"],
    subject: "Deposit chaser",
    body: "The deposit is overdue.\n",
  };
  const payloadFile = join(dir, "payload.json");
  writeFileSync(payloadFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  const taskFile = [
    "---",
    "id: task-042",
    "title: Chase deposit refund",
    "status: In Progress",
    "approval:",
    "  origin:",
    "    app: manual",
    `    created_by: "${AGENT}"`,
    "  state: proposed",
    "  actions:",
    "    - class: communicate.email.external",
    '      summary: "Send deposit chaser"',
    "      reversible: false",
    '      est_cost_usd: "0.02"',
    `      idempotency_key: "${actionKey}"`,
    `      payload_hash: "${payloadHash(payload)}"`,
    "---",
    "",
    "## Description",
    "Body.",
    "",
  ].join("\n");
  writeFileSync(join(dir, "task-042.md"), taskFile, "utf8");

  assert.equal((await runCli(["policy", "attest", "--as", HUMAN], dir, GREEN)).code, 0);
  assert.equal((await runCli(["register", "task-042.md", "--as", AGENT], dir, GREEN)).code, 0);
  assert.equal(
    (await runCli(["request", "task-042", "--action", actionKey, "--as", AGENT], dir, GREEN)).code,
    0,
  );
  const granted = await runCli(["grant", actionKey, "--as", HUMAN, "--json"], dir, GREEN);
  assert.equal(granted.code, 0, granted.stderr);
  const token = String((JSON.parse(granted.stdout) as Record<string, unknown>)["token"]);

  const stored: [string, string][] = [
    ["smtp.host", mock.host],
    ["smtp.port", String(overrides.port ?? mock.port)],
    ["smtp.security", "none"],
  ];
  // A login pair over a cleartext session is a refusal, so it is stored only by
  // the case that asserts the refusal — and that case is also where the leak
  // sweep has a real secret to hunt for.
  if (overrides.withCredentials === true) {
    stored.push(["smtp.user", SMTP_USER], ["smtp.password", SMTP_PASSWORD]);
  }
  for (const [name, value] of stored) {
    const set = await runCli(["vault", "set", name], dir, GREEN, value);
    assert.equal(set.code, 0, set.stderr);
  }

  return { dir, actionKey, token, payloadFile, payload };
}

function events(dir: string): string[] {
  return readFileSync(join(dir, ".approval", "log", "events.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as { event: string }).event);
}

function jsonErr(run: Run): Record<string, unknown> {
  const first = run.stderr.trim().split("\n")[0] as string;
  const parsed = JSON.parse(first) as Record<string, unknown>;
  return (parsed["error"] ?? parsed) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

test("adapter email sends the approved payload and exits 0", async () => {
  const unit = await ready();
  const before = mock.connections;

  const sent = await runCli(
    [
      "adapter",
      "email",
      unit.actionKey,
      "--token",
      unit.token,
      "--payload",
      unit.payloadFile,
      "--as",
      AGENT,
      "--json",
    ],
    unit.dir,
    GREEN,
  );
  assert.equal(sent.code, 0, `${sent.stdout}${sent.stderr}`);

  const result = JSON.parse(sent.stdout) as Record<string, unknown>;
  assert.equal(result["ok"], true);
  assert.equal(result["adapter"], "email");
  assert.equal(result["action_key"], unit.actionKey);
  assert.equal(result["outcome"], "execution.completed");
  assert.equal(result["exit_code"], 0);
  assert.equal(result["payload_hash"], payloadHash(unit.payload));
  assert.equal(result["class"], "communicate.email.external");

  assert.equal(mock.connections, before + 1, "exactly one connection was expected");
  const session = mock.last();
  assert.ok(session?.message?.includes("Subject: Deposit chaser"));
  assert.deepEqual(session?.recipients, ["agency@vendor.invalid"]);

  assert.deepEqual(events(unit.dir).slice(-2), ["execution.started", "execution.completed"]);
  assert.equal((await runCli(["log", "verify", "--json"], unit.dir, GREEN)).code, 0);
});

test("the payload can arrive on stdin, and the human-readable output names both seqs", async () => {
  const unit = await ready();
  const sent = await runCli(
    ["adapter", "email", unit.actionKey, "--token", unit.token, "--payload", "-", "--as", AGENT],
    unit.dir,
    GREEN,
    readFileSync(unit.payloadFile, "utf8"),
  );
  assert.equal(sent.code, 0, sent.stderr);
  assert.match(sent.stdout, /^sent .* execution\.started at seq \d+, execution\.completed at seq \d+$/mu);
});

// ---------------------------------------------------------------------------
// Refusals and their exit codes
// ---------------------------------------------------------------------------

test("a token that is not the minted one exits 1 and opens no connection", async () => {
  const unit = await ready();
  const before = mock.connections;
  const run = await runCli(
    [
      "adapter",
      "email",
      unit.actionKey,
      "--token",
      "not-the-token",
      "--payload",
      unit.payloadFile,
      "--as",
      AGENT,
      "--json",
    ],
    unit.dir,
    GREEN,
  );
  assert.equal(run.code, 1, run.stderr);
  const error = jsonErr(run);
  assert.equal(error["code"], "token-mismatch");
  assert.equal(error["acted"], false);
  assert.equal(mock.connections, before, "a refused token opened a socket");
});

test("a payload the grant did not bind to exits 1 with payload-mismatch", async () => {
  const unit = await ready();
  const before = mock.connections;
  writeFileSync(
    unit.payloadFile,
    JSON.stringify({ ...unit.payload, body: "different bytes" }),
    "utf8",
  );
  const run = await runCli(
    [
      "adapter",
      "email",
      unit.actionKey,
      "--token",
      unit.token,
      "--payload",
      unit.payloadFile,
      "--as",
      AGENT,
      "--json",
    ],
    unit.dir,
    GREEN,
  );
  assert.equal(run.code, 1, run.stderr);
  assert.equal(jsonErr(run)["code"], "payload-mismatch");
  assert.equal(mock.connections, before);
});

test("a send the server refuses exits 1 and records execution.failed", async () => {
  const unit = await ready();
  mock.failAt({ step: "rcpt", reply: "550 5.1.1 mailbox unavailable" });
  try {
    const run = await runCli(
      [
        "adapter",
        "email",
        unit.actionKey,
        "--token",
        unit.token,
        "--payload",
        unit.payloadFile,
        "--as",
        AGENT,
        "--json",
      ],
      unit.dir,
      GREEN,
    );
    assert.equal(run.code, 1, run.stdout);
    const error = jsonErr(run);
    assert.equal(error["code"], "adapter-failed");
    assert.equal(error["adapter_code"], "smtp-550");
    assert.equal(error["acted"], true);
    assert.equal(error["outcome"], "execution.failed");
    assert.equal(events(unit.dir).at(-1), "execution.failed");
  } finally {
    mock.failAt(null);
  }
});

test("a credential in the vault reaches no stream, even when the send is refused", async () => {
  const unit = await ready({ withCredentials: true });
  const run = await runCli(
    [
      "adapter",
      "email",
      unit.actionKey,
      "--token",
      unit.token,
      "--payload",
      unit.payloadFile,
      "--as",
      AGENT,
      "--json",
    ],
    unit.dir,
    GREEN,
  );
  // A password with a cleartext transport is refused before the socket carries
  // it, which is the rule under test as much as the leak sweep is.
  assert.equal(run.code, 1, run.stdout);
  assert.equal(jsonErr(run)["adapter_code"], "smtp-tls-failed");
  assert.equal(run.stdout.includes(SMTP_PASSWORD), false);
  assert.equal(run.stderr.includes(SMTP_PASSWORD), false);
  assert.equal(run.stderr.includes(PASSPHRASE), false);
  assert.equal(mock.last()?.presented, null, "the password went out in the clear");
});

test("an unreachable server exits 1 with smtp-connect-failed", async () => {
  const dead = 1;
  const unit = await ready({ port: dead });
  const run = await runCli(
    [
      "adapter",
      "email",
      unit.actionKey,
      "--token",
      unit.token,
      "--payload",
      unit.payloadFile,
      "--as",
      AGENT,
      "--json",
    ],
    unit.dir,
    GREEN,
  );
  assert.equal(run.code, 1, run.stdout);
  assert.equal(jsonErr(run)["adapter_code"], "smtp-connect-failed");
});

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

test("usage errors exit 2 and append nothing", async () => {
  const unit = await ready();
  const log = join(unit.dir, ".approval", "log", "events.jsonl");
  const before = readFileSync(log, "utf8");

  const cases: [string, string[], RegExp][] = [
    ["no action key", ["adapter", "email", "--token", "t", "--payload", "p"], /missing <action-key>/u],
    [
      "no token",
      ["adapter", "email", unit.actionKey, "--payload", unit.payloadFile],
      /missing --token/u,
    ],
    [
      "no payload",
      ["adapter", "email", unit.actionKey, "--token", unit.token],
      /missing --payload/u,
    ],
    [
      "a bad identity",
      [
        "adapter",
        "email",
        unit.actionKey,
        "--token",
        unit.token,
        "--payload",
        unit.payloadFile,
        "--as",
        "system:gate",
      ],
      /--as expects human:<id> or agent:<id>/u,
    ],
    [
      "an unknown flag",
      ["adapter", "email", unit.actionKey, "--tokne", unit.token],
      /unknown flag --tokne/u,
    ],
    ["an unknown adapter", ["adapter", "carrier-pigeon"], /unknown adapter/u],
  ];

  for (const [label, argv, pattern] of cases) {
    const run = await runCli([...argv, "--json"], unit.dir, GREEN);
    assert.equal(run.code, 2, `${label}: expected exit 2, got ${String(run.code)}${run.stderr}`);
    assert.match(String(jsonErr(run)["message"]), pattern, label);
  }

  // No adapter name at all, without --json: the message is prose plus the help.
  const bare = await runCli(["adapter"], unit.dir, GREEN);
  assert.equal(bare.code, 2, bare.stderr);
  assert.match(bare.stderr, /missing adapter name/u);
  assert.equal(readFileSync(log, "utf8"), before, "a usage error appended to the log");
});

test("an unreadable payload file is exit 4 and unparseable bytes are exit 2", async () => {
  const unit = await ready();
  const missing = await runCli(
    [
      "adapter",
      "email",
      unit.actionKey,
      "--token",
      unit.token,
      "--payload",
      join(unit.dir, "no-such-file.json"),
      "--json",
      "--as",
      AGENT,
    ],
    unit.dir,
    GREEN,
  );
  assert.equal(missing.code, 4, missing.stderr);
  assert.equal(jsonErr(missing)["code"], "io");

  const garbage = join(unit.dir, "garbage.json");
  writeFileSync(garbage, "{not json", "utf8");
  const bad = await runCli(
    [
      "adapter",
      "email",
      unit.actionKey,
      "--token",
      unit.token,
      "--payload",
      garbage,
      "--json",
      "--as",
      AGENT,
    ],
    unit.dir,
    GREEN,
  );
  assert.equal(bad.code, 2, bad.stderr);
  assert.match(String(jsonErr(bad)["message"]), /not valid JSON/u);
});

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

test("the help texts state the rules a reader must not have to infer", async () => {
  const unit = await ready();
  for (const [argv, claims] of [
    [["adapter", "--help"], ["HARD BOUNDARY", "single-use execution token"]],
    [
      ["adapter", "email", "--help"],
      [
        "bcc is INSIDE the hash",
        "Message-ID",
        "quoted-printable",
        "smtp.password",
        "shell history",
        "smtp-<NNN>",
      ],
    ],
  ] as const) {
    const run = await runCli([...argv], unit.dir, GREEN);
    assert.equal(run.code, 0, run.stderr);
    for (const claim of claims) {
      assert.ok(run.stdout.includes(claim), `${argv.join(" ")} --help is missing "${claim}"`);
    }
  }
});

test("the root help lists the adapter verb", async () => {
  assert.match(ROOT_HELP, /approval adapter email <action-key> --token <t> --payload <file\|->/u);
  assert.match(ROOT_HELP, /\n {2}adapter {3}execute an approved action through a side-effect adapter/u);
});
