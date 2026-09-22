/**
 * Quoted argument text is data, not syntax (APRV-353).
 *
 * The incident this suite exists for: on 2026-09-17 a lane could not record
 * what it had done, because the notes it wanted to append named the `Bash`
 * tool, carried an angle-bracketed placeholder, a pipe and a semicolon, and
 * those notes went through the gate as the arguments of a `backlog task edit`
 * command. A tokenizer that reads inside a quoted argument turns prose about
 * work into a refusal, and the author reaches for a rewording of the record
 * instead. SPEC.md §11 prices human attention; a gate that spends it on its own
 * misreading spends the wrong budget.
 *
 * The boundary the classifier honours is the shell's. A quoted argument is ONE
 * word, so the four things this suite pins are the four things the shell does:
 *
 * 1. single-quoted text is wholly inert;
 * 2. double-quoted text is inert too, except `$(…)` and backticks, which the
 *    shell expands and which must keep classifying as they do anywhere else;
 * 3. UNQUOTED operators split exactly as they always did;
 * 4. quoting that does not balance is a refusal, never a guess.
 *
 * The character sweep at the bottom is the part worth keeping. Writing a case
 * per character a lane happened to hit would pin the incident; sweeping every
 * printable ASCII byte in both quote styles pins the PROPERTY, which is what an
 * edit to `lex` has to keep.
 *
 * Pure, like the classifier: no disk, no clock, no log.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyCommand,
  commandSegmentWords,
  type ProtectedPathEntry,
} from "../src/core/command-class.js";

/** The note text from the incident: every construct that was misread, at once. */
const INCIDENT_NOTE =
  "Ran it through the Bash tool; wrote <abs>/lane.log | the exit code is what counts";

/** `classifyCommand`, asserting one segment, and returning it. */
function oneSegment(command: string): { class: string; rule: string; text: string } {
  const result = classifyCommand(command);
  assert.equal(
    result.ok,
    true,
    `expected ${JSON.stringify(command)} to classify, got ${
      result.ok ? "" : `${result.code}: ${result.detail}`
    }`,
  );
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.segments.length, 1, `expected one segment for ${JSON.stringify(command)}`);
  return result.segments[0] as { class: string; rule: string; text: string };
}

/** The words of the one segment of `command`, binary first. */
function oneSegmentWords(command: string): string[] {
  const parsed = commandSegmentWords(command);
  assert.notEqual(parsed, null, `expected ${JSON.stringify(command)} to tokenize`);
  if (parsed === null) throw new Error("unreachable");
  assert.equal(parsed.length, 1, `expected one segment for ${JSON.stringify(command)}`);
  const only = parsed[0] as { bin: string; args: string[] };
  return [only.bin, ...only.args];
}

// ---------------------------------------------------------------------------
// Criterion 1: the incident command, both quote styles
// ---------------------------------------------------------------------------

test("a single-quoted backlog note naming Bash, a placeholder, a pipe and a semicolon is one workspace write", () => {
  const command = `backlog task edit APRV-353 --append-notes '${INCIDENT_NOTE}'`;
  const segment = oneSegment(command);
  assert.equal(segment.class, "files.write.workspace");
  assert.equal(segment.rule, "workspace-tool");
  assert.deepEqual(oneSegmentWords(command), [
    "backlog",
    "task",
    "edit",
    "APRV-353",
    "--append-notes",
    INCIDENT_NOTE,
  ]);
});

test("the same note in double quotes is the same one workspace write", () => {
  const command = `backlog task edit APRV-353 --append-notes "${INCIDENT_NOTE}"`;
  const segment = oneSegment(command);
  assert.equal(segment.class, "files.write.workspace");
  assert.equal(segment.rule, "workspace-tool");
  assert.deepEqual(oneSegmentWords(command), [
    "backlog",
    "task",
    "edit",
    "APRV-353",
    "--append-notes",
    INCIDENT_NOTE,
  ]);
});

