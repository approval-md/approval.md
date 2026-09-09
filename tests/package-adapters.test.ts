/**
 * The public adapter API as a downstream package sees it (APRV-321).
 *
 * Source imports cannot prove a package boundary. This suite packs the current
 * tree, unpacks that tarball under a temporary node_modules directory, and runs
 * JavaScript and TypeScript consumers against the declared package subpath.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import type { JsonValue } from "../src/adapters/contract.js";
import { payloadHash } from "../src/core/payload.js";
import { decide, register, request } from "./clock-adapters.js";
import { at, attest, newScenario, T0 } from "./scenario.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "approval-md-package-adapters-"));
const consumerRoot = join(scratch, "consumer");
const packageRoot = join(consumerRoot, "node_modules", "approval-md");
const AGENT = "agent:package-consumer";
const HUMAN = "human:carter";
const ADAPTER_CLASS = "public.post";

after(() => rmSync(scratch, { recursive: true, force: true }));

interface PackedFile {
  path: string;
}

interface PackResult {
  filename: string;
  files: PackedFile[];
}

function spawn(command: string, args: readonly string[], cwd: string = REPO_ROOT) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: join(scratch, "npm-cache") },
    maxBuffer: 4 * 1024 * 1024,
    timeout: 60_000,
  });
  assert.equal(
    result.error,
    undefined,
    `${command} could not start: ${String(result.error)}`,
  );
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed (${String(result.status)}):\n${result.stderr}\n${result.stdout}`,
  );
  return result;
}

function preparePackage(): PackResult {
  mkdirSync(packageRoot, { recursive: true });
  for (const dependency of [
    "@modelcontextprotocol",
    "@types",
    "ajv",
    "ajv-formats",
    "better-sqlite3",
    "yaml",
  ]) {
    symlinkSync(
      join(REPO_ROOT, "node_modules", dependency),
      join(consumerRoot, "node_modules", dependency),
      "junction",
    );
  }
  writeFileSync(join(consumerRoot, "package.json"), '{"type":"module"}\n', "utf8");
  const packed = spawn("npm", [
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    scratch,
  ]);
  const parsed = JSON.parse(packed.stdout) as PackResult[];
  assert.equal(parsed.length, 1, "npm pack must produce exactly one tarball");
  const result = parsed[0];
  assert.ok(result !== undefined);
  spawn("tar", [
    "-xzf",
    join(scratch, result.filename),
    "-C",
    packageRoot,
    "--strip-components=1",
  ]);
  return result;
}

const packed = preparePackage();

function runConsumer(name: string, source: string, args: readonly string[] = []): string {
  const path = join(consumerRoot, name);
  writeFileSync(path, source, "utf8");
  return spawn(process.execPath, [path, ...args], consumerRoot).stdout.trim();
}

const POLICY = [
  "# Public adapter package fixture",
  "",
  "```yaml approval-policy",
  'version: "0.1"',
  "defaults:",
  "  autonomy: manual",
  "classes:",
  "  public.post:",
  "    autonomy: manual",
  "```",
  "",
].join("\n");

let grantCounter = 0;

interface ConsumerGrant {
  logPath: string;
  policyPath: string;
  actionKey: string;
  payload: JsonValue;
  token: string;
  actor: string;
  class: string;
}

/** A real grant built through the write boundary, never a hand-written log. */
function granted(): ConsumerGrant {
  grantCounter += 1;
  const unit = newScenario(scratch, POLICY);
  attest(unit, T0);
  const actionKey = `package-adapters:send-${grantCounter}:2026-09-08`;
  const payload: JsonValue = { body: `public adapter payload ${grantCounter}` };
  const registered = register(
    unit.logPath,
    {
      task: "package-adapters",
      envelope: {
        origin: { app: "manual", created_by: AGENT },
        state: "awaiting",
        actions: [
          {
            class: ADAPTER_CLASS,
            idempotency_key: actionKey,
            summary: `publish fixture ${grantCounter}`,
            reversible: false,
            payload_hash: payloadHash(payload),
          },
        ],
      },
    },
    T0,
    AGENT,
    unit.options,
  );
  assert.equal(registered.ok, true, JSON.stringify(registered));
  const requested = request(
    unit.logPath,
    {
      task: "package-adapters",
      actionKey,
      cls: ADAPTER_CLASS,
      reversible: false,
      summary: `publish fixture ${grantCounter}`,
    },
    at(1),
    AGENT,
    unit.options,
  );
  assert.equal(requested.ok, true, JSON.stringify(requested));
  const decided = decide(unit.logPath, actionKey, "grant", HUMAN, at(2), unit.options);
  assert.equal(decided.ok, true, JSON.stringify(decided));
  if (!decided.ok || decided.token === undefined) throw new Error("grant returned no token");
  return {
    logPath: unit.logPath,
    policyPath: unit.policyPath,
    actionKey,
    payload,
    token: decided.token,
    actor: AGENT,
    class: ADAPTER_CLASS,
  };
}

