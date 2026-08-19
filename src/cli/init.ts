/**
 * `approval init` — scaffold a working directory (SPEC.md §10.1).
 *
 * Until this verb existed, every ceremony began with a human being told to
 * `mkdir -p .approval/log` and to type a policy file from memory. That is the
 * one step of the ceremony where a mistake is silent: a policy with a mistyped
 * fence is an unparseable policy, an unparseable policy is `manual` everything
 * (SPEC.md §5.2), and a human who meant to declare three autonomous classes
 * discovers the typo only when the queue fills with things they never wanted to
 * be asked about.
 *
 * ## What it writes, and what it refuses to
 *
 * Four things: `APPROVAL.md` (the canonical policy of SPEC.md §5.1, verbatim),
 * `.approval/log/` (the directory only), `.approval/QUEUE.md` (the real
 * renderer's empty state, not a hand-written imitation of it), and the
 * `.gitignore` entries for the derived and secret-bearing files.
 *
 * **It never appends to the log and never attests.** `init` is not a gate
 * operation and holds no authority: it produces a policy file that authorizes
 * nothing until a human reads it and runs `approval policy attest`. The log
 * directory it creates is empty on purpose — the first attestation is what
 * creates `events.jsonl`, and a scaffolded log would be a chain nobody signed.
 *
 * **It never overwrites.** The semantics are idempotent rather than
 * destructive: `init` plans first, then writes only the targets that are
 * missing, and reports the rest as `existing` with a distinct per-file code. A
 * second run therefore writes nothing, reports what it found, and exits 0. The
 * single exception to "never touch an existing file" is `.gitignore`, which is
 * merged: missing lines are appended under a marker comment and no existing
 * line is rewritten, reordered, or removed.
 *
 * **A path of the wrong kind is a refusal, not a report.** A directory named
 * `APPROVAL.md`, or a regular file where `.approval/` belongs, is not a
 * scaffold that already exists; it is a working directory this verb cannot
 * reason about. Those cases refuse as {@link INIT_REFUSAL_CODES `path-conflict`}
 * at {@link EXIT_IO} with **nothing written at all** — the conflict scan runs
 * over every target before the first byte is written, so a conflict on the
 * fourth target does not leave the first three half-scaffolded.
 *
 * ## Exit codes
 *
 * Drawn from the frozen table in `exit-codes.ts`, nothing added: 0 for a
 * successful scaffold *and* for a fully idempotent re-run, 2 for usage, 4 for a
 * path conflict or any other filesystem failure. There is no distinct code for
 * "everything already existed", because that is not a failure: the caller asked
 * for a scaffolded directory and a scaffolded directory is what it has.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve as resolvePathSegments } from "node:path";

import { writeQueue } from "../channels/render-queue.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import { EXIT_IO, EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { INIT_HELP } from "./help.js";
import type { Streams } from "./main.js";
import { DEFAULT_LOG_PATH } from "./paths.js";
import { CANONICAL_POLICY, GITIGNORE_ENTRIES, GITIGNORE_MARKER } from "./scaffold.js";
import { usageErrorText } from "./usage.js";

const FLAGS: Record<string, FlagKind> = {
  "--dir": "string",
  "--json": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

/**
 * Why a target was not written. Frozen, and ADDITIVE in the sense the rest of
 * the CLI's machine-readable vocabularies are: a code is added, never
 * repurposed.
 *
 * The first four are reports, not failures: they appear in `existing[]` of a
 * successful (exit 0) run. Only `path-conflict` refuses, and it refuses the
 * whole invocation.
 */
export const INIT_REFUSAL_CODES = [
  "policy-exists",
  "log-dir-exists",
  "queue-exists",
  "gitignore-entries-present",
  "path-conflict",
] as const;

export type InitRefusalCode = (typeof INIT_REFUSAL_CODES)[number];

/** One target `init` left alone, with the reason it left it alone. */
export interface InitExisting {
  path: string;
  code: InitRefusalCode;
}

function wantsJson(argv: string[]): boolean {
  return argv.includes("--json");
}

function usageError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "usage", message } })}\n`);
  else streams.err(usageErrorText(message, INIT_HELP));
  return EXIT_USAGE;
}

function ioError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "io", message } })}\n`);
  else streams.err(`approval: ${message}\n`);
  return EXIT_IO;
}

function conflictError(streams: Streams, json: boolean, conflicts: string[]): number {
  const message = `path-conflict: ${conflicts.join("; ")}. Nothing was written: init scans every target before it writes anything, so a working directory it cannot reason about is left exactly as it is`;
  if (json) {
    streams.err(`${JSON.stringify({ error: { code: "path-conflict", message } })}\n`);
  } else {
    streams.err(`approval: ${message}\n`);
  }
  return EXIT_IO;
}

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function absolute(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolvePathSegments(cwd, value);
}

type Kind = "absent" | "file" | "directory" | "other";

