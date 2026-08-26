/**
 * A gate verdict whose event cannot be appended is a refusal (APRV-123,
 * SPEC.md §11.1 invariant 8).
 *
 * The doctrine, stated plainly: never authorize an action we cannot account
 * for. Every surface of this runtime that says "proceed" or hands back a token
 * does so on the strength of a record in the log, and the record has to be
 * there. If the append fails — another writer holds the lock, the disk refuses
 * the write, the schema refuses the record — the caller MUST receive a refusal
 * with a stable machine-readable code, never a success whose event is missing.
 *
 * Compare-and-append (invariant 5) gave us this implicitly on every path that
 * existed when this file was written: the audit for APRV-123 found no surface
 * computing a verdict and returning it before the append, so nothing here fixes
 * a bug. What it fixes is that the property was true by construction and stated
 * nowhere, testable by nobody, and therefore free to stop being true the next
 * time someone adds a path. This file is the pin.
 *
 * ## How the failure is injected
 *
 * Three ways, all through the real append path, none of them hand-writing a log
 * line:
 *
 *  - **lock contention.** `<log>.lock` is held by an outside party, exactly as
 *    `tests/log.test.ts` holds it, and the append gives up with `lock-timeout`.
 *  - **schema refusal at the write boundary.** A copy of `schema/` with one
 *    event type struck from the enum, so the record the surface builds is
 *    refused by `validate` before a byte reaches the file (`validation`).
 *  - **disk error.** The log directory is made unwritable, so the lockfile
 *    cannot be created at all (`io`).
 *
 * Whatever the mechanism, the assertion is the same on every surface: the
 * result is a refusal, its code is the pinned `append-failed`, the underlying
 * append error rides along for diagnosis, and the log is byte-identical to what
 * it was before the attempt.
 */

import assert from "node:assert/strict";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  consumeHarnessGrant,
  decide,
  register,
  request,
  consumeToken,
  startExecution,
  appendAttestation,
} from "./clock-adapters.js";
import { GATE_REFUSAL_CODES, type GateOptions } from "../src/core/gate.js";
import { EXECUTE_REFUSAL_CODES } from "../src/core/execute.js";
import { TOKEN_REFUSAL_CODES } from "../src/core/token.js";
import { HOOK_DENY_CODES } from "../src/cli/hook.js";
import { APPEND_ERROR_CODES } from "../src/core/log.js";
import { verify } from "../src/core/verify.js";

/**
 * The one code every surface here returns. It is not a new word: it is already
 * a member of the three frozen refusal unions, which the first test asserts, so
 * a caller branching on it is branching on pinned public API.
 */
const APPEND_REFUSAL = "append-failed";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
const SCHEMA_DIR = join(REPO_ROOT, "schema");

const scratch = mkdtempSync(join(tmpdir(), "approval-md-evidence-"));
let counter = 0;

after(() => {
  // Restore anything a disk-error case left unwritable, or the cleanup fails.
  for (const entry of readdirSync(scratch)) {
    const logDir = join(scratch, entry, ".approval", "log");
    if (existsSync(logDir)) chmodSync(logDir, 0o755);
  }
  rmSync(scratch, { recursive: true, force: true });
});

const T0 = "2026-08-05T10:00:00.000Z";

function at(minutes: number): string {
  return new Date(Date.parse(T0) + minutes * 60_000).toISOString();
}

const PAYLOAD_HASH = "2".repeat(64);

const POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "4h"',
  "  on_expiry: reject",
  "classes:",
  "  read.*:",
  "    autonomy: autonomous",
  "  communicate.email.external:",
  "    autonomy: manual",
  "  financial.spend:",
  "    autonomy: manual",
  "    limits:",
  "      per_action_usd: 0.5",
  "```",
  "",
].join("\n");

