# Approval Policy

Well-formed YAML, invalid policy: `read_proof: incrementel` is not one of the
two proofs the closed enum in `policy.schema.json` admits. The author believed
they had configured the reader and the runtime would have understood nothing,
so the whole policy fails closed (`schema-invalid`) and every class is
`manual` — the same treatment any misspelt key gets.

```yaml approval-policy
version: "0.1"

defaults:
  autonomy: manual

daemon:
  read_proof: incrementel
```
