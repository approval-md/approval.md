---
id: APRV-510
title: >-
  exec.code: a logged class for opaque agent code (python3 -c, node -e,
  interpreter + file, Hermes execute_code), custody-gated
status: In Progress
assignee: []
created_date: '2026-10-12 05:58'
updated_date: '2026-10-12 06:33'
labels:
  - classifier
  - agent-village
dependencies: []
priority: high
type: feature
ordinal: 389000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Opaque agent code is refused before policy on every harness: python3 -c, node -e, perl -e, ruby -e and deno eval are hook-opaque, bun -e, python3 <file> and bun <file>.ts are hook-unclassified, and Hermes execute_code is hook-hermes-execute-code-unbound (lanes-bountify/APPROVAL-OVERBLOCK.md section 2: 18 python3 -c, 10 execute_code, 3 python3 <file> of 52 refusals). This task adds a class exec.code so a TENANT POLICY can record such code (autonomous, binding the program SHA-256 and length, never its text), hold it (manual) or keep refusing it, while a policy that says nothing keeps today refusals byte for byte. The class opens only on an operator-attested policy key exec.code.custody: attested (credential custody in place); Hermes execute_code additionally needs exec.code.execute_code: hooked, set only on the APRV-509 probe result. 0.4.5 candidate; orchestrated as lane L3-EXEC-CODE of the claude-approval seat (brief agentvillage/private/handover/lanes-approval/briefs/L3-EXEC-CODE-brief.md).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A policy that names neither an exec block nor an exec.code class row refuses every in-scope form exactly as before (same code, same words), including execute_code
- [x] #2 A policy naming exec.code without exec.code.custody: attested refuses the in-scope forms with hook-exec-code-custody-unattested, naming the key
- [x] #3 With custody attested, inline programs (python/python3 -c, node -e/--eval, bun -e/--eval, deno eval, perl -e/-E, ruby -e) and python/python3/bun file runs outside skills/<skill>/scripts classify exec.code and resolve by the exec.code row, an exec.* row, or defaults.autonomy
- [x] #4 A record binds interpreter, mode, code_sha256, code_bytes, argv (program word replaced by a hash marker), workdir and the command SHA-256; the program text never reaches the log or the payload store
- [x] #5 A file program the hook cannot read (absent, EACCES, not a regular file, too large, relative after a cd) is refused hook-exec-code-unreadable; skill scripts stay exec.local
- [x] #6 bash -c, sh -c, eval, pipes into an interpreter, python3 - (stdin), assignment prefixes, substituted or shell-expanded program words, heredocs and redirections other than discard writes keep today refusal; the open window does not reach exec.code; Codex stays closed
- [x] #7 Hermes execute_code is classified exec.code only with custody attested AND exec.code.execute_code: hooked; with custody only it keeps hook-hermes-execute-code-unbound and names the second key; a tools entry cannot claim it; its post event closes the start
- [x] #8 Schema, conformance vectors (new hook-exec-code suite, refusal-unions, schema-validation, command-class), unit tests, docs (hermes-hook.md, claude-code-hook.md, SPEC section 7 and 11.2 amendment, CHANGELOG Unreleased), and the village policy template updated
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Lexer: per-word exact flag and per-segment heredoc flag (additive). 2. command-class.ts: ClassifierContext.execCode, exec-code row before node, execCodeShape allowlist, ExecCodeSource on the segment; closed inside an unwrapped login shell. 3. core/exec-code.ts: policy gate (silent / unattested / window / harness). 4. schema exec block + Policy type + fixtures. 5. hook.ts: two deny codes, classifyForHook execCode, describeToolCall binding via cli/hook-exec-code.ts, execute_code early gate, rule-table claim, window closed, Codex closed. 6. Tests, conformance suite, docs, village template, SPEC amendment called out.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
DONE (lane L3-EXEC-CODE, claude-approval/L3-EXEC-CODE, Opus 5.5 subagent):
- Schema chosen: top-level `exec: { code: { custody: attested|unattested, execute_code: hooked|unhooked } }`, closed schema, absent key = closed. Gate in src/core/exec-code.ts (silent / unattested / window / harness).
- Refusal codes added: hook-exec-code-custody-unattested, hook-exec-code-unreadable (hook_deny_codes, before hook-io).
- Decision for the human: "absent keys keep todays refusals byte for byte" and "with custody absent refuse custody-unattested" conflict in the brief. Resolved as: a policy that never names exec.code (no exec block, no exact exec.code class key) gets todays refusal byte for byte; one that names it without custody gets custody-unattested. An exec.* family row is not a mention.
- No program text in the payload; no short prefix on the card (default no, kept).
- Codex closed (its allow binds native command bytes); open window closed; bash -c / sh -c closed inside the APRV-380 unwrap.
- Security review: round 1 fixed interpreter spelling (bare or /usr/bin,/bin,/usr/local/bin,/opt/homebrew/bin), per-line PATH closure, no trailing words after an inline program, unquoted ~ inexact; refuted cwd differential and row-order (tests). Round 2 fixed stdin-fed programs (pipe, <&); refuted wrapper shapes; documented PATH persistence across Hermes terminal calls and entry-program-only hashing as limits. Round 3 all refuted, pinned as tests.
- SPEC.md amendment (call out to Carter): §5.2 exec block, §7 exec.code paragraph and exec.* row, §11.2 table for the two hook refusals, all "(Amended APRV-510, pending sign-off.)".
- Evidence: npx tsc --noEmit exit 0; npm run lint exit 0; node conformance/run.mjs exit 0 (620+ vectors, now 640); node scripts/run-tests.mjs --only <21 files> exit 0, 1435/1435 (cli-hook-exec-code command-class-exec-code command-class command-class-quoting cli-hook cli-hook-hermes cli-hook-hermes-rules cli-hook-cursor cli-hook-tool-map agent-village-policy probe-hermes-hook human-only conformance conformance-regen fixtures docs-guard cli-help cli-long-help agent-sdk-hook harness-cap-ttl evidence-append).
REMAINING: full suite via the orchestrator suite slot; refuter on the fixed target; Carter: SPEC sign-off, merge (not armed in this lane), release 0.4.5.
Resume point: cd /Users/carter/dev/approval-md-wt/approval-exec-code && gh pr checks <PR> --watch

