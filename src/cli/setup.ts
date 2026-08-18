/**
 * `approval setup` — interactive configuration (SPEC.md §5.2, §10.1; APRV-74).
 *
 * APRV-73 gave `.approval/env` a format and `approval env` a reader. This verb
 * is the writer, and it is the only one: it establishes the four things an
 * operator must have before any gate operation works — a declared human
 * identity, a vault passphrase, a sampling secret, and a live Telegram bot and
 * chat — by putting each VALUE in the OS keystore and each SOURCE in
 * `.approval/env`.
 *
 * ## What this verb is not allowed to do
 *
 * **It never appends to the log, never attests, and never edits `APPROVAL.md`.**
 * Configuration is not an authorized action, and the log is the record of
 * authorized actions; a "telegram configured" event would be a line in the one
 * file this project promises never to rewrite, saying something the log has no
 * business knowing. `tests/cli-setup.test.ts` byte-compares `events.jsonl`
 * across a complete run of all four subcommands to keep that true by assertion.
 * When a policy line is needed (the sampling secret's name), this verb PRINTS
 * the `approval policy amend` invocation and stops: an amendment is a human
 * ceremony with an attestation at the end of it, and a setup wizard that
 * silently edited an attested policy would be forging the sign-off.
 *
 * It writes exactly two things: lines in `.approval/env`, through a writer that
 * preserves every other line and comment (`core/env-file.ts`), and items in the
 * OS keystore.
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
 * `setup identity` is EXEMPT from the human-only `--as` gate that `vault` and
 * `sampling` carry, and the exemption is not a hole: identity is what that gate
 * reads. A verb that demanded `APPROVAL_HUMAN` before it would let you set
 * `APPROVAL_HUMAN` could only ever be run by someone who did not need it. The
 * control on this path is the terminal itself.
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
 * {@link readSecret}, which at least keeps it off the screen.
 *
 * **A value we generate ourselves is a different question**, and it is the one
 * place this file makes a trade rather than following a rule. The vault
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
 * else: no path in this file ever puts an operator's own token in an argv.
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

import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { isAbsolute, resolve as resolvePathSegments } from "node:path";

import { HUMAN_ACTOR_ENV, resolveHumanActor } from "../core/attest.js";
import {
  defaultSourceRunner,
  envFilePathFor,
  readEnvFile,
  upsertEnvFileEntries,
  type EnvFileRefusal,
} from "../core/env-file.js";
import { loadPolicy, type PolicyLoadResult } from "../core/policy-load.js";
import { telegramChatEnvFor, telegramTokenEnvFor } from "../core/telegram-config.js";
import { passphraseEnvFor, vaultExists, vaultPathFor } from "../core/vault.js";
import { TELEGRAM_DEFAULT_API_BASE, type TelegramFetch } from "../channels/telegram.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import { EXIT_INTEGRITY, EXIT_IO, EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import {
  SETUP_HELP,
  SETUP_IDENTITY_HELP,
  SETUP_SAMPLING_HELP,
  SETUP_TELEGRAM_HELP,
  SETUP_VAULT_HELP,
} from "./help.js";
import type { Streams } from "./main.js";
import { DEFAULT_LOG_PATH, resolvePath } from "./paths.js";
import { createPrompter, type Prompter } from "./prompt.js";

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * The keystore item names, one per secret. Fixed strings rather than a flag:
 * an operator reading `.approval/env` sees the service name in the file itself
 * (`keychain:approval-tg-token`), so the name is already discoverable, and a
 * `--service-prefix` would add a way for two checkouts to disagree about which
 * item is which without adding a capability the file's own value does not
 * already have.
 */
export const SERVICE_TELEGRAM_TOKEN = "approval-tg-token";
export const SERVICE_VAULT_PASSPHRASE = "approval-vault-passphrase";
export const SERVICE_SAMPLING_SECRET = "approval-sampling-secret";

/**
 * The variable a sampling secret goes into when the policy names none. The
 * value is stored either way; what the operator is then told to do is add the
 * `audit.sampling_secret_env` line, because until the POLICY names a variable
 * the sampler stays off (SPEC.md §5.2) and no amount of environment fixes that.
 */
export const DEFAULT_SAMPLING_ENV = "APPROVAL_SAMPLING_SECRET";

/** The long-poll `getUpdates` asks for, in seconds. */
const POLL_TIMEOUT_SECONDS = 10;

/** doctor's probe timeout, for the calls that answer immediately. */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * The abort for the long poll is the poll's own timeout PLUS the probe's slack:
 * a `getUpdates` that is SUPPOSED to hang for ten seconds must not be aborted
 * at ten seconds for the wrong reason — the same reasoning
 * `TelegramConfig.requestTimeoutMs` documents.
 */

/** How many times the human is asked to send a message before we give up. */
const CHAT_DISCOVERY_ATTEMPTS = 3;

