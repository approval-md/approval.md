/**
 * Web queue channel tests (APRV-25).
 *
 * Every case runs against a real `node:http` server bound to an **ephemeral**
 * loopback port (`port: 0`), driven with `fetch` and form bodies — no browser,
 * no JavaScript, and no fixed port that could collide with a developer's own
 * `approval channel web`. The first thing asserted is the thing the whole
 * design rests on: the socket is on 127.0.0.1 and nowhere else.
 *
 * Same discipline as every other suite here: no log line is written by hand.
 * The policy is attested through `core/attest.ts`, tasks are registered and
 * requested through `core/gate.ts`, and every decision — including the ones
 * made by POSTing a form — goes through `recordChannelDecision` /
 * `recordBatchDecisions` and the human-only `decide()`.
 *
 * The negative cases carry the weight: a reject with no note, a cross-origin
 * POST, a forbidden batch mix and a second click on an already-decided request
 * must each leave the log exactly as they found it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";

import {
  BATCH_DELIVERY_ID_FIELD,
  batchDeliveryIdOf,
  recordChannelDecision,
  type ChannelDecision,
  type ChannelRequest,
  type DecisionOutcome,
} from "../src/channels/contract.js";
import {
  runChannelConformance,
  type ConformanceCase,
  type ConformanceHarness,
} from "../src/channels/conformance.js";
import { buildPendingQueue, type TagOptions } from "../src/channels/tagging.js";
import {
  CLAIMED_MARKER,
  COMPUTED_HEADING,
  COMPUTED_MARKER,
  PAYLOAD_BEGIN,
  WebChannel,
  WEB_DEFAULT_PORT,
  WEB_LOOPBACK_HOST,
} from "../src/channels/web.js";
import {
  commandWeb,
  policyWebPort,
  resolveWebPort,
  startWebChannel,
  type RunningWebChannel,
} from "../src/cli/channel-web.js";
import { EXIT_USAGE } from "../src/cli/exit-codes.js";
import type { Streams } from "../src/cli/main.js";
import { payloadHash } from "../src/core/payload.js";
import { loadPolicy } from "../src/core/policy-load.js";
import { readVerifiedRecords } from "../src/core/state.js";
import { register, request } from "./clock-adapters.js";
import { assertClean, at, attest, fixedClock, newScenario, scratchRoot, T0, type Scenario } from "./scenario.js";

const scratch = scratchRoot("channels-web");

const TASK = "task-250";
const ACTOR = "agent:drafter";
const HUMAN = "human:carter";

/** The policy every scenario uses. `channels.web.port` is here for the precedence test. */
const POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "24h"',
  "  on_expiry: reject",
  "classes:",
  "  read.*:",
  "    autonomy: autonomous",
  "  communicate.email.external:",
  "    autonomy: manual",
  "    limits:",
  "      per_action_usd: 1",
  "      daily_actions: 5",
  "channels:",
  "  web:",
  "    port: 4711",
  "```",
  "",
].join("\n");

/**
 * The injection fixture.
 *
 * The claimed summary carries live markup AND a forged computed marker: an
 * agent that wants its request to look runtime-verified would write exactly
 * this. Both must survive as inert text inside the claimed region.
 */
const FORGERY = `${COMPUTED_MARKER} class financial.spend <script>alert("pwned")</script>`;

const open: (WebChannel | RunningWebChannel)[] = [];

