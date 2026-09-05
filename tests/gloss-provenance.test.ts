import assert from "node:assert/strict";
import test from "node:test";

import { attachGloss, glossMaterial } from "../src/cli/gloss-attach.js";
import {
  glossAuthor,
  glossFor,
  tidyGlossResult,
  GLOSS_EDIT_INSTRUCTION,
  GLOSS_EMAIL_INSTRUCTION,
  GLOSS_INSTRUCTION,
  GLOSS_MAX_CHARS,
  GLOSS_MODEL_ID_MAX_CHARS,
  type GlossProvenance,
  type GlossRunner,
} from "../src/cli/gloss.js";
import { claimed, computed, type ChannelRequest } from "../src/channels/contract.js";

const REQUEST: ChannelRequest = {
  action_key: computed("task-1:action", "log"),
  task: computed("task-1", "log"),
  class: computed("vcs.push.branch", "log"),
  autonomy: computed("manual", "policy-match"),
  provenance: computed("rule", "policy-match"),
  est_cost_usd: claimed(0, "agent:codex"),
  summary: claimed("Push the feature branch", "agent:codex"),
  payload_hash: computed("a".repeat(64), "payload-sha256"),
  fullPayload: computed(
    {
      value: { command: "git push origin feature", cwd: "/repo" },
      text: "git push origin feature",
      hash: "a".repeat(64),
      truncated: false,
    },
    "payload-binding",
  ),
  budgets: computed([], "budgets"),
  attestation: computed({ status: "not-attested" }, "attestation"),
  requested_ts: computed("2026-09-04T00:00:00.000Z", "log"),
  ttl_remaining_ms: computed(null, "clock"),
  waiting: computed("requested now", "clock"),
  chain: computed({ seq: 1, hash: "b".repeat(64), head_seq: 1 }, "log"),
  state: computed("requested", "log"),
};

function answer(text: string, provenance: GlossProvenance) {
  return { text, provenance };
}

test("typed results retain provider and distinguish requested from confirmed models", () => {
  const requested = tidyGlossResult(
    answer("  Pushes the feature branch.\n", { provider: "codex", requestedModel: "gpt-small" }),
  );
  assert.deepEqual(requested, {
    text: "Pushes the feature branch.",
    provenance: { provider: "codex", requestedModel: "gpt-small" },
  });
  assert.equal(glossAuthor(requested!), "model:codex/gpt-small (requested)");

  const confirmed = tidyGlossResult(
    answer("Pushes the feature branch.", {
      provider: "codex",
      requestedModel: "gpt-small",
      confirmedModel: "gpt-small-2026-08-01",
    }),
  );
  assert.equal(
    glossAuthor(confirmed!),
    "model:codex/gpt-small-2026-08-01 (confirmed; requested:gpt-small)",
  );
});

test("legacy string runners keep the historical Haiku attribution only on that seam", () => {
  const legacy = glossFor(GLOSS_INSTRUCTION, "git status", () => "Shows repository status.");
  assert.equal(legacy?.legacy, true);
  assert.equal(glossAuthor(legacy!), "model:haiku");

  const typed = glossFor(GLOSS_INSTRUCTION, "git status", () =>
    answer("Shows repository status.", { provider: "claude", requestedModel: "haiku" }),
  );
  assert.equal(typed?.legacy, undefined);
  assert.equal(glossAuthor(typed!), "model:claude/haiku (requested)");
});

test("attachment renders runner provenance without changing bound request fields", () => {
  const before = structuredClone(REQUEST);
  const attached = attachGloss(REQUEST, () =>
    answer("Pushes the feature branch to origin.", {
      provider: "codex",
      requestedModel: "gpt-small",
    }),
  );

  assert.equal(attached.outcome, "attached");
  assert.deepEqual(attached.request.gloss, {
    kind: "claimed",
    value: "Pushes the feature branch to origin.",
    author: "model:codex/gpt-small (requested)",
  });
  assert.deepEqual(REQUEST, before, "attachment mutated the tagged gate request");
  assert.equal(attached.request.class, REQUEST.class);
  assert.equal(attached.request.autonomy, REQUEST.autonomy);
  assert.equal(attached.request.payload_hash, REQUEST.payload_hash);
  assert.equal(attached.request.fullPayload, REQUEST.fullPayload);
});

test("command, file edit and email payloads retain their dedicated instructions", () => {
  assert.equal(glossMaterial({ command: "git status" })?.instruction, GLOSS_INSTRUCTION);
  assert.equal(
    glossMaterial({ tool: "Edit", file: "a.ts", before: "before", after: "after" })?.instruction,
    GLOSS_EDIT_INSTRUCTION,
  );
  assert.equal(
    glossMaterial({
      from: "sender@example.com",
      to: ["person@example.com"],
      subject: "Hello",
      body: "Checking in",
    })
      ?.instruction,
    GLOSS_EMAIL_INSTRUCTION,
  );
  assert.equal(glossMaterial({ opaque: true }), null);
});

test("normalization remains single-line, capped and fail-closed for unusable results", () => {
  const provenance: GlossProvenance = { provider: "codex", requestedModel: "gpt-small" };
  const capped = tidyGlossResult(answer(` a\n${"x".repeat(GLOSS_MAX_CHARS * 2)} `, provenance));
  assert.equal(capped?.text.length, GLOSS_MAX_CHARS);
  assert.ok(capped?.text.endsWith("…"));
  assert.equal(tidyGlossResult(answer(" \n ", provenance)), null);
  assert.equal(
    tidyGlossResult(answer("text", { provider: "codex", requestedModel: "   " })),
    null,
  );
  assert.equal(
    tidyGlossResult(
      answer("text", { provider: "claude", requestedModel: "haiku", confirmedModel: " " }),
    ),
    null,
  );
  assert.equal(tidyGlossResult(undefined), null);
  assert.equal(tidyGlossResult({ text: "text" }), null);
  assert.equal(tidyGlossResult({ text: 42, provenance }), null);
  assert.equal(tidyGlossResult({ text: "text", provenance: "codex" }), null);
  assert.equal(
    tidyGlossResult({ text: "text", provenance: { provider: "codex", requestedModel: 42 } }),
    null,
  );
  assert.equal(
    tidyGlossResult(
      answer("text", {
        provider: "codex",
        requestedModel: "x".repeat(GLOSS_MODEL_ID_MAX_CHARS + 1),
      }),
    ),
    null,
  );
  assert.equal(
    tidyGlossResult(answer("text", { provider: "codex", requestedModel: "gpt-small\npreview" })),
    null,
  );
  assert.equal(
    tidyGlossResult(answer("text", { provider: "codex", requestedModel: "fake) (confirmed" })),
    null,
  );
  const trimmed = tidyGlossResult(
    answer("text", { provider: "codex", requestedModel: " gpt-small " }),
  );
  assert.equal(trimmed?.provenance.requestedModel, "gpt-small");
});

test("every runner failure remains absence and never changes the request", () => {
  const throwingResult = {
    get text(): string {
      throw new Error("untrusted getter failed");
    },
    provenance: { provider: "codex" as const, requestedModel: "gpt-small" },
  };
  const runners: GlossRunner[] = [
    () => null,
    () => "",
    () => " \n ",
    () => answer("", { provider: "codex", requestedModel: "gpt-small" }),
    () => throwingResult,
    () => {
      throw new Error("runner failed");
    },
  ];

  for (const run of runners) {
    const attached = attachGloss(REQUEST, run);
    assert.equal(attached.outcome, "absent");
    assert.equal(attached.request, REQUEST);
    assert.equal(attached.request.gloss, undefined);
  }
});
