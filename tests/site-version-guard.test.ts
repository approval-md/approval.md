/**
 * Site version guard (APRV-332): the published pages state the package version
 * in prose, and prose goes stale silently. The landing page said 0.1.0 for a
 * day after 0.2.0 shipped. This test binds every version string on the site
 * to `package.json`, so a version bump that forgets the pages fails CI rather
 * than publishing a wrong number.
 *
 * Sites checked: the landing page's `#pkg-version` note and its JSON-LD
 * `softwareVersion`, the features page's JSON-LD, and the `llms.txt` summary.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/* Runs from dist/tests/ after tsc, so the repo root is three levels up. */
const root = join(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (rel: string): string => readFileSync(join(root, rel), "utf8");
const pkg = JSON.parse(read("package.json")) as { version: string };
const version = pkg.version;

test("site version guard: index.html states the package version", () => {
  const html = read("index.html");
  assert.match(
    html,
    new RegExp(`id="pkg-version">v${version.replaceAll(".", "\\.")}<`),
    `index.html #pkg-version must read v${version}`,
  );
  assert.match(
    html,
    new RegExp(`"softwareVersion": "${version.replaceAll(".", "\\.")}"`),
    `index.html JSON-LD softwareVersion must be ${version}`,
  );
});

test("site version guard: features/index.html JSON-LD states the package version", () => {
  const html = read("features/index.html");
  assert.match(
    html,
    new RegExp(`"softwareVersion": "${version.replaceAll(".", "\\.")}"`),
    `features/index.html JSON-LD softwareVersion must be ${version}`,
  );
});

test("site version guard: llms.txt names the published version", () => {
  const text = read("llms.txt");
  assert.ok(
    text.includes(`Version ${version} is published on npm`),
    `llms.txt must say "Version ${version} is published on npm"`,
  );
  assert.ok(
    text.includes(`published version ${version} of`),
    `llms.txt npm line must name version ${version}`,
  );
});
