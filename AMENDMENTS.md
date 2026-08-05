# approval.md — Consolidated Spec Amendment Pass (v0.1 → v0.1.1)

Status: human-drafted for review, 2026-08-05. Each amendment below is exact text.
Part A items modify gate semantics and MUST land inside M3's open tasks under the
standing same-commit rule (spec text + implementing code + tests in one reviewable
unit). Part B items are spec-vocabulary and normative-prose changes whose
enforcement arrives with M4/M5; they land as one spec-only task with fixture
updates where schemas gain fields, and carry no runtime obligations yet.

Human sign-off on the wording below covers all nine; deviations require
re-escalation per CLAUDE.md.

---

## Part A — fold into M3 open tasks

### A1. Content binding: approvals bind to bytes (APRV-16, APRV-17, APRV-18)

**§6.2, add to the `actions[]` field table:**

> `payload_hash` · MUST for `manual` actions, SHOULD otherwise · SHA-256 over the
> RFC 8785 canonical serialization of the action's concrete payload: for a message
> send, the full body and recipients; for `approval run`, the argv array and cwd;
> for a record write, the proposed record content. The payload itself is stored or
> referenced by the request so channels can display it; the hash is what approval
> binds to.

**§10 (gate/tokens), append:**

> An execution token is bound to the request, its `idempotency_key`, AND its
> `payload_hash`. Adapters and `approval run` MUST recompute the hash of the
> payload they are about to execute and MUST refuse, with a distinct
> machine-readable reason (`payload-mismatch`), when it differs from the hash the
> grant recorded. A grant therefore approves specific bytes. Changing the payload
> after grant requires a new request.
>
> For `manual` actions, channels MUST present the full payload or a faithful
> rendering of it, clearly delineated from any agent-written summary, before
> collecting a decision.

**§11, amend the "not defended" list:**

> Deceptive content inside an approved action is defended to this extent: the
> approver sees, and the token binds to, the exact payload bytes. What remains
> undefended is persuasion about whether those bytes should be approved, and any
> consequence the approver fails to model from bytes they did see.

### A2. Runtime-assigned timestamps on gate events (APRV-16)

**§8, append:**

