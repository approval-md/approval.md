/**
 * `approval payload hash` CLI tests (APRV-29) — spawned as a real child process,
 * because what is under test is what a human or an adapter observes: the bytes on
 * stdout, the exit code, and above all whether the hash printed here is the same
 * hash the gate records.
 *
 * The load-bearing case is `equals the payload_hash a real grant recorded`: the
 * verb exists so nobody has to reimplement JCS + SHA-256 or import an internal
 * module, and a verb that printed a *nearly* right hash would be worse than no
 * verb at all. So that case builds a real task through the real gate, in a temp
 * directory, and compares the log's recorded binding against the CLI's stdout.
 * No log line is written by hand.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  agentmailAdapter,
  DEFAULT_AGENTMAIL_CREDENTIAL_NAMES,
} from "../src/adapters/agentmail.js";
import { inMemoryCredentials, type JsonValue } from "../src/adapters/contract.js";
import { commandPayload } from "../src/cli/payload.js";
import { canonicalize } from "../src/core/jcs.js";
import { payloadHash } from "../src/core/payload.js";
import { assertLocal, startMockAgentmail } from "./agentmail-mock.js";

/** dist/tests/cli-payload.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-cli-payload-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string, input?: string): Run {
  const childEnv = { ...process.env };
  delete childEnv["APPROVAL_HUMAN"];
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: childEnv,
    ...(input === undefined ? {} : { input }),
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function caseDir(): string {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The payload of `examples/telegram-demo.md`, and the hash that doc claims. */
const DEMO_PAYLOAD = [
  "{",
  '  "to": ["agency@example.co.uk"],',
  '  "subject": "Deposit refund chaser <second> & final",',
  '  "body": "Following up on the deposit refund, now 21 days past the scheme deadline."',
  "}",
  "",
].join("\n");

const DEMO_HASH = "ce0edde10155883e7c6c7dceea7c5717889b590134eb6bb4b1be1329441f4b17";

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

function taskFile(payloadHash: string): string {
  return [
    "---",
    "id: task-042",
    "title: Chase deposit refund",
    "status: In Progress",
    "approval:",
    "  origin:",
    "    app: example-capture",
    '    created_by: "human:carter"',
    "  state: proposed",
    "  actions:",
    "    - class: communicate.email.external",
    '      summary: "Send deposit chaser"',
    "      reversible: false",
    '      est_cost_usd: "0.02"',
    '      idempotency_key: "task-042:chaser"',
    `      payload_hash: "${payloadHash}"`,
    "---",
    "",
    "## Description",
    "Body.",
    "",
  ].join("\n");
}

// ===========================================================================
// The hash itself
// ===========================================================================

test("hashes a JSON file and prints the 64-hex binding on stdout", () => {
  const dir = caseDir();
  writeFileSync(join(dir, "payload.json"), DEMO_PAYLOAD, "utf8");

  const run = runCli(["payload", "hash", "payload.json"], dir);

  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, `${DEMO_HASH}\n`);
  assert.equal(run.stderr, "");
});

test("- reads the payload from stdin and agrees with the file path byte for byte", () => {
  const dir = caseDir();
  writeFileSync(join(dir, "payload.json"), DEMO_PAYLOAD, "utf8");

  const fromFile = runCli(["payload", "hash", "payload.json"], dir);
  // Reordered keys and different whitespace: the same VALUE, so the same hash.
  const reordered = JSON.stringify({
    body: "Following up on the deposit refund, now 21 days past the scheme deadline.",
    subject: "Deposit refund chaser <second> & final",
    to: ["agency@example.co.uk"],
  });
  const fromStdin = runCli(["payload", "hash", "-"], dir, reordered);

  assert.equal(fromStdin.code, 0, fromStdin.stderr);
  assert.equal(fromStdin.stdout, fromFile.stdout);
  assert.equal(fromStdin.stdout, `${DEMO_HASH}\n`);
});

test("--json prints exactly {ok,hash}", () => {
  const dir = caseDir();
  writeFileSync(join(dir, "payload.json"), DEMO_PAYLOAD, "utf8");

  const run = runCli(["payload", "hash", "payload.json", "--json"], dir);

  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { ok: true, hash: DEMO_HASH });
});

// ===========================================================================
// THE case: the same hash the gate records
// ===========================================================================

