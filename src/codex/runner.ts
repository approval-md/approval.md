/**
 * The confined Codex session runner (APRV-325.3).
 *
 * APRV-325.2 made the canonical workspace writable through one door. That is
 * worth nothing on its own: a door beside an open window is decoration. This
 * module is the window being closed — the shell a Codex session runs gets a
 * DISPOSABLE workspace of its own, no write authority over the canonical one,
 * no write authority over the gate, no ambient credentials, no egress, and no
 * way to ask for any of it back.
 *
 * ## Five removals, and where each is enforced
 *
 * | what the shell does not get | enforced by |
 * |---|---|
 * | canonical workspace writes | Seatbelt `(deny file-write*)` with an allow-list that names only the disposable workspace |
 * | gate writes (log, policy, vault, keys) | the same deny; the gate home is not on the allow-list |
 * | ambient credentials | `core/child-env.ts` strips them from the environment before the spawn |
 * | credential material on disk | Seatbelt `denyRead` over the vault, the env map and the sealing keys |
 * | external egress | Seatbelt `(deny network-outbound)`, loopback included |
 * | mutable executor code | the broker, the CLI and the pinned Node live under the root-owned install root, which is not on the write allow-list either |
 *
 * ## No opt-out, and no raw fallback
 *
 * `approval run` has `--no-sandbox`, because an operator holding a human's grant
 * may deliberately reach the world. A confined session has no such flag and no
 * such path: {@link planConfinedSession} REFUSES when the host cannot apply a
 * profile, where `core/sandbox.ts`'s ordinary posture table would record
 * `unsupported` and proceed. That difference is the whole point — an
 * unsupported host that ran the shell anyway would be a session advertised as
 * confined and not confined, which is worse than no session at all.
 * `APPROVAL_SANDBOX_FORCE_UNAVAILABLE` and `APPROVAL_SANDBOX_REQUIRED` still
 * only tighten, so neither is a way in.
 *
 * ## What it does not claim
 *
 * This confines a CHILD PROCESS on macOS. It is not isolation and it is not a
 * claim about the Codex desktop application, which runs outside anything this
 * runtime spawns; `docs/codex-boundary-probe.md` holds what was measured there.
 * Inbound sockets are not denied (`core/sandbox.ts`'s stated limit), and a
 * confined child can still write inside its own disposable workspace, which is
 * the point of giving it one.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { childEnvironment } from "../core/child-env.js";
import {
  credentialPathsFor,
  detectSandbox,
  resolveExecutable,
  wrapForSandbox,
  type DetectOptions,
  type SandboxDetection,
  type SandboxMechanism,
} from "../core/sandbox.js";
import type { BrokerInstallation } from "./broker.js";

export const CONFINED_SESSION_VERSION = "approval.codex.confined-session.v1" as const;

/**
 * The ONLY environment variables a confined session passes through.
 *
 * An ALLOW-list, and for the reason the write rules are one. `core/child-env.ts`
 * strips a named family (`APPROVAL_`, `TELEGRAM_`, `VAULT_`, `AGENTMAIL_`) and
 * that is right for `approval run`, which runs a command a human approved and
 * whose environment is the operator's own. It is not enough here: a Codex
 * session's host carries `OPENAI_API_KEY`, `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`,
 * an `SSH_AUTH_SOCK` and whatever else the operator's shell exports, and none of
 * those is under a prefix this runtime knows. A deny-list would have to keep up
 * with every provider anyone ever adds; this names the handful a shell needs to
 * function, so a credential nobody thought of is absent rather than forgotten.
 *
 * `core/child-env.ts` still runs FIRST, so its credential-bearing count is
 * reported on the same terms as everywhere else in the runtime. This list then
 * narrows what survives; it can only ever remove more.
 *
 * This is a control over NAMES and therefore best-effort by construction: a
 * credential exported under a name on this list still passes. The load-bearing
 * control beside it is that egress is denied, so a secret that does reach the
 * child has nowhere to go.
 */
export const CONFINED_ENV_ALLOW: readonly string[] = [
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "LINES",
  "COLUMNS",
];

