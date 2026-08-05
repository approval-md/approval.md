/**
 * `approval policy amend` (APRV-30) — the one verb that owns the whole
 * amendment ceremony: diff, advise, confirm, attest, commit.
 *
 * ## The two incidents this verb exists to prevent
 *
 * **seq 2 of this repository's own log — the eleven-minute amendment.** A
 * policy edit was attested and superseded eleven minutes later, because the
 * edit broke a pinned dogfood assertion and nobody found out until the test
 * suite ran. The operator attested bytes whose *consequences* had never been
 * shown to them. `amend` shows the semantic diff and the load advisory BEFORE
 * asking for the sign-off, so the failure that superseded seq 2 would have been
 * on screen while the human was deciding — and with `--require-load` it would
 * have refused to attest at all.
 *
 * **The unsigned interregnum — commit `f829e6c` and its attestation.** The
 * policy-editing commit and the attestation that made the edit operative landed
 * as two separate commits. In between, the repository carried an inoperative
 * policy: `checkAttestation` said `hash-mismatch` and every gate operation
 * refused. `amend` closes that window by making the attestation and the git
 * commit one ceremony — it prints, or with `--commit` runs, the exact two-file
 * `git add` + `git commit` that lands the policy edit and its attestation
 * together, and it validates the `--commit` preconditions BEFORE it attests, so
 * a refusal can never leave a half-finished amendment behind.
 *
 * ## The baseline problem, stated plainly (FLAGGED FOR HUMAN REVIEW)
 *
 * A semantic diff needs the previously-attested policy *text*. The log does not
 * have it. An attestation records only the SHA-256 of the bytes — deliberately,
 * since the log is meant to be exported and copied and a policy body in it
 * would be a second source of truth. So the attested bytes are **not
 * recoverable from the log**, and this verb does not pretend otherwise.
 *
 * What it does instead, at v0.1: when the policy file lives in a git
 * repository, it recovers `HEAD:<path>` and hashes it. **Only if that blob's
 * hash equals the attested hash** is it used as the diff baseline — the point
 * being that we can then prove the text we are diffing against is exactly the
 * text that was signed for. Anything else (not a git repo, no such blob, or a
 * blob whose hash differs from the attestation) drops to **hash-only mode**: a
 * loud notice that the semantic diff is unavailable, followed by the load
 * advisory and the attestation, which still work. No `--baseline` flag is
 * offered; a baseline the operator supplies by hand is a baseline nobody can
 * verify, which is exactly the assurance this design refuses to fake.
 *
 * The limitation is real and worth a human's judgment: an amendment made
 * outside git, or one made on top of an unattested working-tree edit, gets no
 * semantic diff. Flagged rather than smoothed over.
 *
 * ## What this file does and does not decide
 *
 * As everywhere else in the CLI: the diff is `core/policy-diff.ts`, loading is
 * `core/policy-load.ts`, matching is `core/policy-match.ts`, hashing and the
 * append are `core/attest.ts`. This file resolves paths and identity, shells out
 * to git, decides exit codes, and formats output.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, mkdtempSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePathSegments, sep } from "node:path";

import {
  HUMAN_ACTOR_ENV,
  appendAttestation,
  checkAttestation,
  policyFileHash,
  resolveHumanActor,
} from "../core/attest.js";
import { diffPolicies, renderDiff, SPEC_NAMESPACES, type PolicyDiff } from "../core/policy-diff.js";
import { loadPolicy, POLICY_FILENAMES, type PolicyLoadResult } from "../core/policy-load.js";
import { readVerifiedRecords } from "../core/state.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import {
  EXIT_INTEGRITY,
  EXIT_IO,
  EXIT_OK,
  EXIT_TORN_TAIL,
  EXIT_USAGE,
} from "./exit-codes.js";
import { POLICY_AMEND_HELP } from "./help.js";
import type { Streams } from "./main.js";
import { DEFAULT_LOG_PATH, resolvePath } from "./paths.js";

const FLAGS: Record<string, FlagKind> = {
  "--policy": "string",
  "--dir": "string",
  "--log": "string",
  "--as": "string",
  "--require-load": "boolean",
  "--dry-run": "boolean",
  "--commit": "boolean",
  "--yes": "boolean",
  "--json": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

/** Machine-readable refusal codes. Frozen public API, printed in the help. */
type AmendErrorCode =
  | "usage"
  | "io"
  | "load-failed"
  | "commit-preconditions"
  | "git-failed"
  | "append-failed"
  | "log-unreadable"
  | "log-torn-tail"
  | "log-corrupt";

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function absolute(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolvePathSegments(cwd, value);
}

