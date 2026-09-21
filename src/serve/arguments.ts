/**
 * What a caller on this transport may say: nothing about the filesystem
 * outside the store, and nothing shaped like a flag where a value belongs
 * (APRV-421, review findings 3 and 1).
 *
 * ## The two holes this closes
 *
 * **A published path flag is a filesystem oracle.** `approval mcp serve`
 * publishes `--log`, `--dir` and `--policy` on the verbs that accept them and
 * injects the operator's pins only where the operator passed any. On a pipe
 * the operator handed the server that is harmless: the party at the other end
 * is the party who started it. Over HTTP the party at the other end is a
 * sandboxed harness on another machine, and the same flag answers questions
 * about files it cannot see.
 *
 * **A positional is a flag if it starts with a dash.** `buildArgv` emits
 * positionals FIRST and verbatim, and `parseFlags` reads any token beginning
 * with `-` as a flag. So a caller refused `{"flags":{"--payload":"…"}}` could
 * write `{"positionals":["--payload","/tmp/secret","t1"]}` and reach the same
 * flag through the front door — including the `--payload=/tmp/secret`
 * spelling, which `parseFlags` splits on `=`. Positionals are VALUES. One that
 * looks like a flag is refused rather than escaped, because escaping is a
 * thing to get subtly wrong once and lose.
 *
 * `trailing` needs no such rule and deliberately does not get one. `buildArgv`
 * always emits `--` before it, and `parseFlags` STOPS at `--`, pushing the
 * remainder into positionals without reading a single token as a flag. A
 * blanket refusal of dash-leading trailing elements would instead break the
 * one agent verb that needs them: `hook classify -- git push -f` classifies a
 * command line, and command lines have flags. The invariant that makes this
 * safe is pinned by a test rather than assumed here.
 *
 * ## The rule, by scope
 *
 * **Both scopes.** No positional may begin with `-`. `--dir`, `--log` and
 * `--policy` are appended to every call from the launch configuration and are
 * refused from a caller even when the value is correct: one process serves one
 * store, and a caller restating it is a caller that believes it can choose.
 *
 * **Agent scope.** Every path-typed flag is refused OUTRIGHT rather than
 * confined: a sandboxed harness has no files on the daemon's machine, so a
 * path it names is either useless or somebody else's. Payload bytes reach the
 * gate for such a harness through the hook route, which builds the envelope
 * from the tool call itself. On top of that, only the flags named in
 * {@link AGENT_FLAGS} are accepted at all, per verb, so a flag added to one of
 * the five agent verbs tomorrow is refused until somebody decides otherwise.
 *
 * **Tenant scope.** Every path-typed flag is CONFINED to the store, and which
 * flags those are comes from the registry ({@link pathFlagsOf}) rather than
 * from a list kept here, so a flag declared `"path"` tomorrow is confined on
 * the day it appears. Positionals that name files are confined the same way.
 */

import { realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";

import { pathFlagsOf, verbLabel, type VerbSpec } from "../cli/verb-registry.js";
import type { ServeScope } from "./credentials.js";

/**
 * The three the server pins itself, refused from any caller in any scope.
 *
 * They ARE the store. Everything else this module decides is about values
 * inside it.
 */
export const PINNED_FLAGS: readonly string[] = ["--dir", "--log", "--policy"];

/**
 * What each AGENT verb may be given, flag by flag.
 *
 * A positive list per verb, and short on purpose. The agent surface is five
 * verbs; between them they need an action key, a decision deadline, a note and
 * `--json`. Everything else on those verbs is either the store (pinned), the
 * identity (`--as`, refused by the argv builder both transports share), a path
 * (refused below), or something nobody has decided a sandboxed harness should
 * have.
 *
 * `--help` is absent deliberately: a help page over a transport whose client
 * is a program is an odd thing to serve, and `instructions` is the verb for
 * that.
 */
export const AGENT_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["instructions", new Set(["--schemas", "--json"])],
  ["hook classify", new Set(["--json"])],
  ["request", new Set(["--action", "--json"])],
  ["wait", new Set(["--timeout", "--interval", "--withdraw-on-timeout", "--json"])],
  ["withdraw", new Set(["--action", "--reason", "--note", "--json"])],
]);

