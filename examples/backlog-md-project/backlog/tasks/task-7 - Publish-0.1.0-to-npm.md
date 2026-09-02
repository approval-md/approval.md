---
id: task-7
title: Publish 0.1.0 to npm
status: In Progress
assignee:
  - 'agent:release-bot'
created_date: '2026-09-02 09:00'
labels:
  - release
dependencies:
  - task-6
approval:
  origin:
    app: backlog-md
    created_by: "human:alice"
  route:
    assignee: "agent:release-bot"
    confidence: 0.9
    rationale: "scripted publish; the changelog and the tag were reviewed on task-6"
  state: proposed
  actions:
    - class: release.publish
      summary: "Publish 0.1.0 to the npm registry"
      reversible: false
      est_cost_usd: "0"
      idempotency_key: "task-7:publish:0.1.0"
      payload_hash: "93a5b8e63ee9c5132c5c896107eb53693bb6cb1d17f8136fec341a7faa721aa9"
  budget:
    max_latency: 24h
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The changelog and the tag landed on task-6. This task is the one step that
leaves the machine: publishing the package to the registry.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 0.1.0 is on the registry
<!-- AC:END -->
