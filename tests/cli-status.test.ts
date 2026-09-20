/**
 * `approval status` and `approval queue` CLI tests (APRV-18 Part B/C).
 *
 * The two verbs answer two different people — the operator who repairs and the
 * human who decides — and these tests pin that separation as hard as they pin
 * the shapes: every case that puts something in one asserts that the other did
 * not grow it.
 *
 * As in the other CLI suites, every record is produced by the real CLI through
 * the real append path, and `approval log verify` runs after each flow.
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

import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";

import { derivedDaemonId } from "../src/core/daemon-host.js";
import { runPayloadHash } from "../src/core/payload.js";
import { recordRefusedGesture } from "../src/core/gesture-refusal.js";
import { VERB_REGISTRY, verbLabel } from "../src/cli/verb-registry.js";

const addFormats = (addFormatsModule as unknown as { default: FormatsPlugin }).default;

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-cli-status-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string, env: Record<string, string> = {}): Run {
  const childEnv = { ...process.env, ...env };
  if (env["APPROVAL_HUMAN"] === undefined) delete childEnv["APPROVAL_HUMAN"];
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
  '  approval_ttl: "1h"',
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
  "```",
  "",
].join("\n");

/** No budgets block at all: status must report an empty budget list, not fail. */
const POLICY_NO_BUDGETS = POLICY.split("budgets:")[0] as string;

/**
 * The one command every case in this suite runs, and therefore the one payload
 * every declared action binds to (amended SPEC.md §6.2, APRV-140).
 *
 * A1 made the hash MUST for manual actions; APRV-140 made it MUST for every
 * action that executes, and made `approval run` recompute it from the argv and
 * cwd it is about to spawn. A stand-in constant is no longer usable, so the
 * child's exit code travels in the ENVIRONMENT rather than in its argv: every
 * case runs the same bytes, and one binding per case directory covers the whole
 * fixture.
 */
const CHILD = [process.execPath, "-e", "process.exit(Number(process.env.CHILD_EXIT ?? 0))"];

/**
 * The unrebuildable warning `status` carries in `payload_store.note`, pinned
 * verbatim (APRV-35).
 *
 * Duplicated from `src/cli/execute.ts` on purpose: the point of the key is the
 * sentence, and a test that matched it loosely would let the one warning about
 * the one cache a rebuild cannot recreate be softened without anybody noticing.
 */
const PAYLOAD_STORE_NOTE =
  "the payload store holds the bytes approvals bind to, keyed by their hash; " +
  "it is the one cache that cannot be rebuilt from the log, and losing it leaves " +
  "manual requests rendering as payload-unavailable rather than showing bytes no hash bound";

function taskFile(binding: string): string {
  return [
  "---",
  "id: task-042",
  "title: Chase deposit refund",
  "status: In Progress",
  "approval:",
  "  origin:",
  "    app: example-capture",
  '    created_by: "human:carter"',
  "  state: proposed",
  "  actions:",
  "    - class: communicate.email.external",
  '      summary: "Send deposit chaser"',
  "      reversible: false",
  '      est_cost_usd: "0.02"',
  '      idempotency_key: "task-042:chaser"',
  `      payload_hash: "${binding}"`,
  "    - class: communicate.email.external",
  '      summary: "Send the follow-up"',
  "      reversible: false",
  '      est_cost_usd: "0.02"',
  '      idempotency_key: "task-042:followup"',
  `      payload_hash: "${binding}"`,
  "    - class: files.write.local",
  '      summary: "Write the draft"',
  "      reversible: true",
  '      est_cost_usd: "0.01"',
  '      idempotency_key: "task-042:draft"',
  `      payload_hash: "${binding}"`,
  "    - class: files.write.local",
  '      summary: "Write the second draft"',
  "      reversible: true",
  '      est_cost_usd: "0.01"',
  '      idempotency_key: "task-042:draft2"',
  `      payload_hash: "${binding}"`,
  "    - class: files.write.local",
  '      summary: "Write the third draft"',
  "      reversible: true",
  '      est_cost_usd: "0.01"',
  '      idempotency_key: "task-042:draft3"',
  `      payload_hash: "${binding}"`,
  "---",
  "",
  "## Description",
  "Body.",
  "",
  ].join("\n");
}

