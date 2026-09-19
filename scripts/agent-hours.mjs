#!/usr/bin/env node
/**
 * Agent hours: an auditable count of the agent labour spent on this repo
 * (APRV-373).
 *
 * The README says agents built this. That claim is worth exactly as much as
 * the number behind it, so this script produces the number from the only
 * evidence that exists independently of anyone's summary: the session
 * transcripts the harnesses write to this machine as they run. Claude Code
 * leaves JSONL under `~/.claude/projects/<slug>/`, Codex leaves rollouts under
 * `~/.codex/sessions` and `~/.codex/archived_sessions`, and Cursor leaves
 * agent transcripts under `~/.cursor/projects/<slug>/agent-transcripts`. None
 * of the three was written for this purpose, which is the point: they are a
 * byproduct of the work rather than a record of it kept by the party being
 * measured.
 *
 * ## Active time, not wall clock
 *
 * A session that starts at 09:00 and ends at 17:00 did not run for eight
 * hours; it ran for however long the model was actually turning, with the
 * human away for the rest. So the measure is ACTIVE time: walk the events of
 * one session in timestamp order, and for each consecutive pair add the gap
 * between them, capped at `--gap` seconds (300 by default). A pause longer
 * than the cap contributes the cap and no more, which is what makes an
 * overnight gap cost five minutes rather than nine hours. Each capped gap is
 * charged to the model of the most recent event that named one, so a session
 * that switches models mid-way splits between them.
 *
 * The cap is the one tuning knob and it is visible in the output. Raising it
 * raises every figure, which is why the JSON records the value it was computed
 * with. Nothing here reads the value back from the JSON it wrote.
 *
 * ## The floor caveat
 *
 * Every number this prints is a FLOOR, and the JSON says so. Only sessions run
 * on the maintainer's machine leave a transcript here: cloud sessions, sessions
 * on another machine, and anything run before the harness kept transcripts are
 * invisible to this script and are simply not counted. A reader should take the
 * figure as "at least this much", never as a total. Two further limits are
 * recorded alongside it: Cursor transcripts carry no per-turn model and no
 * machine timestamps (only the clock the user turn printed in its prompt), so
 * Cursor hours are approximate and its model is unknown; and `codex-review` is
 * the guardian reviewer that reads other agents' work, counted here because it
 * consumed real time, kept off the README badges because it authored nothing.
 *
 * Usage:
 *   node scripts/agent-hours.mjs                      markdown table
 *   node scripts/agent-hours.mjs --json <path>        write the metrics file
 *   node scripts/agent-hours.mjs --gap <seconds>      idle cap, default 300
 *   node scripts/agent-hours.mjs --since <YYYY-MM-DD> drop events before
 *   node scripts/agent-hours.mjs --until <YYYY-MM-DD> drop events on or after
 *   node scripts/agent-hours.mjs --repo <path>        measured checkout
 *   node scripts/agent-hours.mjs --home <path>        home directory override
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The repository root, from `scripts/` at runtime, without its trailing slash. */
const SCRIPT_ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");

/** The GitHub coordinates the metrics file names. Constant: the badges read one repo. */
const REPO_NAME = "approval-md/approval.md";

/** The default idle cap, in seconds. See the header. */
export const DEFAULT_GAP_SECONDS = 300;

/**
 * The measured checkout, given the directory this script was run from.
 *
 * A worktree under `.claude/worktrees/<name>/` is the same repository wearing a
 * different path, and the transcripts of every other worktree hang off the
 * PRIMARY checkout's slug. Measuring from inside one would silently narrow the
 * count to that worktree's own sessions, so the suffix is stripped and the
 * primary path is what the readers filter on.
 */
export function primaryCheckout(root) {
  const match = /^(.*)\/\.claude\/worktrees\/[^/]+$/u.exec(root);
  return match?.[1] ?? root;
}

// ---------------------------------------------------------------------------
// Model keys
// ---------------------------------------------------------------------------

