/**
 * `approval payload hash <file|->` — print the content binding for a payload
 * (SPEC.md §6.2; APRV-29).
 *
 * The hash was already the whole mechanism of content binding, and until now the
 * only way to obtain one outside the runtime was to import `core/payload.js` by
 * hand. That is a bad instruction to publish: it puts an internal module path in
 * a demo, it drifts the moment the build layout changes, and — worse — it invites
 * an operator to reimplement "SHA-256 of the JSON" with `JSON.stringify`, which
 * agrees with the runtime right up until a key order changes and then binds to
 * bytes the gate will refuse. One verb, calling the same {@link payloadHash} the
 * gate calls, removes the invitation.
 *
 * **No logic lives here either.** The hash is `core/payload.ts`; this file reads
 * bytes at the edge, parses them, and maps the outcome onto the frozen exit
 * table.
 *
 * ## Why the input must parse
 *
 * §6.2 defines `payload_hash` over the RFC 8785 canonical serialization of the
 * *value*, not over the bytes a file happens to hold. Non-JSON input therefore
 * has no defined hash at all: hashing the raw bytes would produce a plausible
 * 64-hex string that no gate, adapter or second implementation would ever
 * reproduce. So a parse failure is a usage error (exit 2) that says why, and
 * nothing is printed on stdout.
 *
 * ## This verb is the fallback, not the main road
 *
 * `approval request --payload <file>` both stores the bytes in
 * `.approval/payloads/` (APRV-28) and verifies their hash against the declared
 * binding, so a flow that uses it never hashes anything by hand. This verb is for
 * the step *before* that: writing the `payload_hash` into the task file in the
 * first place, and for adapters that must present a binding for material the
 * runtime is not holding.
 *
 * Reads no log, writes no file, appends nothing.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePathSegments } from "node:path";

import { payloadHash } from "../core/payload.js";
import { boolFlag, parseFlags, type FlagKind } from "./args.js";
import { EXIT_IO, EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { PAYLOAD_HASH_HELP, PAYLOAD_HELP } from "./help.js";
import type { Streams } from "./main.js";

const HASH_FLAGS: Record<string, FlagKind> = {
  "--json": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

function wantsJson(argv: string[]): boolean {
  return argv.includes("--json");
}

function usageError(streams: Streams, json: boolean, message: string, helpText: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "usage", message } })}\n`);
  else streams.err(`approval: ${message}\n\n${helpText}\n`);
  return EXIT_USAGE;
}

function ioError(streams: Streams, json: boolean, message: string): number {
  if (json) streams.err(`${JSON.stringify({ error: { code: "io", message } })}\n`);
  else streams.err(`approval: ${message}\n`);
  return EXIT_IO;
}

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function absolute(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolvePathSegments(cwd, value);
}

/** `approval payload hash <file|->`. */
function commandPayloadHash(argv: string[], streams: Streams, cwd: string): number {
  const json = wantsJson(argv);
  const parsed = parseFlags(argv, HASH_FLAGS);
  if (!parsed.ok) return usageError(streams, json, parsed.message, PAYLOAD_HASH_HELP);
  if (boolFlag(parsed.flags, "--help") || boolFlag(parsed.flags, "-h")) {
    streams.out(`${PAYLOAD_HASH_HELP}\n`);
    return EXIT_OK;
  }

  const source = parsed.positionals[0];
  if (source === undefined) {
    return usageError(
      streams,
      json,
      "missing <file> argument (use - to read the payload from stdin)",
      PAYLOAD_HASH_HELP,
    );
  }
  const extra = parsed.positionals[1];
  if (extra !== undefined) {
    return usageError(
      streams,
      json,
      `unexpected argument ${JSON.stringify(extra)}`,
      PAYLOAD_HASH_HELP,
    );
  }

  const where = source === "-" ? "stdin" : absolute(source, cwd);
  let raw: string;
  try {
    raw = readFileSync(source === "-" ? 0 : where, "utf8");
  } catch (cause) {
    return ioError(streams, json, `${where} could not be read: ${detail(cause)}`);
  }

  // Empty input is a usage error, not an I/O one: the read succeeded and there
  // is simply no payload. Hashing "" would be hashing the absence of a payload.
  if (raw.trim().length === 0) {
    return usageError(
      streams,
      json,
      `${where} is empty; there is no payload to hash`,
      PAYLOAD_HASH_HELP,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (cause) {
    return usageError(
      streams,
      json,
      `${where} is not valid JSON: ${detail(
        cause,
      )}. payload_hash is defined over the RFC 8785 canonical serialization of the payload VALUE (SPEC.md §6.2), so bytes that do not parse have no defined hash and none was printed`,
      PAYLOAD_HASH_HELP,
    );
  }

  let hash: string;
  try {
    hash = payloadHash(value);
  } catch (cause) {
    return usageError(
      streams,
      json,
      `${where} could not be canonicalized: ${detail(
        cause,
      )}. A payload that RFC 8785 cannot serialize cannot be bound to`,
      PAYLOAD_HASH_HELP,
    );
  }

  if (json) streams.out(`${JSON.stringify({ ok: true, hash })}\n`);
  else streams.out(`${hash}\n`);
  return EXIT_OK;
}

/** `approval payload …` — dispatch to `hash`, or print the help. */
export function commandPayload(argv: string[], streams: Streams, cwd: string): number {
  const sub = argv[0];
  const rest = argv.slice(1);

  if (sub === undefined) {
    return usageError(
      streams,
      wantsJson(argv),
      "missing subcommand for `approval payload`",
      PAYLOAD_HELP,
    );
  }
  if (sub === "--help" || sub === "-h" || sub === "help") {
    streams.out(`${PAYLOAD_HELP}\n`);
    return EXIT_OK;
  }

  switch (sub) {
    case "hash":
      return commandPayloadHash(rest, streams, cwd);
    default:
      return usageError(
        streams,
        wantsJson(argv),
        `unknown subcommand ${JSON.stringify(sub)} for \`approval payload\``,
        PAYLOAD_HELP,
      );
  }
}
