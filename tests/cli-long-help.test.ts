/**
 * The help SPLIT, the wordmark, and the colour boundary (APRV-91 #7/#12, #16).
 *
 * APRV-91 cut every per-verb help down to 25 lines and moved the reasoning into
 * `docs/cli-reference.md`. That trade is only honest if the moved prose is still
 * reachable from the terminal, so the contract this file guards has two halves:
 *
 *   1. THE CAP IS REAL. No per-verb short help exceeds 25 lines. Measured over
 *      every exported constant, so a verb cannot grow back one paragraph at a
 *      time the way this file's subjects did the first time.
 *   2. THE LONG FORM IS ONE FLAG AWAY, and it actually carries the prose. It is
 *      not enough for `--long` to exit 0: the test reads the anchor out of the
 *      short help, reads the section out of the reference, and asserts the
 *      words came through.
 *
 * The third subject is the colour boundary, tested here because it is a
 * property of the CLI rather than of `style.ts`: with colour forced ON, human
 * output gains escapes and `--json` gains none.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import * as help from "../src/cli/help.js";
import { anchorOf, helpFor, longHelp, referenceSection } from "../src/cli/long-help.js";
import { main } from "../src/cli/main.js";
import { makeStyle } from "../src/cli/style.js";
import { plainWordmark, VERSION, wordmark } from "../src/cli/wordmark.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI_ENTRY = join(REPO_ROOT, "cli.js");
const REFERENCE = readFileSync(join(REPO_ROOT, "docs/cli-reference.md"), "utf8");
const PACKAGE = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
  version: string;
  files: string[];
};

// oxlint-disable-next-line no-control-regex -- detecting ANSI IS the point
const ESCAPE = /\u001b/u;

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
  return mkdtempSync(join(tmpdir(), "approval-long-"));
}

/** Run `argv` with colour forced on, then put the environment back. */
function withColour<T>(run: () => T): T {
  const previous = process.env["FORCE_COLOR"];
  process.env["FORCE_COLOR"] = "1";
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env["FORCE_COLOR"];
    else process.env["FORCE_COLOR"] = previous;
  }
}

// ---------------------------------------------------------------------------
// 1. The 25-line cap
// ---------------------------------------------------------------------------

test("no per-verb short help exceeds 25 lines", () => {
  // The root help is exempt by design: it is the one page that carries the verb
  // index, the frozen exit-code table and the stances every verb inherits, and
  // splitting THAT is how you get an operator who never finds the exit codes.
  const offenders: string[] = [];
  for (const [name, text] of HELP_TEXTS) {
    if (name === "ROOT_HELP") continue;
    const lines = text.split("\n").length;
    if (lines > 25) offenders.push(`${name} (${String(lines)} lines)`);
  }
  assert.deepEqual(
    offenders,
    [],
    `these short helps are over the 25-line cap. The reasoning belongs in docs/cli-reference.md, reachable with --long:\n  ${offenders.join("\n  ")}`,
  );
});

