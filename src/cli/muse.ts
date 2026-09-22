/** Operator-launched local Muse prototype; credentials come only from launch env. */
import { resolve } from "node:path";
import { boolFlag, parseFlags, stringFlag } from "./args.js";
import { EXIT_IO, EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { MUSE_HELP } from "./help.js";
import type { Streams } from "./main.js";
import { DEFAULT_LOG_PATH } from "./paths.js";
import { createMuseServer, validMuseOptions, type MuseOptions } from "../muse/server.js";

export async function commandMuse(argv: string[], streams: Streams, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const parsed = parseFlags(argv, { "--dir": "string", "--port": "string", "--help": "boolean", "-h": "boolean" });
  if (!parsed.ok || parsed.positionals.length > 0) {
    streams.err("approval: invalid muse arguments\n");
    return EXIT_USAGE;
  }
  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${MUSE_HELP}\n`);
    return EXIT_OK;
  }
  const root = resolve(cwd, stringFlag(parsed.flags, "--dir") ?? ".");
  const portText = stringFlag(parsed.flags, "--port") ?? "4683";
  if (!/^\d{1,5}$/u.test(portText)) {
    streams.err("approval: --port expects a TCP port\n");
    return EXIT_USAGE;
  }
  const tenant = env["APPROVAL_MUSE_TENANT"] ?? "";
  const options: MuseOptions = {
    tenant,
    actor: `agent:muse:${tenant}`,
    root,
    log: resolve(root, DEFAULT_LOG_PATH),
    readToken: env["APPROVAL_MUSE_READ_TOKEN"] ?? "",
    proposeToken: env["APPROVAL_MUSE_PROPOSE_TOKEN"] ?? "",
    port: Number(portText),
  };
  if (!validMuseOptions(options)) {
    streams.err("approval: Muse launch needs tenant and distinct read/propose credentials of at least 24 characters\n");
    return EXIT_USAGE;
  }
  const server = createMuseServer(options);
  try {
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(options.port, "127.0.0.1", done);
    });
  } catch {
    streams.err("approval: Muse listener could not bind\n");
    return EXIT_IO;
  }
  const address = server.address();
  const bound = typeof address === "object" && address !== null ? address.port : options.port;
  streams.err(`approval: local Muse prototype on 127.0.0.1:${String(bound)} for tenant ${tenant}; human decisions remain in configured Telegram\n`);
  return await new Promise<number>((done) => {
    const stop = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      server.close(() => done(EXIT_OK));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
