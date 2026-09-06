/**
 * `approval doctor` — environment sanity in one verb (APRV-31).
 *
 * ## Why this exists
 *
 * During the live policy-amendment ceremony the operator lost time twice to
 * questions this command answers in a second. First they drove a **stale
 * checkout**: `dist/` was older than the source tree, so verbs that existed in
 * `src/` were simply absent from the built CLI and every invocation looked like
 * a version confusion rather than a missing `npm run build`. Then they reached
 * for what turned out to be an **unbuilt placeholder binary** — a `cli.js`
 * loader with no `dist/` behind it, which fails with one line about a missing
 * file and says nothing about which of the several checkouts on the machine is
 * the real one. Only on the third try did they find the working install.
 *
 * Neither failure was a bug in the runtime. Both were facts about the
 * environment that nothing was in a position to state out loud. `doctor` is
 * that statement: eleven checks, in the order in which their failures cascade,
 * each with a concrete repair.
 *
 * ## Every fix begins with a command (APRV-75)
 *
 * A `fix` string starts with something the operator can paste, and the prose
 * comes after it. The reason is the reading order of a failed run: an operator
 * scanning a wall of `fix:` lines is looking for the next thing to type, and a
 * line that opens with "check that…" makes them read a sentence to discover
 * there is nothing to type at all. {@link FIX_COMMAND_PREFIXES} is the pinned
 * allowlist, and `tests/cli-doctor.test.ts` drives every failing verdict this
 * command can produce and asserts the shape (never the wording).
 *
 * ## What it will not do
 *
 * **It appends nothing.** Not an event, not a marker, not a "doctor ran"
 * breadcrumb. An operator reaching for a diagnostic while the log is in a state
 * they do not understand must not have that state changed by looking at it; the
 * test suite byte-compares the log across a run.
 *
 * **It sends no message.** The Telegram check calls `getMe` and only `getMe` —
 * a pure identity read. It never calls `sendMessage` (a diagnostic that pings a
 * human's phone is a diagnostic nobody runs twice) and it never calls
 * `getUpdates`, because a running `channel telegram listen` owns that offset
 * and a stray poll would consume an update the listener would then never see.
 *
 * **It repairs nothing.** Every failure yields a `fix` string the human runs
 * themselves. A doctor that rebuilt, re-attested, or truncated on its own would
 * be making exactly the decisions this project exists to keep human.
 *
 * ## Exit codes
 *
 * 0 when every check passed or skipped, 1 when any failed. {@link EXIT_IO} is
 * reserved for doctor's own inability to look — the installation root cannot be
 * stat'd for a reason other than "not there". An unreadable *log* or an
 * unreadable *policy* is not that: those are environment facts, which is
 * precisely what this command reports, so they are check failures (exit 1).
 */

import { createServer } from "node:net";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePathSegments } from "node:path";

import { WEB_DEFAULT_PORT } from "../channels/web.js";
import {
  TELEGRAM_DEFAULT_API_BASE,
  telegramChatEnvFor,
  telegramTokenEnvFor,
} from "../channels/telegram.js";
import {
  HUMAN_ACTOR_ENV,
  checkAttestation,
  findOrganAttestation,
  latestOrganAttestation,
  policyBytesHash,
  resolveHumanActor,
} from "../core/attest.js";
import { isGateOrganPath } from "../core/command-class.js";
import { VALUES_INFO_STRING, loadValues } from "../core/values.js";
import {
  KEYSTORE_DEFERRED,
  NON_RESOLVING_RUNNER,
  envFilePathFor,
  resolveEnvironment,
  type ResolvedVariable,
} from "../core/env-file.js";
import { readTaskFile } from "../core/frontmatter.js";
import { instanceFindings, instanceHomeFor, instanceIdFor } from "../core/instance.js";
import type { EventRecord } from "../core/log.js";
import { checkLogAnchor } from "./log-anchor.js";
import { checkLogCheckpoints, checkpointPolicyOf } from "../core/checkpoint.js";
import { payloadStoreCensus } from "../core/payload-census.js";
import { payloadStoreDirFor } from "../core/payload-store.js";
import { DEFAULT_TASKS_DIR, latestRegistration } from "../core/registration.js";
import { POLICY_FILENAMES, loadPolicy, type PolicyLoadResult } from "../core/policy-load.js";
import { openObligations } from "../core/audit.js";
import { classSampling, resolveSampler, type Sampler } from "../core/sampler.js";
import {
  checkVault,
  passphraseEnvFor,
  passphraseFrom,
  vaultExists,
  vaultPathFor,
} from "../core/vault.js";
import {
  admitSnapshot,
  logBytes,
  snapshotPathFor,
  snapshotSummary,
} from "../core/verified-snapshot.js";
import {
  askDaemonSampling,
  dialDrawSocket,
  drawSocketPathFor,
  liveClassesOf,
} from "../core/live-draw.js";
import { verifyWithRecords, type VerifyResult } from "../core/verify.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import { policyWebPort } from "./channel-web.js";
import { EXIT_INTEGRITY, EXIT_IO, EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import {
  RESOLVE_DANGLING_COMMAND,
  lastAdvance,
  proveDanglingAdvances,
} from "../core/advance-cycle.js";
import {
  DEFAULT_DARK_WINDOW_MS,
  reportDarkSessions,
  type DarkSessionFinding,
} from "../core/dark-session.js";
import {
  HARNESS_BINARY,
  HARNESS_KINDS,
  installedHarnessVersion,
  isHarnessKind,
  readHarnessProvenance,
  type HarnessKind,
} from "../core/harness-version.js";
import { repoRoot } from "./git-scope.js";
import {
  ScanError,
  checkBuildFreshness,
  checkMainBehindOrigin,
  installationRoot,
} from "./preflight.js";
import { publishedState } from "./log-advance.js";
import { DOCTOR_HELP } from "./help.js";
import type { Streams } from "./main.js";
import { DEFAULT_LOG_PATH, resolvePath } from "./paths.js";
import { DEFAULT_QUEUE_PATH } from "./render.js";
import { style, type Glyph, type Style, type TableRow } from "./style.js";
import { usageErrorText } from "./usage.js";

const FLAGS: Record<string, FlagKind> = {
  "--log": "string",
  "--policy": "string",
  "--dir": "string",
  "--api-base": "string",
  // Where the task files live, for the envelope-integrity check (APRV-63).
  // Defaults to <--dir>/backlog/tasks, the same default the daemon uses.
  "--tasks": "string",
  // Test-only (documented as such in --help): retarget the build-freshness
  // check at a fixture tree. It moves no other check, and a wrong value can
  // only make check 1 wrong — never the log, the policy, or the network.
  "--root": "string",
  // APRV-102. The brief's `--verbose`: never abbreviate a detail, whatever the
  // terminal is doing. See `renderDoctorHuman` for why the default is not the
  // aggressive truncation the brief first proposed.
  "--verbose": "boolean",
  "--json": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

/** How long the Telegram identity probe waits before calling it a network failure. */
const PROBE_TIMEOUT_MS = 10_000;

/** One check's verdict. `fix` is present only when there is something to do. */
export interface DoctorCheck {
  check: string;
  status: "pass" | "fail" | "skip";
  detail: string;
  fix?: string;
}

/**
 * Every `fix` string begins with one of these, and the prose follows (APRV-75).
 *
 * A closed, small list rather than "looks like a command": the point is that a
 * reader can paste the head of the line, and a `fix` that opened with a verb
 * nobody has installed would be no better than a sentence. `approval ` is by far
 * the commonest — most repairs in this runtime are another verb of this CLI —
 * and the shell builtins here are the ones an actual repair needs: a variable to
 * export, a mode to set, an ignore line to append, a directory to move aside.
 *
 * Note what is NOT here: no `rm`, no `sudo`, no `git commit`. Doctor repairs
 * nothing, and a fix line that told an operator to delete or to commit would be
 * making the decision this project exists to keep human.
 */
export const FIX_COMMAND_PREFIXES: readonly string[] = [
  "approval ",
  "chmod ",
  "echo ",
  "export ",
  "mv ",
  "node ",
  "npm ",
];

function detailOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Fold a multi-line message onto one line.
 *
 * The human renderer is one line per check plus one indented `fix:`, and a
 * message that arrived with an embedded newline (the `.approval/env` mode
 * refusal carries its `chmod` on a second line) would silently break that shape
 * for every reader and every test that counts lines.
 */
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/gu, " ").trim();
}

function absolute(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolvePathSegments(cwd, value);
}

function usageError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "usage", message } })}\n`);
  else streams.err(usageErrorText(message, DOCTOR_HELP));
  return EXIT_USAGE;
}

function ioError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "io", message } })}\n`);
  else streams.err(`approval: ${message}\n`);
  return EXIT_IO;
}

// ---------------------------------------------------------------------------
// 1. build freshness
// ---------------------------------------------------------------------------
//
// `installationRoot`, `ScanError`, `newestMtime` and `checkBuildFreshness`
// moved to `cli/preflight.ts` (APRV-215), where the startup preflight needs the
// same answer before it decides whether to rebuild. They are imported back
// above and their behaviour is unchanged; this note is here so the numbered
// walk through doctor's checks still has a first step to stand on.

// ---------------------------------------------------------------------------
// 2. identity
// ---------------------------------------------------------------------------

/**
 * Is a human identity declared in the environment?
 *
 * Environment only — deliberately no `--as`. `doctor` reports what the *next*
 * command will find, and a `--as` typed here would answer for this invocation
 * and nothing else, which is the opposite of useful.
 */
function checkIdentity(): DoctorCheck {
  const actor = resolveHumanActor();
  if (actor !== null) {
    return {
      check: "identity",
      status: "pass",
      detail: `${HUMAN_ACTOR_ENV}=${actor} (config-declared: the trust boundary is this machine, not cryptography)`,
    };
  }
  const raw = process.env[HUMAN_ACTOR_ENV];
  return {
    check: "identity",
    status: "fail",
    detail:
      raw === undefined || raw.length === 0
        ? `${HUMAN_ACTOR_ENV} is unset: the human-only verbs (grant, reject, revoke, policy attest) will refuse`
        : `${HUMAN_ACTOR_ENV}=${JSON.stringify(raw)} does not match human:<id>, so it is ignored rather than guessed at`,
    // `approval setup identity` lands in APRV-74, in parallel with this task;
    // the manual alternative is kept after it deliberately, because a fix that
    // named only a verb would be useless to anyone on an older build.
    fix: `approval setup identity — or set it yourself: export ${HUMAN_ACTOR_ENV}=human:<id>, or pass --as human:<id> to each human-only verb`,
  };
}

// ---------------------------------------------------------------------------
// 3. attestation
// ---------------------------------------------------------------------------

/**
 * The policy file this runtime would enforce.
 *
 * `--policy` wins outright; otherwise discovery walks {@link POLICY_FILENAMES}
 * in `dir` exactly as `loadPolicy` and `policy attest` do, so doctor never
 * judges a different file from the one the gate reads. When nothing is found,
 * the first candidate name is returned anyway: `checkAttestation` will report
 * it `unreadable`, which is the honest answer ("there is no policy here"), and
 * the message names the path that is missing.
 */
