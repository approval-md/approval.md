/**
 * `approval policy amend` (APRV-30) — the one verb that owns the whole
 * amendment ceremony: diff, advise, confirm, attest, commit.
 *
 * ## The two incidents this verb exists to prevent
 *
 * **seq 2 of this repository's own log — the seven-minute amendment.** A
 * policy edit was attested and superseded seven minutes later (seq 2 at
 * 11:56:07Z, seq 3 at 12:03:35Z), because the
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
import { accessSync, constants, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
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
import { readLineFromStdin } from "./prompt.js";
import {
  refusal as renderRefusal,
  relPath,
  runbook,
  shortHash,
  style,
  type RunbookStep,
  type TableRow,
} from "./style.js";
import { usageErrorText } from "./usage.js";

const FLAGS: Record<string, FlagKind> = {
  "--policy": "string",
  "--dir": "string",
  "--log": "string",
  "--as": "string",
  "--require-load": "boolean",
  "--dry-run": "boolean",
  "--commit": "boolean",
  "--no-publish": "boolean",
  "--branch": "string",
  "--direct": "boolean",
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
  | "push-rejected"
  | "pr-failed"
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
  else streams.err(usageErrorText(message, POLICY_AMEND_HELP));
  return EXIT_USAGE;
}

/**
 * A refusal, on both surfaces.
 *
 * `message` is the FROZEN machine surface: it is what `--json` carries and what
 * the tests pin. `human` (APRV-129) is an alternative rendering of the same
 * facts for a terminal, the runbook shape, for the refusals a human has to act
 * on step by step. Passing it changes nothing a machine reads.
 */
function refuse(
  streams: Streams,
  json: boolean,
  code: AmendErrorCode,
  message: string,
  exitCode: number,
  human?: string,
  /**
   * The ceremony's own outcome, ADDITIVE (APRV-130). A refusal that arrives
   * AFTER the attestation is a refusal of a sub-step, and a machine caller has
   * to be able to see that split without parsing the message: `ceremony` and
   * `publishing` ride alongside the frozen `{ok:false,error:{…}}`, never
   * inside it.
   */
  extra?: Record<string, unknown>,
): number {
  if (json) {
    streams.err(`${JSON.stringify({ ok: false, error: { code, message }, ...extra })}\n`);
  } else if (human !== undefined) streams.err(`${human}\n`);
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
// Branch protection (APRV-92)
// ---------------------------------------------------------------------------

/**
 * What we know about the default branch's protection.
 *
 * `unknown` is a first-class answer and the reason this whole probe can never
 * fail the command: `gh` may be absent, the remote may not be GitHub, the token
 * may lack the scope that reads protection. An amendment that has already been
 * attested must not be held hostage to a network call, so every failure here
 * resolves to `unknown` and the ceremony continues on the direct path, which is
 * exactly what it did before this flag existed.
 */
type Protection = "protected" | "unprotected" | "unknown";

interface ProtectionProbe {
  protection: Protection;
  defaultBranch: string | null;
  currentBranch: string | null;
  /** Why we answered what we answered, in one clause, for the JSON report. */
  reason: string;
}

/** The checked-out branch, or `null` on a detached HEAD. */
function currentBranch(root: string): string | null {
  const result = git(["symbolic-ref", "--quiet", "--short", "HEAD"], root);
  if (!result.ok) return null;
  const name = result.stdout.trim();
  return name.length === 0 ? null : name;
}

/**
 * The remote's default branch, from `refs/remotes/origin/HEAD` when the clone
 * recorded one, else from `gh`. Both are read-only lookups.
 */
function defaultBranchOf(root: string): string | null {
  const symbolic = git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], root);
  if (symbolic.ok) {
    const name = symbolic.stdout.trim().replace(/^origin\//u, "");
    if (name.length > 0) return name;
  }
  const view = spawnSync("gh", ["repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"], {
    cwd: root,
    encoding: "utf8",
  });
  if (view.error === undefined && view.status === 0) {
    const name = view.stdout.trim();
    if (name.length > 0) return name;
  }
  return null;
}

/**
 * Ask GitHub whether the default branch is protected.
 *
 * `gh api …/protection` answers 200 for a protected branch and 404 for an
 * unprotected one, which is the only distinction this verb needs. Anything else
 * (gh absent, not a GitHub remote, an unauthenticated or under-scoped token) is
 * `unknown`.
 */
function probeProtection(root: string): ProtectionProbe {
  const branch = currentBranch(root);
  const target = defaultBranchOf(root);
  if (target === null) {
    return {
      protection: "unknown",
      defaultBranch: null,
      currentBranch: branch,
      reason: "no default branch could be resolved (no origin/HEAD and no gh answer)",
    };
  }
  const probe = spawnSync(
    "gh",
    ["api", `repos/{owner}/{repo}/branches/${target}/protection`, "--silent"],
    { cwd: root, encoding: "utf8" },
  );
  if (probe.error !== undefined || probe.status === null) {
    return {
      protection: "unknown",
      defaultBranch: target,
      currentBranch: branch,
      reason: "gh is not on PATH, so branch protection could not be read",
    };
  }
  if (probe.status === 0) {
    return {
      protection: "protected",
      defaultBranch: target,
      currentBranch: branch,
      reason: `gh reports branch protection on ${target}`,
    };
  }
  const stderr = `${probe.stderr}`;
  if (/404|Branch not protected|Not Found/iu.test(stderr)) {
    return {
      protection: "unprotected",
      defaultBranch: target,
      currentBranch: branch,
      reason: `gh reports no branch protection on ${target}`,
    };
  }
  return {
    protection: "unknown",
    defaultBranch: target,
    currentBranch: branch,
    reason: `gh could not read protection on ${target}: ${stderr.trim().split("\n")[0] ?? "no detail"}`,
  };
}

