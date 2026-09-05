/**
 * `approval policy attest` (SPEC.md §5.2) — the human-only verb that makes the
 * live policy file operative.
 *
 * As everywhere else in this CLI, the logic is not here: hashing, the actor
 * rule, and the append live in `core/attest.ts`, and the append itself goes
 * through `core/log.ts`. This file resolves paths and identity, decides an exit
 * code, and formats output.
 *
 * Three choices are load-bearing enough to state plainly.
 *
 * **Bytes, not parse.** Attestation hashes the file and does not require the
 * policy to load. A human may deliberately attest a file the engine rejects —
 * and should be able to, because the alternative is a runtime that refuses to
 * record what is actually on disk. A schema-invalid policy still fails closed
 * everywhere it matters (`loadPolicy` answers manual-everything); attesting it
 * changes nothing about that. What attestation records is "a human saw these
 * bytes", not "these bytes are good".
 *
 * **Identity is declared, not proved.** `--as human:<id>`, else
 * `APPROVAL_HUMAN`. The trust boundary is the local machine. This is stated in
 * the help text rather than hidden, because a reader who believes attestation
 * authenticates anyone would be wrong in a way that matters.
 *
 * **An agent actor is a usage error, not an I/O one.** `--as agent:x` is
 * refused at exit 2 with the rule quoted. `core/attest.ts` refuses it again
 * independently; the duplication is deliberate, since the core rule must hold
 * for every caller and not only for this one.
 *
 * **`--organ <path>` attests a gate ORGAN instead (APRV-272)**, and appends a
 * different event (`gate.organ.attested`, never `policy.updated`) for a
 * different reason: the organs are `policy.core`, the gate mints nothing for a
 * human-only class, so a hand edit to one can have no grant and the
 * protected-path guard has no other evidence to accept. The three properties
 * above hold there too — bytes not parse, declared identity, an agent actor
 * refused at exit 2 — and two refusals are added, both usage errors, for a path
 * that is the policy file and for a path that is not an organ at all.
 */

import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve as resolvePathSegments } from "node:path";

import {
  HUMAN_ACTOR_ENV,
  appendAttestation,
  appendOrganAttestation,
  resolveHumanActor,
} from "../core/attest.js";
import { normalizePathSpelling } from "../core/command-class.js";
import { POLICY_FILENAMES } from "../core/policy-load.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import { EXIT_IO, EXIT_OK, EXIT_TORN_TAIL, EXIT_USAGE } from "./exit-codes.js";
import { POLICY_ATTEST_HELP } from "./help.js";
import type { Streams } from "./main.js";
import { DEFAULT_LOG_PATH, resolvePath } from "./paths.js";
import { usageErrorText } from "./usage.js";

const FLAGS: Record<string, FlagKind> = {
  "--policy": "string",
  "--dir": "string",
  "--organ": "string",
  "--as": "string",
  "--log": "string",
  "--json": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function absolute(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolvePathSegments(cwd, value);
}

/** Relativize an organ path against the root whose bytes it names. */
function organRelativePath(
  value: string,
  root: string,
): { ok: true; path: string } | { ok: false; message: string } {
  // An absolute path is accepted and reduced, because a human tab-completing a
  // path at a terminal produces one and refusing it would be pedantry. What is
  // NOT accepted is one that leaves the root: the record names a path a reader
  // on another machine resolves against their own checkout, so `../other/…`
  // would record an identity nobody else can reproduce.
  const reduced = isAbsolute(value) ? relative(root, value) : value;
  const normalized = normalizePathSpelling(reduced);
  if (normalized.length === 0 || normalized.split("/").includes("..")) {
    return {
      ok: false,
      message: `--organ ${JSON.stringify(value)} does not name a path inside ${root}; an organ attestation records a repository-relative path, so it must sit under the checkout it is attested in (pass --dir to name a different one)`,
    };
  }
  return { ok: true, path: normalized };
}

function usageError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "usage", message } })}\n`);
  else streams.err(usageErrorText(message, POLICY_ATTEST_HELP));
  return EXIT_USAGE;
}

function ioError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "io", message } })}\n`);
  else streams.err(`approval: ${message}\n`);
  return EXIT_IO;
}

type PathOutcome = { ok: true; path: string } | { ok: false; message: string };

