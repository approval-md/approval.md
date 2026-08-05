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
 */

import { existsSync } from "node:fs";

const entry = new URL("./dist/src/cli/main.js", import.meta.url);

if (!existsSync(entry)) {
  // Exit 4 = I/O error in the frozen exit-code table (src/cli/exit-codes.ts).
  process.stderr.write(
    "approval: dist/src/cli/main.js is missing — run `npm run build` first.\n",
  );
  process.exitCode = 4;
} else {
  const { main } = await import(entry.href);
  process.exitCode = main(process.argv.slice(2));
}
