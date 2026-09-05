#!/usr/bin/env node
/**
 * Regenerate `conformance/vectors/*.v1.json` and the manifest (APRV-122).
 *
 * The INPUTS below are authored by hand; every `expect` block is computed by
 * running this repository's own code through `dist/tests/conformance-harness.js`
 * and then frozen. Nothing is transcribed from a second implementation's output
 * and nothing is hand-written into an expectation — a vector file is either what
 * the reference implementation does or it is not written at all.
 *
 * Run `npm run build` first; this script reads the built harness.
 *
 *   node scripts/regen-conformance-vectors.mjs
 *
 * A regeneration that changes an expectation is a BEHAVIOUR CHANGE and must be
 * reviewed as one: the vectors are the conformance definition of SPEC.md §13,
 * so a diff here is a diff in what a second implementation is required to do.
 *
 * Provenance of the transcribed material:
 *
 * - the RFC 8785 §3.2.2/§3.2.3 examples and the Appendix B number bit patterns
 *   are the RFC's own. They reach this file as INPUTS only; their expected
 *   serializations are computed here and independently pinned against the
 *   RFC's published values by `tests/rfc8785-vectors.test.ts`, which embeds
 *   them verbatim.
 * - the refusal-code unions are SPEC.md §11.1 invariant 6, read from the
 *   runtime constants that define them.
 *
 * ## Two entry points, one generator (APRV-231)
 *
 * Generating and writing are separated, because a committed vector file that
 * has fallen behind the fixtures it is generated from is drift nobody sees:
 *
 * - `generateConformance()` is exported and returns the bytes of every vector
 *   file and of the manifest. It writes nothing and prints nothing, so
 *   `tests/conformance-regen.test.ts` can regenerate in memory and fail when
 *   what is committed is not what the current fixtures produce;
 * - running this file as a command writes those same bytes to disk, which is
 *   the only effect anything in this file has.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const VECTORS_DIR = join(REPO_ROOT, "conformance", "vectors");
const MANIFEST_PATH = join(REPO_ROOT, "conformance", "conformance-manifest.json");

/** Where the committed schema fixtures live. A test may generate from a copy. */
export const DEFAULT_FIXTURES_ROOT = join(REPO_ROOT, "schema", "fixtures");

const { execute } = await import(join(REPO_ROOT, "dist", "tests", "conformance-harness.js"));
const { canonicalize } = await import(join(REPO_ROOT, "dist", "src", "core", "jcs.js"));
const { payloadHash } = await import(join(REPO_ROOT, "dist", "src", "core", "payload.js"));

// ---------------------------------------------------------------------------
// Shared material
// ---------------------------------------------------------------------------

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
  "  read.*:",
  "    autonomy: autonomous",
  "  files.write.*:",
  "    autonomy: supervised",
  "  files.write.local:",
  "    autonomy: autonomous",
  "  communicate.email.external:",
  "    autonomy: manual",
  "  financial.*:",
  "    autonomy: manual",
  "    limits:",
  "      per_action_usd: 25",
  "      daily_usd: 100",
  "```",
  "",
].join("\n");

/**
 * A policy that routes protected paths to `policy.edit` sub-classes (APRV-266).
 *
 * `design/` gets its own line, `SPEC.md` gets none: the pair is what makes the
 * inheritance rule visible, because the first resolves by its own rule and the
 * second by the `policy.edit` line it is a sub-class of. `.github/workflows/`
 * is here too, routed STRICTER than the line, because it is a path the runtime
 * protects on its own and is therefore the one the load-time floor governs.
 */
const POLICY_ROUTED = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "1h"',
  "  on_expiry: reject",
  "protected_paths:",
  "  - { path: SPEC.md, class: policy.edit.spec }",
  "  - { path: design/, class: policy.edit.design }",
  "  - { path: .github/workflows/, class: policy.edit.ci }",
  "classes:",
  "  read.*:",
  "    autonomy: autonomous",
  "  policy.edit:",
  "    autonomy: supervised-live",
  "    live_rate: 0.1",
  "  policy.edit.design:",
  "    autonomy: supervised",
  "  policy.edit.ci:",
  "    autonomy: manual",
  "```",
  "",
].join("\n");

/**
 * The same routing with the floor broken (APRV-266): `.github/workflows/` is a
 * built-in `policy.edit` path, and routing it to an `autonomous` sub-class
 * would take it out of the gate without removing a path from any list.
 *
 * A control, and a fail-closed one: the policy does not load, so EVERY class
 * resolves to `manual`. An implementation that loaded it and honoured the
 * routing has narrowed its own protected surface on the strength of a file it
 * should have refused.
 */
const POLICY_ROUTE_FLOOR_BROKEN = POLICY_ROUTED.replace(
  "  policy.edit.ci:\n    autonomy: manual",
  "  policy.edit.ci:\n    autonomy: autonomous",
);

/**
 * SPEC.md §5.2's request-volume limits, one policy per limit (APRV-173).
 *
 * Written separately rather than as one policy carrying both, so each vector
 * pins ONE refusal: with both ceilings at 1 the queue check fires first and the
 * rate-limit vector would assert a code it never reached.
 */
function policyWithLimits(limits) {
  return [
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
    "    limits:",
    ...limits.map((line) => `      ${line}`),
    "```",
    "",
  ].join("\n");
}

const POLICY_MAX_PENDING = policyWithLimits(["max_pending: 1"]);
const POLICY_REQUESTS_PER_HOUR = policyWithLimits(["requests_per_hour: 1"]);

/** A policy whose YAML does not parse: everything must fall to `manual`. */
const POLICY_BROKEN = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "classes:",
  "  read.*:",
  "   autonomy: [unclosed",
  "```",
  "",
].join("\n");

const PAYLOAD = { to: "agency@example.co.uk", subject: "Deposit", body: "Please refund." };
const INVOICE_PAYLOAD = { invoice: "INV-1" };

// The content binding of amended SPEC.md §6.2, computed from the bytes rather
// than invented: a request whose declared hash does not match what it presents
// is refused `payload-mismatch`, so a made-up digest would make every gate
// vector below assert the wrong thing.
const BOUND_HASH = payloadHash(PAYLOAD);
const INVOICE_HASH = payloadHash(INVOICE_PAYLOAD);

function envelope(actions, extra = {}) {
  return {
    origin: { app: "example-capture", created_by: "human:carter" },
    state: "proposed",
    actions,
    ...extra,
  };
}

const EMAIL_ACTION = {
  class: "communicate.email.external",
  summary: "Send the deposit chaser",
  reversible: false,
  est_cost_usd: "0.02",
  idempotency_key: "task-042:chaser",
  payload_hash: BOUND_HASH,
};

