/**
 * `approval setup` CLI tests (APRV-74).
 *
 * Two halves, for two different claims.
 *
 * **Spawned, non-interactive.** Every subcommand is run as a real child process
 * with a piped stdin, which is the CI and agent case, and every one must exit 2
 * and print the documented commands to run instead. This half also proves the
 * property that makes the whole verb safe to ship: **nothing under `npm test`
 * can reach a keystore**, because the spawned CLI never gets past the terminal
 * check and the in-process cases hand over a fake.
 *
 * **In-process, with the human's side supplied.** `setup`'s prompter, keystore
 * and `fetch` are injected, so a scripted prompter answers the questions, a
 * fake keystore records what was stored, and the Bot API is the loopback mock.
 * This is the only honest way to test a verb whose entire subject is a
 * conversation with a person: the alternative is a suite that needs a terminal,
 * writes to the developer's real Keychain, and talks to the real Bot API — and
 * the last of those would put a real bot token in a test run.
 *
 * Three sweeps run over the whole suite rather than over one case:
 *
 * - **every captured byte is scanned for the fixture secrets**, with an opt-in
 *   `emitsValues` exemption per call, exactly as `tests/cli-env.test.ts` does
 *   it. There is no exempt path in `setup` at all — it is a verb that stores
 *   secrets and prints none — so the sweep here has no exemptions and the flag
 *   exists only so that a future one has to be marked by hand;
 * - **every log file any case touched is byte-compared** before and after, so
 *   "setup appends nothing to the log" is an assertion and not a claim; and
 * - **every `getUpdates` body the mock received from setup is checked for an
 *   `offset` key**, which is the invariant the Telegram flow is built around.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { envFilePathFor } from "../src/core/env-file.js";
import { EXIT_INTEGRITY, EXIT_IO, EXIT_OK, EXIT_USAGE } from "../src/cli/exit-codes.js";
import {
  DEFAULT_SAMPLING_ENV,
  SERVICE_SAMPLING_SECRET,
  SERVICE_TELEGRAM_TOKEN,
  SERVICE_VAULT_PASSPHRASE,
  commandSetup,
  type KeystoreKind,
  type KeystoreRunner,
  type SetupDeps,
  type StoreOutcome,
} from "../src/cli/setup.js";
import type { Prompter, SecretRead } from "../src/cli/prompt.js";
import type { Streams } from "../src/cli/main.js";
import type { TelegramFetch } from "../src/channels/telegram.js";
import { assertLocal, callbackUpdate, messageUpdate, startMockBotApi } from "./telegram-mock.js";

/** dist/tests/cli-setup.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const TOKEN = "7654321:AA-approval-md-setup-fixture-token-DO-NOT-USE";
const GENERATED = "generated-approval-md-setup-3fa91c-DO-NOT-USE";
const HUMAN = "human:carter";
const CHAT = "-1001234567890";

/** Every fixture value that must never appear on any path of this verb. */
const SECRETS = [TOKEN, GENERATED] as const;

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-cli-setup-")));
let counter = 0;

const transcript: string[] = [];
const homes: string[] = [];

