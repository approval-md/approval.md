/**
 * The checkpoint tap: the key ceremony, the cadence, and the channel prompt
 * (APRV-257, the delivery half of APRV-220).
 *
 * APRV-220's suite proves the record and the forgery it catches. This one
 * proves the three things that make it happen without a human remembering to:
 * the ceremony that mints the key, the rule that decides a checkpoint is due,
 * and the prompt that reaches a phone and a terminal.
 *
 * **Nothing here touches anything real.** Every key is minted per test into a
 * scratch directory; every vault is a scratch file under a passphrase this file
 * generates and injects rather than exporting; every log line goes through
 * `core/log.ts`'s real append path; the Bot API is the loopback mock in
 * `tests/telegram-mock.ts`; and the keystore the setup family would otherwise
 * probe is a `Map`.
 *
 * The load-bearing case is the last section. A checkpoint is worth having only
 * because a process an agent launched cannot produce one, so this file proves
 * the three locks that make that true — the classification, the stripped
 * passphrase, and the hook's module graph — rather than asserting it in prose.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { appendAttestation } from "../src/core/attest.js";
import {
  CHECKPOINT_KEY_CREDENTIAL,
  appendCheckpoint,
  appendCheckpointAt,
  checkLogCheckpoints,
  checkpointDue,
  checkpointKeyFingerprint,
  checkpointPolicyOf,
  checkpointSignersIn,
  mintCheckpointKeypair,
} from "../src/core/checkpoint.js";
import { childEnvironment } from "../src/core/child-env.js";
import { classifyCommand } from "../src/core/command-class.js";
import { getCredential, setCredential, vaultPathFor } from "../src/core/vault.js";
import { verifyWithRecords } from "../src/core/verify.js";
import type { EventRecord } from "../src/core/log.js";
import { CliChannel } from "../src/channels/cli.js";
import {
  TelegramChannel,
  parseCallbackData,
  parseCheckpointCallback,
} from "../src/channels/telegram.js";
import {
  checkpointOfferFor,
  checkpointPromptLines,
  resolveCheckpointKey,
  signCheckpointOffer,
  type CheckpointTap,
} from "../src/cli/checkpoint-tap.js";
import {
  checkpointHandlerFor,
  dispatchPending,
  newDispatchState,
  type ListenSetup,
} from "../src/cli/channel-telegram.js";
import { commandSetupCheckpoint } from "../src/cli/setup-checkpoint.js";
import type { KeystoreKind, KeystoreRunner, StoreOutcome } from "../src/cli/setup-common.js";
import type { Prompter, SecretRead } from "../src/cli/prompt.js";
import { assertLocal, callbackUpdate, startMockBotApi } from "./telegram-mock.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "approval-md-tap-")));
let counter = 0;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const HUMAN = "human:tester";
const CHAT = "12345";
const TOKEN = "1234567:AA-approval-md-checkpoint-tap-fixture-DO-NOT-USE";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A policy block, with whatever checkpoint configuration the case needs. */
function policyText(options: {
  keys?: readonly string[];
  every?: string;
  passphraseEnv?: string;
}): string {
  const lines = [
    "# Policy",
    "",
    "```yaml approval-policy",
    'version: "0.1"',
    "defaults:",
    "  autonomy: manual",
    '  approval_ttl: "1h"',
    "  on_expiry: reject",
    "classes:",
    "  read.*:",
    "    autonomy: autonomous",
  ];
  if (options.passphraseEnv !== undefined) {
    lines.push("vault:", `  passphrase_env: ${options.passphraseEnv}`);
  }
  const keys = options.keys ?? [];
  if (keys.length > 0 || options.every !== undefined) {
    lines.push("audit:");
    if (options.every !== undefined) lines.push(`  checkpoint_every: "${options.every}"`);
    if (keys.length > 0) {
      lines.push("  checkpoint_keys:");
      for (const key of keys) lines.push(`    - "${key}"`);
    }
  }
  lines.push("```", "");
  return lines.join("\n");
}

interface Home {
  dir: string;
  logPath: string;
  policyPath: string;
  keyPath: string;
  publicKey: string;
  privateKey: string;
  fingerprint: string;
  /** The variable this home's policy names for the vault passphrase. */
  passphraseEnv: string;
  /** The value of it, generated here and never exported into `process.env`. */
  passphrase: string;
}

/**
 * A scratch approval home: a log, a policy, a freshly minted keypair.
 *
 * The private half is written to a file (`--key-file`'s source) AND, when the
 * case asks, into a scratch vault under a per-test passphrase. Both custody
 * paths are the production ones; what is scratch is the directory.
 */
