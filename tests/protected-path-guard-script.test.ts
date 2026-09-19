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

import {
  appendAttestation,
  appendOrganAttestation,
  appendPathSignOff,
} from "../src/core/attest.js";
import { decide, register, request, startHarnessExecution } from "../src/core/gate.js";
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

/** The same policy with `policy.edit` unattended: PR #393's supervised-live shape. */
const UNATTENDED_POLICY = POLICY.replace(
  "  policy.edit:\n    autonomy: manual",
  "  policy.edit:\n    autonomy: autonomous",
);

const ROUTED_POLICY = POLICY.replace(
  "  - SPEC.md",
  "  - { path: SPEC.md, class: policy.edit.spec }",
).replace(
  "  policy.edit:\n    autonomy: manual",
  "  policy.edit:\n    autonomy: manual\n  policy.edit.spec:\n    autonomy: manual",
);

const roots: Array<() => void> = [];
after(() => {
  for (const cleanup of roots) cleanup();
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function git(args: string[], cwd: string, dates: Record<string, string> = {}): Run {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
      ...dates,
    },
  });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function commit(dir: string, message: string, dates: Record<string, string> = {}): string {
  assert.equal(git(["add", "-A"], dir).code, 0, `git add failed in ${dir}`);
  const made = git(["commit", "-qm", message], dir, dates);
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
function newFixture(label: string, policy = POLICY): Fixture {
  const { root, cleanup } = scratchRoot(`guard-script-${label}`);
  roots.push(cleanup);
  const unit = newScenario(root, policy);
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
  grantChange(fixture, key, "SPEC.md", "old", "new");
}

/**
 * One `policy.edit` grant over an exact change to one path (APRV-375's
 * generalization of {@link grantSpecEdit}, which now calls it).
 *
 * Same real path in every case: `register`, `request` with the material in the
 * content-addressed store, then a human `decide`. Nothing writes a jsonl line
 * by hand.
 */
function grantChange(
  fixture: Fixture,
  key: string,
  path: string,
  before: string,
  after: string,
): void {
  const material = {
    tool: "Edit",
    rule: "protected path",
    file: join(fixture.dir, path),
    before,
    after,
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
            summary: `Edit ${path}`,
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
      summary: `Edit ${path}`,
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
 * The unattended shape: no human in it at all (APRV-339, PR #393).
 *
 * Under a policy that routes `policy.edit` to `autonomous` this is what the
 * hook writes — the registration, the payload in the REAL content-addressed
 * store (which is what `request` does on the nonmanual path, where it appends
 * no record), and then the `execution.started` the harness runs behind. The
 * bound `file` is ABSOLUTE, because that is the only shape the hook has ever
 * written: it resolves the declared target against the session's cwd.
 */
function authorizeSpecEdit(fixture: Fixture, key: string, startedMinutesAgo: number): void {
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
    { ...fixture.unit.options, clock: fixedClock(minutesAgo(startedMinutesAgo + 1)) },
  );
  assert.equal(registered.ok, true, registered.ok ? "" : registered.message);

  const resolved = request(
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
    { ...fixture.unit.options, clock: fixedClock(minutesAgo(startedMinutesAgo)) },
  );
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  assert.equal(resolved.ok ? resolved.record : "appended", null, "autonomous requests append nothing");

  const started = startHarnessExecution(
    fixture.unit.logPath,
    {
      task,
      actionKey,
      cls: "policy.edit",
      payload_hash: hash,
      est_cost_usd: "0",
    },
    AGENT,
    { ...fixture.unit.options, clock: fixedClock(minutesAgo(startedMinutesAgo)) },
  );
  assert.equal(started.ok, true, JSON.stringify(started));
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

interface GuardFindingJson {
  path: string;
  ok: boolean;
  detail: string;
  code?: string;
  evidence?: string;
  /** The commit this finding was reached on (APRV-375). */
  commit?: string;
}

interface GuardCommitJson {
  sha: string;
  base: string | null;
  merge: boolean;
  judged: boolean;
  skipped: string | null;
  ok: boolean;
  findings: GuardFindingJson[];
  covered: number[];
}

interface GuardRun extends Run {
  report: {
    ok: boolean;
    findings: GuardFindingJson[];
    commits: GuardCommitJson[];
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
  return runGuardIn(fixture.dir, ["--base", fixture.base, ...args]);
}

/** The same, for a range this test chooses both ends of. */
function runGuardIn(dir: string, args: string[]): GuardRun {
  const base = ["--repo", dir, ...args];
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

/** The verdict the run reached for one commit, by full sha. */
function verdictOf(run: GuardRun, sha: string): GuardCommitJson {
  const found = run.report.commits.find((commit) => commit.sha === sha);
  assert.ok(
    found !== undefined,
    `${sha.slice(0, 12)} is not in the judged range: ${JSON.stringify(
      run.report.commits.map((commit) => commit.sha.slice(0, 12)),
    )}`,
  );
  return found;
}

/**
 * Every guarded path that differs between base and head is inside some commit
 * the guard judged.
 *
 * This is APRV-375's security argument, asserted rather than asserted-in-prose:
 * per-commit judgment asks a smaller question than the combined diff did, and
 * what makes that safe is that the union of the units still covers every
 * changed byte. Guarded paths only, because an unguarded one is not the
 * guard's business at either granularity.
 */
function assertEveryChangedPathWasJudged(
  run: GuardRun,
  dir: string,
  base: string,
  head: string,
  guarded: readonly string[],
): void {
  const diff = git(["diff", "--name-only", base, head], dir);
  assert.equal(diff.code, 0, diff.stderr);
  const changed = diff.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => guarded.includes(line));
  const judgedPaths = new Set(run.report.findings.map((finding) => finding.path));
  for (const path of changed) {
    assert.ok(
      judgedPaths.has(path),
      `${path} differs between ${base} and ${head} and no judged commit reported it: ${run.stdout}`,
    );
  }
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

test("PR #393: an edit folded in by git commit --amend is credited (APRV-339)", () => {
  // The real shape: `git commit --amend` keeps the first author date and moves
  // the committer date, and the unattended start that wrote the change sits
  // between the two. Commit c03cbb8 was authored 23:06:44 and committed
  // 23:08:22; the start at seq 31684 is at 23:07:58.
  const folded = newFixture("amended-anchor", UNATTENDED_POLICY);
  authorizeSpecEdit(folded, "amended-anchor", 4);
  writeFileSync(join(folded.dir, "SPEC.md"), "new\n", "utf8");
  commit(folded.dir, "edit SPEC.md", {
    GIT_AUTHOR_DATE: minutesAgo(6),
    GIT_COMMITTER_DATE: minutesAgo(2),
  });

  const run = runGuard(folded, ["--head", "HEAD"]);
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  assert.equal(run.report.findings[0]?.path, "SPEC.md");
  assert.equal(run.report.findings[0]?.evidence, "policy-authorized-file");
  // Both dates are named, so a reader can see which question got which.
  assert.match(run.report.findings[0]?.detail ?? "", /authored .*, committed /u);

  // The control: the same log and the same edit on a commit git dated once.
  // The start follows that single date, so it is post-hoc and covers nothing.
  const plain = newFixture("unamended-anchor", UNATTENDED_POLICY);
  authorizeSpecEdit(plain, "unamended-anchor", 4);
  writeFileSync(join(plain.dir, "SPEC.md"), "new\n", "utf8");
  commit(plain.dir, "edit SPEC.md", {
    GIT_AUTHOR_DATE: minutesAgo(6),
    GIT_COMMITTER_DATE: minutesAgo(6),
  });
  const control = runGuard(plain, ["--head", "HEAD"]);
  assert.equal(control.code, 1, `${control.stdout}${control.stderr}`);
});

test("a routed protected-path object is enforced by the script", () => {
  const fixture = newFixture("routed-object", ROUTED_POLICY);
  editSpec(fixture);

  const run = runGuard(fixture, ["--head", "HEAD"]);
  assert.equal(run.code, 1, `${run.stdout}${run.stderr}`);
  assert.equal(run.report.findings[0]?.path, "SPEC.md");
  assert.equal(run.report.findings[0]?.code, "no-evidence");
});

test("a routed protected path removed at head remains enforced from base", () => {
  const fixture = newFixture("routed-object-removed", ROUTED_POLICY);
  const withoutProtectedPaths = POLICY.replace("protected_paths:\n  - SPEC.md\n", "");
  writeFileSync(fixture.unit.policyPath, withoutProtectedPaths, "utf8");
  editSpec(fixture);

  const run = runGuard(fixture, ["--head", "HEAD"]);
  assert.equal(run.code, 1, `${run.stdout}${run.stderr}`);
  const spec = run.report.findings.find((finding) => finding.path === "SPEC.md");
  assert.ok(spec !== undefined, JSON.stringify(run.report.findings));
  assert.equal(spec.code, "no-evidence");
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

// ---------------------------------------------------------------------------
// (d) the unit of judgment is ONE COMMIT (APRV-375)
//
// Carter ruled option B on 2026-09-19 after APRV-357's reproduction (PR #452):
// the guard judges a pull request one commit at a time, base is each commit's
// first parent, and the combined base-to-head replay is retired. What these
// cases pin is that the smaller question is not a weaker one.
// ---------------------------------------------------------------------------

/** A fixture whose SPEC.md starts as three lines, committed as the new base. */
function threeLineFixture(label: string): Fixture {
  const fixture = newFixture(label);
  writeFileSync(join(fixture.dir, "SPEC.md"), "alpha\nbeta\ngamma\n", "utf8");
  const base = commit(fixture.dir, "seed three lines");
  return { ...fixture, base };
}

test("APRV-375: each commit is judged against its own parent, and the verdict is the conjunction", () => {
  const fixture = newFixture("per-commit-chain");
  // Two chained edits, each with its own grant binding its own before-state.
  // Under the retired combined replay the second grant's before-state ("new")
  // does not occur in the blob at BASE, which is what defeated PR #427.
  grantChange(fixture, "chain-one", "SPEC.md", "old", "new");
  grantChange(fixture, "chain-two", "SPEC.md", "new", "newer");
  writeFileSync(join(fixture.dir, "SPEC.md"), "new\n", "utf8");
  const first = commit(fixture.dir, "first edit");
  writeFileSync(join(fixture.dir, "SPEC.md"), "newer\n", "utf8");
  const second = commit(fixture.dir, "second edit");

  const run = runGuard(fixture, ["--head", "HEAD"]);
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  assert.equal(verdictOf(run, first).ok, true);
  assert.equal(verdictOf(run, second).ok, true);
  // Each commit's base is its own parent, and each names the records that
  // covered it, which is what the report is for.
  assert.equal(verdictOf(run, first).base, `${first}^1`);
  assert.equal(verdictOf(run, second).base, `${second}^1`);
  assert.ok(verdictOf(run, second).covered.length > 0, run.stdout);
  assert.match(run.stdout, /judged one commit at a time \(2 commit\(s\) in the range/u);
  assertEveryChangedPathWasJudged(run, fixture.dir, fixture.base, "HEAD", ["SPEC.md"]);
});

test("APRV-375 AC2: a commit with no record of its own fails, and the failure names that commit", () => {
  const fixture = newFixture("per-commit-uncovered");
  grantChange(fixture, "covered-one", "SPEC.md", "old", "new");
  writeFileSync(join(fixture.dir, "SPEC.md"), "new\n", "utf8");
  const granted = commit(fixture.dir, "the granted edit");
  // A second line nobody approved, in its own commit.
  writeFileSync(join(fixture.dir, "SPEC.md"), "new\nsmuggled\n", "utf8");
  const smuggled = commit(fixture.dir, "one more line");

  const run = runGuard(fixture, ["--head", "HEAD"]);
  assert.equal(run.code, 1, `${run.stdout}${run.stderr}`);
  assert.equal(verdictOf(run, granted).ok, true, run.stdout);
  const failed = verdictOf(run, smuggled);
  assert.equal(failed.ok, false);
  assert.equal(failed.findings[0]?.code, "uncovered-hunk");
  // The flattened finding carries the commit, so a reader of the JSON does not
  // have to join two lists to learn which edit is unevidenced.
  const finding = run.report.findings.find((entry) => entry.ok === false);
  assert.equal(finding?.commit, smuggled);
  assert.match(run.stdout, new RegExp(`FAIL ${smuggled.slice(0, 12)}`, "u"));
});

test("APRV-375 AC2: a granted after-state altered by a later commit does not carry that commit", () => {
  const fixture = newFixture("per-commit-altered");
  grantChange(fixture, "altered-one", "SPEC.md", "old", "new");
  writeFileSync(join(fixture.dir, "SPEC.md"), "new\n", "utf8");
  const granted = commit(fixture.dir, "the granted edit");
  // The same bytes the human approved, rewritten with no record at all. The
  // grant is still in the log and still names SPEC.md; exactness is what stops
  // it counting, and per-commit judgment does not change that.
  writeFileSync(join(fixture.dir, "SPEC.md"), "tampered\n", "utf8");
  const altered = commit(fixture.dir, "rewrite the approved line");

  const run = runGuard(fixture, ["--head", "HEAD"]);
  assert.equal(run.code, 1, `${run.stdout}${run.stderr}`);
  assert.equal(verdictOf(run, granted).ok, true, run.stdout);
  assert.equal(verdictOf(run, altered).ok, false);
  assert.equal(verdictOf(run, altered).findings[0]?.code, "uncovered-hunk");
});

test("APRV-375 AC3: work the branch absorbed by merging main is not judged again", () => {
  const fixture = newFixture("absorbed");
  // The lane's own commit, granted, on its own branch.
  assert.equal(git(["checkout", "-q", "-b", "lane"], fixture.dir).code, 0);
  grantSpecEdit(fixture, "absorbed");
  const lane = editSpec(fixture);

  // Main moves meanwhile, with an edit to ANOTHER protected file that nothing
  // in this log authorizes. If the guard judged absorbed commits it would fail
  // this pull request for a commit main already carries.
  assert.equal(git(["checkout", "-q", "main"], fixture.dir).code, 0);
  writeFileSync(join(fixture.dir, "CLAUDE.md"), "someone else's edit\n", "utf8");
  const absorbed = commit(fixture.dir, "main moves");

  // The lane absorbs it, exactly as PR #427's branch did, twice.
  assert.equal(git(["checkout", "-q", "lane"], fixture.dir).code, 0);
  const merged = git(["merge", "--no-edit", "-q", "main"], fixture.dir);
  assert.equal(merged.code, 0, merged.stderr);
  const mergeSha = git(["rev-parse", "HEAD"], fixture.dir).stdout.trim();

  // CI's own base: `git merge-base origin/main HEAD`, which after the absorb is
  // main's tip. That is what makes two-dot `base..head` exclude it.
  const mergeBase = git(["merge-base", "main", "HEAD"], fixture.dir).stdout.trim();
  assert.equal(mergeBase, absorbed);

  const run = runGuardIn(fixture.dir, ["--base", mergeBase, "--head", "HEAD"]);
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  const judged = run.report.commits.map((commit) => commit.sha);
  assert.deepEqual(judged.sort(), [lane, mergeSha].sort());
  assert.ok(!judged.includes(absorbed), `the absorbed commit was judged: ${run.stdout}`);
  assert.ok(
    !run.report.findings.some((finding) => finding.path === "CLAUDE.md"),
    `the absorbed commit's path was judged: ${run.stdout}`,
  );

  // And the control: judged on its OWN range, that same commit fails. The
  // exclusion is about which pull request owes the evidence, never about
  // whether it is owed.
  const control = runGuardIn(fixture.dir, ["--base", `${absorbed}^`, "--head", absorbed]);
  assert.equal(control.code, 1, control.stdout);
  assert.equal(control.report.findings[0]?.path, "CLAUDE.md");
});

test("APRV-375 AC4: a merge that invents a line on a guarded path is judged against its first parent", () => {
  const fixture = threeLineFixture("evil-merge");
  // Both grants are appended before either branch exists, and committed in a
  // commit that touches only the daemon's append surface, so both branches and
  // the merge carry the same log.
  grantChange(fixture, "left", "SPEC.md", "beta", "LEFT");
  grantChange(fixture, "right", "SPEC.md", "beta", "RIGHT");
  const seeded = commit(fixture.dir, "log advance");

  assert.equal(git(["checkout", "-q", "-b", "right"], fixture.dir).code, 0);
  writeFileSync(join(fixture.dir, "SPEC.md"), "alpha\nRIGHT\ngamma\n", "utf8");
  const right = commit(fixture.dir, "right edit");
  assert.equal(git(["checkout", "-q", "main"], fixture.dir).code, 0);
  writeFileSync(join(fixture.dir, "SPEC.md"), "alpha\nLEFT\ngamma\n", "utf8");
  const left = commit(fixture.dir, "left edit");

  // The merge conflicts, and the resolution invents a line that is in NEITHER
  // parent and therefore in no commit's own diff. This is the one shape the
  // per-commit unit could have missed, which is why merges are judged on their
  // dense combined diff.
  assert.notEqual(git(["merge", "--no-edit", "-q", "right"], fixture.dir).code, 0);
  writeFileSync(join(fixture.dir, "SPEC.md"), "alpha\nMERGED\ngamma\n", "utf8");
  const mergeSha = commit(fixture.dir, "resolve the conflict");

  for (const sha of [left, right]) {
    const own = git(["diff", `${sha}^`, sha, "--", "SPEC.md"], fixture.dir);
    assert.ok(
      !own.stdout.includes("+MERGED"),
      `${sha.slice(0, 12)} contains the invented line, so the fixture proves nothing`,
    );
  }

  const run = runGuardIn(fixture.dir, ["--base", seeded, "--head", mergeSha]);
  assert.equal(run.code, 1, `${run.stdout}${run.stderr}`);
  assert.equal(verdictOf(run, left).ok, true, run.stdout);
  assert.equal(verdictOf(run, right).ok, true, run.stdout);
  const merge = verdictOf(run, mergeSha);
  assert.equal(merge.merge, true);
  assert.equal(merge.judged, true);
  assert.equal(merge.ok, false);
  assert.equal(merge.base, `${mergeSha}^1`);
  assert.equal(merge.findings[0]?.path, "SPEC.md");
  assert.match(run.stdout, /merge resolution/u);
  assertEveryChangedPathWasJudged(run, fixture.dir, seeded, mergeSha, ["SPEC.md"]);
});

test("APRV-375 AC4: a merge that takes one parent's bytes verbatim is listed as skipped", () => {
  const fixture = threeLineFixture("clean-merge");
  grantChange(fixture, "clean-left", "SPEC.md", "beta", "LEFT");
  const seeded = commit(fixture.dir, "log advance");

  // The other side touches a different file, so the merge resolves both sides
  // verbatim and invents nothing.
  assert.equal(git(["checkout", "-q", "-b", "side"], fixture.dir).code, 0);
  writeFileSync(join(fixture.dir, "README.md"), "unprotected\n", "utf8");
  commit(fixture.dir, "side edit");
  assert.equal(git(["checkout", "-q", "main"], fixture.dir).code, 0);
  writeFileSync(join(fixture.dir, "SPEC.md"), "alpha\nLEFT\ngamma\n", "utf8");
  const left = commit(fixture.dir, "left edit");
  const merged = git(["merge", "--no-ff", "--no-edit", "-q", "side"], fixture.dir);
  assert.equal(merged.code, 0, merged.stderr);
  const mergeSha = git(["rev-parse", "HEAD"], fixture.dir).stdout.trim();

  const run = runGuardIn(fixture.dir, ["--base", seeded, "--head", mergeSha]);
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  assert.equal(verdictOf(run, left).ok, true, run.stdout);
  const merge = verdictOf(run, mergeSha);
  assert.equal(merge.merge, true);
  assert.equal(merge.judged, false);
  assert.equal(merge.skipped, "clean-merge");
  assert.match(run.stdout, new RegExp(`SKIP ${mergeSha.slice(0, 12)}`, "u"));
  assertEveryChangedPathWasJudged(run, fixture.dir, seeded, mergeSha, ["SPEC.md"]);
});

// ---------------------------------------------------------------------------
// (e) the PR #427 fixture itself, when this checkout carries it (AC1)
// ---------------------------------------------------------------------------

/**
 * PR #427's own commits, replayed from the committed log in THIS repository.
 *
 * Skipped when the checkout cannot reach them, which is the ordinary case in
 * CI: the sharded `full` job clones at depth 1, and only the guard job itself
 * uses `fetch-depth: 0`. A test that failed on a shallow clone would be
 * reporting the clone rather than the guard. Everything it asserts about the
 * per-commit unit is also asserted above on fixtures built through the real
 * append path, so nothing rests on this case alone.
 */
const PR_427 = { base: "6d1b2bbe1dde", head: "e66ba9e689a2" };
const pr427Reachable =
  spawnSync("git", ["cat-file", "-e", `${PR_427.head}^{commit}`], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).status === 0 &&
  spawnSync("git", ["cat-file", "-e", `${PR_427.base}^{commit}`], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).status === 0;

test(
  "APRV-375 AC1: PR #427 passes per commit, on the log its head carries",
  { skip: pr427Reachable ? false : "this checkout does not carry PR #427's commits" },
  () => {
    // `--log-ref <head>` pins the committed log to the 42403-record copy PR
    // #427's head carries, which is what APRV-357's reproduction read. Without
    // it the guard would widen to today's records branches and the case would
    // drift as the log grows.
    const run = runGuardIn(REPO_ROOT, [
      "--base",
      PR_427.base,
      "--head",
      PR_427.head,
      "--log-ref",
      PR_427.head,
    ]);
    assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
    const spec = run.report.findings.filter((finding) => finding.path === "SPEC.md");
    assert.ok(spec.length >= 3, `SPEC.md was judged on ${String(spec.length)} commit(s)`);
    for (const finding of spec) {
      assert.equal(finding.ok, true, finding.detail);
      // AC1's "with no sign-off record present" reads as: the GRANTS carry this
      // pull request. Asserted as the positive — every finding rests on
      // hunk-level evidence, a grant or a policy-authorized execution — rather
      // than as "not attested", because a sign-off at the range head is a
      // legitimate pass for a pull request that needs one, which is what the
      // three `signoff-*` cases above exercise. This one does not need it.
      assert.ok(
        finding.evidence === "granted-file" || finding.evidence === "policy-authorized-file",
        `${finding.commit?.slice(0, 12) ?? "?"} passed on ${String(finding.evidence)}: ${finding.detail}`,
      );
    }
    // Each judged commit is named with its own records.
    for (const commit of run.report.commits.filter((entry) => entry.judged)) {
      assert.ok(commit.covered.length > 0, `${commit.sha.slice(0, 12)} named no records`);
    }
    // Both of the branch's merges of origin/main resolved every guarded path to
    // one parent's bytes, so both are skipped rather than judged for what main
    // did (AC4's clean case, on the real history that motivated the task).
    const merges = run.report.commits.filter((entry) => entry.merge);
    assert.equal(merges.length, 2, run.stdout);
    for (const merge of merges) assert.equal(merge.judged, false, merge.sha);
  },
);

// ---------------------------------------------------------------------------
// (f) whole-file evidence is anchored to the RANGE HEAD, not to a commit
//
// A grant binds a hunk and is evidence about one commit. A sign-off (APRV-338),
// an organ attestation (APRV-272) and the policy attestation are whole-file
// records: a human read the file AS IT NOW STANDS. What they are about is the
// bytes the pull request installs, so every commit in the range is offered the
// digests at the range head. Matched per commit instead, the escape hatch would
// cover only the commit whose blob happened to equal the ratified bytes.
// ---------------------------------------------------------------------------

/** `approval policy attest --path <path>` on the working tree, through the real verb. */
function signOffSpec(fixture: Fixture, minutes = 1): void {
  const signed = appendPathSignOff(
    fixture.unit.logPath,
    { path: "SPEC.md", root: fixture.dir, protectedPaths: ["SPEC.md"] },
    HUMAN,
    { clock: fixedClock(minutesAgo(minutes)) },
  );
  assert.equal(signed.ok, true, JSON.stringify(signed));
}

/**
 * A branch whose FIRST commit has no record of its own and whose second is
 * granted. Returns both shas, with SPEC.md at "signed" on the working tree.
 */
function twoCommitBranch(label: string): { fixture: Fixture; first: string; second: string } {
  const fixture = newFixture(label);
  // No grant for this one: the edit the hook never saw.
  writeFileSync(join(fixture.dir, "SPEC.md"), "ungranted\n", "utf8");
  const first = commit(fixture.dir, "an edit nothing authorized");
  grantChange(fixture, `${label}-two`, "SPEC.md", "ungranted", "signed");
  writeFileSync(join(fixture.dir, "SPEC.md"), "signed\n", "utf8");
  const second = commit(fixture.dir, "a granted edit");
  return { fixture, first, second };
}

test("APRV-375: a sign-off at the range head rescues an earlier commit that has no grant", () => {
  const { fixture, first, second } = twoCommitBranch("signoff-head");
  // The human reads the file as it now stands and ratifies those bytes, then
  // the record is committed with the rest of the log.
  signOffSpec(fixture);
  commit(fixture.dir, "log advance carrying the sign-off");

  const run = runGuard(fixture, ["--head", "HEAD"]);
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);

  // The first commit is covered by the whole-file record, which is what the
  // escape hatch is for: no grant exists for it and none can be made now.
  const rescued = verdictOf(run, first);
  assert.equal(rescued.ok, true, run.stdout);
  assert.equal(rescued.findings[0]?.evidence, "attested");
  assert.match(rescued.findings[0]?.detail ?? "", /gate\.path\.signed_off|signed off/u);

  // The second commit has a grant of its own, and hunk evidence still leads:
  // the evaluator reaches a sign-off only after every grant search has failed
  // (APRV-338's ordering rule, unchanged).
  assert.equal(verdictOf(run, second).findings[0]?.evidence, "granted-file");
});

test("APRV-375: without the sign-off, that same range fails and names the first commit", () => {
  // The same fixture, and the only difference is that nobody ratified the
  // bytes at head. The grant for the second commit was already committed with
  // it, so there is nothing further to commit here.
  const { fixture, first, second } = twoCommitBranch("signoff-absent");

  const run = runGuard(fixture, ["--head", "HEAD"]);
  assert.equal(run.code, 1, `${run.stdout}${run.stderr}`);
  assert.equal(verdictOf(run, first).ok, false);
  assert.equal(verdictOf(run, second).ok, true, run.stdout);
  const failed = run.report.findings.find((finding) => finding.ok === false);
  assert.equal(failed?.commit, first);
  assert.match(run.stdout, new RegExp(`FAIL ${first.slice(0, 12)}`, "u"));
});

test("APRV-375: a sign-off over an INTERMEDIATE commit's bytes covers nothing", () => {
  const fixture = newFixture("signoff-intermediate");
  writeFileSync(join(fixture.dir, "SPEC.md"), "intermediate\n", "utf8");
  const first = commit(fixture.dir, "an edit nothing authorized");
  // Ratified here, at the intermediate bytes — and then the file moves on with
  // no record of its own. A sign-off is about the bytes a human read, and these
  // are not the bytes this pull request installs.
  signOffSpec(fixture, 2);
  writeFileSync(join(fixture.dir, "SPEC.md"), "moved on\n", "utf8");
  const second = commit(fixture.dir, "another edit nothing authorized");

  const run = runGuard(fixture, ["--head", "HEAD"]);
  assert.equal(run.code, 1, `${run.stdout}${run.stderr}`);
  assert.equal(verdictOf(run, first).ok, false, run.stdout);
  assert.equal(verdictOf(run, second).ok, false, run.stdout);
});
