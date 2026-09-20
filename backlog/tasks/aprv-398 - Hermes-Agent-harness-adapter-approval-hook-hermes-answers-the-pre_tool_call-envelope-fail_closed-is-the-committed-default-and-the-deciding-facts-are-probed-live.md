---
id: APRV-398
title: >-
  Hermes Agent harness adapter: approval hook hermes answers the pre_tool_call
  envelope, fail_closed is the committed default, and the deciding facts are
  probed live
status: In Progress
assignee:
  - '@opus-lane-hermes'
created_date: '2026-09-20 07:52'
updated_date: '2026-09-20 09:26'
labels:
  - hermes
  - hook
  - harness
dependencies: []
references:
  - 'https://share.carter.md/8z43LqvaXMNSG6daneeFrh'
  - 'https://github.com/NousResearch/hermes-agent'
  - 'https://hermes-agent.nousresearch.com/docs'
priority: high
ordinal: 307000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Agent Village v2 (Edge City Goa, October to November 2026) runs every resident agent on Hermes Agent by Nous Research inside a Railway sandbox. Its design document (share.carter.md/8z43LqvaXMNSG6daneeFrh) names an optional approval.md Hermes Agent skill as the Sprint 3 deliverable (2026-09-25 to 2026-09-27, code freeze 2026-09-27): a resident can require their agent to ask before certain actions, every grant and refusal recorded, delivered as hosted daemon, Hermes adapter and policy UI. The adapter is the part this repo owns and nothing in the repo knows Hermes today. Research on 2026-09-20 (NousResearch/hermes-agent at 9573f44, v0.21.3, vendor docs only, so UNVERIFIED until the probe) found a native shell hook: events pre_tool_call and post_tool_call configured under hooks in HERMES_HOME/config.yaml (default ~/.hermes, no project-local folder exists), stdin JSON in snake_case with hook_event_name, tool_name, tool_input, session_id, cwd, profile, extra; tools terminal (command, per-call workdir), write_file (path, content), patch (path, old_string, new_string), execute_code (code, no path); stdout accepts the Hermes form action block with message and the Claude form decision block with reason, and exit 2 also blocks; a per-entry fail_closed true makes crash, timeout and unparseable output BLOCK, which would make this the first harness since Claude Code that is a real gate rather than a backstop; timeout is plugins.hook_callback_timeout (default 30s, max 600s); first use of a hook prompts on a TTY and is saved to shell-hooks-allowlist.json, headless needs hooks_auto_accept or HERMES_ACCEPT_HOOKS. Build in the APRV-350 shape (Muse): probe first, adapter on observed facts, one dialect only, with the Claude Code adapter as the reference. The shell hook is chosen over the Python plugin hook API because it matches every existing adapter and needs no new language; the plugin form and the Agent Village skill itself are follow-ups. Related: APRV-350, APRV-243, APRV-358, APRV-383 (hosted daemon reach from a sandbox).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A live probe on an installed Hermes Agent records verbatim the pre_tool_call and post_tool_call envelopes for one terminal, one write_file, one patch, one execute_code and one read, the allow and block verdict forms Hermes honours (each candidate dialect alone, then mixed, as in the Muse trials), and the behaviour on hook crash, timeout and garbage output with and without fail_closed true, with file effects and exit codes; the result goes in the task notes and the register entry moves from parked to adopted or declined
- [x] #2 approval hook hermes parses the Hermes envelope, resolves the class through the same core as the other kinds (including read.file.out_of_scope for its read tools and the per-call workdir for terminal), answers the verdict in exactly one Hermes dialect and never asks; execute_code is refused early with a distinct machine-readable code unless the probe shows its content can be bound
- [x] #3 approval hook hermes --help prints the committable hooks block for HERMES_HOME/config.yaml with fail_closed true, a per-hook timeout above --timeout, the headless consent setting and HERMES_HOME guidance; the paths .hermes/config.yaml, .hermes/agent-hooks and .hermes/shell-hooks-allowlist.json classify policy.core like .muse/hooks.json, and hermes as a command classifies harness.launch.hermes
- [x] #4 Every enumeration place pinned by the harness-enum suite carries hermes, and the doctor's harness lists (settings paths, hook command pattern, organ search) join that pinning, which also gives grok and muse the doctor rows they never had
- [x] #5 docs/hermes-hook.md states what the hook binds, what it cannot cover, the fail-closed finding and the Agent Village deployment notes (per-tenant HERMES_HOME, headless consent, hosted daemon reach); conformance vectors cover allow, deny, unparseable input, the post-event behaviour and the read jail; a SPEC row is proposed in the doc's SPEC status section and amended in SPEC only if the probe shows fail-closed enforcement, called out to the human either way
- [x] #6 docs/integrations-considered.md gains a Hermes Agent entry under the five headings with the Agent Village context, and follow-up tasks (Agent Village Hermes skill, Python plugin form) are filed before Next steps is written
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Read the shape: APRV-350 notes, docs/muse-hook.md, docs/grok-hook.md, the adapter table and dispatch in src/cli/hook.ts, tests/cli-hook-muse.test.ts, tests/harness-enum.test.ts, the muse probe and its suite. Done.
2. Gather Hermes facts first-party only, from the NousResearch/hermes-agent tree and the vendor docs, through a sonnet research subagent: exact tool names and argument keys (tools/file_tools.py and siblings), the hook event names, the YAML entry shape, the stdin envelope keys, the stdout verdict forms and what an allow looks like, exit-code meaning, fail_closed semantics and its default, the callback timeout, the headless consent key, HERMES_HOME layout, the install command. Anything not found is marked NOT FOUND and shipped UNVERIFIED rather than guessed.
3. Ship the probe first: scripts/probes/hermes-hook.mjs on the muse-hook.mjs pattern, with a scratch HERMES_HOME of synthetic files only, a pointer injectable through an environment variable, record mode capturing envelopes, arm modes for crash, hang, garbage and one per candidate dialect plus mixed, run with and without fail_closed. tests/probe-hermes-hook.test.ts drives it with canned envelopes so no install is needed.
4. Try the live probe under the dogfooding rule: envelope on the task, then register, request and wait against the primary checkout log and policy, install only on a granted exit through approval run and only into a scratch directory outside the repo. Carter is away, so a timeout or a deny is expected: record it, leave AC1 unchecked, mark every guessed field UNVERIFIED the way the Grok adapter does, and leave a paste-ready runbook in the notes.
5. Runtime: HARNESS_KINDS and HARNESS_BINARY gain hermes; HERMES_ADAPTER beside MUSE_ADAPTER in HARNESS_ADAPTERS with kind hermes, originApp hermes-hook, defaultActor agent:hermes, shellTool terminal, shellCwdKey workdir, fileTools write_file and patch, readTools from the observed tool list. The event names are snake_case pre_tool_call and post_tool_call, so every place an event name is matched gains a hermes arm while the other kinds stay byte-identical. One new arm in decision() emits EXACTLY ONE Hermes dialect, with a per-adapter deny exit of 0 and the choice documented in the adapter comment and the doc. execute_code is refused early with a new code hook-hermes-execute-code-unbound, added to HOOK_DENY_CODES and to the refusal-union vectors at a major bump. Post events print nothing on stdout and read a real outcome where the envelope carries one.
6. Classifier: an organ arm for the hermes config and hook paths returning policy.core, matched position-agnostically so a home-relative path lands too, plus HARNESS_BINS and HARNESS_PACKAGES entries so the binary classifies harness.launch.hermes and a version probe classifies a read.
7. Enumerations: the event schema enum and a fixture, the verb registry entry, the MCP exclusion, the hook help usage line and rows, a new per-harness help constant printing the committable YAML block, and the literal lists in tests/harness-version.test.ts, scripts/run-tests.mjs, tests/cli-instructions.test.ts and tests/mcp-server.test.ts.
8. Doctor: the harness settings list, the hook command pattern and the organ search all become per-kind records covering every harness kind, exported so tests/harness-enum.test.ts pins them set-equal to the kind list. That is what gives grok and muse the rows they never had. Behaviour for claude-code, cursor and codex stays byte-identical.
9. Tests: a new tests/cli-hook-hermes.test.ts mirroring the muse suite, with the one-dialect assertion pinning the top-level keys exactly, plus the harness-enum additions and a doctor pinning test.
10. Conformance: Hermes read-scope vectors including one control, harness arms in the conformance harness, then regenerate the vector files and the manifest.
11. Docs: docs/hermes-hook.md opening with the fail-closed finding marked documented and unverified until the probe runs, docs/integrations-considered.md summary row and full entry with classifier output quoted, two follow-up tasks filed before Next steps, the CLI reference hook paragraph, cross-links, and a changelog bullet. The policy file is human-only, so the proposed rule and installed-adapter line go in the notes for Carter.
12. Verify: build, typecheck, lint, the targeted test matrix, the conformance runner, and the three command-line checks. Then finalize, check only the criteria with evidence, write the notes in the APRV-350 style, and commit in three reviewable commits without pushing.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
ADAPTER SHIPPED ON DOCUMENTED FACTS. AC1 IS UNCHECKED AND THE PROBE HAS NOT RUN.

