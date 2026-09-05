/**
 * Scratch-delete refinement tests (APRV-267).
 *
 * The classifier's half of this rule is a fixture table in
 * `tests/command-class.test.ts`: pure, synthetic roots, no disk. This file is
 * the other half. `resolveScratchRoots` reads an environment and a filesystem,
 * and `refineScratchDelete` stats real paths, so every case here builds real
 * directories, real symlinks and a real git checkout under a temp root. Nothing
 * is stubbed: a stub would be a second opinion about what `realpath` returns,
 * which is the fact under test.
 *
 * One end-to-end case runs the compiled CLI, because `approval hook classify`
 * printing a different class from the one `hook claude-code` decides would make
 * the explainer a different program.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { classifyCommand } from "../src/core/command-class.js";
import {
  refineScratchDelete,
  resolveScratchRoots,
  scratchRootDepthAccepted,
} from "../src/cli/hook.js";

/** The temp roots the hook compiles in, and the only ones exempt from depth. */
const WELL_KNOWN_TEMP_ROOTS: readonly string[] = ["/tmp", "/private/tmp", "/var/tmp"];

/** dist/tests/cli-hook-scratch.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-hook-scratch-")));
const REAL_TMP = realpathSync(tmpdir());

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Classify with the roots supplied, then apply the impure pass over the top. */
function decide(command: string, roots: readonly string[]): { cls: string; rule: string; note: string } {
  const classified = classifyCommand(command, [], { scratchRoots: roots });
  assert.equal(classified.ok, true);
  if (!classified.ok) throw new Error("unreachable");
  const refined = refineScratchDelete(classified, roots);
  assert.equal(refined.result.ok, true);
  if (!refined.result.ok) throw new Error("unreachable");
  const segment = refined.result.segments[0];
  assert.ok(segment !== undefined);
  return { cls: segment.class, rule: segment.rule, note: refined.notes.join(" ") };
}

// ---------------------------------------------------------------------------
// resolveScratchRoots: what the hook is willing to call a scratch root
// ---------------------------------------------------------------------------

test("the system temp root is a scratch root, resolved through its symlinks", () => {
  // The cwd is the repository checkout, which no temp root contains. The
  // expectation is built from `realpath(os.tmpdir())` on THIS machine, so it
  // holds wherever the temp root lives and however deep it is: `/tmp` on Linux,
  // `/private/tmp` (or `/var/folders/...`) once macOS resolves its symlinks.
  const roots = resolveScratchRoots(process.cwd(), {});
  assert.ok(roots.includes(REAL_TMP), `${REAL_TMP} is not among ${roots.join(", ")}`);
  // Every root came back realpath'd, so no root is a symlink to another place.
  for (const root of roots) {
    assert.equal(root, realpathSync(root));
  }
});

test(
  "on macOS the temp root arrives through the /tmp symlink, not as /tmp",
  { skip: process.platform !== "darwin" ? "darwin-only symlink layout" : false },
  () => {
    // Kept as the proof that resolution happens at all: `/tmp` is a symlink to
    // `/private/tmp` here, and the resolved name is the one that lands.
    assert.equal(realpathSync("/tmp"), "/private/tmp");
    const roots = resolveScratchRoots(process.cwd(), {});
    assert.ok(!roots.includes("/tmp"), `/tmp appeared unresolved among ${roots.join(", ")}`);
    assert.ok(roots.includes("/private/tmp"), `/private/tmp is not among ${roots.join(", ")}`);
  },
);

