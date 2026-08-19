/**
 * The re-rendered human output, in both modes (APRV-91 #9/#10/#14/#15, APRV-93).
 *
 * Every other CLI suite runs with piped stdio, which is exactly the mode a
 * pipeline sees: `style()` resolves to disabled and every helper is a no-op, so
 * those suites pin BYTES and this one does not need to repeat them. What is
 * missing from that picture is the other half of the matrix — what the same
 * renderer emits into a terminal — and there is no pty here to produce it. So
 * each renderer takes an injectable {@link Style}, and these cases build a
 * `makeStyle({ tty: true })` by hand and assert on the escapes it produces.
 *
 * The load-bearing assertion is the NEGATIVE one, and it is the reason the
 * `value` role exists: no escape byte may appear inside a hash, a token, a
 * path, or a `fix:` command. A human triple-clicking a value out of a coloured
 * terminal must get clean bytes, and a `git add` line with an SGR sequence in
 * the middle of it is a line that cannot be pasted.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { renderDoctorHuman } from "../src/cli/doctor.js";
import { renderQueueHuman, renderWaitHuman } from "../src/cli/execute.js";
import { renderClassification } from "../src/cli/hook.js";
import { renderExplainHuman } from "../src/cli/policy.js";
import { makeStyle } from "../src/cli/style.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-style-render-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A terminal, forced: the mode no piped test can otherwise reach. */
const TTY = makeStyle({ tty: true, env: { LANG: "en_US.UTF-8" } });
/** A pipe, forced, so a developer's own FORCE_COLOR cannot colour a fixture. */
const PIPED = makeStyle({ tty: false, env: { LANG: "en_US.UTF-8" } });

