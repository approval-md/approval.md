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
 * that statement: seven checks, in the order in which their failures cascade,
 * each with a concrete repair.
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
import { closeSync, openSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePathSegments } from "node:path";
import { fileURLToPath } from "node:url";

import { WEB_DEFAULT_PORT } from "../channels/web.js";
import {
  TELEGRAM_CHAT_ENV,
  TELEGRAM_DEFAULT_API_BASE,
  TELEGRAM_TOKEN_ENV,
} from "../channels/telegram.js";
import { HUMAN_ACTOR_ENV, checkAttestation, resolveHumanActor } from "../core/attest.js";
import type { EventRecord } from "../core/log.js";
import { payloadStoreDirFor } from "../core/payload-store.js";
import { payloadStoreCensus } from "../daemon/prune.js";
import { POLICY_FILENAMES, loadPolicy } from "../core/policy-load.js";
import { verifyWithRecords, type VerifyResult } from "../core/verify.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import { policyWebPort } from "./channel-web.js";
import { EXIT_INTEGRITY, EXIT_IO, EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { DOCTOR_HELP } from "./help.js";
import type { Streams } from "./main.js";
import { DEFAULT_LOG_PATH, resolvePath } from "./paths.js";

const FLAGS: Record<string, FlagKind> = {
  "--log": "string",
  "--policy": "string",
  "--dir": "string",
  "--api-base": "string",
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

function detailOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function absolute(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolvePathSegments(cwd, value);
}

function usageError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "usage", message } })}\n`);
  else streams.err(`approval: ${message}\n\n${DOCTOR_HELP}\n`);
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
      fix: "run `npm run build` in this checkout (and check you are in the checkout you think you are: `node -p \"process.argv[1]\"`)",
    };
  }

  if (loaderMtime === null) {
    return {
      check: "build-freshness",
      status: "fail",
      detail: `${marker} exists but the bin loader ${loader} does not: \`approval\` on PATH cannot reach this build`,
      fix: "reinstall the package, or invoke the build directly with `node dist/src/cli/main.js`",
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
      fix: "run `npm run build`",
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
    fix: `export ${HUMAN_ACTOR_ENV}=human:<id>, or pass --as human:<id> to each human-only verb`,
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
        fix: "run `approval policy attest --as human:<id>` after reading the file",
      };
    case "hash-mismatch":
      return {
        check: "attestation",
        status: "fail",
        detail: `${policyPath} has changed since it was attested at seq ${status.seq} (attested ${status.attestedSha256.slice(0, 12)}…, live ${status.liveSha256.slice(0, 12)}…); an edited policy is inoperative until a human re-attests it`,
        fix: "review the diff, then re-attest the new bytes with `approval policy attest --as human:<id>`",
      };
    case "unreadable":
      return {
        check: "attestation",
        status: "fail",
        detail: `${status.message}; an unverifiable policy is treated as unattested`,
        fix: `create the policy file (or point --policy / --dir at it), then run \`approval policy attest --as human:<id>\``,
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
        fix: "run `approval log verify` for the full report; nothing here truncates the torn line, because that is a human decision",
      };
    case "corrupt":
      return {
        check: "log",
        status: "fail",
        detail: `${logPath} does not verify (${result.reason}${
          result.firstBadSeq === null ? "" : ` at seq ${result.firstBadSeq}`
        }): ${result.message}`,
        fix: "run `approval log verify`, and authorize nothing from this log until a human has accounted for the break",
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
 */
async function checkTelegram(apiBase: string): Promise<DoctorCheck> {
  const token = process.env[TELEGRAM_TOKEN_ENV] ?? "";
  const chat = process.env[TELEGRAM_CHAT_ENV] ?? "";

  if (token.length === 0 || chat.length === 0) {
    const missing = [
      token.length === 0 ? TELEGRAM_TOKEN_ENV : null,
      chat.length === 0 ? TELEGRAM_CHAT_ENV : null,
    ].filter((name): name is string => name !== null);
    return {
      check: "telegram",
      status: "skip",
      detail: `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} unset: the Telegram channel is not configured, which is a legitimate configuration and not a fault`,
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
            ? `the bot token is not valid: re-copy it from @BotFather into ${TELEGRAM_TOKEN_ENV}`
            : `check ${TELEGRAM_TOKEN_ENV} and that ${base} is the right Bot API base`,
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
      fix: `check network reachability of ${base} (and ${TELEGRAM_TOKEN_ENV} if it is a TLS or auth failure)`,
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
          fix: "set channels.web.port in APPROVAL.md to a port above 1023, then re-attest the policy",
        });
        return;
      }
      resolve({
        check: "web-port",
        status: "fail",
        detail: `127.0.0.1:${port} cannot be bound: ${detailOf(cause)}`,
        fix: "set a usable channels.web.port in APPROVAL.md, then re-attest the policy",
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
      fix: `make ${storeDir} readable and writable by the user running approval`,
    };
  }

  if (!stats.isDirectory()) {
    return {
      check: "payload-store",
      status: "fail",
      detail: `${storeDir} exists and is not a directory, so no payload can be stored beside the log; ${PAYLOAD_STORE_WARNING}`,
      fix: `move whatever occupies ${storeDir} aside, then re-run the request`,
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
      fix: `make ${storeDir} writable by the user running approval (e.g. \`chmod u+w ${storeDir}\`), and check its ownership`,
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

  const port = policyWebPort(
    loadPolicy(policyFlag === null ? { dir } : { file: policyPath }),
  );

  const apiBase = stringFlag(parsed.flags, "--api-base") ?? TELEGRAM_DEFAULT_API_BASE;

  return (async (): Promise<number> => {
    const checks: DoctorCheck[] = [
      build,
      checkIdentity(),
      checkAttestationHealth(verified.records, policyPath),
      checkLog(logPath, verified.result),
      await checkTelegram(apiBase),
      await checkWebPort(port ?? WEB_DEFAULT_PORT),
      checkPayloadStore(logPath, verified.records),
    ];

    const ok = checks.every((entry) => entry.status !== "fail");

    if (json) streams.out(`${JSON.stringify({ ok, checks })}\n`);
    else render(streams, checks);

    return ok ? EXIT_OK : EXIT_INTEGRITY;
  })();
}
