/**
 * The egress sandbox (APRV-193): the room an allowed command runs in.
 *
 * ## What this is for
 *
 * Arbitrary code execution is capability-complete. The gate classifies a
 * command by its TEXT, and `npm test` runs whatever the agent wrote a minute
 * ago, so for laundered exec the text has stopped describing the effect. No
 * classifier over shell strings can close that, and `core/child-env.ts`
 * (APRV-205) closed only half of it: the child no longer inherits the session's
 * credentials, and it still inherits the session's network.
 *
 * This module removes the network. It does not try to predict what the code
 * will do; it takes away what the code would need. Where APRV-205 starves the
 * child of secrets, this starves it of a place to send them.
 *
 * ## The shape, and why it is this shape
 *
 * A NETWORK-ONLY sandbox, with one filesystem exception. The filesystem is left
 * alone because the gate's own IPC is a FILE: `src/daemon/` opens no socket, it
 * polls `.approval/log/events.jsonl`. So denying egress costs the gate nothing
 * and needs no plumbing to stay reachable, and the "one door" other agent
 * sandboxes build an egress proxy for already exists as an append to a file.
 * That is the single largest simplification available here, and it is why the
 * default profile denies the network, denies reads of the credential material
 * beside the log, and touches nothing else.
 *
 * Loopback is denied WITH the rest. There is no gate socket to except: the
 * daemon is a file reader. The one thing loopback costs is a test suite that
 * starts its own localhost server, which is what {@link EgressAllowance.loopback}
 * is for, and that allowance is an operator's decision recorded where it is
 * used (`docs/sandboxed-exec.md` has the survey).
 *
 * ## The mechanism, and what is verified rather than assumed
 *
 * macOS only in this build: `/usr/bin/sandbox-exec` with a Sandbox Profile
 * Language (SBPL) profile. It ships with every macOS, needs no privilege and no
 * daemon, and every macOS agent sandbox in the field uses it. Linux
 * (`bwrap --unshare-net`, `unshare --net`) is a stated follow-up rather than a
 * silent omission: {@link detectSandbox} reports `supported: false` there and
 * says so, and `docs/sandboxed-exec.md` carries the gap.
 *
 * Three Seatbelt behaviours are measured, not assumed. Each of them, got wrong,
 * ships a profile that silently protects nothing, which is the worst artifact
 * this design could produce:
 *
 * 1. `network-outbound` covers AF_UNIX connects as well as AF_INET. A bare
 *    `(deny network-outbound)` kills local IPC — DNS's mDNSResponder socket
 *    included — and the process dies before it can do anything. The unix
 *    exception is mandatory.
 * 2. `subpath` and `literal` filters match the kernel's RESOLVED path. On macOS
 *    `/tmp` is a symlink to `/private/tmp`, so a profile naming `/tmp/x` denies
 *    NOTHING. Every path is realpath-resolved before it is written into a
 *    profile, and `tests/sandbox.test.ts` pins the unresolved spelling as the
 *    no-op it is.
 * 3. `sandbox-exec` execs through `execvp`, so a PATH lookup still happens
 *    inside the wrapper — but a lookup that FAILS exits 71 (EX_OSERR), which
 *    would be recorded as the child's own exit code. So {@link resolveExecutable}
 *    does the lookup first and a command that cannot be found is never wrapped:
 *    it reaches `spawnSync` unwrapped and fails as ENOENT exactly as it does
 *    today.
 *
 * ## What it does not claim
 *
 * A sandboxed child can still WRITE files, including files a later unsandboxed
 * process will run. That is the same laundering one step removed, and it is why
 * `APPROVAL_HOOK_REQUIRE_SANDBOX` (which makes the hook insist that every
 * code-running command wear the room) matters more than any single wrapper. It
 * would be closed properly by running the whole SESSION under the profile,
 * which this build cannot do: an agent harness needs the model API, and denying
 * egress denies exactly that. A session-wide sandbox needs an allowlist
 * reaching one host, which Seatbelt cannot express by hostname and which the
 * prior art solves with a local proxy.
 *
 * Inbound sockets are not denied, so a child could in principle bind a port and
 * wait to be contacted; that needs a peer that can reach this machine and is
 * recorded here as a stated limit rather than an oversight. And the sandbox is
 * not isolation: it is one capability removed from a process that otherwise has
 * the ordinary powers of the session.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";

import { envFilePathFor } from "./env-file.js";
import { keyStoreDirFor } from "./seal.js";
import { vaultPathFor } from "./vault.js";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * The mechanisms this build knows. One, today.
 *
 * A union rather than a string so the Linux follow-up (APRV-193g) is an
 * addition the compiler finds every site of, rather than a value that quietly
 * flows through code written for Seatbelt.
 */
