#!/usr/bin/env node
/**
 * APRV-398 AC1: what does an installed Hermes Agent actually send a
 * `pre_tool_call` hook, which verdict form does it honour, and — the question
 * this whole probe exists for — does `fail_closed: true` really make a broken
 * hook BLOCK?
 *
 * ===========================================================================
 * THE FAIL-CLOSED QUESTION IS THE POINT. READ THIS FIRST.
 * ===========================================================================
 *
 * Every harness this project has adapted since Claude Code fails OPEN: Grok
 * Build and Muse Code both run the tool call when the hook crashes, hangs past
 * its timeout, or prints something the harness cannot parse, and neither offers
 * a setting to change that. Their adapters are therefore backstops rather than
 * gates, and `docs/grok-hook.md` and `docs/muse-hook.md` both open by saying so.
 *
 * Hermes DOCUMENTS a per-entry `fail_closed: true` that makes all three of those
 * cases block. If that holds, this is the first harness since Claude Code whose
 * hook is a real gate in the SPEC.md §11.1 sense. Documentation is not
 * evidence, which is what the trials below are for: each of `crash`, `hang` and
 * `garbage` is run TWICE, once with `fail_closed: true` and once without, and
 * the report pairs them.
 *
 * ===========================================================================
 * SAFETY. WHAT THIS SCRIPT TOUCHES AND WHAT IT NEVER TOUCHES.
 * ===========================================================================
 *
 *   - The scratch project holds ONLY synthetic files this script generates.
 *     Nothing is copied from this repository, from ~/dev, or from any real
 *     project. Never run this probe inside a real repository.
 *   - The scratch project deliberately contains NO `AGENTS.md` and NO
 *     `CLAUDE.md`. A coding harness reads those as instructions, and a test
 *     asserts their absence.
 *   - `HERMES_HOME` is REDIRECTED to a scratch directory this script creates,
 *     so the operator's own `~/.hermes` is never read and never written. The
 *     scratch home holds a `config.yaml` and nothing else: no credential, no
 *     token, no allowlist copied from anywhere.
 *   - This script invokes no model, opens no network connection, reads no
 *     credential, and writes nothing outside the scratch root it creates and
 *     one small pointer file.
 *   - `--record` (the hook entry) applies a PATH JAIL: a tool call naming a path
 *     that resolves outside the scratch project is refused, and so is
 *     `execute_code`, which carries a program and no path at all. That is a
 *     BACKSTOP and not the control, for two reasons. A hook fires after the
 *     prompt has already been sent, so it can stop the next read and cannot
 *     recall what the model already saw. And whether a refusal is honoured at
 *     all is the thing under test: if Hermes turns out to fail open, the jail
 *     refuses and the read happens anyway. The control is that the scratch
 *     project holds nothing real.
 *
 * ===========================================================================
 *
 *   node scripts/probes/hermes-hook.mjs setup [--home <dir>] [--captures <dir>]
 *       Builds the scratch project, installs the hook block into a HERMES_HOME,
 *       and prints the warning, the paths, the export line and the prompts.
 *
 *       With no `--home` it creates a scratch HERMES_HOME of its own, which is
 *       what the test suite drives. With `--home <dir>` it installs into an
 *       EXISTING one — a real install's — and then it is careful: the block goes
 *       in between named markers, the original `config.yaml` is backed up once,
 *       and if that file already carries a top-level `hooks:`, `plugins:` or
 *       `hooks_auto_accept:` the probe REFUSES to touch it and prints the block
 *       for the operator to merge, because YAML has no duplicate top-level keys
 *       and a probe that corrupted a working configuration would have cost more
 *       than the round it was measuring.
 *
 *       `--captures <dir>` puts the state and the envelope capture somewhere
 *       durable instead of under the scratch root, so the findings outlive the
 *       temp directory.
 *
 *   node scripts/probes/hermes-hook.mjs fail-closed on|off
 *       Rewrites the scratch config with or without `fail_closed: true` on
 *       every entry, so the same trial can be run both ways.
 *
 *   node scripts/probes/hermes-hook.mjs arm <trial>
 *       Arms the NEXT tool call to behave one specific way, through a control
 *       file, so the operator never edits the config mid-run.
 *
 *   node scripts/probes/hermes-hook.mjs report
 *       Prints the findings. The FIRST section is the fail-closed answer.
 *
 * `record` is the hook entry; the config points at it. It is not run by hand.
 *
 * Nothing here decides anything for the gate. It records, and it refuses.
 */

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

/** Where `setup` leaves a breadcrumb so the other verbs find the scratch root. */
export const POINTER = join(tmpdir(), "aprv398-hermes-probe-pointer.json");

/**
 * The pointer file this invocation uses.
 *
 * Injectable through `APPROVAL_HERMES_PROBE_POINTER`, and the reason is a real
 * incident rather than tidiness (APRV-350): the first version of the Muse
 * probe's suite called `setup` directly, which wrote the REAL pointer under the
 * system temp root, and a test run during a live session repointed the
 * operator's `arm` at a test directory mid-run, so the trial they armed landed
 * nowhere and the round proved nothing.
 *
 * A probe that can be redirected by an environment variable is fine HERE and
 * would not be fine in the runtime: nothing this file decides is a gate verdict,
 * the operator owns the terminal it runs in, and the alternative is a suite that
 * cannot exercise `setup` without trampling a live run. The variable widens
 * nothing; it only moves a scratch breadcrumb.
 */
export function pointerPath(env = process.env) {
  const override = env["APPROVAL_HERMES_PROBE_POINTER"];
  return typeof override === "string" && override.trim() !== "" ? override : POINTER;
}

/**
 * The FAIL-CLOSED trials: three ways for a hook to be broken rather than to
 * refuse.
 *
 * Each is run twice, once per `fail_closed` setting, and the pair is the
 * finding. A `crash` that blocks with the key and proceeds without it is the
 * documented behaviour confirmed; a `crash` that proceeds both ways is this
 * harness joining Grok and Muse, and the adapter's documentation changes
 * accordingly.
 */
