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
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { appendAttestation } from "../src/core/attest.js";
import {
  DAEMON_EVIDENCE_EMAILS,
  DARK_SESSION_CODES,
  DARK_SESSION_VERDICTS,
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
import { GIT_EVIDENCE_AUTHOR_EMAIL } from "../src/daemon/git-evidence.js";
import { verifyWithRecords } from "../src/core/verify.js";
import { at, fixedClock, newScenario, type Scenario } from "./scenario.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

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

/** Register, request and grant one `policy.edit` bound to `material`. */
function grantEdit(unit: World, key: string, material: unknown, minute: number): EventRecord {
  const hash = payloadHash(material);
  const task = `hook:${key}`;
  const actionKey = `${task}:policy.edit`;

  const registered = register(
    unit.unit.logPath,
    {
      task,
      envelope: {
        origin: { app: "claude-code", created_by: AGENT },
        state: "proposed",
        actions: [
          {
            class: "policy.edit",
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
    { ...unit.unit.options, clock: fixedClock(at(minute)) },
  );
  assert.equal(registered.ok, true, JSON.stringify(registered));

  const requested = request(
    unit.unit.logPath,
    {
      task,
      actionKey,
      cls: "policy.edit",
      est_cost_usd: "0",
      summary: `Edit ${key}`,
      payload_hash: hash,
      payload: { value: material },
      execution: "harness",
    },
    AGENT,
    { ...unit.unit.options, clock: fixedClock(at(minute)) },
  );
  assert.equal(requested.ok, true, JSON.stringify(requested));

  const granted = decide(unit.unit.logPath, actionKey, "grant", HUMAN, {
    ...unit.unit.options,
    clock: fixedClock(at(minute + 1)),
  });
  assert.equal(granted.ok, true, JSON.stringify(granted));
  if (!granted.ok) throw new Error("unreachable");

  unit.store.set(hash, material);
  return granted.record;
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

test("the verdict and code unions are frozen public API, listed", () => {
  assert.deepEqual([...DARK_SESSION_VERDICTS], ["hooked", "dark", "exempt", "undetermined"]);
  assert.deepEqual(
    [...DARK_SESSION_CODES],
    [
      "no-records",
      "no-evidence",
      "evidence-surface",
      "daemon-authored",
      "primary-checkout",
      "log-unverified",
      "git-unavailable",
      "payload-unresolvable",
      "activity-undated",
    ],
  );
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

/** git, inside a temp repository and nowhere else. */
function git(args: string[], cwd: string): Run {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
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