after(() => {
  const said = transcript.join("\n");
  for (const needle of SECRETS) {
    assert.equal(
      said.includes(needle),
      false,
      "a fixture secret was printed by `approval setup`. This verb stores secrets and prints none: not the token it reads back to call getMe, not the passphrase it mints, not the sampling secret (SPEC.md §5.2, §11.1 invariant 3).",
    );
  }
  rmSync(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A policy naming every variable, so the declared-name paths are exercised. */
const FULL_POLICY = `# Approval Policy

\`\`\`yaml approval-policy
version: "0.1"

defaults:
  autonomy: manual
  channel: telegram

classes:
  read.*: { autonomy: autonomous }

audit:
  supervised_sample_rate: 0.10
  sampling_secret_env: APPROVAL_AUDIT_SECRET

vault:
  passphrase_env: APPROVAL_VAULT_PASSPHRASE

channels:
  telegram:
    chat_id_env: APPROVAL_TG_CHAT
    token_env: APPROVAL_TG_TOKEN
\`\`\`
`;

/** A policy that names NO sampling secret, for the "print the amendment" path. */
const NO_SAMPLING_POLICY = FULL_POLICY.replace(
  "  supervised_sample_rate: 0.10\n  sampling_secret_env: APPROVAL_AUDIT_SECRET\n",
  "  supervised_sample_rate: 0.10\n",
);

interface Home {
  dir: string;
  envPath: string;
  logPath: string;
}

/**
 * A working directory with a policy, a log directory, and — because the log is
 * what this suite watches — a real log file whose bytes are recorded.
 */
function makeHome(options: { policy?: string; env?: string } = {}): Home {
  counter += 1;
  const dir = join(scratch, `home-${String(counter)}`);
  mkdirSync(join(dir, ".approval", "log"), { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), options.policy ?? FULL_POLICY, "utf8");
  const logPath = join(dir, ".approval", "log", "events.jsonl");
  // Not a real chain, and it does not need to be: the claim under test is that
  // setup does not TOUCH these bytes, and any bytes prove that equally well.
  writeFileSync(logPath, `{"seq":1,"event":"log.opened"}\n`, "utf8");
  const envPath = envFilePathFor(logPath);
  if (options.env !== undefined) {
    writeFileSync(envPath, options.env, "utf8");
    chmodSync(envPath, 0o600);
  }
  homes.push(dir);
  return { dir, envPath, logPath };
}

function readEnvLines(home: Home): string[] {
  if (!existsSync(home.envPath)) return [];
  return readFileSync(home.envPath, "utf8").split("\n").filter((line) => line.length > 0);
}

// ---------------------------------------------------------------------------
// The fakes
// ---------------------------------------------------------------------------

interface FakeKeystore extends KeystoreRunner {
  /** What is in the fake store, by service name. */
  readonly items: Map<string, string>;
  /** Every call made, so "nothing was stored" is a real assertion. */
  readonly calls: string[];
}

/**
 * A keystore that is a `Map`.
 *
 * `storePrompted` is the interesting one: on the real macOS path the VALUE is
 * collected by Apple's own prompt and never enters this process, so the fake
 * models exactly that — it takes no value argument, and it invents one the way
 * the operator's terminal would have supplied one.
 */
function fakeKeystore(
  kind: KeystoreKind,
  options: { prompted?: string; failStore?: boolean; viaArgv?: boolean } = {},
): FakeKeystore {
  const items = new Map<string, string>();
  const calls: string[] = [];
  return {
    items,
    calls,
    kind: () => kind,
    storeGenerated(service, value): StoreOutcome {
      calls.push(`storeGenerated:${service}`);
      if (options.failStore === true) return { ok: false, message: "fake: the keyring is locked" };
      items.set(service, value);
      return { ok: true, viaArgv: options.viaArgv === true };
    },
    storePrompted(service): StoreOutcome {
      calls.push(`storePrompted:${service}`);
      if (options.failStore === true) return { ok: false, message: "fake: the keyring is locked" };
      items.set(service, options.prompted ?? TOKEN);
      return { ok: true, viaArgv: false };
    },
    read(service) {
      calls.push(`read:${service}`);
      const value = items.get(service);
      return value === undefined
        ? { ok: false, message: `fake: no item ${service}` }
        : { ok: true, value };
    },
  };
}

interface ScriptedPrompter extends Prompter {
  /** Every prompt the verb printed, in order. */
  readonly asked: string[];
  /** Answers not yet consumed. Empty at the end means the script was right. */
  readonly remaining: unknown[];
}

/**
 * A prompter driven by a script.
 *
 * Each entry answers the next question of its kind: a string answers a
 * `readLine`, a boolean answers a `confirm`, and `{secret}` / `"ABORT"` answers
 * a `readSecret`. An exhausted script is an error rather than a default,
 * because a `setup` that asked one more question than the test expected must
 * fail the test rather than silently take "no" for it.
 */
function scriptedPrompter(script: unknown[]): ScriptedPrompter {
  const remaining = [...script];
  const asked: string[] = [];
  const next = (prompt: string): unknown => {
    asked.push(prompt);
    if (remaining.length === 0) {
      throw new Error(`setup asked an unscripted question: ${JSON.stringify(prompt)}`);
    }
    return remaining.shift();
  };
  return {
    asked,
    remaining,
    readLine(prompt) {
      const answer = next(prompt);
      return answer === null ? null : String(answer);
    },
    readSecret(prompt): SecretRead {
      const answer = next(prompt);
      if (answer === "ABORT") return { ok: false, reason: "aborted" };
      return { ok: true, value: String(answer) };
    },
    confirm(prompt) {
      const answer = next(prompt);
      return answer === true;
    },
  };
}

interface Captured {
  code: number;
  out: string;
  err: string;
  /** The log's bytes before and after. Equal, always. */
  logBefore: string;
  logAfter: string;
}

/** Run a subcommand in-process, capturing everything and watching the log. */
async function run(
  argv: string[],
  home: Home,
  deps: SetupDeps,
  options: { emitsValues?: boolean } = {},
): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const streams: Streams = {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  };
  const logBefore = readFileSync(home.logPath, "utf8");
  const code = await commandSetup(argv, streams, home.dir, deps);
  const logAfter = readFileSync(home.logPath, "utf8");

  const captured: Captured = {
    code,
    out: out.join(""),
    err: err.join(""),
    logBefore,
    logAfter,
  };
  if (options.emitsValues !== true) transcript.push(captured.out, captured.err);

  // The log claim, asserted on EVERY run rather than in one case: nothing under
  // `setup` appends, attests, or rewrites a byte of it.
  assert.equal(
    captured.logAfter,
    captured.logBefore,
    `\`approval setup ${argv.join(" ")}\` changed ${home.logPath}. Nothing under setup may append to the log: configuration is not an authorized action, and the log is the record of authorized actions.`,
  );
  return captured;
}

// ===========================================================================
// Half one: the spawned CLI, with no terminal
// ===========================================================================

interface Spawned {
  code: number;
  stdout: string;
  stderr: string;
}

function spawnCli(args: string[], cwd: string): Spawned {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [
    "APPROVAL_HUMAN",
    "APPROVAL_TG_TOKEN",
    "APPROVAL_TG_CHAT",
    "APPROVAL_VAULT_PASSPHRASE",
    "APPROVAL_AUDIT_SECRET",
  ]) {
    delete childEnv[name];
  }
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    env: childEnv,
    encoding: "utf8",
    // A pipe, which is the whole point: `spawnSync` gives the child no tty, so
    // `process.stdin.isTTY` is undefined exactly as it is under CI or an agent.
    input: "",
  });
  const run = { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  transcript.push(run.stdout, run.stderr);
  return run;
}

