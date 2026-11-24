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
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { Dir } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { GlobListingDeadline, listGlobDirectory, listGlobWriteDirsFor } from "../src/cli/glob-listing.js";
import { classifyForHook, DESCRIBE_DEADLINE_ENV } from "../src/cli/hook.js";
import { CANONICAL_POLICY } from "../src/cli/scaffold.js";

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
  // Main's class rides beside every raise (lead ruling L61926).
  assert.deepEqual(await hookClasses("echo x > dist/*/env", dotted), ["policy.core", "files.write.workspace"]);
  const classes = await hookClasses("GLOBIGNORE=x; echo x > dist/*/env", dotted);
  assert.ok(classes.includes("policy.core"), classes.join(","));
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
  // `rm -f *` and `chmod 644 *` where `.claude` is take what `rm -f .claude`
  // takes: the organ directory's class since lead ruling L61587 (`.claude`
  // may be a symlink, which a plain rm removes: lead ruling L62013, fail closed).
  const claude = project({ ".claude": ["settings.json"], src: ["a.ts"] });
  const plain = project({ ".cache": ["x"], src: ["a.ts"] });
  for (const command of ["rm -f *", "rm -rf *", "chmod 644 *"]) {
    assert.ok((await hookClasses(command, claude)).includes("policy.core"), command);
    assert.ok(!(await hookClasses(command, plain)).some((cls) => ["policy.core", "log.mutate", "vcs.history.rewrite"].includes(cls)), command);
  }
  // A directory holding no guarded dot-name stays as it is today.
  const dist = project({ dist: ["a.js", "b.css"], "dist/.cache": ["x"] });
  assert.deepEqual(await hookClasses("rm -rf dist/*", dist), ["files.delete.out_of_scope"]);
  // A guarded dot-name reached by `*` in a home-organ shape, by what is there.
  const hermes = project({ ".hermes": ["auth.json"] });
  assert.deepEqual(await hookClasses("echo x > */auth.json", hermes), ["policy.core", "files.write.workspace"]);
  assert.deepEqual(await hookClasses("echo x > */auth.json", plain), ["files.write.workspace"]);
});

test("a guarded name under a home organ is reached by what is there", async () => {
  const cwd = project({ ".hermes": ["auth.json", "notes.txt"] });
  assert.deepEqual(await hookClasses("echo x > .hermes/a*.json", cwd), ["policy.core", "files.write.workspace"]);
  assert.deepEqual(await hookClasses("echo x > .hermes/n*.txt", cwd), ["files.write.workspace"]);
});

// Unlisted, `dist/*` may be `dist/.approval` itself, and a recursive delete of
// it takes its log's class too (lead ruling L62013, S1).
test("without listings (every synchronous caller) the strict answer stands", () => {
  const cwd = project({ dist: ["a.js"] });
  const result = classifyForHook("rm -rf dist/*", [], cwd, []).result;
  assert.ok(result.ok);
  // Main's class rides beside (lead ruling L61926).
  assert.deepEqual(result.segments.map((segment) => segment.class), ["policy.core", "files.delete.out_of_scope", "log.mutate"]);
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
  assert.deepEqual(result.segments.map((segment) => segment.class), ["policy.core", "files.delete.out_of_scope", "log.mutate"]);
});

test("the CLI route lists before it classifies (hook classify)", () => {
  for (const [files, want] of [
    [["a.js"], "files.delete.out_of_scope"],
    [["APPROVAL.md"], "policy.core"],
  ] as const) {
    // A raise carries main's class beside it (lead ruling L61926).
    const expected = want === "policy.core" ? [want, "files.delete.out_of_scope"] : [want];
    const cwd = project({ dist: [...files] });
    const ran = spawnSync(process.execPath, [CLI_ENTRY, "hook", "classify", "--json", "--", "rm -rf dist/*"], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, HOME: cwd },
    });
    assert.equal(ran.status, 0, ran.stderr);
    const parsed = JSON.parse(ran.stdout) as { ok: boolean; segments: { class: string }[] };
    assert.deepEqual(parsed.segments.map((segment) => segment.class), expected, files.join(","));
  }
});

