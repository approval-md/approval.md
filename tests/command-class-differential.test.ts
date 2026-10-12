/**
 * Differential: the APRV-508 grammars against the real tools.
 *
 * The classifier admits a `date`, `hostname`, `seq`, `paste`, `df`, `uptime`
 * or `whoami` argv on the claim that the tool will only print. That claim is
 * about somebody else's option parser, so this file asks the parsers. It
 * enumerates argvs from a token alphabet that mixes the admitted spellings
 * with the dangerous ones (`-s`, `--set`, `--se`, `-f`, `-r`, `--`, a clock
 * operand, a new host name, clusters, `=`-joined values), keeps every argv
 * the classifier ADMITS, runs each against every real implementation it can
 * find, and checks the tool did nothing the grammar says it cannot do:
 *
 * - `date`: no attempt to set the clock (stderr naming a set, or a refusal to
 *   set), and no file opened (a path under a mode-000 directory is in the
 *   alphabet, so any open of it fails loudly with "Permission denied");
 * - `hostname`: no attempt to set the host name, and no file opened;
 * - `seq`, `paste`, `df`, `uptime`, `whoami`: the tool accepts the argv
 *   (exit 0). An admitted argv the tool rejects means the grammar and the tool
 *   parse it differently, which is the bug class this file exists for.
 *
 * Only admitted argvs are run, never the refused ones, with two exceptions
 * that prove the oracle can see what it looks for: `date -s now` (a set to
 * the current time, refused by the kernel for a non-root user) and `date -r`
 * of the locked canary. Nothing runs as root: the whole file skips under uid
 * 0, because an admitted argv that the grammar got wrong would then really
 * set the clock.
 *
 * Implementations: GNU coreutils (`date` on Linux, `gdate`/`gseq`/… from
 * Homebrew on macOS) and uutils coreutils, which the hosted boxes run, through
 * `APPROVAL_DIFF_UUTILS=/path/to/coreutils` (the multicall binary; build it
 * with `cargo install coreutils@0.10.0 --root <dir> --no-default-features
 * --features "date hostname df seq paste uptime whoami"`). A tool that is not
 * found is skipped and named in the skip reason; no implementation at all
 * skips the test rather than passing it.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { classifyCommand } from "../src/core/command-class.js";

interface Impl {
  label: string;
  /** argv prefix: `[gdate]`, or `[coreutils, date]` for the multicall. */
  prefix: string[];
}

const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

const work = mkdtempSync(join(tmpdir(), "approval-md-diff-"));
mkdirSync(join(work, "locked"));
writeFileSync(join(work, "locked", "canary"), "canary\n");
writeFileSync(join(work, "a.txt"), "1\n2\n");
writeFileSync(join(work, "b.txt"), "x\ny\n");
chmodSync(join(work, "locked"), 0o000);

after(() => {
  chmodSync(join(work, "locked"), 0o700);
  rmSync(work, { recursive: true, force: true });
});

function runs(argv: readonly string[], args: readonly string[] = ["--version"]): boolean {
  const result = spawnSync(argv[0] as string, [...argv.slice(1), ...args], { encoding: "utf8", timeout: 5000 });
  return result.status === 0;
}

/** Every implementation of `name` this machine has. */
function implementations(name: string): Impl[] {
  const found: Impl[] = [];
  const uutils = process.env["APPROVAL_DIFF_UUTILS"];
  if (uutils !== undefined && uutils !== "" && runs([uutils, name])) {
    found.push({ label: `uutils ${name}`, prefix: [uutils, name] });
  }
  for (const candidate of [`g${name}`, name]) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 5000 });
    if (probe.status === 0 && /GNU (coreutils|inetutils)|net-tools|procps/u.test(probe.stdout)) {
      found.push({ label: `${candidate} (${probe.stdout.split("\n")[0] ?? ""})`, prefix: [candidate] });
      break;
    }
  }
  return found;
}

