/**
 * The policy-bound Codex workspace change broker (APRV-325.2).
 *
 * APRV-325.1 shipped preparation, APRV-325.2.1 shipped the read-only planner,
 * and this module is the thing both were for: the ONLY way a change reaches a
 * canonical workspace in a constrained Codex session. It is deliberately not a
 * mode of `src/mcp/server.ts`. That server publishes the whole agent verb
 * catalog, including `run`, and a broker that lived inside it would be one
 * unchecked flag away from the surface it exists to replace.
 *
 * ## What the caller may say, and what it may not
 *
 * A caller supplies exactly two things: a bounded list of typed operations, and
 * the SHA-256 it believes the policy currently has. Everything else — the
 * acting identity, the workspace root, the policy file, the log, the schema
 * directory, the classes, the reversibility, the sandbox posture — comes from
 * the installation manifest, which lives under a root-owned install root that
 * no agent principal can write (`codex/manifest.ts`, `codex/trust.ts`).
 * {@link parseBrokerInput} refuses an unknown key rather than ignoring it, so a
 * caller that tries to name its own actor is told no instead of being quietly
 * overridden, and {@link BROKER_TOOLS} is a POSITIVE allowlist of one: a name
 * not on it is refused whether or not any surface advertised it.
 *
 * ## One action per class, never collapsed
 *
 * The planner returns one action leg per distinct path class, and this module
 * registers, requests, starts and closes each of them separately. Collapsing
 * four classes into one "workspace write" would lose exactly what the policy
 * is for: the class is what the operator's roster, budget and autonomy are
 * keyed to, and an action that reports a cheaper class than it performs is the
 * self-reporting SPEC.md §11.1 invariant 4 forbids.
 *
 * ## The order, and why every step of it is load-bearing
 *
 * Read policy once and hash those exact bytes → check attestation against
 * VERIFIED records → refuse if the caller's expected digest differs → plan →
 * register the legs → authorize EVERY leg (policy, or a real grant token) →
 * start EVERY leg → take custody → revalidate the plan UNDER custody → commit
 * durably → read the workspace back → close every leg with what the reading
 * said.
 *
 * Two of those orderings are the hard-won ones from the 2026-09-09 handover.
 * **Every leg starts before any byte moves**, so a leg that refuses at start
 * leaves a workspace that is untouched by construction rather than by cleanup;
 * the already-started legs are closed `execution.failed` and the filesystem was
 * never entered. And **revalidation happens under custody**, after the last
 * start, because a revalidation that precedes the lock proves only what was
 * true before another writer could act.
 *
 * ## Outcomes are read, not remembered
 *
 * `codex/workspace-commit.ts` classifies the workspace by reading it back
 * against the journal. All-after closes every leg `execution.completed`;
 * all-before closes every leg `execution.failed`; anything else — a partial
 * apply, a failed rollback, an endpoint that could not be read — closes every
 * leg `execution.indeterminate` with reason `workspace-commit-unknown`, the
 * reason this task added to SPEC.md §8's closed set. Nothing here converts an
 * indeterminate outcome into either of the others; that stays human-owned
 * (`approval execution reconcile`).
 */

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import {
  attestationRefusal,
  checkAttestationOfBytes,
  policyBytesHash,
  unreadablePolicyStatus,
  type AttestationStatus,
} from "../core/attest.js";
import type { ClockOptions } from "../core/clock.js";
import {
  finishExecution,
  hasApprovalCycle,
  indeterminateExecution,
  startExecution,
  type ExecuteOptions,
} from "../core/execute.js";
import { register, registeredAction, request } from "../core/gate.js";
import type { AppendOptions, EventRecord } from "../core/log.js";
import { loadPolicy, type PolicyLoadResult } from "../core/policy-load.js";
import { readVerifiedRecords } from "../core/state.js";
import type { CodexInstanceManifest } from "./manifest.js";
import {
  acquireWorkspaceCustody,
  commitWorkspacePlan,
  touchedDirectories,
  WORKSPACE_LOCK_FILE,
  WORKSPACE_TXN_DIR,
  type CustodyReport,
  type WorkspaceState,
} from "./workspace-commit.js";
import {
  planWorkspaceProposal,
  revalidateWorkspacePlan,
  type WorkspacePlan,
  type WorkspacePlanContext,
} from "./workspace-plan.js";

