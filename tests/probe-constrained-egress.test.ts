import assert from "node:assert/strict";
import { test } from "node:test";

// Plain Node ESM on purpose, like the other probes: an operator runs it from a
// checkout before any build.
// @ts-expect-error no declaration file for the standalone probe script
import * as egress from "../../scripts/probes/constrained-egress.mjs";

const {
  EXIT_SANDBOX_UNAVAILABLE,
  authorityAllowed,
  detectSeatbelt,
  harnessProfile,
  probe,
  spawnedProfile,
  startPinningProxy,
} = egress as {
  EXIT_SANDBOX_UNAVAILABLE: number;
  authorityAllowed: (authority: unknown, allow: string[]) => boolean;
  detectSeatbelt: (platform?: string) => { available: boolean; reason: string };
  harnessProfile: (port: number) => string;
  probe: (json?: boolean, write?: (text: string) => void) => Promise<number>;
  spawnedProfile: () => string;
  startPinningProxy: (options: {
    allow: string[];
    map?: Record<string, string>;
    port?: number;
    onDecision?: (decision: "admitted" | "refused", authority: string) => void;
  }) => Promise<{ port: number; refusals: string[]; admitted: string[]; close: () => Promise<void> }>;
};

// ---------------------------------------------------------------------------
// The pinning decision (pure, so it is tested without a socket)
// ---------------------------------------------------------------------------

test("the allow-list matches an exact authority and nothing else", () => {
  const allow = ["api.provider.test:443"];
  assert.equal(authorityAllowed("api.provider.test:443", allow), true);
  assert.equal(authorityAllowed("API.PROVIDER.TEST:443", allow), true, "case-insensitive");
  assert.equal(authorityAllowed("  api.provider.test:443  ", allow), true, "trimmed");

  // The port is part of the identity.
  assert.equal(authorityAllowed("api.provider.test:8080", allow), false);
  // A suffix is not a match: this is how allow-lists leak.
  assert.equal(authorityAllowed("api.provider.test.evil.test:443", allow), false);
  assert.equal(authorityAllowed("evil.test:443", allow), false);
  // No wildcards are honoured, in either direction.
  assert.equal(authorityAllowed("*:443", allow), false);
  assert.equal(authorityAllowed("api.provider.test:443", ["*:443"]), false);
});

test("a malformed authority is refused rather than falling through to a tunnel", () => {
  const allow = ["api.provider.test:443"];
  for (const bad of ["", "   ", "api.provider.test", "api.provider.test:", ":443", "a b:443", null, undefined, 443, {}]) {
    assert.equal(authorityAllowed(bad, allow), false, `${JSON.stringify(bad)} must be refused`);
  }
  assert.equal(authorityAllowed("api.provider.test:443", []), false, "an empty allow-list admits nothing");
});

// ---------------------------------------------------------------------------
// The profiles
// ---------------------------------------------------------------------------

test("the harness profile admits exactly one loopback port and denies the rest", () => {
  const profile = harnessProfile(48291);
  assert.match(profile, /\(deny network-outbound\)/u);
  assert.match(profile, /\(allow network-outbound \(remote ip "localhost:48291"\)\)/u);
  // Unix sockets stay allowed: they are network-outbound to Seatbelt but are
  // not egress, and denying them kills the process before it does anything.
  assert.match(profile, /\(allow network-outbound \(regex #"\^\/"\)\)/u);
  // The wide carve-out must not appear: localhost:* would admit every service
  // on the machine, which is the thing this design is narrowing.
  assert.equal(profile.includes('localhost:*'), false);
});

test("the spawned-command profile has no door at all", () => {
  const profile = spawnedProfile();
  assert.match(profile, /\(deny network-outbound\)/u);
  assert.equal(/remote ip/u.test(profile), false, "no port is admitted to a spawned command");
});

// ---------------------------------------------------------------------------
// The proxy, over a real socket
// ---------------------------------------------------------------------------

test("the proxy refuses a non-listed authority with 403 and never opens a tunnel", async () => {
  const proxy = await startPinningProxy({ allow: ["api.provider.test:443"] });
  try {
    const response = await fetch(`http://127.0.0.1:${String(proxy.port)}/`, { method: "GET" });
    assert.equal(response.status, 405, "a plain GET is not a second way out");

    // Drive a CONNECT by hand; fetch cannot issue one.
    const { createConnection } = await import("node:net");
    const answer = await new Promise<string>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port: proxy.port }, () => {
        socket.write("CONNECT telemetry.vendor.test:443 HTTP/1.1\r\nHost: telemetry.vendor.test:443\r\n\r\n");
      });
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        if (buffer.includes("\r\n\r\n")) {
          socket.destroy();
          resolve(buffer);
        }
      });
      socket.on("error", () => resolve("ERROR"));
      setTimeout(() => {
        socket.destroy();
        resolve(buffer || "TIMEOUT");
      }, 5000);
    });
    assert.match(answer, /403 Forbidden/u);
    assert.deepEqual(proxy.refusals, ["telemetry.vendor.test:443"]);
    assert.deepEqual(proxy.admitted, [], "nothing was admitted");
  } finally {
    await proxy.close();
  }
});