const READ_ACTION = {
  class: "read.file",
  summary: "Read the ledger",
  reversible: true,
  est_cost_usd: "0",
  idempotency_key: "task-042:read",
};

// ---------------------------------------------------------------------------
// Suite 1 — JCS canonicalization (folds in and supersedes the clean-room kit's
// extracted/jcs-vectors.json, which had no envelope, no failure classes, and no
// manifest pin)
// ---------------------------------------------------------------------------

const RFC_SORTING = String.raw`{"\u20ac":"Euro Sign","\r":"Carriage Return","\ufb33":"Hebrew Letter Dalet With Dagesh","1":"One","\ud83d\ude00":"Emoji: Grinning Face","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis"}`;
const RFC_FULL = String.raw`{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"\u20ac$\u000f\nA'B\"\\\\\"\/","literals":[null,true,false]}`;

const JCS_STRUCTURAL = [
  ["rfc8785-3.2.3-sorting", "RFC 8785 §3.2.3 property sorting: keys emerge in code-unit order regardless of input order", RFC_SORTING],
  ["rfc8785-3.2.2-full-example", "RFC 8785 §3.2.2 example: numbers, escaped string, literals", RFC_FULL],
  ["null", "the null literal", "null"],
  ["true", "the true literal", "true"],
  ["false", "the false literal", "false"],
  ["string-plain", "a string with nothing to escape", '"approval"'],
  ["int", "an integer", "17"],
  ["empty-object", "an empty object", "{}"],
  ["empty-array", "an empty array", "[]"],
  ["empty-key", "the empty string is a legal key and sorts first", '{"a":1,"":2}'],
  ["sort-ascii", "ASCII keys sort by code unit, so uppercase precedes lowercase", '{"b":1,"A":2,"a":3,"B":4}'],
  ["sort-prefix", "a key that is a prefix of another sorts before it", '{"ab":1,"a":2,"abc":3}'],
  ["sort-astral", "an astral key sorts by UTF-16 code units, not by code point", '{"\u{1f600}":1,"דּ":2,"€":3}'],
  ["array-order", "array order is data and is never sorted", '["b","a","c"]'],
  ["nested-sort", "sorting applies at every level", '{"z":{"b":1,"a":2},"a":[{"d":1,"c":2}]}'],
  ["esc-quote", "a quotation mark escapes as \\\"", String.raw`"a\"b"`],
  ["esc-backslash", "a reverse solidus escapes as \\\\", String.raw`"a\\b"`],
  ["esc-shorts", "the short escapes RFC 8785 requires: backspace, form feed, newline, return, tab", String.raw`"\b\f\n\r\t"`],
  ["esc-nul", "U+0000 escapes as \\u0000", String.raw`"\u0000"`],
  ["esc-bel", "U+0007 has no short escape and takes the \\u form", String.raw`"\u0007"`],
  ["esc-esc", "U+001B takes the \\u form", String.raw`"\u001b"`],
  ["esc-us", "U+001F is the last control that must be escaped", String.raw`"\u001f"`],
  ["esc-solidus", "a solidus is NOT escaped on output", String.raw`"a\/b"`],
  ["esc-del", "U+007F is emitted literally: it is not a C0 control", String.raw`"\u007f"`],
  ["esc-nonascii", "non-ASCII is emitted as UTF-8, never as \\u escapes", String.raw`"é€"`],
  ["esc-astral", "an astral character survives as one code point", String.raw`"😀"`],
  [
    "record-shape",
    "an approval.md record canonicalizes with every level sorted; the monetary amount is the decimal string of APRV-121, so this vector freezes the post-121 record shape",
    '{"payload":{"note":"go, but cc me","est_cost_usd":"0.5","tags":["b","a"]},"actor":"human:carter","seq":17}',
  ],
];

const JCS_NUMBERS = [
  ["0000000000000000", "zero"],
  ["8000000000000000", "minus zero serializes as 0"],
  ["0000000000000001", "smallest positive subnormal"],
  ["8000000000000001", "smallest negative subnormal"],
  ["7fefffffffffffff", "largest finite positive"],
  ["ffefffffffffffff", "largest finite negative"],
  ["4340000000000000", "max safe integer plus one"],
  ["c340000000000000", "min safe integer minus one"],
  ["4430000000000000", "an integer boundary"],
  ["44b52d02c7e14af5", "just below 1e+23"],
  ["44b52d02c7e14af6", "1e+23"],
  ["44b52d02c7e14af7", "just above 1e+23"],
  ["444b1ae4d6e2ef4e", "just below 1e+21"],
  ["444b1ae4d6e2ef4f", "just below 1e+21, the next double"],
  ["444b1ae4d6e2ef50", "1e+21, where the exponent form begins"],
  ["3eb0c6f7a0b5ed8c", "just below 0.000001"],
  ["3eb0c6f7a0b5ed8d", "0.000001, where the exponent form ends"],
  ["41b3de4355555553", "successive doubles around 333333333.333"],
  ["41b3de4355555554", "successive doubles around 333333333.333"],
  ["41b3de4355555555", "successive doubles around 333333333.333"],
  ["41b3de4355555556", "successive doubles around 333333333.333"],
  ["41b3de4355555557", "successive doubles around 333333333.333"],
  ["becbf647612f3696", "a negative fraction"],
  ["43143ff3c1cb0959", "round to even"],
];

const JCS_REJECTIONS = [
  ["7fffffffffffffff", "NaN has no JSON number form: canonicalization must refuse, never emit null"],
  ["7ff0000000000000", "Infinity has no JSON number form: canonicalization must refuse, never emit null"],
];

const jcsVectors = [
  ...JCS_STRUCTURAL.map(([id, description, source]) => ({
    id,
    description,
    input: { input_json: source },
  })),
  ...JCS_NUMBERS.map(([bits, note]) => ({
    id: `number-${bits}`,
    description: `ECMAScript number serialization, ${note}`,
    input: { ieee754_bits: bits },
  })),
  ...JCS_REJECTIONS.map(([bits, note]) => ({
    id: `reject-${bits}`,
    description: note,
    control: true,
    input: { ieee754_bits: bits },
  })),
];

// ---------------------------------------------------------------------------
// Suite 2 — the refusal-code unions of SPEC.md §11.1 invariant 6 (folds in and
// supersedes the clean-room kit's extracted/refusal-unions.json)
// ---------------------------------------------------------------------------

