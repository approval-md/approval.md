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
 *   - `HERMES_HOME` is REDIRECTED to a scratch directory this script creates
 *     WHEN NO `--home` IS GIVEN, so the operator's own home is never read and
 *     never written. The scratch home holds a `config.yaml` and nothing else: no
 *     credential, no token, no allowlist copied from anywhere.
 *
 *     WITH `--home <dir>` the REAL home is used, which is the only way to
 *     measure a real install: the block goes in between named markers, the
 *     original `config.yaml` is backed up once, and a file that already
 *     configures its own hooks is refused outright. The scratch PROJECT is still
 *     the control there, and it is the whole control — say so out loud rather
 *     than implying a redirection that did not happen (APRV-415).
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
 *   node scripts/probes/hermes-hook.mjs run [--home <dir>] [--captures <dir>]
 *       THE DRIVER (APRV-418). Does everything the four verbs above ask a human
 *       to do, in one process, with no prompt typed and no restart requested:
 *       reads the version and refuses below the fail-closed floor, builds the
 *       scratch project, writes the hook block, then walks the whole matrix,
 *       arming each trial and spawning ONE one-shot Hermes invocation for it,
 *       and prints the report at the end.
 *
 *       That is the point of the verb. The manual runbook is about thirty steps
 *       and every one of them is a `harness.launch.hermes`, which is manual by
 *       policy; the driver is ONE launch, so the human taps once. See
 *       `docs/probe-driver-convention.md` for the shape and the one-grant flow.
 *
 *   node scripts/probes/hermes-hook.mjs report
 *       Prints the findings. The FIRST section is the fail-closed answer.
 *
 * `record` is the hook entry; the config points at it. It is not run by hand.
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
/**
 * The MODIFY trial: does Hermes let a hook REWRITE the call it is answering?
 *
 * Hermes documents a third directive beside `block`: `{action:"modify", args}`,
 * which replaces the tool's arguments. If it is honoured for a shell call's
 * `workdir`, the adapter could PIN the directory it classified rather than
 * refusing a call that names none, the way the Codex adapter pins the exact
 * command bytes through `updatedInput`. That would turn APRV-415's refusal into a
 * repair the session never has to see, so it is worth measuring before relying on
 * it, and worth measuring in a way that cannot be misread.
 *
 * Single-variable by construction, and the construction is the point. The trial
 * pins `workdir` to `<project>/modify-target/`, a directory the scratch project
 * already contains, and the operator asks for the artifact through the SHELL with
 * no directory named. So:
 *
 *   - the file appears in `modify-target/` -> the directive was HONOURED;
 *   - the file appears in the project root -> it was IGNORED, and the command ran
 *     in the session's own recorded directory;
 *   - neither -> the call never ran, which is a third answer and not a failure of
 *     the trial.
 *
 * Pinning the project root instead would have measured nothing: a session started
 * in the project would put the file there either way.
 */
export const MODIFY_TRIAL = "modify-workdir";

/** The directory inside the scratch project that {@link MODIFY_TRIAL} pins. */
export const MODIFY_TARGET_DIR = "modify-target";

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
  // The third directive, read separately from every line above because its
  // reading is different: not blocked or allowed but WHERE it ran (APRV-415).
  MODIFY_TRIAL,
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
// The version floor (APRV-415, driven by APRV-418)
// ---------------------------------------------------------------------------

/**
 * The build at which Hermes starts honouring `fail_closed`.
 *
 * A COPY of `HERMES_FAIL_CLOSED_FLOOR` in `src/core/harness-version.ts`, and the
 * copy is deliberate: this file is plain Node ESM that an operator runs straight
 * from a checkout before any build, so it cannot import the compiled module.
 * `tests/probe-hermes-hook.test.ts` pins the two field for field, so the drift a
 * copy invites costs a test failure rather than a round.
 *
 * Why the floor is here at all rather than only in the doctor row: the first
 * Hermes round (2026-09-21) ran its whole matrix on `v0.21.3`, which ignores the
 * key SILENTLY, and every fail-closed result it produced was wrong for that one
 * reason. A driver that spends a human's launch grant on a build that cannot
 * answer the question is the expensive version of that mistake, so this one reads
 * the version BEFORE it writes a config and refuses below the floor.
 */
export const FAIL_CLOSED_FLOOR = {
  upstream: "118984d7",
  date: { year: 2026, month: 9, day: 20 },
  statement:
    "a build at or after main 118984d7 of 2026-09-20; v0.21.3 (2026.9.14) fails open silently",
};

/** How long a `--version` probe may take before it is killed. */
const VERSION_TIMEOUT_MS = 10_000;

