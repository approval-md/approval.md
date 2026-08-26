/**
 * The model gloss: one sentence saying what a command does, attached to a
 * prompt at render time and to nothing else (APRV-144).
 *
 * The observed complaint (Carter, 2026-08-25): "the claimed isn't very useful —
 * I mostly see the path, not a readable claim of what is happening". The
 * deterministic half of the answer is `channels/payload-view.ts`'s command
 * breakdown, which is derived from the classifier's own parse and is COMPUTED.
 * This is the other half, and it is the opposite kind of thing: a sentence from
 * a language model, which no party vouches for and which the runtime must
 * therefore treat as decoration.
 *
 * Four properties hold the design together, and every one of them is about
 * keeping a model out of the decision.
 *
 * **The gate never sees it.** This runs in the LISTENER, at the moment a
 * message is about to be sent, on a `ChannelRequest` the tagger has already
 * finished building. The payload hash covers the bytes and not this; the log
 * records the approval lifecycle and not this; a restart forgets it. Nothing
 * here writes anything anywhere.
 *
 * **It is never load-bearing.** No code path branches on the content of a
 * gloss. The only thing that turns on it at all is whether one more line
 * appears in the CLAIMED block, which is why every failure mode below resolves
 * to ABSENCE rather than to a placeholder, an error line, or a retry: a prompt
 * with no gloss is the prompt approval.md shipped for its whole life so far,
 * and a listener that waited on a model would have made a language model part
 * of the availability of the gate.
 *
 * **It fails toward absence, fast.** A hard timeout (default
 * {@link GLOSS_TIMEOUT_MS}), a non-zero exit, empty output, a binary that is
 * not installed, a spawn that throws: all `null`. The timeout is short on
 * purpose — this sits in a dispatch cycle that an approver is waiting on, and
 * a slow reading aid is worse than no reading aid.
 *
 * **Its output is untrusted text.** Whatever comes back is collapsed to a
 * single line, capped at {@link GLOSS_MAX_CHARS}, and handed to the channel as
 * a CLAIMED field, which means it goes through the same `escapeHtml` every
 * other claimed value does. It is treated exactly like a summary an agent
 * wrote, because that is precisely what it is a cousin of.
 *
 * The subprocess is injectable ({@link GlossRunner}) so the tests drive both
 * branches without a model ever being invoked: the suite never spawns
 * anything, and the default runner below is exercised only in production.
 */

import { spawnSync } from "node:child_process";

/** How long the subprocess gets before it is killed and the gloss is dropped. */
export const GLOSS_TIMEOUT_MS = 2_000;

/** The most characters a gloss may occupy on the prompt. */
export const GLOSS_MAX_CHARS = 200;

/**
 * The model tier this spends: the cheap one.
 *
 * CLAUDE.md's model tiers put "cheap classification" on a `claude -p` haiku
 * subprocess, and a one-sentence paraphrase of a command line is the cheapest
 * kind of language task there is. Nothing about the prompt or the gate changes
 * if the flag is unrecognised by the installed CLI: an unusable invocation
 * exits non-zero and the gloss is absent.
 */
export const GLOSS_MODEL = "haiku";

/** The author label a gloss is tagged with. Never an actor the log knows. */
export const GLOSS_AUTHOR = `model:${GLOSS_MODEL}`;

/**
 * The instruction the model is given.
 *
 * Deliberately narrow: describe, do not judge. A model asked whether a command
 * is safe would produce a sentence an approver could read as a recommendation,
 * and a recommendation from an unverified party sitting beside an Approve
 * button is the failure this whole codebase is arranged to prevent. It is
 * asked what the command DOES, and the answer is labelled as a model's on the
 * line where it appears.
 */
export const GLOSS_INSTRUCTION = [
  "Describe, in one plain sentence under 25 words, what this shell command does.",
  "Do not judge whether it is safe, do not recommend approving or rejecting it,",
  "and do not add any preamble, quotes or formatting. Output the sentence only.",
].join(" ");

/**
 * How a gloss is obtained. Returns the model's raw text, or `null` for every
 * flavour of "no answer".
 *
 * MUST NOT throw: a runner that raised would put a language model on the
 * failure path of the listener's dispatch cycle.
 */
export type GlossRunner = (prompt: string) => string | null;

/**
 * One line, capped, or `null`.
 *
 * Newlines are stripped rather than escaped because the prompt renders this as
 * a single bullet, and a multi-line value would break the one-fact-per-line
 * shape the whole COMPUTED/CLAIMED split relies on to stay legible. Truncation
 * is marked, for the same reason every other fold in this codebase is.
 */
export function tidyGloss(raw: string | null): string | null {
  if (raw === null) return null;
  const collapsed = raw.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) return null;
  return collapsed.length <= GLOSS_MAX_CHARS
    ? collapsed
    : `${collapsed.slice(0, GLOSS_MAX_CHARS - 1)}…`;
}

/**
 * The production runner: `claude -p --model haiku`, with a hard timeout.
 *
 * `spawnSync` with no shell, in the manner of `cli/hook.ts`'s git calls: the
 * prompt is an argument and never a string a shell re-parses. Every failure is
 * a value rather than an exception — `spawnSync` reports a missing binary and a
 * timeout kill on the result object, and both are simply "no gloss".
 */
export function spawnGloss(prompt: string): string | null {
  let result;
  try {
    result = spawnSync("claude", ["-p", "--model", GLOSS_MODEL, prompt], {
      encoding: "utf8",
      timeout: GLOSS_TIMEOUT_MS,
      killSignal: "SIGKILL",
      // A sentence is a few hundred bytes. A model that decides to emit a
      // megabyte is a model whose answer is dropped rather than buffered.
      maxBuffer: 64 * 1024,
    });
  } catch {
    return null;
  }
  if (result.error !== undefined || result.status !== 0) return null;
  return typeof result.stdout === "string" ? result.stdout : null;
}

/**
 * A gloss for one command, or `null`.
 *
 * The command text is passed to the model as data inside the prompt. It is
 * agent-authored text, and it is worth being explicit about what that does and
 * does not mean here: a command crafted to talk the model into writing
 * "harmless cleanup" gets that sentence onto the prompt, labelled `(model,
 * unverified)`, next to a COMPUTED breakdown derived from the same bytes by
 * code and a FULL PAYLOAD block carrying every byte verbatim. It cannot change
 * the class, the autonomy, the budget verdicts or the payload hash, because
 * nothing downstream reads it. That is the whole reason this is allowed to
 * exist on the prompt at all.
 */
export function glossFor(command: string, run: GlossRunner = spawnGloss): string | null {
  if (command.trim().length === 0) return null;
  let raw: string | null;
  try {
    raw = run(`${GLOSS_INSTRUCTION}\n\n${command}`);
  } catch {
    // A runner is contracted not to throw; if one does anyway, the contract
    // that matters (a gloss never breaks a dispatch cycle) is upheld here.
    return null;
  }
  return tidyGloss(raw);
}