function resolvePolicyPath(policyFlag: string | null, dir: string, cwd: string): string {
  if (policyFlag !== null) return absolute(policyFlag, cwd);
  for (const filename of POLICY_FILENAMES) {
    const candidate = join(dir, filename);
    try {
      statSync(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return join(dir, POLICY_FILENAMES[0] ?? "APPROVAL.md");
}

/**
 * Do the live policy bytes match the latest attestation in the log?
 *
 * This is the check that decides whether the gate will do anything at all: an
 * unattested policy makes every gated operation refuse, and the refusal is
 * easily misread as "the policy says no" rather than "the policy is unverified".
 */
function checkAttestationHealth(records: EventRecord[], policyPath: string): DoctorCheck {
  const status = checkAttestation(records, policyPath);
  switch (status.status) {
    case "attested":
      return {
        check: "attestation",
        status: "pass",
        detail: `${policyPath} is attested at seq ${status.seq} (sha256 ${status.sha256.slice(0, 12)}…)`,
      };
    case "not-attested":
      return {
        check: "attestation",
        status: "fail",
        detail: `${policyPath} has never been attested; every gated operation will refuse with policy-not-attested`,
        fix: "approval policy attest --as human:<id> — after reading the file",
      };
    case "hash-mismatch":
      return {
        check: "attestation",
        status: "fail",
        detail: `${policyPath} has changed since it was attested at seq ${status.seq} (attested ${status.attestedSha256.slice(0, 12)}…, live ${status.liveSha256.slice(0, 12)}…); an edited policy is inoperative until a human re-attests it`,
        fix: `approval policy attest --as human:<id> — after reviewing the diff (\`git diff -- ${policyPath}\`); re-attesting is what makes the new bytes operative`,
      };
    case "unreadable":
      return {
        check: "attestation",
        status: "fail",
        detail: `${status.message}; an unverifiable policy is treated as unattested`,
        fix: `approval init — to scaffold a policy file here (or point --policy / --dir at the one you have), then \`approval policy attest --as human:<id>\``,
      };
  }
}

// ---------------------------------------------------------------------------
// 4. log
// ---------------------------------------------------------------------------

/** The chain verdict, in doctor's vocabulary. Reads; never writes. */
function checkLog(logPath: string, result: VerifyResult): DoctorCheck {
  switch (result.status) {
    case "clean":
      return {
        check: "log",
        status: "pass",
        detail:
          result.head === null
            ? `${logPath} is empty (an audit trail that has recorded nothing is clean, not missing)`
            : `${logPath} verifies: ${result.records} record(s), head seq ${result.head.seq} ${result.head.hash.slice(0, 12)}…`,
      };
    case "torn-tail":
      return {
        check: "log",
        status: "fail",
        detail: `${logPath} ends with an unterminated final line — the signature of a crashed write, not of tampering; records 1..${result.intactThroughSeq} verify clean`,
        fix: "approval log verify — the full report; nothing here truncates the torn line, because that is a human decision",
      };
    case "corrupt":
      return {
        check: "log",
        status: "fail",
        detail: `${logPath} does not verify (${result.reason}${
          result.firstBadSeq === null ? "" : ` at seq ${result.firstBadSeq}`
        }): ${result.message}`,
        fix: "approval log verify — and authorize nothing from this log until a human has accounted for the break",
      };
  }
}

// ---------------------------------------------------------------------------
// 5. telegram
// ---------------------------------------------------------------------------

/** Replace the bot token wherever it appears. Nothing leaves this file with it. */
function redact(text: string, token: string): string {
  return token.length === 0 ? text : text.split(token).join("<token redacted>");
}

/**
 * Is the configured bot token live?
 *
 * `getMe` and nothing else. Not `sendMessage`: a diagnostic that buzzes a
 * human's phone gets run once and then avoided. Not `getUpdates`: that call
 * advances an offset a running `approval channel telegram listen` owns, and a
 * decision tap consumed here would never reach the listener that was waiting
 * for it. `getMe` mutates nothing and acknowledges nothing.
 *
 * Absent configuration is a `skip`, not a failure. Telegram is optional; a
 * runtime driven entirely by `channel cli` is perfectly healthy without it.
 *
 * WHICH variables carry the configuration is the policy's to say (SPEC.md §5.1
 * `channels.telegram.token_env` / `chat_id_env`, amended §5.2 by APRV-72), so
 * the already-computed policy load comes in and every message here names the
 * variable this operator's policy actually asked for. A policy that failed to
 * load names nothing and the reference defaults apply: doctor telling an
 * operator to set a variable their policy never mentions is the failure mode
 * this parameter removes.
 */
async function checkTelegram(apiBase: string, load: PolicyLoadResult): Promise<DoctorCheck> {
  const tokenEnv = telegramTokenEnvFor(load);
  const chatEnv = telegramChatEnvFor(load);
  const token = process.env[tokenEnv] ?? "";
  const chat = process.env[chatEnv] ?? "";

  if (token.length === 0 || chat.length === 0) {
    const missing = [
      token.length === 0 ? tokenEnv : null,
      chat.length === 0 ? chatEnv : null,
    ].filter((name): name is string => name !== null);
    return {
      check: "telegram",
      status: "skip",
      // A skip carries no `fix` — there is nothing wrong to repair — but a
      // reader who WANTED Telegram still needs the path out, so the detail ends
      // with it. (`approval setup channel telegram` is the verb; APRV-79 renamed it.)
      detail: `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} unset: the Telegram channel is not configured, which is a legitimate configuration and not a fault; run \`approval setup channel telegram\` to configure it`,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const base = apiBase.replace(/\/+$/u, "");
  try {
    const response = await fetch(`${base}/bot${token}/getMe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: controller.signal,
    });
    const raw = await response.text();
    let envelope: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        envelope = parsed as Record<string, unknown>;
      }
    } catch {
      /* handled below: a non-JSON body is not an ok envelope */
    }

    if (!response.ok || envelope["ok"] !== true) {
      const description = redact(String(envelope["description"] ?? "no description"), token);
      return {
        check: "telegram",
        status: "fail",
        detail: `getMe on ${base} was refused: HTTP ${response.status} (${description})`,
        fix:
          response.status === 401 || /unauthorized/iu.test(description)
            ? `approval setup channel telegram — the bot token is not valid; re-copy it from @BotFather into ${tokenEnv}`
            : `approval channel telegram health — the offline configuration report; then check ${tokenEnv} and that ${base} is the right Bot API base`,
      };
    }

    const result = (envelope["result"] ?? {}) as Record<string, unknown>;
    const username = typeof result["username"] === "string" ? `@${result["username"]}` : "unnamed";
    const id = result["id"] === undefined ? "unknown id" : `id ${String(result["id"])}`;
    return {
      check: "telegram",
      status: "pass",
      detail: `token valid: ${username} (${id}) via ${base}, chat ${chat}; no message was sent and no update was consumed`,
    };
  } catch (cause) {
    return {
      check: "telegram",
      status: "fail",
      detail: `getMe on ${base} failed: ${redact(detailOf(cause), token)}`,
      fix: `approval channel telegram health — the offline configuration report; then check network reachability of ${base} (and ${tokenEnv} if it is a TLS or auth failure)`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 6. web port
// ---------------------------------------------------------------------------

/**
 * Can the web channel's port be bound on loopback?
 *
 * A **held** port is a `pass`, not a failure, and the detail says why: the most
 * likely holder is this runtime's own `approval channel web`, and a doctor that
 * cried "broken" at a working channel would train operators to ignore it. Only
 * a bind error that means the configuration itself is wrong — `EACCES`, i.e. a
 * privileged port the runtime may not have — is a failure.
 *
 * The probe binds 127.0.0.1 only, never `0.0.0.0`: the web channel is
 * loopback-only, so testing a wider bind would answer a question nobody asked
 * and would briefly open a port to the network.
 */
async function checkWebPort(port: number): Promise<DoctorCheck> {
  return await new Promise<DoctorCheck>((resolve) => {
    const server = createServer();
    const settle = (check: DoctorCheck): void => {
      server.removeAllListeners();
      server.close(() => resolve(check));
    };
    server.once("error", (cause: NodeJS.ErrnoException) => {
      server.removeAllListeners();
      if (cause.code === "EADDRINUSE") {
        resolve({
          check: "web-port",
          status: "pass",
          detail: `127.0.0.1:${port} is already held — most likely this runtime's own \`approval channel web\`; nothing here connected to it`,
        });
        return;
      }
      if (cause.code === "EACCES") {
        resolve({
          check: "web-port",
          status: "fail",
          detail: `127.0.0.1:${port} cannot be bound: EACCES (a privileged port this process may not open)`,
          fix: "approval policy attest --as human:<id> — after setting channels.web.port in APPROVAL.md to a port above 1023 (an edited policy is inoperative until it is re-attested)",
        });
        return;
      }
      resolve({
        check: "web-port",
        status: "fail",
        detail: `127.0.0.1:${port} cannot be bound: ${detailOf(cause)}`,
        fix: "approval policy attest --as human:<id> — after setting a usable channels.web.port in APPROVAL.md (an edited policy is inoperative until it is re-attested)",
      });
    });
    server.once("listening", () => {
      settle({
        check: "web-port",
        status: "pass",
        detail: `127.0.0.1:${port} is free (bound and released; nothing was left listening)`,
      });
    });
    server.listen(port, "127.0.0.1");
  });
}

// ---------------------------------------------------------------------------
// 7. payload store
// ---------------------------------------------------------------------------

/** The sentence every verdict of this check carries. */
const PAYLOAD_STORE_WARNING =
  "the store holds the bytes approvals bind to, keyed by their hash, and it is the one cache that CANNOT be rebuilt from the log: the log records the binding, never the material, so payloads deleted from here are gone and their manual requests render payload-unavailable";

/**
 * Can the payload store be written?
 *
 * A store that does not exist yet is a `pass`: the directory is created by the
 * first request that carries `--payload`, and a repo that has not made one is
 * not broken. What is worth failing on is an existing directory this process
 * cannot write, because the failure surfaces at exactly the wrong moment: a
 * request already accepted by the gate refuses `payload-store-failed` mid
 * ceremony, and the operator reads it as the runtime refusing rather than as a
 * permission bit.
 *
 * The probe is a real create-and-remove in the store directory, not a `statSync`
 * mode test: mode bits do not answer the question on a read-only mount, under an
 * ACL, or in a container whose uid mapping differs from the one that made the
 * directory. Nothing is left behind, and no payload file is read, written or
 * verified here.
 */
function checkPayloadStore(logPath: string, records: EventRecord[]): DoctorCheck {
  const storeDir = payloadStoreDirFor(logPath);

  let stats;
  try {
    stats = statSync(storeDir);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        check: "payload-store",
        status: "pass",
        detail: `${storeDir} is not created until the first request --payload; ${PAYLOAD_STORE_WARNING}`,
      };
    }
    return {
      check: "payload-store",
      status: "fail",
      detail: `${storeDir} could not be stat'd: ${detailOf(cause)}; ${PAYLOAD_STORE_WARNING}`,
      fix: `chmod u+rwx ${storeDir} — make it readable and writable by the user running approval, and check its ownership`,
    };
  }

  if (!stats.isDirectory()) {
    return {
      check: "payload-store",
      status: "fail",
      detail: `${storeDir} exists and is not a directory, so no payload can be stored beside the log; ${PAYLOAD_STORE_WARNING}`,
      fix: `mv ${storeDir} ${storeDir}.aside — move whatever occupies the store's path out of the way (do not delete it until you know what it is), then re-run the request`,
    };
  }

  const probe = join(storeDir, `.doctor-write-probe-${String(process.pid)}`);
  try {
    const handle = openSync(probe, "wx");
    closeSync(handle);
  } catch (cause) {
    return {
      check: "payload-store",
      status: "fail",
      detail: `${storeDir} exists but is not writable (${detailOf(cause)}): a request carrying --payload will refuse payload-store-failed; ${PAYLOAD_STORE_WARNING}`,
      fix: `chmod u+w ${storeDir} — make it writable by the user running approval, and check its ownership`,
    };
  } finally {
    try {
      unlinkSync(probe);
    } catch {
      // The probe may never have been created; nothing to clean up.
    }
  }

  let files = 0;
  try {
    for (const entry of readdirSync(storeDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".json") && !entry.name.startsWith(".")) {
        files += 1;
      }
    }
  } catch {
    files = 0;
  }

  // What the log says about the store, beside what the store holds (APRV-41).
  // `pruned` is retention doing its job and leaving the evidence of the deletion
  // behind; `orphans` are files no record binds; `awaiting removal` are files the
  // log already says are gone, which the next daemon tick unlinks without
  // appending a second event.
  const census = payloadStoreCensus(records, storeDir);
  const residue =
    census.awaitingRemoval === 0
      ? ""
      : `, ${census.awaitingRemoval} already recorded as pruned and awaiting removal by the daemon`;

  return {
    check: "payload-store",
    status: "pass",
    detail: `${storeDir} is writable and holds ${files} payload file(s), ${census.pruned} pruned by the log, ${census.orphans} bound to no record${residue}; ${PAYLOAD_STORE_WARNING}`,
  };
}

// ---------------------------------------------------------------------------
// 7b. the verified-head snapshot (APRV-188)
// ---------------------------------------------------------------------------

/**
 * Is the daemon's verified-head snapshot present, and does it still cover the
 * log a hook would read?
 *
 * The snapshot is what lets a hook process re-prove a digest instead of
 * re-walking the chain, so its absence is a latency fact and never a
 * correctness one. That is why nothing here is a `fail` on the snapshot's own
 * account: every reader re-proves it, an unusable one is ignored, and a hook
 * behind an unusable snapshot behaves exactly as it did before APRV-188. The
 * row exists so an operator can see whether the acceleration is actually in
 * force, and so a snapshot that is somehow unreadable (a bad mode, a foreign
 * owner) is visible rather than silent.
 *
 * The one `fail` is a snapshot a reader would REFUSE for a reason the operator
 * should act on: permissions or ownership. A stale one is a `pass` that says so
 * — it endorses a shorter prefix, and the hook walks the tail.
 */
function checkVerifiedSnapshot(logPath: string): DoctorCheck {
  const path = snapshotPathFor(logPath);
  const read = snapshotSummary(logPath);
  if (!read.ok) {
    if (read.reason === "absent") {
      return {
        check: "verified-snapshot",
        status: "skip",
        detail: `no snapshot at ${path}; every hook invocation verifies the log from genesis. It is published by \`approval daemon run\`, so this is expected when the daemon has never run here.`,
      };
    }
    if (read.reason === "foreign-owner" || read.reason === "loose-permissions") {
      return {
        check: "verified-snapshot",
        status: "fail",
        detail: `${path} would be refused by every reader: ${read.detail}. Hooks fall back to a full chain walk, which is correct but slower.`,
        fix: `rm ${path} — remove it and let \`approval daemon run\` republish it as this user at mode 0600`,
      };
    }
    return {
      check: "verified-snapshot",
      status: "pass",
      detail: `${path} is present but not usable (${read.reason}: ${read.detail}); hooks verify the log from genesis, which is the behaviour without a snapshot at all.`,
    };
  }

  const raw = logBytes(logPath);
  if (raw === null) {
    return {
      check: "verified-snapshot",
      status: "pass",
      detail: `${path} endorses ${String(read.snapshot.lines)} record(s), and the log could not be read here to check it against.`,
    };
  }

  const admitted = admitSnapshot(logPath, raw, read.snapshot, undefined);
  if (!admitted.ok) {
    return {
      check: "verified-snapshot",
      status: "pass",
      detail: `${path} no longer applies to the log (${admitted.reason}: ${admitted.detail}); hooks verify from genesis until the daemon republishes it.`,
    };
  }

  const behind = raw.length - read.snapshot.byte_length;
  const currency =
    behind === 0
      ? "the whole log"
      : `all but the last ${String(behind)} byte(s), which a hook walks itself`;
  return {
    check: "verified-snapshot",
    status: "pass",
    detail: `${path} endorses ${currency}: ${String(read.snapshot.lines)} record(s) through seq ${String(read.snapshot.head.seq)}, published ${read.snapshot.verified_at}. A hook re-proves the digest rather than re-walking the chain.`,
  };
}

// ---------------------------------------------------------------------------
// 7d. the live draw (APRV-208)
// ---------------------------------------------------------------------------

/**
 * Is a daemon answering live draws for this log?
 *
 * The row exists because the difference it reports is invisible everywhere else
 * and expensive: with nothing answering, a class an operator declared
 * `supervised-live` at 0.1 is gated at 100% — safely, silently, and for as long
 * as nobody notices, which is the state APRV-184 found this repository in for a
 * fortnight. "Every policy edit asks for a tap" and "one in ten policy edits
 * asks for a tap" look identical from inside the policy file.
 *
 * `skip` when the policy declares no `supervised-live` class: there is nothing
 * to draw, and a row announcing a missing socket for a feature nobody uses is
 * noise. Otherwise `pass` with the socket, or `fail` — this row's one `fail` —
 * when a live class is declared and no usable socket is there, because that IS
 * the operator's control not being in force.
 *
 * ## Why it connects (APRV-282)
 *
 * It used to `stat` the socket and stop there, and on 2026-09-05 that read a
 * socket file left behind by a daemon that had exited as a healthy gate: the
 * row was green while every tap on the operator's phone sat unconsumed. A
 * socket file is created by a bind and removed by an orderly shutdown, so the
 * one state its presence cannot report is the one that matters — a process that
 * died. PRESENCE PROVES NOTHING. So the row opens a connection and closes it
 * again, which is the first thing an asker does and the first thing that fails.
 *
 * It still asks the daemon NOTHING: it sends no question, waits for no answer,
 * and hangs up the moment the connection is accepted. What it reports is what
 * an asker would conclude before it had said a word.
 */
