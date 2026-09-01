/**
 * `human-only`, the autonomy level above `manual` (APRV-185).
 *
 * The level declares that a class is reserved to human hands: a person performs
 * the action outside agent execution entirely. So there is nothing for the gate
 * to transact in, and the claims under test are claims about ABSENCE — that no
 * verb of this runtime mints or withdraws authority for such a class, and that
 * the refusal is its own machine-readable code rather than a rejection an agent
 * would sensibly retry.
 *
 * Six properties, each a property rather than an example:
 *
 * 1. **The grammar.** A class rule may declare `human-only`, and so may
 *    `defaults.autonomy` — unlike `supervised-live`, which carries a required
 *    rate `defaults` has nowhere to hold. Both rates are forbidden on it, and
 *    the attempt fails the whole policy CLOSED, which is `live_rate`'s
 *    convention mirrored deliberately.
 * 2. **The fail-closed target is still `manual`.** `human-only` heads the
 *    strictness ordering and is NOT what an unparseable policy resolves to. A
 *    broken policy must stay recoverable through its own gate, and a file whose
 *    every class became `human-only` would put the repair for a typo behind a
 *    level that admits no gated repair.
 * 3. **The ordering.** `human-only` > `manual` > `supervised-live` >
 *    `supervised-retro` > `autonomous`, in the one table the runtime holds, and
 *    therefore in the deny-beats-allow tie-break that reads it.
 * 4. **The floor stops below it.** §7's irreversibility floor raises to `manual`
 *    and never to `human-only`, and it never lowers a `human-only` class either.
 * 5. **Every gate verb refuses, with one code.** `request`, all three decisions
 *    of `decide`, the harness spend, the harness start, the token spend, the
 *    token report, and `approval run` — each returns `class-human-only` and
 *    leaves the log byte-identical.
 * 6. **The §11.1 invariant.** The code is a member of every union that could
 *    carry it, it is distinct from every rejection-shaped code, and the hook's
 *    deny is distinct from deny-by-unclassified.
 *
 * Every event this suite reads was written by the real append path, and every
 * scenario that writes ends by verifying the chain.
 *
 * The recurring shape of the enforcement cases is a POLICY AMENDMENT: a class is
 * requested and granted while it is `manual`, and a human then raises it to
 * `human-only` and re-attests. That is the only way a live request or an unspent
 * token can exist under the level at all, since intake refuses it, and it is the
 * case the withdrawal refusals exist for.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { GATE_REFUSAL_CODES, startHarnessExecution } from "../src/core/gate.js";
import { EXECUTE_REFUSAL_CODES } from "../src/core/execute.js";
import { HOOK_DENY_CODES } from "../src/cli/hook.js";
import { loadPolicy } from "../src/core/policy-load.js";
import { resolve, STRICTNESS } from "../src/core/policy-match.js";
import { TOKEN_REFUSAL_CODES, TOKEN_VERIFY_REFUSAL_CODES } from "../src/core/token.js";
import {
  appendAttestation,
  consumeHarnessGrant,
  consumeToken,
  decide,
  register,
  request,
  startExecution,
  withdraw,
} from "./clock-adapters.js";
import { assertClean, at, newScenario, scratchRoot, T0, type Scenario } from "./scenario.js";

const { root, cleanup } = scratchRoot("human-only");
after(cleanup);

/** dist/tests/human-only.test.js -> dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

const ACTION = "act-reserved";
const TASK = "task-185";

/** The content binding the registration declares. */
function bindingFor(key: string): string {
  return createHash("sha256").update(`payload:${key}`, "utf8").digest("hex");
}

function policyText(classes: string[], defaultAutonomy = "manual"): string {
  return [
    "# Policy",
    "",
    "```yaml approval-policy",
    'version: "0.1"',
    "defaults:",
    `  autonomy: ${defaultAutonomy}`,
    '  approval_ttl: "1h"',
    "  on_expiry: reject",
    "classes:",
    ...classes,
    "```",
    "",
  ].join("\n");
}

