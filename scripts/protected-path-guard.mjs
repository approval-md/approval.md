#!/usr/bin/env node
/**
 * The protected-path guard, CI side (APRV-151).
 *
 * Asks git which protected paths changed between two commits, then asks the
 * COMMITTED log whether a human decided each one. Session wiring is never an
 * input: a session whose PreToolUse hook silently failed to load produces no
 * refused-request record, so the only thing that can catch it after the fact is
 * the absence of a grant in the log. See `src/core/protected-path-guard.ts` for
 * the evidence rules, the exempt evidence surface, and the ordering rule the
 * log's lag behind the primary checkout implies.
 *
 * Everything git touches is read at a COMMIT's tree, never the working tree:
 * `git show <ref>:<path>`. A guard that read the checkout could be told a
 * different story than the one the pull request carries.
 *
 * ## Where the log comes from (APRV-260)
 *
 * The log at head is main's log at branch time, and it trails the primary
 * checkout's live log: a grant a human tapped during the session reaches a
 * COMMITTED log only when the daemon's next advance lands on a records branch
 * and merges. Reading head alone therefore failed gated edits whose grant was
 * already pushed, and the ordering rule became "wait for two merges".
 *
 * So the guard considers several committed copies — the head ref, `origin/main`,
 * and every `origin/records-*` branch — and uses the FRESHEST one that is
 * provably the same chain as head's: verified clean end to end, and carrying
 * head's last record at head's own index with head's hash. A copy that fails
 * either test is named and skipped. Head's log still defines the chain; nothing
 * that disagrees with it is ever read, so the widening is "look further along
 * THIS log", never "look at some other log".
 *
 * Usage:
 *   node scripts/protected-path-guard.mjs --base <ref> --head <ref>
 *   ... --json          machine-readable report
 *   ... --repo <dir>    run against another checkout (default: this one)
 *   ... --log-ref <ref> name a log candidate explicitly (repeatable). Replaces
 *                       the origin/main and origin/records-* discovery; the
 *                       head ref is always considered first regardless.
 *
 * Exit codes: 0 pass, 1 a protected path lacks evidence (or the log fails
 * closed), 2 usage, 4 the guard itself could not look.
 *
 * Requires a build: it imports the checked core from `dist/`.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;
const EXIT_CANNOT_LOOK = 4;

/** The log and the policy, at their SPEC.md-fixed repository locations. */
const LOG_PATH = ".approval/log/events.jsonl";
const PAYLOAD_DIR = ".approval/payloads";
const POLICY_PATH = "APPROVAL.md";

/** Run git in `repo`, returning stdout or `null` when the command failed. */
function git(repo, args) {
  const run = spawnSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (run.error !== undefined && run.error !== null) return null;
  if (run.status !== 0) return null;
  return run.stdout;
}

/** A blob at a commit, or `null` when the tree does not carry it. */
function showBlob(repo, ref, path) {
  return git(repo, ["show", `${ref}:${path}`]);
}

function usage(message) {
  process.stderr.write(`protected-path-guard: ${message}\n`);
  process.stderr.write(
    "usage: node scripts/protected-path-guard.mjs --base <ref> --head <ref> [--repo <dir>] [--json] [--log-ref <ref>]...\n",
  );
  return EXIT_USAGE;
}

