/**
 * `approval hook hermes` (APRV-398, corrected against the live probe in
 * APRV-415).
 *
 * Every envelope below was shaped from the PUBLISHED SOURCE of
 * `NousResearch/hermes-agent` and is now CONFIRMED by a live run: 60 envelopes
 * from a session on `main` at `118984d7`, reported in APRV-398's notes. What the
 * run added rather than confirmed is the third fact below, and it is the reason
 * this suite gained the refusal cases: the envelope's `cwd` is the Hermes PROCESS
 * directory, the `terminal` tool keeps a per-session recorded directory that a
 * `cd` moves, and every file tool resolves a relative path against THAT. The
 * facts that shape the adapter:
 *
 *   1. snake_case keys, and the EVENT NAMES ARE ITS OWN: `pre_tool_call` and
 *      `post_tool_call`, not `PreToolUse`. The envelope is
 *      `{hook_event_name, tool_name, tool_input, session_id, cwd, profile,
 *      extra}`, and `turn_id`/`tool_call_id` ride INSIDE `extra`.
 *   2. tools are `terminal` (with a PER-CALL `workdir`), `write_file`
 *      (`path`, `content`), `patch` (`path`, `old_string`, `new_string`),
 *      `read_file` (`path`) and `search_files` (`path`). No tool on this
 *      harness takes a LIST of paths, and there is no `glob`, `grep` or
 *      `list_files` — `search_files` is both readers behind one `target` enum.
 *   3. THE VERDICT IS EXACTLY ONE DIALECT. A block is
 *      `{"action":"block","message":…}` AT EXIT 2, because Hermes treats its
 *      blocking exit code as unconditional and takes the message from the
 *      stdout directive first. An ALLOW IS `{}`: Hermes has no allow directive,
 *      and a parser that finds no directive lets the call proceed.
 *   4. `execute_code` carries a program and no path, no argv and no workdir, and
 *      its kernel can call the other tools in-process where this hook may not
 *      see them, so it is refused before anything else looks at it.
 *   5. A CALL WHOSE DIRECTORY IS UNBOUND IS REFUSED (APRV-415): `terminal`
 *      without an absolute `workdir`, and any path tool whose `path` is relative
 *      or missing, get `hook-unsupported-execution-context` and a reason naming
 *      the retry. Observed rather than reasoned: the probe's model sent no
 *      `workdir` at all, and after each block it retried the same effect through
 *      another tool into a directory the envelope never named.
 *
 * The single-dialect assertions are not style checks and none of them may be
 * relaxed: a second key in that object is a verdict a harness may decline to
 * parse, and a declined verdict is a session that was never gated.
 *
 * EVERY PATH IN THIS FILE IS ABSOLUTE, and that is load-bearing rather than
 * tidy. A relative one would be answered by the refusal above, so a case that
 * meant to measure a class would measure the refusal instead.
 *
 * Spawn the compiled CLI; never hand-write log lines.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { classifyCommand, protectedPathClass } from "../src/core/command-class.js";
import { HARNESS_BINARY, HARNESS_KINDS } from "../src/core/harness-version.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-cli-hook-hermes-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string, input = ""): Run {
  const childEnv = { ...process.env };
  delete childEnv["APPROVAL_HUMAN"];
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: childEnv,
    input,
  });
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
  // The narrowest read scope a policy can declare: the gate root and the
  // runtime paths, and nothing else. It is what makes the out-of-scope read
  // cases below able to reach outside it at all.
  "read_scope:",
  "  roots: []",
  "classes:",
  "  read.*:",
  "    autonomy: autonomous",
  "  read.file.out_of_scope:",
  "    autonomy: human-only",
  "  files.write.workspace:",
  "    autonomy: autonomous",
  "  deps.add:",
  "    autonomy: manual",
  "  network.call:",
  "    autonomy: manual",
  "  policy.edit:",
  "    autonomy: manual",
  "  policy.core:",
  "    autonomy: manual",
  "  log.mutate:",
  "    autonomy: manual",
  "  account.credential:",
  "    autonomy: human-only",
  "```",
  "",
  "",
].join("\n");

function ready(): string {
  counter += 1;
  const dir = join(scratch, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  const attested = runCli(["policy", "attest", "--as", "human:alice"], dir);
  assert.equal(attested.code, 0, attested.stderr);
  return dir;
}

const LOG = ".approval/log/events.jsonl";

function rawLog(dir: string): string {
  const path = join(dir, LOG);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/**
 * The snake_case envelope as Hermes's own payload builder assembles it.
 *
 * `turn_id` and `tool_call_id` sit inside `extra` rather than at the top level,
 * which is where Hermes puts every kwarg it does not name explicitly. Nothing in
 * the adapter reads them; they are here so the fixture is the real shape rather
 * than a convenient one.
 */
