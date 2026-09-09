import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import type { CodexInstanceManifest } from "./manifest.js";

export interface DoctorFinding {
  code: string;
  path?: string;
  message: string;
}

export interface DoctorReport {
  ok: false;
  ready: false;
  findings: DoctorFinding[];
}

export interface TrustOptions {
  platform?: NodeJS.Platform;
  resolveUid?: (name: string) => number | null;
  groupsFor?: (name: string) => number[] | null;
}

function ancestors(path: string): string[] {
  const values: string[] = [];
  let current = resolve(path);
  for (;;) {
    values.unshift(current);
    const parent = dirname(current);
    if (parent === current) return values;
    current = parent;
  }
}

function systemUid(name: string): number | null {
  const result = spawnSync("/usr/bin/id", ["-u", name], {
    encoding: "utf8", timeout: 2_000, maxBuffer: 16_384, env: { PATH: "/usr/bin:/bin" },
  });
  if (result.status !== 0) return null;
  const value = Number(result.stdout.trim());
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function systemGroups(name: string): number[] | null {
  const result = spawnSync("/usr/bin/id", ["-G", name], {
    encoding: "utf8", timeout: 2_000, maxBuffer: 16_384, env: { PATH: "/usr/bin:/bin" },
  });
  if (result.status !== 0) return null;
  const groups = result.stdout.trim().split(/\s+/u).map(Number);
  return groups.length > 0 && groups.every((value) => Number.isSafeInteger(value) && value >= 0)
    ? groups
    : null;
}

export function parseCodexVersionOutput(stdout: string, stderr: string): string | null {
  if (stderr.length !== 0) return null;
  return /^codex-cli (\d+\.\d+\.\d+)$/u.exec(stdout.trim())?.[1] ?? null;
}

export function parseNodeVersionOutput(stdout: string, stderr: string): string | null {
  if (stderr.length !== 0) return null;
  return /^v(\d+\.\d+\.\d+)$/u.exec(stdout.trim())?.[1] ?? null;
}

function add(findings: DoctorFinding[], code: string, message: string, path?: string): void {
  findings.push(path === undefined ? { code, message } : { code, path, message });
}

function inspectNoSymlinks(path: string, findings: DoctorFinding[]): boolean {
  let safe = true;
  for (const candidate of ancestors(path)) {
    try {
      if (lstatSync(candidate).isSymbolicLink()) {
        add(findings, "path-symlink", "path or ancestor is a symbolic link", candidate);
        safe = false;
      }
    } catch {
      add(findings, "path-missing", "path or ancestor does not exist", candidate);
      return false;
    }
  }
  try {
    if (realpathSync(path) !== resolve(path)) {
      add(findings, "path-canonical", "real path differs from the manifest path", path);
      safe = false;
    }
  } catch {
    return false;
  }
  return safe;
}

function inspectRootCustody(path: string, findings: DoctorFinding[]): boolean {
  let safe = true;
  for (const candidate of ancestors(path)) {
    let stat;
    try {
      stat = statSync(candidate);
    } catch {
      return false;
    }
    if (stat.uid !== 0) {
      add(findings, "owner-not-root", `trusted path ancestor is owned by uid ${String(stat.uid)}, expected 0`, candidate);
      safe = false;
    }
    if ((stat.mode & 0o022) !== 0) {
      add(findings, "trusted-path-writable", "trusted path ancestor is group- or world-writable", candidate);
      safe = false;
    }
  }
  return safe;
}

function inspectExecutable(path: string, findings: DoctorFinding[]): boolean {
  try {
    const stat = statSync(path);
    let safe = true;
    if (!stat.isFile()) {
      add(findings, "component-not-file", "component is not a regular file", path);
      safe = false;
    }
    if ((stat.mode & 0o111) === 0) {
      add(findings, "component-not-executable", "component has no execute bit", path);
      safe = false;
    }
    return safe;
  } catch {
    add(findings, "component-missing", "required enforcement component is missing", path);
    return false;
  }
}

export function diagnoseCodexInstance(
  manifest: CodexInstanceManifest,
  options: TrustOptions = {},
): DoctorReport {
  const findings: DoctorFinding[] = [];
  const platform = options.platform ?? process.platform;
  if (platform !== manifest.platform) {
    add(findings, "unsupported-platform", `manifest requires ${manifest.platform}; this host is ${platform}`);
  }

  const resolveUid = options.resolveUid ?? systemUid;
  const groupsFor = options.groupsFor ?? systemGroups;
  const identities = Object.values(manifest.principals).map((name) => ({
    name, uid: resolveUid(name), groups: groupsFor(name),
  }));
  for (const identity of identities) {
    if (identity.uid === null || identity.groups === null) {
      add(findings, "principal-missing", `principal ${identity.name} does not exist or cannot be resolved`);
    } else if (identity.uid === 0) {
      add(findings, "principal-root", `service principal ${identity.name} must not be uid 0`);
    }
  }
  const knownUids = identities.flatMap((identity) => identity.uid === null ? [] : [identity.uid]);
  if (new Set(knownUids).size !== knownUids.length) {
    add(findings, "principal-overlap", "Codex, broker and runner principals must have distinct non-root uids");
  }

  for (const path of Object.values(manifest.paths)) {
    inspectNoSymlinks(path, findings);
  }
  const trusted = [
    manifest.paths.install_root,
    manifest.paths.package_root,
    manifest.paths.manifest,
    manifest.paths.codex_executable,
    manifest.paths.node_executable,
    manifest.paths.mcp_executable,
    manifest.paths.broker_executable,
    manifest.paths.runner_executable,
  ];
  for (const path of trusted) inspectRootCustody(path, findings);

  const executables = [
    manifest.paths.codex_executable,
    manifest.paths.node_executable,
    manifest.paths.mcp_executable,
    manifest.paths.broker_executable,
    manifest.paths.runner_executable,
  ];
  for (const path of executables) inspectExecutable(path, findings);

  add(findings, "trusted-path-acl-unproven", "POSIX ownership and mode do not prove that trusted paths have no writable ACL; APRV-325.1 executes no manifest-selected binary");
  add(findings, "codex-version-unchecked", "Codex version was not executed because ACL-aware executable custody is not implemented", manifest.paths.codex_executable);
  add(findings, "node-version-unchecked", "Node version was not executed because ACL-aware executable custody is not implemented", manifest.paths.node_executable);

  const codex = identities.find((entry) => entry.name === manifest.principals.codex);
  if (codex !== undefined && codex.uid !== null && codex.groups !== null) {
    try {
      const stat = statSync(manifest.paths.workspace);
      const ownerWritable = stat.uid === codex.uid && (stat.mode & 0o200) !== 0;
      const groupWritable = codex.groups.includes(stat.gid) && (stat.mode & 0o020) !== 0;
      const worldWritable = (stat.mode & 0o002) !== 0;
      if (ownerWritable || groupWritable || worldWritable) {
        add(findings, "workspace-writable-by-codex", "workspace root is writable by the Codex principal under POSIX ownership and mode", manifest.paths.workspace);
      }
    } catch {
      // Missing paths were already reported.
    }
  }
  add(findings, "workspace-custody-unproven", "root mode inspection does not prove subtree and ACL non-write; APRV-325.3 must perform a principal-executed denial probe", manifest.paths.workspace);

  add(findings, "broker-not-ready", "APRV-325.1 ships preparation only; the policy-bound broker is not implemented", manifest.paths.broker_executable);
  add(findings, "runner-not-ready", "APRV-325.1 ships preparation only; the confined runner is not implemented", manifest.paths.runner_executable);

  return { ok: false, ready: false, findings };
}
