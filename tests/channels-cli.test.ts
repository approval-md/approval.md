/**
 * CLI channel tests (APRV-23).
 *
 * Three layers, and the first is the one that matters: the shared conformance
 * suite from `channels/conformance.ts`, run against the real {@link CliChannel}
 * with a real harness — a real log built through the real gate, and a real
 * prompt driven by scripted bytes on an injected stdin. The channel is not
 * mocked anywhere in this file; only its two streams are.
 *
 * Then the rendering assertions (the computed/claimed markers, the delimited
 * payload block, batch rendering), and finally the verb itself, spawned as a
 * child process so what is asserted is what a human or an agent actually
 * observes: the exit code and the bytes on each stream.
 *
 * Nothing here hand-writes a log line, and every subprocess case carries a
 * timeout so a prompt that hangs fails the suite instead of stalling it.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CLAIMED_MARKER,
  CliChannel,
  COMPUTED_MARKER,
  PAYLOAD_BEGIN,
  PAYLOAD_END,
} from "../src/channels/cli.js";
import { assembleBatch } from "../src/channels/batch.js";
import type { Channel, ChannelDecision, ChannelRequest } from "../src/channels/contract.js";
import {
  runChannelConformance,
  type ConformanceCase,
  type ConformanceHarness,
} from "../src/channels/conformance.js";
import { buildPendingQueue, type TagOptions } from "../src/channels/tagging.js";
import { payloadHash } from "../src/core/payload.js";
import { register, request } from "./clock-adapters.js";
import { at, attest, fixedClock, newScenario, scratchRoot, T0, type Scenario } from "./scenario.js";

const scratch = scratchRoot("channels-cli");
after(scratch.cleanup);

/** dist/tests/channels-cli.test.js -> dist/src/cli/main.js */
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
  "  read.*:",
  "    autonomy: autonomous",
  "  communicate.email.external:",
  "    autonomy: manual",
  "    limits:",
  "      per_action_usd: 1",
  "      daily_actions: 5",
  "```",
  "",
].join("\n");

const TASK = "task-100";
const ACTOR = "agent:drafter";
const HUMAN = "human:carter";
const NOW = at(2);

function payloadFor(index: number): Record<string, unknown> {
  return {
    to: [`ap-${index}@vendor.example`],
    subject: `Invoice ${41 + index} chaser`,
    body: `Following up on invoice ${41 + index}.`,
  };
}

function actionKeyFor(index: number): string {
  return `${TASK}:chaser-${index}:2026-08-05`;
}

interface Live {
  unit: Scenario;
  keys: string[];
  payloads: Map<string, unknown>;
  tagOptions: TagOptions;
}

/** `count` live manual requests in a fresh log, built through the real gate. */
function live(count: number): Live {
  const unit = newScenario(scratch.root, POLICY);
  attest(unit, T0);

  const payloads = new Map<string, unknown>();
  const keys: string[] = [];
  const actions = [];
  for (let index = 0; index < count; index += 1) {
    const key = actionKeyFor(index);
    const payload = payloadFor(index);
    keys.push(key);
    payloads.set(key, payload);
    actions.push({
      class: "communicate.email.external",
      idempotency_key: key,
      summary: `chase invoice ${41 + index}`,
      reversible: false,
      est_cost_usd: 0.02,
      payload_hash: payloadHash(payload),
    });
  }

  const registered = register(
    unit.logPath,
    { task: TASK, envelope: { origin: { app: "manual", created_by: ACTOR }, state: "awaiting", actions } },
    T0,
    ACTOR,
    unit.options,
  );
  assert.equal(registered.ok, true, "registration failed");

  for (const [index, key] of keys.entries()) {
    const requested = request(
      unit.logPath,
      {
        task: TASK,
        actionKey: key,
        cls: "communicate.email.external",
        est_cost_usd: 0.02,
        reversible: false,
        summary: `chase invoice ${41 + index}`,
      },
      at(1),
      ACTOR,
      unit.options,
    );
    assert.equal(requested.ok, true, `request failed: ${JSON.stringify(requested)}`);
  }

  return {
    unit,
    keys,
    payloads,
    tagOptions: { policy: { file: unit.policyPath }, payload: (key) => payloads.get(key) },
  };
}

