import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadPolicyText } from "../src/core/policy-load.js";

const root = join(fileURLToPath(import.meta.url), "..", "..", "..");
const page = readFileSync(join(root, "approved/index.html"), "utf8");
const script = readFileSync(join(root, "approved/assets/onboarding.js"), "utf8");
const moduleUrl = new URL("../../approved/assets/onboarding.js", import.meta.url);
const { buildDraftPolicy } = await import(moduleUrl.href);

test("every constrained onboarding choice produces a valid approval policy", () => {
  const classes = ["vcs.push.main", "communicate.email.external", "financial.spend"];
  for (let mask = 0; mask < 8; mask++) {
    const choices = Object.fromEntries(classes.map((name, index) => [name, mask & (1 << index) ? "human-only" : "manual"]));
    const draft = buildDraftPolicy(choices);
    const loaded = loadPolicyText("APPROVAL.md", draft);
    assert.equal(loaded.ok, true, loaded.ok ? "" : `${loaded.code}: ${loaded.message}`);
    if (!loaded.ok) continue;
    assert.equal(loaded.policy.defaults?.autonomy, "manual");
    assert.equal(loaded.policy.defaults?.channel, "telegram");
    for (const name of classes) assert.equal(loaded.policy.classes?.[name]?.autonomy, choices[name]);
    assert.match(draft, /This file is a preview/);
    assert.doesNotMatch(draft, /senders:/);
  }
  assert.throws(() => buildDraftPolicy({ "financial.spend": "autonomous" }), TypeError);
});

test("preview stays separate from the existing live demo and avoids activation", () => {
  assert.ok(page.indexOf('class="onboarding"') < page.indexOf('id="live-demo"'));
  assert.match(page, /<strong>Preview only<\/strong>/);
  assert.match(page, /href="#live-demo"/);
  assert.match(page, /id="demo-frame"/);
  assert.match(page, /approved-demo-height-v1/);
  assert.match(page, /approved-demo-policy-reveal-v1/);
  assert.match(page, /Bountify Inc/);
  assert.match(page, /separate from the Jobmaxxing product catalog/);
  assert.match(page, /No payment is collected in this preview/);
  assert.match(page, /\$5 combined agent \+ judge inference allowance/);
  assert.match(page, /\$15 combined agent \+ judge inference allowance/);
  assert.match(page, /id="onboarding-selection"/);
  assert.match(script, /selection\.textContent = premium/);
  assert.match(script, /document\.body\.appendChild\(link\)/);
  assert.match(script, /URL\.revokeObjectURL\(url\), 60_000/);
  assert.match(page, /id="onboarding-copy-status" role="status"/);
  assert.match(script, /await navigator\.clipboard\.writeText\(currentDraft\)/);
  assert.match(script, /Copy was unavailable/);
  for (const forbidden of ["fetch(", "XMLHttpRequest", "sendBeacon", "localStorage", "sessionStorage", "get-approved-button"]) {
    assert.doesNotMatch(script, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
