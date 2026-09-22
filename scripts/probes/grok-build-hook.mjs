#!/usr/bin/env node
/**
 * APRV-243 AC1: does an installed Grok Build actually fire the committed Claude
 * settings hook entries, what envelope does it send, and what does it do with
 * the Claude-shaped nested output on exit 0?
 *
 * ===========================================================================
 * ONE COMMAND (APRV-418). READ THIS FIRST, INCLUDING THE SECOND PARAGRAPH.
 * ===========================================================================
 *
 * This probe follows the driver convention in `docs/probe-driver-convention.md`.
 * `run` does the whole matrix in one process: it reads the version before it
 * writes anything, builds a scratch project, registers BOTH candidate hook
 * files in it, then drives every trial through Grok Build's one-shot mode and
 * prints the report. What that removes is TYPED PROMPTS: the manual runbook was
 * six prompts and six arms with a person sitting there.
 *
 * THE OPERATOR RUNS IT, AND UNLIKE THE HERMES DRIVER THE CLASSIFIER DOES NOT
 * ENFORCE THAT. `approval hook classify` answers `files.write.workspace` under
 * rule `node-script` for this command, because it names no protected path: this
 * harness has no home for the probe to write into. So the hook would ALLOW an
 * agent to run it, and an agent still must not, for a reason the class does not
 * carry: the `grok` invocations inside are child processes the hook never sees,
 * so a wrapper puts `harness.launch.grok` outside the gate entirely, which is
 * what APRV-354 closed for the bare command. Recorded as an open question for a
 * human rather than settled here.
 *
 * `arm`, `record` and `report` still work on their own, for a human who wants to
 * type prompts into an interactive session. Nothing about them changed except
 * that they now build the same scratch project the driver does.
 *
 * ===========================================================================
 * SAFETY. WHAT THIS SCRIPT TOUCHES AND WHAT IT NEVER TOUCHES.
 * ===========================================================================
 *
 *   - It NO LONGER asks anybody to edit this repository's own Claude settings
 *     file. That file is `policy.core`, the old runbook had a human edit it and
 *     remember to take the entry out again, and a probe entry left behind in a
 *     real checkout is a hook that answers nothing. The entries now go in a
 *     SCRATCH PROJECT this script generates, and the whole scratch root is
 *     deletable in one line.
 *   - The scratch project holds ONLY synthetic files this script writes, and
 *     deliberately no `AGENTS.md` and no `CLAUDE.md`: a coding harness reads
 *     those as instructions, so a real project's rules would enter the session.
 *     A test asserts their absence.
 *   - `record` (the hook entry) applies a PATH JAIL: a call naming a path that
 *     resolves outside the scratch project is refused. That is a BACKSTOP and
 *     not the control. This harness is DOCUMENTED TO FAIL OPEN on a hook that
 *     crashes, times out or prints something unparseable, and a hook fires after
 *     the prompt has already been sent, so the jail can stop the next call and
 *     cannot recall what the model already saw. The control is that the scratch
 *     project holds nothing real.
 *   - It opens no network connection, reads no credential, and writes nothing
 *     outside the scratch root it creates and one small pointer file.
 *
 * ===========================================================================
 *
 *   node scripts/probes/grok-build-hook.mjs run [--captures <dir>]
 *       THE DRIVER. Version, scratch project, both hook files, the matrix, the
 *       report. One command the OPERATOR runs, and no prompt typed.
 *
 *   node scripts/probes/grok-build-hook.mjs setup [--captures <dir>]
 *       Build the scratch project and print the prompts, for a hand-typed round.
 *
 *   node scripts/probes/grok-build-hook.mjs arm <trial>
 *       Make the next tool call answer one specific way.
 *
 *   node scripts/probes/grok-build-hook.mjs report
 *       Print the three answers AC1 asks for.
 *
 * `record` is the hook entry; the registered files point at it, not you.
 *
 * Nothing here decides anything for the gate. It records, and it refuses.
 */

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);

/** Where `setup` and `run` leave a breadcrumb so the other verbs find the round. */
export const POINTER = join(tmpdir(), "aprv243-grok-probe-pointer.json");

/**
 * The pointer file this invocation uses.
 *
 * Injectable through `APPROVAL_GROK_PROBE_POINTER`, for the reason the Hermes
 * probe's is (APRV-350): a suite that wrote the real pointer once repointed a
 * live operator's `arm` mid-round, and the trial they armed landed nowhere. The
 * variable widens nothing — it moves a scratch breadcrumb — and nothing this
 * file decides is a gate verdict.
 */
export function pointerPath(env = process.env) {
  const override = env["APPROVAL_GROK_PROBE_POINTER"];
  return typeof override === "string" && override.trim() !== "" ? override : POINTER;
}

/**
 * The trials, and what each one is asking.
 *
 * `hazard` is the whole reason this probe exists and it is deliberately first:
 * it answers in the CLAUDE nested shape at EXIT 0, which is exactly what a
 * committed `approval hook claude-code` entry would answer under a Grok session.
 * If the artifact lands, every command in such a session looks gated and none
 * is, and `approval hook grok` is required rather than optional.
 *
 * The rest are single-variable and each licenses or condemns one thing:
 *
 *   - `deny-grok-exit2`   the deny the shipped adapter emits. If this does not
 *                         block, the adapter is not a backstop either;
 *   - `deny-grok-exit0`   the same body WITHOUT the blocking exit code, which
 *                         says whether exit 2 is load-bearing or belt-and-braces;
 *   - `allow`             the control. If this does NOT land, the harness is
 *                         withholding everything and no other reading is valid;
 *   - `crash`, `garbage`  the documented fail-OPEN cases. This harness has no
 *                         `fail_closed` of any kind, which is the claim
 *                         `docs/grok-hook.md` opens with, and these two measure
 *                         it rather than repeating it.
 */
