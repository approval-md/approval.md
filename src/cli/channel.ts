/**
 * `approval channel cli` (APRV-23) — the zero-config channel, driven over the
 * plugin contract rather than around it.
 *
 * There is no second decision path in this codebase and this verb is not one.
 * It builds the pending queue with `channels/tagging.ts`, hands each request to
 * `channels/cli.ts` for rendering, and registers a decision handler whose entire
 * body is a call to `recordChannelDecision` — which calls the human-only
 * `decide()` in `core/gate.ts`. Every gate rule (human actor, TTL, budgets,
 * attestation, idempotency, compare-and-append) applies here unchanged, because
 * nothing here reimplements any of them.
 *
 * ## Interactive, and deliberately not by default
 *
 * A prompt that blocks is a prompt that hangs a pipeline. So the verb is
 * interactive only when stdin is a TTY, or when `--interactive` says so
 * explicitly; `--json` is never interactive. Anything else lists the queue and
 * exits 0. That rule is in `--help` because an agent that shells out to this
 * verb must be able to predict, before it spawns anything, whether the child
 * will return.
 *
 * ## The reading aids (APRV-197)
 *
 * Two of them, and they are different in kind. The deterministic one is the
 * `command_breakdown` line: derived by the classifier from the bound bytes,
 * marked `[computed] (classifier)`, free, and always present for a command this
 * runtime's own tokenizer can read. The other is the model gloss, which costs a
 * subprocess and 10-15 seconds and is marked `(model, unverified)` on the line
 * itself. Until APRV-197 only the Telegram listener attached the second, so an
 * operator deciding here read the agent's raw summary and nothing else; the two
 * surfaces now share `cli/gloss-attach.ts`. See {@link glossRunner} for when a
 * model is asked at all — only under `--gloss`, and never on the `--json` path,
 * which is not interactive and has nobody waiting at it.
 *
 * ## Identity is declared, not proved
 *
 * `--as human:<id>`, else `APPROVAL_HUMAN`. The trust boundary is the local
 * machine: anyone who can set that variable and write to the log is inside it,
 * so a decision recorded here proves that *someone with local control* answered,
 * not *who*. Stated in `--help` rather than implied, because a reader who
 * believes this authenticates anybody would be wrong in a way that matters. The
 * identity is required only when a decision could be recorded — listing the
 * queue asks nothing of anyone.
 *
 * ## Where the payload comes from
 *
 * v0.1's log records `payload_hash`, never the payload bytes, so the material to
 * render comes from the payload store beside the log — `.approval/payloads/`,
 * written by `approval request --payload` (APRV-28) — which is why this verb
 * needs no flag at all in the ordinary case. `--payload-dir` remains as an
 * override for an operator whose bytes live elsewhere: one JSON file per action
 * key, consulted first. `channels/tagging.ts` hashes whatever it is given and refuses
 * anything that does not match the recorded binding, so a wrong file is a
 * refusal and never a rendering. A manual request with no material is *skipped*
 * and reported — visibly, never silently, because a request missing from a queue
 * is a request nobody will approve.
 *
 * ## The asynchronous exit code
 *
 * `main()` is synchronous by contract: `cli.js` assigns its return value to
 * `process.exitCode`. The prompt loop is asynchronous (readline), so the
 * interactive path returns {@link EXIT_OK} to `main` and assigns the real code
 * to `process.exitCode` when the loop settles. Node exits with the last value
 * assigned, so a refusal still exits 1. Every synchronous path — `--json`, a
 * non-TTY listing, a usage error, an I/O fact — returns its code the ordinary
 * way.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve as resolvePathSegments } from "node:path";

import { CliChannel } from "../channels/cli.js";
import {
  recordChannelDecision,
  refusedDecisionLine,
  type ChannelRequest,
  type DecisionOutcome,
} from "../channels/contract.js";
import { buildPendingQueue, type TagOptions } from "../channels/tagging.js";
import type { CheckpointOffer } from "../core/checkpoint.js";
import {
  checkpointOfferFor,
  checkpointPromptLines,
  checkpointSignedLines,
  signCheckpointOffer,
  type CheckpointTap,
} from "./checkpoint-tap.js";
import { HUMAN_ACTOR_ENV, resolveHumanActor } from "../core/attest.js";
import { loadPolicy } from "../core/policy-load.js";
import { promptLayoutFor, type PromptLayout } from "../core/prompt-layout.js";
import { passphraseEnvFor } from "../core/vault.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import { GLOSS_TIMEOUT_MS, type GlossRunner } from "./gloss.js";
import { attachGloss, glossAbsenceLine } from "./gloss-attach.js";
import {
  glossRunnerFromOptions,
  parseGlossOptions,
  type GlossOptions,
} from "./gloss-options.js";
import {
  EXIT_INTEGRITY,
  EXIT_IO,
  EXIT_OK,
  EXIT_TORN_TAIL,
  EXIT_USAGE,
} from "./exit-codes.js";
import { CHANNEL_CLI_HELP, CHANNEL_HELP } from "./help.js";
import type { Streams } from "./main.js";
import { DEFAULT_LOG_PATH, preflightLog, resolvePath } from "./paths.js";
import { commandTelegram } from "./channel-telegram.js";
import { commandWeb } from "./channel-web.js";
import { refusal as renderRefusal, style, tokenPanel, TOKEN_NOTICE } from "./style.js";
import { usageErrorText } from "./usage.js";

const FLAGS: Record<string, FlagKind> = {
  "--log": "string",
  "--policy-dir": "string",
  "--policy": "string",
  "--payload-dir": "string",
  "--as": "string",
  "--interactive": "boolean",
  "--gloss": "boolean",
  "--gloss-provider": "string",
  "--gloss-model": "string",
  "--json": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

function absolute(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolvePathSegments(cwd, value);
}

function usageError(streams: Streams, json: boolean, message: string, help: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "usage", message } })}\n`);
  else streams.err(usageErrorText(message, help));
  return EXIT_USAGE;
}

function ioError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "io", message } })}\n`);
  else streams.err(`approval: ${message}\n`);
  return EXIT_IO;
}

/**
 * Payload material for one action key, from `--payload-dir`.
 *
 * Two filenames are accepted — the key verbatim and its percent-encoding — so a
 * key containing a path separator cannot name a file outside the directory and
 * an operator is not forced to guess an encoding. Unparseable or unreadable
 * material yields `undefined`, which the tagger turns into a *visible* skip
 * rather than a rendering; the parse failure itself is reported on stderr.
 */