function event(dir: string, fields: Record<string, unknown>): string {
  return JSON.stringify({
    hook_event_name: "pre_tool_call",
    session_id: "hermes-sess-1",
    tool_use_id: "tool-1",
    cwd: dir,
    profile: "default",
    extra: { turn_id: "turn-1", tool_call_id: "tool-1" },
    ...fields,
  });
}

function shellEvent(dir: string, command: string, workdir?: string): string {
  return event(dir, {
    tool_name: "terminal",
    tool_input: {
      command,
      description: "this is self-reported and must never lower scrutiny",
      ...(workdir === undefined ? {} : { workdir }),
    },
  });
}

function hook(dir: string, input: string, extra: string[] = []): Run {
  return runCli(["hook", "hermes", "--as", "agent:hermes", ...extra], dir, input);
}

interface Verdict {
  permission: "allow" | "deny";
  /** The block message, or the empty string for an allow, which carries none. */
  message: string;
}

/**
 * Read the verdict, and assert it is ONE dialect and nothing else.
 *
 * This is the assertion the whole adapter turns on, and it has two halves
 * because Hermes's two answers are different SHAPES rather than two values of
 * one field:
 *
 * - a block is exactly `{action, message}`, with `action: "block"`, at EXIT 2.
 *   Hermes treats its blocking exit code as unconditional and takes the message
 *   from the stdout directive first, so the body and the code agree by its own
 *   stated precedence rather than competing;
 * - an allow is exactly `{}` at exit 0. Hermes has NO allow directive: an empty
 *   stdout, a bare `{}` and any object naming no directive all mean the call
 *   proceeds. The reason rides on stderr because there is nowhere in the body
 *   for it.
 *
 * Neither may gain a key. An unrecognised key is a parse this harness may
 * decline, and under `fail_closed: true` a declined parse is a block while
 * without it the call runs — so a "belt and braces" verdict is a verdict whose
 * meaning depends on a setting, which is not a verdict.
 */
