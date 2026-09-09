import { createHash } from "node:crypto";
import {
  mkdirSync,
  lstatSync,
  readFileSync,
  realpathSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CODEX_INSTANCE_SCHEMA_VERSION,
  SUPPORTED_CODEX_PLATFORM,
  SUPPORTED_CODEX_VERSION,
  checkCodexInstance,
  type CodexInstanceManifest,
} from "./manifest.js";

export const CODEX_BUNDLE_VERSION = 1;
export const CODEX_BUNDLE_FILES = [
  "codex-instance.json",
  "requirements.toml",
  "managed_config.toml",
  "approval-codex-mcp",
  "approval-codex-start",
  "com.approval.codex-broker.plist",
  "com.approval.codex-runner.plist",
  "INSTALL.md",
] as const;

export interface PrepareInput {
  instanceId: string;
  workspace: string;
  primary: string;
  installRoot: string;
  output: string;
  codexExecutable: string;
  nodeExecutable: string;
}

export type PrepareResult =
  | { ok: true; output: string; manifest: CodexInstanceManifest; files: string[] }
  | { ok: false; code: string; message: string };

export interface BundleIndex {
  version: 1;
  files: Record<string, string>;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function packageVersion(): string {
  const packageRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const value = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof value.version !== "string") throw new Error("installed package.json has no version");
  return value.version;
}

export function manifestFor(input: PrepareInput): CodexInstanceManifest {
  const installRoot = resolve(input.installRoot);
  const manifestPath = join(installRoot, "instances", `${input.instanceId}.json`);
  const mcpExecutable = join(installRoot, "bin", "approval-codex-mcp");
  return {
    schema_version: CODEX_INSTANCE_SCHEMA_VERSION,
    instance_id: input.instanceId,
    platform: SUPPORTED_CODEX_PLATFORM,
    codex_version: SUPPORTED_CODEX_VERSION,
    node_version: process.versions.node,
    package_version: packageVersion(),
    paths: {
      install_root: installRoot,
      package_root: join(installRoot, "package"),
      workspace: resolve(input.workspace),
      primary: resolve(input.primary),
      policy: join(resolve(input.primary), "APPROVAL.md"),
      log: join(resolve(input.primary), ".approval", "log", "events.jsonl"),
      manifest: manifestPath,
      codex_executable: resolve(input.codexExecutable),
      node_executable: resolve(input.nodeExecutable),
      mcp_executable: mcpExecutable,
      broker_executable: join(installRoot, "bin", "approval-codex-broker"),
      runner_executable: join(installRoot, "bin", "approval-codex-runner"),
    },
    principals: {
      codex: "_approval_codex",
      broker: "_approval_broker",
      runner: "_approval_runner",
    },
    invocation: {
      command: mcpExecutable,
      args: ["codex", "serve", "--manifest", manifestPath],
    },
    components: {
      broker: "required-not-shipped",
      runner: "required-not-shipped",
    },
  };
}

export function requirementsToml(manifest: CodexInstanceManifest): string {
  const rules = manifest.invocation.args
    .map((value) => `  { match = "exact", value = ${quote(value)} },`)
    .join("\n");
  return `# INERT REVIEW ARTIFACT. Installing this file is a human/MDM action.
allowed_approval_policies = ["never"]
allowed_web_search_modes = ["disabled"]
default_permissions = "approval-codex-readonly"
allow_managed_hooks_only = true
allow_remote_control = false

[allowed_permission_profiles]
approval-codex-readonly = true

[permissions.approval-codex-readonly.filesystem]
":root" = "deny"
":minimal" = "read"

[permissions.approval-codex-readonly.filesystem.":workspace_roots"]
"." = "read"

[permissions.approval-codex-readonly.network]
enabled = false

[features]
apps = false
browser_use = false
browser_use_external = false
browser_use_full_cdp_access = false
computer_use = false
in_app_browser = false
plugins = false
web_search = false

[mcp_servers.approval-codex.identity]
command = { executable = ${quote(manifest.invocation.command)}, args = [
${rules}
] }
`;
}

