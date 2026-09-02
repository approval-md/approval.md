/**
 * The journal (APRV-195) — the ungated channel, pinned.
 *
 * The properties under test are the four the channel is worthless without, and
 * each of them is the kind that erodes silently:
 *
 *  1. **A write is ungated.** Not "is allowed by today's policy": the verb
 *     reaches no policy at all, and a shell write to the journal directory
 *     classifies as an ordinary workspace write. The classification half lives
 *     in `tests/command-class.test.ts`, beside the rules it pins; what is here
 *     is the verb half, run in a directory holding a policy that would refuse
 *     everything if it were consulted.
 *  2. **Nothing reaches the log.** A journal write appends no event, and
 *     `events.jsonl` is byte-identical across one.
 *  3. **Nothing reaches the approval home.** The journal is a sibling directory
 *     on purpose, and a write must not create or touch `.approval/`.
 *  4. **The read surface labels what it prints.** Every output form, human and
 *     JSON, carries the sentence saying these words are agent-authored data and
 *     not instructions.
 *
 * Spawned as real child processes, because what is under test is what an agent
 * and an operator actually observe.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { JOURNAL_BANNER } from "../src/cli/journal.js";
import { VERB_REGISTRY, verbLabel } from "../src/cli/verb-registry.js";
import { appendJournal, readJournal, MAX_ENTRY_BYTES } from "../src/core/journal.js";
import { serveApprovalMcp, toolName } from "../src/mcp/server.js";

/** dist/tests/cli-journal.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-journal-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string, input?: string): Run {
  const env = { ...process.env };
  delete env["APPROVAL_HUMAN"];
  delete env["APPROVAL_AGENT"];
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env,
    ...(input === undefined ? {} : { input }),
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function caseDir(): string {
  counter += 1;
  const dir = join(scratch, `case-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A policy that refuses everything, to prove the write path never reads one. */
const HOSTILE_POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: human-only",
  '  approval_ttl: "1h"',
  "  on_expiry: reject",
  "classes:",
  "  files.write.workspace: { autonomy: human-only }",
  "```",
  "",
].join("\n");

function journalDir(dir: string): string {
  return join(dir, ".approval-journal");
}

