/**
 * The hook's passes over a glob of many `*` are bounded in CPU time
 * (B-HOOK-GLOB-LINEAR).
 *
 * `globRegex` compiled each glob component to an anchored regular expression,
 * and a run of `*` made the engine backtrack, at a cost that grows with
 * (stars + name length) choose (name length) for every name tested: `cat`
 * with 240 `*` and 12 `z` ran the credential pass past Claude Code's 60 s
 * hook timeout, and a hook stopped by its timeout lets the call through. This
 * file imports hook.ts alone, so it runs unchanged against the old matcher.
 *
 * Every credential file here is synthetic, in a scratch directory, and HOME
 * points into that directory.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { classifyForHook, credentialReadLandings } from "../src/cli/hook.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-glob-cost-")));

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** CPU milliseconds (user and system) spent in `run`: a shared runner's wall clock is no bound. */
function cpuMs(run: () => void): number {
  const start = process.cpuUsage();
  run();
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1000;
}

/** A directory an agent might sit in: names as long as `auth.json`, and a synthetic gate home. */
function workspace(): { dir: string; home: string } {
  const dir = join(scratch, "ws");
  const home = join(scratch, "home");
  mkdirSync(join(dir, ".approval"), { recursive: true });
  mkdirSync(home, { recursive: true });
  for (const name of [".env", ".env.local", "auth.json", "keys", "env", "README.md", "package-lock.json"]) {
    writeFileSync(join(dir, name), "x\n", "utf8");
  }
  writeFileSync(join(dir, ".approval", "env"), "SYNTHETIC=1\n", "utf8");
  mkdirSync(join(home, ".hermes", "plugins"), { recursive: true });
  for (const name of ["auth.json", "config.yaml", "shell-hooks-allowlist.json.lock"]) {
    writeFileSync(join(home, ".hermes", name), "x\n", "utf8");
  }
  return { dir, home };
}

// The first case is small so that the old matcher fails the bound in about a
// second rather than running for hours: the old cost per name was (stars +
// name length) choose (name length), so on a521a91d 12 `*` took 0.95 CPU s
// against `package-lock.json` alone, 40 took 31 CPU s in the credential pass
// from a directory holding `auth.json`, and from one holding only `env` and
// `keys` 160 took 4.9 CPU s and 240 took 35.7 CPU s.
const STAR_COUNTS = [12, 160, 240, 2000];

/**
 * The bound: 50 CPU ms for one word through the credential pass, 100 through
 * the whole classification. Measured at 0.4 to 4.7 CPU ms a word here (the
 * 2000-star word and the first, unwarmed call included), so each bound has a
 * margin of 10x or more for a slow runner and stays 600x under the hook's
 * 60 s timeout.
 */
const BOUND_MS = 50;

test("cost: the credential pass over a long `*` run is bounded in CPU time", () => {
  const { dir, home } = workspace();
  const env = { HOME: home };
  for (const stars of STAR_COUNTS) {
    const word = `${"*".repeat(stars)}${"z".repeat(12)}`;
    let found: Array<{ segment: string; path: string }> = [];
    const ms = cpuMs(() => {
      found = credentialReadLandings(`cat ${word}`, dir, env);
    });
    assert.deepEqual(found, [], `${String(stars)} stars`);
    assert.ok(ms < BOUND_MS, `cat with ${String(stars)} '*' and 12 'z': ${ms.toFixed(1)} CPU ms, bound ${String(BOUND_MS)}`);

    // The same run that does name a credential is still found at that scale.
    let named: Array<{ segment: string; path: string }> = [];
    const namedMs = cpuMs(() => {
      named = credentialReadLandings(`cat .approval/${"*".repeat(stars)}env`, dir, env);
    });
    assert.ok(
      named.some((entry) => entry.path === join(dir, ".approval", "env")),
      `${String(stars)} stars before env: ${JSON.stringify(named)}`,
    );
    assert.ok(namedMs < BOUND_MS, `${String(stars)} stars before env: ${namedMs.toFixed(1)} CPU ms, bound ${String(BOUND_MS)}`);
  }
});

test("cost: the whole hook classification of a long `*` run is bounded in CPU time", () => {
  const { dir, home } = workspace();
  // classifyForHook reads HOME from the process: point it at the scratch home
  // for the call, so `~/.hermes/` lists synthetic names only.
  const savedHome = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    // 8 first: the `.git` reader of a write (`echo x > ~/.hermes/...`) took
    // 36.7 CPU s at 8 `*` on a521a91d.
    for (const stars of [8, ...STAR_COUNTS]) {
      const word = `${"*".repeat(stars)}${"z".repeat(12)}`;
      for (const command of [
        `cat ${word}`,
        `cat ~/.hermes/${word}`,
        `echo x > ~/.hermes/${word}`,
        `echo x > ${word}`,
        `cat */${word}/x`,
        `echo x > ~/.hermes/*/${word}`,
      ]) {
        const ms = cpuMs(() => {
          classifyForHook(command, [], dir, [], false, [dir]);
        });
        assert.ok(ms < BOUND_MS * 2, `${command.slice(0, 30)} (${String(stars)} stars): ${ms.toFixed(1)} CPU ms, bound ${String(BOUND_MS * 2)}`);
      }
    }
  } finally {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
  }
});

test("cost: a run of unclosed `[` and a class of many members, through the whole classification (codex on #682)", () => {
  const { dir, home } = workspace();
  // Two hundred names of 250 characters, beside the workspace's own, in the
  // directory and in the home: what a class is tested against, character by
  // character.
  for (let index = 0; index < 200; index += 1) {
    const name = `${String(index).padStart(3, "0")}${"a".repeat(247)}`;
    writeFileSync(join(dir, name), "x\n", "utf8");
    writeFileSync(join(home, ".hermes", name), "x\n", "utf8");
  }
  const savedHome = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    // On bfa73710: `echo x >` and 20,000 `[` took 2.8 CPU s (the `.git`
    // reader scanned from every `[` to the end; #680 now reads the run once),
    // and `cat` of `*[` + 5,000 `z` + `]X` took 160 CPU ms (each character
    // tested against every member, in this change's hook reader). At most about 14 CPU ms a call here, so the bound is 7x.
    // (50,000 members took 985 CPU ms through `cat` on bfa73710 and 31 here;
    // tests/hook-glob-match bounds that size directly.)
    const words = ["[".repeat(2_000), "[".repeat(20_000), `*[${"z".repeat(5_000)}]X`];
    for (const word of words) {
      // A `cat` of a long `[` run is left out: its cost is the kernel refusing
      // a path that long (lstat through realpath, about 7 CPU ms a call,
      // the same before and after this change), not either glob reader.
      const reads = word.startsWith("*") ? [`cat ${word}`, `cat ~/.hermes/${word}`] : [];
      for (const command of [`echo x > ${word}`, `echo x > ~/.hermes/${word}`, ...reads]) {
        const ms = cpuMs(() => {
          classifyForHook(command, [], dir, [], false, [dir]);
        });
        assert.ok(ms < BOUND_MS * 2, `${command.slice(0, 30)} (${String(word.length)} characters): ${ms.toFixed(1)} CPU ms, bound ${String(BOUND_MS * 2)}`);
      }
    }
  } finally {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
  }
});