export const BROKER_VERSION = "approval.codex.broker.v1" as const;

/**
 * The positive server-side tool allowlist: one name, and nothing is reachable
 * by any other.
 *
 * A deny list would have to name every verb the runtime grows next; this names
 * the one a constrained Codex session may call, so anything added tomorrow is
 * unreachable here until somebody decides otherwise. Fail closed, SPEC.md §11.
 */
export const BROKER_TOOLS: ReadonlySet<string> = new Set(["codex_workspace_apply"]);

/** The indeterminate reason a mixed or unreadable commit records (SPEC.md §8). */
export const WORKSPACE_COMMIT_UNKNOWN = "workspace-commit-unknown" as const;

// ---------------------------------------------------------------------------
// Installation-owned context
// ---------------------------------------------------------------------------

/**
 * Everything the broker is, derived from the manifest and from nothing a caller
 * said. Constructed by {@link brokerInstallation}; there is no other maker.
 */
export interface BrokerInstallation {
  instanceId: string;
  /** `agent:codex-<instance_id>`, fixed by the installation. */
  actor: string;
  /** The canonical workspace root, absolute and normalized. */
  root: string;
  policyPath: string;
  logPath: string;
}

/** Derive the fixed context from a validated instance manifest. */
export function brokerInstallation(manifest: CodexInstanceManifest): BrokerInstallation {
  return {
    instanceId: manifest.instance_id,
    actor: `agent:codex-${manifest.instance_id}`,
    root: manifest.paths.workspace,
    policyPath: manifest.paths.policy,
    logPath: manifest.paths.log,
  };
}

// ---------------------------------------------------------------------------
// Caller input
// ---------------------------------------------------------------------------

/** The whole of what a caller may say. */
export interface BrokerInput {
  operations: unknown;
  expected_policy_sha256: string;
}

const HEX64 = /^[0-9a-f]{64}$/u;

export type BrokerInputResult =
  | { ok: true; input: BrokerInput }
  | { ok: false; message: string };

/**
 * Accept `{operations, expected_policy_sha256}` and refuse everything else.
 *
 * An unknown key is a refusal rather than a silent drop for the reason the MCP
 * server refuses `--as`: a caller that named an actor, a root, a class or a
 * token meant something by it, and the something they meant is not available
 * here. Being told so is the only way they learn that.
 */
export function parseBrokerInput(value: unknown): BrokerInputResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, message: "the broker accepts one JSON object" };
  }
  const allowed = new Set(["operations", "expected_policy_sha256"]);
  for (const key of Object.keys(value)) {
    if (allowed.has(key)) continue;
    return {
      ok: false,
      message: `unknown property ${JSON.stringify(key)}: the broker accepts "operations" and "expected_policy_sha256" and nothing else. Identity, workspace root, policy, log, class and reversibility are the installation's and no caller input can change them`,
    };
  }
  const record = value as Record<string, unknown>;
  const digest = record["expected_policy_sha256"];
  if (typeof digest !== "string" || !HEX64.test(digest)) {
    return { ok: false, message: "expected_policy_sha256 must be a lowercase SHA-256 hex digest" };
  }
  if (!("operations" in record)) {
    return { ok: false, message: "operations is required" };
  }
  return { ok: true, input: { operations: record["operations"], expected_policy_sha256: digest } };
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * Every way the broker can say no. Frozen public API in the sense SPEC.md
 * §11.1 invariant 6 means: each fires for exactly one condition, they are
 * distinct from one another, and `tests/codex-broker.test.ts` pins the union.
 */