export const TRIALS = ["hazard", "deny-grok-exit2", "deny-grok-exit0", "allow", "crash", "garbage"];

/** The file the operator asks Grok to create in each trial. */
export function trialArtifact(trial) {
  return `${trial}-probe.txt`;
}

/**
 * The two candidate registration files, and why BOTH are installed at once.
 *
 * The question is which file a Grok session reads. Installing one at a time
 * would cost two rounds to answer it, and a round costs a human's attention.
 * Installing both is still single-variable because each entry names its own
 * `--config-id`, so the capture says which file fired — and if neither fired,
 * that is the same answer it would have been either way.
 *
 * `claude` is the compatibility read under test. `grok` is the CONTROL: if only
 * the native file fires, the compatibility hazard does not exist and the doc's
 * central warning narrows; if neither fires, the harness registered nothing and
 * the round is inconclusive rather than reassuring.
 */
export const REGISTRATIONS = ["claude", "grok"];

/** The Claude-shaped settings file, which is the compatibility read under test. */
export function claudeSettings(statePath) {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: `node ${SCRIPT} record --state ${statePath} --config-id claude`,
              timeout: 30,
            },
          ],
        },
      ],
    },
  };
}

/** The native Grok hook file, which is the control. */
export function grokHook(statePath) {
  return {
    hooks: [
      {
        event: "PreToolUse",
        command: `node ${SCRIPT} record --state ${statePath} --config-id grok`,
        timeout: 600,
      },
    ],
  };
}

/** Where each registration lands inside the scratch project. */
export const REGISTRATION_PATHS = {
  claude: join(".claude", "settings.json"),
  grok: join(".grok", "hooks", "pre-tool-use.json"),
};

/**
 * How the driver spells ONE non-interactive Grok Build run.
 *
 * `{prompt}` and `{dir}` are substituted; every other token is passed through.
 * UNVERIFIED: this repository has never run the binary, and the spelling follows
 * Grok Build's Claude Code lineage rather than an observed session. It is a
 * template so that a wrong guess is `--one-shot "<template>"` on the command
 * line rather than an edit here, and so the early abort can name the knob.
 */
export const ONE_SHOT_TEMPLATE = "-p {prompt} --cwd {dir}";

/** The argv for one one-shot run, or `null` when the template names no prompt. */
export function oneShotArgv(template, prompt, project) {
  const tokens = String(template).split(/\s+/u).filter((token) => token !== "");
  if (!tokens.includes("{prompt}")) return null;
  return tokens.map((token) =>
    token === "{prompt}" ? prompt : token === "{dir}" ? project : token,
  );
}

/**
 * The version floor for this harness: there is none, and that is a statement.
 *
 * The Hermes probe refuses below a floor because a measured build difference
 * exists there (`fail_closed` silently ignored below `main` `118984d7`). Nothing
 * in this repository has measured a build difference in Grok Build, so a floor
 * here would be invented. What the driver still does is RECORD the version
 * before any trial and refuse an unreadable one, because a round whose binary
 * nobody can name is a round nobody can reproduce.
 */
export const VERSION_FLOOR = null;

/** How long a `--version` probe may take before it is killed. */
const VERSION_TIMEOUT_MS = 10_000;

/** How long one step may take. */
export const STEP_TIMEOUT_MS = 180_000;

/** The prompts a driven step sends, in order, one per trial. */
export function matrix() {
  return TRIALS.map((trial) => ({
    id: trial,
    trial,
    prompt: `create a file named ${trialArtifact(trial)} containing x`,
    artifact: trialArtifact(trial),
  }));
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Strip token-shaped strings before anything is written to disk.
 *
 * The envelope is recorded verbatim in every other respect, because the exact
 * bytes are the point. But a capture is pasted into a task and a pull request,
 * and raw secrets never appear in a record this project writes (SPEC.md §11.1
 * invariant 3). Deliberately over-eager: a redacted field the report cannot name
 * is a cheaper mistake than a token in a PR body.
 */
export function redact(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/\b[Bb]earer\s+[A-Za-z0-9._~+/-]{8,}=*/gu, "Bearer <redacted>")
    .replace(
      /("(?:[A-Za-z_]*(?:token|secret|password|passwd|apikey|api_key|auth|cookie|credential|session_key)[A-Za-z_]*)"\s*:\s*")([^"]{4,})(")/giu,
      (_match, head, _value, tail) => `${head}<redacted>${tail}`,
    )
    .replace(/\b(?:sk-|sk-ant-|xai-|xoxb-|ghp_|gho_|github_pat_)[A-Za-z0-9._~+/-]{12,}=*/gu, "<redacted>")
    .replace(/\beyJ[A-Za-z0-9._~+/-]{20,}=*/gu, "<redacted-jwt>");
}

// ---------------------------------------------------------------------------
// The path jail
// ---------------------------------------------------------------------------

/** Keys that carry a path, in either spelling, across this harness's tools. */
const PATH_KEYS = ["path", "file_path", "filePath", "paths", "notebook_path", "cwd", "directory"];

/**
 * The first thing in this call that resolves outside `project`, or `null`.
 *
 * Deliberately shallow and deliberately loud, and not a security boundary: a
 * shell command can leave the project in ways no string inspection catches,
 * which is exactly why the scratch project holds nothing real. An unresolvable
 * value counts as OUTSIDE, because a value nothing can place is a value nothing
 * can say is inside.
 */