function newHome(
  options: {
    records?: number;
    keys?: "own" | "none";
    every?: string;
    vault?: boolean;
  } = {},
): Home {
  counter += 1;
  const dir = join(scratch, `home-${String(counter)}`);
  mkdirSync(join(dir, ".approval", "log"), { recursive: true });
  const pair = mintCheckpointKeypair();
  const passphraseEnv = `APPROVAL_TAP_PASSPHRASE_${String(counter)}`;
  const passphrase = `passphrase-${String(counter)}-${Math.random().toString(36).slice(2)}`;

  const policyPath = join(dir, "APPROVAL.md");
  writeFileSync(
    policyPath,
    policyText({
      keys: options.keys === "none" ? [] : [pair.publicKey],
      ...(options.every === undefined ? {} : { every: options.every }),
      passphraseEnv,
    }),
    "utf8",
  );
  const keyPath = join(dir, "checkpoint.key");
  writeFileSync(keyPath, `${pair.privateKey}\n`, { encoding: "utf8", mode: 0o600 });

  const home: Home = {
    dir,
    logPath: join(dir, ".approval", "log", "events.jsonl"),
    policyPath,
    keyPath,
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    fingerprint: pair.fingerprint,
    passphraseEnv,
    passphrase,
  };
  if (options.vault === true) {
    const stored = setCredential(
      vaultPathFor(home.logPath),
      passphrase,
      CHECKPOINT_KEY_CREDENTIAL,
      pair.privateKey,
    );
    assert.equal(stored.ok, true, stored.ok ? "" : stored.message);
  }
  for (let index = 0; index < (options.records ?? 3); index += 1) {
    appendRecord(home, `seed-${String(index)}`);
  }
  return home;
}

/** One record through the real append path. */
function appendRecord(home: Home, marker: string): EventRecord {
  const path = join(home.dir, ".approval", "attest-marker.md");
  const before = (() => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "# attested fixture\n";
    }
  })();
  writeFileSync(path, `${before}\n<!-- ${marker} -->\n`, "utf8");
  const appended = appendAttestation(home.logPath, path, HUMAN);
  assert.equal(appended.ok, true, appended.ok ? "" : appended.error.message);
  if (!appended.ok) throw new Error("unreachable");
  return appended.record;
}

function records(logPath: string): EventRecord[] {
  const walked = verifyWithRecords(logPath);
  assert.equal(walked.result.status, "clean", JSON.stringify(walked.result));
  return walked.records;
}

function head(logPath: string): { seq: number; hash: string } {
  const all = records(logPath);
  const last = all[all.length - 1] as EventRecord;
  return { seq: last.seq, hash: last.hash };
}

function tapFor(home: Home, key: "file" | "vault" = "file"): CheckpointTap {
  return {
    logPath: home.logPath,
    policy: { file: home.policyPath },
    keyFile: key === "file" ? home.keyPath : null,
    vault: null,
  };
}

/** The check, run the way every caller runs it: on already-verified records. */
function check(home: Home, now?: number): ReturnType<typeof checkLogCheckpoints> {
  const configured = checkpointPolicyOf({ file: home.policyPath });
  return checkLogCheckpoints({
    records: records(home.logPath),
    publicKeys: configured.publicKeys,
    checkpointEveryMs: configured.checkpointEveryMs,
    keysUnavailable: configured.unloadable,
    ...(now === undefined ? {} : { now }),
  });
}

// ===========================================================================
// Signing a head the human was SHOWN (APRV-220's verify rule, used)
// ===========================================================================

test("appendCheckpointAt signs the head it was given, not the head it finds", () => {
  const home = newHome({ records: 3 });
  const shown = head(home.logPath);

  // The daemon appends twice while the phone is in a pocket. This is the whole
  // reason APRV-220's verify rule asks only that a checkpoint signs a seq BELOW
  // its own rather than its immediate predecessor.
  appendRecord(home, "moved-1");
  appendRecord(home, "moved-2");

  const result = appendCheckpointAt(home.logPath, home.privateKey, HUMAN, shown, {
    channel: "telegram",
  });
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok) return;

  assert.equal(result.head.seq, shown.seq);
  assert.equal(result.head.hash, shown.hash);
  assert.equal(result.record.seq, shown.seq + 3, "the record lands at the real head");
  assert.equal(result.record.channel, "telegram");

  const verdict = check(home);
  assert.equal(verdict.status, "pass", JSON.stringify(verdict));
  if (verdict.status !== "pass") return;
  assert.equal(verdict.checkpoints.length, 1);
  assert.equal(verdict.checkpoints[0]?.seq, shown.seq);
});

test("a head this chain does not carry is refused, and nothing is appended", () => {
  const home = newHome({ records: 3 });
  const before = readFileSync(home.logPath);

  const wrongHash = appendCheckpointAt(home.logPath, home.privateKey, HUMAN, {
    seq: 2,
    hash: "f".repeat(64),
  });
  assert.equal(wrongHash.ok, false);
  if (wrongHash.ok) return;
  assert.equal(wrongHash.code, "checkpoint-head-unknown");
  assert.match(wrongHash.message, /carries [0-9a-f]{64} there/u);

  const noSuchSeq = appendCheckpointAt(home.logPath, home.privateKey, HUMAN, {
    seq: 99,
    hash: "f".repeat(64),
  });
  assert.equal(noSuchSeq.ok, false);
  if (noSuchSeq.ok) return;
  assert.equal(noSuchSeq.code, "checkpoint-head-unknown");
  assert.match(noSuchSeq.message, /no record at that seq/u);

  assert.deepEqual(readFileSync(home.logPath), before, "the log was left alone");
});

