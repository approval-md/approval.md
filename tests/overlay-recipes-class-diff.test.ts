/**
 * The CLASS-DIFF release gate (B-167, lead ruling CLAIMS L15681 (1)), after
 * fold 1 of review-b's refute.
 *
 * Pure half: the allowlist's acceptance rule (M-3 (b): `reason: "ok"` and an
 * entry nobody accepted by name both fail), the diff's autonomy ranking (S-4:
 * autonomous -> supervised-retro, a higher live rate and auto -> card block),
 * column-scoped entries, the shadowed-tools reader (M-2 (c)), the hook verdict
 * reader, and the corpus and gate-file pins in ci.yml (M-3 (c): a pruned
 * corpus fails).
 *
 * Box half: the real `approval hook hermes` of this build against a planted
 * copy of it (tests/fixtures/class-diff/plant.mjs, review-b's one-condition
 * plants), in the box layout, through the script's CLI with exit codes read
 * alone. Each plant must FAIL the gate: P20 (core's Hermes table sends
 * send_message to policy.core), P22 (the credential pass fires from $HOME),
 * P23 (a rule keyed on APPROVAL_HERMES_HOME), P24 (a rule keyed on skills on
 * disk), P25 (a rule keyed on non-empty readRoots), P27 (read_file's class
 * goes human-only), P17 (network.call autonomous -> supervised-retro), T5 (a
 * template tools line that shadows an existing tool), and S-1 (a shipped
 * recipe the hook denies in the box, with no diff move).
 *
 * Fold 3 (review-b recheck of bd75c4a6): a card's request is bound to its call
 * by the key the deny names, else by tool and command (S-5: renamed or swapped
 * task ids read right; a card whose request is not found exits 2); a sampling
 * secret name that is a layout or runtime variable exits 2 (N-7); the minimal
 * rule compares per class (N-8).
 *
 * Fold 5 (review-b recheck of 6f752ab8): a call that wrote its own request
 * binds only its own rows (N-9); a card bound to no class that needs a human
 * exits 2 (N-10); a class new to an all-minimal card at another style blocks
 * (N-11, owner N1); and pure tests for the fold-3 checks no test held (N-13).
 *
 * Fold 6 (review-b recheck of 2502bc44): a card whose bound request logs a
 * class other than the one its key names exits 2, even when the logged class
 * needs a human (N-15).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync as copyTree, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import {
  acceptanceErrors,
  cardKeyClassMismatch,
  cardWithoutHumanClass,
  diffCalls,
  entryMatches,
  gateLine,
  leftMinimal,
  newlyNotMinimal,
  shadowedTools,
  // @ts-expect-error no declaration file for the standalone check script
} from "../../scripts/overlay-recipes-check.mjs";
import {
  bindRequest,
  boxEnv,
  readVerdict,
  reservedEnvName,
  summaryFits,
  timeoutKeys,
  // @ts-expect-error no declaration file for the standalone box runner
} from "../../scripts/overlay-recipes-box.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = join(ROOT, "scripts", "overlay-recipes-check.mjs");

interface Side {
  decision: string;
  classes?: string[];
  level?: string | null;
  rank?: number;
  code?: string | null;
}
interface Row {
  status: string;
  column: string;
  command: string;
}
interface Diff {
  rows: Row[];
  summary: { blocking: number; allowlisted: number; changed: number; new: number; removed: number; columns: Record<string, number> };
}

const ACCEPTED = { accepted_by: "human:test", accepted_at: "2026-10-20" };

// --- pure half -------------------------------------------------------------------

test("M-3 (b): a reason that says nothing, or no acceptance by name, keeps an entry from counting", () => {
  assert.deepEqual(acceptanceErrors({ file: "f", command: "c", reason: "a real reason, long enough", ...ACCEPTED }), []);
  assert.match(acceptanceErrors({ file: "f", command: "c", reason: "ok", ...ACCEPTED }).join(";"), /says nothing/u);
  assert.match(acceptanceErrors({ file: "f", command: "c", reason: "a real reason, long enough" }).join(";"), /awaiting acceptance/u);
  assert.match(
    acceptanceErrors({ file: "f", command: "c", reason: "a real reason, long enough", accepted_by: "carter", accepted_at: "2026-10-20" }).join(";"),
    /not a human:<id>/u,
  );
  assert.match(
    acceptanceErrors({ file: "f", command: "c", reason: "a real reason, long enough", ...ACCEPTED, columns: ["nowhere"] }).join(";"),
    /columns/u,
  );
});

test("entries scoped to columns match only there; '*' matches a whole file", () => {
  const e = { file: "a.md", command: "x", columns: ["hermes-home"] };
  assert.equal(entryMatches(e, "a.md", "x", "hermes-home"), true);
  assert.equal(entryMatches(e, "a.md", "x", "home"), false);
  assert.equal(entryMatches({ file: "a.md", command: "*" }, "a.md", "anything", "home"), true);
});

const call = (key: string, side: Side, column = "hermes-home") => ({
  key,
  column,
  kind: "recipe",
  where: "skills/x/SKILL.md:1",
  command: key,
  classes: side.classes ?? ["network.call"],
  ...side,
});

test("S-4: less autonomy on an existing call blocks; more autonomy is reported", () => {
  const cases: [string, Side, Side, string][] = [
    ["retro", { decision: "auto", level: "autonomous", rank: 4 }, { decision: "auto", level: "supervised-retro", rank: 3 }, "blocking"],
    ["live-up", { decision: "sampled", level: "supervised-live:0.1", rank: 1.9 }, { decision: "sampled", level: "supervised-live:1", rank: 1 }, "blocking"],
    ["card", { decision: "auto", level: "autonomous", rank: 4 }, { decision: "card", level: "manual", rank: 1 }, "blocking"],
    ["deny", { decision: "card", level: "manual", rank: 1 }, { decision: "refused", rank: -1, code: "hook-unparseable" }, "blocking"],
    ["looser", { decision: "card", level: "manual", rank: 1 }, { decision: "auto", level: "autonomous", rank: 4 }, "changed"],
    ["deny-to-deny", { decision: "human-only", rank: -1, code: "hook-class-human-only" }, { decision: "refused", rank: -1, code: "hook-unparseable" }, "changed"],
    ["same", { decision: "auto", level: "autonomous", rank: 4 }, { decision: "auto", level: "autonomous", rank: 4 }, "unchanged"],
  ];
  for (const [key, was, now, want] of cases) {
    const d = diffCalls([call(key, was)], [call(key, now)]) as Diff;
    assert.equal(d.rows[0]?.status, want, key);
  }
});

test("a blocking move is allowlisted only by an accepted entry for that call, column and (if given) flip; never by '*'", () => {
  const was = call("c", { decision: "auto", level: "autonomous", rank: 4 });
  const now = call("c", { decision: "human-only", rank: -1, code: "hook-class-human-only" });
  const entry = { file: "skills/x/SKILL.md", command: "c", reason: "accepted for a stated reason", scope: "box", ...ACCEPTED };
  const status = (entries: unknown[]) => (diffCalls([was], [now], { entries }) as Diff).rows[0]?.status;
  assert.equal(status([entry]), "allowlisted");
  assert.equal(status([{ ...entry, accepted_by: "" }]), "blocking", "unaccepted");
  assert.equal(status([{ ...entry, reason: "ok" }]), "blocking", "B1: reason ok");
  assert.equal(status([{ ...entry, columns: ["home"] }]), "blocking", "another column");
  assert.equal(status([{ ...entry, flip: { from: "card", to: "refused" } }]), "blocking", "another flip");
  assert.equal(status([{ ...entry, command: "*" }]), "blocking", "a whole-file entry never covers a move");
});

test("new and removed calls are reported, never blocking", () => {
  const a = call("a", { decision: "auto", rank: 4 });
  const b = call("b", { decision: "human-only", rank: -1 });
  const d = diffCalls([a], [b]) as Diff;
  assert.deepEqual(d.rows.map((r) => r.status).sort(), ["new", "removed"]);
  assert.equal(d.summary.blocking, 0);
});

test("M-2 (c): a tools line shadowed by an earlier one is found (first match wins)", () => {
  const lines = [
    { match: "mcp__*", class: "account.credential" },
    { match: "mcp__index__list_intents", class: "read.web" },
    { match: "web_search", class: "read.web" },
  ];
  assert.deepEqual(
    shadowedTools(lines).map((s: { match: string; by: string }) => `${s.match}<${s.by}`),
    ["mcp__index__list_intents<mcp__*"],
  );
  assert.deepEqual(shadowedTools(lines.slice(1)), []);
});

test("the hook verdict reader names the classes of every allow line the hook writes", () => {
  assert.deepEqual(readVerdict(0, "{}", "approval hook hermes: allow — autonomous: read.web (tools entry 8)\n").classes, ["read.web"]);
  assert.deepEqual(
    readVerdict(0, "{}", "approval hook hermes: allow — granted: network.call, exec.local needs no approval under this policy\n").classes,
    ["network.call", "exec.local"],
  );
  const deny = readVerdict(2, "", "hook-class-human-only: class policy.core resolves to human-only");
  assert.equal(deny.code, "hook-class-human-only");
  assert.equal(deny.verdict, "deny");
  // An exit 0 with no allow line is the CLI not running the hook at all: an error, never an allow.
  assert.equal(readVerdict(0, "", "").verdict, "error");
});

// --- fold 3: a card's request is bound to its call (S-5); the secret name (N-7); per-class style (N-8)

const DENY = (keys: string) =>
  `{"action":"block","message":"hook-timeout: no decision on ${keys} within the hook's 200ms wait. This tool call is denied"}\napproval: x (network.call) is waiting for a human`;
const CMD = 'curl -s -H "A: b"    --url "https://example.com/x"';
const req = (at: number, task: string, cls: string, summary = 'curl -s -H "A: b" --url "https://example.com/x"') => [
  { at, event: "task.registered", task, key: `${task}:${cls}`, cls, summary },
  { at: at + 1, event: "approval.requested", task, key: `${task}:${cls}`, cls, summary },
];

test("S-5: the request keys are read off the hook-timeout deny sentence only", () => {
  assert.deepEqual(timeoutKeys(DENY("hook:s:cd-4:read.web, hook:s:cd-4:read.file.out_of_scope")), ["hook:s:cd-4:read.web", "hook:s:cd-4:read.file.out_of_scope"]);
  assert.deepEqual(timeoutKeys("approval: hook:s:cd-1:network.call (network.call) is waiting for a human"), []);
  assert.deepEqual(timeoutKeys("hook-timeout: no decision on  within the hook's 200ms wait"), []);
});

test("S-5: a terminal summary is the command with whitespace collapsed, cut with an ellipsis; other tools by name", () => {
  assert.equal(summaryFits('curl -s -H "A: b" --url "https://example.com/x"', "terminal", { command: CMD }), true);
  assert.equal(summaryFits('curl -s -H "A: b" --url "https://exa…', "terminal", { command: CMD }), true);
  assert.equal(summaryFits("curl -s https://other", "terminal", { command: CMD }), false);
  assert.equal(summaryFits("send_message (message.send)", "send_message", {}), true);
  assert.equal(summaryFits("send_message (message.send)", "read_file", {}), false);
});

test("S-5: a card binds to the request its deny names, or by tool and command to what it appended; else an error", () => {
  const call = { tool: "terminal", input: { command: CMD }, span: [10, 20] };
  // The deny names the key: bound. A call that appended nothing (an adoption) binds an earlier call's request.
  const store = [...req(0, "hook:s:cd-1", "network.call"), ...req(10, "hook:s:cd-2-renamed", "network.call")];
  assert.deepEqual(bindRequest({ ...call, span: [20, 20], text: DENY("hook:s:cd-1:network.call") }, store), { task: "hook:s:cd-1", classes: ["network.call"] });
  assert.deepEqual(bindRequest({ ...call, text: DENY("hook:s:cd-2-renamed:network.call") }, store).task, "hook:s:cd-2-renamed");
  // A key the store does not hold: error.
  assert.match(bindRequest({ ...call, text: DENY("hook:s:cd-9:network.call") }, store).error, /does not hold/u);
  // No key in the deny: only what this call appended (span), by tool and command.
  assert.equal(bindRequest({ ...call, text: "" }, store).task, "hook:s:cd-2-renamed");
  assert.match(bindRequest({ ...call, text: "", span: [30, 40] }, store).error, /no request/u);
  assert.match(bindRequest({ ...call, text: "", span: [0, 20] }, store).error, /2 requests/u);
  // Keys of two tasks for one call: error (fold 5, N-9: the one outside what the call wrote errors first).
  assert.match(bindRequest({ ...call, span: [20, 20], text: DENY("hook:s:cd-1:network.call, hook:s:cd-2-renamed:network.call") }, store).error, /2 requests/u);
  assert.match(bindRequest({ ...call, text: DENY("hook:s:cd-1:network.call, hook:s:cd-2-renamed:network.call") }, store).error, /another call's/u);
  // The named request is another call's (another command): error.
  const other = req(0, "hook:s:cd-1", "network.call", "curl -s https://other");
  assert.match(bindRequest({ ...call, text: DENY("hook:s:cd-1:network.call") }, other).error, /another call/u);
});

test("N-9: a call that wrote its own request binds only its own rows, never another call's with the same command", () => {
  // Two calls, the same command (another workdir): cd-1 wrote rows 0-1, cd-2 wrote rows 10-11.
  const store = [...req(0, "hook:s:cd-1", "network.call"), ...req(10, "hook:s:cd-2", "network.call")];
  const second = { tool: "terminal", input: { command: CMD }, span: [10, 20] };
  assert.match(bindRequest({ ...second, text: DENY("hook:s:cd-1:network.call") }, store).error, /another call's, though this call wrote its own request/u);
  assert.equal(bindRequest({ ...second, text: DENY("hook:s:cd-2:network.call") }, store).task, "hook:s:cd-2");
  // A harness tool: the same name prefix is not enough either.
  const tool = (at: number, task: string) => [
    { at, event: "task.registered", task, key: `${task}:read.file.out_of_scope`, cls: "read.file.out_of_scope", summary: "read_file /a" },
  ];
  const reads = [...tool(0, "hook:s:cd-3"), ...tool(10, "hook:s:cd-4")];
  const readCall = { tool: "read_file", input: { path: "/b" }, span: [10, 20] };
  assert.match(bindRequest({ ...readCall, text: DENY("hook:s:cd-3:read.file.out_of_scope") }, reads).error, /another call's/u);
  // The adoption (nothing appended) still binds by the named key.
  assert.equal(bindRequest({ ...second, span: [20, 20], text: DENY("hook:s:cd-1:network.call") }, store).task, "hook:s:cd-1");
});

test("N-13 (MU9): with no key named, only the appended requests that fit the call's command count", () => {
  // The span holds this call's request and one whose summary is another command's.
  const store = [...req(10, "hook:s:cd-5", "network.call"), ...req(12, "hook:s:cd-6", "network.call", "curl -s https://other")];
  assert.deepEqual(bindRequest({ tool: "terminal", input: { command: CMD }, span: [10, 20], text: "" }, store), { task: "hook:s:cd-5", classes: ["network.call"] });
});

test("N-13 (MU11): a bound request that names no class is an error", () => {
  const store = req(10, "hook:s:cd-7", "network.call").map((r) => ({ ...r, cls: null }));
  assert.match(bindRequest({ tool: "terminal", input: { command: CMD }, span: [10, 20], text: DENY("hook:s:cd-7:network.call") }, store).error, /names no class/u);
  assert.match(bindRequest({ tool: "terminal", input: { command: CMD }, span: [10, 20], text: "" }, store).error, /names no class/u);
});

test("N-10: a card whose bound request names no class that needs a human is flagged (it would rank as autonomous)", () => {
  const levels: Record<string, { autonomy: string; supervision?: string; liveRate?: number }> = {
    "read.web": { autonomy: "autonomous" },
    "net.retro": { autonomy: "supervised", supervision: "retro" },
    "net.live": { autonomy: "supervised", supervision: "live", liveRate: 0.1 },
    "network.call": { autonomy: "manual" },
  };
  const core = { resolve: (_load: unknown, cls: string) => levels[cls] ?? { autonomy: "autonomous" } };
  const card = (requested: string[] | undefined) => ({ verdict: "deny", code: "hook-timeout", classes: requested ?? [], requested });
  assert.equal(cardWithoutHumanClass(core, {}, card(["read.web"])), true);
  assert.equal(cardWithoutHumanClass(core, {}, card(["net.retro", "read.web"])), true);
  assert.equal(cardWithoutHumanClass(core, {}, card(undefined)), true, "a card bound to no class");
  assert.equal(cardWithoutHumanClass(core, {}, card(["network.call"])), false);
  assert.equal(cardWithoutHumanClass(core, {}, card(["read.web", "net.live"])), false);
  // Not a card: an allow or another deny is never flagged.
  assert.equal(cardWithoutHumanClass(core, {}, { verdict: "allow", code: null, classes: ["read.web"], requested: ["read.web"] }), false);
  assert.equal(cardWithoutHumanClass(core, {}, { verdict: "deny", code: "hook-class-human-only", classes: ["read.web"] }), false);
});

test("N-15: a bound row whose key is not its own task and class is mislabeled, and a card carrying one is flagged", () => {
  // Every class field logged as digest.share (it needs a human), the keys still the carded network.call (review-b C4).
  const relabeled = req(10, "hook:s:cd-8", "network.call").map((r) => ({ ...r, cls: "digest.share" }));
  const call = { tool: "terminal", input: { command: CMD }, span: [10, 20] };
  const keyed = bindRequest({ ...call, text: DENY("hook:s:cd-8:network.call") }, relabeled);
  assert.equal(keyed.task, "hook:s:cd-8");
  assert.deepEqual(keyed.classes, ["digest.share"]);
  assert.deepEqual(keyed.mislabeled, [
    { key: "hook:s:cd-8:network.call", cls: "digest.share" },
    { key: "hook:s:cd-8:network.call", cls: "digest.share" },
  ]);
  // The span path (the deny names no key) reads the same rows.
  assert.equal(bindRequest({ ...call, text: "" }, relabeled).mislabeled?.length, 2);
  // One row of a two-class request with no class: mislabeled too (the other row's class is not the whole request).
  const partial = [...req(10, "hook:s:cd-9", "network.call"), ...req(12, "hook:s:cd-9", "read.web").map((r) => ({ ...r, cls: null }))];
  assert.deepEqual(bindRequest({ ...call, text: DENY("hook:s:cd-9:network.call, hook:s:cd-9:read.web") }, partial).mislabeled, [
    { key: "hook:s:cd-9:read.web", cls: null },
    { key: "hook:s:cd-9:read.web", cls: null },
  ]);
  // Keys that are their rows' own task and class: no field at all.
  assert.deepEqual(bindRequest({ ...call, text: DENY("hook:s:cd-8:network.call") }, req(10, "hook:s:cd-8", "network.call")), { task: "hook:s:cd-8", classes: ["network.call"] });
  // P12 (review-b N-17): a row of task T keyed under another task U, same class.
  // The class half of the key is right, so only the task half catches it (a
  // suffix-only `key.endsWith(":" + cls)` compare, MN15d, passes it).
  const [registered, requested] = req(10, "hook:s:cd-8", "network.call");
  const crossKeyed = [{ ...registered!, key: "hook:s:cd-9:network.call" }, requested!];
  const p12 = bindRequest({ ...call, text: DENY("hook:s:cd-8:network.call") }, crossKeyed);
  assert.equal(p12.task, "hook:s:cd-8");
  assert.deepEqual(p12.mislabeled, [{ key: "hook:s:cd-9:network.call", cls: "network.call" }]);
  assert.equal(bindRequest({ ...call, text: "" }, crossKeyed).mislabeled?.length, 1, "the span path flags it too");
  // Only a card is flagged.
  const card = { verdict: "deny", code: "hook-timeout", classes: ["digest.share"], requested: keyed.classes, mislabeled: keyed.mislabeled };
  assert.equal(cardKeyClassMismatch(card).length, 2);
  assert.deepEqual(cardKeyClassMismatch({ ...card, mislabeled: undefined }), []);
  assert.deepEqual(cardKeyClassMismatch({ ...card, verdict: "allow", code: null }), []);
  assert.deepEqual(cardKeyClassMismatch({ ...card, code: "hook-class-human-only" }), []);
});

test("N-11 (owner N1): a class new to an all-minimal card, at another style, blocks", () => {
  const was = { decision: "card", level: "manual", rank: 1, classes: ["a.x"], style: "minimal", styles: { "a.x": "minimal" } };
  const now = { ...was, classes: ["a.x", "b.y"], style: "minimal+technical (undeclared)", styles: { "a.x": "minimal", "b.y": "technical (undeclared)" } };
  assert.deepEqual(leftMinimal(was.styles, now.styles), [], "leftMinimal alone misses it");
  assert.deepEqual(newlyNotMinimal(was.styles, now.styles), ["b.y"]);
  assert.equal((diffCalls([call("added", was)], [call("added", now)]) as Diff).rows[0]?.status, "blocking");
  // The new class at minimal: changed, not blocking.
  const plain = { ...now, style: "minimal", styles: { "a.x": "minimal", "b.y": "minimal" } };
  assert.equal((diffCalls([call("plain", was)], [call("plain", plain)]) as Diff).rows[0]?.status, "changed");
  // An old card that was not all minimal: the rule is silent (stricter only where the resident read plain words).
  const mixed = { ...was, classes: ["a.x", "c.z"], style: "minimal+technical", styles: { "a.x": "minimal", "c.z": "technical" } };
  assert.deepEqual(newlyNotMinimal(mixed.styles, now.styles), []);
  assert.deepEqual(newlyNotMinimal({}, now.styles), [], "no old card");
});

test("N-13 (MU8): a move in per-class styles alone (joined style the same, nothing leaves minimal) is 'changed'", () => {
  const was = { decision: "card", level: "manual", rank: 1, classes: ["a.x", "b.y"], style: "technical+technical (undeclared)", styles: { "a.x": "technical", "b.y": "technical (undeclared)" } };
  const now = { ...was, styles: { "a.x": "technical (undeclared)", "b.y": "technical" } };
  assert.equal((diffCalls([call("st", was)], [call("st", now)]) as Diff).rows[0]?.status, "changed");
  assert.equal((diffCalls([call("st", was)], [call("st", was)]) as Diff).rows[0]?.status, "unchanged");
});

test("N-7: a sampling secret name never replaces the box layout or the runtime", () => {
  for (const name of ["HOME", "HERMES_HOME", "APPROVAL_HERMES_HOME", "APPROVAL_ANYTHING", "PATH", "NODE_OPTIONS", "A-B", ""]) assert.equal(reservedEnvName(name), true, name);
  assert.equal(reservedEnvName("CLASS_DIFF_SAMPLING_SECRET"), false);
  const env = boxEnv("/box/home", "/box/home/.hermes", { HOME: "/elsewhere", HERMES_HOME: "/x", APPROVAL_HERMES_HOME: "/y", SAMPLING: "fixed" }) as Record<string, string>;
  assert.equal(env["HOME"], "/box/home");
  assert.equal(env["HERMES_HOME"], "/box/home/.hermes");
  assert.equal(env["APPROVAL_HERMES_HOME"], "/box/home/.hermes");
  assert.equal(env["SAMPLING"], "fixed");
});

test("N-8: a class whose card leaves minimal blocks, even when another class keeps the joined style minimal", () => {
  const was = { decision: "card", level: "manual", rank: 1, classes: ["a.x", "b.y"], style: "minimal", styles: { "a.x": "minimal", "b.y": "minimal" } };
  const now = { ...was, style: "minimal+technical (undeclared)", styles: { "a.x": "minimal", "b.y": "technical (undeclared)" } };
  assert.deepEqual(leftMinimal(was.styles, now.styles), ["b.y"]);
  assert.equal((diffCalls([call("two", was)], [call("two", now)]) as Diff).rows[0]?.status, "blocking");
  // A swap of styles between classes leaves the joined string as it was: still blocking.
  const mixed = { ...was, style: "minimal+technical (undeclared)", styles: { "a.x": "minimal", "b.y": "technical (undeclared)" } };
  const swapped = { ...mixed, styles: { "a.x": "technical (undeclared)", "b.y": "minimal" } };
  assert.equal((diffCalls([call("sw", mixed)], [call("sw", swapped)]) as Diff).rows[0]?.status, "blocking");
  // Unchanged per class: unchanged.
  assert.equal((diffCalls([call("same", now)], [call("same", now)]) as Diff).rows[0]?.status, "unchanged");
});

test("the GATE line names both cores by label, and FAIL with the count", () => {
  const meta = { core: "0.4.6", baselineCore: "0.4.6", coreLabel: "this build abc", baselineLabel: "npm 0.4.6", overlay: "f".repeat(40), baselineOverlay: "f".repeat(40) };
  const summary = { calls: 2, recipes: 1, harness: 1, blocking: 1, allowlisted: 0, changed: 0, new: 0, removed: 0, unchanged: 1, columns: { home: 1 } };
  assert.match(gateLine(meta, summary), /^CLASS-DIFF FAIL 1 BLOCKING: core 0\.4\.6 \(npm 0\.4\.6\) -> 0\.4\.6 \(this build abc\).*blocking by column: home 1$/u);
});

test("M-3 (c): ci.yml pins the gate's own files by sha256 and the corpus by its count, so a pruned corpus fails", () => {
  const wf = parse(readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8")) as {
    jobs: Record<string, { env?: Record<string, string> }>;
  };
  const env = wf.jobs["overlay-recipes"]?.env ?? {};
  const sha = (p: string) => createHash("sha256").update(readFileSync(join(ROOT, p))).digest("hex");
  const pins: [string, string][] = [
    ["PIN_CORPUS", "scripts/overlay-recipes/corpus.json"],
    ["PIN_ALLOWLIST", "scripts/overlay-recipes/allowlist.json"],
    ["PIN_CHECK", "scripts/overlay-recipes-check.mjs"],
    ["PIN_BOX", "scripts/overlay-recipes-box.mjs"],
    ["PIN_EXTRACT", "scripts/overlay-recipes-extract.mjs"],
    ["PIN_NEWCALLS", "scripts/overlay-recipes-newcalls.mjs"],
  ];
  for (const [name, path] of pins) assert.equal(env[name], sha(path), `${name} pins ${path}`);
  const corpus = JSON.parse(readFileSync(join(ROOT, "scripts", "overlay-recipes", "corpus.json"), "utf8")) as { recipes: unknown[] };
  assert.equal(env["CORPUS_RECIPES"], String(corpus.recipes.length));
  // B2: review-b's pruned corpus (63 -> 37) matches neither pin.
  const pruned = JSON.stringify({ ...corpus, recipes: corpus.recipes.slice(0, 37) }, null, 2) + "\n";
  assert.notEqual(createHash("sha256").update(pruned).digest("hex"), env["PIN_CORPUS"]);
  assert.notEqual(String(37), env["CORPUS_RECIPES"]);
});

// --- box half: the real hook, a planted copy of this build --------------------------

const scratch = mkdtempSync(join(tmpdir(), "class-diff-test-"));
// The planted core and the boxes each get a directory of their own.
const plantedRoot = mkdtempSync(join(tmpdir(), "class-diff-core-"));
const planted = join(plantedRoot, "planted");
const boxes = mkdtempSync(join(tmpdir(), "class-diff-boxes-"));
const overlay = join(scratch, "overlay");
after(() => {
  for (const dir of [scratch, plantedRoot, boxes]) rmSync(dir, { recursive: true, force: true });
});

const baseCorpus = JSON.parse(readFileSync(join(ROOT, "scripts", "overlay-recipes", "corpus.json"), "utf8")) as {
  overlay: Record<string, string>;
  policy: { source: string; block: string; substitute: Record<string, string> };
  recipes: { where: string; command: string }[];
};
const STAY = { where: "skills/edgeos/SKILL.md:65", command: "bun skills/edgeos/scripts/events.ts --when today" };
const CURL = baseCorpus.recipes.find((r) => r.where.startsWith("skills/edgeos/SKILL.md") && r.command.startsWith("curl "))!;
const PRE_FIX = { where: "skills/edgeos/SKILL.md:300", command: CURL.command.replace('--url "${EDGEOS_API_BASE', '"${EDGEOS_API_BASE') };

before(() => {
  mkdirSync(planted);
  copyTree(join(ROOT, "dist"), join(planted, "dist"), { recursive: true });
  copyTree(join(ROOT, "schema"), join(planted, "schema"), { recursive: true });
  copyTree(join(ROOT, "package.json"), join(planted, "package.json"));
  symlinkSync(join(ROOT, "node_modules"), join(planted, "node_modules"));
  const plant = spawnSync(process.execPath, [join(ROOT, "tests", "fixtures", "class-diff", "plant.mjs"), planted, "PLANT_"], { encoding: "utf8" });
  assert.equal(plant.status, 0, plant.stderr);
  mkdirSync(join(overlay, "skills", "edgeos", "scripts"), { recursive: true });
  mkdirSync(join(overlay, "workspace"), { recursive: true });
  writeFileSync(join(overlay, "skills", "edgeos", "SKILL.md"), "# EdgeOS\n");
  writeFileSync(join(overlay, "skills", "edgeos", "scripts", "events.ts"), "console.log(1);\n");
  writeFileSync(join(overlay, "workspace", "README.md"), "# workspace\n");
});

function corpusWith(recipes: { where: string; command: string }[], block = baseCorpus.policy.block): string {
  const path = join(scratch, `corpus-${String(Math.random()).slice(2)}.json`);
  writeFileSync(path, JSON.stringify({ ...baseCorpus, policy: { ...baseCorpus.policy, block }, recipes }));
  return path;
}

/**
 * Empty since the 0.4.7 rebase round. At 0.4.6 the --url curl was denied from
 * the Hermes home (B-162) and was listed here for that column. From 0.4.7
 * (#666) it is network.call there as everywhere, so the entry went stale and
 * the gate made it fail; the corpus keeps the curl, now run in every column.
 */
