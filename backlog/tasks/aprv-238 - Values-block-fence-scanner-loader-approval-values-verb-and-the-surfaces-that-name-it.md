---
id: APRV-238
title: >-
  Values block: fence scanner, loader, approval values verb, and the surfaces
  that name it
status: In Progress
assignee:
  - '@opus-238'
created_date: '2026-09-02 20:45'
updated_date: '2026-09-04 22:41'
labels:
  - welfare
  - cli
  - mcp
dependencies:
  - APRV-237
ordinal: 193000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Parse the optional `yaml approval-values` block defined in APRV-237 and give agents a way to read it. A new leaf module src/core/md-fence.ts exports scanFences(markdown, infoString), lifted from scanPolicyFences; src/core/values.ts loads the block with a three-state result (present, absent, unreadable) and never imports the policy loader. `approval values [--policy|--dir] [--json]` prints it behind a HUMAN-AUTHORED GUIDANCE banner, prints exactly "the operator has declared no values here." when absent, and exits 1 with the load code when the block is unreadable. A broken values block must never make the policy unloadable, and it is surfaced by `approval values` and a doctor check rather than policy check, whose explanation is the enforcement trace. Depends on APRV-237.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 src/core/md-fence.ts exports scanFences(markdown, infoString); scanPolicyFences in policy-load.ts is a one-line wrapper; tests/policy-load.test.ts passes unchanged
- [x] #2 src/core/values.ts exports VALUES_INFO_STRING, Values, loadValues, loadValuesText; absence is ok:true present:false; two blocks fail multiple-blocks; an unterminated values fence fails unterminated-fence; YAML goes through parseHardenedYaml
- [x] #3 loadPolicyText result is deep-equal across an APPROVAL.md with the values block absent, valid, malformed, and duplicated (asserted over the new fixtures)
- [x] #4 Fixtures exist: schema/fixtures/policy-md/valid/with-values.md and schema/fixtures/values-md/{valid,invalid}/ covering absent, two-blocks, unterminated, yaml-error, schema-invalid
- [x] #5 `approval values` ships with VALUES_BANNER on every output form, the exact absent sentence, exit 1 plus load code for an unreadable block, and --json matching the registry output schema {ok,path,present,note,values|null}
- [x] #6 Verb wired in all four places (src/cli/values.ts + main.ts dispatch; VALUES_HELP with why("values"); ## values in docs/cli-reference.md; VerbSpec human_only:false with human_only_note); tests/cli-help.test.ts and tests/cli-instructions.test.ts pass with no exemptions
- [x] #7 MCP server publishes tool `values`; it is not in GUEST_VERBS; tests/mcp-server.test.ts asserts both
- [x] #8 MCP instructions string and `approval instructions` GUIDE_BODY name `approval values`, label it guidance-not-policy, and tell a session to read it at start; no SessionStart hook is added
- [x] #9 `approval doctor` gains a values-block check: pass when absent or valid, fail with a fix line when present and unreadable
- [x] #10 tests/values.test.ts and tests/cli-values.test.ts added; tests/values-inert.test.ts extended with the behavioural-equivalence cases for loadPolicy, resolve, and policy check --json
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. src/core/md-fence.ts: lift scanPolicyFences + normaliseInfoString + FenceScan out of policy-load.ts as scanFences(markdown, infoString); policy-load's scanPolicyFences becomes a one-line wrapper.
2. src/core/values.ts: VALUES_INFO_STRING, Values, ValuesLoadFailureCode, ValuesLoadResult, loadValues, loadValuesText. Own file discovery (APPROVAL.md then APPROVALS.md via POLICY_FILENAMES); YAML through parseHardenedYaml; schema via validate("values"). Never calls loadPolicyText.
3. Fixtures: schema/fixtures/policy-md/valid/with-values.md and schema/fixtures/values-md/{valid,invalid}/ (absent, with-values, two-blocks, unterminated, yaml-error, schema-invalid). tests/fixtures.test.ts reads only *.json so the .md tree is invisible to it; policy-md is loaded by explicit name, no globbing.
4. tests/values.test.ts (three-state result, each failure code, policy deep-equality across the four variants, hardened YAML rules); extend tests/values-inert.test.ts with the behavioural half (loadPolicy, resolve/policy matching over a class matrix, policy check --json).
5. src/cli/values.ts: approval values [--policy|--dir] [--json], VALUES_BANNER on every form, exact absent sentence, exit 1 + code on an unreadable block. Modelled on journal read.
6. Wire: main.ts case "values"; VALUES_HELP + ROOT_HELP verb list in help.ts; ## values in docs/cli-reference.md; VerbSpec in verb-registry.ts (human_only false, human_only_note). Add "values" to AGENT_FACING in tests/cli-instructions.test.ts (the registry demands every verb be in one list).
7. MCP: confirm tool values publishes, not in GUEST_VERBS; assertions in tests/mcp-server.test.ts and tests/mcp-guest.test.ts; one sentence in the server instructions beside the journal sentence.
8. instructions.ts GUIDE_BODY: WHAT THE OPERATOR ASKED FOR section after the journal section.
9. doctor.ts: values-block check appended last; bump tests/cli-doctor.test.ts check list, status list and count 20 -> 21.
10. tests/cli-values.test.ts: banner, absent sentence, exit 1 per broken fixture, --json against the registry schema, --policy/--dir precedence.
11. build, targeted node --test, lint, typecheck, full npm test.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Completed across TWO agent sessions: the first (@opus-238) landed src/core/md-fence.ts, src/core/values.ts, src/cli/values.ts, the fixtures, tests/values.test.ts and tests/cli-values.test.ts, and the wiring edits, then hit a rate limit with 5 tests red. The second session diagnosed and fixed those five, then finished AC7, AC8 and AC10. The plan above is the first session's and it was accurate; nothing in it was abandoned.