test("appendCheckpointAt is human-only, like every other way of signing one", () => {
  const home = newHome({ records: 2 });
  const before = readFileSync(home.logPath);
  const refused = appendCheckpointAt(
    home.logPath,
    home.privateKey,
    "agent:claude-code",
    head(home.logPath),
  );
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.code, "actor-not-human");
  assert.deepEqual(readFileSync(home.logPath), before);
});

test("checkpointSignersIn names every key that signed, and at which seqs", () => {
  const home = newHome({ records: 2 });
  const first = appendCheckpoint(home.logPath, home.privateKey, HUMAN);
  appendRecord(home, "between");
  const second = appendCheckpoint(home.logPath, home.privateKey, HUMAN);
  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) return;

  const signers = checkpointSignersIn(records(home.logPath));
  assert.deepEqual([...signers.keys()], [home.fingerprint]);
  assert.deepEqual(signers.get(home.fingerprint), [first.record.seq, second.record.seq]);

  // A key nobody used answers nothing rather than an empty promise.
  assert.equal(signers.get(mintCheckpointKeypair().fingerprint), undefined);
});

// ===========================================================================
// The cadence: one rule, read by everything
// ===========================================================================

test("no cadence in the policy is never due, however old the log is", () => {
  const home = newHome({ records: 2 });
  const configured = checkpointPolicyOf({ file: home.policyPath });
  assert.equal(configured.checkpointEveryMs, null);
  assert.equal(
    checkpointDue({
      records: records(home.logPath),
      publicKeys: configured.publicKeys,
      checkpointEveryMs: configured.checkpointEveryMs,
      now: Date.now() + 365 * 24 * 3_600_000,
    }),
    null,
  );
  assert.equal(checkpointOfferFor(tapFor(home)), null);
});

test("a lapsed cadence is due, and the offer names the log's current head", () => {
  const home = newHome({ records: 3, every: "1h" });
  const offer = checkpointOfferFor(tapFor(home), Date.now() + 4 * 3_600_000);
  assert.ok(offer !== null);
  assert.deepEqual(offer.head, head(home.logPath));
  assert.equal(offer.since, null, "this log has never been checkpointed");
  assert.equal(offer.everyMs, 3_600_000);
  assert.match(offer.warning, /never been checkpointed/u);
  assert.match(offer.warning, /nothing is refused/u);

  // The prompt is the same text every surface prints, and it shows what is
  // being signed before it asks for anything.
  const lines = checkpointPromptLines(offer);
  assert.match(lines[0] ?? "", /CHECKPOINT DUE/u);
  assert.ok(lines.some((line) => line.includes(offer.head.hash)));
  assert.ok(lines.some((line) => /Not signing is not a refusal/u.test(line)));
});

test("signing clears the cadence, and the next lapse names the checkpoint it followed", () => {
  const home = newHome({ records: 3, every: "1h" });
  const signed = appendCheckpoint(home.logPath, home.privateKey, HUMAN);
  assert.equal(signed.ok, true);
  if (!signed.ok) return;

  assert.equal(checkpointOfferFor(tapFor(home), Date.now() + 60_000), null, "inside the cadence");

  const later = checkpointOfferFor(tapFor(home), Date.now() + 4 * 3_600_000);
  assert.ok(later !== null);
  assert.equal(later.since, signed.record.seq);
  assert.match(later.warning, /the newest checkpoint \(seq/u);
});

test("no configured key is never due: there is nothing to sign with and nobody to ask", () => {
  const home = newHome({ records: 3, every: "1h", keys: "none" });
  assert.equal(checkpointOfferFor(tapFor(home), Date.now() + 4 * 3_600_000), null);
  // And the check itself says SKIP rather than pass, which is what the doctor
  // row and the daemon report.
  assert.equal(check(home).status, "skip");
});

test("a refused range is never offered a new signature on top of itself", () => {
  const home = newHome({ records: 3, every: "1h" });
  const stranger = mintCheckpointKeypair();
  const signed = appendCheckpointAt(
    home.logPath,
    stranger.privateKey,
    HUMAN,
    head(home.logPath),
  );
  assert.equal(signed.ok, true);

  const verdict = check(home);
  assert.equal(verdict.status, "refused");
  if (verdict.status === "refused") assert.equal(verdict.code, "checkpoint-key-unknown");

  // The thing to do with a checkpoint that does not verify is LOOK at it.
  assert.equal(checkpointOfferFor(tapFor(home), Date.now() + 4 * 3_600_000), null);
});

// ===========================================================================
// Custody: one decision, two sources
// ===========================================================================

test("the vault is a custody source, and its passphrase comes only from the environment", () => {
  const home = newHome({ records: 2, vault: true });

  const missing = resolveCheckpointKey(null, home.logPath, null, { file: home.policyPath }, home.dir, {});
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.code, "checkpoint-key-unreadable");
    assert.match(missing.message, new RegExp(`${home.passphraseEnv} is unset or empty`, "u"));
    assert.match(missing.message, /there is no --passphrase flag/u);
  }

  const found = resolveCheckpointKey(null, home.logPath, null, { file: home.policyPath }, home.dir, {
    [home.passphraseEnv]: home.passphrase,
  });
  assert.equal(found.ok, true, found.ok ? "" : found.message);
  if (found.ok) assert.equal(found.privateKey, home.privateKey);
});

