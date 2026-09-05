/**
 * A fake `claude` on PATH, for every test that spawns a verb which may ask for
 * a model gloss (APRV-197).
 *
 * `cli/gloss.ts` reaches a model exactly one way: `spawnSync("claude", ["-p",
 * …])`, with no shell and no configurable binary. That is deliberate — a
 * runtime that let a policy or an environment variable name the executable it
 * runs would have invented a new way to be told what to execute — and it means
 * the only seam a test has is PATH itself.
 *
 * It is the right seam anyway. Stubbing the {@link GlossRunner} proves the
 * channel renders what a runner returns; putting a fake binary in front of the
 * real `spawnSync` proves the VERB is wired to a runner at all, which is the
 * half that was wrong (the listener spawned unconditionally, so the suite had
 * been invoking a real `claude` on every `--once` case since APRV-144 — it just
 * died inside the old 2s timeout and nobody could see it).
 *
 * Two rules for callers, and the second is the one that bites:
 *
 * - a spawned verb that could reach the gloss path MUST be given one of these
 *   environments, or `--no-gloss`. A test that forgets pays 10-15 seconds and a
 *   real model call, and is at the mercy of whether the machine has the CLI;
 * - `body` runs under `/bin/sh` with the prompt as its single argument. Keep it
 *   to `echo`, `exit`, and at most a `touch`: this is a stub, and a stub that
 *   needs debugging is a test that is asserting the wrong thing.
 *
 * Since APRV-227 `scripts/run-tests.mjs` puts a REFUSING stub in front of every
 * harness binary for the whole suite, so a file that forgets one of these gets a
 * fast `null` under `npm test` instead of a real model call. That is a backstop
 * and not a replacement: it makes forgetting cheap, it does not make a runner
 * appear where a test asserts one, and a bare `node --test dist/tests/x.js`
 * still inherits the developer's own PATH. Keep passing these.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** What the fake prints when the caller does not care what the sentence says. */
export const FAKE_GLOSS_SENTENCE = "Stages everything, commits it, and pushes to origin.";

/**
 * Write an executable `claude` under `dir` and return the env fragment that
 * puts it first on PATH.
 *
 * `body` defaults to echoing {@link FAKE_GLOSS_SENTENCE}. Pass `"exit 1"` for
 * the failure path, or a `touch` for a witness file proving whether it ran.
 */
export function fakeClaudeEnv(
  dir: string,
  body = `echo "${FAKE_GLOSS_SENTENCE}"`,
): Record<string, string> {
  const binDir = join(dir, "fake-bin");
  mkdirSync(binDir, { recursive: true });
  const path = join(binDir, "claude");
  writeFileSync(path, `#!/bin/sh\n${body}\n`, "utf8");
  chmodSync(path, 0o755);
  return { PATH: `${binDir}:${process.env["PATH"] ?? ""}` };
}