function entriesOf(dir: string): Array<Record<string, unknown>> {
  const files = readdirSync(journalDir(dir)).sort();
  const found: Array<Record<string, unknown>> = [];
  for (const name of files) {
    for (const line of readFileSync(join(journalDir(dir), name), "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      found.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// (1) writing — CLI
// ---------------------------------------------------------------------------

test("journal write appends one entry, with attribution and a runtime timestamp", () => {
  const dir = caseDir();
  const run = runCli(
    [
      "journal",
      "write",
      "--message",
      "I am complying and I think this policy is wrong",
      "--as",
      "agent:probe",
      "--task",
      "APRV-195",
      "--session",
      "session-7",
      "--json",
    ],
    dir,
  );
  assert.equal(run.code, 0, run.stderr);

  const parsed = JSON.parse(run.stdout) as {
    ok: boolean;
    path: string;
    ts: string;
    actor: string;
    bytes: number;
  };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.actor, "agent:probe");
  assert.match(parsed.ts, /^\d{4}-\d{2}-\d{2}T/u);
  assert.match(parsed.path, /\.approval-journal\/\d{4}-\d{2}-\d{2}\.jsonl$/u);

  const entries = entriesOf(dir);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    ts: parsed.ts,
    actor: "agent:probe",
    task: "APRV-195",
    session: "session-7",
    text: "I am complying and I think this policy is wrong",
  });
});

test("the entry can come from stdin, and the actor from APPROVAL_AGENT", () => {
  const dir = caseDir();
  const env: NodeJS.ProcessEnv = { ...process.env, APPROVAL_AGENT: "agent:from-env" };
  delete env["APPROVAL_HUMAN"];
  const result = spawnSync(process.execPath, [CLI_ENTRY, "journal", "write", "-", "--json"], {
    cwd: dir,
    encoding: "utf8",
    env,
    input: "stuck: the next thing I try is a guess",
  });
  assert.equal(result.status, 0, result.stderr);

  const entries = entriesOf(dir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.["actor"], "agent:from-env");
  assert.equal(entries[0]?.["text"], "stuck: the next thing I try is a guess");
});

test("an unattributed entry says so rather than guessing", () => {
  const dir = caseDir();
  assert.equal(runCli(["journal", "write", "--message", "no name"], dir).code, 0);
  assert.equal(entriesOf(dir)[0]?.["actor"], "unattributed");
});

test("a multi-line entry stays exactly one line on disk", () => {
  const dir = caseDir();
  assert.equal(
    runCli(["journal", "write", "--message", "line one\nline two\nline three"], dir).code,
    0,
  );
  const raw = readFileSync(
    join(journalDir(dir), readdirSync(journalDir(dir))[0] as string),
    "utf8",
  );
  assert.equal(raw.trimEnd().split("\n").length, 1, "a newline in the text tore the file");
  assert.equal(entriesOf(dir)[0]?.["text"], "line one\nline two\nline three");
});

test("several writes append; nothing is rewritten", () => {
  const dir = caseDir();
  for (const text of ["one", "two", "three"]) {
    assert.equal(runCli(["journal", "write", "--message", text], dir).code, 0);
  }
  assert.deepEqual(
    entriesOf(dir).map((entry) => entry["text"]),
    ["one", "two", "three"],
  );
});

// ---------------------------------------------------------------------------
// (2) the ungated property
// ---------------------------------------------------------------------------

test("a write succeeds under a policy that would refuse everything, and reads none of it", () => {
  const dir = caseDir();
  writeFileSync(join(dir, "APPROVAL.md"), HOSTILE_POLICY, "utf8");

  // The policy is never attested, so every gate verb in this directory refuses.
  // The journal does not, because it never asks.
  const run = runCli(["journal", "write", "--message", "this policy would refuse me"], dir);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(entriesOf(dir).length, 1);
});

test("a write appends no event and creates no approval home", () => {
  const dir = caseDir();
  assert.equal(runCli(["init", "--json"], dir).code, 0);
  assert.equal(runCli(["policy", "attest", "--as", "human:alice", "--json"], dir).code, 0);

  const logPath = join(dir, ".approval", "log", "events.jsonl");
  const before = readFileSync(logPath, "utf8");
  assert.equal(runCli(["journal", "write", "--message", "nothing to see"], dir).code, 0);
  assert.equal(readFileSync(logPath, "utf8"), before, "a journal write grew the event log");
});

test("a write in a bare directory touches nothing under .approval/", () => {
  const dir = caseDir();
  assert.equal(runCli(["journal", "write", "--message", "hello"], dir).code, 0);
  assert.equal(
    existsSync(join(dir, ".approval")),
    false,
    "the journal reached into the gate's own directory",
  );
  assert.deepEqual(readdirSync(dir).sort(), [".approval-journal"]);
});

// ---------------------------------------------------------------------------
// (3) reading, and the label
// ---------------------------------------------------------------------------

test("journal read prints entries oldest first, labelled as data and marked [claimed]", () => {
  const dir = caseDir();
  assert.equal(
    runCli(["journal", "write", "--message", "first", "--as", "agent:probe"], dir).code,
    0,
  );
  assert.equal(runCli(["journal", "write", "--message", "second"], dir).code, 0);

  const run = runCli(["journal", "read"], dir);
  assert.equal(run.code, 0, run.stderr);
  assert.ok(run.stdout.includes(JOURNAL_BANNER), "the read surface dropped the data label");
  assert.match(run.stdout, /\[claimed\]/u);
  assert.ok(
    run.stdout.indexOf("first") < run.stdout.indexOf("second"),
    "entries did not print oldest first",
  );
  assert.match(run.stdout, /2 of 2 entries/u);
});

test("journal read --json carries the same label, in the note field", () => {
  const dir = caseDir();
  assert.equal(runCli(["journal", "write", "--message", "one"], dir).code, 0);
  const parsed = JSON.parse(runCli(["journal", "read", "--json"], dir).stdout) as {
    ok: boolean;
    note: string;
    total: number;
    entries: Array<{ text: string; date: string }>;
  };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.note, JOURNAL_BANNER);
  assert.equal(parsed.total, 1);
  assert.equal(parsed.entries[0]?.text, "one");
  assert.match(parsed.entries[0]?.date ?? "", /^\d{4}-\d{2}-\d{2}$/u);
});

