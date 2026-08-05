/**
 * `approval policy check|test` end-to-end tests (APRV-12).
 *
 * As in `cli.test.ts`, every case spawns the real compiled CLI as a child
 * process: the contract under test is what an agent observes — exit code,
 * stdout bytes, stderr bytes — and an in-process call would test none of it.
 * The `--json` shapes are frozen public API and are asserted with `deepEqual`
 * on the whole object, not by spot-checking fields.
 *
 * The exit-code stance is the point of several cases here: a policy that fails
 * to load is answered, not errored. `exit 0` plus
 * `manualBecause: "load-failure"` is the contract, and it is pinned so that no
 * later change can quietly turn a fail-closed answer into something callers
 * are tempted to retry around. Exit 4 stays what it is elsewhere in this CLI:
 * a path that exists and cannot be read.
 *
 * The repository's own `APPROVAL.md` is read **in place** via `--dir`. It is
 * never copied and never written: the file this repo lives under is a fixture
 * only in the read-only sense.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_SCHEMA_DIR } from "../src/core/validate.js";

/** dist/tests/cli-policy.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
/** <repo>/schema/.. -> <repo> — the real policy file, read where it lives. */
const REPO_ROOT = join(DEFAULT_SCHEMA_DIR, "..");
const REPO_POLICY = join(REPO_ROOT, "APPROVAL.md");

// realpath: on macOS the temp dir is reached through a /var -> /private/var
// symlink, and the CLI reports the path it actually read (process.cwd() is
// already resolved). Comparing traces byte for byte requires the resolved form.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-cli-policy-")));
const restoreOnExit: string[] = [];
let counter = 0;

