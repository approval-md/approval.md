#!/usr/bin/env node
/**
 * A fake `hermes` binary, for `tests/probe-hermes-hook.test.ts` (APRV-418).
 *
 * The driver in `scripts/probes/hermes-hook.mjs` spawns a harness once per trial
 * and reads the effects off the disk. Testing it with a stubbed spawn function
 * would prove the loop calls something; testing it against THIS proves the round
 * it produces is the round a human would get, because this program does the four
 * things the real harness does that the driver depends on:
 *
 *   1. answers `--version`, which the driver reads before it writes anything;
 *   2. READS THE CONFIG THE PROBE JUST WROTE, finds the `pre_tool_call` command
 *      and that entry's `fail_closed`, and so fails if the probe's hand-emitted
 *      YAML ever stops being the shape a reader can find a command in. That file
 *      is the artifact that cost the first Hermes round a day;
 *   3. runs the hook with a tool-call envelope on stdin and applies the verdict
 *      semantics the live probe MEASURED on `main` `118984d7`, including the
 *      fail-closed pair, which is what makes the driven round's headline real;
 *   4. performs the effect when the call was not blocked, so the artifact the
 *      report reads is there (or not) for the right reason.
 *
 * It is NOT a Hermes emulator and must not grow into one. It models the observed
 * behaviour, not the source, and everything it does not model it declares with an
 * environment variable so a test can steer it:
 *
 *   FAKE_HERMES_VERSION         the `--version` line (default: at the floor)
 *   FAKE_HERMES_HOOK_TIMEOUT_MS how long a hook may take (default 1000; the real
 *                               cap is 300s, which no test may wait for)
 *   FAKE_HERMES_INERT           set: do nothing at all and exit 2, which is how a
 *                               wrong one-shot spelling looks from outside
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

const argv = process.argv.slice(2);

const VERSION_DEFAULT = "Hermes Agent v0.21.3 (2026.9.21) · upstream 118984d7ab";

if (argv.includes("--version")) {
  process.stdout.write(`${process.env["FAKE_HERMES_VERSION"] ?? VERSION_DEFAULT}\n`);
  process.exit(0);
}

if (process.env["FAKE_HERMES_INERT"] !== undefined) {
  // A binary that did not understand its arguments: no hook fires, nothing
  // happens, and the driver has to work out why from an empty capture.
  process.stderr.write("fake-hermes: unrecognised invocation\n");
  process.exit(2);
}

const promptIndex = argv.indexOf("-z");
const prompt = promptIndex === -1 ? "" : (argv[promptIndex + 1] ?? "");
const dirIndex = argv.indexOf("--in");
const workdir = dirIndex === -1 ? process.cwd() : (argv[dirIndex + 1] ?? process.cwd());

/** The pre-event hook command and its `fail_closed`, read out of the config. */
function hookEntry(eventKey) {
  const home = process.env["HERMES_HOME"] ?? "";
  let text = "";
  try {
    text = readFileSync(join(home, "config.yaml"), "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^\\s*${eventKey}:\\s*$`, "u").test(line));
  if (start === -1) return null;
  let command = null;
  let failClosed = false;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const entry = /^\s*-\s*command:\s*"(.*)"\s*$/u.exec(line);
    if (entry !== null) {
      if (command !== null) break;
      command = entry[1] ?? null;
      continue;
    }
    if (command === null && /^\s{0,2}\S/u.test(line)) break;
    if (command !== null && /fail_closed:\s*true/u.test(line)) failClosed = true;
    if (command !== null && /^\s*-\s/u.test(line)) break;
  }
  return command === null ? null : { command, failClosed };
}

/** The tool call this prompt asks for, in the shape Hermes's payload builder emits. */
function toolCall() {
  const named = /named\s+(\S+)/u.exec(prompt);
  const target = named === null ? null : join(workdir, String(named[1]));
  if (/^run the shell command/iu.test(prompt)) {
    const quoted = /`([^`]+)`/u.exec(prompt);
    const colon = /run the shell command:\s*(.+)$/iu.exec(prompt);
    const command = quoted?.[1] ?? colon?.[1] ?? "ls";
    return { tool_name: "terminal", tool_input: { command, workdir } };
  }
  if (/^run some python code/iu.test(prompt)) {
    return { tool_name: "execute_code", tool_input: { code: "print(2+2)" } };
  }
  if (/^change the word/iu.test(prompt)) {
    return {
      tool_name: "patch",
      tool_input: { path: join(workdir, "probe.txt"), old_string: "hello", new_string: "goodbye" },
    };
  }
  if (/^read /iu.test(prompt)) {
    return { tool_name: "read_file", tool_input: { path: join(workdir, "README.md") } };
  }
  return {
    tool_name: "write_file",
    tool_input: { path: target ?? join(workdir, "unnamed.txt"), content: "x\n" },
  };
}

/** Do what the tool call said, now that nothing blocked it. */
function performEffect(call) {
  if (call.tool_name === "write_file") {
    const path = String(call.tool_input.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, String(call.tool_input.content ?? ""), "utf8");
    return;
  }
  if (call.tool_name === "terminal") {
    const touched = /^touch\s+(\S+)$/u.exec(String(call.tool_input.command).trim());
    if (touched === null) return;
    const name = String(touched[1]);
    const base = isAbsolute(String(call.tool_input.workdir ?? ""))
      ? String(call.tool_input.workdir)
      : workdir;
    const path = isAbsolute(name) ? name : join(base, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "", "utf8");
  }
}

/** Run one hook command with `envelope` on stdin. */
function fireHook(entry, envelope) {
  const parts = entry.command.split(/\s+/u).filter((part) => part !== "");
  const timeout = Number(process.env["FAKE_HERMES_HOOK_TIMEOUT_MS"] ?? "1000");
  return spawnSync(String(parts[0]), parts.slice(1), {
    input: JSON.stringify(envelope),
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
  });
}

/**
 * The verdict, as the live probe measured it on `main` `118984d7`.
 *
 * The blocking exit code blocks unconditionally; a `block` directive in either
 * dialect blocks; and a hook that crashed, timed out or printed something
 * unparseable blocks IF AND ONLY IF the entry carries `fail_closed: true`. That
 * last clause is the pair the whole probe exists to measure, so the fake has to
 * have it or the driven round proves nothing.
 */
function blocks(result, failClosed) {
  if (result.status === 2) return true;
  const out = String(result.stdout ?? "").trim();
  let parsed = null;
  let unparseable = false;
  if (out !== "") {
    try {
      parsed = JSON.parse(out);
    } catch {
      unparseable = true;
    }
  }
  if (parsed !== null && typeof parsed === "object") {
    if (parsed.action === "block" || parsed.decision === "block") return true;
  }
  const broke =
    unparseable ||
    result.signal !== null ||
    result.error !== undefined ||
    (typeof result.status === "number" && result.status !== 0);
  return broke && failClosed;
}

const call = toolCall();
const pre = hookEntry("pre_tool_call");
const envelope = {
  hook_event_name: "pre_tool_call",
  session_id: "fake-hermes-session",
  cwd: process.cwd(),
  profile: "default",
  ...call,
  extra: { turn_id: "t1", tool_call_id: "c1" },
};

let blocked = false;
if (pre !== null) {
  // With no consent the real harness registers NO hook and says nothing. The
  // driver passes both belts, so a fake that ignored them would hide a
  // regression in the one thing that makes a headless round possible.
  const consented = argv.includes("--accept-hooks") || process.env["HERMES_ACCEPT_HOOKS"] === "1";
  if (consented) blocked = blocks(fireHook(pre, envelope), pre.failClosed);
}

if (!blocked) performEffect(call);

const post = hookEntry("post_tool_call");
if (post !== null) {
  fireHook(post, {
    ...envelope,
    hook_event_name: "post_tool_call",
    result: blocked ? { error: "blocked by hook" } : { exit_code: 0 },
  });
}

process.stdout.write(
  `fake-hermes: ${blocked ? "BLOCKED" : "ran"} ${call.tool_name} for prompt ${JSON.stringify(prompt)}\n`,
);
if (!existsSync(workdir)) process.stderr.write(`fake-hermes: missing --in ${workdir}\n`);
process.exit(0);