test("prints the payload_hash a real request and grant record for the same bytes", () => {
  const dir = caseDir();
  writeFileSync(join(dir, "payload.json"), DEMO_PAYLOAD, "utf8");
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");

  const hashRun = runCli(["payload", "hash", "payload.json"], dir);
  assert.equal(hashRun.code, 0, hashRun.stderr);
  const hash = hashRun.stdout.trim();

  // The declared binding is the hash this verb printed, and nothing else.
  writeFileSync(join(dir, "task-042.md"), taskFile(hash), "utf8");

  assert.equal(runCli(["policy", "attest", "--as", "human:carter"], dir).code, 0);
  assert.equal(runCli(["register", "task-042.md", "--as", "agent:claude"], dir).code, 0);
  const requested = runCli(
    [
      "request",
      "task-042",
      "--action",
      "task-042:chaser",
      "--as",
      "agent:claude",
      "--payload",
      "payload.json",
    ],
    dir,
  );
  assert.equal(requested.code, 0, requested.stderr);
  const granted = runCli(["grant", "task-042:chaser", "--as", "human:carter", "--json"], dir);
  assert.equal(granted.code, 0, granted.stderr);

  const records = readFileSync(join(dir, ".approval", "log", "events.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  const bindings = records
    .filter((record) => record["event"] === "approval.requested" || record["event"] === "approval.granted")
    .map((record) => (record["payload"] as Record<string, unknown>)["payload_hash"]);

  assert.equal(bindings.length, 2);
  for (const recorded of bindings) assert.equal(recorded, hash);

  // And the store filed the bytes under that same name (APRV-28).
  const stored = readFileSync(join(dir, ".approval", "payloads", `${hash}.json`), "utf8");
  assert.deepEqual(JSON.parse(stored), JSON.parse(DEMO_PAYLOAD));

  const verify = runCli(["log", "verify", "--json"], dir);
  assert.equal(verify.code, 0, verify.stderr);
});

// ===========================================================================
// Refusals
// ===========================================================================

test("non-JSON bytes are a usage error (exit 2) that says why there is no hash", () => {
  const dir = caseDir();
  writeFileSync(join(dir, "note.txt"), "just some prose, not JSON\n", "utf8");

  const run = runCli(["payload", "hash", "note.txt"], dir);

  assert.equal(run.code, 2);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /is not valid JSON/u);
  assert.match(run.stderr, /RFC 8785/u);
});

test("empty stdin is a usage error (exit 2), not a hash of nothing", () => {
  const dir = caseDir();

  const run = runCli(["payload", "hash", "-", "--json"], dir, "");

  assert.equal(run.code, 2);
  assert.equal(run.stdout, "");
  const error = (JSON.parse(run.stderr) as Record<string, unknown>)["error"] as Record<
    string,
    unknown
  >;
  assert.equal(error["code"], "usage");
  assert.match(String(error["message"]), /empty/u);
});

test("a missing file is an I/O error (exit 4)", () => {
  const dir = caseDir();

  const run = runCli(["payload", "hash", "nope.json"], dir);

  assert.equal(run.code, 4);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /could not be read/u);
});

test("a missing argument, an extra argument and an unknown subcommand each exit 2", () => {
  const dir = caseDir();
  writeFileSync(join(dir, "payload.json"), DEMO_PAYLOAD, "utf8");

  const missing = runCli(["payload", "hash"], dir);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /missing <file> argument/u);

  const extra = runCli(["payload", "hash", "payload.json", "payload.json"], dir);
  assert.equal(extra.code, 2);
  assert.match(extra.stderr, /unexpected argument/u);

  const unknown = runCli(["payload", "digest", "payload.json"], dir);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown subcommand/u);

  const bare = runCli(["payload"], dir);
  assert.equal(bare.code, 2);
  assert.match(bare.stderr, /missing subcommand/u);
});

// ===========================================================================
// Help
// ===========================================================================

test("--help names the three places a payload_hash goes, and the exit table", () => {
  const dir = caseDir();

  const run = runCli(["payload", "hash", "--help"], dir);

  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /RFC 8785/u);
  assert.match(run.stdout, /SHA-256/u);
  // Destination 1: the declaration and the log.
  assert.match(run.stdout, /payload_hash\s+in a task file's action declaration/u);
  // Destination 2: request --payload, which hashes and verifies for you.
  assert.match(run.stdout, /approval request --payload/u);
  // Destination 3: the spend.
  assert.match(run.stdout, /approval run --payload-hash/u);
  assert.match(run.stdout, /MOST FLOWS NEVER NEED THIS VERB/u);
  // APRV-91: the frozen table is printed by `approval --help` alone.
  assert.match(run.stdout, /exit codes: approval --help/u);
});

