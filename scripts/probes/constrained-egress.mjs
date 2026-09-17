#!/usr/bin/env node
/**
 * APRV-351: can a harness run inside the egress sandbox with ONLY its model
 * API reachable?
 *
 * `approval sandbox -- claude` is a session that cannot think: the profile in
 * `src/core/sandbox.ts` denies all outbound network, and a harness needs its
 * model API. The obvious fix — "allow the provider's hosts" — cannot be
 * written, because Seatbelt has no hostname predicate. This probe establishes
 * that limit as a measured fact rather than an assertion, and then measures the
 * mechanism proposed in its place: a local forwarding proxy on loopback that
 * pins an allow-list of provider hosts, admitted by the profile through a
 * single-port carve-out, with everything the harness spawns still under the
 * full egress-deny profile.
 *
 * ## It runs offline, on purpose
 *
 * Every assertion below is proved against stub origin servers on loopback. No
 * assertion needs the internet, a provider, a credential or a model call, so
 * this runs in CI and on a laptop in a tunnel, and a failure means the
 * mechanism broke rather than that a network blipped. The one thing that
 * genuinely cannot be proved offline is a real harness completing a real model
 * round trip, which needs the operator's own credential; that leg is `--round-trip`
 * and it is the single command left for the operator in docs/sandboxed-exec.md.
 *
 * No credential is read, embedded or logged anywhere in this file.
 *
 *   node scripts/probes/constrained-egress.mjs probe [--json]
 *       The whole matrix, offline. Exit 0 if every assertion held, 1 if any
 *       failed, 69 (EX_UNAVAILABLE) if this machine has no Seatbelt.
 *
 *   node scripts/probes/constrained-egress.mjs proxy --allow <host> [...] [--port N]
 *       Run the pinning proxy in the foreground. This is the piece a real
 *       constrained session would run beside the harness.
 *
 *   node scripts/probes/constrained-egress.mjs round-trip --base-url <url>
 *       The credentialed leg. The operator runs this one.
 */

import { spawn, spawnSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createConnection, createServer as createTcpServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);

/** sysexits EX_UNAVAILABLE: no sandbox primitive here, so nothing was measured. */
export const EXIT_SANDBOX_UNAVAILABLE = 69;

// ---------------------------------------------------------------------------
// The pinning proxy
// ---------------------------------------------------------------------------

/**
 * Decide whether the proxy will open a tunnel to this authority.
 *
 * Exact authority match against an allow-list, and nothing cleverer. No suffix
 * matching, because `api.anthropic.com.evil.test` ends with nothing useful and
 * suffix rules are how allow-lists leak; no wildcards, because a wildcard the
 * operator cannot read is a wildcard the operator cannot audit. A port is part
 * of the identity: `host:443` does not admit `host:8080`.
 *
 * Unparseable, empty and missing authorities are refused, so a malformed
 * CONNECT cannot fall through into an open tunnel (SPEC §11.1, fail closed).
 */
export function authorityAllowed(authority, allowList) {
  if (typeof authority !== "string" || authority.trim() === "") return false;
  const normalized = authority.trim().toLowerCase();
  if (!/^[a-z0-9._-]+:[0-9]{1,5}$/u.test(normalized)) return false;
  return allowList.some((entry) => entry.trim().toLowerCase() === normalized);
}

/**
 * A CONNECT proxy that pins an allow-list and tunnels bytes.
 *
 * Deliberately a TUNNEL and not an interceptor. It never terminates TLS, never
 * sees a request body, and never holds a certificate, so the model traffic
 * stays end-to-end encrypted between the harness and the provider and this
 * process cannot read the operator's prompts or the provider's key. What it can
 * do is refuse an authority, which is the entire job.
 *
 * `map` exists for this probe only: it lets a test pin by NAME while resolving
 * to a loopback stub, so assertion 3 and 4 demonstrate hostname pinning without
 * touching the internet. A real session passes no map and ordinary DNS applies.
 */
