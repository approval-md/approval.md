/**
 * The dark-session detector (APRV-192).
 *
 * The claim under test is the reverse of APRV-42's: not "does every log entry
 * match git" but "does every piece of git activity have a log entry beside it".
 * The signal is an ABSENCE, so the suite is built to make absence provable:
 *
 * - Every log here is built through the REAL append path (`core/attest` for the
 *   attestation, `core/gate`'s register/request/decide for the grants,
 *   `core/payload-store` for the bound bytes) and read back through the real
 *   verifier. Nothing hand-writes a jsonl line. A detector whose "no records"
 *   verdict were proved against a fabricated log would have been proved against
 *   nothing at all.
 * - The git side is a fixture in the pure cases and a REAL scratch repository
 *   with a REAL linked worktree in the integration cases, so the observer's own
 *   parsing (worktree list, `--not <trunk>`, `--name-only`) is exercised rather
 *   than assumed.
 * - AC3's two incident shapes are replayed as named cases: the 2026-08-29
 *   SPEC.md edit in worktree `aprv-145-land`, and the 2026-08-30
 *   `.github/workflows/ci.yml` edit in `agent-a3f5d255372d43ac0`. Each is run
 *   twice — once with no record, which must be dark, and once with the grant
 *   the remediation actually made, which must not be.
 *
 * No git command in this file runs anywhere but inside a temp directory.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { appendAttestation } from "../src/core/attest.js";
import { commitGuardInputParts } from "../src/core/commit-guard.js";
import {
  DAEMON_EVIDENCE_EMAILS,
  DARK_SESSION_CODES,
  DARK_SESSION_VERDICTS,
  DARK_VERDICT_CODES,
  evaluateDarkSessions,
  observationKey,
  renderDarkSessionReport,
  SESSION_EVENTS,
  taskIdFromBranch,
  type DarkSessionInput,
  type GitActivity,
  type ObservedCheckout,
  type ObservedCommit,
} from "../src/core/dark-session.js";
import { decide, register, request } from "../src/core/gate.js";
import type { EventRecord } from "../src/core/log.js";
import { payloadHash } from "../src/core/payload.js";
import { loadPayload, payloadStoreDirFor } from "../src/core/payload-store.js";
import { evaluateProtectedPaths } from "../src/core/protected-path-guard.js";
import { DEFAULT_SCHEMA_DIR } from "../src/core/validate.js";
import { GIT_EVIDENCE_AUTHOR_EMAIL } from "../src/daemon/git-evidence.js";
import { verifyWithRecords } from "../src/core/verify.js";
import { at, fixedClock, newScenario, type Scenario } from "./scenario.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
/** dist/tests/…test.js -> the repository root, and the CI guard beside it. */
const GUARD_SCRIPT = fileURLToPath(new URL("../../scripts/protected-path-guard.mjs", import.meta.url));

const HUMAN = "human:carter";
const AGENT = "agent:claude-code";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-dark-session-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A policy that makes `policy.edit` manual and widens the protected set. */
const POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "1h"',
  "  on_expiry: reject",
  "policy:",
  "  protected_paths:",
  "    - SPEC.md",
  "classes:",
  "  read.*:",
  "    autonomy: autonomous",
  "  files.write.*:",
  "    autonomy: autonomous",
  "  policy.edit:",
  "    autonomy: manual",
  "```",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// Fixtures: the log half
// ---------------------------------------------------------------------------

interface World {
  unit: Scenario;
  /** The live payload store, as the sweep would resolve it. */
  store: Map<string, unknown>;
}

function world(): World {
  counter += 1;
  const unit = newScenario(join(scratch, `logs-${counter}`), POLICY);
  const attested = appendAttestation(unit.logPath, unit.policyPath, HUMAN, {
    clock: fixedClock(at(0)),
  });
  assert.equal(attested.ok, true, JSON.stringify(attested));
  return { unit, store: new Map() };
}

/**
 * Register, request and grant one action of `cls`, bound to `material`.
 *
 * Parameterized by class since APRV-266: a routed `protected_paths` entry
 * means the class on the record is the sub-class the hook asked about, and a
 * helper that could only mint `policy.edit` could not build that log.
 */
function grantOfClass(
  unit: World,
  key: string,
  cls: string,
  material: unknown,
  // APRV-369: `null` means the real clock. The integration fixtures below make
  // real git commits at the real instant, and the guard's recency bound is
  // measured against the commit's own date, so a grant frozen at T0 in 2026-08
  // would be a month stale the moment it was written.
  minute: number | null,
): EventRecord {
  const clockAt = (offset: number): { clock?: () => string } =>
    minute === null ? {} : { clock: fixedClock(at(offset)) };
  const hash = payloadHash(material);
  const task = `hook:${key}`;
  const actionKey = `${task}:${cls}`;

  const registered = register(
    unit.unit.logPath,
    {
      task,
      envelope: {
        origin: { app: "claude-code", created_by: AGENT },
        state: "proposed",
        actions: [
          {
            class: cls,
            summary: `Edit ${key}`,
            reversible: true,
            est_cost_usd: "0",
            idempotency_key: actionKey,
            payload_hash: hash,
          },
        ],
      },
    },
    AGENT,
    { ...unit.unit.options, ...clockAt(minute ?? 0) },
  );
  assert.equal(registered.ok, true, JSON.stringify(registered));

  const requested = request(
    unit.unit.logPath,
    {
      task,
      actionKey,
      cls,
      est_cost_usd: "0",
      summary: `Edit ${key}`,
      payload_hash: hash,
      payload: { value: material },
      execution: "harness",
    },
    AGENT,
    { ...unit.unit.options, ...clockAt(minute ?? 0) },
  );
  assert.equal(requested.ok, true, JSON.stringify(requested));

  const granted = decide(unit.unit.logPath, actionKey, "grant", HUMAN, {
    ...unit.unit.options,
    ...clockAt((minute ?? 0) + 1),
  });
  assert.equal(granted.ok, true, JSON.stringify(granted));
  if (!granted.ok) throw new Error("unreachable");

  unit.store.set(hash, material);
  return granted.record;
}