/** Does this repository have an `origin` to push to? */
function hasOrigin(root: string): boolean {
  return git(["remote", "get-url", "origin"], root).ok;
}

/**
 * Everything git said about a failed push, on one line (APRV-111).
 *
 * A rejection's useful text is spread over four lines — the remote's own
 * message, the `! [remote rejected]` line, and git's summary — and the refusal
 * that carries it is a single message string. They are joined rather than
 * trimmed to the first line, because "which ref, rejected by what" lives in
 * different lines depending on who did the rejecting.
 */
function pushFailureText(run: GitRun): string {
  const lines = commandOutputLines(run.stderr, run.stdout);
  return lines.length === 0 ? "git printed nothing" : lines.join(" | ");
}

/**
 * The same output, kept as LINES (APRV-129).
 *
 * The joined form above exists because a `--json` message is one string. A
 * terminal has no such constraint, and the remote's own four lines are exactly
 * the part the reader needs to see as the remote wrote them, indented under the
 * headline rather than folded into a sentence.
 */
function commandOutputLines(...texts: readonly string[]): string[] {
  return texts
    .join("\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Why the pull request is merged with a merge commit, in one line (APRV-129).
 *
 * It used to be an inline essay in the middle of the recovery commands. The
 * reasoning did not get shorter; it moved to the reference, and what stays here
 * is the rule and where to read about it.
 */
const MERGE_COMMIT_LINE =
  "why a MERGE COMMIT: the policy edit and its attestation stay one commit on main (docs/cli-reference.md, `policy amend`)";

/**
 * How a local branch gets back onto its remote, safely (APRV-129).
 *
 * This line replaces a `git reset --hard origin/<branch>` that the recovery
 * used to end on. With an uncommitted working log, a hard reset rewinds
 * `events.jsonl` underneath the daemon that is appending to it: the fork
 * mechanism, printed as advice. APRV-125 turned the safe sequence into a verb,
 * so what this points at is a command now rather than a runbook.
 */
const LOG_SAFE_PULL_LINE =
  "then `approval log sync` rather than a pull: it holds the append lock, snapshots the log, fast-forwards and reconciles the chain (a hard reset would rewind the working log under the daemon)";

/** Is `gh` runnable at all? Used to decide whether the PR is opened or printed. */
function ghAvailable(root: string): boolean {
  const probe = spawnSync("gh", ["--version"], { cwd: root, encoding: "utf8" });
  return probe.error === undefined && probe.status === 0;
}

/** `gh`, run the way {@link git} runs git: never throws, always answers. */
function gh(args: string[], cwd: string): GitRun {
  const result = spawnSync("gh", args, { cwd, encoding: "utf8" });
  if (result.error !== undefined || result.status === null) {
    return { ok: false, stdout: "", stderr: detail(result.error ?? "gh did not run") };
  }
  return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr };
}

/** The last URL `gh` printed, which is where `gh pr create` puts the PR. */
function lastUrl(text: string): string | null {
  const urls = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("http"));
  return urls[urls.length - 1] ?? null;
}

/**
 * How a pull request is named to a human: `#7` when the URL carries a number,
 * the URL itself otherwise. "PR #7 opened" is the sentence the operator repeats
 * back; a bare URL is not.
 */
function prLabel(url: string | null): string {
  if (url === null) return "the pull request";
  const number = /\/pull\/(\d+)/u.exec(url)?.[1];
  return number === undefined ? url : `PR #${number}`;
}

/** The pull request title. It names the seq, so the PR is findable from the log. */
function prTitle(summary: string, seq: string): string {
  return `Policy: ${summary} (attested seq ${seq})`;
}

/**
 * The pull request body: the one-commit rule, and the merge instruction.
 *
 * One line on purpose. It is printed inside a `gh pr create --body "…"` command
 * the human may copy, and a body with embedded newlines does not survive that
 * copy intact.
 */
function prBody(seq: string): string {
  return (
    `This branch carries exactly one commit: the policy edit and the attestation (seq ${seq}) that names its hash. ` +
    "They have to stay together on main, because a main that carries the policy without its attestation is a main where every gate operation refuses. " +
    "Merge with a MERGE COMMIT so the policy edit and its attestation stay one commit on main. " +
    "A squash or a rebase would also keep the two files together; a merge commit is the convention here, because it puts the attested commit itself on main with the hash the attestation names."
  );
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
  if (diff.vocabulary.length > 0) parts.push(`${diff.vocabulary.length} policy key(s)`);
  if (parts.length === 0) return `amend ${name} (no semantic change)`;
  return `amend ${name}: ${parts.join(", ")}`;
}