const unionVectors = [
  ["gate_refusal_codes", "every way `approval register|request|decide|withdraw|expire` can refuse"],
  ["token_verify_refusal_codes", "every way a presented token can fail verification"],
  ["token_refusal_codes", "the token verbs' union: verification plus the log-and-append failures"],
  ["execute_refusal_codes", "every way `approval run` and the adapter contract can refuse"],
  ["append_error_codes", "every way the write boundary itself can refuse an append"],
  [
    "anchor_refusal_codes",
    "every way the log-anchoring check can refuse a working log that contradicts the committed copy of it",
  ],
  [
    "checkpoint_refusal_codes",
    "every way the human-signed checkpoint check can refuse a range whose signed heads the log contradicts",
  ],
].map(([union, description]) => ({
  id: `union-${union}`,
  description: `${description}. Order is definition order; conformance means emitting exactly these codes, no more, no fewer.`,
  input: { union },
}));

unionVectors.push({
  id: "union-unknown",
  description:
    "a union name no implementation defines must be refused, not answered with an empty list — an empty union would let a checker report full coverage of nothing",
  control: true,
  input: { union: "there_is_no_such_union" },
});

// ---------------------------------------------------------------------------
// Suite 3 — policy resolution: matching, specificity, the irreversibility floor
// ---------------------------------------------------------------------------

const policyVectors = [
  {
    id: "exact-literal-wins",
    description: "an exact class match takes the rule written for it",
    input: { policy: POLICY, class: "communicate.email.external" },
  },
  {
    id: "trailing-star-matches-any-depth",
    description: "`read.*` governs `read.file.local`: a trailing `.*` matches any depth",
    input: { policy: POLICY, class: "read.file.local" },
  },
  {
    id: "specificity-literal-beats-wildcard",
    description:
      "`files.write.local` and `files.write.*` both match; the one with more literal segments wins, and it is the LOOSER of the two — specificity, not strictness, decides which rule applies",
    input: { policy: POLICY, class: "files.write.local" },
  },
  {
    id: "specificity-wildcard-when-no-literal",
    description: "`files.write.remote` has no literal rule, so the wildcard governs",
    input: { policy: POLICY, class: "files.write.remote" },
  },
  {
    id: "unmatched-falls-to-default",
    description: "a class no rule matches takes `defaults.autonomy`",
    input: { policy: POLICY, class: "physical.actuate" },
  },
  {
    id: "floor-irreversible-blocks-autonomous",
    description:
      "SPEC.md §7 irreversibility floor: `reversible: false` cannot resolve `autonomous` however the policy is written, and the resolution says the floor applied",
    input: { policy: POLICY, class: "read.file", reversible: false },
  },
  {
    id: "floor-not-applied-when-reversible",
    description: "the same class and rule, reversible: the floor does not engage",
    input: { policy: POLICY, class: "read.file", reversible: true },
  },
  {
    id: "floor-leaves-supervised-alone",
    description:
      "the floor bounds `autonomous` only: an irreversible action under a supervised rule stays supervised",
    input: { policy: POLICY, class: "files.write.remote", reversible: false },
  },
  {
    id: "floor-unstated-reversibility-is-not-a-claim",
    description:
      "an action that does not say whether it is reversible does not engage the floor; the claim is the agent's to make and its absence is not a permission",
    input: { policy: POLICY, class: "read.file" },
  },
  {
    id: "limits-travel-with-the-matched-rule",
    description: "the matched rule's limits are what the budget evaluator is handed",
    input: { policy: POLICY, class: "financial.spend" },
  },
  {
    id: "fail-closed-unparseable-policy",
    description:
      "an unparseable policy resolves EVERYTHING to manual with no matched rule: SPEC.md §5.2 fail-closed. A conforming implementation must not fall back to a default policy, an empty policy, or the last good one",
    control: true,
    input: { policy: POLICY_BROKEN, class: "read.file" },
  },
  {
    id: "fail-closed-unparseable-policy-irreversible",
    description: "the same, for an irreversible action: still manual, and still no rule",
    control: true,
    input: { policy: POLICY_BROKEN, class: "financial.spend", reversible: false },
  },
  // --- routed policy.edit sub-classes (APRV-266) ----------------------------
  {
    id: "routed-subclass-with-its-own-rule",
    description:
      "a `policy.edit` sub-class a `protected_paths` entry routes to, with a rule of its own: it resolves by that rule like any other class, which is the whole point of routing — one protected surface no longer means one autonomy",
    input: { policy: POLICY_ROUTED, class: "policy.edit.design" },
  },
  {
    id: "routed-subclass-inherits-the-policy-edit-line",
    description:
      "a `policy.edit` sub-class with NO rule of its own inherits the `policy.edit` line, with provenance `inherited` rather than `default`. The general no-rule-matched rule is narrowed here and only here: falling to `defaults.autonomy` would gate every routed path the moment a project adopted routing, which reads as the feature being broken. `inherited` is distinct from `rule` because the winning pattern does not match the class being resolved, and a trace that claimed it did would send a reader looking for a line that is not there",
    input: { policy: POLICY_ROUTED, class: "policy.edit.spec" },
  },
  {
    id: "routed-builtin-path-may-be-routed-stricter",
    description:
      "`.github/workflows/` is protected by the runtime whatever a policy says, and routing it to a sub-class the policy declares MANUAL — stricter than its own supervised-live `policy.edit` line — is exactly what routing is for. The load-time floor bounds this in one direction only: stricter always loads, and the companion control shows what looser costs",
    input: { policy: POLICY_ROUTED, class: "policy.edit.ci" },
  },
  {
    id: "routed-namespace-does-not-generalize",
    description:
      "the inheritance rule is the `policy.edit` namespace and nothing else: a class outside it with no matching rule still takes `defaults.autonomy`. A universal parent walk would silently change the resolution of every class in SPEC.md §7's taxonomy — `read` is manual in a policy whose `read.*` is autonomous, precisely because a bare namespace is not matched by its own wildcard (§5.2)",
    input: { policy: POLICY_ROUTED, class: "read" },
  },
  {
    id: "fail-closed-routing-below-the-protected-floor",
    description:
      "`protected_paths` is additive: it may widen the protected surface and may never narrow it. A routing that would resolve a BUILT-IN protected path below what the `policy.edit` line itself resolves to is refused at load with `protected-route-floor`, and the policy is inoperative — so every class, including unrelated ones, resolves to manual with no matched rule. An implementation that loaded this file and honoured the routing has let a policy edit its way out of the gate",
    control: true,
    input: { policy: POLICY_ROUTE_FLOOR_BROKEN, class: "policy.edit.ci" },
  },
];

// ---------------------------------------------------------------------------
// Suite 4 — chain verification
// ---------------------------------------------------------------------------

const KAT = JSON.parse(
  readFileSync(join(REPO_ROOT, "schema", "fixtures", "hash", "known-answer.json"), "utf8"),
);

/** The frozen known-answer chain as complete log lines. */
const CHAIN = KAT.map((vector) =>
  // The stored line is the canonicalization of the COMPLETE record: the frozen
  // hash input with the frozen digest folded back in. Built here from the two
  // frozen halves through the repo's own canonicalizer, so this suite's inputs
  // are derived from the known-answer fixture rather than hand-typed twice.
  canonicalize({ ...vector.input, hash: vector.expected_hash }),
);

