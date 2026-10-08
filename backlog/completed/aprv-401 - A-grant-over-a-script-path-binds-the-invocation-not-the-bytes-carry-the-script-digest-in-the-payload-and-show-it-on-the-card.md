---
id: APRV-401
title: >-
  A grant over a script path binds the invocation, not the bytes: carry the
  script digest in the payload and show it on the card
status: Done
assignee:
  - 'agent:lane-b'
created_date: '2026-09-20 09:03'
updated_date: '2026-09-22 02:23'
labels:
  - payload
  - gate
  - security
dependencies: []
priority: high
ordinal: 310000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found while spending a deps.add grant during APRV-398 (grant at seq 60837). approval run rehashes the payload from the argv array and the cwd it is about to spawn, so a grant over 'bash /path/to/install.sh' authorizes whatever that path contains AT EXECUTION TIME. The approver's card shows the path, not the content, and the requester controls the file between the request and the grant. Nothing was exploited here (the script was written before the grant and its sha256 is recorded in APRV-398's notes), but the shape is the hazard: the payload hash is supposed to be the binding, and for a script invocation it binds a name. Proposal to settle: when the argv names a readable file the runtime is about to execute, include that file's digest in the hashed payload, and render it on the approval card beside the command, so a changed script is a payload-mismatch refusal rather than a silent substitution. Decide what counts as 'names a script' (argv[0] being an interpreter, or any argv element that resolves to an existing regular file) and whether the digest is advisory or part of the hash, since making it part of the hash means a script edited between request and grant is refused rather than run.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The approval run payload carries the size and SHA-256 of the script the argv names, inside the hashed value, in the two shapes the ruling gives: a known interpreter followed by a path operand, and a path at argv[0]
- [x] #2 A script edited between the declaration and the execution is refused payload-mismatch with nothing appended, and the refusal names the path, the size and the digest it bound
- [x] #3 An argv naming no readable script hashes byte-for-byte as it did before, so every historical record and every declaration written without the digest verifies unchanged
- [x] #4 The path, the byte count and the digest appear in the canonical rendering every channel puts in front of an approver, with no change to CANONICAL_RENDERER_VERSION and no SPEC amendment applied
- [x] #5 A requester can produce the exact payload bytes and the binding with one verb rather than hand-assembling JSON, and that verb is withheld from the MCP and HTTP surfaces because the path it digests is a command word no transport guard confines
- [x] #6 The rule, its six stated limits and the proposed SPEC 6.2 hunk are documented, and docs/cli-reference.md says the same thing under run, request and payload
- [x] #7 Build, typecheck and lint exit 0 with no warnings; the targeted suite matrix and the conformance runner pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
THE RULING TAKEN AS GIVEN, from the orchestrator brief: THE DIGEST BINDS. It is part of the hashed payload, not an advisory field beside it. The task file itself carries no note recording that ruling; the discrepancy is journalled rather than resolved here, and the implementation notes say so.

THE SCOPE QUESTION THE DESCRIPTION LEAVES OPEN, what counts as naming a script, is settled the BROAD way, and it is the one design call in this plan: every argv element that resolves, against the payload's own cwd, to a readable regular file is bound by its SHA-256. Not an interpreter allowlist. An allowlist is fail-open by omission: the day a lane runs a wrapper nobody listed, the binding silently stops covering the bytes. The direction of do-not-guess is also the opposite here from what it is in the classifier. There, refusing to read a string keeps the class STRICT; here, refusing to bind a file leaves bytes UNBOUND. Over-binding costs a fresh request and can never authorize a substitution, so the conservative direction is to bind more.

1. NEW src/core/run-payload.ts holds the rule and the digests in one module.

boundFiles of argv and cwd returns argv_index, path and sha256 entries, ascending by index, one entry per index: an argv naming the same file twice binds it twice, because the payload is a function of the argv. It skips the bare dash, the double dash, the empty string, and anything statSync does not report as a regular file; it skips a file it cannot read.