function queueOf(world: Live, now: string = NOW): ChannelRequest[] {
  const queue = buildPendingQueue(world.unit.logPath, world.tagOptions, now);
  assert.equal(queue.ok, true, JSON.stringify(queue));
  return queue.ok ? queue.requests : [];
}

/** A string sink standing in for a terminal. */
function sink(): { write(text: string): void; text(): string } {
  let buffer = "";
  return {
    write(text: string) {
      buffer += text;
    },
    text: () => buffer,
  };
}

// ---------------------------------------------------------------------------
// The conformance suite, against the real channel and a scripted prompt
// ---------------------------------------------------------------------------

/** Each channel's scripted stdin, so `decide` can type into the one under test. */
const scripts = new Map<Channel, PassThrough>();

function makeCliChannel(): Channel {
  const input = new PassThrough();
  const channel = new CliChannel({ input, output: sink() });
  scripts.set(channel, input);
  return channel;
}

let caseCounter = 0;

const harness: ConformanceHarness = {
  setup(count: number): ConformanceCase {
    caseCounter += 1;
    const world = live(count);
    const requests = queueOf(world);
    assert.equal(requests.length, count, "the harness could not build the requested queue");
    return {
      logPath: world.unit.logPath,
      requests,
      actor: { actor: HUMAN, channel: "cli" },
      gateOptions: { ...world.unit.options, clock: fixedClock(at(2 + caseCounter)) },
    };
  },
  /**
   * The simulated human gesture: type the answer, then run the channel's own
   * prompt loop. Nothing calls the handler directly — the callback wiring under
   * test is the channel's.
   */
  async decide(channel: Channel, decision: ChannelDecision) {
    const input = scripts.get(channel);
    assert.ok(input !== undefined, "no scripted input for this channel");
    // "g" or "r", then the note line (empty = none for a grant).
    input.write(`${decision.decision === "grant" ? "g" : "r"}\n${decision.note ?? ""}\n`);
    const collected = await (channel as CliChannel).collectDecision(
      decision.action_key,
      decision.deliveryId,
      decision.batchDeliveryId === undefined ? {} : { batchDeliveryId: decision.batchDeliveryId },
    );
    assert.equal(collected.kind, "decided", `the prompt collected nothing: ${collected.kind}`);
    if (collected.kind !== "decided") throw new Error("unreachable");
    return collected.outcome;
  },
};

test("the cli channel passes the shared conformance suite", async (t) => {
  await runChannelConformance(t, makeCliChannel, harness);
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test("computed fields are marked apart from claimed ones, with their attribution", () => {
  const world = live(1);
  const requests = queueOf(world);
  const out = sink();
  const channel = new CliChannel({ output: out, input: new PassThrough() });
  channel.notify(requests[0] as ChannelRequest);
  const text = out.text();

  const computed = "\\[computed\\]";
  const claimed = "\\[claimed\\]";

  // Computed: the runtime's answer, with the derivation named.
  assert.match(text, new RegExp(`${computed} class\\s+communicate\\.email\\.external \\(log\\)`, "u"));
  assert.match(text, new RegExp(`${computed} autonomy\\s+manual \\(policy-match\\)`, "u"));
  assert.match(text, /ttl_remaining_ms\s+59m 0s left \(clock\)/u);

  // Claimed: the agent's, with the author named, under its own heading.
  assert.match(text, /claimed by the party under oversight/u);
  assert.match(text, new RegExp(`${claimed} summary\\s+chase invoice 41 \\(${ACTOR}\\)`, "u"));
  assert.match(text, new RegExp(`${claimed} est_cost_usd\\s+\\$0\\.02 \\(${ACTOR}\\)`, "u"));

  // And never the other way round.
  assert.doesNotMatch(text, new RegExp(`${computed} summary`, "u"));
  assert.doesNotMatch(text, new RegExp(`${claimed} class`, "u"));

  const rendered = channel.lastRendered();
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0]?.action_key, world.keys[0]);
  assert.equal(rendered[0]?.fields.find((field) => field.field === "summary")?.kind, "claimed");
  assert.equal(rendered[0]?.fields.find((field) => field.field === "class")?.kind, "computed");
});

