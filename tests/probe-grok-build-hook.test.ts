/**
 * `scripts/probes/grok-build-hook.mjs` (APRV-243 AC1, driven per APRV-418).
 *
 * The probe's whole job is to be run once, by a human, against an installed Grok
 * Build. This suite exists so that when that happens the script does not fail on
 * its own bugs, and it is the reason the port is safe to make at all: APRV-243
 * AC1 has never run, so every line of the driver is unexercised until something
 * exercises it.
 *
 * Three properties are asserted rather than trusted, each because a previous
 * probe round paid for them:
 *
 *   1. the scratch project holds ONLY synthetic files, and no `AGENTS.md` or
 *      `CLAUDE.md` — a coding harness reads those as instructions;
 *   2. the pointer file is INJECTABLE, and this suite redirects it. The Muse
 *      suite once wrote the real pointer and a test run during a live session
 *      repointed the operator's `arm` mid-round;
 *   3. NOTHING in this repository is registered or edited. The old runbook had a
 *      human add a probe entry to the real Claude settings file, which is
 *      `policy.core`, and take it out again afterwards.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

// The probe is plain Node ESM on purpose: an operator runs it straight from a
// checkout, before any build. Its exports are exercised here without adding a
// declaration file, exactly as tests/probe-hermes-hook.test.ts does.
// @ts-expect-error no declaration file for the standalone probe script
import * as probe from "../../scripts/probes/grok-build-hook.mjs";

/** One step of the driven matrix. */
interface MatrixStep {
  id: string;
  trial: string;
  prompt: string;
  artifact: string;
}

const {
  ONE_SHOT_TEMPLATE,
  REGISTRATIONS,
  REGISTRATION_PATHS,
  SYNTHETIC_FILES,
  TRIALS,
  VERSION_FLOOR,
  arm,
  matrix,
  oneShotArgv,
  outsideProject,
  record,
  redact,
  report,
  run,
  setup,
  trialAnswer,
  trialArtifact,
  versionLine,
} = probe as {
  ONE_SHOT_TEMPLATE: string;
  REGISTRATIONS: string[];
  REGISTRATION_PATHS: Record<string, string>;
  SYNTHETIC_FILES: Record<string, string>;
  TRIALS: string[];
  VERSION_FLOOR: null;
  arm: (argv: string[], write?: (text: string) => void) => number;
  matrix: () => MatrixStep[];
  oneShotArgv: (template: string, prompt: string, project: string) => string[] | null;
  outsideProject: (envelope: unknown, project: string) => string | null;
  record: (argv: string[], io?: Record<string, unknown>) => number;
  redact: (text: string) => string;
  report: (argv: string[], write?: (text: string) => void) => number;
  run: (argv: string[], io?: Record<string, unknown>) => number;
  setup: (argv: string[], write?: (text: string) => void) => number;
  trialAnswer: (
    trial: string,
    reason: string,
  ) => { body: Record<string, unknown> | string | null; code: number } | null;
  trialArtifact: (trial: string) => string;
  versionLine: (raw: unknown) => string | null;
};

/** The repository root, from `dist/tests/` at runtime. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The fake harness the driver tests spawn. See its own header for what it models. */
const FAKE_GROK = join(REPO_ROOT, "tests", "fake-grok.mjs");

/** This suite's OWN pointer file; see the header for the incident behind it. */
const POINTER_DIR = mkdtempSync(join(tmpdir(), "approval-grok-probe-test-"));
const TEST_POINTER = join(POINTER_DIR, "pointer.json");
process.env["APPROVAL_GROK_PROBE_POINTER"] = TEST_POINTER;

const created: string[] = [];

after(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
  rmSync(POINTER_DIR, { recursive: true, force: true });
  delete process.env["APPROVAL_GROK_PROBE_POINTER"];
  delete process.env["FAKE_GROK_VERSION"];
  delete process.env["FAKE_GROK_HOOK_TIMEOUT_MS"];
  delete process.env["FAKE_GROK_INERT"];
  delete process.env["FAKE_GROK_IGNORE_CLAUDE_SETTINGS"];
});

interface Pointer {
  state: string;
  project: string;
  root: string;
}

