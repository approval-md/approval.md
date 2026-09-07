/**
 * Dogfood tests (APRV-13): the repository's own `APPROVAL.md`, under CI lock.
 *
 * approval.md is built by agents that operate under approval.md, so the policy
 * at the repo root is not documentation — it is live configuration, and the
 * only thing standing between "the gate works" and "the gate silently stopped
 * reading its own rules" is a test that exercises the real file with the real
 * engine. This suite loads `APPROVAL.md` in place (never a copy, never a
 * fixture), asserts its parsed shape, and pins the autonomy and provenance the
 * matcher resolves for every class the policy declares plus the default and
 * irreversibility-floor paths. Any future edit to `APPROVAL.md` that breaks the
 * policy, and any engine regression that mis-reads it, therefore fails
 * `npm test` and CI rather than being discovered by an agent doing something it
 * should not have been allowed to do. `APPROVAL.md` is read-only to agents: the
 * before/after byte comparison below is the mechanical enforcement of that.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { CLASSIFIER_CLASSES, emittableClass } from "../src/core/command-class.js";
import {
  diffPolicies,
  policyTopLevelKeys,
  renderDiff,
  SPEC_NAMESPACES,
} from "../src/core/policy-diff.js";
import { loadPolicy, loadPolicyText, type PolicyLoadResult } from "../src/core/policy-load.js";
import { loadValuesText } from "../src/core/values.js";
import { resolve } from "../src/core/policy-match.js";
import {
  checkPolicyExpectations,
  describeFailure,
  expectationsFor,
  REPO_POLICY_EXPECTATIONS,
} from "../src/core/policy-expectations.js";

/**
 * Repo root. This file compiles to `dist/tests/dogfood.test.js`, so the root is
 * two levels up from the compiled module — the same relocation-safe
 * `import.meta.url` derivation `src/core/validate.ts` uses for `DEFAULT_SCHEMA_DIR`.
 */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const APPROVAL_MD = fileURLToPath(new URL("../../APPROVAL.md", import.meta.url));

const BROKEN_POLICY_MESSAGE =
  "the repository's own APPROVAL.md no longer parses as a valid policy — " +
  "if you edited APPROVAL.md, fix the policy; if you changed the engine, " +
  "you broke compatibility with the live policy";

/** Bytes of `APPROVAL.md` captured before any test runs; compared after. */
let bytesBefore: Buffer;

before(() => {
  bytesBefore = readFileSync(APPROVAL_MD);
});

after(() => {
  const bytesAfter = readFileSync(APPROVAL_MD);
  assert.ok(
    bytesBefore.equals(bytesAfter),
    "APPROVAL.md is read-only: this suite must never modify a byte of it",
  );
});

/** Load the live policy, failing loudly with the operator-facing message. */
function loadRepoPolicy(): Extract<PolicyLoadResult, { ok: true }> {
  const result = loadPolicy({ dir: REPO_ROOT });
  assert.equal(
    result.ok,
    true,
    result.ok ? "" : `${BROKEN_POLICY_MESSAGE} [${result.code}: ${result.message}]`,
  );
  if (!result.ok) throw new Error("unreachable");
  return result;
}

// ---------------------------------------------------------------------------
// 1. The live policy parses
// ---------------------------------------------------------------------------

test("the repository's own APPROVAL.md parses as a valid policy", () => {
  const result = loadRepoPolicy();
  assert.equal(result.source.filename, "APPROVAL.md", BROKEN_POLICY_MESSAGE);
  // A TTL exists and is positive, and that is the whole assertion (APRV-296).
  // The exact value used to be pinned here — 24h, then 2h after the 2026-09-07
  // ceremony — and pinning it made a one-line duration change a code change
  // too: the ceremony ran the built suite, the built suite carried the old
  // number, and Carter's tuning was refused twice by a test that was defending
  // nothing. What fail-closed actually needs is that a request cannot sit
  // actionable forever, and that when it does expire it expires to a refusal;
  // the second half is the defaults test below. How long is an operator's call,
  // and the amendment ceremony prints the change in its defaults section for
  // the human who attests it.
  const ttl = result.durations.approvalTtlMs;
  assert.notEqual(
    ttl,
    null,
    `${BROKEN_POLICY_MESSAGE} [defaults.approval_ttl is unset, so a pending request never expires]`,
  );
  assert.ok(
    ttl !== null && ttl > 0,
    `${BROKEN_POLICY_MESSAGE} [defaults.approval_ttl must be a positive duration]`,
  );
});