test("review of 6e3cbc9e: a relative pattern is placed only when the cwd is known to be the shell's", async () => {
  const cwd = project({ dist: ["a.js"] });
  const listings = await listGlobWriteDirsFor("rm -rf dist/*", [cwd]);
  // Another directory the command may start in (Claude Code's envelope cwd differing from the hook's).
  const unsure = classifyForHook("rm -rf dist/*", [], cwd, [], false, [join(scratch, "elsewhere")], false, listings).result;
  assert.ok(unsure.ok);
  assert.deepEqual(unsure.segments.map((segment) => segment.class), ["policy.core", "files.delete.out_of_scope", "log.mutate"]);
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

test("security review of the parents rule (L61587), 7, through the hook: `link/..` is the directory above the symlink's target", async () => {
  const savedHome = process.env["HOME"];
  const home = join(scratch, "home7");
  mkdirSync(home, { recursive: true });
  process.env["HOME"] = home;
  try {
    const root = join(scratch, "f7");
    for (const [dir, file] of [
      [join(root, "proj", "src"), "a.ts"],
      [join(root, "other", ".claude"), "settings.json"],
      [join(root, "other", "deep"), "x.txt"],
      [join(root, "plain", "deep"), "x.txt"],
    ] as const) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, file), "made-up\n");
    }
    const proj = join(root, "proj");
    symlinkSync(join(root, "other", "deep"), join(proj, "link"));
    symlinkSync(join(root, "plain", "deep"), join(proj, "link2"));
    // The kernel's reading: link/.. is f7/other, which holds .claude.
    assert.equal(realpathSync.native(join(proj, "link") + "/.."), realpathSync.native(join(root, "other")));
    assert.ok((await hookClasses("chmod -R 000 link/..", proj)).includes("policy.core"));
    assert.ok((await hookClasses("rm -rf link/../.claude", proj)).includes("policy.core"));
    // link2/.. is f7/plain, which holds no guarded name: main's class.
    assert.deepEqual(await hookClasses("chmod -R 000 link2/..", proj), ["files.write.workspace"]);
  } finally {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
  }
});

// ---------------------------------------------------------------------------
// Review-b A686-FOLD5 M1: #688's as-spelled reading compares EXACTLY, so a
// case variant keeps main's ordinary class beside the folded protected one,
// and the strictest decision answers. Through the REAL hook with policy W:
// files.write.workspace human-only, policy.edit autonomous, network.call
// human-only (codex's L61672 shape). Main 324d87dc denies every line below.
// ---------------------------------------------------------------------------

function runCliIn(args: readonly string[], cwd: string, input = ""): { code: number; stdout: string; stderr: string } {
  const env = { ...process.env };
  delete env["APPROVAL_HUMAN"];
  const ran = spawnSync(process.execPath, [CLI_ENTRY, ...args], { cwd, encoding: "utf8", env, input });
  assert.equal(ran.error, undefined, String(ran.error));
  return { code: ran.status ?? -1, stdout: ran.stdout, stderr: ran.stderr };
}

const POLICY_W = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "1h"',
  "  on_expiry: reject",
  "classes:",
  "  read.*:",
  "    autonomy: autonomous",
  "  files.write.workspace:",
  "    autonomy: human-only",
  "  policy.edit:",
  "    autonomy: autonomous",
  "  network.call:",
  "    autonomy: human-only",
  "```",
  "",
].join("\n");