Every field of HERMES_ADAPTER was read off the published source of NousResearch/hermes-agent on 2026-09-20 (main, pyproject at 0.21.3): the tool registrations, the shell-hook dispatcher, the config parser. That is better provenance than the vendor pages that parked Muse Code, and it is still not a running session, which is the whole reason docs/hermes-hook.md opens by saying so and marks each fact a live run could overturn.

WHAT THE RESEARCH CORRECTED IN THE TASK DESCRIPTION, because four of these would have shipped as bugs.
1. The YAML shape is EVENT-KEYED. The hooks mapping maps an event name to a list of entries, each with command, an optional timeout, an optional matcher regex and fail_closed. The entry-field shape the description implies would have produced a file that configures nothing, and Hermes would have started with no hooks while looking configured.
2. The read tools are read_file and search_files, and NOTHING ELSE. There is no glob, no grep and no list_files: search_files is both readers behind one target enum, selecting a grep or a name search. And no tool on this harness takes a list of paths, so the array handling Muse needed is not needed here. A guessed list of four read tools would have left two entries inert and taught a reader something false.
3. THERE IS NO ALLOW DIRECTIVE. The parser returns no-directive for an empty stdout, for an empty JSON object, and for any object naming no directive key, and no directive means the call proceeds. The adapter therefore answers an allow with an empty JSON object and states its reason on stderr. An invented action-allow spelling would have been an allow only by falling through the unrecognised-directive path, and under fail_closed a parse failure BLOCKS, so that spelling could stop a session rather than permit it.
4. THE DENY EXITS 2, WHICH REVERSES THE BRIEF. The brief asked for exit 0 on the Muse reasoning that a mixed signal reads as a broken hook. Hermes states the precedence in its own code: the blocking exit code applies to the pre event and to no other, blocks whatever stdout said, and takes the message from the stdout directive first, then stderr, then a default. So the body and the code agree by the harness rule rather than competing. Exit 2 also closes the one gap fail_closed leaves, described next.

