/**
 * What a caller on this transport may say about the filesystem: nothing
 * outside the store (APRV-421, review finding 3).
 *
 * ## The hole this closes
 *
 * `approval mcp serve` publishes `--log`, `--dir` and `--policy` on the verbs
 * that accept them, and injects the operator's pins only when the operator
 * passed any. On a pipe the operator handed the server that is harmless: the
 * party at the other end is the party who started it, and it could read the
 * file itself. Over HTTP the party at the other end is a sandboxed harness on
 * another machine, and the same published flag is a filesystem oracle:
 *
 *     POST /verb/log_verify  {"flags": {"--log": "/etc/hosts"}}
 *
 * answers with what the verifier made of the first bytes of a host file, and
 * pointed at a second tenant's log it verifies THAT. The positional arguments
 * are the same hole wearing different clothes: `payload hash <file>` names a
 * host path and `request --payload <file>` files host bytes into the payload
 * store.
 *
 * ## The rule
 *
 * Two halves, and both are needed.
 *
 * 1. **The server pins the store.** `--dir`, `--log` and `--policy` are
 *    appended to EVERY verb call, in every scope, from the launch
 *    configuration, whether or not the operator named them. One process serves
 *    one store, and that is now true of the argv as well as of the intent.
 * 2. **A caller may not name a path outside it.** Any argument this module
 *    reads as a path — a flag in {@link PATH_FLAGS}, or a positional a verb
 *    declares as a file — must resolve inside the store root, and is refused
 *    otherwise. The three pinned flags are refused outright even for a path
 *    inside the store, because they are the store and a caller does not get to
 *    restate it.
 *
 * The second half is what keeps the first honest. Pinning alone would leave
 * `payload hash /etc/passwd` answering, since that verb names its file as a
 * positional and no pin reaches it.
 *
 * ## Why confinement rather than outright refusal
 *
 * A path argument inside the store is a legitimate thing for a co-located
 * caller to send, and refusing every one of them would silently make
 * `payload_hash` and `--payload` dead letters rather than deciding they should
 * be. Confinement keeps the verbs meaning what they mean and removes the only
 * dangerous case.
 *
 * Worth stating plainly for the operator's runbook: a REMOTE harness has no
 * files on the host at all, so every path it could legitimately name is one
 * the host put there. `payload_hash` is therefore close to inert over this
 * transport, and the case for keeping it on the agent allowlist is weaker than
 * it looks. That is a scope decision and is recorded in the task's notes, not
 * taken here.
 */

import { realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";

import { verbLabel, type VerbSpec } from "../cli/verb-registry.js";

/**
 * Flags whose value names a filesystem path, on any published verb.
 *
 * A LIST rather than a property of the registry, because the registry types a
 * flag as `"string"` and says no more. Enumerated fail-closed: a flag whose
 * value might be read as a path is on it, and `--source` (an enum of witness
 * names) and `--api-base` (a URL) are not, because neither opens a file.
 *
 * A flag added to the registry tomorrow is absent from this list, so the check
 * below is not a complete proof that no path reaches a verb. What makes the
 * gap survivable is the other half of the rule: the agent surface is seven
 * verbs, and every path-shaped argument any of them takes is named here.
 */
export const PATH_FLAGS: ReadonlySet<string> = new Set([
  "--dir",
  "--log",
  "--policy",
  "--index",
  "--out",
  "--journal",
  "--payload",
  "--root",
  "--vault",
  "--read-jail",
  "--tasks",
]);

/**
 * The three the server pins itself. Refused from a caller even when the value
 * would have been legal: one process serves one store, and a caller restating
 * it is a caller that believes it can choose.
 */
export const PINNED_FLAGS: readonly string[] = ["--dir", "--log", "--policy"];

/**
 * Verbs whose POSITIONAL argument names a file, by registry label.
 *
 * Read off the registry's own positional titles and descriptions rather than
 * guessed: each of these declares a `file`, a `task-file` or a path.
 */
const PATH_POSITIONAL_VERBS: ReadonlyMap<string, number> = new Map([
  ["payload hash", 0],
  ["register", 0],
  ["import agents-md", 0],
]);

export type ArgumentCheck = { ok: true } | { ok: false; code: string; message: string };

const OUTSIDE = "serve-path-outside-store";
const PINNED = "serve-path-pinned";

/**
 * Is `candidate` inside `root`?
 *
 * Resolved through `realpath` on the deepest existing ancestor, so a symlink
 * in the middle of the path cannot walk out of the store and back in on paper.
 * A path that does not exist is judged by where it WOULD be, which is the
 * right answer for a verb that is about to create it.
 */
function insideStore(root: string, candidate: string): boolean {
  const real = (path: string): string => {
    let current = path;
    // Walk up to the deepest ancestor that exists, resolve that, then re-attach
    // the tail. `realpathSync` throws on a path whose leaf is absent.
    const tail: string[] = [];
    for (;;) {
      try {
        return resolve(realpathSync(current), ...tail.reverse());
      } catch {
        const parent = dirname(current);
        if (parent === current) return resolve(path);
        tail.push(current.slice(parent.length + 1));
        current = parent;
      }
    }
  };

  const realRoot = real(root);
  const realCandidate = real(candidate);
  return realCandidate === realRoot || realCandidate.startsWith(`${realRoot}${sep}`);
}

function checkPath(root: string, cwd: string, label: string, value: string): ArgumentCheck {
  // `-` is stdin and is refused earlier, by the argv builder both transports
  // share. Named here so a reader does not wonder.
  if (value === "-") return { ok: true };
  const absolute = isAbsolute(value) ? value : resolve(cwd, value);
  if (insideStore(root, absolute)) return { ok: true };
  return {
    ok: false,
    code: OUTSIDE,
    message: `${label} names ${JSON.stringify(value)}, which is outside the store this server was started for. This transport serves ONE store and reads no path beyond it: a path argument that reached the host filesystem would answer questions about files the caller cannot see and did not put there`,
  };
}

/**
 * Check one verb call's arguments before an argv is built from them.
 *
 * Runs for EVERY scope. The tenant credential is the operator's and is trusted
 * with far more than the agent's, and it is still not a reason to let one
 * process serve two stores: the pins are the launch configuration's, and a
 * second store reached through an argument would be a second gate with no
 * attestation, no daemon id and no record of which one answered.
 */
export function checkVerbArguments(
  spec: VerbSpec,
  rawArgs: unknown,
  storeRoot: string,
  cwd: string,
): ArgumentCheck {
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  if (typeof args !== "object" || Array.isArray(args)) return { ok: true };

  const flags = args["flags"];
  if (typeof flags === "object" && flags !== null && !Array.isArray(flags)) {
    for (const [flag, value] of Object.entries(flags as Record<string, unknown>)) {
      if (PINNED_FLAGS.includes(flag)) {
        return {
          ok: false,
          code: PINNED,
          message: `${flag} is not accepted from a caller. This server serves the one store it was started for, and ${PINNED_FLAGS.join(", ")} are appended to every verb call from its launch configuration; a call that could restate them could point this process at another tenant's log, at another tenant's policy, or at the host's filesystem`,
        };
      }
      if (!PATH_FLAGS.has(flag) || typeof value !== "string") continue;
      const checked = checkPath(storeRoot, cwd, flag, value);
      if (!checked.ok) return checked;
    }
  }

  const index = PATH_POSITIONAL_VERBS.get(verbLabel(spec));
  if (index === undefined) return { ok: true };
  const positionals = args["positionals"];
  if (!Array.isArray(positionals)) return { ok: true };
  const value = positionals[index];
  if (typeof value !== "string") return { ok: true };
  return checkPath(storeRoot, cwd, `\`approval ${verbLabel(spec)}\`'s file argument`, value);
}