/** What `approval run` will compute for {@link CHILD} in `dir`. */
function bindingFor(dir: string): string {
  return runPayloadHash(CHILD, dir);
}

function caseDir(policyText: string = POLICY): string {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), policyText, "utf8");
  writeFileSync(join(dir, "task-042.md"), taskFile(bindingFor(dir)), "utf8");
  return dir;
}

function logPath(dir: string): string {
  return join(dir, ".approval", "log", "events.jsonl");
}

function rawLog(dir: string): string {
  return existsSync(logPath(dir)) ? readFileSync(logPath(dir), "utf8") : "";
}

function logRecords(dir: string): Record<string, unknown>[] {
  return rawLog(dir)
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function assertClean(dir: string): void {
  const verify = runCli(["log", "verify", "--json"], dir);
  assert.equal(verify.code, 0, verify.stderr);
  assert.equal((JSON.parse(verify.stdout) as Record<string, unknown>)["status"], "clean");
}

function ready(policyText: string = POLICY): string {
  const dir = caseDir(policyText);
  assert.equal(runCli(["policy", "attest", "--as", "human:carter"], dir).code, 0);
  assert.equal(runCli(["register", "task-042.md", "--as", "agent:claude"], dir).code, 0);
  return dir;
}

function requestChaser(dir: string, actionKey = "task-042:chaser"): void {
  assert.equal(
    runCli(["request", "task-042", "--action", actionKey, "--as", "agent:claude"], dir).code,
    0,
  );
}

function grant(dir: string, actionKey: string): string {
  const run = runCli(["grant", actionKey, "--as", "human:carter", "--json"], dir);
  assert.equal(run.code, 0, run.stderr);
  return String((JSON.parse(run.stdout) as Record<string, unknown>)["token"]);
}

function statusJson(dir: string): { code: number; body: Record<string, unknown> } {
  const run = runCli(["status", "--json"], dir);
  return { code: run.code, body: JSON.parse(run.stdout) as Record<string, unknown> };
}

function queueJson(dir: string): { code: number; body: Record<string, unknown> } {
  const run = runCli(["queue", "--json"], dir);
  assert.equal(run.stderr, "", run.stderr);
  return { code: run.code, body: JSON.parse(run.stdout) as Record<string, unknown> };
}

/** Run a supervised action to completion, or to a failure with `exitCode`. */
function runSupervised(dir: string, actionKey: string, exitCode: number): void {
  const run = runCli(["run", actionKey, "--as", "agent:claude", "--", ...CHILD], dir, {
    CHILD_EXIT: String(exitCode),
  });
  assert.equal(run.code, exitCode, run.stderr);
}

// ===========================================================================
// approval status — the frozen shape
// ===========================================================================

test("status --json on a healthy repo emits the frozen shape and exits 0", () => {
  const dir = ready();
  requestChaser(dir);
  grant(dir, "task-042:chaser");

  const { code, body } = statusJson(dir);
  assert.equal(code, 0);
  assert.deepEqual(body, {
    ok: true,
    healthy: true,
    attestation: { state: "attested", seq: 1 },
    verification: { status: "clean", records: 4 },
    dangling: [],
    budgets: [
      {
        limit: "global.daily_actions",
        scope: "global",
        window: "rolling-24h",
        // One authorization in the window (the grant), plus the zero-cost
        // probe's own action — documented in --help, asserted here.
        consumed: "1",
        requested: "1",
        remaining: "48",
        pass: true,
      },
      {
        limit: "global.daily_usd",
        scope: "global",
        window: "rolling-24h",
        consumed: "0.02",
        requested: "0",
        remaining: "9.98",
        pass: true,
      },
    ],
    loop_escalations: [],
    // Additive (APRV-145): how many harness starts carry an outcome and how
    // many do not. INFORMATIONAL — a non-zero `unreported` moves neither
    // `healthy` nor the exit code, for the reason `anomalies` moves neither:
    // it is a coverage measurement, not an integrity verdict.
    harness_outcomes: { started: 0, reported: 0, unreported: 0 },
    // Additive (APRV-245): what git witnessed on this branch, against the log.
    // Informational for the same reason, and unavailable here because the
    // fixture is a scratch directory under the OS temp root rather than a
    // checkout — which is the honest answer, not a zero.
    coverage: { available: false, reason: "not a git checkout", observed: 0, covered: 0 },
    // Additive (APRV-127): reconciliation obligations opened by a retrospective
    // denial and not yet discharged. Empty here, and — unlike the payload store
    // — a non-empty list DOES move `healthy` and the exit code, because an
    // unreconciled denial is a "no" that has so far changed nothing.
    reconciliation: [],
    // Additive (APRV-35). This fixture binds hashes and never supplies bytes
    // for a request, so the one file the store holds is the one APRV-356 put
    // there: the attested policy text, bound by the `policy.updated` at seq 1.
    // Nothing here is dangling, and none of it moves `healthy` or the exit code
    // above.
    payload_store: { present: true, files: 1, pruned: 0, orphans: 0, note: PAYLOAD_STORE_NOTE },
    // Additive (APRV-383): the daemon identity this instance resolves, which is
    // what a daemon started HERE would write onto every record it appends.
    // `status` is not the daemon, so this is a fact about the instance: the id
    // derives from the instance home, nothing declared it in this shell, and the
    // fixture policy carries no `daemons` list, so `allowed` is `null` — no
    // restriction, which is not the same fact as an empty list. Informational: it
    // moves neither `healthy` nor the exit code.
    daemon: { id: derivedDaemonId(logPath(dir)), source: "derived", allowed: null },
  });
  assert.equal(rawLog(dir), rawLog(dir), "status must not write");
  assertClean(dir);
});

test("status reports a policy edited after attestation as hash-mismatch, exit 1", () => {
  const dir = ready();
  writeFileSync(join(dir, "APPROVAL.md"), `${POLICY}\n# edited\n`, "utf8");
  const { code, body } = statusJson(dir);
  assert.equal(code, 1);
  assert.equal(body["healthy"], false);
  assert.deepEqual(body["attestation"], { state: "hash-mismatch", seq: 1 });
});

test("status reports a never-attested policy with a null seq, exit 1", () => {
  const dir = caseDir();
  const { code, body } = statusJson(dir);
  assert.equal(code, 1);
  assert.deepEqual(body["attestation"], { state: "not-attested", seq: null });
  assert.deepEqual(body["verification"], { status: "clean", records: 0 });
});

test("status with no budgets configured reports an empty budget list", () => {
  const dir = ready(POLICY_NO_BUDGETS);
  const { code, body } = statusJson(dir);
  assert.equal(code, 0);
  assert.deepEqual(body["budgets"], []);
});

test("status text mode names health, attestation, verification, dangling and budgets", () => {
  const dir = ready();
  const run = runCli(["status"], dir);
  assert.equal(run.code, 0, run.stderr);
  // APRV-91 #9/#14: aligned key/value rows, so the separator is a column of
  // spaces rather than a colon, and the payload store's rationale paragraph
  // moved to `--json`'s `payload_store.note` (still asserted above).
  assert.match(run.stdout, /^health {2,}ok$/mu);
  assert.match(run.stdout, /^attestation {2,}attested \(seq 1\)$/mu);
  assert.match(run.stdout, /^verification {2,}clean/mu);
  assert.match(run.stdout, /^dangling executions {2,}none$/mu);
  assert.match(run.stdout, /^budget global\.daily_usd {2,}consumed /mu);
  assert.match(run.stdout, /^loop escalations {2,}none$/mu);
  // APRV-145: informational, and it says so by never moving `health` above.
  assert.match(run.stdout, /^harness outcomes {2,}0 started, 0 reported, 0 unreported$/mu);
  // APRV-245: informational too, and in a scratch directory it says why it has
  // no number rather than printing a zero it cannot stand behind.
  assert.match(run.stdout, /^git coverage {2,}not a git checkout$/mu);
  // APRV-356: the attestation stores the attested policy text, so even a repo
  // that has made no request carrying --payload holds one bound file.
  assert.match(run.stdout, /^payload store {2,}1 file\(s\), 0 pruned, 0 unbound$/mu);
  // The log path is written the way the operator would type it, and piped
  // output carries no escape codes.
  assert.match(run.stdout, /^log {2,}\.approval\/log\/events\.jsonl$/mu);
  assert.ok(!run.stdout.includes("\u001b"));
});

// ---------------------------------------------------------------------------
// The payload store (APRV-35)
// ---------------------------------------------------------------------------

test("status counts the payload store once a real request has stored bytes", () => {
  const dir = caseDir();
  const payload = '{"to":"landlord@example.com","body":"Chasing the deposit."}\n';
  writeFileSync(join(dir, "payload.json"), payload, "utf8");

  // The declared binding is whatever `approval payload hash` says about these
  // exact bytes, so the request below is the real accepted path rather than a
  // directory assembled by hand.
  const hashRun = runCli(["payload", "hash", "payload.json"], dir);
  assert.equal(hashRun.code, 0, hashRun.stderr);
  const hash = hashRun.stdout.trim();
  writeFileSync(join(dir, "task-042.md"), taskFile(hash), "utf8");

  assert.equal(runCli(["policy", "attest", "--as", "human:carter"], dir).code, 0);
  assert.equal(runCli(["register", "task-042.md", "--as", "agent:claude"], dir).code, 0);
  const requested = runCli(
    [
      "request",
      "task-042",
      "--action",
      "task-042:chaser",
      "--as",
      "agent:claude",
      "--payload",
      "payload.json",
    ],
    dir,
  );
  assert.equal(requested.code, 0, requested.stderr);

  const { code, body } = statusJson(dir);
  assert.equal(code, 0);
  assert.deepEqual(body["payload_store"], {
    present: true,
    // Two, and both bound: the request's own material, and the attested policy
    // text APRV-356 stores for the `policy.attest` above.
    files: 2,
    // APRV-41: what the log says about the store, beside what the store holds.
    // Nothing has been pruned here, and every file is bound by some record.
    pruned: 0,
    orphans: 0,
    note: PAYLOAD_STORE_NOTE,
  });
  assert.equal(body["healthy"], true, "the store is informational, not a health input");

  const text = runCli(["status"], dir);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /^payload store {2,}2 file\(s\), 0 pruned, 0 unbound$/mu);
  assertClean(dir);
});

