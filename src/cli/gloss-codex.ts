/** Provider-specific Codex CLI runner for optional model glosses (APRV-254). */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { childEnvironment } from "../core/child-env.js";
import {
  GLOSS_EDIT_INSTRUCTION,
  GLOSS_EMAIL_INSTRUCTION,
  GLOSS_INSTRUCTION,
  GLOSS_MAX_INPUT_CHARS,
  GLOSS_TRUNCATION_NOTE,
  GLOSS_TIMEOUT_MS,
  normalizeGlossModelId,
  type GlossResult,
  type GlossRunner,
} from "./gloss.js";

const OUTPUT_LIMIT_BYTES = 64 * 1024;
const HELPER_PATH = fileURLToPath(new URL("./gloss-codex-child.js", import.meta.url));
const SUPERVISOR_GRACE_MS = 250;

const CODEX_ENABLED_FEATURES = ["skip_host_skill_discovery"] as const;

const CODEX_DISABLED_FEATURES = [
  "apps",
  "auth_elicitation",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "code_mode",
  "code_mode_host",
  "computer_use",
  "goals",
  "hooks",
  "image_generation",
  "in_app_browser",
  "in_app_local_automation",
  "memories",
  "multi_agent",
  "multi_agent_v2",
  "plugins",
  "remote_plugin",
  "skill_mcp_dependency_install",
  "skill_search",
  "shell_tool",
  "sleep_tool",
  "tool_call_mcp_elicitation",
  "tool_suggest",
  "unified_exec",
  "view_image",
  "workspace_dependencies",
] as const;

const CODEX_CONFIG = [
  'project_doc_max_bytes=0',
  'project_doc_fallback_filenames=[]',
  'project_root_markers=[]',
  'approval_policy="never"',
  'default_permissions="gloss"',
  'permissions.gloss.filesystem={":minimal"="read",":workspace_roots"={"."="read"}}',
  'permissions.gloss.network.enabled=false',
  'web_search="disabled"',
  'mcp_servers={}',
  'hooks={}',
  'plugins={}',
  'history.persistence="none"',
  'check_for_update_on_startup=false',
  'analytics.enabled=false',
  'otel.exporter="none"',
  'notify=[]',
] as const;

const KNOWN_INSTRUCTIONS = new Set([
  GLOSS_INSTRUCTION,
  GLOSS_EDIT_INSTRUCTION,
  GLOSS_EMAIL_INSTRUCTION,
]);

export type CodexGlossUnavailableReason =
  | "invalid-model"
  | "invalid-prompt"
  | "unsupported-platform"
  | "spawn-error"
  | "timeout"
  | "output-too-large"
  | "nonzero-exit"
  | "invalid-output"
  | "unsafe-output"
  | "cleanup-failed";

export interface CodexGlossRunnerOptions {
  /** Test seam. Production callers omit this and run the installed `codex`. */
  readonly executable?: string;
  /** Test seam. Production callers always receive the shared 20-second cap. */
  readonly timeoutMs?: number;
  /** Receives only a fixed reason code, never subprocess output. */
  readonly diagnostic?: (reason: CodexGlossUnavailableReason) => void;
}

function report(options: CodexGlossRunnerOptions, reason: CodexGlossUnavailableReason): null {
  try {
    options.diagnostic?.(reason);
  } catch {
    // Diagnostics cannot make a reading aid load-bearing.
  }
  return null;
}

function splitPrompt(prompt: string): { instruction: string; material: string } | null {
  const separator = prompt.indexOf("\n\n");
  if (separator < 0) return null;
  const instruction = prompt.slice(0, separator);
  if (!KNOWN_INSTRUCTIONS.has(instruction)) return null;
  const material = prompt.slice(separator + 2);
  const largestCappedMaterial = GLOSS_MAX_INPUT_CHARS + GLOSS_TRUNCATION_NOTE.length + 2;
  if (material.length > largestCappedMaterial) return null;
  return { instruction, material };
}

function codexArgs(model: string, cwd: string): string[] {
  const args = [
    "exec",
    "--strict-config",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--skip-git-repo-check",
    "--json",
    "-C",
    cwd,
    "-m",
    model,
  ];
  for (const config of CODEX_CONFIG) args.push("-c", config);
  for (const feature of CODEX_ENABLED_FEATURES) args.push("--enable", feature);
  for (const feature of CODEX_DISABLED_FEATURES) args.push("--disable", feature);
  return args;
}

