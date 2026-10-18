/**
 * A credential read whose LAST path component is a command substitution is
 * `account.credential` on every hook adapter (APRV-524).
 *
 * Since APRV-511 the lexer leaves a `$(…)` in its word as the substitution
 * sentinel, so the credential pass saw an unresolved word and judged it by
 * its text alone. Before APRV-511 the substitution added nothing to the text,
 * so a git reader of a word built from a Hermes home and a substitution was
 * read as a reader of the home itself and took the class. APRV-511 added the
 * judgement back only in the Hermes disk pass, which runs only where the
 * harness states a per-call directory (Hermes and Muse with `workdir`), so
 * Claude Code, Cursor, Codex and Grok (and Hermes or Muse without `workdir`)
 * answered the autonomous read class.
 *
 * Codex's native `Bash` hook is refused outright (the contract carries no
 * per-call directory), so Codex is driven through `approval codex bridge`,
 * whose exec requests reach the same classification with the Codex adapter.
 * Hermes without `workdir` is refused outright as well; one row pins that.
 *
 * Every word below is BUILT here from its parts, never written whole. Every
 * credential file is synthetic, in a scratch directory, and HOME points into
 * that directory: nothing reads a real one. Spawns the compiled CLI.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { classifyForHook } from "../src/cli/hook.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
const STUB = fileURLToPath(new URL("../../tests/fixtures/codex-app-server-stub.mjs", import.meta.url));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-sentinel-cred-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** A configured Hermes home the CLI child is given (review-b S3); none by default. */
let childHermesHome: string | null = null;

function runCli(args: string[], cwd: string, input: string, home: string): Run {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete childEnv["APPROVAL_HUMAN"];
  delete childEnv["HERMES_HOME"];
  delete childEnv["APPROVAL_HERMES_HOME"];
  if (childHermesHome !== null) childEnv["HERMES_HOME"] = childHermesHome;
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], { cwd, encoding: "utf8", env: childEnv, input });
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
  "  vcs.*:",
  "    autonomy: autonomous",
  "  files.write.workspace:",
  "    autonomy: autonomous",
  "  policy.core:",
  "    autonomy: human-only",
  "  account.credential:",
  "    autonomy: human-only",
  "```",
  "",
].join("\n");

