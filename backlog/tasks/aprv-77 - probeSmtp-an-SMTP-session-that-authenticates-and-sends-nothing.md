---
id: APRV-77
title: 'probeSmtp: an SMTP session that authenticates and sends nothing'
status: In Progress
assignee:
  - '@fable'
created_date: '2026-08-18 08:12'
updated_date: '2026-08-18 08:13'
labels: []
milestone: m-10
dependencies: []
priority: high
type: feature
ordinal: 76000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
approval vault set cannot tell an operator whether the five smtp.* values make a working session; today the first evidence is an execution.failed after a human granted a real send. A probe that connects, upgrades, authenticates, and QUITs answers that at configuration time and is the verify hook APRV-78 needs. Own task because it edits a security-critical file (src/adapters/smtp.ts) whose STARTTLS-injection check, single-session budget, and no-silent-downgrade rules must survive the refactor unchanged: sendMail body becomes internal runSession(options, envelope|null, message|null), null envelope = stop after AUTH and QUIT; sendMail keeps its exact signature and delegates; new export probeSmtp mirroring SmtpSendResult minus reply. Redaction honoured.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 probeSmtp against the mock with credentials completes: session records QUIT, mailFrom null, no DATA
- [ ] #2 Failure codes identical to sendMail (connect-failed, tls-failed, smtp-535, timeout); no-credentials probe sends no AUTH and reports authenticated null; a mock reply echoing the password comes back redacted
- [ ] #3 tests/adapter-email.test.ts is UNMODIFIED and green, proving the refactor changed no send behavior
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, worktree from main. 2. Extract runSession from sendMail; sendMail delegates unchanged; probeSmtp export; redaction. 3. tests/smtp-probe.test.ts; adapter-email suite untouched. PR.
<!-- SECTION:PLAN:END -->
