/**
 * The read jail: a deny-default Seatbelt read profile (APRV-347).
 *
 * Two halves, and the second is the one that matters.
 *
 * The first is the profile as TEXT, including the property that costs nothing
 * and is easy to break: a profile built WITHOUT `allowRead` is byte-identical
 * to the profile this runtime produced before the jail existed. Every
 * deployment that has not asked for a read jail must get the same bytes, and a
 * fixture comparison is the only way to know that rather than believe it.
 *
 * The second runs a real `sandbox-exec`. A profile is a claim about a kernel,
 * and a test that only reads the claim back to itself proves nothing: these
 * cases read a file inside the root (succeeds), read a file beside it (EPERM,
 * with an unjailed control that must SUCCEED so a no-op jail fails here rather
 * than passing), and run `npm run build` in a scratch package to show ordinary
 * development survives. They skip cleanly where the primitive is absent.
 *
 * The credential half — that the same jailed exec cannot read the vault or
 * `.approval/env` — is `tests/sandbox-credential-starvation.test.ts`
 * (APRV-193 AC3).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import {
  DENY_ALL_EGRESS,
  RUNTIME_READ_PATHS,
  credentialPathsFor,
  detectSandbox,
  resolveExecutable,
  resolveForProfile,
  seatbeltProfile,
  wrapForSandbox,
} from "../src/core/sandbox.js";

/**
 * The fixtures live under the system temp root, and the jail still denies the
 * sibling — which is only true because the roots are passed EXPLICITLY.
 *
 * `resolveReadRoots` puts the session scratchpad and the system temp root in
 * the effective read scope, so `approval run` and `approval sandbox` open them
 * and ordinary build tooling keeps working. Those roots reach the profile from
 * the CALLER, though, and not from anything compiled into `core/sandbox.ts`. A
 * caller that passes a narrower set gets a narrower jail, which is what these
 * cases do: a gate root at `<temp>/case-N/muse` and a sibling at
 * `<temp>/case-N/other`, with only the first in `allowRead`.
 *
 * The first draft of this file had the temp roots compiled into the profile's
 * runtime set, and it could not demonstrate a denial at all — the sibling was
 * readable through the temp allowance rather than through the root. That was a
 * widening no operator could turn off, and the test failing to fail is how it
 * was found.
 */
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-read-jail-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const FOUND = detectSandbox();
const SKIP = FOUND.available ? false : `no sandbox primitive here: ${FOUND.reason}`;

interface Space {
  /** The gate root: the only project directory the jail opens. */
  root: string;
  /** A directory BESIDE the root, which the jail must not open. */
  sibling: string;
  vault: string;
  envFile: string;
  logPath: string;
}

function space(): Space {
  counter += 1;
  const base = join(scratch, `case-${String(counter)}`);
  const root = join(base, "muse");
  const sibling = join(base, "other");
  mkdirSync(join(root, ".approval", "log"), { recursive: true });
  mkdirSync(join(root, ".approval", "keys"), { recursive: true });
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(root, "mine.txt"), "this one is mine\n", "utf8");
  writeFileSync(join(sibling, "secrets.txt"), "sk-live-not-yours\n", "utf8");
  const vault = join(root, ".approval", "vault.enc");
  const envFile = join(root, ".approval", "env");
  writeFileSync(vault, "ciphertext-that-should-not-be-readable", "utf8");
  writeFileSync(envFile, "APPROVAL_TG_TOKEN=keychain:approval-telegram-token\n", "utf8");
  return {
    root: realpathSync(root),
    sibling: realpathSync(sibling),
    vault,
    envFile,
    logPath: join(root, ".approval", "log", "events.jsonl"),
  };
}

// ---------------------------------------------------------------------------
// The profile as text
// ---------------------------------------------------------------------------

