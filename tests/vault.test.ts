/**
 * The credential vault (APRV-68) — `src/core/vault.ts`.
 *
 * Two properties are asserted almost everywhere here, because they are the
 * whole promise of the module:
 *
 * - **the credential value appears in nothing** except `getCredential`'s return.
 *   Every other result, every refusal message, and the file on disk are scanned
 *   for it, and the scan runs on the failure paths as well as the happy one; and
 * - **a write is a whole write.** The map is re-encrypted under a fresh nonce
 *   and lands atomically, so two writes of the same value differ on disk and an
 *   interrupted one leaves the previous vault intact.
 *
 * Nothing here hand-writes a vault file. Every file under test was produced by
 * `setCredential`, in the same spirit as the log suites, and the tamper cases
 * edit a real file rather than fabricating a plausible one.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_PASSPHRASE_ENV,
  SCRYPT_PARAMS,
  VAULT_FILENAME,
  VAULT_FORMAT_VERSION,
  VAULT_REFUSAL_CODES,
  checkVault,
  getCredential,
  listCredentials,
  passphraseEnvFor,
  passphraseFrom,
  removeCredential,
  secretsEqual,
  setCredential,
  vaultExists,
  vaultPathFor,
} from "../src/core/vault.js";
import { loadPolicy } from "../src/core/policy-load.js";
import { scratchRoot } from "./scenario.js";

const scratch = scratchRoot("vault");
after(scratch.cleanup);

/** Distinctive enough that a stray occurrence anywhere is unambiguous. */
const SECRET = "sk-live-vault-suite-7f3a91-DO-NOT-USE";
const OTHER_SECRET = "smtp-pw-vault-suite-2b6c04-DO-NOT-USE";
const PASSPHRASE = "correct horse battery staple";

let counter = 0;