/** The `policy.edit` case, which is what most of this suite is about. */
function grantEdit(unit: World, key: string, material: unknown, minute: number): EventRecord {
  return grantOfClass(unit, key, "policy.edit", material, minute);
}

function verified(unit: World): EventRecord[] {
  const outcome = verifyWithRecords(unit.unit.logPath);
  assert.equal(outcome.result.status, "clean", JSON.stringify(outcome.result));
  return outcome.records;
}

// ---------------------------------------------------------------------------
// Fixtures: the git half
// ---------------------------------------------------------------------------

const PRIMARY = "/repo";
const WORKTREES = `${PRIMARY}/.claude/worktrees`;

function commit(overrides: Partial<ObservedCommit> = {}): ObservedCommit {
  return {
    sha: "a".repeat(40),
    ts: at(5),
    author: "Carter <soycarts@gmail.com>",
    authorEmail: "soycarts@gmail.com",
    changedPaths: ["src/core/gate.ts"],
    ref: "some-branch",
    ...overrides,
  };
}

function checkout(overrides: Partial<ObservedCheckout> = {}): ObservedCheckout {
  const name = overrides.name ?? "aprv-145-land";
  return {
    root: `${WORKTREES}/${name}`,
    name,
    primary: false,
    branch: name,
    born: at(1),
    commits: [commit()],
    ...overrides,
  };
}

function primaryCheckout(overrides: Partial<ObservedCheckout> = {}): ObservedCheckout {
  return {
    root: PRIMARY,
    name: "primary",
    primary: true,
    branch: "main",
    born: at(-10_000),
    commits: [],
    ...overrides,
  };
}

