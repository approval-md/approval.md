/**
 * `approval vault` CLI tests (APRV-68).
 *
 * Every case spawns the real built CLI in a temp directory. Two sweeps run over
 * the whole suite rather than over one case:
 *
 * - **every captured stdout and stderr is recorded and scanned** for the test
 *   credential and for the test passphrase at the end of the run. A leak through
 *   a message nobody thought to assert on is exactly the shape of failure
 *   SPEC.md §11.1 invariant 3 exists to prevent, so the scan is over everything
 *   the CLI said, not over the strings a test remembered to check; and
 * - **every log file any case touched is scanned too**, along with the assertion
 *   that these verbs append nothing at all. A credential's existence is
 *   configuration, and the log is the record of authorized actions.
 *
 * Nothing here writes a vault file by hand: every vault under test was produced
 * by `approval vault set`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const SECRET = "sk-live-cli-vault-6a21fe-DO-NOT-USE";
const OTHER_SECRET = "smtp-pw-cli-vault-93bd07-DO-NOT-USE";
const PASSPHRASE = "an operator-held passphrase for the suite";
const HUMAN = "human:carter";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-cli-vault-")));
let counter = 0;

/** Everything the CLI printed, across every case. Swept at the end. */
const transcript: string[] = [];
/** Every home a case created, so the final sweep can find their logs. */
const homes: string[] = [];

