/**
 * The AgentMail adapter (APRV-222).
 *
 * Same discipline as every other suite here: nothing hand-writes a log line.
 * The policy is attested through `core/attest.ts`, the task is registered and
 * requested through `core/gate.ts`, the grant is a real human decision, and the
 * token under test is the one that grant printed. Every HTTP call goes to the
 * loopback mock in `agentmail-mock.ts`, whose `assertLocal` is called on every
 * `apiBase` this file builds an adapter with.
 *
 * The two claims worth stating up front, because most of the file exists to
 * prove them:
 *
 * 1. **A refusal before the send sent nothing.** Not "returned ok: false" —
 *    sent nothing. Every such test asserts the mock saw no POST at all.
 * 2. **The API key never leaves.** The mock serves an error body with the key
 *    planted inside it, and the suite sweeps every string it captured, every
 *    log it wrote, and every field of every result.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";

import {
  AGENTMAIL_CLASS,
  AGENTMAIL_CREDENTIAL_SPECS,
  AGENTMAIL_DEFAULT_API_BASE,
  AGENTMAIL_DEFAULT_TIMEOUT_MS,
  AGENTMAIL_DRAFT_FIELDS,
  AGENTMAIL_FAILURE_CODES,
  DEFAULT_AGENTMAIL_CREDENTIAL_NAMES,
  agentmailAdapter,
  agentmailMode,
  draftDrift,
  isAgentmailFailureCode,
  probeAgentmail,
  readAgentmailConfig,
  requiredAgentmailCredentials,
  validateAgentmailDraftPayload,
  type AgentmailDraftPayload,
  type AgentmailFetch,
} from "../src/adapters/agentmail.js";
import {
  CREDENTIAL_REFUSAL_CODES,
  executeThroughAdapter,
  inMemoryCredentials,
  type Adapter,
  type AdapterExecuteOptions,
  type AdapterExecuteResult,
  type JsonValue,
} from "../src/adapters/contract.js";
import type { EmailPayload } from "../src/adapters/email.js";
import { payloadHash } from "../src/core/payload.js";
import { decide, register, request } from "./clock-adapters.js";
import { assertLocal, startMockAgentmail, type MockAgentmail } from "./agentmail-mock.js";
import { at, attest, fixedClock, newScenario, scratchRoot, T0 } from "./scenario.js";

const scratch = scratchRoot("adapter-agentmail");

const TASK = "task-222";
const AGENT = "agent:sender";
const HUMAN = "human:carter";
/** Distinctive enough to hunt for in a log file, a JSON blob and a message. */
const API_KEY = "am-key-aprv222-7c41de-DO-NOT-USE";
const INBOX_ID = "chaser@agentmail.invalid";

/** Everything this suite captured. Swept for the key in `after`. */
const transcript: string[] = [];
/** Every log this suite wrote. Swept too. */
const logs: string[] = [];

function record(value: unknown): void {
  transcript.push(typeof value === "string" ? value : JSON.stringify(value));
}

const POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "1h"',
  "  on_expiry: reject",
  "classes:",
  "  communicate.email.external:",
  "    autonomy: manual",
  "  financial.spend:",
  "    autonomy: manual",
  "```",
  "",
].join("\n");

const mock: MockAgentmail = await startMockAgentmail({ apiKey: API_KEY, inboxId: INBOX_ID });

after(async () => {
  await mock.close();

  const said = transcript.join("\n");
  assert.equal(
    said.includes(API_KEY),
    false,
    "the API key appeared in something this suite captured (SPEC.md §11.1 invariant 3)",
  );
  for (const logPath of logs) {
    const raw = readFileSync(logPath, "utf8");
    assert.equal(raw.includes(API_KEY), false, `the API key reached ${logPath}`);
  }
  scratch.cleanup();
});

// ---------------------------------------------------------------------------
// The scenario: a real grant over the bytes under test
// ---------------------------------------------------------------------------

interface Case {
  logPath: string;
  actionKey: string;
  payload: JsonValue;
  token: string;
  options: AdapterExecuteOptions;
}

let counter = 0;

