import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { commandQuickstart, QUICKSTART_CLASSES, runQuickstartDoctor } from "../src/cli/quickstart.js";
import type { Streams } from "../src/cli/main.js";
import type { Prompter, SecretRead } from "../src/cli/prompt.js";
import { classifyCommand } from "../src/core/command-class.js";
import { loadPolicy } from "../src/core/policy-load.js";
import { resolve } from "../src/core/policy-match.js";
import { VERB_REGISTRY } from "../src/cli/verb-registry.js";
import type { KeystoreRunner } from "../src/cli/setup-common.js";
import type { TelegramFetch } from "../src/channels/telegram.js";
import { appendAttestation } from "../src/core/attest.js";
import type { SourceRunner } from "../src/core/env-file.js";
import { messageUpdate, startMockBotApi } from "./telegram-mock.js";

const scratch = mkdtempSync(join(tmpdir(), "approval-md-quickstart-"));
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
after(() => rmSync(scratch, { recursive: true, force: true }));

function scripted(lines: Array<string | null | boolean>): Prompter {
  return {
    readLine(): string | null {
      const answer = lines.shift();
      return typeof answer === "string" || answer === null ? answer : null;
    },
    readSecret(): SecretRead { return { ok: false, reason: "aborted" }; },
    confirm(): boolean { return lines.shift() === true; },
  };
}

function capture(): { streams: Streams; stdout: () => string; stderr: () => string } {
  let out = "";
  let err = "";
  return {
    streams: { out: (text) => { out += text; }, err: (text) => { err += text; } },
    stdout: () => out,
    stderr: () => err,
  };
}

test("quickstart writes and attests the default terminal policy through the interactive path", async () => {
  const dir = join(scratch, "terminal");
  mkdirSync(dir);
  const io = capture();
  const code = await commandQuickstart([], io.streams, dir, {
    prompter: scripted(["carter", "terminal", "", "understood"]),
    doctor: async () => ({
      code: 1,
      stdout: JSON.stringify({
        ok: false,
        checks: [{ check: "attestation", status: "fail", detail: "APPROVAL.md has never been attested" }],
      }),
      stderr: "",
    }),
  });

  assert.equal(code, 0, io.stderr());
  const policy = readFileSync(join(dir, "APPROVAL.md"), "utf8");
  assert.equal(policy.includes("\naudit:\n"), false);
  assert.match(readFileSync(join(dir, ".approval", "env"), "utf8"), /^APPROVAL_HUMAN=human:carter$/mu);
  assert.ok(existsSync(join(dir, ".approval", "log", "events.jsonl")), "attestation log missing");

  const loaded = loadPolicy({ dir });
  assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.message);
  for (const entry of QUICKSTART_CLASSES) {
    const action = {
      "communicate.*": "communicate.email.external",
      "financial.*": "financial.spend",
      "files.delete.*": "files.delete.out_of_scope",
      "public.*": "public.post",
      "vcs.push.main": "vcs.push.main",
    }[entry.pattern] as string;
    const decision = resolve(loaded, action);
    assert.equal(decision.autonomy, "manual", action);
    assert.deepEqual(decision.approvers, ["carter"], action);
  }
  assert.equal(resolve(loaded, "read.shell").autonomy, "autonomous");
  assert.match(io.stdout(), /ready: 5 selected class families ask human:carter on cli/u);
  assert.match(io.stdout(), new RegExp(`activate: eval "\\$\\(approval env --dir '${dir}'\\)"`, "u"));
  assert.doesNotMatch(io.stdout(), /everything else runs/u);
});

test("quickstart refuses pipes and JSON before touching the directory", async () => {
  for (const [name, argv] of [["pipe", []], ["json", ["--json"]]] as const) {
    const dir = join(scratch, name);
    const io = capture();
    const code = await commandQuickstart([...argv], io.streams, dir, { prompter: null });
    assert.equal(code, 2);
    assert.equal(existsSync(dir), false);
    assert.match(io.stderr(), /approval init/u);
    assert.match(io.stderr(), /approval setup identity/u);
    assert.match(io.stderr(), /approval policy attest/u);
  }
});

test("the real CLI dispatch refuses piped and JSON quickstart invocations", () => {
  for (const argv of [["quickstart"], ["quickstart", "--json"]]) {
    const dir = join(scratch, `spawn-${argv.length}-${argv.at(-1) ?? "plain"}`);
    mkdirSync(dir);
    const run = spawnSync(process.execPath, [CLI_ENTRY, ...argv], {
      cwd: dir, encoding: "utf8", input: "carter\nterminal\n\nunderstood\n",
    });
    assert.equal(run.status, 2, run.stderr);
    assert.equal(existsSync(join(dir, "APPROVAL.md")), false);
    assert.match(run.stderr, /approval init/u);
  }
});

