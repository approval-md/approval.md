---
id: APRV-245
title: >-
  approval coverage: observed side effects (git, gh, adapter observe) joined to
  verified records, informational
status: In Progress
assignee:
  - '@claude'
created_date: '2026-09-02 21:33'
updated_date: '2026-09-04 23:44'
labels: []
dependencies: []
references:
  - scripts/protected-path-guard.mjs
  - src/adapters/contract.ts
  - src/adapters/agentmail.ts
  - examples/web-agent-demo/runbook.md
priority: high
ordinal: 194000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
MCP use is voluntary: an agent connected through `approval mcp serve --http` (a Grok Bot custom connector, APRV-246) can call `request`/`wait`/`run` or simply act. What makes the gate honest is that side effects leave witnesses we do not write: git history and `gh` for repository effects, the provider's own records for adapter-backed effects (AgentMail sent messages). This verb joins those observed effects against verified records and reports, per effect, the evidence (`task.registered`, `approval.granted`, or `execution.*` of a matching class whose window covers the effect time; for protected paths the guard's `attested`/`granted-file` verdicts from scripts/protected-path-guard.mjs) or `none`. Three tiers are documented with the verb so a green line is never over-read: prevented by credential custody (adapter-held keys answer only to tokens, SPEC 10.4), witnessed by a log we do not write (this verb), not covered (effects made with credentials the agent holds itself, e.g. pasted into Grok Bot; the remedy is custody). Informational like the APRV-145 harness-start coverage in `approval status`: exit 0 whether or not gaps exist, no verdict moves (SPEC 10.1: a control an operator learns to silence is worse than one that reports beside the verdict). Reads only verified records (11.1 invariant 1); git blobs via git show, never the working tree. Adds an optional `observe(window)` to the adapter contract (src/adapters/contract.ts) with AgentMail as the first implementation, read-only through the same credential provider a probe uses, no token, no send; matched by the message id `execution.completed` records. SPEC 10.1 and 10.4 gain a paragraph each (policy.edit, call out to Carter in the PR).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 src/core/coverage.ts is a pure, deterministic join from observed effects {source,id,class,at,actorHint,detail} plus verified records to per-effect evidence (seq and event type) or none, with totals per source and class; tests cover evidence found, none, class mismatch, window miss, protected-path guard verdicts, and an agent: author with no records; test logs are built through the real append path
- [ ] #2 Sources under src/core/coverage-sources/: git (commits, merges into main, tags between --base and --head via git log/show/for-each-ref, commit author as actorHint), gh (PRs opened or merged in the window when gh is on PATH, reported absent otherwise), adapter (calls observe on adapters that implement it); each has fixture tests
- [ ] #3 The adapter contract gains optional observe(window) returning observed effects with provider ids; the conformance suite covers it; the AgentMail adapter implements it by listing sent messages for the configured inbox (endpoint verified against docs.agentmail.to and cited in the notes), read-only, no token
- [ ] #4 `approval coverage [--base <ref>] [--head <ref>] [--since <duration>] [--source git,gh,agentmail] [--json]` prints a table (source, effect, class, evidence seq or none) and a coverage line per source, exits 0 with or without gaps; registered in the verb registry, help, and docs/cli-reference.md with the three tiers written under the verb
- [ ] #5 `approval status` quotes the git coverage line for the current branch range, informational
- [ ] #6 SPEC.md 10.1 gains a coverage paragraph beside the APRV-145 text and 10.4 a sentence for observe, both marked pending sign-off and called out in the PR
- [ ] #7 npm test, lint, and npm run check:changed pass; `approval coverage --base origin/main~20 --head origin/main` runs on this repository and exits 0
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Finished the verb, the status row, the docs and the suites on branch aprv-245-coverage; nothing committed and nothing pushed.

WHAT LANDED. src/cli/coverage.ts gained the local policyLocation helper (the same four lines cli/execute.ts gives status, spelled again rather than imported so that a verb whose whole promise is writing nothing does not pull in the appender and the child spawner) and exports commandCoverage. src/cli/help.ts gained COVERAGE_HELP (25 lines, at the cap), a ROOT_HELP usage entry beside queue and an Inspect line after status; STATUS_HELP now names harness_outcomes and git coverage. src/cli/verb-registry.ts gained the coverage VerbSpec after status (human_only false, exit codes 0/2/3/4, a closed output object whose evidence member carries seq/event/verdict with the unused half null) and the status schema gained a required coverage object. src/cli/main.ts dispatches coverage. docs/cli-reference.md gained a ## coverage section after ## status, an observe paragraph under ## adapter, and the coverage field in the ## status prose and JSON example.

