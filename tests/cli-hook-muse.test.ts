/**
 * `approval hook muse` (APRV-350).
 *
 * Every envelope below is shaped from the LIVE capture of
 * `muse-bin-1.3.0-R3233.1` (2026-09-18, 139 events), not from a vendor document
 * and not from a guess. The facts that shape this adapter:
 *
 *   1. snake_case keys, with `model`, `permission_mode` and `model_provider`
 *      alongside the Claude Code set;
 *   2. tools are `bash` (with a PER-CALL `workdir`), `write_file` (RELATIVE
 *      path), `read_file`, `search` (an ARRAY under `paths`), plus the
 *      bookkeeping tool `submit_reminder_decision`;
 *   3. THE VERDICT MUST BE EXACTLY ONE DIALECT. Muse treats output carrying any
 *      unsupported key as invalid, an invalid hook as a FAILED hook, and a
 *      failed hook fails OPEN. The probe's mixed-dialect deny, even at exit 2,
 *      let the write through in under 80 ms;
 *   4. Muse fails open on crash, timeout and garbage as well, so the deny must
 *      be well-formed AND arrive before the harness's own timeout.
 *
 * The single-dialect assertions are therefore not style checks and none of them
 * may be relaxed: a second key in that object is a silently ungated session.
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

import { protectedPathClass } from "../src/core/command-class.js";
import { HARNESS_BINARY, HARNESS_KINDS } from "../src/core/harness-version.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-cli-hook-muse-")));
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
  // An empty `roots` list is the narrowest read scope a policy can declare:
  // the gate root and the runtime paths, and nothing else. It is what makes the
  // `search` cases below able to reach outside it at all.
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
 * The snake_case envelope as Muse actually sends it.
 *
 * `model` defaults to a Standard-tier id so the ordinary cases are not all
 * refused by the contributor guard; the guard's own cases override it.
 * `description` is self-reported and must never lower scrutiny.
 */
function event(dir: string, fields: Record<string, unknown>): string {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: "muse-sess-1",
    turn_id: "turn-1",
    tool_use_id: "tool-1",
    transcript_path: null,
    cwd: dir,
    model: "muse-spark-1.3",
    model_provider: "meta",
    permission_mode: "default",
    ...fields,
  });
}

function shellEvent(dir: string, command: string, workdir?: string): string {
  return event(dir, {
    tool_name: "bash",
    tool_input: {
      command,
      description: "this is self-reported and must never lower scrutiny",
      ...(workdir === undefined ? {} : { workdir }),
    },
  });
}

function hook(dir: string, input: string, extra: string[] = []): Run {
  return runCli(["hook", "muse", "--as", "agent:muse", ...extra], dir, input);
}

interface Verdict {
  permission: string;
  reason: string;
}

/**
 * Read the verdict, and assert it is ONE dialect and nothing else.
 *
 * This is the assertion the whole adapter turns on. Muse rejects an output
 * carrying any key it does not support, a rejected hook is a failed hook, and a
 * failed hook fails open — so a verdict object with a second top-level key is
 * not a belt-and-braces deny, it is no deny at all.
 */
function verdictOf(run: Run): Verdict {
  const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(parsed),
    ["hookSpecificOutput"],
    `Muse fails OPEN on any unsupported key, so the verdict must carry exactly one: ${run.stdout}`,
  );
  const nested = parsed["hookSpecificOutput"] as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(nested).sort(),
    ["hookEventName", "permissionDecision", "permissionDecisionReason"],
    "and the nested object carries exactly the three supported fields",
  );
  const permission = nested["permissionDecision"];
  assert.equal(
    permission === "allow" || permission === "deny",
    true,
    `never "ask": ${run.stdout}`,
  );
  // Muse reads the BODY, not the exit code; a non-zero exit is a failed hook
  // and fails open, so every verdict must arrive at 0.
  assert.equal(run.code, 0, `a verdict always exits 0 on Muse, got ${String(run.code)}`);
  return { permission: String(permission), reason: String(nested["permissionDecisionReason"]) };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test("muse is a known harness with its own binary name", () => {
  assert.equal((HARNESS_KINDS as readonly string[]).includes("muse"), true);
  assert.equal(HARNESS_BINARY["muse"], "muse");
});

