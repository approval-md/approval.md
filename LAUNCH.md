# LAUNCH — open threads

A running document of threads that outlive any one session. Future sessions
update it as tasks close: mark threads done with a pointer to the task or
commit, add new threads as they appear, and keep entries to a few lines.
Seeded at the close of the founding session (2026-08-05).

## Engineering

- **Conformance suite extraction.** The fixture suite defines conformance for
  alternative implementations (SPEC section 13 names it as the boundary for
  the Rust fast-path). Extract it into a runner any implementation can point
  at its own binary, so conformance is a command rather than a code reading.
- **Rust fast-path (SPEC section 13).** Post-v1: policy resolution, chain-tail
  verification, and gate verdict as a low-latency engine for per-tool-call
  hooks. The crates.io name approval-md is reserved for it. Blocked on the
  conformance extraction above.
- **Hook adapter.** A per-tool-call adapter (Claude Code hooks and kin) that
  consults the gate before side-effecting tool calls. The Node CLI works today
  where startup latency is tolerable; the Rust path exists for where it is not.
- **Inspect approver.** An approver integration for Inspect-style eval
  harnesses, so gated agents can run inside evaluations with the human loop
  simulated or live.

## Documentation and ecosystem

- **README ecosystem appendix placeholder.** A non-normative appendix listing
  real adopters by PR is the agreed future home for implementation mentions
  (the neutrality ruling deliberately did not create it). Create it when the
  first adopter exists.

## Launch

- **Launch post.** The write-up: the gap (prose permissions without
  enforcement), the mantra, the seq 2 story as the demo of why logs beat
  memory. Draft after M5 lands and the demo runs against real Telegram.
- **Emanuel preview DM.** Send the preview before the public post.
