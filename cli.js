#!/usr/bin/env node
/**
 * `approval` bin entry: a thin loader for the compiled CLI.
 *
 * All behaviour lives in src/cli/main.ts. This file exists only to find the
 * build output and hand it argv, so the published bin and
 * `node dist/src/cli/main.js` are the same program.
 *
 * The exit code is set via `process.exitCode` rather than `process.exit()`, so
 * stdout is flushed by the normal exit path — a JSON object truncated by an
 * early exit would be worse than no output.
 *
 * ONE exception to "no behaviour here" (APRV-445 refutation, S3): the Hermes
 * hook. Hermes reads any non-zero exit with an EMPTY stdout as an ALLOW, so a
 * failure to load the runtime at all (a missing or half-written dist/, a
 * static import that throws) must still answer with a block. That is the only
 * thing this file can do that the runtime cannot: it runs before the runtime
 * exists. For `approval hook hermes` it prints `{"action":"block",...}` and
 * exits 2 on any failure to load or run, and on a SIGTERM or SIGINT that lands
 * before the runtime's own guard is listening (APRV-466); every other
 * invocation keeps its old behaviour exactly.
 */

import { existsSync, writeSync } from "node:fs";

const argv = process.argv.slice(2);
// Matched the way `main` dispatches it: `--no-color` is the one global flag it
// strips, wherever it appears (APRV-445 recheck L-d).
const dispatched = argv.filter((word) => word !== "--no-color");
const hermesHook = dispatched[0] === "hook" && dispatched[1] === "hermes";

/** Has anything reached stdout? Tracked only for the Hermes hook. */
let printed = false;
/** Has `main` returned its verdict to this file? */
let answered = false;

/**
 * The runtime's `hook-interrupted` directive, byte for byte
 * (`hermesInterruptedDirective` in src/cli/hook.ts). Spelled by hand because a
 * signal can land before that module exists in this process;
 * `tests/hermes-bin-signal-guard.test.ts` pins the two equal.
 */
function hermesInterrupted(signal) {
  return `${JSON.stringify({ action: "block", message: `hook-interrupted: the hook received ${signal} before it reached a verdict; nothing authorizes this call` })}\n`;
}

// The first guard (APRV-466), installed before anything else runs. The default
// disposition of SIGTERM and SIGINT is to die with nothing on stdout, which
// Hermes reads as an ALLOW, and Hermes sends SIGTERM on its hook timeout and on
// gateway shutdown. Until now the earliest handler was the runtime's own
// (`hermesFailClosed`), so a signal during the ESM load of dist/ (the longest
// stretch of a cold start) took the default action.
//
// It hands over rather than competing. The runtime's guard is added after this
// one with `process.on`, and the wait's handler is prepended; Node runs every
// listener in order, so while either is registered this one returns and the
// runtime answers, knowing what this file cannot (whether the event is a post
// event, and what it already printed). Only one of them ever prints. Once
// `main` has answered, a signal ends the process with the verdict already
// reached, and with something on stdout but no answer yet it exits 2 without
// printing a second object (unparseable stdout).
//
// What no guard here can cover is the moment before this file's first
// statement: Node's own bootstrap. A signal there is a death by signal with an
// empty stdout, and the hosted image's patch to Hermes's `shell_hooks` is the
// layer that blocks it (docs/hermes-hook.md, "Two layers").
if (hermesHook) {
  const onSignal = (signal) => {
    if (process.listenerCount(signal) > 1) return;
    if (answered) process.exit();
    if (!printed) {
      try {
        writeSync(1, hermesInterrupted(signal));
      } catch {
        // stdout is gone; the exit code below is the whole verdict.
      }
    }
    process.exit(2);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
}

const entry = new URL("./dist/src/cli/main.js", import.meta.url);

/** Hermes's own block directive, spelled here because the runtime may not load. */
function hermesBlock(message) {
  writeSync(1, `${JSON.stringify({ action: "block", message: `hook-io: ${message}; nothing authorizes this call` })}\n`);
  printed = true;
  process.exitCode = 2;
}

// The last guard (recheck L-d): whatever path the process takes out, a Hermes
// hook that leaves with a non-zero code other than 2 and nothing on stdout is
// an ALLOW to Hermes. Such an exit leaves as 2, with the directive when nothing
// was printed. Exit 0 with nothing on stdout is the post-event answer and is
// left alone; the adapter itself never answers a pre-event that way.
if (hermesHook) {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    if (chunk !== undefined && String(chunk).length > 0) printed = true;
    return write(chunk, ...rest);
  };
  process.on("exit", (code) => {
    if (code === 0 || code === 2) return;
    if (!printed) {
      try {
        writeSync(1, `${JSON.stringify({ action: "block", message: `hook-io: the hook exited ${String(code)} without a verdict; nothing authorizes this call` })}\n`);
      } catch {
        // stdout is gone; the exit code below is the whole verdict.
      }
    }
    // Exit 2 blocks whatever stdout says, so it is the code a Hermes hook
    // leaves with on any non-zero path.
    process.exitCode = 2;
  });
}

if (!existsSync(entry)) {
  if (hermesHook) {
    hermesBlock("the approval runtime is not built (dist/src/cli/main.js is missing)");
    answered = true;
  } else {
    // Exit 4 = I/O error in the frozen exit-code table (src/cli/exit-codes.ts).
    process.stderr.write(
      "approval: dist/src/cli/main.js is missing — run `npm run build` first.\n",
    );
    process.exitCode = 4;
  }
} else if (hermesHook) {
  try {
    const { main } = await import(entry.href);
    process.exitCode = await main(argv);
  } catch (cause) {
    hermesBlock(`the hook could not run: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  answered = true;
} else {
  const { main } = await import(entry.href);
  // `main` is asynchronous since APRV-209: every verb is loaded on demand, and
  // ESM has no synchronous dynamic import. The exit code still travels through
  // `process.exitCode`, so the flush behaviour described above is unchanged.
  process.exitCode = await main(argv);
}