export function outsideProject(envelope, project) {
  if (envelope === null || typeof envelope !== "object") return "(unparseable envelope)";
  const input = envelope.tool_input ?? envelope.toolInput ?? {};
  if (typeof input !== "object" || input === null) return null;

  // BOTH spellings of the root, and the reason is macOS rather than pedantry:
  // the system temp root is a symlink there, so `mkdtemp` hands back
  // `/var/folders/…` while `realpath` of the same directory is
  // `/private/var/folders/…`. A jail comparing one of them calls every call in
  // its own scratch project an escape, which measures nothing.
  const roots = [project];
  try {
    const real = realpathSync(project);
    if (!roots.includes(real)) roots.push(real);
  } catch {
    return `(scratch project ${project} is unreadable)`;
  }
  const under = (candidate) =>
    roots.some((root) => candidate === root || candidate.startsWith(`${root}/`));
  const inside = (value) => {
    if (typeof value !== "string" || value.trim() === "") return true;
    if (value.startsWith("~") || value.includes("$")) return false;
    const absolute = isAbsolute(value) ? value : resolvePath(roots[0], value);
    if (under(absolute)) return true;
    try {
      return under(realpathSync(absolute));
    } catch {
      return false;
    }
  };

  for (const key of PATH_KEYS) {
    const value = input[key];
    if (Array.isArray(value)) {
      const bad = value.find((entry) => !inside(entry));
      if (bad !== undefined) return `${key}[] entry ${JSON.stringify(bad)}`;
      continue;
    }
    if (typeof value === "string" && !inside(value)) return `${key} ${JSON.stringify(value)}`;
  }
  const command = typeof input.command === "string" ? input.command : null;
  if (command !== null) {
    for (const word of command.split(/\s+/u)) {
      if (!word.startsWith("/") && !word.startsWith("~") && !word.startsWith("../")) continue;
      if (!inside(word)) return `a word of the command, ${JSON.stringify(word)}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The scratch project
// ---------------------------------------------------------------------------

/**
 * The synthetic files, and the complete list of what the scratch project holds.
 *
 * Every byte is written by this script. There is deliberately no `AGENTS.md` and
 * no `CLAUDE.md`: a coding harness reads those as instructions in a trusted
 * workspace, so a real project's rules would enter the session. A test asserts
 * their absence rather than trusting this comment.
 */
export const SYNTHETIC_FILES = {
  "README.md": [
    "# Probe Fixture (synthetic)",
    "",
    "This project is fake. Every file in it was generated by",
    "scripts/probes/grok-build-hook.mjs for the APRV-243 hook probe.",
    "",
    "There is no real source code here and nothing was copied from any",
    "repository. Delete the whole scratch root when the probe is done.",
    "",
  ].join("\n"),
  "src/widget.js": [
    "// SYNTHETIC DUMMY FILE - not real source, generated by the APRV-243 probe.",
    "",
    "export const DUMMY_CONSTANT = 'placeholder-value-0000';",
    "",
    "export function addDummyNumbers(first, second) {",
    "  return first + second; // placeholder arithmetic, no meaning",
    "}",
    "",
  ].join("\n"),
  "notes.txt": [
    "Synthetic scratch notes. Generated, not copied. Nothing real lives here.",
    "",
  ].join("\n"),
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** Resolve the scratch state directory: an explicit `--state`, else the pointer. */
export function resolveState(argv) {
  const index = argv.indexOf("--state");
  if (index !== -1 && typeof argv[index + 1] === "string") return argv[index + 1];
  const pointer = readJson(pointerPath(), null);
  if (pointer && typeof pointer.state === "string") return pointer.state;
  return null;
}

function flagValue(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  return typeof value === "string" && !value.startsWith("--") ? value : null;
}

/** The positional after a verb, so `arm crash` reads. */
function positionalAfter(argv, verb) {
  const index = argv.indexOf(verb);
  if (index === -1) return null;
  const value = argv[index + 1];
  return typeof value === "string" && !value.startsWith("--") ? value : null;
}

/**
 * Build the scratch project, register both hook files, leave the breadcrumb.
 *
 * Everything `setup` and `run` both do, in one place, so the hand-typed path and
 * the driven path cannot drift into measuring different things.
 */
export function prepare(argv) {
  const root = mkdtempSync(join(tmpdir(), "aprv243-grok-probe-"));
  const project = join(root, "scratch-project");
  const declaredCaptures = flagValue(argv, "--captures");
  const state = declaredCaptures === null ? join(root, "state") : resolvePath(declaredCaptures);
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });

  for (const [relative, body] of Object.entries(SYNTHETIC_FILES)) {
    const target = join(project, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body, "utf8");
  }
  writeJson(join(project, REGISTRATION_PATHS.claude), claudeSettings(state));
  writeJson(join(project, REGISTRATION_PATHS.grok), grokHook(state));

  writeJson(join(state, "setup.json"), {
    createdAt: new Date().toISOString(),
    root,
    project,
    syntheticFiles: Object.keys(SYNTHETIC_FILES),
    registrations: REGISTRATIONS,
  });
  writeJson(join(state, "control.json"), { armed: "none" });
  writeJson(pointerPath(), { state, project, root, createdAt: new Date().toISOString() });

  return { root, project, state };
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

export function setup(argv, write = process.stdout.write.bind(process.stdout)) {
  const { root, project, state } = prepare(argv);
  write(
    [
      "===========================================================================",
      "NEVER RUN THIS PROBE INSIDE A REAL REPOSITORY. The scratch project below",
      "holds only synthetic files this script just wrote, and it is the control.",
      "This harness is DOCUMENTED TO FAIL OPEN on a hook that crashes, times out",
      "or prints garbage, so the hook's own path jail is a backstop and not the",
      "control.",
      "===========================================================================",
      "",
      "WHAT THIS PROBE IS FOR: Grok Build states that it reads the Claude settings",
      "file for compatibility. If that read fires a committed `approval hook",
      "claude-code` entry under a Grok session, the entry denies in the NESTED",
      "Claude shape and exits 0 — and exit 0 is an ALLOW here. Every command would",
      "look gated and none would be. Three answers settle it: which registration",
      "fired, what the envelope carries, and whether the call ran anyway.",
      "",
      "---------------------------------------------------------------------------",
      `SCRATCH ROOT:    ${root}`,
      `SCRATCH PROJECT: ${project}`,
      `CAPTURES:        ${state}`,
      "---------------------------------------------------------------------------",
      "",
      `Registered in the scratch project: ${Object.values(REGISTRATION_PATHS).join(" and ")}.`,
      "Each entry names its own --config-id, so the capture says which one fired.",
      "Nothing in this repository was touched; the old runbook asked for an edit to",
      "the real settings file, which is policy.core, and no longer does.",
      "",
      `Synthetic files: ${Object.keys(SYNTHETIC_FILES).join(", ")}`,
      "Deliberately ABSENT: AGENTS.md, CLAUDE.md. A coding harness reads those as",
      "instructions, so a real project's rules would enter the session.",
      "",
      "---------------------------------------------------------------------------",
      "THE HAND-TYPED ROUND. Start Grok in the scratch project only:",
      "---------------------------------------------------------------------------",
      "",
      `  cd ${project}`,
      "  grok",
      "",
      "Then, one trial at a time:",
      "",
      ...matrix().flatMap((step) => [
        `  node ${SCRIPT} arm ${step.trial}`,
        `    then in grok: ${step.prompt}`,
      ]),
      "",
      `  node ${SCRIPT} report`,
      "",
      "OR SKIP ALL OF THAT: `node scripts/probes/grok-build-hook.mjs run` drives",
      "every trial above through Grok's one-shot mode in ONE operator command.",
      "",
      `Delete ${root} when you are done.`,
      "",
    ].join("\n"),
  );
  return 0;
}

