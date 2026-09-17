/**
 * APRV-325.3: the confined Codex session, and the proof that only a brokered
 * change reaches the canonical workspace.
 *
 * ## What makes this suite evidence rather than decoration
 *
 * Every confinement case is a PAIR. The same script runs twice — once
 * unconfined, where it MUST succeed, and once inside the session, where it must
 * fail with a permission error and leave no trace. A suite asserting only the
 * failure would pass against a script that was broken, a path that did not
 * exist, or a machine where nothing could have worked; the control is the half
 * that makes the other half mean something.
 *
 * The end-to-end case is the same shape at the level the task is about: the
 * confined shell tries to change the canonical workspace and cannot, then the
 * broker applies one approved change and the workspace holds exactly that and
 * nothing else.
 *
 * ## Where it stands down
 *
 * On a host with no sandbox mechanism (anything but macOS in this build) the
 * spawning cases skip with the probe's own reason, and the pure cases — the
 * profile text, the refusal table, the environment, the broker legs — run
 * everywhere. A skip is recorded as a skip; nothing here reports an unrun case
 * as a passing one.
 */

import assert from "node:assert/strict";
/**
 * `spawnSync` here is for the CONTROL legs only — the half of each pair that
 * runs OUTSIDE the session and must succeed. Every confined leg goes through
 * {@link runConfined}, and the asymmetry is the evidence.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

import { applyWorkspaceChange, type BrokerInstallation } from "../src/codex/broker.js";
import {
  CONFINED_ENV_ALLOW,
  CONFINE_REFUSAL_CODES,
  DEFAULT_CONFINED_TIMEOUT_MS,
  planConfinedSession,
  runConfined,
  type ConfineRefusal,
  type ConfinedSession,
} from "../src/codex/runner.js";
import {
  credentialPathsFor,
  detectSandbox,
  seatbeltProfile,
  type SandboxDetection,
} from "../src/core/sandbox.js";
import { verify } from "../src/core/verify.js";
import { appendAttestation } from "./clock-adapters.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-codex-confine-")));
let serial = 0;

after(() => rmSync(scratch, { recursive: true, force: true }));

const FOUND: SandboxDetection = detectSandbox();
const SKIP = FOUND.available ? false : `no sandbox primitive here: ${FOUND.reason}`;

const T0 = "2026-09-16T10:00:00.000Z";
const CLOCK = (): string => T0;

/** A secret that exists only inside this suite. */
const TOKEN = "aprv3253-not-a-real-telegram-token";

const POLICY = [
  "# Confined session policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  "classes:",
  "  files.write.workspace:",
  "    autonomy: autonomous",
  "    allow_irreversible: true",
  "```",
  "",
].join("\n");

