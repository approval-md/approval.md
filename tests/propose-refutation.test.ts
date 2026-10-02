/**
 * APRV-445, the refutation round: what `propose`, `start` and `wait` do once a
 * proposal's answer can no longer be used, and the edges the review found.
 *
 *   B1  a granted-but-unspent proposal is not stuck: `wait` reports `void`
 *       (exit 7) for a grant or pending request pinned to a re-attested policy
 *       and `expired` (exit 3) for a grant whose window lapsed, and the same
 *       `propose` call re-files. The "grant at hour 71 of 72" case is pinned
 *       with injected clocks.
 *   S1  a plain `request` (or a task FILE) in the `propose:` namespace refuses.
 *   S3  `cli.js` blocks for `hook hermes` when the runtime cannot load.
 *   S4  the key must begin with `<class>:`.
 *   S5  a withdrawn request does not bind the key to the grant path.
 *   L1  `--withdraw-on-timeout` with `--timeout 0` is a usage error.
 *   L5  two identical proposals racing to register are one proposal.
 *   L6  key and summary caps; lone surrogates and non-finite numbers.
 *   L7  `propose` after `start` answers `state: executed`.
 *   L8  a re-run of `init` says it appended the payload-store ignore line.
 *   L9  `start` refuses a task `propose` did not register.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
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
import { fileURLToPath, pathToFileURL } from "node:url";

import { main } from "../src/cli/main.js";
import { appendAttestation } from "../src/core/attest.js";
import {
  attestedPolicySha256,
  decide,
  propose,
  proposedTaskId,
  readGateRecords,
  register,
  requestStanding,
} from "../src/core/gate.js";
import { payloadHash } from "../src/core/payload.js";
import { at, fixedClock, T0 } from "./scenario.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
/** dist/tests/x.js -> <repo>/cli.js */
const BIN = fileURLToPath(new URL("../../cli.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-propose-ref-")));
let counter = 0;

