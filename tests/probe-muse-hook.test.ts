import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

// The probe is plain Node ESM on purpose: an operator runs it straight from a
// checkout, before any build. Its exports are exercised here without adding a
// declaration file, exactly as tests/codex-hook-probe.test.ts does.
// @ts-expect-error no declaration file for the standalone probe script
import * as probe from "../../scripts/probes/muse-hook.mjs";

const {
  KNOWN_CONTRIBUTOR_MODELS,
  KNOWN_STANDARD_MODELS,
  SYNTHETIC_FILES,
  TRIALS,
  arm,
  buildConfigs,
  classifyModel,
  record,
  redact,
  report,
  resolveCwd,
  resolveModel,
  resolveProvider,
  setup,
  trialArtifact,
} = probe as {
  KNOWN_CONTRIBUTOR_MODELS: string[];
  KNOWN_STANDARD_MODELS: string[];
  SYNTHETIC_FILES: Record<string, string>;
  TRIALS: string[];
  arm: (argv: string[], write?: (text: string) => void) => number;
  buildConfigs: (state: string) => { id: string; path: string; body: unknown }[];
  classifyModel: (model: string | null, declared: string[]) => { verdict: string; reason: string };
  record: (argv: string[], io?: Record<string, unknown>) => number;
  redact: (text: string) => string;
  report: (argv: string[], write?: (text: string) => void) => number;
  resolveCwd: (envelope: unknown) => { key: string | null; value: string | null };
  resolveModel: (envelope: unknown) => { key: string | null; value: string | null };
  resolveProvider: (envelope: unknown) => { key: string | null; value: string | null };
  setup: (argv: string[], write?: (text: string) => void) => number;
  trialArtifact: (trial: string) => string;
};

const created: string[] = [];

/** Run `--setup` capturing its output, and remember the scratch root for cleanup. */
function runSetup(extra: string[] = []): { out: string; state: string; project: string; root: string } {
  let out = "";
  const code = setup(["node", "muse-hook.mjs", "--setup", ...extra], (text: string) => {
    out += text;
  });
  assert.equal(code, 0);
  const pointer = JSON.parse(readFileSync(probe.POINTER as string, "utf8")) as {
    state: string;
    project: string;
    root: string;
  };
  created.push(pointer.root);
  return { out, ...pointer };
}

function cleanup() {
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

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: "PreToolUse",
    session_id: "probe-session",
    cwd: "/tmp/scratch-project",
    tool_name: "Bash",
    tool_input: { command: "ls" },
    model: "muse-spark-1.3",
    ...overrides,
  };
}

/** Drive `--record` with a canned envelope, returning the exit code and streams. */
function runRecord(
  state: string,
  input: Record<string, unknown>,
  extra: string[] = [],
): { code: number; out: string; warn: string; slept: boolean } {
  let out = "";
  let warn = "";
  let slept = false;
  const code = record(["node", "muse-hook.mjs", "--record", "--state", state, ...extra], {
    readInput: () => JSON.stringify(input),
    write: (text: string) => {
      out += text;
    },
    warn: (text: string) => {
      warn += text;
    },
    sleep: () => {
      slept = true;
    },
  });
  return { code, out, warn, slept };
}

function decisionOf(out: string): string {
  const parsed = JSON.parse(out) as {
    hookSpecificOutput: { permissionDecision: string };
    permission_decision: string;
  };
  // The probe emits a superset dialect; both carriers must agree, or a harness
  // that reads one key and a reader that reads the other would disagree.
  assert.equal(parsed.hookSpecificOutput.permissionDecision, parsed.permission_decision);
  return parsed.permission_decision;
}

// ---------------------------------------------------------------------------
// --setup: synthetic files only
// ---------------------------------------------------------------------------