test("approval run --help says --payload-hash is checked, never obeyed", () => {
  // APRV-140: the flag used to be an override, and the help promoted it as the
  // way to state a content-shaped payload. It is a CHECK now — run always
  // hashes the argv and cwd it is about to spawn — and the help says so, because
  // an agent that read the old text would build an invocation that refuses.
  const dir = caseDir();

  const run = runCli(["run", "--help"], dir);

  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /CHECKED and never trusted/u);
  assert.match(run.stdout, /payload-mismatch/u);
  assert.match(run.stdout, /argv array and cwd/u);
});

// ===========================================================================
// payload agentmail-draft (APRV-223)
// ===========================================================================

/**
 * The draft snapshot is exercised IN-PROCESS against the loopback AgentMail
 * mock, and not through `spawnSync` like everything above it.
 *
 * Two reasons, and the first is fatal: the mock runs on this process's event
 * loop, so a `spawnSync` child would wait for a greeting this process is
 * blocked from sending. The second is what the case is actually for — the
 * printed bytes have to hash to what the ADAPTER records for the same draft,
 * and the honest way to show that is to hand the printed payload to the real
 * `agentmailAdapter` and read its receipt.
 */

const AGENTMAIL_KEY = "am-key-cli-payload-aprv223-6f31c8-DO-NOT-USE";
const AGENTMAIL_INBOX = "chaser@approval.invalid";

const agentmailMock = await startMockAgentmail({
  apiKey: AGENTMAIL_KEY,
  inboxId: AGENTMAIL_INBOX,
});

after(async () => {
  await agentmailMock.close();
});

interface Printed {
  code: number;
  out: string;
  err: string;
}

/** The verb, in this process, with the environment it is handed and no other. */
async function payloadVerb(argv: string[], env: NodeJS.ProcessEnv): Promise<Printed> {
  let out = "";
  let err = "";
  const code = await commandPayload(
    argv,
    {
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
    },
    caseDir(),
    { env },
  );
  agentmailTranscript.push(out, err);
  return { code, out, err };
}

/** Everything the verb printed in this section. Swept for the key at the end. */
const agentmailTranscript: string[] = [];

after(() => {
  assert.equal(
    agentmailTranscript.join("\n").includes(AGENTMAIL_KEY),
    false,
    "the agent's AgentMail key appeared in this verb's output (SPEC.md §11.1 invariant 3)",
  );
});

const DRAFT_ENV: NodeJS.ProcessEnv = {
  AGENTMAIL_API_KEY: AGENTMAIL_KEY,
  AGENTMAIL_API_BASE: assertLocal(agentmailMock.url),
};

test("the printed snapshot hashes to what the adapter records for the same draft", async () => {
  agentmailMock.setDraft("draft_1", {
    to: ["agency@example.co.uk"],
    cc: ["me@example.co.uk"],
    subject: "Deposit refund chaser <second> & final",
    text: "Following up on the deposit refund, now 21 days past the deadline.",
  });

  const printed = await payloadVerb(
    ["agentmail-draft", AGENTMAIL_INBOX, "draft_1"],
    DRAFT_ENV,
  );
  assert.equal(printed.code, 0, printed.err);

  // The bytes are the canonical serialization, so they are byte-identical to
  // what the runtime hashes: no re-serialization stands between them.
  const payload = JSON.parse(printed.out) as Record<string, unknown>;
  assert.equal(printed.out, `${canonicalize(payload)}\n`);
  assert.deepEqual(Object.keys(payload).sort(), [
    "cc",
    "draft_id",
    "inbox_id",
    "subject",
    "text",
    "to",
  ]);

  // THE case: the adapter, given these bytes, finds no drift against the same
  // draft and records the hash of exactly these bytes.
  const outcome = await agentmailAdapter({
    apiBase: assertLocal(agentmailMock.url),
    timeoutMs: 5_000,
  }).act({
    actionKey: "task-042:chaser",
    payload: payload as JsonValue,
    credentials: inMemoryCredentials({
      [DEFAULT_AGENTMAIL_CREDENTIAL_NAMES.apiKey]: AGENTMAIL_KEY,
      [DEFAULT_AGENTMAIL_CREDENTIAL_NAMES.inboxId]: AGENTMAIL_INBOX,
    }),
  });
  assert.equal(outcome.ok, true, outcome.ok ? "" : `${outcome.code}: ${outcome.message}`);
  const detail = (outcome.ok ? outcome.detail : {}) as Record<string, unknown>;
  assert.equal(detail["mode"], "draft");
  assert.equal(detail["payload_hash"], payloadHash(payload));
});