/** The class under test at `manual`, and at `human-only`. */
const AS_MANUAL = policyText(["  financial.spend:", "    autonomy: manual"]);
const AS_HUMAN_ONLY = policyText(["  financial.spend:", "    autonomy: human-only"]);

function envelope(actionKeys: string[]): Record<string, unknown> {
  return {
    origin: { app: "example-capture", created_by: "human:carter" },
    state: "proposed",
    actions: actionKeys.map((key) => ({
      class: "financial.spend",
      summary: `spend under ${key}`,
      est_cost_usd: "0.01",
      idempotency_key: key,
      payload_hash: bindingFor(key),
    })),
  };
}

/** A scenario whose policy is on disk, attested, and whose task is registered. */
function ready(policy: string, actionKeys: string[] = [ACTION]): Scenario {
  const unit = newScenario(root, policy);
  assert.equal(
    appendAttestation(unit.logPath, unit.policyPath, "human:carter", T0).ok,
    true,
    "attestation append failed",
  );
  const registered = register(
    unit.logPath,
    { task: TASK, envelope: envelope(actionKeys) },
    T0,
    "agent:claude",
  );
  assert.equal(registered.ok, true, registered.ok ? "" : registered.message);
  return unit;
}

/**
 * Rewrite the policy in place and re-attest it, as a human amending APPROVAL.md
 * does. The only way a live request can come to sit under `human-only`.
 */
function amendTo(unit: Scenario, policy: string, ts: string): void {
  writeFileSync(unit.policyPath, policy, "utf8");
  assert.equal(
    appendAttestation(unit.logPath, unit.policyPath, "human:carter", ts).ok,
    true,
    "re-attestation append failed",
  );
}

function rawLog(unit: Scenario): string {
  return existsSync(unit.logPath) ? readFileSync(unit.logPath, "utf8") : "";
}

// ===========================================================================
// 1. The grammar
// ===========================================================================

test("a class rule may declare human-only, and it carries no supervision and no rate", () => {
  const unit = newScenario(root, AS_HUMAN_ONLY);
  const load = loadPolicy({ file: unit.policyPath });
  assert.equal(load.ok, true);
  if (!load.ok) return;
  assert.deepEqual(load.notes, []);

  const outcome = resolve(load, "financial.spend");
  assert.equal(outcome.autonomy, "human-only");
  assert.equal(outcome.declaredAutonomy, "human-only");
  assert.equal(outcome.provenance, "rule");
  // It is not a supervision mode, so it names none and carries neither fraction.
  assert.equal(outcome.supervision, null);
  assert.equal(outcome.liveRate, null);
  assert.equal(outcome.retroRate, null);
  assert.equal(outcome.floorApplied, false);
});

test("defaults.autonomy admits human-only, which supervised-live does not", () => {
  const unit = newScenario(root, policyText(["  read.*:", "    autonomy: autonomous"], "human-only"));
  const load = loadPolicy({ file: unit.policyPath });
  assert.equal(load.ok, true, "human-only is a legal default: it carries no key to be missing");
  if (!load.ok) return;

  const unmatched = resolve(load, "communicate.email.external");
  assert.equal(unmatched.autonomy, "human-only");
  assert.equal(unmatched.provenance, "default");
  // The default narrows nothing a rule declared: a rule still governs its class.
  assert.equal(resolve(load, "read.web").autonomy, "autonomous");

  // The asymmetry this case is named for, restated as a test.
  const live = newScenario(root, policyText(["  read.*:", "    autonomy: autonomous"], "supervised-live"));
  assert.equal(loadPolicy({ file: live.policyPath }).ok, false);
});

