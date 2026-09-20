/**
 * `scripts/probes/hermes-hook.mjs` (APRV-398), driven with canned envelopes.
 *
 * The probe's whole job is to be run once, by a human, against an installed
 * Hermes Agent. This suite exists so that when that happens the script does not
 * fail on its own bugs: every path through it is exercised here with no install
 * anywhere, exactly as `tests/probe-muse-hook.test.ts` does for the Muse probe.
 *
 * Two properties are asserted rather than trusted, because the Muse probe got
 * both wrong on a live run and each cost a round:
 *
 *   1. the scratch project holds ONLY synthetic files, and no `AGENTS.md` or
 *      `CLAUDE.md` — a coding harness reads those as instructions, so a real
 *      project's rules would enter the session;
 *   2. the pointer file is INJECTABLE, and this suite redirects it. The Muse
 *      suite once wrote the real pointer under the system temp root and a test
 *      run during a live session repointed the operator's arm mid-round, so the
 *      trial they armed landed nowhere.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, test } from "node:test";

// The probe is plain Node ESM on purpose: an operator runs it straight from a
// checkout, before any build. Its exports are exercised here without adding a
// declaration file, exactly as tests/probe-muse-hook.test.ts does.
// @ts-expect-error no declaration file for the standalone probe script
import * as probe from "../../scripts/probes/hermes-hook.mjs";

const {
  ALL_TRIALS,
  BLOCK_START,
  DIALECT_TRIALS,
  FAIL_TRIALS,
  SYNTHETIC_FILES,
  arm,
  buildConfig,
  conflictingKeys,
  dialectAnswer,
  failClosedVerb,
  mixedDenyPayload,
  outsideProject,
  record,
  redact,
  report,
  setup,
  stripBlock,
  trialArtifact,
} = probe as {
  ALL_TRIALS: string[];
  BLOCK_START: string;
  DIALECT_TRIALS: string[];
  FAIL_TRIALS: string[];
  SYNTHETIC_FILES: Record<string, string>;
  arm: (argv: string[], write?: (text: string) => void) => number;
  buildConfig: (state: string, failClosed: boolean) => string;
  conflictingKeys: (text: string) => string[];
  stripBlock: (text: string) => string;
  dialectAnswer: (
    trial: string,
    reason: string,
  ) => { body: Record<string, unknown> | null; code: number } | null;
  failClosedVerb: (argv: string[], write?: (text: string) => void) => number;
  mixedDenyPayload: (reason: string) => Record<string, unknown>;
  outsideProject: (envelope: unknown, project: string) => string | null;
  record: (argv: string[], io?: Record<string, unknown>) => number;
  redact: (text: string) => string;
  report: (argv: string[], write?: (text: string) => void) => number;
  setup: (argv: string[], write?: (text: string) => void) => number;
  trialArtifact: (trial: string, failClosed: boolean) => string;
};

/** This suite's OWN pointer file; see the header for the incident behind it. */
const POINTER_DIR = mkdtempSync(join(tmpdir(), "approval-hermes-probe-test-"));
const TEST_POINTER = join(POINTER_DIR, "pointer.json");
process.env["APPROVAL_HERMES_PROBE_POINTER"] = TEST_POINTER;

const created: string[] = [];

after(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
  rmSync(POINTER_DIR, { recursive: true, force: true });
  delete process.env["APPROVAL_HERMES_PROBE_POINTER"];
});

interface Pointer {
  state: string;
  project: string;
  home: string;
  root: string;
}

