/**
 * `approval quickstart` (APRV-309): one human ceremony for a small, operative
 * policy. The command is terminal-only, displays the exact bytes it will
 * attest, and leaves any interrupted setup unattested.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve as resolvePathSegments } from "node:path";
import { fileURLToPath } from "node:url";

import { appendAttestation, HUMAN_ACTOR_ENV, policyBytesHash } from "../core/attest.js";
import { SECRET_ENV_PREFIXES } from "../core/child-env.js";
import {
  defaultSourceRunner,
  envFilePathFor,
  resolveEnvironment,
  upsertEnvFileEntries,
  type SourceRunner,
} from "../core/env-file.js";
import { loadPolicy, loadPolicyText } from "../core/policy-load.js";
import { parseFlags, boolFlag, stringFlag, type FlagKind } from "./args.js";
import { EXIT_INTEGRITY, EXIT_IO, EXIT_OK, EXIT_TORN_TAIL, EXIT_USAGE } from "./exit-codes.js";
import { QUICKSTART_HELP } from "./help.js";
import { commandInit } from "./init.js";
import type { Streams } from "./main.js";
import { DEFAULT_LOG_PATH } from "./paths.js";
import { askUntil, createPrompter, type AnswerVerdict, type Prompter } from "./prompt.js";
import { commandSetupChannel } from "./setup-channel.js";
import type { SetupDeps } from "./setup-common.js";
import { identityFromAnswer } from "./setup.js";
import { usageErrorText } from "./usage.js";

const FLAGS: Record<string, FlagKind> = {
  "--dir": "string",
  "--api-base": "string",
  "--json": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

export const QUICKSTART_CLASSES = [
  { pattern: "communicate.*", label: "send a message or email" },
  { pattern: "financial.*", label: "spend money" },
  { pattern: "files.delete.*", label: "delete files" },
  { pattern: "public.*", label: "post publicly" },
  { pattern: "vcs.push.main", label: "push to main" },
] as const;

type Channel = "cli" | "telegram";

export interface QuickstartDeps {
  prompter?: Prompter | null;
  setup?: SetupDeps;
  sourceRunner?: SourceRunner;
  doctor?: (
    dir: string,
    actor: string,
    resolvedEnv: Readonly<Record<string, string>>,
    apiBase: string | null,
  ) => Promise<DoctorRun>;
}

interface DoctorRun { code: number; stdout: string; stderr: string }

const DOCTOR_TIMEOUT_MS = 20_000;
const DOCTOR_OUTPUT_LIMIT_BYTES = 256 * 1024;

function absolute(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolvePathSegments(cwd, value);
}

function refusal(streams: Streams, message: string): number {
  streams.err(usageErrorText(message, QUICKSTART_HELP));
  return EXIT_USAGE;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function nonInteractive(streams: Streams, json: boolean): number {
  const message =
    "quickstart needs a human at a terminal and has no JSON mode. Non-interactive equivalent: run `approval init`, write and review APPROVAL.md, run `approval setup identity`, optionally run `approval setup channel telegram`, then run `approval policy attest --as human:<id>`.";
  if (json) streams.err(`${JSON.stringify({ error: { code: "usage", message } })}\n`);
  else streams.err(usageErrorText(message, QUICKSTART_HELP));
  return EXIT_USAGE;
}

function channelAnswer(answer: string): AnswerVerdict<Channel> {
  switch (answer.trim().toLowerCase()) {
    case "1":
    case "terminal":
    case "cli":
      return { ok: true, value: "cli" };
    case "2":
    case "telegram":
      return { ok: true, value: "telegram" };
    default:
      return { ok: false, reason: "choose 1 for this terminal or 2 for Telegram" };
  }
}

function classesAnswer(answer: string): AnswerVerdict<string[]> {
  const typed = answer.trim().toLowerCase();
  if (typed.length === 0 || typed === "all") {
    return { ok: true, value: QUICKSTART_CLASSES.map((entry) => entry.pattern) };
  }
  if (typed === "none") return { ok: true, value: [] };
  const indexes = typed.split(",").map((part) => Number(part.trim()));
  if (indexes.some((index) => !Number.isInteger(index) || index < 1 || index > QUICKSTART_CLASSES.length)) {
    return { ok: false, reason: "enter comma-separated numbers 1-5, all, none, or press Enter for all" };
  }
  return {
    ok: true,
    value: [...new Set(indexes)].map((index) => QUICKSTART_CLASSES[index - 1]?.pattern as string),
  };
}

function quickstartIdentity(answer: string): AnswerVerdict<string> {
  const parsed = identityFromAnswer(answer);
  if (!parsed.ok) return parsed;
  const humanId = parsed.value.slice("human:".length);
  return /^[a-z0-9][a-z0-9_-]*$/u.test(humanId)
    ? parsed
    : { ok: false, reason: "the id must start with a lowercase letter or digit and contain only lowercase letters, digits, _ or -" };
}

export function renderSoloPolicy(humanId: string, channel: Channel, patterns: readonly string[]): string {
  const rules = patterns
    .map((pattern) => `  ${pattern}:\n    autonomy: manual\n    approvers: [${humanId}]`)
    .join("\n");
  const channelBlock = channel === "telegram"
    ? "\nchannels:\n  telegram:\n    chat_id_env: APPROVAL_TG_CHAT\n    token_env: APPROVAL_TG_TOKEN\n"
    : "";
  return `# Approval Policy\n\nThis is a solo policy. The selected class families ask the person below.\nOther classified reversible actions use the autonomous default. Runtime safety\nfloors and unclassified-command refusals still apply.\n\n\`\`\`yaml approval-policy\nversion: "0.1"\n\ndefaults:\n  autonomy: autonomous       # Tighten to manual to make every unnamed class ask.\n  channel: ${channel}\n  approval_ttl: 24h\n  on_expiry: reject\n\napprovers:\n  ${humanId}:\n    channels: [${channel}]\n\nclasses:\n${rules.length === 0 ? "  {}" : rules}\n${channelBlock}\`\`\`\n\nNo audit block means retrospective sampling is off. Add one only through a\nhuman-reviewed policy amendment; see \`approval policy amend --help\`.\n`;
}

function appendBounded(current: string, chunk: string, limit: number): { text: string; overflow: boolean } {
  const remaining = limit - Buffer.byteLength(current);
  if (remaining <= 0) return { text: current, overflow: true };
  const bytes = Buffer.from(chunk);
  if (bytes.byteLength <= remaining) return { text: current + chunk, overflow: false };
  return { text: current + bytes.subarray(0, remaining).toString("utf8"), overflow: true };
}

export function runQuickstartDoctor(
  dir: string,
  actor: string,
  resolvedEnv: Readonly<Record<string, string>>,
  apiBase: string | null,
  options: {
    timeoutMs?: number;
    outputLimitBytes?: number;
    spawnChild?: typeof spawn;
  } = {},
): Promise<DoctorRun> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // The check must not borrow identity or credentials from another instance.
    // Only values explicitly resolved from this quickstart's source map return.
    for (const name of Object.keys(env)) {
      if (SECRET_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) delete env[name];
    }
    Object.assign(env, resolvedEnv, { [HUMAN_ACTOR_ENV]: actor });
    const cliEntry = fileURLToPath(new URL("./main.js", import.meta.url));
    const childArgs = [cliEntry, "doctor", "--json", "--dir", dir];
    if (apiBase !== null) childArgs.push("--api-base", apiBase);
    const child = (options.spawnChild ?? spawn)(process.execPath, childArgs, {
      cwd: dir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const outputLimit = options.outputLimitBytes ?? DOCTOR_OUTPUT_LIMIT_BYTES;
    const finish = (result: DoctorRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const abortForOutput = (): void => {
      child.kill("SIGTERM");
      finish({ code: EXIT_IO, stdout, stderr: `${stderr}approval doctor output exceeded ${String(outputLimit)} bytes and was stopped\n` });
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text: string) => {
      const next = appendBounded(stdout, text, outputLimit);
      stdout = next.text;
      if (next.overflow) abortForOutput();
    });
    child.stderr.on("data", (text: string) => {
      const next = appendBounded(stderr, text, outputLimit);
      stderr = next.text;
      if (next.overflow) abortForOutput();
    });
    child.once("error", (cause) => finish({ code: EXIT_IO, stdout, stderr: `${stderr}${cause.message}\n` }));
    child.once("close", (code) => finish({ code: code ?? EXIT_IO, stdout, stderr }));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ code: EXIT_IO, stdout, stderr: `${stderr}approval doctor exceeded ${String(options.timeoutMs ?? DOCTOR_TIMEOUT_MS)}ms and was stopped\n` });
    }, options.timeoutMs ?? DOCTOR_TIMEOUT_MS);
    timer.unref();
  });
}

function doctorPreflight(run: DoctorRun): { ok: true } | { ok: false; message: string; code: number } {
  if (run.code === EXIT_OK) return { ok: true };
  if (run.code === EXIT_INTEGRITY) {
    try {
      const report = JSON.parse(run.stdout) as {
        checks?: Array<{ check?: unknown; status?: unknown; detail?: unknown }>;
      };
      const failed = report.checks?.filter((check) => check.status === "fail") ?? [];
      if (
        failed.length === 1 &&
        failed[0]?.check === "attestation" &&
        typeof failed[0].detail === "string" &&
        failed[0].detail.includes("has never been attested")
      ) return { ok: true };
    } catch {
      // The diagnostic's malformed output is reported below with its exit.
    }
  }
  return {
    ok: false,
    code: run.code,
    message: `approval doctor preflight reported a setup problem; the policy remains unattested:\n${run.stderr}${run.stdout}`,
  };
}

export async function commandQuickstart(
  argv: string[], streams: Streams, cwd: string, deps: QuickstartDeps = {},
): Promise<number> {
  const json = argv.includes("--json");
  const parsed = parseFlags(argv, FLAGS);
  if (!parsed.ok) return refusal(streams, parsed.message);
  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${QUICKSTART_HELP}\n`);
    return EXIT_OK;
  }
  if (parsed.positionals.length > 0) return refusal(streams, `unexpected argument ${JSON.stringify(parsed.positionals[0])}`);
  const prompter = deps.prompter === undefined ? createPrompter(streams) : deps.prompter;
  if (json || prompter === null) return nonInteractive(streams, json);

  const dirFlag = stringFlag(parsed.flags, "--dir");
  const dir = dirFlag === null ? cwd : absolute(dirFlag, cwd);
  const apiBase = stringFlag(parsed.flags, "--api-base");
  if (
    existsSync(join(dir, "APPROVAL.md")) ||
    existsSync(join(dir, "APPROVALS.md")) ||
    existsSync(join(dir, ".approval"))
  ) {
    streams.err(`approval: setup artifacts already exist in ${dir}; quickstart only initializes a fresh instance and changed nothing\n`);
    return EXIT_IO;
  }
  streams.out("approval quickstart — three decisions to make a solo gate operative.\n\n");

  const identity = askUntil(streams, prompter, "1/3 your name (for human:<id>): ", quickstartIdentity);
  if (!identity.ok) return refusal(streams, "no valid human identity was entered; nothing was written");
  const actor = identity.value;
  const humanId = actor.slice("human:".length);

  const channel = askUntil(streams, prompter, "2/3 button location (1 terminal, 2 Telegram): ", channelAnswer);
  if (!channel.ok) return refusal(streams, "no channel was chosen; nothing was written");
  streams.out(`${QUICKSTART_CLASSES.map((entry, index) => `  ${String(index + 1)}. ${entry.label}`).join("\n")}\n`);
  const selected = askUntil(streams, prompter, "3/3 always ask (numbers, Enter for all): ", classesAnswer);
  if (!selected.ok) return refusal(streams, "no valid checklist was entered; nothing was written");

  const policy = renderSoloPolicy(humanId, channel.value, selected.value);
  const loaded = loadPolicyText(join(dir, "APPROVAL.md"), policy);
  if (!loaded.ok) {
    streams.err(`approval: generated policy failed validation: ${loaded.message}\n`);
    return EXIT_IO;
  }
  let initOut = "";
  let initErr = "";
  const initCode = commandInit([], { out: (text) => { initOut += text; }, err: (text) => { initErr += text; } }, dir, { policyText: policy });
  if (initCode !== EXIT_OK) {
    streams.err(`${initErr}${initOut}`);
    return initCode;
  }
  const envPath = envFilePathFor(join(dir, DEFAULT_LOG_PATH));
  const envWrite = upsertEnvFileEntries(envPath, [{ key: HUMAN_ACTOR_ENV, value: actor }]);
  if (!envWrite.ok) {
    streams.err(`approval: ${envWrite.message}\n`);
    return EXIT_IO;
  }

  if (channel.value === "telegram") {
    const setupArgs = ["telegram", "--as", actor, "--dir", dir];
    if (apiBase !== null) setupArgs.push("--api-base", apiBase);
    const setupCode = await commandSetupChannel(setupArgs, streams, dir, { ...deps.setup, prompter });
    if (setupCode !== EXIT_OK) return setupCode;
  }

  const onDisk = loadPolicy({ dir });
  if (!onDisk.ok) {
    streams.err(`approval: generated policy could not be reloaded for preflight: ${onDisk.message}\n`);
    return EXIT_IO;
  }
  const resolution = resolveEnvironment(
    onDisk,
    envPath,
    deps.sourceRunner ?? defaultSourceRunner,
    {},
  );
  if (!resolution.ok) {
    streams.err(`approval: quickstart environment could not be resolved: ${resolution.message}\n`);
    return EXIT_IO;
  }
  const resolvedEnv: Record<string, string> = {};
  for (const variable of resolution.variables) {
    if (variable.value !== undefined) resolvedEnv[variable.name] = variable.value;
    else if (variable.declared) {
      streams.err(`approval: ${variable.name} could not be resolved from this instance (${variable.source}); the policy remains unattested\n`);
      return EXIT_IO;
    }
  }
  const doctor = await (deps.doctor ?? runQuickstartDoctor)(dir, actor, resolvedEnv, apiBase);
  const preflight = doctorPreflight(doctor);
  if (!preflight.ok) {
    streams.err(preflight.message);
    return preflight.code;
  }

  streams.out(`\nReview the exact policy that will become operative:\n\n${policy}\n`);
  const understood = askUntil(streams, prompter, "type understood to attest these exact bytes: ", (answer) =>
    answer.trim() === "understood"
      ? { ok: true, value: true }
      : { ok: false, reason: "type understood exactly, or Ctrl-D to leave the policy unattested" });
  if (!understood.ok) return refusal(streams, "policy left unattested");

  const attestation = appendAttestation(
    join(dir, DEFAULT_LOG_PATH),
    join(dir, "APPROVAL.md"),
    actor,
    { expectedSha256: policyBytesHash(Buffer.from(policy, "utf8")) },
  );
  if (!attestation.ok) {
    streams.err(`approval: ${attestation.error.message}\n`);
    return attestation.error.code === "corrupt-tail" ? EXIT_TORN_TAIL : EXIT_IO;
  }

  streams.out(`ready: ${String(selected.value.length)} selected class families ask ${actor} on ${channel.value}; other classified reversible actions use the autonomous default\n`);
  streams.out(`activate: eval "$(approval env --dir ${shellQuote(dir)})"\n`);
  streams.out("try: approval hook classify -- curl -X POST https://api.example.com/apply\n");
  return EXIT_OK;
}