// ---------------------------------------------------------------------------
// 2. Structure of the parsed policy
// ---------------------------------------------------------------------------

test("APPROVAL.md defaults are fail-closed: manual, expiry rejects", () => {
  // The two defaults that are not an operator's to tune, and the reason the TTL
  // above is asserted only as "positive" (APRV-296): a request that ages out
  // must age out into a refusal, and an action nobody wrote a rule for must
  // reach a human. The DURATION is a preference; these two are the property.
  const { policy } = loadRepoPolicy();
  assert.equal(policy.defaults?.autonomy, "manual");
  assert.equal(policy.defaults?.on_expiry, "reject");
});

test("APPROVAL.md declares the audit sample rate and global budget", () => {
  const { policy } = loadRepoPolicy();
  assert.equal(policy.audit?.supervised_sample_rate, 0.15);
  assert.equal(policy.budgets?.global?.daily_actions, 20000);
});

test("APPROVAL.md declares approver carter on the cli channel", () => {
  const { policy } = loadRepoPolicy();
  const carter = policy.approvers?.carter;
  assert.ok(carter !== undefined, "approver 'carter' is declared");
  assert.ok(carter.channels.includes("cli"), "carter is reachable on 'cli'");
});

// ---------------------------------------------------------------------------
// 3. Matching: every declared class, plus defaults and the floor
// ---------------------------------------------------------------------------

/**
 * The pins themselves live in `src/core/policy-expectations.ts` (APRV-203).
 *
 * They moved out of this file so that `approval policy amend` can read them: the
 * ceremony runs the same check against the AMENDED file before it pushes, which
 * is what turns "CI went red after the ceremony" into a refusal on the laptop.
 * This suite is still their other reader, and still the thing CI runs.
 */
for (const { actionClass, autonomy, provenance, note } of REPO_POLICY_EXPECTATIONS) {
  const label = note === undefined ? "" : ` (${note})`;
  test(`APPROVAL.md resolves ${actionClass} → ${autonomy}/${provenance}${label}`, () => {
    const load = loadRepoPolicy();
    const resolution = resolve(load, actionClass);
    assert.equal(resolution.autonomy, autonomy);
    assert.equal(resolution.provenance, provenance);
    assert.equal(resolution.floorApplied, false);
  });
}

test("the shared expectation check passes against the live policy (APRV-203)", () => {
  // The exact call `approval policy amend` makes before it pushes. When this
  // fails, the ceremony refuses on the laptop instead of on CI.
  const checked = checkPolicyExpectations(loadRepoPolicy(), REPO_POLICY_EXPECTATIONS);
  assert.deepEqual(
    checked.failures.map(describeFailure),
    [],
    "the live policy no longer matches its pins; update src/core/policy-expectations.ts in the same ceremony that changed the policy",
  );
  assert.equal(checked.ok, true);
});

test("a class the policy declares and no pin names is accepted (APRV-296)", () => {
  // The property the trimmed pin set exists for: declaring a supervised or
  // autonomous class is a policy amendment, not also a code change. Before
  // APRV-296 every literal class the policy declared had to appear in the pins
  // or the ceremony refused `policy-suite-failed`, which turned the 2026-09-07
  // TTL amendment into three failed runs.
  const load = loadRepoPolicy();
  const pinned = new Set(REPO_POLICY_EXPECTATIONS.map((expectation) => expectation.actionClass));
  const unpinned = Object.keys(load.policy.classes ?? {})
    .filter((pattern) => !pattern.includes("*"))
    .filter((actionClass) => !pinned.has(actionClass));
  assert.ok(
    unpinned.length > 0,
    "the live policy pins every class it declares, so this test proves nothing; the pin set is meant to be the safety classes alone",
  );
  assert.deepEqual(
    checkPolicyExpectations(load, REPO_POLICY_EXPECTATIONS).failures.map(describeFailure),
    [],
    `an unpinned declared class was refused: ${unpinned.join(", ")}`,
  );
});

