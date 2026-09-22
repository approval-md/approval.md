/**
 * Write-scope refinement tests (APRV-402).
 *
 * The classifier's half of the write rules is a fixture table in
 * `tests/command-class.test.ts`: pure, synthetic roots, no disk. This file is
 * the other half, and it is the half that did not exist. Deletes got a disk
 * pass in APRV-267 and reads in APRV-347; writes were decided on the text
 * alone, so `cp x build/y` was `files.write.workspace` with `build` pointing
 * anywhere at all.
 *
 * Every case here builds real directories and real symlinks under a temp root.
 * Nothing is stubbed: a stub would be a second opinion about what `realpath`
 * returns, which is the fact under test. One end-to-end case runs the compiled
 * CLI, because `approval hook classify` printing a different class from the one
 * `hook claude-code` decides would make the explainer a different program.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  classifyCommand,
  type ClassifiedSegment,
  type CommandClassification,
} from "../src/core/command-class.js";
import { refineWriteScope, resolveWriteRoots } from "../src/cli/hook.js";

/** dist/tests/cli-hook-write-scope.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

/** The class an out-of-scope write answers, as `core/command-class.ts` spells it. */
const OUT_OF_SCOPE = "files.delete.out_of_scope";
const WORKSPACE = "files.write.workspace";
const REJECTED_RULE = "write-out-of-scope-resolved";

const base = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-write-scope-")));

/**
 * The world every case shares.
 *
 * `workspace` is where the command runs. `elsewhere` is outside it and outside
 * every temp root's usable part only in the sense that matters: it is not the
 * workspace, and the scratch-root set handed to each case never contains it.
 * `workspace/build` is the honest directory; `workspace/out` is the symlink
 * that leaves. `scratch/link` is the same trick one level up, for a
 * destination that is textually under a scratch root (AC4).
 */
const workspace = join(base, "workspace");
const elsewhere = join(base, "elsewhere");
const scratch = join(base, "scratch");
mkdirSync(join(workspace, "build"), { recursive: true });
mkdirSync(join(elsewhere, "secrets"), { recursive: true });
mkdirSync(scratch, { recursive: true });
writeFileSync(join(workspace, "x"), "x", "utf8");
writeFileSync(join(workspace, "a.tgz"), "not really an archive", "utf8");
symlinkSync(elsewhere, join(workspace, "out"));
symlinkSync(elsewhere, join(scratch, "link"));

after(() => {
  rmSync(base, { recursive: true, force: true });
});

/** The roots a real hook would hand this pass for a command run in `workspace`. */
const ROOTS: readonly string[] = [workspace, scratch];

/** Classify purely, with `scratch` as the caller-resolved scratch root. */
function pure(command: string): CommandClassification {
  return classifyCommand(command, [], { scratchRoots: [scratch] });
}

interface Verdict {
  cls: string;
  rule: string;
  note: string;
}

/** Classify, then apply the impure pass over the top, as `classifyForHook` does. */
function decide(command: string, roots: readonly string[] = ROOTS): Verdict {
  const classified = pure(command);
  assert.equal(classified.ok, true, `${command} did not classify`);
  const refined = refineWriteScope(classified, roots, workspace);
  assert.equal(refined.result.ok, true);
  if (!refined.result.ok) throw new Error("unreachable");
  const segment = refined.result.segments[0];
  assert.ok(segment !== undefined);
  return { cls: segment.class, rule: segment.rule, note: refined.notes.join(" ") };
}

// ---------------------------------------------------------------------------
// 1. The destination the text cannot see
// ---------------------------------------------------------------------------

test("a relative destination that really is in the workspace is left alone", () => {
  for (const command of [
    "cp x build/y",
    "tee build/notes.txt",
    "mkdir -p build/nested/deeper",
    "mv x build/y",
    "touch build/marker",
    "tar -x -f a.tgz -C build",
    "npm pack --pack-destination build",
  ]) {
    const verdict = decide(command);
    assert.equal(verdict.cls, WORKSPACE, `${command} was tightened: ${verdict.note}`);
    assert.notEqual(verdict.rule, REJECTED_RULE);
  }
});

test("a relative destination that leaves every root through a symlink is out of scope", () => {
  for (const command of [
    "cp x out/y",
    "tee out/notes.txt",
    "mkdir -p out/nested",
    "mv x out/y",
    "ln -s x out/y",
    "truncate -s 0 out/y",
  ]) {
    const verdict = decide(command);
    assert.equal(verdict.cls, OUT_OF_SCOPE, `${command} stayed ${verdict.cls}`);
    assert.equal(verdict.rule, REJECTED_RULE);
    assert.match(verdict.note, /resolves to/u);
  }
});

test("the packaging rows are tightened by the same pass, not by a second rule", () => {
  for (const command of [
    "tar -x -f a.tgz -C out",
    "tar -x -f a.tgz --directory=out",
    "npm pack --pack-destination out",
    "npm pack --pack-destination=out",
    "base64 -o out/encoded x",
    "openssl dgst -sha256 -out out/sums x",
  ]) {
    const verdict = decide(command);
    assert.equal(verdict.cls, OUT_OF_SCOPE, `${command} stayed ${verdict.cls}`);
    assert.equal(verdict.rule, REJECTED_RULE);
  }
});

