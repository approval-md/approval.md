/**
 * `approval policy apply <proposal.md>` (APRV-343) — apply a proposal
 * document's quoted replacements to `APPROVAL.md`, then run the amendment.
 *
 * ## The hand-ritual this replaces
 *
 * Agents may not write `APPROVAL.md`: it is `policy.core`, and this repository's
 * policy holds that class human-only. So a policy change an agent proposes
 * travels as a document under `docs/proposals/` that quotes each current line
 * byte for byte beside its replacement, and the human pastes. On 2026-09-16 the
 * paste was done by copying a prepared file over `APPROVAL.md` and running
 * `approval policy amend`. Two things go wrong with that, and both have:
 *
 * - **a whole-file copy reverts what it did not know about.** The prepared file
 *   was written against the policy as it stood when the proposal was drafted,
 *   so anything landed in between is silently undone. This is the failure
 *   `base-policy-diverged` catches for the COMMIT, one step too late to help;
 * - **a paste carries its wrapper.** One paste of a proposal page took the
 *   page's own fence with it, which hid a block from the loader (APRV-273).
 *
 * This verb answers both by construction. It never writes bytes that are not
 * anchored to bytes already in the live file, and it reads fences by their
 * backtick run, so a four-backtick wrapper around a three-backtick block is the
 * wrapper it is rather than part of the content.
 *
 * ## The contract, and the three questions APRV-343 left open
 *
 * A proposal is markdown. Anywhere in it, a fenced block whose immediately
 * preceding non-blank line is a LABEL is a member of a pair:
 *
 * - `Current:` — the bytes as they stand in the live policy;
 * - `Replace with:` — what they become;
 * - `Supersedes:` — optional, and the answer to the first open question.
 *
 * **How supersession is declared.** Explicitly, by a third block, and never by
 * position. A later section that rewrites a line an earlier section already
 * rewrote quotes the earlier section's RESULT under a `Supersedes:` label, and
 * the applier looks for that text when the section's own `Current` block is no
 * longer in the file — which is exactly the state the earlier section left
 * behind. Position could not carry this: two sections that touch one line are
 * not in general in the order the file needs, and a rule inferred from order is
 * a rule nobody can read off the page. A pair whose `Current` AND `Supersedes`
 * blocks both occur is ambiguous and refuses, because it means the file
 * contains both spellings and no verb here will pick.
 *
 * **Whether a whole-file replacement is accepted.** No, and that is the
 * decision rather than an omission. The verb's whole value is that every byte it
 * writes is anchored to a byte it proved present, which is what makes a stale
 * proposal a refusal instead of a silent revert. A whole-file blob has no
 * anchor: applying one is a paste with extra steps, and `approval policy amend`
 * over a hand-edited file is already the supported way to do that deliberately.
 *
 * **How the values block is treated.** Identically, and by knowing nothing
 * about it. The applier is a byte-level replacement over the whole file; it
 * does not parse the policy, does not locate blocks, and does not care which
 * fence a pair lands in. The values block is inert (SPEC §11.1 invariant 10),
 * so applying one changes no verdict, and the attestation the amend appends
 * covers the whole file's bytes either way (SPEC §5.2, §5.3). A verb that
 * treated the two blocks differently would be asserting a distinction the file
 * does not make.
 *
 * ## Refuse before writing, always
 *
 * Every pair is resolved against an IN-MEMORY copy, in document order, before a
 * byte reaches the disk. A proposal whose third pair is stale writes nothing at
 * all, so "a stale proposal cannot half-apply" is a property of the code rather
 * than of the order somebody wrote the sections in.
 *
 * ## Human-only
 *
 * `approval policy apply` classifies `policy.core` (`core/command-class.ts`),
 * which this repository's policy holds human-only, so the hook denies an agent
 * that runs it. The verb ALSO refuses an agent identity itself, with
 * `apply-agent-actor`: a lock that exists only in the classifier is a lock that
 * a harness without a hook does not have. It mints no class — `policy.core`
 * already exists and already covers the policy's own machinery (SPEC §11.1
 * invariant 9).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePathSegments } from "node:path";

import { commandPolicyAmend } from "./amend.js";
import { EXIT_IO, EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { POLICY_APPLY_HELP } from "./help.js";
import type { Streams } from "./main.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import { preflightPolicyPath } from "./preflight.js";
import { readLineFromStdin } from "./prompt.js";
import { style } from "./style.js";
import { usageErrorText } from "./usage.js";

const FLAGS: Record<string, FlagKind> = {
  "--policy": "string",
  "--dir": "string",
  "--log": "string",
  "--as": "string",
  "--yes": "boolean",
  "--dry-run": "boolean",
  "--no-amend": "boolean",
  "--pr": "boolean",
  "--json": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

/** An agent identity, the one `--as` form this verb refuses outright. */
const AGENT_ACTOR = /^agent:.+/u;

