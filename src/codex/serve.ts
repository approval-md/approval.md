/**
 * The strict Codex broker server (APRV-325.2): one tool, and nothing else.
 *
 * This is deliberately NOT `src/mcp/server.ts` with a flag. That server
 * publishes the whole agent verb catalog — `run` spawns argv on the host,
 * `adapter <name>` spends vault credentials, `journal write` writes a local
 * file — and its tool list is derived from the verb registry, so a verb added
 * tomorrow appears on it. A constrained Codex session is the case where that
 * derivation is exactly wrong: the session must reach ONE door, the door must
 * be the same door next month, and the way to guarantee that is a server whose
 * catalog is a literal of length one.
 *
 * Everything else follows from the same reasoning:
 *
 * - **The catalog is a literal.** {@link BROKER_TOOLS} is checked at CALL time
 *   as well as at list time, so a client that crafted the name itself is
 *   refused by the same check that filtered the list (the defence in depth
 *   `mcp-guest-restricted` keeps on the broad server).
 * - **The input schema has no authority in it.** `operations` and
 *   `expected_policy_sha256`, `additionalProperties: false`, and the broker
 *   refuses an unknown key a second time. There is no `--as`, no path, no
 *   class, no token and no sandbox flag to remove, because none was ever
 *   published.
 * - **Identity and every path come from the manifest**, which lives under a
 *   root-owned install root. The operator who installed it chose them; this
 *   process cannot be argued into different ones.
 * - **A refusal is a RESULT, not a JSON-RPC error**, for the reason the broad
 *   server gives: the call was well formed and the runtime's answer was no,
 *   which the caller has to be able to read as data and branch on.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { SPEC_VERSION } from "../core/version.js";
import {
  applyWorkspaceChange,
  BROKER_TOOLS,
  type BrokerInstallation,
  type BrokerOptions,
} from "./broker.js";

export const BROKER_TOOL_NAME = "codex_workspace_apply" as const;

/** The whole published contract of this server. */
export const BROKER_TOOL: Tool = {
  name: BROKER_TOOL_NAME,
  title: "apply a bounded workspace change through the approval gate",
  description:
    "Apply a bounded, typed change to the canonical workspace through approval.md's gate. Every operation is create, replace, delete or move on a relative path inside the workspace; `replace`, `delete` and `move` state the SHA-256 of the bytes they expect to find and are refused if the workspace has moved on. `expected_policy_sha256` is the digest of the policy you read, and a proposal built against a different one is refused rather than silently re-evaluated. The acting identity, the workspace root, the policy, the log and every class are the installation's and cannot be named here. A class the policy resolves to a human decision is refused with `approval-required` and the action keys a person must grant; ask again once they have. Nothing partially applies: either the whole proposal took, or it did not, or the answer is honestly unknown and a person owns it.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["operations", "expected_policy_sha256"],
    properties: {
      operations: {
        type: "array",
        minItems: 1,
        maxItems: 64,
        description:
          "The bounded closed change language. `{kind:\"create\", path, after_base64}`, `{kind:\"replace\", path, expected_before_sha256, after_base64}`, `{kind:\"delete\", path, expected_before_sha256}`, `{kind:\"move\", from, to, expected_before_sha256}`. Paths are relative NFC POSIX paths inside the workspace; images are canonical base64, at most 1 MiB each and 8 MiB combined.",
        items: { type: "object" },
      },
      expected_policy_sha256: {
        type: "string",
        pattern: "^[0-9a-f]{64}$",
        description:
          "SHA-256 of the exact APPROVAL.md bytes this proposal was built against. A mismatch refuses `attestation-drift`.",
      },
    },
  } as Tool["inputSchema"],
};

export interface BrokerServerOptions {
  installation: BrokerInstallation;
  /** Forwarded to the broker. `tokens` is deliberately absent: see below. */
  broker?: Omit<BrokerOptions, "tokens">;
}

export const BROKER_INSTRUCTIONS =
  "This server is the ONLY way a change reaches the canonical workspace in this session. It publishes exactly one tool, `codex_workspace_apply`, and no other name is callable whether or not something advertised it. You cannot name the acting identity, the workspace root, the policy file, the log, an action class, a reversibility, a grant token or a sandbox posture: all of those belong to the installation an operator owns, and a call that mentions one is refused rather than quietly overridden. Read the policy, hash its exact bytes, and send that digest as `expected_policy_sha256`; if it has changed since, you are told so instead of being evaluated against something you did not read. Every proposal is all-or-nothing: the operations are staged, journaled and applied under a workspace lock, and the outcome you are given is what reading the workspace back proved, not what this process believes it did. When the policy sends a class to a human, the refusal names the action keys awaiting a decision; call again with the same bytes once they have decided, and the same call will apply. Shell, network and credentials are not here and are not coming: this door is for workspace changes.";

/**
 * Build the strict server. Nothing is connected until `Server.connect`.
 *
 * `tokens` is omitted from what a caller of this constructor may forward for
 * the same reason `--as` is absent from the published schema: a raw grant token
 * is spend material, and a server process holding one for every class would be
 * a server that executes a human's decision without the human. The manual path
 * works through sealed delivery instead — the human grants, the token is sealed
 * to the key the request minted, and `core/execute.ts` opens it at the start.
 */
export function createCodexBrokerServer(options: BrokerServerOptions): Server {
  const server = new Server(
    { name: "approval-md-codex-broker", version: SPEC_VERSION },
    { capabilities: { tools: {} }, instructions: BROKER_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [BROKER_TOOL] }));

  server.setRequestHandler(CallToolRequestSchema, (request): CallToolResult => {
    const name = request.params.name;
    if (!BROKER_TOOLS.has(name)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `unknown tool ${JSON.stringify(name)}: this server publishes exactly ${[...BROKER_TOOLS].join(", ")}. Shell, network, credential and gate-authority verbs are not withheld here, they are absent`,
      );
    }
    const result = applyWorkspaceChange(
      name,
      options.installation,
      request.params.arguments,
      options.broker ?? {},
    );
    const payload: Record<string, unknown> = result.ok
      ? { ...result }
      : { error: { code: result.code, message: result.message, ...(result.detail === undefined ? {} : { detail: result.detail }), ...(result.pending === undefined ? {} : { pending: result.pending }), ...(result.state === undefined ? {} : { state: result.state }) } };
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      ...(result.ok ? {} : { isError: true }),
    };
  });

  return server;
}

/** Build the strict server and connect it. Resolves once connected. */
export async function serveCodexBroker(
  options: BrokerServerOptions,
  transport: Transport,
): Promise<Server> {
  const server = createCodexBrokerServer(options);
  await server.connect(transport);
  return server;
}