after(() => {
  const said = transcript.join("\n");
  for (const [label, needle] of [
    ["credential value", SECRET],
    ["second credential value", OTHER_SECRET],
    ["vault passphrase", PASSPHRASE],
  ] as const) {
    assert.equal(
      said.includes(needle),
      false,
      `the ${label} appeared in this suite's captured CLI output (SPEC.md §11.1 invariant 3)`,
    );
  }

  for (const home of homes) {
    const logPath = join(home, ".approval", "log", "events.jsonl");
    if (!existsSync(logPath)) continue;
    const raw = readFileSync(logPath, "utf8");
    for (const needle of [SECRET, OTHER_SECRET, PASSPHRASE]) {
      assert.equal(raw.includes(needle), false, `a secret reached ${logPath}`);
    }
  }

  rmSync(scratch, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the CLI with a scrubbed environment. The ambient `APPROVAL_HUMAN` and
 * any vault variable of whoever runs the suite must never decide a test.
 */
function runCli(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
  stdin?: string,
): Run {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  for (const name of ["APPROVAL_HUMAN", "APPROVAL_VAULT_PASSPHRASE", "APPROVAL_TEST_VAULT_PASS"]) {
    if (env[name] === undefined) delete childEnv[name];
  }
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    env: childEnv,
    encoding: "utf8",
    // An explicit empty stdin, so a `set` with no piped value reads EOF rather
    // than inheriting this process's terminal and blocking the suite forever.
    input: stdin ?? "",
  });
  const run = { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  transcript.push(run.stdout, run.stderr);
  return run;
}

const GREEN = { APPROVAL_HUMAN: HUMAN, APPROVAL_VAULT_PASSPHRASE: PASSPHRASE };

/** A fresh working directory with a `.approval/` home and no vault. */
function makeHome(policy?: string): string {
  counter += 1;
  const home = join(scratch, `home-${String(counter)}`);
  mkdirSync(join(home, ".approval", "log"), { recursive: true });
  if (policy !== undefined) writeFileSync(join(home, "APPROVAL.md"), policy, "utf8");
  homes.push(home);
  return home;
}

function vaultPath(home: string): string {
  return join(home, ".approval", "vault.enc");
}

/** A home whose vault already holds one credential, stored through the CLI. */
function withCredential(name = "api-key", value = SECRET): string {
  const home = makeHome();
  const run = runCli(["vault", "set", name], home, GREEN, value);
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  return home;
}

// ---------------------------------------------------------------------------
// The round trip
// ---------------------------------------------------------------------------

test("vault set stores from stdin, creating the vault, and prints no value", () => {
  const home = makeHome();
  assert.equal(existsSync(vaultPath(home)), false);

  const set = runCli(["vault", "set", "api-key", "--json"], home, GREEN, `${SECRET}\n`);
  assert.equal(set.code, 0, set.stderr);
  const parsed = JSON.parse(set.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), ["ok", "name", "created", "count", "path"]);
  assert.equal(parsed["ok"], true);
  assert.equal(parsed["name"], "api-key");
  assert.equal(parsed["created"], true);
  assert.equal(parsed["count"], 1);
  assert.equal(parsed["path"], vaultPath(home));
  assert.equal(existsSync(vaultPath(home)), true);

  // The one trailing newline was stripped: the stored value is what a `get`
  // through the provider would return, byte for byte.
  const list = runCli(["vault", "list", "--json"], home, GREEN);
  assert.equal(list.code, 0, list.stderr);
  const listed = JSON.parse(list.stdout) as { names: string[]; count: number; present: boolean };
  assert.deepEqual(listed.names, ["api-key"]);
  assert.equal(listed.count, 1);
  assert.equal(listed.present, true);

  // Nothing about the file is readable, and nothing was appended to the log.
  const raw = readFileSync(vaultPath(home), "utf8");
  assert.equal(raw.includes(SECRET), false);
  assert.equal(raw.includes("api-key"), false, "a credential NAME is readable on disk");
  assert.equal(existsSync(join(home, ".approval", "log", "events.jsonl")), false);
});

test("vault set reads --value-env, and refuses when the variable is unset", () => {
  const home = makeHome();
  const stored = runCli(
    ["vault", "set", "api-key", "--value-env", "APPROVAL_TEST_VAULT_VALUE"],
    home,
    { ...GREEN, APPROVAL_TEST_VAULT_VALUE: SECRET },
  );
  assert.equal(stored.code, 0, stored.stderr);
  assert.match(stored.stdout, /stored api-key/u);

  const unset = runCli(["vault", "set", "other", "--value-env", "APPROVAL_TEST_NO_SUCH"], home, GREEN);
  assert.equal(unset.code, 2);
  assert.match(unset.stderr, /APPROVAL_TEST_NO_SUCH/u);
  assert.match(unset.stderr, /unset or empty/u);
});

test("there is no --value flag: a secret on a command line is a secret in history", () => {
  const home = makeHome();
  const run = runCli(["vault", "set", "api-key", "--value", SECRET], home, GREEN);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /unknown flag --value/u);
  assert.equal(existsSync(vaultPath(home)), false);

  // A positional second argument is refused with the reason spelled out.
  const positional = runCli(["vault", "set", "api-key", SECRET], home, GREEN);
  assert.equal(positional.code, 2);
  assert.match(positional.stderr, /the VALUE is never a command-line argument/u);
});

test("vault set with nothing on stdin is a usage error, not an empty credential", () => {
  const home = makeHome();
  const run = runCli(["vault", "set", "api-key"], home, GREEN, "");
  assert.equal(run.code, 2);
  assert.match(run.stderr, /stdin carried no credential value/u);
  assert.equal(existsSync(vaultPath(home)), false);
});

test("vault set replaces an existing name and says so", () => {
  const home = withCredential();
  const again = runCli(["vault", "set", "api-key", "--json"], home, GREEN, OTHER_SECRET);
  assert.equal(again.code, 0, again.stderr);
  const parsed = JSON.parse(again.stdout) as { created: boolean; count: number };
  assert.equal(parsed.created, false);
  assert.equal(parsed.count, 1);
  assert.match(runCli(["vault", "set", "api-key"], home, GREEN, SECRET).stdout, /^replaced /u);
});