test("setup creates only synthetic files and hook configs, all inside the scratch project", () => {
  try {
    const { out, project, state } = runSetup();

    const files = walk(project).sort();
    const configs = buildConfigs(state).map((config) => config.path);
    const expected = [...Object.keys(SYNTHETIC_FILES), ...configs].sort();
    assert.deepEqual(files, expected, "the scratch project holds nothing but generated files");

    // Nothing copied in: every synthetic file is byte-identical to the constant
    // the script carries, so no real file can have been read into the fixture.
    for (const [name, body] of Object.entries(SYNTHETIC_FILES)) {
      assert.equal(readFileSync(join(project, name), "utf8"), body);
    }

    // Muse ingests these as agent instructions in a trusted workspace, so the
    // scratch project must not contain them.
    for (const forbidden of ["AGENTS.md", "CLAUDE.md", ".agents/AGENTS.md", ".claude/CLAUDE.md"]) {
      assert.equal(existsSync(join(project, forbidden)), false, `${forbidden} must not exist`);
    }

    // Each config is valid JSON inside the project and points back at --record.
    for (const config of buildConfigs(state)) {
      const raw = readFileSync(join(project, config.path), "utf8");
      assert.doesNotThrow(() => JSON.parse(raw));
      assert.match(raw, /--record/u, `${config.path} invokes the recorder`);
      assert.match(raw, /--config-id/u, `${config.path} identifies itself`);
    }

    assert.match(out, /CONTRIBUTOR MODEL IS NOT\nSELECTED/u, "the warning is in capitals, up front");
    assert.match(out, /NEVER RUN THIS PROBE INSIDE A REAL REPOSITORY/u);
    assert.match(out, /~\/\.config\/muse\/settings\.json/u, "the setting's location is named");
    assert.match(out, /CANNOT PIN THE MODEL FOR YOU/u, "no project-level pin exists, and it says so");
    assert.match(out, /list the files here/u);
    assert.match(out, /create a file named probe\.txt containing the word hello/u);
    assert.match(out, /read README\.md and tell me its first line/u);
    for (const trial of TRIALS) {
      assert.match(out, new RegExp(`--arm ${trial}`, "u"), `the ${trial} trial command is printed`);
    }
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// The contributor-model guard
// ---------------------------------------------------------------------------

test("a contributor model denies, an unknown model denies, a standard model allows", () => {
  try {
    const { state } = runSetup();

    for (const model of KNOWN_CONTRIBUTOR_MODELS) {
      const result = runRecord(state, envelope({ model }));
      assert.equal(decisionOf(result.out), "deny", `${model} must deny`);
      assert.equal(result.code, 2);
      assert.match(result.warn, /CONTRIBUTOR-MODEL GUARD DENIED/u);
    }

    // The mark, not the list, is what protects against a model Meta ships next.
    const future = runRecord(state, envelope({ model: "muse-spark-9.9-contributor" }));
    assert.equal(decisionOf(future.out), "deny", "an unlisted contributor model still denies");

    const unknown = runRecord(state, envelope({ model: "some-model-nobody-has-heard-of" }));
    assert.equal(decisionOf(unknown.out), "deny", "unknown is not safe");

    const absent = runRecord(state, envelope({ model: undefined }));
    assert.equal(decisionOf(absent.out), "deny", "no model at all denies");

    for (const model of KNOWN_STANDARD_MODELS) {
      const result = runRecord(state, envelope({ model }));
      assert.equal(decisionOf(result.out), "allow", `${model} may allow`);
      assert.equal(result.code, 0);
    }
  } finally {
    cleanup();
  }
});

test("an operator declaration widens the guard but can never launder a contributor model", () => {
  try {
    const { state } = runSetup(["--known-safe-model", "muse-spark-4.0"]);
    assert.equal(decisionOf(runRecord(state, envelope({ model: "muse-spark-4.0" })).out), "allow");
    assert.equal(decisionOf(runRecord(state, envelope({ model: "muse-spark-4.1" })).out), "deny");
  } finally {
    cleanup();
  }

  try {
    // Declaring a contributor model safe must not make it safe: the suffix rule
    // runs first, so the operator can widen the guard but not switch it off.
    const { state } = runSetup(["--known-safe-model", "muse-spark-1.3-contributor"]);
    const result = runRecord(state, envelope({ model: "muse-spark-1.3-contributor" }));
    assert.equal(decisionOf(result.out), "deny");
    assert.match(result.out, /CONTRIBUTOR model/u, "the refusal names the tier");
  } finally {
    cleanup();
  }
});

test("classifyModel is deny-by-default and case-insensitive", () => {
  assert.equal(classifyModel(null, []).verdict, "deny");
  assert.equal(classifyModel("", []).verdict, "deny");
  assert.equal(classifyModel("MUSE-SPARK-1.3-CONTRIBUTOR", []).verdict, "deny");
  assert.equal(classifyModel("MUSE-SPARK-1.3", []).verdict, "allow");
  assert.equal(classifyModel("muse-spark-1.3", []).verdict, "allow");
});

// ---------------------------------------------------------------------------
// Capture, redaction and envelope walking
// ---------------------------------------------------------------------------

test("the envelope is captured verbatim, with token-shaped strings redacted", () => {
  try {
    const { state } = runSetup();
    runRecord(state, envelope({ auth_token: "abcd1234efgh5678ijkl", model: "muse-spark-1.3" }));
    const captured = readFileSync(join(state, "envelopes.jsonl"), "utf8");
    assert.match(captured, /"model":"muse-spark-1\.3"/u);
    assert.match(captured, /redacted/u, "the token-shaped value is redacted");
    assert.equal(captured.includes("abcd1234efgh5678ijkl"), false, "the token never lands on disk");
    assert.match(captured, /\\"tool_name\\":\\"Bash\\"/u, "the rest of the envelope is verbatim");
  } finally {
    cleanup();
  }
});

test("redaction covers bearer tokens, JWTs and keyed secrets", () => {
  assert.match(redact("Authorization: Bearer abcdefghijklmnop"), /Bearer <redacted>/u);
  assert.match(redact('{"session_token":"supersecretvalue"}'), /<redacted>/u);
  assert.equal(redact('{"session_token":"supersecretvalue"}').includes("supersecretvalue"), false);
  assert.match(redact("eyJhbGciOiJIUzI1NiwidHlwIjoiSldUIn0abc"), /<redacted-jwt>/u);
  assert.equal(redact("ordinary text"), "ordinary text");
});

test("model, provider and cwd are found wherever the envelope nests them", () => {
  assert.deepEqual(resolveModel({ session: { modelId: "muse-spark-1.3" } }), {
    key: "session.modelId",
    value: "muse-spark-1.3",
  });
  assert.deepEqual(resolveProvider({ model_provider: "meta" }), { key: "model_provider", value: "meta" });
  assert.deepEqual(resolveCwd({ context: { cwd: "/tmp/x" } }), { key: "context.cwd", value: "/tmp/x" });
  // A relative path is not a working directory the adapter could bind to.
  assert.equal(resolveCwd({ cwd: "relative/path" }).key, null);
  assert.equal(resolveModel({}).value, null);
});

// ---------------------------------------------------------------------------
// Armed trials
// ---------------------------------------------------------------------------

test("each armed trial fires once, then disarms", () => {
  try {
    const { state } = runSetup();

    assert.equal(arm(["node", "muse-hook.mjs", "--arm", "crash", "--state", state], () => {}), 0);
    const crash = runRecord(state, envelope());
    assert.equal(crash.code, 1, "crash exits non-zero");
    assert.equal(crash.out, "", "crash prints no verdict at all");

    // The arm is consumed: the very next call behaves normally again.
    assert.equal(decisionOf(runRecord(state, envelope()).out), "allow");

    arm(["node", "muse-hook.mjs", "--arm", "hang", "--state", state], () => {});
    const hung = runRecord(state, envelope());
    assert.equal(hung.slept, true, "hang blocks past the per-hook timeout");

    arm(["node", "muse-hook.mjs", "--arm", "garbage", "--state", state], () => {});
    const garbage = runRecord(state, envelope());
    assert.equal(garbage.code, 0);
    assert.throws(() => JSON.parse(garbage.out), "garbage is not parseable as a verdict");

    arm(["node", "muse-hook.mjs", "--arm", "deny", "--state", state], () => {});
    const denied = runRecord(state, envelope());
    assert.equal(decisionOf(denied.out), "deny", "an explicit, well-formed refusal");
    assert.equal(denied.code, 2);

    assert.equal(arm(["node", "muse-hook.mjs", "--arm", "nonsense", "--state", state], () => {}), 2);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// --report
// ---------------------------------------------------------------------------

test("report leads with the model line and answers each question", () => {
  try {
    const { state, project } = runSetup();
    runRecord(state, envelope({ tool_name: "Bash" }), ["--config-id", "project-muse-hooks-json"]);
    runRecord(
      state,
      envelope({ tool_name: "Write", tool_input: { file_path: "probe.txt", content: "hello" } }),
      ["--config-id", "project-muse-hooks-json"],
    );
    runRecord(state, envelope({ tool_name: "Read", tool_input: { file_path: "README.md" } }), [
      "--config-id",
      "project-muse-hooks-json",
    ]);

    let out = "";
    assert.equal(report(["node", "muse-hook.mjs", "--state", state, "--report"], (t: string) => {
      out += t;
    }), 0);

    assert.match(out.split("\n")[0] ?? "", /^MODEL REPORTED: muse-spark-1\.3$/u, "line 1 is the model");
    assert.match(out, /FIRED {2}\.muse\/hooks\.json/u, "the config that fired is named");
    assert.match(out, /silent {2}\.muse\/settings\.json/u, "the ones that did not are named too");
    assert.match(out, /PRESENT under: cwd/u, "the per-call working directory is reported");
    assert.match(out, /Bash/u);
    assert.match(out, /Write/u);
    assert.match(out, /Read/u);
    assert.match(out, /did NOT happen -> the deny was honoured \(FAIL CLOSED\)/u);

    // The same report, once the write happened anyway, must read fail open.
    writeFileSync(join(project, "probe.txt"), "hello", "utf8");
    writeFileSync(join(project, trialArtifact("crash")), "x", "utf8");
    arm(["node", "muse-hook.mjs", "--arm", "crash", "--state", state], () => {});
    runRecord(state, envelope());
    let second = "";
    report(["node", "muse-hook.mjs", "--state", state, "--report"], (t: string) => {
      second += t;
    });
    assert.match(second, /FAIL OPEN/u);
    assert.match(second, /crash: FAIL OPEN/u);
  } finally {
    cleanup();
  }
});

test("a report with no captures says so rather than implying a clean result", () => {
  try {
    const { state } = runSetup();
    let out = "";
    report(["node", "muse-hook.mjs", "--state", state, "--report"], (t: string) => {
      out += t;
    });
    assert.match(out, /^MODEL REPORTED: \(nothing captured\)/u);
    assert.match(out, /no envelopes reached the hook/u);
  } finally {
    cleanup();
  }
});