function usageError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ ok: false, error: { code: "usage", message } })}\n`);
  else streams.err(`approval: ${message}\n\n${POLICY_AMEND_HELP}\n`);
  return EXIT_USAGE;
}

function refuse(
  streams: Streams,
  json: boolean,
  code: AmendErrorCode,
  message: string,
  exitCode: number,
): number {
  if (json) streams.err(`${JSON.stringify({ ok: false, error: { code, message } })}\n`);
  else streams.err(`approval: ${message}\n`);
  return exitCode;
}

// ---------------------------------------------------------------------------
// Policy path resolution (mirrors `cli/attest.ts`, deliberately)
// ---------------------------------------------------------------------------

/**
 * Is this path a readable regular file? As in `policy attest` — and unlike
 * `policy check` — an absent policy file is an I/O error and not an answer:
 * there is no fail-closed reading of "amend a file that is not there".
 */
function readableFile(path: string): { ok: true } | { ok: false; message: string } {
  let stats;
  try {
    stats = statSync(path);
  } catch (cause) {
    return { ok: false, message: `policy ${path} could not be opened: ${detail(cause)}` };
  }
  if (stats.isDirectory()) {
    return { ok: false, message: `policy ${path} is a directory, not a policy file` };
  }
  try {
    accessSync(path, constants.R_OK);
  } catch (cause) {
    return { ok: false, message: `policy ${path} is not readable: ${detail(cause)}` };
  }
  return { ok: true };
}

/**
 * `--policy` wins outright; otherwise discovery walks `POLICY_FILENAMES` in
 * `dir` and amends whichever file discovery would have loaded — the same
 * precedence as `loadPolicy` and `policy attest`, so the amended file, the
 * attested file, and the enforced file are never three different files.
 */
function resolvePolicyPath(
  policyFlag: string | null,
  dir: string,
  cwd: string,
): { ok: true; path: string } | { ok: false; message: string } {
  if (policyFlag !== null) {
    const path = absolute(policyFlag, cwd);
    const check = readableFile(path);
    return check.ok ? { ok: true, path } : { ok: false, message: check.message };
  }
  for (const filename of POLICY_FILENAMES) {
    const candidate = join(dir, filename);
    try {
      statSync(candidate);
    } catch {
      continue;
    }
    const check = readableFile(candidate);
    return check.ok ? { ok: true, path: candidate } : { ok: false, message: check.message };
  }
  return {
    ok: false,
    message: `no policy file found in ${dir} (looked for ${POLICY_FILENAMES.join(", ")}); an amendment needs a file to hash`,
  };
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

interface GitRun {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function git(args: string[], cwd: string): GitRun {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error !== undefined || result.status === null) {
    return { ok: false, stdout: "", stderr: detail(result.error ?? "git did not run") };
  }
  return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr };
}

/** The repository root containing `dir`, or `null` when there is none. */
function repoRoot(dir: string): string | null {
  const result = git(["rev-parse", "--show-toplevel"], dir);
  if (!result.ok) return null;
  const root = result.stdout.trim();
  return root.length === 0 ? null : root;
}

/** A repo-relative, forward-slashed path, as git spells it. */
function repoPath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

/**
 * The bytes of `HEAD:<relative>`, or `null` when git has no such blob.
 *
 * Read as a Buffer, never as text: the baseline is compared by SHA-256 against
 * an attestation over exact bytes, and an encoding round-trip would silently
 * change what is being compared.
 */
function showHead(root: string, relative_: string): Buffer | null {
  const result = spawnSync("git", ["show", `HEAD:${relative_}`], { cwd: root });
  if (result.error !== undefined || result.status !== 0) return null;
  return result.stdout;
}

// ---------------------------------------------------------------------------
// Baseline recovery
// ---------------------------------------------------------------------------

/** How (and whether) the diff baseline was recovered. Frozen JSON sub-shape. */
interface Baseline {
  /** `git-head` when the attested bytes were recovered; `unavailable` otherwise. */
  mode: "git-head" | "unavailable";
  /** Why the semantic diff is unavailable; `null` in `git-head` mode. */
  reason: string | null;
}

interface BaselineOutcome {
  baseline: Baseline;
  load: PolicyLoadResult | null;
  /** Temp file holding the recovered bytes, to remove when we are done. */
  scratch: string | null;
}

/**
 * Recover the last-attested policy text, or say honestly that we cannot.
 *
 * The only accepted baseline is a `HEAD` blob whose SHA-256 equals the attested
 * hash. See the module header: an unverifiable baseline would produce a diff
 * that looks authoritative and is not.
 */
function recoverBaseline(policyPath: string, attestedSha256: string | null): BaselineOutcome {
  const unavailable = (reason: string): BaselineOutcome => ({
    baseline: { mode: "unavailable", reason },
    load: null,
    scratch: null,
  });

  if (attestedSha256 === null) {
    return unavailable(
      "the policy has never been attested, so there is no previous state to diff against",
    );
  }
  const root = repoRoot(dirname(policyPath));
  if (root === null) {
    return unavailable(
      "the policy file is not inside a git repository, and the attested BYTES are not recoverable from the log (an attestation records only their SHA-256)",
    );
  }
  const blob = showHead(root, repoPath(root, policyPath));
  if (blob === null) {
    return unavailable(`git has no HEAD:${repoPath(root, policyPath)} blob to recover`);
  }
  const blobSha256 = createHash("sha256").update(blob).digest("hex");
  if (blobSha256 !== attestedSha256) {
    return unavailable(
      `HEAD:${repoPath(root, policyPath)} hashes ${blobSha256}, which is not the attested ${attestedSha256}; a baseline nobody can verify is not a baseline`,
    );
  }

  const scratchDir = mkdtempSync(join(tmpdir(), "approval-amend-"));
  const scratch = join(scratchDir, basename(policyPath));
  writeFileSync(scratch, blob);
  return {
    baseline: { mode: "git-head", reason: null },
    load: loadPolicy({ file: scratch }),
    scratch: scratchDir,
  };
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

/** Read one line from stdin, synchronously. `null` at EOF. */
function readLine(): string | null {
  const buffer = Buffer.alloc(1);
  const chars: string[] = [];
  for (;;) {
    let read = 0;
    try {
      read = readSync(0, buffer, 0, 1, null);
    } catch {
      return chars.length === 0 ? null : chars.join("");
    }
    if (read === 0) return chars.length === 0 ? null : chars.join("");
    const char = buffer.toString("utf8");
    if (char === "\n") return chars.join("");
    if (char !== "\r") chars.push(char);
  }
}

// ---------------------------------------------------------------------------
// The verb
// ---------------------------------------------------------------------------

/** The one-line summary that becomes the commit subject. */
function summarize(policyPath: string, diff: PolicyDiff | null): string {
  const name = basename(policyPath);
  if (diff === null) return `amend ${name} (semantic diff unavailable)`;
  const parts: string[] = [];
  if (diff.classes.length > 0) parts.push(`${diff.classes.length} class resolution(s)`);
  if (diff.approvers.length > 0) parts.push(`${diff.approvers.length} approver change(s)`);
  if (diff.defaults.length > 0) parts.push(`${diff.defaults.length} default(s)`);
  if (diff.budgets.length > 0) parts.push(`${diff.budgets.length} limit(s)`);
  if (parts.length === 0) return `amend ${name} (no semantic change)`;
  return `amend ${name}: ${parts.join(", ")}`;
}

/** `approval policy amend …` — the whole ceremony, in one verb. */
export function commandPolicyAmend(argv: string[], streams: Streams, cwd: string): number {
  const json = argv.includes("--json");
  const parsed = parseFlags(argv, FLAGS);
  if (!parsed.ok) return usageError(streams, json, parsed.message);

  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${POLICY_AMEND_HELP}\n`);
    return EXIT_OK;
  }

  const extra = parsed.positionals[0];
  if (extra !== undefined) {
    return usageError(streams, json, `unexpected argument ${JSON.stringify(extra)}`);
  }

  const dryRun = boolFlag(parsed.flags, "--dry-run");
  const requireLoad = boolFlag(parsed.flags, "--require-load");
  const wantCommit = boolFlag(parsed.flags, "--commit");
  const assumeYes = boolFlag(parsed.flags, "--yes");

  // Identity first, before a byte is read: the ceremony is human-only in every
  // mode, dry runs included. Asking a human to read a diff and only then telling
  // them their sign-off cannot be attributed wastes the one resource this system
  // spends. The rules are `policy attest`'s, unchanged.
  const asFlag = stringFlag(parsed.flags, "--as");
  const actor = resolveHumanActor(asFlag === null ? {} : { actor: asFlag });
  if (actor === null) {
    return usageError(
      streams,
      json,
      asFlag === null
        ? `no human identity: set ${HUMAN_ACTOR_ENV}=human:<id> or pass --as human:<id>`
        : `--as expects a human identity matching human:<id>, got ${JSON.stringify(asFlag)}; an amendment is attested, and attestation is the one verb an agent must not perform`,
    );
  }

  const dirFlag = stringFlag(parsed.flags, "--dir");
  const dir = dirFlag === null ? cwd : absolute(dirFlag, cwd);
  const policy = resolvePolicyPath(stringFlag(parsed.flags, "--policy"), dir, cwd);
  if (!policy.ok) return refuse(streams, json, "io", policy.message, EXIT_IO);
  const policyPath = policy.path;

  let liveSha256: string;
  try {
    liveSha256 = policyFileHash(policyPath);
  } catch (cause) {
    return refuse(
      streams,
      json,
      "io",
      `policy ${policyPath} could not be read: ${detail(cause)}`,
      EXIT_IO,
    );
  }

  const logPath = resolvePath(stringFlag(parsed.flags, "--log"), DEFAULT_LOG_PATH, cwd);
  const read = readVerifiedRecords(logPath);
  if (!read.ok) {
    const exitCode =
      read.code === "log-torn-tail"
        ? EXIT_TORN_TAIL
        : read.code === "log-corrupt"
          ? EXIT_INTEGRITY
          : EXIT_IO;
    return refuse(streams, json, read.code, read.message, exitCode);
  }

  const status = checkAttestation(read.records, policyPath);
  const attested =
    status.status === "attested"
      ? { sha256: status.sha256, seq: status.seq }
      : status.status === "hash-mismatch"
        ? { sha256: status.attestedSha256, seq: status.seq }
        : null;

  // (a) Nothing to amend. A no-op ceremony is a SUCCESS, not an error: an
  // operator (or a script) that runs `amend` on an already-attested policy has
  // established exactly what they wanted to establish.
  if (status.status === "attested") {
    if (json) {
      emitReport(streams, {
        policyPath,
        liveSha256,
        attested,
        baseline: { mode: "unavailable", reason: "the live policy already matches its attestation" },
        diff: null,
        load: null,
        attestation: null,
        git: null,
        noop: true,
        dryRun,
        aborted: false,
      });
    } else {
      streams.out(
        `nothing to amend: ${policyPath} already matches its attestation at seq ${status.seq} (sha256 ${liveSha256})\n`,
      );
    }
    return EXIT_OK;
  }

  // (b) The baseline, and only a verifiable one. See the module header.
  const recovered = recoverBaseline(policyPath, attested?.sha256 ?? null);
  const liveLoad = loadPolicy({ file: policyPath });
  const diff =
    recovered.load === null
      ? null
      : diffPolicies(recovered.load, liveLoad, SPEC_NAMESPACES);
  if (recovered.scratch !== null) rmSync(recovered.scratch, { recursive: true, force: true });

  // (e-pre) --commit's preconditions are checked BEFORE anything is written.
  // Refusing after the attestation would recreate the very interregnum this
  // verb exists to close: an attested policy with no commit carrying it.
  let commitPlan: { root: string; policyArg: string; logArg: string } | null = null;
  if (wantCommit && !dryRun) {
    const plan = planCommit(policyPath, logPath);
    if (!plan.ok) {
      return refuse(streams, json, "commit-preconditions", plan.message, EXIT_USAGE);
    }
    commitPlan = plan.plan;
  }

  const summary = summarize(policyPath, diff);
  const gitCommands = (seq: string): string[] => [
    `git add ${policyPath} ${logPath}`,
    `git commit -m ${JSON.stringify(`Policy: ${summary} (attested seq ${seq})`)}`,
  ];

  // (c) + (d): the report. Human output only; --json emits one object at the end.
  if (!json) {
    streams.out(`amending ${policyPath}\n`);
    streams.out(
      `live sha256 ${liveSha256}; attested ${attested === null ? "never" : `${attested.sha256} at seq ${attested.seq}`}\n`,
    );
    if (diff === null) {
      streams.out(
        `HASH-ONLY MODE: no semantic diff. ${recovered.baseline.reason ?? ""}\nThe load advisory below and the attestation still apply; what changed in MEANING is not shown, so read the file diff yourself.\n`,
      );
    } else {
      for (const line of renderDiff(diff)) streams.out(`${line}\n`);
    }
    if (liveLoad.ok) {
      streams.out("load advisory: loads clean\n");
    } else {
      streams.out(
        `LOAD ADVISORY — THIS POLICY DOES NOT LOAD (${liveLoad.code}): ${liveLoad.message}\n` +
          "Attesting it is allowed (attestation records bytes, not correctness) but it will FAIL CLOSED to all-manual for every class. This is the shape of the seq 2 incident.\n",
      );
    }
  }

  // (d) --require-load: refuse before the confirmation and before the append.
  if (!liveLoad.ok && requireLoad) {
    return refuse(
      streams,
      json,
      "load-failed",
      `--require-load: the policy does not load (${liveLoad.code}): ${liveLoad.message}; nothing was attested and the log is unchanged`,
      EXIT_INTEGRITY,
    );
  }

  // (e) Confirmation. --dry-run never asks, because it never writes.
  if (dryRun) {
    if (json) {
      emitReport(streams, {
        policyPath,
        liveSha256,
        attested,
        baseline: recovered.baseline,
        diff,
        load: loadSummary(liveLoad),
        attestation: null,
        git: { repo: repoRoot(dirname(policyPath)) !== null, commands: gitCommands("<seq>"), committed: false, output: null },
        noop: false,
        dryRun: true,
        aborted: false,
      });
    } else {
      streams.out("--dry-run: nothing was attested, nothing was written. The ceremony would run:\n");
      for (const command of gitCommands("<seq>")) streams.out(`  ${command}\n`);
    }
    return EXIT_OK;
  }

  if (!assumeYes) {
    if (json || process.stdin.isTTY !== true) {
      return usageError(
        streams,
        json,
        "amend needs a confirmation it cannot ask for: stdin is not a terminal (or --json was given). Re-run with --yes to confirm non-interactively, or --dry-run to see the report without writing anything",
      );
    }
    streams.out(`\nattest these bytes and record the amendment? [y/N] `);
    const answer = (readLine() ?? "").trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      streams.out("aborted: nothing was attested and nothing was written\n");
      return EXIT_OK;
    }
  }

  // (f) The attestation itself, through core's one sanctioned path.
  const result = appendAttestation(logPath, policyPath, actor);
  if (!result.ok) {
    const exitCode = result.error.code === "corrupt-tail" ? EXIT_TORN_TAIL : EXIT_IO;
    return refuse(streams, json, "append-failed", result.error.message, exitCode);
  }
  const seq = result.record.seq;

  // (g) The git ceremony: the two files, together, or the commands to do it.
  const commands = gitCommands(String(seq));
  let committed = false;
  let output: string | null = null;
  if (commitPlan !== null) {
    const add = git(["add", "--", commitPlan.policyArg, commitPlan.logArg], commitPlan.root);
    if (!add.ok) {
      return refuse(
        streams,
        json,
        "git-failed",
        `the attestation was appended at seq ${seq}, but \`git add\` failed: ${add.stderr.trim()}; run the two commands by hand`,
        EXIT_IO,
      );
    }
    const message = `Policy: ${summary} (attested seq ${seq})`;
    const commit = git(["commit", "-m", message, "--", commitPlan.policyArg, commitPlan.logArg], commitPlan.root);
    if (!commit.ok) {
      return refuse(
        streams,
        json,
        "git-failed",
        `the attestation was appended at seq ${seq}, but \`git commit\` failed: ${commit.stderr.trim() || commit.stdout.trim()}; run the two commands by hand`,
        EXIT_IO,
      );
    }
    committed = true;
    output = `${commit.stdout}${commit.stderr}`.trim();
  }

  if (json) {
    emitReport(streams, {
      policyPath,
      liveSha256,
      attested,
      baseline: recovered.baseline,
      diff,
      load: loadSummary(liveLoad),
      attestation: { seq, sha256: liveSha256 },
      git: { repo: commitPlan !== null || repoRoot(dirname(policyPath)) !== null, commands, committed, output },
      noop: false,
      dryRun: false,
      aborted: false,
    });
  } else {
    streams.out(`attested ${policyPath} at seq ${seq}: sha256 ${liveSha256}\n`);
    if (committed) {
      streams.out(`committed the policy and the log together:\n`);
      for (const command of commands) streams.out(`  ${command}\n`);
      if (output !== null && output.length > 0) streams.out(`${output}\n`);
    } else {
      streams.out(
        "now land the edit and its attestation as ONE commit — an attested policy whose commit does not carry the log leaves the log's readers behind:\n",
      );
      for (const command of commands) streams.out(`  ${command}\n`);
    }
  }
  return EXIT_OK;
}