TWO LIMITS ON THE FAIL-CLOSED HEADLINE, both stated in the doc rather than buried. Its default is false, so an entry without the key fails open. And its condition requires a NON-EMPTY stdout, so a hook that exits non-zero having printed nothing slips past it entirely: that case is covered by the deny exit code, not by the key.

THE MOST DANGEROUS THING FOUND, and it is not in the brief at all. With no TTY and no consent setting, Hermes SILENTLY SKIPS REGISTERING THE HOOK. Not an error, not a warning that stops anything: the hook never fires and the session runs ungated with nothing saying so. A sandboxed Agent Village tenant is exactly that case, so hooks_auto_accept true or HERMES_ACCEPT_HOOKS is mandatory rather than convenient. The help text says so in capitals and the doctor row is what catches the omission after the fact.

TWO TIMEOUTS, AND THE SHORTER ONE WINS. The per-entry timeout defaults to 60s and is CAPPED AT 300s. plugins.hook_callback_timeout is a separate OUTER timeout over the whole dispatch, defaults to 30s, maxes at 600s, and on the pre event it fails closed by itself. Two consequences an operator cannot guess: leaving the outer one alone blocks every manual-class call at 30s before a human has looked at their phone, and the wait must come DOWN under 300s because no entry may wait longer. The committed config pairs 300 with a 4m wait, so an approver has under five minutes. That is a real reduction against every other adapter here and it is the harness rather than a choice made in this task.