const SUBCOMMANDS = ["identity", "vault", "sampling", "telegram"] as const;

for (const sub of SUBCOMMANDS) {
  test(`setup ${sub} refuses a non-terminal stdin at exit 2 and prints the scripted path`, () => {
    const home = makeHome();
    const before = readFileSync(home.logPath, "utf8");
    const result = spawnCli(["setup", sub], home.dir);

    assert.equal(result.code, EXIT_USAGE, result.stderr);
    assert.match(result.stderr, /stdin is not a terminal/u);
    assert.match(result.stderr, /Nothing was written/u);
    // The alternative is EXACT: an operator copies it, so it must be a command.
    assert.match(result.stderr, /approval env --check/u);
    assert.match(result.stderr, /export |printf |security |secret-tool /u);
    // And it never invents a way to hand a secret to a command line.
    assert.doesNotMatch(result.stderr, /-w \S/u);

    assert.equal(existsSync(home.envPath), false, "a refusal wrote .approval/env");
    assert.equal(readFileSync(home.logPath, "utf8"), before);
  });

  test(`setup ${sub} refuses --json at exit 2`, () => {
    const home = makeHome();
    const result = spawnCli(["setup", sub, "--json"], home.dir);
    assert.equal(result.code, EXIT_USAGE, result.stderr);
    assert.match(result.stderr, /--json was given/u);
    assert.equal(existsSync(home.envPath), false);
  });
}

test("setup with no subcommand, an unknown one, and --help", () => {
  const home = makeHome();

  const missing = spawnCli(["setup"], home.dir);
  assert.equal(missing.code, EXIT_USAGE);
  assert.match(missing.stderr, /missing subcommand/u);

  const unknown = spawnCli(["setup", "keychain"], home.dir);
  assert.equal(unknown.code, EXIT_USAGE);
  assert.match(unknown.stderr, /unknown subcommand "keychain"/u);

  const help = spawnCli(["setup", "--help"], home.dir);
  assert.equal(help.code, EXIT_OK);
  assert.match(help.stdout, /approval setup — interactive configuration/u);
  assert.match(help.stdout, /REFUSES WHEN STDIN IS NOT A TERMINAL/u);
  assert.match(help.stdout, /never {3}appends to the log/u);

  for (const sub of SUBCOMMANDS) {
    const subHelp = spawnCli(["setup", sub, "--help"], home.dir);
    assert.equal(subHelp.code, EXIT_OK, subHelp.stderr);
    assert.match(subHelp.stdout, new RegExp(`approval setup ${sub} —`, "u"));
  }
});

test("the root help lists setup and says it is interactive", () => {
  const home = makeHome();
  const help = spawnCli(["--help"], home.dir);
  assert.equal(help.code, EXIT_OK);
  assert.match(help.stdout, /approval setup {6}identity\|vault\|sampling\|telegram/u);
  assert.match(help.stdout, /\n {2}setup {5}the WRITER for that file/u);
});

// ===========================================================================
// Half two: identity
// ===========================================================================

