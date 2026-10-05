/**
 * Policy-configurable prompt layout (APRV-218).
 *
 * Three questions, in the order a reviewer should ask them:
 *
 * 1. **Does an absent block change anything?** It must not. Every existing
 *    rendering suite (`channels-telegram`, `channels-cli`, `channels-web`) is
 *    the byte-level proof and runs unchanged; what is pinned here is the reason
 *    those suites still pass — a policy with no `prompt` block, and a policy
 *    that did not load at all, both resolve to the layout the channel ships.
 * 2. **Does an invalid block fail closed?** A row name the runtime cannot
 *    place, a required row in `hide`, a row named by both `always` and `hide`,
 *    or a key the block does not define must each take the WHOLE policy down to
 *    all-`manual`, with a machine-readable keyword naming which.
 * 3. **Does a valid block reach the screen, without reaching what the approver
 *    signs?** Each channel is rendered under a custom layout; the canonical
 *    payload block and the computed/claimed split are checked to be beyond its
 *    reach.
 *
 * The requests are built through the real gate against a real log, as every
 * other channel suite here does: nothing writes a log line by hand.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { CliChannel, COMPUTED_MARKER, PAYLOAD_BEGIN } from "../src/channels/cli.js";
import type { ChannelRequest } from "../src/channels/contract.js";
import {
  renderTelegram,
  TELEGRAM_ANOMALY_MARK,
  TELEGRAM_CLAIMED_HEADING_PREFIX,
} from "../src/channels/telegram.js";
import { buildPendingQueue, type TagOptions } from "../src/channels/tagging.js";
import { renderWebRequest, WebChannel } from "../src/channels/web.js";
import { payloadHash } from "../src/core/payload.js";
import { loadPolicyText, type PolicyLoadResult } from "../src/core/policy-load.js";
import {
  applyPromptBlock,
  CLI_PROMPT_LAYOUT,
  DEFAULT_PROMPT_STYLE,
  isPromptRow,
  promptBlockErrors,
  promptLayoutFor,
  promptSayFor,
  promptStyleFor,
  sayEntryFor,
  PROMPT_ROWS,
  PROMPT_SAY_NOTES,
  PROMPT_STYLES,
  BUILTIN_CLASS_PHRASES,
  isReadableKindClass,
  PROMPT_BLOCK_ERROR_KEYWORDS,
  REQUIRED_PROMPT_ROWS,
  TELEGRAM_PROMPT_LAYOUT,
  WEB_PROMPT_LAYOUT,
  type PromptLayout,
} from "../src/core/prompt-layout.js";
import { register, request } from "./clock-adapters.js";
import { at, attest, newScenario, scratchRoot, T0, type Scenario } from "./scenario.js";

const scratch = scratchRoot("prompt-layout");
const open: WebChannel[] = [];
after(async () => {
  for (const channel of open) await channel.close();
  scratch.cleanup();
});

const TASK = "task-218";
const ACTOR = "agent:drafter";

/** A policy with `body` spliced into the fenced block, or none when omitted. */
function policyText(body: string[] = []): string {
  return [
    "# Policy",
    "",
    "```yaml approval-policy",
    'version: "0.1"',
    "defaults:",
    "  autonomy: manual",
    '  approval_ttl: "24h"',
    "  on_expiry: reject",
    "classes:",
    "  communicate.email.external:",
    "    autonomy: manual",
    "    limits:",
    "      per_action_usd: 1",
    "      daily_actions: 5",
    ...body,
    "```",
    "",
  ].join("\n");
}

function load(body: string[] = []): PolicyLoadResult {
  return loadPolicyText("/policy/APPROVAL.md", policyText(body));
}

// ---------------------------------------------------------------------------
// A live request, through the real gate
// ---------------------------------------------------------------------------

interface Live {
  unit: Scenario;
  key: string;
  request: ChannelRequest;
}

let fixtureCounter = 0;