test("without allowRead the profile bytes are unchanged, to the byte", () => {
  const paths = credentialPathsFor("/x/.approval/log/events.jsonl");
  const base = seatbeltProfile({ loopback: false, denyRead: paths });
  // The two spellings a caller can reach "no jail" by must be one profile: the
  // key omitted, and the key present and empty. (`allowRead: undefined` is not
  // a third spelling — `exactOptionalPropertyTypes` refuses it at the type
  // level, which is the compiler making the same point.)
  assert.equal(seatbeltProfile({ loopback: false, denyRead: paths, allowRead: [] }), base);
  assert.equal(base.includes("(deny file-read*)"), false, "no deny-default crept in");
  assert.equal(base.includes("(allow file-read*"), false, "no subpath allow crept in");
  // And the default allowance, which is what `approval run` uses today.
  assert.equal(seatbeltProfile(DENY_ALL_EGRESS).includes("(deny file-read*)"), false);
});

test("with allowRead the profile is deny-default, then the roots, then the runtime set", () => {
  const profile = seatbeltProfile({
    loopback: false,
    denyRead: ["/x/.approval/vault.enc"],
    allowRead: ["/dev/muse"],
  });
  assert.match(profile, /^\(deny file-read\*\)$/mu);
  assert.match(profile, /\(allow file-read\* \(subpath "\/dev\/muse"\)\)/u);
  for (const runtime of RUNTIME_READ_PATHS) {
    // Every compiled-in runtime path is opened under the name the KERNEL will
    // match, which is why the comparison goes through `resolveForProfile`: two
    // of the entries (`/var/db/dyld` and `/private/var/db/dyld`) are the same
    // directory through macOS's `/var` symlink, and one of them is deduplicated
    // away rather than emitted twice.
    assert.equal(
      profile.includes(`(subpath "${resolveForProfile(runtime)}"`),
      true,
      `${runtime} is missing from the profile`,
    );
  }
  // Metadata on the ancestors, or a subpath deep in the tree opens nothing: a
  // process must be able to stat its way down to the root it is allowed.
  assert.match(profile, /\(allow file-read-metadata \(literal "\/dev"\)\)/u);
});

test("the credential denials are the LAST word, even inside an allowed root", () => {
  const profile = seatbeltProfile({
    loopback: false,
    denyRead: ["/dev/muse/.approval/vault.enc"],
    allowRead: ["/dev/muse"],
  });
  const allowIndex = profile.indexOf('(allow file-read* (subpath "/dev/muse")');
  const denyIndex = profile.indexOf('(deny file-read* (literal "/dev/muse/.approval/vault.enc")');
  assert.notEqual(allowIndex, -1);
  assert.notEqual(denyIndex, -1);
  // SBPL takes the last matching rule. A denial written BEFORE the allow that
  // contains it would be overridden by it and would protect nothing.
  assert.equal(denyIndex > allowIndex, true, "the credential denial must follow the root allow");
});