async function checkLiveDraw(logPath: string, load: PolicyLoadResult): Promise<DoctorCheck> {
  const path = drawSocketPathFor(logPath);
  // The same helper the daemon's server asks, so this row and the process that
  // serves draws can never disagree about whether the file declares one.
  const liveClasses = load.ok ? liveClassesOf(load.policy) : [];
  if (liveClasses.length === 0) {
    return {
      check: "live-draw",
      status: "skip",
      detail: `this policy declares no supervised-live class, so no draw is ever made and ${path} is not needed.`,
    };
  }

  const declared = liveClasses.join(", ");
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return {
      check: "live-draw",
      status: "fail",
      detail: `no draw socket at ${path}, so every action of ${declared} gates to a human instead of being sampled: a gate process holds no sampling secret, and there is no daemon to ask.`,
      fix: 'eval "$(approval env)" && approval up — start the ambient runtime in a shell where the sampling secret resolves, so it can answer draws',
    };
  }
  const euid = typeof process.geteuid === "function" ? process.geteuid() : null;
  if (!stats.isSocket() || euid === null || stats.uid !== euid || (stats.mode & 0o077) !== 0) {
    return {
      check: "live-draw",
      status: "fail",
      detail: `${path} exists but every asker would refuse it (owner uid ${String(stats.uid)}, mode ${(stats.mode & 0o777).toString(8)}), so ${declared} gates to a human on every action.`,
      fix: "stop the daemon, remove the socket, and start it again as the user who owns this approval home",
    };
  }

  // The question a `stat` cannot answer: is anything on the other end?
  const dialled = await dialDrawSocket(path, null);
  if (!dialled.ok) {
    return {
      check: "live-draw",
      status: "fail",
      detail: oneLine(
        `${path} is on disk and refuses connections (${dialled.detail}). That is what a daemon killed rather than stopped leaves behind: the file was last written ${stats.mtime.toISOString()} and nothing has served it since. Every action of ${declared} gates to a human at 100% while this stands, and the file's presence says otherwise.`,
      ),
      fix: "approval up — start the ambient runtime again, in a shell where the sampling secret resolves; it clears the stale socket and binds a new one",
    };
  }
  return {
    check: "live-draw",
    status: "pass",
    detail: `${path} is owner-only and answered a connection, so a gate process with no sampling secret can have its draw answered and ${declared} is sampled at its declared rate rather than gated at 100%. The connection was opened and closed with no question asked.`,
  };
}

// ---------------------------------------------------------------------------
// 7d. the values block (APRV-238)
// ---------------------------------------------------------------------------

/**
 * Whether the optional values block of `APPROVAL.md` can be read.
 *
 * The row exists because nothing else would ever report a broken one. A values
 * block is guidance and not policy (SPEC.md §5.3, §11.1 invariant 10), so a
 * malformed one changes nothing about what the policy says and deliberately
 * does not appear in `approval policy check`, whose answer is the enforcement
 * trace. Left there, a typo in the block would silently mean the operator's
 * stated values reach no agent while every gate keeps working perfectly.
 *
 * Absence is a `pass` and says so in the words SPEC.md §5.3 fixes: a file with
 * no block is an operator who declared no values, which is a state and not a
 * fault. The only `fail` is a block that is present and unreadable, and its fix
 * names the code rather than proposing a repair, because what the block should
 * say is the human's to write.
 */
function checkValuesBlock(policyPath: string, policyFlagged: boolean, dir: string): DoctorCheck {
  const result = loadValues(policyFlagged ? { file: policyPath } : { dir });
  if (!result.ok) {
    if (result.code === "file-missing") {
      return {
        check: "values-block",
        status: "skip",
        detail: oneLine(
          `${result.message}, so there is no values block to read. The policy file's own absence is reported by the attestation row above.`,
        ),
      };
    }
    return {
      check: "values-block",
      status: "fail",
      detail: oneLine(
        `a \`\`\`${VALUES_INFO_STRING} block is present and could not be read (${result.code}): ${result.message}. Nothing about the policy changed — guidance is not enforcement — but the operator's stated values reach no agent until this parses.`,
      ),
      fix: `approval values --json — prints the same failure with its code (${result.code}); fix the block in ${result.source?.filename ?? "the policy file"} and re-attest, since the attestation digests the whole file`,
    };
  }
  if (!result.present) {
    return {
      check: "values-block",
      status: "pass",
      detail: `${result.source.filename}: no approval-values block; the operator has declared no values here. That is a declaration rather than a gap, and \`approval values\` says so in those words.`,
    };
  }
  const declared = (["love", "like", "dislike", "wants"] as const).filter(
    (key) => result.values[key] !== undefined,
  );
  const responds = result.values.responds === undefined ? "" : ", responds";
  return {
    check: "values-block",
    status: "pass",
    detail: `${result.source.filename}: the values block parses and validates (version ${String(
      result.values.version,
    )}; ${declared.length === 0 ? "no list" : declared.join(", ")}${responds}). It is guidance, so nothing here is enforced; read it with \`approval values\`.`,
  };
}

// ---------------------------------------------------------------------------
// 7c. the prefix proof long-lived readers run (APRV-217)
// ---------------------------------------------------------------------------

/**
 * Which prefix proof this policy configures for its long-lived readers.
 *
 * A configuration row, and only that. It reads the POLICY and never a running
 * daemon: the mode a process is actually using is on that process's own
 * `started` line, a daemon may have been launched with a flag that beat the
 * policy, and a doctor that reported a live process's memory would be reporting
 * something it cannot verify. Nothing here is ever a `fail` — both modes are
 * correct, they differ in what a repeat read re-proves and how often — and a
 * policy that declares no `daemon` block skips the row rather than announcing a
 * default nobody wrote.
 */
function checkReadProof(policyLoad: PolicyLoadResult): DoctorCheck {
  if (!policyLoad.ok) {
    return {
      check: "read-proof",
      status: "skip",
      detail: `the policy did not load (${policyLoad.code}), so no daemon read proof is configured; every reader proves the whole prefix on every read, which is the strict default. The policy failure itself is reported by \`approval policy check\`.`,
    };
  }
  const configured = policyLoad.daemon;
  if (!configured.declared) {
    return {
      check: "read-proof",
      status: "skip",
      detail: `${policyLoad.source.filename} declares no \`daemon\` block, so long-lived readers re-hash the whole verified prefix on every read (read_proof: full). That is the default and the strictest setting; \`daemon.read_proof: incremental\` trades it for a cadence-bounded proof of the appended bytes.`,
    };
  }
  if (configured.readProof === "full") {
    return {
      check: "read-proof",
      status: "pass",
      detail: `${policyLoad.source.filename} sets daemon.read_proof: full — every cached read re-hashes the whole verified prefix and compares the digest. One-shot processes and \`approval log verify\` do that regardless.`,
    };
  }
  return {
    check: "read-proof",
    status: "pass",
    detail: `${policyLoad.source.filename} sets daemon.read_proof: incremental — a long-lived reader hashes only the appended bytes, re-proving the whole prefix at least every ${String(
      configured.fullReproofEvery,
    )} read(s) or ${String(
      configured.fullReproofAfterMs,
    )} ms, whichever comes first, and after every append it makes. The Claude Code hook, \`approval log verify\` and \`approval doctor\` prove in full whatever this says.`,
  };
}

// ---------------------------------------------------------------------------
// 8. audit sampling
// ---------------------------------------------------------------------------

/**
 * Surface the sampler's state, because sampling fails open by design.
 *
 * SPEC.md §5.2: an unconfigured sampler is disabled with a machine-readable
 * reason rather than escalating everything (the only remaining seed would be
 * agent-authored event content, which §5.2 forbids). The human ruling that
 * accepted the fail-open pairs it with this check: doctor states the disabled
 * state and its reason prominently, so unconfigured-in-production cannot
 * persist unnoticed.
 *
 * Verdict mapping: a sampler the operator plainly chose not to have (no rate,
 * or rate 0) is `skip`, stated in full. A sampler that is half-configured or
 * unreadable (rate set but the secret unnamed or unset, an invalid rate, an
 * unloadable policy) is `fail` with a fix: someone intended sampling and is not
 * getting it.
 */
/**
 * The per-class half of the sampling report (amended SPEC.md §5.2, APRV-183).
 *
 * A rate that can differ per class makes "sampling is on" an incomplete answer:
 * an operator needs to know which classes sample, at which rate, and which
 * sample at nothing and why. Appended to the existing `audit-sampling` detail
 * rather than added as a check of its own, because it is the same fact about the
 * same control and a second check would let one of them go stale.
 */
function classDetail(load: PolicyLoadResult, sampler: Sampler): string {
  const entries = classSampling(load, sampler);
  if (entries.length === 0) return "";
  const rendered = entries.map((entry) =>
    entry.enabled
      ? `${entry.pattern} ${String(entry.rate)} (${entry.source})`
      : `${entry.pattern} none (${entry.reason ?? "rate-absent"})`,
  );
  return `; supervised classes: ${rendered.join(", ")}`;
}

/**
 * The half of the sampling report that this shell cannot answer (APRV-271).
 *
 * `secret-unset` means "the variable the policy names is not in MY
 * environment", and doctor's environment is almost never the one that matters.
 * The secret lives in the single terminal the operator ran `eval "$(approval
 * env)"` in and started the daemon from, and `core/child-env.ts` strips
 * `APPROVAL_*` from every child, so a doctor run from an agent session, a
 * different tab, or a hook could not see it even on a machine where sampling
 * has been running for a fortnight. That is what this row reported as a fault
 * on 2026-09-05, in red, beside a daemon banner confirming the secret in use.
 *
 * So the row asks the daemon, over the APRV-208 socket, and reports the answer
 * WITH ITS SOURCE. Three things bound what that is allowed to do:
 *
 * - **Only this branch.** `secret-unset` is the one disabled reason that is a
 *   fact about a process environment. `rate-absent`, `rate-invalid`,
 *   `rate-zero`, `secret-env-unnamed` and `policy-unreadable` are facts about
 *   the policy FILE, which doctor is reading for itself, and no daemon's answer
 *   may soften one of those.
 * - **Only an owner-only socket.** `askDaemonSampling` refuses a socket that is
 *   not owned by this euid or is reachable by group or other, and refuses an
 *   answer naming a pid that is gone.
 * - **Nothing is authorized either way.** The answer moves a diagnostic row and
 *   the exit code of a verb that appends nothing, sends nothing and repairs
 *   nothing. It reaches no gate, no budget and no log, so SPEC.md §11.1's rule
 *   that self-reported fields never reduce scrutiny is not in play: there is no
 *   scrutiny here to reduce, only a report to get right.
 */
async function samplingFromDaemon(
  logPath: string,
  sampler: Sampler,
): Promise<DoctorCheck | null> {
  if (sampler.enabled || sampler.reason !== "secret-unset") return null;
  const probe = await askDaemonSampling(logPath);
  const variable = sampler.secretEnv ?? "the sampling secret's variable";
  if (!probe.ok) {
    return {
      check: "audit-sampling",
      status: "fail",
      detail: oneLine(
        `disabled (${sampler.reason}): ${sampler.message} No daemon answered on ${probe.socket} (${probe.reason}), so this is what THIS shell can see and the daemon's shell is what decides: a daemon started where ${variable} resolves is sampling whatever this row says.`,
      ),
      fix: `approval setup sampling — or set it yourself: export ${variable} with the operator-held sampling secret in the environment that runs the daemon`,
    };
  }

  const report = probe.answer.sampling;
  const where = `the running daemon (pid ${String(probe.answer.daemon_pid)}, ${probe.socket})`;
  if (!report.enabled) {
    return {
      check: "audit-sampling",
      status: "fail",
      detail: oneLine(
        `disabled (${report.reason ?? "unstated"}) per ${where}, which is the process that decides: ${variable} is unset in this shell too, and the daemon reports its own sampler off. Nothing is sampled.`,
      ),
      fix: `approval setup sampling — or set it yourself: export ${variable} with the operator-held sampling secret in the environment that runs the daemon, then restart it`,
    };
  }
  const rate =
    report.rate === null
      ? "no global fallback rate: only classes declaring their own retro_rate are sampled"
      : `fallback rate ${String(report.rate)} from audit.supervised_sample_rate`;
  return {
    check: "audit-sampling",
    status: "pass",
    detail: oneLine(
      `enabled per ${where}; ${variable} is not exported in THIS shell, and the daemon's is the environment that decides. The value itself is never printed and never logged; ${rate}.`,
    ),
  };
}

/**
 * The per-class half of the report, said in DECLARED terms (APRV-271).
 *
 * {@link classDetail} renders what the LOCAL sampler puts in force, which on
 * this branch is nothing: the local reading is `secret-unset`, so every class
 * would come out as "none (secret-unset)" beside a sentence saying sampling is
 * enabled. The entries still carry each rule's own declared `retro_rate`, which
 * is a fact about the policy file and true whoever is holding the secret, so
 * they are rendered as declarations and a rule with no rate of its own is named
 * as taking the daemon's fallback.
 */
function declaredClassDetail(load: PolicyLoadResult, sampler: Sampler): string {
  const entries = classSampling(load, sampler);
  if (entries.length === 0) return "";
  const rendered = entries.map((entry) =>
    entry.rate === null
      ? `${entry.pattern} at the daemon's fallback rate`
      : `${entry.pattern} ${String(entry.rate)} (class)`,
  );
  return `; supervised classes, as the policy declares them: ${rendered.join(", ")}`;
}

function checkSamplingLocally(load: PolicyLoadResult): DoctorCheck {
  const sampler = resolveSampler(load);
  if (sampler.enabled) {
    const fallback =
      sampler.rate === null
        ? `no global fallback rate (${sampler.fallbackReason ?? "rate-absent"}): only classes declaring their own retro_rate are sampled`
        : `fallback rate ${String(sampler.rate)} from audit.supervised_sample_rate`;
    return {
      check: "audit-sampling",
      status: "pass",
      detail: `enabled at rate ${String(sampler.rate)}; secret read from $${sampler.secretEnv} (the value itself is never printed and never logged); ${fallback}${classDetail(load, sampler)}`,
    };
  }
  const deliberate = sampler.reason === "rate-absent" || sampler.reason === "rate-zero";
  if (deliberate) {
    return {
      check: "audit-sampling",
      status: "skip",
      detail: `disabled (${sampler.reason}): ${sampler.message}${classDetail(load, sampler)}`,
    };
  }
  return {
    check: "audit-sampling",
    status: "fail",
    detail: `disabled (${sampler.reason}): ${sampler.message}${classDetail(load, sampler)}`,
    fix:
      sampler.reason === "secret-unset" && sampler.secretEnv !== null
        ? `approval setup sampling — or set it yourself: export ${sampler.secretEnv} with the operator-held sampling secret in the environment that runs the daemon`
        : "approval policy attest --as human:<id> — after setting audit.supervised_sample_rate and audit.sampling_secret_env in the policy; then export the named variable where the daemon runs",
  };
}

