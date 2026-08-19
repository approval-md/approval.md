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
import { getCredential, listCredentials, vaultPathFor } from "../src/core/vault.js";
import { DEFAULT_CREDENTIAL_NAMES } from "../src/adapters/email.js";
import { probeSmtp, type SmtpTransportOptions } from "../src/adapters/smtp.js";
import { envFileDestination } from "../src/cli/setup-flow.js";
import { EXIT_INTEGRITY, EXIT_IO, EXIT_OK, EXIT_USAGE } from "../src/cli/exit-codes.js";
import { commandSetup } from "../src/cli/setup.js";
import type { ChannelSetupDeps } from "../src/cli/setup-channel.js";
import {
  DEFAULT_SAMPLING_ENV,
  SERVICE_SAMPLING_SECRET,
  SERVICE_TELEGRAM_TOKEN,
  SERVICE_VAULT_PASSPHRASE,
  type KeystoreKind,
  type KeystoreRunner,
  type SetupDeps,
  type StoreOutcome,
} from "../src/cli/setup-common.js";
import type { Prompter, SecretRead } from "../src/cli/prompt.js";
import type { Streams } from "../src/cli/main.js";
import type { TelegramFetch } from "../src/channels/telegram.js";
import { assertLocal, callbackUpdate, messageUpdate, startMockBotApi } from "./telegram-mock.js";
import { assertLoopback, startMockSmtp } from "./smtp-mock.js";

/** dist/tests/cli-setup.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const TOKEN = "7654321:AA-approval-md-setup-fixture-token-DO-NOT-USE";
const GENERATED = "generated-approval-md-setup-3fa91c-DO-NOT-USE";
const HUMAN = "human:carter";
const CHAT = "-1001234567890";

/** The vault passphrase the `setup adapter` cases open their vault with. */
const PASSPHRASE = "passphrase-approval-md-setup-7c02be-DO-NOT-USE";
/** The SMTP credential `setup adapter email` stores. Swept for, with no exemption. */
const SMTP_USER = "you@example.net";
const SMTP_PASSWORD = "smtp-approval-md-setup-fixture-4e11a7-DO-NOT-USE";

/**
 * Every fixture value that must never appear on any path of this verb.
 *
 * The SMTP password is here with NO exemption, which is the point of adding it:
 * `setup adapter email` is the first subcommand that takes a credential the
 * operator holds, types it into this process (the vault has no helper to
 * delegate to), writes it, and then hands it to an SMTP session whose failures
 * quote the server back. Four new places for it to escape, and one assertion
 * over all of them.
 */
const SECRETS = [TOKEN, GENERATED, PASSPHRASE, SMTP_PASSWORD] as const;

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
  deps: ChannelSetupDeps,
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

/**
 * Every subcommand, as the argv that reaches it.
 *
 * `channel telegram` is two words since APRV-79 (SPEC.md §4 gives channels and
 * adapters separate setup nouns), so this list holds arrays rather than names.
 */
const SUBCOMMANDS: ReadonlyArray<readonly string[]> = [
  ["identity"],
  ["vault"],
  ["sampling"],
  ["channel", "telegram"],
];

