/**
 * QUEUE.md renderer tests (APRV-24).
 *
 * Same discipline as every other suite here: nothing hand-writes a log line.
 * The policy is attested through `core/attest.ts`, tasks are registered and
 * requested through `core/gate.ts`, decisions go through the real human-only
 * `decide()`, and timestamps are injected as clocks (amended SPEC.md §8, A2).
 * The two hand-written files are a *copy* of a real log with one record
 * tampered and a copy with its final newline removed — the corruption is the
 * fixture, not a fabricated authorization.
 *
 * The properties under test are the ones SPEC.md §9.1 and the task's acceptance
 * criteria actually turn on:
 *
 * - **Determinism.** Same log, same `now` → the same bytes, twice, and from a
 *   byte-copied log at a different path. A projection that is not reproducible
 *   is not a projection of anything.
 * - **`now` is an input.** A different instant moves the countdown lines and
 *   the evaluated-at line, and nothing else.
 * - **B3.** Computed lines name their derivation; claimed lines name their
 *   author; the two never share a list.
 * - **The renderer writes nothing but QUEUE.md**, and the log's bytes and mtime
 *   are untouched — asserted, not assumed.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  RENDER_QUEUE_REFUSAL_CODES,
  renderQueue,
  writeQueue,
  type RenderQueueOptions,
} from "../src/channels/render-queue.js";
import { appendEvent } from "../src/core/log.js";
import { payloadHash } from "../src/core/payload.js";
import { verify } from "../src/core/verify.js";
import { decide, register, request } from "./clock-adapters.js";
import {
  assertClean,
  at,
  attest,
  newScenario,
  scratchRoot,
  T0,
  type Scenario,
} from "./scenario.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = scratchRoot("render-queue");
after(scratch.cleanup);

const TASK = "task-100";
const ACTOR = "agent:drafter";
const HUMAN = "human:carter";

/** A policy with real limits, so the rendered budget block is not empty. */
const POLICY_WITH_LIMITS = [
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
  "      daily_actions: 5",
  "```",
  "",
].join("\n");

/**
 * The same policy with a TTL long enough to outlive the machine clock.
 *
 * The in-process suites inject the instant, so a one-hour TTL is exactly what
 * they want. The subprocess suites cannot: `approval render` reads the real
 * clock, by design, and the fixture's requests are timestamped at a fixed
 * instant, so a one-hour TTL would make them expired-by-wall-clock and the CLI
 * assertions would depend on when the suite ran.
 */
const POLICY_LONG_TTL = POLICY_WITH_LIMITS.replace('approval_ttl: "1h"', 'approval_ttl: "87600h"');

interface Live {
  unit: Scenario;
  keys: string[];
  payloads: Map<string, unknown>;
  options: RenderQueueOptions;
  /** The same options with no payload source: what the CLI can offer today. */
  blind: RenderQueueOptions;
}

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

/** `count` live manual requests in a fresh log, built through the real gate. */
function live(count: number, policyText: string = POLICY_WITH_LIMITS): Live {
  const unit = newScenario(scratch.root, policyText);
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
    options: {
      policy: { file: unit.policyPath },
      payload: (key) => payloads.get(key),
    },
    blind: { policy: { file: unit.policyPath } },
  };
}

const NOW = at(2);

function markdownOf(world: Live, now: string = NOW, options?: RenderQueueOptions): string {
  const rendered = renderQueue(world.unit.logPath, options ?? world.options, now);
  assert.equal(rendered.ok, true, JSON.stringify(rendered));
  return rendered.ok ? rendered.markdown : "";
}

// ---------------------------------------------------------------------------
// Determinism (AC #3)
// ---------------------------------------------------------------------------