let decided = 0;
function decideW(dir: string, command: string): { permission: string; reason: string } {
  decided += 1;
  const ran = runCliIn(
    ["hook", "claude-code", "--as", "agent:cc", "--timeout", "1s", "--interval", "100ms"],
    dir,
    JSON.stringify({ hook_event_name: "PreToolUse", session_id: "m1", tool_use_id: `m1-${decided}`, cwd: dir, transcript_path: "/dev/null", tool_name: "Bash", tool_input: { command } }),
  );
  assert.equal(ran.code, 0, ran.stderr);
  const output = (JSON.parse(ran.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput;
  return { permission: output.permissionDecision, reason: output.permissionDecisionReason };
}

test("review-b A686-FOLD5 M1, through the real hook with policy W: a case variant keeps main's class beside the protected one, so main's deny stands", () => {
  const dir = join(scratch, "m1-lab");
  for (const [sub, file] of [["src", "a.ts"], [".github/workflows", "ci.yml"], [".claude", "settings.json"], [".git", "config"], ["x", "y"]] as const) {
    mkdirSync(join(dir, sub), { recursive: true });
    writeFileSync(join(dir, sub, file), "made-up\n");
  }
  writeFileSync(join(dir, "a.js"), "made-up\n");
  writeFileSync(join(dir, "README.md"), "made-up\n");
  writeFileSync(join(dir, "APPROVAL.md"), POLICY_W);
  const attested = runCliIn(["policy", "attest", "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);
  // Main 324d87dc refuses these as human-only (files.write.workspace, or
  // network.call for rsync); a manual wait would be lighter.
  for (const command of [
    "cp a.js .gItHuB/WoRkFlOwS/Ci.yMl",
    "mv README.md .GitHub/",
    "mv .gItHuB gone",
    "echo x > .gItHuB/WoRkFlOwS/Ci.yMl",
    "rm -rf .Claude",
    "mv x .CLAUDE",
    "rsync -a x/ .Claude/",
  ]) {
    const decision = decideW(dir, command);
    assert.equal(decision.permission, "deny", `${command}: ${decision.reason}`);
    assert.match(decision.reason, /^hook-class-human-only: /u, command);
  }
  // Main waits on vcs.history.rewrite (manual, timed out): not allowed here either.
  for (const command of ["rm -rf .GIT", "cp a.js .gIt*/x"]) {
    assert.notEqual(decideW(dir, command).permission, "allow", command);
  }
  // `.github` spelled exactly: #686's organ-directory destination raises to
  // policy.edit, and main's class rides beside it (lead ruling L61926, which
  // settled review-b A686-FOLD5 M1's last line), so main's deny stands.
  for (const command of ["cp a.js .github/workflowſ/ci.yml", "mv a.js .github/WORKFLOWS/ci.yml", "cp a.js .github/README"]) {
    const decision = decideW(dir, command);
    assert.equal(decision.permission, "deny", `${command}: ${decision.reason}`);
    assert.match(decision.reason, /^hook-class-human-only: class files\.write\.workspace /u, command);
  }
  // Controls: the canonical spelling keeps the policy's answer for policy.edit.
  assert.equal(decideW(dir, "cp a.js .github/workflows/ci.yml").permission, "allow");
});

test("review-b A686-FOLD5 M1 for the parents rule, through the hook's listing: a listed organ directory in another case keeps the segment's own class", async () => {
  // In process: through the real hook a decision cannot isolate this, since
  // the hook's own directory holds APPROVAL.md (guarded as spelled), and a
  // shell elsewhere fails closed. With the class set, both readings show:
  // folded `.Claude` is `.claude` (policy.core); as spelled it is another
  // name, so main's class rides beside, and a policy that holds
  // files.write.workspace stricter still sees it.
  const savedHome = process.env["HOME"];
  const home = join(scratch, "home-m1p");
  mkdirSync(home, { recursive: true });
  process.env["HOME"] = home;
  try {
    const sub = project({ ".Claude": ["settings.json"], src: ["a.ts"] });
    for (const command of ["chmod -R 000 .", "chmod 000 .", "chmod -R -w ."]) {
      const classes = await hookClasses(command, sub);
      assert.ok(classes.includes("policy.core") && classes.includes("files.write.workspace"), `${command} -> ${classes.join(",")}`);
    }
    const deleted = await hookClasses('rm -rf "$PWD"', sub);
    assert.ok(deleted.includes("policy.core") && deleted.includes("files.delete.out_of_scope"), deleted.join(","));
  } finally {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
  }
});

test("lead ruling L61587, parents, through the real hook with policy W: the rule adds its class and never takes the segment's own away", () => {
  // The lab holds `.github` (policy.edit, autonomous under W) and the policy
  // file. Main 324d87dc answers files.write.workspace, human-only under W;
  // the parents rule's class rides beside it, so main's refusal stands.
  const dir = join(scratch, "parents-w-lab");
  for (const [sub, file] of [["src", "a.ts"], [".github/workflows", "ci.yml"]] as const) {
    mkdirSync(join(dir, sub), { recursive: true });
    writeFileSync(join(dir, sub, file), "made-up\n");
  }
  writeFileSync(join(dir, "APPROVAL.md"), POLICY_W);
  const attested = runCliIn(["policy", "attest", "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);
  for (const command of ["chmod -R 000 .", "chmod 000 .", "chmod -R -w ."]) {
    const decision = decideW(dir, command);
    assert.equal(decision.permission, "deny", `${command}: ${decision.reason}`);
    assert.match(decision.reason, /^hook-class-human-only: /u, `${command}: ${decision.reason}`);
  }
});

/**
 * The hook's decision for `command` in `dir`, with HOME a made-up directory.
 * `--timeout 1s`: a class that waits for a human (manual) denies on timeout.
 */
let decidedIn = 0;
function decideIn(dir: string, home: string, command: string): { permission: string; reason: string } {
  decidedIn += 1;
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env["APPROVAL_HUMAN"];
  const input = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "l61926", tool_use_id: `l61926-${decidedIn}`, cwd: dir, transcript_path: "/dev/null", tool_name: "Bash", tool_input: { command } });
  const ran = spawnSync(process.execPath, [CLI_ENTRY, "hook", "claude-code", "--as", "agent:cc", "--timeout", "1s", "--interval", "100ms"], { cwd: dir, encoding: "utf8", env, input });
  assert.equal(ran.status, 0, ran.stderr);
  const output = (JSON.parse(ran.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput;
  return { permission: output.permissionDecision, reason: output.permissionDecisionReason };
}

test("lead ruling L61926, through the real hook under the default policy and W: one line from each of the five items keeps main's decision or a stricter one", () => {
  // Main 324d87dc's decisions, read on its build in the same lab shape:
  //   item                          | default                 | W
  //   1 cp a.js .github/README      | allow (workspace)       | deny human-only (workspace)
  //   2 echo x >>| ~/.hermes/auth.json | deny unparseable     | deny unparseable
  //   3 echo x >>| ~/.hermes/.?nv.local | deny unparseable    | deny unparseable
  //   4 mv a .gi*/config (no .git)  | waits, vcs.history.rewrite | waits, vcs.history.rewrite
  //   5 cp a.txt "<.github path> deploys ..." | allow (workspace) | deny human-only (workspace)
  // d610b2e9 allowed 1, 4 and 5 under W and 3 under the default policy.
  for (const [name, policy] of [["default", CANONICAL_POLICY], ["W", POLICY_W]] as const) {
    const lab = join(scratch, `l61926-${name}`);
    const home = join(lab, "home");
    const dir = join(lab, "proj");
    mkdirSync(join(home, ".hermes"), { recursive: true });
    writeFileSync(join(home, ".hermes", "notes.txt"), "made-up\n");
    // `.github` and no `.git`: `.gi*` matches only `.github` on disk.
    for (const [sub, file] of [["src", "a.ts"], [".github/workflows", "ci.yml"]] as const) {
      mkdirSync(join(dir, sub), { recursive: true });
      writeFileSync(join(dir, sub, file), "made-up\n");
    }
    for (const file of ["a", "a.js", "a.txt"]) writeFileSync(join(dir, file), "made-up\n");
    writeFileSync(join(dir, "APPROVAL.md"), policy);
    const attested = runCliIn(["policy", "attest", "--as", "human:alice"], dir);
    assert.equal(attested.code, 0, attested.stderr);
    const decide = (command: string): { permission: string; reason: string } => decideIn(dir, home, command);
    // 1. A replace line: the raise (policy.edit) and main's class beside it.
    const replaced = decide("cp a.js .github/README");
    assert.equal(replaced.permission, "deny", `${name}: ${replaced.reason}`);
    assert.match(replaced.reason, name === "W" ? /^hook-class-human-only: class files\.write\.workspace /u : /^hook-timeout: .*policy\.edit/u, name);
    // 2 and 3. A line main refuses stays refused; the zsh clobber forms with it.
    for (const command of ["echo x >>| ~/.hermes/auth.json", "echo x >>| ~/.hermes/.?nv.local"]) {
      const refused = decide(command);
      assert.equal(refused.permission, "deny", `${name}: ${command}`);
      assert.match(refused.reason, /^hook-unparseable: /u, `${name}: ${command}`);
    }
    // 4. `.gi*/config`: main's vcs.history.rewrite is kept beside policy.edit.
    const gitConfig = decide("mv a .gi*/config");
    assert.notEqual(gitConfig.permission, "allow", `${name}: ${gitConfig.reason}`);
    assert.match(gitConfig.reason, /vcs\.history\.rewrite/u, name);
    // 5. The quoted-prose cp: policy.edit raised, main's class beside it.
    const prose = decide('cp a.txt ".github/workflows/pages.yml deploys the site on push to main"');
    assert.equal(prose.permission, "deny", `${name}: ${prose.reason}`);
    assert.match(prose.reason, name === "W" ? /^hook-class-human-only: class files\.write\.workspace /u : /^hook-timeout: .*policy\.edit/u, name);
  }
});

const POLICY_ROUTED = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "1h"',
  "  on_expiry: reject",
  "protected_paths:",
  "  - { path: .github/workflows/, class: policy.edit.ci }",
  "classes:",
  "  read.*:",
  "    autonomy: autonomous",
  "  files.write.workspace:",
  "    autonomy: autonomous",
  "  policy.edit:",
  "    autonomy: autonomous",
  "  policy.edit.ci:",
  "    autonomy: manual",
  "```",
  "",
].join("\n");

test("lead ruling L62013, through the real hook: a folder takes its routed contents' class (S1); only the verbs that remove, move or change access are held (S2)", () => {
  // policy.edit autonomous, policy.edit.ci manual, ordinary writes autonomous.
  // Main 324d87dc allows every line here (files.write.workspace).
  const lab = join(scratch, "l62013");
  const home = join(lab, "home");
  const dir = join(lab, "proj");
  mkdirSync(home, { recursive: true });
  for (const [sub, file] of [["src", "a.ts"], [".github/workflows", "ci.yml"]] as const) {
    mkdirSync(join(dir, sub), { recursive: true });
    writeFileSync(join(dir, sub, file), "made-up\n");
  }
  writeFileSync(join(dir, "x"), "made-up\n");
  writeFileSync(join(dir, "APPROVAL.md"), POLICY_ROUTED);
  const attested = runCliIn(["policy", "attest", "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);
  // S1: `rm -rf .github` removes the routed workflows: policy.edit.ci, manual
  // (7aa0c26f answered policy.edit, autonomous here, beside main's class).
  for (const command of ["rm -rf .github", "rmdir .github", "mv .github gone"]) {
    const held = decideIn(dir, home, command);
    assert.equal(held.permission, "deny", `${command}: ${held.reason}`);
    assert.match(held.reason, /^hook-timeout: .*policy\.edit\.ci/u, command);
  }
  // S2: creating the folder keeps main's decision.
  for (const command of ["mkdir .claude", "touch .claude", "mkdir -p .github"]) {
    const kept = decideIn(dir, home, command);
    assert.equal(kept.permission, "allow", `${command}: ${kept.reason}`);
  }
  // S2: removing, moving, re-linking or locking it is held (policy.core, manual).
  for (const command of ["rm -rf .claude", "chmod -R 000 .claude", "mv .claude x", "ln -sf x .claude"]) {
    const held = decideIn(dir, home, command);
    assert.equal(held.permission, "deny", `${command}: ${held.reason}`);
    assert.match(held.reason, /^hook-timeout: .*policy\.core/u, command);
  }
});

test("main #693, the hook's own deadline: the listing pass runs under it, and past it the classification is stopped and refused", async () => {
  // The classification that finds the directories to list is held to the
  // deadline it is given; past it the lister throws and classifies nothing.
  // 64 KB of words before the pattern: the classification takes far longer
  // than the one millisecond it is given, however warm the process is.
  const dir = project({ out: ["a.log"] });
  const long = `cat ${"notes.txt ".repeat(6_500)}> out/*.log`;
  await assert.rejects(listGlobWriteDirsFor(long, [dir], { deadlineAt: Date.now() + 1 }), GlobListingDeadline);
  assert.ok((await listGlobWriteDirsFor("rm -f out/*", [dir], { deadlineAt: Date.now() + 60_000 })).size > 0);
});

test("main #693 through the real hook: a call whose listing pass outlasts the hook's deadline is refused hook-deadline, never left to the harness's timeout", () => {
  const dir = join(scratch, "deadline-lab");
  mkdirSync(join(dir, "out"), { recursive: true });
  writeFileSync(join(dir, "out", "a.log"), "made-up\n");
  writeFileSync(join(dir, "notes.txt"), "made-up\n");
  writeFileSync(
    join(dir, "APPROVAL.md"),
    ["# Policy", "", "```yaml approval-policy", 'version: "0.1"', "defaults:", "  autonomy: manual", '  approval_ttl: "1h"', "  on_expiry: reject", "classes:", "  read.*:", "    autonomy: autonomous", "  files.write.workspace:", "    autonomy: autonomous", "```", ""].join("\n"),
  );
  assert.equal(runCliIn(["policy", "attest", "--as", "human:alice"], dir).code, 0);
  // A write through a pattern, after 64 KB of words: the listing pass
  // classifies all of it, which takes far longer than one millisecond.
  const command = `cat ${"notes.txt ".repeat(6_500)}> out/*.log`;
  const decide = (extra: Readonly<Record<string, string>>): { permission: string; reason: string } => {
    decided += 1;
    const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
    delete env["APPROVAL_HUMAN"];
    const input = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "deadline", tool_use_id: `deadline-${String(decided)}`, cwd: dir, transcript_path: "/dev/null", tool_name: "Bash", tool_input: { command } });
    const ran = spawnSync(process.execPath, [CLI_ENTRY, "hook", "claude-code", "--as", "agent:cc", "--timeout", "1s", "--interval", "100ms"], { cwd: dir, encoding: "utf8", env, input });
    assert.equal(ran.status, 0, ran.stderr);
    const output = (JSON.parse(ran.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput;
    return { permission: output.permissionDecision, reason: output.permissionDecisionReason };
  };
  // The deadline is spent in the listing pass: refused there, by its own reason.
  const refused = decide({ [DESCRIBE_DEADLINE_ENV]: "1" });
  assert.equal(refused.permission, "deny", refused.reason);
  assert.match(refused.reason, /^hook-deadline: this hook could not read the Bash call within its own 1ms limit \(finding the directories its write patterns glob in ran past it\)/u);
  assert.match(refused.reason, /Nothing was registered or requested/u);
  // With the deadline it ships with, the same call is listed, read and allowed.
  const read = decide({});
  assert.equal(read.permission, "allow", read.reason);
});

test("review of 342f233b S1, through the real hook: a harness slow to close stdin does not spend the deadline, so a plain call held past it is still read and allowed", async () => {
  // The listing pass's clock starts once stdin is read, as main's describe
  // clock does. It started before the read, so a harness that held stdin open
  // past the deadline had a plain call refused `hook-deadline` (and the
  // Hermes race test's twenty hooks, each held on stdin while the test
  // attested the next directories, were refused and never asked).
  const dir = join(scratch, "stdin-lab");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "notes.txt"), "made-up\n");
  writeFileSync(
    join(dir, "APPROVAL.md"),
    ["# Policy", "", "```yaml approval-policy", 'version: "0.1"', "defaults:", "  autonomy: manual", '  approval_ttl: "1h"', "  on_expiry: reject", "classes:", "  read.*:", "    autonomy: autonomous", "  files.write.workspace:", "    autonomy: autonomous", "```", ""].join("\n"),
  );
  assert.equal(runCliIn(["policy", "attest", "--as", "human:alice"], dir).code, 0);
  // A deadline every machine reads `cat notes.txt` well inside (the control
  // below proves it on this one), and stdin held a second past it.
  const deadlineMs = 2_000;
  const decideHeld = (holdMs: number): Promise<{ permission: string; reason: string }> => {
    decided += 1;
    const env: NodeJS.ProcessEnv = { ...process.env, [DESCRIBE_DEADLINE_ENV]: String(deadlineMs) };
    delete env["APPROVAL_HUMAN"];
    const input = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "stdin", tool_use_id: `stdin-${String(decided)}`, cwd: dir, transcript_path: "/dev/null", tool_name: "Bash", tool_input: { command: "cat notes.txt" } });
    const child = spawn(process.execPath, [CLI_ENTRY, "hook", "claude-code", "--as", "agent:cc", "--timeout", "1s", "--interval", "100ms"], { cwd: dir, env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.stdin.on("error", () => undefined);
    const held = setTimeout(() => child.stdin.end(input), holdMs);
    return new Promise((settle, reject) => {
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(held);
        try {
          assert.equal(code, 0, stderr);
          const output = (JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput;
          settle({ permission: output.permissionDecision, reason: output.permissionDecisionReason });
        } catch (error) {
          reject(error as Error);
        }
      });
    });
  };
  // The control: handed at once, the call is read and allowed under this deadline.
  const control = await decideHeld(0);
  assert.equal(control.permission, "allow", control.reason);
  // Held on stdin a second past the deadline: still read and allowed.
  const held = await decideHeld(deadlineMs + 1_000);
  assert.equal(held.permission, "allow", held.reason);
});

test("review-b A686-FOLD7 S2 (lead ruling L62219), through the real hook: a long line that removes a folder holding four routed entries is never allowed, whether the read stops at the deadline or finishes", () => {
  // Review-b's shape: `cp a.js … out/; rm -rf .github`, four routed entries
  // under `.github`. At 100 KB the read takes about 20 CPU s and stops at the
  // shipped deadline; 10 KB (about 1.3 CPU s here) keeps CI's cost down and
  // still shows both ends: a short deadline stops it, the shipped one lets it
  // finish. A later speed-up may move this line from the first to the second,
  // and neither may answer allow.
  const dir = join(scratch, "s2-lab");
  mkdirSync(join(dir, "out"), { recursive: true });
  mkdirSync(join(dir, ".github", "r0"), { recursive: true });
  writeFileSync(join(dir, "a.js"), "made-up\n");
  writeFileSync(join(dir, ".github", "r0", "x.yml"), "made-up\n");
  const home = join(scratch, "s2-home");
  mkdirSync(home, { recursive: true });
  const routes = [0, 1, 2, 3];
  writeFileSync(
    join(dir, "APPROVAL.md"),
    [
      "# Policy",
      "",
      "```yaml approval-policy",
      'version: "0.1"',
      "defaults:",
      "  autonomy: manual",
      '  approval_ttl: "1h"',
      "  on_expiry: reject",
      "protected_paths:",
      ...routes.map((index) => `  - { path: .github/r${String(index)}/, class: policy.edit.r${String(index)} }`),
      "classes:",
      "  read.*:",
      "    autonomy: autonomous",
      "  files.write.workspace:",
      "    autonomy: autonomous",
      // Main's class for the folder is allowed: only the routed classes ask.
      "  policy.edit:",
      "    autonomy: autonomous",
      ...routes.flatMap((index) => [`  policy.edit.r${String(index)}:`, "    autonomy: manual"]),
      "```",
      "",
    ].join("\n"),
  );
  assert.equal(runCliIn(["policy", "attest", "--as", "human:alice"], dir).code, 0);
  const tail = " out/; rm -rf .github";
  const command = `cp${" a.js".repeat(Math.floor((10_000 - 2 - tail.length) / 5))}${tail}`;
  const decide = (extra: Readonly<Record<string, string>>): { permission: string; reason: string } => {
    decided += 1;
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ...extra };
    delete env["APPROVAL_HUMAN"];
    const input = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s2", tool_use_id: `s2-${String(decided)}`, cwd: dir, transcript_path: "/dev/null", tool_name: "Bash", tool_input: { command } });
    const ran = spawnSync(process.execPath, [CLI_ENTRY, "hook", "claude-code", "--as", "agent:cc", "--timeout", "1s", "--interval", "100ms"], { cwd: dir, encoding: "utf8", env, input });
    assert.equal(ran.status, 0, ran.stderr);
    const output = (JSON.parse(ran.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput;
    return { permission: output.permissionDecision, reason: output.permissionDecisionReason };
  };
  // Stopped at the deadline: refused, never a pass.
  const stopped = decide({ [DESCRIBE_DEADLINE_ENV]: "200" });
  assert.notEqual(stopped.permission, "allow", stopped.reason);
  assert.equal(stopped.permission, "deny", stopped.reason);
  assert.match(stopped.reason, /^hook-deadline: /u);
  // Read in full under the shipped deadline: the routed classes ask (manual,
  // a one-second wait, then refused), never main's autonomous policy.edit.
  const finished = decide({});
  assert.notEqual(finished.permission, "allow", finished.reason);
  assert.equal(finished.permission, "deny", finished.reason);
  assert.match(finished.reason, /^hook-timeout: .*policy\.edit\.r[0-3]/u);
});

test("review-b A686-FOLD7 S1 (lead ruling L62219), through the real hook after #690: naming a routed file first no longer clears the folder", () => {
  // Review-b's policy R4, made up: the CI and agent routes human-only, the
  // SPEC.md route and policy.edit autonomous. Before main's #690 the first
  // routed operand answered for the segment, so `rm -rf SPEC.md .github` was
  // allowed on SPEC.md's terms while `rm -rf .github` was denied.
  const dir = join(scratch, "s1-lab");
  for (const [sub, file] of [[".github/workflows", "ci.yml"], [".claude/agents", "a.md"], ["", "SPEC.md"], ["", "README.md"]] as const) {
    mkdirSync(join(dir, sub), { recursive: true });
    writeFileSync(join(dir, sub, file), "made-up\n");
  }
  const home = join(scratch, "s1-home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(dir, "APPROVAL.md"),
    [
      "# Policy",
      "",
      "```yaml approval-policy",
      'version: "0.1"',
      "defaults:",
      "  autonomy: human-only",
      '  approval_ttl: "1h"',
      "  on_expiry: reject",
      "protected_paths:",
      '  - { path: ".github/workflows/", class: policy.edit.ci }',
      '  - { path: ".claude/agents/", class: policy.edit.agents }',
      '  - { path: "SPEC.md", class: policy.edit.spec }',
      "classes:",
      "  read.*:",
      "    autonomy: autonomous",
      "  files.write.workspace:",
      "    autonomy: autonomous",
      "  files.delete.out_of_scope:",
      "    autonomy: autonomous",
      "  policy.edit:",
      "    autonomy: autonomous",
      "  policy.edit.ci:",
      "    autonomy: human-only",
      "  policy.edit.agents:",
      "    autonomy: human-only",
      "  policy.edit.spec:",
      "    autonomy: autonomous",
      "```",
      "",
    ].join("\n"),
  );
  assert.equal(runCliIn(["policy", "attest", "--as", "human:alice"], dir).code, 0);
  // The control: the SPEC.md route alone is allowed, so a deny below is the folder's.
  assert.equal(decideIn(dir, home, "rm -rf SPEC.md").permission, "allow");
  assert.equal(decideIn(dir, home, "rm -rf .github").permission, "deny");
  for (const command of [
    "rm -rf SPEC.md .github",
    "rm -rf .github SPEC.md",
    "rm -rf SPEC.md README.md .github",
    "rm -rf SPEC.md .github .claude",
    "rm -rf SPEC.md .github/workflows",
    "rm -rf SPEC.md ./.github/",
    "rm -rf SPEC.md .GitHub",
    "chmod -R 000 SPEC.md .github",
    "mv SPEC.md .github x/",
    "echo x > SPEC.md > .github",
  ]) {
    const decided = decideIn(dir, home, command);
    assert.equal(decided.permission, "deny", `${command}: ${decided.reason}`);
    assert.match(decided.reason, /^hook-class-human-only: class policy\.(edit\.ci|edit\.agents|core) /u, command);
  }
});

test("lead ruling L62319, through the real hook after main's #700: a zsh clobber form is read at the file zsh writes, or refused as main refuses it", () => {
  // Made up: workspace writes autonomous, everything else human-only, the
  // workflows routed. Main a86c6bbf denies every `>!` line here unparseable.
  const dir = join(scratch, "l62319");
  const home = join(scratch, "l62319-home");
  mkdirSync(home, { recursive: true });
  for (const [sub, file] of [[".github/workflows", "ci.yml"], [".claude", "settings.json"], ["", "notes.txt"]] as const) {
    mkdirSync(join(dir, sub), { recursive: true });
    writeFileSync(join(dir, sub, file), "made-up\n");
  }
  writeFileSync(
    join(dir, "APPROVAL.md"),
    [
      "# Policy",
      "",
      "```yaml approval-policy",
      'version: "0.1"',
      "defaults:",
      "  autonomy: human-only",
      '  approval_ttl: "1h"',
      "  on_expiry: reject",
      "protected_paths:",
      '  - { path: ".github/workflows/", class: policy.edit.ci }',
      "classes:",
      "  read.*:",
      "    autonomy: autonomous",
      "  files.write.workspace:",
      "    autonomy: autonomous",
      "```",
      "",
    ].join("\n"),
  );
  assert.equal(runCliIn(["policy", "attest", "--as", "human:alice"], dir).code, 0);
  // Read at an ordinary file (bash's `!` beside it is ordinary too): allowed, as `>` is.
  for (const command of ["echo x > notes.txt", "echo x >! notes.txt", "echo x >>!notes.txt", "echo x 2>&! notes.txt"]) {
    const decided = decideIn(dir, home, command);
    assert.equal(decided.permission, "allow", `${command}: ${decided.reason}`);
  }
  // Read at a protected, a routed, a glob and an organ-folder target: held on that class.
  for (const [command, cls] of [
    ["echo x >! APPROVAL.md", "policy\\.core"],
    ["echo x >>!APPROVAL.md", "policy\\.core"],
    ["echo x >! .github/workflows/ci.yml", "policy\\.edit\\.ci"],
    ["echo x >&!.github/workflows/ci.yml", "policy\\.edit\\.ci"],
    ["echo x >! APPROVA?.md", "policy\\.core"],
    ["echo x 2>! .claude/settings.json", "policy\\.core"],
    ["echo x >! .cl*/settings.json", "policy\\.core"],
  ] as const) {
    const decided = decideIn(dir, home, command);
    assert.equal(decided.permission, "deny", `${command}: ${decided.reason}`);
    assert.match(decided.reason, new RegExp(`^hook-class-human-only: class ${cls} `, "u"), command);
  }
  // Refused as main refuses it: zsh writes another file there, or none.
  for (const command of ["bash -c 'echo x >! notes.txt'", "echo x 10>! notes.txt", "echo x 2>&1>!notes.txt", "echo x >!=notes.txt"]) {
    const decided = decideIn(dir, home, command);
    assert.equal(decided.permission, "deny", `${command}: ${decided.reason}`);
    assert.match(decided.reason, /^hook-unparseable: redirection /u, command);
  }
});

/** The `examples/agent-village` classes and defaults (its channels left out so the loader takes it alone). */
const POLICY_AV = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: autonomous",
  "  approval_ttl: 72h",
  "  on_expiry: reject",
  "classes:",
  "  policy.core:",
  "    autonomy: human-only",
  "  log.mutate:",
  "    autonomy: human-only",
  "  account.credential:",
  "    autonomy: human-only",
  "```",
  "",
].join("\n");

let decidedAv = 0;
/** The real hook's decision with the hook process in `dir` and the envelope's session `cwd` set to `session`. */
function decideAv(dir: string, home: string, session: string, command: string): { permission: string; reason: string } {
  decidedAv += 1;
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env["APPROVAL_HUMAN"];
  const input = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "l62435", tool_use_id: `l62435-${decidedAv}`, cwd: session, transcript_path: "/dev/null", tool_name: "Bash", tool_input: { command } });
  const ran = spawnSync(process.execPath, [CLI_ENTRY, "hook", "claude-code", "--as", "agent:cc", "--timeout", "1s", "--interval", "100ms"], { cwd: dir, encoding: "utf8", env, input });
  assert.equal(ran.status, 0, ran.stderr);
  const output = (JSON.parse(ran.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput;
  return { permission: output.permissionDecision, reason: output.permissionDecisionReason };
}

test("lead ruling L62435 (S6, S7), through the real hook under the agent-village classes: the over-asks are back at main's allow; a parent still denies", () => {
  const lab = join(scratch, "l62435-av");
  const dir = join(lab, "proj");
  const home = join(lab, "home");
  for (const [sub, file] of [["src", "a.ts"], ["scripts", "run.sh"], ["sub", "b.ts"], [".claude", "settings.json"], ["../home/.claude", "settings.json"], ["../plain", "x"]] as const) {
    mkdirSync(join(dir, sub), { recursive: true });
    writeFileSync(join(dir, sub, file), "made-up\n");
  }
  writeFileSync(join(dir, "APPROVAL.md"), POLICY_AV);
  const attested = spawnSync(process.execPath, [CLI_ENTRY, "policy", "attest", "--as", "human:alice"], { cwd: dir, encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.equal(attested.status, 0, attested.stderr);
  // Main 9122cb3e allows each of these under these classes.
  for (const command of [
    'chmod +x "$f"',
    "chmod +x ./$NAME",
    "chmod u+x $1",
    "chmod 755 $DIR",
    'chmod -R 755 "$OUT"',
    "chmod +x $SCRIPT",
    "chmod +x scripts/$NAME",
    "find . -name '*.tmp' -delete",
    "find . -name '*.pyc' -delete",
    "find . -name .DS_Store -delete",
    "find . -empty -delete",
    "rm -rf $TARGET",
    "rm -rf $BUILD_DIR",
    'rm -rf "$OUT"',
    "rm -rf /tmp/$name",
    "rm -rf ./$X",
    "rm -rf /private/tmp/$SESSION",
    "D=.claude; rm -rf $D",
  ]) {
    const decision = decideAv(dir, home, dir, command);
    assert.equal(decision.permission, "allow", `${command}: ${decision.reason}`);
  }
  // A parent, or an unreadable word below one: human-only.
  for (const command of ["find . -delete", "rm -rf ../$X", "rm -rf ~/$X", "chmod 000 .", "X=. ; rm -rf $X"]) {
    const decision = decideAv(dir, home, dir, command);
    assert.equal(decision.permission, "deny", `${command}: ${decision.reason}`);
  }
  // The session's directory differs from the hook's (a `cd` in an earlier
  // call): a word is placed from both, so a place that holds neither keeps
  // main's allow, and a parent from either still denies.
  const session = join(dir, "sub");
  for (const command of ["rm -rf /tmp/b2-l62435-not-there", "rm -rf ../plain", `rm -rf ${join(lab, "plain")}`]) {
    const decision = decideAv(dir, home, session, command);
    assert.equal(decision.permission, "allow", `${command}: ${decision.reason}`);
  }
  for (const command of ["rm -rf ..", "rm -rf ../..", `rm -rf ${dir}`, "chmod -R 000 ."]) {
    const decision = decideAv(dir, home, session, command);
    assert.equal(decision.permission, "deny", `${command}: ${decision.reason}`);
  }
});
