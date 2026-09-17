/**
 * Credential starvation under a sandboxed exec (APRV-193 AC3).
 *
 * The task's premise is that arbitrary code execution is capability-complete:
 * gate `communicate.email.external` and an agent can reimplement it in a script
 * that `npm test` runs. Two controls answer that, and this file tests the
 * second: egress is denied (`tests/sandbox.test.ts`, AC2), and the credential
 * material is unreadable, so an authenticated effect is impossible regardless
 * of where the packets could go.
 *
 * What is proved here, with a real `sandbox-exec` rather than a claim about a
 * profile's text:
 *
 * 1. a child under the profile cannot read `.approval/vault.enc`, `.approval/env`
 *    or `.approval/keys/`, EVEN WHEN those files sit inside a directory the
 *    read jail opens. SBPL takes the last matching rule, and the credential
 *    denials are emitted after the root allows for exactly this reason;
 * 2. the same denial holds with no read jail at all, which is the profile
 *    `approval run` has built since APRV-193 — so this property does not depend
 *    on APRV-347 and did not arrive with it;
 * 3. the CONTROL: unsandboxed, the same script reads all three. A test whose
 *    "denied" case would also pass against a missing file is not a test.
 *
 * The laundering script is an ordinary `node` program of the kind the hook
 * classifies `files.write.workspace` and allows — the whole point being that
 * its NAME says nothing about what it does.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  credentialPathsFor,
  detectSandbox,
  resolveExecutable,
  wrapForSandbox,
  type EgressAllowance,
} from "../src/core/sandbox.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-starvation-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const FOUND = detectSandbox();
const SKIP = FOUND.available ? false : `no sandbox primitive here: ${FOUND.reason}`;

/** The secret this suite invents, so nothing real is ever at stake. */
const CIPHERTEXT = "aprv193-vault-ciphertext-not-a-real-secret";
const TOKEN_LINE = "APPROVAL_TG_TOKEN=keychain:approval-telegram-token";

/**
 * An ordinary workspace script, of the class the hook ALLOWS. It reports what
 * it managed to read, on stdout, one line per target, so the assertions are
 * about what the child actually obtained rather than about its exit code.
 */
const LAUNDERING_SCRIPT = [
  'import { readFileSync, readdirSync } from "node:fs";',
  "for (const target of process.argv.slice(2)) {",
  "  try {",
  "    const stolen = target.endsWith('keys')",
  "      ? readdirSync(target).join(',')",
  '      : readFileSync(target, "utf8");',
  "    process.stdout.write(`READ ${target} ${stolen.trim()}\\n`);",
  "  } catch (cause) {",
  "    process.stdout.write(`DENIED ${target} ${String(cause.code ?? cause)}\\n`);",
  "  }",
  "}",
  "",
].join("\n");

interface Space {
  root: string;
  script: string;
  vault: string;
  envFile: string;
  keys: string;
  logPath: string;
}

function space(): Space {
  counter += 1;
  const root = join(scratch, `case-${String(counter)}`);
  mkdirSync(join(root, ".approval", "log"), { recursive: true });
  mkdirSync(join(root, ".approval", "keys"), { recursive: true });
  const script = join(root, "launder.mjs");
  writeFileSync(script, LAUNDERING_SCRIPT, "utf8");
  const vault = join(root, ".approval", "vault.enc");
  const envFile = join(root, ".approval", "env");
  writeFileSync(vault, `${CIPHERTEXT}\n`, "utf8");
  writeFileSync(envFile, `${TOKEN_LINE}\n`, "utf8");
  writeFileSync(join(root, ".approval", "keys", "req-1.pem"), "private-key-material\n", "utf8");
  return {
    root: realpathSync(root),
    script,
    vault,
    envFile,
    keys: join(root, ".approval", "keys"),
    logPath: join(root, ".approval", "log", "events.jsonl"),
  };
}

function targetsOf(s: Space): string[] {
  return [s.vault, s.envFile, s.keys];
}

/** Run the laundering script, optionally under a profile. `null` means unwrapped. */
function launder(s: Space, allowance: EgressAllowance | null): string {
  const node = resolveExecutable("node");
  assert.notEqual(node, null, "node is not on PATH");
  const args = [s.script, ...targetsOf(s)];
  if (allowance === null) {
    const bare = spawnSync(node as string, args, { cwd: s.root, encoding: "utf8" });
    return bare.stdout ?? "";
  }
  const wrapped = wrapForSandbox(
    FOUND.mechanism as "sandbox-exec",
    node as string,
    args,
    allowance,
  );
  try {
    const result = spawnSync(wrapped.command, wrapped.args, { cwd: s.root, encoding: "utf8" });
    return result.stdout ?? "";
  } finally {
    rmSync(wrapped.cleanup, { recursive: true, force: true });
  }
}

function assertStarved(output: string, s: Space): void {
  for (const target of targetsOf(s)) {
    // `includes` rather than a regex: the targets are absolute paths full of
    // characters a pattern would have to escape, and the line the script writes
    // is already unambiguous.
    assert.equal(
      output.includes(`DENIED ${target} `),
      true,
      `${target} was readable:\n${output}`,
    );
  }
  // The stronger assertion, and the one that would catch a profile that denied
  // the wrong path: the secret's BYTES are nowhere in what the child produced.
  assert.equal(output.includes(CIPHERTEXT), false, "the vault's contents left the sandbox");
  assert.equal(output.includes(TOKEN_LINE), false, "the environment map left the sandbox");
}

test("the CONTROL: unsandboxed, the same script reads all three", () => {
  // Today's behaviour without a profile, pinned so that closing it is a visible
  // change and so the denial below cannot be passing for the wrong reason.
  const s = space();
  const output = launder(s, null);
  assert.equal(output.includes(`READ ${s.vault} ${CIPHERTEXT}`), true, output);
  assert.equal(output.includes(`READ ${s.envFile} ${TOKEN_LINE}`), true, output);
  assert.equal(output.includes(`READ ${s.keys} req-1.pem`), true, output);
});

test("under the egress profile the credential material is unreadable", { skip: SKIP }, () => {
  // No read jail: this is the profile `approval run` has built since APRV-193,
  // so the property does not depend on APRV-347 and did not arrive with it.
  const s = space();
  assertStarved(launder(s, { loopback: false, denyRead: credentialPathsFor(s.logPath) }), s);
});

test("under the read jail it stays unreadable INSIDE an allowed root", { skip: SKIP }, () => {
  // The case worth proving once APRV-347 exists: the jail opens the workspace,
  // and `.approval/` sits inside the workspace. SBPL takes the last matching
  // rule, so the credential denials are emitted after the root allows; written
  // the other way round the allow would override them and this would pass a
  // profile that protected nothing.
  const s = space();
  assertStarved(
    launder(s, {
      loopback: false,
      denyRead: credentialPathsFor(s.logPath),
      allowRead: [s.root],
    }),
    s,
  );
});

test("the jail alone does not starve credentials; the deny-list does", { skip: SKIP }, () => {
  // The negative control for the control. With the root opened and NO
  // `denyRead`, the same files ARE readable — which is what makes the two cases
  // above evidence about `credentialPathsFor` rather than about the jail.
  const s = space();
  const output = launder(s, { loopback: false, denyRead: [], allowRead: [s.root] });
  assert.equal(output.includes(CIPHERTEXT), true, output);
});