function directPayload(overrides: Partial<EmailPayload> = {}): JsonValue {
  counter += 1;
  return {
    from: INBOX_ID,
    to: ["agency@vendor.invalid"],
    cc: ["records@approval.invalid"],
    subject: `Deposit chaser ${String(counter)}`,
    body: "Following up on the deposit. No reply since 21 July.\n",
    ...overrides,
  } as unknown as JsonValue;
}

function draftPayload(overrides: Partial<AgentmailDraftPayload> = {}): AgentmailDraftPayload {
  counter += 1;
  return {
    inbox_id: INBOX_ID,
    draft_id: `dft_${String(counter)}`,
    to: ["agency@vendor.invalid"],
    cc: ["records@approval.invalid"],
    bcc: ["archive@approval.invalid"],
    subject: `Deposit chaser ${String(counter)}`,
    text: "Following up on the deposit. No reply since 21 July.\n",
    ...overrides,
  };
}

/** The draft body the mock should hold for a payload that must NOT drift. */
function draftBodyOf(payload: AgentmailDraftPayload): Record<string, unknown> {
  return {
    to: payload.to,
    cc: payload.cc ?? null,
    bcc: payload.bcc ?? null,
    subject: payload.subject,
    text: payload.text,
  };
}

/** A fresh log holding one granted, unspent manual action, built through the gate. */
function granted(payload: JsonValue, cls: string = AGENTMAIL_CLASS): Case {
  const unit = newScenario(scratch.root, POLICY);
  attest(unit, T0);
  logs.push(unit.logPath);

  counter += 1;
  const actionKey = `${TASK}:send-${String(counter)}:2026-09-02`;

  const registered = register(
    unit.logPath,
    {
      task: TASK,
      envelope: {
        origin: { app: "manual", created_by: AGENT },
        state: "awaiting",
        actions: [
          {
            class: cls,
            idempotency_key: actionKey,
            summary: `chase deposit ${String(counter)}`,
            reversible: false,
            est_cost_usd: "0.02",
            payload_hash: payloadHash(payload),
          },
        ],
      },
    },
    T0,
    AGENT,
    unit.options,
  );
  assert.equal(registered.ok, true, `registration failed: ${JSON.stringify(registered)}`);

  const requested = request(
    unit.logPath,
    {
      task: TASK,
      actionKey,
      cls,
      est_cost_usd: "0.02",
      reversible: false,
      summary: `chase deposit ${String(counter)}`,
    },
    at(1),
    AGENT,
    unit.options,
  );
  assert.equal(requested.ok, true, `request failed: ${JSON.stringify(requested)}`);

  const decided = decide(unit.logPath, actionKey, "grant", HUMAN, at(2), unit.options);
  assert.equal(decided.ok, true, `grant failed: ${JSON.stringify(decided)}`);
  if (!decided.ok || decided.token === undefined) throw new Error("expected a token");

  return {
    logPath: unit.logPath,
    actionKey,
    payload,
    token: decided.token,
    options: { policy: { file: unit.policyPath }, clock: fixedClock(at(3)) },
  };
}

function adapterFor(extra: Parameters<typeof agentmailAdapter>[0] = {}): Adapter {
  return agentmailAdapter({
    apiBase: assertLocal(mock.url),
    timeoutMs: 5_000,
    ...extra,
  });
}

const CREDENTIALS = inMemoryCredentials({
  [DEFAULT_AGENTMAIL_CREDENTIAL_NAMES.apiKey]: API_KEY,
  [DEFAULT_AGENTMAIL_CREDENTIAL_NAMES.inboxId]: INBOX_ID,
});

async function run(
  unit: Case,
  adapter: Adapter = adapterFor(),
  overrides: Partial<AdapterExecuteOptions> = {},
): Promise<AdapterExecuteResult> {
  const result = await executeThroughAdapter(
    adapter,
    { logPath: unit.logPath, actionKey: unit.actionKey, payload: unit.payload, actor: AGENT },
    { ...unit.options, token: unit.token, credentials: CREDENTIALS, ...overrides },
  );
  record(result);
  return result;
}

/** How many POSTs the mock has seen. The "nothing was sent" measurement. */
function postCount(): number {
  return mock.posts().length;
}