function inputFor(
  unit: World,
  checkouts: readonly ObservedCheckout[],
  overrides: Partial<DarkSessionInput> = {},
): DarkSessionInput {
  const activity: GitActivity = { checkouts, unavailable: null };
  return {
    activity,
    records: verified(unit),
    policyProtectedPaths: ["SPEC.md"],
    policyPath: "APPROVAL.md",
    policySha256: null,
    payloadFor: (hash) => unit.store.get(hash) ?? null,
    daemonEmails: [GIT_EVIDENCE_AUTHOR_EMAIL],
    window: { from: at(0), to: at(60) },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The frozen vocabulary (SPEC.md §11.1 invariant 6)
// ---------------------------------------------------------------------------

/**
 * The `code` enum the event schema puts on an `audit.dark_session` record.
 *
 * Found by walking to the `audit.dark_session` branch of the event schema's
 * per-type constraints rather than by a path constant, so a restructure of the
 * schema is a test failure rather than a silently empty assertion.
 */
function schemaDarkCodes(schema: Record<string, unknown>): string[] {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const fields = node as Record<string, unknown>;
    const condition = fields["if"] as Record<string, unknown> | undefined;
    const matched = condition?.["properties"] as Record<string, Record<string, unknown>> | undefined;
    if (matched?.["event"]?.["const"] === "audit.dark_session") {
      const consequent = fields["then"] as Record<string, unknown> | undefined;
      const properties = consequent?.["properties"] as Record<string, Record<string, unknown>> | undefined;
      const payload = properties?.["payload"] as Record<string, unknown> | undefined;
      const payloadProperties = payload?.["properties"] as
        | Record<string, Record<string, unknown>>
        | undefined;
      const code = payloadProperties?.["code"]?.["enum"];
      if (Array.isArray(code)) found.push(...(code as string[]));
    }
    for (const value of Object.values(fields)) walk(value);
  };
  walk(schema);
  assert.notEqual(found.length, 0, "the event schema no longer constrains audit.dark_session.code");
  return found;
}

test("the verdict and code unions are frozen public API, listed", () => {
  assert.deepEqual([...DARK_SESSION_VERDICTS], ["hooked", "dark", "exempt", "undetermined"]);
  assert.deepEqual(
    [...DARK_SESSION_CODES],
    [
      "no-records",
      "no-evidence",
      // APRV-369. The same failure and the same `dark` verdict as
      // `no-evidence`, under its own code because every failing commit reached
      // the checkout through a merge: the row names the checkout that synced
      // the change rather than the one that made it, and the repair is in the
      // branch the commit came from.
      "no-evidence-merged",
      "evidence-surface",
      "daemon-authored",
      "primary-checkout",
      "log-unverified",
      "git-unavailable",
      "payload-unresolvable",
      "activity-undated",
    ],
  );
  // APRV-369, and APRV-358's lesson applied here: the codes a `dark` verdict
  // can carry are exactly the enum the event schema accepts on an
  // `audit.dark_session` record. A code the sweep can produce and the write
  // boundary refuses is an observation that never reaches a human, and nothing
  // fails loudly when it happens.
  const schema = JSON.parse(
    readFileSync(join(DEFAULT_SCHEMA_DIR, "event.schema.json"), "utf8"),
  ) as Record<string, unknown>;
  const recorded = schemaDarkCodes(schema);
  assert.deepEqual([...recorded].sort(), [...DARK_VERDICT_CODES].sort());
  for (const code of DARK_VERDICT_CODES) {
    assert.ok(
      (DARK_SESSION_CODES as readonly string[]).includes(code),
      `${code} is recordable but is not a dark-session code`,
    );
  }

  // The events a hooked session cannot avoid writing, named in one place.
  // APRV-214 adds `gate.bypassed`: a session running behind an open window
  // writes no request and no execution, and it is the opposite of dark — every
  // call it made is recorded, loudly, by a hook that fired.
  assert.deepEqual(
    [...SESSION_EVENTS],
    ["task.registered", "approval.requested", "execution.started", "gate.bypassed"],
  );
});

test("core's copy of the daemon's git identity is pinned to the daemon's own", () => {
  // `core/` must not import `daemon/`, so the address is spelled twice and this
  // is the joint that keeps the two spellings identical — the device
  // `APPROVALD_VERSION` uses for its own duplicate of the package version.
  assert.deepEqual([...DAEMON_EVIDENCE_EMAILS], [GIT_EVIDENCE_AUTHOR_EMAIL.toLowerCase()]);
});

test("the observation key names one subject in one state of the world", () => {
  assert.notEqual(observationKey("w", "sha1", "born"), observationKey("w", "sha2", "born"));
  assert.notEqual(observationKey("w", "sha1", "born"), observationKey("x", "sha1", "born"));
  assert.equal(observationKey("w", null, null), observationKey("w", null, null));
});

test("a branch name yields the task id it begins with, upper-cased", () => {
  assert.equal(taskIdFromBranch("aprv-192-dark-session"), "APRV-192");
  assert.equal(taskIdFromBranch("APRV-42"), "APRV-42");
  assert.equal(taskIdFromBranch("main"), null);
  assert.equal(taskIdFromBranch(null), null);
});

// ---------------------------------------------------------------------------
// AC3: the two APRV-151 incident shapes
// ---------------------------------------------------------------------------

test("incident A (2026-08-29, SPEC.md in worktree aprv-145-land) is detected", () => {
  const unit = world();
  const report = evaluateDarkSessions(
    inputFor(unit, [
      checkout({
        name: "aprv-145-land",
        commits: [commit({ changedPaths: ["SPEC.md", "src/core/gate.ts"], ref: "aprv-145-land" })],
      }),
    ]),
  );
  assert.equal(report.ok, false, renderDarkSessionReport(report));
  const finding = report.findings[0];
  assert.equal(finding?.verdict, "dark");
  assert.equal(finding?.code, "no-evidence");
  assert.deepEqual(finding?.guardedPaths, ["SPEC.md"]);
  // The message states the log-lag ordering rule APRV-151's guard states, since
  // it is APRV-151's evaluator that produced the finding.
  assert.match(finding?.detail ?? "", /SPEC\.md/u);
  assert.match(renderDarkSessionReport(report), /DARK aprv-145-land \[no-evidence\]/u);
});

test("incident B (2026-08-30, ci.yml in worktree agent-a3f5d255372d43ac0) is detected", () => {
  const unit = world();
  const report = evaluateDarkSessions(
    inputFor(unit, [
      checkout({
        name: "agent-a3f5d255372d43ac0",
        commits: [commit({ changedPaths: [".github/workflows/ci.yml"] })],
      }),
    ]),
  );
  assert.equal(report.ok, false);
  const finding = report.findings[0];
  assert.equal(finding?.verdict, "dark");
  assert.equal(finding?.code, "no-evidence");
  assert.deepEqual(finding?.guardedPaths, [".github/workflows/ci.yml"]);
});

test("the same two edits, with the grant the remediation actually made, are not dark", () => {
  for (const [name, path] of [
    ["aprv-145-land", "SPEC.md"],
    ["agent-a3f5d255372d43ac0", ".github/workflows/ci.yml"],
  ] as const) {
    const unit = world();
    // The grant binds the CHANGE, and its `file` is absolute inside the
    // worktree, exactly as `cli/hook.ts` writes it.
    grantEdit(
      unit,
      name,
      { tool: "Edit", rule: "protected path", file: `${WORKTREES}/${name}/${path}`, before: "a", after: "b" },
      4,
    );
    const report = evaluateDarkSessions(
      inputFor(unit, [checkout({ name, commits: [commit({ changedPaths: [path] })] })]),
    );
    assert.equal(report.ok, true, renderDarkSessionReport(report));
    const finding = report.findings[0];
    assert.equal(finding?.verdict, "hooked", JSON.stringify(finding));
    // And the grant is what attributed the records to this worktree.
    assert.ok((finding?.attributed.length ?? 0) > 0, "no record was attributed");
  }
});

test("a routed protected path is guarded, and its own sub-class grant clears it (APRV-266)", () => {
  // The evaluator reads `policy.protected_paths` and now takes the routed
  // `{path, class}` form. Two things have to hold, and neither implies the
  // other: `design/` becomes GUARDED because the policy routes it, and the
  // grant that clears it carries the routed class rather than `policy.edit`.
  const routed = [{ path: "design/", class: "policy.edit.design" }];
  const material = {
    tool: "Edit",
    rule: "protected path",
    file: `${WORKTREES}/agent-routed/design/adr-1.md`,
    before: "a",
    after: "b",
  };
  const touched = () =>
    checkout({
      name: "agent-routed",
      commits: [commit({ changedPaths: ["design/adr-1.md"], ref: "agent-routed" })],
    });

  const dark = world();
  const before = evaluateDarkSessions(
    inputFor(dark, [touched()], { policyProtectedPaths: routed }),
  );
  assert.equal(before.ok, false, renderDarkSessionReport(before));
  assert.equal(before.findings[0]?.code, "no-evidence");
  assert.deepEqual(
    before.findings[0]?.guardedPaths,
    ["design/adr-1.md"],
    "a routed entry must widen the guarded set exactly as a bare string does",
  );

  const hooked = world();
  grantOfClass(hooked, "agent-routed", "policy.edit.design", material, 4);
  const after = evaluateDarkSessions(
    inputFor(hooked, [touched()], { policyProtectedPaths: routed }),
  );
  assert.equal(after.ok, true, renderDarkSessionReport(after));
  assert.equal(after.findings[0]?.verdict, "hooked");
});

// ---------------------------------------------------------------------------
// Arm B: silence, whatever was touched
// ---------------------------------------------------------------------------

test("a worktree with ordinary commits and not one attributable record is dark", () => {
  const unit = world();
  const report = evaluateDarkSessions(inputFor(unit, [checkout({ name: "agent-quiet" })]));
  const finding = report.findings[0];
  assert.equal(finding?.verdict, "dark");
  assert.equal(finding?.code, "no-records");
  assert.match(finding?.detail ?? "", /DARK SESSION/u);
  assert.match(finding?.detail ?? "", /harness-hook-wiring/u);
  // Nothing guarded was touched: this is the arm the CI-side guard cannot reach.
  assert.deepEqual(finding?.guardedPaths, []);
});

test("a worktree born inside the window with no commits at all is still dark", () => {
  const unit = world();
  const report = evaluateDarkSessions(
    inputFor(unit, [checkout({ name: "agent-newborn", commits: [], born: at(3) })]),
  );
  assert.equal(report.findings[0]?.verdict, "dark");
  assert.equal(report.findings[0]?.code, "no-records");
});

test("a worktree with no commits and no birth owes the log nothing", () => {
  const unit = world();
  const report = evaluateDarkSessions(
    inputFor(unit, [checkout({ name: "agent-idle", commits: [], born: null })]),
  );
  assert.equal(report.findings[0]?.verdict, "hooked");
  assert.equal(report.findings[0]?.code, null);
  assert.equal(report.ok, true);
});

test("a shell grant whose cwd is inside the worktree attributes the session to it", () => {
  const unit = world();
  grantEdit(unit, "agent-shell", { command: "git add -A", cwd: `${WORKTREES}/agent-shell` }, 4);
  const report = evaluateDarkSessions(inputFor(unit, [checkout({ name: "agent-shell" })]));
  assert.equal(report.findings[0]?.verdict, "hooked");
  assert.ok((report.findings[0]?.attributed.length ?? 0) > 0);
});

test("the branch name is a weak second key: it ADDS attribution and never removes it", () => {
  const unit = world();
  // A registration under the task the branch names, bound to material that
  // names no path at all — so only the branch key can place it.
  grantEdit(unit, "APRV-192:tool-1", { note: "no path anywhere" }, 4);
  const report = evaluateDarkSessions(
    inputFor(unit, [checkout({ name: "aprv-192-dark-session", branch: "aprv-192-dark-session" })]),
  );
  // The task id minted above is `hook:APRV-192:tool-1`, which does not begin
  // with APRV-192, so the branch key does NOT place it: the weak key is weak in
  // the safe direction and this worktree stays dark.
  assert.equal(report.findings[0]?.verdict, "dark");
});

// ---------------------------------------------------------------------------
// AC4: the human's own commits, and the daemon's
// ---------------------------------------------------------------------------

test("the primary checkout is exempt from arm B and still subject to arm A", () => {
  const unit = world();
  const report = evaluateDarkSessions(
    inputFor(unit, [primaryCheckout({ commits: [commit({ changedPaths: ["README.md"] })] })]),
  );
  const finding = report.findings[0];
  assert.equal(finding?.verdict, "exempt");
  assert.equal(finding?.code, "primary-checkout");
  assert.equal(report.ok, true);
  // The limit is STATED rather than silent, on the finding and on the report.
  assert.match(finding?.detail ?? "", /stated limit of this detector, not a clean bill/u);
  assert.match(report.coverage, /LINKED WORKTREES only/u);
});

test("a guarded-path commit in the primary checkout with no evidence is still dark", () => {
  const unit = world();
  const report = evaluateDarkSessions(
    inputFor(unit, [primaryCheckout({ commits: [commit({ changedPaths: ["SPEC.md"] })] })]),
  );
  assert.equal(report.findings[0]?.verdict, "dark");
  assert.equal(report.findings[0]?.code, "no-evidence");
  assert.equal(report.ok, false);
});

test("the policy ceremony passes on its attestation, with no grant at all", () => {
  const unit = world();
  const records = verified(unit);
  const attestation = records.find((record) => record.event === "policy.updated");
  const sha = (attestation?.payload as Record<string, unknown> | undefined)?.["sha256"];
  assert.equal(typeof sha, "string");
  const report = evaluateDarkSessions(
    inputFor(unit, [primaryCheckout({ commits: [commit({ changedPaths: ["APPROVAL.md"] })] })], {
      policySha256: sha as string,
    }),
  );
  assert.equal(report.ok, true, renderDarkSessionReport(report));
  assert.equal(report.findings[0]?.verdict, "exempt");
  assert.equal(report.findings[0]?.code, "primary-checkout");
});

test("a records advance, which changes only the evidence surface, is exempt", () => {
  const unit = world();
  const report = evaluateDarkSessions(
    inputFor(unit, [
      checkout({
        name: "records-2026-09-02",
        commits: [
          commit({
            changedPaths: [".approval/log/events.jsonl", ".approval/QUEUE.md"],
          }),
        ],
      }),
    ]),
  );
  assert.equal(report.findings[0]?.verdict, "exempt");
  assert.equal(report.findings[0]?.code, "evidence-surface");
});

test("a commit authored by the daemon's own git identity is exempt", () => {
  const unit = world();
  const report = evaluateDarkSessions(
    inputFor(unit, [
      checkout({
        name: "agent-evidence",
        commits: [commit({ authorEmail: GIT_EVIDENCE_AUTHOR_EMAIL, changedPaths: ["x.txt"] })],
      }),
    ]),
  );
  assert.equal(report.findings[0]?.verdict, "exempt");
  assert.equal(report.findings[0]?.code, "daemon-authored");
});

test("the exemptions are narrow: one substantive commit beside them removes both", () => {
  const unit = world();
  const report = evaluateDarkSessions(
    inputFor(unit, [
      checkout({
        name: "agent-mixed",
        commits: [
          commit({ sha: "b".repeat(40), changedPaths: ["src/core/gate.ts"] }),
          commit({ changedPaths: [".approval/log/events.jsonl"] }),
        ],
      }),
    ]),
  );
  assert.equal(report.findings[0]?.verdict, "dark");
  assert.equal(report.findings[0]?.code, "no-records");
});

// ---------------------------------------------------------------------------
// Fail closed IN THE REPORT: uncertainty is never a pass
// ---------------------------------------------------------------------------

test("a log that does not verify makes every subject undetermined, never a pass", () => {
  const unit = world();
  const report = evaluateDarkSessions(
    inputFor(unit, [checkout(), primaryCheckout()], {
      records: null,
      logDetail: "chain broken at seq 4",
    }),
  );
  assert.equal(report.settled, false);
  for (const finding of report.findings) {
    assert.equal(finding.verdict, "undetermined");
    assert.equal(finding.code, "log-unverified");
    assert.match(finding.detail, /Reported as uncertainty rather than as a pass/u);
  }
  assert.match(renderDarkSessionReport(report), /UNDETERMINED/u);
  assert.match(renderDarkSessionReport(report), /SOME SUBJECTS NOT ESTABLISHED/u);
});

test("git that could not be asked makes every subject undetermined", () => {
  const unit = world();
  const report = evaluateDarkSessions(
    inputFor(unit, [checkout()], {
      activity: { checkouts: [checkout()], unavailable: "git worktree list failed" },
    }),
  );
  assert.equal(report.findings[0]?.verdict, "undetermined");
  assert.equal(report.findings[0]?.code, "git-unavailable");
  assert.equal(report.settled, false);
});

test("bound material that will not resolve is undetermined, not an alarm and not a pass", () => {
  const unit = world();
  grantEdit(unit, "agent-lost", { command: "true", cwd: `${WORKTREES}/agent-lost` }, 4);
  // The payload store has lost the bytes (pruned under retention, say), so the
  // record cannot be placed in any checkout.
  const report = evaluateDarkSessions(
    inputFor(unit, [checkout({ name: "agent-lost" })], { payloadFor: () => null }),
  );
  assert.equal(report.findings[0]?.verdict, "undetermined");
  assert.equal(report.findings[0]?.code, "payload-unresolvable");
  assert.equal(report.ok, true);
  assert.equal(report.settled, false);
});

test("activity git would not date is undetermined", () => {
  const unit = world();
  const report = evaluateDarkSessions(
    inputFor(unit, [checkout({ name: "agent-undated", commits: [commit({ ts: null })], born: null })]),
  );
  assert.equal(report.findings[0]?.verdict, "undetermined");
  assert.equal(report.findings[0]?.code, "activity-undated");
});

// ---------------------------------------------------------------------------
// The observer and the sweep, against a real repository
// ---------------------------------------------------------------------------

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string): Run {
  const env = { ...process.env };
  delete env["APPROVAL_HUMAN"];
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], { cwd, encoding: "utf8", env });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/**
 * git, inside a temp repository and nowhere else.
 *
 * `dates` backdates a commit (APRV-369): the window these sweeps judge is the
 * last 24 hours, and a fixture's own seed commit is seconds old, so without it
 * the repository's creation is itself activity under judgment.
 */