test("a quoted note naming a shell is prose, not an invocation", () => {
  for (const note of ["bash -c rm -rf /", "we ran bash and then sudo", "eval, source and exec"]) {
    for (const command of [
      `backlog task edit APRV-353 --append-notes '${note}'`,
      `backlog task edit APRV-353 --append-notes "${note}"`,
    ]) {
      const segment = oneSegment(command);
      assert.equal(segment.class, "files.write.workspace", command);
      assert.deepEqual(oneSegmentWords(command).slice(-1), [note], command);
    }
  }
});

test("a quoted argument is never a redirection target", () => {
  // `> lane.log` inside quotes creates no file, so nothing here is a write
  // ABOUT a path: the only write is the task file the tool edits.
  const command = `backlog task edit APRV-353 --append-notes 'node scripts/run-tests.mjs --only x > <dir>/lane.log 2>&1'`;
  const segment = oneSegment(command);
  assert.equal(segment.class, "files.write.workspace");
  assert.equal(segment.rule, "workspace-tool");
});

test("quoting a real path argument does not hide the path", () => {
  // The other direction, and deliberately unchanged: quoting stops text being
  // read as SYNTAX, and never stops a path being read as a path. A path-taking
  // command whose target is quoted takes the same protected class as one whose
  // target is bare, which is §11.1's fail-closed rule holding where it must.
  for (const command of ["cp x APPROVAL.md", `cp x 'APPROVAL.md'`, `cp x "APPROVAL.md"`]) {
    const segment = oneSegment(command);
    assert.equal(segment.class, "policy.core", command);
  }
});

test("a protected filename mentioned inside a note is prose, because the note is not a path argument", () => {
  // The distinction is what the ARGUMENT is, not whether it is quoted: the
  // note is one word handed to a workspace tool that takes no path there, so
  // it is read as the prose it is. The `cp` cases above are the same bytes in
  // a position where they name a file, and they classify as one.
  const segment = oneSegment(`backlog task edit APRV-353 --append-notes 'we did not touch APPROVAL.md'`);
  assert.equal(segment.class, "files.write.workspace");
});

// ---------------------------------------------------------------------------
// Criterion 2: what the shell expands inside double quotes still classifies
// ---------------------------------------------------------------------------

test("a command substitution inside double quotes still refuses", () => {
  const result = classifyCommand(
    `backlog task edit APRV-353 --append-notes "$(git push origin main)"`,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "opaque");
  assert.match(result.detail, /vcs\.push\.main/u);
});

test("a read-only command substitution inside double quotes stays inert, as it does unquoted", () => {
  const segment = oneSegment(`backlog task edit APRV-353 --append-notes "$(git log --oneline -1)"`);
  assert.equal(segment.class, "files.write.workspace");
});

test("a backtick inside double quotes refuses, and the refusal names the inert spelling", () => {
  const result = classifyCommand(
    "backlog task edit APRV-353 --append-notes \"verified with `npm test`\"",
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "opaque");
  assert.match(result.detail, /backtick/u);
  assert.match(result.detail, /single quotes/u);
});

test("the same backticks inside SINGLE quotes are literal text", () => {
  const segment = oneSegment(
    "backlog task edit APRV-353 --append-notes 'verified with `npm test`'",
  );
  assert.equal(segment.class, "files.write.workspace");
  assert.deepEqual(oneSegmentWords(
    "backlog task edit APRV-353 --append-notes 'verified with `npm test`'",
  ).slice(-1), ["verified with `npm test`"]);
});

test("arithmetic expansion inside double quotes still refuses", () => {
  const result = classifyCommand(`backlog task edit APRV-353 --append-notes "$((1 + 1))"`);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "opaque");
});

test("an UNQUOTED redirect, pipe and separator still split exactly as they did", () => {
  const redirect = classifyCommand("echo hello > lane.log");
  assert.equal(redirect.ok, true);
  if (!redirect.ok) return;
  assert.equal(redirect.segments.length, 1);
  assert.equal(redirect.segments[0]?.rule, "redirect-write");
  assert.equal(redirect.segments[0]?.class, "files.write.workspace");

  const piped = classifyCommand("git log --oneline | rm -rf /etc/hosts");
  assert.equal(piped.ok, true);
  if (!piped.ok) return;
  assert.equal(piped.segments.length, 2);
  assert.ok(piped.classes.includes("files.delete.out_of_scope"), piped.classes.join(","));

  const sequenced = classifyCommand("echo one ; git push origin main");
  assert.equal(sequenced.ok, true);
  if (!sequenced.ok) return;
  assert.equal(sequenced.segments.length, 2);
  assert.ok(sequenced.classes.includes("vcs.push.main"), sequenced.classes.join(","));
});