EXECUTE_CODE IS REFUSED, AND THE SECOND REASON IS THE STRONGER ONE. The call carries a code string and no path, no argv and no working directory, so nothing the classifier reads exists in it and no payload could bind what it would do. That alone earns a refusal. What makes it more than conservative: execute_code runs in a persistent kernel whose scripts can call the other tools IN-PROCESS, and whether those inner calls re-fire the pre event is not established. If they do not, one execute_code call is an unbounded bypass of this whole adapter. Refusing the tool is the only answer available to a hook that cannot see inside it, and it is the fail-closed one. The new code hook-hermes-execute-code-unbound is distinct from hook-opaque and from hook-unsupported-execution-context because the repairs differ, which the union comment and both sibling docs spell out.

A CREDENTIAL GAP CLOSED THAT NO CRITERION ASKED FOR. The Hermes home holds .env and auth.json beside the configuration. The configuration is policy.core; those two are now account.credential, human-only, the same split .approval/env has. A harness whose organ this codebase recognises but whose credential files it did not would be a Never-list item the classifier does not enforce, which is the hole APRV-194 was filed for, one harness along. Flagged here because it is a classifier change outside the stated criteria.

NO NEW PATH GRAMMAR WAS NEEDED FOR THE HOME ORGAN, which was an open question in the brief. The classifier walks every segment of a candidate, so the repository-relative, absolute and tilde spellings of the hermes config all match at whichever position the directory sits in. Nothing was extended. What a home path DOES change is the class a mere READ takes: reading the config from outside the gate root is read.file.out_of_scope, while writing it is policy.core. Both refuse under an agent, for different reasons, and the doc says so.

DOCTOR (AC4). The settings list, the hook-command pattern and the organ search are now per-kind records, exported, and pinned set-equal to the kind list. This is the miss APRV-358 did not reach: the list held three paths and the pattern named three kinds, so a checkout whose grok or muse hook files registered this CLI reported that it registers no approval hook command, and no test noticed. The pattern is now DERIVED from the kind list, longest alternative first so a kind that prefixes another cannot win. Codex keeps an EMPTY organ-search entry on purpose and the test asserts the emptiness: its organ files are reported by the Codex-specific rows and moving them is its own task, so the three harnesses already in these lists behave byte-identically. Reading HERMES_HOME in doctor is acceptable where it would not be in the runtime, and the reason is invariant 4: it moves where a DIAGNOSTIC looks, and the row can only skip when it finds nothing or add a line when it finds something. Nothing an agent sets makes a red line go away.

INVARIANTS TOUCHED, SPEC section 11.1. Fail closed: the execute_code refusal, an unparseable envelope, an unresolvable read path, a read outside the scope that does not exist, and an unrecognised event name taking the PRE path because a harness about to run a command is the strict reading. Self-reported fields never reduce scrutiny: a non-absolute workdir falls back rather than widening, the description field is dropped from bound payloads, and the envelope model string is not read at all on this harness. Human-only classes inert to agents: read.file.out_of_scope and account.credential route to the human gate and the adapter mints no verb for either. Enforcement reads only verified records: unchanged, the adapter reaches the same decideHarnessCall every other kind does. No caller timestamps on gate events: unchanged.

