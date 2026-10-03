/**
 * The authenticated relay channel: its protocol (SPEC.md §10.3, APRV-455).
 *
 * Agent Village residents review their approval.md settings in the Edge City
 * onboarding app, and that review is meant to be the attestation of the policy
 * in force. The app signs the resident in through EdgeOS, and the operator's
 * control plane is what holds that session. This module is the daemon's side
 * of the hop from there: a gesture the control plane carries, attributed to the
 * EdgeOS `/humans/me` id of the session that made it, arriving over an
 * authenticated HTTP post (`channels/relay-server.ts`) and turned into a log
 * event by the SAME function a Telegram tap goes through.
 *
 * ## What the relay is trusted for, and what it is not
 *
 * The daemon trusts the relay's report of WHO acted, exactly as it trusts the
 * Telegram Bot API's report of `callback_query.from.id`. That is operator
 * trust (APRV-422: no hosted service has authority over decisions), and it is
 * the whole of what the shared secret buys: a post that carries it is a report
 * from the operator's relay, and a post that does not is nothing. Every
 * question of AUTHORITY is answered here, by the runtime, from the verified log
 * and the attested policy:
 *
 * - which approver the account is, by `core/sender-identity.ts` against the
 *   attested mapping, exactly as a tap is resolved;
 * - whether that approver may decide this request, attest this policy, or
 *   neither, by `core/gate.ts` and `core/policy-proposal.ts`, unchanged;
 * - whether the request is still answerable (expiry, policy drift, an earlier
 *   answer), by the same gate, with the same codes.
 *
 * The relay holds NO human identity of its own. A Telegram listener launched
 * `--as human:carter` falls back to that identity for a channel the policy maps
 * no sender for; this surface does not, ever (`requireSenderMapping`). A post
 * naming an account the attested policy does not map is refused
 * `sender-unmapped` with one `audit.decision_refused`, and a policy that maps
 * nobody on `edgeos` refuses every gesture the same way.
 *
 * ## The body, closed
 *
 * ```json
 * { "gesture": "attest" | "decline", "policy_sha256": "<64 hex>",
 *   "sender": { "channel": "edgeos", "id": "<EdgeOS /humans/me id>" },
 *   "nonce": "<16..128 of A-Z a-z 0-9 _ ->", "issued_at": "<RFC 3339 UTC>" }
 * { "gesture": "grant" | "reject", "action_key": "<the request's key>",
 *   "sender": { ... }, "nonce": "...", "issued_at": "..." }
 * { "gesture": "propose", "policy_sha256": "<64 hex>",
 *   "nonce": "...", "issued_at": "..." }
 * ```
 *
 * Unknown keys are refused rather than ignored, so a field that looks like it
 * carries authority (an `actor`, a second sender, a `ts`) cannot ride along on
 * a valid post and be read by something later. `issued_at` is used for one
 * thing only, the freshness window that bounds how long a nonce must be
 * remembered; it is never recorded, and every record's `ts` is still the
 * runtime's own (SPEC.md §11.1 invariant 2).
 *
 * ## Why `propose` exists here
 *
 * The control plane renders the resident's policy and writes it into the
 * store; somebody then has to append the `policy.proposed` an acceptance
 * answers. The existing route for that is `approval policy amend`, which is a
 * git-aware terminal ceremony that blocks for its own `--wait`. `propose` is the
 * same `core/policy-proposal.ts` call, under the same secret, recorded under the
 * actor the operator started the relay with (`--proposer`), and it returns at
 * once. It binds the hash the control plane rendered: bytes on disk that are not
 * the bytes it names are refused, so the prompt the resident answers is the file
 * the control plane showed them.
 *
 * It also admits the one proposal `policy amend` refuses: bytes that are
 * ALREADY the policy in force (`ProposeInput.reaffirm`). The onboarding review
 * most residents make is "accept, unchanged", and the operator attested those
 * bytes at provisioning (APRV-449). The reaffirmation changes the attester of
 * record and nothing else: same hash, a diff that reads "no semantic change",
 * and an acceptance resolved against the policy in force like any other.
 *
 * ## No token leaves this surface
 *
 * A grant may mint a single-use execution token for the deciding surface
 * (manual delivery). A relay is not a place a token can go: the control plane
 * is not the requester and the HTTP response is not a secrets channel. The
 * token `recordChannelDecision` returns is dropped here, unread, and the
 * response says only whether one was minted. The deployments this exists for
 * mint none (a harness-executed request) or seal it to the requester's own
 * key, so nothing is lost in practice, and the residual is stated rather than
 * hidden: a manual-delivery request granted through the relay has a token
 * nobody holds, and its requester asks again.
 */

