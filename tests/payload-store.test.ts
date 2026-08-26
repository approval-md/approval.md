/**
 * Payload store tests (APRV-28).
 *
 * The store is the one place the payload bytes live, so the properties asserted
 * here are the ones a channel's correctness rests on:
 *
 * 1. **Round trip and idempotence.** The same material stores to the same hash,
 *    the same path and the same bytes, twice.
 * 2. **Verified on every read.** A stored file whose contents were edited is
 *    refused `hash-mismatch` and its value is never returned — and, through the
 *    tagger, is never rendered either: the request refuses `payload-mismatch`,
 *    the same word the token uses at spend time.
 * 3. **Absent is not a lie.** Nothing stored means `payload-unavailable` for a
 *    manual request, exactly as before the store existed.
 * 4. **Intake stores, everything downstream reads.** `approval request
 *    --payload` files the bytes once and `approval channel cli` and `approval
 *    render` find them with no flags at all — which is what makes QUEUE.md's
 *    pending count agree with the queue (the APRV-27 friction case, inverted).
 * 5. **The store never touches the log.** No store operation writes a byte of
 *    `events.jsonl`, and no store path is inside the directory the chain is
 *    walked from.
 *
 * Nothing here hand-writes a log line: registrations and requests go through
 * `core/gate.ts`, and the end-to-end cases spawn the real CLI.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildChannelRequest, buildPendingQueue, type TagOptions } from "../src/channels/tagging.js";
import { renderQueue } from "../src/channels/render-queue.js";
import { payloadHash } from "../src/core/payload.js";
import {
  loadPayload,
  payloadPath,
  payloadStoreDirFor,
  storePayload,
  storeReference,
  PAYLOAD_STORE_DIRNAME,
} from "../src/core/payload-store.js";
import { register, request } from "./clock-adapters.js";
import { at, attest, newScenario, scratchRoot, T0, type Scenario } from "./scenario.js";

const scratch = scratchRoot("payload-store");
after(scratch.cleanup);

/** dist/tests/payload-store.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

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
  "    limits:",
  "      per_action_usd: 1",
  "```",
  "",
].join("\n");

const TASK = "task-500";
const ACTION = `${TASK}:chaser`;
const AGENT = "agent:drafter";
const HUMAN = "human:carter";
const NOW = at(2);

/** Keys deliberately out of canonical order: the hash must not care. */
const PAYLOAD = {
  to: ["agency@example.co.uk"],
  subject: "Deposit refund chaser",
  body: "Following up on the deposit refund.",
};
const HASH = payloadHash(PAYLOAD);

// ---------------------------------------------------------------------------
// The store, on its own
// ---------------------------------------------------------------------------

test("the store dir is a sibling of the log dir, never inside it", () => {
  const logPath = join("/tmp", "home", ".approval", "log", "events.jsonl");
  const dir = payloadStoreDirFor(logPath);
  assert.equal(dir, join("/tmp", "home", ".approval", PAYLOAD_STORE_DIRNAME));
  assert.equal(dir.startsWith(join("/tmp", "home", ".approval", "log")), false);
});

test("store round trip: the material comes back, verified against its name", () => {
  const dir = join(scratch.root, "round-trip");
  const stored = storePayload(dir, PAYLOAD);
  assert.equal(stored.ok, true, JSON.stringify(stored));
  if (!stored.ok) return;

  assert.equal(stored.hash, HASH);
  assert.equal(stored.path, payloadPath(dir, HASH));

  const loaded = loadPayload(dir, HASH);
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  if (!loaded.ok) return;
  assert.deepEqual(loaded.value, PAYLOAD);
});

test("the stored bytes are the canonical form, so the file hashes to its own name", () => {
  const dir = join(scratch.root, "canonical");
  const stored = storePayload(dir, PAYLOAD);
  assert.equal(stored.ok, true);
  if (!stored.ok) return;
  const raw = readFileSync(stored.path, "utf8");
  assert.equal(payloadHash(JSON.parse(raw) as unknown), HASH);
  // Canonical: keys sorted, no whitespace. Not merely "some JSON of the value".
  assert.equal(raw.startsWith('{"body":'), true, raw.slice(0, 40));
});

