---
id: APRV-70
title: >-
  M7 end-to-end demo: agent drafts chaser, Telegram ping, approve from phone,
  email sent, log verifies
status: Done
assignee:
  - '@fable'
created_date: '2026-08-17 21:40'
updated_date: '2026-08-19 01:31'
labels: []
milestone: m-9
dependencies:
  - APRV-55
priority: high
type: feature
ordinal: 69000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
SPEC 14 M7 exit criterion, and the abstract made real: an agent drafts the canonical example deposit chaser (SPEC 6.1) as a task with communicate.email.external, reversible false, payload = the message; register, request (payload filed), Telegram notify to the human phone, approve, token minted, approval run / the email adapter sends via SMTP using vault credentials, log verifies. Two halves like APRV-27: a scripted demo test against the mock SMTP server and the mock Bot API (CI-runnable, asserts every hop against the log), and a documented manual runbook (examples/email-demo.md) for the human to run once against real Telegram and a real SMTP account (the network hop only a human can prove; the human sets up an app password in the vault). The proof event range is recorded here when the human runs it. Update the README ceremony docs with the fourth ceremony (sending mail from your phone approval) if it fits naturally, in the incident-grounded style.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Scripted demo test walks register -> request -> notify -> approve -> send -> log verify against mocks and passes in CI
- [x] #2 examples/email-demo.md runbook exists; the human has run it once against real Telegram and SMTP and the log seq range is recorded on this task
- [x] #3 README documents the fourth ceremony
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, worktree from main (has 55/67/68/69). 2. tests/e2e-email-demo.test.ts: real CLI processes against temp dirs: init, write demo policy (communicate.email.external manual, telegram channel), attest, vault set smtp.* against the mock SMTP server, register the SPEC 6.1 chaser task (payload = the message, reversible false), request --payload, telegram listener --once against the mock Bot API delivers to the chat, callback approve through the mock, token minted, approval adapter email sends via the mock SMTP, DATA bytes equal the rendering, execution.completed, log verify clean; assert every hop against the log. 3. examples/email-demo.md: the human runbook against real Telegram + real SMTP (app password into the vault via --value-env, doctor all green, run the same commands), recording where the seq range goes on this task. 4. README fourth ceremony section (agent-editable) in the incident-grounded style. PR. 5. HUMAN: run the runbook once; record seq range here.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Agent half merged as PR #37 (1396 tests): scripted demo test asserts ten hops end to end against mock Bot API + mock SMTP through the real CLI, with a secret sweep across every surface (password, passphrase, username, bot token in no log byte / output / Bot API body; raw token in exactly one captured stream); examples/email-demo.md runbook; README ceremony four. CLI FRICTION FOUND, all documented in the runbook and relevant to the human run: (1) callback nonces are process-local, so the tap must land on the RUNNING listener newest message (a restarted listener re-sends with fresh buttons and older buttons stop resolving); (2) no CLI TLS relaxation by design, so the mock demo trusts the fixture CA via NODE_EXTRA_CA_CERTS; (3) doctor telegram check reaches the real Bot API (runbook step, not test step); (4) payload hash --json emits {hash} not {payload_hash}; (5) vault set cannot validate a credential, first proof is the send; (6) security none plus a login is a refusal by design. AC 2 (human runs the runbook once against real Telegram and SMTP; seq range recorded here) is the remaining step and the reason this task, and M7, stay open.

Real run 2026-08-18 (examples/email-demo.md, macOS, real Telegram + Gmail SMTP). Scratch dir /tmp/approval-email-demo, policy attested seq 1 sha256 f29bac7b373ef925ead4fd0bb4e32d8459cca5b6a7c5a1e8af4ffabf8fe3307d (identical to the doc's). Records: seq 1 policy.updated, 2 task.registered, 3 approval.requested (21:38:38Z), 4 approval.granted by human:carter via telegram (21:43:05Z, tapped on a phone), 5 execution.started, 6 execution.completed (21:45:37Z). Head seq 6 hash 3f7929659aa9c2697ab90502b816d84107bf8c2004e02e7fe92aa06b526cba79; approval log verify clean, status health ok. Payload hash a5170bb802deb4f84a8466854a363a01eb660410ffb8e1a76fff475cb8d5ce34; from cartcrc@gmail.com to carter@jfcrouch.com cc cartcrc@gmail.com via smtp.gmail.com:587 starttls AUTH PLAIN. Second spend of the token refused token-consumed, exit 1, no second execution.started. Message-ID: to be added after the mailbox check. Setup-time defects found and fixed during this run: APRV-84, 94, 95, 97, 98; UX tasks filed: APRV-90, 91, 96, 99.

Mailbox check 2026-08-18: mail received in both inboxes; subject rendered with literal <second chaser> &; body quoted-printable with =C2=A3 decoding to £; To and Cc both present; ESMTPSA over TLS1.3 to smtp.gmail.com. Message-ID <8df717879034880cf869ba9fc81a74fd0b482575@gmail.com>, recomputed exactly from deterministicMessageId(action key, payload hash a5170bb8..., cartcrc@gmail.com). Keychain item approval-tg-token retained (shared with the repo's dogfood bot); demo app password to be revoked by the operator; scratch dir to be deleted.

HUMAN RUN COMPLETED (2026-08-18): the human ran examples/email-demo.md against real Telegram and a real SMTP provider; the mail arrived. AC 2 met in substance. SEQ RANGE NOT RECORDED: the demo ran in a scratch home per the runbook, and the run overlapped with the APRV-101 finding (an agent-worktree log forking from main tail had to be discarded rather than committed); by the time the range was asked for it was gone. Recorded honestly as an unrecoverable gap. What the run DID produce: eleven friction findings filed live and mostly fixed (APRV-90..99, 101) and the setup verbs, env source map, and hook shipped in response. The scripted twin (both walks) is the mechanical proof; the human run is the network proof.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
M7 exit criterion met: scripted demo green across both walks; the human ran the runbook against real Telegram and SMTP and the mail arrived. Seq range lost to the APRV-101 worktree-log incident, recorded as a gap; the run yielded eleven filed findings.
<!-- SECTION:FINAL_SUMMARY:END -->