test("a missing credential says how to mint one, and never what the vault holds", () => {
  const home = newHome({ records: 2 });
  const resolved = resolveCheckpointKey(null, home.logPath, null, { file: home.policyPath }, home.dir, {
    [home.passphraseEnv]: home.passphrase,
  });
  assert.equal(resolved.ok, false);
  if (resolved.ok) return;
  assert.match(resolved.message, /approval setup checkpoint/u);
  assert.equal(resolved.message.includes(home.privateKey), false);
});

// ===========================================================================
// approval setup checkpoint — the ceremony
// ===========================================================================

interface FakeKeystore extends KeystoreRunner {
  readonly items: Map<string, string>;
}

/** A keystore that is a `Map`. Nothing in this file may reach a real one. */
function fakeKeystore(kind: KeystoreKind = "keychain"): FakeKeystore {
  const items = new Map<string, string>();
  return {
    items,
    kind: () => kind,
    storeGenerated(service, value): StoreOutcome {
      items.set(service, value);
      return { ok: true, viaArgv: false };
    },
    storePrompted(service): StoreOutcome {
      items.set(service, TOKEN);
      return { ok: true, viaArgv: false };
    },
    read(service) {
      const value = items.get(service);
      return value === undefined
        ? { ok: false, message: `fake: no item ${service}` }
        : { ok: true, value };
    },
  };
}

function scriptedPrompter(script: unknown[]): Prompter & { remaining: unknown[] } {
  const remaining = [...script];
  const next = (prompt: string): unknown => {
    if (remaining.length === 0) {
      throw new Error(`setup asked an unscripted question: ${JSON.stringify(prompt)}`);
    }
    return remaining.shift();
  };
  return {
    remaining,
    readLine: (prompt) => {
      const answer = next(prompt);
      return answer === null ? null : String(answer);
    },
    readSecret: (prompt): SecretRead => ({ ok: true, value: String(next(prompt)) }),
    confirm: (prompt) => next(prompt) === true,
  };
}

interface SetupRun {
  code: number;
  out: string;
  err: string;
}

function runSetup(
  home: Home,
  argv: string[],
  options: { script?: unknown[]; env?: NodeJS.ProcessEnv; prompter?: Prompter | null } = {},
): SetupRun {
  let out = "";
  let err = "";
  const code = commandSetupCheckpoint(
    ["--as", HUMAN, "--log", home.logPath, "--policy", home.policyPath, ...argv],
    {
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
    },
    home.dir,
    {
      prompter:
        options.prompter === undefined
          ? scriptedPrompter(options.script ?? [])
          : options.prompter,
      keystore: fakeKeystore(),
      env: options.env ?? { [home.passphraseEnv]: home.passphrase },
    },
  );
  return { code, out, err };
}

test("setup checkpoint refuses a non-terminal stdin and prints the ceremony to run", () => {
  const home = newHome({ records: 2, keys: "none" });
  const run = runSetup(home, [], { prompter: null });
  assert.equal(run.code, 2);
  assert.equal(run.out, "");
  assert.match(run.err, /stdin is not a terminal/u);
  assert.match(run.err, /approval setup checkpoint --as human:<id>/u);
  assert.match(run.err, /approval policy amend/u);
});

test("setup checkpoint mints, vaults the private half, and prints the block to paste", () => {
  const home = newHome({ records: 2, keys: "none" });
  const policyBefore = readFileSync(home.policyPath);
  const logBefore = readFileSync(home.logPath);

  const run = runSetup(home, []);
  assert.equal(run.code, 0, run.err);

  // The private half reached the vault and NOTHING else.
  const stored = getCredential(
    vaultPathFor(home.logPath),
    home.passphrase,
    CHECKPOINT_KEY_CREDENTIAL,
  );
  assert.equal(stored.ok, true, stored.ok ? "" : stored.message);
  if (!stored.ok) return;
  assert.equal(run.out.includes(stored.value), false, "the private half was printed");

  // The public half, its fingerprint, and the exact ceremony.
  const fingerprint = checkpointKeyFingerprint(
    (run.out.match(/^\s+- (\S+)$/mu) ?? [])[1] ?? "",
  );
  assert.equal(fingerprint !== null, true, "a readable public key was printed");
  assert.match(run.out, /audit:\n {4}checkpoint_keys:\n {6}- /u);
  assert.match(run.out, /approval policy amend/u);
  assert.match(run.out, /THE KEY IS INERT UNTIL THE POLICY LISTS IT/u);
  assert.match(run.out, /checkpoint_every: 24h/u);
  assert.match(run.out, /IF YOU LOSE THIS KEY/u);

  // It edited no policy and appended no record. Both are the family's rule.
  assert.deepEqual(readFileSync(home.policyPath), policyBefore);
  assert.deepEqual(readFileSync(home.logPath), logBefore);
});