/** The raw first line of a `--version`, trimmed of control characters and capped. */
export function versionLine(raw) {
  if (typeof raw !== "string") return null;
  const first = raw.split("\n", 1)[0] ?? "";
  const text = first.replace(/\p{Cc}/gu, "").trim();
  if (text.length === 0 || text.length > 200) return null;
  return text;
}

/**
 * Does this build honour `fail_closed`? `"honours"`, `"ignores"` or `"unknown"`.
 *
 * The comparison is on the BUILD DATE and the upstream commit, never the semver:
 * the two builds that differ on the whole question both report `0.21.3`. Two
 * commit hashes cannot be ordered without a repository, so a line carrying an
 * unfamiliar commit and no date is honestly `"unknown"`.
 */
export function floorVerdict(raw) {
  const line = versionLine(raw);
  if (line === null) return "unknown";
  const stamp = /\((\d{4})\.(\d{1,2})\.(\d{1,2})\)/u.exec(line);
  const upstream = /\bupstream\s+([0-9a-f]{7,40})\b/iu.exec(line);
  if (upstream !== null && String(upstream[1]).toLowerCase().startsWith(FAIL_CLOSED_FLOOR.upstream)) {
    return "honours";
  }
  if (stamp === null) return "unknown";
  const asNumber = (year, month, day) => year * 10_000 + month * 100 + day;
  const floor = FAIL_CLOSED_FLOOR.date;
  return asNumber(Number(stamp[1]), Number(stamp[2]), Number(stamp[3])) >=
    asNumber(floor.year, floor.month, floor.day)
    ? "honours"
    : "ignores";
}

// ---------------------------------------------------------------------------
// The one-shot invocation, and the matrix the driver walks (APRV-418)
// ---------------------------------------------------------------------------

/**
 * How the driver spells ONE non-interactive Hermes run.
 *
 * `{prompt}` and `{dir}` are substituted; every other token is passed through.
 * UNVERIFIED in this repository: nothing here has ever run the binary, and the
 * spelling comes from APRV-418's brief. It is a template rather than a literal
 * argv precisely so a wrong guess is a flag on the command line
 * (`--one-shot "<template>"`) rather than an edit to this file, and so the
 * driver's early abort can tell the operator which knob to turn.
 *
 * `--accept-hooks` is not optional and not a convenience. With no TTY and no
 * consent, Hermes SILENTLY SKIPS REGISTERING THE HOOK: nothing fires, nothing
 * complains, and an empty capture looks exactly like a config that never loaded.
 * The driver also exports `HERMES_ACCEPT_HOOKS=1` for the same reason, because
 * two belts cost nothing and one missing one costs the round.
 */
export const ONE_SHOT_TEMPLATE = "-z {prompt} --in {dir} --accept-hooks";

/** The argv for one one-shot run, or `null` when the template names no prompt. */
export function oneShotArgv(template, prompt, project) {
  const tokens = String(template).split(/\s+/u).filter((token) => token !== "");
  if (!tokens.includes("{prompt}")) return null;
  return tokens.map((token) =>
    token === "{prompt}" ? prompt : token === "{dir}" ? project : token,
  );
}

/**
 * The five baseline prompts: one envelope of each tool shape.
 *
 * The fifth SHOULD be refused before it runs, and its refusal is a finding
 * rather than a failure: `execute_code` carries a program and no path, so the
 * shipped adapter refuses it early.
 */
export const BASELINE_PROMPTS = [
  "run the shell command `ls -la` here",
  "create a file named probe.txt containing the word hello",
  "change the word hello in probe.txt to goodbye",
  "read README.md and tell me its first line",
  "run some python code that prints 2+2",
];

/**
 * Every step of the driven round, in order, as data.
 *
 * Declarative on purpose: the matrix is what a reviewer checks, and a reviewer
 * should be able to read it without reading the loop that walks it. A step names
 * the trial to arm, the `fail_closed` state its config needs, the prompt to send
 * and the artifact whose presence is the measurement.
 *
 * THE ORDER OF THE TWO FAIL-CLOSED PASSES IS THE FINDING. Pass A (with the key)
 * and pass B (without it) are both driven here, which the manual round never
 * managed: each switch of the key needs Hermes restarted, and a one-shot
 * invocation IS a fresh start, so the driver gets the control pass for free.
 */
