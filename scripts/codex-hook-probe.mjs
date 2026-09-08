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
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const MAX_STDIN_BYTES = 256 * 1024;
const PATCH_ALLOW_COMMAND = [
  "*** Begin Patch",
  "*** Add File: patch-allowed.txt",
  "+patch # codex-hook-probe:patch",
  "*** End Patch",
].join("\n");
const PATCH_DENY_COMMAND = [
  "*** Begin Patch",
  "*** Add File: patch-denied.txt",
  "+denied patch # codex-hook-probe:patch-deny",
  "*** End Patch",
].join("\n");
const PATCH_WORKDIR_BODY = [
  "*** Begin Patch",
  "*** Add File: patch-workdir.txt",
  "+patch workdir # codex-hook-probe:patch-workdir",
  "*** End Patch",
].join("\n");
const PATCH_WORKDIR_HEREDOC = [
  "apply_patch <<'PATCH'",
  PATCH_WORKDIR_BODY,
  "PATCH",
].join("\n");
const commands = {
  allow: "printf 'allow\\n' > shell-allow.txt # codex-hook-probe:allow",
  deny: "printf 'denied\\n' > shell-denied.txt # codex-hook-probe:deny",
  crash: "printf 'crash\\n' > shell-crash.txt # codex-hook-probe:crash",
  timeout: "printf 'timeout\\n' > shell-timeout.txt # codex-hook-probe:timeout",
  malformed: "printf 'malformed\\n' > shell-malformed.txt # codex-hook-probe:malformed",
  success: "printf 'success\\n' > shell-success.txt # codex-hook-probe:success",
  nonzero: "printf 'nonzero\\n' > shell-nonzero.txt; exit 7 # codex-hook-probe:nonzero",
  nested: "printf 'nested\\n' > nested-workdir.txt # codex-hook-probe:nested",
};
const CONTROLLED_STRINGS = new Set([
  ...Object.values(commands),
  PATCH_ALLOW_COMMAND,
  PATCH_DENY_COMMAND,
  PATCH_WORKDIR_BODY,
  PATCH_WORKDIR_HEREDOC,
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
  "nested",
  "nested\n",
]);

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write("usage: codex-hook-probe.mjs prepare|verify --out <absolute scratch directory> [--focus patch-workdir]\n");
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
  if (command === PATCH_ALLOW_COMMAND || command === `${PATCH_ALLOW_COMMAND}\n`) return "patch-allow";
  if (command === PATCH_DENY_COMMAND || command === `${PATCH_DENY_COMMAND}\n`) return "patch-deny";
  if (
    command === PATCH_WORKDIR_BODY ||
    command === `${PATCH_WORKDIR_BODY}\n` ||
    command === PATCH_WORKDIR_HEREDOC ||
    command === `${PATCH_WORKDIR_HEREDOC}\n`
  ) return "patch-workdir";
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

