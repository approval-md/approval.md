#!/usr/bin/env node
/**
 * APRV-350 AC1: what does an installed Meta Muse Code actually send a
 * PreToolUse hook, which config path does it read, and does it fail closed?
 *
 * ===========================================================================
 * READ THIS BEFORE YOU RUN MUSE. A CONTRIBUTOR MODEL SHARES WHAT IT SEES.
 * ===========================================================================
 *
 * A contributor model shares its context, so running one over real code leaks
 * that code. Everything in this script is built around that:
 *
 *   - The scratch project holds ONLY synthetic files this script generates. No
 *     file from this repository, from ~/dev, or from any real project is
 *     copied into it. Never run `muse` for this probe inside a real repository.
 *   - Before typing any prompt, confirm in Muse's model picker that a
 *     contributor model is NOT selected. That is the control.
 *   - The hook below denies every tool call unless the model Muse reports is
 *     one the operator declared safe OUT OF BAND at `--setup`. That is a
 *     backstop, not the control, because A HOOK FIRES AFTER THE PROMPT HAS
 *     ALREADY BEEN SENT. By the time `--record` runs, the model has already
 *     seen the prompt and whatever context the harness attached to it. The
 *     hook can stop the tool read or write that would come next; it cannot
 *     recall what was already sent. That asymmetry is the entire reason the
 *     scratch project contains nothing real.
 *
 * ===========================================================================
 *
 * No agent runs `muse`. Only the operator does, only from the runbook, only in
 * the scratch directory `--setup` prints. This script itself invokes no model,
 * opens no network connection, reads no credential, and writes nothing outside
 * the scratch directory it creates and one small pointer file under the system
 * temp root. It never touches `~/.config/muse`, `~/.muse`, `.approval/` or the
 * working tree.
 *
 *   node scripts/probes/muse-hook.mjs --setup
 *       Builds the scratch project, writes the candidate hook configs INSIDE
 *       it, and prints the warning, the scratch path and the prompts to type.
 *
 *   node scripts/probes/muse-hook.mjs --arm crash|hang|garbage|deny|none
 *       Arms the NEXT tool call to fail in one specific way, through a control
 *       file in the scratch directory, so the operator never edits config.
 *
 *   node scripts/probes/muse-hook.mjs --report
 *       Prints the findings. Line 1 is the model Muse reported.
 *
 * `--record` is the hook entry; the configs point at it. It is not run by hand.
 *
 * Nothing here decides anything for the gate. It records, and it refuses.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);

/** Where `--setup` leaves a breadcrumb so `--report` finds the scratch dir from any cwd. */
export const POINTER = join(tmpdir(), "aprv350-muse-probe-pointer.json");

/** The armed-trial names, in the order the report prints them. */
export const TRIALS = ["crash", "hang", "garbage", "deny"];

/**
 * The file the operator asks Muse to create in each armed trial.
 *
 * Existence of this file in the scratch project after a trial is the whole
 * measurement: the hook refused (or crashed, or hung, or printed garbage) and
 * the write happened ANYWAY, which is fail-open. Absence is fail-closed.
 */
export function trialArtifact(trial) {
  return `${trial}-probe.txt`;
}

/** How long `--arm hang` blocks for, in milliseconds. Well past any sane per-hook timeout. */
const HANG_MS = 120_000;

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Strip token-shaped strings before anything is written to disk.
 *
 * The envelope is recorded verbatim in every other respect, on purpose: the
 * point of the probe is the exact bytes. But an envelope may carry a session
 * token or an auth header, and a probe capture is pasted into a task and a
 * pull request. Raw secrets never appear in a record this project writes
 * (SPEC §11.1), and a scratch capture is no exception.
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
    .replace(/\b(?:EAA|xoxb-|sk-|ghp_|gho_|github_pat_)[A-Za-z0-9._~+/-]{12,}=*/gu, "<redacted>")
    .replace(/\beyJ[A-Za-z0-9._~+/-]{20,}=*/gu, "<redacted-jwt>");
}

// ---------------------------------------------------------------------------
// Model resolution and the contributor-model guard
// ---------------------------------------------------------------------------