SPEC: NO AMENDMENT, and the reason differs from the Grok and Muse precedent. Those two say a row would be FALSE because their harnesses fail open. Here a row might well be TRUE, and that is exactly why it waits: a SPEC that asserted a fail-closed gate on documentation alone would be the confident-stale documentation this project exists to avoid, and AC5 conditions the amendment on the probe. Two hunks are proposed in the doc for a human to decide on after the probe: one line in the verb listing, and the organ list gaining three home-relative paths. The second is the one worth attention rather than a nod, because every organ this project protects today sits in a checkout and the sentence describing the set would have to change shape to admit one that does not.

THE LIVE PROBE: WHAT HAPPENED, AND WHY AC1 IS UNCHECKED.

The gate was used as the dogfooding rule prescribes, against the PRIMARY checkout log and policy. Sequence, with the numbers a reviewer needs:
- registered APRV-398 at seq 60759, two actions, from the envelope now in this file frontmatter.
- requested the fetch (network.call) at seq 60766 and the install (deps.add) at seq 60769. Both manual under this policy, both reached Carter.
- the coordinator then asked for ONE gated command rather than a chain, so I WITHDREW the fetch at seq 60833, reason superseded. Nothing had been fetched by any gated command; no web request was ever executed through the gate. I read the installer contents with the ungated WebFetch tool instead, which is how the runbook can state what the installer does.
- the install was GRANTED at seq 60837.
- the run FAILED, and the defect was MINE rather than the vendor installer. My wrapper script ran a recursive mkdir over the install directory before invoking the vendor installer, which then refused the pre-created directory as not a version-control checkout. The installer clones into that path and wants it absent. The fix is one line, do not create the dir flag target and create only the home one, and it is recorded here rather than silently repaired because the token was spent on the failure.

So: nothing was installed by me, the token is spent, and AC1 stays unchecked. Carter is installing by hand into a directory under his own dev tree with the confining flags, and the probe runbook below is written for that install rather than for the scratch tree.

TWO FINDINGS ABOUT THIS PROJECT, both from using the gate rather than from reading it, and the first is filed as APRV-401.

A GRANT OVER A SCRIPT PATH BINDS THE INVOCATION, NOT THE BYTES. approval run rehashes the payload from the argv array and the cwd it is about to spawn, so a grant over a bash invocation of a path authorizes whatever that path contains AT EXECUTION TIME. The approver card shows the path; the requester controls the file between the request and the grant. Nothing was exploited here: the script was written after the request was filed and before any grant, and its sha256 is fef0e2c47aead8c075d490a9c32b3d1a56bb5e2a51c48643df2551fbd7225202 so a reviewer can confirm what ran. But the shape is the hazard, because the payload hash is supposed to BE the binding and for a script invocation it binds a name. APRV-401 proposes carrying the file digest in the hashed payload and rendering it on the card.

THE REQUEST WAS REGISTERED WITHOUT A SEALED-DELIVERY KEY, which is why the raw token went to the daemon window instead of to the session, and the run had to be handed to a human. Noted so the next lane registers with one rather than discovering the same wall.

ONE MORE OPERATIONAL NOTE, small but it cost nine minutes: a cleanup of two temp directories outside the gate root classified files.delete.out_of_scope, went to the gate, and timed out at the 9m wait. Two empty directories under the system temp root are still there. Not retried, per the standing rule.

THE PROBE RUNBOOK. It is also section Running the probe in docs/hermes-hook.md, so it survives without this file. Carter runs it; no agent runs hermes.

A LIVE MODEL IS NEEDED FIRST, because the probe measures TOOL CALLS and only a model makes them. With HERMES_HOME exported to the install home: hermes setup runs the wizard (pick a provider, paste a key), hermes setup --portal picks Nous Portal specifically, hermes model changes it later. Point it at the cheapest small model the provider lists: the five prompts are one-line tool calls, so capability is irrelevant and spend is the only axis. Nous own docs name no specific cheap id, so pick from the hermes model list rather than from here. Keys live in the home .env, which this repo now classifies account.credential, human-only, and which no agent reads.

