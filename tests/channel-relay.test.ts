/**
 * The authenticated relay channel (APRV-455, part 2), against a fake control
 * plane.
 *
 * The control plane here is `fetch` and nothing else: it holds the secret,
 * renders a policy into the store, and posts gestures to a real
 * `serveRelay` bound on an ephemeral loopback port, exactly as the Agent
 * Village control plane will. Everything on the daemon's side is the real
 * thing: the log is built through `core/attest.ts` and `core/gate.ts`, every
 * gesture reaches `recordChannelDecision` or `proposeAttestation`, and no
 * line of the log is written by hand.
 *
 * The negative cases are the point, and each one asserts what is NOT in the
 * log as carefully as what is: a forged post appends nothing, an unmapped
 * account appends exactly one `audit.decision_refused`, a replay is refused
 * before the gate sees it, a sender swapped between proposal and acceptance
 * attests nothing, and the secret appears nowhere in the log's bytes.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import {
  RELAY_DEFAULT_PORT,
  RELAY_PATH,
  RELAY_REFUSAL_CODES,
  RELAY_SECRET_HEADER,
  fileNonceLedger,
  parseRelayGesture,
} from "../src/channels/relay.js";
import { serveRelay, type RelayHandle } from "../src/channels/relay-server.js";
import { appendAttestation, checkAttestation, policyFileHash } from "../src/core/attest.js";
import { payloadHash } from "../src/core/payload.js";
import { hashedSenderId } from "../src/core/sender-identity.js";
import { readVerifiedRecords } from "../src/core/state.js";
import { RELAY_START_REFUSAL_CODES, prepareRelay, type RelayRequest } from "../src/cli/channel-relay.js";
import { VERB_REGISTRY } from "../src/cli/verb-registry.js";
import { publishedVerbs, toolName } from "../src/mcp/server.js";
import { serveCatalog } from "../src/serve/server.js";
import { register, request } from "./clock-adapters.js";
import {
  assertClean,
  at,
  fixedClock,
  newScenario,
  payloadOf,
  records,
  scratchRoot,
  type Scenario,
} from "./scenario.js";

const scratch = scratchRoot("channel-relay");
const open: RelayHandle[] = [];
after(async () => {
  for (const handle of open) await handle.close();
  scratch.cleanup();
});

const SECRET = "relay-secret-0123456789abcdef0123456789abcdef";
const RESIDENT = "4f1c2a9e-7b3d-4e8a-9c21-5d6e7f8a9b0c";
const RESIDENT_NEW = "aa11bb22-cc33-4d44-8e55-66ff77889900";
const STRANGER = "0b0b0b0b-1c1c-4d2d-8e3e-4f4f4f4f4f4f";
const OPERATOR = "human:operator";
const AGENT = "agent:hermes";
const TASK = "task-455";
const CLASS = "communicate.email.external";

let nonceCounter = 0;
function nonce(): string {
  nonceCounter += 1;
  return `nonce-${String(nonceCounter).padStart(12, "0")}-${String(Date.now())}`;
}

/** The policy the control plane renders, as a function of what it maps. */
function policyText(options: {
  edgeos?: string | null;
  telegram?: string;
  ttl?: string;
  quiet?: string;
} = {}): string {
  const lines = [
    "# Resident policy",
    "",
    "```yaml approval-policy",
    'version: "0.1"',
    "defaults:",
    "  autonomy: manual",
    `  approval_ttl: "${options.ttl ?? "24h"}"`,
    "  on_expiry: reject",
    "approvers:",
    "  resident:",
    "    channels: [telegram, edgeos]",
  ];
  const edgeos = options.edgeos === undefined ? RESIDENT : options.edgeos;
  if (edgeos !== null || options.telegram !== undefined) lines.push("    senders:");
  if (options.telegram !== undefined) lines.push(`      telegram: "${options.telegram}"`);
  if (edgeos !== null) lines.push(`      edgeos: "${edgeos}"`);
  lines.push("classes:", `  ${CLASS}:`, "    autonomy: manual");
  if (options.quiet !== undefined) lines.push(`  ${options.quiet}:`, "    autonomy: supervised-retro");
  lines.push("```", "");
  return lines.join("\n");
}

interface World {
  unit: Scenario;
  relay: RelayHandle;
  url: string;
  nowMs: { value: number };
  ledgerDir: string;
}