Correction: node conformance/run.mjs exit 0 with 625/625 vectors (232 controls), not 640. Report: agentvillage/private/handover/lanes-approval/APPROVAL-EXEC-CODE.md.
Rebased over 0.4.4 (main 54fb0dfb, PR #636 APRV-508 in main; lane claude-approval@edge/L3b-REBASE): conflicts resolved toward the stricter side, both answers kept where they were independent (command-class.ts CommandRule `shape` + `execCode`, matchRule params and call; the `>&`/`<&` lexer branch is #636's with `if (op === "<&") stdinFed = true;` kept first; CHANGELOG entry under `## Unreleased` above `## 0.4.4`). Refuter N6: one system-bin list (`SYSTEM_BIN_DIRS`, read by `isSystemBinWord`); an interpreter takes only its `bin` directories, so `/opt/homebrew/bin`, `/sbin` and `/usr/sbin` interpreters keep today's refusal (stricter than either side). `custody-path-moved-earlier-unchanged` and `custody-printf-v-path-closes-the-line` moved hook-opaque -> hook-unclassified (APRV-508 refuses bare `PATH=` and `printf -v PATH` on their own); docs/hermes-hook.md cross-call PATH limit reworded to match. Closed-class differential vs main 54fb0dfb: 0 changed answers.
Fix round after the 1bf17940 recheck (lane claude-approval@edge/L3d-FIX): refuter rS1 fixed, a `>&` whose descriptor prefix is 0 (`0>&3`, `0>& 1`, `9>&1 0>&9`) sets stdinFed like `0<&3` (bash's `n>&m` is `dup2(m, n)`); four vectors (custody-stdin-dup-via-0-lt-amp-unchanged, custody-stdin-dup-via-0-gt-amp-unchanged, custody-stdin-dup-via-0-gt-amp-spaced-unchanged, custody-stdout-dup-records-exec-code) and one unit test. hook-exec-code stays 1.0.0 (never merged; a version is claimed at merge), 48 vectors. Branch squashed to one commit over 54fb0dfb (refuter rN4).
Fix round 2 after the f6ff8f75 recheck (lane claude-approval@edge/L3f-FIX2): M1, a file program path with a `..` component (or a `.` or empty component after the first) or in a directory that is not its own realpath (a symlinked workdir included) is refused hook-exec-code-unreadable, and the directory is realpath-resolved before the basename is joined; M2, file mode opens only when the exec.code segment is the line's sole segment (inline mode unaffected); rS2, exec.code never opens inside a subshell `( … )` (a redirection after the `)` feeds its stdin; `{ …; }` groups were already unclassified); N8, a file program resolves against the harness-stated directory (per-call key, else the envelope's absolute `cwd`) and file mode is refused when there is none. No new refusal code (a new one would need SPEC §11.2). hook-exec-code stays 1.0.0, 69 vectors; the conformance harness gained `symlinks` and `cwd` inputs.
Fix round 3 after the 4f9ac474 recheck (lane claude-approval@edge/L3i-FIX3): S1, a call that carries the adapter's per-call working-directory key (Muse `workdir`) with a value that is not an absolute path gets no file mode (hook-exec-code-unreadable), never the envelope `cwd` fallback, which now applies only when the key is absent; S2, docs/hermes-hook.md, the village template and the hook-exec-code.ts comment no longer claim that co-location refuses file mode (no code does: a file under the resident's 0700 home is refused by EACCES, and a readable file anywhere is accepted and hashed), and the hash-then-exec residual is stated as a writer other than the hooked call (an earlier hooked call's background job, another session, cron), not the program rewriting its own file; N-b, a command with an embedded NUL is refused hook-exec-code-unreadable beside the lone-surrogate check. hook-exec-code stays 1.0.0, 70 vectors (+custody-embedded-nul-refuses-unreadable); two unit tests. SPEC.md untouched.
<!-- SECTION:NOTES:END -->
