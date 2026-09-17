# A later section that rewrites a line an earlier section already rewrote

## 1. Fix the comment

Current:

```yaml
  network.call:              { autonomy: supervised }   # stale comment
```

Replace with:

```yaml
  network.call:              { autonomy: supervised }   # corrected comment
```

## 2. And then the autonomy, on the corrected line

Section 1's line, which this supersedes:

```yaml
  network.call:              { autonomy: supervised }   # corrected comment
```

Current:

```yaml
  network.call:              { autonomy: supervised }   # stale comment
```

Replace with:

```yaml
  network.call:              { autonomy: manual }   # corrected comment
```
