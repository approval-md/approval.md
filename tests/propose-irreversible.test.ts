/**
 * `approval propose --irreversible` (APRV-537): SPEC.md §7's irreversibility
 * floor, engaged by the proposer for one key.
 *
 * What is pinned:
 *
 *   1. the five resident settings (#679's cells: ask, autonomous,
 *      supervised-retro, supervised-live, manual), each without the flag (the
 *      answers 0.4.8 gives, and records with no `reversible` field) and with it
 *      (every cell answers `requested`, and both the registration and the
 *      request record `reversible: false`);
 *   2. the start: with the flag, a start with no human grant is refused
 *      `not-granted` in every cell, on the grant path (pending request) and on
 *      the policy path (request withdrawn); after a grant it spends the grant
 *      (`authorization: grant`), once;
 *   3. the write boundary: `startHarnessExecution` floors on its caller's
 *      `reversible: false` and, for a proposal, on the key's own records;
 *   4. the stricter value wins and sticks, in both orders of mixed proposes;
 *   5. the floor's two SPEC.md §7 edges: `allow_irreversible: true` keeps the
 *      class's autonomy, and `human-only` is never changed;
 *   6. the CLI flag and its help, the JSON answer's shape unchanged;
 *   7. serve's agent allowlist: `--irreversible` passes on `propose`, a flag
 *      off the list still answers 403 `serve-flag-not-permitted`, and the
 *      list is otherwise exactly what it was.
 *
 * Every record goes through the real append path; no log line is written by
 * hand.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { main } from "../src/cli/main.js";
import { appendAttestation } from "../src/core/attest.js";
import {
  decide,
  propose,
  proposedTaskId,
  startHarnessExecution,
  startProposed,
  withdraw,
  type GateOptions,
  type ProposeResult,
} from "../src/core/gate.js";
import { payloadHash } from "../src/core/payload.js";
import { AGENT_FLAGS, checkVerbArguments } from "../src/serve/arguments.js";
import { AGENT_TOKEN_ENV, resolveServeCredentials, TENANT_TOKEN_ENV } from "../src/serve/credentials.js";
import { serveApproval, type ServeHandle } from "../src/serve/server.js";
import { VERB_REGISTRY } from "../src/cli/verb-registry.js";
import { at, fixedClock, T0 } from "./scenario.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "amd-irrev-")));
let counter = 0;
after(() => rmSync(scratch, { recursive: true, force: true }));

const AGENT = "agent:hermes";
const CLS = "shop.order.confirm";
const SECRET_ENV = "AMD_IRREVERSIBLE_TEST_SECRET";
const SECRET = { [SECRET_ENV]: "irreversible-test-sampling-value-not-a-secret" };

/** #679's five cells, as its `variantBlock` writes the row (and `manual` the defaults too). */
const CELLS = ["ask", "autonomous", "supervised-retro", "supervised-live", "manual"] as const;
type Cell = (typeof CELLS)[number];
const ROW: Record<Cell, string> = {
  ask: "autonomy: manual",
  autonomous: "autonomy: autonomous",
  "supervised-retro": "autonomy: supervised-retro",
  "supervised-live": "autonomy: supervised-live, live_rate: 0.5",
  manual: "autonomy: manual",
};

function policyText(cell: Cell, extraRow = ""): string {
  return [
    "# Policy",
    "",
    "```yaml approval-policy",
    'version: "0.1"',
    "defaults:",
    `  autonomy: ${cell === "manual" ? "manual" : "autonomous"}`,
    '  approval_ttl: "72h"',
    "  on_expiry: reject",
    "classes:",
    `  ${CLS}: { ${ROW[cell]}, agent_may_request: true${extraRow} }`,
    "  shop.secret.*: { autonomy: manual, agent_may_request: true }",
    "  shop.secret.wire: { autonomy: human-only }",
    "audit:",
    `  sampling_secret_env: ${SECRET_ENV}`,
    "```",
    "",
  ].join("\n");
}

interface Store {
  dir: string;
  logPath: string;
  policyPath: string;
  options: (ts?: string) => GateOptions;
}

