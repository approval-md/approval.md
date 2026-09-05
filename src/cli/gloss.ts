/**
 * The model gloss: one sentence saying what a payload does, attached to a
 * prompt at render time and to nothing else (APRV-144, APRV-164).
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
 * not installed, a spawn that throws: all `null`. The timeout is bounded on
 * purpose — this sits in a dispatch cycle that an approver is waiting on — and
 * since APRV-197 it is bounded by a MEASUREMENT rather than by a guess, because
 * a ceiling the model cannot meet is not a fast failure, it is a feature that
 * never runs. See {@link GLOSS_TIMEOUT_MS}. Absences are counted and reported
 * by the caller (`cli/gloss-attach.ts`), so a ceiling that is wrong again
 * announces itself instead of looking like silence.
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

import { childEnvironment } from "../core/child-env.js";

/**
 * How long the subprocess gets before it is killed and the gloss is dropped.
 *
 * **Measured, not guessed (APRV-197).** APRV-144 chose 2s on the reasoning that
 * "a slow reading aid is worse than no reading aid", which is true and was the
 * wrong number: five fresh `claude -p --model haiku` spawns of this module's
 * own command instruction, timed on the author's machine on 2026-09-01, came
 * back in 10.2s, 11.3s, 13.5s, 14.6s and 14.9s. Every one of them would have
 * been killed. The gloss was therefore not "occasionally absent"; it was
 * absent every single time, and because absence is silent by design that was
 * indistinguishable from the feature never having shipped — which is exactly
 * how it was reported (Carter, 2026-09-01: "i thought we implemented a change
 * so that the claim would be an llm summary").
 *
 * A pre-warm was the other option on the table and the measurement rules it
 * out: the runs above were consecutive, so runs two through five were warm in
 * every sense a second process can be (page cache, module cache), and they took
 * 10s to 15s all the same. What is being waited on is inference, not start-up,
 * and nothing a listener does once at boot shortens it.
 *
 * So the ceiling is set above the slowest observed run with headroom, and the
 * price of that honesty is made explicit rather than hidden. A gloss is now
 * asked for only under `--gloss` (on `channel cli`, `channel telegram listen`
 * and `up` alike): an operator who wants the sentence spends the seconds
 * knowingly, one who does not is never made to wait, and the reading aid that
 * is always present is the deterministic `command_breakdown` the classifier
 * derives from the same bytes for free.
 */
export const GLOSS_TIMEOUT_MS = 20_000;

/** The most characters a gloss may occupy on the prompt. */
export const GLOSS_MAX_CHARS = 200;

/** Maximum length of an exact provider-supplied model identifier. */
export const GLOSS_MODEL_ID_MAX_CHARS = 100;

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

/**
 * The historical author label for legacy string-valued test runners.
 *
 * Production runners return explicit provenance. Keeping this constant is a
 * compatibility bridge for callers whose injected seam predates APRV-253; it
 * must never be used to guess the provenance of a typed production result.
 */
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
 * The same instruction for a file change (APRV-164).
 *
 * A payload kind gets its own wording because "what this shell command does" is
 * the wrong question to ask about a diff, and a model handed the wrong question
 * answers a question nobody asked. The discipline is identical: describe the
 * change, do not rate it, and above all do not say whether the edit looks
 * correct — a judgement of a diff sitting beside an Approve button is the same
 * failure as a judgement of a command.
 */
export const GLOSS_EDIT_INSTRUCTION = [
  "Describe, in one plain sentence under 25 words, what this file edit changes.",
  "Do not judge whether it is safe or correct, do not recommend approving or rejecting it,",
  "and do not add any preamble, quotes or formatting. Output the sentence only.",
].join(" ");

/** The same instruction for an email (APRV-164): what it says, and to whom. */
export const GLOSS_EMAIL_INSTRUCTION = [
  "Describe, in one plain sentence under 25 words, what this email says and to whom.",
  "Do not judge whether it is safe, do not recommend approving or rejecting it,",
  "and do not add any preamble, quotes or formatting. Output the sentence only.",
].join(" ");

/**
 * The most material a gloss may hand the subprocess.
 *
 * A whole-file `Write` payload is megabytes, and a reading aid must not turn a
 * dispatch cycle into a megabyte of argv and a model reading it. The cap is on
 * the INPUT only: {@link GLOSS_MAX_CHARS} still bounds what comes back.
 */
export const GLOSS_MAX_INPUT_CHARS = 8_192;