function parseArgs(argv) {
  const flags = { base: null, head: null, repo: REPO_ROOT, json: false, logRefs: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      flags.json = true;
      continue;
    }
    if (arg === "--log-ref") {
      const value = argv[index + 1];
      if (value === undefined) return { ok: false, message: "--log-ref needs a value" };
      flags.logRefs.push(value);
      index += 1;
      continue;
    }
    if (arg === "--base" || arg === "--head" || arg === "--repo") {
      const value = argv[index + 1];
      if (value === undefined) return { ok: false, message: `${arg} needs a value` };
      flags[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    return { ok: false, message: `unexpected argument ${JSON.stringify(arg)}` };
  }
  if (flags.base === null || flags.head === null) {
    return { ok: false, message: "--base and --head are both required" };
  }
  return { ok: true, flags };
}

/**
 * `policy.protected_paths` from the policy AT HEAD, parsed with the same
 * hardened YAML the runtime uses.
 *
 * A pull request that removed an entry would narrow the guarded set with the
 * very change the guard is checking, so the entries at BASE are read too and
 * the union is used. Narrowing the protected surface is itself a protected
 * edit, and it does not get to take effect before it is approved.
 */
function protectedPathsFrom(repo, refs, parsePolicy) {
  const found = new Set();
  for (const ref of refs) {
    const text = showBlob(repo, ref, POLICY_PATH);
    if (text === null) continue;
    let load;
    try {
      load = parsePolicy(text);
    } catch {
      continue;
    }
    for (const entry of load) found.add(entry);
  }
  return [...found];
}

/**
 * The refs whose committed log may be read, in fixed precedence order.
 *
 * Head first, always: it is the copy the pull request itself carries and the
 * one that defines the chain. Then `origin/main`, then every records branch,
 * newest name last — the order only settles ties, and a tie means two copies
 * end at the same record, so which one is named is cosmetic.
 *
 * `--log-ref` replaces the discovery rather than adding to it, so a test can
 * name its candidates without depending on what remote refs a checkout happens
 * to have fetched.
 */
function candidateRefsFor(repo, head, explicit) {
  const refs = [head];
  const add = (ref) => {
    if (ref.length > 0 && !refs.includes(ref)) refs.push(ref);
  };
  if (explicit.length > 0) {
    for (const ref of explicit) add(ref);
    return refs;
  }
  add("origin/main");
  const listed = git(repo, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/remotes/origin/records-*",
  ]);
  if (listed !== null) for (const line of listed.split("\n")) add(line.trim());
  return refs;
}

/**
 * One candidate's log, verified through the real verifier.
 *
 * The verifier wants a path, so the blob is materialized in the scratch
 * directory under a per-candidate name and removed with the rest of it.
 */
function readLogAt(repo, ref, scratch, slot, verifyModule, cache) {
  // Two refs holding the same log blob are one read. Verification walks the
  // whole chain, and a repository accumulates records branches that were never
  // deleted; this repository had 46 of them the day this was written.
  const oid = git(repo, ["rev-parse", `${ref}:${LOG_PATH}`]);
  const key = oid === null ? null : oid.trim();
  if (key !== null && cache.has(key)) return cache.get(key);
  const remember = (outcome) => {
    if (key !== null) cache.set(key, outcome);
    return outcome;
  };
  const text = showBlob(repo, ref, LOG_PATH);
  if (text === null) return remember({ status: "missing", records: null });
  const path = join(scratch, `events-${slot}.jsonl`);
  writeFileSync(path, text, "utf8");
  const verified = verifyModule.verifyWithRecords(path);
  if (verified.result.status !== "clean") {
    return remember({
      status: "unverified",
      records: null,
      detail: JSON.stringify(verified.result),
    });
  }
  return remember({ status: "ok", records: verified.records });
}

/**
 * Pick the log the guard will read for evidence.
 *
 * The rule, stated as the invariant it is: **head's log defines the chain.**
 * A candidate is admitted only when it is verified clean AND its record at
 * head's last index is head's last record, seq and hash both. That is what
 * makes it an EXTENSION of the copy the pull request carries rather than a
 * different history that happens to be longer; a copy that disagrees is
 * reported `diverged` and never read. Among admitted candidates the one
 * reaching the highest seq wins, because the only reason to look past head is
 * that a later advance may carry the grant.
 *
 * Head's own log is the fallback in every degenerate case: missing, unverified,
 * or empty. An empty log at head anchors nothing (there is no record to match),
 * so no extension is admitted onto it — fail closed, the same direction every
 * other unknown in this guard resolves.
 */