/**
 * The row, from this shell first and from the daemon only where this shell
 * cannot be right (APRV-271).
 *
 * The local reading is computed regardless, so a daemon that answers nothing
 * leaves the row saying exactly what it said before, plus who could have
 * answered. There is no path on which the probe makes the report weaker.
 */
async function checkSampling(load: PolicyLoadResult, logPath: string): Promise<DoctorCheck> {
  const sampler = resolveSampler(load);
  const delegated = await samplingFromDaemon(logPath, sampler);
  if (delegated === null) return checkSamplingLocally(load);
  // The per-class breakdown is a fact about the policy file, so it belongs on
  // the row whichever process answered the environment half. It is said in
  // declared terms only where the daemon says sampling is on: everywhere else
  // the local reading IS what is in force, and the existing wording holds.
  const classes =
    delegated.status === "pass"
      ? declaredClassDetail(load, sampler)
      : classDetail(load, sampler);
  return { ...delegated, detail: `${delegated.detail}${classes}` };
}

// ---------------------------------------------------------------------------
// 12. reconciliation obligations (amended SPEC.md §5.2 — APRV-127)
// ---------------------------------------------------------------------------

/**
 * Is any retrospective denial still unreconciled?
 *
 * A denial cannot undo the action it denies. What it does is open an obligation,
 * and the obligation is worth nothing unless somebody is told about it — so
 * doctor FAILS while one is open, in the same voice it uses for a half-configured
 * sampler. This is the "loud" half of the design: a human said an action should
 * not have happened, and until a person records what was done about it, the
 * system has not responded to that at all.
 *
 * **It repairs nothing.** Satisfaction is human-only, in code and in the event
 * schema; a doctor that could close an obligation would be the runtime closing
 * its own homework. The `fix` is the command a person runs after they have
 * actually done the thing.
 */
function checkReconciliation(records: EventRecord[]): DoctorCheck {
  const open = openObligations(records);
  if (open.length === 0) {
    return {
      check: "reconciliation",
      status: "pass",
      detail: "no retrospective denial is waiting to be reconciled",
    };
  }
  const first = open[0] as (typeof open)[number];
  return {
    check: "reconciliation",
    status: "fail",
    detail: `${String(open.length)} unreconciled retrospective denial(s): ${open
      .map((item) => `seq ${String(item.seq)} ${item.actionKey} (${item.obligation})`)
      .join(", ")}. A denial cannot undo what already ran, so what it leaves is this obligation, and it stays open until a PERSON records what was done.`,
    fix: `approval audit obligations — then, once you have done it: approval audit reconcile ${String(first.seq)} --note "<what you did>"${
      first.obligation === "gated-revert" ? " --revert <action-key>" : ""
    }`,
  };
}

// ---------------------------------------------------------------------------
// 9. envelope integrity
// ---------------------------------------------------------------------------

/**
 * Which task files have lost the envelope the log says they had? (APRV-63)
 *
 * The failure this reports was observed live in APRV-60: a task-file rewrite by
 * a tool that did not know the `approval:` key dropped it. Nothing was corrupt,
 * nothing refused, and the loss was invisible until someone looked — which is
 * precisely the shape of question doctor exists to answer out loud.
 *
 * Log-derived in both directions. A file is only interesting when the *log*
 * holds a `task.registered` for its id; the file's own claims are read for one
 * thing, whether an `approval:` key is present, and trusted for nothing else. A
 * file with no frontmatter at all leaves no id, so its Backlog.md file name is
 * matched case-insensitively against registered ids — a way of asking the log a
 * question, never a way of deciding the answer.
 *
 * **It repairs nothing**, in the strong sense doctor means it: the registration
 * in the log holds every action the envelope declared, so a writer could re-emit
 * one, and doing so would make a projection into a source. The fix is a human
 * restoring the block by hand.
 */
function checkEnvelopeIntegrity(tasksDir: string, records: EventRecord[]): DoctorCheck {
  let entries;
  try {
    entries = readdirSync(tasksDir, { withFileTypes: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        check: "envelope-integrity",
        status: "skip",
        detail: `no task folder at ${tasksDir}, so no task file can be compared against the log (pass --tasks <dir> if your task files live elsewhere)`,
      };
    }
    return {
      check: "envelope-integrity",
      status: "fail",
      detail: `${tasksDir} could not be listed: ${detailOf(cause)}; whether any task lost its envelope is unknown`,
      fix: `chmod u+rx ${tasksDir} — make it readable by the user running approval, or point --tasks at the task folder`,
    };
  }

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();

  const lost: string[] = [];
  for (const name of files) {
    const read = readTaskFile(join(tasksDir, name));
    // Unreadable or unparseable frontmatter is the daemon's warning to raise,
    // not this check's verdict: the question here is only "is the envelope
    // gone", and a file nobody can parse has not answered it.
    if (read.ok && read.data["approval"] !== undefined) continue;
    if (!read.ok && read.code !== "no-frontmatter") continue;

    const declared = read.ok ? read.data["id"] : undefined;
    const hasId = typeof declared === "string" && declared.length > 0;
    const id = hasId ? declared : taskIdFromFileName(name);
    if (id === null) continue;
    const registration = latestRegistration(records, id, !hasId);
    if (registration === null) continue;
    lost.push(`${String(registration.task)} (${name}, registered at seq ${String(registration.seq)})`);
  }

  if (lost.length === 0) {
    return {
      check: "envelope-integrity",
      status: "pass",
      detail: `${String(files.length)} task file(s) in ${tasksDir}; every task the log has registered still carries its approval: envelope`,
    };
  }
  return {
    check: "envelope-integrity",
    status: "fail",
    detail: `${String(lost.length)} task(s) have log history and no envelope in their file: ${lost.join(
      "; ",
    )}. The log still holds every action they declared; the file does not.`,
    fix: "approval log tail — it shows the actions each registration declared. The envelope was removed by an external rewrite; restore it from the log by hand — see docs/dogfood-cutover.md (\"If an envelope goes missing\") and the APRV-60 record. Nothing here rewrites a task file: re-emitting the envelope from the log would turn a projection into a source.",
  };
}

// ---------------------------------------------------------------------------
// 10. vault
// ---------------------------------------------------------------------------

/** The exact line doctor tells an operator to add for the vault. */
const VAULT_IGNORE_LINE = ".approval/vault.enc";

/** The same, for the environment source map (APRV-75). */
const ENV_IGNORE_LINE = ".approval/env";

/**
 * Patterns in a `.gitignore` that cover one path under `.approval/`.
 *
 * A deliberately small, literal set rather than a gitignore engine. The two
 * error directions are not symmetric: a false PASS says a file holding
 * credentials is safe from a commit when it is not, and a false FAIL costs an
 * operator one glance at a fix line they can ignore. So only forms whose
 * meaning is unambiguous are accepted, and anything cleverer (a negation, a
 * nested `.gitignore`, a `core.excludesFile`) reads as "not covered here".
 *
 * Generalised from the vault's fixed list (APRV-68) when the env file arrived
 * (APRV-75), because the two questions are the same question: the bare basename
 * is included in both cases because a `.gitignore` pattern with no slash matches
 * at every level, so a line `vault.enc` — or `env` — does cover the file.
 */
function ignorePatternsFor(relative: string): readonly string[] {
  const base = relative.slice(relative.lastIndexOf("/") + 1);
  return [
    relative,
    `/${relative}`,
    ".approval/",
    "/.approval/",
    ".approval",
    "/.approval",
    ".approval/*",
    "/.approval/*",
    base,
    ...(relative.endsWith(".enc") ? ["*.enc"] : []),
  ];
}

type IgnoreVerdict = "ignored" | "not-ignored" | "not-a-repo";

/**
 * Is `relative` covered by the project's `.gitignore`?
 *
 * `not-a-repo` when `dir` holds no `.git` entry (a directory in a normal clone,
 * a file in a worktree or submodule): outside a repository there is nothing to
 * accidentally commit the file to, and failing a check about a risk that does
 * not exist trains people to ignore the check.
 */
function ignoreVerdict(dir: string, relative: string): IgnoreVerdict {
  try {
    statSync(join(dir, ".git"));
  } catch {
    return "not-a-repo";
  }
  let text: string;
  try {
    text = readFileSync(join(dir, ".gitignore"), "utf8");
  } catch {
    return "not-ignored";
  }
  const patterns = ignorePatternsFor(relative);
  for (const raw of text.split(/\r\n|\n|\r/u)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (patterns.includes(line)) return "ignored";
  }
  return "not-ignored";
}

/**
 * Can the credential vault be opened, and is it kept out of the repository?
 *
 * Three verdicts, in an order chosen for what stays wrong the longest:
 *
 * 1. **Not gitignored** is reported FIRST, ahead of any passphrase problem. A
 *    vault that is one `git add -A` from being published is the worse fault, it
 *    is silent, and it remains true after every other problem here is fixed. An
 *    encrypted file in a public repository is not a catastrophe, but it is a
 *    permanent offline-attack target against one human-chosen passphrase, and
 *    history is not something a later commit removes.
 * 2. **No passphrase, or it does not decrypt.** Both fail: the credentials are
 *    unreachable, so every adapter that needs one refuses at execution time,
 *    and that refusal reads as "the adapter is broken" rather than "this
 *    machine cannot open the vault". The fix names the variable.
 * 3. **Absent vault** is a SKIP with the consequence stated. Nobody has created
 *    one, which is a legitimate configuration — the same reading the Telegram
 *    check gives an unconfigured channel.
 *
 * The detail names the credential COUNT and never a name, never a value, and
 * the passphrase is read but never printed (SPEC.md §11.1 invariant 3).
 */
function checkVaultHealth(logPath: string, dir: string, load: PolicyLoadResult): DoctorCheck {
  const vaultPath = vaultPathFor(logPath);
  const passphraseEnv = passphraseEnvFor(load);

  if (!vaultExists(vaultPath)) {
    return {
      check: "vault",
      status: "skip",
      detail: `no credential vault at ${vaultPath}; adapters that need a credential will refuse credential-unavailable until one exists, which is a legitimate configuration for a runtime driven by \`approval run\` and the CLI channel. The passphrase would be read from $${passphraseEnv} (\`approval vault set <name>\` creates the file)`,
    };
  }

  const ignored = ignoreVerdict(dir, VAULT_IGNORE_LINE);
  if (ignored === "not-ignored") {
    return {
      check: "vault",
      status: "fail",
      detail: `${vaultPath} exists and is NOT gitignored in ${dir}: one \`git add -A\` publishes an encrypted credential file, and a commit is not something a later commit removes. The contents stay encrypted, but a published vault is a permanent offline-attack target against one human-chosen passphrase`,
      fix: `echo '${VAULT_IGNORE_LINE}' >> ${join(dir, ".gitignore")} — and if the file has already been committed, treat every credential in it as disclosed and rotate`,
    };
  }

  const passphrase = passphraseFrom(passphraseEnv);
  if (passphrase === null) {
    return {
      check: "vault",
      status: "fail",
      detail: `${vaultPath} exists and $${passphraseEnv} is unset or empty in this process, so no credential can be read: every adapter that needs one will refuse credential-unavailable, which reads like a broken adapter rather than an unopened vault`,
      fix: `approval setup vault — or set it yourself: export ${passphraseEnv} with the vault passphrase in the environment that runs the adapters (the policy names the variable, never the value; there is no --passphrase flag)`,
    };
  }

  const opened = checkVault(vaultPath, passphrase);
  if (!opened.ok) {
    return {
      check: "vault",
      status: "fail",
      detail: `${vaultPath} did not open (${opened.code}): ${opened.message}`,
      fix:
        opened.code === "vault-unreadable"
          ? `approval env --check — confirm value-free where $${passphraseEnv} is coming from, and that it is the passphrase this vault was created with; then check the file's provenance. A wrong passphrase and an altered file are ONE verdict on purpose, because distinguishing them would confirm a guessed passphrase against a file someone had modified`
          : `mv ${vaultPath} ${vaultPath}.unreadable — set it aside and inspect it by hand (do NOT delete it: it may be the only copy of a credential). It is not a vault this build can read, and nothing here rewrites it`,
    };
  }

  return {
    check: "vault",
    status: "pass",
    detail: `${vaultPath} opens with the passphrase in $${passphraseEnv} and holds ${String(opened.count)} credential(s)${ignored === "not-a-repo" ? "; no git repository at " + dir + ", so there is nothing here to commit it to" : ", and it is gitignored"}. No credential name or value is printed by this check`,
  };
}

// ---------------------------------------------------------------------------
// 11. environment (APRV-75)
// ---------------------------------------------------------------------------

/**
 * WHY DOCTOR DOES NOT RESOLVE KEYSTORE SOURCES.
 *
 * `resolveEnvironment` is called here exactly as `approval env --check` calls it
 * — same function, same policy load, same file path — so doctor and env cannot
 * disagree about what the environment IS. The one difference is this runner,
 * and it is a difference about what doctor is allowed to DO.
 *
 * `security find-generic-password -w` is not a read. On macOS it can raise a GUI
 * prompt: an item whose ACL does not already trust the calling binary produces
 * the "wants to access key … in your keychain" dialog, and a locked keychain
 * produces an unlock dialog. Both BLOCK the process until a human answers, and
 * both ask a human for a password. `secret-tool lookup` has the same shape
 * against a locked keyring. Neither is acceptable from a diagnostic: doctor is
 * the command an operator runs when something is already wrong, frequently over
 * ssh or from a CI job where no one will ever see the dialog, and a `doctor`
 * that hangs forever is worse than no doctor. It is also the wrong thing to
 * TEACH: a command that pops a keychain prompt trains people to click through
 * keychain prompts.
 *
 * So a keystore-backed variable is reported as DECLARED, never resolved, and the
 * report says which scheme and which service or label — facts `.approval/env`
 * already carries in the open. `approval env --check`, which the human runs
 * deliberately and watches, is the command that resolves them.
 *
 * This is not a general exception to doctor probing: the Telegram check does
 * make a network call. The line is that a probe may cost time and packets, and
 * may not block on a human or ask anyone for a password.
 *
 * The runner itself is `core/env-file.ts`'s {@link NON_RESOLVING_RUNNER} since
 * APRV-178, because `approval up`'s cross-instance report needs the same
 * refusal and two copies would be two sets of words for one rule.
 */