function runSetup(): { out: string } & Pointer {
  let out = "";
  const code = setup(["node", "grok-build-hook.mjs", "setup"], (text: string) => {
    out += text;
  });
  assert.equal(code, 0);
  const pointer = JSON.parse(readFileSync(TEST_POINTER, "utf8")) as Pointer;
  created.push(pointer.root);
  return { out, ...pointer };
}

function cleanup(): void {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
}

/** Every file under `dir`, as paths relative to it. */
function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full));
  }
  return out;
}

/** A Grok Build `PreToolUse` envelope, in the camelCase shape it sends. */
function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hookEventName: "PreToolUse",
    sessionId: "probe-session",
    cwd: "/tmp/scratch-project",
    workspaceRoot: "/tmp/scratch-project",
    toolName: "Write",
    toolInput: { filePath: "/tmp/scratch-project/x.txt", content: "x" },
    ...overrides,
  };
}

/** Drive `record` with a canned envelope, returning the exit code and streams. */
function runRecord(
  state: string,
  input: Record<string, unknown> | string,
  extra: string[] = [],
): { code: number; out: string; warn: string } {
  let out = "";
  let warn = "";
  const code = record(["node", "grok-build-hook.mjs", "record", "--state", state, ...extra], {
    readInput: () => (typeof input === "string" ? input : JSON.stringify(input)),
    write: (text: string) => {
      out += text;
    },
    warn: (text: string) => {
      warn += text;
    },
  });
  return { code, out, warn };
}

function runReport(state: string): string {
  let out = "";
  report(["node", "grok-build-hook.mjs", "report", "--state", state], (text: string) => {
    out += text;
  });
  return out;
}

/** Drive `run`, returning its exit code and both streams. */
function runDriver(extra: string[] = []): { code: number; out: string; warn: string } {
  let out = "";
  let warn = "";
  const code = run(["node", "grok-build-hook.mjs", "run", "--binary", FAKE_GROK, ...extra], {
    write: (text: string) => {
      out += text;
    },
    warn: (text: string) => {
      warn += text;
    },
  });
  return { code, out, warn };
}