const FLAGS: Record<string, FlagKind> = {
  "--policy": "string",
  "--dir": "string",
  "--log": "string",
  "--api-base": "string",
  "--as": "string",
  "--json": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

// ---------------------------------------------------------------------------
// The keystore seam
// ---------------------------------------------------------------------------

/** Which credential store this machine has, as a closed set. */
export type KeystoreKind = "keychain" | "secret-service" | "none";

/** What a store attempt did. `viaArgv` is reported, never hidden. */
export type StoreOutcome =
  | {
      ok: true;
      /**
       * The value passed through the helper's argv rather than its stdin. True
       * only on the generated-secret fallback path; see the module doc.
       */
      viaArgv: boolean;
    }
  | { ok: false; message: string };

/**
 * The keystore operations `setup` needs, injectable for exactly the reason
 * {@link defaultSourceRunner}'s seam exists: no test in this repository may
 * touch a real Keychain or a real secret service, and the way to guarantee that
 * is for the tests to hand over a fake rather than for the runtime to grow a
 * test-only flag.
 */
export interface KeystoreRunner {
  /** What is available here. Consulted once per run. */
  kind(): KeystoreKind;
  /**
   * Store a value THIS PROCESS GENERATED. Prefers the helper's stdin; may fall
   * back to its argv, and says which it did.
   */
  storeGenerated(service: string, value: string): StoreOutcome;
  /**
   * Have the HELPER'S OWN no-echo prompt collect the value from the terminal.
   * The value never enters this process. macOS and `secret-tool` both support
   * this; there is no such thing on a machine with neither.
   */
  storePrompted(service: string): StoreOutcome;
  /** Read a stored value back. The value arrives on stdout, never in an argv. */
  read(service: string): { ok: true; value: string } | { ok: false; message: string };
}

/** Is `binary` on PATH? An ENOENT from a spawn is the honest way to ask. */
function onPath(binary: string, probeArgs: string[]): boolean {
  const result = spawnSync(binary, probeArgs, { encoding: "utf8", stdio: "ignore" });
  return (result.error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT";
}

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The real one. Nothing in the test suite constructs it. */
export const defaultKeystoreRunner: KeystoreRunner = {
  kind(): KeystoreKind {
    if (process.platform === "darwin" && onPath("security", ["help"])) return "keychain";
    // `secret-tool` with no arguments prints its usage and exits non-zero,
    // which is all this probe needs: it touches no keyring and unlocks nothing.
    if (onPath("secret-tool", [])) return "secret-service";
    return "none";
  },

  storeGenerated(service: string, value: string): StoreOutcome {
    const backend = defaultKeystoreRunner.kind();
    if (backend === "secret-service") {
      // `secret-tool store` reads the secret from stdin. One canonical form,
      // no fallback needed, and the value is never in an argv.
      const stored = spawnSync(
        "secret-tool",
        ["store", "--label", service, "approval", service],
        { encoding: "utf8", input: value },
      );
      if (stored.error !== undefined) {
        return { ok: false, message: `secret-tool could not be run: ${detail(stored.error)}` };
      }
      return stored.status === 0
        ? { ok: true, viaArgv: false }
        : { ok: false, message: `secret-tool store exited ${String(stored.status)}` };
    }
    if (backend !== "keychain") {
      return { ok: false, message: "no OS keystore is available on this machine" };
    }

    const account = process.env["USER"] ?? userInfo().username;
    const base = ["add-generic-password", "-a", account, "-s", service, "-U"];

    // Attempt one: the value on `security`'s STDIN. Its `-w` with no argument
    // prompts twice (the value and its confirmation), so it is written twice.
    //
    // Exit status is NOT trusted as proof of a correct store. A probe against a
    // scratch keychain (APRV-74 review) showed `security … -w` with piped stdin
    // exiting 0 while leaving no findable item under the service name, which
    // is the worst outcome: a fallback that never triggers and a later lookup
    // that fails. So every attempt is followed by a read-back, and success is
    // "the keystore returns exactly the bytes we generated", nothing less.
    const piped = spawnSync("security", [...base, "-w"], {
      encoding: "utf8",
      input: `${value}\n${value}\n`,
    });
    if (piped.error === undefined && piped.status === 0) {
      const back = defaultKeystoreRunner.read(service);
      if (back.ok && back.value === value) return { ok: true, viaArgv: false };
    }

    // Attempt two, for GENERATED VALUES ONLY: the argv form. See the module doc
    // for exactly what is being accepted here and why it is not extended to a
    // value the operator brought with them.
    const argv = spawnSync("security", [...base, "-w", value], { encoding: "utf8" });
    if (argv.error !== undefined) {
      return { ok: false, message: `security could not be run: ${detail(argv.error)}` };
    }
    if (argv.status === 0) {
      const back = defaultKeystoreRunner.read(service);
      if (back.ok && back.value === value) return { ok: true, viaArgv: true };
      return {
        ok: false,
        message: `security add-generic-password reported success for service ${JSON.stringify(service)} but the read-back did not return the stored value; nothing this run wrote can be trusted, inspect the keychain by hand`,
      };
    }
    return {
      ok: false,
      message: `security add-generic-password exited ${String(argv.status)} for service ${JSON.stringify(service)}`,
    };
  },

  storePrompted(service: string): StoreOutcome {
    const backend = defaultKeystoreRunner.kind();
    if (backend === "keychain") {
      const account = process.env["USER"] ?? userInfo().username;
      // `stdio: "inherit"`: Apple's own prompt owns the terminal for the length
      // of this call, and the value it reads is never seen by this process.
      const result = spawnSync(
        "security",
        ["add-generic-password", "-a", account, "-s", service, "-U", "-w"],
        { stdio: "inherit" },
      );
      if (result.error !== undefined) {
        return { ok: false, message: `security could not be run: ${detail(result.error)}` };
      }
      return result.status === 0
        ? { ok: true, viaArgv: false }
        : { ok: false, message: `security add-generic-password exited ${String(result.status)}` };
    }
    if (backend === "secret-service") {
      const result = spawnSync(
        "secret-tool",
        ["store", "--label", service, "approval", service],
        { stdio: "inherit" },
      );
      if (result.error !== undefined) {
        return { ok: false, message: `secret-tool could not be run: ${detail(result.error)}` };
      }
      return result.status === 0
        ? { ok: true, viaArgv: false }
        : { ok: false, message: `secret-tool store exited ${String(result.status)}` };
    }
    return { ok: false, message: "no OS keystore is available on this machine" };
  },

  read(service: string): { ok: true; value: string } | { ok: false; message: string } {
    const backend = defaultKeystoreRunner.kind();
    const outcome =
      backend === "keychain"
        ? defaultSourceRunner.keychain(service)
        : defaultSourceRunner.secretService(service);
    return outcome.ok ? { ok: true, value: outcome.value } : { ok: false, message: outcome.message };
  },
};

/** The `.approval/env` scheme a backend writes. */
function schemeFor(kind: KeystoreKind, service: string): string | null {
  if (kind === "keychain") return `keychain:${service}`;
  if (kind === "secret-service") return `secret-service:${service}`;
  return null;
}

/** The command an operator runs by hand to see that the item is really there. */
function retrievalCommand(kind: KeystoreKind, service: string): string {
  return kind === "keychain"
    ? `security find-generic-password -a "$USER" -s ${service} -w`
    : `secret-tool lookup approval ${service}`;
}

/** The command an operator runs by hand to STORE the item, with no value in it. */
function storageCommand(kind: KeystoreKind, service: string): string {
  return kind === "secret-service"
    ? `secret-tool store --label ${service} approval ${service}`
    : `security add-generic-password -a "$USER" -s ${service} -U -w`;
}

// ---------------------------------------------------------------------------
// Dependencies and the front matter
// ---------------------------------------------------------------------------

/** Everything this verb reaches the world through. Defaults are the real ones. */
export interface SetupDeps {
  prompter?: Prompter | null;
  keystore?: KeystoreRunner;
  fetch?: TelegramFetch;
  apiBase?: string;
  /** Overridable so a test can assert on a value it chose. */
  generate?: () => string;
  /**
   * The `getUpdates` long poll, in seconds. Overridable for one reason: the
   * "nobody messaged the bot" path polls {@link CHAT_DISCOVERY_ATTEMPTS} times,
   * and a suite that spent thirty seconds proving a refusal is a suite people
   * stop running. Not a flag — no operator has a reason to change it.
   */
  pollTimeoutSeconds?: number;
}

function usageError(streams: Streams, json: boolean, message: string, helpText: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "usage", message } })}\n`);
  else streams.err(`approval: ${message}\n\n${helpText}\n`);
  return EXIT_USAGE;
}

function absolute(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolvePathSegments(cwd, value);
}

function refusalExitCode(refusal: EnvFileRefusal): number {
  return refusal.code === "env-file-io" || refusal.code === "env-file-mode"
    ? EXIT_IO
    : EXIT_INTEGRITY;
}

function emitRefusal(streams: Streams, refusal: EnvFileRefusal): number {
  streams.err(`approval: ${refusal.code}: ${refusal.message}\n`);
  return refusalExitCode(refusal);
}

interface Context {
  flags: Record<string, string | boolean>;
  positionals: string[];
  prompter: Prompter;
  keystore: KeystoreRunner;
  /**
   * Which keystore this machine has. Named `backend` rather than `kind` because
   * the outcome union around this context already discriminates on `kind`.
   */
  backend: KeystoreKind;
  load: PolicyLoadResult;
  logPath: string;
  envPath: string;
  apiBase: string;
  generate: () => string;
  pollTimeoutSeconds: number;
}

type FrontOutcome = { kind: "handled"; code: number } | ({ kind: "run" } & Context);

/**
 * `--help`, the paths, the policy, the terminal check.
 *
 * The terminal check has no `process.stdin.isTTY` in it, deliberately: the real
 * prompter refuses to construct without one ({@link createPrompter}), so "there
 * is no prompter" IS "there is no terminal", and a test that injects one has
 * not bypassed a check that a CI job could also bypass — it has supplied the
 * human's side of the conversation, which is the only thing a test can honestly
 * do here.
 */
function front(
  subcommand: string,
  argv: string[],
  streams: Streams,
  cwd: string,
  deps: SetupDeps,
  helpText: string,
  nonInteractiveHint: (context: { envPath: string; kind: KeystoreKind }) => string,
): FrontOutcome {
  const json = argv.includes("--json");
  const parsed = parseFlags(argv, FLAGS);
  if (!parsed.ok) return { kind: "handled", code: usageError(streams, json, parsed.message, helpText) };
  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${helpText}\n`);
    return { kind: "handled", code: EXIT_OK };
  }

  const logPath = resolvePath(stringFlag(parsed.flags, "--log"), DEFAULT_LOG_PATH, cwd);
  const envPath = envFilePathFor(logPath);
  const policyFlag = stringFlag(parsed.flags, "--policy");
  const dirFlag = stringFlag(parsed.flags, "--dir");
  const load = loadPolicy(
    policyFlag !== null
      ? { file: absolute(policyFlag, cwd) }
      : { dir: dirFlag === null ? cwd : absolute(dirFlag, cwd) },
  );

  const keystore = deps.keystore ?? defaultKeystoreRunner;
  const kind = keystore.kind();
  const prompter = deps.prompter ?? createPrompter(streams);

  if (json || prompter === null) {
    streams.err(
      `approval: \`approval setup ${subcommand}\` is interactive and ${
        json
          ? "--json was given"
          : "stdin is not a terminal"
      }. Nothing was written.\n\nIdentity in v0.1 is config-declared (SPEC.md §11), so establishing it — and the credentials beside it — is an act of the human at the machine, not something a pipe or a CI job can do. The non-interactive path is explicit, and here it is:\n\n${nonInteractiveHint({ envPath, kind })}\n\nThen check it with \`approval env --check\`, which prints no values.\n`,
    );
    return { kind: "handled", code: EXIT_USAGE };
  }

  return {
    kind: "run",
    flags: parsed.flags,
    positionals: parsed.positionals,
    prompter,
    keystore,
    backend: kind,
    load,
    logPath,
    envPath,
    apiBase: deps.apiBase ?? stringFlag(parsed.flags, "--api-base") ?? TELEGRAM_DEFAULT_API_BASE,
    generate: deps.generate ?? (() => randomBytes(32).toString("base64")),
    pollTimeoutSeconds: deps.pollTimeoutSeconds ?? POLL_TIMEOUT_SECONDS,
  };
}