test("a one-segment system temp root is accepted, which is the Linux shape", () => {
  // On Linux `os.tmpdir()` IS `/tmp`: one segment, and the depth floor used to
  // refuse it, so `files.delete.scratch` could never fire in CI. The exemption
  // is a property of the resolved name, so it is testable on either platform.
  assert.equal(scratchRootDepthAccepted("/tmp"), true);
  assert.equal(scratchRootDepthAccepted("/var/tmp"), true);
  assert.equal(scratchRootDepthAccepted("/private/tmp"), true);
  // Everything else keeps the two-segment rule, `/` included.
  assert.equal(scratchRootDepthAccepted("/"), false);
  assert.equal(scratchRootDepthAccepted("/etc"), false);
  assert.equal(scratchRootDepthAccepted("/home"), false);
  assert.equal(scratchRootDepthAccepted("/tmpfoo"), false);
  assert.equal(scratchRootDepthAccepted("/home/runner"), true);
  assert.equal(scratchRootDepthAccepted("/tmp/pad"), true);
});

test("a delete under the machine's own temp root is scratch, whatever its depth", () => {
  // The end of the same thread, through the roots this machine actually
  // resolves rather than a hand-written list: the mkdtemp directory sits one
  // level under `realpath(os.tmpdir())` on Linux and macOS alike.
  const roots = resolveScratchRoots(process.cwd(), {});
  const file = join(scratch, "machine-root", "probe.json");
  mkdirSync(join(scratch, "machine-root"), { recursive: true });
  writeFileSync(file, "{}", "utf8");
  const decision = decide(`rm -rf ${file}`, roots);
  assert.equal(decision.cls, "files.delete.scratch");
  assert.equal(decision.rule, "rm-scratch");
  assert.equal(decision.note, "");
});

test("a harness-exported scratchpad directory joins the roots", () => {
  const pad = join(scratch, "session-pad");
  mkdirSync(pad, { recursive: true });
  const roots = resolveScratchRoots(process.cwd(), { CLAUDE_SCRATCHPAD_DIR: pad });
  assert.ok(roots.includes(pad), `${pad} is not among ${roots.join(", ")}`);
});

test("a root that does not exist, is relative, or names nothing is dropped", () => {
  const roots = resolveScratchRoots(process.cwd(), {
    CLAUDE_SCRATCHPAD_DIR: join(scratch, "never-created"),
    CLAUDE_CODE_SCRATCHPAD_DIR: "relative/pad",
  });
  assert.ok(!roots.includes(join(scratch, "never-created")));
  assert.ok(!roots.includes("relative/pad"));
});

test("a root shallower than two segments is refused, so a poisoned TMPDIR cannot name /", () => {
  // The guard is the reason a self-reported value cannot widen the class
  // (SPEC.md §11.1: self-reported fields never reduce scrutiny). `/` resolves,
  // exists, and is still not anyone's scratchpad.
  const roots = resolveScratchRoots(process.cwd(), { CLAUDE_SCRATCHPAD_DIR: "/" });
  assert.ok(!roots.includes("/"));
  // A one-segment root survives only by being one of the three compiled-in temp
  // directories, which a reported value cannot become by reporting it.
  for (const root of roots) {
    const deep = root.split("/").filter((segment) => segment.length > 0).length >= 2;
    assert.ok(deep || WELL_KNOWN_TEMP_ROOTS.includes(root), root);
  }
});

test("a root containing the working directory is refused", () => {
  // A checkout is never inside its own scratch root; a root that swallowed it
  // would make every delete in the repository a scratch delete.
  const inner = join(scratch, "outer", "inner");
  mkdirSync(inner, { recursive: true });
  const roots = resolveScratchRoots(inner, { CLAUDE_SCRATCHPAD_DIR: join(scratch, "outer") });
  assert.ok(!roots.includes(join(scratch, "outer")));
  // …and the temp root above it goes for the same reason.
  assert.ok(!roots.includes(REAL_TMP), `${REAL_TMP} contains the cwd and must not be a root`);
});

// ---------------------------------------------------------------------------
// refineScratchDelete: the checks the text cannot make
// ---------------------------------------------------------------------------

test("a delete inside the scratch root survives the physical pass", () => {
  const dir = join(scratch, "plain");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "build.log"), "x", "utf8");
  const decision = decide(`rm -rf ${join(dir, "build.log")}`, [scratch]);
  assert.equal(decision.cls, "files.delete.scratch");
  assert.equal(decision.rule, "rm-scratch");
  assert.equal(decision.note, "");
});