/** Claude model families, matched as substrings of the harness's model id. */
const CLAUDE_FAMILIES = Object.freeze([
  ["fable", "claude-fable"],
  ["opus", "claude-opus"],
  ["sonnet", "claude-sonnet"],
  ["haiku", "claude-haiku"],
  ["mythos", "claude-mythos"],
]);

/** Codex model ids seen in the rollouts, mapped to their stable key. */
const CODEX_MODELS = Object.freeze({
  "gpt-6-astra": "codex-astra",
  "gpt-5.6-sol": "codex-sol",
  "codex-auto-review": "codex-review",
});

/**
 * A harness model id to the stable `<vendor>-<family>` key the output uses.
 *
 * The keys have to outlive the model ids, because the ids carry dated suffixes
 * (`claude-haiku-4-5-20251001`) and a badge pointed at a dated id would go to
 * zero the day the vendor ships a point release. A family that is not
 * recognised gets a key rather than being dropped: `claude-other` for Claude,
 * and the id's last dash-separated segment for Codex, so a new model shows up
 * in the table as an unfamiliar row instead of quietly vanishing from the total.
 */
export function modelKey(source, model) {
  if (typeof model !== "string" || model === "") return null;
  if (source === "cursor") return "cursor";
  const id = model.toLowerCase();
  if (source === "codex") {
    const known = Object.hasOwn(CODEX_MODELS, id) ? CODEX_MODELS[id] : null;
    if (known !== null) return known;
    const segments = id.split("-").filter((segment) => segment !== "");
    const tail = segments.at(-1);
    return tail === undefined ? "codex-other" : `codex-${tail}`;
  }
  for (const [needle, key] of CLAUDE_FAMILIES) {
    if (id.includes(needle)) return key;
  }
  return "claude-other";
}

// ---------------------------------------------------------------------------
// Shared file helpers
// ---------------------------------------------------------------------------

/** Every `*.jsonl` under `dir`, recursively, sorted for a deterministic walk. */
function jsonlFiles(dir) {
  const found = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue; // unreadable or absent: this source simply contributes nothing
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(path);
    }
  }
  return found.sort();
}

/** The parsed JSON objects of a JSONL file; unparseable lines are skipped. */
function readJsonl(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const objects = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object") objects.push(parsed);
    } catch {
      // A transcript being appended to while this runs can end mid-line.
    }
  }
  return objects;
}