test("a quoted operator does NOT split, where the same operator unquoted does", () => {
  const quoted = classifyCommand("echo 'one ; git push origin main'");
  assert.equal(quoted.ok, true);
  if (!quoted.ok) return;
  assert.equal(quoted.segments.length, 1);
  assert.ok(!quoted.classes.includes("vcs.push.main"), quoted.classes.join(","));
});

// ---------------------------------------------------------------------------
// Fail closed: quoting that does not balance is a refusal
// ---------------------------------------------------------------------------

for (const command of [
  `backlog task edit APRV-353 --append-notes 'never closed`,
  `backlog task edit APRV-353 --append-notes "never closed`,
  `backlog task edit APRV-353 --append-notes "closed by an escape\\"`,
  `backlog task edit APRV-353 --append-notes "$(git log`,
  'backlog task edit APRV-353 --append-notes "opened `and never closed"',
]) {
  test(`unbalanced quoting fails closed: ${command}`, () => {
    const result = classifyCommand(command);
    assert.equal(result.ok, false, `expected a refusal for ${JSON.stringify(command)}`);
    if (result.ok) return;
    assert.ok(
      result.code === "unparseable" || result.code === "opaque",
      `expected a refusal code, got ${result.code}`,
    );
  });
}

// ---------------------------------------------------------------------------
// Concatenation and escapes, the way the shell does them
// ---------------------------------------------------------------------------

const CONCATENATION: readonly (readonly [string, string])[] = [
  [`backlog task edit T --append-notes 'a'"b"`, "ab"],
  [`backlog task edit T --append-notes "a"'b'`, "ab"],
  [`backlog task edit T --append-notes a'b'c"d"e`, "abcde"],
  [`backlog task edit T --append-notes "a\\"b"`, 'a"b'],
  [`backlog task edit T --append-notes a\\ b`, "a b"],
  [`backlog task edit T --append-notes ''`, ""],
  // A `$VAR` is kept verbatim: the tokenizer does not expand, and every rule
  // that reads a value treats a `$` as unknown, which resolves stricter.
  [`backlog task edit T --append-notes "$HOME/notes"`, "$HOME/notes"],
  // Backslash is literal inside single quotes, exactly as the shell has it.
  [`backlog task edit T --append-notes 'a\\b'`, "a\\b"],
];

for (const [command, expected] of CONCATENATION) {
  test(`quote concatenation: ${command}`, () => {
    assert.deepEqual(oneSegmentWords(command).slice(-1), [expected]);
  });
}

// ---------------------------------------------------------------------------
// The sweep: every printable ASCII byte, in both quote styles
// ---------------------------------------------------------------------------

/**
 * Every printable ASCII character plus newline and tab.
 *
 * The quote character of the style under test is excluded, because a bare quote
 * inside its own quoting is not that character being data — it is the end of the
 * quoting, which the unbalanced cases above already pin. In double quotes the
 * three characters the shell itself expands (`"`, `\`, `` ` ``) and `$` are
 * excluded for the same reason: their behaviour is the criterion-2 cases above,
 * not this property.
 */
const SWEEP: readonly string[] = (() => {
  const chars: string[] = [];
  for (let code = 32; code < 127; code += 1) chars.push(String.fromCharCode(code));
  chars.push("\n", "\t");
  return chars;
})();

test("every printable ASCII character is inert inside a single-quoted argument", () => {
  for (const ch of SWEEP) {
    if (ch === "'") continue;
    const note = `A${ch}B`;
    const command = `backlog task edit T --append-notes '${note}'`;
    const segment = oneSegment(command);
    assert.equal(segment.class, "files.write.workspace", `char ${JSON.stringify(ch)}`);
    assert.deepEqual(oneSegmentWords(command), [
      "backlog",
      "task",
      "edit",
      "T",
      "--append-notes",
      note,
    ], `char ${JSON.stringify(ch)}`);
  }
});