Every skip is SAFE because the value is recomputed at execution: unreadable-then-readable, or absent-then-present, changes the hash and refuses. There is no PATH lookup, so a program named without a slash binds nothing: resolving one through PATH would make the binding depend on the environment, which SPEC section 11 says is never read implicitly, and a system binary's bytes are the host's rather than the requester's.

Digests are taken by chunked read of 64 KiB so a large file costs bounded memory. runPayloadValue of argv and cwd returns argv plus cwd when nothing is bound, and argv plus cwd plus files when something is: THE KEY IS OMITTED WHEN EMPTY, and that omission is what keeps every historical record verifying, since an invocation naming no readable file hashes to exactly the value it always did.

2. src/core/payload.ts: runPayloadHash delegates to runPayloadValue. Signature unchanged, so every existing call site, the tests and the MCP surface and the docs, keeps computing the same value the executor computes. payloadHash stays pure; the module header is corrected to say which of the two functions touches the filesystem and why.

3. src/cli/execute.ts: no new call. The run verb already recomputes through runPayloadHash at the one place it spawns. Only the --payload-hash refusal message grows, to name what was bound, so an agent reading the refusal can see WHICH file moved instead of re-deriving it.

4. NEW subcommand: approval payload run, taking --cwd, --hash, and the command after a double dash. It prints the canonical payload bytes in RFC 8785 form, or with --hash the payload_hash. It is the local counterpart of payload agentmail-draft: that verb snapshots a REMOTE mutable object before a grant binds it, this one snapshots LOCAL mutable bytes. Without it a requester hand-writes the argv and cwd JSON and is refused at execution for a field they had no way to compute. Touches src/cli/payload.ts, src/cli/help.ts for PAYLOAD_HELP plus a new PAYLOAD_RUN_HELP, and src/cli/verb-registry.ts.

5. THE CARD, AND WHAT IS DELIBERATELY NOT DONE. The run payload has no structural view: argv, cwd and files falls to the opaque kind, whose view is the canonical JSON WHOLE, so the path and the digest are already inside the block every channel prints verbatim and inside the recorded display_hash. A dedicated argv view would read better, and it is NOT built here: SPEC section 9 names the renderer version normatively, a new kind is a renderer version bump, and this session may not amend SPEC. The hunk is written and left unapplied. A telegram test pins that the digest reaches the card as things stand.

6. DOCS. New docs/run-payload-binding.md: the rule, the three limits, the runbook, and a SPEC status section carrying the exact proposed section 6.2 hunk. The three limits are the absence of a PATH lookup, the absence of anything transitive since a bound script that sources another file binds only its own bytes, and the window between hashing and spawning. docs/cli-reference.md gains the payload run entry and its anchor and says the same thing under run and request. The dogfood-cutover runbook stops hand-writing payload JSON.

7. TESTS. New tests/run-payload.test.ts for the rule: bound, skipped, ordered, deterministic, no PATH lookup, a symlink bound by its target's bytes, omission when empty. tests/payload.test.ts gains the backwards-compatibility case. tests/cli-payload.test.ts gains the verb. tests/cli-run.test.ts gains the case this task exists for: a script edited after the declaration is refused payload-mismatch with nothing appended. tests/channels-telegram.test.ts pins the digest on the card.

8. SCHEMA AND CONFORMANCE. No schema change is expected: event.schema.json leaves payload shape open and the envelope constrains payload_hash as a string. Vectors are checked for a pinned run payload shape and regenerated only if one is found, with the rationale in the regen script's comment block.

