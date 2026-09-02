# Approval Policy

A policy that configures the long-lived readers' prefix proof (APRV-217). The
`daemon` block is latency only: it names which proof a repeat read runs over a
prefix it already verified, and how often the whole prefix is re-proved
regardless. Nothing here reaches a verdict, a class, or an autonomy level.

```yaml approval-policy
version: "0.1"

defaults:
  autonomy: manual

daemon:
  read_proof: incremental
  full_reproof_every: 20
  full_reproof_after: "30s"
```
