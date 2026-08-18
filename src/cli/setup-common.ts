/**
 * What every `approval setup` subcommand shares (SPEC.md §5.2, §10.1; APRV-79).
 *
 * `setup` began as one file with four subcommands in it. APRV-78 added
 * `setup adapter <name>` in a file of its own, and it had to reach back into
 * `cli/setup.ts` for the front matter — which made a cycle: `setup.ts` imports
 * the adapter verb to dispatch it, and the adapter verb imports `front`,
 * `requireHuman` and `SetupDeps` back. ESM tolerates that until the day an
 * initialisation order changes and a `const` at module scope is `undefined` in
 * one direction only. APRV-79 adds a THIRD such file (`setup-channel.ts`), so
 * the cycle is broken by extraction rather than tolerated a second time.
 *
 * The rule this file exists to enforce, asserted in `tests/layering.test.ts`:
 *
 * ```
 * setup.ts ──┬─> setup-adapter.ts ──┐
 *            └─> setup-channel.ts ──┴─> setup-common.ts   (and no arrow back)
 * ```
 *
 * What lives here is what more than one of those three needs: the dependency
 * bag, the keystore seam, the flag table, the front matter (`--help`, the paths,
 * the policy, the terminal check), the human-only gate, the `.approval/env`
 * refusal mapping, the service names, and the plaintext-literal offer. What does
 * NOT live here is anything one subcommand alone uses: the chat picker is
 * `setup-channel.ts`'s, the manifest hint generator is `setup-adapter.ts`'s, and
 * the generated-secret path (`storeGeneratedSecret`) stays with `vault` and
 * `sampling` in `setup.ts`.
 *
 * The reasoning for each decision this file encodes — why the token is never
 * handled by this process, why a generated value may reach an argv and an
 * operator's own may not, why every subcommand refuses a non-terminal stdin —
 * is in `cli/setup.ts`'s module doc, which is the family's front page. It is not
 * repeated here; this file is the mechanism.
 */

import { randomBytes } from "node:crypto";
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { userInfo } from "node:os";
import { isAbsolute, resolve as resolvePathSegments } from "node:path";

import { HUMAN_ACTOR_ENV, resolveHumanActor } from "../core/attest.js";
import {
  defaultSourceRunner,
  envFilePathFor,
  type EnvFileRefusal,
} from "../core/env-file.js";
import { loadPolicy, type PolicyLoadResult } from "../core/policy-load.js";
import { telegramChatEnvFor, telegramTokenEnvFor } from "../core/telegram-config.js";
import { passphraseEnvFor } from "../core/vault.js";
import type { probeSmtp } from "../adapters/smtp.js";
import { TELEGRAM_DEFAULT_API_BASE, type TelegramFetch } from "../channels/telegram.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import { EXIT_INTEGRITY, EXIT_IO, EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
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
export const POLL_TIMEOUT_SECONDS = 10;

/** doctor's probe timeout, for the calls that answer immediately. */
export const PROBE_TIMEOUT_MS = 10_000;