test("the full payload is printed verbatim inside its own delimiters", () => {
  const world = live(1);
  const requests = queueOf(world);
  const only = requests[0] as ChannelRequest;
  const out = sink();
  const channel = new CliChannel({ output: out, input: new PassThrough() });
  channel.notify(only);
  const text = out.text();

  const rendering = only.fullPayload.value;
  assert.ok(rendering !== null);
  assert.ok(text.includes(PAYLOAD_BEGIN), "no payload block was opened");
  assert.ok(text.includes(PAYLOAD_END), "no payload block was closed");
  assert.ok(text.includes(rendering.hash), "the bound hash is not shown on the block");

  const begin = text.indexOf(PAYLOAD_BEGIN);
  const end = text.indexOf(PAYLOAD_END);
  const block = text.slice(begin, end);
  assert.ok(block.includes(rendering.text), "the payload bytes are not inside the delimiters");
  // §10.4: delineated from the agent's summary — which lives OUTSIDE the block.
  assert.ok(!block.includes("chase invoice 41"), "the agent's summary leaked into the payload block");
  assert.ok(text.indexOf("chase invoice 41") < begin, "the summary must be rendered before the payload");

  const reported = channel.lastRendered()[0]?.fullPayloadText;
  assert.ok(reported !== null && reported !== undefined);
  assert.ok(reported.includes(rendering.text));
  assert.ok(reported.startsWith(PAYLOAD_BEGIN));
});

test("a batch renders member by member, each with its own payload", () => {
  const world = live(2);
  const requests = queueOf(world);
  const assembled = assembleBatch(requests);
  assert.equal(assembled.ok, true);
  if (!assembled.ok) return;

  const out = sink();
  const channel = new CliChannel({ output: out, input: new PassThrough() });
  const deliveryId = channel.notify(assembled.batch);
  const text = out.text();

  const rendered = channel.lastRendered();
  assert.equal(rendered.length, 2, "a batch must be rendered member by member");
  for (const entry of rendered) {
    assert.equal(entry.batchDeliveryId, deliveryId, "each member must carry the batch delivery id");
  }
  assert.deepEqual(
    rendered.map((entry) => entry.action_key),
    world.keys,
  );
  // Two distinct payload blocks, neither folded behind the other.
  assert.equal(text.split(PAYLOAD_BEGIN).length - 1, 2);
  assert.match(text, /\(1 of 2\)/u);
  assert.match(text, /\(2 of 2\)/u);
  assert.ok(text.includes("Invoice 41 chaser") && text.includes("Invoice 42 chaser"));
});

test("a reject demands a note and re-asks until it gets one", async () => {
  const world = live(1);
  const requests = queueOf(world);
  const key = world.keys[0] as string;
  const out = sink();
  const input = new PassThrough();
  const channel = new CliChannel({ output: out, input });

  const seen: ChannelDecision[] = [];
  channel.onDecision((decision) => {
    seen.push(decision);
    return { ok: true, action_key: decision.action_key, decision: decision.decision, state: "rejected", record: { seq: 9 } as never, tokenIssued: false };
  });
  const deliveryId = channel.notify(requests[0] as ChannelRequest);

  // An unrecognized answer, a reject, an empty note, then a real one.
  input.write("maybe\nr\n\n   \nnot this vendor\n");
  const collected = await channel.collectDecision(key, deliveryId);
  channel.close();

  assert.equal(collected.kind, "decided");
  assert.match(out.text(), /unrecognized answer/u);
  assert.match(out.text(), /a note is required to reject/u);
  assert.deepEqual(seen, [
    { action_key: key, decision: "reject", deliveryId, note: "not this vendor" },
  ]);
});

