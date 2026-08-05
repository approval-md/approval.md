/**
 * `approval doctor` CLI tests (APRV-31).
 *
 * Every case spawns the real built CLI in a temp directory, and every log these
 * tests read was written by the real append path (`approval policy attest`) —
 * no line is hand-rolled. Two properties are asserted in almost every case
 * because they are the whole promise of a diagnostic verb:
 *
 * - **the log is byte-identical across a doctor run**, and
 * - **the Bot API sees `getMe` and nothing else** — never `sendMessage` (which
 *   would buzz a human's phone), never `getUpdates` (whose offset a running
 *   listener owns).
 *
 * The network never leaves loopback: the Telegram probe is pointed at the mock
 * Bot API in `tests/telegram-mock.ts` via `--api-base`, guarded by
 * `assertLocal`, and the one "network failure" case points at a port that was
 * bound and released so the connection is refused rather than routed.
 *
 * The build-freshness check is exercised through the TEST-ONLY `--root` flag,
 * which retargets that check (and only that check) at a fixture tree. Doing it
 * any other way would mean mutating the mtimes of the real `dist/` the test
 * runner is executing from.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { assertLocal, startMockBotApi, type MockBotApi } from "./telegram-mock.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const TOKEN = "7654321:AA-approval-md-fake-token-for-tests-only-DO-NOT-USE";
const CHAT = "12345";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-cli-doctor-")));
let counter = 0;
let mock: MockBotApi;

/**
 * The healthy fixture, built once. `doctor` writes nothing anywhere, so every
 * case that does not deliberately damage its environment can share one home —
 * and a suite that re-attested a fresh policy per test would spend most of its
 * wall time spawning the CLI to set up rather than to assert.
 */
let healthyHome = "";
let healthyPort = 0;

function healthy(): { home: string; port: number } {
  return { home: healthyHome, port: healthyPort };
}

before(async () => {
  mock = await startMockBotApi(TOKEN);
  healthyPort = await freePort();
  healthyHome = await makeHome({ port: healthyPort });
});

