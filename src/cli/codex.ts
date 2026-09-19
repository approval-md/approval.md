import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { boolFlag, parseFlags, stringFlag } from "./args.js";
import { EXIT_INTEGRITY, EXIT_IO, EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { CODEX_HELP } from "./help.js";
import type { Streams } from "./main.js";
import { usageErrorText } from "./usage.js";
import {
  applyWorkspaceChange,
  brokerInstallation,
  type BrokerInstallation,
  type BrokerOptions,
} from "../codex/broker.js";
import { strictDoctor } from "../codex/doctor.js";
import { readCodexInstance } from "../codex/manifest.js";
import { planConfinedSession, runConfined } from "../codex/runner.js";
import { serveCodexBroker } from "../codex/serve.js";
import { checkBundle, prepareBundle } from "../codex/templates.js";
import { recoverWorkspaceCommit } from "../codex/workspace-commit.js";
import { parseDuration } from "../core/policy-load.js";

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

/**
 * Read and validate the instance manifest, and derive the fixed broker context
 * from it.
 *
 * The manifest is the ONLY source of the acting identity, the workspace root,
 * the policy and the log for every verb below. A flag that named any of them
 * would be a flag an agent's harness could set, and the whole point of the
 * broker is that it cannot.
 */
function installationOf(
  path: string,
  streams: Streams,
  json: boolean,
): BrokerInstallation | null {
  const manifest = readCodexInstance(path);
  if (!manifest.ok) {
    const detail = manifest.errors
      .map((error) => `${error.path === "" ? "/" : error.path}: ${error.message}`)
      .join("; ");
    emitError(streams, json, "manifest-invalid", `${path} is not a valid Codex instance manifest: ${detail}`);
    return null;
  }
  return brokerInstallation(manifest.manifest);
}

/** `--token <class>=<token>`, repeated. Parsed here, never read from a file. */
function tokensOf(values: readonly string[]): Record<string, string> | null {
  const tokens: Record<string, string> = {};
  for (const entry of values) {
    const split = entry.indexOf("=");
    if (split <= 0 || split === entry.length - 1) return null;
    tokens[entry.slice(0, split)] = entry.slice(split + 1);
  }
  return tokens;
}

export async function commandCodex(argv: string[], streams: Streams, cwd: string): Promise<number> {
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

  if (subcommand === "apply") {
    // `--token` is the one repeatable flag in this family, so it is collected
    // here rather than through `parseFlags`, which keeps a last occurrence.
    const tokenValues: string[] = [];
    const remaining: string[] = [];
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] !== "--token") {
        remaining.push(rest[index] as string);
        continue;
      }
      const value = rest[index + 1];
      if (value === undefined) return usage(streams, json, "--token expects <class>=<token>");
      tokenValues.push(value);
      index += 1;
    }
    const parsed = parseFlags(remaining, {
      "--manifest": "string",
      "--proposal": "string",
      "--require-exclusive-custody": "boolean",
      "--json": "boolean",
      "--help": "boolean",
      "-h": "boolean",
    });
    if (!parsed.ok) return usage(streams, json, parsed.message);
    if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
      streams.out(`${CODEX_HELP}\n`);
      return EXIT_OK;
    }
    if (parsed.positionals.length > 0) return usage(streams, json, "apply takes flags only");
    const manifestPath = required(parsed.flags, "--manifest");
    const proposalPath = required(parsed.flags, "--proposal");
    if (manifestPath === null) return usage(streams, json, "apply requires --manifest <path>");
    if (proposalPath === null) return usage(streams, json, "apply requires --proposal <file>");
    const tokens = tokensOf(tokenValues);
    if (tokens === null) return usage(streams, json, "--token expects <class>=<token>");

    const installation = installationOf(resolve(cwd, manifestPath), streams, json);
    if (installation === null) return EXIT_INTEGRITY;

    let proposal: unknown;
    try {
      proposal = JSON.parse(readFileSync(resolve(cwd, proposalPath), "utf8"));
    } catch (cause) {
      emitError(streams, json, "proposal-unreadable", `${proposalPath} could not be read as JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
      return EXIT_IO;
    }

    const options: BrokerOptions = { tokens };
    if (boolFlag(parsed.flags, "--require-exclusive-custody")) options.requireExclusiveCustody = true;
    const result = applyWorkspaceChange("codex_workspace_apply", installation, proposal, options);
    if (!result.ok) {
      if (json) {
        streams.err(`${JSON.stringify({
          error: {
            code: result.code,
            message: result.message,
            ...(result.detail === undefined ? {} : { detail: result.detail }),
            ...(result.pending === undefined ? {} : { pending: result.pending }),
            ...(result.state === undefined ? {} : { state: result.state }),
          },
        })}\n`);
      } else {
        streams.err(`approval: ${result.code}: ${result.message}\n`);
        for (const key of result.pending ?? []) streams.err(`  awaiting a human decision: ${key}\n`);
      }
      return result.code === "log-unavailable" ? EXIT_IO : EXIT_INTEGRITY;
    }
    if (json) streams.out(`${JSON.stringify(result)}\n`);
    else {
      streams.out(`Applied ${String(result.legs.length)} action leg(s) under task ${result.task}.\n`);
      streams.out(`Custody: ${result.custody.kind} (${result.custody.findings.join(", ")}).\n`);
    }
    return EXIT_OK;
  }

  if (subcommand === "recover") {
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
    if (parsed.positionals.length > 0) return usage(streams, json, "recover takes flags only");
    const manifestPath = required(parsed.flags, "--manifest");
    if (manifestPath === null) return usage(streams, json, "recover requires --manifest <path>");
    const installation = installationOf(resolve(cwd, manifestPath), streams, json);
    if (installation === null) return EXIT_INTEGRITY;
    const recovered = recoverWorkspaceCommit(installation.root);
    if (!recovered.ok) {
      emitError(streams, json, recovered.code, recovered.message);
      return EXIT_IO;
    }
    if (recovered.state === "none") {
      if (json) streams.out(`${JSON.stringify({ ok: true, state: "none", message: recovered.message })}\n`);
      else streams.out(`${recovered.message}\n`);
      return EXIT_OK;
    }
    const report = {
      ok: true as const,
      state: recovered.state,
      payload_hash: recovered.journal.payload_hash,
      endpoints: recovered.inspection.endpoints,
    };
    if (json) streams.out(`${JSON.stringify(report)}\n`);
    else {
      streams.out(`Workspace transaction ${recovered.journal.payload_hash} reads back as ${recovered.state}.\n`);
      for (const endpoint of recovered.inspection.endpoints) {
        streams.out(`  ${endpoint.state.padEnd(10)} ${endpoint.path}\n`);
      }
      if (recovered.state === "mixed") {
        streams.out("This is neither the approved before-state nor the approved after-state. Nothing here resolves it: a person reads the journal, decides, and records it with `approval execution reconcile`.\n");
      }
    }
    // A mixed workspace is an integrity fact, and an exit code is the first
    // thing a script reads.
    return recovered.state === "mixed" ? EXIT_INTEGRITY : EXIT_OK;
  }

  // APRV-361. Loaded lazily, like `serve` below and for the same reason: the
  // bridge pulls in the hook's whole decision path, and a `codex prepare` must
  // not pay for a module it never reaches.
  if (subcommand === "bridge") {
    const { runCodexBridge } = await import("./codex-bridge.js");
    return await runCodexBridge(rest, streams, cwd);
  }

  if (subcommand === "serve") {
    const parsed = parseFlags(rest, {
      "--manifest": "string",
      "--require-exclusive-custody": "boolean",
      "--json": "boolean",
      "--help": "boolean",
      "-h": "boolean",
    });
    if (!parsed.ok) return usage(streams, json, parsed.message);
    if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
      streams.out(`${CODEX_HELP}\n`);
      return EXIT_OK;
    }
    if (parsed.positionals.length > 0) return usage(streams, json, "serve takes flags only");
    const manifestPath = required(parsed.flags, "--manifest");
    if (manifestPath === null) return usage(streams, json, "serve requires --manifest <path>");
    const installation = installationOf(resolve(cwd, manifestPath), streams, json);
    if (installation === null) return EXIT_INTEGRITY;

    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const broker: Omit<BrokerOptions, "tokens"> = {};
    if (boolFlag(parsed.flags, "--require-exclusive-custody")) broker.requireExclusiveCustody = true;
    const server = await serveCodexBroker({ installation, broker }, new StdioServerTransport());
    // Never stdout: stdout is the JSON-RPC stream from here on.
    streams.err(
      `approval: strict Codex broker on stdio as ${installation.actor}, workspace ${installation.root}. One tool is published and nothing else; press Ctrl-C to stop.\n`,
    );
    return await new Promise<number>((settle) => {
      let stopping = false;
      const stop = (): void => {
        if (stopping) return;
        stopping = true;
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        void server.close().then(() => settle(EXIT_OK), () => settle(EXIT_IO));
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      server.onclose = stop;
    });
  }

  if (subcommand === "start") {
    // `--` separates the flags from the argv the confined shell runs. Split
    // before `parseFlags`, so a `--json` the CHILD takes is the child's.
    const separator = rest.indexOf("--");
    const flagArgv = separator === -1 ? rest : rest.slice(0, separator);
    const childArgv = separator === -1 ? [] : rest.slice(separator + 1);
    const parsed = parseFlags(flagArgv, {
      "--manifest": "string",
      "--timeout": "string",
      "--json": "boolean",
      "--help": "boolean",
      "-h": "boolean",
    });
    if (!parsed.ok) return usage(streams, json, parsed.message);
    if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
      streams.out(`${CODEX_HELP}\n`);
      return EXIT_OK;
    }
    if (parsed.positionals.length > 0) {
      return usage(streams, json, "start takes flags, then `--` and the command to run confined");
    }
    const manifestPath = required(parsed.flags, "--manifest");
    if (manifestPath === null) return usage(streams, json, "start requires --manifest <path>");
    const installation = installationOf(resolve(cwd, manifestPath), streams, json);
    if (installation === null) return EXIT_INTEGRITY;

    const planned = planConfinedSession(installation);
    if (!planned.ok) {
      emitError(streams, json, planned.code, planned.message);
      return EXIT_INTEGRITY;
    }
    const session = planned.session;
    try {
      // No argv: report the room rather than launching anything. An operator
      // checking that a host can host a confined session should not have to
      // start Codex to find out.
      if (childArgv.length === 0) {
        const report = {
          ok: true as const,
          version: session.version,
          workspace: session.workspace,
          canonical: session.canonical,
          mechanism: session.mechanism,
          write_allow: session.writeAllow,
          read_allow: session.readAllow,
          deny_read: session.denyRead,
          env_stripped: session.envStripped,
          egress: "denied" as const,
        };
        if (json) streams.out(`${JSON.stringify(report)}\n`);
        else {
          streams.out(`Confined session prepared with ${session.mechanism}.\n`);
          streams.out(`  disposable workspace (the only writable path): ${session.workspace}\n`);
          streams.out(`  canonical workspace (readable, never writable): ${session.canonical}\n`);
          streams.out(`  readable at all (nothing else, gate home included): ${session.readAllow.join(", ")}\n`);
          streams.out(`  credential-bearing variables withheld: ${String(session.envStripped)}\n`);
          streams.out("  outbound network: denied, loopback included\n");
          streams.out("Pass `-- <command>` to run something inside it.\n");
        }
        return EXIT_OK;
      }

      const timeoutFlag = stringFlag(parsed.flags, "--timeout");
      const timeoutMs = timeoutFlag === null ? null : parseDuration(timeoutFlag);
      if (timeoutFlag !== null && timeoutMs === null) {
        return usage(streams, json, `--timeout expects a duration like 30s, got ${JSON.stringify(timeoutFlag)}`);
      }
      const command = childArgv[0] as string;
      const ran = runConfined(
        session,
        command,
        childArgv.slice(1),
        timeoutMs === null ? {} : { timeoutMs },
      );
      if (!ran.ok) {
        emitError(streams, json, ran.code, ran.message);
        return EXIT_INTEGRITY;
      }
      if (ran.stdout.length > 0) streams.out(ran.stdout);
      if (ran.stderr.length > 0) streams.err(ran.stderr);
      if (json) {
        streams.out(`${JSON.stringify({
          ok: true, version: session.version, workspace: session.workspace,
          exit_code: ran.exitCode, timed_out: ran.timedOut, env_stripped: session.envStripped,
        })}\n`);
      }
      return ran.exitCode;
    } finally {
      session.dispose();
    }
  }

  return usage(streams, json, `unknown codex subcommand ${JSON.stringify(subcommand)}`);
}
