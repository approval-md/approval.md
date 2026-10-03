# Provisioning a hosted tenant: the operator's bootstrap attestation

A hosted tenant (an Agent Village resident is the first) has a store, a daemon and
a policy, and no shell. Nobody on the tenant's side can type `approval policy
attest` at a terminal, and until something attests the policy the gate answers
every gated call with `policy-not-attested`. With a fail-closed harness hook in
front of it (Hermes with `fail_closed: true`, docs/hermes-hook.md) that means every
gated tool call is blocked from the first second. This page is the step that ends
that state, what it costs in trust, and how to run it so that running it again is
harmless.

## The trust statement

> **The operator sets the starting policy. Every change after that needs the
> approver's own act through a channel.**

That sentence is the whole of what the operator path claims, and the rest of this
page is how the runtime holds it to that:

- The starting policy is attested once, by one fixed operator identity (for the
  village, `human:carter`), as a `policy.updated` record whose actor is that
  identity. The log says the operator did it, because the operator did.
- The bootstrap refuses to attest a second time over the same bytes
  (`policy-already-attested`) and refuses to attest changed bytes
  (`policy-amendment-required`). A change to an attested policy is an amendment,
  and an amendment reaches the log only as the approver's act: a proposal they
  tap on Telegram (SPEC.md §10.3, APRV-109), or `approval policy amend` from a
  human at a terminal.
- The operator path appends no `approval.requested`, `approval.granted` or
  `approval.rejected`, and mints no token. It sets the frame decisions are made
  in and decides no action.

This is operator trust, stated as such. It is the case APRV-422's proposed SPEC.md
§13 wording names: "No hosted service with authority over decisions. A hosted
process may deliver, render, transport, operate and, once decisions are
independently signed by the approver (section 11 cryptographic identity), record.
Below that level a hosted runtime operates under stated operator trust, and the
local-first path remains complete without it." The operator's bootstrap
attestation is operating under stated operator trust: it sets the starting frame
and never decides. SPEC.md §13 still reads "No hosted service" until a human
applies APRV-422; when they do, its cross-reference for operator trust is this
section. Hosted documentation and the tenant's consent copy should carry the
blockquote above verbatim, and should link here rather than restate it.

### Why the operator, and never the resident

The attester must be the operator because the resident did not perform the act.
Running `approval policy attest --as human:<resident>` from a control-plane root
step would record the resident choosing a policy they never saw. SPEC.md §10.4
forbids fabricating a grant, and an attestation is the same kind of act: the
record would be false in the one field a reader relies on. Identity at v0.1 is
config-declared (SPEC.md §11), so nothing in the runtime could stop a script from
writing that record. This page is where the rule is written down instead.

A first-run tap ("accept this policy") over the channel does not work either. A
tap attests only when the policy maps the tapping account as a sender, and the
mapping is itself part of the policy being attested. The channel refuses that
circle with `attest-requires-terminal`. The operator bootstrap breaks it: the
first policy, attested by the operator, already maps the resident's Telegram id,
so the resident's first tap is a mapped sender's act. (A resident attestation in
onboarding, carried by an authenticated sender channel, is APRV-455 and needs a
SPEC amendment of its own. Until it lands, the operator's attestation stands
alone.)

## The sequence

Run as root by the control plane, with every `approval` command executed as the
store user (`approvald` in the village layout) so the files it creates belong to
the daemon that will read them. Nothing here needs a terminal: identity comes
from `--as`, and stdin may be `/dev/null`.

```sh
STORE=/var/lib/approvald/$TENANT/data      # the store; one per tenant
OPERATOR=human:carter                      # one fixed operator identity
RENDERED=/run/provision/$TENANT/APPROVAL.md  # the control plane's rendered policy

install -d -o approvald -g approvald -m 0700 "$STORE"
cd "$STORE"

# 1. Scaffold. Idempotent: an existing store reports `existing` and writes nothing.
runuser -u approvald -- approval init --json

# 2. Write the starting policy, ONLY while the store has never been attested.
#    (`status` exits 1 while unattested; the JSON on stdout is what is read.)
if runuser -u approvald -- approval status --json \
     | grep -q '"attestation":{"state":"not-attested"'; then
  runuser -u approvald -- install -m 0600 "$RENDERED" "$STORE/APPROVAL.md"
fi