test("both rates are forbidden on human-only, and the policy fails closed", () => {
  const cases: Array<[string, string[]]> = [
    [
      "retro_rate on human-only, which has no retrospective pool",
      ["  financial.spend:", "    autonomy: human-only", "    retro_rate: 0.5"],
    ],
    [
      "live_rate on human-only, which has no fraction to gate",
      ["  financial.spend:", "    autonomy: human-only", "    live_rate: 0.5"],
    ],
    [
      "both at once",
      [
        "  financial.spend:",
        "    autonomy: human-only",
        "    live_rate: 0.5",
        "    retro_rate: 0.5",
      ],
    ],
  ];

  for (const [label, classes] of cases) {
    const unit = newScenario(root, policyText(classes));
    const load = loadPolicy({ file: unit.policyPath });
    assert.equal(load.ok, false, `${label} was accepted`);
    if (load.ok) continue;
    assert.equal(load.code, "schema-invalid", label);
    assert.equal(resolve(load, "financial.spend").autonomy, "manual", label);
  }
});

test("the fail-closed target is manual, not the new strictest level", () => {
  const unit = newScenario(root, "# Policy\n\nno fenced block at all\n");
  const load = loadPolicy({ file: unit.policyPath });
  assert.equal(load.ok, false);

  // Every class, including one a working policy would have called human-only.
  for (const cls of ["financial.spend", "read.web", "policy.edit"]) {
    const outcome = resolve(load, cls);
    assert.equal(outcome.autonomy, "manual", cls);
    assert.equal(outcome.provenance, "fail-closed", cls);
  }
  // The reason, stated as the property it protects: a broken policy is still
  // repairable THROUGH its own gate. Under an all-`human-only` fail-closed the
  // repair would have no gated path at all.
  assert.ok(
    STRICTNESS["human-only"] < STRICTNESS["manual"],
    "the fail-closed level is deliberately not the strictest one",
  );
});

// ===========================================================================
// 2. The ordering
// ===========================================================================

test("strictness orders human-only above manual, and the table is total", () => {
  const order = [
    "human-only",
    "manual",
    "supervised-live",
    "supervised-retro",
    "autonomous",
  ] as const;
  for (let index = 1; index < order.length; index += 1) {
    const stricter = order[index - 1] as (typeof order)[number];
    const looser = order[index] as (typeof order)[number];
    assert.ok(
      STRICTNESS[stricter] < STRICTNESS[looser],
      `${stricter} must outrank ${looser}`,
    );
  }
  // The pre-split spelling still ranks with the level it aliases.
  assert.equal(STRICTNESS["supervised"], STRICTNESS["supervised-retro"]);
});

test("deny beats allow: a human-only rule wins every equal-specificity tie", () => {
  // `financial.*` and `*.spend` both match `financial.spend` with one literal
  // and one wildcard, so specificity ties and strictness decides. The second
  // key is quoted because a bare leading `*` is a YAML alias, not a string.
  const pairs: Array<[string, string]> = [
    ['  financial.*:\n    autonomy: human-only', '  "*.spend":\n    autonomy: manual'],
    ['  "*.spend":\n    autonomy: human-only', "  financial.*:\n    autonomy: manual"],
    ['  financial.*:\n    autonomy: human-only', '  "*.spend":\n    autonomy: autonomous'],
  ];
  for (const [reserved, other] of pairs) {
    const unit = newScenario(root, policyText([reserved, other]));
    const load = loadPolicy({ file: unit.policyPath });
    assert.equal(load.ok, true);
    if (!load.ok) continue;
    const outcome = resolve(load, "financial.spend");
    assert.equal(
      outcome.autonomy,
      "human-only",
      `the stricter rule must win regardless of key order: ${reserved} vs ${other}`,
    );
    assert.equal(outcome.candidates.length, 2, "both rules were considered");
  }
});

// ===========================================================================
// 3. The §7 floor
// ===========================================================================

