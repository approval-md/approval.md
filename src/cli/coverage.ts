/**
 * `approval coverage` — observed side effects, joined to the verified log
 * (APRV-245, SPEC.md §10.1).
 *
 * ## What it answers
 *
 * "Here is everything the witnesses outside this runtime say happened, and here
 * is what the log says about each one." Nothing more: the join is
 * `core/coverage.ts`, the witnesses are `core/coverage-sources/`, and this file
 * is argument parsing, source selection, and the rendering of a table.
 *
 * ## Why it exits 0 with gaps
 *
 * Because it is INFORMATIONAL, on exactly SPEC.md §10.1's rule for the APRV-145
 * harness-start coverage in `approval status`: a coverage measurement is not an
 * integrity verdict, and a control an operator learns to silence is worse than
 * one that reports beside the verdict. A gap here is a question ("was this
 * effect ever declared?"), and questions with legitimate answers must not fail
 * a build. The two codes it can still emit are the filesystem's: 2 for a usage
 * error and 4 for a log this process could not read, plus 3 for a torn tail,
 * because a log it could not read is a report it did not make.
 *
 * ## Why a source that cannot be reached is not a gap
 *
 * A source reports `available: false` with a reason, and its effects are absent
 * rather than uncovered. "`gh` is not on PATH" and "`gh` saw nothing" are
 * different facts, and a report that flattened them would let a broken tool read
 * as a clean bill of health. Every unavailable source prints its reason on its
 * own line.
 *
 * ## Writes nothing, reads only verified records
 *
 * The log is read through `readVerifiedRecords` (SPEC.md §11.1 invariant 1) and
 * nothing here appends, renders, or caches. Running it changes no state any
 * later verdict depends on, which is what lets it be safe to run on a timer.
 */

import { isAbsolute, resolve as resolvePathSegments } from "node:path";

import { observeAdapter } from "../core/coverage-sources/adapter.js";
import { observeGh } from "../core/coverage-sources/gh.js";
import {
  DEFAULT_TRUNK_REF,
  defaultRange,
  observeGit,
  type SourceObservation,
} from "../core/coverage-sources/git.js";
import { coverageReport, type CoverageEntry, type ObservedEffect } from "../core/coverage.js";
import { loadPolicy, parseDuration } from "../core/policy-load.js";
import { readVerifiedRecords } from "../core/state.js";
import { passphraseEnvFor, vaultPathFor } from "../core/vault.js";
import { agentmailAdapter } from "../adapters/agentmail.js";
import { vaultCredentialProvider } from "../adapters/vault-provider.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import { EXIT_IO, EXIT_OK, EXIT_TORN_TAIL, EXIT_USAGE } from "./exit-codes.js";
import { repoRoot } from "./git-scope.js";
import { COVERAGE_HELP } from "./help.js";
import type { Streams } from "./main.js";
import { DEFAULT_LOG_PATH, preflightLog, resolvePath } from "./paths.js";
import { style, table } from "./style.js";
import { usageErrorText } from "./usage.js";

