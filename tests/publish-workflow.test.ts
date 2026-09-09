/**
 * Trusted Publishing workflow boundary (APRV-307).
 *
 * The tag workflow is inert. npm authority exists only in a protected-main
 * `workflow_run` job, after an unprivileged job has bound and tested the exact
 * release bytes. These tests parse the checked-in YAML with the hardened parser
 * and execute the input, ref, manifest, and artifact checks against local
 * fixtures. They never contact npm, request OIDC, or publish anything.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { parseHardenedYaml } from "../src/core/policy-load.js";

type Mapping = Record<string, unknown>;

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WORKFLOW_ROOT = join(REPO_ROOT, ".github", "workflows");
const RELAY_TEXT = readFileSync(join(WORKFLOW_ROOT, "release-candidate.yml"), "utf8");
const PUBLISH_TEXT = readFileSync(join(WORKFLOW_ROOT, "publish.yml"), "utf8");
const scratchDirs: string[] = [];

after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function mapping(value: unknown, message: string): Mapping {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value), message);
  return value as Mapping;
}

function parseWorkflow(text: string, path: string): Mapping {
  const parsed = parseHardenedYaml(text, { subject: "workflow YAML", tagContext: path });
  assert.ok(parsed.ok, `${path} must parse under the hardened YAML 1.2 settings`);
  return mapping(parsed.value, `${path} must be a mapping`);
}

const relay = parseWorkflow(RELAY_TEXT, ".github/workflows/release-candidate.yml");
const publish = parseWorkflow(PUBLISH_TEXT, ".github/workflows/publish.yml");

function job(workflow: Mapping, name: string): Mapping {
  return mapping(mapping(workflow["jobs"], "workflow must declare jobs")[name], `${name} job missing`);
}

function steps(workflow: Mapping, name: string): Mapping[] {
  const value = job(workflow, name)["steps"];
  assert.ok(Array.isArray(value), `${name} must declare steps`);
  return value.map((entry) => mapping(entry, `${name} step must be a mapping`));
}

function namedStep(workflow: Mapping, jobName: string, stepName: string): Mapping {
  const matches = steps(workflow, jobName).filter((step) => step["name"] === stepName);
  assert.equal(matches.length, 1, `${jobName} must declare exactly one ${stepName} step`);
  return matches[0] as Mapping;
}

function runOf(step: Mapping): string {
  const run = step["run"];
  assert.equal(typeof run, "string", "step must have a run string");
  return run as string;
}

function usesOf(workflow: Mapping): string[] {
  return Object.keys(mapping(workflow["jobs"], "workflow must declare jobs")).flatMap((name) =>
    steps(workflow, name)
      .map((step) => step["uses"])
      .filter((value): value is string => typeof value === "string"),
  );
}

function scalars(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const entry of value) scalars(entry, out);
  else if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      out.push(key);
      scalars(entry, out);
    }
  }
  return out;
}

function nodePrograms(run: string): string[] {
  return [...run.matchAll(/node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/gu)].map(
    (match) => match[1] as string,
  );
}

function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env["APPROVAL_HUMAN"];
  delete env["NODE_TEST_CONTEXT"];
  return env;
}

function runShell(script: string, cwd: string, env: NodeJS.ProcessEnv) {
  return spawnSync("bash", ["-c", script], { cwd, env: cleanEnv(env), encoding: "utf8" });
}

function runNode(program: string, cwd: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ["--input-type=module"], {
    cwd,
    env: cleanEnv(env),
    input: program,
    encoding: "utf8",
  });
}

test("the tag relay is an inert single-purpose trigger", () => {
  assert.deepEqual(relay["on"], { push: { tags: ["v*"] } });
  assert.deepEqual(relay["permissions"], {});
  assert.deepEqual(Object.keys(mapping(relay["jobs"], "relay jobs")), ["relay"]);
  assert.deepEqual(steps(relay, "relay"), [{ name: "Complete inert relay", run: ":" }]);
  assert.deepEqual(usesOf(relay), []);
  const text = RELAY_TEXT.toLowerCase();
  for (const forbidden of ["checkout", "artifact", "id-token", "secrets.", "workflow_dispatch"])
    assert.ok(!text.includes(forbidden), `relay must not contain ${forbidden}`);
});

test("only the protected publisher job holds OIDC and it receives one fixed artifact", () => {
  assert.deepEqual(publish["on"], {
    workflow_run: { workflows: ["release candidate"], types: ["completed"] },
  });
  assert.deepEqual(publish["permissions"], {});
  assert.deepEqual(publish["concurrency"], {
    group: "npm-publish",
    "cancel-in-progress": false,
  });
  assert.deepEqual(job(publish, "verify")["permissions"], { contents: "read" });
  assert.deepEqual(job(publish, "publish")["permissions"], { "id-token": "write" });
  assert.equal(job(publish, "publish")["environment"], "npm");
  assert.equal(job(publish, "publish")["needs"], "verify");

  assert.deepEqual(usesOf(publish), [
    "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10",
    "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
    "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
    "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
  ]);

  const upload = steps(publish, "verify").find((step) =>
    String(step["uses"] ?? "").startsWith("actions/upload-artifact@"),
  );
  assert.ok(upload !== undefined);
  assert.deepEqual(mapping(upload["with"], "upload inputs"), {
    name: "npm-package",
    path: "${{ runner.temp }}/npm-package/release.tgz",
    "if-no-files-found": "error",
    "retention-days": 1,
    "compression-level": 0,
  });

  const publishSteps = steps(publish, "publish");
  assert.ok(!publishSteps.some((step) => String(step["uses"] ?? "").includes("checkout")));
  const publishRuns = publishSteps.map((step) => step["run"]).filter((run): run is string => typeof run === "string");
  assert.equal(publishRuns.length, 1);
  assert.match(publishRuns[0] as string, /test "\$actual_sha256" = "\$EXPECTED_SHA256"/u);
  assert.match(
    publishRuns[0] as string,
    /npm publish \.\/release\/release\.tgz --access public --ignore-scripts/u,
  );
  assert.doesNotMatch(publishRuns[0] as string, /npm (?:ci|test|pack)|git |scripts\//u);

  for (const text of scalars(publish).concat(PUBLISH_TEXT)) {
    assert.doesNotMatch(
      text,
      /secrets\.|NPM_TOKEN|NODE_AUTH_TOKEN|workflow_dispatch|workflow_call|pull_request_target|self-hosted|provenance\s*[:=]\s*false/iu,
    );
  }
});

test("untrusted workflow-run metadata is rejected before checkout", () => {
  const script = runOf(namedStep(publish, "verify", "Verify workflow-run metadata"));
  const base: NodeJS.ProcessEnv = {
    DOWNSTREAM_EVENT: "workflow_run",
    DOWNSTREAM_REPOSITORY: "approval-md/approval.md",
    RELEASE_CONCLUSION: "success",
    RELEASE_EVENT: "push",
    RELEASE_HEAD_REPOSITORY: "approval-md/approval.md",
    RELEASE_RUN_ATTEMPT: "1",
    RELEASE_SHA: "1".repeat(40),
    RELEASE_TAG: "v1.2.3",
    RELEASE_WORKFLOW_NAME: "release candidate",
    RELEASE_WORKFLOW_PATH: ".github/workflows/release-candidate.yml",
  };
  assert.equal(runShell(script, REPO_ROOT, base).status, 0);
  for (const [name, bad] of [
    ["DOWNSTREAM_EVENT", "push"],
    ["DOWNSTREAM_REPOSITORY", "fork/approval.md"],
    ["RELEASE_CONCLUSION", "failure"],
    ["RELEASE_EVENT", "workflow_dispatch"],
    ["RELEASE_HEAD_REPOSITORY", "fork/approval.md"],
    ["RELEASE_RUN_ATTEMPT", "2"],
    ["RELEASE_WORKFLOW_NAME", "other"],
    ["RELEASE_WORKFLOW_PATH", ".github/workflows/other.yml"],
    ["RELEASE_TAG", "v1.2.3-rc.1"],
    ["RELEASE_TAG", "v01.2.3"],
    ["RELEASE_SHA", "not-a-sha"],
  ] as const) {
    assert.notEqual(runShell(script, REPO_ROOT, { ...base, [name]: bad }).status, 0, `${name} accepted ${bad}`);
  }
});

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

test("the candidate tag, event, checkout, and current main must be the same commit", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "approval-publish-ref-")));
  scratchDirs.push(root);
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const checkout = join(root, "checkout");
  mkdirSync(origin);
  mkdirSync(seed);
  git(origin, ["init", "--bare", "-q"]);
  git(seed, ["init", "-q"]);
  git(seed, ["config", "user.name", "release fixture"]);
  git(seed, ["config", "user.email", "release@example.invalid"]);
  writeFileSync(join(seed, "package.json"), '{"name":"approval-md","version":"1.2.3"}\n');
  git(seed, ["add", "package.json"]);
  git(seed, ["commit", "-qm", "main release"]);
  git(seed, ["branch", "-M", "main"]);
  const mainSha = git(seed, ["rev-parse", "HEAD"]);
  git(seed, ["remote", "add", "origin", origin]);
  git(seed, ["push", "-q", "origin", "main"]);
  git(seed, ["tag", "-am", "release", "v1.2.3"]);
  git(seed, ["push", "-q", "origin", "refs/tags/v1.2.3"]);
  git(seed, ["checkout", "-qb", "side"]);
  writeFileSync(join(seed, "side.txt"), "not main\n");
  git(seed, ["add", "side.txt"]);
  git(seed, ["commit", "-qm", "side"]);
  const sideSha = git(seed, ["rev-parse", "HEAD"]);
  git(seed, ["tag", "-am", "side release", "v1.2.4"]);
  git(seed, ["push", "-q", "origin", "refs/tags/v1.2.4"]);
  git(seed, ["checkout", "-q", "main"]);
  git(root, ["clone", "-q", "--no-tags", "--branch", "main", origin, checkout]);

  const script = runOf(namedStep(publish, "verify", "Bind tag, event, checkout, and current main"));
  const base: NodeJS.ProcessEnv = {
    DOWNSTREAM_REF: "refs/heads/main",
    DOWNSTREAM_SHA: mainSha,
    RELEASE_SHA: mainSha,
    RELEASE_TAG: "v1.2.3",
  };
  assert.equal(runShell(script, checkout, base).status, 0);
  assert.notEqual(runShell(script, checkout, { ...base, RELEASE_SHA: "0".repeat(40) }).status, 0);
  assert.notEqual(
    runShell(script, checkout, { ...base, RELEASE_TAG: "v1.2.4", RELEASE_SHA: sideSha }).status,
    0,
  );

  writeFileSync(join(seed, "later.txt"), "main moved\n");
  git(seed, ["add", "later.txt"]);
  git(seed, ["commit", "-qm", "advance main"]);
  git(seed, ["push", "-q", "origin", "main"]);
  assert.notEqual(runShell(script, checkout, base).status, 0, "stale downstream SHA accepted advanced main");
});

test("post-pack validation binds npm metadata and the tarball manifest", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "approval-publish-pack-")));
  scratchDirs.push(root);
  const programs = nodePrograms(runOf(namedStep(publish, "verify", "Pack and verify release bytes")));
  assert.equal(programs.length, 2);
  const packJson = join(root, "pack.json");
  const packedManifest = join(root, "package.json");
  const baseEnv = { RELEASE_TAG: "v1.2.3" };

  writeFileSync(packJson, '[{"name":"approval-md","version":"1.2.3","filename":"approval-md-1.2.3.tgz"}]\n');
  assert.equal(runNode(programs[0] as string, root, { ...baseEnv, PACK_JSON: packJson }).status, 0);
  writeFileSync(packJson, '[{"name":"approval-md","version":"1.2.3","filename":"other.tgz"}]\n');
  assert.notEqual(runNode(programs[0] as string, root, { ...baseEnv, PACK_JSON: packJson }).status, 0);

  const good = { name: "approval-md", version: "1.2.3", repository: "github:approval-md/approval.md" };
  writeFileSync(packedManifest, `${JSON.stringify(good)}\n`);
  assert.equal(
    runNode(programs[1] as string, root, { ...baseEnv, PACKED_MANIFEST: packedManifest }).status,
    0,
  );
  writeFileSync(packedManifest, `${JSON.stringify({ ...good, repository: "github:fork/repo" })}\n`);
  assert.notEqual(
    runNode(programs[1] as string, root, { ...baseEnv, PACKED_MANIFEST: packedManifest }).status,
    0,
  );

  const run = runOf(namedStep(publish, "verify", "Pack and verify release bytes"));
  assert.match(run, /tar -xOf "\$out\/release\.tgz" package\/package\.json/u);
  assert.match(run, /sha256sum release\.tgz > release\.tgz\.sha256/u);
  assert.equal(job(publish, "verify")["outputs"] instanceof Object, true);
  assert.match(PUBLISH_TEXT, /release_sha256: \$\{\{ steps\.release_hash\.outputs\.sha256 \}\}/u);
});

test("a changed artifact is refused before the publish command", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "approval-publish-artifact-")));
  scratchDirs.push(root);
  const release = join(root, "release");
  const bin = join(root, "bin");
  mkdirSync(release);
  mkdirSync(bin);
  const tarball = Buffer.from("fixed reviewed tarball\n");
  writeFileSync(join(release, "release.tgz"), tarball);
  writeFileSync(
    join(bin, "sha256sum"),
    "#!/usr/bin/env node\nconst fs=require('node:fs');const c=require('node:crypto');const p=process.argv[2];console.log(c.createHash('sha256').update(fs.readFileSync(p)).digest('hex')+'  '+p);\n",
  );
  writeFileSync(join(bin, "npm"), '#!/bin/sh\nprintf "%s\\n" "$*" > "$CAPTURE"\n');
  chmodSync(join(bin, "sha256sum"), 0o755);
  chmodSync(join(bin, "npm"), 0o755);

  const capture = join(root, "npm.args");
  const script = runOf(namedStep(publish, "publish", "Verify and publish fixed artifact"));
  const digest = createHash("sha256").update(tarball).digest("hex");
  const env = { PATH: `${bin}:${process.env["PATH"] ?? ""}`, CAPTURE: capture };
  assert.equal(runShell(script, root, { ...env, EXPECTED_SHA256: digest }).status, 0);
  assert.equal(readFileSync(capture, "utf8"), "publish ./release/release.tgz --access public --ignore-scripts\n");

  rmSync(capture);
  assert.notEqual(runShell(script, root, { ...env, EXPECTED_SHA256: "0".repeat(64) }).status, 0);
  assert.equal(existsSync(capture), false, "npm ran after the artifact hash mismatch");
});
