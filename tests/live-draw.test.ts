/**
 * The daemon-answered live draw (APRV-208).
 *
 * `supervised-live` (APRV-127) has never once been live from an agent process.
 * The draw reads the operator's sampling secret out of the deciding process's
 * own environment, the deciding process is a child of an agent session, and the
 * secret must never be there — so the draw failed closed on every action.
 * APRV-184 measured it on this repository's own log: 15 of 15 supervised-live
 * actions gated to a human after the amendment that turned sampling on. Safe,
 * and a control that has never run.
 *
 * Five claims are under test, each as a property rather than an example:
 *
 * 1. **The draw happens, from a process with no secret.** Over 200 fixture
 *    actions asked through the real gate against a real daemon on a real
 *    socket, the selected fraction lands inside a binomial band around the
 *    declared `live_rate`, while the deciding process's environment holds no
 *    secret at all.
 * 2. **Every failure gates, distinctly.** No socket, a socket nothing serves,
 *    and an answer that cannot be matched to the question each gate the action
 *    and each record their own machine-readable reason.
 * 3. **The answer is evidence, not a claim.** The MAC recorded on the request
 *    recomputes from the record's own fields under the operator's secret, and
 *    every tampering of it — a flipped verdict, a moved rate, other bytes,
 *    another key — is rejected.
 * 4. **The socket is not a private oracle.** The daemon refuses to draw for
 *    bytes no `task.registered` in the verified log declares, so grinding
 *    candidate payloads costs a permanent log record per attempt.
 * 5. **The secret stays where it was.** It never reaches an asking process, and
 *    it never reaches the log.
 *
 * The secret lives in a TEST-SCOPED variable name passed as an explicit
 * environment object, never exported into this process.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  DRAW_PROTOCOL_VERSION,
  askDaemonDraw,
  canonicalQuestion,
  drawDirFor,
  drawMac,
  drawSocketPathFor,
  parseDrawAnswer,
  verifyDrawAnswer,
  verifyLiveDrawRecord,
  type DrawAnswer,
  type DrawOutcome,
  type DrawQuestion,
  type LiveDrawRecord,
} from "../src/core/live-draw.js";
import { DrawServer, drawServerFor } from "../src/daemon/draw.js";
import type { EventRecord } from "../src/core/log.js";
import { isSampled } from "../src/core/sampler.js";
import { verify } from "../src/core/verify.js";
import { appendAttestation, register, request } from "./clock-adapters.js";

// A short scratch root: a Unix socket address is 104 bytes on macOS, and the
// paths under it are the real ones this runtime derives.
const scratch = mkdtempSync(join(tmpdir(), "amd-"));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const T0 = "2026-09-02T10:00:00.000Z";

function at(minutes: number): string {
  return new Date(Date.parse(T0) + minutes * 60_000).toISOString();
}

const SECRET_ENV = "APPROVAL_TEST_DRAW_SECRET";
const SECRET = "operator-held-secret-never-in-the-log";
const LIVE_CLASS = "files.write.local";
const RATE = 0.25;

/** The environment a HOOK has: no secret, by design and by assertion. */
const SECRETLESS: NodeJS.ProcessEnv = { PATH: process.env["PATH"] ?? "" };

function bindingFor(key: string): string {
  return createHash("sha256").update(`payload:${key}`, "utf8").digest("hex");
}

/** The first key in a family whose bytes this secret selects at the class rate. */
function selectedKey(stem: string): string {
  for (let index = 0; index < 1000; index += 1) {
    const key = `${stem}-${String(index)}`;
    if (isSampled(SECRET, bindingFor(key), RATE)) return key;
  }
  throw new Error("no payload in the family draws selected");
}

interface Case {
  dir: string;
  logPath: string;
  policyPath: string;
}

function policyText(rate: number): string {
  return [
    "# Policy",
    "",
    "```yaml approval-policy",
    'version: "0.1"',
    "defaults:",
    "  autonomy: manual",
    '  approval_ttl: "1h"',
    "  on_expiry: reject",
    "budgets:",
    "  global:",
    "    daily_usd: 1000",
    "    daily_actions: 5000",
    "audit:",
    "  supervised_sample_rate: 1",
    `  sampling_secret_env: ${SECRET_ENV}`,
    "classes:",
    "  files.write.*:",
    "    autonomy: supervised-live",
    `    live_rate: ${String(rate)}`,
    "```",
    "",
  ].join("\n");
}

