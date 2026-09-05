import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { CliChannel, PAYLOAD_BEGIN, PAYLOAD_END } from "../src/channels/cli.js";
import {
  GLOSS_UNVERIFIED_SUFFIX,
  claimed,
  computed,
  type ChannelRequest,
} from "../src/channels/contract.js";
import { renderTelegram, TELEGRAM_GLOSS_SUFFIX } from "../src/channels/telegram.js";
import { commandChannelCli } from "../src/cli/channel.js";
import { commandTelegramListen, glossWiring } from "../src/cli/channel-telegram.js";
import { EXIT_USAGE } from "../src/cli/exit-codes.js";
import { attachGloss } from "../src/cli/gloss-attach.js";
import type { GlossRunner } from "../src/cli/gloss.js";
import { commandUp } from "../src/cli/up.js";
import type { Streams } from "../src/cli/main.js";
import { payloadHash } from "../src/core/payload.js";
import { canonicalRender } from "../src/core/wysiwys.js";

function capture(): { streams: Streams; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    streams: { out: (text) => out.push(text), err: (text) => err.push(text) },
    out,
    err,
  };
}

const SURFACES = [
  ["channel cli", commandChannelCli],
  ["channel telegram listen", commandTelegramListen],
  ["up", commandUp],
] as const;

const RENDER_PAYLOAD = { command: "printf '<payload>&'", cwd: "/repo" };
const RENDER_HASH = payloadHash(RENDER_PAYLOAD);
const RENDER_REQUEST: ChannelRequest = {
  action_key: computed("APRV-255:codex-render", "log"),
  task: computed("APRV-255", "log"),
  class: computed("network.call", "log"),
  autonomy: computed("manual", "policy-match"),
  provenance: computed("rule", "policy-match"),
  est_cost_usd: claimed(0, "agent:codex"),
  summary: claimed("Run <payload> & report it", "agent:codex"),
  payload_hash: computed(RENDER_HASH, "payload-sha256"),
  fullPayload: computed(
    {
      value: RENDER_PAYLOAD,
      text: JSON.stringify(RENDER_PAYLOAD),
      hash: RENDER_HASH,
      truncated: false,
    },
    "payload-binding",
  ),
  budgets: computed([], "budgets"),
  attestation: computed({ status: "not-attested" }, "attestation"),
  requested_ts: computed("2026-09-04T22:00:00.000Z", "log"),
  ttl_remaining_ms: computed(60_000, "clock"),
  waiting: computed("requested now; expires 22:01 UTC", "clock"),
  chain: computed({ seq: 1, hash: "a".repeat(64), head_seq: 1 }, "log"),
  state: computed("requested", "log"),
};

function codexRenderedRequest(): ChannelRequest {
  const attached = attachGloss(RENDER_REQUEST, () => ({
    text: "Runs <payload> & reports its output.",
    provenance: { provider: "codex", requestedModel: "gpt-5.4-mini" },
  }));
  assert.equal(attached.outcome, "attached");
  return attached.request;
}

test("all three surfaces reject an unknown gloss provider before repository I/O", () => {
  for (const [name, command] of SURFACES) {
    const { streams, out, err } = capture();
    const result = command(
      ["--gloss-provider", "openai", "--gloss-model", "gpt-5.4-mini"],
      streams,
      "/path-that-must-not-be-read",
    );
    assert.equal(result, EXIT_USAGE, `${name} did not return usage`);
    assert.equal(out.length, 0, `${name} wrote stdout for invalid options`);
    assert.match(err.join(""), /--gloss-provider expects claude or codex/u, name);
  }
});

test("all three surfaces require an explicit model for Codex before repository I/O", () => {
  for (const [name, command] of SURFACES) {
    const { streams, out, err } = capture();
    const result = command(
      ["--gloss-provider", "codex"],
      streams,
      "/path-that-must-not-be-read",
    );
    assert.equal(result, EXIT_USAGE, `${name} did not return usage`);
    assert.equal(out.length, 0, `${name} wrote stdout for invalid options`);
    assert.match(err.join(""), /requires --gloss-model <model>/u, name);
  }
});

