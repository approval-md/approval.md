/**
 * The `approval run` payload: the argv, the cwd, and the bytes of the script
 * the argv names (SPEC.md §6.2, §10.4; APRV-401).
 *
 * ## The hazard this closes
 *
 * §6.2 defined this payload as "the argv array and cwd", and `approval run`
 * recomputes it from the argv and cwd it is about to spawn. For a command that
 * IS its own bytes (`npm update @types/node`) that is the whole action. For a
 * command that names a script it is not: the payload binds a NAME, and the
 * bytes behind that name are whatever the path holds at execution time. The
 * requester controls the file between the request and the grant, so a human
 * approved a path and the runtime executed a file. Found on a live grant during
 * APRV-398, exploited by nobody, filed as APRV-401.
 *
 * The payload hash is supposed to BE the binding (§10.4: "A grant therefore
 * approves specific bytes"), so the repair is to put the bytes inside it. A
 * script edited between the declaration and the execution hashes differently,
 * and the difference refuses `payload-mismatch` before the child is spawned and
 * before anything is appended, exactly as a changed argv already did.
 *
 * ## The shape, as the operator ruled it (APRV-401 notes, 2026-09-21)
 *
 * > the script digest is PART OF THE BINDING, never advisory. Shape: when argv
 * > names an interpreter (bash, sh, zsh, node, python3 and kin) followed by a
 * > path that resolves to a regular file at request time, the runtime reads and
 * > hashes the file into the bound payload, the card shows the digest, byte
 * > count and path, and approval run re-reads the file and refuses
 * > payload-mismatch if the bytes changed. No interpretation of the script and
 * > no second pass for files it sources; the limit is documented. Out of scope:
 * > piped installers (already opaque), sourced files, interpreters the
 * > classifier does not name.
 *
 * So this is an INTERPRETER-KEYED rule and not "every argv word that happens to
 * name a file". One script per invocation: the first word after the interpreter
 * that resolves to a readable regular file, which is the interpreter's operand
 * whether or not a subcommand comes first (`deno run job.ts`).
 * {@link SCRIPT_INTERPRETERS} is the list, and every member of it is a name
 * `core/command-class.ts` already knows: the six shells of its unwrappable set,
 * `node` from its own branch, and `python`, `python3`, `perl`, `ruby` and
 * `deno` from its inline-source table. A launcher neither file names binds
 * nothing, which is the documented limit rather than an oversight.
 *
 * The one thing here that the ruling does not spell out is the DEGENERATE case:
 * `./install.sh` with no interpreter word at all, where the kernel reads the
 * shebang and the script is `argv[0]` itself. It is bound, because it is the
 * same fact with the interpreter implied rather than typed, and leaving it out
 * would be a hole in the rule shaped exactly like the rule.
 *
 * ## What is NOT bound, stated plainly
 *
 * - **An inline program.** `bash -c '…'`, `node -e '…'`, `python3 -c '…'`: the
 *   program is a word of the argv, so it was always bound, and there is no file
 *   to read. The inline flags per interpreter are in {@link SCRIPT_INTERPRETERS}.
 * - **Nothing resolved through PATH.** The interpreter itself is not hashed. Its
 *   bytes are the host's rather than the requester's, and resolving a program
 *   name through `PATH` would make the payload a function of the environment the
 *   process happens to hold, which §11 says is never read implicitly.
 * - **Nothing transitive.** A bound script that sources another file, curls a
 *   second one, or execs a third binds only its own bytes. The digest is a
 *   binding, not a sandbox.
 * - **A piped installer.** `curl … | sh` has no file operand and is opaque to
 *   the classifier for the same reason it is unbindable here.
 * - **The instant between hashing and spawning.** The digest is taken, then
 *   `execution.started` is appended, then the child is spawned. A file rewritten
 *   inside that window runs unbound. Closing it needs the executor to hold the
 *   bytes rather than the path, which is the adapter contract of §10.4.
 *
 * ## Absence is not a claim
 *
 * `script` is omitted when nothing is bound, and that omission is deliberate: an
 * invocation naming no readable script hashes to exactly the value it hashed
 * before this module existed, so every record already in the log, and every
 * declaration already written into a task file, verifies unchanged. What the
 * absence does NOT say is "this runtime checked and there was nothing" — it is
 * the ordinary shape of a payload with no script to bind, and a reader wanting
 * to know whether a digest was possible reads the argv, which is right there.
 *
 * Every skip is safe for one reason, and it is the same reason in each case: the
 * value is recomputed at execution by this same rule. A file that was
 * unreadable at declaration time and readable at execution time gains an entry
 * and refuses; one that existed and was deleted loses one and refuses. The rule
 * does not have to decide correctly what a command will do, because both ends
 * apply it to the same tree and any disagreement is a refusal.
 *
 * Reads the filesystem, by design and by necessity: at most one file per call,
 * and only the one the argv names. Writes nothing, appends nothing, reads no
 * log, no policy, no environment and no clock.
 */