export const SANDBOX_MECHANISMS = ["sandbox-exec"] as const;
export type SandboxMechanism = (typeof SANDBOX_MECHANISMS)[number];

/**
 * What an execution's record says about the room it ran in.
 *
 * Written to `execution.started` as `sandbox`, and it is a fact about the
 * runtime's own behaviour rather than anything a caller asserted: three of the
 * four values are computed here, and the fourth (`opted-out`) is a flag the
 * operator typed, which is exactly why it is RECORDED — an opt-out nobody can
 * see afterwards is an opt-out that costs nothing to take.
 */
export const SANDBOX_STATES = [
  /** The child ran with outbound network denied. */
  "egress-denied",
  /** `--no-sandbox` was passed. The child ran with the session's own network. */
  "opted-out",
  /**
   * The manual path: a human granted these exact bytes and the grant is the
   * authority to reach the world. `approval run` on a token is the one door,
   * and a door that denied egress would not be a door.
   */
  "granted-egress",
  /**
   * This platform has no mechanism in this build (anything but macOS today).
   * Recorded on every execution so an auditor can see exactly which runs were
   * unprotected, rather than inferring it from the absence of a field.
   */
  "unsupported",
] as const;
export type SandboxState = (typeof SANDBOX_STATES)[number];

/** What the machine can do, probed rather than inferred. */
export interface SandboxDetection {
  /** Can a command be run egress-denied here, right now? */
  readonly available: boolean;
  /** The mechanism that would be used, or `null`. */
  readonly mechanism: SandboxMechanism | null;
  /**
   * Does this build have a mechanism for this platform AT ALL?
   *
   * The distinction from {@link available} is load-bearing and it is the one
   * place this module is deliberately not maximally strict. `supported: false`
   * means "nothing was ever written for this platform", which is a known gap
   * with a follow-up task and a docs row. `supported: true, available: false`
   * means "the mechanism that should be here did not work", which is a broken
   * promise, and the callers treat the two differently: the first proceeds and
   * records `unsupported`, the second refuses to run the command at all.
   */
  readonly supported: boolean;
  /** Can loopback be carved back in? (Seatbelt yes; a Linux netns cannot.) */
  readonly loopback: boolean;
  /** Why, when {@link available} is false. Empty otherwise. */
  readonly reason: string;
}

/** What the profile lets through. Everything absent here is denied. */
export interface EgressAllowance {
  /**
   * Allow connections to `localhost:*`.
   *
   * Off by default. The gate needs nothing: its IPC is a file. This exists for
   * the one legitimate case the survey found, a test suite that starts its own
   * server, and it is a real widening — a loopback port is a port, and anything
   * listening on one is reachable from inside.
   */
  readonly loopback: boolean;
  /**
   * Absolute paths whose CONTENTS the child may not read. Resolved before they
   * reach the profile. Directories deny their whole subtree.
   */
  readonly denyRead: readonly string[];
}

/** The default: nothing allowed, nothing denied beyond the network. */
export const DENY_ALL_EGRESS: EgressAllowance = { loopback: false, denyRead: [] };

// ---------------------------------------------------------------------------
// The credential material
// ---------------------------------------------------------------------------