function eventsOf(logPath: string): string[] {
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as { event: string }).event);
}

function refusal(result: AdapterExecuteResult): {
  code: string;
  adapter_code?: string;
  message: string;
  outcome?: string;
} {
  assert.equal(result.ok, false, `expected a refusal, got ${JSON.stringify(result)}`);
  if (result.ok) throw new Error("unreachable");
  return {
    code: result.code,
    ...(result.adapter_code === undefined ? {} : { adapter_code: result.adapter_code }),
    message: result.message,
    ...(result.outcome === undefined ? {} : { outcome: result.outcome }),
  };
}

// ---------------------------------------------------------------------------
// 1. The happy paths
// ---------------------------------------------------------------------------

test("a granted direct send posts exactly the approved message and returns a receipt", async () => {
  const payload = directPayload();
  const unit = granted(payload);
  const before = mock.sentMessages().length;

  const result = await run(unit);
  assert.equal(result.ok, true, `the granted send was refused: ${JSON.stringify(result)}`);

  const sent = mock.sentMessages();
  assert.equal(sent.length, before + 1, "the send did not reach the API exactly once");
  const body = sent[sent.length - 1] as Record<string, unknown>;
  const approved = payload as unknown as EmailPayload;
  assert.deepEqual(body["to"], approved.to);
  assert.deepEqual(body["cc"], approved.cc);
  assert.equal(body["subject"], approved.subject);
  assert.equal(body["text"], approved.body);
  assert.equal("from" in body, false, "AgentMail has no per-message From; one was sent anyway");
  assert.equal("html" in body, false, "a text/plain body was sent as html");

  // The bearer header carried the key, and only the header did.
  const post = mock.requestsFor("message-send").at(-1);
  assert.equal(post?.authorization, `Bearer ${API_KEY}`);
  assert.equal(post?.raw.includes(API_KEY), false, "the key was in the request body");

  if (result.ok) {
    assert.deepEqual(result.detail, {
      mode: "direct",
      message_id: (result.detail as Record<string, JsonValue>)["message_id"],
      thread_id: (result.detail as Record<string, JsonValue>)["thread_id"],
      payload_hash: payloadHash(payload),
      recipients: 2,
      http_status: 200,
    });
    assert.match(String((result.detail as Record<string, JsonValue>)["message_id"]), /^msg_/u);
  }
  assert.deepEqual(eventsOf(unit.logPath).slice(-2), [
    "execution.started",
    "execution.completed",
  ]);
});

test("a text/html direct send puts the body in html and not in text", async () => {
  const payload = directPayload({ content_type: "text/html", body: "<p>Chaser</p>" });
  const unit = granted(payload);
  const result = await run(unit);
  assert.equal(result.ok, true, JSON.stringify(result));

  const body = mock.sentMessages().at(-1) as Record<string, unknown>;
  assert.equal(body["html"], "<p>Chaser</p>");
  assert.equal("text" in body, false, "an html message was also sent as text");
});

test("a granted draft send re-reads the draft, finds no drift, and sends it once", async () => {
  const payload = draftPayload();
  mock.setDraft(payload.draft_id, draftBodyOf(payload));
  const unit = granted(payload as unknown as JsonValue);

  const result = await run(unit);
  assert.equal(result.ok, true, `the granted draft send was refused: ${JSON.stringify(result)}`);

  assert.deepEqual(mock.sentDrafts().slice(-1), [payload.draft_id]);
  assert.equal(
    mock.requestsFor("draft").filter((entry) => entry.path.includes(payload.draft_id)).length,
    1,
    "the draft was not re-read exactly once before the send",
  );
  if (result.ok) {
    const detail = result.detail as Record<string, JsonValue>;
    assert.equal(detail["mode"], "draft");
    assert.equal(detail["payload_hash"], payloadHash(payload as unknown as JsonValue));
    assert.equal(detail["recipients"], 3);
    assert.equal(detail["http_status"], 200);
    assert.match(String(detail["thread_id"]), /^thr_/u);
  }
  assert.deepEqual(eventsOf(unit.logPath).slice(-2), ["execution.started", "execution.completed"]);
});