function sha(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function b64(value: string): string {
  return Buffer.from(value).toString("base64");
}

interface Unit {
  dir: string;
  installation: BrokerInstallation;
  policySha256: string;
}

function unit(): Unit {
  serial += 1;
  const dir = realpathSync(mkdtempSync(join(scratch, `unit-${String(serial)}-`)));
  const primary = join(dir, "primary");
  const workspace = join(dir, "workspace");
  mkdirSync(join(primary, ".approval", "log"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const policyPath = join(primary, "APPROVAL.md");
  writeFileSync(policyPath, POLICY, "utf8");
  const logPath = join(primary, ".approval", "log", "events.jsonl");
  const attested = appendAttestation(logPath, policyPath, "human:carter", T0);
  assert.equal(attested.ok, true, "attestation append failed");
  // Credential-shaped material beside the log, so the read denial has something
  // real to deny rather than a path that happens not to exist.
  writeFileSync(join(primary, ".approval", "vault.json"), JSON.stringify({ token: TOKEN }), "utf8");
  return {
    dir,
    installation: {
      instanceId: "confined",
      actor: "agent:codex-confined",
      root: workspace,
      policyPath,
      logPath,
    },
    policySha256: sha(readFileSync(policyPath)),
  };
}

function session(one: Unit): ConfinedSession {
  const planned = planConfinedSession(one.installation, { scratchRoot: scratch });
  if (!planned.ok) assert.fail(`${planned.code}: ${planned.message}`);
  return planned.session;
}

/** Write a Node script into `dir` and return its path. */
function script(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body, "utf8");
  return path;
}

function workspaceEntries(one: Unit): string[] {
  return readdirSync(one.installation.root).sort();
}

function assertClean(one: Unit): void {
  const result = verify(one.installation.logPath);
  assert.equal(result.status, "clean", `log not clean: ${JSON.stringify(result)}`);
}

/**
 * A loopback port nothing should be listening on.
 *
 * Fixed rather than reserved, because reserving one needs an asynchronous
 * `listen` and this case is synchronous by necessity (`runConfined` uses
 * `spawnSync`). Nothing rests on the guess: the control leg asserts
 * `ECONNREFUSED`, so a port that turns out to be in use fails the test loudly
 * instead of turning the confined leg into a false pass.
 */
const CLOSED_LOOPBACK_PORT = 45_917;

// ===========================================================================
// The refusal table and the profile (run everywhere)
// ===========================================================================

test("the confinement refusal-code union is frozen and every member is distinct", () => {
  assert.equal(new Set(CONFINE_REFUSAL_CODES).size, CONFINE_REFUSAL_CODES.length);
  assert.deepEqual([...CONFINE_REFUSAL_CODES], [
    "sandbox-unsupported",
    "sandbox-unavailable",
    "workspace-unavailable",
    "command-unresolvable",
    "timeout",
  ]);
});

test("an unsupported host REFUSES rather than running the shell and calling it confined", () => {
  const one = unit();
  const planned = planConfinedSession(one.installation, {
    detect: { platform: "linux" },
    scratchRoot: scratch,
  });
  assert.equal(planned.ok, false);
  const refusal = planned as ConfineRefusal;
  assert.equal(refusal.code, "sandbox-unsupported");
  // The difference from `approval run`, stated in the message a person reads.
  assert.match(refusal.message, /does not proceed and record `unsupported`/u);
});

test("the force-unavailable override refuses too: it can only ever tighten", () => {
  const one = unit();
  const planned = planConfinedSession(one.installation, {
    detect: { platform: "darwin", env: { APPROVAL_SANDBOX_FORCE_UNAVAILABLE: "1" } },
    scratchRoot: scratch,
  });
  assert.equal(planned.ok, false);
  assert.equal((planned as ConfineRefusal).code, "sandbox-unavailable");
  assert.match((planned as ConfineRefusal).message, /no opt-out and no raw fallback/u);
});

test("the profile denies every write outside the disposable workspace", () => {
  const room = "/private/tmp/approval-codex-session-example";
  const profile = seatbeltProfile({ loopback: false, denyRead: [], writeAllow: [room] });
  assert.match(profile, /\(deny file-write\*\)/u);
  assert.match(profile, /\(allow file-write\* \(subpath "\/dev"\)\)/u);
  assert.ok(profile.includes(`(allow file-write* (subpath "${room}"))`));
  // The deny precedes every allow: SBPL takes the LAST matching rule, so an
  // allow written before the deny would be overridden and protect nothing.
  assert.ok(profile.indexOf("(deny file-write*)") < profile.indexOf(`(subpath "${room}")`));
});

test("an EMPTY write allow-list is meaningful, and absent is not the same as empty", () => {
  const closed = seatbeltProfile({ loopback: false, denyRead: [], writeAllow: [] });
  assert.match(closed, /\(deny file-write\*\)/u);
  const ordinary = seatbeltProfile({ loopback: false, denyRead: [] });
  assert.equal(ordinary.includes("(deny file-write*)"), false);
  // The egress-only profile every other caller uses is untouched by APRV-325.3.
  assert.match(ordinary, /\(deny network-outbound\)/u);
});

test("a session's only writable path is its own disposable workspace", () => {
  const one = unit();
  const room = session(one);
  try {
    assert.deepEqual(room.writeAllow, [room.workspace]);
    assert.equal(room.canonical, one.installation.root);
    assert.equal(room.writeAllow.includes(one.installation.root), false);
    assert.equal(room.writeAllow.some((path) => one.installation.logPath.startsWith(path)), false);
    assert.equal(room.env["TMPDIR"], room.workspace);
    assert.equal(existsSync(room.workspace), true);
  } finally {
    room.dispose();
  }
  assert.equal(existsSync(room.workspace), false, "the workspace is disposable");
});

test("the session environment is an ALLOW-list, so an unknown credential is absent", () => {
  const one = unit();
  const planned = planConfinedSession(one.installation, {
    scratchRoot: scratch,
    source: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: "/var/empty",
      // Under a prefix `core/child-env.ts` knows.
      TELEGRAM_BOT_TOKEN: TOKEN,
      // Under NO prefix this runtime knows, which is exactly the case an
      // allow-list exists for: a deny-list would have to have heard of each.
      OPENAI_API_KEY: "sk-not-real",
      GITHUB_TOKEN: "ghp-not-real",
      AWS_SECRET_ACCESS_KEY: "aws-not-real",
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
    },
  });
  if (!planned.ok) assert.fail(planned.message);
  const room = planned.session;
  try {
    assert.deepEqual(
      Object.keys(room.env).sort(),
      ["APPROVAL_CODEX_SESSION_WORKSPACE", "HOME", "PATH", "TMPDIR"],
    );
    assert.equal(room.env["HOME"], "/var/empty");
    assert.equal(JSON.stringify(room.env).includes(TOKEN), false);
    assert.equal(JSON.stringify(room.env).includes("not-real"), false);
    // The credential-bearing count is the runtime's usual one; the total
    // withheld is larger, because the allow-list removed more than the family.
    assert.equal(room.envStripped, 1);
    // Seven in, two out: the five withheld are the four credentials and the
    // agent socket, none of which the allow-list names.
    assert.equal(room.envWithheld, 5);
  } finally {
    room.dispose();
  }
});

test("the environment allow-list carries no credential-shaped name", () => {
  for (const name of CONFINED_ENV_ALLOW) {
    assert.doesNotMatch(name, /TOKEN|KEY|SECRET|PASS|CREDENTIAL|AUTH/u, `${name} is on the allow-list`);
  }
  assert.equal(new Set(CONFINED_ENV_ALLOW).size, CONFINED_ENV_ALLOW.length);
});

test("a command that does not resolve is REFUSED, never spawned unwrapped", () => {
  const one = unit();
  const room = session(one);
  try {
    const ran = runConfined(room, "definitely-not-a-real-binary-aprv3253", []);
    assert.equal(ran.ok, false);
    assert.equal((ran as ConfineRefusal).code, "command-unresolvable");
    assert.match((ran as ConfineRefusal).message, /no raw fallback/u);
  } finally {
    room.dispose();
  }
});

// ===========================================================================
// The paired confinement proofs (macOS only)
// ===========================================================================

test("the control: unconfined, the same script DOES write the canonical workspace", { skip: SKIP }, () => {
  const one = unit();
  const target = join(one.installation.root, "smuggled.txt");
  const path = script(one.dir, "write.mjs", "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv[2], 'smuggled');\n");
  const result = spawnSync(process.execPath, [path, target], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(target, "utf8"), "smuggled");
});

test("confined, that write is denied and the canonical workspace is untouched", { skip: SKIP }, () => {
  const one = unit();
  const room = session(one);
  try {
    const target = join(one.installation.root, "smuggled.txt");
    const path = script(room.workspace, "write.mjs", "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv[2], 'smuggled');\n");
    const ran = runConfined(room, process.execPath, [path, target]);
    if (!ran.ok) assert.fail(`${ran.code}: ${ran.message}`);
    assert.notEqual(ran.exitCode, 0, "the confined write should have failed");
    assert.match(ran.stderr, /EPERM|not permitted|EACCES/u);
    assert.equal(existsSync(target), false);
    assert.deepEqual(workspaceEntries(one), []);
  } finally {
    room.dispose();
  }
});

test("confined, the shell CAN write its own disposable workspace", { skip: SKIP }, () => {
  const one = unit();
  const room = session(one);
  try {
    const path = script(room.workspace, "own.mjs", "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv[2], 'mine');\n");
    const inside = join(room.workspace, "mine.txt");
    const ran = runConfined(room, process.execPath, [path, inside]);
    if (!ran.ok) assert.fail(`${ran.code}: ${ran.message}`);
    assert.equal(ran.exitCode, 0, ran.stderr);
    assert.equal(readFileSync(inside, "utf8"), "mine");
  } finally {
    room.dispose();
  }
});

test("confined, the gate's log and policy cannot be written", { skip: SKIP }, () => {
  const one = unit();
  const room = session(one);
  try {
    const before = readFileSync(one.installation.logPath, "utf8");
    const path = script(room.workspace, "gate.mjs", "import { appendFileSync } from 'node:fs';\nappendFileSync(process.argv[2], 'fabricated\\n');\n");
    for (const target of [one.installation.logPath, one.installation.policyPath]) {
      const ran = runConfined(room, process.execPath, [path, target]);
      if (!ran.ok) assert.fail(`${ran.code}: ${ran.message}`);
      assert.notEqual(ran.exitCode, 0, `writing ${target} should have failed`);
    }
    assert.equal(readFileSync(one.installation.logPath, "utf8"), before);
    assert.equal(readFileSync(one.installation.policyPath, "utf8"), POLICY);
    assertClean(one);
  } finally {
    room.dispose();
  }
});

test("confined, the credential material beside the log cannot be read", { skip: SKIP }, () => {
  const one = unit();
  const vault = credentialPathsFor(one.installation.logPath)[0] as string;
  writeFileSync(vault, JSON.stringify({ token: TOKEN }), "utf8");
  const room = session(one);
  const path = script(room.workspace, "read.mjs", "import { readFileSync } from 'node:fs';\nprocess.stdout.write(readFileSync(process.argv[2], 'utf8'));\n");
  try {
    // The control: unconfined, the file is readable and holds the secret. Without
    // it, a vault the test never wrote would make the denial look like a pass.
    const control = spawnSync(process.execPath, [path, vault], { encoding: "utf8", timeout: 10_000 });
    assert.equal(control.status, 0, control.stderr);
    assert.ok(control.stdout.includes(TOKEN));

    const ran = runConfined(room, process.execPath, [path, vault]);
    if (!ran.ok) assert.fail(`${ran.code}: ${ran.message}`);
    assert.notEqual(ran.exitCode, 0);
    assert.equal(ran.stdout.includes(TOKEN), false);
    assert.equal(ran.stderr.includes(TOKEN), false);
  } finally {
    room.dispose();
  }
});

test("confined, a loopback connect is DENIED rather than merely refused", { skip: SKIP }, () => {
  // The evidence is the difference between two error codes, and it needs no
  // listener at all. Unconfined, a connect to a closed loopback port reaches the
  // kernel and comes back ECONNREFUSED: the syscall happened. Confined, the same
  // connect never reaches it and comes back EPERM: the profile stopped it. A
  // test that asserted only "it failed" would pass with no sandbox, because a
  // closed port fails either way — the two codes are what tell them apart.
  //
  // No in-process listener, deliberately: `runConfined` uses `spawnSync`, which
  // blocks this process's event loop, so a server started here could never
  // answer and its silence would prove nothing.
  const one = unit();
  const room = session(one);
  const body = "import { Socket } from 'node:net';\n" +
    "const s = new Socket();\n" +
    "s.on('error', (e) => { process.stdout.write(String(e.code)); process.exit(0); });\n" +
    "s.on('connect', () => { process.stdout.write('CONNECTED'); process.exit(0); });\n" +
    "s.connect(Number(process.argv[2]), '127.0.0.1');\n";
  try {
    const port = CLOSED_LOOPBACK_PORT;
    const path = script(one.dir, "connect.mjs", body);
    const control = spawnSync(process.execPath, [path, String(port)], { encoding: "utf8", timeout: 10_000 });
    assert.equal(control.status, 0, control.stderr);
    assert.equal(control.stdout, "ECONNREFUSED", `unconfined connect said ${control.stdout}`);

    const inside = script(room.workspace, "connect.mjs", body);
    const ran = runConfined(room, process.execPath, [inside, String(port)]);
    if (!ran.ok) assert.fail(`${ran.code}: ${ran.message}`);
    assert.equal(ran.exitCode, 0, ran.stderr);
    assert.notEqual(ran.stdout, "CONNECTED");
    assert.equal(ran.stdout, "EPERM", `confined connect said ${ran.stdout}`);
  } finally {
    room.dispose();
  }
});

test("a DESCENDANT of the confined child is confined too", { skip: SKIP }, () => {
  // The case that matters for a real session: Codex does not write files by
  // calling `writeFileSync` in this process, it spawns shells that do. A room
  // that only held the first child would hold nothing.
  const one = unit();
  const room = session(one);
  try {
    const target = join(one.installation.root, "via-shell.txt");
    const path = script(room.workspace, "nest.mjs",
      "import { spawnSync } from 'node:child_process';\n" +
      "const r = spawnSync('/bin/sh', ['-c', `echo nested > '${process.argv[2]}'`], { encoding: 'utf8' });\n" +
      "process.stdout.write(String(r.status));\n");
    const ran = runConfined(room, process.execPath, [path, target]);
    if (!ran.ok) assert.fail(`${ran.code}: ${ran.message}`);
    assert.notEqual(ran.stdout, "0", "the grandchild shell wrote the canonical workspace");
    assert.equal(existsSync(target), false);
    assert.deepEqual(workspaceEntries(one), []);
  } finally {
    room.dispose();
  }
});

test("every write API a patch tool reaches for is denied, not just the first", { skip: SKIP }, () => {
  // A native write/patch tool does not use one call. The profile is a kernel
  // rule over `file-write*`, so this asserts the property rather than an
  // API-by-API allow-list, and it fails loudly if that ever stops being true.
  const one = unit();
  writeFileSync(join(one.installation.root, "existing.txt"), "old", "utf8");
  const room = session(one);
  try {
    const path = script(room.workspace, "apis.mjs",
      "import { appendFileSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';\n" +
      "import { join } from 'node:path';\n" +
      "const root = process.argv[2];\n" +
      "const staged = process.argv[3];\n" +
      "const attempts = {\n" +
      "  write: () => writeFileSync(join(root, 'a.txt'), 'x'),\n" +
      "  append: () => appendFileSync(join(root, 'existing.txt'), 'x'),\n" +
      "  open: () => openSync(join(root, 'b.txt'), 'w'),\n" +
      "  mkdir: () => mkdirSync(join(root, 'sub')),\n" +
      "  rename: () => renameSync(staged, join(root, 'c.txt')),\n" +
      "  unlink: () => rmSync(join(root, 'existing.txt')),\n" +
      "};\n" +
      "const allowed = [];\n" +
      "for (const [name, run] of Object.entries(attempts)) {\n" +
      "  try { run(); allowed.push(name); } catch { /* denied */ }\n" +
      "}\n" +
      "process.stdout.write(JSON.stringify(allowed));\n");
    const staged = join(room.workspace, "staged.txt");
    writeFileSync(staged, "staged", "utf8");
    const ran = runConfined(room, process.execPath, [path, one.installation.root, staged]);
    if (!ran.ok) assert.fail(`${ran.code}: ${ran.message}`);
    assert.deepEqual(JSON.parse(ran.stdout) as string[], [], `these APIs were allowed: ${ran.stdout}`);
    assert.deepEqual(workspaceEntries(one), ["existing.txt"]);
    assert.equal(readFileSync(join(one.installation.root, "existing.txt"), "utf8"), "old");
  } finally {
    room.dispose();
  }
});

test("a crash, a non-zero exit and a timeout all leave the canonical workspace alone", { skip: SKIP }, () => {
  const one = unit();
  const room = session(one);
  try {
    const target = join(one.installation.root, "crash.txt");
    const crash = script(room.workspace, "crash.mjs", "import { writeFileSync } from 'node:fs';\ntry { writeFileSync(process.argv[2], 'x'); } catch { /* denied */ }\nthrow new Error('boom');\n");
    const crashed = runConfined(room, process.execPath, [crash, target]);
    if (!crashed.ok) assert.fail(crashed.message);
    assert.notEqual(crashed.exitCode, 0);

    const spin = script(room.workspace, "spin.mjs", "import { writeFileSync } from 'node:fs';\ntry { writeFileSync(process.argv[2], 'x'); } catch { /* denied */ }\nsetInterval(() => {}, 1000);\n");
    const killed = runConfined(room, process.execPath, [spin, target], { timeoutMs: 1_500 });
    if (!killed.ok) assert.fail(killed.message);
    assert.notEqual(killed.exitCode, 0);

    assert.equal(existsSync(target), false);
    assert.deepEqual(workspaceEntries(one), []);
    assertClean(one);
  } finally {
    room.dispose();
  }
});

test("a disposed session takes its workspace with it, and a replay gets a fresh one", { skip: SKIP }, () => {
  const one = unit();
  const first = session(one);
  const path = script(first.workspace, "mark.mjs", "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv[2], 'first');\n");
  const marker = join(first.workspace, "state.txt");
  const ran = runConfined(first, process.execPath, [path, marker]);
  if (!ran.ok) assert.fail(ran.message);
  assert.equal(ran.exitCode, 0, ran.stderr);
  const firstRoom = first.workspace;
  first.dispose();
  assert.equal(existsSync(firstRoom), false);

  const second = session(one);
  try {
    // Nothing the first session did survives into the second: a replay of the
    // same shell work starts from an empty room and still cannot reach the
    // canonical workspace.
    assert.notEqual(second.workspace, firstRoom);
    assert.deepEqual(readdirSync(second.workspace), []);
    assert.deepEqual(workspaceEntries(one), []);
  } finally {
    second.dispose();
  }
});

// ===========================================================================
// End to end: the shell cannot, the broker can, and exactly once
// ===========================================================================

test("only a brokered change reaches the canonical workspace, and it is exactly the change", { skip: SKIP }, () => {
  const one = unit();
  writeFileSync(join(one.installation.root, "keep.txt"), "old", "utf8");
  const room = session(one);
  try {
    // 1. The confined shell tries to make the change itself and cannot.
    const direct = script(room.workspace, "direct.mjs", "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv[2], 'new');\n");
    const denied = runConfined(room, process.execPath, [direct, join(one.installation.root, "keep.txt")]);
    if (!denied.ok) assert.fail(denied.message);
    assert.notEqual(denied.exitCode, 0);
    assert.equal(readFileSync(join(one.installation.root, "keep.txt"), "utf8"), "old");

    // 2. The same change through the broker, which the policy admits.
    const applied = applyWorkspaceChange(
      "codex_workspace_apply",
      one.installation,
      {
        operations: [
          { kind: "replace", path: "keep.txt", expected_before_sha256: sha("old"), after_base64: b64("new") },
        ],
        expected_policy_sha256: one.policySha256,
      },
      { clock: CLOCK },
    );
    assert.equal(applied.ok, true, applied.ok ? "" : `${applied.code}: ${applied.message}`);
    if (!applied.ok) return;

    // 3. Exactly its effect, and a verifiable outcome in the log.
    assert.equal(readFileSync(join(one.installation.root, "keep.txt"), "utf8"), "new");
    assert.deepEqual(workspaceEntries(one), ["keep.txt"]);
    const records = readFileSync(one.installation.logPath, "utf8")
      .split("\n").filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { event: string; action_key?: string });
    const completed = records.filter((record) => record.event === "execution.completed");
    assert.equal(completed.length, 1);
    assert.equal(completed[0]?.action_key, applied.legs[0]?.actionKey);
    assertClean(one);

    // 4. The replay: the identical proposal a second time changes nothing.
    const replay = applyWorkspaceChange(
      "codex_workspace_apply",
      one.installation,
      {
        operations: [
          { kind: "replace", path: "keep.txt", expected_before_sha256: sha("old"), after_base64: b64("new") },
        ],
        expected_policy_sha256: one.policySha256,
      },
      { clock: CLOCK },
    );
    assert.equal(replay.ok, false);
    assert.equal(readFileSync(join(one.installation.root, "keep.txt"), "utf8"), "new");
    assertClean(one);
  } finally {
    room.dispose();
  }
});

test("the default confined timeout is bounded and stated", () => {
  assert.equal(DEFAULT_CONFINED_TIMEOUT_MS, 120_000);
});