function live(body: string[] = []): Live {
  fixtureCounter += 1;
  const unit = newScenario(scratch.root, policyText(body));
  attest(unit, T0);

  const key = `${TASK}:chaser-${fixtureCounter}`;
  const payload = {
    to: ["ap@vendor.example"],
    subject: "Invoice 41 chaser",
    body: "Following up on invoice 41.",
  };

  const registered = register(
    unit.logPath,
    {
      task: TASK,
      envelope: {
        origin: { app: "manual", created_by: ACTOR },
        state: "awaiting",
        actions: [
          {
            class: "communicate.email.external",
            idempotency_key: key,
            summary: "chase invoice 41",
            reversible: false,
            est_cost_usd: "0.02",
            payload_hash: payloadHash(payload),
          },
        ],
      },
    },
    T0,
    ACTOR,
    unit.options,
  );
  assert.equal(registered.ok, true, `registration failed: ${JSON.stringify(registered)}`);

  const requested = request(
    unit.logPath,
    {
      task: TASK,
      actionKey: key,
      cls: "communicate.email.external",
      est_cost_usd: "0.02",
      reversible: false,
      summary: "chase invoice 41",
    },
    at(1),
    ACTOR,
    unit.options,
  );
  assert.equal(requested.ok, true, `request failed: ${JSON.stringify(requested)}`);

  const tagOptions: TagOptions = {
    policy: { file: unit.policyPath },
    payload: (asked) => (asked === key ? payload : undefined),
  };
  const queue = buildPendingQueue(unit.logPath, tagOptions, at(2));
  assert.equal(queue.ok, true, `queue build failed: ${JSON.stringify(queue)}`);
  const only = queue.ok ? queue.requests[0] : undefined;
  assert.ok(only !== undefined, "the fixture produced no pending request");
  return { unit, key, request: only };
}

// ---------------------------------------------------------------------------
// 1. Absence changes nothing
// ---------------------------------------------------------------------------

test("with no prompt block every channel keeps the layout it ships (AC #2)", () => {
  const clean = load();
  assert.equal(clean.ok, true);
  assert.deepEqual(promptLayoutFor(clean, "telegram"), TELEGRAM_PROMPT_LAYOUT);
  assert.deepEqual(promptLayoutFor(clean, "cli"), CLI_PROMPT_LAYOUT);
  assert.deepEqual(promptLayoutFor(clean, "web"), WEB_PROMPT_LAYOUT);
});

test("a policy that did not load still yields the shipped layout: fail SOFT here", () => {
  // Fail-closed is about permission. A layout is not a permission, and an
  // unrelated typo in a class rule must not silently redecorate a screen — the
  // same argument `telegramDeliveryFor` and `telegramTokenEnvFor` make.
  const broken = loadPolicyText("/policy/APPROVAL.md", "# no fenced block here\n");
  assert.equal(broken.ok, false);
  assert.deepEqual(promptLayoutFor(broken, "telegram"), TELEGRAM_PROMPT_LAYOUT);
  assert.deepEqual(promptLayoutFor(broken, "web"), WEB_PROMPT_LAYOUT);
});

test("the Telegram default is the slimmed prompt APRV-143 and APRV-163 left", () => {
  const visible = TELEGRAM_PROMPT_LAYOUT.order.filter(
    (row) => TELEGRAM_PROMPT_LAYOUT.visibility[row] === "always",
  );
  assert.deepEqual(visible, [
    "class",
    "command_breakdown",
    "protected_path",
    "policy_diff",
    "policy_load",
    "waiting",
    "gloss",
    "summary",
    "est_cost_usd",
    "rationale",
    "confidence",
  ]);
  for (const row of ["autonomy", "budgets", "attestation"] as const) {
    assert.equal(TELEGRAM_PROMPT_LAYOUT.visibility[row], "abnormal", `${row} is not conditional`);
  }
  for (const row of ["task", "state", "chain", "provenance", "requested_ts", "ttl_remaining_ms", "payload_hash"] as const) {
    assert.equal(TELEGRAM_PROMPT_LAYOUT.visibility[row], "off", `${row} is on by default`);
  }
});

test("every row name is a ChannelRequest member, and fullPayload is not a row", () => {
  const world = live();
  const members = Object.keys(world.request as unknown as Record<string, unknown>);
  // The optional members: absent on an ordinary request by design, and each
  // one is rendered by its channel only when carried.
  const optional = new Set([
    "command_breakdown",
    "protected_path",
    "policy_diff",
    "policy_load",
    "token_delivery",
    "gloss",
    "rationale",
    "confidence",
  ]);
  for (const row of PROMPT_ROWS) {
    if (optional.has(row)) continue;
    assert.ok(members.includes(row), `row ${row} names no ChannelRequest member`);
  }
  assert.equal(isPromptRow("fullPayload"), false, "the canonical block is reachable as a row");
});

// ---------------------------------------------------------------------------
// 2. Invalidity fails closed (AC #1, AC #3)
// ---------------------------------------------------------------------------