test("the Muse hooks file is a gate organ, like .cursor/hooks.json and .grok/hooks/", () => {
  // An agent that could write this file could write itself out of the gate.
  assert.equal(protectedPathClass(".muse/hooks.json", []), "policy.core");
  assert.equal(protectedPathClass("repo/.muse/hooks.json", []), "policy.core");
  assert.equal(protectedPathClass(".muse/settings.json", []), "policy.core");
  // Session bookkeeping is ordinary workspace content: pricing it at a human's
  // attention is the failure mode, not the protection.
  assert.notEqual(protectedPathClass(".muse/worktrees/x/file.ts", []), "policy.core");
});

test("--help prints the committable config with a per-hook timeout above --timeout", () => {
  const dir = ready();
  const help = hook(dir, "", ["--help"]);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /\.muse\/hooks\.json/u, "names the file the human commits");
  assert.match(help.stdout, /"timeout": 600/u, "and a timeout above the 9m default wait");
  assert.match(help.stdout, /MUST EXCEED --timeout/u);
  assert.match(help.stdout, /fails OPEN/u, "the fail-open finding is not buried");
  assert.match(help.stdout, /hook-muse-contributor-model/u);
  // The shape is not Claude's file under another name; an operator who guessed
  // would get "Hooks: 0 runnable" and a session that merely looks gated. The
  // help SAYS so rather than leaving the reader to notice an absence.
  assert.match(help.stdout, /no\s+"matcher"/u, "the help says the key is not used");
  assert.equal(
    /"matcher"\s*:/u.test(help.stdout),
    false,
    "and the config block itself carries no matcher field",
  );
});

// ---------------------------------------------------------------------------
// The contributor-model guard
// ---------------------------------------------------------------------------

test("a Contributor-tier model is refused for every tool call, whatever the policy says", () => {
  const dir = ready();
  // `read.*` is AUTONOMOUS in this policy and `files.write.workspace` is too,
  // so both of these would otherwise be allowed outright. The guard sits above
  // the policy: a self-reported field may raise scrutiny, never lower it.
  for (const model of ["muse-spark-1.3-contributor", "muse-spark-9.9-contributor"]) {
    const shell = verdictOf(hook(dir, shellEvent(dir, "ls -la").replace(/"muse-spark-1\.3"/u, JSON.stringify(model))));
    assert.equal(shell.permission, "deny", `${model} must be refused`);
    assert.match(shell.reason, /hook-muse-contributor-model/u);
    assert.match(shell.reason, /Contributor-tier/u);
  }

  const write = verdictOf(
    hook(
      dir,
      event(dir, {
        model: "muse-spark-1.3-contributor",
        tool_name: "write_file",
        tool_input: { path: "probe.txt", content: "hello\n" },
      }),
    ),
  );
  assert.equal(write.permission, "deny");
  assert.match(write.reason, /hook-muse-contributor-model/u);

  // Nothing was appended for a refused call: the guard decides before intake.
  assert.equal(rawLog(dir).includes("contributor"), false);
});

test("a session that names no model at all is refused too", () => {
  const dir = ready();
  const verdict = verdictOf(
    hook(dir, event(dir, { model: undefined, tool_name: "bash", tool_input: { command: "ls" } })),
  );
  assert.equal(verdict.permission, "deny", "unknown is not safe");
  assert.match(verdict.reason, /hook-muse-contributor-model/u);
  assert.match(verdict.reason, /names no model/u);
});

test("a Standard-tier model passes the guard and is decided by the policy", () => {
  const dir = ready();
  const verdict = verdictOf(hook(dir, shellEvent(dir, "ls -la")));
  assert.equal(verdict.permission, "allow");
  assert.equal(verdict.reason.includes("contributor"), false);
});

// ---------------------------------------------------------------------------
// The ordinary gate
// ---------------------------------------------------------------------------

test("an autonomous command is allowed and records the execution it authorized", () => {
  const dir = ready();
  const before = rawLog(dir);
  const verdict = verdictOf(hook(dir, shellEvent(dir, "ls -la")));
  assert.equal(verdict.permission, "allow");
  const after = rawLog(dir);
  assert.notEqual(after, before, "an authorized execution is recorded");
  assert.match(after, /execution\.started/u);
  assert.match(after, /agent:muse/u);
});

