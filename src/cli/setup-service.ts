/**
 * `approval setup service` — the login service that runs the ambient runtime
 * (SPEC.md §10.2, APRV-110).
 *
 * `approval up` is a foreground process. This verb writes the one file that
 * makes it start at login and stay started: a launchd user agent on macOS, or a
 * systemd user unit on Linux. It is the fifth member of the `setup` family and
 * it obeys the family's rules — interactive by refusal, human-only, appending
 * nothing to the log, editing no policy — with two of its own.
 *
 * ## It never copies a value
 *
 * A unit file is world-readable configuration that survives reboots and gets
 * backed up. A bot token in one is a bot token in a backup. So the unit NAMES
 * where the environment comes from and never carries it:
 *
 * - by default it runs a WRAPPER the human reads in the printed unit —
 *   `eval "$(approval env)"` and then `exec approval up` — so the keystore
 *   references stay in the keystore and `approval env` stays the only thing
 *   that resolves them (SPEC.md §11.1 invariant 7: nothing loads that file
 *   implicitly, and here it is a human's line in a file they approved);
 * - or, with `--env-file`, it points at a file THE OPERATOR AUTHORED, which
 *   this verb neither writes nor reads.
 *
 * ## It prints the unit before it writes it, and it does not arm it
 *
 * The whole file goes to stdout first, and nothing is written until the operator
 * confirms. Loading it is a separate act: this verb prints the exact
 * `launchctl` or `systemctl` line and stops there. A login service is a standing
 * capability on someone's machine — it will start a process that holds a
 * credential and can put prompts on a phone — and a wizard that armed one as a
 * side effect of writing a file would be making that decision on the operator's
 * behalf. Printing the command costs one paste and buys an explicit act.
 *
 * ## Logs never go into `.approval/`
 *
 * The service's stdout and stderr go where the operator chooses, defaulting to
 * the platform's own log home. A path inside the approval home is REFUSED:
 * `.approval/` holds the log, the queue projection, the payload store, the
 * vault and the environment source map, and a service that appended its console
 * output beside them would put unverifiable text in the one directory whose
 * contents are supposed to mean something.
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";

import { envFilePathFor } from "../core/env-file.js";
import { telegramChatEnvFor, telegramTokenEnvFor } from "../core/telegram-config.js";
import { passphraseEnvFor } from "../core/vault.js";
import { HUMAN_ACTOR_ENV } from "../core/attest.js";
import { stringFlag, boolFlag, type FlagKind } from "./args.js";
import { EXIT_IO, EXIT_OK } from "./exit-codes.js";
import { SETUP_SERVICE_HELP } from "./help.js";
import type { Streams } from "./main.js";
import {
  absolute,
  front,
  requireHuman,
  usageError,
  type HintContext,
  type SetupDeps,
} from "./setup-common.js";

/** The two service managers this verb writes for. */
export type ServicePlatform = "launchd" | "systemd";

const SERVICE_FLAGS: Record<string, FlagKind> = {
  "--platform": "string",
  "--label": "string",
  "--logs": "string",
  "--env-file": "string",
  "--exec": "string",
  "--out": "string",
  "--uninstall": "boolean",
};

/** The conventional names. `--label` overrides both. */
export const LAUNCHD_LABEL = "md.approval.up";
export const SYSTEMD_UNIT = "approval-up";

/** Which manager this machine has, or `null` when it has neither. */
export function platformFor(platform: NodeJS.Platform): ServicePlatform | null {
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd";
  return null;
}

/** Where the unit file belongs, for a platform and a label. */
export function unitPathFor(platform: ServicePlatform, label: string, home: string): string {
  return platform === "launchd"
    ? join(home, "Library", "LaunchAgents", `${label}.plist`)
    : join(home, ".config", "systemd", "user", `${label}.service`);
}

/** Where the platform keeps a user's own logs. */
export function defaultLogsDir(platform: ServicePlatform, home: string): string {
  return platform === "launchd"
    ? join(home, "Library", "Logs", "approval")
    : join(home, ".local", "state", "approval");
}

