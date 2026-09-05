/**
 * `approval setup` — the interactive configuration family (SPEC.md §5.2, §10.1).
 *
 * APRV-73 gave `.approval/env` a format and `approval env` a reader. This verb
 * is the writer, and it is the only one: it establishes the things an operator
 * must have before any gate operation works — a declared human identity, a
 * vault passphrase, a sampling secret, a live Telegram bot and chat, and an
 * adapter's credentials — by putting each VALUE where that kind of value
 * belongs and each SOURCE in `.approval/env`.
 *
 * ## Who lives where
 *
 * This file holds the three subcommands whose subject is a value this runtime
 * MINTS or a name it records, plus the dispatch:
 *
 * ```
 * setup identity                 # APPROVAL_HUMAN, in this file
 * setup vault                    # the vault passphrase, in this file
 * setup sampling                 # the audit sampling secret, in this file
 * setup checkpoint               # cli/setup-checkpoint.ts (the vault + a print)
 * setup channel <name>           # cli/setup-channel.ts  (keystore + .approval/env)
 * setup adapter <name>           # cli/setup-adapter.ts  (the vault)
 * setup service                  # cli/setup-service.ts  (a launchd/systemd unit)
 * ```
 *
 * The last two are **two nouns and not one list**, and the split is SPEC.md
 * §4's: a CHANNEL surfaces requests and collects decisions and holds no state,
 * so its setup fills the keystore and `.approval/env`; an ADAPTER executes side
 * effects and holds credentials, so its setup fills the vault.
 * An older build spelled the Telegram one without the `channel` noun, and that
 * form is gone (APRV-79): the dispatch answers it with the new one and exits 2
 * rather than aliasing it, because an alias would leave two spellings of a
 * distinction the SPEC draws on purpose.
 *
 * Everything the three files share — the dependency bag, the keystore seam, the
 * front matter, the human-only gate, the service names, the plaintext-literal
 * offer — is `cli/setup-common.ts`, which imports from none of them. The
 * conversation `setup channel|adapter` both run is `cli/setup-flow.ts`.
 *
 * ## The order these run in
 *
 * Nothing enforced it and nothing said it, which APRV-76 noticed the hard way.
 * It is:
 *
 * ```
 * approval init                       # the directory and the .gitignore
 * (write APPROVAL.md)                 # the policy NAMES every variable below
 * approval setup identity             # APPROVAL_HUMAN
 * approval setup vault                # the passphrase, into the keystore
 * eval "$(approval env)"              # the ONLY thing that puts them in a shell
 * approval setup adapter <name>       # the adapter's credentials, into the vault
 * ```
 *
 * The policy comes before every `setup`, because each of them reads variable
 * NAMES out of it. The `eval` comes before `setup adapter`, because that
 * subcommand needs the passphrase's VALUE in the environment and will not read
 * `.approval/env` to get it (§11.1 invariant 7). `setup sampling` and
 * `setup channel telegram` slot in anywhere after the policy.
 *
 * ## What this verb is not allowed to do
 *
 * **It never appends to the log, never attests, and never edits `APPROVAL.md`.**
 * Configuration is not an authorized action, and the log is the record of
 * authorized actions; a "telegram configured" event would be a line in the one
 * file this project promises never to rewrite, saying something the log has no
 * business knowing. `tests/cli-setup.test.ts` byte-compares `events.jsonl`
 * across a complete run of every subcommand to keep that true by assertion.
 * When a policy line is needed (the sampling secret's name), this verb PRINTS
 * the `approval policy amend` invocation and stops: an amendment is a human
 * ceremony with an attestation at the end of it, and a setup wizard that
 * silently edited an attested policy would be forging the sign-off.
 *
 * It writes exactly three things: lines in `.approval/env`, through a writer
 * that preserves every other line and comment (`core/env-file.ts`), items in
 * the OS keystore, and entries in the vault (`setup adapter` only).
 *
 * ## Interactive or nothing
 *
 * Every subcommand refuses when stdin is not a terminal, or when `--json` was
 * given, and exits 2 printing THE EXACT NON-INTERACTIVE ALTERNATIVE — the
 * `security add-generic-password` line to run, or the `.approval/env` line to
 * add, or the `export` to put in a shell profile. This is not a wizard being
 * precious about its terminal. A `setup` that could be driven from a pipe would
 * be a way for a CI job or an agent to write `APPROVAL_HUMAN` and a keystore
 * item, which is precisely the boundary §11 draws: identity is config-declared,
 * so establishing it must be an act of the human at the machine. The refusal
 * text is the documented scripted path, so nobody has to reverse-engineer one.
 *
 * `setup identity` is EXEMPT from the human-only `--as` gate that every other
 * subcommand carries, and the exemption is not a hole: identity is what that
 * gate reads. A verb that demanded `APPROVAL_HUMAN` before it would let you set
 * `APPROVAL_HUMAN` could only ever be run by someone who did not need it. The
 * control on this path is the terminal itself.
 *
 * ## Answers, and answering again (APRV-90)
 *
 * Every typed question in this family runs through `prompt.ts`'s `askUntil`: a
 * wrong answer is one line saying what was wrong and the same question again,
 * never an exit code with a help page under it. `setup identity` also
 * NORMALISES what it is given — `carter` is recorded as `human:carter`, and
 * `human:carter` is taken as it stands ({@link identityFromAnswer}). The prompt
 * still prints the `human:` prefix, because the prefix is what distinguishes
 * the actor kinds the human-only verbs refuse, but nobody has to retype a
 * prefix the question already showed them. `agent:` and `system:` are refused
 * with the sentence that names why, as a reason to answer again.
 *
 * ## Where a secret goes, and how it gets there
 *
 * Three service names, one per secret, documented so an operator can find them
 * with `security find-generic-password` or `secret-tool lookup` by hand:
 * `approval-tg-token`, `approval-vault-passphrase`, `approval-sampling-secret`.
 *
 * - **macOS** (`darwin` and `security` on PATH) → `keychain:<service>`;
 * - **Linux with `secret-tool`** → `secret-service:<service>` (the same string
 *   is the label, so the two platforms name one secret one way);
 * - **neither** → the operator is OFFERED a plaintext literal in
 *   `.approval/env`, and must type `yes` in full to take it, having been shown
 *   the same warning `approval env --check` will print at them forever after.
 *   §5.2 permits literals for a stated reason, and refusing here would only
 *   move the value into a shell profile where nothing can see it to report it.
 *
 * **A value the operator already holds is never handled by this process.** The
 * Telegram token on macOS is collected by `security`'s OWN no-echo prompt: we
 * spawn `security add-generic-password … -w` WITH NO VALUE and with inherited
 * stdio, Apple's prompt reads it from the terminal, and the token reaches this
 * runtime only afterwards, on the stdout of a `find-generic-password -w` read
 * that puts nothing in an argv either. Off macOS it comes through
 * `Prompter.readSecret`, which at least keeps it off the screen.
 *
 * **A value we generate ourselves is a different question**, and it is the one
 * place this family makes a trade rather than following a rule. The vault
 * passphrase and the sampling secret are `randomBytes(32)`, minted in this
 * process, so they are already in this process and there is nobody to prompt.
 * They reach the keystore by STDIN first: `security add-generic-password -w`
 * with the value written to its stdin twice (the prompt asks for confirmation),
 * and `secret-tool store`, which documents stdin as its input. Only if the
 * stdin form FAILS does the fallback put the value in an argv (`-w <value>`),
 * and then the outcome says so out loud. That residual exposure is a value
 * minted one millisecond earlier, never used, visible in `ps` to the same user
 * who is running the command and to root — which is the boundary §11 already
 * declares undefended. It is accepted for generated values and for nothing
 * else: no path in this family ever puts an operator's own token in an argv.
 *
 * **And there is one standing exception to the rule above, which
 * `setup adapter <name>` takes.** A credential bound for the VAULT must pass
 * through this process, because the vault is not a helper with a prompt: it is
 * a file this runtime encrypts, so `setCredential` needs the bytes. There is
 * nothing to delegate the typing to and no third party to hold the value. The
 * secret is read with `Prompter.readSecret` (no echo), handed straight to the
 * cipher, and never printed, logged, or placed in an argv — which is exactly
 * what `approval vault set` already does when a human pastes a credential onto
 * its stdin. The rule is "never handle a value someone else can hold for you";
 * for the vault nobody can, so it is stated here rather than left to look like
 * an oversight.
 *
 * ## Seams
 *
 * The prompter, the keystore, and `fetch` are injected. The alternative is a
 * test suite that needs a terminal, writes to the developer's real Keychain,
 * and talks to the real Bot API — and the third of those would put a real bot
 * token in a test run. `tests/cli-setup.test.ts` drives all three through fakes
 * and the mock Bot API on loopback, and the spawned-CLI cases never get past
 * the terminal check, so nothing under `npm test` can reach a keystore at all.
 */