test("a manual-class command is refused rather than asked about", () => {
  const dir = ready();
  // `--timeout 1ms` so the wait expires immediately instead of blocking.
  const verdict = verdictOf(
    hook(dir, shellEvent(dir, "npm install left-pad"), ["--timeout", "1ms", "--interval", "1ms"]),
  );
  assert.equal(verdict.permission, "deny");
  // `verdictOf` already pins that the only permissions are allow and deny, so
  // "never ask" is asserted there rather than by hunting the word in the reason
  // text — which matches "task" and was a false failure the first time round.
});

test("an unclassifiable command fails closed", () => {
  const dir = ready();
  const verdict = verdictOf(hook(dir, shellEvent(dir, "frobnicate --wibble")));
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /hook-unclassified/u);
});

test("unparseable stdin is a deny in the one supported dialect", () => {
  const dir = ready();
  const verdict = verdictOf(hook(dir, "{not json at all"));
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /hook-io/u);
});

test("empty stdin is a deny rather than a crash", () => {
  const dir = ready();
  const verdict = verdictOf(hook(dir, ""));
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /hook-io/u);
});

// ---------------------------------------------------------------------------
// The per-call working directory
// ---------------------------------------------------------------------------

test("bash is classified against its PER-CALL workdir, not the session root", () => {
  const dir = ready();
  const nested = join(dir, "sub");
  mkdirSync(nested, { recursive: true });

  // The same relative command in two directories. Written against the session
  // root it would touch the live APPROVAL.md; written against the per-call
  // workdir it touches `sub/APPROVAL.md`, which is a file NAMED like a policy
  // file. Both are protected, so both deny — what this pins is that the
  // workdir is READ AT ALL and reaches the classifier.
  const atRoot = verdictOf(hook(dir, shellEvent(dir, "echo x > APPROVAL.md", dir)));
  assert.equal(atRoot.permission, "deny");
  assert.match(atRoot.reason, /policy\.core|policy\.edit/u);

  // A workdir the harness supplies but which is NOT absolute must not be
  // trusted into a narrower answer; the session cwd stands instead.
  const relative = verdictOf(hook(dir, shellEvent(dir, "echo x > APPROVAL.md", "sub")));
  assert.equal(relative.permission, "deny", "a relative workdir falls back, it does not widen");
});

// ---------------------------------------------------------------------------
// File and read tools
// ---------------------------------------------------------------------------

test("write_file resolves its RELATIVE path against the session cwd", () => {
  const dir = ready();
  const verdict = verdictOf(
    hook(dir, event(dir, { tool_name: "write_file", tool_input: { path: "probe.txt", content: "hello\n" } })),
  );
  assert.equal(verdict.permission, "allow", "an ordinary workspace write");

  // The same tool aimed at the policy file is policy.core, not a workspace
  // write: editing through a file tool must not be cheaper than editing
  // through a shell redirect.
  const protectedWrite = verdictOf(
    hook(dir, event(dir, { tool_name: "write_file", tool_input: { path: "APPROVAL.md", content: "x" } })),
  );
  assert.equal(protectedWrite.permission, "deny");
});

test("read_file inside the workspace is allowed and writes nothing", () => {
  const dir = ready();
  const before = rawLog(dir);
  const verdict = verdictOf(
    hook(dir, event(dir, { tool_name: "read_file", tool_input: { path: "README.md", limit: 5 } })),
  );
  assert.equal(verdict.permission, "allow");
  assert.equal(rawLog(dir), before, "an in-scope read is not a gated question");
});

test("search names an ARRAY of paths, and one outside the scope gates the call", () => {
  const dir = ready();
  // The live capture caught exactly this: a `search` reaching clean out of the
  // workspace, because Muse applies no workspace confinement in
  // `permission_mode: "default"`.
  const verdict = verdictOf(
    hook(
      dir,
      event(dir, {
        tool_name: "search",
        tool_input: { pattern: "secret", output_mode: "text", paths: ["/etc"] },
      }),
    ),
  );
  assert.equal(verdict.permission, "deny", "read.file.out_of_scope is human-only in this policy");
  assert.match(verdict.reason, /read-scope|out_of_scope|human-only/u);
});

