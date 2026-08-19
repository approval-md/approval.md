/**
 * `approval env` CLI tests (APRV-73).
 *
 * Every case spawns the real built CLI in a temp directory. Three sweeps run
 * over the whole suite rather than over one case:
 *
 * - **every captured stdout and stderr is scanned for the fixture secrets at the
 *   end of the run**, EXCEPT the streams of the invocations that legitimately
 *   emit them (`approval env` without `--check`, and `--json` without
 *   `--check`). Those two paths exist to move a value into a shell; every other
 *   path in this CLI — including every `--check` byte, every refusal, and every
 *   other verb — must be value-free, and a leak through a message nobody thought
 *   to assert on is exactly the shape of failure SPEC.md §11.1 invariant 3 is
 *   about;
 * - **every log file any case touched is scanned too**; and
 * - **the invariant-7 case**: `doctor`, `policy attest` and `channel telegram
 *   health` are spawned in a directory holding a complete, mode-0600
 *   `.approval/env` with a literal token and a literal identity, and none of
 *   them may see a byte of it.
 *
 * ## The resolver fakes
 *
 * `keychain:` and `secret-service:` shell out to `security` and `secret-tool`.
 * No test here touches a real Keychain or a real secret service, and no test-only
 * flag is added to the runtime to arrange that: the runtime looks its helpers up
 * on PATH by bare command name, so each case that exercises a helper prepends a
 * temp directory holding STUB SCRIPTS named `security` and `secret-tool` to the
 * child's PATH. That is a real PATH lookup of a real command name, which is what
 * the resolver does in production, and the stub can be made to answer, to exit
 * 44 (`errSecItemNotFound`), or to be absent entirely.
 *
 * A PATH with no stub directory and a scrubbed PATH entry for the real
 * `/usr/bin` is how the "helper binary missing" case is produced, so that case is
 * also honest on a Linux box with no `security` at all.
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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { ENV_FILE_REFUSAL_CODES, envFilePathFor } from "../src/core/env-file.js";
import { EXIT_INTEGRITY, EXIT_IO, EXIT_OK, EXIT_USAGE } from "../src/cli/exit-codes.js";
import { GITIGNORE_ENTRIES } from "../src/cli/scaffold.js";
import { shellSingleQuote } from "../src/cli/env.js";

/** dist/tests/cli-env.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const TOKEN = "7654321:AA-approval-md-env-fixture-token-DO-NOT-USE";
const PASSPHRASE = "an operator-held passphrase for the env suite";
const KEYCHAIN_SECRET = "kc-approval-md-env-4f21ab-DO-NOT-USE";
const SECRET_SERVICE_SECRET = "ss-approval-md-env-9c07de-DO-NOT-USE";
const HUMAN = "human:carter";

/** Every fixture value that must never appear on a value-free path. */
const SECRETS = [TOKEN, PASSPHRASE, KEYCHAIN_SECRET, SECRET_SERVICE_SECRET] as const;

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-cli-env-")));
let counter = 0;

/** Everything printed by an invocation that must NOT carry a value. */
const valueFreeTranscript: string[] = [];
/** Every home a case created, so the final sweep can find their logs. */
const homes: string[] = [];

