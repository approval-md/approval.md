/**
 * The daemon's pure projections (APRV-39), against real logs and injected
 * instants.
 *
 * `tests/daemon.test.ts` drives the daemon as a process and asserts what it left
 * behind; this file asserts the *decisions* underneath it, where an injected
 * instant replaces wall-clock waiting. Every log is still built through the real
 * append path — the CLI's own verbs, spawned — because a projection tested
 * against a hand-assembled record list would be tested against records the
 * runtime would never have written.
 *
 * The TTL cases are the reason this file exists: `requestState` takes the moment
 * the question is asked as a parameter, so a lapse can be examined at any instant
 * without a single second of wall time, and the process-level tests are left to
 * prove only that the daemon reaches the same answers on its own clock.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

import type { EventRecord } from "../src/core/log.js";
import { runPayloadHash } from "../src/core/payload.js";
import { readVerifiedRecords } from "../src/core/state.js";
import {
  ENVELOPE_STATES,
  driftAlreadyLogged,
  isEnvelopeState,
  lapsedRequests,
  registeredActionKeys,
  taskEnvelopeState,
} from "../src/daemon/projection.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-daemon-proj-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * The command every `run` in this suite spawns, and therefore what the declared
 * actions bind to (APRV-140: `run` recomputes the hash from the argv and cwd it
 * is about to spawn, and refuses any other value).
 */
const CHILD = [process.execPath, "-e", "process.exit(0)"];
const HOUR_MS = 3_600_000;

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
  "  files.write.*:",
  "    autonomy: supervised",
  "  communicate.email.external:",
  "    autonomy: manual",
  "```",
  "",
].join("\n");

