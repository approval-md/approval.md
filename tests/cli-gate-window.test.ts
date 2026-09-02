/**
 * `approval gate open|close|status` (APRV-214, amended SPEC.md §5.2).
 *
 * Two shapes of case, and the split is the point:
 *
 *  - **Spawned**, for everything that has to be true of the real process. The
 *    load-bearing one is that `gate open` with a PIPE on stdin refuses: that is
 *    the safeguard which keeps the ceremony out of reach of a harness shell
 *    tool, and it cannot be proved by injecting a prompter.
 *  - **In-process with a scripted prompter**, for the ceremony itself. A test
 *    suite that needed a terminal would not run, and asserting on what was ASKED
 *    as well as on what was done is how "the word must be typed in full" becomes
 *    a test rather than a claim.
 *
 * No log line is written by hand: every record comes from a real verb, and
 * `approval log verify` runs at the end of each flow.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";

import { commandGate } from "../src/cli/gate-window.js";
import { VERB_REGISTRY, verbLabel, type JsonSchema } from "../src/cli/verb-registry.js";
import type { Streams } from "../src/cli/main.js";
import type { Prompter, SecretRead } from "../src/cli/prompt.js";

const addFormats = (addFormatsModule as unknown as { default: FormatsPlugin }).default;

/** dist/tests/cli-gate-window.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-cli-gate-window-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string, input = ""): Run {
  const childEnv = { ...process.env };
  delete childEnv["APPROVAL_HUMAN"];
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: childEnv,
    input,
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

const LOG = ".approval/log/events.jsonl";

/** An initialized, attested working directory. */
function ready(): string {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  const init = runCli(["init"], dir);
  assert.equal(init.code, 0, init.stderr);
  const attested = runCli(["policy", "attest", "--as", "human:carter"], dir);
  assert.equal(attested.code, 0, attested.stderr);
  return dir;
}

