# Adapter API

`approval-md/adapters` is the supported ESM API for building an adapter that
executes through approval.md's token, payload-binding, event-log, credential
window, and redaction sequence. It is available from source checkouts that
include this document and from the next package release after 0.1.0. This task
does not publish a package.

The package requires Node.js 20 or newer. TypeScript consumers should include
`@types/node` in their development dependencies because the public contract
uses Node platform types such as `NodeJS.ProcessEnv` and `AbortSignal`.

```ts
import {
  executeThroughAdapter,
  type ActInput,
  type Adapter,
  type AdapterExecuteRequest,
  type AdapterExecuteOptions,
} from "approval-md/adapters";

const adapter: Adapter = {
  name: "broadcast",
  classes: ["public.post"],
  requiredCredentials: ["broadcast.stream_key"],
  async act(input: ActInput) {
    const key = input.credentials.get("broadcast.stream_key");
    if (!key.ok) return key;

    // Send input.payload through the provider here. Keep the credential inside
    // this call and return the provider's stable identifier when it has one.
    return { ok: true, detail: { provider_ref: "broadcast-event-id" } };
  },
};

export async function execute(
  request: AdapterExecuteRequest,
  options: AdapterExecuteOptions,
) {
  return executeThroughAdapter(adapter, request, options);
}
```

The runtime owns the required order. It recomputes the payload hash and checks
the effective policy. Where the gate requires a grant (including selected live
supervision), it verifies and consumes the token; otherwise the policy authorizes
execution without one. Every
admitted path appends `execution.started` before it opens the credential window
and calls `act`, then redacts the result and appends the outcome. Calling
`adapter.act` directly bypasses that sequence and is unsupported.

The public runtime exports are:

- `executeThroughAdapter`
- `runAdapterConformance`
- `vaultCredentialProvider`
- `ADAPTER_REFUSAL_CODES`
- `CREDENTIAL_REFUSAL_CODES`

The same subpath exports the TypeScript types needed to implement the contract,
its optional precheck, the conformance harness, a credential provider, a vault
provider, and a `CredentialSpec` manifest. Other package files are internal.
The package does not export its adapter registry, built-in adapters, gate, log,
token implementation, or `dist/src` paths.

## Conformance

Run `runAdapterConformance` against a fresh real grant for each harness setup.
The suite checks the binding and ordering guarantees, single use, credential
scope, redaction, failure recording, and the optional read-only observation
path. Passing it proves the adapter uses the shared contract under the tested
fixture. It does not prove the provider granted the intended permissions or
that the calling agent lacks another copy of the credential.

## Vault provider

`vaultCredentialProvider` adapts approval.md's encrypted vault to the public
`CredentialProvider` seam. Construct it with either the vault path or the
instance log path, plus the policy-selected passphrase environment-variable
name. The provider yields credentials only while the shared contract holds its
window open. Keep the passphrase and provider credentials outside agent-owned
configuration and output.

## Migration from deep imports

The 0.1.0 package had no exports map. Consumers could reach files such as:

```text
approval-md/dist/src/adapters/contract.js
approval-md/dist/src/adapters/conformance.js
approval-md/dist/src/adapters/vault-provider.js
```

Those paths were incidental and carried no declaration files or compatibility
promise. Replace all three with `approval-md/adapters`. The new exports map
rejects deep package paths so internal changes do not silently become public
API changes. This is a breaking change for consumers of the incidental paths
and belongs in a minor release while the package major version is zero.

The public names and their TypeScript shapes follow semantic versioning from
the first release that includes them. A patch release preserves them. A change
that removes or incompatibly narrows one requires the next breaking version.

The CLI still discovers adapters from its compiled registry. Package-level
registration for third-party adapters is separate future work; this API lets an
embedding application execute its adapter through the same gate today.
