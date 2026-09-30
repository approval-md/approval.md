const CLASS_CHOICES = ["vcs.push.main", "communicate.email.external", "financial.spend"];
const LEVEL_CHOICES = new Set(["manual", "human-only"]);

// A deliberately narrow policy surface: every possible selection is valid and
// any class this page does not mention still defaults to manual review.
export function buildDraftPolicy(choices = {}) {
  for (const name of CLASS_CHOICES) {
    if (!LEVEL_CHOICES.has(choices[name] ?? "manual")) throw new TypeError(`Invalid autonomy for ${name}`);
  }
  const lines = [
    "# APPROVAL.md — draft from Approved",
    "",
    "This file is a preview. Downloading it does not connect Telegram,",
    "attest the policy, or activate an approval gate.",
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
    "classes:",
    "  read.*:",
    "    autonomy: autonomous",
  ];
  for (const name of CLASS_CHOICES) {
    const level = choices[name] ?? "manual";
    lines.push(`  ${name}:`, `    autonomy: ${level}`);
    if (level === "manual") lines.push("    approvers: [owner]");
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
  const selectors = [...root.querySelectorAll("[data-policy-class]")];
  const back = root.querySelector("#onboarding-back");
  const next = root.querySelector("#onboarding-next");
  const position = root.querySelector("#onboarding-position");
  const text = root.querySelector("#onboarding-policy-text");
  const download = root.querySelector("#onboarding-download");
  const copy = root.querySelector("#onboarding-copy");
  const copyStatus = root.querySelector("#onboarding-copy-status");
  const selection = root.querySelector("#onboarding-selection");
  const plans = [...root.querySelectorAll('input[name="onboarding-plan"]')];
  const nextLabels = ["Continue to policy", "Continue to plan", "Continue to Telegram"];
  let active = 0;
  let unlocked = 0;

  function draft() {
    return buildDraftPolicy(Object.fromEntries(selectors.map(select => [select.dataset.policyClass, select.value])));
  }

  function renderDraft() {
    text.textContent = draft();
    copyStatus.textContent = "";
  }

  function renderSelection() {
    const premium = plans.find(plan => plan.checked)?.value === "premium";
    selection.textContent = premium
      ? "Your preview: Hermes · Premium proposal · 3 VMs · $15 combined agent + judge inference allowance. Nothing is provisioned."
      : "Your preview: Hermes · Standard proposal · 1 VM · $5 combined agent + judge inference allowance. Nothing is provisioned.";
  }

  function showStep(index, focusHeading = true) {
    active = index;
    unlocked = Math.max(unlocked, index);
    steps.forEach((button, number) => {
      button.disabled = number > unlocked;
      if (number === active) button.setAttribute("aria-current", "step");
      else button.removeAttribute("aria-current");
    });
    panels.forEach((panel, number) => { panel.hidden = number !== active; });
    position.textContent = `Step ${active + 1} of 4`;
    back.hidden = active === 0;
    next.hidden = active === 3;
    if (active < 3) next.textContent = nextLabels[active];
    if (focusHeading) panels[active].querySelector("h3").focus();
  }

  selectors.forEach(select => select.addEventListener("change", renderDraft));
  plans.forEach(plan => plan.addEventListener("change", renderSelection));
  steps.forEach((button, index) => button.addEventListener("click", () => {
    if (index <= unlocked) showStep(index);
  }));
  back.addEventListener("click", () => showStep(active - 1));
  next.addEventListener("click", () => showStep(active + 1));
  download.addEventListener("click", () => {
    const file = new Blob([draft()], { type: "text/markdown;charset=utf-8" });
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
    const currentDraft = draft();
    copyStatus.textContent = "";
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(currentDraft);
      copyStatus.textContent = currentDraft === draft()
        ? "Draft APPROVAL.md copied. It is still a preview and has not been activated."
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