for (const argv of SUBCOMMANDS) {
  const sub = argv.join(" ");
  test(`setup ${sub} refuses a non-terminal stdin at exit 2 and prints the scripted path`, () => {
    const home = makeHome();
    const before = readFileSync(home.logPath, "utf8");
    const result = spawnCli(["setup", ...argv], home.dir);

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
    const result = spawnCli(["setup", ...argv, "--json"], home.dir);
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

  // The OLD spelling. A sentence rather than "unknown subcommand", and a
  // refusal rather than an alias: SPEC.md §4 gives channels and adapters
  // separate setup nouns, and two spellings would blur the one distinction the
  // rename exists to draw (APRV-79).
  const renamed = spawnCli(["setup", "telegram"], home.dir);
  assert.equal(renamed.code, EXIT_USAGE);
  assert.match(renamed.stderr, /is now `approval setup channel telegram`/u);
  assert.match(renamed.stderr, /there is no alias/u);
  // APRV-91: the distinction is stated in operator language; the section
  // citation for it lives in `approval setup channel --help` and the reference.
  assert.match(renamed.stderr, /a channel surfaces requests/iu);
  assert.doesNotMatch(renamed.stderr, /SPEC\.md §/u);
  // It did not RUN: the refusal is the rename, not the terminal check, and
  // nothing was written.
  assert.doesNotMatch(renamed.stderr, /Nothing was written\./u);
  assert.equal(existsSync(home.envPath), false);

  const help = spawnCli(["setup", "--help"], home.dir);
  assert.equal(help.code, EXIT_OK);
  assert.match(help.stdout, /approval setup — interactive configuration/u);
  assert.match(help.stdout, /REFUSES WHEN STDIN IS NOT A TERMINAL/u);
  assert.match(help.stdout, /never {3}appends to the log/u);

  for (const argv of SUBCOMMANDS) {
    const subHelp = spawnCli(["setup", ...argv, "--help"], home.dir);
    assert.equal(subHelp.code, EXIT_OK, subHelp.stderr);
    assert.match(subHelp.stdout, new RegExp(`approval setup ${argv.join(" ")} —`, "u"));
  }

  const channel = spawnCli(["setup", "channel", "--help"], home.dir);
  assert.equal(channel.code, EXIT_OK, channel.stderr);
  assert.match(channel.stdout, /approval setup channel —/u);
  assert.match(channel.stdout, /Known channels:/u);

  const missingName = spawnCli(["setup", "channel"], home.dir);
  assert.equal(missingName.code, EXIT_USAGE);
  assert.match(missingName.stderr, /missing <name>/u);
  assert.match(missingName.stderr, /known channels: telegram/u);

  const unknownName = spawnCli(["setup", "channel", "slack"], home.dir);
  assert.equal(unknownName.code, EXIT_USAGE);
  assert.match(unknownName.stderr, /unknown channel "slack"/u);
  assert.match(unknownName.stderr, /known channels: telegram/u);
  // A typo is answered with the list, not with a lecture about terminals.
  assert.doesNotMatch(unknownName.stderr, /Nothing was written\./u);
});

test("the root help lists setup and says it is interactive", () => {
  const home = makeHome();
  const help = spawnCli(["--help"], home.dir);
  assert.equal(help.code, EXIT_OK);
  assert.match(
    help.stdout,
    /approval setup {6}identity\|vault\|sampling\|channel <name>\|adapter <name>/u,
  );
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
  // APRV-91: no section citation on an interactive line; the written line
  // is still reported as inert, which is the fact the operator needs.
  assert.match(result.out, /INERT until you evaluate it/u);
  assert.doesNotMatch(result.out, /SPEC\.md §/u);
  assert.match(result.out, /eval "\$\(approval env\)"/u);
});

/**
 * APRV-90 changed what a WRONG ANSWER TO A PROMPT is worth.
 *
 * Until this task, `setup identity` answered `agent:claude` — and `carter` —
 * with exit 2 and the whole help page, which is how a mangled command line is
 * answered. The four cases below are the replacement, and the three assertions
 * they all make are the acceptance criteria: the reason is ONE LINE, no help
 * page is printed on any prompt path, and nothing is written unless an answer
 * was finally accepted.
 */
test("setup identity refuses an agent: actor as a reason, then takes the human: one", async () => {
  const home = makeHome();
  const prompter = scriptedPrompter(["agent:claude", HUMAN]);
  const result = await run(["identity"], home, { prompter, keystore: fakeKeystore("keychain") });

  // It did NOT exit: the same question came back under one line of reason.
  assert.equal(result.code, EXIT_OK, result.err);
  assert.match(result.out, /is not a human identity/u);
  assert.match(result.out, /\^human:\.\+/u);
  assert.equal(result.err, "");
  assert.deepEqual(prompter.remaining, []);
  assert.deepEqual(prompter.asked, [
    "human identity (human:<id>, or just <id>): ",
    "human identity (human:<id>, or just <id>): ",
  ]);
  assert.deepEqual(readEnvLines(home), [`APPROVAL_HUMAN=${HUMAN}`]);
  // The reason is one line, and the help page is not under it.
  assert.doesNotMatch(result.out, /Usage:\n {2}approval setup identity/u);
});

test("setup identity accepts a bare id and normalises it to human:<id>", async () => {
  const home = makeHome();
  // Exactly what the human typed on 2026-08-18 that cost them forty lines.
  const prompter = scriptedPrompter(["carter"]);
  const result = await run(["identity"], home, { prompter, keystore: fakeKeystore("keychain") });

  assert.equal(result.code, EXIT_OK, result.err);
  assert.deepEqual(readEnvLines(home), ["APPROVAL_HUMAN=human:carter"]);
  // The prefix is still PRINTED — it is what distinguishes the actor kinds —
  // and it simply need not be retyped.
  assert.match(prompter.asked[0] ?? "", /human:<id>/u);
  assert.equal(result.err, "");
});

test("setup identity gives up after the attempt bound, in one line and with no help", async () => {
  const home = makeHome();
  const prompter = scriptedPrompter(["agent:a", "system:b", "", "agent:c", "system:d"]);
  const result = await run(["identity"], home, { prompter, keystore: fakeKeystore("keychain") });

  assert.equal(result.code, EXIT_USAGE);
  assert.deepEqual(prompter.remaining, [], "the bound is not 5 answers");
  assert.match(result.err, /no human identity after 5 attempts; nothing was written/u);
  // ONE line on stderr, and none of it is a help page.
  assert.equal(result.err.split("\n").filter((line) => line.length > 0).length, 1);
  assert.doesNotMatch(result.err, /Usage:/u);
  assert.doesNotMatch(result.err, /EXIT CODES|Exit codes/u);
  assert.equal(existsSync(home.envPath), false);
});

test("setup identity: Ctrl-D mid-reprompt stores nothing and prints no help", async () => {
  const home = makeHome();
  // A wrong answer, the reason, and then the human walks away.
  const prompter = scriptedPrompter(["agent:claude", null]);
  const result = await run(["identity"], home, { prompter, keystore: fakeKeystore("keychain") });

  assert.equal(result.code, EXIT_USAGE);
  assert.match(result.err, /no identity was entered; nothing was written/u);
  assert.doesNotMatch(result.err, /Usage:/u);
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

test("setup channel telegram: token, getMe, chat discovery, both lines — and no offset, ever", async () => {
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
      // No Enter: since APRV-96 the verb long-polls until the message lands.
      true, // use chat <id>?
      false, // send a test message? — default no, and taken
    ]);
    const result = await run(["channel", "telegram", "--as", HUMAN], home, {
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
        "a getUpdates from `approval setup channel telegram` carried an offset. An offset is an ACKNOWLEDGEMENT: it tells the Bot API everything below it may be discarded, and a running listener's callback_query would never arrive.",
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

test("setup channel telegram: several candidates are numbered and picked", async () => {
  const mock = await startMockBotApi(TOKEN);
  try {
    const home = makeHome();
    mock.queueUpdate(messageUpdate({ chatId: "111", username: "carter" }));
    mock.queueUpdate(messageUpdate({ chatId: "222", type: "group", title: "Ops" }));
    mock.queueUpdate(messageUpdate({ chatId: "333", firstName: "Nameless" }));

    const prompter = scriptedPrompter(["2", false]);
    const result = await run(["channel", "telegram", "--as", HUMAN], home, {
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

test("setup channel telegram: zero candidates exits 1 with the manual curl, and writes nothing", async () => {
  const mock = await startMockBotApi(TOKEN);
  try {
    const home = makeHome();
    // Nothing is asked while it waits: the script is empty, and an unscripted
    // question is an error in this prompter, so "no Enter is required" is an
    // assertion here rather than a claim.
    const prompter = scriptedPrompter([]);
    const result = await run(["channel", "telegram", "--as", HUMAN], home, {
      prompter,
      keystore: fakeKeystore("keychain", { prompted: TOKEN }),
      fetch: mockFetch(),
      apiBase: assertLocal(mock.url),
      pollTimeoutSeconds: 0,
      discoveryDeadlineMs: 150,
    });

    assert.equal(result.code, EXIT_INTEGRITY, result.out);
    assert.match(result.err, /no message reached/u);
    assert.match(result.err, /curl -s/u);
    assert.match(result.err, /getUpdates/u);
    assert.match(result.err, /privacy mode/u);
    // The curl carries a PLACEHOLDER, never the token it is holding.
    assert.match(result.err, /bot<token>/u);
    assert.equal(existsSync(home.envPath), false);
    assert.ok(
      getUpdatesBodies(mock.requests).length >= 1,
      "it gave up without reading the update queue even once",
    );
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------------------
// APRV-96: the wait, and what the give-up says
// ---------------------------------------------------------------------------

/**
 * The observation this group exists for (2026-08-18, running
 * `examples/email-demo.md`): the operator sent the bot a message, pressed
 * Enter, and got "No message seen yet" — with no way to tell whether the
 * message went to a different bot, arrived after the 10s long poll had
 * expired, or had been consumed by another poller with an offset. A later curl
 * of `getWebhookInfo` showed `pending_update_count: 1`.
 */
test("setup channel telegram: a message already waiting is found on the first poll, with no Enter", async () => {
  const mock = await startMockBotApi(TOKEN);
  try {
    const home = makeHome();
    mock.queueUpdate(messageUpdate({ chatId: CHAT, username: "carter" }));

    const prompter = scriptedPrompter([true, false]);
    const result = await run(["channel", "telegram", "--as", HUMAN], home, {
      prompter,
      keystore: fakeKeystore("keychain", { prompted: TOKEN }),
      fetch: mockFetch(),
      apiBase: assertLocal(mock.url),
      pollTimeoutSeconds: 1,
      discoveryDeadlineMs: 5_000,
    });

    assert.equal(result.code, EXIT_OK, result.err);
    assert.equal(getUpdatesBodies(mock.requests).length, 1, "one poll should have sufficed");
    assert.match(result.out, /waiting for a message to @approval_md_test_bot \(up to 5s, Ctrl-C to stop\)/u);
    assert.match(result.out, /No Enter is needed/u);
    assert.ok(readEnvLines(home).includes(`APPROVAL_TG_CHAT=${CHAT}`));
    assert.deepEqual(prompter.remaining, []);
  } finally {
    await mock.close();
  }
});

test("setup channel telegram: a message sent AFTER the first poll came back empty is still found", async () => {
  const mock = await startMockBotApi(TOKEN);
  try {
    const home = makeHome();
    // The field case, exactly: the human is slow. The update is queued only
    // once the verb has already polled and found nothing, so the run can only
    // succeed by polling again on its own — which is the whole change.
    const timer = setTimeout(() => {
      mock.queueUpdate(messageUpdate({ chatId: CHAT, username: "carter" }));
    }, 120);

    const prompter = scriptedPrompter([true, false]);
    const result = await run(["channel", "telegram", "--as", HUMAN], home, {
      prompter,
      keystore: fakeKeystore("keychain", { prompted: TOKEN }),
      fetch: mockFetch(),
      apiBase: assertLocal(mock.url),
      // A poll far shorter than the wait, so the first read expires empty.
      pollTimeoutSeconds: 0,
      discoveryDeadlineMs: 10_000,
    });
    clearTimeout(timer);

    assert.equal(result.code, EXIT_OK, result.err);
    assert.ok(readEnvLines(home).includes(`APPROVAL_TG_CHAT=${CHAT}`));
    const polls = getUpdatesBodies(mock.requests);
    assert.ok(polls.length > 1, "it polled once and gave up on the human's timing");
    for (const body of polls) {
      assert.equal(Object.hasOwn(body, "offset"), false, "a re-poll carried an offset");
      assert.deepEqual(body["allowed_updates"], ["message"]);
    }
    // Not one question while it waited: only the two after a chat was found.
    assert.equal(
      prompter.asked.some((question) => /Enter/u.test(question)),
      false,
      "the wait asked the operator to press Enter",
    );
  } finally {
    await mock.close();
  }
});

test("setup channel telegram: the deadline report names the bot, the pending count, and the webhook", async () => {
  const mock = await startMockBotApi(TOKEN);
  try {
    const home = makeHome();
    // What curl showed in the field: one update Telegram is holding that no
    // poller has consumed. `allowed_updates` keeps this callback out of the
    // verb's own reads, so it can only learn the count from getWebhookInfo.
    mock.queueUpdate(callbackUpdate({ data: "g:nonce:task-1:act", chatId: CHAT }));

    const result = await run(["channel", "telegram", "--as", HUMAN], home, {
      prompter: scriptedPrompter([]),
      keystore: fakeKeystore("keychain", { prompted: TOKEN }),
      fetch: mockFetch(),
      apiBase: assertLocal(mock.url),
      pollTimeoutSeconds: 0,
      discoveryDeadlineMs: 150,
    });

    assert.equal(result.code, EXIT_INTEGRITY, result.out);
    assert.match(result.err, /no message reached @approval_md_test_bot in 1s/u);
    assert.match(result.err, /did you message @approval_md_test_bot\?/u);
    assert.match(result.err, /Telegram holds 1 update\(s\) for this bot that no poller has consumed/u);
    assert.match(result.err, /stop `approval channel telegram listen`/u);
    assert.match(result.err, /no webhook is registered/u);
    // It asked, and it asked without acknowledging anything.
    assert.equal(
      mock.requests.filter((entry) => entry.method === "getWebhookInfo").length,
      1,
    );
    assert.equal(mock.pendingUpdateCount(), 1, "the diagnosis consumed the listener's callback");
    assert.equal(existsSync(home.envPath), false);
  } finally {
    await mock.close();
  }
});

test("setup channel telegram: a registered webhook is named as the reason nothing arrives", async () => {
  const mock = await startMockBotApi(TOKEN);
  try {
    const home = makeHome();
    mock.setWebhookInfo({ url: "https://hooks.example.test/tg", pendingUpdateCount: 0 });

    const result = await run(["channel", "telegram", "--as", HUMAN], home, {
      prompter: scriptedPrompter([]),
      keystore: fakeKeystore("keychain", { prompted: TOKEN }),
      fetch: mockFetch(),
      apiBase: assertLocal(mock.url),
      pollTimeoutSeconds: 0,
      discoveryDeadlineMs: 150,
    });

    assert.equal(result.code, EXIT_INTEGRITY, result.out);
    assert.match(result.err, /a webhook is registered at https:\/\/hooks\.example\.test\/tg/u);
    assert.match(result.err, /getUpdates returns nothing while a webhook is set/u);
    assert.match(result.err, /deleteWebhook/u);
    // Zero pending is its own diagnosis: something else acknowledged them.
    assert.match(result.err, /Telegram holds no pending updates for this bot/u);
    assert.equal(existsSync(home.envPath), false);
  } finally {
    await mock.close();
  }
});

test("setup channel telegram: a refused getMe stops before the chat questions", async () => {
  const mock = await startMockBotApi("a-different-token-entirely");
  try {
    const home = makeHome();
    // The keystore hands back OUR token; the mock only answers for its own, so
    // the path is unauthorised — the 401-shaped refusal the real API gives.
    const prompter = scriptedPrompter([]);
    const result = await run(["channel", "telegram", "--as", HUMAN], home, {
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

test("setup channel telegram with no keystore: Ctrl-C mid-token stores nothing", async () => {
  const mock = await startMockBotApi(TOKEN);
  try {
    const home = makeHome();
    const keystore = fakeKeystore("none");
    const prompter = scriptedPrompter(["ABORT"]);
    const result = await run(["channel", "telegram", "--as", HUMAN], home, {
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

test("setup channel telegram: the optional proof sends exactly one message when asked", async () => {
  const mock = await startMockBotApi(TOKEN);
  try {
    const home = makeHome();
    mock.queueUpdate(messageUpdate({ chatId: CHAT, username: "carter" }));
    const result = await run(["channel", "telegram", "--as", HUMAN], home, {
      prompter: scriptedPrompter([true, true]),
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

test("setup channel telegram: a declined chat writes nothing", async () => {
  const mock = await startMockBotApi(TOKEN);
  try {
    const home = makeHome();
    mock.queueUpdate(messageUpdate({ chatId: CHAT, username: "carter" }));
    const result = await run(["channel", "telegram", "--as", HUMAN], home, {
      prompter: scriptedPrompter([false]),
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

test("setup channel telegram is human-only, and an agent: actor never reaches the bot", async () => {
  const mock = await startMockBotApi(TOKEN);
  try {
    const home = makeHome();
    const keystore = fakeKeystore("keychain", { prompted: TOKEN });
    const result = await run(["channel", "telegram", "--as", "agent:bot"], home, {
      prompter: scriptedPrompter([]),
      keystore,
      fetch: mockFetch(),
      apiBase: assertLocal(mock.url),
    });

    // NEW in APRV-79. The help had claimed HUMAN-ONLY since APRV-74 and
    // nothing enforced it: this verb stores a credential and writes
    // .approval/env, which is what `vault` and `sampling` are gated for.
    assert.equal(result.code, EXIT_USAGE);
    assert.match(result.err, /human-only/u);
    assert.match(result.err, /approval setup channel telegram/u);
    assert.equal(existsSync(home.envPath), false);
    assert.deepEqual(keystore.calls, [], "a refused actor still reached the keystore");
    assert.deepEqual(mock.requests, [], "a refused actor still reached the Bot API");
  } finally {
    await mock.close();
  }
});

test("setup channel telegram with no human identity at all refuses too", async () => {
  const home = makeHome();
  const result = await run(["channel", "telegram"], home, {
    prompter: scriptedPrompter([]),
    keystore: fakeKeystore("keychain", { prompted: TOKEN }),
  });
  assert.equal(result.code, EXIT_USAGE);
  assert.match(result.err, /no human identity/u);
  assert.match(result.err, /setup identity/u);
  assert.equal(existsSync(home.envPath), false);
});

// ===========================================================================
// One conversation, two verbs (APRV-79)
// ===========================================================================

/**
 * The claim the shared flow exists to make: `setup channel telegram` and
 * `setup adapter email` are the SAME conversation over different manifests.
 *
 * Asserted as three shapes rather than as byte equality, because the values
 * legitimately differ (two names into `.approval/env`, five into the vault) and
 * the point is that an operator who has run one recognises the other: the
 * checklist header, the replace question, and the closing report.
 */
test("setup channel telegram and setup adapter email print the same conversation", async () => {
  const mock = await startMockBotApi(TOKEN);
  try {
    // Both run twice: the first pass fills the store, the second is the one
    // that has something to replace, which is where the shared plan speaks.
    const tgHome = makeHome();
    const tgDeps: SetupDeps = {
      keystore: fakeKeystore("keychain", { prompted: TOKEN }),
      fetch: mockFetch(),
      apiBase: assertLocal(mock.url),
      pollTimeoutSeconds: 1,
    };
    mock.queueUpdate(messageUpdate({ chatId: CHAT, username: "carter" }));
    const telegram = await run(["channel", "telegram", "--as", HUMAN], tgHome, {
      ...tgDeps,
      prompter: scriptedPrompter([true, false]),
    });
    assert.equal(telegram.code, EXIT_OK, telegram.err);
    // Replace the token, leave the chat alone: the partial re-run is where the
    // shared plan's "left alone" report speaks, in both verbs.
    const telegramAgain = await run(["channel", "telegram", "--as", HUMAN], tgHome, {
      ...tgDeps,
      prompter: scriptedPrompter([true, false]),
    });
    assert.equal(telegramAgain.code, EXIT_OK, telegramAgain.err);

    const mailHome = makeHome();
    const mailDeps: SetupDeps = {
      keystore: fakeKeystore("keychain"),
      env: { APPROVAL_VAULT_PASSPHRASE: PASSPHRASE },
    };
    const email = await run(["adapter", "email", "--as", HUMAN], mailHome, {
      ...mailDeps,
      prompter: scriptedPrompter(["127.0.0.1", "587", "", SMTP_USER, SMTP_PASSWORD, false]),
    });
    assert.equal(email.code, EXIT_OK, email.err);
    const emailAgain = await run(["adapter", "email", "--as", HUMAN], mailHome, {
      ...mailDeps,
      prompter: scriptedPrompter([
        true,
        false,
        false,
        false,
        false,
        "127.0.0.2",
        "n", // the partial re-run's probe offer (APRV-99)
      ]),
    });
    assert.equal(emailAgain.code, EXIT_OK, emailAgain.err);

    // (1) The checklist header: the count, and where every value lands.
    const CHECKLIST = /It will ask for \d+ value\(s\), all of them into \S+:\n/u;
    assert.match(telegram.out, CHECKLIST);
    assert.match(email.out, CHECKLIST);

    // (2) The replace question, asked before any work, printing no old value.
    assert.match(telegramAgain.out, /already has a line in \S+ \(its value is not printed here\)/u);
    assert.match(emailAgain.out, /is already in \S+ \(its value is not printed here\)/u);

    // (3) The closing report: how many, where, and which names.
    const REPORT = /\nstored \d+ value\(s\) in \S+: \S+/u;
    assert.match(telegram.out, REPORT);
    assert.match(email.out, REPORT);
    assert.match(telegramAgain.out, /left alone in \S+: /u);
    assert.match(emailAgain.out, /left alone in \S+: /u);
  } finally {
    await mock.close();
  }
});

// ===========================================================================
// The whole-run log claim
// ===========================================================================

/** The home the whole-run walk left behind, for the `env --check` case. */
let fullWalkHome = "";

test("a complete run of all five subcommands leaves the log byte-identical", async () => {
  const mock = await startMockBotApi(TOKEN);
  try {
    const home = makeHome();
    fullWalkHome = home.dir;
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
    await run(["channel", "telegram", "--as", HUMAN], home, {
      ...deps,
      prompter: scriptedPrompter([true, false]),
    });
    // The fifth, and the only one whose values go somewhere else: an adapter's
    // credentials land in the VAULT and add no line to .approval/env at all
    // (SPEC.md §4, §10.4). The env file below is the proof of that division.
    await run(["adapter", "email", "--as", HUMAN], home, {
      ...deps,
      env: { APPROVAL_VAULT_PASSPHRASE: PASSPHRASE },
      prompter: scriptedPrompter([
        "127.0.0.1",
        "587",
        "",
        SMTP_USER,
        SMTP_PASSWORD,
        false, // probe it? — declined; the vault is what this case is about
      ]),
    });

    assert.deepEqual(readFileSync(home.logPath), before);
    // Five lines, one file, every earlier line intact — and not one of them
    // from the adapter.
    assert.deepEqual(readEnvLines(home), [
      `APPROVAL_HUMAN=${HUMAN}`,
      `APPROVAL_VAULT_PASSPHRASE=keychain:${SERVICE_VAULT_PASSPHRASE}`,
      `APPROVAL_AUDIT_SECRET=keychain:${SERVICE_SAMPLING_SECRET}`,
      `APPROVAL_TG_TOKEN=keychain:${SERVICE_TELEGRAM_TOKEN}`,
      `APPROVAL_TG_CHAT=${CHAT}`,
    ]);
    assert.deepEqual(vaultNames(home), Object.values(DEFAULT_CREDENTIAL_NAMES).sort());
    assert.equal(statSync(home.envPath).mode & 0o777, 0o600);
    // And the policy it read is the policy it left.
    assert.equal(readFileSync(join(home.dir, "APPROVAL.md"), "utf8"), FULL_POLICY);
  } finally {
    await mock.close();
  }
});

// ===========================================================================
// setup adapter <name> (APRV-78)
// ===========================================================================

/** The env a `setup adapter` case runs under: the passphrase and nothing else. */
const WITH_PASSPHRASE: NodeJS.ProcessEnv = { APPROVAL_VAULT_PASSPHRASE: PASSPHRASE };

/**
 * The probe seam, pointed at a mock and told to accept its self-signed cert.
 *
 * **The only TLS relaxation in this suite, and it is inside the test.** The
 * runtime always asks for `tlsRejectUnauthorized: true`; this wrapper overrides
 * it on the way to the mock on 127.0.0.1, so no production path can acquire the
 * relaxation and no test can reach a real server.
 */
function loopbackProbe(): typeof probeSmtp {
  return async (options: SmtpTransportOptions) => {
    assertLoopback(options.host);
    assert.equal(
      options.tlsRejectUnauthorized,
      true,
      "the runtime asked for a relaxed TLS check; only this wrapper may relax it",
    );
    return probeSmtp({ ...options, tlsRejectUnauthorized: false });
  };
}

/** The names in the vault, read with the fixture passphrase. */
function vaultNames(home: Home): string[] {
  const listed = listCredentials(vaultPathFor(home.logPath), PASSPHRASE);
  assert.equal(listed.ok, true, listed.ok ? "" : listed.message);
  return listed.ok ? listed.names : [];
}

/** One credential's value. Read IN-TEST only; never pushed to the transcript. */
function vaultValue(home: Home, name: string): string {
  const got = getCredential(vaultPathFor(home.logPath), PASSPHRASE, name);
  assert.equal(got.ok, true, got.ok ? "" : got.message);
  return got.ok ? got.value : "";
}

test("setup adapter email refuses a non-terminal stdin with the manifest's own commands", () => {
  const home = makeHome();
  const result = spawnCli(["setup", "adapter", "email"], home.dir);

  assert.equal(result.code, EXIT_USAGE, result.stderr);
  assert.match(result.stderr, /stdin is not a terminal/u);
  assert.match(result.stderr, /Nothing was written/u);
  // The hint is GENERATED from the manifest, so it names the resolved
  // passphrase variable, the eval that establishes it, and one `vault set` per
  // credential the adapter actually reads.
  assert.match(result.stderr, /APPROVAL_VAULT_PASSPHRASE/u);
  assert.match(result.stderr, /eval "\$\(approval env\)"/u);
  for (const name of Object.values(DEFAULT_CREDENTIAL_NAMES)) {
    assert.match(result.stderr, new RegExp(`approval vault set ${name.replace(".", "\\.")} `, "u"));
  }
  // And the secret's line still takes its value from the keystore's own reader,
  // so no printed command carries a credential in an argument.
  assert.match(result.stderr, /find-generic-password|secret-tool lookup/u);
  assert.doesNotMatch(result.stderr, /-w \S/u);
  assert.equal(existsSync(home.envPath), false);
  assert.equal(existsSync(vaultPathFor(home.logPath)), false, "a refusal created a vault");
});

test("setup adapter email refuses --json, answers --help, and names the adapters it knows", () => {
  const home = makeHome();

  const json = spawnCli(["setup", "adapter", "email", "--json"], home.dir);
  assert.equal(json.code, EXIT_USAGE, json.stderr);
  assert.match(json.stderr, /--json was given/u);

  const help = spawnCli(["setup", "adapter", "email", "--help"], home.dir);
  assert.equal(help.code, EXIT_OK, help.stderr);
  assert.match(help.stdout, /approval setup adapter email —/u);
  assert.match(help.stdout, /THE PROBE SENDS NOTHING/u);
  assert.match(help.stdout, /approval vault remove smtp\.password/u);

  const bare = spawnCli(["setup", "adapter", "--help"], home.dir);
  assert.equal(bare.code, EXIT_OK, bare.stderr);
  assert.match(bare.stdout, /approval setup adapter —/u);

  const missing = spawnCli(["setup", "adapter"], home.dir);
  assert.equal(missing.code, EXIT_USAGE);
  assert.match(missing.stderr, /missing <name>/u);
  assert.match(missing.stderr, /known adapters: email/u);

  const unknown = spawnCli(["setup", "adapter", "gcal"], home.dir);
  assert.equal(unknown.code, EXIT_USAGE);
  assert.match(unknown.stderr, /unknown adapter "gcal"/u);
  assert.match(unknown.stderr, /known adapters: email/u);
  // A typo is answered with the list, not with a lecture about terminals.
  assert.doesNotMatch(unknown.stderr, /stdin is not a terminal/u);
});

test("setup adapter email with the passphrase unset stores nothing, and diagnoses which repair", async () => {
  // No vault, no line for the variable: nobody has ever established one.
  const fresh = makeHome();
  const untouched = await run(["adapter", "email", "--as", HUMAN], fresh, {
    prompter: scriptedPrompter([]),
    keystore: fakeKeystore("keychain"),
    env: {},
  });
  assert.equal(untouched.code, EXIT_USAGE);
  assert.match(untouched.err, /APPROVAL_VAULT_PASSPHRASE is unset or empty/u);
  assert.match(untouched.err, /Nobody has established a vault passphrase here/u);
  assert.match(untouched.err, /approval setup vault --as human:<id>/u);
  assert.equal(existsSync(vaultPathFor(fresh.logPath)), false, "a refusal created a vault");

  // A line for the variable exists: the passphrase is recorded, this shell just
  // has not evaluated it, so the repair is one command and not two.
  const recorded = makeHome({ env: `APPROVAL_VAULT_PASSPHRASE=keychain:approval-vault-passphrase\n` });
  const unevaluated = await run(["adapter", "email", "--as", HUMAN], recorded, {
    prompter: scriptedPrompter([]),
    keystore: fakeKeystore("keychain"),
    env: {},
  });
  assert.equal(unevaluated.code, EXIT_USAGE);
  assert.match(unevaluated.err, /The passphrase is recorded but not in this shell/u);
  assert.doesNotMatch(unevaluated.err, /Nobody has established/u);
  assert.match(unevaluated.err, /eval "\$\(approval env\)"/u);
});

test("setup adapter email is human-only", async () => {
  const home = makeHome();
  const result = await run(["adapter", "email", "--as", "agent:claude"], home, {
    prompter: scriptedPrompter([]),
    keystore: fakeKeystore("keychain"),
    env: WITH_PASSPHRASE,
  });
  assert.equal(result.code, EXIT_USAGE);
  assert.match(result.err, /human-only/u);
  assert.equal(existsSync(vaultPathFor(home.logPath)), false);
});

test("setup adapter email fills the vault, touches nothing else, and prints no value", async () => {
  const home = makeHome();
  const prompter = scriptedPrompter([
    "127.0.0.1", // smtp.host
    "587", // smtp.port
    "", // smtp.security — Enter takes the default, starttls
    SMTP_USER, // smtp.user
    SMTP_PASSWORD, // smtp.password, through readSecret
    false, // probe it? — offered, declined here
  ]);
  const result = await run(["adapter", "email", "--as", HUMAN], home, {
    prompter,
    keystore: fakeKeystore("keychain"),
    env: WITH_PASSPHRASE,
  });

  assert.equal(result.code, EXIT_OK, result.err);
  assert.deepEqual(prompter.remaining, []);

  // Every name the adapter reads, and only those.
  assert.deepEqual(vaultNames(home), Object.values(DEFAULT_CREDENTIAL_NAMES).sort());
  assert.equal(vaultValue(home, DEFAULT_CREDENTIAL_NAMES.host), "127.0.0.1");
  assert.equal(vaultValue(home, DEFAULT_CREDENTIAL_NAMES.port), "587");
  assert.equal(vaultValue(home, DEFAULT_CREDENTIAL_NAMES.security), "starttls");
  assert.equal(vaultValue(home, DEFAULT_CREDENTIAL_NAMES.user), SMTP_USER);
  assert.equal(vaultValue(home, DEFAULT_CREDENTIAL_NAMES.password), SMTP_PASSWORD);

  // The checklist came before the first question, and the report names the
  // names. The suite-wide sweep is the real assertion about values.
  assert.match(result.out, /smtp\.password \(secret, optional\)/u);
  assert.match(result.out, /stored 5 value\(s\)/u);
  assert.match(result.out, /stored and unverified/u);
  assert.equal(result.out.includes(SMTP_PASSWORD), false);
  assert.equal(result.out.includes(PASSPHRASE), false);

  // Adapter credentials go to the VAULT and nowhere else: no env line was
  // written, and the file was never created.
  assert.equal(existsSync(home.envPath), false, "setup adapter wrote .approval/env");
});

test("setup adapter email reports the secret's length, and offers to strip a Google app password's display spaces (APRV-97)", async () => {
  const spaced = "abcd efgh ijkl mnop";
  // Accepted: the 16 letters are stored.
  {
    const home = makeHome();
    const prompter = scriptedPrompter(["127.0.0.1", "587", "", SMTP_USER, spaced, true, false]);
    const result = await run(["adapter", "email", "--as", HUMAN], home, {
      prompter,
      keystore: fakeKeystore("keychain"),
      env: WITH_PASSPHRASE,
    });
    assert.equal(result.code, EXIT_OK, result.err);
    assert.deepEqual(prompter.remaining, []);
    assert.match(result.out, /received 19 character\(s\)/u);
    assert.match(prompter.asked[5] ?? "", /Google app password .* display spaces/u);
    assert.match(result.out, /storing 16 character\(s\)/u);
    assert.equal(vaultValue(home, DEFAULT_CREDENTIAL_NAMES.password), "abcdefghijklmnop");
    assert.equal(result.out.includes("abcd"), false, "a fragment of the secret was printed");
  }
  // Declined: stored exactly as typed. A password may genuinely contain spaces.
  {
    const home = makeHome();
    const prompter = scriptedPrompter(["127.0.0.1", "587", "", SMTP_USER, spaced, false, false]);
    const result = await run(["adapter", "email", "--as", HUMAN], home, {
      prompter,
      keystore: fakeKeystore("keychain"),
      env: WITH_PASSPHRASE,
    });
    assert.equal(result.code, EXIT_OK, result.err);
    assert.equal(vaultValue(home, DEFAULT_CREDENTIAL_NAMES.password), spaced);
    assert.equal(result.out.includes("storing 16"), false);
  }
  // Not the shape: no offer, one fewer question. The count still prints.
  {
    const home = makeHome();
    const prompter = scriptedPrompter(["127.0.0.1", "587", "", SMTP_USER, "pass word 1", false]);
    const result = await run(["adapter", "email", "--as", HUMAN], home, {
      prompter,
      keystore: fakeKeystore("keychain"),
      env: WITH_PASSPHRASE,
    });
    assert.equal(result.code, EXIT_OK, result.err);
    assert.deepEqual(prompter.remaining, []);
    assert.match(result.out, /received 11 character\(s\)/u);
    assert.equal(vaultValue(home, DEFAULT_CREDENTIAL_NAMES.password), "pass word 1");
  }
});

/**
 * APRV-90: these two used to assert exit 2 on a mistyped port and a `9` at a
 * 1-3 choice. Both sentences survive verbatim — they are the adapter's own
 * refusals, and the point of printing them at collection time was always that
 * the operator hears at setup exactly what they would hear at send time — but
 * they are now REASONS on stdout with the question underneath, not exit codes.
 */
test("setup adapter email asks again for a port that is not a port, in the adapter's own words", async () => {
  const home = makeHome();
  const prompter = scriptedPrompter([
    "127.0.0.1",
    "1e6", // not a port: one line, and the same question
    "587",
    "",
    SMTP_USER,
    SMTP_PASSWORD,
    false,
  ]);
  const result = await run(["adapter", "email", "--as", HUMAN], home, {
    prompter,
    keystore: fakeKeystore("keychain"),
    env: WITH_PASSPHRASE,
  });
  assert.equal(result.code, EXIT_OK, result.err);
  assert.deepEqual(prompter.remaining, []);
  // The SAME sentence `approval adapter email` would print at send time.
  assert.match(result.out, /the vault's smtp\.port is not a TCP port number \(1-65535\)/u);
  assert.equal(prompter.asked.filter((question) => /SMTP port/u.test(question)).length, 2);
  assert.equal(vaultValue(home, DEFAULT_CREDENTIAL_NAMES.port), "587");
  assert.doesNotMatch(result.err, /Usage:/u);
});

test("setup adapter email asks again for a security setting outside the closed set", async () => {
  const home = makeHome();
  const prompter = scriptedPrompter([
    "127.0.0.1",
    "587",
    "9", // not one of 1-3
    "2", // starttls
    SMTP_USER,
    SMTP_PASSWORD,
    false,
  ]);
  const result = await run(["adapter", "email", "--as", HUMAN], home, {
    prompter,
    keystore: fakeKeystore("keychain"),
    env: WITH_PASSPHRASE,
  });
  assert.equal(result.code, EXIT_OK, result.err);
  assert.deepEqual(prompter.remaining, []);
  assert.match(result.out, /"9" is not one of 1-3/u);
  // The options are printed ONCE; only the question repeats.
  assert.equal(result.out.split("2. starttls").length - 1, 1);
  assert.equal(vaultValue(home, DEFAULT_CREDENTIAL_NAMES.security), "starttls");
});

test("setup adapter email gives up on a config prompt after the attempt bound, at exit 2 with no help", async () => {
  const home = makeHome();
  const prompter = scriptedPrompter(["127.0.0.1", "1e6", "0", "65536", "-1", "http://x"]);
  const result = await run(["adapter", "email", "--as", HUMAN], home, {
    prompter,
    keystore: fakeKeystore("keychain"),
    env: WITH_PASSPHRASE,
  });
  assert.equal(result.code, EXIT_USAGE);
  assert.deepEqual(prompter.remaining, []);
  assert.match(result.err, /smtp\.port: no valid value after 5 attempts/u);
  assert.match(result.err, /nothing was written/u);
  assert.doesNotMatch(result.err, /Usage:/u);
  assert.equal(existsSync(vaultPathFor(home.logPath)), false, "a refused value created a vault");
});

test("setup adapter email: Ctrl-D at a config prompt stores nothing", async () => {
  const home = makeHome();
  const result = await run(["adapter", "email", "--as", HUMAN], home, {
    prompter: scriptedPrompter(["127.0.0.1", "1e6", null]),
    keystore: fakeKeystore("keychain"),
    env: WITH_PASSPHRASE,
  });
  assert.equal(result.code, EXIT_USAGE);
  assert.match(result.err, /the entry for smtp\.port was aborted/u);
  assert.doesNotMatch(result.err, /Usage:/u);
  assert.equal(existsSync(vaultPathFor(home.logPath)), false);
});

test("setup adapter email refuses a username with no password, before anything is stored", async () => {
  const home = makeHome();
  const result = await run(["adapter", "email", "--as", HUMAN], home, {
    prompter: scriptedPrompter([
      "127.0.0.1",
      "587",
      "",
      SMTP_USER,
      "", // no password: half a credential
    ]),
    keystore: fakeKeystore("keychain"),
    env: WITH_PASSPHRASE,
  });
  assert.equal(result.code, EXIT_USAGE);
  assert.match(
    result.err,
    /the vault holds smtp\.user but not smtp\.password\. An SMTP login needs both/u,
  );
  // BEFORE anything is stored: the check runs between collection and the writes.
  assert.equal(existsSync(vaultPathFor(home.logPath)), false, "a half credential created a vault");
});

test("a re-run asks before replacing each name, and a no leaves the vault byte-identical", async () => {
  const home = makeHome();
  await run(["adapter", "email", "--as", HUMAN], home, {
    prompter: scriptedPrompter(["127.0.0.1", "587", "", SMTP_USER, SMTP_PASSWORD, false]),
    keystore: fakeKeystore("keychain"),
    env: WITH_PASSPHRASE,
  });
  const before = readFileSync(vaultPathFor(home.logPath));

  // Five names present, five confirmations, all declined — and no question is
  // asked for a VALUE, because a name nobody agreed to replace is never asked
  // about.
  const prompter = scriptedPrompter([false, false, false, false, false]);
  const again = await run(["adapter", "email", "--as", HUMAN], home, {
    prompter,
    keystore: fakeKeystore("keychain"),
    env: WITH_PASSPHRASE,
  });

  assert.equal(again.code, EXIT_OK, again.err);
  assert.deepEqual(prompter.remaining, []);
  assert.match(again.out, /smtp\.host is already in .*vault\.enc \(its value is not printed here\)/u);
  assert.match(again.out, /left alone in .*vault\.enc: smtp\.host, smtp\.port/u);
  assert.match(again.out, /nothing to do: every name is already in/u);
  assert.deepEqual(readFileSync(vaultPathFor(home.logPath)), before, "a declined re-run rewrote the vault");
});

test("setup adapter email: the probe proves the session, sends nothing, and reports the mechanism", async () => {
  const smtp = await startMockSmtp({ tls: "none", user: SMTP_USER, password: SMTP_PASSWORD });
  try {
    const home = makeHome();
    const result = await run(["adapter", "email", "--as", HUMAN], home, {
      prompter: scriptedPrompter([
        assertLoopback(smtp.host),
        String(smtp.port),
        "", // starttls
        SMTP_USER,
        SMTP_PASSWORD,
        true, // probe it
      ]),
      keystore: fakeKeystore("keychain"),
      env: WITH_PASSPHRASE,
      probe: loopbackProbe(),
    });

    assert.equal(result.code, EXIT_OK, result.err);
    assert.match(result.out, /verified: 127\.0\.0\.1:\d+ answered over starttls/u);
    assert.match(result.out, /AUTH PLAIN/u);
    assert.match(result.out, /No message was sent/u);
    assert.equal(smtp.connections, 1);
    // The proof is a session that never names a message: no MAIL, no RCPT, no
    // DATA reached the server.
    const commands = smtp.last()?.commands ?? [];
    assert.equal(commands.some((line) => /^(MAIL|RCPT|DATA)/u.test(line)), false);
    assert.equal(smtp.last()?.authenticated, "PLAIN");
  } finally {
    await smtp.close();
  }
});

test("setup adapter email: a refused probe exits 1, KEEPS the values, and prints the undo", async () => {
  const smtp = await startMockSmtp({ tls: "none", user: SMTP_USER, password: SMTP_PASSWORD });
  try {
    smtp.failAt({ step: "auth", reply: "535 5.7.8 authentication failed" });
    const home = makeHome();
    const result = await run(["adapter", "email", "--as", HUMAN], home, {
      prompter: scriptedPrompter([
        assertLoopback(smtp.host),
        String(smtp.port),
        "",
        SMTP_USER,
        SMTP_PASSWORD,
        true,
      ]),
      keystore: fakeKeystore("keychain"),
      env: WITH_PASSPHRASE,
      probe: loopbackProbe(),
    });

    assert.equal(result.code, EXIT_INTEGRITY, result.out);
    assert.match(result.err, /smtp-535/u);
    assert.match(result.err, /authentication failed/u);
    assert.match(result.err, /The values ARE stored/u);
    assert.match(result.err, /approval vault remove smtp\.password --as human:<id>/u);
    // Kept, all five: a probe failure is not a reason to make anyone retype.
    assert.deepEqual(vaultNames(home), Object.values(DEFAULT_CREDENTIAL_NAMES).sort());
  } finally {
    await smtp.close();
  }
});

test("setup adapter email: a partial re-run that declines the probe prints today's refusal", async () => {
  const home = makeHome();
  await run(["adapter", "email", "--as", HUMAN], home, {
    prompter: scriptedPrompter(["127.0.0.1", "587", "", SMTP_USER, SMTP_PASSWORD, false]),
    keystore: fakeKeystore("keychain"),
    env: WITH_PASSPHRASE,
  });

  // Replace the host only. Every confirmation is asked FIRST, before a single
  // value: the other four are left alone, so this run does not hold the whole
  // configuration. It is OFFERED the stored-set probe (APRV-99) and says no,
  // which is the sentence this verb printed before the offer existed.
  const result = await run(["adapter", "email", "--as", HUMAN], home, {
    prompter: scriptedPrompter([true, false, false, false, false, "127.0.0.2", "n"]),
    keystore: fakeKeystore("keychain"),
    env: WITH_PASSPHRASE,
    probe: () => {
      throw new Error("a declined partial run probed the server");
    },
  });

  assert.equal(result.code, EXIT_OK, result.err);
  assert.match(result.out, /not verified: smtp\.port, smtp\.security, smtp\.user, smtp\.password were left alone/u);
  assert.match(result.out, /stored 1 value\(s\)/u);
  assert.equal(vaultValue(home, DEFAULT_CREDENTIAL_NAMES.host), "127.0.0.2");
  assert.equal(vaultValue(home, DEFAULT_CREDENTIAL_NAMES.password), SMTP_PASSWORD);
});

test("setup adapter email: a partial re-run probes the MERGED set through the adapter's own vault read (APRV-99)", async () => {
  const smtp = await startMockSmtp({ tls: "none", user: SMTP_USER, password: "rotated-app-password" });
  try {
    const home = makeHome();
    // First run: the whole set, against the mock, no probe.
    await run(["adapter", "email", "--as", HUMAN], home, {
      prompter: scriptedPrompter([
        assertLoopback(smtp.host),
        String(smtp.port),
        "",
        SMTP_USER,
        SMTP_PASSWORD,
        false,
      ]),
      keystore: fakeKeystore("keychain"),
      env: WITH_PASSPHRASE,
    });

    // Rotate the password only, then take the offer. The probe must open a
    // session with the KEPT host, port, security and user and the NEW password:
    // the merged set, read the way `approval adapter email` reads it at send
    // time, and printed nowhere.
    const result = await run(["adapter", "email", "--as", HUMAN], home, {
      prompter: scriptedPrompter([
        false,
        false,
        false,
        false,
        true,
        "rotated-app-password",
        "", // the offer defaults to yes
      ]),
      keystore: fakeKeystore("keychain"),
      env: WITH_PASSPHRASE,
      probe: loopbackProbe(),
    });

    assert.equal(result.code, EXIT_OK, result.err);
    assert.match(result.out, /verified: 127\.0\.0\.1:\d+ answered over starttls/u);
    assert.match(result.out, /AUTH PLAIN/u);
    assert.match(result.out, /No message was sent/u);
    assert.doesNotMatch(result.out, /not verified/u);

    // The server's view: the kept user authenticated, with the new password.
    assert.equal(smtp.last()?.authenticated, "PLAIN");
    assert.deepEqual(smtp.last()?.presented, {
      user: SMTP_USER,
      password: "rotated-app-password",
    });
    const commands = smtp.last()?.commands ?? [];
    assert.equal(commands.some((line) => /^(MAIL|RCPT|DATA)/u.test(line)), false);
  } finally {
    await smtp.close();
  }
});

test("setup adapter email: a vault the probe cannot open falls back to today's refusal plus the reason (APRV-99)", async () => {
  const home = makeHome();
  await run(["adapter", "email", "--as", HUMAN], home, {
    prompter: scriptedPrompter(["127.0.0.1", "587", "", SMTP_USER, SMTP_PASSWORD, false]),
    keystore: fakeKeystore("keychain"),
    env: WITH_PASSPHRASE,
  });

  const result = await run(["adapter", "email", "--as", HUMAN], home, {
    prompter: scriptedPrompter([true, false, false, false, false, "127.0.0.2", "y"]),
    keystore: fakeKeystore("keychain"),
    env: WITH_PASSPHRASE,
    // The flow proved the passphrase at its preflight, so the only way to reach
    // the fallback is a read that refuses. This is what a wrong passphrase, a
    // missing variable, or an altered file looks like from the probe's side.
    credentials: {
      get: () => ({
        ok: false,
        code: "credential-refused",
        message: "the vault at .approval/vault.enc did not decrypt under APPROVAL_VAULT_PASSPHRASE",
      }),
    },
    probe: () => {
      throw new Error("a probe ran over a vault that would not open");
    },
  });

  assert.equal(result.code, EXIT_OK, result.err);
  assert.match(result.out, /not verified: smtp\.port, smtp\.security, smtp\.user, smtp\.password were left alone/u);
  assert.match(result.out, /the probe could not run: /u);
  assert.match(result.out, /did not decrypt under APPROVAL_VAULT_PASSPHRASE/u);
  assert.match(result.out, /stored 1 value\(s\)/u);
});

test("setup adapter email: an answer that is neither yes nor no asks the probe offer again (APRV-99)", async () => {
  const smtp = await startMockSmtp({ tls: "none", user: SMTP_USER, password: SMTP_PASSWORD });
  try {
    const home = makeHome();
    await run(["adapter", "email", "--as", HUMAN], home, {
      prompter: scriptedPrompter([
        assertLoopback(smtp.host),
        String(smtp.port),
        "",
        SMTP_USER,
        SMTP_PASSWORD,
        false,
      ]),
      keystore: fakeKeystore("keychain"),
      env: WITH_PASSPHRASE,
    });

    // Replace the host with the same value, keep the rest, then fumble the
    // offer once. APRV-90's convention is that every question loops.
    const prompter = scriptedPrompter([
      true,
      false,
      false,
      false,
      false,
      assertLoopback(smtp.host),
      "sure", // neither yes nor no
      "y",
    ]);
    const result = await run(["adapter", "email", "--as", HUMAN], home, {
      prompter,
      keystore: fakeKeystore("keychain"),
      env: WITH_PASSPHRASE,
      probe: loopbackProbe(),
    });

    assert.equal(result.code, EXIT_OK, result.err);
    assert.match(result.out, /"sure" is not yes or no/u);
    // Asked twice, and the second answer was the one that decided it.
    const offers = prompter.asked.filter((prompt) =>
      prompt.includes("using the stored configuration"),
    );
    assert.equal(offers.length, 2);
    assert.deepEqual(prompter.remaining, []);
    assert.match(result.out, /verified: 127\.0\.0\.1:\d+ answered over starttls/u);
  } finally {
    await smtp.close();
  }
});

test("setup adapter email: replacing only the password keeps the pair rule satisfied by the kept user (APRV-98)", async () => {
  const home = makeHome();
  await run(["adapter", "email", "--as", HUMAN], home, {
    prompter: scriptedPrompter(["127.0.0.1", "587", "", SMTP_USER, SMTP_PASSWORD, false]),
    keystore: fakeKeystore("keychain"),
    env: WITH_PASSPHRASE,
  });

  // Keep host, port, security and user; replace the password. The pair rule
  // must count the KEPT user as present, or every password rotation is refused
  // as "holds smtp.password but not smtp.user".
  const result = await run(["adapter", "email", "--as", HUMAN], home, {
    prompter: scriptedPrompter([false, false, false, false, true, "rotated-secret", "n"]),
    keystore: fakeKeystore("keychain"),
    env: WITH_PASSPHRASE,
  });
  assert.equal(result.code, EXIT_OK, result.err);
  assert.doesNotMatch(result.err, /holds smtp\.password but not smtp\.user/u);
  assert.equal(vaultValue(home, DEFAULT_CREDENTIAL_NAMES.password), "rotated-secret");
  assert.equal(vaultValue(home, DEFAULT_CREDENTIAL_NAMES.user), SMTP_USER);

  // The rule still bites when the counterpart was never stored at all: a fresh
  // vault, user skipped, password given.
  const fresh = makeHome();
  const refused = await run(["adapter", "email", "--as", HUMAN], fresh, {
    prompter: scriptedPrompter(["127.0.0.1", "587", "", "", "lonely-secret"]),
    keystore: fakeKeystore("keychain"),
    env: WITH_PASSPHRASE,
  });
  assert.equal(refused.code, EXIT_USAGE);
  assert.match(refused.err, /holds smtp\.password but not smtp\.user/u);
});

test("setup adapter email: a Google app password pasted with non-breaking spaces is recognised and stripped (APRV-97)", async () => {
  const home = makeHome();
  const nbsp = "abcd efgh ijkl mnop";
  const prompter = scriptedPrompter(["127.0.0.1", "587", "", SMTP_USER, nbsp, true, false]);
  const result = await run(["adapter", "email", "--as", HUMAN], home, {
    prompter,
    keystore: fakeKeystore("keychain"),
    env: WITH_PASSPHRASE,
  });
  assert.equal(result.code, EXIT_OK, result.err);
  assert.match(result.out, /received 19 character\(s\)/u);
  assert.match(result.out, /storing 16 character\(s\)/u);
  assert.equal(vaultValue(home, DEFAULT_CREDENTIAL_NAMES.password), "abcdefghijklmnop");
});

test("setup adapter email: outer whitespace on a pasted secret is trimmed and reported, then the shape check runs (APRV-98)", async () => {
  // A trailing space from a web-page copy, on top of the display spaces: 20
  // characters that would fail AUTH. Trimmed to 19, recognised, stripped to 16.
  const home = makeHome();
  const prompter = scriptedPrompter(["127.0.0.1", "587", "", SMTP_USER, "abcd efgh ijkl mnop ", true, false]);
  const result = await run(["adapter", "email", "--as", HUMAN], home, {
    prompter,
    keystore: fakeKeystore("keychain"),
    env: WITH_PASSPHRASE,
  });
  assert.equal(result.code, EXIT_OK, result.err);
  assert.match(result.out, /received 20 character\(s\)/u);
  assert.match(result.out, /trimmed 1 leading\/trailing whitespace character\(s\); 19 remain/u);
  assert.match(result.out, /storing 16 character\(s\)/u);
  assert.equal(vaultValue(home, DEFAULT_CREDENTIAL_NAMES.password), "abcdefghijklmnop");

  // A plain secret with stray outer whitespace: trimmed, no offer.
  const other = makeHome();
  const p2 = scriptedPrompter(["127.0.0.1", "587", "", SMTP_USER, "  hunter2 ", false]);
  const r2 = await run(["adapter", "email", "--as", HUMAN], other, {
    prompter: p2,
    keystore: fakeKeystore("keychain"),
    env: WITH_PASSPHRASE,
  });
  assert.equal(r2.code, EXIT_OK, r2.err);
  assert.deepEqual(p2.remaining, []);
  assert.match(r2.out, /trimmed 3 leading\/trailing whitespace character\(s\); 7 remain/u);
  assert.equal(vaultValue(other, DEFAULT_CREDENTIAL_NAMES.password), "hunter2");
});

test("setup adapter email: a vault that will not open refuses BEFORE a password is typed", async () => {
  const home = makeHome();
  await run(["adapter", "email", "--as", HUMAN], home, {
    prompter: scriptedPrompter(["127.0.0.1", "587", "", SMTP_USER, SMTP_PASSWORD, false]),
    keystore: fakeKeystore("keychain"),
    env: WITH_PASSPHRASE,
  });

  // A different passphrase. The preflight opens the vault, so the refusal
  // arrives with the script untouched: not one question was asked.
  const prompter = scriptedPrompter([]);
  const result = await run(["adapter", "email", "--as", HUMAN], home, {
    prompter,
    keystore: fakeKeystore("keychain"),
    env: { APPROVAL_VAULT_PASSPHRASE: "a-different-passphrase-entirely" },
  });

  assert.equal(result.code, EXIT_INTEGRITY, result.out);
  assert.match(result.err, /vault-unreadable/u);
  assert.match(result.err, /nothing was collected and nothing was written/u);
  assert.deepEqual(prompter.asked, [], "a wrong passphrase still asked for a credential");
});

// ---------------------------------------------------------------------------
// The other destination
// ---------------------------------------------------------------------------

test("the env-file destination reports what is there, writes a line, and refuses a bad mode", () => {
  const home = makeHome({ env: `# a comment\nAPPROVAL_TG_CHAT=42\n` });
  const destination = envFileDestination(home.envPath);

  assert.equal(destination.kind, "env-file");
  assert.equal(destination.where(), home.envPath);

  const before = destination.present();
  assert.equal(before.ok, true);
  assert.deepEqual(before.ok ? [...before.names] : [], ["APPROVAL_TG_CHAT"]);

  const written = destination.write("APPROVAL_HUMAN", HUMAN);
  assert.equal(written.ok, true, written.ok ? "" : written.message);
  assert.equal(
    readFileSync(home.envPath, "utf8"),
    `# a comment\nAPPROVAL_TG_CHAT=42\nAPPROVAL_HUMAN=${HUMAN}\n`,
  );

  const after = destination.present();
  assert.deepEqual(after.ok ? [...after.names].sort() : [], ["APPROVAL_HUMAN", "APPROVAL_TG_CHAT"]);

  // The mode rule belongs to the file, and the destination passes it through
  // with the exit code the CLI's own table gives it.
  chmodSync(home.envPath, 0o644);
  const refused = destination.present();
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.code, "env-file-mode");
    assert.equal(refused.exitCode, EXIT_IO);
  }
});

test("`approval env --check` reads back exactly what setup wrote", () => {
  // Named explicitly rather than "the last home this suite made": the cases
  // below it add homes of their own, and a test that read the newest one would
  // silently start asserting about a different file.
  assert.notEqual(fullWalkHome, "", "the four-subcommand walk did not run");
  const result = spawnCli(["env", "--check"], fullWalkHome);
  // Every source is a keychain: line, so nothing resolves without a helper —
  // the point here is that the FILE parses and every variable is accounted for.
  assert.match(result.stdout, /APPROVAL_HUMAN/u);
  assert.match(result.stdout, new RegExp(`keychain:${SERVICE_TELEGRAM_TOKEN}`, "u"));
  assert.match(result.stdout, /No value is printed on this path/u);
});
