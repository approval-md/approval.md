/** APRV-325.2.1: bounded, policy-bound Codex workspace planning. */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  MAX_WORKSPACE_DIRECTORY_ENTRIES,
  MAX_WORKSPACE_IMAGE_BYTES,
  MAX_WORKSPACE_OPERATIONS,
  MAX_WORKSPACE_TOTAL_BYTES,
  planWorkspaceProposal,
  revalidateWorkspacePlan,
  type WorkspaceOperationInput,
  type WorkspacePlanContext,
} from "../src/codex/workspace-plan.js";
import { loadPolicy } from "../src/core/policy-load.js";

const scratch = mkdtempSync(join(tmpdir(), "approval-md-codex-workspace-plan-"));
let serial = 0;

after(() => rmSync(scratch, { recursive: true, force: true }));

function sha(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function b64(bytes: string | Buffer): string {
  return Buffer.from(bytes).toString("base64");
}

function fixture(options: { protected?: boolean } = {}): { root: string; context: WorkspacePlanContext } {
  serial += 1;
  const unit = join(scratch, String(serial));
  const rootPath = join(unit, "workspace");
  mkdirSync(rootPath, { recursive: true });
  const root = realpathSync(rootPath);
  const policyPath = join(unit, "POLICY.md");
  const protectedBlock = options.protected
    ? [
        "protected_paths:",
        "  - { path: docs/, class: policy.edit.docs }",
        "  - { path: secret/, class: policy.edit.secret }",
      ]
    : [];
  writeFileSync(policyPath, [
    "# Test policy",
    "",
    "```yaml approval-policy",
    'version: "0.1"',
    "defaults:",
    "  autonomy: manual",
    ...protectedBlock,
    "classes:",
    "  files.write.workspace: { autonomy: manual }",
    "  policy.edit: { autonomy: manual }",
    "  policy.edit.docs: { autonomy: manual }",
    "  policy.edit.secret: { autonomy: human-only }",
    "```",
    "",
  ].join("\n"));
  const policy = loadPolicy({ file: policyPath });
  assert.equal(policy.ok, true, policy.ok ? "" : policy.message);
  return {
    root,
    context: { actor: "agent:codex", root, policy_sha256: "a".repeat(64), policy },
  };
}

function successful(input: unknown, context: WorkspacePlanContext) {
  const result = planWorkspaceProposal(input, context);
  if (!result.ok) assert.fail(`${result.code}: ${result.message}`);
  return result.plan;
}

function refused(input: unknown, context: WorkspacePlanContext, code: string): void {
  const result = planWorkspaceProposal(input, context);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, code, result.message);
}

test("binds all four closed operations, bytes, identities, classes and one payload hash", () => {
  const { root, context } = fixture();
  mkdirSync(join(root, "nested"));
  writeFileSync(join(root, "replace.txt"), "old");
  writeFileSync(join(root, "delete.txt"), "gone");
  writeFileSync(join(root, "nested", "move.txt"), "move");
  const plan = successful([
    { kind: "create", path: "new.txt", after_base64: b64("new") },
    { kind: "replace", path: "replace.txt", expected_before_sha256: sha("old"), after_base64: b64("fresh") },
    { kind: "delete", path: "delete.txt", expected_before_sha256: sha("gone") },
    { kind: "move", from: "nested/move.txt", to: "nested/moved.txt", expected_before_sha256: sha("move") },
  ], context);
  assert.equal(plan.payload.operations.length, 4);
  assert.deepEqual(plan.actions, [{ class: "files.write.workspace", reversible: false, payload_hash: plan.payload_hash }]);
  const moved = plan.payload.operations[3];
  assert.equal(moved?.kind, "move");
  if (moved?.kind === "move") {
    assert.deepEqual(moved.source_directories.map((entry) => entry.path), ["nested"]);
    assert.deepEqual(moved.destination_directories.map((entry) => entry.path), ["nested"]);
    assert.equal(moved.before.base64, moved.after.base64);
    assert.match(moved.before.metadata.dev, /^\d+$/u);
    assert.match(moved.before.metadata.mtime_ns, /^\d+$/u);
  }
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.payload.operations));
  assert.throws(() => { (plan.actions as unknown[]).push({}); }, TypeError);
  assert.equal(revalidateWorkspacePlan(plan, context).ok, true);
});