function verdictOf(run: Run): Verdict {
  const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
  const keys = Object.keys(parsed);
  if (keys.length === 0) {
    assert.equal(run.code, 0, `an allow is exit 0, got ${String(run.code)}: ${run.stderr}`);
    // The reason is not lost, it is moved. An operator reading a session's
    // stderr can still see what was authorized.
    assert.match(run.stderr, /approval hook hermes: allow —/u, "the allow states its reason");
    return { permission: "allow", message: "" };
  }
  assert.deepEqual(
    keys.sort(),
    ["action", "message"],
    `a Hermes block is exactly {action, message} and nothing else: ${run.stdout}`,
  );
  assert.equal(parsed["action"], "block", `never "ask", and never an invented action: ${run.stdout}`);
  assert.equal(
    run.code,
    2,
    `a Hermes deny exits 2, which blocks unconditionally; got ${String(run.code)}`,
  );
  return { permission: "deny", message: String(parsed["message"]) };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test("hermes is a known harness with its own binary name", () => {
  assert.equal((HARNESS_KINDS as readonly string[]).includes("hermes"), true);
  assert.equal(HARNESS_BINARY["hermes"], "hermes");
});

test("a hermes invocation classifies harness.launch.hermes, and a probe reads", () => {
  const launch = classifyCommand("hermes");
  assert.equal(launch.ok, true);
  if (!launch.ok) throw new Error("unreachable");
  assert.equal(launch.segments[0]?.class, "harness.launch.hermes");

  // Reading a harness's own version starts no session, so it is a read: a lane
  // must be able to find out what is installed without a prompt.
  const probe = classifyCommand("hermes --version");
  assert.equal(probe.ok, true);
  if (!probe.ok) throw new Error("unreachable");
  assert.equal(probe.segments[0]?.class, "read.shell");
});

test("the Hermes config and hook paths are gate organs, in the repo AND in the home", () => {
  // The organ that matters lives in `$HERMES_HOME`, which is the user home by
  // design: Hermes has no project-local configuration directory. The
  // classifier's segment walk is position-agnostic, so the same entry answers
  // all three spellings with no new path grammar.
  for (const path of [
    ".hermes/config.yaml",
    "/Users/someone/.hermes/config.yaml",
    "~/.hermes/config.yaml",
    ".hermes/config.yml",
    ".hermes/agent-hooks/guard.py",
    ".hermes/shell-hooks-allowlist.json",
    ".hermes/hooks.json",
    ".hermes",
  ]) {
    assert.equal(
      protectedPathClass(path, []),
      "policy.core",
      `${path} must be policy.core: an agent that could write it could write itself out of the gate`,
    );
  }
  // Session bookkeeping under the same home is ordinary content. Pricing it at a
  // human's attention is the failure mode, not the protection.
  assert.notEqual(protectedPathClass(".hermes/sessions/abc.json", []), "policy.core");
  assert.notEqual(protectedPathClass(".hermes/logs/today.log", []), "policy.core");
});

test("a write to the Hermes config is denied through the hook itself", () => {
  const dir = ready();
  // Not merely a classifier unit test: the whole path, from the envelope to the
  // verdict. `policy.core` is manual in this fixture policy, so a write to the
  // harness's own hook configuration cannot be answered autonomously.
  const shell = verdictOf(
    hook(dir, shellEvent(dir, "echo evil > .hermes/config.yaml", dir), [
      "--timeout",
      "1ms",
      "--interval",
      "1ms",
    ]),
  );
  assert.equal(shell.permission, "deny");

  // And through the file tool, which must not be the cheaper way in. Absolute,
  // so what is measured is the CLASS rather than APRV-415's unbound-directory
  // refusal.
  const write = verdictOf(
    hook(
      dir,
      event(dir, {
        tool_name: "write_file",
        tool_input: { path: join(dir, ".hermes", "config.yaml"), content: "hooks: {}\n" },
      }),
      ["--timeout", "1ms", "--interval", "1ms"],
    ),
  );
  assert.equal(write.permission, "deny");
  // The CODE is deliberately not pinned here: this second call reuses the
  // session and tool ids of the first, so it is refused at intake rather than at
  // the policy. What matters is that it is refused and that it is not refused for
  // an unbound directory, which the absolute path above rules out.
  assert.equal(write.message.includes("hook-unsupported-execution-context"), false);
});

test("the Hermes home's secrets are account.credential, not merely policy.core", () => {
  // `$HERMES_HOME` holds `.env` and `auth.json` beside the configuration. The
  // configuration is a rule and the other two are the secret, which is the same
  // split `.approval/env` has: what leaves the machine is different in kind.
  const read = classifyCommand("cat ~/.hermes/.env");
  assert.equal(read.ok, true);
  if (!read.ok) throw new Error("unreachable");
  assert.equal(read.segments[0]?.class, "account.credential");

  const auth = classifyCommand("cat /Users/someone/.hermes/auth.json");
  assert.equal(auth.ok, true);
  if (!auth.ok) throw new Error("unreachable");
  assert.equal(auth.segments[0]?.class, "account.credential");
});

test("--help prints the committable YAML with fail_closed and both timeouts", () => {
  const dir = ready();
  const help = hook(dir, "", ["--help"]);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /HERMES_HOME\/config\.yaml/u, "names the file the human commits");
  assert.match(help.stdout, /fail_closed: true/u, "and the key that makes this a gate");
  assert.match(help.stdout, /DEFAULT IS false/u, "and says the default is not that");
  // APRV-415: the key is measured now rather than documented, and the build it
  // was measured on is part of the fact. A help that said `fail_closed` blocks
  // without saying which builds honour it would be true of one install and
  // silently false of the other.
  assert.match(help.stdout, /OBSERVED on main 118984d7/u, "the observed fail-closed result");
  assert.match(help.stdout, /v0\.21\.3 \(2026\.9\.14\) fails open SILENTLY/u, "the version floor");
  assert.match(help.stdout, /--dir IS MANDATORY/u, "a gateway session's cwd is the user home");
  assert.match(
    help.stdout,
    /hook-unsupported-execution-context/u,
    "and the refusal a call with no absolute directory gets",
  );
  // The event is a KEY under `hooks:`, not an `event:` field on an entry. An
  // operator who copied another harness's shape would install nothing.
  assert.match(help.stdout, /^\s{4}pre_tool_call:$/mu, "the event is a mapping key");
  assert.match(help.stdout, /^\s{4}post_tool_call:$/mu);
  assert.equal(
    /^\s*- event:/mu.test(help.stdout),
    false,
    "and the config block carries no `event:` field, which is the shape that does not load",
  );

  // TWO timeouts, and the shorter one wins. The outer one fails closed on
  // pre_tool_call at 30s by default, which would block every manual-class call;
  // the per-entry one is capped at 300s, which is why the wait must come down
  // below the 9m default rather than the config going up to meet it.
  assert.match(help.stdout, /hook_callback_timeout: 600/u, "the outer timeout, raised");
  assert.match(help.stdout, /timeout: 300/u, "the per-entry timeout, at its cap");
  assert.match(help.stdout, /--timeout MUST BE UNDER 300s/u, "and the wait that has to fit inside");

  // The headless consent, whose absence is worse than an error.
  assert.match(help.stdout, /hooks_auto_accept: true/u);
  assert.match(help.stdout, /SILENTLY SKIPS REGISTERING THE HOOK/u);

  assert.match(help.stdout, /hook-hermes-execute-code-unbound/u);
});