after(async () => {
  await mock.close();
  rmSync(scratch, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the CLI with a scrubbed environment: the ambient `APPROVAL_HUMAN` and
 * Telegram variables of whoever is running the suite must never decide a test.
 *
 * ASYNCHRONOUS on purpose. `spawnSync` would block this process's event loop
 * for the child's whole lifetime, and the mock Bot API the child is pointed at
 * lives in this process — it could never accept the connection, and every
 * Telegram probe would "fail" by timing out against a server that was simply
 * never listening. The other CLI suites use `spawnSync` freely because nothing
 * they spawn calls back into the test process.
 */
async function runCli(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<Run> {
  const childEnv = { ...process.env, ...env };
  for (const name of ["APPROVAL_HUMAN", "APPROVAL_TG_TOKEN", "APPROVAL_TG_CHAT"]) {
    if (env[name] === undefined) delete childEnv[name];
  }
  // The same discipline as `assertLocal`, one layer out: a fully configured
  // Telegram environment WITHOUT --api-base would point this suite's probe at
  // the real Bot API. No test in this repository contacts the real network.
  if (
    childEnv["APPROVAL_TG_TOKEN"] !== undefined &&
    childEnv["APPROVAL_TG_CHAT"] !== undefined &&
    !args.includes("--api-base")
  ) {
    throw new Error("a configured Telegram probe must be pointed at the mock with --api-base");
  }

  return await new Promise<Run>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], { cwd, env: childEnv });
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
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

interface DoctorCheck {
  check: string;
  status: string;
  detail: string;
  fix?: string;
}

function parseDoctor(run: Run): { ok: boolean; checks: DoctorCheck[] } {
  const parsed = JSON.parse(run.stdout) as { ok: boolean; checks: DoctorCheck[] };
  return parsed;
}

function checkNamed(run: Run, name: string): DoctorCheck {
  const found = parseDoctor(run).checks.find((entry) => entry.check === name);
  assert.ok(found !== undefined, `no ${name} check in ${run.stdout}`);
  return found;
}

function policyWith(port: number): string {
  return [
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
    "channels:",
    "  web:",
    `    port: ${port}`,
    "```",
    "",
  ].join("\n");
}

/** A TCP port nothing is listening on: bound on loopback, then released. */
async function freePort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Hold a loopback port for the duration of one test. */
async function holdPort(port: number): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

/**
 * A working directory: policy file, `.approval/log/`, and (unless
 * `attest: false`) a real attestation appended by the real CLI.
 */
async function makeHome(options: { attest?: boolean; port: number }): Promise<string> {
  counter += 1;
  const dir = join(scratch, `home-${counter}`);
  mkdirSync(join(dir, ".approval", "log"), { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), policyWith(options.port));
  if (options.attest !== false) {
    const attested = await runCli(["policy", "attest"], dir, { APPROVAL_HUMAN: "human:carter" });
    assert.equal(attested.code, 0, attested.stderr);
  }
  return dir;
}

function logPathOf(home: string): string {
  return join(home, ".approval", "log", "events.jsonl");
}

/**
 * A fixture installation tree for the build-freshness check.
 *
 * `shape` picks which shape to build; the first three are the ones seen in the
 * wild, and the two after them are the degenerate cases either side of them:
 * - `fresh`     — cli.js, src/, and a dist marker stamped newer than the source
 * - `stale`     — the same tree with a source file stamped NEWER than the marker
 * - `unbuilt`   — cli.js with no dist/ behind it (the placeholder binary)
 * - `no-loader` — a build with no cli.js to reach it
 * - `published` — a dist marker and no src/ at all
 */
type RootShape = "fresh" | "stale" | "unbuilt" | "no-loader" | "published";

const roots = new Map<string, string>();

function makeRoot(shape: RootShape): string {
  // Built once per shape and reused: doctor only ever reads these trees, and a
  // fresh copy per test would be a few dozen pointless directory creations.
  const memoized = roots.get(shape);
  if (memoized !== undefined) return memoized;
  counter += 1;
  const root = join(scratch, `root-${counter}-${shape}`);
  roots.set(shape, root);
  mkdirSync(root, { recursive: true });

  const loader = join(root, "cli.js");
  const marker = join(root, "dist", "src", "cli", "main.js");
  const source = join(root, "src", "cli", "main.ts");
  const tsconfig = join(root, "tsconfig.json");

  if (shape !== "no-loader") writeFileSync(loader, "// fixture bin loader\n");
  if (shape !== "unbuilt") {
    mkdirSync(join(root, "dist", "src", "cli"), { recursive: true });
    writeFileSync(marker, "// fixture build output\n");
  }
  if (shape !== "published") {
    mkdirSync(join(root, "src", "cli"), { recursive: true });
    writeFileSync(source, "// fixture source\n");
    writeFileSync(tsconfig, "{}\n");
  }

  // Explicit mtimes, in seconds: "same second" would make the comparison a coin
  // flip on a filesystem with coarse timestamps.
  const base = Date.now() / 1000;
  if (shape === "stale") {
    utimesSync(marker, base - 3600, base - 3600);
    utimesSync(source, base, base);
    utimesSync(tsconfig, base - 7200, base - 7200);
    utimesSync(join(root, "src", "cli"), base, base);
    utimesSync(join(root, "src"), base, base);
  } else if (shape === "fresh") {
    utimesSync(source, base - 3600, base - 3600);
    utimesSync(tsconfig, base - 3600, base - 3600);
    utimesSync(join(root, "src", "cli"), base - 3600, base - 3600);
    utimesSync(join(root, "src"), base - 3600, base - 3600);
    utimesSync(marker, base, base);
  }
  return root;
}

/**
 * The baseline environment: a declared human and NO Telegram configuration, so
 * the probe skips. Tests that want the probe to run opt in with {@link TG_ENV}
 * and must pass `--api-base`; `runCli` refuses the combination that would
 * otherwise reach the real Bot API.
 */
const GREEN_ENV: Record<string, string> = { APPROVAL_HUMAN: "human:carter" };

/** Fully configured Telegram. Only ever used together with `--api-base`. */
const TG_ENV: Record<string, string> = {
  ...GREEN_ENV,
  APPROVAL_TG_TOKEN: TOKEN,
  APPROVAL_TG_CHAT: CHAT,
};

// ---------------------------------------------------------------------------
// The all-green run
// ---------------------------------------------------------------------------

test("doctor: every check passes or skips on a healthy environment", async () => {
  const { home, port } = healthy();
  const root = makeRoot("fresh");
  const before = readFileSync(logPathOf(home));
  const requestsBefore = mock.requests.length;

  const run = await runCli(
    ["doctor", "--json", "--root", root, "--api-base", assertLocal(mock.url)],
    home,
    TG_ENV,
  );

  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  const parsed = parseDoctor(run);
  assert.equal(parsed.ok, true);
  assert.deepEqual(
    parsed.checks.map((entry) => entry.check),
    [
      "build-freshness",
      "identity",
      "attestation",
      "log",
      "telegram",
      "web-port",
      "payload-store",
    ],
  );
  assert.deepEqual(
    parsed.checks.map((entry) => entry.status),
    ["pass", "pass", "pass", "pass", "pass", "pass", "pass"],
  );
  for (const entry of parsed.checks) {
    assert.equal(entry.fix, undefined, `a passing check carried a fix: ${entry.check}`);
    assert.ok(entry.detail.length > 0);
  }
  assert.match(checkNamed(run, "identity").detail, /human:carter/u);
  assert.match(checkNamed(run, "attestation").detail, /attested at seq 1/u);
  assert.match(checkNamed(run, "telegram").detail, /@approval_md_test_bot/u);
  assert.match(checkNamed(run, "web-port").detail, new RegExp(`127\\.0\\.0\\.1:${port} is free`, "u"));
  // The healthy fixture has never made a request carrying --payload, so the
  // store does not exist yet: a pass with the reason, plus the warning every
  // verdict of this check carries.
  const store = checkNamed(run, "payload-store");
  assert.match(store.detail, /not created until the first request --payload/u);
  assert.match(store.detail, /CANNOT be rebuilt from the log/u);
  assert.match(store.detail, /payload-unavailable/u);

  // The log was not touched, and the token never appeared in the output.
  assert.deepEqual(readFileSync(logPathOf(home)), before);
  assert.ok(!run.stdout.includes(TOKEN) && !run.stderr.includes(TOKEN));

  // getMe and NOTHING else: no sendMessage, no getUpdates.
  const methods = mock.requests.slice(requestsBefore).map((entry) => entry.method);
  assert.deepEqual(methods, ["getMe"]);
});

test("doctor: human output is one line per check with indented fixes", async () => {
  const { home } = healthy();
  const root = makeRoot("fresh");

  const run = await runCli(["doctor", "--root", root], home, {});

  assert.equal(run.code, 1, run.stderr);
  const lines = run.stdout.trimEnd().split("\n");
  assert.equal(lines.filter((line) => /^[✓✗–] /u.test(line)).length, 7);
  assert.ok(lines.some((line) => line.startsWith("✗ identity:")));
  assert.ok(lines.some((line) => line.startsWith("– telegram:")));
  // The fix belongs to the failing check and is indented under it.
  const identityIndex = lines.findIndex((line) => line.startsWith("✗ identity:"));
  assert.match(lines[identityIndex + 1] as string, /^ {4}fix: export APPROVAL_HUMAN=/u);
});

// ---------------------------------------------------------------------------
// 1. build freshness
// ---------------------------------------------------------------------------

test("doctor: a stale build is named as a stale build", async () => {
  const { home } = healthy();
  const run = await runCli(["doctor", "--json", "--root", makeRoot("stale")], home, GREEN_ENV);

  assert.equal(run.code, 1);
  const check = checkNamed(run, "build-freshness");
  assert.equal(check.status, "fail");
  assert.match(check.detail, /STALE BUILD/u);
  assert.equal(check.fix, "run `npm run build`");
  assert.equal(parseDoctor(run).ok, false);
});

test("doctor: the placeholder-binary shape (cli.js with no dist) is its own message", async () => {
  const { home } = healthy();
  const run = await runCli(["doctor", "--json", "--root", makeRoot("unbuilt")], home, GREEN_ENV);

  assert.equal(run.code, 1);
  const check = checkNamed(run, "build-freshness");
  assert.equal(check.status, "fail");
  assert.match(check.detail, /unbuilt checkout/u);
  assert.match(check.fix ?? "", /npm run build/u);
});

test("doctor: a build with no bin loader fails distinctly", async () => {
  const { home } = healthy();
  const check = checkNamed(
    await runCli(["doctor", "--json", "--root", makeRoot("no-loader")], home, GREEN_ENV),
    "build-freshness",
  );

  assert.equal(check.status, "fail");
  assert.match(check.detail, /bin loader/u);
});

test("doctor: a published install with no sources skips freshness rather than passing", async () => {
  const { home } = healthy();
  const run = await runCli(["doctor", "--json", "--root", makeRoot("published")], home, GREEN_ENV);

  const check = checkNamed(run, "build-freshness");
  assert.equal(check.status, "skip");
  assert.match(check.detail, /carries no sources/u);
  // A skip does not make the run unhealthy.
  assert.equal(run.code, 0);
  assert.equal(parseDoctor(run).ok, true);
});

test("doctor: a root that is not an installation at all fails", async () => {
  const { home } = healthy();
  counter += 1;
  const empty = join(scratch, `root-${counter}-empty`);
  mkdirSync(empty, { recursive: true });

  const check = checkNamed(
    await runCli(["doctor", "--json", "--root", empty], home, GREEN_ENV),
    "build-freshness",
  );
  assert.equal(check.status, "fail");
  assert.match(check.detail, /not an approval\.md installation/u);
});

// ---------------------------------------------------------------------------
// 2. identity
// ---------------------------------------------------------------------------

test("doctor: identity fails when APPROVAL_HUMAN is unset or malformed", async () => {
  const { home } = healthy();
  const root = makeRoot("fresh");

  const unset = checkNamed(await runCli(["doctor", "--json", "--root", root], home, {}), "identity");
  assert.equal(unset.status, "fail");
  assert.match(unset.detail, /is unset/u);
  assert.match(unset.fix ?? "", /--as human:<id>/u);

  const malformed = checkNamed(
    await runCli(["doctor", "--json", "--root", root], home, { APPROVAL_HUMAN: "agent:claude" }),
    "identity",
  );
  assert.equal(malformed.status, "fail");
  assert.match(malformed.detail, /does not match human:<id>/u);
});

// ---------------------------------------------------------------------------
// 3. attestation
// ---------------------------------------------------------------------------

test("doctor: an unattested policy fails with the attest fix", async () => {
  const port = await freePort();
  const home = await makeHome({ port, attest: false });
  const run = await runCli(["doctor", "--json", "--root", makeRoot("fresh")], home, GREEN_ENV);

  const check = checkNamed(run, "attestation");
  assert.equal(check.status, "fail");
  assert.match(check.detail, /never been attested/u);
  assert.match(check.fix ?? "", /approval policy attest/u);
  assert.equal(run.code, 1);
});

test("doctor: a policy edited since attestation is a hash mismatch, not a silent pass", async () => {
  const port = await freePort();
  const home = await makeHome({ port });
  writeFileSync(join(home, "APPROVAL.md"), `${policyWith(port)}\n<!-- edited after attest -->\n`);
  const before = readFileSync(logPathOf(home));

  const run = await runCli(["doctor", "--json", "--root", makeRoot("fresh")], home, GREEN_ENV);

  const check = checkNamed(run, "attestation");
  assert.equal(check.status, "fail");
  assert.match(check.detail, /has changed since it was attested at seq 1/u);
  assert.match(check.fix ?? "", /re-attest/u);
  assert.equal(run.code, 1);
  // Doctor did not "helpfully" re-attest.
  assert.deepEqual(readFileSync(logPathOf(home)), before);
});

test("doctor: a missing policy file is unreadable, not absent-therefore-fine", async () => {
  const port = await freePort();
  const home = await makeHome({ port });
  rmSync(join(home, "APPROVAL.md"));

  const check = checkNamed(
    await runCli(["doctor", "--json", "--root", makeRoot("fresh")], home, GREEN_ENV),
    "attestation",
  );
  assert.equal(check.status, "fail");
  assert.match(check.detail, /treated as unattested/u);
});

// ---------------------------------------------------------------------------
// 4. log
// ---------------------------------------------------------------------------

test("doctor: a torn tail fails the log check and is not repaired", async () => {
  const port = await freePort();
  const home = await makeHome({ port });
  appendFileSync(logPathOf(home), '{"seq":2,"ts":"2026-08-05T00:00:00Z"');
  const before = readFileSync(logPathOf(home));

  const run = await runCli(["doctor", "--json", "--root", makeRoot("fresh")], home, GREEN_ENV);

  const check = checkNamed(run, "log");
  assert.equal(check.status, "fail");
  assert.match(check.detail, /unterminated final line/u);
  assert.match(check.fix ?? "", /approval log verify/u);
  assert.equal(run.code, 1);
  // The torn line is exactly where it was: doctor truncates nothing.
  assert.deepEqual(readFileSync(logPathOf(home)), before);
});

test("doctor: a corrupt log fails the log check", async () => {
  const port = await freePort();
  const home = await makeHome({ port });
  appendFileSync(logPathOf(home), '{"not":"an event"}\n');

  const run = await runCli(["doctor", "--json", "--root", makeRoot("fresh")], home, GREEN_ENV);
  const check = checkNamed(run, "log");
  assert.equal(check.status, "fail");
  assert.match(check.detail, /does not verify/u);
  assert.equal(run.code, 1);
});

test("doctor: an empty log is clean, not missing", async () => {
  const port = await freePort();
  const home = await makeHome({ port, attest: false });

  const check = checkNamed(
    await runCli(["doctor", "--json", "--root", makeRoot("fresh")], home, GREEN_ENV),
    "log",
  );
  assert.equal(check.status, "pass");
  assert.match(check.detail, /is empty/u);
});

// ---------------------------------------------------------------------------
// 5. telegram
// ---------------------------------------------------------------------------

test("doctor: telegram skips cleanly when the environment is absent", async () => {
  const { home } = healthy();
  const requestsBefore = mock.requests.length;

  const run = await runCli(["doctor", "--json", "--root", makeRoot("fresh")], home, {
    APPROVAL_HUMAN: "human:carter",
  });

  const check = checkNamed(run, "telegram");
  assert.equal(check.status, "skip");
  assert.match(check.detail, /APPROVAL_TG_TOKEN and APPROVAL_TG_CHAT are unset/u);
  assert.equal(check.fix, undefined);
  assert.equal(run.code, 0);
  // Nothing was probed.
  assert.equal(mock.requests.length, requestsBefore);
});

test("doctor: half-configured telegram names the missing variable and still skips", async () => {
  const { home } = healthy();
  const check = checkNamed(
    await runCli(["doctor", "--json", "--root", makeRoot("fresh")], home, {
      APPROVAL_HUMAN: "human:carter",
      APPROVAL_TG_TOKEN: TOKEN,
    }),
    "telegram",
  );
  assert.equal(check.status, "skip");
  assert.match(check.detail, /APPROVAL_TG_CHAT is unset/u);
});

test("doctor: a rejected token fails with a token fix and never leaks the token", async () => {
  const { home } = healthy();

  const run = await runCli(
    ["doctor", "--json", "--root", makeRoot("fresh"), "--api-base", assertLocal(mock.url)],
    home,
    { ...TG_ENV, APPROVAL_TG_TOKEN: "9999999:AA-wrong-token-entirely" },
  );

  const check = checkNamed(run, "telegram");
  assert.equal(check.status, "fail");
  assert.match(check.detail, /refused/u);
  assert.match(check.fix ?? "", /@BotFather|not valid/u);
  assert.equal(run.code, 1);
  assert.ok(!run.stdout.includes("9999999:AA-wrong-token-entirely"));
});

test("doctor: an unreachable Bot API is a network failure, not a bad token", async () => {
  const { home } = healthy();
  const dead = await freePort();

  const run = await runCli(
    [
      "doctor",
      "--json",
      "--root",
      makeRoot("fresh"),
      "--api-base",
      assertLocal(`http://127.0.0.1:${dead}`),
    ],
    home,
    TG_ENV,
  );

  const check = checkNamed(run, "telegram");
  assert.equal(check.status, "fail");
  assert.match(check.detail, /failed/u);
  assert.match(check.fix ?? "", /network reachability/u);
  assert.ok(!run.stdout.includes(TOKEN));
  assert.equal(run.code, 1);
});

// ---------------------------------------------------------------------------
// 6. web port
// ---------------------------------------------------------------------------

test("doctor: a held port is a pass with a note, not a failure", async () => {
  const { home, port } = healthy();
  const holder = await holdPort(port);
  try {
    const run = await runCli(["doctor", "--json", "--root", makeRoot("fresh")], home, GREEN_ENV);
    const check = checkNamed(run, "web-port");
    assert.equal(check.status, "pass");
    assert.match(check.detail, /already held/u);
    assert.match(check.detail, new RegExp(`127\\.0\\.0\\.1:${port}`, "u"));
    assert.equal(check.fix, undefined);
  } finally {
    await new Promise<void>((resolve) => holder.close(() => resolve()));
  }
});

test("doctor: the probed port comes from the policy, and the default when absent", async () => {
  const { home, port } = healthy();
  const configured = checkNamed(
    await runCli(["doctor", "--json", "--root", makeRoot("fresh")], home, GREEN_ENV),
    "web-port",
  );
  assert.match(configured.detail, new RegExp(`127\\.0\\.0\\.1:${port}\\b`, "u"));

  // A policy with no channels block falls back to the documented default.
  counter += 1;
  const bare = join(scratch, `home-bare-${counter}`);
  mkdirSync(join(bare, ".approval", "log"), { recursive: true });
  writeFileSync(join(bare, "APPROVAL.md"), policyWith(port).split("channels:")[0] as string);
  const fallback = checkNamed(
    await runCli(["doctor", "--json", "--root", makeRoot("fresh")], bare, GREEN_ENV),
    "web-port",
  );
  assert.match(fallback.detail, /127\.0\.0\.1:4680/u);
});

/**
 * EACCES is not simulated. Producing it requires a privileged port (< 1024),
 * and a test suite that must not run as root cannot ask for one portably — on a
 * developer's macOS box binding 80 fails with EACCES, in a root container it
 * succeeds. The branch is therefore covered by the shape of the code and by
 * this note rather than by a test that would be a coin flip on the CI runner.
 * What IS pinned above is the decision that actually shapes behaviour: a held
 * port passes, and only a bind error fails.
 */
test("doctor: a nonsense policy port falls back to the default rather than crashing", async () => {
  // Port 0 would be "pick one for me" at bind time, so it is not usable as a
  // negative case either; the reachable negative is a port outside the range,
  // which node rejects at listen() with a RangeError rather than an errno.
  const port = await freePort();
  const home = await makeHome({ port });
  writeFileSync(join(home, "APPROVAL.md"), policyWith(70_000));
  const check = checkNamed(
    await runCli(["doctor", "--json", "--root", makeRoot("fresh")], home, GREEN_ENV),
    "web-port",
  );
  // An out-of-range port in the policy is ignored by policyWebPort (which fails
  // closed to null), so the default is probed instead — the check must still
  // answer, and must never crash on a nonsense policy value.
  assert.equal(check.status, "pass");
  assert.match(check.detail, /127\.0\.0\.1:4680/u);
});

// ---------------------------------------------------------------------------
// payload-store (APRV-35)
// ---------------------------------------------------------------------------

test("doctor: a writable payload store passes and counts what it holds", async () => {
  const port = await freePort();
  const home = await makeHome({ port });
  const storeDir = join(home, ".approval", "payloads");
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(join(storeDir, `${"a".repeat(64)}.json`), '{"body":"x"}');

  const run = await runCli(["doctor", "--json", "--root", makeRoot("fresh")], home, GREEN_ENV);
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  const check = checkNamed(run, "payload-store");
  assert.equal(check.status, "pass");
  assert.equal(check.fix, undefined);
  assert.match(check.detail, /is writable and holds 1 payload file\(s\)/u);
  assert.match(check.detail, /CANNOT be rebuilt from the log/u);

  // The probe leaves nothing behind: the store still holds exactly the one file.
  assert.deepEqual(readdirSync(storeDir), [`${"a".repeat(64)}.json`]);
});

test("doctor: an existing payload store that cannot be written fails with a fix", async (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    // Root ignores the mode bits, so the probe would succeed and the case would
    // assert nothing. Skipped rather than faked.
    t.skip("running as root: an unwritable directory cannot be simulated with mode bits");
    return;
  }

  const port = await freePort();
  const home = await makeHome({ port });
  const storeDir = join(home, ".approval", "payloads");
  mkdirSync(storeDir, { recursive: true });
  const before = readFileSync(logPathOf(home));
  chmodSync(storeDir, 0o555);

  try {
    const run = await runCli(["doctor", "--json", "--root", makeRoot("fresh")], home, GREEN_ENV);
    assert.equal(run.code, 1, `${run.stdout}${run.stderr}`);
    const parsed = parseDoctor(run);
    assert.equal(parsed.ok, false);
    const check = checkNamed(run, "payload-store");
    assert.equal(check.status, "fail");
    assert.match(check.detail, /exists but is not writable/u);
    assert.match(check.detail, /payload-store-failed/u);
    assert.match(check.detail, /CANNOT be rebuilt from the log/u);
    assert.ok(check.fix !== undefined && check.fix.includes(storeDir));

    // A failing check is still a report: doctor repaired nothing and wrote
    // nothing, including to the log.
    assert.deepEqual(readFileSync(logPathOf(home)), before);
    assert.deepEqual(readdirSync(storeDir), []);
  } finally {
    chmodSync(storeDir, 0o755);
  }
});

// ---------------------------------------------------------------------------
// Shape and hygiene
// ---------------------------------------------------------------------------

test("doctor: --json emits exactly one object with the frozen shape", async () => {
  const { home } = healthy();
  const run = await runCli(["doctor", "--json", "--root", makeRoot("fresh")], home, GREEN_ENV);

  assert.equal(run.stdout.trimEnd().split("\n").length, 1);
  const parsed = parseDoctor(run);
  assert.deepEqual(Object.keys(parsed), ["ok", "checks"]);
  assert.equal(typeof parsed.ok, "boolean");
  assert.equal(parsed.checks.length, 7);
  for (const entry of parsed.checks) {
    const keys = Object.keys(entry);
    assert.deepEqual(keys.slice(0, 3), ["check", "status", "detail"]);
    assert.ok(keys.length === 3 || (keys.length === 4 && keys[3] === "fix"));
    assert.ok(["pass", "fail", "skip"].includes(entry.status));
  }
});

test("doctor: usage errors and --help behave like every other verb", async () => {
  const { home } = healthy();

  const unknown = await runCli(["doctor", "--nope"], home, GREEN_ENV);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown flag --nope/u);

  const unknownJson = await runCli(["doctor", "--nope", "--json"], home, GREEN_ENV);
  assert.equal(unknownJson.code, 2);
  assert.equal(unknownJson.stdout, "");
  assert.equal(
    (JSON.parse(unknownJson.stderr) as { error: { code: string } }).error.code,
    "usage",
  );

  const positional = await runCli(["doctor", "surprise"], home, GREEN_ENV);
  assert.equal(positional.code, 2);
  assert.match(positional.stderr, /unexpected argument/u);

  const help = await runCli(["doctor", "--help"], home, GREEN_ENV);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /approval doctor — environment sanity in one verb/u);
  assert.match(help.stdout, /APPENDS NOTHING/u);
  assert.match(help.stdout, /TEST-ONLY/u);

  const root = await runCli(["--help"], home, GREEN_ENV);
  assert.match(root.stdout, /approval doctor/u);
});

