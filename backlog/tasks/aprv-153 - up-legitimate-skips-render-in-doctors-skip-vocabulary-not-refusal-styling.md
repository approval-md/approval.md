---
id: APRV-153
title: 'up: legitimate skips render in doctor''s skip vocabulary, not refusal styling'
status: Done
assignee:
  - '@claude'
created_date: '2026-08-30 20:23'
updated_date: '2026-08-30 20:46'
labels: []
dependencies: []
ordinal: 138000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
When `approval up` skips an optional part (the web queue page with no channels.web.port declared, or Telegram unconfigured), the human rendering uses renderRefusal: a red ✗ with a code like web-unavailable and a fix: line. Carter read a healthy startup as a failure because of it. The JSON event already carries doctor vocabulary (check/status:skip/detail/fix); the human line should match doctor too: the yellow – skip glyph, the check name, the detail, and the path out labelled as enablement rather than repair. Presentation only: the --json stream is frozen and must not change.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 part_unavailable renders with the skip glyph and warn-role check label, not the fail glyph or refusal code styling
- [x] #2 The remedy line is labelled 'to enable:' (there is nothing to fix on a legitimate skip); it still prints the event's fix text and is omitted when fix is null
- [x] #3 A test pins the new human rendering for both a fix-bearing skip and a fix-less skip
- [x] #4 npm test passes and lint is clean
- [x] #5 The --json shape for part_unavailable is unchanged (same fields and types; telegram detail/fix values untouched); only the web fix wording changed, deliberately, to lead with the lighter --port path
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add a skip-notice renderer beside refusal() in src/cli/style.ts: skip glyph (–, warn role), check label in warn, plain detail, optional second line labelled to-enable: (key role) carrying the fix text.
2. Switch describeUpEvent part_unavailable in src/cli/up.ts from renderRefusal to the new renderer, keeping stderr routing and the frozen JSON emit path untouched.
3. Pin the new human rendering with unit tests of describeUpEvent (fix-bearing web skip and fix-less --once web skip); confirm existing --json assertions in tests/up.test.ts pass unchanged.
4. npm test + lint.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
describeUpEvent now renders part_unavailable through a new skipNotice() helper in style.ts (skip glyph –, check name in warn, plain detail, optional 'to enable:' second line), added beside refusal() as its counterpart for facts that are not faults. describeUpEvent takes an injectable Style (default style()) so cli-style-render.test.ts can pin both modes; two tests added there (fix-bearing and fix-less skips, TTY and piped, copyability of the enable command). The human code label changed from '<part>-unavailable' to the event's doctor check name (web-port, telegram); the JSON emit path in up.ts is untouched and up.test.ts's frozen-stream assertions pass unchanged. The web skip's fix value was reworded to put 'pass --port <n>' before the policy-amend path: value change only, shape frozen, and no test asserted the old wording. Verified: npm run lint clean; npm test 2403/2403 (one flaky hook-carryover timing failure on first run, green on rerun, pre-existing).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
approval up's legitimate skips (web page unconfigured, telegram unconfigured) now print in doctor's skip vocabulary — yellow – glyph, check name, 'to enable:' label — instead of a red ✗ refusal with a fix: line that read as a startup failure. Presentation only: --json stream shape and routing unchanged. Verified by new render tests in cli-style-render.test.ts and the full suite (2403 pass).
<!-- SECTION:FINAL_SUMMARY:END -->