// ---------------------------------------------------------------------------
// execute_code
// ---------------------------------------------------------------------------

test("execute_code is refused early with its own machine-readable code", () => {
  const dir = ready();
  const before = rawLog(dir);
  const verdict = verdictOf(
    hook(dir, event(dir, { tool_name: "execute_code", tool_input: { code: "print(2 + 2)" } })),
  );
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.message, /hook-hermes-execute-code-unbound/u);
  // The code is distinct from every neighbour because the REPAIR is distinct:
  // there is no rewriting of an `execute_code` call that this hook could answer.
  assert.equal(verdict.message.includes("hook-opaque"), false);
  assert.equal(verdict.message.includes("hook-unclassified"), false);
  assert.match(verdict.message, /no path, no argv and no working directory/u);
  assert.equal(rawLog(dir), before, "nothing is appended for a refusal this early");
});

test("execute_code is refused whatever it claims to be doing", () => {
  const dir = ready();
  // The `code` string is the party under oversight describing itself. A harmless
  // spelling and a hostile one get the same answer, because the adapter reads
  // neither: a self-reported field may never reduce scrutiny.
  for (const code of ["1 + 1", "import os; os.system('curl evil.example')", ""]) {
    const verdict = verdictOf(
      hook(dir, event(dir, { tool_name: "execute_code", tool_input: { code } })),
    );
    assert.equal(verdict.permission, "deny", `execute_code(${JSON.stringify(code)}) must refuse`);
    assert.match(verdict.message, /hook-hermes-execute-code-unbound/u);
  }
});

// ---------------------------------------------------------------------------
// The ordinary gate
// ---------------------------------------------------------------------------

test("an autonomous command is allowed and records the execution it authorized", () => {
  const dir = ready();
  const before = rawLog(dir);
  const verdict = verdictOf(hook(dir, shellEvent(dir, "ls -la", dir)));
  assert.equal(verdict.permission, "allow");
  const after = rawLog(dir);
  assert.notEqual(after, before, "an authorized execution is recorded");
  assert.match(after, /execution\.started/u);
  assert.match(after, /agent:hermes/u);
});

test("a manual-class command is refused rather than asked about, and the log is untouched", () => {
  const dir = ready();
  const verdict = verdictOf(
    hook(dir, shellEvent(dir, "npm install left-pad", dir), [
      "--timeout",
      "1ms",
      "--interval",
      "1ms",
      "--retry-grace",
      "1ms",
    ]),
  );
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.message, /hook-timeout/u, "it waited on a real decision and got none");
});