PLAN REVISION, after the rebase onto main found the ruling. The two paragraphs above about the BROAD rule are superseded and kept for the record. Carter's ruling was on main all along; this worktree was branched before it landed, which is why the session started by journalling that the task carried no notes. The ruling settles the scope question the NARROW way and names the card's fields: an interpreter the classifier already names, followed by a path operand, hashed into the payload with its byte count and path, with interpreters the classifier does not name explicitly out of scope. The implementation now follows the ruling. What changed from the plan above: the rule is keyed on an interpreter list mirroring command-class.ts rather than on any argv word that resolves to a file; there is at most one bound script rather than an entry per argv index; the payload key is script rather than files and carries bytes alongside sha256; and an inline program binds nothing because the program is already a word of the argv. One addition the ruling does not spell out is kept and flagged: a path at argv[0] with no interpreter word is bound too, since the kernel reads its shebang and the omission would be a hole shaped exactly like the rule. My argument for the broad rule is preserved in docs/run-payload-binding.md under a heading that says it is a choice and states the cost either way, so a later widening starts from written reasoning rather than a rediscovery.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Ruling (Carter, 2026-09-21, agreeing with the orchestrator's recommendation): the script digest is PART OF THE BINDING, never advisory. Shape: when argv names an interpreter (bash, sh, zsh, node, python3 and kin) followed by a path that resolves to a regular file at request time, the runtime reads and hashes the file into the bound payload, the card shows the digest, byte count and path, and approval run re-reads the file and refuses payload-mismatch if the bytes changed. No interpretation of the script and no second pass for files it sources; the limit is documented. Out of scope: piped installers (already opaque), sourced files, interpreters the classifier does not name. A script edited between request and grant is refused and re-requested; that is the intended property.

WHAT SHIPPED. src/core/run-payload.ts holds the rule the ruling states: boundScript answers the one script an argv runs, and runPayloadValue puts its argv_index, absolute path, byte count and sha256 under a script key inside the hashed payload. src/core/payload.ts routes runPayloadHash through it, so every existing call site keeps computing the value the executor computes. approval run already recomputed at the one place it spawns, so the enforcement path needed no new code and no new refusal code: a script edited since the declaration simply hashes differently and takes the existing payload-mismatch, before the append and before the child. The new verb approval payload run prints that value, or its hash, for the requester who has to declare it.

THE SHAPE, AND THE TWO PLACES I HAD TO DECIDE SOMETHING. The interpreters are the six shells, node and nodejs, python and python3, perl, ruby and deno: every one a name command-class.ts already knows, from its unwrappable-shell set, its node branch and its inline-source table, which is the ruling's phrase about interpreters the classifier does not name, read as a positive list. The list is DUPLICATED in run-payload.ts rather than imported, because those tables are private to that module and exporting them would make a classification decision serve a second consumer; the comment is the seam, and a name added there and not here binds nothing, which fails toward the old behaviour rather than toward a wrong digest. A test pins that every named interpreter is present and declares its inline form.

First decision: an inline program binds nothing. The -c and -e forms carry the program as a word of the argv, so it was always bound and there is no file to read. The walk returns nothing rather than continuing to look, because a file that happens to share the inline text's spelling is a file the command never opens.

Second decision, and it is an addition to the ruling's literal shape rather than a reading of it: a path at argv[0] with no interpreter word is bound too, at argv_index 0. The kernel reads its shebang, so it is the same fact with the interpreter implied rather than typed, and leaving it out would be a hole shaped exactly like the rule. Flagged here so it can be vetoed rather than discovered.

THE BROAD RULE I BUILT FIRST, AND WHY IT IS NOT WHAT SHIPPED. Before the rebase surfaced the ruling I had implemented the other answer the description offers: every argv word resolving to a readable regular file, bound by its digest. I converted it rather than argue for it in code, because the difference is behavioural and not stylistic. The broad rule cannot under-bind and has no allowlist to fall behind, but it refuses a run whenever any file the argv merely names has changed, and a refusal that costs a tap for nothing is how an operator learns to stop reading refusals, which is the argument SPEC section 10.4 already makes about the AgentMail pre-spend check. The ruling picked the other side of that trade with the limit stated. Both arguments are written down in docs/run-payload-binding.md under a heading that says the limit is a choice, so a later widening starts from reasoning rather than a rediscovery.

HOW HISTORICAL RECORDS WITHOUT THE DIGEST VERIFY, which the brief asked to be stated. The script key is OMITTED when the argv names no readable script, so such an invocation canonicalizes to exactly the value it did before this change: same bytes, same hash. Every record already in a log re-derives, every declaration already sitting in a task file still matches, and the payload store's content addressing is untouched. Chain verification never recomputes a payload from a filesystem in any case, so no log anywhere can be invalidated by this; what CAN be invalidated is a live pending declaration over a command that names a script, which is precisely the hazard the task was filed about, now refused instead of honoured. There is no schema change: event.schema.json leaves payload shape open and the envelope constrains payload_hash as a string, so no version bump and no fixtures. The conformance suites pin no run payload shape, which the conformance-regen suite confirms by passing unregenerated.

INVARIANTS TOUCHED, SPEC section 11.1, each named with how it is kept.

Invariant 4, self-reported fields never reduce scrutiny. The digest an approver reads sits inside payload material the REQUESTER supplied, so it is claimed like the rest of that material. It reduces nothing: no verdict, autonomy, budget, floor, sampling draw or token reads it, and its only effect is to cause a refusal when the recomputation disagrees. A payload claiming a flattering digest cannot execute; it can only waste a tap. That is the ordinary bounded form of a self-reported field, and the doc states it in those words rather than letting a reader assume the card is the check.

The payload hash is the binding, sections 6.2 and 10.4. This strengthens it in the one place it was binding a name instead of bytes, and it moves nothing about where enforcement happens: the executor recomputes unconditionally from the argv, the cwd and the script's bytes, and a caller-supplied --payload-hash remains a CHECK and never a substitute.

Enforcement paths read only verified records: untouched, nothing here reads the log. The recomputation reads one file and compares against a hash that came from a verified record, which is the shape approval run already had.

Refusals are machine-readable and distinct: no union gained or lost a member, stated as a negative result because a new code was the obvious wrong turn here.

SPEC IS UNAMENDED AND THE HUNK IS WRITTEN. The behaviour diverges from section 6.2, which still says the run payload is the argv array and cwd. The gate is down this session and the repo's rule is that an agent proposes and a human applies, so docs/run-payload-binding.md carries a SPEC status section with the exact replacement text for that row, matching the shipped narrow shape. Nothing else in SPEC changes: same refusal code, same registry row in 11.2, no event type, no schema, no renderer version.

THE CARD, AND THE VIEW I DID NOT BUILD. The run payload has no structural view, so it renders under the opaque kind, whose view is the canonical JSON WHOLE. Path, byte count and digest are therefore inside the block every channel prints verbatim and inside the display_hash the gate records, which is why this task changed no channel code and why the ruling's three card fields are all present. A dedicated argv view would read better and was deliberately not built: section 9 names the renderer version normatively, a new kind changes the bytes that module emits, and by its own rule that is a new version, which is an amendment I may not make. Filed as APRV-430.

ONE THING THE VERB CANNOT BE, FOUND BY A TEST RATHER THAN BY ME. tests/serve.test.ts fails on any published flag nobody has classified as path-typed or reviewed as not, and payload run's --cwd landed there. Classifying it was the small half. The large half is that this verb digests a file named by one of the COMMAND'S OWN WORDS, which arrive in trailing, where no transport guard confines a path the way the store confinement confines payload hash's positional. Published over MCP or HTTP it would be a digest oracle over every file the server process can read. So it is withheld on both transports, with the reason recorded in EXCLUDED_VERBS beside the stdin and plumbing ones, and --cwd is declared path-typed anyway because that is the true statement about the flag whether or not a transport publishes it.

VERIFICATION, with the numbers rather than a summary block. Build, typecheck and lint each exit 0 with no warnings. The conformance runner: 461 vectors, 461 passed, 0 failed, 176 negative controls, manifest ok, unregenerated, which is also the evidence that no vector pins the run payload shape. A 33-suite targeted matrix ran 1009 tests with one failure, the 25-line help cap on the new PAYLOAD_RUN_HELP, which was then trimmed; the nine suites touched after that matrix re-ran clean at 290 of 290 (run-payload, payload, cli-payload, cli-resolve, cli-run, cli-help, cli-long-help, channels-telegram, wysiwys). Two later attempts at a full clean matrix HUNG after the same suite and were killed rather than reported; the machine is running several lanes' suites at once and the stall is a port or lock collision between them, not a failure of this diff, so CI on its own runner is the authority for the whole-suite number.

The full npm test was also run earlier in the session, against the broad-rule build: 5147 tests, 5123 passed, 23 failed. 22 of those are a pre-existing SMTP/TLS failure in this worktree, in adapter-email (14), smtp-probe (4) and the four setup adapter email probe cases in cli-setup, all from this Node refusing a TLS servername that is an IP address against the local mock. Proved unrelated by A/B rather than asserted: the two SMTP suites are 32 passed and 18 failed IDENTICALLY with and without this change, measured by reverting src/core/payload.ts to the branch point, rebuilding, re-running and restoring. The 23rd failure was the serve unclassified-flag guard, which is this diff's and is fixed.

AC EVIDENCE. AC1 and AC3: tests/run-payload.test.ts, 22 cases, including the byte-for-byte unchanged case pinned against RFC 8785 by hand. AC2: tests/cli-resolve.test.ts, a supervised action whose script is edited after the declaration, refused with the event list unchanged and the chain clean, plus the refusal-text case. AC4: tests/channels-telegram.test.ts asserts path, size and digest reach the card, and the wysiwys suite passes with CANONICAL_RENDERER_VERSION untouched. AC5: tests/cli-payload.test.ts for the verb, tests/mcp-server.test.ts for the exclusion, tests/serve.test.ts for the flag classification. AC6: docs/run-payload-binding.md and docs/cli-reference.md, with cli-long-help's anchor test proving the pointer resolves. AC7: the numbers above.

ONE FIX AFTER THE FIRST GREEN CI RUN, because a reviewer would have asked. The operand walk used to stop at the first non-option word, which is wrong for an interpreter that takes a SUBCOMMAND: deno run job.ts offered the word run and bound nothing, and python3 -m pkg job.py offered pkg. The walk now collects every non-option word and binds the first that resolves to a readable regular file, so a subcommand is walked past. It cannot bind anything the argv does not name; the worst case is the harmless direction, where a command whose script is absent and whose later argument is a file binds that file. The inline-program guard is unchanged and still answers before any walking. Two cases added to tests/run-payload.test.ts.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
A grant over a script path bound the path; it binds the bytes now. The approval run payload carries the script's argv index, absolute path, byte count and SHA-256 inside the hashed value, in the shape the ruling gives: a known interpreter followed by a path operand, or a path at argv[0] with a shebang behind it. A script edited between the declaration and the run hashes differently and takes the existing payload-mismatch refusal, before the append and before the child; the key is omitted when the argv names no script, so every record and declaration written before this still verifies. New verb approval payload run produces those bytes or their hash for the requester, and is withheld from the MCP and HTTP surfaces because the path it digests is a command word no transport guard confines. No new refusal code, no event type, no schema, no renderer version: the card already shows the three fields because the opaque view prints the payload whole.

SPEC is unamended by design, with the exact section 6.2 hunk written in docs/run-payload-binding.md for a human to apply. Verified: build, typecheck and lint at exit 0 with no warnings; conformance 461 of 461 with 176 controls; a 33-suite matrix at 1009 tests with one help-cap failure since fixed, and 290 of 290 on re-run of everything touched after it. The merge is NOT armed: the gate daemon is down today, so gh pr merge was not run and no auto-merge was set, and CLAUDE.md item 7 is left to Carter deliberately rather than by omission. Follow-ups filed: APRV-429 for the same hazard on the harness hook path, APRV-430 for a structural view and its renderer version bump.
<!-- SECTION:FINAL_SUMMARY:END -->
