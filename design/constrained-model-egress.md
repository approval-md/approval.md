# Constrained model egress: a harness inside the sandbox with only its provider reachable

APRV-351, split from APRV-193 AC1 on 2026-09-17. Status: **recommended, with
the harness mode gated on one operator-run round trip**.

APRV-193 proved per-command containment: an allowed-class command runs under a
Seatbelt profile that denies all outbound network, so laundered code cannot
send mail or POST, and cannot read vault or env material. What it deliberately
did not do is put the harness itself in the room. `approval sandbox -- claude`
is a session that cannot think, because a harness needs its model API and the
profile denies everything.

This document answers what it would take to give the harness exactly one door
and nothing else, and it backs every claim about Seatbelt with output from
`scripts/probes/constrained-egress.mjs`, which runs offline and is exercised by
`tests/probe-constrained-egress.test.ts`.

## 1. The egress a harness actually needs

For the four harnesses this repository cares about, the standing need is a
single TLS connection to one provider API, plus whatever the operator's own
policy already allows through `approval run`.

| Harness | Provider egress | Source |
| --- | --- | --- |
| Claude Code | `api.anthropic.com:443` | vendor docs; `ANTHROPIC_BASE_URL` redirects it |
| Codex CLI | `api.openai.com:443` | vendor docs; `OPENAI_BASE_URL` redirects it |
| Muse Code | `api.meta.ai:443`, `auth.meta.com:443`, `lookaside.facebook.com:443` | read from the installed launcher at build `1.3.0-R3233.1`; the launcher names all three, the last for update payloads |
| Grok | `api.x.ai:443` | vendor docs |

Three observations shape the rest of this document.

First, the need is **TLS to a named host on 443**, never a raw IP. Providers sit
behind CDNs and anycast, so the address set is large, changes without notice,
and is shared with unrelated tenants. Pinning addresses is not a weaker version
of pinning names; it is a different and useless control.

Second, the list is short and stable enough to be written down and audited,
which is what makes an allow-list viable at all.

Third, Muse Code needs **three** hosts, not one, and one of them
(`lookaside.facebook.com`) exists to serve update payloads. An operator who
pins only the API host gets a harness that works until it tries to update.

## 2. Why Seatbelt alone cannot do it

Not "is awkward at". Cannot.

The probe's first assertion asks `sandbox-exec` to compile a profile naming a
host. It does not ignore the rule and it does not silently widen; it refuses the
profile:

```
$ node scripts/probes/constrained-egress.mjs probe
  PASS  seatbelt-rejects-hostname-rules-outright
        observed: hostname rule: exit 65,
        sandbox-exec: host must be * or localhost in network address;
        literal-IP rule: exit 65,
        sandbox-exec: host must be * or localhost in network address
```

Two accepted tokens, `*` and `localhost`. A literal IP is rejected as firmly as
a hostname, so there is no lower-level spelling to fall back on either. The
`remote ip` predicate is a **port** filter on the loopback interface, which the
probe's second assertion confirms by admitting one loopback port and watching a
second port on the same interface fail with `EPERM`.

So the SBPL vocabulary offers exactly three postures for a harness: all egress,
no egress, or egress to a port on loopback. The first is what we have today
outside the sandbox, the second is the session that cannot think, and the third
is the only one left. That is the whole argument for a proxy: it is not a
preference, it is the residue after the alternatives are eliminated.

## 3. The mechanism: a pinning forwarding proxy on loopback

A local proxy listens on `127.0.0.1:<port>`, accepts `CONNECT host:port`,
matches the authority against an allow-list, and either tunnels bytes or answers
`403`. The Seatbelt profile admits that one port and denies everything else.
The harness is pointed at the proxy with `HTTPS_PROXY`.

```
harness ──CONNECT──▶ proxy (loopback, pinned) ──TLS──▶ api.anthropic.com:443
   │                    ▲                                    
   │ direct: EPERM      │ only this one port is admitted
   ▼                    │ by the Seatbelt profile
  ✗ anything else       │
                        
spawned command ──▶ ✗ EPERM (ordinary profile: no port admitted at all)
```

Four properties matter, and the probe measures each one.

**It is a tunnel, not an interceptor.** It never terminates TLS, holds no
certificate, and sees no request body. Prompts, completions and the provider key
stay end-to-end encrypted between harness and provider. The proxy learns which
host was asked for and nothing else. This is the difference between a control
and a wiretap, and it is why the design is acceptable to run over a developer's
own session.