// ---------------------------------------------------------------------------
// 2. Drift: the whole point of the draft mode
// ---------------------------------------------------------------------------

/**
 * One drifted value per field. Every one carries {@link NEEDLE}, which occurs
 * in no sentence this adapter can write, so "the refusal did not quote the
 * unapproved content" is a single exact assertion rather than a word hunt.
 */
const NEEDLE = "zqx-unapproved-9f4";
const DRIFTED: Record<(typeof AGENTMAIL_DRAFT_FIELDS)[number], unknown> = {
  to: [`${NEEDLE}-to@vendor.invalid`],
  cc: [`${NEEDLE}-cc@vendor.invalid`],
  bcc: [`${NEEDLE}-bcc@vendor.invalid`],
  subject: `${NEEDLE} subject`,
  text: `${NEEDLE} body`,
};

for (const field of AGENTMAIL_DRAFT_FIELDS) {
  test(`a draft whose ${field} changed after the grant refuses and sends nothing`, async () => {
    const payload = draftPayload();
    mock.setDraft(payload.draft_id, { ...draftBodyOf(payload), [field]: DRIFTED[field] });
    const unit = granted(payload as unknown as JsonValue);

    const posts = postCount();
    const result = await run(unit);
    const refused = refusal(result);
    assert.equal(refused.code, "adapter-failed");
    assert.equal(refused.adapter_code, "agentmail-draft-drifted");
    assert.equal(refused.outcome, "execution.failed");
    assert.match(refused.message, new RegExp(`\\b${field}\\b`, "u"), "the field was not named");
    assert.equal(postCount(), posts, "a drifted draft was sent anyway");

    // The message names the field and never the value: a refusal is not a
    // channel for publishing text nobody approved.
    assert.equal(
      JSON.stringify(result).includes(NEEDLE),
      false,
      `the drift refusal quoted the unapproved ${field}: ${refused.message}`,
    );
  });
}

test("an absent cc and an empty cc are the same fact, and neither is drift", async () => {
  const payload = draftPayload();
  delete payload.cc;
  mock.setDraft(payload.draft_id, { ...draftBodyOf(payload), cc: [] });
  const unit = granted(payload as unknown as JsonValue);
  const result = await run(unit);
  assert.equal(result.ok, true, `an empty cc was read as drift: ${JSON.stringify(result)}`);
});

test("a reordered recipient list is drift", () => {
  const payload = draftPayload({ to: ["a@vendor.invalid", "b@vendor.invalid"] });
  const drift = draftDrift(payload, {
    ...draftBodyOf(payload),
    to: ["b@vendor.invalid", "a@vendor.invalid"],
  });
  assert.deepEqual(drift, ["to"]);
});

test("a draft that no longer exists refuses agentmail-draft-missing without sending", async () => {
  const payload = draftPayload();
  mock.setDraft(payload.draft_id, draftBodyOf(payload));
  mock.deleteDraft(payload.draft_id);
  const unit = granted(payload as unknown as JsonValue);

  const posts = postCount();
  const refused = refusal(await run(unit));
  assert.equal(refused.adapter_code, "agentmail-draft-missing");
  assert.equal(refused.outcome, "execution.failed");
  assert.equal(postCount(), posts, "a missing draft produced a send");
});

test("a draft payload naming another inbox refuses before any request is made", async () => {
  const payload = draftPayload({ inbox_id: "someone-else@agentmail.invalid" });
  const unit = granted(payload as unknown as JsonValue);

  const before = mock.requests.length;
  const refused = refusal(await run(unit));
  assert.equal(refused.adapter_code, "agentmail-inbox-mismatch");
  assert.equal(mock.requests.length, before, "an inbox mismatch reached the API at all");
});

test("a draft that does not read back as an object refuses rather than sending", async () => {
  const payload = draftPayload();
  mock.setDraft(payload.draft_id, draftBodyOf(payload));
  const unit = granted(payload as unknown as JsonValue);
  mock.fail({ status: 200, body: "not json at all" }, "draft");

  const posts = postCount();
  const refused = refusal(await run(unit));
  mock.fail(null, "draft");
  assert.equal(refused.adapter_code, "agentmail-draft-drifted");
  assert.equal(postCount(), posts, "an unreadable draft was sent anyway");
});

