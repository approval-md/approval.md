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
import {
  HARNESS_SETTINGS,
  ORGAN_SEARCH,
  hookCommandPattern,
  registeredHarnesses,
} from "../src/cli/doctor.js";
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
    // APRV-398: the binary and the protocol share one spelling here, so there
    // is no mapping to get wrong — which is the answer this map exists to make
    // a new harness state out loud rather than inherit.
    hermes: "hermes",
  };
  for (const kind of HARNESS_KINDS) {
    const result = classifyCommand(`${HARNESS_BINARY[kind]} do the thing`);
    assert.equal(result.ok, true, `${HARNESS_BINARY[kind]} does not classify`);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.segments.length, 1);
    assert.equal(result.segments[0]?.class, `harness.launch.${launchName[kind]}`);
  }
});

// ---------------------------------------------------------------------------
// AC4 (APRV-398) — the doctor's own harness lists join the pinning
// ---------------------------------------------------------------------------

test("doctor's harness settings table is keyed by harness kind", () => {
  // The miss this pins is the one APRV-358 did not reach. `HARNESS_SETTINGS`
  // was a flat array of three paths and `HOOK_COMMAND` a regex naming three
  // kinds, so `grok` and `muse` shipped adapters the harness-version row could
  // not see: a checkout with a `.muse/hooks.json` full of `approval hook muse`
  // entries reported "registers no `approval hook` command", and no test noticed.
  assert.deepEqual(Object.keys(HARNESS_SETTINGS).sort(), KINDS);
  for (const kind of HARNESS_KINDS) {
    const locations = HARNESS_SETTINGS[kind];
    assert.ok(Array.isArray(locations), `${kind} has no settings locations array`);
    for (const location of locations) {
      assert.ok(
        typeof location.file === "string" || typeof location.dir === "string",
        `a ${kind} settings location names neither a file nor a directory`,
      );
    }
  }
  // `codex` is deliberately the one kind with no ORGAN_SEARCH entry, and the
  // assertion says so rather than leaving a reader to wonder: its organ files
  // are reported by the Codex-specific rows, and moving them into this row is
  // its own task. Every OTHER kind must name somewhere to look, because an
  // empty list there is a harness whose hand-edited organ nobody reports.
  assert.deepEqual(Object.keys(ORGAN_SEARCH).sort(), KINDS);
  for (const kind of HARNESS_KINDS) {
    if (kind === "codex") {
      assert.deepEqual(ORGAN_SEARCH[kind], [], "the codex exception is documented as empty");
      continue;
    }
    assert.ok(
      ORGAN_SEARCH[kind].length > 0,
      `no organ search directory for \`${kind}\`, so a hand-edited ${kind} organ is never reported`,
    );
  }
});

test("doctor's hook-command pattern recognises every harness kind", () => {
  // Derived from HARNESS_KINDS since APRV-398 rather than spelled, so this test
  // pins the BEHAVIOUR the derivation buys instead of a literal that would have
  // to be edited beside it.
  for (const kind of HARNESS_KINDS) {
    const command = `approval hook ${kind} --dir /repo`;
    const match = hookCommandPattern().exec(command);
    assert.ok(match !== null, `the pattern does not match ${JSON.stringify(command)}`);
    assert.equal(
      match[1],
      kind,
      `the pattern captured ${JSON.stringify(match[1])} from ${JSON.stringify(command)}; a kind that is a prefix of another must not win`,
    );
  }
  assert.equal(
    hookCommandPattern().exec("approval hook gemini --dir /repo"),
    null,
    "a harness this runtime does not speak must not match",
  );
});

