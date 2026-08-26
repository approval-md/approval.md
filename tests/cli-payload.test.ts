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
    "      est_cost_usd: 0.02",
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