interface JsonObject {
  readonly [key: string]: unknown;
}

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function parseSuccessfulAnswer(stdout: string, model: string): GlossResult | null {
  let completedTurns = 0;
  let answer: string | null = null;
  let terminal = false;
  const lines = stdout.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return null;

  for (const line of lines) {
    let event: JsonObject | null;
    try {
      event = object(JSON.parse(line));
    } catch {
      return null;
    }
    if (event === null || typeof event.type !== "string") return null;
    if (terminal) return null;

    if (event.type === "thread.started" || event.type === "turn.started") continue;
    if (event.type === "error" || event.type === "turn.failed") return null;
    if (event.type === "turn.completed") {
      completedTurns += 1;
      terminal = true;
      continue;
    }
    if (
      event.type !== "item.started" &&
      event.type !== "item.updated" &&
      event.type !== "item.completed"
    ) {
      return null;
    }

    const item = object(event.item);
    if (item === null || (item.type !== "reasoning" && item.type !== "agent_message")) {
      return null;
    }
    if (event.type === "item.completed" && item.type === "agent_message") {
      if (typeof item.text !== "string" || item.text.trim().length === 0) return null;
      answer = item.text;
    }
  }

  return completedTurns === 1 && answer !== null
    ? { text: answer, provenance: { provider: "codex", requestedModel: model } }
    : null;
}

/**
 * Build a synchronous Codex gloss runner using the CLI's saved authentication.
 *
 * The invocation starts in a new empty directory with a named read-only
 * permission profile, command network disabled, project instructions
 * suppressed, host skill discovery skipped, and every currently known
 * tool/integration feature disabled.
 * Codex 0.152.1 has no universal deny-all tool switch: host-managed and global
 * base instructions still apply, the under-development discovery switch is
 * version-specific, and the CLI owns any auth-state maintenance.
 * The caller must present that practical isolation boundary to the operator.
 */
export function codexGlossRunnerFor(
  model: string,
  passphraseEnv: string | null = null,
  options: CodexGlossRunnerOptions = {},
): GlossRunner {
  const requestedModel = normalizeGlossModelId(model);
  return (prompt: string): GlossResult | null => {
    if (requestedModel === null) return report(options, "invalid-model");
    if (process.platform === "win32") return report(options, "unsupported-platform");
    const parts = splitPrompt(prompt);
    if (parts === null) return report(options, "invalid-prompt");

    const configuredTimeout = options.timeoutMs ?? GLOSS_TIMEOUT_MS;
    const timeoutMs =
      Number.isSafeInteger(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : GLOSS_TIMEOUT_MS;
    let cwd: string;
    try {
      cwd = mkdtempSync(join(tmpdir(), "approval-md-codex-gloss-"));
    } catch {
      return report(options, "spawn-error");
    }

    let answer: GlossResult | null = null;
    let reason: CodexGlossUnavailableReason | null = null;
    try {
      const childDeadline = Math.max(1, timeoutMs - Math.min(SUPERVISOR_GRACE_MS, Math.floor(timeoutMs / 4)));
      const result = spawnSync(
        process.execPath,
        [
          HELPER_PATH,
          options.executable ?? "codex",
          String(childDeadline),
          cwd,
          parts.instruction,
          JSON.stringify(codexArgs(requestedModel, cwd)),
        ],
        {
          encoding: "utf8",
          env: childEnvironment({ passphraseEnv }).env,
          input: parts.material,
          timeout: timeoutMs,
          killSignal: "SIGTERM",
          maxBuffer: OUTPUT_LIMIT_BYTES,
        },
      );
      if (result.error !== undefined) {
        const code = (result.error as NodeJS.ErrnoException).code;
        reason = code === "ETIMEDOUT" ? "timeout" : code === "ENOBUFS" ? "output-too-large" : "spawn-error";
      } else if (result.status === 124) {
        reason = "timeout";
      } else if (result.status === 125) {
        reason = "output-too-large";
      } else if (result.status === 126) {
        reason = "spawn-error";
      } else if (result.status !== 0) {
        reason = "nonzero-exit";
      } else if (typeof result.stdout !== "string") {
        reason = "invalid-output";
      } else {
        answer = parseSuccessfulAnswer(result.stdout, requestedModel);
        if (answer === null) reason = "unsafe-output";
      }
    } catch {
      reason = "spawn-error";
    }

    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      return report(options, "cleanup-failed");
    }
    return reason === null ? answer : report(options, reason);
  };
}
