---
id: APRV-502
title: >-
  Classify interpreter runs of skill scripts (bun/node/python3
  skills/<skill>/scripts/*) as exec.local so Hermes residents' first-message
  gates run under enforcement (0.4.3)
status: In Progress
assignee: []
created_date: '2026-10-07 00:32'
updated_date: '2026-10-07 01:20'
labels:
  - agent-village
dependencies: []
priority: high
ordinal: 386000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Agent Village, 2026-10-06 23:42Z, first hello after APPROVALD_ENFORCE=1 on six boxes running approval-md 0.4.2: the agent ran the two first-message gates AGENTS.md prescribes, `bun skills/agent-profile/scripts/profile.ts` and `bun skills/index-network/scripts/welcome.ts`, through Hermes `terminal` with an absolute `workdir` (the Hermes home), and the hook shim log shows outcome=block code=hook-unclassified five times. `approval hook classify -- bun skills/index-network/scripts/welcome.ts` answers unclassified ("no rule for bun ..."); the same for `python3 skills/agent-commons/scripts/search_forum.py --q x`. The command table (src/core/command-class.ts, COMMAND_RULES) knows `bun` only through the npm-shaped rows and knows no `python3` at all, and unclassified is a deny by design. A policy has no knob for shell commands (tools:, protected_paths and read_scope only), and workspace/AGENTS.md routes every skill script through `terminal`, so under enforcement every bun/python3 skill script is denied fleet-wide: the name gate, the welcome, edge-india refs.ts, agent-commons search_forum.py, the token audit, the selfie script. Residents get the fallback welcome and the default name "Edge". Unaffected: curl recipes (network.call), MCP/plugin tools, cron jobs (Hermes runs them without pre_tool_call).

Fix, code only, no SPEC class change, no attest: classify an interpreter run of a skill script as `exec.local` (SPEC §7 line 303: "tests, lint, build, scripts inside the workspace", autonomous). An interpreter is `bun`, `node`, `python3`, `python` (and `deno run` if it fits the same narrow shape), optionally preceded by flags from a small allowlist of inert flags (`bun --bun`, `python3 -I`), whose first positional is a script path of exactly the shape `skills/<skill>/scripts/<file>` (relative, `./` prefix allowed after normalization) or an absolute path whose segments carry the Hermes-home grammar the protected-path tier already uses (`.hermes`, optionally `profiles/<p>`, then `skills/<skill>/scripts/<file>`). Inline code (`-c`, `-e`, `--eval`, `-p`, `--print`, `-m`, `-`, stdin) is never this rule; any flag outside the allowlist, a `--flag=value`, a path with `..`, `.`, empty segments, glob or variable characters, a substituted word, or a path outside the two roots keeps today's answer (unclassified or opaque). Every protected-path tier stays ahead of it: a script under `$HERMES_HOME/scripts/` stays `cron.manage`; anything under `.approval`, `agent-hooks`, `config.yaml`, `.env` stays `policy.core`. The hook (src/cli/hook.ts, the classifyForHook chain) adds a disk pass that can only TIGHTEN: resolve the script against the per-call cwd (Hermes `workdir`; the hook's own cwd elsewhere), realpath it, and require the real file to sit under the real `<root>/skills/<skill>/scripts/` directory it was spelled in; a symlink escape, a missing file, an unreadable path, or a real path that lands on a protected or credential path refuses (unclassified) or takes the stricter class. The rule id joins CODE_EXECUTING_RULES. `approval hook classify` prints exec.local for the two gate commands when run from a Hermes home. The daemon process under `approval serve` carries no HERMES_HOME, so nothing here may depend on that variable.

Release: 0.4.3 (CHANGELOG section, version strings in the files APRV-501's d784cb4a touched, docs/releases/0.4.3.md). Carter tags, publishes, moves the control-plane pins and runs the fleet update round. Spec and evidence: agentvillage private/handover/2026-10-06-claude-main-to-next-account.md section 2 (not in this repo).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Pure classifier: bun skills/agent-profile/scripts/profile.ts, bun skills/index-network/scripts/welcome.ts, python3 skills/agent-commons/scripts/search_forum.py --q x, node skills/x/scripts/f.ts, bun --bun ... and python3 -I ... classify exec.local with the script path bound; fixture-tested
- [x] #2 Negative cases stay refused or stricter: bun /path/to/evil.ts, bun evil.ts, bun skills/x/scripts/../../.approval/x, python3 -c ..., bun -e ..., python3 -m x, python3 - , an unknown or value-taking flag before the script (bun --cwd /etc ...), a substituted or variable word, a glob, a script under .hermes/scripts (cron.manage), any path under .approval / agent-hooks / .env / config.yaml (policy.core), an unexpanded $HERMES_HOME spelling, an absolute path outside the .hermes grammar
- [x] #3 Hook disk pass in the classifyForHook chain only tightens, like resolvedPathClasses: where the hook CAN read the disk, the realpath of the script must sit under the real skills/<skill>/scripts directory it was spelled in (resolved from the per-call cwd) or the segment refuses, and a real path landing on a protected or credential path takes that class; where it cannot read (EACCES: under co-location the daemon user cannot read the Hermes home, verified 2026-10-07) or the file is absent, the text answer stands and a note says so. Tested through the compiled hook hermes path with workdir: allow, symlink-escape deny, protected-landing deny, unreadable-home allow
- [x] #4 approval hook classify -- bun skills/index-network/scripts/welcome.ts prints exec.local with the rule named; the rule ids are in CODE_EXECUTING_RULES; docs/hermes-hook.md and docs/claude-code-hook.md name the rule and the disk pass's limits
- [x] #5 Release 0.4.3 prepared as the last commit of the same PR: CHANGELOG 0.4.3 section dated from the GitHub Date header with a fresh empty Unreleased above it, version strings in the nine files d784cb4a touched, docs/releases/0.4.3.md, release-notes test lists; node scripts/release-notes.mjs 0.4.3 --check exit 0; targeted tests + tsc + lint green; CI green on the PR
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Done (lane A502, claude-bountify/A502), four commits on lane/aprv-502-skill-scripts:
d4d18c09 classifier + fixtures; 8dce4e0f hook disk pass + tests; c5ca77bc docs; 632d3653 task file; 8f0a891d release 0.4.3 (last code commit).

What was built
- src/core/command-class.ts: new row `skill-script` (bun, python, python3) after every existing bun row, matched through a new `skillScript` row flag (same device as `probe`), so an argv outside the shape does not match the row and keeps today's answer (unclassified/opaque) rather than being refined into a different refusal. `node` gets `node-skill-script` inside refineNode, after the -e/-p refusal and the gate-entrypoint branch. Both emit `exec.local` and bind the script as `path`; both are in CODE_EXECUTING_RULES. Path shape: relative `skills/<skill>/scripts/<file>` (leading `./` stripped), or absolute ending `.hermes[/profiles/<p>]/skills/<skill>/scripts/<file>`; every segment non-empty, not `.`/`..`, not `-`-leading, no `* ? [ ] { } $ backtick ~ \`. Flag allowlist: bun `--bun --smol`; node `--no-warnings --enable-source-maps --experimental-strip-types`; python `-[IuBEsSOq]+`. Anything else (incl. `--flag=value`, lone `-`, `--`) = no match. `substituted` is now computed before matchRule and passed in, so a substituted word means no match.
- src/cli/hook.ts: `refineSkillScripts` is the fifth pass in classifyForHook. Resolves the bound script from cwd (Hermes workdir; hook cwd elsewhere) and from every literal `cd`/`pushd` target before it. Readable disk: real path on a credential path -> account.credential, on a protected path -> that class (rule id kept so the sandbox requirement still sees code execution); real path not under realpath(spelled root) -> whole classification fails `unclassified` ("skill script escapes its directory"); ELOOP or an unexpected errno -> same refusal. Dangling symlink -> judged by its target via canonicalPath (nearest existing ancestor). EACCES/EPERM, ENOENT/ENOTDIR (no link) -> text stands, note `skill-script-unverified`. An earlier `cd` the text cannot name (`cd $X`, `cd ~`, bare `cd`, `cd -`, `popd`) -> text stands with a note.
- Docs: docs/claude-code-hook.md and docs/cursor-hook.md (row + footnote; the docs tests require every rule id and class there), docs/hermes-hook.md (tool table row, new paragraph before "What stays unclassified").
- Release: nine version files as d784cb4a, CHANGELOG `## 0.4.3 — 2026-10-07` (Date header Wed, 07 Oct 2026 00:58:43 GMT), docs/releases/0.4.3.md. SPEC.md untouched.

Decisions the diff alone does not show
- AC #3 governs over the description's sentence "a missing file, an unreadable path ... refuses": the description and AC disagree; AC (and the brief) say the text answer stands on EACCES/ENOENT, because under co-location the daemon cannot read the 0700 Hermes home and refusing there re-creates the outage. Comment in judgeSkillScript and docs say so.
- Protected landing takes the landing's class (AC #3) rather than the refusal: it is exactly the class the same command gets when it spells the real path, so it can never be looser than the direct spelling. Credential is checked before protected because a direct `python3 <home>/.env` is account.credential by text.
- Deno left out: overlay skill scripts use bun/python3, and `deno run` real scripts need permission flags whose allowlisting is its own decision.
- `~/.hermes/skills/...` and `$HERMES_HOME/skills/...` do not match (AC #2); agents use relative paths with workdir.
- Pre-existing behaviour kept, now visible: `python3 <script> -c x` and `node <script> -e x` stay opaque because the inline-source checks scan every word; `python3 -Ic x` stays unclassified (the opaque table reads only bare `-c`). Both deny.
- `node skills/x/scripts/f.ts` moved from files.write.workspace (node-script) to exec.local. In a policy that holds exec.local stricter than files.write.workspace this tightens; looser only if a policy makes exec.local looser, which is the operator's stated choice.
- exec.local is new to CLASSIFIER_CLASSES. A policy with no exec.local line resolves it by defaults.autonomy: if the village template's defaults are manual, the gates go to the phone until the template has `exec.local: autonomous` (a human policy edit + attest, not in this PR).
- No conformance vectors added and no suite version bumped (conformance/run.mjs passes unchanged: 553/553).
- Global invariants touched: §11.1 invariant 4 (the per-call workdir is self-reported; it is used only to tighten) and "fail closed" (text rule is an exact allowlisted shape; disk pass tightens only). No refusal code added (reuses `unclassified`).

Evidence (exit codes read directly)
- `npm run build` exit 0.
- `node scripts/run-tests.mjs --only command-class command-class-harness-launch command-class-quoting command-class-ref-delete command-class-routing cli-hook cli-hook-cursor cli-hook-hermes cli-hook-hermes-rules cli-hook-scratch cli-hook-read-scope cli-hook-write-scope cli-hook-rewrite dogfood docs-guard release-notes version harness-version site-version-guard` exit 0, 1153 tests, 1153 pass, 0 fail, 0 skipped.
- `npm run lint` exit 0, no warnings.
- `node scripts/release-notes.mjs --check` exit 0 (lists 0.4.3 2026-10-07 first); `node scripts/release-notes.mjs 0.4.3` exit 0. (The brief's `0.4.3 --check` form is refused by the script: "--check takes no version", exit 2.)
- `node conformance/run.mjs` exit 0, 553 vectors, 553 passed.
- `npm pack --dry-run` exit 0, approval-md-0.4.3.tgz, 936 files, 3.4 MB.

Remaining (human-only, not this lane)
- Carter: tag v0.4.3, publish, move control-plane pins (APPROVAL_MD_VERSION=0.4.3 + APPROVAL_MD_INTEGRITY), fleet update round.
- Check the village resident policy resolves exec.local autonomous (own line or defaults) before relying on the fix.

- CI on PR #629 at head 8f0a891d: gh pr checks 629 exit 0; full gate node 22 shards 1/3, 2/3, 3/3 pass, classify tier pass, protected paths pass, ci pass (docs guard, node 20 floor and records tier skipped by the workflow's tiering). Not merged: the orchestrator merges after a refuter.
<!-- SECTION:NOTES:END -->