/**
 * Meta's own tiering, and the only part of it this script is willing to assert.
 *
 * `dev.meta.ai/docs/models/` names two tiers for the Muse Spark family:
 * a **Contributor** variant, which "trades a lower price for permission to
 * train on your prompts and completions", and a **Standard** variant, where
 * "your data is never used for training". The tier is carried in the model id
 * itself as a `-contributor` suffix.
 *
 * Both lists are Meta-sourced and both are treated as INCOMPLETE. The suffix
 * rule is the load-bearing one: it catches a contributor model Meta ships
 * tomorrow that neither list knows about. The standard list only ever adds
 * permission, so a stale entry there is the dangerous direction — which is why
 * a model that is on neither list denies rather than falling through.
 */
export const KNOWN_CONTRIBUTOR_MODELS = ["muse-spark-1.2-contributor", "muse-spark-1.3-contributor"];
export const KNOWN_STANDARD_MODELS = ["muse-spark-1.2", "muse-spark-1.3"];

/** The suffix Meta uses to mark the contributor tier. Matched before anything else. */
const CONTRIBUTOR_MARK = /contributor/iu;

const MODEL_KEY = /^(?:model|model_?id|model_?name|selected_?model|modelSlug|model_?slug)$/iu;

/**
 * `model_provider` is Meta-documented as a hook payload field (changelog 1.2.1:
 * hook payloads carry "the session's canonical `model_provider`"), but a
 * PROVIDER is not a TIER. Knowing the provider is Meta tells you nothing about
 * whether the selected variant trains on your prompts, so this is recorded and
 * reported separately and is never fed to the guard.
 */
const PROVIDER_KEY = /^(?:model_?provider|provider)$/iu;

/**
 * Find the model the envelope reports, wherever Muse puts it.
 *
 * The key is unknown: the shipped binary carries `"model"` and `"modelProposal"`,
 * and both camelCase and snake_case appear elsewhere in its hook vocabulary, so
 * this walks the whole object rather than guessing one path. The key path is
 * returned alongside the value because naming where the model was found is half
 * of what the report is for.
 */
export function resolveModel(envelope) {
  return findByKey(envelope, MODEL_KEY);
}

/** The provider field Meta documents on hook payloads. Reported, never used to decide. */
export function resolveProvider(envelope) {
  return findByKey(envelope, PROVIDER_KEY);
}