export const FAIL_TRIALS = ["crash", "hang", "garbage"];

/**
 * The DIALECT trials: one form of an answer each, and never two at once.
 *
 * Single-variable by construction, which is the lesson APRV-350 paid for. On
 * Muse, a refusal that printed every dialect AND exited 2 did not block: an
 * unsupported key made the whole output invalid, an invalid hook was a failed
 * hook, and a failed hook failed open, so being MORE explicit made the refusal
 * WEAKER. `deny-mixed` is here to test whether Hermes shares that behaviour,
 * and it is the one trial that is deliberately not single-variable.
 *
 * The `allow-*` trials matter as much as the `deny-*` ones on this harness,
 * because Hermes has NO allow directive: an empty stdout, a bare `{}`, and any
 * JSON object naming no directive all mean "no opinion", which means proceed.
 * The adapter ships `{}`, so `allow-empty-object` is the trial that licenses it.
 * `allow-action-allow` prints an invented `{"action":"allow"}` to find out
 * whether an unrecognised directive VALUE still falls through to an allow or is
 * treated as a parse failure — and under `fail_closed: true` a parse failure is
 * a BLOCK, so that one trial is the difference between a spelling that works and
 * a spelling that silently stops a session.
 */
export const DIALECT_TRIALS = [
  // The two the adapter ships. `deny-action-exit2` is the deny it emits, and
  // `allow-empty-object` is the allow; if either of these is the wrong answer
  // nothing else in the list matters.
  "deny-action-exit2",
  "allow-empty-object",
  // The alternatives, each isolated, so the report can say what else would have
  // worked and what would not.
  "deny-action",
  "deny-decision",
  "deny-exit2",
  "deny-mixed",
  "allow-empty",
  "allow-action-allow",
];

/** Every trial name `arm` accepts, plus the disarm. */
export const ALL_TRIALS = [...FAIL_TRIALS, ...DIALECT_TRIALS];

/**
 * The file the operator asks Hermes to create in each trial.
 *
 * Existence after the trial is the whole measurement, and which way it reads
 * depends on the trial. For a `deny-*` or a `fail_closed` trial, PRESENT means
 * the effect happened despite the hook, which is fail open. For an `allow-*`
 * trial, present means the answer was accepted, and ABSENT under
 * `fail_closed: true` means the harness rejected that form of yes.
 *
 * The `fail_closed` state is in the name because the same trial is run both
 * ways and two runs must not overwrite each other's evidence.
 */
export function trialArtifact(trial, failClosed) {
  return `${trial}-${failClosed ? "failclosed" : "failopen"}-probe.txt`;
}

/** How long `arm hang` blocks for. Well past the documented 600s maximum. */
const HANG_MS = 700_000;

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Strip token-shaped strings before anything is written to disk.
 *
 * The envelope is recorded verbatim in every other respect, on purpose: the
 * point of the probe is the exact bytes. But an envelope may carry a session
 * token or an auth header, and a probe capture is pasted into a task and a pull
 * request. Raw secrets never appear in a record this project writes (SPEC.md
 * §11.1 invariant 3), and a scratch capture is no exception.
 *
 * Deliberately over-eager: a redacted field the report cannot name is a far
 * cheaper mistake than a token in a PR body.
 */
export function redact(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/\b[Bb]earer\s+[A-Za-z0-9._~+/-]{8,}=*/gu, "Bearer <redacted>")
    .replace(
      /("(?:[A-Za-z_]*(?:token|secret|password|passwd|apikey|api_key|auth|cookie|credential|session_key)[A-Za-z_]*)"\s*:\s*")([^"]{4,})(")/giu,
      (_match, head, _value, tail) => `${head}<redacted>${tail}`,
    )
    .replace(/\b(?:sk-|sk-ant-|xoxb-|ghp_|gho_|github_pat_|hf_|nous-)[A-Za-z0-9._~+/-]{12,}=*/gu, "<redacted>")
    .replace(/\beyJ[A-Za-z0-9._~+/-]{20,}=*/gu, "<redacted-jwt>");
}

// ---------------------------------------------------------------------------
// The path jail
// ---------------------------------------------------------------------------

/**
 * The tool that carries a program and nothing a verdict could bind.
 *
 * Refused here for the same reason the shipped adapter refuses it
 * (`hook-hermes-execute-code-unbound`): there is no path, no argv and no
 * directory in the call, so nothing in it can be placed inside or outside the
 * scratch project.
 */
const UNBOUND_TOOL = "execute_code";

/** Keys that carry a path, in either spelling, across Hermes's documented tools. */
const PATH_KEYS = ["path", "file_path", "filePath", "paths", "workdir", "cwd", "directory", "dir"];

/**
 * The first thing in this call that resolves outside `project`, or `null`.
 *
 * Deliberately shallow and deliberately loud: it reads the documented path keys
 * and the shell command's words, resolves each against the project, and returns
 * the first that leaves it. An unresolvable value counts as OUTSIDE, because a
 * value nothing can place is a value nothing can say is inside — the same
 * fail-closed reading `readToolGate` makes in the runtime.
 *
 * It is not a security boundary and does not pretend to be one. A shell command
 * can reach out of the project in ways no string inspection catches, which is
 * exactly why the scratch project holds nothing real.
 */