/** The flags every subcommand accepts. One table, so none of them drifts. */
export const FLAGS: Record<string, FlagKind> = {
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
       * only on the generated-secret fallback path; see `cli/setup.ts`.
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

/** A thrown thing, as a sentence. */
export function detail(cause: unknown): string {
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
    // `detached: true` is load-bearing (APRV-94). `security -w` reads the
    // secret from the CONTROLLING TTY whenever the process has one and ignores
    // stdin entirely, so from a real terminal the pipe below was never read:
    // Apple's "password data for new item:" prompt appeared to the human,
    // whatever they typed was stored, and only the read-back mismatch and the
    // argv fallback rescued the run (Ctrl-C at that prompt stored nothing at
    // all). A detached child starts its own session with no controlling
    // terminal, so `security` has nothing to prompt on and reads the pipe.
    // spawnSync still waits for it; detaching changes the session, not the
    // synchrony. The option is absent from the sync typings (undocumented for
    // spawnSync, honoured by Node's SyncProcessRunner, verified against Node
    // 24 with a scratch item), hence the widened type. A Node that ignored it
    // would land on exactly the pre-APRV-94 path, and the read-back below is
    // what catches that.
    //
    // Exit status is NOT trusted as proof of a correct store. A probe against a
    // scratch keychain (APRV-74 review) showed `security … -w` with piped stdin
    // exiting 0 while leaving no findable item under the service name (that
    // was this same tty behaviour, seen from the other side). So every attempt
    // is followed by a read-back, and success is "the keystore returns exactly
    // the bytes we generated", nothing less.
    const pipedOptions: SpawnSyncOptionsWithStringEncoding & { detached: boolean } = {
      encoding: "utf8",
      input: `${value}\n${value}\n`,
      detached: true,
    };
    const piped = spawnSync("security", [...base, "-w"], pipedOptions);
    if (piped.error === undefined && piped.status === 0) {
      const back = defaultKeystoreRunner.read(service);
      if (back.ok && back.value === value) return { ok: true, viaArgv: false };
    }

    // Attempt two, for GENERATED VALUES ONLY: the argv form. See `cli/setup.ts`
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
export function schemeFor(kind: KeystoreKind, service: string): string | null {
  if (kind === "keychain") return `keychain:${service}`;
  if (kind === "secret-service") return `secret-service:${service}`;
  return null;
}

/** The command an operator runs by hand to see that the item is really there. */
export function retrievalCommand(kind: KeystoreKind, service: string): string {
  return kind === "keychain"
    ? `security find-generic-password -a "$USER" -s ${service} -w`
    : `secret-tool lookup approval ${service}`;
}

/** The command an operator runs by hand to STORE the item, with no value in it. */
export function storageCommand(kind: KeystoreKind, service: string): string {
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
   * "nobody messaged the bot" path polls three times, and a suite that spent
   * thirty seconds proving a refusal is a suite people stop running. Not a
   * flag — no operator has a reason to change it.
   */
  pollTimeoutSeconds?: number;
  /**
   * The environment the passphrase is read from. `process.env` by default.
   *
   * A seam and not a back door: it is read through `passphraseFrom`, which is
   * the same function `approval vault set` uses, and it never resolves
   * `.approval/env` (§11.1 invariant 7). Injectable so a test can prove both
   * the unset refusal and the happy path without mutating the suite's own
   * environment, which is shared by every other test in the process.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * The SMTP probe `setup adapter email` verifies with. The real one by
   * default; a test injects a wrapper so that the only TLS relaxation in this
   * repository stays inside the test that needs it (`tests/smtp-mock.ts`'s
   * self-signed fixture on 127.0.0.1).
   */
  probe?: typeof probeSmtp;
}

export function usageError(
  streams: Streams,
  json: boolean,
  message: string,
  helpText: string,
): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "usage", message } })}\n`);
  else streams.err(`approval: ${message}\n\n${helpText}\n`);
  return EXIT_USAGE;
}

export function absolute(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolvePathSegments(cwd, value);
}

export function refusalExitCode(refusal: EnvFileRefusal): number {
  return refusal.code === "env-file-io" || refusal.code === "env-file-mode"
    ? EXIT_IO
    : EXIT_INTEGRITY;
}

export function emitRefusal(streams: Streams, refusal: EnvFileRefusal): number {
  streams.err(`approval: ${refusal.code}: ${refusal.message}\n`);
  return refusalExitCode(refusal);
}

export interface Context {
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

export type FrontOutcome = { kind: "handled"; code: number } | ({ kind: "run" } & Context);

/**
 * What a non-interactive hint needs: where the map lives, which keystore is
 * present, and the variable NAMES the loaded policy resolves to. The hints
 * must print the names the interactive path would write, or an operator on a
 * renamed policy copies a line the runtime never reads.
 */
export interface HintContext {
  envPath: string;
  kind: KeystoreKind;
  passphraseEnv: string;
  samplingEnv: string;
  tokenEnv: string;
  chatEnv: string;
}

/** The policy's `audit.sampling_secret_env`, or `null`. */
export function samplingEnvName(load: PolicyLoadResult): string | null {
  if (!load.ok) return null;
  const declared = load.policy.audit?.sampling_secret_env;
  return typeof declared === "string" && declared.length > 0 ? declared : null;
}

export function hintContextFor(
  load: PolicyLoadResult,
  envPath: string,
  kind: KeystoreKind,
): HintContext {
  return {
    envPath,
    kind,
    passphraseEnv: passphraseEnvFor(load),
    samplingEnv: samplingEnvName(load) ?? DEFAULT_SAMPLING_ENV,
    tokenEnv: telegramTokenEnvFor(load),
    chatEnv: telegramChatEnvFor(load),
  };
}

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
export function front(
  subcommand: string,
  argv: string[],
  streams: Streams,
  cwd: string,
  deps: SetupDeps,
  helpText: string,
  nonInteractiveHint: (context: HintContext) => string,
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
      }. Nothing was written.\n\nIdentity in v0.1 is config-declared (SPEC.md §11), so establishing it — and the credentials beside it — is an act of the human at the machine, not something a pipe or a CI job can do. The non-interactive path is explicit, and here it is:\n\n${nonInteractiveHint(hintContextFor(load, envPath, kind))}\n\nThen check it with \`approval env --check\`, which prints no values.\n`,
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
export function requireHuman(
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
// The plaintext-literal offer
// ---------------------------------------------------------------------------

/**
 * The plaintext-literal offer, for a machine with no keystore.
 *
 * An explicit typed `yes` — not `y`, not Enter — because the whole content of
 * this question is that the operator understood it. The warning is worded to
 * match what `approval env --check` will print at them on every run afterwards,
 * so the two never read as different claims about the same file.
 */
export function offerLiteral(
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
