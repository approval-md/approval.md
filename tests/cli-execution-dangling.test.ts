/**
 * `approval execution resolve --dangling` — the bulk form (APRV-264).
 *
 * ## The manual step these cases remove
 *
 * 2026-09-05: `approval status` listed five dangling daemon log-advance
 * executions, and they were closed by hand with five near-identical
 * `approval execution resolve <key> --outcome completed --note "…"` commands in
 * a second terminal window. The whole content of each of those five notes was
 * the same fact, which the runtime could have read off a git ref and shown the
 * operator once.
 *
 * ## Two shapes of case, and the split is the point
 *
 * - **Spawned**, for what has to be true of the real process. The load-bearing
 *   one is that a PIPE on stdin refuses: every record this verb appends carries
 *   `attested_by_human: true`, and a confirmation something without a terminal
 *   could answer is not an attestation. It cannot be proved by injecting a
 *   prompter.
 * - **In-process with a scripted prompter**, for the conversation itself —
 *   what was listed, what was asked, and what was written when the answer was
 *   yes and when it was no.
 *
 * Nothing here writes a log line by hand. The dangling advance cycle is built
 * by the real gate (register, request, `startExecution`) and then simply never
 * closed, exactly as a crash between the start and its outcome leaves it; the
 * dangling cycle nothing can prove is built the same way under an ordinary
 * class. `approval log verify` runs at the end of every flow.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";

import { appendAttestation } from "../src/core/attest.js";
import {
  ADVANCE_ACTOR,
  ADVANCE_CLASS,
  advanceActionKey,
  advanceTaskId,
} from "../src/core/advance-cycle.js";
import { danglingExecutions, startExecution } from "../src/core/execute.js";
import { register, request } from "../src/core/gate.js";
import { payloadHash } from "../src/core/payload.js";
import { readVerifiedRecords } from "../src/core/state.js";
import { logAdvance, publishedState } from "../src/cli/log-advance.js";
import { commandExecution } from "../src/cli/execute.js";
import { defaultCadence } from "../src/daemon/advance.js";
import { VERB_REGISTRY, type JsonSchema } from "../src/cli/verb-registry.js";
import type { Streams } from "../src/cli/main.js";
import type { Prompter, SecretRead } from "../src/cli/prompt.js";

const addFormats = (addFormatsModule as unknown as { default: FormatsPlugin }).default;

/** dist/tests/cli-execution-dangling.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-cli-dangling-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const LOG_RELATIVE = ".approval/log/events.jsonl";
const QUEUE_RELATIVE = ".approval/QUEUE.md";
const MARKER_RELATIVE = ".approval/attest-marker.md";
const TODAY = "2026-09-05T09:00:00.000Z";
const RECORDS_BRANCH = "records-log-2026-09-05";
const HUMAN = "human:carter";

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
  "  log.advance:",
  "    autonomy: supervised",
  "  net.send:",
  "    autonomy: supervised",
  "```",
  "",
].join("\n");

function git(args: string[], cwd: string): number {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  return result.status ?? -1;
}

/** A `gh` that answers `pr list` and `pr create` and REFUSES `pr merge`. */
function ghStub(): string {
  counter += 1;
  const dir = join(scratch, `gh-bin-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  const script = [
    "#!/bin/sh",
    'case "$1" in',
    '  pr) case "$2" in',
    "    list) echo '[]'; exit 0 ;;",
    '    create) echo "https://example.invalid/pr/1"; exit 0 ;;',
    '    merge) echo "never" >&2; exit 3 ;;',
    "  esac ;;",
    "esac",
    "exit 1",
    "",
  ].join("\n");
  const path = join(dir, "gh");
  writeFileSync(path, script, "utf8");
  chmodSync(path, 0o755);
  return dir;
}

interface Repo {
  dir: string;
  logPath: string;
  policyPath: string;
  ghDir: string;
}

function newRepo(): Repo {
  counter += 1;
  const remote = join(scratch, `remote-${String(counter)}.git`);
  const dir = join(scratch, `work-${String(counter)}`);
  mkdirSync(join(dir, ".approval", "log"), { recursive: true });
  const policyPath = join(dir, "APPROVAL.md");
  writeFileSync(policyPath, POLICY, "utf8");
  writeFileSync(join(dir, "README.md"), "# fixture\n", "utf8");
  writeFileSync(join(dir, QUEUE_RELATIVE), "# queue\n", "utf8");
  writeFileSync(join(dir, ".gitignore"), `${MARKER_RELATIVE}\n`, "utf8");

  const attested = appendAttestation(join(dir, LOG_RELATIVE), policyPath, HUMAN);
  assert.equal(attested.ok, true, attested.ok ? "" : attested.error.message);

  assert.equal(git(["init", "-q", "--bare", "-b", "main", remote], scratch), 0);
  assert.equal(git(["init", "-q", "-b", "main", "."], dir), 0);
  git(["config", "user.email", "test@example.invalid"], dir);
  git(["config", "user.name", "Test"], dir);
  assert.equal(git(["add", "-A"], dir), 0);
  assert.equal(git(["commit", "-qm", "seed"], dir), 0);
  assert.equal(git(["remote", "add", "origin", remote], dir), 0);
  assert.equal(git(["push", "-q", "-u", "origin", "main"], dir), 0);

  return { dir, logPath: join(dir, LOG_RELATIVE), policyPath, ghDir: ghStub() };
}

function records(repo: Repo) {
  const read = readVerifiedRecords(repo.logPath);
  assert.equal(read.ok, true, read.ok ? "" : read.message);
  if (!read.ok) throw new Error("unreachable");
  return read.records;
}

function danglingKeys(repo: Repo): string[] {
  return danglingExecutions([...records(repo)]).map((entry) => entry.actionKey);
}

function rawLog(repo: Repo): string {
  return existsSync(repo.logPath) ? readFileSync(repo.logPath, "utf8") : "";
}

function assertClean(repo: Repo): void {
  const verify = spawnSync(process.execPath, [CLI_ENTRY, "log", "verify"], {
    cwd: repo.dir,
    encoding: "utf8",
  });
  assert.equal(verify.status, 0, `${verify.stdout}${verify.stderr}`);
}

/** A filler record, through the real append path. */
function appendRecord(repo: Repo, marker: string): number {
  const result = register(
    repo.logPath,
    {
      task: `filler-${marker}`,
      envelope: {
        origin: { app: "fixture", created_by: HUMAN },
        state: "proposed",
        actions: [{ class: "read.local", idempotency_key: `filler-${marker}` }],
      },
    },
    HUMAN,
    { policy: { file: repo.policyPath } },
  );
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  return result.ok ? result.record.seq : 0;
}

/** Open one execution and never close it, through the real gate. */
function openExecution(
  repo: Repo,
  task: string,
  actionKey: string,
  cls: string,
  actor: string,
  payload: Record<string, unknown>,
): void {
  const gate = { policy: { file: repo.policyPath } };
  const hash = payloadHash(payload);
  const registered = register(
    repo.logPath,
    {
      task,
      envelope: {
        origin: { app: "fixture", created_by: actor },
        state: "proposed",
        actions: [
          {
            class: cls,
            idempotency_key: actionKey,
            summary: `${cls} for ${task}`,
            reversible: true,
            est_cost_usd: "0",
            payload_hash: hash,
          },
        ],
      },
    },
    actor,
    gate,
  );
  assert.equal(registered.ok, true, registered.ok ? "" : registered.message);

  const asked = request(
    repo.logPath,
    {
      task,
      actionKey,
      cls,
      reversible: true,
      est_cost_usd: "0",
      summary: `${cls} for ${task}`,
      payload_hash: hash,
      payload: { value: payload },
    },
    actor,
    gate,
  );
  assert.equal(asked.ok, true, asked.ok ? "" : asked.message);

  const started = startExecution(
    repo.logPath,
    actionKey,
    { policy: { file: repo.policyPath }, presentedPayloadHash: hash },
    actor,
  );
  assert.equal(started.ok, true, started.ok ? "" : started.message);
}

/** One dangling daemon advance cycle over the span `from..to`. */
function openAdvanceCycle(repo: Repo, from: number, to: number): string {
  const actionKey = advanceActionKey(from, to);
  openExecution(repo, advanceTaskId(to), actionKey, ADVANCE_CLASS, ADVANCE_ACTOR, {
    argv: ["approval", "log", "advance", "--pr", "--remote", defaultCadence().remote],
    cwd: repo.dir,
    seq: { from, to },
  });
  return actionKey;
}

/** Publish everything in the working log onto the day's records branch. */
function publish(repo: Repo): string {
  const previous = process.env["PATH"] ?? "";
  process.env["PATH"] = `${repo.ghDir}${delimiter}${previous}`;
  const advanced = logAdvance({
    cwd: repo.dir,
    remote: "origin",
    base: "main",
    pr: false,
    branch: RECORDS_BRANCH,
    today: TODAY,
  });
  process.env["PATH"] = previous;
  assert.equal(advanced.ok, true, advanced.ok ? "" : advanced.message);
  const state = publishedState(
    repo.dir,
    repo.logPath,
    records(repo),
    { ...defaultCadence(), base: "main" },
    TODAY,
  );
  assert.ok(state.publishedRev !== null, "the fixture published nothing");
  return state.publishedRev;
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

/** A prompter that answers `confirm` from a script and records what was asked. */
function scripted(answers: boolean[]): Prompter & { asked: string[] } {
  const asked: string[] = [];
  let index = 0;
  return {
    asked,
    readLine(prompt: string): string | null {
      // `confirmUntil` asks through `readLine`, so this is where the question
      // arrives and where the scripted yes or no is given back.
      asked.push(prompt);
      const answer = answers[index] ?? false;
      index += 1;
      return answer ? "y" : "n";
    },
    readSecret(): SecretRead {
      throw new Error("resolve must never ask for a secret");
    },
    confirm(): boolean {
      throw new Error("resolve asks through confirmUntil, not confirm");
    },
  };
}

/** Run `approval execution …` in this process with a scripted terminal. */
function run(
  repo: Repo,
  args: string[],
  prompter: Prompter | null,
): { code: number; out: string; err: string } {
  const sink = capture();
  const code = commandExecution(args, sink.streams, repo.dir, { prompter });
  return { code, out: sink.out(), err: sink.err() };
}

const AS = ["--as", HUMAN];

/** The registry's own output schema for `execution resolve`, compiled strict. */
function outputValidator(): (value: unknown) => boolean {
  const verb = VERB_REGISTRY.find(
    (entry) => entry.name === "execution" && entry.subcommand === "resolve",
  );
  assert.ok(verb !== undefined && verb.output !== null, "the registry has no resolve output schema");
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(verb.output as JsonSchema);
  return (value: unknown) => {
    const ok = validate(value);
    assert.ok(ok, `--json does not match the registry schema: ${JSON.stringify(validate.errors)}`);
    return ok;
  };
}

// ---------------------------------------------------------------------------
// The safeguard: no terminal, no attestation
// ---------------------------------------------------------------------------

test("a piped stdin cannot attest in bulk (APRV-264)", () => {
  const repo = newRepo();
  const first = appendRecord(repo, "one");
  const key = openAdvanceCycle(repo, 1, first);
  publish(repo);
  const before = rawLog(repo);

  const child = spawnSync(
    process.execPath,
    [CLI_ENTRY, "execution", "resolve", "--dangling", "--as", HUMAN],
    { cwd: repo.dir, encoding: "utf8", input: "y\n" },
  );
  assert.equal(child.status, 1, child.stderr);
  assert.match(child.stderr, /dangling-stdin-not-tty/u);
  assert.match(child.stderr, /--yes/u);
  assert.equal(rawLog(repo), before, "nothing was appended");
  assert.deepEqual(danglingKeys(repo), [key], "the execution still stands");
  assertClean(repo);
});

// ---------------------------------------------------------------------------
// The list, the question, and the records
// ---------------------------------------------------------------------------

test("--dangling lists provable and unprovable keys, asks once, and closes only the provable", () => {
  const repo = newRepo();
  const first = appendRecord(repo, "one");
  const provable = openAdvanceCycle(repo, 1, first);
  const second = appendRecord(repo, "two");
  const alsoProvable = openAdvanceCycle(repo, first + 1, second);
  // An ordinary execution that crashed: nothing about a git ref says anything
  // about whether this one sent its message.
  openExecution(repo, "task-send", "task-send:mail", "net.send", "agent:claude", {
    to: "nobody@example.invalid",
  });
  const ref = publish(repo);

  // And one advance whose span the trunk does NOT carry, opened after the
  // publish: the case has to prove that "provable" is a fact about this
  // checkout and not about the key's shape.
  const third = appendRecord(repo, "three");
  const unprovable = openAdvanceCycle(repo, second + 1, third);

  const prompter = scripted([true]);
  const result = run(repo, ["resolve", "--dangling", ...AS], prompter);
  assert.equal(result.code, 0, result.err);

  // ONE question, for the whole list.
  assert.equal(prompter.asked.length, 1, JSON.stringify(prompter.asked));
  assert.match(prompter.asked[0] ?? "", /Close 2 execution\(s\) as completed/u);
  assert.match(prompter.asked[0] ?? "", new RegExp(HUMAN, "u"));

  // The list names every key, and says of each what can be shown for it.
  for (const key of [provable, alsoProvable, unprovable, "task-send:mail"]) {
    assert.ok(result.out.includes(key), `${key} is not in the list:\n${result.out}`);
  }
  assert.ok(result.out.includes(ref), "the list does not name the ref that proves anything");
  assert.ok(
    result.out.includes(`approval execution resolve ${unprovable} --outcome`),
    "an unprovable key was not given its own one-line command",
  );

  // Two records, and only two. The unprovable advance and the ordinary
  // execution are untouched: an outcome nobody can demonstrate is a person's.
  assert.deepEqual(
    danglingKeys(repo).sort(),
    [unprovable, "task-send:mail"].sort(),
    "the sweep closed something it could not prove",
  );
  for (const key of [provable, alsoProvable]) {
    const record = records(repo).find(
      (entry) => entry.action_key === key && entry.event === "execution.completed",
    );
    assert.ok(record !== undefined, `${key} was not closed`);
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    // Every rule of the single form, intact.
    assert.equal(payload["attested_by_human"], true);
    assert.equal(payload["exit_code"], null);
    assert.equal(record.actor, HUMAN);
    // And the note is the EVIDENCE, not a summary: it names the ref and the seq
    // the operator was shown before they said yes.
    assert.ok(String(payload["note"]).includes(ref), String(payload["note"]));
    assert.ok(String(payload["note"]).includes(key), String(payload["note"]));
  }
  assertClean(repo);
});

test("--dangling appends nothing when the confirmation is declined", () => {
  const repo = newRepo();
  const first = appendRecord(repo, "one");
  const key = openAdvanceCycle(repo, 1, first);
  publish(repo);
  const before = rawLog(repo);

  const prompter = scripted([false]);
  const result = run(repo, ["resolve", "--dangling", ...AS], prompter);
  assert.equal(result.code, 1, result.out);
  assert.match(result.err, /dangling-declined/u);
  assert.equal(rawLog(repo), before, "a declined confirmation wrote to the log");
  assert.deepEqual(danglingKeys(repo), [key]);
  assertClean(repo);
});

test("--yes closes the provable keys with no terminal at all", () => {
  const repo = newRepo();
  const first = appendRecord(repo, "one");
  const key = openAdvanceCycle(repo, 1, first);
  publish(repo);

  // `null` is "there is no terminal", which is what a runbook has. `--yes` is
  // the answer it gives after reading the same list with --json.
  const result = run(repo, ["resolve", "--dangling", "--yes", ...AS], null);
  assert.equal(result.code, 0, result.err);
  assert.ok(result.out.includes(`resolved ${key} as completed`), result.out);
  assert.deepEqual(danglingKeys(repo), []);
  assertClean(repo);
});

// ---------------------------------------------------------------------------
// --class, --json, and the empty case
// ---------------------------------------------------------------------------

test("--class narrows the list to one declared class and leaves the rest alone", () => {
  const repo = newRepo();
  const first = appendRecord(repo, "one");
  const advance = openAdvanceCycle(repo, 1, first);
  openExecution(repo, "task-send", "task-send:mail", "net.send", "agent:claude", {
    to: "nobody@example.invalid",
  });
  publish(repo);

  const prompter = scripted([true]);
  const result = run(repo, ["resolve", "--dangling", "--class", ADVANCE_CLASS, ...AS], prompter);
  assert.equal(result.code, 0, result.err);
  assert.ok(!result.out.includes("task-send:mail"), `the other class was listed:\n${result.out}`);
  assert.deepEqual(danglingKeys(repo), ["task-send:mail"]);
  assert.ok(result.out.includes(`resolved ${advance} as completed`), result.out);
  assertClean(repo);
});

test("--json carries the list, matches the registry schema, and asks before it writes", () => {
  const repo = newRepo();
  const first = appendRecord(repo, "one");
  const provable = openAdvanceCycle(repo, 1, first);
  const ref = publish(repo);
  const second = appendRecord(repo, "two");
  const unprovable = openAdvanceCycle(repo, first + 1, second);

  const validate = outputValidator();
  const prompter = scripted([true]);
  const result = run(repo, ["resolve", "--dangling", "--json", ...AS], prompter);
  assert.equal(result.code, 0, result.err);
  assert.equal(prompter.asked.length, 1, "--json is not an answer to the question");

  const value = JSON.parse(result.out.trim()) as {
    ok: boolean;
    dangling: {
      action_key: string;
      class: string | null;
      provable: boolean;
      proven_by: string | null;
      proven_seq: number | null;
      fix?: string;
    }[];
    resolved: { action_key: string; seq: number; proven_by: string | null }[];
    unresolved: string[];
    actor: string;
  };
  validate(value);
  assert.equal(value.ok, true);
  assert.equal(value.actor, HUMAN);
  assert.deepEqual(
    value.dangling.map((entry) => entry.action_key).sort(),
    [provable, unprovable].sort(),
  );

  const proved = value.dangling.find((entry) => entry.action_key === provable);
  assert.equal(proved?.provable, true);
  assert.equal(proved?.proven_by, ref);
  assert.equal(proved?.proven_seq, first);
  assert.equal(proved?.class, ADVANCE_CLASS);

  const open = value.dangling.find((entry) => entry.action_key === unprovable);
  assert.equal(open?.provable, false);
  assert.equal(open?.proven_by, null);
  assert.ok(String(open?.fix).includes(unprovable), "an unprovable entry carries no repair");

  assert.deepEqual(
    value.resolved.map((entry) => entry.action_key),
    [provable],
  );
  assert.deepEqual(value.unresolved, [unprovable]);
  assertClean(repo);
});

test("--dangling on a clean log exits 0, asks nothing, and appends nothing", () => {
  const repo = newRepo();
  appendRecord(repo, "one");
  const before = rawLog(repo);

  const prompter = scripted([true]);
  const result = run(repo, ["resolve", "--dangling", ...AS], prompter);
  assert.equal(result.code, 0, result.err);
  assert.equal(prompter.asked.length, 0, "a question was asked about nothing");
  assert.match(result.out, /no dangling executions/u);
  assert.equal(rawLog(repo), before);
  assertClean(repo);
});

// ---------------------------------------------------------------------------
// The two forms do not blur into each other
// ---------------------------------------------------------------------------

test("the two forms refuse each other's arguments as usage errors", () => {
  const repo = newRepo();
  const first = appendRecord(repo, "one");
  const key = openAdvanceCycle(repo, 1, first);
  publish(repo);
  const before = rawLog(repo);

  // A key with --dangling: the bulk form acts on the list, and naming one is
  // the single form.
  const named = run(repo, ["resolve", "--dangling", key, ...AS], scripted([true]));
  assert.equal(named.code, 2, named.err);
  assert.match(named.err, /takes no <action-key>/u);

  // An outcome or a note with --dangling: nothing is inferred for a key nothing
  // proves, and the note for a key something proves is the evidence itself.
  const noted = run(
    repo,
    ["resolve", "--dangling", "--outcome", "completed", "--note", "trust me", ...AS],
    scripted([true]),
  );
  assert.equal(noted.code, 2, noted.err);
  assert.match(noted.err, /neither --outcome nor --note/u);

  // And the bulk flags on the single form.
  const confused = run(
    repo,
    ["resolve", key, "--outcome", "completed", "--note", "looked", "--yes", ...AS],
    scripted([true]),
  );
  assert.equal(confused.code, 2, confused.err);
  assert.match(confused.err, /belong to the bulk form/u);

  assert.equal(rawLog(repo), before, "a usage error wrote to the log");
  assert.deepEqual(danglingKeys(repo), [key]);
  assertClean(repo);
});

test("--dangling is human-only: an agent identity is refused before anything is read", () => {
  const repo = newRepo();
  const first = appendRecord(repo, "one");
  openAdvanceCycle(repo, 1, first);
  publish(repo);
  const before = rawLog(repo);

  const result = run(
    repo,
    ["resolve", "--dangling", "--as", "agent:claude"],
    scripted([true]),
  );
  assert.equal(result.code, 2, result.err);
  assert.match(result.err, /human:<id>/u);
  assert.equal(rawLog(repo), before);
  assertClean(repo);
});