const ESC = "\u001b";
/** Every SGR sequence in a string, so a case can point at where colour landed. */
// oxlint-disable-next-line no-control-regex -- detecting ANSI IS the point
const SGR = /\u001b\[[0-9;]*m/gu;

/** The text with every escape sequence removed: what a pipe would have shown. */
function undressed(text: string): string {
  return text.replace(SGR, "");
}

/**
 * Assert that no escape byte falls INSIDE a copyable value.
 *
 * The test is run against the dressed string with the sequences replaced by a
 * marker, so a run of hex (or a command) that was interrupted by colour no
 * longer matches the "clean value" pattern the undressed text matches.
 */
function assertValuesUndressed(dressed: string): void {
  const marked = dressed.replace(SGR, "\u0000");
  // Any run of 12+ hex characters in the plain text must survive intact.
  for (const [hash] of undressed(dressed).matchAll(/[0-9a-f]{12,}/gu)) {
    assert.ok(
      marked.includes(hash),
      `an escape sequence landed inside the hash ${hash}:\n${JSON.stringify(dressed)}`,
    );
  }
  // And so must every `fix:` command, from the label to the end of its line.
  for (const [, command] of undressed(dressed).matchAll(/^\s*fix: (.+)$/gmu)) {
    assert.ok(
      marked.includes(command as string),
      `an escape sequence landed inside a fix command:\n${JSON.stringify(dressed)}`,
    );
  }
}

// ===========================================================================
// doctor
// ===========================================================================

const CHECKS = [
  { check: "identity", status: "fail" as const, detail: "APPROVAL_HUMAN is unset", fix: "approval setup identity — or export APPROVAL_HUMAN=human:<id>" },
  { check: "log", status: "pass" as const, detail: "verifies: 1 record(s), head seq 1 722d40258af2…" },
  { check: "envelope-integrity", status: "skip" as const, detail: "no task folder" },
];

test("doctor: piped output is one line per check, a fix line, and a summary", () => {
  const text = renderDoctorHuman(CHECKS, PIPED);
  const lines = text.trimEnd().split("\n");

  assert.equal(lines.filter((line) => /^[✓✗–] /u.test(line)).length, CHECKS.length);
  assert.match(lines[0] as string, /^✗ identity {2,}APPROVAL_HUMAN is unset$/u);
  assert.match(lines[1] as string, /^ {4}fix: approval setup identity\b/u);
  assert.equal(lines.at(-1), "1 ok · 1 not applicable · 1 failed");
  assert.ok(!text.includes(ESC), "a pipe must never receive an escape byte");
});

test("doctor: a terminal gets colour, and never inside a hash or a fix command", () => {
  const dressed = renderDoctorHuman(CHECKS, TTY);

  assert.ok(dressed.includes(ESC), "a terminal must receive colour");
  // The same report, minus the dressing, is byte-identical to the piped one.
  assert.equal(undressed(dressed), renderDoctorHuman(CHECKS, PIPED));
  assertValuesUndressed(dressed);
});

// ===========================================================================
// queue
// ===========================================================================

const PENDING = [
  {
    action_key: "task-042:chaser",
    task: "task-042",
    class: "communicate.email.external",
    est_cost_usd: 0.02,
    requested_ts: "2026-08-18T10:00:00.000Z",
    seq: 3,
    ttl_remaining_ms: 3_600_000,
  },
  {
    action_key: "task-042:followup",
    task: "task-042",
    class: "communicate.email.external",
    est_cost_usd: 0.02,
    requested_ts: "2026-08-18T10:05:00.000Z",
    seq: 4,
    ttl_remaining_ms: 60_000,
  },
];

test("queue: the header row and every column line up, with no escapes in a pipe", () => {
  const text = renderQueueHuman(PENDING, 3_600_000, PIPED);
  const lines = text.trimEnd().split("\n");

  assert.match(lines[0] as string, /^action {2,}task {2,}class {2,}cost {2,}requested {2,}ttl$/u);
  // Every column starts at the same offset on every row, header included.
  const column = (line: string): number => line.indexOf("task-042  ");
  assert.equal(column(lines[1] as string), column(lines[2] as string));
  assert.match(lines[1] as string, /1h 0m left$/u);
  assert.match(lines[2] as string, /1m left$/u);
  assert.ok(!text.includes(ESC));
});

test("queue: the TTL column changes role as the window closes", () => {
  // Above half the window is `ok` (32), under a tenth is `fail` (1;31).
  const roomy = renderQueueHuman([PENDING[0] as (typeof PENDING)[0]], 3_600_000, TTY);
  // oxlint-disable-next-line no-control-regex -- detecting ANSI IS the point
  assert.match(roomy, /\u001b\[32m[^\u001b]*left/u);

  const urgent = renderQueueHuman([PENDING[1] as (typeof PENDING)[1]], 3_600_000, TTY);
  // oxlint-disable-next-line no-control-regex -- detecting ANSI IS the point
  assert.match(urgent, /\u001b\[1;31m[^\u001b]*left/u);

  // And in both cases the action key and the class stay clean.
  assertValuesUndressed(roomy);
  assertValuesUndressed(urgent);
  assert.ok(roomy.includes("task-042:chaser"));
});

// ===========================================================================
// wait
// ===========================================================================

test("wait: the verdict, then one aligned row per action, in both modes", () => {
  const actions = [
    { action_key: "task-042:chaser", state: "granted", seq: 5 },
    { action_key: "task-042:followup", state: "rejected", seq: 6 },
  ];
  const piped = renderWaitHuman("task-042", "rejected", actions, PIPED);
  assert.equal(
    piped,
    ["✗ task-042  rejected", "  task-042:chaser    granted", "  task-042:followup  rejected", ""].join(
      "\n",
    ),
  );

  const dressed = renderWaitHuman("task-042", "rejected", actions, TTY);
  assert.ok(dressed.includes(ESC));
  assert.equal(undressed(dressed), piped);
  // Action keys are copyable, so they are the plain half of every row.
  assert.ok(dressed.includes("  task-042:chaser  "));
});

// ===========================================================================
// hook classify
// ===========================================================================

test("hook classify: an aligned table whose command column is never dressed", () => {
  const result = {
    ok: true as const,
    classes: ["vcs.push.main"],
    segments: [{ class: "vcs.push.main", rule: "git-push-main", text: "git push origin main" }],
  };

  const piped = renderClassification(result, false, PIPED);
  assert.match(piped, /^class {2,}rule {2,}command$/mu);
  assert.ok(!piped.includes(ESC));

  const dressed = renderClassification(result, false, TTY);
  assert.equal(undressed(dressed), piped);
  assert.ok(
    dressed.includes("git push origin main"),
    "the command a human copies must survive as one unbroken run",
  );
});

// ===========================================================================
// policy explain
// ===========================================================================

test("policy explain: the trace is muted, the answer is not, and the path is relative", () => {
  const explanation = {
    outcome: { autonomy: "manual" },
    loadFailure: null,
    overridden: null,
    decisionPath: ["policy loaded from /repo/APPROVAL.md", "no rule matched; defaults.autonomy -> manual"],
  } as unknown as Parameters<typeof renderExplainHuman>[0];

  const piped = renderExplainHuman(explanation, "/repo", PIPED);
  assert.equal(piped.split("\n")[0], "policy loaded from APPROVAL.md");
  assert.equal(piped.trimEnd().split("\n").at(-1), "-> manual");
  assert.ok(!piped.includes(ESC));

  const dressed = renderExplainHuman(explanation, "/repo", TTY);
  assert.equal(undressed(dressed), piped);
  assert.ok(dressed.includes(ESC));
});

// ===========================================================================
// `--json` is byte-identical: full hashes, absolute paths, no escapes
// ===========================================================================

const POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: supervised",
  '  approval_ttl: "24h"',
  "classes:",
  "  read.*:",
  "    autonomy: autonomous",
  "```",
  "",
].join("\n");

function caseDir(): string {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  return dir;
}

function runCli(args: string[], cwd: string, env: Record<string, string> = {}): {
  code: number;
  stdout: string;
  stderr: string;
} {
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

test("--json keeps full 64-hex digests and absolute paths, even with FORCE_COLOR set", () => {
  const dir = caseDir();
  assert.equal(runCli(["policy", "attest", "--as", "human:carter"], dir).code, 0);

  // FORCE_COLOR is the strongest "yes" in the enable matrix, and `--json` still
  // vetoes it: one escape byte in a JSON stream is a parse error.
  const run = runCli(["status", "--json"], dir, { FORCE_COLOR: "1" });
  assert.equal(run.code, 0, run.stderr);
  assert.ok(!run.stdout.includes(ESC), "--json output must carry no escape byte");
  JSON.parse(run.stdout);

  const doctor = runCli(["doctor", "--json"], dir, { FORCE_COLOR: "1" });
  assert.ok(!doctor.stdout.includes(ESC));
  const parsed = JSON.parse(doctor.stdout) as { checks: { check: string; detail: string }[] };
  const log = parsed.checks.find((entry) => entry.check === "log");
  assert.ok(log !== undefined);
  // The absolute path survives in the machine shape, whatever the human sees.
  assert.ok(log.detail.includes(dir), `doctor --json lost the absolute path: ${log.detail}`);

  // And `policy amend --json` keeps the untruncated digest.
  writeFileSync(join(dir, "APPROVAL.md"), `${POLICY}\nEdited.\n`, "utf8");
  const amend = runCli(
    ["policy", "amend", "--as", "human:carter", "--dry-run", "--json"],
    dir,
    { FORCE_COLOR: "1" },
  );
  assert.equal(amend.code, 0, amend.stderr);
  assert.ok(!amend.stdout.includes(ESC));
  const report = JSON.parse(amend.stdout) as {
    liveSha256: string;
    policy: string;
    git: { commands: string[] };
  };
  assert.match(report.liveSha256, /^[0-9a-f]{64}$/u);
  assert.equal(report.policy, join(dir, "APPROVAL.md"));
  // The commands a MACHINE reads keep their absolute paths: it has no cwd to
  // resolve a relative one against. Only the printed copy is relativized.
  assert.ok(
    report.git.commands.some((command) => command.includes(join(dir, "APPROVAL.md"))),
    `--json lost the absolute path from git.commands: ${JSON.stringify(report.git.commands)}`,
  );
});

test("the human amend report short-hashes and relativizes what --json leaves whole", () => {
  const dir = caseDir();
  assert.equal(runCli(["policy", "attest", "--as", "human:carter"], dir).code, 0);
  writeFileSync(join(dir, "APPROVAL.md"), `${POLICY}\nEdited.\n`, "utf8");

  const run = runCli(["policy", "amend", "--as", "human:carter", "--dry-run"], dir);
  assert.equal(run.code, 0, run.stderr);
  assert.ok(!run.stdout.includes(ESC));
  // Twelve characters, never sixty-four, and never the absolute path.
  assert.match(run.stdout, /^ {2}live {2,}[0-9a-f]{12}$/mu);
  assert.equal(/[0-9a-f]{64}/u.test(run.stdout), false, "a 64-hex digest reached human output");
  assert.match(run.stdout, /^ {2}file {2,}APPROVAL\.md$/mu);
  assert.equal(run.stdout.includes(dir), false, "an absolute path reached human output");
  // The four section labels the brief named.
  for (const label of ["Policy", "Changes", "Load", "Would run"]) {
    assert.match(run.stdout, new RegExp(`^${label}$`, "mu"), label);
  }
});
