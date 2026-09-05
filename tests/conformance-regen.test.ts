/**
 * The committed conformance vectors are what the current fixtures generate
 * (APRV-231).
 *
 * `tests/conformance.test.ts` asserts that the vectors on disk agree with the
 * implementation and with the manifest. Neither check looks at the *inputs* the
 * vectors were generated from, so a schema fixture could be added, committed,
 * and exercised by `tests/fixtures.test.ts` while `schema-validation.v1.json`
 * never learned about it — and every suite stayed green. That happened twice
 * before this file existed: the `env_stripped` pair (swept in at 1.3.0) and
 * APRV-214's six gate-window fixtures (swept in at 1.6.0), each committed
 * without the regeneration ritual and each unnoticed until somebody read the
 * two directories side by side.
 *
 * So this file runs the generator and compares. It fails when the committed
 * vector files are not what a regeneration would write, in either direction:
 * a fixture added without a regeneration, and a vector file edited by hand.
 *
 * ## What is compared, and what is not
 *
 * `vectors_version` is NOT compared. The version is a human's judgement about
 * what a second implementation is now required to do — a new vector is a minor
 * bump, a moved expectation a major one, and a number is claimed at merge and
 * not at branch (conformance/README.md). A test cannot make that call, and one
 * that guessed would either force a bump nobody reviewed or block a bump
 * somebody did. What this file does say is when CONTENT moved while the version
 * stood still: that is reported as its own kind of drift, because it is the
 * shape a regeneration without the ritual takes.
 *
 * Everything else is compared: the vectors, the envelope, the byte formatting,
 * and the manifest digest of every file whose bytes should be identical.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { cleanup } from "./conformance-harness.js";

/** The repository root, from `dist/tests/` at runtime. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = join(REPO_ROOT, "scripts", "regen-conformance-vectors.mjs");
const MANIFEST_RELATIVE = "conformance/conformance-manifest.json";

// The gate suites write into scratch homes while their expectations are
// computed; the generator does not own them, the harness does.
after(cleanup);

// ---------------------------------------------------------------------------
// The generator, as a module
// ---------------------------------------------------------------------------

interface GeneratedFile {
  file: string;
  relative: string;
  path: string;
  contents: string;
  suite: string;
  vectors_version: string;
  count: number;
  controls: number;
}

interface Generated {
  files: GeneratedFile[];
  manifest: {
    relative: string;
    path: string;
    contents: string;
    value: { files: Record<string, string> };
  };
}

interface Generator {
  generateConformance: (options?: { fixturesRoot: string }) => Generated;
  DEFAULT_FIXTURES_ROOT: string;
  REGEN_COMMAND: string;
}

/**
 * The regeneration script as a module.
 *
 * Importing it must not write anything: the whole point of the APRV-231 split
 * is that a test can ask what a regeneration would produce without producing
 * it. The assertion below is the one that would notice if that changed.
 */
async function generator(): Promise<Generator> {
  return (await import(pathToFileURL(SCRIPT).href)) as unknown as Generator;
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

interface VectorEntry {
  id: string;
  expect: Record<string, unknown>;
  [key: string]: unknown;
}

interface SuiteBody {
  vectors_version: string;
  count: number;
  vectors: VectorEntry[];
  [key: string]: unknown;
}

type Drift = {
  relative: string;
  kind: "missing" | "unpinned" | "content" | "content-version-unchanged" | "digest";
  message: string;
};

/**
 * A view of the committed files, keyed by repository path.
 *
 * A function rather than a directory, so a test can hand the comparison a
 * deliberately drifted snapshot without touching the working tree.
 */
type Committed = (relative: string) => string | null;

/** The real working tree. */
function onDisk(relative: string): string | null {
  try {
    return readFileSync(join(REPO_ROOT, relative), "utf8");
  } catch {
    return null;
  }
}

function sha256(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function parseSuite(contents: string): SuiteBody | null {
  try {
    return JSON.parse(contents) as SuiteBody;
  } catch {
    return null;
  }
}

/** The body with its human-chosen version removed, for comparison. */
function withoutVersion(body: SuiteBody): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...body };
  delete copy["vectors_version"];
  return JSON.parse(JSON.stringify(copy)) as Record<string, unknown>;
}