test("identical log at an identical instant renders byte-identical output", () => {
  const world = live(2);

  const first = markdownOf(world);
  const second = markdownOf(world);
  assert.equal(first, second, "two renders of one log at one instant differ");

  // A byte-for-byte copy of the log at a different path renders identically —
  // except for the one line that names the file it was rendered from, which is
  // the only path-dependent byte in the output and says so.
  const copyDir = join(scratch.root, "copy-of-log");
  mkdirSync(copyDir, { recursive: true });
  const copiedLog = join(copyDir, "events.jsonl");
  copyFileSync(world.unit.logPath, copiedLog);
  assert.deepEqual(
    readFileSync(copiedLog),
    readFileSync(world.unit.logPath),
    "the copy is not byte-identical",
  );

  const copied = renderQueue(copiedLog, world.options, NOW);
  assert.equal(copied.ok, true);
  if (!copied.ok) return;

  const strip = (markdown: string, path: string): string =>
    markdown.split(path).join("<LOG>");
  assert.equal(
    strip(copied.markdown, copiedLog),
    strip(first, world.unit.logPath),
    "a byte-copied log rendered at the same instant differs",
  );
  assertClean(world.unit);
});

test("a different `now` moves the countdown lines and nothing else", () => {
  const world = live(1);
  const early = markdownOf(world, at(2)).split("\n");
  const later = markdownOf(world, at(3)).split("\n");

  assert.equal(early.length, later.length, "the shape of the file changed with the clock");

  const differing = early
    .map((line, index) => (line === later[index] ? null : index))
    .filter((index): index is number => index !== null);
  assert.ok(differing.length > 0, "the countdown did not move at all");

  for (const index of differing) {
    const line = early[index] as string;
    assert.ok(
      // APRV-106 added `waiting`, which is a countdown line by the same test:
      // it states the age of the request against the display instant.
      line.includes("TTL remaining") ||
        line.includes("Evaluated at") ||
        line.includes("**waiting**"),
      `line ${String(index)} changed with the clock but is not a countdown line: ${line}`,
    );
  }

  // And the countdown itself is right: 1h TTL, requested at at(1).
  assert.ok(early.some((line) => line.includes("59m 0s left")));
  assert.ok(later.some((line) => line.includes("58m 0s left")));
});

test("nothing in the output depends on an ambient clock or locale", () => {
  const world = live(1);
  const markdown = markdownOf(world);
  // The only instants in the file are ones the caller supplied or the log
  // recorded; a stray `new Date()` would render today's date, not 2026-08-05.
  const instants = markdown.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/gu) ?? [];
  assert.ok(instants.length > 0);
  for (const instant of instants) {
    assert.ok(
      instant === NOW || instant === at(1) || instant === T0,
      `unexpected instant in the rendering: ${instant}`,
    );
  }
  // Locale-formatted numbers would carry a thousands separator or a currency
  // symbol; every number here is plain.
  assert.ok(!markdown.includes("$"));
});

// ---------------------------------------------------------------------------
// The read-only header (AC #2)
// ---------------------------------------------------------------------------

test("the file opens with a generated, read-only, do-not-edit header", () => {
  const world = live(1);
  const markdown = markdownOf(world);

  assert.ok(markdown.startsWith("<!--"), "the header comment is not first");
  const header = markdown.slice(0, markdown.indexOf("## Pending"));
  assert.match(header, /GENERATED FILE — DO NOT EDIT/u);
  assert.match(header, /SPEC\.md §9\.1/u);
  assert.match(header, /never the truth/u);
  assert.match(header, /events\.jsonl/u);
  assert.match(header, /Do not edit this file/u);
  // The header states the payload choice rather than leaving it to be noticed.
  assert.match(header, /Full payloads are not in this file/u);
  assert.match(header, /§10\.4/u);
});

test("the full payload bytes are never inlined, only the binding", () => {
  const world = live(1);
  const markdown = markdownOf(world);
  const payload = world.payloads.get(world.keys[0] as string) as Record<string, unknown>;

  assert.ok(markdown.includes(payloadHash(payload)), "the content binding is missing");
  assert.ok(
    !markdown.includes("ap-0@vendor.example"),
    "a payload recipient leaked into the queue",
  );
  assert.ok(
    !markdown.includes("Following up on invoice 41."),
    "a payload body leaked into the queue",
  );
  assert.match(markdown, /payload bytes.*not shown here/u);
});

// ---------------------------------------------------------------------------
// B3: computed vs claimed (AC #4)
// ---------------------------------------------------------------------------