export function matrix() {
  const steps = [];
  BASELINE_PROMPTS.forEach((prompt, index) => {
    steps.push({
      id: `baseline-${String(index + 1)}`,
      phase: "baseline",
      trial: "none",
      failClosed: true,
      prompt,
      artifact: null,
      hang: false,
    });
  });
  for (const failClosed of [true, false]) {
    for (const trial of FAIL_TRIALS) {
      const artifact = trialArtifact(trial, failClosed);
      steps.push({
        id: `${trial}-${failClosed ? "failclosed" : "failopen"}`,
        phase: "fail-closed",
        trial,
        failClosed,
        prompt: `create a file named ${artifact} containing x`,
        artifact,
        hang: trial === "hang",
      });
    }
  }
  for (const trial of DIALECT_TRIALS) {
    const artifact = trialArtifact(trial, true);
    steps.push({
      id: trial,
      phase: "dialect",
      trial,
      failClosed: true,
      // The modify trial is asked for through the SHELL with no directory named,
      // because its answer is WHERE the artifact landed. A prompt asking for "a
      // file named x" could be answered by a file tool, which carries its own
      // path and would measure nothing about a workdir.
      prompt:
        trial === MODIFY_TRIAL
          ? `run the shell command: touch ${artifact}`
          : `create a file named ${artifact} containing x`,
      artifact,
      hang: false,
    });
  }
  return steps;
}

/** How long one ordinary step may take. */
export const STEP_TIMEOUT_MS = 180_000;

/**
 * How long a `hang` step may take, and why it is eleven minutes.
 *
 * Two Hermes timeouts bound that trial and the driver must outlast BOTH or it
 * measures its own patience instead of the harness's: the per-entry `timeout`
 * (300s, its documented cap) and `plugins.hook_callback_timeout` (600s, the
 * maximum this probe's config sets). The live round saw the entry cap win at
 * 300s; a driver that gave up at 480s would report a killed child for the case
 * where the outer one wins, which reads as a broken trial rather than as a
 * measurement. Both hang steps together are therefore the slow part of a driven
 * round, and `--hang-timeout <ms>` shortens them when that is the trade wanted.
 */
