---
id: APRV-216
title: >-
  Telegram queue: summary first, one request at a time, /queue and /skip instead
  of the restart burst
status: To Do
assignee: []
created_date: '2026-09-02 15:57'
labels:
  - telegram
  - channels
dependencies: []
references:
  - APRV-196
  - APRV-115
  - APRV-206
priority: high
type: enhancement
ordinal: 178000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
On listener start the Telegram channel re-sends every pending request: a banner (APRV-196), digest grouping where requests are similar (APRV-115), then one message per request or digest (src/cli/channel-telegram.ts deliverUnits/groupForDigest/bannerLines). There are no bot commands. The one-at-a-time walkthrough that Carter liked exists only in approval channel cli --interactive (src/cli/channel.ts interactiveLoop, g/r/s prompt in src/channels/cli.ts). approval queue lists open requests read-only; QUEUE.md is read-only; the web page (src/channels/web.ts, channels.web.port) can act but is not enabled in the live policy. Replace the burst with paced delivery, chosen by Carter 2026-09-02: on listener start, and whenever the pending set grows while nothing is in front of the human, send ONE summary line (N pending, oldest age, classes) and the OLDEST pending request with its buttons. The next request is sent after a decision on the current one, after /skip (stays pending, goes to the back of this process's order), or after /next. /queue replies with the summary and a numbered list (action key, task, class, age) at any time. Digest grouping still applies to the item being shown. SPEC §10.3 holds: the channel holds no truth; the order and the current item are in-memory per process, pending-ness is always re-derived from the log, and a tap on any older copy still decides by action key (APRV-196). Opt-out channels.telegram.delivery: burst keeps today's behaviour; the default becomes paced. Reuse deliverUnits, groupForDigest, bannerLines, buildPendingQueue ordering, and the CLI loop's skip semantics.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Listener start with N pending sends exactly two messages: the summary and the oldest request
- [ ] #2 A grant or reject on the shown request sends the next one within one poll cycle; /skip and /next do the same without deciding anything and append nothing to the log
- [ ] #3 /queue lists every pending request inside its TTL, derived from the log, with counts and ages, and works while an item is being shown
- [ ] #4 A tap on a pre-restart copy still decides the same request (APRV-196 preserved); nothing is ever decided twice
- [ ] #5 channels.telegram.delivery: burst restores today's behaviour; the optional policy key is schema-validated (split into its own schema task if the change is non-trivial)
- [ ] #6 Tests in the Telegram channel suites with the mock bot cover start, decide, skip, next, queue, and the burst opt-out; docs/cli-reference.md channel telegram section updated; npm test passes; lint clean
<!-- AC:END -->
