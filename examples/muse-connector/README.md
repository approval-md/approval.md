# Local synthetic Muse facade

Start `approval muse --dir <tenant-store>` from an operator shell with `APPROVAL_MUSE_TENANT`, `APPROVAL_MUSE_READ_TOKEN`, and `APPROVAL_MUSE_PROPOSE_TOKEN` already exported. Use distinct random values for the two credentials. Run the separately configured `approval channel telegram listen` for actual human decisions.

The facade's five routes and expected JSON bodies are documented in [the connector packet](../../docs/muse-connector.md). To check negative controls, set `APPROVAL_MUSE_LOCAL_URL=http://127.0.0.1:4683` in that shell and run `node scripts/probes/muse-connector.mjs`. Its output is synthetic local evidence, not a native Muse test.
