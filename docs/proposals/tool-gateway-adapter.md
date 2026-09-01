# Proposal: tool-gateway adapter (parked)

Status: **parked**, 2026-08-31. Design verified against the repo and against both
providers' public docs; no code exists. Filed so the work can be activated by
promoting the Backlog draft if demand appears.

## Why parked

The original driver was gating paid tool-gateway calls (prepaid USD wallet,
per-call billing) behind approval.md. Customer feedback (Kevin, via Carter,
2026-08-31): customers are comfortable letting agents run read commands, spend
is modest and already capped platform-side, and the platforms publish usage
metrics, so neither the spend gating nor the audit trail is a felt need today.

The honest split of that feedback: the spend-control case is weak (wallet caps
already bound dollar risk; `cost_backstop` duplicates them), while the
data-governance case is untested rather than refuted. Platform metrics see one
API key: they cannot attribute calls to an agent identity or session, cannot
enforce a purpose string on PII SKUs, cannot fire mid-fan-out, and cannot
separate fetch from persist. Those controls become relevant when a customer
needs PII governance or a compliance story, and that demand has not shown up.
Parked, complete, until it does.

## What it would be

A provider-neutral adapter that puts approval.md's deterministic gate between
an agent and a paid MCP tool gateway, on our side of the wallet. Deterministic
logic only, fail closed: a request missing a required field is denied, and no
LLM appears anywhere in the policy path. Provider specifics are data files;
the engine never names a provider.

### Verified provider facts (public docs, 2026-08-31)

| | AnyAPI | Monid |
|---|---|---|
| MCP endpoint | `https://api.getanyapi.com/mcp` (Streamable HTTP, Bearer) | `https://mcp.monid.ai/v1` (OAuth); REST `api.monid.ai` (Bearer) |
| Run tool | `run_api` (discovery tools are free) | run addressed by `provider` + `endpoint` (REST `POST /v1/run`) |
| SKU addressing | dot-path (`linkedin.profile`, `apollo.people_search`) | `provider` + `endpoint` (`pdl` + `/person/enrich`) |
| Cost in response | `costUsd` (USD float) | `billing.actualCost.value` (micro-dollar units) |
| Item count | `items` | `billedUnits` (`resultCount` is a deprecated alias) |
| Execution | sync | 202 + poll `GET /v1/runs/:runId`; upstream control gate may return `status: BLOCKED` (a provider refusal, never our approval) |

The differences are the design's justification: provider config needs a cost
JSON path plus a unit scale (`usd` vs `micro-usd`), an item-count path, a SKU
normalization template, and a sync/async mode. A third provider is one more
YAML file.

### Provider config sketch

```yaml
# anyapi.yaml
name: anyapi
base_url: https://api.getanyapi.com/mcp
auth: { header: Authorization, key_env: ANYAPI_KEY }   # env var name only; never a key
run_tool: run_api
mode: sync
sku: { style: dot }
response: { cost_path: costUsd, cost_unit: usd, items_path: items }
```

```yaml
# monid.yaml
name: monid
base_url: https://mcp.monid.ai/v1
auth: { header: Authorization, key_env: MONID_KEY }
mode: async        # 202 + bounded poll
sku: { style: provider-endpoint, template: "{provider}{endpoint}" }
response:
  cost_path: billing.actualCost.value
  cost_unit: micro-usd
  items_path: billedUnits
  blocked_status_path: status
  blocked_value: BLOCKED
```

Validated by an adapter-local JSON Schema (Ajv 2020-12, closed, fail closed to
`provider-config-invalid`). SKU patterns reuse `policy-match.ts` glob
semantics. Keys resolve through the env var the config names, per SPEC §5.2;
no key is ever read from or shipped in the repo.

### Rules (each separate, independently testable)

Evaluation order is strictest first so the reported reason is deterministic:
`missing_identity` → `purpose_required` → `per_run_item_cap` → `fan_out_cap` →
`rolling_daily_cap` → `cost_backstop`. `purpose_class_limits` substitutes
per-purpose cap values (recruiting, sales_outreach, research) before
evaluation; overrides adjust caps and never skip a rule.

