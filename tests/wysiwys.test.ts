/**
 * The canonical renderer (APRV-119) — WYSIWYS.
 *
 * The property under test is a security property, not a formatting one: the
 * prompt a human approves must be a deterministic function of the payload bytes
 * and the action class, so two channels (or two versions of one) cannot show two
 * humans two different readings of the same payload without the difference being
 * detectable. The tests here pin each half of that sentence.
 *
 * Emilia RT-079's root threat model, restated: "if the approval UI renders benign
 * text while the hashed payload is malicious, the human signs blind."
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { payloadHash } from "../src/core/payload.js";
import { proposalPayloadValue } from "../src/core/policy-proposal.js";
import {
  canonicalRender,
  displayHashOf,
  rawBytesLine,
  ABSENT,
  CANONICAL_BEGIN,
  CANONICAL_END,
  CANONICAL_JSON_HEADING,
  CANONICAL_KINDS,
  CANONICAL_RENDERER_VERSION,
  COMMAND_VIEW_HEADING,
  DISPLAY_HASH_FIELD,
  EDIT_VIEW_HEADING,
  ELSEWHERE_QUALIFIER,
  EMAIL_VIEW_HEADING,
  LIVE_QUALIFIER,
  OPAQUE_VIEW_HEADING,
  PROPOSAL_QUALIFIER,
} from "../src/core/wysiwys.js";

const CLASS = "communicate.email.external";

/** One payload of each kind, so every test below covers the whole closed set. */
const SAMPLES: Record<string, unknown> = {
  command: { command: "gh pr create --body 'a\nb'", cwd: "/repo" },
  "file-change": {
    tool: "Edit",
    rule: "protected-path",
    file: "/repo/APPROVAL.md",
    before: "a",
    after: "b",
  },
  email: { to: ["a@b.example"], subject: "s", body: "line one\nline two" },
  opaque: { anything: "else", nested: { n: 1 } },
};

// ---------------------------------------------------------------------------
// AC #1 — determinism
// ---------------------------------------------------------------------------

test("the same payload and class always render byte-identically (APRV-119 #1)", () => {
  for (const [kind, payload] of Object.entries(SAMPLES)) {
    const first = canonicalRender(payload, CLASS);
    // Repeated invocations, in the same process: nothing accumulates, nothing
    // is memoized into a different answer, no counter leaks into the text.
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const again = canonicalRender(payload, CLASS);
      assert.equal(again.text, first.text, `${kind} rendered differently on attempt ${attempt}`);
      assert.equal(again.display_hash, first.display_hash, `${kind} hash moved`);
      assert.equal(again.kind, first.kind, `${kind} changed kind`);
    }

    // And from a structurally equal value built separately, which is the case
    // that matters: two channels each parse the payload store's file for
    // themselves and must arrive at the same reading.
    const reparsed: unknown = JSON.parse(JSON.stringify(payload));
    assert.equal(canonicalRender(reparsed, CLASS).text, first.text, `${kind} is not reproducible`);
  }
});

test("display_hash is the SHA-256 of the text, and the version is inside it", () => {
  for (const payload of Object.values(SAMPLES)) {
    const rendering = canonicalRender(payload, CLASS);
    assert.equal(
      rendering.display_hash,
      createHash("sha256").update(rendering.text, "utf8").digest("hex"),
      "display_hash is not the digest of the text it is supposed to name",
    );
    // The version rides INSIDE the hashed text. A version alongside the digest
    // would let two renderer versions produce one digest for two readings.
    assert.ok(
      rendering.text.includes(`renderer: ${CANONICAL_RENDERER_VERSION}`),
      "the renderer version is not inside the hashed text",
    );
    assert.equal(rendering.version, CANONICAL_RENDERER_VERSION);
  }
});

test("a different class is a different rendering, and a different display_hash", () => {
  const payload = SAMPLES["command"];
  const one = canonicalRender(payload, "exec.local");
  const other = canonicalRender(payload, "policy.edit");
  assert.notEqual(one.text, other.text, "the class does not reach the rendering");
  assert.notEqual(one.display_hash, other.display_hash);
  assert.ok(one.text.includes("class: exec.local"));
  assert.ok(other.text.includes("class: policy.edit"));
  // The binding is the same in both: the class changes what the human is told
  // about the action, never which bytes it is.
  assert.equal(payloadHash(payload), payloadHash(payload));
});

test("two payloads that differ at all render differently", () => {
  const seen = new Map<string, string>();
  const payloads: unknown[] = [
    { command: "rm -rf /tmp/a", cwd: "/repo" },
    { command: "rm -rf /tmp/b", cwd: "/repo" },
    { command: "rm -rf /tmp/a", cwd: "/other" },
    { command: "rm -rf /tmp/a" },
    { to: ["a@b.example"], subject: "s", body: "b" },
    { to: ["a@b.example"], subject: "s", body: "b", cc: [] },
    { to: ["a@b.example"], subject: "s", body: "" },
  ];
  for (const payload of payloads) {
    const rendering = canonicalRender(payload, CLASS);
    const first = seen.get(rendering.display_hash);
    assert.equal(
      first,
      undefined,
      `two payloads share a display_hash: ${String(first)} and ${JSON.stringify(payload)}`,
    );
    seen.set(rendering.display_hash, JSON.stringify(payload));
  }
});