export const BROKER_REFUSAL_CODES = [
  /** The tool name is not on {@link BROKER_TOOLS}. */
  "tool-not-allowed",
  /** The caller's object is not `{operations, expected_policy_sha256}`. */
  "input-invalid",
  /** The workspace root is not an absolute normalized path. */
  "installation-invalid",
  /** The log could not be read, is torn, or does not verify. */
  "log-unavailable",
  /** The policy file could not be read or parsed. */
  "policy-unavailable",
  /** The live policy bytes are not the attested ones. */
  "policy-not-attested",
  /** The caller's expected digest is not the live attested digest. */
  "attestation-drift",
  /** An endpoint names the broker's own reserved transaction paths. */
  "reserved-path",
  /** A replace whose after-image equals its preimage: nothing to approve. */
  "no-op-operation",
  /** The planner refused. `detail` carries its own code verbatim. */
  "plan-refused",
  /** The log already declares this task or key under different bytes. */
  "replay",
  /** Registration refused for any other gate reason. */
  "register-refused",
  /** Intake refused for any gate reason. */
  "request-refused",
  /** A leg needs a human's grant and no token for it was presented. */
  "approval-required",
  /** A leg's `execution.started` refused. Nothing was written to the workspace. */
  "start-refused",
  /** Another transaction holds the workspace lock. */
  "custody-contended",
  /** The lock or staging directory could not be created. */
  "custody-unavailable",
  /** The installation requires OS-exclusive custody and the host cannot prove it. */
  "custody-insufficient",
  /** The plan no longer validates against the workspace under custody. */
  "workspace-drift",
  /** Staging failed; the workspace is untouched by construction. */
  "stage-failed",
  /** The commit was attempted and did not take. Every leg is `execution.failed`. */
  "commit-not-applied",
  /** The commit was attempted and nobody knows. Every leg is indeterminate. */
  "commit-unknown",
] as const;

export type BrokerRefusalCode = (typeof BROKER_REFUSAL_CODES)[number];

export interface BrokerRefusal {
  ok: false;
  code: BrokerRefusalCode;
  message: string;
  /** The underlying layer's own code, when this refusal wraps one. */
  detail?: string;
  /** The action keys a human must decide, when `code` is `approval-required`. */
  pending?: readonly string[];
  /** Present once a commit was attempted: what reading the workspace proved. */
  state?: WorkspaceState;
}

function refuse(
  code: BrokerRefusalCode,
  message: string,
  extra: Omit<BrokerRefusal, "ok" | "code" | "message"> = {},
): BrokerRefusal {
  return { ok: false, code, message, ...extra };
}

// ---------------------------------------------------------------------------
// Options and success
// ---------------------------------------------------------------------------

export interface BrokerOptions extends ClockOptions {
  /**
   * Grant tokens, keyed by CLASS, for the legs whose policy resolves manual.
   *
   * Keyed by class rather than by action key because the class is the thing a
   * human decided about and the key is derived; a caller cannot use this map to
   * reach a leg it did not register, because every key is recomputed here.
   */
  tokens?: Readonly<Record<string, string>>;
  /**
   * Refuse unless the host proves OS-exclusive write custody (APRV-325.3 sets
   * it). Absent, the broker still REPORTS which custody it got: the claim never
   * silently softens, only the refusal is optional.
   */
  requireExclusiveCustody?: boolean;
  schemaDir?: string;
  append?: AppendOptions;
  /** Forwarded verbatim to the commit's test seam. See `CommitOptions.onStep`. */
  onStep?: (step: number) => void;
  /** Test seam: called once after the last start and before custody is taken. */
  afterStart?: () => void;
}

/** One class's leg through the gate. */
export interface BrokerLeg {
  class: string;
  actionKey: string;
  /** How it was authorized: `policy` (no token exists) or `token` (a real grant). */
  mode: "policy" | "token";
}

export interface BrokerSuccess {
  ok: true;
  version: typeof BROKER_VERSION;
  task: string;
  payload_hash: string;
  policy_sha256: string;
  legs: readonly BrokerLeg[];
  custody: CustodyReport;
  /** Always `"after"`: a success is a workspace that was read back as applied. */
  state: "after";
}

export type BrokerResult = BrokerSuccess | BrokerRefusal;

// ---------------------------------------------------------------------------
// Intake helpers
// ---------------------------------------------------------------------------