after(() => {
  for (const path of restoreOnExit) {
    try {
      chmodSync(path, 0o644);
    } catch {
      // Already gone or already writable; nothing to do.
    }
  }
  rmSync(scratch, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string): Run {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function caseDir(): string {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write an APPROVAL.md with the given policy block body into a fresh dir. */
function policyDir(block: string): { dir: string; path: string } {
  const dir = caseDir();
  const path = join(dir, "APPROVAL.md");
  writeFileSync(path, `# Policy\n\n\`\`\`yaml approval-policy\n${block}\n\`\`\`\n`, "utf8");
  return { dir, path };
}

const SIMPLE_POLICY = [
  'version: "0.1"',
  "defaults:",
  "  autonomy: supervised",
  "classes:",
  "  read.*: { autonomy: autonomous }",
  "  deps.add: { autonomy: manual }",
].join("\n");

function isRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

// ---------------------------------------------------------------------------
// --json shapes (frozen)
// ---------------------------------------------------------------------------

test("a clean rule match answers with the full explanation object", () => {
  const { dir, path } = policyDir(SIMPLE_POLICY);
  const run = runCli(["policy", "check", "read.web", "--json"], dir);

  assert.equal(run.code, 0);
  assert.equal(run.stderr, "");
  assert.deepEqual(JSON.parse(run.stdout), {
    class: "read.web",
    reversible: null,
    outcome: { autonomy: "autonomous", approvers: null, limits: null },
    provenance: "rule",
    manualBecause: null,
    loadFailure: null,
    matched: { pattern: "read.*", rule: { autonomy: "autonomous" } },
    overridden: null,
    candidates: [
      {
        pattern: "read.*",
        specificity: [1, 1, 2],
        autonomy: "autonomous",
        winner: true,
        tieBreak: "specificity",
      },
    ],
    decisionPath: [
      'class "read.web"; reversible: not stated',
      `policy loaded from ${path}`,
      '1 rule(s) matched "read.web", most specific first:',
      "  read.* [literals=1 wildcards=1 segments=2] -> autonomous (winner; tie-break: specificity)",
      "winner: read.* -> autonomous (strictly the most specific match)",
      "final: autonomous",
    ],
  });
});

test("--reversible false engages the floor and records what it overrode", () => {
  const { dir, path } = policyDir(SIMPLE_POLICY);
  const run = runCli(["policy", "check", "read.web", "--reversible", "false", "--json"], dir);

  assert.equal(run.code, 0);
  assert.equal(run.stderr, "");
  assert.deepEqual(JSON.parse(run.stdout), {
    class: "read.web",
    reversible: false,
    outcome: { autonomy: "manual", approvers: null, limits: null },
    provenance: "floor",
    manualBecause: "irreversibility-floor",
    loadFailure: null,
    matched: { pattern: "read.*", rule: { autonomy: "autonomous" } },
    overridden: { pattern: "read.*", autonomy: "autonomous" },
    candidates: [
      {
        pattern: "read.*",
        specificity: [1, 1, 2],
        autonomy: "autonomous",
        winner: true,
        tieBreak: "specificity",
      },
    ],
    decisionPath: [
      'class "read.web"; reversible: false',
      `policy loaded from ${path}`,
      '1 rule(s) matched "read.web", most specific first:',
      "  read.* [literals=1 wildcards=1 segments=2] -> autonomous (winner; tie-break: specificity)",
      "winner: read.* -> autonomous (strictly the most specific match)",
      "irreversibility floor (SPEC §7): reversible: false overrides read.* (autonomous) -> manual",
      "final: manual",
    ],
  });
});

test("an unmatched class falls to defaults.autonomy", () => {
  const { dir, path } = policyDir(SIMPLE_POLICY);
  const run = runCli(["policy", "test", "physical.order", "--json"], dir);

  assert.equal(run.code, 0);
  assert.equal(run.stderr, "");
  assert.deepEqual(JSON.parse(run.stdout), {
    class: "physical.order",
    reversible: null,
    outcome: { autonomy: "supervised", approvers: null, limits: null },
    provenance: "default",
    manualBecause: null,
    loadFailure: null,
    matched: null,
    overridden: null,
    candidates: [],
    decisionPath: [
      'class "physical.order"; reversible: not stated',
      `policy loaded from ${path}`,
      'no class rule matched "physical.order"',
      "no rule matched; defaults.autonomy -> supervised",
      "final: supervised",
    ],
  });
});

test("a missing policy is answered, not errored: exit 0 and load-failure", () => {
  const dir = caseDir();
  const run = runCli(["policy", "check", "read.web", "--json"], dir);

  // The load failed; the question did not. Pinning both halves of that claim.
  assert.equal(run.code, 0);
  assert.equal(run.stderr, "");
  const answer = JSON.parse(run.stdout) as Record<string, unknown>;
  assert.equal(answer["manualBecause"], "load-failure");
  assert.deepEqual(answer["outcome"], {
    autonomy: "manual",
    approvers: null,
    limits: null,
  });
  assert.equal(answer["provenance"], "fail-closed");
  assert.deepEqual(answer["candidates"], []);
  assert.equal(answer["matched"], null);
  const failure = answer["loadFailure"] as { code: string; message: string };
  assert.equal(failure.code, "file-missing");
  assert.match(failure.message, /no policy file found/u);
});

test("a schema-invalid policy is the same fail-closed answer, still exit 0", () => {
  const { dir } = policyDir(
    ['version: "0.1"', "classes:", "  read.web: { autonomy: sometimes }"].join("\n"),
  );
  const run = runCli(["policy", "check", "read.web", "--json"], dir);

  assert.equal(run.code, 0);
  assert.equal(run.stderr, "");
  const answer = JSON.parse(run.stdout) as Record<string, unknown>;
  assert.equal(answer["manualBecause"], "load-failure");
  assert.equal(answer["provenance"], "fail-closed");
  assert.equal((answer["loadFailure"] as { code: string }).code, "schema-invalid");
});

test("an unparseable YAML block is a fail-closed answer, not a failure", () => {
  const { dir } = policyDir(['version: "0.1"', "classes:", "  read.web: [unclosed"].join("\n"));
  const run = runCli(["policy", "check", "read.web", "--json"], dir);

  assert.equal(run.code, 0);
  assert.equal((JSON.parse(run.stdout) as Record<string, unknown>)["manualBecause"], "load-failure");
});

// ---------------------------------------------------------------------------
// Human output
// ---------------------------------------------------------------------------

test("human output is the trace followed by the answer, stderr silent", () => {
  const { dir } = policyDir(SIMPLE_POLICY);
  const run = runCli(["policy", "check", "deps.add"], dir);

  assert.equal(run.code, 0);
  assert.equal(run.stderr, "");
  const lines = run.stdout.trimEnd().split("\n");
  assert.equal(lines[0], 'class "deps.add"; reversible: not stated');
  assert.equal(lines.at(-1), "-> manual");
  assert.ok(lines.some((line) => line.startsWith("winner: deps.add")));
});

test("the final human line carries the floor and fail-closed markers", () => {
  const { dir } = policyDir(SIMPLE_POLICY);
  const floored = runCli(["policy", "check", "read.web", "--reversible", "false"], dir);
  assert.equal(floored.code, 0);
  assert.equal(
    floored.stdout.trimEnd().split("\n").at(-1),
    "-> manual (floor applied over read.*: autonomous)",
  );

  const broken = runCli(["policy", "check", "read.web"], caseDir());
  assert.equal(broken.code, 0);
  assert.equal(broken.stdout.trimEnd().split("\n").at(-1), "-> manual (fail-closed: file-missing)");
  assert.equal(broken.stderr, "");
});

test("check and test are the same command", () => {
  const { dir } = policyDir(SIMPLE_POLICY);
  const check = runCli(["policy", "check", "read.web", "--json"], dir);
  const alias = runCli(["policy", "test", "read.web", "--json"], dir);

  assert.equal(alias.code, check.code);
  assert.equal(alias.stdout, check.stdout);
});

// ---------------------------------------------------------------------------
// Path selection
// ---------------------------------------------------------------------------

test("--policy reads a named file and --dir picks the search directory", () => {
  const { dir, path } = policyDir(SIMPLE_POLICY);
  const elsewhere = caseDir();

  const byFile = runCli(["policy", "check", "read.web", "--policy", path, "--json"], elsewhere);
  assert.equal(byFile.code, 0);
  assert.equal((JSON.parse(byFile.stdout) as Record<string, unknown>)["provenance"], "rule");

  const byDir = runCli(["policy", "check", "read.web", "--dir", dir, "--json"], elsewhere);
  assert.equal(byDir.code, 0);
  assert.equal(byDir.stdout, byFile.stdout);
});

test("an unreadable policy path is I/O (exit 4), never a parse failure", { skip: isRoot() }, () => {
  const { dir, path } = policyDir(SIMPLE_POLICY);
  chmodSync(path, 0o000);
  restoreOnExit.push(path);

  const run = runCli(["policy", "check", "read.web", "--policy", path], dir);
  assert.equal(run.code, 4);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /not readable/u);
  assert.ok(
    !/corrupt/iu.test(run.stderr),
    "a permission bit is not evidence of a damaged policy",
  );
});

// ---------------------------------------------------------------------------
// Usage errors
// ---------------------------------------------------------------------------

test("usage errors exit 2", () => {
  const { dir } = policyDir(SIMPLE_POLICY);

  const noClass = runCli(["policy", "check"], dir);
  assert.equal(noClass.code, 2);
  assert.match(noClass.stderr, /missing <class>/u);

  const badFlag = runCli(["policy", "check", "read.web", "--jsno"], dir);
  assert.equal(badFlag.code, 2);
  assert.match(badFlag.stderr, /unknown flag --jsno/u);

  const badClass = runCli(["policy", "check", "Read.WEB"], dir);
  assert.equal(badClass.code, 2);
  assert.match(badClass.stderr, /not a valid action class/u);
  assert.equal(badClass.stdout, "");

  const wildcard = runCli(["policy", "check", "read.*"], dir);
  assert.equal(wildcard.code, 2);

  const badReversible = runCli(["policy", "check", "read.web", "--reversible", "maybe"], dir);
  assert.equal(badReversible.code, 2);
  assert.match(badReversible.stderr, /--reversible expects true or false/u);

  const noSub = runCli(["policy"], dir);
  assert.equal(noSub.code, 2);
  assert.match(noSub.stderr, /missing subcommand/u);

  const badSub = runCli(["policy", "explain", "read.web"], dir);
  assert.equal(badSub.code, 2);
  assert.match(badSub.stderr, /unknown subcommand/u);
});

test("--json usage errors print the error object on stderr only", () => {
  const { dir } = policyDir(SIMPLE_POLICY);
  const run = runCli(["policy", "check", "Read.WEB", "--json"], dir);

  assert.equal(run.code, 2);
  assert.equal(run.stdout, "");
  const parsed = JSON.parse(run.stderr) as { error: { code: string; message: string } };
  assert.equal(parsed.error.code, "usage");
  assert.match(parsed.error.message, /not a valid action class/u);
});

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

test("help documents the exit codes and the three manualBecause values", () => {
  const { dir } = policyDir(SIMPLE_POLICY);

  for (const args of [
    ["policy", "--help"],
    ["policy", "check", "--help"],
    ["policy", "test", "--help"],
  ]) {
    const run = runCli(args, dir);
    assert.equal(run.code, 0, args.join(" "));
    assert.equal(run.stderr, "", args.join(" "));

    // The exit-code stance, stated where an agent will read it.
    assert.match(run.stdout, /0 {2}the question was answered/u, args.join(" "));
    assert.match(run.stdout, /broken\n?\s*policy IS a manual-everything policy/u, args.join(" "));
    assert.match(run.stdout, /2 {2}usage/u, args.join(" "));
    assert.match(run.stdout, /4 {2}I\/O/u, args.join(" "));

    // The three ways an answer becomes manual.
    assert.match(run.stdout, /"matched-rule"/u, args.join(" "));
    assert.match(run.stdout, /"irreversibility-floor"/u, args.join(" "));
    assert.match(run.stdout, /"load-failure"/u, args.join(" "));
  }
});

test("the per-verb help names the alias and the JSON shape", () => {
  const { dir } = policyDir(SIMPLE_POLICY);
  const check = runCli(["policy", "check", "--help"], dir);
  assert.match(check.stdout, /exact alias of `policy test`/u);
  assert.match(check.stdout, /"decisionPath"/u);

  const alias = runCli(["policy", "test", "--help"], dir);
  assert.match(alias.stdout, /exact alias of `policy check`/u);
});

test("the root help lists the policy command", () => {
  const { dir } = policyDir(SIMPLE_POLICY);
  const run = runCli(["--help"], dir);

  assert.equal(run.code, 0);
  assert.match(run.stdout, /approval policy check\|test <class>/u);
  assert.match(run.stdout, /policy {4}explain what APPROVAL\.md does/u);
});

// ---------------------------------------------------------------------------
// The repository's own policy, read in place
// ---------------------------------------------------------------------------

test("this repo's APPROVAL.md gates its own classes as written", () => {
  const cwd = caseDir();
  const ask = (actionClass: string): Record<string, unknown> => {
    const run = runCli(["policy", "check", actionClass, "--dir", REPO_ROOT, "--json"], cwd);
    assert.equal(run.code, 0, `${actionClass}: ${run.stderr}`);
    assert.equal(run.stderr, "");
    return JSON.parse(run.stdout) as Record<string, unknown>;
  };

  const deps = ask("deps.add");
  assert.deepEqual(deps["outcome"], { autonomy: "manual", approvers: null, limits: null });
  assert.equal(deps["manualBecause"], "matched-rule");
  assert.deepEqual(deps["matched"], { pattern: "deps.add", rule: { autonomy: "manual" } });
  assert.ok(
    (deps["decisionPath"] as string[]).includes(`policy loaded from ${REPO_POLICY}`),
    "the repo policy must be read in place, not copied",
  );

  const read = ask("read.web");
  assert.equal((read["outcome"] as { autonomy: string }).autonomy, "autonomous");
  assert.equal(read["manualBecause"], null);

  const push = ask("vcs.push.main");
  assert.equal((push["outcome"] as { autonomy: string }).autonomy, "supervised");
  assert.equal(push["manualBecause"], null);
  assert.deepEqual(push["matched"], {
    pattern: "vcs.push.main",
    rule: { autonomy: "supervised" },
  });
});

test("an irreversible action under this repo's policy is floored to manual", () => {
  const run = runCli(
    ["policy", "check", "read.web", "--reversible", "false", "--dir", REPO_ROOT, "--json"],
    caseDir(),
  );

  assert.equal(run.code, 0);
  const answer = JSON.parse(run.stdout) as Record<string, unknown>;
  assert.equal(answer["manualBecause"], "irreversibility-floor");
  assert.deepEqual(answer["overridden"], { pattern: "read.*", autonomy: "autonomous" });
});