/** The keywords of a failed load, or `[]` when the policy loaded. */
function keywordsOf(result: PolicyLoadResult): string[] {
  return result.ok ? [] : (result.errors ?? []).map((error) => error.keyword);
}

test("an unknown row name fails the policy load with a machine-readable code (AC #1)", () => {
  const result = load(["channels:", "  telegram:", "    prompt:", "      rows: [clas]"]);
  assert.equal(result.ok, false, "a policy naming an unknown row loaded");
  assert.equal(result.ok === false && result.code, "schema-invalid");
  // The typed channel is caught by the schema's closed enum.
  assert.ok(keywordsOf(result).length > 0, "the refusal named no keyword");
});

test("an unknown row under an UNTYPED channel name is caught too", () => {
  // `channels` admits unknown channel names as free-form objects on purpose, so
  // a third-party transport does not invalidate a whole policy. The semantic
  // pass is what keeps a prompt block under such a name from reaching a
  // renderer unchecked.
  const result = load(["channels:", "  matrix:", "    prompt:", "      hide: [wating]"]);
  assert.equal(result.ok, false);
  assert.deepEqual(keywordsOf(result), ["prompt-row-unknown"]);
});

test("hiding a row required for a decision fails the load (AC #3)", () => {
  for (const row of REQUIRED_PROMPT_ROWS) {
    const result = load(["channels:", "  matrix:", "    prompt:", `      hide: [${row}]`]);
    assert.equal(result.ok, false, `hiding ${row} loaded`);
    assert.deepEqual(keywordsOf(result), ["prompt-row-required"], `hiding ${row} named the wrong keyword`);
  }
});

test("a required row may be REORDERED, and a non-required one may be hidden", () => {
  const result = load([
    "channels:",
    "  telegram:",
    "    prompt:",
    "      rows: [waiting, class]",
    "      hide: [waiting]",
  ]);
  assert.equal(result.ok, true, `a legal layout was refused: ${JSON.stringify(result)}`);
});

test("naming one row in both always and hide is refused rather than resolved", () => {
  const result = load([
    "channels:",
    "  matrix:",
    "    prompt:",
    "      always: [budgets]",
    "      hide: [budgets]",
  ]);
  assert.equal(result.ok, false);
  assert.deepEqual(keywordsOf(result), ["prompt-row-conflict"]);
});

test("a key the prompt block does not define is refused", () => {
  const typed = load(["channels:", "  web:", "    prompt:", "      order: [class]"]);
  assert.equal(typed.ok, false, "an unknown prompt key loaded on a typed channel");
  const untyped = load(["channels:", "  matrix:", "    prompt:", "      order: [class]"]);
  assert.equal(untyped.ok, false);
  assert.deepEqual(keywordsOf(untyped), ["prompt-key-unknown"]);
});

test("a prompt block that is not an object is refused", () => {
  const result = load(["channels:", "  matrix:", "    prompt: everything"]);
  assert.equal(result.ok, false);
  assert.deepEqual(keywordsOf(result), ["prompt-block-shape"]);
});

test("promptBlockErrors is clean on a policy with no channels at all", () => {
  const clean = load();
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.ok ? promptBlockErrors(clean.policy) : ["not loaded"], []);
});

test("the schema's row enum and PROMPT_ROWS are the same closed list", () => {
  // Two closed lists say the same thing, deliberately: the schema is the write
  // boundary SPEC.md §8 wants the check at, and `PROMPT_ROWS` is what the
  // renderers switch on. Drift between them would be silent in the direction
  // that matters — a row the schema admits and no channel can place is exactly
  // the "rule its author believed was in force" a closed enum exists to stop.
  const schema = JSON.parse(
    readFileSync(join(fileURLToPath(new URL("../../", import.meta.url)), "schema/policy.schema.json"), "utf8"),
  ) as { $defs: Record<string, { enum?: string[]; properties?: Record<string, { description?: string }> }> };

  assert.deepEqual(schema.$defs["promptRow"]?.enum, [...PROMPT_ROWS]);

  // The required rows are named in the operator-facing text, not only in code:
  // a `hide` that refuses at load with no hint of which rows refuse is a
  // refusal an operator has to guess their way out of.
  const hideText = schema.$defs["promptLayout"]?.properties?.["hide"]?.description ?? "";
  for (const row of REQUIRED_PROMPT_ROWS) {
    assert.ok(hideText.includes(row), `the schema's hide description does not name ${row}`);
  }
});