test("vault remove deletes one name and refuses one the vault does not hold", () => {
  const home = withCredential();
  const second = runCli(["vault", "set", "smtp-password"], home, GREEN, OTHER_SECRET);
  assert.equal(second.code, 0, second.stderr);

  const removed = runCli(["vault", "remove", "api-key", "--json"], home, GREEN);
  assert.equal(removed.code, 0, removed.stderr);
  const parsed = JSON.parse(removed.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), ["ok", "name", "count", "path"]);
  assert.equal(parsed["count"], 1);

  const listed = JSON.parse(runCli(["vault", "list", "--json"], home, GREEN).stdout) as {
    names: string[];
  };
  assert.deepEqual(listed.names, ["smtp-password"]);

  const missing = runCli(["vault", "remove", "api-key", "--json"], home, GREEN);
  assert.equal(missing.code, 1, "a name the vault does not hold is a refusal, not a success");
  const error = (JSON.parse(missing.stderr) as { error: { code: string } }).error;
  assert.equal(error.code, "credential-absent");
  assert.equal(missing.stdout, "");
});

// ---------------------------------------------------------------------------
// The missing verb
// ---------------------------------------------------------------------------

test("there is no `vault get`, and the refusal says why", () => {
  const home = withCredential();
  const run = runCli(["vault", "get", "api-key"], home, GREEN);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /there is no `approval vault get`/u);
  assert.match(run.stderr, /verified-token window/u);
  assert.equal(run.stdout, "");
});

test("no vault subcommand prints a credential value on any path", () => {
  const home = withCredential();
  const runs = [
    runCli(["vault", "list"], home, GREEN),
    runCli(["vault", "list", "--json"], home, GREEN),
    runCli(["vault", "set", "api-key"], home, GREEN, SECRET),
    runCli(["vault", "remove", "api-key"], home, GREEN),
    runCli(["vault", "remove", "api-key"], home, GREEN),
    runCli(["vault", "--help"], home, GREEN),
    runCli(["vault", "set", "--help"], home, GREEN),
  ];
  for (const run of runs) {
    assert.equal(run.stdout.includes(SECRET), false);
    assert.equal(run.stderr.includes(SECRET), false);
    assert.equal(run.stdout.includes(PASSPHRASE), false);
    assert.equal(run.stderr.includes(PASSPHRASE), false);
  }
});

// ---------------------------------------------------------------------------
// Identity and the passphrase
// ---------------------------------------------------------------------------

test("all three verbs are human-only, by policy attest's rules", () => {
  const home = withCredential();
  for (const argv of [["vault", "set", "x"], ["vault", "list"], ["vault", "remove", "api-key"]]) {
    const anonymous = runCli(argv, home, { APPROVAL_VAULT_PASSPHRASE: PASSPHRASE }, SECRET);
    assert.equal(anonymous.code, 2, `${argv.join(" ")} ran with no identity`);
    assert.match(anonymous.stderr, /no human identity: set APPROVAL_HUMAN=human:<id>/u);

    const agent = runCli(
      [...argv, "--as", "agent:bot"],
      home,
      { APPROVAL_VAULT_PASSPHRASE: PASSPHRASE },
      SECRET,
    );
    assert.equal(agent.code, 2, `${argv.join(" ")} accepted an agent actor`);
    assert.match(agent.stderr, /human-only/u);
  }
  // --as wins over the environment, exactly as attest has it.
  const explicit = runCli(["vault", "list", "--as", HUMAN], home, {
    APPROVAL_VAULT_PASSPHRASE: PASSPHRASE,
  });
  assert.equal(explicit.code, 0, explicit.stderr);
});

test("an unset passphrase variable is a usage error naming the variable", () => {
  const home = withCredential();
  const run = runCli(["vault", "list"], home, { APPROVAL_HUMAN: HUMAN });
  assert.equal(run.code, 2);
  assert.match(run.stderr, /APPROVAL_VAULT_PASSPHRASE is unset or empty/u);
  assert.match(run.stderr, /no --passphrase flag/u);
});

