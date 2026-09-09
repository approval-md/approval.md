# Governance

How approval.md is held, who may do what with it, and what happens to it if
it succeeds.

## The specification is the product

`SPEC.md` and the JSON schemas under `schema/` are the thing being built.
The TypeScript runtime in this repository is the reference implementation of
that format, and any conforming implementation in any language is a peer of
it. The specification and schemas are dedicated to the public domain under
CC0 1.0 (`schema/LICENSE`). The runtime is licensed under Apache 2.0
(`LICENSE`, `NOTICE`).

Changes to the specification go through public Backlog.md tasks in
`backlog/` and the amendment-attribution rule stated at the top of `SPEC.md`:
amended text names the task that changed it, and text a human has not
ratified through the gate says so. There is no private track for spec
changes.

## Maintainer and copyright

Carter Crouch is the maintainer and the copyright holder. The runtime was
built by Carter directing Claude, Codex, and Cursor, working under this
repository's own approval policy; the log of those agents' gated actions is
committed at `.approval/log/events.jsonl`. Output of those tools carries no
independent copyright, so Carter is the sole human copyright holder as of
the Apache 2.0 relicense (APRV-288). Outside human contributions are
accepted under the Developer Certificate of Origin described in
`CONTRIBUTING.md` and stay the property of their authors.

## Bountify.ai

Bountify.ai, a company Carter Crouch runs, operates a hosted implementation
of this format: a hosted daemon and a hosted agent-reviewer layer. That
service is optional. Nothing in the format, the schemas, or the reference
runtime depends on it, and a self-hosted daemon or a third-party
implementation is a full peer of it.

Bountify.ai holds no rights over the specification, the schemas, or the
reference runtime beyond those of any Apache 2.0 licensee, and no special
standing in how the specification changes.

## Neutral governance

If the format reaches meaningful multi-party adoption, the specification,
the schemas, and the name move to a neutral body. The trigger is
deliberately loose: a second independent implementation running in
production, or a request from an adopter that the maintainer agrees is
reasonable. Until then this file is the governance, and it is edited only
through the same gated process as `SPEC.md`.

## Trademark

approval.md™ and the approval.md logo are trademarks of Carter Crouch,
asserted under common law and unregistered as of 2026-09-06.

You may use the name to describe compatible work: "works with approval.md",
"implements the approval.md format", "an approval.md daemon". You may not
use it, or a confusingly similar name, as the name of a product or service,
or in a way that implies endorsement, without written permission. A fork of
the code ships under a different name. The code itself is yours to fork
under the Apache 2.0 terms; only the name is protected.

## Patents and defensive publication

No patents are sought on anything in this repository, and none will be. The
dated public history of `SPEC.md` in this repository is the prior-art
record. The Apache 2.0 licence adds a patent grant from every contributor
and terminates the licence of anyone who brings a patent claim over the
code.