const FLAGS: Record<string, FlagKind> = {
  "--base": "string",
  "--head": "string",
  "--since": "string",
  "--until": "string",
  "--source": "string",
  "--log": "string",
  "--policy": "string",
  "--dir": "string",
  "--vault": "string",
  "--json": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

/** The sources this verb knows how to ask. */
const KNOWN_SOURCES = ["git", "gh", "agentmail"] as const;
type SourceName = (typeof KNOWN_SOURCES)[number];

/** The default set. `agentmail` is opt-in because it opens a vault. */
const DEFAULT_SOURCES: readonly SourceName[] = ["git", "gh"];

/** The adapter window when `--since` is not given. */
const DEFAULT_SINCE = "7d";

function absolute(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolvePathSegments(cwd, value);
}

/**
 * Where policy lives, from `--policy` / `--dir`, with the CLI's cwd default.
 *
 * The same four lines `cli/execute.ts` gives `status`, spelled again rather than
 * imported: that copy is module-private, and importing it would pull the whole
 * execution module (the appender, the child spawner, the token reader) into a
 * verb whose entire promise is that it writes nothing. The behaviour is pinned
 * by the CLI suites on both sides, so a drift would show up as a test failure
 * rather than as a quietly different discovery order.
 */
function policyLocation(
  flags: Record<string, string | boolean>,
  cwd: string,
): { dir?: string; file?: string } {
  const policyFlag = stringFlag(flags, "--policy");
  const dirFlag = stringFlag(flags, "--dir");
  if (policyFlag !== null) return { file: absolute(policyFlag, cwd) };
  return { dir: dirFlag === null ? cwd : absolute(dirFlag, cwd) };
}

function usageError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "usage", message } })}\n`);
  else streams.err(usageErrorText(message, COVERAGE_HELP));
  return EXIT_USAGE;
}

function ioError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "io", message } })}\n`);
  else streams.err(`approval: ${message}\n`);
  return EXIT_IO;
}

function emitJson(streams: Streams, value: unknown): void {
  streams.out(`${JSON.stringify(value)}\n`);
}

/** One source's contribution to the report, ready to print or serialize. */
interface RenderedSource {
  name: string;
  available: boolean;
  reason: string | null;
  entries: CoverageEntry[];
  observed: number;
  covered: number;
}

/**
 * The evidence column, as one short string a reader can act on.
 *
 * The qualifier says how the record was found, so that a weaker match is never
 * read as a stronger one and the strongest is not read as the ordinary one.
 * `(id)` is APRV-251's: the record names this exact effect by the provider's own
 * identifier, which is a different claim from "a record of this class sits in
 * this effect's window" and prints as one.
 */
export function evidenceText(entry: CoverageEntry): string {
  const evidence = entry.evidence;
  if (evidence === null) return "none";
  if ("verdict" in evidence) return evidence.verdict;
  const qualifier =
    entry.match === "family" ? " (family)" : entry.match === "provider-ref" ? " (id)" : "";
  return `seq ${String(evidence.seq)} ${evidence.event}${qualifier}`;
}

/** The coverage line one source prints, in the shape the help promises. */
export function coverageLine(source: RenderedSource): string {
  if (!source.available) {
    return `${source.name}: unavailable (${source.reason ?? "no reason given"})`;
  }
  const qualifier = source.reason === null ? "" : ` — ${source.reason}`;
  return `${source.name}: ${String(source.covered)} of ${String(source.observed)} effect(s) carry evidence${qualifier}`;
}

