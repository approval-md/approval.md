#!/usr/bin/env node
/**
 * A fake `grok` binary, for `tests/probe-grok-build-hook.test.ts` (APRV-418).
 *
 * The driver in `scripts/probes/grok-build-hook.mjs` spawns a harness once per
 * trial and reads the effects off the disk. This program is what makes that
 * loop testable without an install, and it does the four things the driver
 * depends on:
 *
 *   1. answers `--version`, which the driver reads before it writes anything;
 *   2. READS BOTH REGISTRATION FILES the probe just wrote, in the project
 *      directory, and fires each one it finds. That is the whole question of
 *      APRV-243 AC1, so a fake that hard-coded one of them would prove nothing;
 *   3. applies this harness's DOCUMENTED verdict semantics, including the
 *      fail-open cases;
 *   4. performs the effect when nothing blocked it.
 *
 * ## What it models, and the honest label on it
 *
 * Hermes's fake models a MEASURED harness. This one models a DOCUMENTED one:
 * nothing in this repository has ever run Grok Build, which is exactly why
 * APRV-243 AC1 is still open and stays Carter's. So the semantics below are the
 * vendor's documentation as `docs/grok-hook.md` records it, and they are the
 * thing the live round is meant to CHECK rather than evidence about it:
 *
 *   - deny on exit 2, or on `{"decision":"deny"}` in stdout;
 *   - the nested Claude shape is not understood, so a deny in it at exit 0 is
 *     read as an allow — the hazard;
 *   - a hook that crashes, times out or prints unparseable output FAILS OPEN,
 *     with no setting to change it.
 *
 * `FAKE_GROK_VERSION`, `FAKE_GROK_HOOK_TIMEOUT_MS`, `FAKE_GROK_INERT` and
 * `FAKE_GROK_IGNORE_CLAUDE_SETTINGS` let a test steer each of those.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

const argv = process.argv.slice(2);

if (argv.includes("--version")) {
  process.stdout.write(`${process.env["FAKE_GROK_VERSION"] ?? "grok 0.9.0 (fake)"}\n`);
  process.exit(0);
}

if (process.env["FAKE_GROK_INERT"] !== undefined) {
  process.stderr.write("fake-grok: unrecognised invocation\n");
  process.exit(2);
}

const promptIndex = argv.indexOf("-p");
const prompt = promptIndex === -1 ? "" : (argv[promptIndex + 1] ?? "");
const dirIndex = argv.indexOf("--cwd");
const project = dirIndex === -1 ? process.cwd() : (argv[dirIndex + 1] ?? process.cwd());

/** Every hook command registered in the project, in the order this harness reads. */
function registeredCommands() {
  const commands = [];
  // The NATIVE file first, then the Claude compatibility read, which is the
  // order the vendor documentation implies and the order that makes the
  // `--config-id`s in the capture readable.
  try {
    const native = JSON.parse(
      readFileSync(join(project, ".grok", "hooks", "pre-tool-use.json"), "utf8"),
    );
    for (const entry of native.hooks ?? []) {
      if (typeof entry.command === "string") commands.push(entry.command);
    }
  } catch {
    // Not registered.
  }
  if (process.env["FAKE_GROK_IGNORE_CLAUDE_SETTINGS"] === undefined) {
    try {
      const settings = JSON.parse(readFileSync(join(project, ".claude", "settings.json"), "utf8"));
      for (const matcher of settings.hooks?.PreToolUse ?? []) {
        for (const entry of matcher.hooks ?? []) {
          if (typeof entry.command === "string") commands.push(entry.command);
        }
      }
    } catch {
      // Not registered.
    }
  }
  return commands;
}

/** The tool call this prompt asks for, in this harness's camelCase envelope. */
function toolCall() {
  const named = /named\s+(\S+)/u.exec(prompt);
  return {
    toolName: "Write",
    toolInput: {
      filePath: join(project, named === null ? "unnamed.txt" : String(named[1])),
      content: "x\n",
    },
  };
}

function performEffect(call) {
  const path = String(call.toolInput.filePath);
  const target = isAbsolute(path) ? path : join(project, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, String(call.toolInput.content ?? ""), "utf8");
}

function fireHook(command, envelope) {
  const parts = command.split(/\s+/u).filter((part) => part !== "");
  const timeout = Number(process.env["FAKE_GROK_HOOK_TIMEOUT_MS"] ?? "1000");
  return spawnSync(String(parts[0]), parts.slice(1), {
    input: JSON.stringify(envelope),
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
  });
}

/**
 * The verdict, as this harness's documentation states it.
 *
 * Exit 2 denies. A `{"decision":"deny"}` body denies. EVERYTHING ELSE ALLOWS,
 * including a hook that crashed, was killed or printed something unparseable:
 * there is no `fail_closed` of any kind here, which is the sentence
 * `docs/grok-hook.md` opens with.
 */
function blocks(result) {
  if (result.status === 2) return true;
  const out = String(result.stdout ?? "").trim();
  if (out === "") return false;
  try {
    const parsed = JSON.parse(out);
    return typeof parsed === "object" && parsed !== null && parsed.decision === "deny";
  } catch {
    return false;
  }
}

const call = toolCall();
const envelope = {
  hookEventName: "PreToolUse",
  sessionId: "fake-grok-session",
  cwd: project,
  workspaceRoot: project,
  toolUseId: "u1",
  ...call,
};

let blocked = false;
for (const command of registeredCommands()) {
  if (blocks(fireHook(command, envelope))) blocked = true;
}

if (!blocked) performEffect(call);

process.stdout.write(
  `fake-grok: ${blocked ? "BLOCKED" : "ran"} ${call.toolName} for prompt ${JSON.stringify(prompt)}\n`,
);
process.exit(0);
