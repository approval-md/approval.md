/**
 * Registration lookups shared by the gate, the daemon, and the doctor.
 *
 * Both exports are pure facts about the log and the Backlog.md layout that
 * more than one layer needs. They lived in `daemon/` until APRV-59's layering
 * guard (`tests/layering.test.ts`) made the rule explicit: `src/cli/` imports
 * from `core/`, never from `daemon/`, so anything the CLI needs from the
 * daemon's projection code moves here instead of widening the exception list.
 */

import type { EventRecord } from "./log.js";

/**
 * Where Backlog.md keeps task files, relative to the project directory. The
 * daemon watches it and doctor's `--tasks` defaults to it.
 */
export const DEFAULT_TASKS_DIR = "backlog/tasks";

/**
 * The latest `task.registered` record for `task`, or `null`.
 *
 * `loose` matches the task id case-insensitively, for the one caller that has
 * no frontmatter to read an id out of and must work from the Backlog.md file
 * name (`task-3 - Slug.md` for a board key written `TASK-3`). It is a matching
 * relaxation only: the record returned, and therefore the id every later step
 * uses, is the log's, never the file name's.
 */
export function latestRegistration(
  records: EventRecord[],
  task: string,
  loose = false,
): EventRecord | null {
  const wanted = loose ? task.toLowerCase() : task;
  let latest: EventRecord | null = null;
  for (const record of records) {
    if (record.event !== "task.registered") continue;
    const id = record.task;
    if (typeof id !== "string") continue;
    if ((loose ? id.toLowerCase() : id) !== wanted) continue;
    latest = record;
  }
  return latest;
}