test("quickstart leaves the generated policy unattested without the typed word", async () => {
  const dir = join(scratch, "unattested");
  mkdirSync(dir);
  const io = capture();
  const code = await commandQuickstart([], io.streams, dir, {
    prompter: scripted(["carter", "1", "all", null]),
    doctor: async () => ({ code: 0, stdout: "", stderr: "" }),
  });
  assert.equal(code, 2);
  assert.ok(existsSync(join(dir, "APPROVAL.md")));
  assert.equal(existsSync(join(dir, ".approval", "log", "events.jsonl")), false);
});

test("quickstart never overwrites an existing policy", async () => {
  const dir = join(scratch, "existing-policy");
  mkdirSync(dir);
  const original = "# mine\n";
  writeFileSync(join(dir, "APPROVAL.md"), original);
  const io = capture();
  const code = await commandQuickstart([], io.streams, dir, {
    prompter: scripted(["carter", "cli", "all"]),
    doctor: async () => ({ code: 0, stdout: "", stderr: "" }),
  });
  assert.equal(code, 4, io.stderr());
  assert.equal(readFileSync(join(dir, "APPROVAL.md"), "utf8"), original);
  assert.equal(existsSync(join(dir, ".approval")), false);
});

test("quickstart refuses any existing approval instance state before prompting", async () => {
  const dir = join(scratch, "existing-home");
  mkdirSync(join(dir, ".approval"), { recursive: true });
  writeFileSync(join(dir, ".approval", "owned-by-another-instance"), "keep\n");
  const io = capture();
  let prompted = false;
  const code = await commandQuickstart([], io.streams, dir, {
    prompter: {
      readLine: () => { prompted = true; return "carter"; },
      readSecret: () => ({ ok: false, reason: "aborted" }),
      confirm: () => false,
    },
  });
  assert.equal(code, 4);
  assert.equal(prompted, false);
  assert.equal(readFileSync(join(dir, ".approval", "owned-by-another-instance"), "utf8"), "keep\n");
  assert.equal(existsSync(join(dir, "APPROVAL.md")), false);
  assert.match(io.stderr(), /setup artifacts already exist/u);
});

test("quickstart refuses when policy bytes change after review and appends no attestation", async () => {
  const dir = join(scratch, "changed-after-review");
  mkdirSync(dir);
  const answers = ["carter", "cli", "all", "understood"];
  const io = capture();
  const prompter: Prompter = {
    readLine(): string | null {
      const answer = answers.shift() ?? null;
      if (answer === "understood") writeFileSync(join(dir, "APPROVAL.md"), "# replaced after display\n");
      return answer;
    },
    readSecret: () => ({ ok: false, reason: "aborted" }),
    confirm: () => false,
  };
  const code = await commandQuickstart([], io.streams, dir, {
    prompter,
    doctor: async () => ({ code: 0, stdout: "", stderr: "" }),
  });
  assert.equal(code, 4);
  assert.match(io.stderr(), /changed after the reviewed bytes were shown/u);
  assert.equal(existsSync(join(dir, ".approval", "log", "events.jsonl")), false);
});

test("appendAttestation remains compatible for ordinary callers and expected mismatch appends nothing", () => {
  const ordinary = join(scratch, "ordinary-attest");
  mkdirSync(join(ordinary, ".approval", "log"), { recursive: true });
  writeFileSync(join(ordinary, "APPROVAL.md"), "ordinary\n");
  const ordinaryResult = appendAttestation(
    join(ordinary, ".approval", "log", "events.jsonl"),
    join(ordinary, "APPROVAL.md"),
    "human:carter",
  );
  assert.equal(ordinaryResult.ok, true);

  const mismatch = join(scratch, "mismatch-attest");
  mkdirSync(join(mismatch, ".approval", "log"), { recursive: true });
  writeFileSync(join(mismatch, "APPROVAL.md"), "changed\n");
  const mismatchLog = join(mismatch, ".approval", "log", "events.jsonl");
  const mismatchResult = appendAttestation(
    mismatchLog,
    join(mismatch, "APPROVAL.md"),
    "human:carter",
    { expectedSha256: "0".repeat(64) },
  );
  assert.equal(mismatchResult.ok, false);
  if (!mismatchResult.ok) assert.match(mismatchResult.error.message, /log was left unchanged/u);
  assert.equal(existsSync(mismatchLog), false);
});

