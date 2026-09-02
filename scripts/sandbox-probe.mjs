#!/usr/bin/env node
/**
 * Egress-denial sandbox probe (APRV-193, design lane).
 *
 * A STANDALONE prototype. Nothing in `src/` imports it, no gate verb calls it,
 * and it reads neither the policy nor the log. It exists to answer one question
 * with evidence rather than with prose: on this machine, right now, can a child
 * process be spawned into a room with no doors to the network, while the
 * filesystem it needs stays exactly where it was?
 *
 * The shape it prototypes is the one the design proposes (design/aprv-193-starve
 * -the-code.md): a NETWORK-ONLY sandbox. The filesystem is left alone, because
 * the gate's own IPC is a file (`.approval/log/events.jsonl`, polled by the
 * daemon; there is no socket), so denying egress costs the gate nothing and
 * needs no plumbing to stay reachable. A filesystem sandbox is a separate,
 * later question with a much larger blast radius on ordinary development.
 *
 * Mechanisms, one per platform, each the one that needs no operator setup:
 *   - macOS: `/usr/bin/sandbox-exec` with an SBPL profile (Seatbelt). Ships with
 *     the OS. Deprecated in the man page since 10.14 and still the mechanism
 *     every macOS agent sandbox uses.
 *   - Linux: `bwrap --unshare-net` (bubblewrap), else `unshare --net --map-root-
 *     user`. Both need unprivileged user namespaces, which hardened kernels
 *     disable, so availability is PROBED by running a trivial command rather
 *     than inferred from the binary existing.
 *   - Anything else (Windows, a kernel with userns off, a container without the
 *     capability): unavailable, reported as such, and the command is NOT run.
 *     Failing open here would be the whole bug.
 *
 * Verbs:
 *   detect [--json]            what this machine has. Exit 0 available, 69 not.
 *   run [--allow-loopback] -- <argv…>
 *                              run argv under it. Exit = the child's, or 69
 *                              when there is no sandbox to run it under.
 *
 * 69 is sysexits' EX_UNAVAILABLE, chosen because a child's own exit code may be
 * anything small and "there was no sandbox" must not be mistaken for "the
 * command ran and said 3".
 *
 * `SANDBOX_PROBE_FORCE_UNAVAILABLE=1` forces the unavailable branch, so the
 * fail-closed path is testable on a machine that does have a sandbox.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** sysexits EX_UNAVAILABLE: no sandbox primitive on this machine. */
export const EXIT_SANDBOX_UNAVAILABLE = 69;
/** Bad arguments. */
const EXIT_USAGE = 2;

const USAGE = [
  "sandbox-probe.mjs detect [--json]",
  "sandbox-probe.mjs run [--allow-loopback] [--strip-env] [--deny-read <dir>]… -- <command> [args…]",
  "sandbox-probe.mjs connect <host> <port> [timeout-ms]",
].join("\n");

// ---------------------------------------------------------------------------
// The macOS profile
// ---------------------------------------------------------------------------

/**
 * An SBPL profile that denies outbound IP networking and nothing else.
 *
 * `(allow default)` first, then the denial: SBPL takes the LAST matching rule,
 * so an allow-list of exceptions is written after the deny. This is deliberately
 * a deny-LIST rather than the `(deny default)` posture a real isolation sandbox
 * would take. The property under test is egress, and a deny-default profile
 * spends its whole budget on re-allowing dyld, /dev/urandom, temporary
 * directories and the process's own binary, which is a different task with a
 * different failure mode.
 *
 * `network-outbound` covers AF_UNIX connects as well as AF_INET, so the unix
 * exception is explicit. Without it, everything from DNS's mDNSResponder socket
 * to ordinary local IPC dies, and the sandbox stops being usable for the
 * `npm test` case the design cares about.
 */
