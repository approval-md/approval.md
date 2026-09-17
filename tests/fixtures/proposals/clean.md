# Two ordinary pairs

A proposal page is prose for the human with the pairs embedded in it. This
paragraph is read by nobody but you.

## 1. Tighten `network.call`

Current:

```yaml
  network.call:              { autonomy: supervised }
```

Replace with:

```yaml
  network.call:              { autonomy: manual }
```

## 2. And the comment above it

Before you run this, check the daemon is up:

```bash
approval doctor
```

That block has no label, so the applier skips it: a proposal page carries the
commands that go with it without them becoming policy text.

Current:

```yaml
  # classes
```

Replace with:

```yaml
  # classes (amended by the clean fixture)
```
