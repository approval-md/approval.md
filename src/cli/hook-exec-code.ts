/**
 * The disk half of `exec.code` (APRV-510): what a harness hook binds for an
 * opaque program once the policy has opened the class.
 *
 * The classifier (`core/command-class.ts`) reads the TEXT and says which word
 * of which segment carries a program. This module turns that into the bytes a
 * record binds, and it is impure on purpose: a file program is read from disk
 * here, at hook time, and hashed.
 *
 * ## What is bound, and what never is
 *
 * The payload carries, per program, `{interpreter, mode, code_sha256,
 * code_bytes, argv, workdir}` (plus the `path` of a file program), and for a
 * shell call the SHA-256 and length of the whole command line beside the
 * segments that are not programs. The program TEXT is never in it: the
 * payload's hash is what a log record carries and the payload itself is what
 * the payload store and a phone card hold, and a program written by an agent
 * is exactly where a secret it was handed would sit (SPEC.md §11.1 invariant
 * 3). The word of the argv that held the program is replaced by a marker
 * naming its hash. The command line's own hash still binds every byte, so a
 * grant over this payload is a grant over that exact command.
 *
 * ## A file that cannot be read is refused, never guessed
 *
 * `hook-exec-code-unreadable`: the file is absent, unreadable by this process
 * (EACCES under co-location, where the daemon's user cannot list the
 * resident's 0700 home), not a regular file, larger than
 * {@link EXEC_CODE_MAX_FILE_BYTES}, or relative after a `cd` this module
 * cannot place. The same code refuses a file this module cannot place by the
 * kernel's reading rather than its own (fix round 2): a path with a `..`
 * component, a `.` or empty component after the first, or a directory whose
 * realpath is not the directory as written (refuter M1: the hook folds `..`
 * lexically, the kernel follows a symlink first); a file program on a line
 * with any other segment (refuter M2: an earlier `echo > x.py`, `cp`, `mv`,
 * `tee` or `ln -sf` rewrites the file after the hash); and a harness that
 * states no working directory (refuter N8: the hook's own cwd is a guess).
 * That is the OPPOSITE of the skill-script pass (APRV-502),
 * which lets the text stand where the disk is unreadable, and deliberately:
 * a skill script's path is the thing that pass checks, while here the file's
 * bytes ARE the binding, and a record with no hash would record nothing.
 *
 * A file that resolves onto a credential or a protected path is refused
 * `hook-unclassified`, naming the landing, exactly as a skill script that
 * lands there is.
 *
 * ## What the hash does not close
 *
 * A file program is hashed when the hook runs and opened by the interpreter
 * afterwards. The program itself is not running in that window, and the
 * sole-segment rule closes every writer on the same line, so what remains is
 * a writer OTHER than the hooked call: a background job an earlier hooked
 * call started, another session, cron. One that rewrites the file in between
 * makes the interpreter run bytes the record never saw (fix round 3, refuter
 * S2). The record binds the bytes the hook saw; a writer the agent controls is
 * itself an earlier hooked, logged call, so the trail that explains a mismatch
 * is in the log. The record says which program the agent ASKED to run, which
 * is what the class is for; it is not a sandbox, and hash-then-exec cannot
 * close this without handing the interpreter the descriptor that was hashed.
 */

import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve as resolvePathSegments } from "node:path";

import {
  commandSegmentWords,
  isCredentialPath,
  protectedPathClass,
  type ClassifiedSegment,
  type ExecCodeSource,
  type ProtectedPathEntry,
} from "../core/command-class.js";

/** The largest file program this hook will read and hash. */
export const EXEC_CODE_MAX_FILE_BYTES = 16 * 1024 * 1024;

/** How a bound program reached the hook. */
export type ExecCodeBindingMode = "inline" | "file" | "execute_code";

/** One program, as a payload binds it. Never its text. */
export interface ExecCodeBinding {
  interpreter: string;
  mode: ExecCodeBindingMode;
  code_sha256: string;
  code_bytes: number;
  /** The argv from the binary on, the program word replaced by a hash marker. */
  argv: string[];
  /** The absolute directory the program runs in, or `null` when none is stated. */
  workdir: string | null;
  /** A file program's path as written. */
  path?: string;
}

/** A shell segment in an `exec.code` payload: its text, or the program it runs. */
export type ExecCodeSegment = { text: string } | { exec_code: number };

/** The payload a shell call carrying `exec.code` segments binds. */
export interface ExecCodeShellPayload {
  exec_code: ExecCodeBinding[];
  command_sha256: string;
  command_bytes: number;
  segments: ExecCodeSegment[];
  cwd: string;
}

