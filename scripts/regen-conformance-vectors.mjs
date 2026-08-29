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
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const VECTORS_DIR = join(REPO_ROOT, "conformance", "vectors");
const MANIFEST_PATH = join(REPO_ROOT, "conformance", "conformance-manifest.json");

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
function schemaFixtureVectors() {
  const vectors = [];
  const root = join(REPO_ROOT, "schema", "fixtures");
  for (const schema of ["envelope", "event", "policy", "sample-record"]) {
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

const schemaVectors = [
  ...schemaFixtureVectors(),
  {
    id: "event-historical-numeric-amount",
    description:
      "APRV-121 read boundary: a record written before the decimal-string change carries a JSON amount and MUST still validate in historical mode. The log is append-only, so this is permanent",
    input: {
      schema: "event",
      mode: "historical",
      document: JSON.parse(
        readFileSync(
          join(REPO_ROOT, "schema", "fixtures", "event", "invalid", "est-cost-bare-number.json"),
          "utf8",
        ),
      ),
    },
  },
];

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
    // 2.0.0 (APRV-109): a MAJOR bump, because a pinned expectation moved rather
    // than a vector being added. `gate_refusal_codes` gained the four codes the
    // attestation ceremony refuses with (diff-too-large, proposal-not-found,
    // proposal-stale, policy-already-attested) and `channel_tag_refusal_codes`
    // gained proposal-stale, so a second implementation conforming to 1.0.0
    // emits a union this suite no longer accepts (conformance/README.md).
    vectors_version: "2.0.0",
    algorithm: "SPEC.md §11.1 invariant 6: refusals are machine-readable and distinct",
    description:
      "The closed unions of refusal codes. A caller branches on these strings, so adding, removing, or renaming one is a breaking change and shows up here as a diff.",
    vectors: unionVectors,
  },
  {
    file: "policy-resolution.v1.json",
    suite: "policy-resolution",
    algorithm: "SPEC.md §5.2 class matching and specificity, §7 irreversibility floor",
    description:
      "Which rule governs an action, what autonomy it resolves to, and where the floor and the fail-closed rule bind.",
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
    vectors_version: "1.1.0",
    algorithm: "SPEC.md §8 write-boundary validation, JSON Schema 2020-12",
    description:
      "Every committed schema fixture, with the constraint each refusal violates named. Before APRV-122 the invalid fixtures asserted only that validation failed somehow; a refusal for the wrong reason passed.",
    vectors: schemaVectors,
  },
  {
    file: "gate-verdicts.v1.json",
    suite: "gate-verdicts",
    // 2.0.0, not 1.1.0: APRV-147 moved an expectation. The vector that said
    // intake does not check registration now says it does, and a second
    // implementation that passed 1.0.0 does not pass this.
    vectors_version: "2.0.0",
    algorithm: "SPEC.md §6.3/§7/§10: the gate's admission, decision, and refusal paths",
    description:
      "Scripted scenarios over a scratch log: each is a policy, a sequence of gate operations, and the verdict of the last one. A step before the last that refuses is a broken vector and is reported as such rather than counted as a result.",
    vectors: gateVectors,
  },
];

mkdirSync(VECTORS_DIR, { recursive: true });

const manifestFiles = {};
for (const definition of SUITES) {
  const vectors = definition.vectors.map((vector) => {
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
  const path = join(VECTORS_DIR, definition.file);
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
  const relative = path.slice(REPO_ROOT.length);
  manifestFiles[relative] = createHash("sha256").update(readFileSync(path)).digest("hex");
  const controls = vectors.filter((vector) => vector.control === true).length;
  console.log(
    `${definition.file}: ${String(vectors.length)} vectors (${String(controls)} negative controls)`,
  );
}

for (const relative of ["conformance/run.mjs", "tests/conformance-harness.ts"]) {
  manifestFiles[relative] = createHash("sha256")
    .update(readFileSync(join(REPO_ROOT, relative)))
    .digest("hex");
}

const manifest = {
  manifest_version: "1.0.0",
  description:
    "SHA-256 of every conformance vector file and of the reference runner, so a suite cannot change without the change being visible in one place. `npm test` fails on drift (tests/conformance.test.ts). Regenerate with scripts/regen-conformance-vectors.mjs, and review the diff: an expectation that moved is a behaviour change.",
  files: Object.fromEntries(Object.keys(manifestFiles).sort().map((key) => [key, manifestFiles[key]])),
};
writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`conformance-manifest.json: ${String(Object.keys(manifest.files).length)} files pinned`);
