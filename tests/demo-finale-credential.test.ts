/**
 * The web-agent demo's finale, in the environment it actually runs in
 * (APRV-168).
 *
 * `tests/e2e-email-demo.test.ts` walks the whole story and spends its token in
 * the suite's own environment. This file walks one hop of it — the send — in the
 * shape that broke it live on 2026-09-19, in front of a rehearsal: the adapter
 * runs inside the demo server's agent child, whose environment holds no gate
 * variable of any kind and whose `HOME` is a directory the demo owns.
 *
 * What the room saw, after a human tapped Approve on their phone:
 *
 * ```
 * {"ok":false,"code":"credential-unavailable", … "the passphrase variable
 * APPROVAL_DEMO_VAULT_PASSPHRASE is unset or empty in this process, and it did
 * not resolve from …/.approval/env either" …}
 * ```
 *
 * The scoped fallback (`adapters/env-passphrase.ts`) was there and was reached.
 * What failed was underneath it: the instance's `.approval/env` names the
 * passphrase as a `keychain:` reference, macOS resolves the keychain SEARCH LIST
 * through `$HOME`, and a child whose home was redirected searches a list with no
 * login keychain in it. `core/env-file.ts` now retries the lookup once with
 * `HOME` pinned to the passwd home.
 *
 * **Everything here is a real verb.** `policy attest`, `register`, `request`,
 * `grant`, `vault set`, `adapter email`, `log verify`, each spawned as a child
 * process. Nothing writes a log line or a vault entry by hand.
 *
 * **Nothing real is touched.** The keystore is a stub `security` script on the
 * child's PATH that answers only for the passwd home, exactly as the real one
 * answers only where the login keychain is on the search list; the SMTP server
 * is `tests/smtp-mock.ts` on loopback; the instance is a scratch directory. No
 * operator's `~/demo-gate` and no real credential appears anywhere.
 *
 * **The scrub is the server's own.** The child's environment comes from
 * `examples/web-agent-demo/agent-env.mjs`, imported — the same function
 * `server.mjs` spawns the agent with. A copy of it here would prove nothing
 * about the thing that broke.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { payloadHash } from "../src/core/payload.js";
import { assertLoopback, startMockSmtp } from "./smtp-mock.js";

/** dist/tests/… -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

/**
 * dist/tests/… -> <repo>/examples/web-agent-demo/agent-env.mjs, imported for
 * real. The specifier is a variable so that TypeScript leaves the untyped
 * example module alone; the shape is asserted below before anything uses it.
 */
const AGENT_ENV_MODULE = new URL("../../examples/web-agent-demo/agent-env.mjs", import.meta.url)
  .href;
const { agentEnv } = (await import(AGENT_ENV_MODULE)) as {
  agentEnv: (demoDir: string, sourceEnv?: Record<string, string>) => Record<string, string>;
};

const HUMAN = "human:demo";
const AGENT = "agent:demo";
/** The demo policy's own name for the variable (examples/policies/demo-gate…). */
const PASSPHRASE_ENV = "APPROVAL_DEMO_VAULT_PASSPHRASE";
/** The per-instance keychain service `approval setup vault` writes. */
const KEYCHAIN_SERVICE = "approval-vault-passphrase-c7129ab2";
const PASSPHRASE = "a demo-instance vault passphrase for the APRV-168 suite";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-demo-finale-")));
let counter = 0;

/** Everything the CLI printed, across every case. Swept at the end. */
const transcript: string[] = [];
const dirs: string[] = [];

const mock = await startMockSmtp({ tls: "none", advertiseStarttls: false });
assertLoopback(mock.host);