test("accepts the exact one-MiB canonical base64 boundary without parser recursion", () => {
  const { context } = fixture();
  const bytes = Buffer.alloc(MAX_WORKSPACE_IMAGE_BYTES, 0xa5);
  const plan = successful([{ kind: "create", path: "max.bin", after_base64: bytes.toString("base64") }], context);
  const operation = plan.payload.operations[0];
  assert.equal(operation?.kind, "create");
  if (operation?.kind === "create") assert.equal(operation.after.byte_length, MAX_WORKSPACE_IMAGE_BYTES);
});

test("rejects malformed and noncanonical base64 and stops on aggregate overflow", () => {
  const { context } = fixture();
  for (const value of ["A===", "a", "AA=A", "AB==", `${b64(Buffer.alloc(MAX_WORKSPACE_IMAGE_BYTES))}AAAA`]) {
    refused([{ kind: "create", path: "x", after_base64: value }], context, "input-invalid");
  }
  const image = b64(Buffer.alloc(MAX_WORKSPACE_IMAGE_BYTES));
  const operations = Array.from({ length: MAX_WORKSPACE_TOTAL_BYTES / MAX_WORKSPACE_IMAGE_BYTES + 1 }, (_, index) => ({
    kind: "create", path: `f-${String(index)}`, after_base64: image,
  }));
  refused(operations, context, "payload-too-large");
});

test("rejects unknown fields, kinds, excessive operations and non-agent contexts", () => {
  const { context } = fixture();
  refused([{ kind: "create", path: "x", after_base64: "", extra: true }], context, "input-invalid");
  refused([{ kind: "chmod", path: "x" }], context, "input-invalid");
  refused(Array.from({ length: MAX_WORKSPACE_OPERATIONS + 1 }, (_, index) => ({ kind: "create", path: `f${String(index)}`, after_base64: "" })), context, "operation-limit");
  for (const actor of ["human:carter", "system:codex", "agent:", "agent:x\n", "agent:x\ud800"] ) {
    refused([{ kind: "create", path: "x", after_base64: "" }], { ...context, actor }, "input-invalid");
  }
});

test("rejects ambiguous, non-NFC, malformed-Unicode and escaping paths", () => {
  const { context } = fixture();
  for (const path of ["/abs", "../up", "a/../b", "a\\b", "a//b", "e\u0301", "bad\u0000name", "bad\ud800name", "bad\udc00name", "trailing\ud800", `${"x".repeat(1025)}`]) {
    refused([{ kind: "create", path, after_base64: "" }], context, "path-invalid");
  }
  successful([{ kind: "create", path: "emoji-😀", after_base64: "" }], context);
});

test("rejects duplicate, case-aliased, overlapping and chained endpoints", () => {
  const { context } = fixture();
  const cases: WorkspaceOperationInput[][] = [
    [{ kind: "create", path: "x", after_base64: "" }, { kind: "create", path: "x", after_base64: "" }],
    [{ kind: "create", path: "Name", after_base64: "" }, { kind: "create", path: "name", after_base64: "" }],
    [{ kind: "create", path: "a", after_base64: "" }, { kind: "create", path: "a/b", after_base64: "" }],
    [{ kind: "move", from: "a", to: "b", expected_before_sha256: sha("") }, { kind: "move", from: "b", to: "c", expected_before_sha256: sha("") }],
  ];
  for (const value of cases) refused(value, context, "path-conflict");
});

test("refuses human-only built-ins and routed classes before endpoint inspection", () => {
  const unit = fixture({ protected: true });
  refused([{ kind: "delete", path: ".approval/log/events.jsonl", expected_before_sha256: sha("unknown") }], unit.context, "class-human-only");
  refused([{ kind: "delete", path: ".approval/vault.enc", expected_before_sha256: sha("unknown") }], unit.context, "class-human-only");
  refused([{ kind: "delete", path: "secret/does-not-exist", expected_before_sha256: sha("unknown") }], unit.context, "class-human-only");
});

