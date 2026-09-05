/**
 * `approval feedback` (APRV-239) — the human-to-agent direction of the log.
 *
 * Every record under test is produced by the real append path: `core/gate.ts`
 * for the registrations, requests and grants, `core/execute.ts` for the
 * executions, the daemon's sampler for the `audit.sampled`, and `core/audit.ts`
 * for the reviews. Nothing here hand-writes a log line, so no assertion rests on
 * a record the write boundary would have rejected, and the one case that DOES
 * corrupt a log corrupts it after the fact, which is the thing being tested.
 *
 * What the file is actually guarding, beyond the flag plumbing:
 *
 *   - the banner is on BOTH output forms, because a reaction printed without
 *     the label is a person's after-the-fact opinion handed to an agent in the
 *     register of a rule;
 *   - `agentActor` comes from the registration and never from a payload, so the
 *     party under oversight cannot choose whose feedback an entry reads as;
 *   - an entry with neither a reaction nor a note is omitted, because absence of
 *     feedback is not feedback;
 *   - the verb reads VERIFIED records, so an unverifiable log refuses rather
 *     than showing a partial list of sentences attributed to a person.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { FEEDBACK_BANNER } from "../src/cli/feedback.js";
import { main } from "../src/cli/main.js";
import { humanFeedback, reviewSample, sampleSupervised } from "../src/core/audit.js";
import type { EventRecord } from "../src/core/log.js";
import { verify } from "../src/core/verify.js";
import { appendAttestation, decide, register, request, startExecution } from "./clock-adapters.js";

const scratch = mkdtempSync(join(tmpdir(), "approval-md-feedback-"));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const T0 = "2026-08-05T10:00:00.000Z";

function at(minutes: number): string {
  return new Date(Date.parse(T0) + minutes * 60_000).toISOString();
}

function fixedClock(ts: string): () => string {
  return () => ts;
}

const TEST_SECRET_ENV = "APPROVAL_TEST_SAMPLING_SECRET";
const ENV: NodeJS.ProcessEnv = { [TEST_SECRET_ENV]: "operator-held-secret-never-in-the-log" };

/** Rate 1: every supervised execution is sampled, so the fixture is determinate. */
const POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "6h"',
  "  on_expiry: reject",
  "classes:",
  "  files.write.*:",
  "    autonomy: supervised",
  "  communicate.email.external:",
  "    autonomy: manual",
  "budgets:",
  "  global:",
  "    daily_usd: 10",
  "    daily_actions: 50",
  "audit:",
  "  supervised_sample_rate: 1",
  `  sampling_secret_env: ${TEST_SECRET_ENV}`,
  "```",
  "",
].join("\n");

function bindingFor(key: string): string {
  return createHash("sha256").update(`payload:${key}`, "utf8").digest("hex");
}

function action(
  key: string,
  klass: string,
  summary: string,
): Record<string, unknown> {
  return {
    class: klass,
    summary,
    reversible: klass !== "communicate.email.external",
    est_cost_usd: "0.02",
    idempotency_key: key,
    payload_hash: bindingFor(key),
  };
}

const CLAUDE_ENVELOPE = {
  origin: { app: "example-capture", created_by: "human:carter" },
  state: "proposed",
  actions: [
    action("task-042:chaser", "communicate.email.external", "Send the deposit chaser"),
    action("task-042:draft", "files.write.local", "Write the draft"),
    action("task-042:draft2", "files.write.local", "Write the second draft"),
  ],
};

const CODEX_ENVELOPE = {
  origin: { app: "example-capture", created_by: "human:carter" },
  state: "proposed",
  actions: [
    action("task-099:notice", "communicate.email.external", "Send the renewal notice"),
    action("task-099:receipt", "communicate.email.external", "Send the receipt"),
  ],
};

interface Case {
  dir: string;
  logPath: string;
  policyPath: string;
}

