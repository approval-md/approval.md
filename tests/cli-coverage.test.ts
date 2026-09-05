/**
 * `approval coverage` — the verb (APRV-245).
 *
 * The join has its own suite and the sources have theirs; this file is about
 * what an operator actually gets. It drives the compiled CLI against a real
 * repository holding a real log — a fixture built with `git init` and commits,
 * and records appended by `policy attest` and `register` — and pins the four
 * things a reporting verb can get wrong:
 *
 *  1. the table, and the coverage line under it;
 *  2. `--json`, validated against the verb's own registry schema with the
 *     repo's strict Ajv, so a shape change without a schema change fails here;
 *  3. an unavailable source, which must be reported with its reason and never
 *     flattened into an empty answer;
 *  4. the exit codes: 0 with gaps and without, 2 for a usage error.
 *
 * Nothing here writes a log line by hand, and every git command runs inside the
 * temp fixture.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";

import { VERB_REGISTRY, type JsonSchema } from "../src/cli/verb-registry.js";

const addFormats = (addFormatsModule as unknown as { default: FormatsPlugin }).default;

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-cli-coverage-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const PAYLOAD_HASH = "3".repeat(64);

const POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "1h"',
  "  on_expiry: reject",
  "classes:",
  "  vcs.commit.branch:",
  "    autonomy: supervised",
  "  communicate.email.external:",
  "    autonomy: manual",
  "```",
  "",
].join("\n");

const TASK = [
  "---",
  "id: task-042",
  "title: Commit the work",
  "status: In Progress",
  "approval:",
  "  origin:",
  "    app: example-capture",
  '    created_by: "human:carter"',
  "  state: proposed",
  "  actions:",
  "    - class: vcs.commit.branch",
  '      summary: "Commit the fixture"',
  "      reversible: true",
  '      est_cost_usd: "0"',
  '      idempotency_key: "task-042:commit"',
  `      payload_hash: "${PAYLOAD_HASH}"`,
  "---",
  "",
  "## Description",
  "Body.",
  "",
].join("\n");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string): Run {
  const env = { ...process.env };
  delete env["APPROVAL_HUMAN"];
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], { cwd, encoding: "utf8", env });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** git, inside the fixture and nowhere else. */
function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function commit(root: string, path: string, body: string, message: string): string {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body, "utf8");
  git(["add", "--", path], root);
  git(["commit", "-m", message], root);
  return git(["rev-parse", "HEAD"], root);
}

/**
 * A repository with a policy, an attested log, one registered task, and two
 * commits on a local `main`.
 *
 * The log is real: `policy attest` and `register` appended it through the same
 * path every other verb uses. The `task.registered` that `register` wrote
 * declares `vcs.commit.branch`, which is the class the git source gives a
 * commit the trunk does not reach.
 */
function fixture(): { root: string; base: string; head: string } {
  counter += 1;
  const root = join(scratch, `repo-${counter}`);
  mkdirSync(join(root, "backlog", "tasks"), { recursive: true });
  git(["init", "--initial-branch=main"], root);
  git(["config", "user.email", "fixture@example.invalid"], root);
  git(["config", "user.name", "Fixture"], root);
  git(["config", "commit.gpgsign", "false"], root);

  writeFileSync(join(root, "APPROVAL.md"), POLICY, "utf8");
  writeFileSync(join(root, "backlog", "tasks", "task-042.md"), TASK, "utf8");
  const base = commit(root, "a.txt", "one\n", "first");

  assert.equal(runCli(["policy", "attest", "--as", "human:carter"], root).code, 0);
  const registered = runCli(
    ["register", join("backlog", "tasks", "task-042.md"), "--as", "agent:claude"],
    root,
  );
  assert.equal(registered.code, 0, registered.stderr);

  const head = commit(root, "b.txt", "two\n", "second");
  return { root, base, head };
}

function jsonOf(run: Run): Record<string, unknown> {
  const line = run.stdout.trim().split("\n").at(-1) ?? "";
  return JSON.parse(line) as Record<string, unknown>;
}