const ENVELOPE = {
  origin: { app: "example-capture", created_by: "human:carter" },
  state: "proposed",
  actions: [
    {
      class: "communicate.email.external",
      summary: "Send deposit chaser",
      reversible: false,
      est_cost_usd: 0.02,
      idempotency_key: "task-042:chaser",
      payload_hash: PAYLOAD_HASH,
    },
    {
      class: "read.file",
      summary: "Read the ledger",
      reversible: true,
      est_cost_usd: 0,
      idempotency_key: "task-042:peek",
      // APRV-140: an autonomous action binds to bytes as well. There is no
      // grant on this path, so the declaration is the whole of what authorizes.
      payload_hash: PAYLOAD_HASH,
    },
    {
      class: "financial.spend",
      summary: "Pay the invoice",
      reversible: false,
      est_cost_usd: 5,
      idempotency_key: "task-042:pay",
      payload_hash: PAYLOAD_HASH,
    },
  ],
};

interface Case {
  dir: string;
  logPath: string;
  policyPath: string;
  options: GateOptions;
}

function newCase(): Case {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  const policyPath = join(dir, "APPROVAL.md");
  writeFileSync(policyPath, POLICY, "utf8");
  return {
    dir,
    logPath: join(dir, ".approval", "log", "events.jsonl"),
    policyPath,
    options: { policy: { file: policyPath } },
  };
}

/** Attested and registered: the state every surface below starts from. */
function ready(): Case {
  const unit = newCase();
  const attested = appendAttestation(unit.logPath, unit.policyPath, "human:carter", T0);
  assert.equal(attested.ok, true, "attestation append failed");
  const registered = register(
    unit.logPath,
    { task: "task-042", envelope: ENVELOPE },
    at(1),
    "agent:claude",
    unit.options,
  );
  assert.equal(registered.ok, true, registered.ok ? "" : registered.message);
  return unit;
}

function rawLog(unit: Case): string {
  return existsSync(unit.logPath) ? readFileSync(unit.logPath, "utf8") : "";
}

function assertClean(unit: Case): void {
  const result = verify(unit.logPath);
  assert.equal(result.status, "clean", `log not clean: ${JSON.stringify(result)}`);
}

/**
 * Assert `value` is the refusal this invariant requires: `append-failed`, with
 * the writer's own error attached and one of its pinned codes.
 */
function assertAppendRefusal(
  value: { ok: boolean },
  expectedAppendCode: (typeof APPEND_ERROR_CODES)[number],
  label: string,
): void {
  assert.equal(value.ok, false, `${label}: expected a refusal, got a success`);
  const refusal = value as { code?: unknown; append?: { code?: unknown }; token?: unknown };
  assert.equal(refusal.code, APPEND_REFUSAL, `${label}: refusal code`);
  assert.equal(refusal.append?.code, expectedAppendCode, `${label}: underlying append error`);
  // No surface may hand back an authorization alongside the refusal.
  assert.equal(refusal.token, undefined, `${label}: a refusal carries no token`);
}

// ---------------------------------------------------------------------------
// The three injections
// ---------------------------------------------------------------------------

/** Run `body` while an outside party holds the append lock. */
function underHeldLock<T>(unit: Case, body: () => T): T {
  mkdirSync(dirname(unit.logPath), { recursive: true });
  const lock = `${unit.logPath}.lock`;
  closeSync(openSync(lock, "wx"));
  try {
    return body();
  } finally {
    unlinkSync(lock);
  }
}

/** Lock options tight enough that a held lock fails fast. */
const IMPATIENT = { lockTimeoutMs: 60, lockRetryMs: 5 } as const;

/**
 * A copy of `schema/` with `eventType` struck from `event.schema.json`'s enum,
 * so a record of that type is refused at the write boundary.
 *
 * The rest of the schema is the real one, copied byte for byte: the refusal
 * being exercised is the write boundary's own, not a stub standing in for it.
 */
function schemaDirRejecting(eventType: string): string {
  counter += 1;
  const dir = join(scratch, `schema-${counter}`);
  mkdirSync(dir, { recursive: true });
  for (const entry of readdirSync(SCHEMA_DIR)) {
    if (!entry.endsWith(".json")) continue;
    copyFileSync(join(SCHEMA_DIR, entry), join(dir, entry));
  }
  const path = join(dir, "event.schema.json");
  const schema = JSON.parse(readFileSync(path, "utf8")) as {
    properties: { event: { enum: string[] } };
  };
  const enumeration = schema.properties.event.enum;
  const index = enumeration.indexOf(eventType);
  assert.notEqual(index, -1, `${eventType} is not in the event enum`);
  enumeration.splice(index, 1);
  writeFileSync(path, JSON.stringify(schema, null, 2), "utf8");
  return dir;
}