function git(args: string[], cwd: string, dates?: string): Run {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      ...(dates === undefined ? {} : { GIT_AUTHOR_DATE: dates, GIT_COMMITTER_DATE: dates }),
    },
  });
  assert.equal(result.error, undefined, `git failed to run: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/**
 * A real repository with an attested policy, a trunk commit, and one linked
 * worktree that has committed work and appended nothing.
 */
function repoWithDarkWorktree(): { root: string; worktree: string } {
  counter += 1;
  const root = realpathSync(mkdtempSync(join(scratch, `repo-${counter}-`)));
  mkdirSync(join(root, "backlog", "tasks"), { recursive: true });
  writeFileSync(join(root, "APPROVAL.md"), POLICY, "utf8");
  writeFileSync(join(root, "README.md"), "seed\n", "utf8");
  assert.equal(git(["init", "--initial-branch=main"], root).code, 0);
  assert.equal(git(["add", "-A"], root).code, 0);
  assert.equal(git(["commit", "--no-verify", "-q", "-m", "seed"], root).code, 0);
  assert.equal(runCli(["policy", "attest", "--as", HUMAN], root).code, 0);

  const worktree = join(root, ".claude", "worktrees", "agent-dark");
  assert.equal(
    git(["worktree", "add", "-b", "agent-dark", worktree, "main"], root).code,
    0,
  );
  writeFileSync(join(worktree, "feature.ts"), "export const x = 1;\n", "utf8");
  assert.equal(git(["add", "-A"], worktree).code, 0);
  assert.equal(git(["commit", "--no-verify", "-q", "-m", "unlogged work"], worktree).code, 0);
  return { root, worktree };
}

function jsonLines(text: string): Record<string, unknown>[] {
  return text
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("daemon --dark-sessions: a real dark worktree becomes a line and a record", () => {
  const { root } = repoWithDarkWorktree();

  const first = runCli(["daemon", "run", "--once", "--json", "--dark-sessions"], root);
  assert.equal(first.code, 0, first.stderr);
  const lines = [...jsonLines(first.stdout), ...jsonLines(first.stderr)];
  const dark = lines.filter((line) => line["event"] === "dark_session");
  assert.equal(dark.length, 1, JSON.stringify(lines));
  assert.equal(dark[0]?.["verdict"], "dark");
  assert.equal(dark[0]?.["subject"], "agent-dark");
  assert.equal(dark[0]?.["code"], "no-records");
  assert.equal(dark[0]?.["already_recorded"], false);
  assert.equal(typeof dark[0]?.["seq"], "number");

  // The record is in the log, through the real append path, and the chain
  // still verifies.
  const verifyRun = runCli(["log", "verify", "--json"], root);
  assert.equal(verifyRun.code, 0, verifyRun.stderr);
  const outcome = verifyWithRecords(join(root, ".approval", "log", "events.jsonl"));
  assert.equal(outcome.result.status, "clean");
  const recorded = outcome.records.filter((record) => record.event === "audit.dark_session");
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.actor, "system:daemon");
  const payload = recorded[0]?.payload as Record<string, unknown>;
  assert.equal(payload["subject"], "agent-dark");
  assert.equal(payload["code"], "no-records");
  assert.equal(typeof payload["observation_key"], "string");

  // Idempotent without remembering anything: a second sweep over the same state
  // of the world appends nothing and says so.
  const second = runCli(["daemon", "run", "--once", "--json", "--dark-sessions"], root);
  assert.equal(second.code, 0, second.stderr);
  const repeated = [...jsonLines(second.stdout), ...jsonLines(second.stderr)].filter(
    (line) => line["event"] === "dark_session",
  );
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0]?.["already_recorded"], true);
  assert.equal(repeated[0]?.["seq"], null);
  const after2 = verifyWithRecords(join(root, ".approval", "log", "events.jsonl"));
  assert.equal(
    after2.records.filter((record) => record.event === "audit.dark_session").length,
    1,
    "a second sweep appended a duplicate observation",
  );
});

test("the sweep is opt-in: without the flag the daemon observes nothing", () => {
  const { root } = repoWithDarkWorktree();
  const run = runCli(["daemon", "run", "--once", "--json"], root);
  assert.equal(run.code, 0, run.stderr);
  const lines = [...jsonLines(run.stdout), ...jsonLines(run.stderr)];
  assert.equal(lines.filter((line) => line["event"] === "dark_session").length, 0);
});

test("--dark-window refuses a typo in the same words every duration flag does", () => {
  const { root } = repoWithDarkWorktree();
  const run = runCli(["daemon", "run", "--once", "--dark-sessions", "--dark-window", "twelve"], root);
  assert.equal(run.code, 2, run.stdout);
  assert.match(run.stderr, /--dark-window expects a duration/u);
});

test("doctor reports the dark worktree and appends nothing of its own", () => {
  const { root } = repoWithDarkWorktree();
  const before = verifyWithRecords(join(root, ".approval", "log", "events.jsonl")).records.length;

  const run = runCli(["doctor", "--json"], root);
  const parsed = JSON.parse(run.stdout) as { checks: { check: string; status: string; detail: string }[] };
  const row = parsed.checks.find((check) => check.check === "dark-sessions");
  assert.notEqual(row, undefined, JSON.stringify(parsed.checks.map((check) => check.check)));
  assert.equal(row?.status, "fail");
  assert.match(row?.detail ?? "", /agent-dark \[no-records\]/u);

  const after3 = verifyWithRecords(join(root, ".approval", "log", "events.jsonl")).records.length;
  assert.equal(after3, before, "doctor appended a record; it is a reader");
});

// ---------------------------------------------------------------------------
// APRV-369: arm A and the CI guard, on the same commits, agree
// ---------------------------------------------------------------------------

/**
 * {@link POLICY} in the spelling the LOADER reads.
 *
 * The fixtures above hand `policyProtectedPaths` to the evaluator directly, so
 * the nesting in `POLICY` never mattered to them. These cases go through the
 * real CLI, where `policyFacts` reads the loaded policy, and
 * `protected_paths` is a top-level key there — the same place this
 * repository's own `APPROVAL.md` puts it.
 */
const LOADABLE_POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "1h"',
  "  on_expiry: reject",
  "protected_paths:",
  "  - SPEC.md",
  "classes:",
  "  read.*:",
  "    autonomy: autonomous",
  "  files.write.*:",
  "    autonomy: autonomous",
  "  policy.edit:",
  "    autonomy: manual",
  "```",
  "",
].join("\n");