import { createHash } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { POLICY_HASH_FIELD, policyBytesHash } from "../core/attest.js";
import type { DecideOptions } from "../core/gate.js";
import { payloadStoreDirFor } from "../core/payload-store.js";
import {
  attestationActionKey,
  inForcePolicyText,
  isAttestationActionKey,
  openProposalFor,
  proposalPolicyPath,
  proposeAttestation,
} from "../core/policy-proposal.js";
import { isEdgeosSenderId, type ChannelSender } from "../core/sender-identity.js";
import { readVerifiedRecords } from "../core/state.js";
import { tick } from "../core/clock.js";
import { recordChannelDecision, type ChannelDecision } from "./contract.js";

/** The channel name every relay gesture is recorded under, and its senders' namespace. */
export const RELAY_CHANNEL = "edgeos";

/** The header the shared secret travels in, lowercased as Node presents it. */
export const RELAY_SECRET_HEADER = "x-approval-relay-secret";

/** The one path this transport answers. */
export const RELAY_PATH = "/relay/gesture";

/** The interface it binds when the operator names none. Loopback, always. */
export const RELAY_DEFAULT_HOST = "127.0.0.1";

/** The port it binds when the operator names none: `serve` is 4682, the webhook 4683. */
export const RELAY_DEFAULT_PORT = 4684;

/** Largest body accepted. A gesture is a handful of short strings. */
export const RELAY_MAX_BODY_BYTES = 16 * 1024;

/** How much of an oversized body is drained before the socket is dropped. */
export const RELAY_DRAIN_LIMIT_BYTES = 1024 * 1024;

/**
 * How far `issued_at` may sit from this process's clock, either side.
 *
 * Five minutes: a control plane and a sandbox on the same platform agree to
 * well under a second, and a gesture older than this was not made by a person
 * who is still looking at the screen that made it.
 */
export const RELAY_GESTURE_WINDOW_MS = 5 * 60_000;

/**
 * How long a claimed nonce is remembered.
 *
 * Longer than the whole window a fresh gesture can occupy (issued up to one
 * window in the future, accepted up to one window late), with a minute of
 * margin, so a replay is refused by the nonce while it is still fresh and by
 * the window once the nonce is forgotten. There is no instant at which neither
 * holds.
 */
export const RELAY_NONCE_RETENTION_MS = 2 * RELAY_GESTURE_WINDOW_MS + 60_000;

/**
 * How long a relay proposal stays open (APRV-455 refuter L2).
 *
 * The onboarding review is answered in the screen that rendered it, so an hour
 * is generous; past it the prompt retires from every channel queue by
 * derivation, and a control plane whose resident came back later proposes
 * again. Until a proposal is attested the bytes on disk are not the policy in
 * force, so the control plane restores the in-force bytes when a proposal is
 * declined or lapses.
 */
export const RELAY_PROPOSAL_TTL_MS = 60 * 60_000;

/** The actor a proposal is recorded under when the operator names none. */
export const RELAY_DEFAULT_PROPOSER = "agent:edgeos-relay";

/**
 * What {@link recordChannelDecision} is handed as the configured actor.
 *
 * Never recorded. `requireSenderMapping` refuses every path that would fall
 * back to it, and it is an `agent:` id on purpose, so that if any such path
 * existed the gate would refuse it `actor-not-human` rather than record a
 * decision under it.
 */
