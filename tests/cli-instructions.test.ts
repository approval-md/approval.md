/**
 * `approval instructions` and the verb registry (APRV-85).
 *
 * The registry is the ONE source two surfaces read: the CLI prints it, and
 * SPEC.md §10.5's MCP wrapper derives its tool descriptions and input schemas
 * from it. A registry nobody checks against the running CLI is a second list
 * that drifts from the first, so this file pins it from four directions:
 *
 *  1. every schema in the registry compiles under the repo's Ajv setup, strict,
 *     with no flag relaxed (`src/core/validate.ts` is the configuration);
 *  2. **the both-directions pin**: real `--json` output, captured by spawning
 *     the compiled CLI against a temp working directory, validates against the
 *     verb's declared output schema. The existing suites pin the same shapes
 *     with `deepEqual`, so a shape change with no schema change fails HERE and
 *     a schema change with no shape change fails THERE;
 *  3. the human_only markers are asserted verb by verb, because that flag is
 *     what stops a wrapper from offering an agent a verb the runtime will only
 *     refuse;
 *  4. drift detection against `main.ts`: every command in the real dispatch is
 *     in the registry and every registry name is in the dispatch, parsed from
 *     the source rather than from a list maintained beside it.
 *
 * Nothing here writes a log line by hand: every record under test is appended
 * by the real CLI, exactly as the other CLI suites do it.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";

import {
  VERB_REGISTRY,
  verbLabel,
  type JsonSchema,
  type VerbSpec,
} from "../src/cli/verb-registry.js";
import { runPayloadHash } from "../src/core/payload.js";

const addFormats = (addFormatsModule as unknown as { default: FormatsPlugin }).default;

/** dist/tests/cli-instructions.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
/** dist/tests/cli-instructions.test.js -> <repo>/src/cli/main.ts */
const MAIN_SOURCE = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-instructions-")));

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string, env: Record<string, string> = {}): Run {
  const childEnv = { ...process.env, ...env };
  if (env["APPROVAL_HUMAN"] === undefined) delete childEnv["APPROVAL_HUMAN"];
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: childEnv,
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

// ---------------------------------------------------------------------------
// Ajv, configured exactly as the write boundary configures it
// ---------------------------------------------------------------------------

/**
 * The repo's Ajv: draft 2020-12, `strict: true` with no flag relaxed, formats
 * enforced. A registry schema that only compiles with a strict flag turned off
 * is a schema this project would not accept anywhere else.
 */
function compiler(): (schema: JsonSchema) => ValidateFunction {
  const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: true });
  addFormats(ajv);
  return (schema) => ajv.compile(schema);
}