/** An attested policy, a registered task, and the actions it declares. */
function ready(keys: string[], rate = RATE): Case {
  counter += 1;
  const dir = join(scratch, `c${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  const policyPath = join(dir, "APPROVAL.md");
  writeFileSync(policyPath, policyText(rate), "utf8");
  const unit: Case = { dir, logPath: join(dir, ".approval", "log", "events.jsonl"), policyPath };

  assert.equal(appendAttestation(unit.logPath, policyPath, "human:carter", T0).ok, true);
  const registered = register(
    unit.logPath,
    {
      task: "task-208",
      envelope: {
        origin: { app: "example-capture", created_by: "human:carter" },
        state: "proposed",
        actions: keys.map((key) => ({
          class: LIVE_CLASS,
          summary: `do ${key}`,
          est_cost_usd: "0.01",
          idempotency_key: key,
          payload_hash: bindingFor(key),
        })),
      },
    },
    T0,
    "agent:claude",
  );
  assert.equal(registered.ok, true, registered.ok ? "" : registered.message);
  return unit;
}

function records(unit: Case): EventRecord[] {
  let raw: string;
  try {
    raw = readFileSync(unit.logPath, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as EventRecord);
}

function requestedFor(unit: Case, actionKey: string): EventRecord | null {
  let found: EventRecord | null = null;
  for (const record of records(unit)) {
    if (record.event === "approval.requested" && record.action_key === actionKey) found = record;
  }
  return found;
}

function drawOf(record: EventRecord): LiveDrawRecord | undefined {
  const payload = record.payload as Record<string, unknown>;
  return payload["live_draw"] as LiveDrawRecord | undefined;
}

function assertClean(unit: Case): void {
  const result = verify(unit.logPath);
  assert.equal(result.status, "clean", `log not clean: ${JSON.stringify(result)}`);
}

/** The attested policy hash for a unit, read out of its own log. */
function policyHashOf(unit: Case): string {
  for (const record of records(unit)) {
    if (record.event !== "policy.updated") continue;
    const sha = (record.payload as Record<string, unknown>)["sha256"];
    if (typeof sha === "string") return sha;
  }
  throw new Error("no attestation in the log");
}

/** Start a real server for a unit, and stop it when the test is done. */
function serve(unit: Case, secret = SECRET): DrawServer {
  const server = new DrawServer({
    logPath: unit.logPath,
    policy: { file: unit.policyPath },
    secret,
  });
  const started = server.start();
  assert.equal(started.ok, true, started.ok ? "" : `${started.reason}: ${started.detail}`);
  return server;
}

/** One question over the real socket, the way the relay child asks it. */
async function ask(unit: Case, question: DrawQuestion): Promise<unknown> {
  return await new Promise((settle, fail) => {
    let buffer = "";
    const socket = connect(drawSocketPathFor(unit.logPath));
    socket.setEncoding("utf8");
    socket.setTimeout(4_000, () => {
      socket.destroy();
      fail(new Error("the server did not answer"));
    });
    socket.on("connect", () => socket.write(`${JSON.stringify(question)}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.destroy();
      settle(JSON.parse(buffer.slice(0, newline)) as unknown);
    });
    socket.on("error", fail);
  });
}

function questionFor(unit: Case, key: string, rate = RATE): DrawQuestion {
  return {
    v: DRAW_PROTOCOL_VERSION,
    action_key: key,
    payload_hash: bindingFor(key),
    policy_hash: policyHashOf(unit),
    live_rate: rate,
  };
}

// ===========================================================================
// 1. The protocol, as pure functions
// ===========================================================================

