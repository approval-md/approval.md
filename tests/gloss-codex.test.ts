import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  codexGlossRunnerFor,
  type CodexGlossUnavailableReason,
} from "../src/cli/gloss-codex.js";
import { GLOSS_INSTRUCTION, glossPrompt } from "../src/cli/gloss.js";

const FAKE_SOURCE = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  const capture = process.env.FAKE_CODEX_CAPTURE;
  if (capture) {
    fs.writeFileSync(capture, JSON.stringify({
      argv: process.argv.slice(2),
      stdin,
      cwd: process.cwd(),
      hasApprovalSecret: process.env.APPROVAL_TEST_SECRET !== undefined,
      hasTelegramSecret: process.env.TELEGRAM_TEST_SECRET !== undefined,
      hasPassphrase: process.env.GLOSS_TEST_PASSPHRASE !== undefined,
      hasHome: typeof process.env.HOME === "string",
    }));
  }

  const mode = process.env.FAKE_CODEX_MODE || "success";
  if (mode === "nonzero") process.exit(7);
  if (mode === "malformed") return process.stdout.write("not-json\n");
  if (mode === "oversize") return process.stdout.write("x".repeat(70 * 1024));
  if (mode === "timeout") {
    const marker = process.env.FAKE_CODEX_MARKER;
    const descendant = spawn(process.execPath, ["-e",
      "setTimeout(() => require('node:fs').writeFileSync(" + JSON.stringify(marker) + ", 'alive'), 1500); setInterval(() => {}, 1000)"
    ], { stdio: "ignore" });
    if (process.env.FAKE_CODEX_PID) fs.writeFileSync(process.env.FAKE_CODEX_PID, String(descendant.pid));
    return setInterval(() => {}, 1000);
  }

  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "t" }) + "\n");
  process.stdout.write(JSON.stringify({ type: "turn.started" }) + "\n");
  if (mode === "tool") {
    process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "whoami" } }) + "\n");
  } else if (mode === "unknown") {
    process.stdout.write(JSON.stringify({ type: "future.event" }) + "\n");
  } else if (mode === "error") {
    process.stdout.write(JSON.stringify({ type: "error", message: "secret detail" }) + "\n");
  } else {
    process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "hidden" } }) + "\n");
    process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Earlier draft." } }) + "\n");
    process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Creates a reviewable summary." } }) + "\n");
  }
  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: {} }) + "\n");
  if (mode === "trailing") process.stdout.write(JSON.stringify({ type: "turn.started" }) + "\n");
});
`;

interface FakeInstallation {
  readonly executable: string;
  readonly capture: string;
  readonly root: string;
}

function installFake(): FakeInstallation {
  const root = mkdtempSync(join(tmpdir(), "approval-md-fake-codex-"));
  const executable = join(root, "codex");
  const capture = join(root, "capture.json");
  writeFileSync(executable, FAKE_SOURCE);
  chmodSync(executable, 0o755);
  return { executable, capture, root };
}

function withEnvironment(values: Record<string, string | undefined>, run: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("Codex runner uses saved-auth environment, stdin payload, and strongest verified controls", () => {
  const fake = installFake();
  const reasons: CodexGlossUnavailableReason[] = [];
  const material = "echo payload-should-not-be-an-argument";

  withEnvironment(
    {
      FAKE_CODEX_CAPTURE: fake.capture,
      FAKE_CODEX_MODE: "success",
      APPROVAL_TEST_SECRET: "approval-secret",
      TELEGRAM_TEST_SECRET: "telegram-secret",
      GLOSS_TEST_PASSPHRASE: "vault-secret",
    },
    () => {
      const runner = codexGlossRunnerFor("gpt-5.3-codex", "GLOSS_TEST_PASSPHRASE", {
        executable: fake.executable,
        diagnostic: (reason) => reasons.push(reason),
      });
      assert.deepEqual(runner(glossPrompt(GLOSS_INSTRUCTION, material)), {
        text: "Creates a reviewable summary.",
        provenance: { provider: "codex", requestedModel: "gpt-5.3-codex" },
      });
    },
  );

  assert.deepEqual(reasons, []);
  const capture = JSON.parse(readFileSync(fake.capture, "utf8")) as {
    argv: string[];
    stdin: string;
    cwd: string;
    hasApprovalSecret: boolean;
    hasTelegramSecret: boolean;
    hasPassphrase: boolean;
    hasHome: boolean;
  };
  assert.equal(capture.stdin, material);
  assert.equal(capture.argv.includes(material), false);
  assert.equal(capture.argv.at(-1), GLOSS_INSTRUCTION);
  assert.equal(capture.argv[0], "exec");
  assert.equal(capture.argv.includes("--strict-config"), true);
  assert.equal(capture.argv.includes("--ignore-user-config"), true);
  assert.equal(capture.argv.includes("--ignore-rules"), true);
  assert.equal(capture.argv.includes("--ephemeral"), true);
  assert.equal(capture.argv.includes("--json"), true);
  assert.equal(capture.argv.includes('permissions.gloss.network.enabled=false'), true);
  assert.equal(capture.argv.includes('project_doc_max_bytes=0'), true);
  assert.equal(capture.argv.includes("skip_host_skill_discovery"), true);
  assert.equal(capture.argv.includes("suppress_unstable_features_warning=true"), true);
  assert.equal(capture.argv.includes("skills.max_context_tokens=1"), false);
  assert.equal(capture.argv.includes("shell_tool"), true);
  assert.equal(capture.argv.includes("unified_exec"), true);
  assert.equal(capture.hasApprovalSecret, false);
  assert.equal(capture.hasTelegramSecret, false);
  assert.equal(capture.hasPassphrase, false);
  assert.equal(capture.hasHome, true);
  assert.equal(existsSync(capture.cwd), false);
});

test("Codex runner rejects malformed, tool-bearing, unknown, error, and nonzero results", () => {
  for (const mode of ["malformed", "tool", "unknown", "error", "trailing", "nonzero"] as const) {
    const fake = installFake();
    const reasons: CodexGlossUnavailableReason[] = [];
    withEnvironment(
      { FAKE_CODEX_CAPTURE: fake.capture, FAKE_CODEX_MODE: mode },
      () => {
        const runner = codexGlossRunnerFor("gpt-5.3-codex", null, {
          executable: fake.executable,
          diagnostic: (reason) => reasons.push(reason),
        });
        assert.equal(runner(glossPrompt(GLOSS_INSTRUCTION, "echo hello")), null, mode);
      },
    );
    assert.deepEqual(reasons, [mode === "nonzero" ? "nonzero-exit" : "unsafe-output"], mode);
    const cwd = (JSON.parse(readFileSync(fake.capture, "utf8")) as { cwd: string }).cwd;
    assert.equal(existsSync(cwd), false, mode);
  }
});

test("Codex runner bounds stdout and reports only a safe diagnostic", () => {
  const fake = installFake();
  const reasons: CodexGlossUnavailableReason[] = [];
  withEnvironment(
    { FAKE_CODEX_CAPTURE: fake.capture, FAKE_CODEX_MODE: "oversize" },
    () => {
      const runner = codexGlossRunnerFor("gpt-5.3-codex", null, {
        executable: fake.executable,
        diagnostic: (reason) => reasons.push(reason),
      });
      assert.equal(runner(glossPrompt(GLOSS_INSTRUCTION, "echo hello")), null);
    },
  );
  assert.deepEqual(reasons, ["output-too-large"]);
});

test("Codex runner rejects invalid models and prompts before spawning", () => {
  const reasons: CodexGlossUnavailableReason[] = [];
  const invalidModel = codexGlossRunnerFor("bad model", null, {
    executable: "/does/not/exist",
    diagnostic: (reason) => reasons.push(reason),
  });
  assert.equal(invalidModel(glossPrompt(GLOSS_INSTRUCTION, "echo hello")), null);

  const invalidPrompt = codexGlossRunnerFor("gpt-5.3-codex", null, {
    executable: "/does/not/exist",
    diagnostic: (reason) => reasons.push(reason),
  });
  assert.equal(invalidPrompt("untrusted instruction\n\necho hello"), null);
  assert.deepEqual(reasons, ["invalid-model", "invalid-prompt"]);
});

test("Codex runner kills the process group on timeout and removes its empty cwd", async () => {
  const fake = installFake();
  const marker = join(fake.root, "descendant-marker");
  const pidFile = join(fake.root, "descendant-pid");
  const reasons: CodexGlossUnavailableReason[] = [];
  let childCwd = "";

  withEnvironment(
    {
      FAKE_CODEX_CAPTURE: fake.capture,
      FAKE_CODEX_MODE: "timeout",
      FAKE_CODEX_MARKER: marker,
      FAKE_CODEX_PID: pidFile,
    },
    () => {
      const runner = codexGlossRunnerFor("gpt-5.3-codex", null, {
        executable: fake.executable,
        timeoutMs: 1_000,
        diagnostic: (reason) => reasons.push(reason),
      });
      assert.equal(runner(glossPrompt(GLOSS_INSTRUCTION, "echo hello")), null);
      childCwd = (JSON.parse(readFileSync(fake.capture, "utf8")) as { cwd: string }).cwd;
    },
  );

  assert.deepEqual(reasons, ["timeout"]);
  assert.equal(existsSync(childCwd), false);
  await new Promise((resolve) => setTimeout(resolve, 1_650));
  assert.equal(existsSync(marker), false);
  const descendantPid = Number(readFileSync(pidFile, "utf8"));
  assert.throws(() => process.kill(descendantPid, 0), { code: "ESRCH" });
});