// ---------------------------------------------------------------------------
// arm
// ---------------------------------------------------------------------------

export function arm(argv, write = process.stdout.write.bind(process.stdout)) {
  const trial = positionalAfter(argv, "arm");
  if (trial === null || ![...TRIALS, "none"].includes(trial)) {
    process.stderr.write(`arm takes one of: ${[...TRIALS, "none"].join(", ")}\n`);
    return 2;
  }
  const state = resolveState(argv);
  if (state === null) {
    process.stderr.write("no scratch state found; run `setup` or `run` first\n");
    return 2;
  }
  writeJson(join(state, "control.json"), {
    armed: trial,
    step: flagValue(argv, "--step"),
    armedAt: new Date().toISOString(),
  });
  write(
    trial === "none"
      ? "Disarmed. The next tool call gets the ordinary path jail and nothing else.\n"
      : [
          `Armed: the next tool call will run trial \`${trial}\`.`,
          `In grok, ask for: create a file named ${trialArtifact(trial)} containing x`,
          "",
        ].join("\n"),
  );
  return 0;
}

// ---------------------------------------------------------------------------
// record (the hook entry)
// ---------------------------------------------------------------------------

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch (cause) {
    return `<<stdin unreadable: ${String(cause)}>>`;
  }
}

/**
 * The body and exit code one trial answers with.
 *
 * `hazard` is the combination the whole probe is about: the nested Claude
 * envelope, which this harness does not read, at exit 0, which it reads as an
 * allow. It is what a committed `approval hook claude-code` entry answers.
 */
export function trialAnswer(trial, reason) {
  switch (trial) {
    case "hazard":
      return {
        body: {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason,
          },
        },
        code: 0,
      };
    // The deny the shipped adapter emits.
    case "deny-grok-exit2":
      return { body: { decision: "deny", reason }, code: 2 };
    // The same body without the blocking exit code.
    case "deny-grok-exit0":
      return { body: { decision: "deny", reason }, code: 0 };
    case "allow":
      return { body: null, code: 0 };
    case "crash":
      return { body: null, code: 1 };
    case "garbage":
      return { body: "aprv243-probe: armed trial `garbage` <<<not json at all>>> {", code: 0 };
    default:
      return null;
  }
}

