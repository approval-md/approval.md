/**
 * The agent-hours tracker (APRV-373).
 *
 * The number this script produces ends up on the README as a badge, so what
 * matters here is that it cannot be talked upward: the idle cap really caps,
 * a session belonging to another repository really is excluded, and the source
 * that cannot measure itself properly really is flagged as approximate. Those
 * are the cases below, plus the shape of the metrics document the badges read.
 *
 * The fixtures are synthetic harness transcripts written into a throwaway home
 * directory. They are not approval-log events and nothing here touches the log;
 * a transcript is a byproduct of a harness the repository does not control, and
 * building a small one is the only way to pin the reader against a known answer.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

// The script is plain Node ESM so it runs before a build; its exports are
// exercised here without adding a .d.ts, as `codex-hook-probe.test.ts` does.
// @ts-expect-error no declaration file for the standalone metrics script
import { aggregate, modelKey, parseCursorTimestamp, primaryCheckout, readClaude, readCodex, readCursor, toJson } from "../../scripts/agent-hours.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = join(ROOT, "scripts", "agent-hours.mjs");

/** The repository the fixtures claim to belong to. A string, never touched on disk. */
const REPO = "/Users/test/dev/approval-md";
const CLAUDE_SLUG = REPO.replaceAll("/", "-");
const CURSOR_SLUG = REPO.replace(/^\//u, "").replaceAll("/", "-");

const scratch = mkdtempSync(join(tmpdir(), "approval-agent-hours-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function writeJsonl(path: string, records: ReadonlyArray<unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

function assistant(timestamp: string, model: string, usage?: Record<string, number>) {
  return { type: "assistant", timestamp, message: { model, usage: usage ?? {} } };
}

/** A home directory holding one small transcript per source. */
function buildHome(name: string): string {
  const home = join(scratch, name);

  const project = join(home, ".claude", "projects", CLAUDE_SLUG);
  writeJsonl(join(project, "main.jsonl"), [
    { type: "user", timestamp: "2026-09-01T10:00:00.000Z" },
    assistant("2026-09-01T10:00:30.000Z", "claude-fable-5-1", {
      input_tokens: 10,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 100,
      output_tokens: 7,
    }),
    // An hour of silence: the cap turns it into five minutes.
    assistant("2026-09-01T11:00:30.000Z", "claude-fable-5-1", {
      input_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 3,
    }),
    // Synthetic turns name no real model and are not counted.
    assistant("2026-09-01T11:00:40.000Z", "<synthetic>"),
  ]);
  writeJsonl(join(project, "session-a", "subagents", "lane.jsonl"), [
    assistant("2026-09-01T12:00:00.000Z", "claude-opus-5", {
      input_tokens: 2,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 8,
      output_tokens: 4,
    }),
    assistant("2026-09-01T12:00:20.000Z", "claude-opus-5", { output_tokens: 6 }),
  ]);

  const codex = join(home, ".codex");
  writeJsonl(join(codex, "sessions", "2026", "09", "rollout-worktree.jsonl"), [
    {
      type: "session_meta",
      timestamp: "2026-09-02T10:00:00.000Z",
      payload: { cwd: `${REPO}/.claude/worktrees/x` },
    },
    { type: "turn_context", timestamp: "2026-09-02T10:00:10.000Z", payload: { model: "gpt-6-astra" } },
    {
      type: "event_msg",
      timestamp: "2026-09-02T10:00:20.000Z",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20 } },
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-09-02T10:00:30.000Z",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 500, cached_input_tokens: 300, output_tokens: 60 } },
      },
    },
  ]);
  writeJsonl(join(codex, "sessions", "2026", "09", "rollout-elsewhere.jsonl"), [
    { type: "session_meta", timestamp: "2026-09-02T11:00:00.000Z", payload: { cwd: "/Users/x/other" } },
    { type: "turn_context", timestamp: "2026-09-02T11:00:10.000Z", payload: { model: "gpt-5.6-sol" } },
  ]);
  writeJsonl(join(codex, "archived_sessions", "rollout-archived.jsonl"), [
    { type: "session_meta", timestamp: "2026-09-03T10:00:00.000Z", payload: { cwd: REPO } },
    { type: "turn_context", timestamp: "2026-09-03T10:00:10.000Z", payload: { model: "codex-auto-review" } },
    { type: "event_msg", timestamp: "2026-09-03T10:00:40.000Z", payload: { type: "agent_message" } },
  ]);

  const cursor = join(home, ".cursor", "projects", CURSOR_SLUG, "agent-transcripts", "s1");
  writeJsonl(join(cursor, "s1.jsonl"), [
    {
      role: "user",
      message: {
        content: [
          { type: "text", text: "<timestamp>Friday, Aug 21, 2026, 12:41 PM (UTC+1)</timestamp>\nfirst" },
        ],
      },
    },
    { role: "assistant", message: { content: [{ type: "tool_use", name: "Shell", input: {} }] } },
    {
      role: "user",
      message: {
        content: [
          { type: "text", text: "<timestamp>Friday, Aug 21, 2026, 12:51 PM (UTC+1)</timestamp>\nsecond" },
        ],
      },
    },
  ]);

  return home;
}