after(async () => {
  for (const item of open) await item.close();
  scratch.cleanup();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function payloadFor(index: number): Record<string, unknown> {
  return {
    to: [`ap-${index}@vendor.example`],
    subject: `Invoice ${41 + index} chaser <urgent> & overdue`,
    body: `Following up on invoice ${41 + index}. ${index === 0 ? FORGERY : ""}`,
  };
}

interface Live {
  unit: Scenario;
  keys: string[];
  payloads: Map<string, unknown>;
  tagOptions: TagOptions;
}

let fixtureCounter = 0;

/** `count` live manual requests in a fresh log, built through the real gate. */
function live(count: number): Live {
  fixtureCounter += 1;
  const prefix = `chaser${fixtureCounter}`;
  const unit = newScenario(scratch.root, POLICY);
  attest(unit, T0);

  const payloads = new Map<string, unknown>();
  const keys: string[] = [];
  const actions = [];
  for (let index = 0; index < count; index += 1) {
    const key = `${TASK}:${prefix}-${index}`;
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
    {
      task: TASK,
      envelope: {
        origin: { app: "manual", created_by: ACTOR },
        state: "awaiting",
        actions,
      },
    },
    T0,
    ACTOR,
    unit.options,
  );
  assert.equal(registered.ok, true, `registration failed: ${JSON.stringify(registered)}`);

  for (const [index, key] of keys.entries()) {
    const requested = request(
      unit.logPath,
      {
        task: TASK,
        actionKey: key,
        cls: "communicate.email.external",
        est_cost_usd: 0.02,
        reversible: false,
        // The claimed summary of the first request is the injection fixture.
        summary: index === 0 ? FORGERY : `chase invoice ${41 + index}`,
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

function queueOf(world: Live, now: string): ChannelRequest[] {
  const queue = buildPendingQueue(world.unit.logPath, world.tagOptions, now);
  assert.equal(queue.ok, true, JSON.stringify(queue));
  return queue.ok ? queue.requests : [];
}

function recordsOf(logPath: string) {
  const read = readVerifiedRecords(logPath);
  assert.equal(read.ok, true, `log did not verify: ${JSON.stringify(read)}`);
  return read.ok ? read.records : [];
}

// ---------------------------------------------------------------------------
// Driving the server
// ---------------------------------------------------------------------------

interface Reply {
  status: number;
  body: string;
}

async function get(origin: string, path = "/"): Promise<Reply> {
  const response = await fetch(`${origin}${path}`);
  return { status: response.status, body: await response.text() };
}

/** A form POST, exactly as a browser with scripting disabled would send it. */
async function post(
  origin: string,
  path: string,
  fields: [string, string][],
  headers: Record<string, string> = {},
): Promise<Reply> {
  const body = new URLSearchParams();
  for (const [name, value] of fields) body.append(name, value);
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: body.toString(),
  });
  return { status: response.status, body: await response.text() };
}

/** Start a runtime-wired server over `world`, pinned to the display instant `now`. */
async function serve(world: Live, now: string): Promise<RunningWebChannel> {
  const running = await startWebChannel({
    logPath: world.unit.logPath,
    actor: HUMAN,
    policy: { file: world.unit.policyPath },
    port: 0,
    payload: (key) => world.payloads.get(key),
    now: () => now,
    gateOptions: { clock: fixedClock(now) },
    log: () => {
      /* quiet: the skipped/queue complaints are asserted elsewhere */
    },
  });
  open.push(running);
  return running;
}

function originOf(running: RunningWebChannel): string {
  return `http://${WEB_LOOPBACK_HOST}:${running.port}`;
}

// ---------------------------------------------------------------------------
// The shared conformance suite (APRV-22), unmodified
// ---------------------------------------------------------------------------

const outcomes = new WeakMap<WebChannel, { outcome?: DecisionOutcome }>();

/**
 * A bare channel with no runtime attached.
 *
 * `decisionNotice` is the hook the runtime normally uses to show a token once;
 * here it doubles as the harness's way of learning what the gate answered,
 * since a form POST hands back a page rather than a value.
 */
function makeWebChannel(): WebChannel {
  const box: { outcome?: DecisionOutcome } = {};
  const channel = new WebChannel({
    port: 0,
    log: () => {
      /* quiet */
    },
    decisionNotice: (_decision, outcome) => {
      box.outcome = outcome;
      return null;
    },
  });
  outcomes.set(channel, box);
  open.push(channel);
  return channel;
}

let caseCounter = 0;

const harness: ConformanceHarness = {
  setup(count: number): ConformanceCase {
    caseCounter += 1;
    const world = live(count);
    const now = at(2 + caseCounter);
    const requests = queueOf(world, now);
    assert.equal(requests.length, count, "the harness could not build the requested queue");
    return {
      logPath: world.unit.logPath,
      requests,
      actor: { actor: HUMAN, channel: "web" },
      gateOptions: { ...world.unit.options, clock: fixedClock(now) },
    };
  },
  async decide(channel, decision) {
    const web = channel as WebChannel;
    if (web.server === null) await web.start();
    const reply = await post(web.origin, "/decide", [
      ["action_key", decision.action_key],
      ["decision", decision.decision],
      ...(decision.note === undefined ? [] : ([["note", decision.note]] as [string, string][])),
    ]);
    const box = outcomes.get(web);
    assert.ok(
      box?.outcome !== undefined,
      `the form POST produced no decision (status ${reply.status})`,
    );
    const outcome = box.outcome;
    delete box.outcome;
    return outcome;
  },
};

test("the web channel passes the shared conformance suite", async (t) => {
  await runChannelConformance(t, () => makeWebChannel(), harness);
});

// ---------------------------------------------------------------------------
// The socket
// ---------------------------------------------------------------------------

test("the server binds 127.0.0.1 and nothing else", async () => {
  const world = live(1);
  const running = await serve(world, at(2));

  const address = running.channel.address();
  assert.ok(address !== null, "the channel reports no bound address");
  assert.equal(address.address, WEB_LOOPBACK_HOST, "the server did not bind loopback");
  assert.equal(address.family, "IPv4");
  assert.equal(WEB_LOOPBACK_HOST, "127.0.0.1");

  // There is deliberately no --host: the flag table of the verb does not carry
  // one, and the loopback host is a module constant rather than an option.
  const health = running.channel.health();
  assert.equal(health.ok, true);
  assert.match(health.detail ?? "", /loopback only/u);
});

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

test("the queue page splits computed from claimed and neutralizes claimed markup", async () => {
  const world = live(1);
  const running = await serve(world, at(2));
  const page = await get(originOf(running));
  assert.equal(page.status, 200);

  assert.ok(page.body.includes(COMPUTED_HEADING), "the computed heading is missing");
  assert.match(page.body, /CLAIMED — authored by agent:drafter — NOT verified by the runtime/u);
  assert.ok(page.body.includes(CLAIMED_MARKER), "no claimed marker on the page");

  // The claimed summary carried live markup and a forged computed marker.
  // Both survive as inert text, and neither reaches the document as markup.
  assert.equal(page.body.includes("<script>alert"), false, "raw markup reached the page");
  assert.match(page.body, /&lt;script&gt;alert\(&quot;pwned&quot;\)&lt;\/script&gt;/u);
  assert.match(page.body, /Invoice 41 chaser &lt;urgent&gt; &amp; overdue/u);

  // The forgery is inside the claimed region and in no computed region.
  const claimedRegions = [...page.body.matchAll(/<div class="claimed">([\s\S]*?)<\/div>/gu)].map(
    (match) => match[1] ?? "",
  );
  const computedRegions = [...page.body.matchAll(/<div class="computed">([\s\S]*?)<\/div>/gu)].map(
    (match) => match[1] ?? "",
  );
  assert.ok(claimedRegions.length > 0 && computedRegions.length > 0);
  assert.ok(
    claimedRegions.some((region) => region.includes("financial.spend")),
    "the forged summary is not in the claimed region",
  );
  assert.equal(
    computedRegions.some((region) => region.includes("financial.spend")),
    false,
    "an agent's forged marker was rendered inside the computed region (SPEC.md §9)",
  );

  // And the channel reports the same split it served.
  const rendered = running.channel.lastRendered();
  assert.equal(rendered.length, 1);
  const summary = rendered[0]?.fields.find((field) => field.field === "summary");
  assert.equal(summary?.kind, "claimed");

  // Rendering wrote nothing: register + attest + request = 3 records.
  assert.equal(recordsOf(world.unit.logPath).length, 3);
});

test("the page carries the full payload, hash-labelled, and the §11 trust banner", async () => {
  const world = live(1);
  const key = world.keys[0] as string;
  const running = await serve(world, at(2));
  const page = await get(originOf(running));

  const hash = payloadHash(world.payloads.get(key));
  assert.ok(page.body.includes(`${PAYLOAD_BEGIN} (bound sha256 ${hash}) ---`), "no hash label");
  assert.match(page.body, /<pre class="payload">/u);
  assert.match(page.body, /FULL PAYLOAD — the exact bytes this approval binds to/u);
  assert.match(page.body, /ap-0@vendor.example/u);

  assert.match(page.body, /TRUST BOUNDARY — this page has NO AUTHENTICATION/u);
  assert.match(page.body, /SPEC.md §11/u);
  assert.match(page.body, /human:carter/u, "the page names the actor decisions are recorded as");
});

// ---------------------------------------------------------------------------
// Unit decisions
// ---------------------------------------------------------------------------

test("a grant records one event and shows the token exactly once, never in the log", async () => {
  const world = live(1);
  const key = world.keys[0] as string;
  const running = await serve(world, at(2));
  const origin = originOf(running);
  await get(origin);

  const before = recordsOf(world.unit.logPath).length;
  const reply = await post(origin, "/decide", [
    ["action_key", key],
    ["decision", "grant"],
    ["note", "checked the invoice"],
  ]);
  assert.equal(reply.status, 200);
  assert.match(reply.body, /GRANTED/u);
  assert.match(reply.body, /SHOWN ONCE/u);

  const after_ = recordsOf(world.unit.logPath);
  assert.equal(after_.length, before + 1);
  const appended = after_[after_.length - 1];
  assert.equal(appended?.event, "approval.granted");
  assert.equal(appended?.actor, HUMAN);

  const token = /execution token for [\s\S]*?: ([A-Za-z0-9._~+/=-]+)<\/pre>/u.exec(reply.body)?.[1];
  assert.ok(token !== undefined && token.length > 16, "no token was shown on the response page");

  // The log holds only the token's SHA-256 — the raw value appears nowhere in
  // the bytes on disk.
  const raw = readFileSync(world.unit.logPath, "utf8");
  assert.equal(raw.includes(token), false, "the raw execution token reached the log");

  // Shown ONCE: the queue page after the grant carries no token, and the
  // request is gone from the queue.
  const page = await get(origin);
  assert.equal(page.body.includes(token), false, "the token survived into a later page");
  assert.equal(page.body.includes(key), false, "a decided request is still in the queue");
  assertClean(world.unit);
});

test("a reject without a note is refused 422 and records nothing; with one it records", async () => {
  const world = live(1);
  const key = world.keys[0] as string;
  const running = await serve(world, at(2));
  const origin = originOf(running);

  const before = recordsOf(world.unit.logPath).length;
  const refused = await post(origin, "/decide", [
    ["action_key", key],
    ["decision", "reject"],
    ["note", "   "],
  ]);
  assert.equal(refused.status, 422);
  assert.match(refused.body, /A note is REQUIRED to reject/u);
  assert.equal(recordsOf(world.unit.logPath).length, before, "a note-less reject was recorded");

  const accepted = await post(origin, "/decide", [
    ["action_key", key],
    ["decision", "reject"],
    ["note", "wrong recipient"],
  ]);
  assert.equal(accepted.status, 200);
  const records = recordsOf(world.unit.logPath);
  assert.equal(records.length, before + 1);
  const appended = records[records.length - 1];
  assert.equal(appended?.event, "approval.rejected");
  assert.equal((appended?.payload as { note?: string } | undefined)?.note, "wrong recipient");
  assertClean(world.unit);
});

test("a second decision is idempotent: already-decided is surfaced, nothing is appended", async () => {
  const world = live(1);
  const key = world.keys[0] as string;
  const running = await serve(world, at(2));
  const origin = originOf(running);

  const first = await post(origin, "/decide", [
    ["action_key", key],
    ["decision", "grant"],
  ]);
  assert.equal(first.status, 200);
  const afterFirst = recordsOf(world.unit.logPath).length;

  const second = await post(origin, "/decide", [
    ["action_key", key],
    ["decision", "grant"],
  ]);
  assert.equal(second.status, 409);
  assert.match(second.body, /already-decided/u);
  assert.equal(
    recordsOf(world.unit.logPath).length,
    afterFirst,
    "a duplicate click appended a second event",
  );
  assertClean(world.unit);
});

// ---------------------------------------------------------------------------
// Batching (SPEC.md §10.3, B7)
// ---------------------------------------------------------------------------

test("a batch gesture records one event per member, each carrying the batch delivery id", async () => {
  const world = live(2);
  const [first, second] = world.keys as [string, string];
  const running = await serve(world, at(2));
  const origin = originOf(running);

  const page = await get(origin);
  assert.match(page.body, /id="batch-form"/u);
  assert.match(page.body, /form="batch-form"/u, "checkboxes must attach to the batch form");

  const before = recordsOf(world.unit.logPath).length;
  const reply = await post(origin, "/decide-batch", [
    ["select", first],
    ["select", second],
    ["decision", "grant"],
  ]);
  assert.equal(reply.status, 200);

  const records = recordsOf(world.unit.logPath);
  assert.equal(records.length, before + 2, "the log never batches: two members, two events");
  const appended = records.slice(before);
  const ids = new Set<string>();
  for (const record of appended) {
    assert.equal(record.event, "approval.granted");
    // First-class payload field since APRV-38 (amended SPEC.md §10.3). The id
    // no longer rides in `note`, so the note stays the human's own text.
    const id = (record.payload as Record<string, unknown>)[BATCH_DELIVERY_ID_FIELD];
    assert.equal(typeof id, "string");
    assert.match(id as string, /^web-batch-\d+$/u);
    assert.equal(batchDeliveryIdOf(record), id);
    assert.equal(
      (record.payload as { note?: string }).note,
      undefined,
      "a batch grant with no human note must record no note",
    );
    ids.add(id as string);
  }
  assert.equal(ids.size, 1, "the members carry different batch delivery ids");
  assertClean(world.unit);
});

test("a batch that would hide a payload is refused with the contract's code, recording nothing", async () => {
  const world = live(2);
  const requests = queueOf(world, at(2));
  assert.equal(requests.length, 2);
  const [first, second] = requests as [ChannelRequest, ChannelRequest];
  assert.notEqual(first.payload_hash.value, second.payload_hash.value);

  // The second member arrives truncated — the B7 forbidden mix.
  const truncated: ChannelRequest = {
    ...second,
    fullPayload: {
      kind: "computed",
      source: "payload-binding",
      value:
        second.fullPayload.value === null
          ? null
          : { ...second.fullPayload.value, truncated: true },
    },
  };

  const channel = new WebChannel({
    port: 0,
    refresh: () => [first, truncated],
    log: () => {
      /* quiet */
    },
  });
  open.push(channel);
  channel.onDecision((decision: ChannelDecision) =>
    recordChannelDecision(
      world.unit.logPath,
      decision,
      { actor: HUMAN, channel: "web" },
      { ...world.unit.options, clock: fixedClock(at(2)) },
    ).outcome,
  );
  await channel.start();

  const before = recordsOf(world.unit.logPath).length;
  const reply = await post(channel.origin, "/decide-batch", [
    ["select", first.action_key.value],
    ["select", truncated.action_key.value],
    ["decision", "grant"],
  ]);

  assert.equal(reply.status, 422);
  assert.match(reply.body, /batch-forbidden-mix/u);
  assert.match(reply.body, /Nothing was recorded/u);
  assert.equal(
    recordsOf(world.unit.logPath).length,
    before,
    "a refused batch still wrote to the log",
  );
  assertClean(world.unit);
});

// ---------------------------------------------------------------------------
// Hardening
// ---------------------------------------------------------------------------

test("a clearly cross-origin POST is refused 403 and records nothing", async () => {
  const world = live(1);
  const key = world.keys[0] as string;
  const running = await serve(world, at(2));
  const origin = originOf(running);

  const before = recordsOf(world.unit.logPath).length;
  const reply = await post(
    origin,
    "/decide",
    [
      ["action_key", key],
      ["decision", "grant"],
    ],
    { origin: "http://evil.example", referer: "http://evil.example/trap" },
  );

  assert.equal(reply.status, 403);
  assert.match(reply.body, /Refused/u);
  assert.equal(recordsOf(world.unit.logPath).length, before, "a cross-origin POST was recorded");

  // The same-origin POST still works, which is what makes the check a check
  // rather than a wall.
  const allowed = await post(
    origin,
    "/decide",
    [
      ["action_key", key],
      ["decision", "grant"],
    ],
    { origin },
  );
  assert.equal(allowed.status, 200);
  assert.equal(recordsOf(world.unit.logPath).length, before + 1);
  assertClean(world.unit);
});

test("unknown paths and methods answer without touching the log", async () => {
  const world = live(1);
  const running = await serve(world, at(2));
  const origin = originOf(running);
  const before = recordsOf(world.unit.logPath).length;

  assert.equal((await get(origin, "/nope")).status, 404);
  const deleted = await fetch(`${origin}/decide`, { method: "DELETE" });
  assert.equal(deleted.status, 405);
  await deleted.text();

  assert.equal(recordsOf(world.unit.logPath).length, before);
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test("port precedence: --port beats policy beats 4680", () => {
  const world = live(1);
  const load = loadPolicy({ file: world.unit.policyPath });
  assert.equal(load.ok, true, JSON.stringify(load));
  assert.equal(policyWebPort(load), 4711, "channels.web.port was not read from the policy");

  const fromPolicy = resolveWebPort(null, policyWebPort(load));
  assert.deepEqual(fromPolicy, { ok: true, port: 4711 });

  const fromFlag = resolveWebPort("5000", policyWebPort(load));
  assert.deepEqual(fromFlag, { ok: true, port: 5000 }, "--port must win over the policy");

  assert.deepEqual(resolveWebPort(null, null), { ok: true, port: WEB_DEFAULT_PORT });
  assert.equal(WEB_DEFAULT_PORT, 4680, "SPEC.md §5.1 names 4680");

  const bad = resolveWebPort("http", null);
  assert.equal(bad.ok, false);
  const outOfRange = resolveWebPort("70000", null);
  assert.equal(outOfRange.ok, false);
});

test("the verb refuses to bind without a human identity (exit 2)", () => {
  const world = live(1);
  const out: string[] = [];
  const err: string[] = [];
  const streams: Streams = { out: (text) => out.push(text), err: (text) => err.push(text) };

  const saved = process.env["APPROVAL_HUMAN"];
  delete process.env["APPROVAL_HUMAN"];
  try {
    const code = commandWeb(
      ["--log", world.unit.logPath, "--policy", world.unit.policyPath, "--port", "0"],
      streams,
      world.unit.dir,
    );
    assert.equal(code, EXIT_USAGE, "a server with no approver must not start");
    assert.match(err.join(""), /no human identity/u);
    assert.equal(out.join(""), "", "nothing was served");

    const nonHuman = commandWeb(["--as", "agent:drafter", "--port", "0"], streams, world.unit.dir);
    assert.equal(nonHuman, EXIT_USAGE);
    assert.match(err.join(""), /approvals are human-only/u);
  } finally {
    if (saved !== undefined) process.env["APPROVAL_HUMAN"] = saved;
  }
});