test("quickstart is policy.core and omitted from agent-visible registry entries", () => {
  for (const command of ["approval quickstart", "node cli.js quickstart"]) {
    const classified = classifyCommand(command, []);
    assert.equal(classified.ok, true);
    if (classified.ok) assert.deepEqual(classified.classes, ["policy.core"]);
  }
  const entry = VERB_REGISTRY.find((verb) => verb.name === "quickstart");
  assert.ok(entry !== undefined);
  assert.equal(entry.human_only, true);
  assert.equal(entry.output, null);
});

test("the named human can grant a selected class", async () => {
  const dir = join(scratch, "named-grant");
  mkdirSync(dir);
  const io = capture();
  assert.equal(await commandQuickstart([], io.streams, dir, {
    prompter: scripted(["carter", "cli", "all", "understood"]),
    doctor: async () => ({ code: 0, stdout: "", stderr: "" }),
  }), 0);
  const hash = "a".repeat(64);
  writeFileSync(join(dir, "task.md"), [
    "---", "id: quickstart-grant", "title: Quickstart grant", "approval:",
    "  origin:", "    app: quickstart-test", '    created_by: "human:carter"',
    "  route:", '    assignee: "agent:test"', "    confidence: 1",
    "  state: proposed", "  actions:", "    - class: communicate.email.external",
    '      summary: "Send a message"', "      reversible: false",
    '      idempotency_key: "quickstart-grant:send"', `      payload_hash: "${hash}"`,
    "---", "", "Fixture.", "",
  ].join("\n"));
  const run = (args: string[], human?: string) => spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: dir, encoding: "utf8", env: { ...process.env, ...(human === undefined ? {} : { APPROVAL_HUMAN: human }) },
  });
  assert.equal(run(["register", "task.md", "--as", "agent:test"]).status, 0);
  assert.equal(run(["request", "quickstart-grant", "--action", "quickstart-grant:send", "--as", "agent:test"]).status, 0);
  const granted = run(["grant", "quickstart-grant:send"], "human:carter");
  assert.equal(granted.status, 0, granted.stderr);
  assert.doesNotMatch(granted.stderr, /actor-not-approver/u);
});