function rawLog(dir: string): string {
  const path = join(dir, LOG);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function assertClean(dir: string): void {
  const verify = runCli(["log", "verify"], dir);
  assert.equal(verify.code, 0, `${verify.stdout}${verify.stderr}`);
}

/** In-process streams, so a case can read exactly what was printed. */
function capture(): { streams: Streams; out(): string; err(): string } {
  let out = "";
  let err = "";
  return {
    streams: {
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
    },
    out: () => out,
    err: () => err,
  };
}

/** A prompter that answers with a fixed script and remembers what was asked. */
function scripted(answers: (string | null)[]): Prompter & { asked: string[] } {
  const asked: string[] = [];
  let index = 0;
  return {
    asked,
    readLine(prompt: string): string | null {
      asked.push(prompt);
      const answer = answers[index] ?? null;
      index += 1;
      return answer;
    },
    readSecret(): SecretRead {
      throw new Error("gate open must never ask for a secret");
    },
    confirm(): boolean {
      throw new Error("gate open must never use a y/N confirmation");
    },
  };
}

/** Run `approval gate …` in this process with a scripted terminal. */
function gate(
  dir: string,
  args: string[],
  prompter: Prompter | null,
): { code: number; out: string; err: string } {
  const sink = capture();
  const code = commandGate(args, sink.streams, dir, { prompter });
  return { code, out: sink.out(), err: sink.err() };
}

function lastRecord(dir: string): Record<string, unknown> {
  const lines = rawLog(dir).trim().split("\n");
  return JSON.parse(lines[lines.length - 1] ?? "{}") as Record<string, unknown>;
}

function statusJson(dir: string): { code: number; value: Record<string, unknown> } {
  const run = runCli(["status", "--json"], dir);
  return { code: run.code, value: JSON.parse(run.stdout.trim()) as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// The safeguard: no terminal, no window
// ---------------------------------------------------------------------------

test("a piped stdin cannot open a window (APRV-214)", () => {
  // THE test of this feature. A Claude Code Bash tool has no TTY, so this is
  // the shape every attempt from a harness takes, and the answer must be a
  // refusal rather than a window — however willing the word on stdin is.
  const dir = ready();
  const before = rawLog(dir);

  const run = runCli(
    ["gate", "open", "--for", "5m", "--reason", "let me in", "--as", "human:carter"],
    dir,
    "understood\n",
  );
  assert.equal(run.code, 1, run.stderr);
  assert.match(run.stderr, /gate-stdin-not-tty/u);
  assert.match(run.stderr, /no --yes and no --force/u);
  assert.equal(rawLog(dir), before, "nothing was appended");

  // And the window really is not open, asked through the reporting verb.
  const status = runCli(["gate", "status", "--json"], dir);
  assert.equal(status.code, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout.trim()), { ok: true, open: false, window: null });
  assertClean(dir);
});

test("--json on open refuses before any prompt (APRV-214)", () => {
  const dir = ready();
  const before = rawLog(dir);
  const prompter = scripted(["understood"]);
  const run = gate(
    dir,
    ["open", "--for", "5m", "--reason", "x", "--as", "human:carter", "--json"],
    prompter,
  );
  assert.equal(run.code, 1);
  assert.deepEqual(prompter.asked, [], "a machine-readable request is answered without asking");
  const error = JSON.parse(run.err.trim()) as { ok: boolean; error: { code: string } };
  assert.equal(error.ok, false);
  assert.equal(error.error.code, "gate-stdin-not-tty");
  assert.equal(rawLog(dir), before);
});

// ---------------------------------------------------------------------------
// The ceremony
// ---------------------------------------------------------------------------

test("the typed word opens the window, and the statement says what it costs (APRV-214)", () => {
  const dir = ready();
  const prompter = scripted(["understood"]);
  const run = gate(
    dir,
    ["open", "--reason", "the attestation is drifted", "--as", "human:carter"],
    prompter,
  );
  assert.equal(run.code, 0, run.err);

  // What the person was shown before they answered.
  assert.match(run.out, /a human-only ceremony/u);
  assert.match(run.out, /ALLOWED without approval/u);
  assert.match(run.out, /gate\.bypassed/u);
  assert.match(run.out, /UNHEALTHY/u);
  assert.match(run.out, /log\.mutate/u);
  assert.match(run.out, /human:carter/u);
  assert.equal(prompter.asked.length, 1);
  assert.match(prompter.asked[0] ?? "", /understood/u);

  const record = lastRecord(dir);
  assert.equal(record["event"], "gate.opened");
  assert.equal(record["actor"], "human:carter");
  const payload = record["payload"] as Record<string, unknown>;
  assert.equal(payload["duration"], "30m", "the default is 30m");
  assert.equal(payload["scope"], "hook");
  assert.equal(payload["reason"], "the attestation is drifted");
  // The expiry is the record's OWN ts plus the duration: one tick supplies
  // both, so a scheduling delay cannot put them out of step.
  assert.equal(
    payload["expires_at"],
    new Date(Date.parse(String(record["ts"])) + 30 * 60_000).toISOString(),
  );
  assertClean(dir);
});

test("anything but the word aborts, and the log is byte-identical (APRV-214)", () => {
  const dir = ready();
  const before = rawLog(dir);
  // `UNDERSTOOD` is refused because the answer is matched exactly after
  // trimming and never case-folded: a near miss is a miss.
  for (const answer of ["yes", "y", "UNDERSTOOD", "understood please", "", null]) {
    const prompter = scripted([answer]);
    const run = gate(
      dir,
      ["open", "--for", "5m", "--reason", "x", "--as", "human:carter"],
      prompter,
    );
    assert.equal(run.code, 1, `answer ${JSON.stringify(answer)} opened a window`);
    assert.match(run.err, /gate-confirmation-mismatch/u);
    assert.equal(prompter.asked.length, 1);
    assert.equal(rawLog(dir), before);
  }
  // Whitespace around the word is not a near miss: the answer is trimmed.
  const forgiving = gate(
    dir,
    ["open", "--for", "5m", "--reason", "x", "--as", "human:carter"],
    scripted(["  understood  "]),
  );
  assert.equal(forgiving.code, 0, forgiving.err);
  assertClean(dir);
});

test("an agent identity is refused before any prompt (APRV-214)", () => {
  const dir = ready();
  const before = rawLog(dir);
  for (const identity of ["agent:claude-code", "system:daemon", "carter"]) {
    const prompter = scripted(["understood"]);
    const run = gate(
      dir,
      ["open", "--for", "5m", "--reason", "x", "--as", identity],
      prompter,
    );
    assert.equal(run.code, 1);
    assert.match(run.err, /actor-not-human/u);
    assert.deepEqual(prompter.asked, [], "the identity is settled before anybody is asked");
    assert.equal(rawLog(dir), before);
  }
});

test("the duration cap and the reason are enforced (APRV-214)", () => {
  const dir = ready();
  const before = rawLog(dir);

  // Unparseable is a USAGE error, not a refusal: the runtime did not
  // understand the command rather than deciding against it.
  const garbled = gate(
    dir,
    ["open", "--for", "an hour", "--reason", "x", "--as", "human:carter"],
    scripted(["understood"]),
  );
  assert.equal(garbled.code, 2);
  assert.match(garbled.err, /--for expects a duration/u);

  const missing = gate(dir, ["open", "--as", "human:carter"], scripted(["understood"]));
  assert.equal(missing.code, 2);
  assert.match(missing.err, /--reason is required/u);

  const blank = gate(
    dir,
    ["open", "--reason", "   ", "--as", "human:carter"],
    scripted(["understood"]),
  );
  assert.equal(blank.code, 1);
  assert.match(blank.err, /gate-reason-required/u);

  const long = gate(
    dir,
    ["open", "--for", "25h", "--reason", "a long day", "--as", "human:carter"],
    scripted(["understood"]),
  );
  assert.equal(long.code, 1);
  assert.match(long.err, /gate-duration-too-long/u);
  assert.equal(rawLog(dir), before, "not one of those appended anything");

  // The cap itself is accepted: the refusal is "longer than", not "as long as".
  const capped = gate(
    dir,
    ["open", "--for", "24h", "--reason", "a full day of repair", "--as", "human:carter"],
    scripted(["understood"]),
  );
  assert.equal(capped.code, 0, capped.err);
  assertClean(dir);
});

test("a second open refuses; close needs a window (APRV-214)", () => {
  const dir = ready();

  const noWindow = gate(dir, ["close", "--as", "human:carter"], null);
  assert.equal(noWindow.code, 1);
  assert.match(noWindow.err, /gate-not-open/u);

  const opened = gate(
    dir,
    ["open", "--for", "1h", "--reason", "repairing the hook", "--as", "human:carter"],
    scripted(["understood"]),
  );
  assert.equal(opened.code, 0, opened.err);
  const openedSeq = Number(lastRecord(dir)["seq"]);

  const before = rawLog(dir);
  const again = gate(
    dir,
    ["open", "--for", "1h", "--reason", "again", "--as", "human:carter"],
    scripted(["understood"]),
  );
  assert.equal(again.code, 1);
  assert.match(again.err, /gate-already-open/u);
  assert.equal(rawLog(dir), before);

  const closed = gate(dir, ["close", "--as", "human:carter", "--json"], null);
  assert.equal(closed.code, 0, closed.err);
  const answer = JSON.parse(closed.out.trim()) as Record<string, unknown>;
  assert.equal(answer["ok"], true);
  assert.equal(answer["opened_seq"], openedSeq);
  assert.equal(answer["actor"], "human:carter");
  assert.equal(answer["bypassed"], 0);

  // The close's `--json` shape is the registry's, checked against the registry
  // rather than against a copy of it (APRV-85's both-directions pin).
  const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: true });
  addFormats(ajv);
  const spec = VERB_REGISTRY.find((entry) => verbLabel(entry) === "gate close");
  assert.notEqual(spec, undefined);
  const validate = ajv.compile(spec?.output as JsonSchema);
  assert.ok(validate(answer), JSON.stringify(validate.errors));

  // And closing twice is `gate-not-open` again, not a second closing record.
  const twice = gate(dir, ["close", "--as", "human:carter"], null);
  assert.equal(twice.code, 1);
  assert.match(twice.err, /gate-not-open/u);
  assertClean(dir);
});

