# CLI reference — the reasoning behind each verb

`approval <verb> --help` is the interface: the usage forms, the flags, the
`--json` shape, the refusal codes. This file is the other half — the design
rationale, the threat models, the points that surprise people on first reading,
and the alternatives that were rejected. It was moved here from the help texts
in APRV-91, mostly verbatim: an operator at a terminal wants the next thing to
type, and the reader who wants to know *why* is a different reader, at a
different moment.

The frozen exit-code table lives in `approval --help` and in `README.md`. The
cross-cutting stances every verb inherits — identity is declared and not proved,
a gate refusal is exit 1 and not 2, approval events are exclusive to the manual
path, the raw token is shown once, a channel is transport — are stated once at
the top of `approval --help` and are not repeated here.

Each section below is what the corresponding `--help` points at with its
`why: docs/cli-reference.md#…` footer.

---

## instructions

One source for two surfaces. SPEC.md §10.5's optional MCP server exposes the
same verbs as tools and shares the CLI's code paths, so it derives its tool
descriptions and input schemas from what `--schemas` prints rather than from a
second list that would drift from this one. The verb table at the end of the
guide is generated from the registry, so a verb that exists in the CLI and not
in the guide is a test failure rather than a documentation lapse. Verbs marked
`[HUMAN-ONLY]` record or establish a human's authority: an agent must not call
them, and a wrapper must not publish them as tools.

The output is a pure function of this build: no log is read, no policy is
resolved, and nothing is written.

## log

The three subcommands open the log for reading only. `verify` walks the hash chain
end to end and reports clean | torn-tail | corrupt, `tail` prints the last N
records (default 10), and `export` streams every stored line to stdout, byte for
byte. The default log path is `.approval/log/events.jsonl`, relative to the
working directory.

## log verify

Anomalies do not change the verdict. SPEC.md §8 stamps the timestamps of
gate-typed events (`approval.*`, `execution.*`, `budget.*`, `audit.*`,
`policy.updated`) at the write boundary, so a backwards step of more than 2s
between two of them means either a clock that stepped backwards or a timestamp
that was authored rather than stamped. A clean log with anomalies is clean and
still exits 0. Chain integrity is a proof; skew is a judgment. Folding the
judgment into the proof would turn this verb into a check people learn to pass a
flag to silence.

An unreadable log is exit 4, not 1: a permission bit is not evidence of
tampering.

**`--json`** (one object on stdout):

```
clean      {"status":"clean","records":3,"head":{"seq":3,"hash":"<64 hex>"}}
torn-tail  {"status":"torn-tail","records":3,"head":null,
            "intactThroughSeq":3,"message":"..."}
corrupt    {"status":"corrupt","records":null,"head":null,
            "firstBadSeq":2,"reason":"hash-mismatch","message":"..."}
```

`head` is null for an empty log. `reason` is one of `malformed-line`,
`schema-invalid`, `bad-alg`, `hash-mismatch`, `prev-mismatch`, `seq-gap`,
`seq-duplicate`, `not-genesis`, `head-mismatch`. `anomalies` is ADDITIVE and
appears only when there is something to report:

```
[{"kind":"gate-ts-regression","seq":9,"ts":"...","event":"execution.started",
  "previousSeq":8,"previousTs":"...","skewMs":45000,"message":"..."}]
```

Human output: the status and head on stdout; reason, first bad seq, anomalies,
and the full message on stderr.

## log tail

The chain is verified first. On a torn tail the intact records are printed and the
tear is a warning on stderr; on a corrupt log no records are printed at all. An
empty or absent log prints nothing and succeeds, and nothing is repaired.

Two human shapes, by whether colour is on. **In a pipe (and under `NO_COLOR`) the
fields are tab-separated**, one record per line — `seq`, `ts`, `event`, `actor`,
`task` — which is the shape `cut -f2` and every script that reads this verb rely
on, and it is not going to change. On a terminal the same fields are printed as
an aligned table, the seq right-aligned and the actor coloured by kind (human,
agent, system); the timestamp and the seq stay undressed because they are values
an operator copies.

```
{"status":"ok","records":[<event objects, oldest first>]}
{"status":"torn-tail","records":[...],"warning":"..."}
```

## log export

Without `--json` the stored lines are written verbatim, byte for byte: piping
export to a file yields a copy of the log. The chain is verified first; a torn
tail prints the intact lines with a stderr warning and exits 0, a corrupt log
prints nothing and fails. The log is never modified.

```
{"records":[<every event object, oldest first>]}
{"records":[...],"warning":"..."}   on a torn tail
```

## policy

`policy check` answers the question "what would policy do with this class", and
a policy too broken to load has a perfectly good answer — manual, everything,
always. That is why a load failure is exit 0 with a `manualBecause` of
`load-failure`, and why callers branch on `manualBecause` / `provenance` rather
than on the exit code.

`manualBecause` says why a manual answer is manual, and is null when the answer
is not manual:

- `matched-rule` — a classes rule, or `defaults.autonomy`, says manual. The
  policy was read and understood, and it says ask.
- `irreversibility-floor` — policy granted autonomous or supervised and SPEC §7's
  floor overrode it because `--reversible false` was given. `overridden` records
  what policy actually said.
- `load-failure` — the policy could not be loaded at all, so every class is
  manual. `loadFailure` carries a code and a message.

The exit codes, at length. `policy check|test` uses only 0, 2 and 4:

- **0** the question was answered, INCLUDING the fail-closed answer. A missing,
  unparseable or schema-invalid policy is not an error here: a broken policy IS a
  manual-everything policy, and "manual, because the policy failed to load:
  `<code>`" is the answer, delivered on stdout with exit 0.
- **2** usage: a missing `<class>`, an unknown flag, or a class that is not a
  valid action class (lowercase dotted segments; wildcards are patterns, not
  actions, and are rejected).
- **4** I/O: a policy path that exists but cannot be read (a permission bit).
  Never used for a parse or schema failure; those are the answer above.

1 and 3 are never returned by this command.

## policy check

`policy check` and `policy test` are the same command; SPEC.md §10.1 names both.
`<class>` is a concrete action class, never a pattern: `*` is something a policy
key may contain, never something an agent can do.

`--reversible` takes an explicit value because "unstated", "reversible" and
"irreversible" are three different questions. Only the explicit `false` engages
SPEC §7's irreversibility floor.

**`--json`** (one object on stdout):

```
{"class":"vcs.push.main","reversible":null,
 "outcome":{"autonomy":"supervised","approvers":null,"limits":null},
 "provenance":"rule"|"default"|"fail-closed"|"floor",
 "manualBecause":null|"matched-rule"|"irreversibility-floor"|"load-failure",
 "loadFailure":null|{"code":"file-missing"|"no-block"|"multiple-blocks"|
                     "yaml-error"|"schema-invalid","message":"..."},
 "matched":null|{"pattern":"vcs.push.main","rule":{"autonomy":"supervised"}},
 "overridden":null|{"pattern":"read.web"|null,"autonomy":"autonomous"},
 "candidates":[{"pattern":"read.*","specificity":[1,1,2],
                "autonomy":"autonomous","winner":true,
                "tieBreak":"specificity"|"strictest-autonomy"|
                           "lexicographic"|"tied-specificity"}],
 "decisionPath":["...","..."]}
```

`specificity` is [literalSegments, wildcardSegments, totalSegments] (SPEC §5.2).
`overridden.pattern` is null when the floor overrode `defaults.autonomy` rather
than a rule.

Human output: the `decisionPath` lines, then a final line `-> <autonomy>`
carrying "(fail-closed: `<code>`)" or "(floor applied over `<pattern>`:
`<autonomy>`)" when either applies. stderr stays empty on a successful answer.

## policy attest

Appending a `policy.updated` event records the SHA-256 of the policy file's
exact bytes. Gate operations refuse whenever the live file's hash differs from
the latest attestation or no attestation exists, with the distinct
machine-readable reason `policy-not-attested`. An edited policy is inoperative
until a human re-attests it.

Identity is config-declared: it comes from `--as` or `APPROVAL_HUMAN`, and
nothing here authenticates it. The trust boundary is the local machine — anyone
who can set that variable and write to the log is inside it. An attestation
therefore proves that someone with local control signed off, not who;
cryptographic identity is future work, not a v0.1 claim.

Bytes, not parse: the file is hashed as it sits on disk and does not have to be
loadable. Attesting a schema-invalid policy is allowed and records exactly what
it says — a human saw these bytes. It does not make a broken policy work; a
policy that fails to load is still manual-everything.

**`--json`** (one object on stdout):

```
success  {"ok":true,"seq":7,"sha256":"<64 hex>","path":"/abs/APPROVAL.md"}
refusal  {"ok":false,"error":{"code":"...","message":"..."}}  on stderr
```

`path` is the file that was hashed; the logged payload carries its basename only,
so an exported log leaks no home directory. The event's payload is
`{"policy_path":"APPROVAL.md","sha256":"<64 hex>"}`.

## policy amend

**Branch protection (the two flows).** A protected default branch rejects the
push that would land the amendment, so this verb detects one and offers the flow
that works. DIRECT is `git add` + `git commit` on the branch you are standing
on, then `git push origin <branch>`. BRANCH is `git checkout -b <name>`, the
same one commit, `git push -u origin <name>`, then `gh pr create` with a title
naming the seq and a body stating the one-commit rule. Merge that PR with a
merge commit, so the policy edit and its attestation stay one commit on main.

Detection runs `gh api repos/{owner}/{repo}/branches/<default>/protection`: exit
0 is protected, 404 is unprotected, and no `gh` / no GitHub remote / no readable
answer is UNKNOWN. It is read-only and it never fails the command: a probe that
could not answer leaves an attestation that already happened exactly where it
was. When the direct flow is about to push a protected default branch, the
report prints a one-line warning before the push command rather than letting
GitHub deliver the news.

**Baseline** (a stated limitation, flagged for human review): an attestation
records only the SHA-256 of the policy bytes, so the attested TEXT is not
recoverable from the log. When the policy lives in a git repository this verb
recovers `HEAD:<path>` and uses it as the baseline only if that blob's hash
equals the attested hash — proving the text being diffed is the text that was
signed for. Otherwise it drops to hash-only mode: it says so loudly, the
semantic diff is unavailable, and only the load advisory and the attestation
run. There is no `--baseline` flag, because a baseline supplied by hand is a
baseline nobody can verify.

`--commit` carries exactly two files: the policy and the log. It refuses outside
a git repository, and refuses when the index holds staged changes to anything
else — a commit that swept in an unrelated staged edit would make "this commit
is the amendment" false. On the branch flow it also refuses when there is no
`origin` remote, and when a `--branch` name already exists. Every one of those
refusals happens BEFORE the attestation, so a refused `--commit` never leaves an
attested policy without its commit.

**What it does, in this order.**

1. resolves the live policy file and hashes its bytes;
2. compares that hash to the latest attestation. EQUAL means nothing to amend,
   reported on stdout at exit 0;
3. recovers the last-attested policy TEXT if it can (see Baseline above) and
   prints the SEMANTIC diff, computed by the real engine on both versions;
4. runs the load advisory;
5. asks for confirmation (skipped by `--yes` and `--dry-run`);
6. attests: one `policy.updated` event, identical to `approval policy attest`;
7. prints, or with `--commit` runs, the git ceremony — `git add <policy> <log>`,
   a `git commit` citing the attestation seq, and the push (and, on the branch
   flow, the branch and the pull request).

**Flow precedence, highest first:** `--branch <name>` (with `--direct` it is a
usage error), then `--direct`, then detection — the branch flow when the default
branch is protected and checked out, the direct flow otherwise and when detection
is UNKNOWN.

**Confirmation** is interactive y/N by default. With stdin not a terminal (or
`--json`) and no `--yes` it refuses at exit 2 rather than assuming an answer.

**`--require-load`** refuses to attest a policy that does not load (exit 1,
nothing appended). Without it a load failure is a loud advisory and the
attestation may still proceed.

**`--json`** (one object on stdout; keys always present):