// ---------------------------------------------------------------------------
// 3. `from`, and the inbox read that checks it
// ---------------------------------------------------------------------------

test("a direct send whose from is not the inbox address refuses and sends nothing", async () => {
  const payload = directPayload({ from: "someone-else@approval.invalid" });
  const unit = granted(payload);

  const posts = postCount();
  const refused = refusal(await run(unit));
  assert.equal(refused.adapter_code, "agentmail-from-mismatch");
  assert.equal(refused.outcome, "execution.failed");
  assert.equal(postCount(), posts, "a mismatched From was sent anyway");
  assert.match(refused.message, /someone-else@approval\.invalid/u);
  // The inbox read happened: the check is not a guess.
  assert.ok(mock.requestsFor("inbox").length > 0);
});

test("the from check is case-insensitive and reads the inbox's own address field", async () => {
  mock.setInbox({ inbox_id: INBOX_ID, address: "Chaser@AgentMail.invalid" });
  const payload = directPayload({ from: "CHASER@agentmail.invalid" });
  const unit = granted(payload);
  const result = await run(unit);
  mock.setInbox({ inbox_id: INBOX_ID, address: INBOX_ID });
  assert.equal(result.ok, true, `a case difference was read as a mismatch: ${JSON.stringify(result)}`);
});

// ---------------------------------------------------------------------------
// 4. Payload shape
// ---------------------------------------------------------------------------

test("a payload carrying both modes' keys is ambiguous and refused", async () => {
  const payload = {
    inbox_id: INBOX_ID,
    draft_id: "dft_ambiguous",
    from: INBOX_ID,
    to: ["agency@vendor.invalid"],
    subject: "which one",
    body: "a body",
    text: "and a text",
  } as unknown as JsonValue;
  const unit = granted(payload);

  const before = mock.requests.length;
  const refused = refusal(await run(unit));
  assert.equal(refused.adapter_code, "agentmail-payload-ambiguous");
  assert.equal(mock.requests.length, before, "an ambiguous payload reached the API");
});

test("a payload in neither mode is refused before the vault is read", async () => {
  const payload = { to: ["agency@vendor.invalid"], subject: "no mode" } as unknown as JsonValue;
  const unit = granted(payload);
  const refused = refusal(await run(unit));
  assert.equal(refused.adapter_code, "agentmail-payload-invalid");
});

test("a draft payload with an unknown key is refused rather than silently trimmed", async () => {
  const payload = {
    ...draftPayload(),
    attachments: ["contract.pdf"],
  } as unknown as JsonValue;
  const unit = granted(payload);
  const refused = refusal(await run(unit));
  assert.equal(refused.adapter_code, "agentmail-payload-invalid");
  assert.match(refused.message, /attachments/u);
});

test("a direct payload with a display-name From is refused by the email validator", async () => {
  const payload = directPayload({ from: '"Carter" <carter@approval.invalid>' });
  const unit = granted(payload);
  const refused = refusal(await run(unit));
  assert.equal(refused.adapter_code, "agentmail-payload-invalid");
});

test("agentmailMode and validateAgentmailDraftPayload state their own rules", () => {
  assert.deepEqual(agentmailMode([] as unknown as JsonValue), {
    ok: false,
    code: "agentmail-payload-invalid",
    message: "the payload must be a JSON object",
  });
  const draft = draftPayload();
  const validated = validateAgentmailDraftPayload(draft as unknown as JsonValue);
  assert.equal(validated.ok, true);
  if (validated.ok) assert.deepEqual(validated.payload, draft);
  assert.equal(
    validateAgentmailDraftPayload({ ...draft, to: [] } as unknown as JsonValue).ok,
    false,
  );
  assert.equal(
    validateAgentmailDraftPayload({ ...draft, draft_id: "" } as unknown as JsonValue).ok,
    false,
  );
});

// ---------------------------------------------------------------------------
// 5. The HTTP failure mapping
// ---------------------------------------------------------------------------