test("the tarball ships the public JavaScript, declarations and guide", () => {
  const paths = packed.files.map((file) => file.path);
  assert.ok(paths.includes("dist/src/adapters/public.js"));
  assert.ok(paths.includes("dist/src/adapters/public.d.ts"));
  assert.ok(paths.includes("docs/adapter-api.md"));
  assert.equal(paths.some((path) => path.startsWith("dist/tests/")), false);
});

test("the package exposes exactly the five runtime names and refuses private paths", () => {
  const output = runConsumer(
    "surface.mjs",
    `import * as api from "approval-md/adapters";
const blocked = [];
for (const path of [
  "approval-md/dist/src/adapters/contract.js",
  "approval-md/dist/src/adapters/conformance.js",
  "approval-md/dist/src/adapters/vault-provider.js",
  "approval-md/dist/src/core/token.js",
]) {
  try {
    await import(path);
    blocked.push({ path, code: "imported" });
  } catch (error) {
    blocked.push({ path, code: error?.code });
  }
}
console.log(JSON.stringify({ keys: Object.keys(api).sort(), blocked }));
`,
  );
  const result = JSON.parse(output) as {
    keys: string[];
    blocked: { path: string; code: string }[];
  };
  assert.deepEqual(result.keys, [
    "ADAPTER_REFUSAL_CODES",
    "CREDENTIAL_REFUSAL_CODES",
    "executeThroughAdapter",
    "runAdapterConformance",
    "vaultCredentialProvider",
  ]);
  assert.deepEqual(
    result.blocked.map(({ code }) => code),
    Array.from({ length: 4 }, () => "ERR_PACKAGE_PATH_NOT_EXPORTED"),
  );
});

test("a strict NodeNext TypeScript consumer implements the public types", () => {
  writeFileSync(
    join(consumerRoot, "typed-consumer.ts"),
    `import {
  ADAPTER_REFUSAL_CODES,
  CREDENTIAL_REFUSAL_CODES,
  executeThroughAdapter,
  runAdapterConformance,
  vaultCredentialProvider,
  type ActInput,
  type ActOutcome,
  type Adapter,
  type AdapterConformanceCase,
  type AdapterConformanceHarness,
  type AdapterExecuteOptions,
  type AdapterExecuteRequest,
  type AdapterExecuteResult,
  type AdapterExecuteSuccess,
  type AdapterRefusal,
  type AdapterRefusalCode,
  type ConformanceContext,
  type CredentialKind,
  type CredentialProvider,
  type CredentialRefusalCode,
  type CredentialResult,
  type CredentialSpec,
  type ExecutionGrant,
  type JsonValue,
  type PrecheckInput,
  type PrecheckOutcome,
  type VaultLocation,
  type VaultProviderOptions,
} from "approval-md/adapters";

const kind: CredentialKind = "secret";
const spec: CredentialSpec = {
  name: "broadcast.key", kind, label: "Broadcast key",
  describe: "Provider write credential", required: true,
};
const adapter: Adapter = {
  name: "broadcast", classes: ["public.post"],
  act(input: ActInput): ActOutcome {
    const payload: JsonValue = input.payload;
    return { ok: true, detail: payload };
  },
};
const request: AdapterExecuteRequest = {
  logPath: "/tmp/log", actionKey: "task:action", payload: {}, actor: "agent:test",
};
const options: AdapterExecuteOptions = {};
const promise: Promise<AdapterExecuteResult> = executeThroughAdapter(adapter, request, options);
const provider: CredentialProvider = vaultCredentialProvider(
  { logPath: request.logPath } satisfies VaultLocation,
  { passphraseEnv: "APPROVAL_VAULT_PASSPHRASE" } satisfies VaultProviderOptions,
);
const harness = null as unknown as AdapterConformanceHarness;
const context: ConformanceContext = {};
const conformance: Promise<void> = runAdapterConformance(context, () => adapter, harness);
const refusalCode: AdapterRefusalCode = ADAPTER_REFUSAL_CODES[0];
const credentialCode: CredentialRefusalCode = CREDENTIAL_REFUSAL_CODES[0];
let credential: CredentialResult = provider.get(spec.name);
let outcome: ActOutcome = { ok: false, code: credentialCode, message: "unavailable" };
let precheck: PrecheckOutcome = { ok: true };
let grant!: ExecutionGrant;
let input!: PrecheckInput;
let oneCase!: AdapterConformanceCase;
let refusal!: AdapterRefusal;
let success!: AdapterExecuteSuccess;
void [promise, conformance, refusalCode, credential, outcome, precheck, grant, input, oneCase, refusal, success];
`,
    "utf8",
  );
  writeFileSync(
    join(consumerRoot, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2023",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          exactOptionalPropertyTypes: true,
          noEmit: true,
          skipLibCheck: false,
          types: ["node"],
        },
        files: ["typed-consumer.ts"],
      },
      null,
      2,
    ),
    "utf8",
  );
  spawn(join(REPO_ROOT, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], consumerRoot);
});

