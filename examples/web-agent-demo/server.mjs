#!/usr/bin/env node
/**
 * examples/web-agent-demo/server.mjs — a READ-ONLY window into a demo gate.
 *
 * ===========================================================================
 * SECURITY CONTRACT — read this before running it anywhere reachable.
 * ===========================================================================
 *
 * This process holds NO GATE AUTHORITY, and that is the whole point of it
 * being a separate program rather than a mode of the real web channel.
 *
 *   - RUN IT WITHOUT `APPROVAL_HUMAN`. It must never be able to speak as a
 *     human, because a decision endpoint that cannot name an approver is
 *     the only kind that is safe to expose, and the surest way to keep it
 *     that way is to deny this process an identity at all.
 *   - RUN IT WITHOUT the vault passphrase (`APPROVAL_VAULT_PASSPHRASE` and
 *     kin) and WITHOUT any Telegram bot token. It needs no credential to do
 *     its job: everything it shows comes from reading the log.
 *   - IT NEVER APPENDS TO THE LOG. Every child process it starts is one of
 *     four read verbs (`queue`, `status`, `log tail`, `log verify`), each of
 *     which is documented as writing nothing.
 *   - IT SERVES NO DECISION ENDPOINTS. There are no POST routes here at all.
 *     Grant, reject, revoke, attest, run: none of them are reachable from
 *     this surface, in any shape.
 *   - THE LOOPBACK WEB CHANNEL (port 4680, `src/channels/web.ts`) IS
 *     LOOPBACK-ONLY BY DESIGN AND MUST NEVER BE TUNNELED. Nothing in this
 *     file starts it. When you expose a demo to a room or to the internet,
 *     THIS server's port is the only one that may be tunneled.
 *
 * It binds 0.0.0.0 because it is meant to sit behind a tunnel, which is safe
 * precisely because of the constraints above and for no other reason. Adding
 * a write path to this file breaks all of them at once.
 *
 * ---------------------------------------------------------------------------
 * Usage:
 *   node examples/web-agent-demo/server.mjs --dir <demo gate dir> [--port 4700]
 *
 *   --dir <path>   the demo gate instance (the directory holding APPROVAL.md
 *                  and .approval/). Also readable from APPROVAL_DEMO_DIR;
 *                  the flag wins. Required — there is no default, so this
 *                  server can never accidentally point at a real repo's gate.
 *   --port <n>     listen port (also PORT; default 4700).
 *
 * Requires the repository to be built (`npm run build`): it shells out to
 * dist/src/cli/main.js rather than importing anything from src/.
 */

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { existsSync, readFile } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(HERE, "public");
/** examples/web-agent-demo/ -> <repo>/dist/src/cli/main.js */
const CLI_ENTRY = fileURLToPath(new URL("../../dist/src/cli/main.js", import.meta.url));

const DEFAULT_PORT = 4700;
/** How long one aggregate is served from memory. Many browsers, few forks. */
const CACHE_TTL_MS = 2000;
/** A read verb that hangs is a bug, not a wait. */
const VERB_TIMEOUT_MS = 10_000;
/** Plenty for `log tail -n 20`; a bound is cheaper than trusting one. */
const MAX_CHILD_OUTPUT_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// argv / env
// ---------------------------------------------------------------------------

/** `--name value` from argv, or undefined. Flags win over env, always. */
function argValue(argv, name) {
  const at = argv.indexOf(name);
  if (at === -1) return undefined;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--")) {
    fail(`${name} expects a value`);
  }
  return value;
}

function fail(message) {
  process.stderr.write(`web-agent-demo: ${message}\n`);
  process.exit(2);
}

const argv = process.argv.slice(2);

const dirArg = argValue(argv, "--dir") ?? process.env.APPROVAL_DEMO_DIR;
if (dirArg === undefined || dirArg.trim() === "") {
  fail(
    "no demo gate directory — pass --dir <path> or set APPROVAL_DEMO_DIR.\n" +
      "  This server deliberately has no default: pointing it at a gate is a\n" +
      "  decision somebody makes on purpose.",
  );
}
const DEMO_DIR = resolve(dirArg);
if (!existsSync(DEMO_DIR)) fail(`demo gate directory does not exist: ${DEMO_DIR}`);

const LOG_PATH = join(DEMO_DIR, ".approval", "log", "events.jsonl");

const portArg = argValue(argv, "--port") ?? process.env.PORT;
const PORT = portArg === undefined ? DEFAULT_PORT : Number(portArg);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  fail(`--port expects a port number, got ${JSON.stringify(portArg)}`);
}

if (!existsSync(CLI_ENTRY)) {
  fail(`${CLI_ENTRY} is missing — run \`npm run build\` in the repository first.`);
}

// A loud warning rather than a refusal: the operator may have a shell full of
// gate credentials for good reasons, but this process should not inherit them.
for (const name of ["APPROVAL_HUMAN", "APPROVAL_VAULT_PASSPHRASE", "TELEGRAM_BOT_TOKEN"]) {
  if (process.env[name] !== undefined) {
    process.stderr.write(
      `web-agent-demo: WARNING — ${name} is set in this process's environment. ` +
        "This demo server is supposed to hold no gate authority; unset it and restart.\n",
    );
  }
}