test("the MAC binds the whole question and the verdict, and nothing else does", () => {
  const base: DrawQuestion = {
    v: 1,
    action_key: "task-208:draft",
    payload_hash: bindingFor("a"),
    policy_hash: bindingFor("policy"),
    live_rate: 0.25,
  };
  const mac = drawMac(SECRET, base, true);

  assert.equal(verifyDrawAnswer(SECRET, base, true, mac), true);
  // The verdict is inside the MAC, so a flipped answer is a forged answer.
  assert.equal(verifyDrawAnswer(SECRET, base, false, mac), false);
  // So is every field of the question.
  for (const mutation of [
    { ...base, action_key: "task-208:other" },
    { ...base, payload_hash: bindingFor("b") },
    { ...base, policy_hash: bindingFor("another-policy") },
    { ...base, live_rate: 0.5 },
    { ...base, v: 2 },
  ]) {
    assert.equal(verifyDrawAnswer(SECRET, mutation, true, mac), false);
  }
  // And the key.
  assert.equal(verifyDrawAnswer("a-different-operator-secret", base, true, mac), false);
  // A malformed MAC is an answer, not a crash.
  assert.equal(verifyDrawAnswer(SECRET, base, true, "not-a-mac"), false);

  // Canonical, so two spellings of one question are one question.
  const reordered: DrawQuestion = {
    live_rate: base.live_rate,
    v: base.v,
    policy_hash: base.policy_hash,
    payload_hash: base.payload_hash,
    action_key: base.action_key,
  };
  assert.equal(canonicalQuestion(reordered), canonicalQuestion(base));
  assert.equal(drawMac(SECRET, reordered, true), mac);
});

test("an asker with no secret still refuses every answer it cannot match to its question", () => {
  const asked: DrawQuestion = {
    v: 1,
    action_key: "task-208:draft",
    payload_hash: bindingFor("a"),
    policy_hash: bindingFor("policy"),
    live_rate: 0.25,
  };
  const good: DrawAnswer = {
    v: 1,
    question: asked,
    selected: false,
    mac: drawMac(SECRET, asked, false),
    daemon_pid: process.pid,
    answered_at: T0,
  };
  assert.equal(parseDrawAnswer(JSON.stringify(good), asked).ok, true);

  const rejected: Array<[string, unknown]> = [
    ["not JSON at all", undefined],
    ["another protocol version", { ...good, v: 2 }],
    ["no echoed question", { ...good, question: undefined }],
    ["a different rate", { ...good, question: { ...asked, live_rate: 0.9 } }],
    ["a different payload", { ...good, question: { ...asked, payload_hash: bindingFor("b") } }],
    ["a different policy", { ...good, question: { ...asked, policy_hash: bindingFor("p2") } }],
    ["no verdict", { ...good, selected: "yes" }],
    ["no MAC", { ...good, mac: "short" }],
    ["no pid", { ...good, daemon_pid: 0 }],
  ];
  for (const [why, body] of rejected) {
    const text = body === undefined ? "{not json" : JSON.stringify(body);
    const outcome = parseDrawAnswer(text, asked);
    assert.equal(outcome.ok, false, `an answer with ${why} was accepted`);
    if (outcome.ok) continue;
    assert.equal(outcome.reason, "draw-answer-invalid");
  }
});

// ===========================================================================
// 2. The server: what it refuses to take on the asker's word
// ===========================================================================

test("the socket is owner-only and its directory is not reachable by anyone else", () => {
  const unit = ready(["task-208:a"]);
  const server = serve(unit);
  try {
    const socket = statSync(drawSocketPathFor(unit.logPath));
    assert.equal(socket.isSocket(), true);
    assert.equal(socket.mode & 0o777, 0o600, "the socket is reachable past its owner");
    assert.equal(statSync(drawDirFor(unit.logPath)).mode & 0o777, 0o700);
    assert.equal(socket.uid, process.geteuid?.() ?? -1);
  } finally {
    server.close();
  }
});

test("a draw is answered, and the answer verifies under the operator's secret", async () => {
  const unit = ready(["task-208:a"]);
  const server = serve(unit);
  try {
    const question = questionFor(unit, "task-208:a");
    const body = (await ask(unit, question)) as Record<string, unknown>;
    const outcome = parseDrawAnswer(JSON.stringify(body), question);
    assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.detail);
    if (!outcome.ok) return;
    // The daemon's own draw, and the same one `core/sampler.ts` makes: one
    // selection mechanism in this runtime, not two.
    assert.equal(outcome.answer.selected, isSampled(SECRET, question.payload_hash, RATE));
    assert.equal(
      verifyDrawAnswer(SECRET, question, outcome.answer.selected, outcome.answer.mac),
      true,
    );
    assert.equal(outcome.answer.daemon_pid, process.pid);
    // Never the secret, in any part of the wire format.
    assert.ok(!JSON.stringify(body).includes(SECRET));
  } finally {
    server.close();
  }
});