export async function commandCoverage(
  argv: string[],
  streams: Streams,
  cwd: string,
): Promise<number> {
  const json = argv.includes("--json");
  const parsed = parseFlags(argv, FLAGS);
  if (!parsed.ok) return usageError(streams, json, parsed.message);
  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${COVERAGE_HELP}\n`);
    return EXIT_OK;
  }
  const extra = parsed.positionals[0];
  if (extra !== undefined) {
    return usageError(streams, json, `unexpected argument ${JSON.stringify(extra)}`);
  }
  const flags = parsed.flags;

  // --- the sources ------------------------------------------------------
  const requested = stringFlag(flags, "--source");
  let sources: SourceName[] = [...DEFAULT_SOURCES];
  if (requested !== null) {
    const named = requested
      .split(",")
      .map((word) => word.trim())
      .filter((word) => word.length > 0);
    if (named.length === 0) {
      return usageError(streams, json, "--source was given no source names");
    }
    for (const name of named) {
      if (!(KNOWN_SOURCES as readonly string[]).includes(name)) {
        return usageError(
          streams,
          json,
          `unknown source ${JSON.stringify(name)}; the sources are ${KNOWN_SOURCES.join(", ")}`,
        );
      }
    }
    sources = [...new Set(named as SourceName[])];
  }

  // --- the adapter window ----------------------------------------------
  const sinceText = stringFlag(flags, "--since") ?? DEFAULT_SINCE;
  const sinceMs = parseDuration(sinceText);
  if (sinceMs === null) {
    return usageError(
      streams,
      json,
      `--since ${JSON.stringify(sinceText)} is not a duration (e.g. 7d, 24h, 90m)`,
    );
  }
  const untilText = stringFlag(flags, "--until");
  // The one clock read in this verb, and it reaches only the window a source is
  // ASKED about. Nothing derived from it is written anywhere.
  const untilAt = untilText === null ? Date.now() : Date.parse(untilText);
  if (Number.isNaN(untilAt)) {
    return usageError(
      streams,
      json,
      `--until ${JSON.stringify(untilText ?? "")} is not an RFC 3339 instant`,
    );
  }
  const window = {
    since: new Date(untilAt - sinceMs).toISOString(),
    until: new Date(untilAt).toISOString(),
  };

  // --- the log ----------------------------------------------------------
  const logPath = resolvePath(stringFlag(flags, "--log"), DEFAULT_LOG_PATH, cwd);
  const check = preflightLog(logPath);
  if (!check.ok) return ioError(streams, json, check.message);
  const read = readVerifiedRecords(logPath);
  if (!read.ok) {
    if (read.code === "log-unreadable") return ioError(streams, json, read.message);
    if (read.code === "log-torn-tail") {
      if (json) {
        streams.err(`${JSON.stringify({ error: { code: read.code, message: read.message } })}\n`);
      } else {
        streams.err(`approval: ${read.message}\n`);
      }
      return EXIT_TORN_TAIL;
    }
    // A corrupt chain is reported and the run stops: this verb reads only
    // VERIFIED records (SPEC.md §11.1 invariant 1), so a chain that does not
    // verify leaves it with nothing it is allowed to join against.
    if (json) {
      streams.err(`${JSON.stringify({ error: { code: read.code, message: read.message } })}\n`);
    } else {
      streams.err(`approval: ${read.message}\n`);
    }
    return EXIT_IO;
  }
  const records = read.records;

  const location = policyLocation(flags, cwd);
  const load = loadPolicy(
    location.file === undefined ? { dir: location.dir ?? cwd } : { file: location.file },
  );
  const protectedPaths = load.ok ? (load.policy.protected_paths ?? []) : [];

  // --- the commit range -------------------------------------------------
  const root = repoRoot(cwd) ?? cwd;
  const baseFlag = stringFlag(flags, "--base");
  const headFlag = stringFlag(flags, "--head");
  const fallback = baseFlag === null ? defaultRange(root, DEFAULT_TRUNK_REF) : null;
  const base = baseFlag ?? fallback?.base ?? "HEAD~20";
  const head = headFlag ?? "HEAD";

  // --- ask each source --------------------------------------------------
  const observations: SourceObservation[] = [];
  for (const name of sources) {
    if (name === "git") {
      const seen = observeGit(root, {
        base,
        head,
        policyProtectedPaths: protectedPaths,
      });
      const note = fallback?.note;
      observations.push(
        note === undefined
          ? seen
          : { ...seen, reason: seen.reason === undefined ? note : `${note}; ${seen.reason}` },
      );
      continue;
    }
    if (name === "gh") {
      observations.push(observeGh(root, window));
      continue;
    }
    observations.push(await observeAgentmailSource(flags, cwd, logPath, window));
  }

  // --- the join ---------------------------------------------------------
  const all: ObservedEffect[] = observations.flatMap((observation) => observation.effects);
  const report = coverageReport(all, records);
  const byEffect = new Map<string, CoverageEntry>();
  for (const entry of report.entries) byEffect.set(`${entry.effect.source} ${entry.effect.id}`, entry);

  const rendered: RenderedSource[] = observations.map((observation) => {
    const entries = observation.effects.flatMap((effect) => {
      const entry = byEffect.get(`${effect.source} ${effect.id}`);
      return entry === undefined ? [] : [entry];
    });
    return {
      name: observation.name,
      available: observation.available,
      reason: observation.reason ?? null,
      entries,
      observed: entries.length,
      covered: entries.filter((entry) => entry.evidence !== null).length,
    };
  });

  if (json) {
    emitJson(streams, {
      ok: true,
      window: { base, head, since: window.since, until: window.until },
      sources: rendered.map((source) => ({
        name: source.name,
        available: source.available,
        reason: source.reason,
        effects: source.entries.map((entry) => ({
          id: entry.effect.id,
          class: entry.effect.class,
          at: entry.effect.at,
          actor_hint: entry.effect.actorHint,
          detail: entry.effect.detail,
          path: entry.effect.path ?? null,
          match: entry.match,
          evidence:
            entry.evidence === null
              ? null
              : "verdict" in entry.evidence
                ? { seq: null, event: null, verdict: entry.evidence.verdict }
                : { seq: entry.evidence.seq, event: entry.evidence.event, verdict: null },
        })),
        covered: source.covered,
        observed: source.observed,
      })),
    });
    return EXIT_OK;
  }

  const st = style({ json });
  const rows = rendered.flatMap((source) =>
    source.entries.map((entry) => [
      source.name,
      entry.effect.id.length > 20 ? `${entry.effect.id.slice(0, 19)}…` : entry.effect.id,
      entry.effect.class,
      entry.evidence === null
        ? { text: "none", role: "warn" as const }
        : { text: evidenceText(entry), role: "value" as const },
    ]),
  );
  if (rows.length > 0) {
    streams.out(
      `${table(st, rows, { header: ["source", "effect", "class", "evidence"] })}\n`,
    );
  }
  streams.out(`range ${base}..${head}, adapter window ${window.since} .. ${window.until}\n`);
  for (const source of rendered) streams.out(`${coverageLine(source)}\n`);
  streams.out(
    `${st.muted("informational: exit 0 with or without gaps. A gap is a question, not a verdict — docs/cli-reference.md#coverage")}\n`,
  );
  return EXIT_OK;
}

/**
 * The AgentMail source, with the credential provider built exactly as
 * `approval setup adapter agentmail` builds its probe's.
 *
 * `passphraseEnv` comes from the policy and `envFilePath` is deliberately NOT
 * supplied. The `.approval/env` passphrase fallback is legitimate only inside a
 * consumed-token window (APRV-168): its whole argument is that a human granted
 * THIS action and the token is the authority. A reporting verb holds no token,
 * so it reads the passphrase from the shell environment or it reports that it
 * could not, which is SPEC.md §11.1 invariant 7 applied to a read.
 *
 * A vault that will not open is reported as an unavailable SOURCE with the
 * reason, never as an exit code: the other sources still have answers, and a
 * coverage report that refused to print because one provider was unreachable
 * would be a report people stop running.
 */
async function observeAgentmailSource(
  flags: Record<string, string | boolean>,
  cwd: string,
  logPath: string,
  window: { since: string; until: string },
): Promise<SourceObservation> {
  const location = policyLocation(flags, cwd);
  const load = loadPolicy(
    location.file === undefined ? { dir: location.dir ?? cwd } : { file: location.file },
  );
  const passphraseEnv = passphraseEnvFor(load);
  const vaultFlag = stringFlag(flags, "--vault");
  const vaultPath = vaultFlag === null ? vaultPathFor(logPath) : absolute(vaultFlag, cwd);
  const credentials = vaultCredentialProvider({ vaultPath }, { passphraseEnv });
  // No `secrets` list, and deliberately: this verb never reads the vault's
  // values itself, so the only party that knows what to scrub is the adapter,
  // whose own configuration reader redacts before it returns. Assembling a
  // secret corpus here would mean opening the vault a second time in the one
  // verb that has no business holding what is in it.
  return await observeAdapter(agentmailAdapter(), window, credentials);
}