function chooseLogSource(repo, head, explicit, scratch, verifyModule) {
  const refs = candidateRefsFor(repo, head, explicit);
  const blobCache = new Map();
  const headRead = readLogAt(repo, head, scratch, 0, verifyModule, blobCache);
  const headRecords = headRead.records;
  const headLastSeq =
    headRecords === null || headRecords.length === 0
      ? null
      : headRecords[headRecords.length - 1].seq;
  const candidates = [
    {
      ref: head,
      status: headRead.status === "ok" ? "admitted" : headRead.status,
      lastSeq: headLastSeq,
    },
  ];
  const chosenFallback = {
    ref: head,
    status: headRead.status,
    detail: headRead.detail,
    records: headRecords,
    lastSeq: headLastSeq,
    headLastSeq,
    candidates,
  };
  if (headRecords === null || headRecords.length === 0) {
    // Nothing to anchor to. The other candidates are not even read: admitting
    // one would mean trusting a log the pull request's own tree cannot confirm.
    // A head log that is missing or unverified keeps that status; an empty one
    // verified clean is still the log this run read.
    if (headRecords !== null) candidates[0].status = "chosen";
    return chosenFallback;
  }

  const anchor = headRecords[headRecords.length - 1];
  let best = { ref: head, records: headRecords, lastSeq: headLastSeq, index: 0 };
  for (let slot = 1; slot < refs.length; slot += 1) {
    const ref = refs[slot];
    const read = readLogAt(repo, ref, scratch, slot, verifyModule, blobCache);
    if (read.records === null) {
      candidates.push({ ref, status: read.status, lastSeq: null });
      continue;
    }
    const at = read.records[headRecords.length - 1];
    const anchored = at !== undefined && at.seq === anchor.seq && at.hash === anchor.hash;
    const lastSeq = read.records.length === 0 ? null : read.records[read.records.length - 1].seq;
    if (!anchored) {
      candidates.push({ ref, status: "diverged", lastSeq });
      continue;
    }
    candidates.push({ ref, status: "admitted", lastSeq });
    if (lastSeq !== null && best.lastSeq !== null && lastSeq > best.lastSeq) {
      best = { ref, records: read.records, lastSeq, index: candidates.length - 1 };
    }
  }
  candidates[best.index].status = "chosen";
  return {
    ref: best.ref,
    status: "ok",
    records: best.records,
    lastSeq: best.lastSeq,
    headLastSeq,
    candidates,
  };
}

/**
 * The one-line provenance the human output leads with.
 *
 * `firstSeq` is the chosen log's own first seq, which is head's too: an
 * admitted candidate carries head's prefix by construction.
 */
