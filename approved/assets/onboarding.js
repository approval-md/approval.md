const CLASS_CHOICES = ["vcs.push.main", "communicate.email.external", "financial.spend"];
const LEVEL_CHOICES = new Set(["autonomous", "supervised-retro", "supervised-live", "manual", "human-only"]);

function rateFromPercent(value, label, allowZero = false) {
  const raw = String(value ?? "").trim();
  if (!/^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) throw new RangeError(`${label} must be a decimal percentage.`);
  const percent = raw === "" ? NaN : Number(raw);
  if (percent === 0 && /[1-9]/.test(raw.split(/[eE]/)[0])) throw new RangeError(`${label} is too small to represent.`);
  if (!Number.isFinite(percent) || percent > 100 || (allowZero ? percent < 0 : percent <= 0)) {
    throw new RangeError(`${label} must be ${allowZero ? "0–100" : "more than 0 and at most 100"}%.`);
  }
  const rate = Number((percent / 100).toPrecision(15));
  if (percent > 0 && rate === 0) throw new RangeError(`${label} is too small to represent.`);
  return rate;
}

// Only the three named classes are configurable here; every other class stays manual.
export function buildDraftPolicy({ rules = {}, auditPercent = 10 } = {}) {
  if (Object.keys(rules).some(name => !CLASS_CHOICES.includes(name))) throw new TypeError("Unknown class choice");
  const auditRate = rateFromPercent(auditPercent, "Global retrospective audit", true);
  const lines = [
    "# APPROVAL.md — draft from Approved",
    "",
    "Review and attest this policy before activation.",
    "",
    "```yaml approval-policy",
    'version: "0.1"',
    "",
    "defaults:",
    "  autonomy: manual",
    "  channel: telegram",
    '  approval_ttl: "2h"',
    "  on_expiry: reject",
    "  token_delivery: sealed",
    "",
    "approvers:",
    "  owner:",
    "    channels: [telegram, cli]",
    "",
    "audit:",
    `  supervised_sample_rate: ${auditRate}`,
    "  sampling_secret_env: APPROVAL_SAMPLING_SECRET",
    "",
    "classes:",
    "  read.*:",
    "    autonomy: autonomous",
  ];
  for (const name of CLASS_CHOICES) {
    const rule = rules[name] ?? { autonomy: "manual" };
    const level = rule.autonomy;
    if (!LEVEL_CHOICES.has(level)) throw new TypeError(`Invalid autonomy for ${name}`);
    const hasLive = rule.livePercent !== undefined && String(rule.livePercent).trim() !== "";
    const hasRetro = rule.retroPercent !== undefined && String(rule.retroPercent).trim() !== "";
    if (level !== "supervised-live" && hasLive) throw new TypeError(`Live sampling is not valid for ${name}`);
    if (level !== "supervised-live" && level !== "supervised-retro" && hasRetro) throw new TypeError(`Retrospective sampling is not valid for ${name}`);
    lines.push(`  ${name}:`, `    autonomy: ${level}`);
    if (level === "supervised-live") lines.push(`    live_rate: ${rateFromPercent(rule.livePercent, `${name} live sampling`)}`);
    if (hasRetro) lines.push(`    retro_rate: ${rateFromPercent(rule.retroPercent, `${name} retrospective audit`)}`);
    if (level === "manual" || level === "supervised-live") lines.push("    approvers: [owner]");
  }
  lines.push(
    "",
    "channels:",
    "  telegram:",
    "    token_env: APPROVAL_TG_TOKEN",
    "    chat_id_env: APPROVAL_TG_CHAT",
    "```",
    "",
  );
  return lines.join("\n");
}