> Events written through the gate (`approval.*`, `execution.*`, `budget.*`,
> `audit.*`, `policy.updated`) have `ts` assigned by the runtime at the write
> boundary. Caller-supplied timestamps on these types MUST be refused. Because
> TTL judgment and budget windows read `ts`, a party subject to those controls
> must never author the clock they are judged by. Direct log writers outside the
> gate remain free to supply `ts` (per §8's writer rules); verification treats
> gate-type events with implausible skew relative to their neighbors as a
> reportable anomaly, never silently accepted.

### A3. Self-reported signals never reduce scrutiny (APRV-16; one sentence, text plus a guard test)

**§11, append:**

> Fields authored by the party under oversight (`route.confidence`, summaries,
> cost estimates) MAY raise scrutiny, inform display, or feed retrospective
> analysis. They MUST NOT reduce sampling probability, downgrade a resolved
> autonomy level, or shortcut any refusal path. Scrutiny only ratchets upward on
> self-report.

---

## Part B — spec-only task (enforcement lands M4/M5)

### B1. Unpredictable audit sampling (§5.2; enforcement in the M5 daemon)

**§5.2, replace the `supervised_sample_rate` explanation's seeding sentence with:**

> Sample selection MUST be reproducible by the operator and unpredictable to
> agents. Implementations derive the selection value as HMAC-SHA-256 over the
> event hash using an operator-held secret stored outside the repository and
> outside any agent-readable path. Seeding from event content alone is forbidden:
> the authoring agent controls that content and could search it until its action
> falls outside the sample.

### B2. Request-volume limits: attention is a budgeted resource (§5.2, §10.2; enforcement M4/M5)

**§5.2, add to the policy vocabulary:**

> `limits.max_pending` (per class or global): maximum simultaneously pending
> requests; further requests are refused at intake with reason `queue-full`.
> `limits.requests_per_hour` (per origin): rolling-window ceiling on request
> creation; excess is refused with reason `rate-limited` and logged. Defaults are
> generous; the purpose is a tripwire against queue-flooding and approver
> fatigue, which attack the human's attention rather than the action budget.
> Refused requests consume no budget and no attention beyond the log line.

### B3. Computed versus claimed, on every surface (§9, §10.3; enforcement M4)

**§9 (queue projection) and §10.3 (channels), append to each:**

> Every displayed field is one of two kinds and MUST be visibly distinguished:
> **computed** (derived by the runtime from the log, policy, or payload bytes:
> class resolution, budget state, attestation status, payload hash, chain
> position) and **claimed** (authored by the requesting agent: summaries,
> estimates, rationale, confidence). Rendering claimed fields with the visual
> authority of computed fields misrepresents the verification boundary to the
> approver and is a conformance failure for a channel.

### B4. Disclosure obligation (§11; normative prose, socially enforced now, review-enforced always)

**§11, append:**

> Disclosure duty binds the informed party. An agent that knows information
> material to an approval decision and omits it from the request has violated
> policy even where the action itself was permitted. Materiality is judged as a
> reasonable approver would judge it. Undeclared side effects are the mechanical
> case, caught at the adapter boundary; undisclosed context is the same violation
> in a form only audit can catch, which is one of the things audit is for.

### B5. What the system makes legible, and what it never claims to (§11)

**§11, append:**

> This system makes actions, policies, and decisions common knowledge: a shared
> record both parties can read and neither can silently rewrite. It makes neither
> party's mind legible to the other. Agent reasoning is unverifiable from
> outputs; human intent exceeds any policy file. approval.md shrinks the
> information asymmetry where artifacts can carry it and claims nothing about
> interiority on either side.

### B6. The `record.*` namespace: approval as adoption (§7, §6.2, §11)

**§7 taxonomy table, add:**

> | `record.*` | `.write.stage`, `.categorize`, `.create`, `.archive` |
> supervised or manual, per ownership preference |

**§7, append:**

> For `record.*` classes, grant means adoption: the action proposes a write to a
> system of record (a task stage, a note category, a pipeline state), and
> approval commits it. The "adapter" is whatever write path owns the record; it
> MUST hold proposed writes in a staged state invisible to, or visibly
> provisional in, the record proper until granted. `record.*` actions are
> typically reversible; policies gate them for cognitive ownership rather than
> consequence, and both rationales are first-class (see §11).

**§11, append:**

> The gate protects two things: the world from your agents' actions, and your
> mind from your agents' writes. A system of record is an extended mind; writes
> to it are cheap to make and expensive to un-believe once relied upon. Policies
> that set reversible `record.*` classes to `manual` are exercising
> reversibility-preservation over epistemic state, and the irreversibility floor
> (§7) remains a minimum, never a statement that manual is reserved for the
> irreversible.

### B7. Batch decisions at the channel, unit decisions in the log (§10.3; enforcement M4)

**§10.3, append:**

> Channels MAY present multiple pending requests as a batch and collect one
> human gesture over the set, and SHOULD for high-volume `record.*` classes.
> The log never batches: each granted or rejected request receives its own
> `approval.granted` or `approval.rejected` event carrying the batch's channel
> delivery id in its payload, so audit granularity survives ergonomic grouping.
> A batch MUST NOT mix `manual` classes with differing payload-display
> requirements in a way that hides any full payload behind the fold of another.

---

## Roadmap note (non-normative, add to §13 or the roadmap)

> Post-v1: `review: adversarial` as a per-class flag. Before a flagged `manual`
> request reaches the approver, an independent agent instance with the raw
> payload and no stake in the outcome writes a dissent: worst plausible reading,
> omissions, questions a suspicious reviewer would ask. The approver adjudicates
> between framings instead of consuming one. Untrusted monitoring, spent where
> human attention is scarcest.

## Handling instructions for the session

1. Part A: attach A1 to APRV-16/17/18 acceptance criteria as scoped above, A2
   and A3 to APRV-16, exact text, same-commit rule. If any M3 code already
   merged conflicts with A1's token binding, stop and report before adapting.
2. Part B: create one spec-only task (next APRV number, milestone m-3 or a new
   `spec-0.1.1`), landing all seven B texts plus the roadmap note in a single
   reviewed commit, with schema/fixture updates only where B2 and B6 add policy
   vocabulary and taxonomy entries. No runtime changes in that task.
3. All wording above is pre-approved verbatim; formatting to match surrounding
   spec conventions (backticks, tables) is fine, semantic drift is not.