test("a client that resets the socket on a refusal does not take the proxy down (APRV-351)", async () => {
  // Observed 2026-09-18 on the operator's round trip: the harness sent a
  // CONNECT for an authority off the allow-list, got the 403 and reset the
  // connection without reading it; the unhandled ECONNRESET killed the proxy
  // before it had logged the refusal, and the sandboxed harness then hung on a
  // proxy that no longer existed. The refusal is the one line that run exists
  // to produce, so a reset is a closed tunnel and the proxy keeps serving.
  const decisions: string[] = [];
  const proxy = await startPinningProxy({
    allow: ["api.provider.test:443"],
    onDecision: (decision, authority) => decisions.push(`${decision} ${authority}`),
  });
  try {
    const { createConnection } = await import("node:net");
    await new Promise<void>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port: proxy.port }, () => {
        socket.write("CONNECT telemetry.vendor.test:443 HTTP/1.1\r\nHost: telemetry.vendor.test:443\r\n\r\n", () => {
          // RST rather than FIN: the shape a dropped connection takes on the wire.
          socket.resetAndDestroy();
          resolve();
        });
      });
      socket.on("error", () => resolve());
    });
    // Let the server side observe the reset before asking it anything else.
    await new Promise((resolve) => setTimeout(resolve, 100));

    // The proxy is still alive and still deciding.
    const answer = await new Promise<string>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port: proxy.port }, () => {
        socket.write("CONNECT other.vendor.test:443 HTTP/1.1\r\nHost: other.vendor.test:443\r\n\r\n");
      });
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        if (buffer.includes("\r\n\r\n")) {
          socket.destroy();
          resolve(buffer);
        }
      });
      socket.on("error", () => resolve("ERROR"));
      setTimeout(() => {
        socket.destroy();
        resolve(buffer || "TIMEOUT");
      }, 5000);
    });
    assert.match(answer, /403 Forbidden/u);
    assert.deepEqual(proxy.refusals, ["telemetry.vendor.test:443", "other.vendor.test:443"]);
    assert.deepEqual(decisions, ["refused telemetry.vendor.test:443", "refused other.vendor.test:443"]);
  } finally {
    await proxy.close();
  }
});

// ---------------------------------------------------------------------------
// The whole matrix
// ---------------------------------------------------------------------------

/**
 * Run the matrix ONCE and report each assertion separately.
 *
 * The first cut of this suite was a single case asserting `code === 0`, which
 * is a true statement and a useless failure: a broken proxy and a broken
 * profile produced the same red line, naming neither. The matrix is expensive
 * (it spawns sandboxed children), so it runs once and is memoized, and each
 * assertion below reads its own row out of the result.
 */
interface MatrixResult {
  skipped: boolean;
  code: number;
  results: { name: string; claim: string; pass: boolean; detail: string }[];
}

let matrixRun: Promise<MatrixResult> | null = null;

function matrix(): Promise<MatrixResult> {
  matrixRun ??= (async () => {
    const chunks: string[] = [];
    const code = await probe(true, (text: string) => {
      chunks.push(text);
    });
    const parsed = JSON.parse(chunks.join("")) as {
      skipped: boolean;
      results?: MatrixResult["results"];
    };
    return { skipped: parsed.skipped, code, results: parsed.results ?? [] };
  })();
  return matrixRun;
}

/** One named assertion from the matrix, or a clean skip where there is no Seatbelt. */
function assertion(name: string, why: string): void {
  test(why, async () => {
    const run = await matrix();
    if (run.skipped) {
      assert.equal(
        run.code,
        EXIT_SANDBOX_UNAVAILABLE,
        "a machine without the primitive reports EX_UNAVAILABLE rather than a false pass",
      );
      return;
    }
    const row = run.results.find((result) => result.name === name);
    assert.notEqual(row, undefined, `the matrix produced no assertion named ${name}`);
    assert.equal(row?.pass, true, `${name}: ${row?.claim ?? ""} — observed: ${row?.detail ?? ""}`);
  });
}

assertion(
  "seatbelt-rejects-hostname-rules-outright",
  "Seatbelt refuses to COMPILE a hostname rule, which is why a proxy is needed at all",
);
assertion(
  "seatbelt-filters-by-address-not-name",
  "the remote-ip predicate matches an address and port, never a name",
);
assertion(
  "direct-connection-denied",
  "under the harness profile a direct connection bypassing the proxy is denied",
);
assertion(
  "allowed-host-through-proxy-succeeds",
  "a request through the proxy to an allow-listed host completes",
);
assertion(
  "non-listed-host-through-proxy-denied",
  "the proxy refuses a non-listed authority, so the admitted port is not a general door",
);
assertion(
  "spawned-command-has-no-network",
  "a command the harness spawns inherits no network at all",
);
assertion(
  "proxy-refused-what-it-should",
  "the proxy's own ledger shows it admitted only the allow-listed authority",
);

test("the matrix as a whole passes, or skips cleanly where there is no Seatbelt", async () => {
  const run = await matrix();
  assert.equal(
    run.code,
    run.skipped ? EXIT_SANDBOX_UNAVAILABLE : 0,
    run.skipped ? "a skip is EX_UNAVAILABLE" : "every assertion in the matrix held",
  );
  if (!run.skipped) {
    assert.equal(run.results.length, 7, "and the matrix ran every assertion it claims to have");
  }
});

test("detectSeatbelt reports unavailable off macOS instead of guessing", () => {
  const linux = detectSeatbelt("linux");
  assert.equal(linux.available, false);
  assert.match(linux.reason, /macOS-only/u);
});