**Matching is exact.** Authority equality, lowercased and trimmed, with the port
part of the identity. No suffix matching, because `api.anthropic.com.evil.test`
ends with something a careless suffix rule would admit. No wildcards, because a
wildcard an operator cannot read is a wildcard an operator cannot audit. A
malformed or empty authority is refused rather than falling through, so a
broken `CONNECT` cannot become an open tunnel.

**The door is not inherited.** The harness gets the profile with one admitted
port; everything the harness spawns gets the ordinary APRV-193 profile with no
port admitted. The probe asserts this separately, because the whole posture
would be worthless otherwise: the point of confining the harness is that code it
writes and runs cannot reach the world, and a door the child inherits is not a
door, it is a hole.

**A direct connection still fails.** The harness cannot bypass its own proxy,
because the profile admits the proxy's port and nothing else.

The measured matrix, all offline against loopback stubs:

```
PASS  seatbelt-rejects-hostname-rules-outright
PASS  seatbelt-filters-by-address-not-name
PASS  direct-connection-denied                  observed: BLOCKED:EPERM
PASS  allowed-host-through-proxy-succeeds       observed: REACHED:PROVIDER-ALLOWED
PASS  non-listed-host-through-proxy-denied      observed: BLOCKED:proxy-refused-authority
PASS  spawned-command-has-no-network            observed: BLOCKED:EPERM
PASS  proxy-refused-what-it-should              admitted: api.provider.test:443;
                                                refused: telemetry.vendor.test:443
```

Nothing there needs the internet, a provider, a credential or a model call, so
it runs in CI and a failure means the mechanism broke rather than that a network
blipped. On a machine with no Seatbelt the probe exits 69 (`EX_UNAVAILABLE`) and
the test skips rather than reporting a false pass.

## 4. Keeping ambient credentials out of the harness

The proxy constrains where bytes may go. It says nothing about what the harness
is holding, and a harness that inherits the operator's whole environment is
holding a great deal.

