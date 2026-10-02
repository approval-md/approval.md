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
 * exits 2 on any failure to load or run; every other invocation keeps its old
 * behaviour exactly.
 */

import { existsSync } from "node:fs";

const entry = new URL("./dist/src/cli/main.js", import.meta.url);
const argv = process.argv.slice(2);
const hermesHook = argv[0] === "hook" && argv[1] === "hermes";

/** Hermes's own block directive, spelled here because the runtime may not load. */
function hermesBlock(message) {
  process.stdout.write(`${JSON.stringify({ action: "block", message: `hook-io: ${message}; nothing authorizes this call` })}\n`);
  process.exitCode = 2;
}

if (!existsSync(entry)) {
  if (hermesHook) {
    hermesBlock("the approval runtime is not built (dist/src/cli/main.js is missing)");
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
} else {
  const { main } = await import(entry.href);
  // `main` is asynchronous since APRV-209: every verb is loaded on demand, and
  // ESM has no synchronous dynamic import. The exit code still travels through
  // `process.exitCode`, so the flush behaviour described above is unchanged.
  process.exitCode = await main(argv);
}
