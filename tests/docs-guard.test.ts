/**
 * Documentation guard (APRV-32) — the docs are bound to executed reality.
 *
 * A transcript in `examples/` and a table in `README.md` are the two places in
 * this repository where a human is shown exactly what a command prints. Both
 * are hand-written, both are copied by readers, and both go stale silently: a
 * renamed refusal code or a re-numbered exit code changes the runtime and
 * leaves the prose asserting a world that no longer exists. Documentation that
 * confidently states the wrong exit code is worse than no documentation, since
 * the reader has no reason to doubt it.
 *
 * So this file makes drift a test failure rather than a discovery. It reads
 * the checked-in markdown, extracts the claims that are mechanically checkable,
 * and asserts them against the frozen sources: `EXIT_CODE_TABLE` for the
 * numbers, and the frozen refusal unions for the names. Membership is checked
 * against imported constants rather than by spawning the CLI, because the claim
 * under test is "this vocabulary still exists", not "this invocation still
 * behaves", and the second is already covered by `tests/e2e-demo.test.ts`.
 *
 * The second guard is the refusal RENDERING (APRV-247). A code that still
 * exists can still be printed in a shape the CLI retired, and that drift is
 * invisible to the vocabulary checks above, since both shapes name the same
 * code. So the examples are swept for the old `approval: <code>:` prefix and
 * the demo is asserted to carry what `cli/style.ts` produces today.
 *
 * The third guard is the neutrality sweep. A steward-private product name was
 * removed from the canonical example, the fixtures descended from it, and the
 * prose (APRV-32, human-mandated). Frozen fixtures outlive the decision that
 * created them, so a reintroduction is caught here rather than in review.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { isAgentmailFailureCode } from "../src/adapters/agentmail.js";
import { ADAPTER_REFUSAL_CODES } from "../src/adapters/contract.js";
import { EXECUTE_REFUSAL_CODES } from "../src/core/execute.js";
import { parseFrontmatter } from "../src/core/frontmatter.js";
import { GATE_REFUSAL_CODES } from "../src/core/gate.js";
import { TOKEN_VERIFY_REFUSAL_CODES } from "../src/core/token.js";
import { validate } from "../src/core/validate.js";
import { EXIT_CODE_TABLE } from "../src/cli/exit-codes.js";
import { makeStyle, refusal as renderRefusal } from "../src/cli/style.js";
import { DOCTOR_FRESH_SKIPS, DOCTOR_ROW_ORDER } from "./doctor-rows.js";

/** The repository root, from `dist/tests/` at runtime. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function readDoc(relative: string): string {
  return readFileSync(join(REPO_ROOT, relative), "utf8");
}

/**
 * Every `| <code> | <meaning> |` row of the LAST markdown table in `text`
 * whose first column is a bare integer. Both documents put their exit-code
 * table at the end, and matching on the row shape rather than on a heading
 * keeps the assertion from breaking on an editorial retitle.
 */
function exitRows(text: string): Array<[number, string]> {
  const rows: Array<[number, string]> = [];
  for (const line of text.split("\n")) {
    const match = /^\|\s*(\d+)\s*\|\s*(.+?)\s*\|\s*$/u.exec(line);
    if (match === null) continue;
    rows.push([Number(match[1]), match[2] ?? ""]);
  }
  return rows;
}

/** Every frozen refusal name the CLI can print. */
const REFUSAL_VOCABULARY: ReadonlySet<string> = new Set<string>([
  ...EXECUTE_REFUSAL_CODES,
  ...GATE_REFUSAL_CODES,
  ...TOKEN_VERIFY_REFUSAL_CODES,
]);

/**
 * The refusal names the demo transcript shows a human, chosen for stability:
 * each names a distinct branch of the token lifecycle and a rename of any one
 * of them would invalidate a step of the walkthrough.
 */
const DEMO_REFUSALS = [
  "token-required",
  "token-consumed",
  "payload-mismatch",
  "policy-not-attested",
] as const;

// ---------------------------------------------------------------------------
// examples/telegram-demo.md
// ---------------------------------------------------------------------------