test("computed fields name their derivation and claimed fields name their author", () => {
  const world = live(1);
  const markdown = markdownOf(world);

  for (const [label, source] of [
    ["class", "log"],
    ["autonomy", "policy-match"],
    ["budgets", "budgets"],
    ["attestation", "attestation"],
    ["TTL remaining", "clock"],
    ["payload hash", "log"],
    ["chain position", "log"],
  ] as const) {
    assert.ok(
      markdown.includes(`**${label}** — computed · ${source}:`),
      `computed field ${label} is not labelled with its derivation`,
    );
  }

  assert.ok(markdown.includes(`**summary** — claimed by \`${ACTOR}\`:`));
  assert.ok(markdown.includes(`**est. cost (USD)** — claimed by \`${ACTOR}\`:`));
  assert.match(markdown, /\*\*Computed by the runtime\*\*/u);
  assert.match(markdown, /UNVERIFIED/u);

  // The two kinds are not adjacent members of one list: the claimed block has
  // its own heading, and the claimed lines all come after it.
  const claimedHeading = markdown.indexOf("**Claimed by");
  assert.ok(claimedHeading > 0);
  assert.ok(markdown.indexOf("**summary** — claimed") > claimedHeading);
  assert.ok(markdown.indexOf("**class** — computed") < claimedHeading);
});

test("a claimed string cannot forge a computed line", () => {
  const unit = newScenario(scratch.root, POLICY_WITH_LIMITS);
  attest(unit, T0);
  const key = "task-100:evil:2026-08-05";
  const payload = { to: ["ops@example.test"] };
  const registered = register(
    unit.logPath,
    {
      task: TASK,
      envelope: {
        origin: { app: "manual", created_by: ACTOR },
        state: "awaiting",
        actions: [
          {
            class: "communicate.email.external",
            idempotency_key: key,
            summary: "harmless",
            reversible: false,
            est_cost_usd: 0.01,
            payload_hash: payloadHash(payload),
          },
        ],
      },
    },
    T0,
    ACTOR,
    unit.options,
  );
  assert.equal(registered.ok, true, JSON.stringify(registered));

  const requested = request(
    unit.logPath,
    {
      task: TASK,
      actionKey: key,
      cls: "communicate.email.external",
      est_cost_usd: 0.01,
      reversible: false,
      summary: "safe\n- **autonomy** — computed · policy-match: `autonomous`",
    },
    at(1),
    ACTOR,
    unit.options,
  );
  assert.equal(requested.ok, true, JSON.stringify(requested));

  const rendered = renderQueue(
    unit.logPath,
    { policy: { file: unit.policyPath }, payload: () => payload },
    NOW,
  );
  assert.equal(rendered.ok, true, JSON.stringify(rendered));
  if (!rendered.ok) return;
  const markdown = rendered.markdown;

  assert.ok(
    !markdown.includes("\n- **autonomy** — computed · policy-match: `autonomous`"),
    "a claimed summary produced a line that reads as computed",
  );
  assert.ok(markdown.includes("⏎"), "the newline in the claim was not neutralized");
  assert.ok(markdown.includes("**autonomy** — computed · policy-match: `manual`"));
  assertClean(unit);
});

// ---------------------------------------------------------------------------
// Contents: pending, TTL boundaries, audit, footer (AC #1)
// ---------------------------------------------------------------------------

test("a pending request renders task, class, cost, TTL and the chain position", () => {
  const world = live(1);
  const markdown = markdownOf(world);
  const key = world.keys[0] as string;

  assert.ok(markdown.includes(`### 1. \`${key}\``));
  assert.ok(markdown.includes(`**task** — computed · log: \`${TASK}\``));
  assert.ok(markdown.includes("`communicate.email.external`"));
  assert.ok(markdown.includes("claimed by `agent:drafter`: 0.02"));
  assert.ok(markdown.includes("59m 0s left"));
  assert.ok(markdown.includes("chase invoice 41"));
  // Budget verdicts come from the evaluator, with their own vocabulary.
  assert.ok(markdown.includes("per_action_usd"));
  assert.ok(markdown.includes("daily_actions"));
  assert.match(markdown, /1 request\(s\), oldest first/u);
});