function store(cell: Cell, extraRow = ""): Store {
  counter += 1;
  const dir = join(scratch, `s${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  const policyPath = join(dir, "APPROVAL.md");
  writeFileSync(policyPath, policyText(cell, extraRow), "utf8");
  const logPath = join(dir, ".approval", "log", "events.jsonl");
  const attested = appendAttestation(logPath, policyPath, "human:operator", { clock: fixedClock(T0) });
  assert.equal(attested.ok, true, JSON.stringify(attested));
  return {
    dir,
    logPath,
    policyPath,
    options: (ts = at(1)) => ({ policy: { file: policyPath }, clock: fixedClock(ts), env: SECRET }),
  };
}

function records(s: Store): Record<string, unknown>[] {
  if (!existsSync(s.logPath)) return [];
  return readFileSync(s.logPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const payloadOf = (record: Record<string, unknown>): Record<string, unknown> =>
  (record["payload"] ?? {}) as Record<string, unknown>;

/** The registration's one declared action, and every request, for a key. */
function declared(s: Store, key: string): { action: Record<string, unknown> | null; requests: Record<string, unknown>[] } {
  let action: Record<string, unknown> | null = null;
  const requests: Record<string, unknown>[] = [];
  for (const record of records(s)) {
    if (record["event"] === "task.registered") {
      const envelope = (payloadOf(record)["envelope"] ?? payloadOf(record)) as Record<string, unknown>;
      const actions = (envelope["actions"] ?? payloadOf(record)["actions"]) as Record<string, unknown>[] | undefined;
      for (const a of actions ?? []) if (a["idempotency_key"] === key) action = a;
    }
    if (record["event"] === "approval.requested" && record["action_key"] === key) requests.push(payloadOf(record));
  }
  return { action, requests };
}

const order = (n: number): Record<string, unknown> => ({ order: `1 x Cold brew #${String(n)}`, total: "250" });

function proposeOk(s: Store, key: string, payload: unknown, irreversible: boolean, ts?: string): Extract<ProposeResult, { ok: true }> {
  const result = propose(
    s.logPath,
    { cls: CLS, actionKey: key, summary: "For Kicks order", payload, ...(irreversible ? { irreversible: true } : {}) },
    AGENT,
    s.options(ts),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("unreachable");
  return result;
}

/**
 * The supervised-live draw is deterministic over the policy, the secret and the
 * bytes, so the cell is pinned on a payload that draws UNSAMPLED without the
 * flag: that is the only supervised-live case the floor changes.
 */
function unsampledLivePayload(): Record<string, unknown> {
  const s = store("supervised-live");
  for (let n = 0; n < 64; n += 1) {
    const answer = proposeOk(s, `${CLS}:probe-${String(n)}`, order(n), false);
    if (answer.decision === "supervised") return order(n);
  }
  throw new Error("no unsampled draw in 64 payloads at live_rate 0.5");
}
const LIVE_SKIP = unsampledLivePayload();
const payloadFor = (cell: Cell): Record<string, unknown> => (cell === "supervised-live" ? LIVE_SKIP : order(1));

/** What 0.4.8 answers in each cell, without the flag (the page's run, `matrix679-0.4.8.json`). */
const TODAY: Record<Cell, string> = {
  ask: "requested",
  autonomous: "autonomous",
  "supervised-retro": "supervised",
  "supervised-live": "supervised",
  manual: "requested",
};

// ---------------------------------------------------------------------------
// 1. The five settings, with and without the flag
// ---------------------------------------------------------------------------

for (const cell of CELLS) {
  test(`${cell}: without the flag the answer is today's (${TODAY[cell]}) and no record says reversible`, () => {
    const s = store(cell);
    const key = `${CLS}:plain`;
    const answer = proposeOk(s, key, payloadFor(cell), false);
    assert.equal(answer.decision, TODAY[cell]);
    assert.equal(answer.state, TODAY[cell] === "requested" ? "requested" : null);
    const { action, requests } = declared(s, key);
    assert.ok(action !== null);
    assert.equal(Object.prototype.hasOwnProperty.call(action, "reversible"), false, "the registration is byte-shaped as before");
    for (const r of requests) assert.equal(Object.prototype.hasOwnProperty.call(r, "reversible"), false);
  });

  test(`${cell}: with --irreversible the answer is requested, and the registration and the request say reversible: false`, () => {
    const s = store(cell);
    const key = `${CLS}:floored`;
    const answer = proposeOk(s, key, payloadFor(cell), true);
    assert.equal(answer.decision, "requested");
    assert.equal(answer.state, "requested");
    assert.equal(answer.idempotent, false);
    const { action, requests } = declared(s, key);
    assert.equal(action?.["reversible"], false);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.["reversible"], false);
    assert.equal(requests[0]?.["execution"], "harness");
    // A retry appends nothing and answers the same.
    const again = proposeOk(s, key, payloadFor(cell), true);
    assert.equal(again.decision, "requested");
    assert.equal(again.idempotent, true);
  });

  test(`${cell}: with --irreversible no start runs without a grant; a grant is spent once, as grant`, () => {
    const s = store(cell);
    const key = `${CLS}:start`;
    const payload = payloadFor(cell);
    const answer = proposeOk(s, key, payload, true);
    // The grant path: the request is pending.
    const early = startProposed(s.logPath, answer.task, key, payload, AGENT, s.options(at(2)));
    assert.equal(early.ok, false);
    assert.equal(early.ok ? "" : early.code, "not-granted");
    // A human grants; the start spends the grant.
    const granted = decide(s.logPath, key, "grant", "human:resident", s.options(at(3)));
    assert.equal(granted.ok, true, JSON.stringify(granted));
    const started = startProposed(s.logPath, answer.task, key, payload, AGENT, s.options(at(4)));
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(started.ok ? started.authorization : "", "grant");
    // A second start is refused, and in the words a manual class has always
    // used for it: the spent grant no longer binds the key, the policy path
    // resolves manual, so `not-granted` comes before the single-use scan.
    const twice = startProposed(s.logPath, answer.task, key, payload, AGENT, s.options(at(5)));
    assert.equal(twice.ok ? "" : twice.code, "not-granted");
    assert.equal(records(s).filter((r) => r["event"] === "execution.started").length, 1);
  });

  test(`${cell}: with --irreversible a policy start is refused after the request is withdrawn`, () => {
    const s = store(cell);
    const key = `${CLS}:withdrawn`;
    const payload = payloadFor(cell);
    const answer = proposeOk(s, key, payload, true);
    const back = withdraw(s.logPath, key, AGENT, { ...s.options(at(2)), reason: "cancelled" });
    assert.equal(back.ok, true, JSON.stringify(back));
    const start = startProposed(s.logPath, answer.task, key, payload, AGENT, s.options(at(3)));
    assert.equal(start.ok, false);
    assert.equal(start.ok ? "" : start.code, "not-granted");
    assert.equal(records(s).some((r) => r["event"] === "execution.started"), false);
  });
}

test("control: without the flag the three nonmanual cells start on the policy, as today", () => {
  for (const cell of ["autonomous", "supervised-retro", "supervised-live"] as const) {
    const s = store(cell);
    const key = `${CLS}:policy`;
    const payload = payloadFor(cell);
    const answer = proposeOk(s, key, payload, false);
    const start = startProposed(s.logPath, answer.task, key, payload, AGENT, s.options(at(2)));
    assert.equal(start.ok, true, `${cell}: ${JSON.stringify(start)}`);
    assert.equal(start.ok ? start.authorization : "", "policy");
  }
});

// ---------------------------------------------------------------------------
// 3. The write boundary
// ---------------------------------------------------------------------------

test("startHarnessExecution floors on its caller's reversible: false, and only on false", () => {
  const s = store("autonomous");
  const hash = payloadHash(order(9));
  const floored = startHarnessExecution(
    s.logPath,
    { task: "t-direct", actionKey: `${CLS}:direct-a`, cls: CLS, payload_hash: hash, reversible: false },
    AGENT,
    s.options(at(2)),
  );
  assert.equal(floored.ok ? "" : floored.code, "not-granted");
  assert.match(floored.ok ? "" : floored.message, /declared irreversible \(reversible: false\), so SPEC\.md §7's floor raises class shop\.order\.confirm to manual/u);
  for (const reversible of [true, undefined]) {
    const plain = startHarnessExecution(
      s.logPath,
      { task: "t-direct", actionKey: `${CLS}:direct-${String(reversible)}`, cls: CLS, payload_hash: hash, ...(reversible === undefined ? {} : { reversible }) },
      AGENT,
      s.options(at(3)),
    );
    assert.equal(plain.ok, true, JSON.stringify(plain));
  }
});

test("startHarnessExecution reads a proposal's floor from the log when its caller passes none", () => {
  const s = store("autonomous");
  const key = `${CLS}:direct-proposal`;
  const payload = order(10);
  const answer = proposeOk(s, key, payload, true);
  assert.equal(withdraw(s.logPath, key, AGENT, { ...s.options(at(2)), reason: "cancelled" }).ok, true);
  const direct = startHarnessExecution(
    s.logPath,
    { task: answer.task, actionKey: key, cls: CLS, payload_hash: payloadHash(payload) },
    AGENT,
    s.options(at(3)),
  );
  assert.equal(direct.ok ? "" : direct.code, "not-granted");
});

// ---------------------------------------------------------------------------
// 4. Mixed proposes: the stricter value wins and sticks
// ---------------------------------------------------------------------------

test("flag first, then without it: the key stays floored (propose and start)", () => {
  for (const cell of ["autonomous", "supervised-retro", "supervised-live"] as const) {
    const s = store(cell);
    const key = `${CLS}:first-flagged`;
    const payload = payloadFor(cell);
    const first = proposeOk(s, key, payload, true);
    assert.equal(first.decision, "requested");
    // A retry without the flag while the request is live: the same question.
    const retry = proposeOk(s, key, payload, false, at(2));
    assert.equal(retry.decision, "requested");
    assert.equal(retry.idempotent, true);
    // Withdrawn, then proposed again WITHOUT the flag: asked again, floored.
    assert.equal(withdraw(s.logPath, key, AGENT, { ...s.options(at(3)), reason: "cancelled" }).ok, true);
    const refiled = proposeOk(s, key, payload, false, at(4));
    assert.equal(refiled.decision, "requested", cell);
    assert.equal(refiled.idempotent, false);
    const { requests } = declared(s, key);
    assert.equal(requests.length, 2);
    assert.equal(requests[1]?.["reversible"], false, "the re-asked request carries the registration's floor");
    // And no start without a grant, on either path.
    assert.equal(withdraw(s.logPath, key, AGENT, { ...s.options(at(5)), reason: "cancelled" }).ok, true);
    const start = startProposed(s.logPath, first.task, key, payload, AGENT, s.options(at(6)));
    assert.equal(start.ok ? "" : start.code, "not-granted", cell);
  }
});

test("without the flag first, then with it: the flag files the card, and the floor then sticks", () => {
  for (const cell of ["autonomous", "supervised-retro", "supervised-live"] as const) {
    const s = store(cell);
    const key = `${CLS}:later-flagged`;
    const payload = payloadFor(cell);
    const first = proposeOk(s, key, payload, false);
    assert.equal(first.decision, TODAY[cell]);
    assert.equal(declared(s, key).action?.["reversible"], undefined, "the registration predates the flag");
    // The later propose with the flag asks a human.
    const flagged = proposeOk(s, key, payload, true, at(2));
    assert.equal(flagged.decision, "requested", cell);
    assert.equal(flagged.state, "requested");
    assert.equal(declared(s, key).requests[0]?.["reversible"], false);
    // Withdrawn; a third propose WITHOUT the flag stays floored (the request record sticks).
    assert.equal(withdraw(s.logPath, key, AGENT, { ...s.options(at(3)), reason: "cancelled" }).ok, true);
    const third = proposeOk(s, key, payload, false, at(4));
    assert.equal(third.decision, "requested", cell);
    // And the policy start is refused although neither the registration nor this call says irreversible.
    assert.equal(withdraw(s.logPath, key, AGENT, { ...s.options(at(5)), reason: "cancelled" }).ok, true);
    const start = startProposed(s.logPath, first.task, key, payload, AGENT, s.options(at(6)));
    assert.equal(start.ok ? "" : start.code, "not-granted", cell);
    // After a grant the start runs, as grant.
    const fourth = proposeOk(s, key, payload, false, at(7));
    assert.equal(fourth.decision, "requested");
    assert.equal(decide(s.logPath, key, "grant", "human:resident", s.options(at(8))).ok, true);
    const granted = startProposed(s.logPath, first.task, key, payload, AGENT, s.options(at(9)));
    assert.equal(granted.ok ? granted.authorization : granted.code, "grant");
  }
});

test("a flagged registration whose request was refused still floors the key: a later propose without the flag, and a start", () => {
  // `max_pending: 1` refuses the second request queue-full AFTER propose registered it, so the only
  // record of the flag for that key is its registration.
  const s = store("autonomous", ", limits: { max_pending: 1 }");
  const first = proposeOk(s, `${CLS}:queue-a`, order(20), true);
  assert.equal(first.decision, "requested");
  const keyB = `${CLS}:queue-b`;
  const refused = propose(s.logPath, { cls: CLS, actionKey: keyB, summary: "s", payload: order(21), irreversible: true }, AGENT, s.options(at(2)));
  assert.equal(refused.ok ? "" : refused.code, "queue-full");
  const b = declared(s, keyB);
  assert.equal(b.action?.["reversible"], false, "registered, floored");
  assert.equal(b.requests.length, 0, "no request: the registration is the only record of the flag");
  // No start without a grant, though no request ever bound the key to the grant path.
  const taskB = proposedTaskId(AGENT, CLS, keyB);
  const start = startProposed(s.logPath, taskB, keyB, order(21), AGENT, s.options(at(3)));
  assert.equal(start.ok ? "" : start.code, "not-granted");
  // The queue frees; the same key proposed WITHOUT the flag is still asked of a person.
  assert.equal(withdraw(s.logPath, `${CLS}:queue-a`, AGENT, { ...s.options(at(4)), reason: "cancelled" }).ok, true);
  const later = proposeOk(s, keyB, order(21), false, at(5));
  assert.equal(later.decision, "requested");
  assert.equal(declared(s, keyB).requests[0]?.["reversible"], false);
});

test("a key already started on the policy answers what happened when the flag comes later", () => {
  const s = store("autonomous");
  const key = `${CLS}:already`;
  const payload = order(11);
  const first = proposeOk(s, key, payload, false);
  const started = startProposed(s.logPath, first.task, key, payload, AGENT, s.options(at(2)));
  assert.equal(started.ok ? started.authorization : "", "policy");
  const later = proposeOk(s, key, payload, true, at(3));
  assert.deepEqual([later.decision, later.state, later.idempotent], ["autonomous", "executed", true]);
});

// ---------------------------------------------------------------------------
// 5. SPEC.md §7's two edges
// ---------------------------------------------------------------------------

test("allow_irreversible: true keeps the class's autonomy: the operator's permission, never the agent's", () => {
  const s = store("autonomous", ", allow_irreversible: true");
  const key = `${CLS}:allowed`;
  const payload = order(12);
  const answer = proposeOk(s, key, payload, true);
  assert.equal(answer.decision, "autonomous");
  assert.equal(declared(s, key).action?.["reversible"], false, "the declaration is still recorded");
  const start = startProposed(s.logPath, answer.task, key, payload, AGENT, s.options(at(2)));
  assert.equal(start.ok ? start.authorization : start.code, "policy");
});

test("the floor never changes human-only: the proposal is refused before anything is registered", () => {
  const s = store("ask");
  const before = records(s).length;
  const result = propose(
    s.logPath,
    { cls: "shop.secret.wire", actionKey: "shop.secret.wire:w1", summary: "s", payload: {}, irreversible: true },
    AGENT,
    s.options(),
  );
  assert.equal(result.ok ? "" : result.code, "class-human-only");
  assert.equal(records(s).length, before);
});

// ---------------------------------------------------------------------------
// 6. The CLI
// ---------------------------------------------------------------------------

function runCli(args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...SECRET };
  delete childEnv["APPROVAL_HUMAN"];
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], { cwd, encoding: "utf8", env: childEnv });
  assert.equal(result.error, undefined);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

test("the CLI takes --irreversible on propose, records it, and answers in the same shape", () => {
  const s = store("autonomous");
  const base = ["propose", "--class", CLS, "--summary", "For Kicks order", "--payload-json", JSON.stringify(order(13)), "--as", AGENT, "--json"];
  const plain = runCli([...base.slice(0, 3), "--key", `${CLS}:cli-plain`, ...base.slice(3)], s.dir);
  assert.equal(plain.code, 0, plain.stderr);
  const flagged = runCli([...base.slice(0, 3), "--key", `${CLS}:cli-flag`, ...base.slice(3), "--irreversible"], s.dir);
  assert.equal(flagged.code, 0, flagged.stderr);
  const a = JSON.parse(plain.stdout) as Record<string, unknown>;
  const b = JSON.parse(flagged.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(b), Object.keys(a), "no new member in the answer");
  assert.deepEqual([a["decision"], b["decision"]], ["autonomous", "requested"]);
  assert.equal(b["task"], proposedTaskId(AGENT, CLS, `${CLS}:cli-flag`));
  assert.equal(declared(s, `${CLS}:cli-flag`).action?.["reversible"], false);
  // The start refuses it without a grant, through the CLI too.
  const start = runCli(["start", String(b["task"]), "--action", `${CLS}:cli-flag`, "--payload-json", JSON.stringify(order(13)), "--as", AGENT, "--json"], s.dir);
  assert.equal(start.code, 1);
  assert.equal((JSON.parse(start.stderr || start.stdout) as { error: { code: string } }).error.code, "not-granted");
});

test("--irreversible is a boolean flag in the registry and the help", async () => {
  const spec = VERB_REGISTRY.find((v) => v.name === "propose" && v.subcommand === undefined);
  assert.ok(spec !== undefined);
  const flags = (spec.input as { properties: { flags: { properties: Record<string, unknown> } } }).properties.flags.properties;
  assert.deepEqual(flags["--irreversible"], { type: "boolean" });
  let out = "";
  const code = await main(["propose", "--help"], { cwd: scratch, streams: { out: (t: string) => void (out += t), err: () => undefined } });
  assert.equal(code, 0);
  assert.match(out, /--irreversible {7}it cannot be undone: SPEC\.md §7's floor asks a person/u);
});

// ---------------------------------------------------------------------------
// 7. serve's agent allowlist
// ---------------------------------------------------------------------------

const AGENT_TOKEN = "agent-token-for-the-irreversible-suite";
const TENANT_TOKEN = "tenant-token-for-the-irreversible-sui";

/** The whole agent surface, flag by flag: only propose's `--irreversible` is new. */
const EXPECTED_AGENT_FLAGS: Record<string, string[]> = {
  instructions: ["--json", "--schemas"],
  "hook classify": ["--json"],
  request: ["--action", "--json"],
  wait: ["--interval", "--json", "--timeout", "--withdraw-on-timeout"],
  withdraw: ["--action", "--json", "--note", "--reason"],
  propose: ["--class", "--irreversible", "--json", "--key", "--payload-json", "--summary"],
  start: ["--action", "--json", "--payload-json"],
};

test("the agent allowlist adds --irreversible to propose and nothing else", () => {
  const actual: Record<string, string[]> = {};
  for (const [verb, flags] of AGENT_FLAGS) actual[verb] = [...flags].sort();
  assert.deepEqual(actual, EXPECTED_AGENT_FLAGS);
  const propose = VERB_REGISTRY.find((v) => v.name === "propose" && v.subcommand === undefined);
  const start = VERB_REGISTRY.find((v) => v.name === "start" && v.subcommand === undefined);
  assert.ok(propose !== undefined && start !== undefined);
  const check = (spec: typeof propose, flags: Record<string, unknown>) => checkVerbArguments(spec, { flags }, scratch, scratch, "agent");
  assert.deepEqual(check(propose, { "--irreversible": true }), { ok: true });
  // Not on start: the floor is stated once, at the propose, and read back from the log.
  const onStart = check(start, { "--help": true });
  assert.equal(onStart.ok ? "" : onStart.code, "serve-flag-not-permitted");
});

async function listener(dir: string): Promise<ServeHandle> {
  const credentials = resolveServeCredentials({ [AGENT_TOKEN_ENV]: AGENT_TOKEN, [TENANT_TOKEN_ENV]: TENANT_TOKEN });
  assert.equal(credentials.ok, true);
  if (!credentials.ok) throw new Error("unreachable");
  return await serveApproval({
    actor: AGENT,
    cwd: dir,
    credentials: credentials.credentials,
    env: { APPROVAL_DAEMON_ID: "daemon-serve-irreversible", ...SECRET },
    port: 0,
  });
}

async function verb(server: ServeHandle, name: string, args: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://${server.host}:${String(server.port)}/verb/${name}`, {
    method: "POST",
    headers: { authorization: `Bearer ${AGENT_TOKEN}` },
    body: JSON.stringify(args),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test("over serve the agent credential's --irreversible reaches propose; an off-list flag is still 403", async () => {
  counter += 1;
  const dir = join(scratch, `serve-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), policyText("autonomous"), "utf8");
  const quiet = { out: (): void => undefined, err: (): void => undefined };
  assert.equal(await main(["policy", "attest", "--as", "human:operator"], { cwd: dir, streams: quiet }), 0);
  const server = await listener(dir);
  try {
    const flags = {
      "--class": CLS,
      "--summary": "For Kicks order",
      "--payload-json": JSON.stringify(order(14)),
      "--json": true,
    };
    const plain = await verb(server, "propose", { flags: { ...flags, "--key": `${CLS}:serve-plain` } });
    assert.equal(plain.status, 200);
    assert.equal((JSON.parse(String(plain.body["stdout"])) as Record<string, unknown>)["decision"], "autonomous");
    const floored = await verb(server, "propose", { flags: { ...flags, "--key": `${CLS}:serve-flag`, "--irreversible": true } });
    assert.equal(floored.status, 200, JSON.stringify(floored.body));
    assert.equal(floored.body["exit_code"], 0, String(floored.body["stderr"]));
    assert.equal((JSON.parse(String(floored.body["stdout"])) as Record<string, unknown>)["decision"], "requested");
    // Off the list: refused before any argv is built.
    for (const extra of [{ "--help": true }, { "--policy": join(dir, "APPROVAL.md") }]) {
      const off = await verb(server, "propose", { flags: { ...flags, "--key": `${CLS}:serve-off`, ...extra } });
      assert.equal(off.status, 403, JSON.stringify(off.body));
    }
    const help = await verb(server, "propose", { flags: { ...flags, "--key": `${CLS}:serve-off`, "--help": true } });
    assert.equal((help.body["error"] as { code: string }).code, "serve-flag-not-permitted");
    // The start of the floored key is refused over serve too.
    const task = proposedTaskId(AGENT, CLS, `${CLS}:serve-flag`);
    const start = await verb(server, "start", {
      positionals: [task],
      flags: { "--action": `${CLS}:serve-flag`, "--payload-json": JSON.stringify(order(14)), "--json": true },
    });
    assert.equal(start.status, 200);
    assert.equal(start.body["exit_code"], 1);
    assert.match(String(start.body["stderr"]), /"code":"not-granted"/u);
  } finally {
    await server.close();
  }
});