test("the packed contract binds bytes and permits one execution", () => {
  const unit = granted();
  const inputPath = join(consumerRoot, "binding.json");
  writeFileSync(inputPath, JSON.stringify(unit), "utf8");
  const output = runConsumer(
    "binding.mjs",
    `import { readFileSync } from "node:fs";
import { executeThroughAdapter } from "approval-md/adapters";
const unit = JSON.parse(readFileSync(process.argv[2], "utf8"));
let acts = 0;
const adapter = {
  name: "consumer-broadcast",
  classes: [unit.class],
  act() { acts += 1; return { ok: true, detail: { sent: true } }; },
};
const request = (payload) => ({
  logPath: unit.logPath, actionKey: unit.actionKey, payload, actor: unit.actor,
});
const options = { token: unit.token, policy: { file: unit.policyPath } };
const mismatch = await executeThroughAdapter(adapter, request({ body: "tampered" }), options);
const completed = await executeThroughAdapter(adapter, request(unit.payload), options);
const replay = await executeThroughAdapter(adapter, request(unit.payload), options);
console.log(JSON.stringify({ mismatch, completed, replay, acts }));
`,
    [inputPath],
  );
  const result = JSON.parse(output) as {
    mismatch: { ok: boolean; code: string; acted: boolean };
    completed: { ok: boolean };
    replay: { ok: boolean; code: string };
    acts: number;
  };
  assert.deepEqual(
    { ok: result.mismatch.ok, code: result.mismatch.code, acted: result.mismatch.acted },
    { ok: false, code: "payload-mismatch", acted: false },
  );
  assert.equal(result.completed.ok, true);
  assert.equal(result.replay.ok, false);
  assert.match(result.replay.code, /^(token-consumed|already-executed)$/u);
  assert.equal(result.acts, 1);
});

test("a consumer runs public conformance against the packed contract", () => {
  const cases = Array.from({ length: 8 }, () => granted());
  const casesPath = join(consumerRoot, "conformance-cases.json");
  writeFileSync(casesPath, JSON.stringify(cases), "utf8");
  const output = runConsumer(
    "conformance.mjs",
    `import { readFileSync } from "node:fs";
import { runAdapterConformance } from "approval-md/adapters";
const cases = JSON.parse(readFileSync(process.argv[2], "utf8"));
const adapter = () => ({
  name: "consumer-broadcast",
  classes: ["public.post"],
  act(input) {
    const credential = input.credentials.get("consumer.secret");
    if (!credential.ok) return credential;
    return { ok: true, detail: { sent: true } };
  },
});
await runAdapterConformance(
  {},
  adapter,
  {
    setup() {
      const unit = cases.shift();
      if (unit === undefined) throw new Error("conformance requested too many cases");
      return {
        ...unit,
        options: { policy: { file: unit.policyPath } },
      };
    },
    credential: { name: "consumer.secret", value: "consumer-secret-40f74e" },
    foreignClass: "financial.spend",
  },
);
console.log("conformant");
`,
    [casesPath],
  );
  assert.equal(output, "conformant");
});
