# PENDING: APRV-137 SPEC.md §11.2 insertion (awaiting the human tap)

This file is a carrier, not documentation. It holds the exact, byte-for-byte
text of the one APRV-137 SPEC.md edit that did not land: the new §11.2
refusal-code registry. The build session's `Edit` call was refused twice with
`hook-timeout` on `policy.edit` (the ~9 minute channel wait elapsed with no
answer both times), so the other two SPEC edits landed and this one is parked
here rather than lost.

**To apply it.** In `SPEC.md`, find the last invariant of §11.1, which ends:

    (`tests/evidence-append.test.ts`). (Amended APRV-123, pending sign-off.)

Insert everything below the `--- BEGIN ---` line, and above the `--- END ---`
line, between that invariant and the `## 12. Interoperability` heading that
follows it. Then delete this file: it exists only until the registry is in the
spec where it belongs.

Nothing else about the edit is outstanding. The `actor-not-approver` row it
carries describes a refusal that is already implemented, tested, and pinned in
`conformance/vectors/refusal-unions.v1.json` at `vectors_version` 4.0.0.

--- BEGIN ---

### 11.2 Refusal-code registry (normative)

Invariant 6 above freezes five refusal unions as public API and pins each with a test. It does not say what any member means, and a frozen vocabulary whose triggers are folklore is a vocabulary a second implementation has to guess at. This registry states, for every member of every union, the condition under which that member fires. It is normative, and it is the source the conformance suite's `failure_class` assignments are drawn from (§13): a refusal for the wrong reason is a conformance failure, so the mapping has to live somewhere other than in the reference implementation's source. (Amended APRV-137, pending sign-off.)

Three properties bind the whole registry. A code fires for exactly the condition named and never as a catch-all. Where two conditions could both apply, the order in which an implementation evaluates them is itself normative and is stated with the condition. And a refusal leaves the log untouched unless its row says otherwise: `budget-exceeded` appends a `budget.exceeded` record beside its refusal, `expired` materialises the `approval.expired` record a reader could already derive, and nothing else writes. (Amended APRV-137, pending sign-off.)

**`gate_refusal_codes`** — every way `register`, `request`, `decide`, `withdraw`, `expire`, the policy-amendment ceremony, and harness-grant consumption can refuse, in definition order. (Amended APRV-137, pending sign-off.)

