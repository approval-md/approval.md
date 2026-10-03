/**
 * The Agent Village tenant policy fixture (APRV-446).
 *
 * `examples/agent-village/approval-policy.md` is the canonical day-one policy a
 * co-located Agent Village tenant runs under: a recorder (autonomous default),
 * the three gate organs human-only, one live gate on the propose path
 * (`intent.publish.inferred.index`), and the Hermes tool classes recorded rather
 * than gated. The control plane renders it into the tenant store's APPROVAL.md
 * at provisioning, replacing the sender placeholder with the paired account id.
 *
 * These tests go through the REAL loader, the real resolver and the real CLI:
 *
 * 1. Unrendered, the template fails closed (the placeholder is not a sender id).
 * 2. Rendered, it loads, and the class table resolves as the fixture says.
 * 3. Attested headless by the operator, it blocks nothing on representative
 *    Hermes `terminal`, `write_file` and `read_file` envelopes.
 * 4. A propose for `intent.publish.inferred.index` opens a request, and one for
 *    the stated class is answered autonomous.
 *
 * ## `agent_may_request` and PR #569
 *
 * The fixture carries `agent_may_request`, the policy key PR #569 (APRV-445)
 * adds. Until #569 is in the build, the schema rejects the key, so the rendered
 * fixture fails closed: the test asserts exactly that, and proves the class
 * table and the hook verdicts on the same text with the key removed. Once #569
 * is in, the same file runs the full assertions against the fixture verbatim,
 * including the agent-requestable bit and the propose round. Which branch ran is
 * decided by reading the build's own policy schema, never by a flag.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { VERB_REGISTRY } from "../src/cli/verb-registry.js";
import { loadPolicyText, type PolicyLoadResult } from "../src/core/policy-load.js";
import { resolve } from "../src/core/policy-match.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
const FIXTURE_PATH = join(REPO_ROOT, "examples", "agent-village", "approval-policy.md");
const TEMPLATE = readFileSync(FIXTURE_PATH, "utf8");

/** The paired account id the control plane writes in at provisioning. */
const PAIRED_ID = "12345678";
const RENDERED = TEMPLATE.replace('"<telegram_user_id>"', `"${PAIRED_ID}"`);

/** Does this build's policy schema know the #569 key? */
const SCHEMA = JSON.parse(readFileSync(join(REPO_ROOT, "schema", "policy.schema.json"), "utf8")) as {
  $defs: { classRule: { properties: Record<string, unknown> } };
};
const HAS_AGENT_MAY_REQUEST = "agent_may_request" in SCHEMA.$defs.classRule.properties;
const HAS_PROPOSE = VERB_REGISTRY.some((verb) => verb.name === "propose");

/**
 * The text this build can load. With #569 that is the fixture verbatim; without
 * it, the fixture with the key removed, which is what proves the class table
 * today while the verbatim load is asserted to fail closed.
 */
const LOADABLE = HAS_AGENT_MAY_REQUEST
  ? RENDERED
  : RENDERED.replaceAll(", agent_may_request: true", "");

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-agent-village-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const AUTONOMOUS = [
  "network.call",
  "read.web",
  "cron.manage",
  "process.write",
  "browser.exec",
  "skill.manage",
  "agent.delegate",
  "message.send",
  "intent.publish.stated.index",
] as const;

const HUMAN_ONLY = ["policy.core", "log.mutate", "account.credential"] as const;

function load(text: string): PolicyLoadResult {
  return loadPolicyText("APPROVAL.md", text);
}

// ===========================================================================
// The template and the loader
// ===========================================================================

test("the fixture is a template: unrendered, it fails closed", () => {
  assert.ok(TEMPLATE.includes('"<telegram_user_id>"'), "the sender placeholder moved");
  const unrendered = load(TEMPLATE);
  assert.equal(unrendered.ok, false, "an unrendered template must not load");
  for (const actionClass of [...AUTONOMOUS, "files.write.workspace"]) {
    assert.equal(resolve(unrendered, actionClass).autonomy, "manual", actionClass);
  }
});