export type ExecCodeBindResult =
  | { ok: true; payload: ExecCodeShellPayload; headline: string; notes: string[] }
  | { ok: false; code: "hook-exec-code-unreadable" | "hook-unclassified"; detail: string };

/** SHA-256, lowercase hex. */
export function sha256Hex(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The marker that stands in an argv where the program text was. */
export function programMarker(sha: string, bytes: number): string {
  return `<program sha256:${sha} ${String(bytes)} bytes>`;
}

/**
 * A program named WITHOUT its text, for a refusal or a note (refuter S1, S2):
 * the interpreter, the mode, and the inline program's hash and length or the
 * file's path as written. A deny string reaches the harness and the agent's
 * transcript, and a program is where a secret it was handed sits.
 */
export function describeProgram(source: ExecCodeSource): string {
  if (source.mode === "file") return `${source.interpreter} file ${source.source}`;
  const bytes = Buffer.from(source.source, "utf8");
  return `${source.interpreter} inline program sha256:${sha256Hex(bytes)} (${String(bytes.length)} bytes)`;
}

/**
 * Is `text` well-formed UTF-16, with no lone surrogate? (Refuter S5.) A lone
 * surrogate encodes to U+FFFD in UTF-8, so two programs that differ only there
 * would hash alike while a Python harness passes them on as different bytes.
 * Such a program or command is refused rather than bound by a lossy hash.
 */
export function isWellFormedText(text: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text);
}

/** A short form of a binding for a headline: `python3 -c sha256:0123456789ab (42 bytes)`. */
function headlineOf(binding: ExecCodeBinding): string {
  const how =
    binding.mode === "inline"
      ? `${binding.interpreter} inline`
      : binding.mode === "file"
        ? `${binding.interpreter} ${binding.path ?? "file"}`
        : "execute_code";
  return `exec.code ${how} sha256:${binding.code_sha256.slice(0, 12)} (${String(binding.code_bytes)} bytes)`;
}

/** Does an earlier segment move the working directory (`cd`, `pushd`, `popd`)? */
function directoryMovedBefore(segments: readonly ClassifiedSegment[], index: number): boolean {
  for (const earlier of segments.slice(0, index)) {
    const parsed = commandSegmentWords(earlier.text)?.[0];
    if (parsed === undefined) continue;
    const bin = parsed.bin.split("/").pop() ?? parsed.bin;
    if (bin === "cd" || bin === "pushd" || bin === "popd") return true;
  }
  return false;
}

/** The `code` of a filesystem error, or `null`. */
function fsCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code: unknown }).code;
  return typeof code === "string" ? code : null;
}

type FileRead =
  | { ok: true; bytes: Buffer }
  | { ok: false; code: "hook-exec-code-unreadable" | "hook-unclassified"; detail: string };

/** Read one file program, refusing everything this module cannot vouch for. */
function readProgramFile(
  source: string,
  spelled: string,
  protectedPaths: readonly ProtectedPathEntry[],
): FileRead {
  const unreadable = (why: string): FileRead => ({
    ok: false,
    code: "hook-exec-code-unreadable",
    detail: `the program file ${JSON.stringify(source)} ${why}, so its bytes cannot be hashed and nothing could bind what would run. Nothing was appended. Run it as an inline program, or from a file this hook can read`,
  });
  let real: string;
  try {
    real = realpathSync(spelled);
  } catch (error) {
    return unreadable(`cannot be resolved at ${spelled} (${fsCode(error) ?? "unknown error"})`);
  }
  if (isCredentialPath(real)) {
    return {
      ok: false,
      code: "hook-unclassified",
      detail: `the program file ${JSON.stringify(source)} resolves to ${real}, a credential path (account.credential); a program read from credential material is not run as exec.code`,
    };
  }
  const protectedClass = protectedPathClass(real, protectedPaths);
  if (protectedClass !== null) {
    return {
      ok: false,
      code: "hook-unclassified",
      detail: `the program file ${JSON.stringify(source)} resolves to ${real}, a protected path (${protectedClass}); a program read from the gate's own files is not run as exec.code`,
    };
  }
  try {
    const stat = statSync(real);
    if (!stat.isFile()) return unreadable(`resolves to ${real}, which is not a regular file`);
    if (stat.size > EXEC_CODE_MAX_FILE_BYTES) {
      return unreadable(
        `is ${String(stat.size)} bytes, above the ${String(EXEC_CODE_MAX_FILE_BYTES)}-byte limit this hook hashes`,
      );
    }
    return { ok: true, bytes: readFileSync(real) };
  } catch (error) {
    return unreadable(`cannot be read at ${real} (${fsCode(error) ?? "unknown error"})`);
  }
}

