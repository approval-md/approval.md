/**
 * The shape of what the CLI prints when it is not answering a question
 * (APRV-91): help pages and usage errors.
 *
 * These are structural guards rather than prose assertions. The observation
 * that produced them was a real `examples/email-demo.md` run: every usage error
 * appended the whole per-verb help, which restated its own rationale (the
 * trust-boundary paragraph appeared twice on one screen for `setup identity`)
 * and reprinted the frozen exit-code table, so the one line the operator needed
 * was buried. The rules that came out of it are cheap to state and easy to
 * regress, which is exactly what a test is for:
 *
 *   1. the frozen exit-code table is printed by `approval --help` and by no
 *      other help text;
 *   2. a usage error prints its message and a pointer, never a help page — with
 *      the usage synopsis added when the ARGUMENT SHAPE is what was wrong;
 *   3. no prompt line and no error line cites a SPEC.md section. The citations
 *      belong in `--help` (trimmed) and in `docs/cli-reference.md`;
 *   4. every `why: docs/cli-reference.md#…` footer resolves to a real heading,
 *      so the prose that was moved out of the help is prose a reader can find.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import * as help from "../src/cli/help.js";
import { isShapeError, synopsis, usageErrorText, verbOf } from "../src/cli/usage.js";
import { main } from "../src/cli/main.js";

/** The repository root, from `dist/tests/` at runtime. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const REFERENCE = readFileSync(join(REPO_ROOT, "docs/cli-reference.md"), "utf8");

/** Every exported help constant, by name. */
const HELP_TEXTS: Array<[string, string]> = Object.entries(help).filter(
  (entry): entry is [string, string] => typeof entry[1] === "string" && entry[0].endsWith("_HELP"),
);

function capture(argv: string[], cwd: string): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const code = main(argv, {
    cwd,
    streams: {
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
    },
  });
  return { code, out, err };
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "approval-help-"));
}

// ---------------------------------------------------------------------------
// 1. The exit-code table has one home
// ---------------------------------------------------------------------------

test("only the root help prints the frozen exit-code table", () => {
  assert.ok(HELP_TEXTS.length > 40, "the help module stopped exporting its constants");
  assert.match(help.ROOT_HELP, /Exit codes \(frozen public API\)/u);

  for (const [name, text] of HELP_TEXTS) {
    if (name === "ROOT_HELP") continue;
    assert.doesNotMatch(
      text,
      /Exit codes \(frozen public API\)/u,
      `${name} reprints the frozen exit-code table. It is printed by "approval --help" and nowhere else; a per-verb help says "exit codes: approval --help" and names only the codes peculiar to it.`,
    );
    assert.match(
      text,
      /exit codes: approval --help/u,
      `${name} neither prints the table nor points at it, so a reader of that verb has nowhere to find the codes`,
    );
  }
});

test("every help text opens with its verb and a usage block", () => {
  for (const [name, text] of HELP_TEXTS) {
    assert.match(text.split("\n", 1)[0] ?? "", /^approval\b.* — /u, `${name} has no title line`);
    assert.ok(text.includes("\nUsage:\n"), `${name} has no Usage: block`);
  }
});

// ---------------------------------------------------------------------------
// 2. Usage errors are a message and a pointer
// ---------------------------------------------------------------------------

test("a usage error prints a pointer, not the help page", () => {
  const dir = scratch();

  // Not an argument-shape error: the command line parsed, the runtime refused.
  const plain = usageErrorText("no identity was entered; nothing was written", help.INIT_HELP);
  assert.equal(
    plain,
    "approval: no identity was entered; nothing was written\nsee: approval init --help\n",
  );

  // An argument-shape error carries the synopsis, because the forms ARE the fix.
  const shape = capture(["log", "tail", "--nope"], dir);
  assert.equal(shape.code, 2);
  assert.match(shape.err, /unknown flag --nope/u);
  assert.match(shape.err, /Usage:\n {2}approval log tail/u);
  assert.match(shape.err, /see: approval log tail --help/u);
  // …and not the page: the flags, the JSON shape and the pointer to the docs
  // are all things `--help` prints and an error line must not.
  assert.doesNotMatch(shape.err, /JSON shape/u);
  assert.doesNotMatch(shape.err, /docs\/cli-reference\.md/u);
  assert.ok(
    shape.err.split("\n").length < 12,
    `a usage error grew back into a page:\n${shape.err}`,
  );
});

test("the synopsis is capped, so the root's forms cannot become the error", () => {
  const dir = scratch();
  const unknown = capture(["frobnicate"], dir);
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /unknown command "frobnicate"/u);
  assert.match(unknown.err, /see: approval --help/u);
  // Six forms, an ellipsis and the pointer — where the whole root help is 240
  // lines. The cap is what keeps `approval frobnicate` from being a page.
  assert.match(unknown.err, /^ {2}…$/mu);
  assert.ok(
    unknown.err.split("\n").length <= 14,
    `the root usage error printed ${unknown.err.split("\n").length} lines`,
  );
});