test("the demo transcript's exit-code table is the frozen table", () => {
  const rows = exitRows(readDoc("examples/telegram-demo.md"));
  assert.deepEqual(
    rows.map(([code]) => code),
    EXIT_CODE_TABLE.map(([code]) => code),
    "examples/telegram-demo.md lists exit codes that are not EXIT_CODE_TABLE's, in EXIT_CODE_TABLE's order. The transcript is what a human copies; it does not get to disagree with src/cli/exit-codes.ts.",
  );
  assert.equal(
    rows.length,
    EXIT_CODE_TABLE.length,
    "the demo transcript documents a different number of exit codes than the CLI defines",
  );
});

test("every refusal name the demo transcript prints is still in the CLI vocabulary", () => {
  const demo = readDoc("examples/telegram-demo.md");
  for (const code of DEMO_REFUSALS) {
    assert.ok(
      demo.includes(code),
      `examples/telegram-demo.md no longer shows the refusal ${code}; either restore it or drop it from DEMO_REFUSALS with a reason`,
    );
    assert.ok(
      REFUSAL_VOCABULARY.has(code),
      `examples/telegram-demo.md shows the refusal ${code}, which no frozen union in core/ declares any more. A renamed refusal code makes the transcript state a refusal the runtime cannot produce.`,
    );
  }
});

// ---------------------------------------------------------------------------
// The refusal rendering, across every example (APRV-247)
// ---------------------------------------------------------------------------

/**
 * The shape a refusal is printed in, asked of the renderer rather than spelled
 * out here (APRV-102, `cli/style.ts`).
 *
 * A UTF-8 locale and an explicit `noColor` pin the two axes that would
 * otherwise make this depend on the machine running the suite: the glyph
 * degrades to `[x]` under a non-UTF-8 locale, and colour would wrap the code in
 * escape sequences no markdown file contains. Everything else about the line,
 * the glyph and the two spaces and the order, comes from `refusal()` itself, so
 * a change to the shape reaches the examples through this test rather than
 * through a reader copying a line the CLI stopped printing.
 */
function refusalHead(code: string): string {
  const plain = makeStyle({ env: { LANG: "en_US.UTF-8" }, noColor: true });
  // A sentinel message rather than an empty one, so the separator between the
  // code and the message survives into the returned prefix. An empty message
  // would let a doc that lost the two spaces still match.
  const marker = "<<message>>";
  return renderRefusal(plain, code, marker).split(marker)[0] ?? "";
}

/** Every `.md` file under `examples/`, relative to the repository root. */
function exampleDocs(): string[] {
  return walk(join(REPO_ROOT, "examples"))
    .filter((path) => path.endsWith(".md"))
    .map((path) => path.slice(REPO_ROOT.length));
}

/**
 * The retired refusal form, gone from every example.
 *
 * Refusals used to print as `approval: <code>: <message>`, and the examples
 * were written against that. The current shape is the glyph line above, which
 * is what makes a refusal scannable in a wall of output and machine-readable at
 * the same time (SPEC.md section 11: refusals are machine-readable and
 * distinct). A transcript still showing the old prefix teaches a reader to grep
 * for a string the CLI no longer emits, and the drift is silent, because both
 * forms name the same code and every existing guard here checks only the code.
 *
 * The scan is over the frozen vocabulary rather than a general `approval: \w+:`
 * pattern, deliberately. `approval wait`'s timeout is not a refusal and is
 * still printed as `approval: timeout: …` by `cli/execute.ts`; a looser pattern
 * would fail examples/backlog-md-project/README.md for showing that line
 * correctly.
 */