/**
 * The files beside a log that hold credential material, for the profile's
 * `denyRead`.
 *
 * Named individually rather than by denying the whole approval home. The home
 * also holds the log, the payload store and the queue, and a child that could
 * not read the log could not read the decision that authorized it. What is
 * denied is what a laundering script would want: the vault's ciphertext, the
 * environment source map that says where the secrets come from, and the
 * per-request private keys that seal tokens.
 *
 * This is defence in depth over material that is already encrypted or already
 * useless without the passphrase — the load-bearing custody control is that
 * the passphrase is not in the child's environment at all (APRV-205). It is
 * worth having on the one platform where it costs nothing.
 */
export function credentialPathsFor(logPath: string): string[] {
  return [vaultPathFor(logPath), envFilePathFor(logPath), keyStoreDirFor(logPath)];
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Forces the unavailable branch. A STRICTNESS increase in every caller — the
 * run path refuses and the session launcher refuses — so a forged value cannot
 * widen anything, which is what keeps it clear of SPEC.md §11.1 invariant 4.
 */
export const FORCE_UNAVAILABLE_ENV = "APPROVAL_SANDBOX_FORCE_UNAVAILABLE";

/**
 * Treat an unsupported platform as a broken promise rather than a known gap:
 * with this set, a machine with no mechanism refuses instead of proceeding.
 * The same one-way property holds — it can only ever refuse more.
 */
export const REQUIRE_SANDBOX_ENV = "APPROVAL_SANDBOX_REQUIRED";

export interface DetectOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
}

/** The binary, absolute: a PATH lookup for the sandbox itself would be a hole. */
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** `sandbox-exec`'s flags for "apply this profile file". */
function profileFlags(profile: string): string[] {
  return ["-f", profile];
}

function unavailable(reason: string, supported: boolean): SandboxDetection {
  return { available: false, mechanism: null, supported, loopback: false, reason };
}

/**
 * Does this machine actually have a working primitive?
 *
 * PROBED, by applying a trivial profile to a trivial command, rather than
 * inferred from a binary existing on disk: a mechanism that is present and
 * refused by the kernel is the case that matters, and it is the case
 * `existsSync` answers wrong.
 */
function probe(options: DetectOptions): SandboxDetection {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (env[FORCE_UNAVAILABLE_ENV] === "1") {
    return unavailable(`${FORCE_UNAVAILABLE_ENV}=1 is set`, true);
  }
  if (platform !== "darwin") {
    return unavailable(
      `no egress-denial mechanism is implemented for platform ${JSON.stringify(platform)}; Linux (bwrap/unshare) is APRV-193's follow-up`,
      false,
    );
  }
  if (!existsSync(SANDBOX_EXEC)) {
    return unavailable(`${SANDBOX_EXEC} is missing`, true);
  }
  const dir = mkdtempSync(join(realTmpdir(), "approval-sandbox-detect-"));
  try {
    const profile = join(dir, "probe.sb");
    writeFileSync(profile, seatbeltProfile(DENY_ALL_EGRESS), { mode: 0o600 });
    const result = spawnSync(SANDBOX_EXEC, [...profileFlags(profile), "/usr/bin/true"], {
      stdio: "ignore",
      timeout: 10_000,
    });
    if (result.error !== undefined || result.status !== 0) {
      return unavailable("sandbox-exec is present but refused a trivial profile", true);
    }
    return {
      available: true,
      mechanism: "sandbox-exec",
      supported: true,
      loopback: true,
      reason: "",
    };
  } finally {
    // The probe leaves nothing behind on any path. A verb that ran often enough
    // would otherwise fill the temp directory with two-line profiles.
    rmSync(dir, { recursive: true, force: true });
  }
}

let cached: SandboxDetection | null = null;

/**
 * What this machine can do. Cached for the default call, because every verb
 * that asks would otherwise spawn a probe per invocation, and the answer cannot
 * change inside one process.
 */
export function detectSandbox(options: DetectOptions = {}): SandboxDetection {
  const uncached = options.platform !== undefined || options.env !== undefined;
  if (uncached) return probe(options);
  if (cached === null) cached = probe(options);
  return cached;
}

/** Testing seam: forget the cached probe. Never called by the runtime. */
export function resetSandboxDetection(): void {
  cached = null;
}