/**
 * Is this path a readable regular file? Unlike `policy check`, an absent policy
 * file is an I/O error here and not an answer: there is no fail-closed reading
 * of "attest a file that is not there".
 *
 * The `--organ` route does NOT come through here (APRV-272). Its path rules —
 * the policy file, the approval home, anything that is not an organ — must be
 * decided BEFORE the file is touched, so that a path this verb would never
 * attest is a usage error whether or not it happens to exist. `core/attest.ts`
 * owns that order and reports an absent organ as its own `io` refusal.
 */
function readableFile(path: string): { ok: true } | { ok: false; message: string } {
  let stats;
  try {
    stats = statSync(path);
  } catch (cause) {
    return { ok: false, message: `policy ${path} could not be opened: ${detail(cause)}` };
  }
  if (stats.isDirectory()) {
    return { ok: false, message: `policy ${path} is a directory, not a policy file` };
  }
  try {
    accessSync(path, constants.R_OK);
  } catch (cause) {
    return { ok: false, message: `policy ${path} is not readable: ${detail(cause)}` };
  }
  return { ok: true };
}

/**
 * `--policy` wins outright; otherwise discovery walks `POLICY_FILENAMES` in
 * `dir` and attests **whichever file discovery would have loaded** — the same
 * precedence as `loadPolicy`, so the attested file and the enforced file are
 * never two different files. A candidate that exists but cannot be read stops
 * discovery with an I/O error rather than being skipped: silently attesting the
 * *second* file because the first was locked would attest the wrong policy.
 */
function resolvePolicyPath(policyFlag: string | null, dir: string, cwd: string): PathOutcome {
  if (policyFlag !== null) {
    const path = absolute(policyFlag, cwd);
    const check = readableFile(path);
    return check.ok ? { ok: true, path } : { ok: false, message: check.message };
  }

  for (const filename of POLICY_FILENAMES) {
    const candidate = join(dir, filename);
    let exists = true;
    try {
      statSync(candidate);
    } catch {
      exists = false;
    }
    if (!exists) continue;
    const check = readableFile(candidate);
    return check.ok ? { ok: true, path: candidate } : { ok: false, message: check.message };
  }

  return {
    ok: false,
    message: `no policy file found in ${dir} (looked for ${POLICY_FILENAMES.join(", ")}); attestation needs a file to hash`,
  };
}

/** What {@link attestOrgan} needs from the parsed command line. */
interface OrganRun {
  streams: Streams;
  json: boolean;
  actor: string;
  /** The checkout the organ path is relative to (`--dir`, else the cwd). */
  dir: string;
  logPath: string;
  policyFlag: string | null;
}

/**
 * `approval policy attest --organ <path>` (APRV-272) — the human route for the
 * gate's ORGAN files.
 *
 * One path per call, deliberately. A repeatable flag would let one invocation
 * attest a set, and a human reading back "what did I sign off" would have to
 * reconstruct the set from a single record; one record per file is also what the
 * protected-path guard asks for, since its question is always about one path.
 *
 * `--policy` alongside `--organ` is a usage error rather than a precedence
 * puzzle: the two flags name two different files to hash, and guessing which the
 * caller meant is how the wrong bytes get attested.
 *
 * Everything that decides is in `core/attest.ts`: the human-actor rule, the
 * refusal of the policy file, the refusal of anything that is not an organ, and
 * the digest. This function resolves a path, picks an exit code, and prints.
 */
function attestOrgan(organFlag: string, run: OrganRun): number {
  const { streams, json } = run;
  if (run.policyFlag !== null) {
    return usageError(
      streams,
      json,
      "--policy and --organ name two different files to hash; pass one of them (the policy file is attested by `approval policy attest` with no --organ)",
    );
  }

  const resolved = organRelativePath(organFlag, run.dir);
  if (!resolved.ok) return usageError(streams, json, resolved.message);

  // The file is NOT stat'd here: `core/attest.ts` decides the path rules before
  // it reads anything, so `--organ SPEC.md` is a usage error whether or not
  // SPEC.md exists, and an absent organ comes back as that module's `io`
  // refusal with the path and the root named.
  const onDisk = join(run.dir, resolved.path);

  // No timestamp is passed: `gate.organ.attested` carries the `gate.` prefix, so
  // amended SPEC.md §8 (A2) has core stamp it at the write boundary.
  const result = appendOrganAttestation(
    run.logPath,
    { path: resolved.path, root: run.dir },
    run.actor,
  );

  if (result.ok) {
    const sha256 = (result.record.payload as Record<string, unknown>)["sha256"] as string;
    if (json) {
      streams.out(
        `${JSON.stringify({
          ok: true,
          seq: result.record.seq,
          sha256,
          path: onDisk,
          organ_path: resolved.path,
        })}\n`,
      );
    } else {
      streams.out(
        `attested gate organ ${resolved.path} at seq ${result.record.seq}: sha256 ${sha256}\n`,
      );
    }
    return EXIT_OK;
  }

  if (json) {
    streams.err(
      `${JSON.stringify({ ok: false, error: { code: result.error.code, message: result.error.message } })}\n`,
    );
  } else {
    streams.err(`approval: ${result.error.message}\n`);
  }
  switch (result.error.code) {
    // A path this verb will not attest, and an actor who may not attest, are
    // both bad invocations: the caller has to change what they typed, not
    // retry. `path-is-policy` and `path-not-organ` stay distinct in the payload
    // because the repairs differ — one is `approval policy attest` with no
    // flag, the other is not attested at all.
    case "path-is-policy":
    case "path-not-organ":
    case "actor-not-human":
    case "validation":
      return EXIT_USAGE;
    case "corrupt-tail":
      return EXIT_TORN_TAIL;
    default:
      return EXIT_IO;
  }
}