/** One character of a hex digest, changed. Enough to break a chain. */
function flipHex(text, marker) {
  const index = text.indexOf(marker);
  if (index === -1) throw new Error(`marker ${marker} not found`);
  const digit = text[index + marker.length - 1];
  const replacement = digit === "0" ? "1" : "0";
  return `${text.slice(0, index + marker.length - 1)}${replacement}${text.slice(index + marker.length)}`;
}

const HEAD = { seq: 3, hash: KAT[2].expected_hash };

const chainVectors = [
  {
    id: "clean-chain",
    description: "the frozen known-answer chain verifies end to end",
    input: { lines: CHAIN },
  },
  {
    id: "clean-chain-anchored",
    description: "the same chain against an external anchor at its real head",
    input: { lines: CHAIN, expected_head: HEAD },
  },
  {
    id: "empty-log",
    description: "an empty log is clean with no head: nothing to contradict",
    input: { lines: [] },
  },
  {
    id: "genesis-only",
    description: "a one-record log verifies; `prev` is null exactly at seq 1",
    input: { lines: [CHAIN[0]] },
  },
  {
    id: "mutation-payload",
    description:
      "a byte changed inside a record's payload: the digest no longer matches the content it commits to",
    control: true,
    input: { lines: [CHAIN[0], CHAIN[1].replace("communicate.email.external", "read.file")] },
  },
  {
    id: "mutation-hash",
    description: "a record's own digest altered by one hex digit",
    control: true,
    input: { lines: [CHAIN[0], flipHex(CHAIN[1], '"hash":"')] },
  },
  {
    id: "mutation-prev",
    description: "a record's `prev` link altered: the chain no longer reaches its parent",
    control: true,
    input: { lines: [CHAIN[0], flipHex(CHAIN[1], '"prev":"')] },
  },
  {
    id: "truncation-unanchored",
    description:
      "records dropped off the tail with no anchor: the surviving prefix IS a valid chain, and nothing inside the file can contradict it. This is the detection boundary, stated as a vector so no implementation claims more than a hash chain can give",
    input: { lines: [CHAIN[0], CHAIN[1]] },
  },
  {
    id: "truncation-anchored",
    description: "the same truncation against an external anchor at the real head: caught",
    control: true,
    input: { lines: [CHAIN[0], CHAIN[1]], expected_head: HEAD },
  },
  {
    id: "torn-tail",
    description:
      "a final line with no terminating newline is a crashed write, reported as torn-tail and never as corruption",
    input: { lines: [...CHAIN, '{"seq":4,"ts":"2026-08-0'], final_newline: false },
  },
  {
    id: "reorder",
    description: "two records swapped: the succession breaks at the first one out of place",
    control: true,
    input: { lines: [CHAIN[0], CHAIN[2], CHAIN[1]] },
  },
  {
    id: "deletion-midchain",
    description: "a record spliced out of the middle: the survivor's `prev` names a record that is gone",
    control: true,
    input: { lines: [CHAIN[0], CHAIN[2]] },
  },
  {
    id: "duplicate-record",
    description: "a record repeated verbatim: `seq` no longer succeeds",
    control: true,
    input: { lines: [CHAIN[0], CHAIN[1], CHAIN[1]] },
  },
  {
    id: "not-genesis",
    description: "a first record whose `prev` is not null",
    control: true,
    input: { lines: [CHAIN[1]] },
  },
  {
    id: "alg-stripped",
    description:
      "the hash-scheme identifier removed: refused as a scheme problem, not as schema noise, because a record that does not say how it was hashed cannot be checked",
    control: true,
    input: { lines: [CHAIN[0].replace(',"alg":"sha256/jcs"', "")] },
  },
  {
    id: "alg-unknown",
    description: "an unrecognized `alg`: refused rather than assumed to be the one we know",
    control: true,
    input: { lines: [CHAIN[0].replace("sha256/jcs", "sha512/jcs")] },
  },
  {
    id: "malformed-line",
    description: "a line that is not JSON at all, mid-chain",
    control: true,
    input: { lines: [CHAIN[0], "{not json", CHAIN[2]] },
  },
  {
    id: "schema-invalid-line",
    description:
      "a record whose digest is self-consistent and whose actor prefix is not a principal kind: the write boundary's rules are re-checked on read",
    control: true,
    input: { lines: [CHAIN[0].replace('"actor":"agent:planner"', '"actor":"planner"')] },
  },
];

// ---------------------------------------------------------------------------
// Suite 5 — schema validation at the write boundary
// ---------------------------------------------------------------------------

/** Every committed schema fixture, with the class its refusal must carry. */
function schemaFixtureVectors(root) {
  const vectors = [];
  // Every schema in `schema/`, named rather than discovered, so adding one is a
  // reviewable diff. `values` joined in APRV-237 (SPEC.md §5.3): the block is
  // guidance and never enforcement, but the SHAPE it must have to be shown to a
  // human at all is a write-boundary rule like any other.
  for (const schema of ["envelope", "event", "policy", "sample-record", "values"]) {
    for (const kind of ["valid", "invalid"]) {
      const dir = join(root, schema, kind);
      let entries;
      try {
        entries = readdirSync(dir).filter((entry) => entry.endsWith(".json")).sort();
      } catch {
        continue;
      }
      for (const entry of entries) {
        const document = JSON.parse(readFileSync(join(dir, entry), "utf8"));
        vectors.push({
          id: `${schema}-${kind}-${entry.replace(/\.json$/u, "")}`,
          description:
            kind === "valid"
              ? `${schema} fixture ${entry}: accepted at the write boundary`
              : `${schema} fixture ${entry}: refused at the write boundary, with the constraint it violates named`,
          ...(kind === "invalid" ? { control: true } : {}),
          input: { schema, document, mode: "write" },
        });
      }
    }
  }
  return vectors;
}

/**
 * The schema suite's authored inputs, read from `fixturesRoot`.
 *
 * A function rather than a constant, and parameterised rather than fixed on
 * `schema/fixtures`, for two reasons: the fixtures are read when the suite is
 * generated instead of when this module is imported, and a test can generate
 * from a scratch copy of the fixtures to prove that a fixture added without a
 * regeneration is caught (APRV-231).
 */
