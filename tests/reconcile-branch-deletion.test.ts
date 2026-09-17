/**
 * The APRV-318 branch-deletion driver (`scripts/reconcile-delete-merged-branches.mjs`).
 *
 * The property under test is what the driver REFUSES. Two earlier attempts at
 * this deletion burned their grants and removed nothing, so a driver that
 * deletes the right refs on a good day is not the deliverable; a driver that
 * cannot be talked into deleting anything on a bad day is. The cases below are
 * therefore the bad days: no grant, a stale grant, a tip that moved, a
 * protected name smuggled into the inventory, a hook directory that is not
 * there. One case covers the good day, against a throwaway remote.
 *
 * The script is spawned rather than imported, for the same reason
 * `classify-tier.test.ts` spawns its subject: what a human will run is the
 * process, and an argv or exit-code regression is exactly the kind of thing a
 * unit-level import does not catch. `--repo` points every git command at a
 * scratch checkout, so no case depends on this machine's git configuration or
 * touches the real origin.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { runPayloadHash } from "../src/core/payload.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DRIVER = join(REPO_ROOT, "scripts", "reconcile-delete-merged-branches.mjs");

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function git(args: readonly string[], cwd: string): Run {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr ?? ""}`);
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function driver(args: readonly string[]): Run {
  const result = spawnSync(process.execPath, [DRIVER, ...args], { encoding: "utf8" });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** A scratch remote with three branches, and a clone wired to it. */
function scratch(): {
  readonly dir: string;
  readonly remote: string;
  readonly work: string;
  readonly tips: Map<string, string>;
} {
  const dir = mkdtempSync(join(tmpdir(), "aprv318-"));
  const remote = join(dir, "remote.git");
  const work = join(dir, "work");
  mkdirSync(work, { recursive: true });

  git(["init", "-q", "--bare", "-b", "main", remote], dir);
  git(["init", "-q", "-b", "main", "."], work);
  git(["config", "user.email", "test@example.invalid"], work);
  git(["config", "user.name", "Test"], work);
  writeFileSync(join(work, "seed.txt"), "seed\n");
  git(["add", "-A"], work);
  git(["commit", "-qm", "seed"], work);
  git(["remote", "add", "origin", remote], work);
  git(["push", "-q", "-u", "origin", "main"], work);

  const tips = new Map<string, string>();
  for (const name of ["merged-a", "merged-b", "merged-c"]) {
    git(["checkout", "-q", "-b", name, "main"], work);
    writeFileSync(join(work, `${name}.txt`), `${name}\n`);
    git(["add", "-A"], work);
    git(["commit", "-qm", name], work);
    git(["push", "-q", "origin", name], work);
    tips.set(name, git(["rev-parse", "HEAD"], work).stdout.trim());
  }
  git(["checkout", "-q", "main"], work);
  return { dir, remote, work, tips };
}