/** `approval policy attest …` — hash the live policy file and log the human's sign-off. */
export function commandPolicyAttest(argv: string[], streams: Streams, cwd: string): number {
  const json = argv.includes("--json");
  const parsed = parseFlags(argv, FLAGS);
  if (!parsed.ok) return usageError(streams, json, parsed.message);

  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${POLICY_ATTEST_HELP}\n`);
    return EXIT_OK;
  }

  const extra = parsed.positionals[0];
  if (extra !== undefined) {
    return usageError(streams, json, `unexpected argument ${JSON.stringify(extra)}`);
  }

  const asFlag = stringFlag(parsed.flags, "--as");
  const actor = resolveHumanActor(asFlag === null ? {} : { actor: asFlag });
  if (actor === null) {
    if (asFlag !== null) {
      return usageError(
        streams,
        json,
        `--as expects a human identity matching human:<id>, got ${JSON.stringify(asFlag)}; attestation is human-only and an agent: or system: actor cannot perform it`,
      );
    }
    return usageError(
      streams,
      json,
      `no human identity: set ${HUMAN_ACTOR_ENV}=human:<id> or pass --as human:<id>`,
    );
  }

  const dirFlag = stringFlag(parsed.flags, "--dir");
  const dir = dirFlag === null ? cwd : absolute(dirFlag, cwd);
  const logPath = resolvePath(stringFlag(parsed.flags, "--log"), DEFAULT_LOG_PATH, cwd);

  const organFlag = stringFlag(parsed.flags, "--organ");
  if (organFlag !== null) {
    return attestOrgan(organFlag, {
      streams,
      json,
      actor,
      dir,
      logPath,
      policyFlag: stringFlag(parsed.flags, "--policy"),
    });
  }

  const policy = resolvePolicyPath(stringFlag(parsed.flags, "--policy"), dir, cwd);
  if (!policy.ok) return ioError(streams, json, policy.message);

  // No timestamp is passed: `policy.updated` is gate-typed, so amended SPEC.md
  // §8 (A2) has core stamp it at the write boundary from its own clock.
  const result = appendAttestation(logPath, policy.path, actor);

  if (result.ok) {
    const sha256 = (result.record.payload as Record<string, unknown>)["sha256"] as string;
    if (json) {
      streams.out(
        `${JSON.stringify({ ok: true, seq: result.record.seq, sha256, path: policy.path })}\n`,
      );
    } else {
      streams.out(`attested ${policy.path} at seq ${result.record.seq}: sha256 ${sha256}\n`);
    }
    return EXIT_OK;
  }

  if (json) {
    streams.err(
      `${JSON.stringify({ ok: false, error: { code: result.error.code, message: result.error.message } })}\n`,
    );
  } else {
    streams.err(`approval: ${result.error.message}\n`);
  }
  switch (result.error.code) {
    case "actor-not-human":
      // The actor rule, re-refused by core with its own code since APRV-20 pass
      // two. Reachable only if this layer's check and core's ever disagree; it
      // is a bad invocation either way, so exit 2.
      return EXIT_USAGE;
    case "validation":
      // The record itself failed `event.schema.json` at the write boundary — a
      // different fact from the actor rule, and no longer spelled the same way.
      return EXIT_USAGE;
    case "corrupt-tail":
      // A torn tail has its own code in the frozen table, and calling it I/O
      // would misreport a crashed write as a permission problem.
      return EXIT_TORN_TAIL;
    default:
      return EXIT_IO;
  }
}