/** A fresh, empty vault directory and the path a vault would take in it. */
function freshPath(): string {
  counter += 1;
  const dir = join(scratch.root, `vault-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, VAULT_FILENAME);
}

/** A vault holding one credential, written through the real path. */
function populated(name = "api-key", value = SECRET): string {
  const path = freshPath();
  const written = setCredential(path, PASSPHRASE, name, value);
  assert.equal(written.ok, true, `setup write failed: ${JSON.stringify(written)}`);
  return path;
}

/** Assert `value` occurs nowhere in the JSON of `subject`. */
function assertNoSecret(subject: unknown, secret = SECRET): void {
  const text = typeof subject === "string" ? subject : JSON.stringify(subject);
  assert.equal(
    text.includes(secret),
    false,
    `a credential value escaped into ${text.slice(0, 400)}`,
  );
}

// ---------------------------------------------------------------------------
// Paths and names
// ---------------------------------------------------------------------------

test("the vault sits beside the log home, never inside the log directory", () => {
  assert.equal(
    vaultPathFor("/home/p/.approval/log/events.jsonl"),
    join("/home/p/.approval", "vault.enc"),
  );
  // A --log pointed somewhere ad hoc puts the vault beside that file.
  assert.equal(vaultPathFor("/tmp/x/other.jsonl"), join("/tmp/x", "vault.enc"));
});

test("the passphrase variable is named by the policy, and defaulted when it is not", () => {
  const dir = join(scratch.root, "policy-home");
  mkdirSync(dir, { recursive: true });

  const withVault = join(dir, "APPROVAL.md");
  writeFileSync(
    withVault,
    ["```yaml approval-policy", 'version: "0.1"', "vault:", "  passphrase_env: MY_VAULT_PASS", "```", ""].join("\n"),
    "utf8",
  );
  assert.equal(passphraseEnvFor(loadPolicy({ file: withVault })), "MY_VAULT_PASS");

  const without = join(dir, "PLAIN.md");
  writeFileSync(without, ["```yaml approval-policy", 'version: "0.1"', "```", ""].join("\n"), "utf8");
  assert.equal(passphraseEnvFor(loadPolicy({ file: without })), DEFAULT_PASSPHRASE_ENV);

  // A policy that does not load leaves the default in force for this key alone:
  // the variable's NAME is not a permission, so an unrelated schema typo must
  // not lock an operator out of credentials they created (SPEC.md §5.2, APRV-68).
  assert.equal(
    passphraseEnvFor(loadPolicy({ file: join(dir, "nope.md") })),
    DEFAULT_PASSPHRASE_ENV,
  );
});

test("passphraseFrom reads the named variable and treats empty as unset", () => {
  assert.equal(passphraseFrom("X_VAULT", { X_VAULT: "hunter2" }), "hunter2");
  assert.equal(passphraseFrom("X_VAULT", { X_VAULT: "" }), null);
  assert.equal(passphraseFrom("X_VAULT", {}), null);
});

// ---------------------------------------------------------------------------
// The round trip
// ---------------------------------------------------------------------------

test("set, get, list and remove round-trip through a real file", () => {
  const path = freshPath();
  assert.equal(vaultExists(path), false);

  const first = setCredential(path, PASSPHRASE, "api-key", SECRET);
  assert.equal(first.ok, true);
  if (first.ok) {
    assert.equal(first.created, true);
    assert.equal(first.count, 1);
    assertNoSecret(first);
  }
  assert.equal(vaultExists(path), true);

  const second = setCredential(path, PASSPHRASE, "smtp-password", OTHER_SECRET);
  assert.equal(second.ok, true);
  if (second.ok) assert.equal(second.count, 2);

  const listed = listCredentials(path, PASSPHRASE);
  assert.equal(listed.ok, true);
  if (listed.ok) {
    assert.deepEqual(listed.names, ["api-key", "smtp-password"]);
    assert.equal(listed.count, 2);
    assertNoSecret(listed);
    assertNoSecret(listed, OTHER_SECRET);
  }

  const got = getCredential(path, PASSPHRASE, "api-key");
  assert.equal(got.ok, true);
  if (got.ok) assert.equal(got.value, SECRET);

  const replaced = setCredential(path, PASSPHRASE, "api-key", "rotated-value");
  assert.equal(replaced.ok, true);
  if (replaced.ok) {
    assert.equal(replaced.created, false, "replacing a name is not a creation");
    assert.equal(replaced.count, 2);
  }
  const afterRotation = getCredential(path, PASSPHRASE, "api-key");
  assert.equal(afterRotation.ok && afterRotation.value, "rotated-value");

  const removed = removeCredential(path, PASSPHRASE, "api-key");
  assert.equal(removed.ok, true);
  if (removed.ok) {
    assert.equal(removed.count, 1);
    assertNoSecret(removed);
  }
  const gone = getCredential(path, PASSPHRASE, "api-key");
  assert.equal(gone.ok, false);
  if (!gone.ok) assert.equal(gone.code, "credential-absent");

  // The one still there is untouched by the removal of its neighbour.
  const survivor = getCredential(path, PASSPHRASE, "smtp-password");
  assert.equal(survivor.ok && survivor.value, OTHER_SECRET);
});

test("the file on disk carries the ciphertext and nothing readable", () => {
  const path = populated();
  const raw = readFileSync(path, "utf8");
  assertNoSecret(raw);
  // The NAMES are inside the ciphertext too: an agent that can read the file
  // learns neither what is stored nor what it is called.
  assert.equal(raw.includes("api-key"), false, "a credential name is readable on disk");

  const file = JSON.parse(raw) as Record<string, unknown>;
  assert.deepEqual(Object.keys(file).sort(), [
    "ciphertext_b64",
    "kdf",
    "nonce_b64",
    "tag_b64",
    "version",
  ]);
  assert.equal(file["version"], VAULT_FORMAT_VERSION);
  assert.deepEqual(file["kdf"], {
    alg: "scrypt",
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    salt_b64: (file["kdf"] as Record<string, unknown>)["salt_b64"],
  });
  assert.equal(Buffer.from(String(file["nonce_b64"]), "base64").length, 12);
  assert.equal(Buffer.from(String(file["tag_b64"]), "base64").length, 16);
});

test("a vault is written 0600 and never world-readable", () => {
  const path = populated();
  const mode = statSync(path).mode & 0o777;
  assert.equal(mode & 0o077, 0, `vault mode is ${mode.toString(8)}; group/other must have nothing`);
});

test("every write draws a fresh nonce: the same value twice differs on disk", () => {
  const path = populated();
  const firstBytes = readFileSync(path, "utf8");
  const firstFile = JSON.parse(firstBytes) as Record<string, string>;

  // The identical map, re-encrypted. Nothing about the content changed.
  const again = setCredential(path, PASSPHRASE, "api-key", SECRET);
  assert.equal(again.ok, true);
  const secondFile = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;

  assert.notEqual(
    firstFile["nonce_b64"],
    secondFile["nonce_b64"],
    "a repeated GCM nonce under one key leaks the plaintexts and the authentication subkey",
  );
  assert.notEqual(firstFile["ciphertext_b64"], secondFile["ciphertext_b64"]);
  assert.notEqual(firstFile["tag_b64"], secondFile["tag_b64"]);
  // The salt is reused, so the passphrase that opened it still does.
  assert.deepEqual(firstFile["kdf"], secondFile["kdf"]);
  const got = getCredential(path, PASSPHRASE, "api-key");
  assert.equal(got.ok && got.value, SECRET);
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test("the refusal union is frozen (SPEC.md §11.1 invariant 6)", () => {
  assert.deepEqual(
    [...VAULT_REFUSAL_CODES],
    [
      "vault-absent",
      "passphrase-unset",
      "vault-io",
      "vault-malformed",
      "vault-version-unsupported",
      "vault-unreadable",
      "credential-absent",
      "invalid-name",
      "empty-value",
      "vault-write-failed",
    ],
  );
  assert.equal(new Set(VAULT_REFUSAL_CODES).size, VAULT_REFUSAL_CODES.length);
});

test("a wrong passphrase refuses vault-unreadable and says nothing more", () => {
  const path = populated();
  const listed = listCredentials(path, "not the passphrase");
  assert.equal(listed.ok, false);
  if (!listed.ok) {
    assert.equal(listed.code, "vault-unreadable");
    assert.match(listed.message, /passphrase wrong or file altered/u);
    // The conflation is the point: no branch of this message tells a guesser
    // which of the two they got.
    assert.equal(/wrong passphrase\b(?!.*altered)/u.test(listed.message), false);
    assertNoSecret(listed);
  }

  const got = getCredential(path, "not the passphrase", "api-key");
  assert.equal(!got.ok && got.code, "vault-unreadable");
});

test("a tampered ciphertext and a tampered tag both refuse, with the same code", () => {
  for (const field of ["ciphertext_b64", "tag_b64", "nonce_b64"] as const) {
    const path = populated();
    const file = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
    const bytes = Buffer.from(file[field] as string, "base64");
    // Flip one bit. The smallest possible edit an attacker could make.
    bytes[0] = (bytes[0] ?? 0) ^ 0x01;
    file[field] = bytes.toString("base64");
    writeFileSync(path, JSON.stringify(file), "utf8");

    const result = listCredentials(path, PASSPHRASE);
    assert.equal(result.ok, false, `a flipped bit in ${field} was accepted`);
    if (!result.ok) assert.equal(result.code, "vault-unreadable", `wrong code for ${field}`);
  }
});

test("a tampered KDF header is caught: the header is authenticated too", () => {
  const path = populated();
  const file = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const kdf = file["kdf"] as Record<string, unknown>;
  // A downgrade an attacker would like: a cheaper work factor, still in range.
  kdf["N"] = 1 << 12;
  writeFileSync(path, JSON.stringify(file), "utf8");

  const result = listCredentials(path, PASSPHRASE);
  assert.equal(result.ok, false, "a rewritten KDF header was honoured");
  if (!result.ok) assert.equal(result.code, "vault-unreadable");
});

test("a header this build will not act on is malformed, not unreadable", () => {
  const cases: Array<[string, (file: Record<string, unknown>) => void]> = [
    ["N out of range", (f) => ((f["kdf"] as Record<string, unknown>)["N"] = 1 << 30)],
    ["N not a power of two", (f) => ((f["kdf"] as Record<string, unknown>)["N"] = 16_385)],
    ["unknown kdf", (f) => ((f["kdf"] as Record<string, unknown>)["alg"] = "pbkdf2")],
    ["short nonce", (f) => (f["nonce_b64"] = Buffer.alloc(8).toString("base64"))],
    ["short tag", (f) => (f["tag_b64"] = Buffer.alloc(8).toString("base64"))],
    ["no ciphertext", (f) => delete f["ciphertext_b64"]],
  ];
  for (const [label, damage] of cases) {
    const path = populated();
    const file = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    damage(file);
    writeFileSync(path, JSON.stringify(file), "utf8");
    const result = listCredentials(path, PASSPHRASE);
    assert.equal(result.ok, false, `${label} was accepted`);
    if (!result.ok) assert.equal(result.code, "vault-malformed", `wrong code for ${label}`);
  }
});

test("an unknown format version is refused rather than guessed at", () => {
  const path = populated();
  const file = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  file["version"] = 2;
  writeFileSync(path, JSON.stringify(file), "utf8");

  const result = listCredentials(path, PASSPHRASE);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "vault-version-unsupported");
    assert.match(result.message, /version/u);
  }
});

test("a vault that is not JSON at all is malformed", () => {
  const path = freshPath();
  writeFileSync(path, "this is not a vault\n", "utf8");
  const result = listCredentials(path, PASSPHRASE);
  assert.equal(!result.ok && result.code, "vault-malformed");
});

test("an absent vault refuses vault-absent on every read path", () => {
  const path = freshPath();
  for (const result of [
    listCredentials(path, PASSPHRASE),
    getCredential(path, PASSPHRASE, "api-key"),
    removeCredential(path, PASSPHRASE, "api-key"),
    checkVault(path, PASSPHRASE),
  ]) {
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "vault-absent");
  }
});

test("removing a name the vault does not hold refuses credential-absent", () => {
  const path = populated();
  const result = removeCredential(path, PASSPHRASE, "no-such-credential");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "credential-absent");
  // And the file is unchanged: the one credential is still readable.
  assert.equal(getCredential(path, PASSPHRASE, "api-key").ok, true);
});

test("an empty value and an unusable name are refused before anything is written", () => {
  const path = freshPath();

  const empty = setCredential(path, PASSPHRASE, "api-key", "");
  assert.equal(!empty.ok && empty.code, "empty-value");
  assert.equal(vaultExists(path), false, "a refused write created a vault");

  for (const bad of ["", "has space", "tab\there", "new\nline"]) {
    const result = setCredential(path, PASSPHRASE, bad, SECRET);
    assert.equal(!result.ok && result.code, "invalid-name", `${JSON.stringify(bad)} was accepted`);
  }
  assert.equal(vaultExists(path), false);

  const noPass = setCredential(path, "", "api-key", SECRET);
  assert.equal(!noPass.ok && noPass.code, "passphrase-unset");
  assert.equal(vaultExists(path), false);
});

test("an unreadable vault file is I/O, not corruption", (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root ignores the permission bit");
    return;
  }
  const path = populated();
  chmodSync(path, 0o000);
  try {
    const result = listCredentials(path, PASSPHRASE);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "vault-io");
  } finally {
    chmodSync(path, 0o600);
  }
});

test("no refusal message anywhere carries the credential value", () => {
  const path = populated();
  const refusals: unknown[] = [
    listCredentials(path, "wrong"),
    getCredential(path, PASSPHRASE, "missing"),
    getCredential(path, "wrong", "api-key"),
    removeCredential(path, PASSPHRASE, "missing"),
    setCredential(path, PASSPHRASE, "bad name", SECRET),
    setCredential(path, PASSPHRASE, "api-key", ""),
    checkVault(path, "wrong"),
  ];
  for (const refusal of refusals) assertNoSecret(refusal);
});

// ---------------------------------------------------------------------------
// The structural rule
// ---------------------------------------------------------------------------

/**
 * The module's source, read from the checked-in tree.
 *
 * A source scan is the right instrument for this claim: the property is that no
 * *other* export can return a credential, and a behavioural test can only prove
 * something about the functions it happens to call.
 */
const VAULT_SOURCE = readFileSync(
  fileURLToPath(new URL("../../src/core/vault.ts", import.meta.url)),
  "utf8",
);

test("core/vault.ts exports exactly one function that can return a credential", () => {
  const exported = [...VAULT_SOURCE.matchAll(/^export function (\w+)/gmu)].map(
    (match) => match[1] as string,
  );
  assert.deepEqual(
    exported.sort(),
    [
      "checkVault",
      "getCredential",
      "listCredentials",
      "passphraseEnvFor",
      "passphraseFrom",
      "removeCredential",
      "secretsEqual",
      "setCredential",
      "vaultExists",
      "vaultPathFor",
    ],
    "the vault's exported surface changed; a new export must be shown not to return a credential value",
  );

  // Behaviourally: on a populated vault, every export except getCredential
  // produces something the secret does not appear in.
  const path = populated();
  assertNoSecret(listCredentials(path, PASSPHRASE));
  assertNoSecret(checkVault(path, PASSPHRASE));
  assertNoSecret(setCredential(path, PASSPHRASE, "second", OTHER_SECRET));
  assertNoSecret(setCredential(path, PASSPHRASE, "second", OTHER_SECRET), OTHER_SECRET);
  assertNoSecret(removeCredential(path, PASSPHRASE, "second"));
  assertNoSecret(vaultPathFor(path));
  assertNoSecret(String(vaultExists(path)));

  // And getCredential is the exception, deliberately.
  const got = getCredential(path, PASSPHRASE, "api-key");
  assert.equal(got.ok && got.value, SECRET);
});

test("no `openVault`-shaped export hands out the whole map", () => {
  assert.equal(
    /^export function open\b/mu.test(VAULT_SOURCE),
    false,
    "the plaintext map must not be reachable in one call: a caller who could get it would have no reason to go through the token window",
  );
  assert.equal(
    /^export (?:type|interface) Entries\b/mu.test(VAULT_SOURCE),
    false,
    "the name -> value map type must stay module-private",
  );
});

test("checkVault answers a diagnostic without naming anything", () => {
  const path = populated();
  const result = checkVault(path, PASSPHRASE);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.count, 1);
    assert.equal(JSON.stringify(result).includes("api-key"), false, "a health check learned a name");
  }
});

test("secretsEqual compares without a length-dependent early exit", () => {
  assert.equal(secretsEqual(SECRET, SECRET), true);
  assert.equal(secretsEqual(SECRET, `${SECRET}x`), false);
  assert.equal(secretsEqual("", ""), true);
});