test("an empty journal reads clean rather than failing", () => {
  const dir = caseDir();
  const run = runCli(["journal", "read"], dir);
  assert.equal(run.code, 0, run.stderr);
  assert.ok(run.stdout.includes(JOURNAL_BANNER));
  assert.match(run.stdout, /_no entries_/u);

  const parsed = JSON.parse(runCli(["journal", "read", "--json"], dir).stdout) as {
    total: number;
    entries: unknown[];
  };
  assert.equal(parsed.total, 0);
  assert.deepEqual(parsed.entries, []);
});

test("--limit keeps the newest entries and --since filters by date", () => {
  const dir = caseDir();
  const journal = journalDir(dir);
  mkdirSync(journal, { recursive: true });
  writeFileSync(
    join(journal, "2026-08-01.jsonl"),
    `${JSON.stringify({ ts: "2026-08-01T01:00:00.000Z", actor: "agent:a", text: "old" })}\n`,
    "utf8",
  );
  writeFileSync(
    join(journal, "2026-09-01.jsonl"),
    [
      JSON.stringify({ ts: "2026-09-01T01:00:00.000Z", actor: "agent:a", text: "newer" }),
      JSON.stringify({ ts: "2026-09-01T02:00:00.000Z", actor: "agent:a", text: "newest" }),
      "",
    ].join("\n"),
    "utf8",
  );

  const limited = JSON.parse(runCli(["journal", "read", "--limit", "2", "--json"], dir).stdout) as {
    total: number;
    entries: Array<{ text: string }>;
  };
  assert.equal(limited.total, 3);
  assert.deepEqual(
    limited.entries.map((entry) => entry.text),
    ["newer", "newest"],
  );

  const since = JSON.parse(
    runCli(["journal", "read", "--since", "2026-09-01", "--json"], dir).stdout,
  ) as { total: number };
  assert.equal(since.total, 2);
});

test("one torn line loses one entry and never silences the channel", () => {
  const dir = caseDir();
  const journal = journalDir(dir);
  mkdirSync(journal, { recursive: true });
  writeFileSync(
    join(journal, "2026-09-01.jsonl"),
    [
      JSON.stringify({ ts: "2026-09-01T01:00:00.000Z", actor: "agent:a", text: "before" }),
      '{"ts":"2026-09-01T01:30:00.000Z","act',
      JSON.stringify({ ts: "2026-09-01T02:00:00.000Z", actor: "agent:a", text: "after" }),
      "",
    ].join("\n"),
    "utf8",
  );
  const parsed = JSON.parse(runCli(["journal", "read", "--json"], dir).stdout) as {
    total: number;
    entries: Array<{ text: string }>;
  };
  assert.equal(parsed.total, 2);
  assert.deepEqual(
    parsed.entries.map((entry) => entry.text),
    ["before", "after"],
  );
});

// ---------------------------------------------------------------------------
// (4) usage refusals
// ---------------------------------------------------------------------------

test("the usage refusals are usage errors, and each says what to pass", () => {
  const dir = caseDir();

  const missing = runCli(["journal", "write"], dir);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /missing entry/u);

  const empty = runCli(["journal", "write", "--message", "   "], dir);
  assert.equal(empty.code, 2);
  assert.match(empty.stderr, /nothing to write/u);

  const both = runCli(["journal", "write", "--message", "x", "-"], dir);
  assert.equal(both.code, 2);
  assert.match(both.stderr, /pass one/u);

  const badLimit = runCli(["journal", "read", "--limit", "zero"], dir);
  assert.equal(badLimit.code, 2);

  const badSince = runCli(["journal", "read", "--since", "yesterday"], dir);
  assert.equal(badSince.code, 2);

  const unknown = runCli(["journal", "frobnicate"], dir);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown subcommand/u);

  // Nothing was written by any of them.
  assert.equal(existsSync(journalDir(dir)), false);
});