test("Telegram wiring preserves defaults and constructs only the selected fake provider", () => {
  const calls: string[] = [];
  const fakeRunner: GlossRunner = () => null;
  const factories = {
    claudeRunnerFor: (passphraseEnv: string | null, model: string): GlossRunner => {
      calls.push(`claude:${model}:${passphraseEnv}`);
      return fakeRunner;
    },
    codexRunnerFor: (model: string, passphraseEnv: string | null = null): GlossRunner => {
      calls.push(`codex:${model}:${passphraseEnv}`);
      return fakeRunner;
    },
  };

  const defaults = glossWiring({}, "POLICY_PASSPHRASE", factories);
  assert.equal(defaults.gloss, fakeRunner);
  assert.deepEqual(calls, ["claude:haiku:POLICY_PASSPHRASE"]);

  calls.length = 0;
  const codex = glossWiring(
    { "--gloss-provider": "codex", "--gloss-model": "gpt-5.4-mini" },
    "RENAMED_PASSPHRASE",
    factories,
  );
  assert.equal(codex.gloss, fakeRunner);
  assert.deepEqual(calls, ["codex:gpt-5.4-mini:RENAMED_PASSPHRASE"]);

  calls.length = 0;
  const disabled = glossWiring(
    {
      "--gloss": true,
      "--no-gloss": true,
      "--gloss-provider": "codex",
      "--gloss-model": "gpt-5.4-mini",
    },
    "RENAMED_PASSPHRASE",
    factories,
  );
  assert.equal(disabled.gloss, undefined);
  assert.deepEqual(calls, []);
});

test("invalid programmatic Telegram options fail closed without constructing a provider", () => {
  let calls = 0;
  const factories = {
    claudeRunnerFor: (): GlossRunner => {
      calls += 1;
      return () => null;
    },
    codexRunnerFor: (): GlossRunner => {
      calls += 1;
      return () => null;
    },
  };
  assert.deepEqual(glossWiring({ "--gloss-provider": "codex" }, null, factories), {});
  assert.equal(calls, 0);
});

test("CLI renders Codex requested-model provenance as unverified outside the canonical payload", () => {
  const request = codexRenderedRequest();
  const chunks: string[] = [];
  const channel = new CliChannel({
    output: { write: (text) => chunks.push(String(text)) },
    input: new PassThrough(),
  });
  channel.notify(request);
  channel.close();

  const text = chunks.join("");
  const canonical = canonicalRender(RENDER_PAYLOAD, RENDER_REQUEST.class.value);
  const begin = text.indexOf(PAYLOAD_BEGIN);
  const end = text.indexOf(PAYLOAD_END);
  assert.ok(begin >= 0 && end > begin, "canonical payload delimiters are missing");
  const payloadBlock = text.slice(begin, end);

  assert.match(
    text,
    /\[claimed\]\s+gloss\s+Runs <payload> & reports its output\. \(model, unverified\) \(model:codex\/gpt-5\.4-mini \(requested\)\)/u,
  );
  assert.ok(text.includes(GLOSS_UNVERIFIED_SUFFIX));
  assert.ok(payloadBlock.includes(canonical.text), "canonical payload bytes changed");
  assert.ok(payloadBlock.includes(RENDER_HASH), "bound payload hash disappeared");
  assert.equal(payloadBlock.includes("Runs <payload> & reports"), false, "gloss entered payload");
  assert.equal(request.payload_hash.value, RENDER_REQUEST.payload_hash.value);
  assert.deepEqual(RENDER_REQUEST.gloss, undefined, "attachment mutated the original request");
});

test("Telegram escapes a Codex gloss and preserves the canonical payload and hash", () => {
  const rendered = renderTelegram(codexRenderedRequest());
  const canonical = canonicalRender(RENDER_PAYLOAD, RENDER_REQUEST.class.value);

  assert.ok(
    rendered.claimedText.includes(
      `Runs &lt;payload&gt; &amp; reports its output. ${TELEGRAM_GLOSS_SUFFIX} <i>(model:codex/gpt-5.4-mini (requested))</i>`,
    ),
    rendered.claimedText,
  );
  assert.ok(rendered.claimedText.includes("Run &lt;payload&gt; &amp; report it"));
  assert.equal(rendered.claimedText.includes("Runs <payload>"), false, "raw gloss markup escaped");
  assert.equal(rendered.payloadText, canonical.text);
  assert.ok(rendered.payloadText?.includes(RENDER_HASH));
  assert.equal(rendered.payloadText?.includes("Runs <payload> & reports"), false);
  assert.equal(RENDER_REQUEST.payload_hash.value, RENDER_HASH);
});