import { HUMAN_ACTOR_ENV, resolveHumanActor } from "../core/attest.js";
import { readEnvFile, upsertEnvFileEntries, type EnvFileRefusal } from "../core/env-file.js";
import { passphraseEnvFor, vaultExists, vaultPathFor } from "../core/vault.js";
import { EXIT_IO, EXIT_OK } from "./exit-codes.js";
import {
  SETUP_CHANNEL_HELP,
  SETUP_HELP,
  SETUP_IDENTITY_HELP,
  SETUP_SAMPLING_HELP,
  SETUP_VAULT_HELP,
} from "./help.js";
import { commandSetupAdapter } from "./setup-adapter.js";
import { commandSetupCheckpoint } from "./setup-checkpoint.js";
import { RENAMED_NOTICE, commandSetupChannel } from "./setup-channel.js";
import { commandSetupService } from "./setup-service.js";
import {
  DEFAULT_SAMPLING_ENV,
  emitRefusal,
  front,
  offerLiteral,
  promptRefusal,
  requireHuman,
  retrievalCommand,
  samplingEnvName,
  schemeFor,
  storageCommand,
  usageError,
  type Context,
  type HintContext,
  type SetupDeps,
} from "./setup-common.js";
import { PLAN_PHRASES, planWrites, reportLeftAlone } from "./setup-flow.js";
import type { Streams } from "./main.js";
import { askUntil, type Prompter } from "./prompt.js";