test("the socket is not a private oracle: unregistered bytes are refused", async () => {
  const unit = ready(["task-208:a"]);
  const server = serve(unit);
  try {
    // The grinding attack: ask about a thousand candidate payloads, keep one
    // that draws unsampled. Every candidate must first be registered in the
    // append-only log, where the attempt is permanent and countable.
    const ground = (await ask(unit, {
      ...questionFor(unit, "task-208:a"),
      payload_hash: bindingFor("a-payload-nobody-declared"),
    })) as Record<string, unknown>;
    assert.equal(ground["ok"], false);
    assert.match(String(ground["detail"]), /no task\.registered/u);

    // The same bytes under a key that IS registered are still refused: the pair
    // must match on both halves.
    const swapped = (await ask(unit, {
      ...questionFor(unit, "task-208:a"),
      payload_hash: bindingFor("task-208:unknown"),
    })) as Record<string, unknown>;
    assert.equal(swapped["ok"], false);
  } finally {
    server.close();
  }
});

test("the daemon derives the rate itself, so an inflated question is refused by the asker", async () => {
  const unit = ready(["task-208:a"]);
  const server = serve(unit);
  try {
    // An asker (or something pretending to be one) proposing a rate of its own.
    const asked = { ...questionFor(unit, "task-208:a"), live_rate: 0.99 };
    const body = (await ask(unit, asked)) as Record<string, unknown>;
    // The daemon answers, but it answers ITS question, at the rate its policy
    // declares — and the asker refuses an answer to a question it did not ask.
    const echoed = (body["question"] as Record<string, unknown>)["live_rate"];
    assert.equal(echoed, RATE, "the daemon took the caller's rate");
    const outcome = parseDrawAnswer(JSON.stringify(body), asked);
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.reason, "draw-answer-invalid");
  } finally {
    server.close();
  }
});

test("a malformed question is refused without an answer being made", async () => {
  const unit = ready(["task-208:a"]);
  const server = serve(unit);
  try {
    for (const bad of [
      { v: 2, action_key: "x", payload_hash: bindingFor("a"), policy_hash: bindingFor("p"), live_rate: 0.1 },
      { v: 1, action_key: "", payload_hash: bindingFor("a"), policy_hash: bindingFor("p"), live_rate: 0.1 },
      { v: 1, action_key: "x", payload_hash: "short", policy_hash: bindingFor("p"), live_rate: 0.1 },
      { v: 1, action_key: "x", payload_hash: bindingFor("a"), policy_hash: bindingFor("p"), live_rate: 0 },
      { v: 1, action_key: "x", payload_hash: bindingFor("a"), policy_hash: bindingFor("p"), live_rate: 7 },
    ]) {
      const body = (await ask(unit, bad as unknown as DrawQuestion)) as Record<string, unknown>;
      assert.equal(body["ok"], false, `a malformed question was answered: ${JSON.stringify(bad)}`);
      assert.equal(body["mac"], undefined, "a refusal carried a MAC");
    }
  } finally {
    server.close();
  }
});

test("drawServerFor reads the secret from the environment it is handed, and refuses without one", () => {
  const unit = ready(["task-208:a"]);
  const without = drawServerFor({
    logPath: unit.logPath,
    policy: { file: unit.policyPath },
    env: SECRETLESS,
  });
  assert.equal(without.ok, false);
  if (!without.ok) {
    assert.equal(without.reason, "secret-unset");
    assert.ok(!without.message.includes(SECRET));
  }

  const with_ = drawServerFor({
    logPath: unit.logPath,
    policy: { file: unit.policyPath },
    env: { [SECRET_ENV]: SECRET },
  });
  assert.equal(with_.ok, true);
  if (with_.ok) with_.server.close();
});

// ===========================================================================
// 3. The gate, drawing from a process that holds no secret (AC 1, AC 3, AC 4)
// ===========================================================================