/** Run `body` with the log's directory unwritable, so no lockfile can be made. */
function underUnwritableLogDir<T>(unit: Case, body: () => T): T {
  const logDir = dirname(unit.logPath);
  mkdirSync(logDir, { recursive: true });
  chmodSync(logDir, 0o555);
  try {
    return body();
  } finally {
    chmodSync(logDir, 0o755);
  }
}

/** Root ignores the mode bits, so the disk-error injection cannot bite there. */
const CAN_DENY_WRITES = (process.getuid?.() ?? 1) !== 0;

// ===========================================================================
// the code itself
// ===========================================================================

test("append-failed is a member of every refusal union a gate surface answers with", () => {
  assert.ok(GATE_REFUSAL_CODES.includes(APPEND_REFUSAL));
  assert.ok(EXECUTE_REFUSAL_CODES.includes(APPEND_REFUSAL));
  assert.ok(TOKEN_REFUSAL_CODES.includes(APPEND_REFUSAL));
  // The hook flattens a gate refusal into `hook-gate-refused:<code>`, so its
  // half of the pair is pinned in its own union.
  assert.ok(HOOK_DENY_CODES.includes("hook-gate-refused"));
});

// ===========================================================================
// surface: manual request intake (approval.requested)
// ===========================================================================

const CHASER_REQUEST = {
  task: "task-042",
  actionKey: "task-042:chaser",
  payload_hash: PAYLOAD_HASH,
  cls: "communicate.email.external",
  est_cost_usd: 0.02,
  reversible: false,
  summary: "Send deposit chaser",
} as const;

test("request intake: a request whose event cannot be appended is refused, and nothing is pending", () => {
  const unit = ready();
  const before = rawLog(unit);

  const refused = underHeldLock(unit, () =>
    request(unit.logPath, { ...CHASER_REQUEST }, at(2), "agent:claude", {
      ...unit.options,
      append: { ...IMPATIENT },
    }),
  );
  assertAppendRefusal(refused, "lock-timeout", "request");
  assert.equal(rawLog(unit), before, "a refused intake writes nothing");

  // The proof that this is a refusal and not a silent success: no approver has
  // anything to answer, and the same request still works once the lock clears.
  const retried = request(unit.logPath, { ...CHASER_REQUEST }, at(3), "agent:claude", unit.options);
  assert.equal(retried.ok, true, retried.ok ? "" : retried.message);
  assertClean(unit);
});

test("request intake: a schema refusal at the write boundary is also append-failed", () => {
  const unit = ready();
  const before = rawLog(unit);

  const refused = request(unit.logPath, { ...CHASER_REQUEST }, at(2), "agent:claude", {
    ...unit.options,
    schemaDir: schemaDirRejecting("approval.requested"),
  });
  assertAppendRefusal(refused, "validation", "request/schema");
  assert.equal(rawLog(unit), before);
  assertClean(unit);
});

test("request intake: a disk error is also append-failed", { skip: !CAN_DENY_WRITES }, () => {
  const unit = ready();
  const before = rawLog(unit);

  const refused = underUnwritableLogDir(unit, () =>
    request(unit.logPath, { ...CHASER_REQUEST }, at(2), "agent:claude", unit.options),
  );
  assertAppendRefusal(refused, "io", "request/io");
  assert.equal(rawLog(unit), before);
  assertClean(unit);
});

// ===========================================================================
// surface: grant recording and token minting (approval.granted)
// ===========================================================================