/**
 * The `ea7427a` shape, small enough to build: one protected file edited by
 * three commits on three branches, all merged into main inside one window, each
 * edit evidenced on its own.
 *
 * That is what a day of lanes looks like in the primary, and it is what arm A
 * used to replay as ONE change spanning all of them. Replayed that way a
 * grant's after-state is gone from the head blob and the next grant's
 * before-state is gone from the base blob, so neither covers on its own, and
 * the middle edit — ratified by a human's whole-file SIGN-OFF at its own commit
 * (APRV-338) — has no step the replay can compose at all. The row failed for
 * changes CI had passed. Replayed per commit, which is what CI does and what
 * each piece of evidence binds, all three clear.
 *
 * The middle edit is doubly load-bearing: arm A used to pass neither
 * `pathSha256AtHead` nor `organSha256AtHead`, so a sign-off was evidence the CI
 * guard could read and the doctor could not.
 *
 * Real git, real merges, and every record appended through `core/gate` or the
 * real `policy attest` verb.
 */
function repoWithMergedGrantedEdits(options: { grantLast: boolean }): {
  root: string;
  first: string;
  middle: string;
  last: string;
} {
  counter += 1;
  const root = realpathSync(mkdtempSync(join(scratch, `merged-${counter}-`)));
  writeFileSync(join(root, "APPROVAL.md"), LOADABLE_POLICY, "utf8");
  writeFileSync(join(root, "SPEC.md"), "alpha\n", "utf8");
  assert.equal(git(["init", "--initial-branch=main"], root).code, 0);
  assert.equal(git(["add", "-A"], root).code, 0);
  // Backdated a month, so the repository's own creation is history rather than
  // activity inside the 24h window this sweep judges.
  const long_ago = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(git(["commit", "--no-verify", "-q", "-m", "seed"], root, long_ago).code, 0);
  assert.equal(runCli(["policy", "attest", "--as", HUMAN], root).code, 0);

  const logPath = join(root, ".approval", "log", "events.jsonl");
  const store = new Map<string, unknown>();
  const gate: World = {
    unit: {
      dir: root,
      logPath,
      policyPath: join(root, "APPROVAL.md"),
      options: { policy: { file: join(root, "APPROVAL.md") } },
    },
    store,
  };

  // The grant comes FIRST and the commit after it, because the guard measures
  // ordering against the committer date: a grant that arrives after the bytes
  // were committed is post-hoc and is refused. No clock is injected, so these
  // are real instants a few milliseconds apart, exactly as a live session's are.
  const edit = (before: string, after: string, key: string): void => {
    grantOfClass(
      gate,
      key,
      "policy.edit",
      { tool: "Edit", rule: "protected path", file: join(root, "SPEC.md"), before, after },
      null,
    );
  };
  const onBranch = (
    branch: string,
    before: string,
    after: string,
    key: string,
    evidence: "grant" | "sign-off" | "none",
  ): string => {
    assert.equal(git(["checkout", "-q", "-b", branch, "main"], root).code, 0);
    if (evidence === "grant") edit(before, after, key);
    writeFileSync(join(root, "SPEC.md"), `${after}\n`, "utf8");
    assert.equal(git(["add", "SPEC.md"], root).code, 0);
    assert.equal(git(["commit", "--no-verify", "-q", "-m", key], root).code, 0);
    if (evidence === "sign-off") {
      // The working tree is at this commit's bytes, which is what the verb
      // hashes, so the record covers exactly the file this commit carries.
      assert.equal(
        runCli(["policy", "attest", "--path", "SPEC.md", "--as", HUMAN], root).code,
        0,
      );
    }
    const sha = git(["rev-parse", "HEAD"], root).stdout.trim();
    assert.equal(git(["checkout", "-q", "main"], root).code, 0);
    assert.equal(git(["merge", "--no-ff", "-q", "-m", `merge ${key}`, branch], root).code, 0);
    return sha;
  };

  const first = onBranch("pr-one", "alpha", "beta", "first-edit", "grant");
  const middle = onBranch("pr-two", "beta", "gamma", "middle-edit", "sign-off");
  const last = onBranch("pr-three", "gamma", "delta", "last-edit", options.grantLast ? "grant" : "none");
  return { root, first, middle, last };
}