test("setup checkpoint will not replace a listed key without --rotate", () => {
  const home = newHome({ records: 2, vault: true });
  const run = runSetup(home, []);
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, /already lists 1 checkpoint key/u);
  assert.match(run.out, /Re-run with --rotate/u);

  // Nothing was minted: the vault still holds the key this home started with.
  const stored = getCredential(
    vaultPathFor(home.logPath),
    home.passphrase,
    CHECKPOINT_KEY_CREDENTIAL,
  );
  assert.equal(stored.ok && stored.value === home.privateKey, true);
});

test("--rotate appends: the printed block carries the old key and the new one", () => {
  const home = newHome({ records: 2, vault: true });
  const run = runSetup(home, ["--rotate"], { script: [true] });
  assert.equal(run.code, 0, run.err);

  const listed = [...run.out.matchAll(/^\s+- (\S+)$/gmu)].map((match) => match[1] ?? "");
  assert.equal(listed.length, 2, run.out);
  assert.equal(listed[0], home.publicKey, "the key already listed stays first");
  assert.notEqual(listed[1], home.publicKey);
  assert.match(run.out, /no key is removed/u);

  // The private half in the vault is the NEW one.
  const stored = getCredential(
    vaultPathFor(home.logPath),
    home.passphrase,
    CHECKPOINT_KEY_CREDENTIAL,
  );
  assert.equal(stored.ok, true);
  if (stored.ok) assert.notEqual(stored.value, home.privateKey);
});

test("--rotate declined mints nothing", () => {
  const home = newHome({ records: 2, vault: true });
  const run = runSetup(home, ["--rotate"], { script: [false] });
  assert.equal(run.code, 0);
  assert.match(run.out, /aborted: nothing was minted/u);
  const stored = getCredential(
    vaultPathFor(home.logPath),
    home.passphrase,
    CHECKPOINT_KEY_CREDENTIAL,
  );
  assert.equal(stored.ok && stored.value === home.privateKey, true);
});

test("--retire refuses a key that signed a checkpoint, naming the seqs", () => {
  const home = newHome({ records: 2 });
  const signed = appendCheckpoint(home.logPath, home.privateKey, HUMAN);
  assert.equal(signed.ok, true);
  if (!signed.ok) return;

  const run = runSetup(home, ["--retire", home.fingerprint]);
  assert.equal(run.code, 1, run.out);
  assert.match(run.err, /checkpoint-key-in-use/u);
  assert.match(run.err, new RegExp(`at seq ${String(signed.record.seq)}`, "u"));
  assert.match(run.err, /would turn every one of them into checkpoint-key-unknown/u);
  assert.match(run.err, /Retired keys stay listed forever/u);
  assert.equal(run.out, "", "nothing to paste was printed");
});

test("--retire of a key that signed nothing prints the block that drops it", () => {
  const home = newHome({ records: 2 });
  const run = runSetup(home, ["--retire", home.fingerprint]);
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, /has signed no checkpoint/u);
  assert.match(run.out, /approval policy amend/u);
  assert.equal(run.out.includes(home.publicKey), false, "the dropped key is not in the block");
});

test("--retire of a fingerprint nobody carries is a usage error", () => {
  const home = newHome({ records: 2 });
  const run = runSetup(home, ["--retire", "deadbeef"]);
  assert.equal(run.code, 2);
  assert.match(run.err, /no configured checkpoint key hashes to/u);
});

test("setup checkpoint mints nothing without the vault passphrase", () => {
  const home = newHome({ records: 2, keys: "none" });
  const run = runSetup(home, [], { env: {} });
  assert.equal(run.code, 2);
  assert.match(run.err, new RegExp(`${home.passphraseEnv} is unset or empty`, "u"));
  assert.match(run.err, /No key was generated/u);
  const stored = getCredential(
    vaultPathFor(home.logPath),
    home.passphrase,
    CHECKPOINT_KEY_CREDENTIAL,
  );
  assert.equal(stored.ok, false, "no vault was created");
});

// ===========================================================================
// The Telegram tap, through the mock bot and the real append path
// ===========================================================================

/** The `callback_data` on the Sign / Not now buttons of the last prompt sent. */
function checkpointButtons(
  requests: readonly { method: string; body: Record<string, unknown> }[],
): { sign: string; decline: string; text: string } {
  for (let index = requests.length - 1; index >= 0; index -= 1) {
    const request = requests[index];
    if (request === undefined || request.method !== "sendMessage") continue;
    const markup = request.body["reply_markup"] as
      | { inline_keyboard?: { text: string; callback_data: string }[][] }
      | undefined;
    const row = markup?.inline_keyboard?.[0];
    if (row === undefined || row.length !== 2) continue;
    const sign = row.find((button) => button.text === "Sign");
    const decline = row.find((button) => button.text === "Not now");
    if (sign === undefined || decline === undefined) continue;
    return {
      sign: sign.callback_data,
      decline: decline.callback_data,
      text: String(request.body["text"] ?? ""),
    };
  }
  throw new Error("no checkpoint prompt was sent");
}

