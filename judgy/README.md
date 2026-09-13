# judgy demo page

Static page served at https://approval.md/judgy. Source of truth is this folder;
the approval.md repo only receives a copy (see "Publish").

The page is a **pure renderer**: it reads `data/episode.json` and
`data/improvement.json` and displays them. It never computes a verdict, an
outcome, or a score. Whatever the JSON says about provenance (simulated, replay,
not run, unavailable) is shown as a visible label, never hidden.

The shipped `data/*.json` are hand-written samples labelled `simulated` /
`replay` / `not run`. Wiring the real thing means `reviewer-demo episode` and
`reviewer-demo compare` writing real documents of the same shape into `data/`.

## Preview locally

```bash
python3 -m http.server 8765 -d demo/site
```

Then open http://localhost:8765/. Data is fetched with relative paths so the
same files work under `/judgy/` on approval.md.

## Publish

```bash
scripts/publish_site.sh
```

Copies this folder into `~/dev/approval-md/judgy/` and prints that repo's git
status. It never commits or pushes: the page goes live the moment `main` of
`approval-md/approval.md` is pushed, so that step stays a deliberate human one.

## Data contract

Field names are proposals for `contracts.py` to align with. The provenance
labels are the non-negotiable part (spec §13.3, §14.1).

### `episode.json`

| Field | Values |
|---|---|
| `episode_id`, `scenario`, `recorded_at`, `task` | strings |
| `source` | `live` \| `replay` |
| `integration_mode` | `real` \| `simulated` (a `SimulatedApprovalBridge` must surface as `simulated`) |
| `execution_mode` | `real` \| `simulated` |
| `reviewer_version` | e.g. `reviewer-v1` |
| `reviewer_status` | `baseline` \| `candidate` \| `accepted` |
| `policy_summary[]` | `{id, text}` fixed policy rules |
| `turns[]` | ordered steps, see below |
| `trace` | `{url}` **or** `{status: "not run" \| "unavailable" \| "simulated"}`. Never an invented URL. |
| `cost` | `{usd, tokens, latency_ms}`, each a number or `"unknown"` |
| `counter_episode` | optional second, shorter episode with `episode_id`, `scenario`, `task`, `turns[]` (the human-only boundary case) |

Turn kinds and the authority lane each one renders in:

| `kind` | Lane | Fields |
|---|---|---|
| `proposal` | model | `actor`, `action`, `args{}`, optional `note` |
| `evidence` | evidence | `items[] {source, trusted: bool, text}` |
| `review` | model (recommendation) | `actor`, `verdict: APPROVE \| REVISE \| ESCALATE`, `reasons[]`, `evidence_refs[]` |
| `revised_proposal` | model | as `proposal` plus `changed[]` arg names |
| `runtime_verdict` | runtime (authorization) | `decision: permitted \| blocked \| needs_human`, `rule_ids[]`, optional `note` |
| `human_decision` | human | `status: not requested \| pending \| granted \| denied` |
| `effect` | effect (observed) | `status: completed \| blocked \| not run`, `mode: real \| simulated`, `artifact` or null, optional `note` |

A sample must never show `human_decision.status = granted`: a grant is a real
human's action and is not simulated here.

### `improvement.json`

| Field | Values |
|---|---|
| `generated_at`, `split` | strings |
| `source` | `live` \| `replay` |
| `baseline`, `candidate` | `{reviewer_version, status, metrics}` |
| `accepted` | same shape, or `null` when nothing has been promoted |
| `metrics` | `{n, completion, incorrect_readiness, unnecessary_escalation, unauthorized_effects}`; each count is a number or `"not run"` |
| `diagnosis` | `{source: mcp \| simulated, query, selected_failure_episode_id, finding}` |
| `change` | `{summary, diff}` (unified diff text of the bounded reviewer-config change) |
| `decision` | `{outcome: accepted \| rejected \| not run, reason, gate}` |
| `trace` | as in `episode.json` |

Samples use `not run` or `rejected` for `decision.outcome`, never `accepted`,
so the page cannot imply the loop already worked (spec §13.3).

## Live feed (`live/`)

`live/index.html` is the three-pane feed: every proposed agent action on the
left, the judge's conclusion for that action in the middle, and the human's
conclusion on the right when one was needed. One grid row per action, so the
three panes stay aligned.

It polls `data/live/feed.json` (relative path, every second) and renders new
rows as they appear. It is a pure renderer like the ledger page.

### `data/live/feed.json`

```json
{
  "feed_id": "feed-sample",
  "mode": "simulated",
  "started_at": "2026-09-13T00:00:00Z",
  "events": [ ... ]
}
```

| Field | Values |
|---|---|
| `mode` | `simulated` \| `live`. `live` only when every event's `source` is a real runtime observation. |
| `events[]` | append-only, ordered by `seq` |

Every event has `seq` (int), `ts` (ISO string), `action_id` (string, groups the
panes), `episode_id` (string), `source`: `simulated` \| `runtime` \| `approval_cli`,
and `kind`:

| `kind` | Pane | Fields |
|---|---|---|
| `action` | left | `actor`, `action`, `args{}`, `scenario`, optional `revises` (the `action_id` this replaces), optional `trace_url` (a real Weave URL or absent, never invented), optional `claims[]` (worker-authored assertions, shown as untrusted) |
| `verdict` | middle | `verdict: APPROVE \| REVISE \| ESCALATE \| ABORT`, `reason`, `evidence_refs[]`, `reviewer_version`, optional `runtime: {decision: permitted \| blocked \| needs_human \| error, rule_ids[]}` (absent when the runtime was not consulted, e.g. the reviewer escalated first) |
| `human` | right | `status: pending \| granted \| denied \| expired`, `channel`: `telegram` \| `approval.md` \| `fixture`, optional `request_id`, optional `decided_at` |
| `effect` | left, under the action | `outcome: succeeded \| failed \| refused \| not_run`, `simulated: bool`, `artifact_refs[]` |

Source rules:

- `simulated`: synthetic events from the simulator, and any human decision that
  came from a scenario fixture (a pre-authored answer, not a live human).
- `runtime`: observed from a real `reviewer-demo episode` run (proposals,
  reviewer verdicts, gate verdicts, executions).
- `approval_cli`: a human request or decision the approval.md CLI itself
  reported. A `granted` row with this source is the only kind that means a
  human really granted something; nothing in this repo mints one.

`mode` is `live` only when **no** event has `source: simulated` **and** no
`effect` event has `simulated: true`; otherwise `simulated`. A dry-run
execution is a real runtime observation of something that never happened, so a
feed containing one is never badged `live`.

A `request_id` is the human request's own correlation id (`request_ref`) or is
absent. No authorization handle or token is ever published into the feed, on
any row.

### Real episodes

```bash
reviewer-demo episode --scenario preview-basic --feed demo/site/data/live/feed.json
reviewer-demo feed --episodes artifacts/episodes --out demo/site/data/live/feed.json
```

The first appends one episode's events to the feed as it finishes, continuing
the existing `seq`; the second is a rebuild — it reads only `*.json` files at
the top level of the directory and renumbers `seq` from 1. Both render
`development`-split episodes only: `reviewer-demo feed` skips a validation-split
file with a line on stderr, and `--feed` refuses and exits non-zero without
writing the feed. The mapping lives in `approval_reviewer.feed_view` and is a
pure function of the record.

### Synthetic feed

```bash
python3 scripts/feed_simulator.py --interval 2
```

Appends synthetic events (labelled `simulated`) to `demo/site/data/live/feed.json`
drawn from the development scenarios, so the feed moves during a rehearsal.
`--reset` starts from an empty feed.