/** The human-only rule, spelled exactly as `vault set` spells it. */
function requireHuman(
  flags: Record<string, string | boolean>,
  streams: Streams,
  helpText: string,
  verb: string,
): { ok: true; actor: string } | { ok: false; code: number } {
  const asFlag = stringFlag(flags, "--as");
  const actor = resolveHumanActor(asFlag === null ? {} : { actor: asFlag });
  if (actor !== null) return { ok: true, actor };
  return {
    ok: false,
    code: usageError(
      streams,
      false,
      asFlag === null
        ? `no human identity: set ${HUMAN_ACTOR_ENV}=human:<id> or pass --as human:<id>. \`approval setup identity\` is the verb that establishes it, and it is the one subcommand exempt from this check`
        : `--as expects a human identity matching human:<id>, got ${JSON.stringify(asFlag)}; \`approval setup ${verb}\` stores a credential and is human-only`,
      helpText,
    ),
  };
}

// ---------------------------------------------------------------------------
// Replacing what is already there
// ---------------------------------------------------------------------------

interface Replacement {
  key: string;
  /** The key already has a line in the file. */
  present: boolean;
}

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
  const state: Replacement[] = keys.map((key) => ({ key, present: present.has(key) }));

  const write: string[] = [];
  const skipped: string[] = [];
  for (const entry of state) {
    if (!entry.present) {
      write.push(entry.key);
      continue;
    }
    streams.out(
      `${entry.key} already has a line in ${envPath} (its value is not printed here).\n`,
    );
    if (prompter.confirm(`replace the ${entry.key} line?`)) write.push(entry.key);
    else skipped.push(entry.key);
  }
  return { ok: true, write, skipped };
}