/** The command that arms the written unit, printed and never run. */
export function armCommand(platform: ServicePlatform, label: string, path: string): string {
  return platform === "launchd"
    ? `launchctl bootstrap gui/$(id -u) ${path}`
    : `systemctl --user daemon-reload && systemctl --user enable --now ${label}.service`;
}

/**
 * The command that disarms it, printed before the file is removed.
 *
 * Takes no path, unlike {@link armCommand}: launchd boots a service OUT by its
 * label, and the plist it was booted in from may already be gone.
 */
export function disarmCommand(platform: ServicePlatform, label: string): string {
  return platform === "launchd"
    ? `launchctl bootout gui/$(id -u)/${label}`
    : `systemctl --user disable --now ${label}.service`;
}

/**
 * XML text, escaped. A plist is XML, and a working directory with an `&` in it
 * would otherwise produce a file launchd refuses to parse.
 */
function xml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Everything a unit is generated from, all of it already resolved. */
export interface ServicePlan {
  platform: ServicePlatform;
  label: string;
  /** The unit file this would be written to. */
  path: string;
  /** The primary checkout the runtime is started in. */
  workingDir: string;
  /** The `approval` invocation, as argv words. */
  exec: string[];
  /** An operator-authored EnvironmentFile, or `null` for the `approval env` wrapper. */
  envFile: string | null;
  outLog: string;
  errLog: string;
  /** The variable NAMES the runtime will look for. Printed as a comment only. */
  variables: string[];
}

/** One `sh -lc` script: the wrapper the operator reads inside the unit. */
export function wrapperScript(plan: ServicePlan): string {
  const exec = plan.exec.join(" ");
  const source =
    plan.envFile === null
      ? `eval "$(${exec} env)"`
      : `set -a; . '${plan.envFile}'; set +a`;
  return `cd '${plan.workingDir}' && ${source} && exec ${exec} up --json`;
}

