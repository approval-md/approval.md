---
id: APRV-351
title: >-
  Constrained model egress: run a harness inside the egress sandbox with only
  its model API reachable
status: In Progress
assignee:
  - '@opus-lane-muse'
created_date: '2026-09-17 02:22'
updated_date: '2026-09-17 08:00'
labels:
  - sandbox
  - design
  - egress
dependencies: []
priority: medium
ordinal: 268000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Split from APRV-193 AC1 on 2026-09-17 with Carter. APRV-193 now proves per-command containment: allowed-class commands run under the Seatbelt egress profile through approval run and the hook exec path, laundered code cannot send mail or POST, and cannot read vault or env material (APRV-193 AC2/AC3, PR #411). What it does not do is put the harness itself in the room: approval sandbox -- claude is a session that cannot think, because a harness needs its model API and the profile denies all egress. The 2026-09-09 review reopened AC1 for exactly this. Design and prove a constrained posture where the harness process reaches only its model provider (Anthropic, OpenAI, Meta, xAI endpoints as configured) and the loopback gate daemon, and nothing else, while every command it spawns inherits the full egress-deny profile. Candidates to evaluate with evidence: a Seatbelt profile with a host allow-list (Seatbelt cannot filter by hostname, so this likely means a local forwarding proxy the profile permits and the harness is pointed at); a per-harness proxy that pins provider hosts and strips ambient credentials; and the harness's own sandbox settings where they exist (Claude Code sandbox, Codex read-only mode). State plainly which harnesses can be confined this way and which cannot, and what an operator gives up (streaming, MCP over HTTP, plugin fetches). Output: a design under design/ (policy.edit.design), a probe under scripts/probes/, and either an approval sandbox --harness <name> mode or a declined recommendation with the failing evidence. APPROVAL_HOOK_REQUIRE_SANDBOX remains default off until this lands. Related: APRV-193, APRV-347, APRV-325.3.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A design document under design/ names the egress the harness needs (provider hosts, ports, protocols), the mechanism that admits only that egress, how ambient credentials are kept out of the harness environment, and what is lost; each claim about Seatbelt or the harness is backed by a probe result
- [ ] #2 A probe shows a harness session under the constrained posture completing one model round-trip while a command it spawns is denied outbound network and a direct connection from the harness to a non-provider host is denied
- [ ] #3 Either approval sandbox gains a documented harness mode with tests, or the task closes with a declined recommendation and the evidence; docs/sandboxed-exec.md describes the outcome either way
- [x] #4 No credential is read or embedded; every probe runs in scratch directories through commands the classifier reads or approval run
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read src/core/sandbox.ts (EgressAllowance, seatbeltProfile, RUNTIME_READ_PATHS), src/cli/sandbox.ts, src/core/child-env.ts and the confined session in src/codex/runner.ts.
2. Establish the Seatbelt limit as a MEASURED fact rather than an assertion, since the whole design rests on it.
3. Build scripts/probes/constrained-egress.mjs proving the mechanism offline against loopback stubs, so it runs in CI and needs no credential: a pinning CONNECT proxy on loopback plus a profile admitting only its port.
4. Design doc under design/ citing the probe's own output for every claim.
5. Record the outcome in docs/sandboxed-exec.md and leave exactly one credentialed command for Carter under Harness round trip.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
OUTCOME: recommended, opt-in, with the approval sandbox harness mode gated on one operator round trip. APPROVAL_HOOK_REQUIRE_SANDBOX stays default off, untouched.

THE SEATBELT LIMIT IS NOW MEASURED, NOT ASSUMED. This is the finding the whole design rests on and it turned out stronger than the task description assumed. sandbox-exec does not ignore a hostname rule, it REFUSES TO COMPILE THE PROFILE: exit 65, host must be star or localhost in network address. A literal IP is rejected the same way. So the accepted host tokens are exactly two, star and localhost, and there is no lower-level spelling to fall back on. That leaves three possible postures for a harness: all egress, no egress, or a port on loopback. The proxy is not a preference, it is the residue after the alternatives are eliminated.

MECHANISM. A pinning CONNECT proxy on loopback: exact authority match, no suffix matching and no wildcards, port part of the identity, malformed authority refused rather than falling through. It is a TUNNEL and never terminates TLS, so prompts, completions and the provider key stay end to end encrypted and the proxy learns only which host was asked for. The profile admits that one port; everything the harness spawns keeps the ordinary APRV-193 profile with no port admitted at all.

EVIDENCE, seven assertions, all offline against loopback stubs so CI can run them with no internet, no provider, no credential and no model call: seatbelt rejects hostname rules outright; seatbelt filters by address not name; direct connection denied (EPERM); allowed host through proxy succeeds; non-listed host through proxy denied; spawned command has no network (EPERM); the proxy ledger shows it admitted only the allow-listed authority. Exit 69 EX_UNAVAILABLE and a clean skip where there is no Seatbelt.

A BUG WORTH RECORDING because it produced a convincing false negative. The first run reported four failures that all looked like the sandbox denying things. The cause was spawnSync in the probe blocking the event loop while the stub origins and the proxy listened in the SAME process, so nothing could ever accept and every assertion timed out exactly as a denial would look. Fixed by making the profile runner asynchronous, and the reason is now a comment on that function so it is not rediscovered.

CREDENTIALS. Reuses child-env.ts and the CONFINED_ENV_ALLOW pattern rather than inventing custody. The constrained harness gets that list plus HTTPS_PROXY and an empty NO_PROXY, the second so an inherited value cannot carve a host out of the pinned path. Disk side custody unchanged: vault, env map and sealing keys stay denied, emitted last.

WHAT AN OPERATOR LOSES, stated in the design as a table: MCP over HTTP, plugin and extension fetches, telemetry, auto update, and most importantly any built-in web fetch or search tool, which is irreconcilable by construction. A harness with a fetch tool has a second egress path by design, and pinning the model API while leaving that on produces a posture that looks constrained and is not. Streaming is expected to be unaffected since CONNECT tunnels are byte streams, but that is measured only against loopback stubs here, which is part of what the operator round trip confirms.

HARNESS COVERAGE. Claude Code and Codex confinable on their documented base-url and proxy variables. Grok probably, unverified. Muse Code UNRESOLVED and recorded as such rather than assumed: no HTTPS_PROXY or CLI base-url setting appears in Meta-owned documentation, but Meta does document its own sandbox-network flag with a proxy-only mode, which may be the supported path or may be a different mechanism. Muse also needs THREE hosts, api.meta.ai, auth.meta.com and lookaside.facebook.com, read from the installed launcher; a pin covering only the API host produces intermittent update failures that will look like bugs rather than policy.

Invariants named, SPEC section 11.1: fail closed (no Seatbelt means no constrained session rather than an unconfined one; unparseable authority refused; unknown harness name refuses; the probe exits 69 rather than reporting a pass it did not measure); self-reported fields never reduce scrutiny (the allow-list is compiled in and named by the operator, nothing the harness sends can widen it, and the NO_PROXY pin closes the inherited-environment hole); ambiguity resolves to the stricter path (Muse recorded unresolved, the web-fetch door recorded as unpinnable rather than omitted).

AC4 is satisfied by construction: no credential is read, embedded or logged anywhere, and every probe runs in scratch directories.

Verification: node scripts/run-tests.mjs --only probe-constrained-egress sandbox-probe, 18 tests, 17 pass, 0 fail, 1 skipped (the opt-in external leg), exit 0. Build, typecheck and lint each exit 0.

Remaining for AC2 and AC3: the credentialed harness round trip, one command, left for Carter in docs/sandboxed-exec.md under Harness round trip. It uses the allow-loopback flag that ships today rather than the narrow per-port flag, because the per-port flag arrives with the harness mode; the docs say so plainly instead of implying a narrowness that has not shipped.
<!-- SECTION:NOTES:END -->