test("the pins still catch a pinned class turned looser (APRV-296)", () => {
  // The other direction, which is why the remaining pins are there at all. A
  // policy that grants `log.mutate` to agents resolves cleanly, parses cleanly,
  // and is a regression; the pin is what says so. Proved against a SCRATCH
  // string, never against the live file, which this suite may not write.
  const live = readFileSync(APPROVAL_MD, "utf8");
  const loosened = live.replace(
    "log.mutate:                { autonomy: human-only }",
    "log.mutate:                { autonomy: autonomous }",
  );
  assert.notEqual(loosened, live, "the live policy no longer carries the log.mutate line as written");

  const load = loadPolicyText(APPROVAL_MD, loosened);
  assert.equal(load.ok, true, load.ok ? "" : `${load.code}: ${load.message}`);
  const checked = checkPolicyExpectations(load, REPO_POLICY_EXPECTATIONS);
  assert.equal(checked.ok, false, "a human-only class turned autonomous passed the pins");
  assert.deepEqual(
    checked.failures.filter((failure) => failure.kind === "resolution").map((failure) => failure.actionClass),
    ["log.mutate"],
  );
});

test("this repository's own policy file resolves to this repository's pins", () => {
  assert.equal(expectationsFor(APPROVAL_MD), REPO_POLICY_EXPECTATIONS);
  // Somebody else's policy is not governed by them.
  assert.equal(expectationsFor("/APPROVAL.md"), null);
});

test("APPROVAL.md + irreversibility floor: vcs.push.main reversible:false → manual/floor", () => {
  // SPEC.md §7 (amended): an irreversible action MUST NOT run under
  // `autonomous` or `supervised`. The live policy grants `vcs.push.main`
  // `supervised`, so the floor — not the rule — decides the outcome.
  const load = loadRepoPolicy();
  const resolution = resolve(load, "vcs.push.main", { reversible: false });
  assert.equal(resolution.autonomy, "manual");
  assert.equal(resolution.provenance, "floor");
  assert.equal(resolution.floorApplied, true);
  assert.equal(resolution.matched?.pattern, "vcs.push.main");
});

// ---------------------------------------------------------------------------
// 4. The harness hook can reach every class this policy declares (APRV-82)
// ---------------------------------------------------------------------------

test("every literal class in APPROVAL.md is reachable from the command classifier", () => {
  const { policy } = loadRepoPolicy();
  const declared = Object.keys(policy.classes ?? {});
  assert.ok(declared.length > 0, BROKEN_POLICY_MESSAGE);

  // Wildcard patterns (`read.*`) name a namespace rather than a class; the
  // classifier emits members of it (`read.shell`, `read.vcs.remote`), and the
  // pattern itself is never an action class.
  const literal = declared.filter((pattern) => !pattern.includes("*"));
  // Asked WITH this policy's own `protected_paths` (APRV-266), which is the
  // same question `core/policy-expectations.ts` asks at the ceremony: a
  // `policy.edit` sub-class is emitted only where an entry routes a path family
  // to it, so its reachability is a property of this file rather than of the
  // classifier's fixed table. A routed line whose entry was deleted still
  // fails here, which is the case worth catching.
  const routes = policy.protected_paths ?? [];
  const unreachable = literal.filter((cls) => !emittableClass(cls, routes));
  assert.deepEqual(
    unreachable,
    [],
    `APPROVAL.md gates ${unreachable.join(", ")}, and no rule in the Claude Code hook's classifier ` +
      "can emit it and no protected_paths entry routes to it: a command in that class would be " +
      "classified as something else, or refused as unclassified, and the policy line would never " +
      "fire. Add a rule to src/core/command-class.ts, route a path to it in protected_paths, " +
      "or remove the class from the policy.",
  );
});