test("shape classification is a property of the message", () => {
  for (const message of [
    "missing <task> argument",
    "unknown flag --jsno",
    "unknown subcommand \"squash\" for `approval log`",
    "unexpected argument \"extra\"",
    "no command given",
    "flag --log requires a value",
    "--timeout expects a duration like 30s",
  ]) {
    assert.ok(isShapeError(message), `"${message}" should show the usage synopsis`);
  }
  for (const message of [
    "no human identity: set APPROVAL_HUMAN=human:<id> or pass --as human:<id>",
    "no token was entered; nothing was written",
    "--branch and --direct are mutually exclusive",
  ]) {
    assert.equal(isShapeError(message), false, `"${message}" is not an argument-shape error`);
  }
});

test("the pointer names the verb the help belongs to", () => {
  assert.equal(verbOf(help.ROOT_HELP), "approval");
  assert.equal(verbOf(help.TAIL_HELP), "approval log tail");
  assert.equal(verbOf(help.SETUP_CHANNEL_TELEGRAM_HELP), "approval setup channel telegram");
  assert.ok((synopsis(help.TAIL_HELP) ?? "").startsWith("Usage:\n  approval log tail"));
});

// ---------------------------------------------------------------------------
// 3. No SPEC citations in prompt and error lines
// ---------------------------------------------------------------------------

test("a scripted setup run cites no SPEC section on any line it prints", async () => {
  const dir = scratch();
  const { commandSetup } = await import("../src/cli/setup.js");
  const captured: string[] = [];
  const streams = {
    out: (text: string) => captured.push(text),
    err: (text: string) => captured.push(text),
  };

  // Every refusal path this verb family has that a pipe can reach: the
  // non-interactive refusal (which prints the whole non-interactive hint), the
  // renamed-verb refusal, an unknown channel, and a missing subcommand.
  for (const argv of [
    ["identity"],
    ["vault"],
    ["sampling"],
    ["telegram"],
    ["channel"],
    ["channel", "slack"],
    ["adapter"],
    [],
  ]) {
    await commandSetup(argv, streams, dir, {});
  }

  const printed = captured.join("");
  assert.ok(printed.length > 0, "the scripted setup run printed nothing at all");
  assert.doesNotMatch(
    printed,
    /SPEC\.md §/u,
    `a setup prompt or error line cites a SPEC section:\n${printed}`,
  );
});

test("the CLI's own usage and refusal lines cite no SPEC section", () => {
  const dir = scratch();
  const runs = [
    ["log", "tail", "--nope"],
    ["frobnicate"],
    ["init", "--force"],
    ["env", "--values"],
    ["vault", "get", "smtp.password"],
    ["payload", "hash"],
    ["run", "task-042:chaser"],
  ];
  for (const argv of runs) {
    const result = capture(argv, dir);
    assert.doesNotMatch(
      result.err + result.out,
      /SPEC\.md §/u,
      `\`approval ${argv.join(" ")}\` printed a SPEC citation:\n${result.err}${result.out}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 4. The moved prose is where the help says it is
// ---------------------------------------------------------------------------

/** Anchors are GitHub-style: the heading text, lowercased, spaces to dashes. */
function anchorsOf(markdown: string): Set<string> {
  const anchors = new Set<string>();
  for (const line of markdown.split("\n")) {
    const match = /^##+\s+(.+?)\s*$/u.exec(line);
    if (match === null) continue;
    anchors.add((match[1] ?? "").toLowerCase().replace(/[^a-z0-9 -]/gu, "").replace(/ /gu, "-"));
  }
  return anchors;
}

test("every why: pointer resolves to a heading in docs/cli-reference.md", () => {
  const anchors = anchorsOf(REFERENCE);
  let pointers = 0;
  for (const [name, text] of HELP_TEXTS) {
    for (const match of text.matchAll(/why: docs\/cli-reference\.md#([a-z0-9-]+)/gu)) {
      pointers += 1;
      const anchor = match[1] ?? "";
      assert.ok(
        anchors.has(anchor),
        `${name} points at docs/cli-reference.md#${anchor}, which has no heading. The prose trimmed out of a help text has to land somewhere a reader can reach.`,
      );
    }
  }
  assert.ok(pointers > 30, `only ${pointers} help texts point at the reference`);
});

test("the reference carries the rationale the help texts stopped printing", () => {
  for (const claim of [
    // vault: the threat model (was VAULT_THREAT_MODEL, in three help texts).
    "What the vault DEFENDS",
    "compromised host",
    "read the passphrase variable",
    // daemon: the concurrency stance.
    "Single writer, in intent only",
    // channel cli: the rendering convention and the identity caveat.
    "Identity is declared, not proved",
    // run: the dangling execution.
    "dangling execution",
    // doctor: the fix-line rule.
    "Every fix begins with a command",
    // status: the unrebuildable store.
    "be rebuilt from the log",
    // token: why this verb cannot print the token.
    "recoverable from\nnothing",
  ]) {
    assert.ok(
      REFERENCE.includes(claim),
      `docs/cli-reference.md no longer states "${claim}". The help texts point here instead of saying it themselves, so dropping it loses the reasoning entirely.`,
    );
  }
});