/** Bound material, read from the repository's own payload store. */
function payloadFromStore(root: string): (hash: string) => unknown | null {
  const storeDir = payloadStoreDirFor(join(root, ".approval", "log", "events.jsonl"));
  return (hash) => {
    const loaded = loadPayload(storeDir, hash);
    return loaded.ok ? loaded.value : null;
  };
}

/**
 * The guard's verdict on ONE commit, built from the SHARED per-commit helper
 * (APRV-375).
 *
 * `core/commit-guard.ts` is the one place either side constructs these inputs:
 * `scripts/protected-path-guard.mjs` calls it for every commit of a pull
 * request's range, and `core/dark-session.ts`'s arm A calls it for every commit
 * in its window. Calling it here too is the point — if the doctor and CI could
 * disagree about the unit, this helper is where that would have to show up.
 */
function guardCommit(root: string, sha: string, records: readonly EventRecord[]) {
  const read = (args: readonly string[]): string | null => {
    const run = git([...args], root);
    return run.code === 0 ? run.stdout : null;
  };
  const authored = git(["log", "-1", "--format=%aI", sha], root).stdout.trim();
  const committed = git(["log", "-1", "--format=%cI", sha], root).stdout.trim();
  const parts = commitGuardInputParts(read, {
    sha,
    ts: { author: authored, committer: committed },
  });
  return evaluateProtectedPaths({
    changedPaths: ["SPEC.md"],
    blobsFor: parts.blobsFor,
    records,
    logStatus: "ok",
    policyProtectedPaths: ["SPEC.md"],
    policySha256AtHead: null,
    policyPath: "APPROVAL.md",
    organSha256AtHead: parts.sha256At,
    pathSha256AtHead: parts.sha256At,
    payloadFor: payloadFromStore(root),
    changeTsFor: parts.changeTsFor,
    window: {
      firstSeq: null,
      lastSeq: null,
      firstTs: null,
      lastTs: null,
      base: parts.window.base,
      head: parts.window.head,
    },
  });
}

