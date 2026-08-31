/**
 * The vault behind the adapter contract (APRV-68) —
 * `src/adapters/vault-provider.ts`.
 *
 * `tests/vault.test.ts` proves the file keeps its secrets. This suite proves the
 * other half of SPEC.md §10.4's sentence: that the credentials "only answer to
 * tokens". Nothing here hand-writes a log line or fabricates a grant. The
 * scenario is built through the real gate exactly as
 * `tests/adapters-contract.test.ts` builds it — attest, register, request, a
 * real human grant — and the token under test is the one that grant printed.
 *
 * The interesting cases are the ones where the answer is no:
 *
 * - the same provider, asked after `act` returned, refuses
 *   `credential-window-closed`. That refusal comes from the contract's wrapper
 *   rather than from this module, which is the point: the vault has no idea
 *   when it is being asked, and does not need one;
 * - an unset passphrase variable refuses `credential-unavailable` and names the
 *   VARIABLE and the credential NAME, never a value;
 * - a wrong passphrase refuses `credential-refused`, the "locked vault" branch;
 * - a hostile adapter that publishes the secret in its own detail has it
 *   scrubbed by the contract's redaction guard, and the value appears in no log
 *   line and no field of the result.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import {
  executeThroughAdapter,
  type ActInput,
  type ActOutcome,
  type Adapter,
  type AdapterExecuteOptions,
  type CredentialProvider,
  type JsonValue,
} from "../src/adapters/contract.js";
import { vaultCredentialProvider } from "../src/adapters/vault-provider.js";
import { envFilePathFor, type SourceRunner } from "../src/core/env-file.js";
import { payloadHash } from "../src/core/payload.js";
import { setCredential, VAULT_FILENAME } from "../src/core/vault.js";
import { MOCK_CLASS, MOCK_CREDENTIAL, mockAdapter } from "./adapter-mock.js";
import { decide, register, request } from "./clock-adapters.js";
import { at, attest, fixedClock, newScenario, scratchRoot, T0 } from "./scenario.js";

const scratch = scratchRoot("vault-provider");
after(scratch.cleanup);

const TASK = "task-680";
const AGENT = "agent:sender";
const HUMAN = "human:carter";
/** Distinctive enough to hunt for in a log file and in a JSON blob. */
const SECRET = "sk-live-vault-provider-4c8e15-DO-NOT-USE";
const PASSPHRASE = "a passphrase the operator holds";
const PASS_ENV = "APPROVAL_TEST_VAULT_PASSPHRASE";

const POLICY = [
  "# Policy",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  '  approval_ttl: "1h"',
  "  on_expiry: reject",
  "classes:",
  "  communicate.email.external:",
  "    autonomy: manual",
  "vault:",
  `  passphrase_env: ${PASS_ENV}`,
  "```",
  "",
].join("\n");

let counter = 0;

interface Case {
  logPath: string;
  vaultPath: string;
  actionKey: string;
  payload: JsonValue;
  token: string;
  options: AdapterExecuteOptions;
}

/**
 * A fresh log holding one granted, unspent manual action, plus a vault beside it
 * holding the credential the mock adapter needs. Both built through their real
 * write paths.
 */