test("emits one sorted action leg per distinct permitted endpoint class", () => {
  const unit = fixture({ protected: true });
  mkdirSync(join(unit.root, "docs"));
  const plan = successful([
    { kind: "create", path: "ordinary", after_base64: "" },
    { kind: "create", path: "docs/note", after_base64: b64("note") },
  ], unit.context);
  assert.deepEqual(plan.actions.map((action) => action.class), ["files.write.workspace", "policy.edit.docs"]);
  assert.ok(plan.actions.every((action) => action.payload_hash === plan.payload_hash));
});

test("rejects missing and aliased parents, existing destinations, symlinks, hardlinks and directories", () => {
  const { root, context } = fixture();
  mkdirSync(join(root, "Real"));
  writeFileSync(join(root, "Real", "source"), "x");
  writeFileSync(join(root, "exists"), "x");
  symlinkSync("Real/source", join(root, "link"));
  linkSync(join(root, "Real", "source"), join(root, "hard"));
  refused([{ kind: "create", path: "missing/x", after_base64: "" }], context, "parent-unsafe");
  refused([{ kind: "delete", path: "real/source", expected_before_sha256: sha("x") }], context, "parent-unsafe");
  refused([{ kind: "create", path: "exists", after_base64: "" }], context, "destination-exists");
  refused([{ kind: "delete", path: "link", expected_before_sha256: sha("x") }], context, "source-unsafe");
  refused([{ kind: "delete", path: "hard", expected_before_sha256: sha("x") }], context, "source-unsafe");
  refused([{ kind: "delete", path: "Real", expected_before_sha256: sha("x") }], context, "source-unsafe");
});

test("bounds directory scans instead of materializing an unbounded parent", () => {
  const { root, context } = fixture();
  const crowded = join(root, "crowded");
  mkdirSync(crowded);
  for (let index = 0; index <= MAX_WORKSPACE_DIRECTORY_ENTRIES; index += 1) {
    writeFileSync(join(crowded, `entry-${String(index).padStart(4, "0")}`), "");
  }
  refused([{ kind: "create", path: "crowded/new", after_base64: "" }], context, "path-conflict");
});

test("checks expected hashes and combined before-plus-after size", () => {
  const { root, context } = fixture();
  writeFileSync(join(root, "wrong"), "actual");
  refused([{ kind: "replace", path: "wrong", expected_before_sha256: sha("other"), after_base64: "" }], context, "preimage-mismatch");
  const oversized = Buffer.alloc(MAX_WORKSPACE_IMAGE_BYTES + 1);
  writeFileSync(join(root, "oversized"), oversized);
  refused([{ kind: "delete", path: "oversized", expected_before_sha256: sha(oversized) }], context, "payload-too-large");
  const image = Buffer.alloc(MAX_WORKSPACE_IMAGE_BYTES);
  const moves: WorkspaceOperationInput[] = [];
  for (let index = 0; index < 5; index += 1) {
    const name = `move-${String(index)}`;
    writeFileSync(join(root, name), image);
    moves.push({ kind: "move", from: name, to: `${name}-to`, expected_before_sha256: sha(image) });
  }
  refused(moves, context, "payload-too-large");
});

test("revalidation refuses content, context, and intermediate ancestor identity drift", () => {
  const { root, context } = fixture();
  mkdirSync(join(root, "a", "b"), { recursive: true });
  writeFileSync(join(root, "a", "b", "file"), "before");
  const plan = successful([{ kind: "replace", path: "a/b/file", expected_before_sha256: sha("before"), after_base64: b64("after") }], context);
  writeFileSync(join(root, "a", "b", "file"), "changed");
  assert.deepEqual(revalidateWorkspacePlan(plan, context).ok, false);
  writeFileSync(join(root, "a", "b", "file"), "before");
  assert.deepEqual(revalidateWorkspacePlan(plan, { ...context, policy_sha256: "b".repeat(64) }).ok, false);

  renameSync(join(root, "a"), join(root, "old-a"));
  mkdirSync(join(root, "a"));
  renameSync(join(root, "old-a", "b"), join(root, "a", "b"));
  const result = revalidateWorkspacePlan(plan, context);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "workspace-drift");
});

test("rejects a symbolic workspace root", () => {
  const unit = fixture();
  const alias = join(scratch, `root-link-${String(serial)}`);
  symlinkSync(unit.root, alias);
  refused([{ kind: "create", path: "x", after_base64: "" }], { ...unit.context, root: alias }, "root-unsafe");
});