interface ScriptCommit {
  sha: string;
  merge: boolean;
  judged: boolean;
  ok: boolean;
  findings: Array<{ path: string; ok: boolean; code?: string }>;
}

/**
 * The REAL CI guard, over this fixture's whole history.
 *
 * The fixture keeps its log untracked, because that is what a live checkout
 * looks like while a session is running; the CI guard reads committed trees
 * only, so the log and its payload store are committed first, in a commit that
 * touches nothing but the daemon's own append surface.
 */
function runCiGuard(root: string): { code: number; stdout: string; commits: ScriptCommit[] } {
  assert.equal(git(["add", "-A"], root).code, 0);
  assert.equal(git(["commit", "--no-verify", "-q", "-m", "log advance"], root).code, 0);
  const seed = git(["rev-list", "--max-parents=0", "HEAD"], root).stdout.trim();
  const run = spawnSync(
    process.execPath,
    [GUARD_SCRIPT, "--repo", root, "--base", seed, "--head", "HEAD", "--json"],
    { encoding: "utf8" },
  );
  const parsed = JSON.parse(run.stdout) as { commits: ScriptCommit[] };
  return { code: run.status ?? -1, stdout: run.stdout, commits: parsed.commits };
}

test("APRV-369: the doctor row reaches the CI guard's verdict on merged, evidenced edits", () => {
  const { root, first, middle, last } = repoWithMergedGrantedEdits({ grantLast: true });
  const records = verifyWithRecords(join(root, ".approval", "log", "events.jsonl")).records;

  // The CI guard's verdict, per commit: what PR #432's `protected paths` job
  // computed for `ea7427a`, and passed.
  for (const sha of [first, middle, last]) {
    const report = guardCommit(root, sha, records);
    assert.equal(report.ok, true, `${sha.slice(0, 12)}: ${JSON.stringify(report.findings)}`);
  }

  // The doctor's, through the CLI, over all three commits in one window.
  const run = runCli(["doctor", "--json"], root);
  const parsed = JSON.parse(run.stdout) as { checks: { check: string; status: string; detail: string }[] };
  const row = parsed.checks.find((check) => check.check === "dark-sessions");
  assert.notEqual(row, undefined);
  assert.notEqual(row?.status, "fail", `dark-sessions disagreed with the guard: ${row?.detail ?? ""}`);

  // APRV-375 AC5: the REAL CI guard, over the same repository, names the same
  // unit and reaches the same verdict. It judges these three commits and no
  // other; the merges that carried them into main resolved SPEC.md to one
  // parent's bytes and are listed as skipped.
  const ci = runCiGuard(root);
  assert.equal(ci.code, 0, ci.stdout);
  for (const sha of [first, middle, last]) {
    const judged = ci.commits.find((commit) => commit.sha === sha);
    assert.ok(judged !== undefined, `the CI guard did not judge ${sha.slice(0, 12)}`);
    assert.equal(judged.judged, true);
    assert.equal(judged.ok, true);
  }
  for (const merge of ci.commits.filter((commit) => commit.merge)) {
    assert.equal(merge.judged, false, `${merge.sha.slice(0, 12)} was judged for what its parents did`);
  }

  // What is NOT asserted here, and why. On `ea7427a` the union span ALSO
  // failed, and APRV-357's reproduction recorded the reason: with six commits
  // over a 200 KB SPEC.md the exact base-to-head replay "refused after reaching
  // its byte limit" before it could compose the grants, leaving per-grant
  // matching, which the union defeats. On a fixture this size the replay
  // finishes and rescues the union, so asserting that the union fails here
  // would be asserting the byte budget rather than the span. Since APRV-375 no
  // production path replays a union at all, so what remains to pin is the half
  // that holds at any size: the doctor and the guard agree per commit, and the
  // middle commit's SIGN-OFF counts for the doctor, which it could not before
  // arm A supplied `pathSha256AtHead`.
});