/**
 * Replay a real daemon's answers through the synchronous gate.
 *
 * The gate's request path is synchronous, and the production asker pays a
 * `spawnSync` for exactly that reason. Two hundred of those on a shared machine
 * is a minute of Node starts to prove a statistic, so the questions here are put
 * to the REAL server over the REAL socket in the REAL wire format (above,
 * asynchronously), and the answers are handed back to `request` through the
 * `drawAsk` seam. Everything the gate does with an answer — the version check,
 * the question echo, the MAC recording, the fail-closed branches — is the
 * production path. The spawning relay itself has its own end-to-end test below.
 */
function replayAsker(answers: Map<string, unknown>): (
  logPath: string,
  question: DrawQuestion,
) => DrawOutcome {
  return (_logPath, question) => {
    const body = answers.get(question.payload_hash);
    if (body === undefined) {
      return { ok: false, reason: "draw-daemon-absent", detail: "no recorded answer" };
    }
    return parseDrawAnswer(JSON.stringify(body), question);
  };
}

test("200 fixture actions drawn by the daemon land in a binomial band, from a process with no secret", async () => {
  const keys = Array.from({ length: 200 }, (_, index) => `task-208:a${String(index)}`);
  const unit = ready(keys);
  const server = serve(unit);
  const answers = new Map<string, unknown>();
  try {
    for (const key of keys) {
      answers.set(bindingFor(key), await ask(unit, questionFor(unit, key)));
    }
  } finally {
    server.close();
  }

  // The asking process's environment. Asserted, not assumed: AC4's claim is
  // that no gate process launched from a session reads the secret, and this is
  // the environment `request` is given.
  assert.equal(SECRET_ENV in SECRETLESS, false, "the deciding process was handed the secret");
  assert.ok(!Object.values(SECRETLESS).some((value) => value === SECRET));

  const options = {
    policy: { file: unit.policyPath },
    env: SECRETLESS,
    drawAsk: replayAsker(answers),
  };

  let gated = 0;
  keys.forEach((key, index) => {
    const result = request(
      unit.logPath,
      {
        task: "task-208",
        actionKey: key,
        cls: LIVE_CLASS,
        est_cost_usd: "0.01",
      },
      at(index + 1),
      "agent:claude",
      options,
    );
    assert.equal(result.ok, true, result.ok ? "" : result.message);
    if (!result.ok) return;
    if (result.proceed) {
      // An unsampled action appends nothing at all (SPEC.md §6.3), which is
      // exactly what it did before this task existed.
      assert.equal(result.record, null);
      assert.equal(result.live?.reason, "not-selected");
      return;
    }
    gated += 1;
    assert.equal(result.live?.reason, "selected");
  });

  // The band. Binomial at n = 200, p = 0.25: mean 50, sd about 6.1, so five
  // standard deviations is 20 to 80. Wide on purpose — the point is that the
  // draw HAPPENED and is not stuck at 0 (the fail-closed state APRV-184 found)
  // or at 200 (a gate that ignores the rate). The exact count is deterministic
  // for this secret and these bytes, so this can never flake.
  assert.ok(gated > 20 && gated < 80, `${String(gated)} of 200 gated, outside the band`);
  assert.ok(gated > 0 && gated < 200, "the draw did not distinguish anything");

  // And it is the operator's own draw, action for action.
  const expected = keys.filter((key) => isSampled(SECRET, bindingFor(key), RATE)).length;
  assert.equal(gated, expected, "the gate's verdicts are not the secret's verdicts");

  // The secret reached neither the log nor any record.
  assert.ok(!readFileSync(unit.logPath, "utf8").includes(SECRET));
  assertClean(unit);
});

