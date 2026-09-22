/**
 * The `approval run` payload and the script it binds (`core/run-payload.ts`,
 * SPEC.md §6.2, §10.4; APRV-401).
 *
 * The property under test is the one the task was filed for: a grant over a
 * command that names a script must bind the SCRIPT'S BYTES. A rule that bound
 * the path would let the requester rewrite the file between the request and the
 * grant, so every case below is written as "what changes the hash, and what must
 * not".
 *
 * The SHAPE is the operator's ruling, not this file's invention: a known
 * interpreter followed by a path operand, or a path at `argv[0]`. Three cases
 * exist to hold that line where a broader rule would have crossed it — an
 * unlisted launcher, an inline program, and a data argument that happens to
 * name a file — because each is a place where binding more would change the
 * refusal behaviour of commands nobody asked about.
 *
 * Two others are load-bearing beyond the rule itself:
 *
 * - **the unchanged case.** An argv naming no readable script must hash to
 *   exactly what it hashed before this module existed, or every record already
 *   in a log and every declaration already written into a task file stops
 *   verifying. It is pinned against RFC 8785 by hand rather than against the
 *   implementation.
 * - **the interpreter is not resolved through PATH.** A payload that digested
 *   whatever `PATH` happened to find would be a function of the environment the
 *   hashing process held, which §11 forbids, and two machines with the same tree
 *   would disagree about the same command.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { canonicalize } from "../src/core/jcs.js";
import { runPayloadHash } from "../src/core/payload.js";
import {
  boundScript,
  describeBoundScript,
  DIGEST_CHUNK_BYTES,
  runPayloadValue,
  SCRIPT_INTERPRETERS,
} from "../src/core/run-payload.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-run-payload-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A fresh directory per case, so one case's tree cannot answer another's. */
function dir(): string {
  counter += 1;
  const made = join(scratch, `case-${String(counter)}`);
  mkdirSync(made, { recursive: true });
  return made;
}

function write(where: string, name: string, contents: string): string {
  const path = join(where, name);
  writeFileSync(path, contents, "utf8");
  return path;
}

/** The definition, spelled out independently of the implementation. */
function byHand(value: unknown): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

