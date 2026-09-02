/**
 * The starved child environment (APRV-205).
 *
 * `core/child-env.ts` is pure over a supplied environment map, so these cases
 * hand it one and read the answer. Nothing here reads the real environment, and
 * nothing here touches a vault, a key or `.approval/env`: every credential-shaped
 * value in this file is a fixture invented for the assertion beside it.
 *
 * The end-to-end proof — a real value exported into a real child of `approval
 * run`, absent from the child's own printed environment and absent from the log
 * — lives in `tests/cli-run.test.ts`, because the thing under test there is the
 * spawn.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { requiredAgentmailCredentials } from "../src/adapters/agentmail.js";
import type { Adapter } from "../src/adapters/contract.js";
import { emailAdapter } from "../src/adapters/email.js";
import {
  builtInAdapters,
  declaredCredentialsForClass,
  unionRequiredCredentials,
} from "../src/adapters/registry.js";
import { childEnvironment } from "../src/core/child-env.js";

/** A fixture value, never a real one. */
const FIXTURE = "fixture-value-not-a-credential";

const SESSION: NodeJS.ProcessEnv = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/fixture",
  LANG: "en_US.UTF-8",
  TMPDIR: "/tmp/fixture",
  APPROVAL_TG_TOKEN: FIXTURE,
  APPROVAL_TG_CHAT: FIXTURE,
  APPROVAL_VAULT_PASSPHRASE: FIXTURE,
  TELEGRAM_BOT_TOKEN: FIXTURE,
  VAULT_TOKEN: FIXTURE,
  AGENTMAIL_API_KEY: FIXTURE,
  APPROVAL_HUMAN: "human:carter",
  APPROVAL_AGENT: "agent:claude",
  APPROVAL_ASCII: "1",
  APPROVAL_MD: "APPROVAL.md",
  APPROVAL_HOME: "/home/fixture/.approval",
  APPROVAL_DIR: "/repo",
};

test("every credential-bearing name is withheld from the child", () => {
  const built = childEnvironment({ source: SESSION });
  for (const name of [
    "APPROVAL_TG_TOKEN",
    "APPROVAL_TG_CHAT",
    "APPROVAL_VAULT_PASSPHRASE",
    "TELEGRAM_BOT_TOKEN",
    "VAULT_TOKEN",
    "AGENTMAIL_API_KEY",
  ]) {
    assert.equal(built.env[name], undefined, `${name} reached the child`);
  }
  assert.equal(
    Object.values(built.env).includes(FIXTURE),
    false,
    "a credential value reached the child under some other name",
  );
});

test("the working environment passes through unchanged", () => {
  const built = childEnvironment({ source: SESSION });
  assert.equal(built.env["PATH"], "/usr/bin:/bin");
  assert.equal(built.env["HOME"], "/home/fixture");
  assert.equal(built.env["LANG"], "en_US.UTF-8");
  assert.equal(built.env["TMPDIR"], "/tmp/fixture");
});

test("the APRV-194 allowlist survives the scrub", () => {
  const built = childEnvironment({ source: SESSION });
  assert.equal(built.env["APPROVAL_HUMAN"], "human:carter");
  assert.equal(built.env["APPROVAL_AGENT"], "agent:claude");
  assert.equal(built.env["APPROVAL_ASCII"], "1");
  assert.equal(built.env["APPROVAL_MD"], "APPROVAL.md");
  assert.equal(built.env["APPROVAL_HOME"], "/home/fixture/.approval");
  assert.equal(built.env["APPROVAL_DIR"], "/repo");
});

test("the count is of what was withheld, and names nothing", () => {
  const built = childEnvironment({ source: SESSION });
  // Six: five from APRV-205 plus the AgentMail key APRV-224 added to the
  // prefixes. `env_stripped` counts it like any other credential-bearing name.
  assert.equal(built.stripped, 6);
  assert.equal(built.passed, 0);
  assert.equal(childEnvironment({ source: { PATH: "/bin" } }).stripped, 0);
});

test("the variable the policy names is withheld even outside the prefixes", () => {
  const source: NodeJS.ProcessEnv = { PATH: "/bin", HOUSE_KEY: FIXTURE };
  const built = childEnvironment({ source, passphraseEnv: "HOUSE_KEY" });
  assert.equal(built.env["HOUSE_KEY"], undefined);
  assert.equal(built.env["PATH"], "/bin");
  assert.equal(built.stripped, 1);
});

test("a passphrase variable that is absent costs no count", () => {
  const built = childEnvironment({ source: { PATH: "/bin" }, passphraseEnv: "HOUSE_KEY" });
  assert.equal(built.stripped, 0);
  assert.deepEqual(built.env, { PATH: "/bin" });
});

test("an adapter-declared credential is passed, and nothing else under the prefixes", () => {
  const built = childEnvironment({
    source: SESSION,
    declaredCredentials: ["APPROVAL_TG_TOKEN"],
  });
  assert.equal(built.env["APPROVAL_TG_TOKEN"], FIXTURE, "the declared credential was withheld");
  assert.equal(built.passed, 1);
  assert.equal(built.stripped, 5);
  for (const name of [
    "APPROVAL_TG_CHAT",
    "APPROVAL_VAULT_PASSPHRASE",
    "TELEGRAM_BOT_TOKEN",
    "VAULT_TOKEN",
    "AGENTMAIL_API_KEY",
  ]) {
    assert.equal(built.env[name], undefined, `${name} rode in on the declaration`);
  }
});