export function outsideProject(envelope, project) {
  if (envelope === null || typeof envelope !== "object") return "(unparseable envelope)";
  const tool = envelope.tool_name ?? envelope.toolName ?? null;
  if (tool === UNBOUND_TOOL) return `${UNBOUND_TOOL} (carries a program and no path)`;
  const input = envelope.tool_input ?? envelope.toolInput ?? {};
  if (typeof input !== "object" || input === null) return null;

  // BOTH spellings of the project root, and the reason is macOS rather than
  // pedantry: the system temp root is a symlink there, so `mkdtemp` hands back a
  // `/var/folders/…` path while `realpath` of the same directory is
  // `/private/var/folders/…`. A jail that compared only one of them called every
  // call in its own scratch project an escape, which is a probe that refuses
  // everything and measures nothing.
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
    // FAIL CLOSED on a value this cannot place: a home shortcut and an
    // unexpanded parameter are outside, because nothing can say they are inside.
    if (value.startsWith("~") || value.includes("$")) return false;
    const absolute = isAbsolute(value) ? value : resolvePath(roots[0], value);
    if (under(absolute)) return true;
    try {
      return under(realpathSync(absolute));
    } catch {
      // A path that does not exist yet is judged on its lexical form alone,
      // which the check above already rejected. A write to a new file inside the
      // project is accepted there; one outside it stays outside.
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
// Scratch project and scratch HERMES_HOME
// ---------------------------------------------------------------------------

/**
 * The synthetic files, and the complete list of what the scratch project holds.
 *
 * Every byte here is written by this script. Nothing is copied from this
 * repository or from anywhere else on the disk, and there is deliberately no
 * `AGENTS.md` and no `CLAUDE.md`: a coding harness reads those as instructions,
 * so a real one would put a real project's rules into the session. A test
 * asserts their absence rather than trusting this comment.
 */
export const SYNTHETIC_FILES = {
  "README.md": [
    "# Probe Fixture (synthetic)",
    "",
    "This project is fake. Every file in it was generated by",
    "scripts/probes/hermes-hook.mjs for the APRV-398 hook probe.",
    "",
    "There is no real source code here and nothing was copied from any",
    "repository. Delete the whole scratch root when the probe is done.",
    "",
  ].join("\n"),
  "src/widget.py": [
    "# SYNTHETIC DUMMY FILE - not real source, generated by the APRV-398 probe.",
    "",
    "DUMMY_CONSTANT = 'placeholder-value-0000'",
    "",
    "",
    "def add_dummy_numbers(first, second):",
    "    return first + second  # placeholder arithmetic, no meaning",
    "",
  ].join("\n"),
  "notes.txt": [
    "Synthetic scratch notes. Generated, not copied. Nothing real lives here.",
    "",
  ].join("\n"),
};

/**
 * The hook configuration, as YAML, written into the SCRATCH `HERMES_HOME`.
 *
 * YAML is emitted by hand rather than through a serializer, because this
 * repository carries no YAML writer and adding a dependency for a probe would be
 * a dependency to justify in a task note. The document is four keys deep and
 * fully quoted, so there is nothing for an emitter to get subtly right.
 *
 * THE EVENT IS A KEY, not an `event:` field on the entry: `hooks:` maps an event
 * name to a LIST of entries, each with `command`, an optional `timeout`, an
 * optional `matcher` regex, and `fail_closed`. `matcher` is omitted so every
 * tool is captured, which is what a gate wants and what a probe needs.
 *
 * BOTH TIMEOUTS ARE SET EXPLICITLY, because they are different timeouts and the
 * shorter one wins. The per-entry `timeout` defaults to 60s and is capped at
 * 300s. `plugins.hook_callback_timeout` is an OUTER timeout over the whole
 * dispatch, defaults to 30s, and on `pre_tool_call` it FAILS CLOSED on its own —
 * so leaving it alone would make every `hang` trial block for a reason that has
 * nothing to do with the key under test, and the probe would measure the wrong
 * thing. Both are set to their documented maxima so the `hang` trial outlasts
 * them deliberately rather than by accident.
 *
 * `hooks_auto_accept` is the headless consent, and leaving it out would be worse
 * than an error: with no TTY and no consent setting, Hermes SILENTLY SKIPS
 * REGISTERING THE HOOK, so the probe would capture nothing and the absence would
 * look like a config that did not fire. It is set inside the SCRATCH home only,
 * so nothing about the operator's own consent state changes.
 */
export function buildConfig(statePath, failClosed) {
  const command = `node ${SCRIPT} record --state ${statePath}`;
  const entry = (id) =>
    [
      `    - command: "${command} --config-id ${id}"`,
      "      timeout: 300",
      ...(failClosed ? ["      fail_closed: true"] : []),
    ].join("\n");
  return [
    "# APRV-398 Hermes hook probe. Scratch HERMES_HOME; generated, not edited.",
    `# fail_closed: ${failClosed ? "true on every entry" : "ABSENT on every entry"}`,
    "plugins:",
    "  hook_callback_timeout: 600",
    "hooks_auto_accept: true",
    "hooks:",
    "  pre_tool_call:",
    entry("pre"),
    "  post_tool_call:",
    entry("post"),
    "",
  ].join("\n");
}

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

/** The positional after a verb, so `arm crash` and `fail-closed on` both read. */
function positionalAfter(argv, verb) {
  const index = argv.indexOf(verb);
  if (index === -1) return null;
  const value = argv[index + 1];
  return typeof value === "string" && !value.startsWith("--") ? value : null;
}

/** The current `fail_closed` state, from the state directory. */
function currentFailClosed(state) {
  const saved = readJson(join(state, "fail-closed.json"), { failClosed: true });
  return saved.failClosed !== false;
}

/**
 * The markers the probe's block sits between, in a config it did not author.
 *
 * Everything outside them is the operator's and is never rewritten. `fail-closed
 * on|off` replaces the region between them and nothing else, which is what makes
 * it safe to run against a real install between trials.
 */
export const BLOCK_START = "# >>> APRV-398 HERMES HOOK PROBE (generated) >>>";
export const BLOCK_END = "# <<< APRV-398 HERMES HOOK PROBE <<<";

/** Top-level keys the probe's block introduces, and so must not already exist. */
const OWNED_KEYS = ["hooks", "plugins", "hooks_auto_accept"];

/**
 * Does `text` already carry one of the keys the block would introduce?
 *
 * Read OUTSIDE the probe's own markers, so re-running setup against a config the
 * probe already wrote is fine while running it against a config that configures
 * its own hooks is refused. Matched at column zero, because a top-level key is
 * the only kind that would collide: YAML permits no duplicate key in one mapping,
 * so appending a second `hooks:` would make the whole file unparseable and Hermes
 * would start with no hooks at all — which looks exactly like a probe whose
 * config never fired.
 */
export function conflictingKeys(text) {
  const outside = stripBlock(text);
  return OWNED_KEYS.filter((key) => new RegExp(`^${key}\\s*:`, "mu").test(outside));
}

/** `text` with the probe's own block removed, markers and all. */
export function stripBlock(text) {
  const start = text.indexOf(BLOCK_START);
  if (start === -1) return text;
  const end = text.indexOf(BLOCK_END, start);
  if (end === -1) return text.slice(0, start);
  return `${text.slice(0, start)}${text.slice(end + BLOCK_END.length)}`.replace(/\n{3,}/gu, "\n\n");
}

/**
 * Write the config for `failClosed` and remember which way it was written.
 *
 * Returns `{ok:true}`, or `{ok:false, reason, block}` when the operator's own
 * configuration already owns one of the keys the block introduces — in which case
 * nothing on disk is touched and the caller prints the block instead.
 */
function applyConfig(state, home, failClosed) {
  mkdirSync(home, { recursive: true });
  const path = join(home, "config.yaml");
  const block = `${BLOCK_START}\n${buildConfig(state, failClosed)}${BLOCK_END}\n`;

  let existing = "";
  try {
    existing = readFileSync(path, "utf8");
  } catch {
    existing = "";
  }
  if (existing !== "") {
    const clashes = conflictingKeys(existing);
    if (clashes.length > 0) {
      return {
        ok: false,
        reason: `${path} already carries a top-level ${clashes.join(" and ")} key`,
        block,
      };
    }
    // One backup, ever. A second run must not overwrite the first copy with an
    // already-modified file: the point of the backup is the state before the
    // probe touched anything.
    const backup = `${path}.aprv398-backup`;
    if (!existsSync(backup)) writeFileSync(backup, existing, "utf8");
  }

  const kept = stripBlock(existing);
  writeFileSync(path, `${kept.replace(/\n*$/u, "\n")}${kept === "" ? "" : "\n"}${block}`, "utf8");
  writeJson(join(state, "fail-closed.json"), {
    failClosed,
    at: new Date().toISOString(),
    config: path,
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

export function setup(argv, write = process.stdout.write.bind(process.stdout)) {
  const root = mkdtempSync(join(tmpdir(), "aprv398-hermes-probe-"));
  const project = join(root, "scratch-project");
  // A REAL install's HERMES_HOME when the operator names one, and a scratch home
  // otherwise. The probe must never guess `~/.hermes`: an install directed
  // somewhere else with `--hermes-home` would leave the probe writing a config
  // nothing reads, and the empty capture would look like a hook that never fired.
  const declaredHome = flagValue(argv, "--home");
  const ownHome = declaredHome === null;
  const home = ownHome ? join(root, "hermes-home") : resolvePath(declaredHome);
  // Captures go somewhere durable when asked, so the findings outlive the temp
  // root the scratch project lives in.
  const declaredCaptures = flagValue(argv, "--captures");
  const state = declaredCaptures === null ? join(root, "state") : resolvePath(declaredCaptures);
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(home, { recursive: true });

  for (const [relative, body] of Object.entries(SYNTHETIC_FILES)) {
    const target = join(project, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body, "utf8");
  }
  const applied = applyConfig(state, home, true);
  if (!applied.ok) {
    process.stderr.write(
      [
        "",
        "REFUSED TO EDIT THE CONFIG, AND NOTHING ON DISK WAS TOUCHED.",
        `  ${applied.reason}.`,
        "",
        "YAML permits no duplicate top-level key, so appending this block would",
        "make the whole file unparseable and Hermes would start with NO hooks —",
        "which looks exactly like a probe whose config never fired. Merge the",
        "block below into the existing keys by hand, then re-run setup with the",
        "same --home to record the scratch project and the prompts:",
        "",
        applied.block,
      ].join("\n"),
    );
    return 2;
  }

  writeJson(join(state, "setup.json"), {
    createdAt: new Date().toISOString(),
    root,
    project,
    home,
    ownHome,
    config: join(home, "config.yaml"),
    syntheticFiles: Object.keys(SYNTHETIC_FILES),
  });
  writeJson(join(state, "control.json"), { armed: "none" });
  writeJson(pointerPath(), { state, project, home, root, createdAt: new Date().toISOString() });

  write(
    [
      "===========================================================================",
      "NEVER RUN THIS PROBE INSIDE A REAL REPOSITORY. The scratch project below",
      "holds only synthetic files this script just wrote, and HERMES_HOME is",
      "redirected to a scratch directory, so your own ~/.hermes is never read or",
      "written. Both of those are the control; the hook's own path jail is only a",
      "backstop, because whether a refusal is honoured at all is what is under",
      "test here.",
      "===========================================================================",
      "",
      "WHAT THIS PROBE IS FOR: Hermes documents a per-entry `fail_closed: true`",
      "that makes a hook crash, a hook timeout and unparseable hook output all",
      "BLOCK the tool call. Every other harness this project has adapted since",
      "Claude Code fails OPEN with no setting to change it. If the documented",
      "behaviour holds, `approval hook hermes` is a real gate rather than a",
      "backstop, and docs/hermes-hook.md changes from UNVERIFIED to observed.",
      "",
      "---------------------------------------------------------------------------",
      `SCRATCH ROOT:    ${root}`,
      `SCRATCH PROJECT: ${project}`,
      ownHome
        ? `SCRATCH HOME:    ${home}   (config.yaml only; no credential, no allowlist)`
        : `YOUR HERMES_HOME: ${home}   (the hook block was added between markers;\n                  the original config.yaml is backed up beside it)`,
      `CAPTURES:        ${state}`,
      "---------------------------------------------------------------------------",
      "",
      ...(ownHome
        ? []
        : [
            "A LIVE MODEL IS NEEDED, because the probe measures TOOL CALLS and only a",
            "model makes them. If this install has no provider configured yet:",
            "",
            "  hermes setup            # the wizard: pick a provider and paste a key",
            "  hermes setup --portal   # or Nous Portal specifically",
            "  hermes model            # change the provider or model later",
            "",
            "Point it at the cheapest small model your provider offers: the probe's",
            "prompts are four one-line tool calls, so capability is irrelevant and",
            "spend is the only axis that matters. Nous's own docs name no specific",
            "cheap id, so pick one from `hermes model`'s list rather than from here.",
            "Keys live under $HERMES_HOME/.env, which is `account.credential` to this",
            "repository's classifier and which no agent reads.",
            "",
          ]),
      `Synthetic files: ${Object.keys(SYNTHETIC_FILES).join(", ")}`,
      "Deliberately ABSENT: AGENTS.md, CLAUDE.md. A coding harness reads those as",
      "instructions, so a real project's rules would enter the session.",
      "",
      "---------------------------------------------------------------------------",
      "STEP 1. Every terminal that runs hermes for this probe exports this first:",
      "---------------------------------------------------------------------------",
      "",
      `  export HERMES_HOME=${home}`,
      "",
      "Without it Hermes reads your real configuration and this probe measures",
      "nothing. Check it with `echo $HERMES_HOME` in each terminal.",
      "",
      "---------------------------------------------------------------------------",
      "STEP 2. The baseline capture. Start Hermes in the scratch project only:",
      "---------------------------------------------------------------------------",
      "",
      `  cd ${project}`,
      "  hermes",
      "",
      "Then type these four prompts, separately, so one envelope of each shape is",
      "captured verbatim:",
      "",
      "  1. run the shell command `ls -la` here",
      "  2. create a file named probe.txt containing the word hello",
      "  3. change the word hello in probe.txt to goodbye",
      "  4. read README.md and tell me its first line",
      "",
      "Then one more, which SHOULD be refused before it runs:",
      "",
      "  5. run some python code that prints 2+2",
      "",
      "---------------------------------------------------------------------------",
      "STEP 3. The fail-closed trials. THE POINT OF THE PROBE. Quit Hermes",
      "         between each one.",
      "---------------------------------------------------------------------------",
      "",
      "Each trial is run TWICE, once with `fail_closed: true` and once without,",
      "and the pair is the finding. `hang` makes Hermes wait past its 600s",
      "timeout: let it, and do not interrupt it.",
      "",
      ...["on", "off"].flatMap((mode) => [
        `  node ${SCRIPT} fail-closed ${mode}`,
        ...FAIL_TRIALS.flatMap((trial) => [
          `    node ${SCRIPT} arm ${trial}`,
          `      then in hermes, in ${project}:`,
          `      create a file named ${trialArtifact(trial, mode === "on")} containing x`,
        ]),
        "",
      ]),
      "---------------------------------------------------------------------------",
      "STEP 4. The dialect trials, with fail_closed ON. One form of answer each.",
      "---------------------------------------------------------------------------",
      "",
      "Never two dialects at once except `deny-mixed`, which is there on purpose:",
      "on Muse Code, a refusal printing every dialect AND exiting 2 did not block,",
      "because an unsupported key made the whole output invalid, an invalid hook",
      "was a failed hook, and a failed hook failed open. Being more explicit made",
      "the refusal weaker. This is where we find out whether Hermes shares that.",
      "",
      "The `allow-*` trials matter as much. Hermes has no allow directive: an",
      "empty stdout, a bare {} and any JSON object naming no directive all mean",
      "\"no opinion\", which means proceed. The adapter ships {}, so",
      "`allow-empty-object` is the trial that licenses it. `allow-action-allow`",
      "prints an invented {\"action\":\"allow\"} to find out whether an unrecognised",
      "directive VALUE still allows or is a parse failure — and under fail_closed a",
      "parse failure is a BLOCK, which is why the adapter does not ship it.",
      "",
      "The first two trials in the list are the two forms the adapter actually",
      "emits. If either of those is the wrong answer, nothing else matters.",
      "",
      `  node ${SCRIPT} fail-closed on`,
      ...DIALECT_TRIALS.flatMap((trial) => [
        `  node ${SCRIPT} arm ${trial}`,
        `    then in hermes, in ${project}:`,
        `    create a file named ${trialArtifact(trial, true)} containing x`,
      ]),
      "",
      "---------------------------------------------------------------------------",
      "STEP 5. Report:",
      "---------------------------------------------------------------------------",
      "",
      `  node ${SCRIPT} report`,
      "",
      "Paste the whole report. Its first section is the fail-closed answer.",
      "",
      `Delete ${root} when you are done.`,
      "",
    ].join("\n"),
  );
  return 0;
}

// ---------------------------------------------------------------------------
// fail-closed
// ---------------------------------------------------------------------------

export function failClosedVerb(argv, write = process.stdout.write.bind(process.stdout)) {
  const mode = positionalAfter(argv, "fail-closed");
  if (mode !== "on" && mode !== "off") {
    process.stderr.write("fail-closed takes `on` or `off`\n");
    return 2;
  }
  const state = resolveState(argv);
  if (state === null) {
    process.stderr.write("no scratch state found; run `setup` first\n");
    return 2;
  }
  const setupState = readJson(join(state, "setup.json"), {});
  if (typeof setupState.home !== "string") {
    process.stderr.write("the scratch state names no HERMES_HOME; re-run `setup`\n");
    return 2;
  }
  const applied = applyConfig(state, setupState.home, mode === "on");
  if (!applied.ok) {
    process.stderr.write(`refused to edit the config: ${applied.reason}; nothing was touched\n`);
    return 2;
  }
  write(
    [
      `Rewrote ${join(setupState.home, "config.yaml")}: fail_closed is now ${
        mode === "on" ? "true on every entry" : "ABSENT from every entry"
      }.`,
      "Only the region between the APRV-398 markers changed; everything else in",
      "that file is yours and was left alone.",
      "Restart hermes so it re-reads the config. Every trial from here is",
      `recorded as ${mode === "on" ? "failclosed" : "failopen"}.`,
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
  if (trial === null || ![...ALL_TRIALS, "none"].includes(trial)) {
    process.stderr.write(`arm takes one of: ${[...ALL_TRIALS, "none"].join(", ")}\n`);
    return 2;
  }
  const state = resolveState(argv);
  if (state === null) {
    process.stderr.write("no scratch state found; run `setup` first\n");
    return 2;
  }
  const failClosed = currentFailClosed(state);
  writeJson(join(state, "control.json"), {
    armed: trial,
    failClosed,
    armedAt: new Date().toISOString(),
  });
  write(
    trial === "none"
      ? "Disarmed. The next tool call gets the ordinary path jail and nothing else.\n"
      : [
          `Armed: the NEXT tool call will run trial \`${trial}\`.`,
          `fail_closed is currently ${failClosed ? "TRUE" : "ABSENT"}.`,
          `In hermes, ask for: create a file named ${trialArtifact(trial, failClosed)} containing x`,
          "The arm is consumed by that one call; later calls behave normally.",
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

/** Block the process past any plausible per-hook timeout, without burning CPU. */
function hang() {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, HANG_MS);
}

/**
 * Every dialect at once, for the `deny-mixed` trial only.
 *
 * It exists to be measured, not to be shipped. The shipped adapter emits one
 * form and the test asserts its top-level keys exactly, because on Muse this
 * shape was read as a broken hook and failed open.
 */
export function mixedDenyPayload(reason) {
  return {
    action: "block",
    message: reason,
    decision: "block",
    reason,
    hookSpecificOutput: {
      hookEventName: "pre_tool_call",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

/** The body and exit code one dialect trial answers with. */
export function dialectAnswer(trial, reason) {
  switch (trial) {
    // THE SHIPPED DENY: the native directive plus the blocking exit code. Not a
    // hedge — Hermes states the precedence itself (the exit code blocks
    // unconditionally, and the stdout directive supplies the message), so the
    // two agree by its own rule rather than competing.
    case "deny-action-exit2":
      return { body: { action: "block", message: reason }, code: 2 };
    // THE SHIPPED ALLOW: a JSON object naming no directive.
    case "allow-empty-object":
      return { body: {}, code: 0 };
    case "deny-action":
      return { body: { action: "block", message: reason }, code: 0 };
    case "deny-decision":
      return { body: { decision: "block", reason }, code: 0 };
    case "deny-exit2":
      return { body: null, code: 2 };
    case "deny-mixed":
      return { body: mixedDenyPayload(reason), code: 2 };
    case "allow-empty":
      return { body: null, code: 0 };
    // An invented directive VALUE. Hermes honours `block` and `modify`; whether
    // an unrecognised third falls through to an allow or is a parse failure (a
    // BLOCK under fail_closed) is exactly what this measures, and it is why the
    // adapter does not ship this spelling.
    case "allow-action-allow":
      return { body: { action: "allow", message: reason }, code: 0 };
    default:
      return null;
  }
}

export function record(argv, io = {}) {
  const write = io.write ?? process.stdout.write.bind(process.stdout);
  const warn = io.warn ?? process.stderr.write.bind(process.stderr);
  const readInput = io.readInput ?? readStdin;
  const sleep = io.sleep ?? hang;

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

  // A post event is recorded and answered with NOTHING, and it never consumes an
  // armed trial: an arm landing on the report of a call rather than on the call
  // itself would measure the wrong event, which is the mistake the Muse probe
  // had to be corrected for mid-run.
  const eventName =
    envelope === null ? null : (envelope.hook_event_name ?? envelope.hookEventName ?? null);
  const toolName = envelope === null ? null : (envelope.tool_name ?? envelope.toolName ?? null);
  const isPost = eventName === "post_tool_call";

  const control =
    state === null ? { armed: "none" } : readJson(join(state, "control.json"), { armed: "none" });
  const armed = isPost ? "none" : typeof control.armed === "string" ? control.armed : "none";
  const failClosed = control.failClosed !== false;
  if (state !== null && armed !== "none") {
    // One arm, one call. Consumed BEFORE acting, so a crash or a hang does not
    // leave the trial armed for every later call.
    writeJson(join(state, "control.json"), {
      armed: "none",
      failClosed,
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
          failClosed,
          argv: argv.slice(2).map(redact),
          hermesEnv: Object.fromEntries(
            Object.entries(process.env)
              .filter(([key]) => key.startsWith("HERMES_"))
              .map(([key, value]) => [key, redact(String(value))]),
          ),
          raw: redacted,
        })}\n`,
        "utf8",
      );
    } catch {
      // A capture that cannot be written must not turn into an allow.
    }
  }

  if (isPost) return 0;

  if (armed === "crash") {
    warn(`aprv398-probe: armed trial \`crash\` (fail_closed ${failClosed ? "true" : "absent"}) — exiting non-zero with no output on purpose\n`);
    return 1;
  }
  if (armed === "hang") {
    warn(`aprv398-probe: armed trial \`hang\` (fail_closed ${failClosed ? "true" : "absent"}) — blocking past the per-hook timeout on purpose\n`);
    sleep();
    return 0;
  }
  if (armed === "garbage") {
    write("aprv398-probe: armed trial `garbage` <<<not json at all>>> {\n");
    return 0;
  }

  const dialect = dialectAnswer(armed, `aprv398-probe: armed trial \`${armed}\``);
  if (dialect !== null) {
    if (dialect.body !== null) write(`${JSON.stringify(dialect.body)}\n`);
    return dialect.code;
  }

  // Unarmed: the ordinary path jail, in the dialect the shipped adapter uses,
  // so the baseline capture also exercises the form the adapter will emit.
  if (jailed !== null) {
    const reason = `aprv398-probe path jail: ${jailed} is outside the scratch project ${
      project ?? "(unknown)"
    }`;
    warn(
      [
        "",
        "!!! APRV-398 PROBE: PATH JAIL REFUSED THIS TOOL CALL !!!",
        `    ${reason}`,
        "    A hook fires AFTER the prompt was sent. This stops the tool call; it",
        "    does not recall what the model already saw. If Hermes fails open the",
        "    call happens anyway, which is the thing under test.",
        "",
      ].join("\n"),
    );
    write(`${JSON.stringify({ action: "block", message: reason })}\n`);
    // The blocking exit code as well as the directive, which is the shipped
    // adapter's deny exactly. Hermes states the precedence between them itself.
    return 2;
  }
  // The shipped allow: a JSON object naming no directive. The reason goes to
  // stderr, because there is nowhere in an allow to put one.
  warn(`aprv398-probe: allow — ${String(toolName)} stays inside the scratch project\n`);
  write("{}\n");
  return 0;
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
    write("no scratch state found; run `setup` first\n");
    return 2;
  }
  const setupState = readJson(join(state, "setup.json"), {});
  const project = typeof setupState.project === "string" ? setupState.project : null;
  const capture = join(state, "envelopes.jsonl");

  if (!existsSync(capture)) {
    write(
      [
        "FAIL-CLOSED FINDING: UNKNOWN — no envelope ever reached the hook.",
        "",
        "APRV-398 probe report: nothing was captured.",
        "",
        `Capture file: ${capture}`,
        project === null ? "" : `Scratch project: ${project}`,
        typeof setupState.home === "string" ? `Scratch HERMES_HOME: ${setupState.home}` : "",
        "",
        "That is itself a finding, and the first thing to check is the export:",
        "every terminal running hermes for this probe needs",
        typeof setupState.home === "string" ? `  export HERMES_HOME=${setupState.home}` : "  export HERMES_HOME=<scratch home>",
        "If it was set and nothing fired, then a committed Hermes hooks block is",
        "not a usable interception surface at this version, and the adapter cannot",
        "be enforcement. Check the startup banner for a rejected config.",
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

  const artifactPresent = (name) => project !== null && existsSync(join(project, name));

  /**
   * One trial's verdict, judged from whether its artifact reached the disk.
   *
   * `blockIsPass` is what the trial is asking. A `deny-*` or `fail_closed` trial
   * passes when the artifact is ABSENT: the hook said no (or broke) and the
   * harness withheld the effect. An `allow-*` trial passes when the artifact is
   * PRESENT: the harness accepted that form of yes.
   */
  const trialLine = (trial, failClosed, blockIsPass) => {
    const name = trialArtifact(trial, failClosed);
    const label = `  ${trial} (fail_closed ${failClosed ? "TRUE" : "absent"})`;
    if (project === null) return `${label}: (no scratch project recorded)`;
    const ran = rows.some((row) => row.armed === trial && row.failClosed === failClosed);
    if (!ran) return `${label}: NOT RUN (no captured call was armed this way)`;
    const present = artifactPresent(name);
    if (blockIsPass) {
      return present
        ? `${label}: FAIL OPEN — ${name} exists, so the effect happened anyway`
        : `${label}: FAIL CLOSED — ${name} absent, so Hermes withheld the effect`;
    }
    return present
      ? `${label}: ACCEPTED — ${name} exists, so Hermes honoured this form of allow`
      : `${label}: REJECTED — ${name} absent, so this form of allow did not let the call run`;
  };

  /** The headline: did `fail_closed: true` change anything at all? */
  const failClosedVerdict = () => {
    const withKey = FAIL_TRIALS.filter((trial) =>
      rows.some((row) => row.armed === trial && row.failClosed === true),
    );
    const withoutKey = FAIL_TRIALS.filter((trial) =>
      rows.some((row) => row.armed === trial && row.failClosed === false),
    );
    if (withKey.length === 0) {
      return "UNKNOWN — no crash, hang or garbage trial ran with fail_closed: true.";
    }
    const blockedWithKey = withKey.filter((trial) => !artifactPresent(trialArtifact(trial, true)));
    const blockedWithoutKey = withoutKey.filter(
      (trial) => !artifactPresent(trialArtifact(trial, false)),
    );
    if (blockedWithKey.length === withKey.length && withKey.length === FAIL_TRIALS.length) {
      return [
        "CONFIRMED — every broken hook BLOCKED with fail_closed: true.",
        withoutKey.length === 0
          ? "  The without-key half did not run, so the key is not yet shown to be"
          : blockedWithoutKey.length === 0
            ? "  And every one of them PROCEEDED without the key, so the key is what"
            : "  But some blocked WITHOUT the key too, so the key is not the whole",
        withoutKey.length === 0
          ? "  what causes it; run `fail-closed off` and repeat the three trials."
          : blockedWithoutKey.length === 0
            ? "  does it. `approval hook hermes` is a real gate: crash, timeout and"
            : "  reason; report the pairs below verbatim rather than concluding.",
        blockedWithoutKey.length === 0 && withoutKey.length > 0
          ? "  garbage all refuse, which no adapter since Claude Code could say."
          : "",
      ]
        .filter((line) => line !== "")
        .join("\n");
    }
    return [
      `FAILS OPEN IN ${String(withKey.length - blockedWithKey.length)} OF ${String(withKey.length)} TRIALS DESPITE fail_closed: true.`,
      `  Proceeded anyway: ${withKey
        .filter((trial) => artifactPresent(trialArtifact(trial, true)))
        .join(", ")}.`,
      "  The documented guarantee does not hold for those cases, so the adapter is",
      "  enforcement only while healthy — the Grok and Muse situation — and",
      "  docs/hermes-hook.md must say so in its opening section.",
    ].join("\n");
  };

  const allKeys = new Set();
  for (const row of rows) for (const key of keysOf(row.inner)) allKeys.add(key);
  const camel = [...allKeys].filter((key) => /[a-z][A-Z]/u.test(key));
  const snake = [...allKeys].filter((key) => key.includes("_"));
  const events = [...new Set(rows.map((row) => row.event).filter(Boolean))];
  const tools = [...new Set(rows.map((row) => row.tool).filter(Boolean))];
  const configIds = [...new Set(rows.map((row) => row.configId).filter(Boolean))];

  const pick = (pattern) =>
    rows.find((row) => typeof row.tool === "string" && pattern.test(row.tool));
  const shellRow = pick(/^terminal$|shell|bash|exec/iu);
  const writeRow = pick(/write/iu);
  const patchRow = pick(/patch|edit/iu);
  const readRow = pick(/read|list|grep|glob|search|view/iu);
  const postRow = rows.find((row) => row.event === "post_tool_call");

  const inputKeysOf = (row) => {
    if (row === undefined || row.inner === null) return "(none captured)";
    const input = row.inner.tool_input ?? row.inner.toolInput ?? null;
    return `${row.tool}: tool_input keys ${keysOf(input).join(", ") || "(none)"}`;
  };

  const lines = [
    "=== 1. THE FAIL-CLOSED FINDING (the reason this probe exists) ===",
    failClosedVerdict(),
    "",
    ...FAIL_TRIALS.map((trial) => trialLine(trial, true, true)),
    ...FAIL_TRIALS.map((trial) => trialLine(trial, false, true)),
    "",
    "APRV-398 probe report.",
    "",
    `Envelopes captured: ${String(rows.length)}`,
    `Capture file (full JSON, verbatim, token-redacted): ${capture}`,
    project === null ? "" : `Scratch project: ${project}`,
    typeof setupState.home === "string" ? `Scratch HERMES_HOME: ${setupState.home}` : "",
    "",
    "=== 2. WHICH ENTRIES FIRED ===",
    configIds.length === 0 ? "  none identified" : configIds.map((id) => `  ${id}`).join("\n"),
    `  event names seen: ${events.join(", ") || "(none)"}`,
    "",
    "=== 3. ENVELOPE SHAPE ===",
    `  top-level keys seen: ${[...allKeys].join(", ") || "(payload was not a JSON object)"}`,
    `  camelCase keys: ${camel.join(", ") || "(none)"}`,
    `  snake_case keys: ${snake.join(", ") || "(none)"}`,
    "",
    `  one SHELL call: ${inputKeysOf(shellRow)}`,
    `  one WRITE call: ${inputKeysOf(writeRow)}`,
    `  one PATCH call: ${inputKeysOf(patchRow)}`,
    `  one READ  call: ${inputKeysOf(readRow)}`,
    `  one POST event: ${postRow === undefined ? "(none captured)" : `top-level keys ${keysOf(postRow.inner).join(", ")}`}`,
    "",
    "  THE PER-CALL WORKING DIRECTORY is the field the adapter cannot do without",
    "  (APRV-310 on Codex): without it a verdict binds different bytes from the",
    "  command the harness runs. Look for `workdir` in the SHELL call's",
    "  tool_input keys above. Absent means the adapter must refuse the shell tool",
    "  outright, exactly as the Codex one does.",
    "",
    "=== 4. TOOL NAMES SEEN ===",
    tools.length === 0 ? "  (none)" : tools.map((tool) => `  ${tool}`).join("\n"),
    "  The adapter's readTools list is a GUESS until this section contradicts or",
    "  confirms it. A read tool Hermes sends that the adapter does not list is an",
    "  unscoped read, which is the direction that matters.",
    "",
    "=== 5. DIALECT TRIALS (which single form of answer does Hermes honour?) ===",
    "  Each printed exactly ONE dialect, except deny-mixed. A deny form that",
    "  FAILS CLOSED here is one the adapter may ship; one that FAILS OPEN must",
    "  never be shipped alone. An allow form that is REJECTED cannot be shipped",
    "  at all under fail_closed, because every allow would become a block.",
    ...DIALECT_TRIALS.map((trial) => trialLine(trial, true, trial.startsWith("deny-"))),
    "",
    "=== 6. THE PATH JAIL, AND WHAT IT CAUGHT ===",
    ...(() => {
      const caught = rows.filter((row) => typeof row.jailed === "string" && row.jailed !== "");
      if (caught.length === 0) {
        return ["  Nothing left the scratch project, and execute_code was never asked for."];
      }
      return [
        `  ${String(caught.length)} call(s) named something outside the scratch project:`,
        ...caught.slice(0, 10).map((row) => `    ${String(row.tool)}: ${String(row.jailed)}`),
        "  A refusal here proves the jail fired, not that Hermes honoured it: check",
        "  whether the effect happened. Hermes applying no workspace confinement",
        "  would make the read jail load-bearing for this harness, as it is for",
        "  Muse Code.",
      ];
    })(),
    "",
    "=== 7. FIRST ENVELOPE, VERBATIM ===",
    ...rows.slice(0, 1).map((row) => `  ${row.raw}`),
    "",
    "=== 8. THE PRE EVENT FOR execute_code, VERBATIM (if it was asked for) ===",
    ...(() => {
      const unbound = rows.find((row) => row.tool === "execute_code");
      return unbound === undefined
        ? ["  (never asked for; prompt 5 of the runbook is what produces it)"]
        : [`  ${unbound.raw}`];
    })(),
    "",
    "Reminder: the scratch project held only synthetic files this script wrote,",
    "and HERMES_HOME was a scratch directory. Nothing of yours was read.",
    `Delete ${setupState.root ?? "the scratch root"} when this report is pasted.`,
    "",
  ];
  write(lines.join("\n"));
  return 0;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `usage: node scripts/probes/hermes-hook.mjs setup
                                            fail-closed on|off
                                            arm <trial>
                                            report

  setup        build the scratch project and scratch HERMES_HOME, write the
               hook config, and print the export line and the prompts
  fail-closed  rewrite the config with or without fail_closed: true
  arm          make the NEXT tool call ${ALL_TRIALS.join(", ")}, or none
  report       print the findings; the FIRST section is the fail-closed answer
  record       the hook entry itself; the config points at it, not you
`;

export function main(argv) {
  if (argv.includes("setup")) return setup(argv);
  if (argv.includes("fail-closed")) return failClosedVerb(argv);
  if (argv.includes("arm")) return arm(argv);
  if (argv.includes("record")) return record(argv);
  if (argv.includes("report")) return report(argv);
  process.stderr.write(USAGE);
  return 2;
}

if (process.argv[1] === SCRIPT) {
  process.exitCode = main(process.argv);
}