export function managedConfigToml(manifest: CodexInstanceManifest): string {
  const args = manifest.invocation.args.map(quote).join(", ");
  return `# INERT REVIEW ARTIFACT. This enables only the pinned strict MCP shim.
[mcp_servers.approval-codex]
command = ${quote(manifest.invocation.command)}
args = [${args}]
required = true
`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function launcher(manifest: CodexInstanceManifest, mode: "serve" | "start"): string {
  const cli = join(manifest.paths.package_root, "cli.js");
  const prefix = `exec /usr/bin/env -i PATH=/usr/bin:/bin HOME=/var/empty TMPDIR=/tmp ${shellQuote(manifest.paths.node_executable)} ${shellQuote(cli)}`;
  const command =
    mode === "serve"
      ? `if [ "$#" -ne 4 ] || [ "$1" != 'codex' ] || [ "$2" != 'serve' ] || [ "$3" != '--manifest' ] || [ "$4" != ${shellQuote(manifest.paths.manifest)} ]; then exit 2; fi
${prefix} codex serve --manifest ${shellQuote(manifest.paths.manifest)}`
      : `if [ "$#" -ne 0 ]; then exit 2; fi\n${prefix} codex start --manifest ${shellQuote(manifest.paths.manifest)}`;
  return `#!/bin/sh
# INERT until installed root-owned with the complete APRV-325 broker/runner.
cd ${shellQuote(manifest.paths.package_root)} || exit 1
${command}
`;
}

function plist(manifest: CodexInstanceManifest, component: "broker" | "runner"): string {
  const executable =
    component === "broker" ? manifest.paths.broker_executable : manifest.paths.runner_executable;
  const principal =
    component === "broker" ? manifest.principals.broker : manifest.principals.runner;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.approval.codex-${component}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(executable)}</string>
    <string>--manifest</string>
    <string>${xml(manifest.paths.manifest)}</string>
  </array>
  <key>UserName</key><string>${principal}</string>
  <key>RunAtLoad</key><false/>
</dict></plist>
`;
}

function installGuide(manifest: CodexInstanceManifest): string {
  return `# Constrained Codex instance ${manifest.instance_id}

This bundle is inert. It does not create users, install files, load launchd
services, edit /etc/codex, authenticate Codex, start an executor, or change
approval.md policy.

The broker and runner are deliberately marked required-not-shipped. Do not
install or start this bundle until APRV-325.2 and APRV-325.3 replace those
placeholders and strict doctor reports ready.

Target install root: ${manifest.paths.install_root}
Canonical workspace: ${manifest.paths.workspace}
Primary gate checkout: ${manifest.paths.primary}

Review bundle-sha256.json, then run:
  approval codex setup --check <this-directory>
  approval codex doctor --manifest ${manifest.paths.manifest}

A passing setup check proves only that this review bundle is internally
consistent. It does not prove host custody or enforcement.
`;
}

export function renderBundle(manifest: CodexInstanceManifest): Record<string, string> {
  return {
    "codex-instance.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "requirements.toml": requirementsToml(manifest),
    "managed_config.toml": managedConfigToml(manifest),
    "approval-codex-mcp": launcher(manifest, "serve"),
    "approval-codex-start": launcher(manifest, "start"),
    "com.approval.codex-broker.plist": plist(manifest, "broker"),
    "com.approval.codex-runner.plist": plist(manifest, "runner"),
    "INSTALL.md": installGuide(manifest),
  };
}

export function prepareBundle(input: PrepareInput): PrepareResult {
  let manifest: CodexInstanceManifest;
  try {
    manifest = manifestFor(input);
  } catch (cause) {
    return { ok: false, code: "package-unreadable", message: cause instanceof Error ? cause.message : String(cause) };
  }
  const checked = checkCodexInstance(manifest);
  if (!checked.ok) {
    return {
      ok: false,
      code: "manifest-invalid",
      message: checked.errors.map((error) => `${error.path || "/"}: ${error.message}`).join("; "),
    };
  }
  let output: string;
  try {
    const requestedOutput = resolve(input.output);
    output = join(realpathSync(dirname(requestedOutput)), basename(requestedOutput));
  } catch (cause) {
    return { ok: false, code: "prepare-failed", message: cause instanceof Error ? cause.message : String(cause) };
  }
  const roots = [manifest.paths.workspace, manifest.paths.primary, manifest.paths.install_root];
  if (roots.some((root) => output === root || output.startsWith(`${root}/`) || root.startsWith(`${output}/`))) {
    return { ok: false, code: "output-overlap", message: "preparation output must be disjoint from workspace, primary and install roots" };
  }
  try {
    mkdirSync(output);
    const rendered = renderBundle(manifest);
    for (const [name, content] of Object.entries(rendered)) {
      writeFileSync(join(output, name), content, {
        encoding: "utf8",
        mode: name.startsWith("approval-codex-") ? 0o755 : 0o644,
        flag: "wx",
      });
    }
    const index: BundleIndex = { version: CODEX_BUNDLE_VERSION, files: {} };
    for (const name of CODEX_BUNDLE_FILES) {
      index.files[name] = sha256(readFileSync(join(output, name)));
    }
    writeFileSync(join(output, "bundle-sha256.json"), `${JSON.stringify(index, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o644,
      flag: "wx",
    });
    return { ok: true, output, manifest, files: [...CODEX_BUNDLE_FILES, "bundle-sha256.json"] };
  } catch (cause) {
    return { ok: false, code: "prepare-failed", message: cause instanceof Error ? cause.message : String(cause) };
  }
}

