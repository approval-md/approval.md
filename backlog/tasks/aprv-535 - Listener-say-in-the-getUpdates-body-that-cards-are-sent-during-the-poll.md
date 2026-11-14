---
id: APRV-535
title: 'Listener: say in the getUpdates body that cards are sent during the poll'
status: Done
assignee: []
created_date: '2026-11-14 13:17'
updated_date: '2026-11-14 13:31'
labels: []
dependencies: []
references:
  - >-
    backlog/tasks/aprv-534 -
    APB-12-dispatch-Telegram-requests-while-a-long-poll-is-pending.md
type: enhancement
ordinal: 407000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Since APB-12 (APRV-534, merge #672) the polling listener sends a new request's card while its getUpdates is still held, through the file watch and one-second stat fallback in startListener. A relay in front of the Bot API cannot tell such a listener from an older one, which sends only between polls, so it must keep every box's hold short. This task lets the listener say so: its getUpdates body carries sends_during_poll: true, only from the watch-and-dispatch path and never to Telegram's own API base, so a relay can hold that box's poll longer. With no relay change nothing differs. No interrupt, no second watcher, no change to APB-12's behaviour.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 To Telegram's own API base (TELEGRAM_DEFAULT_API_BASE's host) the getUpdates body is byte-equal to today's: the field is never sent there.
- [x] #2 To any other base, from startListener's watch-and-dispatch listen loop, the body differs from today's by exactly the one field; pollOnce called directly, listen without the option, --once, setup and every other getUpdates caller do not send it (default off in the channel).
- [x] #3 One listener flag, --no-sends-during-poll on channel telegram listen and on up, turns the claim off (field not sent); the watch itself is untouched; every existing listener test passes unchanged.
- [x] #4 The field's name lives in one exported constant.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Export TELEGRAM_SENDS_DURING_POLL_FIELD and a host check against TELEGRAM_DEFAULT_API_BASE in src/channels/telegram.ts. 2. Add TelegramListenOptions.sendsDuringPoll (default off); listen passes it to pollOnce, which adds the field only when it is true and the base's host is not Telegram's. 3. startListener passes it, unless --once or the flag; ListenSetup/ListenRequest carry the optional flag from both verbs. 4. Tests: two body snapshots, other callers, the flag; help text and cli-reference; changelog Unreleased.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Field sends_during_poll is TELEGRAM_SENDS_DURING_POLL_FIELD (src/channels/telegram.ts); pollOnce appends it last, only when TelegramListenOptions.sendsDuringPoll is true and isTelegramOwnApiBase(apiBase) is false (host compare against TELEGRAM_DEFAULT_API_BASE; an unparseable base counts as Telegram's own). Only startListener passes sendsDuringPoll, after arming APRV-534's watch, and not under --once (a one-batch run is not the watch-and-dispatch loop). --no-sends-during-poll on channel telegram listen and up sets ListenSetup.noSendsDuringPoll; the watch is untouched. Help lines folded into existing lines to stay under the 25-line cap. No interrupt, no second watcher, no APRV-534 behaviour change. Evidence: tests/telegram-sends-during-poll.test.ts 9/9; channels-telegram 188/188, channels-telegram-minimal 54/54, telegram-listener-watch 23/23, telegram-webhook 38/38, telegram-tap-latency 5/5, telegram-study 13/13, cli-help 11/11, cli-long-help 23/23, up 17/17, release-notes 27/27; typecheck, lint, build exit 0. Full suite and conformance left to CI.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The polling listener says sends_during_poll: true in its getUpdates body to any base but Telegram's own, from startListener only, with --no-sends-during-poll to withdraw it. Verified by the new test file and the existing Telegram, listener, help and up files.
<!-- SECTION:FINAL_SUMMARY:END -->
