#!/usr/bin/env node
/**
 * examples/demo-provision.mjs — provision a demo gate instance from the steps
 * the runbooks already publish, idempotently, in a durable directory.
 *
 * ===========================================================================
 * WHAT THIS IS, AND WHAT IT REFUSES TO BE
 * ===========================================================================
 *
 * Three stage demos share one provisioning ceremony:
 *
 *   --instance web-agent   ~/demo-gate      examples/web-agent-demo/runbook.md
 *   --instance guest       ~/demo-guest     the same runbook's crowd track (§4)
 *   --instance grok-bot    ~/demo-grok-bot  examples/grok-bot-connector/runbook.md
 *
 * One default directory each, never a shared one: a marker can refuse a second
 * demo in a directory, but only after the operator has already typed it.
 *
 * Until this script existed, each of them was a command sequence a human
 * pasted out of a document, which made every rehearsal a fresh chance to skip
 * a step and made "reset between runs" mean "read the doc again". What is
 * here is the same sequence, detected before it is run, so that running it
 * twice is safe and running it after a human step picks up where the human
 * left off.
 *
 * **It runs no human-only step, ever.** `approval policy attest`, the three
 * interactive credential verbs (`setup identity`, `setup vault`, `setup
 * channel telegram`), the mail adapter verb, the `git clone` of the Grok
 * demo's throwaway repository and the `cloudflared` tunnel are all printed as
 * the exact line to run and then left alone. The script exits 0 with them
 * listed; the next invocation sees them done and carries on.
 *
 * **It writes nothing outside the instance directory.** Not a lockfile, not a
 * scratch copy, not a log line. The only thing it reads from this repository
 * is `dist/src/cli/main.js` (which it shells out to, exactly as
 * `examples/web-agent-demo/server.mjs` does) and `examples/policies/`.
 *
 * **It hand-writes no log line and edits nothing inside `.approval/`.** The
 * log, `QUEUE.md`, the payload store and the vault are written by the real
 * verbs or not at all. `--reset` does not truncate or edit a log either: it
 * MOVES the previous instance state into `<instance>/retired/<stamp>/`, whole,
 * which is the runbooks' own "retire the instance rather than reaching into
 * it" with the directory kept.
 *
 * **The guest instance never gets a vault.** `examples/web-agent-demo/runbook.md`
 * §4 states it as a MUST: the crowd track runs against a throwaway instance
 * with an empty vault and no mail adapter, because that is what makes a bug in
 * guest mode's verb filter cost nothing. Here it is a refusal rather than a
 * warning: `--instance guest` with any vault or adapter step exits 2, and
 * `--check` FAILS if `.approval/vault.enc` ever appears there.
 *
 * ---------------------------------------------------------------------------
 * Usage:
 *   node examples/demo-provision.mjs --instance <id> [--path <dir>]
 *   node examples/demo-provision.mjs --instance <id> --check
 *   node examples/demo-provision.mjs --instance <id> --reset [--vault]
 *
 *   --instance <id>  web-agent | guest | grok-bot (required)
 *   --path <dir>     the instance directory, overriding the default above
 *   --check          run the instance's doctor and the demo's own preflight,
 *                    print one pass/fail line each, and write nothing
 *   --reset          retire the instance's log, queue, payload store and
 *                    seeded tasks into <instance>/retired/<stamp>/, then
 *                    provision again. The vault and .approval/env are left
 *                    alone, which is how a reset keeps the credentials
 *   --vault          with --reset only: retire .approval/vault.enc too
 *   --json           machine-readable output
 *   -h, --help       this text
 *
 * Exit codes follow the CLI's: 0 ok (including "waiting on a human"), 1 a
 * failed step or a failed check, 2 usage or a refusal, 4 I/O.
 *
 * Requires the repository to be built (`npm run build`).
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { agentEnv } from "./web-agent-demo/agent-env.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
/** examples/ -> <repo>/dist/src/cli/main.js, the one thing shelled out to. */
const CLI_ENTRY = fileURLToPath(new URL("../dist/src/cli/main.js", import.meta.url));
/** The demo policy, as a file, so that a policy change is a diff. */
const POLICY_FILE = join(HERE, "policies", "demo-gate.APPROVAL.md");

/** The identity every demo instance's human steps are run as. */
const DEMO_HUMAN = "human:demo";
/** A verb that hangs is a bug, not a wait. */
const VERB_TIMEOUT_MS = 60_000;
/** The marker naming which demo a directory was provisioned for. */
const MARKER_FILE = "demo-instance.json";
/** Where `--reset` moves the previous state. Inside the instance, always. */
const RETIRED_DIR = "retired";

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_IO = 4;

// ---------------------------------------------------------------------------
// The three instances. They differ only in data; the ceremony is one.
// ---------------------------------------------------------------------------

/**
 * `seeds` are the envelopes an operator would otherwise write by hand. A guest
 * can register only what is already on disk, and a manual action registered
 * without a `payload_hash` is refused `payload-hash-required` at request time,
 * so an envelope missing one is an envelope the demo cannot use. The hashes
 * here come from the real `approval payload hash` read verb rather than from a
 * second implementation of RFC 8785.
 *
 * The idempotency keys are stable (`<seed>:<slug>`) rather than date-stamped:
 * one key may be requested once per log, and `--reset` is what gives the next
 * run a fresh log to request it against.
 */
