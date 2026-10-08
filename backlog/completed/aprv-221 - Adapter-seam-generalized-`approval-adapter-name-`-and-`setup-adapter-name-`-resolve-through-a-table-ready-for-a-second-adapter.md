---
id: APRV-221
title: >-
  Adapter seam generalized: `approval adapter <name>` and `setup adapter <name>`
  resolve through a table, ready for a second adapter
status: Done
assignee:
  - '@claude-opus'
created_date: '2026-09-02 16:29'
updated_date: '2026-09-02 16:48'
labels:
  - adapter
  - launch
dependencies: []
priority: high
ordinal: 181000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The CLI dispatches the literal `adapter email` (src/cli/adapter.ts) and the registry (src/adapters/registry.ts) returns a one-element list, so a second adapter has nowhere to plug in. This task opens that seam without changing what the email adapter does, so the AgentMail adapter (next task in this stack) lands as a table entry. Context: AgentMail is the launch-scope adapter Carter decided on 2026-09-02; the stack is this task -> adapter -> CLI face -> prefix/SPEC/docs, and APRV-199 (npm publish) depends on the last of them.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `approval adapter email` output and exit codes are byte-identical before and after (existing tests/cli-adapter.test.ts unchanged and green)
- [x] #2 `approval adapter <unknown>` exits 2 and names the known adapters, driven by the table rather than a literal
- [x] #3 `setup adapter <name>` help text comes from the ADAPTERS table entry, not a name === "email" branch
- [x] #4 The MCP server async-unwrap check matches any `adapter <name>` label, not only `adapter email`
- [x] #5 registry.ts doc comment no longer claims one adapter; declaredCredentialsForClass is covered by a test with two adapters serving one class
- [x] #6 npm test green, lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. src/adapters/registry.ts: export builtInAdapters() and a pure unionRequiredCredentials(adapters, cls); declaredCredentialsForClass keeps its single-argument, roster-only signature (no caller-supplied list). Rewrite the doc comments that claim one adapter.
2. src/cli/adapter.ts: add an ADAPTER_CLIS table (name -> { help, adapter(options) }) plus knownAdapterCliNames(); generalize commandAdapterEmail into commandAdapterExecute(name, entry, ...) with every ADAPTER_EMAIL_HELP reference coming from the entry and the success sentence naming the entry's name; commandAdapter resolves the sub through the table and the unknown-adapter refusal names the known adapters.
3. src/cli/setup-adapter.ts: put help on AdapterSetupEntry (required field), set it on the email entry, delete the name === 'email' ternary.
4. src/mcp/server.ts: the async-unwrap arm matches spec.name === 'adapter' (every 'adapter <name>' label), forwarding the subcommand words like the channel arm below it; fix the two doc comments that name 'adapter email' as the only one.
5. Tests: new registry test in tests/child-env.test.ts proving the union over two test-only adapters serving one class (dedup, order, no leak into the built-in roster). tests/cli-adapter.test.ts stays untouched (AC #1).
6. Verify: npm test, npm run lint, plus live CLI runs for the unknown-adapter refusal and setup adapter help.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Read CLAUDE.md, SPEC-adjacent context, and the four seam files before planning.

APRV-221 implementation.

What changed
- src/cli/adapter.ts: added ADAPTER_CLIS (name -> { help, build(options) }) plus knownAdapterNames(). commandAdapterEmail became commandAdapterExecute(name, entry, argv, streams, cwd): every help reference is entry.help, the adapter instance is entry.build({ timeoutMs }), and the success sentence reads 'through the ${name} adapter' (identical output for email). commandAdapter looks the sub up in the table; the unknown-adapter refusal now appends '; known adapters: email' from the table. EMAIL_FLAGS renamed ADAPTER_FLAGS: one flag set for every adapter, since the token/payload/identity/log/vault question does not vary by adapter.
- src/cli/setup-adapter.ts: AdapterSetupEntry gained a required 'help' field, the email entry sets SETUP_ADAPTER_EMAIL_HELP, and the 'name === "email" ? ... : ...' ternary is gone. SETUP_ADAPTER_HELP now appears only on the paths that run BEFORE a name resolves (bare --help, missing name, unknown name), which is the same text those paths printed before.
- src/adapters/registry.ts: builtInAdapters() is exported and a pure unionRequiredCredentials(adapters, cls) holds the union; declaredCredentialsForClass(cls) delegates to it over the built-in roster. Doc comments no longer claim one adapter.
- src/mcp/server.ts: the async-unwrap arm is now 'spec.name === "adapter"', forwarding spec.subcommand words like the channel arm directly beneath it, so every 'adapter <name>' label is awaited. Two doc comments that named 'adapter email' as the only one were reworded.
- tests/child-env.test.ts: new case 'declaredCredentialsForClass unions two adapters serving one class' over three fixture Adapter objects (dedup, roster order, an adapter that declares nothing, a class nobody serves), plus the assertion that the shipped lookup still equals the union over builtInAdapters() alone.

Decisions the diff does not show
- declaredCredentialsForClass keeps its single-argument signature deliberately. An optional 'adapters' parameter would have been the shorter route to the two-adapter test, but it is exactly the caller-supplied keep-list APRV-205's comment forbids: that list decides which credential variables survive the child-env scrub. The union was extracted as a separate pure function instead, and nothing outside the test passes it a roster.
- The MCP arm matches spec.name rather than label.startsWith('adapter '). Same set of labels, and it reads the same as the 'channel' arm three lines below it.
- The three tables (CLI verb, setup credentials, credential roster) were left side by side rather than derived from one another. Deriving the CLI table from adapters/registry.ts would make the adapters package depend on CLI help text, or the registry on the CLI; the comment in each table now cross-references the other two.
- tests/cli-adapter.test.ts was NOT touched, per AC #1: byte-identical behaviour has to be provable by the unchanged file.

Verification (2026-09-02)
- AC #1: tests/cli-adapter.test.ts unchanged (git status shows no modification) and green inside the full run. 'node cli.js adapter email --help' and 'node cli.js adapter email' print the same help and the same 'missing <action-key> argument' usage error as before; the success sentence still names 'the email adapter' because name is 'email'.
- AC #2: 'node cli.js adapter carrier-pigeon --json' -> exit 2, {"error":{"code":"usage","message":"unknown adapter \"carrier-pigeon\" for `approval adapter`; known adapters: email"}} — the name list is knownAdapterNames() over the table.
- AC #3: 'node cli.js setup adapter email --help' -> 'approval setup adapter email — the SMTP credentials (HUMAN-ONLY)', exit 0, with the ternary deleted; 'node cli.js setup adapter carrier-pigeon' still answers 'unknown adapter "carrier-pigeon"; known adapters: email' from the pre-resolution path.
- AC #4: drove the MCP server over an in-memory transport (serveApprovalMcp + MCP SDK Client) and called the adapter_email tool with positionals ['some-action-key']: _meta['approval.md/exit_code'] = 2 with the verb's own 'missing --token <t>' usage JSON. A dropped promise (the old literal not matching) would have returned exit 0 and empty content, so this is the awaited arm running.
- AC #5: 'npm test' includes the new union test; registry.ts doc comments rewritten.
- AC #6: npm test -> 'tests 2837 / pass 2836 / fail 0 / skipped 1'; npm run lint (oxlint src tests) -> no output, clean.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Generalized the adapter seam so a second adapter is a table entry: ADAPTER_CLIS in src/cli/adapter.ts drives `approval adapter <name>` (help, adapter construction, success sentence and the unknown-name refusal all come from the entry), AdapterSetupEntry carries its own help so `setup adapter <name>` lost its name === 'email' branch, the MCP async-unwrap arm matches every 'adapter <name>' label, and adapters/registry.ts exposes builtInAdapters() plus a pure unionRequiredCredentials() that declaredCredentialsForClass() delegates to (single-argument still, so no caller-supplied keep-list). Verified with npm test (2837 tests, 0 fail) and oxlint clean, tests/cli-adapter.test.ts untouched, a new two-adapter union test in tests/child-env.test.ts, and live runs of the unknown-adapter refusal, both --help paths and the adapter_email MCP tool over an in-memory transport.
<!-- SECTION:FINAL_SUMMARY:END -->