test("the irreversibility floor raises to manual and never to human-only", () => {
  const unit = newScenario(
    root,
    policyText([
      "  files.write.local:",
      "    autonomy: supervised-retro",
      "  read.web:",
      "    autonomy: autonomous",
    ]),
  );
  const load = loadPolicy({ file: unit.policyPath });
  assert.equal(load.ok, true);
  if (!load.ok) return;

  for (const cls of ["files.write.local", "read.web"]) {
    const floored = resolve(load, cls, { reversible: false });
    assert.equal(floored.autonomy, "manual", cls);
    assert.equal(floored.floorApplied, true, cls);
    assert.notEqual(
      floored.autonomy,
      "human-only",
      "a floor is a runtime escalation; human-only is an author's declaration",
    );
  }
});

test("the floor does not lower a human-only class either", () => {
  const unit = newScenario(root, AS_HUMAN_ONLY);
  const load = loadPolicy({ file: unit.policyPath });
  assert.equal(load.ok, true);
  if (!load.ok) return;

  const floored = resolve(load, "financial.spend", { reversible: false });
  assert.equal(floored.autonomy, "human-only");
  // The floor did not decide this: the rule did, and the provenance says so.
  assert.equal(floored.floorApplied, false);
  assert.equal(floored.provenance, "rule");
});

// ===========================================================================
// 4. Every gate verb refuses
// ===========================================================================

test("request refuses a human-only class and writes no approval.requested", () => {
  const unit = ready(AS_HUMAN_ONLY);
  const before = rawLog(unit);

  const attempt = request(
    unit.logPath,
    { task: TASK, actionKey: ACTION, cls: "financial.spend" },
    at(1),
    "agent:claude",
    unit.options,
  );
  assert.equal(attempt.ok, false);
  if (attempt.ok) return;
  assert.equal(attempt.code, "class-human-only");
  assert.match(attempt.message, /financial\.spend/u, "the message names the class");
  assert.match(
    attempt.message,
    /outside agent execution/u,
    "the message says a human performs this action outside agent execution",
  );
  assert.equal(rawLog(unit), before, "nothing was appended");
  assertClean(unit);
});

test("an unregistered action in a human-only class is refused for the class", () => {
  // `not-registered` would send the caller to fix the one thing that cannot
  // make this request valid, so the class is answered first.
  const unit = newScenario(root, AS_HUMAN_ONLY);
  assert.equal(
    appendAttestation(unit.logPath, unit.policyPath, "human:carter", T0).ok,
    true,
  );
  const before = rawLog(unit);
  const attempt = request(
    unit.logPath,
    { task: TASK, actionKey: ACTION, cls: "financial.spend" },
    at(1),
    "agent:claude",
    unit.options,
  );
  assert.equal(attempt.ok, false);
  if (attempt.ok) return;
  assert.equal(attempt.code, "class-human-only");
  assert.equal(rawLog(unit), before);
});

test("no decision may be recorded once a class is raised to human-only", () => {
  // Two actions: one left pending for `reject`, one granted for `revoke`.
  const pending = "act-pending";
  const unit = ready(AS_MANUAL, [ACTION, pending]);

  for (const key of [ACTION, pending]) {
    const asked = request(
      unit.logPath,
      { task: TASK, actionKey: key, cls: "financial.spend" },
      at(1),
      "agent:claude",
      unit.options,
    );
    assert.equal(asked.ok, true, asked.ok ? "" : asked.message);
  }
  const granted = decide(unit.logPath, ACTION, "grant", "human:carter", at(2), unit.options);
  assert.equal(granted.ok, true, granted.ok ? "" : granted.message);

  amendTo(unit, AS_HUMAN_ONLY, at(3));
  const before = rawLog(unit);

  // Grant on the pending one, reject on the pending one, revoke on the granted
  // one: all three directions, all one code, and none of them writes.
  for (const [key, decision] of [
    [pending, "grant"],
    [pending, "reject"],
    [ACTION, "revoke"],
  ] as const) {
    const attempt = decide(unit.logPath, key, decision, "human:carter", at(4), unit.options);
    assert.equal(attempt.ok, false, `${decision} was accepted`);
    if (attempt.ok) continue;
    assert.equal(attempt.code, "class-human-only", decision);
    assert.match(attempt.message, /financial\.spend/u, decision);
  }
  assert.equal(rawLog(unit), before, "no decision record was written");

  // The exits stay open. A request nobody may decide is not a request nobody
  // may take back: its requester withdraws it.
  const taken = withdraw(unit.logPath, pending, "agent:claude", at(5), unit.options);
  assert.equal(taken.ok, true, taken.ok ? "" : taken.message);
  assertClean(unit);
});