/** The pointer file's contents, or `null`. Used to prove a refusal wrote nothing. */
function pointerNow(): string | null {
  try {
    return readFileSync(TEST_POINTER, "utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// setup: a scratch project, and NOTHING of this repository's
// ---------------------------------------------------------------------------

test("setup builds a scratch project holding only synthetic files and the two registrations", () => {
  try {
    const { out, project, state } = runSetup();

    assert.deepEqual(
      walk(project).sort(),
      [...Object.keys(SYNTHETIC_FILES), ...Object.values(REGISTRATION_PATHS)].sort(),
    );
    for (const [name, body] of Object.entries(SYNTHETIC_FILES)) {
      assert.equal(readFileSync(join(project, name), "utf8"), body);
    }

    // A coding harness reads these as agent instructions in a trusted
    // workspace, so the fixture must not contain them.
    for (const forbidden of ["AGENTS.md", "CLAUDE.md", ".agents/AGENTS.md", ".claude/CLAUDE.md"]) {
      assert.equal(existsSync(join(project, forbidden)), false, `${forbidden} must not exist`);
    }

    // BOTH candidates are registered at once, each naming its own --config-id,
    // which is what lets one round answer which file the harness reads.
    const ids: string[] = [];
    for (const key of REGISTRATIONS) {
      const text = readFileSync(join(project, String(REGISTRATION_PATHS[key])), "utf8");
      assert.match(text, /grok-build-hook\.mjs record/u, `${key} points at the recorder`);
      assert.match(text, new RegExp(state.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
      assert.match(text, new RegExp(`--config-id ${key}`, "u"));
      ids.push(key);
    }
    assert.deepEqual(ids, REGISTRATIONS);

    assert.match(out, /NEVER RUN THIS PROBE INSIDE A REAL REPOSITORY/u);
    assert.match(out, /DOCUMENTED TO FAIL OPEN/u, "the harness's own weakness is named up front");
    // The old runbook asked for an edit to this repository's real settings file,
    // which is policy.core. It must be visibly gone.
    assert.match(out, /Nothing in this repository was touched/u);
    assert.match(out, /grok-build-hook\.mjs run/u, "and the one-tap alternative is offered");
    for (const trial of TRIALS) {
      assert.match(out, new RegExp(`arm ${trial}`, "u"), `the ${trial} trial command is printed`);
    }
  } finally {
    cleanup();
  }
});

test("arm refuses a trial it does not know, and refuses with no state at all", () => {
  assert.equal(arm(["node", "grok-build-hook.mjs", "arm", "explode"]), 2);
  try {
    const { state } = runSetup();
    let out = "";
    assert.equal(
      arm(["node", "grok-build-hook.mjs", "arm", "hazard", "--state", state], (text: string) => {
        out += text;
      }),
      0,
    );
    assert.match(out, new RegExp(trialArtifact("hazard"), "u"));
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// The path jail
// ---------------------------------------------------------------------------

test("the path jail catches every documented path key, and a word of a command", () => {
  const project = mkdtempSync(join(tmpdir(), "aprv243-jail-"));
  created.push(project);
  try {
    assert.equal(
      outsideProject(envelope({ toolInput: { filePath: join(project, "x.txt") } }), project),
      null,
    );
    assert.match(
      String(outsideProject(envelope({ toolInput: { filePath: "/etc/hosts" } }), project)),
      /filePath/u,
    );
    assert.match(
      String(
        outsideProject(
          envelope({ toolName: "Bash", toolInput: { command: "cat /etc/passwd" } }),
          project,
        ),
      ),
      /a word of the command/u,
    );
    // FAIL CLOSED on a value this cannot place: a home shortcut and an
    // unexpanded parameter are outside, because nothing can say they are inside.
    assert.notEqual(outsideProject(envelope({ toolInput: { path: "~/secrets" } }), project), null);
    assert.notEqual(
      outsideProject(envelope({ toolInput: { path: "$HOME/secrets" } }), project),
      null,
    );
    assert.match(String(outsideProject(null, project)), /unparseable/u);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// record
// ---------------------------------------------------------------------------

test("an unarmed call inside the project allows in the GROK dialect at exit 0", () => {
  try {
    const { state, project } = runSetup();
    const run0 = runRecord(
      state,
      envelope({ cwd: project, toolInput: { filePath: join(project, "x.txt"), content: "x" } }),
    );
    assert.equal(run0.code, 0);
    assert.deepEqual(Object.keys(JSON.parse(run0.out) as object).sort(), ["decision", "reason"]);
    assert.equal((JSON.parse(run0.out) as { decision: string }).decision, "allow");
  } finally {
    cleanup();
  }
});

test("an unarmed call reaching outside the project denies at EXIT 2, which is the dialect", () => {
  try {
    const { state, project } = runSetup();
    const denied = runRecord(
      state,
      envelope({ cwd: project, toolInput: { filePath: "/etc/hosts", content: "x" } }),
    );
    assert.equal(denied.code, 2, "exit 2 is the only deny this harness acts on");
    assert.equal((JSON.parse(denied.out) as { decision: string }).decision, "deny");
    assert.match(denied.warn, /PATH JAIL REFUSED/u);
    assert.match(denied.warn, /documented\s+to fail OPEN/u, "and what that refusal does not prove");
  } finally {
    cleanup();
  }
});

test("a post event is recorded, answered with nothing, and ALWAYS exits 0", () => {
  try {
    const { state, project } = runSetup();
    // On this harness a non-zero exit is a verdict, and a verdict about a call
    // that has already finished is meaningless at best.
    const post = runRecord(
      state,
      envelope({
        hookEventName: "PostToolUse",
        cwd: project,
        toolInput: { filePath: "/etc/hosts" },
      }),
    );
    assert.equal(post.code, 0);
    assert.equal(post.out, "");
  } finally {
    cleanup();
  }
});

test("each trial answers exactly one shape, and the hazard is the nested deny at exit 0", () => {
  // THE HAZARD, pinned by shape: this is precisely what a committed
  // `approval hook claude-code` entry answers, and exit 0 is an allow here.
  const hazard = trialAnswer("hazard", "why");
  assert.equal(hazard?.code, 0);
  assert.deepEqual(Object.keys(hazard?.body as object), ["hookSpecificOutput"]);

  assert.deepEqual(trialAnswer("deny-grok-exit2", "why"), {
    body: { decision: "deny", reason: "why" },
    code: 2,
  });
  // The same body WITHOUT the exit code, which is what says whether the exit
  // code is load-bearing.
  assert.deepEqual(trialAnswer("deny-grok-exit0", "why"), {
    body: { decision: "deny", reason: "why" },
    code: 0,
  });
  assert.deepEqual(trialAnswer("allow", "why"), { body: null, code: 0 });
  assert.deepEqual(trialAnswer("crash", "why"), { body: null, code: 1 });
  assert.equal(typeof trialAnswer("garbage", "why")?.body, "string");
  assert.equal(trialAnswer("not-a-trial", "why"), null);
});

test("the arm is per CALL by hand and per STEP when driven", () => {
  try {
    const { state, project } = runSetup();
    const call = (): ReturnType<typeof runRecord> =>
      runRecord(
        state,
        envelope({ cwd: project, toolInput: { filePath: join(project, "x.txt"), content: "x" } }),
      );

    // By hand: one arm, one call, exactly as the old probe behaved.
    arm(["node", "grok-build-hook.mjs", "arm", "crash", "--state", state], () => {});
    assert.equal(call().code, 1);
    assert.equal(call().code, 0, "the arm was consumed by the one call");

    // Driven: the arm belongs to the STEP, because both registrations fire for
    // one tool call and a per-call arm would leave the second entry answering
    // something else — the trial would be two variables.
    arm(
      ["node", "grok-build-hook.mjs", "arm", "crash", "--state", state, "--step", "crash"],
      () => {},
    );
    assert.equal(call().code, 1);
    assert.equal(call().code, 1, "both registrations get the same answer within a step");
  } finally {
    cleanup();
  }
});

test("token-shaped strings are stripped before anything is written", () => {
  assert.match(redact('{"api_key":"abcdefghijklmnop"}'), /<redacted>/u);
  assert.match(redact("Authorization: Bearer abcdefghijklmnop"), /Bearer <redacted>/u);
  assert.match(redact("xai-abcdefghijklmnopqrstuvwxyz"), /<redacted>/u);
  assert.equal(redact('{"toolName":"Bash"}'), '{"toolName":"Bash"}');
});

// ---------------------------------------------------------------------------
// The driver (APRV-418)
// ---------------------------------------------------------------------------

test("this harness has no version FLOOR, and the driver says so rather than inventing one", () => {
  // The Hermes probe refuses below a measured floor. Nothing here has measured a
  // build difference in Grok Build, so a floor would be invented — and an
  // invented floor is the confident-stale documentation this project avoids.
  assert.equal(VERSION_FLOOR, null);
  assert.equal(versionLine("grok 1.2.3\nmore"), "grok 1.2.3");
  assert.equal(versionLine(""), null);
});

test("the matrix is one step per trial, each with its own artifact", () => {
  const steps = matrix();
  assert.deepEqual(
    steps.map((step) => step.trial),
    TRIALS,
  );
  assert.deepEqual(
    steps.map((step) => step.artifact),
    TRIALS.map((trial) => trialArtifact(trial)),
  );
  assert.equal(new Set(steps.map((step) => step.id)).size, steps.length);
  // The hazard goes FIRST, because it is the question the probe exists for and
  // an aborted round should have answered it.
  assert.equal(steps[0]?.trial, "hazard");
});

test("the one-shot template substitutes both placeholders, and refuses a prompt-less one", () => {
  assert.deepEqual(oneShotArgv(ONE_SHOT_TEMPLATE, "do a thing", "/tmp/p"), [
    "-p",
    "do a thing",
    "--cwd",
    "/tmp/p",
  ]);
  assert.equal(oneShotArgv("--headless {dir}", "p", "/tmp/p"), null);
});

test("run refuses an UNREADABLE version and writes nothing, and the override is named", () => {
  const before = pointerNow();
  process.env["FAKE_GROK_VERSION"] = "";
  try {
    const { code, warn } = runDriver();
    assert.equal(code, 3);
    assert.match(warn, /THE VERSION COULD NOT BE READ/u);
    assert.match(warn, /no fail-closed version floor for this harness/u, "and it is not a floor");
    assert.match(warn, /--allow-unknown-version/u);
    assert.equal(pointerNow(), before, "no scratch project, nothing to undo");
  } finally {
    delete process.env["FAKE_GROK_VERSION"];
  }
});

test("run drives every trial through a fake harness, and reads the three answers", () => {
  process.env["FAKE_GROK_VERSION"] = "grok 0.9.0 (fake)";
  process.env["FAKE_GROK_HOOK_TIMEOUT_MS"] = "2000";
  try {
    const { code, out } = runDriver(["--step-timeout", "30000"]);
    assert.equal(code, 0, out);

    const pointer = JSON.parse(readFileSync(TEST_POINTER, "utf8")) as Pointer;
    created.push(pointer.root);

    const version = JSON.parse(readFileSync(join(pointer.state, "version.json"), "utf8")) as {
      raw: string;
      floor: null;
    };
    assert.equal(version.raw, "grok 0.9.0 (fake)");
    assert.equal(version.floor, null);

    const rows = readFileSync(join(pointer.state, "runs.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { id: string; captured: number; landed: boolean });
    assert.deepEqual(
      rows.map((row) => row.id),
      matrix().map((step) => step.id),
    );
    // Both registrations fire for one tool call, so each step captures two
    // envelopes. That count IS the answer to the first question.
    assert.ok(
      rows.every((row) => row.captured === 2),
      `each step should capture both registrations: ${JSON.stringify(rows.map((row) => row.captured))}`,
    );

    // ANSWER 1: both files fired, and the report names them.
    assert.match(out, /=== ANSWER 1\./u);
    assert.match(out, /Fired: grok, claude|Fired: claude, grok/u);
    assert.match(out, /THE COMPATIBILITY READ IS REAL/u);
    assert.match(out, /native hook file fired too \(the control\)/u);

    // ANSWER 2: the camelCase envelope, read off the capture.
    assert.match(out, /=== ANSWER 2\./u);
    assert.match(out, /camelCase keys: .*toolName/u);

    // ANSWER 3: the hazard, measured rather than repeated.
    assert.match(out, /=== ANSWER 3\./u);
    assert.match(out, /THE HAZARD IS CONFIRMED/u);
    assert.equal(existsSync(join(pointer.project, trialArtifact("hazard"))), true);

    // The dialect the shipped adapter emits blocks; the same body at exit 0 also
    // blocks on this fake, because that is what the vendor documents.
    assert.match(out, /deny-grok-exit2: BLOCKED/u);
    assert.equal(existsSync(join(pointer.project, trialArtifact("deny-grok-exit2"))), false);
    // The control ran, so every line above is a measurement rather than a
    // harness that withholds everything.
    assert.match(out, /allow: RAN/u);
    // And the documented fail-open, measured.
    assert.match(out, /crash: FAILED OPEN/u);
    assert.match(out, /garbage: FAILED OPEN/u);

    assert.match(out, /=== HOW THIS ROUND WAS RUN ===/u);
    assert.match(out, /version read BEFORE anything was written/u);
  } finally {
    delete process.env["FAKE_GROK_VERSION"];
    delete process.env["FAKE_GROK_HOOK_TIMEOUT_MS"];
    cleanup();
  }
});

test("a harness that ignores the Claude settings file reads as the hazard NOT firing", () => {
  process.env["FAKE_GROK_VERSION"] = "grok 0.9.0 (fake)";
  process.env["FAKE_GROK_HOOK_TIMEOUT_MS"] = "2000";
  process.env["FAKE_GROK_IGNORE_CLAUDE_SETTINGS"] = "1";
  try {
    const { code, out } = runDriver(["--step-timeout", "30000"]);
    assert.equal(code, 0, out);
    const pointer = JSON.parse(readFileSync(TEST_POINTER, "utf8")) as Pointer;
    created.push(pointer.root);

    // The reading that closes AC1 the other way, and the control that makes it
    // trustworthy: the native file DID fire, so the round measured something.
    assert.match(out, /Fired: grok\./u);
    assert.match(out, /Claude settings file did NOT fire from a project directory/u);
    assert.match(out, /USER-level settings file was not tested/u);
    assert.match(out, /native hook file fired too \(the control\)/u);
    // With no Claude entry the hazard trial's own deny is never spoken, so the
    // artifact lands and the hazard section reads on the native answer instead.
    assert.match(out, /=== ANSWER 3\./u);
  } finally {
    delete process.env["FAKE_GROK_VERSION"];
    delete process.env["FAKE_GROK_HOOK_TIMEOUT_MS"];
    delete process.env["FAKE_GROK_IGNORE_CLAUDE_SETTINGS"];
    cleanup();
  }
});

test("run ABORTS after one invocation when nothing reached either hook", () => {
  process.env["FAKE_GROK_VERSION"] = "grok 0.9.0 (fake)";
  process.env["FAKE_GROK_INERT"] = "1";
  try {
    const { code, warn } = runDriver(["--step-timeout", "20000"]);
    assert.equal(code, 4);
    const pointer = JSON.parse(readFileSync(TEST_POINTER, "utf8")) as Pointer;
    created.push(pointer.root);
    const rows = readFileSync(join(pointer.state, "runs.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "");
    assert.equal(rows.length, 1, "one wasted invocation, not six");
    assert.match(warn, /ROUND ABORTED/u);
    assert.match(warn, /the one-shot spelling/u);
    assert.match(warn, /USER-level/u, "and the project-versus-user question is named");
  } finally {
    delete process.env["FAKE_GROK_VERSION"];
    delete process.env["FAKE_GROK_INERT"];
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

test("report with no capture says NEITHER, and rules out the boring causes first", () => {
  try {
    const { state } = runSetup();
    const out = runReport(state);
    assert.match(out, /NEITHER, or the/u);
    // A confirmed no closes AC1 as well as a yes, but only after the boring
    // causes are excluded, so the report names them rather than letting a reader
    // record a finding that was really a misconfiguration.
    assert.match(out, /one-shot spelling/u);
    assert.match(out, /user-level settings file/u);
    assert.match(out, /a session with no model/u);
  } finally {
    cleanup();
  }
});

test("a hand-typed round says so, and names the verb that would have driven it", () => {
  try {
    const { state, project } = runSetup();
    runRecord(
      state,
      envelope({ cwd: project, toolInput: { filePath: join(project, "x.txt"), content: "x" } }),
    );
    const out = runReport(state);
    assert.match(out, /=== HOW THIS ROUND WAS RUN ===/u);
    assert.match(out, /BY HAND/u);
    assert.match(out, /harness\.launch\.grok/u);
    assert.match(out, /grok-build-hook\.mjs run/u);
  } finally {
    cleanup();
  }
});

test("a PRESENT artifact names the later call that could have created it", () => {
  try {
    const { state, project } = runSetup();
    const name = trialArtifact("deny-grok-exit2");
    arm(
      [
        "node",
        "grok-build-hook.mjs",
        "arm",
        "deny-grok-exit2",
        "--state",
        state,
        "--step",
        "deny-grok-exit2",
      ],
      () => {},
    );
    runRecord(
      state,
      envelope({ cwd: project, toolInput: { filePath: join(project, name), content: "x" } }),
    );
    // The hole the Hermes round fell into twice: after a refusal the model
    // retries the same effect, and the retry can create the file whose absence
    // was the measurement. In a driven round the step label says whether the
    // retry was inside the same session.
    runRecord(
      state,
      envelope({
        toolName: "Bash",
        cwd: project,
        toolInput: { command: `touch ${join(project, name)}` },
      }),
    );
    writeFileSync(join(project, name), "x\n", "utf8");

    const out = runReport(state);
    assert.match(out, /deny-grok-exit2: FAILED OPEN/u);
    assert.match(out, /in the SAME one-shot session \(step deny-grok-exit2\)/u);
  } finally {
    cleanup();
  }
});

test("an unparseable capture line does not stop the report", () => {
  try {
    const { state, project } = runSetup();
    runRecord(state, "{not json at all");
    runRecord(
      state,
      envelope({ cwd: project, toolInput: { filePath: join(project, "x.txt"), content: "x" } }),
    );
    const out = runReport(state);
    assert.match(out, /=== ANSWER 1\./u);
  } finally {
    cleanup();
  }
});