The pattern already exists and is reused rather than reinvented:
`src/core/child-env.ts` builds the child environment, and
`CONFINED_ENV_ALLOW` in `src/codex/runner.ts` is the allow-list a confined
session gets (`PATH`, `HOME`, `SHELL`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`,
`LC_CTYPE`, `TERM`, `LINES`, `COLUMNS`). Everything else is dropped, so an
`AWS_SECRET_ACCESS_KEY` or a `GITHUB_TOKEN` sitting in the operator's shell does
not travel into the session.

A constrained harness needs that list plus exactly two additions:

- `HTTPS_PROXY` (and `HTTP_PROXY`, `ALL_PROXY` for harnesses that read those),
  pointing at the loopback port.
- `NO_PROXY` set to empty, so no host can be excluded from the pinned path by an
  inherited value.

The provider credential is the interesting case. The harness needs it, and the
proxy must not see it — which the tunnel design already guarantees, since the
`Authorization` header is inside the TLS session the proxy cannot read. The
credential still has to reach the harness process, and this design does not
change custody: it comes from the operator's own environment or the harness's
own credential store, exactly as it does today. What changes is that it becomes
the *only* reachable secret, because everything else was dropped and everything
else is unreachable.

Disk-side custody is unchanged and still applies: the vault, `.approval/env` and
the sealing keys stay in `denyRead`, emitted after any read-jail allows so they
are the last word.

## 5. What an operator gives up

Stated plainly, because a control that surprises people gets switched off.

| Lost or degraded | Why | Mitigation |
| --- | --- | --- |
| MCP servers over HTTP | Their hosts are not the provider's | Add each to the allow-list, explicitly and visibly, or use stdio MCP servers, which are unaffected |
| Plugin and extension fetches | Marketplace and registry hosts are not on the list | Install before entering the session |
| Telemetry and crash reporting | Not the provider host; refused | This is mostly the point |
| Auto-update checks | Muse's `lookaside.facebook.com`, and the equivalents | On the list for Muse, or accept a harness that cannot self-update |
| Web search / fetch tools | Arbitrary hosts by definition | Irreconcilable: a tool whose purpose is arbitrary egress cannot be pinned. Turn it off, or accept it as an unpinned door and say so |
| Docs and changelog links the harness opens | Not the provider | Refused |
| Streaming | Not affected | `CONNECT` tunnels are byte streams; SSE and chunked responses pass through untouched. Measured only against loopback stubs here, so the operator round trip in §7 is what confirms it against a real provider |
| `git`, `gh`, `npm install` | Not the provider | Unchanged from APRV-193: these are spawned commands, they have no network, and they go through `approval run` |

The web-search row is the one to read twice. A harness with a built-in fetch
tool has a second egress path by design, and pinning the model API while leaving
that on produces a posture that looks constrained and is not.

## 6. Which harnesses can be confined this way

The requirement is that the harness honour `HTTPS_PROXY` or offer a base-URL
setting, and that it not carry a second, unpinnable egress path enabled by
default.

| Harness | Proxy or base URL | Verdict |
| --- | --- | --- |
| Claude Code | `ANTHROPIC_BASE_URL`; standard Node proxy variables | **Confinable.** The round trip in §7 is against this one |
| Codex CLI | `OPENAI_BASE_URL`; standard proxy variables | **Confinable**, on the same evidence class |
| Grok | `--base-url` / env base URL, as documented | **Probably**, unverified here |
| Muse Code | **Unresolved.** Meta's published docs contain no `HTTPS_PROXY` or CLI base-URL setting that this lane could find on a Meta-owned domain. But Meta documents its own sandbox with `--sandbox-network proxy-only`, which names a proxy posture as a supported mode | **Investigate before relying on it.** `proxy-only` may be the supported path and may be better than an external proxy, or may be a different mechanism entirely. Do not assume |

Muse deserves the extra caution for a reason beyond the missing setting: its
launcher reaches three hosts, one of them an update endpoint, so a pin that
covers only the API host produces intermittent failures that will look like
bugs rather than like policy.

## 7. Recommendation

**Adopt, as an opt-in `approval sandbox --harness <name>` mode**, with the
harness mode landing only after the operator round trip in
`docs/sandboxed-exec.md` passes. `APPROVAL_HOOK_REQUIRE_SANDBOX` stays default
off, unchanged by this document.

The reasoning for opt-in rather than default: every assertion above is about
what the mechanism *can* enforce, and all of them hold. None of them is about
whether a real harness stays usable for a real working day behind it, and that
is not something a probe can answer. The honest position is that the control is
proved and the ergonomics are not.

What lands with the mode, when it lands:

1. `--harness <name>` resolves a named allow-list from the table in §1.
2. The proxy starts on an ephemeral loopback port, the profile admits that port,
   and both die with the session.
3. The harness environment is `CONFINED_ENV_ALLOW` plus the proxy variables.
4. Spawned commands keep the ordinary profile. This is a test, not a comment.
5. An unknown harness name refuses rather than defaulting to a wide list, and a
   host that is not in the named list is never added at runtime by anything the
   harness says (SPEC §11.1: self-reported fields never reduce scrutiny).
6. A host that cannot apply a profile refuses the session outright, as
   `planConfinedSession` already does, rather than running unconfined.

## 8. Invariants

- **Fail closed.** No Seatbelt means no constrained session, not an unconfined
  one. An unparseable authority is refused. An unknown harness name refuses. The
  probe exits 69 rather than reporting a pass it did not measure.
- **Self-reported fields never reduce scrutiny.** The allow-list is compiled in
  and named by the operator. Nothing the harness sends can widen it, and the
  `NO_PROXY` pin exists so an inherited environment variable cannot carve a hole
  in it either.
- **Ambiguity resolves to the stricter path.** Muse is recorded as unresolved
  rather than assumed confinable, and the web-fetch row is recorded as an
  unpinnable door rather than quietly omitted.

## 9. What this does not claim

This confines a child process on macOS. It is not isolation, and it is not a
claim about any harness's desktop application, which runs outside anything this
runtime spawns. Inbound sockets are not denied, which is `src/core/sandbox.ts`'s
standing limit and unchanged here. A proxy pins a hostname at `CONNECT` time; it
does not verify that the host on the far side is who DNS said it was, so a
compromised resolver is out of scope and stays that way. Linux is out of scope:
the bubblewrap path would need its own design, because a network namespace
cannot carve loopback back in the way Seatbelt can.

And the largest one: none of this makes a harness trustworthy. It makes a
harness's egress enumerable. Those are different properties, and only the second
is on offer here.