// ---------------------------------------------------------------------------
// AC #2 — no ambient inputs, closed field sets, explicit absence
// ---------------------------------------------------------------------------

/**
 * The renderer's purity, checked against its own source.
 *
 * A runtime test cannot prove the absence of an ambient read; reading the module
 * can, for the ambient reads that exist. The list is every way this codebase
 * could reach a clock, a locale, an environment, a random source or the disk.
 */
test("the renderer reaches no clock, locale, env, randomness or IO (APRV-119 #2)", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../../src/core/wysiwys.ts", import.meta.url)),
    "utf8",
  );
  // Comments explain the rules and legitimately name the forbidden things; the
  // check is over CODE, so strip block comments and line comments first.
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(?:^|\s)\/\/.*$/gmu, "");

  const forbidden: [string, RegExp][] = [
    ["a clock", /\bDate\b|\bperformance\.now\b|\bhrtime\b/u],
    ["a locale", /toLocale[A-Za-z]*|Intl\./u],
    ["the environment", /process\.env|\bprocess\.(?:cwd|platform|argv)\b/u],
    ["randomness", /Math\.random|randomUUID|randomBytes/u],
    ["IO", /node:fs|node:child_process|node:net|node:http|readFileSync|writeFileSync|fetch\(/u],
  ];
  for (const [what, pattern] of forbidden) {
    const match = pattern.exec(code);
    assert.equal(match, null, `core/wysiwys.ts reaches ${what}: ${String(match?.[0])}`);
  }

  // `node:crypto` is the one node import, and it is used for exactly one thing.
  const imports = [...code.matchAll(/from "(node:[^"]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(imports, ["node:crypto"], "the renderer grew a second node dependency");
});

test("every payload renders as exactly one of the closed kinds", () => {
  for (const [expected, payload] of Object.entries(SAMPLES)) {
    const rendering = canonicalRender(payload, CLASS);
    assert.equal(rendering.kind, expected);
    assert.ok(CANONICAL_KINDS.includes(rendering.kind), `${rendering.kind} is not a declared kind`);
    assert.ok(rendering.text.includes(`payload kind: ${expected}`));
  }

  // The four headings are mutually exclusive: a rendering carries exactly one.
  const headings = [
    COMMAND_VIEW_HEADING,
    EDIT_VIEW_HEADING,
    EMAIL_VIEW_HEADING,
    OPAQUE_VIEW_HEADING,
  ];
  for (const payload of Object.values(SAMPLES)) {
    const text = canonicalRender(payload, CLASS).text;
    assert.equal(
      headings.filter((heading) => text.includes(heading)).length,
      1,
      "a rendering carried more than one structural view",
    );
  }
});

test("a field the payload does not carry renders as an explicit absence", () => {
  const email = canonicalRender({ to: ["a@b.example"], subject: "s", body: "b" }, CLASS).text;
  for (const label of ["from", "cc", "bcc", "content_type"]) {
    assert.ok(email.includes(`${label}: ${ABSENT}`), `email ${label} was omitted, not marked`);
  }

  const write = canonicalRender(
    { tool: "Write", file: "/repo/x", content: "a" },
    "policy.edit",
  ).text;
  for (const label of ["rule", "replace_all"]) {
    assert.ok(write.includes(`${label}: ${ABSENT}`), `file-change ${label} was omitted, not marked`);
  }

  // A command with no cwd states the absence in its own words, which predate
  // this task and are already explicit; what must never happen is silence.
  const command = canonicalRender({ command: "ls" }, "exec.local").text;
  assert.ok(command.includes("cwd: (none declared)"), command);
});

test("nothing is hidden: an unrenderable key makes the payload opaque, whole", () => {
  // One key the email view cannot show, so the shape is not an email at all —
  // and the bytes are then shown entire rather than field by field minus one.
  const payload = { to: ["a@b.example"], subject: "s", body: "b", reply_to: "c@d.example" };
  const text = canonicalRender(payload, CLASS).text;
  assert.equal(text.includes(EMAIL_VIEW_HEADING), false, "a payload was half-rendered as an email");
  assert.ok(text.includes(OPAQUE_VIEW_HEADING), text);
  assert.ok(text.includes('"reply_to": "c@d.example"'), "the unshowable key left the rendering");
});

