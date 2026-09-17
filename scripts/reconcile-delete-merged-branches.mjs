#!/usr/bin/env node
/**
 * APRV-318: delete the merged, unowned remote branches the 2026-09-08
 * reconciliation inventory named, and nothing else.
 *
 * Two earlier attempts at this deletion burned their grants without removing a
 * single ref (2026-09-09 handover, "Two burned operations"): execution start
 * 30359 went indeterminate at 30360 because an existing `core.hooksPath=hooks`
 * made git refuse before the push, and the driver that ran it swallowed the
 * diagnostic. All 233 refs were still present afterwards with unchanged tips.
 * This driver exists so the third attempt is the last one, so it is shaped by
 * what went wrong rather than by what was convenient:
 *
 *   - It never touches the hook configuration. It reads `core.hooksPath`,
 *     reports it, and refuses when it names a directory that is not there,
 *     which is the exact condition that produced the indeterminate outcome.
 *     A driver that "fixed" the problem by passing `-c core.hooksPath=` would
 *     be disabling the repository's own pre-push checks to get its push
 *     through, which is the opposite of what this repository is for.
 *   - It is hash-bound. Every candidate must still be at the tip the inventory
 *     recorded, proved by a fresh `ls-remote` before the run and again
 *     immediately before each batch, and each delete additionally carries
 *     `--force-with-lease=<ref>:<sha>` so the server refuses a ref that moved
 *     inside the remaining window. There is no `--force`, no `-f` and no `+`
 *     refspec anywhere in this file.
 *   - It refuses on any drift rather than deleting the subset it still agrees
 *     with. A tip that moved since the inventory is new information about the
 *     branch, and the answer to new information is a human reading it.
 *   - Each batch is a single `--atomic` push: the batch lands whole or not at
 *     all, so a failure leaves a state that can be described in one sentence.
 *   - `--execute` only runs inside a granted execution. See `assertGranted`.
 *
 * Usage:
 *
 *   node scripts/reconcile-delete-merged-branches.mjs --plan
 *   approval run <action-key> --token <t> -- \
 *     node scripts/reconcile-delete-merged-branches.mjs --execute \
 *       --action-key <action-key>
 *
 * `--plan` is read-only: it fetches no objects and mutates nothing, it only
 * lists refs on the remote and prints the manifest it would push. Run it first
 * and read it. `--execute` without a live grant refuses with exit 5 and
 * changes nothing.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readVerifiedRecords } from "../dist/src/core/state.js";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

/**
 * The checkout every git command runs in and every default path hangs off.
 *
 * The script's own repository by default, which is what Carter wants when he
 * runs this from the primary. `--repo <path>` moves it, which is how the tests
 * exercise the whole read-only path against a throwaway remote without
 * depending on this machine's git configuration or on the real origin.
 */
let repoRoot = REPO_ROOT;

/** Where the durable inventory lives, relative to the repository root. */
const DEFAULT_INVENTORY = "docs/repository-reconciliation-2026-09-08.json";

/** The committed log, relative to the checkout the grant was opened in. */
const DEFAULT_LOG = ".approval/log/events.jsonl";

/**
 * The one branch the inventory marks deletable that this driver will never
 * delete. It was excluded by hand during the 2026-09-08 reconciliation as
 * owned work, and the exclusion is restated here rather than left to whoever
 * reads the JSON, because 233 and 234 differ by exactly this name.
 */
const EXCLUDED = new Map([
  [
    "claude/approval-signals-human-values-f0cf71",
    "excluded by hand during the 2026-09-08 reconciliation as owned work",
  ],
]);

/**
 * Names this driver refuses to consider whatever the inventory says, as a
 * second independent check on the inventory rather than a restatement of it.
 */
const NEVER_DELETE = /^(main|master|gh-pages|HEAD)$|^records-log-/u;

/** How many deletes go in one atomic push. */
const DEFAULT_BATCH = 50;

/**
 * How recently the granted execution must have started, in milliseconds.
 *
 * The check below wants evidence that `approval run` started US, not evidence
 * that some execution for this action key started at some point. A window
 * bounds how stale that evidence may be; it is generous enough for a plan
 * readback inside the same execution and short enough that a record from an
 * earlier, abandoned attempt cannot authorize this one.
 */