test("APRV-369: an unevidenced edit that arrived by merge names its commit and its origin", () => {
  const { root, last: second } = repoWithMergedGrantedEdits({ grantLast: false });

  const run = runCli(["doctor", "--json"], root);
  const parsed = JSON.parse(run.stdout) as { checks: { check: string; status: string; detail: string }[] };
  const row = parsed.checks.find((check) => check.check === "dark-sessions");
  assert.equal(row?.status, "fail", row?.detail ?? "");
  // AC2: the row does not read as the primary checkout's own dark activity.
  assert.match(row?.detail ?? "", /\[no-evidence-merged\]/u);
  assert.match(row?.detail ?? "", /reached this checkout through a merge/u);
  // AC3: it names the commit it judged.
  assert.match(row?.detail ?? "", new RegExp(second.slice(0, 12), "u"));

  // APRV-375 AC5: the CI guard fails the SAME commit, and only that one. Same
  // unit, same verdict, from the shared per-commit input construction.
  const ci = runCiGuard(root);
  assert.equal(ci.code, 1, ci.stdout);
  const failed = ci.commits.filter((commit) => !commit.ok);
  assert.deepEqual(
    failed.map((commit) => commit.sha),
    [second],
    ci.stdout,
  );
  assert.equal(failed[0]?.findings[0]?.path, "SPEC.md");
});
