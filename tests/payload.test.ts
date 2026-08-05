/**
 * Content-binding hashes (`core/payload.ts`, amended SPEC.md §6.2, A1).
 *
 * The hash is the whole mechanism: the gate refuses a manual action without
 * one, the grant records it, and the token module refuses to spend against
 * different bytes. If two implementations disagree about the digest of the same
 * payload, every one of those checks becomes a false refusal — so what is
 * pinned here is the *derivation*, against RFC 8785 by hand.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { canonicalize } from "../src/core/jcs.js";
import {
  isPayloadHash,
  payloadHash,
  PAYLOAD_HASH_PATTERN,
  runPayloadHash,
} from "../src/core/payload.js";

/** The definition, spelled out independently of the implementation. */
function byHand(value: unknown): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

test("payloadHash is SHA-256 over the RFC 8785 canonical serialization", () => {
  const payload = { to: ["agency@example.co.uk"], subject: "Deposit", body: "Hello." };
  assert.equal(payloadHash(payload), byHand(payload));
  assert.match(payloadHash(payload), PAYLOAD_HASH_PATTERN);
});

test("key order does not change the hash — that is what canonicalization is for", () => {
  // Two objects an adapter in another language might build in either order.
  assert.equal(
    payloadHash({ b: 2, a: 1, c: [3, { z: 1, y: 2 }] }),
    payloadHash({ c: [3, { y: 2, z: 1 }], a: 1, b: 2 }),
  );
});

test("different bytes hash differently, including whitespace inside values", () => {
  assert.notEqual(payloadHash({ body: "Hello." }), payloadHash({ body: "Hello. " }));
  assert.notEqual(payloadHash({ body: "Hello." }), payloadHash({ Body: "Hello." }));
});

test("runPayloadHash binds the argv array AND the cwd (SPEC.md §6.2)", () => {
  const argv = ["rm", "-rf", "build"];
  assert.equal(runPayloadHash(argv, "/repo/a"), byHand({ argv, cwd: "/repo/a" }));

  // The cwd is inside the hash on purpose: `rm -rf build` means two different
  // things in two different directories, and a binding that ignored the working
  // directory would approve one of them and execute the other.
  assert.notEqual(runPayloadHash(argv, "/repo/a"), runPayloadHash(argv, "/repo/b"));

  // Argv is ordered, and re-splitting an argument is a different command.
  assert.notEqual(runPayloadHash(["a", "b"], "/x"), runPayloadHash(["b", "a"], "/x"));
  assert.notEqual(runPayloadHash(["a b"], "/x"), runPayloadHash(["a", "b"], "/x"));
});

test("runPayloadHash is deterministic and does not alias its input", () => {
  const argv = ["node", "script.js"];
  const first = runPayloadHash(argv, "/x");
  argv.push("--extra");
  assert.equal(runPayloadHash(["node", "script.js"], "/x"), first);
});

test("isPayloadHash accepts only 64 lowercase hex characters", () => {
  assert.equal(isPayloadHash("a".repeat(64)), true);
  assert.equal(isPayloadHash("A".repeat(64)), false, "uppercase is a different string");
  assert.equal(isPayloadHash("a".repeat(63)), false);
  assert.equal(isPayloadHash("a".repeat(65)), false);
  assert.equal(isPayloadHash(""), false);
  assert.equal(isPayloadHash(undefined), false);
  assert.equal(isPayloadHash(123), false);
});
