import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { classifyApplyPatch, parseApplyPatch } from "../src/core/apply-patch.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-apply-patch-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

test("parseApplyPatch accepts the exact Add, Update, Delete, and Move grammar", () => {
  const parsed = parseApplyPatch([
    "*** Begin Patch",
    "*** Add File: added.txt",
    "+one",
    "+two",
    "*** Update File: old.txt",
    "*** Move to: moved.txt",
    "@@ context",
    "-old",
    "+new",
    "*** End of File",
    "*** Delete File: gone.txt",
    "*** End Patch",
    "",
  ].join("\n"));
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.detail);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.operations.map((operation) => operation.kind), ["add", "update", "delete"]);
  assert.equal(parsed.operations[1]?.kind === "update" ? parsed.operations[1].moveTo : null, "moved.txt");

  const pureMove = parseApplyPatch(
    "*** Begin Patch\n*** Update File: old.txt\n*** Move to: moved.txt\n*** End Patch",
  );
  assert.equal(pureMove.ok, true, pureMove.ok ? "" : pureMove.detail);
});

test("parseApplyPatch rejects malformed, unsafe, and conflicting envelopes", () => {
  const invalid = [
    "*** Begin Patch\n*** End Patch",
    "*** Begin Patch\n*** Add File: ../escape\n+x\n*** End Patch",
    "*** Begin Patch\n*** Add File: C:\\escape\n+x\n*** End Patch",
    "*** Begin Patch\n*** Add File: alias\\file\n+x\n*** End Patch",
    "*** Begin Patch\n*** Delete File: x\nbody\n*** End Patch",
    "*** Begin Patch\n*** Update File: x\n@@\n context\n*** End Patch",
    "*** Begin Patch\n*** Update File: x\n@@\n same\n*** End Patch",
    "*** Begin Patch\n*** Add File: x\n+x\n*** Delete File: x\n*** End Patch",
    "*** Begin Patch\r\n*** End Patch",
    "*** Begin Patch\n*** Add File: x\n+x\n*** End Patch\n\n",
  ];
  for (const raw of invalid) assert.equal(parseApplyPatch(raw).ok, false, raw);
});

test("classifyApplyPatch unions every source and destination class", () => {
  const root = join(scratch, "union");
  mkdirSync(join(root, ".codex"), { recursive: true });
  writeFileSync(join(root, "ordinary.txt"), "old\n");
  const parsed = parseApplyPatch([
    "*** Begin Patch",
    "*** Update File: ordinary.txt",
    "@@",
    "-old",
    "+new",
    "*** Add File: .codex/hooks.json",
    "+{}",
    "*** End Patch",
  ].join("\n"));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const classified = classifyApplyPatch(parsed, root);
  assert.equal(classified.ok, true, classified.ok ? "" : classified.detail);
  if (!classified.ok) return;
  assert.deepEqual(classified.classes, ["files.write.workspace", "policy.core"]);

  const move = parseApplyPatch(
    "*** Begin Patch\n*** Update File: ordinary.txt\n*** Move to: .codex/config.toml\n*** End Patch",
  );
  assert.equal(move.ok, true);
  if (!move.ok) return;
  const moveClassified = classifyApplyPatch(move, root);
  assert.equal(moveClassified.ok, true, moveClassified.ok ? "" : moveClassified.detail);
  if (!moveClassified.ok) return;
  assert.deepEqual(moveClassified.classes, ["files.write.workspace", "policy.core"]);
  assert.deepEqual(moveClassified.targets.map((target) => target.role), ["update", "move-destination"]);
});

test("classifyApplyPatch rejects missing sources, existing destinations, and symlink escapes", () => {
  const root = join(scratch, "escapes");
  const outside = join(scratch, "outside");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, "exists"), "x");
  symlinkSync(outside, join(root, "alias"));
  symlinkSync(join(outside, "missing"), join(root, "dangling"));
  symlinkSync(join(outside, "missing-dir"), join(root, "dangling-dir"));
  for (const raw of [
    "*** Begin Patch\n*** Delete File: missing\n*** End Patch",
    "*** Begin Patch\n*** Add File: exists\n+x\n*** End Patch",
    "*** Begin Patch\n*** Add File: alias/escape\n+x\n*** End Patch",
    "*** Begin Patch\n*** Add File: dangling\n+x\n*** End Patch",
    "*** Begin Patch\n*** Add File: dangling-dir/escape\n+x\n*** End Patch",
  ]) {
    const parsed = parseApplyPatch(raw);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) continue;
    assert.equal(classifyApplyPatch(parsed, root).ok, false, raw);
  }
});

test("classifyApplyPatch retains protected ancestors when cwd is inside them", () => {
  const root = join(scratch, "ancestor");
  mkdirSync(join(root, ".codex"), { recursive: true });
  mkdirSync(join(root, ".approval", "log"), { recursive: true });
  for (const [cwd, name, expected] of [
    [join(root, ".codex"), "hooks.json", "policy.core"],
    [join(root, ".approval", "log"), "new.txt", "log.mutate"],
  ] as const) {
    const parsed = parseApplyPatch(`*** Begin Patch\n*** Add File: ${name}\n+x\n*** End Patch`);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) continue;
    const classified = classifyApplyPatch(parsed, cwd);
    assert.equal(classified.ok, true, classified.ok ? "" : classified.detail);
    if (classified.ok) assert.deepEqual(classified.classes, [expected]);
  }

  mkdirSync(join(root, "nested", "protected"), { recursive: true });
  const routed = parseApplyPatch("*** Begin Patch\n*** Add File: child.txt\n+x\n*** End Patch");
  assert.equal(routed.ok, true);
  if (!routed.ok) return;
  const classified = classifyApplyPatch(routed, join(root, "nested", "protected"), [
    { path: join(root, "nested", "protected") + "/", class: "policy.edit.custom" },
  ]);
  assert.equal(classified.ok, true, classified.ok ? "" : classified.detail);
  if (classified.ok) assert.deepEqual(classified.classes, ["policy.edit.custom"]);
});