test("storing is idempotent: same hash, same path, same bytes, twice", () => {
  const dir = join(scratch.root, "idempotent");
  const first = storePayload(dir, PAYLOAD);
  const bytes = first.ok ? readFileSync(first.path, "utf8") : "";
  // A differently-ordered but equal value: RFC 8785 makes them one payload.
  const second = storePayload(dir, {
    body: PAYLOAD.body,
    subject: PAYLOAD.subject,
    to: [...PAYLOAD.to],
  });
  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(second.hash, first.hash);
  assert.equal(second.path, first.path);
  assert.equal(readFileSync(second.path, "utf8"), bytes);
  assert.deepEqual(readdirSync(dir), [`${HASH}.json`]);
});

test("a tampered stored file is refused hash-mismatch and its value withheld", () => {
  const dir = join(scratch.root, "tampered");
  const stored = storePayload(dir, PAYLOAD);
  assert.equal(stored.ok, true);
  if (!stored.ok) return;

  writeFileSync(
    stored.path,
    JSON.stringify({ ...PAYLOAD, to: ["attacker@example.com"] }),
    "utf8",
  );

  const loaded = loadPayload(dir, HASH);
  assert.equal(loaded.ok, false);
  if (loaded.ok) return;
  assert.equal(loaded.code, "hash-mismatch");
  assert.equal(Object.hasOwn(loaded, "value"), false, "a mismatching read returned the value");
  assert.match(loaded.message, /will not be rendered/u);
});

test("absent, unreadable and malformed reads each say which they are", () => {
  const dir = join(scratch.root, "reads");
  const absent = loadPayload(dir, HASH);
  assert.equal(absent.ok === false && absent.code, "absent");

  const notAHash = loadPayload(dir, "nope");
  assert.equal(notAHash.ok === false && notAHash.code, "unreadable");

  storePayload(dir, PAYLOAD);
  writeFileSync(payloadPath(dir, HASH), "{not json", "utf8");
  const malformed = loadPayload(dir, HASH);
  assert.equal(malformed.ok === false && malformed.code, "unreadable");
});

test("an external reference is reported, never resolved", () => {
  const dir = join(scratch.root, "reference");
  const stored = storeReference(dir, HASH, "vault://secrets/deposit-chaser");
  assert.equal(stored.ok, true, JSON.stringify(stored));

  const loaded = loadPayload(dir, HASH);
  assert.equal(loaded.ok, false);
  if (loaded.ok) return;
  assert.equal(loaded.code, "reference");
  assert.equal(loaded.reference, "vault://secrets/deposit-chaser");
  // No fetch, no bytes, no rendering: the pointer is all a channel may show.
  assert.match(loaded.message, /must not present bytes no hash bound/u);
});

test("material RFC 8785 cannot serialize is refused, not stored under a lie", () => {
  const dir = join(scratch.root, "unserializable");
  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  const stored = storePayload(dir, cyclic);
  assert.equal(stored.ok, false);
  assert.equal(stored.ok === false && stored.code, "unserializable");
  assert.equal(existsSync(dir), false, "a refused store created the directory anyway");
});

// ---------------------------------------------------------------------------
// The gate: intake stores
// ---------------------------------------------------------------------------

interface World {
  unit: Scenario;
  tagOptions: TagOptions;
  storeDir: string;
}

