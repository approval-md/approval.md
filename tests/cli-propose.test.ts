/**
 * `approval propose` and `approval start` (APRV-445), in the CLI-gate style:
 * every case spawns the real compiled CLI, asserts whole `--json` objects with
 * `deepEqual`, reads back the records the CLI appended, and runs `approval log
 * verify` afterwards. No log line is written by hand.
 *
 * What is pinned:
 *
 *   1. the happy path: one `task.registered` (origin `approval-propose`) and one
 *      `approval.requested` whose `action_key` is the key EXACTLY as given;
 *   2. idempotency: the same class, key and bytes append nothing; different
 *      bytes refuse `duplicate-request` while live, `payload-mismatch` after;
 *   3. the policy gate: undeclared, declared-but-closed, wildcard-only and
 *      member-closed classes all refuse `class-not-agent-requestable` and
 *      register nothing; a human-only member under an open family refuses
 *      `class-human-only` and registers nothing;
 *   4. the payload: over 256 KiB refuses `payload-too-large` (exit 2), bad JSON
 *      and non-objects are usage errors;
 *   5. autonomous classes answer `decision: autonomous` with no approval record;
 *   6. `start`: policy-authorized and grant-spending starts, single-use,
 *      requester-only, bound to the proposed bytes;
 *   7. `wait --timeout 0` answers the current state at once.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";

import { VERB_REGISTRY, type JsonSchema } from "../src/cli/verb-registry.js";
import { PROPOSE_PAYLOAD_MAX_BYTES, proposedTaskId } from "../src/core/gate.js";
import { payloadHash } from "../src/core/payload.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-cli-propose-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string): Run {
  const childEnv = { ...process.env };
  delete childEnv["APPROVAL_HUMAN"];
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: childEnv,
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

const POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "72h"',
  "  on_expiry: reject",
  "classes:",
  "  intent.publish.*:",
  "    autonomy: manual",
  "    agent_may_request: true",
  "  intent.publish.inferred.index:",
  "    autonomy: manual",
  "  intent.publish.stated.index:",
  "    autonomy: autonomous",
  "  intent.publish.closed:",
  "    autonomy: manual",
  "    agent_may_request: false",
  "  intent.publish.secret:",
  "    autonomy: human-only",
  "  communicate.email.external:",
  "    autonomy: manual",
  "```",
  "",
].join("\n");

const AGENT = "agent:av-resident";
const INFERRED = "intent.publish.inferred.index";
const STATED = "intent.publish.stated.index";
const TEXT = { text: "I want to find a climbing partner for Sunday mornings" };

function caseDir(): string {
  counter += 1;
  const dir = join(scratch, `case-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  const attested = runCli(["policy", "attest", "--as", "human:carter"], dir);
  assert.equal(attested.code, 0, attested.stderr);
  return dir;
}

function logRecords(dir: string): Record<string, unknown>[] {
  const path = join(dir, ".approval", "log", "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function events(dir: string): string[] {
  return logRecords(dir).map((record) => String(record["event"]));
}

function assertClean(dir: string): void {
  const verify = runCli(["log", "verify", "--json"], dir);
  assert.equal(verify.code, 0, verify.stderr);
  assert.equal((JSON.parse(verify.stdout) as Record<string, unknown>)["status"], "clean");
}

function jsonErr(run: Run): Record<string, unknown> {
  const parsed = JSON.parse(run.stderr) as Record<string, unknown>;
  return (parsed["error"] ?? parsed) as Record<string, unknown>;
}

function propose(
  dir: string,
  cls: string,
  key: string,
  payload: unknown = TEXT,
  as: string = AGENT,
): Run {
  return runCli(
    [
      "propose",
      "--class",
      cls,
      "--key",
      key,
      "--summary",
      "Publish an intention to Index",
      "--payload-json",
      typeof payload === "string" ? payload : JSON.stringify(payload),
      "--as",
      as,
      "--json",
    ],
    dir,
  );
}

function policySha256(dir: string): string {
  return createHash("sha256").update(readFileSync(join(dir, "APPROVAL.md"))).digest("hex");
}

// ---------------------------------------------------------------------------
// 1. Happy path
// ---------------------------------------------------------------------------

test("propose registers and requests in one call; action_key is the key verbatim", () => {
  const dir = caseDir();
  const key = `${INFERRED}:01928c3e-7d4a-7b21-9f00-000000000001`;
  const run = propose(dir, INFERRED, key);
  assert.equal(run.code, 0, run.stderr);
  const task = proposedTaskId(AGENT, INFERRED, key);
  const hash = payloadHash(TEXT);
  const before = logRecords(dir).length;
  assert.deepEqual(JSON.parse(run.stdout), {
    ok: true,
    task,
    action_key: key,
    class: INFERRED,
    payload_hash: hash,
    decision: "requested",
    state: "requested",
    seq: before,
    idempotent: false,
  });
  assert.match(task, /^propose:[0-9a-f]{32}$/u);

  const records = logRecords(dir);
  const registered = records.find((record) => record["event"] === "task.registered");
  assert.ok(registered !== undefined);
  assert.equal(registered["actor"], AGENT);
  assert.equal(registered["task"], task);
  assert.deepEqual((registered["payload"] as Record<string, unknown>)["actions"], [
    {
      class: INFERRED,
      summary: "Publish an intention to Index",
      idempotency_key: key,
      payload_hash: hash,
    },
  ]);

  const requested = records.find((record) => record["event"] === "approval.requested");
  assert.ok(requested !== undefined);
  assert.equal(requested["actor"], AGENT);
  assert.equal(requested["task"], task);
  assert.equal(requested["action_key"], key);
  const payload = requested["payload"] as Record<string, unknown>;
  assert.equal(payload["class"], INFERRED);
  assert.equal(payload["payload_hash"], hash);
  assert.equal(payload["summary"], "Publish an intention to Index");
  assert.equal(payload["execution"], "harness");
  assert.equal(payload["policy_sha256"], policySha256(dir));
  assert.match(String(payload["display_hash"]), /^[0-9a-f]{64}$/u);

  // The bytes are in the payload store, owner-only, and never in the log.
  const stored = join(dir, ".approval", "payloads", `${hash}.json`);
  assert.equal(readFileSync(stored, "utf8"), JSON.stringify(TEXT));
  assert.equal(statSync(stored).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, ".approval", "payloads")).mode & 0o777, 0o700);
  assert.equal(readFileSync(join(dir, ".approval", "log", "events.jsonl"), "utf8").includes("climbing"), false);
  assertClean(dir);
});

// ---------------------------------------------------------------------------
// 2. Idempotency
// ---------------------------------------------------------------------------

test("an identical retry appends nothing and answers idempotent:true with the live request", () => {
  const dir = caseDir();
  const key = `${INFERRED}:retry`;
  const first = propose(dir, INFERRED, key);
  assert.equal(first.code, 0, first.stderr);
  const count = logRecords(dir).length;

  const again = propose(dir, INFERRED, key);
  assert.equal(again.code, 0, again.stderr);
  const firstJson = JSON.parse(first.stdout) as Record<string, unknown>;
  assert.deepEqual(JSON.parse(again.stdout), { ...firstJson, idempotent: true });
  assert.equal(logRecords(dir).length, count, "a retry appended");

  // Decided requests answer from the log too, still appending nothing.
  const granted = runCli(["grant", key, "--as", "human:carter", "--json"], dir);
  assert.equal(granted.code, 0, granted.stderr);
  const afterGrant = logRecords(dir).length;
  const third = propose(dir, INFERRED, key);
  assert.equal(third.code, 0, third.stderr);
  const thirdJson = JSON.parse(third.stdout) as Record<string, unknown>;
  assert.equal(thirdJson["state"], "granted");
  assert.equal(thirdJson["idempotent"], true);
  assert.equal(logRecords(dir).length, afterGrant);
  assertClean(dir);
});

test("the same key with different bytes refuses duplicate-request while live, payload-mismatch after", () => {
  const dir = caseDir();
  const key = `${INFERRED}:rebound`;
  assert.equal(propose(dir, INFERRED, key).code, 0);
  const count = logRecords(dir).length;

  const live = propose(dir, INFERRED, key, { text: "something else entirely" });
  assert.equal(live.code, 1);
  assert.equal(jsonErr(live)["code"], "duplicate-request");
  assert.equal(logRecords(dir).length, count);

  const withdrawn = runCli(
    ["withdraw", proposedTaskId(AGENT, INFERRED, key), "--action", key, "--reason", "cancelled", "--as", AGENT, "--json"],
    dir,
  );
  assert.equal(withdrawn.code, 0, withdrawn.stderr);
  const afterWithdraw = logRecords(dir).length;
  const later = propose(dir, INFERRED, key, { text: "something else entirely" });
  assert.equal(later.code, 1);
  assert.equal(jsonErr(later)["code"], "payload-mismatch");
  assert.equal(logRecords(dir).length, afterWithdraw);
  assertClean(dir);
});

test("a withdrawn proposal is asked again by the same call, under the same registration", () => {
  const dir = caseDir();
  const key = `${INFERRED}:refile`;
  assert.equal(propose(dir, INFERRED, key).code, 0);
  const task = proposedTaskId(AGENT, INFERRED, key);
  assert.equal(
    runCli(["withdraw", task, "--action", key, "--reason", "superseded", "--as", AGENT], dir).code,
    0,
  );
  const refiled = propose(dir, INFERRED, key);
  assert.equal(refiled.code, 0, refiled.stderr);
  const parsed = JSON.parse(refiled.stdout) as Record<string, unknown>;
  assert.equal(parsed["state"], "requested");
  assert.equal(parsed["idempotent"], false);
  assert.deepEqual(
    events(dir).filter((event) => event !== "policy.updated"),
    ["task.registered", "approval.requested", "approval.withdrawn", "approval.requested"],
  );
  assertClean(dir);
});

// ---------------------------------------------------------------------------
// 3. The policy gate
// ---------------------------------------------------------------------------

test("a class the policy has not opened to agents refuses class-not-agent-requestable and registers nothing", () => {
  const dir = caseDir();
  const before = events(dir);
  const cases: Array<[cls: string, why: RegExp]> = [
    // Not a key at all.
    ["financial.spend", /not a key of the policy's `classes` map/u],
    // Matched only by the open wildcard family: never declared by name.
    ["intent.publish.other", /not a key of the policy's `classes` map/u],
    // Declared by name, and nothing opens it.
    ["communicate.email.external", /nor any declared `<prefix>\.\*` family/u],
    // Declared by name and closed by its own line under an open family.
    ["intent.publish.closed", /"intent\.publish\.closed" sets agent_may_request: false/u],
  ];
  for (const [cls, why] of cases) {
    const run = propose(dir, cls, `${cls}:k`);
    assert.equal(run.code, 1, `${cls}: ${run.stderr}`);
    const error = jsonErr(run);
    assert.equal(error["code"], "class-not-agent-requestable", cls);
    assert.match(String(error["message"]), why, cls);
  }
  assert.deepEqual(events(dir), before, "a refused proposal wrote something");
  assertClean(dir);
});

test("a human-only member under an open family refuses class-human-only and registers nothing", () => {
  const dir = caseDir();
  const before = events(dir);
  const run = propose(dir, "intent.publish.secret", "intent.publish.secret:k");
  assert.equal(run.code, 1, run.stderr);
  assert.equal(jsonErr(run)["code"], "class-human-only");
  assert.deepEqual(events(dir), before);
});

test("a wildcard class name is not a concrete class", () => {
  const dir = caseDir();
  const run = propose(dir, "intent.publish.*", "k");
  assert.equal(run.code, 1);
  assert.equal(jsonErr(run)["code"], "envelope-invalid");
});

test("propose refuses on an unattested policy and writes nothing", () => {
  counter += 1;
  const dir = join(scratch, `case-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  const run = propose(dir, INFERRED, `${INFERRED}:k`);
  assert.equal(run.code, 1);
  assert.equal(jsonErr(run)["code"], "policy-not-attested");
  assert.deepEqual(events(dir), []);
});

// ---------------------------------------------------------------------------
// 4. The payload
// ---------------------------------------------------------------------------

test("an oversized payload refuses payload-too-large at exit 2; bad JSON and non-objects are usage errors", () => {
  const dir = caseDir();
  const before = events(dir);
  const big = JSON.stringify({ text: "x".repeat(PROPOSE_PAYLOAD_MAX_BYTES) });
  const oversized = propose(dir, INFERRED, `${INFERRED}:big`, big);
  assert.equal(oversized.code, 2);
  assert.equal(jsonErr(oversized)["code"], "payload-too-large");

  const notJson = propose(dir, INFERRED, `${INFERRED}:bad`, "{text: nope");
  assert.equal(notJson.code, 2);
  assert.equal(jsonErr(notJson)["code"], "usage");
  assert.match(String(jsonErr(notJson)["message"]), /not valid JSON/u);

  for (const value of ['"just a string"', "[1,2]", "null", "42"]) {
    const run = propose(dir, INFERRED, `${INFERRED}:shape`, value);
    assert.equal(run.code, 2, value);
    assert.match(String(jsonErr(run)["message"]), /must be a JSON object/u, value);
  }

  // Exactly at the limit is admitted (the size is the text as sent).
  const pad = PROPOSE_PAYLOAD_MAX_BYTES - JSON.stringify({ text: "" }).length;
  const atLimit = propose(dir, INFERRED, `${INFERRED}:edge`, JSON.stringify({ text: "y".repeat(pad) }));
  assert.equal(atLimit.code, 0, atLimit.stderr);

  assert.deepEqual(events(dir).slice(0, before.length), before);
  assertClean(dir);
});

test("missing flags are usage errors", () => {
  const dir = caseDir();
  for (const [args, message] of [
    [["propose", "--key", "k", "--summary", "s", "--payload-json", "{}"], /missing --class/u],
    [["propose", "--class", INFERRED, "--summary", "s", "--payload-json", "{}"], /missing --key/u],
    [["propose", "--class", INFERRED, "--key", "k", "--payload-json", "{}"], /missing --summary/u],
    [["propose", "--class", INFERRED, "--key", "k", "--summary", "s"], /missing --payload-json/u],
  ] as Array<[string[], RegExp]>) {
    const run = runCli([...args, "--as", AGENT, "--json"], dir);
    assert.equal(run.code, 2, args.join(" "));
    assert.match(String(jsonErr(run)["message"]), message);
  }
});

// ---------------------------------------------------------------------------
// 5 and 6. Autonomous classes, and start
// ---------------------------------------------------------------------------

test("an autonomous class answers decision autonomous with no approval record; start records it once", () => {
  const dir = caseDir();
  const key = `${STATED}:01928c3e-0000-7000-8000-000000000002`;
  const run = propose(dir, STATED, key);
  assert.equal(run.code, 0, run.stderr);
  const task = proposedTaskId(AGENT, STATED, key);
  assert.deepEqual(JSON.parse(run.stdout), {
    ok: true,
    task,
    action_key: key,
    class: STATED,
    payload_hash: payloadHash(TEXT),
    decision: "autonomous",
    state: null,
    seq: null,
    idempotent: false,
  });
  assert.deepEqual(events(dir), ["policy.updated", "task.registered"]);

  const retry = propose(dir, STATED, key);
  assert.equal(retry.code, 0);
  assert.equal((JSON.parse(retry.stdout) as Record<string, unknown>)["idempotent"], true);
  assert.deepEqual(events(dir), ["policy.updated", "task.registered"]);

  const started = runCli(
    ["start", task, "--action", key, "--payload-json", JSON.stringify(TEXT), "--as", AGENT, "--json"],
    dir,
  );
  assert.equal(started.code, 0, started.stderr);
  const all = logRecords(dir);
  const record = all[all.length - 1] as Record<string, unknown>;
  const seq = record["seq"];
  assert.deepEqual(JSON.parse(started.stdout), {
    ok: true,
    task,
    action_key: key,
    class: STATED,
    authorization: "policy",
    seq,
  });
  assert.equal(record["event"], "execution.started");
  assert.equal(record["action_key"], key);
  assert.equal((record["payload"] as Record<string, unknown>)["execution"], "harness");
  assert.equal((record["payload"] as Record<string, unknown>)["payload_hash"], payloadHash(TEXT));

  const twice = runCli(
    ["start", task, "--action", key, "--payload-json", JSON.stringify(TEXT), "--as", AGENT, "--json"],
    dir,
  );
  assert.equal(twice.code, 1);
  assert.equal(jsonErr(twice)["code"], "already-executed");
  assertClean(dir);
});

test("start spends a human's grant, only for the proposed bytes, only for the requester", () => {
  const dir = caseDir();
  const key = `${INFERRED}:granted`;
  assert.equal(propose(dir, INFERRED, key).code, 0);
  const task = proposedTaskId(AGENT, INFERRED, key);

  // Pending: no grant to spend yet.
  const early = runCli(
    ["start", task, "--action", key, "--payload-json", JSON.stringify(TEXT), "--as", AGENT, "--json"],
    dir,
  );
  assert.equal(early.code, 1);
  assert.equal(jsonErr(early)["code"], "not-granted");

  assert.equal(runCli(["grant", key, "--as", "human:carter", "--json"], dir).code, 0);

  // Different bytes from the ones a human approved.
  const swapped = runCli(
    ["start", task, "--action", key, "--payload-json", '{"text":"swapped"}', "--as", AGENT, "--json"],
    dir,
  );
  assert.equal(swapped.code, 1);
  assert.equal(jsonErr(swapped)["code"], "payload-mismatch");

  // Somebody else's proposal.
  const stranger = runCli(
    ["start", task, "--action", key, "--payload-json", JSON.stringify(TEXT), "--as", "agent:someone-else", "--json"],
    dir,
  );
  assert.equal(stranger.code, 1);
  assert.equal(jsonErr(stranger)["code"], "not-requester");

  const spent = runCli(
    ["start", task, "--action", key, "--payload-json", JSON.stringify(TEXT), "--as", AGENT, "--json"],
    dir,
  );
  assert.equal(spent.code, 0, spent.stderr);
  assert.equal((JSON.parse(spent.stdout) as Record<string, unknown>)["authorization"], "grant");
  assert.equal(events(dir).filter((event) => event === "execution.started").length, 1);
  assertClean(dir);
});

test("start refuses a manual class nobody requested: the policy authorizes nothing there", () => {
  const dir = caseDir();
  const key = `${INFERRED}:unrequested`;
  // Registered by propose but the request was withdrawn: no live authority.
  assert.equal(propose(dir, INFERRED, key).code, 0);
  const task = proposedTaskId(AGENT, INFERRED, key);
  assert.equal(runCli(["withdraw", task, "--action", key, "--as", AGENT], dir).code, 0);
  const run = runCli(
    ["start", task, "--action", key, "--payload-json", JSON.stringify(TEXT), "--as", AGENT, "--json"],
    dir,
  );
  assert.equal(run.code, 1);
  assert.equal(jsonErr(run)["code"], "not-granted");
  assert.equal(events(dir).includes("execution.started"), false);
});

// ---------------------------------------------------------------------------
// 7. wait --timeout 0
// ---------------------------------------------------------------------------

test("wait --timeout 0 reads the current state once and never sleeps", () => {
  const dir = caseDir();
  const key = `${INFERRED}:poll`;
  assert.equal(propose(dir, INFERRED, key).code, 0);
  const task = proposedTaskId(AGENT, INFERRED, key);

  const started = Date.now();
  const pending = runCli(["wait", task, "--timeout", "0", "--interval", "1h", "--json"], dir);
  assert.equal(pending.code, 6, pending.stderr);
  assert.ok(Date.now() - started < 30_000, "a zero wait slept");
  const timeout = JSON.parse(pending.stderr) as Record<string, unknown>;
  assert.equal(timeout["status"], "timeout");
  assert.deepEqual(timeout["actions"], [
    { action_key: key, state: "requested", seq: logRecords(dir).length },
  ]);

  assert.equal(runCli(["grant", key, "--as", "human:carter"], dir).code, 0);
  for (const spelling of ["0", "0s", "0ms"]) {
    const granted = runCli(["wait", task, "--timeout", spelling, "--json"], dir);
    assert.equal(granted.code, 0, `${spelling}: ${granted.stderr}`);
    assert.equal((JSON.parse(granted.stdout) as Record<string, unknown>)["status"], "granted");
  }

  // A task the log never registered is refused not-registered at exit 1
  // (APRV-428), on the zero wait exactly as on any other.
  const none = runCli(["wait", "no-such-task", "--timeout", "0", "--json"], dir);
  assert.equal(none.code, 1, none.stderr);
  assert.match(none.stderr, /not-registered/);

  // `00` and `-0` are not zero spellings.
  for (const bad of ["00", "-0", "0x"]) {
    assert.equal(runCli(["wait", task, "--timeout", bad, "--json"], dir).code, 2, bad);
  }
  assertClean(dir);
});

// ---------------------------------------------------------------------------
// The registry's frozen output shapes describe what the verbs actually print
// ---------------------------------------------------------------------------

test("propose and start --json validate against their registry output schemas", () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const schemaOf = (name: string): JsonSchema => {
    const spec = VERB_REGISTRY.find((entry) => entry.name === name && entry.subcommand === undefined);
    assert.ok(spec?.output !== null && spec?.output !== undefined, name);
    return spec.output;
  };
  const proposeShape = ajv.compile(schemaOf("propose"));
  const startShape = ajv.compile(schemaOf("start"));

  const dir = caseDir();
  const manualKey = `${INFERRED}:shape`;
  const autoKey = `${STATED}:shape`;
  const outputs = [
    propose(dir, INFERRED, manualKey),
    propose(dir, INFERRED, manualKey),
    propose(dir, STATED, autoKey),
  ];
  for (const run of outputs) {
    assert.equal(run.code, 0, run.stderr);
    const value = JSON.parse(run.stdout) as unknown;
    assert.equal(proposeShape(value), true, `${run.stdout}: ${JSON.stringify(proposeShape.errors)}`);
  }
  const started = runCli(
    ["start", proposedTaskId(AGENT, STATED, autoKey), "--action", autoKey, "--payload-json", JSON.stringify(TEXT), "--as", AGENT, "--json"],
    dir,
  );
  assert.equal(started.code, 0, started.stderr);
  const value = JSON.parse(started.stdout) as unknown;
  assert.equal(startShape(value), true, JSON.stringify(startShape.errors));
});