function readPolicy(policyPath: string):
  | { ok: true; bytes: Uint8Array; sha256: string; policy: PolicyLoadResult }
  | { ok: false; status: AttestationStatus } {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(policyPath);
  } catch (cause) {
    return {
      ok: false,
      status: unreadablePolicyStatus(policyPath, cause instanceof Error ? cause.message : String(cause)),
    };
  }
  return { ok: true, bytes, sha256: policyBytesHash(bytes), policy: loadPolicy({ file: policyPath }) };
}

/** The task id one proposal's bytes always produce. Deterministic, so a replay collides. */
export function brokerTaskId(instanceId: string, payloadHash: string): string {
  return `codex-workspace-${instanceId}-${payloadHash.slice(0, 16)}`;
}

/** The action key one class's leg always produces under that task. */
export function brokerActionKey(task: string, cls: string): string {
  return `${task}:${cls}`;
}

/**
 * Endpoints the broker owns and no proposal may name.
 *
 * The staging directory has to share a filesystem with the workspace for
 * `rename` to be atomic, so it lives inside it. Reserving both names is what
 * stops a proposal from writing its own journal or unlocking its own lock, and
 * it is checked here rather than in the planner because the planner has no idea
 * a transaction exists.
 */
function reservedEndpoint(path: string): boolean {
  const first = path.split("/")[0];
  return first === WORKSPACE_TXN_DIR || first === WORKSPACE_LOCK_FILE;
}

/**
 * The first reserved endpoint named anywhere in the RAW operations, or null.
 *
 * Over the unvalidated input on purpose, so the refusal precedes the planner's
 * preimage read: the planner has no idea a transaction exists and would happily
 * bind the bytes of the broker's own journal before anything here objected.
 * Only the three path-valued fields of the closed operation language are read,
 * and anything that is not a string is left to the planner to refuse.
 */
function reservedInRawOperations(operations: unknown): string | null {
  if (!Array.isArray(operations)) return null;
  for (const entry of operations) {
    if (typeof entry !== "object" || entry === null) continue;
    for (const field of ["path", "from", "to"]) {
      const value = (entry as Record<string, unknown>)[field];
      if (typeof value === "string" && reservedEndpoint(value)) return value;
    }
  }
  return null;
}

/**
 * Does the log's latest cycle for `actionKey` end in a grant nobody has
 * revoked?
 *
 * A HINT and never an authorization: it decides only whether the broker refuses
 * early with the keys a person must decide, or lets `core/execute.ts` ask the
 * real question (is this token the granted one, is its TTL alive, was it
 * spent). Nothing here is compared against a secret and nothing here admits an
 * execution.
 */
function grantOpen(records: readonly EventRecord[], actionKey: string): boolean {
  let granted = false;
  for (const record of records) {
    if (record.action_key !== actionKey) continue;
    if (record.event === "approval.granted") granted = true;
    else if (
      record.event === "approval.rejected" ||
      record.event === "approval.revoked" ||
      record.event === "approval.expired" ||
      record.event === "approval.withdrawn" ||
      record.event === "approval.requested"
    ) granted = false;
  }
  return granted;
}

function legsOf(plan: WorkspacePlan, task: string): BrokerLeg[] {
  return plan.actions.map((action) => ({
    class: action.class,
    actionKey: brokerActionKey(task, action.class),
    mode: "policy" as const,
  }));
}

function envelopeFor(
  actor: string,
  legs: readonly BrokerLeg[],
  plan: WorkspacePlan,
): Record<string, unknown> {
  return {
    origin: { app: "approval-codex-broker", created_by: actor },
    state: "proposed",
    actions: legs.map((leg) => ({
      class: leg.class,
      summary: `Codex workspace change (${leg.class}): ${String(plan.payload.operations.length)} bounded operations`,
      reversible: false,
      est_cost_usd: "0",
      idempotency_key: leg.actionKey,
      payload_hash: plan.payload_hash,
    })),
  };
}

function executeOptionsFor(
  installation: BrokerInstallation,
  options: BrokerOptions,
  payloadHash: string,
  token?: string,
): ExecuteOptions {
  const base: ExecuteOptions = {
    policy: { file: installation.policyPath },
    presentedPayloadHash: payloadHash,
  };
  if (options.clock !== undefined) base.clock = options.clock;
  if (options.schemaDir !== undefined) base.schemaDir = options.schemaDir;
  if (options.append !== undefined) base.append = options.append;
  if (token !== undefined) base.token = token;
  return base;
}