test("a typed channel's unknown row is caught by the SCHEMA, before the semantic pass", () => {
  // Both nets return the same verdict, so an operator never has to know which
  // one caught them; this pins that the schema's own closed enum is one of the
  // two, rather than the semantic pass silently doing all the work.
  const result = load(["channels:", "  web:", "    prompt:", "      always: [clas]"]);
  assert.equal(result.ok, false);
  const keywords = keywordsOf(result);
  assert.ok(keywords.includes("enum"), keywords.join(","));
  assert.equal(keywords.includes("prompt-row-unknown"), false, "the semantic pass ran instead");
});

test("channels.cli exists only to carry a prompt block, and is closed", () => {
  const good = load(["channels:", "  cli:", "    prompt:", "      hide: [chain]"]);
  assert.equal(good.ok, true, `a legal channels.cli was refused: ${JSON.stringify(good)}`);

  const bad = load(["channels:", "  cli:", "    port: 4680"]);
  assert.equal(bad.ok, false, "channels.cli accepted a key it does not define");
});

// ---------------------------------------------------------------------------
// 3. A valid block reaches the screen — Telegram (AC #5)
// ---------------------------------------------------------------------------

/** The rendered rows of a Telegram prompt, as `label` strings in order. */
function telegramLabels(request_: ChannelRequest, layout: PromptLayout): string[] {
  return renderTelegram(request_, undefined, layout).lines.map((entry) => entry.label);
}

test("`always` turns on rows the Telegram default omits, in their default positions", () => {
  const world = live([
    "channels:",
    "  telegram:",
    "    prompt:",
    "      always: [task, ttl_remaining_ms, budgets]",
  ]);
  const layout = promptLayoutFor(load(["channels:", "  telegram:", "    prompt:", "      always: [task, ttl_remaining_ms, budgets]"]), "telegram");
  const labels = telegramLabels(world.request, layout);

  assert.ok(labels.includes("task"), labels.join(","));
  assert.ok(labels.includes("ttl"), labels.join(","));
  assert.ok(labels.includes("budgets"), labels.join(","));
  // Default order preserved: task above class, budgets above waiting, ttl below.
  assert.ok(labels.indexOf("task") < labels.indexOf("class"));
  assert.ok(labels.indexOf("budgets") < labels.indexOf("waiting"));
  assert.ok(labels.indexOf("waiting") < labels.indexOf("ttl"));

  // The anomaly mark is a statement about the VALUE, not about why the row is
  // on the screen: these budgets pass, so the forced-on row is unmarked.
  assert.equal(labels.includes(`${TELEGRAM_ANOMALY_MARK}budgets`), false, labels.join(","));
});

test("a forced-on row still SHOUTS when its value is the reason to look", () => {
  const world = live();
  const layout = applyPromptBlock(TELEGRAM_PROMPT_LAYOUT, { always: ["budgets"] });
  const failing: ChannelRequest = {
    ...world.request,
    budgets: {
      kind: "computed",
      source: "budgets",
      value: [
        {
          limit: "daily_usd",
          scope: "class",
          window: "rolling-24h",
          consumed: "9.99",
          requested: "0.02",
          remaining: "-0.01",
          pass: false,
        },
      ],
    },
  };
  assert.ok(telegramLabels(failing, layout).includes(`${TELEGRAM_ANOMALY_MARK}budgets`));
});

test("`hide` removes a Telegram row, and the canonical block is beyond its reach", () => {
  const world = live();
  const layout = applyPromptBlock(TELEGRAM_PROMPT_LAYOUT, { hide: ["waiting", "summary"] });
  const rendered = renderTelegram(world.request, undefined, layout);
  const labels = rendered.lines.map((entry) => entry.label);
  assert.equal(labels.includes("waiting"), false, labels.join(","));
  assert.equal(labels.includes("summary"), false, labels.join(","));
  assert.ok(labels.includes("class"), "a required row went missing");

  // The block, the action key and the claimed heading survive every layout.
  assert.ok(rendered.payloadText !== null, "the canonical block was suppressed");
  assert.match(rendered.payloadText, /payload sha256/u);
  assert.ok(rendered.header.includes(`<code>${world.key}</code>`), rendered.header);
  assert.ok(rendered.claimedText.startsWith(`<b>${TELEGRAM_CLAIMED_HEADING_PREFIX}`));
});