test("grant: a grant whose event cannot be appended mints nothing and returns no token", () => {
  const unit = ready();
  assert.equal(
    request(unit.logPath, { ...CHASER_REQUEST }, at(2), "agent:claude", unit.options).ok,
    true,
  );
  const before = rawLog(unit);

  const refused = underHeldLock(unit, () =>
    decide(unit.logPath, "task-042:chaser", "grant", "human:carter", at(3), {
      ...unit.options,
      append: { ...IMPATIENT },
    }),
  );
  assertAppendRefusal(refused, "lock-timeout", "grant");
  assert.equal(rawLog(unit), before, "a refused grant writes nothing");

  // The token seam mints immediately before the append. A minted-but-unrecorded
  // token would be a live credential the log never saw; there is none, and the
  // request is still undecided.
  const granted = decide(unit.logPath, "task-042:chaser", "grant", "human:carter", at(4), unit.options);
  assert.equal(granted.ok, true, granted.ok ? "" : granted.message);
  if (!granted.ok) throw new Error("unreachable");
  assert.equal(typeof granted.token, "string");
  assertClean(unit);
});

test("grant: a schema refusal at the write boundary is also append-failed", () => {
  const unit = ready();
  assert.equal(
    request(unit.logPath, { ...CHASER_REQUEST }, at(2), "agent:claude", unit.options).ok,
    true,
  );
  const before = rawLog(unit);

  const refused = decide(unit.logPath, "task-042:chaser", "grant", "human:carter", at(3), {
    ...unit.options,
    schemaDir: schemaDirRejecting("approval.granted"),
  });
  assertAppendRefusal(refused, "validation", "grant/schema");
  assert.equal(rawLog(unit), before);
  assertClean(unit);
});

// ===========================================================================
// surface: token consumption — `approval run` on the manual path
// ===========================================================================

test("token consumption: a failed execution.started leaves the token live and spends nothing", () => {
  const unit = ready();
  assert.equal(
    request(unit.logPath, { ...CHASER_REQUEST }, at(2), "agent:claude", unit.options).ok,
    true,
  );
  const granted = decide(unit.logPath, "task-042:chaser", "grant", "human:carter", at(3), unit.options);
  assert.equal(granted.ok, true, granted.ok ? "" : granted.message);
  if (!granted.ok || granted.token === undefined) throw new Error("expected a token");
  const before = rawLog(unit);

  const refused = underHeldLock(unit, () =>
    consumeToken(unit.logPath, "task-042:chaser", granted.token as string, at(4), "agent:claude", {
      policyFile: unit.policyPath,
      presentedPayloadHash: PAYLOAD_HASH,
      append: { ...IMPATIENT },
    }),
  );
  assertAppendRefusal(refused, "lock-timeout", "consume");
  assert.equal(rawLog(unit), before, "a refused consumption writes nothing");

  // A spend the log did not record is not a spend: the token is still live and
  // the one execution it authorizes is still available.
  const spent = consumeToken(
    unit.logPath,
    "task-042:chaser",
    granted.token,
    at(5),
    "agent:claude",
    { policyFile: unit.policyPath, presentedPayloadHash: PAYLOAD_HASH },
  );
  assert.equal(spent.ok, true, spent.ok ? "" : spent.message);
  assertClean(unit);
});

// ===========================================================================
// surface: supervised/autonomous execution start (execution.started)
// ===========================================================================

test("execution start: an autonomous action whose start cannot be recorded does not start", () => {
  const unit = ready();
  const before = rawLog(unit);

  const refused = underHeldLock(unit, () =>
    startExecution(
      unit.logPath,
      "task-042:peek",
      {
        policy: { file: unit.policyPath },
        presentedPayloadHash: PAYLOAD_HASH,
        append: { ...IMPATIENT },
      },
      at(2),
      "agent:claude",
    ),
  );
  assertAppendRefusal(refused, "lock-timeout", "start");
  assert.equal(rawLog(unit), before, "a refused start writes nothing");

  // This is the surface that accounts for the autonomous path: `request` writes
  // no approval.* event for it (amended SPEC.md §6.3), so `execution.started`
  // is the whole of the record, and a start nobody could record is not a start.
  const started = startExecution(
    unit.logPath,
    "task-042:peek",
    { policy: { file: unit.policyPath }, presentedPayloadHash: PAYLOAD_HASH },
    at(3),
    "agent:claude",
  );
  assert.equal(started.ok, true, started.ok ? "" : started.message);
  assertClean(unit);
});