test("end of input is not a decision", async () => {
  const world = live(1);
  const requests = queueOf(world);
  const out = sink();
  const input = new PassThrough();
  const channel = new CliChannel({ output: out, input });
  let called = 0;
  channel.onDecision(() => {
    called += 1;
    throw new Error("the handler must not be called when nobody answered");
  });
  const deliveryId = channel.notify(requests[0] as ChannelRequest);
  input.end();
  const collected = await channel.collectDecision(world.keys[0] as string, deliveryId);
  assert.equal(collected.kind, "aborted");
  assert.equal(called, 0);
});

// ---------------------------------------------------------------------------
// The verb, as a child process
// ---------------------------------------------------------------------------

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Every subprocess case is timed out: a prompt that hangs must FAIL, not stall. */
function runCli(
  args: string[],
  cwd: string,
  options: { input?: string; env?: Record<string, string> } = {},
): Run {
  const childEnv = { ...process.env, ...options.env };
  if (options.env?.["APPROVAL_HUMAN"] === undefined) delete childEnv["APPROVAL_HUMAN"];
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: childEnv,
    timeout: 20_000,
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  assert.equal(result.signal, null, "the command did not exit on its own (it hung)");
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

const CHILD_POLICY = POLICY;
let repoCounter = 0;

interface Repo {
  dir: string;
  key: string;
  payload: Record<string, unknown>;
}

/** A scratch repo the CLI itself built: attested policy, registered task, live request. */
function repo(options: { withRequest?: boolean } = {}): Repo {
  repoCounter += 1;
  const dir = join(scratch.root, `cli-${repoCounter}`);
  mkdirSync(join(dir, "payloads"), { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), CHILD_POLICY, "utf8");

  const key = "task-042:chaser";
  const payload = { to: ["ap@vendor.example"], subject: "Invoice 41 chaser" };
  writeFileSync(join(dir, "payloads", `${encodeURIComponent(key)}.json`), JSON.stringify(payload), "utf8");
  writeFileSync(
    join(dir, "task-042.md"),
    [
      "---",
      "id: task-042",
      "title: Chase deposit",
      "approval:",
      "  origin:",
      "    app: cartsos",
      '    created_by: "human:carter"',
      "  state: proposed",
      "  actions:",
      "    - class: communicate.email.external",
      '      summary: "Send the deposit chaser"',
      "      reversible: false",
      "      est_cost_usd: 0.02",
      `      idempotency_key: "${key}"`,
      `      payload_hash: "${payloadHash(payload)}"`,
      "---",
      "",
      "## Description",
      "Body.",
      "",
    ].join("\n"),
    "utf8",
  );

  assert.equal(runCli(["policy", "attest", "--as", HUMAN], dir).code, 0);
  assert.equal(runCli(["register", "task-042.md", "--as", ACTOR], dir).code, 0);
  if (options.withRequest !== false) {
    const requested = runCli(["request", "task-042", "--action", key, "--as", ACTOR], dir);
    assert.equal(requested.code, 0, `request failed: ${requested.stderr}`);
  }
  return { dir, key, payload };
}

function logEvents(dir: string): Record<string, unknown>[] {
  let raw: string;
  try {
    raw = readFileSync(join(dir, ".approval", "log", "events.jsonl"), "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("without a terminal the queue is listed and the command exits 0", () => {
  const world = repo();
  const run = runCli(["channel", "cli", "--payload-dir", "payloads"], world.dir, { input: "" });

  assert.equal(run.code, 0);
  assert.ok(run.stdout.includes(COMPUTED_MARKER), "no computed marker in the listing");
  assert.ok(run.stdout.includes(CLAIMED_MARKER), "no claimed marker in the listing");
  assert.ok(run.stdout.includes(PAYLOAD_BEGIN) && run.stdout.includes(PAYLOAD_END));
  assert.match(run.stdout, /stdin is not a terminal, so nothing was asked/u);
  // Nothing was recorded: no decision event exists.
  assert.deepEqual(
    logEvents(world.dir).map((record) => record["event"]),
    ["policy.updated", "task.registered", "approval.requested"],
  );
});

test("--json prints the tagged queue with its kind markers intact", () => {
  const world = repo();
  const run = runCli(["channel", "cli", "--payload-dir", "payloads", "--json"], world.dir, {
    input: "",
  });
  assert.equal(run.code, 0);

  const parsed = JSON.parse(run.stdout) as {
    ok: boolean;
    channel: string;
    interactive: boolean;
    pending: Record<string, { kind: string; value: unknown; source?: string; author?: string }>[];
    skipped: unknown[];
  };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.channel, "cli");
  assert.equal(parsed.interactive, false);
  assert.deepEqual(parsed.skipped, []);
  assert.equal(parsed.pending.length, 1);

  const entry = parsed.pending[0] as NonNullable<(typeof parsed.pending)[0]>;
  assert.deepEqual(entry["action_key"], { kind: "computed", value: world.key, source: "log" });
  assert.equal(entry["class"]?.kind, "computed");
  assert.equal(entry["autonomy"]?.value, "manual");
  assert.equal(entry["autonomy"]?.source, "policy-match");
  assert.equal(entry["summary"]?.kind, "claimed");
  assert.equal(entry["summary"]?.author, ACTOR);
  assert.equal(entry["est_cost_usd"]?.kind, "claimed");
  assert.equal(entry["payload_hash"]?.value, payloadHash(world.payload));
  const rendering = entry["fullPayload"]?.value as { hash: string } | undefined;
  assert.equal(rendering?.hash, payloadHash(world.payload));
});

test("an empty queue exits 0 and says so", () => {
  const world = repo({ withRequest: false });
  const run = runCli(["channel", "cli", "--payload-dir", "payloads"], world.dir, { input: "" });
  assert.equal(run.code, 0);
  assert.match(run.stdout, /queue: empty/u);
});

test("a manual request with no payload material is skipped, visibly", () => {
  const world = repo();
  const run = runCli(["channel", "cli"], world.dir, { input: "" });
  assert.equal(run.code, 0);
  assert.match(run.stderr, /skipped task-042:chaser \(payload-unavailable\)/u);
  assert.match(run.stdout, /queue: empty/u);
});

test("a scripted grant records one event and prints the token exactly once", () => {
  const world = repo();
  const run = runCli(
    ["channel", "cli", "--payload-dir", "payloads", "--interactive", "--as", HUMAN],
    world.dir,
    { input: "g\nlooks right\n" },
  );

  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /granted task-042:chaser -> granted at seq 4/u);
  const tokens = run.stdout.match(/^token: [0-9a-f]+$/gmu) ?? [];
  assert.equal(tokens.length, 1, `the token must be printed exactly once, saw ${tokens.length}`);
  assert.match(run.stdout, /shown ONCE/u);

  const events = logEvents(world.dir);
  assert.deepEqual(events.map((record) => record["event"]), [
    "policy.updated",
    "task.registered",
    "approval.requested",
    "approval.granted",
  ]);
  const granted = events[3] as Record<string, unknown>;
  assert.equal(granted["actor"], HUMAN);
  assert.equal((granted["payload"] as Record<string, unknown>)["note"], "looks right");
  // The raw token is nowhere in the log.
  const raw = readFileSync(join(world.dir, ".approval", "log", "events.jsonl"), "utf8");
  const token = (run.stdout.match(/^token: ([0-9a-f]+)$/mu) ?? [])[1] as string;
  assert.ok(token.length > 0);
  assert.equal(raw.includes(token), false, "the raw token must never reach the log");
  assert.equal(runCli(["log", "verify"], world.dir).code, 0);
});