/**
 * Does a file program's path carry a component the kernel reads differently
 * from a lexical join? (Fix round 2, refuter M1.) A `..` anywhere (the kernel
 * follows a symlink before it climbs, `path.resolve` folds it first), and a
 * `.` or empty component after the first (`./x.py` and an absolute path's
 * leading `/` stay). Stricter than the kernel needs, on purpose: such a path
 * is refused, never folded.
 */
function indirectPathComponent(path: string): string | null {
  const parts = path.split("/");
  if (parts.includes("..")) return "a `..` component";
  if (parts.slice(1).includes(".")) return "a `.` component after the first";
  if (parts.slice(1).includes("")) return "an empty component (`//` or a trailing `/`)";
  return null;
}

type SegmentBind =
  | { ok: true; binding: ExecCodeBinding }
  | { ok: false; code: "hook-exec-code-unreadable" | "hook-unclassified"; detail: string };

/** One segment's program, bound. */
function bindSegment(
  source: ExecCodeSource,
  segments: readonly ClassifiedSegment[],
  index: number,
  workdir: string,
  fileWorkdir: string | null,
  protectedPaths: readonly ProtectedPathEntry[],
): SegmentBind {
  let bytes: Buffer;
  if (source.mode === "inline") {
    bytes = Buffer.from(source.source, "utf8");
  } else {
    const refuse = (why: string): SegmentBind => ({
      ok: false,
      code: "hook-exec-code-unreadable",
      detail: `the program file ${JSON.stringify(source.source)} ${why}, so this hook cannot tell which file would run. Nothing was appended. Run it as an inline program, or as the only command of the line, by a path with no \`..\` and no symlinked directory`,
    });
    if (!isAbsolute(source.source) && directoryMovedBefore(segments, index)) {
      return {
        ok: false,
        code: "hook-exec-code-unreadable",
        detail: `the program file ${JSON.stringify(source.source)} is relative and an earlier segment of the command moves the working directory, so this hook cannot tell which file would run. Nothing was appended. Name the file by its absolute path`,
      };
    }
    // Refuter M2: the hash is taken now and every other segment of the line
    // runs before or beside the interpreter, so any of them can rewrite,
    // move or relink the file (`echo … > x.py; python3 x.py`). File mode
    // opens only for a program that is the line's sole segment.
    if (segments.length !== 1) {
      return refuse(
        "shares the line with another segment, which may write, move or relink it after this hook hashes it (file mode is open only when the program is the line's sole command)",
      );
    }
    // Refuter N8: the directory the harness says the command runs in, or
    // nothing. The hook's own cwd is not evidence of where a relative path
    // lands, so a harness that states none gets no file mode.
    if (fileWorkdir === null || !isAbsolute(fileWorkdir)) {
      return refuse("is named on a call whose harness states no absolute working directory");
    }
    // Refuter M1: no `..` to fold, and the directory resolved by the kernel's
    // reading (realpath) must be the directory as written, so a symlinked
    // directory, a symlinked workdir included, is refused rather than folded.
    const indirect = indirectPathComponent(source.source);
    if (indirect !== null) return refuse(`has ${indirect}`);
    const directory = resolvePathSegments(fileWorkdir, dirname(source.source));
    let realDirectory: string;
    try {
      realDirectory = realpathSync(directory);
    } catch (error) {
      return refuse(`sits in ${directory}, which cannot be resolved (${fsCode(error) ?? "unknown error"})`);
    }
    if (realDirectory !== directory) {
      return refuse(`sits in ${directory}, which resolves through a symlink to ${realDirectory}`);
    }
    const read = readProgramFile(source.source, join(realDirectory, basename(source.source)), protectedPaths);
    if (!read.ok) return read;
    bytes = read.bytes;
  }
  const sha = sha256Hex(bytes);
  const argv = [...source.argv];
  if (source.mode === "inline") argv[source.sourceIndex] = programMarker(sha, bytes.length);
  return {
    ok: true,
    binding: {
      interpreter: source.interpreter,
      mode: source.mode,
      code_sha256: sha,
      code_bytes: bytes.length,
      argv,
      workdir: source.mode === "file" ? fileWorkdir : workdir,
      ...(source.mode === "file" ? { path: source.source } : {}),
    },
  };
}

/**
 * Bind every `exec.code` segment of a classified shell command, or refuse.
 *
 * `null` when no segment carries a program: the caller binds the command the
 * way it always has. `workdir` is the directory the command runs in (the
 * per-call one where the harness states it), and `cwd` is the value the
 * ordinary payload would have carried as its `cwd`. `fileWorkdir` is the
 * directory a file program is resolved against: the one the HARNESS states
 * (the per-call key, else the envelope's `cwd`), or `null` when it states
 * none, which refuses file mode rather than guess with the hook's own cwd
 * (fix round 2, refuter N8).
 */