const HOME = buildHome("home");

// ---------------------------------------------------------------------------
// Model keys
// ---------------------------------------------------------------------------

test("model ids map to stable family keys", () => {
  assert.equal(modelKey("claude", "claude-fable-5-1"), "claude-fable");
  assert.equal(modelKey("claude", "claude-opus-4-8"), "claude-opus");
  assert.equal(modelKey("claude", "claude-sonnet-5"), "claude-sonnet");
  assert.equal(modelKey("claude", "claude-haiku-4-5-20251001"), "claude-haiku");
  assert.equal(modelKey("claude", "claude-mythos-1"), "claude-mythos");
  assert.equal(modelKey("claude", "some-new-thing"), "claude-other");
  assert.equal(modelKey("codex", "gpt-6-astra"), "codex-astra");
  assert.equal(modelKey("codex", "gpt-5.6-sol"), "codex-sol");
  assert.equal(modelKey("codex", "codex-auto-review"), "codex-review");
  assert.equal(modelKey("codex", "gpt-7-nova"), "codex-nova");
  assert.equal(modelKey("cursor", "whatever"), "cursor");
  assert.equal(modelKey("claude", null), null);
});

test("a worktree path measures the primary checkout", () => {
  assert.equal(primaryCheckout("/a/b/repo/.claude/worktrees/lane-1"), "/a/b/repo");
  assert.equal(primaryCheckout("/a/b/repo"), "/a/b/repo");
});

// ---------------------------------------------------------------------------
// The idle cap
// ---------------------------------------------------------------------------

test("a gap longer than the cap contributes exactly the cap", () => {
  const session = {
    source: "claude",
    id: "one",
    events: [
      { t: 1_000_000, model: "claude-opus", usage: null },
      { t: 1_003_600, model: "claude-opus", usage: null },
    ],
  };
  const result = aggregate([session], { gapSeconds: 300 });
  assert.equal(result.agents.get("claude-opus").seconds, 300);
  const wider = aggregate([session], { gapSeconds: 7200 });
  assert.equal(wider.agents.get("claude-opus").seconds, 3600);
});

test("a session naming no model is skipped rather than guessed at", () => {
  const result = aggregate([
    { source: "claude", id: "x", events: [{ t: 10, model: null, usage: null }, { t: 20, model: null, usage: null }] },
  ]);
  assert.equal(result.agents.size, 0);
});

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

test("claude reads the main transcript and each subagent as its own session", () => {
  const sessions = readClaude(HOME, REPO);
  assert.equal(sessions.length, 2);
  assert.deepEqual(
    sessions.map((session: { id: string }) => session.id).sort(),
    ["main.jsonl", join("session-a", "subagents", "lane.jsonl")].map((id) => join(CLAUDE_SLUG, id)).sort(),
  );
  const result = aggregate(sessions, { gapSeconds: 300 });
  // 30s + capped 3600s + 10s on the main transcript.
  assert.equal(result.agents.get("claude-fable").seconds, 340);
  assert.equal(result.agents.get("claude-fable").turns, 2);
  // Cache reads and cache creation count as input.
  assert.equal(result.agents.get("claude-fable").input_tokens, 116);
  assert.equal(result.agents.get("claude-opus").seconds, 20);
  assert.equal(result.agents.get("claude-opus").sessions, 1);
});

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

test("codex admits worktree cwds and archived rollouts, and rejects other repositories", () => {
  const sessions = readCodex(HOME, REPO);
  assert.equal(sessions.length, 2);
  const result = aggregate(sessions, { gapSeconds: 300 });
  assert.equal(result.agents.has("codex-astra"), true);
  assert.equal(result.agents.has("codex-review"), true);
  assert.equal(result.agents.has("codex-sol"), false, "another repository's session leaked in");
});

