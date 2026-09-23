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

const POLICY_IRREVERSIBLE = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  "classes:",
  "  work.*:",
  "    autonomy: autonomous",
  "    allow_irreversible: true",
  "  '*.run':",
  "    autonomy: supervised-retro",
  "    allow_irreversible: true",
  "  policy.edit:",
  "    autonomy: supervised-retro",
  "    allow_irreversible: true",
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
  [
    "hook_deny_codes",
    "every way `approval hook <harness>` can deny a tool call before it runs; `hook-gate-refused` is a family whose emitted form is `hook-gate-refused:<gate refusal code>`",
  ],
  [
    "post_tool_codes",
    "every line the post-execution half of `approval hook <harness>` can print instead of closing a delegated execution; `post-tool-gate-refused` carries the gate's own code after a colon",
  ],
  [
    "channel_decision_refusal_codes",
    "every way a decision SURFACE can refuse a human's gesture before the gate sees it: the sender the transport authenticated resolves to nobody, or to more than one person, in the attested policy, or the attested policy maps that channel's senders in the keyed form and the process holds no key to compute a digest with, or the gesture is an attestation whose in-force policy cannot say who is tapping",
  ],
  [
    "bridge_refusal_codes",
    "every way `approval codex bridge` can decline an app-server approval request on its own, before or instead of asking the gate: a request whose command, directory or call identity is missing, one whose thread or turn mismatches or whose call identity repeats, a command string that names no argv it can bind, an item-based file change whose content it cannot produce from the `item/started` frame that item id names, one whose item had already completed when the question arrived, and a server request it has no reading for. It is NOT the verb's whole vocabulary: `bridge_stop_codes` carries the ways it ends a session instead of answering a request",
  ],
  [
    "bridge_stop_codes",
    "every way `approval codex bridge` STOPS a session rather than declining one request: a refused `thread/start`, a server reporting an effective approval policy that is not the pinned one, a preflight turn that ran no command so nothing was established, a harness auto-reviewer notification saying something else answered a question before this client was asked, a failed turn, or an app-server exit before completion. Separate from `bridge_refusal_codes` because the two boundaries differ: a decline answers one approval request and the turn carries on, a stop ends the run. A second implementation answers BOTH unions or has left a door open",
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
      "SPEC.md §7 default irreversibility floor: `reversible: false` under an autonomous rule without explicit permission resolves manual, and the resolution says the floor applied",
    input: { policy: POLICY, class: "read.file", reversible: false },
  },
  {
    id: "floor-not-applied-when-reversible",
    description: "the same class and rule, reversible: the floor does not engage",
    input: { policy: POLICY, class: "read.file", reversible: true },
  },
  {
    id: "floor-irreversible-blocks-supervised-without-opt-in",
    description:
      "the default floor also sends an irreversible supervised action to manual when its rule does not explicitly opt in",
    input: { policy: POLICY, class: "files.write.remote", reversible: false },
  },
  {
    id: "floor-unstated-reversibility-is-not-a-claim",
    description:
      "an action that does not say whether it is reversible does not engage the floor; the claim is the agent's to make and its absence is not a permission",
    input: { policy: POLICY, class: "read.file" },
  },
  {
    id: "irreversible-explicit-unanimous-tie-allows",
    description:
      "every equally most-specific rule explicitly opts in, so reversible: false retains the strictest tied supervised-retro resolution",
    input: { policy: POLICY_IRREVERSIBLE, class: "work.run", reversible: false },
  },
  {
    id: "irreversible-tie-omission-denies",
    description:
      "removing the opt-in from either equally most-specific rule preserves the manual floor; lexical ordering cannot discard the denial",
    input: {
      policy: POLICY_IRREVERSIBLE.replace(
        "  '*.run':\n    autonomy: supervised-retro\n    allow_irreversible: true",
        "  '*.run':\n    autonomy: supervised-retro",
      ),
      class: "work.run",
      reversible: false,
    },
  },
  {
    id: "irreversible-policy-edit-inherits-capability",
    description:
      "an unmatched policy.edit child inherits both the parent's supervised-retro resolution and its explicit irreversible capability",
    input: { policy: POLICY_IRREVERSIBLE, class: "policy.edit.docs", reversible: false },
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
  for (const schema of ["codex-instance", "envelope", "event", "policy", "sample-record", "values"]) {
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

/**
 * The read scope, per harness (APRV-347).
 *
 * Three harnesses, and the third is the interesting one: Codex has no read tool
 * at all, so its read vectors are about the shell path and about what happens
 * to a tool this runtime cannot bind. Every harness gets an allow, a deny and a
 * malformed input, which is what AC2 asks for.
 */
const readScopeVectors = [
  // --- Claude Code -----------------------------------------------------------
  {
    id: "claude-read-inside-allows",
    description: "a Read of a file inside the gate root keeps the pass-through allow",
    input: { harness: "claude-code", tool: "Read", target: "inside" },
  },
  {
    id: "claude-read-inside-relative-allows",
    description: "a relative Read is resolved against the hook's own directory, not the event cwd",
    input: { harness: "claude-code", tool: "Read", target: "inside-relative" },
  },
  {
    id: "claude-read-outside-denies",
    description: "a Read outside every read root is answered by policy under read.file.out_of_scope",
    input: { harness: "claude-code", tool: "Read", target: "outside" },
  },
  {
    id: "claude-read-unresolvable-denies",
    description: "a Read whose path resolves nowhere is out of scope: fail closed",
    input: { harness: "claude-code", tool: "Read", target: "unresolvable" },
  },
  {
    id: "claude-glob-no-path-allows",
    description: "a Glob carrying no path names no file, so it stays not-a-gated-tool",
    input: { harness: "claude-code", tool: "Glob", target: "absent" },
  },
  {
    id: "claude-grep-outside-denies",
    description: "Grep's search directory is a read target like any other",
    input: { harness: "claude-code", tool: "Grep", target: "outside" },
  },
  {
    id: "claude-shell-read-outside-denies",
    description: "the shell reader takes the same class as the read tool",
    input: { harness: "claude-code", tool: "Bash", target: "outside" },
  },
  {
    id: "claude-malformed-input-denies",
    description: "unparseable hook input is denied, and nothing is appended",
    input: { harness: "claude-code", tool: "Read", target: "inside", malformed: true },
    control: true,
  },
  // --- Cursor ----------------------------------------------------------------
  {
    id: "cursor-read-inside-allows",
    description: "the Cursor envelope, inside the scope",
    input: { harness: "cursor", tool: "Read", target: "inside" },
  },
  {
    id: "cursor-read-outside-denies",
    description: "the Cursor envelope, outside the scope",
    input: { harness: "cursor", tool: "Read", target: "outside" },
  },
  {
    id: "cursor-shell-read-outside-denies",
    description: "Cursor's Shell tool takes the same classifier as Bash",
    input: { harness: "cursor", tool: "Shell", target: "outside" },
  },
  {
    id: "cursor-malformed-input-denies",
    description: "unparseable input on the Cursor envelope",
    input: { harness: "cursor", tool: "Read", target: "inside", malformed: true },
    control: true,
  },
  // --- Codex -----------------------------------------------------------------
  {
    id: "codex-has-no-read-tool",
    description:
      "Codex exposes only Bash and apply_patch, and a tool whose exact command bytes cannot be bound is refused rather than waved through",
    input: { harness: "codex", tool: "Read", target: "outside" },
  },
  {
    id: "codex-malformed-input-denies",
    description: "unparseable input on the Codex envelope",
    input: { harness: "codex", tool: "Bash", target: "inside", malformed: true },
    control: true,
  },
  // --- Grok Build (APRV-243) -------------------------------------------------
  // The camelCase envelope, and the one harness where the EXIT CODE is the
  // verdict: the executor asserts deny at exit 2 and allow at exit 0, because a
  // deny printed at exit 0 is read by Grok as an allow.
  {
    id: "grok-read-inside-allows",
    description: "the camelCase envelope, inside the scope",
    input: { harness: "grok", tool: "Read", target: "inside" },
  },
  {
    id: "grok-read-outside-denies",
    description:
      "a Read outside every read root, in Grok dialect: the deny is {decision,reason} at exit 2",
    input: { harness: "grok", tool: "Read", target: "outside" },
  },
  {
    id: "grok-grep-outside-denies",
    description: "Grok's tool vocabulary follows Claude Code's, so Grep is a read target too",
    input: { harness: "grok", tool: "Grep", target: "outside" },
  },
  {
    id: "grok-glob-no-path-allows",
    description: "a Glob carrying no path names no file, so it stays not-a-gated-tool",
    input: { harness: "grok", tool: "Glob", target: "absent" },
  },
  {
    id: "grok-shell-read-outside-denies",
    description: "the shell reader takes the same class as the read tool, in Grok dialect",
    input: { harness: "grok", tool: "Bash", target: "outside" },
  },
  {
    id: "grok-malformed-input-denies",
    description: "unparseable input on the Grok envelope, denied at exit 2",
    input: { harness: "grok", tool: "Read", target: "inside", malformed: true },
    control: true,
  },

  // --- Meta Muse Code (APRV-350) ---------------------------------------------
  // snake_case, like Claude Code, but with its OWN tool names and one extra
  // refusal that sits above the policy entirely. Every tool name here was
  // observed in a live capture rather than read off a vendor page.
  {
    id: "muse-read-inside-allows",
    description: "a read_file inside the gate root keeps the pass-through allow",
    input: { harness: "muse", tool: "read_file", target: "inside" },
  },
  {
    id: "muse-read-inside-relative-allows",
    description: "a relative read_file is resolved against the hook's own directory",
    input: { harness: "muse", tool: "read_file", target: "inside-relative" },
  },
  {
    id: "muse-read-outside-denies",
    description: "a read_file outside every read root is answered under read.file.out_of_scope",
    input: { harness: "muse", tool: "read_file", target: "outside" },
  },
  {
    id: "muse-read-unresolvable-denies",
    description: "a read_file whose path resolves nowhere is out of scope: fail closed",
    input: { harness: "muse", tool: "read_file", target: "unresolvable" },
  },
  {
    id: "muse-search-outside-denies",
    description:
      "search names an ARRAY of paths, and one outside the scope gates the call: the shape a live session was seen reaching out of the workspace with",
    input: { harness: "muse", tool: "search", target: "outside" },
  },
  {
    id: "muse-search-no-path-allows",
    description: "a search carrying no paths names no file, so it stays not-a-gated-tool",
    input: { harness: "muse", tool: "search", target: "absent" },
  },
  {
    id: "muse-shell-read-outside-denies",
    description: "the shell reader takes the same class as the read tool, through bash's per-call workdir",
    input: { harness: "muse", tool: "bash", target: "outside" },
  },
  {
    id: "muse-contributor-model-denies-an-allowed-read",
    description:
      "a read INSIDE the scope, which every other vector allows, is refused because the session names a Contributor-tier model: the guard sits above the policy and no grant widens it",
    input: { harness: "muse", tool: "read_file", target: "inside", contributor_model: true },
  },
  {
    id: "muse-malformed-input-denies",
    description: "unparseable input on the Muse envelope is a deny in the one supported dialect",
    input: { harness: "muse", tool: "read_file", target: "inside", malformed: true },
    control: true,
  },

  // --- Hermes Agent (APRV-398) -----------------------------------------------
  // snake_case like Muse, but the EVENT NAMES are its own (`pre_tool_call`), its
  // shell tool is `terminal`, and its verdict is a third dialect answered at a
  // third exit code: `{action:"block",message}` at EXIT 2 for a deny and `{}` at
  // 0 for an allow, because Hermes has no allow directive. The vectors below pin
  // the exit code for the same reason the `grok-*` ones do: a runner that
  // answered a Hermes deny at exit 0 would still be blocking, but one that
  // answered an ALLOW at exit 2 would be blocking a call it meant to permit, and
  // neither is visible from the body alone.
  {
    id: "hermes-read-inside-allows",
    description: "a read_file inside the gate root keeps the pass-through allow",
    input: { harness: "hermes", tool: "read_file", target: "inside" },
  },
  {
    id: "hermes-read-inside-relative-denies",
    description:
      "a RELATIVE read_file is refused on this harness rather than resolved: Hermes resolves a relative path against a per-session recorded directory that a cd moves and that no field of the event carries (its cwd is the Hermes process directory), so the verdict and the read would name different files. The refusal names the retry, which is an absolute path",
    input: { harness: "hermes", tool: "read_file", target: "inside-relative" },
  },
  {
    id: "hermes-write-relative-denies",
    description:
      "the same refusal on a write: the tool a blocked model was observed retrying through must not be the way round the refusal",
    input: { harness: "hermes", tool: "write_file", target: "inside-relative" },
  },
  {
    id: "hermes-terminal-no-workdir-denies",
    description:
      "the shape a live Hermes session actually sent — a terminal call carrying command and nothing else — is refused, because the directory the command runs in is a per-session fact the envelope does not report",
    input: { harness: "hermes", tool: "terminal", target: "inside", omit_workdir: true },
  },
  {
    id: "hermes-terminal-absolute-workdir-allows",
    description:
      "the control for the two above: the same read with an ABSOLUTE workdir is classified and allowed, so the refusal is about the unbound directory and not about the tool",
    input: { harness: "hermes", tool: "terminal", target: "inside" },
  },
  {
    id: "hermes-read-outside-denies",
    description: "a read_file outside every read root is answered under read.file.out_of_scope",
    input: { harness: "hermes", tool: "read_file", target: "outside" },
  },
  {
    id: "hermes-read-unresolvable-denies",
    description: "a read_file whose path resolves nowhere is out of scope: fail closed",
    input: { harness: "hermes", tool: "read_file", target: "unresolvable" },
  },
  {
    id: "hermes-search-files-outside-denies",
    description:
      "search_files is both of this harness's readers behind one target enum, and the ONE path it names is what scopes it",
    input: { harness: "hermes", tool: "search_files", target: "outside" },
  },
  {
    id: "hermes-search-files-no-path-denies",
    description:
      "a search_files carrying NO path is refused on this harness, which is the opposite of the answer every other harness in this suite gives and is a measured fact rather than a preference: an unnamed target here is the per-session recorded directory, not the workspace, and a live session's was $HERMES_HOME/cache/scratch while a gateway session's was the user's home",
    input: { harness: "hermes", tool: "search_files", target: "absent" },
  },
  {
    id: "hermes-shell-read-outside-denies",
    description:
      "the shell reader takes the same class as the read tool, through terminal's per-call workdir",
    input: { harness: "hermes", tool: "terminal", target: "outside" },
  },
  {
    id: "hermes-execute-code-denies-with-its-own-code",
    description:
      "execute_code is refused before anything else looks at it, with a code of its own: the call carries a program and no path, no argv and no workdir, so no verdict could bind it and no policy or open window can authorize it",
    input: { harness: "hermes", tool: "execute_code", target: "inside" },
  },
  {
    id: "hermes-post-event-prints-no-verdict",
    description:
      "the post-execution event prints NOTHING on stdout and exits 0: the tool has already run, so a verdict there would be a permission decision about something nobody can still permit, and on a harness whose non-zero exit blocks, a visibility exit would be a block aimed at a finished call",
    input: { harness: "hermes", tool: "read_file", target: "outside", post_event: true },
  },
  {
    id: "hermes-malformed-input-denies",
    description: "unparseable input on the Hermes envelope is a deny in the one supported dialect",
    input: { harness: "hermes", tool: "read_file", target: "inside", malformed: true },
    control: true,
  },
];

/**
 * The note text from the APRV-353 incident, in one constant.
 *
 * It names a shell, carries an angle-bracketed placeholder, a pipe and a
 * semicolon: every construct a tokenizer that reads inside a quoted argument
 * would misread, in the position a real backlog note puts them.
 */
const QUOTED_NOTE =
  "Ran it through the Bash tool; wrote <abs>/lane.log | the exit code is what counts";

/**
 * The command classifier's segmentation and classes (APRV-353).
 *
 * The suite is about the shell's own command boundary, which is the part of a
 * classifier a second implementation is most likely to get subtly wrong in both
 * directions at once: reading operators inside a quoted argument refuses
 * ordinary work, and failing to read a `$(…)` the shell really does expand lets
 * an unclassified effect run before the outer command starts.
 *
 * Every vector is one command string. Nothing here touches a gate root, a
 * policy or the disk, so these vectors are portable in a way the harness
 * suites cannot be.
 */
const commandClassVectors = [
  // --- quoted argument text is data (APRV-353) -------------------------------
  {
    id: "quoted-note-single-quotes",
    description:
      "a single-quoted backlog note naming a shell, a placeholder, a pipe and a semicolon is ONE segment: a workspace write",
    input: { command: `backlog task edit APRV-353 --append-notes '${QUOTED_NOTE}'` },
  },
  {
    id: "quoted-note-double-quotes",
    description: "the same note in double quotes is the same one segment",
    input: { command: `backlog task edit APRV-353 --append-notes "${QUOTED_NOTE}"` },
  },
  {
    id: "quoted-redirect-is-not-a-redirect",
    description:
      "a redirection written inside a quoted argument creates no file, so it is not a write target",
    input: {
      command: `backlog task edit APRV-353 --append-notes 'node run.mjs > <dir>/lane.log 2>&1'`,
    },
  },
  {
    id: "quoted-separator-does-not-split",
    description: "a separator inside quotes is one word, where the same separator unquoted splits",
    input: { command: "echo 'one ; git push origin main'" },
  },
  {
    id: "unquoted-separator-splits",
    description: "the control for the pair above: unquoted, it is two segments and the push shows",
    input: { command: "echo one ; git push origin main" },
  },
  {
    id: "unquoted-redirect-still-writes",
    description: "an unquoted redirection is a write, exactly as it was",
    input: { command: "echo hello > lane.log" },
  },
  {
    id: "double-quoted-substitution-still-refuses",
    description:
      "the shell expands `$(…)` inside double quotes, so an effectful substitution taints the segment",
    input: { command: `backlog task edit APRV-353 --append-notes "$(git push origin main)"` },
    control: true,
  },
  {
    id: "double-quoted-backtick-still-refuses",
    description: "a backtick inside double quotes is a command substitution the shell runs: opaque",
    input: { command: 'backlog task edit APRV-353 --append-notes "verified with `npm test`"' },
    control: true,
  },
  {
    id: "single-quoted-backtick-is-literal",
    description: "the same backticks inside single quotes are text, because the shell does not expand them",
    input: { command: "backlog task edit APRV-353 --append-notes 'verified with `npm test`'" },
  },
  {
    id: "unbalanced-quote-fails-closed",
    description: "quoting that never closes is unparseable, never a guess at what was meant",
    input: { command: `backlog task edit APRV-353 --append-notes 'never closed` },
    control: true,
  },
  {
    id: "adjacent-quotes-concatenate",
    description: "adjacent quoted and unquoted runs are one word, the way the shell joins them",
    input: { command: `backlog task edit T --append-notes 'a'"b"c` },
  },
  // --- remote ref deletion is its own class (APRV-352) -----------------------
  {
    id: "ref-delete-flag",
    description:
      "git push --delete <ref> is vcs.ref.delete with the ref bound, not the trunk-push class",
    input: { command: "git push origin --delete feature/x" },
  },
  {
    id: "ref-delete-short-flag",
    description: "the -d spelling is the same deletion",
    input: { command: "git push origin -d feature/x" },
  },
  {
    id: "ref-delete-colon-refspec",
    description: "the colon refspec deletes without a flag, fully qualified or short",
    input: { command: "git push origin :refs/heads/x" },
  },
  {
    id: "ref-delete-bulk",
    description: "a bulk deletion binds every ref it names, so the prompt can show them",
    input: { command: "git push origin --delete a b c" },
  },
  {
    id: "ref-delete-mixed-with-a-push",
    description:
      "one deleting refspec makes the whole command a deletion: the destructive half is what is being asked about",
    input: { command: "git push origin feature :stale" },
  },
  {
    id: "ref-delete-tag-stays-release",
    description:
      "a TAG deletion keeps release.publish: the name a release was published under is a release surface however it is removed",
    input: { command: "git push origin :refs/tags/v1.2.3" },
  },
  {
    id: "ref-delete-force-stays-rewrite",
    description: "a force push that also deletes is still vcs.history.rewrite, the stricter fact",
    input: { command: "git push --force origin --delete feature/x" },
  },
  {
    id: "ordinary-push-unmoved",
    description: "the control for the six above: an ordinary branch push did not move",
    input: { command: "git push origin feature/x" },
  },
  // --- launching an agent harness is its own class (APRV-354) ----------------
  {
    id: "harness-launch-bare",
    description:
      "a bare harness invocation is harness.launch.NAME with the argv bound, not exec.* and not unclassified",
    input: { command: "codex exec 'refactor the parser'" },
  },
  {
    id: "harness-launch-app-server",
    description: "codex app-server is a launch: it is the spawn APRV-349's probe makes",
    input: { command: "codex app-server" },
  },
  {
    id: "harness-launch-absolute-path",
    description: "an absolute path reaches the same class, because the table matches basenames",
    input: { command: "/opt/homebrew/bin/codex exec x" },
  },
  {
    id: "harness-launch-home-relative",
    description: "a home-relative path reaches the same class without the classifier resolving ~",
    input: { command: "~/.local/bin/muse" },
  },
  {
    id: "harness-launch-env-prefixed",
    description: "a VAR=value prefix is not the command, so the harness behind it is still found",
    input: { command: "FOO=1 grok run" },
  },
  {
    id: "harness-launch-package-runner",
    description:
      "a package runner naming an EXACT harness spec, version suffix stripped, is the same launch",
    input: { command: "npx @openai/codex@0.152.1 exec x" },
  },
  {
    id: "harness-launch-package-runner-unknown-unmoved",
    description:
      "the control for the vector above: a package this table does not know keeps the runner's own class, and a name that merely CONTAINS a harness name is not a launch",
    input: { command: "npx codex-helper" },
  },
  {
    id: "harness-probe-version",
    description: "a version probe starts no session, so it is a read with its own rule id",
    input: { command: "claude --version" },
  },
  {
    id: "harness-probe-lone-help",
    description: "a lone help argument is a probe; a help word beside others is not",
    input: { command: "cursor-agent help" },
  },
  {
    id: "harness-probe-word-with-arguments-is-a-launch",
    description:
      "fail closed: text cannot say which of a probe flag and a prompt the binary will honour, so a session is the answer",
    input: { command: "codex help me refactor this" },
  },
  {
    id: "harness-launch-muse-model-bound",
    description: "a muse launch binds the --model value so a prompt can show it",
    input: { command: "muse --model muse-1-standard" },
  },
  {
    id: "harness-launch-muse-contributor",
    description:
      "a --model ending in -contributor takes a distinct rule id: a contributor model trains on what it is shown, and a self-reported value may raise scrutiny and never lower it",
    input: { command: "muse --model=muse-1-contributor" },
  },
  {
    id: "harness-update-unmoved",
    description:
      "a harness's own update verb stays deps.upgrade: an upgrade swaps the binary that hosts the hook, which is the stricter reading",
    input: { command: "codex update" },
  },
  {
    id: "harness-wrapper-stays-unclassified",
    description:
      "a wrapper that hides the binary is refused, as it was: the command name is the first word and never a substring of an argument",
    input: { command: "mywrapper codex exec x" },
    control: true,
  },
  // --- the login-shell unwrap (APRV-380) -------------------------------------
  //
  // The shape every Codex exec request arrives in. A classifier that refused it
  // is fail-closed and useless against real traffic; one that unwraps more than
  // this is the second parser the opaque position exists to prevent. The line
  // is these six vectors.
  {
    id: "login-shell-inline-script-is-the-inner-command",
    description:
      "exactly a known shell, one inline-script flag and one script: the SCRIPT is classified, through the same classifier and the same segment rules, so a login shell around a push is a push",
    input: { command: "bash -c 'git push origin main'" },
  },
  {
    id: "login-shell-path-and-login-flags",
    description:
      "the shell may be named by path and the flag may carry login and interactive letters, as the observed Codex shape does",
    input: { command: "/bin/zsh -lc 'git push origin main'" },
  },
  {
    id: "login-shell-compound-script-splices-its-segments",
    description:
      "a script is a command line: its segments are spliced in, and the classes are their union rather than one class standing for all of them",
    input: { command: "bash -lc 'cat README.md && rm -rf build'" },
  },
  {
    id: "login-shell-extra-word-stays-opaque",
    description:
      "a fourth word is an option this rule does not model, so the wrapper stays opaque: what runs is no longer stated by the words",
    input: { command: "bash -c 'git push origin main' extra" },
    control: true,
  },
  {
    id: "login-shell-script-file-stays-opaque",
    description:
      "a script FILE rather than an inline string stays opaque: the effect is in the file and the file is not in the words",
    input: { command: "bash script.sh" },
    control: true,
  },
  {
    id: "login-shell-nested-shell-stays-opaque",
    description:
      "the unwrap is ONE level deep: a shell nested inside an unwrapped script is the shape the opaque position still covers, and the refusal names the inner segment",
    input: { command: "bash -c \"sh -c 'git push origin main'\"" },
    control: true,
  },
  // --- packaging and archives (APRV-397) -------------------------------------
  //
  // The tools a release verification runs, each pinned in BOTH directions: the
  // spelling that reads, and the spelling that writes or is refused. The rule
  // they share is that a destination the text can read decides the class, so the
  // write vectors name the destination and the refused ones name a path outside
  // the workspace.
  //
  // These vectors carry no scratch roots, because this suite carries no machine
  // facts at all: an ABSOLUTE destination is therefore out of scope here even
  // when it looks like a temp directory, which is exactly the answer a caller
  // that resolved no roots must get. The loosening a resolved scratch root
  // buys is a caller-supplied fact and is pinned in
  // `tests/command-class.test.ts` instead.
  {
    id: "npm-pack-writes-the-working-directory",
    description:
      "npm pack writes a tarball where it stands, which is the workspace write it has always been in effect and was refused as unclassified until now",
    input: { command: "npm pack" },
  },
  {
    id: "npm-pack-destination-inside-is-a-workspace-write",
    description: "a relative --pack-destination is a path inside the workspace, so the write is one",
    input: { command: "npm pack --pack-destination build/tarballs" },
  },
  {
    id: "npm-pack-destination-outside-is-refused",
    description:
      "an absolute destination is out of scope with the path BOUND: this classifier holds no workspace root, so the arithmetic is rm's and the class is the one rm already answers",
    input: { command: "npm pack --pack-destination /usr/local/lib" },
  },
  {
    id: "npm-pack-of-a-registry-spec-reaches-the-network",
    description:
      "npm pack of a package spec DOWNLOADS it first, so the network class outranks the tarball it then writes",
    input: { command: "npm pack lodash" },
  },
  {
    id: "npm-init-writes-package-json",
    description: "npm init writes package.json into the working directory and no flag moves it",
    input: { command: "npm init -y" },
  },
  {
    id: "npm-init-with-an-initializer-runs-it",
    description:
      "npm init <pkg> downloads an initializer and runs it, which is npm exec wearing another name, so it takes its own rule id",
    input: { command: "npm init vite" },
  },
  {
    id: "npm-version-flag-is-a-read",
    description:
      "a bare version probe prints a string and starts nothing; the row matches ONLY an argv that is nothing but probe flags",
    input: { command: "npm --version" },
  },
  {
    id: "npm-subcommand-without-a-rule-still-refuses",
    description:
      "the control for the probe row: a subcommand this table does not name keeps the unclassified refusal it had, so the row widened one shape and not a binary",
    input: { command: "npm doctor" },
    control: true,
  },
  {
    id: "tar-list-is-a-read",
    description: "tar -t opens the archive and prints its table of contents",
    input: { command: "tar -tzf dist/pkg.tgz" },
  },
  {
    id: "tar-list-old-style-bundle-is-a-read",
    description:
      "the old-style bundle carries no dash and is the spelling most sessions write, so the mode is read out of the first word too",
    input: { command: "tar tvf dist/pkg.tgz" },
  },
  {
    id: "tar-extract-into-a-named-path-is-a-workspace-write",
    description:
      "an extraction writes where -C points, and a relative destination is inside the workspace",
    input: { command: "tar -xzf dist/pkg.tgz -C build/unpack" },
  },
  {
    id: "tar-extract-outside-the-workspace-is-refused",
    description:
      "an extraction unpacks over whatever it finds, so a destination the text puts outside the workspace takes the out-of-scope class with the path bound",
    input: { command: "tar -xzf dist/pkg.tgz -C /usr/local/lib" },
  },
  {
    id: "tar-extract-into-an-unreadable-path-is-refused",
    description:
      "a destination whose expansion is not in the text is out of scope: what $DEST holds is not something this classifier may vouch for",
    input: { command: "tar -xzf dist/pkg.tgz -C $DEST" },
  },
  {
    id: "tar-create-writes-the-archive-it-names",
    description:
      "a creation writes the file -f names, read out of the glued bundle where that is where it is written",
    input: { command: "tar -czf dist/out.tgz src" },
  },
  {
    id: "tar-without-a-mode-stays-opaque",
    description:
      "a tar whose mode is not in its words is a command whose effect is not in its words, which is a refusal rather than a guess",
    input: { command: "tar -f dist/pkg.tgz" },
    control: true,
  },
  {
    id: "gunzip-to-stdout-is-a-read",
    description: "-c leaves the disk alone, so the decompression is a read",
    input: { command: "gunzip -c dist/pkg.gz" },
  },
  {
    id: "gunzip-list-is-a-read",
    description:
      "-l prints the sizes, the ratio and the member name and touches nothing, which is the same act tar -t is and belongs in the same class",
    input: { command: "gunzip -l dist/pkg.gz" },
  },
  {
    id: "gunzip-in-place-is-a-workspace-write",
    description:
      "the DEFAULT form removes the file it names and leaves the decompressed one in its place, so the plain spelling is a write and only the stdout, test and list forms read",
    input: { command: "gunzip dist/pkg.gz" },
  },
  {
    id: "base64-is-a-read-of-what-it-names",
    description: "base64 decodes to stdout unless a flag names a file to write",
    input: { command: "base64 -d dist/blob.b64" },
  },
  {
    id: "base64-with-an-output-file-writes",
    description: "-o names a destination, so the segment is a write scoped to it",
    input: { command: "base64 -i dist/pkg.tgz -o build/out.b64" },
  },
  {
    id: "openssl-digest-is-a-read",
    description:
      "the digest subcommands read their named files; every other openssl subcommand is as unclassified as it was",
    input: { command: "openssl dgst -sha256 dist/pkg.tgz" },
  },
  {
    id: "openssl-digest-with-an-out-file-writes",
    description: "-out names a destination, so the same subcommand writes",
    input: { command: "openssl dgst -sha256 -out build/sums.txt dist/pkg.tgz" },
  },
  {
    id: "openssl-encrypt-still-refuses",
    description:
      "the control for the digest row: openssl enc, genrsa and s_client name a binary this table still has nothing to say about",
    input: { command: "openssl enc -d -in blob.enc" },
    control: true,
  },
  {
    id: "shasum-is-a-read",
    description:
      "the checksum tools were already reads before this task; the pair a verification reaches for is pinned here so a second implementation cannot pass the new rows and miss these",
    input: { command: "shasum -a 256 dist/pkg.tgz" },
  },
  // --- git tag: the listing forms read (APRV-397) ----------------------------
  {
    id: "git-tag-list-is-a-read",
    description:
      "a tag LISTING reaches no registry, remote or consumer, so it takes the class every other reader of local repository metadata takes",
    input: { command: "git tag -l" },
  },
  {
    id: "git-tag-bare-is-a-read",
    description: "a bare git tag lists, exactly as -l does",
    input: { command: "git tag" },
  },
  {
    id: "git-tag-annotation-lines-is-a-read",
    description: "-n prints annotation lines beside the listing, and -n<num> is the same flag",
    input: { command: "git tag -n5" },
  },
  {
    id: "git-tag-contains-consumes-its-value",
    description:
      "a listing filter takes a value, and that value is not a tag name: reading it as one would have made the most ordinary state check a release",
    input: { command: "git tag --contains HEAD" },
  },
  {
    id: "git-tag-pattern-under-l-is-not-a-name",
    description: "with -l a positional is a PATTERN, so the listing stays a read",
    input: { command: "git tag -l 'v0.*'" },
  },
  {
    id: "git-tag-bare-name-creates",
    description:
      "a positional with no -l is a tag NAME, and creating a tag is the act APRV-305 priced as a release",
    input: { command: "git tag v0.1.0" },
  },
  {
    id: "git-tag-annotated-still-publishes",
    description: "-a, -d, -f, -s and -m are unmoved by this task",
    input: { command: "git tag -a v0.1.0 -m release" },
  },
  {
    id: "git-tag-delete-still-publishes",
    description: "deleting a tag removes the name a release was published under",
    input: { command: "git tag -d v0.1.0" },
  },
  {
    id: "git-tag-sign-still-publishes",
    description: "a signed tag is a published one",
    input: { command: "git tag -s v0.1.0" },
  },
  {
    id: "git-tag-unknown-flag-publishes",
    description:
      "the split is an ALLOWLIST of listing flags, so a flag this rule has never heard of is a creation and a future option cannot arrive as a read",
    input: { command: "git tag --unknown-future-flag" },
  },
  // --- prose that opens with a protected directory path (APRV-409) -----------
  //
  // The quoting vectors at the top of this suite pin that a quoted argument is
  // ONE word. These pin what happens to that word next: the positional scan
  // splits it on its slashes, and until this it matched a protected directory
  // run against the front of a sentence. The incident was a task-creation
  // command whose acceptance criterion opened with a workflow path; it
  // classified as a CI edit, sat the whole hook wait on the gate and was denied
  // on timeout, having written one task file and touched no workflow.
  //
  // The rule is stated as a positive and a set of unmoved shapes, because this
  // is a LOOSENING and a second implementation that took only the positive
  // would loosen further than this one does. A positional word is prose when
  // its protected match came entirely from a whitespace-FREE head; everything
  // else keeps the answer it had. The unmoved shapes below are the whole of
  // "else": a bare path, a path whose match needs its FINAL segment (a real
  // file named with a space), whitespace before the protected run, a deeper
  // match than the head answers, a path inside a sentence, and a protected FILE
  // at the head of a sentence. The last two say where the rule does NOT reach:
  // a redirection target is a path by construction whatever it spells, and a
  // read never runs the positional scan at all.
  //
  // None of them carries `control`, which in this suite means a vector that
  // expects a REFUSAL. Every one of these expects an answer; what makes them
  // controls in the English sense is that the answer is the one from before
  // this task.
  //
  // No policy entries here, like every vector in this suite: the paths are the
  // built-in ones, so the surfaces are `policy.edit`, `policy.core` and
  // `log.mutate` rather than any routed sub-class.
  {
    id: "prose-opening-with-a-workflow-path-is-a-workspace-write",
    description:
      "the incident: a task criterion that opens with the workflows directory path and runs on into a sentence writes one task file, and the protected match came from a directory run the sentence merely begins with",
    input: {
      command:
        'backlog task create x --ac ".github/workflows/pages.yml deploys the built site on push to main with the minimal permissions and no other secret"',
    },
  },
  {
    id: "prose-opening-with-a-workflow-path-short-form",
    description:
      "the shortest form of the same shape: a path, one space, and four words of prose",
    input: {
      command: 'backlog task create x --ac ".github/workflows/pages.yml should not gate this"',
    },
  },
  {
    id: "prose-opening-with-the-log-directory-is-a-workspace-write",
    description:
      "the rule is tier-blind: a sentence opening with the log directory is prose too, and the strictest surface in the stack does not buy an exception",
    input: {
      command:
        'backlog task create x --ac ".approval/log/events.jsonl is the live log and is never mutated"',
    },
  },
  {
    id: "prose-opening-with-a-protected-path-under-cp",
    description:
      "the same shape under a different effectful row: cp scans its positionals source and destination alike, and a sentence is neither",
    input: { command: 'cp a.txt ".github/workflows/pages.yml deploys the site on push"' },
  },
  {
    id: "prose-opening-with-a-protected-path-under-tee",
    description: "and under tee, whose single positional is the file it would write",
    input: { command: 'tee ".github/workflows/pages.yml deploys the site on push"' },
  },
  {
    id: "bare-protected-path-is-unmoved",
    description:
      "the first of the unmoved shapes: a path with no whitespace in it is decided before the prose test is reached, so the whole ordinary universe of paths is byte-identical",
    input: { command: "cp a.yml .github/workflows/pages.yml" },
  },
  {
    id: "protected-file-with-an-embedded-space-is-unmoved",
    description:
      "a REAL file named with a space keeps its class when the match needs its final segment: an exact-file entry leaves no whitespace-free head to have matched, so the word is still a path",
    input: { command: 'cp a.md "my notes dir/CLAUDE.md"' },
  },
  {
    id: "whitespace-before-the-protected-run-is-unmoved",
    description:
      "whitespace in FRONT of the protected directory run leaves the word a path: the head before the first spaced segment classifies as nothing, so nothing is skipped",
    input: { command: 'cp a.yml "my notes dir/.github/workflows/pages.yml"' },
  },
  {
    id: "a-deeper-match-than-the-head-is-unmoved",
    description:
      "the skip requires the head to answer the SAME surface: here the head is a CI edit and the whole word is the policy file in a directory named with a space, so the match needed a segment the head does not carry and the word is kept",
    input: { command: 'cp a.md ".github/workflows/sub dir/APPROVAL.md"' },
  },
  {
    id: "a-protected-path-inside-a-sentence-is-unmoved",
    description:
      "a path in the MIDDLE of a sentence never matched in the first place, because the first segment carries the whitespace: this vector pins that the fix did not change the answer",
    input: {
      command:
        'backlog task create x --ac "a sentence naming .github/workflows/pages.yml inside it"',
    },
  },
  {
    id: "a-protected-file-heading-a-sentence-is-unmoved",
    description:
      "a protected FILE at the head of a sentence answered a workspace write before this task and answers one after it, for the reason the bug had: an exact-file entry matches the final segment and a sentence is not one",
    input: {
      command:
        'backlog task create x --ac "CLAUDE.md says the merge is armed by the session that opened the pull request"',
    },
  },
  {
    id: "a-redirection-onto-the-sentence-still-writes-the-protected-path",
    description:
      "the rule reaches the positional scan and nothing else: a redirection target is a file the shell is about to create, whatever it spells, so it keeps the protected class and the redirect-protected rule",
    input: {
      command: 'echo hi > ".github/workflows/pages.yml deploys the site on push"',
    },
  },
  {
    id: "a-read-of-the-sentence-is-unmoved",
    description:
      "a read never reaches the positional protected-path scan, so this answer is the one it always was and the fix did not widen a read into a write",
    input: { command: 'cat ".github/workflows/pages.yml deploys the site on push"' },
  },
];

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
// Suite 9 — the app-server bridge's reply vocabulary (APRV-367)
// ---------------------------------------------------------------------------

/**
 * One vector: an advertised list and an outcome, and the word that goes on the
 * wire.
 *
 * `advertised: null` is a request that advertised nothing, which is a shape the
 * observed server does send, and is not the same input as an empty list.
 */
const bridgeDecisionVectors = [
  {
    id: "advertised-accept-is-sent-verbatim",
    description:
      "the full list the 2026-09-18 probe recorded, and an accept: the word sent is `accept`, taken from the advertisement",
    input: {
      advertised: ["accept", "acceptForSession", "acceptWithExecpolicyAmendment", "cancel", "decline"],
      outcome: "accept",
    },
  },
  {
    id: "advertised-decline-is-sent-verbatim",
    description: "the same list and a decline: the word sent is `decline`, never `cancel`",
    input: {
      advertised: ["accept", "acceptForSession", "acceptWithExecpolicyAmendment", "cancel", "decline"],
      outcome: "decline",
    },
  },
  {
    id: "accept-for-session-is-never-sent",
    description:
      "a server offering ONLY the session-wide and amendment-carrying variants gets this client's own `accept`: standing authority for a whole session is a grant shape the design does not have, and an amendment carries terms nobody approved. A client matching by prefix would send `acceptForSession` here",
    input: { advertised: ["acceptForSession", "acceptWithExecpolicyAmendment"], outcome: "accept" },
  },
  {
    id: "cancel-and-abort-are-never-sent",
    description:
      "a server offering only `cancel` and `abort` gets `decline`: those mean stop the turn, which is a different act from no to this action, and sending one would record an interruption as a denial",
    input: { advertised: ["cancel", "abort"], outcome: "decline" },
  },
  {
    id: "legacy-approved-is-matched",
    description:
      "the legacy API's spellings are the same two words: `approved` for an accept, matched from the advertisement",
    input: { advertised: ["approved", "denied"], outcome: "accept" },
  },
  {
    id: "legacy-denied-is-matched",
    description: "and `denied` for a decline",
    input: { advertised: ["approved", "denied"], outcome: "decline" },
  },
  {
    id: "case-is-not-the-vocabulary",
    description:
      "a server that spells it `Accept` is offering the word, so the match is case-insensitive; what goes on the wire is this runtime's own spelling of it, because the value's type is the closed vocabulary",
    input: { advertised: ["Accept", "Decline"], outcome: "accept" },
  },
  {
    id: "no-advertisement-falls-back",
    description:
      "a request that advertises nothing gets the client's first word and the source says `fallback`, so a reader can tell a choice the server offered from one the client made",
    input: { advertised: null, outcome: "decline" },
  },
  {
    id: "empty-advertisement-falls-back",
    description:
      "an EMPTY list is the same answer by a different route, and is a different input: the server said it has a vocabulary and named none of it",
    input: { advertised: [], outcome: "accept" },
  },
  {
    id: "acceptforsession-is-not-an-outcome",
    description:
      "a third outcome must be REFUSED rather than answered: this client means accept or decline, and a runner that resolved `acceptForSession` here would be describing a client that can mean more",
    control: true,
    input: { advertised: ["acceptForSession"], outcome: "acceptForSession" },
    expect: { valid: false, failure_class: "unknown-outcome" },
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
    // 9.0.0 (APRV-311): an EIGHTH and a NINTH union, `hook_deny_codes` and
    // `post_tool_codes`, the two vocabularies the harness hooks speak. They
    // were closed sets in the source and nowhere else, which is how one code
    // came to carry two unrelated meanings on the Codex adapter: `hook-io` said
    // both "this event was malformed, send a well-formed one" and "every event
    // of this shape is refused on this harness version". Splitting the second
    // out as `hook-unsupported-execution-context` is a distinction a caller can
    // only rely on if it is pinned, and the whole enforcement surface a second
    // implementation has to reproduce is a hook. Major for the reason 7.0.0 and
    // 8.0.0 were: this suite pins WHICH unions exist.
    // 10.0.0 (APRV-354): `gate_refusal_codes` gains `harness-launch-unruled`
    // and `hook_deny_codes` gains `hook-harness-launch-unruled`, the two
    // spellings of one refusal: a `harness.launch.*` class that no rule of the
    // policy names. Major for the reason every union growth here is major —
    // the vector pins each whole array in definition order — and the pair is
    // deliberately two codes rather than one, because the two paths refuse
    // different inputs. The hook refuses a launch it CLASSIFIED from a command
    // line; the gate refuses one a caller DECLARED. A second implementation
    // that offers the family must answer both, or it has left one of the two
    // doors open.
    // 11.0.0 (APRV-324): a TENTH union, `channel_decision_refusal_codes`, for
    // the two refusals a decision SURFACE makes before the gate is called —
    // `sender-unmapped` and `sender-ambiguous`. It is not part of
    // `gate_refusal_codes` and must not be: that union is documented as every
    // way `approval register|request|decide|withdraw|expire` can refuse, and
    // `decide` emits neither, because the sender is resolved against the
    // attested policy before it runs. A second implementation whose gate
    // emitted one would be describing a different boundary from this one.
    // Major for the reason 7.0.0, 8.0.0 and 9.0.0 were: this suite pins WHICH
    // unions exist. (Numbered 11.0.0 rather than 10.0.0 after landing beside
    // APRV-354's growth of `gate_refusal_codes` and `hook_deny_codes`: two
    // majors were open at once on separate branches, and the merge orders them
    // rather than letting one version name two different vector sets — the
    // collision rule conformance/README.md states.)
    // 12.0.0 (APRV-324, follow-up): `attest-requires-terminal` joined
    // `channel_decision_refusal_codes`. The first cut resolved senders on the
    // decision path and left three callback families — attestation taps,
    // checkpoint signatures and review cards — deciding under the listener's
    // configured identity, so a stranger in the configured chat kept exactly
    // the power the mapping removes, on the most privileged gestures. The new
    // code is what an attestation tap gets when the policy IN FORCE cannot say
    // who is tapping: resolving it against the policy being ATTESTED would let
    // whoever edited that file name the account that approves their own edit.
    // 13.0.0 (APRV-350): `hook_deny_codes` gains
    // `hook-muse-contributor-model`, the refusal a Meta Muse Code session takes
    // for EVERY tool call when it names a Contributor-tier model. Major because
    // this suite pins each union's whole array in definition order, so a longer
    // union is a changed expectation. It earns its own code rather than
    // borrowing one: `hook-class-human-only` would say a human must do this
    // action, and the truth is that nothing may do it in this session and the
    // repair is to change the model in Muse's own picker. A caller that could
    // not tell those apart would route somebody to an approver who cannot help.
    // 14.0.0 (APRV-361): an ELEVENTH union, `bridge_refusal_codes`, for the
    // three refusals `approval codex bridge` reaches on its own. Major for the
    // reason 7.0.0 through 11.0.0 were: this suite pins WHICH unions exist.
    // They are not members of `hook_deny_codes` and must not be: that union is
    // documented as every way `approval hook <harness>` can deny a tool call,
    // and the hook emits none of these — it is handed one event on stdin and
    // has no transport to be asked an unreadable question over. A second
    // implementation whose hook emitted one would be describing a different
    // boundary from this one. The three are distinct rather than one
    // `bridge-refused`, because the repairs differ: a request missing `cwd` is
    // a server that changed shape, an unknown method is a protocol this client
    // has not caught up with, and a file change is a correlation this client
    // has deliberately not made (APRV-363).
    // 15.0.0 (APRV-362): `bridge_refusal_codes` gains `bridge-command-unbound`,
    // the refusal an exec request takes when its command string names no argv
    // the bridge can bind. Major for the reason every union growth here is
    // major: the vector pins each whole array in definition order, so a longer
    // union is a changed expectation. It is a fourth code rather than a widening
    // of `bridge-request-unbound` because that one says a field is MISSING and
    // this one says a field ARRIVED and could not be read as the rendering of an
    // argv; a caller that could not tell them apart would tell an operator to
    // fix a server that changed shape when what changed was the quoting of one
    // command. A second implementation on the item-based API has to answer it:
    // that API delivers the argv already joined, so un-joining it is not
    // optional, and a client that skipped the step would be classifying its own
    // re-parse with nothing recording that it had.
    // 16.0.0 (APRV-368): a TWELFTH union, `bridge_stop_codes`, for the four
    // ways `approval codex bridge` ends a session rather than declining one
    // request. MAJOR for the reason 14.0.0 was, and the reason is this suite's
    // own rule rather than a judgement call: it pins WHICH unions exist, so a
    // twelfth is a changed expectation for every implementation that enumerated
    // eleven. (The minor shape used elsewhere today, in `schema-validation`
    // 2.4.0 and `command-class` 1.3.0, is for a suite that gains VECTORS; this
    // one gains a member of its own subject matter.)
    //
    // A second union rather than four more members of `bridge_refusal_codes`,
    // which was the open question APRV-366 left and APRV-368 closes. The two
    // describe different boundaries: a decline answers one approval request and
    // the turn carries on, a stop ends the run before or instead of a turn. An
    // implementation that emitted `bridge-preflight-void` in answer to one
    // request would be saying something false about what it did. Each union's
    // description now names the other, so a checker that reads one knows it has
    // read half.
    // 17.0.0 (APRV-379): `bridge_refusal_codes` gains
    // `bridge-file-change-already-completed`, the refusal an item-based
    // file-change request takes when `item/completed` for its item arrived
    // BEFORE the question about it. Major for the reason every union growth
    // here is major: the vector pins each whole array in definition order, so a
    // longer union is a changed expectation.
    //
    // A fifth code rather than a fifth reading of `bridge-file-change-unbound`,
    // because the two say opposite things about the correlation. Unbound means
    // the content could not be produced: no frame, the wrong item, an empty
    // change set, or a frame belonging to another thread or turn. This one
    // means the content WAS produced and the order was wrong, so the repairs
    // differ: an unbound change points at a client that missed a frame or a
    // protocol that changed shape, and this one points at a session whose
    // approval policy is not the one it was pinned to. A second implementation
    // on the item-based API has to answer it, because holding the content from
    // an earlier frame is the only way to answer that API at all, and anything
    // holding that state can be asked about an item it has already seen
    // finished.
    //
    // 19.0.0 (APRV-370): `channel_decision_refusal_codes` gains
    // `sender-key-unavailable`, the refusal a decision surface reaches when the
    // attested policy maps that channel's senders in the KEYED form and the
    // process holds no key. Major because the vector pins each whole array in
    // definition order, so a longer union is a changed expectation.
    //
    // A fourth code rather than a `sender-unmapped`, because the two say
    // opposite things and want opposite repairs: unmapped says the policy does
    // not name this account, and this says the runtime could evaluate NO
    // account, for anybody, and the fix is an environment variable rather than
    // an amendment. A second implementation has to answer it, because the only
    // alternative to refusing is comparing a raw id against a digest and
    // finding nothing, which reads exactly like a stranger tapping.
    //
    // 18.0.0 DOES NOT EXIST, and this is the record of why. APRV-379 and
    // APRV-370 were two lanes of one session; 379 took 17.0.0 on its branch
    // and 370 took 18.0.0 on its own, each reading 16.0.0 as the highest it
    // had seen. Two branches naming one version for two different vector sets
    // is the collision `conformance/README.md` warns about, and the rule it
    // gives is one minor — here one major — above the highest version either
    // side saw. 379 merged first, so this is 19.0.0 and no published suite ever
    // carried an 18.
    // 20.0.0 (APRV-398): `hook_deny_codes` gains
    // `hook-hermes-execute-code-unbound`, the refusal a Hermes Agent
    // `execute_code` call takes before anything else looks at it. Major for the
    // reason 13.0.0 was: this suite pins each union's whole array in definition
    // order, so a longer union is a changed expectation.
    //
    // It earns its own code rather than borrowing one, and the two it is closest
    // to are the two it must not be confused with. `hook-opaque` says a command
    // line carried a construct the classifier could not read, and its repair is
    // to write the command differently — there is no rewriting of an
    // `execute_code` call. `hook-unsupported-execution-context` says the harness
    // did not say WHERE a call would run, and its repair is a harness contract
    // that exposes the directory — here the call carries no path, no argv and no
    // directory at all, so there is nothing for a contract to expose. A caller
    // that could not tell the three apart would chase the wrong fix.
    // 21.0.0 (APRV-383): `append_error_codes` gains `daemon-id-invalid` and
    // `daemon-not-allowed`, the two ways the write boundary refuses an append for
    // the IDENTITY of the daemon making it. Major for the reason 13.0.0 and 20.0.0
    // were: this suite pins each union's whole array in definition order, so a
    // longer union is a changed expectation.
    //
    // Two codes rather than one, because the repairs have nothing in common. The
    // first says the process declared an id (`APPROVAL_DAEMON_ID`) that is not an
    // id at all, so no record it wrote could be attributed to anything, and the
    // repair is a launch environment. The second says the attested policy's
    // `daemons` list does not admit this daemon, and the repair is a line in a
    // policy a human re-attests. A second implementation that collapsed them would
    // send an operator hunting through a policy for a broken variable.
    //
    // An implementation that carries no hosted-daemon identity at all still
    // conforms to every OTHER vector here; what it cannot do is claim this union,
    // because the union is what a caller branches on.
    // 22.0.0 (APRV-423): `hook_deny_codes` gains `hook-harness-cap-too-short`,
    // the refusal a hook reaches when the harness ceiling it was told it runs
    // under leaves no window a human could answer in. Major for the reason
    // 13.0.0, 20.0.0 and 21.0.0 were: this suite pins each union's whole array
    // in definition order, so a longer union is a changed expectation.
    //
    // Its own code, and the two it sits nearest are the two it must not be
    // confused with. `hook-timeout` says a wait ran out with the question still
    // open and a retry still able to adopt it; `hook-expired` says a question
    // that was really asked has lapsed. This one says NO QUESTION WAS ASKED:
    // nothing was registered, nothing was requested, and the repair is the
    // harness's own timeout rather than anything about this command or this
    // approver. A caller that collapsed it into either neighbour would retry a
    // command that cannot be answered under this configuration, forever.
    // 23.0.0 (APRV-434): bridge request mismatches and failed/exited sessions
    // gain explicit codes; both closed unions change, so the version is major.
    vectors_version: "23.0.0",
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
    // 3.0.0 (APRV-317): explicit class-rule permission may now retain a
    // nonmanual result for reversible:false, and every expectation exposes the
    // governing capability and max-specificity rule group. Both the algorithm
    // and the frozen output shape changed, so this is a major version.
    vectors_version: "3.0.0",
    algorithm:
      "SPEC.md §5.2 class matching, specificity and unanimous irreversible permission, the policy.edit sub-class inheritance rule, §7 irreversibility floor",
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
    // 2.1.0 (APRV-272): a MINOR bump. `gate.organ.attested` is a new event type
    // with four new fixtures (one accepted, three refused: an agent actor, an
    // absolute `organ_path`, and a missing one). No existing expectation moves
    // — every document this suite already refused is refused for the same
    // reason — so an implementation that passed 2.0.0 fails this only by not
    // knowing a type the enum has gained, which is what a minor bump says.
    // 2.2.0 (APRV-325.1): a MINOR bump. The constrained Codex instance schema
    // adds one accepted and one refused fixture. Existing expectations do not
    // move; implementations conforming to 2.1.0 simply do not know this new
    // packaged manifest shape.
    // 2.3.0 (APRV-338): a MINOR bump, the same shape 2.1.0 was.
    // `gate.path.signed_off` is a new event type with four new fixtures (one
    // accepted, three refused: an agent actor, an absolute `path`, and a
    // missing one). No existing expectation moves, so an implementation that
    // passed 2.2.0 fails this only by not knowing a type the enum has gained.
    // 2.4.0 (APRV-378): a MINOR bump, the same shape 2.1.0 and 2.3.0 were.
    // `audit.question_preempted` is a new event type with five new fixtures
    // (two accepted — one carrying a verdict, one where the disclosure stated
    // none — and three refused: an agent actor, a source outside the closed
    // set, and a question naming no id). No existing expectation moves, so an
    // implementation that passed 2.3.0 fails this only by not knowing a type
    // the enum has gained.
    //
    // It also carries APRV-355's five `audit.gesture_refused` fixtures, which
    // reached this suite under 2.3.0 without a bump of their own. 2.4.0 is the
    // first version that NAMES them; an implementation holding itself to 2.3.0
    // has been required to know them since they were committed, which is the
    // drift a version number exists to prevent.
    // 2.5.0 (APRV-370): a MINOR bump, the same shape 2.1.0, 2.3.0 and 2.4.0
    // were, and for the same reason: no existing expectation moves. The
    // `payload.sender` object gains an optional `hashed`, and six new fixtures
    // exercise it — a grant and a gesture refusal carrying the keyed form, a
    // policy mapping one approver keyed and another raw, and three refused: a
    // record claiming `hashed` while carrying a bare account id, one spelling
    // it `false` (the flag is `true` or absent, never `false`), and a policy
    // whose mapping value is an UNKEYED `sha256:` digest, which this schema
    // refuses because a plain digest of a ten-digit number is not a digest of
    // anything. Every record and every policy written before this validates
    // exactly as it did: the field is optional and absent is the raw form.
    // 2.6.0 (APRV-398): a MINOR bump, the same shape. One new fixture, a
    // `task.registered` whose `payload.harness` is `hermes`, and no existing
    // expectation moves: the enum is a closed set documented as extended by the
    // task that adds the case, and every record written before this validates
    // exactly as it did. `tests/harness-enum.test.ts` is what makes the pair
    // unbreakable in future — it asserts one accepted record per harness kind, so
    // the adapter and the fixture land together or the suite fails.
    // 2.7.0 (APRV-383): a MINOR bump, the same shape 2.1.0 and its successors
    // were. Five new fixtures for the hosted-daemon identity: two accepted event
    // records carrying the new optional top-level `daemon` field (one derived id,
    // one declared), one refused for an id that is not an id (a space, a newline
    // and a YAML fragment, which is precisely what a length-and-charset pattern
    // exists to keep out of an append-only log), one accepted policy declaring a
    // `daemons` allowlist, and one refused policy whose listed id is not in the
    // grammar. No existing expectation moves: both keys are OPTIONAL and additive,
    // so every record and every policy written before them validates exactly as it
    // did, and an implementation that passed 2.6.0 fails this only by not knowing
    // a field and a key that have been added.
    // 2.8.0 (APRV-423): a MINOR bump, the same shape. Seven new fixtures for
    // `payload.harness_cap_ms` on `approval.requested`: one accepted (a hermes
    // request carrying the documented 300 000 ms cap beside `execution:
    // "harness"`) and six refused — zero, a negative, a fraction, a duration
    // string, a cap exactly AT the 60 000 ms margin (the schema's `minimum` is
    // the margin plus one, pinned equal to `HARNESS_CAP_MARGIN_MS` by
    // tests/harness-cap-ttl.test.ts), and a cap on a request that declares no
    // `execution: "harness"` (the `dependentSchemas` pairing rule). Four of the
    // seven are ported from PR #539, a duplicate APRV-423 withdrawn in favour
    // of this branch. No existing expectation moves: the field is OPTIONAL and
    // additive, so every record written before it validates exactly as it did,
    // and an implementation that passed 2.7.0 fails this only by not knowing a
    // field that has been added and the two rules that bound it.
    vectors_version: "2.8.0",
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
  {
    file: "hook-read-scope.v1.json",
    suite: "hook-read-scope",
    // 1.1.0 (APRV-243): a MINOR bump. The six `grok-*` vectors are new and no
    // existing expectation moved; the Grok dialect did not exist when 1.0.0
    // was written, so nothing that passed 1.0.0 fails 1.1.0 except an
    // implementation that claims the harness and answers it wrongly.
    // 1.2.0 (APRV-350): a MINOR bump for the same reason 1.1.0 was one. The
    // nine `muse-*` vectors are new, no existing expectation moved, and the
    // Muse dialect did not exist when 1.1.0 was written.
    // 1.3.0 (APRV-398): a MINOR bump, the same shape again. The ten `hermes-*`
    // vectors are new, no existing expectation moves, and the Hermes dialect did
    // not exist when 1.2.0 was written. Two of them pin something none of their
    // predecessors could. `hermes-execute-code-denies-with-its-own-code` sends a
    // tool that carries a PROGRAM and no path, no argv and no workdir, and
    // expects a deny under a code of its own — an implementation that classified
    // it, or that answered it under `hook-opaque`, fails the vector, because the
    // repairs those codes imply do not exist for this call. And
    // `hermes-post-event-prints-no-verdict` asks a different question from every
    // other vector in the suite: not what the verdict is but whether there is one
    // at all. It sends a POST-execution event over a target the pre event would
    // have refused, and expects an empty stdout at exit 0 — an implementation that
    // answered it with a verdict would pass every other vector here and fail this
    // one, because a permission decision about a call that has already run is a
    // decision nobody can act on.
    // 2.0.0 (APRV-415): a MAJOR bump, and the first one this suite has taken. Two
    // expectations MOVED, which is the rule for a major here (the precedent is
    // `policy-resolution` 2.0.0): a relative Hermes read used to ALLOW and now
    // DENIES, and a Hermes `search_files` naming no path used to allow and now
    // denies. Both vectors were renamed to say so, so an implementation cannot
    // pass by matching an id whose meaning changed underneath it.
    //
    // What moved them is evidence rather than taste. A live probe (APRV-398's
    // notes) established that Hermes reports no effective directory for a call
    // that does not state one: the envelope `cwd` is the Hermes PROCESS directory,
    // `terminal` keeps a per-session recorded directory that a `cd` moves, and all
    // four file tools resolve a relative path against THAT. So the answer 1.3.0
    // froze — resolve a relative path against the hook's own directory, as every
    // other harness in this suite does — bound a different file from the one the
    // harness would have touched. A conforming implementation on this harness now
    // refuses with `hook-unsupported-execution-context` and names the retry.
    //
    // Two new vectors ride the same bump without moving anything:
    // `hermes-terminal-no-workdir-denies` sends the exact shape a live session
    // sent (a `command` and nothing else), and
    // `hermes-terminal-absolute-workdir-allows` is its control, so a reader can
    // see that the refusal is about the unbound directory rather than about the
    // tool. Every OTHER harness's vectors are untouched, and deliberately: this
    // answer is a fact about Hermes, and applying it to Muse (whose `cwd` IS the
    // session root) would refuse calls that harness reports perfectly well.
    vectors_version: "2.0.0",
    algorithm:
      "SPEC.md §5.2/§7 (amended, APRV-347): the read scope, and the harness verdict for a read inside it, outside it, absent, unresolvable, or unreadable as input",
    description:
      "Per-harness PreToolUse envelopes over a scratch gate whose policy reserves `read.file.out_of_scope` to human hands. Targets are SYMBOLIC (`inside`, `inside-relative`, `outside`, `absent`, `unresolvable`) rather than paths, so the suite says nothing about any one machine: a conforming runner builds a gate root, puts a file in it, and picks something outside every read root for `outside`. The expectation pins the permission, the deny CODE, and whether the call was gated at all; the reason text is prose and is deliberately not frozen. The `grok-*` vectors additionally pin the EXIT CODE, because Grok Build reads exit 2 as the deny and exit 0 as the allow whatever stdout said: a runner whose Grok deny exits 0 has emitted a verdict that harness reads as an allow, and it fails these vectors. The `muse-*` vectors cover Meta Muse Code's own tool names (`read_file`, `search` with its ARRAY of paths, `bash` with a per-call `workdir`) and one refusal that is not about the action at all: `muse-contributor-model-denies-an-allowed-read` sends a read INSIDE the scope, which every other vector allows, and expects a deny, because a Contributor-tier session discloses every byte it reads and the guard therefore sits above policy resolution. An implementation that resolved that vector by policy would allow it. The `hermes-*` vectors carry one answer that is the OPPOSITE of every other harness's here, and it is a fact about the harness rather than a choice: a relative path, and a call naming no path, are REFUSED under `hook-unsupported-execution-context`, because Hermes resolves both against a per-session recorded working directory that no field of the event reports, so a verdict over them would bind a different file from the one the harness touches. `hermes-terminal-absolute-workdir-allows` is the control that keeps that refusal about the unbound directory rather than about the tool.",
    vectors: readScopeVectors,
  },
  {
    file: "command-class.v1.json",
    suite: "command-class",
    // 1.1.0 (APRV-352): a MINOR bump. The eight `ref-delete-*` /
    // `ordinary-push-unmoved` vectors are new and no existing expectation in
    // this file moved — the suite was born in 1.0.0 with the quoting vectors
    // only, and none of them names a `git push`. The CLASS of a remote ref
    // deletion did move, from `vcs.push.main` to `vcs.ref.delete`, but that
    // expectation lived in no vector before this, so an implementation that
    // passed 1.0.0 fails 1.1.0 only by not knowing a class the taxonomy has
    // gained.
    // 1.2.0 (APRV-354): a MINOR bump, the same shape. Fourteen new
    // `harness-*` vectors, and no existing expectation in this file moves.
    // What DID move outside it is that a harness invocation used to be
    // `unclassified` and is now a class — a refusal becoming an answer, which
    // is the direction a taxonomy grows in. An implementation that passed
    // 1.1.0 fails 1.2.0 only by not knowing the family.
    // 1.3.0 (APRV-380): a MINOR bump, and the reasoning is worth stating
    // because the behaviour change behind it is larger than the diff. Six new
    // `login-shell-*` vectors pin the narrow unwrap: a segment that is exactly
    // a known shell, one inline-script flag and one script is classified by
    // the SCRIPT, and everything outside that shape stays opaque.
    //
    // Why MINOR and not MAJOR, asked and answered. No existing expectation in
    // this file moves: the suite was born with the quoting vectors, gained
    // `git push` and the harness family, and has never carried a shell
    // wrapper. The MAJOR precedent in this repository is
    // `policy-resolution` 2.0.0, where the suite had STATED a general rule in
    // its own `algorithm` line that a later task made wrong; nothing in this
    // suite's algorithm or description says a shell refuses. So an
    // implementation that passed 1.2.0 fails 1.3.0 only by not knowing a
    // shape the classifier has gained, which is what a minor bump says. What
    // DID move is outside this file, in the same direction 1.2.0's harness
    // family moved: a refusal became an answer.
    // 1.4.0 (APRV-397): a MINOR bump, and the same shape a third time. The new
    // vectors pin the packaging and archive tools (`npm pack`, `npm init`, a
    // bare `npm --version`, `tar` in its list, extract and create modes,
    // `gunzip`, `base64`, `openssl dgst`, `shasum`) and the `git tag` split.
    //
    // Why MINOR and not MAJOR, asked and answered, because one expectation in
    // this file LOOKS like it moved and did not. This suite has never carried a
    // `git tag` vector: it was born with the quoting cases and gained
    // `git push` (1.1.0), the harness family (1.2.0) and the login shell
    // (1.3.0), and `git push origin refs/tags/v1.2.3` — the tag vector it does
    // carry — is unmoved, because pushing a tag is still `release.publish`.
    // What moved is `git tag -l`, which no vector expected. Nothing in the
    // algorithm or description line of this suite states a rule that the split
    // makes wrong, which is the MAJOR precedent (`policy-resolution` 2.0.0).
    //
    // Two things a second implementation must know, and neither is a moved
    // expectation. The out-of-scope packaging destination answers
    // `files.delete.out_of_scope`, a class this taxonomy already has, rather
    // than a `files.write.*` sibling that would resolve by `defaults.autonomy`
    // wherever a policy is silent. And the vectors carry no scratch roots,
    // because this suite carries no machine facts: an absolute destination is
    // out of scope here even when it looks like a temp directory, which is the
    // answer a caller that resolved no roots must get.
    //
    // 1.4.0 STAYS 1.4.0 after one correction inside it, and the reason is the
    // rule that a version is claimed at merge rather than at branch. The first
    // cut of the packaging rows read only `-c`/`--stdout` and `-t`/`--test` as
    // `gunzip` reads, on the brief's enumeration; review agreed that `-l` and
    // `--list` print sizes and names and touch nothing, so they read too, and
    // `gunzip-list-is-a-read` joined the set. Nothing a second implementation
    // has ever been held to moved: 1.3.0 carries no `gunzip` vector at all, and
    // 1.4.0 has not been merged, so the number still names one set.
    //
    // 1.5.0 (APRV-409): a MINOR bump, the same shape a fourth time, and the one
    // that most needed the question asked, because the behaviour behind it is a
    // LOOSENING rather than a taxonomy gaining a shape. Thirteen new
    // `prose-*` / `*-is-unmoved` vectors pin that a positional word whose
    // protected match came entirely from a whitespace-FREE head is prose, and
    // eight of the thirteen pin a shape that did NOT move.
    //
    // Why MINOR and not MAJOR, asked and answered. No committed expectation in
    // this file moves. The suite was born with the quoting cases and gained
    // `git push` (1.1.0), the harness family (1.2.0), the login shell (1.3.0)
    // and the packaging tools (1.4.0); it has never carried a vector whose
    // argument spells a protected path, so no implementation that passed 1.4.0
    // was ever told what the old answer was. The MAJOR precedent in this
    // repository is `policy-resolution` 2.0.0, where the suite's own
    // `algorithm` line STATED a general rule a later task made wrong; nothing
    // in this suite's algorithm or description states a rule about protected
    // paths in argument text.
    //
    // What a second implementation must take from these thirteen, and it is the
    // reason eight of them pin an unchanged answer: the positive alone is not
    // the rule. An implementation that skipped every word containing whitespace
    // would pass the five positives and fail four of the eight, and it would
    // have stopped protecting a file named with a space. The rule is that the
    // whitespace-free head must ALREADY answer the same surface the whole word
    // answered, which is what makes the skip narrow: an exact-file match needs
    // the final segment, a deeper match answers a different surface, and
    // whitespace in front of the protected run leaves no head at all. The two
    // remaining controls say the rule stops at the positional scan: a
    // redirection target and a read are unmoved.
    vectors_version: "1.5.0",
    algorithm:
      "SPEC.md §7 command classification: the shell's own command boundary, then the class of each segment",
    description:
      "One command string per vector, classified by the pure classifier: no gate root, no policy, no disk. The suite pins the SEGMENTATION as much as the classes, because that is where a second implementation goes wrong in both directions at once. Quoted argument text is data — a note naming a shell, a placeholder, a pipe or a semicolon is one word — while the two expansions the shell performs inside double quotes (`$(…)` and backticks) keep classifying as they do anywhere else, and quoting that does not balance is a refusal rather than a guess. On a refusal the CODE is pinned and the detail is not: the code is the machine's half (§11.1 invariant 6), the detail is prose a runtime may improve.",
    vectors: commandClassVectors,
  },
  {
    file: "bridge-decisions.v1.json",
    suite: "bridge-decisions",
    // 1.0.0 (APRV-367): a new suite. It pins a BEHAVIOUR rather than an array,
    // which is why it is not more entries in `refusal-unions`: what has to hold
    // is that a server offering `acceptForSession` is answered `accept` and one
    // offering `cancel` is answered `decline`, in any implementation of this
    // client. The vocabulary itself is eight spellings of two words, and it is
    // a TYPE in the reference implementation, so a vector here is the only
    // place a second implementation can be told the rule.
    vectors_version: "1.0.0",
    algorithm:
      "The Codex app-server reply vocabulary: `accept` and `decline` only, matched against `availableDecisions` case-insensitively and never by prefix",
    description:
      "Given what a request advertised and what the client decided, which word goes on the wire and whether it came from the advertisement. The rule a conforming client must not break is the negative one: `acceptForSession` converts one decision into standing authority for a whole session, `acceptWithExecpolicyAmendment` carries terms nobody approved, and `cancel`/`abort` mean stop the turn rather than no to this action. None of the three is ever sent, however loudly a server advertises it, and a client that matched by PREFIX would send the first two. The negative control names a third outcome, which must be refused rather than answered.",
    vectors: bridgeDecisionVectors,
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
