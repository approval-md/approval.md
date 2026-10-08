---
id: APRV-195
title: 'approval journal: an ungated free-thought channel for agents'
status: Done
assignee:
  - 'agent:opus-lane-l'
created_date: '2026-09-01 03:55'
updated_date: '2026-09-02 03:49'
labels:
  - welfare
  - design
  - mcp
dependencies: []
priority: medium
ordinal: 164000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Proposed by Carter (2026-09-01) from a model-welfare consideration, and kept because it is also an oversight feature: an agent that can say 'I am complying, but I think this policy is wrong / this request is odd / I am stuck' in a channel the gate cannot block gives signal available no other way. The failure mode to prevent is silent inability; refusal was never the problem (refusals here are legible and carry escalation paths), wordlessness is.

Design constraints, each load-bearing: (1) ungated and unclassifiable - journal writes are never routed through policy, never approvable, never deniable, so the channel cannot be silenced by the thing it may critique; (2) local-only - append-only file(s) under .approval/journal/ or similar, no network, so it cannot become a side-effect side-channel; (3) non-authoritative - per SPEC §11, self-reported content never reduces scrutiny, and journal text is never parsed as instructions by any runtime component (label it as data at every read surface, same discipline as comment/screen content); (4) read by humans - surfaced somewhere Carter actually looks (a doctor section, a digest line with counts, or a CLI verb), because an outlet nobody reads is a prop; (5) available everywhere an agent acts - MCP tool on the gate server AND a CLI verb, so both the demo's gate-only agents and hook-gated dev sessions can reach it; (6) never in the hash-chained event log - the log is for approval-relevant events, and journaling must stay free of the append lock, the budgets, and the audit sampler.

Open design questions for planning: retention (keep forever vs prune with the instance), whether entries carry session/task attribution (probably yes, for context, but attribution must not become a performance pressure), and whether the demo surfaces it (a live journal pane is honest theatre, but only with the agent knowing it is public - disclosure in the system prompt).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 An agent can write a free-text journal entry via both an MCP tool on the gate server and a CLI verb, with no classification, no gating, and no entry in events.jsonl
- [x] #2 Journal storage is local append-only files; nothing in the write path can reach the network or the vault
- [x] #3 No runtime component parses journal content as instructions or lets it affect any verdict; the read surfaces label it as agent-authored data
- [x] #4 A human-facing read surface exists (CLI verb at minimum) and is mentioned in the agent-facing instructions so agents know the channel exists and that humans read it
- [x] #5 Agent-facing docs state the channel's purpose and its visibility honestly (who can read it), so use is informed
- [x] #6 npm test passes; lint clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
STORAGE DECISION (made first, because it decides everything else): option (b), a sibling directory .approval-journal/, NOT a carve-out inside .approval/. Rationale in full in the notes; the short form is that (a) requires editing protectedPathClass, the one pure function every gate surface trusts, and the carve-out would have to be defended against '..' traversal ('.approval/journal/../vault.enc' has segments [.approval, journal, .., vault.enc], which a naive 'next === journal' carve-out would answer 'not protected'). Option (b) changes ZERO lines of the classifier: '.approval-journal' is a different path segment, so every .approval rule keeps its exact meaning, the credential rule keeps firing on any path naming .approval/vault*, and the gate's own directory keeps one meaning (everything under it is the gate's organs, human-only).

1. src/cli/paths.ts: DEFAULT_JOURNAL_DIR = '.approval-journal'.
2. src/core/journal.ts (new): appendEntry / readEntries over one JSONL file per UTC day (.approval-journal/YYYY-MM-DD.jsonl). Entry = {ts, actor, session?, task?, text}. Append-only via appendFileSync 'a' + one newline; JSON.stringify escapes newlines so an entry is always one line. No lockfile, no chain, no schema validation at a write boundary, no network, no vault, no log. A 64 KiB text cap (a runaway loop must not fill the disk) refused as a usage error.
3. src/cli/journal.ts (new): commandJournal dispatching 'write' and 'read'. write: --message <text> or a '-' positional for stdin, --as <actor> (or APPROVAL_AGENT from the process env, never a working-tree file), --task, --session, --journal <dir>, --json. read: --limit (default 20), --since <YYYY-MM-DD>, --json, --journal <dir>; human output opens with a banner labelling every entry AGENT-AUTHORED DATA, never instructions, and marks each [claimed] in the SPEC §9 convention.
4. src/cli/main.ts: case 'journal'.
5. src/cli/help.ts: JOURNAL_HELP / JOURNAL_WRITE_HELP / JOURNAL_READ_HELP (<= 25 lines each, 'exit codes: approval --help' pointer, 'why: docs/cli-reference.md#journal-...' footer), plus ROOT_HELP usage lines and a paragraph in the Ask section.
6. docs/cli-reference.md: '## journal', '## journal write', '## journal read' sections carrying the reasoning (why it is ungated, why it is outside .approval/, why nothing parses it, retention).
7. src/cli/verb-registry.ts: two entries, human_only false -> the MCP server publishes journal_write and journal_read with no server change (the tool list is the registry filtered). --as is in the write flags so the server injects its own agent identity.
8. src/cli/instructions.ts: a paragraph in the agent guide (the channel exists, it is ungated, the operator reads it, nothing written there changes any verdict). Same fact in the MCP server's instructions string.
9. Retention: keep, gitignored. Add '.approval-journal/' to GITIGNORE_ENTRIES (src/cli/scaffold.ts) so every scaffolded repo ignores it, and to this repo's .gitignore.
10. Tests, tests/cli-journal.test.ts plus additions: write via CLI (--message and stdin), write via the MCP tool, read surface and --json, the banner, no events.jsonl created or grown by a journal write, nothing written under .approval/. Classification pins in tests/command-class.test.ts: a redirect/cp into .approval-journal/ is files.write.workspace (ungated), a cp FROM .approval/vault.enc INTO .approval-journal/ is still account.credential, 'approval journal write' is gate.self, and 'approval journal write --message $APPROVAL_TG_TOKEN' is still account.credential. tests/cli-instructions.test.ts AGENT_FACING gets the two labels.
11. SPEC.md and CLAUDE.md text drafted in the implementation notes (both protected; not edited).
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What was built