/**
 * `--commit`'s preconditions.
 *
 * The amendment commit carries **exactly** the policy file and the log, so a
 * staged change to anything else is refused rather than swept in: a commit that
 * quietly carried an unrelated staged edit would make "this commit is the
 * amendment" false, and that sentence is the whole reason the commit exists.
 * Unstaged and untracked changes elsewhere are left alone — they are not going
 * into this commit.
 */
function planCommit(
  policyPath: string,
  logPath: string,
): { ok: true; plan: { root: string; policyArg: string; logArg: string } } | { ok: false; message: string } {
  const root = repoRoot(dirname(policyPath));
  if (root === null) {
    return {
      ok: false,
      message: `--commit needs a git repository and ${policyPath} is not inside one; nothing was attested`,
    };
  }
  const policyArg = repoPath(root, policyPath);
  const logArg = repoPath(root, logPath);
  if (policyArg.startsWith("../") || logArg.startsWith("../")) {
    return {
      ok: false,
      message: `--commit needs the policy (${policyPath}) and the log (${logPath}) inside the same repository (${root}); nothing was attested`,
    };
  }

  const status = git(["status", "--porcelain"], root);
  if (!status.ok) {
    return { ok: false, message: `--commit could not read git status: ${status.stderr.trim()}` };
  }
  const strays: string[] = [];
  for (const line of status.stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    const index = line[0] ?? " ";
    // Only the INDEX column matters: an unstaged or untracked file elsewhere is
    // not going into this commit, and refusing over it would make the verb
    // unusable in any working repository.
    if (index === " " || index === "?") continue;
    const path = line.slice(3).trim();
    if (path === policyArg || path === logArg) continue;
    strays.push(path);
  }
  if (strays.length > 0) {
    return {
      ok: false,
      message: `--commit refuses: the index carries ${strays.length} staged change(s) beyond the policy and the log (${strays.join(", ")}). The amendment commit carries EXACTLY those two files, so that "this commit is the amendment" stays true. Unstage them, or drop --commit and run the printed commands yourself. Nothing was attested`,
    };
  }
  return { ok: true, plan: { root, policyArg, logArg } };
}

function loadSummary(load: PolicyLoadResult): { ok: boolean; code: string | null; message: string | null } {
  return load.ok
    ? { ok: true, code: null, message: null }
    : { ok: false, code: load.code, message: load.message };
}

/** The frozen `--json` report. Every key is always present. */
interface Report {
  policyPath: string;
  liveSha256: string;
  attested: { sha256: string; seq: number } | null;
  baseline: Baseline;
  diff: PolicyDiff | null;
  load: { ok: boolean; code: string | null; message: string | null } | null;
  attestation: { seq: number; sha256: string } | null;
  git: { repo: boolean; commands: string[]; committed: boolean; output: string | null } | null;
  noop: boolean;
  dryRun: boolean;
  aborted: boolean;
}

function emitReport(streams: Streams, report: Report): void {
  streams.out(
    `${JSON.stringify({
      ok: true,
      noop: report.noop,
      dryRun: report.dryRun,
      aborted: report.aborted,
      policy: report.policyPath,
      liveSha256: report.liveSha256,
      attested: report.attested,
      baseline: report.baseline,
      diff: report.diff,
      load: report.load,
      attestation: report.attestation,
      git: report.git,
    })}\n`,
  );
}
