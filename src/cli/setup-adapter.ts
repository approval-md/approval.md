/**
 * `approval setup adapter <name>` — fill the vault for one adapter (APRV-78).
 *
 * SPEC.md §10.4 gives adapters an encrypted vault and `approval vault set` as
 * the way in, and that verb is deliberately austere: one credential, one call,
 * no prompt, the value from stdin or a named variable. It is the right shape
 * for a script and the wrong shape for a person, who has to know that the email
 * adapter wants five values, what each of them is called, which of them are
 * secrets, that the port must be a port and the security setting one of three
 * words, and that the user and the password are both-or-neither. All of that
 * was written down only inside `adapters/email.ts`'s `act`, where nobody
 * setting a machine up can read it.
 *
 * This verb reads the adapter's own manifest instead. The conversation is
 * `cli/setup-flow.ts` and knows nothing about SMTP; the manifest is
 * `EMAIL_CREDENTIAL_SPECS` and knows nothing about vaults or terminals; this
 * file is the ten lines that join them, plus the two things that are genuinely
 * about the pairing: what to do with the passphrase, and how to prove the
 * result without sending anything.
 *
 * ## Where the values go, and where they do NOT
 *
 * **Into the vault, always.** Not the OS keystore, which is where `setup
 * vault|sampling|channel <name>` put their secrets, and not `.approval/env`. The
 * distinction is the one §10.4 draws: `.approval/env` holds what unlocks the
 * machine (the human identity, the passphrase's source, the channel's token),
 * and the vault holds what a gated adapter SPENDS inside a verified-token
 * window. An SMTP password in `.approval/env` would be readable by
 * `approval env` on demand, which is exactly the journey the vault exists to
 * forbid.
 *
 * ## The passphrase is read, never established
 *
 * From the shell environment, under the name the policy declares, through
 * {@link passphraseFrom} — and from nowhere else. **This verb never resolves
 * `.approval/env` itself** (SPEC.md §11.1 invariant 7: no command loads that
 * file implicitly, because a working-tree file any process read on its own
 * would let anything able to write it act as you). It does READ the file, for
 * one thing only: whether a line for the passphrase variable exists, which
 * decides whether the refusal tells you to run `approval setup vault` or just
 * to `eval "$(approval env)"`. A key's PRESENCE is not its value, and
 * `planReplacements` has always read the file for exactly that.
 *
 * ## Verification sends nothing
 *
 * The proof is {@link probeSmtp}: the same session `sendMail` runs, up to and
 * including AUTH, and then QUIT. It proves the host resolves, the port answers,
 * the TLS mode is the one the server offers, and the credential is accepted. It
 * does not prove a message would be delivered, and it puts no message on the
 * wire — a setup verb that emailed somebody to prove itself would be a verb
 * people run once and then avoid, which is `approval doctor`'s argument for
 * calling `getMe` and nothing else.
 *
 * It is OFFERED, defaulting to YES, and a failure does not delete anything: the
 * values stay, the refusal names the SMTP code and the server's first line
 * (redacted), and the undo is printed as `approval vault remove <name>`. Values
 * discarded by a wizard because a laptop was on a captive portal would be five
 * more things to type.
 */

import type { CredentialSpec } from "../core/credential-spec.js";
import { envFilePathFor, readEnvFile } from "../core/env-file.js";
import type { PolicyLoadResult } from "../core/policy-load.js";
import { passphraseEnvFor, passphraseFrom, vaultExists, vaultPathFor } from "../core/vault.js";
import {
  DEFAULT_CREDENTIAL_NAMES,
  EMAIL_CREDENTIAL_SPECS,
  checkEmailCredentialSet,
} from "../adapters/email.js";
import { isSmtpSecurity, probeSmtp, type SmtpSecurity } from "../adapters/smtp.js";
import { EXIT_OK } from "./exit-codes.js";
import { SETUP_ADAPTER_EMAIL_HELP, SETUP_ADAPTER_HELP } from "./help.js";
import type { Streams } from "./main.js";
import {
  front,
  requireHuman,
  usageError,
  type HintContext,
  type SetupDeps,
} from "./setup-common.js";
import {
  runCredentialFlow,
  vaultDestination,
  type FlowResult,
  type VerifyOutcome,
} from "./setup-flow.js";

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/** What a verify hook is handed beyond the values: what the run actually did. */
export interface VerifyContext {
  written: readonly string[];
  skipped: readonly string[];
  prompter: { confirm(prompt: string, defaultNo?: boolean): boolean };
  probe: typeof probeSmtp;
}

