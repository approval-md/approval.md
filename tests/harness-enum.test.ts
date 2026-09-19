/**
 * One list of harnesses, enumerated in six places (APRV-358).
 *
 * `grok` shipped an adapter in APRV-243 and never reached the event schema's
 * `payload.harness` enum, the verb registry or the MCP exclusions. The adapter
 * classified and denied correctly the whole time, so nothing looked broken;
 * what a Grok session could not do was REGISTER. A manual-class action wrote
 * `harness: "grok"` onto `task.registered`, the write boundary refused the
 * record, and the request never reached a human. Eleven days, no failing test.
 *
 * This suite is the test that would have failed. It takes
 * {@link HARNESS_KINDS} as the source of truth and asserts set-equality
 * against every other place a harness name is written down, plus the
 * end-to-end fact those lists exist to serve: for each of the five kinds, a
 * manual-class tool call through that harness's own dialect appends
 * `task.registered` and `approval.requested` to a real log, through the real
 * append path, and `approval log verify` accepts the result.
 *
 * Nothing here writes a log line by hand.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { classifyCommand } from "../src/core/command-class.js";
import { DEFAULT_SCHEMA_DIR } from "../src/core/validate.js";
import { HARNESS_ADAPTERS } from "../src/cli/hook.js";
import { HOOK_HELP } from "../src/cli/help.js";
import { VERB_REGISTRY } from "../src/cli/verb-registry.js";
import { EXCLUDED_VERBS } from "../src/mcp/server.js";
import { HARNESS_BINARY, HARNESS_KINDS, type HarnessKind } from "../src/core/harness-version.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
// Derived from the schema directory rather than from this file, because this
// file runs compiled from `dist/tests` and `schema/` is not copied there.
const REPO_ROOT = join(DEFAULT_SCHEMA_DIR, "..");

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-harness-enum-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const KINDS = [...HARNESS_KINDS].sort();

// ---------------------------------------------------------------------------
// AC2 — the enumerations, pinned equal
// ---------------------------------------------------------------------------

test("the event schema's harness enum is exactly the harness kinds this runtime speaks", () => {
  const schema = JSON.parse(
    readFileSync(join(DEFAULT_SCHEMA_DIR, "event.schema.json"), "utf8"),
  ) as Record<string, unknown>;
  const properties = schema["properties"] as Record<string, Record<string, unknown>>;
  const payload = properties["payload"] as Record<string, Record<string, unknown>> | undefined;
  assert.ok(payload !== undefined, "the event schema has no payload property");
  const harness = payload["properties"]?.["harness"] as Record<string, unknown> | undefined;
  assert.ok(harness !== undefined, "the event schema does not constrain payload.harness");
  const enumerated = harness["enum"];
  assert.ok(Array.isArray(enumerated), "payload.harness has no enum");
  // Set-equality, in both directions. A kind in the schema and not in the
  // runtime is a record nothing here can write; a kind in the runtime and not
  // in the schema is a record the write boundary refuses, which is the bug
  // this task was filed for.
  assert.deepEqual([...(enumerated as string[])].sort(), KINDS);
});

test("the adapter table is keyed by harness kind, and each adapter agrees with its key", () => {
  assert.deepEqual(Object.keys(HARNESS_ADAPTERS).sort(), KINDS);
  for (const kind of HARNESS_KINDS) {
    const adapter = HARNESS_ADAPTERS[kind];
    assert.equal(adapter.kind, kind, `the adapter filed under ${kind} calls itself ${adapter.kind}`);
    // `origin_app` and the default proposing identity are both derived from the
    // kind by convention. Pinning the convention keeps a sixth adapter from
    // inventing a spelling that a log reader would have to learn separately.
    assert.equal(adapter.originApp, `${kind}-hook`);
    assert.equal(adapter.defaultActor, `agent:${kind}`);
  }
});

test("every harness kind is a `approval hook` subcommand the CLI answers", () => {
  for (const kind of HARNESS_KINDS) {
    const run = spawnSync(process.execPath, [CLI_ENTRY, "hook", kind, "--help"], {
      cwd: scratch,
      encoding: "utf8",
    });
    assert.equal(run.status, 0, `\`approval hook ${kind} --help\` failed: ${run.stderr}`);
    assert.doesNotMatch(run.stderr, /unknown subcommand/u);
  }
  const unknown = spawnSync(process.execPath, [CLI_ENTRY, "hook", "gemini", "--help"], {
    cwd: scratch,
    encoding: "utf8",
  });
  assert.equal(unknown.status, 2, "a harness this runtime does not speak is a usage error");
  assert.match(unknown.stderr, /unknown subcommand/u);
});

test("the verb registry publishes one `hook` verb per harness kind", () => {
  const subcommands = VERB_REGISTRY.filter((spec) => spec.name === "hook")
    .map((spec) => spec.subcommand)
    .filter((sub): sub is string => typeof sub === "string" && sub !== "classify")
    .sort();
  assert.deepEqual(subcommands, KINDS);
});

test("every harness hook verb is withheld from MCP, and only harness hook verbs are", () => {
  for (const kind of HARNESS_KINDS) {
    const reason = EXCLUDED_VERBS.get(`hook ${kind}`);
    assert.ok(
      reason !== undefined,
      `\`hook ${kind}\` reads one event from stdin and must not be published as an MCP tool`,
    );
    assert.match(reason, /stdin/u);
  }
  const excludedHooks = [...EXCLUDED_VERBS.keys()]
    .filter((label) => label.startsWith("hook "))
    .map((label) => label.slice("hook ".length))
    .sort();
  assert.deepEqual(excludedHooks, KINDS);
});

test("the hook help names every harness kind, in its usage line and its command list", () => {
  const usage = HOOK_HELP.split("\n").find((line) => line.includes("approval hook claude-code"));
  assert.ok(usage !== undefined, "no usage line for the harness subcommands");
  for (const kind of HARNESS_KINDS) {
    assert.ok(usage.includes(kind), `the usage line does not offer \`${kind}\``);
    assert.match(HOOK_HELP, new RegExp(`^  ${kind}\\s`, "mu"), `no help row for \`${kind}\``);
  }
});

test("every harness kind's binary carries a launch class, under the launch vocabulary", () => {
  // The launch classes (APRV-354) use a DIFFERENT vocabulary on purpose:
  // `harness.launch.claude`, because the class names a binary and the binary is
  // `claude`, while the harness kind names a protocol and that is `claude-code`.
  // The map below is the whole of the difference, written out so that a sixth
  // harness has to decide which name its class carries rather than inherit one
  // by accident.
  const launchName: Readonly<Record<HarnessKind, string>> = {
    "claude-code": "claude",
    cursor: "cursor",
    codex: "codex",
    grok: "grok",
    muse: "muse",
  };
  for (const kind of HARNESS_KINDS) {
    const result = classifyCommand(`${HARNESS_BINARY[kind]} do the thing`);
    assert.equal(result.ok, true, `${HARNESS_BINARY[kind]} does not classify`);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.segments.length, 1);
    assert.equal(result.segments[0]?.class, `harness.launch.${launchName[kind]}`);
  }
});

test("the conformance schema-validation suite carries an accepted record per harness", () => {
  const suite = JSON.parse(
    readFileSync(join(REPO_ROOT, "conformance", "vectors", "schema-validation.v1.json"), "utf8"),
  ) as { vectors: { input: { schema: string; document: Record<string, unknown> } }[] };
  const recorded = new Set<string>();
  for (const vector of suite.vectors) {
    if (vector.input.schema !== "event") continue;
    const payload = vector.input.document["payload"];
    if (typeof payload !== "object" || payload === null) continue;
    const harness = (payload as Record<string, unknown>)["harness"];
    if (typeof harness === "string") recorded.add(harness);
  }
  // Every kind appears, and nothing appears that is not a kind apart from the
  // negative control that proves the enum is closed at all.
  for (const kind of HARNESS_KINDS) {
    assert.ok(recorded.has(kind), `no conformance vector records a ${kind} record`);
  }
  assert.ok(
    recorded.has("totally-legit-harness"),
    "the refused-unknown-harness control is missing; a closed enum with no control is untested",
  );
});

// ---------------------------------------------------------------------------
// AC3 — the thing the lists exist for: a manual-class registration, per harness
// ---------------------------------------------------------------------------

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string, input = ""): Run {
  const childEnv = { ...process.env };
  delete childEnv["APPROVAL_HUMAN"];
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: childEnv,
    input,
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

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
  "  read.*:",
  "    autonomy: autonomous",
  "  files.write.workspace:",
  "    autonomy: manual",
  "  deps.add:",
  "    autonomy: manual",
  "```",
  "",
  "",
].join("\n");

const LOG = ".approval/log/events.jsonl";

function ready(): string {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  const attested = runCli(["policy", "attest", "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);
  return dir;
}

function records(dir: string): Record<string, unknown>[] {
  const path = join(dir, LOG);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * The version each harness states in its own event.
 *
 * Stated rather than probed, and that is what makes this suite deterministic:
 * `harnessProvenance` prefers the event's own `version` over
 * `<binary> --version`, so the record carries `harness` on a machine where no
 * harness is installed. The value is self-reported and reduces nothing — it is
 * normalized at the write boundary exactly as the probe's output is.
 */
