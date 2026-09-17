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
  probe: (json?: boolean) => Promise<number>;
  spawnedProfile: () => string;
  startPinningProxy: (options: {
    allow: string[];
    map?: Record<string, string>;
    port?: number;
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

// ---------------------------------------------------------------------------
// The whole matrix
// ---------------------------------------------------------------------------

test("the constrained-egress matrix holds, or skips cleanly where there is no Seatbelt", async () => {
  const seatbelt = detectSeatbelt();
  const code = await probe(true);

  if (!seatbelt.available) {
    assert.equal(
      code,
      EXIT_SANDBOX_UNAVAILABLE,
      "a machine without the primitive reports EX_UNAVAILABLE rather than a false pass",
    );
    return;
  }
  assert.equal(code, 0, "every assertion in the matrix held");
});

test("detectSeatbelt reports unavailable off macOS instead of guessing", () => {
  const linux = detectSeatbelt("linux");
  assert.equal(linux.available, false);
  assert.match(linux.reason, /macOS-only/u);
});