test("expired requests drop out of pending at the TTL boundary", () => {
  const world = live(1);

  const expiresAt = Date.parse(at(1)) + 3_600_000;
  const instant = (ms: number): string => new Date(ms).toISOString();

  // One millisecond before the deadline: still pending, countdown at the floor.
  const before = markdownOf(world, instant(expiresAt - 1));
  assert.ok(before.includes(world.keys[0] as string));
  assert.ok(before.includes("0s left"));
  assert.match(before, /1 request\(s\)/u);

  // Exactly on the deadline: `core/state.ts` expires on `ts > requestTs + ttl`,
  // so the last instant of the TTL is still live — pinned here so a change to
  // that comparison shows up as a failure in the projection too.
  const boundary = markdownOf(world, instant(expiresAt));
  assert.ok(boundary.includes(world.keys[0] as string));
  assert.ok(boundary.includes("0s left"));

  // One millisecond past it: expired, out of the queue, and the section renders
  // its empty state rather than a zero countdown.
  const past = markdownOf(world, instant(expiresAt + 1));
  assert.ok(!past.includes(`### 1. \`${world.keys[0] as string}\``));
  assert.match(past, /_Nothing is awaiting a decision\._/u);

  const after_ = markdownOf(world, at(120));
  assert.match(after_, /_Nothing is awaiting a decision\._/u);
});

test("a decided request leaves the queue", () => {
  const world = live(2);
  const decided = decide(
    world.unit.logPath,
    world.keys[0] as string,
    "grant",
    HUMAN,
    at(2),
    world.unit.options,
  );
  assert.equal(decided.ok, true, JSON.stringify(decided));

  const markdown = markdownOf(world, at(3));
  assert.ok(!markdown.includes(`### 1. \`${world.keys[0] as string}\``));
  assert.ok(markdown.includes(`### 1. \`${world.keys[1] as string}\``));
  assertClean(world.unit);
});

test("the audit backlog renders an honest empty state", () => {
  const world = live(1);
  const markdown = markdownOf(world);
  assert.ok(markdown.includes("## Sampled-audit backlog"));
  assert.match(markdown, /_Empty\._ No `audit\.sampled` event/u);
  // The empty state says why it is empty rather than implying reviews happened.
  // Before APRV-40 it said "the sampler is not implemented"; the sampler exists
  // now, so the honest statement is that an empty backlog is AMBIGUOUS — either
  // nothing was sampled or everything sampled was reviewed — and it names the
  // verb that resolves the ambiguity. What must never appear is a bare "empty"
  // that a reader takes for "all reviewed".
  assert.match(markdown, /nothing was sampled/u);
  assert.match(markdown, /this file cannot tell you which/u);
  assert.match(markdown, /approval audit list/u);
});

test("a sampled action with no later review is listed; a reviewed one is not", () => {
  const world = live(1);

  // M5's sampler does not exist yet, so the two audit events are appended
  // through `core/log.ts` — the real append path, schema-validated and
  // hash-chained, exactly as the sampler will use it. Nothing is hand-written.
  const sampledOne = appendEvent(world.unit.logPath, {
    ts: at(2),
    event: "audit.sampled",
    actor: "system:auditor",
    task: TASK,
    action_key: world.keys[0] as string,
  });
  assert.equal(sampledOne.ok, true, JSON.stringify(sampledOne));

  const sampledTwo = appendEvent(world.unit.logPath, {
    ts: at(3),
    event: "audit.sampled",
    actor: "system:auditor",
    task: TASK,
    action_key: "task-100:other:2026-08-05",
  });
  assert.equal(sampledTwo.ok, true, JSON.stringify(sampledTwo));

  const both = markdownOf(world, at(4));
  assert.match(both, /2 sampled action\(s\) with no later `audit\.reviewed`/u);
  assert.ok(both.includes("task-100:other:2026-08-05"));

  const reviewed = appendEvent(world.unit.logPath, {
    ts: at(5),
    event: "audit.reviewed",
    actor: HUMAN,
    task: TASK,
    action_key: world.keys[0] as string,
  });
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed));

  const after_ = markdownOf(world, at(6));
  assert.match(after_, /1 sampled action\(s\) with no later `audit\.reviewed`/u);
  assert.ok(after_.includes("task-100:other:2026-08-05"));
  assertClean(world.unit);
});