export type BundleCheck =
  | { ok: true; manifest: CodexInstanceManifest; files: string[] }
  | { ok: false; code: string; message: string };

export function checkBundle(directory: string): BundleCheck {
  const root = resolve(directory);
  try {
    if (!lstatSync(root).isDirectory() || realpathSync(root) !== root) {
      return { ok: false, code: "bundle-root-unsafe", message: "bundle root must be a canonical directory, not a symlink" };
    }
    if (!lstatSync(join(root, "bundle-sha256.json")).isFile()) {
      return { ok: false, code: "bundle-index-unreadable", message: "bundle-sha256.json must be a regular file" };
    }
  } catch (cause) {
    return { ok: false, code: "bundle-index-unreadable", message: cause instanceof Error ? cause.message : String(cause) };
  }
  let index: BundleIndex;
  try {
    index = JSON.parse(readFileSync(join(root, "bundle-sha256.json"), "utf8")) as BundleIndex;
  } catch (cause) {
    return { ok: false, code: "bundle-index-unreadable", message: cause instanceof Error ? cause.message : String(cause) };
  }
  if (
    index.version !== CODEX_BUNDLE_VERSION ||
    typeof index.files !== "object" ||
    index.files === null ||
    Array.isArray(index.files)
  ) {
    return { ok: false, code: "bundle-index-invalid", message: "bundle-sha256.json has an unsupported shape or version" };
  }
  const expected = [...CODEX_BUNDLE_FILES].sort();
  const actual = Object.keys(index.files).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    return { ok: false, code: "bundle-file-set", message: "bundle index must name the exact required file set" };
  }
  try {
    const disk = readdirSync(root).sort();
    const allowed = [...expected, "bundle-sha256.json"].sort();
    if (JSON.stringify(disk) !== JSON.stringify(allowed)) {
      return { ok: false, code: "bundle-file-set", message: "bundle directory must contain only the indexed files and bundle-sha256.json" };
    }
    for (const name of expected) {
      if (!lstatSync(join(root, name)).isFile()) {
        return { ok: false, code: "bundle-file-type", message: `${name} must be a regular file, not a symlink or directory` };
      }
      if (index.files[name] !== sha256(readFileSync(join(root, name)))) {
        return { ok: false, code: "bundle-hash-mismatch", message: `${name} does not match bundle-sha256.json` };
      }
    }
  } catch (cause) {
    return { ok: false, code: "bundle-unreadable", message: cause instanceof Error ? cause.message : String(cause) };
  }
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(readFileSync(join(root, "codex-instance.json"), "utf8"));
  } catch (cause) {
    return {
      ok: false,
      code: "manifest-invalid",
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
  const checked = checkCodexInstance(manifestValue);
  if (!checked.ok) {
    return { ok: false, code: "manifest-invalid", message: checked.errors.map((error) => error.message).join("; ") };
  }
  const expectedRendered = renderBundle(checked.manifest);
  for (const [name, content] of Object.entries(expectedRendered)) {
    if (readFileSync(join(root, name), "utf8") !== content) {
      return { ok: false, code: "bundle-template-drift", message: `${name} does not match the manifest-derived template` };
    }
  }
  return { ok: true, manifest: checked.manifest, files: [...expected, "bundle-sha256.json"] };
}
