/**
 * The protected-path guard (APRV-151).
 *
 * Every log in this suite is built through the REAL append path — `core/attest`
 * for the attestation, `core/gate`'s `register`/`request`/`decide` for the
 * grants, `core/payload-store` for the bound bytes — and read back through the
 * real verifier. Nothing here hand-writes a jsonl line, which is the same rule
 * the rest of the suite keeps: a guard proved against a fabricated log has been
 * proved against nothing, and this one exists precisely because the log is the
 * only witness left when a session's hook does not fire.
 *
 * What is asserted: each of the three evidence verdicts, the two fail-closed
 * log codes, the no-evidence failure and the ordering rule its message has to
 * carry, and the exemption that keeps a records / log-advance pull request from
 * tripping on the evidence it is carrying.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { appendAttestation } from "../src/core/attest.js";
import { decide, register, request } from "../src/core/gate.js";
import type { EventRecord } from "../src/core/log.js";
import { payloadHash } from "../src/core/payload.js";
import {
  evaluateProtectedPaths,
  isGuardedPath,
  renderGuardReport,
  type GuardInput,
  type LogWindow,
} from "../src/core/protected-path-guard.js";
import { verifyWithRecords } from "../src/core/verify.js";
import { at, fixedClock, newScenario, scratchRoot, type Scenario } from "./scenario.js";

const HUMAN = "human:carter";
const AGENT = "agent:claude-code";

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
  "  policy.edit:",
  "    autonomy: manual",
  "```",
  "",
].join("\n");

const WINDOW: LogWindow = {
  firstSeq: 1,
  lastSeq: 9,
  firstTs: at(0),
  lastTs: at(9),
  base: "aaaaaaaaaaaa",
  head: "bbbbbbbbbbbb",
};

/** The payload material the hook binds for a file-tool edit (APRV-124). */
function fileMaterial(file: string): Record<string, unknown> {
  return {
    tool: "Edit",
    rule: "protected path",
    file,
    before: "old",
    after: "new",
  };
}

/** The payload material the hook binds for a shell command. */
function commandMaterial(command: string): Record<string, unknown> {
  return { command, cwd: "/Users/carter/dev/approval-md" };
}

interface World {
  unit: Scenario;
  /** Bound material by hash, standing in for the committed payload store. */
  store: Map<string, unknown>;
}

/** A scenario with the policy attested, ready for grants. */
function world(root: string): World {
  const unit = newScenario(root, POLICY);
  const attested = appendAttestation(unit.logPath, unit.policyPath, HUMAN, {
    clock: fixedClock(at(0)),
  });
  assert.equal(attested.ok, true, "attestation append failed");
  return { unit, store: new Map() };
}

/**
 * Register, request and grant one `policy.edit` action bound to `material`,
 * entirely through the gate. Returns the grant record.
 */
function grantEdit(world: World, key: string, material: unknown, minute: number): EventRecord {
  const hash = payloadHash(material);
  const task = `hook:${key}`;
  const actionKey = `${task}:policy.edit`;

  const registered = register(
    world.unit.logPath,
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
    { ...world.unit.options, clock: fixedClock(at(minute)) },
  );
  assert.equal(registered.ok, true, registered.ok ? "" : registered.message);

  const requested = request(
    world.unit.logPath,
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
    { ...world.unit.options, clock: fixedClock(at(minute)) },
  );
  assert.equal(requested.ok, true, JSON.stringify(requested));

  const granted = decide(world.unit.logPath, actionKey, "grant", HUMAN, {
    ...world.unit.options,
    clock: fixedClock(at(minute + 1)),
  });
  assert.equal(granted.ok, true, JSON.stringify(granted));
  if (!granted.ok) throw new Error("unreachable");

  world.store.set(hash, material);
  return granted.record;
}

/** The verified records of a scenario's log, exactly as the guard demands them. */
function verified(unit: Scenario): EventRecord[] {
  const outcome = verifyWithRecords(unit.logPath);
  assert.equal(outcome.result.status, "clean", JSON.stringify(outcome.result));
  return outcome.records;
}

