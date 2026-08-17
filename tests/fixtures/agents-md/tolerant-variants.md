# Example Project

Synthetic fixture (APRV-64), written for this test and copied from nothing.

It exercises, in one file, every branch the importer has that the verbatim
CLAUDE.md fixture does not: the tolerant heading variants ("Allowed",
"Requires approval", "Prohibited" rather than the canonical phrases), a nested
non-canonical heading inside the permissions region, a bullet no keyword places,
and one class claimed by two sections with opposite autonomy.

## Tooling

Not a permissions heading, so nothing under it is read.

- This bullet is outside every section and must not reach the draft.

```markdown
### Allowed
- A bullet inside a fenced block is an example, not a permission.
```

## Agent Permissions

### Allowed
- Read the docs directory and search the codebase
- Delete scratch files under /tmp

#### House style
- Prefer commas to em dashes.

### Requires approval
- Deleting anything under data/
- Any outbound webhook

### Prohibited
- Touch the deployment vault
- Feed the plants on the third floor

## Contact

- Also outside the permissions region, and also not read.
