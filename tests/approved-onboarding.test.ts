import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import { loadPolicyText } from "../src/core/policy-load.js";

const root = join(fileURLToPath(import.meta.url), "..", "..", "..");
const page = readFileSync(join(root, "approved/index.html"), "utf8");
const script = readFileSync(join(root, "approved/assets/onboarding.js"), "utf8");
const builderPage = readFileSync(join(root, "hosted/policy-builder/index.html"), "utf8");
const moduleUrl = new URL("../../approved/assets/onboarding.js", import.meta.url);
const { buildDraftPolicy } = await import(moduleUrl.href);

test("five onboarding modes and sampling rates produce parseable, exact policy fields", () => {
  const classes = ["vcs.push.main", "communicate.email.external", "financial.spend"];
  const levels = ["autonomous", "supervised-retro", "supervised-live", "manual", "human-only"];
  for (const level of levels) {
    const rules = Object.fromEntries(classes.map(name => [name, {
      autonomy: level,
      ...(level === "supervised-live" ? { livePercent: "33.3", retroPercent: "12.5" } : {}),
      ...(level === "supervised-retro" ? { retroPercent: "12.5" } : {}),
    }]));
    const draft = buildDraftPolicy({ rules, auditPercent: "7.5" });
    const loaded = loadPolicyText("APPROVAL.md", draft);
    assert.equal(loaded.ok, true, loaded.ok ? "" : `${loaded.code}: ${loaded.message}`);
    if (!loaded.ok) continue;
    assert.equal(loaded.policy.defaults?.autonomy, "manual");
    assert.equal(loaded.policy.defaults?.channel, "telegram");
    assert.equal(loaded.policy.audit?.supervised_sample_rate, 0.075);
    assert.equal(loaded.policy.audit?.sampling_secret_env, "APPROVAL_SAMPLING_SECRET");
    for (const name of classes) {
      const resolvedRule: { autonomy: string; live_rate?: number; retro_rate?: number } | undefined = loaded.policy.classes?.[name];
      assert.equal(resolvedRule?.autonomy, level);
      assert.equal(resolvedRule?.live_rate, level === "supervised-live" ? 0.333 : undefined);
      assert.equal(resolvedRule?.retro_rate, level.startsWith("supervised-") ? 0.125 : undefined);
    }
    assert.match(draft, /Review and attest this policy before activation/);
    assert.doesNotMatch(draft, /senders:/);
  }
  const zero = loadPolicyText("APPROVAL.md", buildDraftPolicy({ auditPercent: 0 }));
  assert.equal(zero.ok, true);
  if (zero.ok) assert.equal(zero.policy.audit?.supervised_sample_rate, 0);
});

test("invalid and inapplicable sampling settings cannot produce a draft", () => {
  const rule = (autonomy: string, extra: object = {}) => ({ rules: { "financial.spend": { autonomy, ...extra } } });
  for (const auditPercent of ["", -1, 101, "Infinity", "nope", "1e-999", "-1e-999", "1e-323"]) {
    assert.throws(() => buildDraftPolicy({ auditPercent }), RangeError);
  }
  for (const livePercent of ["", 0, -0.1, 101, "NaN"]) {
    assert.throws(() => buildDraftPolicy(rule("supervised-live", { livePercent })), RangeError);
  }
  for (const retroPercent of [0, -1, 101, "NaN"]) {
    assert.throws(() => buildDraftPolicy(rule("supervised-retro", { retroPercent })), RangeError);
  }
  assert.throws(() => buildDraftPolicy(rule("manual", { retroPercent: 10 })), TypeError);
  assert.throws(() => buildDraftPolicy(rule("autonomous", { livePercent: 10 })), TypeError);
  assert.throws(() => buildDraftPolicy(rule("unknown")), TypeError);
});