/** Report what was left alone, so a re-run's "no" is visible in the output. */
function reportSkipped(streams: Streams, envPath: string, skipped: string[]): void {
  if (skipped.length === 0) return;
  streams.out(
    `left alone in ${envPath}: ${skipped.join(", ")} (the existing line${skipped.length === 1 ? " is" : "s are"} unchanged)\n`,
  );
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
// Storing a secret, whichever way this machine can
// ---------------------------------------------------------------------------

/**
 * The plaintext-literal offer, for a machine with no keystore.
 *
 * An explicit typed `yes` — not `y`, not Enter — because the whole content of
 * this question is that the operator understood it. The warning is worded to
 * match what `approval env --check` will print at them on every run afterwards,
 * so the two never read as different claims about the same file.
 */
function offerLiteral(
  streams: Streams,
  prompter: Prompter,
  envPath: string,
  what: string,
): boolean {
  streams.out(
    `\nThis machine has no OS keystore this runtime can drive: \`security\` (macOS) and\n\`secret-tool\` (Linux, libsecret) are both absent, so there is nowhere to put the\n${what} except ${envPath} itself, in plaintext.\n\nThat is PERMITTED and it is always reported: \`approval env --check\` will list the\nvariable under PLAINTEXT for as long as the line exists. The file is mode 0600 and\n\`approval init\` gitignores it. A rule people route around is not a control — the\nalternative to writing it here is writing it into a shell profile, where nothing in\nthis runtime can see it to tell you.\n\n`,
  );
  const answer = prompter.readLine(`type \`yes\` in full to write it in plaintext: `);
  const typed = (answer ?? "").trim();
  if (typed === "yes") return true;
  streams.out("not confirmed: nothing was stored and nothing was written\n");
  return false;
}

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

const IDENTITY_HINT = (where: { envPath: string }): string =>
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
    `approval setup identity — declares WHO the human is, in ${HUMAN_ACTOR_ENV}.\n\nThis is config-declared identity (SPEC.md §11): the trust boundary is this\nmachine, and anyone who can set this variable and write to the log is inside it.\nNothing is proved by it and nothing is appended to the log by this verb.\n\n`,
  );

  const plan = planReplacements(streams, context.prompter, context.envPath, [HUMAN_ACTOR_ENV]);
  if (!plan.ok) return emitRefusal(streams, plan.refusal);
  if (plan.write.length === 0) {
    reportSkipped(streams, context.envPath, plan.skipped);
    return EXIT_OK;
  }

  const answer = context.prompter.readLine(`human identity (human:<id>): `);
  if (answer === null) {
    return usageError(streams, false, "no identity was entered; nothing was written", SETUP_IDENTITY_HELP);
  }
  const identity = answer.trim();
  if (resolveHumanActor({ actor: identity }) === null) {
    return usageError(
      streams,
      false,
      `${JSON.stringify(identity)} is not a human identity: it must match ^human:.+ (for example human:carter). An agent: or system: actor cannot be declared here — those are what the human-only verbs refuse. Nothing was written`,
      SETUP_IDENTITY_HELP,
    );
  }

  const written = writeLines(
    streams,
    context.envPath,
    [{ key: HUMAN_ACTOR_ENV, value: identity, describe: identity }],
    plan.write,
  );
  if (!written.ok) return written.code;
  reportSkipped(streams, context.envPath, plan.skipped);

  streams.out(
    `\nThat line is INERT until you evaluate it: no verb reads ${context.envPath} on its\nown (SPEC.md §11.1 invariant 7). Establish it in this shell with:\n\n  eval "$(approval env)"\n`,
  );
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// approval setup vault
// ---------------------------------------------------------------------------