test("execution start: a schema refusal at the write boundary is also append-failed", () => {
  const unit = ready();
  const before = rawLog(unit);

  const refused = startExecution(
    unit.logPath,
    "task-042:peek",
    {
      policy: { file: unit.policyPath },
      presentedPayloadHash: PAYLOAD_HASH,
      schemaDir: schemaDirRejecting("execution.started"),
    },
    at(2),
    "agent:claude",
  );
  assertAppendRefusal(refused, "validation", "start/schema");
  assert.equal(rawLog(unit), before);
  assertClean(unit);
});

// ===========================================================================
// surface: harness grant consumption (the hook's `allow`, in-process)
// ===========================================================================

const HARNESS_REQUEST = { ...CHASER_REQUEST, execution: "harness" as const };

test("harness consumption: a grant whose spend cannot be recorded stays unspent", () => {
  const unit = ready();
  assert.equal(
    request(unit.logPath, { ...HARNESS_REQUEST }, at(2), "agent:claude", unit.options).ok,
    true,
  );
  const granted = decide(unit.logPath, "task-042:chaser", "grant", "human:carter", at(3), unit.options);
  assert.equal(granted.ok, true, granted.ok ? "" : granted.message);
  if (!granted.ok) throw new Error("unreachable");
  assert.equal(granted.token, undefined, "a harness grant mints no token");
  const before = rawLog(unit);

  const refused = underHeldLock(unit, () =>
    consumeHarnessGrant(unit.logPath, "task-042:chaser", "agent:claude", at(4), {
      ...unit.options,
      append: { ...IMPATIENT },
    }),
  );
  assertAppendRefusal(refused, "lock-timeout", "harness-consume");
  assert.equal(rawLog(unit), before, "a refused spend writes nothing");

  const spent = consumeHarnessGrant(unit.logPath, "task-042:chaser", "agent:claude", at(5), unit.options);
  assert.equal(spent.ok, true, spent.ok ? "" : spent.message);
  assertClean(unit);
});

// ===========================================================================
// surface: the hook's allow path, end to end
// ===========================================================================

/**
 * The hook is the surface where a missing record would do the most damage: it
 * answers a harness that is about to run a command, and its `allow` rests
 * entirely on `consumeHarnessGrant` having appended `execution.started` first.
 * Driven here as the harness drives it — a subprocess reading one PreToolUse
 * event on stdin — because the ordering under test is the CLI's, not the core's.
 */