test("the policy names the passphrase variable, and the CLI honours the name", () => {
  const policy = [
    "# Policy",
    "",
    "```yaml approval-policy",
    'version: "0.1"',
    "defaults:",
    "  autonomy: manual",
    "vault:",
    "  passphrase_env: APPROVAL_TEST_VAULT_PASS",
    "```",
    "",
  ].join("\n");
  const home = makeHome(policy);

  // The default variable is ignored once the policy names another.
  const wrongVariable = runCli(["vault", "set", "api-key"], home, GREEN, SECRET);
  assert.equal(wrongVariable.code, 2);
  assert.match(wrongVariable.stderr, /APPROVAL_TEST_VAULT_PASS is unset or empty/u);

  const named = {
    APPROVAL_HUMAN: HUMAN,
    APPROVAL_TEST_VAULT_PASS: PASSPHRASE,
  };
  const stored = runCli(["vault", "set", "api-key"], home, named, SECRET);
  assert.equal(stored.code, 0, stored.stderr);
  const listed = runCli(["vault", "list", "--json"], home, named);
  assert.deepEqual((JSON.parse(listed.stdout) as { names: string[] }).names, ["api-key"]);

  // The policy file itself carries the NAME and nothing else.
  const policyBytes = readFileSync(join(home, "APPROVAL.md"), "utf8");
  assert.equal(policyBytes.includes(PASSPHRASE), false);
});

test("a wrong passphrase refuses vault-unreadable without saying which fault it is", () => {
  const home = withCredential();
  const run = runCli(["vault", "list", "--json"], home, {
    APPROVAL_HUMAN: HUMAN,
    APPROVAL_VAULT_PASSPHRASE: "not the passphrase",
  });
  assert.equal(run.code, 1);
  assert.equal(run.stdout, "");
  const error = (JSON.parse(run.stderr) as { error: { code: string; message: string } }).error;
  assert.equal(error.code, "vault-unreadable");
  assert.match(error.message, /passphrase wrong or file altered/u);
});

// ---------------------------------------------------------------------------
// The absent vault
// ---------------------------------------------------------------------------

test("list on a vault nobody created says so and exits 0", () => {
  const home = makeHome();
  const human = runCli(["vault", "list"], home, { APPROVAL_HUMAN: HUMAN });
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /no vault at /u);
  assert.match(human.stdout, /a state and not a fault/u);

  // And the passphrase is not even required: an absent vault is reported as
  // absent rather than as an unset variable.
  const json = runCli(["vault", "list", "--json"], home, { APPROVAL_HUMAN: HUMAN });
  assert.equal(json.code, 0);
  const parsed = JSON.parse(json.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), ["ok", "present", "path", "count", "names"]);
  assert.equal(parsed["present"], false);
  assert.deepEqual(parsed["names"], []);
});

test("remove and get-shaped reads of an absent vault refuse rather than pretend", () => {
  const home = makeHome();
  const run = runCli(["vault", "remove", "api-key", "--json"], home, GREEN);
  assert.equal(run.code, 1);
  assert.equal(
    (JSON.parse(run.stderr) as { error: { code: string } }).error.code,
    "vault-absent",
  );
});

// ---------------------------------------------------------------------------
// Paths, usage, and help
// ---------------------------------------------------------------------------

test("--vault and --log both point the verbs at another file", () => {
  const home = makeHome();
  const elsewhere = join(scratch, `elsewhere-${String(counter)}`);
  mkdirSync(elsewhere, { recursive: true });
  const explicit = join(elsewhere, "custom.enc");

  const stored = runCli(["vault", "set", "api-key", "--vault", explicit], home, GREEN, SECRET);
  assert.equal(stored.code, 0, stored.stderr);
  assert.equal(existsSync(explicit), true);
  assert.equal(existsSync(vaultPath(home)), false, "--vault was ignored");

  const listed = runCli(["vault", "list", "--vault", explicit, "--json"], home, GREEN);
  assert.deepEqual((JSON.parse(listed.stdout) as { names: string[] }).names, ["api-key"]);

  // --log derives the vault beside the log's home.
  const otherLog = join(elsewhere, "home", ".approval", "log", "events.jsonl");
  mkdirSync(join(elsewhere, "home", ".approval", "log"), { recursive: true });
  const byLog = runCli(["vault", "set", "api-key", "--log", otherLog], home, GREEN, SECRET);
  assert.equal(byLog.code, 0, byLog.stderr);
  assert.equal(existsSync(join(elsewhere, "home", ".approval", "vault.enc")), true);
});

