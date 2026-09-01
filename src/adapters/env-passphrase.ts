/**
 * The vault passphrase, resolved from `.approval/env` inside a granted window
 * (SPEC.md §10.4, §5.2; APRV-168).
 *
 * ## Why this narrows a load-bearing rule, and how far
 *
 * `core/env-file.ts` states the rule this module bends, and states it as the
 * reason the file exists at all: **no verb in this runtime reads `.approval/env`
 * into its own environment.** The argument there is `APPROVAL_HUMAN`. A
 * working-tree file that could set human identity would move SPEC.md §11's trust
 * boundary from "the local machine" to "anyone who can write a file in the
 * repository", and every agent that can edit source can write a file in the
 * repository. So the file is inert, one verb resolves it, and a human evaluates
 * that verb's output in their own shell.
 *
 * The narrowing here keeps every part of that argument intact:
 *
 * 1. **One variable, named by the policy.** What this module resolves is the
 *    `vault.passphrase_env` variable and nothing else. It cannot be asked for
 *    `APPROVAL_HUMAN`, so it cannot be used to claim an identity, attest a
 *    policy, or grant a request. The whole human-only gate is untouched.
 * 2. **One caller, inside a token window.** Reaching this function requires an
 *    {@link ExecutionGrant}, which `adapters/contract.ts` mints and no other
 *    module can construct: its brand is a `unique symbol` that is never
 *    exported, so a call site outside the contract's execution path does not
 *    type-check. A generic vault verb, `approval doctor`, `approval setup` and
 *    every other caller of `vaultCredentialProvider` have no way to produce one,
 *    which is the "no verb reads `.approval/env`" rule holding everywhere except
 *    the one path named here.
 *
 *    The contract mints a grant in two phases and both are honoured, for a
 *    reason worth stating: the credential resolution APRV-169 moved AHEAD of the
 *    token spend runs in the `presented` phase, so a fallback that insisted on
 *    `consumed` would refuse the very execution it exists to enable. A
 *    `presented` grant is minted only when the caller's token matches the digest
 *    the log's `approval.granted` recorded for this action, so it is still proof
 *    that a human approved this action and that the caller holds the token that
 *    approval minted. What it does not prove is that the token may still be
 *    spent (TTL, revocation, single use), and it does not have to: those are
 *    checked in `startExecution` before anything is appended, and no side effect
 *    happens on the strength of this phase.
 * 3. **The authority is the token, not the file.** A human looked at the
 *    payload on their phone, tapped Approve, and a token was minted, delivered,
 *    verified and consumed for exactly this action key and exactly these bytes.
 *    The question this module answers is narrower than "may this process act":
 *    that was already answered, by a person. It is "the action a human approved
 *    is about to run, and the credential it needs is described in the
 *    instance's own configuration; may the runtime read that description".
 * 4. **Nothing is loaded into an environment.** The value is returned to the
 *    vault provider and used to derive one key. It is never written to
 *    `process.env`, never placed in an argv (`core/env-file.ts`'s helper
 *    lookups already pass a service NAME and take the secret on stdout), never
 *    logged, and never put in a message, a refusal, or a thrown error.
 *
 * What the demo case looks like, since it is the one that produced this task:
 * the web-agent runner scrubs the agent child's environment of everything
 * matching `APPROVAL|VAULT|TELEGRAM`, deliberately, because the server itself
 * must hold no vault passphrase. The child then holds a granted token for one
 * approved email and no way to open the vault that token is the key to. Before
 * this module the only answers were to weaken the scrub or to send the mail by
 * hand.
 *
 * ## What it does not defend
 *
 * Exactly what SPEC.md §10.4 and §11 already say the vault does not defend: a
 * compromised host, and an agent that can read the passphrase. An agent that can
 * read `.approval/env` and run the same helper lookups needs no adapter and no
 * token; it decrypts the file directly. This module does not widen that
 * exposure, because it reads what such an agent could already read. What it
 * changes is that a process which holds a HUMAN'S GRANT and no passphrase can
 * complete the action the human approved.
 *
 * Total and synchronous, like everything on the credential path: nothing here
 * throws, and every failure is `null`. A `null` carries no detail on purpose;
 * the caller's own refusal names the variable and the vault, and a diagnostic
 * that quoted a keychain error would be the one string in this system that
 * describes where a passphrase lives.
 */

import { readEnvFile, type SourceRunner, defaultSourceRunner } from "../core/env-file.js";
import type { ExecutionGrant } from "./contract.js";

/**
 * Resolve `variable` from the source map at `envFilePath`, under `grant`.
 *
 * Returns the value, or `null` for every other outcome: no grant, a `consumed`
 * grant from a path where no token was spent, no file, a file this runtime will
 * not read (wrong mode, unparseable), no line for this variable, an `env:` line
 * (which asserts the value comes from the shell and resolves to nothing on its
 * own), a helper that is missing or declined, or an empty result.
 *
 * Not re-exported anywhere. `adapters/vault-provider.ts` is its only caller, and
 * `tests/vault-provider.test.ts` pins that.
 */
export function passphraseUnderGrant(
  grant: ExecutionGrant | null,
  envFilePath: string,
  variable: string,
  runner: SourceRunner = defaultSourceRunner,
): string | null {
  // The window is the whole authorization. No grant at all, or a spent-phase
  // grant from a path where no human was asked (supervised, autonomous: no
  // token was spent), and this function has nothing to offer.
  if (grant === null) return null;
  if (grant.phase === "consumed") {
    if (typeof grant.tokenSha256 !== "string" || grant.tokenSha256.length === 0) return null;
  }
  if (variable.length === 0) return null;

  const file = readEnvFile(envFilePath);
  if (!file.ok || !file.present) return null;

  const entry = file.entries.find((candidate) => candidate.key === variable);
  if (entry === undefined) return null;

  if (entry.kind === "literal") {
    return entry.argument.length === 0 ? null : entry.argument;
  }
  if (entry.kind === "env") {
    // `env:` says "this one comes from the shell that launched you". The shell
    // that launched this one did not carry it, which is why we are here.
    return null;
  }

  let outcome;
  try {
    outcome =
      entry.kind === "keychain"
        ? runner.keychain(entry.argument)
        : runner.secretService(entry.argument);
  } catch {
    return null;
  }
  if (!outcome.ok || outcome.value.length === 0) return null;
  return outcome.value;
}
