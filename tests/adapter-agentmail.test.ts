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
  observeAgentmail,
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
import { readVerifiedRecords } from "../src/core/state.js";
import { verifyToken } from "../src/core/token.js";
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
    const detail = result.detail as Record<string, JsonValue>;
    assert.deepEqual(result.detail, {
      mode: "direct",
      message_id: detail["message_id"],
      // The same id under the one key the contract lifts (APRV-251).
      provider_ref: detail["message_id"],
      thread_id: detail["thread_id"],
      payload_hash: payloadHash(payload),
      recipients: 2,
      http_status: 200,
    });
    assert.match(String(detail["message_id"]), /^msg_/u);
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
    2,
    "the draft was not read exactly twice before the send: once before the token is spent (APRV-276) and once inside the window, immediately before the POST",
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
    const before = readFileSync(unit.logPath, "utf8");
    const result = await run(unit);
    const refused = refusal(result);
    // APRV-276: the comparison runs BEFORE the token is consumed, so a drift is
    // refused with the log untouched rather than recorded as a failed execution.
    assert.equal(refused.code, "adapter-precheck-refused");
    assert.equal(refused.adapter_code, "agentmail-draft-drifted");
    assert.equal(refused.outcome, undefined, "a drift refusal recorded an outcome");
    assert.match(refused.message, new RegExp(`\\b${field}\\b`, "u"), "the field was not named");
    assert.equal(postCount(), posts, "a drifted draft was sent anyway");
    assert.equal(
      readFileSync(unit.logPath, "utf8"),
      before,
      "a drift refusal wrote to the log; it must cost the human no authority",
    );

    // The message names the field and never the value: a refusal is not a
    // channel for publishing text nobody approved.
    assert.equal(
      JSON.stringify(result).includes(NEEDLE),
      false,
      `the drift refusal quoted the unapproved ${field}: ${refused.message}`,
    );
  });
}

/**
 * The APRV-276 regression, end to end on ONE token.
 *
 * Found on a live AgentMail inbox on 2026-09-06: the drift refusal was recorded
 * as `execution.started` then `execution.failed`, so the human's single-use
 * grant was spent by an attempt that sent nothing, and restoring the approved
 * text refused `token-consumed`. What `examples/agentmail-demo.md` promises, and
 * what this pins, is the opposite: nothing sent, the grant untouched, and the
 * same token sending once the draft matches the snapshot again.
 */
test("a drift costs no authority: restore the draft and the SAME token sends once", async () => {
  const payload = draftPayload();
  const approved = draftBodyOf(payload);
  mock.setDraft(payload.draft_id, { ...approved, subject: `${NEEDLE} subject` });
  const unit = granted(payload as unknown as JsonValue);

  const before = readFileSync(unit.logPath, "utf8");
  const posts = postCount();

  // 1. Drifted. Refused before the spend: nothing appended, nothing sent.
  const drifted = refusal(await run(unit));
  assert.equal(drifted.code, "adapter-precheck-refused");
  assert.equal(drifted.adapter_code, "agentmail-draft-drifted");
  assert.equal(drifted.outcome, undefined, "the drift refusal recorded an execution");
  assert.equal(postCount(), posts, "a drifted draft was sent");
  assert.equal(
    readFileSync(unit.logPath, "utf8"),
    before,
    "the drift refusal appended to the log; the grant must be untouched",
  );
  assert.equal(
    eventsOf(unit.logPath).includes("execution.started"),
    false,
    "execution.started was appended for a refusal that attempted nothing",
  );

  // …and the token is still the live, unspent one the grant minted.
  const read = readVerifiedRecords(unit.logPath, {});
  assert.equal(read.ok, true, `the log did not verify: ${JSON.stringify(read)}`);
  if (read.ok) {
    const status = verifyToken([...read.records], unit.actionKey, unit.token, at(3));
    assert.equal(status.ok, true, `the token stopped verifying after a drift: ${JSON.stringify(status)}`);
  }

  // 2. The operator restores the approved text. The SAME token sends, once.
  mock.setDraft(payload.draft_id, approved);
  const sent = await run(unit);
  assert.equal(sent.ok, true, `the retained token was refused: ${JSON.stringify(sent)}`);
  assert.deepEqual(mock.sentDrafts().slice(-1), [payload.draft_id]);
  assert.deepEqual(eventsOf(unit.logPath).slice(-2), ["execution.started", "execution.completed"]);

  // 3. And it is still single-use.
  const third = refusal(await run(unit));
  assert.equal(third.code, "token-consumed", `a spent token was refused for the wrong reason`);
  assert.equal(
    mock.sentDrafts().filter((id) => id === payload.draft_id).length,
    1,
    "the draft was sent more than once across three runs of one token",
  );
});

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
  const before = readFileSync(unit.logPath, "utf8");
  const refused = refusal(await run(unit));
  // Same pre-spend position as drift (APRV-276): the draft read that discovers
  // this happens before the token is consumed, and a draft that is gone is a
  // condition the runtime established without attempting anything.
  assert.equal(refused.code, "adapter-precheck-refused");
  assert.equal(refused.adapter_code, "agentmail-draft-missing");
  assert.equal(refused.outcome, undefined);
  assert.equal(postCount(), posts, "a missing draft produced a send");
  assert.equal(readFileSync(unit.logPath, "utf8"), before, "a missing draft spent the grant");
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
// 8b. observe() — the coverage read (APRV-245)
// ---------------------------------------------------------------------------