THE WINDOW RULE. Evidence for one observed effect is the EARLIEST record that is (1) one of task.registered, approval.granted, execution.started, execution.completed; (2) of a matching class, exact first and only then a FAMILY match on the first two dotted segments, reported distinctly as match: family so a weaker match is never dressed as a strong one; (3) inside [at - 24h, at + 5m]. The window is asymmetric on purpose: 24h back because the ordinary shape is register-request-grant-act and the gap is a working day at worst, while a week back would let one grant carry every later effect of its class (the laundering hole APRV-202 closed in the protected-path guard); 5m forward because that is clock skew between git's author date and this log, and not an ordering allowance. A protected FILE path takes the guard's byte-level verdict instead, and only its attested and granted-file verdicts: granted-command attributes by time, which is the same strength of claim the class-and-window rule makes, so surfacing it beside attested would flatten the distinction the guard exists to draw.

THE GIT CLASS MAPPING. A commit reachable from origin/main is vcs.push.main (the class names the trunk moving, and a commit on the trunk moved it however it got there); any other commit in the range is vcs.commit.branch; a tag is release.publish; a protected path a commit changed is its own policy.edit effect carrying the path, so the guard's verdict can be put against it. A merge is a trunk commit that says merge in its detail and gets no class of its own, because the policy has none for it and an effect nobody can declare is an effect nothing can cover. With no trunk ref resolvable, every commit is reported as a branch commit and the source says the trunk was unknown in its own reason.

THE LABEL FILTER. observeAgentmail asks GET /v0/inboxes/{id}/messages with after/before/limit (page_token on later pages) and keeps the messages whose labels array contains 'sent', case-insensitively. The filter is CLIENT-SIDE, and the limit is worth stating: the documented list endpoint exposes no sent-only parameter, so the request reads received mail as well (a read, changing nothing), and a provider that stopped labelling sent mail would make this source report an empty window rather than an error. A message with no labels is not admitted, which is the fail-closed direction for a report about sends. Endpoint and field names verified against docs.agentmail.to/api-reference/inboxes/messages/list.

THE STATUS ROW. approval status gained an informational 'git coverage' row beside 'harness outcomes' and a coverage object in --json ({available, reason, observed, covered}, always present). The range is defaultRange's: merge-base with origin/main through HEAD, so it counts this BRANCH's own commits. Two states replace the numbers rather than faking them, because in neither would a count mean anything: 'not a git checkout', and 'origin/main absent'. The fallback to the last twenty commits is deliberately NOT taken here: approval coverage announces that guess in its own output where there is room to say so, and a one-line summary that silently changed what it measured would be worse than one that says it cannot measure. It is outside healthy and outside the exit code, citing APRV-145: a coverage measurement is not an integrity verdict.

INVARIANTS. This verb touches SPEC section 11.1 invariant 1 and satisfies it: it reads through readVerifiedRecords and has no way to reach unverified records, and it writes nothing anywhere — no append, no render, no cache — which is exactly what lets it be informational and safe to run on a timer. tests/cli-coverage.test.ts pins that by byte-comparing the log before and after and re-verifying the chain. Invariant 3: every adapter detail goes through redactSecrets twice, once in the adapter's own reader and once in the source layer. Invariant 4: actorHint is printed and never matched on, because a commit author email is whatever the committer configured; a test asserts an agent: hint changes no verdict. Invariant 7: the agentmail source builds vaultCredentialProvider with the policy's passphraseEnv and NO envFilePath, because the .approval/env passphrase fallback is defensible only inside a consumed-token window and a reporting verb holds no token; a vault that will not open is an unavailable SOURCE with a reason, never an exit code.

SPEC GATE. Section 10.1 gained its coverage paragraph, marked (APRV-245, pending sign-off): the hook classified it policy.edit and the human's decision came through on the retry. The section 10.4 sentence for observe is NOT in the tree: four attempts each timed out at the hook's 540s wait with no decision, and the request is still open. It needs one more retry once the approver answers, or a hand-applied edit. Both paragraphs need Carter's sign-off in the PR either way.

FOLLOW-UP. The AgentMail join is by class and window, not by provider message id: execution.completed records an exit_code and the provider's id reaches only the CLI result, so an id-level binding needs an event-schema amendment. That is APRV-251, and docs/cli-reference.md and the adapter's own comment both name it so a reader is never left thinking the id in the report was matched on.

VERIFICATION. npm run build clean; npm test 3110 tests, 3109 pass, 1 skipped, 0 fail, exit 0; npm run lint clean; npm run typecheck clean; npm run check:changed classified 'full' and passed the same 3110 with lint and typecheck, exit 0. approval coverage --base origin/main~20 --head origin/main exits 0 (git: 104 of 161 effects carry evidence with --source git; with the default git,gh over origin/main~5 it is git 3 of 32 and gh 166 of 192). approval status in the worktree prints 'git coverage  0 of 0 effects carry evidence', which is correct: this branch has committed nothing yet.
<!-- SECTION:NOTES:END -->