const INSTANCES = {
  "web-agent": {
    id: "web-agent",
    defaultPath: join(homedir(), "demo-gate"),
    title: "the web-agent demo gate",
    runbook: "examples/web-agent-demo/runbook.md",
    vault: true,
    adapter: { verb: "setup adapter email", credentials: 5, name: "email" },
    channel: true,
    gitClone: false,
    ports: [4700],
    seeds: [],
  },
  guest: {
    id: "guest",
    defaultPath: join(homedir(), "demo-guest"),
    title: "the crowd track's throwaway guest gate",
    runbook: "examples/web-agent-demo/runbook.md (§4)",
    vault: false,
    adapter: null,
    channel: true,
    gitClone: false,
    ports: [4681],
    seeds: [
      {
        id: "crowd-01",
        title: "Crowd demo: say hello (1)",
        actions: [
          {
            slug: "echo",
            class: "exec.local",
            summary: "echo a line in the guest instance",
            reversible: true,
            estCostUsd: "0",
            payload: (dir) => ({ argv: ["echo", "hello from crowd task 1"], cwd: dir }),
          },
        ],
      },
      {
        id: "crowd-02",
        title: "Crowd demo: say hello (2)",
        actions: [
          {
            slug: "echo",
            class: "exec.local",
            summary: "echo a line in the guest instance",
            reversible: true,
            estCostUsd: "0",
            payload: (dir) => ({ argv: ["echo", "hello from crowd task 2"], cwd: dir }),
          },
        ],
      },
      {
        id: "crowd-03",
        title: "Crowd demo: say hello (3)",
        actions: [
          {
            slug: "echo",
            class: "exec.local",
            summary: "echo a line in the guest instance",
            reversible: true,
            estCostUsd: "0",
            payload: (dir) => ({ argv: ["echo", "hello from crowd task 3"], cwd: dir }),
          },
        ],
      },
    ],
  },
  "grok-bot": {
    id: "grok-bot",
    // Its own directory, and not `~/demo-gate` as its runbook first named.
    // Two demos sharing a default path is a footgun the marker can only report
    // after the fact: the operator who typed the wrong --instance has already
    // found out by being refused. Three defaults, three directories, and
    // --path for anyone who wants otherwise.
    defaultPath: join(homedir(), "demo-grok-bot"),
    title: "the Grok Bot connector demo gate",
    runbook: "examples/grok-bot-connector/runbook.md",
    vault: true,
    adapter: { verb: "setup adapter agentmail", credentials: 2, name: "agentmail" },
    channel: true,
    gitClone: true,
    ports: [4681, 4700],
    seeds: [
      {
        id: "grok-001",
        title: "Grok Bot demo: a push and a send, both decided on a phone",
        actions: [
          {
            slug: "push",
            class: "vcs.push.branch",
            summary: "push demo/gated to the throwaway repository",
            reversible: false,
            estCostUsd: "0",
            payload: (dir) => ({ argv: ["git", "push", "-u", "origin", "demo/gated"], cwd: dir }),
          },
          {
            slug: "mail",
            class: "communicate.email.external",
            summary: "send the finale message through the AgentMail adapter",
            reversible: false,
            estCostUsd: "0",
            payload: () => ({
              from: process.env["APPROVAL_DEMO_EMAIL_FROM"] ?? "demo@example.invalid",
              to: [process.env["APPROVAL_DEMO_EMAIL_TO"] ?? "demo@example.invalid"],
              subject: "Approved from a phone, sent by a key the agent never held",
              body:
                "This message was composed on a laptop, approved on a phone, and sent by an adapter inside a single-use token window.\n",
              content_type: "text/plain",
            }),
          },
        ],
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** One CLI verb, as a child process. Returns its code, streams and JSON. */
function runVerb(args, cwd, extraEnv = {}) {
  return runVerbWithEnv(args, cwd, { ...process.env, ...extraEnv });
}

/**
 * The same, with the child's environment REPLACED rather than extended.
 *
 * One caller: the child-credentials preflight, which has to run a verb in an
 * environment this process does not have. Everything else wants to inherit.
 */
function runVerbWithEnv(args, cwd, env) {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: VERB_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
  const stdout = result.stdout ?? "";
  let json = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = null;
  }
  return { code: result.status ?? 1, stdout, stderr: result.stderr ?? "", json };
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function readIfPresent(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** The exact line an operator pastes. Absolute, so no shell function is owed. */
function line(dir, verb) {
  return `cd ${dir} && node ${CLI_ENTRY} ${verb}`;
}

/** The runtime's default when a policy names no `vault.passphrase_env`. */
const DEFAULT_PASSPHRASE_ENV = "APPROVAL_VAULT_PASSPHRASE";

/**
 * The variable this instance's policy names as the vault passphrase, read out
 * of its own `APPROVAL.md`. A policy that names none is the runtime default.
 */
function passphraseVariable(dir) {
  const policy = readIfPresent(join(dir, "APPROVAL.md")) ?? "";
  const named = /^[ \t]*passphrase_env:[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*$/mu.exec(policy);
  return named === null ? DEFAULT_PASSPHRASE_ENV : named[1];
}

/** Is `port` free on loopback? Bound and released; nothing is left listening. */
function portFree(port) {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => done(true));
    });
  });
}

function isGitWorkTree(dir) {
  return existsSync(join(dir, ".git"));
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * A step's status is one of:
 *   "ok"       done, by this run or an earlier one
 *   "waiting"  a human-only step; `command` is the exact line to run
 *   "skip"     not applicable to this instance, with the reason
 *   "fail"     the step ran and did not succeed
 */
function step(name, status, detail, command = null) {
  return command === null ? { step: name, status, detail } : { step: name, status, detail, command };
}

/** `.gitignore` lines this script owes the instance, merged, never rewritten. */
function ensureGitignore(dir, instance) {
  const path = join(dir, ".gitignore");
  const marker = "# examples/demo-provision.mjs";
  const owed = [`${RETIRED_DIR}/`, MARKER_FILE];
  // The Grok demo's instance IS a git work tree (a throwaway clone), so the
  // whole gate has to stay out of a repository the connected agent can push.
  if (instance.gitClone) owed.unshift(".approval/");
  const existing = readIfPresent(path) ?? "";
  const lines = existing.split("\n").map((entry) => entry.trim());
  const missing = owed.filter((entry) => !lines.includes(entry));
  if (missing.length === 0) {
    return step("gitignore", "ok", `${path} already ignores ${owed.join(", ")}`);
  }
  const prefix = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  writeFileSync(path, `${existing}${prefix}\n${marker}\n${missing.join("\n")}\n`, "utf8");
  return step("gitignore", "ok", `added ${missing.join(", ")} to ${path}`);
}

/** The marker that says which demo this directory belongs to. */
function readMarker(dir) {
  const text = readIfPresent(join(dir, MARKER_FILE));
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Write the marker, keeping the timestamp of the first provisioning run.
 *
 * A marker rewritten on every invocation would make "run it twice and nothing
 * changes" false for the one file this script owns, which is the property the
 * whole thing is for.
 */
function writeMarker(dir, instance, policyHash) {
  const existing = readMarker(dir);
  const marker = {
    instance: instance.id,
    path: dir,
    provisioned_at:
      typeof existing?.["provisioned_at"] === "string" ? existing["provisioned_at"] : new Date().toISOString(),
    script: "examples/demo-provision.mjs",
    policy: "examples/policies/demo-gate.APPROVAL.md",
    policy_sha256: policyHash,
  };
  const text = `${JSON.stringify(marker, null, 2)}\n`;
  if (readIfPresent(join(dir, MARKER_FILE)) !== text) writeFileSync(join(dir, MARKER_FILE), text, "utf8");
  return marker;
}

/**
 * Seed one envelope and its payload files, and return the step.
 *
 * The envelope's shape is `examples/web-agent-demo/server.mjs`'s `envelopeFor`,
 * which writes exactly this file for its own agent.
 *
 * **The operator owns the bytes; this script owns the binding.** A payload file
 * that already exists is left exactly as it is — an operator who changed the
 * recipient, the branch or the message meant it — and an envelope that already
 * exists keeps its class, its summary and its key. What a rerun does maintain is
 * the `payload_hash`: it is re-read from the bytes on disk through the real
 * `approval payload hash` and rewritten in place if it has moved, because an
 * envelope whose hash does not match its payload is refused `payload-mismatch`
 * at request time, on stage, with the room watching.
 */
function seedEnvelope(dir, seed, policyHuman) {
  const tasksDir = join(dir, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  const rows = [];
  for (const action of seed.actions) {
    const payloadFile = join(tasksDir, `${seed.id}.${action.slug}.json`);
    if (readIfPresent(payloadFile) === null) {
      writeFileSync(payloadFile, `${JSON.stringify(action.payload(dir), null, 2)}\n`, "utf8");
    }
    const hashed = runVerb(["payload", "hash", payloadFile, "--json"], dir);
    const hash = hashed.json?.hash;
    if (typeof hash !== "string") {
      return step(
        `seed ${seed.id}`,
        "fail",
        `approval payload hash refused ${payloadFile}: ${hashed.stderr.trim() || hashed.stdout.trim()}`,
      );
    }
    rows.push({ action, hash });
  }
  const taskFile = join(tasksDir, `${seed.id}.md`);
  const before = readIfPresent(taskFile);
  if (before === null) {
    writeFileSync(taskFile, envelopeText(seed, rows, policyHuman), "utf8");
    return step(
      `seed ${seed.id}`,
      "ok",
      `wrote ${taskFile}: ${String(rows.length)} action(s), each carrying a payload_hash`,
    );
  }
  let index = 0;
  const rebound = before.replaceAll(/payload_hash: "[0-9a-f]{64}"/gu, () => {
    const row = rows[index];
    index += 1;
    return `payload_hash: ${JSON.stringify(row === undefined ? "" : row.hash)}`;
  });
  if (rebound === before) {
    return step(`seed ${seed.id}`, "ok", `${taskFile} is unchanged, and its payload_hash values still match`);
  }
  writeFileSync(taskFile, rebound, "utf8");
  return step(
    `seed ${seed.id}`,
    "ok",
    `re-bound ${String(index)} payload_hash value(s) in ${taskFile} to the bytes on disk; nothing else in the envelope was touched`,
  );
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function envelopeText(seed, rows, policyHuman) {
  const lines = [
    "---",
    `id: ${seed.id}`,
    `title: ${yamlString(seed.title)}`,
    "status: In Progress",
    "approval:",
    "  origin:",
    "    app: demo-provision",
    `    created_by: ${yamlString(policyHuman)}`,
    "  state: proposed",
    "  actions:",
  ];
  for (const { action, hash } of rows) {
    lines.push(
      `    - class: ${action.class}`,
      `      summary: ${yamlString(action.summary)}`,
      `      reversible: ${action.reversible}`,
      `      est_cost_usd: ${yamlString(action.estCostUsd)}`,
      `      idempotency_key: ${yamlString(`${seed.id}:${action.slug}`)}`,
      `      payload_hash: ${yamlString(hash)}`,
    );
  }
  lines.push(
    "---",
    "",
    "## Description",
    "",
    "Seeded by `examples/demo-provision.mjs`. The class and the payload bytes are",
    "the demo operator's: an agent registers this file, asks the gate about it, and",
    "waits. Re-seeding rewrites nothing that has not changed, so a hash a human has",
    "already read on a phone stays the hash they read.",
    "",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Provision
// ---------------------------------------------------------------------------

async function provision(instance, dir) {
  const steps = [];
  const policyText = readFileSync(POLICY_FILE, "utf8");
  const policyHash = sha256(policyText);

  // 0. The Grok demo's instance is a throwaway repository clone, so that the
  //    gate and a working tree share one directory and `approval coverage` can
  //    see both. `git clone` refuses a directory that is not empty, so this
  //    step comes BEFORE the scaffold and the script stops rather than making
  //    the clone impossible. The clone classifies network.call: it is a
  //    human's to run, or the explicit register/request/wait/run flow's.
  if (instance.gitClone && !isGitWorkTree(dir)) {
    const empty = !existsSync(dir) || readdirSync(dir).length === 0;
    const command = `git clone https://github.com/<you>/grok-bot-demo.git ${dir}`;
    const clone = step(
      "clone",
      "waiting",
      empty
        ? `${dir} is not a git work tree yet, and nothing is scaffolded into it until it is: \`git clone\` refuses a directory that already holds files`
        : `${dir} is not a git work tree and is not empty, so \`git clone\` cannot be pointed at it. Either clone into a fresh path and pass --path, or run \`git init\` here and add the remote yourself`,
      command,
    );
    if (empty) {
      return { steps: [clone], pending: [{ step: clone.step, command }], exit: EXIT_OK };
    }
    steps.push(clone);
  }

  // 1. The directory. `approval init` does NOT create the path it is pointed
  //    at: --dir on an absent path exits 4 with ENOENT and writes nothing.
  if (existsSync(dir)) {
    steps.push(step("directory", "ok", `${dir} exists`));
  } else {
    mkdirSync(dir, { recursive: true });
    steps.push(step("directory", "ok", `created ${dir}`));
  }

  // 2. The marker, and the refusal that keeps two demos out of one directory.
  const marker = readMarker(dir);
  if (marker !== null && marker["instance"] !== instance.id) {
    return {
      steps: [
        ...steps,
        step(
          "marker",
          "fail",
          `${dir} was provisioned for the ${String(marker["instance"])} demo. Pass --path <other dir> to provision ${instance.id} somewhere else, or --reset to retire this instance's state and re-provision it for ${instance.id}`,
        ),
      ],
      pending: [],
      exit: EXIT_USAGE,
    };
  }

  // 3. The scaffold. Idempotent by construction: it never overwrites, reports
  //    what it found under `existing`, and appends nothing to any log.
  const init = runVerb(["init", "--dir", dir, "--json"], dir);
  if (init.code !== EXIT_OK || init.json?.ok !== true) {
    return {
      steps: [
        ...steps,
        step("scaffold", "fail", `approval init refused: ${init.stderr.trim() || init.stdout.trim()}`),
      ],
      pending: [],
      exit: init.code === EXIT_IO ? EXIT_IO : EXIT_FAILED,
    };
  }
  const written = Array.isArray(init.json["written"]) ? init.json["written"] : [];
  steps.push(
    step(
      "scaffold",
      "ok",
      written.length === 0
        ? "approval init found everything already scaffolded and wrote nothing"
        : `approval init wrote ${written.join(", ")}`,
    ),
  );

  // 4. The demo policy. It replaces the scaffold ONLY when this same run wrote
  //    the scaffold: an APPROVAL.md that was already there is somebody's
  //    attested policy, and overwriting it would refuse every gate verb with
  //    hash-mismatch until a human attested again.
  const policyPath = join(dir, "APPROVAL.md");
  const onDisk = readIfPresent(policyPath);
  if (written.includes("APPROVAL.md")) {
    writeFileSync(policyPath, policyText, "utf8");
    steps.push(
      step("policy", "ok", `wrote the demo policy over the scaffold (sha256 ${policyHash.slice(0, 12)}…)`),
    );
  } else if (onDisk === policyText) {
    steps.push(step("policy", "ok", `${policyPath} is the demo policy (sha256 ${policyHash.slice(0, 12)}…)`));
  } else {
    steps.push(
      step(
        "policy",
        "ok",
        `${policyPath} exists and differs from examples/policies/demo-gate.APPROVAL.md; KEPT. Overwriting an attested policy refuses every gate verb with hash-mismatch. Diff the two, and use --reset if you want this instance rebuilt from the packaged one`,
      ),
    );
  }

  steps.push(ensureGitignore(dir, instance));
  writeMarker(dir, instance, policyHash);

  // 5. The proof that the file parses. An unparseable policy is a
  //    manual-everything policy delivered at exit 0, so the discriminating
  //    check is a class the policy makes PERMISSIVE.
  const permissive = runVerb(["policy", "check", "read.files", "--reversible", "true", "--json"], dir);
  const strict = runVerb(
    ["policy", "check", "communicate.email.external", "--reversible", "false", "--json"],
    dir,
  );
  const permissiveOutcome = permissive.json?.outcome?.autonomy;
  const strictOutcome = strict.json?.outcome?.autonomy;
  if (permissiveOutcome !== "autonomous" || strictOutcome !== "manual") {
    steps.push(
      step(
        "policy-check",
        "fail",
        `expected read.files -> autonomous and communicate.email.external -> manual; got ${String(permissiveOutcome)} and ${String(strictOutcome)}. A policy that answers manual everywhere is the fail-closed answer to an unparseable file`,
      ),
    );
  } else {
    steps.push(
      step("policy-check", "ok", "read.files -> autonomous, communicate.email.external -> manual"),
    );
  }

  // 6. Seeded envelopes, hashed by the real verb.
  for (const seed of instance.seeds) steps.push(seedEnvelope(dir, seed, DEMO_HUMAN));

  // 7. What a human owes this instance. Detected, never run.
  const state = inspect(instance, dir);
  steps.push(...state.steps);

  const pending = steps
    .filter((entry) => entry.status === "waiting")
    .map((entry) => ({ step: entry.step, command: entry.command }));

  const failed = steps.filter((entry) => entry.status === "fail");
  return { steps, pending, exit: failed.length === 0 ? EXIT_OK : EXIT_FAILED };
}

/**
 * What state is this instance in, as the read-only verbs see it?
 *
 * `approval doctor` answers for the attestation and the vault; `approval env
 * --check` answers for the variables, and prints no value on any path. Neither
 * appends anything.
 */
function inspect(instance, dir) {
  const steps = [];
  const doctor = runVerb(["doctor", "--json"], dir, { APPROVAL_HUMAN: DEMO_HUMAN });
  const rows = Array.isArray(doctor.json?.checks) ? doctor.json["checks"] : [];
  const row = (name) => rows.find((entry) => entry["check"] === name) ?? null;
  const env = runVerb(["env", "--check", "--json"], dir);
  const variables = Array.isArray(env.json?.variables) ? env.json["variables"] : [];
  const variable = (name) => variables.find((entry) => entry["name"] === name) ?? null;
  const isSet = (name) => {
    const found = variable(name);
    return found !== null && found["status"] !== "unset";
  };

  const attestation = row("attestation");
  if (attestation !== null && attestation["status"] === "pass") {
    steps.push(step("attest", "ok", String(attestation["detail"])));
  } else {
    steps.push(
      step(
        "attest",
        "waiting",
        attestation === null
          ? "approval doctor could not read this instance's attestation state"
          : String(attestation["detail"]),
        line(dir, `policy attest --as ${DEMO_HUMAN}`),
      ),
    );
  }

  if (isSet("APPROVAL_HUMAN")) {
    steps.push(step("identity", "ok", `APPROVAL_HUMAN is set (${String(variable("APPROVAL_HUMAN")["source"])})`));
  } else {
    steps.push(
      step(
        "identity",
        "waiting",
        "APPROVAL_HUMAN is unset: the human-only verbs will refuse until it is declared",
        line(dir, "setup identity"),
      ),
    );
  }

  if (instance.channel) {
    if (isSet("APPROVAL_TG_TOKEN") && isSet("APPROVAL_TG_CHAT")) {
      steps.push(step("channel", "ok", "APPROVAL_TG_TOKEN and APPROVAL_TG_CHAT both resolve"));
    } else {
      steps.push(
        step(
          "channel",
          "waiting",
          "the Telegram channel is not configured, so no decision reaches a phone",
          line(dir, `setup channel telegram --as ${DEMO_HUMAN}`),
        ),
      );
    }
  }

  const vaultPath = join(dir, ".approval", "vault.enc");
  const vaultExists = existsSync(vaultPath);
  if (!instance.vault) {
    steps.push(
      step(
        "vault",
        vaultExists ? "fail" : "skip",
        vaultExists
          ? `${vaultPath} EXISTS on the guest instance. examples/web-agent-demo/runbook.md §4 states the empty vault as a MUST: it is what makes a bug in guest mode's verb filter cost nothing. Retire this instance and provision a fresh one`
          : "not on this instance by design: the crowd track requires an empty vault and no mail adapter (runbook.md §4)",
      ),
    );
    return { steps, doctor, env };
  }

  const vaultRow = row("vault");
  if (!vaultExists) {
    steps.push(
      step(
        "vault",
        "waiting",
        "no credential vault yet; the finale's adapter would refuse credential-unavailable",
        line(dir, `setup vault --as ${DEMO_HUMAN}`),
      ),
    );
  } else if (vaultRow !== null && vaultRow["status"] === "pass") {
    steps.push(step("vault", "ok", String(vaultRow["detail"])));
  } else {
    steps.push(
      step(
        "vault",
        "ok",
        `${vaultPath} exists; this script cannot open it (the passphrase is not in its environment). doctor says: ${vaultRow === null ? "nothing" : String(vaultRow["detail"])}`,
      ),
    );
  }

  if (instance.adapter !== null) {
    const held = vaultRow === null ? null : credentialCount(String(vaultRow["detail"] ?? ""));
    if (held !== null && held >= instance.adapter.credentials) {
      steps.push(
        step("adapter", "ok", `the vault holds ${String(held)} credential(s), enough for the ${instance.adapter.name} adapter`),
      );
    } else {
      steps.push(
        step(
          "adapter",
          "waiting",
          held === null
            ? `this script cannot count the ${instance.adapter.name} adapter's credentials without the vault passphrase; confirm them by name with \`approval vault list --as ${DEMO_HUMAN}\``
            : `the vault holds ${String(held)} credential(s); the ${instance.adapter.name} adapter declares ${String(instance.adapter.credentials)}`,
          line(dir, `${instance.adapter.verb} --as ${DEMO_HUMAN}`),
        ),
      );
    }
  }

  return { steps, doctor, env };
}

/** `…holds N credential(s)…` out of doctor's vault row, or null. */
function credentialCount(detail) {
  const match = /holds (\d+) credential/u.exec(detail);
  return match === null ? null : Number(match[1]);
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

/**
 * Retire the instance's state into `<instance>/retired/<stamp>/`.
 *
 * Nothing is truncated and nothing is edited: the whole log directory moves,
 * intact, which is the runbooks' "retire the instance rather than reaching
 * into it" with the directory kept. The vault and `.approval/env` are not in
 * the moved set, which is how a reset keeps the credentials; `--vault` adds
 * the vault file to it.
 */
function reset(instance, dir, options) {
  if (!existsSync(dir)) {
    return { steps: [step("reset", "skip", `${dir} does not exist yet; nothing to retire`)], exit: EXIT_OK };
  }
  if (options.vault && !instance.vault) {
    return {
      steps: [
        step(
          "reset",
          "fail",
          `--vault does not apply to the ${instance.id} instance: it holds no vault by design (runbook.md §4)`,
        ),
      ],
      exit: EXIT_USAGE,
    };
  }
  const movable = [
    join(".approval", "log"),
    join(".approval", "QUEUE.md"),
    join(".approval", "payloads"),
    join(".approval", "keys"),
    "tasks",
  ];
  if (options.vault) movable.push(join(".approval", "vault.enc"));

  const present = movable.filter((relativePath) => existsSync(join(dir, relativePath)));
  if (present.length === 0) {
    return { steps: [step("reset", "skip", "nothing to retire: this instance holds no log, queue or tasks")], exit: EXIT_OK };
  }
  const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d+Z$/u, "Z");
  const destination = join(dir, RETIRED_DIR, stamp);
  mkdirSync(destination, { recursive: true });
  for (const relativePath of present) {
    const target = join(destination, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    renameSync(join(dir, relativePath), target);
  }
  return {
    steps: [
      step(
        "reset",
        "ok",
        `retired ${present.join(", ")} into ${destination}. Nothing was truncated or edited; the previous chain is intact inside the instance${options.vault ? "" : ", and the vault and .approval/env were left alone"}`,
      ),
    ],
    exit: EXIT_OK,
  };
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

async function check(instance, dir) {
  const checks = [];
  const add = (name, ok, detail, fix = null) =>
    checks.push(fix === null ? { check: name, status: ok ? "pass" : "fail", detail } : { check: name, status: ok ? "pass" : "fail", detail, fix });

  if (!existsSync(dir)) {
    add("instance", false, `${dir} does not exist`, `node ${fileURLToPath(import.meta.url)} --instance ${instance.id}`);
    return { checks, exit: EXIT_FAILED };
  }
  const marker = readMarker(dir);
  add(
    "instance",
    marker !== null && marker["instance"] === instance.id,
    marker === null
      ? `${dir} carries no ${MARKER_FILE}; provision it with this script so a later run knows which demo it belongs to`
      : `${dir} is the ${String(marker["instance"])} instance, provisioned ${String(marker["provisioned_at"])}`,
  );

  const policyText = readFileSync(POLICY_FILE, "utf8");
  const onDisk = readIfPresent(join(dir, "APPROVAL.md"));
  add(
    "policy",
    onDisk !== null,
    onDisk === null
      ? "no APPROVAL.md in the instance"
      : onDisk === policyText
        ? "APPROVAL.md is examples/policies/demo-gate.APPROVAL.md, byte for byte"
        : "APPROVAL.md differs from examples/policies/demo-gate.APPROVAL.md. That is legitimate (an instance may carry a policy of its own), and it means the packaged file is not what this gate is running",
  );

  // The instance's own doctor: 0 failed and exit 0 is green. Rows marked
  // "skip" are states rather than faults and never fail the verb.
  const doctor = runVerb(["doctor", "--json"], dir, { APPROVAL_HUMAN: DEMO_HUMAN });
  const rows = Array.isArray(doctor.json?.checks) ? doctor.json["checks"] : [];
  const failedRows = rows.filter((entry) => entry["status"] === "fail");
  add(
    "doctor",
    doctor.code === EXIT_OK && failedRows.length === 0,
    failedRows.length === 0
      ? `approval doctor: ${String(rows.filter((entry) => entry["status"] === "pass").length)} ok, ${String(rows.filter((entry) => entry["status"] === "skip").length)} not applicable, 0 failed`
      : `approval doctor failed ${String(failedRows.length)} check(s): ${failedRows.map((entry) => String(entry["check"])).join(", ")}`,
    failedRows.length === 0 ? null : line(dir, "doctor"),
  );

  // The demo's own preflight, beyond the doctor's. `doctor` was handed an
  // APPROVAL_HUMAN for its own identity row, and its telegram row is a SKIP
  // when the channel is simply unconfigured — a legitimate state for a gate,
  // and not a legitimate state for a demo whose decisions go to a phone. So
  // both are asked again here, of `.approval/env`, which prints no value.
  const env = runVerb(["env", "--check", "--json"], dir);
  const variables = Array.isArray(env.json?.variables) ? env.json["variables"] : [];
  const resolves = (name) => {
    const found = variables.find((entry) => entry["name"] === name);
    return found !== undefined && found["status"] !== "unset";
  };
  add(
    "identity",
    resolves("APPROVAL_HUMAN"),
    resolves("APPROVAL_HUMAN")
      ? "APPROVAL_HUMAN resolves from .approval/env"
      : "APPROVAL_HUMAN is unset in .approval/env: the human-only verbs refuse, and doctor's identity row is green here only because this script handed it one",
    resolves("APPROVAL_HUMAN") ? null : line(dir, "setup identity"),
  );
  if (instance.channel) {
    const configured = resolves("APPROVAL_TG_TOKEN") && resolves("APPROVAL_TG_CHAT");
    add(
      "channel",
      configured,
      configured
        ? "APPROVAL_TG_TOKEN and APPROVAL_TG_CHAT both resolve, so a request can reach the phone"
        : "the Telegram channel is not configured: nothing this instance asks will reach a phone",
      configured ? null : line(dir, `setup channel telegram --as ${DEMO_HUMAN}`),
    );
  }

  const vaultPath = join(dir, ".approval", "vault.enc");
  if (instance.vault) {
    add(
      "vault",
      existsSync(vaultPath),
      existsSync(vaultPath)
        ? `${vaultPath} exists; confirm its contents by name with \`approval vault list --as ${DEMO_HUMAN}\``
        : "no vault: the finale's adapter refuses credential-unavailable, and the grant it was holding goes unspent",
      existsSync(vaultPath) ? null : line(dir, `setup vault --as ${DEMO_HUMAN}`),
    );

    // APRV-168. The finale is the one beat with a credential in its path, and
    // the adapter that needs it does not run in the operator's shell: it runs
    // inside the agent child, whose environment `web-agent-demo/server.mjs`
    // scrubs of every gate name and whose HOME is a directory the demo owns.
    // On 2026-09-19 that shape, and nothing else, was the difference between a
    // working rehearsal and a `credential-unavailable` in front of a room: the
    // passphrase is a `keychain:` line, and macOS finds the login keychain
    // through HOME.
    //
    // So this asks the question in the shape the answer has to hold for, using
    // the server's own scrub (imported, not copied) and the instance's own
    // `.approval/env`. It spends no token, opens no vault and sends no mail —
    // `approval env --check` resolves and reports, and prints no value on any
    // path — and it may raise the keychain's own access prompt, which is the
    // right morning for that to happen.
    const variable = passphraseVariable(dir);
    const child = runVerbWithEnv(["env", "--check", "--json"], dir, agentEnv(dir));
    const variables = Array.isArray(child.json?.variables) ? child.json["variables"] : [];
    const entry = variables.find((candidate) => candidate["name"] === variable) ?? null;
    const resolved = entry !== null && entry["status"] !== "unset";
    add(
      "child-credentials",
      resolved,
      resolved
        ? `${variable} resolves (${String(entry["status"])}, ${String(entry["source"])}) in the agent child's own environment, so the finale's adapter can open the vault inside its token window`
        : entry === null
          ? `${variable} is not a variable this instance's \`approval env\` answers for; the finale's adapter has no passphrase to find`
          : `${variable} does NOT resolve in the agent child's environment (${String(entry["refusal"]?.["code"] ?? "unset")}): the finale will refuse credential-unavailable with a human's approval already given. The operator's own shell is not the question here — the child runs with HOME=${String(agentEnv(dir).HOME)} and no gate variable at all`,
      resolved ? null : line(dir, "env --check"),
    );
  } else {
    add(
      "vault",
      !existsSync(vaultPath),
      existsSync(vaultPath)
        ? `${vaultPath} EXISTS on the guest instance, and runbook.md §4 states the empty vault as a MUST. Retire this instance`
        : "empty by design: no vault and no mail adapter on the guest instance (runbook.md §4)",
    );
  }

  for (const port of instance.ports) {
    // eslint-disable-next-line no-await-in-loop
    const free = await portFree(port);
    add(
      `port-${String(port)}`,
      free,
      free
        ? `127.0.0.1:${String(port)} is free (bound and released; nothing was left listening)`
        : `127.0.0.1:${String(port)} is already in use: the demo's own server will not be able to bind it`,
    );
  }

  for (const seed of instance.seeds) {
    const taskFile = join(dir, "tasks", `${seed.id}.md`);
    const envelope = readIfPresent(taskFile);
    if (envelope === null) {
      add(`seed-${seed.id}`, false, `${taskFile} is missing: a guest can register only what is already on disk`, `node ${fileURLToPath(import.meta.url)} --instance ${instance.id}`);
      continue;
    }
    const hashes = [...envelope.matchAll(/payload_hash: "([0-9a-f]{64})"/gu)].map((match) => match[1]);
    let matched = hashes.length === seed.actions.length;
    for (const [index, action] of seed.actions.entries()) {
      const payloadFile = join(dir, "tasks", `${seed.id}.${action.slug}.json`);
      if (!existsSync(payloadFile)) {
        matched = false;
        break;
      }
      const hashed = runVerb(["payload", "hash", payloadFile, "--json"], dir);
      if (hashed.json?.hash !== hashes[index]) matched = false;
    }
    add(
      `seed-${seed.id}`,
      matched,
      matched
        ? `${taskFile} declares ${String(seed.actions.length)} action(s), each payload_hash matching the bytes on disk`
        : `${taskFile}'s payload_hash values do not match the payload files beside it. A manual action whose hash is wrong is refused payload-mismatch at request time`,
    );
  }

  if (instance.gitClone) {
    add(
      "clone",
      isGitWorkTree(dir),
      isGitWorkTree(dir)
        ? `${dir} is a git work tree, so the gate and the demo repository share one working directory`
        : `${dir} is not a git work tree; the Grok demo's beats push a branch from this directory`,
    );
    const ignore = readIfPresent(join(dir, ".gitignore")) ?? "";
    add(
      "gitignore",
      ignore.split("\n").some((entry) => entry.trim() === ".approval/"),
      ignore.split("\n").some((entry) => entry.trim() === ".approval/")
        ? ".approval/ is ignored, so no gate state can be pushed to a repository the agent can read"
        : ".approval/ is NOT ignored in this clone: the log, the queue and the payload store would be pushed",
    );
  }

  const failed = checks.filter((entry) => entry.status === "fail");
  return { checks, exit: failed.length === 0 ? EXIT_OK : EXIT_FAILED };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const GLYPH = { ok: "✓", pass: "✓", fail: "✗", skip: "–", waiting: "→" };

function renderSteps(instance, dir, result) {
  const out = [];
  out.push(`approval.md demo provisioning — ${instance.id}: ${instance.title}`);
  out.push(`  directory  ${dir}`);
  out.push(`  policy     examples/policies/demo-gate.APPROVAL.md`);
  out.push(`  runbook    ${instance.runbook}`);
  out.push("");
  for (const entry of result.steps) {
    out.push(`${GLYPH[entry.status] ?? "?"} ${entry.step.padEnd(14)} ${entry.detail}`);
  }
  if (result.pending !== undefined && result.pending.length > 0) {
    out.push("");
    out.push("Waiting on you. Run these, then run this script again:");
    out.push("");
    for (const [index, entry] of result.pending.entries()) {
      out.push(`  ${String(index + 1)}. ${entry.step}`);
      out.push(`     ${entry.command}`);
    }
    out.push("");
    out.push("  Each one prompts, or needs a terminal, or is a real-world action this");
    out.push("  script has no authority to take. None of them is run for you.");
  }
  if (result.exit === EXIT_OK && (result.pending === undefined || result.pending.length === 0)) {
    out.push("");
    out.push(`Provisioned. Check it with: node ${fileURLToPath(import.meta.url)} --instance ${instance.id} --check`);
  }
  return out.join("\n");
}

function renderChecks(instance, dir, result) {
  const out = [];
  out.push(`approval.md demo preflight — ${instance.id} at ${dir}`);
  out.push("");
  for (const entry of result.checks) {
    out.push(`${GLYPH[entry.status] ?? "?"} ${entry.check.padEnd(14)} ${entry.detail}`);
    if (entry.fix !== undefined) out.push(`${" ".repeat(17)}fix: ${entry.fix}`);
  }
  const failed = result.checks.filter((entry) => entry.status === "fail").length;
  out.push("");
  out.push(`${String(result.checks.length - failed)} ok · ${String(failed)} failed`);
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const HELP = `approval.md demo provisioning — one instance, from the documented steps

Usage:
  node examples/demo-provision.mjs --instance <id> [--path <dir>]
  node examples/demo-provision.mjs --instance <id> --check
  node examples/demo-provision.mjs --instance <id> --reset [--vault]

Instances:
  web-agent   ~/demo-gate      the web-agent demo (examples/web-agent-demo/runbook.md)
  guest       ~/demo-guest     the crowd track's throwaway gate, EMPTY VAULT (§4)
  grok-bot    ~/demo-grok-bot  the Grok Bot connector demo

Flags:
  --instance <id>  which demo (required)
  --path <dir>     the instance directory, overriding the default
  --check          doctor plus the demo's own preflight; writes nothing
  --reset          retire log, queue, payload store and seeded tasks into
                   <instance>/retired/<stamp>/, then provision again
  --vault          with --reset only: retire .approval/vault.enc too
  --json           machine-readable output
  -h, --help       this text

Human-only steps (attest, the interactive credential verbs, the clone, the
tunnel) are printed as the exact line to run and never run for you. Run this
script again afterwards and it picks up where you left off.

exit codes: 0 ok (including waiting on a human), 1 a failed step or check,
2 usage or a refusal, 4 I/O.`;

function parseArgs(argv) {
  const options = { instance: null, path: null, reset: false, vault: false, check: false, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--instance":
      case "--path": {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) return { error: `${argument} needs a value` };
        if (argument === "--instance") options.instance = value;
        else options.path = value;
        index += 1;
        break;
      }
      case "--reset":
        options.reset = true;
        break;
      case "--vault":
        options.vault = true;
        break;
      case "--check":
        options.check = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        return { error: `unknown argument ${argument}` };
    }
  }
  return { options };
}

function fail(message, json) {
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: { code: "usage", message } })}\n`);
  else process.stderr.write(`✗ ${message}\n`);
  process.exitCode = EXIT_USAGE;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error !== undefined) {
    fail(parsed.error, false);
    process.stderr.write(`\n${HELP}\n`);
    return;
  }
  const options = parsed.options;
  if (options.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (options.instance === null) {
    fail("--instance is required", options.json);
    if (!options.json) process.stderr.write(`\n${HELP}\n`);
    return;
  }
  const instance = INSTANCES[options.instance];
  if (instance === undefined) {
    fail(`unknown instance ${options.instance}; expected one of ${Object.keys(INSTANCES).join(", ")}`, options.json);
    return;
  }
  if (options.vault && !options.reset) {
    fail("--vault applies to --reset only: this script never creates a vault, it only retires one", options.json);
    return;
  }
  if (options.check && options.reset) {
    fail("--check and --reset are separate runs: check an instance, or reset it", options.json);
    return;
  }
  if (!existsSync(CLI_ENTRY)) {
    const message = `${CLI_ENTRY} is missing: build the repository first (npm run build)`;
    if (options.json) process.stdout.write(`${JSON.stringify({ ok: false, error: { code: "not-built", message } })}\n`);
    else process.stderr.write(`✗ ${message}\n`);
    process.exitCode = EXIT_IO;
    return;
  }

  const dir = resolve(options.path ?? instance.defaultPath);

  if (options.check) {
    const result = await check(instance, dir);
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ok: result.exit === EXIT_OK, instance: instance.id, dir, action: "check", checks: result.checks }, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderChecks(instance, dir, result)}\n`);
    }
    process.exitCode = result.exit;
    return;
  }

  const steps = [];
  if (options.reset) {
    const retired = reset(instance, dir, options);
    steps.push(...retired.steps);
    if (retired.exit !== EXIT_OK) {
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ ok: false, instance: instance.id, dir, action: "reset", steps }, null, 2)}\n`);
      } else {
        process.stdout.write(`${renderSteps(instance, dir, { steps, pending: [], exit: retired.exit })}\n`);
      }
      process.exitCode = retired.exit;
      return;
    }
    // A reset also clears the marker's claim on this directory, so that a
    // retired instance can be re-provisioned for a different demo. The three
    // defaults no longer collide, but --path means one directory can still be
    // asked to hold a second demo, and a reset is how that is allowed.
    const markerPath = join(dir, MARKER_FILE);
    if (existsSync(markerPath)) {
      const destination = join(dir, RETIRED_DIR, "marker");
      mkdirSync(destination, { recursive: true });
      renameSync(markerPath, join(destination, `${MARKER_FILE}.${String(Date.now())}`));
    }
  }

  const result = await provision(instance, dir);
  result.steps = [...steps, ...result.steps];
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: result.exit === EXIT_OK,
          instance: instance.id,
          dir,
          action: options.reset ? "reset" : "provision",
          steps: result.steps,
          pending: result.pending,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`${renderSteps(instance, dir, result)}\n`);
  }
  process.exitCode = result.exit;
}

await main();