const VAULT_HINT = (where: { envPath: string; kind: KeystoreKind }): string =>
  `  # 1. store a passphrase you generated yourself (no value on this command line;\n  #    the helper prompts for it with no echo):\n  ${storageCommand(where.kind === "none" ? "keychain" : where.kind, SERVICE_VAULT_PASSPHRASE)}\n\n  # 2. record where it lives:\n  printf '%s\\n' 'APPROVAL_VAULT_PASSPHRASE=${schemeFor(where.kind === "none" ? "keychain" : where.kind, SERVICE_VAULT_PASSPHRASE) ?? ""}' >> ${where.envPath}\n  chmod 600 ${where.envPath}`;

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
    SERVICE_VAULT_PASSPHRASE,
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

const SAMPLING_HINT = (where: { envPath: string; kind: KeystoreKind }): string =>
  `  # 1. store the secret (the helper prompts; no value on this command line):\n  ${storageCommand(where.kind === "none" ? "keychain" : where.kind, SERVICE_SAMPLING_SECRET)}\n\n  # 2. record where it lives:\n  printf '%s\\n' '${DEFAULT_SAMPLING_ENV}=${schemeFor(where.kind === "none" ? "keychain" : where.kind, SERVICE_SAMPLING_SECRET) ?? ""}' >> ${where.envPath}\n  chmod 600 ${where.envPath}\n\n  # 3. name the variable in the policy, through the amendment ceremony:\n  #    audit: { sampling_secret_env: ${DEFAULT_SAMPLING_ENV} }\n  approval policy amend`;

/** The policy's `audit.sampling_secret_env`, or `null`. */
function samplingEnvName(load: PolicyLoadResult): string | null {
  if (!load.ok) return null;
  const declared = load.policy.audit?.sampling_secret_env;
  return typeof declared === "string" && declared.length > 0 ? declared : null;
}

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
    `approval setup sampling — mints the operator-held secret that selects which\nsupervised actions are sampled for retrospective review (SPEC.md §5.2).\n\nSelection is HMAC-SHA-256 over the event hash under this secret. Seeding from\nevent content alone is forbidden: the agent authoring the event controls that\ncontent and could search it until its action falls outside the sample.\n\n`,
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
    SERVICE_SAMPLING_SECRET,
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
      `\nYour policy names no audit.sampling_secret_env, so the secret was recorded under\nthe conventional name ${variable} and SAMPLING IS STILL OFF. It stays off until\nthe policy names the variable — a policy that fails to name one disables\nsampling by SPEC.md §5.2, and this verb does not edit an attested policy file.\n\nAdd this block, through the ceremony that attests it:\n\n  audit:\n    sampling_secret_env: ${variable}\n\n  approval policy amend\n`,
    );
  } else {
    streams.out(
      `\nYour policy already names ${variable} (audit.sampling_secret_env), so sampling is\nlive once the variable is in the environment:\n\n  eval "$(approval env)"\n`,
    );
  }
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// approval setup telegram
// ---------------------------------------------------------------------------