test("a routed policy makes every one of its literal classes reachable (APRV-266)", () => {
  // The fixture is the shape this repository's own policy is expected to take
  // once Carter adopts routing, and it exercises the branch the live policy
  // cannot yet reach: a `policy.edit` sub-class declared in `classes` and
  // routed in `protected_paths`, which the fixed classifier table knows nothing
  // about. Without it the check above would keep passing for the wrong reason.
  const load = loadPolicy({
    file: join(REPO_ROOT, "schema", "fixtures", "policy-md", "valid", "routed-protected-paths.md"),
  });
  assert.equal(load.ok, true, load.ok ? "" : `${load.code}: ${load.message}`);
  if (!load.ok) return;

  const routes = load.policy.protected_paths ?? [];
  const literal = Object.keys(load.policy.classes ?? {}).filter(
    (pattern) => !pattern.includes("*"),
  );
  assert.ok(literal.includes("policy.edit.design"), "the fixture must declare a routed class");
  for (const cls of literal) {
    assert.equal(emittableClass(cls, routes), true, `${cls} must be reachable`);
  }

  // And the negative, which is the whole value of asking with the policy: a
  // sub-class nothing routes to is a line that will never fire.
  assert.equal(emittableClass("policy.edit.harness", routes), false);
});

test("the classifier's read.* classes are covered by the policy's read.* rule", () => {
  const load = loadRepoPolicy();
  for (const cls of CLASSIFIER_CLASSES.filter((candidate) => candidate.startsWith("read."))) {
    assert.equal(
      resolve(load, cls).autonomy,
      "autonomous",
      `${cls} is emitted by the classifier and must be covered by the policy's read.* rule`,
    );
  }
});

// ---------------------------------------------------------------------------
// 5. The amendment diff describes the live policy without crying wolf (APRV-296)
// ---------------------------------------------------------------------------

test("the amend diff calls no key of the live APPROVAL.md an UNKNOWN KEY", () => {
  // The 2026-09-07 ceremony printed, for three UNCHANGED keys:
  //   daemon.full_reproof_after: 60s -> 60s (UNKNOWN KEY: not part of the
  //   policy vocabulary, so the policy FAILS CLOSED to all-manual until it is
  //   removed)
  // ...over a policy the same ceremony then loaded cleanly and resolved every
  // pin against. The renderer's vocabulary was a hand-written copy of the
  // schema's top-level keys and `daemon` had been in the schema since APRV-217.
  // A false fail-closed warning in a ceremony's output teaches an operator that
  // the warnings are noise, so the live file is fed through the real diff here.
  //
  // Diffed against ITSELF, which is the shape the incident had: an unrecognised
  // key is reported whether or not its value moved, so a vocabulary behind the
  // schema shows up even in a diff with no changes at all.
  const load = loadRepoPolicy();
  const rendered = renderDiff(diffPolicies(load, load, SPEC_NAMESPACES)).join("\n");
  assert.equal(
    /UNKNOWN KEY/u.test(rendered),
    false,
    `the amend diff calls a key of the live policy unknown, and the policy loads:\n${rendered}`,
  );
  assert.match(rendered, /no semantic change/u);
});

test("the diff's key vocabulary is the policy schema's own top-level keys", () => {
  // Derived, not copied (APRV-296). `daemon` is the key the copy was missing,
  // and asserting the whole set means the next key a spec amendment adds is
  // covered on the day the schema admits it.
  const schema = JSON.parse(
    readFileSync(join(REPO_ROOT, "schema", "policy.schema.json"), "utf8"),
  ) as { properties: Record<string, unknown> };
  assert.deepEqual([...policyTopLevelKeys()], Object.keys(schema.properties).sort());
  assert.ok(policyTopLevelKeys().includes("daemon"), "the daemon block reads as an unknown key");
});

// ---------------------------------------------------------------------------
// 6. Read-only proof (the `after` hook above is the enforcement)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The proposed values block (APRV-240)
// ---------------------------------------------------------------------------

/**
 * docs/proposals/repo-values-block.md carries the `yaml approval-values`
 * block Carter pastes into APPROVAL.md by hand (agents may not write that
 * file). The property under test is SPEC.md §5.3's: a values block changes
 * nothing about the parsed policy. It is proved against scratch strings and
 * never by writing the real file, and it holds in both states the live file
 * can be in. Before the paste, the block is appended to the live bytes and the
 * policy must parse identically. After the paste (the live file already
 * carries a block), appending a second one would be the `multiple-blocks`
 * refusal rather than a paste, so the check runs the other way: the live block
 * must load, and the policy must parse identically with the block cut out.
 */

