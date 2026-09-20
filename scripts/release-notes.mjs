#!/usr/bin/env node
/**
 * Release notes: one version's CHANGELOG section, verbatim (APRV-396).
 *
 * The GitHub Releases page was empty for 0.1.0, 0.2.0 and 0.3.0 because
 * `publish.yml` published to npm and stopped there. The notes existed the whole
 * time, in `CHANGELOG.md` (and inside the npm tarball), so nothing here writes
 * release prose: it reads the section a human already wrote and hands it to
 * `gh release create` as the body. One source, two destinations.
 *
 * ## The heading contract
 *
 * A released version's heading is exactly
 *
 *     ## X.Y.Z — YYYY-MM-DD
 *
 * with a canonical stable version (no leading zeros, no prerelease suffix), an
 * em dash, and an ISO calendar date. That shape is the whole interface, and it
 * is checked rather than guessed at, for two reasons:
 *
 *   - `## Unreleased` must never be published as a release body. It carries no
 *     version, so it cannot match a tag, which is the property that matters.
 *   - A heading whose date is missing means the section is still being written.
 *     Publishing a draft as the Release body is worse than publishing nothing,
 *     so an undated heading refuses with its own code and its own message,
 *     distinct from the version having no section at all.
 *
 * Every refusal here is a refusal to create a Release. That is deliberate: the
 * workflow runs this before `npm publish` as well as after it, so a tag whose
 * section is missing or undated fails the run while the registry is still
 * untouched.
 *
 * Usage:
 *   node scripts/release-notes.mjs 0.3.0                   body to stdout
 *   node scripts/release-notes.mjs v0.3.0                  the tag spelling too
 *   node scripts/release-notes.mjs 0.3.0 --out notes.md    body to a file
 *   node scripts/release-notes.mjs --check                 list dated sections
 *   node scripts/release-notes.mjs 0.3.0 --changelog <path>
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The repository root, from `scripts/` at runtime, with its trailing slash. */
const SCRIPT_ROOT = fileURLToPath(new URL("../", import.meta.url));

/** The changelog this reads when none is named. */
export const DEFAULT_CHANGELOG = `${SCRIPT_ROOT}CHANGELOG.md`;

/** A canonical stable version. Prereleases and build metadata are not releases here. */
const CANONICAL_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;

/** The dated form of a version heading's text: version, em dash, ISO date. */
const DATED_HEADING = /^(\S+)[ \t]+—[ \t]+([0-9]{4}-[0-9]{2}-[0-9]{2})$/u;

/** An `h1` or `h2` line. A section body ends at one; `###` subsections do not end it. */
const SECTION_BOUNDARY = /^##? /u;

/** The heading shape every message quotes, so the fix travels with the refusal. */
export const HEADING_FORM = "## X.Y.Z — YYYY-MM-DD";

/**
 * `input` as a canonical version, accepting the `vX.Y.Z` tag spelling, or null.
 *
 * The workflow holds a tag and the changelog holds a version; converting here
 * rather than in the shell keeps one spelling rule in one place.
 */
export function normalizeVersion(input) {
  if (typeof input !== "string") return null;
  const bare = input.startsWith("v") ? input.slice(1) : input;
  return CANONICAL_VERSION.test(bare) ? bare : null;
}