/** The whole unit file, as the operator will read it and as it will be written. */
export function renderUnit(plan: ServicePlan): string {
  const names = plan.variables.join(", ");
  if (plan.platform === "launchd") {
    return [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
      `<!-- approval.md: the ambient runtime (approval up) at login.`,
      `     No credential value appears in this file. The wrapper below resolves`,
      `     ${names}`,
      `     through \`approval env\`, which reads .approval/env and the OS keystore. -->`,
      `<plist version="1.0">`,
      `<dict>`,
      `  <key>Label</key><string>${xml(plan.label)}</string>`,
      `  <key>ProgramArguments</key>`,
      `  <array>`,
      `    <string>/bin/sh</string>`,
      `    <string>-lc</string>`,
      `    <string>${xml(wrapperScript(plan))}</string>`,
      `  </array>`,
      `  <key>WorkingDirectory</key><string>${xml(plan.workingDir)}</string>`,
      `  <key>RunAtLoad</key><true/>`,
      `  <key>KeepAlive</key><true/>`,
      `  <key>StandardOutPath</key><string>${xml(plan.outLog)}</string>`,
      `  <key>StandardErrorPath</key><string>${xml(plan.errLog)}</string>`,
      `</dict>`,
      `</plist>`,
      ``,
    ].join("\n");
  }
  return [
    `# approval.md: the ambient runtime (approval up) at login.`,
    `# No credential value appears in this file. The environment is resolved`,
    `# for ${names}`,
    plan.envFile === null
      ? `# through \`approval env\` in the ExecStart wrapper below.`
      : `# from the EnvironmentFile below, which you wrote and this verb never read.`,
    `[Unit]`,
    `Description=approval.md ambient runtime (daemon and channels)`,
    `After=default.target`,
    ``,
    `[Service]`,
    `Type=simple`,
    `WorkingDirectory=${plan.workingDir}`,
    ...(plan.envFile === null ? [] : [`EnvironmentFile=${plan.envFile}`]),
    `ExecStart=/bin/sh -lc '${wrapperScript(plan).replaceAll("'", `'\\''`)}'`,
    `Restart=always`,
    `RestartSec=5`,
    `StandardOutput=append:${plan.outLog}`,
    `StandardError=append:${plan.errLog}`,
    ``,
    `[Install]`,
    `WantedBy=default.target`,
    ``,
  ].join("\n");
}

const SERVICE_HINT = (where: HintContext): string =>
  `  # write the unit yourself; \`approval setup service\` only generates it:\n  approval setup service --platform launchd|systemd   # from a terminal\n\n  # whatever you write, it must name variables and never values:\n  #   ${where.tokenEnv}, ${where.chatEnv}, ${where.passphraseEnv}, ${HUMAN_ACTOR_ENV}\n  # resolved by \`eval "$(approval env)"\` in the unit's own wrapper.`;

/**
 * The approval invocation this process was started as.
 *
 * `node dist/src/cli/main.js` and the installed `approval` bin are both
 * legitimate, and a unit that named the wrong one would fail at login rather
 * than here. `--exec` overrides for the case neither guess fits.
 */
export function execWords(override: string | null, argv: readonly string[]): string[] {
  if (override !== null) return [override];
  const entry = argv[1];
  if (entry === undefined) return ["approval"];
  return entry.endsWith(".js") || entry.endsWith(".mjs") ? [argv[0] ?? "node", entry] : [entry];
}

/** A path a single-quoted shell word cannot carry safely. */
function unquotable(path: string): boolean {
  return path.includes("'") || path.includes("\n");
}

/** `approval setup service` — write the login unit. HUMAN-ONLY, INTERACTIVE. */
export function commandSetupService(
  argv: string[],
  streams: Streams,
  cwd: string,
  deps: SetupDeps = {},
): number {
  const outcome = front(
    "service",
    argv,
    streams,
    cwd,
    deps,
    SETUP_SERVICE_HELP,
    SERVICE_HINT,
    SERVICE_FLAGS,
  );
  if (outcome.kind === "handled") return outcome.code;
  const context = outcome;

  const human = requireHuman(context.flags, streams, SETUP_SERVICE_HELP, "service");
  if (!human.ok) return human.code;

  const extra = context.positionals[0];
  if (extra !== undefined) {
    return usageError(
      streams,
      false,
      `unexpected argument ${JSON.stringify(extra)}`,
      SETUP_SERVICE_HELP,
    );
  }

  const platformFlag = stringFlag(context.flags, "--platform");
  if (platformFlag !== null && platformFlag !== "launchd" && platformFlag !== "systemd") {
    return usageError(
      streams,
      false,
      `--platform expects launchd or systemd, got ${JSON.stringify(platformFlag)}`,
      SETUP_SERVICE_HELP,
    );
  }
  const platform = (platformFlag as ServicePlatform | null) ?? platformFor(process.platform);
  if (platform === null) {
    return usageError(
      streams,
      false,
      `no login service manager is known for ${process.platform}: this verb writes a launchd plist (macOS) or a systemd user unit (Linux). Run \`approval up\` under whatever supervisor this machine has, or pass --platform to generate a unit for another machine`,
      SETUP_SERVICE_HELP,
    );
  }

  const home = homedir();
  const label =
    stringFlag(context.flags, "--label") ??
    (platform === "launchd" ? LAUNCHD_LABEL : SYSTEMD_UNIT);
  const outFlag = stringFlag(context.flags, "--out");
  const unitPath =
    outFlag === null ? unitPathFor(platform, label, home) : absolute(outFlag, cwd);

  // -------------------------------------------------------------------------
  // Uninstall
  // -------------------------------------------------------------------------

  if (boolFlag(context.flags, "--uninstall")) {
    if (!existsSync(unitPath)) {
      streams.out(`nothing to remove: ${unitPath} does not exist\n`);
      return EXIT_OK;
    }
    streams.out(
      `approval setup service --uninstall — removes ${unitPath}.\n\nSTOP IT FIRST, or the running process outlives the file that describes it:\n\n  ${disarmCommand(platform, label)}\n\n`,
    );
    if (!context.prompter.confirm(`remove ${unitPath}?`)) {
      streams.out("aborted: nothing was removed\n");
      return EXIT_OK;
    }
    try {
      unlinkSync(unitPath);
    } catch (cause) {
      streams.err(
        `approval: ${unitPath} could not be removed: ${
          cause instanceof Error ? cause.message : String(cause)
        }\n`,
      );
      return EXIT_IO;
    }
    streams.out(`removed ${unitPath}\n`);
    streams.out(
      `\nThe log, the policy and .approval/ are untouched: this verb only ever wrote\nthe unit file. Nothing was appended anywhere.\n`,
    );
    return EXIT_OK;
  }

  // -------------------------------------------------------------------------
  // The plan
  // -------------------------------------------------------------------------

  const workingDir = absolute(stringFlag(context.flags, "--dir") ?? cwd, cwd);
  const approvalHome = dirname(envFilePathFor(context.logPath));

  const logsFlag = stringFlag(context.flags, "--logs");
  const logsDir = logsFlag === null ? defaultLogsDir(platform, home) : absolute(logsFlag, cwd);
  if (logsDir === approvalHome || logsDir.startsWith(`${approvalHome}${sep}`)) {
    return usageError(
      streams,
      false,
      `--logs ${logsDir} is inside ${approvalHome}, and a service's console output never goes there: that directory holds the log, the queue projection, the payload store and the environment source map, and unverifiable text beside them is exactly what makes a directory stop meaning something`,
      SETUP_SERVICE_HELP,
    );
  }

  const envFileFlag = stringFlag(context.flags, "--env-file");
  const envFile = envFileFlag === null ? null : absolute(envFileFlag, cwd);
  const exec = execWords(stringFlag(context.flags, "--exec"), process.argv);

  for (const path of [workingDir, logsDir, ...(envFile === null ? [] : [envFile]), ...exec]) {
    if (unquotable(path)) {
      return usageError(
        streams,
        false,
        `${JSON.stringify(path)} carries a quote or a newline, which cannot be placed in the unit's shell wrapper safely. Move it, or write the unit by hand`,
        SETUP_SERVICE_HELP,
      );
    }
  }

  const plan: ServicePlan = {
    platform,
    label,
    path: unitPath,
    workingDir,
    exec,
    envFile,
    outLog: join(logsDir, "approval-up.out.log"),
    errLog: join(logsDir, "approval-up.err.log"),
    variables: [
      HUMAN_ACTOR_ENV,
      telegramTokenEnvFor(context.load),
      telegramChatEnvFor(context.load),
      passphraseEnvFor(context.load),
    ],
  };

  const unit = renderUnit(plan);

  streams.out(
    `approval setup service — writes the ${
      platform === "launchd" ? "launchd user agent" : "systemd user unit"
    } that runs\n\`approval up\` in ${workingDir} at login.\n\nNO CREDENTIAL VALUE APPEARS IN IT. ${
      envFile === null
        ? "The wrapper below evaluates `approval env`, which\nresolves the keystore references in .approval/env at start time."
        : `The unit reads ${envFile}, which you wrote\nand this verb has neither read nor written.`
    }\nIts console output goes to ${logsDir}, never into ${approvalHome}.\n\nRead it before it exists:\n\n`,
  );
  streams.out(`${unit}\n`);

  if (existsSync(unitPath)) {
    streams.out(
      `WARNING: ${unitPath} already exists and would be REPLACED. If a service is\nloaded from it, stop it first:\n\n  ${disarmCommand(platform, label)}\n\n`,
    );
  }
  if (!context.prompter.confirm(`write it to ${unitPath}?`)) {
    streams.out("aborted: nothing was written\n");
    return EXIT_OK;
  }

  try {
    mkdirSync(dirname(unitPath), { recursive: true });
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(unitPath, unit, { encoding: "utf8", mode: 0o644 });
  } catch (cause) {
    streams.err(
      `approval: ${unitPath} could not be written: ${
        cause instanceof Error ? cause.message : String(cause)
      }\n`,
    );
    return EXIT_IO;
  }

  streams.out(`wrote ${unitPath}\n  logs -> ${plan.outLog}\n  logs -> ${plan.errLog}\n`);
  streams.out(
    `\nIT IS NOT RUNNING YET, and this verb will not start it: a service that starts\nat login is a standing capability on this machine, so arming it is your act and\nnot a side effect of writing a file. One command:\n\n  ${armCommand(platform, label, unitPath)}\n\nUndo the whole thing with \`approval setup service --uninstall\`, which prints\nthe stop command and removes the file.\n`,
  );
  return EXIT_OK;
}