/** The window every observe case asks about: wide enough to hold the fixtures. */
const OBSERVE_WINDOW = { since: "2026-01-01T00:00:00.000Z", until: "2026-12-31T00:00:00.000Z" };

/** One listing row, in the provider's own field names. */
function listed(
  id: string,
  labels: string[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    message_id: id,
    labels,
    timestamp: "2026-06-01T09:00:00.000Z",
    subject: "Deposit chaser",
    to: ["landlord@example.invalid"],
    ...extra,
  };
}

test("observeAgentmail lists the inbox and sends nothing", async () => {
  const posts = postCount();
  mock.setMessages([listed("msg-1", ["sent"])]);

  const seen = await observeAgentmail(
    { apiKey: API_KEY, inboxId: INBOX_ID },
    OBSERVE_WINDOW,
    { apiBase: assertLocal(mock.url), timeoutMs: 5_000 },
  );
  record(seen);
  assert.equal(seen.ok, true, JSON.stringify(seen));
  if (seen.ok) {
    assert.equal(seen.messages.length, 1);
    assert.equal(seen.messages[0]?.messageId, "msg-1");
    assert.equal(seen.messages[0]?.recipients, 1);
    assert.equal(seen.truncated, false);
  }
  // The whole reason this is safe to run on a timer: it is a READ.
  assert.equal(postCount(), posts, "the coverage read POSTed something");

  // The window reached the provider as a query rather than being applied here.
  const asked = mock.requestsFor("messages-list").at(-1);
  assert.ok(asked !== undefined, "no listing request reached the mock");
  assert.match(asked.path, /after=2026-01-01/u);
  assert.match(asked.path, /before=2026-12-31/u);
});

test("observeAgentmail keeps only the messages the provider labelled sent", async () => {
  mock.setMessages([
    listed("sent-1", ["sent"]),
    listed("received-1", ["received"]),
    listed("sent-2", ["SENT"], { to: ["a@example.invalid", "b@example.invalid"], cc: ["c@x.invalid"] }),
    // No labels at all: the filter admits nothing it was not told about, which
    // is the fail-closed direction for a report about sends.
    listed("unlabelled", []),
  ]);
  const seen = await observeAgentmail(
    { apiKey: API_KEY, inboxId: INBOX_ID },
    OBSERVE_WINDOW,
    { apiBase: assertLocal(mock.url), timeoutMs: 5_000 },
  );
  assert.equal(seen.ok, true, JSON.stringify(seen));
  if (!seen.ok) return;
  assert.deepEqual(
    seen.messages.map((message) => message.messageId),
    ["sent-1", "sent-2"],
  );
  // `to`, `cc` and `bcc` together: a blind recipient is still a recipient.
  assert.equal(seen.messages[1]?.recipients, 3);
});

test("an unauthorized listing is a failure code, not an empty inbox", async () => {
  mock.setMessages([listed("msg-1", ["sent"])]);
  const seen = await observeAgentmail(
    { apiKey: "not-the-key", inboxId: INBOX_ID },
    OBSERVE_WINDOW,
    { apiBase: assertLocal(mock.url), timeoutMs: 5_000 },
  );
  record(seen);
  assert.equal(seen.ok, false);
  if (!seen.ok) {
    assert.equal(seen.code, "agentmail-unauthorized");
    // "the provider refused us" and "this inbox sent nothing" are different
    // facts, and a report that collapsed them would read a broken credential as
    // a clean bill of health.
    assert.match(seen.message, /Nothing was sent and nothing was changed/u);
  }
});

test("the adapter's observe() returns effects of its own class and no others", async () => {
  const posts = postCount();
  mock.setMessages([listed("msg-9", ["sent"]), listed("msg-10", ["received"])]);

  const adapter = adapterFor();
  assert.notEqual(adapter.observe, undefined, "the agentmail adapter implements no observe()");
  const effects = await (adapter.observe as NonNullable<Adapter["observe"]>)(
    OBSERVE_WINDOW,
    CREDENTIALS,
  );
  record(effects);

  assert.equal(effects.length, 1);
  const effect = effects[0];
  assert.ok(effect !== undefined);
  assert.equal(effect.source, "agentmail");
  assert.equal(effect.id, "msg-9");
  assert.equal(effect.class, AGENTMAIL_CLASS);
  assert.equal(effect.actorHint, INBOX_ID);
  // A subject and a COUNT. Never a body, and never the addresses: this line is
  // read by somebody who did not approve the message.
  assert.equal(effect.detail, 'sent "Deposit chaser" to 1 recipient(s)');
  assert.equal(effect.detail.includes("landlord@example.invalid"), false);
  assert.equal(postCount(), posts, "observe() POSTed something");
});

