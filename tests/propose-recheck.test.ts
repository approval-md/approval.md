/**
 * APRV-445, the scoped recheck of the refutation round.
 *
 *   B    `wait` voids a grant only where its spend enforces `policy-drift`: a
 *        token grant `approval run` still spends after a re-attest reads
 *        `granted`, and `wait && run` keeps working.
 *   SF1  `propose` decides inside the append: eight identical proposals racing
 *        on a void key withdraw it once and ask once, and a stale request
 *        cannot be appended over a fresh grant.
 *   L-a  a policy-path `start` after a withdrawal reads `executed`, and a call
 *        that appended a withdrawal is never `idempotent`.
 *   L-b  the id after `<class>:` is printable, with no whitespace or control.
 *   L-c  the in-memory registration route refuses the `propose:` namespace.
 *   L-d  `cli.js` matches `hook hermes` after `--no-color`, and its exit guard
 *        turns a silent non-zero exit into the block directive.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  attestedPolicySha256,
  decide,
  propose,
  proposedTaskId,
  readGateRecords,
  register,
  request,
  requestStanding,
  withdraw,
} from "../src/core/gate.js";
import { payloadHash } from "../src/core/payload.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));
const BIN = fileURLToPath(new URL("../../cli.js", import.meta.url));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-propose-recheck-")));
let counter = 0;
after(() => rmSync(scratch, { recursive: true, force: true }));

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function env(): NodeJS.ProcessEnv {
  const out = { ...process.env };
  delete out["APPROVAL_HUMAN"];
  return out;
}

function runCli(args: string[], cwd: string, opts: { input?: string; entry?: string; node?: string[] } = {}): Run {
  const result = spawnSync(process.execPath, [...(opts.node ?? []), opts.entry ?? CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: env(),
    input: opts.input ?? "",
  });
  assert.equal(result.error, undefined);
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function runAsync(args: string[], cwd: string): Promise<Run> {
  return new Promise((settle) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], { cwd, env: env() });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("close", (code) => settle({ code: code ?? -1, stdout, stderr }));
  });
}

function policyText(ttl: string, inferred = "manual", extra: string[] = []): string {
  return [
    "```yaml approval-policy",
    'version: "0.1"',
    "defaults:",
    "  autonomy: manual",
    `  approval_ttl: "${ttl}"`,
    "classes:",
    "  intent.publish.*:",
    "    autonomy: manual",
    "    agent_may_request: true",
    "  intent.publish.inferred.index:",
    `    autonomy: ${inferred}`,
    "  deps.add:",
    "    autonomy: manual",
    ...extra,
    "```",
    "",
  ].join("\n");
}

const AGENT = "agent:av-resident";
const INFERRED = "intent.publish.inferred.index";
const TEXT = { text: "lunch on the beach?" };

function caseDir(text = policyText("72h")): string {
  counter += 1;
  const dir = join(scratch, `case-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "APPROVAL.md"), text, "utf8");
  attest(dir);
  return dir;
}

function attest(dir: string): void {
  assert.equal(runCli(["policy", "attest", "--as", "human:carter"], dir).code, 0);
}

function records(dir: string): Record<string, unknown>[] {
  const path = join(dir, ".approval", "log", "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function count(dir: string, event: string): number {
  return records(dir).filter((record) => record["event"] === event).length;
}

function proposeArgs(key: string, payload = JSON.stringify(TEXT)): string[] {
  return ["propose", "--class", INFERRED, "--key", key, "--summary", "s", "--payload-json", payload, "--as", AGENT, "--json"];
}

// ---------------------------------------------------------------------------
// B
// ---------------------------------------------------------------------------

test("B: a token grant that `approval run` still spends after a re-attest reads granted, and run spends it", () => {
  const dir = caseDir(policyText("1h"));
  const hash = runCli(["payload", "run", "--hash", "--", "true"], dir).stdout.trim();
  assert.match(hash, /^[0-9a-f]{64}$/u);
  writeFileSync(
    join(dir, "t.md"),
    [
      "---",
      "id: task-9",
      "title: t",
      "approval:",
      "  origin:",
      "    app: manual",
      '    created_by: "human:carter"',
      "  state: proposed",
      "  actions:",
      "    - class: deps.add",
      '      idempotency_key: "task-9:run"',
      `      payload_hash: "${hash}"`,
      "---",
      "",
    ].join("\n"),
    "utf8",
  );
  assert.equal(runCli(["register", "t.md", "--as", "agent:x"], dir).code, 0);
  assert.equal(runCli(["request", "task-9", "--action", "task-9:run", "--as", "agent:x"], dir).code, 0);
  const granted = runCli(["grant", "task-9:run", "--as", "human:carter", "--json"], dir);
  const token = String((JSON.parse(granted.stdout) as Record<string, unknown>)["token"]);

  writeFileSync(join(dir, "APPROVAL.md"), policyText("2h"), "utf8");
  attest(dir);

  const waited = runCli(["wait", "task-9", "--timeout", "0", "--json"], dir);
  assert.equal(waited.code, 0, waited.stderr);
  assert.equal((JSON.parse(waited.stdout) as Record<string, unknown>)["status"], "granted");
  const ran = runCli(["run", "task-9:run", "--token", token, "--as", "agent:x", "--", "true"], dir);
  assert.equal(ran.code, 0, ran.stderr);
});

// ---------------------------------------------------------------------------
// SF1
// ---------------------------------------------------------------------------

test("SF1: eight identical proposes racing on a void key withdraw it once and ask once", async () => {
  const dir = caseDir();
  const key = `${INFERRED}:race8`;
  assert.equal(runCli(proposeArgs(key), dir).code, 0);
  writeFileSync(join(dir, "APPROVAL.md"), policyText("48h"), "utf8");
  attest(dir);

  const runs = await Promise.all(Array.from({ length: 8 }, () => runAsync(proposeArgs(key), dir)));
  for (const run of runs) {
    assert.equal(run.code, 0, run.stderr);
    assert.equal((JSON.parse(run.stdout) as Record<string, unknown>)["state"], "requested");
  }
  assert.equal(count(dir, "approval.withdrawn"), 1, "more than one superseded withdrawal");
  assert.equal(count(dir, "approval.requested"), 2, "more than one re-asked request");
  assert.equal(runCli(["log", "verify", "--json"], dir).code, 0);
});

test("SF1: a stale request cannot be appended over a fresh grant, and a stale withdrawal cannot retract a live re-ask", () => {
  const dir = caseDir();
  const logPath = join(dir, ".approval", "log", "events.jsonl");
  const options = { policy: { file: join(dir, "APPROVAL.md") } };
  const key = `${INFERRED}:clobber`;
  const task = proposedTaskId(AGENT, INFERRED, key);
  const input = { cls: INFERRED, actionKey: key, summary: "s", payload: TEXT };
  assert.equal(propose(logPath, input, AGENT, options).ok, true);
  assert.equal(decide(logPath, key, "grant", "human:carter", options).ok, true);

  // The request() a caller that read the log before the grant would make.
  const stale = request(
    logPath,
    { task, actionKey: key, cls: INFERRED, summary: "s", payload: { value: TEXT }, execution: "harness", agentProposal: true },
    AGENT,
    options,
  );
  assert.equal(stale.ok, false);
  if (stale.ok) throw new Error("unreachable");
  assert.equal(stale.code, "already-decided");
  const read = readGateRecords(logPath);
  if (!read.ok) throw new Error(read.message);
  assert.equal(
    requestStanding(read.records, key, new Date().toISOString(), 72 * 3_600_000, attestedPolicySha256(read.records, options)),
    "granted",
  );

  // A live request routed under the policy in force is not void, so a
  // `superseded` withdrawal judged on a stale reading is refused.
  const key2 = `${INFERRED}:live`;
  assert.equal(propose(logPath, { ...input, actionKey: key2 }, AGENT, options).ok, true);
  const retract = withdraw(logPath, key2, AGENT, { ...options, onlyIfVoid: true, reason: "superseded" });
  assert.equal(retract.ok, false);
  if (retract.ok) throw new Error("unreachable");
  assert.equal(retract.code, "duplicate-request");
});

// ---------------------------------------------------------------------------
// L-a
// ---------------------------------------------------------------------------

test("L-a: a policy-path start after a withdrawal reads executed; a call that withdrew is not idempotent", () => {
  const dir = caseDir();
  const key = `${INFERRED}:la`;
  const task = proposedTaskId(AGENT, INFERRED, key);
  assert.equal(runCli(proposeArgs(key), dir).code, 0);
  assert.equal(runCli(["withdraw", task, "--action", key, "--as", AGENT], dir).code, 0);
  writeFileSync(join(dir, "APPROVAL.md"), policyText("72h", "autonomous"), "utf8");
  attest(dir);
  assert.equal(
    runCli(["start", task, "--action", key, "--payload-json", JSON.stringify(TEXT), "--as", AGENT], dir).code,
    0,
  );
  const waited = runCli(["wait", task, "--timeout", "0", "--json"], dir);
  assert.equal(waited.code, 0, waited.stderr);
  const parsed = JSON.parse(waited.stdout) as { status: string; actions: Array<{ state: string }> };
  assert.equal(parsed.status, "executed");
  assert.equal(parsed.actions[0]?.state, "executed");

  // A pending proposal voided by a re-tiering re-attest: the call withdraws it
  // and the class now proceeds on its own; it appended, so it is not idempotent.
  const dir2 = caseDir();
  const key2 = `${INFERRED}:la2`;
  assert.equal(runCli(proposeArgs(key2), dir2).code, 0);
  writeFileSync(join(dir2, "APPROVAL.md"), policyText("72h", "autonomous"), "utf8");
  attest(dir2);
  const again = runCli(proposeArgs(key2), dir2);
  assert.equal(again.code, 0, again.stderr);
  const answer = JSON.parse(again.stdout) as Record<string, unknown>;
  assert.equal(answer["decision"], "autonomous");
  assert.equal(answer["idempotent"], false);
  assert.equal(count(dir2, "approval.withdrawn"), 1);
});

// ---------------------------------------------------------------------------
// L-b, L-c
// ---------------------------------------------------------------------------

test("L-b: the id after <class>: is printable, with no whitespace or control characters", () => {
  const dir = caseDir();
  for (const id of ["has space", "tab\there", "bell\u0007", "zero​width", "nl\nx"]) {
    const run = runCli(proposeArgs(`${INFERRED}:${id}`), dir);
    assert.equal(run.code, 2, JSON.stringify(id));
    assert.match(run.stderr, /key-class-mismatch/u, JSON.stringify(id));
  }
  assert.equal(runCli(proposeArgs(`${INFERRED}:01928c3e-ünïcode-ok`), dir).code, 0);
});

test("L-c: an in-memory registration (the muse route's call) may not claim the propose: namespace", () => {
  const dir = caseDir();
  const logPath = join(dir, ".approval", "log", "events.jsonl");
  const result = register(
    logPath,
    {
      task: `propose:${"a".repeat(32)}`,
      envelope: {
        origin: { app: "muse", created_by: AGENT },
        state: "proposed",
        actions: [{ class: INFERRED, idempotency_key: `${INFERRED}:x`, payload_hash: payloadHash(TEXT) }],
      },
    },
    AGENT,
  );
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.code, "task-is-proposal");
});

// ---------------------------------------------------------------------------
// L-d
// ---------------------------------------------------------------------------

test("L-d: cli.js matches `hook hermes` after --no-color, and turns a silent non-zero exit into the block", () => {
  counter += 1;
  const bare = join(scratch, `bare-${String(counter)}`);
  mkdirSync(bare, { recursive: true });
  copyFileSync(BIN, join(bare, "cli.js"));
  const colorless = runCli(["--no-color", "hook", "hermes"], bare, { entry: join(bare, "cli.js"), input: "{}" });
  assert.equal(colorless.code, 2, colorless.stderr);
  assert.equal((JSON.parse(colorless.stdout) as Record<string, unknown>)["action"], "block");

  // Something forces exit 1 on the way out: Hermes would read a bare exit 1 as
  // an allow, so the bin's exit guard makes it exit 2.
  const dir = caseDir();
  const preload = join(scratch, "exit-one.mjs");
  // `beforeExit`, not a timer. A `setTimeout(0)` in a preload can fire while the
  // ESM loader is still fetching cli.js under load, before the bin's exit guard
  // exists (merge-queue run 37192542666: exit 1). Nothing runs before the bin in
  // production, so that exit was a test artefact. `beforeExit` fires only once
  // the hook has answered and the loop is empty, which is the case named here.
  writeFileSync(preload, 'process.once("beforeExit", () => process.exit(1));\n', "utf8");
  const silent = runCli(["hook", "hermes", "--as", "agent:h"], dir, {
    entry: BIN,
    node: ["--import", pathToFileURL(preload).href],
    input: "{}",
  });
  assert.equal(silent.code, 2, silent.stderr);
  // The hook answered (a block for this empty event) and then something forced
  // exit 1: the guard leaves the directive and makes the exit 2.
  assert.equal((JSON.parse(silent.stdout.trim().split("\n")[0] as string) as Record<string, unknown>)["action"], "block");

  // And when nothing was printed at all, the guard prints the directive itself.
  const early = join(scratch, "exit-early.mjs");
  writeFileSync(
    early,
    [
      "export async function resolve(specifier, context, next) {",
      '  if (specifier.endsWith("/dist/src/cli/main.js")) process.exit(1);',
      "  return next(specifier, context);",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  const register = join(scratch, "exit-early-register.mjs");
  writeFileSync(register, `import { register } from "node:module";\nregister(${JSON.stringify(pathToFileURL(early).href)});\n`, "utf8");
  const quiet = runCli(["hook", "hermes", "--as", "agent:h"], dir, {
    entry: BIN,
    node: ["--import", pathToFileURL(register).href],
    input: "{}",
  });
  assert.equal(quiet.code, 2, quiet.stderr);
  const said = JSON.parse(quiet.stdout) as Record<string, unknown>;
  assert.equal(said["action"], "block");
  assert.match(String(said["message"]), /exited 1 without a verdict/u);

  // Any other verb is untouched by the guard.
  const other = runCli(["--version"], dir, { entry: BIN, node: ["--import", pathToFileURL(preload).href] });
  assert.equal(other.code, 1, "the guard rewrote another verb's exit code");
  assert.equal(other.stdout.includes('"block"'), false);
});

test("recheck 3: a proposal whose every append is refused by a moving log ends `contended`, never `already-decided`", () => {
  const dir = caseDir();
  const logPath = join(dir, ".approval", "log", "events.jsonl");
  const policyPath = join(dir, "APPROVAL.md");
  const key = `${INFERRED}:contended`;
  const input = { cls: INFERRED, actionKey: key, summary: "s", payload: TEXT };
  assert.equal(propose(logPath, input, AGENT, { policy: { file: policyPath } }).ok, true);
  const first = readFileSync(policyPath);
  writeFileSync(policyPath, policyText("48h"), "utf8");
  attest(dir);
  const second = readFileSync(policyPath);

  // Each attempt reads the policy three times: propose's own read (it sees the
  // pending request as void under the policy in force), the withdrawal's TTL
  // read, and the withdrawal's in-append void check. Answering that third read
  // with the superseded bytes makes every in-append check refuse, which is what
  // a log another writer keeps moving looks like from inside one call.
  let reads = 0;
  const result = propose(logPath, input, AGENT, {
    policy: {
      file: policyPath,
      read: () => {
        reads += 1;
        return reads % 3 === 0 ? first : second;
      },
    },
  });
  assert.equal(result.ok, false, JSON.stringify(result));
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.code, "contended");
  assert.equal(count(dir, "approval.withdrawn"), 0, "a contended call withdrew something");
});