test("hook: a grant it cannot spend is a deny, not an allow", () => {
  counter += 1;
  const dir = join(scratch, `hook-${counter}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "APPROVAL.md"),
    [
      "```yaml approval-policy",
      'version: "0.1"',
      "defaults:",
      "  autonomy: manual",
      '  approval_ttl: "4h"',
      "  on_expiry: reject",
      "classes:",
      "  deps.add:",
      "    autonomy: manual",
      "```",
      "",
    ].join("\n"),
    "utf8",
  );

  const runCli = (args: string[], input = ""): { code: number; stdout: string; stderr: string } => {
    const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, APPROVAL_HUMAN: "human:alice" },
      input,
    });
    assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
    return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  };

  const attested = runCli(["policy", "attest", "--as", "human:alice"]);
  assert.equal(attested.code, 0, attested.stderr);

  const toolEvent = (toolUseId: string): string =>
    JSON.stringify({
      session_id: "sess-evidence",
      transcript_path: "/dev/null",
      cwd: "/repo",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm install left-pad", description: "add a dependency" },
      tool_use_id: toolUseId,
    });

  // Open the question, let the wait lapse, and answer it late: APRV-117's
  // carryover leaves an unspent grant for the retry to carry.
  const first = runCli(
    ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
    toolEvent("tu-first"),
  );
  assert.equal(first.code, 0, first.stderr);
  const late = runCli(["grant", "hook:sess-evidence:tu-first:deps.add", "--as", "human:alice"]);
  assert.equal(late.code, 0, late.stderr);

  const logPath = join(dir, ".approval", "log", "events.jsonl");
  const before = readFileSync(logPath, "utf8");

  // The retry would carry the grant and allow. With the log locked it cannot
  // record the spend, so it denies — the hook never allows a command whose
  // authorization the log did not see being used.
  const lock = `${logPath}.lock`;
  closeSync(openSync(lock, "wx"));
  let retry: { code: number; stdout: string; stderr: string };
  try {
    retry = runCli(
      ["hook", "claude-code", "--timeout", "1s", "--interval", "100ms"],
      toolEvent("tu-retry"),
    );
  } finally {
    unlinkSync(lock);
  }

  assert.equal(retry.code, 0, `the hook exits 0 with a verdict: ${retry.stderr}`);
  const output = (JSON.parse(retry.stdout) as { hookSpecificOutput: Record<string, unknown> })
    .hookSpecificOutput;
  assert.equal(output["permissionDecision"], "deny");
  assert.match(String(output["permissionDecisionReason"]), /^hook-gate-refused:append-failed: /u);
  assert.equal(readFileSync(logPath, "utf8"), before, "a denied hook writes nothing");

  const verified = runCli(["log", "verify"]);
  assert.equal(verified.code, 0, `${verified.stdout}${verified.stderr}`);
});

// ===========================================================================
// the paths that append nothing, and why that is not a hole
// ===========================================================================

test("a budget refusal whose budget.exceeded cannot be appended is still a refusal", () => {
  const unit = ready();
  const before = rawLog(unit);

  // `financial.spend` is capped at $0.50 and this action declares $5. The
  // refusal is `budget-exceeded`, and it stays a refusal when the event
  // recording it cannot be written: a failed append may never soften a verdict.
  const refused = underHeldLock(unit, () =>
    request(
      unit.logPath,
      {
        task: "task-042",
        actionKey: "task-042:pay",
        payload_hash: PAYLOAD_HASH,
        cls: "financial.spend",
        est_cost_usd: 5,
        reversible: false,
        summary: "Pay the invoice",
      },
      at(2),
      "agent:claude",
      { ...unit.options, append: { ...IMPATIENT } },
    ),
  );
  assert.equal(refused.ok, false);
  const refusal = refused as { code?: unknown; message?: string; record?: unknown };
  assert.equal(refusal.code, "budget-exceeded");
  assert.equal(refusal.record, undefined, "no record is claimed when none was written");
  assert.match(String(refusal.message), /could not be appended/u);
  assert.equal(rawLog(unit), before);
  assertClean(unit);
});

test("the supervised/autonomous admission has no event to fail, and its record is the start", () => {
  const unit = ready();
  const before = rawLog(unit);

  // Amended SPEC.md §6.3: no `approval.*` event exists off the manual path, so
  // `request` returning proceed:true for an autonomous class appends nothing
  // and there is no append that could fail behind the caller's back. The
  // accounting for that path is `execution.started`, and the test above proves
  // a start that cannot be recorded does not happen. This test exists so that a
  // future path which starts writing here is caught by a failing assertion
  // rather than by nobody.
  const admitted = underHeldLock(unit, () =>
    request(
      unit.logPath,
      {
        task: "task-042",
        actionKey: "task-042:peek",
        cls: "read.file",
        est_cost_usd: 0,
        reversible: true,
        summary: "Read the ledger",
      },
      at(2),
      "agent:claude",
      { ...unit.options, append: { ...IMPATIENT } },
    ),
  );
  assert.equal(admitted.ok, true, admitted.ok ? "" : admitted.message);
  if (!admitted.ok) throw new Error("unreachable");
  assert.equal(admitted.proceed, true);
  assert.equal(admitted.autonomy, "autonomous");
  assert.equal(admitted.record, null, "the autonomous path records nothing here");
  assert.equal(rawLog(unit), before, "and writes nothing, lock or no lock");
  assertClean(unit);
});