function logSourceLine(source, firstSeq) {
  if (source.records === null) {
    const why =
      source.status === "missing"
        ? "the tree carries no log"
        : `the log does not verify (${source.detail ?? "no detail"})`;
    return `log from ${source.ref}: ${why}`;
  }
  const range = firstSeq === null || source.lastSeq === null ? "empty" : `seq ${firstSeq}..${source.lastSeq}`;
  const carried =
    firstSeq === null || source.headLastSeq === null
      ? "head carried an empty log"
      : `head carried ${firstSeq}..${source.headLastSeq}`;
  return `log from ${source.ref}, ${range} (${carried})`;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) return usage(parsed.message);
  const { base, head, repo, json, logRefs } = parsed.flags;

  let guard;
  let verifyModule;
  let policyModule;
  try {
    guard = await import("../dist/src/core/protected-path-guard.js");
    verifyModule = await import("../dist/src/core/verify.js");
    policyModule = await import("../dist/src/core/policy-load.js");
  } catch (cause) {
    process.stderr.write(
      `protected-path-guard: the built core is missing (${String(cause)}). Run \`npm run build\` first.\n`,
    );
    return EXIT_CANNOT_LOOK;
  }

  const resolvedBase = git(repo, ["rev-parse", base]);
  const resolvedHead = git(repo, ["rev-parse", head]);
  if (resolvedBase === null || resolvedHead === null) {
    process.stderr.write(
      `protected-path-guard: git could not resolve ${resolvedBase === null ? base : head} in ${repo}\n`,
    );
    return EXIT_CANNOT_LOOK;
  }

  const diff = git(repo, ["diff", "--name-only", `${base}`, `${head}`]);
  if (diff === null) {
    process.stderr.write(`protected-path-guard: git could not diff ${base}..${head} in ${repo}\n`);
    return EXIT_CANNOT_LOOK;
  }
  const changedPaths = diff.split("\n").filter((line) => line.trim().length > 0);

  // The policy's own widening entries, from both ends of the range.
  const readEntries = (text) => {
    const load = policyModule.loadPolicyText(POLICY_PATH, text);
    if (load.ok !== true) return [];
    const entries = load.policy.protected_paths;
    return Array.isArray(entries) ? entries.filter((entry) => typeof entry === "string") : [];
  };
  let policyProtectedPaths = [];
  try {
    policyProtectedPaths = protectedPathsFrom(repo, [head, base], readEntries);
  } catch {
    policyProtectedPaths = [];
  }

  // The committed log, taken from the freshest copy that is provably the same
  // chain as the one head carries (APRV-260). Every candidate is verified
  // through the real verifier before it is looked at.
  const scratch = mkdtempSync(join(tmpdir(), "approval-md-guard-"));
  let window = {
    firstSeq: null,
    lastSeq: null,
    firstTs: null,
    lastTs: null,
    base: resolvedBase.trim().slice(0, 12),
    head: resolvedHead.trim().slice(0, 12),
  };
  try {
    const source = chooseLogSource(repo, head, logRefs, scratch, verifyModule);
    const records = source.records;
    const logStatus = source.status === "ok" ? "ok" : source.status;
    const logDetail = source.detail;
    if (records !== null) {
      const first = records[0];
      const last = records[records.length - 1];
      window = {
        ...window,
        firstSeq: first?.seq ?? null,
        lastSeq: last?.seq ?? null,
        firstTs: first?.ts ?? null,
        lastTs: last?.ts ?? null,
      };
    }
    const logSource = {
      ref: source.ref,
      lastSeq: source.lastSeq,
      headLastSeq: source.headLastSeq,
      candidates: source.candidates,
    };

    const policyBytes = showBlob(repo, head, POLICY_PATH);
    const policySha256AtHead =
      policyBytes === null ? null : createHash("sha256").update(policyBytes, "utf8").digest("hex");

    // The same digest, per GATE ORGAN, for the `attested` verdict on the
    // harness files that install the hook (APRV-272). Computed exactly as the
    // policy digest above is — from the blob at the HEAD COMMIT, never from the
    // working tree, so the guard hashes the bytes the pull request carries and
    // not the bytes the machine running CI happens to have. A path the head
    // tree does not carry (a deletion) is `null`, which the guard reads as "no
    // attestation can match", the fail-closed direction.
    const organShaCache = new Map();
    const organSha256AtHead = (path) => {
      if (organShaCache.has(path)) return organShaCache.get(path);
      const blob = showBlob(repo, head, path);
      const value =
        blob === null ? null : createHash("sha256").update(blob, "utf8").digest("hex");
      organShaCache.set(path, value);
      return value;
    };

    // Bound material, from the payload store beside the log that was chosen and
    // then from head's. A grant only reachable in a records branch has its
    // payload only there, and a grant head already carried has it at head.
    const payloadCache = new Map();
    const payloadRefs = source.ref === head ? [head] : [source.ref, head];
    const payloadFor = (hash) => {
      if (payloadCache.has(hash)) return payloadCache.get(hash);
      let value = null;
      for (const ref of payloadRefs) {
        const blob = showBlob(repo, ref, `${PAYLOAD_DIR}/${hash}.json`);
        if (blob === null) continue;
        try {
          value = JSON.parse(blob);
        } catch {
          value = null;
        }
        if (value !== null) break;
      }
      payloadCache.set(hash, value);
      return value;
    };

    // When each protected path last changed in this range: the anchor the
    // recency bound is measured from. Author date, so a rebase does not move it.
    const changeTsCache = new Map();
    const changeTsFor = (path) => {
      if (changeTsCache.has(path)) return changeTsCache.get(path);
      const out = git(repo, [
        "log",
        "-1",
        "--format=%aI",
        `${base}..${head}`,
        "--",
        path,
      ]);
      const value = out === null || out.trim().length === 0 ? null : out.trim();
      changeTsCache.set(path, value);
      return value;
    };

    // The bytes of each protected path at BOTH commits: what the hunk-level
    // coverage check is made of (APRV-202). Read from the trees, never the
    // working copy. A path absent at one end is an add or a delete and is
    // reported as `null` there; a blob the guard cannot read as text (binary,
    // detected by a NUL byte) yields `null` for the whole change, which fails
    // `change-unreadable` rather than falling back to the path-level rule.
    const blobCache = new Map();
    const blobsFor = (path) => {
      if (blobCache.has(path)) return blobCache.get(path);
      const inTree = (ref) => {
        const listed = git(repo, ["ls-tree", "-z", "--name-only", ref, "--", path]);
        return listed !== null && listed.replace(/\0/gu, "").trim().length > 0;
      };
      let value = null;
      const baseHas = inTree(base);
      const headHas = inTree(head);
      const baseText = baseHas ? showBlob(repo, base, path) : null;
      const headText = headHas ? showBlob(repo, head, path) : null;
      const unreadable =
        (baseHas && baseText === null) ||
        (headHas && headText === null) ||
        (baseText !== null && baseText.includes("\u0000")) ||
        (headText !== null && headText.includes("\u0000"));
      if (!unreadable) value = { base: baseText, head: headText };
      blobCache.set(path, value);
      return value;
    };

    const report = guard.evaluateProtectedPaths({
      changedPaths,
      blobsFor,
      records,
      logStatus,
      logDetail,
      policyProtectedPaths,
      policySha256AtHead,
      policyPath: POLICY_PATH,
      organSha256AtHead,
      payloadFor,
      changeTsFor,
      window,
    });

    if (json) {
      process.stdout.write(`${JSON.stringify({ ...report, log_source: logSource }, null, 2)}\n`);
    } else {
      process.stdout.write(`${logSourceLine(source, window.firstSeq)}\n`);
      // Every candidate that was read and set aside for a reason worth acting
      // on is named. The stale records branches that simply end before head
      // are summarized: this repository has dozens of them and they say
      // nothing, while an unverifiable copy says a great deal.
      const diverged = [];
      for (const candidate of logSource.candidates) {
        if (candidate.status === "chosen") continue;
        if (candidate.status === "diverged") {
          diverged.push(candidate.ref);
          continue;
        }
        const seq = candidate.lastSeq === null ? "no records" : `through seq ${candidate.lastSeq}`;
        process.stdout.write(`  candidate ${candidate.ref}: ${candidate.status} (${seq})\n`);
      }
      if (diverged.length > 0) {
        const named = diverged.slice(0, 5).join(", ");
        const more = diverged.length > 5 ? `, and ${diverged.length - 5} more` : "";
        process.stdout.write(
          `  ${diverged.length} candidate ref(s) did not anchor to head's chain and were not read: ${named}${more}\n`,
        );
      }
      process.stdout.write(guard.renderGuardReport(report));
    }

    return report.ok ? EXIT_OK : EXIT_FAIL;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (cause) => {
    process.stderr.write(`protected-path-guard: ${String(cause)}\n`);
    process.exitCode = EXIT_CANNOT_LOOK;
  },
);