function inputFor(
  world: World,
  changedPaths: readonly string[],
  overrides: Partial<GuardInput> = {},
): GuardInput {
  return {
    changedPaths,
    records: verified(world.unit),
    logStatus: "ok",
    policyProtectedPaths: ["SPEC.md"],
    policySha256AtHead: null,
    policyPath: "APPROVAL.md",
    payloadFor: (hash) => world.store.get(hash) ?? null,
    // The commit that changed the path lands a minute after the grant, which is
    // the ordinary order; the staleness suite overrides it.
    changeTsFor: () => at(3),
    window: WINDOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// what counts as guarded
// ---------------------------------------------------------------------------

test("the guarded set is the hook's protected set minus the daemon's own append surface", () => {
  const extra = ["SPEC.md"];
  for (const path of [
    "SPEC.md",
    "APPROVAL.md",
    "CLAUDE.md",
    "AGENTS.md",
    ".github/workflows/ci.yml",
    ".claude/settings.json",
    ".approval/vault.enc",
  ]) {
    assert.equal(isGuardedPath(path, extra), true, `${path} should be guarded`);
  }
  // The evidence a records pull request carries is not a protected write.
  for (const path of [
    ".approval/log/events.jsonl",
    ".approval/payloads/" + "a".repeat(64) + ".json",
    ".approval/QUEUE.md",
  ]) {
    assert.equal(isGuardedPath(path, extra), false, `${path} should be exempt`);
  }
  // And nothing outside the protected set is dragged in.
  for (const path of ["src/core/gate.ts", "tests/gate.test.ts", "README.md"]) {
    assert.equal(isGuardedPath(path, extra), false, `${path} should be ordinary`);
  }
});

test("a change touching no protected path passes with nothing to check", () => {
  const { root, cleanup } = scratchRoot("guard-clean");
  try {
    const unit = world(root);
    const report = evaluateProtectedPaths(inputFor(unit, ["src/core/gate.ts", "README.md"]));
    assert.equal(report.ok, true);
    assert.equal(report.findings.length, 0);
    assert.match(renderGuardReport(report), /no protected paths changed/u);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// evidence
// ---------------------------------------------------------------------------

test("a file-tool grant naming the path is path-level evidence", () => {
  const { root, cleanup } = scratchRoot("guard-file");
  try {
    const unit = world(root);
    const grant = grantEdit(
      unit,
      "one",
      fileMaterial("/Users/carter/dev/approval-md/.claude/worktrees/aprv-145-land/SPEC.md"),
      1,
    );

    const report = evaluateProtectedPaths(inputFor(unit, ["SPEC.md"]));
    assert.equal(report.ok, true, JSON.stringify(report.findings));
    const [finding] = report.findings;
    assert.equal(finding?.evidence, "granted-file");
    assert.equal(finding?.seq, grant.seq);
    assert.equal(finding?.actor, HUMAN);
  } finally {
    cleanup();
  }
});

test("a grant whose bound path is a DIFFERENT file is not evidence", () => {
  const { root, cleanup } = scratchRoot("guard-other");
  try {
    const unit = world(root);
    grantEdit(unit, "one", fileMaterial("/Users/carter/dev/approval-md/CLAUDE.md"), 1);

    const report = evaluateProtectedPaths(inputFor(unit, ["SPEC.md"]));
    assert.equal(report.ok, false);
    assert.equal(report.findings[0]?.code, "no-evidence");
    // One approved edit may never launder another: the class-level grant is
    // named in the diagnosis and is not a verdict.
    assert.match(report.findings[0]?.detail ?? "", /none naming this path/u);
  } finally {
    cleanup();
  }
});

test("a granted command that WRITES the path is evidence", () => {
  const { root, cleanup } = scratchRoot("guard-command");
  try {
    const unit = world(root);
    grantEdit(unit, "one", commandMaterial("cp /tmp/draft.md /repo/SPEC.md"), 1);

    const hit = evaluateProtectedPaths(inputFor(unit, ["SPEC.md"]));
    assert.equal(hit.ok, true, JSON.stringify(hit.findings));
    assert.equal(hit.findings[0]?.evidence, "granted-command");
    assert.match(hit.findings[0]?.detail ?? "", /writes this path/u);
  } finally {
    cleanup();
  }
});

test("a granted command that only MENTIONS the path is not evidence", () => {
  const { root, cleanup } = scratchRoot("guard-mention");
  try {
    // Both of these passed the first draft of this guard, which substring
    // matched. `cat` reads, and the `hook classify` line is the real one the
    // proof run against the committed log turned up: an approved command whose
    // arguments merely contain the words `SPEC.md`.
    for (const [label, command] of [
      ["read", "cat SPEC.md"],
      ["classify", "node cli.js hook classify -- vi SPEC.md"],
      ["lookalike", "cp /tmp/draft.md /repo/OLDSPEC.md"],
    ] as const) {
      const unit = world(root);
      grantEdit(unit, label, commandMaterial(command), 1);
      const report = evaluateProtectedPaths(inputFor(unit, ["SPEC.md"]));
      assert.equal(report.ok, false, `${label}: ${JSON.stringify(report.findings)}`);
      assert.equal(report.findings[0]?.code, "no-evidence", label);
    }
  } finally {
    cleanup();
  }
});

test("the policy file passes on its attestation record, with no policy.edit grant", () => {
  const { root, cleanup } = scratchRoot("guard-attest");
  try {
    const unit = world(root);
    // The attestation `appendAttestation` wrote binds the policy bytes on disk.
    const records = verified(unit.unit);
    const attestation = records.find((record) => record.event === "policy.updated");
    assert.ok(attestation, "no attestation record");
    const sha = (attestation.payload as Record<string, unknown>)["sha256"];
    assert.equal(typeof sha, "string");

    const report = evaluateProtectedPaths(
      inputFor(unit, ["APPROVAL.md"], { policySha256AtHead: sha as string }),
    );
    assert.equal(report.ok, true, JSON.stringify(report.findings));
    assert.equal(report.findings[0]?.evidence, "attested");
    assert.equal(report.findings[0]?.seq, attestation.seq);
  } finally {
    cleanup();
  }
});

test("a policy change whose bytes nothing attests fails, and says how amendments land", () => {
  const { root, cleanup } = scratchRoot("guard-unattested");
  try {
    const unit = world(root);
    const report = evaluateProtectedPaths(
      inputFor(unit, ["APPROVAL.md"], { policySha256AtHead: "f".repeat(64) }),
    );
    assert.equal(report.ok, false);
    assert.equal(report.findings[0]?.code, "no-evidence");
    assert.match(report.findings[0]?.detail ?? "", /approval policy amend --commit/u);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// the records pull request, and the lag
// ---------------------------------------------------------------------------

test("a records / log-advance change is exempt rather than unevidenced", () => {
  const { root, cleanup } = scratchRoot("guard-records");
  try {
    const unit = world(root);
    const report = evaluateProtectedPaths(
      inputFor(unit, [
        ".approval/log/events.jsonl",
        ".approval/QUEUE.md",
        `.approval/payloads/${"b".repeat(64)}.json`,
        "backlog/tasks/task-1 - Something.md",
      ]),
    );
    assert.equal(report.ok, true, JSON.stringify(report.findings));
    assert.equal(report.findings.length, 0);
    assert.equal(report.exempt.length, 3);
    assert.match(renderGuardReport(report), /exempt/u);
  } finally {
    cleanup();
  }
});

test("the failure states the ordering rule the log's lag implies, and the window searched", () => {
  const { root, cleanup } = scratchRoot("guard-lag");
  try {
    const unit = world(root);
    const report = evaluateProtectedPaths(inputFor(unit, [".github/workflows/ci.yml"]));
    assert.equal(report.ok, false);
    const detail = report.findings[0]?.detail ?? "";
    assert.match(detail, /\.github\/workflows\/ci\.yml/u);
    assert.match(detail, /must merge to main before or with this pull request/u);
    assert.match(detail, /seq 1\.\.9/u);
    assert.match(detail, /bbbbbbbbbbbb/u);
  } finally {
    cleanup();
  }
});

test("a grant that names the path but predates the change by too much is stale", () => {
  const { root, cleanup } = scratchRoot("guard-stale");
  try {
    const unit = world(root);
    grantEdit(unit, "one", fileMaterial("/repo/SPEC.md"), 1);

    // The commit landed a fortnight after the grant. This is the real shape the
    // proof run turned up: a `git add SPEC.md` granted on 2026-08-20 was being
    // read as evidence for a SPEC.md edit made on 2026-08-29.
    const late = at(60 * 24 * 14);
    const report = evaluateProtectedPaths(inputFor(unit, ["SPEC.md"], { changeTsFor: () => late }));
    assert.equal(report.ok, false);
    assert.equal(report.findings[0]?.code, "no-evidence");
    assert.match(report.findings[0]?.detail ?? "", /outside the recency bound/u);
    assert.match(report.findings[0]?.detail ?? "", /not this one/u);

    // The same grant inside the bound passes.
    const near = at(60 * 24);
    const ok = evaluateProtectedPaths(inputFor(unit, ["SPEC.md"], { changeTsFor: () => near }));
    assert.equal(ok.ok, true, JSON.stringify(ok.findings));
  } finally {
    cleanup();
  }
});

test("with no usable anchor NO recency bound is applied, and the finding says so", () => {
  const { root, cleanup } = scratchRoot("guard-noanchor");
  try {
    const unit = world(root);
    // A grant from long before anything: with an anchor this would be stale.
    grantEdit(unit, "one", fileMaterial("/repo/SPEC.md"), 1);

    // git named no date, and git named a date that does not parse. Both are
    // "no anchor", and neither may report a bound it did not enforce.
    for (const anchor of [null, "not-a-date"]) {
      const report = evaluateProtectedPaths(
        inputFor(unit, ["SPEC.md"], { changeTsFor: () => anchor }),
      );
      assert.equal(report.ok, true, `${anchor}: ${JSON.stringify(report.findings)}`);
      const detail = report.findings[0]?.detail ?? "";
      assert.match(detail, /NO recency bound was applied/u);
      assert.match(detail, /rests on the path match alone/u);
      // It must never claim the bound it skipped.
      assert.doesNotMatch(detail, /within \d+d of the commit/u);
    }
  } finally {
    cleanup();
  }
});

test("the finding names the nearest and strongest grant, not the first one found", () => {
  const { root, cleanup } = scratchRoot("guard-nearest");
  try {
    const unit = world(root);
    // Three qualifying grants for the same path, in log order: a distant
    // command, a distant file edit, and the file edit that actually authorized
    // the change. The first-match version reported the first of these, which is
    // how commit 41d2c9f came to pass on a `cp SPEC.md <dir>/` from four days
    // earlier while the real grant sat 95 seconds before the commit.
    grantEdit(unit, "far-cmd", commandMaterial("cp SPEC.md /elsewhere/"), 1);
    grantEdit(unit, "far-file", fileMaterial("/repo/SPEC.md"), 3);
    const near = grantEdit(unit, "near-file", fileMaterial("/repo/SPEC.md"), 600);

    const report = evaluateProtectedPaths(
      inputFor(unit, ["SPEC.md"], { changeTsFor: () => at(602) }),
    );
    assert.equal(report.ok, true, JSON.stringify(report.findings));
    const finding = report.findings[0];
    assert.equal(finding?.evidence, "granted-file");
    assert.equal(finding?.seq, near.seq, "the guard did not pick the nearest grant");
    assert.match(finding?.detail ?? "", /nearest and strongest of 3 qualifying grants/u);
  } finally {
    cleanup();
  }
});

test("a stronger evidence kind wins over a nearer weaker one", () => {
  const { root, cleanup } = scratchRoot("guard-stronger");
  try {
    const unit = world(root);
    const file = grantEdit(unit, "file", fileMaterial("/repo/SPEC.md"), 1);
    grantEdit(unit, "cmd", commandMaterial("cp draft.md /repo/SPEC.md"), 30);

    // The command grant is nearer the change; the file grant binds the actual
    // bytes, so it is the one a reader should be pointed at.
    const report = evaluateProtectedPaths(
      inputFor(unit, ["SPEC.md"], { changeTsFor: () => at(32) }),
    );
    assert.equal(report.ok, true, JSON.stringify(report.findings));
    assert.equal(report.findings[0]?.evidence, "granted-file");
    assert.equal(report.findings[0]?.seq, file.seq);
  } finally {
    cleanup();
  }
});

test("attestation is exempt from the recency bound, because it matches content", () => {
  const { root, cleanup } = scratchRoot("guard-attest-old");
  try {
    const unit = world(root);
    const attestation = verified(unit.unit).find((record) => record.event === "policy.updated");
    assert.ok(attestation);
    const sha = (attestation.payload as Record<string, unknown>)["sha256"] as string;

    const report = evaluateProtectedPaths(
      inputFor(unit, ["APPROVAL.md"], {
        policySha256AtHead: sha,
        changeTsFor: () => at(60 * 24 * 400),
      }),
    );
    assert.equal(report.ok, true, JSON.stringify(report.findings));
    assert.equal(report.findings[0]?.evidence, "attested");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// fail closed
// ---------------------------------------------------------------------------

test("a missing log fails closed with its own code", () => {
  const { root, cleanup } = scratchRoot("guard-nolog");
  try {
    const unit = world(root);
    const report = evaluateProtectedPaths(
      inputFor(unit, ["SPEC.md"], { records: null, logStatus: "missing" }),
    );
    assert.equal(report.ok, false);
    assert.equal(report.findings[0]?.code, "log-missing");
  } finally {
    cleanup();
  }
});

test("a log that does not verify is never read for evidence", () => {
  const { root, cleanup } = scratchRoot("guard-badlog");
  try {
    const unit = world(root);
    grantEdit(unit, "one", fileMaterial("/repo/SPEC.md"), 1);
    // The grant IS in this log; an unverified chain still refuses to use it.
    const report = evaluateProtectedPaths(
      inputFor(unit, ["SPEC.md"], {
        records: null,
        logStatus: "unverified",
        logDetail: "hash-mismatch at seq 4",
      }),
    );
    assert.equal(report.ok, false);
    assert.equal(report.findings[0]?.code, "log-unverified");
    assert.match(report.findings[0]?.detail ?? "", /hash-mismatch at seq 4/u);
    assert.match(report.findings[0]?.detail ?? "", /unverified records/u);
  } finally {
    cleanup();
  }
});

test("a grant whose payload the committed store does not carry is not evidence", () => {
  const { root, cleanup } = scratchRoot("guard-unresolved");
  try {
    const unit = world(root);
    grantEdit(unit, "one", fileMaterial("/repo/SPEC.md"), 1);
    // The store the head tree carries is empty: the bytes cannot be read, so
    // the grant proves nothing about which path it authorized.
    const report = evaluateProtectedPaths(
      inputFor(unit, ["SPEC.md"], { payloadFor: () => null }),
    );
    assert.equal(report.ok, false);
    assert.equal(report.findings[0]?.code, "no-evidence");
    assert.match(report.findings[0]?.detail ?? "", /could not be resolved/u);
  } finally {
    cleanup();
  }
});

test("several protected paths are reported one by one, passes beside failures", () => {
  const { root, cleanup } = scratchRoot("guard-mixed");
  try {
    const unit = world(root);
    grantEdit(unit, "one", fileMaterial("/repo/CLAUDE.md"), 1);
    const report = evaluateProtectedPaths(inputFor(unit, ["CLAUDE.md", "SPEC.md"]));
    assert.equal(report.ok, false);
    assert.equal(report.findings.length, 2);
    assert.equal(report.findings[0]?.ok, true);
    assert.equal(report.findings[1]?.ok, false);
    const rendered = renderGuardReport(report);
    assert.match(rendered, /PASS CLAUDE\.md \[granted-file\]/u);
    assert.match(rendered, /FAIL SPEC\.md \[no-evidence\]/u);
  } finally {
    cleanup();
  }
});