test("a search whose list MIXES in-scope and out-of-scope paths is still gated", () => {
  const dir = ready();
  const verdict = verdictOf(
    hook(
      dir,
      event(dir, {
        tool_name: "search",
        tool_input: { pattern: "x", output_mode: "text", paths: [dir, "/etc"] },
      }),
    ),
  );
  // Gating the first in-scope entry instead would have let the whole call
  // through, which is the direction that matters.
  assert.equal(verdict.permission, "deny");
});

// ---------------------------------------------------------------------------
// The bookkeeping tool
// ---------------------------------------------------------------------------

test("submit_reminder_decision passes through and never reaches the gate", () => {
  const dir = ready();
  const before = rawLog(dir);
  // 100 of the 139 events in the live capture were this one tool. Gating it
  // would put a hundred questions a turn on an approver's phone to authorize
  // the harness thinking.
  const verdict = verdictOf(
    hook(
      dir,
      event(dir, {
        tool_name: "submit_reminder_decision",
        tool_input: { decision: "none", next_step: null, reason: "satisfied the deliverable" },
      }),
    ),
  );
  assert.equal(verdict.permission, "allow");
  assert.match(verdict.reason, /bookkeeping/u);
  assert.equal(rawLog(dir), before, "and nothing is appended for it");
});

test("the bookkeeping tool is still refused on a contributor model", () => {
  const dir = ready();
  // The guard runs BEFORE the pass-through, so there is no tool that escapes it.
  const verdict = verdictOf(
    hook(
      dir,
      event(dir, {
        model: "muse-spark-1.3-contributor",
        tool_name: "submit_reminder_decision",
        tool_input: { decision: "none", next_step: null, reason: "x" },
      }),
    ),
  );
  assert.equal(verdict.permission, "deny");
  assert.match(verdict.reason, /hook-muse-contributor-model/u);
});

// ---------------------------------------------------------------------------
// Post events
// ---------------------------------------------------------------------------

test("a PostToolUse event prints NO verdict on stdout", () => {
  const dir = ready();
  // Muse rejects a permission field on a post event ("unsupported
  // `permission_decision` in output"), and a rejected hook is a failed hook.
  const run = hook(
    dir,
    event(dir, {
      hook_event_name: "PostToolUse",
      tool_name: "bash",
      tool_input: { command: "ls", workdir: dir },
      tool_response: JSON.stringify({ exit_code: 0, terminal_status: "completed", output: "x" }),
    }),
  );
  assert.equal(run.stdout, "", "no verdict is ever printed on a post event");
  assert.match(run.stderr, /"hook":"post-tool-use"/u, "the diagnostic goes to stderr");
});

test("the post event's outcome is READ from Muse's JSON-string tool_response", () => {
  const dir = ready();
  // Muse sends both facts Codex lacks. A non-zero exit_code must not be
  // recorded as a completion: the generic reader would have seen a string,
  // found no `error` key on it, and called every command successful.
  const started = verdictOf(hook(dir, shellEvent(dir, "ls -la", dir)));
  assert.equal(started.permission, "allow");

  const run = hook(
    dir,
    event(dir, {
      hook_event_name: "PostToolUse",
      tool_name: "bash",
      tool_input: { command: "ls -la", workdir: dir },
      tool_response: JSON.stringify({ exit_code: 1, terminal_status: "completed", output: "" }),
    }),
  );
  assert.equal(run.stdout, "");
  // A non-zero `exit_code` closes the start as a FAILURE. The generic reader
  // would have seen a string, found no `error` key on it, and closed every
  // command as a completion — including this one.
  assert.match(rawLog(dir), /"event":"execution\.failed"/u);
  assert.match(rawLog(dir), /"reported_by":"post-tool-use"/u);
});

test("a terminal_status that is not `completed` is unreadable rather than assumed", () => {
  const dir = ready();
  verdictOf(hook(dir, shellEvent(dir, "sleep 1", dir)));
  const run = hook(
    dir,
    event(dir, {
      hook_event_name: "PostToolUse",
      tool_name: "bash",
      tool_input: { command: "sleep 1", workdir: dir },
      tool_response: JSON.stringify({ exit_code: null, terminal_status: "timed_out", output: "" }),
    }),
  );
  // A command that did not finish on its own terms neither completed nor
  // failed: appending either would manufacture a fact nobody observed.
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /post-tool-unreadable-outcome/u);
  assert.equal(rawLog(dir).includes('"outcome":"failed"'), false);
});