test("Telegram quickstart reuses the keystore and chat-discovery path without exposing the token", async () => {
  const token = "7654321:AA-quickstart-fixture-token-DO-NOT-USE";
  const chat = "-1001234567890";
  const update = messageUpdate({ chatId: chat, username: "carter" });
  const fetch: TelegramFetch = async (input) => {
    const url = String(input);
    const body = url.endsWith("/getMe")
      ? { ok: true, result: { id: 424242, is_bot: true, username: "approval_md_test_bot" } }
      : url.endsWith("/getUpdates")
        ? { ok: true, result: [{ update_id: 1, ...update }] }
        : { ok: true, result: {} };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const stored = new Map<string, string>();
    const calls: string[] = [];
    const keystore: KeystoreRunner = {
      kind: () => "keychain",
      storeGenerated: () => ({ ok: false, message: "unused" }),
      storePrompted: (service) => { calls.push(`store:${service}`); stored.set(service, token); return { ok: true, viaArgv: false }; },
      read: (service) => {
        calls.push(`read:${service}`);
        const value = stored.get(service);
        return value === undefined ? { ok: false, message: "missing" } : { ok: true, value };
      },
    };
    const sourceRunner: SourceRunner = {
      keychain: (service) => {
        const value = stored.get(service);
        return value === undefined
          ? { ok: false, code: "helper-item-missing", message: "missing fixture item" }
          : { ok: true, value };
      },
      secretService: () => ({ ok: false, code: "helper-item-missing", message: "unused" }),
    };
    const dir = join(scratch, "telegram");
    mkdirSync(dir);
    const io = capture();
    const code = await commandQuickstart([], io.streams, dir, {
      prompter: scripted(["carter", "telegram", "", true, false, "understood"]),
      setup: { keystore, fetch, apiBase: "http://127.0.0.1:1", pollTimeoutSeconds: 1 },
      sourceRunner,
      doctor: async (_dir, actor, resolvedEnv, apiBase) => {
        assert.equal(actor, "human:carter");
        assert.equal(resolvedEnv.APPROVAL_TG_TOKEN, token);
        assert.equal(resolvedEnv.APPROVAL_TG_CHAT, chat);
        assert.equal(apiBase, null);
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(code, 0, io.stderr());
    const env = readFileSync(join(dir, ".approval", "env"), "utf8");
    assert.match(env, /^APPROVAL_HUMAN=human:carter$/mu);
    assert.match(env, /^APPROVAL_TG_TOKEN=keychain:approval-tg-token-/mu);
    assert.match(env, new RegExp(`^APPROVAL_TG_CHAT=${chat}$`, "mu"));
    assert.ok(calls.some((call) => call.startsWith("store:approval-tg-token-")));
    assert.equal(`${io.stdout()}${io.stderr()}`.includes(token), false);
  } finally {
    // no server was opened: the injected transport returned fixed Telegram envelopes.
  }
});

test("Telegram preflight uses the selected local API and only the fresh instance values", async () => {
  const token = "7654321:AA-quickstart-local-doctor-token-DO-NOT-USE";
  const chat = "-1009988776655";
  const mock = await startMockBotApi(token);
  mock.queueUpdate(messageUpdate({ chatId: chat, username: "carter" }));
  const stored = new Map<string, string>();
  const keystore: KeystoreRunner = {
    kind: () => "keychain",
    storeGenerated: () => ({ ok: false, message: "unused" }),
    storePrompted: (service) => { stored.set(service, token); return { ok: true, viaArgv: false }; },
    read: (service) => {
      const value = stored.get(service);
      return value === undefined ? { ok: false, message: "missing" } : { ok: true, value };
    },
  };
  const sourceRunner: SourceRunner = {
    keychain: (service) => {
      const value = stored.get(service);
      return value === undefined
        ? { ok: false, code: "helper-item-missing", message: "missing fixture item" }
        : { ok: true, value };
    },
    secretService: () => ({ ok: false, code: "helper-item-missing", message: "unused" }),
  };
  const previous = {
    token: process.env.APPROVAL_TG_TOKEN,
    chat: process.env.APPROVAL_TG_CHAT,
    agentmail: process.env.AGENTMAIL_API_KEY,
  };
  process.env.APPROVAL_TG_TOKEN = "9999999:ambient-token-must-not-be-used";
  process.env.APPROVAL_TG_CHAT = "ambient-chat-must-not-be-used";
  process.env.AGENTMAIL_API_KEY = "ambient-agentmail-key-must-not-be-used";
  try {
    const dir = join(scratch, "telegram-local-doctor");
    mkdirSync(dir);
    const io = capture();
    const code = await commandQuickstart(["--api-base", mock.url], io.streams, dir, {
      prompter: scripted(["carter", "telegram", "", true, false, "understood"]),
      setup: { keystore, pollTimeoutSeconds: 1 },
      sourceRunner,
    });
    assert.equal(code, 0, io.stderr());
    assert.deepEqual(mock.requests.map((request) => request.method), ["getMe", "getUpdates", "getMe"]);
    assert.ok(mock.requests.every((request) => request.path.includes(token)));
    assert.equal(mock.requests.some((request) => request.path.includes("ambient-token")), false);
    assert.equal(`${io.stdout()}${io.stderr()}`.includes(token), false);
  } finally {
    if (previous.token === undefined) delete process.env.APPROVAL_TG_TOKEN;
    else process.env.APPROVAL_TG_TOKEN = previous.token;
    if (previous.chat === undefined) delete process.env.APPROVAL_TG_CHAT;
    else process.env.APPROVAL_TG_CHAT = previous.chat;
    if (previous.agentmail === undefined) delete process.env.AGENTMAIL_API_KEY;
    else process.env.AGENTMAIL_API_KEY = previous.agentmail;
    await mock.close();
  }
});

test("doctor preflight is silent on success and a failure leaves the policy unattested", async () => {
  const success = capture();
  const okDir = join(scratch, "doctor-ok");
  mkdirSync(okDir);
  assert.equal(await commandQuickstart([], success.streams, okDir, {
    prompter: scripted(["alice", "cli", "1,5", "understood"]),
    doctor: async (_dir, actor) => {
      assert.equal(actor, "human:alice");
      return { code: 0, stdout: "DOCTOR HEALTHY DETAILS", stderr: "" };
    },
  }), 0);
  assert.doesNotMatch(success.stdout(), /DOCTOR HEALTHY DETAILS/u);

  const failed = capture();
  const failDir = join(scratch, "doctor-fail");
  mkdirSync(failDir);
  assert.equal(await commandQuickstart([], failed.streams, failDir, {
    prompter: scripted(["alice", "cli", "1,5", "understood"]),
    doctor: async () => ({ code: 1, stdout: "one failed row\n", stderr: "" }),
  }), 1);
  assert.match(failed.stderr(), /one failed row/u);
  assert.match(failed.stderr(), /policy remains unattested/u);
  assert.equal(existsSync(join(failDir, ".approval", "log", "events.jsonl")), false);
});

test("the doctor subprocess is bounded by a timeout and aborts cleanly", async () => {
  const dir = join(scratch, "doctor-timeout");
  mkdirSync(dir);
  const result = await runQuickstartDoctor(dir, "human:carter", {}, null, { timeoutMs: 1 });
  assert.equal(result.code, 4);
  assert.match(result.stderr, /exceeded 1ms and was stopped/u);
});