/** True when `value` is a real calendar date in ISO form. */
function isCalendarDate(value) {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Read one `##` line.
 *
 * Returns null for a line that is not an `h2`, and otherwise the heading text
 * plus what could be made of it: `version` set with `date` for the dated form,
 * `version` set with a null `date` for a heading that starts with a canonical
 * version and fails the rest of the contract (an en dash, a missing date, a
 * trailing "(yanked)", an impossible date), and both null for anything else,
 * `## Unreleased` among them.
 */
export function parseHeading(line) {
  const match = /^##[ \t]+(.*?)[ \t]*$/u.exec(line);
  if (match === null) return null;
  const text = match[1];
  const dated = DATED_HEADING.exec(text);
  if (dated !== null && CANONICAL_VERSION.test(dated[1]) && isCalendarDate(dated[2])) {
    return { text, version: dated[1], date: dated[2] };
  }
  const first = /^(\S+)/u.exec(text);
  const candidate = first === null ? "" : first[1];
  return { text, version: CANONICAL_VERSION.test(candidate) ? candidate : null, date: null };
}

/**
 * Every version-shaped heading in `text`, in file order, dated or not.
 *
 * The undated ones are carried rather than dropped: `--check` reports them, and
 * an extraction that finds one says so instead of claiming the version has no
 * section.
 */
export function listSections(text) {
  const lines = text.split("\n");
  const found = [];
  for (let index = 0; index < lines.length; index += 1) {
    const heading = parseHeading(lines[index]);
    if (heading === null || heading.version === null) continue;
    found.push({ ...heading, line: index + 1 });
  }
  return found;
}

/** The body between `startLine` (a heading, 1-based) and the next section boundary. */
function bodyAfter(lines, startLine) {
  const body = [];
  for (let index = startLine; index < lines.length; index += 1) {
    if (SECTION_BOUNDARY.test(lines[index])) break;
    body.push(lines[index]);
  }
  while (body.length > 0 && body[0].trim() === "") body.shift();
  while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();
  return body.join("\n");
}

/**
 * The section for `version` in `text`.
 *
 * Success is `{ ok: true, version, date, heading, body }`. A refusal is
 * `{ ok: false, code, message }` with one code per case, so a caller (and a
 * human reading a failed workflow step) can tell them apart:
 *
 *   - `bad-version`: the argument is not a canonical stable version;
 *   - `no-section`: no heading in the file names that version;
 *   - `duplicate-section`: two headings name it, so the body is ambiguous;
 *   - `undated-heading`: a heading names it and breaks the heading contract;
 *   - `empty-section`: the heading is well formed and the section says nothing.
 */
export function extractSection(text, version) {
  const wanted = normalizeVersion(version);
  if (wanted === null) {
    return {
      ok: false,
      code: "bad-version",
      message: `${JSON.stringify(String(version))} is not a canonical stable version (X.Y.Z, optionally v-prefixed)`,
    };
  }
  const lines = text.split("\n");
  const matches = listSections(text).filter((entry) => entry.version === wanted);
  if (matches.length === 0) {
    return {
      ok: false,
      code: "no-section",
      message: `CHANGELOG has no section for ${wanted}. Add a "${HEADING_FORM}" heading with the notes under it before tagging.`,
    };
  }
  if (matches.length > 1) {
    const at = matches.map((entry) => `line ${entry.line}`).join(", ");
    return {
      ok: false,
      code: "duplicate-section",
      message: `CHANGELOG has ${matches.length} sections for ${wanted} (${at}). One version, one section: which body a Release carries is not a guess.`,
    };
  }
  const [heading] = matches;
  if (heading.date === null) {
    return {
      ok: false,
      code: "undated-heading",
      message: `CHANGELOG heading "## ${heading.text}" (line ${heading.line}) carries no release date. It must read "${HEADING_FORM}" exactly, em dash and ISO date, before ${wanted} can be released.`,
    };
  }
  const body = bodyAfter(lines, heading.line);
  if (body === "") {
    return {
      ok: false,
      code: "empty-section",
      message: `CHANGELOG section for ${wanted} (line ${heading.line}) is empty. A Release body is the section, so an empty section is nothing to publish.`,
    };
  }
  return { ok: true, version: wanted, date: heading.date, heading: `## ${heading.text}`, body };
}

/** Parse the command line. Every ambiguity is an error, never a quiet default. */
export function parseArgs(argv) {
  const options = { version: null, changelog: null, out: null, check: false, error: null };
  const fail = (message) => {
    if (options.error === null) options.error = message;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      options.check = true;
    } else if (arg === "--changelog" || arg === "--out") {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) fail(`${arg} requires a path`);
      else {
        if (arg === "--out") options.out = next;
        else options.changelog = next;
        index += 1;
      }
    } else if (arg.startsWith("-")) {
      fail(`unknown option ${arg}`);
    } else if (options.version !== null) {
      fail(`unexpected second version ${arg}`);
    } else {
      options.version = arg;
    }
    if (options.error !== null) break;
  }
  if (options.error === null) {
    if (options.check && options.version !== null) fail("--check takes no version");
    if (!options.check && options.version === null) fail("a version is required, or --check");
    if (options.check && options.out !== null) fail("--check writes no file");
  }
  return options;
}

/** The `--check` report: dated sections, and anything unreleasable as a complaint. */
export function checkReport(text) {
  const found = listSections(text);
  const dated = found.filter((entry) => entry.date !== null);
  const undated = found.filter((entry) => entry.date === null);
  const counted = new Map();
  for (const entry of dated) counted.set(entry.version, (counted.get(entry.version) ?? 0) + 1);
  const duplicates = [...counted].filter(([, count]) => count > 1).map(([version]) => version);
  const complaints = [
    ...undated.map(
      (entry) =>
        `line ${entry.line}: "## ${entry.text}" is version-shaped and undated; "${HEADING_FORM}" is the form`,
    ),
    ...duplicates.map((version) => `${version} has more than one dated section`),
  ];
  if (dated.length === 0) {
    complaints.push("no dated version section at all; nothing here could be released");
  }
  return { dated, complaints };
}

export function main(argv, io = {}) {
  const out = io.stdout ?? process.stdout;
  const err = io.stderr ?? process.stderr;
  const options = parseArgs(argv);
  if (options.error !== null) {
    err.write(`release-notes: ${options.error}\n`);
    return 2;
  }
  const path = options.changelog ?? DEFAULT_CHANGELOG;
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    err.write(`release-notes: cannot read ${path}: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    return 2;
  }

  if (options.check) {
    const { dated, complaints } = checkReport(text);
    for (const entry of dated) out.write(`${entry.version} ${entry.date}\n`);
    for (const complaint of complaints) err.write(`release-notes: ${complaint}\n`);
    return complaints.length === 0 ? 0 : 1;
  }

  const section = extractSection(text, options.version);
  if (!section.ok) {
    err.write(`release-notes: ${section.code}: ${section.message}\n`);
    return 1;
  }
  if (options.out === null) {
    out.write(`${section.body}\n`);
    return 0;
  }
  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(options.out, `${section.body}\n`, "utf8");
  err.write(`release-notes: wrote ${options.out}, ${section.body.split("\n").length} lines from ${section.heading}\n`);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