test("a delegated verdict is recorded with the MAC an operator recomputes, and tampering is caught", async () => {
  // A key this secret certainly selects at the class rate, found rather than
  // asserted: the draw is a pure function of the bytes, so "which one" is
  // arithmetic and the test must not depend on a guess.
  const key = selectedKey("task-208:evidence");
  const unit = ready([key]);
  const server = serve(unit);
  let body: unknown;
  try {
    body = await ask(unit, questionFor(unit, key));
  } finally {
    server.close();
  }
  // A rate that certainly selects, so there is a request to carry the evidence.
  const selected = isSampled(SECRET, bindingFor(key), RATE);
  assert.equal(selected, true, "fixture: this payload must draw selected at the class rate");

  const result = request(
    unit.logPath,
    { task: "task-208", actionKey: key, cls: LIVE_CLASS, est_cost_usd: "0.01" },
    at(1),
    "agent:claude",
    {
      policy: { file: unit.policyPath },
      env: SECRETLESS,
      drawAsk: replayAsker(new Map([[bindingFor(key), body]])),
    },
  );
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok) return;
  assert.equal(result.proceed, false);

  const record = requestedFor(unit, key);
  assert.ok(record !== null);
  if (record === null) return;
  const draw = drawOf(record);
  assert.ok(draw !== undefined, "the delegation was not recorded");
  if (draw === undefined) return;
  assert.equal(draw.source, "daemon");
  assert.equal(draw.reason, "selected");
  assert.equal(draw.selected, true);
  assert.equal(draw.live_rate, RATE);

  const payload = record.payload as Record<string, unknown>;
  const fields = {
    actionKey: record.action_key ?? "",
    payloadHash: String(payload["payload_hash"]),
    policyHash: String(payload["policy_sha256"]),
    draw,
  };
  // The whole point: an operator holding the secret recomputes the verdict from
  // the record's OWN fields, none of which the requester could choose freely.
  assert.equal(verifyLiveDrawRecord(SECRET, fields), true);
  assert.equal(verifyLiveDrawRecord("a-different-operator-secret", fields), false);

  for (const [why, tampered] of [
    ["a flipped verdict", { ...draw, selected: false }],
    ["a moved rate", { ...draw, live_rate: 0.9 }],
    ["a rewritten MAC", { ...draw, mac: bindingFor("forged") }],
    ["a dropped MAC", { ...draw, mac: undefined }],
    ["another source", { ...draw, source: "unavailable" as const }],
  ] as Array<[string, LiveDrawRecord]>) {
    assert.equal(
      verifyLiveDrawRecord(SECRET, { ...fields, draw: tampered }),
      false,
      `${why} verified`,
    );
  }
  // Recomputing against other bytes fails too, which is what binds the verdict
  // to the action rather than to the record that carries it.
  assert.equal(
    verifyLiveDrawRecord(SECRET, { ...fields, payloadHash: bindingFor("other") }),
    false,
  );
  assert.ok(!readFileSync(unit.logPath, "utf8").includes(SECRET));
  assertClean(unit);
});

// ===========================================================================
// 4. Every failure gates, with its own reason (AC 2)
// ===========================================================================

const FAILURES: Array<[string, (unit: Case) => DrawOutcome, string]> = [
  [
    "no daemon has ever run here",
    (unit) => askDaemonDraw(unit.logPath, questionFor(unit, "task-208:a")),
    "draw-daemon-absent",
  ],
  [
    "the answer is malformed",
    () => ({ ok: false, reason: "draw-answer-invalid", detail: "fixture" }),
    "draw-answer-invalid",
  ],
  [
    "the daemon is gone",
    () => ({ ok: false, reason: "draw-daemon-stale", detail: "fixture" }),
    "draw-daemon-stale",
  ],
];

for (const [why, asker, expected] of FAILURES) {
  test(`the draw fails closed when ${why}, recording ${expected}`, () => {
    const key = "task-208:a";
    const unit = ready([key]);
    const result = request(
      unit.logPath,
      { task: "task-208", actionKey: key, cls: LIVE_CLASS, est_cost_usd: "0.01" },
      at(1),
      "agent:claude",
      {
        policy: { file: unit.policyPath },
        env: SECRETLESS,
        drawAsk: (logPath: string) => asker({ ...unit, logPath }),
      },
    );
    assert.equal(result.ok, true, result.ok ? "" : result.message);
    if (!result.ok) return;

    // Gated: the action stops for a human, exactly as it did before APRV-208.
    assert.equal(result.proceed, false);
    assert.equal(result.autonomy, "manual");
    assert.equal(result.live?.gated, true);
    assert.equal(result.live?.reason, expected);

    const record = requestedFor(unit, key);
    assert.ok(record !== null);
    if (record === null) return;
    const draw = drawOf(record);
    assert.ok(draw !== undefined, "the refusal was not recorded on the request");
    if (draw === undefined) return;
    assert.equal(draw.source, "unavailable");
    assert.equal(draw.reason, expected);
    // No MAC, so no verifier can ever mistake a refusal for an evidenced draw.
    assert.equal(draw.mac, undefined);
    assert.equal(draw.selected, undefined);
    assert.equal(verifyLiveDrawRecord(SECRET, {
      actionKey: key,
      payloadHash: bindingFor(key),
      policyHash: policyHashOf(unit),
      draw,
    }), false);
    assertClean(unit);
  });
}