test("every printable ASCII character the shell does not expand is inert inside a double-quoted argument", () => {
  for (const ch of SWEEP) {
    if (ch === '"' || ch === "\\" || ch === "$" || ch === "`") continue;
    const note = `A${ch}B`;
    const command = `backlog task edit T --append-notes "${note}"`;
    const segment = oneSegment(command);
    assert.equal(segment.class, "files.write.workspace", `char ${JSON.stringify(ch)}`);
    assert.deepEqual(oneSegmentWords(command), [
      "backlog",
      "task",
      "edit",
      "T",
      "--append-notes",
      note,
    ], `char ${JSON.stringify(ch)}`);
  }
});

// ---------------------------------------------------------------------------
// Criterion 5: a quoted sentence that OPENS with a protected directory path
// (APRV-409)
// ---------------------------------------------------------------------------

/**
 * The second incident, and the same lesson arriving one layer later.
 *
 * On 2026-09-20 a `backlog task create` whose acceptance-criterion argument
 * opened with the literal text of a workflow path and ran on into a sentence
 * classified `policy.edit.ci` by rule `protected-path`, sat the full
 * nine-minute hook wait on the gate and was denied on timeout. The command
 * writes one task file and touches no workflow. The shell had already done its
 * job: the sentence was ONE word. The positional scan then split that word on
 * its slashes and matched a protected directory run against the front of it.
 *
 * The rule the fix draws: a positional word is prose when its protected match
 * came entirely from a whitespace-FREE head. One shape moves — a
 * directory-prefix match followed by whitespace — and the four shapes below it
 * do not: a bare path, a path with a real embedded space whose match needs its
 * final segment, a path inside a sentence, and a protected FILE at the head of
 * a sentence.
 *
 * The negative controls matter as much as the positives. This is a loosening,
 * in the file that answers "may this run".
 */

/** This repository's own routing, so the CI sub-class is the answer under test. */
const ROUTED_PATHS: readonly ProtectedPathEntry[] = [
  { path: ".github/workflows/", class: "policy.edit.ci" },
  { path: "design/", class: "policy.edit.design" },
  "SPEC.md",
];

/** `classifyCommand` over one segment, with the policy's entries and the bound path. */
function onePathSegment(
  command: string,
  protectedPaths: readonly ProtectedPathEntry[] = [],
): { class: string; rule: string; path?: string } {
  const result = classifyCommand(command, protectedPaths);
  assert.equal(
    result.ok,
    true,
    `expected ${JSON.stringify(command)} to classify, got ${
      result.ok ? "" : `${result.code}: ${result.detail}`
    }`,
  );
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.segments.length, 1, `expected one segment for ${JSON.stringify(command)}`);
  return result.segments[0] as { class: string; rule: string; path?: string };
}

/** The argument from the incident, verbatim apart from the task id. */
const CI_SENTENCE =
  ".github/workflows/pages.yml deploys _site/ on push to main with the minimal permissions" +
  " (contents read, pages write, id-token write) and no other secret";

test("the incident: a task criterion opening with the workflows path is a workspace write", () => {
  const segment = onePathSegment(`backlog task create x --ac "${CI_SENTENCE}"`, ROUTED_PATHS);
  assert.equal(segment.class, "files.write.workspace");
  assert.equal(segment.rule, "workspace-tool");
  assert.equal(segment.path, undefined);
});

test("the same sentence with no routing answers the same, so the fix is not about the sub-class", () => {
  assert.equal(
    onePathSegment(`backlog task create x --ac "${CI_SENTENCE}"`).class,
    "files.write.workspace",
  );
});

test("the shortest form of the shape: a path, a space, and four words", () => {
  const segment = onePathSegment(
    `backlog task create x --ac ".github/workflows/pages.yml should not gate this"`,
    ROUTED_PATHS,
  );
  assert.equal(segment.class, "files.write.workspace");
});

