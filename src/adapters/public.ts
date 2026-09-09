/**
 * The supported adapter-author API.
 *
 * Keep this barrel deliberately small. Every name exported here is a package
 * compatibility commitment; the surrounding adapter and core modules remain
 * implementation details.
 */

export {
  ADAPTER_REFUSAL_CODES,
  CREDENTIAL_REFUSAL_CODES,
  executeThroughAdapter,
  type ActInput,
  type ActOutcome,
  type Adapter,
  type AdapterExecuteOptions,
  type AdapterExecuteRequest,
  type AdapterExecuteResult,
  type AdapterExecuteSuccess,
  type AdapterRefusal,
  type AdapterRefusalCode,
  type CredentialProvider,
  type CredentialRefusalCode,
  type CredentialResult,
  type ExecutionGrant,
  type JsonValue,
  type PrecheckInput,
  type PrecheckOutcome,
} from "./contract.js";

export {
  runAdapterConformance,
  type AdapterConformanceCase,
  type AdapterConformanceHarness,
  type ConformanceContext,
} from "./conformance.js";

export {
  vaultCredentialProvider,
  type VaultLocation,
  type VaultProviderOptions,
} from "./vault-provider.js";

export type { CredentialKind, CredentialSpec } from "../core/credential-spec.js";