test("class-human-only is evaluated before policy-drift on the grant path", () => {
  // Both conditions hold at once: the request was routed under a policy that is
  // no longer attested, AND its class is now reserved. The class answers first,
  // because "who may decide this, under which rules" does not arise for a class
  // nobody may decide.
  const unit = ready(AS_MANUAL);
  const asked = request(
    unit.logPath,
    { task: TASK, actionKey: ACTION, cls: "financial.spend" },
    at(1),
    "agent:claude",
    unit.options,
  );
  assert.equal(asked.ok, true, asked.ok ? "" : asked.message);

  amendTo(unit, AS_HUMAN_ONLY, at(2));
  const attempt = decide(unit.logPath, ACTION, "grant", "human:carter", at(3), unit.options);
  assert.equal(attempt.ok, false);
  if (attempt.ok) return;
  assert.equal(attempt.code, "class-human-only");
  assert.notEqual(attempt.code, "policy-drift");
});

test("a token minted before the amendment becomes unspendable, not merely stale", () => {
  const unit = ready(AS_MANUAL);
  const asked = request(
    unit.logPath,
    { task: TASK, actionKey: ACTION, cls: "financial.spend" },
    at(1),
    "agent:claude",
    unit.options,
  );
  assert.equal(asked.ok, true, asked.ok ? "" : asked.message);
  const granted = decide(unit.logPath, ACTION, "grant", "human:carter", at(2), unit.options);
  assert.equal(granted.ok, true, granted.ok ? "" : granted.message);
  if (!granted.ok) return;
  const token = granted.token;
  assert.ok(typeof token === "string" && token.length > 0, "a manual grant mints a token");

  amendTo(unit, AS_HUMAN_ONLY, at(3));
  const before = rawLog(unit);

  // The spend itself.
  const spend = consumeToken(unit.logPath, ACTION, token ?? "", at(4), "agent:claude", {
    policyFile: unit.policyPath,
    presentedPayloadHash: bindingFor(ACTION),
  });
  assert.equal(spend.ok, false);
  if (!spend.ok) assert.equal(spend.code, "class-human-only");

  // And `approval run`, which surfaces the same fact in its own vocabulary.
  const ran = startExecution(
    unit.logPath,
    ACTION,
    {
      policy: { file: unit.policyPath },
      token: token ?? "",
      presentedPayloadHash: bindingFor(ACTION),
    },
    at(5),
    "agent:claude",
  );
  assert.equal(ran.ok, false);
  if (!ran.ok) {
    assert.equal(ran.code, "class-human-only");
    assert.notEqual(ran.code, "token-required", "there is no token to go and get");
  }

  assert.equal(rawLog(unit), before, "no execution.started was written by either path");
  assertClean(unit);
});

test("approval run refuses a human-only class off the manual path too", () => {
  // No approval cycle at all: the refusal is not a token redirection.
  const unit = ready(AS_HUMAN_ONLY);
  const before = rawLog(unit);
  const ran = startExecution(
    unit.logPath,
    ACTION,
    { policy: { file: unit.policyPath }, presentedPayloadHash: bindingFor(ACTION) },
    at(1),
    "agent:claude",
  );
  assert.equal(ran.ok, false);
  if (!ran.ok) assert.equal(ran.code, "class-human-only");
  assert.equal(rawLog(unit), before);
  assertClean(unit);
});