/**
 * Machine-readable refusal codes. Frozen public API, printed in the help.
 *
 * Distinct by repair, which is the whole test: `proposal-stale` means the live
 * file moved and the proposal has to be rewritten against it; `proposal-
 * ambiguous` means the quoted text is not specific enough and the proposal has
 * to quote more; `proposal-malformed` means the page is not a proposal yet.
 *
 * Two outcomes are deliberately NOT in this union, because neither is this
 * verb's refusal to make:
 *
 * - an operator who answers no at the confirmation gets exit 0 and `aborted:`
 *   on stdout, exactly as `policy amend` does. Nothing failed, and an error
 *   object at exit 0 would be a contradiction a caller has to resolve;
 * - an amendment that refuses has already printed its OWN code, from its own
 *   frozen union. Wrapping it in a second one would put two error objects on
 *   one stream and make a caller guess which is the answer. What this verb adds
 *   is the sentence naming the state that refusal leaves behind.
 */
export const POLICY_APPLY_REFUSAL_CODES = [
  "usage",
  "io",
  "apply-agent-actor",
  "proposal-empty",
  "proposal-malformed",
  "proposal-stale",
  "proposal-ambiguous",
] as const;

export type PolicyApplyRefusalCode = (typeof POLICY_APPLY_REFUSAL_CODES)[number];

// ---------------------------------------------------------------------------
// Fences
// ---------------------------------------------------------------------------

/** One fenced block, with the label line that introduced it. */
interface Fence {
  /** The non-blank line immediately above the opening fence, trimmed. */
  label: string;
  /** The block's content, without either fence line and without a trailing newline. */
  body: string;
  /** 1-based line number of the opening fence, for a refusal that has to point. */
  line: number;
}

/**
 * Every fenced block in `text` that declares a language.
 *
 * Two rules, and both are APRV-273:
 *
 * 1. **A fence is closed by a run of AT LEAST as many backticks as opened it.**
 *    That is CommonMark's rule and it is the one that makes a four-backtick
 *    wrapper work: the inner ```` ```yaml approval-values ```` lines are content,
 *    not fences, so the block quoted is the block including its own fences.
 * 2. **An opener with no info string is not a block this verb reads.** The
 *    incident was a bare fence swallowing a block whose language nobody
 *    declared; a proposal that wants a block applied says what it is.
 */
export function fencesOf(text: string): Fence[] {
  const lines = text.split("\n");
  const found: Fence[] = [];
  let label = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    const opener = /^(`{3,})(.*)$/u.exec(line);
    if (opener === null) {
      // The label is the last non-blank line before a fence, so a blank line
      // between the two does not lose it and a paragraph two lines up does not
      // become one.
      if (line.trim().length > 0) label = line.trim();
      continue;
    }
    const ticks = (opener[1] as string).length;
    const info = (opener[2] as string).trim();
    const body: string[] = [];
    let closed = false;
    let cursor = index + 1;
    for (; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor] as string;
      const closer = /^(`{3,})\s*$/u.exec(candidate);
      if (closer !== null && (closer[1] as string).length >= ticks) {
        closed = true;
        break;
      }
      body.push(candidate);
    }
    // An unterminated fence is not a block. Reading to the end of the document
    // would turn a typo into a replacement covering half the page.
    if (closed && info.length > 0) {
      found.push({ label, body: body.join("\n"), line: index + 1 });
    }
    label = "";
    index = cursor;
  }
  return found;
}