test("close is human-only too, and refuses an agent (APRV-214)", () => {
  const dir = ready();
  const opened = gate(
    dir,
    ["open", "--for", "1h", "--reason", "x", "--as", "human:carter"],
    scripted(["understood"]),
  );
  assert.equal(opened.code, 0, opened.err);
  const before = rawLog(dir);
  const run = gate(dir, ["close", "--as", "agent:claude-code"], null);
  assert.equal(run.code, 1);
  assert.match(run.err, /actor-not-human/u);
  assert.equal(rawLog(dir), before);
  assertClean(dir);
});

// ---------------------------------------------------------------------------
// status, and the health it changes
// ---------------------------------------------------------------------------

test("gate status reports the window in text and in JSON (APRV-214)", () => {
  const dir = ready();

  const closed = runCli(["gate", "status"], dir);
  assert.equal(closed.code, 0, closed.stderr);
  assert.match(closed.stdout, /gate: closed/u);

  const opened = gate(
    dir,
    ["open", "--for", "2h", "--reason", "the daemon is hung", "--as", "human:carter"],
    scripted(["understood"]),
  );
  assert.equal(opened.code, 0, opened.err);
  const seq = Number(lastRecord(dir)["seq"]);

  const text = runCli(["gate", "status"], dir);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /gate: OPEN until /u);
  assert.match(text.stdout, /human:carter/u);
  assert.match(text.stdout, /the daemon is hung/u);
  assert.match(text.stdout, /approval gate close/u);

  const json = runCli(["gate", "status", "--json"], dir);
  const value = JSON.parse(json.stdout.trim()) as {
    ok: boolean;
    open: boolean;
    window: Record<string, unknown>;
  };
  assert.equal(value.ok, true);
  assert.equal(value.open, true);
  assert.equal(value.window["seq"], seq);
  assert.equal(value.window["opened_by"], "human:carter");
  assert.equal(value.window["reason"], "the daemon is hung");
  assert.equal(value.window["bypassed"], 0);
  assert.equal(value.window["scope"], "hook");
  assert.ok(Number(value.window["remaining_ms"]) > 0);
  assertClean(dir);
});

