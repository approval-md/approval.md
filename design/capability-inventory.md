# Capability inventory and enforcement visibility

**Status: deferred design. No build task exists, and nothing here is wired
into the gate.** Trimmed from a proposal drafted with ChatGPT on 2026-09-20
(kept in full in the primary checkout's private folder). The one finding in it
that could be built today shipped as APRV-408; the rest is recorded here so it
is not rediscovered from scratch.

---

## 1. The question

An operator reading `APPROVAL.md` sees rules. A rule existing says nothing about
whether the action it names can be recognised, whether the route that action
arrives by is intercepted, or whether an interception has ever been observed.
The proposal's distinction, which this document keeps:

> available or potentially available → classifiable → policy-configured →
> interception configured → interception observed → bounded enforcement
> evidence

These are independent facts, never a ladder. A tool can be configured and not
offered to a session. A call can be intercepted and passed through
unclassified. An explicit deny can hold while a hook crash fails open. An
adapter can hold a credential without being the only route to the service.

The report the proposal wanted replaces "read access is supervised" with: the
policy assigns retrospective supervision to out-of-scope reads; this project's
matcher does not send the direct read tools to the hook; other configuration
layers and live session interception are not established.

## 2. What already exists

Before any of this is built, a reader should know what the repository answers
today, because the proposal's MVP overlaps with all of it.

- **`approval doctor`, row `harness-hook-wiring`** (APRV-151, APRV-408). Reads
  this checkout's `.claude/settings.json`, derives the gated roster from the
  Claude adapter rather than a hand list, names the read tools the matcher
  leaves out, names a matched tool the adapter would pass through, and parses
  the handler command to compare its `--dir` with the primary root. This is the
  proposal's static-interception dimension for one harness, done.
- **The held read-scope matcher line.** `Read`, `Glob` and `Grep` are declared
  by the adapter and absent from the committed matcher on purpose: a read is the
  most frequent tool call and every match is a Node process start.
  `docs/claude-code-hook.md` prints the wider matcher and states the cost. A
  future inventory must report this as a documented decision, never as a
  discovered gap.
- **`approval hook classify` and `approval policy check`** answer "what would
  happen for this concrete operation". The proposal's classes view adds little
  on top of them.
- **`approval coverage`** joins observed side effects to log evidence. It is the
  retrospective complement and must keep its own denominators.
- **The adapters are already data.** `HARNESS_ADAPTERS` in `src/cli/hook.ts`
  exports each harness's shell, file, read and passthrough tools. The
  proposal's "extract a shared descriptor seam" is an import.

## 3. Invariants a build would carry

Condensed from the proposal's ten. They restate SPEC §11 for this surface.

1. **No authority from observation.** No report, snapshot or catalogue is ever
   an input to a verdict, a floor, a budget or a sampling draw.
2. **No mutation and no execution.** The inventory writes nothing and spawns
   nothing beyond what doctor already spawns (git). No harness `--version`
   probe, no hook command, no MCP server, no config interpolation, no
   `.approval/env`.
3. **Partial means partial.** An unreadable, unsupported or uninspected source
   is a visible limitation, never an empty source.
4. **Same semantics.** Policy explanations come from the existing resolver;
   classification summaries name the actual passthrough and refusal branches.
5. **No transitive guarantee.** Approval of a shell, interpreter, script or
   agent launch says nothing about downstream effects.
6. **Evidence is scoped and bound.** Every claim names its route, context,
   time, source and configuration revision. A missing binding limits the claim.
7. **No fabricated denominator.** No percentage of "all agent actions covered".
   Counts name their set.
8. **No manufactured certainty.** A verifying chain establishes the chain
   property, not honest self-reports or complete capture. A grant does not
   prove execution; a hook's deny does not prove the harness obeyed it.

## 4. The model, in brief

**Unit.** An execution route: one harness tool in one configuration, one MCP
server's tool as advertised to one client, one adapter's brokered route. Routes
are never merged by effect ("send email" is three routes with three custody
stories). Identity is a tuple of scope, harness kind, route kind, origin and
native tool name; schema and config digests are revisions of a route, not new
routes.

**Two views.** Routes (default): what is known about each configured,
advertised or observed route. Classes: the policy's declared patterns, the
classes the runtime can emit, and which routes reach each. A declared class
with no known route is informational, never invalid.

**Evidence dimensions, kept independent.** Availability, classification
(implemented, restricted, passthrough, unmapped, unknown), policy resolution,
static interception, runtime interception, enforcement evidence, outcome
evidence. There is no top-level `enforced: true`. Each evidence record carries
its origin trust (local inspection, verified log, imported assertion,
maintainer contract) and freshness (matching, stale, unbound, historical).

**Three unknowns never confused.** A classified action with no rule (show the
policy default). An intercepted command that cannot be classified (show the
refusal). A route outside interception (state that no verdict is established;
do not claim the action is permitted).

## 5. The CLI sketch, if built

```sh
approval capabilities --dir <project> [--harness claude-code|codex|all]
                      [--view routes|classes] [--include-user-config]
                      [--mcp-snapshot <file>] [--format text|markdown] [--json]
                      [--strict]
```

Offline only. `--strict` checks static consistency of declared sources and
exits non-zero on a known gap; its success text is fixed: "Static checks passed
for declared scope; runtime enforcement not verified." No `--fix`, `--probe`,
`--connect` or `--grant`. Output allowlists fields: no raw commands, environment
values, credentials, payload bodies or server descriptions.

**Registry decision the build cannot avoid.** The verb reads arbitrary project
and user configuration, so it must not be published through the MCP wrapper by
the generic filter, and `human_only` is the wrong marker for it (it records no
human authority). A transport-exclusion mechanism, or a fixed-scope redacted MCP
view, is a registry change of its own.

## 6. Deferred milestones

- **Live MCP discovery.** Connecting to individually reviewed server
  definitions, paginated `tools/list` without `tools/call`. Starting a stdio
  server is code execution and needs the policy's consent flow, never an
  offline flag.
- **Session evidence and bounded probes.** Explicit capture of effective
  configuration, native tool identity and outcomes; a probe matrix on a scratch
  instance (allow, deny before effect, crash, timeout, malformed output,
  continuation routes) with witnesses. New log fields go through the schema
  review path.
- **Reviewed mapping and enforcement expansion.** Tool-specific classification
  behind an explicit route origin, input-schema revision and conformance tests.
  A call-time manifest is an authority-bearing artifact under attestation; a
  stale inventory never grants or revokes.

## 7. Why it is deferred

- Nobody has asked for MCP snapshot import, and no exporter exists to produce
  the snapshot.
- The verified-log "interception observed" projection answers a question no
  operator has raised; `approval coverage` already answers the neighbouring one.
- The operator questions the MVP targets (which knobs exist, what would happen
  for this operation, why is this not governed as expected) are answered today
  by `doctor`, `policy check`, `hook classify` and the docs, with APRV-408
  closing the one gap doctor had.
- The new verb needs the registry decision in §5 before it can exist safely.

When a user appears for one of the deferred pieces, file the build task against
this document and against SPEC §11; the acceptance matrix in the private
proposal (A01 to A35) is the starting checklist.