function shellQuote(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(word) ? word : `'${word.replace(/'/gu, `'\\''`)}'`;
}

/** Does the classifier admit `name args` as a plain read? */
function admitted(name: string, args: readonly string[]): boolean {
  const result = classifyCommand([name, ...args].map(shellQuote).join(" "));
  return result.ok && result.classes.length === 1 && result.classes[0] === "read.shell";
}

/** Every argv of length 0..max over the alphabet. */
function* argvs(alphabet: readonly string[], max: number): Generator<string[]> {
  yield [];
  let frontier: string[][] = [[]];
  for (let length = 1; length <= max; length += 1) {
    const next: string[][] = [];
    for (const prefix of frontier) {
      for (const token of alphabet) {
        const argv = [...prefix, token];
        next.push(argv);
        yield argv;
      }
    }
    frontier = next;
  }
}

function run(impl: Impl, args: readonly string[]): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync(impl.prefix[0] as string, [...impl.prefix.slice(1), ...args], {
    cwd: work,
    encoding: "utf8",
    input: "",
    timeout: 5000,
    env: { PATH: process.env["PATH"] ?? "", LC_ALL: "C" },
  });
  return { status: result.status, stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
}

/**
 * stderr that says the tool tried to change the system, or tried to open the
 * canary (under a mode-000 directory, so any open of it is "Permission
 * denied"). Echoing the canary's NAME back is not an open: `date -d
 * locked/canary` reports an invalid date string and touches nothing.
 */
const SET_ATTEMPT = /\bset|not permitted|not supported|permission denied/iu;

/**
 * Two alphabets, so the run stays a few seconds: every pair over the wide one,
 * every triple over the narrow one (the spellings most likely to hide a set or
 * a file read behind an admitted prefix).
 */
const DATE_ALPHABET: readonly string[] = [
  "-u", "-R", "-uR", "-ud", "-d", "-du", "-us", "-su", "-I", "-Iseconds", "-Iu", "-Ins",
  "--iso-8601", "--iso-8601=seconds", "--rfc-3339", "--rfc-3339=seconds", "seconds",
  "--date", "--date=now", "-d=now", "now", "@0", "+%s", "+%F", "0101", "0101000026",
  "-s", "--set", "--se", "--set=now", "-f", "--file", "-r", "--reference", "--ref",
  "locked/canary", "--", "-h", "-V", "--debug", "--resolution", "--utc", "--u", "--rfc-email",
];

const DATE_ALPHABET_NARROW: readonly string[] = [
  "-u", "-ud", "-d", "now", "+%s", "0101", "-s", "--set", "-f", "-r", "locked/canary", "--", "--date",
];

const HOSTNAME_ALPHABET: readonly string[] = [
  "-s", "-f", "-d", "-i", "-I", "--short", "--fqdn", "--domain", "--ip-address", "--fq", "--sh",
  "-sf", "-F", "--file", "-b", "--boot", "--", "newname", "locked/canary", "--help", "--version",
];

test("APRV-508 differential: no admitted date argv sets the clock or opens a file", (t) => {
  if (IS_ROOT) return t.skip("runs real tools; refused under uid 0");
  const impls = implementations("date");
  if (impls.length === 0) return t.skip("no GNU or uutils date found");
  let checked = 0;
  for (const impl of impls) {
    // The oracle sees what it looks for, or this test proves nothing.
    assert.match(run(impl, ["-s", "now"]).stderr, SET_ATTEMPT, `${impl.label}: the set oracle is blind`);
    assert.match(run(impl, ["-r", "locked/canary"]).stderr, SET_ATTEMPT, `${impl.label}: the file oracle is blind`);
    const seen = new Set<string>();
    for (const args of [...argvs(DATE_ALPHABET, 2), ...argvs(DATE_ALPHABET_NARROW, 3)]) {
      const key = JSON.stringify(args);
      if (seen.has(key) || !admitted("date", args)) continue;
      seen.add(key);
      const out = run(impl, args);
      assert.doesNotMatch(out.stderr, SET_ATTEMPT, `${impl.label} date ${args.join(" ")}: ${out.stderr}`);
      checked += 1;
    }
  }
  assert.ok(checked > 0);
  t.diagnostic(`${String(checked)} admitted date argvs run against ${impls.map((i) => i.label).join(", ")}`);
});

test("APRV-508 differential: no admitted hostname argv sets the name or opens a file", (t) => {
  if (IS_ROOT) return t.skip("runs real tools; refused under uid 0");
  const impls = implementations("hostname");
  if (impls.length === 0) return t.skip("no GNU, net-tools or uutils hostname found");
  let checked = 0;
  for (const impl of impls) {
    for (const args of argvs(HOSTNAME_ALPHABET, 2)) {
      if (!admitted("hostname", args)) continue;
      const out = run(impl, args);
      assert.doesNotMatch(out.stderr, SET_ATTEMPT, `${impl.label} hostname ${args.join(" ")}: ${out.stderr}`);
      checked += 1;
    }
  }
  assert.ok(checked > 0);
  t.diagnostic(`${String(checked)} admitted hostname argvs run against ${impls.map((i) => i.label).join(", ")}`);
});

const ACCEPTS: ReadonlyArray<readonly [string, readonly string[], number]> = [
  ["seq", ["1", "3", "-5", "0.5", "-w", "-s", ",", "-f", "%g", "--", "0x10", "--format=%.1f", "--separator=:"], 3],
  // Every operand in this alphabet is a file that exists (or `-`): a missing
  // file is the tool refusing a read, not a parse difference.
  ["paste", ["a.txt", "b.txt", "-", "-s", "-d,", "-d", "--delimiters=:", "-z", "--", "--serial", "--de=,"], 3],
  ["df", ["-h", "-T", "-hT", "-i", "-k", "--total", "-P", "/", "--", "-x"], 2],
  ["uptime", ["--version", "--help", "-p", "x"], 1],
  ["whoami", ["--version", "--help", "x"], 1],
];

for (const [name, alphabet, depth] of ACCEPTS) {
  test(`APRV-508 differential: the real ${name} accepts every argv the grammar admits`, (t) => {
    if (IS_ROOT) return t.skip("runs real tools; refused under uid 0");
    const impls = implementations(name);
    if (impls.length === 0) return t.skip(`no GNU or uutils ${name} found`);
    let checked = 0;
    for (const impl of impls) {
      for (const args of argvs(alphabet, depth)) {
        if (!admitted(name, args)) continue;
        // `paste -` and `paste` read standard input; give them an empty one.
        const out = run(impl, args);
        assert.equal(
          out.status,
          0,
          `${impl.label} ${name} ${args.join(" ")} was admitted but the tool rejected it: ${out.stderr}`,
        );
        assert.doesNotMatch(out.stderr, /permission denied/iu, `${impl.label} ${name} ${args.join(" ")}`);
        checked += 1;
      }
    }
    assert.ok(checked > 0);
    t.diagnostic(`${String(checked)} admitted ${name} argvs run against ${impls.map((i) => i.label).join(", ")}`);
  });
}
