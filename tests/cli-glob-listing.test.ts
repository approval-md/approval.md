/**
 * GLOB-WRITE, the disk half (lead ruling L61167): the hook lists the directory
 * a write-target pattern globs in BEFORE it classifies, and the classifier
 * decides by what is there. `rm -rf dist/*` keeps main's class in a directory
 * holding no guarded name and is `policy.core` in one holding `APPROVAL.md`.
 * Unlistable (error, entry cap, timeout) keeps the strict answer.
 *
 * Hermetic: every directory is a fresh temp directory holding made-up files.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { Dir } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { listGlobDirectory, listGlobWriteDirsFor } from "../src/cli/glob-listing.js";
import { classifyForHook } from "../src/cli/hook.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "glob-listing-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

let made = 0;
function project(files: Record<string, string[]>): string {
  made += 1;
  const dir = join(scratch, `p${String(made)}`);
  for (const [sub, names] of Object.entries(files)) {
    mkdirSync(join(dir, sub), { recursive: true });
    for (const name of names) writeFileSync(join(dir, sub, name), "made-up\n");
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function hookClasses(command: string, cwd: string): Promise<string[]> {
  const listings = await listGlobWriteDirsFor(command, [cwd]);
  const result = classifyForHook(command, [], cwd, [], false, [], false, listings).result;
  assert.ok(result.ok, `${command}: ${result.ok ? "" : result.detail}`);
  return result.segments.map((segment) => segment.class);
}

const WORKFLOW: readonly (readonly [string, string])[] = [
  ["rm -rf dist/*", "files.delete.out_of_scope"],
  ["chmod +x dist/*", "files.write.workspace"],
  ["git add dist/*", "vcs.commit.branch"],
  ["npx prettier --write dist/*", "files.write.workspace"],
  ["echo x > dist/*", "files.write.workspace"],
];

test("the four workflow lines keep main's class where the directory holds no guarded name", async () => {
  const cwd = project({ dist: ["a.js", "b.css", "README.md"] });
  for (const [command, main] of WORKFLOW) assert.deepEqual(await hookClasses(command, cwd), [main], command);
});

test("they are policy.core where the directory holds the policy file, in any letter case", async () => {
  for (const name of ["APPROVAL.md", "apprOVAL.MD", "APPROVALS.md"]) {
    const cwd = project({ dist: ["a.js", name] });
    for (const [command] of WORKFLOW) assert.deepEqual(await hookClasses(command, cwd), ["policy.core"], `${name}: ${command}`);
  }
});

test("an empty directory, and a dot-name without dot matching on the line, keep main's class", async () => {
  const empty = project({ dist: [] });
  assert.deepEqual(await hookClasses("rm -rf dist/*", empty), ["files.delete.out_of_scope"]);
  const dotted = project({ "dist/.approval": [] });
  assert.deepEqual(await hookClasses("echo x > dist/*/env", dotted), ["files.write.workspace"]);
  // With dot matching possibly on (a non-plain line), the dot-name counts.
  const classes = await hookClasses("GLOBIGNORE=x; echo x > dist/*/env", dotted);
  assert.equal(classes[classes.length - 1], "policy.core");
});

test("a guarded name under a home organ is reached by what is there", async () => {
  const cwd = project({ ".hermes": ["auth.json", "notes.txt"] });
  assert.deepEqual(await hookClasses("echo x > .hermes/a*.json", cwd), ["policy.core"]);
  assert.deepEqual(await hookClasses("echo x > .hermes/n*.txt", cwd), ["files.write.workspace"]);
});

test("without listings (every synchronous caller) the strict answer stands", () => {
  const cwd = project({ dist: ["a.js"] });
  const result = classifyForHook("rm -rf dist/*", [], cwd, []).result;
  assert.ok(result.ok);
  assert.deepEqual(result.segments.map((segment) => segment.class), ["policy.core"]);
});

test("lister: names, a missing directory, the entry cap and the timeout", async () => {
  const cwd = project({ dist: ["a", "b", "c"] });
  const names = await listGlobDirectory(join(cwd, "dist"));
  assert.ok(Array.isArray(names));
  assert.deepEqual([...(names as string[])].sort(), ["a", "b", "c"]);
  assert.equal(await listGlobDirectory(join(cwd, "missing")), "unreadable");
  assert.equal(await listGlobDirectory(join(cwd, "dist"), { entryCap: 2 }), "unreadable");
  // A directory that never answers: the deadline wins and the handle is closed.
  let closed = false;
  const slow = (): Promise<Dir> =>
    Promise.resolve({
      read: () => new Promise(() => undefined),
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    } as unknown as Dir);
  const started = Date.now();
  assert.equal(await listGlobDirectory(join(cwd, "dist"), { opendir: slow, timeoutMs: 200 }), "unreadable");
  assert.ok(Date.now() - started < 2_000);
  assert.equal(closed, true);
  // An opener that throws.
  assert.equal(await listGlobDirectory(join(cwd, "dist"), { opendir: () => Promise.reject(new Error("EIO")) }), "unreadable");
});

test("an unlistable directory keeps the strict answer through the hook", async () => {
  const cwd = project({ dist: ["a.js"] });
  const listings = await listGlobWriteDirsFor("rm -rf dist/*", [cwd], { entryCap: 0 });
  assert.equal(listings.get(join(cwd, "dist")), "unreadable");
  const result = classifyForHook("rm -rf dist/*", [], cwd, [], false, [], false, listings).result;
  assert.ok(result.ok);
  assert.deepEqual(result.segments.map((segment) => segment.class), ["policy.core"]);
});

test("the CLI route lists before it classifies (hook classify)", () => {
  for (const [files, want] of [
    [["a.js"], "files.delete.out_of_scope"],
    [["APPROVAL.md"], "policy.core"],
  ] as const) {
    const cwd = project({ dist: [...files] });
    const ran = spawnSync(process.execPath, [CLI_ENTRY, "hook", "classify", "--json", "--", "rm -rf dist/*"], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, HOME: cwd },
    });
    assert.equal(ran.status, 0, ran.stderr);
    const parsed = JSON.parse(ran.stdout) as { ok: boolean; segments: { class: string }[] };
    assert.deepEqual(parsed.segments.map((segment) => segment.class), [want], files.join(","));
  }
});

test("review of 6e3cbc9e: a relative pattern is placed only when the cwd is known to be the shell's", async () => {
  const cwd = project({ dist: ["a.js"] });
  const listings = await listGlobWriteDirsFor("rm -rf dist/*", [cwd]);
  // Another directory the command may start in (Claude Code's envelope cwd differing from the hook's).
  const unsure = classifyForHook("rm -rf dist/*", [], cwd, [], false, [join(scratch, "elsewhere")], false, listings).result;
  assert.ok(unsure.ok);
  assert.deepEqual(unsure.segments.map((segment) => segment.class), ["policy.core"]);
  const sure = classifyForHook("rm -rf dist/*", [], cwd, [], false, [], false, listings).result;
  assert.ok(sure.ok);
  assert.deepEqual(sure.segments.map((segment) => segment.class), ["files.delete.out_of_scope"]);
});