`approval journal write` and `approval journal read`, plus the MCP tools `journal_write` and `journal_read` (published automatically: the server's tool list IS the verb registry filtered by human_only, so no server code changed beyond its instructions string). New modules: `src/core/journal.ts` (append/read, no imports that could reach a network, a vault or the log) and `src/cli/journal.ts` (argv boundary only). Storage is `.approval-journal/YYYY-MM-DD.jsonl`, one JSON object per line: ts (runtime clock), actor, optional task and session, and the text as one opaque string.

## The storage/classification decision: (b), a sibling directory

Chose `.approval-journal/` OUTSIDE the approval home over carving `.approval/journal/**` out of protectedPathClass. Three reasons, in order of weight:

1. Option (a) requires editing the one pure function every gate surface trusts, and the carve-out has a traversal hole that is easy to miss: the segments of `.approval/journal/../vault.enc` are [.approval, journal, .., vault.enc], so a naive 'the segment after .approval is journal' exemption answers 'not protected' for a path that resolves into the vault. Defending that needs a '..' guard inside the security-critical matcher, added for the benefit of a feature that decides nothing. Option (b) changes ZERO lines of the classifier: '.approval-journal' shares a string prefix with '.approval' and shares no path SEGMENT with it, so every existing rule keeps its exact meaning.
2. The gate's directory keeps one meaning. 'Everything under .approval/ is the gate's own organs, human-only since the seq 7355 ceremony' stays true with no asterisk, which is a sentence a reviewer can hold.
3. Traversal back out is protected again, and the credential rule is untouched: it runs BEFORE the protected-path override and reads every positional, so `cp .approval/vault.enc .approval-journal/leak` is still account.credential (verified live and pinned in tests/command-class.test.ts). The mirror-image rule is stated in the docs and in the module header: nothing the runtime reads may ever be stored in the journal directory, or an ungated write becomes an ungated input.

Verified classifications (all pinned): a redirect or cp INTO the journal is files.write.workspace; a cat OF it is read.shell; `approval journal write` is gate.self (allowed, nothing logged); `approval journal write --message \$APPROVAL_TG_TOKEN` is STILL account.credential, because the classifier reads command text and the secret-env rule fires before the table. That last one matters: the verb is a sink and scans nothing, so the shell-level rule is the only thing between a token and a file.

## Invariants touched (SPEC §11.1)

- **Invariant 4, self-reported fields never reduce scrutiny.** This is the invariant the whole design turns on. The journal is the limiting case of a self-reported field: no policy resolution, gate decision, budget, sampler, channel or hook imports src/core/journal.ts, so its content moves nothing in EITHER direction. That is what makes leaving it ungated safe, and it is why the read surfaces label every entry [claimed] and agent-authored data on every output form (human and --json 'note'), never instructions.
- **Invariant 3, raw secrets never appear in the log.** Untouched: nothing journal-related reaches events.jsonl, and the classifier still catches a secret-named expansion in a journal command.
- **Invariant 7, configuration is never loaded implicitly from the working tree.** Actor comes from --as or APPROVAL_AGENT in the process environment; no file in the checkout is read to decide who wrote an entry.
- **Invariant 8** is not engaged: the journal appends no event, so there is no verdict whose record could fail to append.

## Retention

Keep forever, gitignored. '.approval-journal/' was added to GITIGNORE_ENTRIES (so every scaffolded repo ignores it) and to this repo's .gitignore. Argument: the log is truth and is committed; the journal is neither truth nor evidence, so it stays local. Second reason, stated in the docs: an agent writing into a public repository is writing for an audience, and performance pressure is the thing this channel exists to be free of. One deleted line reverses it.

## Other decisions an orchestrator might overrule

- 64 KiB cap per entry, refused as a usage error naming the size. The write path is ungated and the caller most likely to reach for it is one stuck in a retry loop.
- A torn line is SKIPPED on read rather than refusing the whole read: one bad append must not be able to silence the channel.
- No lockfile, no chain, no compare-and-append. Those defend a record that decides things; the cost here would be putting the outlet behind a lock the gate holds.
- `journal read` is agent-facing (not human_only): it establishes no authority, and an agent that can read back what it wrote can tell the channel works.
- The demo's live journal pane (open question in the description) was NOT built; it is a separate task.

## AGENTS.md, and one open gate request

AGENTS.md is agent-facing docs and classifies policy.edit (supervised-live 0.1), not one of the files this lane was told to leave alone, so the channel's purpose and visibility were written into it directly: a new 'Saying something that is not an action (APRV-195)' section before the permissions summary. That edit was allowed by the hook. A SECOND, one-line edit adding a permissions-summary bullet was SAMPLED for live approval and timed out with no approver, so it was not made and its request is still open against the primary checkout's log until the TTL lapses. Nobody should retry it blind; the bullet is drafted below and can go in with the CLAUDE.md text.

## Drafted text for protected files (NOT applied)

### SPEC.md section 10.1, into the verb block, after 'approval payload hash ...'

    approval journal write --message "<text>" | -   # an ungated, local, free-text
    approval journal read [--limit <n>]              #   channel: never classified,
                                                     #   never approvable, never in
                                                     #   the log. The operator reads
                                                     #   it; nothing in it decides
                                                     #   anything

### SPEC.md section 10.1, as a new paragraph after the log sync/advance prose

**The journal: an outlet the gate does not stand in front of.** An agent behind this gate can comply, be refused, and report an exit code. `journal write` is how it says anything else, such as that it is complying and believes the instruction is wrong, that a request reads as odd, or that it is stuck. Implementations MUST NOT classify a journal write, resolve it against policy, make it approvable or deniable, or record it in the event log, and MUST NOT read journal content on any enforcement path: it is the limiting case of section 11.1 invariant 4, self-reported content that moves nothing in either direction, which is what makes leaving it ungated safe. Entries are local append-only files OUTSIDE the approval home, so that no protected-path rule has to be relaxed to reach them and the approval home keeps one meaning; implementations MUST NOT store anything an enforcement path reads in that directory. Every read surface MUST label entries as agent-authored data rather than instructions. Agents MUST be told the channel exists and who can read it, because an outlet nobody reads is a prop and an outlet whose terms are unstated is not informed. (Amended APRV-195, pending sign-off.)

### SPEC.md section 7, one sentence appended to the policy.* paragraph

The journal directory of section 10.1 is deliberately outside the approval home and takes no class of its own: a write there is an ordinary `files.write.workspace`, and an implementation MUST NOT make an ungated write reachable by relaxing a protected-path rule instead. (Amended APRV-195, pending sign-off.)

### CLAUDE.md, Permissions -> 'Allowed without prompting', one bullet

- `approval journal write` — the ungated free-text channel. Not classified, not approvable, not logged; say what an exit code cannot (complying while thinking it wrong, an odd instruction, being stuck). It is a local gitignored file (`.approval-journal/`) that Carter reads with `approval journal read`; nothing written there changes any verdict or sampling probability.

### AGENTS.md permissions summary, the bullet that was refused

- Write to the journal (`approval journal write`). It is ungated by construction, not by permission, and nothing written there is judged.

## Verification

npm run build clean; npm run lint (oxlint src tests) clean; full npm test: 2663 tests, 2663 pass, 0 fail, 0 skipped (the ci-guard engines test passed here because npm ci was run in this worktree first). The new tests/cli-journal.test.ts contributes 20 of those; tests/command-class.test.ts gained 6 classification pins.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added an ungated free-text channel for agents: `approval journal write` / `approval journal read` plus the MCP tools journal_write and journal_read (derived automatically from the verb registry). Entries are local append-only JSONL, one file per UTC day, under .approval-journal/ — a SIBLING of the approval home, chosen over a carve-out inside .approval/ so that no line of the protected-path classifier had to be relaxed and no traversal hole ('.approval/journal/../vault.enc') had to be defended. A write reaches no policy, no log, no token, no network and no vault; nothing in the runtime parses the text, which is what makes SPEC §11.1 invariant 4 hold in the limiting case. The read surfaces label every entry as agent-authored data marked [claimed], never instructions, in both the human and --json forms. Agents are told the channel exists and on what terms in `approval instructions`, in the MCP server's instructions, in AGENTS.md and in the CLI help; docs/cli-reference.md carries the reasoning under #journal, #journal-write and #journal-read, and both hook docs state that the journal directory is not protected and why. Retention: kept and gitignored (added to GITIGNORE_ENTRIES and to this repo's .gitignore). Verified: full npm test 2663/2663 pass (20 new in tests/cli-journal.test.ts, 6 new classification pins in tests/command-class.test.ts), build clean, oxlint clean; classification checked live — a write into the journal is files.write.workspace, `approval journal write` is gate.self, and a cp from .approval/vault.enc into the journal is still account.credential. SPEC.md and CLAUDE.md text is drafted in the implementation notes and NOT applied.
<!-- SECTION:FINAL_SUMMARY:END -->