// ---------------------------------------------------------------------------
// Replacing what is already there
// ---------------------------------------------------------------------------

/**
 * Which of `keys` already have a line, asked about BEFORE any work is done.
 *
 * Up front rather than at write time so that declining costs nothing: a
 * confirmation asked after the keystore item had already been replaced would be
 * a question whose "no" no longer means anything.
 *
 * **No previous VALUE is ever printed**, not even for `APPROVAL_HUMAN`, whose
 * value is not a secret. The file may legitimately hold a plaintext literal on
 * any line (§5.2), the operator chose that with a warning, and a verb that
 * echoed "replacing 7654321:AA…?" would undo the choice on their behalf.
 *
 * The asking itself is {@link planWrites} (APRV-78), shared with the credential
 * flow `setup channel|adapter` run. What stays here is the part that is about
 * THIS file: reading it, and turning a read refusal into a refusal the caller
 * can return. The sentences are unchanged, deliberately — an operator who has
 * run `setup` before should not be told the same fact in new words.
 */
function planReplacements(
  streams: Streams,
  prompter: Prompter,
  envPath: string,
  keys: string[],
): { ok: true; write: string[]; skipped: string[] } | { ok: false; refusal: EnvFileRefusal } {
  const file = readEnvFile(envPath);
  if (!file.ok) return { ok: false, refusal: file };

  const present = new Set(file.entries.map((entry) => entry.key));
  const plan = planWrites(streams, prompter, present, envPath, keys, PLAN_PHRASES["env-file"]);
  return { ok: true, write: plan.write, skipped: plan.skipped };
}

/** Report what was left alone, so a re-run's "no" is visible in the output. */
function reportSkipped(streams: Streams, envPath: string, skipped: string[]): void {
  reportLeftAlone(streams, envPath, skipped, PLAN_PHRASES["env-file"]);
}

/**
 * Write the lines that survived {@link planReplacements}, and report.
 *
 * `values` may contain a plaintext secret on the no-keystore path, so the
 * report names the KEY and the SOURCE FORM and never the line's value.
 */