function inventoryAt(
  dir: string,
  entries: readonly { name: string; sha: string; disposition?: string }[],
): string {
  const path = join(dir, "inventory.json");
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        task: "APRV-318",
        date: "2026-09-08",
        base: "0".repeat(40),
        remote_refs: entries.map((entry) => ({
          name: entry.name,
          sha: entry.sha,
          merged: true,
          reason: "merged-unowned",
          disposition: entry.disposition ?? "pending-gated-deletion",
        })),
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

test("plan lists the manifest, reports no blockers and pushes nothing", () => {
  const { dir, remote, work, tips } = scratch();
  try {
    const inventory = inventoryAt(dir, [
      { name: "merged-a", sha: tips.get("merged-a") ?? "" },
      { name: "merged-b", sha: tips.get("merged-b") ?? "" },
    ]);
    const run = driver(["--plan", "--repo", work, "--inventory", inventory, "--remote", remote]);

    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /still at the recorded tip: 2/u);
    assert.match(run.stdout, /drifted:\s+0/u);
    assert.match(run.stdout, /no blockers\./u);
    assert.match(run.stdout, /plan only: nothing was pushed\./u);
    assert.match(run.stdout, new RegExp(`:refs/heads/merged-a`, "u"));

    // Read-only means read-only: every ref is still there afterwards.
    const after = git(["ls-remote", "--heads", "--", remote], work).stdout;
    assert.match(after, /refs\/heads\/merged-a/u);
    assert.match(after, /refs\/heads\/merged-b/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tip that moved since the inventory blocks the whole run, not just that ref", () => {
  const { dir, remote, work, tips } = scratch();
  try {
    const inventory = inventoryAt(dir, [
      { name: "merged-a", sha: tips.get("merged-a") ?? "" },
      { name: "merged-b", sha: "0".repeat(39) + "1" },
    ]);
    const run = driver(["--plan", "--repo", work, "--inventory", inventory, "--remote", remote]);

    assert.equal(run.status, 1);
    assert.match(run.stdout, /drifted:\s+1/u);
    assert.match(run.stdout, /tip-drift/u);
    // The manifest is still printed: a plan run's job is to explain, and the
    // refs it would have deleted are half the explanation.
    assert.match(run.stdout, /:refs\/heads\/merged-a/u);
    assert.match(run.stdout, /--execute would refuse today/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a protected name in the inventory is refused before the remote is contacted", () => {
  const { dir, remote, work, tips } = scratch();
  try {
    const inventory = inventoryAt(dir, [
      { name: "main", sha: tips.get("merged-a") ?? "" },
    ]);
    const run = driver(["--plan", "--repo", work, "--inventory", inventory, "--remote", remote]);

    assert.equal(run.status, 1);
    assert.match(run.stderr, /inventory-protected-name/u);
    assert.match(run.stderr, /Nothing was pushed/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a records-log delivery ref is protected by name even when the inventory marks it", () => {
  const { dir, remote, work, tips } = scratch();
  try {
    const inventory = inventoryAt(dir, [
      { name: "records-log-2026-09-16", sha: tips.get("merged-a") ?? "" },
    ]);
    const run = driver(["--plan", "--repo", work, "--inventory", inventory, "--remote", remote]);

    assert.equal(run.status, 1);
    assert.match(run.stderr, /inventory-protected-name/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a branch name the driver cannot safely put in a refspec is refused", () => {
  const { dir, remote, work, tips } = scratch();
  try {
    const inventory = inventoryAt(dir, [
      { name: "--force", sha: tips.get("merged-a") ?? "" },
    ]);
    const run = driver(["--plan", "--repo", work, "--inventory", inventory, "--remote", remote]);

    assert.equal(run.status, 1);
    assert.match(run.stderr, /inventory-unsafe-name/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing hooks directory blocks execute and is reported by plan", () => {
  const { dir, remote, work, tips } = scratch();
  try {
    git(["config", "core.hooksPath", join(dir, "hooks-that-are-not-there")], work);
    const inventory = inventoryAt(dir, [{ name: "merged-a", sha: tips.get("merged-a") ?? "" }]);
    const run = driver(["--plan", "--repo", work, "--inventory", inventory, "--remote", remote]);

    assert.equal(run.status, 1);
    assert.match(run.stdout, /hooks-path-absent/u);
    assert.match(run.stdout, /--execute would refuse today/u);

    // And the setting itself is untouched: the driver reads it, never writes it.
    const still = git(["config", "--get", "core.hooksPath"], work).stdout.trim();
    assert.equal(still, join(dir, "hooks-that-are-not-there"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a present hooks directory is not a blocker", () => {
  const { dir, remote, work, tips } = scratch();
  try {
    const hooks = join(dir, "hooks");
    mkdirSync(hooks, { recursive: true });
    git(["config", "core.hooksPath", hooks], work);
    const inventory = inventoryAt(dir, [{ name: "merged-a", sha: tips.get("merged-a") ?? "" }]);
    const run = driver(["--plan", "--repo", work, "--inventory", inventory, "--remote", remote]);

    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /no blockers\./u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("execute without an action key is a usage error and contacts nothing", () => {
  const run = driver(["--execute"]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /execute-needs-action-key/u);
  assert.match(run.stderr, /Nothing was pushed/u);
});

test("execute without a human grant refuses with the ungranted code", () => {
  const { dir, remote, work, tips } = scratch();
  try {
    const inventory = inventoryAt(dir, [{ name: "merged-a", sha: tips.get("merged-a") ?? "" }]);
    const log = join(dir, "empty-events.jsonl");
    writeFileSync(log, "");
    const run = driver([
      "--execute",
      "--action-key",
      "aprv-318-delete-233:act",
      "--repo",
      work,
      "--inventory",
      inventory,
      "--remote",
      remote,
      "--log",
      log,
    ]);

    assert.equal(run.status, 5);
    // The grant is checked before the execution record, because a human
    // decision is the thing this action actually needs.
    assert.match(run.stderr, /execute-no-grant/u);
    assert.match(run.stderr, /Nothing was pushed/u);

    // Nothing was deleted, which is the only claim that matters here.
    const after = git(["ls-remote", "--heads", "--", remote], work).stdout;
    assert.match(after, /refs\/heads\/merged-a/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a real grant with no started execution is still refused, and the two checks are independent", () => {
  const { dir, remote, work, tips } = scratch();
  try {
    // A real gate instance, built through the real CLI: no log line in this
    // test is written by hand. CLAUDE.md's rule about fabricated log entries
    // applies to tests as much as to anything else.
    const gate = join(dir, "gate");
    mkdirSync(gate, { recursive: true });
    const cli = join(REPO_ROOT, "dist", "src", "cli", "main.js");
    const approval = (args: readonly string[]): Run => {
      const result = spawnSync(process.execPath, [cli, ...args], { cwd: gate, encoding: "utf8" });
      return {
        status: result.status ?? -1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    };

    const init = approval(["init", "--dir", gate, "--json"]);
    assert.equal(init.status, 0, init.stderr);
    const log = join(gate, ".approval", "log", "events.jsonl");
    const policy = join(gate, "APPROVAL.md");

    // A scaffolded policy is not an operative one: a human attests it first,
    // and the gate refuses `policy-not-attested` until they have.
    const attested = approval([
      "policy",
      "attest",
      "--policy",
      policy,
      "--dir",
      gate,
      "--as",
      "human:test",
      "--json",
    ]);
    assert.equal(attested.status, 0, attested.stderr);

    const key = "aprv-318-delete-merged:test";
    // A manual action's envelope MUST carry the payload hash (SPEC §6.2), and
    // for `approval run` the payload is exactly the child argv and its cwd. So
    // the grant binds the one command, which is the shape Carter's runbook
    // uses too.
    const childArgv = ["node", "scripts/reconcile-delete-merged-branches.mjs", "--execute", "--action-key", key];
    const payload = { argv: childArgv, cwd: gate };
    const payloadFile = join(gate, "payload.json");
    writeFileSync(payloadFile, JSON.stringify(payload));
    const taskFile = join(gate, "task.md");
    writeFileSync(
      taskFile,
      [
        "---",
        "id: APRV-318T",
        "title: scratch deletion",
        "approval:",
        "  origin:",
        "    app: manual",
        "    created_by: 'agent:test'",
        "  state: proposed",
        "  actions:",
        "    - class: vcs.ref.delete.bulk",
        "      summary: 'delete merged refs on a scratch remote'",
        "      reversible: false",
        // A string, not a number: envelope.schema.json says so, and a
        // number here is the refusal `envelope-invalid` at /est_cost_usd.
        "      est_cost_usd: '0'",
        `      idempotency_key: '${key}'`,
        `      payload_hash: '${runPayloadHash(childArgv, gate)}'`,
        "---",
        "",
        "scratch",
        "",
      ].join("\n"),
    );

    const registered = approval(["register", taskFile, "--as", "agent:test", "--log", log]);
    assert.equal(registered.status, 0, registered.stderr);
    const requested = approval([
      "request",
      "APRV-318T",
      "--action",
      key,
      "--as",
      "agent:test",
      "--payload",
      payloadFile,
      "--policy",
      policy,
      "--dir",
      gate,
      "--log",
      log,
    ]);
    assert.equal(requested.status, 0, requested.stderr);
    const granted = approval([
      "grant",
      key,
      "--as",
      "human:test",
      "--policy",
      policy,
      "--log",
      log,
      "--note",
      "scratch",
    ]);
    assert.equal(granted.status, 0, granted.stderr);

    const inventory = inventoryAt(dir, [{ name: "merged-a", sha: tips.get("merged-a") ?? "" }]);
    const run = driver([
      "--execute",
      "--action-key",
      key,
      "--repo",
      work,
      "--inventory",
      inventory,
      "--remote",
      remote,
      "--log",
      log,
    ]);

    // The grant is real and the driver still refuses: a decision is necessary
    // and not sufficient, because nothing has started this process under it.
    assert.equal(run.status, 5);
    assert.match(run.stderr, /execute-not-granted/u);
    const after = git(["ls-remote", "--heads", "--", remote], work).stdout;
    assert.match(after, /refs\/heads\/merged-a/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("execute refuses when the log it was pointed at is not there", () => {
  const run = driver([
    "--execute",
    "--action-key",
    "aprv-318-delete-233:act",
    "--log",
    join(tmpdir(), "aprv318-no-such-log.jsonl"),
  ]);
  assert.equal(run.status, 5);
  assert.match(run.stderr, /execute-log-missing/u);
});

test("the pushed argv carries a per-ref lease and no force flag", async () => {
  const module: {
    batchArgv: (remote: string, batch: readonly { name: string; sha: string }[]) => string[];
    batches: <T>(items: readonly T[], size: number) => T[][];
    isSafeBranchName: (name: unknown) => boolean;
  } = await import(join(REPO_ROOT, "scripts", "reconcile-delete-merged-branches.mjs"));

  const argv = module.batchArgv("origin", [
    { name: "merged-a", sha: "a".repeat(40) },
    { name: "merged-b", sha: "b".repeat(40) },
  ]);

  assert.deepEqual(argv, [
    "push",
    "--atomic",
    "--porcelain",
    `--force-with-lease=refs/heads/merged-a:${"a".repeat(40)}`,
    `--force-with-lease=refs/heads/merged-b:${"b".repeat(40)}`,
    "--",
    "origin",
    ":refs/heads/merged-a",
    ":refs/heads/merged-b",
  ]);
  // The lease is a conditional, the force flags are not. Neither the blanket
  // force nor a `+` refspec may ever appear here.
  assert.equal(
    argv.some((word) => word === "--force" || word === "-f" || word.startsWith("+")),
    false,
  );

  assert.deepEqual(module.batches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.equal(module.isSafeBranchName("feature/ok-1.2"), true);
  assert.equal(module.isSafeBranchName("-rf"), false);
  assert.equal(module.isSafeBranchName("a b"), false);
  assert.equal(module.isSafeBranchName("a..b"), false);
  assert.equal(module.isSafeBranchName("a@{0}"), false);
  assert.equal(module.isSafeBranchName("x.lock"), false);
});