test("doctor: the log is byte-identical after every run, healthy or not", async () => {
  const { home } = healthy();
  const before = readFileSync(logPathOf(home));

  const runs: { args: string[]; env: Record<string, string> }[] = [
    { args: ["doctor", "--root", makeRoot("fresh")], env: GREEN_ENV },
    { args: ["doctor", "--json", "--root", makeRoot("stale")], env: GREEN_ENV },
    {
      args: [
        "doctor",
        "--json",
        "--root",
        makeRoot("unbuilt"),
        "--api-base",
        assertLocal(mock.url),
      ],
      env: TG_ENV,
    },
  ];
  for (const entry of runs) {
    await runCli(entry.args, home, entry.env);
    assert.deepEqual(
      readFileSync(logPathOf(home)),
      before,
      `${entry.args.join(" ")} changed the log`,
    );
  }

  // And `approval log verify` still says clean afterwards.
  const verified = await runCli(["log", "verify"], home, GREEN_ENV);
  assert.equal(verified.code, 0, verified.stderr);
});

test("doctor: --log, --policy and --dir point the checks at other trees", async () => {
  const { home } = healthy();
  counter += 1;
  const elsewhere = join(scratch, `elsewhere-${counter}`);
  mkdirSync(elsewhere, { recursive: true });

  // Run from a directory with no policy and no log, pointed at the healthy one.
  const run = await runCli(
    [
      "doctor",
      "--json",
      "--root",
      makeRoot("fresh"),
      "--dir",
      home,
      "--log",
      logPathOf(home),
    ],
    elsewhere,
    GREEN_ENV,
  );
  assert.equal(checkNamed(run, "attestation").status, "pass");
  assert.equal(checkNamed(run, "log").status, "pass");

  // --policy wins outright over discovery.
  const explicit = await runCli(
    [
      "doctor",
      "--json",
      "--root",
      makeRoot("fresh"),
      "--policy",
      join(home, "APPROVAL.md"),
      "--log",
      logPathOf(home),
    ],
    elsewhere,
    GREEN_ENV,
  );
  assert.equal(checkNamed(explicit, "attestation").status, "pass");
});
