# A pair whose first half is fine and whose second is stale

The order matters: the applier must write NOTHING, not the first pair.

## 1. This one would apply

Current:

```yaml
  network.call:              { autonomy: supervised }
```

Replace with:

```yaml
  network.call:              { autonomy: manual }
```

## 2. This one quotes a line nobody has

Current:

```yaml
  financial.spend:           { autonomy: supervised }
```

Replace with:

```yaml
  financial.spend:           { autonomy: manual }
```