test("onboarding blocks unlocked forward steps and export for invalid rates, then preserves hidden choices", () => {
  function element(value = "") {
    const listeners: Record<string, () => void> = {};
    return {
      value, checked: false, hidden: false, disabled: false, textContent: "", dataset: {} as Record<string, string>,
      addEventListener(name: string, listener: () => void) { listeners[name] = listener; },
      emit(name: string) { listeners[name]?.(); },
      setAttribute() {}, removeAttribute() {}, focus() {},
    };
  }
  const rules = ["vcs.push.main", "communicate.email.external", "financial.spend"].map(name => {
    const mode = element("manual");
    const liveInput = element("10");
    const retroInput = element("");
    const liveWrap = { hidden: true, querySelector: () => liveInput };
    const retroWrap = { hidden: true, querySelector: () => retroInput };
    return {
      dataset: { policyRule: name }, mode, liveInput, retroInput, liveWrap, retroWrap,
      querySelector(selector: string) { return ({ "[data-policy-mode]": mode, "[data-live-rate]": liveWrap, "[data-retro-rate]": retroWrap, "[data-live-rate] input": liveInput, "[data-retro-rate] input": retroInput } as Record<string, unknown>)[selector]; },
      querySelectorAll: () => [liveInput, retroInput],
    };
  });
  const steps = Array.from({ length: 4 }, () => element());
  const panels = Array.from({ length: 4 }, () => ({ hidden: false, querySelector: () => element() }));
  const audit = element("10");
  const next = element();
  const download = element();
  const copy = element();
  const position = element();
  const text = element();
  const error = element();
  const standard = element("standard"); standard.checked = true;
  const premium = element("premium");
  const named: Record<string, unknown> = {
    "#onboarding-audit-rate": audit, "#onboarding-policy-error": error, "#onboarding-back": element(),
    "#onboarding-next": next, "#onboarding-position": position, "#onboarding-policy-text": text,
    "#onboarding-download": download, "#onboarding-copy": copy, "#onboarding-copy-status": element(),
    "#onboarding-selection": element(),
  };
  const root = {
    querySelector: (selector: string) => named[selector],
    querySelectorAll: (selector: string) => ({ "[data-onboarding-step]": steps, "[data-onboarding-panel]": panels, "[data-policy-rule]": rules, 'input[name="onboarding-plan"]': [standard, premium] } as Record<string, unknown>)[selector],
  };
  runInNewContext(script.replace("export function buildDraftPolicy", "function buildDraftPolicy"), {
    document: { querySelector: () => root }, navigator: {}, setTimeout,
  });
  next.emit("click"); // Policy
  next.emit("click"); // Unlock Plan
  steps[1]!.emit("click"); // Return to Policy
  const spend = rules[2]!;
  spend.mode.value = "supervised-live";
  spend.mode.emit("change");
  assert.equal(spend.liveWrap.hidden, false);
  assert.equal(spend.retroWrap.hidden, false);
  spend.liveInput.value = "0";
  spend.liveInput.emit("input");
  assert.equal(next.disabled, true);
  assert.equal(steps[2]!.disabled, true);
  assert.equal(download.disabled, true);
  assert.equal(copy.disabled, true);
  steps[2]!.emit("click");
  assert.equal(position.textContent, "Step 2 of 4");
  spend.liveInput.value = "37.5";
  spend.retroInput.value = "22.5";
  spend.liveInput.emit("input");
  assert.equal(next.disabled, false);
  assert.equal(steps[2]!.disabled, false);
  assert.match(text.textContent, /live_rate: 0\.375/);
  assert.match(text.textContent, /retro_rate: 0\.225/);
  spend.mode.value = "manual";
  spend.mode.emit("change");
  assert.equal(spend.liveWrap.hidden, true);
  assert.equal(spend.retroWrap.hidden, true);
  assert.doesNotMatch(text.textContent, /live_rate|retro_rate/);
  assert.equal(spend.liveInput.value, "37.5");
  assert.equal(spend.retroInput.value, "22.5");
  spend.mode.value = "supervised-live";
  spend.mode.emit("change");
  assert.match(text.textContent, /live_rate: 0\.375/);
  audit.value = "";
  audit.emit("input");
  assert.equal(download.disabled, true);
  audit.value = "0";
  audit.emit("input");
  assert.equal(download.disabled, false);
});