// ---------------------------------------------------------------------------
// Pairs
// ---------------------------------------------------------------------------

/** What a label says a block is, or `null` when it says nothing. */
type Role = "current" | "replacement" | "supersedes";

/**
 * The label vocabulary.
 *
 * Canonical spellings are `Current:`, `Replace with:` and `Supersedes:`. The
 * match is on the leading keyword rather than the whole line so a page can say
 * "Section 1's line, which this supersedes:" — which `docs/proposals/
 * approval-md-2026-09.md` does, and which reads better than a bare label on a
 * page a human is meant to understand before any verb does.
 */
function roleOf(label: string): Role | null {
  const text = label.toLowerCase();
  if (/^current\b/u.test(text)) return "current";
  if (/^replace[ -]with\b/u.test(text)) return "replacement";
  if (/supersede/u.test(text)) return "supersedes";
  return null;
}

/** One current/replacement pair, in the order the document states them. */
export interface ProposalPair {
  /** The `###` (or `##`) heading this pair sits under, for the diff. */
  heading: string;
  current: string;
  replacement: string;
  /** The earlier section's result this pair replaces instead, when declared. */
  supersedes: string | null;
  /** Line of the `Replace with:` fence, so a refusal can point at the page. */
  line: number;
}

export type ParseResult =
  | { ok: true; pairs: ProposalPair[] }
  | { ok: false; code: PolicyApplyRefusalCode; message: string };

/**
 * Read a proposal document into ordered pairs.
 *
 * A block whose label names no role is skipped in silence, which is what lets a
 * proposal page carry a `bash` block of commands to run afterwards without the
 * applier mistaking it for policy text.
 */
