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
import { closeSync, openSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePathSegments } from "node:path";
import { fileURLToPath } from "node:url";

import { WEB_DEFAULT_PORT } from "../channels/web.js";
import {
  TELEGRAM_DEFAULT_API_BASE,
  telegramChatEnvFor,
  telegramTokenEnvFor,
} from "../channels/telegram.js";
import { HUMAN_ACTOR_ENV, checkAttestation, resolveHumanActor } from "../core/attest.js";
import {
  envFilePathFor,
  resolveEnvironment,
  type ResolvedVariable,
  type SourceOutcome,
  type SourceRunner,
} from "../core/env-file.js";
import { readTaskFile } from "../core/frontmatter.js";
import type { EventRecord } from "../core/log.js";
import { payloadStoreCensus } from "../core/payload-census.js";
import { payloadStoreDirFor } from "../core/payload-store.js";
import { DEFAULT_TASKS_DIR, latestRegistration } from "../core/registration.js";
import { POLICY_FILENAMES, loadPolicy, type PolicyLoadResult } from "../core/policy-load.js";
import { resolveSampler } from "../core/sampler.js";
import {
  checkVault,
  passphraseEnvFor,
  passphraseFrom,
  vaultExists,
  vaultPathFor,
} from "../core/vault.js";
import { verifyWithRecords, type VerifyResult } from "../core/verify.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import { policyWebPort } from "./channel-web.js";
import { EXIT_INTEGRITY, EXIT_IO, EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { DOCTOR_HELP } from "./help.js";
import type { Streams } from "./main.js";
import { DEFAULT_LOG_PATH, resolvePath } from "./paths.js";
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

/**
 * The installation root: the directory holding `cli.js`, `src/`, `dist/`.
 *
 * Derived from this module's own location rather than from `cwd`, because the
 * question is "is the code I am running stale", and the answer must not change
 * when the operator runs the CLI from somewhere else. Compiled, this file is
 * `<root>/dist/src/cli/doctor.js`, hence three levels up.
 */
function installationRoot(): string {
  return resolvePathSegments(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

/** Thrown out of the source walk so a real I/O denial can become exit 4. */
class ScanError extends Error {}

/**
 * Newest mtime under `dir`, or `null` when `dir` does not exist.
 *
 * ENOENT anywhere in the walk is "not there", which is an answer. Anything else
 * — a permission bit, a vanished mount — is doctor failing to look, and is
 * raised so the caller can report {@link EXIT_IO} rather than quietly reporting
 * a build as fresh because half the tree was invisible.
 */
function newestMtime(path: string): number | null {
  let stats;
  try {
    stats = statSync(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ScanError(`${path} could not be stat'd: ${detailOf(cause)}`);
  }
  if (!stats.isDirectory()) return stats.mtimeMs;

  let newest = stats.mtimeMs;
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return newest;
    throw new ScanError(`${path} could not be listed: ${detailOf(cause)}`);
  }
  for (const entry of entries) {
    const child = newestMtime(join(path, entry.name));
    if (child !== null && child > newest) newest = child;
  }
  return newest;
}

/**
 * Is the built CLI at least as new as the sources it was built from?
 *
 * The marker is `dist/src/cli/main.js` — the exact file `cli.js` loads, so the
 * thing being timestamped is the thing that will actually run. It is compared
 * against the newest mtime under `src/` and of `tsconfig.json` (a compiler
 * option change invalidates a build as surely as an edit does).
 *
 * Three shapes are distinguished because their repairs differ:
 *
 * - `cli.js` present, `dist/` absent — the placeholder-binary shape from the
 *   ceremony. The loader exists, so the checkout *looks* installed; nothing
 *   behind it does.
 * - marker older than sources — the stale-checkout shape. Verbs that exist in
 *   `src/` are missing from the binary.
 * - no `src/` at all — a published install, where freshness is not a question
 *   that can be asked. `skip`, not a silent pass.
 *
 * Note the self-reference: doctor itself runs *from* `dist`, so a completely
 * absent `dist` means `cli.js` already refused and this code never ran. The
 * check is still implemented for that shape because `--root` can point it at
 * another tree, and because "the binary you ran is not the tree you edited" is
 * exactly the confusion it exists to name.
 */
function checkBuildFreshness(root: string): DoctorCheck {
  const loader = join(root, "cli.js");
  const marker = join(root, "dist", "src", "cli", "main.js");
  const sources = join(root, "src");
  const tsconfig = join(root, "tsconfig.json");

  const loaderMtime = newestMtime(loader);
  const markerMtime = newestMtime(marker);

  if (markerMtime === null) {
    return {
      check: "build-freshness",
      status: "fail",
      detail:
        loaderMtime === null
          ? `neither ${loader} nor ${marker} exists — ${root} is not an approval.md installation`
          : `${loader} exists but ${marker} does not: this is an unbuilt checkout, a bin loader with no build behind it`,
      fix: 'npm run build — in this checkout; if you are not sure this is the checkout you meant, `node -p "process.argv[1]"` names the one you just ran',
    };
  }

  if (loaderMtime === null) {
    return {
      check: "build-freshness",
      status: "fail",
      detail: `${marker} exists but the bin loader ${loader} does not: \`approval\` on PATH cannot reach this build`,
      fix: "node dist/src/cli/main.js — invoke the build directly, or reinstall the package so `approval` on PATH reaches it",
    };
  }

  const sourceMtime = newestMtime(sources);
  if (sourceMtime === null) {
    return {
      check: "build-freshness",
      status: "skip",
      detail: `${sources} is absent (a published install carries no sources), so the build cannot be dated against them; ${marker} is present`,
    };
  }

  const configMtime = newestMtime(tsconfig) ?? 0;
  const newestSource = Math.max(sourceMtime, configMtime);

  if (newestSource > markerMtime) {
    return {
      check: "build-freshness",
      status: "fail",
      detail: `${marker} is older than the source tree (build ${new Date(markerMtime).toISOString()}, newest source ${new Date(newestSource).toISOString()}): you are running a STALE BUILD, and verbs added since it was compiled are simply absent`,
      fix: "npm run build",
    };
  }

  return {
    check: "build-freshness",
    status: "pass",
    detail: `${marker} built ${new Date(markerMtime).toISOString()}, not older than the source tree`,
  };
}

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
function checkSampling(load: PolicyLoadResult): DoctorCheck {
  const sampler = resolveSampler(load);
  if (sampler.enabled) {
    return {
      check: "audit-sampling",
      status: "pass",
      detail: `enabled at rate ${String(sampler.rate)}; secret read from $${sampler.secretEnv} (the value itself is never printed and never logged)`,
    };
  }
  const deliberate = sampler.reason === "rate-absent" || sampler.reason === "rate-zero";
  if (deliberate) {
    return {
      check: "audit-sampling",
      status: "skip",
      detail: `disabled (${sampler.reason}): ${sampler.message}`,
    };
  }
  return {
    check: "audit-sampling",
    status: "fail",
    detail: `disabled (${sampler.reason}): ${sampler.message}`,
    fix:
      sampler.reason === "secret-unset" && sampler.secretEnv !== null
        ? `approval setup sampling — or set it yourself: export ${sampler.secretEnv} with the operator-held sampling secret in the environment that runs the daemon`
        : "approval policy attest --as human:<id> — after setting audit.supervised_sample_rate and audit.sampling_secret_env in the policy; then export the named variable where the daemon runs",
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
 */
const KEYSTORE_DEFERRED = "not resolved by doctor";

const NON_RESOLVING_RUNNER: SourceRunner = {
  keychain(service: string): SourceOutcome {
    return {
      ok: false,
      code: "helper-failed",
      message: `${KEYSTORE_DEFERRED}: keychain:${service} is declared here and looked up by \`approval env --check\`. \`security find-generic-password -w\` can block on a keychain-unlock or ACL prompt, and a diagnostic must never hang or ask a human for a password`,
    };
  },
  secretService(label: string): SourceOutcome {
    return {
      ok: false,
      code: "helper-failed",
      message: `${KEYSTORE_DEFERRED}: secret-service:${label} is declared here and looked up by \`approval env --check\`. \`secret-tool lookup\` can block on a keyring-unlock prompt, and a diagnostic must never hang or ask a human for a password`,
    };
  },
};

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

/** The Backlog.md board key a task file's name begins with (`task-3 - Slug.md`). */
function taskIdFromFileName(name: string): string | null {
  const match = /^([A-Za-z][A-Za-z0-9_]*-\d+)/u.exec(name);
  return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const MARK: Record<DoctorCheck["status"], string> = {
  pass: "✓",
  fail: "✗",
  skip: "–",
};

function render(streams: Streams, checks: DoctorCheck[]): void {
  for (const entry of checks) {
    streams.out(`${MARK[entry.status]} ${entry.check}: ${entry.detail}\n`);
    if (entry.fix !== undefined) streams.out(`    fix: ${entry.fix}\n`);
  }
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
      checkSampling(policyLoad),
      checkEnvelopeIntegrity(tasksDir, verified.records),
      // APRV-68: appended rather than inserted, for the same reason the
      // envelope check was — a reader's position-based expectations still hold.
      checkVaultHealth(logPath, dir, policyLoad),
      // APRV-75: appended, for the third time and the same reason — the check
      // list is a frozen shape that grows only at the end.
      checkEnvironment(logPath, dir, policyLoad),
    ];

    const ok = checks.every((entry) => entry.status !== "fail");

    if (json) streams.out(`${JSON.stringify({ ok, checks })}\n`);
    else render(streams, checks);

    return ok ? EXIT_OK : EXIT_INTEGRITY;
  })();
}