// ---------------------------------------------------------------------------
// The profile
// ---------------------------------------------------------------------------

/** `os.tmpdir()` with its symlinks gone. See the header's point 2. */
function realTmpdir(): string {
  try {
    return realpathSync(tmpdir());
  } catch {
    return tmpdir();
  }
}

/**
 * A path as the KERNEL will see it.
 *
 * A path that does not exist yet cannot be resolved, so its directory is
 * resolved and the name re-joined. A profile naming an unresolved path denies
 * nothing at all and reports no error, which is the failure this function
 * exists to prevent.
 */
export function resolveForProfile(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // Fall through: the leaf may simply not exist yet.
  }
  try {
    return join(realpathSync(dirname(path)), basename(path));
  } catch {
    return path;
  }
}

/**
 * The SBPL profile.
 *
 * `(allow default)` first, then the denial: SBPL takes the LAST matching rule,
 * so exceptions are written after the deny. This is deliberately a deny-LIST
 * and not the `(deny default)` posture a true isolation sandbox takes. The
 * property being enforced is egress, and a deny-default profile spends itself
 * re-allowing dyld, `/dev/urandom`, the process's own binary and every
 * temporary directory, which is a different task with a different failure mode
 * (and a much larger chance of breaking ordinary development, which is how a
 * control gets switched off).
 */
