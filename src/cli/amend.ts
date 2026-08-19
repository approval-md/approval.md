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
import { relPath, shortHash, style, type TableRow } from "./style.js";
import { usageErrorText } from "./usage.js";

const FLAGS: Record<string, FlagKind> = {
  "--policy": "string",
  "--dir": "string",
  "--log": "string",
  "--as": "string",
  "--require-load": "boolean",
  "--dry-run": "boolean",
  "--commit": "boolean",
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

/** Is `gh` runnable at all? Used to decide whether the PR is opened or printed. */
function ghAvailable(root: string): boolean {
  const probe = spawnSync("gh", ["--version"], { cwd: root, encoding: "utf8" });
  return probe.error === undefined && probe.status === 0;
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
            `${st.glyph("fail")} ${st.fail("DOES NOT LOAD")} (${liveLoad.code}): ${liveLoad.message}`,
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

  // (g) The git ceremony: the two files, together, or the commands to do it.
  const commands = gitCommands(String(seq));
  const branch = useBranch ? branchName(String(seq)) : null;
  let committed = false;
  let pushed = false;
  let prUrl: string | null = null;
  let output: string | null = null;
  if (commitPlan !== null) {
    if (branch !== null) {
      const checkout = git(["checkout", "-b", branch], commitPlan.root);
      if (!checkout.ok) {
        return refuse(
          streams,
          json,
          "git-failed",
          `the attestation was appended at seq ${seq}, but \`git checkout -b ${branch}\` failed: ${checkout.stderr.trim()}; run the printed commands by hand`,
          EXIT_IO,
        );
      }
    }
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

    // The branch flow does not stop at the commit: the commit is only useful on
    // a protected main once it is on a branch, pushed, and carried by a PR.
    if (branch !== null) {
      const push = git(["push", "-u", "origin", branch], commitPlan.root);
      if (!push.ok) {
        return refuse(
          streams,
          json,
          "git-failed",
          `the attestation was appended at seq ${seq} and committed on ${branch}, but \`git push -u origin ${branch}\` failed: ${push.stderr.trim() || push.stdout.trim()}; push the branch and open the pull request by hand`,
          EXIT_IO,
        );
      }
      pushed = true;
      output = `${output}\n${`${push.stdout}${push.stderr}`.trim()}`.trim();

      if (ghAvailable(commitPlan.root)) {
        const args = [
          "pr",
          "create",
          "--title",
          prTitle(summary, String(seq)),
          "--body",
          prBody(String(seq)),
          "--head",
          branch,
        ];
        if (probe.defaultBranch !== null) args.push("--base", probe.defaultBranch);
        const pr = spawnSync("gh", args, { cwd: commitPlan.root, encoding: "utf8" });
        if (pr.error !== undefined || pr.status !== 0) {
          return refuse(
            streams,
            json,
            "pr-failed",
            `the attestation was appended at seq ${seq}, committed on ${branch} and pushed, but \`gh pr create\` failed: ${(pr.stderr ?? "").trim() || detail(pr.error ?? "gh did not run")}; open the pull request by hand and merge it with a merge commit`,
            EXIT_IO,
          );
        }
        const url = pr.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.startsWith("http"));
        prUrl = url[url.length - 1] ?? null;
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
    });
  } else {
    section("Attested", [
      st.table([
        { left: "file", right: relPath(policyPath, cwd) },
        { left: "seq", right: String(seq) },
        { left: "sha256", right: shortHash(liveSha256) },
      ]),
    ]);
    if (committed) {
      const done: string[] = [
        branch === null
          ? `${st.glyph("ok")} committed the policy and the log together:`
          : `${st.glyph("ok")} committed the policy and the log together on ${branch}:`,
        "",
      ];
      for (const command of commands) {
        // The PR command is printed as a to-do when gh could not run it.
        if (command.startsWith("gh pr create") && prUrl === null && branch !== null) continue;
        done.push(`  ${st.value(humanCommand(command))}`);
      }
      if (output !== null && output.length > 0) done.push("", ...output.split("\n"));
      if (branch !== null) {
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
