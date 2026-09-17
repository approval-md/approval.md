#!/usr/bin/env node
/**
 * APRV-243 AC1: does an installed Grok Build actually fire the committed
 * `.claude/settings.json` hook entries, what envelope does it send, and what
 * does it do with the Claude-shaped nested output on exit 0?
 *
 * Carter runs this INSIDE a Grok Build session, from the repository root. It
 * is read-only: it writes one file, in a scratch directory it creates under
 * the system temp root, and it reads nothing else. It invokes no model, opens
 * no network connection, touches no credential, and never writes to
 * `.approval/`, `.claude/`, `.grok/` or the working tree.
 *
 * The probe cannot install the hook: a hook file is `policy.core` and a human
 * commits it. What it can do is make the three questions answerable in one
 * pass and print a report that pastes straight into the task.
 *
 *   node scripts/probes/grok-build-hook.mjs --arm
 *       Prints the exact `.claude/settings.json` entry to put in place for the
 *       probe, and the scratch recorder path that entry points at. Writes
 *       nothing that needs approval. Read it, install the entry by hand.
 *
 *   <run any harmless tool call inside the Grok session, e.g. ask it to run
 *    `ls` or to edit a scratch file>
 *
 *   node scripts/probes/grok-build-hook.mjs --report
 *       Reads what the recorder captured and prints the answers.
 *
 * The recorder itself is this same file, invoked as `--record`: it reads the
 * envelope on stdin, appends it verbatim to the capture file, then answers
 * DENY in the Claude nested shape AND exits 0, which is precisely the
 * combination the hazard is about. Whether the command then ran is the
 * question, so the recorder also notes what it was asked about; comparing that
 * against what actually happened in the session is the third answer.
 *
 * Nothing here decides anything. It records.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFileSync as readStdinSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const CAPTURE_DIR = join(tmpdir(), "aprv243-grok-probe");
const CAPTURE = join(CAPTURE_DIR, "envelopes.jsonl");
const NOTES = join(CAPTURE_DIR, "notes.md");

const USAGE = `usage: node scripts/probes/grok-build-hook.mjs --arm | --record | --report

  --arm     print the hook entry to install by hand, and where captures land
  --record  the hook itself: read one envelope on stdin, record it, answer
            deny in the CLAUDE nested shape at exit 0 (the hazard, on purpose)
  --report  print what was captured, as text to paste into APRV-243
`;

function ensureDir() {
  mkdirSync(CAPTURE_DIR, { recursive: true });
}

/**
 * The entry the human installs.
 *
 * Deliberately the CLAUDE-shaped entry, registered in `.claude/settings.json`,
 * because the question is whether Grok Build reads THAT file. It points at
 * this script rather than at `approval hook claude-code` so the probe captures
 * the bytes instead of gating anything: the real adapter would append to the
 * live log, and a probe must not.
 */
function arm() {
  ensureDir();
  const entry = {
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: `node ${SCRIPT} --record`, timeout: 30 }],
        },
      ],
    },
  };
  process.stdout.write(
    [
      "APRV-243 AC1 probe, arm step.",
      "",
      "1. Put this in .claude/settings.json (merge it with what is already there;",
      "   .claude/settings.json is policy.core, so you install it by hand and you",
      "   REMOVE IT AGAIN when the probe is done):",
      "",
      JSON.stringify(entry, null, 2),
      "",
      `2. Captures land in ${CAPTURE}`,
      "   (nothing else is written, and nothing in the repository is touched).",
      "",
      "3. Start a Grok Build session in this repository and give it one harmless",
      "   tool call: ask it to run `ls`, or to write a file under /tmp. Do not",
      "   give it anything with a real side effect; the recorder answers deny at",
      "   exit 0 on purpose, and the whole question is whether that stops it.",
      "",
      "4. Note, by hand, whether the command actually ran. That is the third",
      "   answer and the probe cannot observe it for you.",
      "",
      "5. Run: node scripts/probes/grok-build-hook.mjs --report",
      "",
      "6. Remove the entry from .claude/settings.json.",
      "",
    ].join("\n"),
  );
  return 0;
}

/**
 * The recorder.
 *
 * Answers exactly what `approval hook claude-code` would answer for a deny:
 * the nested Claude envelope on stdout, exit 0. If Grok reads that as an
 * allow, the command runs, and the hazard in docs/grok-hook.md is real. If
 * Grok blocks, the compatibility read understands the Claude shape and the
 * hazard is narrower than feared. Either way the envelope is on disk.
 */