/** The registry's declared output schema for `coverage`, compiled strictly. */
function coverageValidator(): ValidateFunction {
  const spec = VERB_REGISTRY.find(
    (entry) => entry.name === "coverage" && entry.subcommand === undefined,
  );
  assert.ok(spec !== undefined, "the registry has no `coverage` entry");
  assert.ok(spec.output !== null, "`coverage` declares no output schema");
  const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: true });
  addFormats(ajv);
  return ajv.compile(spec.output as JsonSchema);
}

function describeErrors(fn: ValidateFunction): string {
  return (fn.errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.keyword}: ${error.message ?? ""}`)
    .join("; ");
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

test("the text report is a table of effects and one coverage line per source", () => {
  const { root, base, head } = fixture();
  const run = runCli(["coverage", "--base", base, "--head", head, "--source", "git"], root);
  assert.equal(run.code, 0, run.stderr);

  assert.match(run.stdout, /^source {2,}effect {2,}class {2,}evidence$/mu);
  assert.match(run.stdout, /^git {2,}\w+.* {2,}vcs\.commit\.branch {2,}/mu);
  // The fixture has no remote, so the source qualifies its own answer after an
  // em dash. A qualifier is part of the line by design: the reader has to see
  // that no commit here could be reported as a trunk commit.
  assert.match(run.stdout, /^git: \d+ of \d+ effect\(s\) carry evidence — origin\/main does not resolve/mu);
  assert.match(run.stdout, /^range .*\.\..*, adapter window /mu);
  // The informational rule, printed where the reader is: a gap is a question.
  assert.match(run.stdout, /informational: exit 0 with or without gaps/u);
  assert.ok(!run.stdout.includes("\u001b"), "piped output carried escape codes");
});

test("a commit whose class the log declared cites the record; a gap prints none", () => {
  const { root, base, head } = fixture();
  const covered = runCli(["coverage", "--base", base, "--head", head, "--source", "git"], root);
  assert.equal(covered.code, 0, covered.stderr);
  // The registration declared `vcs.commit.branch` and the commit followed it
  // within seconds, so the evidence is that record's seq.
  assert.match(covered.stdout, /vcs\.commit\.branch {2,}seq \d+ task\.registered/u);
  assert.match(covered.stdout, /^git: 1 of 1 effect\(s\) carry evidence/mu);

  // A tag is `release.publish`, which nothing in this log ever declared.
  git(["tag", "v9.9.9"], root);
  const gapped = runCli(["coverage", "--base", base, "--head", head, "--source", "git"], root);
  // INFORMATIONAL: the gap is reported and the exit code does not move.
  assert.equal(gapped.code, 0, gapped.stderr);
  assert.match(gapped.stdout, /release\.publish {2,}none/u);
  assert.match(gapped.stdout, /^git: 1 of 2 effect\(s\) carry evidence/mu);
});

// ---------------------------------------------------------------------------
// --json, against the registry schema
// ---------------------------------------------------------------------------

test("--json matches the registry's declared output schema", () => {
  const { root, base, head } = fixture();
  const run = runCli(
    ["coverage", "--base", base, "--head", head, "--source", "git", "--json"],
    root,
  );
  assert.equal(run.code, 0, run.stderr);

  const body = jsonOf(run);
  const validate = coverageValidator();
  assert.ok(
    validate(body),
    `live --json does not match the registry schema: ${describeErrors(validate)}\n${JSON.stringify(body)}`,
  );

  assert.equal(body["ok"], true);
  assert.deepEqual(Object.keys(body["window"] as object).sort(), [
    "base",
    "head",
    "since",
    "until",
  ]);
  const sources = body["sources"] as Array<Record<string, unknown>>;
  assert.equal(sources.length, 1);
  assert.equal(sources[0]?.["name"], "git");
  assert.equal(sources[0]?.["available"], true);

  const effects = sources[0]?.["effects"] as Array<Record<string, unknown>>;
  assert.equal(effects.length, 1);
  const effect = effects[0] as Record<string, unknown>;
  assert.equal(effect["class"], "vcs.commit.branch");
  assert.equal(effect["match"], "exact");
  assert.equal(effect["path"], null);
  // Two kinds of proof under one key, with the unused half null.
  const evidence = effect["evidence"] as Record<string, unknown>;
  assert.equal(typeof evidence["seq"], "number");
  assert.equal(evidence["event"], "task.registered");
  assert.equal(evidence["verdict"], null);
});

test("--json still validates when a source is unavailable", () => {
  const { root, base, head } = fixture();
  // No remote and (usually) no auth, so `gh` answers nothing here. Whichever
  // way it fails, the source is reported with its reason rather than as zero
  // effects, and the object shape does not change.
  const run = runCli(
    ["coverage", "--base", base, "--head", head, "--source", "gh", "--json"],
    root,
  );
  assert.equal(run.code, 0, run.stderr);
  const body = jsonOf(run);
  const validate = coverageValidator();
  assert.ok(validate(body), describeErrors(validate));

  const source = (body["sources"] as Array<Record<string, unknown>>)[0];
  assert.equal(source?.["name"], "gh");
  assert.equal(source?.["available"], false);
  assert.equal(typeof source?.["reason"], "string");
  assert.deepEqual(source?.["effects"], []);
  assert.equal(source?.["observed"], 0);
});

test("a vault that will not open makes agentmail unavailable, never an exit code", () => {
  const { root, base, head } = fixture();
  // No vault was ever created here and no passphrase is in the environment, so
  // the adapter cannot read its credentials. The other sources still have
  // answers, and a report that refused to print because one provider was
  // unreachable would be a report people stop running.
  const run = runCli(
    ["coverage", "--base", base, "--head", head, "--source", "git,agentmail", "--json"],
    root,
  );
  assert.equal(run.code, 0, run.stderr);
  const body = jsonOf(run);
  const validate = coverageValidator();
  assert.ok(validate(body), describeErrors(validate));

  const sources = body["sources"] as Array<Record<string, unknown>>;
  const agentmail = sources.find((source) => source["name"] === "agentmail");
  assert.ok(agentmail !== undefined, "the agentmail source is missing from the report");
  assert.equal(agentmail["available"], false);
  assert.equal(typeof agentmail["reason"], "string");
  // The git source's answer is untouched by the other one's failure.
  assert.equal(sources.find((source) => source["name"] === "git")?.["available"], true);
});

test("the text report names an unavailable source and the reason it gave", () => {
  const { root, base, head } = fixture();
  const run = runCli(["coverage", "--base", base, "--head", head, "--source", "gh"], root);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /^gh: unavailable \(.+\)$/mu);
});

// ---------------------------------------------------------------------------
// Usage, help, and writing nothing
// ---------------------------------------------------------------------------

test("an unknown source is a usage error, exit 2, and names the sources there are", () => {
  const { root } = fixture();
  const run = runCli(["coverage", "--source", "gitlab"], root);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /unknown source "gitlab"/u);
  assert.match(run.stderr, /git, gh, agentmail/u);
});

test("a usage error under --json prints one error object and nothing on stdout", () => {
  const { root } = fixture();
  const run = runCli(["coverage", "--source", "gitlab", "--json"], root);
  assert.equal(run.code, 2);
  assert.equal(run.stdout, "");
  const error = (JSON.parse(run.stderr.trim()) as { error: Record<string, unknown> }).error;
  assert.equal(error["code"], "usage");
});

test("an unparseable --since is a usage error rather than a silent default", () => {
  const { root } = fixture();
  const run = runCli(["coverage", "--since", "a fortnight"], root);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /is not a duration/u);
});

test("--help prints the verb's own help and exits 0", () => {
  const { root } = fixture();
  const run = runCli(["coverage", "--help"], root);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /^approval coverage — /u);
  assert.match(run.stdout, /docs\/cli-reference\.md#coverage/u);
});

test("the verb appends nothing to the log it read", () => {
  const { root, base, head } = fixture();
  const logPath = join(root, ".approval", "log", "events.jsonl");
  const before = readFileSync(logPath, "utf8");
  assert.equal(
    runCli(["coverage", "--base", base, "--head", head, "--source", "git"], root).code,
    0,
  );
  assert.equal(readFileSync(logPath, "utf8"), before, "coverage wrote to the log");
  // And the chain it read still verifies, which is the other half of the claim.
  assert.equal(runCli(["log", "verify"], root).code, 0);
});
