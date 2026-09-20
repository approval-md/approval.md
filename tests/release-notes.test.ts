/**
 * Release notes from the changelog, and the workflow that publishes them
 * (APRV-396).
 *
 * Two halves, one property. `scripts/release-notes.mjs` turns a tag into the
 * body of a GitHub Release by reading `CHANGELOG.md`, so the first half pins it
 * against the real changelog (0.2.0 and 0.3.0, the two sections that exist and
 * are dated) and against fixtures for every way a section can be unusable. The
 * cases that matter are the refusals: `## Unreleased` must never become a
 * release body, and a heading whose date has not been written yet means the
 * notes are still a draft.
 *
 * The second half reads the checked-in bytes of `.github/workflows/publish.yml`
 * under `parseHardenedYaml`, the way `ci-guard.test.ts` reads `ci.yml`. The
 * workflow cannot be run from here, so what can be asserted is its shape: the
 * changelog check sits in the verify job ahead of anything that touches npm, the
 * release job holds `contents: write` and no OIDC, the create carries
 * `--verify-tag`, and the published manifest is bound to the release commit.
 * A release that skipped one of those would still be green without this file.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseHardenedYaml } from "../src/core/policy-load.js";

// The script is plain Node ESM so it runs before a build, in CI and in the
// release workflow alike; its exports are exercised here without adding a
// .d.ts, as `agent-hours.test.ts` and `codex-hook-probe.test.ts` do.
// @ts-expect-error no declaration file for the standalone release-notes script
import { checkReport, extractSection, listSections, normalizeVersion, parseArgs, parseHeading } from "../../scripts/release-notes.mjs";

/** The repository root, from `dist/tests/` at runtime. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = join(REPO_ROOT, "scripts", "release-notes.mjs");
const CHANGELOG_PATH = join(REPO_ROOT, "CHANGELOG.md");
const WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "publish.yml");

const CHANGELOG = readFileSync(CHANGELOG_PATH, "utf8");
const WORKFLOW_TEXT = readFileSync(WORKFLOW_PATH, "utf8");

const scratch = mkdtempSync(join(tmpdir(), "approval-release-notes-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

interface Refusal {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
}

interface Section {
  readonly ok: true;
  readonly version: string;
  readonly date: string;
  readonly heading: string;
  readonly body: string;
}

function section(text: string, version: string): Section {
  const result = extractSection(text, version) as Section | Refusal;
  assert.ok(result.ok, `expected a section for ${version}, got ${JSON.stringify(result)}`);
  return result;
}

function refusal(text: string, version: string): Refusal {
  const result = extractSection(text, version) as Section | Refusal;
  assert.ok(!result.ok, `expected a refusal for ${version}, got a section`);
  return result;
}

/** A changelog fixture written to the scratch directory, and its path. */
function fixture(name: string, text: string): string {
  const path = join(scratch, `${name}.md`);
  writeFileSync(path, text, "utf8");
  return path;
}