function taskFile(binding: string): string {
  return [
  "---",
  "id: task-042",
  "title: Chase deposit refund",
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
  `      payload_hash: "${binding}"`,
  "    - class: communicate.email.external",
  '      summary: "Send the follow-up"',
  "      reversible: false",
  "      est_cost_usd: 0.02",
  '      idempotency_key: "task-042:followup"',
  `      payload_hash: "${binding}"`,
  "    - class: files.write.local",
  '      summary: "Write the draft"',
  "      reversible: true",
  "      est_cost_usd: 0.01",
  '      idempotency_key: "task-042:draft"',
  `      payload_hash: "${binding}"`,
  "---",
  "",
  "Body.",
  "",
  ].join("\n");
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string): Run {
  const env = { ...process.env };
  delete env["APPROVAL_HUMAN"];
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env,
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function ok(args: string[], cwd: string): Run {
  const run = runCli(args, cwd);
  assert.equal(run.code, 0, `${args.join(" ")}: ${run.stderr}`);
  return run;
}

/** An attested, registered world. Every record in it was written by the CLI. */
function world(): string {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(join(dir, "backlog", "tasks"), { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  writeFileSync(
    join(dir, "backlog", "tasks", "task-042.md"),
    taskFile(runPayloadHash(CHILD, dir)),
    "utf8",
  );
  ok(["policy", "attest", "--as", "human:carter"], dir);
  return dir;
}

function logPath(dir: string): string {
  return join(dir, ".approval", "log", "events.jsonl");
}

/** The verified records, read the one sanctioned way. */
function verified(dir: string): EventRecord[] {
  const read = readVerifiedRecords(logPath(dir));
  assert.equal(read.ok, true, read.ok ? "" : read.message);
  return read.ok ? read.records : [];
}

/** The instant the last record was written, plus `offsetMs`. */
function after_(records: EventRecord[], offsetMs: number): string {
  const last = records[records.length - 1];
  assert.ok(last !== undefined, "the log is empty");
  return new Date(Date.parse(last.ts) + offsetMs).toISOString();
}

// ===========================================================================
// The vocabulary
// ===========================================================================

test("ENVELOPE_STATES is exactly envelope.schema.json's state enum", () => {
  const schema = JSON.parse(
    readFileSync(join(REPO_ROOT, "schema", "envelope.schema.json"), "utf8"),
  ) as { properties: { state: { enum: string[] } } };
  assert.deepEqual([...ENVELOPE_STATES], schema.properties.state.enum);
  for (const state of schema.properties.state.enum) assert.equal(isEnvelopeState(state), true);
  assert.equal(isEnvelopeState("nonsense"), false);
  assert.equal(isEnvelopeState(7), false);
});

// ===========================================================================
// taskEnvelopeState (SPEC.md §6.3)
// ===========================================================================

test("an unregistered task projects to proposed, and its action list is empty", () => {
  const dir = world();
  const records = verified(dir);
  const projection = taskEnvelopeState(records, "task-042", after_(records, 0), HOUR_MS);
  assert.equal(projection.state, "proposed");
  assert.equal(projection.registered, false);
  assert.deepEqual(projection.actions, []);
  assert.deepEqual(registeredActionKeys(records, "task-042"), []);
});

test("registration alone is still proposed, and declares every action key", () => {
  const dir = world();
  ok(["register", join("backlog", "tasks", "task-042.md"), "--as", "agent:claude"], dir);
  const records = verified(dir);
  const projection = taskEnvelopeState(records, "task-042", after_(records, 0), HOUR_MS);
  assert.equal(projection.state, "proposed");
  assert.equal(projection.registered, true);
  assert.deepEqual(registeredActionKeys(records, "task-042"), [
    "task-042:chaser",
    "task-042:followup",
    "task-042:draft",
  ]);
});

test("a live request is awaiting; a grant is approved; an execution is executed", () => {
  const dir = world();
  ok(["register", join("backlog", "tasks", "task-042.md"), "--as", "agent:claude"], dir);
  ok(["request", "task-042", "--action", "task-042:chaser", "--as", "agent:claude"], dir);

  let records = verified(dir);
  assert.equal(taskEnvelopeState(records, "task-042", after_(records, 0), HOUR_MS).state, "awaiting");

  const granted = ok(["grant", "task-042:chaser", "--as", "human:carter", "--json"], dir);
  const token = String((JSON.parse(granted.stdout) as Record<string, unknown>)["token"]);
  records = verified(dir);
  assert.equal(taskEnvelopeState(records, "task-042", after_(records, 0), HOUR_MS).state, "approved");

  ok(
    ["run", "task-042:chaser", "--token", token, "--as", "agent:claude", "--", ...CHILD],
    dir,
  );
  records = verified(dir);
  assert.equal(taskEnvelopeState(records, "task-042", after_(records, 0), HOUR_MS).state, "executed");
});

test("a rejection projects to rejected, and a live request outranks it", () => {
  const dir = world();
  ok(["register", join("backlog", "tasks", "task-042.md"), "--as", "agent:claude"], dir);
  ok(["request", "task-042", "--action", "task-042:chaser", "--as", "agent:claude"], dir);
  ok(["reject", "task-042:chaser", "--as", "human:carter"], dir);

  let records = verified(dir);
  assert.equal(taskEnvelopeState(records, "task-042", after_(records, 0), HOUR_MS).state, "rejected");

  // A second action is requested: a human owes an answer, and that outranks the
  // decision already made on the first (the rollup rule, stated in the module).
  ok(["request", "task-042", "--action", "task-042:followup", "--as", "agent:claude"], dir);
  records = verified(dir);
  assert.equal(taskEnvelopeState(records, "task-042", after_(records, 0), HOUR_MS).state, "awaiting");
});

test("a lapsed TTL projects to expired with no event, purely from the instant asked about", () => {
  const dir = world();
  ok(["register", join("backlog", "tasks", "task-042.md"), "--as", "agent:claude"], dir);
  ok(["request", "task-042", "--action", "task-042:chaser", "--as", "agent:claude"], dir);
  const records = verified(dir);

  assert.equal(
    taskEnvelopeState(records, "task-042", after_(records, HOUR_MS - 1), HOUR_MS).state,
    "awaiting",
  );
  assert.equal(
    taskEnvelopeState(records, "task-042", after_(records, HOUR_MS + 1), HOUR_MS).state,
    "expired",
  );
  // No TTL means no lapse: a policy that bounded nothing expires nothing.
  assert.equal(
    taskEnvelopeState(records, "task-042", after_(records, HOUR_MS * 100), null).state,
    "awaiting",
  );
});

// ===========================================================================
// lapsedRequests — the sweep's candidate list
// ===========================================================================

test("lapsedRequests names only live requests past their TTL, and nothing without one", () => {
  const dir = world();
  ok(["register", join("backlog", "tasks", "task-042.md"), "--as", "agent:claude"], dir);
  ok(["request", "task-042", "--action", "task-042:chaser", "--as", "agent:claude"], dir);
  ok(["request", "task-042", "--action", "task-042:followup", "--as", "agent:claude"], dir);
  ok(["grant", "task-042:followup", "--as", "human:carter"], dir);
  const records = verified(dir);

  assert.deepEqual(lapsedRequests(records, after_(records, 60_000), HOUR_MS), []);
  assert.deepEqual(lapsedRequests(records, after_(records, HOUR_MS * 2), null), []);

  const lapsed = lapsedRequests(records, after_(records, HOUR_MS * 2), HOUR_MS);
  assert.equal(lapsed.length, 1, "the decided request must not be a candidate");
  assert.equal(lapsed[0]?.actionKey, "task-042:chaser");
  assert.equal(lapsed[0]?.task, "task-042");
});

test("lapsedRequests is empty once the expiry is on record: idempotence without memory", () => {
  const dir = world();
  ok(["register", join("backlog", "tasks", "task-042.md"), "--as", "agent:claude"], dir);
  ok(["request", "task-042", "--action", "task-042:chaser", "--as", "agent:claude"], dir);

  // The system verb, through the CLI, with a policy whose TTL has lapsed.
  const shortTtl = POLICY.replace('approval_ttl: "1h"', 'approval_ttl: "1ms"');
  writeFileSync(join(dir, "APPROVAL.md"), shortTtl, "utf8");
  ok(["policy", "attest", "--as", "human:carter"], dir);
  ok(["expire", "task-042:chaser"], dir);

  const records = verified(dir);
  assert.deepEqual(lapsedRequests(records, after_(records, HOUR_MS * 2), HOUR_MS), []);
  assert.equal(
    taskEnvelopeState(records, "task-042", after_(records, HOUR_MS * 2), HOUR_MS).state,
    "expired",
  );
});

// ===========================================================================
// driftAlreadyLogged — the dedupe rule
// ===========================================================================

test("driftAlreadyLogged is true only for the identical claim against the same log", () => {
  const dir = world();
  ok(["register", join("backlog", "tasks", "task-042.md"), "--as", "agent:claude"], dir);
  ok(["request", "task-042", "--action", "task-042:chaser", "--as", "agent:claude"], dir);

  const facts = {
    declaredState: "proposed",
    derivedState: "awaiting" as const,
    envelopeDigest: null,
  };
  assert.equal(driftAlreadyLogged(verified(dir), "task-042", facts), false);

  // The daemon writes the record; the predicate must then suppress a repeat.
  ok(["daemon", "run", "--once"], dir);
  const records = verified(dir);
  assert.ok(existsSync(join(dir, ".approval", "QUEUE.md")), "the daemon rendered no queue");
  const drift = records.filter((record) => record.event === "envelope.drift");
  assert.equal(drift.length, 1);

  const payload = (drift[0]?.payload ?? {}) as Record<string, unknown>;
  const recorded = {
    declaredState: payload["declared_state"] as string,
    derivedState: payload["derived_state"] as "awaiting",
    envelopeDigest: (payload["envelope_sha256"] ?? null) as string | null,
  };
  assert.equal(driftAlreadyLogged(records, "task-042", recorded), true);
  assert.equal(
    driftAlreadyLogged(records, "task-042", { ...recorded, envelopeDigest: "0".repeat(64) }),
    false,
    "an edited envelope must be a new drift, not a suppressed one",
  );
  assert.equal(
    driftAlreadyLogged(records, "task-042", { ...recorded, derivedState: "approved" }),
    false,
  );
  assert.equal(driftAlreadyLogged(records, "task-099", recorded), false);
});