/** A store the operator bootstrapped, one live request, and a relay on it. */
async function world(
  text: string = policyText(),
  options: { requests?: number; gateNow?: string; relayNow?: string; ledgerDir?: string } = {},
): Promise<World & { keys: string[] }> {
  const unit = newScenario(scratch.root, text);
  const attested = appendAttestation(unit.logPath, unit.policyPath, OPERATOR, { clock: fixedClock(at(0)) });
  assert.equal(attested.ok, true, JSON.stringify(attested));

  const keys: string[] = [];
  const count = options.requests ?? 1;
  if (count > 0) {
    const actions = [];
    for (let index = 0; index < count; index += 1) {
      const key = `${TASK}:send-${String(index)}`;
      keys.push(key);
      actions.push({
        class: CLASS,
        idempotency_key: key,
        summary: `send ${String(index)}`,
        est_cost_usd: "0",
        payload_hash: payloadHash({ to: [`x${String(index)}@example.org`] }),
      });
    }
    const registered = register(
      unit.logPath,
      { task: TASK, envelope: { origin: { app: "manual", created_by: AGENT }, state: "awaiting", actions } },
      at(0),
      AGENT,
      unit.options,
    );
    assert.equal(registered.ok, true, JSON.stringify(registered));
    for (const [index, key] of keys.entries()) {
      const requested = request(
        unit.logPath,
        { task: TASK, actionKey: key, cls: CLASS, est_cost_usd: "0", summary: `send ${String(index)}` },
        at(1),
        AGENT,
        unit.options,
      );
      assert.equal(requested.ok, true, JSON.stringify(requested));
    }
  }

  const nowMs = { value: Date.parse(options.relayNow ?? at(2)) };
  const ledgerDir = options.ledgerDir ?? join(unit.dir, ".approval", "daemon", "relay-nonces");
  const relay = await serveRelay({
    logPath: unit.logPath,
    secret: SECRET,
    ledger: fileNonceLedger(ledgerDir),
    host: "127.0.0.1",
    port: 0,
    now: () => nowMs.value,
    gateOptions: { ...unit.options, clock: fixedClock(options.gateNow ?? at(2)) },
    proposer: OPERATOR,
    log: () => {},
  });
  open.push(relay);
  return { unit, relay, url: `http://127.0.0.1:${String(relay.port)}${RELAY_PATH}`, nowMs, ledgerDir, keys };
}

interface Posted {
  status: number;
  body: Record<string, unknown>;
}