function run(args: readonly string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

// ---------------------------------------------------------------------------
// The real changelog
// ---------------------------------------------------------------------------

test("the 0.3.0 section is extracted from the real changelog with its date", () => {
  const found = section(CHANGELOG, "0.3.0");
  assert.equal(found.version, "0.3.0");
  assert.equal(found.date, "2026-09-20");
  assert.equal(found.heading, "## 0.3.0 — 2026-09-20");
  assert.match(found.body, /^Written on 2026-09-20 against /u);
  // The body stops at the next version heading and keeps its own subsections.
  assert.ok(!found.body.includes("## 0.2.0"), "the 0.3.0 body ran into the 0.2.0 section");
  assert.ok(!found.body.includes("## Unreleased"), "the 0.3.0 body reached the Unreleased section");
  assert.ok(found.body.includes("### Gate and guard"), "the 0.3.0 body lost its subsections");
  assert.ok(found.body.length > 2000, `the 0.3.0 body is implausibly short (${found.body.length} bytes)`);
});

test("the 0.2.0 section is extracted, tag spelling included", () => {
  const found = section(CHANGELOG, "0.2.0");
  assert.equal(found.date, "2026-09-12");
  assert.match(found.body, /^Published to npm as `approval-md@0\.2\.0`/u);
  assert.ok(!found.body.includes("## 0.1.0"), "the 0.2.0 body ran into the 0.1.0 section");
  assert.deepEqual(section(CHANGELOG, "v0.2.0"), found, "the vX.Y.Z spelling read a different section");
});

test("a body is trimmed of the blank lines around it, never of its own", () => {
  const found = section(CHANGELOG, "0.2.0");
  assert.ok(!/^\s/u.test(found.body), "the body keeps a leading blank line");
  assert.ok(!/\s$/u.test(found.body), "the body keeps a trailing blank line");
  assert.ok(found.body.includes("\n\n"), "the body lost the blank lines inside it");
});

test("every dated section in the real changelog is listed, newest first", () => {
  const { dated, complaints } = checkReport(CHANGELOG) as {
    dated: ReadonlyArray<{ version: string; date: string }>;
    complaints: readonly string[];
  };
  assert.deepEqual(
    dated.map((entry) => `${entry.version} ${entry.date}`),
    ["0.3.0 2026-09-20", "0.2.0 2026-09-12", "0.1.0 2026-09-08"],
  );
  assert.deepEqual(
    complaints,
    [],
    "CHANGELOG.md carries a version-shaped heading that could not be released. The heading form is `## X.Y.Z — YYYY-MM-DD`, em dash and ISO date; `## Unreleased` is the only headless section.",
  );
});

test("the Unreleased heading is not a version and cannot be released", () => {
  assert.ok(CHANGELOG.includes("## Unreleased"), "the changelog lost its Unreleased section");
  const heading = parseHeading("## Unreleased") as { version: string | null; date: string | null };
  assert.equal(heading.version, null);
  assert.equal(heading.date, null);
  const refused = refusal(CHANGELOG, "Unreleased");
  assert.equal(refused.code, "bad-version");
  // And no version-shaped request can reach it either.
  const listed = listSections(CHANGELOG) as ReadonlyArray<{ text: string }>;
  assert.ok(
    listed.every((entry) => entry.text !== "Unreleased"),
    "the Unreleased heading was listed as a version section",
  );
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test("a version with no section refuses with the heading to add", () => {
  const refused = refusal(CHANGELOG, "0.4.0");
  assert.equal(refused.code, "no-section");
  assert.match(refused.message, /no section for 0\.4\.0/u);
  assert.match(refused.message, /## X\.Y\.Z — YYYY-MM-DD/u);
});

test("an undated heading refuses as a draft, distinctly from a missing one", () => {
  const text = "# Changelog\n\n## 9.9.9\n\n- something, not yet dated\n";
  const refused = refusal(text, "9.9.9");
  assert.equal(refused.code, "undated-heading");
  assert.match(refused.message, /carries no release date/u);
  assert.match(refused.message, /line 3/u);
});

test("a heading that breaks the form in any other way is undated too", () => {
  for (const heading of [
    "## 9.9.9 - 2026-01-01", // a hyphen, not an em dash
    "## 9.9.9 – 2026-01-01", // an en dash
    "## 9.9.9 — 2026-13-01", // not a calendar date
    "## 9.9.9 — 2026-01-01 (yanked)", // a trailing note
    "## 9.9.9 — 20260101", // not ISO
  ]) {
    const refused = refusal(`# Changelog\n\n${heading}\n\n- body\n`, "9.9.9");
    assert.equal(refused.code, "undated-heading", `${heading} was not refused as undated`);
  }
});

test("two sections for one version refuse rather than picking one", () => {
  const text = "## 9.9.9 — 2026-01-01\n\n- first\n\n## 9.9.9 — 2026-02-02\n\n- second\n";
  const refused = refusal(text, "9.9.9");
  assert.equal(refused.code, "duplicate-section");
  assert.match(refused.message, /line 1, line 5/u);
});

test("a well formed heading with nothing under it refuses", () => {
  const text = "## 9.9.9 — 2026-01-01\n\n\n## 9.9.8 — 2025-01-01\n\n- body\n";
  const refused = refusal(text, "9.9.9");
  assert.equal(refused.code, "empty-section");
});

test("only canonical stable versions are releasable", () => {
  for (const input of ["0.3", "1.2.3.4", "01.2.3", "1.2.3-rc.1", "1.2.3+build", "", "v", "latest"]) {
    assert.equal(normalizeVersion(input), null, `${JSON.stringify(input)} was accepted as a version`);
  }
  assert.equal(normalizeVersion("0.3.0"), "0.3.0");
  assert.equal(normalizeVersion("v10.20.30"), "10.20.30");
});

test("a prerelease tag finds no section even when the stable one exists", () => {
  const refused = refusal(CHANGELOG, "v0.3.0-rc.1");
  assert.equal(refused.code, "bad-version");
});

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

test("the CLI prints the section body and exits 0", () => {
  const result = run(["0.3.0"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Written on 2026-09-20 against /u);
  assert.ok(!result.stdout.includes("## 0.2.0"), "the printed body ran into the previous section");
  assert.equal(result.stdout, `${section(CHANGELOG, "0.3.0").body}\n`);
});

test("the CLI exits 1 with the refusal on stderr for a version with no section", () => {
  const result = run(["0.4.0"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^release-notes: no-section: CHANGELOG has no section for 0\.4\.0\./u);
});

test("the CLI exits 1 on an undated section in a named changelog", () => {
  const path = fixture("undated", "# Changelog\n\n## 9.9.9\n\n- undated\n");
  const result = run(["9.9.9", "--changelog", path]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /undated-heading/u);
});

test("--check lists the dated versions and exits 0 on the real changelog", () => {
  const result = run(["--check"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "0.3.0 2026-09-20\n0.2.0 2026-09-12\n0.1.0 2026-09-08\n");
  assert.equal(result.stderr, "");
});

test("--check exits 1 when a version-shaped heading could not be released", () => {
  const path = fixture("check-undated", "## 9.9.9 — 2026-01-01\n\n- ok\n\n## 9.9.8\n\n- draft\n");
  const result = run(["--check", "--changelog", path]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "9.9.9 2026-01-01\n");
  assert.match(result.stderr, /line 5: "## 9\.9\.8" is version-shaped and undated/u);
});

test("--out writes the body and says what it wrote", () => {
  const out = join(scratch, "written", "notes.md");
  const result = run(["v0.2.0", "--out", out]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(readFileSync(out, "utf8"), `${section(CHANGELOG, "0.2.0").body}\n`);
  assert.match(result.stderr, /^release-notes: wrote .*notes\.md, \d+ lines from ## 0\.2\.0 — 2026-09-12\n$/u);
});

test("the CLI exits 2 on a usage error, never 0 and never a body", () => {
  for (const args of [[], ["--check", "0.3.0"], ["0.3.0", "0.2.0"], ["--nope"], ["0.3.0", "--out"], ["--check", "--out", "x"]]) {
    const result = run(args);
    assert.equal(result.status, 2, `${JSON.stringify(args)} did not exit 2`);
    assert.equal(result.stdout, "", `${JSON.stringify(args)} printed a body`);
    assert.match(result.stderr, /^release-notes: /u);
  }
});

test("a missing changelog is a usage error rather than an empty release", () => {
  const result = run(["0.3.0", "--changelog", join(scratch, "absent.md")]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cannot read /u);
});

test("the argument parser reports the first complaint and stops", () => {
  const parsed = parseArgs(["--nope", "--also-nope"]) as { error: string | null };
  assert.equal(parsed.error, "unknown option --nope");
});

// ---------------------------------------------------------------------------
// The workflow that uses it
// ---------------------------------------------------------------------------

/** `publish.yml` as data, parsed under the repository's hardened settings. */
function workflow(): Record<string, unknown> {
  const parsed = parseHardenedYaml(WORKFLOW_TEXT, {
    subject: "workflow YAML",
    tagContext: "a workflow file",
  });
  assert.ok(
    parsed.ok,
    `.github/workflows/publish.yml does not parse under the hardened settings every other YAML surface in this repository gets: ${parsed.ok ? "" : parsed.message}`,
  );
  const value = parsed.value;
  assert.ok(
    typeof value === "object" && value !== null && !Array.isArray(value),
    ".github/workflows/publish.yml is not a YAML mapping",
  );
  return value as Record<string, unknown>;
}

function job(name: string): Record<string, unknown> {
  const jobs = workflow()["jobs"];
  assert.ok(typeof jobs === "object" && jobs !== null, ".github/workflows/publish.yml declares no jobs");
  const entry = (jobs as Record<string, unknown>)[name];
  assert.ok(
    typeof entry === "object" && entry !== null,
    `.github/workflows/publish.yml no longer declares the \`${name}\` job`,
  );
  return entry as Record<string, unknown>;
}

function steps(name: string): ReadonlyArray<Record<string, unknown>> {
  const list = job(name)["steps"];
  assert.ok(Array.isArray(list), `the \`${name}\` job has no steps`);
  return list as ReadonlyArray<Record<string, unknown>>;
}

/** The index of the first step whose `run` mentions `needle`, or -1. */
function stepRunning(name: string, needle: string): number {
  return steps(name).findIndex((step) => typeof step["run"] === "string" && (step["run"] as string).includes(needle));
}

/** Every scalar reachable from `value`, keys included. */
function scalars(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) scalars(item, out);
  else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      scalars(item, out);
    }
  }
  return out;
}

test("the publish workflow reads no secret, in its data or its bytes", () => {
  const offenders = scalars(workflow()).filter((text) => text.includes("secrets."));
  assert.deepEqual(
    offenders,
    [],
    `.github/workflows/publish.yml now reads a secret (${offenders.join(", ")}). Trusted Publishing exists so this workflow holds no npm credential, and the Release is created with the run's own \`github.token\`.`,
  );
  assert.ok(!WORKFLOW_TEXT.includes("secrets."), ".github/workflows/publish.yml mentions `secrets.` in its raw text");
});

test("the changelog check runs in the verify job, ahead of everything that could publish", () => {
  const check = stepRunning("verify", "scripts/release-notes.mjs");
  assert.ok(
    check >= 0,
    "the verify job no longer runs scripts/release-notes.mjs. A tag with no dated changelog section would then reach npm and only fail afterwards, when the version is spent.",
  );
  const pack = stepRunning("verify", "npm pack");
  assert.ok(pack >= 0, "the verify job no longer packs the release");
  assert.ok(
    check < pack,
    "the changelog check now runs after the pack step. It has to come first: its whole point is that a tag with no notes never reaches the registry.",
  );
  const publishNeeds = job("publish")["needs"];
  assert.ok(
    publishNeeds === "verify" || (Array.isArray(publishNeeds) && publishNeeds.includes("verify")),
    "the publish job no longer needs the verify job, so the changelog check no longer gates npm",
  );
});

test("the release commit is bound into the published manifest and checked in the tarball", () => {
  const bind = stepRunning("verify", "npm pkg set");
  assert.ok(bind >= 0, "the verify job no longer sets gitHead, so the registry metadata carries no commit");
  const pack = stepRunning("verify", "npm pack");
  assert.ok(bind < pack, "gitHead is set after the pack, where the packed bytes can no longer carry it");
  const packStep = steps("verify")[pack] ?? {};
  const packText = String(packStep["run"]);
  assert.ok(
    packText.includes("gitHead"),
    "the pack step no longer checks the tarball's gitHead. Setting a field npm might drop is worth nothing without the assertion that it survived.",
  );
  assert.ok(
    scalars(packStep["env"]).some((text) => text.includes("workflow_run.head_sha")),
    "the pack step no longer reads the release SHA, so its gitHead check compares against nothing",
  );
});

test("the release job creates the Release after the publish, with contents write and no OIDC", () => {
  const release = job("release");
  const needs = release["needs"];
  assert.ok(Array.isArray(needs), "the release job declares no needs");
  for (const required of ["verify", "publish"]) {
    assert.ok(
      (needs as readonly unknown[]).includes(required),
      `the release job no longer needs \`${required}\`. A Release created before the publish succeeds would announce bytes the registry never got.`,
    );
  }
  assert.deepEqual(
    release["permissions"],
    { contents: "write" },
    "the release job's permissions changed. `contents: write` is what a Release needs and all it needs; OIDC belongs to the publish job alone.",
  );
  assert.deepEqual(
    workflow()["permissions"],
    {},
    "the workflow-level permissions are no longer empty, so a job that declares none would inherit something",
  );
  assert.deepEqual(
    job("publish")["permissions"],
    { "id-token": "write" },
    "the publish job's permissions changed; Trusted Publishing needs `id-token: write` and nothing else",
  );
});

test("the Release is verified against the tag, idempotent, and carries the tarball", () => {
  const text = steps("release")
    .map((step) => (typeof step["run"] === "string" ? (step["run"] as string) : ""))
    .join("\n");
  assert.ok(text.includes("gh release create"), "the release job no longer creates a Release");
  assert.ok(
    text.includes("--verify-tag"),
    "the Release is created without --verify-tag, so a Release could be created for a tag that does not exist on the remote",
  );
  assert.ok(
    text.includes("gh release edit") && text.includes("--clobber"),
    "the release job no longer updates an existing Release. A rerun must update the one Release rather than fail or duplicate it.",
  );
  assert.ok(
    text.includes("scripts/release-notes.mjs"),
    "the release job no longer reads the changelog section, so the Release body is not the notes",
  );
  assert.ok(
    text.includes(".sha256"),
    "the release job no longer attaches the tarball checksum beside the tarball",
  );
  assert.ok(
    text.includes("EXPECTED_SHA256"),
    "the release job no longer re-verifies the artifact digest bound by the verify job before attaching it",
  );
});