function stableReference(kind, value) {
  if (typeof value !== "string") return `<${kind}:missing>`;
  const digest = createHash("sha256")
    .update(`approval.md/codex-hook-probe/${kind}/v1\0`, "utf8")
    .update(value, "utf8")
    .digest("hex")
    .slice(0, 24);
  return `<${kind}:${digest}>`;
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
export function sanitizeEvent(event, scratchRoot = null, hookProcessCwd = null) {
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
    session_id: stableReference("session", event.session_id),
    turn_id: stableReference("turn", event.turn_id),
    tool_name: typeof event.tool_name === "string" ? event.tool_name : "<missing>",
    tool_use_id: stableReference("tool-use", event.tool_use_id),
    cwd: "<scratch>",
    cwd_matches_scratch:
      scratchRoot && typeof event.cwd === "string" ? resolve(event.cwd) === resolve(scratchRoot) : null,
    cwd_matches_nested:
      scratchRoot && typeof event.cwd === "string"
        ? resolve(event.cwd) === resolve(scratchRoot, "nested-cwd")
        : null,
    cwd_matches_hook_process:
      hookProcessCwd && typeof event.cwd === "string"
        ? resolve(event.cwd) === resolve(hookProcessCwd)
        : null,
    hook_process_cwd_matches_scratch:
      scratchRoot && hookProcessCwd ? resolve(hookProcessCwd) === resolve(scratchRoot) : null,
    hook_process_cwd_matches_nested:
      scratchRoot && hookProcessCwd
        ? resolve(hookProcessCwd) === resolve(scratchRoot, "nested-cwd")
        : null,
    top_level_field_types: Object.fromEntries(
      Object.keys(event).sort().slice(0, 100).map((key) => [key, valueType(event, key)]),
    ),
    common_field_types: Object.fromEntries(
      ["session_id", "transcript_path", "cwd", "model", "turn_id", "tool_name", "tool_use_id"]
        .map((key) => [key, valueType(event, key)]),
    ),
    tool_input_keys: rawToolInput ? Object.keys(rawToolInput).sort() : [],
    tool_input_cwd_type: rawToolInput ? valueType(rawToolInput, "cwd") : "missing",
    tool_input_cwd_matches_scratch:
      scratchRoot && rawToolInput && typeof rawToolInput.cwd === "string"
        ? resolve(rawToolInput.cwd) === resolve(scratchRoot)
        : null,
    tool_input_cwd_matches_nested:
      scratchRoot && rawToolInput && typeof rawToolInput.cwd === "string"
        ? resolve(rawToolInput.cwd) === resolve(scratchRoot, "nested-cwd")
        : null,
    tool_input_workdir_type: rawToolInput ? valueType(rawToolInput, "workdir") : "missing",
    tool_input_workdir_matches_scratch:
      scratchRoot && rawToolInput && typeof rawToolInput.workdir === "string"
        ? resolve(rawToolInput.workdir) === resolve(scratchRoot)
        : null,
    tool_input_workdir_matches_nested:
      scratchRoot && rawToolInput && typeof rawToolInput.workdir === "string"
        ? resolve(rawToolInput.workdir) === resolve(scratchRoot, "nested-cwd")
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
  const sanitized = sanitizeEvent(event, scratch, process.cwd());
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
    case "patch-deny":
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
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: { command: event.tool_input.command },
        },
      })}\n`);
  }
}

function prepare(args) {
  const out = assertScratch(option(args, "--out"));
  const focus = option(args, "--focus");
  if (focus !== null && focus !== "patch-workdir") throw new Error(`unsupported --focus: ${focus}`);
  if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`refusing non-empty --out: ${out}`);
  mkdirSync(out, { recursive: true });
  mkdirSync(join(out, "nested-cwd"));
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
  const prompt = focus === "patch-workdir"
    ? [
        "This is a one-call native Codex patch working-directory probe in an isolated scratch directory.",
        `Run exactly one exec_command tool call with workdir exactly ${join(out, "nested-cwd")} and command exactly:`,
        PATCH_WORKDIR_HEREDOC,
        "Do not read files, use network tools, call subagents, retry, or perform any other tool call. Stop after reporting the tool call result.",
        "",
      ].join("\n")
    : [
        "This is a bounded native Codex hook compatibility probe in an isolated scratch directory.",
        "Run exactly the eight shell commands below in order, each as its own Bash/exec_command tool call.",
        ...Object.entries(commands).map(([scenario, command], index) =>
          scenario === "nested"
            ? `${index + 1}. ${command} (set this tool call's workdir to exactly ${join(out, "nested-cwd")})`
            : `${index + 1}. ${command}`),
        "Then use apply_patch once with this exact allowed patch:",
        PATCH_ALLOW_COMMAND,
        "Then use apply_patch once with this exact denied patch:",
        PATCH_DENY_COMMAND,
        "Do not read files, use network tools, call subagents, retry denied calls, or perform any other tool call. Stop after reporting which calls Codex presented as allowed, denied, or failed.",
        "",
      ].join("\n");
  writeFileSync(join(out, "prompt.txt"), prompt, "utf8");
  writeFileSync(join(out, ".gitignore"), "native-events.sanitized.jsonl\nshell-*.txt\npatch-allowed.txt\npatch-denied.txt\npatch-workdir.txt\nnested-cwd/nested-workdir.txt\nnested-cwd/patch-workdir.txt\n", "utf8");
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
    focus,
  }, null, 2)}\n`);
}

function verify(args) {
  const out = assertScratch(option(args, "--out"));
  const focus = option(args, "--focus");
  if (focus !== null && focus !== "patch-workdir") throw new Error(`unsupported --focus: ${focus}`);
  const log = join(out, "native-events.sanitized.jsonl");
  const events = existsSync(log)
    ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const matching = (eventName, scenario) =>
    events.filter((event) => event.hook_event_name === eventName && event.scenario === scenario);
  const has = (eventName, scenario) => matching(eventName, scenario).length > 0;
  const exactly = (eventName, scenario, count) => matching(eventName, scenario).length === count;
  const correlated = (scenario) => {
    const pre = matching("PreToolUse", scenario)[0];
    const post = matching("PostToolUse", scenario)[0];
    return Boolean(pre && post && pre.session_id === post.session_id && pre.tool_use_id === post.tool_use_id);
  };
  const preToolRefs = events
    .filter((event) => event.hook_event_name === "PreToolUse")
    .map((event) => event.tool_use_id);
  if (focus === "patch-workdir") {
    const pre = matching("PreToolUse", "patch-workdir");
    const post = matching("PostToolUse", "patch-workdir");
    const observed = pre[0];
    const directoryExposed = observed?.tool_input_workdir_matches_nested === true ||
      observed?.tool_input_cwd_matches_nested === true ||
      (observed?.cwd_matches_nested === true && observed?.cwd_matches_hook_process === true);
    const checks = {
      exactly_one_pre: pre.length === 1,
      exactly_one_post: post.length === 1,
      ids_correlate: pre.length === 1 && post.length === 1 &&
        pre[0].session_id === post[0].session_id && pre[0].tool_use_id === post[0].tool_use_id,
      effect_in_nested_workdir: existsSync(join(out, "nested-cwd", "patch-workdir.txt")),
      effect_absent_at_root: !existsSync(join(out, "patch-workdir.txt")),
      execution_directory_exposed: directoryExposed,
      canonical_tool_supported: observed?.tool_name === "Bash" || observed?.tool_name === "apply_patch",
    };
    const ok = Object.values(checks).every(Boolean);
    process.stdout.write(`${JSON.stringify({
      ok,
      focus,
      event_count: events.length,
      observed_tool_name: typeof observed?.tool_name === "string" ? observed.tool_name : null,
      checks,
    }, null, 2)}\n`);
    if (!ok) process.exitCode = 1;
    return;
  }
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
    pre_nested: exactly("PreToolUse", "nested", 1),
    post_nested: exactly("PostToolUse", "nested", 1),
    nested_effect_in_workdir: existsSync(join(out, "nested-cwd", "nested-workdir.txt")),
    nested_effect_absent_at_root: !existsSync(join(out, "nested-workdir.txt")),
    nested_workdir_exposed: (() => {
      const nested = matching("PreToolUse", "nested")[0];
      return nested?.tool_input_workdir_matches_nested === true ||
        nested?.tool_input_cwd_matches_nested === true ||
        (nested?.cwd_matches_nested === true && nested?.cwd_matches_hook_process === true);
    })(),
    pre_patch_allow: exactly("PreToolUse", "patch-allow", 1),
    post_patch_allow: exactly("PostToolUse", "patch-allow", 1),
    patch_effect_present: existsSync(join(out, "patch-allowed.txt")),
    pre_patch_deny: exactly("PreToolUse", "patch-deny", 1),
    post_patch_deny_absent: exactly("PostToolUse", "patch-deny", 0),
    patch_denied_effect_absent: !existsSync(join(out, "patch-denied.txt")),
    allow_exactly_once: exactly("PreToolUse", "allow", 1) && exactly("PostToolUse", "allow", 1),
    allow_ids_correlate: correlated("allow"),
    patch_ids_correlate: correlated("patch-allow"),
    native_calls_have_distinct_tool_refs: new Set(preToolRefs).size === preToolRefs.length,
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