/** An attested policy with `TASK` registered and nothing requested yet. */
function registered(): World {
  const unit = newScenario(scratch.root, POLICY);
  attest(unit, T0);
  const result = register(
    unit.logPath,
    {
      task: TASK,
      envelope: {
        origin: { app: "demo", created_by: AGENT },
        state: "proposed",
        actions: [
          {
            class: "communicate.email.external",
            summary: "Send the deposit chaser",
            reversible: false,
            est_cost_usd: "0.02",
            idempotency_key: ACTION,
            payload_hash: HASH,
          },
        ],
      },
    },
    T0,
    AGENT,
    unit.options,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  return {
    unit,
    tagOptions: { policy: { file: unit.policyPath } },
    storeDir: payloadStoreDirFor(unit.logPath),
  };
}

function logBytes(unit: Scenario): string {
  return existsSync(unit.logPath) ? readFileSync(unit.logPath, "utf8") : "";
}

test("request with material stores it, and the store never touches the log", () => {
  const world = registered();
  const before = logBytes(world.unit);

  const result = request(
    world.unit.logPath,
    {
      task: TASK,
      actionKey: ACTION,
      cls: "communicate.email.external",
      est_cost_usd: "0.02",
      reversible: false,
      payload: { value: PAYLOAD },
    },
    at(1),
    AGENT,
    world.unit.options,
  );
  assert.equal(result.ok, true, JSON.stringify(result));

  assert.equal(existsSync(payloadPath(world.storeDir, HASH)), true);
  // The append added exactly one line; nothing rewrote what was there.
  const afterBytes = logBytes(world.unit);
  assert.equal(afterBytes.startsWith(before), true, "the store rewrote existing log bytes");
  assert.equal(afterBytes.split("\n").filter((line) => line.length > 0).length, 3);
  // And no store file is inside the directory the chain is walked from.
  assert.equal(existsSync(join(world.unit.logPath, "..", `${HASH}.json`)), false);
  assert.deepEqual(readdirSync(join(world.unit.logPath, "..")), ["events.jsonl"]);
});

test("material that hashes to something else refuses payload-mismatch and stores nothing", () => {
  const world = registered();
  const before = logBytes(world.unit);

  const result = request(
    world.unit.logPath,
    {
      task: TASK,
      actionKey: ACTION,
      cls: "communicate.email.external",
      est_cost_usd: "0.02",
      reversible: false,
      payload: { value: { ...PAYLOAD, to: ["attacker@example.com"] } },
    },
    at(1),
    AGENT,
    world.unit.options,
  );

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, "payload-mismatch");
  assert.equal(existsSync(world.storeDir), false, "a refused request stored bytes");
  assert.equal(logBytes(world.unit), before, "a refused request appended");
});

test("a request refused for any other reason stores nothing either", () => {
  const world = registered();
  // Duplicate: the first request stores, the second is refused before phase two.
  const input = {
    task: TASK,
    actionKey: ACTION,
    cls: "communicate.email.external",
    est_cost_usd: "0.02",
    reversible: false,
    payload: { value: PAYLOAD },
  };
  assert.equal(request(world.unit.logPath, input, at(1), AGENT, world.unit.options).ok, true);
  const files = readdirSync(world.storeDir);
  const second = request(world.unit.logPath, input, at(2), AGENT, world.unit.options);
  assert.equal(second.ok === false && second.code, "duplicate-request");
  assert.deepEqual(readdirSync(world.storeDir), files, "a refused request added a store file");
});

// ---------------------------------------------------------------------------
// The tagger: the store is the fallback, and it is verified
// ---------------------------------------------------------------------------

