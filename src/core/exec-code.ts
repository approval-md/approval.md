/**
 * The `exec.code` gate: what the attested policy says about opaque agent code
 * (APRV-510, 0.4.5 candidate).
 *
 * `python3 -c`, `node -e` and kin, an interpreter running a file that is not a
 * skill script, and a Hermes `execute_code` call are all programs whose effect
 * no classifier reads. Before this module every one of them was refused before
 * policy (`hook-opaque`, `hook-unclassified`, `hook-hermes-execute-code-unbound`),
 * and that stays the answer for every policy that does not speak: the gate is
 * CLOSED unless the operator's policy opens it, key by key.
 *
 * Two keys, each opening one thing, and an absent key is the closed answer:
 *
 * - `exec.code.custody: attested` opens the class for the shell forms. It is the
 *   operator's statement that credential custody is in place: opaque code run by
 *   an agent that can read the tenant's credentials is a way round every gate
 *   that guards them, so the class may not exist without that statement.
 * - `exec.code.execute_code: hooked`, beside the first, opens Hermes's
 *   `execute_code`. It is the operator's statement that a tool call made from
 *   inside the `execute_code` kernel re-fires the hook, which only a live probe
 *   can establish (`docs/hermes-hook.md`); without it one `execute_code` call
 *   would be an unbounded bypass of the adapter.
 *
 * Pure: a function of the parsed policy and nothing else. It decides whether a
 * call may be CLASSIFIED `exec.code`; what the class then resolves to is the
 * policy's ordinary class resolution (an `exec.code` row, an `exec.*` row, or
 * `defaults.autonomy`), unchanged.
 */

import type { Policy } from "./policy-load.js";

/** The `exec` policy block (schema/policy.schema.json, APRV-510). */
export interface ExecBlock {
  code?: {
    custody?: "attested" | "unattested";
    execute_code?: "hooked" | "unhooked";
  };
}

/** The class an opened program is judged under. Mirrors `command-class.ts`. */
export const EXEC_CODE_POLICY_CLASS = "exec.code";

/** The policy line that opens the class, as a refusal names it. */
export const EXEC_CODE_CUSTODY_KEY = "exec.code.custody: attested";

/** The policy line that opens Hermes `execute_code`, as a refusal names it. */
export const EXEC_CODE_EXECUTE_KEY = "exec.code.execute_code: hooked";

/**
 * Why the gate is closed, which decides the refusal's code and words.
 *
 * - `silent`: the policy says nothing about `exec.code` (no `exec` block and no
 *   `exec.code` class row), or there is no policy. The refusal is today's,
 *   byte for byte.
 * - `unattested`: the policy names `exec.code` (an `exec` block, or a class row
 *   for it) without `custody: attested`. The refusal is
 *   `hook-exec-code-custody-unattested`, naming the key.
 * - `window`: an open window is standing. A window suspends the policy's
 *   answer, and opening this class is a policy statement, so it is not reached
 *   through one; the refusal is today's.
 * - `harness`: the adapter binds native bytes this class's payload cannot
 *   carry (Codex), so the class is not opened there; the refusal is today's.
 */
export type ExecCodeClosed = "silent" | "unattested" | "window" | "harness";

export interface ExecCodeGate {
  /** May a shell segment be classified `exec.code`? */
  shell: boolean;
  /** May a Hermes `execute_code` call be classified `exec.code`? */
  executeCode: boolean;
  /** Why `shell` is false; `null` when it is true. */
  closed: ExecCodeClosed | null;
}

/** The gate with everything closed for `reason`. */
export function closedExecCodeGate(reason: ExecCodeClosed): ExecCodeGate {
  return { shell: false, executeCode: false, closed: reason };
}

/**
 * Does the policy name `exec.code` anywhere? An `exec` block, or a `classes`
 * key that is exactly `exec.code`. A family row (`exec.*`) is not a mention:
 * it was written for `exec.local`, and a policy that predates the class keeps
 * its refusals byte for byte.
 */
export function execCodeMentioned(policy: Policy): boolean {
  if (policy.exec !== undefined) return true;
  return Object.prototype.hasOwnProperty.call(policy.classes ?? {}, EXEC_CODE_POLICY_CLASS);
}

/** What `policy` opens. `null` (no policy loaded) opens nothing. */
export function execCodeGate(policy: Policy | null): ExecCodeGate {
  if (policy === null) return closedExecCodeGate("silent");
  const code = policy.exec?.code;
  if (code?.custody !== "attested") {
    return closedExecCodeGate(execCodeMentioned(policy) ? "unattested" : "silent");
  }
  return { shell: true, executeCode: code.execute_code === "hooked", closed: null };
}