test("observe() with no credential throws rather than reporting a quiet inbox", async () => {
  const adapter = adapterFor();
  await assert.rejects(
    async () =>
      (adapter.observe as NonNullable<Adapter["observe"]>)(
        OBSERVE_WINDOW,
        inMemoryCredentials({}),
      ),
    // "the vault would not open" and "this inbox sent nothing" are different
    // facts; the source layer turns this into an unavailable source with a
    // reason, and never into zero effects.
    /credential/iu,
  );
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

// ---------------------------------------------------------------------------
// 10. The provider reference on the record (APRV-251)
// ---------------------------------------------------------------------------

/** The `provider_ref` on the last outcome of `event` in this log, if any. */
function recordedProviderRef(logPath: string, event = "execution.completed"): unknown {
  const read = readVerifiedRecords(logPath);
  assert.equal(read.ok, true, `the log does not verify: ${JSON.stringify(read)}`);
  if (!read.ok) throw new Error("unreachable");
  const outcome = read.records.filter((entry) => entry.event === event).at(-1);
  assert.ok(outcome !== undefined, `no ${event} in the log`);
  return (outcome.payload as Record<string, unknown> | undefined)?.["provider_ref"];
}

test("a direct send records the provider's message_id on execution.completed", async () => {
  const payload = directPayload();
  const unit = granted(payload);

  const result = await run(unit);
  assert.equal(result.ok, true, `the granted send was refused: ${JSON.stringify(result)}`);
  if (!result.ok) throw new Error("unreachable");

  const id = String((result.detail as Record<string, JsonValue>)["message_id"]);
  assert.match(id, /^msg_/u, "the mock did not answer with a message id");

  // The id the provider gave is the id the log carries, under the adapter this
  // runtime called. That pair is what `approval coverage` joins on, so a send
  // this inbox reports is answered about by name rather than by its hour.
  assert.deepEqual(
    recordedProviderRef(unit.logPath),
    { adapter: "agentmail", id },
    "the completed record does not name the message that was sent",
  );
  assert.deepEqual(result.provider_ref, { adapter: "agentmail", id });
});

test("a draft send records the provider's message_id too", async () => {
  const payload = draftPayload();
  mock.setDraft(payload.draft_id, draftBodyOf(payload));
  const unit = granted(payload as unknown as JsonValue);

  const result = await run(unit);
  assert.equal(result.ok, true, `the granted draft send was refused: ${JSON.stringify(result)}`);
  if (!result.ok) throw new Error("unreachable");

  const detail = result.detail as Record<string, JsonValue>;
  const id = String(detail["message_id"]);
  assert.match(id, /^msg_/u, "the mock did not answer the draft send with a message id");
  assert.equal(
    detail["provider_ref"],
    id,
    "the draft receipt does not name the reference under the conventional key",
  );
  assert.deepEqual(recordedProviderRef(unit.logPath), { adapter: "agentmail", id });
});

test("a send whose answer carries no message_id records no reference", async () => {
  const payload = directPayload();
  const unit = granted(payload);

  // A 200 with no id: the send happened and the provider named nothing. The
  // completion is then the pre-amendment record, which is always valid, rather
  // than a record carrying an invented or empty reference.
  mock.fail({ status: 200, body: JSON.stringify({ ok: true }) }, "message-send");
  const result = await run(unit);
  mock.fail(null, "message-send");
  assert.equal(result.ok, true, `the granted send was refused: ${JSON.stringify(result)}`);
  if (!result.ok) throw new Error("unreachable");

  assert.equal((result.detail as Record<string, JsonValue>)["message_id"], null);
  assert.equal(
    (result.detail as Record<string, JsonValue>)["provider_ref"],
    undefined,
    "a receipt with no id named a reference anyway",
  );
  assert.equal(recordedProviderRef(unit.logPath), undefined);
  assert.equal(result.provider_ref, undefined);
});

test("a failed send records no reference, because nothing was filed", async () => {
  const payload = directPayload();
  const unit = granted(payload);

  mock.fail({ status: 502, body: JSON.stringify({ message: "upstream is down" }) }, "message-send");
  const result = await run(unit);
  mock.fail(null, "message-send");
  assert.equal(result.ok, false, "a 502 send reported success");

  assert.equal(
    recordedProviderRef(unit.logPath, "execution.failed"),
    undefined,
    "a failed execution named a provider reference for an effect that did not happen",
  );
});