const RELAY_UNMAPPED_ACTOR = "agent:edgeos-relay";

/** The gestures, closed. */
export const RELAY_GESTURES = ["propose", "attest", "decline", "grant", "reject"] as const;

export type RelayGestureName = (typeof RELAY_GESTURES)[number];

/**
 * Every refusal THIS transport makes, and nothing else. Frozen, per SPEC.md
 * §11.1 invariant 6, and pinned by `conformance/vectors/refusal-unions.v1.json`
 * because the control plane on the other side of the hop is a second
 * implementation that branches on these strings.
 *
 * Refusals the GATE or the decision surface makes (`sender-unmapped`,
 * `expired`, `policy-drift`, `already-decided`, `proposal-stale`,
 * `proposal-not-found`, ...) are not here: they arrive verbatim under
 * `refusal` in the response body, from their own unions, exactly as a Telegram
 * tap would surface them.
 *
 * None of these appends to the log. A post the relay refuses is a fact about
 * the transport and is counted and reported on stderr, because an endpoint
 * that wrote its refusals into the approval log would let anyone who can reach
 * it grow the record a human is asked to trust.
 */
export const RELAY_REFUSAL_CODES = [
  /** No secret header, or one that is not the launch environment's secret. */
  "relay-secret-mismatch",
  /** More than one secret header. Malformed, and not resolvable by choosing. */
  "relay-duplicate-secret-header",
  /** The request line and the Host header do not form a URL. */
  "relay-malformed-request",
  /** A path this transport does not serve. */
  "relay-unknown-path",
  /** The right path, a method other than POST. */
  "relay-method-not-allowed",
  /** Larger than {@link RELAY_MAX_BODY_BYTES}. */
  "relay-body-too-large",
  /** The body could not be read off the socket, or is not JSON. */
  "relay-body-unreadable",
  /** JSON that is not a gesture of the closed shape. */
  "relay-body-invalid",
  /**
   * The sender is not an EdgeOS account this transport can report: a channel
   * other than `edgeos`, or an id outside the grammar `senders.edgeos` pins.
   */
  "relay-sender-invalid",
  /** `issued_at` is further than {@link RELAY_GESTURE_WINDOW_MS} from now. */
  "relay-gesture-stale",
  /** This nonce was already used within {@link RELAY_NONCE_RETENTION_MS}. */
  "relay-nonce-replayed",
  /**
   * The nonce ledger could not be written, so a replay could not be refused.
   * Fails closed: nothing is decided without it.
   */
  "relay-nonce-unavailable",
  /**
   * `propose` named a hash that is not the hash of the policy file on disk.
   * Distinct from the gate's `proposal-stale`, which is the same fact found at
   * ACCEPTANCE: this one is found before anything is proposed.
   */
  "relay-policy-mismatch",
  /** The gesture threw while being applied. Nothing is claimed about the log. */
  "relay-handler-failed",
] as const;

export type RelayRefusalCode = (typeof RELAY_REFUSAL_CODES)[number];

/** A parsed, shape-checked gesture. */
export type RelayGesture =
  | {
      gesture: "attest" | "decline";
      policySha256: string;
      sender: ChannelSender;
      nonce: string;
      issuedAtMs: number;
    }
  | {
      gesture: "grant" | "reject";
      actionKey: string;
      sender: ChannelSender;
      nonce: string;
      issuedAtMs: number;
    }
  | { gesture: "propose"; policySha256: string; nonce: string; issuedAtMs: number };

export type RelayParse =
  | { ok: true; gesture: RelayGesture }
  | { ok: false; code: RelayRefusalCode; message: string };

const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
/** RFC 3339 in UTC, `Z` only: one spelling, so two implementations agree on it. */
const ISSUED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const ACTION_KEY_MAX = 512;

/** The keys each gesture admits. Anything else is `relay-body-invalid`. */
const ALLOWED_KEYS: Record<RelayGestureName, readonly string[]> = {
  propose: ["gesture", "policy_sha256", "nonce", "issued_at"],
  attest: ["gesture", "policy_sha256", "sender", "nonce", "issued_at"],
  decline: ["gesture", "policy_sha256", "sender", "nonce", "issued_at"],
  grant: ["gesture", "action_key", "sender", "nonce", "issued_at"],
  reject: ["gesture", "action_key", "sender", "nonce", "issued_at"],
};

