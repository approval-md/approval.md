# Approval Policy

Well-formed YAML, invalid policy: `autonomy: yolo` is not one of the three
levels the closed enum in `policy.schema.json` admits. An unrecognised
autonomy level cannot be ordered against the others, so the whole policy
fails closed: `schema-invalid`.

```yaml approval-policy
version: "0.1"

defaults:
  autonomy: manual

classes:
  financial.spend: { autonomy: yolo }
```
