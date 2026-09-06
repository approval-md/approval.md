# Policy amendment proposals: APRV-184 and APRV-166

Drafted 2026-09-06 by the `@opus-policy` lane, against the policy committed at
`origin/main` (`APPROVAL.md`, sha256 `a6d7b83d492994a7ab5152ccc6881dd849cc9fe9a0cfb15c449ff3e2ce40ac2d`,
attested at seq 23351 on 2026-09-05T19:49:06Z). Agents may not write `APPROVAL.md`
(`policy.core`, human-only), so a proposal is the whole of what this lane can produce.

## Verdict, both tasks

**Neither task needs a ceremony. Both amendments are already in the attested policy,
and both pin sets already match.** There is no YAML diff to apply and no
`src/core/policy-expectations.ts` diff to accompany one. The runbook further down is
kept for the day one of these lines does move, and it is not a thing to run today.

| Task | Amendment asked for | State in the live policy | What is still owed |
| --- | --- | --- | --- |
| APRV-184 | `policy.edit` → `supervised-live`, `live_rate: 0.1` | Present since the seq 5147 ceremony (2026-09-01) | Operational: the daemon must serve draws, then one drawn-through edit observed |
| APRV-166 | `defaults.token_delivery: sealed` | Present since the seq 3067 ceremony (2026-08-30) | Nothing. Sealed delivery is proven end to end on 17 real grants |

## The two lines, as they stand in the attested file

```yaml
defaults:
  autonomy: manual
  channel: telegram        # cli remains a fallback per approvers
  approval_ttl: 24h
  on_expiry: reject
  token_delivery: sealed   # APRV-166: grant seals to the requester's ephemeral
                           # key; the channel never carries a usable token and
                           # no human relays one (was: manual)

classes:
  policy.edit:               { autonomy: supervised-live, live_rate: 0.1 }       # this file, CLAUDE.md, CI config
```

Resolved with the engine rather than read by eye:

```
$ approval policy test policy.edit
final: supervised-live at rate 0.1 — that fraction of this class STOPS at the human
gate before executing (selected by HMAC over the payload hash under the operator's
secret); the rest proceed and are still eligible for retrospective review
-> supervised
```

`policy.edit.spec` inherits that same line (provenance `inherited`, SPEC §5.2 as
amended by APRV-266), so SPEC.md edits carry the 0.1 rate too. `policy.edit.design`
is `supervised` and `policy.edit.ci` is `manual` on their own rules, and the gate's
own organs sit outside all of it on `policy.core`, `log.mutate` and
`account.credential`, each `human-only` since APRV-198 and APRV-194. The tension the
APRV-184 notes recorded, that a 0.1 sample was sitting on `APPROVAL.md` itself, is
therefore closed in the file as well as on paper.

## APRV-184: policy.edit at supervised-live 0.1

### What is done

AC1, AC2 and AC4 are recorded as landed and this lane re-derived the part that lives
in the file: the rule is present, it resolves as intended, and the pins agree.

### What is still owed, and why its shape changed

The task's AC3 asks that the sampling secret be "verified resolvable in the gate
process environment". **That criterion was written before APRV-208 and no longer
describes the system.** The draw moved out of the gate process and into the daemon:
a gate process (the Claude Code hook, the CLI) holds no sampling secret and asks over
an owner-only Unix socket at `.approval/daemon/draw.sock`, and the daemon answers
because a human exported the secret in the terminal they started it from
(`docs/dogfood-cutover.md`, "What a restart looks like"). Read AC3 as: *the daemon is
up, in a shell where the secret resolves, and `approval doctor`'s `live-draw` row
passes in the primary checkout.*

Under that reading, AC3 is still unmet, and the log now says so in its own words. Two
`approval.requested` records written last night carry the `live_draw` field APRV-208
added:

| seq | ts | class | `live_draw` |
| --- | --- | --- | --- |
| 23709 | 2026-09-05T22:15:52Z | `policy.edit.spec` | `{"v":1,"live_rate":0.1,"source":"unavailable","reason":"draw-daemon-stale"}` |
| 23714 | 2026-09-05T22:33:11Z | `policy.edit.spec` | `{"v":1,"live_rate":0.1,"source":"unavailable","reason":"draw-daemon-stale"}` |

`draw-daemon-stale` means something was listening on the socket and would not answer,
so the action failed closed and went to a human. That is the correct behaviour and it
is also the operator's control not being in force.

### The mechanism does work, on the other live class

`log.advance` is the second `supervised-live` class (rate 0.01). Since its seq 7413
ceremony the log holds **99 actions that executed with no `approval.requested` at all**
and 15 that gated, and 9 of the executed ones were afterwards picked up as
`audit.sampled` with `reason: "supervised-sample"`, `rate: 0.15` and a real
`selection: "hmac-sha256/…"` value. Live selection and the retrospective sampler both
run correctly wherever the secret resolves. Nothing is wrong with the machinery; the
gap is that the process deciding a `policy.edit` is a hook child, and its route to the
secret (the daemon socket) was not answering.