function record() {
  ensureDir();
  let raw = "";
  try {
    raw = readStdinSync(0, "utf8");
  } catch (cause) {
    raw = `<<stdin unreadable: ${String(cause)}>>`;
  }
  appendFileSync(
    CAPTURE,
    `${JSON.stringify({ at: new Date().toISOString(), bytes: raw.length, raw })}\n`,
    "utf8",
  );
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "aprv243-probe: this is a probe, not a gate. It denies in the Claude nested shape at exit 0 on purpose.",
      },
    })}\n`,
  );
  // Exit 0, which is the whole point.
  return 0;
}

function keysOf(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  return Object.keys(value).sort();
}

function report() {
  if (!existsSync(CAPTURE)) {
    process.stdout.write(
      [
        "APRV-243 AC1 probe, report step.",
        "",
        `No captures at ${CAPTURE}.`,
        "",
        "ANSWER 1 (does a Grok session fire .claude/settings.json hook entries?):",
        "  NO, or the entry was not installed. Check that the entry from --arm is",
        "  in .claude/settings.json and that the session was started after it was.",
        "  A confirmed no is a real result and closes AC1 just as well as a yes:",
        "  it means the compatibility hazard in docs/grok-hook.md does not fire,",
        "  and `approval hook grok` is the only way in.",
        "",
      ].join("\n"),
    );
    return 0;
  }

  const lines = readFileSync(CAPTURE, "utf8").split("\n").filter((line) => line.trim() !== "");
  const envelopes = [];
  for (const line of lines) {
    try {
      const outer = JSON.parse(line);
      let inner = null;
      try {
        inner = JSON.parse(outer.raw);
      } catch {
        inner = null;
      }
      envelopes.push({ at: outer.at, bytes: outer.bytes, raw: outer.raw, inner });
    } catch {
      envelopes.push({ at: "<unparseable capture line>", bytes: line.length, raw: line, inner: null });
    }
  }

  const allKeys = new Set();
  for (const envelope of envelopes) for (const key of keysOf(envelope.inner)) allKeys.add(key);
  const camel = [...allKeys].filter((key) => /[a-z][A-Z]/u.test(key));
  const snake = [...allKeys].filter((key) => key.includes("_"));

  process.stdout.write(
    [
      "APRV-243 AC1 probe, report step.",
      "",
      `Captures: ${String(envelopes.length)} at ${CAPTURE}`,
      "",
      "ANSWER 1 (does a Grok session fire .claude/settings.json hook entries?):",
      `  YES. ${String(envelopes.length)} envelope(s) reached the hook entry registered there.`,
      "",
      "ANSWER 2 (what envelope does it send?):",
      `  keys seen: ${[...allKeys].join(", ") || "(none; the payload was not a JSON object)"}`,
      `  camelCase keys: ${camel.join(", ") || "(none)"}`,
      `  snake_case keys: ${snake.join(", ") || "(none)"}`,
      "",
      "  First envelope verbatim:",
      ...envelopes.slice(0, 1).map((envelope) => `    ${envelope.raw}`),
      "",
      "ANSWER 3 (what does it do with a Claude nested deny at exit 0?):",
      "  The recorder answered deny in the nested Claude shape and exited 0 for",
      "  every envelope above. Say here whether the tool call actually ran:",
      "    - if it RAN, the hazard in docs/grok-hook.md is confirmed: a committed",
      "      claude-code entry makes a Grok session look gated while it is not,",
      "      and `approval hook grok` is required rather than optional.",
      "    - if it was BLOCKED, the compatibility read understands the Claude",
      "      shape, and the hazard is narrower. Correct docs/grok-hook.md.",
      "  The probe cannot observe this; only you can.",
      "",
      "Also record: the tool names the envelopes carried, against the list in",
      "docs/grok-hook.md (Bash, Edit, Write, MultiEdit, NotebookEdit). That list",
      "is documentation's guess until this probe corrects it.",
      "",
      "Then: move the register entry in docs/integrations-considered.md from",
      "parked to adopted or declined, and remove the probe entry from",
      ".claude/settings.json.",
      "",
    ].join("\n"),
  );

  writeFileSync(
    NOTES,
    `# APRV-243 probe notes\n\nCaptures: ${String(envelopes.length)}\nKeys: ${[...allKeys].join(", ")}\n`,
    "utf8",
  );
  return 0;
}

const mode = process.argv[2];
switch (mode) {
  case "--arm":
    process.exitCode = arm();
    break;
  case "--record":
    process.exitCode = record();
    break;
  case "--report":
    process.exitCode = report();
    break;
  default:
    process.stderr.write(USAGE);
    process.exitCode = 2;
}