const allowlist = join(scratch, "allowlist.json");
function writeAllowlist(): void {
  writeFileSync(allowlist, JSON.stringify({ entries: [] }));
}

function gate(
  env: Record<string, string>,
  opts: { corpus?: string; baselineCorpus?: string; core?: string; baseline?: string; concurrency?: number } = {},
): { status: number | null; out: string; err: string } {
  writeAllowlist();
  const corpus = opts.corpus ?? corpusWith([STAY, CURL]);
  const box = mkdtempSync(join(boxes, "box-"));
  const md = join(box, "report.md");
  const run = spawnSync(
    process.execPath,
    [
      SCRIPT,
      "--core", opts.core ?? planted,
      "--diff", opts.baseline ?? ROOT,
      "--corpus", corpus,
      "--baseline-corpus", opts.baselineCorpus ?? corpus,
      "--allowlist", allowlist,
      "--overlay-tree", overlay,
      "--box-root", box,
      "--md", md,
      "--box-concurrency", String(opts.concurrency ?? 1),
      // Sequential hook runs (the lead's load rule) over the harness tools the plants touch.
      "--harness-only", "terminal,read_file,search_files,send_message,web_search,mcp__index__list_intents",
    ],
    { encoding: "utf8", env: { ...process.env, ...env } },
  );
  let report = "";
  try {
    report = readFileSync(md, "utf8");
  } catch {
    report = "(no report)";
  }
  return { status: run.status, out: report, err: run.stderr };
}

