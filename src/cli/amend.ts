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
import {
  accessSync,
  constants,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePathSegments, sep } from "node:path";

import {
  HUMAN_ACTOR_ENV,
  appendAttestation,
  checkAttestation,
  policyFileHash,
  resolveHumanActor,
} from "../core/attest.js";
import { compareChains } from "../core/log-reconcile.js";
import { diffPolicies, renderDiff, SPEC_NAMESPACES, type PolicyDiff } from "../core/policy-diff.js";
import {
  checkPolicyExpectations,
  describeFailure,
  expectationsFor,
  EXPECTATIONS_MODULE,
} from "../core/policy-expectations.js";
import {
  loadPolicy,
  parseDuration,
  POLICY_FILENAMES,
  type PolicyLoadResult,
} from "../core/policy-load.js";
import {
  proposalState,
  proposeAttestation,
  type DiffSummary,
  type LoadAdvisory,
} from "../core/policy-proposal.js";
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
import { commitOnBase, fetchBase, showBlob } from "./git-scope.js";
import { createProgress, silentProgress, type ProgressReporter } from "./progress.js";
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
  // APRV-109: the agent path's two knobs. `--wait` is how long this process
  // holds the ceremony open for the approver's tap, and `--interval` how often
  // it re-reads the log. Both are ignored under a human identity, where the
  // human act is the confirmation this process already asks for.
  "--wait": "string",
  "--interval": "string",
  "--note": "string",
  "--json": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

/**
 * How long the agent path waits for a tap when `--wait` is not given
 * (APRV-109).
 *
 * Long enough that a phone left face-down through a meeting still collects the
 * decision, short enough that a forgotten `amend` does not hold a worktree
 * open overnight. A lapse attests nothing, so the cost of the timeout being
 * too short is a re-run.
 */
const DEFAULT_ATTESTATION_WAIT_MS = 15 * 60 * 1000;

/** How often the agent path re-reads the log while waiting. */
const DEFAULT_ATTESTATION_INTERVAL_MS = 2000;

/** An agent identity, the one `--as` form that routes to the channel path. */
const AGENT_ACTOR = /^agent:.+/u;

/** Synchronous sleep with no dependency and no busy-spin (as `cli/execute.ts`). */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Machine-readable refusal codes. Frozen public API, printed in the help. */
type AmendErrorCode =
  | "usage"
  | "io"
  | "load-failed"
  | "commit-preconditions"
  // APRV-203: the ceremony owns its own git preconditions. Each of these three
  // ends with NOTHING attested, committed or pushed.
  /** The remote could not be fetched, so there is no base to build on. */
  | "fetch-failed"
  /** The remote's policy is not the attested baseline this edit was made against. */
  | "base-policy-diverged"
  /** The remote's log is not a prefix of the working log: two chains. */
  | "base-log-diverged"
  /** The amended policy does not resolve the way its pins say it must. */
  | "policy-suite-failed"
  | "git-failed"
  | "push-rejected"
  | "pr-failed"
  | "append-failed"
  | "log-unreadable"
  | "log-torn-tail"
  | "log-corrupt"
  // APRV-109, the agent path's own four. Each names a ceremony that ended with
  // NOTHING attested, which is the only outcome an agent-run amendment can have
  // short of a human's tap.
  /** No channel is configured, so no prompt could reach an approver. */
  | "no-channel"
  /** `core/policy-proposal.ts` refused to propose; its code rides in `detail`. */
  | "propose-failed"
  /** The approver said no. */
  | "attestation-declined"
  /** `--wait` elapsed with no answer. */
  | "attestation-timeout";

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
  /**
   * The recovered baseline BYTES, when a verifiable baseline was found
   * (APRV-109). `core/policy-proposal.ts` re-hashes them and refuses any that
   * are not the attested text, so handing them over concedes nothing: this is
   * the same blob that produced `load`, passed on rather than re-recovered.
   */
  bytes: Uint8Array | null;
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
    bytes: null,
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
    bytes: blob,
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

// ---------------------------------------------------------------------------
// The agent path: ask, wait, and attest nothing yourself (APRV-109)
// ---------------------------------------------------------------------------

/** What the channel ceremony collected, when it collected an attestation. */
interface CollectedAttestation {
  ok: true;
  /** The `policy.updated` the approver's tap appended. */
  seq: number;
  /** The `policy.proposed` that tap answered. */
  proposedSeq: number;
  sha256: string;
  diff: DiffSummary;
  load: LoadAdvisory;
}