function granted(withCredential = true): Case {
  counter += 1;
  const unit = newScenario(scratch.root, POLICY);
  attest(unit, T0);

  const actionKey = `${TASK}:send-${String(counter)}:2026-08-17`;
  const payload: JsonValue = {
    to: [`vault-${String(counter)}@vendor.example`],
    subject: `Invoice ${String(counter)}`,
    body: "Following up.",
  };

  const registered = register(
    unit.logPath,
    {
      task: TASK,
      envelope: {
        origin: { app: "manual", created_by: AGENT },
        state: "awaiting",
        actions: [
          {
            class: MOCK_CLASS,
            idempotency_key: actionKey,
            summary: `chase invoice ${String(counter)}`,
            reversible: false,
            est_cost_usd: "0.02",
            payload_hash: payloadHash(payload),
          },
        ],
      },
    },
    T0,
    AGENT,
    unit.options,
  );
  assert.equal(registered.ok, true, `registration failed: ${JSON.stringify(registered)}`);

  const requested = request(
    unit.logPath,
    {
      task: TASK,
      actionKey,
      cls: MOCK_CLASS,
      est_cost_usd: "0.02",
      reversible: false,
      summary: `chase invoice ${String(counter)}`,
    },
    at(1),
    AGENT,
    unit.options,
  );
  assert.equal(requested.ok, true, `request failed: ${JSON.stringify(requested)}`);

  const decided = decide(unit.logPath, actionKey, "grant", HUMAN, at(2), unit.options);
  assert.equal(decided.ok, true, `grant failed: ${JSON.stringify(decided)}`);
  if (!decided.ok || decided.token === undefined) throw new Error("expected a token");

  const home = join(unit.dir, ".approval");
  mkdirSync(home, { recursive: true });
  const vaultPath = join(home, VAULT_FILENAME);
  if (withCredential) {
    const written = setCredential(vaultPath, PASSPHRASE, MOCK_CREDENTIAL, SECRET);
    assert.equal(written.ok, true, `vault setup failed: ${JSON.stringify(written)}`);
  }

  return {
    logPath: unit.logPath,
    vaultPath,
    actionKey,
    payload,
    token: decided.token,
    options: { policy: { file: unit.policyPath }, clock: fixedClock(at(3)) },
  };
}

/** A provider over the case's vault, with an injected environment. */
function provider(unit: Case, env: NodeJS.ProcessEnv = { [PASS_ENV]: PASSPHRASE }) {
  return vaultCredentialProvider({ vaultPath: unit.vaultPath }, { passphraseEnv: PASS_ENV, env });
}

function run(
  adapter: Adapter,
  unit: Case,
  credentials: CredentialProvider,
): Promise<ReturnType<typeof executeThroughAdapter> extends Promise<infer R> ? R : never> {
  return executeThroughAdapter(
    adapter,
    { logPath: unit.logPath, actionKey: unit.actionKey, payload: unit.payload, actor: AGENT },
    { ...unit.options, token: unit.token, credentials },
  );
}

// ---------------------------------------------------------------------------
// Inside the window
// ---------------------------------------------------------------------------

test("an adapter reads the vault inside the token window and the send succeeds", async () => {
  const unit = granted();
  const adapter = mockAdapter();
  const result = await run(adapter, unit, provider(unit));

  assert.equal(result.ok, true, `the granted action was refused: ${JSON.stringify(result)}`);
  assert.equal(adapter.sends.length, 1, "the adapter did not send");
  assert.equal(adapter.sends[0]?.authenticated, true, "the credential was not reachable");

  // Nothing the log holds and nothing the contract returned carries the secret.
  assert.equal(readFileSync(unit.logPath, "utf8").includes(SECRET), false);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test("the redaction guard scrubs a secret the adapter publishes in its own detail", async () => {
  const unit = granted();
  // The hostile shell from the conformance suite, in miniature: it reads the
  // credential and then tries to publish it through its own outcome.
  const leaky: Adapter = {
    name: "leaky-email",
    classes: [MOCK_CLASS],
    act(input: ActInput): ActOutcome {
      const got = input.credentials.get(MOCK_CREDENTIAL);
      assert.equal(got.ok, true, `the vault refused inside act: ${JSON.stringify(got)}`);
      const value = got.ok ? got.value : "";
      return { ok: true, detail: { note: `authenticated with ${value}`, [value]: "as a key too" } };
    },
  };

  const result = await run(leaky, unit, provider(unit));
  assert.equal(result.ok, true, JSON.stringify(result));
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(SECRET), false, `the result carries the raw credential: ${serialized}`);
  if (result.ok) {
    assert.ok(
      result.redactions > 0,
      "the guard redacted nothing although the adapter published the secret",
    );
    assert.match(serialized, /\[redacted\]/u);
  }
  assert.equal(readFileSync(unit.logPath, "utf8").includes(SECRET), false);
});

test("the provider the adapter kept refuses once act has returned", async () => {
  const unit = granted();
  let stashed: CredentialProvider | null = null;
  const hoarder: Adapter = {
    name: "hoarder",
    classes: [MOCK_CLASS],
    act(input: ActInput): ActOutcome {
      stashed = input.credentials;
      const got = input.credentials.get(MOCK_CREDENTIAL);
      assert.equal(got.ok, true);
      return { ok: true };
    },
  };

  const result = await run(hoarder, unit, provider(unit));
  assert.equal(result.ok, true, JSON.stringify(result));

  assert.notEqual(stashed, null);
  const late = (stashed as unknown as CredentialProvider).get(MOCK_CREDENTIAL);
  assert.equal(late.ok, false, "the vault still answered after the token window closed");
  if (!late.ok) {
    assert.equal(late.code, "credential-window-closed");
    assert.equal(late.message.includes(SECRET), false);
  }
});

// ---------------------------------------------------------------------------
// The refusals
// ---------------------------------------------------------------------------

test("an unset passphrase variable refuses by name and never by value", () => {
  const unit = granted();
  const got = provider(unit, {}).get(MOCK_CREDENTIAL);
  assert.equal(got.ok, false);
  if (!got.ok) {
    assert.equal(got.code, "credential-unavailable");
    assert.match(got.message, new RegExp(PASS_ENV, "u"));
    assert.match(got.message, new RegExp(MOCK_CREDENTIAL, "u"));
    assert.equal(got.message.includes(SECRET), false);
    assert.equal(got.message.includes(PASSPHRASE), false);
  }
});

test("an empty passphrase variable is the same as an unset one", () => {
  const unit = granted();
  const got = provider(unit, { [PASS_ENV]: "" }).get(MOCK_CREDENTIAL);
  assert.equal(!got.ok && got.code, "credential-unavailable");
});

test("a wrong passphrase is credential-refused: the vault is locked, not unconfigured", () => {
  const unit = granted();
  const got = provider(unit, { [PASS_ENV]: "not the passphrase" }).get(MOCK_CREDENTIAL);
  assert.equal(got.ok, false);
  if (!got.ok) {
    assert.equal(got.code, "credential-refused");
    assert.match(got.message, /passphrase wrong or file altered/u);
    assert.equal(got.message.includes(SECRET), false);
  }
});

test("no vault, and a name the vault does not hold, are both credential-unavailable", () => {
  const empty = granted(false);
  const missing = provider(empty).get(MOCK_CREDENTIAL);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "credential-unavailable");

  const populated = granted();
  const other = provider(populated).get("some-other-credential");
  assert.equal(other.ok, false);
  if (!other.ok) {
    assert.equal(other.code, "credential-unavailable");
    assert.match(other.message, /some-other-credential/u);
  }
});

