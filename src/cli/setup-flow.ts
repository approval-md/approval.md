/**
 * The credential-collection flow (SPEC.md §5.2, §10.1, §10.4; APRV-78).
 *
 * `setup identity|vault|sampling|telegram` each hand-rolled their own
 * conversation, and that was right while there were four of them and each was
 * different. `setup adapter <name>` was the first verb whose conversation is
 * DERIVED — from a manifest of {@link CredentialSpec}s an adapter declares — so
 * the conversation itself becomes a function, and this file is that function.
 * APRV-79 made it the second caller's too: `setup channel telegram` runs this
 * flow over the Telegram channel's manifest, into `.approval/env` instead of
 * into the vault, which is what the destination seam was built for.
 *
 * It knows nothing about email, SMTP, Telegram, or the vault's file format. It
 * is handed a list of specs, somewhere to put the values
 * ({@link FlowDestination}), and up to four hooks, and it runs one fixed order:
 *
 * 1. the title and the prerequisite line;
 * 2. **the checklist** — one line per spec, before a single question is asked,
 *    so an operator can see the whole shape of what is about to be demanded and
 *    where it will land, and abandon at zero cost if it is the wrong vault;
 * 3. **the preflight** ({@link FlowDestination.present}), which for a vault
 *    means OPENING it. This is why it is step three and not step six: a wrong
 *    passphrase must refuse before the operator has typed a password, not
 *    after. The set it returns is also what step four reads;
 * 4. **the replacement plan** ({@link planWrites}), asked up front for the same
 *    reason `setup`'s own does: a confirmation asked after the value had been
 *    replaced is a question whose "no" no longer means anything. A name the
 *    operator declines is never even asked for;
 * 5. **collection**, in manifest order;
 * 6. **the cross-field check** ({@link FlowHooks.check}), before any write, so
 *    a half-configured pair costs nothing;
 * 7. **the writes**, in manifest order — which is why an adapter puts its
 *    secret last: a destination that refuses half way reports exactly which
 *    names landed and stops. **There is no rollback**, deliberately: deleting
 *    credentials in response to a write failure is a destructive act taken by a
 *    wizard on its own authority, over a store whose previous contents it
 *    cannot restore;
 * 8. **verification** ({@link FlowHooks.verify}), after the write, because the
 *    thing being verified is the stored configuration; and
 * 9. **the report** — where, how many, which names — and the next steps.
 *
 * **Values are held in this process and printed by nothing.** The flow must
 * hold them: it collected them and it is about to write them. Every line it
 * emits names a CREDENTIAL NAME, a kind, a count, or a path, and the suite in
 * `tests/cli-setup.test.ts` sweeps every captured byte for the fixture secrets
 * with no exemption on this path.
 */

