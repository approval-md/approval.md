# Approval Policy

Two machine-readable blocks. SPEC.md §5 allows exactly one, so this fails
closed: `multiple-blocks`. Merging them would mean guessing which one the
author meant to be in force.

```yaml approval-policy
version: "0.1"
defaults:
  autonomy: manual
```

Some prose in between.

```yaml approval-policy
version: "0.1"
defaults:
  autonomy: autonomous
```