/**
 * What the model is told when the cap bit.
 *
 * Announced rather than silent, for the reason every other fold in this
 * codebase is announced: a model describing a prefix as if it were the whole
 * would produce a confident sentence about a change the approver is not being
 * shown. The line is for the model; the approver's own evidence is the PAYLOAD
 * block, which is never folded.
 */
export const GLOSS_TRUNCATION_NOTE = "(input truncated; describe what is shown)";

/** A summarizer implementation the listener may explicitly select. */
export type GlossProvider = "claude" | "codex";

/**
 * The model identity a runner can honestly establish.
 *
 * `requestedModel` is always present because it is controlled by the
 * invocation. `confirmedModel` is present only when machine-readable process
 * output identifies the model that actually served the request. A successful
 * process exit alone does not confirm that identity.
 */
export interface GlossProvenance {
  provider: GlossProvider;
  requestedModel: string;
  confirmedModel?: string;
}

/** One raw model answer together with runner-supplied provenance. */
export interface GlossResult {
  text: string;
  provenance: GlossProvenance;
  /** Compatibility marker for the pre-APRV-253 injected string seam. */
  legacy?: true;
}

/**
 * How a gloss is obtained.
 *
 * New runners return a {@link GlossResult}. A raw string remains accepted only
 * so existing injected stubs keep working; it is explicitly interpreted as
 * the historical Claude/Haiku seam. Every flavour of "no answer" is `null`.
 *
 * MUST NOT throw: a runner that raised would put a language model on the
 * failure path of the listener's dispatch cycle.
 */
export type GlossRunnerOutput = GlossResult | string | null;
export type GlossRunner = (prompt: string) => GlossRunnerOutput;

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
 * Normalize a runner answer without inventing provenance.
 *
 * Objects with incomplete metadata fail toward absence. Raw strings take the
 * one narrowly documented legacy path and retain the historical Haiku label.
 */
export function tidyGlossResult(raw: unknown): GlossResult | null {
  if (typeof raw === "string" || raw === null) {
    const text = tidyGloss(raw);
    return text === null
      ? null
      : {
          text,
          provenance: { provider: "claude", requestedModel: GLOSS_MODEL },
          legacy: true,
        };
  }

  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate["text"] !== "string") return null;
  const provenanceValue = candidate["provenance"];
  if (typeof provenanceValue !== "object" || provenanceValue === null) return null;
  const provenance = provenanceValue as Record<string, unknown>;
  const requestedModel = normalizeGlossModelId(provenance["requestedModel"]);
  const confirmedModel =
    provenance["confirmedModel"] === undefined
      ? undefined
      : normalizeGlossModelId(provenance["confirmedModel"]);
  if (
    (provenance.provider !== "claude" && provenance.provider !== "codex") ||
    requestedModel === null ||
    (provenance["confirmedModel"] !== undefined && confirmedModel === null)
  ) {
    return null;
  }
  const text = tidyGloss(candidate["text"]);
  if (text === null) return null;
  const normalizedProvenance: GlossProvenance = {
    provider: provenance.provider,
    requestedModel,
  };
  if (typeof confirmedModel === "string") normalizedProvenance.confirmedModel = confirmedModel;
  return { text, provenance: normalizedProvenance };
}

/** A bounded, single-line identifier, or `null` rather than a misleading fold. */
export function normalizeGlossModelId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > GLOSS_MODEL_ID_MAX_CHARS ||
    !/^[\p{L}\p{N}][\p{L}\p{N}._:/+-]*$/u.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

/**
 * The claimed author rendered beside one gloss.
 *
 * Requested and confirmed identities are deliberately distinct. The default
 * subprocess knows what it asked Claude for, but its plain stdout does not
 * prove which model served the request, so it renders as requested.
 */
export function glossAuthor(result: GlossResult): string {
  if (result.legacy === true) return GLOSS_AUTHOR;
  const { provider, requestedModel, confirmedModel } = result.provenance;
  if (confirmedModel === undefined) {
    return `model:${provider}/${requestedModel} (requested)`;
  }
  return confirmedModel === requestedModel
    ? `model:${provider}/${confirmedModel} (confirmed)`
    : `model:${provider}/${confirmedModel} (confirmed; requested:${requestedModel})`;
}