/** Was this variable left unresolved by {@link NON_RESOLVING_RUNNER}? */
function isDeferred(variable: ResolvedVariable): boolean {
  return (
    variable.refusal !== undefined &&
    variable.refusal.code === "helper-failed" &&
    variable.refusal.message.startsWith(KEYSTORE_DEFERRED)
  );
}

/**
 * The `approval setup <thing>` that knows a given variable, or `null`.
 *
 * Derived here from the names doctor already resolves rather than read off the
 * resolution, so that a fix line in this file is a fix line this file can be
 * read to verify. A name the policy invented under the `_env` convention maps to
 * nothing, and its repair is the generic one.
 */
function setupThingFor(name: string, load: PolicyLoadResult): string | null {
  if (name === HUMAN_ACTOR_ENV) return "identity";
  // Two words, because the verb is two words: SPEC.md §4 gives channels and
  // adapters separate setup nouns, and a fix line that printed the old
  // one-word spelling would be a command that exits 2 (APRV-79).
  if (name === telegramTokenEnvFor(load) || name === telegramChatEnvFor(load)) {
    return "channel telegram";
  }
  if (name === passphraseEnvFor(load)) return "vault";
  if (name === resolveSampler(load).secretEnv) return "sampling";
  return null;
}

/**
 * One variable, in words, with NO VALUE ON ANY PATH.
 *
 * `ResolvedVariable.value` is never read by this check — not to length-check it,
 * not to redact it. The fields consulted are `status`, `source`, `plaintext` and
 * `refusal`, and `source` is a scheme and a service label, which is what
 * `.approval/env` carries in the open (SPEC.md §11.1 invariant 3).
 */
function describeVariable(variable: ResolvedVariable): string {
  switch (variable.status) {
    case "set-in-environment":
      return "set in the environment";
    case "resolved-from-keychain":
    case "resolved-from-secret-service":
      return `resolved from ${variable.source}`;
    case "resolved-literal":
      return variable.plaintext
        ? `declared in ${ENV_IGNORE_LINE} as a PLAINTEXT literal`
        : `declared in ${ENV_IGNORE_LINE} as a literal`;
    case "unset":
      if (isDeferred(variable)) {
        return `declared in ${ENV_IGNORE_LINE} as ${variable.source} (${KEYSTORE_DEFERRED}; \`approval env --check\` resolves it)`;
      }
      if (variable.refusal !== undefined) {
        return `unresolved — ${variable.refusal.code}: ${variable.refusal.message}`;
      }
      if (variable.source.startsWith("env:")) {
        return `declared in ${ENV_IGNORE_LINE} as env: (inherited), and not set in this shell`;
      }
      return "unset";
  }
}

/**
 * Are the variables the policy NAMES actually going to be there? (APRV-75)
 *
 * The gap this closes: every check above reports on ONE variable at the moment
 * it needs it (identity, the sampling secret, the vault passphrase, the Telegram
 * pair), each in its own message, and nothing states the environment as a whole
 * or mentions `.approval/env` — the file SPEC.md §5.2 made the written-down
 * place for where those values come from. An operator whose file has the wrong
 * mode learns it one refusal at a time.
 *
 * ## The verdict rule, and why unset is a SKIP
 *
 * - **PASS** when every policy-named variable is set in this environment,
 *   resolved, or declared against a keystore (see {@link NON_RESOLVING_RUNNER}:
 *   declared-and-deferred counts as configured, because the operator wrote the
 *   line and only `approval env --check` may run the lookup).
 * - **FAIL** for something that is WRONG: a mode other than 0600, an unreadable
 *   or unparseable file, a secret-bearing variable sitting in the working tree
 *   as a plaintext literal, an env file a `git add -A` would commit, or a
 *   variable whose declared source refused for a real reason (a missing helper
 *   binary, an item that is not there, a policy `_env` key that is not a usable
 *   variable name).
 * - **SKIP**, naming the variables, when the only thing true is that some are
 *   unset. Unset is a STATE, exactly as an absent vault and an unconfigured
 *   Telegram are states, and each of those is a skip already. It is a real
 *   consideration that doctor runs in THIS shell and an unset variable here
 *   means the verbs run from here will refuse — but doctor is also run from a
 *   shell that never intends to grant anything, and a machine with no Telegram
 *   and no vault would then be permanently "unhealthy" for declining features it
 *   was never asked to have. The state is stated loudly instead, with the verb
 *   that gives the full table. The checks that DO fail on a specific unset
 *   variable are the ones that know it is needed: `identity` fails because
 *   human-only verbs refuse without it, `vault` fails only once a vault exists,
 *   and `audit-sampling` fails only once a rate has been configured.
 */
function checkEnvironment(logPath: string, dir: string, load: PolicyLoadResult): DoctorCheck {
  const envPath = envFilePathFor(logPath);
  const resolved = resolveEnvironment(load, envPath, NON_RESOLVING_RUNNER, process.env);

  if (!resolved.ok) {
    return {
      check: "environment",
      status: "fail",
      detail: `${resolved.path}: ${resolved.code}: ${oneLine(resolved.message)}`,
      fix:
        resolved.code === "env-file-mode"
          ? `chmod 600 ${resolved.path} — the file may carry a plaintext secret, so it is read only at mode 0600`
          : `approval env --check — the value-free report on this file; fix the line it names (nothing here rewrites it)`,
    };
  }

  const variables = resolved.variables;
  const table = variables
    .map((variable) => `${variable.name} ${describeVariable(variable)}`)
    .join("; ");
  const head = resolved.present
    ? `${resolved.path} (mode 0600, and no verb loads it implicitly: \`eval "$(approval env)"\` is how a human puts these in a shell)`
    : `${resolved.path} is absent, so every variable below is inherited from this shell or unset`;
  const preamble = `${head}. ${table}`;

  // Ordered by what stays wrong the longest, the same reading the vault check
  // uses: a file one `git add -A` from publication is the fault that survives
  // fixing everything else here.
  if (resolved.present && ignoreVerdict(dir, ENV_IGNORE_LINE) === "not-ignored") {
    return {
      check: "environment",
      status: "fail",
      detail: `${preamble}. The file is NOT gitignored in ${dir}: one \`git add -A\` commits it, and it is the file whose whole purpose is to say where credentials come from — a plaintext literal in it would be published outright, and even a keychain: line publishes the service names`,
      fix: `echo '${ENV_IGNORE_LINE}' >> ${join(dir, ".gitignore")} — and if the file has already been committed, treat anything literal in it as disclosed and rotate`,
    };
  }

  // A plaintext secret is REPORTED, never failed (APRV-76 review). SPEC §5.2
  // permits the literal form and `approval setup` itself writes one, behind a
  // typed "yes", on a machine with no keystore; a verdict that called setup's
  // own documented fallback wrong would have two verbs disagreeing about the
  // same line. So the state is a skip: prominent, named, with the upgrade in
  // the detail, and never a pass with a fix (passing checks carry none).
  const plaintext = variables.filter((variable) => variable.plaintext);
  if (plaintext.length > 0) {
    const thing = setupThingFor(plaintext[0]?.name ?? "", load);
    const upgrade =
      thing === null
        ? `move each one to \`<NAME>=keychain:<service>\` (macOS) or \`<NAME>=secret-service:<label>\` (Linux) in ${resolved.path}`
        : `run \`approval setup ${thing}\` on a machine with a keystore, or edit ${resolved.path} to \`<NAME>=keychain:<service>\` (macOS) / \`<NAME>=secret-service:<label>\` (Linux)`;
    return {
      check: "environment",
      status: "skip",
      detail: `${preamble}. ${plaintext.map((variable) => variable.name).join(", ")} ${plaintext.length === 1 ? "is a secret written" : "are secrets written"} literally into ${resolved.path}: permitted, and reported every time because the value sits in the working tree where a backup, an editor swap file or a stray \`git add -f\` reaches it; to stop seeing this, ${upgrade}`,
    };
  }

  const broken = variables.filter(
    (variable) => variable.refusal !== undefined && !isDeferred(variable),
  );
  const first = broken[0];
  if (first !== undefined) {
    const thing = setupThingFor(first.name, load);
    return {
      check: "environment",
      status: "fail",
      detail: `${preamble}. ${broken.map((variable) => variable.name).join(", ")} ${broken.length === 1 ? "declares a source that did not resolve" : "declare sources that did not resolve"}: a line was written for ${broken.length === 1 ? "it" : "them"}, so this is a configuration that is not working rather than one nobody made`,
      fix:
        first.refusal?.code === "invalid-variable-name"
          ? `approval policy attest --as human:<id> — after fixing the _env key in APPROVAL.md: ${JSON.stringify(first.name)} is not a usable shell variable name, so no export line is ever emitted for it`
          : thing === null
            ? `approval env --check — the full value-free report, with the helper's own reason for each variable`
            : `approval setup ${thing} — re-store the item the file names; \`approval env --check\` shows the helper's own reason`,
    };
  }

  const unset = variables.filter(
    (variable) => variable.status === "unset" && !isDeferred(variable),
  );
  if (unset.length > 0) {
    return {
      check: "environment",
      status: "skip",
      detail: `${preamble}. ${unset.map((variable) => variable.name).join(", ")} ${unset.length === 1 ? "is" : "are"} unset in this shell, which is a state and not a fault — but the verbs run from THIS shell will refuse anything that needs ${unset.length === 1 ? "it" : "them"}; run \`approval env --check\` for the full table, and \`eval "$(approval env)"\` once you have written the file`,
    };
  }

  return {
    check: "environment",
    status: "pass",
    detail: `${preamble}. Every variable your policy names is available to the verbs run from this shell. No value is printed by this check on any path`,
  };
}

/**
 * Whose credentials is this instance actually using? (APRV-178)
 *
 * The row this check exists to print did not exist on the morning a demo gate
 * in another directory stored its bot token under the same fixed keystore name
 * the production gate used, read the production token back, and put two long
 * pollers on one bot until a human's approval tap was delivered to the listener
 * that had not asked the question. Nothing on the machine could be asked "are
 * two instances sharing a credential"; the answer was assembled by hand,
 * afterwards.
 *
 * It resolves nothing (`core/instance.ts` calls the {@link NON_RESOLVING_RUNNER}
 * for exactly the reason the environment check does), reads no value, and
 * prints none: a scope suffix, an item name and a variable name are all the
 * evidence it needs, and all three are already in `.approval/env` in the open.
 *
 * ## The verdict rule
 *
 * - **FAIL** for an item whose scope suffix belongs to ANOTHER instance. That
 *   is two gates on one credential, and it is wrong rather than a state.
 * - **SKIP**, named and loud, for the unscoped legacy item and for a value that
 *   came from the ambient environment while the file names something else. Both
 *   are what a correct pre-APRV-178 machine looks like, and the primary gate on
 *   this project's own machine is fed exactly that way on purpose. A red row for
 *   every existing installation is a red row people learn to skip past.
 * - **PASS** when every line names this instance's own item.
 */
function checkKeychainScope(logPath: string, load: PolicyLoadResult): DoctorCheck {
  const findings = instanceFindings(logPath, load);
  const id = instanceIdFor(logPath);
  const head = `${instanceHomeFor(logPath)} is instance ${id}; its keystore items are named \`<secret>-${id}\``;

  const foreign = findings.filter((finding) => finding.kind === "foreign-instance");
  if (foreign.length > 0) {
    return {
      check: "keychain-scope",
      status: "fail",
      detail: `${head}. ${foreign.map((finding) => finding.detail).join("; ")}. Two instances resolving one item share a bot: both long-poll it, their getUpdates offsets acknowledge each other's messages, and an approval tap is answered by whichever listener asked first`,
      fix: `approval setup channel telegram — store this instance's own token under its own item; \`approval env --check\` shows which name each variable resolves through`,
    };
  }

  const shared = findings.filter((finding) => finding.kind === "legacy-shared");
  const bleed = findings.filter((finding) => finding.kind === "ambient-bleed");
  if (shared.length > 0 || bleed.length > 0) {
    return {
      check: "keychain-scope",
      status: "skip",
      detail: `${head}. ${[...shared, ...bleed].map((finding) => finding.detail).join("; ")}. Neither is broken here and both are how one instance becomes two instances' problem: re-run \`approval setup channel telegram\` to move onto this instance's own item, and \`unset\` an inherited variable before \`eval "$(approval env)"\` if the exported value is another gate's`,
    };
  }

  return {
    check: "keychain-scope",
    status: "pass",
    detail: `${head}, and every source ${envFilePathFor(logPath)} names is this instance's own. No value is read or printed by this check on any path`,
  };
}

// ---------------------------------------------------------------------------
// 12. log-drift (APRV-125)
// ---------------------------------------------------------------------------

/**
 * How the working log stands against the committed one.
 *
 * This is the doctor mitigation named in APRV-104's fork-2 notes: the fork that
 * incident produced was invisible until something tried to append onto it, and
 * the instrument a person reaches for first is `approval doctor`.
 *
 * Since APRV-219 the row IS `approval log verify --anchor`'s check
 * (`cli/log-anchor.ts`), rather than a second comparison written beside it. Two
 * implementations were two chances to disagree about whether a repository has
 * forked, and that is the one question where disagreement is intolerable — and
 * the disagreement duly arrived: APRV-210 recorded this row printing "this log
 * has never been committed" in a checkout where `git show HEAD:<log>` printed
 * the log, because it built its blob spec from an unresolved path. The anchor
 * check resolves that path through `git-scope.repoPath`, realpath on both
 * sides, and looks at every rev a committed copy may live at rather than only
 * `HEAD`.
 *
 * Reads only. It never fetches, never pulls and never writes: the committed
 * side comes out of git's object store with `git show`.
 */