test("a harness grant raised to human-only may not be spent", () => {
  const unit = ready(AS_MANUAL);
  const asked = request(
    unit.logPath,
    { task: TASK, actionKey: ACTION, cls: "financial.spend", execution: "harness" },
    at(1),
    "agent:claude",
    unit.options,
  );
  assert.equal(asked.ok, true, asked.ok ? "" : asked.message);
  const granted = decide(unit.logPath, ACTION, "grant", "human:carter", at(2), unit.options);
  assert.equal(granted.ok, true, granted.ok ? "" : granted.message);

  amendTo(unit, AS_HUMAN_ONLY, at(3));
  const before = rawLog(unit);

  const spend = consumeHarnessGrant(unit.logPath, ACTION, "agent:claude", at(4), unit.options);
  assert.equal(spend.ok, false);
  if (!spend.ok) assert.equal(spend.code, "class-human-only");
  assert.equal(rawLog(unit), before);
  assertClean(unit);
});

test("the harness write boundary refuses a human-only class as well", () => {
  // The belt to the hook's braces: a caller that reaches this function without
  // asking the hook first must not be able to record the execution anyway.
  const unit = ready(AS_HUMAN_ONLY);
  const before = rawLog(unit);
  const start = startHarnessExecution(
    unit.logPath,
    {
      task: TASK,
      actionKey: ACTION,
      cls: "financial.spend",
      payload_hash: bindingFor(ACTION),
    },
    "agent:claude",
    { ...unit.options, clock: () => at(1) },
  );
  assert.equal(start.ok, false);
  if (!start.ok) {
    assert.equal(start.code, "class-human-only");
    assert.notEqual(start.code, "not-granted", "this is not a missing grant");
  }
  assert.equal(rawLog(unit), before);
  assertClean(unit);
});

test("approval token reports an unspendable token rather than a live one", () => {
  // This case spawns the real CLI, which reads the real clock, so its policy
  // declares no `approval_ttl`: an absent TTL means nothing lapses (§5.1), and
  // the answer under test must be about the class rather than about the age of
  // a grant these fixed timestamps put in the past.
  const noTtl = (autonomy: string): string =>
    [
      "# Policy",
      "",
      "```yaml approval-policy",
      'version: "0.1"',
      "defaults:",
      "  autonomy: manual",
      "classes:",
      "  financial.spend:",
      `    autonomy: ${autonomy}`,
      "```",
      "",
    ].join("\n");

  const unit = ready(noTtl("manual"));
  const asked = request(
    unit.logPath,
    { task: TASK, actionKey: ACTION, cls: "financial.spend" },
    at(1),
    "agent:claude",
    unit.options,
  );
  assert.equal(asked.ok, true, asked.ok ? "" : asked.message);
  const granted = decide(unit.logPath, ACTION, "grant", "human:carter", at(2), unit.options);
  assert.equal(granted.ok, true, granted.ok ? "" : granted.message);
  amendTo(unit, noTtl("human-only"), at(3));

  const run = spawnSync(process.execPath, [CLI_ENTRY, "token", ACTION, "--json"], {
    cwd: unit.dir,
    encoding: "utf8",
  });
  assert.notEqual(run.status, 0, "an unspendable token is not an exit-0 answer");
  const parsed = JSON.parse(run.stderr.trim()) as { error?: { code?: string } };
  assert.equal(parsed.error?.code, "class-human-only");
});

// ===========================================================================
// 5. The hook
// ===========================================================================