```
{"ok":true,"noop":false,"dryRun":false,"aborted":false,
 "policy":"/abs/APPROVAL.md","liveSha256":"<64 hex>",
 "attested":null|{"sha256":"<64 hex>","seq":2},
 "baseline":{"mode":"git-head"|"unavailable","reason":null|"..."},
 "diff":null|{"beforeFailure":null|{"code","message"},
              "afterFailure":null|{"code","message"},
              "structuralComparable":true,"probes":["..."],
              "classes":[{"class":"...","before":{"autonomy","provenance",
                "pattern"},"after":{...}}],
              "approvers":[{"approver":"...","change":"added"|"removed"|
                "channels-changed","beforeChannels":[...]|null,
                "afterChannels":[...]|null,"danglingRules":["..."]}],
              "defaults":[{"field":"autonomy"|"channel"|"approval_ttl"|
                "on_expiry","before":null|"...","after":null|"..."}],
              "budgets":[{"scope":"global"|"classes.<pattern>",
                "limit":"daily_usd","before":null|N,"after":null|N}],
              "unchanged":false},
 "load":null|{"ok":true|false,"code":null|"...","message":null|"..."},
 "attestation":null|{"seq":3,"sha256":"<64 hex>"},
 "git":null|{"repo":true,
             "protection":"protected"|"unprotected"|"unknown",
             "protectionReason":"...","defaultBranch":null|"main",
             "currentBranch":null|"main","flow":"direct"|"branch",
             "branch":null|"policy-amend-7","warning":null|"...",
             "commands":["git add ...","git commit -m ...","git push ..."],
             "committed":false,"pushed":false,"prUrl":null|"https://...",
             "output":null|"..."}}
```

`diff` is null in hash-only mode; `attestation` is null for a no-op, a dry run,
and an abort. In a dry run the commands carry the literal placeholder `<seq>`.
A refusal is `{"ok":false,"error":{"code":"...","message":"..."}}` on stderr.

**Refusal codes** (`error.code` with `--json`; frozen public API):

- `usage` — no identity, a non-human `--as`, an unknown flag, or a confirmation
  that could not be asked for.
- `io` — the policy file or the log could not be read or written.
- `load-failed` — `--require-load` and the policy does not load. Nothing was
  appended.
- `commit-preconditions` — `--commit` outside a git repository, with staged
  changes beyond the policy and the log, or (branch flow) with no origin remote
  or a `--branch` name already taken. Checked before the attestation; nothing was
  appended.
- `git-failed` — the attestation WAS appended and git then failed; the message
  names the seq and what to run by hand.
- `pr-failed` — the attestation was appended, committed and pushed, and
  `gh pr create` then failed.
- `append-failed` — the attestation append itself failed.
- `log-unreadable` / `log-torn-tail` / `log-corrupt` — nothing is amended from a
  log that does not verify.

## register

The task file is read only. Nothing is rewritten, so unknown frontmatter keys
are preserved trivially. The task id comes from the frontmatter's `id` — a
Backlog.md board key, not part of the envelope.

Registering the same task id twice is refused: two declarations of one id would
leave every later "what class is this key?" lookup guessing. An envelope that
changed after registration is `envelope.drift`, not a second registration. An
envelope that vanished after registration is `envelope-missing`: re-registering
a stripped file would narrow the record to what survives in it, so the runtime
refuses and a human restores the block from the log.

**`--json`** (one object on stdout):

```
success  {"ok":true,"seq":1,"task":"task-042","actions":1}
refusal  {"ok":false,"error":{"code":"...","message":"...","errors"?:[...]}}
```

The refusal goes to stderr, and `errors` carries the schema failures.

## request

The action's class, cost, reversibility and summary are read from the
`task.registered` record in the log — there are no `--class` or `--cost` flags.
An agent that could name its own class at request time could declare `read.web`
for an action registered as `financial.spend`, and SPEC.md §7's "the class MUST
be declared before a token can be requested" would mean nothing. Register once
from the file; request against what was registered.

Amended SPEC.md §6.3: `approval.*` events are exclusive to the manual path. An
action whose class resolves to supervised or autonomous emits no
`approval.requested` and no `approval.granted` — `approval request` appends
nothing and reports `proceed:true`. Its authorization is the `execution.started`
event, which is also where its budget is charged. Do not wait for a grant that
will never come.