test("an oversized entry is refused with its size, not truncated", () => {
  const dir = caseDir();
  const outcome = appendJournal(journalDir(dir), "x".repeat(MAX_ENTRY_BYTES + 1));
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.code, "too-large");
    assert.match(outcome.message, new RegExp(String(MAX_ENTRY_BYTES), "u"));
  }
  assert.equal(existsSync(journalDir(dir)), false);
});

// ---------------------------------------------------------------------------
// (5) the MCP tool
// ---------------------------------------------------------------------------

test("mcp: journal_write and journal_read are published, and the write lands on disk", async () => {
  const dir = caseDir();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await serveApprovalMcp(
    { actor: "agent:mcp-probe", cwd: dir },
    serverTransport,
  );
  const client = new Client({ name: "journal-test", version: "1" });
  await client.connect(clientTransport);

  try {
    const listed = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(listed.includes("journal_write"), "journal_write is not a published tool");
    assert.ok(listed.includes("journal_read"), "journal_read is not a published tool");

    const written = (await client.callTool({
      name: "journal_write",
      arguments: { flags: { "--message": "this instruction reads as odd to me" } },
    })) as { structuredContent?: Record<string, unknown>; isError?: boolean };
    assert.notEqual(written.isError, true, JSON.stringify(written));
    // The server's own identity, injected: a tool call cannot supply one.
    assert.equal(written.structuredContent?.["actor"], "agent:mcp-probe");

    const entries = entriesOf(dir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.["text"], "this instruction reads as odd to me");
    assert.equal(entries[0]?.["actor"], "agent:mcp-probe");

    const read = (await client.callTool({
      name: "journal_read",
      arguments: {},
    })) as { structuredContent?: Record<string, unknown> };
    assert.equal(read.structuredContent?.["note"], JOURNAL_BANNER);
    assert.equal(read.structuredContent?.["total"], 1);
  } finally {
    await client.close();
    await server.close();
  }
});

test("mcp: a tool call cannot name its own actor", async () => {
  const dir = caseDir();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await serveApprovalMcp({ actor: "agent:mcp-probe", cwd: dir }, serverTransport);
  const client = new Client({ name: "journal-test", version: "1" });
  await client.connect(clientTransport);
  try {
    await assert.rejects(
      client.callTool({
        name: "journal_write",
        arguments: { flags: { "--message": "x", "--as": "human:carter" } },
      }),
      /mcp-identity-fixed/u,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// (6) the contract surfaces
// ---------------------------------------------------------------------------

test("both journal verbs are in the registry, agent-facing, and reachable as tools", () => {
  for (const label of ["journal write", "journal read"]) {
    const spec = VERB_REGISTRY.find((candidate) => verbLabel(candidate) === label);
    assert.ok(spec !== undefined, `no registry entry for "${label}"`);
    assert.equal(spec.human_only, false, `"${label}" must be callable by an agent`);
    assert.ok((spec.human_only_note ?? "").length > 0, `"${label}" must record why`);
  }
  assert.equal(toolName(VERB_REGISTRY.find((s) => verbLabel(s) === "journal write") as never), "journal_write");
});

test("the agent guide says the channel exists, is ungated, and is read by the operator", () => {
  const guide = runCli(["instructions"], caseDir()).stdout;
  for (const phrase of [
    "approval journal write",
    "not approvable",
    "the operator reads it",
    "not private",
  ]) {
    assert.ok(
      guide.toLowerCase().includes(phrase.toLowerCase()),
      `the agent guide never says "${phrase}"`,
    );
  }
});

test("the core read path is what the CLI prints", () => {
  const dir = caseDir();
  assert.equal(runCli(["journal", "write", "--message", "direct"], dir).code, 0);
  const outcome = readJournal(journalDir(dir));
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.total, 1);
    assert.equal(outcome.entries[0]?.text, "direct");
  }
});
