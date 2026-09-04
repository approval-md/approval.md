/**
 * Harness version provenance (APRV-227).
 *
 * Three layers, in the order the value moves:
 *
 *  - the pure half of `core/harness-version.ts` — the normalizer both the
 *    writer and the reader call, and the strict read of an already-written
 *    payload;
 *  - the probe, driven through a STUB BINARY on PATH. There is no configurable
 *    binary name by design (`cli/gloss.ts` settled that), so PATH is the only
 *    seam, and every case in this file puts a stub in front of it. **No test
 *    here ever reaches a real `claude`**: the "not installed" cases use a stub
 *    that exits non-zero rather than an empty PATH, because a machine that has
 *    the real CLI installed would otherwise spawn it;
 *  - the hook and doctor, through the real compiled CLI over a scratch log
 *    written by the real append path.
 *
 * The invariant this file exists to pin is the negative one. AC4: the field
 * moves nothing. Two runs whose only difference is the version — present,
 * absent, or contradicting what the log already carries — produce the same
 * verdict, the same records, and the same harness-outcome coverage.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
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

import { openWindow } from "../src/core/gate-window.js";
import {
  HARNESS_BINARY,
  HARNESS_KINDS,
  HARNESS_VERSION_LIMIT,
  harnessProvenance,
  installedHarnessVersion,
  isHarnessKind,
  normalizeHarnessVersion,
  probeHarnessVersion,
  readHarnessProvenance,
  resetHarnessVersionCache,
} from "../src/core/harness-version.js";
import type { EventRecord } from "../src/core/log.js";

/** dist/tests/harness-version.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-harness-version-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The pure half
// ---------------------------------------------------------------------------

/** `2.0.14` with a BEL glued on, spelled so this file stays greppable text. */
const BELL_SUFFIXED = `2.0.14${String.fromCharCode(7)}`;

test("normalizeHarnessVersion takes the first line, trimmed, and nothing else", () => {
  assert.equal(normalizeHarnessVersion("2.0.14 (Claude Code)"), "2.0.14 (Claude Code)");
  assert.equal(normalizeHarnessVersion("  2.0.14  \n"), "2.0.14");
  // The case the cap and the single-line rule exist for: a banner, and whatever
  // a banner quotes, must not follow the version into an append-only log
  // (SPEC.md §11.1 invariant 3).
  assert.equal(normalizeHarnessVersion("2.0.14\nwarning: token sk-ant-oops"), "2.0.14");
  assert.equal(normalizeHarnessVersion(""), null);
  assert.equal(normalizeHarnessVersion("   "), null);
  assert.equal(normalizeHarnessVersion(BELL_SUFFIXED), null, "control characters are refused");
  assert.equal(normalizeHarnessVersion("2.0.14-café"), null, "non-ASCII is refused");
  assert.equal(normalizeHarnessVersion("v".repeat(HARNESS_VERSION_LIMIT)), "v".repeat(HARNESS_VERSION_LIMIT));
  assert.equal(normalizeHarnessVersion("v".repeat(HARNESS_VERSION_LIMIT + 1)), null);
  assert.equal(normalizeHarnessVersion(42), null);
  assert.equal(normalizeHarnessVersion(null), null);
});

test("readHarnessProvenance needs both halves and a kind this build knows", () => {
  assert.deepEqual(readHarnessProvenance({ harness: "claude-code", harness_version: "2.0.14" }), {
    harness: "claude-code",
    harness_version: "2.0.14",
  });
  assert.equal(readHarnessProvenance({ harness_version: "2.0.14" }), null);
  assert.equal(readHarnessProvenance({ harness: "claude-code" }), null);
  // A harness this build cannot probe is not evidence about any binary here.
  assert.equal(readHarnessProvenance({ harness: "acme", harness_version: "1" }), null);
  // A version that did not go through the normalizer is not one this runtime
  // wrote, so it is not one this runtime compares against anything.
  assert.equal(
    readHarnessProvenance({ harness: "cursor", harness_version: "1.0\nbanner" }),
    null,
  );
  assert.equal(readHarnessProvenance(null), null);
  assert.equal(readHarnessProvenance("claude-code"), null);
});

test("the harness kind set and the binary map are the same list", () => {
  assert.deepEqual([...HARNESS_KINDS], ["claude-code", "cursor"]);
  assert.deepEqual(Object.keys(HARNESS_BINARY).sort(), [...HARNESS_KINDS].sort());
  for (const kind of HARNESS_KINDS) assert.ok(isHarnessKind(kind));
  assert.ok(!isHarnessKind("acme"));
  assert.ok(!isHarnessKind(7));
});