test("no example shows a refusal in the retired `approval: <code>:` form", () => {
  const offenders: string[] = [];
  for (const relative of exampleDocs()) {
    const text = readDoc(relative);
    for (const code of REFUSAL_VOCABULARY) {
      if (text.includes(`approval: ${code}:`)) offenders.push(`${relative} — ${code}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these examples print a refusal in the retired \`approval: <code>:\` form: ${offenders.join(
      "; ",
    )}. The CLI prints \`${refusalHead(
      "token-required",
    )}\` — glyph, code, two spaces, message. Re-run the walkthrough and paste what it says.`,
  );
});

/**
 * And the positive half: the demo transcript's refusals are in the current
 * shape, rather than merely absent from the old one. Without this, a rewrite
 * that dropped the glyph entirely, or reordered the line, would pass the sweep
 * above by saying nothing at all.
 */
test("the demo transcript prints its refusals in the shape the CLI renders today", () => {
  const demo = readDoc("examples/telegram-demo.md");
  for (const code of ["token-required", "token-consumed"]) {
    assert.ok(
      demo.includes(refusalHead(code)),
      `examples/telegram-demo.md does not show \`${refusalHead(
        code,
      )}\`. The walkthrough's steps 7 and 11 ARE those two refusals; a reader who cannot match what their terminal printed against the transcript has lost the only check the document offers.`,
    );
  }
});

// ---------------------------------------------------------------------------
// examples/agentmail-demo.md (APRV-224)
// ---------------------------------------------------------------------------

/**
 * The AgentMail walkthrough's refusals, from two vocabularies.
 *
 * The demo shows the runtime's own refusal beside the adapter's, and the two
 * are frozen in different files: `adapter-failed` and `token-consumed` are the
 * contract's and core's, `agentmail-draft-drifted` and its kin are the
 * adapter's. A reader copying the transcript is told what a refusal will say,
 * so a rename in either vocabulary has to reach the prose.
 */
const AGENTMAIL_DEMO_RUNTIME_REFUSALS = [
  "adapter-failed",
  "token-consumed",
  "payload-mismatch",
  "credential-unavailable",
] as const;

const AGENTMAIL_DEMO_ADAPTER_REFUSALS = [
  "agentmail-draft-drifted",
  "agentmail-unauthorized",
  "agentmail-inbox-mismatch",
  "agentmail-draft-missing",
  "agentmail-from-mismatch",
  "agentmail-unreachable",
  "agentmail-payload-ambiguous",
  "agentmail-payload-invalid",
] as const;

test("every refusal the AgentMail demo shows is still a real refusal", () => {
  const demo = readDoc("examples/agentmail-demo.md");
  const runtimeVocabulary: ReadonlySet<string> = new Set<string>([
    ...REFUSAL_VOCABULARY,
    ...ADAPTER_REFUSAL_CODES,
  ]);
  for (const code of AGENTMAIL_DEMO_RUNTIME_REFUSALS) {
    assert.ok(
      demo.includes(code),
      `examples/agentmail-demo.md no longer shows the refusal ${code}; either restore it or drop it from the list with a reason`,
    );
    assert.ok(
      runtimeVocabulary.has(code),
      `examples/agentmail-demo.md shows the refusal ${code}, which no frozen union declares any more`,
    );
  }
  for (const code of AGENTMAIL_DEMO_ADAPTER_REFUSALS) {
    assert.ok(
      demo.includes(code),
      `examples/agentmail-demo.md no longer shows the AgentMail refusal ${code}`,
    );
    assert.ok(
      isAgentmailFailureCode(code),
      `examples/agentmail-demo.md shows ${code}, which AGENTMAIL_FAILURE_CODES no longer declares. The vocabulary is frozen and additive; a rename makes the walkthrough state a refusal the adapter cannot produce.`,
    );
  }
});

test("the AgentMail demo states the two-key split it depends on", () => {
  const demo = readDoc("examples/agentmail-demo.md");
  for (const permission of ["draft_create", "draft_read", "draft_send", "message_send"]) {
    assert.match(
      demo,
      new RegExp(permission, "u"),
      `examples/agentmail-demo.md no longer names the ${permission} permission. The two-key split IS the enforcement (SPEC.md section 10.4); a walkthrough that stops naming the permissions leaves the reader to guess which key goes where.`,
    );
  }
});

// ---------------------------------------------------------------------------
// README.md
// ---------------------------------------------------------------------------

test("the README's AgentMail paragraph keeps the two-key split and the drift refusal", () => {
  const readme = readDoc("README.md");
  assert.match(
    readme,
    /agentmail-draft-drifted/u,
    "README.md no longer names the drift refusal. A grant over a remote mutable object is only bound because the adapter re-fetches and refuses; prose that drops the refusal claims a binding it does not describe.",
  );
  assert.ok(
    isAgentmailFailureCode("agentmail-draft-drifted"),
    "README.md names a refusal AGENTMAIL_FAILURE_CODES no longer declares",
  );
  assert.match(
    readme,
    /message_send/u,
    "README.md no longer names the send permission the vault key holds, which is the half of the two-key split that makes the other half enforcement",
  );
});

test("the README's exit-code table is EXIT_CODE_TABLE verbatim", () => {
  assert.deepEqual(
    exitRows(readDoc("README.md")),
    EXIT_CODE_TABLE.map(([code, meaning]) => [code, meaning]),
    "README.md's exit-code table drifted from src/cli/exit-codes.ts. The numbers are a frozen public API and the README is where an agent's author reads them.",
  );
});

// ---------------------------------------------------------------------------
// The README's APPROVAL.md dictionary, and doctor's roster
// ---------------------------------------------------------------------------

/**
 * The autonomy levels, read from the schema rather than listed here.
 *
 * `schema/policy.schema.json` is what refuses a policy, so it is the only
 * honest source for what an author may write. The README's dictionary tells a
 * reader the whole vocabulary, and the vocabulary has been widened twice
 * (APRV-127 split `supervised`, APRV-185 added `human-only`) while the prose
 * kept saying three. Reading the enum here means the next widening fails this
 * test instead of shipping a README that names five sixths of the levels.
 */
function schemaAutonomyLevels(): readonly string[] {
  const raw: unknown = JSON.parse(readDoc("schema/policy.schema.json"));
  const defs = (raw as { $defs?: { autonomy?: { enum?: unknown } } }).$defs;
  const levels = defs?.autonomy?.enum;
  assert.ok(
    Array.isArray(levels) && levels.length > 0,
    "schema/policy.schema.json no longer defines $defs.autonomy.enum; the dictionary guard has nothing to hold the README to",
  );
  return (levels as unknown[]).map((level) => {
    assert.equal(typeof level, "string", "$defs.autonomy.enum holds a non-string level");
    return level as string;
  });
}

/** Small counts as the README spells them, for the one place it spells one. */
const NUMBER_WORDS: ReadonlyMap<number, string> = new Map([
  [3, "Three"],
  [4, "Four"],
  [5, "Five"],
  [6, "Six"],
  [7, "Seven"],
  [8, "Eight"],
]);

test("the README's dictionary names every autonomy level the schema admits", () => {
  const readme = readDoc("README.md");
  const levels = schemaAutonomyLevels();
  for (const level of levels) {
    assert.ok(
      readme.includes(`\`${level}\``),
      `README.md never names the autonomy level \`${level}\`, which schema/policy.schema.json admits. A policy author reading the dictionary would not know the level exists, and the schema is what decides.`,
    );
  }
  const word = NUMBER_WORDS.get(levels.length);
  assert.ok(
    word !== undefined,
    `the autonomy enum now holds ${levels.length} levels, which NUMBER_WORDS does not spell; add it and update the README`,
  );
  assert.ok(
    readme.includes(`${word} values, strictest first`),
    `README.md does not say "${word} values, strictest first" where it introduces autonomy. The schema admits ${levels.length} levels; a count that disagrees is the drift this guard exists for.`,
  );
  assert.ok(
    readme.includes("`live_rate`"),
    "README.md names `supervised-live` without naming the `live_rate` it requires. A level whose rate the reader never sees is a level they cannot write.",
  );
});

test("the README's doctor description matches the doctor roster", () => {
  const readme = readDoc("README.md");
  const rows = DOCTOR_ROW_ORDER.length;

  for (const skip of DOCTOR_FRESH_SKIPS) {
    assert.ok(
      (DOCTOR_ROW_ORDER as readonly string[]).includes(skip),
      `DOCTOR_FRESH_SKIPS names ${skip}, which doctor does not emit; the README would name a row nobody sees`,
    );
  }

  assert.ok(
    readme.includes(`${rows} rows`),
    `README.md does not say doctor prints ${rows} rows. tests/doctor-rows.ts is the roster the doctor suite asserts against, and the prose is what a reader counts their own output against.`,
  );
  assert.ok(
    readme.includes(`of the ${rows} lines`),
    `README.md's install walkthrough does not say how many of doctor's ${rows} lines it shows`,
  );
  assert.ok(
    readme.includes(`${DOCTOR_FRESH_SKIPS.length} of the ${rows}`),
    `README.md does not say that ${DOCTOR_FRESH_SKIPS.length} of the ${rows} rows report "not applicable" in a fresh directory`,
  );
  for (const skip of DOCTOR_FRESH_SKIPS) {
    assert.ok(
      readme.includes(`\`${skip}\``),
      `README.md does not name the row \`${skip}\` among the ones a fresh directory skips. A reader meeting a dash they cannot place reads a configuration as a fault.`,
    );
  }

  // The sample tally is the same claim in arithmetic, so it is held to the same
  // roster: a run that skipped a different number of rows would print a
  // different middle figure, and a run over a different roster would not sum.
  const tally = /^(\d+) ok · (\d+) not applicable · (\d+) failed$/mu.exec(readme);
  assert.ok(
    tally !== null,
    "README.md no longer shows a doctor tally line in the `<n> ok · <n> not applicable · <n> failed` shape doctor prints",
  );
  const [ok, skipped, failed] = [tally[1], tally[2], tally[3]].map((part) => Number(part));
  assert.equal(
    (ok ?? 0) + (skipped ?? 0) + (failed ?? 0),
    rows,
    `README.md's doctor tally sums to something other than the ${rows} rows doctor emits`,
  );
  assert.equal(
    skipped,
    DOCTOR_FRESH_SKIPS.length,
    `README.md's doctor tally reports a "not applicable" count that is not the ${DOCTOR_FRESH_SKIPS.length} rows a fresh directory skips`,
  );
});

/**
 * The dictionary is a table of KEYS, so its completeness is checkable against
 * the schema's own key shape. Every top-level property and every member of a
 * class rule gets a row; the table's first column is read back and compared.
 *
 * `classes` and `defaults` and their kin are containers rather than leaves, so
 * the check is over the leaf paths the schema actually names, spelled the way
 * the table spells them.
 */
test("the README's dictionary has a row for every policy key the schema defines", () => {
  const raw: unknown = JSON.parse(readDoc("schema/policy.schema.json"));
  const schema = raw as {
    properties?: Record<string, { properties?: Record<string, unknown> }>;
    $defs?: { classRule?: { properties?: Record<string, unknown> } };
  };
  const readme = readDoc("README.md");
  const keys = new Set<string>();
  for (const [name, node] of Object.entries(schema.properties ?? {})) {
    const children = node.properties;
    if (name === "defaults" || name === "daemon" || name === "vault" || name === "audit") {
      for (const child of Object.keys(children ?? {})) keys.add(`${name}.${child}`);
      continue;
    }
    if (name === "approvers" || name === "classes" || name === "budgets" || name === "channels") {
      continue; // pattern-keyed; covered by the class-rule and channel rows below
    }
    keys.add(name);
  }
  for (const field of Object.keys(schema.$defs?.classRule?.properties ?? {})) {
    keys.add(`classes.<pattern>.${field}`);
  }
  const missing = [...keys].filter((key) => !readme.includes(`| \`${key}\``));
  assert.deepEqual(
    missing,
    [],
    `README.md's APPROVAL.md dictionary has no row for: ${missing.join(
      ", ",
    )}. The table promises every key that can appear in the policy block; a key the schema accepts and the table omits is a policy an author cannot discover.`,
  );
});

test("the README cites the seq 2 amendment incident by number", () => {
  const readme = readDoc("README.md");
  const cited = /seq 2[\s\S]{0,600}?(superseded|eleven minutes)/iu.test(readme);
  assert.ok(
    cited,
    "README.md no longer cites seq 2 of this repository's own log as the incident `approval policy amend` exists to prevent. The verb's rationale is an event in the log, checkable by number; prose that drops the citation turns a fact into an anecdote.",
  );
  assert.match(
    readme,
    /approval policy amend/u,
    "README.md cites the incident but no longer names the verb it motivates",
  );
});

test("the README states the token-delivery asymmetry and the web CSRF stance", () => {
  const readme = readDoc("README.md");
  assert.match(
    readme,
    /CSRF/u,
    "README.md dropped the web channel's CSRF stance. v0.1 ships no anti-CSRF token deliberately, and a deliberate omission that goes unstated reads as an oversight.",
  );
  assert.match(
    readme,
    /speed bump/iu,
    "README.md no longer says the same-origin check is a speed bump rather than a control",
  );
  assert.match(
    readme,
    /loopback/iu,
    "README.md no longer states the loopback trust boundary the web channel relies on",
  );
});

// ---------------------------------------------------------------------------
// examples/backlog-md-project (APRV-226)
// ---------------------------------------------------------------------------

/**
 * The Backlog.md example's task file is the one place a reader is shown a
 * complete envelope sitting in real board frontmatter. The README tells them
 * it validates against `schema/envelope.schema.json`, and `approval register`
 * would refuse it otherwise; the schema is versioned and amended, so this is
 * the assertion that keeps the example registerable.
 */
const BACKLOG_EXAMPLE_TASK =
  "examples/backlog-md-project/backlog/tasks/task-7 - Publish-0.1.0-to-npm.md";

test("the Backlog.md example's task file carries an envelope the schema accepts", () => {
  const parsed = parseFrontmatter(readDoc(BACKLOG_EXAMPLE_TASK));
  assert.ok(parsed.ok, `${BACKLOG_EXAMPLE_TASK} does not parse as a task file`);
  const envelope = parsed.data["approval"];
  assert.ok(
    typeof envelope === "object" && envelope !== null,
    `${BACKLOG_EXAMPLE_TASK} carries no approval: envelope; the example exists to show one`,
  );
  const result = validate("envelope", envelope);
  assert.equal(
    result.ok,
    true,
    `${BACKLOG_EXAMPLE_TASK} no longer validates against envelope.schema.json: ${
      result.ok ? "" : JSON.stringify(result.errors)
    }. The README promises a registerable file; fix the file or the promise.`,
  );
});

test("the Backlog.md example's README walks the four verbs in order", () => {
  const readme = readDoc("examples/backlog-md-project/README.md");
  const verbs = ["approval register ", "approval request ", "approval wait ", "approval run "];
  let cursor = -1;
  for (const verb of verbs) {
    const at = readme.indexOf(verb, cursor + 1);
    assert.ok(
      at > cursor,
      `examples/backlog-md-project/README.md no longer shows \`${verb.trim()}\` after the verb before it`,
    );
    cursor = at;
  }
});

// ---------------------------------------------------------------------------
// Neutrality
// ---------------------------------------------------------------------------

/** Directories the sweep does not enter, and why. */
const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  ".git", // history is not edited
  "node_modules", // not ours
  "dist", // a build product of the sources below
  "backlog", // audited separately: the sweep task names its own search target
]);

/** Every file under `dir`, recursively, skipping {@link SKIPPED_DIRS}. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

test("the retired product name appears nowhere outside backlog/", () => {
  // Assembled rather than written out: this file is inside its own search
  // space, and a guard that failed on its own source would have to be exempted,
  // which is exactly the exemption a reintroduction would hide behind.
  const needle = ["carts", "os"].join("");
  const offenders: string[] = [];
  for (const path of walk(REPO_ROOT)) {
    // latin1 rather than utf8: this is a byte scan, so a binary asset is
    // searched rather than skipped, and no file needs an extension allowlist.
    const text = readFileSync(path).toString("latin1").toLowerCase();
    if (text.includes(needle)) offenders.push(path.slice(REPO_ROOT.length));
  }
  assert.deepEqual(
    offenders,
    [],
    `the retired product name was reintroduced in: ${offenders.join(", ")}. The canonical example's origin.app is \`example-capture\`, chosen because a name frozen into fixtures must read as unmistakably illustrative. Prose uses the generic phrasing from SPEC.md section 12.`,
  );
});