function checkLogDrift(logPath: string, records: readonly EventRecord[]): DoctorCheck {
  const outcome = checkLogAnchor({ logPath, records });
  switch (outcome.status) {
    // A SKIP carries no `fix` — the rule every non-git fixture in
    // `tests/cli-doctor.test.ts` pins. A check that could not look has nothing
    // to prescribe, so what a reader might still want to run is said in the
    // detail. A pass that owes records keeps its `fix`, as this row always has.
    // The reason is carried through whole, `oneLine`d rather than trimmed. When
    // no rev resolved it now names the git command each candidate ran and what
    // git answered, and that is the half of the sentence a person acts on: the
    // row that misread a twelve-megabyte committed log said only which revs it
    // had tried, which is equally true of a repository that has genuinely never
    // committed one.
    case "skip":
      return {
        check: "log-drift",
        status: "skip",
        detail: oneLine(
          `${outcome.reason}. \`approval log advance --dry-run\` shows what a first advance would carry`,
        ),
      };
    case "pass":
      return {
        check: "log-drift",
        status: "pass",
        detail:
          outcome.ahead === 0
            ? outcome.detail
            : `${outcome.detail} — the ordinary state of a checkout that has been recording decisions`,
        ...(outcome.ahead === 0
          ? {}
          : { fix: "approval log advance — commit those records onto a records branch" }),
      };
    case "behind":
      return {
        check: "log-drift",
        status: "pass",
        detail: `${outcome.detail} — the committed copy carries records this working file does not`,
        fix: "approval log sync — fast-forward, then reconcile the chain",
      };
    case "diverged":
      return {
        check: "log-drift",
        status: "fail",
        detail: `${oneLine(
          outcome.message,
        )} Hash chains do not merge and nothing in this runtime will re-chain them: which of these is the log is a human decision`,
        fix: "approval log verify --anchor — then `git log -- .approval/log/events.jsonl` for who committed the other chain",
      };
  }
}

// ---------------------------------------------------------------------------
// 25. checkpoint (APRV-257)
// ---------------------------------------------------------------------------

/**
 * The second witness, as a row: how many checkpoints verify, how old the newest
 * one is against the cadence, and how many keys the policy declares.
 *
 * The row IS `core/checkpoint.ts`'s check, exactly as `log-drift` IS the anchor
 * check — the argument APRV-219 made and APRV-210 proved the hard way. Two
 * implementations of "does this log's own signature contradict it" would be two
 * chances to disagree about the one question where disagreement is intolerable.
 *
 * Three verdicts and no fourth:
 *
 * - **skip** when the policy declares no readable key. Nothing was verified,
 *   and a check that could not look must never report a pass. A skip carries no
 *   `fix` — the rule every non-git fixture in `tests/cli-doctor.test.ts` pins —
 *   so what to run is said in the detail.
 * - **fail** on any refusal. A checkpoint whose signature does not verify, or
 *   whose named hash is not the hash at that seq, is a human's key vouching for
 *   a chain this file does not carry. That is the finding this whole mechanism
 *   exists to produce, and doctor exits 1 on it.
 * - **pass** otherwise, INCLUDING when a checkpoint is due. The cadence carries
 *   a `fix` rather than a status: a person who has not signed recently is not
 *   evidence of tampering, and a doctor that went red because somebody was on
 *   holiday is a doctor whose red people stop reading.
 */
function checkCheckpoints(
  records: readonly EventRecord[],
  policy: { dir?: string; file?: string },
): DoctorCheck {
  const configured = checkpointPolicyOf(policy);
  const outcome = checkLogCheckpoints({
    records,
    publicKeys: configured.publicKeys,
    checkpointEveryMs: configured.checkpointEveryMs,
    keysUnavailable: configured.unloadable,
  });

  if (outcome.status === "skip") {
    return {
      check: "checkpoint",
      status: "skip",
      detail: `${outcome.reason}. \`approval setup checkpoint\` mints a key and prints the audit.checkpoint_keys block to add`,
    };
  }
  if (outcome.status === "refused") {
    return {
      check: "checkpoint",
      status: "fail",
      detail: `${oneLine(
        outcome.message,
      )} A key no agent process holds signed a head this chain does not carry: the chain was rewritten after the checkpoint was taken`,
      fix: "approval log verify --checkpoints — then `git log -- .approval/log/events.jsonl` for who wrote the other chain",
    };
  }

  const newest = outcome.checkpoints[outcome.checkpoints.length - 1];
  const detail =
    `${outcome.detail}, ${String(configured.publicKeys.length)} key(s) declared` +
    (newest === undefined ? "" : ` (newest at seq ${String(newest.at)}, ${newest.ts})`) +
    (outcome.unchecked === 0
      ? ""
      : `; ${String(outcome.unchecked)} signed a seq below this range`);

  return {
    check: "checkpoint",
    status: "pass",
    detail: outcome.warning === null ? detail : `${detail} — ${oneLine(outcome.warning)}`,
    ...(outcome.warning === null
      ? {}
      : {
          fix: "approval log checkpoint --as human:<id> — or answer the CHECKPOINT DUE prompt on your channel",
        }),
  };
}

// ---------------------------------------------------------------------------
// 13. log-advance-cadence (APRV-204)
// ---------------------------------------------------------------------------

/**
 * How far the log has run ahead of any records branch, and how the daemon's
 * last advance ended.
 *
 * This is the status surface the cadence needed and `approval daemon` did not
 * have. There is no `approval daemon status` subcommand and no status file: the
 * daemon reports live on its own event stream, which is gone the moment nobody
 * is tailing it, and a status file would be a second copy of facts the log
 * already carries. So the answer is read from the log itself (the advance
 * cycles the daemon registers under `daemon-advance-*`) plus git's local refs,
 * which is why it can be answered by a DIFFERENT process from the one that made
 * the attempt, and why an operator gets the same answer whether or not a daemon
 * is running at all.
 *
 * Reads only, and never fetches: the same rule `log-drift` holds itself to.
 * Advisory rather than failing — records waiting to be published is the normal
 * state of a checkout that has been recording decisions, and only the reader
 * knows how long is too long.
 */
function checkAdvanceCadence(logPath: string, records: readonly EventRecord[]): DoctorCheck {
  const check = "log-advance-cadence";
  const root = repoRoot(dirname(logPath));
  if (root === null) {
    return {
      check,
      status: "skip",
      detail: `${logPath} is not inside a git repository, so there is no records branch for anything to be waiting for`,
    };
  }

  const today = new Date().toISOString();
  const state = publishedState(root, logPath, records, { remote: "origin", base: null }, today);
  const last = lastAdvance(records);
  // The reason, when the log carries one (APRV-211). A failed advance used to
  // reach this row as the bare word `failed`, which told an operator that
  // something had gone wrong and nothing about what: the daemon knew, said it
  // once on an event stream nobody was tailing, and recorded `exit_code: 1`.
  // The verb's own code and message now travel onto `execution.failed`, so this
  // row says them. A cycle recorded before the field existed still reads `null`
  // and still prints the bare outcome; the shape is not assumed away.
  const why =
    last === null || last.code === null
      ? ""
      : ` (${last.code}${last.message === null ? "" : `: ${last.message}`})`;
  const attempt =
    last === null
      ? "no daemon advance cycle is in this log yet (the cadence is opt-in: `approval daemon run --advance`)"
      : `the last daemon advance (through seq ${String(last.toSeq)}, ${last.ts}) ended ${last.outcome}${why}`;

  // Which ref the count came from (APRV-210). A row that says "9,875 records
  // are not yet on a records branch" is unreadable without it: a rev that
  // resolved to nothing and a rev that carried nothing produce the same number
  // and are completely different facts, and this row reported the first as the
  // second on a log whose first 8,379 records had been merged to the trunk an
  // hour earlier.
  const from =
    state.publishedRev === null
      ? `no rev this checkout can see carries a copy of this chain (tried ${state.revs.join(", ")})`
      : `read from ${state.publishedRev}`;

  // APRV-264. The advance cycles nobody closed, and what this checkout can
  // prove about each. They belong on THIS row rather than only in `status`'s
  // dangling list, because their effect is on the cadence: while one stands the
  // daemon authorizes no further advance, so a row reporting how far behind the
  // records branch is without saying that the thing that publishes it is
  // blocked reports the symptom and hides the cause. Provable ones are named as
  // the daemon's to close on its next tick; the rest are a person's, with the
  // one command that takes them all.
  const open = proveDanglingAdvances(records, state);
  const outstanding = open.filter((entry) => entry.provenBy === null);
  const provable = open.filter((entry) => entry.provenBy !== null);
  const blocked =
    open.length === 0
      ? ""
      : ` ${String(open.length)} advance execution(s) are open and no further advance is authorized while they stand: ${open
          .map(
            (entry) =>
              `${entry.actionKey} (${
                entry.provenBy === null
                  ? "nothing in this checkout carries the seq it named"
                  : `proved by ${entry.provenBy}`
              })`,
          )
          .join(", ")}.${
          provable.length === 0
            ? ""
            : ` A running daemon closes ${String(provable.length)} of them on its next tick.`
        }`;
  const sweepFix =
    outstanding.length === 0
      ? null
      : `${RESOLVE_DANGLING_COMMAND} — close the advance executions this checkout can prove and list the ${String(
          outstanding.length,
        )} it cannot`;

  if (state.pending === 0) {
    return {
      check,
      status: "pass",
      detail: `every record through seq ${String(
        state.publishedSeq,
      )} is on a records branch or the trunk (${from}); ${attempt}${blocked}`,
      ...(sweepFix === null ? {} : { fix: sweepFix }),
    };
  }
  return {
    check,
    status: "pass",
    detail: `${String(state.pending)} record(s) are not yet on a records branch (${String(
      state.substantive,
    )} of them are not the daemon's own advance bookkeeping); published through seq ${String(
      state.publishedSeq,
    )} (${from}), working head seq ${String(state.workingSeq)}. ${attempt}${blocked}`,
    fix:
      sweepFix ??
      "approval log advance --pr — publish them now, or run the daemon with --advance",
  };
}

// ---------------------------------------------------------------------------
// harness hook outcome reporting (APRV-145)
// ---------------------------------------------------------------------------

/** Where Claude Code keeps the hook registration a human commits. */
const CLAUDE_SETTINGS = join(".claude", "settings.json");

/** Does any `hooks.<event>` entry run this CLI's harness hook? */
function registersApprovalHook(hooks: unknown, event: string): boolean {
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) return false;
  const matchers = (hooks as Record<string, unknown>)[event];
  if (!Array.isArray(matchers)) return false;
  for (const matcher of matchers) {
    if (typeof matcher !== "object" || matcher === null) continue;
    const entries = (matcher as Record<string, unknown>)["hooks"];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const command = (entry as Record<string, unknown>)["command"];
      if (typeof command === "string" && /\bapproval hook\b/u.test(command)) return true;
    }
  }
  return false;
}

/**
 * Is the harness registered for the event that reports outcomes (APRV-145)?
 *
 * The configuration this exists to name is the one in which loop escalation
 * cannot accrue AT ALL: the pre-execution hook registered and the post-execution
 * one not, so every tool call opens a delegated `execution.started` that nothing
 * ever closes, the harness streaks of amended SPEC.md §10.2 hold at zero, and
 * the guard reads as passing because there is nothing for it to see. That is a
 * silent control, which is worse than an absent one.
 *
 * Doctor READS this file and never writes it. `.claude/settings.json` is
 * `policy.core` in this taxonomy — a file that configures the gate is part of
 * the gate — so the repair is a line for a human to commit, printed by
 * `approval instructions hook`.
 */
function checkHarnessOutcomes(dir: string): DoctorCheck {
  const check = "harness-hook-outcomes";
  const path = join(dir, CLAUDE_SETTINGS);
  if (!existsSync(path)) {
    return {
      check,
      status: "skip",
      detail: `no ${CLAUDE_SETTINGS} in ${dir}: this checkout does not run a Claude Code harness hook`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (cause) {
    return {
      check,
      status: "skip",
      detail: `${path} is not readable as JSON (${detailOf(cause)}), so which hooks it registers cannot be established here`,
    };
  }
  const hooks =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)["hooks"]
      : null;
  const pre = registersApprovalHook(hooks, "PreToolUse");
  const post =
    registersApprovalHook(hooks, "PostToolUse") ||
    registersApprovalHook(hooks, "PostToolUseFailure");
  if (!pre && !post) {
    return {
      check,
      status: "skip",
      detail: `${path} registers no \`approval hook\` entry, so this checkout is not gated by the harness hook at all`,
    };
  }
  if (!post) {
    return {
      check,
      status: "fail",
      detail: `${path} registers \`approval hook\` for PreToolUse and not for PostToolUse, so no tool call ever reports an outcome: every harness execution.started stays delegated, and the loop escalation of SPEC.md §10.2 cannot accrue on this path`,
      fix: "approval hook claude-code --help — prints the PostToolUse entry to add, which a human commits (.claude/settings.json is policy.core)",
    };
  }
  return {
    check,
    status: "pass",
    detail: `${path} registers \`approval hook\` for the ${pre ? "pre-execution and " : ""}post-execution event, so tool call outcomes reach the log and loop escalation can accrue`,
  };
}

// ---------------------------------------------------------------------------
// harness hook wiring in THIS worktree (APRV-151)
// ---------------------------------------------------------------------------

/** The tool names a protected-path write can arrive as. */
const GATED_TOOLS: readonly string[] = ["Edit", "Write", "Bash"];

/** The `matcher` strings of every `approval hook` entry registered for `event`. */
function approvalHookMatchers(hooks: unknown, event: string): string[] {
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) return [];
  const matchers = (hooks as Record<string, unknown>)[event];
  if (!Array.isArray(matchers)) return [];
  const found: string[] = [];
  for (const matcher of matchers) {
    if (typeof matcher !== "object" || matcher === null) continue;
    const entries = (matcher as Record<string, unknown>)["hooks"];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const command = (entry as Record<string, unknown>)["command"];
      if (typeof command !== "string" || !/\bapproval hook\b/u.test(command)) continue;
      const pattern = (matcher as Record<string, unknown>)["matcher"];
      found.push(typeof pattern === "string" ? pattern : "");
    }
  }
  return found;
}

/**
 * Does the settings file THIS worktree carries register the pre-execution hook
 * for the tools a protected-path write arrives through? (APRV-151.)
 *
 * The incidents this row exists for are two file-tool Edits to protected paths
 * that applied in spawned-agent worktrees with no prompt, no denial, and no
 * refused-request record — the hook never ran, and nothing anywhere said so.
 * A session cannot be asked whether it is hooked (a party under oversight does
 * not report its own oversight, SPEC.md §11), so this row reports only the one
 * thing a process CAN establish about itself from disk: whether the settings
 * file in this checkout carries the entry at all.
 *
 * Read the `pass` wording carefully, because the limit is the point. The entry
 * being on disk is NOT proof the session loaded it: `.claude/settings.json` is
 * git-tracked here, so every worktree has an identical copy, and both bypasses
 * happened in worktrees whose copy was present and correct. What actually
 * differs between a gated and an ungated session is whether the harness
 * resolved and trusted this file when the session started, which is state this
 * runtime cannot see. That is exactly why the deterministic backstop is
 * CI-side, over the committed log, in `core/protected-path-guard.ts`: it does
 * not trust session wiring, and this row does not claim to establish it.
 *
 * Advisory, so it never fails the run. Doctor reads and never writes; the file
 * is `policy.edit` and its repair is a line for a human to commit.
 */
