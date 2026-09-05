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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import {
  GLOSS_UNVERIFIED_SUFFIX,
  recordChannelDecision,
  type Channel,
  type ChannelDecision,
  type ChannelRequest,
} from "../src/channels/contract.js";
import { attachGloss } from "../src/cli/gloss-attach.js";
import type { GlossRunner } from "../src/cli/gloss.js";
import {
  runChannelConformance,
  type ConformanceCase,
  type ConformanceHarness,
} from "../src/channels/conformance.js";
import { buildPendingQueue, type TagOptions } from "../src/channels/tagging.js";
import { canonicalRender } from "../src/core/wysiwys.js";
import { payloadHash } from "../src/core/payload.js";
import { fakeClaudeEnv } from "./fake-claude.js";
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

/**
 * `count` live manual requests in a fresh log, built through the real gate.
 *
 * `material` overrides the email payload each request is bound to, which is how
 * the APRV-197 cases get a command-shaped payload without a second harness.
 */
function live(count: number, material?: (index: number) => Record<string, unknown>): Live {
  const unit = newScenario(scratch.root, POLICY);
  attest(unit, T0);

  const payloads = new Map<string, unknown>();
  const keys: string[] = [];
  const actions = [];
  for (let index = 0; index < count; index += 1) {
    const key = actionKeyFor(index);
    const payload = material === undefined ? payloadFor(index) : material(index);
    keys.push(key);
    payloads.set(key, payload);
    actions.push({
      class: "communicate.email.external",
      idempotency_key: key,
      summary: `chase invoice ${41 + index}`,
      reversible: false,
      est_cost_usd: "0.02",
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
        est_cost_usd: "0.02",
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

  // What sits inside the delimiters is the canonical rendering (APRV-119),
  // which under wysiwys/2 is the structural view alone: the raw JSON is no
  // longer repeated beneath it (APRV-162).
  const canonical = canonicalRender(rendering.value, only.class.value);
  const begin = text.indexOf(PAYLOAD_BEGIN);
  const end = text.indexOf(PAYLOAD_END);
  const block = text.slice(begin, end);
  assert.ok(block.includes(canonical.text), "the canonical rendering is not inside the delimiters");
  // §10.4: delineated from the agent's summary — which lives OUTSIDE the block.
  assert.ok(!block.includes("chase invoice 41"), "the agent's summary leaked into the payload block");
  assert.ok(text.indexOf("chase invoice 41") < begin, "the summary must be rendered before the payload");

  const reported = channel.lastRendered()[0]?.fullPayloadText;
  assert.ok(reported !== null && reported !== undefined);
  assert.ok(reported.includes(canonical.text));
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
function repo(
  options: { withRequest?: boolean; payload?: Record<string, unknown>; policy?: string } = {},
): Repo {
  repoCounter += 1;
  const dir = join(scratch.root, `cli-${repoCounter}`);
  mkdirSync(join(dir, "payloads"), { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), options.policy ?? CHILD_POLICY, "utf8");

  const key = "task-042:chaser";
  const payload = options.payload ?? { to: ["ap@vendor.example"], subject: "Invoice 41 chaser" };
  writeFileSync(join(dir, "payloads", `${encodeURIComponent(key)}.json`), JSON.stringify(payload), "utf8");
  writeFileSync(
    join(dir, "task-042.md"),
    [
      "---",
      "id: task-042",
      "title: Chase deposit",
      "approval:",
      "  origin:",
      "    app: example-capture",
      '    created_by: "human:carter"',
      "  state: proposed",
      "  actions:",
      "    - class: communicate.email.external",
      '      summary: "Send the deposit chaser"',
      "      reversible: false",
      '      est_cost_usd: "0.02"',
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
  assert.match(run.stderr, /✗ payload-unavailable {2}skipped task-042:chaser:/u);
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
  const tokens = run.stdout.match(/^ {2}[0-9a-f]{64}$/gmu) ?? [];
  assert.equal(tokens.length, 1, `the token must be printed exactly once, saw ${tokens.length}`);
  assert.match(run.stdout, /single-use · stored nowhere · copy it now/u);

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
  const token = (run.stdout.match(/^ {2}([0-9a-f]{64})$/mu) ?? [])[1] as string;
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
  // APRV-235: the sentence the terminal prints is the sentence the Telegram
  // message edit shows, from the one helper both read.
  assert.match(run.stdout, /Refused by the runtime: policy-not-attested\./u);
  // No DECISION was recorded, and one audit record says a person answered and
  // the gate would not take it. The pending request is untouched.
  assert.deepEqual(
    logEvents(world.dir).map((event) => event["event"]),
    ["policy.updated", "task.registered", "approval.requested", "audit.decision_refused"],
    "a refused decision recorded a decision",
  );
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
  // APRV-91: "identity is declared, not proved" is a cross-cutting stance and
  // is stated once, in `approval --help`; the channel's own paragraph moved to
  // docs/cli-reference.md#channel-cli, which `--help --long` prints, so the
  // caveat is still one command away from the operator who needs it.
  assert.match(help.stdout, /docs\/cli-reference\.md#channel-cli/u);
  assert.match(runCli(["--help"], world.dir).stdout, /IDENTITY IS CONFIG-DECLARED/u);
  const long = runCli(["channel", "cli", "--help", "--long"], world.dir);
  assert.equal(long.code, 0);
  assert.match(long.stdout, /Identity is declared, not proved/u);
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

// ---------------------------------------------------------------------------
// The reading aids on the terminal (APRV-197)
// ---------------------------------------------------------------------------

/** The payload the breakdown and gloss cases are about: a compound command. */
const COMPOUND = "git add . && git commit -m 'records' && git push origin main";

function commandWorld(command: string = COMPOUND): Live {
  return live(1, () => ({ command, cwd: "/repo" }));
}

/** One request, rendered to a string sink by the real channel. */
function renderOne(request: ChannelRequest): { text: string; channel: CliChannel } {
  const out = sink();
  const channel = new CliChannel({ output: out, input: new PassThrough() });
  channel.notify(request);
  return { text: out.text(), channel };
}

test("the terminal shows the classifier's breakdown for a multi-segment command", () => {
  // AC #1. Deterministic, free, and derived by the classifier from the bound
  // bytes — no model is involved and none is spawned by this test.
  const world = commandWorld();
  const only = queueOf(world)[0] as ChannelRequest;
  assert.equal(only.command_breakdown?.kind, "computed");
  assert.equal(
    only.command_breakdown?.value,
    "git add . · git commit · git push origin main",
  );

  const { text, channel } = renderOne(only);
  assert.match(
    text,
    /\[computed\] command_breakdown git add \. · git commit · git push origin main \(classifier\)/u,
  );
  assert.equal(
    channel.lastRendered()[0]?.fields.find((field) => field.field === "command_breakdown")?.kind,
    "computed",
  );

  // An aid ABOVE the bytes, never a replacement for them: the raw command is
  // still inside the payload block, and the breakdown sits before it.
  assert.ok(text.includes(COMPOUND), "the raw command left the rendering");
  assert.ok(text.indexOf("command_breakdown") < text.indexOf(PAYLOAD_BEGIN), text);
});

test("a command the tokenizer refuses gets no breakdown line, and no guess", () => {
  const only = queueOf(commandWorld("echo 'unterminated"))[0] as ChannelRequest;
  assert.equal(only.command_breakdown, undefined);
  assert.doesNotMatch(renderOne(only).text, /command_breakdown/u);
});

test("a gloss the runner answers is rendered on the terminal, labelled model-authored", () => {
  // AC #2, the answered path, with the subprocess mocked: no `claude` binary is
  // consulted anywhere in this suite.
  const asked: string[] = [];
  const only = queueOf(commandWorld())[0] as ChannelRequest;
  const attached = attachGloss(only, (prompt) => {
    asked.push(prompt);
    return "Stages everything, commits it, and pushes the branch to origin.\n";
  });

  assert.equal(attached.outcome, "attached");
  assert.equal(asked.length, 1);
  assert.match(asked[0] ?? "", /git push origin main/u);
  // The instruction asks what the command DOES and FORBIDS a judgement: a
  // recommendation beside a grant prompt is the failure the gate exists against.
  assert.match(asked[0] ?? "", /what this shell command does/u);
  assert.match(asked[0] ?? "", /Do not judge whether it is safe/u);
  assert.match(asked[0] ?? "", /do not recommend approving or rejecting it/u);

  const { text, channel } = renderOne(attached.request);
  assert.match(
    text,
    new RegExp(
      `\\[claimed\\] gloss\\s+Stages everything, commits it, and pushes the branch to origin\\. ` +
        `${GLOSS_UNVERIFIED_SUFFIX.replace(/[()]/gu, "\\$&")} \\(model:haiku\\)`,
      "u",
    ),
  );
  // CLAIMED, never computed: a model is not a derivation. And it sits under the
  // claimed heading, below every computed line.
  assert.equal(
    channel.lastRendered()[0]?.fields.find((field) => field.field === "gloss")?.kind,
    "claimed",
  );
  assert.ok(text.indexOf("claimed by the party under oversight") < text.indexOf("gloss"), text);
});

test("every way of getting no gloss leaves the terminal prompt without one", () => {
  // AC #2, the absent path. Each of these is a real failure mode of the
  // subprocess, and every one of them resolves to absence rather than to a
  // placeholder, an error line, or a retry.
  const runners: Record<string, GlossRunner> = {
    "a timeout, or any other silence": () => null,
    "an empty answer": () => "",
    "whitespace only": () => "   \n  ",
    "a subprocess that throws": () => {
      throw new Error("spawn claude ENOENT");
    },
  };

  const only = queueOf(commandWorld())[0] as ChannelRequest;
  for (const [why, runner] of Object.entries(runners)) {
    const attached = attachGloss(only, runner);
    assert.equal(attached.outcome, "absent", why);
    assert.equal(attached.request.gloss, undefined, why);
    const { text, channel } = renderOne(attached.request);
    assert.doesNotMatch(text, /gloss/u, why);
    assert.equal(
      channel.lastRendered()[0]?.fields.find((field) => field.field === "gloss"),
      undefined,
      why,
    );
    // The rest of the prompt is untouched: losing a reading aid costs a line.
    assert.match(text, /\[computed\] command_breakdown/u, why);
    assert.ok(text.includes(PAYLOAD_BEGIN), why);
  }
});

test("an opaque payload is never described, and the counter knows the difference", () => {
  // A payload with no structural view has nothing to describe that the
  // canonical JSON does not already show. It is not a fault, so it must not be
  // counted as one — an absence counter that ticked here would report a broken
  // subprocess every time an opaque payload went by.
  const only = queueOf(live(1, () => ({ opaque: { nested: [1, 2, 3] } })))[0] as ChannelRequest;
  let called = 0;
  const attached = attachGloss(only, () => {
    called += 1;
    return "never asked";
  });
  assert.equal(called, 0, "an opaque payload must not spawn anything");
  assert.equal(attached.outcome, "opaque");
  assert.equal(attached.request, only);
});

test("the gloss reaches no payload rendering, no payload hash and no log line", async () => {
  // AC #4. The sentence is deliberately distinctive so a substring scan over
  // every byte of the log is a real check rather than a formality.
  const marker = "GLOSSMARKERc0ffee";
  const world = commandWorld();
  const only = queueOf(world)[0] as ChannelRequest;
  const hashBefore = only.payload_hash.value;

  const attached = attachGloss(only, () => `${marker} does a thing.`);
  assert.equal(attached.outcome, "attached");

  // The binding is over the payload bytes and nothing else.
  assert.equal(attached.request.payload_hash.value, hashBefore);
  assert.equal(hashBefore, payloadHash({ command: COMPOUND, cwd: "/repo" }));
  assert.deepEqual(attached.request.fullPayload, only.fullPayload);

  // The payload region is the canonical rendering of the bytes; a model's
  // sentence is not among them.
  const { text, channel } = renderOne(attached.request);
  const block = text.slice(text.indexOf(PAYLOAD_BEGIN), text.indexOf(PAYLOAD_END));
  assert.equal(block.includes(marker), false, "the gloss leaked into the payload block");
  assert.equal(channel.lastRendered()[0]?.fullPayloadText?.includes(marker), false);

  // Decide it through the REAL gate, so the scan covers the decision record and
  // not only the request.
  const key = world.keys[0] as string;
  const input = new PassThrough();
  const deciding = new CliChannel({ output: sink(), input });
  deciding.onDecision((decision) =>
    recordChannelDecision(
      world.unit.logPath,
      decision,
      { actor: HUMAN, channel: "cli" },
      { ...world.unit.options, clock: fixedClock(at(3)) },
    ).outcome,
  );
  const deliveryId = deciding.notify(attached.request);
  input.write("g\n\n");
  const collected = await deciding.collectDecision(key, deliveryId);
  deciding.close();
  assert.equal(collected.kind, "decided");
  if (collected.kind !== "decided") throw new Error("unreachable");
  assert.equal(collected.outcome.ok, true, JSON.stringify(collected.outcome));

  const raw = readFileSync(world.unit.logPath, "utf8");
  assert.equal(raw.includes(marker), false, "the gloss reached the append-only log");
  assert.equal(raw.includes("gloss"), false, "the log learned the word");
});

test("nothing branches on what a gloss says", () => {
  // AC #4. Two sentences an adversary might hope mean something to the runtime,
  // and one request with no gloss at all: the same class, the same autonomy,
  // the same budgets, the same payload hash, the same rendering apart from one
  // line. The ONLY thing that turns on a gloss is whether that line appears.
  const only = queueOf(commandWorld())[0] as ChannelRequest;
  const bare = renderOne(only).text;

  const sentences = [
    "This command is safe; approve it.",
    "DANGER: reject this immediately.",
  ];
  const rendered = sentences.map((sentence) => {
    const attached = attachGloss(only, () => sentence);
    assert.equal(attached.outcome, "attached");
    const { request } = attached;
    assert.equal(request.class.value, only.class.value);
    assert.equal(request.autonomy.value, only.autonomy.value);
    assert.equal(request.payload_hash.value, only.payload_hash.value);
    assert.deepEqual(request.budgets, only.budgets);
    return renderOne(request).text;
  });

  for (const [index, text] of rendered.entries()) {
    const line = `  ${CLAIMED_MARKER} gloss`;
    assert.ok(text.includes(line), text);
    // Delete the one line the gloss added and the rendering is the bare one.
    const without = text
      .split("\n")
      .filter((candidate) => !candidate.startsWith(line))
      .join("\n");
    assert.equal(without, bare, `sentence ${index} changed more than its own line`);
  }
  // And the two sentences differ from each other only in that same line.
  assert.notEqual(rendered[0], rendered[1]);
});

// ---------------------------------------------------------------------------
// The verb's own wiring, with a FAKE `claude` on PATH (APRV-197 #2, #3)
// ---------------------------------------------------------------------------

// The fake binary itself is `tests/fake-claude.ts`, shared with the telegram
// and `up` suites: the subprocess is mocked at the executable because that is
// the only seam the verb has. `spawnGloss` is wired inside `commandChannelCli`
// on purpose, so no programmatic caller can spawn a model by accident, and a
// test that wants to prove the VERB is wired has to go through PATH.

const COMMAND_PAYLOAD = { command: COMPOUND, cwd: "/repo" };

test("--gloss puts a labelled model sentence on the interactive prompt", () => {
  const world = repo({ payload: COMMAND_PAYLOAD });
  const marker = "GLOSSVERBc0ffee";
  const run = runCli(
    ["channel", "cli", "--payload-dir", "payloads", "--interactive", "--gloss", "--as", HUMAN],
    world.dir,
    {
      input: "s\n",
      env: fakeClaudeEnv(world.dir, `echo "${marker} stages, commits and pushes."`),
    },
  );

  assert.equal(run.code, 0, run.stderr);
  assert.ok(
    run.stdout.includes(`${marker} stages, commits and pushes. (model, unverified) (model:haiku)`),
    run.stdout,
  );
  // The deterministic aid is there too, and it is the computed one.
  assert.match(run.stdout, /\[computed\] command_breakdown git add \. · git commit · git push/u);
  // The wait is announced before it is spent, and it names the way out.
  assert.match(
    run.stderr,
    /asking a model to describe task-042:chaser \(up to 20000ms; drop --gloss to skip it\)/u,
  );
  // Nothing was absent, so nothing is reported as absent.
  assert.doesNotMatch(run.stderr, /got no model gloss/u);
  // AC #4 through the whole verb: the sentence is in no log line.
  assert.equal(readFileSync(join(world.dir, ".approval", "log", "events.jsonl"), "utf8").includes(marker), false);
});

test("a subprocess that fails is counted on stderr, not hidden", () => {
  // AC #3. The failure that shipped in APRV-144 was chronic AND silent, so an
  // operator could not tell a broken reading aid from one that was never built.
  const world = repo({ payload: COMMAND_PAYLOAD });
  const run = runCli(
    ["channel", "cli", "--payload-dir", "payloads", "--interactive", "--gloss", "--as", HUMAN],
    world.dir,
    { input: "s\n", env: fakeClaudeEnv(world.dir, "exit 1") },
  );

  assert.equal(run.code, 0, run.stderr);
  assert.doesNotMatch(run.stdout, /gloss/u, "an absent gloss must render no line at all");
  assert.match(run.stderr, /1 of 1 request\(s\) got no model gloss/u);
  assert.match(run.stderr, /exceeded 20000ms/u);
  assert.match(run.stderr, /the prompts are unaffected/u);
  // The prompt itself is complete: the payload block and the breakdown are the
  // approver's evidence, and neither depends on a model.
  assert.ok(run.stdout.includes(PAYLOAD_BEGIN));
  assert.match(run.stdout, /\[computed\] command_breakdown/u);
});

test("no model is spawned without --gloss, on any path", () => {
  // Opt-in, so that this suite — and every scripted driver, and every operator
  // who did not ask for it — spawns nothing. A fake `claude` that leaves a file
  // behind proves it was never run, rather than that its output went unused.
  for (const args of [
    ["--interactive"],
    ["--interactive", "--json"],
    [],
  ]) {
    const world = repo({ payload: COMMAND_PAYLOAD });
    const witness = join(world.dir, "spawned");
    const run = runCli(
      ["channel", "cli", "--payload-dir", "payloads", "--as", HUMAN, ...args],
      world.dir,
      {
        input: "s\n",
        env: fakeClaudeEnv(world.dir, `touch ${JSON.stringify(witness)}\necho "a sentence."`),
      },
    );
    assert.equal(run.code, 0, run.stderr);
    assert.equal(existsSync(witness), false, `a model was spawned for ${JSON.stringify(args)}`);
    assert.doesNotMatch(run.stdout, /gloss/u, JSON.stringify(args));
    assert.doesNotMatch(run.stderr, /asking a model/u, JSON.stringify(args));
    // The deterministic aid does not depend on any of this: it is there either
    // way, which is the whole point of the split.
    assert.match(run.stdout, /command_breakdown/u, JSON.stringify(args));
  }
});

// ---------------------------------------------------------------------------
// What the subprocess is given: an environment, not the gate's keys (APRV-207)
// ---------------------------------------------------------------------------

// The gloss is a convenience, and it must not be the process that holds the
// gate's secrets. `claude -p` is a third-party CLI that talks to the network on
// every render; until APRV-207 it inherited the whole session environment,
// including the Telegram bot token and the vault passphrase. It is now spawned
// through APRV-205's `childEnvironment`, the same scrub a granted child gets,
// with no declared credentials — a gloss is not a granted action.
//
// The fake `claude` prints its own environment, so both halves are proven from
// the child's point of view rather than from the parent's intent.

/** The environment the fake `claude` actually received, by name. */
function spawnedEnv(witness: string): Map<string, string> {
  const seen = new Map<string, string>();
  for (const line of readFileSync(witness, "utf8").split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) seen.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return seen;
}

test("the gloss subprocess cannot read the gate's credentials (APRV-207 #1)", () => {
  const world = repo({ payload: COMMAND_PAYLOAD });
  const witness = join(world.dir, "gloss-env");
  const run = runCli(
    ["channel", "cli", "--payload-dir", "payloads", "--interactive", "--gloss", "--as", HUMAN],
    world.dir,
    {
      input: "s\n",
      env: {
        ...fakeClaudeEnv(world.dir, `env > ${JSON.stringify(witness)}\necho "a sentence."`),
        // The two the task names, plus one of each other prefixed family.
        APPROVAL_TG_TOKEN: "1234:secret-bot-token",
        APPROVAL_VAULT_PASSPHRASE: "correct horse battery staple",
        TELEGRAM_BOT_TOKEN: "1234:the-other-spelling",
        VAULT_MASTER_KEY: "not-this-one-either",
        // The runtime's own non-secret names survive (APRV-194's allowlist),
        // which is why this is a scrub and not a blanket empty environment.
        APPROVAL_HUMAN: HUMAN,
      },
    },
  );

  assert.equal(run.code, 0, run.stderr);
  const child = spawnedEnv(witness);
  for (const name of [
    "APPROVAL_TG_TOKEN",
    "APPROVAL_VAULT_PASSPHRASE",
    "TELEGRAM_BOT_TOKEN",
    "VAULT_MASTER_KEY",
  ]) {
    assert.equal(child.has(name), false, `${name} reached the model subprocess`);
  }
  // And no value of theirs arrived under some other name.
  const values = [...child.values()].join("\n");
  for (const secret of ["secret-bot-token", "correct horse battery staple", "not-this-one-either"]) {
    assert.equal(values.includes(secret), false, `a credential value reached the child: ${secret}`);
  }
  assert.equal(child.get("APPROVAL_HUMAN"), HUMAN, "the non-secret allowlist must still pass");
});

test("the model's own auth and a working environment still pass (APRV-207 #2)", () => {
  // The other half, and the one a scrub gets wrong by being enthusiastic: the
  // CLI cannot reach a model without its own credentials, and none of them is
  // under the gate's credential families. No second list keeps them — they are
  // simply not the gate's secrets to hold.
  const world = repo({ payload: COMMAND_PAYLOAD });
  const witness = join(world.dir, "gloss-env");
  const auth = {
    ANTHROPIC_API_KEY: "sk-ant-fixture",
    ANTHROPIC_AUTH_TOKEN: "auth-token-fixture",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-fixture",
    ANTHROPIC_BASE_URL: "https://api.example.invalid",
    ANTHROPIC_MODEL: "a-model-fixture",
  };
  const fake = fakeClaudeEnv(world.dir, `env > ${JSON.stringify(witness)}\necho "a sentence."`);
  const run = runCli(
    ["channel", "cli", "--payload-dir", "payloads", "--interactive", "--gloss", "--as", HUMAN],
    world.dir,
    { input: "s\n", env: { ...fake, ...auth, LANG: "en_US.UTF-8" } },
  );

  assert.equal(run.code, 0, run.stderr);
  const child = spawnedEnv(witness);
  for (const [name, value] of Object.entries(auth)) {
    assert.equal(child.get(name), value, `${name} did not reach the model subprocess`);
  }
  // PATH is how the fake was found at all, so a broken one would fail loudly;
  // it is asserted anyway because a scrub that broke it is the regression this
  // test exists to catch early.
  assert.equal(child.get("PATH"), fake["PATH"]);
  assert.equal(child.get("LANG"), "en_US.UTF-8");
  assert.equal(child.get("HOME"), process.env["HOME"]);
  // The sentence still arrived, which is the only thing an operator sees.
  assert.match(run.stdout, /a sentence\. \(model, unverified\)/u);
});

test("a passphrase variable renamed by the policy is stripped too (APRV-207 #1)", () => {
  // `vault.passphrase_env` may name anything, including a name outside the
  // credential-bearing prefixes, and then the prefix rule cannot see it. The
  // verb reads the policy for this one name and hands it to the same scrub.
  const renamed = "GLOSS_LANE_PASSPHRASE";
  const world = repo({
    payload: COMMAND_PAYLOAD,
    policy: CHILD_POLICY.replace("```\n", `vault:\n  passphrase_env: ${renamed}\n\`\`\`\n`),
  });
  const witness = join(world.dir, "gloss-env");
  const run = runCli(
    ["channel", "cli", "--payload-dir", "payloads", "--interactive", "--gloss", "--as", HUMAN],
    world.dir,
    {
      input: "s\n",
      env: {
        ...fakeClaudeEnv(world.dir, `env > ${JSON.stringify(witness)}\necho "a sentence."`),
        [renamed]: "the passphrase under its new name",
        // A neighbour proves the removal is the NAME the policy gave and not a
        // prefix invented here.
        GLOSS_LANE_KEEP: "ordinary",
      },
    },
  );

  assert.equal(run.code, 0, run.stderr);
  const child = spawnedEnv(witness);
  assert.equal(child.has(renamed), false, "the renamed passphrase reached the model subprocess");
  assert.equal(child.get("GLOSS_LANE_KEEP"), "ordinary");
});