const TELEGRAM_HINT = (where: { envPath: string; kind: KeystoreKind }): string =>
  `  # 1. store the bot token (the helper prompts for it with NO ECHO; the token is\n  #    never an argument, so it never reaches your shell history or \`ps\`):\n  ${storageCommand(where.kind === "none" ? "keychain" : where.kind, SERVICE_TELEGRAM_TOKEN)}\n\n  # 2. find the chat id — send your bot a message first, then:\n  curl -s "https://api.telegram.org/bot<token>/getUpdates" \\\n    | grep -o '"chat":{"id":[-0-9]*' | head -1\n\n  # 3. record both (a chat id is not a secret):\n  printf '%s\\n' 'APPROVAL_TG_TOKEN=${schemeFor(where.kind === "none" ? "keychain" : where.kind, SERVICE_TELEGRAM_TOKEN) ?? ""}' 'APPROVAL_TG_CHAT=<id>' >> ${where.envPath}\n  chmod 600 ${where.envPath}`;

/** Replace the token wherever it appears. Nothing leaves this file with it. */
function redact(text: string, token: string): string {
  return token.length === 0 ? text : text.split(token).join("<token redacted>");
}

interface BotCall {
  ok: boolean;
  status: number;
  envelope: Record<string, unknown>;
}

/** One Bot API call, with doctor's probe shape: the token is in the URL only. */
async function call(
  fetchImpl: TelegramFetch,
  apiBase: string,
  token: string,
  method: string,
  body: unknown,
  timeoutMs: number,
): Promise<BotCall | { failed: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${apiBase}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    let envelope: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) envelope = parsed as Record<string, unknown>;
    } catch {
      /* a non-JSON body is not an ok envelope; handled by the caller */
    }
    return { ok: response.ok, status: response.status, envelope };
  } catch (cause) {
    return { failed: redact(detail(cause), token) };
  } finally {
    clearTimeout(timer);
  }
}

/** One chat the bot has heard from. */
interface Candidate {
  id: string;
  type: string;
  name: string;
}

/**
 * The chats in a `getUpdates` result, newest first and deduplicated by id.
 *
 * `title ?? username ?? first_name` is Telegram's own precedence for what to
 * call a chat: groups and channels carry a title, a private chat carries the
 * user's username or, for a user who has set none, their first name.
 */
function candidatesFrom(updates: unknown): Candidate[] {
  const found = new Map<string, Candidate>();
  const list = Array.isArray(updates) ? [...updates].reverse() : [];
  for (const update of list) {
    if (typeof update !== "object" || update === null) continue;
    const message = (update as Record<string, unknown>)["message"];
    if (typeof message !== "object" || message === null) continue;
    const chat = (message as Record<string, unknown>)["chat"];
    if (typeof chat !== "object" || chat === null) continue;
    const record = chat as Record<string, unknown>;
    const id = record["id"];
    if (typeof id !== "number" && typeof id !== "string") continue;
    const key = String(id);
    if (found.has(key)) continue;
    const name =
      typeof record["title"] === "string"
        ? record["title"]
        : typeof record["username"] === "string"
          ? `@${record["username"]}`
          : typeof record["first_name"] === "string"
            ? record["first_name"]
            : "unnamed";
    found.set(key, {
      id: key,
      type: typeof record["type"] === "string" ? record["type"] : "unknown",
      name,
    });
  }
  return [...found.values()];
}