| code | fires when |
|---|---|
| `policy-not-attested` | The live policy bytes do not match the latest attestation, no attestation exists, or the policy file cannot be read. Checked at intake, at grant, and at harness-grant consumption. Reject, revoke, and withdraw do not require attestation, because they withdraw authority rather than confer it. |
| `policy-drift` | The policy is attested, and the hash in force differs from the hash the matching `approval.requested` pinned. Grant and harness consumption only. The pending request is void; nothing is appended. A request written before the field existed carries no hash and is decided as it always was. |
| `envelope-invalid` | The envelope fails `envelope.schema.json`, the task file's frontmatter carries no `approval:` key or no usable id, or an in-memory registration names an empty task id. |
| `task-file-unreadable` | The task file could not be read. An I/O fact, and never an accusation about its contents. |
| `task-already-registered` | The task id already has a `task.registered` record, or a declared `idempotency_key` is already declared under a different task. |
| `envelope-missing` | The file carries no envelope and the log holds a `task.registered` for its task, so the envelope was removed after registration. Nothing is appended, and no implementation repairs the file. |
| `not-registered` | No `task.registered` record exists for the task id. |
| `action-not-registered` | The task is registered and declares no action carrying this `idempotency_key`. |
| `duplicate-request` | A live `approval.requested` for this action key is already awaiting a decision. |
| `already-executed` | The action key already has an `execution.started`. On the revoke path it says revocation was attempted after execution, which is a thing revocation cannot reach. |
| `budget-exceeded` | A conjunctive budget verdict failed at intake or at grant. A `budget.exceeded` record IS appended before the refusal; where that append itself fails the refusal still stands and reports both facts. |
| `payload-hash-required` | An action that reached the manual path, by class, by the §7 floor, or by a live draw, carries no `payload_hash` in its registered declaration. The same code answers the same fact at the harness boundary: a harness start that names no binding, or a harness-grant spend that presents none. |
| `payload-mismatch` | Payload material supplied at intake does not hash to the declared `payload_hash`. Nothing is stored and nothing is appended. |
| `payload-store-failed` | Supplied material cannot be canonicalized, or the payload store cannot be written. A manual request whose bytes no channel can display is a request no human can answer, so intake refuses. |
| `grant-classless-request` | A grant was attempted on a request whose payload carries no usable `class`. Reject and revoke are unaffected, since withdrawing authority needs no class. |
| `loop-escalated` | The task has three consecutive `execution.failed` events and the action would otherwise have proceeded unsupervised. Manual requests for the same task are unaffected, because escalation puts a human in the loop rather than closing the task. |
| `not-requested` | No `approval.requested` record exists for the action key. |
| `already-decided` | The request already carries a terminal decision: rejected or revoked, granted where the verb is not revoke, or any settled state on the withdraw path. |
| `not-granted` | Revoke was attempted on a request that is awaiting a decision, or a harness grant was consumed for a key whose grant is not harness-executed. |
| `request-withdrawn` | A decision, or a second withdrawal, was attempted on a request its requester had already withdrawn. Nobody decided, which is what makes this distinct from `already-decided`. |
| `not-requester` | A withdrawal was attempted by an actor other than the one that appended the matching `approval.requested`. |
| `expired` | The TTL lapsed, judged from the request's own timestamp whether or not an `approval.expired` record exists. Where no such record exists the runtime appends one, under a `system:` actor, and then refuses. |
| `not-expired` | `expire` was called on a request whose TTL has not lapsed, including every request under a policy that declares no `approval_ttl` (§5.1). |
| `actor-invalid` | The actor is not a well-formed `human:` or `agent:` identity, on register, request, withdraw, and harness-grant consumption. |
| `actor-not-human` | A human-only verb, grant or reject or revoke, was attempted by an actor that is not `human:<id>`. |
| `actor-not-approver` | A grant was recorded by a `human:` actor the resolved rule's `approvers` list does not name (§5.2). Grant only, and evaluated after `policy-drift` and `grant-classless-request`, which establish that there is still a request and that it has a class, and before budgets, which write. A rule declaring no `approvers` restricts nobody. |
| `log-unreadable` | The log could not be opened. A filesystem fact. |
| `log-torn-tail` | The log's final line is unterminated, which is the signature of a crashed write. Nothing is repaired. |
| `log-corrupt` | The chain does not verify. The log's own contents contradict each other, so nothing may be authorized from it. |
| `diff-too-large` | The rendered semantic diff of a proposed policy amendment is larger than a channel prompt can show whole. A refusal rather than a truncation, because a prompt showing two thirds of a policy change would collect a signature for the third it did not show. |
| `proposal-not-found` | No `policy.proposed` record exists at the named seq, so there is no attestation prompt to answer. |
| `proposal-stale` | The policy bytes changed after the attestation prompt was rendered, so the hash on the approver's screen is not the hash on disk. Distinct from `policy-drift`, which is about a pending approval routed under superseded rules. |
| `policy-already-attested` | An attestation was proposed for a policy file that already matches its attestation. There is no amendment to sign. |
| `append-failed` | The append itself failed, carrying the writer's own error. Its code is `head-moved` where the log grew between the read that authorized the write and the write. |

**`token_verify_refusal_codes`** — every way a presented token can fail verification, in definition order. Evaluated as: revoked, then lapsed by derivation, then any state that is not granted, then the parent TTL re-applied, then the harness marker, then the recorded digest, then consumption, then the presented preimage. (Amended APRV-137, pending sign-off.)

| code | fires when |
|---|---|
| `not-granted` | No grant governs the action key: it was never requested, is still awaiting, was rejected, or was withdrawn. Also where a granted cycle names no task, since `execution.started` requires one. |
| `token-mismatch` | A grant exists and the SHA-256 of the presented token is not the digest it recorded, compared in constant time. Also where the grant carries no usable `token_sha256`, which authenticates nothing and fails closed. |
| `token-consumed` | An `execution.started` for this action key already spent it, whether that record carried the same digest or simply landed after the grant. Single use is proved from the log rather than remembered. |
| `token-expired` | The parent request's TTL lapsed. There is no separate token TTL: a token lives exactly as long as its request, and under a policy declaring no `approval_ttl` it does not lapse at all (§5.1). |
| `token-revoked` | A human withdrew the grant with `approval.revoked`. |
| `payload-mismatch` | The hash the consumer states for the bytes it is about to execute differs from the hash the grant bound to, or the consumer stated none, or the grant recorded none. A grant that recorded no binding can never be spent. |
| `harness-executed` | The grant declared `execution: "harness"` and minted no token. A shape condition on the grant, and never a report that a command already ran: the authorization is complete and is not of the kind that is spent. Evaluated before the digest comparison, so a caller is told the authorization was never of the kind that is spent rather than sent hunting for a token deliberately never created. |

**`token_refusal_codes`** — the token verbs' union: every verification code above, plus the log and append failures, in definition order. (Amended APRV-137, pending sign-off.)