function initOnboarding() {
  const root = document.querySelector(".onboarding");
  if (!root) return;
  const steps = [...root.querySelectorAll("[data-onboarding-step]")];
  const panels = [...root.querySelectorAll("[data-onboarding-panel]")];
  const ruleElements = [...root.querySelectorAll("[data-policy-rule]")];
  const auditInput = root.querySelector("#onboarding-audit-rate");
  const policyError = root.querySelector("#onboarding-policy-error");
  const back = root.querySelector("#onboarding-back");
  const next = root.querySelector("#onboarding-next");
  const position = root.querySelector("#onboarding-position");
  const text = root.querySelector("#onboarding-policy-text");
  const download = root.querySelector("#onboarding-download");
  const copy = root.querySelector("#onboarding-copy");
  const copyStatus = root.querySelector("#onboarding-copy-status");
  const selection = root.querySelector("#onboarding-selection");
  const plans = [...root.querySelectorAll('input[name="onboarding-plan"]')];
  const nextLabels = ["Continue to policy", "Continue to plan", "Continue as demo draft"];
  let active = 0;
  let unlocked = 0;
  let currentDraft = null;

  function config() {
    return {
      auditPercent: auditInput.value,
      rules: Object.fromEntries(ruleElements.map(element => {
        const autonomy = element.querySelector("[data-policy-mode]").value;
        const rule = { autonomy };
        if (autonomy === "supervised-live") rule.livePercent = element.querySelector("[data-live-rate] input").value;
        if (autonomy === "supervised-live" || autonomy === "supervised-retro") {
          const retro = element.querySelector("[data-retro-rate] input").value;
          if (retro.trim() !== "") rule.retroPercent = retro;
        }
        return [element.dataset.policyRule, rule];
      })),
    };
  }

  function renderDraft() {
    try {
      currentDraft = buildDraftPolicy(config());
      text.textContent = currentDraft;
      policyError.hidden = true;
      policyError.textContent = "";
    } catch (error) {
      currentDraft = null;
      text.textContent = "Fix the sampling value to generate the draft.";
      policyError.textContent = error.message;
      policyError.hidden = false;
    }
    download.disabled = !currentDraft;
    copy.disabled = !currentDraft;
    next.disabled = active === 1 && !currentDraft;
    steps.forEach((button, index) => { if (index >= 2) button.disabled = index > unlocked || !currentDraft; });
    copyStatus.textContent = "";
  }

  function showRateFields(element) {
    const mode = element.querySelector("[data-policy-mode]").value;
    element.querySelector("[data-live-rate]").hidden = mode !== "supervised-live";
    element.querySelector("[data-retro-rate]").hidden = mode !== "supervised-live" && mode !== "supervised-retro";
    renderDraft();
  }

  function renderSelection() {
    const premium = plans.find(plan => plan.checked)?.value === "premium";
    selection.textContent = premium
      ? "Your configuration: Hermes · Premium proposal · 3 VMs · $15 combined agent + judge inference allowance. Agent not created."
      : "Your configuration: Hermes · Standard proposal · 1 VM · $5 combined agent + judge inference allowance. Agent not created.";
  }

  function showStep(index, focusHeading = true) {
    if (index >= 2 && !currentDraft) return;
    active = index;
    unlocked = Math.max(unlocked, index);
    steps.forEach((button, number) => {
      button.disabled = number > unlocked || (number >= 2 && !currentDraft);
      if (number === active) button.setAttribute("aria-current", "step");
      else button.removeAttribute("aria-current");
    });
    panels.forEach((panel, number) => { panel.hidden = number !== active; });
    position.textContent = `Step ${active + 1} of 4`;
    back.hidden = active === 0;
    next.hidden = active === 3;
    next.disabled = active === 1 && !currentDraft;
    if (active < 3) next.textContent = nextLabels[active];
    if (focusHeading) panels[active].querySelector("h3").focus();
  }

  ruleElements.forEach(element => {
    element.querySelector("[data-policy-mode]").addEventListener("change", () => showRateFields(element));
    element.querySelectorAll(".onboarding-rate input").forEach(input => input.addEventListener("input", renderDraft));
    showRateFields(element);
  });
  auditInput.addEventListener("input", renderDraft);
  plans.forEach(plan => plan.addEventListener("change", renderSelection));
  steps.forEach((button, index) => button.addEventListener("click", () => {
    if (index <= unlocked) showStep(index);
  }));
  back.addEventListener("click", () => showStep(active - 1));
  next.addEventListener("click", () => { if (active !== 1 || currentDraft) showStep(active + 1); });
  download.addEventListener("click", () => {
    if (!currentDraft) return;
    const file = new Blob([currentDraft], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = "APPROVAL.md";
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  });
  copy.addEventListener("click", async () => {
    if (!currentDraft) return;
    const draftToCopy = currentDraft;
    copyStatus.textContent = "";
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(draftToCopy);
      copyStatus.textContent = draftToCopy === currentDraft
        ? "APPROVAL.md copied."
        : "Copied the prior draft. Copy again for your latest choices.";
    } catch {
      copyStatus.textContent = "Copy was unavailable. Select the policy text above or try Download draft.";
    }
  });
  renderDraft();
  renderSelection();
  showStep(0, false);
}

if (typeof document !== "undefined") initOnboarding();
