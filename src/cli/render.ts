/**
 * `approval render` — regenerate `.approval/QUEUE.md` from the log (SPEC.md
 * §9.1, §10.1).
 *
 * As everywhere else in this CLI, no logic lives here. The projection is
 * `channels/render-queue.ts`; this file splits argv, resolves paths, reads the
 * clock **once at the edge** and hands the instant to core, and maps a result
 * onto the frozen exit table.
 *
 * The clock is the point worth stating. The renderer is a pure function of
 * (verified log, policy, `now`), which is what makes an identical log render to
 * identical bytes. That property survives only if exactly one place reads a real
 * clock, and this is it.
 *
 * `render` writes one file and never the log. A corrupt log refuses (exit 1)
 * rather than producing a queue: a projection of a log that does not verify
 * would be a screenshot of something nobody should be reading.
 */

import { isAbsolute, resolve as resolvePathSegments } from "node:path";

import {
  writeQueue,
  type RenderQueueOptions,
  type RenderQueueRefusal,
} from "../channels/render-queue.js";
import { boolFlag, parseFlags, stringFlag, type FlagKind } from "./args.js";
import {
  EXIT_INTEGRITY,
  EXIT_IO,
  EXIT_OK,
  EXIT_TORN_TAIL,
  EXIT_USAGE,
} from "./exit-codes.js";
import { RENDER_HELP } from "./help.js";
import type { Streams } from "./main.js";
import { DEFAULT_LOG_PATH, preflightLog, resolvePath } from "./paths.js";
import { usageErrorText } from "./usage.js";

/** SPEC.md §9.1: where the queue projection lives. */
export const DEFAULT_QUEUE_PATH = ".approval/QUEUE.md";

const RENDER_FLAGS: Record<string, FlagKind> = {
  "--log": "string",
  "--out": "string",
  "--policy": "string",
  "--dir": "string",
  "--json": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

function absolute(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolvePathSegments(cwd, value);
}

function emitJson(streams: Streams, value: unknown): void {
  streams.out(`${JSON.stringify(value)}\n`);
}

function usageError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "usage", message } })}\n`);
  else streams.err(usageErrorText(message, RENDER_HELP));
  return EXIT_USAGE;
}

function ioError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "io", message } })}\n`);
  else streams.err(`approval: ${message}\n`);
  return EXIT_IO;
}

/**
 * The refusal → exit-code mapping, drawn exactly where every other verb draws
 * it: a filesystem fact is 4, a crashed write is 3, and a log that does not
 * verify is 1.
 */
function refusalExit(code: RenderQueueRefusal["code"]): number {
  switch (code) {
    case "log-unreadable":
    case "write-failed":
      return EXIT_IO;
    case "log-torn-tail":
      return EXIT_TORN_TAIL;
    default:
      return EXIT_INTEGRITY;
  }
}

/** Where policy lives, from `--policy` / `--dir`, with the CLI's cwd default. */
function policyLocation(
  flags: Record<string, string | boolean>,
  cwd: string,
): { dir?: string; file?: string } {
  const policyFlag = stringFlag(flags, "--policy");
  const dirFlag = stringFlag(flags, "--dir");
  if (policyFlag !== null) return { file: absolute(policyFlag, cwd) };
  return { dir: dirFlag === null ? cwd : absolute(dirFlag, cwd) };
}

export function commandRender(argv: string[], streams: Streams, cwd: string): number {
  const json = argv.includes("--json");
  const parsed = parseFlags(argv, RENDER_FLAGS);
  if (!parsed.ok) return usageError(streams, json, parsed.message);
  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${RENDER_HELP}\n`);
    return EXIT_OK;
  }
  const extra = parsed.positionals[0];
  if (extra !== undefined) {
    return usageError(streams, json, `unexpected argument ${JSON.stringify(extra)}`);
  }

  const logPath = resolvePath(stringFlag(parsed.flags, "--log"), DEFAULT_LOG_PATH, cwd);
  const queuePath = resolvePath(stringFlag(parsed.flags, "--out"), DEFAULT_QUEUE_PATH, cwd);

  const check = preflightLog(logPath);
  if (!check.ok) return ioError(streams, json, check.message);

  const options: RenderQueueOptions = { policy: policyLocation(parsed.flags, cwd) };
  // The one clock read on this path. Everything downstream is a pure function
  // of this string, which is what makes the output reproducible.
  const now = new Date().toISOString();

  const result = writeQueue(logPath, queuePath, options, now);

  if (!result.ok) {
    if (json) {
      streams.err(
        `${JSON.stringify({ ok: false, error: { code: result.code, message: result.message } })}\n`,
      );
    } else {
      streams.err(`approval: ${result.code}: ${result.message}\n`);
    }
    return refusalExit(result.code);
  }

  if (json) {
    emitJson(streams, {
      ok: true,
      out: result.path,
      bytes: result.bytes,
      head: result.head,
      pending: result.pending,
      skipped: result.skipped,
      audit_backlog: result.auditBacklog,
      now,
    });
  } else {
    const head =
      result.head === null ? "head none" : `head seq ${String(result.head.seq)} ${result.head.hash}`;
    streams.out(
      `wrote ${result.path}: ${String(result.bytes)} byte(s), ${head}, ${String(
        result.pending,
      )} pending, ${String(result.skipped)} not summarized, ${String(
        result.auditBacklog,
      )} awaiting audit review\n`,
    );
  }
  return EXIT_OK;
}