`policy.edit` itself has had no action since seq 19638 (2026-09-05T08:10Z), so there
is no post-APRV-208 sample of the class to read either way: 218 gated, 0 drawn through,
across the whole log.

### To close AC3 and AC5

In the primary checkout, in the terminal that owns the daemon:

```sh
cd /Users/carter/dev/approval-md
eval "$(approval env)"
approval up
approval doctor            # the `live-draw` row must read pass
```

Then AC5 needs one `policy.edit` action to be drawn through: an agent edits CLAUDE.md
or a `protected_paths` entry, and the log shows `task.registered` followed straight by
`execution.started` with no `approval.requested` between them. Verify the draw
afterwards by recomputing HMAC-SHA-256 over that action's `payload_hash` under the
secret and comparing against 0.1, which is evidence nobody can forge because the
`payload_hash` is in the record and the secret never is.

The counterpart, a *sampled* edit, is what every `policy.edit` in the log already is,
so AC5's second half is satisfied the moment the first half is.

### Recommendation

Do not run a ceremony. Uncheck nothing and change no YAML. Either close APRV-184 on
the strength of AC1/AC2/AC4 and carry AC3/AC5 into a small follow-up about the daemon
draw being live in the primary, or leave it open and let the next `approval up` with
the secret exported close it. The policy half of this task has been done since
2026-09-01, and what remains is a terminal Carter owns.

## APRV-166: repo token_delivery manual → sealed

### What is done

`defaults.token_delivery: sealed` is in the attested file with the APRV-166 comment
on it (AC1, AC2, both recorded as landed at the seq 3067 ceremony).

### AC3 is met: sealed delivery is proven on real grants

The two additive fields SPEC §10.4 defines appear on real actions in the committed
log, correlated by `payload_hash`:

- **17** `approval.requested` records carry `token_recipient_key`, each a 60-character
  base64 X25519 SPKI public key (`MCowBQYDK2…`).
- **17** `approval.granted` records carry `token_sealed`, every one of them the same
  shape: `{alg: "x25519-hkdf-sha256/aes-256-gcm", epk, nonce, ct, tag}`, exactly the
  scheme §10.4 specifies.
- **10** of those actions go on to an `execution.started`.

They span 2026-08-31 to 2026-09-05, three classes (`policy.edit`, `log.advance`,
`network.call`) and three agent identities (`agent:claude-code`, `agent:codex`,
`agent:codex-claude-import`), so this is the ordinary path rather than one rehearsed
demo. One full trace:

```
19223  2026-09-05T02:02:08Z  approval.requested  agent:codex     network.call  +token_recipient_key
19231  2026-09-05T02:02:59Z  approval.granted    human:carter    network.call  +token_sealed
19251  2026-09-05T02:03:53Z  execution.started   agent:codex     network.call
```