test("a lost payload store is reported without changing health or the exit code", () => {
  const dir = ready();
  requestChaser(dir);
  grant(dir, "task-042:chaser");

  // Deleting the store cannot be undone by any rebuild, which is exactly what
  // the note says; what it must NOT do is turn a healthy repo unhealthy.
  rmSync(join(dir, ".approval", "payloads"), { recursive: true, force: true });

  const { code, body } = statusJson(dir);
  assert.equal(code, 0);
  assert.equal(body["healthy"], true);
  assert.deepEqual(body["payload_store"], {
    present: false,
    files: 0,
    pruned: 0,
    orphans: 0,
    note: PAYLOAD_STORE_NOTE,
  });
  assert.match(
    String((body["payload_store"] as Record<string, unknown>)["note"]),
    /cannot be rebuilt from the log/u,
  );
});

// ---------------------------------------------------------------------------
// The two refusal families (APRV-376)
// ---------------------------------------------------------------------------

/**
 * Refuse a human's DECISION through the real surface, and return the code.
 *
 * `--reaction loved` with no `--note` is refused `reaction-note-required` by
 * `approval grant` itself, and the CLI's decision surface appends one
 * `audit.decision_refused` for it (APRV-235): a person tapped, the gate would not
 * take it, and the log says so. Nothing else is appended, and the request stays
 * pending, which is what makes this the cheapest real producer of the record.
 */