/** Which vectors were added, dropped, or moved, so a failure names names. */
function vectorDelta(
  generated: SuiteBody,
  committed: SuiteBody,
): { added: string[]; removed: string[]; changed: string[] } {
  const left = new Map(generated.vectors.map((vector) => [vector.id, JSON.stringify(vector)]));
  const right = new Map(committed.vectors.map((vector) => [vector.id, JSON.stringify(vector)]));
  const added = [...left.keys()].filter((id) => !right.has(id));
  const removed = [...right.keys()].filter((id) => !left.has(id));
  const changed = [...left.entries()]
    .filter(([id, body]) => right.has(id) && right.get(id) !== body)
    .map(([id]) => id);
  return { added, removed, changed };
}

function summarize(delta: { added: string[]; removed: string[]; changed: string[] }): string {
  const parts: string[] = [];
  for (const [label, ids] of [
    ["added", delta.added],
    ["removed", delta.removed],
    ["changed", delta.changed],
  ] as const) {
    if (ids.length > 0) parts.push(`${String(ids.length)} ${label} (${ids.slice(0, 5).join(", ")})`);
  }
  return parts.length > 0 ? parts.join(", ") : "the envelope or the formatting moved";
}

/**
 * Everything about the committed conformance surface that a regeneration would
 * change. An empty array is the only passing answer.
 */