test("the jail opens the directory the command itself lives in", () => {
  // You cannot run a program you may not read. The wrapper derives this from
  // the argv it was handed — it is not a widening a caller can ask for — and it
  // is what lets a `node` or `npm` from a version manager under `~` start at
  // all. Asserted through `wrapForSandbox`, because that is where it happens.
  const resolved = resolveExecutable("node");
  assert.notEqual(resolved, null);
  const wrapped = wrapForSandbox(
    "sandbox-exec",
    resolved as string,
    ["--version"],
    { loopback: false, denyRead: [], allowRead: ["/dev/muse"] },
  );
  try {
    const profile = readFileSync(wrapped.args[wrapped.args.indexOf("-f") + 1] as string, "utf8");
    const own = dirname(realpathSync(resolved as string));
    assert.match(profile, new RegExp(`\\(subpath "${own}"\\)`, "u"));
    assert.match(profile, new RegExp(`\\(subpath "${dirname(own)}"\\)`, "u"));
  } finally {
    rmSync(wrapped.cleanup, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// A real kernel
// ---------------------------------------------------------------------------

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run `argv` under a read jail rooted at `roots`, with `denyRead` on top. */
function jailed(
  roots: readonly string[],
  denyRead: readonly string[],
  argv: readonly string[],
  cwd: string,
): Ran {
  assert.notEqual(FOUND.mechanism, null);
  const resolved = resolveExecutable(argv[0] as string);
  assert.notEqual(resolved, null, `${String(argv[0])} is not on PATH`);
  const wrapped = wrapForSandbox(
    FOUND.mechanism as "sandbox-exec",
    resolved as string,
    argv.slice(1),
    { loopback: false, denyRead, allowRead: roots },
  );
  try {
    const result = spawnSync(wrapped.command, wrapped.args, { cwd, encoding: "utf8" });
    return {
      code: result.status ?? -1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } finally {
    rmSync(wrapped.cleanup, { recursive: true, force: true });
  }
}

test("inside the root a read succeeds; a sibling is EPERM", { skip: SKIP }, () => {
  const s = space();
  const inside = jailed([s.root], [], ["cat", join(s.root, "mine.txt")], s.root);
  assert.equal(inside.code, 0, `${inside.stdout}${inside.stderr}`);
  assert.match(inside.stdout, /this one is mine/u);

  const outside = jailed([s.root], [], ["cat", join(s.sibling, "secrets.txt")], s.root);
  assert.notEqual(outside.code, 0, "a sibling read must fail");
  assert.equal(outside.stdout.includes("sk-live-not-yours"), false, "nothing leaked on stdout");
  assert.match(outside.stderr, /Operation not permitted|not permitted/iu);
});

test("the control: WITHOUT the jail the same sibling read succeeds", { skip: SKIP }, () => {
  // The load-bearing half. A jail that denied nothing would pass the case above
  // if the file simply did not exist, so the unjailed run has to succeed.
  const s = space();
  const resolved = resolveExecutable("cat");
  assert.notEqual(resolved, null);
  const wrapped = wrapForSandbox(
    FOUND.mechanism as "sandbox-exec",
    resolved as string,
    [join(s.sibling, "secrets.txt")],
    DENY_ALL_EGRESS,
  );
  try {
    const result = spawnSync(wrapped.command, wrapped.args, { cwd: s.root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr ?? "");
    assert.match(result.stdout ?? "", /sk-live-not-yours/u);
  } finally {
    rmSync(wrapped.cleanup, { recursive: true, force: true });
  }
});

test("`npm run build` inside the root still passes under the jail", { skip: SKIP }, () => {
  const s = space();
  // A scratch package rather than this repository's own: the point is that the
  // jail lets a real `npm run build` start node, resolve its own binary, read
  // the project and write an artefact. Using this checkout would instead be a
  // test of where ITS node_modules happens to live (see the note below).
  writeFileSync(
    join(s.root, "package.json"),
    `${JSON.stringify(
      { name: "read-jail-fixture", private: true, type: "module", scripts: { build: "node build.mjs" } },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(
    join(s.root, "build.mjs"),
    [
      'import { readFileSync, writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'const src = readFileSync(join(process.cwd(), "mine.txt"), "utf8");',
      'writeFileSync(join(process.cwd(), "built.txt"), src.toUpperCase());',
      'process.stdout.write("built\\n");',
      "",
    ].join("\n"),
    "utf8",
  );
  const run = jailed([s.root], credentialPathsFor(s.logPath), ["npm", "run", "build"], s.root);
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /built/u);
});

test(
  "a dependency tree OUTSIDE the root is refused, which is the documented limit",
  { skip: SKIP },
  () => {
    // Stated as a test rather than only as prose, because it is the one way the
    // jail breaks an ordinary project: dependencies resolved from a directory
    // above the gate root (a linked package, a shared store, a git worktree
    // whose node_modules lives in the primary checkout). The fix is a
    // `read_scope.roots` entry naming it, which is what that key is for.
    const s = space();
    const outside = join(s.sibling, "lib.mjs");
    writeFileSync(outside, 'export const value = "from outside";\n', "utf8");
    writeFileSync(
      join(s.root, "importer.mjs"),
      `import { value } from ${JSON.stringify(outside)};\nprocess.stdout.write(value);\n`,
      "utf8",
    );
    const refused = jailed([s.root], [], ["node", join(s.root, "importer.mjs")], s.root);
    assert.notEqual(refused.code, 0, "an import from outside the root must fail");

    const widened = jailed(
      [s.root, s.sibling],
      [],
      ["node", join(s.root, "importer.mjs")],
      s.root,
    );
    assert.equal(widened.code, 0, `${widened.stdout}${widened.stderr}`);
    assert.match(widened.stdout, /from outside/u);
  },
);
