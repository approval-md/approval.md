/**
 * Known-answer tests for `alg: "sha256/jcs"` (APRV-6).
 *
 * `schema/fixtures/hash/known-answer.json` is a permanent wire commitment: the
 * digests in it were produced once by this implementation and frozen. If a
 * change to the canonicalizer or the writer moves any of these values, the
 * change is a hash-scheme migration (SPEC.md §8) and needs a new `alg`, not a
 * new fixture. Both layers are pinned — the JCS string *and* the SHA-256 over
 * it — so a serialization regression cannot hide behind a matching digest.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { canonicalize } from "../src/core/jcs.js";
import {
  appendEvent,
  computeRecordHash,
  verifyRecordHash,
  type EventInput,
  type EventRecord,
  type UnhashedRecord,
} from "../src/core/log.js";
import { validate } from "../src/core/validate.js";

interface KnownAnswer {
  name: string;
  note: string;
  input: UnhashedRecord;
  expected_canonical: string;
  expected_hash: string;
}

const FIXTURE_PATH = fileURLToPath(
  new URL("../../schema/fixtures/hash/known-answer.json", import.meta.url),
);

const vectors = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as KnownAnswer[];

const scratch = mkdtempSync(join(tmpdir(), "approval-md-kat-"));

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

test("the fixture carries the vectors it is supposed to", () => {
  assert.ok(Array.isArray(vectors));
  assert.ok(vectors.length >= 3, "at least genesis, a chained record, and a unicode record");
  assert.equal(vectors[0]?.input.prev, null, "the first vector is a genesis record");
  assert.equal(vectors[1]?.input.prev, vectors[0]?.expected_hash, "the second vector chains");
  for (const vector of vectors) {
    assert.equal(vector.input.alg, "sha256/jcs");
    assert.match(vector.expected_hash, /^[a-f0-9]{64}$/);
  }
});

for (const vector of vectors) {
  test(`known answer: ${vector.name} canonicalizes to the frozen JCS string`, () => {
    assert.equal(canonicalize(vector.input), vector.expected_canonical);
  });

  test(`known answer: ${vector.name} digests to the frozen hash`, () => {
    assert.equal(computeRecordHash(vector.input), vector.expected_hash);
  });

  test(`known answer: ${vector.name} verifies as a complete record`, () => {
    const record = { ...vector.input, hash: vector.expected_hash } as EventRecord;
    assert.ok(verifyRecordHash(record));
    assert.deepEqual(validate("event", record), { ok: true });
  });
}

test("the writer reproduces the frozen chain end to end", () => {
  const logPath = join(scratch, "chain", "events.jsonl");

  for (const [index, vector] of vectors.entries()) {
    // Feed only caller content; the writer must stamp seq, prev, alg, and hash
    // itself and arrive at exactly the frozen digest.
    const source = vector.input;
    const content: EventInput = {
      ts: source.ts,
      event: source.event,
      actor: source.actor,
    };
    if (source.task !== undefined) content.task = source.task;
    if (source.action_key !== undefined) content.action_key = source.action_key;
    if (source.channel !== undefined) content.channel = source.channel;
    if (source.payload !== undefined) content.payload = source.payload;

    const result = appendEvent(logPath, content);
    assert.ok(result.ok, `append ${vector.name} failed`);
    assert.equal(result.record.seq, index + 1);
    assert.equal(result.record.hash, vector.expected_hash, `${vector.name} digest`);
    // The stored line is the canonicalization of the *complete* record, i.e.
    // the frozen hash input with the frozen digest folded back in.
    assert.equal(
      result.line,
      canonicalize({ ...vector.input, hash: vector.expected_hash }),
      `${vector.name} stored bytes`,
    );
  }

  const lines = readFileSync(logPath, "utf8").split("\n").filter((line) => line.length > 0);
  assert.deepEqual(
    lines,
    vectors.map((vector) => canonicalize({ ...vector.input, hash: vector.expected_hash })),
  );
});