const MAPPING: readonly { status: number; code: string }[] = [
  { status: 401, code: "agentmail-unauthorized" },
  { status: 403, code: "agentmail-unauthorized" },
  { status: 404, code: "agentmail-not-found" },
  { status: 409, code: "agentmail-conflict" },
  { status: 422, code: "agentmail-rejected" },
  { status: 429, code: "agentmail-rate-limited" },
  { status: 500, code: "agentmail-server-error" },
  { status: 503, code: "agentmail-server-error" },
];

for (const { status, code } of MAPPING) {
  test(`HTTP ${String(status)} from the send maps to ${code} and is recorded as execution.failed`, async () => {
    const unit = granted(directPayload());
    mock.fail({ status, body: JSON.stringify({ message: `mock says ${String(status)}` }) }, "message-send");
    const result = await run(unit);
    mock.fail(null, "message-send");

    const refused = refusal(result);
    assert.equal(refused.code, "adapter-failed");
    assert.equal(refused.adapter_code, code);
    assert.equal(refused.outcome, "execution.failed");
    assert.match(refused.message, new RegExp(`HTTP ${String(status)}`, "u"));
    assert.deepEqual(eventsOf(unit.logPath).slice(-2), ["execution.started", "execution.failed"]);
  });
}

test("a 404 on the inbox read is agentmail-not-found, not agentmail-draft-missing", async () => {
  const unit = granted(directPayload());
  mock.fail({ status: 404, body: '{"message":"no such inbox"}' }, "inbox");
  const result = await run(unit);
  mock.fail(null, "inbox");
  const refused = refusal(result);
  assert.equal(refused.adapter_code, "agentmail-not-found");
});

test("a 500 on the draft read maps to agentmail-server-error and sends nothing", async () => {
  const payload = draftPayload();
  mock.setDraft(payload.draft_id, draftBodyOf(payload));
  const unit = granted(payload as unknown as JsonValue);
  const posts = postCount();
  mock.fail({ status: 500, body: '{"message":"boom"}' }, "draft");
  const result = await run(unit);
  mock.fail(null, "draft");
  assert.equal(refusal(result).adapter_code, "agentmail-server-error");
  assert.equal(postCount(), posts);
});

test("a 4xx on the draft send maps like any other refusal", async () => {
  const payload = draftPayload();
  mock.setDraft(payload.draft_id, draftBodyOf(payload));
  const unit = granted(payload as unknown as JsonValue);
  mock.fail({ status: 409, body: '{"message":"already sent"}' }, "draft-send");
  const result = await run(unit);
  mock.fail(null, "draft-send");
  assert.equal(refusal(result).adapter_code, "agentmail-conflict");
});

// ---------------------------------------------------------------------------
// 6. Transport failures: which side of the send they fall on
// ---------------------------------------------------------------------------

/** A fetch that delegates to the real one and throws on the calls named. */
function throwingFetch(on: (url: string, method: string) => boolean): AgentmailFetch {
  const real = globalThis.fetch as unknown as AgentmailFetch;
  return async (url, init) => {
    if (on(url, init.method)) throw new Error("ECONNRESET while the request was in flight");
    return await real(url, init);
  };
}

test("a throw on the send itself propagates, and the log records execution.indeterminate", async () => {
  const unit = granted(directPayload());
  const adapter = adapterFor({
    fetch: throwingFetch((_url, method) => method === "POST"),
  });
  const result = await run(unit, adapter);

  const refused = refusal(result);
  assert.equal(
    refused.code,
    "execution-indeterminate",
    "a throw after the request left the process must not be reported as a clean failure",
  );
  assert.equal(refused.outcome, "execution.indeterminate");
  assert.deepEqual(eventsOf(unit.logPath).slice(-2), [
    "execution.started",
    "execution.indeterminate",
  ]);
});

test("a throw on the draft send propagates too", async () => {
  const payload = draftPayload();
  mock.setDraft(payload.draft_id, draftBodyOf(payload));
  const unit = granted(payload as unknown as JsonValue);
  const adapter = adapterFor({ fetch: throwingFetch((_url, method) => method === "POST") });
  const refused = refusal(await run(unit, adapter));
  assert.equal(refused.code, "execution-indeterminate");
});