test("the same shape under the other effectful rows", () => {
  for (const command of [
    `cp a.txt ".github/workflows/pages.yml deploys the site on push to main"`,
    `tee ".github/workflows/pages.yml deploys the site on push to main"`,
    `mv a.txt ".github/workflows/pages.yml deploys the site on push to main"`,
  ]) {
    const segment = onePathSegment(command, ROUTED_PATHS);
    assert.notEqual(segment.rule, "protected-path", command);
    assert.ok(segment.class.startsWith("files."), `${command} -> ${segment.class}`);
  }
});

test("the log directory in a sentence is prose by the same rule, at the strictest tier", () => {
  assert.equal(
    onePathSegment(
      `backlog task create x --ac ".approval/log/events.jsonl is the live log and is never mutated"`,
    ).class,
    "files.write.workspace",
  );
});

test("a bare protected path is unmoved: no whitespace, nothing to decide", () => {
  for (const [command, expected] of [
    [`cp a.yml .github/workflows/pages.yml`, "policy.edit.ci"],
    [`cp a.md design/notes.md`, "policy.edit.design"],
    [`cp a.md SPEC.md`, "policy.edit"],
    [`cp a.md APPROVAL.md`, "policy.core"],
    [`cp a.jsonl .approval/log/events.jsonl`, "log.mutate"],
  ] as const) {
    const segment = onePathSegment(command, ROUTED_PATHS);
    assert.equal(segment.class, expected, command);
    assert.equal(segment.rule, "protected-path", command);
  }
});

test("a path with a real embedded space is unmoved when its match needs the final segment", () => {
  for (const [command, expected] of [
    [`cp a.md "my notes dir/CLAUDE.md"`, "policy.edit"],
    [`cp a.md "my notes dir/APPROVAL.md"`, "policy.core"],
    [`cp a.md "my notes dir/SPEC.md"`, "policy.edit"],
  ] as const) {
    const segment = onePathSegment(command, ROUTED_PATHS);
    assert.equal(segment.class, expected, command);
    assert.equal(segment.rule, "protected-path", command);
  }
});

test("whitespace BEFORE the protected run leaves the word a path: the head classifies as nothing", () => {
  const segment = onePathSegment(
    `cp a.yml "my notes dir/.github/workflows/pages.yml"`,
    ROUTED_PATHS,
  );
  assert.equal(segment.class, "policy.edit.ci");
  assert.equal(segment.rule, "protected-path");
  assert.equal(segment.path, "my notes dir/.github/workflows/pages.yml");
});

test("the skip needs the head to answer the SAME surface, so a deeper match is kept", () => {
  // The head `.github/workflows` answers `policy.edit.ci`; the whole word
  // answers `policy.core`, because its FINAL segment is the policy file. The
  // match therefore needed a segment the head does not carry, and the word
  // stays a path — which is the policy file itself, in a directory named with
  // a space.
  const segment = onePathSegment(`cp a.md ".github/workflows/sub dir/APPROVAL.md"`, ROUTED_PATHS);
  assert.equal(segment.class, "policy.core");
  assert.equal(segment.rule, "protected-path");
});

test("a path inside a sentence rather than at its head is unmoved: it never matched", () => {
  assert.equal(
    onePathSegment(
      `backlog task create x --ac "a sentence naming .github/workflows/pages.yml inside it"`,
      ROUTED_PATHS,
    ).class,
    "files.write.workspace",
  );
});

test("a protected FILE at the head of a sentence is unmoved: it never matched either", () => {
  for (const head of ["CLAUDE.md", "APPROVAL.md", "AGENTS.md"]) {
    const command = `backlog task create x --ac "${head} says the merge is armed by the session"`;
    assert.equal(onePathSegment(command, ROUTED_PATHS).class, "files.write.workspace", command);
  }
});

test("a write REDIRECTION onto the same sentence still takes the protected class", () => {
  const segment = onePathSegment(
    `echo hi > ".github/workflows/pages.yml deploys the site on push to main"`,
    ROUTED_PATHS,
  );
  assert.equal(segment.class, "policy.edit.ci");
  assert.equal(segment.rule, "redirect-protected");
});

test("a read of the sentence is unmoved, because the positional scan never runs on a read", () => {
  assert.equal(
    onePathSegment(
      `cat ".github/workflows/pages.yml deploys the site on push to main"`,
      ROUTED_PATHS,
    ).class,
    "read.shell",
  );
});
