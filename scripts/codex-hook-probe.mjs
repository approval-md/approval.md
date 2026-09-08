#!/usr/bin/env node
/**
 * APRV-310: bounded, scratch-only compatibility probe for native Codex hooks.
 *
 * Unit tests import the pure sanitizer. A live Codex call is never made by this
 * script: `prepare` writes an isolated project and `verify` checks its evidence.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const MAX_STDIN_BYTES = 256 * 1024;
const PATCH_COMMAND = [
  "*** Begin Patch",
  "*** Add File: patch-allowed.txt",
  "+patch # codex-hook-probe:patch",
  "*** End Patch",
].join("\n");
const commands = {
  allow: "printf 'allow\\n' > shell-allow.txt # codex-hook-probe:allow",
  deny: "printf 'denied\\n' > shell-denied.txt # codex-hook-probe:deny",
  crash: "printf 'crash\\n' > shell-crash.txt # codex-hook-probe:crash",
  timeout: "printf 'timeout\\n' > shell-timeout.txt # codex-hook-probe:timeout",
  malformed: "printf 'malformed\\n' > shell-malformed.txt # codex-hook-probe:malformed",
  success: "printf 'success\\n' > shell-success.txt # codex-hook-probe:success",
  nonzero: "printf 'nonzero\\n' > shell-nonzero.txt; exit 7 # codex-hook-probe:nonzero",
};
const CONTROLLED_STRINGS = new Set([
  ...Object.values(commands),
  PATCH_COMMAND,
  "allow",
  "allow\n",
  "denied",
  "denied\n",
  "crash",
  "crash\n",
  "timeout",
  "timeout\n",
  "malformed",
  "malformed\n",
  "success",
  "success\n",
  "nonzero",
  "nonzero\n",
  "patch",
  "patch\n",
]);

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write("usage: codex-hook-probe.mjs prepare|verify --out <absolute scratch directory>\n");
  process.exitCode = 2;
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] ?? null;
}

function assertScratch(path) {
  if (!path || !isAbsolute(path)) throw new Error("--out must be an absolute path");
  const absolute = resolve(path);
  const temporaryRoots = [...new Set([resolve(tmpdir()), resolve("/private/tmp"), resolve("/tmp")])];
  if (!temporaryRoots.some((temporary) => absolute !== temporary && absolute.startsWith(`${temporary}${sep}`))) {
    throw new Error(`--out must be below a temporary root (${temporaryRoots.join(", ")})`);
  }
  return absolute;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function scenarioForEvent(event) {
  const command = event?.tool_input?.command;
  if (typeof command !== "string") return "unknown";
  for (const [scenario, expected] of Object.entries(commands)) {
    if (command === expected) return scenario;
  }
  if (command === PATCH_COMMAND || command === `${PATCH_COMMAND}\n`) return "patch";
  return "unknown";
}

function normalizedString(value, scratchRoot) {
  let normalized = scratchRoot ? value.replaceAll(scratchRoot, "<scratch>") : value;
  if (normalized.length > 4_096) normalized = `${normalized.slice(0, 4_096)}<truncated>`;
  if (CONTROLLED_STRINGS.has(normalized) || CONTROLLED_STRINGS.has(value)) return normalized;
  return "<redacted-string>";
}

function sanitizeValue(value, scratchRoot, depth = 0) {
  if (depth > 8) return "<max-depth>";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return normalizedString(value, scratchRoot);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeValue(item, scratchRoot, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([key, item]) => [key, sanitizeValue(item, scratchRoot, depth + 1)]),
    );
  }
  return `<${typeof value}>`;
}

function valueType(object, key) {
  if (!Object.hasOwn(object, key)) return "missing";
  const value = object[key];
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

function sanitizeResponse(value, scratchRoot) {
  if (typeof value !== "string") return sanitizeValue(value, scratchRoot);
  const exact = normalizedString(value, scratchRoot);
  if (exact !== "<redacted-string>") return exact;
  const controlled_results = [...CONTROLLED_STRINGS]
    .filter((candidate) => !candidate.includes("codex-hook-probe:") && candidate.trim().length > 0)
    .map((candidate) => candidate.trim())
    .filter((candidate, index, all) => all.indexOf(candidate) === index)
    .filter((candidate) => value.split(/\r?\n/u).includes(candidate));
  return {
    redacted: "<redacted-string>",
    length: value.length,
    line_count: value.split(/\r?\n/u).length,
    controlled_result_lines: controlled_results,
  };
}

/** Remove transcript paths, real identifiers, model names, and arbitrary text. */
export function sanitizeEvent(event, scratchRoot = null) {
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("hook input must be a JSON object");
  const command = event?.tool_input?.command;
  const rawToolInput = event.tool_input && typeof event.tool_input === "object" && !Array.isArray(event.tool_input)
    ? event.tool_input
    : null;
  const toolInput =
    (event.tool_name === "Bash" || event.tool_name === "apply_patch") && typeof command === "string"
      ? { command: normalizedString(command, scratchRoot) }
      : sanitizeValue(event.tool_input ?? null, scratchRoot);
  const sanitized = {
    hook_event_name: typeof event.hook_event_name === "string" ? event.hook_event_name : "<missing>",
    session_id: "<session>",
    turn_id: "<turn>",
    tool_name: typeof event.tool_name === "string" ? event.tool_name : "<missing>",
    tool_use_id: "<tool-use>",
    cwd: "<scratch>",
    cwd_matches_scratch:
      scratchRoot && typeof event.cwd === "string" ? resolve(event.cwd) === resolve(scratchRoot) : null,
    common_field_types: Object.fromEntries(
      ["session_id", "transcript_path", "cwd", "model", "turn_id", "tool_name", "tool_use_id"]
        .map((key) => [key, valueType(event, key)]),
    ),
    tool_input_keys: rawToolInput ? Object.keys(rawToolInput).sort() : [],
    tool_input_workdir_type: rawToolInput ? valueType(rawToolInput, "workdir") : "missing",
    tool_input_workdir_matches_scratch:
      scratchRoot && rawToolInput && typeof rawToolInput.workdir === "string"
        ? resolve(rawToolInput.workdir) === resolve(scratchRoot)
        : null,
    scenario: scenarioForEvent(event),
    tool_input: toolInput,
  };
  if (Object.hasOwn(event, "tool_response")) {
    sanitized.tool_response_type = Array.isArray(event.tool_response)
      ? "array"
      : event.tool_response === null
        ? "null"
        : typeof event.tool_response;
    sanitized.tool_response = sanitizeResponse(event.tool_response, scratchRoot);
  }
  return sanitized;
}