/** Breadth-first-ish walk for the first string value under a key matching `pattern`. */
function findByKey(envelope, pattern, accept = (value) => value.trim() !== "") {
  const found = [];
  const walk = (node, path) => {
    if (found.length > 0) return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${String(index)}]`));
      return;
    }
    if (typeof node !== "object" || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      const here = path === "" ? key : `${path}.${key}`;
      if (pattern.test(key) && typeof value === "string" && accept(value)) {
        found.push({ key: here, value: value.trim() });
        return;
      }
    }
    for (const [key, value] of Object.entries(node)) {
      walk(value, path === "" ? key : `${path}.${key}`);
    }
  };
  walk(envelope, "");
  return found[0] ?? { key: null, value: null };
}

/**
 * The guard. Allow only a model positively recognised as non-contributor.
 *
 * Four outcomes, in this order, and the order is the point:
 *
 *   1. No model in the envelope -> DENY. Nothing can be recognised.
 *   2. The id carries Meta's `contributor` mark -> DENY, loudly and by name.
 *   3. The id is a known Standard model, or one the operator declared out of
 *      band at `--setup` -> allow.
 *   4. Anything else -> DENY. An unknown model is not a safe model.
 *
 * Step 2 runs before step 3 so that an operator declaration can never launder a
 * contributor model: if someone passes `--known-safe-model muse-spark-1.3-
 * contributor`, the suffix still wins and the call is refused. The operator can
 * widen the guard to a model Meta has newly shipped; they cannot switch it off.
 *
 * Step 4 is why there is an allow-list at all. A deny-list would have to be
 * complete to be safe, and no list this repository can build is complete: Meta
 * ships new ids whenever it likes. An allow-list fails the right way, so an
 * unrecognised model, a missing model field, an unparseable envelope and a
 * brand-new model name all land on the same deny.
 *
 * The declaration in step 3 is the operator speaking out of band, in their own
 * terminal, about a model they checked in the picker. It is NOT the envelope's
 * claim about itself: a self-reported field may raise scrutiny, never lower it
 * (SPEC §11.1), so the envelope's model string can only ever fail this check.
 * It passes only by matching something the operator already said independently,
 * which is the operator's authority, not Muse's.
 */
export function classifyModel(model, declaredSafe) {
  if (model === null || model === "") {
    return {
      verdict: "deny",
      reason: "the envelope reported no model, so nothing can be recognised as non-contributor",
    };
  }
  const normalized = model.trim().toLowerCase();

  if (CONTRIBUTOR_MARK.test(normalized)) {
    return {
      verdict: "deny",
      reason: `${model} is a CONTRIBUTOR model: Meta trains on the prompts and completions of this tier. Refused regardless of any --known-safe-model declaration.`,
    };
  }
  if (KNOWN_CONTRIBUTOR_MODELS.includes(normalized)) {
    return { verdict: "deny", reason: `${model} is a known Meta contributor model` };
  }
  if (KNOWN_STANDARD_MODELS.includes(normalized)) {
    return { verdict: "allow", reason: `${model} is a known Meta standard-tier model` };
  }
  if (declaredSafe.map((entry) => entry.trim().toLowerCase()).includes(normalized)) {
    return { verdict: "allow", reason: `the operator declared ${model} safe out of band at --setup` };
  }
  return {
    verdict: "deny",
    reason: `${model} is not recognised as a non-contributor model; unknown is not safe`,
  };
}

// ---------------------------------------------------------------------------
// Scratch project
// ---------------------------------------------------------------------------

/**
 * The synthetic files, and the complete list of what the scratch project holds.
 *
 * Every byte here is written by this function. Nothing is copied from this
 * repository or from anywhere else on the disk, which is the property the
 * contributor-model warning depends on and the property the test asserts.
 */
export const SYNTHETIC_FILES = {
  "README.md": [
    "# Probe Fixture (synthetic)",
    "",
    "This project is fake. Every file in it was generated by",
    "scripts/probes/muse-hook.mjs for the APRV-350 hook probe.",
    "",
    "There is no real source code here and nothing was copied from any",
    "repository. Delete the whole directory when the probe is done.",
    "",
  ].join("\n"),
  "src/widget.js": [
    "// SYNTHETIC DUMMY FILE - not real source, generated by the APRV-350 probe.",
    "export function addDummyNumbers(first, second) {",
    "  return first + second; // placeholder arithmetic, no meaning",
    "}",
    "",
    "export const DUMMY_CONSTANT = 'placeholder-value-0000';",
    "",
  ].join("\n"),
  "notes.txt": [
    "Synthetic scratch notes. Generated, not copied. Nothing real lives here.",
    "",
  ].join("\n"),
};

/**
 * The candidate hook configs, all written INSIDE the scratch project.
 *
 * Three candidates because the shipped build's config path is exactly one of
 * the two unresolved facts in the register entry. `grep -a` over
 * muse-bin-1.3.0-R3233.1 finds `.config/muse/settings.json` (user level, which
 * this probe must not touch), the bare strings `hooks.json` and
 * `hooks/hooks.json`, a `.muse/` project directory, and the keys `"hooks"`,
 * `"event"`, `"events"`, `"command"`, `"type"`, `"run"`, `"when"` and
 * `"timeout"` — but NOT `"matcher"`, which is the key Claude Code's schema
 * turns on. So the entry shape is uncertain too, and each candidate carries a
 * different plausible shape.
 *
 * Each one passes a distinct `--config-id`, so the capture says which file the
 * installed build actually read and which shape it accepted. A candidate that
 * never fires is a finding, not a failure.
 */
export function buildConfigs(statePath) {
  const command = `node ${SCRIPT} --record --state ${statePath}`;
  return [
    {
      id: "project-muse-hooks-json",
      path: join(".muse", "hooks.json"),
      note: "vendor-documented project path, array-of-events shape",
      body: {
        hooks: [
          {
            event: "PreToolUse",
            type: "command",
            command: `${command} --config-id project-muse-hooks-json`,
            timeout: 30,
          },
          {
            event: "PostToolUse",
            type: "command",
            command: `${command} --config-id project-muse-hooks-json-post`,
            timeout: 30,
          },
        ],
      },
    },
    {
      id: "project-muse-settings-json",
      path: join(".muse", "settings.json"),
      note: "settings.json is the name the binary carries; nested event-keyed shape",
      body: {
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: `${command} --config-id project-muse-settings-json`,
                  timeout: 30,
                },
              ],
            },
          ],
        },
      },
    },
    {
      id: "project-muse-hooks-dir",
      path: join(".muse", "hooks", "hooks.json"),
      note: "the hooks/hooks.json string in the binary, events-array shape",
      body: {
        hooks: [
          {
            events: ["PreToolUse"],
            run: `${command} --config-id project-muse-hooks-dir`,
            timeout: 30,
          },
        ],
      },
    },
  ];
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
  const pointer = readJson(POINTER, null);
  if (pointer && typeof pointer.state === "string") return pointer.state;
  return null;
}

function flagValue(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  return typeof value === "string" && !value.startsWith("--") ? value : null;
}

function flagValues(argv, name) {
  const out = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== name) continue;
    const value = argv[index + 1];
    if (typeof value === "string" && !value.startsWith("--")) out.push(value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// --setup
// ---------------------------------------------------------------------------

export function setup(argv, write = process.stdout.write.bind(process.stdout)) {
  const declaredSafe = flagValues(argv, "--known-safe-model");
  const root = mkdtempSync(join(tmpdir(), "aprv350-muse-probe-"));
  const project = join(root, "scratch-project");
  const state = join(root, "state");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });

  for (const [relative, body] of Object.entries(SYNTHETIC_FILES)) {
    const target = join(project, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body, "utf8");
  }

  const configs = buildConfigs(state);
  for (const config of configs) {
    const target = join(project, config.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(config.body, null, 2)}\n`, "utf8");
  }

  writeJson(join(state, "setup.json"), {
    createdAt: new Date().toISOString(),
    root,
    project,
    declaredSafeModels: declaredSafe,
    configs: configs.map((config) => ({ id: config.id, path: config.path, note: config.note })),
    syntheticFiles: Object.keys(SYNTHETIC_FILES),
  });
  writeJson(join(state, "control.json"), { armed: "none" });
  writeJson(POINTER, { state, project, root, createdAt: new Date().toISOString() });

  write(
    [
      "===========================================================================",
      "STOP. CONFIRM IN MUSE'S MODEL PICKER THAT A CONTRIBUTOR MODEL IS NOT",
      "SELECTED BEFORE YOU TYPE ANY PROMPT. A CONTRIBUTOR MODEL SHARES WHAT IT",
      "SEES. NEVER RUN THIS PROBE INSIDE A REAL REPOSITORY.",
      "===========================================================================",
      "",
      "WHERE THE SETTING LIVES (Meta's own docs):",
      "  - user config:  ~/.config/muse/settings.json, key \"model\"",
      "  - per run:      muse --model <id>",
      "  - in session:   /models",
      "  Meta's model tiers are named Contributor and Standard, and the tier is",
      "  carried in the id as a -contributor suffix. Meta says the Contributor",
      "  variant trades a lower price for permission to train on your prompts",
      "  and completions; Standard is documented as never used for training.",
      `  Known Contributor ids: ${KNOWN_CONTRIBUTOR_MODELS.join(", ")}`,
      `  Known Standard ids:    ${KNOWN_STANDARD_MODELS.join(", ")}`,
      "  Both lists are incomplete by construction; the suffix rule is what",
      "  actually protects you, and an unknown id is refused as unsafe.",
      "",
      "  THIS SCRIPT CANNOT PIN THE MODEL FOR YOU. Meta documents no",
      "  project-level model setting, only the global config, the --model flag",
      "  and /models. So the confirmation in the picker is the control, and",
      "  everything below is a backstop.",
      "",
      "SECOND REASON NEVER TO RUN THIS IN A REAL REPOSITORY: Meta's",
      "configuration docs say Muse Code reads a trusted workspace's AGENTS.md,",
      "CLAUDE.md, .agents/AGENTS.md and .claude/CLAUDE.md as agent instructions.",
      "In a real repository those files would be ingested into the session. The",
      "scratch project below deliberately contains none of them.",
      "",
      "The hook this probe installs DENIES every tool call unless the model Muse",
      "reports is positively recognised as non-contributor. That is a backstop,",
      "not the control: a hook fires AFTER the prompt has already been sent, so",
      "it can stop the next read or write but cannot recall what the model",
      "already saw. That is why the scratch project below holds nothing real:",
      "every file in it was generated just now by this script.",
      "",
      declaredSafe.length === 0
        ? "You declared no extra safe models, so the guard allows only the known\nStandard ids above. If your picker shows a newer Standard model, re-run\n--setup with --known-safe-model <exact id>. A -contributor id is refused\neven if you declare it."
        : `Declared safe by you, out of band: ${declaredSafe.join(", ")}\nThese are allowed in addition to the known Standard ids. Any id carrying\nthe -contributor mark is still refused, declaration or not.`,
      "",
      "---------------------------------------------------------------------------",
      `SCRATCH PROJECT: ${project}`,
      "---------------------------------------------------------------------------",
      "",
      `Synthetic files: ${Object.keys(SYNTHETIC_FILES).join(", ")}`,
      "Candidate hook configs written inside the scratch project (the shipped",
      "build's real path is one of the things this probe settles; none of these",
      "is your user config, which the probe never touches):",
      ...configs.map((config) => `  - ${config.path}  (${config.note})`),
      "",
      "---------------------------------------------------------------------------",
      "STEP 1. Start Muse in the scratch project, and nowhere else:",
      "---------------------------------------------------------------------------",
      "",
      `  cd ${project}`,
      "  muse",
      "",
      "Confirm the model picker first. Then type these three prompts, separately:",
      "",
      "  1. list the files here",
      "  2. create a file named probe.txt containing the word hello",
      "  3. read README.md and tell me its first line",
      "",
      "---------------------------------------------------------------------------",
      "STEP 2. The four armed trials. Quit Muse between each one.",
      "---------------------------------------------------------------------------",
      "",
      "Each arms the NEXT tool call to fail one specific way, so the report can",
      "say what Muse does with a hook that breaks. Run the arm command in another",
      "terminal, then start Muse in the scratch project and give it the one",
      "prompt printed with it. The `hang` trial makes Muse wait; let it.",
      "",
      ...TRIALS.flatMap((trial) => [
        `  node ${SCRIPT} --arm ${trial}`,
        `    then in muse, in ${project}:`,
        `    create a file named ${trialArtifact(trial)} containing x`,
        "",
      ]),
      "---------------------------------------------------------------------------",
      "STEP 3. Report:",
      "---------------------------------------------------------------------------",
      "",
      `  node ${SCRIPT} --report`,
      "",
      "Paste the whole report. Its first line is the model Muse reported.",
      "",
      `Delete ${root} when you are done.`,
      "",
    ].join("\n"),
  );
  return 0;
}

