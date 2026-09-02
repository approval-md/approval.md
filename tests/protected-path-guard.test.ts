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
import { consumeHarnessGrant, decide, register, request } from "../src/core/gate.js";
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

/**
 * The checkout a granted command ran in. Command attribution anchors the
 * write to it (APRV-202): a granted `cp` into a scratch copy of SPEC.md is a
 * grant for that copy, and this repository's file is somewhere else.
 */
const CHECKOUT = "/Users/carter/dev/approval-md";

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
function fileMaterial(
  file: string,
  before = "old",
  after = "new",
): Record<string, unknown> {
  return {
    tool: "Edit",
    rule: "protected path",
    file,
    before,
    after,
  };
}

/** The material a Write binds: the whole intended file (APRV-124). */
function writeMaterial(file: string, content: string): Record<string, unknown> {
  return { tool: "Write", rule: "protected path", file, content };
}

/** The payload material the hook binds for a shell command. */
function commandMaterial(command: string): Record<string, unknown> {
  return { command, cwd: CHECKOUT };
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

/**
 * Spend a grant the way the hook does, appending the `execution.started` a
 * command grant is attributed through (APRV-202). Through `core/gate.ts`, so
 * the record is the real one rather than a shape a test invented.
 */
function spendGrant(world: World, key: string, material: unknown, minute: number): EventRecord {
  const actionKey = `hook:${key}:policy.edit`;
  const spent = consumeHarnessGrant(world.unit.logPath, actionKey, AGENT, {
    ...world.unit.options,
    clock: fixedClock(at(minute)),
    presentedPayloadHash: payloadHash(material),
  });
  assert.equal(spent.ok, true, JSON.stringify(spent));
  if (!spent.ok) throw new Error("unreachable");
  return spent.record;
}

/** A granted command that was granted AND run: the shape PR #187 has. */
function grantAndRunCommand(
  world: World,
  key: string,
  command: string,
  minute: number,
): EventRecord {
  const material = commandMaterial(command);
  const grant = grantEdit(world, key, material, minute);
  spendGrant(world, key, material, minute + 2);
  return grant;
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
    // The change itself, which is what coverage is asked about (APRV-202). The
    // default is exactly the edit `fileMaterial` binds: one line out, one line
    // in. Every suite that cares about the diff overrides it.
    blobsFor: () => ({ base: "old\n", head: "new\n" }),
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

test("a granted command that WRITES the path, and ran, is evidence", () => {
  const { root, cleanup } = scratchRoot("guard-command");
  try {
    const unit = world(root);
    grantAndRunCommand(unit, "one", `cp /tmp/draft.md ${CHECKOUT}/SPEC.md`, 1);

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
    grantAndRunCommand(unit, "far-cmd", "cp SPEC.md /elsewhere/", 1);
    grantEdit(unit, "far-file", fileMaterial("/repo/SPEC.md"), 3);
    const near = grantEdit(unit, "near-file", fileMaterial("/repo/SPEC.md"), 600);

    const report = evaluateProtectedPaths(
      inputFor(unit, ["SPEC.md"], { changeTsFor: () => at(602) }),
    );
    assert.equal(report.ok, true, JSON.stringify(report.findings));
    const finding = report.findings[0];
    assert.equal(finding?.evidence, "granted-file");
    assert.equal(finding?.seq, near.seq, "the guard did not pick the nearest grant");
    // Two of the three cover: the distant command's run is ten hours from the
    // commit, outside the attribution window, so it contributes nothing.
    assert.match(finding?.detail ?? "", /assembled from 2 grants/u);
    assert.equal(finding?.coveredBy?.[0], near.seq);
  } finally {
    cleanup();
  }
});

test("a stronger evidence kind wins over a nearer weaker one", () => {
  const { root, cleanup } = scratchRoot("guard-stronger");
  try {
    const unit = world(root);
    const file = grantEdit(unit, "file", fileMaterial("/repo/SPEC.md"), 1);
    grantAndRunCommand(unit, "cmd", "cp draft.md SPEC.md", 30);

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
// hunk-level coverage (APRV-202)
// ---------------------------------------------------------------------------

/** A blob, as lines. */
function blob(...lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

test("the exact granted edit passes, and the finding says the hunks all trace", () => {
  const { root, cleanup } = scratchRoot("guard-exact");
  try {
    const unit = world(root);
    const grant = grantEdit(
      unit,
      "one",
      fileMaterial("/repo/SPEC.md", "the old sentence", "the new sentence"),
      1,
    );

    const report = evaluateProtectedPaths(
      inputFor(unit, ["SPEC.md"], {
        blobsFor: () => ({
          base: blob("preamble", "the old sentence", "tail"),
          head: blob("preamble", "the new sentence", "tail"),
        }),
      }),
    );
    assert.equal(report.ok, true, JSON.stringify(report.findings));
    const finding = report.findings[0];
    assert.equal(finding?.evidence, "granted-file");
    assert.equal(finding?.seq, grant.seq);
    assert.deepEqual(finding?.coveredBy, [grant.seq]);
    assert.match(finding?.detail ?? "", /1 added and 1 removed line\(s\) all trace/u);
  } finally {
    cleanup();
  }
});

test("a REPEAT edit inside the window does not inherit the first edit's grant", () => {
  const { root, cleanup } = scratchRoot("guard-repeat");
  try {
    const unit = world(root);
    // One grant, for the first edit. The second edit — same file, same week,
    // no grant of its own — is the hole APRV-202 closes: before it, this
    // passed on the grant above, which is how PR #187, #196 and #207 passed.
    grantEdit(unit, "one", fileMaterial("/repo/SPEC.md", "first before", "first after"), 1);

    const report = evaluateProtectedPaths(
      inputFor(unit, ["SPEC.md"], {
        blobsFor: () => ({
          base: blob("preamble", "first before", "tail"),
          head: blob("preamble", "first after", "an ungranted second edit", "tail"),
        }),
      }),
    );
    assert.equal(report.ok, false, JSON.stringify(report.findings));
    const finding = report.findings[0];
    assert.equal(finding?.code, "uncovered-hunk");
    assert.deepEqual(finding?.uncovered, ["+an ungranted second edit"]);
    assert.match(finding?.detail ?? "", /naming is not coverage/u);
    // The grant that DOES name the path is diagnosis, never a verdict.
    assert.match(finding?.detail ?? "", /1 grant name(s)? this path/u);
  } finally {
    cleanup();
  }
});

test("a granted edit whose after-state never landed covers nothing", () => {
  const { root, cleanup } = scratchRoot("guard-notlanded");
  try {
    const unit = world(root);
    grantEdit(unit, "one", fileMaterial("/repo/SPEC.md", "before", "the approved wording"), 1);

    const report = evaluateProtectedPaths(
      inputFor(unit, ["SPEC.md"], {
        blobsFor: () => ({
          base: blob("before"),
          head: blob("some other wording entirely"),
        }),
      }),
    );
    assert.equal(report.ok, false);
    assert.equal(report.findings[0]?.code, "uncovered-hunk");
    assert.match(report.findings[0]?.detail ?? "", /is not the edit that landed/u);
  } finally {
    cleanup();
  }
});

test("a Write grant whose content IS the blob at head covers the whole path", () => {
  const { root, cleanup } = scratchRoot("guard-write");
  try {
    const unit = world(root);
    const head = blob("line one", "line two", "line three");
    const grant = grantEdit(unit, "one", writeMaterial("/repo/CLAUDE.md", head), 1);

    const report = evaluateProtectedPaths(
      inputFor(unit, ["CLAUDE.md"], {
        blobsFor: () => ({ base: blob("something else"), head }),
      }),
    );
    assert.equal(report.ok, true, JSON.stringify(report.findings));
    assert.equal(report.findings[0]?.evidence, "granted-file");
    assert.equal(report.findings[0]?.seq, grant.seq);
    assert.match(report.findings[0]?.detail ?? "", /ARE the blob at head/u);

    // The same grant against a file that then drifted covers nothing whole.
    const drifted = evaluateProtectedPaths(
      inputFor(unit, ["CLAUDE.md"], {
        blobsFor: () => ({ base: blob("something else"), head: blob("line one", "smuggled") }),
      }),
    );
    assert.equal(drifted.ok, false);
    assert.equal(drifted.findings[0]?.code, "uncovered-hunk");
    // A whole-file write covers all or nothing: bytes that are neither the head
    // blob nor contained in it describe a file that is not this one, so every
    // line of the change is uncovered rather than the smuggled one alone.
    assert.deepEqual(drifted.findings[0]?.uncovered, [
      "+line one",
      "+smuggled",
      "-something else",
    ]);
    assert.match(drifted.findings[0]?.detail ?? "", /neither equal to nor contained in/u);
  } finally {
    cleanup();
  }
});

test("coverage assembles from several grants when a pull request carries several edits", () => {
  const { root, cleanup } = scratchRoot("guard-assembled");
  try {
    const unit = world(root);
    const first = grantEdit(unit, "one", fileMaterial("/repo/SPEC.md", "old A", "new A"), 1);
    const second = grantEdit(unit, "two", fileMaterial("/repo/SPEC.md", "old B", "new B"), 10);

    const report = evaluateProtectedPaths(
      inputFor(unit, ["SPEC.md"], {
        changeTsFor: () => at(12),
        blobsFor: () => ({
          base: blob("head", "old A", "middle", "old B", "tail"),
          head: blob("head", "new A", "middle", "new B", "tail"),
        }),
      }),
    );
    assert.equal(report.ok, true, JSON.stringify(report.findings));
    assert.equal(report.findings[0]?.coveredBy?.length, 2);
    assert.match(report.findings[0]?.detail ?? "", /assembled from 2 grants/u);
    assert.equal(report.findings[0]?.seq, second.seq, "the nearest grant should lead");
    assert.ok(report.findings[0]?.coveredBy?.includes(first.seq));
  } finally {
    cleanup();
  }
});

test("a reordering is an uncovered hunk, not an empty diff", () => {
  const { root, cleanup } = scratchRoot("guard-reorder");
  try {
    const unit = world(root);
    grantEdit(unit, "one", fileMaterial("/repo/SPEC.md", "old", "new"), 1);

    const report = evaluateProtectedPaths(
      inputFor(unit, ["SPEC.md"], {
        blobsFor: () => ({
          base: blob("clause one", "clause two"),
          head: blob("clause two", "clause one"),
        }),
      }),
    );
    assert.equal(report.ok, false, JSON.stringify(report.findings));
    assert.equal(report.findings[0]?.code, "uncovered-hunk");
    assert.match(report.findings[0]?.detail ?? "", /different order/u);
  } finally {
    cleanup();
  }
});

test("a change that alters no substantive line still needs a grant naming the path", () => {
  const { root, cleanup } = scratchRoot("guard-quiet");
  try {
    const unit = world(root);
    const same = { base: blob("clause", "", "tail"), head: blob("clause", "tail") };

    // No grant at all: a mode or whitespace change to a protected path is still
    // a change, and the pre-APRV-202 rule stands for it.
    const bare = evaluateProtectedPaths(inputFor(unit, ["SPEC.md"], { blobsFor: () => same }));
    assert.equal(bare.ok, false);
    assert.equal(bare.findings[0]?.code, "no-evidence");

    grantEdit(unit, "one", fileMaterial("/repo/SPEC.md"), 1);
    const granted = evaluateProtectedPaths(inputFor(unit, ["SPEC.md"], { blobsFor: () => same }));
    assert.equal(granted.ok, true, JSON.stringify(granted.findings));
    assert.match(granted.findings[0]?.detail ?? "", /no substantive hunks to cover/u);
  } finally {
    cleanup();
  }
});

test("a change whose bytes cannot be read fails rather than falling back to the path", () => {
  const { root, cleanup } = scratchRoot("guard-unreadable");
  try {
    const unit = world(root);
    grantEdit(unit, "one", fileMaterial("/repo/SPEC.md"), 1);
    const report = evaluateProtectedPaths(inputFor(unit, ["SPEC.md"], { blobsFor: () => null }));
    assert.equal(report.ok, false);
    assert.equal(report.findings[0]?.code, "change-unreadable");
    assert.match(report.findings[0]?.detail ?? "", /naming is not coverage/u);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// command grants: attribution rather than coverage (APRV-202)
// ---------------------------------------------------------------------------

test("a command batch passes on its OWN granted run and not on a later edit", () => {
  const { root, cleanup } = scratchRoot("guard-batch");
  try {
    const unit = world(root);
    // The PR #187 shape: one approved script run that rewrites the file.
    const grant = grantAndRunCommand(
      unit,
      "batch",
      `node scripts/apply.mjs ${CHECKOUT}/CLAUDE.md`,
      1,
    );
    const changed = {
      base: blob("head", "old body", "tail"),
      head: blob("head", "rewritten body", "tail"),
    };

    const own = evaluateProtectedPaths(
      inputFor(unit, ["CLAUDE.md"], { changeTsFor: () => at(5), blobsFor: () => changed }),
    );
    assert.equal(own.ok, true, JSON.stringify(own.findings));
    assert.equal(own.findings[0]?.evidence, "granted-command");
    assert.equal(own.findings[0]?.seq, grant.seq);
    assert.match(own.findings[0]?.detail ?? "", /attribution window|brackets the commit/u);

    // A later, unrelated edit to the same file. The grant is still inside the
    // seven-day path window, and its RUN is a day away from this commit, so it
    // attributes nothing: the batch produced some earlier change, not this one.
    const later = evaluateProtectedPaths(
      inputFor(unit, ["CLAUDE.md"], {
        changeTsFor: () => at(60 * 24),
        blobsFor: () => ({
          base: changed.head,
          head: blob("head", "rewritten body", "a later ungranted edit", "tail"),
        }),
      }),
    );
    assert.equal(later.ok, false, JSON.stringify(later.findings));
    assert.equal(later.findings[0]?.code, "uncovered-hunk");
    assert.match(later.findings[0]?.detail ?? "", /outside the .* attribution window/u);
  } finally {
    cleanup();
  }
});

test("a granted command nobody ran attributes nothing", () => {
  const { root, cleanup } = scratchRoot("guard-unspent");
  try {
    const unit = world(root);
    // Granted and never spent: no execution.started, so the log does not say
    // the command ever ran, and a command that never ran wrote no bytes.
    grantEdit(unit, "one", commandMaterial(`cp /tmp/draft.md ${CHECKOUT}/SPEC.md`), 1);

    const report = evaluateProtectedPaths(
      inputFor(unit, ["SPEC.md"], {
        blobsFor: () => ({ base: blob("old"), head: blob("new") }),
      }),
    );
    assert.equal(report.ok, false, JSON.stringify(report.findings));
    assert.equal(report.findings[0]?.code, "uncovered-hunk");
    assert.match(report.findings[0]?.detail ?? "", /never spent/u);
  } finally {
    cleanup();
  }
});

test("a granted command that ran AFTER the commit did not produce it", () => {
  const { root, cleanup } = scratchRoot("guard-after");
  try {
    const unit = world(root);
    // Granted and run four hours after the commit: inside a symmetric window
    // and behind the change in time. This is the real shape that would have
    // laundered PR #187's SPEC.md change onto an APRV-203 batch the next day.
    grantAndRunCommand(unit, "late", `node scripts/apply.mjs ${CHECKOUT}/SPEC.md`, 60 * 4);

    const report = evaluateProtectedPaths(
      inputFor(unit, ["SPEC.md"], {
        changeTsFor: () => at(1),
        blobsFor: () => ({ base: blob("old"), head: blob("new") }),
      }),
    );
    assert.equal(report.ok, false, JSON.stringify(report.findings));
    assert.equal(report.findings[0]?.code, "uncovered-hunk");
    assert.match(report.findings[0]?.detail ?? "", /AFTER the commit/u);
  } finally {
    cleanup();
  }
});

test("a granted command that wrote a COPY of the path elsewhere covers nothing", () => {
  const { root, cleanup } = scratchRoot("guard-dryrun");
  try {
    const unit = world(root);
    // The real shape from the log: PR #187's SPEC.md change had three grants
    // whose commands wrote `$SCRATCH/dry/SPEC.md`, a dry run into a temporary
    // directory. Every one classifies policy.edit on a path ending SPEC.md,
    // and not one of them touched the file the pull request changed.
    grantAndRunCommand(unit, "dry", "cp /repo/SPEC.md /tmp/scratch/dry/SPEC.md", 1);

    const report = evaluateProtectedPaths(
      inputFor(unit, ["SPEC.md"], {
        blobsFor: () => ({ base: blob("old"), head: blob("new") }),
      }),
    );
    assert.equal(report.ok, false, JSON.stringify(report.findings));
    assert.equal(report.findings[0]?.code, "uncovered-hunk");
    assert.match(report.findings[0]?.detail ?? "", /a copy of the file elsewhere/u);
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