// ---------------------------------------------------------------------------
// The probe, through a stub binary on PATH
// ---------------------------------------------------------------------------

/**
 * Write an executable stub for a harness binary and return its directory.
 *
 * `body` runs under `/bin/sh`. Keep it to `echo`, `exit` and a `touch`, in the
 * manner of `tests/fake-claude.ts`: this is a stub, and a stub that needs
 * debugging is a test asserting the wrong thing.
 */
function stubBin(name: string, body: string, dir?: string): string {
  counter += 1;
  const binDir = dir ?? join(scratch, `bin-${counter}`);
  mkdirSync(binDir, { recursive: true });
  const path = join(binDir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, "utf8");
  chmodSync(path, 0o755);
  return binDir;
}

/** A stub `claude` whose `--version` prints `version` and leaves a witness. */
function stubClaude(version: string, witness?: string): string {
  const touch = witness === undefined ? "" : `touch ${JSON.stringify(witness)}\n`;
  return stubBin("claude", `${touch}echo ${JSON.stringify(version)}`);
}

/**
 * A stub `claude` that answers nothing, standing in for "not installed".
 *
 * Deliberately a stub rather than an empty PATH: a developer machine may well
 * have the real CLI, and this suite must never spawn it.
 */
function stubClaudeMissing(): string {
  return stubBin("claude", "exit 127");
}

/** Run `body` with `dir` at the head of this process's PATH, then restore it. */
function withPath<T>(dir: string, body: () => T): T {
  const before = process.env["PATH"];
  process.env["PATH"] = `${dir}:${before ?? ""}`;
  resetHarnessVersionCache();
  try {
    return body();
  } finally {
    if (before === undefined) delete process.env["PATH"];
    else process.env["PATH"] = before;
    resetHarnessVersionCache();
  }
}

test("the probe reads `<binary> --version` and normalizes it", () => {
  const dir = stubClaude("2.0.14 (Claude Code)");
  withPath(dir, () => {
    assert.equal(probeHarnessVersion("claude-code"), "2.0.14 (Claude Code)");
  });
});

test("a binary that answers nothing usable yields absence, never a guess", () => {
  withPath(stubClaudeMissing(), () => {
    assert.equal(probeHarnessVersion("claude-code"), null);
    assert.equal(harnessProvenance("claude-code"), null);
  });
  // Output the write boundary will not record is the same as no output: the
  // normalizer is the only spelling either side ever sees.
  withPath(stubBin("claude", "echo ''"), () => {
    assert.equal(probeHarnessVersion("claude-code"), null);
  });
});

test("a process reads a version once, failures included", () => {
  counter += 1;
  const witness = join(scratch, `probe-witness-${counter}`);
  const dir = stubClaude("2.0.14", witness);
  withPath(dir, () => {
    assert.equal(installedHarnessVersion("claude-code"), "2.0.14");
    rmSync(witness, { force: true });
    assert.equal(installedHarnessVersion("claude-code"), "2.0.14");
    assert.equal(existsSync(witness), false, "the second call must not spawn the binary again");
  });

  counter += 1;
  const missWitness = join(scratch, `probe-miss-${counter}`);
  const missing = stubBin("claude", `touch ${JSON.stringify(missWitness)}\nexit 127`);
  withPath(missing, () => {
    assert.equal(installedHarnessVersion("claude-code"), null);
    rmSync(missWitness, { force: true });
    assert.equal(installedHarnessVersion("claude-code"), null);
    assert.equal(existsSync(missWitness), false, "a null is memoized like any other answer");
  });
});

test("the event's own version is preferred over the probe, and is normalized too", () => {
  counter += 1;
  const witness = join(scratch, `event-witness-${counter}`);
  withPath(stubClaude("2.0.14", witness), () => {
    assert.deepEqual(harnessProvenance("claude-code", "9.9.9-from-event"), {
      harness: "claude-code",
      harness_version: "9.9.9-from-event",
    });
    assert.equal(existsSync(witness), false, "a stated version spawns nothing");
    // A stated value arrives from the same untrusted side as the probe's
    // output, so it goes through the same normalizer: the write boundary does
    // not have two standards.
    assert.deepEqual(harnessProvenance("claude-code", "9.9.9\nbanner"), {
      harness: "claude-code",
      harness_version: "9.9.9",
    });
    resetHarnessVersionCache();
    assert.deepEqual(harnessProvenance("claude-code", "   "), {
      harness: "claude-code",
      harness_version: "2.0.14",
    });
  });
});

