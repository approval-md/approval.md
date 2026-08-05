/**
 * MILESTONES.md is the canonical map between SPEC milestone names and
 * Backlog.md ids (see its standing rules). This guard makes drift loud:
 * every milestone id any task carries must appear in the map with a matching
 * display name, and every milestone file's title must match the map too.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function mapRows(): Map<string, string> {
  const text = readFileSync(join(ROOT, "MILESTONES.md"), "utf8");
  const rows = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^\|\s*[^|]+\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|/.exec(line);
    if (match !== null && match[1] !== undefined && match[2] !== undefined) {
      rows.set(match[1], match[2]);
    }
  }
  return rows;
}

test("every task milestone id appears in MILESTONES.md", () => {
  const rows = mapRows();
  assert.ok(rows.size >= 8, "the map must parse; got too few rows");
  const tasksDir = join(ROOT, "backlog", "tasks");
  for (const name of readdirSync(tasksDir)) {
    if (!name.endsWith(".md")) continue;
    const text = readFileSync(join(tasksDir, name), "utf8");
    const match = /^milestone:\s*(\S+)\s*$/m.exec(text);
    if (match === null || match[1] === undefined) continue;
    assert.ok(
      rows.has(match[1]),
      `task ${name} carries milestone id ${match[1]} which is missing from MILESTONES.md`,
    );
  }
});

test("every milestone file's title matches the map's display name", () => {
  const rows = mapRows();
  const dir = join(ROOT, "backlog", "milestones");
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const id = name.split(" - ")[0];
    assert.ok(id !== undefined && rows.has(id), `milestone file ${name} id missing from MILESTONES.md`);
    const text = readFileSync(join(dir, name), "utf8");
    const title = /^title:\s*(.+?)\s*$/m.exec(text)?.[1] ?? /^#\s*(.+?)\s*$/m.exec(text)?.[1];
    if (title === undefined) return;
    assert.equal(
      title.replace(/^["']|["']$/g, ""),
      rows.get(id),
      `milestone file ${name} title diverges from MILESTONES.md`,
    );
  }
});