const STATED_VERSION = "9.9.9-test";

/** The manual-class command, in the dialect each harness actually sends. */
function manualEvent(kind: HarnessKind, dir: string): string {
  const command = "npm install --save-dev oxlint";
  switch (kind) {
    case "claude-code":
      return JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: "enum-sess",
        cwd: dir,
        tool_name: "Bash",
        tool_use_id: "enum-tool",
        tool_input: { command, description: "self-reported, never read" },
        version: STATED_VERSION,
      });
    case "cursor":
      return JSON.stringify({
        hook_event_name: "preToolUse",
        session_id: "enum-sess",
        cwd: dir,
        tool_name: "Shell",
        tool_use_id: "enum-tool",
        tool_input: { command, description: "self-reported, never read" },
        version: STATED_VERSION,
      });
    case "codex":
      // Codex Bash is refused before gate intake (no per-call workdir in the
      // native contract, APRV-310), so its manual-class surface is the one it
      // does expose: a direct `apply_patch`, gated as `files.write.workspace`.
      return JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: "enum-sess",
        turn_id: "enum-turn",
        transcript_path: "/never/read",
        cwd: dir,
        model: "synthetic-model",
        tool_name: "apply_patch",
        tool_use_id: "enum-tool",
        tool_input: {
          command: "*** Begin Patch\n*** Add File: manual.txt\n+x\n*** End Patch",
          description: "self-reported, never read",
        },
        version: STATED_VERSION,
      });
    case "grok":
      return JSON.stringify({
        hookEventName: "PreToolUse",
        sessionId: "enum-sess",
        cwd: dir,
        workspaceRoot: dir,
        toolName: "Bash",
        toolUseId: "enum-tool",
        toolInput: { command, description: "self-reported, never read" },
        version: STATED_VERSION,
      });
    case "muse":
      return JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: "enum-sess",
        turn_id: "enum-turn",
        tool_use_id: "enum-tool",
        transcript_path: null,
        cwd: dir,
        model: "muse-spark-1.3",
        model_provider: "meta",
        permission_mode: "default",
        tool_name: "bash",
        tool_input: { command, workdir: dir, description: "self-reported, never read" },
        version: STATED_VERSION,
      });
  }
}

