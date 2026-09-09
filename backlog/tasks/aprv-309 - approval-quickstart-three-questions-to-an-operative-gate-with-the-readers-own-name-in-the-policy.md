---
id: APRV-309
title: >-
  approval quickstart: three questions to an operative gate with the reader's
  own name in the policy
status: In Progress
assignee: []
created_date: '2026-09-08 06:47'
updated_date: '2026-09-09 07:33'
labels:
  - dogfood
dependencies: []
priority: high
ordinal: 227000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The README's quick path (PR #342) is init, a sed that renames the scaffold's approver from alice to the reader, and attest. The sed is a text substitution on a file the reader has not read, and it exists because the scaffold names an approver who is not them; without it a grant on communicate.email.external refuses actor-not-approver. docs/proposals/solo-dev-quickstart.md designs the replacement: one interactive verb that asks who you are, where the button goes, and what must always ask, then writes the policy with those answers in it, stores the channel token, and attests in the same session. Reuses setup identity, setup channel telegram and policy attest; new are the prompt flow and the template.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 approval quickstart is interactive by refusal (a pipe or --json exits 2 and prints the non-interactive equivalents), asks three questions (name; Telegram token or this terminal; a checklist of the classes that must always ask, defaulting to all on: send a message or email, spend money, delete files, post publicly, push to main), and writes APPROVAL.md from a solo template with the reader name as the sole approver, the checklist class families manual, defaults.autonomy autonomous, no audit block, and comments on how to add sampling and how to tighten
- [ ] #2 It runs setup identity, stores a Telegram token through the same keystore path setup channel telegram uses, writes .approval/env, and attests the policy only after showing its exact bytes and receiving typed understood; it prints ready: N selected class families ask human:<name> on <channel>; other classified reversible actions use the autonomous default (or an equally concise statement that preserves protected controls and fail-closed classification), plus a try: line naming approval hook classify
- [ ] #3 Doctor output appears only when a step failed; a fresh directory after quickstart has 0 failed rows when checked with the explicit identity context (the solo template names no audit block, so audit-sampling reports not applicable), and the success output tells the operator to activate .approval/env explicitly
- [ ] #4 tests/cli-quickstart.test.ts drives the actual terminal flow plus pipe and --json refusals, asserts the written policy loads, resolves the five selected class families manual and read.shell autonomous through the default, and proves a grant by the named human on communicate.email.external is not refused actor-not-approver; docs/cli-reference.md gains the verb; the README quick path uses approval quickstart
- [ ] #5 SPEC.md 10.1 CLI list gains the verb (exact amendment text in implementation notes for hand application; no SPEC edit from the implementation lane)
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Implement a human-only approval quickstart command from current origin/main. Add one prompt flow that validates a schema-safe human id, chooses terminal or Telegram, and parses a default-all checklist into communicate.*, financial.*, files.delete.*, public.*, and vcs.push.main. Render and validate a solo policy in memory, preflight scaffold paths without overwriting existing policy state, create the ordinary init artifacts, write identity through the existing env-file path, and delegate Telegram credentials and chat discovery to the existing setup-channel seam. Show the exact generated policy, require typed understood, and only then call the real attestation path with the explicit human actor. Classify quickstart as policy.core and mark it human_only in the verb registry so MCP omits it. Capture doctor output, print it only on failure, and keep later shells explicit with eval "$(approval env)". Add isolated terminal, non-TTY, policy resolution, approver, classification, MCP registry, doctor, and secret-redaction tests. Update README and CLI reference. Do not edit SPEC.md; record exact proposed §10.1 text for the parent to apply through the protected ceremony. No dependency, CI, version, credential, live-policy, or release changes.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented the operative quickstart source in /private/tmp/approval-quickstart-runtime on codex/operative-quickstart from main c9e0718. Added a human-only, terminal-only quickstart command with three decisions, schema-safe identity validation, actual class-family policy rendering, non-overwriting init scaffolding, the existing env-file writer, the existing Telegram keystore/chat-discovery flow, full policy display, typed understood, real policy attestation, captured doctor diagnostics, explicit approval env activation, policy.core command classification, and MCP exclusion. The published npm package remains 0.1.0 and does not contain quickstart; README labels the command source-only and preserves the manual 0.1.0 fallback. Dedicated tests cover real CLI pipe/JSON refusal, terminal policy load and resolution, unattested abort, existing-policy preservation, named-approver grant, Telegram fake-keystore/fixed-response transport with token redaction, doctor output suppression/failure visibility, registry, and classifier behavior. Exact protected SPEC text is in /private/tmp/aprv309-spec-amendment.md for hand application; SPEC.md was not edited. Checks: npm ci exit 0; npm run build exit 0; node --test dist/tests/cli-quickstart.test.js exit 0 (9/9); npm run typecheck exit 0; npm run lint exit 0; help/long-help/docs focused suite exit 0 (50/50); registry/instructions targeted suite exit 0 (4/4); command-class registry targeted suite exit 0 (2/2). A real Python forkpty smoke drove the production CLI through all prompts and attestation in an isolated /private/tmp fixture; doctor exited 1 only because the managed sandbox refused its loopback bind, and printed that row as required. An earlier broad focused batch also encountered the same host sandbox egress-sandbox limitation in an unrelated cli-instructions token-run capture; its relevant targeted rerun passed. No live policy, repository env, credential, package, CI, release, or agent configuration was modified.

