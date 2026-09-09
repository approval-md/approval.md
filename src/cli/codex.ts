import { resolve } from "node:path";

import { boolFlag, parseFlags, stringFlag } from "./args.js";
import { EXIT_INTEGRITY, EXIT_IO, EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { CODEX_HELP } from "./help.js";
import type { Streams } from "./main.js";
import { usageErrorText } from "./usage.js";
import { strictDoctor } from "../codex/doctor.js";
import { checkBundle, prepareBundle } from "../codex/templates.js";

function emitError(streams: Streams, json: boolean, code: string, message: string): void {
  if (json) streams.err(`${JSON.stringify({ error: { code, message } })}\n`);
  else streams.err(`approval: ${message}\n`);
}

function usage(streams: Streams, json: boolean, message: string): number {
  if (json) emitError(streams, true, "usage", message);
  else streams.err(usageErrorText(message, CODEX_HELP));
  return EXIT_USAGE;
}

function required(flags: Record<string, string | boolean>, name: string): string | null {
  const value = stringFlag(flags, name);
  return value === null || value.length === 0 ? null : value;
}

export function commandCodex(argv: string[], streams: Streams, cwd: string): number {
  const json = argv.includes("--json");
  const subcommand = argv[0];
  const rest = argv.slice(1);
  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
    streams.out(`${CODEX_HELP}\n`);
    return subcommand === undefined ? EXIT_USAGE : EXIT_OK;
  }

  if (subcommand === "prepare") {
    const parsed = parseFlags(rest, {
      "--instance": "string",
      "--workspace": "string",
      "--primary": "string",
      "--install-root": "string",
      "--output": "string",
      "--codex": "string",
      "--node": "string",
      "--json": "boolean",
      "--help": "boolean",
      "-h": "boolean",
    });
    if (!parsed.ok) return usage(streams, json, parsed.message);
    if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
      streams.out(`${CODEX_HELP}\n`);
      return EXIT_OK;
    }
    if (parsed.positionals.length > 0) return usage(streams, json, "prepare takes flags only");
    const names = ["--instance", "--workspace", "--primary", "--install-root", "--output", "--codex", "--node"] as const;
    const values = Object.fromEntries(names.map((name) => [name, required(parsed.flags, name)]));
    const missing = names.find((name) => values[name] === null);
    if (missing !== undefined) return usage(streams, json, `prepare requires ${missing}`);
    const result = prepareBundle({
      instanceId: values["--instance"] as string,
      workspace: resolve(cwd, values["--workspace"] as string),
      primary: resolve(cwd, values["--primary"] as string),
      installRoot: resolve(cwd, values["--install-root"] as string),
      output: resolve(cwd, values["--output"] as string),
      codexExecutable: resolve(cwd, values["--codex"] as string),
      nodeExecutable: resolve(cwd, values["--node"] as string),
    });
    if (!result.ok) {
      emitError(streams, json, result.code, result.message);
      return result.code === "manifest-invalid" || result.code === "output-overlap" ? EXIT_INTEGRITY : EXIT_IO;
    }
    if (json) streams.out(`${JSON.stringify({ ok: true, inert: true, output: result.output, files: result.files, manifest: result.manifest })}\n`);
    else streams.out(`Prepared inert Codex host bundle at ${result.output}. Review it; no host configuration changed.\n`);
    return EXIT_OK;
  }

  if (subcommand === "setup") {
    const parsed = parseFlags(rest, {
      "--check": "string",
      "--json": "boolean",
      "--help": "boolean",
      "-h": "boolean",
    });
    if (!parsed.ok) return usage(streams, json, parsed.message);
    if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
      streams.out(`${CODEX_HELP}\n`);
      return EXIT_OK;
    }
    if (parsed.positionals.length > 0) return usage(streams, json, "setup takes flags only");
    const directory = required(parsed.flags, "--check");
    if (directory === null) return usage(streams, json, "setup requires --check <bundle>");
    const result = checkBundle(resolve(cwd, directory));
    if (!result.ok) {
      emitError(streams, json, result.code, result.message);
      return EXIT_INTEGRITY;
    }
    const response = {
      ok: true,
      inert: true,
      ready: false,
      bundle: resolve(cwd, directory),
      files: result.files,
      reason: "broker-and-runner-not-shipped",
    };
    if (json) streams.out(`${JSON.stringify(response)}\n`);
    else streams.out("Bundle is internally consistent and inert. Broker and runner are not shipped; do not activate it.\n");
    return EXIT_OK;
  }

  if (subcommand === "doctor") {
    const parsed = parseFlags(rest, {
      "--manifest": "string",
      "--strict": "boolean",
      "--json": "boolean",
      "--help": "boolean",
      "-h": "boolean",
    });
    if (!parsed.ok) return usage(streams, json, parsed.message);
    if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
      streams.out(`${CODEX_HELP}\n`);
      return EXIT_OK;
    }
    if (parsed.positionals.length > 0) return usage(streams, json, "doctor takes flags only");
    if (!boolFlag(parsed.flags, "--strict")) return usage(streams, json, "doctor requires --strict");
    const manifest = required(parsed.flags, "--manifest");
    if (manifest === null) return usage(streams, json, "doctor requires --manifest <path>");
    const result = strictDoctor(resolve(cwd, manifest));
    if (!result.ok) {
      if (json) streams.err(`${JSON.stringify({ ok: false, ready: false, error: { code: result.code, message: result.message }, findings: result.report?.findings ?? [] })}\n`);
      else {
        streams.err(`approval: ${result.message}\n`);
        for (const finding of result.report?.findings ?? []) {
          streams.err(`  ${finding.code}${finding.path === undefined ? "" : ` ${finding.path}`}: ${finding.message}\n`);
        }
      }
      return EXIT_INTEGRITY;
    }
    return EXIT_OK;
  }

  if (subcommand === "start" || subcommand === "serve") {
    const parsed = parseFlags(rest, {
      "--manifest": "string",
      "--json": "boolean",
      "--help": "boolean",
      "-h": "boolean",
    });
    if (!parsed.ok) return usage(streams, json, parsed.message);
    if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
      streams.out(`${CODEX_HELP}\n`);
      return EXIT_OK;
    }
    if (parsed.positionals.length > 0) return usage(streams, json, `${subcommand} takes flags only`);
    if (required(parsed.flags, "--manifest") === null) return usage(streams, json, `${subcommand} requires --manifest <path>`);
    emitError(streams, json, "codex-not-ready", `codex ${subcommand} is not implemented until APRV-325.2 and APRV-325.3 provide the broker and runner`);
    return EXIT_INTEGRITY;
  }

  return usage(streams, json, `unknown codex subcommand ${JSON.stringify(subcommand)}`);
}