import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";

/** The payload key carrying the bound script. Omitted when there is none. */
export const BOUND_SCRIPT_KEY = "script";

/**
 * How much of a file is read at once while digesting it.
 *
 * Chunked rather than `readFileSync`, because a script may be of any size and
 * the executor must not be the thing that runs out of memory: a refusal to
 * compute the binding is a refusal to execute.
 */
export const DIGEST_CHUNK_BYTES = 64 * 1024;

/**
 * The interpreters whose script operand is bound, and the flags that mean
 * "the program is inline, there is no file".
 *
 * Every name here is one `core/command-class.ts` already knows, which is the
 * ruling's "interpreters the classifier does not name" read as a positive list:
 * the six shells of its unwrappable set, `node` from its own classification
 * branch, and `python`, `python3`, `perl`, `ruby`, `deno` from its
 * inline-source table. The list is duplicated rather than imported because
 * those tables are private to that module and a public export of them would be
 * a second consumer of a decision that belongs to classification; the comment
 * is the seam, and a name added there without being added here binds nothing,
 * which fails toward the old behaviour rather than toward a wrong digest.
 *
 * The shell inline flag is `-c` with any run of `l` and `i` before it, which is
 * `INLINE_SCRIPT_FLAG` in that module, spelled here as the same regular
 * expression for the same reason.
 */
export const SCRIPT_INTERPRETERS: ReadonlyMap<string, readonly (string | RegExp)[]> = new Map([
  ["bash", [/^-[li]*c$/u]],
  ["sh", [/^-[li]*c$/u]],
  ["zsh", [/^-[li]*c$/u]],
  ["dash", [/^-[li]*c$/u]],
  ["ksh", [/^-[li]*c$/u]],
  ["fish", [/^-[li]*c$/u, "--command"]],
  ["node", ["-e", "--eval", "-p", "--print", "--input-type=module"]],
  ["nodejs", ["-e", "--eval", "-p", "--print"]],
  ["python", ["-c"]],
  ["python3", ["-c"]],
  ["perl", ["-e", "-E"]],
  ["ruby", ["-e"]],
  ["deno", ["eval"]],
]);

/** One script the argv names, bound by its bytes. */
export interface BoundScript {
  /** Which argv word named it. */
  argv_index: number;
  /** The path as resolved against the payload's `cwd`: absolute, always. */
  path: string;
  /** The file's size in bytes, which the approver's card shows beside the digest. */
  bytes: number;
  /** SHA-256 (lowercase hex) of the file's bytes. */
  sha256: string;
}

/** The `approval run` payload value, canonicalized and hashed by the caller. */
export interface RunPayload {
  argv: string[];
  cwd: string;
  /** Present only when the argv named a readable script. */
  script?: BoundScript;
}

/**
 * The digest and size of one file, read in bounded chunks, or `null` when it
 * cannot be read at all.
 *
 * `null` for every failure — gone, a directory, a device, permission denied, a
 * disappearing file, a read error partway — and the reason is not recorded
 * anywhere. Recording it would put a local errno inside hashed material, so two
 * machines that agree about the bytes could disagree about the payload; and the
 * only thing a reader could do with it is treat "unreadable" as a state, which
 * the recomputation already handles better than any field could.
 */
function fileDigest(path: string): { bytes: number; sha256: string } | null {
  let fd: number;
  try {
    const stats = statSync(path);
    if (!stats.isFile()) return null;
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(DIGEST_CHUNK_BYTES);
  let bytes = 0;
  try {
    let read = readSync(fd, buffer, 0, DIGEST_CHUNK_BYTES, null);
    while (read > 0) {
      hash.update(buffer.subarray(0, read));
      bytes += read;
      read = readSync(fd, buffer, 0, DIGEST_CHUNK_BYTES, null);
    }
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // A close that fails has nothing to do with the bytes already hashed.
    }
  }
  return { bytes, sha256: hash.digest("hex") };
}

/** The last path segment of an argv word: `/usr/bin/bash` reads as `bash`. */
function basenameOf(word: string): string {
  const segments = word.split("/");
  return segments[segments.length - 1] ?? word;
}

