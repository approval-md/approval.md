/**
 * The brace-expansion memo (build-6 round two, for lead bar L62670's node 20
 * cost): `braceCandidates` remembers its answers by word for ONE outermost
 * classification call. Pure, so no answer moves; bounded, so no line grows
 * memory past it: at most BRACE_CANDIDATES_MEMO_CHARS characters (each word
 * and every word it expands to), at most BRACE_CANDIDATES_MEMO_ENTRIES
 * entries, no entry over 2,000,000 characters, and nothing left when the
 * call returns.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BRACE_CANDIDATES_MEMO_CHARS,
  BRACE_CANDIDATES_MEMO_ENTRIES,
  braceCandidates,
  braceCandidatesMemoPeak,
  classifyCommand,
} from "../src/core/command-class.js";

function classesOf(command: string): string[] {
  const result = classifyCommand(command, []);
  assert.ok(result.ok, `${command} was refused`);
  return result.classes;
}

test("a word with a stray `}` alone is expanded as before: the brace reader strips it", () => {
  // Outside a classification call the memo is not used: the reader's own answer.
  assert.deepEqual(braceCandidates(".approval/env}"), [".approval/env}", ".approval/env"]);
  assert.deepEqual(braceCandidates("APPROVAL.md}"), ["APPROVAL.md}", "APPROVAL.md"]);
  // Inside one, the same answers decide the class.
  assert.ok(classesOf("cat .approval/env}").includes("account.credential"));
  assert.ok(classesOf("cat ~/.hermes/.op.env}").includes("account.credential"));
  assert.ok(classesOf("echo x > APPROVAL.md}").includes("policy.core"));
  // Unquoted beside an unread part: the shell keeps a stray `}` (the word
  // is `APPROVAL}…`), so it is not the policy file; the spliced reading's
  // other readings answer, as they did before the memo (ed2e354a).
  assert.deepEqual(classesOf("echo x > APPROVAL}$E.md"), ["log.mutate", "policy.edit", "files.write.workspace"]);
});

test("the memo is bounded in characters and entries, and does not outlive the call", () => {
  // 300 words of eight two-way groups (256 expansions of about 300 characters
  // each): about 23,000,000 characters if every answer were kept. Under 100 KB of input.
  const payload = "p".repeat(275);
  const wide = Array.from({ length: 300 }, (_, i) => `${"{a,b}".repeat(8)}${payload}${String(i)}`).join(" ");
  assert.ok(wide.length < 100_000);
  classifyCommand(`cat ${wide}`, []);
  const held = braceCandidatesMemoPeak();
  assert.ok(held.peak > 0, "the memo was used");
  assert.ok(held.peak <= BRACE_CANDIDATES_MEMO_CHARS, `peak ${String(held.peak)} characters`);
  assert.equal(held.heldNow, 0, "nothing is left after the call");
  // 6,000 small words: at most the entry bound is kept.
  const many = Array.from({ length: 6000 }, (_, i) => `{a,b}${String(i)}`).join(" ");
  assert.ok(many.length < 100_000);
  classifyCommand(`cat ${many}`, []);
  const counted = braceCandidatesMemoPeak();
  assert.ok(counted.entriesPeak <= BRACE_CANDIDATES_MEMO_ENTRIES, `peak ${String(counted.entriesPeak)} entries`);
  assert.ok(counted.entriesPeak > 0);
  assert.equal(counted.heldNow, 0);
});
