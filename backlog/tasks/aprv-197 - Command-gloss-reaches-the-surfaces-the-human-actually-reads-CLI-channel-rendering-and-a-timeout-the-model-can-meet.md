---
id: APRV-197
title: >-
  Command gloss reaches the surfaces the human actually reads: CLI channel
  rendering, and a timeout the model can meet
status: To Do
assignee: []
created_date: '2026-09-01 05:08'
labels:
  - channels
  - ux
  - llm
dependencies: []
priority: medium
ordinal: 164000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
2026-09-01, from the human, mid-wave: 'i still get a claim like summary: cp /private/tmp/... but i thought we implemented a change so that the claim would be an llm summary'. APRV-144 built the gloss correctly but two choices hide it: (1) it is attached by the Telegram LISTENER only; approval channel cli and the interactive queue walker render the raw claimed summary with no gloss and no COMPUTED command_breakdown line, and tonight's incident (APRV-196) made the CLI channel the primary deciding surface; (2) the haiku subprocess has a 2s SIGKILL timeout, while a cold claude -p start routinely exceeds 2s, so on Telegram the gloss can be chronically absent and absence is silent by design, indistinguishable from unimplemented.

Scope: (a) render the deterministic command_breakdown (already in COMPUTED) in the CLI channel and queue views, no model needed; (b) wire the same opt-in gloss into the CLI channel's interactive prompt path with the same never-load-bearing, fail-to-absence properties; (c) make the timeout honest: measure real claude -p haiku latency, raise the ceiling accordingly or pre-warm once per listener/channel process, and count gloss absences somewhere a human can see (doctor or the channel's stderr) so silent failure is at least visible failure. Constraints unchanged from APRV-144: gloss never enters payload store, hash, or log; clearly labelled model-authored; no safety judgments in the prompt; nothing branches on gloss content.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 CLI channel and interactive queue prompts show the COMPUTED command_breakdown for multi-segment commands
- [ ] #2 CLI interactive prompts render the labelled model gloss when the subprocess answers, absent otherwise, both paths tested with the subprocess mocked
- [ ] #3 Gloss timeout grounded in measured latency or a pre-warm; absences counted visibly (doctor or channel stderr); no silent chronic failure
- [ ] #4 Never-load-bearing properties re-asserted: gloss absent from store, hash, log; nothing branches on its content
<!-- AC:END -->
