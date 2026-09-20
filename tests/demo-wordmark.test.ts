/**
 * The demo page wears the brand's mark, not one of its own (APRV-392).
 *
 * `examples/web-agent-demo/public/index.html` is the page a room looks at. It
 * is projected at demos, reached through a tunnel, and read by people who have
 * never seen approval.md before, so the header it carries is the first and
 * sometimes the only piece of the project they see. It used to draw its own
 * `approval.md` in whatever the page's font stack resolved to; it now carries
 * `brand/wordmark.svg` itself.
 *
 * Inlined, not linked. The contract at the top of `server.mjs` forbids a CDN
 * and an external font because a demo behind a tunnel has no network to spare
 * and no second chance in front of an audience, and the same argument retires
 * an `<img src>`: a header that costs a request is a header that can be
 * missing. Inlining also leaves that file's route table exactly as it was,
 * which matters more than a header does, since every route on that server is
 * part of a security argument.
 *
 * What this file pins:
 *
 *  1. The bytes. The `<svg>` the demo page serves is `brand/wordmark.svg`
 *     verbatim. A copied asset is an asset that drifts, and the only cheap
 *     defence against drift is an equality test that fails the moment someone
 *     edits one of the two.
 *  2. The page still asks the network for nothing, so it renders offline.
 *  3. The other two pages that carry the mark, `index.html` and
 *     `rsi/index.html`, draw it from the same geometry. They compose it
 *     differently on purpose (both set the letters in the page's own font and
 *     drop the glyph in where the "o" goes, and rsi hangs "/ rsi" off the
 *     end), so the thing to pin there is the artwork rather than the file: the
 *     two bracket paths, the tick, and the green.
 *
 * It reads checked-in files and spawns nothing, because the claim under test
 * is "these four files agree", which no amount of running proves better.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/** The repository root, from `dist/tests/` at runtime. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function read(relative: string): string {
  return readFileSync(join(REPO_ROOT, relative), "utf8");
}

const DEMO_PAGE_PATH = "examples/web-agent-demo/public/index.html";
const WORDMARK = read("brand/wordmark.svg");
const DEMO_PAGE = read(DEMO_PAGE_PATH);

/**
 * The three `d` attributes the mark is drawn from: the two bracket halves and
 * the tick between them. Matched on the attribute rather than on the whole
 * element, because the three pages write the surrounding element differently
 * (a `class="bx"` here, a `fill="#17191D"` there) and it is the geometry that
 * has to agree, not the markup around it.
 */
function glyphPaths(svg: string): string[] {
  return [...svg.matchAll(/\sd="([^"]+)"/gu)].map((match) => match[1] ?? "");
}

/** The tick's green, as the asset spells it. */
const TICK_GREEN = "#17A15E";

test("the demo page carries brand/wordmark.svg byte for byte (APRV-392)", () => {
  const asset = WORDMARK.trimEnd();
  assert.ok(
    asset.startsWith("<svg") && asset.endsWith("</svg>"),
    "brand/wordmark.svg should be one <svg> element and nothing else",
  );
  assert.ok(
    DEMO_PAGE.includes(asset),
    `${DEMO_PAGE_PATH} no longer contains brand/wordmark.svg verbatim. The two have ` +
      "drifted: re-inline the asset rather than editing the copy in the page.",
  );
});

test("the demo page renders with no request of any kind (APRV-392)", () => {
  // Absolute and protocol-relative sources, which is every shape a browser
  // would go to the network for. A demo behind a tunnel, or on no network at
  // all, has to draw its own header.
  const external = [...DEMO_PAGE.matchAll(/(?:src|href)\s*=\s*"((?:https?:)?\/\/[^"]*)"/gu)].map(
    (match) => match[1] ?? "",
  );
  assert.deepEqual(
    external,
    [],
    `${DEMO_PAGE_PATH} must fetch nothing; found ${external.join(", ")}`,
  );
  assert.ok(!DEMO_PAGE.includes("@import"), "no @import: the page carries its own styles");
  assert.ok(
    !/<link[^>]+rel\s*=\s*"(?:stylesheet|preconnect|dns-prefetch)"/u.test(DEMO_PAGE),
    "no stylesheet or preconnect link: the page carries its own styles",
  );
});

test("the guest-mode demo is this same page (APRV-392)", () => {
  // Guest mode is an instance (`--instance guest`, its own gate directory and
  // its own empty vault), not a second front end: the server is handed a
  // `--dir` and serves this one file whichever instance that is. So "the
  // guest-mode variant uses the same mark" is a property of public/ holding
  // exactly one page, and this is where that stops being true silently.
  const served = readdirSync(join(REPO_ROOT, "examples/web-agent-demo/public")).sort();
  assert.deepEqual(
    served,
    ["index.html"],
    "examples/web-agent-demo/public/ serves one page; a second one would need its own mark check",
  );
  const server = read("examples/web-agent-demo/server.mjs");
  assert.ok(
    server.includes('path === "/" || path === "/index.html"'),
    "the demo server still has exactly one page route",
  );
});

test("the landing page and /rsi draw the mark from the same geometry (APRV-392)", () => {
  const brand = glyphPaths(WORDMARK);
  assert.equal(brand.length, 3, "the mark is two bracket halves and a tick");
  assert.ok(WORDMARK.includes(TICK_GREEN), "the asset still names the tick's green");

  for (const page of ["index.html", "rsi/index.html"]) {
    const text = read(page);
    for (const d of brand) {
      assert.ok(
        text.includes(`d="${d}"`),
        `${page} no longer draws the mark from brand/wordmark.svg's geometry (missing ${d})`,
      );
    }
    assert.ok(text.includes(TICK_GREEN), `${page} no longer uses the brand green for the tick`);
  }
});