test("a throw on the pre-send inbox read is a returned agentmail-unreachable", async () => {
  const unit = granted(directPayload());
  const adapter = adapterFor({ fetch: throwingFetch((_url, method) => method === "GET") });
  const refused = refusal(await run(unit, adapter));

  assert.equal(refused.code, "adapter-failed", "nothing was attempted, so nothing is unknown");
  assert.equal(refused.adapter_code, "agentmail-unreachable");
  assert.equal(refused.outcome, "execution.failed");
  assert.deepEqual(eventsOf(unit.logPath).slice(-2), ["execution.started", "execution.failed"]);
});

test("a throw on the pre-send draft read is a returned agentmail-unreachable", async () => {
  const payload = draftPayload();
  mock.setDraft(payload.draft_id, draftBodyOf(payload));
  const unit = granted(payload as unknown as JsonValue);
  const adapter = adapterFor({ fetch: throwingFetch((_url, method) => method === "GET") });
  const refused = refusal(await run(unit, adapter));
  assert.equal(refused.adapter_code, "agentmail-unreachable");
});

test("a timeout aborts the request rather than hanging", async () => {
  const unit = granted(directPayload());
  const adapter = adapterFor({
    timeoutMs: 20,
    fetch: async (url, init) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5_000);
        init.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
      });
      return await (globalThis.fetch as unknown as AgentmailFetch)(url, init);
    },
  });
  const refused = refusal(await run(unit, adapter));
  assert.equal(refused.adapter_code, "agentmail-unreachable");
});

// ---------------------------------------------------------------------------
// 7. Redaction (SPEC.md §11.1 invariant 3)
// ---------------------------------------------------------------------------

test("an API key planted in an error body never reaches the message, the detail or the log", async () => {
  const unit = granted(directPayload());
  mock.fail(
    {
      status: 400,
      body: JSON.stringify({ message: `the key ${API_KEY} is not permitted to send` }),
    },
    "message-send",
  );
  const result = await run(unit);
  mock.fail(null, "message-send");

  const refused = refusal(result);
  assert.equal(refused.adapter_code, "agentmail-rejected");
  assert.equal(
    refused.message.includes(API_KEY),
    false,
    `the far side's error published the API key: ${refused.message}`,
  );
  assert.match(refused.message, /\[redacted\]/u, "the key was dropped rather than redacted");
  assert.equal(JSON.stringify(result).includes(API_KEY), false, "the result carries the key");
  assert.equal(
    readFileSync(unit.logPath, "utf8").includes(API_KEY),
    false,
    "the key reached the log",
  );
});

// ---------------------------------------------------------------------------
// 8. Credentials: the manifest, the reader, and the probe
// ---------------------------------------------------------------------------

test("the credential manifest matches the names act asks for", () => {
  assert.deepEqual(
    AGENTMAIL_CREDENTIAL_SPECS.map((spec) => spec.name).sort(),
    Object.values(DEFAULT_AGENTMAIL_CREDENTIAL_NAMES).slice().sort(),
  );
  const kinds = new Map(AGENTMAIL_CREDENTIAL_SPECS.map((spec) => [spec.name, spec.kind]));
  assert.equal(kinds.get(DEFAULT_AGENTMAIL_CREDENTIAL_NAMES.apiKey), "secret");
  assert.equal(kinds.get(DEFAULT_AGENTMAIL_CREDENTIAL_NAMES.inboxId), "config");
  for (const spec of AGENTMAIL_CREDENTIAL_SPECS) {
    assert.equal(spec.required, true, `${spec.name} must be required`);
    assert.equal(spec.default, undefined, "a credential spec must carry no value");
    assert.equal(spec.validate?.("").ok, false, "an empty value was accepted");
    assert.equal(spec.validate?.("has space").ok, false, "a whitespace value was accepted");
    assert.equal(spec.validate?.("fine").ok, true);
  }
  assert.deepEqual(
    requiredAgentmailCredentials().slice().sort(),
    Object.values(DEFAULT_AGENTMAIL_CREDENTIAL_NAMES).slice().sort(),
  );
  assert.deepEqual(
    requiredAgentmailCredentials({ apiKey: "other.key", inboxId: "other.inbox" }).slice().sort(),
    ["other.inbox", "other.key"],
  );
  assert.deepEqual(
    agentmailAdapter().requiredCredentials?.slice().sort(),
    Object.values(DEFAULT_AGENTMAIL_CREDENTIAL_NAMES).slice().sort(),
  );
  assert.deepEqual(agentmailAdapter().classes, [AGENTMAIL_CLASS]);
  assert.equal(agentmailAdapter().name, "agentmail");
  assert.equal(AGENTMAIL_DEFAULT_API_BASE, "https://api.agentmail.to");
  assert.ok(AGENTMAIL_DEFAULT_TIMEOUT_MS > 0);
});