function runSetup(): { out: string } & Pointer {
  let out = "";
  const code = setup(["node", "hermes-hook.mjs", "setup"], (text: string) => {
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

/** A Hermes `pre_tool_call` envelope, in the shape its own payload builder emits. */
function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: "pre_tool_call",
    session_id: "probe-session",
    cwd: "/tmp/scratch-project",
    profile: "default",
    tool_name: "terminal",
    tool_input: { command: "ls" },
    extra: { turn_id: "t1", tool_call_id: "c1" },
    ...overrides,
  };
}

/** Drive `record` with a canned envelope, returning the exit code and streams. */
function runRecord(
  state: string,
  input: Record<string, unknown> | string,
  extra: string[] = [],
): { code: number; out: string; warn: string; slept: boolean } {
  let out = "";
  let warn = "";
  let slept = false;
  const code = record(["node", "hermes-hook.mjs", "record", "--state", state, ...extra], {
    readInput: () => (typeof input === "string" ? input : JSON.stringify(input)),
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

function runReport(state: string): string {
  let out = "";
  report(["node", "hermes-hook.mjs", "report", "--state", state], (text: string) => {
    out += text;
  });
  return out;
}

// ---------------------------------------------------------------------------
// setup: synthetic files only, and a scratch HERMES_HOME
// ---------------------------------------------------------------------------

test("setup creates only synthetic files, and the hook config lives in a SCRATCH home", () => {
  try {
    const { out, project, home, state } = runSetup();

    // The project holds the synthetic files and nothing else. Unlike the Muse
    // probe, the hook config is NOT in the project: Hermes has no project-local
    // configuration directory, so it goes in the scratch home.
    assert.deepEqual(walk(project).sort(), Object.keys(SYNTHETIC_FILES).sort());
    for (const [name, body] of Object.entries(SYNTHETIC_FILES)) {
      assert.equal(readFileSync(join(project, name), "utf8"), body);
    }

    // A coding harness reads these as agent instructions in a trusted
    // workspace, so the fixture must not contain them.
    for (const forbidden of ["AGENTS.md", "CLAUDE.md", ".agents/AGENTS.md", ".claude/CLAUDE.md"]) {
      assert.equal(existsSync(join(project, forbidden)), false, `${forbidden} must not exist`);
    }

    // The scratch home holds a config and nothing else: no credential, no
    // allowlist, nothing copied from the operator's own ~/.hermes.
    assert.deepEqual(walk(home).sort(), ["config.yaml"]);
    for (const secret of [".env", "auth.json", "shell-hooks-allowlist.json"]) {
      assert.equal(existsSync(join(home, secret)), false, `${secret} must not be created`);
    }

    const config = readFileSync(join(home, "config.yaml"), "utf8");
    assert.match(config, /record/u, "the config invokes the recorder");
    assert.match(config, /--config-id/u, "and each entry identifies itself");
    assert.match(config, new RegExp(state.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));

    assert.match(out, /NEVER RUN THIS PROBE INSIDE A REAL REPOSITORY/u);
    assert.match(out, /export HERMES_HOME=/u, "the export is printed, not assumed");
    assert.match(out, /fail_closed/u, "and the finding under test is named up front");
    for (const trial of ALL_TRIALS) {
      assert.match(out, new RegExp(`arm ${trial}`, "u"), `the ${trial} trial command is printed`);
    }
  } finally {
    cleanup();
  }
});

test("the generated config is the event-keyed shape Hermes actually loads", () => {
  // An `- event: pre_tool_call` entry is the shape another harness uses and the
  // shape Hermes does NOT load. Getting this wrong costs a whole probe round: the
  // config would be rejected or ignored and the absence would read as "the hook
  // never fired" rather than "the config was wrong".
  const withKey = buildConfig("/tmp/state", true);
  assert.match(withKey, /^hooks:$/mu);
  assert.match(withKey, /^ {2}pre_tool_call:$/mu, "the event is a mapping key");
  assert.match(withKey, /^ {2}post_tool_call:$/mu);
  assert.match(withKey, /^ {4}- command: /mu, "and each entry is a list item under it");
  assert.equal(/- event:/u.test(withKey), false, "never the entry-field shape");
  assert.equal(/matcher:/u.test(withKey), false, "and no matcher, so every tool is captured");

  // Both timeouts, explicitly. The outer one fails closed on pre_tool_call at
  // 30s by default, which would make every `hang` trial block for a reason that
  // has nothing to do with the key under test.
  assert.match(withKey, /hook_callback_timeout: 600/u);
  assert.match(withKey, /timeout: 300/u);
  // The headless consent, whose absence makes Hermes silently skip registering
  // the hook rather than complain.
  assert.match(withKey, /hooks_auto_accept: true/u);

  assert.match(withKey, /fail_closed: true/u);
  const without = buildConfig("/tmp/state", false);
  assert.equal(
    /^\s+fail_closed:/mu.test(without),
    false,
    "the off variant carries the key on no entry",
  );
  assert.match(without, /ABSENT on every entry/u, "and the file's own header says which variant it is");
});

test("fail-closed on and off rewrite the config and record which way it stands", () => {
  try {
    const { state, home } = runSetup();
    let out = "";
    assert.equal(
      failClosedVerb(["node", "hermes-hook.mjs", "fail-closed", "off", "--state", state], (text: string) => {
        out += text;
      }),
      0,
    );
    assert.equal(
      /^\s+fail_closed:/mu.test(readFileSync(join(home, "config.yaml"), "utf8")),
      false,
      "the rewritten config carries the key on no entry",
    );
    assert.match(out, /Restart hermes/u, "the operator is told the config is only read at startup");

    // An armed trial records the CURRENT fail_closed state with it, so the
    // report can pair the two halves of one trial. Without that the two rounds
    // of `crash` would be indistinguishable in the capture.
    let armed = "";
    assert.equal(
      arm(["node", "hermes-hook.mjs", "arm", "crash", "--state", state], (text: string) => {
        armed += text;
      }),
      0,
    );
    assert.match(armed, /fail_closed is currently ABSENT/u);
    assert.match(armed, new RegExp(trialArtifact("crash", false), "u"));

    assert.equal(
      failClosedVerb(["node", "hermes-hook.mjs", "fail-closed", "on", "--state", state]),
      0,
    );
    assert.match(readFileSync(join(home, "config.yaml"), "utf8"), /fail_closed: true/u);
  } finally {
    cleanup();
  }
});

test("setup installs into an EXISTING HERMES_HOME between markers, and backs it up once", () => {
  const home = mkdtempSync(join(tmpdir(), "aprv398-real-home-"));
  const captures = mkdtempSync(join(tmpdir(), "aprv398-captures-"));
  created.push(home, captures);
  try {
    // A real install's config: it has content the probe did not write, and none
    // of it may be lost. This is the case that matters — the scratch home the
    // other tests use is the easy one.
    const original = ["model: some-small-model", "approvals:", "  mode: manual", ""].join("\n");
    writeFileSync(join(home, "config.yaml"), original, "utf8");

    let out = "";
    const code = setup(
      ["node", "hermes-hook.mjs", "setup", "--home", home, "--captures", captures],
      (text: string) => {
        out += text;
      },
    );
    assert.equal(code, 0, out);

    const written = readFileSync(join(home, "config.yaml"), "utf8");
    assert.match(written, /^model: some-small-model$/mu, "the operator's own keys survive");
    assert.match(written, /^approvals:$/mu);
    assert.match(written, new RegExp(BLOCK_START.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    assert.match(written, /fail_closed: true/u);
    // The backup is the state BEFORE the probe touched anything, which is the
    // only version worth keeping.
    assert.equal(readFileSync(join(home, "config.yaml.aprv398-backup"), "utf8"), original);

    // Re-running is idempotent: the block is replaced, not duplicated, and the
    // backup is not overwritten with an already-modified file.
    failClosedVerb(["node", "hermes-hook.mjs", "fail-closed", "off", "--captures", captures, "--state", captures]);
    const again = readFileSync(join(home, "config.yaml"), "utf8");
    assert.equal(again.split(BLOCK_START).length - 1, 1, "exactly one probe block, ever");
    assert.equal(/^\s+fail_closed:/mu.test(again), false);
    assert.equal(readFileSync(join(home, "config.yaml.aprv398-backup"), "utf8"), original);

    // Stripping the block gives back something that still holds the operator's
    // keys, which is what makes the region safely removable by hand afterwards.
    assert.match(stripBlock(again), /^model: some-small-model$/mu);
    assert.equal(stripBlock(again).includes("fail_closed"), false);

    // The runbook changes shape for a real home: it must say a live model is
    // needed, because the probe measures tool calls and only a model makes them.
    assert.match(out, /A LIVE MODEL IS NEEDED/u);
    assert.match(out, /hermes setup/u);
    assert.match(out, /YOUR HERMES_HOME/u);
    assert.match(out, new RegExp(captures.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  } finally {
    cleanup();
  }
});

test("setup REFUSES a config that already configures its own hooks, and prints the block", () => {
  const home = mkdtempSync(join(tmpdir(), "aprv398-clash-home-"));
  created.push(home);
  try {
    // YAML permits no duplicate top-level key, so appending a second `hooks:`
    // would make the file unparseable and Hermes would start with NO hooks —
    // indistinguishable from a probe whose config never fired. Refusing is the
    // only honest answer, and it must leave the file exactly as it was.
    const original = ["hooks:", "  pre_tool_call:", "    - command: mine", ""].join("\n");
    writeFileSync(join(home, "config.yaml"), original, "utf8");
    assert.deepEqual(conflictingKeys(original), ["hooks"]);

    const code = setup(["node", "hermes-hook.mjs", "setup", "--home", home], () => {});
    assert.equal(code, 2, "a refusal, not a silent merge");
    assert.equal(readFileSync(join(home, "config.yaml"), "utf8"), original, "nothing was touched");
    assert.equal(existsSync(join(home, "config.yaml.aprv398-backup")), false, "and nothing backed up");
  } finally {
    cleanup();
  }
});

test("fail-closed and arm refuse a value they do not know, and refuse with no state", () => {
  assert.equal(failClosedVerb(["node", "hermes-hook.mjs", "fail-closed", "maybe"]), 2);
  assert.equal(arm(["node", "hermes-hook.mjs", "arm", "explode"]), 2);
});

// ---------------------------------------------------------------------------
// The path jail
// ---------------------------------------------------------------------------

test("the path jail catches every documented path key, and a list entry", () => {
  const project = mkdtempSync(join(tmpdir(), "aprv398-jail-"));
  created.push(project);
  try {
    // Inside, in every spelling the tools use.
    assert.equal(outsideProject(envelope({ tool_input: { command: "ls" } }), project), null);
    assert.equal(
      outsideProject(envelope({ tool_name: "read_file", tool_input: { path: "README.md" } }), project),
      null,
    );
    assert.equal(
      outsideProject(
        envelope({ tool_name: "write_file", tool_input: { path: join(project, "x.txt"), content: "x" } }),
        project,
      ),
      null,
    );

    // Outside, in each of them.
    assert.match(
      String(outsideProject(envelope({ tool_name: "read_file", tool_input: { path: "/etc/hosts" } }), project)),
      /path/u,
    );
    assert.match(
      String(outsideProject(envelope({ tool_input: { command: "ls", workdir: "/etc" } }), project)),
      /workdir/u,
    );
    // A list, even though no Hermes tool ships one today: an array arriving from
    // a later release must not be waved through because the key held the wrong
    // type.
    assert.match(
      String(outsideProject(envelope({ tool_name: "read_file", tool_input: { paths: [project, "/etc"] } }), project)),
      /paths\[\]/u,
    );
    // A word of the command that reaches out.
    assert.match(
      String(outsideProject(envelope({ tool_input: { command: "cat /etc/passwd" } }), project)),
      /a word of the command/u,
    );

    // FAIL CLOSED on a value this cannot place: a home shortcut and an
    // unexpanded parameter are both "outside", because a value nothing can
    // resolve is a value nothing can say is inside.
    assert.notEqual(
      outsideProject(envelope({ tool_name: "read_file", tool_input: { path: "~/secrets" } }), project),
      null,
    );
    assert.notEqual(
      outsideProject(envelope({ tool_name: "read_file", tool_input: { path: "$HOME/secrets" } }), project),
      null,
    );

    // The unbound tool, and an envelope that is not an envelope.
    assert.match(String(outsideProject(envelope({ tool_name: "execute_code", tool_input: { code: "1" } }), project)), /execute_code/u);
    assert.match(String(outsideProject(null, project)), /unparseable/u);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// record
// ---------------------------------------------------------------------------

test("an unarmed call inside the project allows with {} and no reason in the body", () => {
  try {
    const { state, project } = runSetup();
    const run = runRecord(state, envelope({ cwd: project, tool_input: { command: "ls", workdir: project } }));
    assert.equal(run.code, 0);
    // The shipped allow: a JSON object naming no directive. Hermes has no allow
    // directive, so this is its vocabulary rather than a shrug.
    assert.deepEqual(JSON.parse(run.out), {});
    assert.match(run.warn, /allow/u, "and the reason is on stderr, where there is room for it");
  } finally {
    cleanup();
  }
});

test("an unarmed call reaching outside the project blocks, with the directive AND exit 2", () => {
  try {
    const { state, project } = runSetup();
    const run = runRecord(state, envelope({ cwd: project, tool_input: { command: "cat /etc/passwd" } }));
    const body = JSON.parse(run.out) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["action", "message"]);
    assert.equal(body["action"], "block");
    assert.equal(run.code, 2, "the blocking exit code as well, which is the shipped adapter's deny");
    assert.match(run.warn, /PATH JAIL REFUSED/u);
    // The warning must say what a refusal here does and does not prove: if
    // Hermes fails open the call happens anyway, which is the thing under test.
    assert.match(run.warn, /does not recall what the model already saw/u);
  } finally {
    cleanup();
  }
});

test("execute_code is refused by the probe too, for the adapter's own reason", () => {
  try {
    const { state, project } = runSetup();
    const run = runRecord(state, envelope({ cwd: project, tool_name: "execute_code", tool_input: { code: "print(1)" } }));
    assert.equal(run.code, 2);
    assert.match(String((JSON.parse(run.out) as Record<string, unknown>)["message"]), /execute_code/u);
  } finally {
    cleanup();
  }
});

test("each dialect trial prints exactly one form, and mixed prints every form", () => {
  for (const trial of DIALECT_TRIALS) {
    const answer = dialectAnswer(trial, "why");
    assert.notEqual(answer, null, `${trial} has no answer defined`);
    if (answer === null) throw new Error("unreachable");
    if (trial === "deny-mixed") {
      // The one trial that is deliberately not single-variable: it carries every
      // dialect at once, which is the payload that failed OPEN on Muse.
      assert.deepEqual(
        Object.keys(answer.body ?? {}).sort(),
        ["action", "decision", "hookSpecificOutput", "message", "reason"],
      );
      continue;
    }
    const keys = Object.keys(answer.body ?? {});
    assert.ok(keys.length <= 2, `${trial} prints more than one dialect: ${keys.join(", ")}`);
    // No trial may carry both a Hermes key and a Claude key, or it measures two
    // variables at once and the round proves nothing.
    assert.equal(
      keys.includes("action") && keys.includes("decision"),
      false,
      `${trial} mixes dialects`,
    );
  }
  // The two the adapter ships, pinned by shape.
  assert.deepEqual(dialectAnswer("deny-action-exit2", "why"), {
    body: { action: "block", message: "why" },
    code: 2,
  });
  assert.deepEqual(dialectAnswer("allow-empty-object", "why"), { body: {}, code: 0 });
  assert.equal(dialectAnswer("not-a-trial", "why"), null);
  assert.match(String(mixedDenyPayload("why")["action"]), /block/u);
});

test("an armed trial behaves as armed, and is consumed by the one call", () => {
  try {
    const { state, project } = runSetup();
    const call = (): ReturnType<typeof runRecord> =>
      runRecord(state, envelope({ cwd: project, tool_input: { command: "ls", workdir: project } }));

    arm(["node", "hermes-hook.mjs", "arm", "crash", "--state", state], () => {});
    const crashed = call();
    assert.equal(crashed.code, 1, "a crash exits non-zero with no output");
    assert.equal(crashed.out, "");
    // And the arm is spent: the NEXT call is ordinary. Consuming it before
    // acting is what makes a crash or a hang leave nothing armed behind.
    assert.equal(call().code, 0);

    arm(["node", "hermes-hook.mjs", "arm", "hang", "--state", state], () => {});
    const hung = call();
    assert.equal(hung.slept, true, "the hang trial actually blocks");
    assert.equal(hung.out, "");

    arm(["node", "hermes-hook.mjs", "arm", "garbage", "--state", state], () => {});
    const garbled = call();
    assert.equal(garbled.code, 0);
    assert.throws(() => JSON.parse(garbled.out), "garbage is not JSON, which is the point");

    arm(["node", "hermes-hook.mjs", "arm", "deny-exit2", "--state", state], () => {});
    const bare = call();
    assert.equal(bare.code, 2);
    assert.equal(bare.out, "", "exit 2 with nothing on stdout is its own trial");
  } finally {
    cleanup();
  }
});

test("a post event is recorded, answered with nothing, and never consumes an arm", () => {
  try {
    const { state, project } = runSetup();
    arm(["node", "hermes-hook.mjs", "arm", "crash", "--state", state], () => {});
    const post = runRecord(
      state,
      envelope({
        hook_event_name: "post_tool_call",
        cwd: project,
        tool_input: { command: "ls", workdir: project },
      }),
    );
    assert.equal(post.code, 0, "a post event is answered with nothing, not with a crash");
    assert.equal(post.out, "");

    // The arm is still standing, so it lands on the PRE event it was aimed at.
    // An arm consumed by the report of a call rather than by the call is the
    // mistake the Muse probe had to be corrected for mid-run.
    const pre = runRecord(state, envelope({ cwd: project, tool_input: { command: "ls", workdir: project } }));
    assert.equal(pre.code, 1, "the crash arm survived the post event");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

test("token-shaped strings are stripped before anything is written", () => {
  assert.match(redact('{"api_key":"abcdefghijklmnop"}'), /<redacted>/u);
  assert.match(redact("Authorization: Bearer abcdefghijklmnop"), /Bearer <redacted>/u);
  assert.match(redact("sk-abcdefghijklmnopqrstuvwxyz"), /<redacted>/u);
  assert.match(redact(`eyJ${"a".repeat(30)}`), /<redacted-jwt>/u);
  // Ordinary content is untouched: the capture is verbatim in every other
  // respect, because the exact bytes are the point of the probe.
  assert.equal(redact('{"tool_name":"terminal"}'), '{"tool_name":"terminal"}');
  assert.equal(redact(42 as unknown as string), 42 as unknown as string);
});

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

test("report leads with the fail-closed finding, and says UNKNOWN before any trial runs", () => {
  try {
    const { state, project } = runSetup();
    runRecord(state, envelope({ cwd: project, tool_input: { command: "ls", workdir: project } }));
    const out = runReport(state);
    // The ordering is the deliverable: the first thing a reader of this report
    // sees is the answer to the question the probe exists for.
    assert.match(out.split("\n")[0] ?? "", /THE FAIL-CLOSED FINDING/u);
    assert.match(out, /UNKNOWN — no crash, hang or garbage trial ran/u);
    assert.match(out, /=== 3\. ENVELOPE SHAPE ===/u);
    assert.match(out, /pre_tool_call/u, "the event names seen are reported");
    assert.match(out, /terminal/u, "and the tool names");
    assert.match(out, /THE PER-CALL WORKING DIRECTORY/u, "and the field the adapter needs");
    assert.match(out, /readTools list is a GUESS/u, "and the list the probe is meant to correct");
  } finally {
    cleanup();
  }
});

test("report with no capture at all says so, and names the export that is usually missing", () => {
  try {
    const { state } = runSetup();
    const out = runReport(state);
    assert.match(out, /FAIL-CLOSED FINDING: UNKNOWN/u);
    assert.match(out, /no envelope ever reached the hook/u);
    // The most likely cause, named rather than left to guesswork: without the
    // export Hermes reads the operator's real config and the probe measures
    // nothing.
    assert.match(out, /export HERMES_HOME=/u);
  } finally {
    cleanup();
  }
});

test("report pairs each fail trial across both fail_closed settings", () => {
  try {
    const { state, project } = runSetup();
    const call = (): void => {
      runRecord(state, envelope({ cwd: project, tool_input: { command: "ls", workdir: project } }));
    };
    for (const mode of ["on", "off"]) {
      failClosedVerb(["node", "hermes-hook.mjs", "fail-closed", mode, "--state", state]);
      for (const trial of FAIL_TRIALS) {
        arm(["node", "hermes-hook.mjs", "arm", trial, "--state", state], () => {});
        call();
      }
    }
    const out = runReport(state);
    // No artifact was ever created (no Hermes ran), so every trial reads FAIL
    // CLOSED. What this pins is the PAIRING: both halves of each trial appear,
    // labelled, so a reader can see which setting was in force.
    for (const trial of FAIL_TRIALS) {
      assert.match(out, new RegExp(`${trial} \\(fail_closed TRUE\\)`, "u"));
      assert.match(out, new RegExp(`${trial} \\(fail_closed absent\\)`, "u"));
    }
    assert.match(out, /CONFIRMED|FAILS OPEN/u, "the headline commits to an answer");
  } finally {
    cleanup();
  }
});

test("an unparseable capture line does not stop the report", () => {
  try {
    const { state, project } = runSetup();
    // A hook whose stdin was not JSON is a real case, and the report must still
    // print: a probe that crashes on its own capture loses the whole round.
    runRecord(state, "{not json at all");
    runRecord(state, envelope({ cwd: project, tool_input: { command: "ls", workdir: project } }));
    const out = runReport(state);
    assert.match(out, /THE FAIL-CLOSED FINDING/u);
    assert.match(out, /Envelopes captured: 2/u);
  } finally {
    cleanup();
  }
});