test("the hook denies a human-only command, distinctly from unclassified", () => {
  const dir = join(root, "hook-case");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "APPROVAL.md"),
    policyText([
      "  read.*:",
      "    autonomy: autonomous",
      "  vcs.history.rewrite:",
      "    autonomy: human-only",
    ]),
    "utf8",
  );
  const attested = spawnSync(
    process.execPath,
    [CLI_ENTRY, "policy", "attest", "--as", "human:carter"],
    { cwd: dir, encoding: "utf8" },
  );
  assert.equal(attested.status, 0, attested.stderr);
  const logPath = join(dir, ".approval", "log", "events.jsonl");
  const before = readFileSync(logPath, "utf8");

  const event = JSON.stringify({
    session_id: "sess-185",
    transcript_path: "/dev/null",
    cwd: "/repo",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "git push --force origin main", description: "harmless" },
  });
  const run = spawnSync(process.execPath, [CLI_ENTRY, "hook", "claude-code"], {
    cwd: dir,
    encoding: "utf8",
    input: event,
  });
  assert.equal(run.status, 0, `the hook must exit 0 with a verdict: ${run.stderr}`);
  const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
  const output = parsed["hookSpecificOutput"] as Record<string, unknown>;
  assert.equal(output["permissionDecision"], "deny");
  const reason = String(output["permissionDecisionReason"]);
  assert.match(reason, /^hook-class-human-only: /u);
  assert.match(reason, /vcs\.history\.rewrite/u, "the deny names the class");
  assert.match(reason, /class-human-only/u, "and names the gate's own code");

  // Nothing was registered, requested, or appended: the policy answered.
  assert.equal(readFileSync(logPath, "utf8"), before);

  // And an unclassified command is still its own, different answer.
  const unclassified = spawnSync(process.execPath, [CLI_ENTRY, "hook", "claude-code"], {
    cwd: dir,
    encoding: "utf8",
    input: event.replace("git push --force origin main", "vim CLAUDE.md"),
  });
  const other = (JSON.parse(unclassified.stdout) as Record<string, unknown>)[
    "hookSpecificOutput"
  ] as Record<string, unknown>;
  assert.equal(other["permissionDecision"], "deny");
  assert.match(String(other["permissionDecisionReason"]), /^hook-unclassified: /u);
});

// ===========================================================================
// 6. The §11.1 invariant
// ===========================================================================

test("invariant 9: the refusal is in every union that can carry it", () => {
  // Frozen public API. A union that lost the member would be an enforcement
  // path that answers a human-only class with somebody else's code.
  assert.ok(
    (GATE_REFUSAL_CODES as readonly string[]).includes("class-human-only"),
    "gate_refusal_codes",
  );
  assert.ok(
    (TOKEN_REFUSAL_CODES as readonly string[]).includes("class-human-only"),
    "token_refusal_codes",
  );
  assert.ok(
    (EXECUTE_REFUSAL_CODES as readonly string[]).includes("class-human-only"),
    "execute_refusal_codes",
  );
  assert.ok(
    (HOOK_DENY_CODES as readonly string[]).includes("hook-class-human-only"),
    "the hook's own union",
  );

  // NOT in the token VERIFICATION union: verification is pure over the log, and
  // this is a fact about the policy, which `verifyToken` deliberately does not
  // read. Widening it there would make a replayed verification depend on a file
  // the replay does not hold.
  assert.ok(
    !(TOKEN_VERIFY_REFUSAL_CODES as readonly string[]).includes("class-human-only"),
    "token_verify_refusal_codes stays pure over the log",
  );
});

test("invariant 9: the refusal is distinct from every rejection-shaped code", () => {
  // The property the code exists for: nobody decided anything. An agent that
  // read a rejection would retry with a better summary; this must not be
  // mistakable for one.
  for (const rejection of ["already-decided", "request-withdrawn", "not-granted", "expired"]) {
    assert.notEqual("class-human-only", rejection);
  }
  // And it is a new member rather than a rename of an existing one: every code
  // the registry froze before APRV-185 is still present.
  for (const kept of [
    "actor-not-approver",
    "grant-classless-request",
    "loop-escalated",
    "policy-drift",
  ]) {
    assert.ok((GATE_REFUSAL_CODES as readonly string[]).includes(kept), kept);
  }
});