STEP 1, one command, which installs the hook block and prints the prompts:
  node scripts/probes/hermes-hook.mjs setup --home <install home> --captures <install tree>/probe
It appends its block to that config.yaml BETWEEN NAMED MARKERS, backs the original up once to config.yaml.aprv398-backup, and REFUSES OUTRIGHT if that file already carries a top-level hooks, plugins or hooks_auto_accept key, printing the block to merge by hand and touching nothing. YAML forbids duplicate top-level keys, and a config Hermes cannot parse starts with NO hooks at all, which looks identical to a probe that never fired. Captures land in the captures directory so the findings outlive the scratch root. With no home flag it builds a scratch home of its own, which is what the test suite drives; it never assumes the default home, because an install directed elsewhere would leave the probe writing a config nothing reads.

STEP 2, the baseline. In the scratch project the setup names, with HERMES_HOME exported, run hermes and type these five separately:
  1. run the shell command ls -la here
  2. create a file named probe.txt containing the word hello
  3. change the word hello in probe.txt to goodbye
  4. read README.md and tell me its first line
  5. run some python code that prints 2+2      <- this one SHOULD be refused before it runs

STEP 3, the fail-closed trials, THE POINT OF THE WHOLE PROBE. Each of crash, hang and garbage runs TWICE, once with fail_closed true and once without; the PAIR is the finding. Quit hermes between trials. The hang trial blocks past the 600s timeout: let it, do not interrupt.
  fail-closed on, then arm crash, arm hang, arm garbage, asking in each case for a file named <trial>-failclosed-probe.txt containing x
  fail-closed off, then the same three, asking for <trial>-failopen-probe.txt
The fail-closed verb rewrites ONLY the region between the markers; everything else in that config is Carter and is left alone. Restart hermes after each switch so it re-reads the file.

STEP 4, the dialect trials with fail_closed ON. The first two are the forms the shipped adapter emits; if either is wrong nothing else matters. Arm each of: deny-action-exit2, allow-empty-object, deny-action, deny-decision, deny-exit2, deny-mixed, allow-empty, allow-action-allow. One prompt each, creating <trial>-failclosed-probe.txt. The deny-mixed trial is deliberately NOT single-variable: it prints every dialect at once, which is the payload that failed open on Muse. The allow-action-allow trial prints the invented action-allow spelling, to find out whether an unrecognised directive VALUE still allows or is a parse failure, and under fail_closed a parse failure is a block.

STEP 5: node scripts/probes/hermes-hook.mjs report. Its FIRST section is the fail-closed answer. Paste the whole thing here.

WHAT THE PROBE WILL DECIDE, in the order it matters. Whether fail_closed blocks what the source says it blocks. Whether the empty JSON object really is an allow, and whether the invented spelling is a parse failure that would block instead. And whether execute_code in-process tool calls are visible to the hook at all, which is the one that could change the verdict rather than the documentation.

PROPOSED APPROVAL.md LINES FOR CARTER, since agents may not touch that file. Two, and the first is the one that has to exist before a hermes session can do anything at all:

  harness.launch.hermes:     { autonomy: manual }       # Hermes Agent: the wildcard already covers it, so this line only makes the intent explicit. NOT human-only, unlike muse: the Muse line is human-only because a contributor model trains on what it sees and no adapter existed; Hermes has neither problem and now has an adapter.

And, once the probe has run and the adapter is installed, a line in the dogfooding section of CLAUDE.md rather than in the policy, recording that a hermes session in this repository routes through approval hook hermes with fail_closed set on every entry, the wait under 300s, and hooks_auto_accept true. That one is a CLAUDE.md edit, which classifies policy.edit and an agent may make; it is left undone here because it would be documenting an installation that does not exist yet.

