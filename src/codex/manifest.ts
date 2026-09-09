import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { validate, type ValidationError } from "../core/validate.js";

export const CODEX_INSTANCE_SCHEMA_VERSION = "approval.codex.instance.v1" as const;
export const SUPPORTED_CODEX_VERSION = "0.152.1" as const;
export const SUPPORTED_CODEX_PLATFORM = "darwin" as const;

export interface CodexInstancePaths {
  install_root: string;
  package_root: string;
  workspace: string;
  primary: string;
  policy: string;
  log: string;
  manifest: string;
  codex_executable: string;
  node_executable: string;
  mcp_executable: string;
  broker_executable: string;
  runner_executable: string;
}

export interface CodexInstanceManifest {
  schema_version: typeof CODEX_INSTANCE_SCHEMA_VERSION;
  instance_id: string;
  platform: typeof SUPPORTED_CODEX_PLATFORM;
  codex_version: typeof SUPPORTED_CODEX_VERSION;
  node_version: string;
  package_version: string;
  paths: CodexInstancePaths;
  principals: {
    codex: "_approval_codex";
    broker: "_approval_broker";
    runner: "_approval_runner";
  };
  invocation: { command: string; args: [string, string, string, string] };
  components: {
    broker: "required-not-shipped";
    runner: "required-not-shipped";
  };
}

export type ManifestCheck =
  | { ok: true; manifest: CodexInstanceManifest }
  | { ok: false; errors: ValidationError[] };

function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function normalizedAbsolute(value: string): boolean {
  return isAbsolute(value) && resolve(value) === value && !value.includes("\u0000");
}

function semanticErrors(manifest: CodexInstanceManifest): ValidationError[] {
  const errors: ValidationError[] = [];
  const add = (path: string, message: string): void => {
    errors.push({ path, keyword: "codexInstance", message });
  };
  for (const [name, value] of Object.entries(manifest.paths)) {
    if (!normalizedAbsolute(value)) add(`/paths/${name}`, "must be a normalized absolute path");
  }
  const { paths } = manifest;
  const roots = [
    ["workspace", paths.workspace],
    ["primary", paths.primary],
    ["install_root", paths.install_root],
  ] as const;
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      const a = roots[left] as (typeof roots)[number];
      const b = roots[right] as (typeof roots)[number];
      if (within(a[1], b[1]) || within(b[1], a[1])) {
        add("/paths", `${a[0]} and ${b[0]} must be disjoint and may not contain one another`);
      }
    }
  }
  if (!within(paths.primary, paths.policy) || paths.policy === paths.primary) {
    add("/paths/policy", "must be a file below primary");
  }
  if (!within(paths.primary, paths.log) || paths.log === paths.primary) {
    add("/paths/log", "must be a file below primary");
  }
  for (const name of [
    "package_root",
    "manifest",
    "codex_executable",
    "node_executable",
    "mcp_executable",
    "broker_executable",
    "runner_executable",
  ] as const) {
    const value = paths[name];
    if (!within(paths.install_root, value) || value === paths.install_root) {
      add(`/paths/${name}`, "must be below install_root");
    }
  }
  const nodeMajor = Number.parseInt(manifest.node_version.split(".")[0] ?? "", 10);
  if (!Number.isSafeInteger(nodeMajor) || nodeMajor < 20) add("/node_version", "Node 20 or newer is required");
  const executablePaths = new Set([
    paths.codex_executable,
    paths.node_executable,
    paths.mcp_executable,
    paths.broker_executable,
    paths.runner_executable,
  ]);
  if (executablePaths.size !== 5) add("/paths", "Codex, Node, MCP, broker and runner executables must be distinct");
  const expectedArgs = ["codex", "serve", "--manifest", paths.manifest];
  if (
    manifest.invocation.command !== paths.mcp_executable ||
    manifest.invocation.args.length !== expectedArgs.length ||
    manifest.invocation.args.some((value, index) => value !== expectedArgs[index])
  ) {
    add("/invocation", "must exactly invoke the pinned MCP executable as codex serve --manifest <manifest>");
  }
  return errors;
}

export function checkCodexInstance(value: unknown): ManifestCheck {
  const checked = validate("codex-instance", value);
  if (!checked.ok) return checked;
  const manifest = value as CodexInstanceManifest;
  const errors = semanticErrors(manifest);
  return errors.length === 0 ? { ok: true, manifest } : { ok: false, errors };
}

export function readCodexInstance(path: string): ManifestCheck {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    return {
      ok: false,
      errors: [{
        path: "",
        keyword: "manifestRead",
        message: cause instanceof Error ? cause.message : String(cause),
      }],
    };
  }
  return checkCodexInstance(value);
}