test("codex tokens come from the last cumulative token_count", () => {
  const result = aggregate(readCodex(HOME, REPO), { gapSeconds: 300 });
  const astra = result.agents.get("codex-astra");
  assert.equal(astra.input_tokens, 500);
  assert.equal(astra.output_tokens, 60);
});

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

test("cursor prompt clocks parse, offset included", () => {
  assert.equal(
    parseCursorTimestamp("Friday, Aug 21, 2026, 12:41 PM (UTC+1)"),
    Math.floor(Date.parse("2026-08-21T11:41:00Z") / 1000),
  );
  assert.equal(
    parseCursorTimestamp("Monday, Sep 1, 2026, 12:05 AM (UTC-7)"),
    Math.floor(Date.parse("2026-09-01T07:05:00Z") / 1000),
  );
  assert.equal(
    parseCursorTimestamp("Monday, Sep 1, 2026, 9:00 AM (UTC)"),
    Math.floor(Date.parse("2026-09-01T09:00:00Z") / 1000),
  );
  assert.equal(parseCursorTimestamp("yesterday afternoon"), null);
});

test("cursor sessions carry hours and an approx flag", () => {
  const sessions = readCursor(HOME, REPO);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].approx, true);
  const result = aggregate(sessions, { gapSeconds: 300 });
  const cursor = result.agents.get("cursor");
  assert.ok(cursor.seconds > 0, "cursor contributed no time");
  assert.equal(cursor.approx, true);
});

test("an absent cursor directory is not an error", () => {
  const empty = join(scratch, "no-cursor");
  mkdirSync(empty, { recursive: true });
  assert.deepEqual(readCursor(empty, REPO), []);
});

// ---------------------------------------------------------------------------
// The metrics document
// ---------------------------------------------------------------------------

test("the metrics document has sorted keys, a method block and the caveats", () => {
  const sessions = [
    ...readClaude(HOME, REPO),
    ...readCodex(HOME, REPO),
    ...readCursor(HOME, REPO),
  ];
  const document = toJson(aggregate(sessions, { gapSeconds: 300 }), new Date(0));

  const keys = Object.keys(document.agents);
  assert.deepEqual(keys, [...keys].sort(), "agent keys are not alphabetical");
  const weeks = Object.keys(document.weeks);
  assert.deepEqual(weeks, [...weeks].sort(), "week keys are not alphabetical");
  assert.ok(weeks.includes("2026-W36"), `expected an ISO week key, got ${weeks.join(",")}`);

  assert.equal(document.repo, "approval-md/approval.md");
  assert.equal(document.method.gap_seconds, 300);
  assert.ok(Array.isArray(document.method.caveats));
  assert.equal(document.method.caveats.length, 3);
  assert.match(document.method.caveats[0], /floor/u);
  assert.equal(typeof document.method.sources.claude, "string");
  assert.equal(document.agents["cursor"].approx, true);
  assert.equal(document.agents["claude-fable"].approx, undefined);
  assert.equal(document.agents["claude-fable"].hours, 0.1);
  assert.ok(document.total_hours > 0);
  assert.equal(document.generated_at, "1970-01-01T00:00:00.000Z");
});

test("the same input produces the same document", () => {
  const sessions = readClaude(HOME, REPO);
  const first = toJson(aggregate(sessions, { gapSeconds: 300 }), new Date(0));
  const second = toJson(aggregate(sessions, { gapSeconds: 300 }), new Date(0));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

// ---------------------------------------------------------------------------
// The CLI
// ---------------------------------------------------------------------------

test("the CLI writes a metrics file and prints the table", () => {
  const out = join(scratch, "out", "agent-hours.json");
  const result = spawnSync(
    process.execPath,
    [SCRIPT, "--home", HOME, "--repo", REPO, "--json", out],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\| agent \| hours \|/u);
  assert.match(result.stdout, /claude-fable/u);
  assert.ok(existsSync(out), "the metrics file was not written");
  const document = JSON.parse(readFileSync(out, "utf8")) as {
    total_hours: number;
    method: { caveats: string[] };
  };
  assert.ok(document.total_hours > 0);
  assert.equal(document.method.caveats.length, 3);
  assert.ok(readFileSync(out, "utf8").endsWith("\n"));
});

test("a bad flag is a usage error, not a wrong number", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "--since", "last tuesday"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /YYYY-MM-DD/u);
});