export const HANG_STEP_TIMEOUT_MS = 660_000;

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
  // The directory the `modify-workdir` trial pins, with a file in it so it
  // exists on disk before any trial runs: a `cd` into a directory that is not
  // there would fail for a reason that has nothing to do with the directive.
  [`${MODIFY_TARGET_DIR}/NOTE.md`]: [
    "# Synthetic target directory",
    "",
    "The APRV-415 `modify-workdir` trial pins a hook-supplied workdir HERE. A file",
    "that lands in this directory means Hermes honoured the modify directive; one",
    "that lands in the project root means it ignored it.",
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

/**
 * Build the scratch project, install the hook block, leave the breadcrumb.
 *
 * Everything `setup` and `run` (APRV-418) both do, in one place, so the manual
 * path and the driven path cannot drift into measuring different things. It
 * prints nothing: `setup` follows it with the runbook a human types, and `run`
 * follows it with the matrix nobody types.
 *
 * Returns `{ok:true, ...paths}`, or `{ok:false, reason, block}` when the
 * operator's own configuration already owns one of the keys the block
 * introduces, in which case nothing on disk was touched.
 */
export function prepare(argv) {
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
  if (!applied.ok) return { ok: false, reason: applied.reason, block: applied.block };

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

  return { ok: true, root, project, home, state, ownHome };
}

/** The refusal `prepare` returns, rendered for a terminal. */
function refusedConfigText(refusal) {
  return [
    "",
    "REFUSED TO EDIT THE CONFIG, AND NOTHING ON DISK WAS TOUCHED.",
    `  ${refusal.reason}.`,
    "",
    "YAML permits no duplicate top-level key, so appending this block would",
    "make the whole file unparseable and Hermes would start with NO hooks —",
    "which looks exactly like a probe whose config never fired. Merge the",
    "block below into the existing keys by hand, then re-run with the",
    "same --home to record the scratch project and the prompts:",
    "",
    refusal.block,
  ].join("\n");
}

export function setup(argv, write = process.stdout.write.bind(process.stdout)) {
  const prepared = prepare(argv);
  if (!prepared.ok) {
    process.stderr.write(refusedConfigText(prepared));
    return 2;
  }
  const { root, project, home, state, ownHome } = prepared;

  write(
    [
      "===========================================================================",
      "NEVER RUN THIS PROBE INSIDE A REAL REPOSITORY. The scratch project below",
      "holds only synthetic files this script just wrote, and it is the control.",
      ...(ownHome
        ? [
            "HERMES_HOME is redirected to a scratch directory as well, so your own",
            "home is never read or written.",
          ]
        : [
            "YOUR OWN HERMES_HOME IS IN USE, because you named one with --home: this",
            "run reads and writes that real home. Its config.yaml is backed up once",
            "beside itself and only the region between the probe's markers is ever",
            "rewritten, but nothing about it is redirected — the scratch project is",
            "the whole of the control here.",
          ]),
      "The hook's own path jail is only a backstop, because whether a refusal is",
      "honoured at all is what is under test.",
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
        // The modify trial is asked for through the SHELL and with no directory
        // named, because the answer is WHERE the file lands: the pinned
        // `modify-target/` if the directive was honoured, the project root if it
        // was ignored. Asking for a file "named x" would let a file tool answer
        // it and measure nothing.
        trial === MODIFY_TRIAL
          ? `    run the shell command: touch ${trialArtifact(trial, true)}`
          : `    create a file named ${trialArtifact(trial, true)} containing x`,
      ]),
      `  The ${MODIFY_TRIAL} trial reads differently from the rest: the artifact in`,
      `  ${MODIFY_TARGET_DIR}/ means Hermes HONOURED the hook's workdir, in the project`,
      "  root means it IGNORED it, and in neither means the call never ran.",
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
  // The STEP label (APRV-418). Each driven step is one one-shot Hermes process,
  // so the label is a session boundary written into every envelope the call
  // produces, and the report uses it to tell a model's own retry INSIDE the
  // armed call from a file another step created. A hand-armed trial has no step
  // and the report says so rather than inventing one.
  writeJson(join(state, "control.json"), {
    armed: trial,
    failClosed,
    step: flagValue(argv, "--step"),
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
// run — the driver (APRV-418)
// ---------------------------------------------------------------------------

/**
 * Spawn one child and report every failure as a value.
 *
 * A missing binary, a non-zero exit and a timeout kill are all results here,
 * never exceptions: a driver that threw on step 3 would abandon a round a human
 * had already paid a launch grant for, with seventeen trials unrun and no report.
 */
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
      error: result.error === undefined || result.error === null ? null : String(result.error.message ?? result.error),
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
 * Drive the whole matrix through Hermes's one-shot mode. ONE launch grant.
 *
 * ## The order is the safety property
 *
 * 1. **The version, before anything is written.** Not before the first trial:
 *    before the CONFIG. A build below the floor cannot answer the question this
 *    probe exists for, so refusing early means a refused build never has a hook
 *    block installed in its home and the operator has nothing to undo.
 * 2. **Then the scratch project and the hook block**, through the same
 *    {@link prepare} the manual path uses, so the two cannot measure different
 *    things.
 * 3. **Then the matrix**, one one-shot invocation per step. Each invocation is a
 *    fresh Hermes process, which is what makes the fail-closed PAIR drivable at
 *    all: the config is read at startup, so switching the key between steps
 *    needs no human to quit and relaunch anything. The manual round never got
 *    its control pass for exactly that reason.
 * 4. **Then the report**, read from the capture rather than from this loop's own
 *    memory, because the capture is what a reader can check.
 *
 * ## The early abort
 *
 * If the first step produces NO captured envelope, the driver stops. Twenty
 * further invocations against a wrong one-shot flag spelling, an unregistered
 * hook or a `HERMES_HOME` nothing reads would all fail the same silent way, and
 * the round would read as "the harness ignored everything" when the truth is
 * that nothing ever ran. One wasted invocation is the price; the diagnosis names
 * the three causes and the flag that fixes the first.
 */
export function run(argv, io = {}) {
  const write = io.write ?? process.stdout.write.bind(process.stdout);
  const warn = io.warn ?? process.stderr.write.bind(process.stderr);
  const spawn = io.spawn ?? spawnOnce;
  const now = io.now ?? Date.now;

  const binary = flagValue(argv, "--binary") ?? "hermes";
  const template = flagValue(argv, "--one-shot") ?? ONE_SHOT_TEMPLATE;
  if (oneShotArgv(template, "p", "d") === null) {
    warn(`--one-shot must contain {prompt}; got ${JSON.stringify(template)}\n`);
    return 2;
  }
  const stepTimeout = Number(flagValue(argv, "--step-timeout") ?? STEP_TIMEOUT_MS);
  const hangTimeout = Number(flagValue(argv, "--hang-timeout") ?? HANG_STEP_TIMEOUT_MS);

  // ---- 1. the version, before a single byte is written anywhere -----------
  const probed = spawn(binary, ["--version"], { timeout: VERSION_TIMEOUT_MS, env: process.env });
  const line = probed.error === null ? versionLine(probed.stdout) : null;
  const verdict = floorVerdict(line);
  const allowUnknown = argv.includes("--allow-unknown-version");

  if (verdict === "ignores") {
    warn(
      [
        "",
        "REFUSED: THIS BUILD IS BELOW THE FAIL-CLOSED FLOOR, AND NOTHING WAS WRITTEN.",
        `  ${binary} --version said: ${String(line)}`,
        `  The floor is ${FAIL_CLOSED_FLOOR.statement}.`,
        "",
        "  A build below it ignores `fail_closed` SILENTLY, so every trial in the",
        "  matrix would answer a question about a key this binary does not read.",
        "  That is not a hypothetical: the first Hermes round measured exactly this",
        "  and the whole day's results were wrong for that one reason.",
        "",
        "  `hermes update` fixes it. No config was installed and no scratch project",
        "  was built, so there is nothing to undo.",
        "",
      ].join("\n"),
    );
    return 3;
  }
  if (verdict === "unknown" && !allowUnknown) {
    warn(
      [
        "",
        "REFUSED: THE VERSION COULD NOT BE READ, AND NOTHING WAS WRITTEN.",
        probed.error === null
          ? `  ${binary} --version printed: ${JSON.stringify(tail(probed.stdout, 200))}`
          : `  ${binary} --version could not be run: ${probed.error}`,
        `  The floor is ${FAIL_CLOSED_FLOOR.statement}, and it is compared on the`,
        "  build date and the upstream commit, because the two builds that differ",
        "  on the whole question report the SAME semver.",
        "",
        "  A driver that guessed here would spend a human's launch grant on a round",
        "  whose headline nobody could trust afterwards. If you know this build is",
        "  at or above the floor, say so explicitly:",
        "",
        "    --allow-unknown-version",
        "",
      ].join("\n"),
    );
    return 3;
  }

  // ---- 2. the scratch project and the hook block --------------------------
  const prepared = prepare(argv);
  if (!prepared.ok) {
    warn(refusedConfigText(prepared));
    return 2;
  }
  const { root, project, home, state, ownHome } = prepared;
  writeJson(join(state, "version.json"), {
    binary,
    raw: line,
    verdict,
    floor: FAIL_CLOSED_FLOOR,
    readAt: new Date().toISOString(),
  });

  const steps = matrix();
  write(
    [
      "===========================================================================",
      "APRV-418 DRIVEN PROBE ROUND. One launch grant, no prompt typed by hand.",
      "===========================================================================",
      `  binary:     ${binary}`,
      `  version:    ${String(line)}  (fail_closed: ${verdict.toUpperCase()})`,
      `  one-shot:   ${template}`,
      `  project:    ${project}`,
      ownHome ? `  home:       ${home}   (scratch)` : `  home:       ${home}   (YOURS, --home)`,
      `  captures:   ${state}`,
      `  steps:      ${String(steps.length)}`,
      "",
      "  The gateway pass is NOT driven: a bot cannot message a bot. It is three",
      "  messages a human sends, printed at the end of the report.",
      "",
    ].join("\n"),
  );

  // ---- 3. the matrix ------------------------------------------------------
  // `prepare` wrote the config with the key ON, so the first step that wants it
  // OFF is the first rewrite. Tracking it here rather than re-reading the file
  // keeps a step from paying a write it does not need.
  let configFailClosed = true;
  let aborted = null;
  const runsLog = join(state, "runs.jsonl");

  for (const [index, step] of steps.entries()) {
    if (configFailClosed !== step.failClosed) {
      const applied = applyConfig(state, home, step.failClosed);
      if (!applied.ok) {
        aborted = `the config could not be rewritten for step ${step.id}: ${applied.reason}`;
        break;
      }
      configFailClosed = step.failClosed;
    }
    writeJson(join(state, "control.json"), {
      armed: step.trial,
      failClosed: step.failClosed,
      step: step.id,
      armedAt: new Date().toISOString(),
    });

    const before = capturedCount(state);
    const started = now();
    const result = spawn(binary, oneShotArgv(template, step.prompt, project), {
      timeout: step.hang ? hangTimeout : stepTimeout,
      cwd: project,
      // HERMES_HOME is how the child finds the config this probe just wrote, and
      // HERMES_ACCEPT_HOOKS is the second belt on the silent-skip hazard: with no
      // TTY and no consent, Hermes registers no hook at all and says nothing.
      env: { ...process.env, HERMES_HOME: home, HERMES_ACCEPT_HOOKS: "1" },
    });
    const elapsed = now() - started;
    const captured = capturedCount(state) - before;
    const landed = step.artifact === null ? null : existsSync(join(project, step.artifact));

    const row = {
      at: new Date().toISOString(),
      index: index + 1,
      id: step.id,
      phase: step.phase,
      trial: step.trial,
      failClosed: step.failClosed,
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
      }, ${String(captured)} envelope(s), ${String(Math.round(elapsed / 1000))}s${
        landed === null ? "" : landed ? ", artifact PRESENT" : ", artifact absent"
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
        "  2. the hook never registered. With no TTY and no consent Hermes SKIPS",
        "     hook registration silently; the config carries `hooks_auto_accept:",
        "     true` and the child is given HERMES_ACCEPT_HOOKS=1, so if this is the",
        "     cause the harness has changed its consent story;",
        "  3. the home. The child was given HERMES_HOME=" + home + "; a build that",
        "     reads its configuration from somewhere else would find no hooks there.",
        "",
      ].join("\n"),
    );
  }

  writeJson(join(state, "run.json"), {
    startedAt: new Date().toISOString(),
    binary,
    template,
    version: line,
    verdict,
    steps: steps.length,
    aborted,
  });

  write("\n");
  report(["node", SCRIPT, "report", "--state", state], write);
  write(
    [
      "",
      "=== THE MANUAL PASS THE DRIVER CANNOT DO ===",
      "  A bot cannot message a bot, so the messaging-gateway pass stays human.",
      "  Send exactly these three messages to the gateway, in order, and paste what",
      "  came back:",
      "",
      "    1. run the shell command `ls -la` in your working directory",
      "    2. create a file named gateway-probe.txt containing x",
      "    3. read README.md and tell me its first line",
      "",
      "  Message 1 is the one that matters: a gateway session's envelope `cwd` is",
      "  the user's HOME, which is why `--dir` is mandatory on every gateway entry.",
      "",
      `Delete ${root} when this report is pasted.`,
      "",
    ].join("\n"),
  );
  return aborted === null ? 0 : 4;
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

/**
 * The body and exit code one dialect trial answers with.
 *
 * `project` is needed by {@link MODIFY_TRIAL} alone, which names a directory
 * inside the scratch project; every other trial ignores it. A trial that needs a
 * path and is given none answers with the placeholder rather than with a guess at
 * the operator's filesystem, so a report can say the trial was armed wrong.
 */
export function dialectAnswer(trial, reason, project = null) {
  if (trial === MODIFY_TRIAL) {
    return {
      body: {
        action: "modify",
        args: {
          workdir:
            project === null ? "(no scratch project)" : join(project, MODIFY_TARGET_DIR),
        },
      },
      code: 0,
    };
  }
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
  // The step label SURVIVES the arm being consumed, and that is the whole point
  // of it (APRV-418). One driven step is one one-shot Hermes process, and the
  // interesting calls are the ones the model makes AFTER its armed call was
  // refused: those carry the same label, so the report can say "this file was
  // created by a retry inside the same session" rather than leaving a reader to
  // guess. The next `arm --step` replaces it.
  const step = typeof control.step === "string" ? control.step : null;
  if (state !== null && armed !== "none") {
    // One arm, one call. Consumed BEFORE acting, so a crash or a hang does not
    // leave the trial armed for every later call.
    writeJson(join(state, "control.json"), {
      armed: "none",
      failClosed,
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
          failClosed,
          step,
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

  const dialect = dialectAnswer(armed, `aprv398-probe: armed trial \`${armed}\``, project);
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
   * A LATER call that named this artifact, or `null` (APRV-415).
   *
   * The file-existence heuristic has one hole, and the live run walked straight
   * into it twice: when a refusal lands, the model RETRIES the same effect through
   * another tool or another path, and one of those retries can create the very
   * file whose absence was the measurement. On the 2026-09-21 run the armed crash
   * write was refused and the model then wrote the file under
   * `$HERMES_HOME/cache/scratch`, and the armed garbage write was refused and the
   * model then created the file through `terminal`.
   *
   * So a PRESENT artifact is reported with this caveat attached whenever a call
   * after the armed one named the same path. It does not decide the trial — a
   * retry through `terminal` that the probe ALLOWED is exactly how the file can be
   * present although the armed call was refused — and it tells the reader which
   * envelope to go and look at instead of trusting the file.
   */
  /**
   * APRV-418 sharpens this. A DRIVEN round labels every capture with its step,
   * and one step is one one-shot Hermes process, so the label answers the
   * question the bare timestamp could only raise:
   *
   *   - same step  -> the model retried INSIDE the armed session. This is the
   *     confound, and it is the one that misread the garbage trial;
   *   - later step -> a different process entirely, so the file belongs to
   *     another trial and the armed call is not implicated at all.
   *
   * A hand-armed round carries no step and reads exactly as it did before.
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
    const armedIndex = rows.findIndex(
      (row) => row.armed === trial && row.failClosed === failClosed,
    );
    if (armedIndex === -1) return `${label}: NOT RUN (no captured call was armed this way)`;
    const present = artifactPresent(name);
    const retry = present ? laterCallNaming(name, armedIndex) : null;
    const caveat =
      retry === null
        ? ""
        : `; CAUTION: a later call (${retry}) also named ${name}, so its presence may be a model RETRY rather than the armed call proceeding — read that envelope before concluding`;
    if (blockIsPass) {
      return present
        ? `${label}: FAIL OPEN — ${name} exists, so the effect happened anyway${caveat}`
        : `${label}: FAIL CLOSED — ${name} absent, so Hermes withheld the effect`;
    }
    return present
      ? `${label}: ACCEPTED — ${name} exists, so Hermes honoured this form of allow${caveat}`
      : `${label}: REJECTED — ${name} absent, so this form of allow did not let the call run`;
  };

  /**
   * The modify directive's answer, which is a PLACE rather than a yes or a no.
   *
   * Read from two paths rather than one, because that is what makes the trial
   * single-variable: the pinned directory and the project root. See
   * {@link MODIFY_TRIAL}.
   */
  const modifyLine = () => {
    const name = trialArtifact(MODIFY_TRIAL, true);
    if (project === null) return "  (no scratch project recorded)";
    const ran = rows.some((row) => row.armed === MODIFY_TRIAL);
    if (!ran) return `  NOT RUN — no captured call was armed \`${MODIFY_TRIAL}\`.`;
    const inTarget = existsSync(join(project, MODIFY_TARGET_DIR, name));
    const inRoot = existsSync(join(project, name));
    if (inTarget && !inRoot) {
      return [
        `  HONOURED — ${name} landed in ${MODIFY_TARGET_DIR}/, the directory the hook named.`,
        "  So a hook CAN pin a shell call's workdir, and APRV-415's refusal of a call",
        "  that names none could become a repair the session never sees. Confirm on a",
        "  second run before the adapter relies on it: one observation of a directive",
        "  being honoured is not a contract.",
      ].join("\n");
    }
    if (inRoot && !inTarget) {
      return [
        `  IGNORED — ${name} landed in the project root, not in ${MODIFY_TARGET_DIR}/.`,
        "  The command ran in the session's own recorded directory, so the directive",
        "  changed nothing and the refusal is the only available answer.",
      ].join("\n");
    }
    if (inRoot && inTarget) {
      return `  AMBIGUOUS — ${name} exists in BOTH places; a retry created one of them. Read the envelopes.`;
    }
    return `  NO EFFECT — ${name} is in neither place, so the call did not run at all (a blocked or abandoned call, which is a third answer rather than a failed trial).`;
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

  /**
   * The driven round's own log, when this was a driven round (APRV-418).
   *
   * Absent for a hand-typed round, which is not an error and not a gap: the
   * section simply says the round was driven by hand, and everything below it
   * reads as it always did.
   */
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
    // No run log: a hand-driven round.
  }
  const versionState = readJson(join(state, "version.json"), null);
  const runState = readJson(join(state, "run.json"), null);

  const drivenSection = () => {
    if (runRows.length === 0) {
      return [
        "=== 1b. HOW THIS ROUND WAS RUN ===",
        "  BY HAND. No driver log is present, so each prompt above was typed into",
        "  an interactive session and every one of them was its own",
        "  `harness.launch.hermes`. `node scripts/probes/hermes-hook.mjs run` does",
        "  the same matrix under ONE launch grant (docs/probe-driver-convention.md).",
      ];
    }
    const failed = runRows.filter((row) => row.status !== 0);
    return [
      "=== 1b. THE DRIVEN ROUND (one launch grant, no prompt typed) ===",
      versionState === null
        ? "  version: (not recorded)"
        : `  version read BEFORE the config was written: ${String(versionState.raw)} -> fail_closed ${String(versionState.verdict).toUpperCase()}`,
      runState === null || typeof runState.template !== "string"
        ? ""
        : `  one-shot invocation: ${String(runState.binary)} ${runState.template}`,
      runState !== null && typeof runState.aborted === "string"
        ? `  ABORTED: ${runState.aborted}. Everything below covers only what ran.`
        : "",
      `  ${String(runRows.length)} step(s), ${String(failed.length)} with a non-zero exit:`,
      ...runRows.map((row) => {
        const landed =
          row.landed === null || row.landed === undefined
            ? ""
            : row.landed
              ? ", artifact PRESENT"
              : ", artifact absent";
        return `    ${String(row.index)}. ${String(row.id)} [${String(row.phase)}] exit ${String(row.status)}${
          row.signal === null || row.signal === undefined ? "" : ` (${String(row.signal)})`
        }, ${String(row.captured)} envelope(s), ${String(Math.round(Number(row.ms) / 1000))}s${landed}`;
      }),
      "  A step with ZERO envelopes ran the harness and the hook never fired; a step",
      "  with several is the model retrying after a refusal, and those retries are",
      "  what the CAUTION lines below are reading.",
    ].filter((line) => line !== "");
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
    // The two passes are LABELLED (APRV-415). The finding is the PAIR, and a
    // reader who sees three NOT RUN lines under an unlabelled list cannot tell a
    // pass nobody ran from a trial that went wrong. Pass B is the control: it
    // shows that the key is what caused Pass A's blocks rather than something
    // else in the configuration.
    "  PASS A — fail_closed: true on every entry:",
    ...FAIL_TRIALS.map((trial) => trialLine(trial, true, true)),
    "",
    "  PASS B — fail_closed ABSENT (the control; run `fail-closed off` first).",
    "  NOT RUN here means this pass was not run, which leaves Pass A one-sided:",
    "  it does not mean a trial failed.",
    ...FAIL_TRIALS.map((trial) => trialLine(trial, false, true)),
    "",
    ...drivenSection(),
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
    "  tool_input keys above. On the 2026-09-21 round it was ABSENT — the model",
    "  sent `command` and nothing else — which is why the adapter now REFUSES a",
    "  terminal call with no absolute workdir (APRV-415), and refuses a relative",
    "  or missing path on the file and read tools for the same reason.",
    "",
    "=== 4. TOOL NAMES SEEN ===",
    tools.length === 0 ? "  (none)" : tools.map((tool) => `  ${tool}`).join("\n"),
    "  The 2026-09-21 round saw terminal, write_file, patch, read_file and",
    "  execute_code; search_files is on the adapter's list from the registrations",
    "  and was not exercised. A read tool Hermes sends that the adapter does not",
    "  list is an unscoped read, which is the direction that matters, so a tool",
    "  name here that is new to docs/hermes-hook.md is the line to read twice.",
    "",
    "=== 5. DIALECT TRIALS (which single form of answer does Hermes honour?) ===",
    "  Each printed exactly ONE dialect, except deny-mixed. A deny form that",
    "  FAILS CLOSED here is one the adapter may ship; one that FAILS OPEN must",
    "  never be shipped alone. An allow form that is REJECTED cannot be shipped",
    "  at all under fail_closed, because every allow would become a block.",
    "  A PRESENT artifact carries a CAUTION where a later call named the same path:",
    "  the model's observed answer to a block is to retry the same effect through",
    "  another tool, and a retry can create the file whose absence was the measurement.",
    ...DIALECT_TRIALS.filter((trial) => trial !== MODIFY_TRIAL).map((trial) =>
      trialLine(trial, true, trial.startsWith("deny-")),
    ),
    "",
    "=== 5b. THE MODIFY DIRECTIVE (can a hook PIN the workdir?) ===",
    "  Hermes documents {action:\"modify\", args}. If a hook can rewrite a shell",
    "  call's workdir, the adapter could pin the directory it classified instead of",
    `  refusing a call that names none. The trial pins ${MODIFY_TARGET_DIR}/ and the`,
    "  answer is WHERE the artifact landed, not whether it exists.",
    modifyLine(),
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
    "Reminder: the scratch project held only synthetic files this script wrote.",
    // APRV-415: with `--home` the operator's REAL home was used, so the report
    // must not sign off with a safety property this round did not have.
    setupState.ownHome === false
      ? "Your OWN HERMES_HOME was in use (--home): the block sits between the markers and config.yaml.aprv398-backup holds what was there before."
      : "HERMES_HOME was a scratch directory. Nothing of yours was read.",
    `Delete ${setupState.root ?? "the scratch root"} when this report is pasted.`,
    "",
  ];
  write(lines.join("\n"));
  return 0;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `usage: node scripts/probes/hermes-hook.mjs run
                                            setup
                                            fail-closed on|off
                                            arm <trial>
                                            report

  run          THE DRIVER: version check, scratch project, hook block, the whole
               matrix through hermes's one-shot mode, then the report. One
               harness.launch grant, no prompt typed. Flags:
                 --home <dir>            install into a REAL HERMES_HOME
                 --captures <dir>        put the capture somewhere durable
                 --binary <name>         default hermes
                 --one-shot "<template>" default ${JSON.stringify(ONE_SHOT_TEMPLATE)}
                 --step-timeout <ms>     default ${String(STEP_TIMEOUT_MS)}
                 --hang-timeout <ms>     default ${String(HANG_STEP_TIMEOUT_MS)}
                 --allow-unknown-version proceed on an unreadable version line
               exits 0 ok, 2 usage or a config it refused to edit, 3 below the
               fail-closed floor (nothing written), 4 aborted mid-round
  setup        build the scratch project and scratch HERMES_HOME, write the
               hook config, and print the export line and the prompts
  fail-closed  rewrite the config with or without fail_closed: true
  arm          make the NEXT tool call ${ALL_TRIALS.join(", ")}, or none
  report       print the findings; the FIRST section is the fail-closed answer
  record       the hook entry itself; the config points at it, not you
`;

export function main(argv) {
  // `run` is matched before `setup` and `report` because it does both, and a
  // driven invocation that fell through to `setup` would build a scratch project
  // and then sit there waiting for prompts nobody is going to type.
  if (argv.includes("run")) return run(argv);
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
