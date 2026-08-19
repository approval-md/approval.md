---
id: APRV-100
title: 'Telegram prompt: render the FULL PAYLOAD body as text, not JSON escapes'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-18 21:47'
updated_date: '2026-08-19 15:40'
labels:
  - channels
  - ux
dependencies: []
ordinal: 92000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed in the real email-demo run (2026-08-18): the approval message on the phone shows the payload as raw JSON, so the email body arrives as one line with literal \n sequences and the £ as-is; the operator called it 'not styled too well'. The exactness is right (the human approves the bytes the hash binds), and it must stay verifiable, but a body field should be shown as the human will read it: real line breaks, and the JSON view (or the hash) available underneath rather than instead. Proposal: for payloads the channel recognises (email: from/to/cc/subject/body), render a labelled block per field with body unescaped and HTML-escaped for Telegram (the existing < and & handling stays), and keep 'payload sha256 …' as the binding line; unknown payload shapes keep the JSON rendering. Same for the web channel if it mirrors Telegram.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Email-shaped payloads render field-by-field with real line breaks in the body; the binding hash is still shown
- [x] #2 Markup injection tests (< & in subject/body) still pass; unknown shapes still render as JSON
- [x] #3 npm test and lint clean; examples/email-demo.md step 8 text updated
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, worktree from main. 2. src/channels/telegram.ts: structural detection of email-shaped payloads (from/to/cc/subject/body strings); labelled block per field, body with real line breaks inside pre, existing HTML escaping reused; payload sha256 line unchanged and distinct (computed vs claimed, SPEC 10.3); unknown shapes keep JSON byte for byte; length limit keeps the hash. 3. Mirror in web channel if it renders JSON. 4. Injection tests plus field-path tests. 5. examples/email-demo.md step 8. 6. PR by branch, auto-merge; records here.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Opus subagent build, PR by branch aprv-100-payload-view (#80). New src/channels/payload-view.ts shared by telegram and web (one-line swap in each, inside the existing payload region, escaping stays with the channel). Detection is STRUCTURAL: plain object whose every key is one of from/to/cc/bcc/subject/content_type/body, with to, subject and body present and typed (strings or string arrays for address lists); any unknown key, including a self-declared kind, falls back to JSON so the field view can never omit a byte (SPEC 10.3: the agent must not choose its own presentation). Rendering: a first line saying the values are CLAIMED, labelled fields, body between begin/end markers with real newlines, then the canonical JSON underneath unchanged, so conformance (fullPayloadText includes rendering.text) and the exact bytes hold; the computed payload sha256 line is untouched. Telegram chunking of oversized regions kept as is (it never truncates a payload); a rendering the tagging layer already truncated keeps JSON text. Tests: telegram fixture now multi-line with pound sign, tags and ampersand through the new path; new field-by-field and negative-detection tests; web mirror test. 1787 tests, lint and typecheck clean.

Merged at 94ed55f via auto-merge behind ci.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Email-shaped payloads render field by field on Telegram and the web page, body with real line breaks, marked claimed, canonical JSON and the computed sha256 underneath; structural detection only. PR #80 merged at 94ed55f; verified by channel tests incl. injection and negative-detection cases, conformance suites, 1787 tests, lint, typecheck.
<!-- SECTION:FINAL_SUMMARY:END -->