/** `approval policy amend …` — the whole ceremony, in one verb. */
export function commandPolicyAmend(argv: string[], streams: Streams, cwd: string): number {
  const json = argv.includes("--json");
  // Asked BEFORE anything is printed, which is what makes `--json` an absolute
  // veto on colour for this process (see `style.ts`'s header).
  const st = style({ json });
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
  // APRV-130: the ceremony publishes by default (push, and on a protected main
  // branch + push + PR). `--no-publish` is the operator who wants it to stop at
  // the commit, which is what `--commit` did before the publishing half existed.
  const noPublish = boolFlag(parsed.flags, "--no-publish");
  const assumeYes = boolFlag(parsed.flags, "--yes");
  const branchFlag = stringFlag(parsed.flags, "--branch");
  const forceDirect = boolFlag(parsed.flags, "--direct");
  if (branchFlag !== null && forceDirect) {
    return usageError(
      streams,
      json,
      "--branch and --direct ask for opposite ceremonies; pass one of them, or neither and let the protection probe decide",
    );
  }
  if (branchFlag !== null && branchFlag.trim().length === 0) {
    return usageError(streams, json, "--branch expects a branch name");
  }

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
        `nothing to amend: ${relPath(policyPath, cwd)} already matches its attestation at seq ${status.seq} (sha256 ${shortHash(liveSha256)})\n`,
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

  // (e-pre) Which ceremony this is: the direct one (commit on the branch you
  // are standing on and push it) or the branch one (branch, commit, push, PR).
  //
  // PRECEDENCE, stated once and documented in the help: --branch <name> forces
  // the branch flow and names the branch; --direct forces the direct flow; the
  // two together are a usage error. With neither, the protection probe decides,
  // and it chooses the branch flow only when the default branch is protected
  // AND that default branch is the one currently checked out. An `unknown`
  // probe (no gh, no GitHub remote, no network) is the direct flow, which is
  // what this verb did before protection was detected at all.
  const amendRoot = repoRoot(dirname(policyPath));
  const probe: ProtectionProbe =
    amendRoot === null
      ? {
          protection: "unknown",
          defaultBranch: null,
          currentBranch: null,
          reason: "the policy file is not inside a git repository",
        }
      : probeProtection(amendRoot);
  const onProtectedDefault =
    probe.protection === "protected" &&
    probe.currentBranch !== null &&
    probe.currentBranch === probe.defaultBranch;
  const useBranch = branchFlag !== null || (!forceDirect && onProtectedDefault);
  const branchName = (seq: string): string => branchFlag ?? `policy-amend-${seq}`;
  // The direct flow's push is about to hit a protected branch. Say so before
  // the human types it, rather than after GitHub says it.
  const pushWarning =
    !useBranch && onProtectedDefault
      ? `${probe.defaultBranch ?? "the default branch"} is protected: this push will be rejected; use --branch`
      : null;

  // --commit's preconditions are checked BEFORE anything is written. Refusing
  // after the attestation would recreate the very interregnum this verb exists
  // to close: an attested policy with no commit carrying it.
  let commitPlan: { root: string; policyArg: string; logArg: string } | null = null;
  if (wantCommit && !dryRun) {
    const plan = planCommit(policyPath, logPath, useBranch ? { branch: branchFlag } : null);
    if (!plan.ok) {
      return refuse(streams, json, "commit-preconditions", plan.message, EXIT_USAGE);
    }
    commitPlan = plan.plan;
  }

  /**
   * The same command, with the two long absolute paths written the way the
   * operator would type them.
   *
   * This is a HUMAN transform and nothing else: `--json`'s `git.commands` keeps
   * the absolute forms, because a machine reading that array has no cwd to
   * resolve against. `git` itself resolves a relative pathspec against the
   * process's cwd, so the printed line is still the line that works.
   */
  const humanCommand = (command: string): string =>
    command.split(policyPath).join(relPath(policyPath, cwd)).split(logPath).join(relPath(logPath, cwd));

  /** A `Label` heading with its body indented under it, then a blank line. */
  const section = (label: string, body: readonly string[]): void => {
    if (body.length === 0) return;
    streams.out(`${st.heading(label)}\n`);
    for (const entry of body) {
      for (const line of entry.split("\n")) streams.out(line === "" ? "\n" : `  ${line}\n`);
    }
    streams.out("\n");
  };

  const summary = summarize(policyPath, diff);
  const commitCommands = (seq: string): string[] => [
    `git add ${policyPath} ${logPath}`,
    `git commit -m ${JSON.stringify(`Policy: ${summary} (attested seq ${seq})`)}`,
  ];
  const gitCommands = (seq: string): string[] => {
    if (useBranch) {
      return [
        `git checkout -b ${branchName(seq)}`,
        ...commitCommands(seq),
        `git push -u origin ${branchName(seq)}`,
        `gh pr create --title ${JSON.stringify(prTitle(summary, seq))} --body ${JSON.stringify(prBody(seq))}`,
      ];
    }
    return amendRoot === null
      ? commitCommands(seq)
      : [...commitCommands(seq), `git push origin ${probe.currentBranch ?? "HEAD"}`];
  };

  /**
   * The paragraph a first-time operator reads: two sentences of why, then the
   * commands for their situation. It is printed whenever the verb did not run
   * the commands itself.
   */
  const whyOneCommit = (): string[] => {
    const lines = [
      st.muted(
        "The policy bytes and the attestation that names their hash have to land in the same commit.",
      ),
      st.muted(
        "If they land separately, then for as long as the gap lasts the branch carries a policy no attestation covers, and every gate operation refuses until the second commit arrives.",
      ),
      "",
    ];
    if (useBranch) {
      lines.push(
        `${probe.protection === "protected" ? `${probe.defaultBranch ?? "the default branch"} is protected, so the commit goes onto a branch and reaches main through a pull request` : "This amendment goes onto a branch and reaches main through a pull request"}. Run these, in order:`,
      );
    } else {
      if (pushWarning !== null) lines.push(`${st.fail("WARNING:")} ${pushWarning}`);
      lines.push("Run these, in order:");
    }
    return lines;
  };

  // (c) + (d): the report. Human output only; --json emits one object at the end.
  if (!json) {
    // `Policy` / `Changes` / `Load`, with the changed resolutions as the visual
    // centre (APRV-93). The two 64-hex digests that made the old first screen
    // unreadable are twelve characters each here; the full values are one
    // `--json` away, and that is the copy a machine should be comparing anyway.
    const identity: TableRow[] = [
      { left: "file", right: relPath(policyPath, cwd) },
      { left: "live", right: shortHash(liveSha256) },
      {
        left: "attested",
        right:
          attested === null
            ? "never"
            : `${shortHash(attested.sha256)}  ${st.muted(`(seq ${attested.seq})`)}`,
      },
    ];
    section("Policy", [st.table(identity)]);

    section(
      "Changes",
      diff === null
        ? [
            `${st.warn("HASH-ONLY MODE:")} no semantic diff. ${recovered.baseline.reason ?? ""}`,
            st.muted(
              "The load advisory below and the attestation still apply; what changed in MEANING is not shown, so read the file diff yourself.",
            ),
          ]
        : renderDiff(diff),
    );

    section(
      "Load",
      liveLoad.ok
        ? [`${st.glyph("ok")} loads clean`]
        : [
            // APRV-102: glyph, CODE, message — the order every other refusal in
            // this CLI uses. `DOES NOT LOAD` sat where the machine-readable code
            // belongs and pushed the code into a parenthesis, so the one token a
            // reader greps for was the one thing not in the scannable column.
            renderRefusal(st, liveLoad.code, `the policy does not load: ${liveLoad.message}`),
            st.muted(
              "Attesting it is allowed (attestation records bytes, not correctness) but it will FAIL CLOSED to all-manual for every class. This is the shape of the seq 2 incident.",
            ),
          ],
    );
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

  /** The `git` sub-object of the JSON report. Every key is always present. */
  const gitReport = (over: {
    commands: string[];
    committed: boolean;
    pushed: boolean;
    prUrl: string | null;
    output: string | null;
    branch: string | null;
  }): GitReport => ({
    repo: amendRoot !== null,
    protection: probe.protection,
    protectionReason: probe.reason,
    defaultBranch: probe.defaultBranch,
    currentBranch: probe.currentBranch,
    flow: useBranch ? "branch" : "direct",
    warning: pushWarning,
    ...over,
  });

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
        git: gitReport({
          commands: gitCommands("<seq>"),
          committed: false,
          pushed: false,
          prUrl: null,
          output: null,
          branch: useBranch ? branchName("<seq>") : null,
        }),
        noop: false,
        dryRun: true,
        aborted: false,
      });
    } else {
      section("Would run", [
        `${st.warn("--dry-run:")} nothing was attested, nothing was written. The ceremony would run:`,
        "",
        ...whyOneCommit(),
        "",
        ...gitCommands("<seq>").map((command) => `  ${st.value(humanCommand(command))}`),
        ...(useBranch
          ? [
              "",
              "Merge that pull request with a MERGE COMMIT, so the policy edit and its attestation stay one commit on main.",
            ]
          : []),
      ]);
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
    const answer = (readLineFromStdin() ?? "").trim().toLowerCase();
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

  // (f2) SUCCESS FIRST (APRV-130).
  //
  // The incident: a re-tighten ceremony attested correctly — the one act only a
  // human can perform, done — and the terminal opened with the word REJECTED,
  // because the convenience push that follows had been refused by branch
  // protection. The reader was told their signature had failed when what had
  // failed was a `git push`.
  //
  // So the achievement is printed HERE, the moment it is true, before a single
  // git command runs. Everything after it is logistics: it can fail, it is
  // reported where it fails, and it prints beneath a line that already says the
  // policy is operative. A failure word may headline a SUB-STEP; it may never
  // headline a ceremony whose attestation landed.
  if (!json) {
    streams.out(`${st.glyph("ok")} attested seq ${String(seq)} — the policy is operative\n`);
    for (const line of st
      .table([
        { left: "file", right: relPath(policyPath, cwd) },
        { left: "sha256", right: shortHash(liveSha256) },
      ])
      .split("\n")) {
      streams.out(`  ${line}\n`);
    }
    streams.out("\n");
  }

  // (g) The git ceremony: the two files, together, or the commands to do it.
  const commands = gitCommands(String(seq));
  const branch = useBranch ? branchName(String(seq)) : null;
  let committed = false;
  let pushed = false;
  let prUrl: string | null = null;
  let output: string | null = null;

  /**
   * What the publishing half did, for the machine and for the terminal
   * (APRV-130).
   *
   * `attested` is deliberately NOT a key of this object and not a rename of the
   * report's existing top-level `attested` (which is, and stays, the PREVIOUS
   * attestation this amendment moved from). The new boolean lives on
   * `ceremony`, so both facts keep their names.
   */
  const publishing: PublishingReport = {
    attempted: false,
    complete: false,
    via: "none",
    branch: null,
    pushed: false,
    prUrl: null,
    autoMerge: "not-attempted",
    steps: [],
    stoppedAt: null,
    reason: null,
  };

  /** The `Publishing` section, accumulated as the steps run and flushed once. */
  const publishLines: string[] = [];
  let publishFlushed = false;
  const note = (line: string): void => {
    if (!json) publishLines.push(line);
  };
  const quoteUnder = (run: GitRun): void => {
    for (const line of commandOutputLines(run.stderr, run.stdout)) note(`    ${st.muted(line)}`);
  };
  const flushPublishing = (): void => {
    if (json || publishFlushed || publishLines.length === 0) return;
    publishFlushed = true;
    section("Publishing", publishLines);
  };
  /** The additive `--json` half of the same, for every exit after the append. */
  const ceremonyJson = (): Record<string, unknown> => ({
    ceremony: { attested: true, seq },
    publishing,
  });

  /**
   * A `git-failed` refusal, as a runbook (APRV-129).
   *
   * The machine message is unchanged. What the terminal gets instead is the
   * state (the attestation happened; the commit did not) and the commands that
   * are STILL OWED, one per line — which is what "run the printed commands by
   * hand" was asking for without ever printing them next to the failure.
   */
  const gitFailed = (
    what: string,
    failure: string,
    message: string,
    remaining: readonly string[],
  ): number =>
    refuse(
      streams,
      json,
      "git-failed",
      message,
      EXIT_IO,
      runbook(st, "git-failed", `\`${what}\` failed; the attestation is already appended`, {
        quote: commandOutputLines(failure),
        state: [
          `attestation appended at seq ${seq}: it is in the log, on disk`,
          "NOT committed: the policy edit and its attestation are working-tree changes",
          "NOT on origin: origin still carries the previous policy",
        ],
        steps: remaining.map((command) => ({ command: humanCommand(command) })),
        footer: [
          "these two files land in ONE commit: a main carrying the policy without its attestation refuses every gate operation",
        ],
      }),
      ceremonyJson(),
    );

  /**
   * The publishing half stopped at one of its own steps (APRV-130).
   *
   * `owed` is the WHOLE recovery, in order, and `index` the step that failed:
   * the runbook is rendered from there, so the reader is never handed a command
   * this verb already ran successfully. That slice is the entire relationship
   * between the automatic path and the APRV-129 runbook — the runbook is what
   * automation degrades INTO, at the exact point it ran out.
   */
  const stalled = (
    code: AmendErrorCode,
    headline: string,
    failure: GitRun,
    message: string,
    state: readonly string[],
    owed: readonly RunbookStep[],
    index: number,
    footer: readonly string[],
  ): number => {
    note(`${st.glyph("fail")} ${headline}`);
    quoteUnder(failure);
    note(st.muted("the automatic path stopped here; what is still owed is printed below"));
    publishing.stoppedAt = owed[index]?.command ?? null;
    publishing.reason = commandOutputLines(failure.stderr, failure.stdout)[0] ?? null;
    flushPublishing();
    return refuse(
      streams,
      json,
      code,
      message,
      EXIT_IO,
      runbook(st, code, headline, {
        quote: commandOutputLines(failure.stderr, failure.stdout),
        state,
        steps: owed.slice(index),
        footer,
      }),
      ceremonyJson(),
    );
  };

  /**
   * `gh pr merge --auto`, which is allowed to say no.
   *
   * A merge queue, a repository with auto-merge disabled, a PR that is already
   * mergeable: `--auto` refuses all three, and none of them is a failure of the
   * ceremony. The pull request is open either way, so a refusal reports the PR
   * and stops — still inside the success framing.
   */
  const armAutoMerge = (root: string, target: string): void => {
    const merge = gh(["pr", "merge", target, "--merge", "--auto"], root);
    publishing.steps.push({ command: `gh pr merge ${target} --merge --auto`, ok: merge.ok });
    if (merge.ok) {
      publishing.autoMerge = "armed";
      note(
        `${st.glyph("ok")} auto-merge armed: ${prLabel(publishing.prUrl)} lands on ${probe.defaultBranch ?? "the default branch"} as a merge commit when CI is green`,
      );
      return;
    }
    publishing.autoMerge = "refused";
    const why = commandOutputLines(merge.stderr, merge.stdout)[0];
    note(
      `${prLabel(publishing.prUrl)} is open — merge it with a MERGE COMMIT when CI is green. auto-merge was not armed${why === undefined ? "" : `: ${why}`}`,
    );
  };

  if (commitPlan !== null) {
    if (branch !== null) {
      const checkout = git(["checkout", "-b", branch], commitPlan.root);
      if (!checkout.ok) {
        return gitFailed(
          `git checkout -b ${branch}`,
          checkout.stderr.trim(),
          `the attestation was appended at seq ${seq}, but \`git checkout -b ${branch}\` failed: ${checkout.stderr.trim()}; run the printed commands by hand`,
          commands,
        );
      }
    }
    const add = git(["add", "--", commitPlan.policyArg, commitPlan.logArg], commitPlan.root);
    if (!add.ok) {
      return gitFailed(
        "git add",
        add.stderr.trim(),
        `the attestation was appended at seq ${seq}, but \`git add\` failed: ${add.stderr.trim()}; run the two commands by hand`,
        branch === null ? commands : commands.slice(1),
      );
    }
    const message = `Policy: ${summary} (attested seq ${seq})`;
    const commit = git(["commit", "-m", message, "--", commitPlan.policyArg, commitPlan.logArg], commitPlan.root);
    if (!commit.ok) {
      const failure = commit.stderr.trim() || commit.stdout.trim();
      return gitFailed(
        "git commit",
        failure,
        `the attestation was appended at seq ${seq}, but \`git commit\` failed: ${failure}; run the two commands by hand`,
        branch === null ? commands : commands.slice(1),
      );
    }
    committed = true;
    output = `${commit.stdout}${commit.stderr}`.trim();

    /** `gh pr create …` as the operator would type it, for both flows. */
    const prCreateCommand = (head: string): string =>
      `gh pr create --title ${JSON.stringify(prTitle(summary, String(seq)))} --body ${JSON.stringify(prBody(String(seq)))} --head ${head}${probe.defaultBranch === null ? "" : ` --base ${probe.defaultBranch}`}`;
    const prCreateArgs = (head: string): string[] => [
      "pr",
      "create",
      "--title",
      prTitle(summary, String(seq)),
      "--body",
      prBody(String(seq)),
      "--head",
      head,
      ...(probe.defaultBranch === null ? [] : ["--base", probe.defaultBranch]),
    ];

    if (noPublish) {
      // The old stop-after-commit ceremony, on request. Nothing is pushed, so
      // the push and (on the branch flow) the pull request are printed as owed.
      publishing.via = useBranch ? "branch" : "direct";
      publishing.branch = branch;
      publishing.reason = "--no-publish: the ceremony stopped at the commit";
    } else if (branch !== null) {
      // The branch flow does not stop at the commit: the commit is only useful
      // on a protected main once it is on a branch, pushed, and carried by a PR.
      publishing.attempted = true;
      publishing.via = "branch";
      publishing.branch = branch;
      const push = git(["push", "-u", "origin", branch], commitPlan.root);
      publishing.steps.push({ command: `git push -u origin ${branch}`, ok: push.ok });
      if (!push.ok) {
        const prCreate = `gh pr create --title ${JSON.stringify(prTitle(summary, String(seq)))} --body ${JSON.stringify(prBody(String(seq)))}`;
        return stalled(
          "push-rejected",
          `the remote REJECTED \`git push -u origin ${branch}\``,
          push,
          `the attestation was appended at seq ${seq} and committed on ${branch}, but \`git push -u origin ${branch}\` was REJECTED: ${pushFailureText(push)}. STATE: the amendment commit exists LOCALLY on ${branch} and nowhere else; origin still carries the previous policy. Next: \`git push -u origin ${branch} && ${prCreate}\`, and merge that pull request with a merge commit`,
          [
            `attestation appended at seq ${seq}: it is in the log, on disk`,
            `committed LOCALLY on ${branch}, and nowhere else`,
            "NOT on origin: origin still carries the previous policy",
          ],
          [
            { command: `git push -u origin ${branch}`, note: "once the remote will take it" },
            { command: prCreate },
            { command: `gh pr merge ${branch} --merge`, note: "or merge it in the web UI" },
          ],
          0,
          [MERGE_COMMIT_LINE],
        );
      }
      pushed = true;
      publishing.pushed = true;
      output = `${output}\n${`${push.stdout}${push.stderr}`.trim()}`.trim();

      if (ghAvailable(commitPlan.root)) {
        const pr = gh(prCreateArgs(branch), commitPlan.root);
        publishing.steps.push({ command: prCreateCommand(branch), ok: pr.ok });
        if (!pr.ok) {
          const ghFailure = pr.stderr.trim() || pr.stdout.trim() || "gh did not run";
          return stalled(
            "pr-failed",
            "`gh pr create` failed; the branch is already on origin",
            pr,
            `the attestation was appended at seq ${seq}, committed on ${branch} and pushed, but \`gh pr create\` failed: ${ghFailure}; open the pull request by hand and merge it with a merge commit`,
            [
              `attestation appended at seq ${seq}: it is in the log, on disk`,
              `committed on ${branch} and PUSHED: origin has the branch`,
              "no pull request: origin's default branch still carries the previous policy",
            ],
            [
              { command: prCreateCommand(branch), note: "retry, or open it in the web UI" },
              { command: `gh pr merge ${branch} --merge`, note: "or merge it in the web UI" },
            ],
            0,
            [MERGE_COMMIT_LINE],
          );
        }
        prUrl = lastUrl(pr.stdout);
        publishing.prUrl = prUrl;
        publishing.complete = true;
        // APRV-130: the ceremony offers to finish the last step too.
        armAutoMerge(commitPlan.root, branch);
      }
    } else {
      // APRV-111. The direct flow used to stop at the commit while PRINTING the
      // push line among the commands it had just run, so a push that never
      // happened — and, on the day this was found, a push that GitHub's branch
      // protection would have rejected — read as a finished ceremony. The commit
      // sat ahead of origin, unpushed and unnoticed.
      //
      // APRV-130. The rejection used to end the verb, handing the operator four
      // commands to type. Those four commands are non-destructive and entirely
      // mechanical, so the verb RUNS them: a branch off the commit that already
      // exists, a push of that branch, a pull request, and an attempt at
      // auto-merge. What is NOT automated is the APRV-111 constraint, unchanged:
      // `git branch` copies a ref, so the operator's checked-out branch stays
      // exactly where they left it, on the commit they just signed for.
      const target = probe.currentBranch;
      if (target !== null && hasOrigin(commitPlan.root)) {
        publishing.attempted = true;
        publishing.via = "direct";
        const push = git(["push", "origin", target], commitPlan.root);
        publishing.steps.push({ command: `git push origin ${target}`, ok: push.ok });
        if (push.ok) {
          pushed = true;
          publishing.pushed = true;
          publishing.complete = true;
          output = `${output}\n${`${push.stdout}${push.stderr}`.trim()}`.trim();
        } else {
          // ---- the ceremony finishes its own job ----
          const recovery = branchName(String(seq));
          publishing.via = "recovery";
          publishing.branch = recovery;
          const owed: RunbookStep[] = [
            { command: `git branch ${recovery}`, note: "the same commit, on a branch" },
            { command: `git push -u origin ${recovery}` },
            { command: prCreateCommand(recovery) },
            { command: `gh pr merge ${recovery} --merge`, note: "or merge it in the web UI" },
          ];
          /** The state lines every stop on this path shares, plus its own. */
          const state = (last: string): string[] => [
            `attestation appended at seq ${seq}: it is in the log, on disk`,
            `committed LOCALLY on ${target}, one commit ahead of origin`,
            `${target} is protected, whatever the probe reported: the remote just refused`,
            last,
          ];
          const preamble = `the attestation was appended at seq ${seq} and committed on ${target}, but \`git push origin ${target}\` was REJECTED by the remote: ${pushFailureText(push)}. ${target} is protected (whatever the protection probe reported: the remote just refused the push), so this ceremony published through branch ${recovery} instead`;

          note(
            `${st.warn(`${target} is protected:`)} the direct push was refused, so this amendment publishes through branch ${recovery}`,
          );
          quoteUnder(push);

          // 1. The branch. A ref copy: HEAD does not move.
          const branched = git(["branch", recovery], commitPlan.root);
          publishing.steps.push({ command: `git branch ${recovery}`, ok: branched.ok });
          if (!branched.ok) {
            return stalled(
              "push-rejected",
              `\`git branch ${recovery}\` failed, so the recovery branch does not exist`,
              branched,
              `${preamble}, and \`git branch ${recovery}\` failed: ${pushFailureText(branched)}. STATE: the amendment is committed LOCALLY on ${target} and is NOT on origin, so origin still carries the previous policy and your ${target} is one commit ahead of it. Next: \`git branch ${recovery} && git push -u origin ${recovery} && ${prCreateCommand(recovery)}\`. Merge it with a merge commit, then run \`approval log sync\` rather than a pull`,
              state("NOT on origin: origin still carries the previous policy"),
              owed,
              0,
              [MERGE_COMMIT_LINE, LOG_SAFE_PULL_LINE],
            );
          }
          note(
            `${st.glyph("ok")} branch ${recovery} created — your checkout stays on ${target}`,
          );

          // 2. The push of that branch.
          const branchPush = git(["push", "-u", "origin", recovery], commitPlan.root);
          publishing.steps.push({ command: `git push -u origin ${recovery}`, ok: branchPush.ok });
          if (!branchPush.ok) {
            return stalled(
              "push-rejected",
              `the remote REJECTED \`git push -u origin ${recovery}\``,
              branchPush,
              `${preamble}; \`git push -u origin ${recovery}\` was REJECTED too: ${pushFailureText(branchPush)}. STATE: the amendment is committed LOCALLY on ${target} and is NOT on origin, so origin still carries the previous policy and your ${target} is one commit ahead of it. Next: \`git push -u origin ${recovery} && ${prCreateCommand(recovery)}\`. Merge it with a merge commit, then run \`approval log sync\` rather than a pull`,
              state("NOT on origin: origin still carries the previous policy"),
              owed,
              1,
              [MERGE_COMMIT_LINE, LOG_SAFE_PULL_LINE],
            );
          }
          publishing.pushed = true;
          note(`${st.glyph("ok")} pushed ${recovery} to origin`);

          // 3. The pull request. `gh` absent is a failure of THIS step and
          //    nothing more: the branch is on origin either way, so the runbook
          //    resumes from here rather than from the beginning.
          if (!ghAvailable(commitPlan.root)) {
            return stalled(
              "pr-failed",
              "gh is not available, so the pull request was not opened",
              { ok: false, stdout: "", stderr: "gh is not on PATH" },
              `${preamble}, and ${recovery} is on origin, but \`gh\` is not available so the pull request was not opened: open it by hand and merge it with a merge commit. STATE: the amendment is committed LOCALLY on ${target} and is on origin as ${recovery}; origin's ${probe.defaultBranch ?? "default branch"} still carries the previous policy. Next: \`${prCreateCommand(recovery)}\`; and \`approval log sync\` rather than a pull afterwards`,
              state(`on origin as ${recovery}: no pull request carries it yet`),
              owed,
              2,
              [MERGE_COMMIT_LINE, LOG_SAFE_PULL_LINE],
            );
          }
          const pr = gh(prCreateArgs(recovery), commitPlan.root);
          publishing.steps.push({ command: prCreateCommand(recovery), ok: pr.ok });
          if (!pr.ok) {
            return stalled(
              "pr-failed",
              "`gh pr create` failed; the branch is already on origin",
              pr,
              `${preamble}, and ${recovery} is on origin, but \`gh pr create\` failed: ${pushFailureText(pr)}; open the pull request by hand and merge it with a merge commit. STATE: the amendment is committed LOCALLY on ${target} and is on origin as ${recovery}; origin's ${probe.defaultBranch ?? "default branch"} still carries the previous policy. Next: \`${prCreateCommand(recovery)}\`; and \`approval log sync\` rather than a pull afterwards`,
              state(`on origin as ${recovery}: no pull request carries it yet`),
              owed,
              2,
              [MERGE_COMMIT_LINE, LOG_SAFE_PULL_LINE],
            );
          }
          prUrl = lastUrl(pr.stdout);
          publishing.prUrl = prUrl;
          publishing.complete = true;
          note(`${st.glyph("ok")} ${prLabel(prUrl)} opened${prUrl === null ? "" : `: ${prUrl}`}`);

          // 4. Auto-merge, which is allowed to refuse.
          armAutoMerge(commitPlan.root, recovery);
        }
      }
    }
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
      git: gitReport({ commands, committed, pushed, prUrl, output, branch }),
      noop: false,
      dryRun: false,
      aborted: false,
      ceremony: { attested: true, seq },
      publishing,
    });
  } else {
    if (committed) {
      const done: string[] = [
        branch === null
          ? `${st.glyph("ok")} committed the policy and the log together:`
          : `${st.glyph("ok")} committed the policy and the log together on ${branch}:`,
        "",
      ];
      // APRV-111: only the commands that actually RAN are listed under
      // "committed". A push the verb skipped (no origin, or a detached HEAD)
      // used to be printed here as though it had run, which is how an unpushed
      // amendment came to look like a finished one. A push that ran and FAILED
      // never reaches this branch at all: it is a refusal above.
      const remaining: string[] = [];
      for (const command of commands) {
        // The PR command is printed as a to-do when gh could not run it, or
        // (APRV-130) when --no-publish stopped the ceremony before it.
        if (command.startsWith("gh pr create") && branch !== null) {
          if (noPublish) remaining.push(command);
          if (prUrl === null) continue;
        }
        if (command.startsWith("git push") && !pushed) {
          // APRV-130: the direct push that the RECOVERY answered is not owed to
          // anybody. It ran, the remote refused it, and the Publishing section
          // below says so and says what was done instead. Printing it here as
          // "still to run" would send the operator to re-run a rejected push.
          if (publishing.via !== "recovery") remaining.push(command);
          continue;
        }
        done.push(`  ${st.value(humanCommand(command))}`);
      }
      if (output !== null && output.length > 0) done.push("", ...output.split("\n"));
      if (remaining.length > 0) {
        done.push(
          "",
          noPublish
            ? `${st.warn("--no-publish:")} the commit is local only, and origin still carries the previous policy. Still to run:`
            : `${st.warn("NOT pushed:")} the commit is local only, and origin still carries the previous policy. Still to run:`,
          "",
          ...remaining.map((command) => `  ${st.value(humanCommand(command))}`),
        );
      }
      if (branch !== null && !noPublish) {
        done.push("");
        if (prUrl !== null) {
          done.push(`${st.key("pull request:")} ${st.value(prUrl)}`);
          done.push(
            "Merge it with a MERGE COMMIT, so the policy edit and its attestation stay one commit on main.",
          );
        } else {
          done.push(
            "gh is not available, so the pull request was not opened. Open it yourself, and merge it with a MERGE COMMIT so the policy edit and its attestation stay one commit on main:",
            "",
          );
          for (const command of commands) {
            if (command.startsWith("gh pr create")) done.push(`  ${st.value(humanCommand(command))}`);
          }
        }
      }
      section("Committed", done);
    } else {
      section("Now run", [
        ...whyOneCommit(),
        "",
        ...commands.map((command) => `  ${st.value(humanCommand(command))}`),
        ...(useBranch
          ? [
              "",
              "Then merge that pull request with a MERGE COMMIT, so the policy edit and its attestation stay one commit on main.",
            ]
          : []),
      ]);
    }
    // Logistics, beneath the achievement and beneath the commit: what the
    // publishing half did, step by step, when it had to do anything unusual.
    flushPublishing();
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
  /**
   * The branch flow's preconditions, checked here for the same reason: an
   * `origin` that does not exist, or a branch name already taken, would fail
   * AFTER the attestation and leave the operator holding a half-run ceremony.
   * `null` is the direct flow. `branch: null` inside it is the branch flow with
   * a generated name, which contains the seq and so cannot be checked before
   * the append happens.
   */
  branchFlow: { branch: string | null } | null,
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

  if (branchFlow !== null) {
    const remote = git(["remote", "get-url", "origin"], root);
    if (!remote.ok) {
      return {
        ok: false,
        message: `--commit on a branch needs an "origin" remote to push to, and ${root} has none (${remote.stderr.trim()}); pass --direct to commit in place, or add the remote. Nothing was attested`,
      };
    }
    if (branchFlow.branch !== null) {
      const exists = git(["rev-parse", "--verify", "--quiet", `refs/heads/${branchFlow.branch}`], root);
      if (exists.ok) {
        return {
          ok: false,
          message: `--branch ${branchFlow.branch} already exists in ${root}; the amendment branch is created fresh so it carries exactly one commit. Pick another name. Nothing was attested`,
        };
      }
    }
  }
  return { ok: true, plan: { root, policyArg, logArg } };
}