async function readStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_STDIN_BYTES) throw new Error(`hook input exceeds ${MAX_STDIN_BYTES} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function hook(args) {
  const log = option(args, "--log");
  const scratch = option(args, "--scratch");
  if (!log || !scratch) throw new Error("hook requires --log and --scratch");
  const event = JSON.parse(await readStdin());
  const sanitized = sanitizeEvent(event, scratch);
  appendFileSync(log, `${JSON.stringify(sanitized)}\n`, { encoding: "utf8", mode: 0o600 });

  if (event.hook_event_name !== "PreToolUse") return;
  switch (sanitized.scenario) {
    case "unknown":
      process.stdout.write(`${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Outside the exact APRV-310 scratch probe command set.",
        },
      })}\n`);
      return;
    case "deny":
      process.stdout.write(`${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Denied by APRV-310 scratch probe.",
        },
      })}\n`);
      return;
    case "crash":
      process.stderr.write("APRV-310 intentional hook crash\n");
      process.exitCode = 1;
      return;
    case "timeout":
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
      return;
    case "malformed":
      process.stdout.write("{malformed-hook-output\n");
      return;
    default:
      process.stdout.write(`${JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
      })}\n`);
  }
}

function prepare(args) {
  const out = assertScratch(option(args, "--out"));
  if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`refusing non-empty --out: ${out}`);
  mkdirSync(out, { recursive: true });
  const log = join(out, "native-events.sanitized.jsonl");
  const hookCommand = [process.execPath, SCRIPT, "hook", "--log", log, "--scratch", out].map(shellQuote).join(" ");
  const handler = { type: "command", command: hookCommand, timeout: 1, statusMessage: "Running APRV-310 scratch probe" };
  writeFileSync(
    join(out, "hooks.example.json"),
    `${JSON.stringify({ hooks: {
      PreToolUse: [{ matcher: "Bash|apply_patch|Edit|Write", hooks: [handler] }],
      PostToolUse: [{ matcher: "Bash|apply_patch|Edit|Write", hooks: [handler] }],
    } }, null, 2)}\n`,
    "utf8",
  );
  const prompt = [
    "This is a bounded native Codex hook compatibility probe in an isolated scratch directory.",
    "Run exactly the seven shell commands below in order, each as its own Bash/exec_command tool call.",
    ...Object.values(commands).map((command, index) => `${index + 1}. ${command}`),
    "Then use apply_patch once with this exact patch:",
    PATCH_COMMAND,
    "Do not read files, use network tools, call subagents, retry denied calls, or perform any other tool call. Stop after reporting which calls Codex presented as allowed, denied, or failed.",
    "",
  ].join("\n");
  writeFileSync(join(out, "prompt.txt"), prompt, "utf8");
  writeFileSync(join(out, ".gitignore"), "native-events.sanitized.jsonl\nshell-*.txt\npatch-allowed.txt\n", "utf8");
  const matcher = "Bash|apply_patch|Edit|Write";
  const inlineHandler = `{type="command",command=${JSON.stringify(hookCommand)},timeout=1,statusMessage="Running APRV-310 scratch probe"}`;
  const codexArgv = [
    "codex", "exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check",
    "--approve-for-me",
    "-c", "features.hooks=true",
    "-c", `hooks.PreToolUse=[{matcher=${JSON.stringify(matcher)},hooks=[${inlineHandler}]}]`,
    "-c", `hooks.PostToolUse=[{matcher=${JSON.stringify(matcher)},hooks=[${inlineHandler}]}]`,
    "-C", out, "-",
  ];
  process.stdout.write(`${JSON.stringify({
    out,
    hooks_example: join(out, "hooks.example.json"),
    prompt: join(out, "prompt.txt"),
    log,
    codex_argv: codexArgv,
    prompt_via_stdin: true,
  }, null, 2)}\n`);
}

function verify(args) {
  const out = assertScratch(option(args, "--out"));
  const log = join(out, "native-events.sanitized.jsonl");
  const events = existsSync(log)
    ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const has = (eventName, scenario) => events.some((event) => event.hook_event_name === eventName && event.scenario === scenario);
  const checks = {
    pre_allow: has("PreToolUse", "allow"),
    allow_effect_present: existsSync(join(out, "shell-allow.txt")),
    denied_effect_absent: !existsSync(join(out, "shell-denied.txt")),
    pre_deny: has("PreToolUse", "deny"),
    pre_crash: has("PreToolUse", "crash"),
    pre_timeout: has("PreToolUse", "timeout"),
    pre_malformed: has("PreToolUse", "malformed"),
    post_success: has("PostToolUse", "success"),
    post_nonzero: has("PostToolUse", "nonzero"),
    pre_patch: has("PreToolUse", "patch"),
    post_patch: has("PostToolUse", "patch"),
    patch_effect_present: existsSync(join(out, "patch-allowed.txt")),
  };
  const observed_failure_behavior = {
    crash_effect_present: existsSync(join(out, "shell-crash.txt")),
    crash_post_observed: has("PostToolUse", "crash"),
    timeout_effect_present: existsSync(join(out, "shell-timeout.txt")),
    timeout_post_observed: has("PostToolUse", "timeout"),
    malformed_effect_present: existsSync(join(out, "shell-malformed.txt")),
    malformed_post_observed: has("PostToolUse", "malformed"),
  };
  const ok = Object.values(checks).every(Boolean);
  process.stdout.write(`${JSON.stringify({ ok, event_count: events.length, checks, observed_failure_behavior }, null, 2)}\n`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  try {
    if (mode === "hook") await hook(args);
    else if (mode === "prepare") prepare(args);
    else if (mode === "verify") verify(args);
    else usage(mode ? `unknown mode: ${mode}` : null);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