test("setup identity validates, writes the line, and appends nothing", async () => {
  const home = makeHome();
  const prompter = scriptedPrompter([HUMAN]);
  const result = await run(["identity"], home, { prompter, keystore: fakeKeystore("keychain") });

  assert.equal(result.code, EXIT_OK, result.err);
  assert.deepEqual(readEnvLines(home), [`APPROVAL_HUMAN=${HUMAN}`]);
  assert.equal(statSync(home.envPath).mode & 0o777, 0o600);
  assert.deepEqual(prompter.remaining, []);
  // The identity is not a secret and IS echoed; the inertness note is not
  // optional, because a line nobody evaluates does nothing at all.
  assert.match(result.out, /invariant 7/u);
  assert.match(result.out, /eval "\$\(approval env\)"/u);
});

test("setup identity refuses an agent: actor and writes nothing", async () => {
  const home = makeHome();
  const prompter = scriptedPrompter(["agent:claude"]);
  const result = await run(["identity"], home, { prompter, keystore: fakeKeystore("keychain") });

  assert.equal(result.code, EXIT_USAGE);
  assert.match(result.err, /is not a human identity/u);
  assert.match(result.err, /\^human:\.\+/u);
  assert.equal(existsSync(home.envPath), false);
});

test("setup identity needs no APPROVAL_HUMAN — it is the verb that sets one", async () => {
  const home = makeHome();
  // No --as, and the suite's environment carries no APPROVAL_HUMAN. Every other
  // subcommand refuses in this state; this one must not.
  const prompter = scriptedPrompter([HUMAN]);
  const result = await run(["identity"], home, { prompter, keystore: fakeKeystore("none") });
  assert.equal(result.code, EXIT_OK, result.err);
  assert.deepEqual(readEnvLines(home), [`APPROVAL_HUMAN=${HUMAN}`]);
});

// ===========================================================================
// vault and sampling
// ===========================================================================

test("setup vault generates, stores in the keystore, and writes only the source", async () => {
  const home = makeHome();
  const keystore = fakeKeystore("keychain");
  const prompter = scriptedPrompter([]);
  const result = await run(["vault", "--as", HUMAN], home, {
    prompter,
    keystore,
    generate: () => GENERATED,
  });

  assert.equal(result.code, EXIT_OK, result.err);
  assert.deepEqual(readEnvLines(home), [
    `APPROVAL_VAULT_PASSPHRASE=keychain:${SERVICE_VAULT_PASSPHRASE}`,
  ]);
  assert.equal(keystore.items.get(SERVICE_VAULT_PASSPHRASE), GENERATED);
  assert.deepEqual(keystore.calls, [`storeGenerated:${SERVICE_VAULT_PASSPHRASE}`]);
  // The variable NAME and the retrieval command, and never the value. The
  // suite-wide sweep is the real assertion; this one names the intent.
  assert.match(result.out, /APPROVAL_VAULT_PASSPHRASE/u);
  assert.match(result.out, /security find-generic-password/u);
  assert.equal(result.out.includes(GENERATED), false);
});

test("setup vault is human-only", async () => {
  const home = makeHome();
  const result = await run(["vault"], home, {
    prompter: scriptedPrompter([]),
    keystore: fakeKeystore("keychain"),
  });
  assert.equal(result.code, EXIT_USAGE);
  assert.match(result.err, /no human identity/u);
  assert.match(result.err, /setup identity/u);
  assert.equal(existsSync(home.envPath), false);
});

test("setup sampling is human-only too", async () => {
  const home = makeHome();
  const result = await run(["sampling", "--as", "agent:claude"], home, {
    prompter: scriptedPrompter([]),
    keystore: fakeKeystore("keychain"),
  });
  assert.equal(result.code, EXIT_USAGE);
  assert.match(result.err, /human-only/u);
});

test("setup vault warns before re-keying an existing vault, and no means no", async () => {
  const home = makeHome();
  writeFileSync(join(home.dir, ".approval", "vault.enc"), "{}", "utf8");
  const keystore = fakeKeystore("keychain");
  const result = await run(["vault", "--as", HUMAN], home, {
    prompter: scriptedPrompter([false]),
    keystore,
    generate: () => GENERATED,
  });

  assert.equal(result.code, EXIT_OK);
  assert.match(result.out, /becomes unreadable/u);
  assert.match(result.out, /nothing was generated, stored, or written/u);
  assert.deepEqual(keystore.calls, [], "a declined re-key still touched the keystore");
  assert.equal(existsSync(home.envPath), false);
});

test("setup sampling uses the policy's name when it has one", async () => {
  const home = makeHome();
  const keystore = fakeKeystore("secret-service");
  const result = await run(["sampling", "--as", HUMAN], home, {
    prompter: scriptedPrompter([]),
    keystore,
    generate: () => GENERATED,
  });

  assert.equal(result.code, EXIT_OK, result.err);
  assert.deepEqual(readEnvLines(home), [
    `APPROVAL_AUDIT_SECRET=secret-service:${SERVICE_SAMPLING_SECRET}`,
  ]);
  assert.equal(keystore.items.get(SERVICE_SAMPLING_SECRET), GENERATED);
  assert.match(result.out, /secret-tool lookup approval/u);
  assert.doesNotMatch(result.out, /SAMPLING IS STILL OFF/u);
});