**Order of checks**, each with its own refusal code: identity, attestation, class
resolution (including SPEC §7's irreversibility floor), then, on the manual path
only, the content binding (`payload-hash-required`, `payload-mismatch`), request
legality, budgets, the payload store write, and the append of
`approval.requested`. A refused request stores nothing.

`--payload` takes the action's concrete payload as JSON, and `-` reads stdin. Its
hash must equal the declared `payload_hash` and it is filed in
`.approval/payloads/<hash>.json`, which is where render and every channel read the
bytes from. Supply it here once and no channel needs `--payload-dir` or
`--payloads` at all.

**`--json`** (one object on stdout):

```
manual      {"ok":true,"task":"task-042","action_key":"...","class":"...",
             "autonomy":"manual","proceed":false,"requested":true,"seq":3}
non-manual  {"ok":true,...,"autonomy":"autonomous","proceed":true,
             "requested":false,"seq":null}
refusal     {"ok":false,"error":{"code":"...","message":"...",
             "verdicts"?:[...],"detail"?:"...","state"?:"...","seq"?:N}}
```

The refusal goes to stderr, and `seq` is the `budget.exceeded` record that WAS
appended.

## grant

Legal only on a request that is awaiting a decision. A second decision is
refused (`already-decided`): the log is append-only and a human's answer is not
overwritten.

Attestation is required: granting is the authorizing decision, so an unverified
policy cannot produce one.

Budgets are re-evaluated at grant time — the request may have aged in the queue
while other actions consumed the window, and the moment that matters for a
commitment is the moment the human commits. A failure appends `budget.exceeded`
and refuses. The appended `approval.granted` carries payload
`{"class","est_cost_usd"}` copied from the request: the budgets evaluator meters
authorization from exactly those two fields.

Tokens: a grant mints the single-use execution token for the action and prints
it once. The log records only its SHA-256 (payload `token_sha256`), so this
print is the only time the raw value exists outside the caller's memory and
nothing can recover it: not `approval token`, not the log, not the index.

TTL: a decision after the request's TTL is refused with `expired`, judged from the
request's OWN timestamp plus `defaults.approval_ttl`. When the gate discovers a
lapse it appends `approval.expired` (actor `system:gate`) and then refuses.

The raw token is printed once, on stdout, in a rule-boxed panel whose middle
line is the 64-hex value alone and undressed (so a triple-click copies exactly
the token), or as the `token` key with `--json`. Capture it, or revoke and
request again. Spend it with `approval run`.

**`--json`** (one object on stdout):

```
success  {"ok":true,"decision":"grant","state":"granted","action_key":"...",
          "seq":5,"token":"<64 hex>"}   (the token is shown once)
refusal  {"ok":false,"error":{"code":"...","message":"...","state"?:"...",
          "verdicts"?:[...],"detail"?:"...","seq"?:N}}  on stderr
```

## reject

Legal only on a request that is awaiting a decision. Attestation is NOT required
for this verb: it withdraws authority rather than granting it, and refusing it
because a policy file changed would leave a live authorization standing. No
budget is charged — an authorization that was refused was never a commitment.

TTL applies exactly as it does to [grant](#grant): a decision after the request's
TTL is refused with `expired`.

**`--json`** (one object on stdout):

```
success  {"ok":true,"decision":"reject","state":"rejected","action_key":"...",
          "seq":5}
refusal  {"ok":false,"error":{"code":"...","message":"...","state"?:"...",
          "detail"?:"...","seq"?:N}}  on stderr
```

## revoke

Legal only on a granted request that has not executed: an unexecuted grant can
be withdrawn, an executed one cannot be un-sent (`not-granted` /
`already-executed`). Attestation is not required, and no budget is charged, for
the reasons under [reject](#reject).

**`--json`** (one object on stdout):

```
success  {"ok":true,"decision":"revoke","state":"revoked","action_key":"...",
          "seq":5}
refusal  {"ok":false,"error":{"code":"...","message":"...","state"?:"...",
          "detail"?:"...","seq"?:N}}  on stderr
```

## withdraw

The requester takes its own pending question back (SPEC.md §6.3, amended
APRV-106). It is the only terminal gate verb that is not human-only, because the
party that asked is usually an agent and the whole point is that the asker can
stop asking.

**Why it exists.** On 2026-08-19 a builder ran `git commit --amend` through the
Claude Code hook. The hook classified it manual, appended `approval.requested`,
waited its nine minutes, got nothing, denied the tool call and moved on. The
request stayed pending for the policy's 24-hour TTL. Half an hour later the
human was pinged on their phone and approved it, and the grant authorized
nothing at all: the hook had answered long before, and a retried tool call is a
new request with a new key. A person spent attention on a question whose asker
had left. SPEC.md §11 makes human attention the audit budget, and a decision
nobody can consume must not be solicited.

**Requester-only.** The actor must equal the actor on the matching
`approval.requested`; anything else is `not-requester`. If any actor could
withdraw, the approver's queue would be clearable by whoever reached the log
first — which is the one property the gate exists to deny. A human who wants a
pending request gone **rejects** it, on the record, as themselves.

**Pending-only, and terminal.** `not-requested` when there is nothing to
withdraw, `already-decided` when a human has answered, `request-withdrawn` for a
second withdrawal, `expired` when the TTL has lapsed — judged from the request's
own timestamp exactly as a decision is judged, with the same lazy materialisation
of the `approval.expired` record. Once appended, a grant, rejection or revocation
is refused `request-withdrawn`. A withdrawn action that is still wanted is
requested again; that is a new request, and it gets its own decision.

**No attestation, no budget.** Withdrawal removes a question. It authorizes
nothing and commits nothing, so refusing it on an unattested policy would leave
requests standing in a human's queue because a file changed.

`--reason` is closed to `timeout`, `cancelled` and `superseded`, and an
unrecognized value is exit 2 rather than a silent default: an append-only log
should not put a word in the requester's mouth. `timeout` is what
`approval wait --withdraw-on-timeout` and the Claude Code hook write.

Channels drop a withdrawn request from the queue immediately (it is no longer
`requested`, and every channel derives its queue from that one predicate), and
the Telegram listener edits the message it already sent to say so and removes
the buttons.

**`--json`** (one object on stdout):

```
success  {"ok":true,"task":"...","action_key":"...","state":"withdrawn",
          "reason":"timeout","seq":7}
refusal  {"ok":false,"error":{"code":"...","message":"...","state"?:"..."}}
```

## expire

No identity is accepted or resolved: no human decides an expiry, the clock does,
and SPEC.md §8 names expiry as the example of a `system:`-originated event. This
is the verb the daemon's sweep calls; it exists in the CLI so the sweep is
testable and so an operator can run it by hand.

`defaults.on_expiry` is recorded in the payload. Its only v0.1 value, `reject`,
does not change the mechanics — an expired request is terminal either way — it
tells the projection layer to render the envelope state as rejected. Late
decisions are refused with `expired` whether or not this verb has ever run, and
`not-expired` also covers a policy that declares no `defaults.approval_ttl`: no
TTL means no lapse, and expiring a request the policy never bounded would be the
runtime inventing a deadline.

Refused when the request is not live (`not-requested`, `already-decided`) or when
the TTL has not lapsed (`not-expired`, which also covers a policy declaring no
`defaults.approval_ttl`).

**`--json`** (one object on stdout):

```
success  {"ok":true,"action_key":"...","actor":"system:gate","seq":6}
refusal  {"ok":false,"error":{"code":"...","message":"...","state"?:"..."}}
```

## gate refusal codes

The vocabulary every gate verb (register, request, grant, reject, revoke,
withdraw, expire) returns in `error.code` with `--json`. Frozen public API: an agent branches on it
to decide whether to fix itself, stop retrying, or ask a human.

- `policy-not-attested` — policy unattested or its bytes changed since
  attestation (detail: `not-attested` | `hash-mismatch` | `unreadable`). Run
  `approval policy attest`.
- `envelope-invalid` — the envelope failed `envelope.schema.json`, or the task
  file has no frontmatter or no `approval:` key.
- `task-file-unreadable` — the task file could not be read (exit 4).
- `task-already-registered` — this task id already has a `task.registered` record.
- `envelope-missing` — the file carries no `approval:` envelope AND the log holds
  a `task.registered` for its task: the envelope was LOST after registration.
  Nothing is appended; restore the block by hand from the log.
- `not-registered` — the task has no `task.registered` record.
- `action-not-registered` — the task declares no action with that idempotency key.
- `duplicate-request` — a live `approval.requested` already awaits a decision.
- `already-executed` — the action key already has an `execution.started`.
- `budget-exceeded` — budget verdicts failed; a `budget.exceeded` event WAS
  appended and `error.verdicts` lists the failures.
- `loop-escalated` — three consecutive `execution.failed` events escalated the
  task to manual (SPEC.md §10.2). Its MANUAL actions are unaffected; the streak
  clears on a completion.
- `not-requested` — there is no request to decide or expire.
- `already-decided` — the request is already granted, rejected, revoked or
  expired.
- `not-granted` — revoke was attempted on a request that is not granted.
- `request-withdrawn` — the requester withdrew the request before anyone decided
  it, or is withdrawing one it already withdrew. Distinct from `already-decided`:
  nobody answered, and nobody can now. Request the action again.
- `not-requester` — a withdrawal was attempted by an actor other than the one
  that opened the request. Only the party that asked may take the question back;
  anyone else who wants it gone rejects it.
- `expired` — the TTL lapsed, judged from the request's own `ts`.
- `not-expired` — expire was called before the TTL lapsed, or the policy declares
  no `defaults.approval_ttl`.
- `actor-invalid` — the actor is not a well-formed `human:` / `agent:` identity.
- `actor-not-human` — a human-only verb was attempted by another actor.
- `log-unreadable` (exit 4) / `log-torn-tail` (exit 3) / `log-corrupt` (exit 1):
  nothing is authorized from a log that does not verify.
- `append-failed` — the append itself failed; the exit code follows the cause.
  `head-moved` means the log grew between this command's read and its write, so
  nothing was written.

## token

The raw token is shown once, by `approval grant`, and is recoverable from
nothing. The log records only its SHA-256, which is the entire point: an
exported, copied, audited log grants its reader no power to execute.

So this command does not print the token — it cannot, and no future version can
without storing the secret the design exists to avoid storing. SPEC.md §10.1
lists "approval token `<action-key>`  # print single-use execution token if
granted"; the honest reading under the settled hash-only design is that the
token is printed BY grant and that this verb reports status. (Flagged for human
review.)

Exit 0 means granted, unrevoked, unexpired, unconsumed. Every other answer names
which of the three deaths applied: execution (`token-consumed`), revocation
(`token-revoked`), or the parent request's TTL (`token-expired`).

**`--json`** (one object on stdout):

```
live     {"ok":true,"action_key":"...","state":"granted","live":true,
          "token_sha256":"<64 hex>","grant_seq":4,"class":"...",
          "est_cost_usd":0.02,"payload_hash":"<64 hex>"|null,
          "task":"task-042"}
refusal  {"ok":false,"error":{"code":"...","message":"...","state"?:"...",
          "seq"?:N}}  on stderr
```

`payload_hash` is the binding the grant carried, or null for a grant that bound to
no bytes.

## token refusal codes

The vocabulary `approval token` and `approval consume` return in `error.code`.
Frozen public API in the same sense the gate's codes are.

- `not-granted` — no grant governs this action key: never requested, still
  awaiting a decision, or rejected. Ask a human, do not retry.
- `token-mismatch` — a grant exists but the presented token is not its preimage,
  or the grant predates tokens and carries no hash.
- `token-consumed` — already spent: an `execution.started` for this action key is
  in the log. A token is single-use; retrying cannot help.
- `token-expired` — the PARENT REQUEST's TTL lapsed. There is no separate token
  TTL; re-request the action.
- `token-revoked` — a human withdrew the grant (`approval.revoked`).
- `harness-executed` — the grant was for a request the requester declared
  `execution: "harness"` (the Claude Code hook), so no token was minted. Nothing
  is wrong and nothing is recoverable: the grant is complete, and it authorized
  a process that runs the command itself rather than through `approval run`.
  Distinct from `token-mismatch`, which would send an agent hunting for a token
  that deliberately never existed.
- `log-unreadable` (exit 4) / `log-torn-tail` (exit 3) / `log-corrupt` (exit 1):
  no token is spendable from a log that does not verify.
- `append-failed` — the append itself failed; the exit code follows the cause.
  `head-moved` means another writer got there first, which with one token is a
  refused double-spend, and nothing was written.

## consume

Internal. This is the plumbing verb `approval run` wraps; it exists in the CLI
so the token boundary is testable and so an adapter integration can be driven by
hand. It is the only sanctioned appender of `execution.started` on the manual
path: a manual action's start event cannot exist without a verified token behind
it.

Budgets are not charged twice: the evaluator counts an `execution.started` only
when the window holds no `approval.granted` with the same action key, so a
manual action costs its window exactly one charge — the grant.

Supervised and autonomous actions have no grant and therefore no token (amended
SPEC.md §6.3); this verb correctly refuses them with `not-granted`. Their
`execution.started` belongs to `approval run`.

`--payload-hash` is SHA-256 over the RFC 8785 canonical serialization of the
payload about to be executed. It is REQUIRED whenever the grant bound to bytes,
which under amended SPEC.md §6.2 is every manual grant this runtime mints. A
different hash, or none, is refused `payload-mismatch`, nothing is appended, and
the token stays live.

The appended `execution.started` carries
`{"class","est_cost_usd","token_sha256"}`.

**`--json`** (one object on stdout):

```
success  {"ok":true,"action_key":"...","event":"execution.started","seq":5,
          "token_sha256":"<64 hex>","grant_seq":4,"class":"...",
          "est_cost_usd":0.02}
refusal  {"ok":false,"error":{"code":"...","message":"...","state"?:"...",
          "seq"?:N}}  on stderr
```

## run

`run` is transparent: it exits with the child's exit code, because a wrapper
that swallowed the code would break every `&&` and every CI step that wrapped
it. A child killed by a signal is recorded and reported as 128 + signal number
(SIGKILL 137, SIGTERM 143), the shell convention. A command that could not be
spawned at all is recorded as exit_code 127.

A crash between `started` and its outcome leaves a **dangling execution**: the
log says truthfully that the action began and that nobody knows how it ended.
`approval status` reports it distinctly; `approval queue` does not (it is not a
pending decision). Nothing repairs it automatically — a second run for the same
key refuses rather than reconciling, because reconciliation would mean guessing
whether the side effect happened, and a guess in an append-only log is
indistinguishable from a fact. Recovery is a human recording the outcome they
actually observed, with `approval execution resolve`, which appends
`execution.completed` or `execution.failed` with `exit_code` null and
`attested_by_human` true, so no reader mistakes an observation for a
measurement.

Content binding (amended SPEC.md §6.2, §10): run computes the hash of the argv
and cwd it is about to spawn and presents it when spending the token. By default
that is right, because the command IS the action: an executor that had to be
told what it was running could be told wrong. An action whose grant bound to
content instead — an email body, a record write, a message and its recipients —
must pass `--payload-hash` with that content's hash. If the grant bound to
different bytes the spend is refused `payload-mismatch`, nothing is appended,
and the token stays live. A grant approves specific bytes.

Exit 5 is an addition to the frozen table, emitted by this verb alone, and it is
distinct from 1 because the repair is distinct: request the action, have a human
grant it, and pass the token that grant printed once.

**What it does, in this order.**

1. appends `execution.started` BEFORE the child is spawned, never after;
2. spawns the command with inherited stdio (the child owns the terminal);
3. appends `execution.completed` (child exit 0) or `execution.failed` (anything
   else), carrying `payload.exit_code`, the real number, unmapped;
4. exits with THE CHILD'S EXIT CODE.

Everything after the first `--` is the child's argv, passed through untouched.
Authorization: manual actions spend a token; supervised and autonomous actions
have no grant and no token, and for them run enforces attestation, loop
escalation, single-use idempotency, and budgets, which are charged here.

Recovery from a dangling execution:

```
approval execution resolve <action-key> --outcome completed|failed \
                           --note "<what you saw>" [--as human:<id>]
```

**`--json`** goes ON STDERR, because stdout belongs to the child:

```
success  {"ok":true,"action_key":"...","task":"...","class":"...",
          "autonomy":"manual","started_seq":5,"outcome":"execution.completed",
          "outcome_seq":6,"exit_code":0}
refusal  {"ok":false,"error":{"code":"...","message":"...","detail"?:"...",
          "verdicts"?:[...],"seq"?:N,"event_seq"?:N}}
```

**Refusal codes** (`error.code` with `--json`; frozen public API):

- `token-required` — the class resolves to manual and no token was given. Nothing
  was appended. EXIT 5.
- `action-not-registered` — no `task.registered` record declares this action key.
- `loop-escalated` — three consecutive `execution.failed` events escalated the
  task to manual; route it through a human grant instead.
- `policy-not-attested` — policy unattested or its bytes changed (detail:
  `not-attested` | `hash-mismatch` | `unreadable`).
- `already-executed` — an `execution.started` already exists for this key.
- `budget-exceeded` — budgets refused the start; a `budget.exceeded` event WAS
  appended and `error.verdicts` lists the failures.
- `not-granted` — manual action with a token but no grant behind it.
- `token-mismatch` — the presented token is not the grant's preimage.
- `token-consumed` — the token was already spent, including by a dangling
  execution, which run will NOT reconcile.
- `token-expired` — the parent request's TTL lapsed.
- `token-revoked` — a human withdrew the grant.
- `not-started` / `already-finished` — (finish path) no `execution.started` to
  close, or that execution already has an outcome.
- `log-unreadable` (exit 4) / `log-torn-tail` (exit 3) / `log-corrupt` (exit 1).
- `append-failed` — the append itself failed; the exit code follows the cause.

## wait

Polls the log and writes nothing — not even the `approval.expired` event it may
derive: expiry is judged lazily from the request's own timestamp, and
materialising it is `approval expire`'s job, not a reader's. The one exception is
`--withdraw-on-timeout`, below.

For `approval wait` the exit code IS the decision (SPEC.md §10.1). The
overloading of 1 (integrity / rejected) and 3 (torn tail / expired) is
deliberate: wait appends nothing and cannot fail a chain verification of its
own, and `--json` names the outcome exactly (`granted | rejected | withdrawn |
expired | timeout`) for callers that need more than a number. Flagged for human
review.

`withdrawn` (APRV-106) reuses exit **1** rather than claiming a new number. The
exit table in `src/cli/exit-codes.ts` is frozen public API and agents already
branch on its seven values; the fact a caller needs — this action is not
authorized and no retry of this request will change that — is exactly what 1
already carries. The distinction lives where one can be added without breaking
anyone: `status` in the `--json` object, and the state printed beside the action
in the human render.

Exit 6 is an addition to the frozen table, emitted by this verb alone: the wait
elapsed with request(s) still undecided, nothing was appended, the requests are
still live, and waiting again is legitimate.

**`--withdraw-on-timeout`** (APRV-106) changes only that last sentence. On
timeout, every request this actor opened and that is still pending is withdrawn
(`reason: "timeout"`), so nobody is asked a question the waiting process can no
longer answer to. It is OFF by default, because a caller that stopped waiting
has not necessarily stopped wanting an answer — a supervisor may wait again. It
needs `--as` (or `APPROVAL_HUMAN`), checked up front rather than after the wait,
since only the actor that opened a request may withdraw it. A withdrawal that
itself fails is reported on stderr and leaves the request live; the exit code is
6 either way.

**`--json`** (one object on stdout; a timeout goes to stderr):

```
decided  {"ok":true,"task":"task-042",
          "status":"granted"|"rejected"|"withdrawn"|"expired",
          "actions":[{"action_key":"...","state":"granted","seq":4}]}
timeout  {"ok":false,"task":"task-042","status":"timeout",
          "actions":[{"action_key":"...","state":"requested","seq":3}]}
```

`withdrawn` is added to the timeout object only when `--withdraw-on-timeout` was
passed, listing the keys actually retracted; the default shape is unchanged.

`state` is the per-action derived state; `status` is the whole task's outcome,
with rejected/revoked outranking withdrawn, withdrawn outranking expired, and
expired outranking granted. `--timeout` and `--interval` take the SPEC.md §5.2
duration grammar, `<positive integer><ms|s|m|h|d|w>`.

## queue

What it deliberately does not show — all of it lives in `approval status`:
dangling executions, attestation state, budget headroom, chain verification,
loop escalations. A decided, expired, revoked or executed action leaves the
queue and does not come back; operational debris never enters it. An inbox that
accumulates things nobody can act on is an inbox that stops being read, and this
one is the whole mechanism by which a human's attention is spent.

Exit 0 always when the log could be read: an empty inbox is a healthy inbox, not
an error.

What it lists: the action key, the task, the class, the declared cost, when it was
requested, and how much of the TTL is left.

**`--json`** (one object on stdout):

```
{"ok":true,"pending":[{"action_key":"task-042:chaser","task":"task-042",
 "class":"communicate.email.external","est_cost_usd":0.02,
 "requested_ts":"2026-08-06T10:00:00.000Z","seq":3,
 "ttl_remaining_ms":3599000}]}
```

`pending` is `[]` for an empty inbox. `ttl_remaining_ms` is null when the policy
declares no `defaults.approval_ttl` (no TTL means no lapse).

## status

`queue` is what a human must answer; `status` is what an operator must fix.
Neither shows the other's content, and a dangling execution is the clearest
case: it appears in status, never in the queue, because nobody is being asked to
decide it.

**dangling** is the state a crash between `execution.started` and its outcome
leaves. Nothing repairs it automatically; it clears only when a human records
the real outcome with `approval execution resolve`, which demands a mandatory
note, a human actor, and records `exit_code` null rather than inventing one.
Recording an outcome nobody observed is exactly the write this design refuses to
make casual.

**budgets** come from a zero-cost probe evaluated now: the numbers are what the
evaluator would say about a hypothetical next action declaring $0. Consequently
`remaining` for `daily_actions` already has that one action subtracted, because
every authorization counts as one. Class limits are absent by design — they need
a matched rule, and therefore a specific action, which status does not have.

**payload_store** carries the warning it exists to keep in front of an operator:
the store holds the bytes approvals bind to, and it is the one cache that cannot
be rebuilt from the log. QUEUE.md regenerates and index.sqlite reindexes; the
store does not, because the log records the hash a request bound to and never
the material. Deleting it loses those bytes for good, and the surviving binding
makes the loss visible: every manual request whose material went with it renders
`payload-unavailable`. `pruned` counts distinct hashes named by a
`payload.pruned` event — retention removes bytes and leaves that record behind on
purpose — and `orphans` counts store files no record binds. All of it is
informational: it moves neither the health verdict nor the exit code. An empty
store is the normal state of a repo that has never made a request carrying
`--payload`. (`approval doctor` is where an unwritable store is a failure.)

**anomalies** are informational for the same reason `approval log verify`
declined to refuse on them: status does not get to overrule that.

**`--verbose`** prints the rationale sentences under the rows they explain — at
v0.1 that is the payload-store paragraph above, which is the one row whose three
numbers a first-time reader cannot interpret unaided. It adds lines and moves
none: the rows themselves are byte-identical with and without it, and `--json`
does not know the flag exists.

**What it reports**, in one object:

- `attestation` — attested | hash-mismatch | not-attested | unreadable, with the
  seq of the governing `policy.updated` record.
- `verification` — the latest chain verdict, and the record count (null when
  corrupt).
- `dangling` — executions that started and never finished.
- `budgets` — headroom per configured GLOBAL limit, from a zero-cost probe.
- `loop_escalations` — tasks with three consecutive `execution.failed` events.
- `payload_store` — whether `.approval/payloads/` exists, how many files it holds,
  how many the log records as pruned, and how many are unbound. Informational.
- `anomalies` — additive and present only when non-empty: gate-typed events whose
  `ts` steps backwards by more than 2s. Informational.

**`--json`** (one object on stdout):

```
{"ok":true,"healthy":false,
 "attestation":{"state":"attested","seq":1},
 "verification":{"status":"clean","records":6},
 "dangling":[{"action_key":"...","task":"...","ts":"...","seq":5}],
 "budgets":[{"limit":"global.daily_usd","scope":"global",
   "window":"rolling-24h","consumed":0.02,"requested":0,"remaining":9.98,
   "pass":true}],
 "loop_escalations":[{"task":"task-042","consecutive_failures":3,
   "escalated":true}],
 "payload_store":{"present":true,"files":2,"pruned":0,"orphans":0,
   "note":"..."}}
```

`ok` is true whenever status ran; `healthy` is the verdict. `attestation.seq` is
null for not-attested and unreadable. `note` carries the unrebuildable warning
verbatim.

## doctor

status reports the health of the SYSTEM recorded in the log — attestation,
dangling executions, budgets, escalations. doctor reports whether this MACHINE
can run the system: the right build, a declared identity, a reachable channel. A
stale binary is invisible to status and is exactly what doctor exists to name.

**One line per check**, with its `fix` on one indented line under it, so a failed
run is counted rather than read. A detail is abbreviated with `…` only when a
terminal width is known and the row would overflow it; a pipe has no width and is
never abbreviated, `--verbose` turns the abbreviation off everywhere, and a
`fix:` line is never abbreviated on any path — repair instructions cut off
mid-command are worse than a wide line.

**Every fix begins with a command.** A `fix:` line opens with something you can
paste — `approval …`, `chmod …`, `echo …`, `export …`, `mv …`, `node …`,
`npm …` — and the prose explaining it comes after. An operator scanning a failed
run is looking for the next thing to type, and a line that opens with "check
that…" makes them read a sentence to find out there is nothing to type. Nothing
in that list deletes or commits: doctor repairs nothing, and a fix that told you
to `rm` or to `git commit` would be making the decision this project keeps human.

**Appends nothing.** Not an event, not a marker. An operator reaching for a
diagnostic while the log is in a state they do not understand must not have that
state changed by looking at it.

The checks, at length:

- **build-freshness** — `dist/src/cli/main.js`, the exact file the bin loader
  runs, is present and not older than the newest file under `src/` or
  `tsconfig.json`. Two shapes have their own message because both cost real time
  in a real ceremony: a STALE BUILD, where verbs that exist in the source are
  absent from the binary, and an UNBUILT CHECKOUT, where `cli.js` exists with no
  `dist/` behind it. A published install carries no `src/`, so freshness is
  unanswerable there and the check skips rather than passing.
- **identity** — `APPROVAL_HUMAN` names a `human:<id>`. Environment only, no
  `--as`: this reports what the next command will find.
- **attestation** — anything other than "the live bytes match" makes every gated
  operation refuse, and that refusal reads like "the policy says no" when it
  means "the policy is unverified".
- **log** — a torn tail and a corrupt log are both failures here; neither is
  repaired, and doctor never truncates a torn line.
- **telegram** — `getMe` against `--api-base`, when both variables are set;
  otherwise SKIP, because a runtime driven by `channel cli` is healthy without
  Telegram. Which variables those are comes from the policy this run resolved.
  getMe and nothing else: never `sendMessage`, which would buzz a human's phone
  for a diagnostic, and never `getUpdates`, whose offset a running listener owns
  — a decision tap consumed here would never reach the listener waiting for it.
- **web-port** — a port already HELD is a PASS with a note; the likeliest holder
  is this runtime's own `approval channel web`, and a doctor that cried broken at
  a working channel would train people to ignore it. Only a bind error meaning
  the config itself is wrong (EACCES on a privileged port) fails.
- **payload-store** — a store that does not exist yet passes (the first
  `--payload` request creates it); an existing directory this process cannot
  write FAILS, because a request already accepted by the gate would refuse
  `payload-store-failed` mid ceremony. The probe creates and removes one empty
  file and reads no payload.
- **audit-sampling** — sampling fails open by design (SPEC.md §5.2), so an
  unconfigured sampler silently audits nothing; this states the disabled reason
  out loud. A sampler nobody configured skips; a half-configured one fails,
  because someone intended sampling and is not getting it.
- **envelope-integrity** — every task file whose task the log registered still
  carries an `approval:` envelope. The loss this names was observed live
  (APRV-60): a task-file rewrite by a tool that did not know the key dropped it,
  and nothing refused. Nothing here rewrites a task file: the log holds the
  actions, and re-emitting the envelope from it would turn a projection into a
  source.
- **vault** — the gitignore check runs FIRST, because a vault about to be
  committed is the worse fault and stays wrong after every other problem is
  fixed. A wrong passphrase and an altered file are reported as one verdict on
  purpose, since telling them apart would confirm a guessed passphrase against a
  file someone had modified. Passes naming the credential COUNT and never a name
  or a value.
- **environment** — resolves exactly what `approval env --check` resolves, with
  one deliberate difference: a `keychain:` / `secret-service:` source is reported
  as DECLARED and is not looked up, because those helpers can block on an unlock
  or ACL prompt, and a diagnostic must never hang or ask a human for a password.
  Value-free by construction: it reads each variable's status and source and
  never its value, on any path.

**`--json`** (one object on stdout):

```
{"ok":false,"checks":[
  {"check":"build-freshness","status":"pass","detail":"..."},
  {"check":"identity","status":"fail","detail":"...","fix":"..."}, …]}
```

`status` is `pass` | `fail` | `skip`. `fix` is present only when there is
something to do, and it always begins with a runnable command. `ok` is true when
no check failed; a skip does not make it false. The eleven checks always appear,
in the order listed above.

`--root <path>` is TEST-ONLY: it points the build-freshness check at another tree
and moves no other check. Real invocations never pass it, because freshness is
judged against the installation this binary was loaded from, not against the
working directory.

## audit

Supervised actions execute immediately and are audited afterwards. The daemon
samples a fraction of them (`audit.supervised_sample_rate`) into a backlog a
person works through; SPEC.md §12 calls the human's attention the audit budget,
and this is where it is spent retrospectively rather than before the fact.

There is no `approval audit sample`. Selection is the runtime's, derived as
HMAC-SHA-256 over the event hash with an operator-held secret named by
`audit.sampling_secret_env` and kept outside this repository. A verb that let a
caller sample — or decline to sample — an action of its choosing would hand the
party under oversight the control that exists to oversee it. Seeding from event
content alone is forbidden by SPEC.md §5.2 for the same reason: the agent
authoring the event controls that content and could search it until its action
falls outside the sample.

If no secret is configured, sampling is off and this backlog stays empty.
`approval audit list` reports that beside the backlog, because an empty backlog
means one thing when sampling is running and quite another when it is not.

## audit list

A review closes a sample only when it comes AFTER it in the chain and names the
same action. An earlier `audit.reviewed` is a review of an earlier sample, and
treating it as covering this one would silently empty the backlog — which is
exactly the failure a sampled-audit backlog exists to prevent.

The secret itself is never printed, never logged, and never returned by any code
path; `sampling.secret_env` is the variable's NAME, which the policy file already
carries in the open.

**`--json`** (one object on stdout):

```
{"ok":true,
 "sampling":{"enabled":false,"rate":0.1,"secret_env":"APPROVAL_SAMPLE_SECRET",
             "reason":"secret-unset"},
 "open":2,
 "samples":[{"seq":9,"ts":"...","action_key":"...","task":"...",
             "subject_seq":7,"reviewed_seq":null}]}
```

`sampling.reason` is null when sampling is running, and otherwise one of
`policy-unreadable`, `rate-absent`, `rate-zero`, `rate-invalid`,
`secret-env-unnamed`, `secret-unset`.

## audit review

`--note` is optional — unlike `execution resolve`, this event records only that a
person looked, and the runtime is not relying on the note for a fact it does not
otherwise have. Human-only: a runtime that could mark its own samples reviewed
would be a supervision backlog that empties itself.

No attestation is required, for the reason `execution resolve` states: review
records an observation, exercises no policy authority, authorizes nothing, and
spends no budget. A review blocked because a policy file was edited afterwards
would be a supervision backlog held open by an unrelated fact.

What it appends is `audit.reviewed`, naming the sample's action key and task, with
payload `{"subject_seq":<seq of the audit.sampled>,"reviewed":true,"note"?:"..."}`.
An action key with several open samples refuses `ambiguous-subject`.

**`--json`** (one object on stdout):

```
success  {"ok":true,"seq":11,"sample_seq":9,"action_key":"...","task":"...",
          "actor":"human:alice"}
refusal  {"ok":false,"error":{"code":"...","message":"...","seq"?:N}}
```

## execution

A dangling execution is what a crash between `execution.started` and its outcome
leaves behind: the log says truthfully that the action began and that nobody
knows how it ended. Nothing in this codebase closes one automatically — an
automatic reconciliation would have to guess whether the email went out, and a
guess written into an append-only log is indistinguishable from a fact.

## execution resolve

`exit_code` is NULL, not 0 and not 127. Nobody ran anything and there is no code
to report; a fabricated exit code would read exactly like an observed one.
`attested_by_human` marks the difference for every reader and every projection.

`--note` is mandatory and non-empty: the event's entire value is the observation
behind it, and an unexplained human-attested outcome cannot be told apart from a
guess. Human-only — an agent closing its own dangling execution is the executing
party reporting on itself, which is the one thing the log exists not to accept.

No attestation is required: resolve records a fact a human observed, exercises no
policy authority, authorizes nothing, spends no budget, mints no token and
consumes nothing — the commitment was charged at authorization time, long before
the crash. A dangling execution left unclosable because a policy file was edited
afterwards would be a repair blocked by an unrelated fact.

**`--json`** (one object on stdout):

```
success  {"ok":true,"action_key":"...","task":"...",
          "event":"execution.completed","outcome":"completed","seq":7,
          "attested_by_human":true,"actor":"human:alice"}
refusal  {"ok":false,"error":{"code":"...","message":"...","seq"?:N}}
```

## channel

A channel is transport. It renders what the runtime derived and reports the
gesture a human made; it decides nothing, holds no state, writes no log line and
never sees an execution token. Every decision collected through a channel is
recorded by the same human-only gate `approval grant` and `approval reject`
call, with every rule — TTL, budgets, attestation, idempotency — applied
unchanged.

## channel cli

**The rendering convention (SPEC.md §9).** Every displayed field carries a
marker in the first column, and the marker is the whole point:

```
[computed] class            communicate.email.external      (log)
[claimed]  summary          chase invoice 41                (agent:drafter)
```

`[computed]` means the RUNTIME derived it — from the verified log, the attested
policy, the budget evaluator, the payload bytes, or arithmetic on the display
instant — and the parenthetical names which derivation. `[claimed]` means the
PARTY UNDER OVERSIGHT wrote it, and the parenthetical names the author. Claimed
fields are indented under their own heading. A claim may raise your scrutiny; it
is never evidence, and rendering one with the visual authority of a computed
field is a conformance failure for a channel, not a styling preference.

**The full payload (SPEC.md §10.4).** For a manual action the exact bytes the
approval binds to are printed verbatim inside delimiters, never mixed with the
agent's summary. The material comes from the payload store or `--payload-dir`,
and is hash-checked against the recorded binding before it is shown, so what is
inside the delimiters is what the execution token will spend. A manual request
with no material is skipped and reported on stderr — visibly, because a request
missing from a queue is a request nobody will approve.

**Identity is declared, not proved.** `--as`, else `APPROVAL_HUMAN`. The trust
boundary is the local machine: a decision recorded here proves that someone with
local control answered, not who. Missing or non-human identity on the deciding
path is a usage error, refused before anything is rendered.

Without a TTY, and always with `--json`, the queue is printed and the command
exits 0 without reading stdin. It cannot hang a pipeline, and it records nothing.

The full payload is printed verbatim inside delimiters:

```
--- BEGIN FULL PAYLOAD (bound sha256 <64hex>) ---
{ … }
--- END FULL PAYLOAD ---
```

A manual request whose material nobody holds is SKIPPED and reported on stderr. A
reject demands a note, and a grant prints its single-use execution token once.
`--payload-dir` takes one JSON file per action key, `<key>.json` or its
percent-encoded name; unset, the bytes come from `.approval/payloads/`. Either way
they are hashed and checked against the request's recorded `payload_hash`, and
material that does not match is refused rather than rendered.

**`--json`** (one object on stdout):

```
{"ok":true,"channel":"cli","interactive":false,
 "pending":[{"action_key":{"kind":"computed","value":"task-042:chaser",
   "source":"log"},
   "summary":{"kind":"claimed","value":"chase invoice 41",
     "author":"agent:drafter"}, …}],
 "skipped":[{"action_key":"...","code":"payload-unavailable",
   "message":"..."}]}
```

`pending` holds the TAGGED requests verbatim, so a machine reader sees the same
computed/claimed split a human does, and is `[]` for an empty queue.

## channel web

**Binds 127.0.0.1 and nothing else.** The loopback host is hard-coded, and there
is no flag, option or environment variable that widens it. That is not an
oversight: this server has NO AUTHENTICATION, so the loopback interface IS the
access control. A `--host 0.0.0.0` would turn "anyone with local access can
approve" into "anyone on this network can approve", from a flag that reads like
a convenience.

**No auth in v0.1 — the trust boundary (SPEC.md §11).** This page authenticates
nobody. Every decision is recorded against the actor from `--as` /
`APPROVAL_HUMAN`, so what it proves is "someone with access to this machine
answered", never "that specific person answered". The same caveat is printed in
a banner on the page, because the page is where the human is looking. CSRF:
there is no token in v0.1 — there is no session to protect, and anything that
can open a socket to the port can POST directly. A best-effort same-origin check
refuses clearly cross-origin POSTs (403); it is a speed bump, not a control, and
is flagged for review in the source.

Every value — claimed fields and payload bytes especially — is HTML-escaped:
they are agent-authored, and they are this page's entire injection surface.

**Batching (SPEC.md §10.3, B7).** The log never batches: each member gets its own
`approval.granted` / `approval.rejected` carrying the batch's delivery id. A
selection that would hide one member's full payload behind another is refused
(`batch-forbidden-mix`) with nothing recorded. A reject needs a note, batch or
not, and the requirement is enforced on the server (422).

**The execution token is shown on the page, once.** It is never written to the
log (which holds only its SHA-256), never put in a URL, and never shown again.
This differs from the Telegram channel, which refuses to put a token in a chat:
that transcript lives on someone else's servers, this page is served over
loopback to the person deciding, right now, and is persisted nowhere.

`--port` precedence is `--port`, then `channels.web.port` in the policy, then
4680. `--as` is required at startup: this page exists to record decisions, so a
server whose buttons could not record one is refused before the socket is bound
(exit 2). No JavaScript is required, and batching is one gesture over a ticked
set while the log still records one event per member.

**`--json`** (one object per line on stdout):

```
{"event":"listening","channel":"web","url":"http://127.0.0.1:4680/",
 "host":"127.0.0.1","port":4680,"actor":"human:alice"}
{"event":"stopped","notified":3,"views":7,"decisions":2,"refused":1}
```

## channel telegram

Identity is config-declared (SPEC.md §11). This channel does not authenticate
the person who taps a button: it checks that the callback came from the
configured chat, and records the decision against the human actor this process
was started with (`--as` / `APPROVAL_HUMAN`). The guarantee is "someone with
access to that chat, on a runtime configured by someone with local control,
approved" — not "that specific person approved". Anyone in the chat can approve
as the configured actor, so the chat's membership is part of your trust
boundary. Use a private chat with the bot. Cryptographic identity is future work.

Configuration is environment-only (SPEC.md §5.1): `APPROVAL.md` carries the
variable NAMES, never a token and never a secret, and there is no flag that
would put a bot token into a shell history or a process listing.

## channel telegram listen

**Delivery is per cycle, not only at startup.** Before every `getUpdates` the
listener re-derives the pending queue from the verified log and sends whatever
it has not already sent, so a request appended while this listener is running
reaches the phone on the next cycle without a restart. Decided and TTL-lapsed
requests fall out of that derivation and are never sent. A send that fails
leaves the request undelivered and is retried on every later cycle, with no
attempt limit — an unreachable Bot API must not turn into a pending request
nobody sees — though the stderr warnings thin out after a few consecutive
failures for the same request. A failure during the STARTUP send still exits
non-zero, so a mistyped token or chat id is immediate.

A callback from any chat other than the configured one is ignored: counted as an
anomaly, answered with a refusal, never turned into a decision and never written
to the log. A second tap on an already-decided request is refused
`already-decided` by the gate.

**Delivery bookkeeping is in memory only** (channels hold no state, §10.3). A
restarted listener re-sends everything still pending and the buttons on its
older messages stop resolving. Duplicated messages are the acceptable failure
mode; an approval that depended on a channel's memory would not be.

**The execution token is printed on this terminal's stdout and is never sent to
Telegram.** A chat transcript is stored on someone else's servers, backed up to
phones, and readable by anyone later added to the chat — it is not a credential
store. So the person who taps Approve on their phone does not receive the token;
the operator running this listener does.

**Reject collects no reason.** An inline keyboard has no text input, so a
rejection is recorded with the note "rejected via telegram (callback `<id>`)".
Use `approval reject --note` when the reason matters. (A ForceReply flow is a
follow-up, flagged rather than silently dropped.)

**Batching is deferred.** §10.3 permits one gesture over a set; Telegram binds
one keyboard to one message, and a batch carrying every member's full payload
would exceed the 4096-character limit long before the keyboard helped. `notify()`
still accepts a batch and sends one message per member sharing one batch delivery
id, so every event carries it — the semantics are there, the one-tap ergonomics
are not. One message per member also makes the annotation below per member:
deciding one member edits that member's message and leaves the others armed.

**A settled request stops looking live.** Every terminal state the listener
observes for a message it sent edits that message: the text becomes the outcome
(`✓ APPROVED`, `✗ REJECTED`, `✗ REVOKED`, `✗ EXPIRED`, `WITHDRAWN`) with the
action key, who decided, when, and the record's seq, and the buttons go in the
same call. A tap annotates immediately; a decision taken at the CLI or on the web
queue, a revocation, and an expiry the daemon appended are picked up on the next
poll cycle, which re-derives every delivered message's state from the verified
log. The edit is best effort — a failure is a stderr complaint, never a blocked
decision — and an annotation never carries the execution token.

The bot token and chat id come from the environment and the policy names the
variables (`channels.telegram.token_env` / `chat_id_env`, defaulting to
`APPROVAL_TG_TOKEN` and `APPROVAL_TG_CHAT`). There is no flag for either value.
Each message carries the computed fields, the agent's claimed fields under their
own heading, the full payload verbatim, and an inline Approve/Reject keyboard. The
loop survives the network: timeouts, dropped sockets and 5xx are counted,
complained about on stderr, and retried with a doubling backoff.

**`--json`** is one object per line on stdout, because a listener is a stream
rather than a query:

```
{"event":"notified","action_key":"task-042:chaser","delivery_id":"41"}
{"event":"annotated","action_key":"task-042:chaser","delivery_id":"41",
 "outcome":"granted"}
{"event":"decision","action_key":"task-042:chaser","decision":"grant",
 "ok":true,"seq":7,"state":"granted","token_issued":true}
{"event":"decision","action_key":"...","decision":"grant","ok":false,
 "code":"already-decided","token_issued":false}
{"event":"stopped","notified":1,"updates":1,"decisions":1,"pollErrors":0,
 "anomalies":{"foreign-chat":0,"malformed-callback":0,"unknown-callback":0,
 "key-mismatch":0}}
```

The raw execution token is never in the JSON stream.

## channel telegram health

Makes no network call. A health check that contacted the Bot API would announce
the bot from any shell and would fail for reasons (a captive portal, a rate
limit) that say nothing about whether the configuration is right. The live
counters — deliveries, decisions, ignored callbacks, recovered poll errors —
belong to a RUNNING listener: they are on its stderr as they happen, in its
`--json` "stopped" line, and programmatically on
`TelegramChannel.health()`/`stats()`.

Which variables are read comes from the policy, so a renamed variable reads back
as the name you set.

## init

`init` holds no authority: the policy it writes authorizes nothing until a human
reads it and attests it. What it scaffolds is SPEC.md §5.1's canonical example,
not your policy — it names an approver you are probably not and declares classes
you have not agreed to.

It never overwrites. init plans every target before writing any of them, then
writes only what is missing and reports the rest in `existing` with a per-file
code. A re-run in a scaffolded directory writes nothing and exits 0. A directory
carrying `APPROVALS.md` (the SPEC.md §5 fallback filename) already has a policy:
init reports `policy-exists` and writes no `APPROVAL.md` beside it.

Payloads are tracked. `.approval/payloads/` is deliberately not ignored: those
bytes are what each approval bound to, and evidence belongs in the history. To
ignore them instead, add `.approval/payloads/` yourself — the log keeps every
`payload_hash`, but the bytes behind them stop being rebuildable.

The per-file codes reported in `existing` are `policy-exists`, `log-dir-exists`,
`queue-exists` and `gitignore-entries-present`. `.gitignore` is the one file that
is merged, and no existing line is rewritten. A path of the wrong kind is a
refusal rather than a report: a directory named `APPROVAL.md`, or a regular file
where `.approval/` belongs, exits 4 with `error.code` `path-conflict` and nothing
is written. `approval policy attest` is what creates `events.jsonl`.

## hook

Exit 0 carries the verdict. Claude Code reads stdout as a decision only on exit
0, treats exit 2 as a block with stderr as the reason, and treats any other code
as a non-blocking error. So allow and deny are both exit 0 with JSON on stdout,
and exit 2 is reserved for a misconfigured hook (unknown flag, bad identity),
where blocking is the right failure mode. No new exit code is defined here.

The verdict is never "ask": the harness's own prompt would collect a decision
that no event records, no channel delivered, and no audit can reconstruct.

The classifier is best effort and is not scheming-robust (SPEC.md §11). It reads
the command text and nothing else — never the agent's own `description` field,
which is self-reported. The hard boundary remains the vault and the execution
token (SPEC.md §10.4). See `docs/claude-code-hook.md` for the settings.json
entry, which a HUMAN commits: it is `policy.edit`.

**What it decides.**

```
autonomous class   allow, and NOTHING is appended
supervised class   allow, after registering the task; no approval event exists
manual class       register + request, then WAIT for a human decision. Allow
                   on granted; deny on rejected, revoked, expired or timeout
gate.self          the "approval" CLI itself is pass-through
```

Bash commands are classified into SPEC.md §7 action classes; Edit, Write,
MultiEdit and NotebookEdit are gated only when the file is policy-protected
(`APPROVAL.md`, `.approval/`, `CLAUDE.md`, `AGENTS.md`, `.claude/settings*`,
`.github/workflows/`, `.npmrc`); every other tool passes through. `hook classify`
reads no log, resolves no policy and writes nothing; put the command after `--` so
its own flags are not parsed as this verb's.

**Deny reasons** (the reason string is `<code>: <detail>`):

- `hook-unclassified` — no rule covers some segment of the command.
- `hook-opaque` — a construct whose effect cannot be read from the text
  (`bash -c`, `eval`, backticks, a non-read substitution).
- `hook-unparseable` — the command line could not be tokenized.
- `hook-rejected` — a human said no.
- `hook-revoked` — a granted approval was withdrawn.
- `hook-expired` — the TTL lapsed before a decision.
- `hook-timeout` — no decision inside `--timeout`; the request stays live.
- `hook-gate-refused:<c>` — the gate refused intake; `<c>` is its own frozen code
  (`policy-not-attested`, `budget-exceeded`, …).
- `hook-policy-unavailable` — `APPROVAL.md` could not be loaded.
- `hook-log-unreachable` — there is no log where the hook was pointed. It is a
  writer to an existing log and never an initializer: a log scaffolded where the
  session happens to stand is a second chain forked from the real one's tail, and
  hash chains do not survive a merge. Run `approval init` and `approval policy
  attest` in the checkout named in the detail, or pass `--log`.
- `hook-io` — malformed hook input, or an unreadable log.

Set `--timeout` (default 55s) BELOW the hook timeout configured in
`.claude/settings.json`.

**Where the policy and the log come from** (they always come from the same
place, APRV-101). `--policy` and `--log` each win outright for their half.
Otherwise `--dir <d>` scopes BOTH: policy discovery in `<d>`, log at
`<d>/.approval/log/events.jsonl`, never relative to the session's working
directory. With neither, the hook runs `git rev-parse --git-common-dir` in its
working directory and takes that directory's parent as the PRIMARY checkout, so
a session in a linked worktree still reads and writes the one log the daemon
commits; a plain checkout resolves to itself, and with no git (or no repository)
the hook falls back to its working directory, as it always did.

## import agents-md

SPEC.md §2: AGENTS.md permissions lists are instructions an agent is trusted to
obey and nothing checks. This verb is the first step in making one checkable, and
the draft authorizes nothing — review it, paste it into `APPROVAL.md`, and run
`approval policy amend`, the ceremony that puts a policy in force.

A fixed, ordered keyword table decides the classes, first match wins: no model is
consulted, and the same bytes always produce the same draft. A bullet the table
cannot place is not guessed at. v0.1 has no forbid level, so "never" bullets are
rendered manual with a `# never:` comment — manual is not never; read those
lines. A class claimed by two sections resolves to the stricter autonomy (SPEC.md
§5.2, deny beats allow). No approvers and no channels are generated: a machine
must not name who may approve.

**What it recognises.**

```
region         a heading containing "permissions", at any level (or the three
               sub-headings on their own, the bare AGENTS.md layout)
allowed        "allowed without prompting" / "allowed" / "autonomous"
approval-first "require approval first" / "requires approval" / "ask first" /
               "approval required"
never          "never" / "forbidden" / "prohibited"
bullets        "- " / "* " list items under those headings; a wrapped
               continuation line is joined to its bullet
```

**How bullets become classes.** A fixed, ordered keyword table, first match wins.
The precedence order is `account.credential`, `vcs.history.rewrite`,
`policy.edit`, `vcs.push`, `vcs.push.main`, `release.publish`, `network.call`,
`deps.add`, `data.delete`, `vcs.commit.branch`, `exec.local`,
`files.write.workspace`, `read.*`. Every mapping carries its source bullet as a
`# from:` comment so the human can check the guess, and `from` in the JSON is the
bullet that DECIDED the autonomy (the stricter one on a conflict).

A bullet the table cannot place is preserved verbatim as a comment and listed
under UNMAPPED; a class claimed by two sections resolves to the stricter autonomy
and both bullets are named in a warning; unrecognised headings are reported, never
silently skipped; a file with no permissions section is exit 0 with an empty draft
and a warning. `--out` writes the draft YAML without the fence and refuses to
overwrite an existing file.

## payload hash

Canonicalization first is what makes the hash reproducible across
implementations that agree about the payload but not about key order, whitespace
or number formatting. This is the same function the runtime uses.

Bytes that do not parse as JSON are a usage error, not a hash: the binding is
defined over the canonical VALUE, so non-JSON input has no defined
`payload_hash`, and printing one would invent a binding no other implementation
could reproduce. Empty input is the same answer. A file that exists but cannot be
read is exit 4.

## render

Writes the queue projection of SPEC.md §9.1: "this is the screenshot; it is never
the truth". The file opens with a header saying so; editing it authorizes nothing
and is overwritten by the next render.

Full payloads are deliberately not inlined: the queue collects no decision, so it
carries the content binding only, and the decision channels present the bytes, as
SPEC.md §10.4 requires. Deterministic: the evaluation instant is read once and
handed to the pure renderer, so the same log rendered at the same instant
produces the same bytes. TTL countdowns are the only thing that moves between
renders of an unchanged log.

**`--json`** (one object on stdout):

```
{"ok":true,"out":"/abs/.approval/QUEUE.md","bytes":2481,
 "head":{"seq":7,"hash":"<64hex>"},"pending":2,"skipped":0,
 "audit_backlog":0,"now":"2026-08-06T10:00:00.000Z"}
refusal  {"ok":false,"error":{"code":"log-corrupt|log-torn-tail|
          log-unreadable|write-failed","message":"..."}}  on stderr
```

`head` is null for an empty log. `skipped` counts live requests the renderer could
not summarize; they are listed in the file with their reason, never dropped.

## reindex

The database is a cache; the log is the truth. The index is rebuilt from scratch
at a temporary path and renamed into place, so a crashed rebuild leaves the
previous index intact. A corrupt log is refused outright and a torn tail is
refused unless `--force` is given, which indexes the intact prefix and reports
`truncated: true`. The log itself is never written to, and `head` is null for an
empty log.

## daemon run

**Runs in the foreground** and stops on SIGINT/SIGTERM. It does not fork, write a
pidfile, or manage its own lifecycle: in v0.1 backgrounding is the operator's
business, and systemd, launchd, tmux and `&` all do it better than a bespoke
daemonizer would.

**Watching is a latency optimization, never a correctness dependency.**
`fs.watch` is bursty and platform-dependent, so every tick re-scans the folder
and re-derives everything from the verified log, and the periodic tick runs
whether or not any watcher ever fired. A daemon whose watchers failed to attach
is slower, not wrong; it says so in its first line.

**Single writer, in intent only.** While it runs the daemon is meant to be the
only writer, but the CLI verbs stay appendable: core's advisory lockfile
serializes the writes, and every append here carries the head it decided against,
so a concurrent CLI append refuses the daemon's write rather than corrupting it.
The daemon tolerates that by re-reading — the next tick re-derives the whole
question from the log as it now is. It holds no lock of its own.

A log that does not verify stops the daemon rather than degrading it: nothing may
be appended onto a chain that does not verify, and a projection of one would be a
screenshot of something nobody should read.

**Write-back** happens after the events above are appended and never before: the
log is the truth and the file is its projection. Exactly the `state:` line
changes; every other byte, key, comment and line ending is preserved. So a drift
record marks a file found wrong AND fixed; a file that keeps drifting is one
another writer is fighting over.

**Git evidence (`--git-evidence`, off by default).** SPEC.md §8's optional
hardening: a second, independent record of the same bytes, one an operator can
clone and diff from somewhere the tamperer does not control. The daemon commits
the log file and the payload store to the log home's own repository after each
tick that moved the head, authored as itself ("approvald `<version>`", fixed
noreply address, never your git identity). The log home must be its own
repository root and must not sit inside any outer working tree: a hash chain does
not survive a merge, and an outer repository's rebases, amends and force-pushes
rewrite the bytes the evidence is made of. The nested layout stays fully valid
WITHOUT the flag; the two patterns do not mix. See `docs/git-evidence.md`.

**Each tick, in order.**

- ENVELOPE DRIFT — a task file whose `state:` contradicts the log gets an
  `envelope.drift` event (actor `system:daemon`), once per claim.
- TTL SWEEP — every live request whose TTL lapsed gets an `approval.expired`
  through the same `approval expire` the CLI calls; idempotent.
- WRITE-BACK — every task file whose `state:` still disagrees is rewritten to
  match the log, after those appends. A file the writer cannot round-trip safely
  is left alone with a `write-back-refused` warning.
- LOOP ESCALATION — tasks with three consecutive `execution.failed` are reported
  when they escalate and when they clear.
- QUEUE — `.approval/QUEUE.md` is regenerated through the same renderer
  `approval render` uses, temp-then-renamed.

`--tasks` named explicitly and missing is an error; absent by default is a warning
and the daemon runs log-only. `--interval` defaults to 30s and `--debounce` to
250ms. Git-evidence refusals at startup: `git-unavailable` and `log-dir-missing`
exit 4; `log-dir-not-repo` and `log-dir-nested` exit 2.

**`--json`** is one object per line on stdout:

```
{"event":"started","log":".approval/log/events.jsonl","tasks":"backlog/tasks",
 "queue":".approval/QUEUE.md","interval_ms":30000,"debounce_ms":250,
 "watching":true}
{"event":"drift","task":"task-042","file":"backlog/tasks/task-042.md",
 "declared_state":"approved","derived_state":"awaiting","seq":9}
{"event":"expired","action_key":"task-042:chaser","task":"task-042","seq":10}
{"event":"sampled","action_key":"task-042:draft","task":"task-042","seq":11,
 "subject_seq":8}
{"event":"pruned","payload_hash":"<sha256 of the payload>","reason":
 "payload_retention","action_key":"task-042:chaser","task":"task-042","seq":12}
{"event":"rendered","path":".approval/QUEUE.md","bytes":2481,"pending":1,
 "skipped":0,"audit_backlog":0}
{"event":"escalated","task":"task-042","consecutive_failures":3}
{"event":"escalation_cleared","task":"task-042"}
{"event":"tick","n":1,"head":10,"drift":1,"expired":1,"escalated":0}
{"event":"stopped","reason":"SIGINT","ticks":3,"drift":1,"expired":1,
 "renders":3}
{"event":"git_evidence","commit":"a1b2c3d","seq":10,
 "hash":"<sha256 of the head record>","records":2}
```

Warnings go to stderr as `{"event":"warning","code":"...","message":"..."}`, with
`code` one of `task-unreadable`, `frontmatter-invalid`, `envelope-invalid`,
`task-id-missing`, `tasks-dir-unreadable`, `append-refused`, `expire-refused`,
`render-failed`, `watch-unavailable`, `prune-refused`. A warning never stops the
loop, and neither does `{"event":"git_evidence_failed","step":"commit",…}`.

Payload retention: with `payload_retention` set in policy, each tick appends
`payload.pruned` and THEN removes the payload file for every payload whose action
has been terminal longer than the duration, and for orphaned store files. With the
key absent nothing is ever pruned. One `pruned` line is emitted per removal that
both appended its event and unlinked its file; a prune whose unlink failed is a
`prune-refused` warning instead. One `sampled` line is emitted per `audit.sampled`
the tick appended, so a supervised action drawn for retrospective review is named
rather than inferred from the queue's backlog. `rendered` is emitted when the queue's summary
CHANGES; the file itself is rewritten every tick, because TTL countdowns move even
when the log does not.

## vault

**There is no `approval vault get`**, and it is not an oversight. A verb that
printed a credential would put it in a terminal, a scrollback buffer, a CI log
and — through the shell that ran it — a history file. A credential's only
sanctioned journey is from the vault into an adapter, inside the verified-token
window the adapter contract holds open (SPEC.md §10.4: "the credentials only
answer to tokens"). Names are visible; values are not.

**What the vault DEFENDS:** credentials at rest, and casual reads by an agent
that can read files in the working tree — the ciphertext hides the NAMES as well
as the values.

**What it does NOT defend** (SPEC.md §11, plainly): a compromised host, and an
agent that can read the passphrase variable. That agent does not need this CLI;
it can decrypt the file itself. Keep the passphrase in an operator-held
environment and outside every agent-readable path.

All three subcommands are human-only, exactly as `policy attest` requires.
Identity is declared, not proved; the check is what stops an agent's tooling from
storing or deleting a credential in passing.

The file is AES-256-GCM over a JSON map of name -> credential, under a key
derived by scrypt (N=16384, r=8, p=1, 32-byte key) from a passphrase read from
the environment variable named by the policy's `vault.passphrase_env`. The policy
carries the variable NAME and never the value, the same convention as
`channels.telegram.token_env` and `audit.sampling_secret_env`.

**Appends nothing to the log.** A credential's existence is configuration, not an
authorized action, and a log line naming the credentials an operator holds would
be a map of the machine's reach written into the one file this project promises
never to rewrite.

## vault set

The value is never a command-line argument: a secret on a command line is a
secret in the shell history and in `ps` output for the length of the call.

One trailing newline is stripped from stdin and nothing else: interior whitespace
is preserved, because some tokens legitimately contain it and a silently trimmed
credential fails at the far end with no local evidence of why. An empty value is
refused rather than stored.

Every write re-encrypts the whole map under a fresh nonce and lands atomically
(temp file at mode 0600, then rename), so an interrupted write leaves the
previous vault intact and two writes of the same value never produce the same
bytes on disk.

The value comes from stdin:

```
pass show smtp/app | approval vault set smtp-password
approval vault set api-key <<'EOF'
sk-live-…
EOF
```

or from a variable named with `--value-env`:

```
APPROVAL_TMP_SECRET="$(op read op://vault/item/field)" \
  approval vault set api-key --value-env APPROVAL_TMP_SECRET
```

**`--json`** (one object on stdout):

```
{"ok":true,"name":"smtp-password","created":true,"count":2,
 "path":"/…/.approval/vault.enc"}
```

`created` is false when the name was already present and has been replaced. The
VALUE appears in no field, on either the success or the failure path.

## vault list

A vault nobody created is a state, not a fault: when the file does not exist this
says so and exits 0. A runtime driven by `approval run` and the CLI channel never
needs a credential, exactly as a runtime with no Telegram configuration is
healthy without one. The passphrase is not read in that case, so an absent vault
reports absent rather than complaining about an unset variable.

A wrong passphrase and an altered file both refuse `vault-unreadable` and are not
distinguished: a runtime that told you which would let someone confirm a guessed
passphrase against a file they had modified.

**`--json`** (one object on stdout):

```
{"ok":true,"present":true,"path":"/…/.approval/vault.enc","count":2,
 "names":["api-key","smtp-password"]}
{"ok":true,"present":false,"path":"…","count":0,"names":[]}
```

The second form is a vault that does not exist.

## vault remove

A name the vault does not hold refuses `credential-absent` rather than reporting
success: an operator removing a credential wants to know whether they removed the
one they meant.

Removing a credential an adapter still needs makes that adapter refuse
`credential-unavailable` at execution time. Nothing here checks for that, because
the check would require this verb to know every adapter a machine might run.

**`--json`** (one object on stdout):

```
{"ok":true,"name":"api-key","count":1,"path":"/…/.approval/vault.enc"}
```

## adapter

An adapter is the hard boundary of SPEC.md §10.4: it holds the credentials and
refuses to act without a valid, unexpired, single-use execution token bound to
the action's `idempotency_key` and its `payload_hash`. An agent that bypasses
this CLI still cannot send, because the credentials only answer to tokens.

The runtime, not the adapter, owns the sequence: recompute the payload hash,
verify and consume the token, append `execution.started`, call the adapter,
append `execution.completed` or `execution.failed`. The adapter implements one
method and cannot skip a step, because it never holds the sequence.

## adapter email

`bcc` is inside the hash and appears in no header: a blind recipient is still a
recipient, and an approval that did not cover them would approve a different act.
Addresses are plain ASCII `local@domain` — no display names, no angle brackets,
no internationalized addresses (this client does not negotiate SMTPUTF8). Unknown
keys are refused rather than ignored.

Two fields are stamped by the runtime and are not part of the hash. `Date` is the
moment of the send: the grant binds the message CONTENT, and a Date inside the
payload would make every grant expire into a `payload-mismatch` as soon as the
clock moved. `Message-ID` is SHA-256 over the action key and the payload hash at
the From domain — deterministic, so an operator holding the log can recompute the
exact Message-ID the far side saw and trace a bounce back to an approval.

`smtp.security` "starttls" is a MANDATORY upgrade: a server that does not offer
it is a failure, never a silent downgrade. A credential is never sent over
"none". Storing neither `smtp.user` nor `smtp.password` means an unauthenticated
relay; storing exactly one is refused, because sending unauthenticated because
half a credential is missing puts the message on a path nobody configured.

No credential value reaches the log, this command's output, or an error message:
the adapter scrubs every diagnostic it builds, and the contract scans everything
the adapter returns for the values it handed out and redacts them again.

The payload, whose RFC 8785 canonical hash is what the grant approved:

```
{"from":"a@example.com","to":["b@example.com"],"cc":[…],"bcc":[…],
 "subject":"…","body":"…","content_type":"text/plain"|"text/html"}
```

There is deliberately no flag that takes the message inline: a body on a command
line is a body in the shell history. `--timeout` is the whole-SMTP-session budget
in milliseconds (default 30000), and exceeding it is recorded as
`execution.failed` with `smtp-timeout`. A non-ASCII body is sent
quoted-printable and a non-ASCII subject as RFC 2047 encoded-words; an all-ASCII
body is sent 8bit, byte for byte as approved.

**Failure codes** (in `adapter_code`):

- `email-payload-invalid` — the approved bytes are not a well-formed email.
- `email-config-invalid` — the vault holds unusable SMTP configuration.
- `credential-unavailable` / `credential-refused` — the vault could not supply a
  name. Nothing was sent.
- `smtp-connect-failed` / `smtp-tls-failed` / `smtp-timeout` /
  `smtp-protocol-error`.
- `smtp-<NNN>` — the server refused a verb; NNN is its own reply code
  (`smtp-535` authentication, `smtp-550` mailbox, …).

**`--json`** carries the adapter contract's own result, unmodified. On a completed
send, on stdout:

```
{"ok":true,"adapter":"email","action_key":"…","task":"…","class":"…",
 "autonomy":"manual","payload_hash":"<64hex>","started_seq":N,
 "outcome":"execution.completed","outcome_seq":N,"exit_code":0,
 "detail":{"message_id":"<…>","recipients":N,"bytes":N,"secure":true,
           "auth":"PLAIN","smtp_code":250,"transcript":[…]},"redactions":0}
```

On a refusal, on stderr:

```
{"ok":false,"code":"…","message":"…","adapter":"email","action_key":"…",
 "acted":true|false,"started_seq":N,"outcome":"execution.failed",
 "outcome_seq":N,"exit_code":1,"adapter_code":"smtp-550","redactions":0}
```

## env

This command is the only thing that reads `.approval/env`, and its default output
carries secrets, deliberately: its job is to put them into your shell. No other
verb loads that file. Human identity (`APPROVAL_HUMAN`) is one of the variables
it can carry, and in v0.1 identity is config-declared (SPEC.md §11), so a
working-tree file that any process read on its own would let anything able to
write that file act as you on every human-only verb — `policy attest`, `grant`,
`vault set`. The file is inert; a human evaluating this output is what makes it
take effect (SPEC.md §11.1 invariant 7).

A plaintext literal is PERMITTED, and always reported as plaintext by `--check`
and by `--json`. A rule people route around is not a control. Near misses of the
real schemes (`keyring:`, `secret_service:`, `plaintext:`, `vault:`, …) are
reserved and refused rather than silently exported as their own text, since a
mistyped source would otherwise surface as a 401 from the far end hours later.

The value is never put in an argv: the helper commands receive a service name or
a label and hand the secret back on stdout.

Already-exported values win. A variable set in this shell is reported
`set-in-environment` and its line in the file is not consulted: your shell is the
authority, and a file that could override it would be a file that silently
redirects a gate operation's credentials.

Exit 0 even when variables are unresolved, because the output is destined for
`eval` and a shell function that failed on an unconfigured channel is one nobody
keeps in their profile. `--check` is the path with an opinion. A defaulted
variable nobody mentioned is an offer, not a promise.

**The file.** One `KEY=VALUE` per line, `#` comments and blank lines ignored, no
quoting and no interpolation, mode 0600 (anything else is refused with the chmod
to run), and gitignored by `approval init`. VALUE says WHERE the value lives:

```
KEY=keychain:<service>       macOS: security find-generic-password -a "$USER"
                             -s <service> -w
KEY=secret-service:<label>   Linux: secret-tool lookup approval <label>
KEY=env:                     inherited from the shell that launched you
KEY=<value>                  a plaintext literal
KEY=literal:<value>          the same, spelled out, for a value that begins
                             with something that looks like a scheme
```

A value with some other `word:` prefix is a literal, not an error.

**Which variables are answered for:** `APPROVAL_HUMAN`, the Telegram token and
chat id, the vault passphrase, the sampling secret when one is named, and any
other string-valued key ending in `_env` anywhere in the loaded policy. An absent
file is not an error. Unresolved variables are printed as `#` comments naming the
repair.

**`--json`** (one object on stdout):

```
{"ok":true,"path":"/…/.approval/env","present":true,
 "variables":[{"name":"APPROVAL_TG_TOKEN","status":"resolved-from-keychain",
               "source":"keychain:approval-tg","plaintext":false,
               "declared":true,"value":"…","fix"?:"…","refusal"?:{…}}]}
```

`status` is one of `set-in-environment` | `resolved-from-keychain` |
`resolved-from-secret-service` | `resolved-literal` | `unset`. `value` is present
only when there is one AND `--check` was not passed. `ok` is the `--check` verdict
on every path.

## setup

**Channel and adapter are two nouns, not one list, and SPEC.md §4 is why.** A
channel surfaces requests and collects decisions and holds no state, so its setup
fills the OS keystore and `.approval/env` — the map of where the values that
unlock the machine live. An adapter executes side effects and holds credentials,
so its setup fills `.approval/vault.enc`, which holds the values a gated adapter
SPENDS, read inside the verified-token window and by nothing else. There is no
verb that prints one back. (An older build spelled the Telegram one without the
`channel` noun. That form exits 2 and names this one; there is no alias, because
two spellings of a distinction the SPEC draws on purpose is how the distinction
stops being drawn.)

**Every subcommand refuses when stdin is not a terminal**, and when `--json` is
given, and exits 2 printing the exact non-interactive commands to run instead. A
setup that a pipe could drive would be a way for a CI job or an agent to declare a
human identity and store a credential, and identity in v0.1 is config-declared
(SPEC.md §11): establishing it is an act of the human at the machine.

**It never appends to the log, attests anything, or edits `APPROVAL.md`.** When a
policy line is needed it prints the `approval policy amend` ceremony and stops: an
amendment ends in a human attestation, and a wizard that edited an attested policy
would be forging the sign-off.

**A value you already hold is never handled by this process.** The Telegram token
is collected by the keystore helper's own no-echo prompt (`security
add-generic-password … -w`, with no value on the command line), and reaches this
runtime only by being read back on stdout. Values this runtime GENERATES (the
passphrase, the sampling secret) go to the helper on its stdin; if a helper will
not take stdin, the fallback puts a just-minted value in an argv and says so.

**What each subcommand is for.**

- `identity` — declare who the human is (`APPROVAL_HUMAN`).
- `vault` — mint a vault passphrase, store it, and record where it lives.
- `sampling` — mint the audit sampling secret, store it, and print the policy
  line that turns sampling on.
- `channel <name>` — configure one channel's transport credential. For telegram
  that is collecting the bot token, proving it with getMe, discovering the
  approver chat, and recording both variables.
- `adapter <name>` — fill the vault with one adapter's credentials, asked for
  from the manifest that adapter declares, and prove them against the service
  without sending anything.

**Where secrets go.**

```
macOS (security on PATH)     keychain:<service>
Linux (secret-tool on PATH)  secret-service:<service>
neither                      offered as a PLAINTEXT literal in .approval/env,
                             taken only on a typed `yes`, and reported as
                             plaintext by `approval env --check` ever after

approval-tg-token            the bot token
approval-vault-passphrase    the vault passphrase
approval-sampling-secret     the audit sampling secret
```

What it writes is `.approval/env` (one `KEY=VALUE` line per variable, mode 0600,
every other line and comment preserved) and items in the OS keystore.

## setup identity

Not human-only, unlike every other setup subcommand, and that is not a hole: a
verb that required `APPROVAL_HUMAN` before it would let you set `APPROVAL_HUMAN`
could only be run by someone who did not need it. The terminal is the control on
this path.

This is config-declared identity (SPEC.md §11). The trust boundary is this
machine: whoever can set the variable and write to the log is inside it. v0.1
makes no cryptographic claim about who attested.

A bare id is enough. The prompt prints the `human:` prefix because it is what
separates a human from the `agent:` and `system:` actors the human-only verbs
refuse — but a prefix the question already showed you does not have to be
retyped. An answer that does not fit gets one line saying why and the same
question again.

The line it writes is inert. No verb reads `.approval/env` on its own (SPEC.md
§11.1 invariant 7); `eval "$(approval env)"` is what puts it in your shell.

An answer that does not fit gets one line saying why and the same question again;
Ctrl-C or Ctrl-D writes nothing. Refusing a non-terminal stdin, it prints the
export line to use instead.

## setup vault

Warns first if `.approval/vault.enc` already exists. A vault is encrypted under
its passphrase and cannot be re-keyed by changing a variable: every credential in
it becomes unreadable. The warning comes before the generation, and the
confirmation defaults to no.

The generated value reaches the keystore on the helper's stdin. If this build of
the helper will not take stdin, the fallback passes it in an argv and says so: a
value minted one moment earlier, never used, visible in `ps` to your own user for
the length of one call. That trade is made for generated values only.

## setup sampling

Selection is HMAC-SHA-256 over the event hash under this secret. Seeding from
event content alone is forbidden: the agent authoring the event controls that
content and could search it until its action falls outside the sample.

If your policy names no `audit.sampling_secret_env`, the secret is recorded under
the conventional name `APPROVAL_SAMPLING_SECRET` and sampling stays off — §5.2
disables it whenever the policy names no variable, and this verb does not edit an
attested policy file. It prints the block to add and the `approval policy amend`
ceremony that attests it.

## setup adapter

The manifest is the adapter's, so the names this verb writes are by construction
the names its `act` reads.

The passphrase is read, never established. It comes from the environment variable
your policy names in `vault.passphrase_env`, exactly as `approval vault set` reads
it. This verb does not resolve `.approval/env` (SPEC.md §11.1 invariant 7) — run
`approval setup vault` and then `eval "$(approval env)"` first. With the variable
unset, nothing is stored and no vault is created.

The values go into the vault, not into the OS keystore and not into
`.approval/env`: what this verb stores is what a gated adapter spends inside a
verified-token window.

What it reports: the path, the count, the names written and the names left alone.
Never a value, on any path, including a failed probe. Exit 1 means the service
refused the stored configuration, or the vault would not open; the values are kept
either way and the undo is printed.

## setup adapter email

A port that is not a port and a security setting that is not one of the three
words are refused HERE, in the words `approval adapter email` would have used at
send time. A username without a password (or the reverse) is refused before
anything is stored: sending unauthenticated because half the credential is
missing would put the message on a path nobody configured.

The probe sends nothing. It is the same SMTP session a send runs — connect, EHLO,
STARTTLS, AUTH — and then QUIT. It proves the host answers, that the TLS mode is
the one the server offers, and that the credential is accepted. It does not prove
delivery, and it puts no message on the wire.

A failed probe keeps the values. A laptop behind a captive portal is not a reason
to make you type five things again. The refusal prints the SMTP code and the
server's first line, with the credential redacted, and the undo.

The five names, and what each answer is checked against:

```
smtp.host      the submission server
smtp.port      587 for STARTTLS submission, 465 for implicit TLS
smtp.security  implicit | starttls | none, picked from a numbered list
smtp.user      optional, and both-or-neither with the password
smtp.password  optional, read with no echo, written last
```

The probe defaults to yes and can be declined; declining stores the values and
says they are unverified.

A partial re-run is probed too (APRV-99). Rotating an app password replaces one
name and leaves four alone, so the run does not hold the whole configuration, and
this verb used to stop there: it will not read the missing values back, because
there is no verb in this CLI that reads a credential out of the vault. That rule
is about PRINTING, and the inference from it was too wide. The email adapter reads
all five out of the vault on every send, through `readEmailSmtpConfig` over the
credential provider `approval adapter email` hands to `act`, and the probe now
calls the same function over a provider built the same way. The values are read
into this process, handed to the SMTP session, and dropped: no value, no count, no
prefix and no length reaches a stream, and the transcript sweep in
`tests/cli-setup.test.ts` covers this path with the rest. A probe that is no wider
than the send it proves does not widen the exposure, and rotating a credential
deserves the proof first setup gets.

So a partial re-run asks one more question, after the replace/keep decisions and
the write:

```
open an SMTP session using the stored configuration to check it? [Y/n]
```

An answer that is neither yes nor no is asked again rather than defaulted, which
is the convention every other typed question in `setup` follows. Declining prints
the same "not verified: … were left alone this run" sentence the verb printed
before the offer existed. So does a vault the probe cannot open — a missing or
wrong passphrase, an altered file — with one more line naming why the probe could
not run, and no value in it.

## setup channel

A channel is not an adapter, and the two setup verbs fill different stores.
SPEC.md §4: a channel surfaces requests and collects decisions and holds no
state, so what it needs is a transport credential — it goes into the OS keystore,
and `.approval/env` records where. An adapter executes side effects and holds
credentials, so `approval setup adapter <name>` fills the vault instead.

## setup channel telegram

Stop `approval channel telegram listen` first. Two processes long-polling one bot
is a 409 from the Bot API, and the loser is whichever asked second. This is a
configuration verb; it is not meant to run beside the listener.

The token is never typed into this process on a machine with a keystore: the
helper's own no-echo prompt collects it, and this runtime reads it back on stdout
to make the getMe call. With no keystore, it is read with no echo and — after a
typed `yes` — written as a plaintext literal. The chat id is written as a
literal: a chat id is not a secret; the token is.

No `getUpdates` from this verb carries an offset, ever. An offset is an
acknowledgement: it tells the Bot API that everything below it may be discarded,
and a decision tap consumed here would never reach the listener waiting for it.
That is why `approval doctor` refuses to call `getUpdates` at all. Reading
without an offset confirms nothing, and `allowed_updates` is `["message"]`, so a
pending `callback_query` is not even delivered here.

The wait is a continuous long poll of up to 90 seconds, so when you send the
message does not matter and no Enter is asked for. If nothing arrives it asks
`getWebhookInfo` and prints what Telegram says about this bot — how many updates
are pending, and whether a webhook is swallowing them.

The chat id is written as a literal because a chat id is not a secret. Human-only
and enforced: it stores a credential and writes `.approval/env`, so `--as` expects
a `human:<id>` and an `agent:` or `system:` actor is refused at exit 2. Exit 1
means the far end refused: an invalid token, a 409 from a running listener, or no
message reaching the bot before the deadline.

## mcp serve

STDOUT IS THE JSON-RPC STREAM: this verb's own messages go to stderr, and a child
spawned by the run tool is piped rather than inheriting the terminal, so nothing
can write into the wire. SIGINT and SIGTERM close the transport and exit 0.

**The tools are the agent surface, and only that.** The tool list is the verb
registry (`approval instructions --schemas`) filtered by `human_only` false, and
every tool's `inputSchema` is that verb's registry input schema. Two agent-facing
verbs are still withheld: `consume`, which is internal plumbing that `run` wraps,
and `hook claude-code`, which reads a PreToolUse event from a stdin this transport
already owns.

**Not published**, and this is the design rather than an omission: grant, reject,
revoke, policy attest, policy amend, execution resolve, audit review, expire, env,
init, setup, vault, the channels, the daemon, and this verb itself. SPEC.md §11
names the agent the untrusted policy and the human the trusted, expensive
overseer. An MCP client is an agent's harness, so offering it grant would hand the
untrusted policy the overseer's pen. A human decides at a human's surface:
`approval channel cli`, the local web page, or Telegram.

**Identity cannot be escalated by a caller.** `--as` is removed from every
published input schema, so a client sending one is refused by the schema; the
server's own identity is appended last to every argv, so it wins even if one
arrives another way. There is no tool that takes an actor. A `human:` or
`system:` value for `--as` is refused at exit 2, before the transport exists.

Tool calls run serially in this process, and appends go through the same lockfile
and compare-and-append every `approval` process uses, so a CLI running beside this
server is safe. A refusal comes back as a tool result with `isError` true carrying
the CLI's own `{"error":{"code","message"}}` object, never as a thrown JSON-RPC
error: the command was well-formed and the answer was no, which the caller must be
able to read as data. A JSON-RPC error means something else, an unknown tool or
arguments that do not match the schema. The exit code travels in `_meta` as
`approval.md/exit_code`.

**This server reads no `.approval/env`** (SPEC.md §11.1 invariant 7). It runs
under whatever environment the operator launched it with, exactly as every other
`approval` invocation does.

POST-V1: mapping the MCP tasks/elicitation extension onto `awaiting`. SPEC.md
§10.5 says that MAY happen "when client support stabilizes"; until then the wait
tool blocks and answers, and its timeout is an answer of its own.