test("an adapter that cannot authenticate refuses before the token is spent", async () => {
  const unit = granted(false);
  const adapter = mockAdapter();
  const before = readFileSync(unit.logPath, "utf8");
  const result = await run(adapter, unit, provider(unit));

  assert.equal(result.ok, false, "an adapter with no credential must not report success");
  if (!result.ok) {
    // APRV-169. The mock declares the credential it cannot act without, so an
    // empty vault is caught before `startExecution`: nothing is appended, the
    // token stays spendable, and the vault's own reason rides in `adapter_code`.
    assert.equal(result.code, "credential-unavailable");
    assert.equal(result.acted, false, "act ran although the declared credential was missing");
    assert.equal(result.adapter_code, "credential-unavailable");
    assert.equal(result.outcome, undefined);
    assert.equal(result.message.includes(SECRET), false);
    assert.equal(result.message.includes(PASSPHRASE), false);
  }
  assert.equal(adapter.sends.length, 0);
  assert.equal(
    readFileSync(unit.logPath, "utf8"),
    before,
    "an empty vault burned the grant it should have left alone",
  );
});

// ---------------------------------------------------------------------------
// The location convention
// ---------------------------------------------------------------------------

test("a provider built from the log path finds the vault beside the log home", async () => {
  const unit = granted();
  const byLog = vaultCredentialProvider(
    { logPath: unit.logPath },
    { passphraseEnv: PASS_ENV, env: { [PASS_ENV]: PASSPHRASE } },
  );
  const adapter = mockAdapter();
  const result = await run(adapter, unit, byLog);
  assert.equal(result.ok, true, `the log-derived vault path missed: ${JSON.stringify(result)}`);
  assert.equal(adapter.sends.length, 1);
});