test("the canonical block is self-describing and delimited", () => {
  const payload = SAMPLES["email"];
  const text = canonicalRender(payload, CLASS).text;
  assert.ok(text.startsWith(CANONICAL_BEGIN), text);
  assert.ok(text.endsWith(CANONICAL_END), text);
  assert.ok(text.includes(`class: ${CLASS}`));
  assert.ok(text.includes(`payload sha256: ${payloadHash(payload)}`));
  // And the route back to the bytes, which under wysiwys/2 is this line rather
  // than a JSON appendix (APRV-162).
  assert.ok(text.includes(rawBytesLine(payloadHash(payload))), text);
});

// ---------------------------------------------------------------------------
// APRV-162 — the structural view is the whole reading
// ---------------------------------------------------------------------------

test("a structured kind renders no canonical-JSON appendix; opaque IS that JSON", () => {
  for (const kind of ["command", "file-change", "email"]) {
    const text = canonicalRender(SAMPLES[kind], CLASS).text;
    assert.equal(
      text.includes(CANONICAL_JSON_HEADING),
      false,
      `${kind} still shows the payload a second time as JSON`,
    );
  }

  const opaque = canonicalRender(SAMPLES["opaque"], CLASS).text;
  assert.ok(opaque.includes(CANONICAL_JSON_HEADING), opaque);
  assert.ok(opaque.includes(JSON.stringify(SAMPLES["opaque"], null, 2)), "the bytes are not shown");
});

test("every structural view names the payload store, so the bytes stay reachable", () => {
  for (const kind of ["command", "file-change", "email"]) {
    const payload = SAMPLES[kind];
    const text = canonicalRender(payload, CLASS).text;
    assert.ok(text.includes(rawBytesLine(payloadHash(payload))), `${kind} lost the store pointer`);
  }
});

test("a long change and a long command render whole: no view folds (APRV-162)", () => {
  const lines = Array.from({ length: 400 }, (_, index) => `line ${String(index)}`);
  const change = canonicalRender(
    { tool: "Write", file: "/repo/x", content: lines.join("\n") },
    "policy.edit",
  ).text;
  for (const line of lines) assert.ok(change.includes(`+${line}`), `${line} was folded away`);

  const command = canonicalRender(
    { command: lines.map((line) => `echo ${line}`).join("\n"), cwd: "/repo" },
    "exec.local",
  ).text;
  for (const line of lines) assert.ok(command.includes(`echo ${line}`), `${line} was folded away`);

  // The wording the old fold used, in any rendering, is now a defect.
  for (const text of [change, command]) {
    assert.equal(/more lines \(hash covers all bytes\)/u.test(text), false, text.slice(0, 200));
  }
});

test("each protected-path tier renders its own qualifier, and never another's", () => {
  const base = { tool: "Edit", file: "/repo/APPROVAL.md", before: "a", after: "b" };
  const cases: [string, string, string[]][] = [
    ["protected-path", LIVE_QUALIFIER, [PROPOSAL_QUALIFIER, ELSEWHERE_QUALIFIER]],
    ["protected-path-proposal", PROPOSAL_QUALIFIER, [LIVE_QUALIFIER, ELSEWHERE_QUALIFIER]],
    ["protected-name-elsewhere", ELSEWHERE_QUALIFIER, [LIVE_QUALIFIER, PROPOSAL_QUALIFIER]],
  ];
  for (const [rule, expected, forbidden] of cases) {
    const text = canonicalRender({ ...base, rule }, "policy.edit").text;
    assert.ok(text.includes(`note: ${expected}`), `${rule} lost its qualifier`);
    for (const other of forbidden) {
      assert.equal(text.includes(other), false, `${rule} borrowed another tier's wording`);
    }
  }
});

test("an attestation prompt's policy text still renders opaque, whole (APRV-162 #9)", () => {
  // The shape `core/policy-proposal.ts` stores: no structural view claims it,
  // so the approver reads the policy bytes as the canonical JSON they are.
  const payload = proposalPayloadValue("/repo/APPROVAL.md", "defaults:\n  autonomy: manual\n");
  const rendering = canonicalRender(payload, "policy.edit");
  assert.equal(rendering.kind, "opaque");
  assert.ok(rendering.text.includes(OPAQUE_VIEW_HEADING), rendering.text);
  assert.ok(rendering.text.includes(CANONICAL_JSON_HEADING), rendering.text);
  assert.ok(rendering.text.includes(JSON.stringify(payload, null, 2)), "the policy text is not shown");
});

test("displayHashOf answers nothing for a payload that cannot be bound to", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  assert.equal(displayHashOf(cyclic, CLASS), null);
  assert.throws(() => canonicalRender(cyclic, CLASS));
  // And the ordinary case still answers, so the null above is the exception.
  assert.equal(displayHashOf(SAMPLES["email"], CLASS), canonicalRender(SAMPLES["email"], CLASS).display_hash);
});

test("the field name the gate writes is the one this module declares", () => {
  assert.equal(DISPLAY_HASH_FIELD, "display_hash");
});