export function bindExecCodeCommand(
  raw: string,
  segments: readonly ClassifiedSegment[],
  workdir: string,
  cwd: string,
  protectedPaths: readonly ProtectedPathEntry[],
  fileWorkdir: string | null,
): ExecCodeBindResult | null {
  if (!segments.some((segment) => segment.execCode !== undefined)) return null;
  if (!isWellFormedText(raw)) {
    return {
      ok: false,
      code: "hook-exec-code-unreadable",
      detail:
        "the command carries a lone UTF-16 surrogate, which has no exact byte encoding, so the program's hash could not bind what the harness hands the interpreter. Nothing was appended. Send the command as well-formed text",
    };
  }
  // Fix round 3 (refuter N-b): an embedded NUL is not text a command line can
  // carry. No argv word holds one (Node `spawn` and Python `subprocess` refuse
  // it), and a harness that writes the line to a script file hands bash bytes
  // it then drops, so the hash would bind `print(1)\0junk` while the
  // interpreter got `print(1)junk`, or nothing at all. Refused as not
  // well-formed text, the lone surrogate's code, rather than bound.
  if (raw.includes("\u0000")) {
    return {
      ok: false,
      code: "hook-exec-code-unreadable",
      detail:
        "the command carries an embedded NUL (U+0000), which no argv word can hold, so the program's hash could not bind what the harness hands the interpreter. Nothing was appended. Send the command as well-formed text",
    };
  }
  const bindings: ExecCodeBinding[] = [];
  const shown: ExecCodeSegment[] = [];
  for (const [index, segment] of segments.entries()) {
    if (segment.execCode === undefined) {
      shown.push({ text: segment.text });
      continue;
    }
    const bound = bindSegment(segment.execCode, segments, index, workdir, fileWorkdir, protectedPaths);
    if (!bound.ok) return bound;
    shown.push({ exec_code: bindings.length });
    bindings.push(bound.binding);
  }
  const others = shown.filter((entry): entry is { text: string } => "text" in entry);
  const headline = [
    ...bindings.map(headlineOf),
    ...(others.length === 0 ? [] : [`with ${others.map((entry) => entry.text).join(" ; ")}`]),
  ].join("; ");
  return {
    ok: true,
    payload: {
      exec_code: bindings,
      command_sha256: sha256Hex(raw),
      command_bytes: Buffer.byteLength(raw, "utf8"),
      segments: shown,
      cwd,
    },
    headline,
    notes: [
      `exec.code (APRV-510): ${bindings
        .map((binding) => `${binding.interpreter} ${binding.mode} program sha256:${binding.code_sha256} (${String(binding.code_bytes)} bytes)`)
        .join(", ")} bound by hash and length, never by text; the record says the program existed, and each tool call it makes is its own hook event`,
    ],
  };
}

/** The payload a Hermes `execute_code` call binds. */
export interface ExecuteCodePayload {
  tool: "execute_code";
  exec_code: ExecCodeBinding;
  /** The SHA-256 of the whole `tool_input`, canonical JSON, so every key is bound. */
  input_sha256: string;
}

/** Bind a Hermes `execute_code` call: the `code` string, by hash and length. */
export function bindExecuteCode(
  toolInput: Record<string, unknown>,
  inputHash: string,
):
  | { ok: true; payload: ExecuteCodePayload; headline: string; notes: string[] }
  | { ok: false; code: "hook-io" | "hook-exec-code-unreadable"; detail: string } {
  const code = toolInput["code"];
  if (typeof code !== "string") {
    return { ok: false, code: "hook-io", detail: "execute_code tool_input carries no code string" };
  }
  if (!isWellFormedText(code)) {
    return {
      ok: false,
      code: "hook-exec-code-unreadable",
      detail:
        "the execute_code program carries a lone UTF-16 surrogate, which has no exact byte encoding, so its hash could not bind what the kernel would run. Nothing was appended",
    };
  }
  const bytes = Buffer.from(code, "utf8");
  const sha = sha256Hex(bytes);
  const declared = toolInput["workdir"];
  const binding: ExecCodeBinding = {
    interpreter: "execute_code",
    mode: "execute_code",
    code_sha256: sha,
    code_bytes: bytes.length,
    argv: [],
    workdir: typeof declared === "string" && isAbsolute(declared) ? declared : null,
  };
  return {
    ok: true,
    payload: { tool: "execute_code", exec_code: binding, input_sha256: inputHash },
    headline: headlineOf(binding),
    notes: [
      `exec.code (APRV-510): execute_code program sha256:${sha} (${String(bytes.length)} bytes) bound by hash and length, never by text; each tool call made from inside the kernel is its own hook event (the policy declares exec.code.execute_code: hooked)`,
    ],
  };
}
