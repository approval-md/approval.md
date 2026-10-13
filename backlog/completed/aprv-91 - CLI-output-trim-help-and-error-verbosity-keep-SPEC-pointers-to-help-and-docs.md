---
id: APRV-91
title: >-
  CLI output: readability and design pass (colour, wordmark, help split, refusal
  shape); SPEC pointers to help/docs
status: Done
assignee:
  - '@fable'
created_date: '2026-08-18 12:04'
updated_date: '2026-08-19 12:34'
labels:
  - cli
  - ux
  - design
dependencies:
  - APRV-90
ordinal: 82000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observed running examples/email-demo.md (2026-08-18). Interactive output cites SPEC.md sections inline (`This is config-declared identity (SPEC.md §11)`) and every usage error appends the full per-verb help, which itself restates its rationale (the trust-boundary paragraph appears twice on one screen for setup identity) and repeats the frozen exit-code table. To a first-time operator without SPEC.md open the section pointers read as internal jargon, and the one line they needed is buried. Direction: keep the "why" prose and SPEC pointers in --help and docs/, not in prompt and error lines; per-verb help is usage plus one or two lines of intent, with the exit-code table only in `approval --help`; usage errors print the error and a one-line `see approval <verb> --help` unless the error is genuinely about argument shape. Do a pass over src/cli/*HELP* constants and the usageError paths, not only setup. Coordinate with the sibling task on setup prompt reprompting so the two do not fight over the same lines.

## Design brief (added 2026-08-18 after the real email-demo run)

The operator's verdict on the current output was blunt: unreadable. This section is the design direction, written to be handed to an implementer as-is. Where it says "must", it is an acceptance criterion; where it says "prefer", it is a default to depart from only with a stated reason.

### Where we are

- Zero colour anywhere: no ANSI in `src/`, no colour dependency, no TTY detection on stdout. Every verb prints undifferentiated grey paragraphs.
- 59 help constants, 3,282 lines, in `src/cli/help.ts`. Per-verb help restates rationale (often twice), cites SPEC sections inline, and repeats the exit-code table on every verb.
- Only `doctor` uses glyphs (`✓`, `✗`, `–`), and even there each line is a 200-character sentence, so the glyph column is the only scannable thing on the screen.
- Interactive prompts print a 6–10 line preamble before the first question, and a wrong answer prints the whole help page.

### Principles

1. **Two audiences, two densities.** A first-time human at a terminal wants the next thing to type and one line of why. The design rationale (SPEC sections, invariants, "why this is not a hole") is genuinely valuable and belongs in `--help --long`, in `docs/`, and in code comments. Default output is the short form; the long form is one flag away and says so.
2. **Scan first, read second.** Every screen must be legible in one glance from shape alone: a coloured status column, a bold key, aligned values. Colour is redundant with a glyph or a word, never the only carrier of meaning (colour-blind safe, and it degrades to plain text losslessly).
3. **Quiet by default, loud when it matters.** Success is one dim line. A refusal is one bold red line naming the machine-readable code, then the fix as a command. Never a page.
4. **Trust surfaces look different from chatter.** The things a human is asked to trust (a payload they are approving, a hash they are recording, a token they must copy) get a box or a rule and generous whitespace; everything else is flush-left prose.
5. **The brand shows up where a person pauses, not on every line.** The wordmark appears on `approval` with no arguments, on `approval --help`, and on `approval init`; nowhere else. Verbs are tools, not billboards.

### Palette and typography (ANSI, no dependency)

Prefer a ~40-line internal `src/cli/style.ts` over a package: this repo justifies every dependency, and a colour library buys nothing we need. Roles, not colours, so a theme is one table:

| role | use | ANSI default |
| --- | --- | --- |
| `brand` | wordmark, verb names in headings | bold + 256-colour 111 (soft blue) |
| `ok` | ✓ rows, "verified", "clean", "granted" | green |
| `warn` | – rows, "declined", "left alone", TTL running low | yellow |
| `fail` | ✗ rows, refusals, error codes | bold red |
| `key` | field names, env var names, flag names | bold |
| `value` | hashes, ids, paths | default, hashes dimmed after 12 chars |
| `muted` | rationale one-liners, "(its value is not printed here)", timestamps | dim |
| `secret-notice` | "not echoed", "copy it now", "single-use" | bold yellow on default (never red: red is failure) |
| `rule` | horizontal rules and box drawing | dim |

Rules:
- Colour on only when stdout is a TTY, `NO_COLOR` is unset, `TERM` is not `dumb`, and `--json` is not given; `FORCE_COLOR=1` overrides; `--no-color` flag on every verb. This must be one function (`style.enabled()`), decided once per process.
- Never colour inside a value that a human might copy (hashes, tokens, commands): colour the label, leave the value clean, so a triple-click copies clean bytes.
- Glyphs are ASCII-fallback aware: `✓ ✗ – ▸ │ ─` with `[ok] [x] [-] > | -` when `LANG`/`LC_ALL` lack UTF-8 or `APPROVAL_ASCII=1`.
- No emoji. Ever. This is a gate that people will read at 2am.

### The wordmark

Small, exact, and only in the three places named above. Six lines maximum, monospace-safe, no half-blocks (they break in Terminal.app fonts). Reference:

```
                                            _
  __ _ _ __  _ __  _ __ _____   ____ _| |  _ __ ___   __| |
 / _` | '_ \| '_ \| '__/ _ \ \ / / _` | | | '_ ` _ \ / _` |
| (_| | |_) | |_) | | | (_) \ V / (_| | |_| | | | | | (_| |
 \__,_| .__/| .__/|_|  \___/ \_/ \__,_|_(_)_| |_| |_|\__,_|
      |_|   |_|                    human approval for agent actions · v0.1
```

Coloured `brand`; the `.md` in the same colour, the tagline `muted`. Under it on `approval` (no args): the five verbs a new operator needs (`init`, `setup`, `doctor`, `queue`, `--help`) as a two-column table, and nothing else. Add `approval --plain` (or honour `NO_COLOR`) and the wordmark degrades to a one-line `approval.md v0.1`.

### Screen-by-screen

**Help.** Top-level `--help`: wordmark, then verbs grouped under four bold headings (Set up · Ask · Decide · Inspect), one line each, then a footer `approval <verb> --help` / `--help --long for the reasoning` / exit-code table ONCE. Per-verb `--help`: usage line, one paragraph of intent (max 3 sentences), flags as an aligned table, two examples, and a `muted` footer "Why: approval <verb> --help --long, or SPEC.md §n". `--long` prints today's prose. Target: no per-verb short help over 25 lines. The 3,282-line file becomes short + long constants; the long ones are today's text, moved, not rewritten (grandfathered prose).

**Refusals and errors.** Exactly this shape, always:
```
✗ payload-mismatch   message.json does not hash to the registered payload_hash
  fix: approval payload hash message.json   (then re-register, or restore the file)
```
Bold red glyph and code; message plain; `fix:` line with the command in `key`. Never followed by help. `--json` keeps today's `{"error":{"code","message"}}` unchanged (frozen API).

**Prompts (setup verbs).** Preamble collapses to: one `brand` title line, one `muted` line saying where values go, then the checklist as an aligned table (`name  kind  one-line describe`). Each question is `key`-styled label, `muted` hint in brackets, cursor. Secrets: label ends with `(not echoed)` in `secret-notice`; after entry, `received 16 characters` in `muted`. Handoffs to a helper (`security`) are announced with a `▸` line in `secret-notice`: `▸ macOS security will ask "password data for new item:" — paste the BOT TOKEN here`. Re-prompt on a bad answer (APRV-90) with a one-line `fail` reason and the same question again.

**doctor.** A table, not sentences: `glyph  check  one-line status`, glyph coloured by role, check name in `key`, status truncated to terminal width with `…`; `--verbose` prints today's full sentences under each row. Summary line at the end: `9 ok · 2 not applicable · 0 failed` with each count in its role colour.

**queue.** Header row in `key`; columns aligned; TTL column coloured `ok`/`warn`/`fail` by remaining fraction (>50% / >10% / less); age of the request `muted`.

**Listener / decision moments.** `notified …` is `muted`; `granted …` line is `ok`; the token block is a `rule`-boxed panel:
```
─────────────────────────────────────────────────────────────
  execution token   task-042:chaser:2026-08-18
  729a25b06567ccc0aed356f3423e39bf12b6252056b7890acde455603010fb11
  single-use · stored nowhere · not sent to Telegram · copy it now
─────────────────────────────────────────────────────────────
```
Token itself uncoloured (copyable); the last line in `secret-notice`.

**log tail / verify / status.** `tail`: seq right-aligned, timestamp `muted`, event name in `key`, actor coloured by kind (human `ok`, agent default, system `muted`), task plain. `verify`: one line, `ok` when clean, `fail` with the seq that broke. `status`: key/value pairs aligned; the long payload-store sentence becomes `payload store  1 file(s), 0 pruned, 0 unbound` with the explanation under `--verbose`.

**Telegram / web channel text** is out of scope here (APRV-100), but the same role vocabulary should drive it later.

### Testing the look

- Snapshot tests run with colour OFF (`NO_COLOR=1`) so assertions stay byte-stable; one test asserts that with `FORCE_COLOR=1` the ANSI codes appear only in labels, never inside a hash, token, or command (regex over captured output).
- A `tests/style.test.ts` asserts the enable/disable matrix (TTY, NO_COLOR, FORCE_COLOR, --json, --no-color, TERM=dumb).
- Line-length lint: no short-help constant exceeds 25 lines; no single output line exceeds 100 characters unless it is a value.

### Sequencing

1. `style.ts` + enable matrix + tests (no visible change yet).
2. Refusal shape and `doctor` table (highest impact per line changed).
3. Help split into short/long, wordmark, top-level `--help`.
4. Prompt preambles and re-prompt (with APRV-90).
5. queue / log tail / status / listener panel.

Each step is its own PR; the whole thing is one task only in the sense of one design direction.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Interactive prompt lines and error lines carry no SPEC.md section citations; --help and docs keep them
- [x] #2 Per-verb help is usage plus at most a short paragraph of intent; the exit-code table lives only in top-level help
- [x] #3 Usage errors print the message plus a one-line pointer to --help instead of the full help text, except for argument-shape errors where the usage line is shown
- [x] #4 Every existing test asserting on help/error text updated; examples/*.md transcripts updated to match
- [x] #5 npm test and lint clean
- [x] #6 style.ts with role palette and the enable matrix (TTY, NO_COLOR, FORCE_COLOR, --json, --no-color, TERM=dumb), no new dependency, tested
- [x] #7 Wordmark on approval (no args), --help and init only; degrades to one line under NO_COLOR/ASCII
- [ ] #8 Every refusal follows the glyph+code / fix-line shape; never followed by help; --json unchanged
- [ ] #9 doctor, queue, log tail, status render as aligned tables with role colours; --verbose restores today's sentences
- [x] #10 Colour never inside a copyable value (hash, token, command); asserted by test
- [x] #11 style.ts with a role palette and the enable matrix (TTY, NO_COLOR, FORCE_COLOR, --json, --no-color, TERM=dumb), no new dependency, tested
- [x] #12 Wordmark on approval (no args), --help and init only; degrades to one line under NO_COLOR or ASCII mode
- [ ] #13 Every refusal follows the glyph+code / fix-line shape and is never followed by help; --json output unchanged
- [ ] #14 doctor, queue, log tail and status render as aligned tables with role colours; --verbose restores today's sentences
- [x] #15 Colour never appears inside a copyable value (hash, token, command); asserted by test
- [x] #16 No per-verb short help exceeds 25 lines; the long form is one flag away
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Opus subagent, worktree from main; file boundary help.ts + per-file usageError helpers + prompt/error lines in setup*/vault/env/doctor + tests asserting help text + examples transcripts. 2. Per-verb help = usage + a short intent paragraph; exit-code table only in ROOT_HELP; usageError prints message + one-line --help pointer (usage line for shape errors); prompt/error lines lose SPEC citations (kept in --help and docs). 3. Reconcile the two --help shapes 85 found (status payload_store pruned/orphans; token payload_hash). 4. Every affected test updated deliberately and listed. PR.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Opus subagent build, PR #74. ACs 1-5 delivered; the brief later grew ACs 6-16 (colour, style.ts, wordmark, glyph refusal shape, doctor/queue tables, --help --long) which overlap APRV-93 and land there. Exit-code table only in ROOT_HELP; per-verb helps carry the pointer plus their peculiar codes. Cross-cutting rationale into ROOT_HELP once; long essays verbatim into new docs/cli-reference.md (~50 anchors, why: pointers). Help 2959 -> 2315 lines. src/cli/usage.ts: message + pointer; shape errors get a capped synopsis; 22 helpers delegate; --json byte-identical. No SPEC.md § in prompt/error lines (scripted sweep). status/token help shapes reconciled. 13 pinned assertions changed deliberately: cli.test (root-only table), cli-env x2, cli-gate, cli-payload, cli-run, cli-status, cli-token, cli-vault (threat model -> reference pointer, prose asserted in cli-help.test), daemon, channels-cli, cli-setup x2, setup-rename. New tests/cli-help.test.ts pins the convention. Fable on merge: MCP_HELP from 88 converted to the pointer convention. Deferred per brief: src/channels/* SPEC citations (APRV-100); verb-registry purposes. docs/cli-reference.md is not yet linked from README (89 will). 1733 tests.

