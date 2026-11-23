/**
 * GLOB-WRITE (#686) cost, three lines with a bound each (lead ruling L62051,
 * review-b A686-FOLD6 S1 and S2). The lead accepted these lines at 2.2 to 4.3
 * times main at 320 KB, under the hook's 60 s, and asked that each be pinned
 * with its own bound: 1.5 times its CPU seconds on CI's runner (the L61975
 * form: a bound set from a measurement, not raised to pass a head).
 *
 * Review-b's shapes, at a size that keeps each run a few CPU seconds:
 * - distinct glob sources: `cp .c0*\/x.json .c1*\/x.json …`;
 * - rsync -aR with many distinct sources: `rsync -aR s0/*\/./a* s1/*\/./a* …`;
 * - rm of dot-names: `rm -rf ./*; ` repeated.
 * Each runs the hook's path: the listing of the directories its patterns glob
 * in, then classifyForHook, in a made-up project. Each prints one line,
 * `COST686 <name> cpu_s=<n.nn> bound_s=<n.nn>`, for CI's figure to be read.
 *
 * CPU time, not wall-clock time: the machine is shared. Hermetic: HOME and
 * the project are fixture directories holding made-up files; no line is run.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { listGlobWriteDirsFor } from "../src/cli/glob-listing.js";
import { classifyForHook } from "../src/cli/hook.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-glob-write-cost-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

const HOME = join(scratch, "home");
mkdirSync(HOME);
process.env["HOME"] = HOME;
delete process.env["CDPATH"];

const PROJECT = join(scratch, "proj");
for (const [dir, file] of [[".claude", "settings.json"], [".github/workflows", "ci.yml"], ["src", "a.ts"], ["dist", "a.o"]] as const) {
  mkdirSync(join(PROJECT, dir), { recursive: true });
  writeFileSync(join(PROJECT, dir, file), "made-up\n");
}

// Each bound: 1.5 x CI's figure for this line on the runner; measured in run
// <id> at <sha8>: <n.nn> s. One line each, to be replaced with CI's figure.
// PROVISIONAL (local figure, replace with CI's): 1.5 x 1.28 s, the slowest of three local runs at ef8b0884.
const BOUND_GLOB_SOURCES_S = 1.92;
// PROVISIONAL (local figure, replace with CI's): 1.5 x 4.62 s, the slowest of three local runs at ef8b0884.
const BOUND_RSYNC_RELATIVE_S = 6.93;
// PROVISIONAL (local figure, replace with CI's): 1.5 x 1.81 s, the slowest of three local runs at ef8b0884.
const BOUND_RM_DOT_NAMES_S = 2.72;

/** `head`, then `format(i)` for i = 0, 1, ... while the line stays within `bytes`. */
function distinct(head: string, format: (index: string) => string, bytes: number): string {
  let line = head;
  for (let index = 0; ; index += 1) {
    const word = format(index.toString(16));
    if (Buffer.byteLength(line + word) > bytes) return line;
    line += word;
  }
}

/** The hook's CPU seconds for `command` in the project: its listings, then its classification. */
async function hookSeconds(command: string): Promise<{ seconds: number; classes: string[] }> {
  const start = process.cpuUsage();
  const listings = await listGlobWriteDirsFor(command, [PROJECT]);
  const result = classifyForHook(command, [], PROJECT, [], false, [], false, listings).result;
  const used = process.cpuUsage(start);
  return { seconds: (used.user + used.system) / 1e6, classes: result.ok ? result.classes : [`refused ${result.code}`] };
}

async function pinned(
  t: { diagnostic: (message: string) => void },
  name: string,
  command: string,
  bound: number,
): Promise<string[]> {
  const { seconds, classes } = await hookSeconds(command);
  t.diagnostic(`COST686 ${name} cpu_s=${seconds.toFixed(2)} bound_s=${bound.toFixed(2)}`);
  assert.ok(seconds < bound, `${name}: ${seconds.toFixed(2)} CPU s, bound ${bound.toFixed(2)}`);
  return classes;
}

test("cost (L62051): distinct glob sources, `cp .c0*/x.json .c1*/x.json …` at 10 KB", async (t) => {
  const command = distinct("cp", (index) => ` .c${index}*/x.json`, 10_000);
  const classes = await pinned(t, "glob_sources", command, BOUND_GLOB_SOURCES_S);
  assert.ok(classes.length > 0);
});

test("cost (L62051): rsync -aR with many distinct sources, `rsync -aR s0/*/./a* …` at 500 bytes", async (t) => {
  // 46 sources. This line's cost is not monotonic in its length: below the
  // matcher's budget every source's preserved landing is walked against the
  // guarded paths; above it the strict answer comes early.
  const command = distinct("rsync -aR", (index) => ` s${index}/*/./a*`, 500);
  const classes = await pinned(t, "rsync_relative", command, BOUND_RSYNC_RELATIVE_S);
  assert.ok(classes.includes("network.call"), classes.join(","));
});

test("cost (L62051): rm of dot-names, `rm -rf ./*; ` repeated to 10 KB", async (t) => {
  const command = "rm -rf ./*; ".repeat(Math.floor(10_000 / "rm -rf ./*; ".length));
  const classes = await pinned(t, "rm_dot_names", command, BOUND_RM_DOT_NAMES_S);
  // The listing shows `.claude`: the organ directory's class, main's beside it.
  assert.ok(classes.includes("policy.core") && classes.includes("files.delete.out_of_scope"), classes.join(","));
});