function refuseDecision(dir: string): void {
  const run = runCli(
    ["grant", "task-042:chaser", "--reaction", "loved", "--as", "human:carter", "--json"],
    dir,
  );
  // A gate refusal is exit 1, and with `--json` its object goes to stderr.
  assert.equal(run.code, 1, run.stderr);
  assert.equal(
    (JSON.parse(run.stderr) as { error: { code: string } }).error.code,
    "reaction-note-required",
  );
}

/**
 * Refuse a human's GESTURE, through the same function the only surface that can
 * produce one calls.
 *
 * `audit.gesture_refused` has exactly one writer today, the Telegram listener's
 * checkpoint and review handlers (`cli/channel-telegram.ts`), and reaching it
 * needs a mock Bot API server: that surface is already proved in
 * `tests/checkpoint-tap.test.ts` and `tests/channels-telegram.test.ts`. What is
 * under test HERE is the report, so this calls `recordRefusedGesture` directly —
 * the real append path, the real write boundary, the real chain. No line is
 * written by hand anywhere in this file.
 */
function refuseGesture(dir: string, code = "sender-unmapped"): void {
  const result = recordRefusedGesture(
    logPath(dir),
    {
      gesture: "checkpoint-signature",
      actor: null,
      channel: "telegram",
      sender: GESTURE_SENDER,
    },
    { code, message: `refused ${code}` },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.notEqual(
    result.ok ? result.audit : null,
    null,
    "the refusal recorded nothing, so there is no record for status to count",
  );
}

/** The account every refused gesture in this suite arrives from. */
const GESTURE_SENDER = { channel: "telegram", id: "5551234567" };

function refusals(body: Record<string, unknown>): Record<string, unknown> | undefined {
  return body["refusals"] as Record<string, unknown> | undefined;
}

test("status lists both refusal families with the newest seqs and their codes", () => {
  const dir = ready();
  requestChaser(dir);
  refuseDecision(dir);
  refuseDecision(dir);
  refuseGesture(dir);

  // Spelled out so the seqs below are readable rather than magic: the
  // attestation, the registration, the request, then the three refusals.
  assert.deepEqual(
    logRecords(dir).map((record) => record["event"]),
    [
      "policy.updated",
      "task.registered",
      "approval.requested",
      "audit.decision_refused",
      "audit.decision_refused",
      "audit.gesture_refused",
    ],
  );

  const { code, body } = statusJson(dir);
  assert.deepEqual(refusals(body), {
    decision: {
      count: 2,
      // Newest first: the reason to read the row is what just happened.
      recent: [
        { seq: 5, code: "reaction-note-required" },
        { seq: 4, code: "reaction-note-required" },
      ],
    },
    gesture: {
      count: 1,
      // The observed account, in the form the record carries it. A terminal
      // decision authenticates no sender, which is why the two decision
      // entries above carry none.
      recent: [{ seq: 6, code: "sender-unmapped", sender: GESTURE_SENDER }],
    },
  });
  // AC2: informational. Three refusals, and the repository is still healthy and
  // still exit 0, because a refusal is the gate having worked.
  assert.equal(body["healthy"], true);
  assert.equal(code, 0);
  assertClean(dir);
});

test("a refusal-bearing status object validates against the registry's own schema", () => {
  // The both-directions pin of `tests/cli-instructions.test.ts` (APRV-85), for
  // the one field its live world cannot reach: that world refuses nothing, so
  // the shape it validates is the shape with no `refusals` key. A declared field
  // no captured output ever carries is a declaration nothing checks.
  const dir = ready();
  requestChaser(dir);
  refuseDecision(dir);
  refuseGesture(dir);

  const spec = VERB_REGISTRY.find((candidate) => verbLabel(candidate) === "status");
  assert.ok(spec !== undefined, "the registry lost its status entry");
  assert.ok(spec.output !== null, "the status entry declares no output shape");
  const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: true });
  addFormats(ajv);
  const validate = ajv.compile(spec.output);
  const { body } = statusJson(dir);
  assert.equal(
    validate(body),
    true,
    (validate.errors ?? [])
      .map((error) => `${error.instancePath || "/"} ${error.keyword}: ${error.message ?? ""}`)
      .join("; "),
  );
});