test("setup sampling defaults the name, says sampling is still off, and prints the amendment", async () => {
  const home = makeHome({ policy: NO_SAMPLING_POLICY });
  const result = await run(["sampling", "--as", HUMAN], home, {
    prompter: scriptedPrompter([]),
    keystore: fakeKeystore("keychain"),
    generate: () => GENERATED,
  });

  assert.equal(result.code, EXIT_OK, result.err);
  assert.deepEqual(readEnvLines(home), [
    `${DEFAULT_SAMPLING_ENV}=keychain:${SERVICE_SAMPLING_SECRET}`,
  ]);
  assert.match(result.out, /SAMPLING IS STILL OFF/u);
  assert.match(result.out, /sampling_secret_env: APPROVAL_SAMPLING_SECRET/u);
  assert.match(result.out, /approval policy amend/u);
  // And it did NOT edit the policy: the ceremony is the human's.
  assert.equal(readFileSync(join(home.dir, "APPROVAL.md"), "utf8"), NO_SAMPLING_POLICY);
});

test("a keystore that refuses leaves the env file untouched, at exit 4", async () => {
  const home = makeHome();
  const result = await run(["vault", "--as", HUMAN], home, {
    prompter: scriptedPrompter([]),
    keystore: fakeKeystore("keychain", { failStore: true }),
    generate: () => GENERATED,
  });
  assert.equal(result.code, EXIT_IO);
  assert.match(result.err, /the keyring is locked/u);
  assert.equal(existsSync(home.envPath), false);
});

test("the argv fallback for a generated secret is reported, not hidden", async () => {
  const home = makeHome();
  const result = await run(["vault", "--as", HUMAN], home, {
    prompter: scriptedPrompter([]),
    keystore: fakeKeystore("keychain", { viaArgv: true }),
    generate: () => GENERATED,
  });
  assert.equal(result.code, EXIT_OK, result.err);
  assert.match(result.out, /through its argv/u);
  assert.match(result.out, /visible in `ps`/u);
});

// ===========================================================================
// No keystore: the plaintext offer
// ===========================================================================

test("with no keystore, a plaintext literal needs a typed `yes` in full", async () => {
  const home = makeHome();
  // `y` is not `yes`, and that is the whole point of the question.
  const declined = await run(["vault", "--as", HUMAN], home, {
    prompter: scriptedPrompter(["y"]),
    keystore: fakeKeystore("none"),
    generate: () => GENERATED,
  });
  assert.equal(declined.code, EXIT_OK);
  assert.match(declined.out, /not confirmed: nothing was stored/u);
  assert.equal(existsSync(home.envPath), false);

  const accepted = await run(
    ["vault", "--as", HUMAN],
    home,
    {
      prompter: scriptedPrompter(["yes"]),
      keystore: fakeKeystore("none"),
      generate: () => GENERATED,
    },
    // The one place a value legitimately lands in a file this suite reads back:
    // the operator asked for a plaintext literal, having been told what it is.
    { emitsValues: true },
  );
  assert.equal(accepted.code, EXIT_OK, accepted.err);
  assert.deepEqual(readEnvLines(home), [`APPROVAL_VAULT_PASSPHRASE=${GENERATED}`]);
  assert.match(accepted.out, /PLAINTEXT/u);
  assert.match(accepted.out, /approval env --check/u);
  // Even here, the VALUE is not printed — only the fact that it is a literal.
  assert.equal(accepted.out.includes(GENERATED), false);
});

// ===========================================================================
// Re-running over an existing entry
// ===========================================================================

test("a re-run asks before replacing, and reports what it left alone", async () => {
  const home = makeHome({
    env: `# my own comment, which must survive\nAPPROVAL_HUMAN=human:someone-else\nAPPROVAL_TG_CHAT=999\n`,
  });
  const keystore = fakeKeystore("keychain");

  const declined = await run(["identity"], home, {
    prompter: scriptedPrompter([false]),
    keystore,
  });
  assert.equal(declined.code, EXIT_OK, declined.err);
  assert.match(declined.out, /already has a line/u);
  assert.match(declined.out, /left alone/u);
  assert.deepEqual(readEnvLines(home), [
    "# my own comment, which must survive",
    "APPROVAL_HUMAN=human:someone-else",
    "APPROVAL_TG_CHAT=999",
  ]);

  const accepted = await run(["identity"], home, {
    prompter: scriptedPrompter([true, HUMAN]),
    keystore,
  });
  assert.equal(accepted.code, EXIT_OK, accepted.err);
  assert.deepEqual(readEnvLines(home), [
    "# my own comment, which must survive",
    `APPROVAL_HUMAN=${HUMAN}`,
    "APPROVAL_TG_CHAT=999",
  ]);
  // Replaced IN PLACE, and the previous value was never echoed at it.
  assert.equal(accepted.out.includes("human:someone-else"), false);
});