function payloadSource(
  dir: string,
  streams: Streams,
): (actionKey: string) => unknown {
  return (actionKey) => {
    for (const name of [`${encodeURIComponent(actionKey)}.json`, `${actionKey}.json`]) {
      if (name.includes("/") || name.includes("\\")) continue;
      let raw: string;
      try {
        raw = readFileSync(join(dir, name), "utf8");
      } catch {
        continue;
      }
      try {
        return JSON.parse(raw) as unknown;
      } catch (cause) {
        streams.err(
          `approval: payload material for ${actionKey} (${join(dir, name)}) is not valid JSON: ${
            cause instanceof Error ? cause.message : String(cause)
          }; the request will be skipped rather than rendered from bytes nobody could bind\n`,
        );
        return undefined;
      }
    }
    return undefined;
  };
}

/** The queue refusal codes, mapped onto the frozen exit table. */
function refusalExit(code: string): number {
  switch (code) {
    case "log-unreadable":
      return EXIT_IO;
    case "log-torn-tail":
      return EXIT_TORN_TAIL;
    default:
      return EXIT_INTEGRITY;
  }
}

/**
 * One line of human-readable outcome per decision.
 *
 * A refusal since APRV-235 leads with the sentence the Telegram message edit
 * shows, from the one helper both surfaces share, and keeps the gate's own
 * message after it. The person at this terminal and the person holding the
 * phone are usually the same person, and they were reading two different
 * accounts of one refused tap. The gate's message stays because a terminal can
 * afford the detail a chat bubble cannot, and because it is the text that names
 * the hashes.
 */
function describeOutcome(outcome: DecisionOutcome): string {
  if (outcome.ok) {
    return `${outcome.decision === "grant" ? "granted" : "rejected"} ${outcome.action_key} -> ${outcome.state} at seq ${outcome.record.seq}`;
  }
  return `refused: ${outcome.code}: ${refusedDecisionLine(outcome.code)}\n  ${outcome.message}`;
}

