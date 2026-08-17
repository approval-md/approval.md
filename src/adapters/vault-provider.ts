/**
 * The vault as a {@link CredentialProvider} (SPEC.md §10.4; APRV-68).
 *
 * `adapters/contract.ts` left one seam open and named the task that would fill
 * it: "No vault. {@link CredentialProvider} is the seam a real vault implements
 * (APRV-68)." This module is that implementation, and it is deliberately thin.
 * Everything about *when* a credential may be read belongs to the contract;
 * everything about *how* the bytes are stored belongs to `core/vault.ts`. What
 * is left here is the translation between the two vocabularies.
 *
 * ## The structural rule
 *
 * A provider built here is only ever handed to
 * {@link executeThroughAdapter} through {@link AdapterExecuteOptions.credentials}.
 * The contract wraps it in a window that closes the instant `act` returns, so
 * every read is inside a verified, consumed, single-use token — which is what
 * SPEC.md §10.4 means by "the credentials only answer to tokens". Three things
 * hold that rule up, and none of them is a convention:
 *
 * 1. `core/vault.ts` exports exactly one function that returns a credential
 *    value (`getCredential`), and this module is its only caller in the
 *    repository. `tests/vault.test.ts` pins both halves.
 * 2. There is no CLI verb that prints a value. `approval vault` can set, list
 *    (names), and remove; it cannot show. See `src/cli/vault.ts`.
 * 3. The contract scans everything an adapter returns for the values the
 *    provider handed out and redacts them, so a leak by a careless adapter is
 *    caught mechanically rather than reviewed for.
 *
 * ## What this defends, and what it does not
 *
 * Exactly what the vault module's own threat model says, restated because a
 * reader arriving from the adapter side deserves it here too. **Defended:**
 * credentials at rest, and casual reads by an agent that can read files in the
 * working tree — the ciphertext hides the names as well as the values.
 * **Not defended (SPEC.md §11, plainly):** a compromised host, and an agent that
 * can read the passphrase environment variable. Such an agent does not need this
 * provider; it can decrypt the file directly. The vault raises the cost of a
 * leak from reading a file to owning the session, and claims nothing beyond
 * that.
 *
 * Total and synchronous, as {@link CredentialProvider} requires: nothing here
 * throws, nothing blocks on a human, and every failure is one of the three
 * {@link CREDENTIAL_REFUSAL_CODES}.
 */

import {
  getCredential,
  passphraseFrom,
  vaultPathFor,
  type VaultRefusalCode,
} from "../core/vault.js";
import type { CredentialProvider, CredentialResult } from "./contract.js";

/**
 * How to reach the vault. Either the vault file directly, or the log path the
 * convention derives it from — never both, so there is one answer to "which
 * file".
 */
export type VaultLocation = { vaultPath: string } | { logPath: string };

export interface VaultProviderOptions {
  /**
   * The NAME of the environment variable holding the passphrase. Callers get
   * this from `passphraseEnvFor(loadPolicy(...))`, so the policy's declaration
   * is honoured and the default applies when it declares nothing.
   */
  passphraseEnv: string;
  /** Injectable for tests. Defaults to this process's environment. */
  env?: NodeJS.ProcessEnv;
}

/**
 * How a vault refusal is reported to an adapter.
 *
 * The contract's union has three members and they answer three different
 * questions, so the mapping is by *repair* rather than by severity:
 *
 * - **`credential-unavailable`** — nothing is configured yet. No vault, no such
 *   name, no passphrase in the environment. The operator has something to do.
 * - **`credential-refused`** — the vault exists and would not open: a wrong
 *   passphrase, an altered file, a format this build does not read, an
 *   unreadable path. SPEC.md's phrase for this branch is "a locked vault", and
 *   it is distinct because the repair is investigation, not configuration.
 * - **`credential-window-closed`** — never produced here. It is the contract's
 *   own verdict about *when* the question was asked, and this module has no way
 *   to know that.
 */
function mapRefusal(code: VaultRefusalCode): "credential-unavailable" | "credential-refused" {
  switch (code) {
    case "vault-absent":
    case "passphrase-unset":
    case "credential-absent":
    case "invalid-name":
      return "credential-unavailable";
    case "vault-io":
    case "vault-malformed":
    case "vault-version-unsupported":
    case "vault-unreadable":
    case "empty-value":
    case "vault-write-failed":
      return "credential-refused";
  }
}

/**
 * A provider that answers from the encrypted vault.
 *
 * **Lazy, and cached for the life of the provider.** The vault is not opened
 * until an adapter actually asks for something, so an execution that needs no
 * credential pays no scrypt cost and touches no ciphertext. Once opened, the
 * derived value for a name is remembered, because a provider's life *is* one
 * `act` call: the contract closes it when `act` returns, so the cache cannot
 * outlive the token window it was built for, and the alternative — a fresh
 * ~100 ms key derivation per credential — would put a visible tax on an adapter
 * that needs two.
 *
 * The passphrase is read from the environment on every open rather than
 * captured at construction, so a provider built before the operator exported the
 * variable is not permanently poisoned.
 *
 * Messages name the environment VARIABLE and the credential NAME, and never a
 * value: an adapter's failure message is one of the strings the contract hands
 * back to a caller, and a diagnostic that quoted the secret would defeat the
 * redaction guard by putting the secret in the one place the guard cannot know
 * to look for it.
 */
export function vaultCredentialProvider(
  location: VaultLocation,
  options: VaultProviderOptions,
): CredentialProvider {
  const vaultPath = "vaultPath" in location ? location.vaultPath : vaultPathFor(location.logPath);
  const { passphraseEnv } = options;
  const cache = new Map<string, string>();

  return {
    get(name: string): CredentialResult {
      const cached = cache.get(name);
      if (cached !== undefined) return { ok: true, value: cached };

      const passphrase = passphraseFrom(passphraseEnv, options.env ?? process.env);
      if (passphrase === null) {
        return {
          ok: false,
          code: "credential-unavailable",
          message: `credential ${JSON.stringify(name)} lives in the vault at ${vaultPath}, and the passphrase variable ${passphraseEnv} is unset or empty in this process. The policy names the variable and never the value (SPEC.md §5.2, §10.4); export it in the environment that runs the adapter.`,
        };
      }

      const result = getCredential(vaultPath, passphrase, name);
      if (result.ok) {
        cache.set(name, result.value);
        return { ok: true, value: result.value };
      }
      return { ok: false, code: mapRefusal(result.code), message: result.message };
    },
  };
}