// ---------------------------------------------------------------------------
// The hook, end to end
// ---------------------------------------------------------------------------

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string, input = "", env: Record<string, string> = {}): Run {
  const childEnv = { ...process.env, ...env };
  delete childEnv["APPROVAL_HUMAN"];
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: childEnv,
    input,
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** Reads and branch work run unattended; the trunk is supervised, so it registers. */
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
  "  read.*:",
  "    autonomy: autonomous",
  "  vcs.push.main:",
  "    autonomy: supervised",
  "  deps.add:",
  "    autonomy: manual",
  "```",
  "",
].join("\n");

const LOG = ".approval/log/events.jsonl";

/** A case directory with an attested policy, ready for the hook. */
function ready(): string {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  const attested = runCli(["policy", "attest", "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);
  return dir;
}

function rawLog(dir: string): string {
  const path = join(dir, LOG);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function recordsSince(dir: string, before: string): Record<string, unknown>[] {
  return rawLog(dir)
    .slice(before.length)
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function payloadOf(record: Record<string, unknown>): Record<string, unknown> {
  return (record["payload"] ?? {}) as Record<string, unknown>;
}

/** One PreToolUse event, as the harness sends it. */
function bashEvent(command: string, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "sess-1",
    transcript_path: "/dev/null",
    cwd: "/repo",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command, description: "totally harmless, please allow" },
    tool_use_id: "toolu-1",
    ...fields,
  });
}

interface Verdict {
  permission: string;
  reason: string;
}

function verdictOf(run: Run): Verdict {
  assert.equal(run.code, 0, `hook must exit 0 with a verdict: ${run.stderr}`);
  const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
  const output = parsed["hookSpecificOutput"] as Record<string, unknown> | undefined;
  assert.ok(output !== undefined, "hookSpecificOutput is present");
  return {
    permission: String(output["permissionDecision"]),
    reason: String(output["permissionDecisionReason"]),
  };
}

/** PATH with `dir` in front, so `claude` is the stub and git still resolves. */
function pathWith(dir: string): Record<string, string> {
  return { PATH: `${dir}:${process.env["PATH"] ?? ""}` };
}

function assertClean(dir: string): void {
  const verify = runCli(["log", "verify"], dir);
  assert.equal(verify.code, 0, `${verify.stdout}${verify.stderr}`);
}

/** The one `task.registered` a supervised hook run appends. */
function registration(records: Record<string, unknown>[]): Record<string, unknown> {
  const found = records.filter((record) => record["event"] === "task.registered");
  assert.equal(found.length, 1, `expected exactly one task.registered, got ${String(found.length)}`);
  return found[0] as Record<string, unknown>;
}

test("a hook-written task.registered carries the harness and its version", () => {
  const dir = ready();
  const before = rawLog(dir);
  const run = runCli(
    ["hook", "claude-code", "--dir", dir],
    dir,
    bashEvent("git push origin main"),
    pathWith(stubClaude("2.0.14 (Claude Code)")),
  );
  assert.equal(verdictOf(run).permission, "allow");

  const payload = payloadOf(registration(recordsSince(dir, before)));
  assert.equal(payload["harness"], "claude-code");
  assert.equal(payload["harness_version"], "2.0.14 (Claude Code)");
  assertClean(dir);
});

test("the version the hook event states wins, and the binary is never spawned", () => {
  const dir = ready();
  counter += 1;
  const witness = join(scratch, `hook-witness-${counter}`);
  const before = rawLog(dir);
  const run = runCli(
    ["hook", "claude-code", "--dir", dir],
    dir,
    bashEvent("git push origin main", { version: "3.1.0-stated" }),
    pathWith(stubClaude("2.0.14", witness)),
  );
  assert.equal(verdictOf(run).permission, "allow");

  const payload = payloadOf(registration(recordsSince(dir, before)));
  assert.equal(payload["harness_version"], "3.1.0-stated");
  assert.equal(existsSync(witness), false, "a stated version spawns no probe");
});

test("no usable version means no field at all, never a placeholder", () => {
  const dir = ready();
  const before = rawLog(dir);
  const run = runCli(
    ["hook", "claude-code", "--dir", dir],
    dir,
    bashEvent("git push origin main"),
    pathWith(stubClaudeMissing()),
  );
  assert.equal(verdictOf(run).permission, "allow");

  const payload = payloadOf(registration(recordsSince(dir, before)));
  assert.ok(!("harness" in payload), "no harness key");
  assert.ok(!("harness_version" in payload), "no harness_version key");
  // And the record is otherwise exactly the one this path has always written.
  assert.ok(Array.isArray(payload["actions"]));
  assert.equal(payload["state"], "proposed");
  assertClean(dir);
});

test("the autonomous verdict spawns no probe (APRV-209's cost holds)", () => {
  const dir = ready();
  counter += 1;
  const witness = join(scratch, `passthrough-witness-${counter}`);
  const before = rawLog(dir);
  const run = runCli(
    ["hook", "claude-code", "--dir", dir],
    dir,
    bashEvent("cat README.md"),
    pathWith(stubClaude("2.0.14", witness)),
  );
  assert.equal(verdictOf(run).permission, "allow");
  // The probe lives at the write site of the two records the hook STAMPS, and
  // an autonomous class writes neither: it charges an `execution.started` and
  // registers nothing. So the busiest path in the whole runtime pays no spawn.
  assert.equal(existsSync(witness), false, "an autonomous verdict reads no version");
  const appended = recordsSince(dir, before);
  assert.deepEqual(
    appended.map((record) => String(record["event"])),
    ["execution.started"],
  );
  const payload = payloadOf(appended[0] as Record<string, unknown>);
  assert.ok(!("harness_version" in payload), "and the record it does write is unstamped");
});

test("a gate.bypassed names the binary that printed the allow", () => {
  const dir = ready();
  const opened = openWindow(
    join(dir, LOG),
    {
      durationText: "30m",
      durationMs: 30 * 60_000,
      reason: "the gate itself is broken and this is how it gets debugged",
    },
    "human:alice",
  );
  assert.equal(opened.ok, true, opened.ok ? "" : `${opened.code}: ${opened.message}`);

  const before = rawLog(dir);
  const run = runCli(
    ["hook", "claude-code", "--dir", dir],
    dir,
    bashEvent("npm install --save-dev oxlint"),
    pathWith(stubClaude("2.0.14 (Claude Code)")),
  );
  assert.equal(verdictOf(run).permission, "allow");

  const bypassed = recordsSince(dir, before).filter(
    (record) => record["event"] === "gate.bypassed",
  );
  assert.equal(bypassed.length, 1);
  const payload = payloadOf(bypassed[0] as Record<string, unknown>);
  assert.equal(payload["harness"], "claude-code");
  assert.equal(payload["harness_version"], "2.0.14 (Claude Code)");
  // Everything the record carried before APRV-227 is still exactly there.
  assert.equal(payload["tool"], "Bash");
  assert.deepEqual(payload["classes"], ["deps.add"]);
  assertClean(dir);
});

// ---------------------------------------------------------------------------
// AC4: the field moves nothing
// ---------------------------------------------------------------------------

/** What a run of the hook resolved to, with the version deliberately excluded. */
interface Resolution {
  permission: string;
  reason: string;
  events: string[];
  actions: unknown;
  state: unknown;
}

function resolveWith(version: string | null, stated?: string): Resolution {
  const dir = ready();
  const before = rawLog(dir);
  const run = runCli(
    ["hook", "claude-code", "--dir", dir],
    dir,
    bashEvent("git push origin main", stated === undefined ? {} : { version: stated }),
    pathWith(version === null ? stubClaudeMissing() : stubClaude(version)),
  );
  const verdict = verdictOf(run);
  const records = recordsSince(dir, before);
  const payload = payloadOf(registration(records));
  assertClean(dir);
  return {
    permission: verdict.permission,
    reason: verdict.reason,
    events: records.map((record) => String(record["event"])),
    actions: payload["actions"],
    state: payload["state"],
  };
}

test("the version moves no verdict and no record but its own field (AC4)", () => {
  const base = resolveWith("2.0.14");
  // A different installed version.
  assert.deepEqual(resolveWith("99.0.0-completely-different"), base);
  // No version at all.
  assert.deepEqual(resolveWith(null), base);
  // A version the harness states that contradicts the binary on PATH — the
  // mismatch case the doctor row is about, and it changes nothing here.
  assert.deepEqual(resolveWith("2.0.14", "0.0.1-contradicts-the-binary"), base);
});

test("a version already in the log, matching or not, changes the next verdict not at all", () => {
  const dir = ready();

  const first = rawLog(dir);
  const one = runCli(
    ["hook", "claude-code", "--dir", dir],
    dir,
    bashEvent("git push origin main", { version: "1.0.0", tool_use_id: "toolu-a" }),
    pathWith(stubClaudeMissing()),
  );
  const oneVerdict = verdictOf(one);
  const oneEvents = recordsSince(dir, first).map((record) => String(record["event"]));

  // A second, independent tool call under a wildly different version. Same
  // classes, same policy, same everything: the recorded provenance is not an
  // input to anything the gate decides.
  const second = rawLog(dir);
  const two = runCli(
    ["hook", "claude-code", "--dir", dir],
    dir,
    bashEvent("git push origin main", { version: "42.0.0", tool_use_id: "toolu-b" }),
    pathWith(stubClaudeMissing()),
  );
  const twoVerdict = verdictOf(two);
  const twoEvents = recordsSince(dir, second).map((record) => String(record["event"]));

  assert.equal(twoVerdict.permission, oneVerdict.permission);
  assert.deepEqual(twoEvents, oneEvents);
  assertClean(dir);
});

// ---------------------------------------------------------------------------
// AC5: `approval status` harness coverage is untouched
// ---------------------------------------------------------------------------

function statusJson(dir: string): Record<string, unknown> {
  const run = runCli(["status", "--json"], dir);
  const parsed = JSON.parse(run.stdout.trim()) as Record<string, unknown>;
  return parsed;
}

test("harness outcome coverage is identical with and without the field (AC5)", () => {
  const withVersion = ready();
  const withoutVersion = ready();
  for (const [dir, bin] of [
    [withVersion, stubClaude("2.0.14")],
    [withoutVersion, stubClaudeMissing()],
  ] as const) {
    const run = runCli(
      ["hook", "claude-code", "--dir", dir],
      dir,
      bashEvent("git push origin main"),
      pathWith(bin),
    );
    assert.equal(verdictOf(run).permission, "allow");
  }

  const stamped = statusJson(withVersion);
  const bare = statusJson(withoutVersion);
  assert.deepEqual(stamped["harness_outcomes"], bare["harness_outcomes"]);
  // Not vacuous: the supervised path did record a harness execution.
  assert.deepEqual(stamped["harness_outcomes"], {
    started: 1,
    reported: 0,
    unreported: 1,
  });
});

// ---------------------------------------------------------------------------
// The doctor row
// ---------------------------------------------------------------------------

/** Write a `.claude/settings.json` that registers this CLI's hook. */
function wireClaudeHook(dir: string): void {
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(
    join(dir, ".claude", "settings.json"),
    `${JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash|Edit|Write",
              hooks: [{ type: "command", command: `approval hook claude-code --dir ${dir}` }],
            },
          ],
          PostToolUse: [
            {
              matcher: "Bash|Edit|Write",
              hooks: [{ type: "command", command: `approval hook claude-code --dir ${dir}` }],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

interface DoctorCheckJson {
  check: string;
  status: string;
  detail: string;
  fix?: string;
}

function doctorRow(dir: string, env: Record<string, string>): DoctorCheckJson {
  const run = runCli(["doctor", "--json"], dir, "", env);
  const parsed = JSON.parse(run.stdout.trim()) as { checks: DoctorCheckJson[] };
  const row = parsed.checks.find((entry) => entry.check === "harness-version-unverified");
  assert.ok(row !== undefined, "the row is in the report");
  return row;
}

test("doctor skips when no harness hook is registered in this checkout", () => {
  const dir = ready();
  const row = doctorRow(dir, pathWith(stubClaude("2.0.14")));
  assert.equal(row.status, "skip");
  assert.match(row.detail, /registers no `approval hook` command/u);
  assert.equal(row.fix, undefined);
});

test("doctor skips when the hook is wired and no record names a version yet", () => {
  const dir = ready();
  wireClaudeHook(dir);
  const row = doctorRow(dir, pathWith(stubClaude("2.0.14")));
  assert.equal(row.status, "skip");
  assert.match(row.detail, /no baseline to compare against/u);
});

test("doctor skips when the binary itself cannot be asked", () => {
  const dir = ready();
  wireClaudeHook(dir);
  const run = runCli(
    ["hook", "claude-code", "--dir", dir],
    dir,
    bashEvent("git push origin main"),
    pathWith(stubClaude("2.0.14")),
  );
  assert.equal(verdictOf(run).permission, "allow");

  const row = doctorRow(dir, pathWith(stubClaudeMissing()));
  assert.equal(row.status, "skip");
  assert.match(row.detail, /gave no usable answer here/u);
  assert.match(row.detail, /"2\.0\.14"/u, "and names what the log last saw");
});

test("doctor passes when the installed binary matches the last hook record", () => {
  const dir = ready();
  wireClaudeHook(dir);
  const bin = stubClaude("2.0.14 (Claude Code)");
  const run = runCli(
    ["hook", "claude-code", "--dir", dir],
    dir,
    bashEvent("git push origin main"),
    pathWith(bin),
  );
  assert.equal(verdictOf(run).permission, "allow");

  const row = doctorRow(dir, pathWith(bin));
  assert.equal(row.status, "pass");
  assert.match(row.detail, /matches the version on the hook record at seq/u);
  assert.equal(row.fix, undefined, "a passing row carries no fix");
  // The row states its own limit rather than claiming the hook fired.
  assert.match(row.detail, /not proof the hook fired/u);
});

test("doctor fails on an unverified change, and passes again once the hook re-records", () => {
  const dir = ready();
  wireClaudeHook(dir);
  const oldBin = stubClaude("2.0.14 (Claude Code)");
  const first = runCli(
    ["hook", "claude-code", "--dir", dir],
    dir,
    bashEvent("git push origin main"),
    pathWith(oldBin),
  );
  assert.equal(verdictOf(first).permission, "allow");

  // The upgrade: the binary on PATH is now a different one, and nothing in the
  // log has been written under it.
  const newBin = stubClaude("2.1.0 (Claude Code)");
  const failed = doctorRow(dir, pathWith(newBin));
  assert.equal(failed.status, "fail");
  assert.match(failed.detail, /"2\.1\.0 \(Claude Code\)"/u);
  assert.match(failed.detail, /"2\.0\.14 \(Claude Code\)"/u);
  const fix = failed.fix;
  assert.ok(fix !== undefined, "a failing row carries a fix");
  assert.ok(fix.startsWith("approval "), fix);
  assert.match(fix, /self-test/u);

  // The self-test: one supervised-class tool call through the upgraded hook.
  // It prompts nobody, and the row is green on the next look.
  const before = rawLog(dir);
  const selfTest = runCli(
    ["hook", "claude-code", "--dir", dir],
    dir,
    bashEvent("git push origin main", { session_id: "sess-selftest", tool_use_id: "toolu-2" }),
    pathWith(newBin),
  );
  assert.equal(verdictOf(selfTest).permission, "allow");
  assert.equal(
    payloadOf(registration(recordsSince(dir, before)))["harness_version"],
    "2.1.0 (Claude Code)",
  );

  const green = doctorRow(dir, pathWith(newBin));
  assert.equal(green.status, "pass");
  assertClean(dir);
});

test("doctor reads only the records the hook writes, and only verified ones", () => {
  const dir = ready();
  wireClaudeHook(dir);
  const bin = stubClaude("2.0.14");
  const run = runCli(
    ["hook", "claude-code", "--dir", dir],
    dir,
    bashEvent("git push origin main"),
    pathWith(bin),
  );
  assert.equal(verdictOf(run).permission, "allow");

  // Doctor appends nothing, whatever verdict it reaches: the log is
  // byte-identical across the run (the promise every row of this verb makes).
  const before = readFileSync(join(dir, LOG));
  const row = doctorRow(dir, pathWith(bin));
  assert.equal(row.status, "pass");
  assert.deepEqual(readFileSync(join(dir, LOG)), before);
});

// ---------------------------------------------------------------------------
// The read boundary: records written before the field existed
// ---------------------------------------------------------------------------

test("a log with no provenance anywhere still verifies and still reads back", () => {
  const dir = ready();
  const run = runCli(
    ["hook", "claude-code", "--dir", dir],
    dir,
    bashEvent("git push origin main"),
    pathWith(stubClaudeMissing()),
  );
  assert.equal(verdictOf(run).permission, "allow");
  assertClean(dir);

  const records = rawLog(dir)
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as EventRecord);
  for (const record of records) {
    assert.equal(readHarnessProvenance(record.payload), null);
  }
});
