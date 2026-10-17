---
id: APRV-89
title: 'README holistic pass: from changelog to front door'
status: Done
assignee:
  - '@fable'
created_date: '2026-08-18 11:17'
updated_date: '2026-08-20 12:52'
labels: []
milestone: m-11
dependencies:
  - APRV-88
priority: medium
type: docs
ordinal: 84000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The README grew ceremony by ceremony across eight milestones and is accurate (docs-guard pins its exit-code table and refusal strings) but has never had a top-to-bottom read as a newcomer would give it. This is that pass, timed for the moment the surface stops moving (after M8), and it pairs with the launch post thread in private/LAUNCH.md. Questions to answer with the rewrite: is the opening still the right pitch (the AGENTS.md-says-ask-first hook); does a quickstart belong before the ceremonies (approval init -> setup -> eval env -> doctor in ten lines); are the four ceremonies the right spine or should the MCP path be a fifth; where do the incident-lineage paragraphs live (they are the best part; keep them, place them); does Running the checks belong at the end; is the verb inventory needed or is ROOT_HELP enough. Constraints: docs-guard stays green; every command shown is copied from the built --help; the incident-grounded voice and the prose rules hold; the four SPEC pointers and the CLAUDE.md pointer survive; nothing claims more than the code does (the M7/M8 demo runs are the evidence for their ceremonies).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 README rewritten top to bottom with a quickstart, the ceremonies as spine (MCP as its own path), incident lineage kept, checks section placed; docs-guard green; every command matches --help
- [x] #2 A newcomer read-through by the human confirms the pitch and ordering; the launch-post thread in private/LAUNCH.md points at the sections it will quote
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, worktree from main (after 106/107/108). 2. Top-to-bottom rewrite: pitch, ten-line quickstart (init, setup, env, doctor), the four ceremonies as spine plus the harness/MCP path as its own section, incident lineage kept (seq 2, token asymmetry, web CSRF), Running the checks and exit codes at the end. 3. Every transcript recaptured from real NO_COLOR=1 runs of the built CLI (refusal glyph shape, token panel, tables, wordmark, --help --long); every command copied from --help. 4. Reflect this session: hook --dir scopes the log, withdrawn on timeout, harness grants mint no token, protected_paths, email payload rendering, audit.skew_tolerance, withdraw verb. 5. docs-guard green (exit table verbatim, seq 2 cited, token asymmetry and CSRF stance, no retired name). 6. AC 2 stays for the human (newcomer read-through; private/LAUNCH.md pointers). 7. PR by branch, auto-merge; records here.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Opus subagent build with fable edits, PR by branch aprv-89-readme-pass (#91). Outline: What this is (AGENTS.md gap as the first paragraph), Quickstart (six commands, real attest and doctor output), four ceremonies as spine (attest incl. protected_paths; amend with the seq 2 incident; deciding from the phone with the bytes-binding, refusal shape, email field rendering, token panel, run, token-consumed, withdraw, log tail piped vs aligned, verify and skew_tolerance; sending mail incl. the partial re-run probe), How an agent harness reaches the gate (CLI, the Claude Code hook with one root / never creates a log / withdraws on timeout with the 2026-08-19 incident / harness grants mint no token / failed launch is an open gate, and the MCP server described as built and scripted-tested, not yet run on a phone), Two things stated plainly kept, Running the checks, Exit codes, Where to look next (verb inventory dropped; --help and --help --long pointers; docs/cli-reference linked). Every transcript recaptured from fresh temp dirs on the current build. FINDING from the quickstart capture: a fresh approval init plus attest fails one doctor check, audit-sampling (secret-env-unnamed), because the SPEC 5.1 canonical policy sets supervised_sample_rate 0.1 and names no sampling_secret_env; the README now shows that line and says why; a cleaner answer (the canonical example naming the variable, or init scaffolding it) is a SPEC 5.1 decision to fold into APRV-103. Also fixed here: ROOT_HELP was missing the withdraw verb (usage and the Ask group), and wait now says 1 rejected/revoked/withdrawn. 582 lines against 443; the extra is requested facts and real transcripts. docs-guard green (exit table verbatim, seq 2 cited, token asymmetry and CSRF stance, no retired name); 1873 tests, lint and typecheck clean. AC 2 remains the human newcomer read and the private/LAUNCH.md pointers.

Merged at 7e2d01e (PR #91). AC 2 (the human newcomer read and the private/LAUNCH.md pointers) stays open; the task stays In Progress for it.

AC 2 newcomer read done by the human (2026-08-20). Three findings, spawning APRV-116 (README v2, m-12): (1) voice should read human-written; agent drafts plainly, human edits later. (2) The why must lead: irreversible or human-attributed actions need a verifiably human-gated path; enforcement, not prose trust; supervised mode samples a percentage. (3) Quickstart and ceremonies should become outcome-based step-by-step guides: install, gate a coding agent, define surfaces, define channels, APPROVAL.md dictionary, comparison with alternatives, and how the gate resists bypass. The read is the AC; the rewrite is new scope and does not hold M8 open.
<!-- SECTION:NOTES:END -->