ACs 6-16 (the visual layer) were built under APRV-93 (PR by branch aprv-93-legibility) and reviewed 2026-08-19; see its notes for the decisions. Checked here on evidence: 6/11 style.ts palette and enable matrix, tests/style.test.ts sweeps TTY, NO_COLOR (incl. empty), FORCE_COLOR, TERM=dumb, --no-color, --json, no new dependency; 7/12 wordmark on approval, --help and init, spawned tests assert presence there and absence on queue/status/doctor/log verify, collapses under NO_COLOR and APPROVAL_ASCII/non-UTF-8 locale; 10/15 colour never inside hashes, tokens or commands, asserted by tests/cli-style-render.test.ts; 16 every per-verb short help under 25 lines (test-enforced), long form via --help --long from docs/cli-reference.md. LEFT UNCHECKED, deliberately: 8/13 hold for the gate (glyph+code, no help after, --json frozen) but execute (run/token), audit, channel and env refusals still print the old "approval: <code>: <message>" line; 9/14 doctor, queue and status are tables with role colours, but log tail is untouched, no --verbose exists, and the token panel was deferred so the two decision surfaces stay consistent. APRV-102 carries exactly that remainder; this task closes so 93 and the design brief stop being two homes for one list.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Help and errors trimmed to what the operator needs (ACs 1-5, PR #74); the visual layer (style.ts, wordmark, help split, refusal shape for the gate, doctor/queue/status tables) landed under APRV-93 (PR by branch aprv-93-legibility). ACs 8/13 and 9/14 are partial and left unchecked; APRV-102 holds the remainder. Verified by npm test (1784), lint, typecheck, and the spawned TTY/NO_COLOR/ASCII checks in tests/cli-long-help.test.ts.
<!-- SECTION:FINAL_SUMMARY:END -->