function drift(generated: Generated, committed: Committed, regenCommand: string): Drift[] {
  const problems: Drift[] = [];
  const bytesShouldMatch = new Set<string>();

  for (const file of generated.files) {
    const bytes = committed(file.relative);
    if (bytes === null) {
      problems.push({
        relative: file.relative,
        kind: "missing",
        message: `${file.relative} is not committed, and the ${file.suite} suite generates it. Run \`${regenCommand}\``,
      });
      continue;
    }
    const mine = parseSuite(file.contents);
    const theirs = parseSuite(bytes);
    if (mine === null || theirs === null) {
      problems.push({
        relative: file.relative,
        kind: "content",
        message: `${file.relative} is not parseable JSON. Run \`${regenCommand}\``,
      });
      continue;
    }
    const sameContent =
      JSON.stringify(withoutVersion(mine)) === JSON.stringify(withoutVersion(theirs));
    const sameVersion = mine.vectors_version === theirs.vectors_version;
    if (!sameContent) {
      const delta = vectorDelta(mine, theirs);
      const head = `${file.relative} is not what the current fixtures and inputs generate: ${summarize(delta)}. Run \`${regenCommand}\` and review the diff`;
      problems.push(
        sameVersion
          ? {
              relative: file.relative,
              kind: "content-version-unchanged",
              message: `${head}. The committed vectors_version is still ${theirs.vectors_version}: content moved without the bump the ritual requires (a new vector is a minor bump, a changed expectation a major one — conformance/README.md), so choose the number in the regeneration script as part of the same change`,
            }
          : { relative: file.relative, kind: "content", message: head },
      );
      continue;
    }
    if (!sameVersion) {
      // A version difference on its own is not drift: the number is chosen by a
      // human under the ritual, and `tests/conformance.test.ts` still fails if
      // the file's bytes and its manifest digest disagree.
      continue;
    }
    if (bytes !== file.contents) {
      problems.push({
        relative: file.relative,
        kind: "content",
        message: `${file.relative} holds the right vectors with different bytes (formatting, key order, or the trailing newline). The vectors are generated, never hand-edited: run \`${regenCommand}\``,
      });
      continue;
    }
    bytesShouldMatch.add(file.relative);
  }

  // A vector file nobody generates is a surface with no source: the runner will
  // execute it, and a regeneration will never update it.
  const generatedNames = new Set(generated.files.map((file) => file.file));
  let present: string[] = [];
  try {
    present = readdirSync(join(REPO_ROOT, "conformance", "vectors")).filter((entry) =>
      entry.endsWith(".json"),
    );
  } catch {
    present = [];
  }
  for (const entry of present.sort()) {
    if (generatedNames.has(entry)) continue;
    problems.push({
      relative: `conformance/vectors/${entry}`,
      kind: "unpinned",
      message: `conformance/vectors/${entry} is committed but no suite in the regeneration script generates it. Either it is stale, or its inputs live nowhere: \`${regenCommand}\` cannot maintain it`,
    });
  }

  // The manifest: every file whose bytes should be identical must be pinned at
  // the digest of those bytes. A file skipped above (its version differs) is
  // skipped here too, because its digest legitimately does not match.
  const committedManifestBytes = committed(MANIFEST_RELATIVE);
  if (committedManifestBytes === null) {
    problems.push({
      relative: MANIFEST_RELATIVE,
      kind: "missing",
      message: `${MANIFEST_RELATIVE} is not committed. Run \`${regenCommand}\``,
    });
    return problems;
  }
  let committedManifest: { files?: Record<string, string> };
  try {
    committedManifest = JSON.parse(committedManifestBytes) as { files?: Record<string, string> };
  } catch {
    problems.push({
      relative: MANIFEST_RELATIVE,
      kind: "content",
      message: `${MANIFEST_RELATIVE} is not parseable JSON. Run \`${regenCommand}\``,
    });
    return problems;
  }
  const pinned = committedManifest.files ?? {};
  for (const [relative, digest] of Object.entries(generated.manifest.value.files)) {
    if (relative.startsWith("conformance/vectors/") && !bytesShouldMatch.has(relative)) continue;
    if (pinned[relative] === digest) continue;
    problems.push({
      relative: MANIFEST_RELATIVE,
      kind: "digest",
      message: `${MANIFEST_RELATIVE} pins ${relative} at ${String(pinned[relative] ?? "nothing")}, and a regeneration would pin ${digest}. Run \`${regenCommand}\``,
    });
  }
  for (const relative of Object.keys(pinned)) {
    if (Object.hasOwn(generated.manifest.value.files, relative)) continue;
    problems.push({
      relative: MANIFEST_RELATIVE,
      kind: "digest",
      message: `${MANIFEST_RELATIVE} pins ${relative}, which a regeneration does not write. Run \`${regenCommand}\``,
    });
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The check itself
// ---------------------------------------------------------------------------

test("regenerating the conformance vectors from the current fixtures changes nothing", async () => {
  const { generateConformance, REGEN_COMMAND } = await generator();
  const problems = drift(generateConformance(), onDisk, REGEN_COMMAND);
  assert.deepEqual(
    problems.map((problem) => problem.message),
    [],
    "the committed conformance vectors are not what this repository's fixtures and inputs generate",
  );
});

test("the generator writes nothing: importing it leaves the conformance directory alone", async () => {
  const before = new Map(
    readdirSync(join(REPO_ROOT, "conformance", "vectors"))
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => [entry, sha256(readFileSync(join(REPO_ROOT, "conformance", "vectors", entry), "utf8"))]),
  );
  const { generateConformance, DEFAULT_FIXTURES_ROOT } = await generator();
  generateConformance();
  generateConformance({ fixturesRoot: DEFAULT_FIXTURES_ROOT });
  const after_ = new Map(
    readdirSync(join(REPO_ROOT, "conformance", "vectors"))
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => [entry, sha256(readFileSync(join(REPO_ROOT, "conformance", "vectors", entry), "utf8"))]),
  );
  assert.deepEqual(
    [...after_.entries()],
    [...before.entries()],
    "generating touched the working tree; only the CLI entry may write",
  );
});

// ---------------------------------------------------------------------------
// Both directions of the drift this check exists to catch
// ---------------------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), "approval-md-regen-"));
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

test("a schema fixture added without a regeneration is caught, by name", async () => {
  // The real direction of the two historical misses: a fixture lands, every
  // fixture test covers it, and the frozen vector file never hears about it.
  // Generated from a scratch COPY of schema/fixtures, so the working tree keeps
  // its hands clean while the drift is genuine rather than simulated.
  const { generateConformance, DEFAULT_FIXTURES_ROOT, REGEN_COMMAND } = await generator();
  const fixturesRoot = join(scratch, "fixtures");
  cpSync(DEFAULT_FIXTURES_ROOT, fixturesRoot, { recursive: true });
  const validDir = join(fixturesRoot, "event", "valid");
  const donor = readdirSync(validDir)
    .filter((entry) => entry.endsWith(".json"))
    .sort()[0];
  assert.ok(donor !== undefined, "schema/fixtures/event/valid is empty");
  writeFileSync(
    join(validDir, "aprv-231-added-without-regen.json"),
    readFileSync(join(validDir, donor), "utf8"),
  );

  const problems = drift(generateConformance({ fixturesRoot }), onDisk, REGEN_COMMAND);
  const schema = problems.find((problem) => problem.relative.endsWith("schema-validation.v1.json"));
  assert.ok(schema !== undefined, "a fixture the vectors do not cover was not reported");
  assert.equal(schema.kind, "content-version-unchanged");
  assert.match(schema.message, /event-valid-aprv-231-added-without-regen/u);
  assert.match(schema.message, /node scripts\/regen-conformance-vectors\.mjs/u);
  // One fixture, one report. A file whose content has drifted is not also
  // reported as a manifest digest: the digest follows from the content, and
  // naming both would bury the sentence that says what to do.
  assert.deepEqual(
    problems.map((problem) => problem.relative),
    ["conformance/vectors/schema-validation.v1.json"],
  );
});