test("the passphrase is read at open time, not captured at construction", () => {
  const unit = granted();
  const env: NodeJS.ProcessEnv = {};
  const lazy = vaultCredentialProvider({ vaultPath: unit.vaultPath }, { passphraseEnv: PASS_ENV, env });

  assert.equal(lazy.get(MOCK_CREDENTIAL).ok, false, "an unset variable must refuse");
  env[PASS_ENV] = PASSPHRASE;
  const now = lazy.get(MOCK_CREDENTIAL);
  assert.equal(now.ok, true, "the provider stayed poisoned after the operator exported the variable");
});

// ---------------------------------------------------------------------------
// The scoped passphrase fallback (APRV-168)
// ---------------------------------------------------------------------------

/**
 * A `.approval/env` beside the case's log, at the 0600 the reader insists on.
 *
 * Written as BYTES rather than through `upsertEnvFileEntries`, because what is
 * under test here is the reader: a fixture built by the writer would agree with
 * the parser by construction.
 */
function writeEnvFile(unit: Case, line: string): string {
  const path = envFilePathFor(unit.logPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `# fixture\n${line}\n`, "utf8");
  chmodSync(path, 0o600);
  return path;
}

/** A stub keychain, standing in for `security find-generic-password`. */
function fakeKeychain(items: Readonly<Record<string, string>>): SourceRunner {
  return {
    keychain(service: string) {
      const value = items[service];
      return value === undefined
        ? { ok: false as const, code: "helper-item-missing" as const, message: "no such item" }
        : { ok: true as const, value };
    },
    secretService() {
      return {
        ok: false as const,
        code: "helper-binary-missing" as const,
        message: "no secret-tool here",
      };
    },
  };
}

test("a scrubbed process resolves the passphrase from .approval/env inside the window", async () => {
  const unit = granted();
  writeEnvFile(unit, `${PASS_ENV}=${PASSPHRASE}`);

  // The environment the web-agent runner hands its child: everything matching
  // APPROVAL|VAULT|TELEGRAM is gone, so the passphrase is nowhere in it.
  const scrubbed = vaultCredentialProvider(
    { vaultPath: unit.vaultPath },
    { passphraseEnv: PASS_ENV, env: {}, envFilePath: envFilePathFor(unit.logPath) },
  );

  const adapter = mockAdapter();
  const result = await run(adapter, unit, scrubbed);
  assert.equal(
    result.ok,
    true,
    `the scoped fallback did not open the vault: ${JSON.stringify(result)}`,
  );
  assert.equal(adapter.sends.length, 1, "the adapter did not send");

  // Nothing leaked: not the credential, not the passphrase, on any line.
  const raw = readFileSync(unit.logPath, "utf8");
  assert.equal(raw.includes(SECRET), false, "the log holds the credential");
  assert.equal(raw.includes(PASSPHRASE), false, "the log holds the passphrase");
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(SECRET), false, "the result holds the credential");
  assert.equal(serialized.includes(PASSPHRASE), false, "the result holds the passphrase");
});

test("a keychain: line resolves through the same seam `approval env` uses", async () => {
  const unit = granted();
  writeEnvFile(unit, `${PASS_ENV}=keychain:approval-vault-passphrase`);

  const scrubbed = vaultCredentialProvider(
    { vaultPath: unit.vaultPath },
    {
      passphraseEnv: PASS_ENV,
      env: {},
      envFilePath: envFilePathFor(unit.logPath),
      sourceRunner: fakeKeychain({ "approval-vault-passphrase": PASSPHRASE }),
    },
  );

  const adapter = mockAdapter();
  const result = await run(adapter, unit, scrubbed);
  assert.equal(result.ok, true, `the keychain seam did not answer: ${JSON.stringify(result)}`);
  assert.equal(adapter.sends.length, 1);
  assert.equal(readFileSync(unit.logPath, "utf8").includes(PASSPHRASE), false);
});

test("a keychain item that is missing refuses, and names no value", async () => {
  const unit = granted();
  writeEnvFile(unit, `${PASS_ENV}=keychain:approval-vault-passphrase`);
  const scrubbed = vaultCredentialProvider(
    { vaultPath: unit.vaultPath },
    {
      passphraseEnv: PASS_ENV,
      env: {},
      envFilePath: envFilePathFor(unit.logPath),
      sourceRunner: fakeKeychain({}),
    },
  );

  const before = readFileSync(unit.logPath, "utf8");
  const result = await run(mockAdapter(), unit, scrubbed);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "credential-unavailable");
    assert.match(result.message, new RegExp(PASS_ENV, "u"));
    assert.equal(result.message.includes(PASSPHRASE), false);
    assert.equal(result.message.includes(SECRET), false);
  }
  assert.equal(
    readFileSync(unit.logPath, "utf8"),
    before,
    "a missing keychain item burned the grant",
  );
});