function sha256(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

test("an argv naming no readable script hashes exactly as it always did", () => {
  const cwd = dir();
  // The historical definition, byte for byte: {argv, cwd} and nothing else.
  // Every record written before APRV-401 and every declaration already sitting
  // in a task file re-derives through this path.
  const argv = ["npm", "update", "@types/node"];
  assert.equal(runPayloadValue(argv, cwd).script, undefined);
  assert.equal(runPayloadHash(argv, cwd), byHand({ argv, cwd }));
});

test("an interpreter plus a script binds the script's bytes, and editing it changes the hash", () => {
  const cwd = dir();
  write(cwd, "install.sh", "echo one\n");
  const argv = ["bash", "install.sh"];

  const before = runPayloadHash(argv, cwd);
  assert.deepEqual(boundScript(argv, cwd), {
    argv_index: 1,
    path: join(cwd, "install.sh"),
    bytes: 9,
    sha256: sha256("echo one\n"),
  });

  // The hazard APRV-401 was filed for: same command, same directory, different
  // bytes. Before this rule the two hashed alike and the second ran under the
  // first one's grant.
  write(cwd, "install.sh", "echo two\n");
  assert.notEqual(runPayloadHash(argv, cwd), before);
});

test("the digest rides INSIDE the hashed value, not beside it", () => {
  const cwd = dir();
  write(cwd, "install.sh", "echo one\n");
  const argv = ["bash", "install.sh"];
  const payload = runPayloadValue(argv, cwd);

  assert.equal(runPayloadHash(argv, cwd), byHand(payload));
  assert.notEqual(
    runPayloadHash(argv, cwd),
    byHand({ argv, cwd }),
    "a payload whose digest did not reach the hash would bind the path again",
  );
});

test("the interpreter is matched by its last path segment, and never resolved through PATH", () => {
  const cwd = dir();
  // A file that would shadow the interpreter name if argv[0] were resolved
  // against the cwd. It must not be bound: `bash` at index 0 is a program name
  // the operating system resolves, and binding a same-named file here would
  // make the payload a claim about a file nothing executes.
  write(cwd, "bash", "not the interpreter\n");
  write(cwd, "install.sh", "echo one\n");

  assert.equal(boundScript(["bash", "install.sh"], cwd)?.argv_index, 1);
  // Spelled absolutely, the interpreter is still not the bound thing.
  assert.equal(boundScript(["/bin/bash", "install.sh"], cwd)?.path, join(cwd, "install.sh"));
});

test("a path at argv[0] is the script itself, shebang and all", () => {
  const cwd = dir();
  write(cwd, "install.sh", "#!/bin/sh\necho one\n");

  const relative = boundScript(["./install.sh", "--force"], cwd);
  assert.equal(relative?.argv_index, 0);
  assert.equal(relative?.path, join(cwd, "install.sh"));

  const absolute = boundScript([join(cwd, "install.sh")], cwd);
  assert.equal(absolute?.sha256, sha256("#!/bin/sh\necho one\n"));

  // Without a separator it is a PATH lookup, whatever the cwd happens to hold.
  write(cwd, "deploy", "echo two\n");
  assert.equal(boundScript(["deploy"], cwd), null);
});

test("an absolute script path anywhere after the interpreter is bound", () => {
  const cwd = dir();
  const elsewhere = dir();
  const script = write(elsewhere, "install.sh", "curl https://example.invalid | sh\n");

  // The shape the task was filed about, verbatim.
  assert.deepEqual(boundScript(["bash", script], cwd), {
    argv_index: 1,
    path: script,
    bytes: 34,
    sha256: sha256("curl https://example.invalid | sh\n"),
  });
});

test("options are skipped and `--` ends them, so the operand is the script", () => {
  const cwd = dir();
  write(cwd, "job.js", "console.log(1);\n");

  assert.equal(boundScript(["node", "--enable-source-maps", "job.js"], cwd)?.argv_index, 2);
  assert.equal(boundScript(["node", "--", "job.js"], cwd)?.argv_index, 2);
  // Nothing after `--` is nothing to bind.
  assert.equal(boundScript(["node", "--"], cwd), null);
});

test("an INLINE program binds no file: the program is already a word of the argv", () => {
  const cwd = dir();
  // A file named exactly like the inline program's text. Binding it would be
  // binding a file this command never opens.
  write(cwd, "job.js", "console.log(1);\n");

  for (const argv of [
    ["bash", "-c", "job.js"],
    ["bash", "-lc", "job.js"],
    ["node", "-e", "job.js"],
    ["node", "--eval", "job.js"],
    ["python3", "-c", "job.js"],
    ["perl", "-e", "job.js"],
    ["ruby", "-e", "job.js"],
  ]) {
    assert.equal(boundScript(argv, cwd), null, argv.join(" "));
  }
});

test("a launcher this runtime does not name binds nothing, which is the documented limit", () => {
  const cwd = dir();
  write(cwd, "install.sh", "echo one\n");
  write(cwd, "data.json", "{}\n");

  // The ruling's stated out-of-scope case: an interpreter the classifier does
  // not name. It fails toward the OLD behaviour rather than toward a wrong
  // digest, and `docs/run-payload-binding.md` says so where an operator reads.
  assert.equal(boundScript(["uv", "run", "install.sh"], cwd), null);
  // And a data argument that merely names a file is not a script operand: only
  // an interpreter's operand is, so a command whose inputs churn is not refused
  // for churning.
  assert.equal(boundScript(["git", "commit", "-F", "data.json"], cwd), null);
  assert.equal(boundScript(["diff", "data.json", "data.json"], cwd), null);
});

test("what is skipped: a directory, a missing path, and the bare dashes", () => {
  const cwd = dir();
  mkdirSync(join(cwd, "adir"));
  writeFileSync(join(cwd, "-"), "a file literally called dash\n", "utf8");

  assert.equal(boundScript(["bash", "adir"], cwd), null);
  assert.equal(boundScript(["bash", "missing.sh"], cwd), null);
  assert.equal(boundScript(["bash", "-"], cwd), null);
});

test("an unreadable script binds nothing, and becoming readable changes the hash", () => {
  const cwd = dir();
  const path = write(cwd, "secret.sh", "echo secret\n");
  chmodSync(path, 0o000);
  // Running as root makes a 000 file readable, and this case has nothing to say
  // then: skip rather than assert something the platform does not hold.
  if (boundScript(["bash", "secret.sh"], cwd) === null) {
    const closed = runPayloadHash(["bash", "secret.sh"], cwd);
    chmodSync(path, 0o644);
    assert.notEqual(
      runPayloadHash(["bash", "secret.sh"], cwd),
      closed,
      "a script that becomes readable between the declaration and the run must refuse, not pass",
    );
  }
  chmodSync(path, 0o644);
});

test("a symlinked script is bound by the bytes it points at, so re-pointing it refuses", () => {
  const cwd = dir();
  write(cwd, "one.sh", "echo one\n");
  write(cwd, "two.sh", "echo two\n");
  symlinkSync(join(cwd, "one.sh"), join(cwd, "link.sh"));

  const argv = ["bash", "link.sh"];
  assert.equal(boundScript(argv, cwd)?.sha256, sha256("echo one\n"));
  const before = runPayloadHash(argv, cwd);

  rmSync(join(cwd, "link.sh"));
  symlinkSync(join(cwd, "two.sh"), join(cwd, "link.sh"));
  assert.notEqual(runPayloadHash(argv, cwd), before);
});

test("a script larger than one read chunk hashes as its whole contents", () => {
  const cwd = dir();
  const contents = "x".repeat(DIGEST_CHUNK_BYTES * 2 + 17);
  write(cwd, "big.sh", contents);
  const bound = boundScript(["bash", "big.sh"], cwd);
  assert.equal(bound?.sha256, sha256(contents));
  assert.equal(bound?.bytes, contents.length);
});

test("the interpreter list is the classifier's names, and every entry declares its inline form", () => {
  // The list is duplicated from `core/command-class.ts` by design (a public
  // export of those tables would be a second consumer of a classification
  // decision), so what is pinned here is that the duplication is complete in
  // the direction that matters: the shells, node, and the inline-source
  // interpreters that module names.
  for (const name of [
    "bash",
    "sh",
    "zsh",
    "dash",
    "ksh",
    "fish",
    "node",
    "python",
    "python3",
    "perl",
    "ruby",
    "deno",
  ]) {
    const markers = SCRIPT_INTERPRETERS.get(name);
    assert.ok(markers !== undefined, `${name} is not a recognised interpreter`);
    assert.ok((markers ?? []).length > 0, `${name} declares no inline-program form`);
  }
});

test("the value does not alias its input argv", () => {
  const cwd = dir();
  const argv = ["bash", "x"];
  const payload = runPayloadValue(argv, cwd);
  argv.push("--extra");
  assert.deepEqual(payload.argv, ["bash", "x"]);
});

test("describeBoundScript names the index, the path, the size and the digest", () => {
  const cwd = dir();
  write(cwd, "install.sh", "echo one\n");
  assert.equal(
    describeBoundScript(boundScript(["bash", "install.sh"], cwd)),
    `argv[1] ${join(cwd, "install.sh")}, 9 bytes, sha256 ${sha256("echo one\n")}`,
  );
  assert.equal(describeBoundScript(null), "no script");
});