function macosProfile(allowLoopback, denyReadSubpaths = []) {
  const lines = [
    "(version 1)",
    "(allow default)",
    ";; APRV-193: deny outbound network. Last match wins, so exceptions follow.",
    "(deny network-outbound)",
    ";; Unix-domain sockets are network-outbound to Seatbelt. Local IPC is not",
    ";; egress, and denying it breaks the process before it can prove anything.",
    '(allow network-outbound (regex #"^/"))',
  ];
  if (allowLoopback) {
    lines.push(
      ";; --allow-loopback: the gate's web channel binds 127.0.0.1 (channels/web.ts).",
      '(allow network-outbound (remote ip "localhost:*"))',
    );
  }
  for (const path of denyReadSubpaths) {
    // The custody half, prototyped: material the granted process has no business
    // reading is unreadable to it, whatever its uid says. Seatbelt only; the
    // Linux mechanisms here have no filesystem story (see the design doc).
    //
    // The path is RESOLVED first. Seatbelt matches `subpath` against the kernel's
    // resolved path, so a profile naming `/tmp/x` on macOS denies nothing at all,
    // because the file the process opens is `/private/tmp/x`. A profile that
    // silently protects nothing is the worst artifact this design could ship, so
    // the resolution happens here rather than in each caller's head.
    let resolved = path;
    try {
      resolved = realpathSync(path);
    } catch {
      // A path that does not exist yet cannot be resolved; deny the literal form,
      // which is still correct wherever no symlink stands in the way.
    }
    lines.push(`(deny file-read* (subpath ${JSON.stringify(resolved)}))`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The environment a starved child gets.
 *
 * An allowlist rather than a denylist, and short. `approval run` today spawns
 * with no `env` option at all, so the child inherits every variable the session
 * holds, which is how a vault passphrase reaches code nobody approved. The
 * carried names are the ones a build needs plus APRV-194's list of runtime
 * variables that are known to hold no secret.
 */
const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "SHELL",
  "USER",
  "LOGNAME",
  "TERM",
  "APPROVAL_HUMAN",
  "APPROVAL_AGENT",
  "APPROVAL_ASCII",
  "APPROVAL_MD",
  "APPROVAL_HOME",
  "APPROVAL_DIR",
];

function starvedEnv(source) {
  const env = {};
  for (const name of ENV_ALLOWLIST) {
    const value = source[name];
    if (typeof value === "string") env[name] = value;
  }
  return env;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Does `argv` run successfully? Used to PROBE a mechanism rather than trust that
 * a binary on PATH implies a working kernel feature: `bwrap` installed on a
 * kernel with `kernel.unprivileged_userns_clone=0` exists and fails.
 */
function probes(argv) {
  const result = spawnSync(argv[0], argv.slice(1), { stdio: "ignore", timeout: 10_000 });
  return result.error === undefined && result.status === 0;
}

function onPath(binary) {
  const result = spawnSync("command", ["-v", binary], { shell: true, stdio: "ignore" });
  return result.status === 0;
}

/**
 * What this machine has.
 *
 * Returns `{ available, mechanism, reason, loopback }`. `loopback` says whether
 * `--allow-loopback` means anything here: on macOS the profile can name
 * `localhost:*`, while a Linux network namespace has its own empty `lo` with the
 * interface down, so the host's 127.0.0.1 is unreachable and no flag brings it
 * back. That asymmetry is a design input, not a defect of this script.
 */
export function detect(platform = process.platform) {
  if (process.env["SANDBOX_PROBE_FORCE_UNAVAILABLE"] === "1") {
    return {
      available: false,
      mechanism: null,
      loopback: false,
      reason: "SANDBOX_PROBE_FORCE_UNAVAILABLE=1 is set (test override)",
    };
  }
  if (platform === "darwin") {
    if (!existsSync("/usr/bin/sandbox-exec")) {
      return {
        available: false,
        mechanism: null,
        loopback: false,
        reason: "/usr/bin/sandbox-exec is missing",
      };
    }
    const dir = mkdtempSync(join(tmpdir(), "sandbox-probe-detect-"));
    try {
      const profile = join(dir, "probe.sb");
      writeFileSync(profile, macosProfile(false), { mode: 0o600 });
      if (!probes(["/usr/bin/sandbox-exec", "-f", profile, "/usr/bin/true"])) {
        return {
          available: false,
          mechanism: null,
          loopback: false,
          reason: "sandbox-exec exists but refused a trivial profile",
        };
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return { available: true, mechanism: "sandbox-exec", loopback: true, reason: "" };
  }
  if (platform === "linux") {
    if (onPath("bwrap") && probes(["bwrap", "--unshare-net", "--dev-bind", "/", "/", "true"])) {
      return { available: true, mechanism: "bwrap", loopback: false, reason: "" };
    }
    if (onPath("unshare") && probes(["unshare", "--net", "--map-root-user", "true"])) {
      return { available: true, mechanism: "unshare", loopback: false, reason: "" };
    }
    return {
      available: false,
      mechanism: null,
      loopback: false,
      reason:
        "neither bwrap nor unshare could create a network namespace; unprivileged user namespaces are probably disabled",
    };
  }
  return {
    available: false,
    mechanism: null,
    loopback: false,
    reason: `no egress-denial primitive is wired for platform ${JSON.stringify(platform)}`,
  };
}

// ---------------------------------------------------------------------------
// The wrapper
// ---------------------------------------------------------------------------

/**
 * The argv that runs `childArgv` under `mechanism`, plus the temp directory the
 * caller must remove (macOS writes a profile file; the Linux mechanisms take
 * their whole configuration on the command line).
 */
export function wrap(mechanism, childArgv, allowLoopback, denyRead = []) {
  if (mechanism === "sandbox-exec") {
    const dir = mkdtempSync(join(tmpdir(), "sandbox-probe-"));
    const profile = join(dir, "egress-denied.sb");
    writeFileSync(profile, macosProfile(allowLoopback, denyRead), { mode: 0o600 });
    return { argv: ["/usr/bin/sandbox-exec", "-f", profile, ...childArgv], cleanup: dir };
  }
  if (mechanism === "bwrap") {
    return {
      argv: ["bwrap", "--unshare-net", "--dev-bind", "/", "/", "--die-with-parent", ...childArgv],
      cleanup: null,
    };
  }
  if (mechanism === "unshare") {
    return { argv: ["unshare", "--net", "--map-root-user", ...childArgv], cleanup: null };
  }
  throw new Error(`unknown mechanism ${JSON.stringify(mechanism)}`);
}

function runUnderSandbox(childArgv, options, stdio) {
  const found = detect();
  if (!found.available) return { unavailable: found.reason, status: null };
  const { argv, cleanup } = wrap(found.mechanism, childArgv, options.allowLoopback, options.denyRead);
  try {
    const child = spawnSync(argv[0], argv.slice(1), {
      stdio,
      encoding: "utf8",
      ...(options.stripEnv ? { env: starvedEnv(process.env) } : {}),
    });
    return {
      unavailable: null,
      status: child.error === undefined ? (child.status ?? 1) : 1,
      stdout: child.stdout ?? "",
      stderr: child.stderr ?? "",
      error: child.error === undefined ? null : child.error.message,
      mechanism: found.mechanism,
    };
  } finally {
    if (cleanup !== null) rmSync(cleanup, { recursive: true, force: true });
  }
}

/** Programmatic entry point, for the test. Captures the child's output. */
export function runCaptured(childArgv, options = {}) {
  return runUnderSandbox(
    childArgv,
    { allowLoopback: false, stripEnv: false, denyRead: [], ...options },
    ["ignore", "pipe", "pipe"],
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * The egress attempt itself, as a child this script can be asked to be.
 *
 * `run -- node scripts/sandbox-probe.mjs connect <host> <port> <ms>` is the
 * whole demonstration in one line, with no dependency on `curl` existing and,
 * pointed at RFC 5737's TEST-NET-1 (192.0.2.0/24), with no packet that could
 * reach anything real. It reports the SHAPE of the failure, which is the part
 * that matters: outside a sandbox a non-routable address TIMES OUT, and inside
 * one the socket is refused in milliseconds. "Slow" and "denied" are different
 * facts, and a test that accepted either would pass with the sandbox switched
 * off.
 */
function connectProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    void import("node:net").then(({ Socket }) => {
      const started = Date.now();
      const socket = new Socket();
      let settled = false;
      const done = (outcome, code) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve({ outcome, code, ms: Date.now() - started });
      };
      socket.setTimeout(timeoutMs, () => done("timeout", null));
      socket.on("error", (error) => done("error", error.code ?? error.message));
      socket.connect(port, host, () => done("connected", null));
    });
  });
}

function main(argv) {
  const verb = argv[0];
  if (verb === "connect") {
    const [host, port, ms] = argv.slice(1);
    if (host === undefined || port === undefined) {
      process.stderr.write(`${USAGE}\n`);
      return EXIT_USAGE;
    }
    void connectProbe(host, Number(port), Number(ms ?? "3000")).then((verdict) => {
      process.stdout.write(`${JSON.stringify(verdict)}\n`);
      process.exitCode = verdict.outcome === "connected" ? 0 : 1;
    });
    return undefined;
  }
  if (verb === "detect") {
    const json = argv.includes("--json");
    const found = detect();
    if (json) {
      process.stdout.write(`${JSON.stringify(found)}\n`);
    } else if (found.available) {
      process.stdout.write(
        `sandbox available: ${found.mechanism} (loopback ${found.loopback ? "allowable" : "unreachable"})\n`,
      );
    } else {
      process.stdout.write(`sandbox unavailable: ${found.reason}\n`);
    }
    return found.available ? 0 : EXIT_SANDBOX_UNAVAILABLE;
  }
  if (verb === "run") {
    const separator = argv.indexOf("--");
    if (separator === -1 || argv.length === separator + 1) {
      process.stderr.write(`sandbox-probe: run needs \`-- <command>\`\n${USAGE}\n`);
      return EXIT_USAGE;
    }
    const ours = argv.slice(1, separator);
    const denyRead = [];
    for (let i = 0; i < ours.length; i += 1) {
      if (ours[i] === "--deny-read" && ours[i + 1] !== undefined) denyRead.push(ours[i + 1]);
    }
    const childArgv = argv.slice(separator + 1);
    const result = runUnderSandbox(
      childArgv,
      {
        allowLoopback: ours.includes("--allow-loopback"),
        stripEnv: ours.includes("--strip-env"),
        denyRead,
      },
      "inherit",
    );
    if (result.unavailable !== null) {
      // Fail closed, loudly, and do NOT fall back to running it unsandboxed.
      process.stderr.write(`sandbox unavailable: ${result.unavailable}; the command was not run\n`);
      return EXIT_SANDBOX_UNAVAILABLE;
    }
    if (result.error !== null) process.stderr.write(`sandbox-probe: ${result.error}\n`);
    return result.status;
  }
  process.stderr.write(`${USAGE}\n`);
  return EXIT_USAGE;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
