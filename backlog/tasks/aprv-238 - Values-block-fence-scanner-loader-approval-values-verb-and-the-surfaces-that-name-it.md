---
id: APRV-238
title: >-
  Values block: fence scanner, loader, approval values verb, and the surfaces
  that name it
status: To Do
assignee: []
created_date: '2026-09-02 20:45'
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
- [ ] #1 src/core/md-fence.ts exports scanFences(markdown, infoString); scanPolicyFences in policy-load.ts is a one-line wrapper; tests/policy-load.test.ts passes unchanged
- [ ] #2 src/core/values.ts exports VALUES_INFO_STRING, Values, loadValues, loadValuesText; absence is ok:true present:false; two blocks fail multiple-blocks; an unterminated values fence fails unterminated-fence; YAML goes through parseHardenedYaml
- [ ] #3 loadPolicyText result is deep-equal across an APPROVAL.md with the values block absent, valid, malformed, and duplicated (asserted over the new fixtures)
- [ ] #4 Fixtures exist: schema/fixtures/policy-md/valid/with-values.md and schema/fixtures/values-md/{valid,invalid}/ covering absent, two-blocks, unterminated, yaml-error, schema-invalid
- [ ] #5 `approval values` ships with VALUES_BANNER on every output form, the exact absent sentence, exit 1 plus load code for an unreadable block, and --json matching the registry output schema {ok,path,present,note,values|null}
- [ ] #6 Verb wired in all four places (src/cli/values.ts + main.ts dispatch; VALUES_HELP with why("values"); ## values in docs/cli-reference.md; VerbSpec human_only:false with human_only_note); tests/cli-help.test.ts and tests/cli-instructions.test.ts pass with no exemptions
- [ ] #7 MCP server publishes tool `values`; it is not in GUEST_VERBS; tests/mcp-server.test.ts asserts both
- [ ] #8 MCP instructions string and `approval instructions` GUIDE_BODY name `approval values`, label it guidance-not-policy, and tell a session to read it at start; no SessionStart hook is added
- [ ] #9 `approval doctor` gains a values-block check: pass when absent or valid, fail with a fix line when present and unreadable
- [ ] #10 tests/values.test.ts and tests/cli-values.test.ts added; tests/values-inert.test.ts extended with the behavioural-equivalence cases for loadPolicy, resolve, and policy check --json
<!-- AC:END -->