| code | fires when |
|---|---|
| `not-granted`, `token-mismatch`, `token-consumed`, `token-expired`, `token-revoked`, `payload-mismatch`, `harness-executed` | Exactly as in the verification table above; the names and the meanings are the same ones. |
| `log-unreadable` | The log could not be opened. |
| `log-torn-tail` | The log's final line is unterminated. |
| `log-corrupt` | The chain does not verify, so nothing may be spent from it. |
| `append-failed` | The `execution.started` append failed, carrying the writer's error. Its code is `head-moved` for the double-spend case, refused under the append lock with nothing written. |

**`execute_refusal_codes`** — every way `approval run` and the adapter contract can refuse, in definition order. Six of the token codes are re-exposed verbatim rather than collapsed, because the responses differ. (Amended APRV-137, pending sign-off.)

| code | fires when |
|---|---|
| `action-not-registered` | No `task.registered` record declares the action key, or more than one task declares it, in which case the runtime refuses rather than guess which declaration governs. |
| `token-required` | The action resolves to `manual`, or the log already holds an `approval.requested` for the key, and no token was passed and none was recoverable from sealed delivery. Nothing is appended. |
| `loop-escalated` | The task has three consecutive `execution.failed` events, on the supervised or autonomous path. A redirection rather than a ban: request the action, have a human grant it, run it with the token. |
| `policy-not-attested` | Attestation fails, on the supervised or autonomous path. It is deliberately not re-checked on the manual path, where the grant that minted the token already required it. |
| `already-executed` | An `execution.started` already exists for the key, on the supervised or autonomous path. |
| `budget-exceeded` | Budgets refused the start. A `budget.exceeded` record IS appended before the refusal. |
| `not-started` | An outcome verb found no unfinished `execution.started` for the key, or the start record names no task. |
| `already-finished` | The most recent start already carries an outcome. An execution has exactly one. |
| `not-granted`, `token-mismatch`, `token-consumed`, `token-expired`, `token-revoked`, `harness-executed` | Surfaced verbatim from the token layer on the manual path, with the meanings of the verification table above. |
| `payload-mismatch` | On the manual path, from the token layer. Off it, where the registered declaration carries no `payload_hash`, where the executor presented none, or where the presented hash differs from the declared one. Nothing is appended in any of the three. |
| `actor-not-human` | Resolve or reconcile was attempted by an actor that is not `human:<id>`. Those two verbs and no others: starting an execution carries no actor check of its own, so a malformed identity there is refused at the write boundary by the event schema and reaches the caller as `append-failed`. The same code additionally answers a missing or empty mandatory note on both verbs, which is a second condition its name does not describe; the doubling is recorded here as the behaviour to expect rather than blessed, and splitting it would add a member to a frozen union. |
| `execution-delegated` | The key's latest `execution.started` carries `payload.execution: "harness"`, so the harness ran the command and this runtime never observed an exit status. The record is terminal by design and no outcome may be placed over it. |
| `execution-indeterminate` | The key's execution ended in an unknown outcome that nobody has reconciled. Refused on both paths, because a retry against an unknown outcome is a blind double-execution. |
| `not-indeterminate` | Reconcile found no unreconciled `execution.indeterminate` for the key, or the cycle names no task. A started execution with no outcome at all is a dangling execution and is closed with resolve instead. |
| `already-reconciled` | The indeterminate outcome already carries a resolution. Neither record is rewritten. |
| `log-unreadable` | The log could not be opened. |
| `log-torn-tail` | The log's final line is unterminated. |
| `log-corrupt` | The chain does not verify, so nothing may execute from it. |
| `append-failed` | The append failed, carrying the writer's error. Its code is `head-moved` where a record landed between the read that authorized the write and the write. |

**`append_error_codes`** — every way the write boundary itself can refuse an append, in definition order. Every one of them leaves the file byte-identical. (Amended APRV-137, pending sign-off.)

| code | fires when |
|---|---|
| `lock-timeout` | Another writer held the append lockfile past the timeout. A stale lock is never stolen, because silently breaking one is how two writers come to share a `seq`. |
| `corrupt-tail` | The file's last line is truncated, blank, not valid JSON, not a JSON object, or carries no usable integer `seq` or 64-hex `hash`. Chaining onto a half-written record would make the damage permanent. |
| `validation` | The complete record, chain fields included, failed the event schema at the write boundary. This is also the code an implementation MUST use where its write boundary can still receive a caller-supplied timestamp on a gate-typed event (§8). |
| `canonicalization` | The record could not be serialized under RFC 8785. |
| `io` | The log directory, the file, or the write could not be created, opened, or performed. |
| `head-moved` | The caller supplied a compare-and-append precondition and the tail read under the lock is a different `(seq, hash)`. Every read-dependent check that authorized the write is stale, and nothing is retried by the writer. |

--- END ---