/**
 * The production runner: `claude -p --model haiku`, with a hard timeout.
 *
 * `spawnSync` with no shell, in the manner of `cli/hook.ts`'s git calls: the
 * prompt is an argument and never a string a shell re-parses. Every failure is
 * a value rather than an exception — `spawnSync` reports a missing binary and a
 * timeout kill on the result object, and both are simply "no gloss".
 *
 * **Starved, like a granted child (APRV-207).** The environment is built by
 * APRV-205's scrub rather than inherited: this is a third-party CLI that talks
 * to the network on every prompt render, spawned by the listener, which is the
 * process holding the Telegram bot token and the vault passphrase. It has no
 * use for either, and a gate that hands its own credentials to a convenience is
 * a gate whose custody claim is decorative. No credential is DECLARED here,
 * because a gloss is not a granted action and no adapter asked for one.
 *
 * What passes is what the scrub does not take: the model's own auth
 * (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`,
 * `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL` and kin), `PATH`, `HOME`, `TMPDIR`
 * and the locale. None of them is under the gate's credential-bearing prefixes,
 * so none of them needs a list of its own: a second list here is a second list
 * to drift, and the CLI's ability to reach its own model is not this gate's
 * secret to keep.
 *
 * `passphraseEnv` is the name the policy's `vault.passphrase_env` gives, for
 * the deployment that renamed it out from under the prefixes. Omitted, the
 * default (`APPROVAL_VAULT_PASSPHRASE`) is removed by the prefix rule anyway.
 */
export function spawnGloss(
  prompt: string,
  passphraseEnv: string | null = null,
  model: string = GLOSS_MODEL,
): GlossResult | null {
  const requestedModel = normalizeGlossModelId(model);
  if (requestedModel === null) return null;
  let result;
  try {
    result = spawnSync("claude", ["-p", "--model", requestedModel, prompt], {
      encoding: "utf8",
      env: childEnvironment({ passphraseEnv }).env,
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
  return typeof result.stdout === "string"
    ? {
        text: result.stdout,
        provenance: { provider: "claude", requestedModel },
      }
    : null;
}

/**
 * {@link spawnGloss} bound to one policy's passphrase variable (APRV-207).
 *
 * The verbs that wire a runner (`channel cli`, `channel telegram listen`, `up`)
 * have a policy load in hand already, and this is the only thing the scrub
 * needs from it. A runner is still a `(prompt) => string | null`, so nothing
 * downstream learns that a policy exists.
 */
export function glossRunnerFor(
  passphraseEnv: string | null,
  model: string = GLOSS_MODEL,
): GlossRunner {
  return (prompt: string) => spawnGloss(prompt, passphraseEnv, model);
}

/**
 * `material`, capped at {@link GLOSS_MAX_INPUT_CHARS} and marked when it was.
 *
 * The marker precedes the material rather than trailing it, so a model reading
 * a long prefix meets the caveat before the text it is about to describe.
 */
export function glossPrompt(instruction: string, material: string): string {
  return material.length <= GLOSS_MAX_INPUT_CHARS
    ? `${instruction}\n\n${material}`
    : `${instruction}\n\n${GLOSS_TRUNCATION_NOTE}\n\n${material.slice(0, GLOSS_MAX_INPUT_CHARS)}`;
}

/**
 * A gloss for one payload's material, or `null`.
 *
 * The material is passed to the model as data inside the prompt. It is
 * agent-authored text, and it is worth being explicit about what that does and
 * does not mean here: a command (or a diff, or a body) crafted to talk the
 * model into writing "harmless cleanup" gets that sentence onto the prompt,
 * labelled `(model, unverified)`, next to a COMPUTED breakdown derived from the
 * same bytes by code and a PAYLOAD block carrying the canonical rendering verbatim. It
 * cannot change the class, the autonomy, the budget verdicts or the payload
 * hash, because nothing downstream reads it. That is the whole reason this is
 * allowed to exist on the prompt at all.
 *
 * The caller chooses the instruction, which is the only thing that varies by
 * payload kind: the bounds, the failure modes and the author label are one
 * pipeline for every kind (APRV-164).
 */
export function glossFor(
  instruction: string,
  material: string,
  run: GlossRunner = spawnGloss,
): GlossResult | null {
  if (material.trim().length === 0) return null;
  let raw: GlossRunnerOutput;
  try {
    raw = run(glossPrompt(instruction, material));
    return tidyGlossResult(raw);
  } catch {
    // A runner is contracted not to throw; if one does anyway, the contract
    // that matters (a gloss never breaks a dispatch cycle) is upheld here. The
    // normalization stays inside this boundary because an injected object can
    // throw from a property getter just as readily as the runner can throw.
    return null;
  }
}