/** An ISO-8601 instant to whole epoch seconds, or `null` if it is not one. */
function epochSeconds(value) {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

/**
 * Claude Code sessions for `repo`, one session per transcript file.
 *
 * The project directory is the absolute path with every `/` turned into `-`,
 * and every worktree gets its own directory whose name extends the primary
 * slug, so a substring match on the slug picks up the primary checkout and all
 * of its worktrees and nothing else. Matching the bare repository basename
 * instead would also sweep in another repository's worktree that happens to be
 * named after a task about this one, which is why the slug is the filter.
 *
 * Subagent transcripts live under `<session>/subagents/*.jsonl` and are read as
 * sessions in their own right: a subagent is a separate model doing separate
 * work, and folding its turns into its parent would both lose the model
 * attribution and overlap two clocks that ran at the same time.
 */
export function readClaude(home, repo) {
  const root = join(home, ".claude", "projects");
  const slug = repo.replaceAll("/", "-");
  let directories;
  try {
    directories = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const sessions = [];
  for (const entry of directories.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !entry.name.includes(slug)) continue;
    for (const file of jsonlFiles(join(root, entry.name))) {
      const events = [];
      for (const record of readJsonl(file)) {
        const t = epochSeconds(record.timestamp);
        if (t === null) continue;
        let model = null;
        let usage = null;
        if (record.type === "assistant" && record.message !== null && typeof record.message === "object") {
          const raw = record.message.model;
          // `<synthetic>` marks a turn the harness produced without a model.
          if (typeof raw === "string" && !raw.startsWith("<")) {
            model = modelKey("claude", raw);
            usage = claudeUsage(record.message.usage);
          }
        }
        events.push({ t, model, usage });
      }
      if (events.length > 0) {
        sessions.push({ source: "claude", id: relative(root, file), events });
      }
    }
  }
  return sessions;
}

/** Claude's usage block flattened to the two totals the output reports. */
function claudeUsage(usage) {
  if (usage === null || typeof usage !== "object") return null;
  const number = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  return {
    input_tokens:
      number(usage.input_tokens) +
      number(usage.cache_creation_input_tokens) +
      number(usage.cache_read_input_tokens),
    output_tokens: number(usage.output_tokens),
  };
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

/**
 * Codex sessions for `repo`, from the live and the archived rollouts.
 *
 * Codex writes one rollout per session wherever it was launched, so the
 * repository filter is the session's own `cwd` rather than a path convention:
 * the first line is `session_meta`, and the session counts when its `cwd` is
 * the repository or anything beneath it, which is what admits the worktrees
 * under `.claude/worktrees/`.
 *
 * Model attribution is per turn: a `turn_context` line names the model for
 * everything that follows it, so those lines carry the model and the rest carry
 * none, and the aggregator's "most recent model" rule does the attribution.
 * Tokens cannot be split the same way. The rollout reports
 * `total_token_usage` cumulatively for the whole session, so the last
 * `token_count` is the session total and is charged to the session's dominant
 * model; a session that switched models mid-way therefore has accurate hours
 * and approximate tokens.
 */
export function readCodex(home, repo) {
  const files = [
    ...jsonlFiles(join(home, ".codex", "sessions")),
    ...jsonlFiles(join(home, ".codex", "archived_sessions")),
  ];
  const sessions = [];
  for (const file of files) {
    const records = readJsonl(file);
    const first = records[0];
    if (first === undefined || first.type !== "session_meta") continue;
    const cwd = first.payload?.cwd;
    if (typeof cwd !== "string") continue;
    if (cwd !== repo && !cwd.startsWith(`${repo}/`)) continue;

    const events = [];
    let tokens = null;
    for (const record of records) {
      const t = epochSeconds(record.timestamp);
      if (t === null) continue;
      let model = null;
      if (record.type === "turn_context") model = modelKey("codex", record.payload?.model);
      if (record.type === "event_msg" && record.payload?.type === "token_count") {
        const total = record.payload?.info?.total_token_usage;
        if (total !== null && typeof total === "object") {
          const number = (value) =>
            typeof value === "number" && Number.isFinite(value) ? value : 0;
          // `input_tokens` already includes `cached_input_tokens` here.
          tokens = {
            input_tokens: number(total.input_tokens),
            output_tokens: number(total.output_tokens),
          };
        }
      }
      events.push({ t, model, usage: null });
    }
    if (events.length > 0) {
      const session = { source: "codex", id: relative(home, file), events };
      if (tokens !== null) session.tokens = tokens;
      sessions.push(session);
    }
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

const CURSOR_MONTHS = Object.freeze({
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
});

const CURSOR_STAMP =
  /^[A-Za-z]+,\s*([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4}),\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*\(UTC([+-]\d{1,2})?(?::(\d{2}))?\)$/iu;

/**
 * A Cursor prompt clock to epoch seconds, or `null`.
 *
 * Cursor stamps its user turns with the human-readable local time it printed
 * into the prompt, `Friday, Aug 21, 2026, 12:41 PM (UTC+1)`, and nothing else
 * in the transcript carries a machine timestamp. The offset is part of the
 * string and is honoured, so a session run in one timezone and a session run in
 * another land on the same absolute axis.
 */
export function parseCursorTimestamp(text) {
  const match = CURSOR_STAMP.exec(String(text ?? "").trim());
  if (match === null) return null;
  const [, monthName, day, year, hour12, minute, meridiem, offsetHour, offsetMinute] = match;
  const month = CURSOR_MONTHS[monthName.slice(0, 3).toLowerCase()];
  if (month === undefined) return null;
  let hour = Number(hour12) % 12;
  if (meridiem.toUpperCase() === "PM") hour += 12;
  const offset = offsetHour === undefined ? 0 : Number(offsetHour);
  const offsetSign = offset < 0 ? -1 : 1;
  const offsetMinutes = offset * 60 + offsetSign * Number(offsetMinute ?? 0);
  const ms = Date.UTC(Number(year), month, Number(day), hour, Number(minute));
  return Math.floor(ms / 1000) - offsetMinutes * 60;
}

/** Every `<timestamp>...</timestamp>` payload inside one transcript line. */
function cursorStamps(record) {
  const content = record.message?.content;
  if (!Array.isArray(content)) return [];
  const stamps = [];
  for (const block of content) {
    const text = block?.text;
    if (typeof text !== "string") continue;
    for (const match of text.matchAll(/<timestamp>([^<]*)<\/timestamp>/gu)) {
      const t = parseCursorTimestamp(match[1]);
      if (t !== null) stamps.push(t);
    }
  }
  return stamps;
}

/**
 * Cursor sessions for `repo`, one session per transcript file, all approximate.
 *
 * Two things are missing from these transcripts and both are recorded rather
 * than guessed at. There is no per-turn model, so every Cursor turn buckets as
 * `cursor` and the model is reported as unknown. And there are no machine
 * timestamps: the only clock is the one each USER turn printed, so assistant
 * turns inherit the timestamp of the user turn they follow and the file's mtime
 * closes the session. Active time is therefore bounded by the cadence of the
 * human's own turns, which reads low rather than high; the session is flagged
 * `approx` so no reader takes it for the same measurement as the other two.
 *
 * The directory is frequently absent (Cursor was used on this repository for a
 * few days) and its absence is not an error.
 */
export function readCursor(home, repo) {
  const slug = repo.replace(/^\//u, "").replaceAll("/", "-");
  const root = join(home, ".cursor", "projects", slug, "agent-transcripts");
  const sessions = [];
  for (const file of jsonlFiles(root)) {
    const records = readJsonl(file);
    const events = [];
    let current = null;
    for (const record of records) {
      if (record.role === "user") {
        const stamps = cursorStamps(record);
        for (const t of stamps) {
          current = t;
          events.push({ t, model: "cursor", usage: null });
        }
        continue;
      }
      if (record.role === "assistant" && current !== null) {
        events.push({ t: current, model: "cursor", usage: null });
      }
    }
    if (events.length === 0) continue;
    // The last user turn tells us nothing about when the agent stopped; the
    // file's mtime does, so it closes the session as a modelless boundary.
    let mtime = null;
    try {
      mtime = Math.floor(statSync(file).mtimeMs / 1000);
    } catch {
      mtime = null;
    }
    if (mtime !== null && mtime > current) events.push({ t: mtime, model: null, usage: null });
    sessions.push({ source: "cursor", id: relative(root, file), events, approx: true });
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** The UTC ISO-8601 week an instant falls in, as `YYYY-Www`. */
export function isoWeek(t) {
  const date = new Date(t * 1000);
  const thursday = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  thursday.setUTCDate(thursday.getUTCDate() - ((thursday.getUTCDay() + 6) % 7) + 3);
  const year = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / 604800000);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

function emptyBucket() {
  return { seconds: 0, sessions: 0, turns: 0, output_tokens: 0, input_tokens: 0, approx: false };
}

/**
 * Roll a list of sessions up into per-model totals and a per-week series.
 *
 * The one judgement call is the session's DOMINANT model: the model that named
 * the most events in it. It starts the attribution (the gap before the first
 * model-bearing event belongs to whoever ran the session, and on a single-model
 * session that is the same model), it owns the session in the session count,
 * and it takes any session-level token total the source could not split. A
 * session in which no event named a model is skipped entirely rather than
 * charged to a guess.
 */
export function aggregate(sessions, options = {}) {
  const gapSeconds = options.gapSeconds ?? DEFAULT_GAP_SECONDS;
  const since = options.since ?? null;
  const until = options.until ?? null;
  const agents = new Map();
  const weeks = new Map();

  const bucket = (key) => {
    let entry = agents.get(key);
    if (entry === undefined) {
      entry = emptyBucket();
      agents.set(key, entry);
    }
    return entry;
  };

  for (const session of sessions) {
    const events = session.events
      .filter((event) => (since === null || event.t >= since) && (until === null || event.t < until))
      .sort((a, b) => a.t - b.t);
    if (events.length === 0) continue;

    const counts = new Map();
    for (const event of events) {
      if (event.model !== null) counts.set(event.model, (counts.get(event.model) ?? 0) + 1);
    }
    if (counts.size === 0) continue;
    let dominant = null;
    for (const [key, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (dominant === null || count > counts.get(dominant)) dominant = key;
    }

    const approx = session.approx === true;
    bucket(dominant).sessions += 1;
    if (approx) bucket(dominant).approx = true;

    let current = dominant;
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      if (event.model !== null) {
        current = event.model;
        const entry = bucket(current);
        entry.turns += 1;
        if (approx) entry.approx = true;
        if (event.usage !== null) {
          entry.input_tokens += event.usage.input_tokens;
          entry.output_tokens += event.usage.output_tokens;
        }
      }
      const next = events[i + 1];
      if (next === undefined) continue;
      const seconds = Math.min(Math.max(next.t - event.t, 0), gapSeconds);
      if (seconds === 0) continue;
      const entry = bucket(current);
      entry.seconds += seconds;
      if (approx) entry.approx = true;
      const week = isoWeek(event.t);
      let series = weeks.get(week);
      if (series === undefined) {
        series = new Map();
        weeks.set(week, series);
      }
      series.set(current, (series.get(current) ?? 0) + seconds);
    }

    if (session.tokens !== undefined && session.tokens !== null) {
      const entry = bucket(dominant);
      entry.input_tokens += session.tokens.input_tokens;
      entry.output_tokens += session.tokens.output_tokens;
    }
  }

  return { agents, weeks, gapSeconds };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Seconds to hours, one decimal. The output's only rounding. */
function hours(seconds) {
  return Math.round((seconds / 3600) * 10) / 10;
}

function sortedKeys(map) {
  return [...map.keys()].sort((a, b) => a.localeCompare(b));
}

const CAVEATS = Object.freeze([
  "Only sessions run on the maintainer's machine are counted; cloud-only sessions never land locally, so every figure is a floor.",
  "cursor has no per-turn model or timestamps; its hours are approximate and its model is not known.",
  "codex-review is the codex-auto-review guardian model, counted but not an authoring agent.",
]);

const SOURCES = Object.freeze({
  claude: "~/.claude/projects/<repo>*/**/*.jsonl",
  codex: "~/.codex/sessions + archived_sessions, filtered by session cwd",
  cursor: "~/.cursor/projects/<repo>/agent-transcripts (user-turn timestamps only)",
});

const ACTIVE_TIME =
  "sum of gaps between consecutive transcript events, each capped at gap_seconds, attributed to the most recent assistant model";

/** The metrics document. Deterministic for a fixed input apart from `generated_at`. */
export function toJson(result, now = new Date()) {
  const agents = {};
  let totalSeconds = 0;
  for (const key of sortedKeys(result.agents)) {
    const entry = result.agents.get(key);
    totalSeconds += entry.seconds;
    agents[key] = {
      hours: hours(entry.seconds),
      sessions: entry.sessions,
      turns: entry.turns,
      output_tokens: entry.output_tokens,
      input_tokens: entry.input_tokens,
      ...(entry.approx ? { approx: true } : {}),
    };
  }
  const weeks = {};
  for (const week of sortedKeys(result.weeks)) {
    const series = result.weeks.get(week);
    const row = {};
    for (const key of sortedKeys(series)) row[key] = hours(series.get(key));
    weeks[week] = row;
  }
  return {
    generated_at: now.toISOString(),
    repo: REPO_NAME,
    method: {
      active_time: ACTIVE_TIME,
      gap_seconds: result.gapSeconds,
      sources: { ...SOURCES },
      caveats: [...CAVEATS],
    },
    agents,
    total_hours: hours(totalSeconds),
    weeks,
  };
}

/** Thousands separators without a locale, so the table is the same everywhere. */
function group(value) {
  const digits = String(value);
  let out = "";
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return out;
}

/** The default output: one markdown table, heaviest agent first. */
export function toTable(result) {
  const rows = sortedKeys(result.agents)
    .map((key) => ({ key, ...result.agents.get(key) }))
    .sort((a, b) => b.seconds - a.seconds || a.key.localeCompare(b.key));
  const lines = [
    "| agent | hours | sessions | turns | output tokens | input tokens |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
  ];
  let totalSeconds = 0;
  let totalSessions = 0;
  let totalTurns = 0;
  let totalOut = 0;
  let totalIn = 0;
  for (const row of rows) {
    totalSeconds += row.seconds;
    totalSessions += row.sessions;
    totalTurns += row.turns;
    totalOut += row.output_tokens;
    totalIn += row.input_tokens;
    const name = row.approx ? `${row.key} (approx)` : row.key;
    lines.push(
      `| ${name} | ${hours(row.seconds).toFixed(1)} | ${group(row.sessions)} | ${group(row.turns)} | ${group(row.output_tokens)} | ${group(row.input_tokens)} |`,
    );
  }
  lines.push(
    `| **total** | ${hours(totalSeconds).toFixed(1)} | ${group(totalSessions)} | ${group(totalTurns)} | ${group(totalOut)} | ${group(totalIn)} |`,
  );
  lines.push("");
  lines.push(
    `Active time: consecutive transcript events, each gap capped at ${result.gapSeconds}s, charged to the most recent model. Local transcripts only, so every figure is a floor.`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** A `YYYY-MM-DD` day boundary, UTC, in epoch seconds. `null` if unparseable. */
function parseDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(value))) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

export function parseArgs(argv) {
  const options = {
    json: null,
    gapSeconds: DEFAULT_GAP_SECONDS,
    since: null,
    until: null,
    repo: null,
    home: null,
    error: null,
  };
  const value = (i) => {
    const next = argv[i];
    if (next === undefined || next.startsWith("--")) return null;
    return next;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json" || arg === "--repo" || arg === "--home") {
      const next = value(i + 1);
      if (next === null) options.error = `${arg} requires a path`;
      else {
        options[arg === "--json" ? "json" : arg.slice(2)] = next;
        i += 1;
      }
    } else if (arg === "--gap") {
      const next = value(i + 1);
      const seconds = Number(next);
      if (next === null || !Number.isFinite(seconds) || seconds <= 0) {
        options.error = "--gap requires a positive number of seconds";
      } else {
        options.gapSeconds = seconds;
        i += 1;
      }
    } else if (arg === "--since" || arg === "--until") {
      const next = value(i + 1);
      const day = next === null ? null : parseDay(next);
      if (day === null) options.error = `${arg} requires a YYYY-MM-DD date`;
      else {
        options[arg.slice(2)] = day;
        i += 1;
      }
    } else {
      options.error = `unknown option ${arg}`;
    }
    // Stop at the first complaint: continuing would let a later argument
    // overwrite the message that actually explains what is wrong.
    if (options.error !== null) break;
  }
  return options;
}

export function main(argv) {
  const options = parseArgs(argv);
  if (options.error !== null) {
    process.stderr.write(`agent-hours: ${options.error}\n`);
    return 2;
  }
  const home = options.home ?? homedir();
  const repo = (options.repo ?? primaryCheckout(SCRIPT_ROOT)).replace(/\/$/u, "");

  const sessions = [
    ...readClaude(home, repo),
    ...readCodex(home, repo),
    ...readCursor(home, repo),
  ];
  const result = aggregate(sessions, {
    gapSeconds: options.gapSeconds,
    ...(options.since === null ? {} : { since: options.since }),
    ...(options.until === null ? {} : { until: options.until }),
  });

  if (options.json !== null) {
    const document = toJson(result);
    const directory = dirname(options.json);
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
    writeFileSync(options.json, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    process.stderr.write(`agent-hours: wrote ${options.json}\n`);
  }
  process.stdout.write(`${toTable(result)}\n`);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
