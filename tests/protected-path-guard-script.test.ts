/**
 * Where the CI guard gets its log (APRV-260).
 *
 * The evidence rules live in `core/protected-path-guard.ts` and are proved in
 * `tests/protected-path-guard.test.ts`. What is proved HERE is the one decision
 * the script makes before those rules ever run: which committed copy of the log
 * it reads. The copy at the pull request's head is main's log at branch time,
 * so a grant tapped during the session is not in it, and the script may look
 * further along the same chain — a pushed `records-*` branch — but never at a
 * different chain.
 *
 * Every fixture is a REAL git repository driven with real `git`, and every log
 * is built through the REAL append path: `core/attest` for the attestation and
 * `core/gate`'s register/request/decide for the grant, whose payload lands in
 * the real content-addressed store beside the log. Nothing here writes a jsonl
 * line by hand. The one case that needs a chain that disagrees with head's
 * produces it the way `tests/log-anchor.test.ts` does: it truncates a copy and
 * re-appends different records through the same real path, so what the script
 * is shown is a log that walks clean from genesis and is not head's history.
 * The corrupt case is likewise a real log with bytes removed, which is what a
 * damaged copy actually is.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { appendAttestation, appendOrganAttestation } from "../src/core/attest.js";
import { decide, register, request } from "../src/core/gate.js";
import { payloadHash } from "../src/core/payload.js";
import { verify } from "../src/core/verify.js";
import { fixedClock, newScenario, scratchRoot, type Scenario } from "./scenario.js";

/** dist/tests/…test.js -> the repository root. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GUARD = join(REPO_ROOT, "scripts", "protected-path-guard.mjs");

const HUMAN = "human:carter";
const AGENT = "agent:claude-code";

/**
 * A policy that makes `policy.edit` manual, so the gate produces a real grant,
 * and widens the protected set to SPEC.md.
 *
 * `protected_paths` is a TOP-LEVEL key of the policy block; the schema is
 * closed, so a nested one would fail validation and the guard would then see no
 * widening at all (and, faithfully, report that nothing protected changed).
 */
const POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "8h"',
  "  on_expiry: reject",
  "protected_paths:",
  "  - SPEC.md",
  "classes:",
  "  read.*:",
  "    autonomy: autonomous",
  "  policy.edit:",
  "    autonomy: manual",
  "```",
  "",
].join("\n");