/** `approval setup telegram` — token, identity probe, chat discovery, both lines. */
export async function commandSetupTelegram(
  argv: string[],
  streams: Streams,
  cwd: string,
  deps: SetupDeps = {},
): Promise<number> {
  const outcome = front("telegram", argv, streams, cwd, deps, SETUP_TELEGRAM_HELP, TELEGRAM_HINT);
  if (outcome.kind === "handled") return outcome.code;
  const context = outcome;

  const tokenEnv = telegramTokenEnvFor(context.load);
  const chatEnv = telegramChatEnvFor(context.load);
  const fetchImpl = deps.fetch ?? (globalThis.fetch as unknown as TelegramFetch);
  const apiBase = context.apiBase.replace(/\/+$/u, "");

  streams.out(
    `approval setup telegram — the bot token, the approver chat, and the two lines in\n${context.envPath} that say where they live.\n\nIF \`approval channel telegram listen\` IS RUNNING, STOP IT FIRST. Two processes\nlong-polling one bot is a 409 from the Bot API, and the loser is whichever asked\nsecond. This verb is a configuration verb; it is not meant to run beside the\nlistener.\n\n`,
  );

  const plan = planReplacements(streams, context.prompter, context.envPath, [tokenEnv, chatEnv]);
  if (!plan.ok) return emitRefusal(streams, plan.refusal);
  if (plan.write.length === 0) {
    reportSkipped(streams, context.envPath, plan.skipped);
    return EXIT_OK;
  }

  // (a) The token. On a machine with a keystore, the HELPER's prompt collects
  // it and this process learns it only by reading the item back on stdout.
  let token: string;
  let tokenSource: Stored;
  if (context.backend === "none") {
    const read = context.prompter.readSecret(
      `bot token from @BotFather (not echoed): `,
    );
    if (!read.ok) {
      return usageError(
        streams,
        false,
        "the token entry was aborted; nothing was stored and nothing was written",
        SETUP_TELEGRAM_HELP,
      );
    }
    token = read.value.trim();
    if (token.length === 0) {
      return usageError(streams, false, "no token was entered; nothing was written", SETUP_TELEGRAM_HELP);
    }
    if (!offerLiteral(streams, context.prompter, context.envPath, "bot token")) return EXIT_OK;
    tokenSource = { value: token, describe: `a plaintext literal in ${context.envPath} (PLAINTEXT)` };
  } else {
    streams.out(
      `The bot token is collected by ${context.backend === "keychain" ? "macOS `security`" : "`secret-tool`"}'s own prompt, below — it goes\nstraight into the keystore and this process never sees you type it.\n\n`,
    );
    const stored = context.keystore.storePrompted(SERVICE_TELEGRAM_TOKEN);
    if (!stored.ok) {
      streams.err(
        `approval: the token could not be stored (${stored.message}); nothing was written to ${context.envPath}\n`,
      );
      return EXIT_IO;
    }
    const read = context.keystore.read(SERVICE_TELEGRAM_TOKEN);
    if (!read.ok) {
      streams.err(
        `approval: the token was stored but could not be read back (${read.message}); nothing was written to ${context.envPath}\n`,
      );
      return EXIT_IO;
    }
    token = read.value.trim();
    const scheme = schemeFor(context.backend, SERVICE_TELEGRAM_TOKEN) as string;
    tokenSource = { value: scheme, describe: scheme };
    streams.out(`stored the token as ${scheme}\n`);
    streams.out(`  read it back with: ${retrievalCommand(context.backend, SERVICE_TELEGRAM_TOKEN)}\n`);
  }

  // (b) getMe — doctor's probe, verbatim in shape: it mutates nothing, sends
  // nothing, and acknowledges nothing.
  const identity = await call(fetchImpl, apiBase, token, "getMe", {}, PROBE_TIMEOUT_MS);
  if ("failed" in identity) {
    streams.err(`approval: getMe on ${apiBase} failed: ${identity.failed}\n`);
    streams.err(`  check network reachability of ${apiBase}\n`);
    return EXIT_IO;
  }
  if (!identity.ok || identity.envelope["ok"] !== true) {
    const description = redact(String(identity.envelope["description"] ?? "no description"), token);
    streams.err(`approval: getMe on ${apiBase} was refused: HTTP ${String(identity.status)} (${description})\n`);
    streams.err(
      identity.status === 401 || /unauthorized/iu.test(description)
        ? `  the bot token is not valid: re-copy it from @BotFather into ${tokenEnv}\n`
        : `  check the token and that ${apiBase} is the right Bot API base\n`,
    );
    streams.err(`  nothing was written to ${context.envPath}\n`);
    return EXIT_INTEGRITY;
  }
  const result = (identity.envelope["result"] ?? {}) as Record<string, unknown>;
  const username = typeof result["username"] === "string" ? `@${result["username"]}` : "the bot";
  streams.out(`\ntoken valid: ${username} via ${apiBase}\n`);

  // (c)-(e) The chat. THE getUpdates BELOW CARRIES NO OFFSET, EVER.
  let candidates: Candidate[] = [];
  for (let attempt = 1; attempt <= CHAT_DISCOVERY_ATTEMPTS; attempt += 1) {
    context.prompter.readLine(
      attempt === 1
        ? `\nOpen Telegram and send any message to ${username} now, then press Enter: `
        : `\nNo message seen yet. Send one to ${username} and press Enter (attempt ${String(attempt)} of ${String(CHAT_DISCOVERY_ATTEMPTS)}): `,
    );

    // NO OFFSET, EVER. An `offset` is an ACKNOWLEDGEMENT: it tells the Bot API
    // that everything below it may be discarded. A running
    // `approval channel telegram listen` owns that acknowledgement, and a
    // decision tap consumed here would never reach the listener that was
    // waiting for it — which is exactly why `approval doctor` refuses to call
    // getUpdates at all. Reading WITHOUT an offset confirms nothing: the
    // pending callback_query updates a listener is waiting for are still
    // pending when this returns. `allowed_updates: ["message"]` narrows the
    // read to the only kind this verb has any use for, so a callback is not
    // even delivered here.
    const updates = await call(
      fetchImpl,
      apiBase,
      token,
      "getUpdates",
      { timeout: context.pollTimeoutSeconds, allowed_updates: ["message"] },
      context.pollTimeoutSeconds * 1000 + PROBE_TIMEOUT_MS,
    );
    if ("failed" in updates) {
      streams.err(`approval: getUpdates on ${apiBase} failed: ${updates.failed}\n`);
      streams.err(`  nothing was written to ${context.envPath}\n`);
      return EXIT_IO;
    }
    if (!updates.ok || updates.envelope["ok"] !== true) {
      const description = redact(String(updates.envelope["description"] ?? "no description"), token);
      streams.err(
        `approval: getUpdates on ${apiBase} was refused: HTTP ${String(updates.status)} (${description})\n`,
      );
      streams.err(
        `  a 409 here means another process is long-polling this bot: stop \`approval channel telegram listen\` and re-run\n`,
      );
      return EXIT_INTEGRITY;
    }
    candidates = candidatesFrom(updates.envelope["result"]);
    if (candidates.length > 0) break;
  }

  if (candidates.length === 0) {
    streams.err(
      `approval: no message reached ${username} after ${String(CHAT_DISCOVERY_ATTEMPTS)} attempts, so there is no chat id to record.\n\nThe token is stored; only the two ${context.envPath} lines are missing. Find the id\nby hand — send the bot a message, then:\n\n  curl -s "${apiBase}/bot<token>/getUpdates" | grep -o '"chat":{"id":[-0-9]*'\n\n(the <token> is yours to substitute; it is deliberately not printed here). Then:\n\n  printf '%s\\n' '${chatEnv}=<id>' >> ${context.envPath}\n\nIf the bot is in a GROUP, check that privacy mode is off in @BotFather, or the\nbot never sees plain group messages at all.\n`,
    );
    return EXIT_INTEGRITY;
  }

  let chosen: Candidate;
  if (candidates.length === 1) {
    const only = candidates[0] as Candidate;
    if (!context.prompter.confirm(`use chat ${only.id} (${only.type}, ${only.name})?`)) {
      streams.out("aborted: nothing was written\n");
      return EXIT_OK;
    }
    chosen = only;
  } else {
    streams.out(`\n${String(candidates.length)} chats have messaged ${username}, newest first:\n`);
    candidates.forEach((candidate, index) => {
      streams.out(`  ${String(index + 1)}. ${candidate.id} (${candidate.type}, ${candidate.name})\n`);
    });
    const picked = context.prompter.readLine(`which one? [1-${String(candidates.length)}]: `);
    const index = Number.parseInt((picked ?? "").trim(), 10);
    if (!Number.isInteger(index) || index < 1 || index > candidates.length) {
      return usageError(
        streams,
        false,
        `${JSON.stringify((picked ?? "").trim())} is not one of 1-${String(candidates.length)}; nothing was written`,
        SETUP_TELEGRAM_HELP,
      );
    }
    chosen = candidates[index - 1] as Candidate;
  }

  // (f) The optional proof. Default NO: a configuration verb that buzzes a
  // phone by default is one an operator runs once and then avoids, which is
  // doctor's argument for calling getMe and nothing else.
  if (context.prompter.confirm(`send a test message to ${chosen.id} to prove it?`)) {
    const sent = await call(
      fetchImpl,
      apiBase,
      token,
      "sendMessage",
      { chat_id: chosen.id, text: "approval.md: setup test message. Nothing is pending." },
      PROBE_TIMEOUT_MS,
    );
    if ("failed" in sent || !sent.ok || sent.envelope["ok"] !== true) {
      const why =
        "failed" in sent
          ? sent.failed
          : redact(String(sent.envelope["description"] ?? "no description"), token);
      streams.out(`  the test message did not send (${why}); the chat id is still recorded below\n`);
    } else {
      streams.out(`  sent — check ${chosen.name}\n`);
    }
  }

  // (g) Both lines, in one write. A chat id is not a secret and goes in as a
  // literal; the token goes in as a source.
  const written = writeLines(
    streams,
    context.envPath,
    [
      { key: tokenEnv, value: tokenSource.value, describe: tokenSource.describe },
      { key: chatEnv, value: chosen.id, describe: `${chosen.id} (a chat id is not a secret)` },
    ],
    plan.write,
  );
  if (!written.ok) return written.code;
  reportSkipped(streams, context.envPath, plan.skipped);

  streams.out(
    `\nNo update was acknowledged by this verb: every getUpdates above carried no\noffset, so a running listener's pending callbacks are exactly where they were.\n\nEstablish the variables and check the channel:\n\n  eval "$(approval env)"\n  approval channel telegram health\n`,
  );
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** `approval setup <identity|vault|sampling|telegram>`. */
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
  if (sub === "telegram") return commandSetupTelegram(rest, streams, cwd, deps);
  return usageError(
    streams,
    json,
    `unknown subcommand ${JSON.stringify(sub)} for \`approval setup\``,
    SETUP_HELP,
  );
}