export function record(argv, io = {}) {
  const write = io.write ?? process.stdout.write.bind(process.stdout);
  const warn = io.warn ?? process.stderr.write.bind(process.stderr);
  const readInput = io.readInput ?? readStdin;

  const state = resolveState(argv);
  const configId = flagValue(argv, "--config-id") ?? "(none)";
  const raw = readInput();
  const redacted = redact(raw);

  let envelope = null;
  try {
    envelope = JSON.parse(raw);
  } catch {
    envelope = null;
  }

  const setupState = state === null ? {} : readJson(join(state, "setup.json"), {});
  const project = typeof setupState.project === "string" ? setupState.project : null;
  const jailed = project === null ? null : outsideProject(envelope, project);

  const eventName =
    envelope === null ? null : (envelope.hook_event_name ?? envelope.hookEventName ?? null);
  const toolName = envelope === null ? null : (envelope.tool_name ?? envelope.toolName ?? null);
  const isPost = typeof eventName === "string" && /post/iu.test(eventName);

  const control =
    state === null ? { armed: "none" } : readJson(join(state, "control.json"), { armed: "none" });
  const armed = isPost ? "none" : typeof control.armed === "string" ? control.armed : "none";
  const step = typeof control.step === "string" ? control.step : null;

  // ONE ARM PER STEP, not per call, and only in a DRIVEN round. Both candidate
  // registrations are installed at once, so one tool call fires the hook TWICE
  // and a per-call arm would leave the second entry answering something else:
  // the trial would be two variables. A hand-typed round has no step label and
  // keeps the per-call arm it always had, because there the operator is the one
  // deciding when a trial is over.
  if (state !== null && armed !== "none" && step === null) {
    writeJson(join(state, "control.json"), {
      armed: "none",
      step,
      consumedAt: new Date().toISOString(),
    });
  }

  if (state !== null) {
    try {
      appendFileSync(
        join(state, "envelopes.jsonl"),
        `${JSON.stringify({
          at: new Date().toISOString(),
          configId,
          bytes: raw.length,
          parsed: envelope !== null,
          event: eventName,
          tool: toolName,
          jailed,
          armed,
          step,
          argv: argv.slice(2).map(redact),
          raw: redacted,
        })}\n`,
        "utf8",
      );
    } catch {
      // A capture that cannot be written must not turn into an allow.
    }
  }

  // A post event is recorded and answered with nothing. On this harness a
  // non-zero exit is a VERDICT, and a verdict about a call that has already run
  // is meaningless at best, so the post path always exits 0.
  if (isPost) return 0;

  const answer = trialAnswer(armed, `aprv243-probe: armed trial \`${armed}\``);
  if (answer !== null) {
    if (typeof answer.body === "string") write(`${answer.body}\n`);
    else if (answer.body !== null) write(`${JSON.stringify(answer.body)}\n`);
    return answer.code;
  }

  // Unarmed: the ordinary path jail, in the dialect the shipped adapter uses.
  if (jailed !== null) {
    const reason = `aprv243-probe path jail: ${jailed} is outside the scratch project ${
      project ?? "(unknown)"
    }`;
    warn(
      [
        "",
        "!!! APRV-243 PROBE: PATH JAIL REFUSED THIS TOOL CALL !!!",
        `    ${reason}`,
        "    A hook fires AFTER the prompt was sent. This stops the tool call; it",
        "    does not recall what the model already saw. This harness is documented",
        "    to fail OPEN, so the call may happen anyway.",
        "",
      ].join("\n"),
    );
    write(`${JSON.stringify({ decision: "deny", reason })}\n`);
    return 2;
  }
  warn(`aprv243-probe: allow — ${String(toolName)} stays inside the scratch project\n`);
  write(`${JSON.stringify({ decision: "allow", reason: "inside the scratch project" })}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// run — the driver (APRV-418)
// ---------------------------------------------------------------------------

/** Spawn one child and report every failure as a value. */
function spawnOnce(binary, args, options) {
  try {
    const result = spawnSync(binary, args, {
      encoding: "utf8",
      timeout: options.timeout,
      killSignal: "SIGKILL",
      maxBuffer: 4 * 1024 * 1024,
      env: options.env,
      cwd: options.cwd,
    });
    return {
      status: result.status ?? null,
      signal: result.signal ?? null,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
      error:
        result.error === undefined || result.error === null
          ? null
          : String(result.error.message ?? result.error),
    };
  } catch (cause) {
    return { status: null, signal: null, stdout: "", stderr: "", error: String(cause) };
  }
}

/** The last few hundred characters of a stream, redacted, for the run log. */
function tail(text, limit = 600) {
  const value = redact(typeof text === "string" ? text : "");
  return value.length <= limit ? value : `…${value.slice(value.length - limit)}`;
}

/** The raw first line of a `--version`, trimmed of control characters and capped. */
export function versionLine(raw) {
  if (typeof raw !== "string") return null;
  const first = raw.split("\n", 1)[0] ?? "";
  const text = first.replace(/\p{Cc}/gu, "").trim();
  if (text.length === 0 || text.length > 200) return null;
  return text;
}

/** How many envelopes have reached the hook so far. */
function capturedCount(state) {
  try {
    return readFileSync(join(state, "envelopes.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "").length;
  } catch {
    return 0;
  }
}

/**
 * Drive the whole matrix through Grok Build's one-shot mode. ONE command.
 *
 * Same order as the Hermes driver, and the order is the safety property: the
 * version before anything is written, then the scratch project and both
 * registrations, then one one-shot invocation per trial, then the report read
 * back out of the capture rather than out of this loop's memory.
 *
 * There is no floor to refuse below on this harness ({@link VERSION_FLOOR}), so
 * an unreadable version is the only version refusal here, and it is still a
 * refusal: a round whose binary nobody can name is a round nobody can reproduce.
 */
export function run(argv, io = {}) {
  const write = io.write ?? process.stdout.write.bind(process.stdout);
  const warn = io.warn ?? process.stderr.write.bind(process.stderr);
  const spawn = io.spawn ?? spawnOnce;
  const now = io.now ?? Date.now;

  const binary = flagValue(argv, "--binary") ?? "grok";
  const template = flagValue(argv, "--one-shot") ?? ONE_SHOT_TEMPLATE;
  if (oneShotArgv(template, "p", "d") === null) {
    warn(`--one-shot must contain {prompt}; got ${JSON.stringify(template)}\n`);
    return 2;
  }
  const stepTimeout = Number(flagValue(argv, "--step-timeout") ?? STEP_TIMEOUT_MS);

  // ---- 1. the version, before a single byte is written anywhere -----------
  const probed = spawn(binary, ["--version"], { timeout: VERSION_TIMEOUT_MS, env: process.env });
  const line = probed.error === null ? versionLine(probed.stdout) : null;
  if (line === null && !argv.includes("--allow-unknown-version")) {
    warn(
      [
        "",
        "REFUSED: THE VERSION COULD NOT BE READ, AND NOTHING WAS WRITTEN.",
        probed.error === null
          ? `  ${binary} --version printed: ${JSON.stringify(tail(probed.stdout, 200))}`
          : `  ${binary} --version could not be run: ${probed.error}`,
        "",
        "  There is no fail-closed version floor for this harness, so this is not a",
        "  floor refusal: it is that a round whose binary nobody can name is a round",
        "  nobody can reproduce, and this one costs an operator's round. If the",
        "  binary is right and only its banner is unreadable, say so explicitly:",
        "",
        "    --allow-unknown-version",
        "",
      ].join("\n"),
    );
    return 3;
  }

  // ---- 2. the scratch project and both registrations ----------------------
  const { root, project, state } = prepare(argv);
  writeJson(join(state, "version.json"), {
    binary,
    raw: line,
    floor: VERSION_FLOOR,
    readAt: new Date().toISOString(),
  });

  const steps = matrix();
  write(
    [
      "===========================================================================",
      "APRV-243 DRIVEN PROBE ROUND (APRV-418 driver). One operator command.",
      "===========================================================================",
      `  binary:     ${binary}`,
      `  version:    ${String(line)}`,
      `  one-shot:   ${template}   (UNVERIFIED spelling; --one-shot overrides)`,
      `  project:    ${project}`,
      `  captures:   ${state}`,
      `  steps:      ${String(steps.length)}`,
      "",
      `  Registered: ${Object.values(REGISTRATION_PATHS).join(" and ")}, each with its`,
      "  own --config-id, so the capture says which file this harness reads.",
      "",
    ].join("\n"),
  );

  // ---- 3. the matrix ------------------------------------------------------
  let aborted = null;
  const runsLog = join(state, "runs.jsonl");

  for (const [index, step] of steps.entries()) {
    writeJson(join(state, "control.json"), {
      armed: step.trial,
      step: step.id,
      armedAt: new Date().toISOString(),
    });

    const before = capturedCount(state);
    const started = now();
    const result = spawn(binary, oneShotArgv(template, step.prompt, project), {
      timeout: stepTimeout,
      cwd: project,
      env: process.env,
    });
    const elapsed = now() - started;
    const captured = capturedCount(state) - before;
    const landed = existsSync(join(project, step.artifact));

    const row = {
      at: new Date().toISOString(),
      index: index + 1,
      id: step.id,
      trial: step.trial,
      prompt: step.prompt,
      artifact: step.artifact,
      landed,
      captured,
      ms: elapsed,
      status: result.status,
      signal: result.signal,
      error: result.error,
      stdout: tail(result.stdout),
      stderr: tail(result.stderr),
    };
    appendFileSync(runsLog, `${JSON.stringify(row)}\n`, "utf8");
    write(
      `  [${String(index + 1)}/${String(steps.length)}] ${step.id}: exit ${String(result.status)}${
        result.signal === null ? "" : ` (${result.signal})`
      }, ${String(captured)} envelope(s), ${String(Math.round(elapsed / 1000))}s, artifact ${
        landed ? "PRESENT" : "absent"
      }\n`,
    );

    if (index === 0 && capturedCount(state) === 0) {
      aborted =
        "the FIRST invocation produced no captured envelope, so nothing after it could mean anything";
      break;
    }
  }

  if (aborted !== null) {
    warn(
      [
        "",
        "ROUND ABORTED, and the report below covers only what ran.",
        `  ${aborted}.`,
        "",
        "  Three causes, in the order they are worth checking:",
        `  1. the one-shot spelling. This round used \`${binary} ${template}\`, which`,
        "     this repository has never verified. Check the harness's own help and",
        '     re-run with --one-shot "<template>", where {prompt} and {dir} are',
        "     substituted and every other token is passed through;",
        "  2. neither registration is read from a PROJECT directory. Both files were",
        `     written under ${project}; a harness that reads only a USER-level`,
        "     settings file would find nothing there, which is itself worth writing",
        "     down in the task;",
        "  3. the harness needs a model configured, and a session with no provider",
        "     makes no tool calls at all. Check its own setup command first.",
        "",
      ].join("\n"),
    );
  }

  writeJson(join(state, "run.json"), {
    startedAt: new Date().toISOString(),
    binary,
    template,
    version: line,
    steps: steps.length,
    aborted,
  });

  write("\n");
  report(["node", SCRIPT, "report", "--state", state], write);
  write(`\nDelete ${root} when this report is pasted.\n`);
  return aborted === null ? 0 : 4;
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