const GRANT_WINDOW_MS = 15 * 60 * 1000;

/** Exit codes, matching the CLI's own vocabulary where they overlap. */
const EXIT_OK = 0;
const EXIT_REFUSED = 1;
const EXIT_USAGE = 2;
const EXIT_UNGRANTED = 5;

class Refusal extends Error {
  constructor(code, message, exitCode = EXIT_REFUSED) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

// ---------------------------------------------------------------------------
// git, always as argv, never through a shell
// ---------------------------------------------------------------------------

function git(args, { cwd = repoRoot, allowFailure = false } = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) {
    throw new Refusal("git-unavailable", `git could not be run: ${result.error.message}`);
  }
  if (!allowFailure && result.status !== 0) {
    const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new Refusal(
      "git-failed",
      `git ${args.join(" ")} exited ${String(result.status)}${detail === "" ? "" : `\n${detail}`}`,
    );
  }
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

/**
 * A branch name this driver is willing to put in a refspec.
 *
 * Deliberately narrow. Anything with a space, a leading dash, a `+`, a `:`, a
 * `^`, a `~`, a `?`, a `*`, a `[`, a backslash or a control character is
 * refused rather than escaped, because the safe move for a name this driver
 * does not fully understand is not to push it.
 */
export function isSafeBranchName(name) {
  if (typeof name !== "string" || name.length === 0 || name.length > 255) return false;
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/")) return false;
  if (name.startsWith(".") || name.endsWith(".") || name.endsWith(".lock")) return false;
  if (name.includes("..") || name.includes("//") || name.includes("@{")) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(name);
}

function isSha(value) {
  return typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
}

export function loadInventory(path) {
  if (!existsSync(path)) {
    throw new Refusal("inventory-missing", `inventory ${path} does not exist`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new Refusal("inventory-unparseable", `inventory ${path} is not JSON: ${String(cause)}`);
  }
  const refs = parsed?.remote_refs;
  if (!Array.isArray(refs) || refs.length === 0) {
    throw new Refusal("inventory-empty", `inventory ${path} has no remote_refs array`);
  }

  const candidates = [];
  const excluded = [];
  for (const entry of refs) {
    if (entry?.disposition !== "pending-gated-deletion") continue;
    const { name, sha } = entry;
    if (!isSafeBranchName(name)) {
      throw new Refusal(
        "inventory-unsafe-name",
        `inventory names a branch this driver will not put in a refspec: ${JSON.stringify(name)}`,
      );
    }
    if (!isSha(sha)) {
      throw new Refusal(
        "inventory-unsafe-sha",
        `inventory entry ${name} has no full 40-hex tip: ${JSON.stringify(sha)}`,
      );
    }
    if (NEVER_DELETE.test(name)) {
      throw new Refusal(
        "inventory-protected-name",
        `inventory marks a protected ref for deletion: ${name}. Nothing was pushed; this is an inventory bug, not a drift.`,
      );
    }
    const reason = EXCLUDED.get(name);
    if (reason !== undefined) {
      excluded.push({ name, sha, reason });
      continue;
    }
    candidates.push({ name, sha });
  }

  if (candidates.length === 0) {
    throw new Refusal("inventory-no-candidates", `inventory ${path} marks nothing for deletion`);
  }
  const seen = new Set();
  for (const { name } of candidates) {
    if (seen.has(name)) {
      throw new Refusal("inventory-duplicate", `inventory lists ${name} twice`);
    }
    seen.add(name);
  }
  candidates.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { candidates, excluded, base: parsed.base ?? null, date: parsed.date ?? null };
}

// ---------------------------------------------------------------------------
// Remote state
// ---------------------------------------------------------------------------

function remoteHeads(remote) {
  const listed = git(["ls-remote", "--heads", "--", remote]);
  const heads = new Map();
  for (const line of listed.stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const [sha, ref] = trimmed.split(/\s+/u);
    if (!isSha(sha) || typeof ref !== "string" || !ref.startsWith("refs/heads/")) continue;
    heads.set(ref.slice("refs/heads/".length), sha);
  }
  if (heads.size === 0) {
    throw new Refusal("remote-empty", `${remote} reported no heads; refusing to act on an empty listing`);
  }
  return heads;
}

/**
 * Compare the inventory against the remote as it is right now.
 *
 * Three outcomes per candidate, and only one of them is a delete: the ref is
 * still exactly where the inventory left it (delete), the ref is already gone
 * (skip, and say so), or the ref is there at a different tip (drift, refuse).
 */
export function reconcile(candidates, heads) {
  const deletable = [];
  const gone = [];
  const drifted = [];
  for (const candidate of candidates) {
    const actual = heads.get(candidate.name);
    if (actual === undefined) {
      gone.push(candidate);
      continue;
    }
    if (actual !== candidate.sha) {
      drifted.push({ ...candidate, actual });
      continue;
    }
    deletable.push(candidate);
  }
  return { deletable, gone, drifted };
}

// ---------------------------------------------------------------------------
// Ownership and hooks
// ---------------------------------------------------------------------------

/** Branch names checked out in any worktree of this repository. */
function checkedOutBranches() {
  const listed = git(["worktree", "list", "--porcelain"]);
  const branches = new Set();
  for (const line of listed.stdout.split("\n")) {
    if (!line.startsWith("branch ")) continue;
    const ref = line.slice("branch ".length).trim();
    if (ref.startsWith("refs/heads/")) branches.add(ref.slice("refs/heads/".length));
  }
  return branches;
}

/**
 * Read the effective hook configuration without changing it.
 *
 * `core.hooksPath` pointing at a directory that is not there is the exact
 * shape of the 2026-09-09 failure, so it is a refusal and not a warning: a
 * pre-push hook that should have run and did not is a gate that did not
 * happen. The path is resolved against the repository root when it is
 * relative, which is how git resolves it.
 */
function hookConfiguration() {
  const configured = git(["config", "--get", "core.hooksPath"], { allowFailure: true });
  if (configured.status !== 0) {
    return { hooksPath: null, resolved: null, present: true };
  }
  const raw = configured.stdout.trim();
  if (raw === "") return { hooksPath: null, resolved: null, present: true };
  const resolved = isAbsolute(raw) ? raw : join(repoRoot, raw);
  let present = false;
  try {
    present = statSync(resolved).isDirectory();
  } catch {
    present = false;
  }
  return { hooksPath: raw, resolved, present };
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

/**
 * Refuse unless this process is running inside a live granted execution.
 *
 * What this check is NOT: a read of `APPROVAL_TOKEN` from the environment.
 * That variable is not a usable signal here and pretending otherwise would be
 * theatre. `approval run` hands the child a scrubbed environment
 * (`src/core/child-env.ts`): every `APPROVAL_`-prefixed name outside the small
 * non-secret allowlist is REMOVED before the spawn, precisely so that a
 * granted child cannot read the gate's credentials back out. A driver that
 * required `APPROVAL_TOKEN` to be set would therefore refuse the real wrapper
 * and accept anyone who exported the variable by hand, which is exactly
 * backwards. This is called out in the task notes as a deliberate divergence
 * from the brief's wording.
 *
 * What it is instead: proof in the log of a human decision and of the wrapper
 * acting on it. Both are gate-typed events that only the runtime appends. So
 * the driver requires, for the action key it was given:
 *
 *   0. a live `approval.granted` record, not withdrawn, rejected, revoked or
 *      expired since. This one is not redundant. `approval.granted` is
 *      exclusive to the MANUAL path, and today's policy resolves
 *      `git push --delete` to `vcs.push.main`, which is supervised-retro: a
 *      bulk ref deletion classified from the command line would proceed with
 *      nobody asked. Requiring the grant record means this driver acts only on
 *      a decision a person actually made,
 *   1. an `execution.started` record for that exact key,
 *   2. no terminal record (`completed`, `failed`, `indeterminate`,
 *      `reconciled`) after it, so the execution is still open, and
 *   3. a start within `GRANT_WINDOW_MS`, so a record from one of the two
 *      burned attempts cannot be replayed into authority for this one.
 *
 * An agent cannot forge any of that: it would have to append a gate-typed
 * event to the committed log, which is what the whole repository is built to
 * prevent. Run the script by hand and it refuses with exit 5, having done
 * nothing.
 */
function assertGranted({ actionKey, logPath, now }) {
  if (actionKey === null) {
    throw new Refusal(
      "execute-needs-action-key",
      "--execute requires --action-key <key>: the key of the granted action this run is executing. Nothing was pushed.",
      EXIT_USAGE,
    );
  }
  if (!existsSync(logPath)) {
    throw new Refusal(
      "execute-log-missing",
      `--execute needs the committed log to prove a live grant, and ${logPath} does not exist. Run this from the primary checkout, or pass --log <path>. Nothing was pushed.`,
      EXIT_UNGRANTED,
    );
  }

  const read = readVerifiedRecords(logPath);
  if (read.ok !== true) {
    throw new Refusal(
      "execute-log-unverified",
      `--execute needs a verified log and ${logPath} did not verify: ${read.message}. Nothing was pushed.`,
      EXIT_UNGRANTED,
    );
  }

  let granted = null;
  let started = null;
  for (const record of read.records) {
    if (record.action_key !== actionKey) continue;
    switch (record.event) {
      case "approval.granted":
        granted = record;
        break;
      case "approval.rejected":
      case "approval.revoked":
      case "approval.expired":
      case "approval.withdrawn":
        granted = null;
        break;
      case "execution.started":
        started = record;
        break;
      case "execution.completed":
      case "execution.failed":
      case "execution.indeterminate":
      case "execution.reconciled":
        started = null;
        break;
      default:
        break;
    }
  }

  // A human decision, not merely an execution. `approval.granted` is exclusive
  // to the manual path, which is the point: today's policy resolves
  // `git push --delete` to `vcs.push.main`, supervised-retro, so a bulk ref
  // deletion classified from the command line would proceed without anyone
  // being asked. This driver will not act on that. The envelope for this
  // action declares a class the policy table does not list, which fails closed
  // to `defaults.autonomy: manual`, and the record below is the tap.
  if (granted === null) {
    throw new Refusal(
      "execute-no-grant",
      `no live approval.granted for action key ${actionKey} in ${logPath}. A 233-ref deletion is a decision a person makes; register an envelope whose action resolves manual, request it, and let the grant land before running this. Nothing was pushed.`,
      EXIT_UNGRANTED,
    );
  }

  if (started === null) {
    throw new Refusal(
      "execute-not-granted",
      `no open execution.started for action key ${actionKey} in ${logPath}. This driver only runs inside \`approval run <key> --token <t> -- node scripts/reconcile-delete-merged-branches.mjs --execute --action-key <key>\`, and it refuses to delete anything outside one. Nothing was pushed.`,
      EXIT_UNGRANTED,
    );
  }

  const startedAt = Date.parse(started.ts ?? "");
  if (!Number.isFinite(startedAt)) {
    throw new Refusal(
      "execute-grant-undated",
      `execution.started seq ${String(started.seq)} for ${actionKey} has no readable timestamp. Nothing was pushed.`,
      EXIT_UNGRANTED,
    );
  }
  const age = now - startedAt;
  if (age < 0 || age > GRANT_WINDOW_MS) {
    throw new Refusal(
      "execute-grant-stale",
      `execution.started seq ${String(started.seq)} for ${actionKey} began ${String(Math.round(age / 1000))}s ago, outside the ${String(GRANT_WINDOW_MS / 1000)}s window this driver accepts. Request a fresh grant rather than reusing an old record. Nothing was pushed.`,
      EXIT_UNGRANTED,
    );
  }

  return { seq: started.seq, ts: started.ts, grantSeq: granted.seq, head: read.head };
}

// ---------------------------------------------------------------------------
// Manifest and push
// ---------------------------------------------------------------------------

export function batches(deletable, size) {
  const out = [];
  for (let index = 0; index < deletable.length; index += size) {
    out.push(deletable.slice(index, index + size));
  }
  return out;
}

/**
 * The argv for one atomic batch delete.
 *
 * `--atomic` so the batch lands whole or not at all. One
 * `--force-with-lease=<ref>:<sha>` per ref so the SERVER refuses any ref whose
 * tip moved after the pre-flight listing, which closes the window the
 * listing on its own leaves open. The refspecs are bare `:refs/heads/<name>`
 * deletions: no `+`, no `--force`, no `-f`.
 */
export function batchArgv(remote, batch) {
  const argv = ["push", "--atomic", "--porcelain"];
  for (const { name, sha } of batch) {
    argv.push(`--force-with-lease=refs/heads/${name}:${sha}`);
  }
  argv.push("--", remote);
  for (const { name } of batch) {
    argv.push(`:refs/heads/${name}`);
  }
  return argv;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    mode: null,
    repo: null,
    inventory: null,
    remote: "origin",
    batchSize: DEFAULT_BATCH,
    actionKey: null,
    logPath: null,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Refusal("usage", `${arg} expects a value`, EXIT_USAGE);
      }
      index += 1;
      return value;
    };
    switch (arg) {
      case "--plan":
        options.mode = "plan";
        break;
      case "--execute":
        options.mode = "execute";
        break;
      case "--repo":
        options.repo = resolve(next());
        break;
      case "--inventory":
        options.inventory = resolve(next());
        break;
      case "--remote":
        options.remote = next();
        break;
      case "--batch-size": {
        const value = Number.parseInt(next(), 10);
        if (!Number.isInteger(value) || value < 1 || value > 200) {
          throw new Refusal("usage", "--batch-size expects 1..200", EXIT_USAGE);
        }
        options.batchSize = value;
        break;
      }
      case "--action-key":
        options.actionKey = next();
        break;
      case "--log":
        options.logPath = resolve(next());
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        options.mode = "help";
        break;
      default:
        throw new Refusal("usage", `unknown argument ${JSON.stringify(arg)}`, EXIT_USAGE);
    }
  }
  if (options.mode === null) {
    throw new Refusal("usage", "one of --plan or --execute is required", EXIT_USAGE);
  }
  repoRoot = options.repo ?? REPO_ROOT;
  options.inventory ??= join(repoRoot, DEFAULT_INVENTORY);
  options.logPath ??= join(repoRoot, DEFAULT_LOG);
  return options;
}