function invalid(message: string): RelayParse {
  return { ok: false, code: "relay-body-invalid", message };
}

function isGestureName(value: unknown): value is RelayGestureName {
  return typeof value === "string" && (RELAY_GESTURES as readonly string[]).includes(value);
}

/**
 * Check one decoded body against the closed shape.
 *
 * Pure: no clock, no file, no log. Freshness and the nonce are the server's,
 * because both need state this function deliberately does not hold.
 */
export function parseRelayGesture(value: unknown): RelayParse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid("the body is not a JSON object");
  }
  const body = value as Record<string, unknown>;
  const name = body["gesture"];
  if (!isGestureName(name)) {
    return invalid(`gesture must be one of ${RELAY_GESTURES.join(", ")}`);
  }
  const allowed = ALLOWED_KEYS[name];
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      return invalid(
        `${JSON.stringify(key)} is not a field of a ${name} gesture (${allowed.join(", ")}). Unknown fields are refused rather than ignored, so nothing that looks like authority can ride along on a valid post`,
      );
    }
  }
  for (const key of allowed) {
    if (!(key in body)) return invalid(`a ${name} gesture requires ${JSON.stringify(key)}`);
  }

  const nonce = body["nonce"];
  if (typeof nonce !== "string" || !NONCE_PATTERN.test(nonce)) {
    return invalid("nonce must be 16 to 128 characters of A-Z, a-z, 0-9, underscore and hyphen");
  }
  const issuedAt = body["issued_at"];
  const issuedAtMs = typeof issuedAt === "string" && ISSUED_AT_PATTERN.test(issuedAt) ? Date.parse(issuedAt) : Number.NaN;
  if (Number.isNaN(issuedAtMs)) {
    return invalid("issued_at must be an RFC 3339 instant in UTC, ending in Z");
  }

  if (name === "propose") {
    const sha = body["policy_sha256"];
    if (typeof sha !== "string" || !SHA256_PATTERN.test(sha)) {
      return invalid("policy_sha256 must be 64 lowercase hex characters");
    }
    return { ok: true, gesture: { gesture: name, policySha256: sha, nonce, issuedAtMs } };
  }

  const senderValue = body["sender"];
  if (typeof senderValue !== "object" || senderValue === null || Array.isArray(senderValue)) {
    return invalid("sender must be an object {channel, id}");
  }
  const senderBody = senderValue as Record<string, unknown>;
  for (const key of Object.keys(senderBody)) {
    if (key !== "channel" && key !== "id") {
      return invalid(`${JSON.stringify(key)} is not a field of sender (channel, id)`);
    }
  }
  if (senderBody["channel"] !== RELAY_CHANNEL) {
    return {
      ok: false,
      code: "relay-sender-invalid",
      message: `sender.channel must be ${JSON.stringify(RELAY_CHANNEL)}: this transport reports EdgeOS sessions and nothing else, and a gesture naming another channel's account would borrow that channel's attribution`,
    };
  }
  const id = senderBody["id"];
  if (typeof id !== "string" || !isEdgeosSenderId(id)) {
    return {
      ok: false,
      code: "relay-sender-invalid",
      message:
        "sender.id is not an EdgeOS id this runtime compares: an ASCII letter or digit, then up to 127 letters, digits, '.', '_' or '-'. It is the raw /humans/me id, never a digest and never an email address",
    };
  }
  const sender: ChannelSender = { channel: RELAY_CHANNEL, id };

  if (name === "attest" || name === "decline") {
    const sha = body["policy_sha256"];
    if (typeof sha !== "string" || !SHA256_PATTERN.test(sha)) {
      return invalid("policy_sha256 must be 64 lowercase hex characters");
    }
    return { ok: true, gesture: { gesture: name, policySha256: sha, sender, nonce, issuedAtMs } };
  }

  const actionKey = body["action_key"];
  if (typeof actionKey !== "string" || actionKey.length === 0 || actionKey.length > ACTION_KEY_MAX) {
    return invalid(`action_key must be a non-empty string of at most ${String(ACTION_KEY_MAX)} characters`);
  }
  if (isAttestationActionKey(actionKey)) {
    // The gate would route it to the attestation path, which is a door this
    // shape does not offer under that name: an attestation is `attest` with a
    // policy hash, so the gesture a person made and the gesture recorded are
    // never two different words.
    return invalid("a policy.attest: key is answered with the attest or decline gesture, not grant or reject");
  }
  return { ok: true, gesture: { gesture: name, actionKey, sender, nonce, issuedAtMs } };
}