# 3. Attest it as the operator. Safe to re-run.
runuser -u approvald -- approval policy attest --bootstrap --as "$OPERATOR" --json
```

Three rules the commands above encode:

- **Work from the store.** `policy attest`, `status` and `doctor` resolve the log
  against the working directory (`.approval/log/events.jsonl`, or `--log`), and
  `--dir` names only where the policy is discovered. `cd "$STORE"` keeps the log
  they read and the log they write the same file. `approval up` resolves its log
  (and `QUEUE.md`) against the working directory the same way, while `approval
  serve --dir` resolves the log under `--dir`. A launcher that starts both with
  `--dir "$STORE"` must therefore also start `up` with the store as its working
  directory (or pass `--log`), or the two processes write two different logs.
- **Never write over an attested policy.** Step 2 is guarded because a policy
  file rewritten under an attestation is a policy the gate refuses
  (`policy-not-attested`, detail `hash-mismatch`) until someone re-attests it, and
  the operator is exactly who must not. If the template moved, the change goes to
  the resident as a proposal. Step 3 refuses `policy-amendment-required` if the
  guard is ever skipped, but by then the file has already changed and the gate is
  shut, so the guard is the line that keeps the tenant working.
- **`--bootstrap`, always.** The plain `approval policy attest` reads no log and
  appends every time it runs: a second `policy.updated` per redeploy, and, after
  the resident has attested or amended their policy, the operator back on record
  as its attester. `--bootstrap` reads the verified log first and attests only a
  store that has never been attested.

### What step 3 answers

| answer | exit | meaning | the control plane does |
|---|---|---|---|
| `{"ok":true,"seq":1,...}` on stdout | 0 | attested; the gate is live | continue |
| `policy-already-attested` | 1 | this exact policy is in force already (a re-run) | treat as done |
| `policy-amendment-required` | 1 | the file differs from the attested policy | alarm; do not attest; route the change to the approver |
| `head-moved` | 1 | another record landed between the read and the append | run step 3 again |
| `log-corrupt` | 1 | the log does not verify | stop; nothing may be decided from it |
| `log-torn-tail` / `corrupt-tail` | 3 | a crashed write left the last line unterminated | stop; a human repairs it |
| `io`, `log-unreadable` | 4 | a file could not be read or written (ownership, mode, a full disk) | fix the store's permissions and re-run |
| `actor-not-human`, `usage` | 2 | the command itself is wrong (`--as agent:…`, a flag mix) | fix the step |

Refusals print one JSON object on stderr. The two bootstrap refusals also carry
the attestation in force and who made it:

```
{"ok":false,"error":{"code":"policy-already-attested","message":"...",
 "seq":1,"attested_by":"human:carter"}}
```

Branch on `error.code`, never on the exit code alone: exit 1 covers both "already
done" and "the policy moved", and those want opposite responses.

### Before step 3 has run

Every gated call refuses `policy-not-attested` (detail `not-attested`). A Hermes
hook configured `fail_closed: true` turns that refusal into a blocked tool, so the
tenant's agent can do nothing gated until the operator's attestation lands. That
is the intended order: the gate is closed while the frame is unset.

## What the tenant can see afterwards

`approval status`, run in the store, names the policy in force and who set it,
read from the verified record and never from the file:

```
attestation           attested (seq 1, by human:carter)
```

and in `--json`, `"attestation":{"state":"attested","seq":1,"attested_by":"human:carter"}`.
`approval doctor`'s attestation row says the same thing:
`APPROVAL.md is attested at seq 1 by human:carter (sha256 …)`. Once the resident's
own attestation or amendment lands, the same rows name them instead, which is how
a tenant learns that the policy in force is now their own.

The exact bytes the operator attested are recoverable. The attestation record
carries `payload_hash`, and the store beside the log holds
`.approval/payloads/<payload_hash>.json` as `{"text": "<the policy, byte for
byte>"}` (APRV-356). A reader re-hashes that text against the record's `sha256`,
so the store is checked rather than trusted.

## Related

- [docs/cli-reference.md#policy-attest](cli-reference.md#policy-attest): the verb,
  `--bootstrap`, and the refusal shapes.
- [docs/hermes-hook.md](hermes-hook.md): the fail-closed hook that blocks every
  tool until this step has run.
- SPEC.md §5.2 (attestation), §10.3 (channel amendments), §11 (identity is
  config-declared), §13 (non-goals; APRV-422 pending).