test("usage errors and --help behave like every other verb", () => {
  const home = makeHome();

  const bare = runCli(["vault"], home, GREEN);
  assert.equal(bare.code, 2);
  assert.match(bare.stderr, /missing subcommand for `approval vault`/u);

  const unknownSub = runCli(["vault", "rotate"], home, GREEN);
  assert.equal(unknownSub.code, 2);
  assert.match(unknownSub.stderr, /unknown subcommand "rotate"/u);

  const unknownFlag = runCli(["vault", "list", "--nope"], home, GREEN);
  assert.equal(unknownFlag.code, 2);
  assert.match(unknownFlag.stderr, /unknown flag --nope/u);

  const jsonUsage = runCli(["vault", "list", "--nope", "--json"], home, GREEN);
  assert.equal(jsonUsage.code, 2);
  assert.equal(jsonUsage.stdout, "");
  assert.equal(
    (JSON.parse(jsonUsage.stderr) as { error: { code: string } }).error.code,
    "usage",
  );

  const noName = runCli(["vault", "set"], home, GREEN, SECRET);
  assert.equal(noName.code, 2);
  assert.match(noName.stderr, /missing <name> argument/u);

  const removeNoName = runCli(["vault", "remove"], home, GREEN);
  assert.equal(removeNoName.code, 2);
  assert.match(removeNoName.stderr, /missing <name> argument/u);
});

test("help: every vault help documents exit codes, the JSON shape, and the threat model", () => {
  const home = makeHome();
  for (const argv of [
    ["vault", "--help"],
    ["vault", "set", "--help"],
    ["vault", "list", "--help"],
    ["vault", "remove", "--help"],
  ]) {
    const run = runCli(argv, home, GREEN);
    assert.equal(run.code, 0, run.stderr);
    for (const claim of ["Exit codes (frozen public API)", "JSON", "HUMAN-ONLY"]) {
      assert.ok(run.stdout.includes(claim), `${argv.join(" ")} --help is missing "${claim}"`);
    }
    // -h is accepted wherever --help is.
    const short = runCli([...argv.slice(0, -1), "-h"], home, GREEN);
    assert.equal(short.stdout, run.stdout);
  }

  const family = runCli(["vault", "--help"], home, GREEN);
  assert.match(family.stdout, /THERE IS NO "approval vault get"/u);
  assert.match(family.stdout, /What the vault DEFENDS/u);
  assert.match(family.stdout, /does NOT defend/u);
  assert.match(family.stdout, /compromised host/u);
  assert.match(family.stdout, /read the passphrase variable/u);

  // And the root help names the verb.
  const root = runCli(["--help"], home, GREEN);
  assert.match(root.stdout, /approval vault set <name>/u);
});

// ---------------------------------------------------------------------------
// The log is not touched
// ---------------------------------------------------------------------------

test("no vault verb appends to the log, and none creates one", () => {
  const home = withCredential();
  const logPath = join(home, ".approval", "log", "events.jsonl");
  assert.equal(existsSync(logPath), false, "vault set created a log");

  // A home with a real (empty-but-present) log file is left byte-identical.
  writeFileSync(logPath, "", "utf8");
  const before = readFileSync(logPath);
  runCli(["vault", "set", "second"], home, GREEN, OTHER_SECRET);
  runCli(["vault", "list"], home, GREEN);
  runCli(["vault", "remove", "second"], home, GREEN);
  assert.deepEqual(readFileSync(logPath), before);

  // Nor does anything land beside the vault: no temp file survives a write.
  const residue = readdirSync(join(home, ".approval")).filter((name) => name.startsWith("."));
  assert.deepEqual(residue, [], `interrupted-write residue: ${residue.join(", ")}`);
});