const roots: Array<() => void> = [];
after(() => {
  for (const cleanup of roots) cleanup();
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function git(args: string[], cwd: string): Run {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function commit(dir: string, message: string): string {
  assert.equal(git(["add", "-A"], dir).code, 0, `git add failed in ${dir}`);
  const made = git(["commit", "-qm", message], dir);
  assert.equal(made.code, 0, `git commit failed: ${made.stderr}`);
  return git(["rev-parse", "HEAD"], dir).stdout.trim();
}

interface Fixture {
  unit: Scenario;
  dir: string;
  /** The commit before the protected edit: the guard's `--base`. */
  base: string;
}

/** Now, and a few minutes either side of it: the grant and the commit are same-session. */
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

/**
 * A repository with an attested policy, a committed log of two records, and
 * SPEC.md at its pre-edit content.
 *
 * Two records rather than one so the divergence case has a prefix to keep: a
 * candidate that disagrees at seq 2 while agreeing at seq 1 is exactly the
 * shape "a different history that is longer" takes.
 */
function newFixture(label: string): Fixture {
  const { root, cleanup } = scratchRoot(`guard-script-${label}`);
  roots.push(cleanup);
  const unit = newScenario(root, POLICY);
  for (const minutes of [30, 29]) {
    const attested = appendAttestation(unit.logPath, unit.policyPath, HUMAN, {
      clock: fixedClock(minutesAgo(minutes)),
    });
    assert.equal(attested.ok, true, "the fixture attestation did not append");
  }
  writeFileSync(join(unit.dir, "SPEC.md"), "old\n", "utf8");

  assert.equal(git(["init", "-q", "-b", "main", "."], unit.dir).code, 0);
  git(["config", "user.email", "test@example.invalid"], unit.dir);
  git(["config", "user.name", "Test"], unit.dir);
  const base = commit(unit.dir, "seed");
  return { unit, dir: unit.dir, base };
}

/** The protected edit itself, committed with the log left exactly as it was. */
function editSpec(fixture: Fixture): string {
  writeFileSync(join(fixture.dir, "SPEC.md"), "new\n", "utf8");
  return commit(fixture.dir, "edit SPEC.md");
}

/**
 * One `policy.edit` grant for SPEC.md, appended through the gate, with its
 * material in the real payload store. The grant binds the CHANGE (APRV-124):
 * one line out, one line in, which is exactly the edit `editSpec` makes.
 */
function grantSpecEdit(fixture: Fixture, key: string): void {
  const material = {
    tool: "Edit",
    rule: "protected path",
    file: join(fixture.dir, "SPEC.md"),
    before: "old",
    after: "new",
  };
  const hash = payloadHash(material);
  const task = `hook:${key}`;
  const actionKey = `${task}:policy.edit`;
  const clock = fixedClock(minutesAgo(2));

  const registered = register(
    fixture.unit.logPath,
    {
      task,
      envelope: {
        origin: { app: "claude-code", created_by: AGENT },
        state: "proposed",
        actions: [
          {
            class: "policy.edit",
            summary: "Edit SPEC.md",
            reversible: true,
            est_cost_usd: "0",
            idempotency_key: actionKey,
            payload_hash: hash,
          },
        ],
      },
    },
    AGENT,
    { ...fixture.unit.options, clock },
  );
  assert.equal(registered.ok, true, registered.ok ? "" : registered.message);

  const requested = request(
    fixture.unit.logPath,
    {
      task,
      actionKey,
      cls: "policy.edit",
      est_cost_usd: "0",
      summary: "Edit SPEC.md",
      payload_hash: hash,
      payload: { value: material },
      execution: "harness",
    },
    AGENT,
    { ...fixture.unit.options, clock },
  );
  assert.equal(requested.ok, true, JSON.stringify(requested));

  const granted = decide(fixture.unit.logPath, actionKey, "grant", HUMAN, {
    ...fixture.unit.options,
    clock: fixedClock(minutesAgo(1)),
  });
  assert.equal(granted.ok, true, JSON.stringify(granted));
  assert.equal(verify(fixture.unit.logPath).status, "clean");
}

/**
 * Do `work` on a fresh branch cut from the current commit, commit it, and come
 * back. The working log is restored by the checkout, so what each branch holds
 * is exactly the log as it stood when that branch committed.
 */
function onBranch(fixture: Fixture, name: string, message: string, work: () => void): void {
  const from = git(["rev-parse", "--abbrev-ref", "HEAD"], fixture.dir).stdout.trim();
  assert.equal(git(["checkout", "-q", "-b", name], fixture.dir).code, 0);
  work();
  commit(fixture.dir, message);
  assert.equal(git(["checkout", "-q", from], fixture.dir).code, 0);
}

interface GuardRun extends Run {
  report: {
    ok: boolean;
    findings: Array<{
      path: string;
      ok: boolean;
      detail: string;
      code?: string;
      evidence?: string;
    }>;
    log_source: {
      ref: string;
      lastSeq: number | null;
      headLastSeq: number | null;
      candidates: Array<{ ref: string; status: string; lastSeq: number | null }>;
    };
  };
}

/** The script, run twice: once for the human output, once for `--json`. */
function runGuard(fixture: Fixture, args: string[]): GuardRun {
  const base = ["--repo", fixture.dir, "--base", fixture.base, ...args];
  const human = spawnSync(process.execPath, [GUARD, ...base], { encoding: "utf8" });
  const json = spawnSync(process.execPath, [GUARD, ...base, "--json"], { encoding: "utf8" });
  assert.equal(
    json.status,
    human.status,
    `--json and the human rendering disagreed about the verdict:\n${human.stdout}${human.stderr}`,
  );
  return {
    code: human.status ?? -1,
    stdout: human.stdout,
    stderr: human.stderr,
    report: JSON.parse(json.stdout) as GuardRun["report"],
  };
}

function candidate(run: GuardRun, ref: string): { ref: string; status: string; lastSeq: number | null } {
  const found = run.report.log_source.candidates.find((entry) => entry.ref === ref);
  assert.ok(found !== undefined, `no candidate named ${ref} in ${JSON.stringify(run.report.log_source)}`);
  return found;
}

// ---------------------------------------------------------------------------
// (a) head alone, unchanged
// ---------------------------------------------------------------------------

test("head alone: the grant in the log the pull request carries still passes", () => {
  const fixture = newFixture("head-only");
  grantSpecEdit(fixture, "head-only");
  editSpec(fixture);

  const run = runGuard(fixture, ["--head", "HEAD"]);
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  assert.equal(run.report.findings[0]?.path, "SPEC.md");
  assert.equal(run.report.findings[0]?.evidence, "granted-file");
  // The log came from head, and the report says so in both renderings.
  assert.equal(run.report.log_source.ref, "HEAD");
  assert.equal(run.report.log_source.lastSeq, run.report.log_source.headLastSeq);
  assert.equal(candidate(run, "HEAD").status, "chosen");
  assert.match(run.stdout, /^log from HEAD, seq 1\.\.\d+ \(head carried 1\.\.\d+\)$/mu);
  // Discovery is harmless where the refs do not exist: this fixture has no
  // remote at all, and the absent candidate neither fails the run nor is read.
  assert.equal(candidate(run, "origin/main").status, "missing");
});

// ---------------------------------------------------------------------------
// (b) the grant is on a pushed records branch, not yet merged
// ---------------------------------------------------------------------------

test("a records branch that extends head's chain carries the grant, and is named", () => {
  const fixture = newFixture("extension");
  editSpec(fixture);
  // The grant is tapped AFTER the branch was cut, which is the real order: it
  // reaches a committed log only on the advance.
  onBranch(fixture, "records-log-later", "log advance", () => {
    grantSpecEdit(fixture, "extension");
  });

  // Head alone still fails, and the failure states the ordering rule.
  const headOnly = runGuard(fixture, ["--head", "main", "--log-ref", "main"]);
  assert.equal(headOnly.code, 1, headOnly.stdout);
  assert.equal(headOnly.report.findings[0]?.code, "no-evidence");
  assert.match(
    headOnly.report.findings[0]?.detail ?? "",
    /pushed to a records branch or merged to main/u,
  );

  const run = runGuard(fixture, ["--head", "main", "--log-ref", "records-log-later"]);
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  assert.equal(run.report.findings[0]?.evidence, "granted-file");
  assert.equal(run.report.log_source.ref, "records-log-later");
  assert.ok(
    (run.report.log_source.lastSeq ?? 0) > (run.report.log_source.headLastSeq ?? 0),
    "the chosen log must reach further than the one head carries",
  );
  assert.equal(candidate(run, "records-log-later").status, "chosen");
  assert.match(run.stdout, /^log from records-log-later, seq 1\.\.\d+ \(head carried 1\.\.2\)$/mu);
});

// ---------------------------------------------------------------------------
// (c) longer, and a different history
// ---------------------------------------------------------------------------

test("a longer candidate that disagrees with head's chain is diverged and never read", () => {
  const fixture = newFixture("diverged");
  editSpec(fixture);
  onBranch(fixture, "records-forged", "a different history", () => {
    // The forgery, built the way a forger would: keep the first record, drop
    // the rest, re-append through the real path. The result walks clean from
    // genesis (the chain is unkeyed) and is not the history head carries.
    const lines = readFileSync(fixture.unit.logPath, "utf8").split("\n").filter((line) => line.length > 0);
    writeFileSync(fixture.unit.logPath, `${lines[0]}\n`, "utf8");
    const attested = appendAttestation(fixture.unit.logPath, fixture.unit.policyPath, HUMAN, {
      clock: fixedClock(minutesAgo(10)),
    });
    assert.equal(attested.ok, true, "the forged branch's re-append failed");
    grantSpecEdit(fixture, "diverged");
  });

  const run = runGuard(fixture, ["--head", "main", "--log-ref", "records-forged"]);
  // The grant IS in that branch's log, and it buys nothing: the verdict is
  // exactly the one head alone gives.
  assert.equal(run.code, 1, run.stdout);
  assert.equal(run.report.findings[0]?.code, "no-evidence");
  assert.equal(run.report.log_source.ref, "main");
  const rejected = candidate(run, "records-forged");
  assert.equal(rejected.status, "diverged");
  assert.ok(
    (rejected.lastSeq ?? 0) > (run.report.log_source.headLastSeq ?? 0),
    "the fixture must offer a LONGER divergent candidate, or it proves nothing",
  );
  assert.match(run.stdout, /records-forged/u);
});

// ---------------------------------------------------------------------------
// (d) a candidate that does not verify
// ---------------------------------------------------------------------------

test("a candidate whose log does not verify is skipped and named", () => {
  const fixture = newFixture("unverified");
  editSpec(fixture);
  onBranch(fixture, "records-torn", "a damaged copy", () => {
    grantSpecEdit(fixture, "unverified");
    // A real log with bytes removed: what a truncated push or a bad merge
    // leaves behind. It carries the grant, and it is not readable evidence.
    const lines = readFileSync(fixture.unit.logPath, "utf8").split("\n").filter((line) => line.length > 0);
    const torn = [...lines.slice(0, 2), ...lines.slice(3)];
    writeFileSync(fixture.unit.logPath, `${torn.join("\n")}\n`, "utf8");
    assert.notEqual(verify(fixture.unit.logPath).status, "clean", "the fixture must not verify");
  });

  const run = runGuard(fixture, ["--head", "main", "--log-ref", "records-torn"]);
  assert.equal(run.code, 1, run.stdout);
  assert.equal(run.report.findings[0]?.code, "no-evidence");
  assert.equal(run.report.log_source.ref, "main");
  assert.equal(candidate(run, "records-torn").status, "unverified");
  assert.match(run.stdout, /candidate records-torn: unverified/u);
});

// ---------------------------------------------------------------------------
// (e) two admitted candidates
// ---------------------------------------------------------------------------

test("among candidates that anchor, the one reaching the highest seq is chosen", () => {
  const fixture = newFixture("two");
  editSpec(fixture);
  assert.equal(git(["checkout", "-q", "-b", "records-first"], fixture.dir).code, 0);
  grantSpecEdit(fixture, "first");
  commit(fixture.dir, "advance one");
  assert.equal(git(["checkout", "-q", "-b", "records-second"], fixture.dir).code, 0);
  const attested = appendAttestation(fixture.unit.logPath, fixture.unit.policyPath, HUMAN, {
    clock: fixedClock(minutesAgo(1)),
  });
  assert.equal(attested.ok, true, "the second advance did not append");
  commit(fixture.dir, "advance two");
  assert.equal(git(["checkout", "-q", "main"], fixture.dir).code, 0);

  const run = runGuard(fixture, [
    "--head",
    "main",
    "--log-ref",
    "records-first",
    "--log-ref",
    "records-second",
  ]);
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  assert.equal(run.report.log_source.ref, "records-second");
  assert.equal(candidate(run, "records-first").status, "admitted");
  assert.equal(candidate(run, "records-second").status, "chosen");
  assert.ok(
    (candidate(run, "records-second").lastSeq ?? 0) > (candidate(run, "records-first").lastSeq ?? 0),
  );
});

// ---------------------------------------------------------------------------
// The working tree is never an input
// ---------------------------------------------------------------------------

test("the guard reads committed trees only: a working-tree log is not evidence", () => {
  const fixture = newFixture("worktree");
  editSpec(fixture);
  // The grant is appended and left UNCOMMITTED, which is the state a session's
  // own checkout is in between advances. A guard that read the checkout would
  // pass this; one that reads trees cannot.
  grantSpecEdit(fixture, "worktree");

  const run = runGuard(fixture, ["--head", "main", "--log-ref", "main"]);
  assert.equal(run.code, 1, run.stdout);
  assert.equal(run.report.findings[0]?.code, "no-evidence");
});

// ---------------------------------------------------------------------------
// The gate organs, digested per path at the head commit (APRV-272)
// ---------------------------------------------------------------------------

const ORGAN = join(".claude", "settings.json");

/** Write the harness settings file in the fixture, at `text`. */
function writeOrgan(fixture: Fixture, text: string): void {
  mkdirSync(join(fixture.dir, ".claude"), { recursive: true });
  writeFileSync(join(fixture.dir, ORGAN), text, "utf8");
}

test("a hand-edited gate organ passes on its attestation, with no grant anywhere", () => {
  const fixture = newFixture("organ");
  const text = '{"hooks":{"PreToolUse":[],"PostToolUse":[]}}\n';
  writeOrgan(fixture, text);
  // The human's own act: attest the bytes, then commit the change AND the log
  // advance carrying the record — which is the shape PR #300 could not have.
  const attested = appendOrganAttestation(
    fixture.unit.logPath,
    { path: ".claude/settings.json", root: fixture.dir },
    HUMAN,
    { clock: fixedClock(minutesAgo(2)) },
  );
  assert.equal(attested.ok, true, JSON.stringify(attested));
  commit(fixture.dir, "install the PostToolUse entries");

  const run = runGuard(fixture, ["--head", "HEAD"]);
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  const finding = run.report.findings.find((entry) => entry.path === ".claude/settings.json");
  assert.ok(finding !== undefined, JSON.stringify(run.report.findings));
  assert.equal(finding.evidence, "attested");
  assert.match(finding.detail, /human-only/u);
});

test("an organ committed without attesting the bytes at head fails, naming the verb", () => {
  const fixture = newFixture("organ-unattested");
  writeOrgan(fixture, '{"hooks":{"PreToolUse":[]}}\n');
  commit(fixture.dir, "install a hook entry nobody signed");

  const run = runGuard(fixture, ["--head", "HEAD"]);
  assert.equal(run.code, 1, run.stdout);
  const finding = run.report.findings.find((entry) => entry.path === ".claude/settings.json");
  assert.ok(finding !== undefined, JSON.stringify(run.report.findings));
  assert.equal(finding.code, "no-evidence");
  assert.match(finding.detail, /approval policy attest --organ \.claude\/settings\.json/u);
});

test("attesting an organ and then editing it again fails: the digest at head is not signed", () => {
  const fixture = newFixture("organ-stale");
  writeOrgan(fixture, '{"hooks":{"PreToolUse":[]}}\n');
  const attested = appendOrganAttestation(
    fixture.unit.logPath,
    { path: ".claude/settings.json", root: fixture.dir },
    HUMAN,
    { clock: fixedClock(minutesAgo(3)) },
  );
  assert.equal(attested.ok, true, JSON.stringify(attested));
  // One more edit AFTER the signature, committed with it.
  writeOrgan(fixture, '{"hooks":{"PreToolUse":[],"PostToolUse":[]}}\n');
  commit(fixture.dir, "one more entry, unsigned");

  const run = runGuard(fixture, ["--head", "HEAD"]);
  assert.equal(run.code, 1, run.stdout);
  const finding = run.report.findings.find((entry) => entry.path === ".claude/settings.json");
  assert.ok(finding !== undefined, JSON.stringify(run.report.findings));
  assert.equal(finding.code, "no-evidence");
  assert.match(finding.detail, /no gate\.organ\.attested record attests/u);
});