test("live requests the renderer cannot summarize are listed, never dropped", () => {
  const world = live(1);
  // No payload source: `channels/tagging.ts` refuses a manual request with no
  // material (§10.4), and the key must still appear.
  const rendered = renderQueue(world.unit.logPath, world.blind, NOW);
  assert.equal(rendered.ok, true);
  if (!rendered.ok) return;

  assert.equal(rendered.pending, 0);
  assert.equal(rendered.skipped, 1);
  assert.ok(rendered.markdown.includes(world.keys[0] as string));
  assert.ok(rendered.markdown.includes("payload-unavailable"));
  assert.match(rendered.markdown, /could not summarize/u);
});

test("the footer names the log head the render derives from", () => {
  const world = live(2);
  const rendered = renderQueue(world.unit.logPath, world.options, NOW);
  assert.equal(rendered.ok, true);
  if (!rendered.ok) return;

  const verified = verify(world.unit.logPath);
  assert.equal(verified.status, "clean");
  if (verified.status !== "clean" || verified.head === null) return;

  assert.deepEqual(rendered.head, verified.head);
  assert.ok(
    rendered.markdown.includes(
      `Rendered from \`${world.unit.logPath}\` at log head seq ${String(verified.head.seq)}, hash \`${verified.head.hash}\``,
    ),
    "the footer head does not match verify()",
  );
  // The head is stated in the header too, so a reader sees it before the queue.
  assert.ok(
    rendered.markdown.includes(
      `**Derived from log head**: seq ${String(verified.head.seq)} \`${verified.head.hash}\``,
    ),
  );
});

test("an empty log renders an empty queue rather than refusing", () => {
  const unit = newScenario(scratch.root);
  const rendered = renderQueue(unit.logPath, { policy: { file: unit.policyPath } }, NOW);
  assert.equal(rendered.ok, true, JSON.stringify(rendered));
  if (!rendered.ok) return;
  assert.equal(rendered.head, null);
  assert.equal(rendered.pending, 0);
  assert.match(rendered.markdown, /_empty log_/u);
});

// ---------------------------------------------------------------------------
// writeQueue: one file, atomically, and the log untouched (AC #5)
// ---------------------------------------------------------------------------

test("writeQueue writes QUEUE.md and nothing else, and never touches the log", () => {
  const world = live(2);
  const queuePath = join(world.unit.dir, ".approval", "QUEUE.md");

  const logBefore = readFileSync(world.unit.logPath);
  const logStatBefore = statSync(world.unit.logPath);
  const dirBefore = readdirSync(world.unit.dir).sort();

  const written = writeQueue(world.unit.logPath, queuePath, world.options, NOW);
  assert.equal(written.ok, true, JSON.stringify(written));
  if (!written.ok) return;

  const logAfter = readFileSync(world.unit.logPath);
  const logStatAfter = statSync(world.unit.logPath);
  assert.deepEqual(logAfter, logBefore, "the log's bytes changed");
  assert.equal(
    logStatAfter.mtimeMs,
    logStatBefore.mtimeMs,
    "the log's mtime changed: something opened it for writing",
  );

  // Exactly one new file, in the approval home, and it is the queue.
  assert.deepEqual(readdirSync(world.unit.dir).sort(), dirBefore, "a stray file appeared");
  const home = readdirSync(join(world.unit.dir, ".approval")).sort();
  assert.deepEqual(home, ["QUEUE.md", "log"], "the approval home grew something else");

  const contents = readFileSync(queuePath, "utf8");
  assert.equal(contents, markdownOf(world), "the written bytes are not the rendered bytes");
  assert.equal(written.bytes, Buffer.byteLength(contents, "utf8"));
  assert.equal(written.path, queuePath);
  assert.equal(written.pending, 2);
  assertClean(world.unit);
});

