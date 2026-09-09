/**
 * The egress-denial sandbox prototype (APRV-193, design lane).
 *
 * What is under test is a CAPABILITY of the machine, not a pure function, so the
 * suite is written to be honest about that in both directions. Where the
 * platform has no primitive every substantive case skips, loudly, with the
 * reason the probe gave; where it has one, the cases prove the two halves the
 * design rests on — a child can still write files, and a child cannot reach the
 * network — and they prove them in a way a broken sandbox would FAIL rather than
 * pass.
 *
 * The distinction that carries that last property is `denied` versus
 * `unreachable`. The always-on egress case connects to RFC 5737's TEST-NET-1
 * (192.0.2.1), which is reserved for documentation and routes nowhere, so no
 * packet leaves for anything real. Inside a sandbox the kernel refuses the
 * socket itself, with EPERM, in milliseconds; outside one the connection fails
 * some other way, and WHICH other way is a fact about the host's routing rather
 * than about this code. A machine with no opinion about the address hangs until
 * the timeout, a machine whose stack knows there is no route answers
 * EHOSTUNREACH at once, and both say the same thing: no bytes reached the
 * network (APRV-286).
 *
 * So the control asserts the SHAPE rather than one host's spelling of it: an
 * enumerated set of outcomes that all prove egress did not happen, with the
 * sandbox's own EPERM excluded from that set, so a no-op profile still fails the
 * suite. It carries a second leg that needs no route at all, a connect to a
 * closed 127.0.0.1 port, which answers ECONNREFUSED on every machine and answers
 * EPERM under the profile. That leg pins the discriminating property even on a
 * host with no network configured.
 *
 * The `curl https://example.com` demonstration the task asks for is here too,
 * behind `SANDBOX_PROBE_EXTERNAL=1`. It is opt-in because `npm test` should make
 * no external request in anyone's CI, and because the point it proves is already
 * proved by the non-routable case: it is a demonstration for a human reading a
 * transcript rather than an assertion the suite needs.
 *
 * The script is spawned rather than imported, as `tests/classify-tier.test.ts`
 * spawns its subject, because the fail-closed behaviour under test is an exit
 * code and an argv, and an import would not see either.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/** The repository root, from `dist/tests/` at runtime. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = join(REPO_ROOT, "scripts", "sandbox-probe.mjs");

/** sysexits EX_UNAVAILABLE, mirrored from the script. */
const EXIT_SANDBOX_UNAVAILABLE = 69;

/** TEST-NET-1 (RFC 5737): reserved for documentation, routed nowhere. */
const NON_ROUTABLE = "192.0.2.1";

/**
 * The failure codes that mean "the connection did not happen, and this machine's
 * NETWORK is why" (APRV-286).
 *
 * Every one of them is a fact about routing, or about a peer that answered with
 * a reset. All of them are reachable by an ordinary process with no sandbox
 * anywhere near it, and all of them prove the same thing the control needs: no
 * bytes reached the network.
 *
 * EPERM and EACCES are deliberately absent, and their absence is what keeps the
 * control discriminating. The kernel refusing to open the socket at all is
 * Seatbelt's signature, and the sandboxed case below asserts exactly that, so a
 * no-op profile still FAILS this suite: a shape only a sandbox produces can
 * never satisfy the control.
 */
const NOT_SANDBOXED_CODES: ReadonlySet<string> = new Set([
  "EHOSTUNREACH", // the host knows there is no route, and says so in milliseconds
  "ENETUNREACH", // no route to that network at all
  "ENETDOWN", // the interface is down, so there is nothing to send from
  "EADDRNOTAVAIL", // no usable source address for that destination
  "ETIMEDOUT", // the kernel's own connect timeout beat the socket's
  "ECONNREFUSED", // something answered with a reset: a closed port, or a middlebox
]);