after(() => rmSync(scratch, { recursive: true, force: true }));

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string, opts: { input?: string; entry?: string; node?: string[] } = {}): Run {
  const env = { ...process.env };
  delete env["APPROVAL_HUMAN"];
  const result = spawnSync(process.execPath, [...(opts.node ?? []), opts.entry ?? CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env,
    input: opts.input ?? "",
  });
  assert.equal(result.error, undefined);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function policyText(ttl: string, statedAutonomy = "autonomous", inferredAutonomy = "manual"): string {
  return [
    "# Policy",
    "",
    "```yaml approval-policy",
    'version: "0.1"',
    "defaults:",
    "  autonomy: manual",
    `  approval_ttl: "${ttl}"`,
    "  on_expiry: reject",
    "classes:",
    "  intent.publish.*:",
    "    autonomy: manual",
    "    agent_may_request: true",
    "  intent.publish.inferred.index:",
    `    autonomy: ${inferredAutonomy}`,
    "  intent.publish.stated.index:",
    `    autonomy: ${statedAutonomy}`,
    "```",
    "",
  ].join("\n");
}

const AGENT = "agent:av-resident";
const INFERRED = "intent.publish.inferred.index";
const STATED = "intent.publish.stated.index";
const TEXT = { text: "Anyone up for a sunrise swim tomorrow?" };

function caseDir(text = policyText("72h")): string {
  counter += 1;
  const dir = join(scratch, `case-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), text, "utf8");
  reattest(dir);
  return dir;
}

function reattest(dir: string): void {
  const run = runCli(["policy", "attest", "--as", "human:carter"], dir);
  assert.equal(run.code, 0, run.stderr);
}

function events(dir: string): string[] {
  const path = join(dir, ".approval", "log", "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => String((JSON.parse(line) as Record<string, unknown>)["event"]));
}

function proposeRun(dir: string, cls: string, key: string, extra: { payload?: string; summary?: string } = {}): Run {
  return runCli(
    [
      "propose", "--class", cls, "--key", key,
      "--summary", extra.summary ?? "Publish an intention",
      "--payload-json", extra.payload ?? JSON.stringify(TEXT),
      "--as", AGENT, "--json",
    ],
    dir,
  );
}

function out(run: Run): Record<string, unknown> {
  return JSON.parse(run.stdout) as Record<string, unknown>;
}

function err(run: Run): Record<string, unknown> {
  const parsed = JSON.parse(run.stderr) as Record<string, unknown>;
  return (parsed["error"] ?? parsed) as Record<string, unknown>;
}

function startRun(dir: string, task: string, key: string, payload = JSON.stringify(TEXT)): Run {
  return runCli(["start", task, "--action", key, "--payload-json", payload, "--as", AGENT, "--json"], dir);
}

// ---------------------------------------------------------------------------
// B1
// ---------------------------------------------------------------------------

test("B1: a grant voided by a re-attest reads `void` (exit 7), start refuses it, and propose re-files", () => {
  const dir = caseDir();
  const key = `${INFERRED}:drift-granted`;
  const task = proposedTaskId(AGENT, INFERRED, key);
  assert.equal(proposeRun(dir, INFERRED, key).code, 0);
  assert.equal(runCli(["grant", key, "--as", "human:carter"], dir).code, 0);

  // The human edits the policy and attests it: every routing under the old
  // hash is void, the grant included.
  writeFileSync(join(dir, "APPROVAL.md"), policyText("48h"), "utf8");
  reattest(dir);

  const waited = runCli(["wait", task, "--timeout", "0", "--json"], dir);
  assert.equal(waited.code, 7, waited.stderr);
  assert.equal(out(waited)["status"], "void");
  assert.equal((out(waited)["actions"] as Array<Record<string, unknown>>)[0]?.["state"], "void");

  const spent = startRun(dir, task, key);
  assert.equal(spent.code, 1);
  assert.equal(err(spent)["code"], "policy-drift");

  const refiled = proposeRun(dir, INFERRED, key);
  assert.equal(refiled.code, 0, refiled.stderr);
  assert.equal(out(refiled)["state"], "requested");
  assert.equal(out(refiled)["idempotent"], false);
  assert.equal(events(dir).filter((event) => event === "approval.requested").length, 2);

  // The new question is pending under the policy in force, and a grant on it spends.
  assert.equal(runCli(["wait", task, "--timeout", "0", "--json"], dir).code, 6);
  assert.equal(runCli(["grant", key, "--as", "human:carter"], dir).code, 0);
  assert.equal(runCli(["wait", task, "--timeout", "0", "--json"], dir).code, 0);
  assert.equal(startRun(dir, task, key).code, 0);
});

test("B1: a pending proposal under a re-attested policy reads `void`, and propose withdraws and re-asks it", () => {
  const dir = caseDir();
  const key = `${INFERRED}:drift-pending`;
  const task = proposedTaskId(AGENT, INFERRED, key);
  assert.equal(proposeRun(dir, INFERRED, key).code, 0);
  writeFileSync(join(dir, "APPROVAL.md"), policyText("48h"), "utf8");
  reattest(dir);

  const waited = runCli(["wait", task, "--timeout", "0", "--json"], dir);
  assert.equal(waited.code, 7, waited.stderr);
  assert.equal(out(waited)["status"], "void");

  const refiled = proposeRun(dir, INFERRED, key);
  assert.equal(refiled.code, 0, refiled.stderr);
  assert.equal(out(refiled)["state"], "requested");
  assert.deepEqual(
    events(dir).filter((event) => event.startsWith("approval.")),
    ["approval.requested", "approval.withdrawn", "approval.requested"],
  );
  assert.equal(runCli(["wait", task, "--timeout", "0", "--json"], dir).code, 6);
});

test("B1: a grant whose window lapsed reads `expired` (exit 3), and propose re-files", async () => {
  // The hour-71-of-72 shape, scaled to seconds so a real CLI runs it.
  const dir = caseDir(policyText("3s"));
  const key = `${INFERRED}:lapsed-grant`;
  const task = proposedTaskId(AGENT, INFERRED, key);
  assert.equal(proposeRun(dir, INFERRED, key).code, 0);
  await new Promise((settle) => setTimeout(settle, 1500));
  assert.equal(runCli(["grant", key, "--as", "human:carter"], dir).code, 0);
  assert.equal(runCli(["wait", task, "--timeout", "0", "--json"], dir).code, 0, "inside the window it is granted");
  await new Promise((settle) => setTimeout(settle, 2500));

  const waited = runCli(["wait", task, "--timeout", "0", "--json"], dir);
  assert.equal(waited.code, 3, waited.stderr);
  assert.equal(out(waited)["status"], "expired");
  assert.equal(err(startRun(dir, task, key))["code"], "expired");

  const refiled = proposeRun(dir, INFERRED, key);
  assert.equal(refiled.code, 0, refiled.stderr);
  assert.equal(out(refiled)["state"], "requested");
  assert.equal(out(refiled)["idempotent"], false);
});

test("B1: a grant at hour 71 of a 72 h window is spendable at 71, expired at 73, and re-filed at 73", () => {
  counter += 1;
  const dir = join(scratch, `core-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  const policyPath = join(dir, "APPROVAL.md");
  writeFileSync(policyPath, policyText("72h"), "utf8");
  const logPath = join(dir, ".approval", "log", "events.jsonl");
  assert.equal(appendAttestation(logPath, policyPath, "human:carter", { clock: fixedClock(T0) }).ok, true);
  const options = (ts: string) => ({ policy: { file: policyPath }, clock: fixedClock(ts) });
  const key = `${INFERRED}:hour-71`;
  const input = { cls: INFERRED, actionKey: key, summary: "s", payload: TEXT };

  const first = propose(logPath, input, AGENT, options(at(1)));
  assert.equal(first.ok, true, JSON.stringify(first));
  const granted = decide(logPath, key, "grant", "human:carter", options(at(71 * 60)));
  assert.equal(granted.ok, true, JSON.stringify(granted));

  const standingAt = (ts: string): string => {
    const read = readGateRecords(logPath);
    if (!read.ok) throw new Error(read.message);
    return requestStanding(read.records, key, ts, 72 * 3_600_000, attestedPolicySha256(read.records, options(ts)));
  };
  assert.equal(standingAt(at(71 * 60 + 30)), "granted");
  assert.equal(standingAt(at(73 * 60)), "expired");

  // A retry at hour 71 is a retry; at hour 73 the question is asked again.
  const retry = propose(logPath, input, AGENT, options(at(71 * 60 + 30)));
  assert.equal(retry.ok && retry.idempotent && retry.state === "granted", true, JSON.stringify(retry));
  const refiled = propose(logPath, input, AGENT, options(at(73 * 60)));
  assert.equal(refiled.ok && !refiled.idempotent && refiled.state === "requested", true, JSON.stringify(refiled));
  assert.equal(standingAt(at(73 * 60 + 1)), "requested");
});

test("L1: --withdraw-on-timeout cannot ride a zero wait", () => {
  const dir = caseDir();
  const key = `${INFERRED}:l1`;
  assert.equal(proposeRun(dir, INFERRED, key).code, 0);
  const run = runCli(
    ["wait", proposedTaskId(AGENT, INFERRED, key), "--timeout", "0", "--withdraw-on-timeout", "--as", AGENT, "--json"],
    dir,
  );
  assert.equal(run.code, 2);
  assert.match(String(err(run)["message"]), /--withdraw-on-timeout cannot be combined with --timeout 0/u);
  assert.equal(events(dir).includes("approval.withdrawn"), false);
});

// ---------------------------------------------------------------------------
// S1, S4, S5, L5, L6, L7, L9
// ---------------------------------------------------------------------------

test("S1: a plain request on a propose: task refuses task-is-proposal, and a task FILE may not claim the namespace", () => {
  const dir = caseDir(policyText("72h", "autonomous", "manual"));
  const key = `${INFERRED}:s1`;
  const task = proposedTaskId(AGENT, INFERRED, key);
  assert.equal(proposeRun(dir, INFERRED, key).code, 0);
  assert.equal(runCli(["withdraw", task, "--action", key, "--as", AGENT], dir).code, 0);
  const before = events(dir).length;
  const plain = runCli(["request", task, "--action", key, "--as", AGENT, "--json"], dir);
  assert.equal(plain.code, 1);
  assert.equal(err(plain)["code"], "task-is-proposal");
  assert.equal(events(dir).length, before);

  writeFileSync(
    join(dir, "t.md"),
    [
      "---",
      `id: "propose:${"f".repeat(32)}"`,
      "title: t",
      "approval:",
      "  origin:",
      "    app: manual",
      '    created_by: "human:carter"',
      "  state: proposed",
      "  actions:",
      "    - class: intent.publish.inferred.index",
      '      idempotency_key: "x:1"',
      "---",
      "",
    ].join("\n"),
    "utf8",
  );
  const registered = runCli(["register", "t.md", "--as", "human:carter", "--json"], dir);
  assert.equal(registered.code, 1, registered.stderr);
  assert.equal(err(registered)["code"], "task-is-proposal");
});

test("S4: the key must begin with <class>: and name something after it", () => {
  const dir = caseDir();
  for (const key of ["01928c3e-0000", `${STATED}:x`, `${INFERRED}:`, `${INFERRED}x:1`]) {
    const run = proposeRun(dir, INFERRED, key);
    assert.equal(run.code, 2, key);
    assert.equal(err(run)["code"], "key-class-mismatch", key);
  }
  assert.deepEqual(events(dir), ["policy.updated"]);
});

test("S5: a withdrawn request does not bind the key; after re-tiering to autonomous, start is the policy's", () => {
  const dir = caseDir(policyText("72h", "autonomous", "manual"));
  const key = `${INFERRED}:s5`;
  const task = proposedTaskId(AGENT, INFERRED, key);
  assert.equal(proposeRun(dir, INFERRED, key).code, 0);
  assert.equal(runCli(["withdraw", task, "--action", key, "--as", AGENT], dir).code, 0);
  writeFileSync(join(dir, "APPROVAL.md"), policyText("72h", "autonomous", "autonomous"), "utf8");
  reattest(dir);
  const started = startRun(dir, task, key);
  assert.equal(started.code, 0, started.stderr);
  assert.equal(out(started)["authorization"], "policy");

  // A LIVE request still binds: pending means the human decides first.
  const dir2 = caseDir();
  const key2 = `${INFERRED}:s5-live`;
  assert.equal(proposeRun(dir2, INFERRED, key2).code, 0);
  writeFileSync(join(dir2, "APPROVAL.md"), policyText("72h", "autonomous", "autonomous"), "utf8");
  reattest(dir2);
  const early = startRun(dir2, proposedTaskId(AGENT, INFERRED, key2), key2);
  assert.equal(early.code, 1);
  assert.notEqual(err(early)["code"], undefined);
  assert.equal(events(dir2).includes("execution.started"), false);
});

test("L5: two identical proposals racing to register are one proposal, answered idempotently", () => {
  counter += 1;
  const dir = join(scratch, `core-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  const policyPath = join(dir, "APPROVAL.md");
  writeFileSync(policyPath, policyText("72h"), "utf8");
  const logPath = join(dir, ".approval", "log", "events.jsonl");
  assert.equal(appendAttestation(logPath, policyPath, "human:carter").ok, true);
  const key = `${INFERRED}:race`;
  const task = proposedTaskId(AGENT, INFERRED, key);
  let raced = false;
  const result = propose(
    logPath,
    { cls: INFERRED, actionKey: key, summary: "s", payload: TEXT },
    AGENT,
    {
      policy: {
        file: policyPath,
        // The racing twin registers the identical task between this call's
        // read of the log and its own registration.
        read: (path: string) => {
          if (!raced) {
            raced = true;
            const twin = register(
              logPath,
              {
                task,
                envelope: {
                  origin: { app: "approval-propose", created_by: AGENT },
                  state: "proposed",
                  actions: [{ class: INFERRED, summary: "s", idempotency_key: key, payload_hash: payloadHash(TEXT) }],
                },
              },
              AGENT,
              // The twin is another `propose` call, which owns the namespace.
              { proposal: true },
            );
            assert.equal(twin.ok, true);
          }
          return readFileSync(path);
        },
      },
    },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.state, "requested");
  assert.equal(raced, true);
});

test("L6: key and summary caps, lone surrogates and non-finite numbers are usage errors", async () => {
  const dir = caseDir();
  const cases: Array<[string, { payload?: string; summary?: string }, RegExp]> = [
    [`${INFERRED}:${"k".repeat(1100)}`, {}, /--key is over 1024 bytes/u],
    [`${INFERRED}:sum`, { summary: "s".repeat(4097) }, /--summary is over 4096 bytes/u],
    [`${INFERRED}:sur`, { payload: '{"text":"\\ud800 lone"}' }, /lone UTF-16 surrogate at \$\.text/u],
    [`${INFERRED}:surk`, { payload: '{"\\udc00":"x"}' }, /lone UTF-16 surrogate in a key/u],
    [`${INFERRED}:inf`, { payload: '{"n":1e400}' }, /not finite/u],
  ];
  for (const [key, extra, message] of cases) {
    const run = proposeRun(dir, INFERRED, key, extra);
    assert.equal(run.code, 2, `${key.slice(0, 40)}: ${run.stderr}`);
    assert.match(String(err(run)["message"]), message);
  }
  assert.deepEqual(events(dir), ["policy.updated"]);

  // A spawned argv cannot carry a lone surrogate (the OS boundary replaces it),
  // but `approval serve` builds argv in-process from JSON, which can.
  let stderr = "";
  const code = await main(
    ["propose", "--class", INFERRED, "--key", `${INFERRED}:sum2`, "--summary", "bad \ud800",
      "--payload-json", JSON.stringify(TEXT), "--as", AGENT, "--json"],
    { cwd: dir, streams: { out: () => undefined, err: (text) => (stderr += text) } },
  );
  assert.equal(code, 2, stderr);
  assert.match(stderr, /--summary has a lone UTF-16 surrogate/u);
  assert.deepEqual(events(dir), ["policy.updated"]);
});

test("L7: propose after start answers state executed, on both paths", () => {
  const dir = caseDir();
  const auto = `${STATED}:l7`;
  assert.equal(proposeRun(dir, STATED, auto).code, 0);
  assert.equal(startRun(dir, proposedTaskId(AGENT, STATED, auto), auto).code, 0);
  const again = proposeRun(dir, STATED, auto);
  assert.equal(again.code, 0);
  assert.equal(out(again)["state"], "executed");
  assert.equal(out(again)["decision"], "autonomous");
  assert.equal(out(again)["idempotent"], true);

  const manual = `${INFERRED}:l7`;
  assert.equal(proposeRun(dir, INFERRED, manual).code, 0);
  assert.equal(runCli(["grant", manual, "--as", "human:carter"], dir).code, 0);
  assert.equal(startRun(dir, proposedTaskId(AGENT, INFERRED, manual), manual).code, 0);
  const after = proposeRun(dir, INFERRED, manual);
  assert.equal(out(after)["state"], "executed");
  assert.equal(out(after)["decision"], "requested");
});

test("L9: start refuses a task propose did not register", () => {
  const dir = caseDir();
  const run = startRun(dir, "task-042", "task-042:chaser");
  assert.equal(run.code, 1);
  assert.equal(err(run)["code"], "task-not-proposal");
});

test("L8: a re-run of init in an older scaffold says it appended the payload-store ignore line", () => {
  counter += 1;
  const dir = join(scratch, `init-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  assert.equal(runCli(["init"], dir).code, 0);
  const gitignore = join(dir, ".gitignore");
  writeFileSync(
    gitignore,
    readFileSync(gitignore, "utf8").split("\n").filter((line) => line !== ".approval/payloads/").join("\n"),
    "utf8",
  );
  const rerun = runCli(["init"], dir);
  assert.equal(rerun.code, 0, rerun.stderr);
  assert.match(rerun.stdout, /appended \.gitignore: \.approval\/payloads\//u);
  assert.ok(readFileSync(gitignore, "utf8").split("\n").includes(".approval/payloads/"));
});

// ---------------------------------------------------------------------------
// S3: the bin blocks for `hook hermes` when the runtime cannot load
// ---------------------------------------------------------------------------

test("S3: cli.js answers `hook hermes` with the block directive when dist/ is missing", () => {
  counter += 1;
  const bare = join(scratch, `bare-${String(counter)}`);
  mkdirSync(bare, { recursive: true });
  copyFileSync(BIN, join(bare, "cli.js"));
  const hermes = runCli(["hook", "hermes"], bare, { entry: join(bare, "cli.js"), input: "{}" });
  assert.equal(hermes.code, 2, hermes.stderr);
  const parsed = JSON.parse(hermes.stdout) as Record<string, unknown>;
  assert.equal(parsed["action"], "block");
  assert.match(String(parsed["message"]), /not built/u);

  // Every other invocation keeps exit 4 and an empty stdout.
  const other = runCli(["hook", "claude-code"], bare, { entry: join(bare, "cli.js"), input: "{}" });
  assert.equal(other.code, 4);
  assert.equal(other.stdout, "");
});

test("S3: cli.js answers `hook hermes` with the block directive when a static import of main throws", () => {
  const dir = caseDir();
  const hooks = join(scratch, "break-static-hooks.mjs");
  writeFileSync(
    hooks,
    [
      "export async function resolve(specifier, context, next) {",
      '  if (specifier === "./records.js" && String(context.parentURL).endsWith("/cli/main.js")) {',
      '    throw new Error("simulated: a static import of main.js failed");',
      "  }",
      "  return next(specifier, context);",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  const registerFile = join(scratch, "break-static-register.mjs");
  writeFileSync(
    registerFile,
    `import { register } from "node:module";\nregister(${JSON.stringify(pathToFileURL(hooks).href)});\n`,
    "utf8",
  );
  const node = ["--import", pathToFileURL(registerFile).href];
  const hermes = runCli(["hook", "hermes", "--as", "agent:hermes"], dir, { entry: BIN, node, input: "{}" });
  assert.equal(hermes.code, 2, hermes.stderr);
  const parsed = JSON.parse(hermes.stdout) as Record<string, unknown>;
  assert.equal(parsed["action"], "block");
  assert.match(String(parsed["message"]), /simulated: a static import of main\.js failed/u);

  const other = runCli(["--version"], dir, { entry: BIN, node });
  assert.notEqual(other.code, 0);
  assert.equal(other.stdout, "");
});