- `purpose_required`: PII-pattern SKU (default `linkedin.*`, `instagram.*`,
  `x.*`, `people.*`) without a purpose string is denied.
- `per_run_item_cap`: requested or expected items over N (default 20) requires
  approval.
- `fan_out_cap`: after a search, more than N (default 20) fetches to a PII SKU
  within one agent session requires approval on the N+1th call.
- `rolling_daily_cap`: more than N (default 200) PII items per agent identity
  per rolling 24h requires approval.
- `missing_identity`: session id and agent identity are required inputs for
  the two caps above; absence must never fail open. Default: deny for PII
  SKUs, require per-call approval for everything else. Unidentified callers
  are never bucketed together; the audit record carries an explicit
  `missing_session_id` / `missing_agent_identity` reason, never an empty
  identity field.
- `cost_backstop`: a single run over X USD (default 1.00) requires approval
  regardless of SKU. Weakest rule given platform wallet caps; kept for
  completeness, evaluated pre-call against the estimate and post-call against
  the metered actual (a post-call breach is flagged; the money is spent).
- `persist_is_separate`: writing fetched PII anywhere is its own registered,
  gated action. This is mechanical, via class separation (below).

### Audit record: one new product-neutral event type, `execution.metered`

Fan-out and rolling-daily counters must derive from verified records (SPEC
§11.1 invariant 1). Three options were weighed:

- Piggybacking on `execution.completed` was rejected: `finishExecution`
  (`src/core/execute.ts`) writes `payload: { exit_code }` and the adapter
  contract states as doctrine that outcome events carry nothing else.
- An adapter-local hash-chained ledger was rejected: a second chain is
  invisible to `approval log verify`, `log sync`, and every operator surface.
  Two truths is the failure mode this project exists to prevent.
- Chosen: an additive event-type amendment, following the registry's own
  precedent (`payload.pruned`, `execution.indeterminate`/`reconciled`): SPEC
  §8 entry (pending human sign-off), an `event.schema.json` branch, the
  `EventType` union in `src/core/log.ts`, and conformance vectors regenerated
  through `scripts/regen-conformance-vectors.mjs` with a reviewed diff.

Shape (product-neutral; no provider, "SKU", or "PII" in field names):

```json
{"event":"execution.metered","task":"…","action_key":"…","actor":"agent:<id>","ts":"<runtime>",
 "payload":{"outcome_seq":41,"class":"network.gateway.run","adapter":"tool-gateway:anyapi",
  "resource":"linkedin.profile","purpose":"job_search_outreach",
  "dimensions":{"session_id":"sess-…"},"attribution_gaps":[],
  "requested_units":40,"actual_units":10,"cost_usd":"0.42"}}
```

`attribution_gaps` is a closed enum (`missing_session_id`,
`missing_agent_identity`), required non-empty whenever the matching dimension
is absent (engine-enforced and tested). `cost_usd` reuses the §6.2
decimal-string grammar; arithmetic is integer micro-USD via `src/core/money.ts`.
The record is runtime-stamped, built from the contract's already-redacted
detail, appended under compare-and-append, and authorizes nothing: a failed
metered append leaves the completed execution standing, and counters
compensate by counting started-but-unmetered calls at the larger requested
figure (the fail-safe direction).

### Gate mapping

- Classes: `network.gateway.run` (one billed call) and
  `network.gateway.persist` (writing fetched data to any store).
  `persist_is_separate` falls out of the contract: `executeThroughAdapter`
  refuses `adapter-class-mismatch` on exact class match, so a fetch token
  physically cannot execute a persist. `network.*` default gravity is manual,
  so an unconfigured policy fails closed to per-call approval.
- Deny: engine-local frozen union `GATEWAY_REFUSAL_CODES`
  (`purpose-required`, `identity-required`, `cost-backstop-unevaluable`,
  `gateway-response-unreadable`, `gateway-upstream-blocked`,
  `provider-config-invalid`, `rule-policy-invalid`), pinned by test per
  invariant 6. A deny appends nothing.