async function tapWorld(
  options: { every?: string } = {},
): Promise<{
  home: Home;
  setup: ListenSetup;
  mock: Awaited<ReturnType<typeof startMockBotApi>>;
  close: () => Promise<void>;
}> {
  const home = newHome({ records: 3, every: options.every ?? "1h" });
  const mock = await startMockBotApi(TOKEN);
  const channel = new TelegramChannel({
    token: TOKEN,
    chatId: CHAT,
    apiBase: assertLocal(mock.url),
    pollTimeoutSeconds: 0,
    requestTimeoutMs: 5_000,
    log: () => undefined,
  });
  const setup: ListenSetup = {
    channel,
    logPath: home.logPath,
    actor: HUMAN,
    json: false,
    once: true,
    delivery: "paced",
    gateOptions: { policy: { file: home.policyPath } },
    tagOptions: { policy: { file: home.policyPath } },
    // The tap reads its key from the file this home wrote. Custody is the same
    // function the vault path uses; what changes is which source it takes.
    checkpoint: { ...tapFor(home) },
  };
  channel.onCheckpoint(checkpointHandlerFor(setup, { out: () => undefined, err: () => undefined }));
  return { home, setup, mock, close: () => mock.close() };
}

/** A dispatch cycle at a chosen instant, with the cadence long lapsed. */
async function cycle(
  setup: ListenSetup,
  state: ReturnType<typeof newDispatchState>,
): Promise<ReturnType<typeof dispatchPending> extends Promise<infer T> ? T : never> {
  return dispatchPending(
    setup,
    { out: () => undefined, err: () => undefined },
    state,
    new Date().toISOString(),
  );
}

test("a due checkpoint reaches the phone once, and only once", async (t) => {
  const world = await tapWorld();
  t.after(world.close);

  // The cadence is 1h and the fixture's records are seconds old, so nothing is
  // owed yet and nothing is offered.
  const state = newDispatchState();
  const quiet = await cycle(world.setup, state);
  assert.equal(quiet.checkpoint, undefined);

  // Age the log by rewriting the policy to a cadence the fixture has outrun.
  writeFileSync(
    world.home.policyPath,
    policyText({
      keys: [world.home.publicKey],
      every: "1ms",
      passphraseEnv: world.home.passphraseEnv,
    }),
    "utf8",
  );

  const offered = await cycle(world.setup, state);
  assert.ok(offered.checkpoint !== undefined);
  assert.equal(offered.checkpoint.seq, head(world.home.logPath).seq);

  const buttons = checkpointButtons(world.mock.requests);
  assert.match(buttons.text, /CHECKPOINT DUE/u);
  assert.ok(buttons.text.includes(offered.checkpoint.hash));

  // NEVER A NAG. The cadence is still lapsed and the next cycle asks nothing.
  const again = await cycle(world.setup, state);
  assert.equal(again.checkpoint, undefined);
  const third = await cycle(world.setup, state);
  assert.equal(third.checkpoint, undefined);
});

test("tapping Sign appends a checkpoint over the head that was shown", async (t) => {
  const world = await tapWorld({ every: "1ms" });
  t.after(world.close);

  const state = newDispatchState();
  const offered = await cycle(world.setup, state);
  assert.ok(offered.checkpoint !== undefined);
  const shown = { seq: offered.checkpoint.seq, hash: offered.checkpoint.hash };

  // The head moves between the prompt and the tap, which is the case the whole
  // design exists for.
  appendRecord(world.home, "while-the-phone-was-in-a-pocket");
  assert.notEqual(head(world.home.logPath).seq, shown.seq);

  const buttons = checkpointButtons(world.mock.requests);
  world.mock.queueUpdate(callbackUpdate({ data: buttons.sign, chatId: CHAT }));
  await world.setup.channel.pollOnce();

  const all = records(world.home.logPath);
  const checkpoints = all.filter((record) => record.event === "log.checkpoint");
  assert.equal(checkpoints.length, 1);
  const payload = checkpoints[0]?.payload as { seq: number; hash: string } | undefined;
  assert.deepEqual(payload === undefined ? null : { seq: payload.seq, hash: payload.hash }, shown);
  assert.equal(checkpoints[0]?.actor, HUMAN);
  assert.equal(checkpoints[0]?.channel, "telegram");

  // And it verifies: this is the record `log verify --checkpoints` accepts.
  const verdict = check(world.home);
  assert.equal(verdict.status, "pass", JSON.stringify(verdict));

  // The message says what the log recorded, and its buttons are gone.
  const edits = world.mock.edits();
  const last = edits[edits.length - 1];
  assert.ok(last !== undefined);
  assert.match(last.text, /CHECKPOINTED/u);
  assert.ok(last.text.includes(shown.hash));
  assert.equal(last.replyMarkup, undefined);
  assert.match(world.mock.answerTexts().join("\n"), /signing/u);
});

