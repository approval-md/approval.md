/**
 * The GitHub coverage source (APRV-245).
 *
 * A pull request is an effect with a witness this project does not write:
 * GitHub recorded who opened it and when, and GitHub recorded the merge that
 * moved the trunk. `gh pr list --json` reads both back, and neither number can
 * be edited by an agent editing its own log.
 *
 * ## Absent is reported, never inferred
 *
 * `gh` is optional and unauthenticated checkouts are ordinary, so an absent or
 * refusing `gh` produces `available: false` with the reason and NO effects. That
 * distinction is the whole reliability of the report: "gh saw no pull requests"
 * and "gh could not be asked" are different facts, and collapsing them into an
 * empty list would let a broken CLI read as a clean bill of health.
 *
 * ## The class mapping
 *
 * - opening a pull request is `vcs.pr.open`, the class `core/command-class.ts`
 *   gives `gh pr create`;
 * - merging one is `vcs.push.main`, the class it gives `gh pr merge`, because
 *   what a merge does is move the trunk.
 *
 * A pull request that was opened and merged inside the window produces TWO
 * effects, because they are two decisions a policy answers separately and each
 * needs its own evidence.
 *
 * Nothing here reads the clock: the window comes from the caller and every
 * timestamp is GitHub's own.
 */

import type { ObservedEffect } from "../coverage.js";
import { gh, onPath } from "../git-run.js";
import { firstLine, type SourceObservation } from "./git.js";

/** How many pull requests one run asks for. `gh` caps at 1000; this is plenty. */
export const GH_PR_LIMIT = 100;

export interface GhSourceOptions {
  /** Inclusive lower bound of the window, RFC 3339. */
  since: string;
  /** Inclusive upper bound, RFC 3339. */
  until: string;
  /** Override {@link GH_PR_LIMIT}. */
  limit?: number;
}

/** One row of `gh pr list --json`, as much of it as this module reads. */
interface PullRequest {
  number: number;
  createdAt: string | null;
  mergedAt: string | null;
  author: string | null;
  headRefOid: string | null;
}

function rowsOf(stdout: string): PullRequest[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const rows: PullRequest[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const number = row["number"];
    if (typeof number !== "number") continue;
    const author = row["author"];
    const login =
      typeof author === "object" && author !== null && !Array.isArray(author)
        ? (author as Record<string, unknown>)["login"]
        : null;
    rows.push({
      number,
      createdAt: typeof row["createdAt"] === "string" ? row["createdAt"] : null,
      mergedAt: typeof row["mergedAt"] === "string" ? row["mergedAt"] : null,
      author: typeof login === "string" ? login : null,
      headRefOid: typeof row["headRefOid"] === "string" ? row["headRefOid"] : null,
    });
  }
  return rows;
}

/** Is `ts` inside `[since, until]`? An unparseable bound excludes, never includes. */
function within(ts: string | null, since: number, until: number): boolean {
  if (ts === null) return false;
  const at = Date.parse(ts);
  return !Number.isNaN(at) && at >= since && at <= until;
}

/**
 * What GitHub witnessed in the window.
 *
 * Never throws. `gh` that is not installed, not authenticated, or pointed at a
 * directory with no remote all come back as `available: false`.
 */
export function observeGh(root: string, options: GhSourceOptions): SourceObservation {
  const unavailable = (reason: string): SourceObservation => ({
    name: "gh",
    available: false,
    reason,
    effects: [],
  });

  if (!onPath("gh", root)) return unavailable("gh is not on PATH");

  const listed = gh(
    [
      "pr",
      "list",
      "--state",
      "all",
      "--limit",
      String(options.limit ?? GH_PR_LIMIT),
      "--json",
      "number,mergedAt,createdAt,author,headRefOid",
    ],
    root,
  );
  if (!listed.ok) return unavailable(`gh pr list failed: ${firstLine(listed.stderr)}`);

  const since = Date.parse(options.since);
  const until = Date.parse(options.until);
  if (Number.isNaN(since) || Number.isNaN(until)) {
    return unavailable(
      `the window ${options.since}..${options.until} is not two RFC 3339 instants, so no pull request could be placed in it`,
    );
  }

  const effects: ObservedEffect[] = [];
  for (const row of rowsOf(listed.stdout)) {
    const head = row.headRefOid === null ? "" : ` head ${row.headRefOid.slice(0, 12)}`;
    if (within(row.createdAt, since, until)) {
      effects.push({
        source: "gh",
        id: `pr-${String(row.number)}`,
        class: "vcs.pr.open",
        at: row.createdAt as string,
        actorHint: row.author,
        detail: `pull request #${String(row.number)} opened${head}`,
      });
    }
    if (within(row.mergedAt, since, until)) {
      effects.push({
        source: "gh",
        id: `pr-${String(row.number)}-merged`,
        class: "vcs.push.main",
        at: row.mergedAt as string,
        actorHint: row.author,
        detail: `pull request #${String(row.number)} merged${head}`,
      });
    }
  }
  // Sorted by time so two runs over the same repository print the same table.
  // `gh` orders by number, and a report whose rows move when a pull request is
  // renumbered is a report nobody can diff.
  effects.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
  return { name: "gh", available: true, effects };
}