// ---------------------------------------------------------------------------
// --arm
// ---------------------------------------------------------------------------

export function arm(argv, write = process.stdout.write.bind(process.stdout)) {
  const trial = argv[argv.indexOf("--arm") + 1];
  if (typeof trial !== "string" || ![...TRIALS, "none"].includes(trial)) {
    process.stderr.write(`--arm takes one of: ${[...TRIALS, "none"].join(", ")}\n`);
    return 2;
  }
  const state = resolveState(argv);
  if (state === null) {
    process.stderr.write("no scratch state found; run --setup first\n");
    return 2;
  }
  writeJson(join(state, "control.json"), { armed: trial, armedAt: new Date().toISOString() });
  write(
    trial === "none"
      ? "Disarmed. The next tool call gets the ordinary contributor-model guard.\n"
      : [
          `Armed: the NEXT tool call will ${trial}.`,
          `In muse, ask for: create a file named ${trialArtifact(trial)} containing x`,
          "The arm is consumed by that one call; later calls behave normally.",
          "",
        ].join("\n"),
  );
  return 0;
}

// ---------------------------------------------------------------------------
// --record (the hook entry)
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
 * The deny payload.
 *
 * A deliberate SUPERSET of every dialect the shipped binary hints at: the
 * nested camelCase shape (`hookSpecificOutput` / `hookEventName` /
 * `permissionDecision` / `permissionDecisionReason`, all present in the
 * binary) and a top-level snake_case `permission_decision` (also present).
 * Emitting both means a deny is honoured whichever key Muse reads, which is the
 * right trade for a guard: the cost is that this probe cannot isolate WHICH key
 * was read, and the report says so rather than implying a cleaner finding than
 * the evidence supports.
 */