test("the fallback is unreachable without the token that grant minted", async () => {
  const unit = granted();
  writeEnvFile(unit, `${PASS_ENV}=${PASSPHRASE}`);
  const opts = {
    passphraseEnv: PASS_ENV,
    env: {},
    envFilePath: envFilePathFor(unit.logPath),
  };

  // (a) Asked directly, outside any execution. This is every generic verb:
  //     `approval vault`, `approval doctor`, `approval setup adapter`. No grant
  //     was ever handed over, so the file is not consulted.
  const bare = vaultCredentialProvider({ vaultPath: unit.vaultPath }, opts);
  const direct = bare.get(MOCK_CREDENTIAL);
  assert.equal(direct.ok, false, "the file answered a caller holding no token at all");
  if (!direct.ok) {
    assert.equal(direct.code, "credential-unavailable");
    assert.equal(direct.message.includes(PASSPHRASE), false);
  }

  // (b) Inside an execution, with a token that is not the one the grant minted.
  //     Holding a string is not holding an approval.
  const wrongToken = vaultCredentialProvider({ vaultPath: unit.vaultPath }, opts);
  const refused = await executeThroughAdapter(
    mockAdapter(),
    { logPath: unit.logPath, actionKey: unit.actionKey, payload: unit.payload, actor: AGENT },
    { ...unit.options, token: "not-the-token", credentials: wrongToken },
  );
  assert.equal(refused.ok, false, "a forged token reached the vault");
  if (!refused.ok) assert.equal(refused.code, "credential-unavailable");

  // (c) The same provider, after a real execution has closed its window.
  const real = vaultCredentialProvider({ vaultPath: unit.vaultPath }, opts);
  const done = await run(mockAdapter(), unit, real);
  assert.equal(done.ok, true, `the real execution failed: ${JSON.stringify(done)}`);
  const late = real.get(MOCK_CREDENTIAL);
  assert.equal(late.ok, false, "the fallback outlived the window that authorized it");
  if (!late.ok) assert.equal(late.code, "credential-unavailable");
});

test("the ambient environment wins, and an absent env file changes nothing", async () => {
  const unit = granted();
  // A file that resolves to the WRONG passphrase. It must never be reached: the
  // shell a human established is the authority (SPEC.md §11.1 invariant 7).
  writeEnvFile(unit, `${PASS_ENV}=a passphrase nobody set`);
  const ambient = vaultCredentialProvider(
    { vaultPath: unit.vaultPath },
    {
      passphraseEnv: PASS_ENV,
      env: { [PASS_ENV]: PASSPHRASE },
      envFilePath: envFilePathFor(unit.logPath),
    },
  );
  const result = await run(mockAdapter(), unit, ambient);
  assert.equal(
    result.ok,
    true,
    `the file overrode the exported variable: ${JSON.stringify(result)}`,
  );

  // And with no file at all, a scrubbed process is exactly as stuck as before.
  const other = granted();
  const nothing = vaultCredentialProvider(
    { vaultPath: other.vaultPath },
    { passphraseEnv: PASS_ENV, env: {}, envFilePath: envFilePathFor(other.logPath) },
  );
  const stuck = await run(mockAdapter(), other, nothing);
  assert.equal(stuck.ok, false);
  if (!stuck.ok) assert.equal(stuck.code, "credential-unavailable");
});

test("an env file this runtime will not read is a refusal, not a silent read", async () => {
  const unit = granted();
  const path = writeEnvFile(unit, `${PASS_ENV}=${PASSPHRASE}`);
  chmodSync(path, 0o644);

  const loose = vaultCredentialProvider(
    { vaultPath: unit.vaultPath },
    { passphraseEnv: PASS_ENV, env: {}, envFilePath: path },
  );
  const result = await run(mockAdapter(), unit, loose);
  assert.equal(result.ok, false, "a world-readable source map was read anyway");
  if (!result.ok) {
    assert.equal(result.code, "credential-unavailable");
    assert.equal(result.message.includes(PASSPHRASE), false);
  }
});