export function commandChannelCli(argv: string[], streams: Streams, cwd: string): number {
  const json = argv.includes("--json");
  const parsed = parseFlags(argv, FLAGS);
  if (!parsed.ok) return usageError(streams, json, parsed.message, CHANNEL_CLI_HELP);

  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${CHANNEL_CLI_HELP}\n`);
    return EXIT_OK;
  }
  const extra = parsed.positionals[0];
  if (extra !== undefined) {
    return usageError(
      streams,
      json,
      `unexpected argument ${JSON.stringify(extra)}`,
      CHANNEL_CLI_HELP,
    );
  }

  const flags = parsed.flags;
  const selectedGloss = parseGlossOptions(flags, false);
  if (!selectedGloss.ok) {
    return usageError(streams, json, selectedGloss.message, CHANNEL_CLI_HELP);
  }
  const logPath = resolvePath(stringFlag(flags, "--log"), DEFAULT_LOG_PATH, cwd);

  const policyFile = stringFlag(flags, "--policy");
  const policyDir = stringFlag(flags, "--policy-dir");
  const policy =
    policyFile !== null
      ? { file: absolute(policyFile, cwd) }
      : { dir: policyDir === null ? cwd : absolute(policyDir, cwd) };

  const payloadDir = stringFlag(flags, "--payload-dir");
  const tagOptions: TagOptions = {
    policy,
    ...(payloadDir === null
      ? {}
      : { payload: payloadSource(absolute(payloadDir, cwd), streams) }),
  };

  const check = preflightLog(logPath);
  if (!check.ok) return ioError(streams, json, check.message);

  const queue = buildPendingQueue(logPath, tagOptions, new Date().toISOString());
  if (!queue.ok) {
    if (json) {
      streams.err(
        `${JSON.stringify({ ok: false, error: { code: queue.code, message: queue.message } })}\n`,
      );
    } else {
      streams.err(`${renderRefusal(style({ json }), queue.code, queue.message)}\n`);
    }
    return refusalExit(queue.code);
  }

  // Never interactive with --json: a prompt has nowhere to go in a machine
  // shape, and a caller that asked for one object must get one object.
  const interactive =
    !json && (boolFlag(flags, "--interactive") || process.stdin.isTTY === true);

  if (!interactive) {
    return listOnly(queue.requests, queue.skipped, streams, json, promptLayoutFor(loadPolicy(policy), "cli"));
  }

  const asFlag = stringFlag(flags, "--as");
  const actor = resolveHumanActor(asFlag === null ? {} : { actor: asFlag });
  if (actor === null) {
    // Checked BEFORE anything is rendered: asking a human to read a payload and
    // then telling them their answer cannot be recorded wastes the one resource
    // this whole system is spending.
    return usageError(
      streams,
      json,
      asFlag === null
        ? `no human identity: set ${HUMAN_ACTOR_ENV}=human:<id> or pass --as human:<id>; a decision collected here is recorded by the human-only gate and cannot be attributed to nobody`
        : `--as expects a human identity matching human:<id>, got ${JSON.stringify(asFlag)}; approval decisions are human-only and an agent: or system: actor cannot record one`,
      CHANNEL_CLI_HELP,
    );
  }

  // APRV-257. Resolved BEFORE the empty-queue exit, because an empty queue is
  // exactly when a checkpoint is the only thing owed: the operator who opens
  // this verb on a quiet gate is the one who should be asked, and a verb that
  // had already returned could not ask them.
  const tap: CheckpointTap = { logPath, policy, keyFile: null, vault: null };
  const checkpoint = checkpointOfferFor(tap);

  if (queue.requests.length === 0 && checkpoint === null) {
    reportSkipped(queue.skipped, streams);
    streams.out("queue: empty — no requests awaiting a decision\n");
    return EXIT_OK;
  }

  // See the module header: the prompt loop is asynchronous, so its exit code is
  // assigned to process.exitCode when it settles.
  void interactiveLoop(
    queue.requests,
    logPath,
    policy,
    actor,
    streams,
    glossRunner(selectedGloss.options, policy, streams),
    checkpoint === null ? null : { tap, offer: checkpoint },
  ).then(
    (code) => {
      process.exitCode = code;
    },
    (cause: unknown) => {
      streams.err(
        `approval: the prompt loop failed: ${cause instanceof Error ? cause.message : String(cause)}\n`,
      );
      process.exitCode = EXIT_IO;
    },
  );
  reportSkipped(queue.skipped, streams);
  return EXIT_OK;
}

/**
 * Whether this walk asks a model for a gloss, and with what (APRV-197).
 *
 * `--gloss`, and nothing else. The VERB is the only place a subprocess is
 * wired, so every other caller of the prompt loop — the conformance harness,
 * the test suite, any programmatic driver — gets `undefined` and spawns
 * nothing. Three surfaces now carry the same flag under the same rule
 * (`channel cli`, `channel telegram listen`, `up`).
 *
 * Opt-in rather than on-by-default because the cost is measured and it is not
 * small: 10-15 seconds per request (see {@link GLOSS_TIMEOUT_MS}), spent while
 * a human waits at a prompt. The reading aid that is always there is the
 * deterministic one — `command_breakdown`, derived by the classifier from the
 * bound bytes, free, and marked `[computed]`. A sentence from a model that no
 * party vouches for is worth asking for, and worth asking for ON PURPOSE.
 *
 * The policy is read for one thing only (APRV-207): the NAME of its passphrase
 * variable, so the scrub that starves the subprocess removes a renamed one too.
 */
function glossRunner(
  selection: GlossOptions,
  policy: { dir?: string; file?: string },
  streams: Streams,
): GlossRunner | undefined {
  if (!selection.enabled) return undefined;
  return glossRunnerFromOptions(selection, {
    passphraseEnv: passphraseEnvFor(loadPolicy(policy)),
    diagnostic: (reason) =>
      streams.err(`approval: Codex gloss unavailable (${reason}); continuing without it\n`),
  });
}

function reportSkipped(
  skipped: { action_key: string; code: string; message: string }[],
  streams: Streams,
): void {
  for (const entry of skipped) {
    // APRV-102: the shared refusal shape. The action key leads the message
    // because a skip is ABOUT one request, and the reader is scanning for which.
    streams.err(
      `${renderRefusal(style(), entry.code, `skipped ${entry.action_key}: ${entry.message}`)}\n`,
    );
  }
}

/**
 * The non-interactive answer: the queue, and then nothing. It must not read
 * stdin at all — a listing that blocked on a closed pipe would hang every CI
 * step that ever called it.
 */
function listOnly(
  requests: ChannelRequest[],
  skipped: { action_key: string; code: string; message: string }[],
  streams: Streams,
  json: boolean,
  layout: PromptLayout,
): number {
  if (json) {
    // FROZEN SHAPE: the tagged queue, verbatim. Every field keeps its
    // kind/value/source|author markers, so a machine reader sees the same
    // computed/claimed split a human does.
    streams.out(
      `${JSON.stringify({
        ok: true,
        channel: "cli",
        interactive: false,
        pending: requests,
        skipped,
      })}\n`,
    );
    return EXIT_OK;
  }

  reportSkipped(skipped, streams);
  if (requests.length === 0) {
    streams.out("queue: empty — no requests awaiting a decision\n");
    return EXIT_OK;
  }

  const channel = new CliChannel({ output: { write: (text) => streams.out(text) }, layout });
  channel.notify({ requests });
  streams.out(
    `\n${requests.length} request(s) awaiting a decision. stdin is not a terminal, so nothing was asked and nothing was recorded; re-run with a terminal (or --interactive) to decide.\n`,
  );
  return EXIT_OK;
}

/**
 * Walk the queue: notify, prompt, record, report.
 *
 * The grant token is printed exactly once, here, by the runtime — never by the
 * channel, which is handed a {@link DecisionOutcome} that does not carry it.
 */
async function interactiveLoop(
  requests: ChannelRequest[],
  logPath: string,
  policy: { dir?: string; file?: string },
  actor: string,
  streams: Streams,
  gloss: GlossRunner | undefined,
  /**
   * The checkpoint this log is owed, when one is (APRV-257). Asked FIRST, and
   * once: it is a question about the whole log rather than about any request in
   * the queue, so leaving it until the end would be asking it of whoever
   * happened to still be at the terminal.
   */
  checkpoint: { tap: CheckpointTap; offer: CheckpointOffer } | null,
): Promise<number> {
  // APRV-218: which rows this walk shows, from `channels.cli.prompt`. Resolved
  // HERE, at the verb, because the channel neither reads a policy file nor holds
  // an opinion about what an operator should see. A policy that did not load
  // yields the default layout and nothing else: a layout is not a permission.
  const channel = new CliChannel({
    output: { write: (text) => streams.out(text) },
    layout: promptLayoutFor(loadPolicy(policy), "cli"),
  });

  let token: string | undefined;
  channel.onDecision((decision) => {
    const result = recordChannelDecision(
      logPath,
      decision,
      { actor, channel: channel.name },
      { policy },
    );
    token = result.token;
    return result.outcome;
  });

  let refused = false;
  const tally = { asked: 0, absent: 0 };
  try {
    // APRV-257, first and once. Declining costs nothing and refuses nothing, so
    // a `false` here is not an outcome the exit code reads; a signature that
    // was ATTEMPTED and failed is reported and does set `refused`, because the
    // operator asked for a record and did not get one.
    if (checkpoint !== null) {
      const sign = await channel.collectCheckpoint(checkpointPromptLines(checkpoint.offer));
      if (sign === true) {
        const result = signCheckpointOffer(
          checkpoint.tap,
          checkpoint.offer.head,
          actor,
          channel.name,
          process.cwd(),
        );
        for (const line of checkpointSignedLines(result)) streams.out(`${line}\n`);
        if (!result.ok) refused = true;
      }
    }

    for (const original of requests) {
      // APRV-197. Attached per request, immediately before it is rendered, and
      // by the same function the Telegram listener uses. Per request rather
      // than in one pass up front because the wait is 10-15s each: a human who
      // walks away after the first decision should not have paid for glosses of
      // requests they never read, and one who stays sees the pause land next to
      // the prompt it belongs to.
      let request = original;
      if (gloss !== undefined) {
        streams.err(
          `approval: asking a model to describe ${original.action_key.value} (up to ${GLOSS_TIMEOUT_MS}ms; drop --gloss to skip it)\n`,
        );
        const attached = attachGloss(original, gloss);
        if (attached.outcome !== "opaque") tally.asked += 1;
        if (attached.outcome === "absent") tally.absent += 1;
        request = attached.request;
      }
      const deliveryId = channel.notify(request);
      token = undefined;
      const collected = await channel.collectDecision(request.action_key.value, deliveryId);
      if (collected.kind === "aborted") break;
      if (collected.kind === "skipped") continue;

      streams.out(`${describeOutcome(collected.outcome)}\n`);
      if (!collected.outcome.ok) refused = true;
      else if (token !== undefined) {
        // APRV-102: the rule-boxed panel of APRV-91's brief, from the one helper
        // every token surface shares. This terminal is the only place the raw
        // value will ever exist.
        streams.out(
          `${tokenPanel(style(), request.action_key.value, token, TOKEN_NOTICE)}\n`,
        );
      }
    }
  } finally {
    channel.close();
  }

  // APRV-197. Chronic silence becomes a visible line: an operator who asked for
  // glosses and read none now learns that a model was asked and did not answer,
  // instead of concluding the feature was never built (which is exactly what
  // happened under APRV-144's ceiling).
  if (tally.absent > 0) {
    streams.err(glossAbsenceLine("channel cli", tally.absent, tally.asked, GLOSS_TIMEOUT_MS));
  }

  return refused ? EXIT_INTEGRITY : EXIT_OK;
}

/** `approval channel <subcommand>` — `cli`, `web` (APRV-25), `telegram`. */
export function commandChannel(argv: string[], streams: Streams, cwd: string): number | Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  const json = argv.includes("--json");

  if (sub === undefined) {
    return usageError(streams, json, "missing subcommand for `approval channel`", CHANNEL_HELP);
  }
  if (sub === "--help" || sub === "-h" || sub === "help") {
    streams.out(`${CHANNEL_HELP}\n`);
    return EXIT_OK;
  }
  if (sub === "cli") return commandChannelCli(rest, streams, cwd);
  // APRV-25: the local queue page. Long-lived, like `telegram listen`.
  if (sub === "web") return commandWeb(rest, streams, cwd);
  if (sub === "telegram") return commandTelegram(rest, streams, cwd);
  return usageError(
    streams,
    json,
    `unknown subcommand ${JSON.stringify(sub)} for \`approval channel\``,
    CHANNEL_HELP,
  );
}