interface CollectRefusal {
  ok: false;
  code: AmendErrorCode;
  message: string;
  exitCode: number;
  human?: string;
}

interface CollectInput {
  streams: Streams;
  json: boolean;
  st: ReturnType<typeof style>;
  logPath: string;
  policyPath: string;
  actor: string;
  baseline: Uint8Array | null;
  note: string | null;
  liveLoad: PolicyLoadResult;
  waitMs: number;
  intervalMs: number;
  cwd: string;
}

/**
 * Is there a channel that could carry an attestation prompt to a human?
 *
 * FAIL CLOSED, and this is the check that makes the agent path safe to offer at
 * all. A proposal appended into a repository with no configured channel is a
 * question nobody will ever be asked, and the verb would then sit through its
 * whole `--wait` before reporting a timeout that was decidable at the start.
 * Worse, the proposal would stay in the log looking like an outstanding ask.
 *
 * A policy that does not LOAD is the same answer for a stronger reason: the
 * channel table is in the policy, so an unloadable policy is one whose channel
 * configuration is unknown, and "unknown" resolves to the stricter path here
 * exactly as it does everywhere else.
 */
function channelConfigured(load: PolicyLoadResult): boolean {
  if (!load.ok) return false;
  const channels = load.policy.channels;
  return channels !== undefined && Object.keys(channels).length > 0;
}

/**
 * Ask a human to attest the prepared bytes, and wait for the answer.
 *
 * The whole of what APRV-109 adds to this verb. It appends a `policy.proposed`
 * through `core/policy-proposal.ts` — which computes the hash, the semantic
 * diff and the load advisory from the bytes, and refuses `diff-too-large`
 * rather than truncating — and then polls the VERIFIED log until the proposal
 * reaches a terminal state.
 *
 * Only one of those states continues the ceremony. `attested` returns the seq of
 * the `policy.updated` the tap appended, and the caller's git half proceeds
 * unchanged, citing that seq in the commit exactly as it cites a terminal
 * attestation's today. `declined`, `expired`, `superseded` and a lapsed `--wait`
 * all attest nothing and commit nothing: the policy edit stays in the working
 * tree, as unattested as it was before the verb ran.
 *
 * This process never appends the attestation and never holds a human identity.
 * The tap does both, in the channel listener, under the human identity that
 * listener is configured with — the same identity, from the same configuration,
 * that every grant already lands under (SPEC.md §11, unchanged).
 */
