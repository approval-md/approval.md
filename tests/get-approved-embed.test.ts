import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const root = join(fileURLToPath(import.meta.url), "..", "..", "..");
const page = readFileSync(join(root, "approved/index.html"), "utf8");
const script = page.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1];
assert.ok(script, "the Get Approved controller is present");

function harness() {
  const windowHandlers: Record<string, (event: Record<string, unknown>) => void> = {};
  const buttonHandlers: Record<string, () => void> = {};
  const source = {};
  const scrolls: { top: number; behavior: string }[] = [];
  const rect = { top: 100, height: 1200 };
  const frame = {
    contentWindow: source,
    style: { height: "" },
    src: "",
    getBoundingClientRect() { return rect; },
    focus() {},
    removeAttribute(name: string) {
      if (name === "src") this.src = "";
    },
  };
  const embed = { hidden: true };
  const button = {
    textContent: "Get Approved",
    addEventListener(name: string, cb: () => void) { buttonHandlers[name] = cb; },
    setAttribute() {},
    focus() {},
  };
  const newTab = { href: "" };
  const elements: Record<string, unknown> = {
    "get-approved-button": button,
    "demo-embed": embed,
    "demo-frame": frame,
    "demo-new-tab": newTab,
  };
  runInNewContext(script!, {
    URL,
    document: { getElementById: (id: string) => elements[id] },
    window: { innerHeight: 844, scrollY: 1000,
      scrollTo(options: { top: number; behavior: string }) { scrolls.push(options); },
      addEventListener: (name: string, cb: (event: Record<string, unknown>) => void) => { windowHandlers[name] = cb; } },
  });
  return { frame, embed, button, newTab, source, rect, scrolls, message: windowHandlers.message!, click: buttonHandlers.click! };
}

test("Get Approved accepts only current gateway height messages", () => {
  const h = harness();
  assert.equal(h.newTab.href, "https://approved-demo-gateway.vercel.app/?auto=1");
  h.click();
  assert.equal(h.embed.hidden, false);
  const send = (origin: string, source: unknown, height: unknown, type = "approved-demo-height-v1") =>
    h.message({ origin, source, data: { type, height } });
  send("https://evil.example", h.source, 1800);
  send("https://approved-demo-gateway.vercel.app", {}, 1800);
  send("https://approved-demo-gateway.vercel.app", h.source, Number.NaN);
  send("https://approved-demo-gateway.vercel.app", h.source, -1);
  send("https://approved-demo-gateway.vercel.app", h.source, 1800, "other");
  assert.equal(h.frame.style.height, "");
  send("https://approved-demo-gateway.vercel.app", h.source, 100);
  assert.equal(h.frame.style.height, "520px");
  send("https://approved-demo-gateway.vercel.app", h.source, 9000);
  assert.equal(h.frame.style.height, "9004px");
  h.click();
  assert.equal(h.embed.hidden, true);
  assert.equal(h.frame.src, "");
  assert.equal(h.frame.style.height, "");
  send("https://approved-demo-gateway.vercel.app", h.source, 1200);
  assert.equal(h.frame.style.height, "");
});

test("policy reveal scrolls only the active trusted iframe header into view", () => {
  const h = harness();
  h.click();
  const send = (origin: string, source: unknown, y: unknown) =>
    h.message({ origin, source, data: { type: "approved-demo-policy-reveal-v1", y } });
  send("https://evil.example", h.source, 300);
  send("https://approved-demo-gateway.vercel.app.evil.example", h.source, 300);
  send("https://approved-demo-gateway.vercel.app", {}, 300);
  for (const y of [Number.NaN, Infinity, -1, 1201, 30001, "300"]) send("https://approved-demo-gateway.vercel.app", h.source, y);
  assert.equal(h.scrolls.length, 0);
  send("https://approved-demo-gateway.vercel.app", h.source, 100);
  assert.equal(h.scrolls.length, 0, "visible header does not move the page");
  h.rect.top = -500;
  send("https://approved-demo-gateway.vercel.app", h.source, 300);
  assert.equal(h.scrolls.length, 1);
  assert.equal(h.scrolls[0]?.top, 776);
  h.click();
  send("https://approved-demo-gateway.vercel.app", h.source, 300);
  assert.equal(h.scrolls.length, 1, "closed iframe ignores old messages");
});

test("Get Approved stays wide without changing deck and policy builder links", () => {
  assert.match(page, /get-approved \{[^}]*width: min\(1500px, calc\(100vw - 32px\)\)/);
  assert.match(page, /href="slides\.html"/);
  assert.match(page, /https:\/\/approval\.md\/hosted\/policy-builder\//);
  assert.doesNotMatch(page, /scrolling="no"/);
});