for (const kind of HARNESS_KINDS) {
  test(`a manual-class action through \`hook ${kind}\` registers and asks a human`, () => {
    const dir = ready();
    const run = runCli(
      ["hook", kind, "--timeout", "1ms", "--interval", "1ms", "--retry-grace", "1ms"],
      dir,
      manualEvent(kind, dir),
    );
    // Grok reads the EXIT CODE: a deny is exit 2 there and exit 0 everywhere
    // else. Either way the verdict is a deny, because no human answered.
    assert.equal(run.code, kind === "grok" ? 2 : 0, `${kind}: ${run.stderr}`);
    assert.match(run.stdout, /hook-timeout/u, `${kind} did not wait on a decision: ${run.stdout}`);

    const written = records(dir);
    const registration = written.find((record) => record["event"] === "task.registered");
    assert.ok(registration !== undefined, `${kind}: nothing was registered`);
    const payload = registration["payload"] as Record<string, unknown>;
    // The field that was refused at the write boundary before this task. The
    // registration reaching the log at all is the regression.
    assert.equal(payload["harness"], kind);
    assert.equal(payload["harness_version"], STATED_VERSION);
    assert.equal(registration["actor"], `agent:${kind}`);
    assert.ok(
      written.some((record) => record["event"] === "approval.requested"),
      `${kind}: registered but never asked`,
    );
    assert.equal(runCli(["log", "verify"], dir).code, 0, `${kind}: the chain does not verify`);
  });
}