test("the writer preserves comments, ordering, blank lines, and mode", async () => {
  const home = makeHome({
    env: `# header\n\nAPPROVAL_TG_CHAT=42\n\n# trailing note\n`,
  });
  const result = await run(["identity"], home, {
    prompter: scriptedPrompter([HUMAN]),
    keystore: fakeKeystore("keychain"),
  });
  assert.equal(result.code, EXIT_OK, result.err);
  assert.equal(
    readFileSync(home.envPath, "utf8"),
    `# header\n\nAPPROVAL_TG_CHAT=42\n\n# trailing note\nAPPROVAL_HUMAN=${HUMAN}\n`,
  );
  assert.equal(statSync(home.envPath).mode & 0o777, 0o600);
});

test("a file whose mode is not 0600 is refused before anything is written", async () => {
  const home = makeHome({ env: `APPROVAL_TG_CHAT=42\n` });
  chmodSync(home.envPath, 0o644);
  const keystore = fakeKeystore("keychain");
  const result = await run(["vault", "--as", HUMAN], home, {
    prompter: scriptedPrompter([]),
    keystore,
    generate: () => GENERATED,
  });
  assert.equal(result.code, EXIT_IO);
  assert.match(result.err, /env-file-mode/u);
  assert.match(result.err, /chmod 600/u);
  assert.deepEqual(keystore.calls, [], "a refused file still reached the keystore");
});

// ===========================================================================
// telegram
// ===========================================================================

/** The mock, as a `TelegramFetch`. Every case asserts the base is loopback. */
function mockFetch(): TelegramFetch {
  return globalThis.fetch as unknown as TelegramFetch;
}

/** Every `getUpdates` body setup sent, parsed. */
function getUpdatesBodies(requests: ReadonlyArray<{ method: string; body: Record<string, unknown> }>): Record<string, unknown>[] {
  return requests.filter((entry) => entry.method === "getUpdates").map((entry) => entry.body);
}