test("an empty cc is omitted, so a snapshot of it is not drift", async () => {
  agentmailMock.setDraft("draft_2", {
    to: ["agency@example.co.uk"],
    cc: [],
    bcc: null,
    subject: "No copies",
    text: "One recipient.",
  });

  const printed = await payloadVerb(
    ["agentmail-draft", AGENTMAIL_INBOX, "draft_2"],
    DRAFT_ENV,
  );
  assert.equal(printed.code, 0, printed.err);
  const payload = JSON.parse(printed.out) as Record<string, unknown>;
  assert.equal("cc" in payload, false, "an empty cc was carried into the payload");
  assert.equal("bcc" in payload, false, "a null bcc was carried into the payload");
});

test("the API base can be a flag, and the request carries the agent's key", async () => {
  agentmailMock.setDraft("draft_3", {
    to: ["agency@example.co.uk"],
    subject: "Flagged",
    text: "Read over --api-base.",
  });

  const postsBefore = agentmailMock.posts().length;
  const printed = await payloadVerb(
    [
      "agentmail-draft",
      AGENTMAIL_INBOX,
      "draft_3",
      "--api-base",
      assertLocal(agentmailMock.url),
    ],
    { AGENTMAIL_API_KEY: AGENTMAIL_KEY },
  );
  assert.equal(printed.code, 0, printed.err);

  const read = agentmailMock.requestsFor("draft").at(-1);
  assert.equal(read?.method, "GET");
  assert.equal(read?.authorization, `Bearer ${AGENTMAIL_KEY}`);
  // A snapshot spends nothing and sends nothing: the only POST this suite has
  // seen is the adapter's own, from the case above.
  assert.equal(agentmailMock.posts().length, postsBefore);
});

test("an unset AGENTMAIL_API_KEY refuses with a code, and reads no draft", async () => {
  const before = agentmailMock.requests.length;

  const plain = await payloadVerb(["agentmail-draft", AGENTMAIL_INBOX, "draft_1"], {});
  assert.equal(plain.code, 2);
  assert.equal(plain.out, "");
  assert.match(plain.err, /AGENTMAIL_API_KEY is unset or empty/u);

  const json = await payloadVerb(
    ["agentmail-draft", AGENTMAIL_INBOX, "draft_1", "--json"],
    { AGENTMAIL_API_KEY: "   " },
  );
  assert.equal(json.code, 2);
  const error = (JSON.parse(json.err) as { error: { code: string; message: string } }).error;
  assert.equal(error.code, "agentmail-api-key-unset");

  assert.equal(
    agentmailMock.requests.length,
    before,
    "a verb with no key still contacted AgentMail",
  );
});

test("a draft that is gone is agentmail-draft-missing at exit 1", async () => {
  const json = await payloadVerb(
    ["agentmail-draft", AGENTMAIL_INBOX, "no_such_draft", "--json"],
    DRAFT_ENV,
  );
  assert.equal(json.code, 1);
  assert.equal(json.out, "");
  const error = (JSON.parse(json.err) as { error: { code: string; message: string } }).error;
  assert.equal(error.code, "agentmail-draft-missing");
});

test("a draft that cannot be sent as it stands is refused, not printed", async () => {
  agentmailMock.setDraft("draft_empty", { to: [], subject: "Nobody", text: "" });

  const json = await payloadVerb(
    ["agentmail-draft", AGENTMAIL_INBOX, "draft_empty", "--json"],
    DRAFT_ENV,
  );
  assert.equal(json.code, 1);
  assert.equal(json.out, "");
  const error = (JSON.parse(json.err) as { error: { code: string } }).error;
  assert.equal(error.code, "agentmail-draft-unusable");
});

test("the arguments and the help are what the verb says they are", async () => {
  const missing = await payloadVerb(["agentmail-draft", AGENTMAIL_INBOX], DRAFT_ENV);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /missing <inbox-id> <draft-id>/u);

  const extra = await payloadVerb(
    ["agentmail-draft", AGENTMAIL_INBOX, "draft_1", "spare"],
    DRAFT_ENV,
  );
  assert.equal(extra.code, 2);
  assert.match(extra.err, /unexpected argument/u);

  const help = await payloadVerb(["agentmail-draft", "--help"], {});
  assert.equal(help.code, 0);
  assert.match(help.out, /approval payload agentmail-draft —/u);
  // The two claims a reader must not have to infer: whose key this is, and
  // that the verb sends nothing.
  assert.match(help.out, /AGENTMAIL_API_KEY/u);
  assert.match(help.out, /SENDS NOTHING/u);
});