function keysOf(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  return Object.keys(value).sort();
}

export function report(argv, write = process.stdout.write.bind(process.stdout)) {
  const state = resolveState(argv);
  if (state === null) {
    write("no scratch state found; run `setup` or `run` first\n");
    return 2;
  }
  const setupState = readJson(join(state, "setup.json"), {});
  const project = typeof setupState.project === "string" ? setupState.project : null;
  const capture = join(state, "envelopes.jsonl");

  if (!existsSync(capture)) {
    write(
      [
        "ANSWER 1 (which registration does a Grok session read?): NEITHER, or the",
        "  round never ran. No envelope reached either hook entry.",
        "",
        `Capture file: ${capture}`,
        project === null ? "" : `Scratch project: ${project}`,
        "",
        "A confirmed NO closes AC1 as well as a yes would: it means the",
        "compatibility hazard in docs/grok-hook.md does not fire from a project",
        "directory, and `approval hook grok` is the only way in. Before recording",
        "that, rule out the boring causes: the one-shot spelling, a harness that",
        "reads only a user-level settings file, and a session with no model.",
        "",
      ].join("\n"),
    );
    return 0;
  }

  const rows = [];
  for (const line of readFileSync(capture, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const outer = JSON.parse(line);
      let inner = null;
      try {
        inner = JSON.parse(outer.raw);
      } catch {
        inner = null;
      }
      rows.push({ ...outer, inner });
    } catch {
      rows.push({ at: "(unparseable capture line)", raw: line, inner: null });
    }
  }

  const runRows = [];
  try {
    for (const line of readFileSync(join(state, "runs.jsonl"), "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        runRows.push(JSON.parse(line));
      } catch {
        // One unreadable row must not cost the section.
      }
    }
  } catch {
    // No run log: a hand-typed round.
  }
  const versionState = readJson(join(state, "version.json"), null);
  const runState = readJson(join(state, "run.json"), null);

  const artifactPresent = (name) => project !== null && existsSync(join(project, name));

  /**
   * A LATER call that named this artifact, or `null`.
   *
   * The file-existence heuristic has one hole and the Hermes round fell into it
   * twice: after a refusal the model retries the same effect through another tool
   * or path, and a retry can create the very file whose absence was the
   * measurement. A driven round labels each step, so this says whether the later
   * call was a retry INSIDE the armed session or a different step's file
   * entirely (APRV-418).
   */
  const laterCallNaming = (name, armedIndex) => {
    const armedStep = typeof rows[armedIndex]?.step === "string" ? rows[armedIndex].step : null;
    for (let index = armedIndex + 1; index < rows.length; index += 1) {
      const row = rows[index];
      if (typeof row.raw !== "string" || !row.raw.includes(name)) continue;
      const step = typeof row.step === "string" ? row.step : null;
      const where =
        armedStep === null || step === null
          ? ""
          : step === armedStep
            ? ` in the SAME one-shot session (step ${step}), so it is a model retry`
            : ` in a LATER step (${step}), a different process, so it is that step's file rather than this trial's`;
      return `${String(row.tool)} at ${String(row.at)}${where}`;
    }
    return null;
  };

  /**
   * One trial's reading. `blockIsPass` is what the trial is asking.
   *
   * For `hazard`, `crash` and `garbage` a PRESENT artifact is the finding rather
   * than a failure: it is the fail-open behaviour this harness is documented to
   * have, measured instead of repeated.
   */
  const trialLine = (trial, blockIsPass) => {
    const name = trialArtifact(trial);
    const label = `  ${trial}`;
    if (project === null) return `${label}: (no scratch project recorded)`;
    const armedIndex = rows.findIndex((row) => row.armed === trial);
    if (armedIndex === -1) return `${label}: NOT RUN (no captured call was armed this way)`;
    const present = artifactPresent(name);
    const retry = present ? laterCallNaming(name, armedIndex) : null;
    const caveat =
      retry === null
        ? ""
        : `; CAUTION: a later call (${retry}) also named ${name}, so read that envelope before concluding`;
    if (blockIsPass) {
      return present
        ? `${label}: FAILED OPEN — ${name} exists, so the effect happened anyway${caveat}`
        : `${label}: BLOCKED — ${name} absent, so Grok withheld the effect`;
    }
    return present
      ? `${label}: RAN — ${name} exists, as this trial expects${caveat}`
      : `${label}: WITHHELD — ${name} absent, which this trial did NOT expect; read the envelopes`;
  };

  const allKeys = new Set();
  for (const row of rows) for (const key of keysOf(row.inner)) allKeys.add(key);
  const camel = [...allKeys].filter((key) => /[a-z][A-Z]/u.test(key));
  const snake = [...allKeys].filter((key) => key.includes("_"));
  const configIds = [...new Set(rows.map((row) => row.configId).filter(Boolean))];
  const tools = [...new Set(rows.map((row) => row.tool).filter(Boolean))];
  const events = [...new Set(rows.map((row) => row.event).filter(Boolean))];

  const hazardPresent = artifactPresent(trialArtifact("hazard"));
  const hazardRan = rows.some((row) => row.armed === "hazard");

  /** Answer 1, which is a reading of the `--config-id`s that fired. */
  const whichRegistration = () => {
    const out = [
      "=== ANSWER 1. WHICH REGISTRATION DOES A GROK SESSION READ? ===",
      configIds.length === 0
        ? "  NEITHER — envelopes were captured but none named a --config-id."
        : `  Fired: ${configIds.join(", ")}.`,
    ];
    out.push(
      ...(configIds.includes("claude")
        ? [
            "  THE COMPATIBILITY READ IS REAL: the Claude settings file fired under a",
            "  session of this harness, which is the premise of the hazard below.",
          ]
        : [
            "  The Claude settings file did NOT fire from a project directory, so the",
            "  compatibility hazard does not fire that way. Record that, and record",
            "  with it that a USER-level settings file was not tested by this round.",
          ]),
    );
    out.push(
      ...(configIds.includes("grok")
        ? [
            "  The native hook file fired too (the control), so this harness does read",
            "  a project-local registration at all.",
          ]
        : [
            "  The native hook file did NOT fire either, which is the control failing:",
            "  a round in which nothing fires says nothing about the compatibility read.",
          ]),
    );
    return out;
  };

  const lines = [
    ...whichRegistration(),
    "",
    "=== ANSWER 2. WHAT DOES THE ENVELOPE CARRY? ===",
    `  top-level keys: ${[...allKeys].join(", ") || "(the payload was not a JSON object)"}`,
    `  camelCase keys: ${camel.join(", ") || "(none)"}`,
    `  snake_case keys: ${snake.join(", ") || "(none)"}`,
    `  event names: ${events.join(", ") || "(none)"}`,
    `  tool names: ${tools.join(", ") || "(none)"}`,
    "  The adapter's tool lists (Bash, Edit, Write, MultiEdit, NotebookEdit, Read,",
    "  Glob, Grep) follow this harness's Claude Code lineage rather than an",
    "  observed session. A tool name here that is NOT on those lists is an",
    "  ungated call, which is the direction that matters: correct",
    "  docs/grok-hook.md from this line.",
    "",
    "  First envelope verbatim:",
    ...rows.slice(0, 1).map((row) => `    ${row.raw}`),
    "",
    "=== ANSWER 3. WHAT DOES IT DO WITH A CLAUDE NESTED DENY AT EXIT 0? ===",
    !hazardRan
      ? "  NOT RUN — no captured call was armed `hazard`."
      : hazardPresent
        ? [
            "  THE HAZARD IS CONFIRMED. The hook answered deny in the NESTED CLAUDE",
            "  shape and exited 0, and the effect happened anyway. A committed",
            "  `approval hook claude-code` entry under a session of this harness makes",
            "  every command look gated while none of them is, so `approval hook grok`",
            "  is required rather than optional.",
          ].join("\n")
        : [
            "  THE HAZARD IS NARROWER THAN FEARED. The nested Claude shape at exit 0",
            "  BLOCKED the call, so this harness understands that output. Correct the",
            "  opening of docs/grok-hook.md, which says it does not.",
          ].join("\n"),
    "",
    "=== THE TRIALS ===",
    trialLine("hazard", false),
    trialLine("deny-grok-exit2", true),
    trialLine("deny-grok-exit0", true),
    trialLine("allow", false),
    trialLine("crash", true),
    trialLine("garbage", true),
    "  `allow` is the control: if it is WITHHELD, this harness is blocking",
    "  everything and no line above is a measurement.",
    "  `deny-grok-exit2` is the deny the shipped adapter emits. `deny-grok-exit0`",
    "  says whether the exit code is load-bearing or belt-and-braces.",
    "  `crash` and `garbage` measure the fail-OPEN this harness is documented to",
    "  have and offers no setting to change.",
    "",
    "=== HOW THIS ROUND WAS RUN ===",
    ...(runRows.length === 0
      ? [
          "  BY HAND. No driver log is present, so every prompt was typed into an",
          "  interactive session, one arm at a time.",
          "  `node scripts/probes/grok-build-hook.mjs run` does the same matrix in",
          "  ONE operator command (docs/probe-driver-convention.md).",
        ]
      : [
          versionState === null
            ? "  version: (not recorded)"
            : `  version read BEFORE anything was written: ${String(versionState.raw)}`,
          "  no fail-closed version floor is known for this harness, so nothing was",
          "  refused on a build comparison; an unreadable version still refuses.",
          ...(runState === null || typeof runState.template !== "string"
            ? []
            : [`  one-shot invocation: ${String(runState.binary)} ${runState.template}`]),
          ...(runState !== null && typeof runState.aborted === "string"
            ? [`  ABORTED: ${runState.aborted}.`]
            : []),
          `  ${String(runRows.length)} step(s):`,
          ...runRows.map(
            (row) =>
              `    ${String(row.index)}. ${String(row.id)} exit ${String(row.status)}, ${String(
                row.captured,
              )} envelope(s), artifact ${row.landed === true ? "PRESENT" : "absent"}`,
          ),
        ]),
    "",
    "Then: move the register entry in docs/integrations-considered.md from parked",
    "to adopted or declined, correct the tool lists in docs/grok-hook.md from",
    "answer 2, and paste this whole report into APRV-243.",
    "",
    "Reminder: the scratch project held only synthetic files this script wrote,",
    "and nothing in this repository was registered or edited.",
    "",
  ];

  write(lines.join("\n"));
  return 0;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `usage: node scripts/probes/grok-build-hook.mjs run
                                                setup
                                                arm <trial>
                                                report

  run      THE DRIVER: version, scratch project, both registrations, the whole
           matrix through grok's one-shot mode, then the report. ONE command,
           run by the operator; this one classifies files.write.workspace rather
           than policy.core, so the hook does not enforce that (see the header).
           Flags:
             --captures <dir>        put the capture somewhere durable
             --binary <name>         default grok
             --one-shot "<template>" default ${JSON.stringify(ONE_SHOT_TEMPLATE)}
             --step-timeout <ms>     default ${String(STEP_TIMEOUT_MS)}
             --allow-unknown-version proceed on an unreadable version line
           exits 0 ok, 2 usage, 3 unreadable version (nothing written), 4
           aborted mid-round
  setup    build the scratch project and print the prompts, for a hand round
  arm      make the next tool call ${TRIALS.join(", ")}, or none
  report   print the three answers APRV-243 AC1 asks for
  record   the hook entry itself; the registered files point at it, not you
`;

export function main(argv) {
  // `run` is matched first because it does everything the others do; a driven
  // invocation that fell through to `setup` would build a scratch project and
  // then wait for prompts nobody is going to type.
  if (argv.includes("run")) return run(argv);
  if (argv.includes("setup")) return setup(argv);
  if (argv.includes("arm")) return arm(argv);
  if (argv.includes("record")) return record(argv);
  if (argv.includes("report")) return report(argv);
  process.stderr.write(USAGE);
  return 2;
}

if (process.argv[1] === SCRIPT) {
  process.exitCode = main(process.argv);
}