const BOX_TIMEOUT = { timeout: 600_000 };

test("box control: the planted copy with every plant off passes, class-diff: none", BOX_TIMEOUT, () => {
  const run = gate({});
  assert.equal(run.status, 0, run.err);
  assert.match(run.out, /^CLASS-DIFF PASS: .*class-diff: none/u);
});

const plants: [string, Record<string, string>, RegExp][] = [
  ["P20 core's Hermes table: send_message -> policy.core", { PLANT_TOOL: "send_message=policy.core" }, /blocking by column: harness \d/u],
  ["P22 the credential pass also fires from $HOME", { PLANT_CLASSIFY: "home-parent" }, /blocking by column: .*home \d/u],
  ["P23 a rule keyed on APPROVAL_HERMES_HOME", { PLANT_CLASSIFY: "hosted" }, /blocking by column: .*home \d/u],
  ["P24 a rule keyed on skills present on disk", { PLANT_CLASSIFY: "skills-present" }, /blocking by column: hermes-home \d/u],
  ["P25 a rule keyed on non-empty readRoots", { PLANT_CLASSIFY: "readroots" }, /blocking by column: .*home \d/u],
  ["P27 read_file's class goes human-only", { PLANT_RESOLVE: "read.file.out_of_scope=human-only" }, /blocking by column: harness \d/u],
  ["P17 (S-4) network.call autonomous -> supervised-retro", { PLANT_RESOLVE: "network.call=supervised:retro" }, /CLASS-DIFF FAIL \d+ BLOCKING/u],
];
for (const [name, env, shape] of plants) {
  test(`plant ${name}: the gate fails (exit 1)`, BOX_TIMEOUT, () => {
    const run = gate(env);
    assert.equal(run.status, 1, `${run.err}\n${run.out.slice(0, 400)}`);
    assert.match(run.out, /^CLASS-DIFF FAIL \d+ BLOCKING/u);
    assert.match(run.out.split("\n")[0] ?? "", shape);
  });
}