/** How long a confined command may run before it is killed. */
export const DEFAULT_CONFINED_TIMEOUT_MS = 120_000;

/**
 * Why a confined session could not be prepared or run. Frozen, distinct, and
 * pinned by `tests/codex-confine.test.ts` (SPEC.md §11.1 invariant 6).
 */
export const CONFINE_REFUSAL_CODES = [
  /** This host has no sandbox mechanism in this build. A confined session refuses. */
  "sandbox-unsupported",
  /** The mechanism exists and did not work. */
  "sandbox-unavailable",
  /** The disposable workspace could not be created. */
  "workspace-unavailable",
  /** The command could not be resolved, so it was never wrapped. */
  "command-unresolvable",
  /** The command was killed at the deadline. No canonical effect is possible. */
  "timeout",
] as const;

export type ConfineRefusalCode = (typeof CONFINE_REFUSAL_CODES)[number];

export interface ConfineRefusal {
  ok: false;
  code: ConfineRefusalCode;
  message: string;
}

function refuse(code: ConfineRefusalCode, message: string): ConfineRefusal {
  return { ok: false, code, message };
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface ConfinedSession {
  version: typeof CONFINED_SESSION_VERSION;
  /** The scratch tree the shell may write. Removed by {@link ConfinedSession.dispose}. */
  workspace: string;
  /** The canonical workspace: readable, never writable from inside. */
  canonical: string;
  mechanism: SandboxMechanism;
  /** Absolute subtrees the profile allows writes to. */
  writeAllow: readonly string[];
  /** Absolute paths the profile denies reads of. */
  denyRead: readonly string[];
  /** The child's environment: {@link CONFINED_ENV_ALLOW} and the session's own. */
  env: Record<string, string>;
  /**
   * How many credential-bearing variables `core/child-env.ts` withheld. A
   * COUNT, never a name: a name is half of a credential, and SPEC.md §11.1's
   * raw-secrets invariant is not satisfied by leaking the other half slowly.
   */
  envStripped: number;
  /** How many source variables did not survive the allow-list, in total. */
  envWithheld: number;
  /** Remove the disposable workspace. Idempotent, never throws. */
  dispose: () => void;
}

export interface ConfineOptions {
  /** Forwarded to `core/sandbox.ts`'s probe. Tests inject a platform here. */
  detect?: DetectOptions;
  /** The environment to derive the child's from. Defaults to this process's. */
  source?: NodeJS.ProcessEnv;
  /** Where the disposable workspace is created. Defaults to `os.tmpdir()`. */
  scratchRoot?: string;
}

export type ConfinedSessionResult =
  | { ok: true; session: ConfinedSession }
  | ConfineRefusal;

/**
 * Prepare one confined session, or refuse.
 *
 * The refusal on an unsupported host is deliberate and is the one place this
 * module is STRICTER than `core/sandbox.ts`'s posture table. See the header.
 */
export function planConfinedSession(
  installation: BrokerInstallation,
  options: ConfineOptions = {},
): ConfinedSessionResult {
  const detection: SandboxDetection = detectSandbox(options.detect ?? {});
  if (!detection.supported) {
    return refuse(
      "sandbox-unsupported",
      `a confined Codex session needs a sandbox mechanism and this build has none for this host: ${detection.reason}. Unlike \`approval run\`, this verb does not proceed and record \`unsupported\`: a session advertised as confined and not confined is worse than no session`,
    );
  }
  if (!detection.available || detection.mechanism === null) {
    return refuse(
      "sandbox-unavailable",
      `the sandbox mechanism is present and did not work: ${detection.reason}. There is no opt-out and no raw fallback`,
    );
  }

  let workspace: string;
  try {
    const root = options.scratchRoot === undefined ? tmpdir() : options.scratchRoot;
    workspace = realpathSync(mkdtempSync(join(root, "approval-codex-session-")));
  } catch (cause) {
    return refuse(
      "workspace-unavailable",
      `the disposable session workspace could not be created: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const source = options.source ?? process.env;
  const { env: filtered, stripped } = childEnvironment({ source });
  // Then the allow-list, which can only ever remove more. See CONFINED_ENV_ALLOW.
  const env: Record<string, string> = {};
  for (const name of CONFINED_ENV_ALLOW) {
    const value = filtered[name];
    if (value !== undefined) env[name] = value;
  }
  const withheld = Object.values(source).filter((value) => value !== undefined).length -
    Object.keys(env).length;
  // The child's own view of "somewhere to put temporary files" is inside the
  // room. Left alone it would point at a directory the profile denies, and a
  // shell whose TMPDIR is unwritable fails in ways that look like the sandbox
  // being broken rather than doing its job.
  env["TMPDIR"] = workspace;
  env["APPROVAL_CODEX_SESSION_WORKSPACE"] = workspace;

  return {
    ok: true,
    session: {
      version: CONFINED_SESSION_VERSION,
      workspace,
      canonical: installation.root,
      mechanism: detection.mechanism,
      // The ONLY writable subtree. The canonical workspace, the gate home, the
      // install root and the rest of the filesystem are absent, which is what
      // makes this an allow-list rather than a wish.
      writeAllow: [workspace],
      denyRead: credentialPathsFor(installation.logPath),
      env,
      envStripped: stripped,
      envWithheld: Math.max(0, withheld),
      dispose: () => {
        try {
          rmSync(workspace, { recursive: true, force: true });
        } catch {
          // A scratch directory that outlives the session is visible to a person
          // and costs nothing; failing to remove it must not fail the session.
        }
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Running one command inside it
// ---------------------------------------------------------------------------

export interface ConfinedRun {
  ok: true;
  /** The child's own exit code, or `128 + signal` when a signal killed it. */
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the deadline killed it. The exit code is then the signal's. */
  timedOut: boolean;
}

export type ConfinedRunResult = ConfinedRun | ConfineRefusal;

export interface ConfinedRunOptions {
  timeoutMs?: number;
  /** Working directory for the child. Defaults to the disposable workspace. */
  cwd?: string;
  maxBuffer?: number;
}

/**
 * Run one command inside a prepared session.
 *
 * The command is resolved BEFORE it is wrapped, for `core/sandbox.ts`'s reason:
 * an `execvp` failure inside `sandbox-exec` exits 71, and 71 recorded as the
 * child's exit code is a lie about a command that never ran. Here it is a
 * refusal instead of an unwrapped spawn, because an unwrapped spawn is exactly
 * the raw fallback this session must not have.
 */
export function runConfined(
  session: ConfinedSession,
  command: string,
  args: readonly string[],
  options: ConfinedRunOptions = {},
): ConfinedRunResult {
  const resolved = resolveExecutable(command, session.env);
  if (resolved === null) {
    return refuse(
      "command-unresolvable",
      `${JSON.stringify(command)} could not be resolved on the session's PATH. It was NOT spawned unwrapped: a confined session has no raw fallback`,
    );
  }
  const wrapped = wrapForSandbox(session.mechanism, resolved, args, {
    loopback: false,
    denyRead: session.denyRead,
    writeAllow: session.writeAllow,
  });
  try {
    const result = spawnSync(wrapped.command, wrapped.args, {
      cwd: options.cwd ?? session.workspace,
      env: session.env,
      encoding: "utf8",
      timeout: options.timeoutMs ?? DEFAULT_CONFINED_TIMEOUT_MS,
      maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
    });
    const timedOut = result.signal !== null && result.error !== undefined;
    return {
      ok: true,
      exitCode: exitCodeOf(result.status, result.signal),
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      timedOut,
    };
  } finally {
    // The profile file, not the workspace: the session owns that and disposes
    // of it when it ends, so several commands share one room.
    try {
      rmSync(wrapped.cleanup, { recursive: true, force: true });
    } catch {
      // Same reasoning as the workspace: visible, and never a reason to fail.
    }
  }
}

/** The shell's convention, so a signal death is distinguishable from an exit. */
function exitCodeOf(status: number | null, signal: NodeJS.Signals | null): number {
  if (status !== null) return status;
  if (signal === null) return 1;
  const numbers: Record<string, number> = { SIGTERM: 15, SIGKILL: 9, SIGINT: 2, SIGHUP: 1 };
  return 128 + (numbers[signal] ?? 0);
}