/** The fake control plane: one POST, the secret in the header unless told otherwise. */
async function post(
  url: string,
  body: unknown,
  options: { secret?: string | null; headers?: Record<string, string>; method?: string; raw?: string } = {},
): Promise<Posted> {
  const headers: Record<string, string> = { "content-type": "application/json", ...options.headers };
  const secret = options.secret === undefined ? SECRET : options.secret;
  if (secret !== null) headers[RELAY_SECRET_HEADER] = secret;
  const response = await fetch(url, {
    method: options.method ?? "POST",
    headers,
    ...(options.method === "GET" ? {} : { body: options.raw ?? JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as Record<string, unknown> };
}

function gesture(
  name: "attest" | "decline" | "grant" | "reject" | "propose",
  fields: Record<string, unknown>,
  issuedAt: string = at(2),
): Record<string, unknown> {
  return { gesture: name, nonce: nonce(), issued_at: issuedAt, ...fields };
}

const sender = (id: string = RESIDENT): Record<string, string> => ({ channel: "edgeos", id });

function logBytes(unit: Scenario): string {
  try {
    return readFileSync(unit.logPath, "utf8");
  } catch {
    return "";
  }
}

function errorCode(posted: Posted): string {
  return String((posted.body["error"] as { code?: unknown } | undefined)?.code ?? "");
}

function refusalCode(posted: Posted): string {
  return String((posted.body["refusal"] as { code?: unknown } | undefined)?.code ?? "");
}

function eventsOf(unit: Scenario, type: string): ReturnType<typeof records> {
  return records(unit).filter((record) => record.event === type);
}

// ---------------------------------------------------------------------------
// Forged posts: the secret first, and nothing appended
// ---------------------------------------------------------------------------

test("a post without the secret, or with the wrong one, or with two, appends nothing and returns a frozen code", async () => {
  const w = await world();
  const before = logBytes(w.unit);
  const body = gesture("grant", { action_key: w.keys[0], sender: sender() });

  const none = await post(w.url, body, { secret: null });
  assert.equal(none.status, 401);
  assert.equal(errorCode(none), "relay-secret-mismatch");

  const wrong = await post(w.url, body, { secret: `${SECRET}x` });
  assert.equal(wrong.status, 401);
  assert.equal(errorCode(wrong), "relay-secret-mismatch");

  // Two headers: fetch joins duplicates, so send them raw through http.
  const { request: rawRequest } = await import("node:http");
  const duplicate = await new Promise<Posted>((settle, fail) => {
    const req = rawRequest(
      { host: "127.0.0.1", port: w.relay.port, path: RELAY_PATH, method: "POST", headers: { [RELAY_SECRET_HEADER]: [SECRET, SECRET], "content-type": "application/json" } },
      (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
        res.on("end", () => settle({ status: res.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown> }));
      },
    );
    req.on("error", fail);
    req.end(JSON.stringify(body));
  });
  assert.equal(duplicate.status, 401);
  assert.equal(errorCode(duplicate), "relay-duplicate-secret-header");

  // The secret is checked before the body: an oversized forged post is a
  // secret refusal, not a size refusal, so nothing about the body is learned.
  const huge = await post(w.url, null, { secret: null, raw: "x".repeat(64 * 1024) });
  assert.equal(errorCode(huge), "relay-secret-mismatch");
  // And before the path.
  const lost = await post(w.url.replace(RELAY_PATH, "/elsewhere"), body, { secret: null });
  assert.equal(errorCode(lost), "relay-secret-mismatch");

  assert.equal(logBytes(w.unit), before, "a forged post changed the log");
  assert.equal(w.relay.stats().gestures, 0);
  assert.equal(w.relay.stats().refusals["relay-secret-mismatch"], 4);
});

test("with the secret, a malformed request is refused by its own code and appends nothing", async () => {
  const w = await world();
  const before = logBytes(w.unit);
  const ok = { action_key: w.keys[0], sender: sender() };

  assert.equal(errorCode(await post(w.url.replace(RELAY_PATH, "/relay/other"), gesture("grant", ok))), "relay-unknown-path");
  assert.equal(errorCode(await post(w.url, null, { method: "GET" })), "relay-method-not-allowed");
  assert.equal(errorCode(await post(w.url, null, { raw: "{not json" })), "relay-body-unreadable");
  assert.equal(errorCode(await post(w.url, null, { raw: "x".repeat(20 * 1024) })), "relay-body-too-large");
  // Unknown fields are refused, so nothing that looks like authority rides along.
  assert.equal(errorCode(await post(w.url, gesture("grant", { ...ok, actor: "human:resident" }))), "relay-body-invalid");
  assert.equal(
    errorCode(await post(w.url, gesture("grant", { ...ok, sender: { ...sender(), actor: "human:x" } }))),
    "relay-body-invalid",
  );
  assert.equal(errorCode(await post(w.url, gesture("grant", { sender: sender() }))), "relay-body-invalid");
  assert.equal(errorCode(await post(w.url, { ...gesture("grant", ok), nonce: "short" })), "relay-body-invalid");
  assert.equal(
    errorCode(await post(w.url, { ...gesture("grant", ok), issued_at: "2026-08-05T10:02:00+00:00" })),
    "relay-body-invalid",
  );
  // A grant cannot be steered onto the attestation path by its key.
  assert.equal(
    errorCode(await post(w.url, gesture("grant", { action_key: `policy.attest:${"a".repeat(64)}`, sender: sender() }))),
    "relay-body-invalid",
  );
  // A sender on another channel's namespace, or an id outside the grammar.
  assert.equal(
    errorCode(await post(w.url, gesture("grant", { ...ok, sender: { channel: "telegram", id: "42" } }))),
    "relay-sender-invalid",
  );
  assert.equal(
    errorCode(await post(w.url, gesture("grant", { ...ok, sender: sender(`hmac-sha256:${"b".repeat(64)}`) }))),
    "relay-sender-invalid",
  );
  assert.equal(
    errorCode(await post(w.url, gesture("grant", { ...ok, sender: sender("someone@example.org") }))),
    "relay-sender-invalid",
  );
  assert.equal(logBytes(w.unit), before);
});

// ---------------------------------------------------------------------------
// Sender resolution: exactly as a tap, with no configured fallback
// ---------------------------------------------------------------------------

test("an unmapped sender is refused sender-unmapped with exactly one audit.decision_refused", async () => {
  const w = await world();
  const posted = await post(w.url, gesture("grant", { action_key: w.keys[0], sender: sender(STRANGER) }));
  assert.equal(posted.status, 409);
  assert.equal(refusalCode(posted), "sender-unmapped");
  assert.equal(eventsOf(w.unit, "approval.granted").length, 0);
  const refusals = eventsOf(w.unit, "audit.decision_refused");
  assert.equal(refusals.length, 1);
  const refusal = refusals[0];
  assert.ok(refusal !== undefined);
  assert.equal(refusal.channel, "edgeos");
  assert.equal(refusal.action_key, w.keys[0]);
  assert.deepEqual(payloadOf(refusal)["sender"], { channel: "edgeos", id: STRANGER });
  assert.equal(payloadOf(refusal)["code"], "sender-unmapped");
  assert.equal("actor" in payloadOf(refusal), false, "an unmapped refusal named a person");
  assertClean(w.unit);
});

test("a policy that maps no EdgeOS account refuses every gesture: the relay has no identity to fall back on", async () => {
  const w = await world(policyText({ edgeos: null, telegram: "42" }));
  const posted = await post(w.url, gesture("grant", { action_key: w.keys[0], sender: sender() }));
  assert.equal(refusalCode(posted), "sender-unmapped");
  assert.equal(eventsOf(w.unit, "approval.granted").length, 0);
  assert.equal(eventsOf(w.unit, "audit.decision_refused").length, 1);

  // And a policy that maps nobody at all.
  const bare = await world(policyText({ edgeos: null }));
  const refused = await post(bare.url, gesture("reject", { action_key: bare.keys[0], sender: sender() }));
  assert.equal(refusalCode(refused), "sender-unmapped");
  assert.equal(eventsOf(bare.unit, "approval.rejected").length, 0);
});

test("a mapped grant lands under the resident, names the channel and the sender, and returns no token", async () => {
  const w = await world();
  const posted = await post(w.url, gesture("grant", { action_key: w.keys[0], sender: sender() }));
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  assert.equal(posted.body["ok"], true);
  assert.equal(posted.body["event"], "approval.granted");
  assert.equal(posted.body["actor"], "human:resident");
  assert.equal(typeof posted.body["token_issued"], "boolean");
  assert.equal("token" in posted.body, false);

  const granted = eventsOf(w.unit, "approval.granted");
  assert.equal(granted.length, 1);
  const record = granted[0];
  assert.ok(record !== undefined);
  assert.equal(record.actor, "human:resident");
  assert.equal(record.channel, "edgeos");
  assert.deepEqual(payloadOf(record)["sender"], { channel: "edgeos", id: RESIDENT });
  assert.equal(payloadOf(record)["sender_source"], "policy");

  // A second answer, with a fresh nonce, is the gate's already-decided.
  const again = await post(w.url, gesture("reject", { action_key: w.keys[0], sender: sender() }));
  assert.equal(refusalCode(again), "already-decided");
  assertClean(w.unit);
});

test("a keyed edgeos mapping resolves with the key and records the digest, never the id", async () => {
  const key = "relay-test-sender-key-0123456789abcdef";
  const previous = process.env["APPROVAL_SENDER_KEY"];
  process.env["APPROVAL_SENDER_KEY"] = key;
  try {
    const w = await world(policyText({ edgeos: hashedSenderId(key, RESIDENT) }));
    const posted = await post(w.url, gesture("grant", { action_key: w.keys[0], sender: sender() }));
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    const record = eventsOf(w.unit, "approval.granted")[0];
    assert.ok(record !== undefined);
    assert.deepEqual(payloadOf(record)["sender"], {
      channel: "edgeos",
      id: hashedSenderId(key, RESIDENT),
      hashed: true,
    });
    assert.equal(logBytes(w.unit).includes(RESIDENT), false, "the raw EdgeOS id reached a keyed log");
  } finally {
    if (previous === undefined) delete process.env["APPROVAL_SENDER_KEY"];
    else process.env["APPROVAL_SENDER_KEY"] = previous;
  }
});

test("a reject lands as approval.rejected under the resident", async () => {
  const w = await world();
  const posted = await post(w.url, gesture("reject", { action_key: w.keys[0], sender: sender() }));
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  assert.equal(posted.body["event"], "approval.rejected");
  assert.equal(eventsOf(w.unit, "approval.rejected")[0]?.actor, "human:resident");
});

test("an expired request is refused expired, exactly as a tap would be", async () => {
  const w = await world(policyText({ ttl: "1h" }), { gateNow: at(120), relayNow: at(120) });
  const posted = await post(w.url, gesture("grant", { action_key: w.keys[0], sender: sender() }, at(120)));
  assert.equal(posted.status, 409);
  assert.equal(refusalCode(posted), "expired");
  assert.equal(eventsOf(w.unit, "approval.granted").length, 0);
});

test("a request asked under a policy re-attested since is refused policy-drift, exactly as a tap would be", async () => {
  const w = await world();
  writeFileSync(w.unit.policyPath, policyText({ ttl: "48h" }), "utf8");
  const reattested = appendAttestation(w.unit.logPath, w.unit.policyPath, OPERATOR, { clock: fixedClock(at(2)) });
  assert.equal(reattested.ok, true);
  const posted = await post(w.url, gesture("grant", { action_key: w.keys[0], sender: sender() }));
  assert.equal(refusalCode(posted), "policy-drift");
  assert.equal(eventsOf(w.unit, "approval.granted").length, 0);
  const refusal = eventsOf(w.unit, "audit.decision_refused")[0];
  assert.ok(refusal !== undefined);
  assert.equal(payloadOf(refusal)["code"], "policy-drift");
  assert.equal(payloadOf(refusal)["actor"], "human:resident");
  assertClean(w.unit);
});

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

test("a replayed post is refused before the gate, across a restart too, and a stale one by the window", async () => {
  const w = await world(policyText(), { requests: 2 });
  const body = gesture("grant", { action_key: w.keys[0], sender: sender() });
  const first = await post(w.url, body);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const replay = await post(w.url, body);
  assert.equal(replay.status, 409);
  assert.equal(errorCode(replay), "relay-nonce-replayed");

  // The same nonce on a different key, after a restart on the same ledger: still refused.
  await w.relay.close();
  const restarted = await serveRelay({
    logPath: w.unit.logPath,
    secret: SECRET,
    ledger: fileNonceLedger(w.ledgerDir),
    host: "127.0.0.1",
    port: 0,
    now: () => w.nowMs.value,
    gateOptions: { ...w.unit.options, clock: fixedClock(at(2)) },
    proposer: OPERATOR,
    log: () => {},
  });
  open.push(restarted);
  const url = `http://127.0.0.1:${String(restarted.port)}${RELAY_PATH}`;
  const crossKey = await post(url, { ...body, action_key: w.keys[1] });
  assert.equal(errorCode(crossKey), "relay-nonce-replayed");
  assert.equal(eventsOf(w.unit, "approval.granted").length, 1);

  // Outside the window either side.
  assert.equal(errorCode(await post(url, gesture("grant", { action_key: w.keys[1], sender: sender() }, at(-10)))), "relay-gesture-stale");
  assert.equal(errorCode(await post(url, gesture("grant", { action_key: w.keys[1], sender: sender() }, at(10)))), "relay-gesture-stale");
  assert.equal(eventsOf(w.unit, "approval.granted").length, 1);
  assertClean(w.unit);
});

test("two ledgers on one directory refuse the same nonce once: the file system settles the race", () => {
  const dir = join(scratch.root, "shared-ledger");
  const one = fileNonceLedger(dir);
  const two = fileNonceLedger(dir);
  const n = "shared-nonce-000000000001";
  assert.equal(one.claim(n, Date.parse(at(0))), "claimed");
  assert.equal(two.claim(n, Date.parse(at(0))), "replayed");
  assert.equal(readdirSync(dir).length, 1);
});

// ---------------------------------------------------------------------------
// Attestation from the onboarding review
// ---------------------------------------------------------------------------

test("propose then attest: policy.updated under the resident with payload.sender edgeos", async () => {
  const w = await world(policyText(), { requests: 0 });
  // The control plane renders the resident's changed settings and writes them.
  writeFileSync(w.unit.policyPath, policyText({ quiet: "intent.publish.inferred" }), "utf8");
  const sha = policyFileHash(w.unit.policyPath);

  const proposed = await post(w.url, gesture("propose", { policy_sha256: sha }));
  assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
  assert.equal(proposed.body["reaffirm"], false);
  assert.equal(proposed.body["existing"], false);
  assert.match(String(proposed.body["changes"]), /class resolution/u);
  const proposal = eventsOf(w.unit, "policy.proposed")[0];
  assert.ok(proposal !== undefined);
  assert.equal(proposal.actor, OPERATOR);

  // A retry of the same proposal is the same proposal.
  const retried = await post(w.url, gesture("propose", { policy_sha256: sha }));
  assert.equal(retried.body["existing"], true);
  assert.equal(eventsOf(w.unit, "policy.proposed").length, 1);

  const accepted = await post(w.url, gesture("attest", { policy_sha256: sha, sender: sender() }));
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body["event"], "policy.updated");
  const attestation = eventsOf(w.unit, "policy.updated").at(-1);
  assert.ok(attestation !== undefined);
  assert.equal(attestation.actor, "human:resident");
  // An attestation names its surface through the sender it was resolved from,
  // as a Telegram attestation does; the record's own channel is a decision's.
  assert.deepEqual(payloadOf(attestation)["sender"], { channel: "edgeos", id: RESIDENT });
  assert.equal(payloadOf(attestation)["sha256"], sha);
  assert.equal(payloadOf(attestation)["proposed_seq"], proposal.seq);

  const read = readVerifiedRecords(w.unit.logPath);
  assert.equal(read.ok, true);
  assert.equal(checkAttestation(read.ok ? read.records : [], w.unit.policyPath).status, "attested");
  assertClean(w.unit);
});

test("an unchanged review is still the resident's attestation: a reaffirmation of the bytes in force", async () => {
  const w = await world(policyText(), { requests: 0 });
  const sha = policyFileHash(w.unit.policyPath);
  const proposed = await post(w.url, gesture("propose", { policy_sha256: sha }));
  assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
  assert.equal(proposed.body["reaffirm"], true);
  assert.equal(proposed.body["changes"], "no semantic change");

  const accepted = await post(w.url, gesture("attest", { policy_sha256: sha, sender: sender() }));
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  const attestations = eventsOf(w.unit, "policy.updated");
  assert.equal(attestations.length, 2);
  assert.equal(attestations[0]?.actor, OPERATOR);
  assert.equal(attestations[1]?.actor, "human:resident");
  assert.equal(payloadOf(attestations[1] as (typeof attestations)[number])["sha256"], sha);
  assertClean(w.unit);
});

test("a decline appends policy.declined under the resident and attests nothing", async () => {
  const w = await world(policyText(), { requests: 0 });
  writeFileSync(w.unit.policyPath, policyText({ ttl: "12h" }), "utf8");
  const sha = policyFileHash(w.unit.policyPath);
  assert.equal((await post(w.url, gesture("propose", { policy_sha256: sha }))).status, 200);
  const declined = await post(w.url, gesture("decline", { policy_sha256: sha, sender: sender() }));
  assert.equal(declined.status, 200, JSON.stringify(declined.body));
  assert.equal(declined.body["event"], "policy.declined");
  assert.equal(eventsOf(w.unit, "policy.declined")[0]?.actor, "human:resident");
  assert.equal(eventsOf(w.unit, "policy.updated").length, 1);
});

test("a stale hash is refused with a distinct code and attests nothing", async () => {
  const w = await world(policyText(), { requests: 0 });
  writeFileSync(w.unit.policyPath, policyText({ ttl: "12h" }), "utf8");
  const first = policyFileHash(w.unit.policyPath);
  assert.equal((await post(w.url, gesture("propose", { policy_sha256: first }))).status, 200);

  // The resident changed a setting again in another tab: a second proposal
  // supersedes the first, and an acceptance of the first names a question
  // nobody is asking any more.
  writeFileSync(w.unit.policyPath, policyText({ ttl: "6h" }), "utf8");
  const second = policyFileHash(w.unit.policyPath);
  assert.equal((await post(w.url, gesture("propose", { policy_sha256: second }))).status, 200);
  const superseded = await post(w.url, gesture("attest", { policy_sha256: first, sender: sender() }));
  assert.equal(refusalCode(superseded), "proposal-not-found");

  // The file changed under an open proposal without a new one: the gate's
  // proposal-stale, which is the hash the resident saw not being the bytes.
  writeFileSync(w.unit.policyPath, policyText({ ttl: "3h" }), "utf8");
  const stale = await post(w.url, gesture("attest", { policy_sha256: second, sender: sender() }));
  assert.equal(refusalCode(stale), "proposal-stale");

  // And the relay's own check, before anything is proposed.
  const mismatch = await post(w.url, gesture("propose", { policy_sha256: second }));
  assert.equal(mismatch.status, 409);
  assert.equal(errorCode(mismatch), "relay-policy-mismatch");

  assert.equal(eventsOf(w.unit, "policy.updated").length, 1, "a stale hash attested something");
  assertClean(w.unit);
});

test("a sender swapped between proposal and acceptance attests nothing: the policy in force decides who may", async () => {
  const w = await world(policyText(), { requests: 0 });
  // A proposal that repoints the resident's EdgeOS id to a new account.
  writeFileSync(w.unit.policyPath, policyText({ edgeos: RESIDENT_NEW }), "utf8");
  const sha = policyFileHash(w.unit.policyPath);
  assert.equal((await post(w.url, gesture("propose", { policy_sha256: sha }))).status, 200);

  // The account the PROPOSAL names cannot sign for the proposal that names it.
  const swapped = await post(w.url, gesture("attest", { policy_sha256: sha, sender: sender(RESIDENT_NEW) }));
  assert.equal(refusalCode(swapped), "sender-unmapped");
  assert.equal(eventsOf(w.unit, "policy.updated").length, 1);
  const refusal = eventsOf(w.unit, "audit.decision_refused")[0];
  assert.ok(refusal !== undefined);
  assert.deepEqual(payloadOf(refusal)["sender"], { channel: "edgeos", id: RESIDENT_NEW });

  // The account in force can, and the change is then attested under that person.
  const accepted = await post(w.url, gesture("attest", { policy_sha256: sha, sender: sender(RESIDENT) }));
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(eventsOf(w.unit, "policy.updated").at(-1)?.actor, "human:resident");
  assertClean(w.unit);
});

test("an amendment that introduces the EdgeOS mapping cannot be attested through the relay", async () => {
  const w = await world(policyText({ edgeos: null, telegram: "42" }), { requests: 0 });
  writeFileSync(w.unit.policyPath, policyText({ telegram: "42" }), "utf8");
  const sha = policyFileHash(w.unit.policyPath);
  assert.equal((await post(w.url, gesture("propose", { policy_sha256: sha }))).status, 200);
  const refused = await post(w.url, gesture("attest", { policy_sha256: sha, sender: sender() }));
  assert.equal(refusalCode(refused), "attest-requires-terminal");
  assert.equal(eventsOf(w.unit, "policy.updated").length, 1);
});

// ---------------------------------------------------------------------------
// The secret never reaches the log; the relay is unreachable through serve and MCP
// ---------------------------------------------------------------------------

test("the relay secret appears nowhere in the log or the payload store after every kind of gesture", async () => {
  const w = await world();
  await post(w.url, gesture("grant", { action_key: w.keys[0], sender: sender(STRANGER) }));
  await post(w.url, gesture("grant", { action_key: w.keys[0], sender: sender() }));
  writeFileSync(w.unit.policyPath, policyText({ ttl: "12h" }), "utf8");
  const sha = policyFileHash(w.unit.policyPath);
  await post(w.url, gesture("propose", { policy_sha256: sha }));
  await post(w.url, gesture("attest", { policy_sha256: sha, sender: sender() }));
  await post(w.url, gesture("grant", { action_key: w.keys[0], sender: sender() }), { secret: "wrong-secret-value-that-is-long" });

  assert.equal(logBytes(w.unit).includes(SECRET), false);
  const storeDir = join(w.unit.dir, ".approval", "payloads");
  let names: string[] = [];
  try {
    names = readdirSync(storeDir);
  } catch {
    names = [];
  }
  for (const name of names) {
    assert.equal(readFileSync(join(storeDir, name), "utf8").includes(SECRET), false, name);
  }
  assert.ok(eventsOf(w.unit, "policy.updated").length >= 2);
});

test("neither serve nor MCP can reach the relay: the verb is human_only and nothing there imports it", () => {
  const spec = VERB_REGISTRY.find((entry) => entry.name === "channel" && entry.subcommand === "relay");
  assert.ok(spec !== undefined, "the relay verb is not registered");
  assert.equal(spec.human_only, true);
  assert.equal(publishedVerbs().some((entry) => toolName(entry) === "channel_relay"), false);
  assert.equal(publishedVerbs(true).some((entry) => toolName(entry) === "channel_relay"), false);
  assert.equal(serveCatalog().some((entry) => entry.name === "channel_relay"), false);

  const root = fileURLToPath(new URL("../../src/", import.meta.url));
  for (const dir of ["serve", "mcp"]) {
    for (const name of readdirSync(join(root, dir))) {
      if (!name.endsWith(".ts")) continue;
      const source = readFileSync(join(root, dir, name), "utf8");
      assert.equal(/channels\/relay/u.test(source), false, `${dir}/${name} imports the relay`);
      assert.equal(/channel-relay/u.test(source), false, `${dir}/${name} imports the relay verb`);
    }
  }
});

// ---------------------------------------------------------------------------
// The verb's start-up refusals, and the frozen unions
// ---------------------------------------------------------------------------

function relayRequest(env: NodeJS.ProcessEnv, extra: Partial<RelayRequest> = {}): RelayRequest {
  return {
    logPath: join(scratch.root, "nowhere.jsonl"),
    policy: { dir: scratch.root },
    listen: null,
    port: null,
    allowNonLoopback: false,
    proposer: null,
    json: true,
    env,
    ...extra,
  };
}

test("the secret comes from the launch environment, with a floor and a charset, and the bind is loopback", () => {
  const code = (env: NodeJS.ProcessEnv, extra: Partial<RelayRequest> = {}): string => {
    const prepared = prepareRelay(relayRequest(env, extra));
    return prepared.ok ? "ok" : prepared.code;
  };
  assert.equal(code({}), "relay-secret-missing");
  assert.equal(code({ APPROVAL_RELAY_SECRET: "   " }), "relay-secret-missing");
  assert.equal(code({ APPROVAL_RELAY_SECRET: "short-secret" }), "relay-secret-weak");
  assert.equal(code({ APPROVAL_RELAY_SECRET: `${"a".repeat(30)} b` }), "relay-secret-charset");
  assert.equal(code({ APPROVAL_RELAY_SECRET: SECRET }), "ok");
  assert.equal(code({ APPROVAL_RELAY_SECRET: SECRET }, { proposer: "system:me" }), "relay-proposer-invalid");
  assert.equal(code({ APPROVAL_RELAY_SECRET: SECRET }, { listen: "0.0.0.0:4684" }), "relay-bind-invalid");
  assert.equal(code({ APPROVAL_RELAY_SECRET: SECRET }, { listen: "0.0.0.0:4684", allowNonLoopback: true }), "ok");
  assert.equal(code({ APPROVAL_RELAY_SECRET: SECRET }, { port: "0" }), "relay-bind-invalid");
  assert.equal(code({ APPROVAL_RELAY_SECRET: SECRET }, { port: "4684", listen: "4684" }), "relay-bind-invalid");

  const prepared = prepareRelay(relayRequest({ APPROVAL_RELAY_SECRET: SECRET }));
  assert.ok(prepared.ok);
  assert.equal(prepared.setup.port, RELAY_DEFAULT_PORT);
  assert.equal(prepared.setup.host, "127.0.0.1");
  assert.equal(prepared.setup.proposer, "agent:edgeos-relay");
  // A refusal never prints the value it refused.
  const weak = prepareRelay(relayRequest({ APPROVAL_RELAY_SECRET: "hunter2-is-not-long" }));
  assert.equal(weak.ok === false && weak.message.includes("hunter2"), false);
});

test("the relay's refusal unions are frozen", () => {
  assert.deepEqual(
    [...RELAY_REFUSAL_CODES],
    [
      "relay-secret-mismatch",
      "relay-duplicate-secret-header",
      "relay-malformed-request",
      "relay-unknown-path",
      "relay-method-not-allowed",
      "relay-body-too-large",
      "relay-body-unreadable",
      "relay-body-invalid",
      "relay-sender-invalid",
      "relay-gesture-stale",
      "relay-nonce-replayed",
      "relay-nonce-unavailable",
      "relay-policy-mismatch",
      "relay-handler-failed",
    ],
  );
  assert.deepEqual(
    [...RELAY_START_REFUSAL_CODES],
    ["relay-secret-missing", "relay-secret-weak", "relay-secret-charset", "relay-proposer-invalid", "relay-bind-invalid"],
  );
  // A propose carries no sender: the proposal is the operator's, and an
  // acceptance is where a person is named.
  const parsed = parseRelayGesture({
    gesture: "propose",
    policy_sha256: "a".repeat(64),
    sender: { channel: "edgeos", id: RESIDENT },
    nonce: "abcdefghijklmnop",
    issued_at: at(0),
  });
  assert.equal(parsed.ok, false);
});