after(async () => {
  await mock.close();

  const said = transcript.join("\n");
  assert.equal(
    said.includes(PASSPHRASE),
    false,
    "the vault passphrase appeared in this suite's captured CLI output (SPEC.md §11.1 invariant 3)",
  );
  for (const dir of dirs) {
    const log = join(dir, ".approval", "log", "events.jsonl");
    if (!existsSync(log)) continue;
    assert.equal(readFileSync(log, "utf8").includes(PASSPHRASE), false, `a secret reached ${log}`);
  }

  rmSync(scratch, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the CLI with an environment given WHOLE, not merged.
 *
 * Asynchronous for `tests/cli-adapter.test.ts`'s reason: the mock SMTP server
 * runs on this process's event loop, so a synchronous child would deadlock the
 * very loop it is waiting on.
 */
async function runCli(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  stdin = "",
): Promise<Run> {
  const run = await new Promise<Run>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
  transcript.push(run.stdout, run.stderr);
  return run;
}

/** The operator's own shell: the passphrase is in it, the way a human's is. */
function operatorEnv(extra: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) base[name] = value;
  }
  base["APPROVAL_HUMAN"] = HUMAN;
  base[PASSPHRASE_ENV] = PASSPHRASE;
  return { ...base, ...extra };
}

/**
 * A stub `security` on PATH that answers only for the passwd home, and records
 * the `$HOME` of every invocation.
 *
 * This is the whole fixture: the real binary is not consulted, no keychain is
 * read, and the behaviour being stood in for is the one that was probed on the
 * real `security` — the login keychain is on the search list when `$HOME` is
 * the account's home and is absent when it is not.
 */
function stubKeystore(journal: string): string {
  counter += 1;
  const dir = join(scratch, `bin-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  const script = [
    "#!/bin/sh",
    `printf '%s\\n' "\${HOME:-}" >> ${journal}`,
    `if [ "\${HOME:-}" != "${userInfo().homedir}" ]; then exit 44; fi`,
    "cat <<'APPROVAL_STUB_EOF'",
    PASSPHRASE,
    "APPROVAL_STUB_EOF",
  ].join("\n");
  const path = join(dir, "security");
  writeFileSync(path, `${script}\n`, "utf8");
  chmodSync(path, 0o755);
  return dir;
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
  "  communicate.email.external:",
  "    autonomy: manual",
  "vault:",
  `  passphrase_env: ${PASSPHRASE_ENV}`,
  "```",
  "",
].join("\n");

interface Instance {
  /** The gate instance, standing in for ~/demo-gate. */
  dir: string;
  actionKey: string;
  token: string;
  payloadFile: string;
  payload: Record<string, unknown>;
  /** The child's PATH prefix, and the file the stub writes its homes to. */
  stubBin: string;
  journal: string;
}

/**
 * A provisioned demo instance: an attested policy, a filled vault, a registered
 * and GRANTED email action, and a `.approval/env` whose passphrase line is a
 * keychain reference — which is what `approval setup vault` writes.
 *
 * Everything through the real CLI, in the operator's environment, exactly as a
 * human provisions an instance before a show.
 */
async function instance(): Promise<Instance> {
  counter += 1;
  const dir = join(scratch, `gate-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");

  const actionKey = `demo-finale:send-${String(counter)}`;
  const payload = {
    from: "demo@example.invalid",
    to: ["volunteer@example.invalid"],
    subject: "Approved from a phone",
    body: "Sent by an adapter inside a single-use token window.\n",
  };
  const payloadFile = join(dir, "payload.json");
  writeFileSync(payloadFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  writeFileSync(
    join(dir, "demo-finale.md"),
    [
      "---",
      "id: demo-finale",
      "title: The finale",
      "status: In Progress",
      "approval:",
      "  origin:",
      "    app: manual",
      `    created_by: "${AGENT}"`,
      "  state: proposed",
      "  actions:",
      "    - class: communicate.email.external",
      '      summary: "Send the email"',
      "      reversible: false",
      '      est_cost_usd: "0"',
      `      idempotency_key: "${actionKey}"`,
      `      payload_hash: "${payloadHash(payload)}"`,
      "---",
      "",
      "## Description",
      "The demo's fourth beat.",
      "",
    ].join("\n"),
    "utf8",
  );

  const env = operatorEnv();
  assert.equal((await runCli(["policy", "attest", "--as", HUMAN], dir, env)).code, 0);
  assert.equal((await runCli(["register", "demo-finale.md", "--as", AGENT], dir, env)).code, 0);
  assert.equal(
    (await runCli(["request", "demo-finale", "--action", actionKey, "--as", AGENT], dir, env)).code,
    0,
  );
  const granted = await runCli(["grant", actionKey, "--as", HUMAN, "--json"], dir, env);
  assert.equal(granted.code, 0, granted.stderr);
  const token = String((JSON.parse(granted.stdout) as Record<string, unknown>)["token"]);

  for (const [name, value] of [
    ["smtp.host", mock.host],
    ["smtp.port", String(mock.port)],
    ["smtp.security", "none"],
  ] as const) {
    // `vault set` takes the value on stdin and has no `--value` flag: a secret
    // in an argv is world-readable in `ps` for the length of the call.
    const set = await runCli(["vault", "set", name], dir, env, value);
    assert.equal(set.code, 0, set.stderr);
  }

  // The instance's source map, as `approval setup vault` writes it on macOS:
  // the policy's variable, pointing at a per-instance keychain item.
  const envFile = join(dir, ".approval", "env");
  mkdirSync(join(dir, ".approval"), { recursive: true });
  writeFileSync(envFile, `${PASSPHRASE_ENV}=keychain:${KEYCHAIN_SERVICE}\n`, "utf8");
  chmodSync(envFile, 0o600);

  // The home the demo server generates for its agent child. It exists on a
  // provisioned instance; it holds nothing this test needs.
  mkdirSync(String(agentEnv(dir)["HOME"]), { recursive: true });

  counter += 1;
  const journal = join(scratch, `security-homes-${String(counter)}.txt`);
  return { dir, actionKey, token, payloadFile, payload, stubBin: stubKeystore(journal), journal };
}

/** The agent child's environment, from the demo server's own definition. */
function childEnv(unit: Instance): Record<string, string> {
  return agentEnv(unit.dir, {
    PATH: `${unit.stubBin}${delimiter}${process.env["PATH"] ?? ""}`,
  });
}

function events(dir: string): string[] {
  return readFileSync(join(dir, ".approval", "log", "events.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as { event: string }).event);
}

function homesSeen(journal: string): string[] {
  if (!existsSync(journal)) return [];
  return readFileSync(journal, "utf8")
    .split("\n")
    .filter((entry) => entry.length > 0);
}

// ---------------------------------------------------------------------------

test("the child's environment carries no gate variable at all", async () => {
  const unit = await instance();
  const env = childEnv(unit);
  for (const name of Object.keys(env)) {
    assert.equal(
      /APPROVAL|VAULT|TELEGRAM|TG_/u.test(name),
      false,
      `${name} crossed into the agent child`,
    );
  }
  assert.equal(env["HOME"], join(unit.dir, "agent-home"), "the child's HOME is the demo's own");
  assert.equal(Object.values(env).includes(PASSPHRASE), false, "the passphrase crossed by value");
});

test("the finale sends, in the agent child's environment, with the passphrase in the keychain (APRV-168)", async () => {
  const unit = await instance();
  const before = mock.connections;

  const sent = await runCli(
    [
      "adapter",
      "email",
      unit.actionKey,
      "--token",
      unit.token,
      "--payload",
      unit.payloadFile,
      "--as",
      AGENT,
      "--json",
    ],
    unit.dir,
    childEnv(unit),
  );
  assert.equal(sent.code, 0, `${sent.stdout}${sent.stderr}`);

  const result = JSON.parse(sent.stdout) as Record<string, unknown>;
  assert.equal(result["ok"], true);
  assert.equal(result["outcome"], "execution.completed");
  assert.equal(result["payload_hash"], payloadHash(unit.payload));

  assert.equal(mock.connections, before + 1, "exactly one SMTP session was expected");
  assert.ok(mock.last()?.message?.includes("Subject: Approved from a phone"));
  assert.deepEqual(events(unit.dir).slice(-2), ["execution.started", "execution.completed"]);
  assert.equal((await runCli(["log", "verify", "--json"], unit.dir, operatorEnv())).code, 0);

  // The lookup the demo needed, in pairs: the child's own HOME first — which is
  // where the live failure stopped — then the passwd home. One pair per
  // credential the adapter declares, because the provider reads the passphrase
  // per credential rather than caching it across the window.
  const homes = homesSeen(unit.journal);
  assert.ok(homes.length >= 2 && homes.length % 2 === 0, `odd lookup count: ${String(homes.length)}`);
  for (let index = 0; index < homes.length; index += 2) {
    assert.deepEqual(
      [homes[index], homes[index + 1]],
      [join(unit.dir, "agent-home"), userInfo().homedir],
    );
  }

  // Nothing the child printed carries the passphrase, and neither does the log.
  // (The suite-wide sweep repeats this; here it is part of the walk.)
  assert.equal(sent.stdout.includes(PASSPHRASE), false);
  assert.equal(sent.stderr.includes(PASSPHRASE), false);
});

test("without the token the same child resolves nothing and sends nothing", async () => {
  const unit = await instance();
  const before = mock.connections;

  const refused = await runCli(
    ["adapter", "email", unit.actionKey, "--payload", unit.payloadFile, "--as", AGENT, "--json"],
    unit.dir,
    childEnv(unit),
  );
  assert.equal(refused.code, 5, refused.stderr);
  const error = JSON.parse(refused.stderr.trim().split("\n")[0] as string) as Record<
    string,
    unknown
  >;
  const detail = (error["error"] ?? error) as Record<string, unknown>;
  assert.equal(detail["code"], "token-required");
  assert.equal(detail["acted"], false);

  assert.equal(mock.connections, before, "a refusal opened an SMTP session");
  assert.equal(
    homesSeen(unit.journal).length,
    0,
    "the environment source map was read without a token behind it",
  );
  assert.equal(events(unit.dir).includes("execution.started"), false);
});