test("a declaration beats the policy's passphrase name too", () => {
  const built = childEnvironment({
    source: { PATH: "/bin", HOUSE_KEY: FIXTURE },
    passphraseEnv: "HOUSE_KEY",
    declaredCredentials: ["HOUSE_KEY"],
  });
  assert.equal(built.env["HOUSE_KEY"], FIXTURE);
  assert.equal(built.stripped, 0);
  assert.equal(built.passed, 1);
});

test("a declared name that is unset is not invented", () => {
  const built = childEnvironment({
    source: { PATH: "/bin" },
    declaredCredentials: ["APPROVAL_TG_TOKEN"],
  });
  assert.equal("APPROVAL_TG_TOKEN" in built.env, false);
  assert.equal(built.passed, 0);
});

test("the child's environment is a copy: mutating it does not touch the source", () => {
  const source: NodeJS.ProcessEnv = { PATH: "/bin" };
  const built = childEnvironment({ source });
  built.env["PATH"] = "/elsewhere";
  assert.equal(source["PATH"], "/bin");
});

test("the pass-through set comes from the adapter's own declaration (APRV-169)", () => {
  const declared = declaredCredentialsForClass("communicate.email.external");
  // A superset rather than an equality: a second adapter serving this class
  // (AgentMail, APRV-223) adds its own names to the union, and the property
  // under test is that the email adapter's declaration is honoured whole.
  for (const name of emailAdapter().requiredCredentials ?? []) {
    assert.ok(declared.includes(name), `the email adapter's ${name} is not in the class's union`);
  }
  assert.ok(declared.length > 0, "the email adapter declares no required credential");
  assert.deepEqual(declaredCredentialsForClass("files.write.local"), []);
  assert.deepEqual(declaredCredentialsForClass("no.such.class"), []);
});

/**
 * The AgentMail declaration, and why it lets nothing through the scrub
 * (APRV-224).
 *
 * `AGENTMAIL_` is a credential-bearing prefix now, so the obvious worry is that
 * the adapter's own declaration reopens the hole the prefix closes: a name a
 * declaration passes is a name the child gets. It does not, and the reason is
 * structural rather than lucky. Every name this adapter declares is a VAULT
 * name (`agentmail.api_key`, `agentmail.inbox_id`), read inside the verified
 * token window through the credential provider, and no vault name can match an
 * environment variable under the prefix. So the declaration is honoured in
 * full, and an `AGENTMAIL_`-prefixed variable in the session is still withheld
 * and still counted.
 */
test("the agentmail adapter declares vault names, so nothing AGENTMAIL_ passes", () => {
  const declaredCredentials = requiredAgentmailCredentials();
  assert.deepEqual([...declaredCredentials], ["agentmail.inbox_id", "agentmail.api_key"]);
  for (const name of declaredCredentials) {
    assert.equal(
      name.startsWith("AGENTMAIL_"),
      false,
      `${name} is an environment-shaped declaration; a vault name cannot open the scrub`,
    );
  }

  const built = childEnvironment({ source: SESSION, declaredCredentials });
  assert.equal(built.env["AGENTMAIL_API_KEY"], undefined, "the AgentMail key reached the child");
  assert.equal(built.passed, 0, "a vault name matched an environment variable");
  assert.equal(built.stripped, 6);
  assert.equal(
    Object.values(built.env).includes(FIXTURE),
    false,
    "a credential value reached the child under some other name",
  );
});

/**
 * Two adapters, one class (APRV-221).
 *
 * The union is the rule the scrub depends on: when more than one adapter serves
 * a class, "which one would have run this" has no answer at the point `approval
 * run` builds the child's environment, so both declarations pass through and
 * neither adapter is guessed at. The build ships one adapter today, so the
 * second here is a fixture object rather than a real adapter — the pure
 * `unionRequiredCredentials` takes the roster so this case can exist at all,
 * while `declaredCredentialsForClass` keeps reading the built-in roster and
 * nothing else (a caller-supplied keep-list is the hole APRV-205 closed).
 */
test("declaredCredentialsForClass unions two adapters serving one class", () => {
  const CLASS = "communicate.email.external";
  const first: Adapter = {
    name: "fixture-one",
    classes: [CLASS],
    requiredCredentials: ["fixture.host", "fixture.shared"],
    act: () => ({ ok: true }),
  };
  const second: Adapter = {
    name: "fixture-two",
    classes: [CLASS, "fixture.other.class"],
    // `fixture.shared` is declared by both: the union deduplicates it, and the
    // order is the roster's, so a second adapter never reorders the first's.
    requiredCredentials: ["fixture.shared", "fixture.api-key"],
    act: () => ({ ok: true }),
  };
  const third: Adapter = {
    name: "fixture-three",
    classes: ["fixture.other.class"],
    requiredCredentials: ["fixture.unrelated"],
    act: () => ({ ok: true }),
  };

  assert.deepEqual(
    [...unionRequiredCredentials([first, second, third], CLASS)],
    ["fixture.host", "fixture.shared", "fixture.api-key"],
  );
  // An adapter that serves the class but declares nothing contributes nothing,
  // and a class nobody serves is still the empty list.
  assert.deepEqual(
    [...unionRequiredCredentials([{ name: "bare", classes: [CLASS], act: () => ({ ok: true }) }], CLASS)],
    [],
  );
  assert.deepEqual([...unionRequiredCredentials([first, second], "no.such.class")], []);

  // And the fixtures reached nothing: the shipped lookup still answers from the
  // built-in roster alone.
  assert.deepEqual(
    [...declaredCredentialsForClass(CLASS)],
    [...unionRequiredCredentials(builtInAdapters(), CLASS)],
  );
  assert.deepEqual(declaredCredentialsForClass("fixture.other.class"), []);
});