const HELP = `reconcile-delete-merged-branches.mjs — APRV-318

  --plan                  read-only: list the remote, compare it to the
                          inventory, print the exact manifest, push nothing
  --execute               perform the deletion; refuses unless a live
                          approval.granted and an open execution.started for
                          --action-key are both in the log
  --action-key <key>      the granted action key (required by --execute)
  --repo <path>           the checkout git runs in, default this script's own
  --inventory <path>      default ${DEFAULT_INVENTORY}
  --log <path>            default ${DEFAULT_LOG} under the repository root
  --remote <name>         default origin
  --batch-size <n>        refs per atomic push, default ${String(DEFAULT_BATCH)}
  --json                  machine-readable report on stdout

Run --plan first and read the manifest. Nothing here deletes anything without
a human grant: --execute requires a live approval.granted for --action-key and
an open execution.started under it, both of which only the runtime appends.

The action's class must resolve MANUAL. Note that \`git push --delete\`
classifies vcs.push.main, which this repository's policy makes supervised-retro,
so a deletion classified from the command line would proceed with nobody asked.
The envelope therefore declares a class the policy table does not list, which
fails closed to defaults.autonomy: manual.

  # 1. read the manifest
  node scripts/reconcile-delete-merged-branches.mjs --plan

  # 2. envelope on the task file, payload bound to the exact command:
  #      argv ["node","scripts/reconcile-delete-merged-branches.mjs",
  #            "--execute","--action-key","<key>"]
  #      cwd  the primary checkout
  #    payload_hash is the SHA-256 of that object's RFC 8785 serialization;
  #    \`approval payload hash <file>\` computes it.

  approval register "backlog/tasks/<file>.md" --as agent:<session>
  approval request APRV-318 --action "<key>" --as agent:<session> --payload <file>
  approval wait APRV-318 --timeout 6h
  approval run "<key>" --token <t> --as agent:<session> -- \\
    node scripts/reconcile-delete-merged-branches.mjs --execute --action-key <key>
`;

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === "help") {
    process.stdout.write(HELP);
    return EXIT_OK;
  }

  // The authorization check comes first in `--execute`, before the inventory
  // is read and before the remote is contacted: an ungranted run should spend
  // nothing and touch nothing, and the refusal should not depend on the state
  // of anything else.
  const grant =
    options.mode === "execute"
      ? assertGranted({
          actionKey: options.actionKey,
          logPath: options.logPath,
          now: Date.now(),
        })
      : null;

  const inventory = loadInventory(options.inventory);

  /**
   * Conditions that must be false before anything is pushed.
   *
   * `--plan` collects them, prints the whole manifest anyway and ends
   * non-zero: a plan run is read-only, and the useful answer to "why can this
   * not run yet" is the list of reasons next to the list of refs, not a bare
   * refusal with the manifest withheld. `--execute` refuses on the first one.
   */
  const blockers = [];

  const hooks = hookConfiguration();
  if (hooks.hooksPath !== null && !hooks.present) {
    blockers.push({
      code: "hooks-path-absent",
      message: `core.hooksPath is ${hooks.hooksPath} (resolved ${hooks.resolved}) and that directory is not there. This is the condition that made the 2026-09-09 attempt indeterminate: git refuses before the push, and a pre-push check that should have run did not. Restore the directory or clear the setting deliberately; this driver will not override it.`,
    });
  }

  const heads = remoteHeads(options.remote);
  const { deletable, gone, drifted } = reconcile(inventory.candidates, heads);

  const checkedOut = checkedOutBranches();
  const owned = deletable.filter(({ name }) => checkedOut.has(name));
  if (owned.length > 0) {
    blockers.push({
      code: "candidate-checked-out",
      message: `these candidates are checked out in a worktree of this repository and will not be deleted: ${owned.map(({ name }) => name).join(", ")}.`,
    });
  }
  if (drifted.length > 0) {
    blockers.push({
      code: "tip-drift",
      message:
        `${String(drifted.length)} ref(s) are no longer at the tip the inventory recorded:\n` +
        drifted
          .map(({ name, sha, actual }) => `    ${name}\n      inventory ${sha}\n      remote    ${actual}`)
          .join("\n") +
        `\n  A moved tip is new information about the branch. Re-run the reconciliation and produce a fresh inventory rather than deleting the subset this driver still agrees with.`,
    });
  }

  const plan = batches(deletable, options.batchSize);
  const report = {
    mode: options.mode,
    remote: options.remote,
    inventory: { path: options.inventory, base: inventory.base, date: inventory.date },
    hooks,
    counts: {
      inventory_pending: inventory.candidates.length + inventory.excluded.length,
      excluded: inventory.excluded.length,
      candidates: inventory.candidates.length,
      deletable: deletable.length,
      already_gone: gone.length,
      drifted: drifted.length,
      batches: plan.length,
    },
    excluded: inventory.excluded,
    deletable,
    already_gone: gone,
    drifted,
    blockers,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      `inventory ${options.inventory}\n` +
        `  base ${String(inventory.base)} (${String(inventory.date)})\n` +
        `  marked for deletion: ${String(inventory.candidates.length + inventory.excluded.length)}\n` +
        `  excluded by hand:    ${String(inventory.excluded.length)}\n` +
        inventory.excluded.map(({ name, reason }) => `    ${name} — ${reason}\n`).join("") +
        `  candidates:          ${String(inventory.candidates.length)}\n` +
        `remote ${options.remote}: ${String(heads.size)} heads\n` +
        `  still at the recorded tip: ${String(deletable.length)}\n` +
        `  already gone:              ${String(gone.length)}\n` +
        `  drifted:                   ${String(drifted.length)}\n` +
        `core.hooksPath: ${hooks.hooksPath === null ? "(unset)" : `${hooks.hooksPath} -> ${hooks.resolved}`}\n` +
        `\nmanifest (${String(plan.length)} atomic batch(es) of up to ${String(options.batchSize)}):\n` +
        plan
          .map(
            (batch, index) =>
              `  batch ${String(index + 1)}/${String(plan.length)}, ${String(batch.length)} ref(s)\n` +
              batch.map(({ name, sha }) => `    ${sha}  :refs/heads/${name}\n`).join(""),
          )
          .join("") +
        (gone.length === 0
          ? ""
          : `\nalready gone (no push needed):\n${gone.map(({ name }) => `    ${name}\n`).join("")}`) +
        (blockers.length === 0
          ? "\nno blockers.\n"
          : `\nblockers (${String(blockers.length)}), all of which stop --execute:\n${blockers
              .map(({ code, message }) => `  ${code}: ${message}\n`)
              .join("")}`),
    );
  }

  if (options.mode === "plan") {
    process.stdout.write(
      blockers.length === 0
        ? `\nplan only: nothing was pushed.\n`
        : `\nplan only: nothing was pushed, and --execute would refuse today.\n`,
    );
    return blockers.length === 0 ? EXIT_OK : EXIT_REFUSED;
  }

  if (blockers.length > 0) {
    const first = blockers[0];
    throw new Refusal(first.code, `${first.message}\nNothing was pushed.`);
  }

  process.stdout.write(
    `\ngranted: approval.granted seq ${String(grant.grantSeq)}, execution.started seq ${String(grant.seq)} at ${String(grant.ts)} for ${options.actionKey}\n`,
  );

  if (deletable.length === 0) {
    process.stdout.write("nothing left to delete.\n");
    return EXIT_OK;
  }

  let deleted = 0;
  for (const [index, batch] of plan.entries()) {
    // Re-prove every tip immediately before the push, so the window between
    // the pre-flight listing and this batch is as small as it can be. The
    // per-ref lease closes what is left of it on the server.
    const fresh = remoteHeads(options.remote);
    for (const { name, sha } of batch) {
      const actual = fresh.get(name);
      if (actual === undefined) continue;
      if (actual !== sha) {
        throw new Refusal(
          "tip-drift-midrun",
          `${name} moved to ${actual} between the pre-flight listing and batch ${String(index + 1)}. ${String(deleted)} ref(s) were deleted in earlier batches; this batch was not pushed.`,
        );
      }
    }

    const argv = batchArgv(options.remote, batch);
    process.stdout.write(
      `\nbatch ${String(index + 1)}/${String(plan.length)}: git ${argv.slice(0, 3).join(" ")} … ${String(batch.length)} ref(s)\n`,
    );
    const pushed = git(argv, { allowFailure: true });
    process.stdout.write(pushed.stdout);
    if (pushed.status !== 0) {
      process.stderr.write(pushed.stderr);
      throw new Refusal(
        "push-failed",
        `batch ${String(index + 1)} exited ${String(pushed.status)}. It was atomic, so none of its ${String(batch.length)} ref(s) were deleted. ${String(deleted)} ref(s) were deleted in earlier batches. The stderr above is the diagnostic the 2026-09-09 driver swallowed; do not retry blindly, re-run --plan and read it.`,
      );
    }
    deleted += batch.length;
  }

  process.stdout.write(`\ndeleted ${String(deleted)} ref(s) on ${options.remote}.\n`);

  const after = remoteHeads(options.remote);
  const survivors = deletable.filter(({ name }) => after.has(name));
  if (survivors.length > 0) {
    throw new Refusal(
      "post-check-survivors",
      `${String(survivors.length)} ref(s) are still present after a push that reported success: ${survivors.map(({ name }) => name).join(", ")}. Report this rather than retrying.`,
    );
  }
  process.stdout.write(`post-check: none of the ${String(deleted)} deleted ref(s) are still on ${options.remote}.\n`);
  return EXIT_OK;
}

// Importable, and the CLI runs only when this file is the entry point, so a
// test can exercise the pure halves without listing a remote or pushing
// anything. Same shape as `scripts/run-tests.mjs`.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    if (error instanceof Refusal) {
      process.stderr.write(`refused (${error.code}): ${error.message}\n`);
      process.exitCode = error.exitCode;
    } else {
      throw error;
    }
  }
}