export function startPinningProxy({ allow, map = {}, port = 0 }) {
  const refusals = [];
  const admitted = [];
  const server = createHttpServer();

  server.on("connect", (request, clientSocket, head) => {
    const authority = request.url ?? "";
    if (!authorityAllowed(authority, allow)) {
      refusals.push(authority);
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.end();
      return;
    }
    admitted.push(authority);
    const target = map[authority.toLowerCase()] ?? authority;
    const [host, rawPort] = target.split(":");
    const upstream = createConnection(
      { host, port: Number(rawPort) },
      () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      },
    );
    upstream.on("error", () => {
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      clientSocket.end();
    });
    clientSocket.on("error", () => upstream.destroy());
  });

  // A plain (non-CONNECT) request is refused too: the proxy is a tunnel, and an
  // absolute-form GET would be a second, unpinned way out.
  server.on("request", (_request, response) => {
    response.writeHead(405, { "content-type": "text/plain" });
    response.end("this proxy tunnels CONNECT only\n");
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        refusals,
        admitted,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/** A stub "provider": answers one line on a TCP socket, so a tunnel is observable. */
function startStubOrigin(banner) {
  const server = createTcpServer((socket) => {
    socket.end(`${banner}\n`);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Seatbelt
// ---------------------------------------------------------------------------

/** Is there a usable `sandbox-exec` here? */
export function detectSeatbelt(platform = process.platform) {
  if (platform !== "darwin") {
    return { available: false, reason: `Seatbelt is macOS-only; this is ${platform}` };
  }
  const probe = spawnSync("sandbox-exec", ["-p", "(version 1)(allow default)", "true"], {
    encoding: "utf8",
  });
  if (probe.error || probe.status !== 0) {
    return { available: false, reason: "sandbox-exec did not accept a trivial profile" };
  }
  return { available: true, reason: "" };
}

/**
 * The profile a CONSTRAINED HARNESS runs under.
 *
 * Identical to the ordinary egress-deny profile in `src/core/sandbox.ts` except
 * for one line: a single loopback PORT is admitted, the port the pinning proxy
 * listens on. That narrowness is the design. The existing
 * `EgressAllowance.loopback` flag opens `localhost:*`, which admits every
 * service on the machine — a database, a dev server, another agent's daemon —
 * and is far too wide to be the standing posture for a harness.
 */
export function harnessProfile(proxyPort) {
  return [
    "(version 1)",
    "(allow default)",
    "(deny network-outbound)",
    ";; AF_UNIX is network-outbound to Seatbelt; local IPC is not egress.",
    '(allow network-outbound (regex #"^/"))',
    ";; The one door: the pinning proxy, by port, on loopback.",
    `(allow network-outbound (remote ip "localhost:${String(proxyPort)}"))`,
  ].join("\n");
}

/** The profile everything the harness SPAWNS runs under: no door at all. */
export function spawnedProfile() {
  return [
    "(version 1)",
    "(allow default)",
    "(deny network-outbound)",
    '(allow network-outbound (regex #"^/"))',
  ].join("\n");
}

/**
 * Run `argv` under `profile` and collect its output.
 *
 * Asynchronous, and that is load-bearing rather than stylistic. The stub
 * origins and the pinning proxy listen inside THIS process, so a `spawnSync`
 * here would block the event loop for the whole life of the child: the child
 * would connect, nothing would ever accept, and every assertion would report a
 * timeout that looked exactly like the sandbox denying it. That false negative
 * is how this function came to be written twice.
 */
function runUnderProfile(profile, argv, scratch, label) {
  const path = join(scratch, `${label}.sb`);
  writeFileSync(path, `${profile}\n`, "utf8");
  return new Promise((resolve) => {
    const child = spawn("sandbox-exec", ["-f", path, ...argv], { encoding: "utf8" });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, status });
    });
  });
}

// ---------------------------------------------------------------------------
// The client the assertions drive
// ---------------------------------------------------------------------------

/**
 * A one-file client, written into the scratch directory and run under a
 * profile. It either connects straight to an origin or asks the proxy for a
 * tunnel, and prints `REACHED` or `BLOCKED:<reason>`.
 *
 * It is a separate file rather than `node -e` because the classifier in this
 * repository refuses `node -e`, and because a file is what an operator can read
 * before running it.
 */
const CLIENT_SOURCE = `
import { createConnection } from "node:net";

const [mode, host, port, authority] = process.argv.slice(2);

function done(text) {
  process.stdout.write(text + "\\n");
  process.exit(0);
}

const socket = createConnection({ host, port: Number(port) }, () => {
  if (mode === "direct") {
    socket.on("data", (chunk) => done("REACHED:" + chunk.toString().trim()));
    return;
  }
  socket.write("CONNECT " + authority + " HTTP/1.1\\r\\nHost: " + authority + "\\r\\n\\r\\n");
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    if (buffer.includes("403")) done("BLOCKED:proxy-refused-authority");
    if (buffer.includes("502")) done("BLOCKED:proxy-upstream-failed");
    if (buffer.includes("200 Connection Established") && buffer.includes("\\n", buffer.indexOf("200"))) {
      const body = buffer.split("\\r\\n\\r\\n").slice(1).join("\\r\\n\\r\\n").trim();
      if (body !== "") done("REACHED:" + body);
    }
  });
});
socket.on("error", (error) => done("BLOCKED:" + error.code));
setTimeout(() => done("BLOCKED:timeout"), 8000);
`;

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

export async function probe(json = false) {
  const seatbelt = detectSeatbelt();
  if (!seatbelt.available) {
    const message = `constrained-egress probe: SKIPPED — ${seatbelt.reason}\n`;
    process.stdout.write(json ? `${JSON.stringify({ skipped: true, reason: seatbelt.reason })}\n` : message);
    return EXIT_SANDBOX_UNAVAILABLE;
  }

  const scratch = mkdtempSync(join(tmpdir(), "aprv351-egress-"));
  const client = join(scratch, "client.mjs");
  writeFileSync(client, CLIENT_SOURCE, "utf8");

  const allowed = await startStubOrigin("PROVIDER-ALLOWED");
  const other = await startStubOrigin("PROVIDER-NOT-LISTED");
  const allowedAuthority = "api.provider.test:443";
  const otherAuthority = "telemetry.vendor.test:443";
  const proxy = await startPinningProxy({
    allow: [allowedAuthority],
    map: {
      [allowedAuthority]: `127.0.0.1:${String(allowed.port)}`,
      [otherAuthority]: `127.0.0.1:${String(other.port)}`,
    },
  });

  const results = [];
  const check = (name, claim, pass, detail) => {
    results.push({ name, claim, pass, detail });
  };

  try {
    // -- 0. Seatbelt REFUSES to compile a hostname rule ---------------------
    //
    // The most direct evidence there is, and the reason this whole design has
    // to reach for a proxy. `sandbox-exec` does not merely ignore a hostname,
    // it refuses the profile: "host must be * or localhost in network address".
    // Two tokens, neither of which is a provider. There is no SBPL spelling of
    // "allow api.anthropic.com" to be found by trying harder.
    const byName = await runUnderProfile(
      [
        "(version 1)",
        "(allow default)",
        "(deny network-outbound)",
        '(allow network-outbound (remote ip "api.provider.test:443"))',
      ].join("\n"),
      [process.execPath, "--version"],
      scratch,
      "by-name",
    );
    const byAddress = await runUnderProfile(
      [
        "(version 1)",
        "(allow default)",
        "(deny network-outbound)",
        '(allow network-outbound (remote ip "127.0.0.1:443"))',
      ].join("\n"),
      [process.execPath, "--version"],
      scratch,
      "by-address",
    );
    check(
      "seatbelt-rejects-hostname-rules-outright",
      "A Seatbelt profile naming a hostname, or any literal IP, does not compile: the only accepted hosts are `*` and `localhost`",
      byName.status !== 0 &&
        /host must be \* or localhost/u.test(byName.stderr) &&
        byAddress.status !== 0,
      `hostname rule: exit ${String(byName.status)}, ${byName.stderr.split("\n")[0]?.trim() ?? ""}; literal-IP rule: exit ${String(byAddress.status)}, ${byAddress.stderr.split("\n")[0]?.trim() ?? ""}`,
    );

    // -- 1. Seatbelt cannot filter by hostname -----------------------------
    //
    // The profile admits ONE loopback port. Both stub origins are on loopback,
    // both would be named differently by DNS, and the profile cannot tell them
    // apart by name — only by address and port. Reaching the admitted port and
    // failing the other proves the predicate is an ADDRESS predicate. There is
    // no SBPL form that would have expressed "allow api.provider.test".
    const narrow = harnessProfile(allowed.port);
    const toAdmittedPort = await runUnderProfile(
      narrow,
      [process.execPath, client, "direct", "127.0.0.1", String(allowed.port)],
      scratch,
      "narrow-admitted",
    );
    const toOtherPort = await runUnderProfile(
      narrow,
      [process.execPath, client, "direct", "127.0.0.1", String(other.port)],
      scratch,
      "narrow-other",
    );
    check(
      "seatbelt-filters-by-address-not-name",
      "Seatbelt's `remote ip` predicate matches an address and port, never a hostname, so a provider allow-list cannot be written as a profile rule",
      toAdmittedPort.stdout.includes("REACHED") && toOtherPort.stdout.includes("BLOCKED"),
      `admitted port: ${toAdmittedPort.stdout.trim()}; other port: ${toOtherPort.stdout.trim()}`,
    );

    // -- 2. A direct connection from the harness fails ---------------------
    const viaProxyProfile = harnessProfile(proxy.port);
    const direct = await runUnderProfile(
      viaProxyProfile,
      [process.execPath, client, "direct", "127.0.0.1", String(allowed.port)],
      scratch,
      "direct",
    );
    check(
      "direct-connection-denied",
      "Under the harness profile, a direct connection that bypasses the proxy is denied",
      direct.stdout.includes("BLOCKED"),
      direct.stdout.trim(),
    );

    // -- 3. Through the proxy to an allowed host succeeds -------------------
    const allowedThrough = await runUnderProfile(
      viaProxyProfile,
      [process.execPath, client, "proxy", "127.0.0.1", String(proxy.port), allowedAuthority],
      scratch,
      "allowed",
    );
    check(
      "allowed-host-through-proxy-succeeds",
      "Under the harness profile, a request through the proxy to an allow-listed host completes",
      allowedThrough.stdout.includes("REACHED:PROVIDER-ALLOWED"),
      allowedThrough.stdout.trim(),
    );

    // -- 4. Through the proxy to a non-listed host fails --------------------
    const blockedThrough = await runUnderProfile(
      viaProxyProfile,
      [process.execPath, client, "proxy", "127.0.0.1", String(proxy.port), otherAuthority],
      scratch,
      "not-listed",
    );
    check(
      "non-listed-host-through-proxy-denied",
      "The proxy refuses an authority that is not on the allow-list, so the single admitted port is not a general door",
      blockedThrough.stdout.includes("BLOCKED:proxy-refused-authority"),
      blockedThrough.stdout.trim(),
    );

    // -- 5. A command the harness spawns has no network --------------------
    //
    // The whole posture depends on this: the harness may reach its provider,
    // but code the harness writes and runs must not inherit that door.
    const spawned = await runUnderProfile(
      spawnedProfile(),
      [process.execPath, client, "proxy", "127.0.0.1", String(proxy.port), allowedAuthority],
      scratch,
      "spawned",
    );
    check(
      "spawned-command-has-no-network",
      "A command spawned under the ordinary profile cannot reach even the proxy, so the harness's door is not inherited",
      spawned.stdout.includes("BLOCKED"),
      spawned.stdout.trim(),
    );

    check(
      "proxy-refused-what-it-should",
      "The proxy's own ledger shows it admitted only the allow-listed authority",
      proxy.refusals.includes(otherAuthority) && !proxy.refusals.includes(allowedAuthority),
      `admitted: ${proxy.admitted.join(", ") || "(none)"}; refused: ${proxy.refusals.join(", ") || "(none)"}`,
    );
  } finally {
    await proxy.close();
    await allowed.close();
    await other.close();
    rmSync(scratch, { recursive: true, force: true });
  }

  const failed = results.filter((result) => !result.pass);
  if (json) {
    process.stdout.write(`${JSON.stringify({ skipped: false, results }, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        "APRV-351 constrained-egress probe (offline; no credential, no provider, no model call).",
        "",
        ...results.map(
          (result) =>
            `  ${result.pass ? "PASS" : "FAIL"}  ${result.name}\n        ${result.claim}\n        observed: ${result.detail}`,
        ),
        "",
        failed.length === 0
          ? `All ${String(results.length)} assertions held.`
          : `${String(failed.length)} of ${String(results.length)} assertions FAILED.`,
        "",
      ].join("\n"),
    );
  }
  return failed.length === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `usage: node scripts/probes/constrained-egress.mjs <verb>

  probe [--json]                    the offline assertion matrix
  proxy --allow <host:port> [...]   run the pinning proxy in the foreground
        [--port <n>]
  round-trip --base-url <url>       the credentialed leg; the operator runs it
`;

function flagValues(argv, name) {
  const out = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== name) continue;
    const value = argv[index + 1];
    if (typeof value === "string" && !value.startsWith("--")) out.push(value);
  }
  return out;
}

async function runProxyVerb(argv) {
  const allow = flagValues(argv, "--allow");
  if (allow.length === 0) {
    process.stderr.write("proxy needs at least one --allow <host:port>\n");
    return 2;
  }
  const portFlag = flagValues(argv, "--port")[0];
  const started = await startPinningProxy({ allow, port: portFlag ? Number(portFlag) : 0 });
  process.stdout.write(
    [
      `pinning proxy listening on 127.0.0.1:${String(started.port)}`,
      `allow-list (exact authority match): ${allow.join(", ")}`,
      "",
      "Point the harness at it with HTTPS_PROXY, and admit exactly this port in",
      "the Seatbelt profile. It tunnels CONNECT and terminates no TLS, so it",
      "never sees a prompt, a completion or a provider key.",
      "",
      "Ctrl-C to stop.",
      "",
    ].join("\n"),
  );
  return new Promise(() => {});
}

function roundTrip(argv) {
  const baseUrl = flagValues(argv, "--base-url")[0];
  process.stdout.write(
    [
      "APRV-351 harness round trip.",
      "",
      "This is the one leg that cannot be proved offline: it needs a real",
      "provider and YOUR credential, which no agent session may hold or read.",
      "This script does not read, embed or log any credential; it prints the",
      "command and gets out of the way.",
      "",
      baseUrl === undefined
        ? "Pass --base-url <your provider base url> to have the command printed with it filled in."
        : `Base URL: ${baseUrl}`,
      "",
      "See docs/sandboxed-exec.md, section \"Harness round trip\", for the single",
      "command and what a pass looks like.",
      "",
    ].join("\n"),
  );
  return 0;
}

export async function main(argv) {
  const verb = argv[2];
  if (verb === "probe") return probe(argv.includes("--json"));
  if (verb === "proxy") return runProxyVerb(argv);
  if (verb === "round-trip") return roundTrip(argv);
  process.stderr.write(USAGE);
  return 2;
}

if (process.argv[1] === SCRIPT) {
  main(process.argv).then((code) => {
    process.exitCode = code;
  });
}
