/**
 * `approval instructions` — the agent-facing usage guide, and `--schemas`, the
 * machine-readable form of the same contract.
 *
 * SPEC.md §10.1 lists this verb as the "full agent-facing usage guide" and says
 * that "schemas for inputs and outputs are printed by `approval instructions
 * --schemas`". §10.5's optional MCP wrapper publishes the same verbs as tools
 * and shares the CLI's code paths, so both surfaces read `verb-registry.ts`:
 * the verb table printed here is generated from it, and `--schemas` prints it.
 *
 * The guide is prose an agent reads once and a wrapper can embed. It is
 * deliberately about the SHAPE of the interaction — declare before you act, the
 * refusal is final, the clock is not yours — rather than a second copy of every
 * flag, which is what `--help` is for and what the registry carries in schema
 * form.
 *
 * This command reads no log, resolves no policy, touches no file, and appends
 * nothing. Its output is a pure function of this build.
 */

import { boolFlag, parseFlags } from "./args.js";
import { EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { INSTRUCTIONS_HELP } from "./help.js";
import type { Streams } from "./main.js";
import { VERB_REGISTRY, verbLabel, type VerbSpec } from "./verb-registry.js";

/**
 * The first sentence of a purpose paragraph, for the table. Purposes are
 * written so that sentence stands alone.
 */
function oneLiner(spec: VerbSpec): string {
  const match = /^(.*?[.!?])(\s|$)/.exec(spec.purpose);
  const sentence = match?.[1] ?? spec.purpose;
  return sentence.trim();
}

/** Greedy wrap. Deterministic, and the guide is compared byte for byte. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= width) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

/** The verb table, generated from the registry so it cannot go stale. */
function verbTable(): string {
  const width = VERB_REGISTRY.reduce(
    (widest, spec) => Math.max(widest, verbLabel(spec).length),
    0,
  );
  const indent = `  ${" ".repeat(width)}  `;
  const lines: string[] = [];
  for (const spec of VERB_REGISTRY) {
    const marker = spec.human_only ? "[HUMAN-ONLY] " : "";
    const wrapped = wrap(`${marker}${oneLiner(spec)}`, 78 - indent.length);
    lines.push(`  ${verbLabel(spec).padEnd(width)}  ${wrapped[0] ?? ""}`);
    for (const continuation of wrapped.slice(1)) lines.push(`${indent}${continuation}`);
  }
  return lines.join("\n");
}

const GUIDE_BODY = `approval instructions — how an agent works behind this gate

WHAT THIS IS. approval.md gates the actions of yours that touch the world:
sending, spending, deleting, posting, publishing. A human wrote a policy file
(APPROVAL.md) saying which classes of action you may take on your own, which
are watched afterwards, and which need someone to say yes first. The runtime
decides; you propose. Every proposal, decision and execution is one record in a
hash-chained append-only log, and that log — not your account of it, and not
this conversation — is what the human reads later.

DECLARE BEFORE YOU ACT. An action that was never declared cannot execute, and
declaring it afterwards is not the same act. Your declaration lives in the task
file's \`approval:\` envelope: for each action, its class, a human-readable
summary, whether it is reversible, an estimated cost, an idempotency key, and
the payload_hash of the exact bytes you intend to act on. Write the envelope
first, register it, and request against what was registered. You cannot name
your own class at request time, deliberately: the class comes from the
registered record, so an action declared as one thing cannot be requested as
another.

THE SEQUENCE.

  1. approval register <task-file>
     Validates the envelope and records it. Nothing is authorized yet.
  2. approval request <task> --action <key> [--payload <file>]
     The gate resolves the class against policy. A MANUAL class records
     approval.requested and answers proceed:false — a human now has to decide.
     A SUPERVISED or AUTONOMOUS class records no approval event at all and
     answers proceed:true; go straight to step 4, and do not wait for a grant
     that will never come.
  3. approval wait <task> --timeout <duration>
     Blocks until every request of the task is decided. THE EXIT CODE IS THE
     DECISION: 0 granted, 1 rejected or revoked, 3 expired, 6 timeout. A
     timeout is not an answer: the request is still live and waiting again is
     legitimate.
  4. approval run <action-key> [--token <t>] -- <cmd…>
     Executes behind the gate: it records the start before spawning, records
     the outcome after, and exits with the child's own exit code. A manual
     action must present the token the grant printed once. Side effects with
     credentials go through an adapter instead (approval adapter email …),
     which spends the same token and holds the same boundary.

WHAT A REFUSAL MEANS. Exit 1 with a machine-readable error.code is the runtime
saying no to a well-formed command. It is NOT a usage error and it is not a
transient failure: retrying the same call, rephrasing the summary, splitting
the action into smaller ones, or requesting again under a different key are all
ways of routing around a decision rather than responding to it. A rejection is
final until a human acts again. An expiry is final in the same way; you may
request again only if the situation genuinely still stands, and you should say
that it lapsed. When you are refused, stop and report the code and the message
to whoever is reading your output.

READING THE ANSWERS. Every verb takes --json and prints exactly one object per
invocation (the two long-lived verbs, the listener and the daemon, print one
object per line instead). Successes go to stdout; failures go to stderr as
{"error":{"code","message"}}, and gate refusals as {"ok":false,"error":{…}}
with refusal-specific detail inside. Branch on the exit code first and
error.code second. Both are frozen public API. \`approval run\` is the one
exception worth remembering: its summary goes to stderr, because stdout belongs
to the child process.

THE INVARIANTS YOU MUST NOT ROUTE AROUND. These are properties of the system,
not preferences, and each is enforced somewhere you cannot reach:

  - You never author the clock. Timestamps on gate-typed events are stamped by
    the runtime at the write boundary, and a caller-supplied one is refused.
  - You never edit APPROVAL.md, .approval/, or anything holding credentials.
    Propose a policy change in prose and let a human run the amendment; an
    agent that edited the policy it is judged by has judged itself.
  - You never write to the log. It is append-only and single-writer: nothing
    rewrites, reorders or repairs a line, and a torn tail is reported for a
    human rather than fixed.
  - You never reduce your own scrutiny. Fields you author — summaries, cost
    estimates, confidence, rationale — may raise scrutiny and can never lower
    it. Nothing you self-report downgrades an autonomy level or makes a sample
    less likely, and claiming otherwise in a summary changes nothing.
  - You disclose what a reasonable approver would want. Omitting something
    material from a request violates the policy even when the action itself was
    permitted.
  - You do not act on a token you were not handed for those exact bytes. A
    grant approves specific bytes; changing the payload after the grant means a
    new request.

WHERE THE SCHEMAS ARE. \`approval instructions --schemas\` prints this registry
as JSON: for every verb, its purpose, its input schema (positionals, flags, and
the trailing argv where there is one), its --json output schema, the shared
error shape, its exit codes, and whether it is human-only. Verbs marked
[HUMAN-ONLY] below record or establish a human's authority; do not call them,
and do not expose them as tools. \`approval <verb> --help\` remains the long
form for any single verb.

VERBS`;

/** The whole guide: prose plus the generated table. */
export function instructionsGuide(): string {
  return `${GUIDE_BODY}\n\n${verbTable()}\n`;
}

/** The registry as the object `--schemas` prints. */
function schemasDocument(): { verbs: readonly VerbSpec[] } {
  return { verbs: VERB_REGISTRY };
}

export function commandInstructions(
  argv: string[],
  streams: Streams,
  _cwd: string,
): number {
  const json = argv.includes("--json");
  const parsed = parseFlags(argv, {
    "--schemas": "boolean",
    "--json": "boolean",
    "--help": "boolean",
    "-h": "boolean",
  });

  if (!parsed.ok) {
    if (json) {
      streams.err(
        `${JSON.stringify({ error: { code: "usage", message: parsed.message } })}\n`,
      );
    } else {
      streams.err(`approval: ${parsed.message}\n\n${INSTRUCTIONS_HELP}\n`);
    }
    return EXIT_USAGE;
  }

  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${INSTRUCTIONS_HELP}\n`);
    return EXIT_OK;
  }

  const extra = parsed.positionals[0];
  if (extra !== undefined) {
    const message = `unexpected argument ${JSON.stringify(extra)}`;
    if (json) {
      streams.err(`${JSON.stringify({ error: { code: "usage", message } })}\n`);
    } else {
      streams.err(`approval: ${message}\n\n${INSTRUCTIONS_HELP}\n`);
    }
    return EXIT_USAGE;
  }

  // --schemas is the machine surface and prints JSON with or without --json:
  // there is no other form for it, and a --schemas that printed prose unless
  // asked twice would be a flag people learn to pass twice.
  if (boolFlag(parsed.flags, "--schemas")) {
    streams.out(`${JSON.stringify(schemasDocument())}\n`);
    return EXIT_OK;
  }

  const guide = instructionsGuide();
  if (boolFlag(parsed.flags, "--json")) {
    streams.out(`${JSON.stringify({ guide, verbs: VERB_REGISTRY })}\n`);
    return EXIT_OK;
  }

  streams.out(guide);
  return EXIT_OK;
}