test("tapping Not now appends nothing and refuses nothing", async (t) => {
  const world = await tapWorld({ every: "1ms" });
  t.after(world.close);

  const state = newDispatchState();
  const offered = await cycle(world.setup, state);
  assert.ok(offered.checkpoint !== undefined);
  const before = readFileSync(world.home.logPath);

  const buttons = checkpointButtons(world.mock.requests);
  world.mock.queueUpdate(callbackUpdate({ data: buttons.decline, chatId: CHAT }));
  await world.setup.channel.pollOnce();

  assert.deepEqual(readFileSync(world.home.logPath), before);
  const edits = world.mock.edits();
  const last = edits[edits.length - 1];
  assert.ok(last !== undefined);
  assert.match(last.text, /NOT SIGNED/u);
  assert.match(last.text, /never a refusal/u);
});

test("a checkpoint nonce from an earlier run is answered, never guessed at", async (t) => {
  const world = await tapWorld({ every: "1ms" });
  t.after(world.close);

  const state = newDispatchState();
  await cycle(world.setup, state);
  const before = readFileSync(world.home.logPath);

  world.mock.queueUpdate(callbackUpdate({ data: "k:not-a-nonce-this-process-issued", chatId: CHAT }));
  const polled = await world.setup.channel.pollOnce();

  assert.deepEqual(readFileSync(world.home.logPath), before);
  assert.deepEqual(
    polled.ignored.map((entry) => entry.kind),
    ["unknown-callback"],
  );
  assert.match(world.mock.answerTexts().join("\n"), /from an earlier run/u);
});

test("a tapped nonce is spent: the second tap signs nothing", async (t) => {
  const world = await tapWorld({ every: "1ms" });
  t.after(world.close);

  const state = newDispatchState();
  await cycle(world.setup, state);
  const buttons = checkpointButtons(world.mock.requests);

  world.mock.queueUpdate(callbackUpdate({ data: buttons.sign, chatId: CHAT }));
  await world.setup.channel.pollOnce();
  world.mock.queueUpdate(callbackUpdate({ data: buttons.sign, chatId: CHAT }));
  await world.setup.channel.pollOnce();

  const checkpoints = records(world.home.logPath).filter(
    (record) => record.event === "log.checkpoint",
  );
  assert.equal(checkpoints.length, 1, "a double tap made one record");
});

test("the checkpoint vocabulary and the decision vocabulary cannot be read as each other", () => {
  // The separation the callback parsers exist for: a signature gesture must
  // never fall into the decision ladder, where an unresolved nonce becomes an
  // action-reference lookup and starts hunting for a request to approve.
  assert.equal(parseCallbackData("k:nonce"), null);
  assert.equal(parseCallbackData("x:nonce"), null);
  assert.equal(parseCheckpointCallback("g:nonce:abcd"), null);
  assert.equal(parseCheckpointCallback("G:nonce"), null);
  assert.equal(parseCheckpointCallback("k:"), null);
  assert.deepEqual(parseCheckpointCallback("k:abc"), { sign: true, nonce: "abc" });
  assert.deepEqual(parseCheckpointCallback("x:abc"), { sign: false, nonce: "abc" });
});

// ===========================================================================
// The CLI channel gets the same prompt
// ===========================================================================

/** The CLI channel over scripted stdin, collecting the checkpoint gesture. */
async function collect(answers: string[]): Promise<{ answer: boolean | null; out: string }> {
  const { Readable } = await import("node:stream");
  let out = "";
  const channel = new CliChannel({
    output: { write: (text) => (out += text) },
    input: Readable.from(answers.map((line) => `${line}\n`)) as NodeJS.ReadableStream,
  });
  try {
    return { answer: await channel.collectCheckpoint(["CHECKPOINT DUE — sign?"]), out };
  } finally {
    channel.close();
  }
}

test("the cli channel asks the same question and takes s / n / nothing", async () => {
  const signed = await collect(["s"]);
  assert.equal(signed.answer, true);
  assert.match(signed.out, /CHECKPOINT DUE/u);
  assert.match(signed.out, /s\) sign {3}n\) not now/u);

  const declined = await collect(["n"]);
  assert.equal(declined.answer, false);
  assert.match(declined.out, /nothing was appended and nothing is refused/u);

  // Enter is "not now", never a signature by default.
  assert.equal((await collect([""])).answer, false);

  const confused = await collect(["yes", "s"]);
  assert.equal(confused.answer, true);
  assert.match(confused.out, /expected s or n/u);

  const ended = await collect([]);
  assert.equal(ended.answer, null, "end of input is not a decline and not a signature");
});

test("the cli channel's answer is only a gesture: signing is the runtime's", () => {
  const home = newHome({ records: 3, every: "1h" });
  const offer = checkpointOfferFor(tapFor(home), Date.now() + 4 * 3_600_000);
  assert.ok(offer !== null);

  const result = signCheckpointOffer(tapFor(home), offer.head, HUMAN, "cli", home.dir);
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok) return;
  assert.equal(result.signed.seq, offer.head.seq);
  assert.equal(result.fingerprint, home.fingerprint);
  assert.equal(check(home).status, "pass");

  const signedRecord = records(home.logPath).find((record) => record.seq === result.seq);
  assert.equal(signedRecord?.channel, "cli");
});