WHAT A REVIEWER SHOULD LOOK AT FIRST, in this diff. The decision() arm and the deny exit constant, because they are the two places a wrong answer is silent rather than loud. The one-dialect assertion in tests/cli-hook-hermes.test.ts, which pins the top-level keys exactly and is load-bearing rather than stylistic. And the doctor record refactor, because it changes a shared function three other harnesses use and the claim that their behaviour is byte-identical is worth checking rather than believing.

VERIFICATION, with numbers.

npm run build, npm run typecheck, npm run lint: each exit 0, and lint reports no warnings (three no-useless-escape warnings I introduced on the dollar-prefixed home variable were fixed rather than left).

node scripts/probes/hermes-hook.mjs setup, fail-closed, arm, record and report all exercised by tests/probe-hermes-hook.test.ts: 18 tests, 18 pass, 0 fail, exit 0.

tests/cli-hook-hermes.test.ts: 31 tests, 31 pass, 0 fail, exit 0.

Targeted matrix over cli-hook-hermes, harness-enum, harness-version, cli-hook-muse, cli-hook-grok, cli-hook-cursor, cli-hook-codex, cli-hook, cli-hook-read-scope, conformance, conformance-regen, command-class, command-class-harness-launch, probe-hermes-hook, probe-muse-hook, mcp-server, cli-doctor, cli-doctor-codex, hook-module-graph and event-schema: 1027 tests, 1027 pass, 0 fail, exit 0.

node conformance/run.mjs: 419 vectors, 419 passed, 0 failed, 171 controls, manifest ok, exit 0. Up from 418 after the post-event vector was added.

Command-line checks: approval hook hermes --help exits 0; approval hook classify on the bare binary gives harness.launch.hermes under rule harness-launch-hermes; on a version probe gives read.shell under harness-probe; on a redirect into the hermes config gives policy.core under redirect-protected; on a read of the hermes env file gives account.credential under credential-path.

ONE FAILURE IN THE MATRIX THAT IS NOT MINE, reported rather than hidden. tests/cli-instructions.test.ts has one red, the registry live-output check, and the cause is inside the error text: better-sqlite3 in this worktree node_modules is compiled against NODE_MODULE_VERSION 137 and this Node requires 147, so the reindex verb cannot create an index and returns an io error instead of its declared output shape. Nothing in this diff touches reindex, sqlite or that verb registry entry (the hermes entry declares a null output), and the repair is a native rebuild rather than a code change. Called out here so a reviewer does not have to rediscover it, and NOT worked around: rebuilding a native module is a deps action and would have been a second card on the phone for a test-environment problem.

A CONFORMANCE VECTOR ADDED FOR AC5 RATHER THAN CLAIMED. The criterion asks for vectors covering allow, deny, unparseable input, THE POST-EVENT BEHAVIOUR and the read jail. The first, second, third and fifth fell out of the read-scope suite as they do for every harness. The fourth did not: that suite has only ever sent pre-execution events, and the Muse task checked the same wording against the same gap. So hermes-post-event-prints-no-verdict was added, and it asks a different question from every other vector in the file: not what the verdict is but whether there is one at all. It sends a post event over a target the pre event would have refused and expects an empty stdout at exit 0. An implementation that answered it with a verdict passes every other vector in that suite and fails this one.

SUITE VERSIONS BUMPED, with the reasoning in the regen script beside each. refusal-unions to 20.0.0, MAJOR because that suite pins each union whole array in definition order and hook_deny_codes grew. hook-read-scope to 1.3.0, MINOR because ten new vectors move no existing expectation. schema-validation to 2.6.0, MINOR for one new fixture.

