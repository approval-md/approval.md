/**
 * The landing page's GitHub stars chip (APRV-529).
 *
 * The page is static: GitHub Pages serves `main` at `/` with no build step
 * (APRV-407), so the count cannot be fetched when the site is built. The chip
 * ships with a committed count, and the browser asks the public API for a
 * fresher one at most once an hour. Anonymous calls are capped at 60 an hour
 * per IP, which is why a per-view call is not an option and why a failed call
 * backs off for the same hour.
 *
 * What this file pins:
 *
 *  1. Where the chip points. Its link, the API URL its script calls, the
 *     `repository` in package.json and the JSON-LD `codeRepository` all name
 *     one repository, so a rename that moves one of them fails here.
 *  2. The committed count reads as a count, and the label says what it is.
 *  3. The formatter, extracted from the page itself and run at its
 *     boundaries, so the test exercises the code the page ships.
 *  4. The refresh, also extracted from the page and run against a stand-in
 *     document, storage and fetch: a good answer replaces the count, every
 *     kind of failure leaves a number on screen (never NaN, never empty,
 *     never an error), and the hour is honoured in both directions.
 *  5. No token. A credential in a public page is a published credential.
 *
 * It reads checked-in files and spawns nothing.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/** The repository root, from `dist/tests/` at runtime. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (relative: string): string => readFileSync(join(REPO_ROOT, relative), "utf8");

const PAGE = read("index.html");
const PKG = JSON.parse(read("package.json")) as { repository: string };

/** package.json says `github:owner/name`; the page says the https URL. */
function repoUrl(): string {
  const match = /^github:([\w.-]+\/[\w.-]+)$/u.exec(PKG.repository);
  assert.ok(match, `package.json repository should read github:owner/name, got ${PKG.repository}`);
  return `https://github.com/${match[1] ?? ""}`;
}

/** The chip's anchor element, exactly as committed. */
function chip(): string {
  const anchors = [...PAGE.matchAll(/<a\b[^>]*\bid="gh-stars"[^>]*>[\s\S]*?<\/a>/gu)];
  assert.equal(anchors.length, 1, "index.html should carry exactly one #gh-stars chip");
  return anchors[0]?.[0] ?? "";
}

/** The page's stars script, from its section comment to the next section. */
function starsScript(): string {
  const start = PAGE.indexOf("/* ---------------- GitHub stars ---------------- */");
  const end = PAGE.indexOf("/* ---------------- copyable commands ---------------- */");
  assert.ok(start > 0 && end > start, "the GitHub stars section of the page script has moved");
  return PAGE.slice(start, end);
}

/** `formatStars` as the page defines it, compiled on its own. */
function formatStars(): (n: number) => string {
  const source = /function formatStars\(n\) \{[\s\S]*?\n {2}\}\n/u.exec(starsScript())?.[0];
  assert.ok(source, "formatStars is no longer defined in the stars section");
  return new Function(`${source}; return formatStars;`)() as (n: number) => string;
}

test("the chip sits in the hero and links to the package's own repository (APRV-529)", () => {
  const hero = /<header class="hero">([\s\S]*?)<\/header>/u.exec(PAGE)?.[1] ?? "";
  assert.ok(hero.includes('id="gh-stars"'), "the stars chip should sit inside the hero header");
  const url = repoUrl();
  assert.match(chip(), new RegExp(`href="${url.replaceAll(".", "\\.")}"`, "u"));
  assert.ok(
    PAGE.includes(`"codeRepository": "${url}"`),
    "the JSON-LD codeRepository and the chip should name the same repository",
  );
  const apiCalls = [...starsScript().matchAll(/https:\/\/api\.github\.com\/repos\/([\w.-]+\/[\w.-]+)'/gu)];
  assert.deepEqual(
    apiCalls.map((match) => `https://github.com/${match[1] ?? ""}`),
    [url],
    "the refresh should ask about the repository the chip links to, once",
  );
});

test("the committed count is a count and the label says GitHub stars (APRV-529)", () => {
  const anchor = chip();
  const committed = /<span class="n" id="gh-stars-n">([^<]*)<\/span>/u.exec(anchor)?.[1];
  assert.ok(committed !== undefined, "the chip should carry its count in #gh-stars-n");
  assert.match(committed, /^\d+(?:\.\d)?[kM]?$/u, "the committed count should read like 7, 1.2k or 3M");
  const label = /aria-label="([^"]*)"/u.exec(anchor)?.[1] ?? "";
  assert.ok(label.startsWith("GitHub stars: "), `the chip's label should start "GitHub stars: ", got "${label}"`);
  assert.match(anchor, /<svg class="st"[^>]*aria-hidden="true"/u, "the star glyph should be hidden from readers");
});

test("formatStars writes integers below 1000 and one decimal of k or M above (APRV-529)", () => {
  const format = formatStars();
  const cases: [number, string][] = [
    [0, "0"],
    [7, "7"],
    [999, "999"],
    [1000, "1k"],
    [1049, "1k"],
    [1234, "1.2k"],
    [15678, "15.7k"],
    [999949, "999.9k"],
    [999950, "1M"],
    [1234567, "1.2M"],
  ];
  for (const [n, want] of cases) {
    assert.equal(format(n), want, `formatStars(${n})`);
  }
});

test("the page sends no token to GitHub (APRV-529)", () => {
  const script = starsScript();
  assert.doesNotMatch(script, /authorization|bearer|token|ghp_|github_pat_/iu);
  assert.match(script, /credentials: 'omit'/u, "the call should carry no cookies either");
});