/** One adapter, as this verb needs to see it. */
export interface AdapterSetupEntry {
  /** The manifest, declared by the adapter itself. */
  specs: readonly CredentialSpec[];
  /**
   * The adapter's cross-field rule, or `undefined` when it has none. `kept`
   * names the values already in the store that this run left alone (APRV-98):
   * the flow never reads a value back, but presence is a fact it does know.
   */
  check?(values: Record<string, string>, kept: readonly string[]): string | null;
  /** One line of what this adapter is, for the title. */
  summary: string;
  /** The non-interactive path: the exact `vault set` calls, generated. */
  hint(context: HintContext): string;
  /** Prove the stored configuration against the far end, sending nothing. */
  verify(values: Record<string, string>, context: VerifyContext): Promise<VerifyOutcome>;
  /** What to tell the operator to do next. */
  nextSteps: readonly string[];
}

/** The keystore read form for this machine, defaulting to the macOS one. */
function readBackCommand(kind: HintContext["kind"], item: string): string {
  return kind === "secret-service"
    ? `secret-tool lookup approval ${item}`
    : `security find-generic-password -a "$USER" -s ${item} -w`;
}

/**
 * The scripted path, GENERATED FROM THE MANIFEST rather than written out.
 *
 * A hand-written hint is a list of five commands that has to be edited every
 * time the manifest changes and will not be. Generating it means the refusal an
 * operator copies is, by construction, the set of names the adapter actually
 * reads.
 *
 * The secret's line takes its value from the keystore's own reader, so the
 * password is never an argument on any line printed here — the rule the rest of
 * `setup` follows, applied to a verb whose whole subject is credentials.
 */
function manifestHint(specs: readonly CredentialSpec[], context: HintContext): string {
  const lines: string[] = [
    `  # 1. establish the vault passphrase in ${context.passphraseEnv} and put it in this`,
    `  #    shell. Every line below reads it from the environment and nowhere else:`,
    `  approval setup vault --as human:<id>`,
    `  eval "$(approval env)"`,
    ``,
    `  # 2. store each credential. The VALUE is never a command-line argument:`,
    `  #    --value-env names a variable, and the variable is set for that one call.`,
  ];
  for (const spec of specs) {
    const call = `approval vault set ${spec.name} --value-env V --as human:<id>`;
    if (spec.kind === "secret") {
      lines.push(
        `  V="$(${readBackCommand(context.kind, "<your-item>")})" \\`,
        `    ${call}`,
      );
    } else {
      const placeholder = spec.default ?? `<${spec.label.replace(/\s+/gu, "-")}>`;
      lines.push(`  V='${placeholder}' ${call}`);
    }
  }
  return lines.join("\n");
}

/** Replace every occurrence of each secret. Nothing leaves this file with one. */
function redactor(secrets: readonly string[]): (text: string) => string {
  const present = secrets.filter((secret) => secret.length > 0);
  return (text: string): string => {
    let out = text;
    for (const secret of present) out = out.split(secret).join("<redacted>");
    return out;
  };
}

/**
 * The email adapter's verification: one SMTP session that sends nothing.
 *
 * Runs only when this run collected the whole picture. A run in which the
 * operator declined to replace `smtp.user` would probe with whatever the OTHER
 * four values say and no login, and report a failure about a configuration that
 * is in fact fine — and the alternative, reading the missing values back out of
 * the vault, is the thing there is deliberately no verb for. So a partial run
 * says so and stops, which is honest and one re-run away from a full check.
 */