/** What is at `path` right now. An unreadable stat is reported as `other`. */
function kindOf(path: string): Kind {
  let stats;
  try {
    stats = statSync(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    return "other";
  }
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "file";
  return "other";
}

/**
 * The next steps, in the order a human performs them.
 *
 * Returned as an array rather than printed as a paragraph because an agent
 * reading `--json` needs the same instructions the human gets, and a wall of
 * prose is not something a caller can act on one item at a time.
 *
 * The payload note is the one editorial decision in this verb, so it is stated
 * rather than implied. `.approval/payloads/` holds the exact bytes each approval
 * bound to (SPEC.md §6.2, §9): the material evidence of what a human said yes
 * to. Evidence defaults to tracked, so the scaffold does not ignore it. The
 * alternative is one line, and it costs the rebuildability of that evidence, so
 * both halves are printed together.
 */
function nextSteps(): string[] {
  return [
    "Edit APPROVAL.md. What was scaffolded is the canonical example policy, not your policy: it names an approver you are probably not and declares classes you have not agreed to. Read every class before you sign for it.",
    "Run `approval policy attest` (as a human: APPROVAL_HUMAN=human:<id>, or --as human:<id>). Attestation is what makes a policy operative, and it is what creates .approval/log/events.jsonl — init made the directory and deliberately put nothing in it, because a log entry nobody signed is not evidence of anything.",
    "Run `approval doctor` to check that this machine can run the system at all: build freshness, identity, attestation, chain health, channels.",
    "Run `approval env --check` to see which environment variables your policy names and where each one would come from (it prints no values). To record where they live, write `.approval/env` — one KEY=VALUE per line, where VALUE is `keychain:<service>`, `secret-service:<label>`, `env:`, or a plaintext literal — `chmod 600` it, and put `eval \"$(approval env)\"` in your shell. No other command reads that file, deliberately: human identity is one of the variables it can carry, so a file the runtime loaded on its own would let anything able to write it act as you.",
    "Payload bytes are TRACKED by default: .approval/payloads/ is not in the .gitignore lines init wrote. Those bytes are what each approval bound to, and evidence belongs in the history. To keep them out of git instead, add `.approval/payloads/` to .gitignore yourself — the log still records every payload_hash, but the bytes behind those hashes become unrebuildable.",
  ];
}

/**
 * Merge the ignore lines into an existing `.gitignore`, or produce a new one.
 *
 * Append-only, by the same instinct as the log: existing lines are never
 * rewritten, reordered, or removed, and a line already present anywhere in the
 * file (under our marker or the operator's own heading) counts as present. The
 * marker is written once — a file that already carries it gets the missing lines
 * appended under the existing one rather than a second copy of it.
 */
export function mergeGitignore(
  current: string | null,
  entries: readonly string[] = GITIGNORE_ENTRIES,
): { changed: boolean; text: string; added: string[] } {
  const existing = current ?? "";
  const lines = new Set(existing.split("\n").map((line) => line.trim()));
  const added = entries.filter((entry) => !lines.has(entry));
  if (added.length === 0) return { changed: false, text: existing, added };

  const parts: string[] = [];
  if (existing.length > 0) {
    parts.push(existing.endsWith("\n") ? existing : `${existing}\n`);
    parts.push("\n");
  }
  if (!existing.split("\n").some((line) => line.trim() === GITIGNORE_MARKER)) {
    parts.push(`${GITIGNORE_MARKER}\n`);
  }
  parts.push(`${added.join("\n")}\n`);
  return { changed: true, text: parts.join(""), added };
}

export function commandInit(argv: string[], streams: Streams, cwd: string): number {
  const json = wantsJson(argv);
  const parsed = parseFlags(argv, FLAGS);
  if (!parsed.ok) return usageError(streams, json, parsed.message);
  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${INIT_HELP}\n`);
    return EXIT_OK;
  }
  const extra = parsed.positionals[0];
  if (extra !== undefined) {
    return usageError(streams, json, `unexpected argument ${JSON.stringify(extra)}`);
  }

  const dirFlag = stringFlag(parsed.flags, "--dir");
  const dir = dirFlag === null ? cwd : absolute(dirFlag, cwd);

  const policyPath = join(dir, "APPROVAL.md");
  const fallbackPolicyPath = join(dir, "APPROVALS.md");
  const approvalDir = join(dir, ".approval");
  const logDir = join(approvalDir, "log");
  const queuePath = join(approvalDir, "QUEUE.md");
  const gitignorePath = join(dir, ".gitignore");
  const logPath = join(dir, DEFAULT_LOG_PATH);

  // ---------------------------------------------------------------------
  // Plan. Nothing below this block writes; nothing above it does either.
  // ---------------------------------------------------------------------

  const dirKind = kindOf(dir);
  if (dirKind === "file" || dirKind === "other") {
    return conflictError(streams, json, [`${dir} is not a directory`]);
  }

  const conflicts: string[] = [];
  const requireFileOrAbsent = (path: string, what: string): Kind => {
    const kind = kindOf(path);
    if (kind === "directory") conflicts.push(`${path} is a directory where ${what} belongs`);
    if (kind === "other") conflicts.push(`${path} exists and is neither a file nor a directory`);
    return kind;
  };
  const requireDirOrAbsent = (path: string, what: string): Kind => {
    const kind = kindOf(path);
    if (kind === "file") conflicts.push(`${path} is a file where ${what} belongs`);
    if (kind === "other") conflicts.push(`${path} exists and is neither a file nor a directory`);
    return kind;
  };

  const policyKind = requireFileOrAbsent(policyPath, "the policy file APPROVAL.md");
  const fallbackKind = requireFileOrAbsent(
    fallbackPolicyPath,
    "the fallback policy file APPROVALS.md",
  );
  requireDirOrAbsent(approvalDir, "the .approval/ directory");
  const logDirKind = requireDirOrAbsent(logDir, "the log directory .approval/log/");
  const queueKind = requireFileOrAbsent(queuePath, "the queue projection .approval/QUEUE.md");
  const gitignoreKind = requireFileOrAbsent(gitignorePath, "the .gitignore file");

  if (conflicts.length > 0) return conflictError(streams, json, conflicts);

  const written: string[] = [];
  const existing: InitExisting[] = [];

  // SPEC.md §5: APPROVALS.md is an accepted filename, so a directory carrying
  // one already has a policy and init has nothing to add. Scaffolding
  // APPROVAL.md beside it would silently take precedence over the file the
  // human actually wrote.
  const policyPresent = policyKind === "file" || fallbackKind === "file";

  // ---------------------------------------------------------------------
  // Write. Only the missing targets, in ceremony order.
  // ---------------------------------------------------------------------

  if (policyPresent) {
    existing.push({
      path: policyKind === "file" ? "APPROVAL.md" : "APPROVALS.md",
      code: "policy-exists",
    });
  } else {
    try {
      writeFileSync(policyPath, CANONICAL_POLICY, { encoding: "utf8", flag: "wx" });
    } catch (cause) {
      return ioError(streams, json, `APPROVAL.md could not be written: ${detail(cause)}`);
    }
    written.push("APPROVAL.md");
  }

  if (logDirKind === "directory") {
    existing.push({ path: ".approval/log/", code: "log-dir-exists" });
  } else {
    try {
      mkdirSync(logDir, { recursive: true });
    } catch (cause) {
      return ioError(streams, json, `.approval/log/ could not be created: ${detail(cause)}`);
    }
    written.push(".approval/log/");
  }

  if (queueKind === "file") {
    existing.push({ path: ".approval/QUEUE.md", code: "queue-exists" });
  } else {
    // The real renderer, against the (absent, therefore empty and clean) log
    // this directory now has. A hand-written "empty queue" header would be a
    // second implementation of the projection, and the first thing `approval
    // render` did would be to disagree with it.
    const now = new Date().toISOString();
    const result = writeQueue(logPath, queuePath, { policy: { dir } }, now);
    if (!result.ok) {
      return ioError(
        streams,
        json,
        `.approval/QUEUE.md could not be written (${result.code}): ${result.message}`,
      );
    }
    written.push(".approval/QUEUE.md");
  }

  let currentGitignore: string | null = null;
  if (gitignoreKind === "file") {
    try {
      currentGitignore = readFileSync(gitignorePath, "utf8");
    } catch (cause) {
      return ioError(streams, json, `.gitignore could not be read: ${detail(cause)}`);
    }
  }
  const merged = mergeGitignore(currentGitignore);
  if (!merged.changed) {
    existing.push({ path: ".gitignore", code: "gitignore-entries-present" });
  } else {
    try {
      writeFileSync(gitignorePath, merged.text, "utf8");
    } catch (cause) {
      return ioError(streams, json, `.gitignore could not be written: ${detail(cause)}`);
    }
    written.push(".gitignore");
  }

  const steps = nextSteps();

  if (json) {
    streams.out(`${JSON.stringify({ ok: true, dir, written, existing, next_steps: steps })}\n`);
    return EXIT_OK;
  }

  streams.out(`approval: scaffolded ${dir}\n`);
  if (written.length === 0) {
    streams.out("  nothing written — every target already exists\n");
  } else {
    for (const path of written) streams.out(`  wrote    ${path}\n`);
  }
  for (const entry of existing) {
    streams.out(`  existing ${entry.path} (${entry.code}) — left exactly as it is\n`);
  }
  streams.out("\nNext steps:\n");
  for (const [index, step] of steps.entries()) {
    streams.out(`  ${String(index + 1)}. ${step}\n`);
  }
  streams.out(
    "\nNothing was appended to the log and no policy was attested: init holds no authority and the file it wrote authorizes nothing until a human attests it.\n",
  );
  return EXIT_OK;
}