test("the human rendering names both families, their counts, and the account", () => {
  const dir = ready();
  requestChaser(dir);
  refuseDecision(dir);
  refuseGesture(dir);

  const run = runCli(["status"], dir);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /^refusals {2,}1 decision, 1 gesture \(reported; health unaffected\)$/mu);
  assert.match(run.stdout, /^ +decision {2}seq 4 {2}reaction-note-required$/mu);
  assert.match(run.stdout, /^ +gesture\s+seq 5 {2}sender-unmapped {2}telegram:5551234567$/mu);
  assert.ok(!run.stdout.includes(""));
});

test("a keyed sender is reported as the digest the record carries, marked as one", () => {
  const dir = ready();
  // The form APRV-370 records a keyed mapping in: the whole `hmac-sha256:<hex>`
  // string, which is what the write boundary's own pattern accepts.
  const keyed = `hmac-sha256:${"a".repeat(64)}`;
  const result = recordRefusedGesture(
    logPath(dir),
    {
      gesture: "review",
      actor: null,
      channel: "telegram",
      sender: { channel: "telegram", id: keyed, hashed: true },
    },
    { code: "sender-key-unavailable", message: "no key for the mapping this policy declares" },
  );
  assert.equal(result.ok, true, JSON.stringify(result));

  const { body } = statusJson(dir);
  assert.deepEqual((refusals(body) as { gesture: unknown }).gesture, {
    count: 1,
    recent: [
      {
        // The attestation, the registration, then this.
        seq: 3,
        code: "sender-key-unavailable",
        sender: { channel: "telegram", id: keyed, hashed: true },
      },
    ],
  });
  const run = runCli(["status"], dir);
  // The digest verbatim, and marked, so a reader knows to re-key rather than to
  // go looking for the account in a chat client.
  assert.match(run.stdout, /sender-key-unavailable {2}telegram:hmac-sha256:a{64} \(keyed\)$/mu);
  assertClean(dir);
});