test("T5 (M-2): a template line inserted first that shadows existing tools fails the gate", BOX_TIMEOUT, () => {
  const shadowing = baseCorpus.policy.block.replace(/^tools:\n/mu, 'tools:\n  - { match: "mcp__*", class: account.credential }\n');
  assert.notEqual(shadowing, baseCorpus.policy.block);
  const run = gate({}, { core: ROOT, corpus: corpusWith([STAY, CURL], shadowing), baselineCorpus: corpusWith([STAY, CURL]) });
  assert.equal(run.status, 1, run.err);
  assert.match(run.out, /newly shadowed tools line/u);
  assert.match(run.out, /mcp__index__list_intents/u);
});

test("S-1: a shipped recipe the hook denies in the box fails with no diff move, unless listed", BOX_TIMEOUT, () => {
  const run = gate({}, { core: ROOT, corpus: corpusWith([STAY, PRE_FIX]) });
  assert.equal(run.status, 1, run.err);
  assert.match(run.out, /class-diff: none/u);
  assert.match(run.err, /denied by the real hook in the box layout/u);
});

// --- fold 2: carded calls keep their class, autonomy and style (S-4) -----------------------

const NETWORK_ROW = /^(\s*)network\.call:(\s*)\{ autonomy: autonomous \}/mu;
const withNetwork = (row: string): string => {
  const block = baseCorpus.policy.block.replace(NETWORK_ROW, `$1network.call:$2${row}`);
  assert.notEqual(block, baseCorpus.policy.block);
  return block;
};
const LIVE_01 = withNetwork("{ autonomy: supervised-live, live_rate: 0.1 }");
const LIVE_10 = withNetwork("{ autonomy: supervised-live, live_rate: 1.0 }");
const MANUAL = withNetwork("{ autonomy: manual }");
const SAY_LINE = /^\s*network\.call:\s*\{ quote: .*$\n/mu;
const MANUAL_NO_SAY = MANUAL.replace(SAY_LINE, "");

test("S-4 control: a template whose network.call cards on both sides passes, class-diff: none", BOX_TIMEOUT, () => {
  const run = gate({}, { core: ROOT, corpus: corpusWith([STAY, CURL], MANUAL), baselineCorpus: corpusWith([STAY, CURL], MANUAL) });
  assert.equal(run.status, 0, run.err);
  assert.match(run.out, /^CLASS-DIFF PASS: .*class-diff: none/u);
});

test("S-4 plant: live_rate 0.1 -> 1.0 on network.call fails (more of its calls card)", BOX_TIMEOUT, () => {
  assert.equal(MANUAL_NO_SAY === MANUAL, false, "the say line was removed");
  const run = gate({}, { core: ROOT, corpus: corpusWith([STAY, CURL], LIVE_10), baselineCorpus: corpusWith([STAY, CURL], LIVE_01) });
  assert.equal(run.status, 1, run.err);
  assert.match(run.out, /^CLASS-DIFF FAIL \d+ BLOCKING/u);
  assert.match(run.out, /supervised-live:0\.1.*supervised-live:1/u);
});

test("S-4 plant: supervised-live -> manual on network.call (sampled -> card) fails", BOX_TIMEOUT, () => {
  const run = gate({}, { core: ROOT, corpus: corpusWith([STAY, CURL], MANUAL), baselineCorpus: corpusWith([STAY, CURL], LIVE_01) });
  assert.equal(run.status, 1, run.err);
  assert.match(run.out, /^CLASS-DIFF FAIL \d+ BLOCKING/u);
});

test("S-4 plant: network.call's card falls from minimal to technical (its say entry removed) fails", BOX_TIMEOUT, () => {
  const run = gate({}, { core: ROOT, corpus: corpusWith([STAY, CURL], MANUAL_NO_SAY), baselineCorpus: corpusWith([STAY, CURL], MANUAL) });
  assert.equal(run.status, 1, run.err);
  assert.match(run.out, /minimal card .*technical \(undeclared\) card/u);
});

test("N-6: carded calls at box concurrency 4 read no false refusal (one store per worker)", BOX_TIMEOUT, () => {
  const run = gate({}, { core: ROOT, corpus: corpusWith([STAY, CURL], MANUAL), baselineCorpus: corpusWith([STAY, CURL], MANUAL), concurrency: 4 });
  assert.equal(run.status, 0, run.err);
  assert.doesNotMatch(`${run.out}${run.err}`, /append-failed/u);
});

// --- fold 3: a card's request bound to its call (review-b S-5), the secret name (N-7) ---------

// Both sides on the planted copy (the plant's env reaches both cores' hooks), or head only.
const both = () => ({ core: planted, baseline: planted });

test("S-5: both cores rename their tasks (review-b K2) and the card falls minimal -> technical: the move blocks (fold 2: rc 0, none)", BOX_TIMEOUT, () => {
  const run = gate({ PLANT_TASK: "suffix:-v2" }, { ...both(), corpus: corpusWith([STAY, CURL], MANUAL_NO_SAY), baselineCorpus: corpusWith([STAY, CURL], MANUAL) });
  assert.equal(run.status, 1, run.err);
  assert.match(run.out, /minimal card .*technical \(undeclared\) card/u);
});

test("S-5: the head core alone renames its tasks, no template move: class-diff none (fold 2: every card read 'changed')", BOX_TIMEOUT, () => {
  const run = gate({ PLANT_TASK: "suffix:-v2" }, { core: planted, corpus: corpusWith([STAY, CURL], MANUAL), baselineCorpus: corpusWith([STAY, CURL], MANUAL) });
  assert.equal(run.status, 0, run.err);
  assert.match(run.out, /^CLASS-DIFF PASS: .*class-diff: none/u);
});

test("S-5 (a): both cores log the card's request under a key their deny does not name: the gate errors, exit 2 (never none)", BOX_TIMEOUT, () => {
  const run = gate({ PLANT_DENYKEY: "suffix:-renamed" }, { ...both(), corpus: corpusWith([STAY, CURL], MANUAL_NO_SAY), baselineCorpus: corpusWith([STAY, CURL], MANUAL) });
  assert.equal(run.status, 2, `${run.err}\n${run.out.slice(0, 400)}`);
  assert.match(run.err, /card-request-unbound: the hook names request hook:class-diff:cd-\d+:network\.call-renamed, which this call's store does not hold/u);
});

test("S-5 (a): the head core alone names a request its store does not hold: exit 2", BOX_TIMEOUT, () => {
  const run = gate({ PLANT_DENYKEY: "suffix:-renamed" }, { core: planted, corpus: corpusWith([STAY, CURL], MANUAL), baselineCorpus: corpusWith([STAY, CURL], MANUAL) });
  assert.equal(run.status, 2, `${run.err}\n${run.out.slice(0, 400)}`);
  assert.match(run.err, /card-request-unbound/u);
});

test("S-5 (b): both cores swap task ids between calls (review-b K6): each card binds to its own request, the same moves block", BOX_TIMEOUT, () => {
  const plain = gate({}, { core: ROOT, corpus: corpusWith([STAY, CURL], MANUAL_NO_SAY), baselineCorpus: corpusWith([STAY, CURL], MANUAL) });
  const run = gate({ PLANT_TASK: "swap" }, { ...both(), corpus: corpusWith([STAY, CURL], MANUAL_NO_SAY), baselineCorpus: corpusWith([STAY, CURL], MANUAL) });
  assert.equal(plain.status, 1, plain.err);
  assert.equal(run.status, 1, run.err);
  const blocking = (out: string) => (out.split("\n")[0] ?? "").match(/FAIL (\d+) BLOCKING/u)?.[1];
  assert.equal(blocking(run.out), blocking(plain.out));
  assert.doesNotMatch(run.out, /Changed, not less autonomy/u);
});

test("S-5 (b): a deny that names no request key binds by tool and command to what the call appended", BOX_TIMEOUT, () => {
  const run = gate({ PLANT_DENYKEY: "none" }, { ...both(), corpus: corpusWith([STAY, CURL], MANUAL_NO_SAY), baselineCorpus: corpusWith([STAY, CURL], MANUAL) });
  assert.equal(run.status, 1, run.err);
  assert.match(run.out, /minimal card .*technical \(undeclared\) card/u);
});

// --- fold 5: review-b recheck of 6f752ab8 (N-9, N-10) ----------------------------------------

test("N-9: both cores' denies name another call's request with the same command (review-b X2h): exit 2, never none", BOX_TIMEOUT, () => {
  // The curl cards at several workdirs, one worker, one store: the second card's deny names the first's key.
  const run = gate({ PLANT_DENYKEY: "xsame" }, { ...both(), corpus: corpusWith([STAY, CURL], MANUAL), baselineCorpus: corpusWith([STAY, CURL], MANUAL) });
  assert.equal(run.status, 2, `${run.err}\n${run.out.slice(0, 400)}`);
  assert.match(run.err, /card-request-unbound: the hook names request hook:class-diff:cd-\d+:network\.call, another call's, though this call wrote its own request/u);
});

test("N-10: both cores log a class other than the one they carded on (review-b C3) with a real minimal -> technical move: exit 2, never none", BOX_TIMEOUT, () => {
  const run = gate({ PLANT_CLS: "other:read.web" }, { ...both(), corpus: corpusWith([STAY, CURL], MANUAL_NO_SAY), baselineCorpus: corpusWith([STAY, CURL], MANUAL) });
  assert.equal(run.status, 2, `${run.err}\n${run.out.slice(0, 400)}`);
  assert.match(run.err, /card-request-no-human-class: the hook carded this call, but the request it bound to names read\.web, none of which needs a human/u);
});

// --- fold 6: review-b recheck of 2502bc44 (N-15) -------------------------------------------

test("N-15: both cores log digest.share (it needs a human) while carding on network.call (review-b C4), with a real minimal -> technical move: exit 2, never none", BOX_TIMEOUT, () => {
  const run = gate({ PLANT_CLS: "other:digest.share" }, { ...both(), corpus: corpusWith([STAY, CURL], MANUAL_NO_SAY), baselineCorpus: corpusWith([STAY, CURL], MANUAL) });
  assert.equal(run.status, 2, `${run.err}\n${run.out.slice(0, 400)}`);
  assert.match(run.err, /card-request-class-mismatch: the hook carded this call, but request hook:class-diff:cd-\d+ logs hook:class-diff:cd-\d+:network\.call as digest\.share/u);
});

const withSecret = (block: string, name: string): string => {
  assert.doesNotMatch(block, /^audit:/mu);
  return `${block.trimEnd()}\naudit:\n  sampling_secret_env: ${name}\n`;
};

test("N-7: a template naming a box layout or runtime variable as its sampling secret: exit 2", BOX_TIMEOUT, () => {
  for (const name of ["HOME", "APPROVAL_HERMES_HOME", "PATH"]) {
    const corpus = corpusWith([STAY, CURL], withSecret(MANUAL, name));
    const run = gate({}, { core: ROOT, corpus, baselineCorpus: corpus });
    assert.equal(run.status, 2, `${name}: ${run.err}`);
    assert.match(run.err, /sampling_secret_env .*a box layout or runtime variable/u, name);
  }
});

test("N-7 control: a plain sampling secret name passes, class-diff: none", BOX_TIMEOUT, () => {
  const corpus = corpusWith([STAY, CURL], withSecret(MANUAL, "CLASS_DIFF_SAMPLING_SECRET"));
  const run = gate({}, { core: ROOT, corpus, baselineCorpus: corpus });
  assert.equal(run.status, 0, run.err);
  assert.match(run.out, /^CLASS-DIFF PASS: .*class-diff: none/u);
});