after(() => {
  const said = valueFreeTranscript.join("\n");
  for (const needle of SECRETS) {
    assert.equal(
      said.includes(needle),
      false,
      `a fixture secret appeared on a value-free path in this suite (SPEC.md §11.1 invariant 3). Only \`approval env\` and \`approval env --json\` may emit values.`,
    );
  }

  for (const home of homes) {
    const logPath = join(home, ".approval", "log", "events.jsonl");
    if (!existsSync(logPath)) continue;
    const raw = readFileSync(logPath, "utf8");
    for (const needle of SECRETS) {
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
 * Spawn the CLI with a scrubbed environment: the ambient identity and channel
 * variables of whoever runs the suite must never decide a test.
 *
 * `emitsValues` marks the two invocations that are ALLOWED to print a secret. It
 * is opt-in per call rather than inferred from argv, so that a future path which
 * starts printing values has to be marked by hand — the sweep is the assertion,
 * and a sweep that inferred its own exemptions would exempt the bug.
 */
function runCli(
  args: string[],
  cwd: string,
  options: { env?: Record<string, string>; path?: string; emitsValues?: boolean } = {},
): Run {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  for (const name of [
    "APPROVAL_HUMAN",
    "APPROVAL_TG_TOKEN",
    "APPROVAL_TG_CHAT",
    "APPROVAL_VAULT_PASSPHRASE",
    "APPROVAL_AUDIT_SECRET",
  ]) {
    if (options.env?.[name] === undefined) delete childEnv[name];
  }
  if (options.path !== undefined) childEnv["PATH"] = options.path;

  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    env: childEnv,
    encoding: "utf8",
    input: "",
  });
  const run = { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  if (options.emitsValues !== true) valueFreeTranscript.push(run.stdout, run.stderr);
  return run;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A policy naming every variable this verb answers for. Deliberately NOT the
 * canonical scaffold: this one also declares a sampling secret and a vault
 * passphrase, so the full variable set is exercised.
 */
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

function makeHome(options: { policy?: string; env?: string; mode?: number } = {}): string {
  counter += 1;
  const home = join(scratch, `home-${String(counter)}`);
  mkdirSync(join(home, ".approval", "log"), { recursive: true });
  writeFileSync(join(home, "APPROVAL.md"), options.policy ?? FULL_POLICY, "utf8");
  if (options.env !== undefined) {
    const path = join(home, ".approval", "env");
    writeFileSync(path, options.env, "utf8");
    chmodSync(path, options.mode ?? 0o600);
  }
  homes.push(home);
  return home;
}

/**
 * A directory holding stub `security` / `secret-tool` scripts, and a PATH that
 * finds them first. `behaviour` is baked into the script, so the runtime is
 * driven exactly as it would be in production: bare command name, PATH lookup,
 * value on stdout.
 */
function stubHelpers(behaviour: {
  keychain?: { value?: string; exit?: number };
  secretService?: { value?: string; exit?: number };
}): string {
  counter += 1;
  const dir = join(scratch, `bin-${String(counter)}`);
  mkdirSync(dir, { recursive: true });

  const write = (name: string, spec: { value?: string; exit?: number } | undefined): void => {
    if (spec === undefined) return;
    const body =
      spec.value === undefined
        ? `#!/bin/sh\nexit ${String(spec.exit ?? 1)}\n`
        : `#!/bin/sh\ncat <<'APPROVAL_STUB_EOF'\n${spec.value}\nAPPROVAL_STUB_EOF\nexit ${String(spec.exit ?? 0)}\n`;
    const path = join(dir, name);
    writeFileSync(path, body, "utf8");
    chmodSync(path, 0o755);
  };

  write("security", behaviour.keychain);
  write("secret-tool", behaviour.secretService);
  return dir;
}

/** PATH with the stub directory first, so a real helper can never win. */
function pathWith(dir: string): string {
  return `${dir}${delimiter}${process.env["PATH"] ?? ""}`;
}

/** A PATH holding ONLY a directory with no helpers in it: the binary is absent. */
function pathWithout(): string {
  counter += 1;
  const empty = join(scratch, `empty-bin-${String(counter)}`);
  mkdirSync(empty, { recursive: true });
  return empty;
}

interface EnvJson {
  ok: boolean;
  path: string;
  present: boolean;
  variables: Array<{
    name: string;
    status: string;
    source: string;
    plaintext: boolean;
    declared: boolean;
    value?: string;
    fix?: string;
    refusal?: { code: string; message: string };
  }>;
}

function envJson(home: string, args: string[] = [], options: Parameters<typeof runCli>[2] = {}) {
  const run = runCli(["env", "--json", ...args], home, options);
  return { run, parsed: JSON.parse(run.stdout) as EnvJson };
}

function variable(parsed: EnvJson, name: string) {
  const found = parsed.variables.find((entry) => entry.name === name);
  assert.ok(found !== undefined, `no variable ${name} in ${JSON.stringify(parsed.variables)}`);
  return found;
}

// ---------------------------------------------------------------------------
// The refusal union
// ---------------------------------------------------------------------------

test("the env-file refusal union is frozen and every code is distinct", () => {
  assert.deepEqual(
    [...ENV_FILE_REFUSAL_CODES],
    [
      "env-file-mode",
      "env-file-io",
      "env-file-syntax",
      "env-file-key-invalid",
      "env-file-duplicate-key",
      "env-file-unknown-scheme",
      "env-file-empty-value",
      "helper-binary-missing",
      "helper-item-missing",
      "helper-failed",
      "invalid-variable-name",
    ],
    "ENV_FILE_REFUSAL_CODES is frozen public API (SPEC.md §11.1 invariant 6)",
  );
  assert.equal(new Set(ENV_FILE_REFUSAL_CODES).size, ENV_FILE_REFUSAL_CODES.length);
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test("comments, blank lines and surrounding whitespace are ignored", () => {
  const home = makeHome({
    env: `# the source map\n\n   \nAPPROVAL_HUMAN=${HUMAN}\n\n# trailing comment\n`,
  });
  const { run, parsed } = envJson(home, ["--check"]);
  assert.equal(run.code, EXIT_INTEGRITY, run.stderr); // the telegram vars are unresolved
  assert.equal(variable(parsed, "APPROVAL_HUMAN").status, "resolved-literal");
});

test("a bare literal is a literal, and so is any value with an unreserved word: prefix", () => {
  // `human:carter` is the commonest line the file will ever hold and must not
  // be read as a source scheme.
  const home = makeHome({ env: `APPROVAL_HUMAN=${HUMAN}\nAPPROVAL_TG_CHAT=12345\n` });
  const { parsed } = envJson(home, ["--check"]);
  assert.equal(variable(parsed, "APPROVAL_HUMAN").status, "resolved-literal");
  assert.equal(variable(parsed, "APPROVAL_TG_CHAT").status, "resolved-literal");
  // Neither is a secret, so neither is flagged plaintext…
  assert.equal(variable(parsed, "APPROVAL_HUMAN").plaintext, false);
  // …but the SOURCE still says literal, on every one of them.
  assert.match(variable(parsed, "APPROVAL_HUMAN").source, /literal \(plaintext in \.approval\/env\)/u);
});

test("a literal token IS flagged plaintext, and the value never reaches --check", () => {
  const home = makeHome({ env: `APPROVAL_TG_TOKEN=${TOKEN}\n` });
  const { parsed } = envJson(home, ["--check"]);
  const token = variable(parsed, "APPROVAL_TG_TOKEN");
  assert.equal(token.status, "resolved-literal");
  assert.equal(token.plaintext, true);
  assert.equal(token.value, undefined, "--json --check must not carry values");

  const table = runCli(["env", "--check"], home);
  assert.equal(table.stdout.includes(TOKEN), false, "the --check table printed the token");
  assert.match(table.stdout, /PLAINTEXT: APPROVAL_TG_TOKEN/u);
});

test("literal: is the escape for a value that begins with a reserved scheme", () => {
  const home = makeHome({ env: "APPROVAL_TG_CHAT=literal:vault:12345\n" });
  const { parsed } = envJson(home);
  assert.equal(variable(parsed, "APPROVAL_TG_CHAT").value, "vault:12345");
});

test("a reserved-but-unimplemented scheme is refused, never read as text", () => {
  const home = makeHome({ env: "APPROVAL_TG_TOKEN=keyring:approval-token\n" });
  const run = runCli(["env"], home);
  assert.equal(run.code, EXIT_INTEGRITY);
  assert.match(run.stderr, /env-file-unknown-scheme/u);
  assert.match(run.stderr, /literal:keyring:/u, "the refusal must name the escape");
});

test("every parse refusal is distinct, names its line, and refuses the whole file", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["export APPROVAL_HUMAN=human:x\n", "env-file-syntax", /export/u],
    ["APPROVAL_HUMAN\n", "env-file-syntax", /line 1/u],
    ["approval_human=human:x\n", "env-file-key-invalid", /A-Z_/u],
    [`APPROVAL_HUMAN=${HUMAN}\nAPPROVAL_HUMAN=human:other\n`, "env-file-duplicate-key", /twice/u],
    ["APPROVAL_HUMAN=\n", "env-file-empty-value", /empty value/u],
    ["APPROVAL_HUMAN=literal:\n", "env-file-empty-value", /literal:/u],
    ["APPROVAL_TG_TOKEN=keychain:\n", "env-file-syntax", /service name/u],
    ["APPROVAL_TG_CHAT=env:something\n", "env-file-syntax", /nothing after the colon/u],
  ];
  for (const [text, code, message] of cases) {
    const home = makeHome({ env: text });
    const run = runCli(["env"], home);
    assert.equal(run.code, EXIT_INTEGRITY, `${code}: ${run.stdout}${run.stderr}`);
    assert.match(run.stderr, new RegExp(code, "u"));
    assert.match(run.stderr, message);
    assert.equal(run.stdout, "", "a refused file must produce no export block at all");
  }
});

test("nothing is quote-stripped: this is a source map, not a shell script", () => {
  const home = makeHome({ env: `APPROVAL_TG_CHAT="12345"\n` });
  const { parsed } = envJson(home);
  assert.equal(variable(parsed, "APPROVAL_TG_CHAT").value, `"12345"`);
});

// ---------------------------------------------------------------------------
// The resolvers, through a real PATH lookup
// ---------------------------------------------------------------------------

test("keychain: resolves through `security` found on PATH, and the value is never in argv", () => {
  const home = makeHome({ env: "APPROVAL_TG_TOKEN=keychain:approval-tg\n" });
  const bin = stubHelpers({ keychain: { value: KEYCHAIN_SECRET } });
  const { parsed } = envJson(home, [], { path: pathWith(bin), emitsValues: true });
  const token = variable(parsed, "APPROVAL_TG_TOKEN");
  assert.equal(token.status, "resolved-from-keychain");
  assert.equal(token.value, KEYCHAIN_SECRET);
  assert.equal(token.plaintext, false, "a keychain-held value is not plaintext in the tree");
  assert.equal(token.source, "keychain:approval-tg");
});

test("secret-service: resolves through `secret-tool` found on PATH", () => {
  const home = makeHome({ env: "APPROVAL_VAULT_PASSPHRASE=secret-service:vault-pass\n" });
  const bin = stubHelpers({ secretService: { value: SECRET_SERVICE_SECRET } });
  const { parsed } = envJson(home, [], { path: pathWith(bin), emitsValues: true });
  const pass = variable(parsed, "APPROVAL_VAULT_PASSPHRASE");
  assert.equal(pass.status, "resolved-from-secret-service");
  assert.equal(pass.value, SECRET_SERVICE_SECRET);
  assert.equal(pass.source, "secret-service:vault-pass");
});

test("a missing helper binary and a missing item are DIFFERENT refusals", () => {
  const home = makeHome({ env: "APPROVAL_TG_TOKEN=keychain:approval-tg\n" });

  const absent = envJson(home, ["--check"], { path: pathWithout() });
  assert.equal(variable(absent.parsed, "APPROVAL_TG_TOKEN").refusal?.code, "helper-binary-missing");

  // 44 is errSecItemNotFound: the helper ran, the item is not there.
  const missing = envJson(home, ["--check"], {
    path: pathWith(stubHelpers({ keychain: { exit: 44 } })),
  });
  assert.equal(variable(missing.parsed, "APPROVAL_TG_TOKEN").refusal?.code, "helper-item-missing");

  // Anything else is a failure, whose repair is not "store the item".
  const failed = envJson(home, ["--check"], {
    path: pathWith(stubHelpers({ keychain: { exit: 51 } })),
  });
  assert.equal(variable(failed.parsed, "APPROVAL_TG_TOKEN").refusal?.code, "helper-failed");

  for (const parsed of [absent.parsed, missing.parsed, failed.parsed]) {
    assert.equal(variable(parsed, "APPROVAL_TG_TOKEN").status, "unset");
  }
});

test("secret-tool exiting 1, or 0 with no output, is a missing item", () => {
  const home = makeHome({ env: "APPROVAL_VAULT_PASSPHRASE=secret-service:vault-pass\n" });
  const one = envJson(home, ["--check"], {
    path: pathWith(stubHelpers({ secretService: { exit: 1 } })),
  });
  assert.equal(
    variable(one.parsed, "APPROVAL_VAULT_PASSPHRASE").refusal?.code,
    "helper-item-missing",
  );
  const empty = envJson(home, ["--check"], {
    path: pathWith(stubHelpers({ secretService: { value: "", exit: 0 } })),
  });
  assert.equal(
    variable(empty.parsed, "APPROVAL_VAULT_PASSPHRASE").refusal?.code,
    "helper-item-missing",
  );
});

// ---------------------------------------------------------------------------
// The ambient environment wins
// ---------------------------------------------------------------------------

test("an already-exported value wins and the file's line is not consulted", () => {
  const home = makeHome({ env: "APPROVAL_TG_TOKEN=keychain:approval-tg\n" });
  // The stub would answer if it were consulted. It must not be: the shell wins.
  const { parsed } = envJson(home, ["--check"], {
    env: { APPROVAL_TG_TOKEN: TOKEN },
    path: pathWith(stubHelpers({ keychain: { value: KEYCHAIN_SECRET } })),
  });
  const token = variable(parsed, "APPROVAL_TG_TOKEN");
  assert.equal(token.status, "set-in-environment");
  assert.match(token.source, /already exported/u);
});

test("env: means inherited — set in the shell it is set, unset it is unset", () => {
  const home = makeHome({ env: "APPROVAL_TG_CHAT=env:\n" });
  const unset = envJson(home, ["--check"]);
  assert.equal(variable(unset.parsed, "APPROVAL_TG_CHAT").status, "unset");
  assert.match(variable(unset.parsed, "APPROVAL_TG_CHAT").source, /inherited/u);

  const set = envJson(home, ["--check"], { env: { APPROVAL_TG_CHAT: "12345" } });
  assert.equal(variable(set.parsed, "APPROVAL_TG_CHAT").status, "set-in-environment");
});

// ---------------------------------------------------------------------------
// The variable set
// ---------------------------------------------------------------------------

test("the variable set is identity, telegram, the vault passphrase and — only when named — sampling", () => {
  const full = envJson(makeHome(), ["--check"]).parsed;
  assert.deepEqual(
    full.variables.map((entry) => entry.name),
    [
      "APPROVAL_HUMAN",
      "APPROVAL_TG_TOKEN",
      "APPROVAL_TG_CHAT",
      "APPROVAL_VAULT_PASSPHRASE",
      "APPROVAL_AUDIT_SECRET",
    ],
  );

  // No audit.sampling_secret_env: the sampling variable is ABSENT rather than
  // invented, because that key has no default (SPEC.md §5.2).
  const quiet = envJson(
    makeHome({
      policy: `\`\`\`yaml approval-policy\nversion: "0.1"\ndefaults: { autonomy: manual }\n\`\`\`\n`,
    }),
    ["--check"],
  ).parsed;
  assert.deepEqual(
    quiet.variables.map((entry) => entry.name),
    ["APPROVAL_HUMAN", "APPROVAL_TG_TOKEN", "APPROVAL_TG_CHAT", "APPROVAL_VAULT_PASSPHRASE"],
    "the four defaulted variables are always answered for",
  );
  // …and none of them is `declared`, so --check passes with all four unset.
  assert.equal(quiet.variables.some((entry) => entry.declared), false);
});

test("policy-declared names are honoured, and any other *_env key is picked up too", () => {
  const home = makeHome({
    policy: `\`\`\`yaml approval-policy
version: "0.1"
defaults: { autonomy: manual }
channels:
  telegram:
    token_env: MY_BOT_TOKEN
    chat_id_env: MY_CHAT
  matrix:
    access_token_env: MY_MATRIX_TOKEN
\`\`\`
`,
  });
  const { parsed } = envJson(home, ["--check"]);
  const names = parsed.variables.map((entry) => entry.name);
  assert.deepEqual(names, [
    "APPROVAL_HUMAN",
    "MY_BOT_TOKEN",
    "MY_CHAT",
    "APPROVAL_VAULT_PASSPHRASE",
    "MY_MATRIX_TOKEN",
  ]);
  // `matrix` is a third-party channel the schema admits as an opaque object, so
  // this is the real case: an _env key nothing in this build knows about, found
  // by the walk and treated as secret-bearing — the stricter reading.
  const walked = variable(parsed, "MY_MATRIX_TOKEN");
  assert.equal(walked.declared, true);
  assert.match(walked.fix ?? "", /export MY_MATRIX_TOKEN/u);
});

test("--check fails only on a variable the POLICY NAMED", () => {
  // Everything unset. The full policy names token, chat, passphrase, sampling.
  const declaredMissing = runCli(["env", "--check"], makeHome());
  assert.equal(declaredMissing.code, EXIT_INTEGRITY);
  assert.match(declaredMissing.stderr, /APPROVAL_TG_TOKEN/u);

  // A policy that declares nothing: the four defaults are offers, not promises.
  const defaultsOnly = runCli(
    ["env", "--check"],
    makeHome({
      policy: `\`\`\`yaml approval-policy\nversion: "0.1"\ndefaults: { autonomy: manual }\n\`\`\`\n`,
    }),
  );
  assert.equal(defaultsOnly.code, EXIT_OK, defaultsOnly.stderr);
  assert.match(defaultsOnly.stdout, /ok: every variable your policy names resolves/u);
});

// ---------------------------------------------------------------------------
// The export block, and eval safety
// ---------------------------------------------------------------------------

test("the export block is eval-safe for a value containing ' $ ` \\ \" and a newline", () => {
  // Every character a shell would otherwise interpret. A newline cannot come
  // from the FILE (one line, one variable, no continuations), so it arrives the
  // way a newline realistically would: already exported in the calling shell.
  // The rest come from the file, so both sources are covered by one assertion.
  const fromFile = `a'b$c\`d\\e"f g`;
  const fromShell = `x'y$z\`w\nsecond line\tand a tab`;
  const home = makeHome();
  writeFileSync(join(home, ".approval", "env"), `APPROVAL_TG_CHAT=${fromFile}\n`, "utf8");
  chmodSync(join(home, ".approval", "env"), 0o600);

  const run = runCli(["env"], home, {
    env: { APPROVAL_HUMAN: fromShell },
    emitsValues: true,
  });
  assert.equal(run.code, EXIT_OK, run.stderr);
  assert.match(run.stdout, /^export APPROVAL_TG_CHAT=/mu);

  // The real test: a shell evaluates the block and reports what it got.
  const shell = spawnSync(
    "/bin/sh",
    [
      "-c",
      `eval "$(cat)" >/dev/null 2>&1; printf %s "$APPROVAL_TG_CHAT"; printf '\\034'; printf %s "$APPROVAL_HUMAN"`,
    ],
    { input: run.stdout, encoding: "utf8" },
  );
  assert.equal(shell.status, 0);
  assert.deepEqual(
    shell.stdout.split("\u001c"),
    [fromFile, fromShell],
    "the values a shell recovers from the export block must be byte-identical",
  );
});

test("shellSingleQuote closes, escapes and reopens, and does nothing else", () => {
  assert.equal(shellSingleQuote("plain"), "'plain'");
  assert.equal(shellSingleQuote("a'b"), `'a'\\''b'`);
  assert.equal(shellSingleQuote("$x`y`\\z"), "'$x`y`\\z'");
});

test("unresolved variables are COMMENTS naming a setup verb, and the block still exits 0", () => {
  const run = runCli(["env"], makeHome(), { emitsValues: true });
  assert.equal(run.code, EXIT_OK, "the output is destined for eval and must never fail a shell");
  for (const [name, verb] of [
    ["APPROVAL_HUMAN", "identity"],
    ["APPROVAL_TG_TOKEN", "channel telegram"],
    ["APPROVAL_TG_CHAT", "channel telegram"],
    ["APPROVAL_VAULT_PASSPHRASE", "vault"],
    ["APPROVAL_AUDIT_SECRET", "sampling"],
  ] as const) {
    assert.match(
      run.stdout,
      new RegExp(`# ${name} unset: run \`approval setup ${verb}\``, "u"),
      `no setup hint for ${name}`,
    );
  }
  assert.equal(run.stdout.includes("\nexport "), false, "nothing resolved, so nothing is exported");
  assert.match(run.stdout, /eval "\$\(approval env\)"/u);
  // APRV-91: the export block's banner says what the rule is, not which
  // invariant number it is; the citation stays in `approval env --help`.
  assert.match(run.stdout, /No other command reads that file/u);
  assert.doesNotMatch(run.stdout, /SPEC\.md §/u);
});

test("an already-set variable is re-exported, marked, and still correct", () => {
  const run = runCli(["env"], makeHome(), {
    env: { APPROVAL_HUMAN: HUMAN },
    emitsValues: true,
  });
  assert.match(run.stdout, /^export APPROVAL_HUMAN='human:carter' {2}# already set$/mu);
});

// ---------------------------------------------------------------------------
// The file's own conditions
// ---------------------------------------------------------------------------

test("a mode other than 0600 is refused at exit 4, with the chmod to run", () => {
  const home = makeHome({ env: `APPROVAL_TG_TOKEN=${TOKEN}\n`, mode: 0o644 });
  const run = runCli(["env"], home);
  assert.equal(run.code, EXIT_IO);
  assert.match(run.stderr, /env-file-mode/u);
  assert.match(run.stderr, /has mode 0644/u);
  assert.match(run.stderr, new RegExp(`chmod 600 ${envFilePathFor(join(home, ".approval", "log", "events.jsonl"))}`, "u"));
  assert.equal(run.stdout, "");

  // World-readable is refused too, and so is group-writable.
  for (const mode of [0o604, 0o660, 0o700]) {
    chmodSync(join(home, ".approval", "env"), mode);
    assert.equal(runCli(["env"], home).code, EXIT_IO, `mode ${mode.toString(8)} was accepted`);
  }
  chmodSync(join(home, ".approval", "env"), 0o600);
  assert.equal(runCli(["env"], home, { emitsValues: true }).code, EXIT_OK);
});

test("an absent file is NOT an error: everything falls to inherited or unset", () => {
  const home = makeHome();
  const { run, parsed } = envJson(home);
  assert.equal(run.code, EXIT_OK);
  assert.equal(parsed.present, false);
  assert.deepEqual(
    [...new Set(parsed.variables.map((entry) => entry.status))],
    ["unset"],
  );

  const withShell = envJson(home, [], { env: { APPROVAL_HUMAN: HUMAN } });
  assert.equal(variable(withShell.parsed, "APPROVAL_HUMAN").status, "set-in-environment");

  const table = runCli(["env", "--check"], home);
  assert.match(table.stdout, /no file/u);
});

// ---------------------------------------------------------------------------
// THE INVARIANT: no verb loads .approval/env implicitly (SPEC.md §11.1(7))
// ---------------------------------------------------------------------------

test("NO OTHER VERB READS .approval/env — not doctor, not attest, not telegram health", () => {
  // A complete, correctly-permissioned source map: identity, token, chat,
  // passphrase, sampling secret. Everything a gate operation needs.
  const home = makeHome({
    env: [
      `APPROVAL_HUMAN=${HUMAN}`,
      `APPROVAL_TG_TOKEN=${TOKEN}`,
      "APPROVAL_TG_CHAT=12345",
      `APPROVAL_VAULT_PASSPHRASE=${PASSPHRASE}`,
      `APPROVAL_AUDIT_SECRET=${KEYCHAIN_SECRET}`,
      "",
    ].join("\n"),
  });

  // 1. `policy attest` is HUMAN-ONLY and takes its identity from APPROVAL_HUMAN.
  //    If anything loaded the file, this would succeed and append an event.
  const attest = runCli(["policy", "attest"], home);
  assert.equal(attest.code, EXIT_USAGE, `attest saw an identity it should not have: ${attest.stdout}`);
  assert.match(attest.stderr, /no human identity/u);
  assert.equal(
    existsSync(join(home, ".approval", "log", "events.jsonl")),
    false,
    "policy attest appended an event using an identity it read from the working tree",
  );

  // 2. `channel telegram health` reports the token as unset.
  const health = runCli(["channel", "telegram", "health", "--json"], home);
  assert.match(health.stdout, /"token_set":false/u, "telegram health saw a token from the tree");
  assert.match(health.stdout, /"chat_id":null/u);
  assert.match(health.stdout, /"token_env":"APPROVAL_TG_TOKEN"/u);

  // 3. `doctor` SKIPS the telegram check and FAILS identity.
  const doctor = runCli(["doctor", "--json"], home);
  const report = JSON.parse(doctor.stdout) as {
    checks: Array<{ check: string; status: string; detail: string }>;
  };
  const telegram = report.checks.find((entry) => entry.check === "telegram");
  assert.equal(telegram?.status, "skip", "doctor probed Telegram with a token from the working tree");
  const identity = report.checks.find((entry) => entry.check === "identity");
  assert.equal(identity?.status, "fail", "doctor found an identity in the working tree");

  // And the sweep in `after` proves none of the three printed any of it: every
  // stream above went into the value-free transcript.
  for (const run of [attest, health, doctor]) {
    for (const needle of SECRETS) {
      assert.equal(
        `${run.stdout}${run.stderr}`.includes(needle),
        false,
        "a verb that must not read .approval/env printed something from it",
      );
    }
  }

  // The file is unchanged and nothing was written beside it.
  assert.match(readFileSync(join(home, ".approval", "env"), "utf8"), new RegExp(TOKEN, "u"));
});

// ---------------------------------------------------------------------------
// Usage, help, and the scaffold
// ---------------------------------------------------------------------------

test("init gitignores .approval/env, and the pinned block still matches", () => {
  assert.ok(
    GITIGNORE_ENTRIES.includes(".approval/env"),
    "the environment source map may hold a plaintext literal and must be ignored",
  );
  const dir = join(scratch, `init-${String((counter += 1))}`);
  mkdirSync(dir, { recursive: true });
  const run = runCli(["init"], dir);
  assert.equal(run.code, EXIT_OK, run.stderr);
  assert.match(readFileSync(join(dir, ".gitignore"), "utf8"), /^\.approval\/env$/mu);
  assert.match(run.stdout, /approval env --check/u, "the next steps must mention the verb");
});

test("help: the verb documents the exit codes, the JSON shape, and that it emits secrets", () => {
  const home = makeHome();
  const help = runCli(["env", "--help"], home);
  assert.equal(help.code, EXIT_OK);
  for (const claim of [
    // APRV-91: the frozen table is the root help's; a verb points at it.
    "exit codes: approval --help",
    "JSON shape",
    "ONLY THING THAT READS",
    "CARRIES SECRETS",
    "invariant 7",
    "0600",
  ]) {
    assert.ok(help.stdout.includes(claim), `env --help is missing "${claim}"`);
  }
  assert.equal(runCli(["env", "-h"], home).stdout, help.stdout);

  const root = runCli(["--help"], home);
  assert.match(root.stdout, /approval env {8}\[--check\]/u);
  assert.match(root.stdout, /\n {2}env {7}resolve \.approval\/env/u);
});

test("usage errors: an unknown flag and a stray positional both exit 2", () => {
  const home = makeHome();
  const flag = runCli(["env", "--values"], home);
  assert.equal(flag.code, EXIT_USAGE);
  assert.match(flag.stderr, /unknown flag --values/u);

  const positional = runCli(["env", "extra"], home);
  assert.equal(positional.code, EXIT_USAGE);
  assert.match(positional.stderr, /unexpected argument/u);

  const json = runCli(["env", "--values", "--json"], home);
  assert.equal(json.code, EXIT_USAGE);
  assert.match(json.stderr, /"code":"usage"/u);
});

test("nothing under `approval env` writes anything, anywhere", () => {
  const home = makeHome({ env: `APPROVAL_HUMAN=${HUMAN}\n` });
  const before = readFileSync(join(home, ".approval", "env"));
  runCli(["env"], home, { emitsValues: true });
  runCli(["env", "--check"], home);
  runCli(["env", "--json"], home, { emitsValues: true });
  assert.deepEqual(readFileSync(join(home, ".approval", "env")), before);
  assert.equal(
    existsSync(join(home, ".approval", "log", "events.jsonl")),
    false,
    "a read-only diagnostic created a log",
  );
});