test("every per-verb short help names the anchor its long form lives at", () => {
  // This is what makes --long possible at all: no anchor, no long form.
  for (const [name, text] of HELP_TEXTS) {
    if (name === "ROOT_HELP") continue;
    const anchor = anchorOf(text);
    assert.notEqual(anchor, null, `${name} has no "why: docs/cli-reference.md#…" footer`);
    assert.notEqual(
      referenceSection(anchor ?? "", REFERENCE),
      null,
      `${name} points at #${anchor ?? ""}, which is not a heading in docs/cli-reference.md`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. --long prints the moved prose
// ---------------------------------------------------------------------------

test("--long prints the short help verbatim and then the reference section", () => {
  const short = help.QUEUE_HELP;
  const rendered = longHelp(short, { reference: REFERENCE, style: makeStyle({ tty: false }) });

  // Additive by definition: an operator who learned the short help must not
  // have to re-find their bearings because they asked for more.
  assert.ok(rendered.startsWith(short), "--long did not open with the short help verbatim");

  const anchor = anchorOf(short) ?? "";
  const section = referenceSection(anchor, REFERENCE) ?? "";
  assert.ok(section.length > 0, "the queue section of the reference is empty");
  assert.ok(rendered.includes(section), "--long did not include the anchor's prose");
  assert.ok(rendered.length > short.length, "--long added nothing");
});

test("approval help <verb> --long reaches the same text through the CLI", () => {
  const dir = scratch();
  const short = capture(["help", "queue"], dir);
  const long = capture(["help", "queue", "--long"], dir);
  assert.equal(short.code, 0);
  assert.equal(long.code, 0);
  assert.ok(long.out.length > short.out.length, "--long printed no more than the short help");

  // The anchor's actual prose, not merely a pointer to it.
  const section = referenceSection(anchorOf(help.QUEUE_HELP) ?? "", REFERENCE) ?? "";
  const claim = section.split("\n").find((line) => line.length > 40) ?? "";
  assert.ok(claim.length > 0);
  assert.ok(long.out.includes(claim), `--long is missing the reference prose: ${claim}`);
  assert.equal(short.out.includes(claim), false, "the short help already carried the long prose");
});

test("--long is spelled the same way on a verb as on the help command", () => {
  const dir = scratch();
  assert.equal(
    capture(["queue", "--help", "--long"], dir).out,
    capture(["help", "queue", "--long"], dir).out,
  );
});

test("--long survives a reference that is not installed", () => {
  // A documentation flag that exits non-zero because a doc file moved would be
  // a worse bug than the missing prose.
  const rendered = longHelp(help.QUEUE_HELP, {
    reference: null,
    style: makeStyle({ tty: false }),
  });
  assert.ok(rendered.startsWith(help.QUEUE_HELP));
  assert.match(rendered, /docs\/cli-reference\.md#queue/u);
});

test("--long only means something alongside a help request", () => {
  const dir = scratch();
  // On its own it is an unknown flag, which is the honest answer.
  const stray = capture(["queue", "--long"], dir);
  assert.equal(stray.code, 2);
  assert.match(stray.err, /unknown flag --long/u);
});

test("the help index finds the longest matching verb", () => {
  assert.equal(helpFor(["log", "tail"]), help.TAIL_HELP);
  assert.equal(helpFor(["log"]), help.LOG_HELP);
  assert.equal(helpFor(["setup", "channel", "telegram"]), help.SETUP_CHANNEL_TELEGRAM_HELP);
  assert.equal(helpFor(["frobnicate"]), null);
});

test("the reference ships with the package, or --long is a lie", () => {
  assert.ok(
    PACKAGE.files.includes("docs/cli-reference.md"),
    'package.json "files" must ship docs/cli-reference.md: --long reads it at runtime',
  );
  assert.ok(PACKAGE.files.includes("dist"), 'package.json "files" must ship the build output');
});

// ---------------------------------------------------------------------------
// 3. The wordmark
// ---------------------------------------------------------------------------

test("the wordmark degrades to one line whenever colour is off", () => {
  const plain = wordmark(makeStyle({ tty: false }));
  assert.equal(plain, plainWordmark());
  assert.equal(plain.split("\n").length, 1);
  assert.equal(plain, `approval.md v${VERSION}`);
  assert.equal(ESCAPE.test(plain), false);
});

test("the wordmark degrades to one line in ASCII mode even on a colour terminal", () => {
  // A terminal that cannot promise UTF-8 is not a terminal to draw on, whatever
  // its colour support says.
  for (const env of [{ APPROVAL_ASCII: "1" }, { LANG: "C" }, { LC_ALL: "POSIX" }]) {
    const plain = wordmark(makeStyle({ tty: true, env }));
    assert.equal(plain, plainWordmark(), `env ${JSON.stringify(env)} drew the banner`);
  }
});

test("the wordmark is six lines of ASCII art plus a tagline on a terminal", () => {
  const art = wordmark(makeStyle({ tty: true, env: { LANG: "en_US.UTF-8" } }));
  const lines = art.split("\n");
  assert.equal(lines.length, 7, "six lines of art and one tagline line");
  // No half-blocks and no box drawing: those are the characters that break in
  // Terminal.app's default font. Strip the escapes and every byte is ASCII.
  // oxlint-disable-next-line no-control-regex -- detecting ANSI IS the point
  const bare = art.replace(/\u001b\[[0-9;]*m/gu, "");
  assert.match(bare, /human approval for agent actions · v/u);
  const artOnly = bare.split("\n").slice(0, 6).join("\n");
  // eslint-disable-next-line no-control-regex
  assert.ok(/^[\x20-\x7e\n]*$/u.test(artOnly), `the wordmark art is not pure ASCII:\n${artOnly}`);
});

test("the version in the wordmark is the package version", () => {
  assert.equal(VERSION, PACKAGE.version);
});

test("the wordmark appears on --help, on init, and on a bare invocation", () => {
  // Spawned with piped stdio rather than captured in process: in process, the
  // style is decided from THIS runner's stdout, which is a TTY when a human
  // runs `npm test` in a terminal, and then the art prints instead of the
  // one-line form asserted here. A pipe is the same answer everywhere.
  const dir = scratch();
  for (const argv of [["--help"], ["help"], [], ["init"]]) {
    const run = spawnSync(process.execPath, [CLI_ENTRY, ...argv], { cwd: dir, encoding: "utf8" });
    assert.ok(
      run.stdout.includes(plainWordmark()),
      `\`approval ${argv.join(" ")}\` printed no wordmark`,
    );
  }
});

test("the wordmark appears nowhere else", () => {
  // Principle five of the brief: verbs are tools, not billboards. A banner over
  // a refusal at 2am is an insult.
  //
  // Spawned rather than captured in process, because `doctor` is one of the
  // asynchronous verbs: it reports its code through `process.exitCode` when it
  // settles, so calling it in process leaves this test FILE holding a non-zero
  // exit long after the assertions passed.
  const dir = scratch();
  for (const argv of [["queue"], ["status"], ["doctor"], ["log", "verify"], ["queue", "--help"]]) {
    const run = spawnSync(process.execPath, [CLI_ENTRY, ...argv], { cwd: dir, encoding: "utf8" });
    assert.equal(
      (run.stdout + run.stderr).includes(plainWordmark()),
      false,
      `\`approval ${argv.join(" ")}\` printed the wordmark`,
    );
  }
});

test("a bare invocation still refuses, and the refusal is still one line", () => {
  // The orientation screen goes to stdout; the usage error keeps stderr and
  // exit 2, so anything scripting this CLI sees exactly what it saw before.
  const dir = scratch();
  const run = capture([], dir);
  assert.equal(run.code, 2);
  assert.match(run.err, /no command given/u);
  // "no command given" is an argument-shape error by APRV-91's own rule, so it
  // keeps the CAPPED synopsis: the shape of the command line is what was wrong.
  // What it must never be again is the whole 260-line root help.
  assert.ok(
    run.err.split("\n").length <= 14,
    `the bare refusal grew into a page (${String(run.err.split("\n").length)} lines):\n${run.err}`,
  );
  assert.doesNotMatch(run.err, /Exit codes \(frozen public API\)/u);

  // …and the five verbs a new operator needs are on stdout, under the wordmark.
  for (const verb of ["init", "setup", "doctor", "queue", "--help"]) {
    assert.ok(run.out.includes(verb), `the orientation screen omits ${verb}`);
  }
});

// ---------------------------------------------------------------------------
// 4. The colour boundary, end to end
// ---------------------------------------------------------------------------

test("piped human output carries no escape code", () => {
  // The spawned form is the real one: stdio is piped, so `process.stdout.isTTY`
  // is undefined and the whole palette is a no-op.
  const dir = scratch();
  for (const argv of [["--help"], ["help", "queue"], ["init"], ["doctor"], ["queue"], ["status"]]) {
    const run = spawnSync(process.execPath, [CLI_ENTRY, ...argv], { cwd: dir, encoding: "utf8" });
    assert.equal(
      ESCAPE.test(run.stdout + run.stderr),
      false,
      `\`approval ${argv.join(" ")}\` put an escape code in a pipe`,
    );
  }
});

test("--json carries no escape code even with colour forced on", () => {
  // The veto that makes the frozen shapes safe. One escape byte in a JSON
  // stream is a parse error, not a cosmetic regression.
  const dir = scratch();
  for (const argv of [["queue", "--json"], ["status", "--json"], ["log", "verify", "--json"]]) {
    const run = spawnSync(process.execPath, [CLI_ENTRY, ...argv], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "1" },
    });
    const stream = run.stdout + run.stderr;
    assert.equal(
      ESCAPE.test(stream),
      false,
      `\`approval ${argv.join(" ")}\` put an escape code in a --json stream`,
    );
    // Still exactly one JSON object per invocation.
    const body = run.stdout.trim() === "" ? run.stderr.trim() : run.stdout.trim();
    assert.doesNotThrow(() => JSON.parse(body), `--json emitted something unparseable: ${body}`);
  }
});

test("human output DOES gain colour when colour is forced on", () => {
  // The negative tests above are only meaningful if the positive one holds:
  // otherwise they would pass on a build where the palette does nothing.
  const dir = scratch();
  const run = withColour(() => capture(["--help"], dir));
  assert.ok(ESCAPE.test(run.out), "FORCE_COLOR=1 produced no colour at all");
});

test("--no-color turns it off again and never reaches the verb", () => {
  const dir = scratch();
  const run = withColour(() => capture(["--help", "--no-color"], dir));
  assert.equal(ESCAPE.test(run.out), false, "--no-color did not suppress colour");
  // The flag is consumed centrally, so no verb has to declare it and none can
  // call it unknown.
  const verb = withColour(() => capture(["queue", "--no-color"], dir));
  assert.doesNotMatch(verb.err, /unknown flag --no-color/u);
});

test("--no-color is not stolen from the command a verb is asked to run", () => {
  // `approval run … -- some-tool --no-color` is the child's flag, and rewriting
  // a command line we were asked to execute would be a real bug.
  const dir = scratch();
  const run = capture(["hook", "classify", "--", "mytool", "--no-color"], dir);
  assert.match(run.out + run.err, /--no-color/u, "the flag was stripped from the child's argv");
});