test("an open window makes the system unhealthy, additively (APRV-214)", () => {
  const dir = ready();

  const before = statusJson(dir);
  assert.equal(before.code, 0);
  assert.equal(before.value["healthy"], true);
  assert.equal("gate_window" in before.value, false, "no key where there is no window");

  const opened = gate(
    dir,
    ["open", "--for", "1h", "--reason", "repairing the gate", "--as", "human:carter"],
    scripted(["understood"]),
  );
  assert.equal(opened.code, 0, opened.err);

  const during = statusJson(dir);
  assert.equal(during.code, 1, "a CI check keyed on healthy goes red while a window stands");
  assert.equal(during.value["healthy"], false);
  const reported = during.value["gate_window"] as Record<string, unknown>;
  assert.equal(reported["opened_by"], "human:carter");
  assert.equal(reported["reason"], "repairing the gate");
  assert.equal(reported["bypassed"], 0);

  // The key is the ONLY difference: every other name a consumer reads is where
  // it was, so a repository with no window emits the object it always emitted.
  assert.deepEqual(
    Object.keys(during.value).filter((key) => key !== "gate_window"),
    Object.keys(before.value),
  );

  const text = runCli(["status"], dir);
  assert.match(text.stdout, /gate window/u);
  assert.match(text.stdout, /OPEN until/u);

  const closed = gate(dir, ["close", "--as", "human:carter"], null);
  assert.equal(closed.code, 0, closed.err);
  const after = statusJson(dir);
  assert.equal(after.code, 0);
  assert.equal(after.value["healthy"], true);
  assert.equal("gate_window" in after.value, false);
  assertClean(dir);
});

test("gate rejects an unknown subcommand and a stray argument (APRV-214)", () => {
  const dir = ready();
  for (const args of [["gate"], ["gate", "reopen"], ["gate", "status", "extra"]]) {
    const run = runCli(args, dir);
    assert.equal(run.code, 2, `${args.join(" ")} was not a usage error`);
  }
  const help = runCli(["gate", "--help"], dir);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /approval gate — the open window/u);
});