/* ---------------- the refresh, run against stand-ins ---------------- */

interface Element {
  textContent: string;
  readonly attrs: Map<string, string>;
  setAttribute(name: string, value: string): void;
}

function element(text: string, label: string): Element {
  const attrs = new Map([["aria-label", label]]);
  return { textContent: text, attrs, setAttribute: (name, value) => void attrs.set(name, value) };
}

interface Run {
  readonly num: Element;
  readonly link: Element;
  readonly calls: string[];
  readonly stored: () => string | null;
}

type Answer = { ok: boolean; body: unknown } | "reject";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 20, 8, 0, 0);

/**
 * Runs the page's stars section once. `stored` seeds localStorage, `answer`
 * is what fetch does, and `blocked` makes every storage access throw, as a
 * private window or a blocked-cookies setting does.
 */
async function run(opts: { stored?: string; answer?: Answer; blocked?: boolean }): Promise<Run> {
  const committed = /<span class="n" id="gh-stars-n">([^<]*)<\/span>/u.exec(chip())?.[1] ?? "";
  const committedLabel = /aria-label="([^"]*)"/u.exec(chip())?.[1] ?? "";
  const num = element(committed, "");
  const link = element("", committedLabel);
  const store = new Map<string, string>();
  if (opts.stored !== undefined) {
    store.set("approval-stars", opts.stored);
  }
  const localStorage = {
    getItem(key: string): string | null {
      if (opts.blocked) throw new Error("SecurityError");
      return store.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      if (opts.blocked) throw new Error("SecurityError");
      store.set(key, value);
    },
  };
  const calls: string[] = [];
  const answer = opts.answer ?? "reject";
  const fetch = (url: string): Promise<unknown> => {
    calls.push(url);
    if (answer === "reject") return Promise.reject(new TypeError("Failed to fetch"));
    return Promise.resolve({ ok: answer.ok, json: () => Promise.resolve(answer.body) });
  };
  const document = {
    getElementById: (id: string): Element | null => (id === "gh-stars" ? link : id === "gh-stars-n" ? num : null),
  };
  const DateStub = { now: () => NOW };
  const body = new Function("document", "localStorage", "window", "fetch", "Date", starsScript());
  body(document, localStorage, { fetch }, fetch, DateStub);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return { num, link, calls, stored: () => store.get("approval-stars") ?? null };
}

test("a good answer replaces the count, the label, and is remembered for the hour (APRV-529)", async () => {
  const r = await run({ answer: { ok: true, body: { stargazers_count: 1234 } } });
  assert.deepEqual(r.calls, ["https://api.github.com/repos/approval-md/approval.md"]);
  assert.equal(r.num.textContent, "1.2k");
  assert.equal(r.link.attrs.get("aria-label"), "GitHub stars: 1234. approval.md on GitHub");
  assert.deepEqual(JSON.parse(r.stored() ?? "null"), { n: 1234, t: NOW });
});

test("every failure keeps a number on screen and backs off for the hour (APRV-529)", async () => {
  const committed = /<span class="n" id="gh-stars-n">([^<]*)<\/span>/u.exec(chip())?.[1] ?? "";
  const failures: [string, Answer][] = [
    ["network error", "reject"],
    ["rate limited", { ok: false, body: { message: "API rate limit exceeded" } }],
    ["a string count", { ok: true, body: { stargazers_count: "1234" } }],
    ["NaN", { ok: true, body: { stargazers_count: Number.NaN } }],
    ["a negative count", { ok: true, body: { stargazers_count: -1 } }],
    ["a fraction", { ok: true, body: { stargazers_count: 1.5 } }],
    ["no count", { ok: true, body: {} }],
    ["a null body", { ok: true, body: null }],
  ];
  for (const [what, answer] of failures) {
    const r = await run({ answer });
    assert.equal(r.calls.length, 1, `${what}: one call`);
    assert.equal(r.num.textContent, committed, `${what}: the committed count should stay`);
    assert.deepEqual(JSON.parse(r.stored() ?? "null"), { t: NOW }, `${what}: the back-off should start`);
  }
});

test("within the hour nothing is asked; after it a remembered count shows first (APRV-529)", async () => {
  const fresh = await run({ stored: JSON.stringify({ n: 50, t: NOW - HOUR + 1000 }) });
  assert.deepEqual(fresh.calls, [], "a fresh count should not call the API");
  assert.equal(fresh.num.textContent, "50");

  const backingOff = await run({ stored: JSON.stringify({ t: NOW - 1000 }) });
  assert.deepEqual(backingOff.calls, [], "a fresh failure should not call the API either");

  const stale = await run({ stored: JSON.stringify({ n: 50, t: NOW - 2 * HOUR }), answer: "reject" });
  assert.equal(stale.calls.length, 1, "a stale count should be refreshed");
  assert.equal(stale.num.textContent, "50", "a failed refresh should keep the remembered count");
  assert.deepEqual(JSON.parse(stale.stored() ?? "null"), { n: 50, t: NOW });

  const garbage = await run({ stored: "{not json", answer: { ok: true, body: { stargazers_count: 8 } } });
  assert.equal(garbage.num.textContent, "8", "unreadable storage should be ignored, not thrown");
});

test("blocked storage still refreshes the count and throws nothing (APRV-529)", async () => {
  const r = await run({ blocked: true, answer: { ok: true, body: { stargazers_count: 42 } } });
  assert.equal(r.calls.length, 1);
  assert.equal(r.num.textContent, "42");
});