/** One live manual request, with material stored at intake. */
function live(withMaterial: boolean): World {
  const world = registered();
  const result = request(
    world.unit.logPath,
    {
      task: TASK,
      actionKey: ACTION,
      cls: "communicate.email.external",
      est_cost_usd: "0.02",
      reversible: false,
      ...(withMaterial ? { payload: { value: PAYLOAD } } : {}),
    },
    at(1),
    AGENT,
    world.unit.options,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  return world;
}

test("with the payload stored, the tagger renders it without any --payload flag", () => {
  const world = live(true);
  const built = buildChannelRequest(world.unit.logPath, ACTION, world.tagOptions, NOW);
  assert.equal(built.ok, true, JSON.stringify(built));
  if (!built.ok) return;
  const rendering = built.request.fullPayload.value;
  assert.notEqual(rendering, null);
  assert.deepEqual(rendering?.value, PAYLOAD);
  assert.equal(rendering?.hash, HASH);
});

test("with nothing stored, a manual request is still payload-unavailable", () => {
  const world = live(false);
  const built = buildChannelRequest(world.unit.logPath, ACTION, world.tagOptions, NOW);
  assert.equal(built.ok, false);
  assert.equal(built.ok === false && built.code, "payload-unavailable");
});

test("a tampered store file is refused payload-mismatch by the tagger, never rendered", () => {
  const world = live(true);
  const forged = { ...PAYLOAD, to: ["attacker@example.com"] };
  writeFileSync(payloadPath(world.storeDir, HASH), JSON.stringify(forged), "utf8");

  const built = buildChannelRequest(world.unit.logPath, ACTION, world.tagOptions, NOW);
  assert.equal(built.ok, false);
  assert.equal(built.ok === false && built.code, "payload-mismatch");

  // And through the queue: listed as skipped, with the reason, never rendered.
  const queue = buildPendingQueue(world.unit.logPath, world.tagOptions, NOW);
  assert.equal(queue.ok, true);
  if (!queue.ok) return;
  assert.deepEqual(queue.requests, []);
  assert.equal(queue.skipped[0]?.code, "payload-mismatch");

  const render = renderQueue(world.unit.logPath, world.tagOptions, NOW);
  assert.equal(render.ok, true);
  if (!render.ok) return;
  assert.equal(render.pending, 0);
  assert.equal(render.markdown.includes("attacker@example.com"), false, "forged bytes rendered");
});

test("TagOptions.payload still overrides the store, and payloadStoreDir: null disables it", () => {
  const world = live(true);
  // The override wins: a source that answers is not second-guessed by the store.
  const overridden = buildChannelRequest(
    world.unit.logPath,
    ACTION,
    { ...world.tagOptions, payload: () => PAYLOAD },
    NOW,
  );
  assert.equal(overridden.ok, true, JSON.stringify(overridden));

  const blind = buildChannelRequest(
    world.unit.logPath,
    ACTION,
    { ...world.tagOptions, payloadStoreDir: null },
    NOW,
  );
  assert.equal(blind.ok === false && blind.code, "payload-unavailable");
});

test("a stored external reference is unavailable, and says where the payload lives", () => {
  const world = live(false);
  storeReference(world.storeDir, HASH, "vault://secrets/deposit-chaser");
  const built = buildChannelRequest(world.unit.logPath, ACTION, world.tagOptions, NOW);
  assert.equal(built.ok, false);
  if (built.ok) return;
  assert.equal(built.code, "payload-unavailable");
  assert.match(built.message, /vault:\/\/secrets\/deposit-chaser/u);
});

// ---------------------------------------------------------------------------
// End to end, through the CLI a human actually types
// ---------------------------------------------------------------------------

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string): Run {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, APPROVAL_HUMAN: HUMAN },
    timeout: 20_000,
  });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** A scratch home with policy + task file on disk, driven only through the CLI. */
function cliWorld(): { dir: string; payloadFile: string } {
  const unit = newScenario(scratch.root, POLICY);
  const taskFile = join(unit.dir, `${TASK}.md`);
  writeFileSync(
    taskFile,
    [
      "---",
      `id: ${TASK}`,
      "title: Chase the letting agency",
      "approval:",
      "  origin:",
      "    app: demo",
      `    created_by: "${AGENT}"`,
      "  state: proposed",
      "  actions:",
      "    - class: communicate.email.external",
      '      summary: "Send the deposit chaser"',
      "      reversible: false",
      '      est_cost_usd: "0.02"',
      `      idempotency_key: "${ACTION}"`,
      `      payload_hash: "${HASH}"`,
      "---",
      "",
    ].join("\n"),
    "utf8",
  );
  const payloadFile = join(unit.dir, "payload.json");
  writeFileSync(payloadFile, `${JSON.stringify(PAYLOAD, null, 2)}\n`, "utf8");

  assert.equal(runCli(["policy", "attest", "--as", HUMAN, "--json"], unit.dir).code, 0);
  assert.equal(runCli(["register", `${TASK}.md`, "--as", AGENT, "--json"], unit.dir).code, 0);
  return { dir: unit.dir, payloadFile: "payload.json" };
}