function collectAttestation(input: CollectInput): CollectedAttestation | CollectRefusal {
  const { streams, json, st, logPath, policyPath, cwd } = input;

  if (!channelConfigured(input.liveLoad)) {
    return {
      ok: false,
      code: "no-channel",
      exitCode: EXIT_USAGE,
      message: input.liveLoad.ok
        ? `no channel is configured in ${basename(policyPath)}, so an attestation prompt has nowhere to go; nothing was proposed and nothing was attested. Configure a channel, or attest at a terminal with --as human:<id>`
        : `the policy does not load (${input.liveLoad.code}), so which channel would carry the attestation prompt is unknown; nothing was proposed and nothing was attested. Fix the policy, or attest at a terminal with --as human:<id>`,
    };
  }

  const waitUntil = new Date(Date.now() + input.waitMs).toISOString();
  const proposed = proposeAttestation(
    logPath,
    {
      policyPath,
      baseline: input.baseline,
      waitUntil,
      ...(input.note === null ? {} : { note: input.note }),
    },
    input.actor,
  );
  if (!proposed.ok) {
    // A gate refusal, so exit 1 rather than 4: the command was well-formed and
    // the runtime said no. `diff-too-large` is the one a caller acts on — read
    // the diff at a terminal — and it rides in the message with its own code.
    return {
      ok: false,
      code: "propose-failed",
      exitCode: proposed.code === "append-failed" ? EXIT_IO : EXIT_INTEGRITY,
      message: `${proposed.code}: ${proposed.message}`,
    };
  }

  const proposedSeq = proposed.record.seq;
  if (!json) {
    streams.out(
      `${st.glyph("ok")} proposed seq ${String(proposedSeq)} — an approver has been asked to attest ${relPath(policyPath, cwd)}\n`,
    );
    for (const line of st
      .table([
        { left: "sha256", right: shortHash(proposed.sha256) },
        { left: "changes", right: proposed.diff.headline },
        { left: "loads", right: proposed.load.ok ? "clean" : `NO (${proposed.load.code ?? "?"})` },
        { left: "waiting until", right: waitUntil },
      ])
      .split("\n")) {
      streams.out(`  ${line}\n`);
    }
    streams.out("\n");
  }

  const deadline = Date.now() + input.waitMs;
  for (;;) {
    const read = readVerifiedRecords(logPath);
    if (!read.ok) {
      return {
        ok: false,
        code: read.code === "log-torn-tail" ? "log-torn-tail" : "log-unreadable",
        exitCode: read.code === "log-torn-tail" ? EXIT_TORN_TAIL : EXIT_IO,
        message: `${read.message}; the attestation prompt at seq ${String(proposedSeq)} is unanswered and nothing was attested`,
      };
    }

    const derived = proposalState(read.records, proposedSeq, new Date().toISOString());
    const state = derived?.state ?? "open";

    if (state === "attested") {
      // The tap's own record, found by the hash it names. `proposalState` proved
      // one exists; this recovers its seq, which is what the commit cites.
      const attestation = read.records.find(
        (entry) =>
          entry.seq > proposedSeq &&
          entry.event === "policy.updated" &&
          typeof entry.payload === "object" &&
          entry.payload !== null &&
          (entry.payload as Record<string, unknown>)["sha256"] === proposed.sha256,
      );
      if (attestation === undefined) {
        return {
          ok: false,
          code: "log-unreadable",
          exitCode: EXIT_IO,
          message: `the attestation prompt at seq ${String(proposedSeq)} derives as attested and no policy.updated naming ${proposed.sha256} could be found; nothing was committed`,
        };
      }
      return {
        ok: true,
        seq: attestation.seq,
        proposedSeq,
        sha256: proposed.sha256,
        diff: proposed.diff,
        load: proposed.load,
      };
    }

    if (state === "declined") {
      return {
        ok: false,
        code: "attestation-declined",
        exitCode: EXIT_INTEGRITY,
        message: `the approver DECLINED the attestation prompt at seq ${String(proposedSeq)}; nothing was attested and nothing was committed. The policy edit is still in the working tree, and the policy in force is the one that was in force before this ran`,
      };
    }

    if (state === "superseded") {
      return {
        ok: false,
        code: "attestation-timeout",
        exitCode: EXIT_INTEGRITY,
        message: `the attestation prompt at seq ${String(proposedSeq)} was SUPERSEDED by a later proposal for the same policy; nothing was attested here. Re-run the amendment against the bytes now on disk`,
      };
    }

    if (state === "expired" || Date.now() >= deadline) {
      return {
        ok: false,
        code: "attestation-timeout",
        exitCode: EXIT_INTEGRITY,
        message: `no answer arrived for the attestation prompt at seq ${String(proposedSeq)} before its deadline (${waitUntil}); nothing was attested and nothing was committed. The prompt retires itself: it leaves every channel queue by derivation, so no stale question is left in front of the approver`,
      };
    }

    sleepSync(Math.min(input.intervalMs, Math.max(0, deadline - Date.now())));
  }
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

  // Identity first, before a byte is read. Asking a human to read a diff and
  // only then telling them their sign-off cannot be attributed wastes the one
  // resource this system spends.
  //
  // APRV-109 widens WHO may run the verb without widening who may attest. Under
  // a human identity everything below is byte-for-byte what it was: the diff,
  // the advisory, the terminal confirmation, `appendAttestation`. Under an
  // AGENT identity the same preparation runs and then stops at the one act an
  // agent must not perform — instead of attesting, it appends a `policy.proposed`
  // and waits for a human's tap to append the attestation under the human
  // identity the channel listener holds. The agent never holds that identity and
  // never writes a `policy.updated`; `core/policy-proposal.ts` refuses it in
  // code and `schema/event.schema.json` refuses it at the write boundary.
  const asFlag = stringFlag(parsed.flags, "--as");
  const agentActor = asFlag !== null && AGENT_ACTOR.test(asFlag) ? asFlag : null;
  const actor = agentActor ?? resolveHumanActor(asFlag === null ? {} : { actor: asFlag });
  if (actor === null) {
    return usageError(
      streams,
      json,
      asFlag === null
        ? `no identity: set ${HUMAN_ACTOR_ENV}=human:<id>, or pass --as human:<id> to attest here or --as agent:<id> to ask an approver to attest through a channel`
        : `--as expects human:<id> or agent:<id>, got ${JSON.stringify(asFlag)}; an amendment is attested, and under an agent identity the attestation is collected as a tap rather than performed here`,
    );
  }

  // APRV-109. The wait knobs are refused outright under a human identity rather
  // than quietly ignored: an operator who passed `--wait` believes they asked
  // for the channel ceremony, and a verb that attested on the spot instead would
  // be answering a question they did not ask.
  const waitText = stringFlag(parsed.flags, "--wait");
  const intervalText = stringFlag(parsed.flags, "--interval");
  const proposalNote = stringFlag(parsed.flags, "--note");
  if (agentActor === null && (waitText !== null || intervalText !== null)) {
    return usageError(
      streams,
      json,
      "--wait and --interval belong to the channel ceremony, which runs under --as agent:<id>; under a human identity the amendment is attested here and there is no tap to wait for",
    );
  }
  const waitMs = waitText === null ? DEFAULT_ATTESTATION_WAIT_MS : parseDuration(waitText);
  if (waitMs === null) {
    return usageError(
      streams,
      json,
      `--wait expects a duration like 30s, 10m, 6h, got ${JSON.stringify(waitText)}`,
    );
  }
  const intervalMs =
    intervalText === null ? DEFAULT_ATTESTATION_INTERVAL_MS : parseDuration(intervalText);
  if (intervalMs === null) {
    return usageError(
      streams,
      json,
      `--interval expects a duration like 500ms, 2s, got ${JSON.stringify(intervalText)}`,
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

  // (a-pre) The thirty-three seconds of silence, ended (APRV-167).
  //
  // Everything from here to the `Policy` block below is work the operator could
  // not see: a full chain re-verification, then a baseline recovery that shells
  // out to git. The verb said nothing until all of it was done, which read as a
  // hang — one ceremony was abandoned mid-run over it and left this repository's
  // gate fail-closed for every agent session until the next attempt.
  //
  // SILENT UNDER `--json`, and this is not a stylistic choice. This verb's
  // machine surface is not stdout alone: a refusal under `--json` emits its
  // error OBJECT on stderr (see `refuse`), and every caller parses that stream
  // whole. Narration mixed into it would be a parse error in every machine
  // consumer of a refusal — the progress meter would have broken the thing it
  // was added beside. A human is the only reader who benefits from these lines,
  // and `--json` is exactly the flag that says there is no human.
  const progress = json ? silentProgress : createProgress(streams);
  progress.phase("verifying the log chain before anything is read from it");
  const read = readVerifiedRecords(logPath, {
    onProgress: ({ done, total }) => {
      progress.step(done, total);
    },
  });
  progress.done();
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
  progress.phase("recovering the attested baseline and diffing it against the live policy");
  const recovered = recoverBaseline(policyPath, attested?.sha256 ?? null);
  const liveLoad = loadPolicy({ file: policyPath });
  const diff =
    recovered.load === null
      ? null
      : diffPolicies(recovered.load, liveLoad, SPEC_NAMESPACES);
  if (recovered.scratch !== null) rmSync(recovered.scratch, { recursive: true, force: true });
  // Closed here, so the report below starts on a line of its own on a terminal
  // and after the last phase line everywhere else.
  progress.done();

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
  /**
   * The remote tip this ceremony's commit will be parented on (APRV-203).
   *
   * Captured HERE, before the attestation, and used unchanged afterwards: a
   * ceremony that re-read the remote after the tap could build its commit on a
   * base nobody checked.
   */
  let commitBase: { remote: string | null; branch: string; sha: string } | null = null;
  if (wantCommit && !dryRun) {
    const plan = planCommit(policyPath, logPath, useBranch ? { branch: branchFlag } : null);
    if (!plan.ok) {
      return refuse(streams, json, "commit-preconditions", plan.message, EXIT_USAGE);
    }
    commitPlan = plan.plan;

    const prepared = prepareBase(
      { root: commitPlan.root, policyArg: commitPlan.policyArg, logPath, progress },
      probe,
      attested?.sha256 ?? null,
    );
    if (!prepared.ok) {
      return refuse(streams, json, prepared.code, prepared.message, EXIT_IO, prepared.human);
    }
    commitBase = prepared.base;

    // The dogfood pins, run against the AMENDED file before anything is
    // attested or pushed (APRV-203). A policy edit whose pins nobody updated
    // used to be found by CI, hours later, on a pull request that was already
    // open and already carrying an attestation.
    const expectations = expectationsFor(policyPath);
    if (expectations !== null) {
      progress.phase(
        `running the policy suite against the amended file (${String(expectations.length)} pinned resolutions)`,
      );
      const checked = checkPolicyExpectations(liveLoad, expectations);
      progress.done();
      if (!checked.ok) {
        return refuse(
          streams,
          json,
          "policy-suite-failed",
          `the amended policy does not match its pins: ${checked.failures
            .map(describeFailure)
            .join("; ")}. Nothing was attested, committed or pushed`,
          EXIT_USAGE,
          runbook(st, "policy-suite-failed", "the amended policy does not match its pins", {
            state: [
              "nothing was attested: the policy edit is still only a working-tree change",
              "nothing was committed and nothing was pushed",
              ...checked.failures.map(describeFailure),
            ],
            steps: [
              {
                command: `$EDITOR ${EXPECTATIONS_MODULE}`,
                note: "make the pins say what the amendment means them to say",
              },
              { command: "npm run build", note: "the ceremony reads the compiled pins" },
              { command: "approval policy amend --commit", note: "re-run; it starts over cleanly" },
            ],
            footer: [
              "this is the check CI runs: failing it here costs a minute, failing it there costs a red pull request carrying an attestation",
            ],
          }),
        );
      }
    }
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
    // APRV-203: `--commit` runs none of these; it assembles the commit on the
    // remote's tip without a checkout. These are the HAND procedure, and they
    // start where `--commit` starts: at the remote, so the branch is not built
    // on a local trunk that has fallen behind.
    if (useBranch) {
      return [
        "git fetch origin",
        `git checkout -b ${branchName(seq)} origin/${probe.defaultBranch ?? "main"}`,
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

  // (e2) The terminal confirmation belongs to the human path only. Under an
  // agent identity the confirmation IS the tap, and asking this process's stdin
  // for one would be asking the party under oversight to confirm its own
  // amendment.
  if (agentActor === null && !assumeYes) {
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

  // (f) The attestation itself. One of two doors onto the same act: the human
  // path performs it here, the agent path asks for it and waits.
  let seq: number;
  let collected: CollectedAttestation | null = null;
  if (agentActor === null) {
    const result = appendAttestation(logPath, policyPath, actor);
    if (!result.ok) {
      const exitCode = result.error.code === "corrupt-tail" ? EXIT_TORN_TAIL : EXIT_IO;
      return refuse(streams, json, "append-failed", result.error.message, exitCode);
    }
    seq = result.record.seq;
  } else {
    const asked = collectAttestation({
      streams,
      json,
      st,
      logPath,
      policyPath,
      actor,
      baseline: recovered.bytes,
      note: proposalNote,
      liveLoad,
      waitMs,
      intervalMs,
      cwd,
    });
    if (!asked.ok) {
      return refuse(streams, json, asked.code, asked.message, asked.exitCode, asked.human);
    }
    collected = asked;
    seq = asked.seq;
  }

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
        // APRV-109: on the agent path the attestation was collected as a tap, so
        // the prompt it answered is named here. The seq the commit cites is the
        // ATTESTATION's, as it has always been.
        ...(collected === null
          ? []
          : [{ left: "attested by tap on", right: `policy.proposed seq ${String(collected.proposedSeq)}` }]),
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

  if (commitPlan !== null && commitBase !== null) {
    // APRV-203. The commit is ASSEMBLED, never checked out: a scratch index is
    // filled from the remote's tree, the two ceremony files are laid over it
    // from the working tree, and the result is parented on the remote. HEAD does
    // not move, the operator's index is not touched, and the working tree ends
    // the ceremony carrying exactly the policy edit it started with.
    const message = `Policy: ${summary} (attested seq ${seq})`;
    /** `origin/main abc123`, or `HEAD abc123` where there is no remote. */
    const baseLabel = `${commitBase.remote === null ? "HEAD" : `${commitBase.remote}/${commitBase.branch}`} ${commitBase.sha.slice(0, 12)}`;
    progress.phase(`building the amendment commit on ${baseLabel} (nothing is checked out)`);
    const built = commitOnBase(commitPlan.root, {
      base: commitBase.sha,
      paths: [commitPlan.policyArg, commitPlan.logArg],
      message,
    });
    progress.done();
    if (!built.ok) {
      return gitFailed(
        built.step,
        built.quote.join(" | "),
        `the attestation was appended at seq ${seq}, but ${built.message}; the checkout is untouched, so run the printed commands by hand`,
        commands,
      );
    }
    if (built.unchanged) {
      return gitFailed(
        "git write-tree",
        `${baseLabel} already carries these exact bytes`,
        `the attestation was appended at seq ${seq}, but the amendment tree is identical to ${baseLabel}: there is nothing to commit`,
        commands,
      );
    }
    const commitSha = built.sha;

    /**
     * The direct flow, when this checkout was already sitting on the base.
     *
     * Moving the branch ref here is exactly what `git commit` would have done:
     * the tree of the new commit is the base tree plus the two files the working
     * tree already carries, so the status afterwards is clean. It is done ONLY
     * when HEAD is the base — a checkout that had fallen behind is left where it
     * is, because moving it would rewrite the working tree, and rewriting the
     * working tree around a live log is the whole thing this verb never does.
     */
    const headSha = git(["rev-parse", "HEAD"], commitPlan.root).stdout.trim();
    const inPlace =
      branch === null &&
      probe.currentBranch !== null &&
      headSha === commitBase.sha &&
      git(["update-ref", `refs/heads/${probe.currentBranch}`, commitSha, headSha], commitPlan.root).ok;
    if (inPlace) {
      // The index has to follow the ref, or every one of the two files reads as
      // a staged modification of a commit that already contains it. `read-tree`
      // without `-u` writes the index and never the working tree, which is the
      // half of `git commit` the ref move did not do.
      git(["read-tree", commitSha], commitPlan.root);
    }

    // Otherwise the commit is anchored on a ref of its own before anything is
    // pushed, so a rejected push leaves an object a human can still find and
    // push. The branch flow anchors on ITS branch, because that is the name the
    // recovery instructions use; the direct flow anchors under `refs/approval/`,
    // where it claims no branch name that the recovery might later need.
    const fallbackRef = `refs/approval/amend/${String(seq)}`;
    let anchor = fallbackRef;
    if (!inPlace) {
      if (branch !== null && git(["branch", branch, commitSha], commitPlan.root).ok) {
        anchor = branch;
      } else {
        git(["update-ref", fallbackRef, commitSha], commitPlan.root);
      }
    }

    committed = true;
    output = inPlace
      ? `${commitSha.slice(0, 12)} on ${probe.currentBranch ?? "HEAD"} (built on ${baseLabel})`
      : `${commitSha.slice(0, 12)} on ${baseLabel} (held at ${anchor}; your checkout was not moved)`;

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
      progress.phase(`pushing ${commitSha.slice(0, 12)} to origin ${branch}`);
      const push = git(["push", "origin", `${commitSha}:refs/heads/${branch}`], commitPlan.root);
      progress.done();
      publishing.steps.push({ command: `git push -u origin ${branch}`, ok: push.ok });
      if (!push.ok) {
        const prCreate = `gh pr create --title ${JSON.stringify(prTitle(summary, String(seq)))} --body ${JSON.stringify(prBody(String(seq)))}`;
        return stalled(
          "push-rejected",
          `the remote REJECTED \`git push origin ${branch}\``,
          push,
          `the attestation was appended at seq ${seq} and committed as ${commitSha.slice(0, 12)} on ${commitBase.remote}/${commitBase.branch}, but \`git push origin ${commitSha.slice(0, 12)}:refs/heads/${branch}\` was REJECTED: ${pushFailureText(push)}. STATE: the amendment commit exists LOCALLY on ${branch} and nowhere else; origin still carries the previous policy. Next: \`git push -u origin ${branch} && ${prCreate}\`, and merge that pull request with a merge commit`,
          [
            `attestation appended at seq ${seq}: it is in the log, on disk`,
            `committed LOCALLY on ${branch} (${commitSha.slice(0, 12)}, parented on ${commitBase.remote}/${commitBase.branch}), and nowhere else`,
            "your checkout was never moved: same branch, same working tree",
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
        progress.phase(`pushing ${commitSha.slice(0, 12)} to origin ${target}`);
        const push = git(["push", "origin", `${commitSha}:refs/heads/${target}`], commitPlan.root);
        progress.done();
        publishing.steps.push({ command: `git push origin ${target}`, ok: push.ok });
        if (push.ok) {
          pushed = true;
          publishing.pushed = true;
          publishing.complete = true;
          output = `${output}\n${`${push.stdout}${push.stderr}`.trim()}`.trim();
          // APRV-203: the commit was assembled on the remote's tip and pushed
          // there, so the operator's own branch does not carry it yet. Say so,
          // rather than letting them find out from a `git status` later.
          if (!inPlace) {
            note(
              `${st.glyph("ok")} pushed to origin ${target}; your ${target} does not carry the commit yet — \`approval log sync\` brings it down safely`,
            );
          }
        } else {
          // ---- the ceremony finishes its own job ----
          const recovery = branchName(String(seq));
          publishing.via = "recovery";
          publishing.branch = recovery;
          const owed: RunbookStep[] = [
            {
              command: `git branch ${recovery} ${commitSha.slice(0, 12)}`,
              note: "the assembled commit, on a branch",
            },
            { command: `git push -u origin ${recovery}` },
            { command: prCreateCommand(recovery) },
            { command: `gh pr merge ${recovery} --merge`, note: "or merge it in the web UI" },
          ];
          /** The state lines every stop on this path shares, plus its own. */
          const state = (last: string): string[] => [
            `attestation appended at seq ${seq}: it is in the log, on disk`,
            `committed as ${commitSha.slice(0, 12)} on ${commitBase.remote}/${commitBase.branch}, held LOCALLY on ${recovery}`,
            `your checkout was never moved: still on ${target}, working tree as you left it`,
            `${target} is protected, whatever the probe reported: the remote just refused`,
            last,
          ];
          const preamble = `the attestation was appended at seq ${seq} and committed as ${commitSha.slice(0, 12)} on ${commitBase.remote}/${commitBase.branch}, but \`git push origin ${target}\` was REJECTED by the remote: ${pushFailureText(push)}. ${target} is protected (whatever the protection probe reported: the remote just refused the push), so this ceremony published through branch ${recovery} instead`;

          note(
            `${st.warn(`${target} is protected:`)} the direct push was refused, so this amendment publishes through branch ${recovery}`,
          );
          quoteUnder(push);

          // 1. The branch. A ref copy at the assembled commit (APRV-203: at the
          //    COMMIT rather than at HEAD, which never carried it). A name
          //    already taken is still a refusal: this verb does not overwrite
          //    somebody else's branch to finish its own ceremony.
          const branched = git(["branch", recovery, commitSha], commitPlan.root);
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
      ...(collected === null
        ? {}
        : {
            proposal: {
              seq: collected.proposedSeq,
              sha256: collected.sha256,
              diff: collected.diff,
              load: collected.load,
            },
          }),
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

/**
 * Fetch the remote and establish that this ceremony may be based on it (APRV-203).
 *
 * The ceremony used to commit on whatever branch the operator was standing on,
 * which made the operator responsible for that branch being current. On
 * 2026-09-01 it was not: origin's main had moved, the amendment commit went onto
 * the stale local tip, and the pull request carried a parent missing everything
 * main had merged since — including the test pins the previous ceremony landed.
 * CI went red and the branch had to be rebased by hand. So the verb fetches, and
 * it bases its commit on the remote.
 *
 * Two things are checked before that base is accepted, and both are refusals
 * with their own codes rather than reconciliations:
 *
 * - the remote's POLICY must be the attested bytes this edit was made against.
 *   If the remote carries a policy this working tree never saw, the edit in the
 *   working tree is an edit to a different document.
 * - the remote's LOG must be a prefix of the working log. The amendment commit
 *   carries the log, so a remote log this working log does not contain would be
 *   reverted by it, and two chains do not merge.
 *
 * A local branch AHEAD of the remote is deliberately not checked at all: the
 * commit is parented on the remote either way, so those commits are simply not
 * part of the ceremony.
 */
function prepareBase(
  ctx: { root: string; policyArg: string; logPath: string; progress: ProgressReporter },
  probe: ProtectionProbe,
  attestedSha256: string | null,
):
  | { ok: true; base: { remote: string | null; branch: string; sha: string } }
  | { ok: false; code: AmendErrorCode; message: string; human?: string } {
  const remote = "origin";
  // A repository with no remote has nothing to fetch and nothing to diverge
  // from: its own HEAD is the base, which is what this ceremony always used.
  if (!hasOrigin(ctx.root)) {
    const head = git(["rev-parse", "HEAD"], ctx.root);
    const sha = head.stdout.trim();
    if (!head.ok || sha.length === 0) {
      return {
        ok: false,
        code: "fetch-failed",
        message: `${ctx.root} has no "origin" remote and no HEAD commit to base this amendment on; nothing was attested. Make the first commit, or add the remote`,
      };
    }
    return { ok: true, base: { remote: null, branch: probe.currentBranch ?? "HEAD", sha } };
  }
  const branch = probe.defaultBranch ?? probe.currentBranch;
  if (branch === null) {
    return {
      ok: false,
      code: "fetch-failed",
      message: `no branch could be resolved to base this amendment on (${probe.reason}); nothing was attested. Check out the trunk in this checkout, or add an "origin" remote`,
    };
  }

  ctx.progress.phase(
    `fetching ${remote}/${branch}: the amendment is based on the remote, not on this checkout`,
  );
  const fetched = fetchBase(ctx.root, remote, branch);
  ctx.progress.done();
  if (!fetched.ok) {
    return {
      ok: false,
      code: "fetch-failed",
      message: `${fetched.message}. The amendment commit is based on ${remote}/${branch}, so the ceremony cannot proceed without knowing where that is; nothing was attested. Fix the remote (network, credentials, or no origin at all) and run this again`,
    };
  }
  const sha = fetched.sha;

  ctx.progress.phase(`verifying that ${remote}/${branch} ${sha.slice(0, 12)} is this edit's base`);
  const remotePolicy = showBlob(ctx.root, sha, ctx.policyArg);
  const remoteSha256 =
    remotePolicy === null ? null : createHash("sha256").update(remotePolicy).digest("hex");
  if (attestedSha256 !== null && remoteSha256 !== attestedSha256) {
    ctx.progress.done();
    return {
      ok: false,
      code: "base-policy-diverged",
      message: `${remote}/${branch} carries a policy this amendment was not written against: ${
        remoteSha256 === null
          ? `it has no ${ctx.policyArg} at all`
          : `${remote}/${branch}:${ctx.policyArg} hashes ${remoteSha256}`
      }, and the attested baseline this edit is a diff from is ${attestedSha256}. Somebody amended the policy since this edit began, so committing it would revert their amendment. Nothing was attested. Bring this checkout up to ${remote}/${branch} and re-apply the edit on top of it`,
    };
  }

  const remoteLog = showBlob(ctx.root, sha, repoPath(ctx.root, ctx.logPath));
  const compared = compareChains(
    { label: `the working log ${ctx.logPath}`, text: readLogText(ctx.logPath) },
    {
      label: `${remote}/${branch}:${repoPath(ctx.root, ctx.logPath)}`,
      text: remoteLog === null ? "" : remoteLog.toString("utf8"),
    },
  );
  ctx.progress.done();
  if (!compared.ok) {
    return { ok: false, code: "base-log-diverged", message: `${compared.message}; nothing was attested` };
  }
  if (compared.drift.relation === "diverged" || compared.drift.relation === "behind") {
    const drift = compared.drift;
    return {
      ok: false,
      code: "base-log-diverged",
      message:
        drift.relation === "diverged"
          ? `the working log and ${remote}/${branch}'s log part at seq ${String(drift.firstDivergentSeq)}: two chains, not one. The amendment commit carries the log, and hash chains do not merge, so nothing was attested. Run \`approval doctor\` for the log-drift report; which of the two is the log is a human decision`
          : `${remote}/${branch} carries log records this checkout does not (its head is seq ${String(
              drift.committedHead?.seq ?? 0,
            )}, the working head is seq ${String(
              drift.workingHead?.seq ?? 0,
            )}). An amendment commit built on the remote would carry this shorter log over the longer one, dropping records. Nothing was attested. Run \`approval log sync\` first, then run this again`,
    };
  }

  return { ok: true, base: { remote, branch, sha } };
}

/** The working log's text, or the empty string when there is no file yet. */
function readLogText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
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
  /**
   * The attestation prompt this ceremony collected its tap from (APRV-109).
   * Present only on the agent path; absent when the operator attested here, so
   * a machine reading it can tell the two ceremonies apart without a flag.
   */
  proposal?: { seq: number; sha256: string; diff: DiffSummary; load: LoadAdvisory };
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
      // APRV-109, additive and always present: `null` says the attestation was
      // performed at this terminal, an object says it was collected as a tap.
      proposal: report.proposal ?? null,
    })}\n`,
  );
}