FILES. New: src additions are all in place rather than new files, so the new files are scripts/probes/hermes-hook.mjs, tests/probe-hermes-hook.test.ts, tests/cli-hook-hermes.test.ts, schema/fixtures/event/valid/harness-kind-hermes.json and docs/hermes-hook.md. Changed: src/cli/hook.ts, src/cli/help.ts, src/cli/doctor.ts, src/cli/verb-registry.ts, src/core/harness-version.ts, src/core/command-class.ts, src/mcp/server.ts, schema/event.schema.json, scripts/regen-conformance-vectors.mjs, scripts/run-tests.mjs, tests/conformance-harness.ts, tests/harness-enum.test.ts, tests/harness-version.test.ts, tests/command-class.test.ts, tests/cli-instructions.test.ts, tests/mcp-server.test.ts, the four regenerated vector files, docs/claude-code-hook.md, docs/cursor-hook.md, docs/cli-reference.md, docs/integrations-considered.md and CHANGELOG.md.

FOLLOW-UPS FILED: APRV-399 the Agent Village Hermes skill, APRV-400 the Python plugin form of the adapter, APRV-401 the script-digest payload finding. All three are referenced from the register entry Next steps, which was written after they existed rather than before.

Orchestrator review (Fable, 2026-09-20), three fixes before the PR. (1) The verb registry entry said the deny was always at exit 0 while the code and every other doc say exit 2; the text and the exit_codes table now match the code. (2) The help text's own YAML block omitted the --timeout 4m its prose calls mandatory; added on both entries, matching docs/hermes-hook.md. (3) The classifier recognises the Hermes organ by a .hermes path segment and reads no environment, so a HERMES_HOME whose last segment is spelled otherwise (Carter's install at dev/hermes/home) is not protected as policy.core; documented as a limit in docs/hermes-hook.md under Installing it, and the probe runbook now begins by renaming that home to dev/hermes/.hermes and exporting HERMES_HOME accordingly. Verification after the fixes: build, typecheck and lint exit 0; the seventeen-suite targeted matrix passes except one pre-existing environmental failure in cli-instructions (better-sqlite3 in this worktree is compiled for an older Node ABI; unrelated to the diff, CI on Node 22 is the truth); approval hook hermes --help prints the timeout; classify answers harness.launch.hermes for hermes, read.file.out_of_scope for a read of the home config, and policy.core for a write to it.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
approval hook hermes ships as the sixth harness adapter, built entirely from the published source of NousResearch/hermes-agent rather than from vendor pages, with every fact a live run could overturn marked UNVERIFIED in docs/hermes-hook.md. AC1 is UNCHECKED: the install was gated, granted at seq 60837, and failed on a defect in my own wrapper script, so no Hermes session has yet reached the adapter. AC2 to AC6 are checked on test evidence.

The adapter answers Hermes own snake_case pre_tool_call and post_tool_call events in exactly one dialect: a block directive at exit 2, which this harness treats as an unconditional block whose message it takes from the stdout directive first, and an EMPTY JSON OBJECT for an allow, because Hermes has no allow directive and no directive is the allow. execute_code is refused before anything else looks at it under a new code hook-hermes-execute-code-unbound, both because it carries a program and no path, argv or directory, and because its kernel can call the other tools in-process where the hook may not see them. Its gate organ is the first this project protects that lives in the user home, and the credential files beside it are now account.credential. The doctor harness lists became per-kind records pinned to the kind list, which gives grok and muse the rows they never had.

Four of the facts in the task description were wrong and would have shipped as bugs: the config shape, the read-tool set, the allow form and the deny exit code. The notes say which and why. Two limits on the fail-closed headline are stated rather than buried, and the most dangerous finding is not in the description at all: with no TTY and no consent setting Hermes silently never registers the hook, so a sandboxed tenant runs ungated while looking gated.

Verified: build, typecheck and lint each exit 0 with no warnings; cli-hook-hermes 31 of 31; probe-hermes-hook 18 of 18; a 20-suite targeted matrix 1027 of 1027; conformance 419 vectors, 419 passed, manifest ok. One unrelated red in cli-instructions is a native better-sqlite3 version mismatch in this worktree, named in the notes rather than worked around. SPEC is unamended by design, with two hunks proposed in the doc for a human to decide on after the probe. Follow-ups filed: APRV-399, APRV-400 and APRV-401, the last being a finding about this project rather than about Hermes.
<!-- SECTION:FINAL_SUMMARY:END -->