/** A scratch gate whose HOME holds a synthetic Hermes home, and an ordinary directory. */
function lab(): { dir: string; home: string } {
  counter += 1;
  const dir = join(scratch, `case-${String(counter)}`);
  const home = join(dir, ".hermes");
  for (const sub of ["workspace", "skills/s1", "hermes-agent"]) mkdirSync(join(home, sub), { recursive: true });
  mkdirSync(join(dir, "notes"), { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  writeFileSync(join(home, ".env"), "SYNTHETIC_TOKEN=x\n", "utf8");
  writeFileSync(join(home, "auth.json"), "{}\n", "utf8");
  writeFileSync(join(home, "hermes-agent", ".env"), "SYNTHETIC_TOKEN=x\n", "utf8");
  writeFileSync(join(dir, "notes", "a.md"), "x\n", "utf8");
  const attested = runCli(["policy", "attest", "--as", "human:alice"], dir, "", dir);
  assert.equal(attested.code, 0, attested.stderr);
  return { dir, home };
}

// The parts every word is built from. A substitution is assembled, never spelled.
const substitution = (...inner: string[]): string => ["$", "(", inner.join(" "), ")"].join("");
const printed = (name: string): string => substitution("echo", name);
const ENV_FILE = [".", "env"].join("");
const AUTH_FILE = ["auth", "json"].join(".");
const HOME_DIR = [".", "hermes"].join("");
const tilde = (...parts: string[]): string => ["~", HOME_DIR, ...parts].join("/");

/** Words whose LAST component is a substitution under a directory that holds credentials. */
const SENTINEL_WORDS: readonly string[] = [
  tilde(printed(ENV_FILE)),
  tilde("hermes-agent", printed(ENV_FILE)),
  tilde(".", printed(ENV_FILE)),
  tilde("skills", "..", printed(AUTH_FILE)),
  // The home spelled as a variable the hook process does not have set.
  [["$", "HERMES_HOME"].join(""), printed(ENV_FILE)].join("/"),
];

/** The four git readers, each built as an argv and joined. */
const GIT_READERS: ReadonlyArray<(word: string) => string> = [
  (word) => ["git", "show", word].join(" "),
  (word) => ["git", "diff", "--no-index", "/dev/null", word].join(" "),
  (word) => ["git", "grep", "--no-index", "-h", ".", word].join(" "),
  (word) => ["git", "log", "-p", "--", word].join(" "),
];

type Verdict = "allow" | "deny";

interface Adapter {
  /** The label in a failure message. */
  name: string;
  /** Does this configuration state a per-call directory? */
  perCall: boolean;
  ask(dir: string, envelopeCwd: string, command: string): Run;
  verdict(run: Run): Verdict;
}

const nestedVerdict = (run: Run): Verdict => {
  assert.equal(run.code, 0, run.stderr);
  const body = JSON.parse(run.stdout) as { hookSpecificOutput?: { permissionDecision?: string } };
  const decision = body.hookSpecificOutput?.permissionDecision;
  assert.ok(decision === "allow" || decision === "deny", `not a verdict: ${run.stdout}`);
  return decision;
};

const id = (): string => String(Math.random()).slice(2);

const ADAPTERS: readonly Adapter[] = [
  {
    name: "claude-code",
    perCall: false,
    ask: (dir, cwd, command) =>
      runCli(
        ["hook", "claude-code", "--as", "agent:cc"],
        dir,
        JSON.stringify({
          hook_event_name: "PreToolUse",
          session_id: "cc-sentinel",
          tool_use_id: `cc-${id()}`,
          cwd,
          tool_name: "Bash",
          tool_input: { command },
          transcript_path: "/dev/null",
          permission_mode: "default",
        }),
        dir,
      ),
    verdict: nestedVerdict,
  },
  {
    name: "cursor",
    perCall: false,
    ask: (dir, cwd, command) =>
      runCli(
        ["hook", "cursor", "--as", "agent:cursor"],
        dir,
        JSON.stringify({ session_id: "cursor-sentinel", cwd, hook_event_name: "preToolUse", tool_name: "Shell", tool_input: { command } }),
        dir,
      ),
    verdict: (run) => {
      assert.equal(run.code, 0, run.stderr);
      const permission = (JSON.parse(run.stdout) as { permission?: string }).permission;
      assert.ok(permission === "allow" || permission === "deny", `not a verdict: ${run.stdout}`);
      return permission;
    },
  },
  {
    name: "grok",
    perCall: false,
    ask: (dir, cwd, command) =>
      runCli(
        ["hook", "grok", "--as", "agent:grok"],
        dir,
        JSON.stringify({ hookEventName: "PreToolUse", sessionId: "grok-sentinel", cwd, workspaceRoot: cwd, toolName: "Bash", toolInput: { command } }),
        dir,
      ),
    verdict: (run) => {
      const decision = (JSON.parse(run.stdout) as { decision?: string }).decision;
      assert.ok(decision === "allow" || decision === "deny", `not a verdict: ${run.stdout}`);
      assert.equal(run.code, decision === "deny" ? 2 : 0, run.stderr);
      return decision;
    },
  },
  ...[true].map(
    (perCall): Adapter => ({
      name: "hermes (workdir)",
      perCall,
      ask: (dir, cwd, command) =>
        runCli(
          ["hook", "hermes", "--as", "agent:hermes"],
          dir,
          JSON.stringify({
            hook_event_name: "pre_tool_call",
            session_id: "hermes-sentinel",
            tool_use_id: `hermes-${id()}`,
            cwd,
            profile: "default",
            extra: {},
            tool_name: "terminal",
            tool_input: perCall ? { command, workdir: cwd } : { command },
          }),
          dir,
        ),
      verdict: (run) => {
        const body = JSON.parse(run.stdout) as Record<string, unknown>;
        if (Object.keys(body).length === 0) {
          assert.equal(run.code, 0, run.stderr);
          return "allow";
        }
        assert.equal(body["action"], "block", run.stdout);
        assert.equal(run.code, 2);
        return "deny";
      },
    }),
  ),
  ...[false, true].map(
    (perCall): Adapter => ({
      name: perCall ? "muse (workdir)" : "muse (no workdir)",
      perCall,
      ask: (dir, cwd, command) =>
        runCli(
          ["hook", "muse", "--as", "agent:muse"],
          dir,
          JSON.stringify({
            hook_event_name: "PreToolUse",
            session_id: "muse-sentinel",
            turn_id: "turn-1",
            tool_use_id: `muse-${id()}`,
            transcript_path: null,
            cwd,
            model: "muse-spark-1.3",
            model_provider: "meta",
            permission_mode: "default",
            tool_name: "bash",
            tool_input: perCall ? { command, workdir: cwd } : { command },
          }),
          dir,
        ),
      verdict: nestedVerdict,
    }),
  ),
];

function expectVerdict(adapter: Adapter, dir: string, cwd: string, command: string, want: Verdict): void {
  const run = adapter.ask(dir, cwd, command);
  const got = adapter.verdict(run);
  assert.equal(got, want, `${adapter.name}: ${command} (cwd ${cwd}): ${run.stdout} ${run.stderr}`);
  if (want === "deny") {
    assert.match(`${run.stdout} ${run.stderr}`, /account\.credential/u, `${adapter.name}: ${command}: ${run.stdout}`);
  }
}

for (const adapter of ADAPTERS) {
  test(`APRV-524 ${adapter.name}: a git reader of a word whose last component is a substitution under a Hermes home is account.credential`, () => {
    const { dir, home } = lab();
    for (const reader of GIT_READERS) {
      for (const word of SENTINEL_WORDS) expectVerdict(adapter, dir, dir, reader(word), "deny");
      // The substitution alone, read from the home itself.
      expectVerdict(adapter, dir, home, reader(["."].concat(printed(ENV_FILE)).join("/")), "deny");
    }
  });

  test(`APRV-524 ${adapter.name}: controls under an ordinary directory still read`, () => {
    const { dir } = lab();
    const ordinary = (name: string): string => ["notes", printed(name)].join("/");
    // A literal git read of an ordinary file, and a single-file read of a
    // substitution under an ordinary directory.
    expectVerdict(adapter, dir, dir, ["git", "log", "-p", "--", "notes/a.md"].join(" "), "allow");
    expectVerdict(adapter, dir, dir, ["cat", ordinary("a.md")].join(" "), "allow");
    // Without a per-call directory, the fix does not make every unresolved git
    // word a credential read (with one, APRV-511's recursive-reader rule does).
    if (!adapter.perCall) {
      for (const reader of GIT_READERS) expectVerdict(adapter, dir, dir, reader(ordinary("a.md")), "allow");
    }
  });
}

test("APRV-524 classifyForHook with no per-call directory: the four git readers of a substitution under a home", () => {
  const { dir, home } = lab();
  const absolute: readonly string[] = [
    join(home, printed(ENV_FILE)),
    join(home, "hermes-agent", printed(ENV_FILE)),
    [home, ".", printed(ENV_FILE)].join("/"),
    [home, "skills", "..", printed(AUTH_FILE)].join("/"),
  ];
  for (const reader of GIT_READERS) {
    for (const word of absolute) {
      const result = classifyForHook(reader(word), [], dir, [], false).result;
      assert.ok(result.ok, reader(word));
      assert.ok(result.classes.includes("account.credential"), `${reader(word)}: ${JSON.stringify(result)}`);
    }
    // Relative, judged from the home as the working directory, and from the
    // envelope directory the credential pass is also handed.
    const relative = reader(["."].concat(printed(ENV_FILE)).join("/"));
    for (const [cwd, also] of [[home, []], [dir, [home]]] as const) {
      const result = classifyForHook(relative, [], cwd, [], false, also).result;
      assert.ok(result.ok && result.classes.includes("account.credential"), `${relative} from ${cwd}: ${JSON.stringify(result)}`);
    }
    // Control: the same reader of a substitution under an ordinary directory.
    const control = classifyForHook(reader(join(dir, "notes", printed("a.md"))), [], dir, [], false).result;
    assert.ok(control.ok && !control.classes.includes("account.credential"), JSON.stringify(control));
  }
});

test("APRV-524 hermes (no workdir): the call is refused before it is classified", () => {
  const { dir } = lab();
  const command = GIT_READERS[0]!(SENTINEL_WORDS[0]!);
  const run = runCli(
    ["hook", "hermes", "--as", "agent:hermes"],
    dir,
    JSON.stringify({
      hook_event_name: "pre_tool_call",
      session_id: "hermes-sentinel",
      tool_use_id: `hermes-${id()}`,
      cwd: dir,
      profile: "default",
      extra: {},
      tool_name: "terminal",
      tool_input: { command },
    }),
    dir,
  );
  assert.equal(run.code, 2, run.stderr);
  assert.match(run.stdout, /hook-unsupported-execution-context/u);
});

// ---------------------------------------------------------------------------
// Codex, through the bridge (its native Bash hook refuses every call)
// ---------------------------------------------------------------------------

interface BridgeAnswer {
  outcome: "accept" | "decline";
  code: string | null;
  detail: string;
}

/** Each command as one exec approval request, in one bridge run against the stub. */
function codexBridge(dir: string, rows: ReadonlyArray<{ command: string; cwd: string }>): BridgeAnswer[] {
  const repliesPath = join(dir, "stub-replies.jsonl");
  const script = rows.map(({ command, cwd }, at) => ({
    method: "item/commandExecution/requestApproval",
    params: {
      kind: "command",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: `item-${String(at)}`,
      startedAtMs: 0,
      command,
      cwd,
      environmentId: "local",
      reason: null,
      availableDecisions: ["accept", "acceptForSession", "cancel", "decline"],
    },
  }));
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: dir,
    APPROVAL_STUB_SCRIPT: JSON.stringify(script),
    APPROVAL_STUB_REPLIES: repliesPath,
  };
  delete childEnv["APPROVAL_HUMAN"];
  delete childEnv["HERMES_HOME"];
  delete childEnv["APPROVAL_HERMES_HOME"];
  const run = spawnSync(
    process.execPath,
    [CLI_ENTRY, "codex", "bridge", "--prompt", "do the thing", "--dir", dir, "--wait", "2s", "--interval", "200ms", "--json", "--", process.execPath, STUB],
    { cwd: dir, encoding: "utf8", env: childEnv },
  );
  assert.equal(run.error, undefined, `spawn failed: ${String(run.error)}`);
  const line = run.stdout.split("\n").find((candidate) => candidate.trim().startsWith("{") && candidate.includes('"answers"'));
  assert.ok(line !== undefined, `no bridge report in:\n${run.stdout}\n${run.stderr}`);
  const answers = (JSON.parse(line) as { answers: BridgeAnswer[] }).answers;
  assert.equal(answers.length, rows.length, run.stdout);
  assert.ok(existsSync(repliesPath) && readFileSync(repliesPath, "utf8").length > 0, "the stub recorded no replies");
  return answers;
}

test("APRV-524 codex (bridge): a git reader of a word whose last component is a substitution under a Hermes home is account.credential", () => {
  const { dir, home } = lab();
  const rows: Array<{ command: string; cwd: string }> = [];
  for (const reader of GIT_READERS) {
    for (const word of SENTINEL_WORDS) rows.push({ command: reader(word), cwd: dir });
    rows.push({ command: reader(["."].concat(printed(ENV_FILE)).join("/")), cwd: home });
  }
  for (const [at, answer] of codexBridge(dir, rows).entries()) {
    const row = rows[at]!;
    assert.equal(answer.outcome, "decline", `${row.command} (cwd ${row.cwd}): ${JSON.stringify(answer)}`);
    assert.equal(answer.code, "hook-class-human-only", `${row.command}: ${JSON.stringify(answer)}`);
    assert.match(answer.detail, /account\.credential/u, `${row.command}: ${JSON.stringify(answer)}`);
  }
});

test("APRV-524 codex (bridge): controls under an ordinary directory still read", () => {
  const { dir } = lab();
  const ordinary = (name: string): string => ["notes", printed(name)].join("/");
  const rows = [
    ["git", "log", "-p", "--", "notes/a.md"].join(" "),
    ["cat", ordinary("a.md")].join(" "),
    ...GIT_READERS.map((reader) => reader(ordinary("a.md"))),
  ].map((command) => ({ command, cwd: dir }));
  for (const [at, answer] of codexBridge(dir, rows).entries()) {
    assert.equal(answer.outcome, "accept", `${rows[at]!.command}: ${JSON.stringify(answer)}`);
  }
});

/**
 * Siblings of the same rule (the commit review's parity and parser points):
 * the home spelled as a variable this process does not have set, which the
 * credential pass handles in its own branch; a quoted backslash, which the
 * shell keeps and the kernel reads as a character of the name; and a trailing
 * `/.`. The plain and braced home-variable rows were account.credential on
 * ee26a22f for a git reader and not on 49c56543. Every other row here is
 * stricter than both earlier trees: a single-file reader, `hermes-agent/.env`
 * (a credential row only since APRV-511), and the backslash and `/.` shapes.
 */
test("APRV-524 classifyForHook siblings: an unset home variable, a quoted backslash, a trailing dot", () => {
  const { dir, home } = lab();
  const saved = { h: process.env["HERMES_HOME"], a: process.env["APPROVAL_HERMES_HOME"] };
  delete process.env["HERMES_HOME"];
  delete process.env["APPROVAL_HERMES_HOME"];
  try {
    const plain = ["$", "HERMES_HOME"].join("");
    const braced = ["$", "{HERMES_HOME}"].join("");
    const denied: readonly string[] = [
      [plain, printed(ENV_FILE)].join("/"),
      [braced, printed(ENV_FILE)].join("/"),
      [plain, "hermes-agent", printed(ENV_FILE)].join("/"),
      [plain, "profiles", "p", printed(ENV_FILE)].join("/"),
      [plain, "approval", printed("env")].join("/"),
      ['"', [home, [printed("x"), "y"].join("\\")].join("/"), '"'].join(""),
      [home, printed("x"), "."].join("/"),
    ];
    for (const reader of [...GIT_READERS, (word: string) => ["cat", word].join(" ")]) {
      for (const word of denied) {
        const result = classifyForHook(reader(word), [], dir, [], false).result;
        assert.ok(result.ok && result.classes.includes("account.credential"), `${reader(word)}: ${JSON.stringify(result)}`);
      }
      for (const word of [[plain, "workspace", printed("a.md")].join("/"), [plain, "workspace", "a.md"].join("/")]) {
        const result = classifyForHook(reader(word), [], dir, [], false).result;
        assert.ok(result.ok && !result.classes.includes("account.credential"), `${reader(word)}: ${JSON.stringify(result)}`);
      }
    }
  } finally {
    if (saved.h !== undefined) process.env["HERMES_HOME"] = saved.h;
    if (saved.a !== undefined) process.env["APPROVAL_HERMES_HOME"] = saved.a;
  }
});

// ---------------------------------------------------------------------------
// review-b M1: a substitution that is NOT the whole last component
// ---------------------------------------------------------------------------

const APPROVAL_DIR = [".", "approval"].join("");
/** A substitution that prints nothing, so the word reads as its literal text. */
const EMPTY = substitution("true");

/**
 * The lab with every directory review-b names as holding credentials, built in
 * the scratch directory (never under the real HOME): a profile home, a home's
 * `approval/`, an approval home with its `keys/`, a configured home not named
 * `.hermes`, two directories under the home that hold a credential file without
 * being a home (the disk rule's own case), and an ordinary one beside them.
 */
function credentialLab(): {
  dir: string;
  home: string;
  configured: string;
  holders: readonly string[];
  plain: string;
} {
  const { dir, home } = lab();
  const vault = join(dir, "vault-parent", APPROVAL_DIR);
  const configured = join(dir, "hh");
  const holders = [join(home, "workspace", "proj"), join(home, "workspace", "proj2")];
  const plain = join(home, "workspace", "plain");
  for (const sub of [join(home, "profiles", "p"), join(home, "approval"), join(vault, "keys"), configured, ...holders, plain]) {
    mkdirSync(sub, { recursive: true });
  }
  writeFileSync(join(home, "profiles", "p", ENV_FILE), "SYNTHETIC_TOKEN=x\n", "utf8");
  writeFileSync(join(home, "approval", "env"), "SYNTHETIC=x\n", "utf8");
  writeFileSync(join(vault, "env"), "SYNTHETIC=x\n", "utf8");
  writeFileSync(join(vault, "keys", "k"), "x\n", "utf8");
  writeFileSync(join(configured, ENV_FILE), "SYNTHETIC_TOKEN=x\n", "utf8");
  writeFileSync(join(holders[0]!, ["config", "yaml"].join(".")), "x: 1\n", "utf8");
  writeFileSync(join(holders[1]!, AUTH_FILE), "{}\n", "utf8");
  writeFileSync(join(plain, "a.md"), "x\n", "utf8");
  return { dir, home, configured, holders, plain };
}

/**
 * Review-b's three M1 shapes, under `root` (the directory that holds the Hermes
 * home): each word, read with the substitution empty, names a directory that
 * holds credentials. The last row is the relative form, read from `root`.
 */
const m1Words = (root: string): readonly string[] => {
  const at = (...parts: string[]): string => [root, ...parts].join("/");
  return [
    // (i) the substitution in a middle component, the literal tail a credential directory
    at(EMPTY, HOME_DIR),
    at(HOME_DIR, EMPTY, "approval"),
    at(HOME_DIR, "profiles", EMPTY, "p"),
    at(HOME_DIR, EMPTY, "hermes-agent"),
    at("vault-parent", EMPTY, APPROVAL_DIR),
    // (ii) the substitution glued to the directory's own name
    at([HOME_DIR, EMPTY].join("")),
    at([EMPTY, HOME_DIR].join("")),
    at(HOME_DIR, "profiles", ["p", EMPTY].join("")),
    at("vault-parent", [APPROVAL_DIR, EMPTY].join("")),
    // (iii) a glob before a last-component substitution, matching such a directory on disk
    at(HOME_DIR, ["appr", "*"].join(""), EMPTY),
    at("vault-parent", APPROVAL_DIR, ["k", "*", "s"].join(""), EMPTY),
    // (f) relative, from the directory that holds the home
    [".", EMPTY, HOME_DIR].join("/"),
  ];
};

/** The same shapes over an ordinary directory: controls. */
const m1Controls = (root: string): readonly string[] => {
  const at = (...parts: string[]): string => [root, ...parts].join("/");
  return [at(EMPTY, "notes"), at(["notes", EMPTY].join("")), at(["no", "*", "s"].join(""), EMPTY), [".", EMPTY, "notes"].join("/")];
};

/** Review-b's recursive readers: the four git readers, grep -r, rg, tar and a directory copy. */
const RECURSIVE_READERS: ReadonlyArray<(word: string) => string> = [
  ...GIT_READERS,
  (word) => ["grep", "-r", "x", word].join(" "),
  (word) => ["rg", "x", word].join(" "),
  (word) => ["tar", "-cf", "notes/out.tar", word].join(" "),
  (word) => ["cp", "-r", word, "notes/copy"].join(" "),
];

/**
 * The L11340 class proper (the substitution as the whole last component) under
 * the directories no adapter row used before: an approval home, a profile home
 * and a configured home not named `.hermes` (review-b S3).
 */
const properWords = (root: string): readonly string[] => {
  const at = (...parts: string[]): string => [root, ...parts].join("/");
  return [
    at("vault-parent", APPROVAL_DIR, printed("env")),
    at("vault-parent", APPROVAL_DIR, EMPTY),
    at(HOME_DIR, "profiles", "p", printed(ENV_FILE)),
    at(HOME_DIR, "profiles", "p", EMPTY),
    at("hh", printed(ENV_FILE)),
    at("hh", EMPTY),
  ];
};

const credentialClassOf = (command: string, cwd: string): boolean => {
  const result = classifyForHook(command, [], cwd, [], false).result;
  assert.ok(result.ok, `${command}: ${JSON.stringify(result)}`);
  return result.classes.includes("account.credential");
};

/** Run `body` with the configured home set, in this process and in every CLI child. */
function withConfiguredHome(configured: string, body: () => void): void {
  const saved = { h: process.env["HERMES_HOME"], a: process.env["APPROVAL_HERMES_HOME"] };
  process.env["HERMES_HOME"] = configured;
  delete process.env["APPROVAL_HERMES_HOME"];
  childHermesHome = configured;
  try {
    body();
  } finally {
    childHermesHome = null;
    if (saved.h === undefined) delete process.env["HERMES_HOME"];
    else process.env["HERMES_HOME"] = saved.h;
    if (saved.a !== undefined) process.env["APPROVAL_HERMES_HOME"] = saved.a;
  }
}

test("APRV-524 M1 classifyForHook with no per-call directory: a middle, glued or glob substitution before a credential directory", () => {
  const { dir } = credentialLab();
  // Every row is judged before the assertion, so a failure lists all it missed.
  const missed: string[] = [];
  const opened: string[] = [];
  for (const reader of RECURSIVE_READERS) {
    for (const word of m1Words(dir)) if (!credentialClassOf(reader(word), dir)) missed.push(reader(word));
    for (const word of m1Controls(dir)) if (credentialClassOf(reader(word), dir)) opened.push(reader(word));
  }
  assert.deepEqual(missed, []);
  assert.deepEqual(opened, [], "controls");
});

test("APRV-524 S3 classifyForHook: the whole last component under an approval home, a profile home and a configured home", () => {
  const { dir, configured } = credentialLab();
  withConfiguredHome(configured, () => {
    for (const reader of GIT_READERS) {
      for (const word of properWords(dir)) assert.ok(credentialClassOf(reader(word), dir), reader(word));
    }
  });
});

/**
 * The disk rule (a last component left unresolved, its prefix a directory that
 * holds credentials) on its own: a variable rather than a substitution, so the
 * empty reading does not apply, under directories no text rule names.
 */
test("APRV-524 S3 classifyForHook: the disk rule, an unresolved last component in a directory that holds credentials", () => {
  const { holders, plain } = credentialLab();
  const variable = ["$", "UNSET_NAME"].join("");
  const braced = ["$", "{UNSET_NAME}"].join("");
  const missed: string[] = [];
  for (const reader of GIT_READERS) {
    for (const holder of holders) {
      const rows: ReadonlyArray<[string, string]> = [
        [reader([holder, variable].join("/")), plain],
        [reader([holder, braced, "."].join("/")), plain],
        // Relative, from the holder itself.
        [reader([".", variable].join("/")), holder],
      ];
      for (const [command, cwd] of rows) if (!credentialClassOf(command, cwd)) missed.push(`${command} (cwd ${cwd})`);
    }
    assert.ok(!credentialClassOf(reader([plain, variable].join("/")), plain), `control: ${reader(plain)}`);
  }
  assert.deepEqual(missed, []);
});

const M1_ADAPTERS = ADAPTERS.filter((adapter) => adapter.name === "claude-code" || adapter.name === "hermes (workdir)");
// The readers whose only human-only class here is the credential one. An
// archive or a copy of a home is `policy.core` as well, and a hook's reason
// names one class, so tar and cp are pinned through classifyForHook above.
const M1_CLI_READERS = RECURSIVE_READERS.slice(0, 6);

for (const adapter of M1_ADAPTERS) {
  test(`APRV-524 M1 ${adapter.name}: a recursive reader of a middle, glued or glob substitution before a credential directory is account.credential`, () => {
    const { dir } = credentialLab();
    for (const reader of M1_CLI_READERS) {
      for (const word of m1Words("~")) expectVerdict(adapter, dir, dir, reader(word), "deny");
    }
    // Controls: only without a per-call directory (with one, APRV-511's
    // recursive-reader rule makes every unresolved word a credential read).
    if (!adapter.perCall) {
      for (const reader of M1_CLI_READERS) {
        for (const word of m1Controls("~")) expectVerdict(adapter, dir, dir, reader(word), "allow");
      }
    }
  });

  test(`APRV-524 S3 ${adapter.name}: the whole last component under an approval home, a profile home and a configured home`, () => {
    const { dir, configured } = credentialLab();
    withConfiguredHome(configured, () => {
      for (const reader of GIT_READERS) {
        for (const word of properWords("~")) expectVerdict(adapter, dir, dir, reader(word), "deny");
      }
    });
  });
}