WHAT THE DIFF DOES NOT SHOW.

1. The five red tests were three different bugs, and only one was in the product code.
   * tests/cli-values.test.ts "a broken block leaves the policy answering exactly as it did" compared `policy check --json` from two DIFFERENT temp directories, so the decisionPath's "policy loaded from <path>" line differed and the deep-equal failed on a fact about the test harness. Fixed by writing both variants to ONE directory in turn, which holds the path constant and lets the comparison stay over the whole object instead of a hand-picked subset. The same test's follow-up assertion (`policy check` never mentions the values block) was matching the suite's own scratch directory name, which contained the word; it now masks the scratch path before reading the output, and tests/values-inert.test.ts's temp prefix was renamed to "approval-md-inert-" for the same reason.
   * The doctor and registry failures were the expected bookkeeping: tests/cli-doctor.test.ts's check-name list, status list and two counts (20 -> 21), and "values" added to AGENT_FACING in tests/cli-instructions.test.ts because the registry demands every verb sit in exactly one of the two lists. Neither is an exemption.

2. AC10's behavioural half went into tests/values-inert.test.ts rather than tests/values.test.ts, deliberately. The property belongs to SPEC.md 11.1 invariant 10, not to the reader, and the person most likely to break it is somebody working on enforcement, who is pointed at the inert file. Three cases: loadPolicy over the four variants; resolve() over a 10-class x 3-reversible matrix (wildcard match, every declared autonomy, a limits-bearing rule, an unmatched class falling to defaults, and the SPEC 7 irreversibility floor); and `policy check --json` byte-compared across four real child processes. Each carries a guard on the guard: the policy must actually LOAD, and the matrix must produce more than one autonomy, so four identical fail-closed answers cannot pass it trivially. The file's header comment was updated where it claimed src/core/values.ts does not exist yet.

3. GUIDE_BODY originally named `approval feedback` beside `approval values`. That verb is APRV-240 and does not exist, so the guide would have told a session to run a command that fails; the sentence was removed and belongs in APRV-240. AC8 is now pinned by a new test ("instructions: the guide points a session at approval values") rather than left to prose review, and the MCP half is pinned in tests/mcp-server.test.ts by reading the server's own instructions string through the client.

4. VALUES_HELP was 29 lines and would have failed APRV-91's 25-line cap in tests/cli-long-help.test.ts (the targeted suites do not include that file, so it only shows up in a full run). Trimmed to exactly 25. `approval values --help --long` prints the docs/cli-reference.md#values section, so the moved prose is one flag away.

5. Prose pass per CLAUDE.md on the new text: em dashes removed from the docs section, VALUES_HELP, ROOT_HELP's verb line and the registry's purpose/human_only_note, and the "is not an error and not a blank" constructions restated affirmatively. VALUES_BANNER's "HUMAN-AUTHORED GUIDANCE, not policy" is unchanged, since the tests pin those words.

6. One lint fix in src/core/values.ts: the schemaDir passthrough spread an object into an object literal (unicorn/no-useless-spread); it now passes the conditional object directly, with a note that exactOptionalPropertyTypes is why the key is omitted rather than passed as undefined.

VERIFICATION. npm run build clean; npm run lint clean (exit 0); npm run typecheck clean (exit 0); full npm test: 3068 tests, 3067 pass, 0 fail, 1 skipped, exit 0, no flakes needed rerunning. Targeted before that: values, cli-values, values-inert, policy-load, cli-help, cli-instructions, cli-doctor, mcp-server, mcp-guest = 218 pass / 0 fail; plus cli-long-help + cli-help + cli-instructions + cli-values = 55 pass / 0 fail after the help trim.

NOT DONE, on purpose: no commit (the orchestrator commits), status left In Progress, and AGENTS.md was left with its unrelated uncommitted edit untouched and unstaged. No global invariant in CLAUDE.md was touched; invariant 10 is the one this task serves, and it is now pinned behaviourally as well as statically.

ONE THING FOR THE HUMAN. A plain `rm -f $TMPDIR/<scratch test log>` from this session classified files.delete.out_of_scope, went to the gate, and timed out after 540s with no decision; the request is still open against the TTL. The file was a test log under TMPDIR, entirely outside the repo. Not blocking (the run was redone under a different filename), but the practical effect of scratch-file cleanup reaching the phone is that sessions stop cleaning up after themselves rather than asking. Also in the journal.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Shipped the values block reader and its surfaces: src/core/md-fence.ts (shared CommonMark fence scanner), src/core/values.ts (three-state loader that never touches the policy loader), approval values (banner on every form, the exact absent sentence, exit 1 with the load code when unreadable), wired in main, help, cli-reference and the verb registry, published as an MCP tool and withheld from guests, named in the MCP instructions and the approval instructions guide, plus a doctor values-block check. tests/values-inert.test.ts carries the behavioural half of invariant 10 for values. Verified with the targeted suites, and a full npm test (3067/3068, one skip) before the merge of origin/main; the affected suites (436 tests) and conformance rerun green after it.
<!-- SECTION:FINAL_SUMMARY:END -->