async function verifyEmail(
  values: Record<string, string>,
  context: VerifyContext,
): Promise<VerifyOutcome> {
  const names = DEFAULT_CREDENTIAL_NAMES;
  if (context.skipped.length > 0) {
    return {
      ok: true,
      declined: true,
      detail: `\nnot verified: ${context.skipped.join(", ")} ${context.skipped.length === 1 ? "was" : "were"} left alone this run, so this verb does not hold the whole\nconfiguration, and it will not read the missing values back — there is no verb in\nthis CLI that reads a credential out of the vault. Re-run and replace all of them\nto probe the server.\n`,
    };
  }

  const host = values[names.host];
  const port = Number(values[names.port]);
  const security = values[names.security];
  if (host === undefined || !Number.isInteger(port) || !isSmtpSecurity(security)) {
    return {
      ok: true,
      declined: true,
      detail: `\nnot verified: the run did not collect ${names.host}, ${names.port} and ${names.security}\n`,
    };
  }

  const user = values[names.user];
  const password = values[names.password];
  const scrub = redactor([user ?? "", password ?? ""]);

  if (
    !context.prompter.confirm(
      `open an SMTP session to ${host}:${String(port)} to check it? Nothing is sent`,
      false,
    )
  ) {
    return {
      ok: true,
      declined: true,
      detail: `\nstored and unverified: no connection was made. \`approval doctor\` does not probe SMTP\neither; the first proof will be the first \`approval adapter email\` send.\n`,
    };
  }

  const result = await context.probe({
    host,
    port,
    security: security as SmtpSecurity,
    ...(user === undefined ? {} : { user }),
    ...(password === undefined ? {} : { password }),
    tlsRejectUnauthorized: true,
    redact: scrub,
  });

  if (result.ok) {
    return {
      ok: true,
      detail: `\nverified: ${host}:${String(port)} answered over ${security}, ${
        result.authenticated === null
          ? "with no login (neither a user nor a password is stored)"
          : `and accepted the credential over AUTH ${result.authenticated}`
      }.\nNo message was sent: the session ran to AUTH and then QUIT.\n`,
    };
  }

  const undo = [names.host, names.port, names.security, names.user, names.password]
    .filter((name) => values[name] !== undefined)
    .map((name) => `  approval vault remove ${name} --as human:<id>`)
    .join("\n");
  return {
    ok: false,
    detail: `approval: ${result.code}: ${scrub(result.message)}\n\nThe values ARE stored — a probe that failed because a laptop is behind a captive\nportal is not a reason to make you type five things again. Fix the server or the\nsetting and re-run this verb, or undo it by hand:\n\n${undo}\n`,
  };
}

/** Every adapter this verb can configure. Keyed by the `adapter <name>` name. */
export const ADAPTER_SETUPS: Record<string, AdapterSetupEntry> = {
  email: {
    specs: EMAIL_CREDENTIAL_SPECS,
    check: (values, kept) => checkEmailCredentialSet(values, DEFAULT_CREDENTIAL_NAMES, kept),
    summary:
      "the SMTP settings `approval adapter email` reads inside the verified-token window",
    hint: (context) => manifestHint(EMAIL_CREDENTIAL_SPECS, context),
    verify: verifyEmail,
    nextSteps: [
      `Check the names (never the values) with:`,
      ``,
      `  approval vault list --as human:<id>`,
      ``,
      `The adapter reads them itself, inside the token window; nothing else does.`,
    ],
  },
};

/** The known names, sorted, for a usage error and for the help text. */
export function knownAdapterNames(): string[] {
  return Object.keys(ADAPTER_SETUPS).sort();
}

// ---------------------------------------------------------------------------
// The verb
// ---------------------------------------------------------------------------

/**
 * The refusal for an unset passphrase.
 *
 * Two shapes, and the difference is a diagnosis: no vault file AND no line for
 * the variable means nobody has ever established one, so the repair starts with
 * `approval setup vault`. Anything else means the passphrase exists and this
 * shell has not evaluated it, so the repair is one line. A verb that printed
 * both every time would train the operator to skim past the one that mattered.
 */