/** Is `issuedAtMs` within the window of `nowMs`? */
export function relayGestureFresh(issuedAtMs: number, nowMs: number): boolean {
  return Math.abs(nowMs - issuedAtMs) <= RELAY_GESTURE_WINDOW_MS;
}

// ---------------------------------------------------------------------------
// Nonce ledger
// ---------------------------------------------------------------------------

/** What claiming one nonce came to. */
export type NonceClaim = "claimed" | "replayed" | { error: string };

/**
 * Where used nonces are remembered.
 *
 * One file per nonce, named by its SHA-256, written whole to a private temp and
 * then hard-linked into place, under the gate's own `daemon/` directory. The
 * file system settles the race: `link` fails with EEXIST exactly as `O_EXCL`
 * does, so of any number of processes claiming one nonce at once exactly one
 * wins, and a claim file never exists without the time it was claimed.
 * That is why two relays on one gate need no lease between them for replay
 * protection, and why a restart forgets nothing it was still obliged to
 * remember. Files older than {@link RELAY_NONCE_RETENTION_MS} are pruned.
 */
export interface NonceLedger {
  claim(nonce: string, nowMs: number): NonceClaim;
}

let tempCounter = 0;

/** How often the ledger prunes, at most. */
const PRUNE_INTERVAL_MS = 60_000;