test("the fixture names the relay credential, the resident chat and the 72h window", () => {
  const loaded = load(LOADABLE);
  assert.ok(loaded.ok, loaded.ok ? "" : loaded.message);
  const telegram = loaded.policy.channels?.["telegram"] as Record<string, unknown> | undefined;
  assert.equal(telegram?.["token_env"], "APPROVAL_RELAY_TOKEN");
  assert.equal(telegram?.["chat_id_env"], "APPROVAL_RESIDENT_CHAT");
  assert.equal(loaded.policy.defaults?.approval_ttl, "72h");
  assert.match(TEMPLATE, /approval_ttl: 72h +# .*harness cap minus 60 s/u);
  assert.equal(loaded.policy.defaults?.autonomy, "autonomous");
});

test(
  HAS_AGENT_MAY_REQUEST
    ? "the rendered fixture loads verbatim through the real loader"
    : "without #569's key in the build, the verbatim fixture fails closed",
  () => {
    const verbatim = load(RENDERED);
    if (HAS_AGENT_MAY_REQUEST) {
      assert.ok(verbatim.ok, verbatim.ok ? "" : verbatim.message);
      return;
    }
    assert.equal(verbatim.ok, false);
    assert.match(verbatim.ok ? "" : JSON.stringify(verbatim), /agent_may_request/u);
    for (const actionClass of [...AUTONOMOUS, ...HUMAN_ONLY]) {
      assert.equal(resolve(verbatim, actionClass).autonomy, "manual", actionClass);
    }
  },
);

test("network.call, read.web and the six Hermes tool classes resolve autonomous", () => {
  const loaded = load(LOADABLE);
  assert.ok(loaded.ok);
  for (const actionClass of AUTONOMOUS) {
    const resolution = resolve(loaded, actionClass);
    assert.equal(resolution.autonomy, "autonomous", actionClass);
    assert.equal(resolution.matched?.pattern, actionClass, `${actionClass} has its own row`);
  }
  // The default is the recorder too: a class the fixture does not name is
  // recorded, never gated.
  assert.equal(resolve(loaded, "files.write.workspace").autonomy, "autonomous");
});

test("intent.publish.inferred.index resolves manual and agent-requestable", () => {
  const loaded = load(LOADABLE);
  assert.ok(loaded.ok);
  const resolution = resolve(loaded, "intent.publish.inferred.index");
  assert.equal(resolution.autonomy, "manual");
  assert.equal(resolution.matched?.pattern, "intent.publish.inferred.index");
  // A future member of the family is manual too, without a policy edit.
  assert.equal(resolve(loaded, "intent.publish.inferred.calendar").autonomy, "manual");
  assert.equal(resolve(loaded, "digest.share").autonomy, "manual");
  assert.equal(resolve(loaded, "village.vote").autonomy, "manual");
  if (HAS_AGENT_MAY_REQUEST) {
    const rules = loaded.policy.classes ?? {};
    for (const pattern of ["intent.publish.*", "intent.publish.inferred.index"]) {
      assert.equal(
        (rules[pattern] as Record<string, unknown> | undefined)?.["agent_may_request"],
        true,
        pattern,
      );
    }
  }
});

test("policy.core, log.mutate and account.credential resolve human-only", () => {
  const loaded = load(LOADABLE);
  assert.ok(loaded.ok);
  for (const actionClass of HUMAN_ONLY) {
    assert.equal(resolve(loaded, actionClass).autonomy, "human-only", actionClass);
  }
});

// ===========================================================================
// The tenant store, end to end through the CLI
// ===========================================================================

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string, input = ""): Run {
  const childEnv: Record<string, string | undefined> = { ...process.env };
  for (const name of ["APPROVAL_HUMAN", "APPROVAL_TG_TOKEN", "APPROVAL_TG_CHAT"]) {
    delete childEnv[name];
  }
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: childEnv,
    input,
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** A provisioned tenant store: init, the rendered policy, the operator's bootstrap. */
function tenantStore(): string {
  counter += 1;
  const dir = join(scratch, `tenant-${counter}`);
  mkdirSync(dir, { recursive: true });
  assert.equal(runCli(["init", "--json"], dir).code, 0);
  writeFileSync(join(dir, "APPROVAL.md"), LOADABLE);
  const attested = runCli(["policy", "attest", "--bootstrap", "--as", "human:operator"], dir);
  assert.equal(attested.code, 0, attested.stderr);
  return dir;
}

/** The snake_case pre_tool_call envelope Hermes sends. */
function envelope(dir: string, toolName: string, toolInput: Record<string, unknown>): string {
  return JSON.stringify({
    hook_event_name: "pre_tool_call",
    session_id: "village-sess-1",
    tool_use_id: "tool-1",
    cwd: dir,
    profile: "default",
    tool_name: toolName,
    tool_input: toolInput,
    extra: { turn_id: "turn-1", tool_call_id: "tool-1" },
  });
}

test("the fixture blocks nothing on representative terminal, write_file and read_file calls", () => {
  const dir = tenantStore();
  writeFileSync(join(dir, "notes.md"), "a resident's notes\n");
  const calls: [string, Record<string, unknown>][] = [
    ["terminal", { command: "ls -la", workdir: dir }],
    ["write_file", { path: join(dir, "draft.md"), content: "hello village\n" }],
    ["read_file", { path: join(dir, "notes.md") }],
  ];
  for (const [toolName, toolInput] of calls) {
    const run = runCli(
      ["hook", "hermes", "--as", "agent:hermes", "--harness-cap", "300s"],
      dir,
      envelope(dir, toolName, toolInput),
    );
    // Hermes's allow is an empty object at exit 0; a block is {action, message}
    // at exit 2. Nothing here may block.
    assert.equal(run.code, 0, `${toolName} was blocked: ${run.stdout}${run.stderr}`);
    assert.deepEqual(JSON.parse(run.stdout), {}, `${toolName}: ${run.stdout}`);
  }
  // The recorder half: nothing was gated, and nothing waited for a human.
  const log = readFileSync(join(dir, ".approval", "log", "events.jsonl"), "utf8");
  assert.doesNotMatch(log, /"event":"approval\.requested"/u);
  assert.equal(runCli(["log", "verify"], dir).code, 0);
});

test(
  "a propose for intent.publish.inferred.index opens a request; the stated class does not",
  { skip: HAS_PROPOSE ? false : "needs #569's `approval propose` verb in the build" },
  () => {
    const dir = tenantStore();
    const propose = (actionClass: string, id: string): Record<string, unknown> => {
      const run = runCli(
        [
          "propose",
          "--class",
          actionClass,
          "--key",
          `${actionClass}:${id}`,
          "--summary",
          "publish an intention to Index",
          "--payload-json",
          JSON.stringify({ text: "I want to meet people working on soil health" }),
          "--as",
          "agent:hermes",
          "--json",
        ],
        dir,
      );
      assert.equal(run.code, 0, run.stderr);
      return JSON.parse(run.stdout) as Record<string, unknown>;
    };

    const inferred = propose("intent.publish.inferred.index", "intention-1");
    assert.equal(inferred["decision"], "requested");
    assert.equal(inferred["state"], "requested");
    const log = readFileSync(join(dir, ".approval", "log", "events.jsonl"), "utf8");
    assert.match(log, /"event":"approval\.requested"/u);

    const stated = propose("intent.publish.stated.index", "intention-2");
    assert.equal(stated["decision"], "autonomous");
    assert.equal(runCli(["log", "verify"], dir).code, 0);
  },
);