/** Does `word` mean "the program is inline" for this interpreter? */
function isInlineProgramFlag(word: string, markers: readonly (string | RegExp)[]): boolean {
  return markers.some((marker) =>
    typeof marker === "string" ? word === marker : marker.test(word),
  );
}

/**
 * The words of an interpreter invocation that could be its script, in order,
 * or `null` when the program is inline and there is no file at all.
 *
 * An inline-program marker anywhere in the options answers `null` rather than
 * "keep looking": the program is a word of the argv and already bound, and a
 * file that happens to share its spelling is a file the command never opens.
 *
 * Otherwise every non-option word is a candidate, in argv order, and the caller
 * binds the first that resolves to a readable regular file. Not just the first
 * non-option word, because interpreters take SUBCOMMANDS: `deno run job.ts`
 * would otherwise offer `run` and stop, and `python3 -m pkg job.py` would offer
 * `pkg`. Walking on cannot bind anything the argv does not name, and the worst
 * case is the harmless direction — a command whose script is missing and whose
 * later argument happens to be a file binds that file, which is one more thing
 * bound rather than one fewer.
 *
 * An option that takes a separate path value is the one place this can pick the
 * wrong file (`node --require ./a.js job.js` binds `./a.js`), and both are
 * files that invocation executes.
 */
function scriptCandidateIndexes(
  argv: readonly string[],
  markers: readonly (string | RegExp)[],
): number[] | null {
  const candidates: number[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const word = argv[index] as string;
    if (isInlineProgramFlag(word, markers)) return null;
    if (word === "--") continue;
    if (word.startsWith("-") && word.length > 1) continue;
    candidates.push(index);
  }
  return candidates;
}

/**
 * Where an argv word points, resolved against the payload's own `cwd`.
 *
 * The cwd is the payload's, never `process.cwd()`: the payload already carries
 * the directory the child will run in, and resolving against anything else
 * would make the binding a function of where the hashing process happened to
 * stand.
 */
function resolveArgvPath(word: string, cwd: string): string | null {
  if (word === "" || word === "-" || word === "--") return null;
  if (word.includes("\0")) return null;
  return isAbsolute(word) ? word : resolvePath(cwd, word);
}

/**
 * The script this argv runs, bound by its bytes, or `null` (APRV-401).
 *
 * Two shapes, and only two: an interpreter this module names followed by a path
 * operand, and a path at `argv[0]` that the kernel will read a shebang from.
 * Anything else binds nothing and the payload is what it always was.
 */
export function boundScript(argv: readonly string[], cwd: string): BoundScript | null {
  const program = argv[0];
  if (program === undefined || program === "") return null;

  const markers = SCRIPT_INTERPRETERS.get(basenameOf(program));
  if (markers !== undefined) {
    const candidates = scriptCandidateIndexes(argv, markers);
    if (candidates === null) return null;
    for (const index of candidates) {
      const path = resolveArgvPath(argv[index] as string, cwd);
      if (path === null) continue;
      const digest = fileDigest(path);
      if (digest !== null) return { argv_index: index, path, ...digest };
    }
    return null;
  }

  // The degenerate case: no interpreter word, so the script IS argv[0] and the
  // interpreter is whatever its shebang names. A program with no separator in
  // it is a PATH lookup and is not this (see the module header).
  if (!isAbsolute(program) && !program.includes("/")) return null;
  const path = resolveArgvPath(program, cwd);
  if (path === null) return null;
  const digest = fileDigest(path);
  return digest === null ? null : { argv_index: 0, path, ...digest };
}

/**
 * The value `approval run`'s `payload_hash` is taken over (SPEC.md §6.2).
 *
 * `{argv, cwd}` when the argv names no readable script, byte for byte what it
 * has always been; `{argv, cwd, script}` when it does. The caller canonicalizes
 * and hashes it — this function decides WHAT is bound and never how it is
 * digested into an approval.
 */
export function runPayloadValue(argv: readonly string[], cwd: string): RunPayload {
  const script = boundScript(argv, cwd);
  const payload: RunPayload = { argv: [...argv], cwd };
  if (script !== null) payload.script = script;
  return payload;
}

/**
 * One line naming the bound script, for a refusal message or a terminal.
 *
 * Not a rendering an approver signs: the canonical renderer owns that, and this
 * is the executor explaining to an agent WHICH file moved.
 */
export function describeBoundScript(script: BoundScript | null): string {
  if (script === null) return "no script";
  return `argv[${String(script.argv_index)}] ${script.path}, ${String(script.bytes)} bytes, sha256 ${script.sha256}`;
}
