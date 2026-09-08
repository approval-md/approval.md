/**
 * The Codex-specific edge of `approval hook codex` (APRV-311).
 *
 * Codex currently uses the same outer hook envelope as Claude Code, but its
 * input and outcome contracts are independent. Keeping the readings here
 * prevents a Claude event name or a Claude tool-response shape from becoming
 * evidence about a Codex execution.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { payloadHash } from "../core/payload.js";

/** The only Codex events this adapter understands. */
export const CODEX_PRE_TOOL_EVENT = "PreToolUse";
export const CODEX_POST_TOOL_EVENT = "PostToolUse";

/** Stable correlation ids are log material, so bound their shape and size. */
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export interface CodexHookInput {
  sessionId: string;
  sessionIdPresent: boolean;
  cwd: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string | null;
  hookEventName: string | null;
  /** Preserved verbatim so a future native reading does not inherit Claude's object-only parse. */
  toolResponseRaw: unknown;
}

export type CodexInputCheck =
  | { ok: true; phase: "pre" | "post" }
  | { ok: false; detail: string };

function stableId(name: string, value: string | null): string | null {
  if (value === null || !STABLE_ID.test(value)) {
    return `${name} must be a non-empty stable id of at most 256 safe characters`;
  }
  return null;
}

/**
 * Validate the closed Codex hook surface before it reaches shared gate code.
 *
 * The process directory is the directory the hook can establish itself. The
 * event's `cwd` is self-reported, so it may agree with that directory but may
 * not select a different payload binding. Both paths are resolved through the
 * filesystem so a symlink spelling of the same directory does not create a
 * false mismatch.
 */
export function checkCodexHookInput(input: CodexHookInput, processCwd: string): CodexInputCheck {
  const phase =
    input.hookEventName === CODEX_PRE_TOOL_EVENT
      ? "pre"
      : input.hookEventName === CODEX_POST_TOOL_EVENT
        ? "post"
        : null;
  if (phase === null) {
    return {
      ok: false,
      detail: `hook_event_name must be ${CODEX_PRE_TOOL_EVENT} or ${CODEX_POST_TOOL_EVENT}`,
    };
  }

  const session = stableId("session_id", input.sessionIdPresent ? input.sessionId : null);
  if (session !== null) return { ok: false, detail: session };
  const toolUse = stableId("tool_use_id", input.toolUseId);
  if (toolUse !== null) return { ok: false, detail: toolUse };

  if (input.toolName !== "Bash") {
    return {
      ok: false,
      detail: `${JSON.stringify(input.toolName)} is not a supported Codex tool; APRV-311 gates exact Bash only`,
    };
  }
  if (typeof input.toolInput["command"] !== "string" || input.toolInput["command"].length === 0) {
    return { ok: false, detail: "Bash tool_input.command must be a non-empty string" };
  }

  const knownInput = new Set(["command", "description", "cwd", "workdir"]);
  const unexpected = Object.keys(input.toolInput).find((key) => !knownInput.has(key));
  if (unexpected !== undefined) {
    return {
      ok: false,
      detail: `Bash tool_input contains unsupported execution-affecting field ${JSON.stringify(unexpected)}`,
    };
  }
  if (
    input.toolInput["description"] !== undefined &&
    typeof input.toolInput["description"] !== "string"
  ) {
    return { ok: false, detail: "Bash tool_input.description must be a string when present" };
  }

  if (input.cwd.length === 0) return { ok: false, detail: "hook input has no cwd" };
  let eventCwd: string;
  let actualCwd: string;
  try {
    eventCwd = realpathSync(input.cwd);
    actualCwd = realpathSync(processCwd);
  } catch {
    return {
      ok: false,
      detail: "hook cwd could not be resolved against the hook process directory",
    };
  }
  if (eventCwd !== actualCwd) {
    return {
      ok: false,
      detail: `hook cwd ${JSON.stringify(input.cwd)} does not identify the hook process directory`,
    };
  }

  for (const key of ["cwd", "workdir"] as const) {
    const stated = input.toolInput[key];
    if (stated === undefined) continue;
    if (typeof stated !== "string") {
      return { ok: false, detail: `Bash tool_input.${key} must be a string when present` };
    }
    let resolved: string;
    try {
      resolved = realpathSync(resolve(processCwd, stated));
    } catch {
      return { ok: false, detail: `Bash tool_input.${key} could not be resolved` };
    }
    if (resolved !== actualCwd) {
      return {
        ok: false,
        detail: `Bash tool_input.${key} does not identify the hook process directory`,
      };
    }
  }

  return { ok: true, phase };
}

export type CodexOutcomeReading =
  | { ok: true; outcome: "completed" | "failed" }
  | { ok: false; detail: string };

/**
 * Read a Codex outcome only from a native-observed, closed contract.
 *
 * The documented event name is identical for zero and non-zero Bash exits,
 * and `tool_response` is arbitrary JSON with no stable status key. Its raw
 * value is intentionally accepted and ignored. Until the native probe records
 * a discriminating contract, appending either outcome would fabricate it.
 */
export function readCodexReportedOutcome(_input: CodexHookInput): CodexOutcomeReading {
  return {
    ok: false,
    detail:
      "Codex PostToolUse does not yet expose a native-verified success or failure reading; tool_response is arbitrary JSON, so the execution remains open",
  };
}

export interface CodexBinding {
  /** Exact bytes the gate and a future counterpart both bind. */
  payload: { tool: "Bash"; command: string; cwd: string };
  /** Passed to the legacy finish helper; reconstructs the four-segment task. */
  finishSessionId: string;
  finishToolUseId: string;
  task: string;
}

/**
 * Build the one Codex tool-call identity used by both pre and post phases.
 *
 * Native ids may contain colons, so they never enter the colon-delimited task
 * directly. The session digest preserves per-session loop scope; the call
 * digest additionally binds tool semantics, command bytes, and established
 * process directory. Fixed-width digests make the encoding injective at the
 * task grammar boundary.
 */
export function codexBinding(input: CodexHookInput, processCwd: string): CodexBinding {
  const command = input.toolInput["command"];
  if (input.toolName !== "Bash" || typeof command !== "string") {
    throw new Error("codexBinding requires a validated Bash input");
  }
  if (input.toolUseId === null) throw new Error("codexBinding requires a validated tool_use_id");
  const payload = { tool: "Bash" as const, command, cwd: realpathSync(processCwd) };
  const sessionDigest = payloadHash({
    domain: "approval.md/codex-hook-session/v1",
    harness: "codex",
    session_id: input.sessionId,
  });
  const callDigest = payloadHash({
    domain: "approval.md/codex-hook-call/v1",
    harness: "codex",
    session_id: input.sessionId,
    tool_use_id: input.toolUseId,
    payload_hash: payloadHash(payload),
  });
  const finishSessionId = `codex:${sessionDigest}`;
  return {
    payload,
    finishSessionId,
    finishToolUseId: callDigest,
    task: `hook:${finishSessionId}:${callDigest}`,
  };
}