test("request --payload: one flag at intake, and every later surface just works", () => {
  const world = cliWorld();

  const requested = runCli(
    ["request", TASK, "--action", ACTION, "--payload", world.payloadFile, "--as", AGENT, "--json"],
    world.dir,
  );
  assert.equal(requested.code, 0, requested.stderr);

  const stored = join(world.dir, ".approval", PAYLOAD_STORE_DIRNAME, `${HASH}.json`);
  assert.equal(existsSync(stored), true, "request --payload stored nothing");

  // The channel, with NO --payload-dir at all.
  const channel = runCli(["channel", "cli", "--json"], world.dir);
  assert.equal(channel.code, 0, channel.stderr);
  const listed = JSON.parse(channel.stdout) as {
    pending: { action_key: { value: string } }[];
    skipped: unknown[];
  };
  assert.equal(listed.pending.length, 1);
  assert.equal(listed.pending[0]?.action_key.value, ACTION);
  assert.deepEqual(listed.skipped, []);
  assert.equal(channel.stdout.includes(PAYLOAD.body), true, "the channel showed no payload bytes");

  // The render, which has no payload flag and now needs none.
  const render = runCli(["render", "--json"], world.dir);
  assert.equal(render.code, 0, render.stderr);
  const rendered = JSON.parse(render.stdout) as Record<string, unknown>;
  assert.equal(rendered["pending"], 1);
  assert.equal(rendered["skipped"], 0);
  // The count agreement APRV-27 could not have: QUEUE.md and the queue agree.
  assert.equal(rendered["pending"], listed.pending.length);
  const queueMd = readFileSync(join(world.dir, ".approval", "QUEUE.md"), "utf8");
  assert.match(queueMd, /1 request\(s\), oldest first/u);
  assert.equal(queueMd.includes(PAYLOAD.body), false, "QUEUE.md inlined payload bytes");
});

test("request --payload with the wrong bytes refuses and writes nothing at all", () => {
  const world = cliWorld();
  const wrong = join(world.dir, "wrong.json");
  writeFileSync(wrong, JSON.stringify({ ...PAYLOAD, to: ["attacker@example.com"] }), "utf8");
  const logPath = join(world.dir, ".approval", "log", "events.jsonl");
  const before = readFileSync(logPath, "utf8");

  const refused = runCli(
    ["request", TASK, "--action", ACTION, "--payload", "wrong.json", "--as", AGENT, "--json"],
    world.dir,
  );
  assert.equal(refused.code, 1, refused.stdout);
  const error = (JSON.parse(refused.stderr.trim().split("\n")[0] as string) as {
    error: { code: string };
  }).error;
  assert.equal(error.code, "payload-mismatch");
  assert.equal(existsSync(join(world.dir, ".approval", PAYLOAD_STORE_DIRNAME)), false);
  assert.equal(readFileSync(logPath, "utf8"), before, "a refused request appended");
});

test("request --payload with unreadable or non-JSON material never reaches the gate", () => {
  const world = cliWorld();
  const logPath = join(world.dir, ".approval", "log", "events.jsonl");
  const before = readFileSync(logPath, "utf8");

  const missing = runCli(
    ["request", TASK, "--action", ACTION, "--payload", "nope.json", "--as", AGENT, "--json"],
    world.dir,
  );
  assert.equal(missing.code, 4, missing.stderr);

  writeFileSync(join(world.dir, "bad.json"), "{not json", "utf8");
  const malformed = runCli(
    ["request", TASK, "--action", ACTION, "--payload", "bad.json", "--as", AGENT, "--json"],
    world.dir,
  );
  assert.equal(malformed.code, 2, malformed.stderr);

  assert.equal(readFileSync(logPath, "utf8"), before);
});

test("request --payload - reads the material from stdin", () => {
  const world = cliWorld();
  const piped = spawnSync(
    process.execPath,
    [CLI_ENTRY, "request", TASK, "--action", ACTION, "--payload", "-", "--as", AGENT, "--json"],
    {
      cwd: world.dir,
      encoding: "utf8",
      input: JSON.stringify(PAYLOAD),
      env: { ...process.env, APPROVAL_HUMAN: HUMAN },
      timeout: 20_000,
    },
  );
  assert.equal(piped.status, 0, piped.stderr);
  assert.equal(
    existsSync(join(world.dir, ".approval", PAYLOAD_STORE_DIRNAME, `${HASH}.json`)),
    true,
  );
});
