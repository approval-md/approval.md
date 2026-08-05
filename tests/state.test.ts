/**
 * Verified reads and the module boundary (APRV-20 findings S1 and S4).
 *
 * `core/state.ts` is where the runtime turns log bytes into answers, so it is
 * tested on the two properties it was extracted to hold: it refuses to derive
 * anything from a log that does not verify, and it is the *only* thing the gate
 * and the token module share — the import cycle between those two is gone.
 *
 * Every log here is built through the real `appendEvent` path. The damaged logs
 * are copies, damaged after the fact: the copy plays the attacker or the crashed
 * writer, and the original is never touched.
 */

import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { appendEvent, type EventInput } from "../src/core/log.js";
import {
  headOf,
  readVerifiedRecords,
  VerifiedReadCache,
  type ReadRecordsResult,
  type ReadVerifiedOptions,
} from "../src/core/state.js";

/** dist/tests/state.test.js -> <repo>/src/core */
const SOURCE_DIR = fileURLToPath(new URL("../../src/core/", import.meta.url));

const scratch = mkdtempSync(join(tmpdir(), "approval-md-state-"));
let counter = 0;

const restoreOnExit: string[] = [];

after(() => {
  for (const path of restoreOnExit) {
    try {
      chmodSync(path, 0o644);
    } catch {
      // Already gone or already writable.
    }
  }
  rmSync(scratch, { recursive: true, force: true });
});

function event(index: number): EventInput {
  const stamp = String(index).padStart(2, "0");
  return {
    ts: `2026-08-04T09:${stamp}:00Z`,
    event: "task.registered",
    actor: "agent:planner",
    task: `task-${stamp}`,
    payload: { note: `record ${index}` },
  };
}

/** A fresh log of `count` real records. */
function buildLog(count: number): string {
  counter += 1;
  const logPath = join(scratch, `case-${counter}`, "events.jsonl");
  for (let index = 1; index <= count; index += 1) {
    assert.equal(appendEvent(logPath, event(index)).ok, true, `append ${index} failed`);
  }
  return logPath;
}

const RUNNING_AS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

/**
 * How a test performs a verified read.
 *
 * APRV-43 put a verified-read cache on this path, so the corpus below runs
 * twice: once with the cache switched off (verification from genesis, every
 * time, exactly as before APRV-43), and once through a cache that is read twice
 * so the second read is served warm. The two modes must be indistinguishable —
 * the mode itself asserts it, and `tests/state-cache.test.ts` presses the point
 * against a log that changes underneath the cache.
 */
interface ReadMode {
  label: string;
  read: (logPath: string, options?: ReadVerifiedOptions) => ReadRecordsResult;
}

const MODES: ReadMode[] = [
  {
    label: "uncached",
    read: (logPath, options = {}) => readVerifiedRecords(logPath, { ...options, cache: null }),
  },
  {
    label: "cached",
    read: (logPath, options = {}) => {
      const cache = new VerifiedReadCache();
      const cold = readVerifiedRecords(logPath, { ...options, cache });
      const warm = readVerifiedRecords(logPath, { ...options, cache });
      assert.deepEqual(warm, cold, "a warm cached read must equal the cold one");
      return warm;
    },
  },
];