test("a claimed row reordered to the front stays under the CLAIMED heading (AC #4)", () => {
  const world = live();
  const layout = applyPromptBlock(TELEGRAM_PROMPT_LAYOUT, {
    rows: ["summary", "est_cost_usd", "class"],
  });
  const rendered = renderTelegram(world.request, undefined, layout);

  // The computed heading's block carries no claimed line...
  assert.equal(rendered.header.includes("<b>summary:</b>"), false, rendered.header);
  assert.equal(rendered.header.includes("<b>est. cost:</b>"), false, rendered.header);
  assert.ok(rendered.header.includes("<b>class:</b>"), rendered.header);
  // ...and the claimed segment carries no computed one.
  assert.ok(rendered.claimedText.includes("<b>summary:</b>"), rendered.claimedText);
  assert.equal(rendered.claimedText.includes("<b>class:</b>"), false, rendered.claimedText);

  // The ordering DID take effect inside the claimed region.
  const claimed = rendered.lines.filter((entry) => entry.kind === "claimed").map((e) => e.field);
  assert.deepEqual(claimed.slice(0, 2), ["summary", "est_cost_usd"]);
  const computed = rendered.lines.filter((entry) => entry.kind === "computed").map((e) => e.field);
  assert.equal(computed[0], "class");
});

// ---------------------------------------------------------------------------
// 3. A valid block reaches the screen — the CLI renderer (AC #5)
// ---------------------------------------------------------------------------

test("the CLI channel honours a layout, and keeps the payload block and required rows", async () => {
  const world = live();
  const chunks: string[] = [];
  const channel = new CliChannel({
    output: { write: (text) => chunks.push(text) },
    input: new PassThrough(),
    layout: applyPromptBlock(CLI_PROMPT_LAYOUT, {
      rows: ["class", "waiting"],
      hide: ["provenance", "chain", "requested_ts"],
    }),
  });
  await channel.notify(world.request);
  const text = chunks.join("");

  assert.equal(text.includes(`${COMPUTED_MARKER} provenance`), false, text);
  assert.equal(text.includes(`${COMPUTED_MARKER} chain`), false, text);
  assert.equal(text.includes(`${COMPUTED_MARKER} requested_ts`), false, text);
  assert.ok(text.includes(`${COMPUTED_MARKER} class`), text);
  assert.ok(text.includes(PAYLOAD_BEGIN), "the canonical block was suppressed");

  const fields = channel.lastRendered()[0]?.fields.map((field) => field.field) ?? [];
  assert.deepEqual(fields.slice(0, 2), ["class", "waiting"], fields.join(","));
  assert.ok(fields.includes("action_key"), "a required row went missing");
  assert.equal(fields.includes("provenance"), false, fields.join(","));
});

// ---------------------------------------------------------------------------
// 3. A valid block reaches the screen — the web page (AC #5)
// ---------------------------------------------------------------------------

test("the web page honours a layout, computed and claimed stay apart", async () => {
  const world = live();
  const layout = applyPromptBlock(WEB_PROMPT_LAYOUT, {
    rows: ["summary", "class"],
    hide: ["chain", "provenance"],
  });

  const rendering = renderWebRequest(world.request, layout);
  assert.equal(rendering.computed[0]?.field, "class", "the reorder did not reach the page");
  assert.equal(rendering.claimed[0]?.field, "summary");
  assert.equal(
    rendering.computed.some((line) => line.field === "chain" || line.field === "provenance"),
    false,
  );
  assert.ok(rendering.payloadText !== null, "the canonical block was suppressed");

  const channel = new WebChannel({ port: 0, refresh: () => [world.request], layout });
  open.push(channel);
  const address = await channel.start();
  const page = await (await fetch(`http://127.0.0.1:${String(address.port)}/`)).text();
  assert.ok(page.includes(world.key), "the page did not render the request");
  assert.equal(page.includes(">chain<"), false, "a hidden row reached the served page");
  assert.ok(page.includes(PAYLOAD_BEGIN), "the canonical block was suppressed on the page");
});

// ---------------------------------------------------------------------------
// The prompt style and the say declarations (APRV-489)
// ---------------------------------------------------------------------------

const VILLAGE_SAY = [
  "      say:",
  "        intent.publish.inferred.index:",
  '          does: "post a wish to Index, the village matching service, in your name"',
  '          quote: { text: "" }',
  "          note: none",
  "        digest.share:",
  '          does: "share a note about you"',
  '          quote: { scope: "Shared with", expires_at: "Until", text: "Note", digest_id: ~ }',
  "          note: none",
  "        intent.publish.stated.index:",
  '          does: "post something you said to Index in your name"',
  '          quote: { text: "" }',
];