import type { CredentialSpec } from "../core/credential-spec.js";
import {
  envFilePathFor,
  readEnvFile,
  upsertEnvFileEntries,
  type EnvFileRefusal,
} from "../core/env-file.js";
import {
  listCredentials,
  setCredential,
  vaultExists,
  type VaultRefusal,
} from "../core/vault.js";
import { EXIT_INTEGRITY, EXIT_IO, EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import type { Streams } from "./main.js";
import type { Prompter } from "./prompt.js";

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

/**
 * A refusal from a destination, already carrying its exit code.
 *
 * The code is decided by the destination and not by this file, because the
 * frozen exit table's split (4 is a filesystem fact, 1 is the runtime deciding
 * no) is a property of the STORE's vocabulary — `cli/vault.ts` and
 * `cli/setup.ts` each already map their own refusals that way, and a flow that
 * re-derived the mapping would be a third opinion about the same table.
 */
export interface FlowRefusal {
  code: string;
  message: string;
  exitCode: number;
}

/** Where a flow puts what it collected. Two implementations live below. */
export interface FlowDestination {
  kind: "vault" | "env-file";
  /** The path, for the checklist and the report. Never a value. */
  where(): string;
  /**
   * Which of the names are ALREADY there — and, for a store that must be
   * unlocked, the act of unlocking it. Called once, before anything is asked.
   */
  present(): { ok: true; names: ReadonlySet<string> } | ({ ok: false } & FlowRefusal);
  /** Store one value. Called once per name, in manifest order. */
  write(name: string, value: string): { ok: true } | ({ ok: false } & FlowRefusal);
}

/** A vault refusal onto the exit table, exactly as `cli/vault.ts` maps it. */
function vaultExit(refusal: VaultRefusal): FlowRefusal {
  return {
    code: refusal.code,
    message: refusal.message,
    exitCode:
      refusal.code === "vault-io" || refusal.code === "vault-write-failed"
        ? EXIT_IO
        : EXIT_INTEGRITY,
  };
}

/** An env-file refusal onto the exit table, exactly as `cli/setup.ts` maps it. */
function envExit(refusal: EnvFileRefusal): FlowRefusal {
  return {
    code: refusal.code,
    message: refusal.message,
    exitCode:
      refusal.code === "env-file-io" || refusal.code === "env-file-mode"
        ? EXIT_IO
        : EXIT_INTEGRITY,
  };
}

/**
 * The encrypted credential store (SPEC.md §10.4).
 *
 * `present()` is where the passphrase is proved. A vault that does not exist
 * yet holds nothing and refuses nothing: the first `write` creates it, which is
 * what `approval vault set` does too. A vault that DOES exist is opened here
 * and nowhere later, so a wrong passphrase costs the operator one line of
 * output rather than five typed values.
 */
export function vaultDestination(vaultPath: string, passphrase: string): FlowDestination {
  return {
    kind: "vault",
    where: () => vaultPath,
    present() {
      if (!vaultExists(vaultPath)) return { ok: true, names: new Set<string>() };
      const listed = listCredentials(vaultPath, passphrase);
      if (!listed.ok) return { ok: false, ...vaultExit(listed) };
      return { ok: true, names: new Set(listed.names) };
    },
    write(name: string, value: string) {
      const stored = setCredential(vaultPath, passphrase, name, value);
      if (!stored.ok) return { ok: false, ...vaultExit(stored) };
      return { ok: true };
    },
  };
}

/**
 * The `.approval/env` source map (SPEC.md §5.2).
 *
 * Unused by `setup adapter` — an adapter's credentials go to the vault, never
 * to this file — and used by `setup channel telegram`, which is what a channel's
 * two values are: a source for the token and a literal chat id, both of them
 * things that unlock the machine rather than things an adapter spends.
 *
 * The value written is whatever the caller collected, which on this path is a
 * SOURCE (`keychain:<service>`), an identity, or a chat id. Nothing here decides
 * that; {@link upsertEnvFileEntries} preserves every other line and comment.
 */
export function envFileDestination(envPath: string): FlowDestination {
  return {
    kind: "env-file",
    where: () => envPath,
    present() {
      const file = readEnvFile(envPath);
      if (!file.ok) return { ok: false, ...envExit(file) };
      return { ok: true, names: new Set(file.entries.map((entry) => entry.key)) };
    },
    write(name: string, value: string) {
      const written = upsertEnvFileEntries(envPath, [{ key: name, value }]);
      if (!written.ok) return { ok: false, ...envExit(written) };
      return { ok: true };
    },
  };
}

/** The env file for a log path, re-exported so a caller needs one import. */
export { envFilePathFor };

// ---------------------------------------------------------------------------
// The replacement plan
// ---------------------------------------------------------------------------

/** How a destination talks about what it already holds. */
export interface PlanPhrases {
  /** `<name> already has a line in <path> (its value is not printed here).` */
  present(name: string, where: string): string;
  /** The confirm question. Defaults to no, like every other one in `setup`. */
  replace(name: string): string;
  /** The "left alone" report, or `null` when nothing was left alone. */
  leftAlone(names: string[], where: string): string;
}

/**
 * The two phrasings, kept as data.
 *
 * The env-file wording is BYTE-FOR-BYTE what `setup identity|vault|sampling|
 * telegram` printed before this file existed, because those sentences are
 * asserted on and, more to the point, an operator who has run `setup` before
 * should not be told the same fact in new words for no reason.
 */
export const PLAN_PHRASES: Record<FlowDestination["kind"], PlanPhrases> = {
  "env-file": {
    present: (name, where) =>
      `${name} already has a line in ${where} (its value is not printed here).\n`,
    replace: (name) => `replace the ${name} line?`,
    leftAlone: (names, where) =>
      `left alone in ${where}: ${names.join(", ")} (the existing line${names.length === 1 ? " is" : "s are"} unchanged)\n`,
  },
  vault: {
    present: (name, where) =>
      `${name} is already in ${where} (its value is not printed here).\n`,
    replace: (name) => `replace ${name}?`,
    leftAlone: (names, where) =>
      `left alone in ${where}: ${names.join(", ")} (the existing value${names.length === 1 ? " is" : "s are"} unchanged)\n`,
  },
};

/**
 * Which names to ask for, given which are already there.
 *
 * Asked BEFORE any work is done, and no previous VALUE is ever printed — not
 * even one that is not a secret. A store may legitimately hold anything under
 * any name, the operator put it there, and a verb that echoed "replacing
 * smtp.user (you@example.net)?" would publish it into a terminal on their
 * behalf.
 */
export function planWrites(
  streams: Streams,
  prompter: Prompter,
  present: ReadonlySet<string>,
  where: string,
  names: readonly string[],
  phrases: PlanPhrases,
): { write: string[]; skipped: string[] } {
  const write: string[] = [];
  const skipped: string[] = [];
  for (const name of names) {
    if (!present.has(name)) {
      write.push(name);
      continue;
    }
    streams.out(phrases.present(name, where));
    if (prompter.confirm(phrases.replace(name))) write.push(name);
    else skipped.push(name);
  }
  return { write, skipped };
}

/** Report what was left alone, so a re-run's "no" is visible in the output. */
export function reportLeftAlone(
  streams: Streams,
  where: string,
  skipped: readonly string[],
  phrases: PlanPhrases,
): void {
  if (skipped.length === 0) return;
  streams.out(phrases.leftAlone([...skipped], where));
}

// ---------------------------------------------------------------------------
// Picking from a closed set
// ---------------------------------------------------------------------------

/**
 * A numbered picker over a closed list.
 *
 * Extracted from the Telegram chat picker, which is the same conversation over
 * different nouns: print the options with an index, read a number, refuse
 * anything else without a re-prompt. Both callers use this one (APRV-79).
 *
 * An unparseable answer is a REFUSAL rather than a re-ask. `setup` refuses on
 * every other bad answer it gets (a malformed identity, a `y` where `yes` was
 * demanded), and a wizard that loops on one question and not the others is a
 * wizard whose behaviour an operator cannot predict.
 */
export function pickOne<T>(
  streams: Streams,
  prompter: Prompter,
  options: {
    heading: string;
    items: readonly T[];
    label(item: T): string;
    prompt: string;
    /** Index of the item an empty answer takes, or `null` for no default. */
    defaultIndex: number | null;
  },
): { ok: true; item: T } | { ok: false; message: string } {
  streams.out(options.heading);
  options.items.forEach((item, index) => {
    const marker = index === options.defaultIndex ? " (default)" : "";
    streams.out(`  ${String(index + 1)}. ${options.label(item)}${marker}\n`);
  });

  const answer = (prompter.readLine(options.prompt) ?? "").trim();
  if (answer.length === 0 && options.defaultIndex !== null) {
    return { ok: true, item: options.items[options.defaultIndex] as T };
  }
  const index = Number.parseInt(answer, 10);
  if (!Number.isInteger(index) || index < 1 || index > options.items.length) {
    return {
      ok: false,
      message: `${JSON.stringify(answer)} is not one of 1-${String(options.items.length)}`,
    };
  }
  return { ok: true, item: options.items[index - 1] as T };
}

// ---------------------------------------------------------------------------
// Hooks and results
// ---------------------------------------------------------------------------

/** What a verification attempt reports back. Never carries a value. */
export interface VerifyOutcome {
  /** Did the far end accept the stored configuration? */
  ok: boolean;
  /** The operator declined to verify. `ok` is ignored when this is true. */
  declined?: boolean;
  /** Lines to print, already redacted by whoever built them. */
  detail: string;
}

/** What the flow has done by the time {@link FlowHooks.verify} is called. */
export interface FlowProgress {
  /** Names stored this run, in the order they landed. */
  written: readonly string[];
  /** Names the operator declined to replace, so this run never saw them. */
  skipped: readonly string[];
}

/**
 * What a {@link FlowHooks.collect} or {@link FlowHooks.discover} attempt did.
 *
 * `refused` carries an exit code and nothing else, because the hook has already
 * printed its own sentences. A channel's refusals are specific to the far end
 * it just talked to — an invalid bot token, a 409 from a running listener, no
 * message reaching the bot after three attempts, each with its own repair and
 * its own code from the frozen table — and a flow that re-derived them from a
 * message string would be a second opinion about what went wrong.
 */
export type HookOutcome =
  | { kind: "value"; value: string }
  /** Nothing to store for this spec. A required spec may not do this. */
  | { kind: "skip" }
  | { kind: "refused"; code: number };

export interface FlowHooks {
  /**
   * Collect one value, overriding the built-in prompts.
   *
   * Async because a hook may need to prove what it collected before the flow
   * writes anything: `setup channel telegram` calls `getMe` at the end of its
   * token collection, so an invalid token refuses at step five and no line is
   * ever written. Handed what has been collected so far, in manifest order.
   */
  collect?(spec: CredentialSpec, state: Readonly<Record<string, string>>): Promise<HookOutcome>;
  /**
   * The cross-field rule, run over everything collected, before any write.
   * Returns the refusal sentence, or `null`.
   */
  check?(values: Record<string, string>): string | null;
  /**
   * Prove the stored configuration against the far end. Runs after the write.
   *
   * It is handed what the run DID as well as what it collected, because
   * "verify" and "verify what is in the store" are different questions on a
   * re-run: a hook that only saw the values would probe a partial
   * configuration and report a failure about a deployment that is fine. The
   * flow will not read the store back to complete the picture, and neither
   * should a hook — there is no verb in this CLI that reads a credential out.
   */
  verify?(values: Record<string, string>, progress: FlowProgress): Promise<VerifyOutcome>;
  /**
   * Ask the SERVICE what a value is, rather than asking the human to type it.
   *
   * Called for one spec at a time, and only when {@link FlowHooks.collect}
   * skipped it (or there is no `collect` and the spec is optional and empty),
   * so the two compose: a manifest can have some values typed and some
   * discovered without the flow knowing which is which. It is handed what has
   * been collected so far, because discovery generally needs it — Telegram's
   * chat discovery cannot happen before the token it polls with.
   *
   * APRV-78 reserved this hook and called nothing; APRV-79 is the caller.
   */
  discover?(
    spec: CredentialSpec,
    state: Readonly<Record<string, string>>,
  ): Promise<HookOutcome>;
}

export interface FlowLabels {
  /** The first line: what this verb is about to do. */
  title: string;
  /** The prerequisite sentence, printed under the title. */
  prereq?: string;
  /** Printed last, after the report. One line each. */
  nextSteps?: readonly string[];
}

export interface FlowResult {
  /** The exit code, from the frozen table. */
  code: number;
  /** Names actually stored, in the order they landed. */
  written: string[];
  /** Names the operator declined to replace. */
  skipped: string[];
  verified: "passed" | "failed" | "declined" | "not-attempted";
}

export interface CredentialFlow {
  streams: Streams;
  prompter: Prompter;
  specs: readonly CredentialSpec[];
  destination: FlowDestination;
  labels: FlowLabels;
  hooks?: FlowHooks;
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

/**
 * A Google app password as the account page displays it: sixteen lowercase
 * letters in four groups separated by single spaces (APRV-97). Anchored and
 * exact, so an ordinary password that happens to contain a space never matches.
 */
const DISPLAY_SPACED_APP_PASSWORD = /^[a-z]{4} [a-z]{4} [a-z]{4} [a-z]{4}$/u;

type Collected =
  | { kind: "value"; value: string }
  | { kind: "skip" }
  | { kind: "refused"; code: number }
  | { kind: "abort"; message: string };

/** The built-in prompts, one per {@link CredentialSpec.kind}. */
function collectDefault(
  streams: Streams,
  prompter: Prompter,
  spec: CredentialSpec,
): Collected {
  if (spec.kind === "secret") {
    const read = prompter.readSecret(`${spec.label} (not echoed): `);
    if (!read.ok) return { kind: "abort", message: `the entry for ${spec.name} was aborted` };
    let value = read.value;
    if (value.length === 0) {
      return spec.required
        ? { kind: "abort", message: `${spec.name} is required and nothing was entered` }
        : { kind: "skip" };
    }
    // The count, never the value (APRV-97). What setup collects are app
    // passwords and tokens whose lengths are public, so a count leaks nothing
    // and turns "blind paste, then a provider's 535" into "received 19".
    streams.out(`  received ${String(value.length)} character(s)\n`);
    if (DISPLAY_SPACED_APP_PASSWORD.test(value)) {
      // Google shows app passwords as four groups with display spaces, and
      // Gmail's AUTH rejects the spaced form. The shape is unmistakable, so
      // the offer defaults to yes; it is still an offer, because a secret
      // that genuinely contains spaces is stored exactly as typed.
      const strip = prompter.confirm(
        `  that is the shape of a Google app password pasted with its display spaces (16 letters shown as 4 groups); store the 16 characters without the spaces?`,
        false,
      );
      if (strip) {
        value = value.split(" ").join("");
        streams.out(`  storing ${String(value.length)} character(s)\n`);
      }
    }
    return { kind: "value", value };
  }

  if (spec.kind === "choice") {
    const choices = spec.choices ?? [];
    if (choices.length === 0) {
      return { kind: "abort", message: `${spec.name} declares no choices to pick from` };
    }
    const defaultIndex = choices.findIndex((choice) => choice.value === spec.default);
    const picked = pickOne(streams, prompter, {
      heading: `\n${spec.label} — ${spec.describe}:\n`,
      items: choices,
      label: (choice) => `${choice.value} — ${choice.describe}`,
      prompt: `which one? [1-${String(choices.length)}]: `,
      defaultIndex: defaultIndex === -1 ? null : defaultIndex,
    });
    if (!picked.ok) return { kind: "abort", message: `${spec.name}: ${picked.message}` };
    return { kind: "value", value: picked.item.value };
  }

  const suffix = spec.default === undefined ? "" : ` [${spec.default}]`;
  const answer = prompter.readLine(`${spec.label}${suffix}: `);
  const typed = (answer ?? "").trim();
  const value = typed.length === 0 ? (spec.default ?? "") : typed;
  if (value.length === 0) {
    return spec.required
      ? { kind: "abort", message: `${spec.name} is required and nothing was entered` }
      : { kind: "skip" };
  }
  return { kind: "value", value };
}

/** The kind, in the one word the checklist prints. */
function kindWord(spec: CredentialSpec): string {
  if (spec.kind === "secret") return "secret";
  if (spec.kind === "choice") return "choice";
  return "config";
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

/**
 * Run one credential conversation, start to finish. Never throws.
 *
 * The caller has already done everything that is its own business: flags, the
 * terminal check, the human-only gate, and resolving the passphrase out of the
 * environment. What arrives here is a manifest and somewhere to put it.
 */
export async function runCredentialFlow(flow: CredentialFlow): Promise<FlowResult> {
  const { streams, prompter, specs, destination, labels } = flow;
  const hooks = flow.hooks ?? {};
  const where = destination.where();
  const phrases = PLAN_PHRASES[destination.kind];
  const nothing: FlowResult = {
    code: EXIT_OK,
    written: [],
    skipped: [],
    verified: "not-attempted",
  };

  // (1) What this is, and what must already be true.
  streams.out(`${labels.title}\n`);
  if (labels.prereq !== undefined) streams.out(`${labels.prereq}\n`);

  // (2) The whole demand, before the first question.
  streams.out(`\nIt will ask for ${String(specs.length)} value(s), all of them into ${where}:\n`);
  for (const spec of specs) {
    streams.out(
      `  ${spec.name} (${kindWord(spec)}${spec.required ? "" : ", optional"}) — ${spec.describe}\n`,
    );
  }
  streams.out("\n");

  // (3) The preflight. For a vault this is where the passphrase is proved, and
  //     it is here rather than at the first write so that a wrong one refuses
  //     before a password has been typed.
  const present = destination.present();
  if (!present.ok) {
    streams.err(`approval: ${present.code}: ${present.message}\n`);
    streams.err(`  nothing was collected and nothing was written to ${where}\n`);
    return { ...nothing, code: present.exitCode };
  }

  // (4) What is already there, and whether to replace it.
  const plan = planWrites(
    streams,
    prompter,
    present.names,
    where,
    specs.map((spec) => spec.name),
    phrases,
  );
  const wanted = specs.filter((spec) => plan.write.includes(spec.name));
  if (wanted.length === 0) {
    reportLeftAlone(streams, where, plan.skipped, phrases);
    streams.out(`nothing to do: every name is already in ${where}\n`);
    return { ...nothing, skipped: plan.skipped };
  }

  // (5) Collection, in manifest order. A skipped name is never asked for.
  const values: Record<string, string> = {};
  for (const spec of wanted) {
    let collected: Collected =
      hooks.collect === undefined
        ? collectDefault(streams, prompter, spec)
        : await hooks.collect(spec, values);

    // Discovery is the second chance, not the first: a value the operator
    // typed is never overwritten by one the service reported. The hook runs
    // only where collection left a hole, which for a channel is exactly the
    // spec whose value the service is the authority on.
    if (collected.kind === "skip" && hooks.discover !== undefined) {
      collected = await hooks.discover(spec, values);
    }

    if (collected.kind === "refused") {
      // The hook has already said what happened and why, in the words of the
      // far end it was talking to. Nothing is added here.
      return { ...nothing, code: collected.code, skipped: plan.skipped };
    }
    if (collected.kind === "abort") {
      streams.err(`approval: ${collected.message}; nothing was written to ${where}\n`);
      return { ...nothing, code: EXIT_USAGE, skipped: plan.skipped };
    }
    if (collected.kind === "skip") {
      if (spec.required) {
        streams.err(
          `approval: ${spec.name} is required and no value was given; nothing was written to ${where}\n`,
        );
        return { ...nothing, code: EXIT_USAGE, skipped: plan.skipped };
      }
      continue;
    }

    const verdict = spec.validate?.(collected.value) ?? { ok: true as const };
    if (!verdict.ok) {
      // No re-prompt. The message is the adapter's own refusal sentence, so the
      // operator is told at collection time exactly what they would have been
      // told at send time, and re-running the verb is one line.
      streams.err(`approval: ${spec.name}: ${verdict.message}; nothing was written to ${where}\n`);
      return { ...nothing, code: EXIT_USAGE, skipped: plan.skipped };
    }
    values[spec.name] = collected.value;
  }

  // (6) The cross-field rule, before anything is stored.
  const crossField = hooks.check?.(values) ?? null;
  if (crossField !== null) {
    streams.err(`approval: ${crossField}; nothing was written to ${where}\n`);
    return { ...nothing, code: EXIT_USAGE, skipped: plan.skipped };
  }

  // (7) The writes, in manifest order, with no rollback on a partial failure.
  const written: string[] = [];
  for (const spec of wanted) {
    const value = values[spec.name];
    if (value === undefined) continue;
    const stored = destination.write(spec.name, value);
    if (!stored.ok) {
      streams.err(`approval: ${stored.code}: ${stored.message}\n`);
      streams.err(
        written.length === 0
          ? `  nothing was written to ${where}\n`
          : `  ${String(written.length)} value(s) had already landed in ${where}: ${written.join(", ")}. They are NOT rolled back — undoing a write this verb did not understand would be a destructive act taken on its own authority — so re-run this verb, or remove them by hand\n`,
      );
      return { code: stored.exitCode, written, skipped: plan.skipped, verified: "not-attempted" };
    }
    written.push(spec.name);
  }

  // (8) The proof, against the far end, over what was just stored.
  let verified: FlowResult["verified"] = "not-attempted";
  let verifyCode = EXIT_OK;
  if (hooks.verify !== undefined) {
    const outcome = await hooks.verify(values, { written, skipped: plan.skipped });
    if (outcome.declined === true) {
      verified = "declined";
      streams.out(outcome.detail);
    } else if (outcome.ok) {
      verified = "passed";
      streams.out(outcome.detail);
    } else {
      verified = "failed";
      verifyCode = EXIT_INTEGRITY;
      streams.err(outcome.detail);
    }
  }

  // (9) The report. Names, counts, and a path; never a value.
  streams.out(
    `\nstored ${String(written.length)} value(s) in ${where}: ${written.join(", ")}\n`,
  );
  reportLeftAlone(streams, where, plan.skipped, phrases);
  if (labels.nextSteps !== undefined && labels.nextSteps.length > 0) {
    streams.out("\n");
    for (const line of labels.nextSteps) streams.out(`${line}\n`);
  }

  return { code: verifyCode, written, skipped: plan.skipped, verified };
}