- Require-approval: the existing manual path (`request` → channel/`wait` →
  grant mints the single-use token → `executeThroughAdapter`). Approver
  identity and timestamp land on `approval.granted` as they do today.
- Allow: means the adapter rules add nothing; core policy resolution still
  applies. The engine is a pure ratchet: it may force manual and can never
  grant autonomy the policy withheld (invariant 4).

### Counters

`deriveCounters(records, call, evalTs)`, pure over verified records. A call
instance is a `task.registered` action of class `network.gateway.run` with an
`execution.started`; its unit count is the metered `actual_units` when
present, else the declared `requested_units`. `fan_out_cap` partitions on the
runtime-stamped `actor` plus `dimensions.session_id` for PII-pattern
resources. `rolling_daily_cap` partitions on `actor` alone over `evalTs −
24h` (same window semantics as `budgets.ts`). Two distinct `agent:` ids can
never share a counter because the partition key is the exact runtime-stamped
actor string. When session or identity is null the counters are not computed;
`missing_identity` answers first.

Honest-security caveat: `session_id` is self-reported, so a caller rotating
session ids resets `fan_out_cap`; the actor-keyed rolling daily cap is the
backstop, and the actor string is runtime-stamped (on the MCP path the server
appends its own identity).

### Everything else, briefly

- Engine layout: `src/adapters/tool-gateway/` (`provider-config.ts` + schema,
  both YAMLs, `rule-policy.ts` defaults with explicit-path override only,
  `rules.ts`, `counters.ts`, `transport.ts`, `adapter.ts`, `metered.ts`,
  `engine.ts`, `persist.ts`, `README.md`). The transport interface
  (`callRunTool`) is the mock seam; live mode differs from tests by the
  transport constructor and one env var, with no code-path differences.
- Example: `examples/tool-gateway/` demo against a mock gateway, run once per
  provider YAML. Scenario: agent asked to find hiring managers at three
  companies; search returns ~40 profiles; agent attempts to fetch all;
  `per_run_item_cap` fires at 20; a human approves a re-scoped 10-item request
  with purpose `job_search_outreach`; the log shows one grant for 10, a
  metered record with `actual_units: 10`, the other 30 never fetched or
  billed, and `verify()` clean.
- Tests: per-rule suites plus three named cases (PII SKU with no session id
  is denied; non-PII SKU with no session id produces an approval request, no
  pass; two agents with distinct ids never share a counter), all fixtures
  through `tests/scenario.ts` and the real append path.
- Providers' skills-repo pitch page (`docs/tool-gateway.md`): what the gate
  does, one config snippet, and one line on what it does not do — it makes
  scraping auditable; it does not make it lawful.

## Task decomposition on activation (ten tasks, in order)

1. SPEC §8 + `event.schema.json` + `EventType` + conformance regen for
   `execution.metered` (pending human sign-off; blocks the rest).
2. Provider config loader + schema + both YAMLs + tests.
3. Rule policy defaults + pure rule engine + frozen union + per-rule tests.
4. Counter derivation from verified records + tests.
5. Transport (mock + live MCP client) + adapter `act()` + extraction and
   BLOCKED-mapping tests.
6. Engine orchestration + metered append + end-to-end tests including the
   three named cases.
7. Persist adapter + class-separation test.
8. `examples/tool-gateway/` demo + mock gateway + env var docs.
9. Adapter README + `docs/tool-gateway.md` pitch page.
10. Sweep: full `npm test`, `npm run conformance`, oxlint; file the
    APPROVAL.md override-key proposal.

## Open questions held with the park

1. `execution.metered` is a SPEC §8 amendment and needs human ratification.
2. An APPROVAL.md override key for the adapter rule policy requires opening
   the deliberately closed `policy.schema.json`; until then defaults ship
   in-code with an explicitly passed override path (invariant 7), and agents
   never edit APPROVAL.md.
3. Post-call `cost_backstop` breach handling: flag-only in the result, or an
   additional escalation record. Recommendation at park time: flag-only.
4. Live verification needs a trial key created by a human (AnyAPI offers
   agent self-signup, which our own rules put on the human side); the free
   discovery tools can then validate config paths without spending.