test("an absent style is technical, on every channel, and a failed load is technical too (AC #1)", () => {
  const clean = load();
  assert.equal(clean.ok, true);
  for (const channel of ["telegram", "web", "cli", "matrix"]) {
    assert.equal(promptStyleFor(clean, channel), "technical", channel);
    assert.deepEqual(promptSayFor(clean, channel), {}, channel);
  }
  const broken = load(["channels:", "  telegram:", "    prompt:", "      style: minimal", "      rows: [clas]"]);
  assert.equal(broken.ok, false);
  assert.equal(promptStyleFor(broken, "telegram"), "technical", "a policy that did not load drew a minimal card");
  assert.equal(DEFAULT_PROMPT_STYLE, "technical");
});

test("style minimal and a say map load under channels.telegram.prompt and resolve", () => {
  const result = load(["channels:", "  telegram:", "    prompt:", "      always: [ttl_remaining_ms]", "      style: minimal", ...VILLAGE_SAY]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(promptStyleFor(result, "telegram"), "minimal");
  const say = promptSayFor(result, "telegram");
  assert.deepEqual(say["digest.share"], {
    does: "share a note about you",
    quote: { scope: "Shared with", expires_at: "Until", text: "Note", digest_id: null },
    note: "none",
  });
  // The layout is untouched by the new keys: the ttl row is still forced on.
  assert.equal(promptLayoutFor(result, "telegram").visibility.ttl_remaining_ms, "always");
});

test("a say entry names exactly one class: no pattern can rename several (fix round 2, S6)", () => {
  const result = load(["channels:", "  telegram:", "    prompt:", "      style: minimal", ...VILLAGE_SAY]);
  assert.equal(result.ok, true, JSON.stringify(result));
  const say = promptSayFor(result, "telegram");
  assert.equal(sayEntryFor(say, "intent.publish.inferred.index")?.pattern, "intent.publish.inferred.index");
  assert.equal(sayEntryFor(say, "intent.publish.stated.index")?.pattern, "intent.publish.stated.index");
  assert.equal(sayEntryFor(say, "intent.publish.other"), null, "an exact key matched another class");
  assert.equal(sayEntryFor(say, "village.vote"), null);
  for (const pattern of ["files.*", "*", "files.*.out"]) {
    const lines = ["      say:", `        "${pattern}": { does: "tidy up a little", quote: { text: "" } }`];
    const typed = load(["channels:", "  telegram:", "    prompt:", ...lines]);
    assert.equal(typed.ok, false, `${pattern} loaded on telegram`);
    const untyped = load(["channels:", "  matrix:", "    prompt:", ...lines]);
    assert.deepEqual(keywordsOf(untyped), ["prompt-say-wildcard"], pattern);
  }
});

test("say mistakes that would load silently are load errors (fix round 2, S6)", () => {
  const cases: [string, string[], string][] = [
    ["quote shows nothing", ["      say:", "        digest.share: { does: share, quote: { digest_id: ~ } }"], "prompt-say-shape"],
    ["empty quote", ["      say:", "        digest.share: { does: share, quote: {} }"], "prompt-say-shape"],
    ["does carries the notice mark", ["      say:", '        digest.share: { does: "⚠ share now", quote: { text: Note } }'], "prompt-say-does"],
    ["label carries the notice mark", ["      say:", '        digest.share: { does: share, quote: { text: "⚠ There is more than fits here" } }'], "prompt-say-label"],
  ];
  for (const [label, lines, keyword] of cases) {
    const typed = load(["channels:", "  telegram:", "    prompt:", ...lines]);
    assert.equal(typed.ok, false, `${label}: loaded on telegram`);
    const untyped = load(["channels:", "  matrix:", "    prompt:", ...lines]);
    assert.deepEqual([...new Set(keywordsOf(untyped))], [keyword], label);
  }
});

test("style is IGNORED on web and cli: it loads and they stay technical (documented rule)", () => {
  const result = load(["channels:", "  web:", "    prompt:", "      style: minimal", "  cli:", "    prompt:", "      style: minimal"]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(promptStyleFor(result, "web"), "technical");
  assert.equal(promptStyleFor(result, "cli"), "technical");
  // ...and the row layout those channels draw is the one they ship.
  assert.deepEqual(promptLayoutFor(result, "web"), WEB_PROMPT_LAYOUT);
  assert.deepEqual(promptLayoutFor(result, "cli"), CLI_PROMPT_LAYOUT);
});

test("an unknown style fails the load: by the schema on telegram, by keyword elsewhere", () => {
  const typed = load(["channels:", "  telegram:", "    prompt:", "      style: compact"]);
  assert.equal(typed.ok, false, "an unknown style loaded");
  assert.equal(typed.ok === false && typed.code, "schema-invalid");
  assert.ok(keywordsOf(typed).includes("enum"), keywordsOf(typed).join(","));
  const untyped = load(["channels:", "  matrix:", "    prompt:", "      style: compact"]);
  assert.equal(untyped.ok, false);
  assert.deepEqual(keywordsOf(untyped), ["prompt-style-unknown"]);
});

test("a malformed say fails the load, with prompt-say-shape on an untyped channel", () => {
  const cases: [string, string[]][] = [
    ["say is a list", ["      say: [a]"]],
    // (fix round 3: each case may now carry the more precise say keyword)
    ["bad class pattern", ["      say:", "        Digest.Share: { does: share }"]],
    ["missing does", ["      say:", "        digest.share: { quote: { text: Note } }"]],
    ["empty does", ["      say:", '        digest.share: { does: "" }']],
    ["does too long", ["      say:", `        digest.share: { does: "${"x".repeat(121)}" }`]],
    ["does with a bidi override", ["      say:", '        digest.share: { does: "share \\u202Etxt" }']],
    ["does on two lines", ["      say:", '        digest.share: { does: "share\\nall" }']],
    ["label too long", ["      say:", `        digest.share: { does: share, quote: { text: "${"y".repeat(41)}" } }`]],
    ["label is a number", ["      say:", "        digest.share: { does: share, quote: { text: 3 } }"]],
    ["unknown note", ["      say:", "        digest.share: { does: share, note: always }"]],
    ["unknown entry key", ["      say:", "        digest.share: { does: share, show: all }"]],
  ];
  for (const [label, lines] of cases) {
    const typed = load(["channels:", "  telegram:", "    prompt:", ...lines]);
    assert.equal(typed.ok, false, `${label}: loaded on telegram`);
    const untyped = load(["channels:", "  matrix:", "    prompt:", ...lines]);
    assert.equal(untyped.ok, false, `${label}: loaded on an untyped channel`);
    assert.ok(
      keywordsOf(untyped).length > 0 &&
        keywordsOf(untyped).every((keyword) =>
          ["prompt-say-shape", "prompt-say-does", "prompt-say-label"].includes(keyword),
        ),
      `${label}: ${keywordsOf(untyped).join(",")}`,
    );
  }
});

test("the schema's style enum is PROMPT_STYLES, and the new keys sit in the shared prompt block", () => {
  const schema = JSON.parse(
    readFileSync(join(fileURLToPath(new URL("../../", import.meta.url)), "schema/policy.schema.json"), "utf8"),
  ) as { $defs: Record<string, { properties?: Record<string, { enum?: string[] }> }> };
  assert.deepEqual(schema.$defs["promptLayout"]?.properties?.["style"]?.enum, [...PROMPT_STYLES]);
  assert.ok(schema.$defs["promptLayout"]?.properties?.["say"] !== undefined);
  assert.deepEqual(Object.keys(schema.$defs["promptSay"]?.properties ?? {}).sort(), ["does", "note", "quote"]);
  assert.deepEqual([...PROMPT_SAY_NOTES], ["summary", "none"]);
});

// ---------------------------------------------------------------------------
// Fix round 3: built-in phrases win, and operator text cannot pass for the runtime's
// ---------------------------------------------------------------------------

test("R2-S2: a say entry may not set does for a class core phrases itself; quote and note still load", () => {
  const refused = load(["channels:", "  matrix:", "    prompt:", "      say:", '        network.call: { does: "tidy up a little", quote: { tool: Tool, input: Input } }']);
  assert.deepEqual(keywordsOf(refused), ["prompt-say-builtin"]);
  const typed = load(["channels:", "  telegram:", "    prompt:", "      say:", '        files.delete.scratch: { does: "tidy up a little" }']);
  assert.equal(typed.ok, false);
  const quoteOnly = load(["channels:", "  telegram:", "    prompt:", "      style: minimal", "      say:", "        message.send: { quote: { tool: Tool, input: Input } }"]);
  assert.equal(quoteOnly.ok, true, JSON.stringify(quoteOnly));
  assert.equal(promptSayFor(quoteOnly, "telegram")["message.send"]?.does, undefined);
  const noDoes = load(["channels:", "  matrix:", "    prompt:", "      say:", "        digest.share: { quote: { text: Note } }"]);
  assert.deepEqual(keywordsOf(noDoes), ["prompt-say-does"]);
  assert.equal(BUILTIN_CLASS_PHRASES["network.call"], "contact a website or online service");
});

test("R2-S3: does is a plain verb phrase and labels are plain words, so neither can imitate the runtime's notices", () => {
  const badDoes = [
    "vote. There is no time limit",
    "share it! now",
    "share: Not shown here",
    "❗ share now",
    "- share now",
    "share <b>now</b>",
    "share & send",
    "share now?",
  ];
  for (const does of badDoes) {
    const result = load(["channels:", "  matrix:", "    prompt:", "      say:", `        digest.share: { does: ${JSON.stringify(does)}, quote: { text: Note } }`]);
    assert.deepEqual(keywordsOf(result), ["prompt-say-does"], does);
  }
  const badLabels = ["❗Answer", "Answer:", "Not shown here.", "a".repeat(25), "Shared_with"];
  for (const label of badLabels) {
    const result = load(["channels:", "  matrix:", "    prompt:", "      say:", `        digest.share: { does: share, quote: { text: ${JSON.stringify(label)} } }`]);
    assert.deepEqual(keywordsOf(result), ["prompt-say-label"], label);
  }
  // The village's own words load.
  const village = load(["channels:", "  telegram:", "    prompt:", "      style: minimal", "      say:",
    "        intent.publish.inferred.index:",
    '          does: "post a wish it guessed from your chats to Index, the village matching service, in your name"',
    '          quote: { text: "" }',
    "        village.vote:",
    '          does: "vote for you in this week\'s village question"',
    '          quote: { answer: "Answer", question_id: "Question" }',
  ]);
  assert.equal(village.ok, true, JSON.stringify(village));
});

test("R2-B2: an empty label is allowed only when it is the only field quoted", () => {
  const alone = load(["channels:", "  telegram:", "    prompt:", "      say:", '        digest.share: { does: share, quote: { text: "", digest_id: ~ } }']);
  assert.equal(alone.ok, true, JSON.stringify(alone));
  const two = load(["channels:", "  matrix:", "    prompt:", "      say:", '        digest.share: { does: share, quote: { text: "", scope: Scope } }']);
  assert.deepEqual(keywordsOf(two), ["prompt-say-label"]);
});

// ---------------------------------------------------------------------------
// Fix round 4: a does over a payload core reads itself is refused at load
// ---------------------------------------------------------------------------

test("R3-S1: a say entry may not set does for a class the command classifier emits; quote and note still load", () => {
  const cases: [string, string][] = [
    ["files.delete.out_of_scope", "tidy up a little"],
    ["vcs.push.main", "save your work"],
    ["harness.launch.codex", "ask a friend for help"],
  ];
  for (const [cls, does] of cases) {
    assert.equal(isReadableKindClass(cls), true, cls);
    const untyped = load(["channels:", "  matrix:", "    prompt:", "      say:", `        ${cls}: { does: ${JSON.stringify(does)} }`]);
    assert.deepEqual(keywordsOf(untyped), ["prompt-say-kind"], cls);
    const typed = load(["channels:", "  telegram:", "    prompt:", "      style: minimal", "      say:", `        ${cls}: { does: ${JSON.stringify(does)} }`]);
    assert.equal(typed.ok, false, `${cls}: a mild phrase over a classifier class loaded`);
  }
  // Without does, such an entry loads (no prompt-say-does), and nothing in it can set the phrase.
  const noDoes = load(["channels:", "  telegram:", "    prompt:", "      style: minimal", "      say:", "        files.delete.out_of_scope: { note: none }"]);
  assert.equal(noDoes.ok, true, JSON.stringify(noDoes));
  assert.deepEqual(promptSayFor(noDoes, "telegram")["files.delete.out_of_scope"], { note: "none" });
  // Core's own classes keep their own keyword; the village's classes are not classifier classes.
  assert.equal(isReadableKindClass("network.call"), false);
  for (const cls of ["intent.publish.inferred.index", "intent.publish.stated.index", "digest.share", "village.vote"]) {
    assert.equal(isReadableKindClass(cls), false, cls);
  }
  assert.ok((PROMPT_BLOCK_ERROR_KEYWORDS as readonly string[]).includes("prompt-say-kind"));
});