test("a scripted reject re-asks for the mandatory note and records it", () => {
  const world = repo();
  const run = runCli(
    ["channel", "cli", "--payload-dir", "payloads", "--interactive", "--as", HUMAN],
    world.dir,
    { input: "r\n\nwrong vendor\n" },
  );

  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /a note is required to reject/u);
  assert.match(run.stdout, /rejected task-042:chaser -> rejected/u);
  assert.equal(run.stdout.includes("token:"), false, "a rejection mints no token");

  const events = logEvents(world.dir);
  const rejected = events[3] as Record<string, unknown>;
  assert.equal(rejected["event"], "approval.rejected");
  assert.equal((rejected["payload"] as Record<string, unknown>)["note"], "wrong vendor");
  assert.equal(runCli(["log", "verify"], world.dir).code, 0);
});

test("skipping decides nothing and leaves the request pending", () => {
  const world = repo();
  const run = runCli(
    ["channel", "cli", "--payload-dir", "payloads", "--interactive", "--as", HUMAN],
    world.dir,
    { input: "s\n" },
  );
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /skipped; the request stays pending/u);
  assert.equal(logEvents(world.dir).length, 3);
});

test("a gate refusal surfaced from a decision exits 1", () => {
  const world = repo();
  // The policy file is edited after attestation: the gate refuses every decision
  // with policy-not-attested, and the channel reports the refusal verbatim.
  writeFileSync(join(world.dir, "APPROVAL.md"), `${CHILD_POLICY}\n<!-- edited -->\n`, "utf8");

  const run = runCli(
    ["channel", "cli", "--payload-dir", "payloads", "--interactive", "--as", HUMAN],
    world.dir,
    { input: "g\n\n" },
  );
  assert.equal(run.code, 1, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /refused: policy-not-attested/u);
  assert.equal(logEvents(world.dir).length, 3, "a refused decision appends nothing");
});