function writeLines(
  streams: Streams,
  envPath: string,
  wanted: Array<{ key: string; value: string; describe: string }>,
  allowed: string[],
): { ok: true; wrote: number } | { ok: false; code: number } {
  const entries = wanted.filter((entry) => allowed.includes(entry.key));
  if (entries.length === 0) return { ok: true, wrote: 0 };

  const result = upsertEnvFileEntries(
    envPath,
    entries.map((entry) => ({ key: entry.key, value: entry.value })),
  );
  if (!result.ok) return { ok: false, code: emitRefusal(streams, result) };

  if (result.created) streams.out(`created ${envPath} (mode 0600)\n`);
  for (const entry of entries) {
    streams.out(`  ${entry.key} -> ${entry.describe}\n`);
  }
  return { ok: true, wrote: entries.length };
}

// ---------------------------------------------------------------------------
// Storing a secret this runtime minted
// ---------------------------------------------------------------------------

interface Stored {
  /** The `.approval/env` VALUE for this secret: a scheme, or the secret itself. */
  value: string;
  /** How to describe the line in output. Never the value. */
  describe: string;
}

/**
 * Put a GENERATED secret where this machine keeps secrets, and say where.
 *
 * `null` means the operator declined the plaintext offer, or the keystore
 * refused; either way nothing was written and the caller stops.
 *
 * This stays in this file rather than in `setup-common.ts` because `vault` and
 * `sampling` are the only two subcommands that MINT a value: a channel's token
 * and an adapter's password are the operator's, and the whole argument in the
 * module doc turns on that difference.
 */
function storeGeneratedSecret(
  streams: Streams,
  context: Context,
  service: string,
  what: string,
): Stored | { failed: true; code: number } | null {
  if (context.backend === "none") {
    const value = context.generate();
    if (!offerLiteral(streams, context.prompter, context.envPath, what)) return null;
    return { value, describe: `a plaintext literal in ${context.envPath} (PLAINTEXT)` };
  }

  const value = context.generate();
  const outcome = context.keystore.storeGenerated(service, value);
  if (!outcome.ok) {
    streams.err(
      `approval: the ${what} could not be stored (${outcome.message}); nothing was written to ${context.envPath}\n`,
    );
    return { failed: true, code: EXIT_IO };
  }
  streams.out(
    `stored a freshly generated ${what} as ${schemeFor(context.backend, service) ?? service}\n`,
  );
  if (outcome.viaArgv) {
    streams.out(
      `  note: this build of the helper would not take the value on stdin, so it went\n  through its argv and was briefly visible in \`ps\` to your own user. That is\n  accepted for a value generated one moment earlier and never used; a token you\n  brought with you is never passed that way.\n`,
    );
  }
  streams.out(`  read it back with: ${retrievalCommand(context.backend, service)}\n`);
  return {
    value: schemeFor(context.backend, service) as string,
    describe: schemeFor(context.backend, service) as string,
  };
}

// ---------------------------------------------------------------------------
// approval setup identity
// ---------------------------------------------------------------------------

/**
 * One typed answer to `human identity (human:<id>):`, as an identity (APRV-90).
 *
 * **A bare id is accepted and normalised.** The prompt prints the `human:`
 * prefix because the prefix is load-bearing — actors are `human:`, `agent:` or
 * `system:`, and the human-only verbs refuse the other two — so an operator who
 * has never read SPEC.md §11 learns the shape from the question itself. Making
 * them retype a prefix the prompt just printed adds a failure path and teaches
 * nothing further, so `carter` becomes `human:carter` and `human:carter` is
 * taken as it stands.
 *
 * An answer with a colon in it is taken as a FULL actor and validated as one,
 * which is what makes `agent:claude` a refusal rather than `human:agent:claude`.
 * That refusal is a reason handed back to {@link askUntil}, so the operator is
 * asked again rather than dropped out of the verb.
 */