for (const mode of MODES) {
  test(`an absent log reads as an empty log with a null head (${mode.label})`, () => {
    const result = mode.read(join(scratch, "nowhere", "events.jsonl"));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.records, []);
      assert.equal(result.head, null);
    }
  });

  test(`a clean log yields its records and the head an append can be pinned to (${mode.label})`, () => {
    const logPath = buildLog(3);
    const result = mode.read(logPath);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");

    assert.deepEqual(
      result.records.map((record) => record.seq),
      [1, 2, 3],
    );
    assert.deepEqual(result.head, headOf(result.records));
    assert.equal(result.head?.seq, 3);
    assert.equal(result.head?.hash, result.records[2]?.hash);

    // And that head is exactly what the writer's precondition accepts.
    assert.equal(appendEvent(logPath, event(4), { expectedHead: result.head }).ok, true);
  });

  test(`a mutated record is log-corrupt, not silently trusted (${mode.label})`, () => {
    const logPath = buildLog(3);
    const tampered = `${logPath}.tampered`;
    copyFileSync(logPath, tampered);
    const lines = readFileSync(tampered, "utf8").split("\n");
    const record = JSON.parse(lines[1] as string) as Record<string, unknown>;
    record["payload"] = { note: "forged" };
    lines[1] = JSON.stringify(record);
    writeFileSync(tampered, lines.join("\n"));

    const result = mode.read(tampered);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "log-corrupt");
      assert.match(result.message, /hash-mismatch at seq 2/);
      assert.match(result.message, /approval log verify/);
    }
  });

  test(`a deleted record is log-corrupt: the chain notices the gap (${mode.label})`, () => {
    const logPath = buildLog(3);
    const spliced = `${logPath}.spliced`;
    const lines = readFileSync(logPath, "utf8").split("\n").filter((line) => line.length > 0);
    writeFileSync(spliced, `${[lines[0], lines[2]].join("\n")}\n`);

    const result = mode.read(spliced);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "log-corrupt");
  });

  test(`a torn tail keeps its own code: nothing is repaired here (${mode.label})`, () => {
    const logPath = buildLog(3);
    const torn = `${logPath}.torn`;
    copyFileSync(logPath, torn);
    const before = readFileSync(torn, "utf8");
    writeFileSync(torn, `${before}{"seq":4,"ts":"2026-08-04T10:00`);

    const result = mode.read(torn);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "log-torn-tail");
      assert.match(result.message, /Nothing is repaired here/);
    }
  });

  test(`an unopenable log is log-unreadable — an I/O fact, never an accusation (${mode.label})`, {
    skip: RUNNING_AS_ROOT ? "running as root: permission bits are not enforced" : false,
  }, () => {
    const logPath = buildLog(2);
    chmodSync(logPath, 0o000);
    restoreOnExit.push(logPath);

    const result = mode.read(logPath);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "log-unreadable");
      assert.doesNotMatch(result.message, /corrupt/iu);
    }
  });
}

test("headOf is null for an empty list", () => {
  assert.equal(headOf([]), null);
});

test("the default read path is cached, so a watch loop needs no wiring", () => {
  // APRV-43 AC #3: the daemon gets the acceleration by calling the same
  // function everything else calls. Asserted on the default (no `cache`
  // option), which is the call every consumer in `src/` makes today.
  const logPath = buildLog(3);
  const first = readVerifiedRecords(logPath);
  const second = readVerifiedRecords(logPath);
  assert.deepEqual(second, first);
  assert.deepEqual(second, readVerifiedRecords(logPath, { cache: null }));
});

test("the gate <-> token import cycle is gone", () => {
  // The structural claim of APRV-20 finding S4, asserted on the source rather
  // than trusted: `token.ts` imports no part of `gate.ts`. The one permitted
  // edge is the other direction — gate -> token, at the mint seam.
  const token = readFileSync(join(SOURCE_DIR, "token.ts"), "utf8");
  const importedModules = [...token.matchAll(/^\s*import[^;]*from\s+"([^"]+)";/gmu)].map(
    (match) => match[1],
  );
  assert.equal(
    importedModules.includes("./gate.js"),
    false,
    `token.ts must not import the gate; it imports ${JSON.stringify(importedModules)}`,
  );
  assert.ok(importedModules.includes("./state.js"), "token.ts derives state from state.ts");

  const gate = readFileSync(join(SOURCE_DIR, "gate.ts"), "utf8");
  const gateImports = [...gate.matchAll(/^\s*import[^;]*from\s+"([^"]+)";/gmu)].map(
    (match) => match[1],
  );
  assert.ok(gateImports.includes("./token.js"), "gate.ts still mints at grant");
  assert.ok(gateImports.includes("./state.js"), "gate.ts derives state from state.ts");

  // And `state.ts` depends on neither, so the shared foundation cannot close a
  // cycle of its own.
  const state = readFileSync(join(SOURCE_DIR, "state.ts"), "utf8");
  const stateImports = [...state.matchAll(/^\s*import[^;]*from\s+"([^"]+)";/gmu)].map(
    (match) => match[1],
  );
  assert.deepEqual(stateImports.includes("./gate.js"), false);
  assert.deepEqual(stateImports.includes("./token.js"), false);
});

test("frontmatter parses through the policy loader's hardened parser only", () => {
  // APRV-20 finding S5: the replicated parser settings are gone, so no
  // `parseDocument` call survives in `frontmatter.ts`.
  const frontmatter = readFileSync(join(SOURCE_DIR, "frontmatter.ts"), "utf8");
  assert.equal(
    frontmatter.includes("parseDocument("),
    false,
    "frontmatter.ts must not parse YAML itself",
  );
  assert.ok(frontmatter.includes("parseHardenedYaml("), "it calls the shared parser");
});