export function seatbeltProfile(allowance: EgressAllowance): string {
  const lines = [
    "(version 1)",
    ";; APRV-193: the egress sandbox. Last match wins, so exceptions follow the deny.",
    "(allow default)",
    "(deny network-outbound)",
    ";; Unix-domain sockets are `network-outbound` to Seatbelt. Local IPC is not",
    ";; egress, and denying it kills the process before it can do anything.",
    '(allow network-outbound (regex #"^/"))',
  ];
  if (allowance.loopback) {
    lines.push(
      ";; Carve-out: a suite that starts its own localhost server. A real widening.",
      '(allow network-outbound (remote ip "localhost:*"))',
    );
  }
  for (const path of allowance.denyRead) {
    const resolved = resolveForProfile(path);
    // `literal` for a file, `subpath` for a directory. Both are emitted for a
    // path that does not exist yet, because which one it will be is not knowable
    // and an extra rule over a nonexistent path denies nothing extra.
    let directory = false;
    let file = false;
    try {
      directory = statSync(resolved).isDirectory();
      file = !directory;
    } catch {
      // Neither: emit both forms.
    }
    if (!directory) lines.push(`(deny file-read* (literal ${sbplString(resolved)}))`);
    if (!file) lines.push(`(deny file-read* (subpath ${sbplString(resolved)}))`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * A path as an SBPL string literal.
 *
 * SBPL is a TinyScheme dialect and its strings take backslash escapes, so a
 * path is escaped for backslash and double quote and nothing else. `JSON.stringify`
 * would additionally emit `\uXXXX` for non-ASCII, which SBPL does not read, and
 * a profile it cannot parse is a profile that does not load.
 */
function sbplString(path: string): string {
  return `"${path.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

// ---------------------------------------------------------------------------
// Wrapping a spawn
// ---------------------------------------------------------------------------

/** The argv to spawn, and the temporary directory the caller must remove. */
export interface WrappedSpawn {
  readonly command: string;
  readonly args: string[];
  /** A directory holding the profile file; remove it once the child is gone. */
  readonly cleanup: string;
  /** What the caller records. */
  readonly mechanism: SandboxMechanism;
}

/**
 * Resolve a command the way `execvp` would, and say when it cannot be found.
 *
 * Done HERE rather than left to the wrapper for the reason in the header: an
 * execvp failure inside `sandbox-exec` exits 71, and 71 recorded as the child's
 * exit code is a lie about a command that never ran. A command that does not
 * resolve is returned as `null`, and the caller spawns it unwrapped so the
 * ENOENT surfaces exactly as it does with no sandbox in the picture.
 */
export function resolveExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (command.includes("/")) {
    return isExecutableFile(command) ? command : null;
  }
  const path = env["PATH"];
  if (path === undefined || path.length === 0) return null;
  for (const entry of path.split(delimiter)) {
    if (entry.length === 0) continue;
    const candidate = isAbsolute(entry) ? join(entry, command) : join(process.cwd(), entry, command);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function isExecutableFile(candidate: string): boolean {
  try {
    const stat = statSync(candidate);
    // The x bit for anybody: a finer answer would need the process's own uid and
    // gid resolution, and a false positive here costs one ENOENT-shaped failure
    // rather than an unsandboxed execution.
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Build the wrapped spawn for `argv`.
 *
 * Writes the profile to a fresh 0600 file under a private directory: the
 * profile names the paths whose reads are denied, which is not secret, but a
 * world-writable profile would be a profile another process could rewrite
 * between this write and the exec.
 */
export function wrapForSandbox(
  mechanism: SandboxMechanism,
  command: string,
  args: readonly string[],
  allowance: EgressAllowance = DENY_ALL_EGRESS,
): WrappedSpawn {
  if (mechanism !== "sandbox-exec") {
    // Unreachable while the union has one member; the compiler keeps it that way.
    throw new Error(`unknown sandbox mechanism ${String(mechanism)}`);
  }
  const dir = mkdtempSync(join(realTmpdir(), "approval-sandbox-"));
  const profile = join(dir, "egress-denied.sb");
  writeFileSync(profile, seatbeltProfile(allowance), { mode: 0o600 });
  return {
    command: SANDBOX_EXEC,
    args: [...profileFlags(profile), command, ...args],
    cleanup: dir,
    mechanism,
  };
}

// ---------------------------------------------------------------------------
// The posture a caller applies
// ---------------------------------------------------------------------------

export interface PostureInput {
  /** `--no-sandbox` was passed. */
  readonly optedOut: boolean;
  /**
   * A human's grant over these exact bytes is in the caller's hand (the manual
   * path presented a token). The grant IS the authority to reach the world.
   *
   * Not a self-report that widens anything: a token that does not verify runs
   * no command at all, so the loosening is reachable only by holding something
   * a human minted. SPEC.md §11.1 invariant 4 is about a declaration the
   * executing party authors; this is a secret it cannot author.
   */
  readonly granted: boolean;
  /** The machine's capability. */
  readonly detection: SandboxDetection;
  /** `APPROVAL_SANDBOX_REQUIRED=1` promotes an unsupported platform to a refusal. */
  readonly requireSupported?: boolean;
}

export type SandboxPosture =
  | { readonly kind: "apply"; readonly state: "egress-denied"; readonly mechanism: SandboxMechanism }
  | { readonly kind: "skip"; readonly state: Exclude<SandboxState, "egress-denied"> }
  | { readonly kind: "refuse"; readonly reason: string };

/**
 * What to do about the sandbox for one execution.
 *
 * Total, pure, and exhaustively testable: it reads a detection and two booleans
 * and returns one of three answers. The ORDER of the branches is the policy —
 * a broken mechanism refuses before an opt-out is considered, so `--no-sandbox`
 * on a machine whose sandbox is broken is still a refusal rather than a way to
 * turn the noise off.
 */
export function sandboxPosture(input: PostureInput): SandboxPosture {
  const { detection } = input;
  if (detection.supported && !detection.available) {
    return {
      kind: "refuse",
      reason: detection.reason,
    };
  }
  if (!detection.supported) {
    if (input.requireSupported === true) {
      return { kind: "refuse", reason: detection.reason };
    }
    return { kind: "skip", state: "unsupported" };
  }
  if (input.optedOut) return { kind: "skip", state: "opted-out" };
  if (input.granted) return { kind: "skip", state: "granted-egress" };
  const mechanism = detection.mechanism;
  if (mechanism === null) return { kind: "refuse", reason: "no mechanism was reported" };
  return { kind: "apply", state: "egress-denied", mechanism };
}

/** Is `APPROVAL_SANDBOX_REQUIRED` set on this environment? */
export function sandboxRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[REQUIRE_SANDBOX_ENV] === "1";
}