// ===========================================================================
// No route to the key from anything an agent launched
// ===========================================================================

test("both checkpoint verbs classify to a human-only class, and mint no new one", () => {
  for (const command of [
    "approval log checkpoint --as human:carter",
    "approval setup checkpoint",
    "approval setup checkpoint --rotate",
    "node ./cli.js log checkpoint --as human:carter",
  ]) {
    const classified = classifyCommand(command);
    assert.equal(classified.ok, true, command);
    if (!classified.ok) continue;
    assert.deepEqual(classified.classes, ["policy.core"], command);
  }

  // `policy.core` is an EXISTING class — the one `gate open` and `gate close`
  // already use — so nothing here mints authority (SPEC.md §11.1 invariant 9).
  const gate = classifyCommand("approval gate open");
  assert.equal(gate.ok && gate.classes[0], "policy.core");

  // And the other setup subcommands are untouched: their control is the
  // terminal, not a class.
  const vault = classifyCommand("approval setup vault");
  assert.equal(vault.ok, true);
  if (vault.ok) assert.equal(vault.classes.includes("policy.core"), false);
});

test("the vault passphrase never reaches a child this runtime spawns", () => {
  const home = newHome({ records: 1 });
  const child = childEnvironment({
    source: { PATH: "/usr/bin", [home.passphraseEnv]: home.passphrase },
    passphraseEnv: home.passphraseEnv,
  });
  assert.equal(child.env[home.passphraseEnv], undefined);
  assert.equal(child.env["PATH"], "/usr/bin");
  assert.equal(child.stripped, 1);

  // Which is the whole of it: a child with no passphrase cannot open the vault,
  // so it cannot reach the key even by running the code that reads one.
  const resolved = resolveCheckpointKey(
    null,
    home.logPath,
    null,
    { file: home.policyPath },
    home.dir,
    child.env,
  );
  assert.equal(resolved.ok, false);
});

test("the hook's module graph never reaches the file that resolves a key", () => {
  // The third lock, and the one a comment cannot keep. `approval hook
  // claude-code` is the path an agent's own commands travel; if it could import
  // the custody module, a future change could give it a way to call one.
  const specifier = /(?:^|\n)\s*(?:import|export)\b[^;]*?from\s*["']([^"']+)["']/gu;
  const seen = new Set<string>();
  const stack = [join(REPO_ROOT, "src", "cli", "hook.ts")];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const match of source.matchAll(specifier)) {
      const target = match[1];
      if (target === undefined || !target.startsWith(".")) continue;
      stack.push(join(file, "..", target.replace(/\.js$/u, ".ts")));
    }
  }

  const forbidden = [
    join(REPO_ROOT, "src", "cli", "checkpoint-tap.ts"),
    join(REPO_ROOT, "src", "cli", "log-checkpoint.ts"),
    join(REPO_ROOT, "src", "cli", "setup-checkpoint.ts"),
  ];
  for (const file of forbidden) {
    assert.equal(
      seen.has(file),
      false,
      `src/cli/hook.ts reaches ${file.slice(REPO_ROOT.length)} — the hook path must have no route to a checkpoint key`,
    );
  }
  // The walk really walked: a graph of one file would pass this vacuously.
  assert.ok(seen.size > 5, `the import walk found only ${String(seen.size)} files`);
});

test("getCredential has exactly the two callers core/vault.ts's header names", () => {
  // The other half of the same property, from the other direction. APRV-220
  // flagged that the checkpoint verb was becoming a second caller of the one
  // function that hands back a credential value, and APRV-257 decided to keep
  // it there and name it. This is the assertion behind that comment: the list
  // is two files, and a third would fail here rather than in review.
  const callers: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      // The definition site is not a caller of itself.
      if (path === join(REPO_ROOT, "src", "core", "vault.ts")) continue;
      const source = readFileSync(path, "utf8");
      if (/(?<![A-Za-z.])getCredential\s*\(/u.test(source)) {
        callers.push(path.slice(REPO_ROOT.length));
      }
    }
  };
  walk(join(REPO_ROOT, "src"));
  assert.deepEqual(callers.sort(), [
    join("src", "adapters", "vault-provider.ts"),
    join("src", "cli", "checkpoint-tap.ts"),
  ]);
  // And the name that second caller reads is the reserved one, not a string it
  // composed: a verb that could name any credential would be a verb that could
  // read any of them.
  const custody = readFileSync(join(REPO_ROOT, "src", "cli", "checkpoint-tap.ts"), "utf8");
  assert.match(custody, /getCredential\(vaultPath, passphrase, CHECKPOINT_KEY_CREDENTIAL\)/u);
  assert.equal(CHECKPOINT_KEY_CREDENTIAL, "approval.checkpoint.key");
});