function checkHarnessWiring(dir: string): DoctorCheck {
  const check = "harness-hook-wiring";
  const root = repoRoot(dir);
  const where = root === null ? dir : root;
  const path = join(where, CLAUDE_SETTINGS);
  const scope =
    root === null
      ? `${dir} (git could not say what checkout this is)`
      : root === dir
        ? root
        : `${root}, the checkout root above ${dir}`;

  if (!existsSync(path)) {
    return {
      check,
      status: "skip",
      // No `fix`, deliberately: a checkout that is not a Claude Code checkout
      // at all owes no repair, exactly as `harness-hook-outcomes` treats the
      // same absence. The two branches below DO carry one, because there the
      // harness is present and the entry is what is missing.
      detail: `NOT WIRED: ${scope} carries no ${CLAUDE_SETTINGS}, so nothing in this worktree registers the pre-execution hook and a protected-path Edit here would apply unclassified. A session started elsewhere may still be hooked; this row can only see this checkout.`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (cause) {
    return {
      check,
      status: "skip",
      detail: `UNDETERMINABLE: ${path} exists and is not readable as JSON (${detailOf(cause)}), so whether this checkout registers the pre-execution hook cannot be established here.`,
    };
  }

  const hooks =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)["hooks"]
      : null;
  const matchers = approvalHookMatchers(hooks, "PreToolUse");
  if (matchers.length === 0) {
    return {
      check,
      status: "skip",
      detail: `NOT WIRED: ${path} registers no \`approval hook\` entry for PreToolUse, so a protected-path Edit, Write or Bash call in this checkout reaches the file system unclassified.`,
      fix: "approval instructions hook — prints the PreToolUse entry a human commits",
    };
  }

  const covered = GATED_TOOLS.filter((tool) =>
    matchers.some((pattern) => pattern.length === 0 || pattern.split("|").includes(tool)),
  );
  const missing = GATED_TOOLS.filter((tool) => !covered.includes(tool));
  if (missing.length > 0) {
    return {
      check,
      status: "skip",
      detail: `NOT WIRED for every tool: ${path} registers \`approval hook\` for PreToolUse with matcher ${JSON.stringify(matchers.join(", "))}, which does not cover ${missing.join(", ")}. A protected-path write arriving through ${missing[0]} is never classified.`,
      fix: "approval instructions hook — prints the PreToolUse entry a human commits",
    };
  }

  return {
    check,
    status: "pass",
    detail: `WIRED on disk: ${path} registers \`approval hook\` for PreToolUse over ${GATED_TOOLS.join(", ")}. This is the file being present, NOT proof this session loaded it — the APRV-151 bypasses happened in worktrees carrying exactly this entry. The check that does not trust session wiring is the CI-side grant cross-check over the committed log, which asks whether the CHANGE was granted rather than whether the path ever was (APRV-202).`,
  };
}

// ---------------------------------------------------------------------------
// harness version provenance (APRV-227)
// ---------------------------------------------------------------------------

/** The Cursor counterpart of {@link CLAUDE_SETTINGS}. */
const CURSOR_HOOKS = join(".cursor", "hooks.json");

/** Where a harness hook registration can be written, one file per harness. */
const HARNESS_SETTINGS: readonly string[] = [CLAUDE_SETTINGS, CURSOR_HOOKS];

/** `approval hook <kind>` inside a command string, whichever file shape holds it. */
const HOOK_COMMAND = /\bapproval\s+hook\s+(claude-code|cursor)\b/u;

/**
 * Every harness this checkout registers an `approval hook` command for.
 *
 * Shape-agnostic on purpose: `.claude/settings.json` nests the command under
 * `hooks.PreToolUse[].hooks[].command` and `.cursor/hooks.json` under
 * `hooks.preToolUse[].command`, and a third harness would nest it somewhere
 * else again. What all of them have in common is a STRING somewhere in the
 * document that invokes this CLI, so the document is parsed as JSON (a file
 * that is not JSON registers nothing this can read) and its string leaves are
 * searched. The row this feeds can only SKIP when the answer is empty, so a
 * miss costs a skip and never a false red.
 */
function registeredHarnesses(dir: string): HarnessKind[] {
  const found = new Set<HarnessKind>();
  for (const relative of HARNESS_SETTINGS) {
    const path = join(dir, relative);
    if (!existsSync(path)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch {
      continue;
    }
    const stack: unknown[] = [parsed];
    while (stack.length > 0) {
      const node = stack.pop();
      if (typeof node === "string") {
        const match = HOOK_COMMAND.exec(node);
        if (match !== null && isHarnessKind(match[1])) found.add(match[1]);
        continue;
      }
      if (Array.isArray(node)) {
        stack.push(...node);
        continue;
      }
      if (typeof node === "object" && node !== null) {
        stack.push(...Object.values(node as Record<string, unknown>));
      }
    }
  }
  return HARNESS_KINDS.filter((kind) => found.has(kind));
}

/**
 * The last version each harness recorded, from the records the hook writes.
 *
 * Latest wins: the log is append-only and ordered, so the newest record naming
 * a harness is the newest statement about that binary. Only `task.registered`
 * and `gate.bypassed` are consulted, because those are the two the hook stamps
 * (APRV-227); the pair appearing on any other event type was not written by the
 * surface this row reports on and is ignored rather than trusted.
 */
function recordedHarnessVersions(
  records: readonly EventRecord[],
): Map<HarnessKind, { version: string; seq: number }> {
  const latest = new Map<HarnessKind, { version: string; seq: number }>();
  for (const record of records) {
    if (record.event !== "task.registered" && record.event !== "gate.bypassed") continue;
    const provenance = readHarnessProvenance(record.payload);
    if (provenance === null) continue;
    latest.set(provenance.harness, {
      version: provenance.harness_version,
      seq: record.seq,
    });
  }
  return latest;
}

/**
 * Has the harness binary changed under the hook since the log last saw it?
 *
 * ## What this row is for
 *
 * A harness upgrade swaps the binary that hosts the PreToolUse hook, and it
 * happens on a human's own machine, unattended, at whatever hour an updater
 * runs. A release can change the hook envelope semantics; the gate then answers
 * a protocol nobody is speaking any more and the tool calls go through
 * unclassified. Nothing in the log would say so, because the thing that changed
 * is outside the log entirely.
 *
 * So this row compares the two facts it can actually establish: what
 * `<binary> --version` says now, and what the last hook-written record says the
 * binary was. A difference is not evidence of a fault, since most upgrades are
 * fine. It is evidence that the gate has not been exercised since the binary
 * changed, and the remedy is to exercise it. The self-test in
 * `docs/claude-code-hook.md` does that and costs nobody a prompt.
 *
 * ## Why it fails rather than warns
 *
 * The reason `dark-sessions` fails. A row in the pass column would be saying
 * "the gate may or may not still fire and I am content", and the whole content
 * of an unverified change is that nobody has checked. It clears the moment one
 * record is written under the new binary, which is a cheap and bounded remedy,
 * and that is what makes a red row here honest rather than nagging.
 *
 * ## What it will not claim
 *
 * A recorded version is SELF-REPORTED (SPEC.md §11.1 invariant 4), so this row
 * is careful about the direction it can move. A match ADDS nothing: not proof
 * the hook fired, not proof the harness is honest, and no substitute for
 * `harness-hook-wiring` or the CI-side guard. A mismatch is the only thing it
 * asserts, and all it asserts about one is that a human should run the
 * self-test. Nothing anywhere reads the field as an input to a verdict, a
 * floor, a budget, a streak or a sampling draw.
 *
 * Three skips, each with its reason in the detail: no harness hook registered
 * in this checkout; no hook-written record naming that harness yet (a fresh log
 * has nothing to compare against, and inventing a baseline would be inventing
 * the fact); and no such binary on PATH, since doctor may be running somewhere
 * the harness is not installed, which is a state and not a fault.
 */
function checkHarnessVersion(dir: string, records: readonly EventRecord[]): DoctorCheck {
  const check = "harness-version-unverified";
  const root = repoRoot(dir);
  const where = root === null ? dir : root;
  const kinds = registeredHarnesses(where);
  if (kinds.length === 0) {
    return {
      check,
      status: "skip",
      detail: `${where} registers no \`approval hook\` command in ${HARNESS_SETTINGS.join(" or ")}, so no harness hosts the hook here and there is no installed version for the log to be behind`,
    };
  }

  const recorded = recordedHarnessVersions(records);
  const mismatched: string[] = [];
  const matched: string[] = [];
  const unknown: string[] = [];

  for (const kind of kinds) {
    const last = recorded.get(kind);
    if (last === undefined) {
      unknown.push(
        `${kind}: no hook-written task.registered or gate.bypassed names a version yet, so there is no baseline to compare against`,
      );
      continue;
    }
    const installed = installedHarnessVersion(kind);
    if (installed === null) {
      unknown.push(
        `${kind}: \`${HARNESS_BINARY[kind]} --version\` gave no usable answer here (not on PATH, a non-zero exit, or output this runtime will not record), so what is installed cannot be established; the log last saw ${JSON.stringify(last.version)} at seq ${String(last.seq)}`,
      );
      continue;
    }
    if (installed === last.version) {
      matched.push(
        `${kind} ${JSON.stringify(installed)} matches the version on the hook record at seq ${String(last.seq)}`,
      );
      continue;
    }
    mismatched.push(
      `${kind} is installed at ${JSON.stringify(installed)} and the last hook-written record (seq ${String(last.seq)}) was issued by ${JSON.stringify(last.version)}`,
    );
  }

  if (mismatched.length > 0) {
    const first = kinds[0] as HarnessKind;
    return {
      check,
      status: "fail",
      detail: `the harness binary changed and the gate has not been exercised since: ${mismatched.join("; ")}. A release can change the hook envelope semantics, so until one record is written under the new binary nothing here shows the hook still fires. The recorded version is self-reported and reduces nothing: a match would not have proved the hook fired either, and what a mismatch says is that nobody has looked.`,
      fix: `approval hook ${first} --dir ${where} < one PreToolUse event for a supervised-class command — the self-test in docs/${first === "cursor" ? "cursor" : "claude-code"}-hook.md. It prompts nobody and writes one task.registered carrying the installed version.`,
    };
  }
  if (matched.length > 0) {
    return {
      check,
      status: "pass",
      detail: `${matched.join("; ")}${unknown.length === 0 ? "" : `; ${unknown.join("; ")}`}. A match is not proof the hook fired; it is the absence of the one thing this row can see, an unverified change of the binary hosting it.`,
    };
  }
  return {
    check,
    status: "skip",
    detail: `${where} registers ${kinds.join(", ")} and no comparison could be made: ${unknown.join("; ")}`,
  };
}

// ---------------------------------------------------------------------------
// dark sessions (APRV-192)
// ---------------------------------------------------------------------------

/**
 * Does the git activity in this checkout have log records beside it?
 *
 * The detective complement to `harness-hook-wiring` above. That row reports
 * whether the settings file is on disk and says plainly that this is not proof
 * a session loaded it; this row asks the question that does not depend on
 * session wiring at all — git shows commits and worktrees, and the log either
 * carries records beside them or it does not.
 *
 * Reads only. Doctor never appends, so a dark subject found HERE is reported
 * and not recorded: the record is the daemon's, written by the sweep it runs on
 * its own cadence (`approval daemon run --dark-sessions`). Two processes
 * appending the same observation would be two writers to one fact, and doctor
 * is a reader.
 *
 * This row DOES fail the run, which is where it parts company with
 * `harness-hook-wiring` above. That row reports a configuration, and a
 * configuration this runtime cannot verify from disk is not a health verdict.
 * This one reports an EVENT: work was done in this repository and the log was
 * not told. "Never silently tolerate it" is the whole of APRV-192, and a row
 * that reported a dark session in the pass column would be tolerating it
 * quietly in the one place an operator goes to ask whether anything is wrong.
 *
 * An `undetermined` subject is a skip, not a fail, for the reason the daemon
 * appends nothing for one: what the detector could not see is a gap in the
 * instrument, and a red row for it would train an operator to ignore red rows.
 * The gap is named in the detail, never folded into a pass.
 */
function checkDarkSessions(
  logPath: string,
  dir: string,
  policyPath: string,
  records: readonly EventRecord[],
  verified: boolean,
): DoctorCheck {
  const check = "dark-sessions";
  const root = repoRoot(dir);
  if (root === null) {
    return {
      check,
      status: "skip",
      detail: `${dir} is not inside a git repository, so there is no git activity for the log to owe records against`,
    };
  }

  // `reportDarkSessions`, never `sweepDarkSessions`: the read-only half of the
  // same code, so doctor and the daemon reach identical verdicts and only the
  // daemon writes them down.
  const { report } = reportDarkSessions({
    logPath,
    root,
    policy: { file: policyPath },
    windowMs: DEFAULT_DARK_WINDOW_MS,
    records: verified ? records : null,
    ...(verified ? {} : { logDetail: "the chain did not verify; see the log check above" }),
  });

  const dark = report.findings.filter((finding) => finding.verdict === "dark");
  const undetermined = report.findings.filter((finding) => finding.verdict === "undetermined");
  const watched = report.findings.length;

  if (dark.length > 0) {
    return {
      check,
      status: "fail",
      detail: `${String(dark.length)} of ${String(watched)} checkout(s) show git activity the log carries no record of: ${dark
        .map((finding) => `${finding.subject} [${finding.code ?? "?"}]`)
        .join(", ")}. ${(dark[0] as DarkSessionFinding).detail}`,
      fix: "approval doctor --dir <that checkout> — its harness-hook-wiring row, then `approval instructions hook`",
    };
  }
  if (undetermined.length > 0) {
    return {
      check,
      status: "skip",
      detail: `UNDETERMINED for ${String(undetermined.length)} of ${String(
        watched,
      )} checkout(s): ${undetermined
        .map((finding) => `${finding.subject} [${finding.code ?? "?"}]`)
        .join(", ")}. ${(undetermined[0] as DarkSessionFinding).detail}`,
    };
  }
  return {
    check,
    status: "pass",
    detail: `${String(watched)} checkout(s) swept over the last ${String(
      Math.round(DEFAULT_DARK_WINDOW_MS / 3_600_000),
    )}h and every one of them either produced no git activity or has records beside it. ${report.coverage}`,
  };
}

// ---------------------------------------------------------------------------
// 27. gate-organs (APRV-272)
// ---------------------------------------------------------------------------

/**
 * Where the gate's organs live, as repository-relative prefixes.
 *
 * The enumeration is deliberately narrow and one level deep. `core/command-class.ts`
 * decides what IS an organ (and every path listed here is put to it before it
 * is reported); this list only says where to look, so a directory nobody uses
 * costs nothing and a file nobody named is not invented.
 */
const ORGAN_SEARCH: readonly { dir: string; prefix?: string }[] = [
  { dir: ".claude", prefix: "settings" },
  { dir: ".cursor", prefix: "hooks.json" },
  { dir: join(".cursor", "hooks") },
  { dir: join(".cursor", "agents") },
];

/** The organ files this checkout actually carries, repository-relative, sorted. */
function listGateOrgans(root: string): string[] {
  const found: string[] = [];
  for (const entry of ORGAN_SEARCH) {
    let names: string[];
    try {
      names = readdirSync(join(root, entry.dir));
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (entry.prefix !== undefined && !name.startsWith(entry.prefix)) continue;
      const relative = `${entry.dir.split(/[/\\]+/u).join("/")}/${name}`;
      let isFile: boolean;
      try {
        isFile = statSync(join(root, relative)).isFile();
      } catch {
        continue;
      }
      // The classifier has the last word on what an organ is, so a file that
      // merely sits in one of these directories is not reported as one.
      if (isFile && isGateOrganPath(relative)) found.push(relative);
    }
  }
  return found;
}

/**
 * Which gate organs in this checkout carry no attestation of their CURRENT
 * bytes (APRV-272)?
 *
 * **This row never moves the exit code, by design.** It reports a fact about
 * files a human edits by hand, and the enforcement for that fact lives in the
 * CI-side protected-path guard, which fails the pull request. Doctor's job here
 * is to make the state visible BEFORE a pull request fails on it: a human who
 * has just hand-edited the settings file should be told they owe an
 * attestation while they are still at the terminal, not by a red check twenty
 * minutes later. A failing row would also be wrong on its own terms — an
 * unattested organ breaks nothing on this machine, unlike an unattested policy,
 * which makes every gated operation refuse.
 *
 * A checkout with no organ files at all is a skip: there is no harness
 * configuration here, which is a state and not a fault, exactly as
 * `harness-hook-wiring` treats the same absence.
 */
function checkGateOrgans(dir: string, records: readonly EventRecord[]): DoctorCheck {
  const check = "gate-organs";
  const root = repoRoot(dir) ?? dir;
  const organs = listGateOrgans(root);
  if (organs.length === 0) {
    return {
      check,
      status: "skip",
      detail: `${root} carries no gate organ files (${ORGAN_SEARCH.map((entry) => entry.dir).join(", ")}), so there is nothing here for a human to have attested`,
    };
  }

  const unattested: string[] = [];
  const unreadable: string[] = [];
  let attested = 0;
  for (const organ of organs) {
    let sha256: string;
    try {
      sha256 = policyBytesHash(readFileSync(join(root, organ)));
    } catch (cause) {
      unreadable.push(`${organ} (${detailOf(cause)})`);
      continue;
    }
    if (findOrganAttestation(records, organ, sha256) !== null) {
      attested += 1;
      continue;
    }
    const previous = latestOrganAttestation(records, organ);
    unattested.push(
      previous === null
        ? `${organ} (never attested, live ${sha256.slice(0, 12)}…)`
        : `${organ} (edited since seq ${previous.record.seq}: attested ${previous.sha256.slice(0, 12)}…, live ${sha256.slice(0, 12)}…)`,
    );
  }

  if (unattested.length === 0 && unreadable.length === 0) {
    return {
      check,
      status: "pass",
      detail: `${String(attested)} gate organ file(s) carry an attestation of their current bytes: ${organs.join(", ")}`,
    };
  }

  const parts: string[] = [];
  if (unattested.length > 0) parts.push(`NOT ATTESTED: ${unattested.join("; ")}`);
  if (unreadable.length > 0) parts.push(`unreadable: ${unreadable.join("; ")}`);
  return {
    check,
    // Never a fail: see the note above. The exit code belongs to the guard.
    status: "skip",
    detail: `${parts.join(". ")}. A gate organ is policy.core, so no grant for a hand edit to one can exist and the protected-path guard accepts only an attestation of these exact bytes; a pull request carrying this change will fail until one is in the committed log`,
    fix: `approval policy attest --organ ${(unattested[0] ?? "<path>").split(" ")[0] ?? "<path>"} --as human:<id> — after reading the file`,
  };
}

/** The Backlog.md board key a task file's name begins with (`task-3 - Slug.md`). */
function taskIdFromFileName(name: string): string | null {
  const match = /^([A-Za-z][A-Za-z0-9_]*-\d+)/u.exec(name);
  return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** The status column, as a glyph role the shared style already knows how to paint. */
const GLYPH_OF: Record<DoctorCheck["status"], Glyph> = {
  pass: "ok",
  fail: "fail",
  skip: "skip",
};

/**
 * The human report: one aligned row per check, fixes indented under their row.
 *
 * The line contract is load-bearing and older than the table (APRV-91 #9): a
 * check occupies exactly one line, and a `fix` exactly one indented line under
 * it, so an operator scanning a failed run counts rows rather than paragraphs.
 * What the table changed is alignment and colour, never that arithmetic.
 *
 * A detail is abbreviated only when a TERMINAL WIDTH IS KNOWN and the row would
 * not fit it, and `--verbose` (APRV-102) turns even that off. The brief asked
 * for truncation outright; this is the narrowed version of it, for two reasons.
 * A pipe has no width, so piped output — which every other suite pins, and
 * which is what a bug report contains — is never abbreviated at all. And a
 * `fix:` line is never touched on any path: repair instructions cut off
 * mid-command are worse than a wide line, which is what the truncation was
 * supposed to prevent.
 */
export function renderDoctorHuman(
  checks: readonly DoctorCheck[],
  st: Style = style(),
  options: { verbose?: boolean; width?: number | null } = {},
): string {
  const labelWidth = Math.max(0, ...checks.map((entry) => entry.check.length));
  // glyph (1) + space + label + gap (2), the columns the detail starts after.
  const room =
    options.verbose === true || options.width === null || options.width === undefined
      ? null
      : Math.max(20, options.width - labelWidth - 4);
  const fit = (detail: string): string =>
    room === null || detail.length <= room ? detail : `${detail.slice(0, room - 1)}…`;

  const rows: TableRow[] = checks.map((entry) => ({
    left: entry.check,
    right: fit(entry.detail),
    glyph: GLYPH_OF[entry.status],
    ...(entry.fix === undefined ? {} : { under: [`fix: ${entry.fix}`] }),
  }));

  const count = (status: DoctorCheck["status"]): number =>
    checks.filter((entry) => entry.status === status).length;
  const failed = count("fail");
  // Each count wears its own role, so the summary is scannable at the same
  // glance as the glyph column above it and says the same thing.
  const summary = [
    st.ok(`${count("pass")} ok`),
    st.warn(`${count("skip")} not applicable`),
    failed === 0 ? st.muted("0 failed") : st.fail(`${failed} failed`),
  ].join(" · ");

  return `${st.table(rows)}\n${summary}\n`;
}

// ---------------------------------------------------------------------------
// The verb
// ---------------------------------------------------------------------------

/**
 * `approval doctor …` — run every check in order and report.
 *
 * Returns a number for the paths that are decided before any I/O (help, usage),
 * and a promise otherwise, because two checks are asynchronous. `main`
 * dispatches both shapes, as it already does for `channel`.
 */
export function commandDoctor(
  argv: string[],
  streams: Streams,
  cwd: string,
): number | Promise<number> {
  const json = argv.includes("--json");
  const parsed = parseFlags(argv, FLAGS);
  if (!parsed.ok) return usageError(streams, json, parsed.message);

  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${DOCTOR_HELP}\n`);
    return EXIT_OK;
  }

  const extra = parsed.positionals[0];
  if (extra !== undefined) {
    return usageError(streams, json, `unexpected argument ${JSON.stringify(extra)}`);
  }

  const rootFlag = stringFlag(parsed.flags, "--root");
  const root = rootFlag === null ? installationRoot() : absolute(rootFlag, cwd);

  let build: DoctorCheck;
  try {
    build = checkBuildFreshness(root);
  } catch (cause) {
    // Doctor could not look — the one thing that is not a report about the
    // environment but a failure of the instrument. Exit 4.
    if (cause instanceof ScanError) {
      return ioError(streams, json, `doctor could not inspect ${root}: ${cause.message}`);
    }
    throw cause;
  }

  const dirFlag = stringFlag(parsed.flags, "--dir");
  const dir = dirFlag === null ? cwd : absolute(dirFlag, cwd);
  const policyFlag = stringFlag(parsed.flags, "--policy");
  const policyPath = resolvePolicyPath(policyFlag, dir, cwd);
  const logPath = resolvePath(stringFlag(parsed.flags, "--log"), DEFAULT_LOG_PATH, cwd);
  // The second path the startup preflight must not let a fast-forward clobber.
  // Spelled from `--dir` rather than from a flag of its own: doctor has no
  // `--out`, and inventing one for a single row would be a new surface.
  const queuePath = join(dir, DEFAULT_QUEUE_PATH);

  // ONE walk of the log for both the attestation check and the log check: two
  // walks could disagree, and doctor is the last place a reader wants to be
  // told two different things about one file.
  const verified = verifyWithRecords(logPath);

  const policyLoad = loadPolicy(policyFlag === null ? { dir } : { file: policyPath });
  const port = policyWebPort(policyLoad);

  const apiBase = stringFlag(parsed.flags, "--api-base") ?? TELEGRAM_DEFAULT_API_BASE;

  const tasksFlag = stringFlag(parsed.flags, "--tasks");
  const tasksDir = tasksFlag === null ? join(dir, DEFAULT_TASKS_DIR) : absolute(tasksFlag, cwd);

  return (async (): Promise<number> => {
    const checks: DoctorCheck[] = [
      build,
      checkIdentity(),
      checkAttestationHealth(verified.records, policyPath),
      checkLog(logPath, verified.result),
      await checkTelegram(apiBase, policyLoad),
      await checkWebPort(port ?? WEB_DEFAULT_PORT),
      checkPayloadStore(logPath, verified.records),
      // APRV-271: asks the running daemon for the one half of this answer that
      // doctor's own environment cannot hold.
      await checkSampling(policyLoad, logPath),
      checkEnvelopeIntegrity(tasksDir, verified.records),
      // APRV-68: appended rather than inserted, for the same reason the
      // envelope check was — a reader's position-based expectations still hold.
      checkVaultHealth(logPath, dir, policyLoad),
      // APRV-75: appended, for the third time and the same reason — the check
      // list is a frozen shape that grows only at the end.
      checkEnvironment(logPath, dir, policyLoad),
      // APRV-125: appended, fourth time, same reason. The fork this reports is
      // the one APRV-104 could only find by hand.
      checkLogDrift(logPath, verified.records),
      // APRV-127: appended, fifth time, same reason.
      checkReconciliation(verified.records),
      // APRV-145: appended, sixth time, same reason.
      checkHarnessOutcomes(dir),
      // APRV-151: appended, seventh time, same reason.
      checkHarnessWiring(dir),
      // APRV-178: appended, eighth time, same reason. The sharing this reports
      // is what put a demo gate on the production bot.
      checkKeychainScope(logPath, policyLoad),
      // APRV-204: appended, ninth time, same reason. The cadence advance needed
      // a status surface that outlives the daemon's own event stream.
      checkAdvanceCadence(logPath, verified.records),
      // APRV-192: appended, tenth time, same reason. The detective complement
      // to harness-hook-wiring above — that row asks this checkout's settings
      // file, this one asks git and the log and never asks a session anything.
      checkDarkSessions(
        logPath,
        dir,
        policyPath,
        verified.records,
        verified.result.status === "clean",
      ),
      // APRV-188: appended, eleventh time, same reason.
      checkVerifiedSnapshot(logPath),
      // APRV-217: appended, twelfth time, same reason. A configuration row: it
      // reads the policy, never a running daemon's memory.
      checkReadProof(policyLoad),
      // APRV-215: appended, thirteenth time, same reason. The report half of
      // `approval up`'s startup preflight, and the only row that reads the
      // remote-tracking refs. It fetches NOTHING: a report that reached the
      // network to be more accurate would be acting on its own account, so the
      // answer is as fresh as the operator's last fetch and says so.
      checkMainBehindOrigin(logPath, queuePath, root),
      // APRV-227: appended, fourteenth time, same reason. The only row that
      // asks a question about a binary OUTSIDE this repository, and it asks it
      // the one way a log can: what the last record said the harness was,
      // against what `<binary> --version` says it is now.
      checkHarnessVersion(dir, verified.records),
      // APRV-208: appended, fourteenth time, same reason. The one row that says
      // whether supervised-live is actually live on this machine.
      // APRV-282: it connects now, because a socket file outlives the process
      // that bound it and a `stat` reads the leftovers as a healthy gate.
      await checkLiveDraw(logPath, policyLoad),
      // APRV-238: appended, fifteenth time, same reason. The one surface
      // besides `approval values` that would notice a broken values block:
      // `policy check` deliberately says nothing about it, because guidance has
      // no place in an enforcement trace.
      checkValuesBlock(policyPath, policyFlag !== null, dir),
      // APRV-257: appended, sixteenth time, same reason. The status surface the
      // second witness needed. It runs the SAME check `approval log verify
      // --checkpoints` and the daemon's full re-proof run, over the same single
      // walk of the log every other row here reads, so three instruments cannot
      // disagree about one file.
      checkCheckpoints(verified.records, policyFlag === null ? { dir } : { file: policyPath }),
      // APRV-272: appended, seventeenth time, same reason. Informational and
      // never a fail: the enforcement for an unattested organ is the CI-side
      // protected-path guard, and this row exists so a hand edit is visible at
      // the terminal before a pull request fails on it.
      checkGateOrgans(dir, verified.records),
    ];

    const ok = checks.every((entry) => entry.status !== "fail");

    if (json) streams.out(`${JSON.stringify({ ok, checks })}\n`);
    else {
      streams.out(
        renderDoctorHuman(checks, style({ json }), {
          verbose: boolFlag(parsed.flags, "--verbose"),
          // `undefined` in a pipe, which is exactly when nothing is abbreviated.
          width: process.stdout.columns ?? null,
        }),
      );
    }

    return ok ? EXIT_OK : EXIT_INTEGRITY;
  })();
}
