#!/usr/bin/env node

import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratchDir = mkdtempSync(join(tmpdir(), "approval-codex-witness-"));
const markerPath = join(scratchDir, "post-received");
let requestCount = 0;

const server = createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/probe") {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found\n");
    return;
  }

  if (requestCount !== 0) {
    response.writeHead(409, { "content-type": "text/plain" });
    response.end("probe already received\n");
    return;
  }

  requestCount += 1;
  try {
    writeFileSync(markerPath, "one loopback POST\n", { flag: "wx" });
  } catch (cause) {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end("could not write witness marker\n");
    console.error(cause instanceof Error ? cause.message : String(cause));
    server.close(() => process.exitCode = 1);
    return;
  }
  response.writeHead(204);
  response.end();
  console.log(`received requests: ${requestCount}`);
  console.log(`marker written: ${markerPath}`);
  server.close();
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a loopback TCP address");
  }
  const url = `http://127.0.0.1:${address.port}/probe`;
  console.log("ready");
  console.log(`Codex command: curl -X POST ${url}`);
  console.log(`marker path: ${markerPath}`);
  console.log("received requests: 0");
});

const deadline = setTimeout(() => {
  console.error("witness timed out after 10 minutes without a POST");
  server.close(() => process.exitCode = 2);
}, 10 * 60 * 1000);
deadline.unref();

server.on("close", () => clearTimeout(deadline));