// ---------------------------------------------------------------------------
// the four read verbs
// ---------------------------------------------------------------------------

/**
 * The read verbs, with the flags each one actually accepts (checked against
 * `--help`, not guessed): `queue` and `status` discover the policy with
 * `--dir`, while `log tail` and `log verify` take only `--log`. Every verb is
 * pinned to the demo instance's log file so the server's own cwd can never
 * change what is displayed.
 */
const VERBS = {
  queue: ["queue", "--dir", DEMO_DIR, "--log", LOG_PATH, "--json"],
  status: ["status", "--dir", DEMO_DIR, "--log", LOG_PATH, "--json"],
  log_tail: ["log", "tail", "-n", "20", "--log", LOG_PATH, "--json"],
  log_verify: ["log", "verify", "--log", LOG_PATH, "--json"],
};

/**
 * Run one read verb and parse its stdout.
 *
 * `execFile` with an argument array, never a shell string: nothing here is
 * interpolated into a command line, so a path with a space (or worse) is an
 * argument and not a syntax.
 *
 * A non-zero exit is NOT by itself a failure. `status` exits 1 whenever the
 * instance needs attention (a fresh demo gate is un-attested and therefore
 * "unhealthy"), and `log verify` exits non-zero on a corrupt or torn log —
 * in both cases the JSON on stdout is exactly the answer the page wants to
 * show. Only unparseable output is an error.
 */
function runVerb(args) {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [CLI_ENTRY, ...args],
      {
        cwd: DEMO_DIR,
        timeout: VERB_TIMEOUT_MS,
        maxBuffer: MAX_CHILD_OUTPUT_BYTES,
        // No inherited environment beyond PATH: this child must not be handed
        // an identity or a credential either, and the read verbs need none.
        env: { PATH: process.env.PATH ?? "", NO_COLOR: "1" },
      },
      (error, stdout, stderr) => {
        const text = String(stdout).trim();
        if (text !== "") {
          try {
            done(JSON.parse(text));
            return;
          } catch {
            // fall through to the error report below
          }
        }
        const detail = String(stderr).trim().split("\n")[0] ?? "";
        done({
          error:
            detail !== ""
              ? detail.slice(0, 300)
              : error
                ? `${args[0]} failed: ${String(error.message).slice(0, 200)}`
                : `${args[0]} produced no JSON`,
        });
      },
    );
  });
}

let cache = null;

async function readState() {
  const nowMs = Date.now();
  if (cache !== null && nowMs - cache.fetched_at_ms < CACHE_TTL_MS) return cache;

  const [queue, status, logTail, logVerify] = await Promise.all([
    runVerb(VERBS.queue),
    runVerb(VERBS.status),
    runVerb(VERBS.log_tail),
    runVerb(VERBS.log_verify),
  ]);

  cache = {
    queue,
    status,
    log_tail: logTail,
    log_verify: logVerify,
    fetched_at_ms: Date.now(),
  };
  return cache;
}

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------

function sendJson(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

function sendText(res, code, text) {
  res.writeHead(code, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

/** Only ever index.html, and only ever from inside public/. */
function serveIndex(res) {
  const file = resolve(join(PUBLIC_DIR, "index.html"));
  // Belt and braces: the path is a constant, and it is still prefix-checked so
  // no future edit can turn this into a traversal.
  if (file !== resolve(PUBLIC_DIR) && !file.startsWith(resolve(PUBLIC_DIR) + sep)) {
    sendText(res, 403, "forbidden");
    return;
  }
  readFile(file, (error, bytes) => {
    if (error) {
      sendText(res, 500, "index.html could not be read");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(bytes);
  });
}

const server = createServer((req, res) => {
  // GET and HEAD only. There are no POST routes in this server, by design:
  // APRV-155 attaches the agent-task runner as its own surface, and whatever
  // it does, it does not gain the authority to decide anything here.
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("allow", "GET, HEAD");
    sendText(res, 405, "read-only server: GET only");
    return;
  }

  const path = (req.url ?? "/").split("?")[0];

  if (path === "/api/state") {
    readState().then(
      (state) => sendJson(res, 200, state),
      (error) => sendJson(res, 500, { error: String(error?.message ?? error).slice(0, 300) }),
    );
    return;
  }

  if (path === "/" || path === "/index.html") {
    serveIndex(res);
    return;
  }

  sendText(res, 404, "not found");
});

server.listen(PORT, "0.0.0.0", () => {
  process.stdout.write(
    `web-agent-demo: read-only status server on http://0.0.0.0:${PORT}\n` +
      `  gate instance: ${DEMO_DIR}\n` +
      `  log:           ${LOG_PATH}\n` +
      "  endpoints:     GET /  and  GET /api/state (nothing else, and no POST)\n" +
      "  reminder:      tunnel THIS port if you must tunnel anything. The gate's\n" +
      "                 own web channel on 4680 is loopback-only and stays that way.\n",
  );
});