// ---------------------------------------------------------------------------
// The broker
// ---------------------------------------------------------------------------

/**
 * Apply one bounded typed proposal to the canonical workspace, or say exactly
 * why not.
 *
 * `tool` is checked against {@link BROKER_TOOLS} first, before the input is
 * even parsed: a surface that published nothing still refuses a name it does
 * not serve, which is the defence in depth `src/mcp/server.ts` keeps for
 * `mcp-guest-restricted`.
 */
export function applyWorkspaceChange(
  tool: string,
  installation: BrokerInstallation,
  rawInput: unknown,
  options: BrokerOptions = {},
): BrokerResult {
  if (!BROKER_TOOLS.has(tool)) {
    return refuse(
      "tool-not-allowed",
      `${JSON.stringify(tool)} is not a broker tool; this surface serves exactly ${[...BROKER_TOOLS].join(", ")}`,
    );
  }
  const parsed = parseBrokerInput(rawInput);
  if (!parsed.ok) return refuse("input-invalid", parsed.message);
  if (!isAbsolute(installation.root) || resolve(installation.root) !== installation.root) {
    return refuse("installation-invalid", "the installation's workspace root is not a normalized absolute path");
  }

  // --- Verified log, attested policy, and the caller's expectation of it ---
  const read = readVerifiedRecords(
    installation.logPath,
    options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir },
  );
  if (!read.ok) return refuse("log-unavailable", read.message, { detail: read.code });
  const records: EventRecord[] = read.records;

  const policy = readPolicy(installation.policyPath);
  if (!policy.ok) {
    const attestation = attestationRefusal(policy.status);
    return refuse("policy-unavailable", attestation?.message ?? "policy could not be read");
  }
  const status = checkAttestationOfBytes(records, policy.bytes);
  const attestation = attestationRefusal(status);
  if (attestation !== null) {
    return refuse("policy-not-attested", attestation.message, { detail: attestation.detail });
  }
  if (parsed.input.expected_policy_sha256 !== policy.sha256) {
    return refuse(
      "attestation-drift",
      `the proposal expects policy ${parsed.input.expected_policy_sha256} and the attested policy is ${policy.sha256}; re-read the policy and rebuild the proposal`,
    );
  }
  if (!policy.policy.ok) {
    return refuse("policy-unavailable", `policy ${installation.policyPath} did not parse: ${policy.policy.message}`);
  }

  // --- Plan (the merged read-only intake does the path work) --------------
  const context: WorkspacePlanContext = {
    actor: installation.actor,
    root: installation.root,
    policy_sha256: policy.sha256,
    policy: policy.policy,
  };
  // Before the planner, because the planner would read the preimage of an
  // endpoint it has no reason to think is special. The scan is over the raw
  // input's own path fields and errs toward refusing.
  const reserved = reservedInRawOperations(parsed.input.operations);
  if (reserved !== null) {
    return refuse(
      "reserved-path",
      `${reserved} is inside the broker's own transaction custody (${WORKSPACE_TXN_DIR}, ${WORKSPACE_LOCK_FILE}) and is never a proposal endpoint`,
    );
  }

  const planned = planWorkspaceProposal(parsed.input.operations, context);
  if (!planned.ok) {
    return refuse(
      "plan-refused",
      `${planned.code}: ${planned.message}`,
      { detail: planned.code },
    );
  }
  const plan = planned.plan;

  for (const operation of plan.payload.operations) {
    if (operation.kind !== "replace" || operation.before.sha256 !== operation.after.sha256) continue;
    return refuse(
      "no-op-operation",
      `${operation.path} replaces its own bytes; a change with no effect has no outcome to report honestly`,
    );
  }

  const task = brokerTaskId(installation.instanceId, plan.payload_hash);
  const legs = legsOf(plan, task);

  // --- Register: one declared action per class, all bound to one payload ---
  const registration = register(
    installation.logPath,
    { task, envelope: envelopeFor(installation.actor, legs, plan) },
    installation.actor,
    {
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir }),
      ...(options.append === undefined ? {} : { append: options.append }),
    },
  );
  if (!registration.ok) {
    if (registration.code !== "task-already-registered") {
      return refuse("register-refused", registration.message, { detail: registration.code });
    }
    // The same bytes produce the same task id, so a second apply of an
    // identical proposal lands here. It is legitimate only when the log's own
    // declaration is byte-for-byte the one we just derived; anything else is a
    // key this installation does not own and nothing may execute from it.
    for (const leg of legs) {
      const declared = registeredAction(records, task, leg.actionKey);
      if (!declared.ok || declared.action.class !== leg.class || declared.action.payload_hash !== plan.payload_hash) {
        return refuse(
          "replay",
          `${task} is already registered under different bytes or classes; this proposal cannot reuse it`,
          { detail: registration.code },
        );
      }
    }
  }

  // --- Authorize every leg BEFORE any start and before any mutation -------
  const pending: string[] = [];
  for (const leg of legs) {
    if (hasApprovalCycle(records, leg.actionKey)) {
      // Already asked. Re-requesting would open a second cycle for one
      // decision, so the token (or its absence) settles this leg.
      leg.mode = "token";
      continue;
    }
    const intake = request(
      installation.logPath,
      {
        task,
        actionKey: leg.actionKey,
        cls: leg.class,
        est_cost_usd: "0",
        reversible: false,
        summary: `Codex workspace change (${leg.class})`,
        payload_hash: plan.payload_hash,
        payload: { value: plan.payload },
      },
      installation.actor,
      {
        policy: { file: installation.policyPath },
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        ...(options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir }),
        ...(options.append === undefined ? {} : { append: options.append }),
      },
    );
    if (!intake.ok) {
      return refuse("request-refused", intake.message, { detail: intake.code });
    }
    leg.mode = intake.proceed ? "policy" : "token";
  }
  const tokens = options.tokens ?? {};
  const afterIntake = readVerifiedRecords(
    installation.logPath,
    options.schemaDir === undefined ? {} : { schemaDir: options.schemaDir },
  );
  if (!afterIntake.ok) return refuse("log-unavailable", afterIntake.message, { detail: afterIntake.code });
  for (const leg of legs) {
    if (leg.mode !== "token") continue;
    if (typeof tokens[leg.class] === "string") continue;
    // No token in hand is not the same as no authority. Sealed delivery
    // (SPEC.md §10.4) puts the grant's token beside the log for the requester
    // that asked, and `startExecution` opens it itself; the broker's job is
    // only to tell a caller with NO grant what is waiting for a person. This
    // check reduces no scrutiny: the grant is still verified where it always
    // was, against the log's digest, and a leg that reaches `startExecution`
    // with nothing to open is refused there.
    if (grantOpen(afterIntake.records, leg.actionKey)) continue;
    pending.push(leg.actionKey);
  }
  if (pending.length > 0) {
    return refuse(
      "approval-required",
      `${String(pending.length)} action(s) resolve to a human decision and no grant token was presented for them. Nothing was written`,
      { pending },
    );
  }

  // --- Start every leg. A later refusal must mean no filesystem effect. ---
  const started: BrokerLeg[] = [];
  for (const leg of legs) {
    const execOptions = executeOptionsFor(
      installation,
      options,
      plan.payload_hash,
      leg.mode === "token" ? tokens[leg.class] : undefined,
    );
    const start = startExecution(installation.logPath, leg.actionKey, execOptions, installation.actor);
    if (start.ok) {
      started.push(leg);
      continue;
    }
    closeLegs(installation, options, plan, started, "failed", {
      code: "leg-start-refused",
      message: `a later action leg refused to start (${start.code}); no workspace operation was attempted`,
    });
    return refuse(
      "start-refused",
      `${leg.actionKey} could not start: ${start.message}. No workspace operation was attempted`,
      { detail: start.code },
    );
  }
  options.afterStart?.();

  // --- Custody, then revalidation UNDER it, then the durable commit -------
  const directories = touchedDirectories(plan);
  const acquired = acquireWorkspaceCustody(installation.root, directories);
  if (!acquired.ok) {
    closeLegs(installation, options, plan, started, "failed", {
      code: acquired.code,
      message: "workspace custody was not obtained; no operation was attempted",
    });
    return refuse(acquired.code, acquired.message);
  }
  const custody = acquired.custody;
  // A mixed commit leaves its journal inside the staging directory for a
  // person, and `release` removes that directory. This is the one flag that
  // decides between the two, and it is set only where the readback said mixed.
  let keepStaging = false;

  try {
    if (options.requireExclusiveCustody === true && custody.report.kind !== "os-exclusive") {
      closeLegs(installation, options, plan, started, "failed", {
        code: "custody-insufficient",
        message: "this installation requires OS-exclusive workspace custody",
      });
      return refuse(
        "custody-insufficient",
        `this installation requires OS-exclusive workspace custody and the host proved only ${custody.report.kind} (${custody.report.findings.join(", ")})`,
      );
    }

    const revalidated = revalidateWorkspacePlan(plan, context);
    if (!revalidated.ok) {
      closeLegs(installation, options, plan, started, "failed", {
        code: revalidated.code,
        message: "the workspace no longer matched the approved snapshot; no operation was attempted",
      });
      return refuse("workspace-drift", revalidated.message, { detail: revalidated.code });
    }

    const commit = commitWorkspacePlan(
      plan,
      custody,
      options.onStep === undefined ? {} : { onStep: options.onStep },
    );
    if (!commit.ok) {
      closeLegs(installation, options, plan, started, "failed", {
        code: commit.code,
        message: "staging failed before any mutation; the workspace is unchanged",
      });
      return refuse("stage-failed", commit.message, { state: "before" });
    }

    const { state, failure } = commit.outcome;
    if (state === "after") {
      closeLegs(installation, options, plan, started, "completed");
      return {
        ok: true,
        version: BROKER_VERSION,
        task,
        payload_hash: plan.payload_hash,
        policy_sha256: policy.sha256,
        legs: started,
        custody: custody.report,
        state: "after",
      };
    }
    if (state === "before") {
      closeLegs(installation, options, plan, started, "failed", {
        code: "workspace-commit-reverted",
        message: "the commit did not take and the workspace was read back as unchanged",
      });
      return refuse(
        "commit-not-applied",
        `the workspace was read back as unchanged${failure === undefined ? "" : `: ${failure}`}`,
        { state },
      );
    }
    keepStaging = commit.outcome.journalRetained;
    closeLegs(installation, options, plan, started, "indeterminate");
    return refuse(
      "commit-unknown",
      `the workspace read back as neither the approved before-state nor the approved after-state${failure === undefined ? "" : `: ${failure}`}. The transaction journal and the workspace lock were retained, so no further brokered change can run until a person reads the journal and clears them; nothing here resolves it`,
      { state },
    );
  } finally {
    if (!keepStaging) custody.release();
  }
}

/**
 * Close every started leg with the outcome the workspace readback established.
 *
 * Best effort per leg and never a throw: a leg whose close cannot be appended
 * leaves a DANGLING execution, which is the honest state for it (SPEC.md §8),
 * and failing to close the second leg must not stop the third from being told
 * the truth.
 */
function closeLegs(
  installation: BrokerInstallation,
  options: BrokerOptions,
  plan: WorkspacePlan,
  legs: readonly BrokerLeg[],
  outcome: "completed" | "failed" | "indeterminate",
  reason?: { code: string; message: string },
): void {
  for (const leg of legs) {
    const base = executeOptionsFor(installation, options, plan.payload_hash);
    if (outcome === "indeterminate") {
      indeterminateExecution(
        installation.logPath,
        leg.actionKey,
        WORKSPACE_COMMIT_UNKNOWN,
        installation.actor,
        base,
      );
      continue;
    }
    finishExecution(
      installation.logPath,
      leg.actionKey,
      outcome === "completed" ? 0 : 1,
      installation.actor,
      outcome === "completed" ? base : { ...base, ...(reason === undefined ? {} : { reason }) },
    );
  }
}
