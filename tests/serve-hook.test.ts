/**
 * `POST /hook/<harness>` answers the bytes the stdin form prints (APRV-421).
 *
 * The acceptance criterion is byte equality across EVERY adapter in
 * `HARNESS_ADAPTERS`, and the reason it has to be byte equality rather than
 * "an equivalent verdict" is that the dialects disagree about where a block
 * lives. Claude Code, Cursor, Muse and Codex put it in the body at exit 0;
 * Grok Build and Hermes use exit 2; Hermes's ALLOW is `{}` and carries its
 * reason on stderr and nowhere else. A transport that reshaped any of that
 * would produce, for at least one harness, a verdict the harness declines to
 * parse — and a declined verdict on a harness that fails open is a session
 * that was never gated.
 *
 * So each case below runs twice: once through the listener, and once through
 * `commandHook` with the argv the listener itself builds (`hookArgv`, exported
 * for exactly this, so the two sides are one invocation of one verb rather
 * than two spellings of it).
 *
 * **Each side gets its own freshly built store**, which is what makes the two
 * runs comparable at all. Some of these envelopes APPEND — Codex's
 * `apply_patch` is autonomous under the policy below, so it records an
 * `execution.started` — and an idempotency key is single-use, so running the
 * same envelope twice against one log answers `already-executed` the second
 * time. Two identical stores means each run is the first one, and the bytes
 * that come back are then a statement about the transport rather than about
 * the order the test happened to run in.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { commandHook, HARNESS_ADAPTERS } from "../src/cli/hook.js";
import { main } from "../src/cli/main.js";
import type { HarnessKind } from "../src/core/harness-version.js";
import { resolveServeCredentials } from "../src/serve/credentials.js";
import { hookArgv, serveApproval, type ServeHandle } from "../src/serve/server.js";

const AGENT_TOKEN = "agent-token-for-the-serve-suite-0000";
const TENANT_TOKEN = "tenant-token-for-the-serve-suite-000";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-serve-hook-")));
let counter = 0;

after(() => rmSync(scratch, { recursive: true, force: true }));

const POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "1h"',
  "  on_expiry: reject",
  "read_scope:",
  "  roots: []",
  "classes:",
  "  read.*:",
  "    autonomy: autonomous",
  "  files.write.workspace:",
  "    autonomy: autonomous",
  // Human-only, so the deny case below refuses outright, appends nothing, and
  // never opens a request a wait would have to sit on.
  "  deps.add:",
  "    autonomy: human-only",
  "```",
  "",
].join("\n");

async function ready(): Promise<string> {
  counter += 1;
  const dir = join(scratch, `case-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  const code = await main(["policy", "attest", "--as", "human:alice"], {
    cwd: dir,
    streams: { out: () => undefined, err: () => undefined },
  });
  assert.equal(code, 0, "the scenario policy did not attest");
  return dir;
}

const SERVE_ACTOR = "agent:serve-test";

async function listener(dir: string): Promise<ServeHandle> {
  const credentials = resolveServeCredentials({
    APPROVAL_SERVE_AGENT_TOKEN: AGENT_TOKEN,
    APPROVAL_SERVE_TENANT_TOKEN: TENANT_TOKEN,
  });
  assert.equal(credentials.ok, true);
  if (!credentials.ok) throw new Error("unreachable");
  return await serveApproval({
    actor: SERVE_ACTOR,
    cwd: dir,
    credentials: credentials.credentials,
    daemonId: "daemon-serve-test",
    port: 0,
  });
}

/** The same invocation the listener makes, run in this process. */
function locally(harness: HarnessKind, dir: string, body: string): { out: string; err: string; code: number } {
  let out = "";
  let err = "";
  const code = commandHook(
    [harness, ...hookArgv({ actor: SERVE_ACTOR, cwd: dir })],
    {
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
    },
    dir,
    () => body,
  );
  return { out, err, code };
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

interface Case {
  /** A tool call this runtime does not gate, or the harness's nearest thing to one. */
  allow: (dir: string) => Record<string, unknown>;
  /** A `human-only` class through the harness's shell tool. */
  deny: (dir: string) => Record<string, unknown>;
  /** The exit code a DENY carries on this harness. */
  denyExit: number;
  /** Where this harness's decision is written. */
  reads: (verdict: Record<string, unknown>) => { permission: string; reason: string };
}

const MANUAL_COMMAND = "npm install left-pad";

function claudeShaped(dir: string, tool: string, input: Record<string, unknown>): Record<string, unknown> {
  return {
    hook_event_name: "PreToolUse",
    session_id: "serve-session",
    tool_use_id: "serve-tool",
    cwd: dir,
    tool_name: tool,
    tool_input: input,
  };
}

/**
 * One entry per harness, and the exhaustiveness check below is what makes it a
 * TABLE rather than six tests: a kind added to `HARNESS_ADAPTERS` with no entry
 * here fails, which is the same discipline `tests/harness-enum.test.ts` keeps
 * over the enumerations outside `cli/hook.ts`.
 */
const CASES: Record<HarnessKind, Case> = {
  "claude-code": {
    allow: (dir) => claudeShaped(dir, "Ls", {}),
    deny: (dir) => claudeShaped(dir, "Bash", { command: MANUAL_COMMAND }),
    denyExit: 0,
    reads: (verdict) => {
      const nested = verdict["hookSpecificOutput"] as Record<string, unknown>;
      return {
        permission: String(nested["permissionDecision"]),
        reason: String(nested["permissionDecisionReason"]),
      };
    },
  },
  cursor: {
    allow: (dir) => claudeShaped(dir, "Ls", {}),
    deny: (dir) => claudeShaped(dir, "Shell", { command: MANUAL_COMMAND }),
    denyExit: 0,
    reads: (verdict) => ({
      permission: String(verdict["permission"]),
      reason: String(verdict["user_message"]),
    }),
  },
  codex: {
    // Codex's native contract exposes exactly two tools, so "a tool this
    // harness does not gate" does not exist for it: the allow case is the
    // workspace write its `apply_patch` carries, which the policy above makes
    // autonomous.
    allow: (dir) =>
      claudeShaped(dir, "apply_patch", {
        command: "*** Begin Patch\n*** Add File: notes.md\n+hello\n*** End Patch\n",
      }),
    // And its deny is its own: the native hook contract does not expose the
    // per-call working directory, so Bash is refused before any policy is
    // consulted (APRV-310).
    deny: (dir) => claudeShaped(dir, "Bash", { command: MANUAL_COMMAND }),
    denyExit: 0,
    reads: (verdict) => {
      const nested = verdict["hookSpecificOutput"] as Record<string, unknown>;
      return {
        permission: String(nested["permissionDecision"]),
        reason: String(nested["permissionDecisionReason"]),
      };
    },
  },
  grok: {
    allow: (dir) => ({
      hookEventName: "PreToolUse",
      sessionId: "serve-session",
      toolUseId: "serve-tool",
      cwd: dir,
      toolName: "Ls",
      toolInput: {},
    }),
    deny: (dir) => ({
      hookEventName: "PreToolUse",
      sessionId: "serve-session",
      toolUseId: "serve-tool",
      cwd: dir,
      toolName: "Bash",
      toolInput: { command: MANUAL_COMMAND },
    }),
    // Grok Build reads exit 2 as the deny and exit 0 as ALLOW whatever stdout
    // said, so the code is the verdict here and the body is the reason.
    denyExit: 2,
    reads: (verdict) => ({
      permission: String(verdict["decision"]),
      reason: String(verdict["reason"]),
    }),
  },
  muse: {
    // `model` is required on every Muse envelope: the adapter refuses a session
    // that will not say what it is running, above the policy (APRV-350).
    allow: (dir) => ({ ...claudeShaped(dir, "Ls", {}), model: "muse-spark-standard" }),
    deny: (dir) => ({
      ...claudeShaped(dir, "bash", { command: MANUAL_COMMAND, workdir: dir }),
      model: "muse-spark-standard",
    }),
    denyExit: 0,
    reads: (verdict) => {
      const nested = verdict["hookSpecificOutput"] as Record<string, unknown>;
      return {
        permission: String(nested["permissionDecision"]),
        reason: String(nested["permissionDecisionReason"]),
      };
    },
  },
  hermes: {
    allow: (dir) => ({ ...claudeShaped(dir, "Ls", {}), hook_event_name: "pre_tool_call" }),
    deny: (dir) => ({
      ...claudeShaped(dir, "terminal", { command: MANUAL_COMMAND, workdir: dir }),
      hook_event_name: "pre_tool_call",
    }),
    denyExit: 2,
    reads: (verdict) =>
      Object.keys(verdict).length === 0
        ? { permission: "allow", reason: "" }
        : { permission: verdict["action"] === "block" ? "deny" : "?", reason: String(verdict["message"]) },
  },
};

test("the hook table covers every adapter this runtime speaks for", () => {
  assert.deepEqual(Object.keys(CASES).sort(), Object.keys(HARNESS_ADAPTERS).sort());
});

for (const harness of Object.keys(HARNESS_ADAPTERS) as HarnessKind[]) {
  const entry = CASES[harness];

  test(`hook/${harness}: the response is byte-for-byte the verdict stdin prints`, async () => {
    for (const [label, build, expectedPermission, expectedExit] of [
      ["allow", entry.allow, "allow", 0],
      ["deny", entry.deny, "deny", entry.denyExit],
    ] as const) {
      const servedDir = await ready();
      const localDir = await ready();

      const server = await listener(servedDir);
      let served: string;
      let exit: number;
      try {
        const response = await fetch(
          `http://${server.host}:${String(server.port)}/hook/${harness}`,
          {
            method: "POST",
            headers: { authorization: `Bearer ${AGENT_TOKEN}`, "content-type": "application/json" },
            body: JSON.stringify(build(servedDir)),
          },
        );
        assert.equal(response.status, 200, `${label}: a verdict is an ANSWER, so its status is 200`);
        // ONE body, since the review: the exit code and both streams. Headers
        // carry no part of the verdict, because a header is a thing a refusal
        // can forget to set and a missing exit code reads as zero, which is an
        // allow on four of the six dialects.
        const body = (await response.json()) as {
          exit_code: number;
          stdout: string;
          stdout_truncated: boolean;
        };
        assert.equal(body.stdout_truncated, false, `${label}: the verdict was clipped`);
        served = body.stdout;
        exit = body.exit_code;
      } finally {
        await server.close();
      }

      const printed = locally(harness, localDir, JSON.stringify(build(localDir)));
      // AC2, and the assertion the response contract is built around: `stdout`
      // is byte-for-byte what the stdin form printed.
      assert.equal(
        served,
        printed.out,
        `${label}: the ${harness} response body is not the bytes \`approval hook ${harness}\` prints`,
      );
      assert.equal(
        exit,
        printed.code,
        `${label}: the ${harness} exit code did not travel with the verdict`,
      );
      assert.equal(
        exit,
        expectedExit,
        `${label}: ${harness} encodes this verdict at exit ${String(expectedExit)}`,
      );

      const verdict = JSON.parse(served) as Record<string, unknown>;
      const read = entry.reads(verdict);
      assert.equal(
        read.permission,
        expectedPermission,
        `${label}: ${harness} answered ${read.permission} in its own dialect`,
      );
      assert.notEqual(read.permission, "ask", "no adapter ever answers ask");
    }
  });
}

test("hook/hermes: the allow's reason travels, because its body has nowhere for one", async () => {
  const dir = await ready();
  const server = await listener(dir);
  try {
    const body = JSON.stringify(CASES.hermes.allow(dir));
    const response = await fetch(`http://${server.host}:${String(server.port)}/hook/hermes`, {
      method: "POST",
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      body,
    });
    const parsed = (await response.json()) as {
      exit_code: number;
      stdout: string;
      stderr: string;
      stderr_truncated: boolean;
    };
    // `{}` is the whole of a Hermes allow: it has no allow directive, and a
    // parser that finds no directive lets the call proceed.
    assert.equal(parsed.stdout, "{}\n");
    assert.equal(parsed.exit_code, 0);
    assert.ok(parsed.stderr.length > 0, "the Hermes allow's reason was dropped by the transport");
    assert.equal(parsed.stderr_truncated, false);
    assert.match(parsed.stderr, /approval hook hermes: allow —/u);
    assert.equal(parsed.stderr, locally("hermes", dir, body).err);
  } finally {
    await server.close();
  }
});

test("hook/<harness>: an unknown harness is a refusal with a code, not a bare 404", async () => {
  const dir = await ready();
  const server = await listener(dir);
  try {
    const response = await fetch(`http://${server.host}:${String(server.port)}/hook/devin`, {
      method: "POST",
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      body: "{}",
    });
    assert.equal(response.status, 404);
    const parsed = (await response.json()) as { error: { code: string; message: string } };
    assert.equal(parsed.error.code, "serve-unknown-harness");
    assert.match(parsed.error.message, /claude-code/u);
  } finally {
    await server.close();
  }
});

test("hook/<harness>: the tenant credential does not act as the agent", async () => {
  const dir = await ready();
  const server = await listener(dir);
  try {
    const response = await fetch(`http://${server.host}:${String(server.port)}/hook/claude-code`, {
      method: "POST",
      headers: { authorization: `Bearer ${TENANT_TOKEN}` },
      body: JSON.stringify(CASES["claude-code"].allow(dir)),
    });
    assert.equal(response.status, 403);
    const parsed = (await response.json()) as {
      error: { code: string };
      exit_code: number;
      stdout: string;
    };
    assert.equal(parsed.error.code, "serve-tenant-forbidden");
    // Even a scope refusal on this route speaks the harness's dialect, so a
    // misconfigured client that writes stdout and exits exit_code blocks
    // rather than proceeding.
    assert.notEqual(parsed.exit_code, 0);
    const directive = JSON.parse(parsed.stdout) as Record<string, unknown>;
    const nested = directive["hookSpecificOutput"] as Record<string, unknown>;
    assert.equal(nested["permissionDecision"], "deny");
  } finally {
    await server.close();
  }
});
