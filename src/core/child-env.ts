/**
 * The environment a spawned child receives (APRV-205).
 *
 * `approval run` used to call `spawnSync` with no `env` option, so Node handed
 * the child a copy of the whole session environment: the Telegram bot token,
 * whatever `vault.passphrase_env` names, every other credential the session was
 * launched with. APRV-194 closed the direct route by classifying the shell
 * commands that READ credential material, and it could not close this one,
 * because the classifier reads `npm test` and the reading happens inside
 * whatever `npm test` runs. A gate that holds the token while handing it to
 * every child it launches is custody theatre.
 *
 * This module is the scrub. It is the minimal, pre-launch slice of APRV-193's
 * "spawn starved": it removes credential-bearing variables and does nothing
 * else. It is not a sandbox — the child keeps the network, the filesystem, and
 * every other ambient capability of the session, and APRV-193 is where those
 * are taken away.
 *
 * Three rules, in this order:
 *
 * 1. A name the granted action's adapter declared in `requiredCredentials`
 *    (APRV-169) is PASSED. That declaration is static, made by the adapter's own
 *    code, and reaches this function through nothing a caller typed: a flag that
 *    could name a variable to keep would be a flag that hands an agent the
 *    token back.
 * 2. A name under the credential-bearing prefixes (`APPROVAL_`, `TELEGRAM_`,
 *    `VAULT_`), less the APRV-194 allowlist of runtime names that hold no
 *    secret, is REMOVED. The list is imported from `command-class.ts` rather
 *    than restated, so the classifier and the scrub cannot drift apart.
 * 3. The name the policy's `vault.passphrase_env` gives is REMOVED, whatever it
 *    is. The default (`APPROVAL_VAULT_PASSPHRASE`) is already caught by rule 2;
 *    a deployment that renamed it to something outside the prefixes is the
 *    reason this rule is separate.
 *
 * Everything else passes through untouched. `PATH`, `HOME`, `TMPDIR`, `LANG`,
 * `NODE_OPTIONS` and the rest of a working environment are not this task's
 * business, and a scrub that broke `PATH` would be reverted within the day.
 * That is an allowlist inverted, and the design says so plainly: APRV-193's
 * §3.4 wants a real allowlist at the SESSION boundary, where the operator
 * launches the harness; a per-child allowlist here would break every command an
 * agent legitimately runs.
 *
 * What comes back beside the environment is a COUNT. The log records how many
 * variables were withheld and never which ones, because a name is the half of a
 * credential this repository can print, and SPEC.md §11.1's raw-secrets
 * invariant is not satisfied by leaking the other half slowly. The count is
 * informational: nothing in the gate reads it back, and no decision anywhere
 * turns on it.
 */

import { NON_SECRET_ENV_NAMES, SECRET_ENV_PREFIXES, isSecretEnvName } from "./command-class.js";

export { NON_SECRET_ENV_NAMES, SECRET_ENV_PREFIXES, isSecretEnvName };

export interface ChildEnvironmentOptions {
  /** The environment to start from. Defaults to this process's own. */
  readonly source?: NodeJS.ProcessEnv;
  /**
   * The name the policy's `vault.passphrase_env` gives, when a policy was
   * loaded. `null` or omitted removes nothing beyond the prefixed family.
   */
  readonly passphraseEnv?: string | null;
  /**
   * The credential names the granted action's adapter declared in
   * `requiredCredentials` (APRV-169). Passed through even when they fall under
   * the credential-bearing prefixes: the adapter said it cannot act without
   * them, and this is the injection point the design names.
   */
  readonly declaredCredentials?: readonly string[];
}

export interface ChildEnvironment {
  /** What to hand `spawnSync`. Never a reference to the source. */
  readonly env: Record<string, string>;
  /** How many variables were withheld. Names are deliberately not reported. */
  readonly stripped: number;
  /**
   * The declared names that were present in the source and survived, as a
   * count, for the same reason: a caller may want to know that injection
   * happened without learning what was injected.
   */
  readonly passed: number;
}

/**
 * Build the environment a granted child gets.
 *
 * Total and deterministic: no reads, no throws, and the same source produces
 * the same answer every time. A variable whose value is `undefined` (Node's
 * spelling for "unset") is neither copied nor counted, because there was
 * nothing there to withhold.
 */
export function childEnvironment(options: ChildEnvironmentOptions = {}): ChildEnvironment {
  const source = options.source ?? process.env;
  const passphraseEnv =
    typeof options.passphraseEnv === "string" && options.passphraseEnv.length > 0
      ? options.passphraseEnv
      : null;
  const declared = new Set(options.declaredCredentials ?? []);

  const env: Record<string, string> = {};
  let stripped = 0;
  let passed = 0;
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (declared.has(name)) {
      env[name] = value;
      if (isSecretEnvName(name) || name === passphraseEnv) passed += 1;
      continue;
    }
    if (isSecretEnvName(name) || name === passphraseEnv) {
      stripped += 1;
      continue;
    }
    env[name] = value;
  }
  return { env, stripped, passed };
}