/**
 * The values fence of `markdown` as the LOADER sees it, or null where it sees
 * none. Deciding by the loader rather than by a substring search matters: a
 * fence pasted inside a wider fence (the proposal's own ````markdown wrapper,
 * which one paste of the live file did carry) is text to the loader, and a
 * test that found it by searching would strip something the loader never read.
 */
function valuesFenceOf(markdown: string): { start: number; end: number } | null {
  const seen = loadValuesText(join(REPO_ROOT, "APPROVAL.md"), markdown);
  if (!(seen.ok && seen.present)) return null;
  const fence = rawValuesFenceOf(markdown);
  assert.ok(fence !== null, "the loader saw a values block the text does not name");
  return fence;
}

/** The first `yaml approval-values` fence by text, wrapper or no wrapper. */
function rawValuesFenceOf(markdown: string): { start: number; end: number } | null {
  const open = markdown.indexOf("```yaml approval-values");
  if (open < 0) return null;
  const close = markdown.indexOf("\n```", open + 1);
  assert.ok(close > open, "the values fence is unterminated");
  return { start: open, end: close + 4 };
}

function proposedValuesBlock(): string {
  const proposal = readFileSync(join(REPO_ROOT, "docs", "proposals", "repo-values-block.md"), "utf8");
  const fence = rawValuesFenceOf(proposal);
  assert.ok(fence !== null, "the proposal names no approval-values fence");
  return proposal.slice(fence.start, fence.end);
}

/** The assertion both states share: values load, and the policy is unmoved. */
function assertValuesInert(withBlock: string, withoutBlock: string): void {
  const scratchPath = join(REPO_ROOT, "APPROVAL.md");
  const values = loadValuesText(scratchPath, withBlock);
  assert.equal(values.ok, true, values.ok ? "" : `${values.code}: ${values.message}`);
  assert.equal(values.ok && values.present, true);
  const absent = loadValuesText(scratchPath, withoutBlock);
  assert.equal(absent.ok && !absent.present, true, "the stripped copy still carries a values block");

  assert.deepEqual(loadPolicyText(scratchPath, withBlock), loadPolicyText(scratchPath, withoutBlock));
}

test("the proposed values block leaves the live policy byte-for-byte the same (APRV-240)", () => {
  const live = readFileSync(APPROVAL_MD, "utf8");
  const fence = valuesFenceOf(live);
  if (fence === null) {
    // Before the paste: the proposal goes onto the live bytes.
    assertValuesInert(`${live.trimEnd()}\n\n${proposedValuesBlock()}\n`, live);
    return;
  }
  // After the paste: the live block comes off the live bytes.
  assertValuesInert(live, `${live.slice(0, fence.start)}${live.slice(fence.end)}`);
});

test("the values check holds in the state the live file is not in (APRV-240)", () => {
  // Whichever state APPROVAL.md is in, exercise the other one against a scratch
  // string, so a paste (or its reversal) cannot leave one branch of the check
  // untested.
  const live = readFileSync(APPROVAL_MD, "utf8");
  const fence = valuesFenceOf(live);
  if (fence === null) {
    // The block goes on the end, so the block that comes off is the LAST fence
    // by text: a file whose earlier fence is hidden inside a wrapper still has
    // exactly one the loader can see, and it is the one just appended.
    const block = proposedValuesBlock();
    const pasted = `${live.trimEnd()}\n\n${block}\n`;
    const cutStart = pasted.lastIndexOf(block);
    assert.ok(cutStart > 0);
    assertValuesInert(pasted, `${pasted.slice(0, cutStart)}${pasted.slice(cutStart + block.length)}`);
    return;
  }
  const stripped = `${live.slice(0, fence.start)}${live.slice(fence.end)}`;
  assertValuesInert(`${stripped.trimEnd()}\n\n${proposedValuesBlock()}\n`, stripped);
});

test("APPROVAL.md is unchanged mid-suite", () => {
  assert.ok(
    bytesBefore.equals(readFileSync(APPROVAL_MD)),
    "APPROVAL.md must never be written by this suite",
  );
});