function schemaVectors(fixturesRoot) {
  return [
    ...schemaFixtureVectors(fixturesRoot),
    {
      id: "event-historical-numeric-amount",
      description:
        "APRV-121 read boundary: a record written before the decimal-string change carries a JSON amount and MUST still validate in historical mode. The log is append-only, so this is permanent",
      input: {
        schema: "event",
        mode: "historical",
        document: JSON.parse(
          readFileSync(join(fixturesRoot, "event", "invalid", "est-cost-bare-number.json"), "utf8"),
        ),
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Suite 6 — gate verdicts
// ---------------------------------------------------------------------------

const REGISTER_EMAIL = {
  op: "register",
  task: "task-042",
  envelope: envelope([EMAIL_ACTION, READ_ACTION]),
  actor: "agent:claude",
};

const REQUEST_EMAIL = {
  op: "request",
  task: "task-042",
  action: "task-042:chaser",
  class: "communicate.email.external",
  est_cost_usd: "0.02",
  reversible: false,
  payload: PAYLOAD,
  actor: "agent:claude",
  at: 1,
};

// A second action of the SAME class, so the request-volume vectors below put
// two questions of one class in front of one approver (APRV-173).
const SECOND_EMAIL_ACTION = {
  class: "communicate.email.external",
  summary: "Send the second chaser",
  reversible: false,
  est_cost_usd: "0.02",
  idempotency_key: "task-042:chaser-2",
  payload_hash: INVOICE_HASH,
};

const REGISTER_TWO_EMAILS = {
  op: "register",
  task: "task-042",
  envelope: envelope([EMAIL_ACTION, SECOND_EMAIL_ACTION]),
  actor: "agent:claude",
};

const REQUEST_SECOND_EMAIL = {
  op: "request",
  task: "task-042",
  action: "task-042:chaser-2",
  class: "communicate.email.external",
  est_cost_usd: "0.02",
  reversible: false,
  payload: INVOICE_PAYLOAD,
  actor: "agent:claude",
  at: 2,
};

const gateVectors = [
  {
    id: "manual-request-is-recorded",
    description: "the manual path: an attested policy, a registered task, one approval.requested",
    input: { policy: POLICY, steps: [{ op: "attest", actor: "human:carter" }, REGISTER_EMAIL, REQUEST_EMAIL] },
  },
  {
    id: "autonomous-request-appends-no-approval-event",
    description:
      "amended SPEC.md §6.3: an autonomous action records no approval event and reports proceed",
    input: {
      policy: POLICY,
      steps: [
        { op: "attest", actor: "human:carter" },
        REGISTER_EMAIL,
        {
          op: "request",
          task: "task-042",
          action: "task-042:read",
          class: "read.file",
          est_cost_usd: "0",
          reversible: true,
          actor: "agent:claude",
          at: 1,
        },
      ],
    },
  },
  {
    id: "grant-is-recorded-by-a-human",
    description: "a human grants the pending request",
    input: {
      policy: POLICY,
      steps: [
        { op: "attest", actor: "human:carter" },
        REGISTER_EMAIL,
        REQUEST_EMAIL,
        { op: "decide", action: "task-042:chaser", decision: "grant", actor: "human:carter", at: 2 },
      ],
    },
  },
  {
    id: "policy-not-attested",
    description:
      "an unattested policy answers nothing: the gate refuses before the policy is consulted",
    control: true,
    input: { policy: POLICY, steps: [REGISTER_EMAIL, REQUEST_EMAIL] },
  },
  {
    id: "not-registered",
    description:
      "SPEC.md §7's declaration check: the log is asked what it knows about an action of a task it has never registered",
    control: true,
    input: {
      policy: POLICY,
      steps: [
        { op: "attest", actor: "human:carter" },
        { op: "lookup", task: "task-042", action: "task-042:chaser" },
      ],
    },
  },
  {
    id: "action-not-registered",
    description:
      "the same check for an idempotency key the registered envelope does not declare",
    control: true,
    input: {
      policy: POLICY,
      steps: [
        { op: "attest", actor: "human:carter" },
        REGISTER_EMAIL,
        { op: "lookup", task: "task-042", action: "task-042:undeclared" },
      ],
    },
  },
  {
    id: "lookup-registered-action",
    description:
      "the declaration check answering: the class and the declared amount come from the LOG's registration, not from the task file, which may have been edited since",
    input: {
      policy: POLICY,
      steps: [
        { op: "attest", actor: "human:carter" },
        REGISTER_EMAIL,
        { op: "lookup", task: "task-042", action: "task-042:chaser" },
      ],
    },
  },
  {
    id: "intake-checks-registration",
    description:
      "SPEC.md §7 at INTAKE (APRV-147): a manual request naming its own binding, for an action the log has never registered, is refused `not-registered` and appends nothing. A caller-supplied `payload_hash` is not a substitute for a declaration — admitting one would put a class, a cost and a summary the requester alone wrote in front of a human approver — so a conforming implementation refuses here, before the request is recorded, as well as at execution and at harness consumption",
    control: true,
    input: {
      policy: POLICY,
      steps: [
        { op: "attest", actor: "human:carter" },
        { ...REQUEST_EMAIL, payload_hash: BOUND_HASH },
      ],
    },
  },
  {
    id: "intake-not-registered-outranks-payload-hash-required",
    description:
      "the refusal ORDER at intake (APRV-147): with no registration and no binding anywhere, the answer is `not-registered` rather than `payload-hash-required`. The missing hash is a consequence of the missing declaration, and a refusal naming the symptom sends the caller to declare bytes for an action nothing knows about",
    control: true,
    input: {
      policy: POLICY,
      steps: [
        { op: "attest", actor: "human:carter" },
        { ...REQUEST_EMAIL, payload: undefined },
      ],
    },
  },
  {
    id: "intake-action-not-registered",
    description:
      "the same check one level in (APRV-147): the task IS registered and the requested idempotency key is not among its declared actions, so intake refuses `action-not-registered` and appends nothing",
    control: true,
    input: {
      policy: POLICY,
      steps: [
        { op: "attest", actor: "human:carter" },
        REGISTER_EMAIL,
        { ...REQUEST_EMAIL, action: "task-042:undeclared", payload_hash: BOUND_HASH },
      ],
    },
  },
  {
    id: "task-already-registered",
    description: "a second registration of the same task is envelope drift, not a registration",
    control: true,
    input: {
      policy: POLICY,
      steps: [{ op: "attest", actor: "human:carter" }, REGISTER_EMAIL, REGISTER_EMAIL],
    },
  },
  {
    id: "duplicate-request",
    description: "a second live request for one action key",
    control: true,
    input: {
      policy: POLICY,
      steps: [
        { op: "attest", actor: "human:carter" },
        REGISTER_EMAIL,
        REQUEST_EMAIL,
        { ...REQUEST_EMAIL, at: 2 },
      ],
    },
  },
  {
    id: "payload-hash-required",
    description:
      "a manual action requested with no payload material: SPEC.md §10.4 needs the bytes a human is deciding about, so the request is refused rather than delivered as a summary",
    control: true,
    input: {
      policy: POLICY,
      steps: [
        { op: "attest", actor: "human:carter" },
        {
          op: "register",
          task: "task-042",
          actor: "agent:claude",
          envelope: envelope([
            {
              class: "communicate.email.external",
              summary: "Send the deposit chaser",
              reversible: false,
              est_cost_usd: "0.02",
              idempotency_key: "task-042:chaser",
            },
          ]),
        },
        { ...REQUEST_EMAIL, payload: undefined },
      ],
    },
  },
  {
    id: "actor-not-human",
    description: "an agent cannot grant: approval decisions are human-only",
    control: true,
    input: {
      policy: POLICY,
      steps: [
        { op: "attest", actor: "human:carter" },
        REGISTER_EMAIL,
        REQUEST_EMAIL,
        { op: "decide", action: "task-042:chaser", decision: "grant", actor: "agent:claude", at: 2 },
      ],
    },
  },
  {
    id: "not-requested",
    description: "a decision on an action nobody asked about",
    control: true,
    input: {
      policy: POLICY,
      steps: [
        { op: "attest", actor: "human:carter" },
        REGISTER_EMAIL,
        { op: "decide", action: "task-042:chaser", decision: "grant", actor: "human:carter", at: 2 },
      ],
    },
  },
  {
    id: "already-decided",
    description: "a second decision on one request",
    control: true,
    input: {
      policy: POLICY,
      steps: [
        { op: "attest", actor: "human:carter" },
        REGISTER_EMAIL,
        REQUEST_EMAIL,
        { op: "decide", action: "task-042:chaser", decision: "grant", actor: "human:carter", at: 2 },
        { op: "decide", action: "task-042:chaser", decision: "reject", actor: "human:carter", at: 3, note: "changed my mind" },
      ],
    },
  },
  {
    id: "request-withdrawn",
    description: "the requester retracts, and every later decision is refused",
    control: true,
    input: {
      policy: POLICY,
      steps: [
        { op: "attest", actor: "human:carter" },
        REGISTER_EMAIL,
        REQUEST_EMAIL,
        { op: "withdraw", action: "task-042:chaser", actor: "agent:claude", reason: "superseded", at: 2 },
        { op: "decide", action: "task-042:chaser", decision: "grant", actor: "human:carter", at: 3 },
      ],
    },
  },
  {
    id: "not-requester",
    description: "only the requester may withdraw",
    control: true,
    input: {
      policy: POLICY,
      steps: [
        { op: "attest", actor: "human:carter" },
        REGISTER_EMAIL,
        REQUEST_EMAIL,
        { op: "withdraw", action: "task-042:chaser", actor: "agent:other", reason: "superseded", at: 2 },
      ],
    },
  },
  {
    id: "expired-then-grant",
    description:
      "a grant after the TTL lapsed: the request expires and the late decision is refused",
    control: true,
    input: {
      policy: POLICY,
      steps: [
        { op: "attest", actor: "human:carter" },
        REGISTER_EMAIL,
        REQUEST_EMAIL,
        { op: "decide", action: "task-042:chaser", decision: "grant", actor: "human:carter", at: 180 },
      ],
    },
  },
  {
    id: "not-expired",
    description: "`expire` refuses a request whose TTL has not lapsed",
    control: true,
    input: {
      policy: POLICY,
      steps: [
        { op: "attest", actor: "human:carter" },
        REGISTER_EMAIL,
        REQUEST_EMAIL,
        { op: "expire", action: "task-042:chaser", at: 2 },
      ],
    },
  },
  {
    id: "budget-exceeded",
    description:
      "the matched rule's `per_action_usd` is 25 and the action declares 25.01: refused, and a budget.exceeded event records the refusal",
    control: true,
    input: {
      policy: POLICY,
      steps: [
        { op: "attest", actor: "human:carter" },
        {
          op: "register",
          task: "task-042",
          actor: "agent:claude",
          envelope: envelope([
            {
              class: "financial.spend",
              summary: "Pay the invoice",
              reversible: false,
              est_cost_usd: "25.01",
              idempotency_key: "task-042:pay",
              payload_hash: INVOICE_HASH,
            },
          ]),
        },
        {
          op: "request",
          task: "task-042",
          action: "task-042:pay",
          class: "financial.spend",
          est_cost_usd: "25.01",
          reversible: false,
          payload: INVOICE_PAYLOAD,
          actor: "agent:claude",
          at: 1,
        },
      ],
    },
  },
  {
    id: "queue-full",
    description:
      "SPEC.md §5.2 request-volume limits (APRV-173): the matched rule caps `max_pending` at 1 and one request for the class is already awaiting a decision, so the second is refused `queue-full` at intake. Nothing is appended — the record count is unchanged from before the refused request — because a log line per refused request would hand a queue-flooder the log growth it was refused the queue for",
    control: true,
    input: {
      policy: POLICY_MAX_PENDING,
      steps: [
        { op: "attest", actor: "human:carter" },
        REGISTER_TWO_EMAILS,
        REQUEST_EMAIL,
        REQUEST_SECOND_EMAIL,
      ],
    },
  },
  {
    id: "rate-limited",
    description:
      "SPEC.md §5.2 request-volume limits (APRV-173): the matched rule caps `requests_per_hour` at 1 for this origin and the origin created one a minute ago, so the second is refused `rate-limited`. Distinct from `queue-full`: the queue is not capped here at all, the caller's own volume is the ceiling, and the window is rolling rather than drained by a human. Nothing is appended",
    control: true,
    input: {
      policy: POLICY_REQUESTS_PER_HOUR,
      steps: [
        { op: "attest", actor: "human:carter" },
        REGISTER_TWO_EMAILS,
        REQUEST_EMAIL,
        REQUEST_SECOND_EMAIL,
      ],
    },
  },
  {
    id: "envelope-invalid-bare-number-amount",
    description:
      "APRV-121 at the gate: an envelope declaring `est_cost_usd` as a JSON number is refused at registration, so the number never reaches hashed material",
    control: true,
    input: {
      policy: POLICY,
      steps: [
        { op: "attest", actor: "human:carter" },
        {
          op: "register",
          task: "task-042",
          actor: "agent:claude",
          envelope: envelope([{ ...EMAIL_ACTION, est_cost_usd: 0.02 }]),
        },
      ],
    },
  },
];

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const SUITES = [
  {
    file: "jcs-canonicalization.v1.json",
    suite: "jcs-canonicalization",
    algorithm: "RFC 8785 (JSON Canonicalization Scheme), as required by `alg: sha256/jcs`",
    description:
      "The serialization every digest in SPEC.md §8 is taken over. Two implementations that disagree here agree about nothing else: the hash is over these bytes.",
    vectors: jcsVectors,
  },
  {
    file: "refusal-unions.v1.json",
    suite: "refusal-unions",
    // 3.0.0: two MAJOR bumps in sequence, each a pinned expectation moving
    // rather than a vector being added, because the vector pins each whole
    // array in definition order and a longer union is a changed expectation.
    // 2.0.0 (APRV-146): `execution-delegated` joined the execute union.
    // 3.0.0 (APRV-109): `gate_refusal_codes` gained the four codes the
    // attestation ceremony refuses with (diff-too-large, proposal-not-found,
    // proposal-stale, policy-already-attested) and `channel_tag_refusal_codes`
    // gained proposal-stale. An implementation conforming to either earlier
    // version emits a union this suite no longer accepts (conformance/README.md).
    // 4.0.0 (APRV-137): `gate_refusal_codes` gained `actor-not-approver`, the
    // refusal a grant by a person the resolved rule's `approvers` list does not
    // name now carries. The list was parsed and enforced nowhere before, so this
    // is a union that grew because a control started existing.
    // 5.0.0 (APRV-145): `gate_refusal_codes` gained `not-delegated` and
    // `already-finished`, the two refusals the completion counterpart of the
    // amended §10.2 can produce. `not-delegated` is the mirror of the execute
    // union's `execution-delegated`: that one stops a human recovery verb
    // closing a harness start, this one stops a harness report closing an
    // execution this runtime watched itself.
    // 6.0.0 (APRV-173): `gate_refusal_codes` gained `queue-full` and
    // `rate-limited`, the two refusals SPEC.md §5.2's request-volume limits
    // produce now that a runtime reads them. The vector pins the whole array in
    // definition order, so a longer union is a changed expectation and a major
    // bump, exactly as 4.0.0 and 5.0.0 were.
    // 7.0.0 (APRV-219): a SIXTH union, `anchor_refusal_codes`, for the
    // log-anchoring check's `anchor-diverged`. A major bump because this suite
    // pins WHICH unions exist as well as what each one holds: an
    // implementation that answers five of them covers five sixths of invariant
    // 6, and a runner reporting that as a pass would be reporting coverage of
    // work nobody did.
    // 8.0.0 (APRV-220): a SEVENTH union, `checkpoint_refusal_codes`, for the
    // human-signed checkpoint check. Major for the reason 7.0.0 was major: the
    // suite pins which unions exist, and an implementation that verifies a
    // chain and an anchor but cannot say what a bad checkpoint signature is
    // called has not implemented invariant 6 for checkpoints at all.
    vectors_version: "8.0.0",
    algorithm: "SPEC.md §11.1 invariant 6: refusals are machine-readable and distinct",
    description:
      "The closed unions of refusal codes. A caller branches on these strings, so adding, removing, or renaming one is a breaking change and shows up here as a diff.",
    vectors: unionVectors,
  },
  {
    file: "policy-resolution.v1.json",
    suite: "policy-resolution",
    // 2.0.0 (APRV-266): a MAJOR bump, and the reason is the `algorithm` line
    // below rather than the vector count. 1.0.0 stated the no-rule-matched rule
    // without qualification — `unmatched-falls-to-default` says a class no rule
    // matches takes `defaults.autonomy` — and an implementation that read the
    // suite and implemented exactly that is now wrong for one namespace: a
    // `policy.edit` sub-class with no rule of its own inherits the
    // `policy.edit` line, with a provenance 1.0.0 does not name. The five new
    // vectors move no existing expectation, but the general rule they narrow is
    // one a second implementation was required to implement, so a run that
    // passed 1.0.0 does not pass this.
    vectors_version: "2.0.0",
    algorithm:
      "SPEC.md §5.2 class matching and specificity, the policy.edit sub-class inheritance rule, §7 irreversibility floor",
    description:
      "Which rule governs an action, what autonomy it resolves to, where a routed policy.edit sub-class inherits from, and where the floor, the protected-path routing floor and the fail-closed rule bind.",
    vectors: policyVectors,
  },
  {
    file: "chain-verification.v1.json",
    suite: "chain-verification",
    algorithm: "SPEC.md §8 hash chain over `alg: sha256/jcs`",
    description:
      "Mutation, truncation, reorder, splice, duplication, and scheme tampering, each with the machine-readable reason a verifier must report. Includes the detection boundary: an unanchored truncation is a valid chain, and an implementation that claims to catch it is claiming more than a hash chain can give.",
    vectors: chainVectors,
  },
  {
    file: "schema-validation.v1.json",
    suite: "schema-validation",
    // 1.1.0 (APRV-109): a MINOR bump. The five `policy.proposed` /
    // `policy.declined` fixtures are new vectors; no existing expectation moved.
    // 1.2.0 (APRV-145): another MINOR bump. The four harness-counterpart
    // fixtures (a completion and a failure carrying `reported_by`, an open
    // `reported_by` string, a non-integer `exit_code`) are new vectors; no
    // existing expectation moved.
    // 1.3.0 (swept in by APRV-173's regeneration, authored earlier): the two
    // `env_stripped` event fixtures were committed without a regen, so the
    // suite did not cover them. New vectors, no expectation moved: a minor bump.
    // 1.4.0 (APRV-227): another MINOR bump. The four harness-provenance event
    // fixtures — a `task.registered` and a `gate.bypassed` carrying the
    // `harness`/`harness_version` pair, a multi-line version, an unknown
    // harness kind — are new vectors. No existing expectation moved: the two
    // names are OPTIONAL and additive, so every record written before them
    // validates exactly as it did.
    // 1.5.0 was claimed twice, on two branches that did not see each other:
    // APRV-220 published it from main, APRV-235 from its own branch, and each
    // carried a different vector set under the same number. Both claims are
    // superseded here. 1.6.0 is the single version that contains both, and
    // neither 1.5.0 is a version a second implementation should hold itself to.
    // 1.6.0 (APRV-220 + APRV-235): a MINOR bump carrying eighteen new vectors,
    // none of which moves an existing expectation. Seven are APRV-220's: the
    // five `log.checkpoint` event fixtures (a well-formed checkpoint, an agent
    // actor, a missing signature, a truncated signed hash, an unimplemented
    // signature alg) and the two policy fixtures for `audit.checkpoint_keys` /
    // `audit.checkpoint_every`. Five are APRV-235's: the
    // `audit.decision_refused` fixture with the two refusals that pin its
    // actor and its required code, and the `policy-drift` withdrawal with the
    // agent-authored one that must not validate. The other six are APRV-214's
    // `gate.opened` / `gate.closed` / `gate.bypassed` fixtures, committed
    // without a regen exactly as the `env_stripped` pair was before 1.3.0.
    // Nothing moved: both event types are new, so no record written before
    // them names either, and the two policy keys are OPTIONAL, so every policy
    // written before them validates exactly as it did. The only removed line
    // in the fixture diff is `count`.
    // 2.0.0 (APRV-266): a MAJOR bump, and a reluctant one — no fixture was
    // added and no new constraint was written. `protected_paths` gained the
    // routed `{path, class}` entry beside the bare string, so `items` is a
    // `oneOf` over two shapes, and two existing vectors move their
    // `failure_class` from `schema-pattern` to `schema-oneOf`: a `..` path and
    // an absolute path are still refused, still at `/protected_paths/0`, and
    // the `pattern` failure is still in the error list, but the union reports
    // itself first. Every alternative spelling was tried and each moves the
    // same expectation or worse — `if`/`then`/`else` on the entry type emits an
    // `if` error, and the flat form (`pattern` and `minLength` at the item
    // level, which JSON Schema ignores for an object) is refused by Ajv's
    // `strictTypes`. A second implementation holding itself to 1.6.0 refuses
    // the same documents this does; it names one of them differently, and the
    // suite's whole premise is that a refusal for the wrong reason is a
    // failure, so this is a major.
    vectors_version: "2.0.0",
    algorithm: "SPEC.md §8 write-boundary validation, JSON Schema 2020-12",
    description:
      "Every committed schema fixture, with the constraint each refusal violates named. Before APRV-122 the invalid fixtures asserted only that validation failed somehow; a refusal for the wrong reason passed.",
    // A function of the fixtures root, not a fixed array: this suite is
    // generated FROM the committed fixtures, which is exactly the pair that
    // APRV-231 pins against drift.
    vectors: schemaVectors,
  },
  {
    file: "gate-verdicts.v1.json",
    suite: "gate-verdicts",
    // 2.0.0, not 1.1.0: APRV-147 moved an expectation. The vector that said
    // intake does not check registration now says it does, and a second
    // implementation that passed 1.0.0 does not pass this.
    // 2.1.0 (APRV-173): a MINOR bump. The `queue-full` and `rate-limited`
    // vectors are new; no existing expectation moved, because no policy in this
    // suite declared a request-volume limit before.
    vectors_version: "2.1.0",
    algorithm: "SPEC.md §5.2/§6.3/§7/§10: the gate's admission, decision, and refusal paths",
    description:
      "Scripted scenarios over a scratch log: each is a policy, a sequence of gate operations, and the verdict of the last one. A step before the last that refuses is a broken vector and is reported as such rather than counted as a result.",
    vectors: gateVectors,
  },
];

/** The non-vector files the manifest pins alongside the suites. */
const MANIFEST_EXTRA_FILES = ["conformance/run.mjs", "tests/conformance-harness.ts"];

const MANIFEST_DESCRIPTION =
  "SHA-256 of every conformance vector file and of the reference runner, so a suite cannot change without the change being visible in one place. `npm test` fails on drift (tests/conformance.test.ts). Regenerate with scripts/regen-conformance-vectors.mjs, and review the diff: an expectation that moved is a behaviour change.";

/** The command that turns a generated result into the committed files. */
export const REGEN_COMMAND = "node scripts/regen-conformance-vectors.mjs";

/**
 * Generate every vector file and the manifest, in memory.
 *
 * Reads the authored inputs, the schema fixtures, and the built harness, and
 * returns the exact bytes the CLI entry would write. It creates nothing, writes
 * nothing, and prints nothing, so a test can call it and compare the result
 * against what is committed (`tests/conformance-regen.test.ts`).
 *
 * @param {{ fixturesRoot?: string }} [options]
 *   `fixturesRoot` defaults to `schema/fixtures`. A test passes a scratch copy
 *   to show that a fixture added there changes the generated suite.
 */
export function generateConformance(options = {}) {
  const fixturesRoot = options.fixturesRoot ?? DEFAULT_FIXTURES_ROOT;
  const files = [];
  const digests = {};
  for (const definition of SUITES) {
    const authored =
      typeof definition.vectors === "function"
        ? definition.vectors(fixturesRoot)
        : definition.vectors;
    const vectors = authored.map((vector) => {
      const input = JSON.parse(JSON.stringify(vector.input ?? {}));
      const expect = execute(definition.suite, input);
      const entry = { id: vector.id, description: vector.description };
      if (vector.control === true) entry.control = true;
      entry.input = input;
      entry.expect = expect;
      return entry;
    });
    const body = {
      suite: definition.suite,
      // A suite file carries its own version: a new vector is a minor bump and a
      // changed expectation a major one (conformance/README.md).
      vectors_version: definition.vectors_version ?? "1.0.0",
      algorithm: definition.algorithm,
      description: definition.description,
      provenance:
        "Generated by scripts/regen-conformance-vectors.mjs from this repository's own implementation. Inputs are authored by hand; every expectation is computed, never transcribed. See conformance/README.md for the runner contract.",
      count: vectors.length,
      vectors,
    };
    const contents = `${JSON.stringify(body, null, 2)}\n`;
    // Built with "/" rather than `path.join`, because a manifest key is a
    // portable repository path and not a path on the machine that generated it.
    const relative = `conformance/vectors/${definition.file}`;
    files.push({
      file: definition.file,
      relative,
      path: join(VECTORS_DIR, definition.file),
      contents,
      suite: definition.suite,
      vectors_version: body.vectors_version,
      count: vectors.length,
      controls: vectors.filter((vector) => vector.control === true).length,
    });
    digests[relative] = createHash("sha256").update(contents).digest("hex");
  }

  for (const relative of MANIFEST_EXTRA_FILES) {
    digests[relative] = createHash("sha256")
      .update(readFileSync(join(REPO_ROOT, relative)))
      .digest("hex");
  }

  const manifest = {
    manifest_version: "1.0.0",
    description: MANIFEST_DESCRIPTION,
    files: Object.fromEntries(Object.keys(digests).sort().map((key) => [key, digests[key]])),
  };
  return {
    files,
    manifest: {
      relative: "conformance/conformance-manifest.json",
      path: MANIFEST_PATH,
      contents: `${JSON.stringify(manifest, null, 2)}\n`,
      value: manifest,
    },
  };
}

/** The CLI entry: generate, then write. Everything above it is side-effect free. */
function main() {
  const generated = generateConformance();
  mkdirSync(VECTORS_DIR, { recursive: true });
  for (const file of generated.files) {
    writeFileSync(file.path, file.contents);
    console.log(
      `${file.file}: ${String(file.count)} vectors (${String(file.controls)} negative controls)`,
    );
  }
  writeFileSync(generated.manifest.path, generated.manifest.contents);
  console.log(
    `conformance-manifest.json: ${String(Object.keys(generated.manifest.value.files).length)} files pinned`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