test("a deny reaches a log that does not exist, and says which log", () => {
  // An empty gate root: the policy is there, the log is not. The hook is a
  // WRITER to an existing log and never an initializer, because a log scaffolded
  // where a process happens to stand forks a chain off the real one's tail.
  counter += 1;
  const dir = join(scratch, `nolog-${counter}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), POLICY, "utf8");
  const verdict = verdictOf(hook(dir, shellEvent(dir, "npm install left-pad", dir)));
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.message, /hook-policy-unavailable|hook-log-unreachable/u);
});

test("an unclassifiable command fails closed", () => {
  const dir = ready();
  const verdict = verdictOf(hook(dir, shellEvent(dir, "frobnicate --wibble", dir)));
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.message, /hook-unclassified/u);
});

test("unparseable stdin is a deny in the one supported dialect", () => {
  const dir = ready();
  const verdict = verdictOf(hook(dir, "{not json at all"));
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.message, /hook-io/u);
});

test("empty stdin is a deny rather than a crash", () => {
  const dir = ready();
  const verdict = verdictOf(hook(dir, ""));
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.message, /hook-io/u);
});

test("an event naming no tool at all is a deny", () => {
  const dir = ready();
  const verdict = verdictOf(hook(dir, JSON.stringify({ hook_event_name: "pre_tool_call" })));
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.message, /hook-io/u);
});

// ---------------------------------------------------------------------------
// The per-call working directory
// ---------------------------------------------------------------------------

test("terminal is classified against its PER-CALL workdir, not the session root", () => {
  const dir = ready();
  const nested = join(dir, "sub");
  mkdirSync(nested, { recursive: true });

  // The same relative command in two directories. Against the session root it
  // touches the live APPROVAL.md; against the per-call workdir it touches
  // `sub/APPROVAL.md`, a file NAMED like a policy file. Both are protected, so
  // both deny — what this pins is that the workdir is READ AT ALL and reaches
  // the classifier.
  const atRoot = verdictOf(
    hook(dir, shellEvent(dir, "echo x > APPROVAL.md", dir), ["--timeout", "1ms", "--interval", "1ms"]),
  );
  assert.equal(atRoot.permission, "deny");
  assert.match(atRoot.message, /policy\.core|policy\.edit/u);

  // A workdir the harness supplies but which is NOT absolute is refused rather
  // than fallen back from (APRV-415). The fallback was the right answer on Muse,
  // where the envelope `cwd` IS the session root; here the envelope `cwd` is the
  // Hermes process directory and the session's own is reported nowhere, so there
  // is no directory to fall back TO.
  const relative = verdictOf(
    hook(dir, shellEvent(dir, "echo x > APPROVAL.md", "sub"), ["--timeout", "1ms", "--interval", "1ms"]),
  );
  assert.equal(relative.permission, "deny", "a relative workdir is refused, not narrowed");
  assert.match(relative.message, /hook-unsupported-execution-context/u);
});

// ---------------------------------------------------------------------------
// The unbound directory (APRV-415)
// ---------------------------------------------------------------------------

const UNBOUND = /hook-unsupported-execution-context/u;

test("terminal with NO workdir is refused, and the reason names the retry", () => {
  const dir = ready();
  const before = rawLog(dir);
  // The shape the live probe actually captured: the model asked for `ls -la` and
  // sent `command` and nothing else. The directory that command would have run
  // in is the per-session recorded one, which no field of the event carries — the
  // envelope `cwd` is the Hermes PROCESS directory — so there is nothing for a
  // verdict to bind.
  const verdict = verdictOf(hook(dir, shellEvent(dir, "ls -la")));
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.message, UNBOUND);
  assert.match(verdict.message, /workdir/u);
  assert.match(verdict.message, /absolute/u, "a refusal that does not name the repair earns the retry");
  assert.equal(rawLog(dir), before, "nothing is appended for a refusal this early");
});

test("an autonomous command is refused for its directory before its class is read", () => {
  const dir = ready();
  // `ls -la` is autonomous under this policy WITH a workdir (the allow case
  // above). Without one it is refused, which is the ordering that matters: the
  // directory is a precondition for classifying at all, not a detail the policy
  // could excuse. A policy cannot widen this and neither can an open window.
  const withWorkdir = verdictOf(hook(dir, shellEvent(dir, "ls -la", dir)));
  assert.equal(withWorkdir.permission, "allow");
  const without = verdictOf(hook(dir, shellEvent(dir, "ls -la")));
  assert.equal(without.permission, "deny");
  assert.match(without.message, UNBOUND);
});

test("every path tool is refused for a RELATIVE path, in the same words", () => {
  const dir = ready();
  const calls: Record<string, unknown>[] = [
    { tool_name: "write_file", tool_input: { path: "probe.txt", content: "hello\n" } },
    { tool_name: "patch", tool_input: { path: "src/widget.py", old_string: "a", new_string: "b" } },
    { tool_name: "read_file", tool_input: { path: "README.md", limit: 5 } },
    { tool_name: "search_files", tool_input: { pattern: "needle", target: "content", path: "src" } },
  ];
  for (const call of calls) {
    const before = rawLog(dir);
    const verdict = verdictOf(hook(dir, event(dir, call)));
    assert.equal(
      verdict.permission,
      "deny",
      `${String(call["tool_name"])} with a relative path must be refused`,
    );
    assert.match(verdict.message, UNBOUND);
    assert.match(verdict.message, /relative/u);
    assert.match(verdict.message, /absolute path/u, "the retry is named");
    assert.equal(rawLog(dir), before, "a refusal this early appends nothing");
  }
});

test("a path tool naming no path at all is refused too", () => {
  const dir = ready();
  // `write_file` always names one in practice; the case is here because the
  // ANSWER must not depend on which key was omitted. An unnamed target resolves
  // against the same unreported directory a relative one does.
  const verdict = verdictOf(
    hook(dir, event(dir, { tool_name: "read_file", tool_input: { limit: 5 } })),
  );
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.message, UNBOUND);
});

test("a relative entry in a future `paths` ARRAY is refused with the rest", () => {
  const dir = ready();
  // No Hermes tool sends a list today. If one does, an unbound entry must not
  // arrive as a bound call: the refusal reads the array the same way the read
  // gate does.
  const verdict = verdictOf(
    hook(
      dir,
      event(dir, {
        tool_name: "search_files",
        tool_input: { pattern: "needle", paths: [dir, "src"] },
      }),
    ),
  );
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.message, UNBOUND);
});

test("the refusal precedes the policy and the log entirely", () => {
  // No APPROVAL.md and no log: a classified call in this directory answers
  // `hook-policy-unavailable`. The unbound-directory refusal answers FIRST,
  // which is the placement the Codex `Bash` refusal has and for its reason —
  // nothing below it can supply a fact the call does not carry, and a repo
  // whose policy is missing must not change what this call is told to do.
  counter += 1;
  const dir = join(scratch, `unbound-nopolicy-${counter}`);
  mkdirSync(dir, { recursive: true });
  const verdict = verdictOf(
    hook(dir, event(dir, { tool_name: "write_file", tool_input: { path: "probe.txt", content: "x" } })),
  );
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.message, UNBOUND);
  assert.equal(
    verdict.message.includes("hook-policy-unavailable"),
    false,
    "the directory is decided before the policy is even looked for",
  );
});

test("execute_code keeps its OWN code, which is checked before the directory", () => {
  const dir = ready();
  // Both refusals would fire on this call: it carries no path and no workdir.
  // The `execute_code` one wins because the REPAIRS differ — one says send an
  // absolute path, the other says there is no spelling of this call that would
  // be answered — and a session told the wrong repair retries forever.
  const verdict = verdictOf(
    hook(dir, event(dir, { tool_name: "execute_code", tool_input: { code: "print(2 + 2)" } })),
  );
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.message, /hook-hermes-execute-code-unbound/u);
  assert.equal(verdict.message.includes("hook-unsupported-execution-context"), false);
});

test("a POST event with a relative path is a report, not a refusal", () => {
  const dir = ready();
  // The post half answers a call that has already run, so there is nothing left
  // to bind and nothing to refuse. It prints no verdict, at exit 0, exactly as
  // every other post event on this harness does.
  const run = hook(
    dir,
    event(dir, {
      hook_event_name: "post_tool_call",
      tool_name: "write_file",
      tool_input: { path: "probe.txt", content: "x" },
      tool_response: { exit_code: 0 },
    }),
  );
  assert.equal(run.stdout, "", "a post event never carries a verdict, refusal or otherwise");
  assert.equal(run.code, 0);
});

test("a tool this adapter does not gate is not refused for its directory", () => {
  const dir = ready();
  // The refusal covers the shell tool, the file tools and the read tools, which
  // is the set a verdict could bind. An unknown tool takes the path it took
  // before, because denying every tool a later release adds would break a
  // session on an upgrade.
  const verdict = verdictOf(
    hook(dir, event(dir, { tool_name: "some_future_tool", tool_input: { path: "wherever" } })),
  );
  assert.equal(verdict.permission, "allow");
});

// ---------------------------------------------------------------------------
// File and read tools
// ---------------------------------------------------------------------------

test("write_file with an ABSOLUTE path is classified by the path it names", () => {
  const dir = ready();
  const verdict = verdictOf(
    hook(
      dir,
      event(dir, {
        tool_name: "write_file",
        tool_input: { path: join(dir, "probe.txt"), content: "hello\n" },
      }),
    ),
  );
  assert.equal(verdict.permission, "allow", "an ordinary workspace write");

  // The same tool aimed at the policy file is policy.core, not a workspace
  // write: editing through a file tool must not be cheaper than editing through
  // a shell redirect.
  const protectedWrite = verdictOf(
    hook(
      dir,
      event(dir, {
        tool_name: "write_file",
        tool_input: { path: join(dir, "APPROVAL.md"), content: "x" },
      }),
      ["--timeout", "1ms", "--interval", "1ms"],
    ),
  );
  assert.equal(protectedWrite.permission, "deny");
});

test("patch is gated by the path it names, with its before and after bound", () => {
  const dir = ready();
  const verdict = verdictOf(
    hook(
      dir,
      event(dir, {
        tool_name: "patch",
        tool_input: {
          mode: "str_replace",
          path: join(dir, "src", "widget.py"),
          old_string: "DUMMY = 0",
          new_string: "DUMMY = 1",
          replace_all: false,
        },
      }),
    ),
  );
  assert.equal(verdict.permission, "allow", "an ordinary workspace edit");

  const protectedPatch = verdictOf(
    hook(
      dir,
      event(dir, {
        tool_name: "patch",
        tool_input: {
          path: join(dir, "APPROVAL.md"),
          old_string: "manual",
          new_string: "autonomous",
        },
      }),
      ["--timeout", "1ms", "--interval", "1ms"],
    ),
  );
  assert.equal(protectedPatch.permission, "deny", "the policy file is not editable through patch");
});

test("read_file inside the workspace is allowed and writes nothing", () => {
  const dir = ready();
  const before = rawLog(dir);
  const verdict = verdictOf(
    hook(
      dir,
      event(dir, { tool_name: "read_file", tool_input: { path: join(dir, "README.md"), limit: 5 } }),
    ),
  );
  assert.equal(verdict.permission, "allow");
  assert.equal(rawLog(dir), before, "an in-scope read is not a gated question");
});

test("read_file outside the read scope is gated, and human-only in this policy", () => {
  const dir = ready();
  const verdict = verdictOf(
    hook(dir, event(dir, { tool_name: "read_file", tool_input: { path: "/etc/hosts" } })),
  );
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.message, /read-scope|out_of_scope|human-only/u);
});

test("search_files is scoped by the ONE path it names, in both directions", () => {
  const dir = ready();
  // `search_files` is both of the readers another harness would ship as two: its
  // `target` enum selects a grep or a name search, and either way the directory
  // is one `path`. No tool on this harness names a list.
  const inside = verdictOf(
    hook(
      dir,
      event(dir, {
        tool_name: "search_files",
        tool_input: { pattern: "needle", target: "content", path: dir, output_mode: "content" },
      }),
    ),
  );
  assert.equal(inside.permission, "allow");

  const outside = verdictOf(
    hook(
      dir,
      event(dir, {
        tool_name: "search_files",
        tool_input: { pattern: "secret", target: "content", path: "/etc" },
      }),
    ),
  );
  assert.equal(outside.permission, "deny", "read.file.out_of_scope is human-only in this policy");
});

test("a read naming NO path is refused on this harness, not allowed (APRV-415)", () => {
  const dir = ready();
  // The reverse of the answer every other harness gives, and the reason is a
  // measured fact rather than a preference. Claude Code's `Glob` with no path
  // defaults to the workspace, which is inside the gate root by construction, so
  // the pass-through allow is honest there. Hermes defaults to the per-session
  // recorded directory instead: the probe watched one session's writes land in
  // `$HERMES_HOME/cache/scratch` and a gateway session's in the user's home. An
  // unnamed target here is therefore an unbounded read, not a workspace read.
  const verdict = verdictOf(
    hook(dir, event(dir, { tool_name: "search_files", tool_input: { pattern: "needle", target: "files" } })),
  );
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.message, /hook-unsupported-execution-context/u);
  assert.match(verdict.message, /names no path at all/u);
  assert.match(verdict.message, /absolute/u, "the refusal names the retry");
});

test("a read outside the scope that does not exist is still outside it", () => {
  const dir = ready();
  // Fail closed: a target nothing on this disk can place is a target nothing can
  // say is inside the scope, so non-existence is not a way out of the jail. The
  // path below cannot be realpath'd and resolves lexically outside every root.
  const verdict = verdictOf(
    hook(
      dir,
      event(dir, {
        tool_name: "read_file",
        tool_input: { path: "/nonexistent-root-aprv398/secrets/id_rsa" },
      }),
    ),
  );
  assert.equal(verdict.permission, "deny");
});

test("a read that escapes the root with .. is resolved before it is judged", () => {
  const dir = ready();
  // The RESOLVED path is the fact, not the spelling. A harness-supplied
  // `<root>/../<sibling>` must not be able to describe itself as in scope. The
  // spelling is ABSOLUTE and still escapes, which is what keeps this case about
  // resolution rather than about APRV-415's refusal of a relative path.
  const verdict = verdictOf(
    hook(
      dir,
      event(dir, {
        tool_name: "read_file",
        tool_input: { path: join(dir, "..", "..", "..", "..", "etc", "hosts") },
      }),
    ),
  );
  assert.equal(verdict.permission, "deny");
  assert.equal(
    verdict.message.includes("hook-unsupported-execution-context"),
    false,
    "an absolute path is placed and judged, not refused for being unplaceable",
  );
});

test("a tool this adapter does not know is answered, not gated", () => {
  const dir = ready();
  // An unknown tool takes the path it took before this adapter existed. That is
  // stated rather than assumed, because the alternative — denying every tool
  // Hermes adds in a later release — would break a session on an upgrade.
  const verdict = verdictOf(
    hook(dir, event(dir, { tool_name: "some_future_tool", tool_input: { whatever: true } })),
  );
  assert.equal(verdict.permission, "allow");
  assert.match(verdict.message, /^$/u);
});

// ---------------------------------------------------------------------------
// Post events
// ---------------------------------------------------------------------------

test("a post_tool_call event prints NO verdict on stdout, at exit 0", () => {
  const dir = ready();
  const run = hook(
    dir,
    event(dir, {
      hook_event_name: "post_tool_call",
      tool_name: "terminal",
      tool_input: { command: "ls", workdir: dir },
      tool_response: { exit_code: 0 },
    }),
  );
  assert.equal(run.stdout, "", "no verdict is ever printed on a post event");
  // Exit 2 is Hermes's BLOCKING code. A visibility exit here would be a block
  // aimed at a call that has already run, so the post half always exits 0 and
  // the diagnostic goes to stderr.
  assert.equal(run.code, 0, `a post event always exits 0 on Hermes, got ${String(run.code)}`);
  assert.match(run.stderr, /"hook":"post-tool-use"/u, "the diagnostic goes to stderr");
});

test("the post event closes a real outcome, and a non-zero exit_code is a FAILURE", () => {
  const dir = ready();
  const started = verdictOf(hook(dir, shellEvent(dir, "ls -la", dir)));
  assert.equal(started.permission, "allow");

  const run = hook(
    dir,
    event(dir, {
      hook_event_name: "post_tool_call",
      tool_name: "terminal",
      tool_input: { command: "ls -la", workdir: dir },
      tool_response: { exit_code: 1 },
    }),
  );
  assert.equal(run.stdout, "");
  assert.match(rawLog(dir), /"event":"execution\.failed"/u);
  assert.match(rawLog(dir), /"reported_by":"post-tool-use"/u);
});

test("an interrupted post event is unreadable rather than assumed either way", () => {
  const dir = ready();
  verdictOf(hook(dir, shellEvent(dir, "sleep 1", dir)));
  const run = hook(
    dir,
    event(dir, {
      hook_event_name: "post_tool_call",
      tool_name: "terminal",
      tool_input: { command: "sleep 1", workdir: dir },
      tool_response: { interrupted: true },
    }),
  );
  // A command a person interrupted neither completed nor failed on its own
  // terms: appending either would manufacture a fact nobody observed.
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /post-tool-unreadable-outcome/u);
  assert.equal(rawLog(dir).includes('"outcome":"failed"'), false);
});

test("Claude Code's event names are NOT this harness's, and take the pre path", () => {
  const dir = ready();
  // `PostToolUse` is not a Hermes event. The strict reading of an event name
  // this adapter does not recognise is that a command is about to run, so it
  // takes the PRE path and is answered with a verdict — rather than being
  // silently treated as a report about something that already happened.
  const run = hook(
    dir,
    event(dir, {
      hook_event_name: "PostToolUse",
      tool_name: "terminal",
      tool_input: { command: "ls", workdir: dir },
      tool_response: { exit_code: 0 },
    }),
  );
  const verdict = verdictOf(run);
  assert.equal(verdict.permission, "allow", "an unknown event name is a call about to run");
  assert.match(rawLog(dir), /execution\.started/u);
});