/**
 * Does `verdict` prove an UNSANDBOXED failure? Returns null when it does, and
 * otherwise the reason it does not, for the assertion message.
 *
 * Unrecognised codes are rejected rather than waved through, so a novel shape
 * stops the suite and a human decides what it meant instead of the control
 * quietly widening to cover it.
 */
function unsandboxedShape(verdict: ConnectVerdict): string | null {
  if (verdict.outcome === "connected") {
    return "the address answered, so bytes reached the network";
  }
  if (verdict.outcome === "timeout") return null;
  if (verdict.outcome !== "error") {
    return `unknown outcome ${JSON.stringify(verdict.outcome)}`;
  }
  if (verdict.code === "EPERM" || verdict.code === "EACCES") {
    return `the kernel refused the socket (${verdict.code}), which is the SANDBOX's signature and must not appear without one`;
  }
  if (verdict.code === null || !NOT_SANDBOXED_CODES.has(verdict.code)) {
    return `unrecognised failure code ${String(verdict.code)}: add it to NOT_SANDBOXED_CODES if it is an ordinary routing failure`;
  }
  return null;
}

/**
 * A 127.0.0.1 port with nothing listening on it, obtained by binding one and
 * letting it go. Loopback exists on every machine, so this target needs no route
 * and no network configuration, which is the point.
 */