test("no human identity on the deciding path is a usage error, before anything is rendered", () => {
  const world = repo();
  const run = runCli(["channel", "cli", "--payload-dir", "payloads", "--interactive"], world.dir, {
    input: "g\n\n",
  });
  assert.equal(run.code, 2);
  assert.match(run.stderr, /--as human:<id>/u);
  assert.match(run.stderr, /APPROVAL_HUMAN/u);
  assert.equal(run.stdout.includes(PAYLOAD_BEGIN), false, "nothing may be rendered before identity");
  assert.equal(logEvents(world.dir).length, 3);

  // The same run with APPROVAL_HUMAN set is accepted.
  const withEnv = runCli(
    ["channel", "cli", "--payload-dir", "payloads", "--interactive"],
    world.dir,
    { input: "s\n", env: { APPROVAL_HUMAN: HUMAN } },
  );
  assert.equal(withEnv.code, 0, withEnv.stderr);
});

test("a non-human --as is refused at exit 2", () => {
  const world = repo();
  const run = runCli(
    ["channel", "cli", "--payload-dir", "payloads", "--interactive", "--as", ACTOR],
    world.dir,
    { input: "g\n\n" },
  );
  assert.equal(run.code, 2);
  assert.match(run.stderr, /human-only|human:<id>/u);
});

test("the verb's usage surface: help, unknown subcommand, unknown flag", () => {
  const world = repo({ withRequest: false });
  const help = runCli(["channel", "cli", "--help"], world.dir);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /\[computed\]/u);
  assert.match(help.stdout, /\[claimed\]/u);
  assert.match(help.stdout, /BEGIN FULL PAYLOAD/u);
  assert.match(help.stdout, /IDENTITY IS DECLARED, NOT PROVED/u);
  assert.match(help.stdout, /EXITS 0 WITHOUT READING STDIN/u);

  assert.equal(runCli(["channel"], world.dir).code, 2);
  assert.equal(runCli(["channel", "web"], world.dir).code, 2);
  assert.equal(runCli(["channel", "cli", "--nope"], world.dir).code, 2);
  assert.equal(runCli(["channel", "cli", "extra"], world.dir).code, 2);
});

test("an unreadable log is I/O (4), never corruption", () => {
  const world = repo({ withRequest: false });
  const run = runCli(["channel", "cli", "--log", join(world.dir, "no-such-dir", "events.jsonl")], world.dir, {
    input: "",
  });
  // An absent log is an empty log: nothing pending, exit 0.
  assert.equal(run.code, 0);
  assert.match(run.stdout, /queue: empty/u);

  const asDir = runCli(["channel", "cli", "--log", world.dir], world.dir, { input: "" });
  assert.equal(asDir.code, 4);
  assert.equal(asDir.stderr.includes("corrupt"), false, "an I/O fact must not be called corruption");
});