test("the three refusals are distinct, so a diagnostic can branch on them", () => {
  const reasons = new Set(FAILURES.map(([, , expected]) => expected));
  assert.equal(reasons.size, 3);
});

// ===========================================================================
// 5. The real relay, end to end (AC 1's transport, AC 4)
// ===========================================================================

/**
 * The whole thing, in the shape it actually runs in: a real `approval daemon
 * run` holding the secret in ITS environment, and this process — holding none —
 * asking through the production `spawnSync` relay.
 *
 * A separate process is not a nicety here, it is the test. The relay is
 * synchronous, so a server on this thread could never accept the connection: the
 * event loop is inside `spawnSync`. That constraint is exactly why the daemon
 * exists as the answerer and why the asker pays a child.
 */
test("the daemon holds the secret, the asker holds none, and the draw crosses between them", async () => {
  const key = "task-208:relay";
  const unit = ready([key]);
  const socketPath = drawSocketPathFor(unit.logPath);

  const daemonEnv: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"] ?? "",
    [SECRET_ENV]: SECRET,
  };
  const daemon = spawn(
    process.execPath,
    [
      join(process.cwd(), "dist", "src", "cli", "main.js"),
      "daemon",
      "run",
      "--log",
      unit.logPath,
      "--policy",
      unit.policyPath,
      "--dir",
      unit.dir,
      "--interval",
      "1h",
      "--json",
    ],
    { cwd: unit.dir, env: daemonEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  daemon.stdout.setEncoding("utf8");
  daemon.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });

  try {
    for (let waited = 0; waited < 200 && !existsSync(socketPath); waited += 1) {
      await new Promise((settle) => setTimeout(settle, 50));
    }
    assert.equal(existsSync(socketPath), true, `no socket appeared: ${stdout}`);

    // This process's environment carries no secret — the hook's situation.
    assert.equal(SECRET_ENV in process.env, false);

    const question = questionFor(unit, key);
    const outcome = askDaemonDraw(unit.logPath, question);
    assert.equal(outcome.ok, true, outcome.ok ? "" : `${outcome.reason}: ${outcome.detail}`);
    if (!outcome.ok) return;
    assert.equal(outcome.answer.selected, isSampled(SECRET, question.payload_hash, RATE));
    assert.equal(
      verifyDrawAnswer(SECRET, question, outcome.answer.selected, outcome.answer.mac),
      true,
      "the daemon's MAC does not verify under the operator's secret",
    );
    assert.notEqual(outcome.answer.daemon_pid, process.pid, "the draw was made in this process");

    // The daemon's first line says where it is serving draws, so an operator can
    // see whether supervised-live is live without asking the process anything.
    assert.match(stdout, /"draw":"[^"]*draw\.sock"/u);
    // And nothing it printed carries the secret.
    assert.ok(!stdout.includes(SECRET));
  } finally {
    daemon.kill("SIGTERM");
    for (let waited = 0; waited < 100 && daemon.exitCode === null; waited += 1) {
      await new Promise((settle) => setTimeout(settle, 50));
    }
  }

  // A stopped daemon takes its socket with it, so the next asker fails closed
  // rather than dialling a file nobody serves.
  const outcome = askDaemonDraw(unit.logPath, questionFor(unit, key));
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.ok(
    outcome.reason === "draw-daemon-absent" || outcome.reason === "draw-daemon-stale",
    `a stopped daemon answered ${outcome.reason}`,
  );
});

test("a socket that nothing serves is stale, not absent, and never an answer", () => {
  const unit = ready(["task-208:a"]);
  // A plain file where the socket belongs: something is there, and no daemon is.
  mkdirSync(drawDirFor(unit.logPath), { recursive: true, mode: 0o700 });
  writeFileSync(drawSocketPathFor(unit.logPath), "not a socket", { mode: 0o600 });
  const outcome = askDaemonDraw(unit.logPath, questionFor(unit, "task-208:a"));
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.reason, "draw-daemon-stale");
});