test("a vector edited by hand is caught, and names the vector", async () => {
  // The other direction: the fixtures are untouched and somebody "fixed" an
  // expectation in the frozen file. An expectation is computed by running this
  // implementation, so an edited one is a claim about behaviour that nothing
  // produces.
  const { generateConformance, REGEN_COMMAND } = await generator();
  const generated = generateConformance();
  const target = generated.files.find((file) => file.suite === "schema-validation");
  assert.ok(target !== undefined, "the schema-validation suite is missing");
  const body = JSON.parse(target.contents) as SuiteBody;
  const victim = body.vectors.find((vector) => vector.expect["valid"] === false);
  assert.ok(victim !== undefined, "no refusal vector to edit");
  victim.expect["failure_class"] = "hand-edited-by-a-human";
  const edited = `${JSON.stringify(body, null, 2)}\n`;

  const problems = drift(
    generated,
    (relative) => (relative === target.relative ? edited : onDisk(relative)),
    REGEN_COMMAND,
  );
  const schema = problems.find((problem) => problem.relative.endsWith("schema-validation.v1.json"));
  assert.ok(schema !== undefined, "a hand-edited expectation was not reported");
  assert.equal(schema.kind, "content-version-unchanged");
  assert.match(schema.message, new RegExp(victim.id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.match(schema.message, /node scripts\/regen-conformance-vectors\.mjs/u);
});

test("a hand edit under a BUMPED version is still drift, reported without the ritual note", async () => {
  const { generateConformance, REGEN_COMMAND } = await generator();
  const generated = generateConformance();
  const target = generated.files.find((file) => file.suite === "schema-validation");
  assert.ok(target !== undefined);
  const body = JSON.parse(target.contents) as SuiteBody;
  body.vectors_version = "99.0.0";
  body.vectors = body.vectors.slice(0, -1);
  body.count = body.vectors.length;
  const edited = `${JSON.stringify(body, null, 2)}\n`;

  const problems = drift(
    generated,
    (relative) => (relative === target.relative ? edited : onDisk(relative)),
    REGEN_COMMAND,
  );
  const schema = problems.find((problem) => problem.relative.endsWith("schema-validation.v1.json"));
  assert.ok(schema !== undefined, "a dropped vector under a new version was not reported");
  assert.equal(schema.kind, "content");
  assert.doesNotMatch(schema.message, /vectors_version is still/u);
});

test("a version bump on its own is not drift: the number is the human's, not the test's", async () => {
  // The rule this file deliberately does not enforce. A version that moved
  // while the content stood still is the ritual being performed, and a test
  // that failed here would be second-guessing the one judgement the ritual
  // reserves for a person. The bytes are still pinned: the manifest digest of
  // a file whose version was hand-bumped is checked by
  // `tests/conformance.test.ts`, which compares the manifest with what is on
  // disk rather than with what a regeneration would produce.
  const { generateConformance, REGEN_COMMAND } = await generator();
  const generated = generateConformance();
  const target = generated.files.find((file) => file.suite === "policy-resolution");
  assert.ok(target !== undefined);
  const body = JSON.parse(target.contents) as SuiteBody;
  body.vectors_version = "42.0.0";
  const bumped = `${JSON.stringify(body, null, 2)}\n`;

  const problems = drift(
    generated,
    (relative) => (relative === target.relative ? bumped : onDisk(relative)),
    REGEN_COMMAND,
  );
  assert.deepEqual(
    problems.map((problem) => problem.message),
    [],
  );
});