test("a target that does not exist yet is resolved through its nearest existing ancestor", () => {
  const dir = join(scratch, "partly");
  mkdirSync(dir, { recursive: true });
  const decision = decide(`rm -rf ${join(dir, "not", "there", "yet")}`, [scratch]);
  assert.equal(decision.cls, "files.delete.scratch");
});

test("a symlink escaping the root tightens back to files.delete.out_of_scope", () => {
  // The whole point of the physical pass: the text says the target is under the
  // root, and the kernel would follow the link somewhere else entirely.
  const dir = join(scratch, "escape");
  mkdirSync(dir, { recursive: true });
  symlinkSync("/etc", join(dir, "out"), "dir");
  const decision = decide(`rm -rf ${join(dir, "out", "hosts")}`, [scratch]);
  assert.equal(decision.cls, "files.delete.out_of_scope");
  assert.equal(decision.rule, "rm-scratch-rejected");
  assert.match(decision.note, /does not resolve to a path inside a scratch root/u);
});

test("a git checkout inside the temp root is not scratch", () => {
  // `/tmp/probe-clone` is a real shape: a lane clones the repository into temp
  // and then removes it. Removing a checkout destroys work, so it stays manual.
  const clone = join(scratch, "probe-clone");
  mkdirSync(clone, { recursive: true });
  const init = spawnSync("git", ["init", "-q"], { cwd: clone, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);

  const wholeClone = decide(`rm -rf ${clone}`, [scratch]);
  assert.equal(wholeClone.cls, "files.delete.out_of_scope");
  assert.equal(wholeClone.rule, "rm-scratch-rejected");

  // A file deep inside it is inside the checkout too: the walk goes up to the
  // root, not just one level.
  mkdirSync(join(clone, "src", "deep"), { recursive: true });
  const inside = decide(`rm -rf ${join(clone, "src", "deep")}`, [scratch]);
  assert.equal(inside.cls, "files.delete.out_of_scope");
  assert.equal(inside.rule, "rm-scratch-rejected");

  // …and a sibling directory beside the clone is unaffected.
  const sibling = join(scratch, "beside-the-clone");
  mkdirSync(sibling, { recursive: true });
  assert.equal(decide(`rm -rf ${sibling}`, [scratch]).cls, "files.delete.scratch");
});

test("with no roots the pass never fires, because the classifier never offered a scratch segment", () => {
  const decision = decide(`rm -rf ${join(scratch, "anything")}`, []);
  assert.equal(decision.cls, "files.delete.out_of_scope");
  assert.equal(decision.rule, "rm-absolute");
});

test("one escaping target taints the whole segment", () => {
  const dir = join(scratch, "mixed");
  mkdirSync(dir, { recursive: true });
  symlinkSync("/etc", join(dir, "out"), "dir");
  const decision = decide(`rm -rf ${join(dir, "keep.txt")} ${join(dir, "out", "hosts")}`, [scratch]);
  assert.equal(decision.cls, "files.delete.out_of_scope");
  assert.equal(decision.rule, "rm-scratch-rejected");
});

// ---------------------------------------------------------------------------
// End to end: the explainer runs the same two halves the hook does
// ---------------------------------------------------------------------------

test("approval hook classify reports files.delete.scratch for a temp-root delete", () => {
  const dir = join(scratch, "cli-case");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "probe.json"), "{}", "utf8");

  // Run from the repository checkout: `resolveScratchRoots` refuses a root that
  // contains the working directory, so classifying from inside the temp tree
  // would (correctly) find no roots at all.
  const repo = fileURLToPath(new URL("../..", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [CLI_ENTRY, "hook", "classify", "--json", "--", `rm -rf ${join(dir, "probe.json")}`],
    { cwd: repo, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as {
    ok: boolean;
    classes?: string[];
    segments?: { rule: string }[];
  };
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.classes, ["files.delete.scratch"]);
  assert.equal(parsed.segments?.[0]?.rule, "rm-scratch");
});