test("one family present reports that family alone, never a zero for the other", () => {
  // Decisions only.
  const decided = ready();
  requestChaser(decided);
  refuseDecision(decided);
  const decidedBody = statusJson(decided).body;
  assert.deepEqual(Object.keys(refusals(decidedBody) ?? {}), ["decision"]);
  assert.equal("gesture" in (refusals(decidedBody) ?? {}), false);
  const decidedText = runCli(["status"], decided);
  assert.match(decidedText.stdout, /^refusals {2,}1 decision \(/mu);
  assert.ok(!decidedText.stdout.includes("gesture"));

  // Gestures only. No request is needed: a gesture is not a decision, and it
  // answers for a chain head rather than for an action.
  const gestured = ready();
  refuseGesture(gestured);
  const gesturedBody = statusJson(gestured).body;
  assert.deepEqual(Object.keys(refusals(gesturedBody) ?? {}), ["gesture"]);
  assert.equal("decision" in (refusals(gesturedBody) ?? {}), false);
  const gesturedText = runCli(["status"], gestured);
  assert.match(gesturedText.stdout, /^refusals {2,}1 gesture \(/mu);
  assert.ok(!gesturedText.stdout.includes("decision"));
  assertClean(gestured);
});

test("a log with neither family omits the field and the row entirely", () => {
  const dir = ready();
  requestChaser(dir);
  const { code, body } = statusJson(dir);
  assert.equal(code, 0);
  // Not `{}`, not zeros: absent. The frozen-shape test above pins the whole
  // object; this pins the reason it is still that object.
  assert.equal("refusals" in body, false);
  const run = runCli(["status"], dir);
  assert.ok(!run.stdout.includes("refusals"));
});

test("the listing is capped at five while the count keeps counting", () => {
  const dir = ready();
  requestChaser(dir);
  for (let index = 0; index < 6; index += 1) refuseDecision(dir);

  const { code, body } = statusJson(dir);
  assert.equal(code, 0);
  const family = (refusals(body) as { decision: { count: number; recent: { seq: number }[] } })
    .decision;
  assert.equal(family.count, 6);
  assert.equal(family.recent.length, 5);
  // Seqs 4 through 9 were appended; the newest five, newest first.
  assert.deepEqual(
    family.recent.map((entry) => entry.seq),
    [9, 8, 7, 6, 5],
  );
  assertClean(dir);
});

test("an unverifiable log reports no refusals rather than ones it cannot stand behind", () => {
  const dir = ready();
  requestChaser(dir);
  refuseDecision(dir);
  refuseGesture(dir);
  assert.notEqual(refusals(statusJson(dir).body), undefined);

  // A tampered line: the chain no longer verifies, so every projection over it
  // is empty (SPEC.md §11.1 invariant 1). The refusal field goes with them.
  const lines = rawLog(dir).split("\n").filter((line) => line.trim().length > 0);
  lines[2] = (lines[2] as string).replace('"approval.requested"', '"task.registered"');
  writeFileSync(logPath(dir), `${lines.join("\n")}\n`, "utf8");

  const { code, body } = statusJson(dir);
  assert.equal(code, 1, "a log that does not verify is not healthy");
  assert.notEqual(body["verification"], undefined);
  assert.notEqual((body["verification"] as { status: string }).status, "clean");
  assert.equal("refusals" in body, false);
});

// ===========================================================================
// dangling executions: status shows them, queue never does
// ===========================================================================

test("a dangling execution appears in status, never in queue, and nothing repairs it", () => {
  const dir = ready();
  requestChaser(dir);
  const token = grant(dir, "task-042:chaser");

  // `approval consume` starts the execution and, by design, never finishes it —
  // the same state a crash between started and its outcome leaves behind.
  assert.equal(
    runCli(
      ["consume", "task-042:chaser", "--payload-hash", bindingFor(dir), "--token", token, "--as", "agent:claude"],
      dir,
    ).code,
    0,
  );

  const dangled = statusJson(dir);
  assert.equal(dangled.code, 1);
  assert.equal(dangled.body["healthy"], false);
  const startedSeq = logRecords(dir).findIndex(
    (record) => record["event"] === "execution.started",
  ) + 1;
  assert.deepEqual(dangled.body["dangling"], [
    {
      action_key: "task-042:chaser",
      task: "task-042",
      ts: String(logRecords(dir)[startedSeq - 1]?.["ts"]),
      seq: startedSeq,
    },
  ]);
  assert.deepEqual(queueJson(dir).body, { ok: true, pending: [] });

  // The human recovery, through the same CLI: nothing else changes the state.
  const before = rawLog(dir);
  assert.equal(statusJson(dir).code, 1, "status changed the state");
  assert.equal(rawLog(dir), before, "status wrote to the log");
});

// ===========================================================================
// loop escalation in status
// ===========================================================================

test("three consecutive failures raise a loop escalation in status; a completion clears it", () => {
  const dir = ready();
  runSupervised(dir, "task-042:draft", 1);
  runSupervised(dir, "task-042:draft2", 1);
  assert.deepEqual(statusJson(dir).body["loop_escalations"], []);
  runSupervised(dir, "task-042:draft3", 1);

  const escalated = statusJson(dir);
  assert.equal(escalated.code, 1);
  // APRV-145: the entry keeps the three fields every consumer already read and
  // gains `scope`, which names the derivation that produced the key in `task`.
  const rows = escalated.body["loop_escalations"] as Record<string, unknown>[];
  assert.deepEqual(
    rows.map((entry) => [
      entry["task"],
      entry["scope"],
      entry["consecutive_failures"],
      entry["escalated"],
    ]),
    [["task-042", "task", 3, true]],
  );
  // APRV-280: the row says what clears it, and says it in the amended terms —
  // only a completion in a class that has side effects.
  assert.match(
    String(rows[0]?.["clears"]),
    /an execution\.completed for task task-042 in a class that has side effects/u,
  );
  // These executions are `approval run`'s own, so none of them is a harness
  // start and the coverage row is all zeroes.
  assert.deepEqual(escalated.body["harness_outcomes"], {
    started: 0,
    reported: 0,
    unreported: 0,
  });

  // The manual path still works for the escalated task — escalation is a floor.
  requestChaser(dir);
  assert.equal(queueJson(dir).body["pending"] instanceof Array, true);
  const token = grant(dir, "task-042:chaser");
  const ran = runCli(
    ["run", "task-042:chaser", "--token", token, "--as", "agent:claude", "--", ...CHILD],
    dir,
  );
  assert.equal(ran.code, 0, ran.stderr);
  // That completion is for the same task, so the streak resets.
  assert.deepEqual(statusJson(dir).body["loop_escalations"], []);
  assertClean(dir);
});

// ===========================================================================
// approval queue — the inbox and nothing else
// ===========================================================================

test("queue lists exactly the live awaiting requests, with the TTL remaining", () => {
  const dir = ready();
  requestChaser(dir);
  requestChaser(dir, "task-042:followup");

  const { code, body } = queueJson(dir);
  assert.equal(code, 0);
  const pending = body["pending"] as Record<string, unknown>[];
  assert.equal(pending.length, 2);
  assert.deepEqual(
    pending.map((entry) => entry["action_key"]),
    ["task-042:chaser", "task-042:followup"],
  );
  const first = pending[0] as Record<string, unknown>;
  assert.equal(first["task"], "task-042");
  assert.equal(first["class"], "communicate.email.external");
  assert.equal(first["est_cost_usd"], "0.02");
  assert.equal(first["seq"], 3);
  assert.equal(typeof first["requested_ts"], "string");
  const remaining = first["ttl_remaining_ms"] as number;
  assert.ok(remaining > 0 && remaining <= 3_600_000, `ttl_remaining_ms out of range: ${remaining}`);
});

test("a decided request leaves the queue; an empty inbox is still exit 0", () => {
  const dir = ready();
  requestChaser(dir);
  assert.equal((queueJson(dir).body["pending"] as unknown[]).length, 1);

  grant(dir, "task-042:chaser");
  const after = queueJson(dir);
  assert.equal(after.code, 0);
  assert.deepEqual(after.body, { ok: true, pending: [] });

  const empty = runCli(["queue"], dir);
  assert.equal(empty.code, 0);
  assert.match(empty.stdout, /queue: empty/u);
});

test("queue on a fresh directory with no log at all is empty and exits 0", () => {
  const dir = caseDir();
  const run = runCli(["queue", "--json"], dir);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { ok: true, pending: [] });
});

test("a supervised action never enters the queue: it has no request to decide", () => {
  const dir = ready();
  runSupervised(dir, "task-042:draft", 0);
  assert.deepEqual(queueJson(dir).body, { ok: true, pending: [] });
  assertClean(dir);
});

// ===========================================================================
// usage and help
// ===========================================================================

test("status and queue reject unexpected positionals at exit 2", () => {
  const dir = ready();
  assert.equal(runCli(["status", "extra"], dir).code, 2);
  assert.equal(runCli(["queue", "extra"], dir).code, 2);
});

for (const [name, args] of [
  ["status", ["status", "--help"]],
  ["queue", ["queue", "--help"]],
] as Array<[string, string[]]>) {
  test(`help: ${name} --help documents the codes and the JSON shape`, () => {
    const dir = caseDir();
    const run = runCli(args, dir);
    assert.equal(run.code, 0);
    assert.equal(run.stderr, "");
    assert.match(run.stdout, /Usage:/u);
    // APRV-91: the frozen table is printed by `approval --help` alone.
    assert.match(run.stdout, /exit codes: approval --help/u);
    assert.match(run.stdout, /JSON shape/u);
  });
}

test("help: the status/queue distinction is stated in both help texts and at the root", () => {
  const dir = caseDir();
  assert.match(runCli(["queue", "--help"], dir).stdout, /THIS IS AN INBOX, NOT A DASHBOARD/u);
  assert.match(runCli(["status", "--help"], dir).stdout, /THIS IS NOT "approval queue"/u);
  const root = runCli(["--help"], dir).stdout;
  assert.match(root, /queue {5}the pending-decision INBOX/u);
  assert.match(root, /status {4}system HEALTH/u);
});