test("a grok and a muse registration are seen by doctor, which they were not before", () => {
  // The end-to-end half of the pinning above. Before APRV-398 both of these
  // returned an empty list.
  const grokDir = join(scratch, "registered-grok");
  mkdirSync(join(grokDir, ".grok", "hooks"), { recursive: true });
  writeFileSync(
    join(grokDir, ".grok", "hooks", "pre-tool-use.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: "approval hook grok --dir /repo" }] },
        ],
      },
    }),
    "utf8",
  );
  assert.deepEqual(registeredHarnesses(grokDir), ["grok"]);

  const museDir = join(scratch, "registered-muse");
  mkdirSync(join(museDir, ".muse"), { recursive: true });
  writeFileSync(
    join(museDir, ".muse", "hooks.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: "approval hook muse --dir /repo" }] }],
      },
    }),
    "utf8",
  );
  assert.deepEqual(registeredHarnesses(museDir), ["muse"]);

  // And a checkout with neither still reports neither, which is the half that
  // makes the two above mean anything.
  const emptyDir = join(scratch, "registered-nothing");
  mkdirSync(emptyDir, { recursive: true });
  assert.deepEqual(registeredHarnesses(emptyDir), []);
});

test("a hermes registration is read out of HERMES_HOME, which is not in the checkout", () => {
  // Hermes documents no project-local configuration directory, so a
  // repository-relative search would be empty on every machine and the row could
  // never say anything true. `HERMES_HOME` is read to know where to LOOK; the
  // row it feeds can only add a line, never remove a red one.
  const home = join(scratch, "hermes-home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.yaml"),
    [
      "plugins:",
      "  hook_callback_timeout: 600",
      "hooks:",
      "  - event: pre_tool_call",
      '    command: "approval hook hermes --dir /repo"',
      "    fail_closed: true",
      "",
    ].join("\n"),
    "utf8",
  );
  const checkout = join(scratch, "hermes-checkout");
  mkdirSync(checkout, { recursive: true });

  const previous = process.env["HERMES_HOME"];
  process.env["HERMES_HOME"] = home;
  try {
    assert.deepEqual(registeredHarnesses(checkout), ["hermes"]);
    // A YAML file is searched as TEXT, because it has no JSON leaves to walk.
    // That is why the entry declares `text: true` rather than relying on the
    // JSON walk the other five use.
    process.env["HERMES_HOME"] = join(scratch, "hermes-home-empty");
    mkdirSync(process.env["HERMES_HOME"], { recursive: true });
    assert.deepEqual(registeredHarnesses(checkout), []);
  } finally {
    if (previous === undefined) delete process.env["HERMES_HOME"];
    else process.env["HERMES_HOME"] = previous;
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
    case "hermes":
      // APRV-398. snake_case like Muse, but the EVENT NAME is its own —
      // `pre_tool_call`, not `PreToolUse` — and the shell tool is `terminal`.
      // Sending this one Claude Code's event name would take the post-execution
      // arm on no harness at all and the pre-execution arm by the "unknown name
      // is a command about to run" rule, so it would register and prove nothing
      // about the dispatch.
      return JSON.stringify({
        hook_event_name: "pre_tool_call",
        session_id: "enum-sess",
        tool_use_id: "enum-tool",
        cwd: dir,
        profile: "default",
        tool_name: "terminal",
        tool_input: { command, workdir: dir, description: "self-reported, never read" },
        version: STATED_VERSION,
      });
  }
}

for (const kind of HARNESS_KINDS) {
  test(`a manual-class action through \`hook ${kind}\` registers and asks a human`, () => {
    const dir = ready();
    // APRV-423 (second pass): Hermes with no `--harness-cap` assumes its 30s
    // default callback timeout and refuses `hook-harness-cap-too-short` before
    // it asks anything, which is the right verdict and not the one this case is
    // about. The documented config states the cap, so this case does too.
    const cap = kind === "hermes" ? ["--harness-cap", "300s"] : [];
    const run = runCli(
      ["hook", kind, "--timeout", "1ms", "--interval", "1ms", "--retry-grace", "1ms", ...cap],
      dir,
      manualEvent(kind, dir),
    );
    // Grok and Hermes both answer a deny at EXIT 2 and everything else answers
    // it at 0, for different reasons: Grok reads the exit code as the whole
    // verdict, while Hermes treats 2 as an unconditional block whose message
    // comes from the stdout directive. Either way the verdict is a deny, because
    // no human answered.
    assert.equal(run.code, kind === "grok" || kind === "hermes" ? 2 : 0, `${kind}: ${run.stderr}`);
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