Parent review hardening: quickstart now refuses any pre-existing policy or .approval instance state before prompting; resolves only the freshly written instance source map for doctor (including the configured Telegram token/chat through the explicit source runner, never ambient approval credentials); runs doctor as a bounded pre-attestation preflight and accepts only its expected never-attested row; and uses appendAttestation expectedSha256 so the record is bound to the exact displayed bytes and a change before append leaves the log untouched. The doctor child has a 20s timeout and 256 KiB per-stream output bound. Focused regressions cover existing-home refusal, changed-after-review refusal/no append, ordinary attest compatibility, Telegram instance resolution, preflight failure remaining unattested, and timeout abort.

Verification correction and environment boundary: --api-base is now passed unchanged to both Telegram setup and doctor. The doctor child removes every ambient variable under the canonical APPROVAL_, TELEGRAM_, VAULT_, and AGENTMAIL_ credential families, then overlays only values explicitly resolved from the just-created instance and the selected actor. The activation line includes approval env --dir with a safely shell-quoted absolute target. A real local Telegram mock test uses hostile ambient credential values and proves setup getMe/getUpdates plus doctor getMe all use only the selected local endpoint and fresh-instance token. Verification incident: before this correction, one standalone doctor command was accidentally run from the worktree with ambient Telegram variables and performed doctors documented read-only getMe identity probe; it sent no message and consumed no update. No secret values, output identities, or account metadata are recorded here. The subsequent isolated verification explicitly removed ambient approval credentials.

Final verification after endpoint/environment fixes: npm run build exit 0; node --test dist/tests/cli-quickstart.test.js exit 0 (14/14, loopback enabled); npm run typecheck exit 0; npm run lint exit 0; real forkpty terminal quickstart exit 0 with the absolute --dir activation line; final full `env -u APPROVAL_HUMAN ... npm test` with loopback enabled exit 0 (4010 tests: 4009 pass, 0 fail, 1 skip). A prior escalated full run without clearing the hosts identity exited 1 (4006 pass, 2 identity-sensitive existing setup tests failed, 1 skip); the credential-scrubbed final run is the valid suite evidence.

Overnight resumption explicitly authorized 2026-09-09. Parent reviewed and applied the existing three exact SPEC amendment payloads through the primary gate under original immutable declaration codex-aprv-309-spec (registration seq30063). Successful outcomes30130/30132/30134; complete-file hashes checked at every step. An attempted duplicate declaration was refused before any write, then the original identity was reused. Current reviewed runtime supplied payload retention while primary policy/log/cwd remained pinned. These were policy-authorized nonmanual edits, not a human grant; pending-sign-off suffix remains. Human-only quickstart semantics, exact displayed-byte attestation and no automatic service activation are preserved. Implementation still needs final current-main integration, validation and GitHub delivery before task completion.
<!-- SECTION:NOTES:END -->