test("readAgentmailConfig is the one reader, and refuses a malformed value", () => {
  const good = readAgentmailConfig(CREDENTIALS);
  assert.equal(good.ok, true, JSON.stringify(good));
  if (good.ok) {
    assert.deepEqual(good.config, { apiKey: API_KEY, inboxId: INBOX_ID });
    assert.deepEqual([...good.secrets], [API_KEY], "the corpus must hold the key and only the key");
  }

  const missing = readAgentmailConfig(
    inMemoryCredentials({ [DEFAULT_AGENTMAIL_CREDENTIAL_NAMES.inboxId]: INBOX_ID }),
  );
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "credential-unavailable");

  const spaced = readAgentmailConfig(
    inMemoryCredentials({
      [DEFAULT_AGENTMAIL_CREDENTIAL_NAMES.apiKey]: "a key with spaces",
      [DEFAULT_AGENTMAIL_CREDENTIAL_NAMES.inboxId]: INBOX_ID,
    }),
  );
  assert.equal(spaced.ok, false);
  if (!spaced.ok) {
    assert.equal(spaced.code, "agentmail-config-invalid");
    assert.equal(
      spaced.message.includes("a key with spaces"),
      false,
      "the refusal quoted the key it refused",
    );
  }
});

test("probeAgentmail reads the inbox and sends nothing", async () => {
  const posts = postCount();
  const probe = await probeAgentmail(
    { apiKey: API_KEY, inboxId: INBOX_ID },
    { apiBase: assertLocal(mock.url), timeoutMs: 5_000 },
  );
  record(probe);
  assert.equal(probe.ok, true, JSON.stringify(probe));
  if (probe.ok) assert.equal(probe.address, INBOX_ID);
  assert.equal(postCount(), posts, "a probe sent something");

  const wrong = await probeAgentmail(
    { apiKey: "not-the-key", inboxId: INBOX_ID },
    { apiBase: assertLocal(mock.url), timeoutMs: 5_000 },
  );
  record(wrong);
  assert.equal(wrong.ok, false);
  if (!wrong.ok) assert.equal(wrong.code, "agentmail-unauthorized");
});

// ---------------------------------------------------------------------------
// 9. The frozen union (SPEC.md §11.1 invariant 6)
// ---------------------------------------------------------------------------

test("the agentmail failure union is frozen", () => {
  assert.deepEqual(
    [...AGENTMAIL_FAILURE_CODES],
    [
      "agentmail-payload-invalid",
      "agentmail-payload-ambiguous",
      "agentmail-config-invalid",
      "agentmail-inbox-mismatch",
      "agentmail-from-mismatch",
      "agentmail-draft-missing",
      "agentmail-draft-drifted",
      "agentmail-unreachable",
      "agentmail-unauthorized",
      "agentmail-not-found",
      "agentmail-conflict",
      "agentmail-rate-limited",
      "agentmail-rejected",
      "agentmail-server-error",
      ...CREDENTIAL_REFUSAL_CODES,
    ],
    "the agentmail failure union changed; it is frozen public API (SPEC.md §11.1 invariant 6)",
  );
  assert.equal(
    new Set(AGENTMAIL_FAILURE_CODES).size,
    AGENTMAIL_FAILURE_CODES.length,
    "a failure code is listed twice",
  );
  for (const code of AGENTMAIL_FAILURE_CODES) assert.equal(isAgentmailFailureCode(code), true);
  assert.equal(isAgentmailFailureCode("smtp-550"), false);
});