/**
 * Verbs whose POSITIONAL argument names a file, by registry label.
 *
 * Read off the registry's own positional titles: each declares a `file` or a
 * `task-file`. None is on the agent surface any more, and the confinement
 * still runs for the tenant, because one process serves one store whoever is
 * asking.
 */
const PATH_POSITIONAL_VERBS: ReadonlyMap<string, number> = new Map([
  ["payload hash", 0],
  ["register", 0],
  ["import agents-md", 0],
]);

export type ArgumentCheck = { ok: true } | { ok: false; code: string; message: string };

const OUTSIDE = "serve-path-outside-store";
const PINNED = "serve-path-pinned";
const DASH = "serve-positional-flag";
const UNSUPPORTED = "serve-flag-not-permitted";

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

function confine(root: string, cwd: string, label: string, value: string): ArgumentCheck {
  // `-` is stdin and is refused by the argv builder both transports share.
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
 * with far more than the agent's, and that is still not a reason to let one
 * process serve two stores: the pins are the launch configuration's, and a
 * second store reached through an argument would be a second gate with no
 * attestation, no daemon id, and no record of which one answered.
 */
export function checkVerbArguments(
  spec: VerbSpec,
  rawArgs: unknown,
  storeRoot: string,
  cwd: string,
  scope: ServeScope,
): ArgumentCheck {
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  if (typeof args !== "object" || Array.isArray(args)) return { ok: true };
  const label = verbLabel(spec);

  // A POSITIONAL THAT LOOKS LIKE A FLAG IS A FLAG. Checked first and in both
  // scopes, because it is the route around every other rule in this file.
  const positionals = args["positionals"];
  if (Array.isArray(positionals)) {
    for (const value of positionals) {
      if (typeof value !== "string" || !value.startsWith("-")) continue;
      return {
        ok: false,
        code: DASH,
        message: `positional ${JSON.stringify(value)} begins with a dash. Positionals on this surface are VALUES, passed to the verb verbatim, and the verb reads anything starting with \`-\` as a flag: a value spelled this way reaches the flag parser through the front door. Send flags in \`flags\``,
      };
    }
  }

  const pathFlags = new Set(pathFlagsOf(spec));
  const permitted = AGENT_FLAGS.get(label);

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

      if (scope === "agent") {
        // `--as` is not this module's to refuse. The argv builder both
        // transports share owns identity and refuses it with
        // `mcp-identity-fixed`, whose message is the whole reason this surface
        // is safe to run; catching it here first would replace that with a
        // vaguer code and leave the rule stated in two places.
        if (flag === "--as") continue;
        if (pathFlags.has(flag)) {
          return {
            ok: false,
            code: UNSUPPORTED,
            message: `${flag} names a file on the machine this server runs on, and the agent credential never names one. A harness reached through this transport has no files there; payload bytes reach the gate through \`POST /hook/<harness>\`, which builds the envelope from the tool call itself`,
          };
        }
        if (permitted !== undefined && !permitted.has(flag)) {
          return {
            ok: false,
            code: UNSUPPORTED,
            message: `${flag} is not accepted on \`approval ${label}\` from the agent credential, which takes ${[...permitted].sort().join(", ")} on this verb and nothing else. A flag added to it later is refused until somebody decides a harness under oversight should have it`,
          };
        }
        continue;
      }

      if (!pathFlags.has(flag) || typeof value !== "string") continue;
      const checked = confine(storeRoot, cwd, flag, value);
      if (!checked.ok) return checked;
    }
  }

  const index = PATH_POSITIONAL_VERBS.get(label);
  if (index === undefined) return { ok: true };
  if (!Array.isArray(positionals)) return { ok: true };
  const value = positionals[index];
  if (typeof value !== "string") return { ok: true };
  return confine(storeRoot, cwd, `\`approval ${label}\`'s file argument`, value);
}