async function closedLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("the loopback listener reported no port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

/** Run the probe's `connect` verb and parse its one line of JSON. */
function connect(host: string, port: number | string): ConnectVerdict {
  const { stdout } = probe(["connect", host, String(port), "1500"]);
  return JSON.parse(stdout) as ConnectVerdict;
}

interface Detection {
  readonly available: boolean;
  readonly mechanism: string | null;
  readonly loopback: boolean;
  readonly reason: string;
}

interface ConnectVerdict {
  readonly outcome: "connected" | "refused" | "timeout" | "error";
  readonly code: string | null;
  readonly ms: number;
}

function probe(
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
}

function detect(): Detection {
  const { stdout } = probe(["detect", "--json"]);
  return JSON.parse(stdout) as Detection;
}

const FOUND = detect();

/** The reason every substantive case gives when it stands down. */
const SKIP = FOUND.available ? false : `no sandbox primitive here: ${FOUND.reason}`;

// ---------------------------------------------------------------------------
// Detection, and the fail-closed path, which are testable everywhere
// ---------------------------------------------------------------------------

test("detect reports a well-formed verdict and an exit code that matches it", () => {
  const { status } = probe(["detect", "--json"]);
  assert.equal(typeof FOUND.available, "boolean");
  assert.equal(typeof FOUND.reason, "string");
  assert.equal(status, FOUND.available ? 0 : EXIT_SANDBOX_UNAVAILABLE);
  if (FOUND.available) {
    assert.ok(
      ["sandbox-exec", "bwrap", "unshare"].includes(FOUND.mechanism ?? ""),
      `unexpected mechanism ${String(FOUND.mechanism)}`,
    );
  } else {
    assert.equal(FOUND.mechanism, null);
    assert.notEqual(FOUND.reason, "", "an unavailable verdict must say why");
  }
});

test("detect's human output names the mechanism or says plainly that there is none", () => {
  const { stdout } = probe(["detect"]);
  assert.match(stdout, FOUND.available ? /^sandbox available: / : /^sandbox unavailable: /);
});

test("with no sandbox, the command is refused and NOT run unsandboxed", () => {
  // The whole design fails open at exactly this line if it is written the other
  // way round, so it is pinned on every platform by forcing the branch.
  const dir = mkdtempSync(join(tmpdir(), "aprv193-failclosed-"));
  try {
    const witness = join(dir, "the-command-ran");
    const { status, stderr } = probe(["run", "--", "/usr/bin/touch", witness], {
      SANDBOX_PROBE_FORCE_UNAVAILABLE: "1",
    });
    assert.equal(status, EXIT_SANDBOX_UNAVAILABLE);
    assert.match(stderr, /sandbox unavailable: /);
    assert.match(stderr, /the command was not run/);
    assert.equal(existsSync(witness), false, "the command ran anyway: the sandbox failed OPEN");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run without `--` is a usage error rather than a silent no-op", () => {
  const { status, stderr } = probe(["run"]);
  assert.equal(status, 2);
  assert.match(stderr, /needs `-- <command>`/);
});

// ---------------------------------------------------------------------------
// The control: unsandboxed, the refusal does not carry the SANDBOX's signature
// ---------------------------------------------------------------------------

test("the shape table accepts every routing failure and rejects the sandbox's refusal", () => {
  // A pure table, so the property AC1 asks for is pinned on every host rather
  // than only on hosts that happen to produce each shape. This is the half that
  // proves the control "still fails if the address is refused by the sandbox
  // denial path", without needing a sandbox to run it.
  const verdict = (outcome: ConnectVerdict["outcome"], code: string | null): ConnectVerdict => ({
    outcome,
    code,
    ms: 5,
  });

  for (const accepted of [
    verdict("timeout", null),
    verdict("error", "EHOSTUNREACH"),
    verdict("error", "ENETUNREACH"),
    verdict("error", "ENETDOWN"),
    verdict("error", "EADDRNOTAVAIL"),
    verdict("error", "ETIMEDOUT"),
    verdict("error", "ECONNREFUSED"),
  ]) {
    assert.equal(unsandboxedShape(accepted), null, JSON.stringify(accepted));
  }

  for (const rejected of [
    verdict("error", "EPERM"), // Seatbelt's refusal
    verdict("error", "EACCES"), // the same refusal, spelled the other way
    verdict("connected", null), // bytes reached the network
    verdict("error", "ECONNRESET"), // unnamed: stop rather than widen silently
    verdict("error", null),
  ]) {
    assert.notEqual(unsandboxedShape(rejected), null, JSON.stringify(rejected));
  }
});

test("control: outside the sandbox, a connect fails in a way only the NETWORK explains", async () => {
  // Two legs, because each covers the other's weakness (APRV-286).
  //
  // The first needs no route to exist at all: a 127.0.0.1 port with nothing on
  // it is refused by the local stack on every machine, in a tunnel, on a laptop
  // with the wifi off. That refusal is ECONNREFUSED, never EPERM, so this leg
  // alone pins the discriminating property the suite rests on. Under the profile
  // the same connect is refused EPERM, which is why loopback is not excepted
  // there.
  const port = await closedLoopbackPort();
  const local = connect("127.0.0.1", port);
  assert.equal(
    local.outcome,
    "error",
    `a closed loopback port did not refuse the connection: ${JSON.stringify(local)}`,
  );
  assert.equal(
    local.code,
    "ECONNREFUSED",
    `an unsandboxed connect to a closed loopback port answered ${String(local.code)} rather than a plain refusal: ${JSON.stringify(local)}`,
  );

  // The second is the address the sandboxed case uses, so the pair is a genuine
  // control for it. Its outcome is a fact about the HOST's routing, so what is
  // asserted is the shape: a host with no opinion about TEST-NET-1 hangs until
  // the timeout, a host whose stack knows there is no route answers EHOSTUNREACH
  // at once, and either proves no bytes left. The design lane asserted the
  // timeout specifically, which held on the machine it was written on and failed
  // twice on Carter's laptop.
  const remote = connect(NON_ROUTABLE, 443);
  const why = unsandboxedShape(remote);
  assert.equal(why, null, `${String(why)}; verdict ${JSON.stringify(remote)}`);
});

// ---------------------------------------------------------------------------
// Inside the sandbox
// ---------------------------------------------------------------------------

test("a file write inside the sandbox succeeds", { skip: SKIP }, () => {
  const dir = mkdtempSync(join(tmpdir(), "aprv193-write-"));
  try {
    const target = join(dir, "written-from-inside");
    const { status } = probe(["run", "--", "/usr/bin/touch", target]);
    assert.equal(status, 0, "touch failed inside the sandbox");
    assert.equal(existsSync(target), true, "the sandbox denied a write it was supposed to allow");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("outbound network inside the sandbox is DENIED, not merely slow", { skip: SKIP }, () => {
  const { stdout } = probe([
    "run",
    "--",
    process.execPath,
    SCRIPT,
    "connect",
    NON_ROUTABLE,
    "443",
    "1500",
  ]);
  const verdict = JSON.parse(stdout) as ConnectVerdict;
  assert.notEqual(verdict.outcome, "connected", "the sandboxed child reached the network");
  assert.equal(
    verdict.outcome,
    "error",
    `expected an immediate socket refusal, got ${JSON.stringify(verdict)}`,
  );
  // EPERM, specifically: the kernel refusing to open the socket at all. That is
  // the sandbox's own signature, and the control above pins that it does not
  // appear without one (amended by the build lane, where the control's timeout
  // turned out to be a fact about one machine's routing).
  assert.equal(
    verdict.code,
    "EPERM",
    `expected the sandbox's EPERM, got ${JSON.stringify(verdict)}`,
  );
  assert.ok(
    verdict.ms < 1000,
    `the connection was refused after ${verdict.ms}ms, which is a timeout wearing a refusal's name`,
  );
});

test("credential starvation: --strip-env keeps a secret-named variable out of the child", { skip: SKIP }, () => {
  const secret = "aprv193-not-a-real-secret";
  const withStrip = probe(["run", "--strip-env", "--", "/usr/bin/printenv", "APPROVAL_TG_TOKEN"], {
    APPROVAL_TG_TOKEN: secret,
  });
  assert.equal(withStrip.status, 1, "printenv found the variable, so the environment was inherited");
  assert.equal(withStrip.stdout.includes(secret), false);

  // The control, which is what makes the case above mean something: today's
  // `approval run` spawns with no `env` option at all, so the child DOES inherit
  // it. This asserts the hole the design closes, so that closing it is a visible
  // change rather than a claim.
  const withoutStrip = probe(["run", "--", "/usr/bin/printenv", "APPROVAL_TG_TOKEN"], {
    APPROVAL_TG_TOKEN: secret,
  });
  assert.equal(withoutStrip.status, 0);
  assert.match(withoutStrip.stdout, new RegExp(secret));
});

test("custody: a --deny-read subpath is unreadable inside, symlinks resolved", { skip: SKIP }, (t) => {
  if (FOUND.mechanism !== "sandbox-exec") {
    t.skip(`${String(FOUND.mechanism)} has no filesystem story in this prototype`);
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "aprv193-custody-"));
  try {
    const file = join(dir, "vault.enc");
    writeFileSync(file, "ciphertext");
    const denied = probe(["run", "--deny-read", dir, "--", "/bin/cat", file]);
    assert.notEqual(denied.status, 0, "the denied subpath was read");
    assert.equal(denied.stdout.includes("ciphertext"), false);

    const allowed = probe(["run", "--", "/bin/cat", file]);
    assert.equal(allowed.status, 0);
    assert.match(allowed.stdout, /ciphertext/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "demonstration: curl https://example.com fails inside the sandbox",
  { skip: SKIP || (process.env["SANDBOX_PROBE_EXTERNAL"] === "1" ? false : "set SANDBOX_PROBE_EXTERNAL=1 to run the external leg") },
  (t) => {
    if (!existsSync("/usr/bin/curl")) {
      t.skip("no /usr/bin/curl on this machine");
      return;
    }
    const { status } = probe([
      "run",
      "--",
      "/usr/bin/curl",
      "-sS",
      "--max-time",
      "8",
      "-o",
      "/dev/null",
      "https://example.com",
    ]);
    assert.notEqual(status, 0, "curl reached example.com from inside the sandbox");
  },
);
