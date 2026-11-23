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
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    for (const [command] of WORKFLOW) assert.ok((await hookClasses(command, cwd)).includes("policy.core"), `${name}: ${command}`);
  }
});

test("an empty directory keeps main's class; a guarded dot-name counts, setter or not (L61492)", async () => {
  const empty = project({ dist: [] });
  assert.deepEqual(await hookClasses("rm -rf dist/*", empty), ["files.delete.out_of_scope"]);
  const dotted = project({ "dist/.approval": [] });
  // dotglob or globdots may be set in the user's profile (lead ruling, CLAIMS L61492 and L61497).
  assert.deepEqual(await hookClasses("echo x > dist/*/env", dotted), ["policy.core"]);
  const classes = await hookClasses("GLOBIGNORE=x; echo x > dist/*/env", dotted);
  assert.equal(classes[classes.length - 1], "policy.core");
  // An unguarded dot-name does not.
  const cache = project({ "dist/.cache": [] });
  assert.deepEqual(await hookClasses("echo x > dist/*/env", cache), ["files.write.workspace"]);
});

test("lead ruling L61492/L61497 through the hook: `rm -f *` and `chmod 644 *` where `.git` is take its class; elsewhere main's", async () => {
  const checkout = project({ ".git": ["config"], src: ["a.ts"] });
  writeFileSync(join(checkout, "a.js"), "made-up\n");
  for (const command of ["rm -f *", "chmod 644 *", "rm -rf ./*"]) {
    assert.ok((await hookClasses(command, checkout)).includes("vcs.history.rewrite"), command);
  }
  // `rm -f *` where `.claude` is takes what `rm -f .claude` takes: the organ
  // directory's class since lead ruling L61587.
  const claude = project({ ".claude": ["settings.json"], src: ["a.ts"] });
  const plain = project({ ".cache": ["x"], src: ["a.ts"] });
  for (const command of ["rm -f *", "chmod 644 *"]) {
    assert.ok((await hookClasses(command, claude)).includes("policy.core"), command);
    assert.ok(!(await hookClasses(command, plain)).some((cls) => ["policy.core", "log.mutate", "vcs.history.rewrite"].includes(cls)), command);
  }
  // A directory holding no guarded dot-name stays as it is today.
  const dist = project({ dist: ["a.js", "b.css"], "dist/.cache": ["x"] });
  assert.deepEqual(await hookClasses("rm -rf dist/*", dist), ["files.delete.out_of_scope"]);
  // A guarded dot-name reached by `*` in a home-organ shape, by what is there.
  const hermes = project({ ".hermes": ["auth.json"] });
  assert.deepEqual(await hookClasses("echo x > */auth.json", hermes), ["policy.core"]);
  assert.deepEqual(await hookClasses("echo x > */auth.json", plain), ["files.write.workspace"]);
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
  // A directory that is not there, or a file, is "missing".
  assert.equal(await listGlobDirectory(join(cwd, "missing")), "missing");
  assert.equal(await listGlobDirectory(join(cwd, "dist", "a")), "missing");
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
  // An opener that throws anything else.
  assert.equal(await listGlobDirectory(join(cwd, "dist"), { opendir: () => Promise.reject(new Error("EIO")) }), "unreadable");
  const denied = Object.assign(new Error("EACCES"), { code: "EACCES" });
  assert.equal(await listGlobDirectory(join(cwd, "dist"), { opendir: () => Promise.reject(denied) }), "unreadable");
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

test("the split (L61320) through the hook: a copy into a guarded directory is strict; a contents copy into an ordinary place keeps main's class", async () => {
  const organ = project({ ".claude": ["settings.json"], src: ["a.js"], "evil/.claude": ["settings.json"] });
  for (const command of ["cp -r src/ .claude/", "tar -xf a.tar -C .claude", "rsync -a src/ .cursor/"]) {
    assert.ok((await hookClasses(command, organ)).includes("policy.core"), command);
  }
  // Moved to a follow-up: these keep main's class even where .claude is.
  for (const command of ["tar -xf a.tar", "cp -r src/ .", "cp -r evil/. .", "rsync -a src/ .", "tar -xf a.tar -C build"]) {
    const classes = await hookClasses(command, organ);
    assert.ok(!classes.some((cls) => ["policy.core", "policy.edit", "log.mutate"].includes(cls)), `${command}: ${classes.join(",")}`);
  }
});

test("review of e6b7bf97 (4) through the hook: a missing directory is empty only on a one-segment line", async () => {
  const cwd = project({ src: ["a.js"] });
  const listings = await listGlobWriteDirsFor("rm -rf d/*", [cwd]);
  assert.equal(listings.get(join(cwd, "d")), "missing");
  assert.deepEqual(await hookClasses("rm -rf d/*", cwd), ["files.delete.out_of_scope"]);
  assert.ok((await hookClasses("true; rm -rf d/*", cwd)).includes("policy.core"));
});

test("lead ruling L61587 through the hook: `rm -rf *` where an organ directory is takes its class; an ordinary tree keeps main's", async () => {
  const claude = project({ ".claude": ["settings.json"], src: ["a.ts"] });
  for (const command of ["rm -rf *", "rm -rf ./*", "chmod -R 777 *", "rm -rf .claude", "mv .claude gone"]) {
    assert.ok((await hookClasses(command, claude)).includes("policy.core"), command);
  }
  const nested = project({ "sub/.claude": ["settings.json"], sub: ["a.ts"] });
  assert.ok((await hookClasses("rm -rf sub/*", nested)).includes("policy.core"));
  const plain = project({ dist: ["a.js"], node_modules: ["x.js"], build: ["o.js"], ".cache": ["x"] });
  assert.deepEqual(await hookClasses("rm -rf *", plain), ["files.delete.out_of_scope"]);
  for (const command of ["rm -rf dist", "rm -rf node_modules", "rm -rf build/"]) {
    assert.deepEqual(await hookClasses(command, plain), ["files.write.workspace"], command);
  }
});

test("lead ruling L61587, parents, through the hook: `rm -rf .` where the directory holds an organ directory takes its class; elsewhere main's", async () => {
  const organ = project({ ".claude": ["settings.json"], src: ["a.ts"], sub: ["b.ts"] });
  for (const command of ["rm -rf .", "rm -rf ./", 'rm -rf "$PWD"', "rm -rf $(pwd)", "rm -rf sub/..", "chmod -R u+w .", 'mv "$PWD" ../moved']) {
    assert.ok((await hookClasses(command, organ)).includes("policy.core"), command);
  }
  const plain = project({ src: ["a.ts"], dist: ["a.js"], ".cache": ["x"] });
  assert.deepEqual(await hookClasses("rm -rf .", plain), ["files.delete.out_of_scope"]);
  assert.deepEqual(await hookClasses("chmod -R u+w .", plain), ["files.write.workspace"]);
  assert.deepEqual(await hookClasses("rm -rf ./dist", plain), ["files.write.workspace"]);
  const checkout = project({ ".git": ["config"], src: ["a.ts"] });
  assert.ok((await hookClasses("rm -rf .", checkout)).includes("vcs.history.rewrite"));
});

test("security review of the parents rule (L61587), 6, through the hook: an absolute path that reaches the working directory through a symlink or another letter case", async (t) => {
  const savedHome = process.env["HOME"];
  const home = join(scratch, "home6");
  mkdirSync(home, { recursive: true });
  process.env["HOME"] = home;
  try {
    const parent = join(scratch, "real6");
    const proj = join(parent, "proj");
    for (const [dir, file] of [[join(proj, ".claude"), "settings.json"], [join(proj, "src"), "a.ts"]] as const) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, file), "made-up\n");
    }
    const alias = join(scratch, "alias6");
    symlinkSync(parent, alias);
    for (const command of [`rm -rf ${alias}/`, `chmod -R 000 ${alias}/proj`, `rm -rf ${alias}/proj/`]) {
      assert.ok((await hookClasses(command, proj)).includes("policy.core"), command);
    }
    // The temp root's own alias on macOS (/var is /private/var).
    if (proj.startsWith("/private/var/")) {
      assert.ok((await hookClasses(`chmod -R 000 ${proj.slice("/private".length)}`, proj)).includes("policy.core"));
    }
    // Provably elsewhere, holding no guarded name: main's class.
    const build = join(scratch, "elsewhere6", "build");
    mkdirSync(build, { recursive: true });
    writeFileSync(join(build, "a.o"), "made-up\n");
    assert.deepEqual(await hookClasses(`rm -rf ${build}`, proj), ["files.delete.out_of_scope"]);
    writeFileSync(join(scratch, "CaseProbe6"), "made-up\n");
    if (!existsSync(join(scratch, "caseprobe6"))) {
      t.diagnostic("case-sensitive volume: the letter-case half is skipped");
      return;
    }
    assert.ok((await hookClasses(`rm -rf ${join(scratch, "REAL6")}/`, proj)).includes("policy.core"));
    assert.ok((await hookClasses(`chmod -R 000 ${join(parent, "PROJ")}`, proj)).includes("policy.core"));
  } finally {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
  }
});