test("setup telegram: token, getMe, chat discovery, both lines — and no offset, ever", async () => {
  const mock = await startMockBotApi(TOKEN);
  try {
    const home = makeHome();
    const keystore = fakeKeystore("keychain", { prompted: TOKEN });

    // A running listener's pending decision, queued BEFORE setup runs. It must
    // still be there afterwards: setup asks only for `message` updates and
    // acknowledges nothing, so nothing it does can consume this.
    mock.queueUpdate(callbackUpdate({ data: "g:nonce:task-1:act", chatId: CHAT }));
    mock.queueUpdate(messageUpdate({ chatId: CHAT, type: "group", title: "Approvals" }));
    assert.equal(mock.pendingUpdateCount(), 2);

    const prompter = scriptedPrompter([
      "", // Enter, after "send the bot a message"
      true, // use chat <id>?
      false, // send a test message? — default no, and taken
    ]);
    const result = await run(["telegram", "--as", HUMAN], home, {
      prompter,
      keystore,
      fetch: mockFetch(),
      apiBase: assertLocal(mock.url),
      pollTimeoutSeconds: 1,
    });

    assert.equal(result.code, EXIT_OK, result.err);
    assert.deepEqual(readEnvLines(home), [
      `APPROVAL_TG_TOKEN=keychain:${SERVICE_TELEGRAM_TOKEN}`,
      `APPROVAL_TG_CHAT=${CHAT}`,
    ]);

    // The token was collected by the KEYSTORE's prompt, not by ours: the
    // scripted prompter was never asked for it, and the value came back over
    // the read seam.
    assert.deepEqual(keystore.calls, [
      `storePrompted:${SERVICE_TELEGRAM_TOKEN}`,
      `read:${SERVICE_TELEGRAM_TOKEN}`,
    ]);
    assert.equal(
      prompter.asked.some((question) => /token/iu.test(question)),
      false,
      "setup asked for the token itself on a machine whose keystore can prompt for it",
    );
    assert.deepEqual(prompter.remaining, []);

    // THE INVARIANT: no getUpdates from this verb carried an offset.
    const polls = getUpdatesBodies(mock.requests);
    assert.ok(polls.length > 0, "setup made no getUpdates call at all");
    for (const body of polls) {
      assert.equal(
        Object.hasOwn(body, "offset"),
        false,
        "a getUpdates from `approval setup telegram` carried an offset. An offset is an ACKNOWLEDGEMENT: it tells the Bot API everything below it may be discarded, and a running listener's callback_query would never arrive.",
      );
      assert.deepEqual(body["allowed_updates"], ["message"]);
    }

    // And the listener's callback is exactly where it was.
    assert.equal(
      mock.pendingUpdateCount(),
      1,
      "setup consumed a queued callback_query; a running listener would have lost its decision",
    );
    // Provably deliverable: a poll that asks for callbacks still gets it.
    const response = await fetch(`${mock.url}/bot${TOKEN}/getUpdates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timeout: 0, allowed_updates: ["callback_query"] }),
    });
    const envelope = (await response.json()) as { result: unknown[] };
    assert.equal(envelope.result.length, 1);

    // No message was sent: the proof step defaulted to no and was answered no.
    assert.deepEqual(mock.sentTexts(), []);
    assert.match(result.out, /No update was acknowledged by this verb/u);
  } finally {
    await mock.close();
  }
});

test("setup telegram: several candidates are numbered and picked", async () => {
  const mock = await startMockBotApi(TOKEN);
  try {
    const home = makeHome();
    mock.queueUpdate(messageUpdate({ chatId: "111", username: "carter" }));
    mock.queueUpdate(messageUpdate({ chatId: "222", type: "group", title: "Ops" }));
    mock.queueUpdate(messageUpdate({ chatId: "333", firstName: "Nameless" }));

    const prompter = scriptedPrompter(["", "2", false]);
    const result = await run(["telegram", "--as", HUMAN], home, {
      prompter,
      keystore: fakeKeystore("keychain", { prompted: TOKEN }),
      fetch: mockFetch(),
      apiBase: assertLocal(mock.url),
      pollTimeoutSeconds: 1,
    });

    assert.equal(result.code, EXIT_OK, result.err);
    // Newest first: 333, 222, 111 — so choice 2 is the group.
    assert.match(result.out, /1\. 333 \(private, Nameless\)/u);
    assert.match(result.out, /2\. 222 \(group, Ops\)/u);
    assert.match(result.out, /3\. 111 \(private, @carter\)/u);
    assert.ok(readEnvLines(home).includes("APPROVAL_TG_CHAT=222"));
  } finally {
    await mock.close();
  }
});

test("setup telegram: zero candidates exits 1 with the manual curl, and writes nothing", async () => {
  const mock = await startMockBotApi(TOKEN);
  try {
    const home = makeHome();
    const prompter = scriptedPrompter(["", "", ""]);
    const result = await run(["telegram", "--as", HUMAN], home, {
      prompter,
      keystore: fakeKeystore("keychain", { prompted: TOKEN }),
      fetch: mockFetch(),
      apiBase: assertLocal(mock.url),
      pollTimeoutSeconds: 0,
    });

    assert.equal(result.code, EXIT_INTEGRITY, result.out);
    assert.match(result.err, /no message reached/u);
    assert.match(result.err, /curl -s/u);
    assert.match(result.err, /getUpdates/u);
    assert.match(result.err, /privacy mode/u);
    // The curl carries a PLACEHOLDER, never the token it is holding.
    assert.match(result.err, /bot<token>/u);
    assert.equal(existsSync(home.envPath), false);
    assert.equal(getUpdatesBodies(mock.requests).length, 3, "it did not retry three times");
  } finally {
    await mock.close();
  }
});

test("setup telegram: a refused getMe stops before the chat questions", async () => {
  const mock = await startMockBotApi("a-different-token-entirely");
  try {
    const home = makeHome();
    // The keystore hands back OUR token; the mock only answers for its own, so
    // the path is unauthorised — the 401-shaped refusal the real API gives.
    const prompter = scriptedPrompter([]);
    const result = await run(["telegram", "--as", HUMAN], home, {
      prompter,
      keystore: fakeKeystore("keychain", { prompted: TOKEN }),
      fetch: mockFetch(),
      apiBase: assertLocal(mock.url),
    });

    assert.equal(result.code, EXIT_INTEGRITY);
    assert.match(result.err, /getMe on http:\/\/127\.0\.0\.1:\d+ was refused/u);
    assert.match(result.err, /Unauthorized/u);
    assert.match(result.err, /re-copy it from @BotFather/u);
    assert.match(result.err, /nothing was written/u);
    assert.equal(existsSync(home.envPath), false);
    assert.deepEqual(getUpdatesBodies(mock.requests), [], "it polled after a refused token");
  } finally {
    await mock.close();
  }
});

test("setup telegram with no keystore: Ctrl-C mid-token stores nothing", async () => {
  const mock = await startMockBotApi(TOKEN);
  try {
    const home = makeHome();
    const keystore = fakeKeystore("none");
    const prompter = scriptedPrompter(["ABORT"]);
    const result = await run(["telegram", "--as", HUMAN], home, {
      prompter,
      keystore,
      fetch: mockFetch(),
      apiBase: assertLocal(mock.url),
    });

    assert.equal(result.code, EXIT_USAGE);
    assert.match(result.err, /aborted/u);
    assert.match(result.err, /nothing was stored and nothing was written/u);
    assert.equal(existsSync(home.envPath), false);
    assert.deepEqual(keystore.calls, []);
    assert.deepEqual(mock.requests, [], "an aborted token entry still called the Bot API");
  } finally {
    await mock.close();
  }
});

test("setup telegram: the optional proof sends exactly one message when asked", async () => {
  const mock = await startMockBotApi(TOKEN);
  try {
    const home = makeHome();
    mock.queueUpdate(messageUpdate({ chatId: CHAT, username: "carter" }));
    const result = await run(["telegram", "--as", HUMAN], home, {
      prompter: scriptedPrompter(["", true, true]),
      keystore: fakeKeystore("keychain", { prompted: TOKEN }),
      fetch: mockFetch(),
      apiBase: assertLocal(mock.url),
      pollTimeoutSeconds: 1,
    });

    assert.equal(result.code, EXIT_OK, result.err);
    assert.equal(mock.sentTexts().length, 1);
    assert.match(mock.sentTexts()[0] as string, /approval\.md: setup test message/u);
  } finally {
    await mock.close();
  }
});

test("setup telegram: a declined chat writes nothing", async () => {
  const mock = await startMockBotApi(TOKEN);
  try {
    const home = makeHome();
    mock.queueUpdate(messageUpdate({ chatId: CHAT, username: "carter" }));
    const result = await run(["telegram", "--as", HUMAN], home, {
      prompter: scriptedPrompter(["", false]),
      keystore: fakeKeystore("keychain", { prompted: TOKEN }),
      fetch: mockFetch(),
      apiBase: assertLocal(mock.url),
      pollTimeoutSeconds: 1,
    });
    assert.equal(result.code, EXIT_OK, result.err);
    assert.match(result.out, /aborted: nothing was written/u);
    assert.equal(existsSync(home.envPath), false);
  } finally {
    await mock.close();
  }
});

// ===========================================================================
// The whole-run log claim
// ===========================================================================

test("a complete run of all four subcommands leaves the log byte-identical", async () => {
  const mock = await startMockBotApi(TOKEN);
  try {
    const home = makeHome();
    const before = readFileSync(home.logPath);
    const keystore = fakeKeystore("keychain", { prompted: TOKEN });
    mock.queueUpdate(messageUpdate({ chatId: CHAT, username: "carter" }));

    const deps: SetupDeps = {
      keystore,
      fetch: mockFetch(),
      apiBase: assertLocal(mock.url),
      generate: () => GENERATED,
      pollTimeoutSeconds: 1,
    };

    await run(["identity"], home, { ...deps, prompter: scriptedPrompter([HUMAN]) });
    await run(["vault", "--as", HUMAN], home, { ...deps, prompter: scriptedPrompter([]) });
    await run(["sampling", "--as", HUMAN], home, { ...deps, prompter: scriptedPrompter([]) });
    await run(["telegram", "--as", HUMAN], home, {
      ...deps,
      prompter: scriptedPrompter(["", true, false]),
    });

    assert.deepEqual(readFileSync(home.logPath), before);
    // All five lines, one file, every earlier line intact.
    assert.deepEqual(readEnvLines(home), [
      `APPROVAL_HUMAN=${HUMAN}`,
      `APPROVAL_VAULT_PASSPHRASE=keychain:${SERVICE_VAULT_PASSPHRASE}`,
      `APPROVAL_AUDIT_SECRET=keychain:${SERVICE_SAMPLING_SECRET}`,
      `APPROVAL_TG_TOKEN=keychain:${SERVICE_TELEGRAM_TOKEN}`,
      `APPROVAL_TG_CHAT=${CHAT}`,
    ]);
    assert.equal(statSync(home.envPath).mode & 0o777, 0o600);
    // And the policy it read is the policy it left.
    assert.equal(readFileSync(join(home.dir, "APPROVAL.md"), "utf8"), FULL_POLICY);
  } finally {
    await mock.close();
  }
});

test("`approval env --check` reads back exactly what setup wrote", () => {
  const home = homes[homes.length - 1] as string;
  const result = spawnCli(["env", "--check"], home);
  // Every source is a keychain: line, so nothing resolves without a helper —
  // the point here is that the FILE parses and every variable is accounted for.
  assert.match(result.stdout, /APPROVAL_HUMAN/u);
  assert.match(result.stdout, new RegExp(`keychain:${SERVICE_TELEGRAM_TOKEN}`, "u"));
  assert.match(result.stdout, /No value is printed on this path/u);
});