/**
 * AC4, and the sharper of the two cases the task names: the delete rule closed
 * this explicitly for `rm` in APRV-267 and the write path had no equivalent. A
 * destination strictly under a resolved scratch root answers `workspace` on the
 * TEXT alone, so "unpack into the temp directory" was autonomous even when the
 * named directory under the temp root is a symlink pointing at a checkout or a
 * home directory.
 */
test("a packaging destination under a scratch root only through a symlink is tightened", () => {
  const inside = decide(`tar -x -f a.tgz -C ${join(scratch, "real")}`);
  assert.equal(inside.cls, WORKSPACE, `a real path under the scratch root was tightened: ${inside.note}`);

  for (const command of [
    `tar -x -f a.tgz -C ${join(scratch, "link")}`,
    `tar -x -f a.tgz -C ${join(scratch, "link", "deeper")}`,
    `npm pack --pack-destination ${join(scratch, "link")}`,
  ]) {
    const verdict = decide(command);
    assert.equal(verdict.cls, OUT_OF_SCOPE, `${command} stayed ${verdict.cls}`);
    assert.equal(verdict.rule, REJECTED_RULE);
    assert.match(verdict.note, new RegExp(elsewhere.replaceAll(".", "\\."), "u"));
  }
});

// ---------------------------------------------------------------------------
// 2. The pass can only narrow (AC3)
// ---------------------------------------------------------------------------

test("the pure classifier is unchanged: the tightening lives in the hook", () => {
  for (const command of ["cp x out/y", `tar -x -f a.tgz -C ${join(scratch, "link")}`]) {
    const classified = pure(command);
    assert.equal(classified.ok, true);
    if (!classified.ok) return;
    const segment = classified.segments[0];
    assert.ok(segment !== undefined);
    assert.equal(
      segment.class,
      WORKSPACE,
      `${command} was answered ${segment.class} by the pure classifier; the symlink is a disk fact and the text half must not have learned it`,
    );
  }
});

/**
 * The property the whole design rests on. `hook classify` and
 * `hook <harness>` share this pass precisely because a caller that skipped it
 * can never be MORE strict than one that runs it, so a pass that loosened even
 * one segment would make the explainer and the decider two programs.
 */
test("the pass never loosens a class, whatever the roots", () => {
  const commands = [
    "cp x build/y",
    "cp x out/y",
    "cp x /etc/passwd",
    "mkdir -p build/nested",
    "tee out/notes.txt",
    "tar -x -f a.tgz -C out",
    "tar -x -f a.tgz -C build",
    "npm pack --pack-destination out",
    "base64 -o out/encoded x",
    "cat build/y",
    "rm -rf build",
    "git status",
    "echo hello",
  ];
  for (const roots of [ROOTS, [workspace], [scratch], []]) {
    for (const command of commands) {
      const classified = pure(command);
      if (!classified.ok) continue;
      const refined = refineWriteScope(classified, roots, workspace);
      assert.equal(refined.result.ok, true);
      if (!refined.result.ok) continue;
      assert.equal(refined.result.segments.length, classified.segments.length);
      const segments: readonly ClassifiedSegment[] = refined.result.segments;
      for (const [index, was] of classified.segments.entries()) {
        const now: ClassifiedSegment | undefined = segments[index];
        assert.ok(now !== undefined);
        const moved = now.class !== was.class;
        assert.ok(
          !moved || (was.class === WORKSPACE && now.class === OUT_OF_SCOPE),
          `${command} moved from ${was.class} to ${now.class} under roots ${JSON.stringify(roots)}; this pass may only move a workspace write to ${OUT_OF_SCOPE}`,
        );
      }
    }
  }
});

test("no roots means no write scoping, which is the answer this hook gave before", () => {
  const verdict = decide("cp x out/y", []);
  assert.equal(verdict.cls, WORKSPACE);
  assert.equal(verdict.note, "");
});

test("a class that is not a workspace write is never touched", () => {
  // `cat` is a read and `curl` is a network call: neither is this pass's
  // business, and a pass that re-read them would be a second classifier.
  for (const command of ["cat out/y", "curl https://example.invalid"]) {
    const classified = pure(command);
    if (!classified.ok) continue;
    const refined = refineWriteScope(classified, ROOTS, workspace);
    assert.deepEqual(refined.notes, [], `${command} was re-read by the write pass`);
  }
});

// ---------------------------------------------------------------------------
// 3. The roots, and the end-to-end agreement
// ---------------------------------------------------------------------------

test("resolveWriteRoots carries the working directory and the scratch roots", () => {
  const roots = resolveWriteRoots(workspace);
  assert.equal(roots[0], workspace, "the working directory is not the first root");
  assert.ok(
    roots.some((root) => root === realpathSync(tmpdir()) || root === "/tmp" || root === "/private/tmp"),
    `no temp root among ${JSON.stringify(roots)}; the write rule and the delete rule must agree about where scratch is`,
  );
});

test("hook classify prints the class the hook decides, symlink and all", () => {
  const run = spawnSync(
    process.execPath,
    [CLI_ENTRY, "hook", "classify", "--json", "--", "cp x out/y"],
    { cwd: workspace, encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout) as {
    segments: Array<{ class: string; rule: string }>;
  };
  const segment = parsed.segments[0];
  assert.ok(segment !== undefined);
  assert.equal(
    segment.class,
    OUT_OF_SCOPE,
    `the explainer printed ${segment.class} where the hook decides ${OUT_OF_SCOPE}`,
  );
  assert.equal(segment.rule, REJECTED_RULE);
});
