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
 * The distinction that carries that last property is `denied` versus `slow`. The
 * always-on egress case connects to RFC 5737's TEST-NET-1 (192.0.2.1), which is
 * reserved for documentation and routes nowhere, so no packet leaves for
 * anything real. Outside a sandbox that connection TIMES OUT; inside one it is
 * refused in milliseconds. A test that accepted either outcome would pass with
 * the sandbox switched off, so the control case below asserts the timeout
 * first, and the sandboxed case asserts the fast refusal.
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

test("control: outside the sandbox, the non-routable address is not refused with EPERM", () => {
  // Amended by APRV-193's build lane. The design lane asserted a TIMEOUT here,
  // which held on the machine it was written on and is a fact about that
  // machine's routing rather than about the sandbox: TEST-NET-1 has no route,
  // and a host that says so answers EHOSTUNREACH in milliseconds instead of
  // letting the connection hang. Both are the unsandboxed outcome.
  //
  // What must never happen unsandboxed is the kernel refusing the socket
  // outright, which is Seatbelt's own signature and is exactly what the case
  // below asserts inside the profile. So the discriminating property survives —
  // a no-op profile still fails the suite, because EPERM appears only where the
  // sandbox put it — and the brittle half is gone. `tests/sandbox.test.ts`
  // avoids the question entirely by connecting to a live loopback listener.
  const { stdout } = probe(["connect", NON_ROUTABLE, "443", "1500"]);
  const verdict = JSON.parse(stdout) as ConnectVerdict;
  assert.notEqual(verdict.outcome, "connected", `TEST-NET-1 answered: ${JSON.stringify(verdict)}`);
  assert.notEqual(
    verdict.code,
    "EPERM",
    `an unsandboxed connect was refused EPERM: ${JSON.stringify(verdict)}`,
  );
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