function passphraseHint(
  variable: string,
  logPath: string,
  envPath: string,
): string {
  const file = readEnvFile(envPath);
  // Reading the file for a KEY'S PRESENCE, never for a value, and never
  // resolving it: SPEC.md §11.1 invariant 7 forbids the resolution, not the
  // stat. An unreadable file is treated as "no line", which is the fail-closed
  // reading: it produces the longer hint, never the shorter one.
  const hasLine = file.ok && file.entries.some((entry) => entry.key === variable);
  const established = hasLine || vaultExists(vaultPathFor(logPath));
  return established
    ? `The passphrase is recorded but not in this shell. Establish it with:\n\n  eval "$(approval env)"`
    : `Nobody has established a vault passphrase here. Do that first, then evaluate it:\n\n  approval setup vault --as human:<id>\n  eval "$(approval env)"`;
}

/**
 * `approval setup adapter <name>` — the interactive writer for one adapter's
 * credentials. HUMAN-ONLY.
 *
 * `argv` starts at the adapter's name: `commandSetup` has already eaten
 * `adapter`.
 */
export async function commandSetupAdapter(
  argv: string[],
  streams: Streams,
  cwd: string,
  deps: SetupDeps = {},
): Promise<number> {
  const json = argv.includes("--json");
  const name = argv[0];

  // The name is resolved BEFORE the terminal check, so that a typo is answered
  // with "here are the adapters" rather than with a lecture about pipes.
  if (name === "--help" || name === "-h" || name === "help") {
    streams.out(`${SETUP_ADAPTER_HELP}\n`);
    return EXIT_OK;
  }
  if (name === undefined || name.startsWith("-")) {
    return usageError(
      streams,
      json,
      `missing <name> for \`approval setup adapter\`; known adapters: ${knownAdapterNames().join(", ")}`,
      SETUP_ADAPTER_HELP,
    );
  }
  const entry = ADAPTER_SETUPS[name];
  if (entry === undefined) {
    return usageError(
      streams,
      json,
      `unknown adapter ${JSON.stringify(name)}; known adapters: ${knownAdapterNames().join(", ")}`,
      SETUP_ADAPTER_HELP,
    );
  }
  const helpText = name === "email" ? SETUP_ADAPTER_EMAIL_HELP : SETUP_ADAPTER_HELP;

  const outcome = front(
    `adapter ${name}`,
    argv.slice(1),
    streams,
    cwd,
    deps,
    helpText,
    (context: HintContext) => entry.hint(context),
  );
  if (outcome.kind === "handled") return outcome.code;
  const context = outcome;

  const extra = context.positionals[0];
  if (extra !== undefined) {
    return usageError(streams, false, `unexpected argument ${JSON.stringify(extra)}`, helpText);
  }

  const human = requireHuman(context.flags, streams, helpText, `adapter ${name}`);
  if (!human.ok) return human.code;

  // The passphrase, from the SHELL environment under the policy's name. Never
  // from `.approval/env` directly: §11.1 invariant 7.
  const variable = passphraseEnvFor(context.load as PolicyLoadResult);
  const passphrase = passphraseFrom(variable, deps.env ?? process.env);
  if (passphrase === null) {
    return usageError(
      streams,
      false,
      `${variable} is unset or empty: the vault passphrase is read from that environment variable and from nowhere else, and this verb creates nothing without it. Nothing was stored and no vault was created.\n\n${passphraseHint(variable, context.logPath, envFilePathFor(context.logPath))}`,
      helpText,
    );
  }

  const vaultPath = vaultPathFor(context.logPath);
  const probe = deps.probe ?? probeSmtp;

  const result: FlowResult = await runCredentialFlow({
    streams,
    prompter: context.prompter,
    specs: entry.specs,
    destination: vaultDestination(vaultPath, passphrase),
    labels: {
      title: `approval setup adapter ${name} — ${entry.summary}.`,
      prereq: `The values go into the VAULT (SPEC.md §10.4), not into the OS keystore and not\ninto .approval/env: what this verb stores is what a gated adapter spends inside\na verified-token window. Nothing here appends to the log or attests anything.`,
      nextSteps: entry.nextSteps,
    },
    hooks: {
      ...(entry.check === undefined ? {} : { check: entry.check }),
      verify: (values, progress) =>
        entry.verify(values, {
          written: progress.written,
          skipped: progress.skipped,
          prompter: context.prompter,
          probe,
        }),
    },
  });

  // The flow decided the code; this verb adds nothing to it.
  return result.code;
}