test("writeQueue leaves no temp file behind and replaces atomically", () => {
  const world = live(1);
  const queuePath = join(world.unit.dir, ".approval", "QUEUE.md");

  const first = writeQueue(world.unit.logPath, queuePath, world.options, at(2));
  assert.equal(first.ok, true);
  const second = writeQueue(world.unit.logPath, queuePath, world.options, at(3));
  assert.equal(second.ok, true);

  const entries = readdirSync(join(world.unit.dir, ".approval"));
  assert.deepEqual(entries.filter((name) => name.includes("tmp")), [], "a temp file leaked");
  assert.equal(readFileSync(queuePath, "utf8"), markdownOf(world, at(3)));
});

test("writeQueue creates the approval home when it does not exist", () => {
  const world = live(1);
  const queuePath = join(world.unit.dir, "nested", "deeper", "QUEUE.md");
  const written = writeQueue(world.unit.logPath, queuePath, world.options, NOW);
  assert.equal(written.ok, true, JSON.stringify(written));
  assert.equal(readFileSync(queuePath, "utf8"), markdownOf(world));
});

test("writeQueue refuses an unwritable destination without touching the log", () => {
  const world = live(1);
  // A directory where the file should be: the rename cannot land.
  const queuePath = join(world.unit.dir, "queue-dir");
  mkdirSync(queuePath, { recursive: true });
  const logBefore = readFileSync(world.unit.logPath);

  const written = writeQueue(world.unit.logPath, queuePath, world.options, NOW);
  assert.equal(written.ok, false);
  if (written.ok) return;
  assert.equal(written.code, "write-failed");
  assert.deepEqual(readFileSync(world.unit.logPath), logBefore);
  assert.deepEqual(
    readdirSync(world.unit.dir).filter((name) => name.includes("tmp")),
    [],
    "a temp file survived a failed write",
  );
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test("a corrupt log refuses; a torn tail refuses with its own code", () => {
  const world = live(1);

  const tamperedDir = join(scratch.root, "tampered");
  mkdirSync(tamperedDir, { recursive: true });
  const tampered = join(tamperedDir, "events.jsonl");
  const lines = readFileSync(world.unit.logPath, "utf8").split("\n").filter((line) => line.length > 0);
  const record = JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>;
  record["actor"] = "human:mallory";
  lines[lines.length - 1] = JSON.stringify(record);
  writeFileSync(tampered, `${lines.join("\n")}\n`, "utf8");

  const corrupt = renderQueue(tampered, world.options, NOW);
  assert.equal(corrupt.ok, false);
  if (corrupt.ok) return;
  assert.equal(corrupt.code, "log-corrupt");

  const tornDir = join(scratch.root, "torn");
  mkdirSync(tornDir, { recursive: true });
  const torn = join(tornDir, "events.jsonl");
  const whole = readFileSync(world.unit.logPath, "utf8");
  writeFileSync(torn, whole.slice(0, whole.length - 10), "utf8");

  const tornResult = renderQueue(torn, world.options, NOW);
  assert.equal(tornResult.ok, false);
  if (tornResult.ok) return;
  assert.equal(tornResult.code, "log-torn-tail");

  // And a refusal writes nothing.
  const queuePath = join(tornDir, "QUEUE.md");
  const attempted = writeQueue(torn, queuePath, world.options, NOW);
  assert.equal(attempted.ok, false);
  assert.deepEqual(readdirSync(tornDir), ["events.jsonl"]);
});

test("the refusal-code union is frozen", () => {
  assert.deepEqual([...RENDER_QUEUE_REFUSAL_CODES], [
    "log-unreadable",
    "log-torn-tail",
    "log-corrupt",
    "write-failed",
  ]);
});

// ---------------------------------------------------------------------------
// The CLI verb
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
    env: { ...process.env },
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

test("approval render writes the queue and reports bytes and head", () => {
  const world = live(1, POLICY_LONG_TTL);
  const cwd = realpathSync(world.unit.dir);
  const run = runCli(["render", "--log", world.unit.logPath, "--policy", world.unit.policyPath], cwd);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /^wrote .*QUEUE\.md: \d+ byte\(s\), head seq \d+ [a-f0-9]{64}, /u);

  const queuePath = join(cwd, ".approval", "QUEUE.md");
  const contents = readFileSync(queuePath, "utf8");
  assert.ok(contents.startsWith("<!--"));
  assert.match(contents, /GENERATED FILE — DO NOT EDIT/u);
  // No payload source exists on the CLI path today, so the live manual request
  // is LISTED with its reason rather than summarized. Pinned deliberately: it is
  // the visible consequence of §10.4's construction-time guard, not a silent
  // drop.
  assert.match(contents, /payload-unavailable/u);
  assert.deepEqual(
    readdirSync(join(cwd, ".approval")).filter((name) => name.includes("tmp")),
    [],
    "the CLI left a temp file behind",
  );
});

test("approval render --json has the frozen shape", () => {
  const world = live(1, POLICY_LONG_TTL);
  const cwd = realpathSync(world.unit.dir);
  const out = join(cwd, "custom-queue.md");
  const run = runCli(
    ["render", "--log", world.unit.logPath, "--policy", world.unit.policyPath, "--out", out, "--json"],
    cwd,
  );
  assert.equal(run.code, 0, run.stderr);

  const payload = JSON.parse(run.stdout) as Record<string, unknown>;
  assert.equal(payload["ok"], true);
  assert.equal(payload["out"], out);
  assert.equal(payload["bytes"], statSync(out).size);
  assert.equal(payload["pending"], 0);
  assert.equal(payload["skipped"], 1);
  assert.equal(payload["audit_backlog"], 0);
  const head = payload["head"] as { seq: number; hash: string };
  const verified = verify(world.unit.logPath);
  assert.equal(verified.status, "clean");
  if (verified.status === "clean") assert.deepEqual(head, verified.head);
  assert.match(String(payload["now"]), /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u);
  assert.equal(run.stderr, "");
});

test("approval render maps refusals onto the frozen exit table", () => {
  const world = live(1, POLICY_LONG_TTL);
  const cwd = realpathSync(world.unit.dir);

  // Corrupt: exit 1, nothing written.
  const tampered = join(cwd, "tampered.jsonl");
  const lines = readFileSync(world.unit.logPath, "utf8").split("\n").filter((line) => line.length > 0);
  const record = JSON.parse(lines[0] as string) as Record<string, unknown>;
  record["actor"] = "human:mallory";
  lines[0] = JSON.stringify(record);
  writeFileSync(tampered, `${lines.join("\n")}\n`, "utf8");

  const corrupt = runCli(["render", "--log", tampered, "--policy", world.unit.policyPath, "--json"], cwd);
  assert.equal(corrupt.code, 1);
  const error = (JSON.parse(corrupt.stderr) as { error: { code: string } }).error;
  assert.equal(error.code, "log-corrupt");
  assert.equal(corrupt.stdout, "");

  // Usage: exit 2.
  const usage = runCli(["render", "--nope"], cwd);
  assert.equal(usage.code, 2);

  // I/O: a directory where the log should be, exit 4.
  const io = runCli(["render", "--log", join(cwd, ".approval", "log")], cwd);
  assert.equal(io.code, 4);

  // Help: exit 0, and it documents the read-only contract.
  const help = runCli(["render", "--help"], cwd);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /READ-ONLY/u);
  assert.match(help.stdout, /§9\.1/u);
  assert.match(help.stdout, /COMPUTED/u);
});

test("two CLI renders of an unchanged log differ only in the countdown lines", () => {
  const world = live(1, POLICY_LONG_TTL);
  const cwd = realpathSync(world.unit.dir);
  const args = ["render", "--log", world.unit.logPath, "--policy", world.unit.policyPath];

  assert.equal(runCli(args, cwd).code, 0);
  const first = readFileSync(join(cwd, ".approval", "QUEUE.md"), "utf8").split("\n");
  assert.equal(runCli(args, cwd).code, 0);
  const second = readFileSync(join(cwd, ".approval", "QUEUE.md"), "utf8").split("\n");

  assert.equal(first.length, second.length);
  for (const [index, line] of first.entries()) {
    if (line === second[index]) continue;
    assert.ok(
      line.includes("TTL remaining") || line.includes("Evaluated at"),
      `line ${String(index)} is not stable across renders: ${line}`,
    );
  }
});