export function verdictPayload(decision, reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
    permission_decision: decision,
    permission_decision_reason: reason,
    decision: decision === "deny" ? "block" : "approve",
    reason,
  };
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
  const declaredSafe = Array.isArray(setupState.declaredSafeModels)
    ? setupState.declaredSafeModels
    : [];
  const model = envelope === null ? { key: null, value: null } : resolveModel(envelope);
  const provider = envelope === null ? { key: null, value: null } : resolveProvider(envelope);
  const guard = classifyModel(model.value, declaredSafe);

  const control = state === null ? { armed: "none" } : readJson(join(state, "control.json"), { armed: "none" });
  const armed = typeof control.armed === "string" ? control.armed : "none";
  if (state !== null && armed !== "none") {
    // One arm, one call. Consume it before acting, so a crash or a hang does
    // not leave the trial armed for every later call.
    writeJson(join(state, "control.json"), { armed: "none", consumedAt: new Date().toISOString() });
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
          modelKey: model.key,
          model: model.value,
          providerKey: provider.key,
          provider: provider.value,
          guard: guard.verdict,
          guardReason: guard.reason,
          armed,
          argv: argv.slice(2).map(redact),
          museEnv: Object.fromEntries(
            Object.entries(process.env)
              .filter(([key]) => key.startsWith("MUSE_"))
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

  if (guard.verdict === "deny") {
    warn(
      [
        "",
        "!!! APRV-350 PROBE: CONTRIBUTOR-MODEL GUARD DENIED THIS TOOL CALL !!!",
        `    model reported: ${model.value ?? "(none)"}${model.key === null ? "" : ` (at ${model.key})`}`,
        `    reason: ${guard.reason}`,
        "    A hook fires AFTER the prompt was sent. This stops the tool call,",
        "    it does not recall what the model already saw. If you did not mean",
        "    to run this model, quit Muse now.",
        "",
      ].join("\n"),
    );
  }

  if (armed === "crash") {
    warn("aprv350-probe: armed trial `crash` — exiting non-zero with no output on purpose\n");
    return 1;
  }
  if (armed === "hang") {
    warn("aprv350-probe: armed trial `hang` — blocking past the per-hook timeout on purpose\n");
    sleep();
    return 0;
  }
  if (armed === "garbage") {
    write("aprv350-probe: armed trial `garbage` <<<not json at all>>> {\n");
    return 0;
  }

  const decision = armed === "deny" ? "deny" : guard.verdict;
  const reason =
    armed === "deny"
      ? "aprv350-probe: armed trial `deny` — an explicit, well-formed refusal"
      : `aprv350-probe: ${guard.reason}`;
  write(`${JSON.stringify(verdictPayload(decision, reason))}\n`);
  // Exit 2 on deny as well as the JSON: it is the strongest refusal signal
  // available across dialects, and a guard picks the loudest form of no.
  return decision === "deny" ? 2 : 0;
}

// ---------------------------------------------------------------------------
// --report
// ---------------------------------------------------------------------------

function keysOf(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  return Object.keys(value).sort();
}

const CWD_KEY = /^(?:cwd|working_?directory|workingDir|work_?dir|project_?dir|root|path)$/iu;

/** Walk for a per-call working directory, reporting the key path it was found at. */
export function resolveCwd(envelope) {
  const found = [];
  const walk = (node, path) => {
    if (found.length > 0) return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${String(index)}]`));
      return;
    }
    if (typeof node !== "object" || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      const here = path === "" ? key : `${path}.${key}`;
      if (CWD_KEY.test(key) && typeof value === "string" && value.startsWith("/")) {
        found.push({ key: here, value });
        return;
      }
    }
    for (const [key, value] of Object.entries(node)) {
      walk(value, path === "" ? key : `${path}.${key}`);
    }
  };
  walk(envelope, "");
  return found[0] ?? { key: null, value: null };
}

const TOOL_KEY = /^(?:tool_?name|tool|name)$/iu;

export function resolveTool(envelope) {
  const found = [];
  const walk = (node) => {
    if (found.length > 0) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if (TOOL_KEY.test(key) && typeof value === "string" && value.trim() !== "") {
        found.push(value.trim());
        return;
      }
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(envelope);
  return found[0] ?? null;
}

export function report(argv, write = process.stdout.write.bind(process.stdout)) {
  const state = resolveState(argv);
  if (state === null) {
    write("no scratch state found; run --setup first\n");
    return 2;
  }
  const setupState = readJson(join(state, "setup.json"), {});
  const project = typeof setupState.project === "string" ? setupState.project : null;
  const capture = join(state, "envelopes.jsonl");

  if (!existsSync(capture)) {
    write(
      [
        "MODEL REPORTED: (nothing captured)",
        "",
        "APRV-350 probe report: no envelopes reached the hook.",
        "",
        `Capture file: ${capture}`,
        project === null ? "" : `Scratch project: ${project}`,
        "",
        "That is itself a finding: none of the three candidate config paths",
        "fired for this build, so a committed Muse hooks file is not a usable",
        "interception surface at this version, and the adapter cannot be",
        "enforcement. Check the configs were present before Muse started.",
        "",
        ...(Array.isArray(setupState.configs)
          ? setupState.configs.map((config) => `  - ${config.path} (${config.id})`)
          : []),
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

  const models = [...new Set(rows.map((row) => row.model).filter((value) => typeof value === "string"))];
  const modelKeys = [...new Set(rows.map((row) => row.modelKey).filter((value) => typeof value === "string"))];
  const providers = [...new Set(rows.map((row) => row.provider).filter((value) => typeof value === "string"))];
  const providerKeys = [...new Set(rows.map((row) => row.providerKey).filter((value) => typeof value === "string"))];
  const configIds = [...new Set(rows.map((row) => row.configId).filter(Boolean))];
  const tools = [...new Set(rows.map((row) => resolveTool(row.inner)).filter(Boolean))];
  const cwds = rows.map((row) => resolveCwd(row.inner)).filter((entry) => entry.key !== null);
  const cwdKeys = [...new Set(cwds.map((entry) => entry.key))];

  const allKeys = new Set();
  for (const row of rows) for (const key of keysOf(row.inner)) allKeys.add(key);
  const camel = [...allKeys].filter((key) => /[a-z][A-Z]/u.test(key));
  const snake = [...allKeys].filter((key) => key.includes("_"));

  const pick = (pattern) => rows.find((row) => {
    const tool = resolveTool(row.inner);
    return typeof tool === "string" && pattern.test(tool);
  });
  const shellRow = pick(/bash|shell|exec|run|command|terminal/iu);
  const writeRow = pick(/write|edit|create|apply|patch/iu);
  const readRow = pick(/read|view|cat|open|fetch/iu);

  const artifactPresent = (name) =>
    project !== null && existsSync(join(project, name));

  const denied = rows.filter((row) => row.guard === "deny" || row.armed === "deny").length;
  const baselineWriteHappened = artifactPresent("probe.txt");

  const lines = [
    `MODEL REPORTED: ${models.length === 0 ? "(none found in any envelope)" : models.join(", ")}`,
    models.length === 0
      ? "  No model field was found, so the guard denied every call. If Muse does\n  not report its model id to a hook, the shipped adapter's guard can never\n  allow, and that is the finding: the guard would have to live somewhere a\n  hook payload cannot reach."
      : `  Found at key path: ${modelKeys.join(", ")}\n  Contributor tier: ${models.some((model) => /contributor/iu.test(model)) ? "YES — this session trained on your prompts. Treat the scratch\n  project's contents as shared." : "no -contributor mark on any reported id"}`,
    providers.length === 0
      ? "  model_provider: absent (Meta's changelog says 1.2.1 added it to hook\n  payloads; this build did not send it, or not under that name)"
      : `  model_provider: ${providers.join(", ")} (at ${providerKeys.join(", ")})\n  A provider is not a tier: it cannot tell you whether the variant trains\n  on your prompts, so the guard ignores it.`,
    "",
    "APRV-350 probe report.",
    "",
    `Envelopes captured: ${String(rows.length)}  (${String(denied)} denied by the guard or an armed trial)`,
    `Capture file (full JSON, verbatim, token-redacted): ${capture}`,
    project === null ? "" : `Scratch project: ${project}`,
    "",
    "--- 1. WHICH CONFIG PATH FIRED ---",
    configIds.length === 0
      ? "  none identified"
      : configIds.map((id) => `  ${id}`).join("\n"),
    ...(Array.isArray(setupState.configs)
      ? setupState.configs.map(
          (config) =>
            `    ${configIds.includes(config.id) ? "FIRED" : "silent"}  ${config.path}`,
        )
      : []),
    "",
    "--- 2. ENVELOPE SHAPE ---",
    `  top-level keys seen: ${[...allKeys].join(", ") || "(payload was not a JSON object)"}`,
    `  camelCase keys: ${camel.join(", ") || "(none)"}`,
    `  snake_case keys: ${snake.join(", ") || "(none)"}`,
    "",
    `  one SHELL call: ${shellRow === undefined ? "(none captured)" : keysOf(shellRow.inner).join(", ")}`,
    `  one WRITE call: ${writeRow === undefined ? "(none captured)" : keysOf(writeRow.inner).join(", ")}`,
    `  one READ  call: ${readRow === undefined ? "(none captured)" : keysOf(readRow.inner).join(", ")}`,
    "",
    "--- 3. PER-CALL WORKING DIRECTORY ---",
    cwdKeys.length === 0
      ? "  ABSENT. No absolute-path field was found under any cwd-shaped key.\n  Without a per-call working directory the adapter cannot bind the call to\n  a gate root, so it must ship refuse-early (hook-unsupported-execution-\n  context), exactly as the Codex native hook does."
      : `  PRESENT under: ${cwdKeys.join(", ")}\n  example value: ${cwds[0].value}`,
    "",
    "--- 4. TOOL NAMES SEEN ---",
    tools.length === 0 ? "  (none)" : tools.map((tool) => `  ${tool}`).join("\n"),
    "",
    "--- 5. VERDICT DIALECT ---",
    "  The hook emitted a SUPERSET on every call: the nested camelCase shape",
    "  (hookSpecificOutput/hookEventName/permissionDecision) AND top-level",
    "  permission_decision AND decision/reason, with exit 2 on deny. So a",
    "  honoured deny proves Muse reads ONE of these; it does not say which.",
    "  Narrowing that is a follow-up probe, not a claim this run can make.",
    `  Baseline: the guard denied ${String(denied)} call(s). The write the`,
    `  first three prompts asked for (probe.txt) ${baselineWriteHappened ? "HAPPENED ANYWAY -> the deny was NOT honoured (FAIL OPEN)" : "did NOT happen -> the deny was honoured (FAIL CLOSED)"}.`,
    "",
    "--- 6. ARMED TRIALS (did the tool effect happen anyway?) ---",
    ...TRIALS.map((trial) => {
      const name = trialArtifact(trial);
      if (project === null) return `  ${trial}: (no scratch project recorded)`;
      const ran = rows.some((row) => row.armed === trial);
      if (!ran) return `  ${trial}: NOT RUN (no captured call was armed ${trial})`;
      return artifactPresent(name)
        ? `  ${trial}: FAIL OPEN — ${name} exists, so the write happened despite the hook ${trial}ing`
        : `  ${trial}: FAIL CLOSED — ${name} absent, so Muse withheld the write`;
    }),
    "",
    "--- 7. FIRST ENVELOPE, VERBATIM ---",
    ...rows.slice(0, 1).map((row) => `  ${row.raw}`),
    "",
    "Reminder: the scratch project held only synthetic files this script wrote.",
    `Delete ${setupState.root ?? "the scratch root"} when this report is pasted.`,
    "",
  ];
  write(lines.join("\n"));
  return 0;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `usage: node scripts/probes/muse-hook.mjs --setup [--known-safe-model <id>]...
                                          --arm crash|hang|garbage|deny|none
                                          --report

  --setup   build the scratch project (synthetic files only) and print the
            contributor-model warning, the scratch path and the prompts
  --arm     make the NEXT tool call crash, hang, print garbage, or deny
  --report  print the findings; line 1 is the model Muse reported
  --record  the hook entry itself; the configs point at it, not you
`;

export function main(argv) {
  if (argv.includes("--setup")) return setup(argv);
  if (argv.includes("--arm")) return arm(argv);
  if (argv.includes("--record")) return record(argv);
  if (argv.includes("--report")) return report(argv);
  process.stderr.write(USAGE);
  return 2;
}

if (process.argv[1] === SCRIPT) {
  process.exitCode = main(process.argv);
}