export function identityFromAnswer(
  answer: string,
): { ok: true; value: string } | { ok: false; reason: string } {
  const typed = answer.trim();
  if (typed.length === 0) {
    return {
      ok: false,
      reason: `nothing was entered; type your id (for example carter, which is recorded as human:carter)`,
    };
  }
  const candidate = typed.includes(":") ? typed : `human:${typed}`;
  if (resolveHumanActor({ actor: candidate }) === null) {
    return {
      ok: false,
      reason: `${JSON.stringify(typed)} is not a human identity: it must match ^human:.+ (for example human:alice, or just alice). An agent: or system: actor cannot be declared here — those are what the human-only verbs refuse`,
    };
  }
  return { ok: true, value: candidate };
}

const IDENTITY_HINT = (where: HintContext): string =>
  `  # in your shell profile, which is where a declared identity belongs:\n  export ${HUMAN_ACTOR_ENV}=human:<id>\n\n  # or, recorded for \`approval env\` to hand back to you:\n  printf '%s\\n' '${HUMAN_ACTOR_ENV}=human:<id>' >> ${where.envPath}\n  chmod 600 ${where.envPath}`;

/**
 * `approval setup identity` — declare who the human is.
 *
 * EXEMPT from the human-only gate, and the module doc says why: this is the
 * verb that creates the thing the gate reads.
 */