function describeErrors(fn: ValidateFunction): string {
  return (fn.errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.keyword}: ${error.message ?? ""}`)
    .join("; ");
}

function findVerb(label: string): VerbSpec {
  const spec = VERB_REGISTRY.find((candidate) => verbLabel(candidate) === label);
  assert.ok(spec !== undefined, `no registry entry for "${label}"`);
  return spec;
}

// ---------------------------------------------------------------------------
// (a) every schema compiles
// ---------------------------------------------------------------------------

test("registry: every input, output and error schema compiles under strict Ajv", () => {
  const compile = compiler();
  for (const spec of VERB_REGISTRY) {
    const label = verbLabel(spec);
    assert.doesNotThrow(() => compile(spec.input), `input schema for "${label}"`);
    assert.doesNotThrow(() => compile(spec.error), `error schema for "${label}"`);
    if (spec.output !== null) {
      assert.doesNotThrow(() => compile(spec.output as JsonSchema), `output schema for "${label}"`);
    }
  }
});

test("registry: every entry carries a purpose, exit codes, and exit 0", () => {
  for (const spec of VERB_REGISTRY) {
    const label = verbLabel(spec);
    assert.ok(spec.purpose.length > 80, `purpose for "${label}" is too thin to be a paragraph`);
    assert.ok(spec.exit_codes.length > 0, `no exit codes for "${label}"`);
    assert.ok(
      spec.exit_codes.some((entry) => entry.code === 0),
      `"${label}" documents no success code`,
    );
    for (const entry of spec.exit_codes) {
      assert.ok(entry.meaning.length > 0, `exit ${entry.code} of "${label}" has no meaning`);
    }
  }
});

test("registry: the shared error shape accepts both failure forms", () => {
  const compile = compiler();
  const validateError = compile(findVerb("register").error);
  assert.equal(validateError({ error: { code: "usage", message: "unknown flag --jsno" } }), true);
  assert.equal(
    validateError({ ok: false, error: { code: "policy-not-attested", message: "…", detail: "x" } }),
    true,
  );
  assert.equal(validateError({ error: { code: "usage" } }), false);
  assert.equal(validateError({ ok: true, error: { code: "x", message: "y" } }), false);
});

// ---------------------------------------------------------------------------
// (b) the both-directions pin: real --json output validates
// ---------------------------------------------------------------------------

/** The command the captured `run` spawns, and therefore what it binds to. */
const CHILD = [process.execPath, "-e", "0"];

/**
 * APRV-140: `approval run` recomputes the binding from the argv and cwd it will
 * spawn, so the declaration commits to {@link CHILD} rather than to a stand-in.
 */
function taskFile(binding: string): string {
  return [
  "---",
  "id: task-042",
  "title: Chase deposit refund",
  "approval:",
  "  origin:",
  "    app: instructions-test",
  '    created_by: "human:tester"',
  "  route:",
  '    assignee: "agent:probe"',
  "    confidence: 0.8",
  "  state: proposed",
  "  actions:",
  "    - class: communicate.email.external",
  '      summary: "Send the chaser"',
  "      reversible: false",
  '      est_cost_usd: "0.02"',
  '      idempotency_key: "task-042:chaser"',
  `      payload_hash: "${binding}"`,
  "---",
  "",
  "Body.",
  "",
  ].join("\n");
}

const AGENTS_MD = [
  "# Permissions",
  "",
  "## Allowed without prompting",
  "- Read files",
  "",
].join("\n");

/** One captured `--json` answer, with the registry entry it must satisfy. */
interface Capture {
  readonly label: string;
  readonly note: string;
  readonly value: unknown;
}

/**
 * Drive one real working directory end to end and capture every `--json`
 * success object along the way. One world rather than one per verb: the
 * interesting shapes (a token, a granted wait, a completed run) only exist
 * downstream of the ones before them.
 */
function captureLiveOutputs(): Capture[] {
  const dir = join(scratch, "world");
  mkdirSync(dir, { recursive: true });
  // `human:alice` rather than `human:tester` since APRV-137. `approval init`
  // scaffolds a policy whose `communicate.email.external` rule declares
  // `approvers: [alice]`, and that roster now BINDS the grant: before the
  // amendment the list was parsed and enforced nowhere, so any identity could
  // grant, and now one the rule does not name is refused `actor-not-approver`.
  // This world's whole point is reaching a real token, so it drives the
  // scaffolded policy as the person that policy names.
  const env = { APPROVAL_HUMAN: "human:alice" };
  const captures: Capture[] = [];

  const capture = (label: string, note: string, run: Run, stream: "out" | "err" = "out"): void => {
    const text = stream === "out" ? run.stdout : run.stderr;
    const line = text.trim().split("\n").at(-1) ?? "";
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (cause) {
      assert.fail(`"${label}" (${note}) did not print JSON: ${String(cause)}\n${text}`);
    }
    captures.push({ label, note, value });
  };

  capture("init", "fresh directory", runCli(["init", "--json"], dir, env));
  capture("policy attest", "first attestation", runCli(["policy", "attest", "--json"], dir, env));

  writeFileSync(join(dir, "task-042.md"), taskFile(runPayloadHash(CHILD, dir)));
  writeFileSync(join(dir, "payload.json"), '{"to":"b@example.com","subject":"hi"}\n');
  writeFileSync(join(dir, "agents.md"), AGENTS_MD);

  capture("register", "valid envelope", runCli(["register", "task-042.md", "--json"], dir, env));
  capture(
    "request",
    "manual class",
    runCli(["request", "task-042", "--action", "task-042:chaser", "--json"], dir, env),
  );
  capture("queue", "one pending request", runCli(["queue", "--json"], dir, env));
  // A timeout prints its object on stderr: "no answer yet" is not the answer
  // the caller asked for. Same schema, same keys, different stream.
  capture(
    "wait",
    "timeout, still undecided (stderr)",
    runCli(["wait", "task-042", "--timeout", "300ms", "--interval", "50ms", "--json"], dir, env),
    "err",
  );
  capture("status", "healthy system", runCli(["status", "--json"], dir, env));
  // APRV-214: no window open, which is the shape every repository is in until
  // somebody performs the ceremony at a terminal.
  capture("gate status", "no window open", runCli(["gate", "status", "--json"], dir, env));
  capture("log verify", "clean chain", runCli(["log", "verify", "--json"], dir, env));
  capture("log tail", "three records", runCli(["log", "tail", "--json"], dir, env));
  capture("log export", "whole log", runCli(["log", "export", "--json"], dir, env));
  capture("reindex", "clean rebuild", runCli(["reindex", "--json"], dir, env));
  capture("render", "queue projection", runCli(["render", "--json"], dir, env));
  capture(
    "policy check",
    "an autonomous class",
    runCli(["policy", "check", "read.web", "--json"], dir, env),
  );
  capture(
    "policy test",
    "a manual class under the irreversibility floor",
    runCli(
      ["policy", "test", "communicate.email.external", "--reversible", "false", "--json"],
      dir,
      env,
    ),
  );
  capture("payload hash", "a JSON file", runCli(["payload", "hash", "payload.json", "--json"], dir, env));
  capture("env", "--check, no env file", runCli(["env", "--check", "--json"], dir, env));
  capture("vault list", "no vault yet", runCli(["vault", "list", "--json"], dir, env));
  capture("doctor", "eleven checks", runCli(["doctor", "--json"], dir, env));
  capture(
    "hook classify",
    "a read-only command",
    runCli(["hook", "classify", "--json", "--", "ls", "-la"], dir, env),
  );
  capture(
    "import agents-md",
    "one mappable bullet",
    runCli(["import", "agents-md", "agents.md", "--json"], dir, env),
  );

  // The grant is where the token exists; everything below it needs that token.
  const granted = runCli(["grant", "task-042:chaser", "--json"], dir, env);
  capture("grant", "mints the token", granted);
  const token = (JSON.parse(granted.stdout.trim()) as { token: string }).token;

  capture("token", "live and unspent", runCli(["token", "task-042:chaser", "--json"], dir, env));
  capture(
    "wait",
    "decided: granted",
    runCli(["wait", "task-042", "--timeout", "300ms", "--interval", "50ms", "--json"], dir, env),
  );
  capture(
    "run",
    "spends the token; summary on stderr",
    runCli(
      ["run", "task-042:chaser", "--token", token, "--json", "--", ...CHILD],
      dir,
      env,
    ),
    "err",
  );
  capture("log verify", "after the executions", runCli(["log", "verify", "--json"], dir, env));

  return captures;
}

test("registry: real --json output validates against every declared output schema", () => {
  const compile = compiler();
  const captures = captureLiveOutputs();

  for (const item of captures) {
    const spec = findVerb(item.label);
    assert.ok(
      spec.output !== null,
      `"${item.label}" produced a --json object but declares no output schema`,
    );
    const validateOutput = compile(spec.output as JsonSchema);
    assert.ok(
      validateOutput(item.value),
      `live output of "${item.label}" (${item.note}) does not match its registry schema: ${describeErrors(
        validateOutput,
      )}\n${JSON.stringify(item.value)}`,
    );
  }

  // A guard on the guard: a captureLiveOutputs() that silently stopped
  // capturing would make the loop above pass by doing nothing.
  const labels = new Set(captures.map((item) => item.label));
  for (const required of [
    "init",
    "policy attest",
    "register",
    "request",
    "queue",
    "wait",
    "status",
    "log verify",
    "log tail",
    "log export",
    "reindex",
    "render",
    "policy check",
    "policy test",
    "payload hash",
    "env",
    "vault list",
    "doctor",
    "hook classify",
    "gate status",
    "import agents-md",
    "grant",
    "token",
    "run",
  ]) {
    assert.ok(labels.has(required), `no live output was captured for "${required}"`);
  }
});

// ---------------------------------------------------------------------------
// (c) the human_only markers
// ---------------------------------------------------------------------------

const HUMAN_ONLY: readonly string[] = [
  "init",
  "policy attest",
  "policy amend",
  "grant",
  "reject",
  "revoke",
  "expire",
  "execution resolve",
  "execution reconcile",
  "audit review",
  // APRV-127: closing a reconciliation obligation is a human's act by the same
  // rule that makes reviewing one human's. Reading the backlog is not.
  "audit reconcile",
  "channel cli",
  "channel web",
  "channel telegram listen",
  "daemon run",
  // APRV-110. The ambient runtime is `daemon run` and `channel telegram listen`
  // in one process, so it inherits both refusals and cannot be weaker than
  // either: a long-lived writer against the log, holding the channel credential,
  // recording decisions against the human identity in its launch environment.
  "up",
  // APRV-87. The MCP wrapper publishes no human-only verb, so an agent that
  // could start one would gain no authority; what it would gain is a second
  // long-lived writer and a choice of the identity every tool call is recorded
  // under, both of which belong to the operator who launches the process.
  "mcp serve",
  "env",
  "setup identity",
  "setup vault",
  "setup sampling",
  "setup channel",
  "setup adapter",
  // APRV-110. It installs a standing capability: a login service holding a
  // credential that can put prompts in front of a human.
  "setup service",
  "vault set",
  "vault list",
  "vault remove",
  // APRV-214. Opening the window SUSPENDS the policy for every gated tool call
  // under the root, which is the most consequential thing this CLI can do;
  // closing is the other half of the same ceremony. Neither may be published as
  // a tool an agent can call, and `gate open` additionally cannot be performed
  // without a terminal and a typed word.
  "gate open",
  "gate close",
];

const AGENT_FACING: readonly string[] = [
  "instructions",
  "register",
  "request",
  // APRV-106. The one terminal gate verb an agent may run, because it is the
  // requester retracting its OWN question rather than deciding anything. The
  // gate checks the actor against the approval.requested record, so publishing
  // it to agents cannot let one clear someone else's queue.
  "withdraw",
  "wait",
  "run",
  "consume",
  "token",
  "queue",
  "status",
  "log verify",
  "log tail",
  "log export",
  // APRV-125. The two verbs that move the log FILE are agent-facing on purpose:
  // they establish no human authority, and withholding them would put the
  // ritual they replace back into an agent's hands as raw shell. Whether an
  // agent may run one is decided by the policy, through their own classes
  // (`log.sync`, `log.advance`), and not by this marker.
  "log sync",
  "log advance",
  "policy check",
  "policy test",
  "payload hash",
  // APRV-223. The composing half of the AgentMail flow: the agent's own key
  // reads the agent's own draft, before any approval exists, and that key
  // cannot send. What the verb produces is a proposal and no authority.
  "payload agentmail-draft",
  // APRV-195. The ungated channel is agent-facing at both ends. `journal write`
  // has to be, or it is not a channel the party under oversight can rely on;
  // `journal read` is human-FACING and still not human-only, because it
  // establishes no authority and an agent that can read back what it wrote can
  // tell whether the channel is working.
  "journal write",
  "journal read",
  // APRV-239. Human-AUTHORED and agent-FACING, which is the whole point: the
  // words are a person's and the reader is the agent they are about. Publishing
  // it establishes no authority because what it prints decides nothing — an
  // agent that reads `disliked` has learned something about the operator and
  // gained no permission, and one that never reads it is under exactly the same
  // rules (SPEC.md §11.1 invariant 10).
  "feedback",
  "doctor",
  "reindex",
  "render",
  "import agents-md",
  "audit list",
  "audit obligations",
  "channel telegram health",
  "adapter email",
  "adapter agentmail",
  "hook claude-code",
  "hook cursor",
  "hook classify",
  // APRV-214. Reporting the window establishes no authority and changes
  // nothing; an agent that can see a bypass window is standing is better placed
  // than one that cannot.
  "gate status",
];

test("registry: the human-only verbs are marked, and only those", () => {
  for (const label of HUMAN_ONLY) {
    assert.equal(findVerb(label).human_only, true, `"${label}" must be human_only`);
  }
  for (const label of AGENT_FACING) {
    assert.equal(findVerb(label).human_only, false, `"${label}" must not be human_only`);
  }

  // Every verb is accounted for by exactly one of the two lists, so a verb
  // added without a decision about who may call it fails here.
  const decided = new Set([...HUMAN_ONLY, ...AGENT_FACING]);
  for (const spec of VERB_REGISTRY) {
    assert.ok(
      decided.has(verbLabel(spec)),
      `"${verbLabel(spec)}" is in neither the human-only nor the agent-facing list`,
    );
  }
  assert.equal(decided.size, VERB_REGISTRY.length);
});

test("registry: a human_only decision that needed an argument carries its note", () => {
  for (const label of ["expire", "daemon run", "env", "vault list", "channel cli"]) {
    const spec = findVerb(label);
    assert.ok(
      (spec.human_only_note ?? "").length > 0,
      `"${label}" is a judgment call and must record why`,
    );
  }
  for (const label of [
    "adapter email",
    "adapter agentmail",
    "payload agentmail-draft",
    "hook claude-code",
    "hook cursor",
    "consume",
  ]) {
    const spec = findVerb(label);
    assert.equal(spec.human_only, false);
    assert.ok(
      (spec.human_only_note ?? "").length > 0,
      `"${label}" is agent-facing by argument and must record why`,
    );
  }
});

// ---------------------------------------------------------------------------
// (d) the guide, the table, and drift against the real dispatch
// ---------------------------------------------------------------------------

test("instructions: the guide states the agent-facing invariants plainly", () => {
  const run = runCli(["instructions"], scratch);
  assert.equal(run.code, 0);
  const guide = run.stdout;

  for (const phrase of [
    "DECLARE BEFORE YOU ACT",
    "approval register",
    "approval request",
    "approval wait",
    "approval run",
    "never author the clock",
    "APPROVAL.md",
    "append-only",
    "final until a human acts",
    "reduce your own scrutiny",
    "--schemas",
  ]) {
    assert.ok(guide.includes(phrase), `the guide never says "${phrase}"`);
  }
});

test("instructions: the printed table lists every registry entry", () => {
  const run = runCli(["instructions"], scratch);
  assert.equal(run.code, 0);
  for (const spec of VERB_REGISTRY) {
    const label = verbLabel(spec);
    assert.ok(run.stdout.includes(`  ${label} `), `the verb table omits "${label}"`);
  }
  for (const spec of VERB_REGISTRY.filter((candidate) => candidate.human_only)) {
    assert.ok(
      run.stdout.includes("[HUMAN-ONLY]"),
      `the table must mark "${verbLabel(spec)}" human-only`,
    );
  }
});

test("instructions: --json carries the guide and the registry in one object", () => {
  const run = runCli(["instructions", "--json"], scratch);
  assert.equal(run.code, 0);
  const parsed = JSON.parse(run.stdout) as { guide: string; verbs: unknown[] };
  assert.equal(typeof parsed.guide, "string");
  assert.equal(parsed.verbs.length, VERB_REGISTRY.length);
  assert.equal(parsed.guide, runCli(["instructions"], scratch).stdout);
});

test("instructions: --schemas is valid JSON and byte-stable across runs", () => {
  const first = runCli(["instructions", "--schemas"], scratch);
  const second = runCli(["instructions", "--schemas"], scratch);
  assert.equal(first.code, 0);
  assert.equal(first.stdout, second.stdout);

  const parsed = JSON.parse(first.stdout) as { verbs: VerbSpec[] };
  assert.equal(parsed.verbs.length, VERB_REGISTRY.length);
  for (const [index, verb] of parsed.verbs.entries()) {
    const spec = VERB_REGISTRY[index] as VerbSpec;
    assert.equal(verb.name, spec.name);
    assert.equal(verb.subcommand, spec.subcommand);
    assert.equal(verb.human_only, spec.human_only);
    assert.ok(verb.input !== undefined, `${verbLabel(spec)} lost its input schema`);
    assert.ok(verb.error !== undefined, `${verbLabel(spec)} lost its error shape`);
    assert.ok(verb.exit_codes.length > 0);
  }
});

test("instructions: --help and an unexpected argument", () => {
  const help = runCli(["instructions", "--help"], scratch);
  assert.equal(help.code, 0);
  assert.ok(help.stdout.startsWith("approval instructions —"));

  const bad = runCli(["instructions", "verbs"], scratch);
  assert.equal(bad.code, 2);

  const badJson = runCli(["instructions", "--jsno"], scratch);
  assert.equal(badJson.code, 2);
});

/** The top-level dispatch of `main()`, read from the source. */
function dispatchedCommands(): Set<string> {
  const source = readFileSync(MAIN_SOURCE, "utf8");
  // `main` became async in APRV-209 (every verb is reached through a dynamic
  // import), so the signature is matched rather than spelled out.
  const signature = /export (?:async )?function main\(/u.exec(source);
  const start = signature?.index ?? -1;
  assert.ok(start > 0, "could not find main() in main.ts");
  const body = source.slice(start);
  const found = new Set<string>();
  for (const match of body.matchAll(/case "([a-z-]+)":/g)) {
    found.add(match[1] as string);
  }
  return found;
}

test("registry: no verb in the dispatch is missing from the registry, and vice versa", () => {
  const dispatched = dispatchedCommands();
  assert.ok(dispatched.size > 20, "the dispatch parse found suspiciously few commands");

  const registered = new Set(VERB_REGISTRY.map((spec) => spec.name));
  for (const command of dispatched) {
    assert.ok(registered.has(command), `\`approval ${command}\` is dispatched but not in the registry`);
  }
  for (const name of registered) {
    assert.ok(dispatched.has(name), `the registry names "${name}", which main() does not dispatch`);
  }
});