/** The file ledger described at {@link NonceLedger}. */
export function fileNonceLedger(dir: string): NonceLedger {
  let lastPrune = Number.NEGATIVE_INFINITY;
  function prune(nowMs: number): void {
    if (nowMs - lastPrune < PRUNE_INTERVAL_MS) return;
    lastPrune = nowMs;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      try {
        if (/^[a-f0-9]{64}$/u.test(name)) {
          // The claim time is the file's own content rather than its mtime, so
          // a copy or a restore that touched every file does not extend them
          // all. A claim file is linked into place already holding its content
          // (see `claim`), so it is never seen empty; anything that does not
          // parse as a positive time is judged by mtime instead, which is the
          // strict direction for a file this pass did not write.
          const text = readFileSync(path, "utf8").trim();
          const claimed = /^[1-9][0-9]*$/u.test(text) ? Number(text) : Number.NaN;
          const age = Number.isFinite(claimed) ? nowMs - claimed : nowMs - statSync(path).mtimeMs;
          if (age > RELAY_NONCE_RETENTION_MS) unlinkSync(path);
        } else if (name.endsWith(".tmp") && nowMs - statSync(path).mtimeMs > RELAY_NONCE_RETENTION_MS) {
          // A temp left by a claim that died between write and link.
          unlinkSync(path);
        }
      } catch {
        // Another process pruned it first, or it is mid-write: either way it
        // is not this pass's to judge.
      }
    }
  }
  return {
    claim(nonce: string, nowMs: number): NonceClaim {
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      } catch (cause) {
        return { error: cause instanceof Error ? cause.message : String(cause) };
      }
      prune(nowMs);
      const path = join(dir, createHash("sha256").update(nonce, "utf8").digest("hex"));
      // Written whole to a private temp, then LINKED into place: `link` fails
      // with EEXIST exactly as `O_EXCL` does, so one claimant wins, and the
      // claim file never exists without its content, so a concurrent prune can
      // never judge a half-made claim (APRV-455 refuter M1).
      tempCounter += 1;
      const temp = `${path}.${String(process.pid)}.${String(tempCounter)}.tmp`;
      try {
        writeFileSync(temp, `${String(nowMs)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      } catch (cause) {
        return { error: cause instanceof Error ? cause.message : String(cause) };
      }
      try {
        linkSync(temp, path);
        return "claimed";
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
          return { error: cause instanceof Error ? cause.message : String(cause) };
        }
      } finally {
        try {
          unlinkSync(temp);
        } catch {
          // Already gone; its absence is the desired state.
        }
      }
      // It exists. A file left by a claim older than the retention is a nonce
      // this ledger is no longer obliged to remember, and the window has
      // already refused anything that old, so reaching here with one means
      // the prune has not run yet; it is still refused, which is the strict
      // direction and costs a legitimate caller nothing (nonces are fresh).
      return "replayed";
    },
  };
}

// ---------------------------------------------------------------------------
// Applying a gesture
// ---------------------------------------------------------------------------

/** What applying a gesture produced: an HTTP status and the JSON body. */
export interface RelayResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface ApplyRelayOptions {
  /** The gate options a decision runs under: the policy location, the clock. */
  gateOptions: DecideOptions;
  /** The actor a `propose` is recorded under. */
  proposer: string;
}

/** A transport refusal as a response. Never appended. */
export function relayRefusal(status: number, code: RelayRefusalCode, message: string): RelayResponse {
  return { status, body: { error: { code, message } } };
}

/** The policy file this process enforces, resolved as the gate resolves it. */
function relayPolicyPath(options: DecideOptions): string {
  const policy = options.policy;
  if (policy?.file !== undefined) return policy.file;
  return proposalPolicyPath(policy?.dir ?? process.cwd());
}

/**
 * Turn one checked gesture into a log event, or into the refusal that replaces
 * one.
 *
 * Decisions and attestations go through {@link recordChannelDecision}, the one
 * place a reported gesture becomes a log event, with `requireSenderMapping` set
 * and the channel named `edgeos`. A proposal goes through `proposeAttestation`.
 * Nothing here decides anything those two do not already decide.
 */
export function applyRelayGesture(
  logPath: string,
  gesture: RelayGesture,
  options: ApplyRelayOptions,
): RelayResponse {
  if (gesture.gesture === "propose") return applyPropose(logPath, gesture, options);

  let decision: ChannelDecision;
  if ("policySha256" in gesture) {
    decision = {
      action_key: attestationActionKey(gesture.policySha256),
      decision: gesture.gesture === "attest" ? "grant" : "reject",
      deliveryId: `relay:${gesture.nonce}`,
      sender: gesture.sender,
    };
  } else {
    decision = {
      action_key: gesture.actionKey,
      decision: gesture.gesture,
      deliveryId: `relay:${gesture.nonce}`,
      sender: gesture.sender,
    };
  }

  const result = recordChannelDecision(
    logPath,
    decision,
    { actor: RELAY_UNMAPPED_ACTOR, channel: RELAY_CHANNEL, requireSenderMapping: true },
    options.gateOptions,
  );
  // `result.token` is deliberately never read: see the module doc. A raw token
  // has no route off this surface, into a response, a log line or stderr.
  const outcome = result.outcome;
  if (!outcome.ok) {
    return {
      status: 409,
      body: {
        ok: false,
        gesture: gesture.gesture,
        refusal: { code: outcome.code, message: outcome.message },
      },
    };
  }
  return {
    status: 200,
    body: {
      ok: true,
      gesture: gesture.gesture,
      action_key: outcome.action_key,
      event: outcome.record.event,
      seq: outcome.record.seq,
      actor: outcome.record.actor,
      state: outcome.state,
      token_issued: outcome.tokenIssued,
    },
  };
}

function applyPropose(
  logPath: string,
  gesture: Extract<RelayGesture, { gesture: "propose" }>,
  options: ApplyRelayOptions,
): RelayResponse {
  const policyPath = relayPolicyPath(options.gateOptions);
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(policyPath);
  } catch (cause) {
    return relayRefusal(
      409,
      "relay-policy-mismatch",
      `the policy file ${policyPath} could not be read to confirm it is the bytes this proposal names (${cause instanceof Error ? cause.message : String(cause)}); nothing was proposed`,
    );
  }
  const live = policyBytesHash(bytes);
  if (live !== gesture.policySha256) {
    return relayRefusal(
      409,
      "relay-policy-mismatch",
      `this proposal names ${gesture.policySha256} and the policy file on disk hashes ${live}. A proposal binds the bytes a person will be asked to accept, and these are not the bytes the caller rendered; nothing was proposed. Write the rendered policy first, then propose its hash`,
    );
  }

  const schemaOptions =
    options.gateOptions.schemaDir === undefined ? {} : { schemaDir: options.gateOptions.schemaDir };
  const read = readVerifiedRecords(logPath, schemaOptions);
  if (!read.ok) {
    return {
      status: 409,
      body: { ok: false, gesture: "propose", refusal: { code: read.code, message: read.message } },
    };
  }

  // Idempotent on a retry: an open proposal of exactly these bytes is the
  // answer, and a second record asking the same question would only make two
  // prompts for one acceptance to answer.
  const existing = openProposalFor(read.records, live, tick(options.gateOptions));
  if (existing !== null) {
    return {
      status: 200,
      body: { ok: true, gesture: "propose", sha256: live, seq: existing.seq, existing: true },
    };
  }

  // The baseline for the semantic diff: the in-force text, recovered from the
  // payload store and verified against the attested digest by the module that
  // recovers it, and verified AGAIN by `summarizeDiff` before it is used. No
  // caller material is a baseline here.
  const storeDir = options.gateOptions.payloadStoreDir ?? payloadStoreDirFor(logPath);
  const inForce = inForcePolicyText(read.records, storeDir);
  const baseline = inForce.ok ? Buffer.from(inForce.text, "utf8") : null;

  const proposed = proposeAttestation(
    logPath,
    {
      policyPath,
      baseline,
      reaffirm: true,
      waitUntil: new Date(Date.parse(tick(options.gateOptions)) + RELAY_PROPOSAL_TTL_MS).toISOString(),
    },
    options.proposer,
    {
      ...schemaOptions,
      ...(options.gateOptions.clock === undefined ? {} : { clock: options.gateOptions.clock }),
      ...(options.gateOptions.payloadStoreDir === undefined
        ? {}
        : { payloadStoreDir: options.gateOptions.payloadStoreDir }),
    },
  );
  if (!proposed.ok) {
    return {
      status: 409,
      body: {
        ok: false,
        gesture: "propose",
        refusal: { code: proposed.code, message: proposed.message },
      },
    };
  }
  if (proposed.sha256 !== gesture.policySha256) {
    // The file changed between the relay's hash check and the proposal's own
    // read. The proposal already appended names bytes the caller never
    // rendered; nothing can be attested unseen (acceptance re-hashes, and the
    // caller attests by the hash IT named, which this proposal is not), and
    // the caller is told rather than handed a hash it did not ask for.
    return relayRefusal(
      409,
      "relay-policy-mismatch",
      `the policy file changed while this proposal was being made: it names ${gesture.policySha256} and the proposal recorded at seq ${String(proposed.record.seq)} is of ${proposed.sha256}. Write the rendered policy again and propose its hash; an acceptance of ${gesture.policySha256} finds no open proposal and attests nothing`,
    );
  }
  return {
    status: 200,
    body: {
      ok: true,
      gesture: "propose",
      sha256: proposed.sha256,
      seq: proposed.record.seq,
      existing: false,
      // A reaffirmation is a proposal whose bytes are the attested bytes: the
      // record says so itself, by naming the same hash twice.
      reaffirm: proposed.record.payload?.[POLICY_HASH_FIELD] === proposed.sha256,
      changes: proposed.diff.headline,
      loads: proposed.load.ok,
    },
  };
}