function newCase(): Case {
  counter += 1;
  const dir = join(scratch, `case-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  const policyPath = join(dir, "APPROVAL.md");
  writeFileSync(policyPath, POLICY, "utf8");
  return { dir, logPath: join(dir, ".approval", "log", "events.jsonl"), policyPath };
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

function assertClean(unit: Case): void {
  const result = verify(unit.logPath);
  assert.equal(result.status, "clean", `log not clean: ${JSON.stringify(result)}`);
}

async function runCli(unit: Case, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await main([...argv, "--log", unit.logPath], {
    cwd: unit.dir,
    streams: {
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
    },
  });
  return { code, out, err };
}

function ok<T extends { ok: boolean }>(result: T, what: string): T {
  assert.equal(result.ok, true, `${what} failed: ${JSON.stringify(result)}`);
  return result;
}

/**
 * The fixture log every case below reads.
 *
 * Two tasks registered by two different agents, so `--task` and `--actor` have
 * something to separate. Six things a human could have said, of which four are
 * feedback and two are silence:
 *
 *   1. grant of task-042:chaser  — reaction `loved` + note        (decision)
 *   2. review of task-042:draft  — `--deny` + `disliked` + note   (review)
 *   3. review of task-042:draft2 — note only, no reaction         (review)
 *   4. grant of task-099:notice  — note only, no reaction         (decision)
 *   5. grant of task-099:receipt — neither: the ordinary case     (omitted)
 *   6. review of task-042:chaser — nothing at all                 (n/a, not sampled)
 */
function fixture(): Case {
  const unit = newCase();
  ok(appendAttestation(unit.logPath, unit.policyPath, "human:carter", T0), "attest");
  const options = { policy: { file: unit.policyPath } };

  ok(
    register(unit.logPath, { task: "task-042", envelope: CLAUDE_ENVELOPE }, at(1), "agent:claude"),
    "register task-042",
  );
  ok(
    register(unit.logPath, { task: "task-099", envelope: CODEX_ENVELOPE }, at(2), "agent:codex"),
    "register task-099",
  );

  // 1. A grant that says what the approver thought of it.
  ok(
    request(unit.logPath, { task: "task-042", actionKey: "task-042:chaser", cls: "communicate.email.external" }, at(3), "agent:claude", options),
    "request chaser",
  );
  ok(
    decide(unit.logPath, "task-042:chaser", "grant", "human:carter", at(4), {
      ...options,
      note: "exactly the wording I would have used",
      reaction: "loved",
    }),
    "grant chaser",
  );

  // 4 and 5. One grant with words, one without.
  ok(
    request(unit.logPath, { task: "task-099", actionKey: "task-099:notice", cls: "communicate.email.external" }, at(5), "agent:codex", options),
    "request notice",
  );
  ok(
    decide(unit.logPath, "task-099:notice", "grant", "human:carter", at(6), {
      ...options,
      note: "fine, but send it before Friday next time",
    }),
    "grant notice",
  );
  ok(
    request(unit.logPath, { task: "task-099", actionKey: "task-099:receipt", cls: "communicate.email.external" }, at(7), "agent:codex", options),
    "request receipt",
  );
  ok(
    decide(unit.logPath, "task-099:receipt", "grant", "human:carter", at(8), options),
    "grant receipt",
  );

  // 2 and 3. Two supervised executions, sampled, then reviewed.
  for (const [key, minutes] of [
    ["task-042:draft", 9],
    ["task-042:draft2", 10],
  ] as Array<[string, number]>) {
    ok(
      startExecution(
        unit.logPath,
        key,
        { ...options, presentedPayloadHash: bindingFor(key) },
        at(minutes),
        "agent:claude",
      ),
      `execute ${key}`,
    );
  }
  ok(
    sampleSupervised(unit.logPath, unit.dir, {
      policy: { file: unit.policyPath },
      env: ENV,
      clock: fixedClock(at(11)),
    }),
    "sample",
  );

  ok(
    reviewSample(
      unit.logPath,
      { kind: "action-key", actionKey: "task-042:draft" },
      "human:carter",
      "this should not have been written at all",
      { clock: fixedClock(at(12)), verdict: "denied", reaction: "disliked" },
    ),
    "review draft",
  );
  ok(
    reviewSample(
      unit.logPath,
      { kind: "action-key", actionKey: "task-042:draft2" },
      "human:carter",
      "read it; nothing to say beyond that",
      { clock: fixedClock(at(13)) },
    ),
    "review draft2",
  );

  assertClean(unit);
  return unit;
}

interface FeedbackJson {
  ok: boolean;
  log: string;
  note: string;
  total: number;
  entries: Array<Record<string, unknown>>;
}

async function feedback(unit: Case, argv: string[] = []): Promise<FeedbackJson> {
  const run = await runCli(unit, ["feedback", ...argv, "--json"]);
  assert.equal(run.code, 0, run.err);
  return JSON.parse(run.out) as FeedbackJson;
}

// ---------------------------------------------------------------------------
// What it lists
// ---------------------------------------------------------------------------

test("feedback lists what a human said, oldest first, from both sources", async () => {
  const unit = fixture();
  const body = await feedback(unit);

  assert.equal(body.ok, true);
  assert.equal(body.log, unit.logPath);
  assert.equal(body.total, 4);
  assert.deepEqual(
    body.entries.map((entry) => [entry["source"], entry["reaction"], entry["actionKey"]]),
    [
      ["decision", "loved", "task-042:chaser"],
      ["decision", null, "task-099:notice"],
      ["review", "disliked", "task-042:draft"],
      ["review", null, "task-042:draft2"],
    ],
  );

  const first = body.entries[0] as Record<string, unknown>;
  assert.equal(first["event"], "approval.granted");
  assert.equal(first["actor"], "human:carter");
  assert.equal(first["note"], "exactly the wording I would have used");
  assert.equal(first["task"], "task-042");
  assert.equal(first["class"], "communicate.email.external");
  assert.equal(first["agentActor"], "agent:claude");
  // A grant has no verdict to report, and reporting one would invent a
  // supervision decision nobody made.
  assert.equal(first["verdict"], null);
  assert.equal(first["sampleSeq"], null);

  const review = body.entries[2] as Record<string, unknown>;
  assert.equal(review["event"], "audit.reviewed");
  // The enforcement field is reported BESIDE the reaction so the two are never
  // confused: this one is a denial that the human also disliked.
  assert.equal(review["verdict"], "denied");
  assert.equal(review["reaction"], "disliked");
  assert.equal(typeof review["sampleSeq"], "number");
  assertClean(unit);
});

test("an entry with neither a reaction nor a note is omitted", async () => {
  const unit = fixture();
  const body = await feedback(unit);
  const keys = body.entries.map((entry) => entry["actionKey"]);
  // The bare grant happened, and the log records it; it is not FEEDBACK.
  assert.equal(
    records(unit).some(
      (record) => record.event === "approval.granted" && record.action_key === "task-099:receipt",
    ),
    true,
  );
  assert.equal(keys.includes("task-099:receipt"), false);
});

test("rejections and revocations are not a source", async () => {
  const unit = newCase();
  ok(appendAttestation(unit.logPath, unit.policyPath, "human:carter", T0), "attest");
  const options = { policy: { file: unit.policyPath } };
  ok(register(unit.logPath, { task: "task-099", envelope: CODEX_ENVELOPE }, at(1), "agent:codex"), "register");
  ok(
    request(unit.logPath, { task: "task-099", actionKey: "task-099:notice", cls: "communicate.email.external" }, at(2), "agent:codex", options),
    "request",
  );
  ok(
    decide(unit.logPath, "task-099:notice", "reject", "human:carter", at(3), {
      ...options,
      note: "not this week",
    }),
    "reject",
  );

  const body = await feedback(unit);
  assert.equal(body.total, 0);
  assert.deepEqual(body.entries, []);
  assertClean(unit);
});

// ---------------------------------------------------------------------------
// agentActor
// ---------------------------------------------------------------------------

test("agentActor comes from the registration, never from a payload field", async () => {
  const unit = fixture();
  const body = await feedback(unit);
  for (const entry of body.entries) {
    const expected = String(entry["task"]) === "task-099" ? "agent:codex" : "agent:claude";
    assert.equal(entry["agentActor"], expected, JSON.stringify(entry));
  }

  // The claim is about the SOURCE, not just the value: the registrations are the
  // only records naming these agents, and no payload anywhere carries an actor
  // field the projection could have read instead.
  const registrations = records(unit).filter((record) => record.event === "task.registered");
  assert.deepEqual(
    registrations.map((record) => record.actor),
    ["agent:claude", "agent:codex"],
  );
  for (const record of records(unit)) {
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    assert.ok(!("actor" in payload), `payload actor field on seq ${String(record.seq)}`);
  }
});

test("humanFeedback is a pure projection over the records it is handed", async () => {
  const unit = fixture();
  const all = records(unit);
  assert.deepEqual(humanFeedback(all), humanFeedback([...all]));
  assert.equal(humanFeedback(all).length, 4);
  // No log, no policy, no clock: an empty list projects to an empty list rather
  // than reaching for anything.
  assert.deepEqual(humanFeedback([]), []);
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

test("--task, --actor, --reaction and --source narrow the list", async () => {
  const unit = fixture();

  const byTask = await feedback(unit, ["--task", "task-099"]);
  assert.deepEqual(byTask.entries.map((entry) => entry["actionKey"]), ["task-099:notice"]);

  // --actor is the AGENT the feedback is about, not the human who wrote it.
  const byAgent = await feedback(unit, ["--actor", "agent:codex"]);
  assert.deepEqual(byAgent.entries.map((entry) => entry["actionKey"]), ["task-099:notice"]);
  const byHuman = await feedback(unit, ["--actor", "human:carter"]);
  assert.equal(byHuman.total, 0);

  const byReaction = await feedback(unit, ["--reaction", "disliked"]);
  assert.deepEqual(byReaction.entries.map((entry) => entry["actionKey"]), ["task-042:draft"]);

  const bySource = await feedback(unit, ["--source", "review"]);
  assert.deepEqual(bySource.entries.map((entry) => entry["source"]), ["review", "review"]);
  const decisions = await feedback(unit, ["--source", "decision"]);
  assert.deepEqual(decisions.entries.map((entry) => entry["source"]), ["decision", "decision"]);
});

test("--since filters by UTC date and --limit keeps the newest, printed oldest first", async () => {
  const unit = fixture();

  const sinceToday = await feedback(unit, ["--since", "2026-08-05"]);
  assert.equal(sinceToday.total, 4);
  const sinceTomorrow = await feedback(unit, ["--since", "2026-08-06"]);
  assert.equal(sinceTomorrow.total, 0);

  const limited = await feedback(unit, ["--limit", "2"]);
  // `total` counts what matched, `entries` holds at most --limit of them, so a
  // reader can tell a short list from a truncated one.
  assert.equal(limited.total, 4);
  assert.deepEqual(limited.entries.map((entry) => entry["actionKey"]), [
    "task-042:draft",
    "task-042:draft2",
  ]);
});

test("a word outside a closed vocabulary is a usage error, not an empty list", async () => {
  const unit = fixture();
  for (const argv of [
    ["--reaction", "love"],
    ["--source", "grant"],
    ["--limit", "0"],
    ["--limit", "-3"],
    ["--since", "05-08-2026"],
    ["nonsense"],
  ]) {
    const run = await runCli(unit, ["feedback", ...argv, "--json"]);
    assert.equal(run.code, 2, `${argv.join(" ")} was accepted`);
    const error = (JSON.parse(run.err) as { error: { code: string } }).error;
    assert.equal(error.code, "usage");
  }
});

// ---------------------------------------------------------------------------
// The banner, the empty case, and the reads
// ---------------------------------------------------------------------------

test("the banner is on every output form", async () => {
  const unit = fixture();

  const human = await runCli(unit, ["feedback"]);
  assert.equal(human.code, 0, human.err);
  assert.ok(human.out.startsWith(FEEDBACK_BANNER), "the human form does not lead with the banner");

  const json = await feedback(unit);
  assert.equal(json.note, FEEDBACK_BANNER);

  const empty = newCase();
  ok(appendAttestation(empty.logPath, empty.policyPath, "human:carter", T0), "attest");
  const emptyHuman = await runCli(empty, ["feedback"]);
  assert.ok(emptyHuman.out.startsWith(FEEDBACK_BANNER), "the empty form dropped the banner");
  const emptyJson = await feedback(empty);
  assert.equal(emptyJson.note, FEEDBACK_BANNER);

  // The words themselves: what this is, and what it does not do.
  assert.match(FEEDBACK_BANNER, /HUMAN-AUTHORED GUIDANCE, not policy/u);
  assert.match(FEEDBACK_BANNER, /grants nothing, forbids nothing/u);
  assert.match(FEEDBACK_BANNER, /verdict, sampling probability or budget/u);
});

test("nothing to show prints _no feedback_ rather than an empty page", async () => {
  const unit = newCase();
  ok(appendAttestation(unit.logPath, unit.policyPath, "human:carter", T0), "attest");

  const human = await runCli(unit, ["feedback"]);
  assert.equal(human.code, 0, human.err);
  assert.match(human.out, /_no feedback_/u);

  const json = await feedback(unit);
  assert.equal(json.total, 0);
  assert.deepEqual(json.entries, []);

  // A filter that matches nothing says the same thing as an empty log.
  const filtered = await runCli(unit, ["feedback", "--task", "task-000"]);
  assert.match(filtered.out, /_no feedback_/u);
});

test("the human rendering carries the words, the grade and the join, and no [claimed]", async () => {
  const unit = fixture();
  const run = await runCli(unit, ["feedback"]);
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, /exactly the wording I would have used/u);
  assert.match(run.out, /loved/u);
  assert.match(run.out, /task-042:chaser/u);
  assert.match(run.out, /agent agent:claude/u);
  assert.match(run.out, /class communicate\.email\.external/u);
  // `[claimed]` marks text written by the party under oversight. These words
  // were appended under a human: actor to a hash-chained log, which is what
  // that marker exists to distinguish journal text FROM.
  assert.equal(run.out.includes("[claimed]"), false);
});

test("the verb reads verified records and writes nothing", async () => {
  const unit = fixture();
  const before = readFileSync(unit.logPath, "utf8");
  await runCli(unit, ["feedback"]);
  await runCli(unit, ["feedback", "--json"]);
  assert.equal(readFileSync(unit.logPath, "utf8"), before, "the read surface wrote to the log");

  // A torn tail is exit 3 and shows nothing, rather than listing the records
  // that happened to parse: a reaction read out of an unverifiable log is a
  // sentence attributed to a person who may not have written it.
  appendFileSync(unit.logPath, '{"seq":99,"event":"audit.reviewed"', "utf8");
  const torn = await runCli(unit, ["feedback", "--json"]);
  assert.equal(torn.code, 3);
  assert.equal(torn.out, "");
  assert.equal((JSON.parse(torn.err) as { error: { code: string } }).error.code, "log-torn-tail");
});

test("an absent log reads as no feedback, and a directory in its place is I/O", async () => {
  // A log that does not exist yet is a workspace nobody has used, which every
  // read verb here treats as empty rather than as a failure.
  const fresh = newCase();
  const run = await runCli(fresh, ["feedback", "--json"]);
  assert.equal(run.code, 0, run.err);
  const body = JSON.parse(run.out) as FeedbackJson;
  assert.equal(body.total, 0);
  assert.deepEqual(body.entries, []);
  assert.equal(body.note, FEEDBACK_BANNER);

  // A path that exists and cannot be a log is exit 4, and it is reported as
  // I/O rather than as corruption.
  const broken = newCase();
  mkdirSync(broken.logPath, { recursive: true });
  const io = await runCli(broken, ["feedback", "--json"]);
  assert.equal(io.code, 4);
  assert.equal(io.out, "");
  assert.equal((JSON.parse(io.err) as { error: { code: string } }).error.code, "io");
});

test("--help prints the guidance framing and exits 0", async () => {
  const unit = fixture();
  const run = await runCli(unit, ["feedback", "--help"]);
  assert.equal(run.code, 0);
  assert.match(run.out, /approval feedback/u);
  assert.match(run.out, /GUIDANCE/u);
});