export function commandSetupIdentity(
  argv: string[],
  streams: Streams,
  cwd: string,
  deps: SetupDeps = {},
): number {
  const outcome = front(
    "identity",
    argv,
    streams,
    cwd,
    deps,
    SETUP_IDENTITY_HELP,
    IDENTITY_HINT,
  );
  if (outcome.kind === "handled") return outcome.code;
  const context = outcome;

  const extra = context.positionals[0];
  if (extra !== undefined) {
    return usageError(
      streams,
      false,
      `unexpected argument ${JSON.stringify(extra)}`,
      SETUP_IDENTITY_HELP,
    );
  }

  streams.out(
    `approval setup identity — declares WHO the human is, in ${HUMAN_ACTOR_ENV}.\n\nIdentity here is declared, not proved: anyone who can set this variable and\nwrite to the log can act as this human. Nothing is appended to the log by this\nverb.\n\n`,
  );

  const plan = planReplacements(streams, context.prompter, context.envPath, [HUMAN_ACTOR_ENV]);
  if (!plan.ok) return emitRefusal(streams, plan.refusal);
  if (plan.write.length === 0) {
    reportSkipped(streams, context.envPath, plan.skipped);
    return EXIT_OK;
  }

  const asked = askUntil(
    streams,
    context.prompter,
    `human identity (human:<id>, or just <id>): `,
    identityFromAnswer,
  );
  if (!asked.ok) {
    // One line, and no help page: the question was on screen and the answer to
    // it was wrong or withdrawn, which is not a mangled command line (APRV-90).
    return promptRefusal(
      streams,
      asked.reason === "aborted"
        ? "no identity was entered; nothing was written"
        : `no human identity after ${String(asked.attempts)} attempts; nothing was written`,
    );
  }
  const identity = asked.value;

  const written = writeLines(
    streams,
    context.envPath,
    [{ key: HUMAN_ACTOR_ENV, value: identity, describe: identity }],
    plan.write,
  );
  if (!written.ok) return written.code;
  reportSkipped(streams, context.envPath, plan.skipped);

  streams.out(
    `\nThat line is INERT until you evaluate it: no verb reads ${context.envPath} on its\nown. Establish it in this shell with:\n\n  eval "$(approval env)"\n`,
  );
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// approval setup vault
// ---------------------------------------------------------------------------

const VAULT_HINT = (where: HintContext): string =>
  `  # 1. store a passphrase you generated yourself (no value on this command line;\n  #    the helper prompts for it with no echo):\n  ${storageCommand(where.kind === "none" ? "keychain" : where.kind, where.services.vaultPassphrase)}\n\n  # 2. record where it lives (the name carries this instance's id; see \`approval doctor\`):\n  printf '%s\\n' '${where.passphraseEnv}=${schemeFor(where.kind === "none" ? "keychain" : where.kind, where.services.vaultPassphrase) ?? ""}' >> ${where.envPath}\n  chmod 600 ${where.envPath}`;

/** `approval setup vault` — mint and store the vault passphrase. HUMAN-ONLY. */
export function commandSetupVault(
  argv: string[],
  streams: Streams,
  cwd: string,
  deps: SetupDeps = {},
): number {
  const outcome = front("vault", argv, streams, cwd, deps, SETUP_VAULT_HELP, VAULT_HINT);
  if (outcome.kind === "handled") return outcome.code;
  const context = outcome;

  const human = requireHuman(context.flags, streams, SETUP_VAULT_HELP, "vault");
  if (!human.ok) return human.code;

  const variable = passphraseEnvFor(context.load);
  streams.out(
    `approval setup vault — mints the passphrase for ${vaultPathFor(context.logPath)} and puts\nit where this machine keeps secrets. The policy names the VARIABLE\n(vault.passphrase_env${variable === "APPROVAL_VAULT_PASSPHRASE" ? ", defaulted here" : ""}) and never the value.\n\n`,
  );

  // A vault already encrypted under a different passphrase is not recoverable
  // from a new one, and this verb generates rather than asks, so the warning
  // has to come before the generation and not after it.
  if (vaultExists(vaultPathFor(context.logPath))) {
    streams.out(
      `WARNING: ${vaultPathFor(context.logPath)} already exists. It is encrypted under the\npassphrase you are about to REPLACE, and a vault cannot be re-keyed by changing\nthe variable: every credential in it becomes unreadable. Store the current\npassphrase somewhere first, or remove the vault, if you mean to continue.\n\n`,
    );
    if (!context.prompter.confirm("generate a new passphrase anyway?")) {
      streams.out("aborted: nothing was generated, stored, or written\n");
      return EXIT_OK;
    }
  }

  const plan = planReplacements(streams, context.prompter, context.envPath, [variable]);
  if (!plan.ok) return emitRefusal(streams, plan.refusal);
  if (plan.write.length === 0) {
    reportSkipped(streams, context.envPath, plan.skipped);
    return EXIT_OK;
  }

  const stored = storeGeneratedSecret(
    streams,
    context,
    context.services.vaultPassphrase,
    "vault passphrase",
  );
  if (stored === null) return EXIT_OK;
  if ("failed" in stored) return stored.code;

  const written = writeLines(
    streams,
    context.envPath,
    [{ key: variable, value: stored.value, describe: stored.describe }],
    plan.write,
  );
  if (!written.ok) return written.code;
  reportSkipped(streams, context.envPath, plan.skipped);

  streams.out(
    `\nThe passphrase is in ${variable}, and its value was not printed here or anywhere\nelse — there is no verb in this CLI that prints it. Establish it with:\n\n  eval "$(approval env)"\n\nthen \`approval vault set <name>\` will work.\n`,
  );
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// approval setup sampling
// ---------------------------------------------------------------------------

const SAMPLING_HINT = (where: HintContext): string =>
  `  # 1. store the secret (the helper prompts; no value on this command line):\n  ${storageCommand(where.kind === "none" ? "keychain" : where.kind, where.services.samplingSecret)}\n\n  # 2. record where it lives (the name carries this instance's id; see \`approval doctor\`):\n  printf '%s\\n' '${where.samplingEnv}=${schemeFor(where.kind === "none" ? "keychain" : where.kind, where.services.samplingSecret) ?? ""}' >> ${where.envPath}\n  chmod 600 ${where.envPath}\n\n  # 3. name the variable in the policy, through the amendment ceremony:\n  #    audit: { sampling_secret_env: ${where.samplingEnv} }\n  approval policy amend`;

/** `approval setup sampling` — mint and store the audit sampling secret. HUMAN-ONLY. */
export function commandSetupSampling(
  argv: string[],
  streams: Streams,
  cwd: string,
  deps: SetupDeps = {},
): number {
  const outcome = front("sampling", argv, streams, cwd, deps, SETUP_SAMPLING_HELP, SAMPLING_HINT);
  if (outcome.kind === "handled") return outcome.code;
  const context = outcome;

  const human = requireHuman(context.flags, streams, SETUP_SAMPLING_HELP, "sampling");
  if (!human.ok) return human.code;

  const declared = samplingEnvName(context.load);
  const variable = declared ?? DEFAULT_SAMPLING_ENV;

  streams.out(
    `approval setup sampling — mints the operator-held secret that selects which\nsupervised actions are sampled for retrospective review.\n\nSelection is HMAC-SHA-256 over the event hash under this secret. Seeding from\nevent content alone is forbidden: the agent authoring the event controls that\ncontent and could search it until its action falls outside the sample.\n\n`,
  );

  const plan = planReplacements(streams, context.prompter, context.envPath, [variable]);
  if (!plan.ok) return emitRefusal(streams, plan.refusal);
  if (plan.write.length === 0) {
    reportSkipped(streams, context.envPath, plan.skipped);
    return EXIT_OK;
  }

  const stored = storeGeneratedSecret(
    streams,
    context,
    context.services.samplingSecret,
    "sampling secret",
  );
  if (stored === null) return EXIT_OK;
  if ("failed" in stored) return stored.code;

  const written = writeLines(
    streams,
    context.envPath,
    [{ key: variable, value: stored.value, describe: stored.describe }],
    plan.write,
  );
  if (!written.ok) return written.code;
  reportSkipped(streams, context.envPath, plan.skipped);

  if (declared === null) {
    // The value is in place and the sampler is still off, which is the honest
    // report: §5.2 turns sampling on from the POLICY, and this verb does not
    // edit a policy file. What it can do is hand over the exact ceremony.
    streams.out(
      `\nYour policy names no audit.sampling_secret_env, so the secret was recorded under\nthe conventional name ${variable} and SAMPLING IS STILL OFF. It stays off until\nthe policy names the variable — a policy that names none disables sampling, and\nthis verb does not edit an attested policy file.\n\nAdd this block, through the ceremony that attests it:\n\n  audit:\n    sampling_secret_env: ${variable}\n\n  approval policy amend\n`,
    );
  } else {
    streams.out(
      `\nYour policy already names ${variable} (audit.sampling_secret_env), so sampling is\nlive once the variable is in the environment:\n\n  eval "$(approval env)"\n`,
    );
  }
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** `approval setup <identity|vault|sampling|channel <name>|adapter <name>>`. */
export function commandSetup(
  argv: string[],
  streams: Streams,
  cwd: string,
  deps: SetupDeps = {},
): number | Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  const json = argv.includes("--json");

  if (sub === undefined) {
    return usageError(streams, json, "missing subcommand for `approval setup`", SETUP_HELP);
  }
  if (sub === "--help" || sub === "-h" || sub === "help") {
    streams.out(`${SETUP_HELP}\n`);
    return EXIT_OK;
  }
  if (sub === "identity") return commandSetupIdentity(rest, streams, cwd, deps);
  if (sub === "vault") return commandSetupVault(rest, streams, cwd, deps);
  if (sub === "sampling") return commandSetupSampling(rest, streams, cwd, deps);
  // APRV-257. The fourth subcommand whose subject is a value this runtime
  // MINTS, and the first whose public half belongs in APPROVAL.md rather than
  // in `.approval/env`. It prints that half and the amendment ceremony and
  // edits no policy file, exactly as `setup sampling` does with its variable
  // name — the private half goes to the vault, like an adapter's credentials.
  if (sub === "checkpoint") return commandSetupCheckpoint(rest, streams, cwd, deps);
  // `channel` and `adapter` are the two subcommands with a subject of their
  // own: the name selects the entry, so it is a positional and not a flag.
  if (sub === "channel") return commandSetupChannel(rest, streams, cwd, deps);
  if (sub === "adapter") return commandSetupAdapter(rest, streams, cwd, deps);
  // APRV-110. The one subcommand whose subject is neither a value this runtime
  // mints nor a credential the operator holds: it writes the unit file that
  // starts `approval up` at login, and it never copies a value into it.
  if (sub === "service") return commandSetupService(rest, streams, cwd, deps);
  // The one former spelling that gets a sentence rather than "unknown
  // subcommand". It is NOT an alias: it refuses at exit 2 and says what to run.
  // See {@link RENAMED_NOTICE} and this file's module doc.
  if (sub === "telegram") return usageError(streams, json, RENAMED_NOTICE, SETUP_CHANNEL_HELP);
  return usageError(
    streams,
    json,
    `unknown subcommand ${JSON.stringify(sub)} for \`approval setup\``,
    SETUP_HELP,
  );
}