function loadSummary(load: PolicyLoadResult): { ok: boolean; code: string | null; message: string | null } {
  return load.ok
    ? { ok: true, code: null, message: null }
    : { ok: false, code: load.code, message: load.message };
}

/**
 * The `git` sub-object of the report: which ceremony ran, what it knew about
 * branch protection, and what it did or would do.
 */
interface GitReport {
  repo: boolean;
  protection: Protection;
  protectionReason: string;
  defaultBranch: string | null;
  currentBranch: string | null;
  flow: "direct" | "branch";
  branch: string | null;
  warning: string | null;
  commands: string[];
  committed: boolean;
  pushed: boolean;
  prUrl: string | null;
  output: string | null;
}

/**
 * What the publishing half of the ceremony did (APRV-130). ADDITIVE: it reports
 * on the steps that follow the attestation, and it removes nothing.
 */
interface PublishingReport {
  /** Did the verb try to publish at all? False for `--no-publish` and no origin. */
  attempted: boolean;
  /** Is the amendment on origin, as a pushed branch or as an open pull request? */
  complete: boolean;
  /**
   * `direct` pushed the operator's branch; `branch` is the pre-planned branch
   * flow; `recovery` is the direct push that was refused and published through
   * a branch anyway; `none` published nothing.
   */
  via: "direct" | "branch" | "recovery" | "none";
  /** The branch that was published, when one was. */
  branch: string | null;
  /** Did a push reach origin? */
  pushed: boolean;
  prUrl: string | null;
  autoMerge: "armed" | "refused" | "not-attempted";
  /** Every publishing command the verb RAN, in order, with its outcome. */
  steps: { command: string; ok: boolean }[];
  /** The command the automatic path stopped at, when it stopped. */
  stoppedAt: string | null;
  /** Why publishing is incomplete, in one clause. */
  reason: string | null;
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
  git: GitReport | null;
  noop: boolean;
  dryRun: boolean;
  aborted: boolean;
  /**
   * Did the ATTESTATION land (APRV-130)? A separate key because the report's
   * top-level `attested` is, and stays, the attestation this amendment moved
   * FROM. Two different facts; two different names.
   */
  ceremony?: { attested: boolean; seq: number | null };
  publishing?: PublishingReport;
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
      // Additive (APRV-130), and always present: a machine caller reads the
      // ceremony's own outcome without inferring it from `attestation`.
      ceremony: report.ceremony ?? { attested: report.attestation !== null, seq: null },
      publishing: report.publishing ?? null,
    })}\n`,
  );
}