test("preview stays separate from the existing live demo and avoids activation", () => {
  assert.ok(page.indexOf('class="onboarding"') < page.indexOf('id="live-demo"'));
  assert.match(page, /<h2 id="onboarding-title">Get Approved<\/h2>/);
  assert.match(page, /Host an Approved agent from \$99\/month/);
  assert.match(page, /aria-label="Setup steps"/);
  assert.match(page, /Choose your agent framework/);
  assert.doesNotMatch(page, /Not selectable in this preview|Selected for this preview/);
  assert.doesNotMatch(page, /class="onboarding-preview-note"/);
  assert.match(page, /Pending Stripe credentials — continue as demo draft/);
  assert.match(script, /Continue as demo draft/);
  assert.match(page, /href="#live-demo"/);
  assert.match(page, /id="demo-frame"/);
  assert.match(page, /approved-demo-height-v1/);
  assert.match(page, /approved-demo-policy-reveal-v1/);
  assert.match(page, /<p class="onboarding-billing"><strong>Pending Stripe credentials — continue as demo draft\.<\/strong><\/p>/);
  assert.match(page, /No agent has been created and no Telegram bot is connected/);
  assert.match(page, /\$5 combined agent \+ judge inference allowance/);
  assert.match(page, /\$15 combined agent \+ judge inference allowance/);
  assert.match(page, /id="onboarding-selection"/);
  assert.match(script, /selection\.textContent = premium/);
  assert.match(script, /document\.body\.appendChild\(link\)/);
  assert.match(script, /URL\.revokeObjectURL\(url\), 60_000/);
  assert.match(page, /id="onboarding-copy-status" role="status"/);
  assert.match(script, /await navigator\.clipboard\.writeText\(draftToCopy\)/);
  assert.match(script, /Copy was unavailable/);
  assert.match(page, /data-policy-mode/);
  assert.match(page, /data-live-rate/);
  assert.match(page, /data-retro-rate/);
  assert.match(script, /next\.disabled = active === 1 && !currentDraft/);
  for (const forbidden of ["fetch(", "XMLHttpRequest", "sendBeacon", "localStorage", "sessionStorage", "get-approved-button"]) {
    assert.doesNotMatch(script, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("standalone hosted builder emits the same valid live and retrospective fields", () => {
  const source = builderPage.match(/<script>\s*("use strict";[\s\S]*?)document\.getElementById\("add"\)/)?.[1];
  assert.ok(source, "builder script is present");
  const sandbox = { document: { getElementById: () => ({}) } };
  const build = runInNewContext(`${source}\nglobalThis.buildForTest = build; buildForTest`, sandbox) as (config: object) => string;
  const config = {
    approver: "owner", sender: "", defaultAutonomy: "manual", ttl: "2h", auditPercent: "3.5",
    classes: [
      { name: "vcs.push.main", mode: "supervised-live", livePercent: "12.5", retroPercent: "30" },
      { name: "financial.spend", mode: "supervised-retro", livePercent: null, retroPercent: "" },
      { name: "communicate.email.external", mode: "human-only", livePercent: null, retroPercent: null },
    ],
  };
  const result = loadPolicyText("APPROVAL.md", build(config));
  assert.equal(result.ok, true, result.ok ? "" : `${result.code}: ${result.message}`);
  if (result.ok) {
    assert.equal(result.policy.audit?.supervised_sample_rate, 0.035);
    assert.equal(result.policy.classes?.["vcs.push.main"]?.live_rate, 0.125);
    assert.equal(result.policy.classes?.["vcs.push.main"]?.retro_rate, 0.3);
    assert.equal(result.policy.classes?.["financial.spend"]?.retro_rate, undefined);
    assert.equal(result.policy.classes?.["communicate.email.external"]?.autonomy, "human-only");
  }
  assert.throws(() => build({ ...config, auditPercent: "Infinity" }), { name: "RangeError" });
  assert.throws(() => build({ ...config, auditPercent: "1e-999" }), { name: "RangeError" });
  assert.throws(() => build({ ...config, auditPercent: "-1e-999" }), { name: "RangeError" });
  assert.throws(() => build({ ...config, auditPercent: "1e-323" }), { name: "RangeError" });
  assert.throws(() => build({ ...config, classes: [{ ...config.classes[0], livePercent: 0 }] }), { name: "RangeError" });
  assert.throws(() => build({ ...config, classes: [{ ...config.classes[1], retroPercent: 0 }] }), { name: "RangeError" });
  const wildcard = loadPolicyText("APPROVAL.md", build({ ...config, classes: [{ name: "*", mode: "supervised-live", livePercent: "17.5", retroPercent: null }] }));
  assert.equal(wildcard.ok, true, wildcard.ok ? "" : `${wildcard.code}: ${wildcard.message}`);
  if (wildcard.ok) assert.equal(wildcard.policy.classes?.["*"]?.live_rate, 0.175);
  const nullClass = loadPolicyText("APPROVAL.md", build({ ...config, classes: [{ name: "null", mode: "manual" }] }));
  assert.equal(nullClass.ok, true, nullClass.ok ? "" : `${nullClass.code}: ${nullClass.message}`);
  if (nullClass.ok) assert.equal(nullClass.policy.classes?.null?.autonomy, "manual");
  assert.throws(() => build({ ...config, classes: [config.classes[0], config.classes[0]] }), { name: "TypeError", message: /Duplicate class pattern/ });
  assert.throws(() => build({ ...config, classes: [{ name: "read..file", mode: "manual" }] }), { name: "TypeError", message: /Invalid class pattern/ });
  assert.match(builderPage, /Without it, retro sampling is off and live sampling gates every action/);
});