export function parseProposal(text: string): ParseResult {
  const lines = text.split("\n");
  const headingAt = (line: number): string => {
    for (let index = line - 1; index >= 0; index -= 1) {
      const candidate = (lines[index] ?? "").trim();
      if (/^#{2,6}\s+/u.test(candidate)) return candidate.replace(/^#+\s+/u, "");
    }
    return "the proposal";
  };

  const pairs: ProposalPair[] = [];
  let current: Fence | null = null;
  let supersedes: Fence | null = null;
  for (const fence of fencesOf(text)) {
    const role = roleOf(fence.label);
    if (role === null) continue;
    if (role === "supersedes") {
      if (supersedes !== null) {
        return {
          ok: false,
          code: "proposal-malformed",
          message: `two Supersedes blocks before one Replace with (lines ${String(supersedes.line)} and ${String(fence.line)}); a pair names at most one superseded text, because two would be two claims about which bytes are in the file`,
        };
      }
      supersedes = fence;
      continue;
    }
    if (role === "current") {
      if (current !== null) {
        return {
          ok: false,
          code: "proposal-malformed",
          message: `two Current blocks before one Replace with (lines ${String(current.line)} and ${String(fence.line)}); every Current block needs the replacement that goes with it, or the page is stating a fact rather than proposing a change`,
        };
      }
      current = fence;
      continue;
    }
    if (current === null) {
      return {
        ok: false,
        code: "proposal-malformed",
        message: `the Replace with block at line ${String(fence.line)} has no Current block above it; a replacement with nothing to anchor it is a paste, and this verb writes no byte it has not proved present`,
      };
    }
    pairs.push({
      heading: headingAt(fence.line),
      current: current.body,
      replacement: fence.body,
      supersedes: supersedes === null ? null : supersedes.body,
      line: fence.line,
    });
    current = null;
    supersedes = null;
  }

  if (current !== null) {
    return {
      ok: false,
      code: "proposal-malformed",
      message: `the Current block at line ${String(current.line)} has no Replace with block after it; nothing was applied`,
    };
  }
  if (pairs.length === 0) {
    return {
      ok: false,
      code: "proposal-empty",
      message:
        "this document declares no Current/Replace with pairs. A pair is two fenced blocks WITH a declared language, each introduced by its label on the line above (`Current:` and `Replace with:`); a fence with no language is skipped, which is the APRV-273 hazard this parser is built around",
    };
  }
  return { ok: true, pairs };
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

/** What one pair did, once the whole proposal was known to apply. */
export interface AppliedPair {
  heading: string;
  /** The text that was found in the file: the `Current` block, or the superseded one. */
  matched: string;
  replacement: string;
  /** True when the match was the superseded text rather than the pair's own Current. */
  superseded: boolean;
}

export type PlanResult =
  | { ok: true; text: string; applied: AppliedPair[] }
  | { ok: false; code: PolicyApplyRefusalCode; message: string };

/** How many times `needle` occurs in `haystack`, counting non-overlapping hits. */
function occurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

/**
 * Resolve every pair against an in-memory copy of the policy, in order.
 *
 * Nothing here touches the disk, which is what makes the refusals honest: a
 * proposal is applied whole or not at all, and the caller writes only the text
 * this function returned.
 */
export function planApply(live: string, pairs: readonly ProposalPair[]): PlanResult {
  let text = live;
  const applied: AppliedPair[] = [];
  for (const [index, pair] of pairs.entries()) {
    const ordinal = `pair ${String(index + 1)} (${pair.heading}, line ${String(pair.line)})`;
    const own = occurrences(text, pair.current);
    const carried = pair.supersedes === null ? 0 : occurrences(text, pair.supersedes);

    if (own > 0 && carried > 0) {
      return {
        ok: false,
        code: "proposal-ambiguous",
        message: `${ordinal}: the policy contains BOTH the text this pair quotes as current and the text it says it supersedes. Two spellings of one line is a question about which of them the file means, and no verb here will pick. Nothing was written`,
      };
    }
    const target = own > 0 ? pair.current : carried > 0 ? pair.supersedes : null;
    const hits = own > 0 ? own : carried;
    if (target === null) {
      return {
        ok: false,
        code: "proposal-stale",
        message: `${ordinal}: the text this pair quotes as current is not in the policy${
          pair.supersedes === null ? "" : ", and neither is the text it says it supersedes"
        }. The file has moved since the proposal was written, so applying it would write bytes nobody checked against what is there. Nothing was written; rewrite the proposal against the live file`,
      };
    }
    if (hits > 1) {
      return {
        ok: false,
        code: "proposal-ambiguous",
        message: `${ordinal}: the text this pair quotes occurs ${String(hits)} times in the policy, so which one it means is a guess. Nothing was written; quote enough surrounding lines to make it unique`,
      };
    }
    text = text.replace(target, () => pair.replacement);
    applied.push({
      heading: pair.heading,
      matched: target,
      replacement: pair.replacement,
      superseded: own === 0,
    });
  }
  return { ok: true, text, applied };
}

// ---------------------------------------------------------------------------
// The verb
// ---------------------------------------------------------------------------

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function refuse(
  streams: Streams,
  json: boolean,
  code: PolicyApplyRefusalCode,
  message: string,
  exitCode: number,
): number {
  if (json) streams.err(`${JSON.stringify({ ok: false, error: { code, message } })}\n`);
  else streams.err(`approval: ${message}\n`);
  return exitCode;
}

function usageRefusal(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ ok: false, error: { code: "usage", message } })}\n`);
  else streams.err(usageErrorText(message, POLICY_APPLY_HELP));
  return EXIT_USAGE;
}

/** Every line of a block, prefixed, so a diff reads as one. */
function block(text: string, marker: string): string[] {
  return text.split("\n").map((line) => `${marker} ${line}`);
}

export function commandPolicyApply(argv: string[], streams: Streams, cwd: string): number {
  const parsed = parseFlags(argv, FLAGS);
  if (!parsed.ok) return usageRefusal(streams, wantsJson(argv), parsed.message);
  const json = boolFlag(parsed.flags, "--json");
  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${POLICY_APPLY_HELP}\n`);
    return EXIT_OK;
  }

  const proposalArg = parsed.positionals[0];
  if (proposalArg === undefined) {
    return usageRefusal(streams, json, "missing <proposal.md>: the document whose pairs to apply");
  }
  const extra = parsed.positionals[1];
  if (extra !== undefined) {
    return usageRefusal(streams, json, `unexpected argument ${JSON.stringify(extra)}`);
  }

  // Identity first, as the amendment ceremony does it, and for the stricter
  // reason: an agent may not write this file at all, so telling it after it has
  // read a diff would be telling it too late.
  const asFlag = stringFlag(parsed.flags, "--as");
  if (asFlag !== null && AGENT_ACTOR.test(asFlag)) {
    return refuse(
      streams,
      json,
      "apply-agent-actor",
      `apply is human-only: ${asFlag} may not write the policy file. APPROVAL.md is policy.core and this verb classifies as policy.core too, so the hook denies an agent that runs it; the refusal here is the same lock in a harness that has no hook. Propose the change as a document under docs/proposals/ and let a human run this verb`,
      EXIT_USAGE,
    );
  }

  const proposalPath = isAbsolute(proposalArg) ? proposalArg : resolvePathSegments(cwd, proposalArg);
  let proposalText: string;
  try {
    proposalText = readFileSync(proposalPath, "utf8");
  } catch (cause) {
    return refuse(
      streams,
      json,
      "io",
      `the proposal ${proposalPath} could not be read: ${detail(cause)}`,
      EXIT_IO,
    );
  }

  const policyPath = preflightPolicyPath(
    stringFlag(parsed.flags, "--policy"),
    stringFlag(parsed.flags, "--dir"),
    cwd,
  );
  if (policyPath === null) {
    return refuse(
      streams,
      json,
      "io",
      `no policy file to apply to: pass --policy <path>, or run this where APPROVAL.md is`,
      EXIT_IO,
    );
  }
  let live: string;
  try {
    live = readFileSync(policyPath, "utf8");
  } catch (cause) {
    return refuse(
      streams,
      json,
      "io",
      `the policy ${policyPath} could not be read: ${detail(cause)}`,
      EXIT_IO,
    );
  }

  const parsedProposal = parseProposal(proposalText);
  if (!parsedProposal.ok) {
    return refuse(streams, json, parsedProposal.code, parsedProposal.message, EXIT_USAGE);
  }
  const plan = planApply(live, parsedProposal.pairs);
  if (!plan.ok) return refuse(streams, json, plan.code, plan.message, EXIT_USAGE);

  const dryRun = boolFlag(parsed.flags, "--dry-run");
  if (plan.text === live) {
    // Every pair resolved and the bytes did not move: the proposal has already
    // been applied. A success, and a no-op, and it says which.
    if (json) {
      streams.out(
        `${JSON.stringify({
          ok: true,
          policy: policyPath,
          proposal: proposalPath,
          pairs: plan.applied.length,
          noop: true,
          dryRun,
          applied: [],
        })}\n`,
      );
    } else {
      streams.out(
        `nothing to apply: all ${String(plan.applied.length)} replacement(s) already read as the proposal asks. ${policyPath} is unchanged\n`,
      );
    }
    return EXIT_OK;
  }

  const st = style({ json });
  if (!json) {
    streams.out(`${st.heading("Applying")}\n`);
    streams.out(`  ${st.key("proposal")} ${proposalPath}\n`);
    streams.out(`  ${st.key("policy")}   ${policyPath}\n\n`);
    for (const [index, entry] of plan.applied.entries()) {
      streams.out(
        `${st.value(`pair ${String(index + 1)} — ${entry.heading}`)}${
          entry.superseded ? st.muted("  (matched the text it supersedes)") : ""
        }\n`,
      );
      for (const line of block(entry.matched, "-")) streams.out(`  ${st.fail(line)}\n`);
      for (const line of block(entry.replacement, "+")) streams.out(`  ${st.ok(line)}\n`);
      streams.out("\n");
    }
  }

  if (dryRun) {
    if (json) {
      streams.out(
        `${JSON.stringify({
          ok: true,
          policy: policyPath,
          proposal: proposalPath,
          pairs: plan.applied.length,
          noop: false,
          dryRun: true,
          applied: plan.applied,
        })}\n`,
      );
    } else {
      streams.out("--dry-run: nothing was written and nothing was attested\n");
    }
    return EXIT_OK;
  }

  // The confirmation is for the WRITE. The amendment asks its own, about the
  // semantic diff, and the two are different questions: this one is "are these
  // the bytes", that one is "is this the policy". `--yes` answers both, because
  // an operator who passed it has said so once for the whole ceremony.
  const assumeYes = boolFlag(parsed.flags, "--yes");
  if (!assumeYes) {
    if (json || process.stdin.isTTY !== true) {
      return usageRefusal(
        streams,
        json,
        "apply needs a confirmation it cannot ask for: stdin is not a terminal (or --json was given). Re-run with --yes, or with --dry-run to see the replacements without writing anything",
      );
    }
    streams.out(`write these ${String(plan.applied.length)} replacement(s) to ${policyPath}? [y/N] `);
    const answer = (readLineFromStdin() ?? "").trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      streams.out("aborted: nothing was written and nothing was attested\n");
      return EXIT_OK;
    }
  }

  try {
    writeFileSync(policyPath, plan.text, "utf8");
  } catch (cause) {
    return refuse(
      streams,
      json,
      "io",
      `${policyPath} could not be written: ${detail(cause)}. Nothing was attested`,
      EXIT_IO,
    );
  }

  if (boolFlag(parsed.flags, "--no-amend")) {
    const owed = "approval policy amend --pr";
    if (json) {
      streams.out(
        `${JSON.stringify({
          ok: true,
          policy: policyPath,
          proposal: proposalPath,
          pairs: plan.applied.length,
          noop: false,
          dryRun: false,
          amended: false,
          owed,
          applied: plan.applied,
        })}\n`,
      );
    } else {
      streams.out(
        `${st.glyph("ok")} ${String(plan.applied.length)} replacement(s) written to ${policyPath}\n`,
      );
      streams.err(
        `approval: --no-amend, so the policy is EDITED AND UNATTESTED: every gated operation refuses policy-not-attested until you run \`${owed}\`\n`,
      );
    }
    return EXIT_OK;
  }

  // And then the amendment, in this process. The edit and its attestation are
  // one act, so a verb that wrote the file and left the operator to remember
  // the second half would have built the interregnum it exists to close.
  const logFlag = stringFlag(parsed.flags, "--log");
  const amendArgv = [
    ...(stringFlag(parsed.flags, "--policy") === null ? [] : ["--policy", policyPath]),
    ...(stringFlag(parsed.flags, "--dir") === null
      ? []
      : ["--dir", stringFlag(parsed.flags, "--dir") as string]),
    ...(logFlag === null ? [] : ["--log", logFlag]),
    ...(asFlag === null ? [] : ["--as", asFlag]),
    ...(assumeYes ? ["--yes"] : []),
    ...(json ? ["--json"] : []),
    ...(boolFlag(parsed.flags, "--pr") ? ["--pr"] : []),
  ];
  const code = commandPolicyAmend(amendArgv, streams, cwd);
  if (code !== EXIT_OK) {
    // The write happened and the amendment did not. Said plainly, on stderr,
    // because the operator is now holding an edited policy no attestation
    // covers and the next gate operation will tell them so in a worse place.
    streams.err(
      `approval: the replacements ARE written to ${policyPath}, and \`approval policy amend\` exited ${String(code)}: the policy is edited and unattested until it succeeds. Fix what it reported and run \`approval policy amend --pr\`\n`,
    );
  }
  return code;
}

/** `--json` before the flags are parsed, so a parse error can honour it. */
function wantsJson(argv: readonly string[]): boolean {
  return argv.includes("--json");
}