**What the log cannot show, stated plainly.** No field records *how* the executing
process obtained its token, so the log proves the seal was minted, addressed to the
requester's ephemeral key and recorded, and that the action then executed. It cannot
prove the negative that nobody read the token off a terminal and pasted it. The
corroboration is the code path rather than a record: under `token_delivery: sealed`,
`approval run` opens the grant's `token_sealed` with the private key `approval request`
wrote and needs no `--token` in the argv at all (`docs/cli-reference.md`, "`--token` is
optional under sealed delivery"), and `approval wait --json` returns the raw token in
the granted action's entry. A relay is possible and is no longer necessary, which is
what the amendment set out to achieve.

`tests/sealed-delivery.test.ts` carries the property under test, and it passes 10/10
(exit 0). Two of its cases are the exact shape this repository's ceremony uses:
**"request on A, grant on B, wait and run on A: the token never crosses in clear"** is
the split between the agent session that opens the request and the phone the human
grants from, and **"a machine that did not open the request gets no token from wait"**
is its negative. A third, "the human render never prints the token, whatever the
delivery mode is", bounds what a relay could have copied off a terminal in the first
place. So the mechanism is proven in the suite and exercised in production traffic, and
the residual is the negative for any one named action, which is a property of the event
schema rather than a gap in the feature.

### Recommendation

Do not run a ceremony. Check AC3 and close APRV-166. If the stricter reading is wanted,
that a single named run is watched from `wait` to `run` with the argv visible, the
0.1.0 release ceremony still serves as that observation, and it costs nothing to wait
for.

## The ceremony, for the day one of these lines does move

Nothing below is to be run today. It is here because a proposal that names an
amendment should also name how it lands.

```sh
cd /Users/carter/dev/approval-md         # the primary checkout, never a worktree
$EDITOR APPROVAL.md                      # apply the one-line change by hand
$EDITOR src/core/policy-expectations.ts  # move the pin in the same breath
npm run build && npm test                # the dogfood suite reads both
approval policy amend --as human:carter --commit
```

`approval policy amend` fetches, bases the commit on `origin/main`, runs
`checkPolicyExpectations` against the amended file, attests, pushes by refspec, opens
the pull request and arms the merge, switching to a `policy-amend-<seq>` branch on its
own because main is protected (`docs/dogfood-cutover.md`). It stops before the
attestation on `fetch-failed`, `base-policy-diverged`, `base-log-diverged` and
`policy-suite-failed`, so a half-done ceremony is not a state this reaches. Expect the
silent chain verify to take around 33 seconds (APRV-167) and let it run.

**Any resolution change moves a pin.** `src/core/policy-expectations.ts` pins autonomy
and provenance for every class the policy declares literally, and
`checkPolicyExpectations` fails in both directions: a changed resolution, and a class
the policy declares that nothing pins (APRV-274). A ceremony that changed
`policy.edit`'s rate alone would move no pin, because the pins record
`supervised`/`rule` and the rate lives in the note beside it; a ceremony that changed
its *level* would move one.

Afterwards:

```sh
approval doctor          # attestation row names the new seq; live-draw row must pass
approval policy test policy.edit
approval log sync        # once the pull request merges
```

## Verification this lane performed

| Check | Result |
| --- | --- |
| `approval policy test policy.edit` | `supervised-live` 0.1, provenance `rule` |
| `approval policy test policy.edit.spec` | `supervised-live` 0.1, provenance `inherited` |
| `approval policy test log.advance` | `supervised-live` 0.01, provenance `rule` |
| `approval policy test policy.core` | `human-only`, provenance `rule` |
| `approval policy check <class> --policy <scratch copy of origin/main:APPROVAL.md>` | same answers from the scratch bytes |
| `node dist/tests/dogfood.test.js` | 39 tests, 39 pass, 0 fail, exit 0 |
| `node dist/tests/sealed-delivery.test.js` | 10 tests, 10 pass, 0 fail, exit 0 |
| `npm run lint` | exit 0 |
| `shasum -a 256 APPROVAL.md` | `a6d7b83d…`, equal to the seq 23351 `policy.updated` record |
| `approval doctor` (this worktree) | `attestation` pass at seq 23351, `log` pass at 23721 records |

A caveat on the scratch-path check: `expectationsFor()` answers with this repository's
pins only when the nearest `package.json` above the policy file names `approval-md`, so
`policy check --policy /tmp/…` exercises parsing and resolution and does **not** run the
pins. The pins run inside `approval policy amend` and inside `npm test`, which is where
they belong. The dogfood suite reads `APPROVAL.md` from the repo root in place and takes
no path argument, by design (it byte-compares the file before and after to prove it never
writes it), so it was run against the worktree's copy, which is byte-identical to
`origin/main`.

The log was read through `approval log export` into a scratch file. No byte under
`.approval/` was written.

## Risks

**Sealed delivery changes how every agent session receives a token.** It is already
live, so these are the failure modes in force today rather than ones an amendment would
introduce.

- **The private half is machine-local and action-local.** `approval request` writes it
  to `.approval/keys/<action-key>.key`, mode 0600 inside a 0700 directory beside the log,
  and unlinks it at three deaths: the token is consumed, the request expires, the grant
  is revoked. A key that outlived its grant would be a standing decryption capability for
  a ciphertext the log keeps forever, which is why the unlink is not optional.
- **A requester without the keypair falls back to the paste, and nothing breaks.**
  `approval wait --json` includes `token` only when this machine holds the private key,
  and `approval run` with no `--token` refuses `token-required` when the lookup finds
  nothing. The raw token is still printed once on the granting surface under sealed
  delivery, so the human relay path is preserved rather than removed. The cost of a lost
  key is one paste, never a lost authorization.
- **A grant is never refused over an unusable recipient key.** `sealToken` returns null
  and the grant stands (`src/core/seal.ts`): the authorization is the human's decision,
  the digest still binds it, and a convenience must not be able to void a human's yes.
- **Ask the request and the run from the same approval home.** The key is written under
  the checkout that opened the request. A session that requests against the primary and
  runs somewhere else finds no key and is back to `--token`. This is one more reason gate
  operations stay in the primary checkout.
- **The daemon is not in the seal's path.** A daemon that is down costs sampling (every
  supervised-live action gates) and costs nothing about sealed delivery: sealing happens
  at the mint site, on the grant. The two mechanisms fail independently.

**One thing found in passing, outside both tasks' scope.** `.approval/keys/` has no
`.gitignore` entry, while its siblings `.approval/daemon/`, `.approval/env`,
`.approval/vault.enc` and `.approval/log/verified-head.json` all do, and
`.approval/payloads/` is deliberately tracked (323 files under `.approval` are in the
index today). No key file exists right now and the unlink-at-consume rule means one
rarely sits on disk for long, but a `git add .approval/` during a records or ceremony
commit could sweep a live private key into a public repository, and a committed key
opens that action's `token_sealed` for anyone holding the log. This deserves its own
Backlog task: add `.approval/keys/` to `.gitignore`, and give `approval doctor` a row
for it the way it already has one for `.approval/vault.enc`.
